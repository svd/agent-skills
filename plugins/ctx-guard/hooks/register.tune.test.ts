import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  NOW,
  ROOT,
  STATE,
  LEAD_SOFT,
  RESUME,
  newWorld,
  world,
  writeConfig,
  start,
  measure,
  step,
  notes,
  stepBottom,
  turn,
  armed,
  ready,
  restartWorld,
  compactBottom,
  compactSession,
  ctxGuard,
} from './register.fixtures'
import type { CompactAnswer, World } from './register.fixtures'

// ---- the ledger -------------------------------------------------------------------

const LEDGER = `${STATE}/ledger`

const DAY = '2026-10-13'

const partPath = (sid: string, part = 1): string => `${LEDGER}/${DAY}-${sid}${part > 1 ? `-${part}` : ''}.jsonl`

type Rec = { k: string } & Record<string, unknown>

// The records of one part, or [] when the file is absent.
const records = (w: World, sid: string, part = 1): Rec[] =>
  (w.files[partPath(sid, part)]?.text ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Rec)

const kinds = (w: World, sid: string, part = 1): string[] => records(w, sid, part).map(r => r.k)

const ledgerFiles = (w: World): string[] => Object.keys(w.files).filter(p => p.startsWith(`${LEDGER}/`))

const OFF = { ...LEAD_SOFT, ledger: { enabled: false } }

// A lead with a config file on disk, its steps filling to `fill.tokens`.
async function lead($: Engine, on: On, w: World, config: unknown = LEAD_SOFT, fill = { tokens: 120_000, model: 'm' }): Promise<{ clock: MockClock }> {
  stepBottom(on, () => fill.tokens, () => fill.model)
  writeConfig(w, config)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  return { clock }
}

async function turnEnd($: Engine, clock: MockClock): Promise<void> {
  await turn($, 'end')
  await clock.settle()
}

test('a main step and the turn end write the day and session part: start, then the request', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  await turnEnd($, clock)
  expect(ledgerFiles(w)).toEqual([partPath('s1')])
  const [first, req] = records(w, 's1')
  expect(first).toMatchObject({ k: 'start', role: 'lead' })
  expect(typeof first?.window).toBe('number')
  expect(req).toMatchObject({ k: 'req', role: 'lead', ctx: 120_000, cr: 119_990, cw: 0, out: 50, model: 'm' })
})

test("a subagent's step makes no record", async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock, 'sub-1')
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start'])
})

test('with no config file on disk nothing is written', async ($, on) => {
  const w = newWorld()
  stepBottom(on, () => 120_000)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock)
  await turnEnd($, clock)
  expect(ledgerFiles(w)).toEqual([])
})

test('ledger.enabled false: nothing written, the folder never listed, no rm', async ($, on) => {
  const w = newWorld()
  w.files[`${LEDGER}/2026-01-01-old.jsonl`] = { text: '{}\n', mtimeMs: 0 }
  const { clock } = await lead($, on, w, OFF)
  await step($, clock)
  await turnEnd($, clock)
  expect(ledgerFiles(w)).toEqual([`${LEDGER}/2026-01-01-old.jsonl`])
  expect(w.listed.filter(p => p.startsWith(LEDGER))).toEqual([])
  expect(w.processes).toEqual([])
})

test('a reload turning the ledger off lands what it holds once, then writes nothing', async ($, on) => {
  const w = newWorld()
  let writes = 0
  w.onWrite = p => {
    if (p.startsWith(`${LEDGER}/`)) writes += 1
  }
  const { clock } = await lead($, on, w)
  await step($, clock)
  await clock.advance(1000)
  writeConfig(w, OFF)
  await measure($, w, 120_000)
  await clock.settle()
  expect(kinds(w, 's1')).toEqual(['start', 'req'])
  expect(writes).toBe(1)
  await step($, clock)
  await turnEnd($, clock)
  expect(writes).toBe(1)
  expect(kinds(w, 's1')).toEqual(['start', 'req'])
  // Nothing was kept while off: switched back on, the new part holds only what came after.
  writeConfig(w, LEAD_SOFT)
  await measure($, w, 120_000)
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req'])
  expect(kinds(w, 's1', 2)).toEqual(['start'])
})

test('a reload turning the ledger off and on while its last flush writes: the new ledger takes the next part', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  w.writeHang = { path: /\/ledger\//, ms: 1000 }
  // Each measure's evaluation waits behind the hanging flush; its config reload does not.
  writeConfig(w, OFF)
  const off = measure($, w, 120_000)
  await clock.settle()
  writeConfig(w, LEAD_SOFT)
  const switchedOn = measure($, w, 120_000)
  await clock.settle()
  await clock.advance(5000)
  await Promise.all([off, switchedOn])
  w.writeHang = null
  await step($, clock)
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req'])
  expect(kinds(w, 's1', 2)).toEqual(['start', 'req'])
})

test('a record made while a flush writes is kept for the next flush', async ($, on) => {
  compactBottom(on, () => ({ tokensBefore: 500_000, tokensAfter: 40_000 }))
  const w = newWorld()
  const { clock } = await lead($, on, w)
  w.writeHang = { path: /\/ledger\//, ms: 1000 }
  await turnEnd($, clock)
  await compactSession($, 'auto')
  await clock.advance(1000)
  expect(kinds(w, 's1')).toEqual(['start'])
  w.writeHang = null
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'compact'])
})

test('a second session start lands what the first one held', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  await start($)
  await clock.settle()
  expect(kinds(w, 's1')).toEqual(['start', 'req'])
})

test("a second session start lands the first one's records under its id, though the flush runs after the id changed", async ($, on) => {
  const w = newWorld()
  stepBottom(on, () => 120_000, () => 'm')
  writeConfig(w, OFF)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  await start($)
  // The turn end's transcript read holds the chain; what follows waits behind it.
  w.readHang['/home/u/.claude/projects/-repo/s1.jsonl'] = 1000
  await turnEnd($, clock)
  // The ledger starts on this reload, before any flush has read the session id.
  writeConfig(w, LEAD_SOFT)
  const busy = measure($, w, 120_000)
  await clock.settle()
  const second = start($)
  await clock.settle()
  w.sessionId = 's2'
  await clock.advance(5000)
  await Promise.all([busy, second])
  await clock.settle()
  expect(kinds(w, 's1')).toEqual(['start'])
  expect(kinds(w, 's2')).toEqual([])
})

test('a stateDir changed mid-session: the live ledger keeps listing and landing in the folder it started with', async ($, on) => {
  const w = newWorld()
  const other = `${ROOT}/.other/ledger/${DAY}-s1-2.jsonl`
  w.files[other] = { text: '{"k":"x"}\n', mtimeMs: 0 }
  const { clock } = await lead($, on, w)
  await step($, clock)
  await turnEnd($, clock)
  writeConfig(w, { ...LEAD_SOFT, stateDir: '.other' })
  await measure($, w, 120_000)
  await clock.settle()
  await step($, clock)
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req', 'req'])
  expect(w.files[other]?.text).toBe('{"k":"x"}\n')
})

test('a failed write keeps the records; the next turn end writes them', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  w.failWrites = /\/ledger\//
  await step($, clock)
  await turnEnd($, clock)
  expect(ledgerFiles(w)).toEqual([])
  w.failWrites = null
  await step($, clock)
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req', 'req'])
})

test('while writes keep failing the buffer holds the newest 1000 records', { timeoutMs: 60_000 }, async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  w.failWrites = /\/ledger\//
  for (let i = 0; i < 1005; i++) {
    const s = $.turn.step({ turnId: 't1', index: i, model: 'm', messageCount: 3 })
    for await (const _ of s) {
      // drain
    }
    await s.result
    if (i % 100 === 99) await clock.settle()
  }
  await turnEnd($, clock)
  expect(ledgerFiles(w)).toEqual([])
  w.failWrites = null
  await turnEnd($, clock)
  const all = kinds(w, 's1')
  expect(all.length).toBe(1000)
  expect(all.every(k => k === 'req')).toBe(true)
})

test("/clear lands a clear by the operator in the old session's part; later records go to the new one", async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  w.sessionId = 's2'
  expect(kinds(w, 's1')).toEqual(['start', 'req', 'clear'])
  expect(records(w, 's1')[2]).toMatchObject({ k: 'clear', role: 'lead', by: 'operator' })
  await step($, clock)
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req', 'clear'])
  expect(kinds(w, 's2')).toEqual(['start', 'req'])
})

test("a failed flush at /clear: the old session's records land in its own part later", async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  w.failWrites = /-s1\.jsonl$/
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  w.failWrites = null
  w.sessionId = 's2'
  await step($, clock)
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req', 'clear'])
  expect(kinds(w, 's2')).toEqual(['start', 'req'])
})

test('a ready-token restart records the ready, then a clear by ctx-guard', async ($, on) => {
  const w = restartWorld({ hang: { clear: 1000, 'ctx-guard:resume': 1000 } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual(['clear'])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  w.sessionId = 's2'
  await clock.advance(2000)
  expect(w.ran).toEqual(['clear', RESUME])
  const old = records(w, 's1')
  const at = old.findIndex(r => r.k === 'ready')
  expect(at).toBeGreaterThan(0)
  expect(old[at]).toMatchObject({ k: 'ready', role: 'lead' })
  expect(old.at(-1)).toMatchObject({ k: 'clear', role: 'lead', by: 'ctx-guard' })
})

test('a context note records its trigger and the threshold in tokens', async ($, on) => {
  const w = newWorld()
  stepBottom(on, () => 310_000)
  writeConfig(w, LEAD_SOFT)
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  await clock.settle()
  expect(notes(session).length).toBe(1)
  await turnEnd($, clock)
  const note = records(w, 's1').filter(r => r.k === 'note')
  expect(note.length).toBe(1)
  expect(note[0]).toMatchObject({ k: 'note', role: 'lead', id: 'soft', ctx: 310_000, threshold: 300_000 })
})

test('main auto and manual compacts are recorded with before and after; precompute, subagent and skip are not', async ($, on) => {
  let answer: CompactAnswer = { tokensBefore: 500_000, tokensAfter: 40_000 }
  compactBottom(on, () => answer)
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await compactSession($, 'auto')
  answer = { tokensBefore: 300_000, tokensAfter: 30_000 }
  await compactSession($, 'manual')
  await compactSession($, 'precompute')
  await compactSession($, 'auto', 'sub-1')
  answer = { skip: 'nothing to compact' }
  await compactSession($, 'manual')
  await turnEnd($, clock)
  const compacts = records(w, 's1').filter(r => r.k === 'compact')
  expect(compacts).toEqual([
    expect.objectContaining({ trigger: 'auto', pre: 500_000, post: 40_000, role: 'lead' }),
    expect.objectContaining({ trigger: 'manual', pre: 300_000, post: 30_000, role: 'lead' }),
  ])
})

test('the session start deletes only expired parts, with one rm -f -- and no shell', async ($, on) => {
  const w = newWorld()
  const old = [`${LEDGER}/2026-08-01-a.jsonl`, `${LEDGER}/2026-09-01-b-2.jsonl`]
  for (const p of [...old, `${LEDGER}/${DAY}-c.jsonl`, `${LEDGER}/2026-10-12-d.jsonl`, `${LEDGER}/2026-01-01-notes.txt`]) w.files[p] = { text: '{}\n', mtimeMs: 0 }
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(w.processes).toEqual([['rm', '-f', '--', ...old]])
  expect(w.inits[0]).toMatchObject({ cwd: ROOT, timeoutMs: 10_000 })
})

test('no rm when no part has expired', async ($, on) => {
  const w = newWorld()
  w.files[`${LEDGER}/2026-10-12-d.jsonl`] = { text: '{}\n', mtimeMs: 0 }
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(w.processes).toEqual([])
})

test('the session end lands what the ledger holds', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  expect(ledgerFiles(w)).toEqual([])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} as never })
  expect(kinds(w, 's1')).toEqual(['start', 'req'])
})

test('a part that would pass 256 KiB continues in -2', async ($, on) => {
  const w = newWorld()
  const fill = { tokens: 120_000, model: 'm' }
  const { clock } = await lead($, on, w, LEAD_SOFT, fill)
  for (const m of ['a', 'b', 'c']) {
    fill.model = m.repeat(100_000)
    await step($, clock)
  }
  await turnEnd($, clock)
  expect(kinds(w, 's1')).toEqual(['start', 'req', 'req'])
  expect(kinds(w, 's1', 2)).toEqual(['req'])
  for (const p of ledgerFiles(w)) expect(new TextEncoder().encode(w.files[p]?.text ?? '').length).toBeLessThanOrEqual(256 * 1024)
})

// ---- the reach check --------------------------------------------------------------

const HOUR = 60 * 60_000

const seedPath = (role: string | null, i: number, t: number): string => `${LEDGER}/${new Date(t).toISOString().slice(0, 10)}-seed_${role ?? 'none'}_${i}.jsonl`

// One landed part per session, `daysAgo` days before NOW: a start, two requests up to its peak, then `extra`.
function seed(w: World, peaks: number[], { role = 'lead' as string | null, daysAgo = 1, extra = (_t: number): Rec[] => [] } = {}): string[] {
  return peaks.map((peak, i) => {
    const t = NOW - daysAgo * 24 * HOUR - i * HOUR
    const req = (dt: number, ctx: number): Rec => ({ t: t + dt, k: 'req', role, ctx, cw: 0, cr: ctx, out: 10, model: 'm', miss: 0, gap: null })
    const recs: Rec[] = [{ t, k: 'start', role, window: 1_000_000 }, req(1, peak / 2), req(2, peak), ...extra(t + 3)]
    const path = seedPath(role, i, t)
    w.files[path] = { text: recs.map(r => JSON.stringify(r)).join('\n') + '\n', mtimeMs: 0 }
    return path
  })
}

const UNDER = [100_000, 150_000, 200_000, 220_000, 250_000]

const UNREACHED = 'ctx-guard: context triggers for lead never fired in 14 days; sessions peaked at 250k (p90), the lowest is 300k. /ctx-guard tune'

test('reach: 5 lead sessions peaking under the lowest context trigger toast unreached once; check lists the finding', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(w.toasts.filter(t => t.includes('never fired'))).toEqual([UNREACHED])
  const out = await ctxGuard($, 'check')
  expect(out).toContain('reach (last 14 days, from the ledger):\n  lead: 5 sessions, 10 requests; peak per session median 200k, p90 250k, max 250k')
  expect(out).toContain('    finding: unreached: the lowest context trigger, soft at 300k, is above the p90 peak (250k) and no context note fired')
  expect(w.toasts.filter(t => t.includes('never fired'))).toHaveLength(1)
})

test('reach: auto compacts at 203k and 298k give the engine-compacted toast', async ($, on) => {
  const w = newWorld()
  const pres = [203_000, 298_000]
  seed(w, UNDER, { extra: t => { const pre = pres.shift(); return pre === undefined ? [] : [{ t, k: 'compact', role: 'lead', trigger: 'auto', pre, post: 20_000 }] } })
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(w.toasts.filter(t => t.startsWith('ctx-guard: context triggers'))).toEqual([
    'ctx-guard: context triggers for lead never fired in 14 days; engine compacted at 203k–298k. /ctx-guard tune',
  ])
})

test('reach: a second start in the same engine does not toast the same finding again', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  const { clock } = await lead($, on, w)
  await clock.settle()
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} as never })
  await start($)
  await clock.settle()
  expect(w.toasts.filter(t => t.includes('never fired'))).toEqual([UNREACHED])
})

test('reach: 4 sessions say not enough data and toast nothing', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER.slice(0, 4))
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(w.toasts.filter(t => t.includes('/ctx-guard tune'))).toEqual([])
  expect(await ctxGuard($, 'check')).toContain('    not enough data (4 sessions; a finding needs 5)')
})

test('reach: ledger off prints off and never lists the folder; no config file prints no ledger', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  const { clock } = await lead($, on, w, OFF)
  await clock.settle()
  expect(await ctxGuard($, 'check')).toContain('\nreach: off (ledger.enabled is false)')
  expect(w.listed.filter(p => p.startsWith(LEDGER))).toEqual([])
  expect(w.toasts.filter(t => t.includes('/ctx-guard tune'))).toEqual([])
})

test('reach: with no config file check prints no ledger', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  stepBottom(on, () => 120_000)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'check')).toContain('\nreach: no ledger (no ctx-guard config file in this repo)')
  expect(w.toasts.filter(t => t.includes('/ctx-guard tune'))).toEqual([])
})

test('reach: records still in the buffer count in check, and once after the turn end lands them', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  expect(ledgerFiles(w)).toEqual([])
  expect(await ctxGuard($, 'check')).toContain('  lead: 1 session, 1 request;')
  await turnEnd($, clock)
  expect(ledgerFiles(w)).toEqual([partPath('s1')])
  expect(await ctxGuard($, 'check')).toContain('  lead: 1 session, 1 request;')
})

test('reach: a session with no role still prints the section, with none', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER, { role: null })
  writeConfig(w, LEAD_SOFT)
  const { clock } = world(on, w)
  await start($)
  await clock.settle()
  const out = await ctxGuard($, 'check')
  expect(out).toContain('ctx-guard check: no role, so no restart to check\nreach (last 14 days, from the ledger):\n  none: 5 sessions, 10 requests;')
})

test('reach: the report shows its line right after the cache line', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  const { clock } = await lead($, on, w)
  await clock.settle()
  const lines = (await ctxGuard($, '')).split('\n')
  const at = lines.findIndex(l => l.startsWith('cache:'))
  expect(at).toBeGreaterThan(-1)
  expect(lines[at + 1]).toBe('reach (14 days): lead unreached')
})

test('reach: parts older than 14 days are not read', async ($, on) => {
  const w = newWorld()
  const old = seed(w, UNDER, { daysAgo: 20 })
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(await ctxGuard($, 'check')).toContain('\nreach: no sessions recorded in the last 14 days')
  for (const p of old) expect(w.reads[p]).toBeUndefined()
  expect(w.toasts.filter(t => t.includes('/ctx-guard tune'))).toEqual([])
})

test('reach: a failed read of the reach memory toasts nothing and stores nothing', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  stepBottom(on, () => 120_000, () => 'm')
  writeConfig(w, LEAD_SOFT)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' }, { store: false })
  // A store whose reads of the reach memory fail.
  const kept = new Map<string, unknown>()
  const sets: string[] = []
  on('store.get', ($, e) => {
    if (e.key.startsWith('reach:')) throw new Error('store down')
    return { value: kept.get(e.key) }
  })
  on('store.set', ($, e) => {
    sets.push(e.key)
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    kept.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  await start($)
  await clock.settle()
  expect(w.toasts.filter(t => t.includes('/ctx-guard tune'))).toEqual([])
  expect(sets.filter(k => k.startsWith('reach:'))).toEqual([])
})

test('reach: a ledger started on a reload counts its buffer and its landed part as one session', async ($, on) => {
  const w = newWorld()
  stepBottom(on, () => 120_000, () => 'm')
  writeConfig(w, OFF)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  // A part this session landed before the ledger went off.
  const req: Rec = { t: NOW - HOUR, k: 'req', role: 'lead', ctx: 90_000, cw: 0, cr: 90_000, out: 10, model: 'm', miss: 0, gap: null }
  w.files[partPath('s1')] = { text: JSON.stringify(req) + '\n', mtimeMs: 0 }
  // The ledger starts on this reload, before any flush has read the session id.
  writeConfig(w, LEAD_SOFT)
  await measure($, w, 120_000)
  await clock.settle()
  await step($, clock)
  expect(await ctxGuard($, 'check')).toContain('  lead: 1 session, 2 requests;')
})

test('reach: ledger.days 7 keeps 7 days, and the check, report and toast say 7 days', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  const { clock } = await lead($, on, w, { ...LEAD_SOFT, ledger: { days: 7 } })
  await clock.settle()
  expect(w.toasts.filter(t => t.includes('/ctx-guard tune'))).toEqual([UNREACHED.replace('in 14 days', 'in 7 days')])
  expect(await ctxGuard($, 'check')).toContain('\nreach (last 7 days, from the ledger):\n  lead: 5 sessions')
  expect((await ctxGuard($, '')).split('\n')).toContain('reach (7 days): lead unreached')
})

test('reach: the report reads the ledger again once ledger.days changes the window', async ($, on) => {
  const w = newWorld()
  seed(w, UNDER)
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect((await ctxGuard($, '')).split('\n')).toContain('reach (14 days): lead unreached')
  writeConfig(w, { ...LEAD_SOFT, ledger: { days: 7 } })
  await measure($, w, 120_000)
  await clock.settle()
  expect((await ctxGuard($, '')).split('\n')).toContain('reach (7 days): lead unreached')
})

// ---- tune -------------------------------------------------------------------------

const LOCAL = `${ROOT}/.claude/ctx-guard.local.json`

// `n` landed sessions of `reqs` requests each, a day before NOW, context climbing 4k a request from 20k.
function seedTune(w: World, n: number, reqs = 150, { role = 'lead' as string | null, model = 'm' } = {}): void {
  for (let i = 0; i < n; i++) {
    const t = NOW - 24 * HOUR - i * HOUR
    const recs: Rec[] = [{ t, k: 'start', role, window: 1_000_000 }]
    for (let j = 1; j <= reqs; j++) {
      const ctx = 20_000 + j * 4_000
      recs.push({ t: t + j, k: 'req', role, ctx, cw: 4_000, cr: ctx - 4_000, out: 10, model, miss: 0, gap: null })
    }
    w.files[seedPath(role, i, t)] = { text: recs.map(r => JSON.stringify(r)).join('\n') + '\n', mtimeMs: 0 }
  }
}

const localJson = (w: World): Record<string, unknown> => JSON.parse(w.files[LOCAL]?.text ?? 'null') as Record<string, unknown>

const TUNED = [
  'tune (last 30 days, from the ledger):',
  '  lead: 10 sessions, 1,500 requests, 2026-10-12 → 2026-10-13',
  '    inputs: restart start 65k (fallback, 0 samples), restart write 32k (fallback, 0 samples), handoff out 3k (fallback, 0 samples), overshoot 25k (fallback, 0 samples)',
  '    weights: other Claude models, cache TTL unknown; window 1M, ceiling 1M',
  '    current: soft 300k',
  '    B        clears  cost vs none',
  '    100k     90      39%',
].join('\n')

const RECOMMEND = [
  '    current  20      58%',
  '    none     0       100%',
  '    recommend: boundary 125k, 33% below current',
  '      soft 125k, hard 175k, stop 225k every 25k',
  '      /ctx-guard tune apply lead writes it to the local config file',
].join('\n')

const PINNED = 'The whole trigger list of lead is now pinned in .claude/ctx-guard.local.json'
const TRUST_AGAIN = 'run /ctx-guard trust to approve it again'

test('tune: data, inputs marked fallback, the current ladder, the table and a recommendation; nothing written', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const { clock } = await lead($, on, w)
  await clock.settle()
  const files = Object.keys(w.files).sort()
  const out = await ctxGuard($, 'tune')
  expect(out.startsWith(TUNED)).toBe(true)
  expect(out.endsWith(RECOMMEND)).toBe(true)
  expect(out).not.toContain('$')
  expect(Object.keys(w.files).sort()).toEqual(files)
})

test('tune <role> shows that role only; a role in neither the config nor the ledger is named', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  seedTune(w, 2, 10, { role: null })
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(await ctxGuard($, 'tune')).toContain('\n  none: 2 sessions, 20 requests')
  const one = await ctxGuard($, 'tune lead')
  expect(one.startsWith(TUNED)).toBe(true)
  expect(one).not.toContain('none: 2 sessions')
  expect(await ctxGuard($, 'tune ghost')).toBe('[ctx-guard] no role "ghost" in the config or the ledger.')
})

test('tune: 9 sessions say not enough data with no table, and apply has nothing to apply', async ($, on) => {
  const w = newWorld()
  seedTune(w, 9)
  const { clock } = await lead($, on, w)
  await clock.settle()
  const out = await ctxGuard($, 'tune')
  expect(out).toContain('    not enough data (a recommendation needs 10 sessions and 1,500 requests)')
  expect(out).not.toContain('clears  cost vs none')
  expect(await ctxGuard($, 'tune apply')).toBe('[ctx-guard] tune apply: nothing to apply for lead (/ctx-guard tune lead shows why); nothing changed.')
  expect(w.files[LOCAL]).toBeUndefined()
})

test('tune and tune apply are the operator\'s: from the model both are refused and nothing is written', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(await ctxGuard($, 'tune', 'plugin')).toContain('only the operator can run /ctx-guard tune;')
  expect(await ctxGuard($, 'tune apply', 'plugin')).toContain('only the operator can run /ctx-guard tune apply;')
  expect(w.files[LOCAL]).toBeUndefined()
})

test('tune apply with no local file writes roles.lead.triggers there and reloads; tune then shows the new soft', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const { clock } = await lead($, on, w)
  await clock.settle()
  const out = await ctxGuard($, 'tune apply')
  expect(out).toContain('[ctx-guard] tune apply: wrote roles.lead.triggers to .claude/ctx-guard.local.json:\n  soft: 300k → 125k\n')
  expect(out).toContain(PINNED)
  expect(out).not.toContain(TRUST_AGAIN)
  expect(localJson(w)).toEqual({ roles: { lead: { triggers: [{ id: 'soft', when: { context: '125k' }, do: ['note'], level: 'soft' }] } } })
  expect(w.files[LOCAL]?.text.endsWith('}\n')).toBe(true)
  expect(await ctxGuard($, 'tune')).toContain('\n    current: soft 125k\n')
})

test('tune apply keeps the other keys of an existing local file', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  writeConfig(w, { ledger: { days: 30 }, roles: { other: {} } }, LOCAL)
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(await ctxGuard($, 'tune apply lead')).toContain('soft: 300k → 125k')
  expect(localJson(w)).toEqual({
    ledger: { days: 30 },
    roles: { other: {}, lead: { triggers: [{ id: 'soft', when: { context: '125k' }, do: ['note'], level: 'soft' }] } },
  })
})

test('tune apply refuses four context-only triggers and names them; nothing written', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const rung = (id: string, context: string) => ({ id, when: { context }, do: ['note'] })
  const config = { version: 1, roles: { lead: { triggers: [rung('c1', '300k'), rung('c2', '350k'), rung('c3', '400k'), rung('c4', '450k')] } } }
  const { clock } = await lead($, on, w, config)
  await clock.settle()
  expect(await ctxGuard($, 'tune apply')).toBe('[ctx-guard] tune apply: more than three context-only triggers (c1, c2, c3, c4); nothing changed.')
  expect(w.files[LOCAL]).toBeUndefined()
})

test('tune apply refuses invalid local JSON, a local roles.lead null, and config errors; the files stay', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const { clock } = await lead($, on, w)
  await clock.settle()
  writeConfig(w, '{ "roles": ', LOCAL)
  expect(await ctxGuard($, 'tune apply')).toBe('[ctx-guard] tune apply: .claude/ctx-guard.local.json is not valid JSON; nothing changed.')
  expect(w.files[LOCAL]?.text).toBe('{ "roles": ')
  writeConfig(w, { roles: { lead: null } }, LOCAL)
  expect(await ctxGuard($, 'tune apply')).toBe(
    '[ctx-guard] tune apply: .claude/ctx-guard.local.json removes the role lead (roles.lead is null); nothing changed.',
  )
  writeConfig(w, { enabled: 'yes' }, LOCAL)
  expect(await ctxGuard($, 'tune apply')).toBe('[ctx-guard] tune apply: the config has errors (/ctx-guard lists them); nothing changed.')
  expect(localJson(w)).toEqual({ enabled: 'yes' })
})

test('tune apply with no role refuses: there is no role to write', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10, 150, { role: null })
  writeConfig(w, LEAD_SOFT)
  const { clock } = world(on, w)
  await start($)
  await clock.settle()
  expect(await ctxGuard($, 'tune apply')).toBe('[ctx-guard] tune apply: no role to write; give one, or set a role with /ctx-guard role; nothing changed.')
  expect(await ctxGuard($, 'tune apply none')).toContain('no role to write')
  expect(w.files[LOCAL]).toBeUndefined()
})

test('tune apply on a trusted lead says trust is needed again only when a trusted setting changed', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const stop = { id: 'stop', when: { context: '400k' }, do: ['note', { deny: ['Agent'] }], level: 'stop', lift: { do: ['prompt'], times: 1 } }
  const config = { version: 1, roles: { lead: { triggers: [...LEAD_SOFT.roles.lead.triggers, stop] } } }
  const { clock } = await lead($, on, w, config)
  await clock.settle()
  expect(await ctxGuard($, 'trust')).toContain('approved for /repo')
  const out = await ctxGuard($, 'tune apply')
  expect(out).toContain('  soft: 300k → 125k\n  stop: 400k → 175k\n')
  expect(out).toContain(TRUST_AGAIN)

})

test('tune apply on a trusted lead with no trusted setting in its ladder needs no trust again', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const { clock } = await lead($, on, w)
  await clock.settle()
  expect(await ctxGuard($, 'trust')).toContain('approved for /repo')
  const out = await ctxGuard($, 'tune apply')
  expect(out).toContain('soft: 300k → 125k')
  expect(out).not.toContain(TRUST_AGAIN)
})

test('tune: ledger off prints off', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  const { clock } = await lead($, on, w, OFF)
  await clock.settle()
  expect(await ctxGuard($, 'tune')).toBe('tune: off (ledger.enabled is false)')
})

test('tune: with no config file prints no ledger', async ($, on) => {
  const w = newWorld()
  seedTune(w, 10)
  stepBottom(on, () => 120_000)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'tune')).toBe('tune: no ledger (no ctx-guard config file in this repo)')
})

test('tune: records still in the buffer count', async ($, on) => {
  const w = newWorld()
  const { clock } = await lead($, on, w)
  await step($, clock)
  expect(ledgerFiles(w)).toEqual([])
  expect(await ctxGuard($, 'tune')).toContain('  lead: 1 session, 1 request,')
})
