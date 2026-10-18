import { describe, expect, test } from 'claude-code/testing'

import { asLifts, emptyLifts, liftsFor } from './lifts'

describe('stored lifts', () => {
  const hold = { tools: ['Agent'], when: '{}', startedAt: 1, touchedAt: 2, notedAt: null, phase: 'stalled', tries: 3, window: 'five_hour', liftedAt: 4, ran: true, liftNotedAt: 5, stall: { reports: 2, until: 9 } }

  test('reads back what was written', () => {
    const v = { role: 'lead', holds: { b: hold }, estimatedLift: ['b'], forkAt: 7, attempts: { b: 1 }, pending: { triggerId: 'b', text: 'go', tries: 1, at: 3, checked: true }, operatorAt: 6, reports: 4 }
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
