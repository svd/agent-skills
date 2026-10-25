import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
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
