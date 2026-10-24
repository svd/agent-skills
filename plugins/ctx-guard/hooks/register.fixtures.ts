// Shared fixtures and helpers of the register.*.test.ts files: the fake world, its engine
// bottoms, and the peek plugins. Not a test file itself.

import { expect, mock } from 'claude-code/testing'
import type { Engine, MockClock, MockSession, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

export const NOW = Date.parse('2026-10-13T12:00:00Z')

export const ROOT = '/repo'

export const TEAM = `${ROOT}/.claude/ctx-guard.json`

export const WINDOW = 1_000_000

export const HOUR = 60 * 60 * 1000

// Stand-ins for skills/guide/assets/presets/*.json, which tests cannot read.
// They must equal the shipped files byte for byte: when you edit a preset, paste it here too.
export const PRESET_TEXT: Record<string, string> = {
  solo: "{\n  \"version\": 1,\n  \"defaultRole\": \"main\",\n  \"roles\": {\n    \"main\": {\n      \"description\": \"the one long-running session in this project\",\n      \"triggers\": [\n        { \"id\": \"ctx-soft\", \"when\": { \"context\": \"40%\" }, \"do\": [\"note\"], \"level\": \"soft\" },\n        { \"id\": \"ctx-hard\", \"when\": { \"context\": \"60%\" }, \"do\": [\"note\"], \"level\": \"hard\" },\n        { \"id\": \"ctx-stop\", \"when\": { \"context\": \"75%\", \"every\": \"5%\" }, \"do\": [\"note\"], \"level\": \"stop\" },\n        { \"id\": \"limit-soft\", \"when\": { \"limit.any\": 80 }, \"do\": [\"note\"], \"level\": \"soft\" },\n        { \"id\": \"limit-hard\", \"when\": { \"limit.any\": 90 }, \"do\": [\"note\", \"toast\"], \"level\": \"hard\" },\n        { \"id\": \"week-80-early\", \"when\": { \"limit.seven_day\": 80, \"limit.seven_day.resetsIn\": \"2d\" }, \"do\": [\"note\", { \"deny\": [\"Agent\", \"Workflow\"] }], \"level\": \"hard\", \"message\": \"With {resetsIn} still to the weekly reset, start no new subagents so the rest of the window lasts; do small steps in this session.\", \"lift\": { \"do\": [\"note\", \"notify\"] } },\n        { \"id\": \"week-90-early\", \"when\": { \"limit.seven_day\": 90, \"limit.seven_day.resetsIn\": \"1d\" }, \"do\": [\"note\", { \"deny\": [\"Agent\", \"Workflow\"] }], \"level\": \"hard\", \"message\": \"With {resetsIn} still to the weekly reset, start no new subagents so the rest of the window lasts; do small steps in this session.\", \"lift\": { \"do\": [\"note\", \"notify\"] } },\n        { \"id\": \"limit-brake\", \"when\": { \"limit.any\": 95 }, \"do\": [\"note\", \"toast\", { \"deny\": [\"Agent\", \"Workflow\", \"WebSearch\", \"WebFetch\"] }], \"level\": \"stop\", \"lift\": { \"do\": [\"note\", \"notify\"] } },\n        { \"id\": \"cache-miss\", \"when\": { \"cache.miss\": \"50k\" }, \"do\": [\"toast\"] }\n      ],\n      \"handoff\": {\n        \"instructions\": \"Rewrite the whole file. Header: when it was written and the git HEAD, if this is a git repo. Sections: Goal, State, Next action.\"\n      },\n      \"restart\": {\n        \"mode\": \"auto\",\n        \"prompt\": \"Carry out Next action without waiting.\",\n        \"minContext\": \"40%\"\n      }\n    }\n  }\n}\n",
  peers: "{\n  \"version\": 1,\n  \"defaults\": {\n    \"triggers\": [\n      { \"id\": \"ctx-soft\", \"when\": { \"context\": \"40%\" }, \"do\": [\"note\"], \"level\": \"soft\" },\n      { \"id\": \"ctx-hard\", \"when\": { \"context\": \"60%\" }, \"do\": [\"note\"], \"level\": \"hard\" },\n      { \"id\": \"ctx-stop\", \"when\": { \"context\": \"75%\", \"every\": \"5%\" }, \"do\": [\"note\", \"toast\"], \"level\": \"stop\" },\n      { \"id\": \"limit-hard\", \"when\": { \"limit.any\": 90 }, \"do\": [\"note\", \"toast\"], \"level\": \"hard\" },\n      { \"id\": \"limit-brake\", \"when\": { \"limit.any\": 95 }, \"do\": [\"note\", { \"deny\": [\"Agent\", \"Workflow\", \"WebSearch\", \"WebFetch\"] }], \"level\": \"stop\", \"lift\": { \"do\": [\"note\", \"notify\"] } },\n      { \"id\": \"cache-miss\", \"when\": { \"cache.miss\": \"50k\" }, \"do\": [\"toast\"] }\n    ],\n    \"handoff\": {\n      \"instructions\": \"Rewrite the whole file. Header: when it was written and the git HEAD, if this is a git repo. Sections: Goal, State, Open questions for the peer, Next action.\"\n    },\n    \"restart\": {\n      \"mode\": \"auto\",\n      \"prompt\": \"Carry out Next action without waiting.\",\n      \"peerGap\": \"10m\"\n    }\n  },\n  \"roles\": {\n    \"lead\": {\n      \"description\": \"coordinates the work and dispatches subagents\",\n      \"notes\": { \"suffix\": \"Before you stop, send the reviewer session a short message: what you finished and what you hand over.\" },\n      \"restart\": { \"peers\": [\"reviewer\"] }\n    },\n    \"reviewer\": {\n      \"description\": \"reviews what the lead session produces\",\n      \"notes\": { \"suffix\": \"Before you stop, send the lead session a short message: what you reviewed and what is still open.\" },\n      \"restart\": { \"peers\": [\"lead\"] }\n    }\n  },\n  \"subagents\": {\n    \"*\": { \"warn\": \"120k\", \"stop\": \"170k\" },\n    \"Explore\": { \"warn\": \"100k\", \"stop\": \"150k\", \"message\": \"Budget of {stop} reached: return your findings now.\" }\n  }\n}\n",
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The world beneath the plugin: files in memory, the session's figures, the
// commands it lists, and what the plugin showed.
export type World = {
  files: Record<string, { text: string; mtimeMs: number }>
  tokens: number | undefined
  limits: Limit[]
  commands: { name: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }[]
  registered: string[]
  // Why command.register refuses, or null when it registers.
  failRegister: string | null
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
  // The `init` of each process run, in the order of `processes`.
  inits: ({ cwd?: string; env?: Record<string, string>; timeoutMs?: number } | undefined)[]
  // What a process prints, by its argv joined with spaces; absent prints nothing.
  stdout: Record<string, string>
  // How long a process runs before it answers.
  processHang: number
  exitCode: number | 'timeout'
  // What a ready check prints to stderr.
  stderr: string
  // path → where it really lands (a symlink); absent means the path itself.
  links: Record<string, string>
  onWrite?: (path: string) => void
  // Runs as a ready check runs: what another session does meanwhile.
  onProcess?: () => void
  // The engine's compaction window, answered with a breakdown; null answers none.
  rawMax: number | null
  window: number
  // The preset files the plugin ships, by name; read by suffix, wherever the plugin root is.
  presets: Record<string, string>
  // What a tool's result reads as for the model, by tool name.
  toolText: Record<string, string>
  // Reads per path, and how long a read of a path takes before it answers.
  reads: Record<string, number>
  readHang: Record<string, number>
  // Calls of $.session.usage(), and how long each takes before it answers.
  usageCalls: number
  usageHang: number
  // The text of each prompt that reached the bottom.
  prompts: string[]
  // Why the bottom refuses a prompt (it answers `{ drop }`); null lets it in.
  dropPrompt: string | null
  // Each `$.ui.log` line, `to: text`.
  logs: string[]
  clock?: MockClock
}

export function newWorld(over: Partial<World> = {}): World {
  return {
    files: {},
    tokens: 100_000,
    limits: [],
    commands: [],
    registered: [],
    failRegister: null,
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
    inits: [],
    stdout: {},
    processHang: 0,
    exitCode: 0,
    stderr: '',
    links: {},
    rawMax: null,
    window: WINDOW,
    presets: { ...PRESET_TEXT },
    toolText: {},
    reads: {},
    readHang: {},
    usageCalls: 0,
    usageHang: 0,
    prompts: [],
    dropPrompt: null,
    logs: [],
    ...over,
  }
}

export function usageOf(w: World) {
  return {
    startedAt: NOW,
    context: w.tokens === undefined ? { window: w.window } : { window: w.window, tokens: w.tokens, percent: Math.round((w.tokens / w.window) * 100) },
    rateLimits: w.limits,
  }
}

export function dirsOf(w: World): Set<string> {
  const dirs = new Set<string>([ROOT])
  for (const path of Object.keys(w.files)) {
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return dirs
}

export function world(on: On, w: World, env: Record<string, string> = {}): { clock: MockClock; session: MockSession } {
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
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    if (w.dropPrompt !== null) return { drop: w.dropPrompt }
    return { text: e.text }
  })
  on('ui.log', ($, e) => {
    w.logs.push(`${e.to}: ${e.text}`)
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('session.usage', async ($, e) => {
    w.usageCalls += 1
    if (w.usageHang > 0) await clock.sleep(w.usageHang)
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
    if (w.failRegister !== null) return { deny: w.failRegister }
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
    // The built-in local commands answer with text; a prompt command shows none.
    return e.command === 'clear' || e.command === 'compact' ? { text: '' } : {}
  })
  on('process.run', async ($, e) => {
    w.processes.push([...e.argv])
    w.inits.push(e.init as World['inits'][number])
    w.onProcess?.()
    if (w.processHang > 0) await clock.sleep(w.processHang)
    if (w.exitCode === 'timeout') throw new Error('timed out')
    const stdout = w.stdout[e.argv.join(' ')] ?? ''
    return { value: { exitCode: w.exitCode, stdout, stderr: w.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path in w.files || dirsOf(w).has(e.path) || e.path in w.links }))
  on('classic.Stop', () => ({}))
  on('fs.read', async ($, e) => {
    w.reads[e.path] = (w.reads[e.path] ?? 0) + 1
    const hang = w.readHang[e.path] ?? 0
    if (hang > 0) await clock.sleep(hang)
    const f = w.files[e.path]
    const preset = /\/skills\/guide\/assets\/presets\/([a-z]+)\.json$/.exec(e.path)?.[1]
    if (!f && preset !== undefined && preset in w.presets) return { value: w.presets[preset] as never }
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text as never }
  })
  on('fs.write', ($, e) => {
    w.files[e.path] = { text: e.text, mtimeMs: clock.now() }
    w.onWrite?.(e.path)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    const text = w.toolText[String(e.tool)]
    return { result: 'ran' as never, ...(text === undefined ? {} : { text }) }
  })
  // The started agent's id is the spawn's description.
  on('agent.spawn', ($, e) => ({ model: 'm', agentId: e.description }))
  return { clock, session }
}

export function writeConfig(w: World, value: unknown, path = TEAM): void {
  w.files[path] = { text: typeof value === 'string' ? value : JSON.stringify(value), mtimeMs: (w.clock?.now() ?? NOW) + Math.random() }
}

export async function start($: Engine, surface: 'terminal' | 'vscode' | null = 'terminal', isInteractive = true): Promise<void> {
  await $.session.start({ cwd: ROOT, surface, isInteractive })
}

export async function measure($: Engine, w: World, tokens: number | undefined): Promise<void> {
  w.tokens = tokens
  const u = usageOf(w)
  await $.session.measure({ context: u.context, rateLimits: u.rateLimits, changed: ['context'] })
}

// One model request; the step bottom answers its usage. The evaluation runs
// off the step's path, so the clock settles it.
export async function step($: Engine, clock: MockClock, agentId?: string): Promise<void> {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
    // drain
  }
  await s.result
  await clock.settle()
}

export async function ctxGuard($: Engine, args: string, kind: 'composer' | 'plugin' = 'composer'): Promise<string> {
  const r = await $.command.run({ command: 'ctx-guard', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })
  return r.text ?? ''
}

export const notes = (s: MockSession): string[] =>
  s
    .appended()
    .filter(r => r.door === 'note')
    .map(r => JSON.stringify(r.message.content))

// A second plugin that reads ctx-guard's $.state (any plugin may read it), so a
// test can look at what survives a reload.
export const PEEK: Plugin = {
  name: 'peek',
  register: on => {
    on('command.run', { command: 'peek' }, async $ => {
      const marks = (await $.state.get({ plugin: 'ctx-guard', key: 'marks' })).value ?? null
      const roleClaim = (await $.state.get({ plugin: 'ctx-guard', key: 'roleClaim' })).value ?? null
      return { text: JSON.stringify({ marks, roleClaim }) }
    })
  },
}

export async function peek($: Engine): Promise<{ marks: { byId: Record<string, { step: number }> } | null; roleClaim: { role: string | null } | null }> {
  const r = await $.command.run({ command: 'peek', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

export const AGENT = { tool: 'Agent', description: 'probe', prompt: 'Reply OK', subagent_type: 'general-purpose' } as const

// The deny reason of an Agent call, or undefined when it ran.
export async function agentDenied($: Engine): Promise<string | undefined> {
  const r = await $.tool.call(AGENT)
  if (r.deny !== undefined) return r.deny
  expect(r.result).toBe('ran')
  return undefined
}

export const LEAD_SOFT = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'soft', when: { context: '300k' }, do: ['note'], level: 'soft' }] } },
}

export const LEAD_BRAKE = {
  version: 1,
  roles: { lead: { triggers: [{ id: 'brake', when: { 'limit.any': 90 }, do: [{ deny: ['Agent'] }], level: 'stop' }] } },
}

// The step bottom answers with the usage the test sets per call.
export function stepBottom(on: On, tokens: () => number, model: () => string = () => 'm'): void {
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

// A test plugin's command, run as a plugin would: it is no operator input.
export const run = ($: Engine, command: string) => $.command.run({ command, args: '', origin: { kind: 'plugin', name: 'test' } as never, presentation: { isFullscreen: false, columns: 120 } })

// Refuses every read of ctx-guard's $.state from /deny-reads to /allow-reads, as a failing host would.
export const DENY_READS: Plugin = {
  name: 'deny-reads',
  register: on => {
    let deny = false
    on('command.run', { command: 'deny-reads' }, () => {
      deny = true
      return { text: '' }
    })
    on('command.run', { command: 'allow-reads' }, () => {
      deny = false
      return { text: '' }
    })
    on('state.get', { plugin: 'ctx-guard' }, async ($, e, next) => (deny ? { deny: 'state unreadable' } : next(e)))
  },
}

// A test plugin's register sees nothing of this file's scope: what it needs is written inside it.
// The engine empties ctx-guard's $.state right after a /clear's session.end; the kit
// does not, so this plugin plays the wipe: after /wipe every key reads as never
// written until ctx-guard writes it again. After /wipe-hold every key reads as never
// written whatever ctx-guard writes, so anything it still knows comes from memory.
// /wipe-sets counts ctx-guard's writes per key since the last /wipe.
export const WIPE: Plugin = {
  name: 'wipe',
  register: on => {
    const keys = ['band', 'cache', 'marks', 'roleClaim', 'config', 'pendingResume', 'pendingCompact', 'lastCompact', 'pause', 'lastClearAt', 'lastRestartAt', 'lastVerdict', 'lease', 'work', 'subagents', 'spawned', 'stamp', 'activity', 'lifts']
    const wiped = new Set<string>()
    let hold = false
    let sets: Record<string, number> = {}
    const wipe = (): void => {
      for (const k of keys) wiped.add(k)
      sets = {}
    }
    on('command.run', { command: 'wipe' }, () => {
      wipe()
      return { text: '' }
    })
    on('command.run', { command: 'wipe-hold' }, () => {
      wipe()
      hold = true
      return { text: '' }
    })
    on('command.run', { command: 'wipe-sets' }, () => ({ text: JSON.stringify(sets) }))
    on('state.get', { plugin: 'ctx-guard' }, async ($, e, next) => {
      const r = await next(e)
      return wiped.has(e.key) && 'value' in r && r.value ? { value: { value: undefined, version: r.value.version } } : r
    })
    on('state.set', { plugin: 'ctx-guard' }, async ($, e, next) => {
      sets[e.key] = (sets[e.key] ?? 0) + 1
      if (!hold) wiped.delete(e.key)
      return next(e)
    })
  },
}

export const wipeState = ($: Engine) => run($, 'wipe')

export async function turn($: Engine, phase: 'start' | 'end'): Promise<void> {
  if (phase === 'start') await $.turn.start({ text: 'go', turnId: 't1' })
  else await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

export const MIN = 60 * 1000

export const RACE_SETTLE_MS = 1500

export const STATE = `${ROOT}/.ctx-guard`

export const HANDOFF = `${STATE}/lead-handoff.md`

export const RESUME = 'ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md Carry on.'

export const RESTART_COMMANDS: World['commands'] = [
  { name: 'clear', source: 'builtin' },
  { name: 'compact', source: 'builtin' },
  { name: 'ctx-guard:resume', source: 'plugin', plugin: 'ctx-guard' },
]

export function autoConfig(restart: Record<string, unknown> = {}, handoff: Record<string, unknown> = {}) {
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

// Past the 300k trigger of autoConfig, so a context note asks for the restart.
export function restartWorld(over: Partial<World> = {}): World {
  return newWorld({ commands: RESTART_COMMANDS, tokens: 310_000, ...over })
}

// A handoff written a minute after the session start.
export async function writeHandoff(w: World, clock: MockClock, path = HANDOFF): Promise<void> {
  await clock.advance(MIN)
  w.files[path] = { text: '# handoff\n', mtimeMs: clock.now() }
}

export type Task = { id: string; type: string; status: string; description: string }

// The main turn's end as the engine raises it: its Stop (with what is in flight), then turn.complete.
export async function ready($: Engine, clock: MockClock, answer = 'Handoff written.\n\nCTX-READY', background: Task[] | 'none' = []): Promise<void> {
  await $.classic.Stop(background === 'none' ? { stop_hook_active: false } : { stop_hook_active: false, background_tasks: background })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  // The race's settle period after the stamp is written.
  await clock.advance(RACE_SETTLE_MS)
}

export const refusals = (s: MockSession): string[] => notes(s).filter(n => n.includes('CTX-READY ignored'))

// A trusted lead with a fresh handoff: everything a restart needs.
export async function armed($: Engine, on: On, w: World, config: unknown = autoConfig()): Promise<{ clock: MockClock; session: MockSession }> {
  writeConfig(w, config)
  const env = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  expect(await ctxGuard($, 'trust')).toContain('approved for /repo')
  await writeHandoff(w, env.clock)
  return env
}

export const PEEK_RESTART: Plugin = {
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

export async function peekRestart($: Engine): Promise<{ pendingResume: { step: string } | null; lastVerdict: { code: string } | null; band: { restartFailed: string | null; untrusted?: string | null } | null }> {
  const r = await $.command.run({ command: 'peek-restart', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

export const KEEP = 'Keep open tasks and file paths.'

export function compactConfig(restart: Record<string, unknown> = {}) {
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
export async function compactArmed($: Engine, on: On, w: World, config: unknown = compactConfig()): Promise<{ clock: MockClock; session: MockSession }> {
  const env = await armed($, on, w, config)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  return env
}

export async function mainTurnEnd($: Engine, clock: MockClock, answer = 'Done.'): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
}

export const status = (w: World): string => [...w.statuses].reverse().find(s => s !== undefined) ?? ''

// The step bottom answers each call with the next usage in `usages` (the last one repeats).
export function usageBottom(on: On, usages: { read: number; write: number; model?: string }[]): void {
  let i = 0
  on('turn.step', async function* ($, e) {
    const u = usages[Math.min(i++, usages.length - 1)] as { read: number; write: number; model?: string }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as never,
      usage: { input_tokens: 10, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, output_tokens: 50, model: u.model ?? 'm' },
    }
  })
}

export const CACHE_ROLE = (triggers: unknown[], cache: unknown = { ttl: '1h' }) => ({ version: 1, cache, roles: { lead: { triggers } } })

// The band as the stand-in status line drew it last (these tests start with surface 'vscode').
export const bandOfWorld = (w: World): string => w.statuses.at(-1) ?? ''

export const missToasts = (w: World): string[] => w.toasts.filter(t => t.includes('cache miss'))

export const CTX_GUARD = { kind: 'plugin', name: 'ctx-guard' } as const

export const KEEP_WARM_TRIGGERS = [
  { id: 'warm', when: { 'cache.expiresIn': '5m', context: '50k' }, do: ['ping'], times: 3 },
  { id: 'away', when: { 'cache.expiresIn': '5m', 'cache.pings': 3 }, do: ['prompt', 'notify'], times: 1 },
]

export const KEEP_WARM = CACHE_ROLE(KEEP_WARM_TRIGGERS)

export const WARM_READ = { read: 150_000, write: 0 }

export const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// What the fork bottom answers: a read and a write, after `hang` ms when given, or an API error.
export type ForkAnswer = { read: number; write: number; hang?: number } | 'error'

// The fork bottom answers each call with the next of `answers`, recording its prompt.
export function forkBottom(on: On, clock: MockClock, answers: () => ForkAnswer, calls: string[]): void {
  on('model.fork', async ($, e) => {
    calls.push(e.prompt)
    const a = answers()
    if (a === 'error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: NO_USAGE } } as never
    if (a.hang) await clock.sleep(a.hang)
    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } } as never
  })
}

export type KeepWarm = { config?: unknown; answers?: () => ForkAnswer; trust?: boolean }

// A keep-warm session: the config approved (unless `trust` is false), one main turn with a warm request, then idle.
export async function trustedKeepWarm($: Engine, on: On, w: World, o: KeepWarm = {}): Promise<{ clock: MockClock; forks: string[] }> {
  writeConfig(w, o.config ?? KEEP_WARM)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [WARM_READ])
  const forks: string[] = []
  forkBottom(on, clock, o.answers ?? (() => WARM_READ), forks)
  await start($, 'vscode')
  if (o.trust !== false) await ctxGuard($, 'trust')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  return { clock, forks }
}

export const ownPrompts = (w: World): string[] => w.prompts.filter(p => p.startsWith('[ctx-guard]'))

export const compacts = (w: World): string[] => w.ran.filter(r => r.startsWith('compact'))
