import { describe, expect, test } from 'claude-code/testing'

import { asLifts, checkTries, earliestReset, emptyLifts, keepsWake, liftsFor, operatorInput, wakeVerdict, wakesOnLift } from './lifts'
import type { WakeFacts, WakeGate } from './lifts'
import { NOT_WOKEN } from './messages'
import type { Hold } from '../types'

describe('stored lifts', () => {
  const hold = { tools: ['Agent'], when: '{}', startedAt: 1, touchedAt: 2, notedAt: null, phase: 'stalled', tries: 3, window: 'five_hour', liftedAt: 4, reason: 'r', ran: true, liftNotedAt: 5, stall: { reports: 2, until: 9 } }

  test('reads back what was written, a /ctx-guard wake\'s hold too', () => {
    const wake = { ...hold, tools: [], manual: { window: 'seven_day', pct: 80, text: 'go', resetsAt: '2026-10-14T00:00:00.000Z' } }
    const v = { role: 'lead', holds: { b: hold, '/ctx-guard wake': wake }, estimatedLift: ['b'], forkAt: 7, attempts: { b: 1 }, pending: { triggerId: 'b', text: 'go', tries: 1, at: 3 }, operatorAt: 6, reports: 4 }
    expect(asLifts(JSON.parse(JSON.stringify(v)))).toEqual(v)
  })

  test('garbage reads as empty, a bad hold or pending is dropped', () => {
    expect(asLifts(null)).toEqual(emptyLifts(null))
    const v = asLifts({ role: 'lead', holds: { a: { tools: 'Agent' }, b: hold, c: { ...hold, phase: 'gone' } }, pending: { triggerId: 3 }, attempts: { a: 'x', b: 2 } })
    expect(Object.keys(v.holds)).toEqual(['b'])
    expect(v.pending).toBeNull()
    expect(v.attempts).toEqual({ b: 2 })
  })

  test('lifts of another role are dropped', () => {
    const v = { ...emptyLifts('lead'), attempts: { b: 1 } }
    expect(liftsFor(v, 'lead')).toBe(v)
    expect(liftsFor(v, 'worker')).toEqual(emptyLifts('worker'))
    expect(liftsFor(null, 'lead')).toEqual(emptyLifts('lead'))
  })
})

describe('waking', () => {
  const hold = (over: Partial<Hold> = {}): Hold => ({ tools: ['Agent'], when: '{}', startedAt: 0, touchedAt: 10, notedAt: null, phase: 'lifting', tries: 0, window: null, liftedAt: 30, reason: null, ran: false, liftNotedAt: null, stall: null, ...over })
  const open: WakeGate = { trusted: true, autoActions: true, paused: false }
  const facts = (over: Partial<WakeFacts> = {}): WakeFacts => ({ lastTurnEndAt: 20, operatorAt: null, gate: open, attempts: 0, times: 2, ...over })

  test('a /ctx-guard wake skips rules 1 and 2, and keeps the gates and times', () => {
    const manual = { window: 'five_hour' as const, pct: 60, text: null, resetsAt: null }
    expect(wakeVerdict(hold({ manual, touchedAt: 10 }), facts({ lastTurnEndAt: null, operatorAt: 50 }))).toEqual({ kind: 'wake' })
    expect(wakeVerdict(hold({ manual }), facts({ gate: { ...open, paused: true } }))).toEqual({ kind: 'not-woken', why: NOT_WOKEN.paused })
    expect(wakeVerdict(hold({ manual }), facts({ attempts: 1, times: 1 }))).toEqual({ kind: 'not-woken', why: NOT_WOKEN.spent })
  })

  test('rule 1: not touched, or no main turn ended after the touch', () => {
    expect(wakeVerdict(hold({ touchedAt: null }), facts())).toEqual({ kind: 'untouched' })
    expect(wakeVerdict(hold(), facts({ lastTurnEndAt: 5 }))).toEqual({ kind: 'untouched' })
    expect(wakeVerdict(hold(), facts({ lastTurnEndAt: null }))).toEqual({ kind: 'untouched' })
  })

  test('rule 2: operator input after the last touch; input before it ("go on" → refused) still wakes', () => {
    expect(wakeVerdict(hold(), facts({ operatorAt: 15 }))).toEqual({ kind: 'steering' })
    expect(wakeVerdict(hold(), facts({ operatorAt: 5 }))).toEqual({ kind: 'wake' })
  })

  test('rule 3: the gates, each with its reason', () => {
    expect(wakeVerdict(hold(), facts({ gate: { ...open, trusted: false } }))).toEqual({ kind: 'not-woken', why: NOT_WOKEN.untrusted })
    expect(wakeVerdict(hold(), facts({ gate: { ...open, autoActions: false } }))).toEqual({ kind: 'not-woken', why: NOT_WOKEN.autoActions })
    expect(wakeVerdict(hold(), facts({ gate: { ...open, paused: true } }))).toEqual({ kind: 'not-woken', why: NOT_WOKEN.paused })
  })

  test('rule 4: lift.times spent, unless this attempt is already charged', () => {
    expect(wakeVerdict(hold(), facts({ attempts: 2 }))).toEqual({ kind: 'not-woken', why: NOT_WOKEN.spent })
    expect(wakeVerdict(hold({ tries: 1 }), facts({ attempts: 2 }))).toEqual({ kind: 'wake' })
  })

  test('checkTries: the tries of the lifting holds the check covers, none other', () => {
    const holds = { a: hold({ tries: 1 }), b: hold({ tries: 3 }), c: hold({ phase: 'waiting', tries: 3 }) }
    expect(checkTries(holds, new Set(['a', 'c']))).toBe(1)
    expect(checkTries(holds, new Set(['a', 'b']))).toBe(3)
    expect(checkTries(holds, new Set(['gone']))).toBe(0)
  })

  test('operator input: the operator origins, never /ctx-guard', () => {
    for (const o of ['composer', 'bridge', 'sdk', 'peer', 'coordinator', 'channel', 'slack-ping']) expect(operatorInput(o, null)).toBe(true)
    for (const o of ['plugin', 'peer-send-message', 'task-notification', 'scheduled-trigger', 'auto-continuation', 'observer', 'observer-activity', 'projects-relay', 'unclassified']) {
      expect(operatorInput(o, null)).toBe(false)
    }
    expect(operatorInput('composer', 'ctx-guard')).toBe(false)
    expect(operatorInput('composer', 'ctx-guard:resume')).toBe(true)
    expect(operatorInput('composer', 'clear')).toBe(true)
    expect(operatorInput(undefined, null)).toBe(false)
  })

  test('keepsWake: input the person did not type, and their /clear and /compact', () => {
    for (const command of [null, 'review', 'clear']) expect(keepsWake(command, false)).toBe(true)
    for (const command of ['clear', 'compact']) expect(keepsWake(command, true)).toBe(true)
    for (const command of [null, 'review', 'ctx-guard:resume']) expect(keepsWake(command, true)).toBe(false)
  })

  test('wakesOnLift: prompt in lift.do, gates open, times left', () => {
    const t = (lift: unknown) => ({ id: 'b', lift }) as never
    expect(wakesOnLift(t({ do: ['note', 'prompt'], times: 2, message: null }), open, 1)).toBe(true)
    expect(wakesOnLift(t({ do: ['note', 'prompt'], times: 2, message: null }), open, 2)).toBe(false)
    expect(wakesOnLift(t({ do: ['note'], times: null, message: null }), open, 0)).toBe(false)
    expect(wakesOnLift(t({ do: ['prompt'], times: 2, message: null }), { ...open, paused: true }, 0)).toBe(false)
  })

  test('earliestReset: the soonest known reset', () => {
    const m = (five: string | null, week: string | null) =>
      ({ limits: { five_hour: five === null ? null : { pct: 1, resetsAt: five }, seven_day: week === null ? null : { pct: 1, resetsAt: week } } }) as never
    expect(earliestReset(m('2026-10-13T12:00:00Z', '2026-10-15T00:00:00Z'))).toBe(Date.parse('2026-10-13T12:00:00Z'))
    expect(earliestReset(m(null, null))).toBeNull()
  })

  test('earliestReset: a rolled-over window resets again one window length after it rolled over', () => {
    const rolled = (at: string) => ({ pct: 0, resetsAt: null, estimated: true, rolledAt: at })
    const five = { limits: { five_hour: rolled('2026-10-13T12:00:00Z'), seven_day: { pct: 1, resetsAt: '2026-10-15T00:00:00Z' } } } as never
    expect(earliestReset(five)).toBe(Date.parse('2026-10-13T17:00:00Z'))
    const both = { limits: { five_hour: rolled('2026-10-13T12:00:00Z'), seven_day: rolled('2026-10-13T11:00:00Z') } } as never
    expect(earliestReset(both)).toBe(Date.parse('2026-10-13T17:00:00Z'))
  })
})
