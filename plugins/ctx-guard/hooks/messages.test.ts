import { describe, expect, test } from 'claude-code/testing'

import { defaultTriggers, roleSpec, validate } from './config'
import {
  DEFAULT_PROMPT,
  DEFAULT_WAKE_PROMPT,
  NOT_WOKEN,
  TEMPLATE_VARS,
  clearNoteText,
  collapseNotes,
  denyReason,
  effectiveMode,
  handoffInstructionsFor,
  handoffPathFor,
  humanDuration,
  humanPercent,
  humanTokens,
  humanUsd,
  levelText,
  liftCheckFailedText,
  liftNoteText,
  liftNotifyText,
  liftReason,
  liftToastText,
  noteText,
  noteToastText,
  isOwnPrompt,
  promptText,
  refusalNote,
  render,
  restartTail,
  subagentDenyReason,
  subagentStopText,
  subagentWarnText,
  templateVars,
  toastText,
  wakeCancelledText,
  wakePromptText,
} from './messages'
import { NO_CACHE, evaluate, readingVars } from './triggers'
import type { Fire, FireVars, Metrics } from './triggers'
import type { RoleSpec } from '../types'

const NOW = Date.parse('2026-10-13T10:00:00Z')
const RESET = '2026-10-13T12:10:00Z' // 2h10m after NOW

function spec(role: unknown): RoleSpec {
  const r = validate({ version: 1, roles: { lead: role } })
  expect(r.errors).toEqual([])
  return roleSpec(r.config as NonNullable<typeof r.config>, 'lead') as RoleSpec
}

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    tokens: 312_000,
    window: 1_000_000,
    limits: { five_hour: { pct: 82, resetsAt: RESET }, seven_day: { pct: 40, resetsAt: null } },
    cost: 1.5,
    idleMs: null,
    cache: NO_CACHE,
    now: NOW,
    ...over,
  }
}

function fires(s: RoleSpec, m = metrics()): Fire[] {
  return evaluate(s.triggers, m, null, 'lead').fire
}

function note(s: RoleSpec, f: Fire): string {
  return noteText({ trigger: f.trigger, vars: f.vars, role: 'lead', spec: s, readyToken: 'CTX-READY' })
}

describe('render', () => {
  test('fills known vars; unknown placeholders stay', () => {
    expect(render('{role} at {tokens} {nope} {x y} {}', { role: 'lead', tokens: '312k' })).toBe('lead at 312k {nope} {x y} {}')
  })

  test('prototype names are not vars', () => {
    expect(render('{constructor}', {})).toBe('{constructor}')
  })
})

describe('humanize', () => {
  test('tokens', () => {
    expect(humanTokens(850)).toBe('850')
    expect(humanTokens(1500)).toBe('1.5k')
    expect(humanTokens(312_400)).toBe('312k')
    expect(humanTokens(999_600)).toBe('1M')
    expect(humanTokens(1_000_000)).toBe('1M')
    expect(humanTokens(1_200_000)).toBe('1.2M')
  })

  test('percent', () => {
    expect(humanPercent(31.2)).toBe('31%')
    expect(humanPercent(7.5)).toBe('7.5%')
    expect(humanPercent(80)).toBe('80%')
  })

  test('durations', () => {
    expect(humanDuration(45_000)).toBe('45s')
    expect(humanDuration(12 * 60_000)).toBe('12m')
    expect(humanDuration((2 * 60 + 10) * 60_000)).toBe('2h10m')
    expect(humanDuration(2 * 3_600_000)).toBe('2h')
    expect(humanDuration((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
    expect(humanDuration(-5)).toBe('0s')
  })

  test('usd', () => {
    expect(humanUsd(2.5)).toBe('$2.50')
  })
})

describe('template vars', () => {
  test('every variable, humanized', () => {
    const s = spec({ triggers: [{ id: '5h', when: { 'limit.five_hour': 80 }, do: ['note'] }] })
    const f = fires(s)[0] as Fire
    expect(templateVars(f.vars, { role: 'lead', handoffPath: '.ctx-guard/lead-handoff.md', readyToken: 'CTX-READY' }, f.trigger)).toEqual({
      id: '5h',
      tools: 'unknown',
      // The reset plus the 1-minute roll-over grace.
      liftsIn: '2h11m',
      role: 'lead',
      tokens: '312k',
      percent: '31%',
      threshold: '80%',
      window: '1M',
      limit: '5-hour 82%',
      resetsIn: '2h10m',
      handoffPath: '.ctx-guard/lead-handoff.md',
      readyToken: 'CTX-READY',
      idle: 'unknown',
      expiresIn: 'unknown',
    })
  })

  test('unknown figures say so', () => {
    const s = spec({ triggers: [{ id: 'c', when: { cost: 1 }, do: ['note'] }] })
    const f = fires(s, metrics({ limits: { five_hour: null, seven_day: null } }))[0] as Fire
    const v = templateVars({ ...f.vars, tokens: null, percent: null }, { role: null, handoffPath: null, readyToken: 'R' })
    expect(v).toMatchObject({ role: 'none', tokens: 'unknown', percent: 'unknown', limit: 'unknown', resetsIn: 'unknown' })
  })
})

describe('level wording', () => {
  const ladder = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      when: { context: `${10 + i * 5}%` },
      do: ['note'],
      level: (['soft', 'hard', 'stop'] as const)[Math.min(i, 2)],
    }))

  const COUNT_WORDING = /\b(first|second|third|last|final|one|two|three|four|five) of\b|\bof (two|three|four|five)\b|\d+\s*(of|\/)\s*\d+ (thresholds|triggers|notes)/i

  for (const n of [1, 2, 5]) {
    test(`${n} trigger(s) crossed at once: one note, no count wording`, () => {
      const s = spec({ restart: { mode: 'auto' }, notes: { suffix: 'Ping the peer.' }, triggers: ladder(n) })
      const f = fires(s, metrics({ tokens: 900_000 }))
      expect(f).toHaveLength(n)
      const text = collapseNotes(f, { role: 'lead', spec: s, readyToken: 'CTX-READY' }) as string
      expect(text).toStartWith('[ctx-guard] ')
      expect(text.split('[ctx-guard]')).toHaveLength(2)
      expect(text.split('Context is at')).toHaveLength(2)
      expect(text.split('At the next safe point')).toHaveLength(2)
      expect(text.split('Ping the peer.')).toHaveLength(2)
      expect(text).toContain(`past ${10 + (n - 1) * 5}%.`)
      expect(text).toContain(levelText((['soft', 'hard', 'stop'] as const)[Math.min(n - 1, 2)] ?? 'soft', 'context'))
      expect(text).not.toMatch(COUNT_WORDING)
      for (const one of f) expect(note(s, one)).not.toMatch(COUNT_WORDING)
    })
  }

  test('collapse: one head per figure, highest level wording, custom messages kept', () => {
    const s = spec({
      restart: { mode: 'off' },
      triggers: [
        { id: 'c1', when: { context: '200k' }, do: ['note'], level: 'stop' },
        { id: 'c2', when: { context: '300k' }, do: ['note'], level: 'soft' },
        { id: 'l', when: { 'limit.five_hour': 80 }, do: ['note'], level: 'hard' },
        { id: 'm', when: { cost: 1 }, do: ['note'], message: '[ctx-guard] cost is {threshold}+' },
      ],
    })
    const text = collapseNotes(fires(s), { role: 'lead', spec: s, readyToken: 'R' })
    expect(text).toBe(
      '[ctx-guard] Context is at 312k (31% of 1M), past 300k. 5-hour usage is at 82%, past 80%. The window resets in 2h10m. ' +
        `${levelText('stop', 'context')} cost is $1.00+`,
    )
    expect(collapseNotes([], { role: 'lead', spec: s, readyToken: 'R' })).toBeNull()
  })

  test('each level has its own text; none is neutral', () => {
    const texts = (['soft', 'hard', 'stop', null] as const).map(l => levelText(l, 'context'))
    expect(new Set(texts).size).toBe(4)
    expect(levelText('stop', 'context')).toMatch(/^Stop/)
    expect(levelText('hard', 'context')).toMatch(/^Wrap up/)
    expect(levelText('soft', 'context')).toMatch(/^Plan/)
    expect(levelText(null, 'context')).not.toMatch(/stop|wrap up/i)
  })

  test('a context note names the figure and threshold', () => {
    const s = spec({ restart: { mode: 'off' }, triggers: [{ id: 'h', when: { context: '300k' }, do: ['note'], level: 'hard' }] })
    expect(note(s, fires(s)[0] as Fire)).toBe(
      '[ctx-guard] Context is at 312k (31% of 1M), past 300k. Wrap up: start no new item and bring the current one to a safe point.',
    )
  })

  test('a limit note names the window and reset time', () => {
    const s = spec({ restart: { mode: 'off' }, triggers: [{ id: '5h', when: { 'limit.any': 80 }, do: ['note'], level: 'soft' }] })
    const text = note(s, fires(s)[0] as Fire)
    expect(text).toContain('5-hour usage is at 82%, past 80%.')
    expect(text).toContain('resets in 2h10m')
    expect(text).toContain(levelText('soft', 'limit.any'))
  })

  test('a note on usage, cost or idle alone asks for no restart; one with a context trigger keeps the tail once', () => {
    const triggers = [
      { id: 'week', when: { 'limit.seven_day': 30 }, do: ['note'], level: 'soft' },
      { id: 'spend', when: { cost: 1 }, do: ['note'] },
    ]
    const s = spec({ restart: { mode: 'auto' }, notes: { suffix: 'Tell the peer.' }, triggers })
    const text = collapseNotes(fires(s), { role: 'lead', spec: s, readyToken: 'CTX-READY' }) as string
    expect(text).toBe(`[ctx-guard] Weekly usage is at 40%, past 30%. Session cost is $1.50, past $1.00. ${levelText('soft', 'limit.any')} Tell the peer.`)
    expect(text).not.toContain('CTX-READY')
    const mixed = spec({ restart: { mode: 'auto' }, triggers: [...triggers, { id: 'ctx', when: { context: '300k' }, do: ['note'] }] })
    const both = collapseNotes(fires(mixed), { role: 'lead', spec: mixed, readyToken: 'CTX-READY' }) as string
    expect(both.split('CTX-READY').length).toBe(2)
    expect(both).toContain('Weekly usage is at 40%')
  })

  test('a custom message replaces the built-in text; prefix added once', () => {
    const s = spec({
      restart: { mode: 'off' },
      triggers: [
        { id: 'a', when: { context: '300k' }, do: ['note'], message: '{role}: {tokens} > {threshold}, {mystery}' },
        { id: 'b', when: { context: '200k' }, do: ['note'], message: '[ctx-guard] already prefixed' },
      ],
    })
    const [a, b] = fires(s).map(f => note(s, f))
    expect(a).toBe('[ctx-guard] lead: 312k > 300k, {mystery}')
    expect(b).toBe('[ctx-guard] already prefixed')
  })
})

describe('built-in early weekly brake', () => {
  test('one note: the usage head, the soft wording and the brake message', () => {
    const s = spec({ restart: { mode: 'off' } })
    expect(s.triggers).toEqual(defaultTriggers())
    const m = metrics({ limits: { five_hour: null, seven_day: { pct: 85, resetsAt: new Date(NOW + 3 * 24 * 3_600_000).toISOString() } } })
    const f = fires(s, m)
    expect(f.map(x => x.trigger.id)).toEqual(['limit-soft', 'week-80-early'])
    expect(collapseNotes(f, { role: 'lead', spec: s, readyToken: 'CTX-READY' })).toBe(
      `[ctx-guard] Weekly usage is at 85%, past 80%. The window resets in 3d. ${levelText('soft', 'limit.any')} ` +
        'With 3d still to the weekly reset, start no new subagents so the rest of the window lasts; do small steps in this session.',
    )
  })
})

describe('restart tail', () => {
  const instructions = 'Rewrite whole. Sections: Goal, State, Next action'
  const base = (restart: unknown, handoff: unknown = { instructions }) =>
    spec({ restart, handoff, triggers: [{ id: 's', when: { context: '1k' }, do: ['note'], level: 'soft' }] })

  test('auto: write the handoff, then the ready token', () => {
    const s = base({ mode: 'auto' })
    expect(restartTail(s, 'lead', 'CTX-READY')).toBe(
      'At the next safe point — no subagents running, current work recorded — write the handoff to `.ctx-guard/lead-handoff.md`: ' +
        'Rewrite whole. Sections: Goal, State, Next action. Then end your reply with a line holding only `CTX-READY`.',
    )
  })

  test('manual: tell the operator', () => {
    const s = base({ mode: 'manual' })
    const tail = restartTail(s, 'lead', 'CTX-READY')
    expect(tail).toContain('write the handoff to `.ctx-guard/lead-handoff.md`: Rewrite whole.')
    expect(tail).toEndWith("Then tell the operator 'ready for /clear'.")
    expect(tail).not.toContain('CTX-READY')
  })

  test('off: no tail', () => {
    const s = base({ mode: 'off' })
    expect(restartTail(s, 'lead', 'CTX-READY')).toBe('')
    expect(note(s, fires(s)[0] as Fire)).not.toContain('safe point')
  })

  test('instructions naming a skill pass through with {role} filled in', () => {
    const named = 'Write it with the session-handoff skill (project slug `ctx-guard-{role}`), then copy it here; {role} owns it. Keep {x}'
    const s = base({ mode: 'auto' }, { instructions: named })
    expect(handoffInstructionsFor(s, 'lead')).toBe(
      'Write it with the session-handoff skill (project slug `ctx-guard-lead`), then copy it here; lead owns it. Keep {x}',
    )
    const tail = restartTail(s, 'lead', 'CTX-READY')
    expect(tail).toContain('write the handoff to `.ctx-guard/lead-handoff.md`: Write it with the session-handoff skill (project slug `ctx-guard-lead`)')
    expect(tail).toContain('lead owns it. Keep {x}. Then end your reply')
    expect(tail).not.toContain('{role}')
    expect(handoffInstructionsFor(base({ mode: 'auto' }, {}), 'lead')).toBeNull()
  })

  test('no instructions: the bare path', () => {
    const s = base({ mode: 'auto' }, { path: 'h.md' })
    expect(restartTail(s, 'lead', 'GO')).toBe(
      'At the next safe point — no subagents running, current work recorded — write the handoff to `h.md`. Then end your reply with a line holding only `GO`.',
    )
  })

  test('via compact needs no handoff, and the note plans for the compaction', () => {
    const s = base({ mode: 'auto', via: 'compact' })
    expect(restartTail(s, 'lead', 'GO')).toBe(
      'At the next safe point — no subagents running, current work recorded — end your reply with a line holding only `GO`; ctx-guard then compacts the session.',
    )
    expect(restartTail(base({ mode: 'manual', via: 'compact' }), 'lead', 'GO')).toEndWith("tell the operator 'ready for /compact'.")
    const text = note(s, fires(s)[0] as Fire)
    expect(text).toContain('Plan for a compaction: finish the item in hand')
    expect(text).not.toContain('handoff')
    expect(note(base({ mode: 'auto' }), fires(base({ mode: 'auto' }))[0] as Fire)).toContain('Plan for a handoff')
  })

  test('the custom handoff path and token land in the note', () => {
    const s = spec({
      restart: { mode: 'auto' },
      handoff: { path: 'notes/{role}.md' },
      triggers: [{ id: 's', when: { context: '1k' }, do: ['note'] }],
    })
    const text = noteText({ trigger: s.triggers[0] as NonNullable<RoleSpec['triggers'][0]>, vars: (fires(s)[0] as Fire).vars, role: 'lead', spec: s, readyToken: 'GO-NOW' })
    expect(text).toContain('`notes/lead.md`')
    expect(text).toContain('`GO-NOW`')
  })

  test('effective mode: auto drops to manual when ctx-guard would not act', () => {
    const s = base({ mode: 'auto' })
    const ok = { autoActions: true, trusted: true, paused: false }
    expect(effectiveMode(s, ok)).toBe('auto')
    expect(effectiveMode(s, { ...ok, autoActions: false })).toBe('manual')
    expect(effectiveMode(s, { ...ok, trusted: false })).toBe('manual')
    expect(effectiveMode(s, { ...ok, paused: true })).toBe('manual')
    expect(effectiveMode(base({ mode: 'off' }), { ...ok, paused: true })).toBe('off')
    expect(effectiveMode(base({ mode: 'manual' }), ok)).toBe('manual')
    const f = fires(s)[0] as Fire
    const text = noteText({ trigger: f.trigger, vars: f.vars, role: 'lead', spec: s, readyToken: 'CTX-READY', mode: effectiveMode(s, { ...ok, trusted: false }) })
    expect(text).toContain("tell the operator 'ready for /clear'")
    expect(text).not.toContain('CTX-READY')
  })

  test('the suffix comes after the tail', () => {
    const s = spec({
      restart: { mode: 'auto' },
      notes: { suffix: 'Tell {role}-peer before you stop.' },
      triggers: [{ id: 's', when: { context: '1k' }, do: ['note'], level: 'stop' }],
    })
    const text = note(s, fires(s)[0] as Fire)
    expect(text).toEndWith('`CTX-READY`. Tell lead-peer before you stop.')
  })

  test('suffix with mode off', () => {
    const s = spec({ restart: { mode: 'off' }, notes: { suffix: 'Ping the peer.' }, triggers: [{ id: 's', when: { context: '1k' }, do: ['note'] }] })
    expect(note(s, fires(s)[0] as Fire)).toEndWith('next steps. Ping the peer.')
  })
})

describe('clear note', () => {
  const instructions = 'Rewrite whole. Sections: Goal, State, Next action'
  const base = (restart: unknown, suffix: string | null = null) =>
    spec({ restart, handoff: { instructions }, notes: { suffix }, triggers: [{ id: 'stop', when: { context: '1k' }, do: ['note'], level: 'stop' }] })
  // The live figures: 120k of a 200k window.
  const vars = readingVars({ tokens: 120_000, window: 200_000, limits: { five_hour: null, seven_day: null }, cost: null, idleMs: null, cache: { ...NO_CACHE }, now: 0 })

  test('auto: the stop wording and the restart tail a stop-level context note carries', () => {
    const s = base({ mode: 'auto' })
    const text = clearNoteText({ role: 'lead', spec: s, readyToken: 'CTX-READY', vars }) as string
    expect(text).toBe(
      `[ctx-guard] The operator asked for a restart with /ctx-guard:clear. ${levelText('stop', 'context')} ${restartTail(s, 'lead', 'CTX-READY')}`,
    )
    expect(note(s, fires(s)[0] as Fire)).toEndWith(`${levelText('stop', 'context')} ${restartTail(s, 'lead', 'CTX-READY')}`)
  })

  test('the effective mode: manual tells the operator and names no token', () => {
    const s = base({ mode: 'auto' })
    const text = clearNoteText({ role: 'lead', spec: s, readyToken: 'CTX-READY', mode: 'manual', vars }) as string
    expect(text).toEndWith("Then tell the operator 'ready for /clear'.")
    expect(text).not.toContain('CTX-READY')
  })

  test('via compact: no handoff, the token compacts', () => {
    const text = clearNoteText({ role: 'lead', spec: base({ mode: 'auto', via: 'compact' }), readyToken: 'R', vars }) as string
    expect(text).not.toContain('handoff')
    expect(text).toEndWith('end your reply with a line holding only `R`; ctx-guard then compacts the session.')
  })

  test('mode off: no note', () => {
    expect(clearNoteText({ role: 'lead', spec: base({ mode: 'off' }), readyToken: 'R', vars })).toBeNull()
  })

  test('the suffix closes the note: role, path and token filled, figures from the live reading', () => {
    const s = base({ mode: 'auto' }, 'Tell main ({role}, {handoffPath}, {readyToken}) at {tokens}, {percent} of {window}, past {threshold}. Keep {x}')
    expect(clearNoteText({ role: 'lead', spec: s, readyToken: 'R', vars })).toEndWith(
      'Then end your reply with a line holding only `R`. Tell main (lead, .ctx-guard/lead-handoff.md, R) at 120k, 60% of 200k, past unknown. Keep {x}',
    )
  })

  test('the close is the stop-level context note\'s: the same tail and suffix', () => {
    const s = base({ mode: 'auto' }, 'Ping the peer ({role}).')
    const close = `${restartTail(s, 'lead', 'CTX-READY')} Ping the peer (lead).`
    expect(clearNoteText({ role: 'lead', spec: s, readyToken: 'CTX-READY', vars })).toEndWith(close)
    expect(note(s, fires(s)[0] as Fire)).toEndWith(close)
  })
})

describe('deny reason', () => {
  test('names the trigger, the metric and how to lift it', () => {
    const s = spec({ triggers: [{ id: 'brake', when: { 'limit.any': 80 }, do: [{ deny: ['Agent'] }] }] })
    const text = denyReason('Agent', s.triggers[0] as NonNullable<RoleSpec['triggers'][0]>, metrics())
    expect(text).toBe(
      '[ctx-guard] Agent is blocked by trigger "brake": 5-hour usage 82% ≥ 80%. Carry on without Agent; the block lifts ' +
        'when the usage window resets (in 2h10m), or when the operator runs /ctx-guard pause, changes trigger "brake" in the ' +
        'ctx-guard config, or turns blocking off in /config. If you need Agent now, ask the operator.',
    )
    expect(text).not.toMatch(/\b(run|wait for|change) [/"a-z]/)
  })

  test('a context deny suggests clearing or compacting', () => {
    const s = spec({ triggers: [{ id: 'full', when: { context: '300k' }, do: [{ deny: ['Agent'] }] }] })
    const text = denyReason('Agent', s.triggers[0] as NonNullable<RoleSpec['triggers'][0]>, metrics())
    expect(text).toContain('context 312k ≥ 300k')
    expect(text).toContain('when the context shrinks after a /clear or /compact')
    expect(text).not.toContain('reset')
  })

  test('a time-left condition names it and when the nearing reset lifts it', () => {
    const DAY = 24 * 3_600_000
    const s = spec({
      triggers: [{ id: 'early', when: { 'limit.seven_day': 80, 'limit.seven_day.resetsIn': '2d' }, do: [{ deny: ['Agent'] }] }],
    })
    const m = metrics({ limits: { five_hour: null, seven_day: { pct: 85, resetsAt: new Date(NOW + 3 * DAY).toISOString() } } })
    const text = denyReason('Agent', s.triggers[0] as NonNullable<RoleSpec['triggers'][0]>, m)
    expect(text).toBe(
      '[ctx-guard] Agent is blocked by trigger "early": weekly usage 85% ≥ 80% and time to the weekly reset 3d ≥ 2d. ' +
        'Carry on without Agent; the block lifts when the weekly reset is less than 2d away (in 1d), ' +
        'when the usage window resets (in 3d), or when the operator runs /ctx-guard pause, changes trigger "early" in the ' +
        'ctx-guard config, or turns blocking off in /config. If you need Agent now, ask the operator.',
    )
  })

  test('names when the tool comes free, and whether ctx-guard prompts then', () => {
    const s = spec({ triggers: [{ id: 'brake', when: { 'limit.any': 80 }, do: [{ deny: ['Agent'] }] }] })
    const t = s.triggers[0] as NonNullable<RoleSpec['triggers'][0]>
    const tail = (lift: { liftsIn: number | null; wakes: boolean }) => denyReason('Agent', t, metrics(), lift).split('/config.')[1]
    expect(tail({ liftsIn: 5 * 3_600_000, wakes: false })).toBe(' Agent comes free in 5h. If you need Agent now, ask the operator.')
    expect(tail({ liftsIn: 5 * 3_600_000, wakes: true })).toBe(
      ' Agent comes free in 5h; ctx-guard is set to prompt you when the tool comes free. If you need Agent now, ask the operator.',
    )
    expect(tail({ liftsIn: null, wakes: false })).toBe(' Agent comes free at a time not known yet. If you need Agent now, ask the operator.')
  })
})

describe('lift texts', () => {
  const H = 3_600_000
  const DAY = 24 * H
  const iso = (ms: number): string => new Date(ms).toISOString()
  const ctx = { role: 'lead', handoffPath: '.ctx-guard/lead-handoff.md', readyToken: 'CTX-READY' }
  const brake = (raw: Record<string, unknown>) => spec({ triggers: [{ do: ['note', { deny: ['Agent', 'Workflow'] }], ...raw }] }).triggers[0] as NonNullable<RoleSpec['triggers'][0]>
  const at = (five: { pct: number; resetsAt: string | null; estimated?: true } | null, week: { pct: number; resetsAt: string | null; estimated?: true } | null) =>
    metrics({ limits: { five_hour: five, seven_day: week } })
  const stop = brake({ id: 'limit-stop', when: { 'limit.any': 95 }, lift: { do: ['note'] } })
  const w60 = brake({ id: 'week-60-early', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, lift: { do: ['note'] } })

  test('liftReason: a window reset, a reported percent, a .resetsIn, limit.any and a context trigger', () => {
    expect(liftReason(brake({ id: 'f', when: { 'limit.five_hour': 90 } }), at({ pct: 0, resetsAt: null, estimated: true }, null))).toBe('the 5-hour usage window reset')
    expect(liftReason(w60, at(null, { pct: 0, resetsAt: null, estimated: true }))).toBe('the weekly usage window reset')
    expect(liftReason(w60, at(null, { pct: 55, resetsAt: iso(NOW + 5 * DAY) }))).toBe('weekly usage is below 60%')
    expect(liftReason(w60, at(null, { pct: 70, resetsAt: iso(NOW + 3 * DAY) }))).toBe('the weekly reset is less than 4d away')
    expect(liftReason(stop, at({ pct: 0, resetsAt: null, estimated: true }, { pct: 40, resetsAt: iso(NOW + DAY) }))).toBe('the 5-hour usage window reset')
    expect(liftReason(stop, at({ pct: 10, resetsAt: iso(NOW + H) }, { pct: 40, resetsAt: iso(NOW + DAY) }), 'five_hour')).toBe('5-hour usage is below 95%')
    expect(liftReason(brake({ id: 'c', when: { context: '300k' } }), metrics({ tokens: 10_000 }))).toBe('its condition no longer holds')
  })

  const rolled = at({ pct: 0, resetsAt: null, estimated: true }, { pct: 40, resetsAt: iso(NOW + DAY) })

  test('the default lift note, wake prompt, toast and notifies', () => {
    const l = { trigger: stop, metrics: rolled, window: 'five_hour' }
    expect(liftNoteText([l], ctx)).toBe('[ctx-guard] Trigger "limit-stop" has lifted: the 5-hour usage window reset. Agent, Workflow are allowed again.')
    expect(wakePromptText(l, ctx)).toBe(
      '[ctx-guard] Trigger "limit-stop" has lifted: the 5-hour usage window reset. Agent, Workflow are allowed again. You paused your work because of it. ' +
        'Time has passed since then, so first check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. ' +
        'Then carry on with the work you paused. If nothing is left to do, say so in one line and stop.',
    )
    expect(DEFAULT_WAKE_PROMPT.startsWith('[ctx-guard] Trigger "{id}" has lifted')).toBe(true)
    expect(liftToastText([l])).toBe('ctx-guard: "limit-stop" lifted (the 5-hour usage window reset); Agent, Workflow allowed again.')
    expect(liftNotifyText([{ lift: l, why: NOT_WOKEN.untrusted }])).toBe(
      'ctx-guard: "limit-stop" lifted (the 5-hour usage window reset); Agent, Workflow allowed again. Not woken: the repo is not trusted.',
    )
    expect(liftCheckFailedText(['week-60-early'])).toBe(
      'ctx-guard: "week-60-early" may have lifted, but fresh usage could not be read (the window may still be full). Not woken; ctx-guard tries again when usage is next reported or the window resets.',
    )
  })

  test('the toast of a cancelled /ctx-guard wake names its window and why', () => {
    expect(wakeCancelledText('five_hour', 'back')).toBe('ctx-guard: the wake after the 5-hour reset is cancelled: you are back.')
    expect(wakeCancelledText('seven_day', { role: 'reviewer' })).toBe('ctx-guard: the wake after the weekly reset is cancelled: the role is now reviewer.')
    expect(wakeCancelledText('five_hour', { role: null })).toBe('ctx-guard: the wake after the 5-hour reset is cancelled: the role is now none.')
  })

  test('several lifts make one note and one notify naming them', () => {
    const a = { trigger: stop, metrics: rolled, window: 'five_hour' }
    const b = { trigger: w60, metrics: at(null, { pct: 70, resetsAt: iso(NOW + 3 * DAY) }), window: null }
    expect(liftNoteText([a, b], ctx)).toBe(
      '[ctx-guard] Trigger "limit-stop" has lifted: the 5-hour usage window reset. Agent, Workflow are allowed again. ' +
        'Trigger "week-60-early" has lifted: the weekly reset is less than 4d away. Agent, Workflow are allowed again.',
    )
    expect(liftNotifyText([{ lift: a, why: NOT_WOKEN.paused }, { lift: b, why: NOT_WOKEN.paused }])).toBe(
      'ctx-guard: "limit-stop" lifted (the 5-hour usage window reset); Agent, Workflow allowed again. ' +
        '"week-60-early" lifted (the weekly reset is less than 4d away); Agent, Workflow allowed again. Not woken: ctx-guard is paused.',
    )
    expect(liftNotifyText([{ lift: a, why: NOT_WOKEN.spent }, { lift: b, why: NOT_WOKEN.paused }])).toContain('Not woken: "limit-stop": lift.times is spent; "week-60-early": ctx-guard is paused.')
    expect(liftNotifyText([{ lift: a, why: null }])).toBe(liftToastText([a]))
  })

  test('liftReason for limit.any names the window that held, a reset only when that window rolled over', () => {
    const rolled = { pct: 0, resetsAt: null, estimated: true } as const
    expect(liftReason(stop, at({ pct: 40, resetsAt: iso(NOW + H) }, rolled), 'five_hour')).toBe('5-hour usage is below 95%')
    expect(liftReason(stop, at(rolled, { pct: 40, resetsAt: iso(NOW + DAY) }), 'five_hour')).toBe('the 5-hour usage window reset')
    expect(liftReason(stop, at({ pct: 40, resetsAt: iso(NOW + H) }, rolled))).toBe('the weekly usage window reset')
  })

  test('a custom lift.message renders {id}, {tools} and {liftReason} in the note and the prompt', () => {
    const t = brake({ id: 'b', when: { 'limit.any': 95 }, lift: { do: ['note', 'prompt'], times: 1, message: 'Back: {id} freed {tools} ({liftReason}).' } })
    const l = { trigger: t, metrics: rolled, window: null }
    expect(liftNoteText([l], ctx)).toBe('[ctx-guard] Back: b freed Agent, Workflow (the 5-hour usage window reset).')
    expect(wakePromptText(l, ctx)).toBe('Back: b freed Agent, Workflow (the 5-hour usage window reset).')
  })

  test('a trigger note can name {id}, {tools} and {liftsIn}', () => {
    const s = spec({
      triggers: [{ id: 'e', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: ['note', { deny: ['Agent'] }], message: '{id} blocks {tools} for {liftsIn}.' }],
    })
    const m = at(null, { pct: 70, resetsAt: iso(NOW + 4 * DAY + 5 * H) })
    expect(note(s, fires(s, m)[0] as Fire)).toBe('[ctx-guard] e blocks Agent for 5h.')
    expect(TEMPLATE_VARS).toContain('liftsIn')
  })

  test('{liftReason} is a lift text variable: a trigger note or prompt leaves it as written', () => {
    const s = spec({ triggers: [{ id: 'e', when: { 'limit.seven_day': 60 }, do: ['note', { deny: ['Agent'] }], message: '{id}: {liftReason}.' }] })
    const f = fires(s, at(null, { pct: 70, resetsAt: iso(NOW + DAY) }))[0] as Fire
    expect(note(s, f)).toBe('[ctx-guard] e: {liftReason}.')
    expect(promptText(f, ctx)).toBe('e: {liftReason}.')
    expect(TEMPLATE_VARS).not.toContain('liftReason')
  })
})

describe('refusal and subagent texts', () => {
  test('refusal note', () => {
    expect(refusalNote('CTX-READY', 'agents-running', 'two subagents are still running.')).toBe(
      '[ctx-guard] CTX-READY ignored (agents-running): two subagents are still running. Nothing was cleared.',
    )
    expect(refusalNote('CTX-READY', 'already-busy', 'a /compact is under way', 'compact')).toBe(
      '[ctx-guard] CTX-READY ignored (already-busy): a /compact is under way. Nothing was compacted.',
    )
  })

  test('subagent budget texts', () => {
    const b = { type: 'Explore', tokens: 152_000, warn: 120_000, stop: 150_000 }
    expect(subagentDenyReason(b)).toBe('[ctx-guard] context budget 150k reached; return your final report now. Tool calls are refused, except the one that returns your report.')
    expect(subagentStopText(b, null)).toBe(subagentDenyReason(b))
    expect(subagentStopText(b, 'Budget {stop} reached: return your findings now.')).toBe('[ctx-guard] Budget 150k reached: return your findings now.')
    expect(subagentWarnText({ ...b, tokens: 125_000 })).toContain('125k, past this subagent\'s 120k budget')
    expect(subagentWarnText({ ...b, stop: null })).not.toContain('refused')
  })
})

describe('toasts', () => {
  test('context, limit, cost and idle', () => {
    const s = spec({
      triggers: [
        { id: 'c', when: { context: '50%' }, do: ['toast'] },
        { id: 'l', when: { 'limit.five_hour': 80 }, do: ['toast'] },
        { id: 'd', when: { cost: 1 }, do: ['toast'] },
        { id: 'i', when: { idle: '50m' }, do: ['notify'] },
      ],
    })
    const f = fires(s, metrics({ tokens: 520_000, idleMs: 55 * 60_000 }))
    expect(f.map(x => toastText(x.vars, null))).toEqual([
      'ctx-guard: context 520k (52% of 1M)',
      'ctx-guard: 5-hour usage 82% (past 80%), resets in 2h10m',
      'ctx-guard: cost $1.50 (past $1.00)',
      'ctx-guard: idle 55m with context at 520k',
    ])
    expect(toastText((f[0] as Fire).vars, 'lead')).toBe('ctx-guard: lead: context 520k (52% of 1M)')
  })
})

describe('note toasts', () => {
  const ladder = [
    { id: 'soft', when: { context: '43k' }, do: ['note'], level: 'soft' },
    { id: 'hard', when: { context: '50k' }, do: ['note'], level: 'hard' },
    { id: 'stop', when: { context: '55k' }, do: ['note'], level: 'stop' },
  ]
  const toast = (s: RoleSpec, tokens: number, mode?: 'auto' | 'manual' | 'off'): string | null =>
    noteToastText(fires(s, metrics({ tokens })), { role: 'lead', spec: s, readyToken: 'CTX-READY', ...(mode ? { mode } : {}) })

  test('soft, hard and stop on context in auto mode', () => {
    const s = spec({ restart: { mode: 'auto' }, triggers: ladder })
    expect(toast(s, 48_000)).toBe('ctx-guard → model (soft): context 48k past 43k — plan for a handoff; write the handoff, then end with CTX-READY')
    expect(toast(s, 52_000)).toBe('ctx-guard → model (hard): context 52k past 50k — wrap up; write the handoff, then end with CTX-READY')
    expect(toast(s, 56_000)).toBe('ctx-guard → model (stop): context 56k past 55k — stop; write the handoff, then end with CTX-READY')
  })

  test('the ask follows the effective mode: manual tells the operator, off asks for nothing', () => {
    const s = spec({ restart: { mode: 'auto' }, triggers: ladder })
    expect(toast(s, 52_000, 'manual')).toBe("ctx-guard → model (hard): context 52k past 50k — wrap up; write the handoff, then tell you 'ready for /clear'")
    expect(toast(spec({ restart: { mode: 'off' }, triggers: ladder }), 52_000)).toBe('ctx-guard → model (hard): context 52k past 50k — wrap up')
  })

  test('via compact: no handoff, the token compacts', () => {
    const s = spec({ restart: { mode: 'auto', via: 'compact' }, triggers: ladder })
    expect(toast(s, 48_000)).toBe('ctx-guard → model (soft): context 48k past 43k — plan for a compaction; end with CTX-READY to compact')
    expect(toast(s, 52_000, 'manual')).toBe("ctx-guard → model (hard): context 52k past 50k — wrap up; tell you 'ready for /compact'")
  })

  test('a limit note asks for no handoff', () => {
    const s = spec({ restart: { mode: 'auto' }, triggers: [{ id: 'week', when: { 'limit.seven_day': 90 }, do: ['note'], level: 'hard' }] })
    const m = metrics({ limits: { five_hour: null, seven_day: { pct: 91, resetsAt: null } } })
    const text = noteToastText(fires(s, m), { role: 'lead', spec: s, readyToken: 'CTX-READY' })
    expect(text).toBe('ctx-guard → model (hard): weekly usage 91% past 90% — wrap up')
  })

  test('several fires collapse into one toast: the top level, its figure and threshold', () => {
    const s = spec({
      restart: { mode: 'auto' },
      triggers: [
        { id: 'c', when: { context: '300k' }, do: ['note'], level: 'soft' },
        { id: 'l', when: { 'limit.five_hour': 80 }, do: ['note'], level: 'hard' },
        { id: 'd', when: { cost: 1 }, do: ['note'] },
      ],
    })
    const f = fires(s)
    expect(f).toHaveLength(3)
    const text = noteToastText(f, { role: 'lead', spec: s, readyToken: 'CTX-READY' })
    // The note's level wording comes from the hard limit fire; its tail from the context fire.
    expect(text).toBe('ctx-guard → model (hard): 5-hour usage 82% past 80% — wrap up; write the handoff, then end with CTX-READY')
    expect(collapseNotes(f, { role: 'lead', spec: s, readyToken: 'CTX-READY' })).toContain(levelText('hard', 'limit.any'))
  })

  test('cost, idle, no level and a custom message', () => {
    const s = spec({
      restart: { mode: 'auto' },
      triggers: [
        { id: 'd', when: { cost: 1 }, do: ['note'] },
        { id: 'i', when: { idle: '50m' }, do: ['note'], message: 'Back from a break: {tokens} in context; reread the plan.' },
      ],
    })
    const [cost, idle] = fires(s, metrics({ idleMs: 55 * 60_000 }))
    expect(noteToastText([cost as Fire], { role: 'lead', spec: s, readyToken: 'R' })).toBe(
      'ctx-guard → model: session cost $1.50 past $1.00 — keep this in mind as you plan the next steps',
    )
    expect(noteToastText([idle as Fire], { role: 'lead', spec: s, readyToken: 'R' })).toBe(
      'ctx-guard → model: idle 55m past 50m — back from a break: 312k in context; reread the plan',
    )
    expect(noteToastText([], { role: 'lead', spec: s, readyToken: 'R' })).toBeNull()
  })
})

describe('cache texts', () => {
  const vars = (over: Partial<FireVars>): FireVars => ({
    metric: 'cache.miss',
    threshold: { kind: 'tokens', value: 50_000 },
    tokens: 150_000,
    percent: 15,
    window: 1_000_000,
    limit: null,
    cost: null,
    idleMs: 55 * 60_000,
    now: 0,
    expiresIn: 4 * 60_000,
    miss: null,
    missCause: null,
    pings: 0,
    liftsIn: null,
    ...over,
  })
  const ctx = { role: 'main', handoffPath: '.ctx-guard/main-handoff.md', readyToken: 'CTX-READY' }

  test('toasts', () => {
    expect(toastText(vars({ miss: 140_000, missCause: 'model' }), 'main')).toBe('ctx-guard: main: cache miss, 140k re-written (model switch)')
    expect(toastText(vars({ miss: 140_000, missCause: 'prefix' }), 'main')).toBe(
      'ctx-guard: main: cache miss, 140k re-written (prefix changed: CLAUDE.md, tools or MCP?)',
    )
    expect(toastText(vars({ metric: 'cache.expiresIn', threshold: { kind: 'duration', value: 300_000 } }), 'main')).toBe(
      'ctx-guard: main: prompt cache expires in 4m, idle 55m',
    )
    expect(toastText(vars({ metric: 'cache.pings', threshold: { kind: 'count', value: 3 }, pings: 3 }), null)).toBe(
      'ctx-guard: prompt cache kept warm by 3 pings, expires in 4m',
    )
    expect(toastText(vars({ metric: 'cache.pings', threshold: { kind: 'count', value: 1 }, pings: 1 }), null)).toBe(
      'ctx-guard: prompt cache kept warm by 1 ping, expires in 4m',
    )
  })

  test('template variables idle and expiresIn', () => {
    const v = templateVars(vars({}), ctx)
    expect([v.idle, v.expiresIn]).toEqual(['55m', '4m'])
    expect(TEMPLATE_VARS).toContain('idle')
    expect(TEMPLATE_VARS).toContain('expiresIn')
    const unknown = templateVars(vars({ idleMs: null, expiresIn: null }), ctx)
    expect([unknown.idle, unknown.expiresIn]).toEqual(['unknown', 'unknown'])
  })

  test('the prompt text, default and from the trigger message', () => {
    const f = (message: string | null) => ({
      trigger: { id: 'away', message, do: ['prompt'] } as never,
      actions: ['prompt'] as never,
      step: 0,
      vars: vars({ metric: 'cache.expiresIn' }),
    })
    expect(promptText(f(null), ctx)).toBe(
      '[ctx-guard] The user has been away 55m; the prompt cache expires in 4m. Write the handoff to .ctx-guard/main-handoff.md and stop; do not start new work.',
    )
    expect(DEFAULT_PROMPT).toContain('{idle}')
    expect(promptText(f('Away {idle}. Note it in {handoffPath}.'), ctx)).toBe('Away 55m. Note it in .ctx-guard/main-handoff.md.')
  })

  test('own prompt: origin ctx-guard while it submits, no command; the text may have been rewritten', () => {
    const ctxGuard = { kind: 'plugin', name: 'ctx-guard' }
    expect(isOwnPrompt({ origin: ctxGuard }, '[ctx-guard] away')).toBe(true)
    expect(isOwnPrompt({ origin: ctxGuard, text: '[ctx-guard] away, rewritten' } as never, '[ctx-guard] away')).toBe(true)
    expect(isOwnPrompt({ origin: ctxGuard }, null)).toBe(false)
    expect(isOwnPrompt({ origin: ctxGuard, command: { name: 'ctx-guard:resume' } }, '[ctx-guard] away')).toBe(false)
    expect(isOwnPrompt({ origin: { kind: 'plugin', name: 'other' } }, '[ctx-guard] away')).toBe(false)
    expect(isOwnPrompt({ origin: { kind: 'composer' } }, '[ctx-guard] away')).toBe(false)
    expect(isOwnPrompt({}, '[ctx-guard] away')).toBe(false)
  })

  describe('notes for a cache trigger', () => {
    const trigger = (id: string, when: Record<string, unknown>) => {
      const s = spec({ restart: { mode: 'off' }, triggers: [{ id, when, do: ['note'] }] })
      return { s, trigger: s.triggers[0] as never }
    }
    const opts = (s: RoleSpec) => ({ role: 'lead', spec: s, readyToken: 'CTX-READY' })

    test('the note head names the rewrite', () => {
      const { s, trigger: t } = trigger('miss', { 'cache.miss': '50k' })
      const fire = { trigger: t, actions: ['note'] as never, step: 0, vars: vars({ miss: 140_000, missCause: 'prefix' }) }
      expect(collapseNotes([fire], opts(s))).toContain(
        'A request rewrote 140k tokens of a prompt cache that should have been warm (prefix changed: CLAUDE.md, tools or MCP?).',
      )
    })

    test('the note head for an expiring cache', () => {
      const { s, trigger: t } = trigger('soon', { 'cache.expiresIn': '5m' })
      const fire = { trigger: t, actions: ['note'] as never, step: 0, vars: vars({ metric: 'cache.expiresIn', threshold: { kind: 'duration', value: 300_000 } }) }
      expect(collapseNotes([fire], opts(s))).toContain('The prompt cache expires in 4m; the session has been idle for 55m.')
    })

    test('the operator toast words the crossing for each cache metric', () => {
      const miss = trigger('miss', { 'cache.miss': '50k' })
      const missFire = { trigger: miss.trigger, actions: ['note'] as never, step: 0, vars: vars({ miss: 140_000, missCause: 'model' }) }
      expect(noteToastText([missFire], opts(miss.s))).toBe('ctx-guard → model: cache miss 140k (model switch) past 50k — keep this in mind as you plan the next steps')
      const soon = trigger('soon', { 'cache.expiresIn': '5m' })
      const soonFire = { trigger: soon.trigger, actions: ['note'] as never, step: 0, vars: vars({ metric: 'cache.expiresIn', threshold: { kind: 'duration', value: 300_000 } }) }
      expect(noteToastText([soonFire], opts(soon.s))).toBe('ctx-guard → model: prompt cache expires in 4m, within 5m — keep this in mind as you plan the next steps')
      const pings = trigger('kept', { 'cache.pings': 3 })
      const pingsFire = { trigger: pings.trigger, actions: ['note'] as never, step: 0, vars: vars({ metric: 'cache.pings', threshold: { kind: 'count', value: 3 }, pings: 3 }) }
      expect(noteToastText([pingsFire], opts(pings.s))).toBe('ctx-guard → model: prompt cache kept warm by 3 pings, at least 3 — keep this in mind as you plan the next steps')
      const one = trigger('kept', { 'cache.pings': 1 })
      const oneFire = { trigger: one.trigger, actions: ['note'] as never, step: 0, vars: vars({ metric: 'cache.pings', threshold: { kind: 'count', value: 1 }, pings: 1 }) }
      expect(noteToastText([oneFire], opts(one.s))).toBe('ctx-guard → model: prompt cache kept warm by 1 ping, at least 1 — keep this in mind as you plan the next steps')
    })
  })
})
