import { describe, expect, test } from 'claude-code/testing'

import { roleSpec, validate, zeroConfigTriggers } from './config'
import type { LedgerRecord } from './ledger'
import {
  FINDING_MEMORY_MS,
  asReachMemory,
  contextLadder,
  groupSessions,
  newFindings,
  reach,
  reachKey,
  reachToast,
  windowParts,
} from './tune'
import type { ReachInput, RoleReach, SessionRecords } from './tune'
import type { Config, Trigger } from '../types'

// 2026-10-25T12:00:00Z
const NOW = Date.UTC(2026, 9, 25, 12)
const DAY = 24 * 60 * 60_000
const M = 60_000
const SID = '0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b'

function trigs(...raw: unknown[]): Trigger[] {
  const r = validate({ version: 1, roles: { lead: { triggers: raw } } })
  expect(r.errors).toEqual([])
  return roleSpec(r.config as Config, 'lead')?.triggers ?? []
}

// lead: lowest context trigger at 400k.
const LEAD = trigs(
  { id: 'ctx-soft', when: { context: 400_000 }, do: ['note'], level: 'soft' },
  { id: 'ctx-hard', when: { context: 600_000 }, do: ['note'], level: 'hard' },
)

const req = (t: number, ctx: number, role: string | null = 'lead'): LedgerRecord => ({ t, k: 'req', role, ctx, cw: 0, cr: ctx, out: 10, model: 'm', miss: 0, gap: null })
const compact = (t: number, trigger: 'auto' | 'manual' | 'ctx-guard', pre: number | null, role: string | null = 'lead'): LedgerRecord => ({
  t,
  k: 'compact',
  role,
  trigger,
  pre,
  post: 20_000,
})
const note = (t: number, level: 'soft' | 'hard' | 'stop' | null, role: string | null = 'lead', id = 'ctx-soft'): LedgerRecord => ({ t, k: 'note', role, id, level, ctx: 1, threshold: 1 })

// One session per peak, each a request at its peak an hour before NOW (minus i minutes).
function sessions(peaks: number[], role: string | null = 'lead'): SessionRecords[] {
  return peaks.map((p, i) => ({ sessionId: `s${role ?? 'none'}${i}`, records: [req(NOW - 60 * M - i * M, p / 2, role), req(NOW - 59 * M - i * M, p, role)] }))
}

function run(s: SessionRecords[], over: Partial<ReachInput> = {}): RoleReach[] {
  return reach({ sessions: s, now: NOW, triggers: r => (r === 'lead' ? LEAD : r === 'none' ? zeroConfigTriggers() : null), window: 1_000_000, ...over })
}

const one = (s: SessionRecords[], over: Partial<ReachInput> = {}): RoleReach => run(s, over)[0] as RoleReach

describe('context ladder', () => {
  test('context-only triggers without an auto action, lowest first; percent resolves on the window', () => {
    const t = trigs(
      { id: 'b', when: { context: '50%' }, do: ['toast'] },
      { id: 'a', when: { context: 500_000 }, do: ['note', { deny: ['Agent'] }] },
      { id: 'step', when: { context: 300_000, every: 50_000 }, do: ['note'] },
      { id: 'and', when: { context: 100_000, 'limit.any': 50 }, do: ['note'] },
      { id: 'cmp', when: { context: 100_000 }, do: ['compact'] },
      { id: 'pr', when: { context: 100_000 }, do: ['note', 'prompt'], times: 1 },
      { id: 'lim', when: { 'limit.any': 80 }, do: ['note'] },
    )
    // The config takes a ping only with cache.expiresIn; a context-only one still stays off the ladder.
    const cmp = t.find(x => x.id === 'cmp') as Trigger
    t.push({ ...cmp, id: 'pg', do: ['ping'] })
    expect(contextLadder(t, 1_000_000)).toEqual([
      { id: 'step', tokens: 300_000 },
      { id: 'a', tokens: 500_000 },
      { id: 'b', tokens: 500_000 },
    ])
    expect(contextLadder(t, 200_000)[0]).toEqual({ id: 'b', tokens: 100_000 })
  })
})

describe('window parts and sessions', () => {
  test('parts of the last 14 days per session, by day then part; other names ignored', () => {
    const names = [
      `2026-10-11-${SID}.jsonl`,
      `2026-10-10-${SID}.jsonl`,
      `2026-10-24-${SID}-2.jsonl`,
      `2026-10-24-${SID}.jsonl`,
      `2026-10-25-${SID}.jsonl`,
      '2026-10-25-other.jsonl',
      'notes.txt',
      '2026-10-25-x.json',
    ]
    expect(windowParts(names, NOW)).toEqual([
      { sessionId: SID, parts: [`2026-10-11-${SID}.jsonl`, `2026-10-24-${SID}.jsonl`, `2026-10-24-${SID}-2.jsonl`, `2026-10-25-${SID}.jsonl`] },
      { sessionId: 'other', parts: ['2026-10-25-other.jsonl'] },
    ])
  })

  test('parts of a session join, the buffer merges into its session, current stays apart, bad lines skipped', () => {
    const line = (r: LedgerRecord): string => JSON.stringify(r)
    const g = groupSessions(
      [
        { sessionId: SID, text: `${line(req(NOW - DAY, 1))}\nnot json\n{"t":1}\n` },
        { sessionId: SID, text: `${line(req(NOW, 2))}\n` },
      ],
      [
        { sessionId: SID, records: [req(NOW + 1, 3)] },
        { sessionId: 'current', records: [req(NOW + 2, 4)] },
      ],
    )
    expect(g.map(s => [s.sessionId, s.records.map(r => (r.k === 'req' ? r.ctx : -1))])).toEqual([
      [SID, [1, 2, 3]],
      ['current', [4]],
    ])
  })
})

describe('reach stats', () => {
  test('sessions, requests and peak per session: median (odd, even), p90 nearest rank, max', () => {
    const odd = one(sessions([100_000, 300_000, 200_000, 500_000, 400_000]))
    expect(odd).toMatchObject({ role: 'lead', sessions: 5, requests: 10, peak: { median: 300_000, p90: 500_000, max: 500_000 } })
    const ten = one(sessions([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => n * 10_000)))
    expect(ten.peak).toEqual({ median: 55_000, p90: 90_000, max: 100_000 })
  })

  test('records older than 14 days or after now are left out', () => {
    const s = [{ sessionId: 'a', records: [req(NOW - 14 * DAY - 1, 900_000), req(NOW + 1, 800_000), req(NOW - 14 * DAY, 100_000)] }]
    expect(one(s)).toMatchObject({ sessions: 1, requests: 1, peak: { max: 100_000 } })
    expect(run([{ sessionId: 'a', records: [req(NOW - 20 * DAY, 1)] }])).toEqual([])
  })

  test('notes by level, clears by ready token or operator, compacts by trigger, the auto pre range', () => {
    const s = sessions([100_000])
    s[0]?.records.push(
      note(NOW - M, 'soft'),
      note(NOW - M, 'stop'),
      note(NOW - M, null),
      { t: NOW - M, k: 'clear', role: 'lead', by: 'ctx-guard' },
      { t: NOW - M, k: 'clear', role: 'lead', by: 'operator' },
      { t: NOW - M, k: 'clear', role: 'lead', by: 'operator' },
      compact(NOW - M, 'auto', 298_000),
      compact(NOW - M, 'auto', 203_000),
      compact(NOW - M, 'auto', null),
      compact(NOW - M, 'manual', 100_000),
      compact(NOW - M, 'ctx-guard', 90_000),
    )
    expect(one(s)).toMatchObject({
      notes: { soft: 1, hard: 0, stop: 1, other: 1 },
      clears: { ready: 1, operator: 2 },
      compacts: { auto: 3, manual: 1, 'ctx-guard': 1 },
      autoPre: { min: 203_000, max: 298_000 },
      below: { min: 203_000, max: 298_000 },
    })
  })

  test('role null counts as none, on the zero-config ladder (500k on a 1M window), listed last', () => {
    const r = run([...sessions([100_000], null), ...sessions([100_000], 'dev'), ...sessions([100_000])])
    expect(r.map(x => x.role)).toEqual(['dev', 'lead', 'none'])
    expect(r[2]?.lowest).toEqual({ id: 'ctx-50', tokens: 500_000 })
  })

  test('a session that changed role counts under each', () => {
    const r = run([{ sessionId: 'a', records: [req(NOW - 2 * M, 50_000, null), req(NOW - M, 70_000)] }])
    expect(r.map(x => [x.role, x.sessions, x.peak?.max])).toEqual([
      ['lead', 1, 70_000],
      ['none', 1, 50_000],
    ])
  })

  test('a role with no request in the period is left out', () => {
    const start: LedgerRecord = { t: NOW - M, k: 'start', role: null, window: 1_000_000 }
    expect(run([{ sessionId: 'a', records: [start] }, ...sessions([90_000])]).map(x => x.role)).toEqual(['lead'])
  })
})

describe('reach findings', () => {
  const low = [100_000, 150_000, 200_000, 250_000, 300_000]

  test('under 5 sessions: not enough data, no finding; 5 give a finding', () => {
    expect(one(sessions(low.slice(0, 4)))).toMatchObject({ verdict: 'few', findings: [], sessions: 4 })
    expect(one(sessions(low))).toMatchObject({ verdict: 'findings', findings: ['unreached'] })
  })

  test('unreached: the lowest above the p90 peak and no note; a note or a peak at the lowest gives none', () => {
    const noted = sessions(low)
    noted[0]?.records.push(note(NOW - M, 'soft'))
    expect(one(noted)).toMatchObject({ verdict: 'ok', findings: [] })
    expect(one(sessions([...low.slice(0, 4), 400_000]))).toMatchObject({ verdict: 'ok', findings: [] })
    expect(one(sessions([...low.slice(0, 4), 399_999])).findings).toEqual(['unreached'])
  })

  test('unreached: a note of a trigger off the ladder (ANDed, level-less) is no context note', () => {
    const triggers = (): Trigger[] => [...LEAD, ...trigs({ id: 'ctx-and', when: { context: 100_000, 'limit.any': 50 }, do: ['note'], level: 'soft' }, { id: 'lim', when: { 'limit.any': 80 }, do: ['note'] })]
    const s = sessions(low)
    s[0]?.records.push(note(NOW - M, 'soft', 'lead', 'ctx-and'), note(NOW - M, null, 'lead', 'lim'))
    expect(one(s, { triggers })).toMatchObject({ verdict: 'findings', findings: ['unreached'], notes: { soft: 1, other: 1 } })
    s[1]?.records.push(note(NOW - M, 'hard', 'lead', 'ctx-hard'))
    expect(one(s, { triggers })).toMatchObject({ verdict: 'ok', findings: [] })
  })

  test('pre-empted: an auto compact below the lowest; manual, ctx-guard or a null pre gives none', () => {
    const reached = [...low.slice(0, 4), 450_000]
    const auto = sessions(reached)
    auto[0]?.records.push(compact(NOW - M, 'auto', 380_000), compact(NOW - M, 'auto', 420_000))
    expect(one(auto)).toMatchObject({ verdict: 'findings', findings: ['pre-empted'], below: { min: 380_000, max: 380_000 }, autoPre: { min: 380_000, max: 420_000 } })
    const other = sessions(reached)
    other[0]?.records.push(compact(NOW - M, 'manual', 100_000), compact(NOW - M, 'ctx-guard', 100_000), compact(NOW - M, 'auto', null))
    expect(one(other)).toMatchObject({ verdict: 'ok', findings: [], below: null })
  })

  test('a percent threshold uses the role\'s latest start window, else the input window', () => {
    const pct = trigs({ id: 'half', when: { context: '50%' }, do: ['note'] })
    const s = sessions(low)
    const triggers = (): Trigger[] => pct
    expect(one(s, { triggers }).lowest).toEqual({ id: 'half', tokens: 500_000 })
    s[0]?.records.push({ t: NOW - 3 * DAY, k: 'start', role: 'lead', window: 400_000 }, { t: NOW - DAY, k: 'start', role: 'lead', window: 200_000 })
    s[1]?.records.push({ t: NOW - 2 * DAY, k: 'start', role: 'lead', window: 800_000 })
    expect(one(s, { triggers })).toMatchObject({ lowest: { tokens: 100_000 }, verdict: 'ok' })
  })

  test('a role not in the config, or with no context trigger: no finding', () => {
    expect(one(sessions(low, 'gone'))).toMatchObject({ verdict: 'unconfigured', lowest: null, findings: [], sessions: 5 })
    const lim = trigs({ id: 'lim', when: { 'limit.any': 80 }, do: ['note'] })
    expect(one(sessions(low), { triggers: () => lim })).toMatchObject({ verdict: 'no-ladder', lowest: null, findings: [] })
  })
})

describe('reach memory and toasts', () => {
  const unreached = one(sessions([100_000, 150_000, 200_000, 250_000, 300_000]))
  const both: RoleReach = { ...unreached, findings: ['unreached', 'pre-empted'], autoPre: { min: 203_000, max: 298_000 }, below: { min: 203_000, max: 298_000 } }

  test('a new finding toasts; one shown 6 days ago does not, 8 days ago does again; stale entries pruned', () => {
    const first = newFindings([unreached], { shown: {} }, NOW)
    expect(first.toasts.length).toBe(1)
    expect(first.next).toEqual({ shown: { 'lead:unreached': NOW } })
    expect(newFindings([unreached], { shown: { 'lead:unreached': NOW - 6 * DAY } }, NOW)).toEqual({ toasts: [], next: { shown: { 'lead:unreached': NOW - 6 * DAY } } })
    const again = newFindings([unreached], { shown: { 'lead:unreached': NOW - 8 * DAY, 'dev:unreached': NOW - FINDING_MEMORY_MS } }, NOW)
    expect(again).toEqual({ toasts: [reachToast(unreached, 'unreached')], next: { shown: { 'lead:unreached': NOW } } })
  })

  test('two new findings of one role give a toast each', () => {
    const r = newFindings([both], { shown: {} }, NOW)
    expect(r.toasts).toEqual([reachToast(both, 'unreached'), reachToast(both, 'pre-empted')])
    expect(r.toasts[1]).toContain('the engine compacted lead at 203k–298k')
    expect(Object.keys(r.next.shown).sort()).toEqual(['lead:pre-empted', 'lead:unreached'])
  })

  test('unreached shown 6 days ago, pre-empted new: the toast is pre-empted\'s own text', () => {
    const r = newFindings([both], { shown: { 'lead:unreached': NOW - 6 * DAY } }, NOW)
    expect(r.toasts).toEqual(['ctx-guard: the engine compacted lead at 203k–298k, below its lowest context trigger (400k). /ctx-guard tune'])
    expect(r.next.shown).toEqual({ 'lead:unreached': NOW - 6 * DAY, 'lead:pre-empted': NOW })
  })

  test('the toast names the days it covers', () => {
    expect(newFindings([unreached], { shown: {} }, NOW, 7).toasts).toEqual(['ctx-guard: context triggers for lead never fired in 7 days; sessions peaked at 300k (p90), the lowest is 400k. /ctx-guard tune'])
  })

  test('the toast texts', () => {
    expect(reachToast({ ...both, role: 'main' }, 'unreached')).toBe('ctx-guard: context triggers for main never fired in 14 days; engine compacted at 203k–298k. /ctx-guard tune')
    expect(reachToast(unreached, 'unreached')).toBe('ctx-guard: context triggers for lead never fired in 14 days; sessions peaked at 300k (p90), the lowest is 400k. /ctx-guard tune')
    expect(reachToast({ ...both, findings: ['pre-empted'], below: { min: 203_000, max: 203_000 } }, 'pre-empted')).toBe(
      'ctx-guard: the engine compacted lead at 203k, below its lowest context trigger (400k). /ctx-guard tune',
    )
    expect(reachToast({ ...unreached, role: 'none' }, 'unreached')).toContain('for none never fired')
  })

  test('the memory reads junk as empty; the key drops trailing slashes', () => {
    expect(asReachMemory(null)).toEqual({ shown: {} })
    expect(asReachMemory({ shown: [1] })).toEqual({ shown: {} })
    expect(asReachMemory({ shown: { a: 1, b: 'x', c: Number.NaN } })).toEqual({ shown: { a: 1 } })
    expect(reachKey('/repo//')).toBe('reach:/repo')
    expect(reachKey('/repo')).toBe('reach:/repo')
  })
})

describe('reach size', () => {
  test('30 days, 2 roles, 4 sessions a day, 100 requests each', () => {
    const s: SessionRecords[] = []
    for (let d = 0; d < 30; d++) {
      for (const role of ['lead', 'dev']) {
        for (let k = 0; k < 4; k++) {
          const records: LedgerRecord[] = []
          for (let n = 0; n < 100; n++) records.push(req(NOW - d * DAY - (k * 100 + n) * 1000 - 1, 1000 * (n + 1), role))
          s.push({ sessionId: `${role}-${d}-${k}`, records })
        }
      }
    }
    const r = run(s, { triggers: () => LEAD })
    // Days 0-13 count, 4 sessions each; day 14's records all fall just before the 14-day cut.
    expect(r.map(x => [x.role, x.sessions, x.requests, x.peak?.max])).toEqual([
      ['dev', 56, 5600, 100_000],
      ['lead', 56, 5600, 100_000],
    ])
  })
})
