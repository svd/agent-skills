import { describe, expect, test } from 'claude-code/testing'

import { defaultTriggers, roleSpec, validate } from './config'
import {
  CHARS_PER_TOKEN,
  NO_CACHE,
  ROLL_OVER_GRACE_MS,
  applyTimes,
  blockedBy,
  conditions,
  crossesGates,
  deniedBy,
  evaluate,
  idleMs,
  inFlightTokens,
  liftsInMs,
  limitsFrom,
  liveDenies,
  markHeld,
  metricsOf,
  planActions,
  resetMarks,
  stepHolds,
  stepTokens,
  tokenGates,
  toolLiftsIn,
  toolsFree,
  triggersFor,
  whenState,
} from './triggers'
import type { Metrics } from './triggers'
import type { Config, Hold, Marks, Trigger } from '../types'

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
    cache: NO_CACHE,
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

describe('conditions', () => {
  test('read once per trigger and reading: a new reading or another trigger reads afresh', () => {
    const [a, b] = trigs({ id: 'a', when: { context: '10k' }, do: ['notify'] }, { id: 'b', when: { context: '20k' }, do: ['notify'] }) as [Trigger, Trigger]
    const r = m({ tokens: 15_000 })
    const first = conditions(a, r)
    expect(conditions(a, r)).toBe(first)
    expect(conditions(b, r)).not.toBe(first)
    expect(conditions(b, r)[0]?.holds).toBe(false)
    const next = m({ tokens: 5_000 })
    expect(conditions(a, next)).not.toBe(first)
    expect(conditions(a, next)[0]?.holds).toBe(false)
    expect(conditions(a, r)[0]?.holds).toBe(true)
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
    expect(planActions([])).toEqual({ notes: [], toasts: [], notifies: [], compact: null, ping: null, prompts: [] })
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
    expect(r).toEqual({ tokens: null, window: WINDOW, limits: { five_hour: null, seven_day: null }, cost: null, idleMs: null, cache: NO_CACHE, now: 5 })
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

describe('cache metrics', () => {
  const c = (over: Partial<typeof NO_CACHE>) => m({ cache: { ...NO_CACHE, ...over } })

  test('expiresIn holds at or below its threshold', () => {
    const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['toast'] })
    expect(run(t, [c({ expiresIn: 6 * 60_000 }), c({ expiresIn: 5 * 60_000 }), c({ expiresIn: 60_000 })]).fired).toEqual([[], ['warm@0'], []])
  })

  test('expiry rising again re-arms it, as a warm ping does', () => {
    const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['toast'] })
    expect(run(t, [c({ expiresIn: 4 * 60_000 }), c({ expiresIn: 59 * 60_000 }), c({ expiresIn: 4 * 60_000 })]).fired).toEqual([['warm@0'], [], ['warm@0']])
  })

  test('miss and pings hold at or above', () => {
    const t = trigs(
      { id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] },
      { id: 'away', when: { 'cache.expiresIn': '5m', 'cache.pings': 3 }, do: ['toast'] },
    )
    expect(run(t, [c({ miss: 40_000 }), c({ miss: 140_000 }), c({ expiresIn: 4 * 60_000, pings: 2 }), c({ expiresIn: 4 * 60_000, pings: 3 })]).fired).toEqual([[], ['miss@0'], [], ['away@0']])
  })

  test('unknown cache figures fire nothing', () => {
    const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['toast'] })
    expect(run(t, [c({ expiresIn: null })]).fired).toEqual([[]])
  })

  test('fire vars carry the cache figures', () => {
    const t = trigs({ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] })
    const e = evaluate(t, c({ miss: 140_000, missCause: 'model' }), null, 'lead')
    expect(e.fire[0]?.vars).toMatchObject({ metric: 'cache.miss', miss: 140_000, missCause: 'model' })
  })

  test('metricsOf carries the cache figures it is given', () => {
    const cache = { ...NO_CACHE, expiresIn: 1000, pings: 1 }
    expect(metricsOf({}, WINDOW, null, 5, cache).cache).toEqual(cache)
  })
})

describe('times', () => {
  const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 2 }, { id: 'loud', when: { idle: '5m' }, do: ['toast'] })
  const fires = (ids: string[]) => evaluate(t, m({ idleMs: 6 * 60_000, cache: { ...NO_CACHE, expiresIn: 60_000 } }), null, 'lead').fire.filter(f => ids.includes(f.trigger.id))

  test('a capped trigger fires up to its times, then not', () => {
    let fired: Record<string, number> = {}
    const one = applyTimes(fires(['warm']), fired)
    expect(one.fire.map(f => f.trigger.id)).toEqual(['warm'])
    fired = one.fired
    fired = applyTimes(fires(['warm']), fired).fired
    expect(fired).toEqual({ warm: 2 })
    expect(applyTimes(fires(['warm']), fired).fire).toEqual([])
  })

  test('an id that names an Object.prototype member is counted like any other', () => {
    const t = trigs({ id: 'constructor', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 })
    const f = evaluate(t, m({ cache: { ...NO_CACHE, expiresIn: 60_000 } }), null, 'lead').fire
    const first = applyTimes(f, {})
    expect(first.fire.length).toBe(1)
    expect(first.fired).toEqual({ constructor: 1 })
    expect(applyTimes(f, first.fired).fire).toEqual([])
  })

  test('an `every` trigger counts each step it fires and stops at times', () => {
    const t = trigs({ id: 'step', when: { context: '300k', every: '100k' }, do: ['note'], times: 2 })
    let marks: Marks | null = null
    let fired: Record<string, number> = {}
    const acted: string[] = []
    for (const tokens of [310_000, 410_000, 510_000]) {
      const ev = evaluate(t, m({ tokens }), marks, 'lead')
      marks = ev.marks
      const r = applyTimes(ev.fire, fired)
      fired = r.fired
      acted.push(...r.fire.map(f => `${f.trigger.id}@${f.step}`))
    }
    expect(acted).toEqual(['step@0', 'step@1'])
    expect(fired).toEqual({ step: 2 })
  })

  test('an uncapped trigger is never held back, and not counted', () => {
    const r = applyTimes(fires(['loud']), { loud: 99 })
    expect(r.fire.length).toBe(1)
    expect(r.fired).toEqual({ loud: 99 })
  })
})

describe('plan', () => {
  const fire = (id: string, actions: string[]) => ({ trigger: { id } as never, actions: actions as never, step: 0, vars: {} as never })

  test('a ping and every prompt are planned, in order; the caller picks', () => {
    const p = planActions([fire('warm', ['ping']), fire('away', ['prompt', 'notify']), fire('gone', ['prompt'])])
    expect(p.ping?.trigger.id).toBe('warm')
    expect(p.prompts.map(f => f.trigger.id)).toEqual(['away', 'gone'])
    expect(p.notifies.length).toBe(1)
  })

  test('one ping per evaluation', () => {
    expect(planActions([fire('a', ['ping']), fire('b', ['ping'])]).ping?.trigger.id).toBe('a')
  })
})

describe('rolled-over windows', () => {
  const H = 3_600_000
  const NOW = Date.parse('2026-10-13T10:00:00Z')
  const iso = (ms: number): string => new Date(ms).toISOString()

  test('a window past its reset reads as 0 %, reset unknown, estimated; one ahead of it as reported', () => {
    const l = limitsFrom(
      [
        { kind: 'five_hour', percentUsed: 95, resetsAt: iso(NOW - 60_000) },
        { kind: 'seven_day', percentUsed: 61, resetsAt: iso(NOW + H) },
      ],
      NOW,
    )
    expect(l).toEqual({ five_hour: { pct: 0, resetsAt: null, estimated: true, rolledAt: iso(NOW - 60_000) }, seven_day: { pct: 61, resetsAt: iso(NOW + H) } })
    // Without a time the figures stand as reported.
    expect(limitsFrom([{ kind: 'five_hour', percentUsed: 95, resetsAt: iso(NOW - 60_000) }]).five_hour?.pct).toBe(95)
  })

  test('a window reads as rolled over only a minute past its reset: a fresh figure inside that minute stands', () => {
    const at = (past: number) => limitsFrom([{ kind: 'five_hour', percentUsed: 97, resetsAt: iso(NOW - past) }], NOW).five_hour
    expect(at(59_999)).toEqual({ pct: 97, resetsAt: iso(NOW - 59_999) })
    expect(at(60_000)).toEqual({ pct: 0, resetsAt: null, estimated: true, rolledAt: iso(NOW - 60_000) })
  })

  test('metricsOf reads the windows against its time', () => {
    const r = metricsOf({ rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: iso(NOW - 60_000) }] }, WINDOW, null, NOW)
    expect(r.limits.five_hour).toEqual({ pct: 0, resetsAt: null, estimated: true, rolledAt: iso(NOW - 60_000) })
  })

  const reading = (pct: number, resetsAt: number) => metricsOf({ rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: iso(resetsAt) }] }, WINDOW, null, NOW)
  const stop = { id: 'limit-stop', when: { 'limit.any': 95 }, do: ['note', { deny: ['Agent'] }] }

  test('an estimate keeps the mark; the first reported figures still over fire no second note', () => {
    const t = trigs(stop)
    const first = evaluate(t, reading(96, NOW + H), null, 'lead')
    expect(first.fire.map(f => f.trigger.id)).toEqual(['limit-stop'])
    const rolled = evaluate(t, reading(96, NOW - 60_000), first.marks, 'lead')
    expect(rolled.fire).toEqual([])
    expect(markHeld(rolled.marks, 'lead', 'limit-stop')).toBe(true)
    // The window was in fact still full: fresh figures, same hold, no note.
    const fresh = evaluate(t, reading(97, NOW + 5 * H), rolled.marks, 'lead')
    expect(fresh.fire).toEqual([])
  })

  test('a reported figure below the threshold drops the mark', () => {
    const t = trigs(stop)
    const first = evaluate(t, reading(96, NOW + H), null, 'lead')
    expect(markHeld(evaluate(t, reading(20, NOW + 5 * H), first.marks, 'lead').marks, 'lead', 'limit-stop')).toBe(false)
  })

  test('after a passed reset a percent brake denies nothing until a response reports figures', () => {
    expect(liveDenies(trigs(stop), reading(96, NOW - 60_000), { blocking: true, paused: false })).toEqual([])
  })

  test('limit.any rests on an estimate when either window does', () => {
    const r = metricsOf(
      { rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: iso(NOW - 60_000) }, { kind: 'seven_day', percentUsed: 40, resetsAt: iso(NOW + 9 * H) }] },
      WINDOW,
      null,
      NOW,
    )
    expect(conditions(trigs(stop)[0] as Trigger, r)[0]?.estimated).toBe(true)
  })
})

describe('whenState', () => {
  const H = 3_600_000
  const t = trigs({ id: 'e', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: [{ deny: ['Agent'] }] })[0] as Trigger
  const week = (pct: number, left: number | null) => m({ now: 0, limits: { five_hour: null, seven_day: { pct, resetsAt: left === null ? null : new Date(left).toISOString() } } })

  test('true when every metric is known and holds', () => {
    expect(whenState(t, week(70, 5 * 24 * H))).toBe(true)
  })

  test('false when one metric is known not to hold, whatever the others read', () => {
    expect(whenState(t, week(50, 5 * 24 * H))).toBe(false)
    expect(whenState(t, week(50, null))).toBe(false)
  })

  test('null when one is unknown and none is known false', () => {
    expect(whenState(t, week(70, null))).toBeNull()
    expect(whenState(t, m())).toBeNull()
  })
})

describe('holds and lifts', () => {
  const H = 3_600_000
  const D = 24 * H
  const T0 = Date.parse('2026-10-13T10:00:00Z')
  const iso = (ms: number): string => new Date(ms).toISOString()
  const week = (pct: number, left: number | null, now = T0, five: number | null = null): Metrics =>
    m({
      now,
      limits: {
        five_hour: five === null ? null : { pct: five, resetsAt: iso(now + 2 * H) },
        seven_day: { pct, resetsAt: left === null ? null : iso(now + left) },
      },
    })
  const early = (id: string, pct: number, lift: unknown = { do: ['note'] }) => ({
    id,
    when: { 'limit.seven_day': pct, 'limit.seven_day.resetsIn': '4d' },
    do: ['note', { deny: ['Agent', 'Workflow'] }],
    ...(lift ? { lift } : {}),
  })
  const on = { blocking: true, reports: 0 }
  type Step = { holds: Record<string, Hold>; lifted: string[] }
  const steps = (triggers: Trigger[], readings: Metrics[]): Step[] => {
    let holds: Record<string, Hold> = {}
    return readings.map(r => {
      const s = stepHolds(holds, triggers, r, on)
      holds = s.holds
      return s
    })
  }
  const phases = (s: Step): Record<string, string> => Object.fromEntries(Object.entries(s.holds).map(([id, h]) => [id, h.phase]))

  test('a hold starts while the condition holds and carries the tools and when', () => {
    const [s] = steps(trigs(early('w60', 60)), [week(65, 5 * D)])
    expect(s?.holds.w60).toMatchObject({ phase: 'holding', tools: ['Agent', 'Workflow'], startedAt: T0, tries: 0, touchedAt: null, notedAt: null })
    expect(s?.lifted).toEqual([])
  })

  test('stacked brakes: 60 % lets go while 70 % holds → waits; 70 % lets go → both lift at once', () => {
    // The 60 % brake lets go at 5d left, the 70 % one at 4d.
    const t2 = trigs({ ...early('w60', 60), when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '5d' } }, early('w70', 70))
    const r = steps(t2, [week(75, 6 * D), week(75, 4.5 * D), week(75, 3.5 * D)])
    expect(phases(r[1] as Step)).toEqual({ w60: 'waiting', w70: 'holding' })
    expect(r[1]?.lifted).toEqual([])
    expect(phases(r[2] as Step)).toEqual({ w60: 'lifting', w70: 'lifting' })
    expect(r[2]?.lifted).toEqual(['w60', 'w70'])
  })

  test('stacked brakes with lift only on the 60 % one: it lifts when the 70 % one lets go', () => {
    const t = trigs({ ...early('w60', 60), when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '5d' } }, early('w70', 70, null))
    const r = steps(t, [week(75, 6 * D), week(75, 4.5 * D), week(75, 3.5 * D)])
    expect(phases(r[1] as Step)).toEqual({ w60: 'waiting' })
    expect(r[2]?.lifted).toEqual(['w60'])
  })

  test('a waiting hold whose condition holds again goes back to holding, no lift', () => {
    const t = trigs({ ...early('w60', 60), when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '5d' } }, early('w70', 70))
    const r = steps(t, [week(75, 6 * D), week(75, 4.5 * D), week(75, 5.5 * D)])
    expect(phases(r[2] as Step).w60).toBe('holding')
    expect(r[2]?.lifted).toEqual([])
  })

  test('another trigger on the same tool with an unknown metric does not hold the lift back', () => {
    const t = trigs(early('w60', 60), { id: 'ctx', when: { context: '50%' }, do: [{ deny: ['Agent'] }] })
    const r = steps(t, [week(65, 5 * D), week(65, 3 * D)])
    expect(r[1]?.lifted).toEqual(['w60'])
  })

  test('limit-stop lets go while week-90-early still denies Agent → waits; week-90-early lets go → limit-stop lifts with all four tools', () => {
    const t = defaultTriggers()
    // 96 % with 30h left: both hold; the five-hour window resets and the week sits at 92 % with 30h left.
    const r = steps(t, [week(96, 30 * H, T0), week(92, 30 * H, T0), week(92, 20 * H, T0)])
    expect(phases(r[0] as Step)).toEqual({ 'week-90-early': 'holding', 'limit-stop': 'holding' })
    expect(phases(r[1] as Step)['limit-stop']).toBe('waiting')
    expect(r[2]?.lifted).toEqual(['week-90-early', 'limit-stop'])
    expect(r[2]?.holds['limit-stop']?.tools).toEqual(['Agent', 'Workflow', 'WebSearch', 'WebFetch'])
  })

  test('a .resetsIn lift on time alone: 4d1m left holds, 3d59m lifts', () => {
    const r = steps(trigs(early('w60', 60)), [week(65, 4 * D + 60_000), week(65, 4 * D - 60_000)])
    expect(phases(r[0] as Step)).toEqual({ w60: 'holding' })
    expect(r[1]?.lifted).toEqual(['w60'])
    expect(r[1]?.holds.w60?.liftedAt).toBe(T0)
  })

  test('an AND with one condition known false and one unknown lets go; all unknown changes nothing', () => {
    const t = trigs(early('w60', 60))
    const r = steps(t, [week(65, 5 * D), week(50, null)])
    expect(r[1]?.lifted).toEqual(['w60'])
    const u = steps(t, [week(65, 5 * D), m({ now: T0 })])
    expect(phases(u[1] as Step)).toEqual({ w60: 'holding' })
  })

  test('a lifting hold stays lifting until its condition holds again', () => {
    const t = trigs(early('w60', 60))
    const r = steps(t, [week(65, 5 * D), week(65, 3 * D), week(65, 2 * D), week(65, 5 * D)])
    expect(phases(r[2] as Step)).toEqual({ w60: 'lifting' })
    expect(r[2]?.lifted).toEqual([])
    expect(phases(r[3] as Step)).toEqual({ w60: 'holding' })
  })

  test('a lifting hold whose tools another brake starts denying waits again, stamps kept; it lifts once that brake lets go', () => {
    const t = trigs(early('w60', 60), { id: 'stop', when: { 'limit.five_hour': 95 }, do: [{ deny: ['Agent'] }] })
    const r = steps(t, [week(65, 5 * D), week(65, 3 * D, T0, 10), week(65, 3 * D, T0 + H, 96), week(65, 3 * D, T0 + 2 * H, 10)])
    expect(phases(r[1] as Step)).toEqual({ w60: 'lifting' })
    expect(phases(r[2] as Step)).toEqual({ w60: 'waiting' })
    expect(r[2]?.lifted).toEqual([])
    expect(r[2]?.holds.w60).toMatchObject({ startedAt: T0, tries: 0 })
    expect(r[3]?.lifted).toEqual(['w60'])
    expect(r[3]?.holds.w60).toMatchObject({ phase: 'lifting', liftedAt: T0 + 2 * H, startedAt: T0 })
  })

  test('blocking off drops every hold, and none starts while it stays off', () => {
    const t = trigs(early('w60', 60))
    const held = stepHolds({}, t, week(65, 5 * D), on).holds
    expect(stepHolds(held, t, week(65, 3 * D), { ...on, blocking: false })).toEqual({ holds: {}, lifted: [] })
    expect(stepHolds({}, t, week(65, 5 * D), { ...on, blocking: false }).holds).toEqual({})
  })

  test('a reload that removes the trigger, its lift, a deny tool, or changes its when drops the hold with no lift', () => {
    const held = stepHolds({}, trigs(early('w60', 60)), week(65, 5 * D), on).holds
    const later = week(65, 3 * D)
    expect(stepHolds(held, trigs(early('other', 60)), later, on)).toEqual({ holds: {}, lifted: [] })
    expect(stepHolds(held, trigs(early('w60', 60, null)), later, on)).toEqual({ holds: {}, lifted: [] })
    expect(stepHolds(held, trigs({ ...early('w60', 60), do: ['note', { deny: ['Agent'] }] }), later, on)).toEqual({ holds: {}, lifted: [] })
    expect(stepHolds(held, trigs({ ...early('w60', 60), when: { 'limit.seven_day': 61, 'limit.seven_day.resetsIn': '4d' } }), later, on).lifted).toEqual([])
    // The same config keeps it.
    expect(stepHolds(held, trigs(early('w60', 60)), later, on).lifted).toEqual(['w60'])
  })

  test('a frozen hold is left as it is', () => {
    const t = trigs(early('w60', 60))
    const lifting = stepHolds(stepHolds({}, t, week(65, 5 * D), on).holds, t, week(65, 3 * D), on).holds
    const back = stepHolds(lifting, t, week(65, 5 * D), { ...on, frozen: new Set(['w60']) })
    expect(back.holds.w60?.phase).toBe('lifting')
  })

  test('a stalled hold lifts again only after a newer usage report or its reset', () => {
    const t = trigs(early('w60', 60))
    const stalled: Hold = { ...(stepHolds({}, t, week(65, 5 * D), on).holds.w60 as Hold), phase: 'stalled', tries: 3, stall: { reports: 4, until: T0 + H } }
    const prev = { w60: stalled }
    expect(stepHolds(prev, t, week(65, 3 * D), { ...on, reports: 4 }).holds.w60?.phase).toBe('stalled')
    const report = stepHolds(prev, t, week(65, 3 * D), { ...on, reports: 5 })
    expect(report.lifted).toEqual(['w60'])
    expect(report.holds.w60).toMatchObject({ phase: 'lifting', tries: 0, stall: null, startedAt: T0 })
    expect(stepHolds(prev, t, week(65, 3 * D, T0 + H), { ...on, reports: 4 }).lifted).toEqual(['w60'])
    // Held again on fresh figures: back to holding, stamps kept.
    expect(stepHolds(prev, t, week(65, 5 * D), { ...on, reports: 4 }).holds.w60).toMatchObject({ phase: 'holding', tries: 0, startedAt: T0 })
  })

  test('toolsFree and blockedBy follow the call path', () => {
    const t = trigs(early('w60', 60), early('w70', 70))
    expect(toolsFree(t[0] as Trigger, t, week(75, 3 * D))).toBe(true)
    expect(toolsFree(t[0] as Trigger, t, week(75, 5 * D))).toBe(false)
    const both = week(75, 5 * D)
    expect(blockedBy('w60', ['Agent'], t, both)).toBe('w70')
    expect(toolsFree(t[0] as Trigger, t, week(50, 5 * D))).toBe(true)
  })
})

describe('liftsIn', () => {
  const H = 3_600_000
  const D = 24 * H
  const G = ROLL_OVER_GRACE_MS
  const T0 = Date.parse('2026-10-13T10:00:00Z')
  const iso = (ms: number): string => new Date(ms).toISOString()
  const at = (five: number | null, fiveLeft: number | null, week: number | null, weekLeft: number | null): Metrics =>
    m({
      now: T0,
      limits: {
        five_hour: five === null ? null : { pct: five, resetsAt: fiveLeft === null ? null : iso(T0 + fiveLeft) },
        seven_day: week === null ? null : { pct: week, resetsAt: weekLeft === null ? null : iso(T0 + weekLeft) },
      },
    })

  test('a .resetsIn condition: the time left less its threshold', () => {
    const t = trigs({ id: 'e', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: [{ deny: ['Agent'] }] })[0] as Trigger
    expect(liftsInMs(t, at(null, null, 70, 4 * D + 5 * H))).toBe(5 * H)
    expect(liftsInMs(t, at(null, null, 70, null))).toBeNull()
  })

  test('a percent alone: the time until its window reads as rolled over', () => {
    const t = trigs({ id: 's', when: { 'limit.five_hour': 90 }, do: [{ deny: ['Agent'] }] })[0] as Trigger
    expect(liftsInMs(t, at(95, 2 * H, null, null))).toBe(2 * H + G)
    // Reset 30 s ago: the grace has 30 s left.
    expect(liftsInMs(t, at(95, -30_000, null, null))).toBe(G - 30_000)
    expect(liftsInMs(t, at(95, -G, null, null))).toBe(0)
  })

  test('limit.any: the latest reset among the windows at or over the threshold', () => {
    const t = trigs({ id: 's', when: { 'limit.any': 95 }, do: [{ deny: ['Agent'] }] })[0] as Trigger
    expect(liftsInMs(t, at(96, 2 * H, 97, 3 * D))).toBe(3 * D + G)
    expect(liftsInMs(t, at(96, 2 * H, 40, 3 * D))).toBe(2 * H + G)
    expect(liftsInMs(t, at(96, null, 40, 3 * D))).toBeNull()
  })

  test('a context trigger is unknown', () => {
    const t = trigs({ id: 'c', when: { context: '80%' }, do: [{ deny: ['Agent'] }] })[0] as Trigger
    expect(liftsInMs(t, m({ tokens: 900_000 }))).toBeNull()
  })

  test('a tool comes free when the last brake on it lets go; unknown when one is unknown', () => {
    const t = trigs(
      { id: 'e', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: [{ deny: ['Agent'] }] },
      { id: 's', when: { 'limit.five_hour': 90 }, do: [{ deny: ['Agent', 'WebFetch'] }] },
    )
    expect(toolLiftsIn('Agent', t, at(95, 2 * H, 70, 4 * D + 5 * H))).toBe(5 * H)
    expect(toolLiftsIn('Agent', t, at(95, 6 * H, 70, 4 * D + 5 * H))).toBe(6 * H + G)
    expect(toolLiftsIn('WebFetch', t, at(95, 2 * H, 70, 4 * D + 5 * H))).toBe(2 * H + G)
    expect(toolLiftsIn('Agent', [...t, ...trigs({ id: 'c', when: { context: '50%' }, do: [{ deny: ['Agent'] }] })], { ...at(95, 2 * H, 70, 4 * D), tokens: 900_000 })).toBeNull()
  })

  test('the fired vars carry liftsIn', () => {
    const t = trigs({ id: 'e', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: ['note', { deny: ['Agent'] }] })
    expect(evaluate(t, at(null, null, 70, 4 * D + 5 * H), null, 'lead').fire[0]?.vars.liftsIn).toBe(5 * H)
  })
})

describe('times exempt', () => {
  test('an exempt fire passes uncounted, even past its times', () => {
    const t = trigs({ id: 'b', when: { 'limit.any': 95 }, do: ['note', { deny: ['Agent'] }], times: 1 })
    const f = evaluate(t, m({ five: 96 }), null, 'lead').fire
    expect(applyTimes(f, { b: 1 }, new Set(['b']))).toEqual({ fire: f, fired: { b: 1 } })
    expect(applyTimes(f, { b: 1 }).fire).toEqual([])
  })
})
