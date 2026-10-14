// ctx-guard triggers: metric readings, rising-edge evaluation with JSON marks,
// and the level-triggered live deny set. Pure: no `$`, never throws.
import type { Config, EdgeAction, Mark, Marks, Metric, Quantity, Trigger } from '../types'
import { roleSpec, zeroConfigTriggers } from './config'

export type LimitKind = 'five_hour' | 'seven_day'
export type LimitReading = { pct: number; resetsAt: string | null }

// One reading of everything a trigger can test; null is unknown.
export type Metrics = {
  tokens: number | null
  window: number
  limits: { five_hour: LimitReading | null; seven_day: LimitReading | null }
  cost: number | null
  // See idleMs(): 0 while a main turn runs, null before the first main turn ends.
  idleMs: number | null
  now: number
}

/**
 * Time since the last main-loop turn end. A running main turn is never idle
 * (0); before any main turn has ended there is nothing to measure from (null).
 */
export function idleMs(lastEnd: number | null, busy: boolean, now: number): number | null {
  if (busy) return 0
  return lastEnd === null || !Number.isFinite(lastEnd) ? null : Math.max(0, now - lastEnd)
}

export type LimitInfo = LimitReading & { kind: LimitKind }

// One metric of a trigger's AND, read against the live metrics.
export type Condition = {
  metric: Metric
  threshold: Quantity
  // In the threshold's own unit (tokens, percent, USD, ms); null is unknown.
  value: number | null
  holds: boolean
  // The window behind a limit metric (the highest one for limit.any).
  limit: LimitInfo | null
}

// What a note, toast or deny reason needs about a fired trigger.
export type FireVars = {
  // The metric the text is about: `every`'s metric, else the first in METRIC_ORDER.
  metric: Metric
  // That metric's threshold at the fired step.
  threshold: Quantity
  tokens: number | null
  percent: number | null
  window: number
  limit: LimitInfo | null
  cost: number | null
  idleMs: number | null
  now: number
}

export type Fire = { trigger: Trigger; actions: EdgeAction[]; step: number; vars: FireVars }

export type Evaluation = { fire: Fire[]; marks: Marks }

export type DenyEntry = { tool: string; triggerId: string }

// A window's percent comes before its `.resetsIn`, so a fired trigger's text is about the usage.
export const METRIC_ORDER: readonly Metric[] = [
  'context',
  'limit.five_hour',
  'limit.seven_day',
  'limit.any',
  'limit.five_hour.resetsIn',
  'limit.seven_day.resetsIn',
  'cost',
  'idle',
]

// Float slack so 70 + 2 × 5 counts as reaching step 2 at exactly 80.
const EPS = 1e-9

/** The rate-limit windows ctx-guard tests, from the engine's list. */
export function limitsFrom(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[] | null | undefined,
): Metrics['limits'] {
  const out: Metrics['limits'] = { five_hour: null, seven_day: null }
  for (const r of rateLimits ?? []) {
    if ((r.kind === 'five_hour' || r.kind === 'seven_day') && Number.isFinite(r.percentUsed)) {
      out[r.kind] = { pct: r.percentUsed, resetsAt: r.resetsAt ?? null }
    }
  }
  return out
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/**
 * A request's context fill from its usage: uncached, cache-read and
 * cache-written input together, what the status line counts. Null with no usage.
 */
export function stepTokens(
  usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null | undefined,
): number | null {
  if (!usage) return null
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].map(count)
  return parts.some(p => p === null) ? null : (parts as number[]).reduce((a, b) => a + b, 0)
}

// Characters per token in tool results, the usual rough rate for English text and code.
export const CHARS_PER_TOKEN = 4

/**
 * The fill of a main-loop request still streaming. Its usage arrives with its
 * stop chunk, after the tools it calls have started, and no earlier chunk
 * carries it; so it is estimated as the last finished request's input plus
 * its output plus the tool results sent back since. The person's next prompt
 * and any note are left out, so it errs low by those.
 */
export function inFlightTokens(lastInput: number, lastOutput: number | null, resultChars: number): number {
  return lastInput + (lastOutput ?? 0) + Math.ceil(Math.max(0, resultChars) / CHARS_PER_TOKEN)
}

export type MetricsSource = {
  // Absent before the first response and after /clear: unknown.
  tokens?: number | null
  rateLimits?: readonly { kind: string; percentUsed: number; resetsAt?: string }[] | null
  cost?: { usd: number } | null
}

/** One reading from the engine's figures, against the effective window. */
export function metricsOf(src: MetricsSource, window: number, idle: number | null, now: number): Metrics {
  return {
    tokens: count(src.tokens),
    window,
    limits: limitsFrom(src.rateLimits),
    cost: count(src.cost?.usd),
    idleMs: idle,
    now,
  }
}

/** Time until an ISO reset; null when absent or unparsable. */
export function resetsInMs(resetsAt: string | null, now: number): number | null {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  return Number.isFinite(t) ? Math.max(0, t - now) : null
}

export function contextPercent(m: Metrics): number | null {
  return m.tokens === null || !(m.window > 0) ? null : (m.tokens / m.window) * 100
}

function limitFor(metric: Metric, m: Metrics): LimitInfo | null {
  const of = (kind: LimitKind): LimitInfo | null => {
    const r = m.limits[kind]
    return r ? { kind, ...r } : null
  }
  if (metric === 'limit.five_hour' || metric === 'limit.five_hour.resetsIn') return of('five_hour')
  if (metric === 'limit.seven_day' || metric === 'limit.seven_day.resetsIn') return of('seven_day')
  if (metric !== 'limit.any') return null
  const five = of('five_hour')
  const week = of('seven_day')
  if (five && week) return week.pct > five.pct ? week : five
  return five ?? week
}

function valueOf(metric: Metric, q: Quantity, m: Metrics, limit: LimitInfo | null): number | null {
  switch (metric) {
    case 'context':
      return q.kind === 'percent' ? contextPercent(m) : m.tokens
    case 'cost':
      return m.cost
    case 'idle':
      return m.idleMs
    case 'limit.five_hour.resetsIn':
    case 'limit.seven_day.resetsIn':
      // A window with no reset time is unknown: the trigger waits, a deny lets the call through.
      return limit ? resetsInMs(limit.resetsAt, m.now) : null
    default:
      return limit ? limit.pct : null
  }
}

/** Each metric of the trigger's AND with its live value. */
export function conditions(trigger: Trigger, m: Metrics): Condition[] {
  const out: Condition[] = []
  for (const metric of METRIC_ORDER) {
    const threshold = trigger.when[metric]
    if (!threshold) continue
    const limit = limitFor(metric, m)
    const value = valueOf(metric, threshold, m, limit)
    out.push({ metric, threshold, value, holds: value !== null && value + EPS >= threshold.value, limit })
  }
  return out
}

const known = (cs: readonly Condition[]): boolean => cs.every(c => c.value !== null)
const allHold = (cs: readonly Condition[]): boolean => cs.length > 0 && cs.every(c => c.holds)

// 0 at the first threshold, +1 per `every` past it.
function stepOf(trigger: Trigger, cs: readonly Condition[]): number {
  const { every, everyMetric } = trigger.when
  const c = everyMetric ? cs.find(x => x.metric === everyMetric) : undefined
  if (!every || !c || c.value === null || !(every.value > 0)) return 0
  return Math.max(0, Math.floor((c.value - c.threshold.value) / every.value + EPS))
}

function varsOf(trigger: Trigger, cs: readonly Condition[], step: number, m: Metrics): FireVars {
  const main = cs.find(c => c.metric === trigger.when.everyMetric) ?? (cs[0] as Condition)
  const stepSize = trigger.when.every && main.metric === trigger.when.everyMetric ? trigger.when.every.value : 0
  return {
    metric: main.metric,
    threshold: { kind: main.threshold.kind, value: main.threshold.value + step * stepSize },
    tokens: m.tokens,
    percent: contextPercent(m),
    window: m.window,
    limit: cs.find(c => c.limit)?.limit ?? null,
    cost: m.cost,
    idleMs: m.idleMs,
    now: m.now,
  }
}

const edgeActions = (t: Trigger): EdgeAction[] => t.do.filter((a): a is EdgeAction => typeof a === 'string')

/**
 * The marks after a /clear: the context starts over, so every trigger with a
 * context condition re-arms. The others (usage windows, cost, idle) watch
 * figures a /clear leaves as they were, so they keep their marks and re-arm
 * only when their figure drops: a clear never fires them again by itself.
 */
export function resetMarks(role: string | null, marks: Marks | null = null, triggers: readonly Trigger[] = []): Marks {
  const prev = priorMarks(marks, role)
  const byId: Record<string, Mark> = {}
  for (const t of triggers) {
    if (t.when.context !== null) continue
    const raw = Object.hasOwn(prev, t.id) ? prev[t.id] : undefined
    if (isMark(raw)) byId[t.id] = raw
  }
  return { role, byId }
}

// Marks come back from $.state, which another version may have written.
function isMark(v: unknown): v is Mark {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.step === 'number' && Number.isInteger(o.step) && o.step >= 0 && typeof o.at === 'number' && Number.isFinite(o.at)
}

function priorMarks(marks: unknown, role: string | null): Record<string, unknown> {
  if (typeof marks !== 'object' || marks === null) return {}
  const m = marks as Record<string, unknown>
  const byId = m.byId
  return m.role === role && typeof byId === 'object' && byId !== null && !Array.isArray(byId) ? (byId as Record<string, unknown>) : {}
}

/**
 * Rising edges since `marks`. A trigger fires when its whole AND holds and it
 * did not at the last mark, or `every` reached a higher step (a jump of several
 * steps fires once, at the highest). The mark drops when the AND stops holding
 * and falls with the step, so the trigger re-arms. A trigger with an unknown
 * metric is skipped and keeps its mark; marks of another role, or of triggers
 * no longer configured, are dropped.
 */
export function evaluate(
  triggers: readonly Trigger[],
  metrics: Metrics,
  marks: Marks | null,
  role: string | null,
): Evaluation {
  const prev = priorMarks(marks, role)
  const byId: Record<string, Mark> = {}
  const fire: Fire[] = []
  for (const trigger of triggers) {
    const raw = Object.hasOwn(prev, trigger.id) ? prev[trigger.id] : undefined
    const old = isMark(raw) ? raw : undefined
    const cs = conditions(trigger, metrics)
    if (!known(cs)) {
      if (old) byId[trigger.id] = old
      continue
    }
    if (!allHold(cs)) continue
    const step = stepOf(trigger, cs)
    if (old && old.step >= step) {
      byId[trigger.id] = old.step === step ? old : { step, at: old.at }
      continue
    }
    byId[trigger.id] = { step, at: metrics.now }
    const actions = edgeActions(trigger)
    if (actions.length) fire.push({ trigger, actions, step, vars: varsOf(trigger, cs, step, metrics) })
  }
  return { fire, marks: { role, byId } }
}

/** Whether the trigger's whole AND holds on `m`; null when one of its metrics is unknown. */
export function triggerHolds(trigger: Trigger, m: Metrics): boolean | null {
  const cs = conditions(trigger, m)
  return known(cs) ? allHold(cs) : null
}

/** Whether `marks` (of `role`) still hold a mark for trigger `id`: it fired and has not re-armed. */
export function markHeld(marks: Marks | null, role: string | null, id: string): boolean {
  const prev = priorMarks(marks, role)
  return Object.hasOwn(prev, id) && isMark(prev[id])
}

/** The lowest context threshold among `triggers`, in tokens on `window`; null when none has one, or one cannot be placed. */
export function contextFloor(triggers: readonly Trigger[], window: number): { tokens: number; threshold: Quantity } | null {
  let floor: { tokens: number; threshold: Quantity } | null = null
  for (const t of triggers) {
    const q = t.when.context
    if (!q) continue
    const tokens = asTokens(q, window)
    if (tokens === null) return null
    if (!floor || tokens < floor.tokens) floor = { tokens, threshold: q }
  }
  return floor
}

// ---- step gates --------------------------------------------------------------

// Between `rise` and `fall` a new context reading cannot change any context
// trigger's mark; null is unbounded on that side.
export type TokenGates = { rise: number | null; fall: number | null }

function asTokens(q: Quantity, window: number): number | null {
  if (q.kind === 'tokens') return q.value
  if (q.kind === 'percent') return window > 0 ? (q.value / 100) * window : null
  return null
}

/**
 * Where the next context reading must land for an evaluation to matter: at or
 * past `rise` an unmarked trigger (or the next `every` step) may fire; below
 * `fall` a marked step may drop. Lets a main-loop step skip the evaluation in
 * between. A threshold that cannot be placed (percent with no window) gives
 * gates that always evaluate.
 */
export function tokenGates(triggers: readonly Trigger[], marks: Marks | null, role: string | null, window: number): TokenGates {
  const prev = priorMarks(marks, role)
  let rise = Infinity
  let fall = -Infinity
  for (const t of triggers) {
    const q = t.when.context
    if (!q) continue
    const base = asTokens(q, window)
    const every = t.when.every && t.when.everyMetric === 'context' ? asTokens(t.when.every, window) : 0
    if (base === null || every === null) return { rise: 0, fall: null }
    const raw = Object.hasOwn(prev, t.id) ? prev[t.id] : undefined
    const mark = isMark(raw) ? raw : null
    if (!mark) rise = Math.min(rise, base)
    else {
      fall = Math.max(fall, base + mark.step * every)
      if (every > 0) rise = Math.min(rise, base + (mark.step + 1) * every)
    }
  }
  return { rise: Number.isFinite(rise) ? rise : null, fall: Number.isFinite(fall) ? fall : null }
}

/** Whether a reading of `tokens` may change a mark under `gates` (rounding slack of one token). */
export function crossesGates(tokens: number, gates: TokenGates | null): boolean {
  if (!gates) return true
  return (gates.rise !== null && tokens + 1 >= gates.rise) || (gates.fall !== null && tokens - 1 < gates.fall)
}

export type ActionPlan = {
  // Every fired trigger with a note; the caller sends them as one note.
  notes: Fire[]
  toasts: Fire[]
  notifies: Fire[]
  // At most one compact per evaluation: the first trigger asking for it.
  compact: Fire | null
}

/** Groups one evaluation's fires by action, so a burst of crossings costs one note. */
export function planActions(fire: readonly Fire[]): ActionPlan {
  const by = (a: EdgeAction): Fire[] => fire.filter(f => f.actions.includes(a))
  return { notes: by('note'), toasts: by('toast'), notifies: by('notify'), compact: by('compact')[0] ?? null }
}

/**
 * Tools denied right now, judged afresh from live metrics on every call. An
 * unknown metric denies nothing (fail open), as do `blocking` off and a pause.
 */
export function liveDenies(
  triggers: readonly Trigger[],
  metrics: Metrics,
  opts: { blocking: boolean; paused: boolean },
): DenyEntry[] {
  if (!opts.blocking || opts.paused) return []
  const out: DenyEntry[] = []
  for (const trigger of triggers) {
    const tools = trigger.do.flatMap(a => (typeof a === 'object' ? a.deny : []))
    if (!tools.length || !allHold(conditions(trigger, metrics))) continue
    for (const tool of tools) if (!out.some(d => d.tool === tool && d.triggerId === trigger.id)) out.push({ tool, triggerId: trigger.id })
  }
  return out
}

/** The first live deny that names `tool`, or null. */
export function deniedBy(tool: string, denies: readonly DenyEntry[]): DenyEntry | null {
  return denies.find(d => d.tool === tool) ?? null
}

/** A role's triggers; with no role (or a role gone from the config), the zero-config toasts. */
export function triggersFor(config: Config, role: string | null): Trigger[] {
  const spec = role === null ? null : roleSpec(config, role)
  return spec ? spec.triggers : zeroConfigTriggers()
}
