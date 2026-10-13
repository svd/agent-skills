// ctx-guard text: templates, humanized figures, notes keyed to level, the
// restart tail, deny reasons, refusals, subagent budget notes and toasts.
// Pure: no `$`, never throws. Texts carry numbers, names and paths only.
import type { Level, Quantity, RestartMode, RoleSpec, Trigger } from '../types'
import type { Condition, Fire, FireVars, LimitInfo, Metrics } from './triggers'
import { conditions } from './triggers'

export const PREFIX = '[ctx-guard]'

// ---- templates and figures ---------------------------------------------------

export const TEMPLATE_VARS = ['role', 'tokens', 'percent', 'threshold', 'window', 'limit', 'resetsIn', 'handoffPath', 'readyToken'] as const

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
  }
}

/** Time until an ISO reset; null when absent or unparsable. */
export function resetsInMs(resetsAt: string | null, now: number): number | null {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  return Number.isFinite(t) ? Math.max(0, t - now) : null
}

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

export type NoteContext = { role: string | null; handoffPath: string | null; readyToken: string }

/** Every template variable for a fired trigger, humanized. */
export function templateVars(vars: FireVars, ctx: NoteContext): Record<string, string> {
  return {
    role: ctx.role ?? 'none',
    tokens: vars.tokens === null ? UNKNOWN : humanTokens(vars.tokens),
    percent: vars.percent === null ? UNKNOWN : humanPercent(vars.percent),
    threshold: humanQuantity(vars.threshold),
    window: humanTokens(vars.window),
    limit: limitText(vars.limit),
    resetsIn: resetsText(vars.limit, vars.now),
    handoffPath: ctx.handoffPath ?? UNKNOWN,
    readyToken: ctx.readyToken,
  }
}

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

export function levelText(level: Level | null, metric: string): string {
  const t = LEVEL_TEXT[level ?? 'none']
  return isLimit(metric) ? t.limit : t.context
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

/** What a note ends with by restart mode; empty with mode off. */
export function restartTail(spec: RoleSpec, handoffPath: string, readyToken: string, mode: RestartMode = spec.restart.mode): string {
  const { via } = spec.restart
  if (mode === 'off') return ''
  const instructions = spec.handoff.instructions
  let write: string
  if (via === 'compact') write = ''
  else if (spec.handoff.style === 'session-handoff') {
    write = ` write a handoff with the session-handoff skill${instructions ? `: ${sentence(instructions)}` : '.'}`
  } else write = ` rewrite \`${handoffPath}\`${instructions ? `: ${sentence(instructions)}` : '.'}`
  const after = via === 'compact' ? 'ready for /compact' : 'ready for /clear'
  if (mode === 'manual') return write ? `${SAFE_POINT}${write} Then tell the operator '${after}'.` : `${SAFE_POINT} tell the operator '${after}'.`
  return write
    ? `${SAFE_POINT}${write} Then end your reply with a line holding only \`${readyToken}\`.`
    : `${SAFE_POINT} end your reply with a line holding only \`${readyToken}\`.`
}

export type NoteOptions = {
  role: string
  spec: RoleSpec
  readyToken: string
  // From effectiveMode(); the configured mode when absent.
  mode?: RestartMode
  // Overrides the configured path, e.g. the latest session-handoff file.
  handoffPath?: string
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
 * messages rendered, then one restart tail and one `notes.suffix`. Null for
 * no fires. A cold start past several thresholds thus sends one note.
 */
export function collapseNotes(fires: readonly Fire[], opts: NoteOptions): string | null {
  if (fires.length === 0) return null
  const { role, spec, readyToken } = opts
  const handoffPath = opts.handoffPath ?? handoffPathFor(spec, role)
  const tvOf = (f: Fire): Record<string, string> => templateVars(f.vars, { role, handoffPath, readyToken })

  const builtIn = fires.filter(f => f.trigger.message === null)
  const byFigure = new Map<string, Fire>()
  for (const f of builtIn) {
    const key = figureKey(f.vars)
    const had = byFigure.get(key)
    if (!had || f.vars.threshold.value > had.vars.threshold.value) byFigure.set(key, f)
  }
  const top = [...builtIn].sort((a, b) => rank(b) - rank(a))[0]
  const parts = [...byFigure.values()].map(f => head(f.vars))
  if (top) parts.push(levelText(top.trigger.level, top.vars.metric))
  for (const f of fires) if (f.trigger.message !== null) parts.push(unprefixed(render(f.trigger.message, tvOf(f)).trim()))
  parts.push(restartTail(spec, handoffPath, readyToken, opts.mode ?? spec.restart.mode))
  const suffixVars = tvOf(top ?? (fires[0] as Fire))
  if (spec.notes.suffix) parts.push(render(spec.notes.suffix, suffixVars).trim())
  return `${PREFIX} ${parts.filter(Boolean).join(' ')}`
}

/** The note for one fired trigger; see collapseNotes. */
export function noteText(input: NoteInput): string {
  const { trigger, vars, ...opts } = input
  return collapseNotes([{ trigger, vars, step: 0, actions: ['note'] }], opts) as string
}

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
  else what = `context ${v.tokens} (${v.percent} of ${v.window})`
  return `ctx-guard: ${who}${what}`
}

// ---- denies, refusals, subagents ---------------------------------------------

function metricName(c: Condition): string {
  if (c.limit) return `${windowName(c.limit.kind)} usage`
  if (c.metric.startsWith('limit.')) return 'usage'
  return c.metric
}

function conditionText(c: Condition): string {
  const value = c.value === null ? UNKNOWN : humanQuantity({ kind: c.threshold.kind, value: c.value })
  return `${metricName(c)} ${value} ≥ ${humanQuantity(c.threshold)}`
}

/**
 * Why `tool` is denied, addressed to the model: the trigger, its metrics, and
 * what lifts it, none of which the model can do itself.
 */
export function denyReason(tool: string, trigger: Trigger, metrics: Metrics): string {
  const cs = conditions(trigger, metrics)
  const lifts: string[] = []
  const limits = cs.filter(c => c.limit)
  if (limits.length) {
    const ms = limits.map(c => resetsInMs(c.limit?.resetsAt ?? null, metrics.now)).filter((x): x is number => x !== null)
    lifts.push(ms.length ? `when the usage window resets (in ${humanDuration(Math.max(...ms))})` : 'when the usage window resets')
  }
  if (cs.some(c => c.metric === 'context')) lifts.push('when the context shrinks after a /clear or /compact')
  lifts.push(`when the operator runs /ctx-guard pause, changes trigger "${trigger.id}" in the ctx-guard config, or turns blocking off in /config`)
  const last = lifts.pop() as string
  const when = lifts.length ? `${lifts.join(', ')}, or ${last}` : last
  return (
    `${PREFIX} ${tool} is blocked by trigger "${trigger.id}": ${cs.map(conditionText).join(' and ')}. ` +
    `Carry on without ${tool}; the block lifts ${when}. If you need ${tool} now, ask the operator.`
  )
}

/** The note after a refused ready token. */
export function refusalNote(readyToken: string, code: string, text: string): string {
  return `${PREFIX} ${readyToken} ignored (${code}): ${text.trim().replace(/\.$/, '')}. Nothing was cleared.`
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
  const stop = b.stop === null ? '' : ` At ${v.stop} your tool calls are refused.`
  return `${PREFIX} Your context is at ${v.tokens}, past this subagent's ${v.warn} budget.${stop} Wrap up and return your report soon.`
}

/** The deny reason for a subagent past its stop budget. */
export function subagentDenyReason(b: BudgetVars): string {
  return `${PREFIX} context budget ${budgetVars(b).stop} reached; return your final report now.`
}

/** The note sent once at stop: the budget's `message` (rendered) or the deny reason. */
export function subagentStopText(b: BudgetVars, message: string | null): string {
  if (message === null) return subagentDenyReason(b)
  const text = render(message, budgetVars(b)).trim()
  return text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`
}
