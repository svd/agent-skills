// ctx-guard's `/ctx-guard` command and start-up checks: argument parsing, the
// pause, `init` presets and .gitignore lines, the report text, the engine
// version gate and the command-collision check. Pure: no `$`, never throws.
import type { Action, Budget, Config, ConfigState, Display, LastVerdict, Marks, Pause, RestartMode, Trigger, TtlSource } from '../types'
import { liftHas, parseQuantity, roleSpec, validate } from './config'
import { humanDuration, humanPercent, humanQuantity, humanTokens, humanUsd, resetsInMs, windowName } from './messages'
import { listedRoles } from './roles'
import type { RoleResolution } from './roles'
import { METRIC_ORDER, contextPercent, holdsBelow } from './triggers'
import type { DenyEntry, Metrics } from './triggers'
import type { CheckLine } from './restart'
import { shortId } from './subagents'

export const COMMAND = 'ctx-guard'
// The first engine with every event and `$` call ctx-guard uses.
export const MIN_VERSION = '2.1.293'
export const DEFAULT_PAUSE_MS = 30 * 60 * 1000

export const ARGUMENT_HINT = '[role <name|none> | check | trust [off] | reload | pause [30m|off] | init [solo|peers]]'

export const USAGE = [
  'Usage:',
  '  /ctx-guard                   report: role, config, metrics, marks, blocks',
  '  /ctx-guard role <name|none>  set this session\'s role (typed by you only)',
  '  /ctx-guard check             dry-run the restart guard: each check and its verdict',
  '  /ctx-guard trust             approve this repo\'s restart, ready-check and compact settings (typed by you only)',
  '  /ctx-guard trust off         withdraw that approval (typed by you only)',
  '  /ctx-guard reload            re-read the config files',
  '  /ctx-guard pause [30m|off]   lift tool blocks and automatic actions for a while; notes go on',
  '  /ctx-guard init [solo|peers] write a starter config if there is none, and .gitignore lines',
].join('\n')

// ---- arguments ---------------------------------------------------------------

export type Preset = 'solo' | 'peers'
export const PRESETS: readonly Preset[] = ['solo', 'peers']

export type Subcommand =
  | { kind: 'report' }
  | { kind: 'role'; arg: string }
  | { kind: 'reload' }
  | { kind: 'check' }
  | { kind: 'trust' }
  | { kind: 'trust-off' }
  | { kind: 'pause'; arg: string }
  | { kind: 'init'; preset: Preset }
  | { kind: 'usage'; error: string | null }

export function parseCommand(args: string): Subcommand {
  const text = (typeof args === 'string' ? args : '').trim()
  if (text === '') return { kind: 'report' }
  const [head = '', ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')
  switch (head.toLowerCase()) {
    case 'role':
      return { kind: 'role', arg }
    case 'trust':
      if (arg.toLowerCase() === 'off') return { kind: 'trust-off' }
      return arg ? { kind: 'usage', error: 'trust takes no arguments but off' } : { kind: 'trust' }
    case 'reload':
    case 'check': {
      const kind = head.toLowerCase() as 'reload' | 'check'
      return arg ? { kind: 'usage', error: `${kind} takes no arguments` } : { kind }
    }
    case 'pause':
      return { kind: 'pause', arg }
    case 'init': {
      const preset = (arg || 'solo').toLowerCase()
      return (PRESETS as readonly string[]).includes(preset)
        ? { kind: 'init', preset: preset as Preset }
        : { kind: 'usage', error: `unknown preset "${arg}"; use solo or peers` }
    }
    default:
      return { kind: 'usage', error: `unknown subcommand "${head}"` }
  }
}

// ms null lifts the pause.
export type PauseArg = { ok: true; ms: number | null } | { ok: false; error: string }

export function parsePause(arg: string): PauseArg {
  const a = (typeof arg === 'string' ? arg : '').trim()
  if (a === '') return { ok: true, ms: DEFAULT_PAUSE_MS }
  if (/^(off|resume|none)$/i.test(a)) return { ok: true, ms: null }
  const q = parseQuantity(a, ['duration'])
  return q ? { ok: true, ms: q.value } : { ok: false, error: `"${a}" is not a duration ("10m", "1h") or "off"` }
}

export function isPaused(pause: Pause | null | undefined, now: number): boolean {
  return typeof pause?.until === 'number' && Number.isFinite(pause.until) && now < pause.until
}

// ---- init --------------------------------------------------------------------

// `init` copies the preset files the skill ships, byte for byte, so the
// starter and the documented preset are one file and cannot drift apart.
export const PRESET_DIR = 'skills/guide/assets/presets'

/** Where a preset sits under the plugin's own root. */
export function presetPath(pluginRoot: string, preset: Preset): string {
  return `${pluginRoot.replace(/[/\\]+$/, '')}/${PRESET_DIR}/${preset}.json`
}

/** Why a shipped preset's text is not a valid config, or null when it is. */
export function presetProblem(text: string, preset: Preset): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return `the ${preset} preset is not valid JSON (${e instanceof Error ? e.message : String(e)})`
  }
  const errors = validate(raw, `${preset} preset`).errors
  return errors.length ? errors.join('; ') : null
}

/** What `init` adds when the written config asks for automatic actions the repo has not approved. */
export const INIT_TRUST_HINT =
  'Its automatic clear, compact and ready checks stay off, and notes ask for the operator, until you review it and run /ctx-guard trust.'

// The trigger actions that run unattended, so trust gates them.
const TRUST_ACTIONS: readonly Action[] = ['compact', 'ping', 'prompt']

/** True when a role restarts on its own or a trigger compacts, pings or prompts (on its lift too): the actions trust gates. */
export function wantsTrust(config: Config): boolean {
  return Object.keys(config.roles).some(name => {
    const spec = roleSpec(config, name)
    return spec !== null && (spec.restart.mode === 'auto' || spec.triggers.some(t => t.do.some(a => TRUST_ACTIONS.includes(a)) || liftHas(t, 'prompt')))
  })
}

// `x`, `/x`, `x/` and `/x/` ignore the same path here.
const ignoreKey = (line: string): string => line.trim().replace(/^\/+/, '').replace(/\/+$/, '')

/**
 * `.gitignore` text with each of `lines` it lacks appended, and which those
 * were; null when it already lists them all. A missing file is null text.
 */
export function gitignoreWith(existing: string | null, lines: readonly string[]): { text: string; added: string[] } | null {
  const have = new Set((existing ?? '').split(/\r?\n/).map(ignoreKey).filter(Boolean))
  const added: string[] = []
  for (const line of lines) {
    const key = ignoreKey(line)
    if (key && !have.has(key)) {
      have.add(key)
      added.push(line)
    }
  }
  if (!added.length) return null
  const base = existing ?? ''
  const sep = base === '' || base.endsWith('\n') ? '' : '\n'
  return { text: `${base}${sep}${added.join('\n')}\n`, added }
}

// ---- start-up checks ---------------------------------------------------------

function triple(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when the engine's release is older than `min`; an unreadable version is not. */
export function versionBelow(v: { version: string; base?: string }, min: string): boolean {
  const have = triple(v.base ?? v.version ?? '')
  const need = triple(min)
  if (!have || !need) return false
  for (let i = 0; i < 3; i++) if ((have[i] as number) !== (need[i] as number)) return (have[i] as number) < (need[i] as number)
  return false
}

export type CommandEntry = { name: string; source: string; plugin?: string }

/**
 * A command named `name` that some other plugin, a user file or an MCP
 * prompt owns, or a skill or command listed as `name:name`, to which the
 * engine maps a bare `/name` (a plugin's own skill named after the plugin);
 * null when there is none. A plugin command whose owner the engine does not
 * name is taken as this plugin's own (a previous load's registration).
 */
export function collidingCommand(commands: readonly CommandEntry[], name: string, self: string): CommandEntry | null {
  const other = commands.find(c => c.name === name && !(c.source === 'plugin' && (c.plugin === undefined || c.plugin === self)))
  return other ?? commands.find(c => c.name === `${name}:${name}`) ?? null
}

// ---- report ------------------------------------------------------------------

function whenText(t: Trigger): string {
  const parts: string[] = []
  for (const metric of METRIC_ORDER) {
    const q = t.when[metric]
    if (q) parts.push(`${metric} ${holdsBelow(metric) ? '≤' : '≥'} ${humanQuantity(q)}`)
  }
  if (t.when.every) parts.push(`every ${humanQuantity(t.when.every)}`)
  return parts.join(' and ')
}

function doText(t: Trigger): string {
  return t.do.map(a => (typeof a === 'string' ? a : `deny ${a.deny.join(', ')}`)).join(', ')
}

// `; lift → note, prompt (times 3)`; empty with no lift.
function liftText(t: Trigger): string {
  const l = t.lift
  return l ? `; lift → ${l.do.join(', ')}${l.times === null ? '' : ` (times ${l.times})`}` : ''
}

/** One line per trigger: `id: context ≥ 70% and every 10% → note, deny Agent [stop] (times 2)`, then its lift. */
export function triggerLine(t: Trigger): string {
  return `${t.id}: ${whenText(t)} → ${doText(t)}${t.level ? ` [${t.level}]` : ''}${t.times === null ? '' : ` (times ${t.times})`}${liftText(t)}`
}

function ago(ms: number): string {
  return `${humanDuration(Math.max(0, ms))} ago`
}

const SOURCE_TEXT: Record<string, string> = {
  command: '/ctx-guard role',
  resume: '/ctx-guard:resume or a restart command',
  env: 'CTX_GUARD_ROLE',
  'repo-default': 'project defaultRole',
  'user-default': 'userConfig defaultRole',
}

export type ReportInput = {
  now: number
  interactive: boolean
  // Why ctx-guard does nothing in this session; null when it is on.
  off: string | null
  pause: Pause | null
  role: RoleResolution
  // When the session's role claim was made (/ctx-guard role or /ctx-guard:resume); null without one.
  claimAt?: number | null
  configState: ConfigState | null
  config: Config
  switches: { blocking: boolean; autoActions: boolean; noteToasts: boolean; display: Display }
  // Where the window came from (resolveWindow's source).
  windowSource: string
  // The restart mode a note promises now (auto drops to manual while untrusted).
  mode: RestartMode | null
  metrics: Metrics
  marks: Marks | null
  triggers: readonly Trigger[]
  denies: readonly DenyEntry[]
  lastClearAt: number | null
  // The restart guard's state; absent leaves its lines out.
  restart?: RestartReport
  // The subagent budgets and the agents followed; absent leaves the table out.
  subagents?: SubagentReport
  // Band probes and their last run; absent leaves the lines out.
  probes?: { id: string; state: string }[]
  // The main thread's prompt cache; absent leaves its line out.
  cache?: CacheReport
}

export type CacheReport = {
  ttl: number
  source: TtlSource
  // Time left before expiry, less the margin; null before the first main request.
  expiresIn: number | null
  // A main turn runs: the cache is in use.
  busy: boolean
  // Warm pings in this idle period and the pinging trigger's `times` (null: no cap); null without a pinging trigger.
  pings: { n: number; cap: number | null } | null
  // A ping in this idle period found the cache gone.
  cold: boolean
  miss: number
  missCause: 'model' | 'prefix' | null
  // A failed or put-off ping or prompt, tried again on the next idle tick.
  retry: { kind: 'ping' | 'prompt'; triggerId: string; tries: number } | null
}

const TTL_SOURCE: Record<TtlSource, string> = { config: 'from config', transcript: 'from the transcript', observed: 'observed', guess: 'a guess' }

/** `cache: TTL 1h (observed); expires in 12m; pings 1/3; last miss 140k (prefix changed)`. */
export function cacheLine(c: CacheReport): string {
  const left =
    c.expiresIn === null ? 'no main request yet' : c.busy ? 'in use by the running turn' : c.expiresIn <= 0 ? 'expired' : `expires in ${humanDuration(c.expiresIn)}`
  const parts = [`TTL ${humanDuration(c.ttl)} (${TTL_SOURCE[c.source]})`, left]
  if (c.pings) parts.push(`pings ${c.pings.n}${c.pings.cap === null ? '' : `/${c.pings.cap}`}`)
  if (c.cold) parts.push('cold (a ping found it gone)')
  if (c.miss > 0) parts.push(`last miss ${humanTokens(c.miss)}${c.missCause === 'model' ? ' (model switch)' : c.missCause === 'prefix' ? ' (prefix changed)' : ''}`)
  if (c.retry) parts.push(`${c.retry.kind} of "${c.retry.triggerId}" waits for its retry (try ${c.retry.tries})`)
  return `cache: ${parts.join('; ')}`
}

export type SubagentRow = {
  id: string
  type: string | null
  tokens: number
  warn: number | null
  stop: number | null
  state: 'under' | 'warned' | 'stopped'
}

export type SubagentReport = {
  // Why no budget applies now (no role, none configured); null when they do.
  off: string | null
  // Why a stopped agent's tool calls go through anyway (blocking off, a pause); null when they are refused.
  noDeny: string | null
  // Each configured type merged over "*"; null when it has no step at all.
  budgets: readonly { type: string; budget: Budget | null }[]
  rows: readonly SubagentRow[]
}

export type RestartReport = {
  trusted: boolean
  // False when an approval would turn nothing on; absent counts as true.
  wanted?: boolean
  // Fields that need approval while untrusted.
  changed: readonly string[]
  approvedAt: number | null
  lastVerdict: LastVerdict | null
  // The handoff path and its mtime (null: absent); null when there is no role.
  handoff: { path: string; mtime: number | null } | null
  // Who holds the role lease: `this session`, another id, `free`; null with no role.
  lease: string | null
  pending: string | null
  // The role's selfGap (0: off) and this session's last restart on the ready token; absent with no role.
  selfGap?: { gap: number; lastRestartAt: number | null } | null
  // A compact a trigger queued, and the last compact ctx-guard ran or gave up on; absent leaves them out.
  pendingCompact?: string | null
  lastCompact?: string | null
}

function trustLine(t: RestartReport, now: number): string {
  if (t.trusted) return `trust: approved${t.approvedAt === null ? '' : ` ${ago(now - t.approvedAt)}`}`
  if (t.wanted === false) return 'trust: not needed (nothing automatic: no auto restart, compact, ping or prompt trigger, lift prompt, or probe)'
  const what = t.changed.length ? ` (needs approval: ${t.changed.join(', ')})` : ''
  return `trust: not approved${what}; automatic clear, compact, ping, prompt, lift prompts and ready checks stay off until the operator runs /ctx-guard trust`
}

// How long the ready token stays refused as too-soon, mirroring restart.ts's check.
function selfGapLine(s: { gap: number; lastRestartAt: number | null }, now: number): string {
  if (s.gap <= 0) return 'self gap: off (selfGap 0)'
  const gap = humanDuration(s.gap)
  if (s.lastRestartAt === null) return `self gap: ${gap}; no restart yet in this session`
  const since = now - s.lastRestartAt
  const left = s.gap - since
  return left > 0
    ? `self gap: ${gap}; last restart ${ago(since)}, ready token refused (too-soon) for ${humanDuration(left)} more`
    : `self gap: ${gap}; last restart ${ago(since)}, passed`
}

function restartLines(t: RestartReport, now: number): string[] {
  const lines = [trustLine(t, now)]
  const v = t.lastVerdict
  lines.push(`last verdict: ${v ? `${v.code} (${ago(now - v.at)})${v.text ? `: ${v.text}` : ''}` : 'none'}`)
  if (t.selfGap) lines.push(selfGapLine(t.selfGap, now))
  if (t.handoff) lines.push(`handoff: ${t.handoff.path}, ${t.handoff.mtime === null ? 'absent' : `written ${ago(now - t.handoff.mtime)}`}`)
  if (t.lease) lines.push(`lease: ${t.lease}`)
  if (t.pending) lines.push(`pending resume: ${t.pending}`)
  if (t.pendingCompact) lines.push(`queued compact: ${t.pendingCompact}`)
  if (t.lastCompact) lines.push(`last compact: ${t.lastCompact}`)
  return lines
}

/** The `/ctx-guard check` answer: one line per check, then the verdict. */
export function checkText(role: string | null, via: string | null, lines: readonly CheckLine[] | null, note: string | null): string {
  if (role === null || via === null || lines === null) return `ctx-guard check: ${note ?? 'no role, so no restart to check'}`
  const mark = { pass: 'ok  ', fail: 'FAIL', skip: '--  ' } as const
  const out = [`ctx-guard check (dry run, role ${role}, via ${via}; nothing written or cleared):`]
  for (const l of lines) out.push(`  ${mark[l.status]} ${l.code}: ${l.text}`)
  const failed = lines.find(l => l.status === 'fail')
  out.push(failed ? `verdict: refused (${failed.code})` : 'verdict: would restart (the race is judged at the real one)')
  if (note) out.push(note)
  return out.join('\n')
}

/** The `/ctx-guard` report, plain text. */
export function reportText(r: ReportInput): string {
  const lines: string[] = []
  const paused = isPaused(r.pause, r.now)
  lines.push(
    `ctx-guard: ${r.off ? `off (${r.off})` : paused ? `paused for ${humanDuration((r.pause?.until ?? r.now) - r.now)} more` : 'on'}`,
  )

  const role = r.role.role
  // A claim lasts the whole session, /clear and plugin reloads included: its age says how old it is.
  const at = r.role.source === 'command' || r.role.source === 'resume' ? r.claimAt : null
  const set = typeof at === 'number' ? `, set ${ago(r.now - at)}` : ''
  const from = r.role.source ? ` (from ${SOURCE_TEXT[r.role.source] ?? r.role.source}${set})` : ''
  lines.push(`role: ${role ?? 'none'}${from}${r.interactive ? '' : ' (non-interactive session: no role)'}`)
  if (r.role.problem) lines.push(`  problem: ${r.role.problem}`)

  const cs = r.configState
  lines.push(`config: ${cs ? cs.source : 'not loaded'}`)
  for (const f of cs?.files ?? []) lines.push(`  ${f.path}: ${f.mtime === null ? 'absent' : `modified ${ago(r.now - f.mtime)}`}`)
  for (const e of cs?.errors ?? []) lines.push(`  error: ${e}`)

  const c = r.config
  const roles = listedRoles(c, role)
  lines.push(
    `effective: roles ${roles.length ? roles.join(', ') : 'none'}; defaultRole ${c.defaultRole ?? 'none'}; ` +
      `contextWindow ${c.contextWindow === 'auto' ? 'auto' : humanTokens(c.contextWindow)} = ${humanTokens(r.metrics.window)} (${r.windowSource}); ` +
      `stateDir ${c.stateDir}; readyToken ${c.readyToken}`,
  )
  lines.push(
    `switches: blocking ${r.switches.blocking ? 'on' : 'off'}; autoActions ${r.switches.autoActions ? 'on' : 'off'}; noteToasts ${r.switches.noteToasts ? 'on' : 'off'}; display ${r.switches.display}`,
  )
  lines.push(`triggers${role ? ` of ${role}` : ' (no role: toasts only)'}:`)
  for (const t of r.triggers) lines.push(`  ${triggerLine(t)}`)
  if (r.mode) lines.push(`restart: ${r.mode}`)

  const m = r.metrics
  const pct = contextPercent(m)
  lines.push(`context: ${m.tokens === null ? 'unknown (no response yet)' : `${humanTokens(m.tokens)} (${pct === null ? '?' : humanPercent(pct)} of ${humanTokens(m.window)})`}`)
  const limits = [m.limits.five_hour && { kind: 'five_hour', ...m.limits.five_hour }, m.limits.seven_day && { kind: 'seven_day', ...m.limits.seven_day }]
  const shown = limits.filter((x): x is { kind: string; pct: number; resetsAt: string | null } => Boolean(x))
  if (!shown.length) lines.push('usage: no rate-limit windows reported')
  for (const l of shown) {
    const left = resetsInMs(l.resetsAt, r.now)
    lines.push(`usage ${windowName(l.kind)}: ${humanPercent(l.pct)}${left === null ? '' : `, resets in ${humanDuration(left)}`}`)
  }
  if (m.cost !== null) lines.push(`cost: ${humanUsd(m.cost)}`)
  lines.push(`idle: ${m.idleMs === null ? 'no turn has ended yet' : m.idleMs === 0 ? 'a turn is running' : humanDuration(m.idleMs)}`)
  if (r.cache) lines.push(cacheLine(r.cache))
  if (r.lastClearAt !== null) lines.push(`last /clear: ${ago(r.now - r.lastClearAt)}`)

  const marks = Object.entries(r.marks?.byId ?? {})
  lines.push(`marks: ${marks.length ? marks.map(([id, mk]) => `${id}${mk.step ? `@${mk.step}` : ''} (${ago(r.now - mk.at)})`).join(', ') : 'none'}`)
  lines.push(`blocks: ${r.denies.length ? r.denies.map(d => `${d.tool} (${d.triggerId})`).join(', ') : 'none'}`)
  if (r.probes) {
    if (!r.probes.length) lines.push('band probes: none')
    for (const p of r.probes) lines.push(`probe ${p.id}: ${p.state}`)
  }
  if (r.restart) lines.push(...restartLines(r.restart, r.now))
  if (r.subagents) lines.push(...subagentLines(r.subagents))
  else {
    const budgets = Object.keys(c.subagents).sort()
    lines.push(`subagent budgets: ${budgets.length ? budgets.join(', ') : 'none'}`)
  }
  return lines.join('\n')
}

const tokensOr = (v: number | null): string => (v === null ? '-' : humanTokens(v))

function budgetText({ type, budget: b }: { type: string; budget: Budget | null }): string {
  if (!b) return `${type} off`
  const steps = [b.warn === null ? null : `warn ${humanTokens(b.warn)}`, b.stop === null ? null : `stop ${humanTokens(b.stop)}`].filter(Boolean)
  return `${type} ${steps.join(', ')}${b.message === null ? '' : ', own stop message'}`
}

function subagentLines(s: SubagentReport): string[] {
  const lines = [`subagent budgets: ${s.budgets.length ? s.budgets.map(budgetText).join('; ') : 'none'}${s.off ? ` (${s.off})` : ''}`]
  if (!s.rows.length) return [...lines, 'subagents: none followed']
  lines.push('subagents:')
  const cells = s.rows.map(row => [
    shortId(row.id),
    row.type ?? 'unknown',
    humanTokens(row.tokens),
    tokensOr(row.warn),
    tokensOr(row.stop),
    row.state === 'stopped' ? `stopped (${s.noDeny ? `tool calls allowed: ${s.noDeny}` : 'tool calls refused'})` : row.state,
  ])
  const table = [['id', 'type', 'fill', 'warn', 'stop', 'state'], ...cells]
  const widths = table[0]?.map((_, i) => Math.max(...table.map(r => (r[i] ?? '').length))) ?? []
  for (const r of table) lines.push(`  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')}`)
  return lines
}
