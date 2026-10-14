import { describe, expect, test } from 'claude-code/testing'

import { defaultTriggers, roleSpec, validate } from './config'
import { CHARS_PER_TOKEN, conditions, crossesGates, deniedBy, evaluate, idleMs, inFlightTokens, limitsFrom, liveDenies, markHeld, metricsOf, planActions, resetMarks, stepTokens, tokenGates, triggersFor } from './triggers'
import type { Metrics } from './triggers'
import type { Config, Marks, Trigger } from '../types'

function configWith(triggers: unknown[]): Config {
  const r = validate({ version: 1, roles: { lead: { triggers } } })
  expect(r.errors).toEqual([])
  return r.config as Config
}

function trigs(...raw: unknown[]): Trigger[] {
  return roleSpec(configWith(raw), 'lead')?.triggers ?? []
}

const WINDOW = 1_000_000

function m(over: Partial<Metrics> & { five?: number; week?: number } = {}): Metrics {
  const { five, week, ...rest } = over
  return {
    tokens: null,
    window: WINDOW,
    limits: {
      five_hour: five === undefined ? null : { pct: five, resetsAt: null },
      seven_day: week === undefined ? null : { pct: week, resetsAt: null },
    },
    cost: null,
    idleMs: null,
    now: 1000,
    ...rest,
  }
}

// Feeds readings in order, carrying marks; returns the fired ids per reading.
function run(triggers: Trigger[], readings: Metrics[], start: Marks | null = null): { fired: string[][]; marks: Marks | null } {
  let marks = start
  const fired: string[][] = []
  for (const r of readings) {
    const e = evaluate(triggers, r, marks, 'lead')
    fired.push(e.fire.map(f => `${f.trigger.id}@${f.step}`))
    marks = e.marks
  }
  return { fired, marks }
}

const soft = { id: 'soft', when: { context: '300k' }, do: ['note'], level: 'soft' }

describe('rising edge', () => {
  test('fires once when crossing, not again while held', () => {
    const { fired } = run(trigs(soft), [m({ tokens: 100_000 }), m({ tokens: 310_000 }), m({ tokens: 320_000 })])
    expect(fired).toEqual([[], ['soft@0'], []])
  })

  test('fires at exactly the threshold', () => {
    expect(run(trigs(soft), [m({ tokens: 300_000 })]).fired).toEqual([['soft@0']])
  })

  test('percent of the window', () => {
    const t = trigs({ id: 'p', when: { context: '30%' }, do: ['note'] })
    expect(run(t, [m({ tokens: 290_000 }), m({ tokens: 300_000 })]).fired).toEqual([[], ['p@0']])
    expect(run(t, [m({ tokens: 60_000, window: 200_000 })]).fired).toEqual([['p@0']])
  })

  test('the fired entry carries edge actions only and vars', () => {
    const t = trigs({ id: 'x', when: { 'limit.any': 95 }, do: ['note', 'toast', { deny: ['Agent'] }], level: 'stop' })
    const e = evaluate(t, m({ tokens: 5, five: 96 }), null, 'lead')
    expect(e.fire).toHaveLength(1)
    expect(e.fire[0]?.actions).toEqual(['note', 'toast'])
    expect(e.fire[0]?.vars).toMatchObject({ metric: 'limit.any', threshold: { kind: 'percent', value: 95 }, limit: { kind: 'five_hour', pct: 96 } })
  })

  test('a deny-only trigger keeps a mark but fires nothing', () => {
    const t = trigs({ id: 'd', when: { 'limit.any': 95 }, do: [{ deny: ['Agent'] }] })
    const e = evaluate(t, m({ five: 96 }), null, 'lead')
    expect(e.fire).toEqual([])
    expect(Object.keys(e.marks.byId)).toEqual(['d'])
  })
})

describe('re-arm', () => {
  test('on drop below the threshold (compaction)', () => {
    const { fired } = run(trigs(soft), [m({ tokens: 310_000 }), m({ tokens: 120_000 }), m({ tokens: 305_000 })])
    expect(fired).toEqual([['soft@0'], [], ['soft@0']])
  })

  test('on clear: resetMarks', () => {
    const t = trigs(soft)
    const first = run(t, [m({ tokens: 310_000 })])
    expect(run(t, [m({ tokens: 320_000 })], first.marks).fired).toEqual([[]])
    expect(run(t, [m({ tokens: 320_000 })], resetMarks('lead')).fired).toEqual([['soft@0']])
  })

  test('on clear: triggers with no context condition keep their marks; mixed ones re-arm', () => {
    const t = trigs(
      soft,
      { id: 'week', when: { 'limit.seven_day': 80 }, do: ['note'] },
      { id: 'spend', when: { cost: '$5' }, do: ['note'] },
      { id: 'both', when: { context: '300k', 'limit.any': 80 }, do: ['note'] },
    )
    const first = run(t, [m({ tokens: 310_000, week: 89, cost: 6 })])
    expect(first.fired).toEqual([['soft@0', 'week@0', 'spend@0', 'both@0']])
    const cleared = resetMarks('lead', first.marks, t)
    expect(Object.keys(cleared.byId).sort()).toEqual(['spend', 'week'])
    expect(run(t, [m({ tokens: 320_000, week: 89, cost: 6 })], cleared).fired).toEqual([['soft@0', 'both@0']])
    // They still re-arm when their own figure drops.
    expect(run(t, [m({ tokens: 320_000, week: 50, cost: 6 }), m({ tokens: 320_000, week: 89, cost: 6 })], cleared).fired).toEqual([['soft@0'], ['week@0', 'both@0']])
    // Marks of another role are not kept.
    expect(resetMarks('other', first.marks, t).byId).toEqual({})
  })

  test('a percent threshold re-arms when the window grows', () => {
    const t = trigs({ id: 'p', when: { context: '50%' }, do: ['note'] })
    const { fired } = run(t, [m({ tokens: 120_000, window: 200_000 }), m({ tokens: 120_000, window: 1_000_000 }), m({ tokens: 520_000, window: 1_000_000 })])
    expect(fired).toEqual([['p@0'], [], ['p@0']])
  })

  test('on a limit window reset', () => {
    const t = trigs({ id: '5h', when: { 'limit.five_hour': 80 }, do: ['toast'] })
    expect(run(t, [m({ five: 85 }), m({ five: 3 }), m({ five: 81 })]).fired).toEqual([['5h@0'], [], ['5h@0']])
  })

  test('marks of another role are ignored', () => {
    const t = trigs(soft)
    const marks: Marks = { role: 'other', byId: { soft: { step: 0, at: 1 } } }
    expect(evaluate(t, m({ tokens: 310_000 }), marks, 'lead').fire).toHaveLength(1)
  })

  test('marks of removed triggers are pruned', () => {
    const marks: Marks = { role: 'lead', byId: { gone: { step: 0, at: 1 } } }
    expect(evaluate(trigs(soft), m({ tokens: 1 }), marks, 'lead').marks.byId).toEqual({})
  })
})

describe('every', () => {
  const stop = { id: 'stop', when: { context: '70%', every: '10%' }, do: ['note'], level: 'stop' }

  test('each new step fires again', () => {
    const { fired } = run(trigs(stop), [700_000, 750_000, 800_000, 850_000, 900_000].map(tokens => m({ tokens })))
    expect(fired).toEqual([['stop@0'], [], ['stop@1'], [], ['stop@2']])
  })

  test('jumping two steps fires once, at the highest', () => {
    const { fired, marks } = run(trigs(stop), [m({ tokens: 710_000 }), m({ tokens: 910_000 })])
    expect(fired).toEqual([['stop@0'], ['stop@2']])
    expect(marks?.byId.stop?.step).toBe(2)
  })

  test('first reading already past several steps fires once', () => {
    expect(run(trigs(stop), [m({ tokens: 950_000 })]).fired).toEqual([['stop@2']])
  })

  test('a falling step re-arms the higher steps', () => {
    const { fired } = run(trigs(stop), [900_000, 750_000, 800_000].map(tokens => m({ tokens })))
    expect(fired).toEqual([['stop@2'], [], ['stop@1']])
  })

  test('the threshold var moves with the step', () => {
    const e = evaluate(trigs(stop), m({ tokens: 900_000 }), null, 'lead')
    expect(e.fire[0]?.vars.threshold).toEqual({ kind: 'percent', value: 90 })
  })

  test('steps on a limit metric', () => {
    const t = trigs({ id: 'l', when: { 'limit.five_hour': 80, every: 5 }, do: ['note'] })
    expect(run(t, [80, 84, 85, 96].map(five => m({ five }))).fired).toEqual([['l@0'], [], ['l@1'], ['l@3']])
  })

  test('steps on cost', () => {
    const t = trigs({ id: 'c', when: { cost: '$2', every: '$1' }, do: ['toast'] })
    expect(run(t, [1, 2, 2.5, 3, 5.2].map(cost => m({ cost }))).fired).toEqual([[], ['c@0'], [], ['c@1'], ['c@3']])
  })

  test('token steps', () => {
    const t = trigs({ id: 't', when: { context: '300k', every: '100k' }, do: ['note'] })
    expect(run(t, [300_000, 399_999, 400_000].map(tokens => m({ tokens }))).fired).toEqual([['t@0'], [], ['t@1']])
  })
})

describe('AND metrics', () => {
  const idle = { id: 'idle', when: { idle: '50m', context: '150k' }, do: ['notify'] }
  const min = 60_000

  test('fires only when all hold', () => {
    const t = trigs(idle)
    const { fired } = run(t, [
      m({ tokens: 200_000, idleMs: 10 * min }),
      m({ tokens: 100_000, idleMs: 60 * min }),
      m({ tokens: 200_000, idleMs: 60 * min }),
    ])
    expect(fired).toEqual([[], [], ['idle@0']])
  })

  test('one missing metric keeps it quiet and the mark as it was', () => {
    const t = trigs(idle)
    const marked = run(t, [m({ tokens: 200_000, idleMs: 60 * min })]).marks
    const next = evaluate(t, m({ tokens: 200_000, idleMs: null }), marked, 'lead')
    expect(next.fire).toEqual([])
    expect(next.marks.byId).toEqual(marked?.byId)
    expect(evaluate(t, m({ tokens: 200_000 }), null, 'lead').fire).toEqual([])
  })

  test('idle re-arms when the session wakes', () => {
    const t = trigs(idle)
    const { fired } = run(t, [
      m({ tokens: 200_000, idleMs: 55 * min }),
      m({ tokens: 200_000, idleMs: 0 }),
      m({ tokens: 200_000, idleMs: 51 * min }),
    ])
    expect(fired).toEqual([['idle@0'], [], ['idle@0']])
  })
})

describe('unknown metrics', () => {
  test('unknown tokens skip the trigger and leave its mark', () => {
    const t = trigs(soft)
    const marked = run(t, [m({ tokens: 310_000 })]).marks
    const after = evaluate(t, m({ tokens: null }), marked, 'lead')
    expect(after.fire).toEqual([])
    expect(after.marks.byId.soft).toEqual(marked?.byId.soft)
    // Known again and still over: no second note.
    expect(evaluate(t, m({ tokens: 320_000 }), after.marks, 'lead').fire).toEqual([])
  })

  test('a percent threshold with no window is unknown', () => {
    const t = trigs({ id: 'p', when: { context: '30%' }, do: ['note'] })
    expect(conditions(t[0] as Trigger, m({ tokens: 5, window: 0 }))[0]?.value).toBeNull()
  })

  test('an absent limit window is unknown', () => {
    const t = trigs({ id: 'w', when: { 'limit.seven_day': 50 }, do: ['note'] })
    expect(evaluate(t, m({ five: 99 }), null, 'lead').fire).toEqual([])
  })

  test('cost', () => {
    const t = trigs({ id: 'c', when: { cost: '$5' }, do: ['toast'] })
    expect(run(t, [m(), m({ cost: 4.99 }), m({ cost: 5 })]).fired).toEqual([[], [], ['c@0']])
  })
})

describe('resetsIn', () => {
  const H = 3_600_000
  const START = Date.parse('2026-10-13T10:00:00Z')
  const iso = (ms: number): string => new Date(ms).toISOString()
  // The weekly window at `pct`, `left` before its reset, read at `now`.
  const week = (pct: number, left: number | null, now = START): Metrics =>
    m({ now, limits: { five_hour: null, seven_day: { pct, resetsAt: left === null ? null : iso(now + left) } } })
  const early = { id: 'early', when: { 'limit.seven_day': 80, 'limit.seven_day.resetsIn': '2d' }, do: ['note', { deny: ['Agent'] }] }
  const on = { blocking: true, paused: false }

  test('reads the time left to its window reset', () => {
    const t = trigs(early)
    const cs = conditions(t[0] as Trigger, week(85, 50 * H))
    expect(cs.map(c => [c.metric, c.value, c.holds])).toEqual([
      ['limit.seven_day', 85, true],
      ['limit.seven_day.resetsIn', 50 * H, true],
    ])
  })

  test('holds only while enough time is left; re-arms in the next window', () => {
    const t = trigs(early)
    const { fired } = run(t, [
      week(85, 72 * H),
      week(86, 60 * H),
      // Under two days left: stops holding, the mark drops.
      week(87, 47 * H),
      // The window reset and filled fast again.
      week(82, 6 * 24 * H),
    ])
    expect(fired).toEqual([['early@0'], [], [], ['early@0']])
  })

  test('the deny lifts as the reset nears, before the window resets', () => {
    const t = trigs(early)
    expect(liveDenies(t, week(85, 49 * H), on)).toEqual([{ tool: 'Agent', triggerId: 'early' }])
    expect(liveDenies(t, week(85, 47 * H), on)).toEqual([])
    expect(liveDenies(t, week(79, 6 * 24 * H), on)).toEqual([])
  })

  test('a window with no reset time is unknown: skipped, keeps its mark, denies nothing', () => {
    const t = trigs(early)
    const marked = run(t, [week(85, 72 * H)]).marks
    const after = evaluate(t, week(90, null), marked, 'lead')
    expect(after.fire).toEqual([])
    expect(after.marks.byId.early).toEqual(marked?.byId.early)
    expect(liveDenies(t, week(99, null), on)).toEqual([])
  })

  test('the built-in ladder blocks Agent sooner the earlier the weekly window fills', () => {
    const t = defaultTriggers()
    const ids = (r: Metrics): string[] => [...new Set(liveDenies(t, r, on).map(d => d.triggerId))]
    expect(ids(week(85, 3 * 24 * H))).toEqual(['week-80-early'])
    expect(ids(week(85, 30 * H))).toEqual([])
    expect(ids(week(92, 30 * H))).toEqual(['week-90-early'])
    expect(ids(week(92, 20 * H))).toEqual([])
    expect(ids(week(96, 20 * H))).toEqual(['limit-stop'])
    expect(ids(week(92, null))).toEqual([])
  })

  test('the built-in brakes block workflows with subagents, and the web at the last one', () => {
    const t = defaultTriggers()
    const tools = (r: Metrics): string[] => liveDenies(t, r, on).map(d => d.tool)
    expect(tools(week(85, 3 * 24 * H))).toEqual(['Agent', 'Workflow'])
    expect(tools(week(92, 30 * H))).toEqual(['Agent', 'Workflow'])
    expect(tools(week(96, 20 * H))).toEqual(['Agent', 'Workflow', 'WebSearch', 'WebFetch'])
  })

  test('the text is about the usage, not the time left', () => {
    const e = evaluate(trigs(early), week(85, 72 * H), null, 'lead')
    expect(e.fire[0]?.vars).toMatchObject({ metric: 'limit.seven_day', threshold: { kind: 'percent', value: 80 }, limit: { kind: 'seven_day', pct: 85 } })
  })
})

describe('limit.any', () => {
  const any = { id: 'any', when: { 'limit.any': 90 }, do: ['note'] }

  test('the max of the known windows', () => {
    const t = trigs(any)
    expect(evaluate(t, m({ five: 50, week: 91 }), null, 'lead').fire[0]?.vars.limit?.kind).toBe('seven_day')
    expect(evaluate(t, m({ five: 92, week: 10 }), null, 'lead').fire[0]?.vars.limit?.kind).toBe('five_hour')
    expect(evaluate(t, m({ week: 95 }), null, 'lead').fire).toHaveLength(1)
    expect(evaluate(t, m({ five: 89, week: 89 }), null, 'lead').fire).toEqual([])
  })

  test('no window known: unknown', () => {
    expect(conditions(trigs(any)[0] as Trigger, m())[0]?.value).toBeNull()
  })

  test('limitsFrom keeps the two windows, with reset times', () => {
    expect(
      limitsFrom([
        { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-13T12:00:00Z' },
        { kind: 'seven_day', percentUsed: 61 },
        { kind: 'spend_limit', percentUsed: 99 },
      ]),
    ).toEqual({ five_hour: { pct: 42, resetsAt: '2026-10-13T12:00:00Z' }, seven_day: { pct: 61, resetsAt: null } })
    expect(limitsFrom(undefined)).toEqual({ five_hour: null, seven_day: null })
  })
})

describe('garbage marks', () => {
  test('bad shapes from $.state never throw and count as no mark', () => {
    const t = trigs(soft)
    const reading = m({ tokens: 310_000 })
    const bad: unknown[] = [
      'x',
      42,
      [],
      { role: 'lead' },
      { role: 'lead', byId: 'nope' },
      { role: 'lead', byId: [] },
      { role: 'lead', byId: null },
      { role: 'lead', byId: { soft: null } },
      { role: 'lead', byId: { soft: { at: 1 } } },
      { role: 'lead', byId: { soft: { step: 'zero', at: 1 } } },
      { role: 'lead', byId: { soft: { step: -1, at: 1 } } },
    ]
    for (const marks of bad) {
      const e = evaluate(t, reading, marks as Marks, 'lead')
      expect(e.fire.map(f => f.trigger.id)).toEqual(['soft'])
      expect(e.marks.byId.soft).toEqual({ step: 0, at: reading.now })
    }
  })

  test('a garbage mark on an unknown reading is dropped, not kept', () => {
    const marks = { role: 'lead', byId: { soft: { step: 'x' } } } as unknown as Marks
    expect(evaluate(trigs(soft), m(), marks, 'lead').marks.byId).toEqual({})
  })
})

describe('marks are JSON', () => {
  test('round-trip through JSON gives the same evaluation', () => {
    const t = trigs(soft, { id: 'stop', when: { context: '70%', every: '10%' }, do: ['note'] })
    const marks = run(t, [m({ tokens: 810_000 })]).marks
    const copy = JSON.parse(JSON.stringify(marks)) as Marks
    expect(copy).toEqual(marks)
    expect(evaluate(t, m({ tokens: 910_000 }), copy, 'lead').fire.map(f => f.trigger.id)).toEqual(['stop'])
  })
})

describe('liveDenies', () => {
  const t = trigs(
    { id: 'brake', when: { 'limit.any': 95 }, do: ['note', { deny: ['Agent', 'Workflow'] }] },
    { id: 'ctx', when: { context: '80%' }, do: [{ deny: ['Agent'] }] },
  )
  const on = { blocking: true, paused: false }

  test('level-triggered from live metrics', () => {
    expect(liveDenies(t, m({ tokens: 10, five: 96 }), on)).toEqual([
      { tool: 'Agent', triggerId: 'brake' },
      { tool: 'Workflow', triggerId: 'brake' },
    ])
    expect(liveDenies(t, m({ tokens: 10, five: 50 }), on)).toEqual([])
    expect(liveDenies(t, m({ tokens: 850_000, five: 96 }), on)).toHaveLength(3)
  })

  test('unknown metrics deny nothing', () => {
    expect(liveDenies(t, m(), on)).toEqual([])
  })

  test('an AND deny with one metric unknown denies nothing', () => {
    const and = trigs({ id: 'and', when: { context: '50%', 'limit.seven_day': 90 }, do: [{ deny: ['Agent'] }] })
    expect(liveDenies(and, m({ tokens: 900_000, five: 99 }), on)).toEqual([])
    expect(liveDenies(and, m({ tokens: null, week: 99 }), on)).toEqual([])
    expect(liveDenies(and, m({ tokens: 900_000, week: 99 }), on)).toEqual([{ tool: 'Agent', triggerId: 'and' }])
  })

  test('blocking off or paused: empty', () => {
    expect(liveDenies(t, m({ five: 99 }), { blocking: false, paused: false })).toEqual([])
    expect(liveDenies(t, m({ five: 99 }), { blocking: true, paused: true })).toEqual([])
  })

  test('deniedBy finds the first entry for a tool', () => {
    const d = liveDenies(t, m({ tokens: 850_000, five: 96 }), on)
    expect(deniedBy('Agent', d)).toEqual({ tool: 'Agent', triggerId: 'brake' })
    expect(deniedBy('Read', d)).toBeNull()
  })
})

describe('zero-config', () => {
  test('no role runs the zero-config toasts', () => {
    const config = configWith([soft])
    const t = triggersFor(config, null)
    expect(t.length).toBeGreaterThan(0)
    expect(t.every(x => x.do.every(a => a === 'toast'))).toBe(true)
    const e = evaluate(t, m({ tokens: 520_000, five: 81 }), null, null)
    expect(e.fire.map(f => f.trigger.id)).toEqual(['ctx-50', 'limit-80'])
    expect(e.marks.role).toBeNull()
    expect(liveDenies(t, m({ tokens: 990_000, five: 99 }), { blocking: true, paused: false })).toEqual([])
  })

  test('a role uses its own triggers; an unknown one falls back to zero-config', () => {
    const config = configWith([soft])
    expect(triggersFor(config, 'lead').map(x => x.id)).toEqual(['soft'])
    expect(triggersFor(config, 'ghost').map(x => x.id)).toEqual(triggersFor(config, null).map(x => x.id))
  })
})

describe('idleMs', () => {
  test('0 while a main turn runs, null before the first turn end, else time since it', () => {
    expect(idleMs(null, true, 5000)).toBe(0)
    expect(idleMs(1000, true, 5000)).toBe(0)
    expect(idleMs(null, false, 5000)).toBeNull()
    expect(idleMs(1000, false, 5000)).toBe(4000)
    expect(idleMs(9000, false, 5000)).toBe(0)
  })
})

describe('planActions', () => {
  test('groups fires by action; compact once', () => {
    const t = trigs(
      { id: 'a', when: { context: '10%' }, do: ['note', 'compact'] },
      { id: 'b', when: { context: '20%' }, do: ['note', 'toast'] },
      { id: 'c', when: { context: '30%' }, do: ['compact', 'notify'] },
    )
    const plan = planActions(evaluate(t, m({ tokens: 900_000 }), null, 'lead').fire)
    expect(plan.notes.map(f => f.trigger.id)).toEqual(['a', 'b'])
    expect(plan.toasts.map(f => f.trigger.id)).toEqual(['b'])
    expect(plan.notifies.map(f => f.trigger.id)).toEqual(['c'])
    expect(plan.compact?.trigger.id).toBe('a')
    expect(planActions([])).toEqual({ notes: [], toasts: [], notifies: [], compact: null })
  })
})

describe('inFlightTokens', () => {
  test('the last input, its output and the results since, at 4 characters a token', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(inFlightTokens(72_900, 300, 62_000)).toBe(72_900 + 300 + 15_500)
    expect(inFlightTokens(1000, null, 0)).toBe(1000)
    expect(inFlightTokens(1000, 10, 5)).toBe(1012)
  })
})

describe('stepTokens', () => {
  test('sums uncached, cache-read and cache-written input', () => {
    expect(stepTokens({ input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 5000 })).toBe(205_010)
  })

  test('no usage, or a junk count, is unknown', () => {
    expect(stepTokens(null)).toBeNull()
    expect(stepTokens(undefined)).toBeNull()
    expect(stepTokens({ input_tokens: Number.NaN, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 })).toBeNull()
  })
})

describe('metricsOf', () => {
  test('absent tokens and cost are unknown', () => {
    const r = metricsOf({ rateLimits: [] }, WINDOW, null, 5)
    expect(r).toEqual({ tokens: null, window: WINDOW, limits: { five_hour: null, seven_day: null }, cost: null, idleMs: null, now: 5 })
  })

  test('carries tokens, limits, cost and idle', () => {
    const r = metricsOf(
      { tokens: 312_000, rateLimits: [{ kind: 'seven_day', percentUsed: 61, resetsAt: '2026-10-14T00:00:00Z' }], cost: { usd: 2.5 } },
      WINDOW,
      60_000,
      5,
    )
    expect(r.tokens).toBe(312_000)
    expect(r.limits.seven_day).toEqual({ pct: 61, resetsAt: '2026-10-14T00:00:00Z' })
    expect(r.cost).toBe(2.5)
    expect(r.idleMs).toBe(60_000)
  })
})

describe('tokenGates', () => {
  const ladder = trigs(
    soft,
    { id: 'pct', when: { context: '50%' }, do: ['note'] },
    { id: 'step', when: { context: '700k', every: '100k' }, do: ['note'] },
    { id: 'lim', when: { 'limit.any': 90 }, do: ['note'] },
  )

  test('no marks: rise at the lowest threshold, no fall', () => {
    expect(tokenGates(ladder, null, 'lead', WINDOW)).toEqual({ rise: 300_000, fall: null })
  })

  test('marked triggers raise rise to the next one and set fall', () => {
    const marks: Marks = { role: 'lead', byId: { soft: { step: 0, at: 1 }, pct: { step: 0, at: 1 } } }
    expect(tokenGates(ladder, marks, 'lead', WINDOW)).toEqual({ rise: 700_000, fall: 500_000 })
    const stepped: Marks = { role: 'lead', byId: { ...marks.byId, step: { step: 1, at: 1 } } }
    expect(tokenGates(ladder, stepped, 'lead', WINDOW)).toEqual({ rise: 900_000, fall: 800_000 })
  })

  test('agrees with evaluate: inside the gates nothing changes', () => {
    let marks: Marks | null = null
    for (const tokens of [100_000, 310_000, 320_000, 520_000, 690_000, 710_000, 790_000, 805_000, 650_000, 200_000, 950_000]) {
      const gates = tokenGates(ladder, marks, 'lead', WINDOW)
      const ev = evaluate(ladder, m({ tokens }), marks, 'lead')
      const changed = ev.fire.length > 0 || JSON.stringify(Object.keys(ev.marks.byId).sort()) !== JSON.stringify(Object.keys(marks?.byId ?? {}).sort()) ||
        Object.entries(ev.marks.byId).some(([id, mk]) => marks?.byId[id]?.step !== mk.step)
      if (changed) expect(crossesGates(tokens, gates)).toBe(true)
      marks = ev.marks
    }
  })

  test('a percent threshold with no window always evaluates', () => {
    expect(tokenGates(ladder, null, 'lead', 0)).toEqual({ rise: 0, fall: null })
    expect(crossesGates(5, null)).toBe(true)
    expect(crossesGates(5, { rise: null, fall: null })).toBe(false)
  })
})

describe('markHeld', () => {
  test('a mark of the role is held; another role, a missing id or garbage is not', () => {
    const marks: Marks = { role: 'lead', byId: { squeeze: { step: 0, at: 1 }, bad: { step: -1, at: 1 } } }
    expect(markHeld(marks, 'lead', 'squeeze')).toBe(true)
    expect(markHeld(marks, 'reviewer', 'squeeze')).toBe(false)
    expect(markHeld(marks, 'lead', 'other')).toBe(false)
    expect(markHeld(marks, 'lead', 'bad')).toBe(false)
    expect(markHeld(null, 'lead', 'squeeze')).toBe(false)
  })
})
