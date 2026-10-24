import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock, MockSession } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NOW, HOUR, MIN, newWorld, world, writeConfig, start, ctxGuard, turn, mainTurnEnd } from './register.fixtures'
import type { Limit, World } from './register.fixtures'

// ---- /ctx-guard wake: a wake the operator sets for a usage window's reset ----------

const iso = (ms: number): string => new Date(ms).toISOString()

const fiveAt = (pct: number, resetsAt: number): Limit => ({ kind: 'five_hour', percentUsed: pct, resetsAt: iso(resetsAt) })

const weekAt = (pct: number, resetsAt: number): Limit => ({ kind: 'seven_day', percentUsed: pct, resetsAt: iso(resetsAt) })

// The five-hour window resets at 1h; it reads as rolled over a minute later.
const RESETS_AT = NOW + HOUR
const PAST_RESET = HOUR + 2 * MIN

const DAY = 24 * HOUR

// A role with no trigger at all: the wake needs none. `prompt` asks for trust.
const CONFIG = { version: 1, roles: { lead: { triggers: [{ id: 'away', when: { idle: '9h' }, do: ['prompt'], times: 1 }] }, reviewer: {} } }

const wakes = (w: World): string[] => w.prompts.filter(p => p.includes('/ctx-guard wake'))

// A trusted lead with the five-hour window at `pct`; each lift check's fork reports `after`, `hang` ms after it starts.
async function lead($: Engine, on: On, pct = 60, after: Limit[] = [fiveAt(3, NOW + 7 * HOUR)], config: unknown = CONFIG, hang = 0): Promise<{ w: World; clock: MockClock; session: MockSession; forks: string[] }> {
  const w = newWorld({ limits: [fiveAt(pct, RESETS_AT), weekAt(40, NOW + 3 * 24 * HOUR)] })
  writeConfig(w, config)
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  const forks: string[] = []
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    if (hang > 0) await clock.sleep(hang)
    w.limits = after
    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 13, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  await start($)
  await ctxGuard($, 'trust')
  return { w, clock, session, forks }
}

test('/ctx-guard wake 5h: set with the reset time; at the reset one lift check, then the default wake prompt', async ($, on) => {
  const { w, clock, forks } = await lead($, on)
  expect(await ctxGuard($, 'wake 5h')).toBe(
    '[ctx-guard] wake set: when the 5-hour usage window resets in 1h (2026-10-13 13:00 UTC), ctx-guard reads fresh usage and wakes this session with ' +
      'a prompt to check where the work stands and carry on. Anything you type first cancels it, as does /ctx-guard wake off; ' +
      '/clear, /compact, /ctx-guard:clear and a restart command leave it.',
  )
  await clock.advance(30 * MIN)
  expect(wakes(w)).toEqual([])
  await clock.advance(PAST_RESET - 30 * MIN)
  expect(forks.length).toBe(1)
  expect(wakes(w)).toEqual([
    '[ctx-guard] The operator asked with /ctx-guard wake to start once the usage window reset, and the 5-hour usage window reset. ' +
      'First check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. ' +
      'Then carry on with the work. If nothing is left to do, say so in one line and stop.',
  ])
  await clock.advance(10 * MIN)
  expect([forks.length, wakes(w).length]).toEqual([1, 1])
  expect(await ctxGuard($, '')).not.toContain('wake:')
})

test('/ctx-guard wake 7d with text: the wake prompt carries the text', async ($, on) => {
  const w = newWorld({ limits: [fiveAt(10, NOW + 3 * HOUR), weekAt(90, NOW + HOUR)] })
  writeConfig(w, CONFIG)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  on('model.fork', async () => {
    w.limits = [fiveAt(1, NOW + 7 * HOUR), weekAt(1, NOW + 8 * DAY)]
    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  await start($)
  await ctxGuard($, 'trust')
  expect(await ctxGuard($, 'wake 7d Run the nightly suite.')).toContain('weekly usage window resets in 1h')
  await clock.advance(PAST_RESET)
  expect(wakes(w)).toEqual(['[ctx-guard] The operator asked with /ctx-guard wake to start once the usage window reset, and the weekly usage window reset. Run the nightly suite.'])
})


test('/ctx-guard wake: a prompt the operator types first cancels it, with a toast', async ($, on) => {
  const { w, clock, forks } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await clock.advance(MIN)
  await $.prompt.submit({ text: 'never mind, I am here', origin: { kind: 'composer' } } as never)
  expect(w.toasts).toContain('ctx-guard: the wake after the 5-hour reset is cancelled: you are back.')
  await clock.advance(PAST_RESET)
  expect([forks.length, wakes(w).length]).toEqual([0, 0])
})

test('/ctx-guard wake: a command the operator types first cancels it; /ctx-guard itself does not', async ($, on) => {
  const { w, clock } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await ctxGuard($, '')
  expect(await ctxGuard($, '')).toContain('wake: after the 5-hour reset in 1h (2026-10-13 13:00 UTC); waiting for the reset')
  await $.command.run({ command: 'review', args: '', origin: { kind: 'bridge' } as never, presentation: { isFullscreen: false, columns: 120 } })
  await clock.advance(PAST_RESET)
  expect(wakes(w)).toEqual([])
})

for (const command of ['clear', 'compact']) {
  test(`/ctx-guard wake: the operator's /${command} leaves it`, async ($, on) => {
    const { w, clock } = await lead($, on)
    await ctxGuard($, 'wake 5h')
    await clock.advance(MIN)
    await $.command.run({ command, args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
    if (command === 'clear') {
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
      await clock.settle()
    }
    await clock.advance(PAST_RESET)
    expect(w.toasts.filter(t => t.includes('cancelled'))).toEqual([])
    expect(wakes(w).length).toBe(1)
  })
}

// /ctx-guard:clear and a role's restart command (the default /ctx-guard:resume too): the context action before stepping away.
const RESTART_CONFIG = { ...CONFIG, roles: { ...CONFIG.roles, lead: { ...CONFIG.roles.lead, restart: { command: 'restart-lead' } } } }

for (const command of ['ctx-guard:clear', 'restart-lead', 'ctx-guard:resume']) {
  test(`/ctx-guard wake: the operator's typed /${command} leaves it`, async ($, on) => {
    const { w, clock } = await lead($, on, 60, undefined, RESTART_CONFIG)
    await ctxGuard($, 'wake 5h')
    await clock.advance(MIN)
    await $.command.run({ command, args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
    await clock.settle()
    expect(w.toasts.filter(t => t.includes('cancelled'))).toEqual([])
    expect(await ctxGuard($, '')).toContain('wake: after the 5-hour reset')
  })
}

test('/ctx-guard wake: a peer session\'s message, and its turn, leave it', async ($, on) => {
  const { w, clock } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await clock.advance(MIN)
  await $.prompt.submit({ text: 'from the reviewer', origin: { kind: 'peer' } } as never)
  await turn($, 'start')
  await mainTurnEnd($, clock)
  await clock.advance(PAST_RESET)
  expect(wakes(w).length).toBe(1)
})

// The lift check's fork hangs 30 s; a turn that starts while it runs leaves the wake prompt waiting for the turn's end.
async function wakeWaiting($: Engine, on: On): Promise<{ w: World; clock: MockClock }> {
  const { w, clock, forks } = await lead($, on, 60, undefined, CONFIG, 30_000)
  await ctxGuard($, 'wake 5h')
  await clock.advance(HOUR)
  for (let i = 0; i < 30 && !forks.length; i++) await clock.advance(10_000)
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await turn($, 'start')
  await clock.advance(MIN)
  expect(await ctxGuard($, '')).toContain('the wake prompt waits for an idle moment')
  return { w, clock }
}

const leaveWaiting: [string, ($: Engine) => Promise<unknown>][] = [
  ['the operator\'s /compact', $ => $.command.run({ command: 'compact', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })],
  ['a peer session\'s message', $ => $.prompt.submit({ text: 'from the reviewer', origin: { kind: 'peer' } } as never)],
  ['an SDK host\'s command', $ => $.command.run({ command: 'review', args: '', origin: { kind: 'sdk' } as never, presentation: { isFullscreen: false, columns: 120 } })],
]

for (const [what, input] of leaveWaiting) {
  test(`/ctx-guard wake: ${what} leaves its waiting prompt, which goes at the turn's end`, async ($, on) => {
    const { w, clock } = await wakeWaiting($, on)
    await input($)
    await clock.settle()
    await mainTurnEnd($, clock)
    await clock.advance(MIN)
    expect(w.toasts.filter(t => t.includes('/ctx-guard wake'))).toEqual([])
    expect(wakes(w).length).toBe(1)
  })
}

test('/ctx-guard wake: a prompt the operator types cancels its waiting prompt too', async ($, on) => {
  const { w, clock } = await wakeWaiting($, on)
  await $.prompt.submit({ text: 'I am here', origin: { kind: 'composer' }, turnId: 't1' } as never)
  await clock.settle()
  expect(w.toasts).toContain('ctx-guard: the wake after the 5-hour reset is cancelled: you are back.')
  await mainTurnEnd($, clock)
  await clock.advance(MIN)
  expect(wakes(w)).toEqual([])
})

test('/ctx-guard wake off cancels it', async ($, on) => {
  const { w, clock } = await lead($, on)
  expect(await ctxGuard($, 'wake off')).toBe('[ctx-guard] no wake is set.')
  await ctxGuard($, 'wake 5h')
  expect(await ctxGuard($, 'wake off')).toBe('[ctx-guard] wake cancelled.')
  await clock.advance(PAST_RESET)
  expect(wakes(w)).toEqual([])
})

test('/ctx-guard wake: paused at the reset, a notify and no prompt', async ($, on) => {
  const { w, clock, forks } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await clock.advance(HOUR - 10 * MIN)
  await ctxGuard($, 'pause 1h')
  await clock.advance(15 * MIN)
  expect([forks.length, wakes(w).length]).toEqual([0, 0])
  expect(w.notifies).toEqual(['ctx-guard: "/ctx-guard wake" lifted (the 5-hour usage window reset). Not woken: ctx-guard is paused.'])
  await clock.advance(HOUR)
  expect(wakes(w)).toEqual([])
})

test('/ctx-guard wake untrusted: set with a warning; at the reset a notify and no prompt', async ($, on) => {
  const w = newWorld({ limits: [fiveAt(60, RESETS_AT)] })
  writeConfig(w, { version: 1, roles: { lead: {} } })
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'wake 5h')).toEndWith('Note: the repo is not trusted now, so the wake would only notify you.')
  expect(await ctxGuard($, '')).toContain('trust: not approved')
  await clock.advance(PAST_RESET)
  expect(wakes(w)).toEqual([])
  expect(w.notifies).toEqual(['ctx-guard: "/ctx-guard wake" lifted (the 5-hour usage window reset). Not woken: the repo is not trusted.'])
})

test('/ctx-guard wake survives a /clear and a reload', async ($, on) => {
  const { w, clock } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.settle()
  await ctxGuard($, 'reload')
  await clock.advance(PAST_RESET)
  expect(wakes(w).length).toBe(1)
})

test('/ctx-guard wake: a role change drops it', async ($, on) => {
  const { w, clock } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await ctxGuard($, 'role reviewer')
  await ctxGuard($, 'role lead')
  await clock.advance(PAST_RESET)
  expect(wakes(w)).toEqual([])
})

test('/ctx-guard wake with blocking off still wakes', { options: { blocking: false } }, async ($, on) => {
  const { w, clock } = await lead($, on)
  await ctxGuard($, 'wake 5h')
  await clock.advance(PAST_RESET)
  expect(wakes(w).length).toBe(1)
})

test('/ctx-guard wake: a new window already at or over the usage it was set at is the reset, and the wake prompt goes', async ($, on) => {
  const { w, clock, forks } = await lead($, on, 6, [fiveAt(8, NOW + 6 * HOUR)])
  await ctxGuard($, 'wake 5h')
  await clock.advance(PAST_RESET)
  expect(forks.length).toBe(1)
  expect(wakes(w)).toEqual([expect.stringContaining('/ctx-guard wake to start once the usage window reset, and the 5-hour usage window reset.')])
  expect(await ctxGuard($, '')).not.toContain('wake:')
})

test('/ctx-guard wake: the check finds the window with no reset time still at its usage, so the wake waits for the next reset', async ($, on) => {
  const { w, clock, forks } = await lead($, on, 60, [{ kind: 'five_hour', percentUsed: 70 }])
  await ctxGuard($, 'wake 5h')
  await clock.advance(PAST_RESET)
  expect([forks.length, wakes(w).length]).toEqual([1, 0])
  expect(await ctxGuard($, '')).toContain('wake: after the 5-hour reset')
})

test('/ctx-guard wake is refused with no figures, below 5 %, a bad window, no role, and not typed by the person', async ($, on) => {
  const w = newWorld({ limits: [fiveAt(3, RESETS_AT)] })
  writeConfig(w, CONFIG)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'wake 7d')).toBe('[ctx-guard] no weekly usage figures yet; try again after the next reply; nothing changed.')
  expect(await ctxGuard($, 'wake 5h')).toBe('[ctx-guard] the 5-hour usage window is at 3%; under 5% its reset frees next to nothing; nothing changed.')
  expect(await ctxGuard($, 'wake 5h', 'plugin')).toBe('[ctx-guard] only the operator can run /ctx-guard wake; ask the operator to type it. Nothing changed.')
  expect(await ctxGuard($, 'wake 3h')).toContain('wake takes 5h, 7d or off, not "3h"')
  await ctxGuard($, 'role none')
  expect(await ctxGuard($, 'wake 5h')).toBe('[ctx-guard] this session has no role, so nothing can wake it; nothing changed.')
})
