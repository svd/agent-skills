import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock, MockSession, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  NOW,
  HOUR,
  newWorld,
  usageOf,
  world,
  writeConfig,
  start,
  measure,
  step,
  ctxGuard,
  notes,
  PEEK,
  peek,
  agentDenied,
  LEAD_BRAKE,
  run,
  turn,
  MIN,
  HANDOFF,
  autoConfig,
  restartWorld,
  ready,
  PEEK_RESTART,
  peekRestart,
  mainTurnEnd,
  status,
  usageBottom,
  CACHE_ROLE,
  bandOfWorld,
  missToasts,
  CTX_GUARD,
  WARM_READ,
  NO_USAGE,
  trustedKeepWarm,
  ownPrompts,
  compacts,
  WIPE,
} from './register.fixtures'
import type {
  Limit,
  World,
} from './register.fixtures'

// ---- lifts: holds, lift checks and wake prompts -----------------------------------

const iso = (ms: number): string => new Date(ms).toISOString()

const fiveAt = (pct: number, resetsAt: number): Limit => ({ kind: 'five_hour', percentUsed: pct, resetsAt: iso(resetsAt) })

const weekAt = (pct: number, resetsAt: number): Limit => ({ kind: 'seven_day', percentUsed: pct, resetsAt: iso(resetsAt) })

const DAY = 24 * HOUR

// The five-hour brake: at 95 % Agent is denied; its lift notes and wakes (twice between operator inputs).
const STOP = (lift: unknown = { do: ['note', 'prompt'], times: 2 }, extra: unknown[] = []) => ({
  version: 1,
  roles: { lead: { triggers: [{ id: 'stop', when: { 'limit.five_hour': 95 }, do: ['note', { deny: ['Agent'] }], level: 'stop', lift }, ...extra] } },
})

// What the fork bottom does on each lift check: report new windows, hang, fail, or find nothing to fork.
type LiftFork = { limits?: Limit[]; hang?: number; fail?: 'api-error' | 'nothing-to-fork' }

function liftForkBottom(on: On, w: World, clock: MockClock, answers: () => LiftFork, calls: string[]): void {
  on('model.fork', async ($, e) => {
    calls.push(e.prompt)
    const a = answers()
    if (a.hang) await clock.sleep(a.hang)
    if (a.limits) w.limits = a.limits
    if (a.fail === 'nothing-to-fork') return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
    if (a.fail === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: NO_USAGE } } as never
    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 13, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000 } } } as never
  })
}

type Braked = { config?: unknown; forks?: LiftFork[] | (() => LiftFork); trust?: boolean; surface?: 'vscode'; options?: never }

// A trusted lead under the five-hour brake (96 %, resetting in 2h): the session start holds it and notes it.
async function braked($: Engine, on: On, w: World, o: Braked = {}): Promise<{ clock: MockClock; session: MockSession; forks: string[] }> {
  writeConfig(w, o.config ?? STOP())
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  const forks: string[] = []
  const list = o.forks ?? [{ limits: [fiveAt(10, NOW + 7 * HOUR)] }]
  let n = 0
  liftForkBottom(on, w, clock, typeof list === 'function' ? list : () => list[Math.min(n++, list.length - 1)] ?? {}, forks)
  await start($, o.surface)
  if (o.trust !== false) await ctxGuard($, 'trust')
  return { clock, session, forks }
}

// The five-hour window reads as rolled over a minute past its reset: at 2h.
const ROLLS_AT = NOW + 2 * HOUR - MIN

const brakeWorld = (over: Partial<World> = {}): World => newWorld({ limits: [fiveAt(96, ROLLS_AT)], ...over })

// The brake touches the work: a turn whose Agent call is refused, then its end.
async function touch($: Engine, clock: MockClock): Promise<void> {
  await turn($, 'start')
  expect(await agentDenied($)).toContain('is blocked by trigger')
  await mainTurnEnd($, clock)
}

const wakePrompts = (w: World): string[] => w.prompts.filter(p => p.includes('has lifted'))

const liftNotes = (s: MockSession): string[] => notes(s).filter(n => n.includes('has lifted'))

// Past the five-hour reset, to the first idle tick after it.
const PAST_RESET = 2 * HOUR + MIN

// To the idle tick at `at` (ticks fall on whole minutes from the start).
const advanceTo = (clock: MockClock, at: number): Promise<void> => clock.advance(at - clock.now())

test('lift: "go on" → refused by the brake → turn ends → the window resets → one check, one wake prompt, no separate note', async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w)
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' } } as never)
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(forks).toEqual(['Reply with OK.'])
  expect(wakePrompts(w)).toEqual([
    '[ctx-guard] Trigger "stop" has lifted: the 5-hour usage window reset. Agent is allowed again. You paused your work because of it. ' +
      'Time has passed since then, so first check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. ' +
      'Then carry on with the work you paused. If nothing is left to do, say so in one line and stop.',
  ])
  expect(liftNotes(session)).toEqual([])
  // Nothing more on later ticks.
  await clock.advance(10 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('lift: not touched → no prompt and no notify; a notify in lift.do still goes', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { config: STOP({ do: ['notify', 'prompt'], times: 2 }) })
  await turn($, 'start')
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again.'])
})

test('lift: a refusal another trigger made still touches the hold', async ($, on) => {
  const w = brakeWorld()
  // `cap` is first in config order and blocks Agent too: deniedBy names it, not `stop`.
  const config = { version: 1, roles: { lead: { triggers: [{ id: 'cap', when: { 'limit.five_hour': 90 }, do: [{ deny: ['Agent'] }] }, ...STOP().roles.lead.triggers] } } }
  const { clock } = await braked($, on, w, { config })
  await turn($, 'start')
  expect(await agentDenied($)).toContain('trigger "cap"')
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect(wakePrompts(w).length).toBe(1)
})

test('lift: operator input after the last touch → a toast and the lift note, no prompt', async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w)
  await touch($, clock)
  await clock.advance(MIN)
  await $.prompt.submit({ text: 'do something else', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
  expect(w.toasts).toContain('ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again.')
  expect(liftNotes(session)).toEqual(['[{"type":"text","text":"[ctx-guard] Trigger \\"stop\\" has lifted: the 5-hour usage window reset. Agent is allowed again."}]'])
})

test('lift: operator input delivered into a running turn after the touch counts', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w)
  await turn($, 'start')
  expect(await agentDenied($)).toBeDefined()
  await clock.advance(MIN)
  await $.prompt.submit({ text: 'stop that', origin: { kind: 'composer' }, turnId: 't1' } as never)
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
})

for (const kind of ['task-notification', 'scheduled-trigger', 'unclassified', 'peer-send-message'] as const) {
  test(`lift: a ${kind} prompt after the touch is not operator input`, async ($, on) => {
    const w = brakeWorld()
    const { clock } = await braked($, on, w)
    await touch($, clock)
    await clock.advance(MIN)
    await $.prompt.submit({ text: 'note', origin: { kind } } as never)
    await clock.advance(PAST_RESET)
    expect(wakePrompts(w).length).toBe(1)
  })
}

test('lift: /ctx-guard typed at the composer and the restart\'s own /ctx-guard:resume are not operator input', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w)
  await touch($, clock)
  await clock.advance(MIN)
  await ctxGuard($, '')
  await $.command.run({ command: 'ctx-guard:resume', args: 'role=lead', origin: CTX_GUARD as never, presentation: { isFullscreen: false, columns: 120 } })
  await clock.advance(PAST_RESET)
  expect(wakePrompts(w).length).toBe(1)
})

for (const [what, input] of [
  ['a peer message', async ($: Engine) => void (await $.prompt.submit({ text: 'from the lead', origin: { kind: 'peer' } } as never))],
  ['/ctx-guard:resume typed', async ($: Engine) => void (await $.command.run({ command: 'ctx-guard:resume', args: 'role=lead', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } }))],
  ['an operator /clear', async ($: Engine) => void (await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } }))],
] as const) {
  test(`lift: ${what} after the touch is operator input`, async ($, on) => {
    const w = brakeWorld()
    const { clock, forks } = await braked($, on, w)
    await touch($, clock)
    await clock.advance(MIN)
    await input($)
    await clock.advance(PAST_RESET)
    expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
  })
}

// What the engine raises for a typed command: command.run, then a second later here, the prompt.submit of its prompt.
for (const command of ['ctx-guard:resume', 'ctx-guard:clear', 'review']) {
  test(`a typed /${command} is one operator input: the lifts are written once`, { plugins: [WIPE] }, async ($, on) => {
    const w = brakeWorld()
    const { clock } = await braked($, on, w)
    await touch($, clock)
    await $.command.run({ command: 'wipe', args: '', origin: { kind: 'plugin', name: 'test' } as never, presentation: { isFullscreen: false, columns: 120 } })
    await $.command.run({ command, args: 'role=lead', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
    await clock.advance(1000)
    await $.prompt.submit({ text: `/${command} role=lead`, origin: { kind: 'composer' }, command: { name: command, args: 'role=lead' } } as never)
    await clock.settle()
    const r = await $.command.run({ command: 'wipe-sets', args: '', origin: { kind: 'plugin', name: 'test' } as never, presentation: { isFullscreen: false, columns: 120 } })
    expect(JSON.parse(r.text ?? '{}').lifts).toBe(1)
  })
}

// Reads ctx-guard's lifts and cache from $.state.
const PEEK_LIFTS: Plugin = {
  name: 'peek-lifts',
  register: on => {
    on('command.run', { command: 'peek-lifts' }, async $ => {
      const lifts = (await $.state.get({ plugin: 'ctx-guard', key: 'lifts' })).value ?? null
      const cache = (await $.state.get({ plugin: 'ctx-guard', key: 'cache' })).value ?? null
      return { text: JSON.stringify({ lifts, cache }) }
    })
  },
}

type PeekedLifts = {
  lifts: { holds: Record<string, { phase: string; tries: number; touchedAt: number | null; startedAt: number }>; attempts: Record<string, number>; forkAt: number | null; pending: unknown } | null
  cache: { pings: number; anchor: number | null; cold: boolean } | null
}

async function peekLifts($: Engine): Promise<PeekedLifts> {
  const r = await $.command.run({ command: 'peek-lifts', args: '', origin: { kind: 'plugin', name: 'test' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

test('lift mid-turn with note and prompt: the note read by a later step → no prompt', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [{ read: 100_000, write: 0 }])
  const { clock, session, forks } = await braked($, on, w)
  await touch($, clock)
  await clock.advance(2 * HOUR - MIN)
  await turn($, 'start')
  await clock.advance(2 * MIN)
  expect(liftNotes(session).length).toBe(1)
  await clock.advance(1000)
  await step($, clock)
  await mainTurnEnd($, clock)
  await clock.advance(10 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
})

test('lift mid-turn: a call to the freed tool that goes through → no prompt', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { config: STOP({ do: ['prompt'], times: 2 }) })
  await touch($, clock)
  await clock.advance(2 * HOUR - MIN)
  await turn($, 'start')
  await clock.advance(2 * MIN)
  expect(await agentDenied($)).toBeUndefined()
  await clock.settle()
  await mainTurnEnd($, clock)
  await clock.advance(10 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
})

test('lift mid-turn: the turn ends with the note unread and the tool unused → a wake attempt at the next idle tick', async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w)
  await touch($, clock)
  await clock.advance(2 * HOUR - MIN)
  await turn($, 'start')
  await clock.advance(2 * MIN)
  expect(liftNotes(session).length).toBe(1)
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
  // The note went mid-turn; no second one with the prompt.
  expect(liftNotes(session).length).toBe(1)
})

test('lift mid-turn whose idle-tick check finds the brake holding → no prompt; the trigger notes its new crossing', async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w, { forks: [{ limits: [fiveAt(97, NOW + 7 * HOUR)] }] })
  const before = notes(session).filter(n => n.includes('5-hour usage is at')).length
  await touch($, clock)
  await clock.advance(2 * HOUR - MIN)
  await turn($, 'start')
  await clock.advance(2 * MIN)
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 0])
  expect(liftNotes(session).length).toBe(1)
  expect(notes(session).filter(n => n.includes('5-hour usage is at')).length).toBe(before + 1)
})

test('lift under a closed gate, touched → a notify with its reason at once, no fork, no attempt counted', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w, { trust: false })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(forks).toEqual([])
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: the repo is not trusted.'])
  expect(liftNotes(session).length).toBe(1)
  expect((await peekLifts($)).lifts?.attempts).toEqual({})
})

for (const touched of [true, false]) {
  test(`lift while paused, ${touched ? 'touched → a notify "ctx-guard is paused"' : 'untouched → no notify'}`, async ($, on) => {
    const w = brakeWorld()
    const { clock, forks } = await braked($, on, w)
    if (touched) await touch($, clock)
    await ctxGuard($, 'pause 3h')
    await clock.advance(PAST_RESET)
    expect(w.notifies).toEqual(touched ? ['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: ctx-guard is paused.'] : [])
    expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
  })
}

test('lift under a closed gate, not touched → no notify for the prompt', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { trust: false })
  await clock.advance(PAST_RESET)
  expect(w.notifies).toEqual([])
})

test('several lifts under a closed gate → one notify naming them', async ($, on) => {
  const w = brakeWorld()
  const second = { id: 'any', when: { 'limit.any': 95 }, do: [{ deny: ['WebFetch'] }], lift: { do: ['prompt'], times: 1 } }
  const { clock } = await braked($, on, w, { config: STOP(undefined, [second]), trust: false })
  await turn($, 'start')
  expect(await agentDenied($)).toBeDefined()
  expect((await $.tool.call({ tool: 'WebFetch', url: 'https://x' } as never)).deny).toBeDefined()
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect(w.notifies).toEqual([
    'ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. "any" lifted (the 5-hour usage window reset); WebFetch allowed again. Not woken: the repo is not trusted.',
  ])
})

const NOTE_B = (pct: number) => ({ id: 'b', when: { 'limit.five_hour': pct }, do: [{ deny: ['WebFetch'] }], lift: { do: ['note'] } })

test('mixed lifts: the note-only lift waits for the check; freed, its note goes and the other\'s text goes as the prompt', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { config: STOP(undefined, [NOTE_B(90)]) })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(liftNotes(session)).toEqual(['[{"type":"text","text":"[ctx-guard] Trigger \\"b\\" has lifted: the 5-hour usage window reset. WebFetch is allowed again."}]'])
  expect(wakePrompts(w).length).toBe(1)
})

test('mixed lifts: the check holds the waking lift only → the other\'s note goes, the waking one does nothing', async ($, on) => {
  const w = brakeWorld({ limits: [fiveAt(99, NOW + 2 * HOUR)] })
  const { clock, session } = await braked($, on, w, { config: STOP(undefined, [NOTE_B(98)]), forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(liftNotes(session).map(n => n.includes('"b\\" has lifted'))).toEqual([true])
  expect(wakePrompts(w)).toEqual([])
})

test('charged trigger: stacked brakes both held again on fresh figures → the first in config order counts one attempt', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const second = { id: 'stop2', when: { 'limit.five_hour': 90 }, do: [{ deny: ['Agent'] }], lift: { do: ['prompt'], times: 2 } }
  const { clock, forks } = await braked($, on, w, { config: STOP(undefined, [second]), forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(forks.length).toBe(1)
  const p = await peekLifts($)
  expect(p.lifts?.attempts).toEqual({ stop: 1 })
  expect([p.lifts?.holds.stop?.phase, p.lifts?.holds.stop2?.phase, p.lifts?.holds.stop?.tries]).toEqual(['holding', 'holding', 0])
})

test('lift.times 2: check holds, check holds, then the third lift notes and notifies "lift.times is spent", no fork', async ($, on) => {
  const w = brakeWorld()
  let reset = NOW + 2 * HOUR
  const { clock, session, forks } = await braked($, on, w, {
    forks: () => {
      reset += 5 * HOUR
      return { limits: [fiveAt(96, reset)] }
    },
  })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  await clock.advance(5 * HOUR)
  expect(forks.length).toBe(2)
  await clock.advance(5 * HOUR)
  expect(forks.length).toBe(2)
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: lift.times is spent.'])
  expect(liftNotes(session).length).toBe(1)
})

test('fresh figures hold the brake: no lift action, no notify, the mark kept; the next let-go wakes without a new touch', async ($, on) => {
  const w = brakeWorld()
  let n = 0
  const { clock, session, forks } = await braked($, on, w, { forks: () => (n++ === 0 ? { limits: [fiveAt(96, NOW + 7 * HOUR)] } : { limits: [fiveAt(10, NOW + 12 * HOUR)] }) })
  const edges = (): number => notes(session).filter(n => n.includes('5-hour usage is at')).length
  const before = edges()
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length, liftNotes(session).length, w.notifies.length, edges()]).toEqual([1, 0, 0, 0, before])
  await clock.advance(5 * HOUR)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
})

test('a fork that reports the stale figures again is judged on $.session.usage(), with no hang', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { forks: [{}] })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('the fork\'s own measure and an idle tick during the fork start no second check and no second lift', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 90_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  w.limits = [fiveAt(12, NOW + 7 * HOUR)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.advance(MIN)
  expect(wakePrompts(w)).toEqual([])
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('the operator types while the fork runs → no prompt; a toast and the note on their turn', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  await clock.advance(MIN)
  expect(wakePrompts(w)).toEqual([])
  expect(w.toasts).toContain('ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again.')
  expect(liftNotes(session).length).toBe(1)
})

test('a non-operator turn starts during the fork, the check frees the tools → no note while the prompt waits; it goes at the next idle tick', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  expect([wakePrompts(w).length, liftNotes(session).length]).toEqual([0, 0])
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([wakePrompts(w).length, liftNotes(session).length]).toEqual([1, 0])
})

test('a prompt waiting after the check whose lift a reload no longer prompts → no prompt; the lift note goes instead', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  // The check let the prompt through; it waits for the turn's end. The lift loses its prompt.
  writeConfig(w, STOP({ do: ['note'] }))
  const reload = ctxGuard($, 'reload')
  await clock.settle()
  await reload
  await ctxGuard($, 'trust')
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([wakePrompts(w).length, liftNotes(session).length]).toEqual([0, 1])
})

test('a prompt waiting after the check, dropped by operator input → the note is appended then', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await turn($, 'start')
  await clock.advance(MIN)
  await $.prompt.submit({ text: 'me again', origin: { kind: 'composer' }, turnId: 't1' } as never)
  await clock.settle()
  expect(liftNotes(session).length).toBe(1)
  await mainTurnEnd($, clock)
  await clock.advance(5 * MIN)
  expect(wakePrompts(w)).toEqual([])
})

test('a non-operator turn during the fork that uses a freed tool drops the prompt and appends the note', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await turn($, 'start')
  await clock.advance(MIN)
  expect(await agentDenied($)).toBeUndefined()
  await clock.settle()
  expect(liftNotes(session).length).toBe(1)
  await mainTurnEnd($, clock)
  await clock.advance(5 * MIN)
  expect(wakePrompts(w)).toEqual([])
})

test('trust withdrawn during the fork → a notify with its reason, no prompt', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await ctxGuard($, 'trust off')
  await clock.advance(MIN)
  expect(wakePrompts(w)).toEqual([])
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: the repo is not trusted.'])
})

test('lift checks failing three times count one attempt, stall with one notify; a new usage report makes a new attempt', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  let fail = true
  const { clock, forks } = await braked($, on, w, { forks: () => (fail ? { fail: 'api-error' } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(forks.length).toBe(1)
  await clock.advance(2 * MIN)
  expect(forks.length).toBe(3)
  expect(w.notifies).toEqual([
    'ctx-guard: "stop" may have lifted, but fresh usage could not be read (the window may still be full). Not woken; ctx-guard tries again when usage is next reported or the window resets.',
  ])
  const p = await peekLifts($)
  expect([p.lifts?.holds.stop?.phase, p.lifts?.attempts]).toEqual(['stalled', { stop: 1 }])
  await clock.advance(30 * MIN)
  expect(forks.length).toBe(3)
  fail = false
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([4, 1])
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 2 })
})

test('nothing to fork fails the check like an API error', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { forks: [{ fail: 'nothing-to-fork' }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR + 2 * MIN)
  expect([forks.length, w.notifies.length, wakePrompts(w).length]).toEqual([3, 1, 0])
})

test('a stalled weekly hold makes a new attempt when the earliest known reset (the five-hour one) passes', async ($, on) => {
  const config = { version: 1, roles: { lead: { triggers: [{ id: 'w60', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: ['note', { deny: ['Agent'] }], lift: { do: ['prompt'], times: 3 } }] } } }
  const w = newWorld({ limits: [fiveAt(30, NOW + 5 * HOUR), weekAt(70, NOW + 4 * DAY + HOUR)] })
  let fail = true
  const { clock, forks } = await braked($, on, w, { config, forks: () => (fail ? { fail: 'api-error' } : {}) })
  await touch($, clock)
  // The weekly brake lets go by time an hour in; three failed tries stall it.
  await advanceTo(clock, NOW + HOUR + 3 * MIN)
  expect([forks.length, w.notifies.length]).toEqual([3, 1])
  await advanceTo(clock, NOW + 5 * HOUR - MIN)
  expect(forks.length).toBe(3)
  fail = false
  await advanceTo(clock, NOW + 5 * HOUR)
  expect([forks.length, wakePrompts(w).length]).toEqual([4, 1])
})

test('a stalled hold on a rolled-over window makes a new attempt one window length after the roll-over', async ($, on) => {
  const w = brakeWorld()
  let fail = true
  const { clock, forks } = await braked($, on, w, { forks: () => (fail ? { fail: 'api-error' } : {}) })
  await touch($, clock)
  // The five-hour window rolls over at 2h with no figures since; three failed tries stall the lift.
  await advanceTo(clock, NOW + 2 * HOUR + 5 * MIN)
  expect([forks.length, w.notifies.length]).toEqual([3, 1])
  await advanceTo(clock, ROLLS_AT + 5 * HOUR - MIN)
  expect(forks.length).toBe(3)
  fail = false
  await advanceTo(clock, ROLLS_AT + 5 * HOUR)
  expect([forks.length, wakePrompts(w).length]).toEqual([4, 1])
})

test('a failed fork whose usage moved is judged on the new figures', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { forks: [{ fail: 'api-error', limits: [fiveAt(97, NOW + 7 * HOUR)] }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR + 3 * MIN)
  // Held on the figures the error carried: no retry, no notify, no prompt.
  expect([forks.length, w.notifies.length, wakePrompts(w).length]).toEqual([1, 0, 0])
})

test('a hot reload during the fork: the fork counts as a failed try, no second fork until 2 minutes after it began, then the same attempt goes on', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  let n = 0
  const { clock, forks } = await braked($, on, w, { forks: () => (n++ === 0 ? { limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 10 * MIN } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(forks.length).toBe(1)
  await start($)
  await clock.advance(MIN)
  expect(forks.length).toBe(1)
  expect((await peekLifts($)).lifts?.holds.stop).toMatchObject({ phase: 'lifting', tries: 1 })
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
  // The first fork's late answer changes nothing.
  await clock.advance(10 * MIN)
  expect(wakePrompts(w).length).toBe(1)
})

test('a /clear during the fork drops its answer; the new context was never touched: no wake, the lift note goes there', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  let n = 0
  const { clock, session, forks } = await braked($, on, w, { forks: () => (n++ === 0 ? { hang: MIN } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.advance(30_000)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 0])
  // The first fork settles at 2h1m, its answer dropped; the next tick judges the hold again, untouched.
  await clock.advance(5 * MIN)
  expect([forks.length, wakePrompts(w).length, liftNotes(session).length]).toEqual([1, 0, 1])
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
})

test('a fork that does not answer within 2 minutes is a failed try; the next try waits until it settles', async ($, on) => {
  const w = brakeWorld()
  let n = 0
  const { clock, forks } = await braked($, on, w, { forks: () => (n++ === 0 ? { limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 2.5 * MIN } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR + 2 * MIN)
  expect(w.logs).toContain('debug: ctx-guard: lift check failed (timeout)')
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 0])
  // It settles at 2h2m30s, its late answer dropped; the next try forks at the next tick.
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
})

test('a lift check\'s fork that never settles holds the slot until 4 minutes after it began; then the next try forks', async ($, on) => {
  const w = brakeWorld()
  let n = 0
  const { clock, forks } = await braked($, on, w, { forks: () => (n++ === 0 ? { hang: 100 * DAY } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR + 3 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 0])
  // 4 minutes after it began the fork counts as gone; its answer, should it come, is dropped.
  await advanceTo(clock, NOW + 2 * HOUR + 4 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
})

test('a refused wake prompt is tried three times in all with the same text, then a notify; no second fork or count', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld({ dropPrompt: 'refused by another plugin' })
  const { clock, session, forks } = await braked($, on, w)
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(wakePrompts(w).length).toBe(1)
  await clock.advance(5 * MIN)
  expect(wakePrompts(w).length).toBe(3)
  expect(new Set(wakePrompts(w)).size).toBe(1)
  expect(forks.length).toBe(1)
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: the prompt was refused.'])
  expect(liftNotes(session).length).toBe(1)
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
})

test('operator input while a refused wake prompt waits to retry → the retry is dropped, a toast and the note', async ($, on) => {
  const w = brakeWorld({ dropPrompt: 'refused by another plugin' })
  const { clock, session } = await braked($, on, w)
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  w.dropPrompt = null
  await $.prompt.submit({ text: 'here', origin: { kind: 'composer' } } as never)
  await clock.advance(5 * MIN)
  expect(wakePrompts(w).length).toBe(1)
  expect(liftNotes(session).length).toBe(1)
  expect(w.toasts).toContain('ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again.')
})

test('a woken turn: idle does not grow during it and counts from its end; trigger times and the idle period go on', async ($, on) => {
  const w = brakeWorld()
  // Once per idle period: a new period would let it notify again an hour after the woken turn.
  const quiet = { id: 'quiet', when: { idle: '1h' }, do: ['notify'], times: 1 }
  const { clock } = await braked($, on, w, { config: STOP(undefined, [quiet]) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(wakePrompts(w).length).toBe(1)
  expect(w.notifies.length).toBe(1)
  expect(await ctxGuard($, '')).toContain('idle: 2h')
  await turn($, 'start')
  await clock.advance(10 * MIN)
  expect(await ctxGuard($, '')).toContain('idle: a turn is running')
  await mainTurnEnd($, clock)
  await clock.advance(3 * MIN)
  expect(await ctxGuard($, '')).toContain('idle: 3m')
  await clock.advance(HOUR)
  expect(w.notifies.length).toBe(1)
})

test('a trigger prompt\'s turn keeps idle growing; a woken turn\'s does not', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'away', when: { idle: '5m' }, do: ['prompt'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(5 * MIN)
  expect(w.prompts.length).toBe(1)
  await turn($, 'start')
  await clock.advance(2 * MIN)
  await turn($, 'end')
  await clock.advance(MIN)
  expect(await ctxGuard($, '')).toContain('idle: 8m')
})

test('a woken turn that hits the brake again and ends can be woken again', async ($, on) => {
  const w = brakeWorld()
  let reset = NOW + 7 * HOUR
  const { clock, forks } = await braked($, on, w, { forks: () => ({ limits: [fiveAt(10, reset)] }) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(wakePrompts(w).length).toBe(1)
  // The woken turn spends the new window to the brake again and is refused.
  await turn($, 'start')
  w.limits = [fiveAt(96, NOW + 7 * HOUR - MIN)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  expect(await agentDenied($)).toBeDefined()
  await mainTurnEnd($, clock)
  reset = NOW + 12 * HOUR
  await advanceTo(clock, NOW + 7 * HOUR)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 2])
})

test('deny reason: when the tool comes free, and the wake tail only with prompt, trust, autoActions, no pause and lift.times left', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w)
  const reason = await agentDenied($)
  expect(reason).toContain('Agent comes free in 2h; ctx-guard is set to prompt you when the tool comes free.')
  await ctxGuard($, 'trust off')
  expect(await agentDenied($)).toContain('Agent comes free in 2h. If you need Agent now')
  await clock.settle()
})

test('deny reason: no wake tail for a lift without prompt', async ($, on) => {
  const w = brakeWorld()
  await braked($, on, w, { config: STOP({ do: ['note'] }) })
  expect(await agentDenied($)).toContain('Agent comes free in 2h. If you need Agent now')
})

test('blocking off: no hold, no lift', { options: { blocking: false } }, async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w)
  await clock.advance(PAST_RESET)
  expect([forks.length, liftNotes(session).length, wakePrompts(w).length]).toEqual([0, 0, 0])
})

test('a lift that runs clears the mark: the condition holding again notes again, and a correction of an estimate does not count in times', async ($, on) => {
  const w = brakeWorld()
  const config = { version: 1, roles: { lead: { triggers: [{ id: 'stop', when: { 'limit.five_hour': 95 }, do: ['note', { deny: ['Agent'] }], times: 1, lift: { do: ['note'] } }] } } }
  const { clock, session } = await braked($, on, w, { config })
  const edges = (): number => notes(session).filter(n => n.includes('5-hour usage is at')).length
  expect(edges()).toBe(1)
  await clock.advance(PAST_RESET)
  expect(liftNotes(session).length).toBe(1)
  // The first response shows the window still full: the rising edge fires again despite times 1.
  w.limits = [fiveAt(97, NOW + 7 * HOUR)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  expect(edges()).toBe(2)
})

test('after a passed reset a brake without lift denies nothing until a response reports figures; the band and report read 0 %', async ($, on) => {
  const w = brakeWorld()
  writeConfig(w, LEAD_BRAKE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  expect(await agentDenied($)).toBeDefined()
  expect(bandOfWorld(w)).toContain('5h 96%')
  await clock.advance(PAST_RESET)
  expect(await agentDenied($)).toBeUndefined()
  expect(bandOfWorld(w)).toContain('5h 0%')
  expect(await ctxGuard($, '')).toContain('usage 5-hour: 0% (estimated: the window reset, no response since)')
})

test('a stale window: the lift on the timer, then a check reporting 96 % keeps the mark: no second rising-edge note', { plugins: [PEEK, PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w, { forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  const edges = (): number => notes(session).filter(n => n.includes('5-hour usage is at')).length
  await touch($, clock)
  const mark = (await peek($)).marks?.byId.stop
  expect(mark).toBeDefined()
  await clock.advance(PAST_RESET + 5 * MIN)
  expect([forks.length, wakePrompts(w).length, liftNotes(session).length, edges()]).toEqual([1, 0, 0, 1])
  expect((await peek($)).marks?.byId.stop).toEqual(mark)
  expect((await peekLifts($)).lifts?.holds.stop?.phase).toBe('holding')
  expect(await agentDenied($)).toContain('is blocked by trigger')
})

test('a trigger prompt arising while a lift check runs waits for the next idle tick; nothing displaces anything', async ($, on) => {
  const w = brakeWorld()
  const config = STOP(undefined, [{ id: 'away', when: { idle: '121m' }, do: ['prompt'], times: 1, message: 'Away.' }])
  const { clock } = await braked($, on, w, { config, forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 90_000 }] })
  await touch($, clock)
  // The check starts at 2h; `away` fires at 2h1m, while the fork is out, and waits.
  await advanceTo(clock, NOW + 2 * HOUR + MIN)
  expect(w.prompts).toEqual([])
  // The fork answers at 2h1m30s and the wake goes; `away` goes at the next tick.
  await clock.advance(MIN)
  expect(w.prompts.length).toBe(2)
  expect(wakePrompts(w)).toEqual([w.prompts[0]])
  expect(w.prompts[1]).toBe('Away.')
})

test('limit-stop with a note and week-60-early with a prompt lift together; the check fails three times → limit-stop\'s note goes, week-60-early stalls', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const config = {
    version: 1,
    roles: {
      lead: {
        triggers: [
          { id: 'week-60-early', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: [{ deny: ['Agent', 'Workflow'] }], lift: { do: ['note', 'prompt'], times: 3 } },
          { id: 'limit-stop', when: { 'limit.any': 95 }, do: [{ deny: ['Agent', 'Workflow', 'WebSearch', 'WebFetch'] }], lift: { do: ['note'] } },
        ],
      },
    },
  }
  // The five-hour window is full and resets in an hour; the weekly brake lets go by time at the same moment.
  const w = newWorld({ limits: [fiveAt(96, NOW + HOUR), weekAt(70, NOW + 4 * DAY + HOUR)] })
  const { clock, session, forks } = await braked($, on, w, { config, forks: [{ fail: 'api-error' }] })
  await touch($, clock)
  await advanceTo(clock, NOW + HOUR + MIN)
  expect([forks.length, liftNotes(session)]).toEqual([1, []])
  await clock.advance(2 * MIN)
  expect(forks.length).toBe(3)
  expect(liftNotes(session).map(n => n.includes('"limit-stop\\" has lifted'))).toEqual([true])
  expect((await peekLifts($)).lifts?.holds['week-60-early']?.phase).toBe('stalled')
})

test('a lift check near a limit runs where a ping would not: the cache expired and usage past cache.ping.maxUsage', async ($, on) => {
  const config = {
    version: 1,
    cache: { ttl: '5m' },
    roles: {
      lead: {
        triggers: [
          { id: 'w90', when: { 'limit.seven_day': 90, 'limit.seven_day.resetsIn': '1d' }, do: [{ deny: ['Agent'] }], lift: { do: ['prompt'], times: 1 } },
          { id: 'warm', when: { 'cache.expiresIn': '4m' }, do: ['ping'], times: 3 },
        ],
      },
    },
  }
  const w = newWorld({ limits: [weekAt(92, NOW + DAY + HOUR)] })
  usageBottom(on, [WARM_READ])
  const { clock, forks } = await braked($, on, w, { config, forks: [{}] })
  await turn($, 'start')
  await step($, clock)
  expect(await agentDenied($)).toBeDefined()
  await mainTurnEnd($, clock)
  // `warm` fires a minute in, at 92 % against the ping's maxUsage of 90: no ping, then the cache expires.
  await advanceTo(clock, NOW + 30 * MIN)
  expect(forks).toEqual([])
  await advanceTo(clock, NOW + HOUR + MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('the lift check leaves the cache as it found it: pings, anchor and cold', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [{ read: 150_000, write: 0 }])
  const { clock, forks } = await braked($, on, w, { forks: [{ limits: [fiveAt(97, NOW + 7 * HOUR)] }] })
  await turn($, 'start')
  await step($, clock)
  expect(await agentDenied($)).toBeDefined()
  await mainTurnEnd($, clock)
  const before = (await peekLifts($)).cache
  expect(before?.anchor).not.toBeNull()
  await clock.advance(PAST_RESET)
  expect(forks.length).toBe(1)
  const after = (await peekLifts($)).cache
  expect([after?.pings, after?.anchor, after?.cold]).toEqual([before?.pings, before?.anchor, before?.cold])
})

test('a session with no figures yet (as after --resume) holds nothing until the first response', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = newWorld({ limits: [] })
  const { clock } = await braked($, on, w)
  await clock.advance(10 * MIN)
  expect((await peekLifts($)).lifts?.holds ?? {}).toEqual({})
  w.limits = [fiveAt(96, NOW + 2 * HOUR)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  expect(Object.keys((await peekLifts($)).lifts?.holds ?? {})).toEqual(['stop'])
})

test('a hot reload with the same config keeps holds and attempts; a role change drops them', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const config = { version: 1, roles: { lead: STOP().roles.lead, other: {} } }
  const { clock } = await braked($, on, w, { config, forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  const kept = (await peekLifts($)).lifts
  expect(kept?.attempts).toEqual({ stop: 1 })
  await start($)
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
  expect((await peekLifts($)).lifts?.holds.stop?.touchedAt).toBe(kept?.holds.stop?.touchedAt ?? -1)
  await ctxGuard($, 'role other')
  await clock.advance(MIN)
  const after = (await peekLifts($)).lifts as unknown as { role: string; attempts: Record<string, number>; holds: Record<string, unknown> }
  expect([after.role, after.attempts, Object.keys(after.holds).includes('stop')]).toEqual(['other', {}, false])
})

test('a role change to a role that writes no lifts and back still drops the first role\'s lifts', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const config = { version: 1, roles: { lead: STOP().roles.lead, other: { triggers: [{ id: 'ctx', when: { context: '90%' }, do: ['note'] }] } } }
  const { clock } = await braked($, on, w, { config, forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
  await ctxGuard($, 'role other')
  await clock.advance(MIN)
  await ctxGuard($, 'role lead')
  await clock.advance(MIN)
  const back = (await peekLifts($)).lifts
  expect([back?.attempts, back?.holds.stop?.touchedAt ?? null]).toEqual([{}, null])
})

test('operator input resets the wake count; a restart\'s resume does not', async ($, on) => {
  const w = brakeWorld()
  let reset = NOW + 2 * HOUR
  const { clock, forks } = await braked($, on, w, {
    config: STOP({ do: ['note', 'prompt'], times: 1 }),
    forks: () => {
      reset += 5 * HOUR
      return { limits: [fiveAt(96, reset)] }
    },
  })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(forks.length).toBe(1)
  await $.command.run({ command: 'ctx-guard:resume', args: 'role=lead', origin: CTX_GUARD as never, presentation: { isFullscreen: false, columns: 120 } })
  await clock.advance(5 * HOUR)
  expect(forks.length).toBe(1)
  // The operator speaks, the next response brakes again, and the brake touches the work.
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' } } as never)
  w.limits = [fiveAt(96, NOW + 12 * HOUR - MIN)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  await touch($, clock)
  await advanceTo(clock, NOW + 12 * HOUR)
  expect(forks.length).toBe(2)
})

test('a lift found by a measure while idle is judged at once', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w)
  await touch($, clock)
  await clock.advance(30_000)
  w.limits = [fiveAt(40, NOW + 2 * HOUR)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.settle()
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

const STOP2 = (lift: unknown) => ({ id: 'stop2', when: { 'limit.five_hour': 90 }, do: [{ deny: ['Agent'] }], lift })

test('stacked brakes lift together: one note message, one check, one prompt from the first in config order, one attempt', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w, { config: STOP(undefined, [STOP2({ do: ['note', 'prompt'], times: 2 })]) })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(forks.length).toBe(1)
  expect(wakePrompts(w).map(p => p.includes('"stop"'))).toEqual([true])
  expect(liftNotes(session).map(n => n.includes('\\"stop2\\" has lifted'))).toEqual([true])
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
})

test('a trigger past lift.times beside another whose prompt goes: no "Not woken" notify for it', async ($, on) => {
  const w = brakeWorld()
  let n = 0
  const { clock, forks } = await braked($, on, w, {
    config: STOP({ do: ['note', 'prompt'], times: 1 }, [STOP2({ do: ['prompt'], times: 3 })]),
    forks: () => (n++ === 0 ? { limits: [fiveAt(96, NOW + 7 * HOUR)] } : { limits: [fiveAt(10, NOW + 12 * HOUR)] }),
  })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  await advanceTo(clock, NOW + 7 * HOUR + MIN)
  expect(forks.length).toBe(2)
  expect(wakePrompts(w).map(p => p.includes('"stop2"'))).toEqual([true])
  expect(w.notifies).toEqual([])
})

test('past lift.times with notify in lift.do: one notify', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { config: STOP({ do: ['notify', 'prompt'], times: 1 }), forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(w.notifies).toEqual([])
  await advanceTo(clock, NOW + 7 * HOUR + MIN)
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: lift.times is spent.'])
})

test('lift.do notify and prompt with the prompt turned into a notify: one notification', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { config: STOP({ do: ['notify', 'prompt'], times: 1 }), trust: false })
  await touch($, clock)
  await clock.advance(PAST_RESET)
  expect(w.notifies.length).toBe(1)
})

const SQUEEZE = { id: 'squeeze', when: { context: '85%' }, do: ['compact'] }

test('a compact queued and free at the turn end runs before the lift is judged', async ($, on) => {
  const w = brakeWorld()
  let compactedFirst: boolean | null = null
  const { clock, forks } = await braked($, on, w, {
    config: STOP(undefined, [SQUEEZE]),
    forks: () => {
      compactedFirst = compacts(w).length === 1
      return { limits: [fiveAt(10, NOW + 7 * HOUR)] }
    },
  })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR - MIN)
  await turn($, 'start')
  await measure($, w, 900_000)
  await clock.advance(2 * MIN)
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([compacts(w).length, forks.length, wakePrompts(w).length, compactedFirst]).toEqual([1, 1, 1, true])
})

test('a compact queued at the turn end and still busy does not hold the lift back', async ($, on) => {
  const w = brakeWorld({ agents: [{ id: 'a1', status: 'running', description: 'x', type: 'general-purpose' }] })
  const { clock, forks } = await braked($, on, w, { config: STOP(undefined, [SQUEEZE]) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR - MIN)
  await turn($, 'start')
  await measure($, w, 900_000)
  await clock.advance(2 * MIN)
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([compacts(w).length, forks.length, wakePrompts(w).length]).toEqual([0, 1, 1])
})

test('a compact queued while the wake prompt waits unsent goes first; the lift is judged again from the start after it', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { config: STOP(undefined, [SQUEEZE]), forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  // A turn that is not the operator's starts while the fork is out; the check frees the tools, the prompt waits.
  await turn($, 'start')
  await clock.advance(MIN)
  await measure($, w, 900_000)
  await mainTurnEnd($, clock)
  expect(compacts(w).length).toBe(1)
  // The same attempt: a second check (it too takes 30s), then the prompt.
  await clock.advance(2 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
})

test('a compact that drops the pending wake prompt charges no second attempt: lift.times 1 still wakes', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, {
    config: STOP({ do: ['note', 'prompt'], times: 1 }, [SQUEEZE]),
    forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }],
  })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await turn($, 'start')
  await clock.advance(MIN)
  await measure($, w, 900_000)
  await mainTurnEnd($, clock)
  expect(compacts(w).length).toBe(1)
  await clock.advance(2 * MIN)
  expect([forks.length, wakePrompts(w).length, w.notifies]).toEqual([2, 1, []])
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
})

test('a wake prompt refused three times drops the compact that waited for it', async ($, on) => {
  const w = brakeWorld({ dropPrompt: 'refused by another plugin' })
  const { clock } = await braked($, on, w, { config: STOP(undefined, [SQUEEZE]) })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(wakePrompts(w).length).toBe(1)
  await measure($, w, 900_000)
  await clock.settle()
  expect(compacts(w)).toEqual([])
  await clock.advance(3 * MIN)
  expect(wakePrompts(w).length).toBe(3)
  expect(w.toasts).toContain('ctx-guard: the queued /compact for trigger "squeeze" was dropped: the wake prompt was refused 3 times.')
  expect(compacts(w)).toEqual([])
})

test('a lift while a trigger prompt waits for its retry: the wake waits for the next idle tick', async ($, on) => {
  const w = brakeWorld()
  const config = STOP(undefined, [{ id: 'away', when: { idle: '2h' }, do: ['prompt'], times: 1, message: 'Away.' }])
  const { clock, forks } = await braked($, on, w, { config })
  await touch($, clock)
  w.dropPrompt = 'refused by another plugin'
  // `away` fires at 2h and is refused; the brake lifts on the same tick.
  await advanceTo(clock, NOW + 2 * HOUR)
  expect([w.prompts, forks.length]).toEqual([['Away.'], 0])
  w.dropPrompt = null
  // The next tick tries `away` first; its retry slot free, the lift is judged after it.
  await clock.advance(MIN)
  expect(w.prompts.slice(0, 2)).toEqual(['Away.', 'Away.'])
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('a lift held back whose tool another brake starts denying mid-turn: no "allowed again" note until that brake lets go', async ($, on) => {
  const w = brakeWorld()
  const week = { id: 'week', when: { 'limit.seven_day': 90 }, do: [{ deny: ['Agent'] }] }
  const config = STOP(undefined, [{ id: 'away', when: { idle: '2h' }, do: ['prompt'], times: 1, message: 'Away.' }, week])
  const { clock, session } = await braked($, on, w, { config })
  await touch($, clock)
  w.dropPrompt = 'refused by another plugin'
  // `away` is refused at 2h and holds the wake back; the brake lets go on the same tick.
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(liftNotes(session)).toEqual([])
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  w.limits = [fiveAt(10, NOW + 7 * HOUR), weekAt(96, NOW + 3 * DAY)]
  await measure($, w, 100_000)
  await clock.settle()
  expect(liftNotes(session)).toEqual([])
  expect(await agentDenied($)).toContain('trigger "week"')
  w.limits = [fiveAt(10, NOW + 7 * HOUR), weekAt(50, NOW + 3 * DAY)]
  await measure($, w, 110_000)
  await clock.settle()
  expect(liftNotes(session).map(n => n.includes('"stop\\" has lifted'))).toEqual([true])
})

test('a trigger prompt and compact arising while a wake prompt waits to retry: the wake goes, then the prompt, then the compact after its turn', async ($, on) => {
  const w = brakeWorld({ dropPrompt: 'refused by another plugin' })
  const config = STOP(undefined, [{ id: 'away', when: { idle: '121m' }, do: ['prompt', 'compact'], times: 1, message: 'Away.' }])
  const { clock } = await braked($, on, w, { config })
  await touch($, clock)
  // The wake prompt is refused at 2h; `away` fires at 2h1m and waits for the lift work.
  await advanceTo(clock, NOW + 2 * HOUR + MIN)
  expect([w.prompts.includes('Away.'), compacts(w)]).toEqual([false, []])
  w.dropPrompt = null
  const refused = w.prompts.length
  // The next tick sends the wake prompt; `away` waits for the tick after.
  await clock.advance(MIN)
  expect(w.prompts.length).toBe(refused + 1)
  expect(wakePrompts(w)).toEqual(w.prompts)
  await clock.advance(MIN)
  expect(w.prompts.slice(refused + 1)).toEqual(['Away.'])
  expect(compacts(w)).toEqual([])
  // The compact goes once the prompt's turn ends.
  await turn($, 'start')
  await mainTurnEnd($, clock)
  expect(compacts(w).length).toBe(1)
})

test('a trigger prompt rising on the lift check\'s fresh figures waits for the next idle tick: one own prompt at a time', async ($, on) => {
  const w = brakeWorld()
  const config = STOP(undefined, [{ id: 'week', when: { 'limit.seven_day': 75 }, do: ['prompt'], times: 1, message: 'Week.' }])
  const { clock } = await braked($, on, w, { config, forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR), weekAt(80, NOW + 3 * DAY)] }] })
  await touch($, clock)
  // The check answers at 2h with the weekly window at 80 %: `week` rises on those figures and waits.
  await advanceTo(clock, NOW + 2 * HOUR)
  expect([w.prompts.length, wakePrompts(w).length]).toEqual([1, 1])
  await clock.advance(MIN)
  expect(w.prompts.slice(1)).toEqual(['Week.'])
})

test('operator input that lands while an idle tick is about to send the waiting wake prompt → no prompt; a toast and the note', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  // A non-operator turn runs while the check answers: the wake prompt waits for the next idle tick.
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  await mainTurnEnd($, clock)
  // The next tick's reading takes a second; the operator types meanwhile, ahead of the drop their input schedules.
  w.usageHang = 1000
  await clock.advance(MIN)
  w.usageHang = 0
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  await clock.advance(1000)
  expect(wakePrompts(w)).toEqual([])
  expect(w.toasts).toContain('ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again.')
  expect(liftNotes(session).length).toBe(1)
})

test('a waiting wake prompt whose trigger reads unknown fails a try on each idle tick; the third stalls it with the failed notify', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  // A non-operator turn runs while the check answers: the wake prompt waits for the next idle tick.
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  expect((await peekLifts($)).lifts?.pending).not.toBeNull()
  // The usage report stops naming the five-hour window: the trigger reads unknown.
  w.limits = []
  await mainTurnEnd($, clock)
  await clock.advance(5 * MIN)
  expect(wakePrompts(w)).toEqual([])
  expect(w.notifies).toEqual([
    'ctx-guard: "stop" may have lifted, but fresh usage could not be read (the window may still be full). Not woken; ctx-guard tries again when usage is next reported or the window resets.',
  ])
  const p = await peekLifts($)
  expect([p.lifts?.pending, p.lifts?.holds.stop?.phase]).toEqual([null, 'stalled'])
})

test('an operator /clear while the wake prompt waits → no prompt; the toast and the note come after the clear, not before it', async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  // A non-operator turn runs while the check answers: the wake prompt waits for the next idle tick.
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  await mainTurnEnd($, clock)
  // The operator clears before that tick: nothing is appended to the context the /clear wipes.
  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  await clock.settle()
  expect(liftNotes(session)).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.settle()
  expect(liftNotes(session)).toEqual([])
  await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
  await clock.settle()
  expect(wakePrompts(w)).toEqual([])
  expect(w.toasts).toContain('ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again.')
  expect(liftNotes(session).length).toBe(1)
  await clock.advance(5 * MIN)
  expect([wakePrompts(w).length, liftNotes(session).length]).toEqual([0, 1])
})

test('a restart\'s own /clear while the wake prompt waits → no prompt into the new context; the lift note goes there', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock, session } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  // A non-operator turn runs while the check answers: the wake prompt waits for the next idle tick.
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  await mainTurnEnd($, clock)
  expect((await peekLifts($)).lifts?.pending).not.toBeNull()
  // ctx-guard's own restart clears before that tick: the /clear comes from the plugin, not the operator.
  await $.command.run({ command: 'clear', args: '', origin: { kind: 'plugin', name: 'ctx-guard' } as never, presentation: { isFullscreen: false, columns: 120 } })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.advance(5 * MIN)
  expect(wakePrompts(w)).toEqual([])
  expect(w.toasts.filter(t => t.includes('lifted'))).toEqual([])
  expect(liftNotes(session).length).toBe(1)
  const p = await peekLifts($)
  expect([p.lifts?.pending, p.lifts?.holds.stop]).toEqual([null, undefined])
})

test('a ping after a hot reload during the lift check\'s fork waits until that fork is no longer out', async ($, on) => {
  const w = brakeWorld()
  writeConfig(w, { ...STOP(undefined, [{ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 }]), cache: { ttl: '1h' } })
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [WARM_READ])
  const forks: string[] = []
  let n = 0
  liftForkBottom(on, w, clock, () => (n++ === 0 ? { limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 10 * MIN } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }), forks)
  await start($)
  await ctxGuard($, 'trust')
  // The touch reads a warm cache at 1h6m30s: it expires at 2h6m30s, and `warm` fires at 2h1m.
  await advanceTo(clock, NOW + HOUR + 6 * MIN + 30_000)
  await turn($, 'start')
  expect(await agentDenied($)).toContain('is blocked by trigger')
  await step($, clock)
  await mainTurnEnd($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(forks.length).toBe(1)
  await start($)
  await clock.advance(MIN)
  expect(forks.length).toBe(1)
})

test('a lift check after a hot reload during a keep-warm ping\'s fork waits until that fork is no longer out', async ($, on) => {
  const w = brakeWorld()
  writeConfig(w, { ...STOP(undefined, [{ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 }]), cache: { ttl: '1h', ping: { maxUsage: 99 } } })
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [WARM_READ])
  const forks: string[] = []
  let n = 0
  liftForkBottom(on, w, clock, () => (n++ === 0 ? { hang: 3 * MIN } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }), forks)
  await start($)
  await ctxGuard($, 'trust')
  // The touch reads a warm cache at 1h4m30s: it expires at 2h4m30s, and `warm` pings at 1h59m.
  await advanceTo(clock, NOW + HOUR + 4 * MIN + 30_000)
  await turn($, 'start')
  expect(await agentDenied($)).toContain('is blocked by trigger')
  await step($, clock)
  await mainTurnEnd($, clock)
  await advanceTo(clock, NOW + HOUR + 59 * MIN)
  expect(forks.length).toBe(1)
  // A reload while the ping's fork is out, until 2h2m; the brake lets go at the new copy's first tick, 2h0m30s.
  await clock.advance(30_000)
  await start($)
  await advanceTo(clock, NOW + 2 * HOUR + 30_000)
  expect(forks.length).toBe(1)
  // Its timeout passes at 2h1m: the next tick checks.
  await advanceTo(clock, NOW + 2 * HOUR + MIN + 30_000)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
})

test('a compact whose quiet hold ends while the lift check\'s fork is out waits for that work', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { config: STOP(undefined, [SQUEEZE]), forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 90_000 }] })
  await touch($, clock)
  // A compact runs at 1h56m; a new edge right after it is held until 2h1m.
  await advanceTo(clock, NOW + 2 * HOUR - 4 * MIN)
  await measure($, w, 900_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 900_000)
  await clock.settle()
  expect(compacts(w).length).toBe(1)
  // The check forks at 2h and answers at 2h1m30s; the hold ends between.
  await advanceTo(clock, NOW + 2 * HOUR + MIN)
  await clock.advance(1000)
  expect([forks.length, compacts(w).length]).toEqual([1, 1])
  await clock.advance(2 * MIN)
  expect([wakePrompts(w).length, compacts(w).length]).toEqual([1, 2])
})

test('keep-warm after a passed reset: a ping goes on the rolled-over 0 %', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [fiveAt(92, NOW + 10 * MIN)] })
  const { clock, forks } = await trustedKeepWarm($, on, w)
  await clock.advance(55 * MIN)
  expect(forks.length).toBe(1)
})

test('the brake\'s note read by a later main step touches the hold: the lift wakes with no refused call', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [{ read: 100_000, write: 0 }])
  const { clock, forks } = await braked($, on, w)
  await turn($, 'start')
  await clock.advance(1000)
  await step($, clock)
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

// The five-hour brake with no lift: a reload adds one while it holds.
const STOP_NO_LIFT = { version: 1, roles: { lead: { triggers: [{ id: 'stop', when: { 'limit.five_hour': 95 }, do: ['note', { deny: ['Agent'] }], level: 'stop' }] } } }

test('a reload adds the lift while the brake holds: its note, read before the reload, touches the new hold and the lift wakes', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [{ read: 100_000, write: 0 }])
  const { clock, forks } = await braked($, on, w, { config: STOP_NO_LIFT })
  await turn($, 'start')
  await clock.advance(1000)
  await step($, clock)
  await mainTurnEnd($, clock)
  writeConfig(w, STOP())
  await ctxGuard($, 'reload')
  await ctxGuard($, 'trust')
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('a reload adds the lift while the brake holds, its note never read: no wake', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { config: STOP_NO_LIFT })
  writeConfig(w, STOP())
  await ctxGuard($, 'reload')
  await ctxGuard($, 'trust')
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
})

test('a step that went out before the note was appended reads nothing: no touch', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [{ read: 100_000, write: 0 }])
  const { clock, forks } = await braked($, on, w)
  await turn($, 'start')
  await step($, clock)
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length]).toEqual([0, 0])
})

test('a pause during the hold that ends before the lift: the real lift after it wakes once', async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w)
  await touch($, clock)
  await ctxGuard($, 'pause 1h')
  await clock.advance(PAST_RESET)
  expect([forks.length, wakePrompts(w).length, w.notifies]).toEqual([1, 1, []])
  await clock.advance(10 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('a pause during the lift check\'s fork → a notify "ctx-guard is paused", no prompt', async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await ctxGuard($, 'pause 1h')
  await clock.advance(MIN)
  expect(wakePrompts(w)).toEqual([])
  expect(w.notifies).toEqual(['ctx-guard: "stop" lifted (the 5-hour usage window reset); Agent allowed again. Not woken: ctx-guard is paused.'])
})

test('a .resetsIn lift on the timer with no usage report: 4d1m left holds, 3d59m left wakes once', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const config = { version: 1, roles: { lead: { triggers: [{ id: 'w60', when: { 'limit.seven_day': 60, 'limit.seven_day.resetsIn': '4d' }, do: ['note', { deny: ['Agent'] }], lift: { do: ['note', 'prompt'], times: 1 } }] } } }
  const w = newWorld({ limits: [weekAt(70, NOW + 4 * DAY + 5 * MIN)] })
  const { clock, forks } = await braked($, on, w, { config, forks: [{}] })
  await touch($, clock)
  await advanceTo(clock, NOW + 4 * MIN)
  expect([(await peekLifts($)).lifts?.holds.w60?.phase, forks.length]).toEqual(['holding', 0])
  await advanceTo(clock, NOW + 6 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
  await clock.advance(10 * MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

test('a lift while a keep-warm ping holds the fork slot: the check waits until the ping settles', async ($, on) => {
  const w = brakeWorld()
  writeConfig(w, { ...STOP(undefined, [{ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 1 }]), cache: { ttl: '1h', ping: { maxUsage: 99 } } })
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [WARM_READ])
  const forks: string[] = []
  let n = 0
  liftForkBottom(on, w, clock, () => (n++ === 0 ? { hang: 90_000 } : { limits: [fiveAt(10, NOW + 7 * HOUR)] }), forks)
  await start($)
  await ctxGuard($, 'trust')
  // The touch reads a warm cache at 1h4m30s: it expires at 2h4m30s, and `warm` pings at 1h59m.
  await advanceTo(clock, NOW + HOUR + 4 * MIN + 30_000)
  await turn($, 'start')
  expect(await agentDenied($)).toContain('is blocked by trigger')
  await step($, clock)
  await mainTurnEnd($, clock)
  // The brake lets go at 2h, while the ping's fork is out until 2h0m30s.
  await advanceTo(clock, NOW + 2 * HOUR)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 0])
  await advanceTo(clock, NOW + 2 * HOUR + MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([2, 1])
})

test('a non-operator turn during the fork whose figures brake again: no prompt and no lift note; the rising edge notes it', async ($, on) => {
  const w = brakeWorld()
  const { clock, session, forks } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  const edges = (): number => notes(session).filter(n => n.includes('5-hour usage is at')).length
  const before = edges()
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  // The check freed the tools; the turn's own response finds the window full again.
  w.limits = [fiveAt(97, NOW + 7 * HOUR)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  await mainTurnEnd($, clock)
  await clock.advance(5 * MIN)
  expect([forks.length, wakePrompts(w).length, liftNotes(session).length, w.notifies.length, edges()]).toEqual([1, 0, 0, 0, before + 1])
})

test('a brake that holds on fresh figures with the cache expired: no band countdown, no cache.expiresIn fire and no ping', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [WARM_READ])
  const config = {
    ...STOP(undefined, [
      { id: 'expiring', when: { 'cache.expiresIn': '5m' }, do: ['note'], message: 'Cache expiring.' },
      { id: 'warm', when: { 'cache.expiresIn': '5m', idle: '100m' }, do: ['ping'], times: 3 },
    ]),
    cache: { ttl: '1h', ping: { maxUsage: 99 } },
  }
  const { clock, session, forks } = await braked($, on, w, { config, forks: [{ limits: [fiveAt(97, NOW + 7 * HOUR)] }], surface: 'vscode' })
  const expiring = (): number => notes(session).filter(n => n.includes('Cache expiring.')).length
  await turn($, 'start')
  await step($, clock)
  expect(await agentDenied($)).toBeDefined()
  await mainTurnEnd($, clock)
  // The cache expired at 1h, long before the brake lets go; `warm` skips the expired cache.
  await advanceTo(clock, NOW + 2 * HOUR - 2 * MIN)
  expect([expiring(), forks.length]).toEqual([1, 0])
  expect(bandOfWorld(w)).toContain('cache cold')
  // The check at 2h holds the brake; an hour later the cache still reads expired.
  await advanceTo(clock, NOW + 3 * HOUR + 5 * MIN)
  expect([forks.length, wakePrompts(w).length, expiring()]).toEqual([1, 0, 1])
  expect(bandOfWorld(w)).toContain('cache cold')
})

test('the wake prompt\'s own request after the check restarts the cache countdown and counts no miss', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [WARM_READ, { read: 150_000, write: 0 }])
  const config = { ...STOP(undefined, [{ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] }]), cache: { ttl: '1h' } }
  const { clock } = await braked($, on, w, { config, surface: 'vscode' })
  await turn($, 'start')
  await step($, clock)
  expect(await agentDenied($)).toBeDefined()
  await mainTurnEnd($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(wakePrompts(w).length).toBe(1)
  expect(bandOfWorld(w)).toContain('cache cold')
  // The woken turn's request reads the prefix the fork wrote.
  await turn($, 'start')
  await step($, clock)
  await mainTurnEnd($, clock)
  await clock.advance(51 * MIN)
  expect(bandOfWorld(w)).toContain('cache 8m')
  expect(missToasts(w)).toEqual([])
})

test('a lift found by a measure while a trigger prompt waits for its retry: its note waits with it, and the wake carries it', async ($, on) => {
  const w = brakeWorld()
  const config = STOP(undefined, [{ id: 'away', when: { idle: '30m' }, do: ['prompt'], times: 1, message: 'Away.' }])
  const { clock, session, forks } = await braked($, on, w, { config })
  await touch($, clock)
  w.dropPrompt = 'refused by another plugin'
  await advanceTo(clock, NOW + 30 * MIN)
  expect(w.prompts).toEqual(['Away.'])
  // A usage report while idle lets the brake go; `away`'s retry holds the lift back.
  await clock.advance(30_000)
  w.limits = [fiveAt(40, ROLLS_AT)]
  await $.session.measure({ context: usageOf(w).context, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.settle()
  expect([forks.length, liftNotes(session).length]).toEqual([0, 0])
  w.dropPrompt = null
  await clock.advance(30_000)
  expect(w.prompts.slice(0, 2)).toEqual(['Away.', 'Away.'])
  expect([forks.length, wakePrompts(w).length, liftNotes(session).length]).toEqual([1, 1, 0])
})

test('a stalled hold leaves the stall on a main response with no measure: a new attempt at the next idle tick', async ($, on) => {
  const w = brakeWorld()
  usageBottom(on, [{ read: 100_000, write: 0 }])
  let fail = true
  const { clock, forks } = await braked($, on, w, { forks: () => (fail ? { fail: 'api-error' } : {}) })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR + 2 * MIN)
  expect([forks.length, w.notifies.length]).toEqual([3, 1])
  await clock.advance(10 * MIN)
  expect(forks.length).toBe(3)
  fail = false
  // A main turn whose response moves no percent: no session.measure fires.
  await turn($, 'start')
  await step($, clock)
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([4, 1])
})

test('keep-warm after a passed reset: cache.prompt.maxUsage reads the rolled-over 0 %, and the prompt goes', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [fiveAt(92, NOW + 10 * MIN)] })
  const config = CACHE_ROLE([{ id: 'away', when: { 'cache.expiresIn': '5m' }, do: ['prompt'], times: 1 }])
  const { clock } = await trustedKeepWarm($, on, w, { config })
  await clock.advance(55 * MIN)
  expect(ownPrompts(w).length).toBe(1)
})

test('a woken turn that ends with the ready token is judged as any turn: the restart runs', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const config = autoConfig()
  config.roles.lead.triggers = [...config.roles.lead.triggers, ...(STOP().roles.lead.triggers as never[])]
  const w = restartWorld({ limits: [fiveAt(96, ROLLS_AT)] })
  const { clock } = await braked($, on, w, { config })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  expect(wakePrompts(w).length).toBe(1)
  await turn($, 'start')
  w.files[HANDOFF] = { text: '# handoff\n', mtimeMs: clock.now() }
  await ready($, clock)
  expect(w.ran[0]).toBe('clear')
  await clock.settle()
  expect((await peekRestart($)).lastVerdict?.code).toBe('ok')
})

test('a hot reload keeps the pending wake prompt: it goes at the next idle tick with no new fork', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock, forks } = await braked($, on, w, { forks: [{ limits: [fiveAt(10, NOW + 7 * HOUR)], hang: 30_000 }] })
  await touch($, clock)
  await advanceTo(clock, NOW + 2 * HOUR)
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  const pending = (await peekLifts($)).lifts?.pending ?? null
  expect(pending).not.toBeNull()
  await start($)
  expect((await peekLifts($)).lifts?.pending).toEqual(pending)
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect([forks.length, wakePrompts(w).length]).toEqual([1, 1])
})

const RELOADED = { id: 'stop', when: { 'limit.five_hour': 95 }, do: ['note', { deny: ['Agent', 'WebFetch'] }], level: 'stop', lift: { do: ['note', 'prompt'], times: 2 } }

const RELOADED_ROLE = (t: unknown) => ({ version: 1, roles: { lead: { triggers: [t] } } })

for (const [what, changed] of [
  ['changes the trigger\'s when', { ...RELOADED, when: { 'limit.five_hour': 94 } }],
  ['removes the trigger\'s lift', { id: 'stop', when: { 'limit.five_hour': 95 }, do: ['note', { deny: ['Agent', 'WebFetch'] }], level: 'stop' }],
  ['removes one of the trigger\'s deny tools', { ...RELOADED, do: ['note', { deny: ['Agent'] }] }],
] as const) {
  test(`a reload that ${what}: the hold is dropped, no lift note, no wake`, { plugins: [PEEK_LIFTS] }, async ($, on) => {
    const w = brakeWorld()
    const { clock, session, forks } = await braked($, on, w, { config: RELOADED_ROLE(RELOADED) })
    await touch($, clock)
    expect((await peekLifts($)).lifts?.holds.stop?.touchedAt).not.toBeNull()
    writeConfig(w, RELOADED_ROLE(changed))
    await start($)
    await clock.advance(MIN)
    expect((await peekLifts($)).lifts?.holds.stop?.touchedAt ?? null).toBeNull()
    expect([liftNotes(session).length, w.notifies.length]).toEqual([0, 0])
    await clock.advance(PAST_RESET)
    expect([forks.length, wakePrompts(w).length, w.notifies.length]).toEqual([0, 0, 0])
  })
}

test('deny reason: no wake tail with autoActions off', { options: { autoActions: false } }, async ($, on) => {
  const w = brakeWorld()
  await braked($, on, w)
  expect(await agentDenied($)).toContain('Agent comes free in 2h. If you need Agent now')
})

test('deny reason: no wake tail once lift.times is spent', { plugins: [PEEK_LIFTS] }, async ($, on) => {
  const w = brakeWorld()
  const { clock } = await braked($, on, w, { config: STOP({ do: ['note', 'prompt'], times: 1 }), forks: [{ limits: [fiveAt(96, NOW + 7 * HOUR)] }] })
  expect(await agentDenied($)).toContain('set to prompt you')
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect((await peekLifts($)).lifts?.attempts).toEqual({ stop: 1 })
  expect(await agentDenied($)).toContain('Agent comes free in 5h. If you need Agent now')
})

test('deny reason: no deny while paused, so no wake tail either', async ($, on) => {
  const w = brakeWorld()
  await braked($, on, w)
  await ctxGuard($, 'pause 1h')
  expect(await agentDenied($)).toBeUndefined()
})
