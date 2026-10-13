import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, MockSession, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const ROOT = '/repo'
const TEAM = `${ROOT}/.claude/ctx-guard.json`
const LOCAL = `${ROOT}/.claude/ctx-guard.local.json`
const GITIGNORE = `${ROOT}/.gitignore`
const WINDOW = 1_000_000
const HOUR = 60 * 60 * 1000

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The world beneath the plugin: files in memory, the session's figures, the
// commands it lists, and what the plugin showed.
type World = {
  files: Record<string, { text: string; mtimeMs: number }>
  tokens: number | undefined
  limits: Limit[]
  commands: { name: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }[]
  registered: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  version: string
  notifies: string[]
  failUsage: boolean
  // The engine's compaction window, answered with a breakdown; null answers none.
  rawMax: number | null
  window: number
  clock?: MockClock
}

function newWorld(over: Partial<World> = {}): World {
  return {
    files: {},
    tokens: 100_000,
    limits: [],
    commands: [],
    registered: [],
    toasts: [],
    statuses: [],
    version: '2.1.296',
    notifies: [],
    failUsage: false,
    rawMax: null,
    window: WINDOW,
    ...over,
  }
}

function usageOf(w: World) {
  return {
    startedAt: NOW,
    context: w.tokens === undefined ? { window: w.window } : { window: w.window, tokens: w.tokens, percent: Math.round((w.tokens / w.window) * 100) },
    rateLimits: w.limits,
  }
}

function world(on: On, w: World, env: Record<string, string> = {}): { clock: MockClock; session: MockSession } {
  const session = mock.session(on)
  mock.env(on, env)
  const clock = mock.clock(on, { now: NOW })
  w.clock = clock
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('session.usage', ($, e) => {
    if (w.failUsage) throw new Error('usage unavailable')
    const u = usageOf(w)
    if (!e?.breakdown || w.rawMax === null) return { value: u }
    const breakdown = { rawMaxTokens: w.rawMax, autocompactSource: 'settings' } as never
    return { value: { ...u, context: { ...u.context, breakdown } } }
  })
  on('session.version', () => ({ value: { version: w.version, base: w.version } }))
  on('settings.read', () => ({ value: {} }))
  on('command.list', () => ({ value: w.commands.map(c => ({ description: '', ...c })) }))
  on('command.register', ($, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    w.notifies.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } as never }
  })
  on('fs.stat', ($, e) => {
    const f = w.files[e.path]
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path in w.files }))
  on('fs.read', ($, e) => {
    const f = w.files[e.path]
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text as never }
  })
  on('fs.write', ($, e) => {
    w.files[e.path] = { text: e.text, mtimeMs: clock.now() }
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ran' as never }))
  return { clock, session }
}

function writeConfig(w: World, value: unknown, path = TEAM): void {
  w.files[path] = { text: typeof value === 'string' ? value : JSON.stringify(value), mtimeMs: (w.clock?.now() ?? NOW) + Math.random() }
}

async function start($: Engine, surface: 'terminal' | 'vscode' | null = 'terminal', isInteractive = true): Promise<void> {
  await $.session.start({ cwd: ROOT, surface, isInteractive })
}

async function measure($: Engine, w: World, tokens: number | undefined): Promise<void> {
  w.tokens = tokens
  const u = usageOf(w)
  await $.session.measure({ context: u.context, rateLimits: u.rateLimits, changed: ['context'] })
}

// One model request; the step bottom answers its usage. The evaluation runs
// off the step's path, so the clock settles it.
async function step($: Engine, clock: MockClock, agentId?: string): Promise<void> {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
    // drain
  }
  await s.result
  await clock.settle()
}

async function ctxGuard($: Engine, args: string, kind: 'composer' | 'plugin' = 'composer'): Promise<string> {
  const r = await $.command.run({ command: 'ctx-guard', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })
  return r.text ?? ''
}

const notes = (s: MockSession): string[] =>
  s
    .appended()
    .filter(r => r.door === 'note')
    .map(r => JSON.stringify(r.message.content))

// A second plugin that reads ctx-guard's $.state (any plugin may read it), so a
// test can look at what survives a reload.
const PEEK: Plugin = {
  name: 'peek',
  register: on => {
    on('command.run', { command: 'peek' }, async $ => {
      const marks = (await $.state.get({ plugin: 'ctx-guard', key: 'marks' })).value ?? null
      const roleClaim = (await $.state.get({ plugin: 'ctx-guard', key: 'roleClaim' })).value ?? null
      return { text: JSON.stringify({ marks, roleClaim }) }
    })
  },
}

async function peek($: Engine): Promise<{ marks: { byId: Record<string, { step: number }> } | null; roleClaim: { role: string | null } | null }> {
  const r = await $.command.run({ command: 'peek', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

const AGENT = { tool: 'Agent', description: 'probe', prompt: 'Reply OK', subagent_type: 'general-purpose' } as const

// The deny reason of an Agent call, or undefined when it ran.
async function agentDenied($: Engine): Promise<string | undefined> {
  const r = await $.tool.call(AGENT)
  if (r.deny !== undefined) return r.deny
  expect(r.result).toBe('ran')
  return undefined
}

const LEAD_SOFT = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'soft', when: { context: '300k' }, do: ['note'], level: 'soft' }] } },
}

const LEAD_BRAKE = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'brake', when: { 'limit.any': 90 }, do: [{ deny: ['Agent'] }], level: 'stop' }] } },
}

// The step bottom answers with the usage the test sets per call.
function stepBottom(on: On, tokens: () => number, model: () => string = () => 'm'): void {
  on('turn.step', async function* ($, e) {
    const t = tokens()
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as never,
      usage: { input_tokens: 10, cache_read_input_tokens: t - 10, cache_creation_input_tokens: 0, output_tokens: 50, model: model() },
    }
  })
}

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
  expect(await ctxGuard($, '')).toContain('role: reviewer (from /ctx-guard role)')
  expect(await ctxGuard($, 'role none')).toContain('role is now none')
  expect(await ctxGuard($, '')).toContain('role: none (from /ctx-guard role)')
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
  expect(await ctxGuard($, 'init')).toContain('wrote .claude/ctx-guard.json (solo starter)')
  const written = w.files[TEAM]?.text ?? ''
  expect(JSON.parse(written).defaultRole).toBe('main')
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
  expect(Object.keys(JSON.parse(w.files[TEAM]?.text ?? '{}').roles)).toEqual(['lead', 'reviewer'])
  expect(w.files[GITIGNORE]?.text).toBe('.claude/ctx-guard.local.json\n.ctx-guard/\n')
  expect(await ctxGuard($, '')).not.toContain('error:')
})

test('unknown subcommands answer with the usage', async ($, on) => {
  const w = newWorld()
  world(on, w)
  await start($)
  const text = await ctxGuard($, 'trust')
  expect(text).toContain('unknown subcommand "trust"')
  expect(text).toContain('Usage:')
})

test('another plugin owning /ctx-guard leaves ctx-guard inert', async ($, on) => {
  const w = newWorld({ commands: [{ name: 'ctx-guard', source: 'plugin', plugin: 'someone-else' }] })
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  on('command.run', () => ({ text: 'the other plugin' }))
  await start($)
  await start($)
  expect(w.toasts.filter(t => t.includes('/ctx-guard already belongs to the someone-else plugin')).length).toBe(1)
  expect(w.registered).toEqual([])
  await measure($, w, 310_000)
  expect(notes(session)).toEqual([])
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

const IDLE_ROLE = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'idle', when: { idle: '5m' }, do: ['notify'] }] } },
}

async function turn($: Engine, phase: 'start' | 'end'): Promise<void> {
  if (phase === 'start') await $.turn.start({ text: 'go', turnId: 't1' })
  else await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
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
