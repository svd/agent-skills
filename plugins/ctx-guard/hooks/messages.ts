// ctx-guard text: templates, humanized figures, notes keyed to level, the
// restart tail, deny reasons, refusals, subagent budget notes and toasts.
// Pure: no `$`, never throws. Texts carry numbers, names and paths only.
import type { Level, Quantity, RestartMode, RestartVia, RoleSpec, Trigger } from '../types'
import type { Condition, Fire, FireVars, LimitInfo, LimitKind, Metrics } from './triggers'
import { conditions, denyTools, fireVars, isResetsIn, resetsInMs } from './triggers'

export const PREFIX = '[ctx-guard]'

// ---- templates and figures ---------------------------------------------------

export const TEMPLATE_VARS = ['role', 'tokens', 'percent', 'threshold', 'window', 'limit', 'resetsIn', 'handoffPath', 'readyToken', 'idle', 'expiresIn', 'id', 'tools', 'liftsIn'] as const

export const DEFAULT_PROMPT = `${PREFIX} The user has been away {idle}; the prompt cache expires in {expiresIn}. Write the handoff to {handoffPath} and stop; do not start new work.`

/** Fills `{name}` from `vars`; an unknown `{x}` stays as written. */
export function render(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (all, name: string) => (Object.hasOwn(vars, name) ? (vars[name] ?? all) : all))
}

const trim1 = (n: number): string => n.toFixed(1).replace(/\.0$/, '')

/** 850, 1.5k, 312k, 1M, 1.2M. */
export function humanTokens(n: number): string {
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (a < 10_000) return `${trim1(n / 1000)}k`
  if (Math.round(a / 1000) < 1000) return `${Math.round(n / 1000)}k`
  return `${trim1(n / 1e6)}M`
}

/** 31%; one decimal below 10 (7.5%). */
export function humanPercent(p: number): string {
  return Math.abs(p) < 10 ? `${trim1(p)}%` : `${Math.round(p)}%`
}

/** 45s, 12m, 2h10m, 3d4h. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`
}

export function humanUsd(v: number): string {
  return `$${v.toFixed(2)}`
}

export function humanQuantity(q: Quantity): string {
  switch (q.kind) {
    case 'tokens':
      return humanTokens(q.value)
    case 'percent':
      return humanPercent(q.value)
    case 'duration':
      return humanDuration(q.value)
    case 'usd':
      return humanUsd(q.value)
    case 'count':
      return String(q.value)
  }
}

export { resetsInMs }

export function windowName(kind: string): string {
  return kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'weekly' : kind
}

const UNKNOWN = 'unknown'

function limitText(limit: LimitInfo | null): string {
  return limit ? `${windowName(limit.kind)} ${humanPercent(limit.pct)}` : UNKNOWN
}

function resetsText(limit: LimitInfo | null, now: number): string {
  const ms = limit ? resetsInMs(limit.resetsAt, now) : null
  return ms === null ? UNKNOWN : humanDuration(ms)
}

/** The role's handoff path with `{role}` filled in. */
export function handoffPathFor(spec: RoleSpec, role: string): string {
  return spec.handoff.path.replace(/\{role\}/g, role)
}

/** The role's handoff instructions with `{role}` filled in; null when none. */
export function handoffInstructionsFor(spec: RoleSpec, role: string): string | null {
  return spec.handoff.instructions === null ? null : spec.handoff.instructions.replace(/\{role\}/g, role)
}

export type NoteContext = { role: string | null; handoffPath: string | null; readyToken: string }

/** Every template variable for a fired trigger, humanized; a lift's texts add `liftReason`. */
export function templateVars(vars: FireVars, ctx: NoteContext, trigger: Trigger | null = null): Record<string, string> {
  return {
    id: trigger?.id ?? UNKNOWN,
    tools: trigger ? denyTools(trigger).join(', ') || UNKNOWN : UNKNOWN,
    liftsIn: vars.liftsIn === null || vars.liftsIn === undefined ? UNKNOWN : humanDuration(vars.liftsIn),
    role: ctx.role ?? 'none',
    tokens: vars.tokens === null ? UNKNOWN : humanTokens(vars.tokens),
    percent: vars.percent === null ? UNKNOWN : humanPercent(vars.percent),
    threshold: vars.threshold === null ? UNKNOWN : humanQuantity(vars.threshold),
    window: humanTokens(vars.window),
    limit: limitText(vars.limit),
    resetsIn: resetsText(vars.limit, vars.now),
    handoffPath: ctx.handoffPath ?? UNKNOWN,
    readyToken: ctx.readyToken,
    idle: vars.idleMs === null ? UNKNOWN : humanDuration(vars.idleMs),
    expiresIn: vars.expiresIn === null ? UNKNOWN : humanDuration(vars.expiresIn),
  }
}

/** What a `prompt` action submits: the trigger's message, else the default, with template variables filled. */
export function promptText(fire: Fire, ctx: NoteContext): string {
  return render(fire.trigger.message ?? DEFAULT_PROMPT, templateVars(fire.vars, ctx, fire.trigger))
}

/**
 * Whether a prompt a `prompt.submit` hook sees is the one ctx-guard is
 * submitting (`ownText` non-null while it does): origin ctx-guard and no slash
 * command. The text is not compared, as a hook above may have rewritten it;
 * ctx-guard's resume command and every other prompt are not its own.
 */
export function isOwnPrompt(e: { origin?: { kind: string; name?: string }; command?: unknown }, ownText: string | null): boolean {
  const o = e.origin
  return ownText !== null && o?.kind === 'plugin' && o.name === 'ctx-guard' && e.command === undefined
}

const MISS_CAUSE = { model: 'model switch', prefix: 'prefix changed: CLAUDE.md, tools or MCP?' } as const

// " (model switch)" for a miss with a known cause; empty otherwise.
const missWhy = (v: FireVars): string => (v.missCause ? ` (${MISS_CAUSE[v.missCause]})` : '')

const missTokens = (v: FireVars): string => (v.miss === null ? UNKNOWN : humanTokens(v.miss))

// ---- notes -------------------------------------------------------------------

const isLimit = (metric: string): boolean => metric.startsWith('limit.')

// What the figure is, by metric: "Context is at 312k (31% of 1M), past 300k."
function head(vars: FireVars): string {
  const now = vars.now
  const v = templateVars(vars, { role: null, handoffPath: null, readyToken: '' })
  if (isLimit(vars.metric)) {
    const which = vars.limit ? `${windowName(vars.limit.kind)} usage` : 'Usage'
    const pct = vars.limit ? humanPercent(vars.limit.pct) : UNKNOWN
    const ms = vars.limit ? resetsInMs(vars.limit.resetsAt, now) : null
    const reset = ms === null ? '' : ` The window resets in ${humanDuration(ms)}.`
    return `${which[0]?.toUpperCase()}${which.slice(1)} is at ${pct}, past ${v.threshold}.${reset}`
  }
  if (vars.metric === 'cost') return `Session cost is ${vars.cost === null ? UNKNOWN : humanUsd(vars.cost)}, past ${v.threshold}.`
  if (vars.metric === 'idle') {
    return `The session has been idle for ${vars.idleMs === null ? UNKNOWN : humanDuration(vars.idleMs)}, past ${v.threshold}.`
  }
  if (vars.metric === 'cache.miss') {
    return `A request rewrote ${missTokens(vars)} tokens of a prompt cache that should have been warm${missWhy(vars)}.`
  }
  if (vars.metric === 'cache.expiresIn' || vars.metric === 'cache.pings') {
    return `The prompt cache expires in ${v.expiresIn}; the session has been idle for ${v.idle}.`
  }
  return `Context is at ${v.tokens} (${v.percent} of ${v.window}), past ${v.threshold}.`
}

// Keyed to the level alone, so the text reads right with any number of triggers.
const LEVEL_TEXT: Record<Level | 'none', { context: string; limit: string }> = {
  none: {
    context: 'Keep this in mind as you plan the next steps.',
    limit: 'Keep this in mind as you plan the next steps.',
  },
  soft: {
    context: 'Plan for a handoff: finish the item in hand and keep new work small.',
    limit: 'Prefer cheaper steps: fewer subagents and no speculative work.',
  },
  hard: {
    context: 'Wrap up: start no new item and bring the current one to a safe point.',
    limit: 'Wrap up: start no new item, dispatch only what the current one needs, and bring it to a safe point.',
  },
  stop: {
    context: 'Stop: dispatch nothing new and start no new work.',
    limit: 'Stop: dispatch nothing new and start no new work.',
  },
}

// A role that compacts instead of clearing writes no handoff: its soft note plans for the compaction.
const COMPACT_SOFT = 'Plan for a compaction: finish the item in hand and keep new work small.'

export function levelText(level: Level | null, metric: string, via: RestartVia = 'clear'): string {
  const t = LEVEL_TEXT[level ?? 'none']
  if (isLimit(metric)) return t.limit
  return via === 'compact' && level === 'soft' ? COMPACT_SOFT : t.context
}

function sentence(s: string): string {
  const t = s.trim()
  return /[.!?:]$/.test(t) ? t : `${t}.`
}

const SAFE_POINT = 'At the next safe point — no subagents running, current work recorded —'

export type RestartGates = { autoActions: boolean; trusted: boolean; paused: boolean }

/**
 * The mode a note may promise: `auto` drops to `manual` when ctx-guard would
 * not act on the ready token (auto actions off, repo untrusted, paused).
 */
export function effectiveMode(spec: RoleSpec, gates: RestartGates): RestartMode {
  const mode = spec.restart.mode
  return mode === 'auto' && (!gates.autoActions || !gates.trusted || gates.paused) ? 'manual' : mode
}

const readyFor = (via: RestartVia): string => (via === 'compact' ? 'ready for /compact' : 'ready for /clear')

/** What a note ends with by restart mode; empty with mode off. */
export function restartTail(spec: RoleSpec, role: string, readyToken: string, mode: RestartMode = spec.restart.mode): string {
  const { via } = spec.restart
  if (mode === 'off') return ''
  const instructions = handoffInstructionsFor(spec, role)
  const write = via === 'compact' ? '' : ` write the handoff to \`${handoffPathFor(spec, role)}\`${instructions ? `: ${sentence(instructions)}` : '.'}`
  const after = readyFor(via)
  if (mode === 'manual') return write ? `${SAFE_POINT}${write} Then tell the operator '${after}'.` : `${SAFE_POINT} tell the operator '${after}'.`
  if (!write) return `${SAFE_POINT} end your reply with a line holding only \`${readyToken}\`; ctx-guard then compacts the session.`
  return `${SAFE_POINT}${write} Then end your reply with a line holding only \`${readyToken}\`.`
}

export type NoteOptions = {
  role: string
  spec: RoleSpec
  readyToken: string
  // From effectiveMode(); the configured mode when absent.
  mode?: RestartMode
}

export type NoteInput = NoteOptions & { trigger: Trigger; vars: FireVars }

const LEVEL_RANK: Record<Level | 'none', number> = { none: 0, soft: 1, hard: 2, stop: 3 }
const rank = (f: Fire): number => LEVEL_RANK[f.trigger.level ?? 'none']

// Crossings of one figure collapse to the highest threshold.
function figureKey(v: FireVars): string {
  return isLimit(v.metric) ? `limit:${v.limit?.kind ?? ''}` : v.metric
}

const unprefixed = (t: string): string => (t.startsWith(PREFIX) ? t.slice(PREFIX.length).trim() : t)

/**
 * One model note for every note trigger an evaluation fired: one head per
 * figure (its highest threshold), the wording of the highest level, custom
 * messages rendered, then one restart tail (only when a fired trigger has a
 * context condition) and one `notes.suffix`. Null for no fires. A cold start
 * past several thresholds thus sends one note.
 */
export function collapseNotes(fires: readonly Fire[], opts: NoteOptions): string | null {
  if (fires.length === 0) return null
  const { role, spec, readyToken } = opts
  const handoffPath = handoffPathFor(spec, role)
  const tvOf = (f: Fire): Record<string, string> => templateVars(f.vars, { role, handoffPath, readyToken }, f.trigger)

  const builtIn = fires.filter(f => f.trigger.message === null)
  const byFigure = new Map<string, Fire>()
  for (const f of builtIn) {
    const key = figureKey(f.vars)
    const had = byFigure.get(key)
    if (!had || (f.vars.threshold?.value ?? 0) > (had.vars.threshold?.value ?? 0)) byFigure.set(key, f)
  }
  const top = [...builtIn].sort((a, b) => rank(b) - rank(a))[0]
  const parts = [...byFigure.values()].map(f => head(f.vars))
  if (top) parts.push(levelText(top.trigger.level, top.vars.metric, spec.restart.via))
  for (const f of fires) if (f.trigger.message !== null) parts.push(unprefixed(render(f.trigger.message, tvOf(f)).trim()))
  // A restart frees context only: a note on usage, cost or idle alone asks for none, or a /clear would
  // land back on the same figure and the same note.
  const asks = fires.some(f => f.trigger.when.context !== null)
  return `${PREFIX} ${[...parts, ...noteClose(opts, asks, tvOf(top ?? (fires[0] as Fire)))].filter(Boolean).join(' ')}`
}

// A note's close: the restart tail (when it asks for a restart), then `notes.suffix` filled from `vars`.
function noteClose(opts: NoteOptions, asks: boolean, vars: Readonly<Record<string, string>>): string[] {
  const { role, spec, readyToken } = opts
  return [asks ? restartTail(spec, role, readyToken, opts.mode ?? spec.restart.mode) : '', spec.notes.suffix ? render(spec.notes.suffix, vars).trim() : '']
}

/** The note for one fired trigger; see collapseNotes. */
export function noteText(input: NoteInput): string {
  const { trigger, vars, ...opts } = input
  return collapseNotes([{ trigger, vars, step: 0, actions: ['note'] }], opts) as string
}

/**
 * The note `/ctx-guard:clear` sends: the stop wording, then the close a
 * stop-level context note carries (restart tail, `notes.suffix` filled from
 * `vars`, the live figures). Null when the role's restart mode is off: there
 * is no tail to ask for.
 */
export function clearNoteText(opts: NoteOptions & { vars: FireVars }): string | null {
  const { role, spec, readyToken } = opts
  if (!restartTail(spec, role, readyToken, opts.mode ?? spec.restart.mode)) return null
  const vars = templateVars(opts.vars, { role, handoffPath: handoffPathFor(spec, role), readyToken })
  const parts = ['The operator asked for a restart with /ctx-guard:clear.', levelText('stop', 'context', spec.restart.via), ...noteClose(opts, true, vars)]
  return `${PREFIX} ${parts.filter(Boolean).join(' ')}`
}

// "1 ping", "3 pings".
const pingsText = (n: number | null): string => `${n ?? 0} ${n === 1 ? 'ping' : 'pings'}`

/** A short toast or OS notice for a fired trigger (also the zero-config toasts). */
export function toastText(vars: FireVars, role: string | null): string {
  const v = templateVars(vars, { role, handoffPath: null, readyToken: '' })
  const who = role ? `${role}: ` : ''
  let what: string
  if (isLimit(vars.metric)) {
    const reset = v.resetsIn === UNKNOWN ? '' : `, resets in ${v.resetsIn}`
    what = `${vars.limit ? `${windowName(vars.limit.kind)} usage ${humanPercent(vars.limit.pct)}` : 'usage'} (past ${v.threshold})${reset}`
  } else if (vars.metric === 'cost') what = `cost ${vars.cost === null ? UNKNOWN : humanUsd(vars.cost)} (past ${v.threshold})`
  else if (vars.metric === 'idle') what = `idle ${vars.idleMs === null ? UNKNOWN : humanDuration(vars.idleMs)} with context at ${v.tokens}`
  else if (vars.metric === 'cache.miss') what = `cache miss, ${missTokens(vars)} re-written${missWhy(vars)}`
  else if (vars.metric === 'cache.expiresIn') what = `prompt cache expires in ${v.expiresIn}, idle ${v.idle}`
  else if (vars.metric === 'cache.pings') what = `prompt cache kept warm by ${pingsText(vars.pings)}, expires in ${v.expiresIn}`
  else what = `context ${v.tokens} (${v.percent} of ${v.window})`
  return `ctx-guard: ${who}${what}`
}

// restartTail in a few words, for the operator: the model "tells you".
function restartAsk(spec: RoleSpec, readyToken: string, mode: RestartMode): string {
  const { via } = spec.restart
  if (mode === 'off') return ''
  if (mode === 'manual') return via === 'compact' ? `tell you '${readyFor(via)}'` : `write the handoff, then tell you '${readyFor(via)}'`
  return via === 'compact' ? `end with ${readyToken} to compact` : `write the handoff, then end with ${readyToken}`
}

// The figure a fire crossed and its threshold: "context 48k past 43k".
function crossedText(vars: FireVars): string {
  const v = templateVars(vars, { role: null, handoffPath: null, readyToken: '' })
  let what: string
  if (isLimit(vars.metric)) what = vars.limit ? `${windowName(vars.limit.kind)} usage ${humanPercent(vars.limit.pct)}` : `usage ${UNKNOWN}`
  else if (vars.metric === 'cost') what = `session cost ${vars.cost === null ? UNKNOWN : humanUsd(vars.cost)}`
  else if (vars.metric === 'idle') what = `idle ${vars.idleMs === null ? UNKNOWN : humanDuration(vars.idleMs)}`
  else if (vars.metric === 'cache.miss') return `cache miss ${missTokens(vars)}${missWhy(vars)} past ${v.threshold}`
  else if (vars.metric === 'cache.expiresIn') return `prompt cache expires in ${v.expiresIn}, within ${v.threshold}`
  else if (vars.metric === 'cache.pings') return `prompt cache kept warm by ${pingsText(vars.pings)}, at least ${v.threshold}`
  else what = `context ${v.tokens}`
  return `${what} past ${v.threshold}`
}

// A sentence as a clause: "Reread the plan." → "reread the plan".
function clause(s: string): string {
  const t = s.trim().replace(/[.!?]$/, '')
  return `${t.charAt(0).toLowerCase()}${t.slice(1)}`
}

/**
 * The toast that tells the operator a note went to the model: the level and
 * figure of the top-ranked fire, then what collapseNotes asks for (its level
 * wording, or the first custom message, and its restart tail) in a few words.
 * Null for no fires.
 */
export function noteToastText(fires: readonly Fire[], opts: NoteOptions): string | null {
  const top = [...fires].sort((a, b) => rank(b) - rank(a))[0]
  if (!top) return null
  const { role, spec, readyToken } = opts
  const builtInTop = [...fires].filter(f => f.trigger.message === null).sort((a, b) => rank(b) - rank(a))[0]
  const custom = fires.find(f => f.trigger.message !== null)
  const asks: string[] = []
  if (builtInTop) {
    // The level wording up to its colon: "Wrap up: start no new item…" → "wrap up".
    asks.push(clause(levelText(builtInTop.trigger.level, builtInTop.vars.metric, spec.restart.via).split(':')[0] ?? ''))
  } else if (custom) {
    const tv = templateVars(custom.vars, { role, handoffPath: handoffPathFor(spec, role), readyToken }, custom.trigger)
    asks.push(clause(unprefixed(render(custom.trigger.message as string, tv))))
  }
  if (fires.some(f => f.trigger.when.context !== null)) asks.push(restartAsk(spec, readyToken, opts.mode ?? spec.restart.mode))
  const level = top.trigger.level ? ` (${top.trigger.level})` : ''
  const ask = asks.filter(Boolean).join('; ')
  return `ctx-guard → model${level}: ${crossedText(top.vars)}${ask ? ` — ${ask}` : ''}`
}

// ---- denies, refusals, subagents ---------------------------------------------

// Why a command that needs ctx-guard running (/ctx-guard:clear, /ctx-guard wake) is refused.
export const NOT_ACTIVE = 'ctx-guard is not active in this session; /ctx-guard says why'

function metricName(c: Condition): string {
  if (isResetsIn(c.metric)) return `time to the ${c.limit ? windowName(c.limit.kind) : 'usage'} reset`
  if (c.limit) return `${windowName(c.limit.kind)} usage`
  if (c.metric.startsWith('limit.')) return 'usage'
  return c.metric
}

function conditionText(c: Condition): string {
  const value = c.value === null ? UNKNOWN : humanQuantity({ kind: c.threshold.kind, value: c.value })
  return `${metricName(c)} ${value} ≥ ${humanQuantity(c.threshold)}`
}

// When the denied tool comes free (toolLiftsIn; null is unknown), and whether ctx-guard will prompt the model then.
export type DenyLift = { liftsIn: number | null; wakes: boolean }

/**
 * Why `tool` is denied, addressed to the model: the trigger, its metrics, and
 * what lifts it, none of which the model can do itself; with `lift`, when the
 * tool comes free and whether ctx-guard prompts the model then.
 */
export function denyReason(tool: string, trigger: Trigger, metrics: Metrics, lift: DenyLift | null = null): string {
  const cs = conditions(trigger, metrics)
  const lifts: string[] = []
  // A time-left condition stops holding as the reset nears, before the window resets.
  for (const c of cs.filter(x => isResetsIn(x.metric) && x.value !== null)) {
    const which = c.limit ? `${windowName(c.limit.kind)} ` : ''
    lifts.push(`when the ${which}reset is less than ${humanQuantity(c.threshold)} away (in ${humanDuration((c.value as number) - c.threshold.value)})`)
  }
  const limits = cs.filter(c => c.limit)
  if (limits.length) {
    const ms = limits.map(c => resetsInMs(c.limit?.resetsAt ?? null, metrics.now)).filter((x): x is number => x !== null)
    lifts.push(ms.length ? `when the usage window resets (in ${humanDuration(Math.max(...ms))})` : 'when the usage window resets')
  }
  if (cs.some(c => c.metric === 'context')) lifts.push('when the context shrinks after a /clear or /compact')
  lifts.push(`when the operator runs /ctx-guard pause, changes trigger "${trigger.id}" in the ctx-guard config, or turns blocking off in /config`)
  const last = lifts.pop() as string
  const when = lifts.length ? `${lifts.join(', ')}, or ${last}` : last
  const free = lift
    ? ` ${tool} comes free ${lift.liftsIn === null ? 'at a time not known yet' : `in ${humanDuration(lift.liftsIn)}`}${lift.wakes ? '; ctx-guard is set to prompt you when the tool comes free' : ''}.`
    : ''
  return (
    `${PREFIX} ${tool} is blocked by trigger "${trigger.id}": ${cs.map(conditionText).join(' and ')}. ` +
    `Carry on without ${tool}; the block lifts ${when}.${free} If you need ${tool} now, ask the operator.`
  )
}

// ---- lifts ---------------------------------------------------------------------

export const DEFAULT_LIFT_NOTE = 'Trigger "{id}" has lifted: {liftReason}. {tools} are allowed again.'

export const DEFAULT_WAKE_PROMPT =
  `${PREFIX} Trigger "{id}" has lifted: {liftReason}. {tools} are allowed again. You paused your work because of it. ` +
  'Time has passed since then, so first check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. ' +
  'Then carry on with the work you paused. If nothing is left to do, say so in one line and stop.'

// Why a wake did not run, as the operator's notify says it.
export const NOT_WOKEN = {
  untrusted: 'the repo is not trusted',
  autoActions: 'autoActions is off',
  paused: 'ctx-guard is paused',
  spent: 'lift.times is spent',
  refused: 'the prompt was refused',
} as const

export type NotWoken = (typeof NOT_WOKEN)[keyof typeof NOT_WOKEN]

// A trigger that lifted, the figures at hand, the window `limit.any` read while it held, and
// what let it go when it lifted (liftReason on those figures; null reads it from `metrics`).
export type LiftInput = { trigger: Trigger; metrics: Metrics; window: string | null; reason?: string | null }

const reasonOf = (l: LiftInput): string => l.reason ?? liftReason(l.trigger, l.metrics, l.window)

// The default texts say "Agent is", "Agent, Workflow are".
function agreeing(text: string, l: LiftInput): string {
  const tools = denyTools(l.trigger)
  return tools.length === 1 ? text.replace(`${tools[0]} are allowed again`, `${tools[0]} is allowed again`) : text
}

const isKind = (k: string | null): k is LimitKind => k === 'five_hour' || k === 'seven_day'

/**
 * What let the trigger's AND go, in words: a window past its reset, a usage
 * percent below its threshold, a reset nearer than its `.resetsIn`, or "its
 * condition no longer holds" for any other metric. For `limit.any`, the window
 * that held while the brake did (`window`), else one that rolled over.
 */
export function liftReason(trigger: Trigger, m: Metrics, window: string | null = null): string {
  const c = conditions(trigger, m).find(x => x.value !== null && !x.holds)
  if (!c || !c.metric.startsWith('limit.')) return 'its condition no longer holds'
  let kind: LimitKind | null = c.limit?.kind ?? null
  if (c.metric === 'limit.any') {
    const rolled = (['five_hour', 'seven_day'] as const).find(k => m.limits[k]?.estimated)
    kind = isKind(window) ? window : (rolled ?? kind)
  }
  const name = kind ? windowName(kind) : null
  if (kind && (m.limits[kind]?.estimated || c.reset)) return `the ${name} usage window reset`
  if (isResetsIn(c.metric)) return `the ${name ? `${name} ` : ''}reset is less than ${humanQuantity(c.threshold)} away`
  return `${name ? `${name} usage` : 'usage'} is below ${humanQuantity(c.threshold)}`
}

function liftTemplateVars(l: LiftInput, ctx: NoteContext): Record<string, string> {
  const vars = fireVars(l.trigger, l.metrics)
  const reason = reasonOf(l)
  if (vars) return { ...templateVars(vars, ctx, l.trigger), liftReason: reason }
  return { role: ctx.role ?? 'none', id: l.trigger.id, tools: denyTools(l.trigger).join(', '), liftReason: reason }
}

/** One lift note for every lift of an evaluation: each trigger's `lift.message`, else the default sentence. Null for none. */
export function liftNoteText(lifts: readonly LiftInput[], ctx: NoteContext): string | null {
  if (!lifts.length) return null
  const parts = lifts.map(l => {
    const custom = l.trigger.lift?.message ?? null
    const text = render(custom ?? DEFAULT_LIFT_NOTE, liftTemplateVars(l, ctx)).trim()
    return unprefixed(custom === null ? agreeing(text, l) : text)
  })
  return `${PREFIX} ${parts.join(' ')}`
}

/** The wake prompt: the trigger's `lift.message`, else the default, with template variables filled. */
export function wakePromptText(l: LiftInput, ctx: NoteContext): string {
  const custom = l.trigger.lift?.message ?? null
  const text = render(custom ?? DEFAULT_WAKE_PROMPT, liftTemplateVars(l, ctx))
  return custom === null ? agreeing(text, l) : text
}

// `"limit-stop" lifted (the 5-hour usage window reset); Agent, Workflow allowed again.`
// A brake that denies nothing (/ctx-guard wake's) names no tools.
function liftedText(l: LiftInput): string {
  const tools = denyTools(l.trigger)
  return `"${l.trigger.id}" lifted (${reasonOf(l)})${tools.length ? `; ${tools.join(', ')} allowed again` : ''}.`
}

export const DEFAULT_MANUAL_WAKE =
  'First check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. ' +
  'Then carry on with the work. If nothing is left to do, say so in one line and stop.'

/** The wake prompt of /ctx-guard wake: what woke the session, then the operator's text or the default. */
export function manualWakeText(text: string | null, reason: string): string {
  return `${PREFIX} The operator asked with /ctx-guard wake to start once the usage window reset, and ${reason}. ${text ?? DEFAULT_MANUAL_WAKE}`
}

/**
 * The toast when something other than /ctx-guard wake off cancels a wake:
 * input the operator typed (`back`), or a change to `role` (null: none).
 */
export function wakeCancelledText(window: string, cause: 'back' | { role: string | null }): string {
  const why = cause === 'back' ? 'you are back' : `the role is now ${cause.role ?? 'none'}`
  return `ctx-guard: the wake after the ${windowName(window)} reset is cancelled: ${why}.`
}

/** The toast (and `notify`) for lifts: one line naming each. Null for none. */
export function liftToastText(lifts: readonly LiftInput[]): string | null {
  return lifts.length ? `ctx-guard: ${lifts.map(liftedText).join(' ')}` : null
}

/**
 * The one `notify` of an evaluation's lifts: the toast text, then why a wake
 * did not run (one reason, or one per trigger when they differ). Null for none.
 */
export function liftNotifyText(lifts: readonly { lift: LiftInput; why: NotWoken | null }[]): string | null {
  const head = liftToastText(lifts.map(x => x.lift))
  if (!head) return null
  const whys = lifts.filter(x => x.why !== null)
  const distinct = [...new Set(whys.map(x => x.why))]
  if (!distinct.length) return head
  if (distinct.length === 1) return `${head} Not woken: ${distinct[0]}.`
  return `${head} Not woken: ${whys.map(x => `"${x.lift.trigger.id}": ${x.why}`).join('; ')}.`
}

/** The `notify` after a lift check failed three times. */
export function liftCheckFailedText(ids: readonly string[]): string {
  return (
    `ctx-guard: ${ids.map(id => `"${id}"`).join(', ')} may have lifted, but fresh usage could not be read (the window may still be full). ` +
    'Not woken; ctx-guard tries again when usage is next reported or the window resets.'
  )
}

/** The note after a refused ready token. */
export function refusalNote(readyToken: string, code: string, text: string, via: RestartVia = 'clear'): string {
  return `${PREFIX} ${readyToken} ignored (${code}): ${text.trim().replace(/\.$/, '')}. Nothing was ${via === 'compact' ? 'compacted' : 'cleared'}.`
}

export type BudgetVars = { type: string; tokens: number; warn: number | null; stop: number | null }

function budgetVars(b: BudgetVars): Record<string, string> {
  return {
    type: b.type,
    tokens: humanTokens(b.tokens),
    warn: b.warn === null ? UNKNOWN : humanTokens(b.warn),
    stop: b.stop === null ? UNKNOWN : humanTokens(b.stop),
  }
}

export function subagentWarnText(b: BudgetVars): string {
  const v = budgetVars(b)
  const stop = b.stop === null ? '' : ` At ${v.stop} your tool calls are refused, except the one that returns your report.`
  return `${PREFIX} Your context is at ${v.tokens}, past this subagent's ${v.warn} budget.${stop} Wrap up and return your report soon.`
}

/** The deny reason for a subagent past its stop budget. */
export function subagentDenyReason(b: BudgetVars): string {
  return `${PREFIX} context budget ${budgetVars(b).stop} reached; return your final report now. Tool calls are refused, except the one that returns your report.`
}

/** The note sent once at stop: the budget's `message` (rendered) or the deny reason. */
export function subagentStopText(b: BudgetVars, message: string | null): string {
  if (message === null) return subagentDenyReason(b)
  const text = render(message, budgetVars(b)).trim()
  return text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`
}
