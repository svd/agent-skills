import { expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import {
  NOW,
  ROOT,
  TEAM,
  HOUR,
  PRESET_TEXT,
  newWorld,
  world,
  writeConfig,
  start,
  measure,
  step,
  ctxGuard,
  notes,
  PEEK,
  peek,
  AGENT,
  agentDenied,
  LEAD_SOFT,
  LEAD_BRAKE,
  stepBottom,
  run,
  WIPE,
  wipeState,
  turn,
} from './register.fixtures'
import type {
  World,
} from './register.fixtures'

const LOCAL = `${ROOT}/.claude/ctx-guard.local.json`

const GITIGNORE = `${ROOT}/.gitignore`

test('zero-config: toasts past 50% context, never a note', async ($, on) => {
  const w = newWorld({ tokens: 100_000 })
  const { session } = world(on, w)
  await start($)
  await measure($, w, 600_000)
  expect(w.toasts.some(t => t.includes('context 600k (60% of 1M)'))).toBe(true)
  expect(notes(session)).toEqual([])
  expect(w.registered).toEqual(['ctx-guard'])
})

test('role from env: one note on the rising edge, none while held', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 250_000)
  expect(notes(session)).toEqual([])
  await measure($, w, 310_000)
  await measure($, w, 320_000)
  const sent = notes(session)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('[ctx-guard] Context is at 310k')
})

test('a main-loop step past the threshold notes mid-turn; a subagent step does not', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  let stepTokens = 310_000
  stepBottom(on, () => stepTokens)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  expect(notes(session)).toEqual([])
  await step($, clock)
  expect(notes(session).length).toBe(1)
  expect(notes(session)[0]).toContain('Context is at 310k')
  stepTokens = 330_000
  await step($, clock)
  expect(notes(session).length).toBe(1)
  // The step's fill is newer than usage() (still 100k): a tick must not drop the mark.
  await clock.advance(60 * 1000)
  stepTokens = 340_000
  await step($, clock)
  expect(notes(session).length).toBe(1)
})

test('marks survive a reload: no second note for the same crossing', { plugins: [PEEK] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  // A hot reload fires session.start again with module state rebuilt.
  const marks = (await peek($)).marks
  expect(marks?.byId.soft?.step).toBe(0)
  await start($)
  expect((await peek($)).marks).toEqual(marks)
  await measure($, w, 320_000)
  expect(notes(session).length).toBe(1)
})

test('/clear re-arms every trigger', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await measure($, w, undefined)
  expect(notes(session).length).toBe(1)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(2)
  expect(await ctxGuard($, '')).toContain('last /clear: 0s ago')
})

const noteToasts = (w: World): string[] => w.toasts.filter(t => t.startsWith('ctx-guard → model'))

const LEAD_SOFT_TOAST = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'soft', when: { context: '300k' }, do: ['note', 'toast'], level: 'soft' }] } },
}

test('a note shows exactly one toast saying what the model was told', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  expect(w.toasts.filter(t => t.includes('310k'))).toEqual(noteToasts(w))
  expect(noteToasts(w)).toHaveLength(1)
  // The repo is untrusted, so the note asks for a manual restart and so does the toast.
  expect(notes(session)[0]).toContain("Then tell the operator 'ready for /clear'")
  expect(noteToasts(w)[0]).toBe("ctx-guard → model (soft): context 310k past 300k — plan for a handoff; write the handoff, then tell you 'ready for /clear'")
})

test('a trigger with note and toast still shows one toast', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT_TOAST)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  expect(w.toasts.filter(t => t.includes('310k'))).toHaveLength(1)
  expect(noteToasts(w)).toHaveLength(1)
})

test('noteToasts off: no note toast, the trigger toast as before', { options: { noteToasts: false } }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT_TOAST)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  expect(noteToasts(w)).toEqual([])
  expect(w.toasts).toContain('ctx-guard: lead: context 310k (31% of 1M)')
})

test('the report shows the noteToasts switch', { options: { noteToasts: false } }, async ($, on) => {
  const w = newWorld()
  world(on, w)
  await start($)
  expect(await ctxGuard($, '')).toContain('switches: blocking on; autoActions on; noteToasts off; display band')
})

test('zero-config, no role: no note, so no note toast', async ($, on) => {
  const w = newWorld()
  world(on, w)
  await start($)
  await measure($, w, 600_000)
  expect(w.toasts.some(t => t.includes('context 600k (60% of 1M)'))).toBe(true)
  expect(noteToasts(w)).toEqual([])
})

test('a rising edge held across measures toasts once', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT_TOAST)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  await measure($, w, 320_000)
  await measure($, w, 330_000)
  expect(noteToasts(w)).toHaveLength(1)
  expect(w.toasts.filter(t => /context 3[123]0k/.test(t))).toHaveLength(1)
})

test('a /clear that wipes $.state: the next hook writes back the role, pause, verdict and lease', { plugins: [WIPE, PEEK] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w)
  await start($)
  expect(await ctxGuard($, 'role lead')).toContain('role is now lead')
  expect(await ctxGuard($, 'pause 30m')).toContain('paused for 30m')
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await wipeState($)
  // The wipe as the next session sees it, before ctx-guard runs a hook.
  expect((await peek($)).roleClaim).toBeNull()
  await measure($, w, undefined)
  expect((await peek($)).roleClaim?.role).toBe('lead')
  const report = await ctxGuard($, '')
  expect(report).toContain('paused for')
  expect(report).toContain('role: lead (from /ctx-guard role, set ')
  expect(report).toContain('last /clear: 0s ago')
  expect(report).toContain('lease: held by this session')
  expect(report).toContain('self gap: 1m; no restart yet in this session')
  // The marks were reset by the clear: a new crossing notes again.
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(2)
})

test('a timer after a wiping /clear writes memory back, before any hook', { plugins: [WIPE, PEEK] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { clock } = world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await wipeState($)
  // The idle tick is the first of ctx-guard's code to run.
  await clock.advance(60 * 1000)
  await clock.settle()
  expect((await peek($)).roleClaim?.role).toBe('lead')
})

test('a /clear that keeps $.state leaves it as it is', { plugins: [PEEK] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  // A role set after the clear is not undone by the write-back of the memory from before it.
  await ctxGuard($, 'role none')
  await measure($, w, 100_000)
  expect((await peek($)).roleClaim?.role).toBeNull()
})

// Holds every read of ctx-guard's band from /hold-band to /release-band, as a busy session start can.
const HOLD_BAND: Plugin = {
  name: 'hold-band',
  register: on => {
    let gate: Promise<void> | null = null
    let release: () => void = () => undefined
    on('command.run', { command: 'hold-band' }, () => {
      gate = new Promise<void>(r => {
        release = r
      })
      return { text: '' }
    })
    on('command.run', { command: 'release-band' }, () => {
      gate = null
      release()
      return { text: '' }
    })
    on('state.get', { plugin: 'ctx-guard', key: 'band' }, async ($, e, next) => {
      if (gate) await gate
      return next(e)
    })
  },
}

test('the band draws without waiting on $: from what was last written', { plugins: [HOLD_BAND] }, async ($, on) => {
  const w = newWorld({ tokens: 312_000 })
  writeConfig(w, LEAD_SOFT)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await run($, 'hold-band')
  try {
    const ui = await $.ui.mount({ plugin: 'ctx-guard', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    expect((await ui.findAll({ type: 'Text', text: '312k (31%)' })).length).toBeGreaterThan(0)
  } finally {
    await run($, 'release-band')
  }
})

test('Agent is denied past the threshold with blocking on', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  const reason = await agentDenied($)
  expect(reason).toContain('[ctx-guard] Agent is blocked by trigger "brake"')
  expect(reason).toContain('resets (in 2h)')
  const bash = await $.tool.call({ tool: 'Bash', command: 'true' } as never)
  expect(bash.deny).toBeUndefined()
  expect(bash.result).toBe('ran')
})

const CTX_BRAKE = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'stop', when: { context: '80k' }, do: [{ deny: ['Agent'] }], level: 'stop' }] } },
}

test("a call made while the step streams is judged on that step's request, not the last one", async ($, on) => {
  // The stop chunk, the only one with usage, comes after the tools a response calls have started.
  let fill = 72_900
  let release: () => void = () => undefined
  let held: Promise<void> = Promise.resolve()
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'Reading.' }
    await held
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as never,
      usage: { input_tokens: 10, cache_read_input_tokens: fill - 10, cache_creation_input_tokens: 0, output_tokens: 300, model: 'm' },
    }
  })
  const w = newWorld({ tokens: 70_000, toolText: { Read: 'x'.repeat(62_000) } })
  writeConfig(w, CTX_BRAKE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock)
  // 72.9k answered: the Agent passes, and the Read's 62,000 characters go into the next request.
  expect(await agentDenied($)).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: '/repo/big.txt' } as never)
  fill = 88_800
  held = new Promise<void>(r => {
    release = r
  })
  const s = $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 5 })
  const it = s[Symbol.asyncIterator]()
  await it.next()
  // In flight: 72.9k + 300 out + 15.5k of results ≈ 88.7k, past 80k, though usage() still says 70k.
  expect(await agentDenied($)).toContain('Agent is blocked by trigger "stop"')
  release()
  while (!(await it.next()).done) {
    // drain
  }
  await s.result
  await clock.settle()
  // Done streaming: the step's own figure stands.
  expect(await ctxGuard($, '')).toContain('context: 89k')
  fill = 60_000
  await step($, clock)
  expect(await agentDenied($)).toBeUndefined()
})

// Runs a Read of its own on the main loop: its result goes to this plugin, not into the model's context.
const READER: Plugin = {
  name: 'reader',
  register: on => {
    on('command.run', { command: 'read-big' }, async $ => {
      await $.tool.call({ tool: 'Read', file_path: '/repo/big.txt' } as never)
      return { text: '' }
    })
  },
}

test("a plugin's own tool call adds nothing to the in-flight estimate", { plugins: [READER] }, async ($, on) => {
  let release: () => void = () => undefined
  let held: Promise<void> = Promise.resolve()
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'Reading.' }
    await held
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as never,
      usage: { input_tokens: 10, cache_read_input_tokens: 72_890, cache_creation_input_tokens: 0, output_tokens: 300, model: 'm' },
    }
  })
  const w = newWorld({ tokens: 70_000, toolText: { Read: 'x'.repeat(62_000) } })
  writeConfig(w, CTX_BRAKE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock)
  await $.command.run({ command: 'read-big', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  held = new Promise<void>(r => {
    release = r
  })
  const s = $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 5 })
  const it = s[Symbol.asyncIterator]()
  await it.next()
  expect(await agentDenied($)).toBeUndefined()
  release()
  while (!(await it.next()).done) {
    // drain
  }
  await s.result
})

test('Agent passes below the threshold', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 50 }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await agentDenied($)).toBeUndefined()
})

test('with blocking off the same call passes', { options: { blocking: false } }, async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await agentDenied($)).toBeUndefined()
})

test('a pause lifts the deny until it ends or is lifted', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'pause 10m')).toContain('paused for 10m')
  expect(await agentDenied($)).toBeUndefined()
  await clock.advance(11 * 60 * 1000)
  expect(await agentDenied($)).toContain('Agent is blocked')
  await ctxGuard($, 'pause')
  expect(await agentDenied($)).toBeUndefined()
  expect(await ctxGuard($, 'pause off')).toContain('pause lifted')
  expect(await agentDenied($)).toContain('Agent is blocked')
})

test('no role, no deny', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w)
  await start($)
  expect(await agentDenied($)).toBeUndefined()
})

test('an invalid file lists its errors, toasts once and keeps the last good config', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await clock.advance(1000)
  writeConfig(w, '{ "version": 1, "roles": ')
  await measure($, w, 200_000)
  await measure($, w, 210_000)
  const errorToasts = w.toasts.filter(t => t.includes('config has 1 error'))
  expect(errorToasts.length).toBe(1)
  expect(errorToasts[0]).toContain('kept the last good config')
  const report = await ctxGuard($, '')
  expect(report).toContain('config: last-good')
  expect(report).toContain('error: .claude/ctx-guard.json: invalid JSON')
  expect(report).toContain('role: lead (from CTX_GUARD_ROLE)')
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
})

test('an invalid file with nothing good before runs the built-ins', async ($, on) => {
  const w = newWorld()
  writeConfig(w, { version: 1, roles: { lead: { triggers: 'nope' } } })
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(w.toasts.some(t => t.includes('running on the built-in config'))).toBe(true)
  const report = await ctxGuard($, '')
  expect(report).toContain('config: built-in')
  expect(report).toContain('not in the config')
})

test('an mtime change reloads the config at the next measure', async ($, on) => {
  const w = newWorld()
  writeConfig(w, { version: 1, roles: { lead: { triggers: [{ id: 'soft', when: { context: '500k' }, do: ['note'] }] } } })
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  expect(notes(session)).toEqual([])
  await clock.advance(1000)
  writeConfig(w, LEAD_SOFT)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
})

test('the local file overrides the team file', async ($, on) => {
  const w = newWorld()
  writeConfig(w, { version: 1, roles: { lead: { triggers: [{ id: 'soft', when: { context: '500k' }, do: ['note'] }] } } })
  writeConfig(w, LEAD_SOFT, LOCAL)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
})

test('/ctx-guard role from the composer sets the claim, which survives a reload', { plugins: [PEEK] }, async ($, on) => {
  const w = newWorld({ tokens: 312_000, limits: [{ kind: 'five_hour', percentUsed: 42 }] })
  writeConfig(w, { version: 1, roles: { lead: {}, reviewer: {} } })
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  expect(await ctxGuard($, 'role reviewer')).toContain('role is now reviewer')
  expect(w.statuses.at(-1)).toBe('reviewer · 312k (31%) · 5h 42%')
  await start($, 'vscode')
  expect((await peek($)).roleClaim?.role).toBe('reviewer')
  expect(await ctxGuard($, '')).toContain('role: reviewer (from /ctx-guard role, set ')
  expect(await ctxGuard($, 'role none')).toContain('role is now none')
  expect(await ctxGuard($, '')).toContain('role: none (from /ctx-guard role, set ')
})

test('/ctx-guard role from a plugin or an unknown role changes nothing', async ($, on) => {
  const w = newWorld()
  writeConfig(w, { version: 1, roles: { lead: {}, reviewer: {} } })
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'role reviewer', 'plugin')).toContain('ask the operator')
  expect(await ctxGuard($, 'role ghost')).toContain('not in the config')
  expect(await ctxGuard($, '')).toContain('role: lead (from CTX_GUARD_ROLE)')
})

test('an unknown env role toasts once and runs with no role', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'ghost' })
  await start($)
  await start($)
  expect(w.toasts.filter(t => t.includes('role "ghost"')).length).toBe(1)
  await measure($, w, 310_000)
  expect(notes(session)).toEqual([])
})

test('a non-interactive session gets no role and no note', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, null, false)
  await measure($, w, 310_000)
  expect(notes(session)).toEqual([])
})

test('init writes the starter once, never overwrites, and adds .gitignore lines', async ($, on) => {
  const w = newWorld()
  w.files[GITIGNORE] = { text: 'node_modules/', mtimeMs: NOW }
  world(on, w)
  await start($)
  const reply = await ctxGuard($, 'init')
  expect(reply).toContain('wrote .claude/ctx-guard.json (solo preset)')
  // The solo preset restarts on its own, which waits for the operator's approval.
  expect(reply).toContain('run /ctx-guard trust')
  const written = w.files[TEAM]?.text ?? ''
  expect(written).toBe(PRESET_TEXT.solo)
  expect(w.files[GITIGNORE]?.text).toBe('node_modules/\n.claude/ctx-guard.local.json\n.ctx-guard/\n')
  expect(await ctxGuard($, '')).toContain('role: main (from project defaultRole)')

  const again = await ctxGuard($, 'init peers')
  expect(again).toContain('exists; left as it is')
  expect(again).toContain('.gitignore already lists')
  expect(w.files[TEAM]?.text).toBe(written)
  expect(w.files[GITIGNORE]?.text).toBe('node_modules/\n.claude/ctx-guard.local.json\n.ctx-guard/\n')
})

test('init peers writes two peer roles and a fresh .gitignore', async ($, on) => {
  const w = newWorld()
  world(on, w)
  await start($)
  await ctxGuard($, 'init peers')
  expect(w.files[TEAM]?.text).toBe(PRESET_TEXT.peers)
  expect(Object.keys(JSON.parse(w.files[TEAM]?.text ?? '{}').roles)).toEqual(['lead', 'reviewer'])
  expect(w.files[GITIGNORE]?.text).toBe('.claude/ctx-guard.local.json\n.ctx-guard/\n')
  expect(await ctxGuard($, '')).not.toContain('error:')
})

test('init writes nothing when the shipped preset is missing or invalid', async ($, on) => {
  const w = newWorld({ presets: { peers: '{"version": 1, "roles": {"Bad": {}}}' } })
  world(on, w)
  await start($)
  expect(await ctxGuard($, 'init')).toContain('the solo preset could not be read')
  expect(await ctxGuard($, 'init peers')).toContain('nothing written')
  expect(w.files[TEAM]).toBeUndefined()
  expect(w.files[GITIGNORE]).toBeUndefined()
})

test('init says nothing of trust when the preset needs none', async ($, on) => {
  const manual = JSON.stringify({ version: 1, defaultRole: 'main', roles: { main: { restart: { mode: 'manual' } } } })
  const w = newWorld({ presets: { solo: manual } })
  world(on, w)
  await start($)
  const reply = await ctxGuard($, 'init')
  expect(reply).toContain('wrote .claude/ctx-guard.json (solo preset)')
  expect(reply).not.toContain('/ctx-guard trust')
  expect(w.files[TEAM]?.text).toBe(manual)
})

test('unknown subcommands answer with the usage', async ($, on) => {
  const w = newWorld()
  world(on, w)
  await start($)
  const text = await ctxGuard($, 'frobnicate')
  expect(text).toContain('unknown subcommand "frobnicate"')
  expect(text).toContain('Usage:')
})

test('another plugin owning /ctx-guard leaves ctx-guard inert', async ($, on) => {
  const w = newWorld({ commands: [{ name: 'ctx-guard', source: 'plugin', plugin: 'someone-else' }] })
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await start($)
  expect(w.toasts.filter(t => t.includes('/ctx-guard already belongs to the someone-else plugin')).length).toBe(1)
  expect(w.registered).toEqual([])
  await measure($, w, 310_000)
  expect(notes(session)).toEqual([])
  expect(await ctxGuard($, '')).toBe('the other plugin')
})

const SOFT_AND_BRAKE = {
  version: 1,
  roles: { lead: { triggers: [...LEAD_SOFT.roles.lead.triggers, ...LEAD_BRAKE.roles.lead.triggers] } },
}

test("a skill named after the plugin takes the bare command: one toast, and notes and denies still work", async ($, on) => {
  const w = newWorld({
    commands: [{ name: 'ctx-guard:ctx-guard', source: 'plugin', plugin: 'ctx-guard' }],
    limits: [{ kind: 'five_hour', percentUsed: 95 }],
  })
  writeConfig(w, SOFT_AND_BRAKE)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await start($)
  expect(w.toasts.filter(t => t.includes('the /ctx-guard command is unavailable (the engine maps /ctx-guard to /ctx-guard:ctx-guard)')).length).toBe(1)
  expect(w.registered).toEqual([])
  expect(await agentDenied($)).toContain('Agent is blocked by trigger "brake"')
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
})

test('a refused command registration toasts its error once and the rest keeps working', async ($, on) => {
  const w = newWorld({ failRegister: '"/ctx-guard" refused: it is taken', limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, SOFT_AND_BRAKE)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await start($)
  expect(w.toasts.filter(t => t.includes('the /ctx-guard command is unavailable') && t.includes('"/ctx-guard" refused: it is taken')).length).toBe(1)
  expect(await agentDenied($)).toContain('Agent is blocked by trigger "brake"')
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  // The command is not ctx-guard's: it passes on to whoever answers it.
  expect(await ctxGuard($, '')).toBe('the other plugin')
})

test('an old engine gets one toast', async ($, on) => {
  const w = newWorld({ version: '2.1.280' })
  world(on, w)
  await start($)
  await start($)
  expect(w.toasts.filter(t => t.includes('needs Claude Code 2.1.293')).length).toBe(1)
})

test('enabled false: no band, no toasts, no denies', { options: { enabled: false } }, async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  await measure($, w, 900_000)
  expect(w.toasts).toEqual([])
  expect(w.statuses.filter(s => s !== undefined)).toEqual([])
  expect(await agentDenied($)).toBeUndefined()
  expect(await ctxGuard($, '')).toContain('ctx-guard: off')
})

test('the band text on the status line where no band is drawn', async ($, on) => {
  const w = newWorld({
    tokens: 312_000,
    limits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 2 * HOUR + 10 * 60 * 1000).toISOString() },
      { kind: 'seven_day', percentUsed: 95, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
    ],
  })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  expect(w.statuses.at(-1)).toBe('lead · 312k (31%) · 5h 42% (2h10m) · wk 95% (3d4h) · deny Agent')
})

test('display status writes the status line on the terminal too', { options: { display: 'status' } }, async ($, on) => {
  const w = newWorld({ tokens: 50_000 })
  world(on, w)
  await start($, 'terminal')
  expect(w.statuses.at(-1)).toBe('50k (5%)')
})

test('the band draws above the prompt on the terminal and desktop', async ($, on) => {
  const w = newWorld({ tokens: 312_000, limits: [{ kind: 'five_hour', percentUsed: 42 }] })
  writeConfig(w, LEAD_SOFT)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'terminal')
  expect(w.statuses).toEqual([undefined])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ctx-guard',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })
    expect((await ui.findAll({ type: 'Text', text: 'lead' })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ type: 'Text', text: '312k (31%)' })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ type: 'Text', text: '5h 42%' })).length).toBeGreaterThan(0)
  }
})

test('the band repaints on every new fill', async ($, on) => {
  const w = newWorld({ tokens: 312_000 })
  writeConfig(w, LEAD_SOFT)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  const ui = await $.ui.mount({ plugin: 'ctx-guard', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  expect((await ui.findAll({ type: 'Text', text: '312k (31%)' })).length).toBeGreaterThan(0)
  await measure($, w, 420_000)
  expect((await ui.findAll({ type: 'Text', text: '420k (42%)' })).length).toBeGreaterThan(0)
  await measure($, w, 530_000)
  expect((await ui.findAll({ type: 'Text', text: '530k (53%)' })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ type: 'Text', text: '420k (42%)' })).length).toBe(0)
})

const IDLE_ROLE = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'idle', when: { idle: '5m' }, do: ['notify'] }] } },
}

test('the idle timer notifies once the session sits idle', async ($, on) => {
  const w = newWorld()
  writeConfig(w, IDLE_ROLE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(4 * 60 * 1000)
  expect(w.notifies).toEqual([])
  await clock.advance(2 * 60 * 1000)
  expect(w.notifies.length).toBe(1)
  expect(w.notifies[0]).toContain('idle')
})

test('a running turn is never idle, across a reload too', async ($, on) => {
  const w = newWorld()
  writeConfig(w, IDLE_ROLE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await turn($, 'start')
  // A reload mid-turn must not forget the running turn.
  await start($)
  await clock.advance(10 * 60 * 1000)
  expect(w.notifies).toEqual([])
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(1)
})

test('the timers are armed again by a session start, once', async ($, on) => {
  const w = newWorld()
  writeConfig(w, IDLE_ROLE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await start($)
  await start($)
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(1)
})

test('enabling ctx-guard in the config file arms it at the next measure', async ($, on) => {
  const w = newWorld({ tokens: 312_000 })
  writeConfig(w, { version: 1, enabled: false, roles: { lead: {} } })
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  expect(w.statuses.filter(x => x !== undefined)).toEqual([])
  await clock.advance(1000)
  writeConfig(w, { version: 1, roles: { lead: {} } })
  await measure($, w, 312_000)
  expect(w.statuses.at(-1)).toBe('lead · 312k (31%)')
  await clock.advance(1000)
  writeConfig(w, { version: 1, enabled: false, roles: { lead: {} } })
  await measure($, w, 312_000)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('the band refreshes its countdowns every 5 minutes', async ($, on) => {
  const w = newWorld({ tokens: 312_000, limits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 2 * HOUR + 10 * 60 * 1000).toISOString() }] })
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'main' })
  await start($, 'vscode')
  expect(w.statuses.at(-1)).toBe('main · 312k (31%) · 5h 42% (2h10m)')
  await clock.advance(5 * 60 * 1000)
  expect(w.statuses.at(-1)).toBe('main · 312k (31%) · 5h 42% (2h5m)')
})

test('the engine window counts the percentages and the report names it', async ($, on) => {
  const w = newWorld({ tokens: 312_000, rawMax: 400_000 })
  world(on, w)
  await start($, 'vscode')
  expect(w.statuses.at(-1)).toBe('312k (78%)')
  expect(await ctxGuard($, '')).toContain('contextWindow auto = 400k (engine: settings)')
})

test('a subagent tool call is never denied', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  const r = await $.tool.call({ ...AGENT, agentId: 'sub-1' } as never)
  expect(r.deny).toBeUndefined()
  expect(r.result).toBe('ran')
})

test('the deny fails open when the usage cannot be read', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await agentDenied($)).toContain('Agent is blocked')
  w.failUsage = true
  expect(await agentDenied($)).toBeUndefined()
})

test('a measure and a step racing note once', async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  stepBottom(on, () => 310_000)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await Promise.all([measure($, w, 310_000), step($, clock), measure($, w, 310_000), step($, clock)])
  await clock.settle()
  expect(notes(session).length).toBe(1)
})

test('pause and init typed by anyone but the operator are refused', async ($, on) => {
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 95 }] })
  writeConfig(w, LEAD_BRAKE)
  const before = w.files[TEAM]?.text
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'pause 10m', 'plugin')).toContain('only the operator can run /ctx-guard pause')
  expect(await agentDenied($)).toContain('Agent is blocked')
  expect(await ctxGuard($, 'init', 'plugin')).toContain('only the operator can run /ctx-guard init')
  expect(w.files[TEAM]?.text).toBe(before)
  expect(w.files[GITIGNORE]).toBeUndefined()
})

test('a configPath escaping the root is refused; init writes the default path only', { options: { configPath: '../outside.json' } }, async ($, on) => {
  const w = newWorld()
  world(on, w)
  await start($)
  expect(await ctxGuard($, 'init')).toContain('wrote .claude/ctx-guard.json')
  expect(Object.keys(w.files).every(p => p.startsWith(`${ROOT}/`))).toBe(true)
  expect(await ctxGuard($, '')).toContain('error: userConfig: configPath')
})

test('turn ends are kept before ctx-guard has started', async ($, on) => {
  const w = newWorld()
  writeConfig(w, IDLE_ROLE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await turn($, 'start')
  await turn($, 'end')
  await start($)
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(1)
})

test('a turn start with no end for hours counts as stale, so idle fires', async ($, on) => {
  const w = newWorld()
  writeConfig(w, IDLE_ROLE)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await turn($, 'start')
  await clock.advance(5 * 60 * 60 * 1000)
  expect(w.notifies).toEqual([])
  await clock.advance(61 * 60 * 1000)
  expect(w.notifies.length).toBe(1)
})

test('a new step model re-places percent gates', async ($, on) => {
  const w = newWorld()
  writeConfig(w, { version: 1, roles: { lead: { triggers: [{ id: 'half', when: { context: '50%' }, do: ['note'] }] } } })
  let model = 'big'
  stepBottom(on, () => 310_000, () => model)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock)
  expect(notes(session)).toEqual([])
  // Same tokens on a model with a 600k window: 52%, past the threshold.
  model = 'small'
  w.window = 600_000
  await step($, clock)
  expect(notes(session).length).toBe(1)
})

test('the engine window is read again when the context starts over and every 10th measure', async ($, on) => {
  const w = newWorld({ tokens: 240_000, rawMax: 400_000 })
  world(on, w)
  await start($, 'vscode')
  expect(w.statuses.at(-1)).toBe('240k (60%)')
  w.rawMax = 300_000
  await measure($, w, undefined)
  await measure($, w, 240_000)
  expect(w.statuses.at(-1)).toBe('240k (80%)')
  w.rawMax = 480_000
  for (let i = 0; i < 7; i++) await measure($, w, 240_000)
  expect(w.statuses.at(-1)).toBe('240k (80%)')
  await measure($, w, 240_000)
  expect(w.statuses.at(-1)).toBe('240k (50%)')
})
