import { describe, expect, test } from 'claude-code/testing'

import { bandOf, bandSegments, bandText, sameBand, untrustedText } from './band'
import { metricsOf } from './triggers'
import type { Band } from '../types'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 60 * 60 * 1000
const at = (ms: number): string => new Date(NOW + ms).toISOString()

const base: Band = { role: null, tokens: null, percent: null, window: null, limits: [], probes: [], subagentsOver: 0, denies: [], restartFailed: null, untrusted: null, now: NOW }

describe('band text', () => {
  test('the full line', () => {
    const b: Band = {
      ...base,
      role: 'lead',
      tokens: 312_000,
      percent: 31.2,
      window: 1_000_000,
      limits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: at(2 * HOUR + 10 * 60 * 1000) },
        { kind: 'seven_day', percentUsed: 61, resetsAt: at(76 * HOUR) },
      ],
      subagentsOver: 1,
      denies: ['Agent'],
    }
    expect(bandText(b)).toBe('lead · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h) · sub 1! · deny Agent')
  })

  test('unknown figures are left out; nothing known is no segment at all', () => {
    expect(bandSegments(base)).toEqual([])
    expect(bandText({ ...base, limits: [{ kind: 'five_hour', percentUsed: 7.5, resetsAt: null }] })).toBe('5h 7.5%')
  })

  test('a failed restart shows its text', () => {
    expect(bandText({ ...base, role: 'lead', restartFailed: 'restart failed — type /ctx-guard:resume' })).toBe(
      'lead · restart failed — type /ctx-guard:resume',
    )
  })

  test('colours by level', () => {
    const color = (b: Band, text: string): string | undefined => bandSegments(b).find(s => s.text.startsWith(text))?.color
    expect(color({ ...base, tokens: 400_000, percent: 40 }, '400k')).toBe('green')
    expect(color({ ...base, tokens: 600_000, percent: 60 }, '600k')).toBe('warning')
    expect(color({ ...base, tokens: 800_000, percent: 80 }, '800k')).toBe('error')
    // A fill with no window to measure against has no level to colour by.
    expect(color({ ...base, tokens: 400_000 }, '400k')).toBeUndefined()
    expect(color({ ...base, limits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: null }] }, '5h')).toBe('green')
    expect(color({ ...base, limits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: null }] }, '5h')).toBe('warning')
    expect(color({ ...base, limits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: null }] }, '5h')).toBe('error')
    expect(color({ ...base, denies: ['Agent'] }, 'deny')).toBe('error')
  })
})

describe('bandOf', () => {
  test('from a reading, keeping the subagent count and restart failure', () => {
    const m = metricsOf({ tokens: 250_000, rateLimits: [{ kind: 'seven_day', percentUsed: 61, resetsAt: at(HOUR) }] }, 500_000, null, NOW)
    const prev: Band = { ...base, subagentsOver: 2, restartFailed: 'x', untrusted: 'untrusted' }
    const b = bandOf('lead', m, [{ tool: 'Agent', triggerId: 'a' }, { tool: 'Agent', triggerId: 'b' }], prev)
    expect(b).toEqual({
      role: 'lead',
      tokens: 250_000,
      percent: 50,
      window: 500_000,
      limits: [{ kind: 'seven_day', percentUsed: 61, resetsAt: at(HOUR) }],
      probes: [],
      subagentsOver: 2,
      denies: ['Agent'],
      restartFailed: 'x',
      untrusted: 'untrusted',
      now: NOW,
    })
  })
})

describe('untrusted segment', () => {
  const record = { hash: 'h', fields: {}, at: NOW }
  test('only where trust is wanted and missing; changed once an approval no longer matches', () => {
    expect(untrustedText(null, true)).toBeNull()
    expect(untrustedText({ trusted: false, changed: ['lead.restart'], record: null }, false)).toBeNull()
    expect(untrustedText({ trusted: true, changed: [], record }, true)).toBeNull()
    expect(untrustedText({ trusted: false, changed: ['lead.restart'], record: null }, true)).toBe('untrusted')
    expect(untrustedText({ trusted: false, changed: ['lead.restart'], record }, true)).toBe('untrusted (changed)')
  })

  test('after the probes, before sub and deny, in warning colour', () => {
    const b: Band = { ...base, role: 'lead', probes: [{ id: 'run', text: 'step 03', color: null }], untrusted: 'untrusted', subagentsOver: 1, denies: ['Agent'] }
    expect(bandText(b)).toBe('lead · step 03 · untrusted · sub 1! · deny Agent')
    expect(bandSegments(b).find(s => s.text === 'untrusted')?.color).toBe('warning')
  })

  test('a band stored before the field existed draws without it', () => {
    const old = { ...base, role: 'lead' } as Record<string, unknown>
    delete old.untrusted
    expect(bandText(old as unknown as Band)).toBe('lead')
  })
})

describe('sameBand', () => {
  test('ignores the read time only', () => {
    expect(sameBand(base, { ...base, now: NOW + 1 })).toBe(true)
    expect(sameBand(base, { ...base, tokens: 1 })).toBe(false)
    expect(sameBand(null, null)).toBe(true)
    expect(sameBand(base, null)).toBe(false)
  })
})

describe('probe segments', () => {
  test('after the usage windows, before sub, deny and a failed restart', () => {
    const b: Band = {
      ...base,
      role: 'lead',
      limits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: null }],
      probes: [
        { id: 'run', text: 'step 03 sonnet 12m', color: 'warning' },
        { id: 'git', text: 'main', color: null },
      ],
      subagentsOver: 1,
      denies: ['Agent'],
      restartFailed: 'restart failed — type /ctx-guard:resume',
    }
    expect(bandText(b)).toBe('lead · 5h 42% · step 03 sonnet 12m · main · sub 1! · deny Agent · restart failed — type /ctx-guard:resume')
    expect(bandSegments(b).find(s => s.text === 'step 03 sonnet 12m')?.color).toBe('warning')
    expect(bandSegments(b).find(s => s.text === 'main')?.color).toBeUndefined()
  })

  test('a band stored before probes existed still draws', () => {
    const old = { ...base, role: 'lead' } as Record<string, unknown>
    delete old.probes
    expect(bandText(old as unknown as Band)).toBe('lead')
  })

  test('bandOf keeps the last probes', () => {
    const m = metricsOf({ tokens: 1000 }, 1_000_000, null, NOW)
    const prev: Band = { ...base, probes: [{ id: 'run', text: 'x', color: null }] }
    expect(bandOf('lead', m, [], prev).probes).toEqual(prev.probes)
    expect(bandOf('lead', m, [], null).probes).toEqual([])
  })
})
