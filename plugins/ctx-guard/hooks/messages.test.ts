import { describe, expect, test } from 'claude-code/testing'

import { roleSpec, validate } from './config'
import {
  collapseNotes,
  denyReason,
  effectiveMode,
  handoffPathFor,
  humanDuration,
  humanPercent,
  humanTokens,
  humanUsd,
  levelText,
  noteText,
  refusalNote,
  render,
  restartTail,
  subagentDenyReason,
  subagentStopText,
  subagentWarnText,
  templateVars,
  toastText,
} from './messages'
import { evaluate } from './triggers'
import type { Fire, Metrics } from './triggers'
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
  test('all nine, humanized', () => {
    const s = spec({ triggers: [{ id: '5h', when: { 'limit.five_hour': 80 }, do: ['note'] }] })
    const f = fires(s)[0] as Fire
    expect(templateVars(f.vars, { role: 'lead', handoffPath: '.ctx-guard/lead-handoff.md', readyToken: 'CTX-READY' })).toEqual({
      role: 'lead',
      tokens: '312k',
      percent: '31%',
      threshold: '80%',
      window: '1M',
      limit: '5-hour 82%',
      resetsIn: '2h10m',
      handoffPath: '.ctx-guard/lead-handoff.md',
      readyToken: 'CTX-READY',
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

describe('restart tail', () => {
  const instructions = 'Rewrite whole. Sections: Goal, State, Next action'
  const base = (restart: unknown, handoff: unknown = { instructions }) =>
    spec({ restart, handoff, triggers: [{ id: 's', when: { context: '1k' }, do: ['note'], level: 'soft' }] })

  test('auto: rewrite the handoff, then the ready token', () => {
    const s = base({ mode: 'auto' })
    expect(restartTail(s, handoffPathFor(s, 'lead'), 'CTX-READY')).toBe(
      'At the next safe point — no subagents running, current work recorded — rewrite `.ctx-guard/lead-handoff.md`: ' +
        'Rewrite whole. Sections: Goal, State, Next action. Then end your reply with a line holding only `CTX-READY`.',
    )
  })

  test('manual: tell the operator', () => {
    const s = base({ mode: 'manual' })
    const tail = restartTail(s, 'h.md', 'CTX-READY')
    expect(tail).toEndWith("Then tell the operator 'ready for /clear'.")
    expect(tail).not.toContain('CTX-READY')
  })

  test('off: no tail', () => {
    const s = base({ mode: 'off' })
    expect(restartTail(s, 'h.md', 'CTX-READY')).toBe('')
    expect(note(s, fires(s)[0] as Fire)).not.toContain('safe point')
  })

  test('style session-handoff names the skill, not the path', () => {
    const s = base({ mode: 'auto' }, { style: 'session-handoff', instructions })
    const tail = restartTail(s, handoffPathFor(s, 'lead'), 'CTX-READY')
    expect(tail).toContain('write a handoff with the session-handoff skill: Rewrite whole.')
    expect(tail).not.toContain('lead-handoff.md')
    expect(tail).toEndWith('`CTX-READY`.')
  })

  test('no instructions: a bare rewrite', () => {
    const s = base({ mode: 'auto' }, {})
    expect(restartTail(s, 'h.md', 'GO')).toBe(
      'At the next safe point — no subagents running, current work recorded — rewrite `h.md`. Then end your reply with a line holding only `GO`.',
    )
  })

  test('via compact needs no handoff', () => {
    expect(restartTail(base({ mode: 'auto', via: 'compact' }), 'h.md', 'GO')).toBe(
      'At the next safe point — no subagents running, current work recorded — end your reply with a line holding only `GO`.',
    )
    expect(restartTail(base({ mode: 'manual', via: 'compact' }), 'h.md', 'GO')).toEndWith("tell the operator 'ready for /compact'.")
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

  test('a caller handoff path overrides the configured one', () => {
    const s = base({ mode: 'auto' })
    const f = fires(s)[0] as Fire
    const text = noteText({ trigger: f.trigger, vars: f.vars, role: 'lead', spec: s, readyToken: 'R', handoffPath: '.claude/session-handoffs/x/1.md' })
    expect(text).toContain('`.claude/session-handoffs/x/1.md`')
    expect(text).not.toContain('lead-handoff.md')
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
    expect(subagentDenyReason(b)).toBe('[ctx-guard] context budget 150k reached; return your final report now.')
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
