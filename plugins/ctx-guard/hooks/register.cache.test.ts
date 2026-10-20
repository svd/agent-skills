import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  NOW,
  HOUR,
  PRESET_TEXT,
  newWorld,
  world,
  writeConfig,
  start,
  measure,
  step,
  ctxGuard,
  turn,
  MIN,
  mainTurnEnd,
  usageBottom,
  CACHE_ROLE,
  bandOfWorld,
  missToasts,
  CTX_GUARD,
  KEEP_WARM_TRIGGERS,
  WARM_READ,
  trustedKeepWarm,
  ownPrompts,
  compacts,
} from './register.fixtures'
import type {
  World,
} from './register.fixtures'

// ---- the prompt cache ---------------------------------------------------------

// Where the transcript of session `s1` in ROOT lies for HOME=/home/u.
const TRANSCRIPT = '/home/u/.claude/projects/-repo/s1.jsonl'

const HOUR_ROW = '{"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":25528,"ephemeral_5m_input_tokens":0}}}}\n'

const MISS_TOAST = 'ctx-guard: lead: cache miss, 140k re-written (prefix changed: CLAUDE.md, tools or MCP?)'

test('the band counts down the prompt cache once idle', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.advance(40 * 60 * 1000)
  expect(bandOfWorld(w)).not.toContain('cache')
  await clock.advance(11 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
  await clock.advance(10 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache cold')
})

test('a long step anchors the cache when it opens, not when its answer arrives', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  // The answer streams for 3m.
  on('turn.step', async function* ($, e) {
    await clock.sleep(3 * 60 * 1000)
    const usage = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 50, model: 'm' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as never, usage }
  })
  await start($, 'vscode')
  await turn($, 'start')
  const stepped = step($, clock)
  await clock.settle()
  await clock.advance(3 * 60 * 1000)
  await stepped
  await turn($, 'end')
  // Opened at 0 and answered at 3m: at 51m the 1h cache has 9m left, less the margin, as when the answer is at once.
  await clock.advance(48 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
})

test('a rewrite of a warm cache fires a cache.miss toast; the first request after a /clear does not', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [
    { read: 50_000, write: 100_000 },
    { read: 150_000, write: 0 },
    { read: 10_000, write: 140_000 },
    { read: 150_000, write: 0 },
    // At least half the old fill: only the /clear tells this rewrite from a miss.
    { read: 0, write: 100_000 },
  ])
  await start($)
  await step($, clock)
  await step($, clock)
  expect(missToasts(w)).toEqual([])
  await step($, clock)
  expect(missToasts(w)).toEqual([MISS_TOAST])
  // A warm request re-arms the trigger, so a miss after the /clear would toast again.
  await step($, clock)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await step($, clock)
  expect(missToasts(w)).toEqual([MISS_TOAST])
})

test('the first request after a compact is no cache miss', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  // The last request fills at least half the old fill: only the measure tells it from a miss.
  usageBottom(on, [{ read: 50_000, write: 100_000 }, { read: 150_000, write: 0 }, { read: 0, write: 100_000 }])
  await start($)
  await step($, clock)
  await step($, clock)
  // The context started over, as a measure reports it after /compact.
  await measure($, w, undefined)
  await step($, clock)
  expect(missToasts(w)).toEqual([])
})

test('a reload keeps the idle period: a trigger that used up its times stays held', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [
    { read: 50_000, write: 100_000 },
    { read: 150_000, write: 0 },
    { read: 10_000, write: 140_000 },
    { read: 150_000, write: 0 },
    { read: 10_000, write: 140_000 },
  ])
  await start($)
  await step($, clock)
  await step($, clock)
  await step($, clock)
  await step($, clock)
  expect(missToasts(w)).toEqual([MISS_TOAST])
  // A hot reload fires session.start again; the miss that cleared stays cleared.
  await start($)
  await clock.settle()
  expect(missToasts(w)).toEqual([MISS_TOAST])
  await step($, clock)
  expect(missToasts(w)).toEqual([MISS_TOAST])
})

test('a miss that cleared stays cleared across a reload', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 50_000, write: 100_000 }, { read: 150_000, write: 0 }, { read: 10_000, write: 140_000 }, { read: 150_000, write: 0 }])
  await start($)
  await turn($, 'start')
  for (let i = 0; i < 3; i++) await step($, clock)
  // The turn end writes the cache, miss and all.
  await turn($, 'end')
  expect(missToasts(w)).toEqual([MISS_TOAST])
  await turn($, 'start')
  await step($, clock)
  // The warm request re-armed the trigger; a reload mid-turn must not read the old miss back.
  await start($)
  await clock.settle()
  expect(missToasts(w)).toEqual([MISS_TOAST])
})

test('the ttl comes from the transcript at the session\'s own path after a turn', async ($, on) => {
  const w = newWorld({ limits: [] })
  writeConfig(w, CACHE_ROLE([], {}))
  w.files[TRANSCRIPT] = { text: HOUR_ROW, mtimeMs: NOW }
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await turn($, 'start')
  await step($, clock)
  // The engine stamps an empty transcript_path where it has none.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await turn($, 'end')
  await clock.settle()
  // No rate limits would guess five minutes; the transcript says one hour, so 51 min idle is still warm.
  await clock.advance(51 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
  expect(bandOfWorld(w)).not.toContain('~')
})

test('a transcript with no cache write yet is read again after the next turn', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([], {}))
  w.files[TRANSCRIPT] = { text: '{"message":{"usage":{"input_tokens":3}}}\n', mtimeMs: NOW }
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.settle()
  w.files[TRANSCRIPT] = { text: `${w.files[TRANSCRIPT]?.text ?? ''}${HOUR_ROW}`, mtimeMs: NOW }
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.settle()
  await clock.advance(51 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
})

test('without HOME the ttl comes from the transcript the Stop hook names', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([], {}))
  const path = '/elsewhere/s1.jsonl'
  w.files[path] = { text: HOUR_ROW, mtimeMs: NOW }
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await turn($, 'start')
  await step($, clock)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], transcript_path: path })
  await turn($, 'end')
  await clock.settle()
  await clock.advance(51 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
})

async function mainTurn($: Engine, clock: MockClock): Promise<void> {
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.settle()
}

test('a session start keeps a stored cache only when it is this session\'s', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await mainTurn($, clock)
  // A hot reload of the same session keeps the anchor.
  await start($, 'vscode')
  await clock.advance(51 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
  // $.state still holding another session's cache: its anchor is not this session's.
  w.sessionId = 's2'
  await start($, 'vscode')
  expect(bandOfWorld(w)).not.toContain('cache')
})

test('a refused transcript read is not tried again until /clear', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([], {}))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($)
  // No such file: the read is refused.
  await mainTurn($, clock)
  expect((w.reads[TRANSCRIPT] ?? 0)).toBe(1)
  await mainTurn($, clock)
  expect((w.reads[TRANSCRIPT] ?? 0)).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await mainTurn($, clock)
  expect((w.reads[TRANSCRIPT] ?? 0)).toBe(2)
})

test('a transcript past 1 MiB with no cache write is not read again', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([], {}))
  w.files[TRANSCRIPT] = { text: `${'{"message":{"usage":{"input_tokens":3}}}\n'.repeat(30_000)}`, mtimeMs: NOW }
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($)
  await mainTurn($, clock)
  await mainTurn($, clock)
  expect((w.reads[TRANSCRIPT] ?? 0)).toBe(1)
})

test('a transcript read that a /clear overtakes leaves the new session free to read', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([], {}))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($)
  w.readHang[TRANSCRIPT] = 1000
  // The read is under way, and will be refused, when the /clear comes.
  await mainTurn($, clock)
  expect((w.reads[TRANSCRIPT] ?? 0)).toBe(1)
  const cleared = $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.advance(1000)
  await cleared
  w.readHang[TRANSCRIPT] = 0
  await mainTurn($, clock)
  expect((w.reads[TRANSCRIPT] ?? 0)).toBe(2)
})

test('a main step reads no usage for the cache once a reading is known', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($)
  await step($, clock)
  const before = w.usageCalls
  await step($, clock)
  await step($, clock)
  expect(w.usageCalls).toBe(before)
})

// ---- idle periods ---------------------------------------------------------------

test('the operator\'s turn starts a new idle period: times counts start over', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'idle', when: { idle: '5m' }, do: ['notify'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(2)
  expect(w.prompts).toEqual(['hi'])
})

test('the turn of ctx-guard\'s resume command starts a new idle period', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'idle', when: { idle: '5m' }, do: ['notify'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  // The prompt ctx-guard's $.command.run of its resume command raises.
  const line = '/ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md'
  await $.prompt.submit({ text: line, origin: CTX_GUARD, command: { name: 'ctx-guard:resume', args: 'role=lead handoff=.ctx-guard/lead-handoff.md' } } as never)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(2)
})

test('a prompt under ctx-guard\'s name that ctx-guard did not send starts a new idle period', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'idle', when: { idle: '5m' }, do: ['notify'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  await $.prompt.submit({ text: '[ctx-guard] x', origin: CTX_GUARD } as never)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(2)
})

// ---- keep-warm: ping and prompt ---------------------------------------------------

test('keep-warm: three pings, then one prompt and a notify, then nothing', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const { clock, forks } = await trustedKeepWarm($, on, w)
  await clock.advance(55 * MIN)
  expect(forks).toEqual(['Reply with OK.'])
  expect(w.logs).toContain('debug: ctx-guard: ping read 150000, wrote 0')
  await clock.advance(55 * MIN)
  await clock.advance(55 * MIN)
  expect(forks.length).toBe(3)
  expect(w.prompts).toEqual([])
  await clock.advance(55 * MIN)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('Write the handoff to .ctx-guard/lead-handoff.md')
  // The notify is about the trigger's first metric, cache.expiresIn.
  expect(w.notifies.some(n => n.includes('prompt cache expires in'))).toBe(true)
  await clock.advance(3 * HOUR)
  expect([forks.length, w.prompts.length]).toEqual([3, 1])
})

test('keep-warm: a cold ping stops the series for the period', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const { clock, forks } = await trustedKeepWarm($, on, w, { answers: () => ({ read: 10_000, write: 140_000 }) })
  await clock.advance(4 * HOUR)
  expect(forks.length).toBe(1)
})

test('keep-warm: after a cold ping, ctx-guard\'s prompt turn warms the cache but sends no ping in that period', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const config = CACHE_ROLE([KEEP_WARM_TRIGGERS[0], { id: 'away', when: { idle: '58m' }, do: ['prompt'], times: 1 }])
  const { clock, forks } = await trustedKeepWarm($, on, w, { config, answers: () => ({ read: 10_000, write: 140_000 }) })
  // The cold ping at 55m, the prompt at 58m.
  await clock.advance(58 * MIN)
  expect([forks.length, ownPrompts(w).length]).toEqual([1, 1])
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  // The prompt turn's request anchors a fresh countdown, and `warm` fires again at 113m; the period stays cold.
  await clock.advance(62 * MIN)
  expect(forks.length).toBe(1)
})

test('keep-warm: a failed ping is retried on the next tick, not fired again', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  let n = 0
  const { clock, forks } = await trustedKeepWarm($, on, w, { answers: () => (n++ === 0 ? 'error' : WARM_READ) })
  await clock.advance(55 * MIN)
  expect(forks.length).toBe(1)
  expect(await ctxGuard($, '')).toContain('cache: TTL 1h (from config); expires in 4m; pings 0/3; ping of "warm" waits for its retry (try 2)')
  await clock.advance(MIN)
  expect(forks.length).toBe(2)
  expect(await ctxGuard($, '')).toContain('cache: TTL 1h (from config); expires in 59m; pings 1/3\n')
  // The retry was warm: the next ping comes a full TTL later, and only two fires of `warm` remain.
  await clock.advance(2 * 55 * MIN)
  expect(forks.length).toBe(4)
})

test('keep-warm: a failing ping is retried on every tick until the cache expires, then dropped', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const { clock, forks } = await trustedKeepWarm($, on, w, { answers: () => 'error' })
  // Fired at 55m; retried at 56, 57, 58 and 59m; expired at 59m 30s.
  await clock.advance(60 * MIN)
  expect(forks.length).toBe(5)
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(5)
})

test('keep-warm: a ping that times out is retried once the request is over, one at a time', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  let n = 0
  const config = CACHE_ROLE([{ id: 'warm', when: { 'cache.expiresIn': '10m' }, do: ['ping'], times: 3 }])
  const { clock, forks } = await trustedKeepWarm($, on, w, { config, answers: () => (n++ === 0 ? { ...WARM_READ, hang: 3.5 * MIN } : WARM_READ) })
  // Fired at 50m; timed out at 52m; the request itself answers at 53m 30s.
  await clock.advance(53 * MIN + 15_000)
  expect(forks.length).toBe(1)
  expect(w.logs).toContain('debug: ctx-guard: ping failed (timeout)')
  await clock.advance(MIN)
  expect(forks.length).toBe(2)
})

test('keep-warm: a ping whose request never settles holds the slot until 4 minutes after it went', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  let n = 0
  const config = CACHE_ROLE([{ id: 'warm', when: { 'cache.expiresIn': '10m' }, do: ['ping'], times: 3 }])
  const { clock, forks } = await trustedKeepWarm($, on, w, { config, answers: () => (n++ === 0 ? { ...WARM_READ, hang: 10 * HOUR } : WARM_READ) })
  // Fired at 50m; timed out at 52m; the request never answers.
  await clock.advance(53 * MIN + 15_000)
  expect(forks.length).toBe(1)
  // At 54m it counts as gone: the retry goes.
  await clock.advance(MIN)
  expect(forks.length).toBe(2)
})

test('keep-warm: a ping in flight never holds up a /clear, and its answer after one is dropped', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const config = CACHE_ROLE(KEEP_WARM_TRIGGERS, { ttl: '1h', band: { show: 'always' } })
  const { clock, forks } = await trustedKeepWarm($, on, w, { config, answers: () => ({ ...WARM_READ, hang: MIN }) })
  await clock.advance(55 * MIN)
  expect(forks.length).toBe(1)
  // Resolves with the fork still out: the clock has not moved.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.advance(2 * MIN)
  // A warm answer applied would anchor the new, empty context: `cache 59m · ping 1/3`.
  expect(bandOfWorld(w)).not.toContain('cache')
})

test('keep-warm: nothing is sent without trust, the band says untrusted, notify still runs', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const config = CACHE_ROLE([
    KEEP_WARM_TRIGGERS[0],
    { id: 'away', when: { idle: '50m' }, do: ['prompt', 'notify'], times: 1 },
    { id: 'gone', when: { 'cache.expiresIn': '2m', idle: '70m' }, do: ['ping', 'prompt'], times: 2, message: 'Away {idle}.' },
  ])
  const { clock, forks } = await trustedKeepWarm($, on, w, { config, trust: false })
  expect(bandOfWorld(w)).toContain('untrusted')
  await clock.advance(4 * HOUR)
  expect(forks).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.notifies.length).toBe(1)
  expect(w.toasts.filter(t => t.startsWith('ctx-guard: ping and prompt actions skipped'))).toEqual([
    "ctx-guard: ping and prompt actions skipped: this repo's automatic actions are not approved (never approved); the operator runs /ctx-guard trust.",
  ])
  // Each ping and prompt trigger with its times and the text its prompt sends.
  expect(await ctxGuard($, 'trust')).toContain(
    '    ping trigger warm: times 3\n    prompt trigger away: times 1, prompt default\n    ping and prompt trigger gone: times 2, prompt "Away {idle}."\n',
  )
})

test('keep-warm: no ping while a usage window is at maxUsage', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'five_hour', percentUsed: 92 }] })
  const { clock, forks } = await trustedKeepWarm($, on, w)
  await clock.advance(55 * MIN)
  expect(forks).toEqual([])
})

test('keep-warm: no prompt from a cache trigger while a usage window is at cache.prompt.maxUsage; one on idle goes', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'seven_day', percentUsed: 92 }] })
  const config = CACHE_ROLE([
    { id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt', 'notify'], times: 1 },
    { id: 'idle', when: { idle: '57m' }, do: ['prompt'], times: 1 },
  ])
  const { clock } = await trustedKeepWarm($, on, w, { config })
  await clock.advance(55 * MIN)
  expect([ownPrompts(w).length, w.notifies.length]).toEqual([0, 1])
  await clock.advance(2 * MIN)
  expect(ownPrompts(w).length).toBe(1)
})

test('keep-warm: cache.prompt.maxUsage moves the line', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'five_hour', percentUsed: 92 }] })
  const config = CACHE_ROLE([{ id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt'], times: 1 }], { ttl: '1h', prompt: { maxUsage: 95 } })
  const { clock } = await trustedKeepWarm($, on, w, { config })
  await clock.advance(55 * MIN)
  expect(ownPrompts(w).length).toBe(1)
})

test('keep-warm: a prompt skipped at cache.prompt.maxUsage leaves the ping beside it to go', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'five_hour', percentUsed: 85 }] })
  const config = CACHE_ROLE(
    [
      { id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 },
      { id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt'], times: 1 },
    ],
    { ttl: '1h', prompt: { maxUsage: 80 } },
  )
  const { clock, forks } = await trustedKeepWarm($, on, w, { config })
  await clock.advance(55 * MIN)
  expect([ownPrompts(w).length, forks.length]).toEqual([0, 1])
})

test('keep-warm: a prompt skipped at cache.prompt.maxUsage leaves another prompt in the same fire to go', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'five_hour', percentUsed: 92 }] })
  const config = CACHE_ROLE([
    { id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt'], times: 1 },
    { id: 'idle', when: { idle: '55m' }, do: ['prompt'], times: 1, message: 'Idle.' },
  ])
  const { clock } = await trustedKeepWarm($, on, w, { config })
  await clock.advance(54 * MIN)
  expect(w.prompts).toEqual([])
  // Both cross on the 55m tick: `away` is skipped, `idle` goes.
  await clock.advance(MIN)
  expect(w.prompts).toEqual(['Idle.'])
})

test('prompt then compact on a cache trigger: at cache.prompt.maxUsage the prompt is skipped and the compact runs', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'five_hour', percentUsed: 92 }] })
  const config = CACHE_ROLE([{ id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt', 'compact'], times: 1 }])
  const { clock } = await trustedKeepWarm($, on, w, { config })
  // A Stop that lists no background tasks: a compact let through runs at once.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(55 * MIN)
  expect([ownPrompts(w), compacts(w)]).toEqual([[], ['compact']])
})

test('prompt then compact on a cache trigger: a refused prompt\'s retry at cache.prompt.maxUsage is skipped, and the compact runs', async ($, on) => {
  const w = newWorld({ tokens: 150_000, dropPrompt: 'refused by another plugin' })
  const config = CACHE_ROLE([{ id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt', 'compact'], times: 1 }])
  const { clock } = await trustedKeepWarm($, on, w, { config })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(55 * MIN)
  expect([w.prompts.length, compacts(w).length]).toEqual([1, 0])
  w.dropPrompt = null
  w.limits.push({ kind: 'five_hour', percentUsed: 92 })
  await clock.advance(MIN)
  expect([w.prompts.length, compacts(w)]).toEqual([1, ['compact']])
})

test('prompt then compact: /compact runs at the prompt turn\'s end', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  writeConfig(w, CACHE_ROLE([{ id: 'away', when: { idle: '50m' }, do: ['prompt', 'compact'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(51 * MIN)
  expect(w.prompts.length).toBe(1)
  expect(compacts(w)).toEqual([])
  await turn($, 'start')
  await mainTurnEnd($, clock)
  expect(compacts(w)).toEqual(['compact'])
})

test('prompt then compact on cache.expiresIn: the compact outlives the re-arm of the prompt turn', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const config = CACHE_ROLE([{ id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt', 'compact'], times: 1 }])
  const { clock } = await trustedKeepWarm($, on, w, { config })
  await clock.advance(55 * MIN)
  expect(w.prompts.length).toBe(1)
  await turn($, 'start')
  await step($, clock)
  // A tick in the turn: the cache is in use, so `away` re-arms.
  await clock.advance(MIN)
  expect(compacts(w)).toEqual([])
  await mainTurnEnd($, clock)
  expect(compacts(w)).toEqual(['compact'])
})

test('ctx-guard\'s prompt turn keeps the idle period; the operator\'s next turn starts one', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const config = CACHE_ROLE([
    { id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 },
    { id: 'away', when: { idle: '58m', 'cache.pings': 1 }, do: ['prompt'], times: 1 },
    { id: 'idle', when: { idle: '5m' }, do: ['notify'] },
  ])
  const { clock, forks } = await trustedKeepWarm($, on, w, { config })
  // The notify at 5m, the ping at 55m, the prompt at 58m.
  await clock.advance(58 * MIN)
  expect([w.notifies.length, forks.length, ownPrompts(w).length]).toEqual([1, 1, 1])
  await turn($, 'start')
  await step($, clock)
  // A subagent's turn inside the prompt turn.
  await $.turn.start({ text: '', turnId: 't2', agentId: 'sub' })
  await clock.advance(MIN)
  await turn($, 'end')
  // Idle counts on from the operator's turn, and the ping and times stay spent: no second notify, ping or prompt.
  await clock.advance(57 * MIN)
  expect([w.notifies.length, forks.length, ownPrompts(w).length]).toEqual([1, 1, 1])
  expect(bandOfWorld(w)).toContain('ping 1/1')
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  // A new period: the notify, the ping and the prompt each come again.
  await clock.advance(59 * MIN)
  expect([w.notifies.length, forks.length, ownPrompts(w).length]).toEqual([2, 2, 2])
})

test('a refused prompt is tried three times in all; the next turn is the operator\'s', async ($, on) => {
  const w = newWorld({ dropPrompt: 'refused by another plugin' })
  writeConfig(w, CACHE_ROLE([{ id: 'away', when: { idle: '5m' }, do: ['prompt'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(5 * MIN)
  expect(w.prompts.length).toBe(1)
  await clock.advance(MIN)
  expect(w.prompts.length).toBe(2)
  await clock.advance(10 * MIN)
  expect(w.prompts.length).toBe(3)
  w.dropPrompt = null
  // A turn that no prompt.submit announced: the refused prompt's flag must not make it ctx-guard's.
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(5 * MIN)
  expect(w.prompts.length).toBe(4)
})

const AWAY_COMPACT = CACHE_ROLE([{ id: 'away', when: { idle: '50m' }, do: ['prompt', 'compact'], times: 1 }])

async function awayCompact($: Engine, on: On, w: World): Promise<MockClock> {
  writeConfig(w, AWAY_COMPACT)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  // A Stop that lists no background tasks: a compact let through would run at once.
  await mainTurnEnd($, clock)
  return clock
}

test('prompt then compact: a refused prompt holds the compact until its retry\'s turn ends', async ($, on) => {
  const w = newWorld({ tokens: 150_000, dropPrompt: 'refused by another plugin' })
  const clock = await awayCompact($, on, w)
  await clock.advance(51 * MIN)
  expect([w.prompts.length, compacts(w).length]).toEqual([2, 0])
  w.dropPrompt = null
  await clock.advance(MIN)
  expect([w.prompts.length, compacts(w).length]).toEqual([3, 0])
  await turn($, 'start')
  await mainTurnEnd($, clock)
  expect(compacts(w)).toEqual(['compact'])
})

test('prompt then compact: a prompt refused three times drops its compact', async ($, on) => {
  const w = newWorld({ tokens: 150_000, dropPrompt: 'refused by another plugin' })
  const clock = await awayCompact($, on, w)
  await clock.advance(60 * MIN)
  expect(w.prompts.length).toBe(3)
  expect(w.toasts).toContain('ctx-guard: the queued /compact for trigger "away" was dropped: its prompt was refused 3 times.')
  // The operator's next turn end finds nothing queued.
  w.dropPrompt = null
  await turn($, 'start')
  await mainTurnEnd($, clock)
  expect(compacts(w)).toEqual([])
})

test('a prompt that fires while a main turn runs waits for the next idle tick, no try spent', async ($, on) => {
  const w = newWorld({ dropPrompt: null })
  writeConfig(w, CACHE_ROLE([
    { id: 'away', when: { idle: '5m' }, do: ['prompt'], times: 1 },
    { id: 'later', when: { idle: '7m' }, do: ['prompt'], times: 1 },
  ]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(5 * MIN)
  expect(w.prompts.length).toBe(1)
  // ctx-guard's own turn runs, and idle counts on: `later` fires inside it at 7m and waits through three ticks.
  await turn($, 'start')
  await clock.advance(4 * MIN + 30_000)
  expect(w.prompts.length).toBe(1)
  await turn($, 'end')
  await clock.advance(MIN)
  expect(w.prompts.length).toBe(2)
})

test('prompt then compact: the operator back before the refused prompt went in: no compact', async ($, on) => {
  const w = newWorld({ tokens: 150_000, dropPrompt: 'refused by another plugin' })
  const clock = await awayCompact($, on, w)
  await clock.advance(50 * MIN)
  expect(w.prompts.length).toBe(1)
  w.dropPrompt = null
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  await mainTurnEnd($, clock)
  expect(compacts(w)).toEqual([])
  // The retry's trigger no longer holds: the prompt and its compact are given up.
  await clock.advance(MIN)
  expect(ownPrompts(w)).toEqual([w.prompts[0]])
  expect(w.toasts.some(t => t.includes('/compact for trigger "away" was dropped'))).toBe(true)
})

test('prompt then compact on a cache trigger: the operator back before a refused prompt\'s retry, at cache.prompt.maxUsage: no compact', async ($, on) => {
  const w = newWorld({ tokens: 150_000, dropPrompt: 'refused by another plugin' })
  const config = CACHE_ROLE([
    { id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 },
    { id: 'away', when: { 'cache.pings': 1 }, do: ['prompt', 'compact'], times: 1 },
  ])
  const { clock, forks } = await trustedKeepWarm($, on, w, { config })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  // The ping at 55m; `away` at 56m, refused.
  await clock.advance(56 * MIN)
  expect([forks.length, ownPrompts(w).length, compacts(w).length]).toEqual([1, 1, 0])
  w.dropPrompt = null
  w.limits.push({ kind: 'five_hour', percentUsed: 92 })
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  // A tick in the operator's turn puts the retry off; the usage cap is read only idle.
  await clock.advance(MIN)
  await mainTurnEnd($, clock)
  expect(compacts(w)).toEqual([])
  // The operator's turn began a new period: `away` no longer holds, and its prompt and compact are given up.
  await clock.advance(MIN)
  expect([ownPrompts(w).length, compacts(w)]).toEqual([1, []])
  expect(w.toasts.some(t => t.includes('/compact for trigger "away" was dropped'))).toBe(true)
})

// The presets carry a cache.miss toast, so a rewritten prefix shows up without any extra config.
for (const [preset, role] of [['solo', 'main'], ['peers', 'lead']] as const) {
  test(`the ${preset} preset toasts a cache miss`, async ($, on) => {
    const w = newWorld()
    writeConfig(w, PRESET_TEXT[preset] ?? '')
    const { clock } = world(on, w, { CTX_GUARD_ROLE: role })
    usageBottom(on, [
      { read: 50_000, write: 100_000 },
      { read: 150_000, write: 0 },
      { read: 10_000, write: 140_000 },
    ])
    await start($)
    await step($, clock)
    await step($, clock)
    expect(missToasts(w)).toEqual([])
    await step($, clock)
    expect(missToasts(w)).toEqual([`ctx-guard: ${role}: cache miss, 140k re-written (prefix changed: CLAUDE.md, tools or MCP?)`])
  })
}
