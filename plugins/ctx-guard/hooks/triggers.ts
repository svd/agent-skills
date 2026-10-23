// ctx-guard triggers: metric readings, rising-edge evaluation with JSON marks,
// the level-triggered live deny set, and the holds and lifts of brakes.
// Pure: no `$`, never throws.
import type { Config, EdgeAction, Hold, Mark, Marks, Metric, Quantity, Trigger } from '../types'
import { canonicalJson, roleSpec, zeroConfigTriggers } from './config'

export type LimitKind = 'five_hour' | 'seven_day'
// `estimated`: the window's reset time passed with no response since, so it reads as rolled
// over; `rolledAt` is that passed reset time.
export type LimitReading = { pct: number; resetsAt: string | null; estimated?: true; rolledAt?: string }

// How long past its reset time a window still reads as reported: clock skew, or a reset
// time rounded down, must not turn a fresh 97 % into an estimated 0 %.
export const ROLL_OVER_GRACE_MS = 60 * 1000

// The length of each window: a rolled-over one resets again this long after it rolled over.
export const WINDOW_MS: Readonly<Record<LimitKind, number>> = { five_hour: 5 * 60 * 60 * 1000, seven_day: 7 * 24 * 60 * 60 * 1000 }

// The main thread's prompt cache, as cache.ts reads it; null is unknown.
export type CacheMetrics = { expiresIn: number | null; miss: number | null; missCause: 'model' | 'prefix' | null; pings: number | null }
export const NO_CACHE: CacheMetrics = { expiresIn: null, miss: null, missCause: null, pings: null }

// One reading of everything a trigger can test; null is unknown.
export type Metrics = {
  tokens: number | null
  window: number
  limits: { five_hour: LimitReading | null; seven_day: LimitReading | null }
  cost: number | null
  // See idleMs(): 0 while a main turn runs, null before the first main turn ends.
  idleMs: number | null
  cache: CacheMetrics
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
  // The value rests on a window read as rolled over (for limit.any, either window).
  estimated: boolean
}

// What a note, toast or deny reason needs about a fired trigger.
export type FireVars = {
  // The metric the text is about: `every`'s metric, else the first in METRIC_ORDER.
  metric: Metric
  // That metric's threshold at the fired step; null with no trigger behind the text.
  threshold: Quantity | null
  tokens: number | null
  percent: number | null
  window: number
  limit: LimitInfo | null
  cost: number | null
  idleMs: number | null
  expiresIn: number | null
  miss: number | null
  missCause: 'model' | 'prefix' | null
  pings: number | null
  now: number
  // Time until the trigger's condition stops holding; null when unknown (see liftsInMs).
  liftsIn: number | null
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
  'cache.expiresIn',
  'cache.miss',
  'cache.pings',
]

// Float slack so 70 + 2 × 5 counts as reaching step 2 at exactly 80.
const EPS = 1e-9

/**
 * The rate-limit windows ctx-guard tests, from the engine's list. The figures
 * are the last response's; with `now`, a window whose reset time passed
 * ROLL_OVER_GRACE_MS ago or more reads as rolled over (0 %, reset unknown,
 * estimated) until a response reports it again.
 */
export function limitsFrom(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[] | null | undefined,
  now?: number,
): Metrics['limits'] {
  const out: Metrics['limits'] = { five_hour: null, seven_day: null }
  for (const r of rateLimits ?? []) {
    if ((r.kind === 'five_hour' || r.kind === 'seven_day') && Number.isFinite(r.percentUsed)) {
      const at = r.resetsAt ? Date.parse(r.resetsAt) : Number.NaN
      out[r.kind] =
        now !== undefined && Number.isFinite(at) && now - at >= ROLL_OVER_GRACE_MS ? { pct: 0, resetsAt: null, estimated: true, rolledAt: r.resetsAt as string } : { pct: r.percentUsed, resetsAt: r.resetsAt ?? null }
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
export function metricsOf(src: MetricsSource, window: number, idle: number | null, now: number, cache: CacheMetrics = NO_CACHE): Metrics {
  return {
    tokens: count(src.tokens),
    window,
    limits: limitsFrom(src.rateLimits, now),
    cost: count(src.cost?.usd),
    idleMs: idle,
    cache,
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
    case 'cache.expiresIn':
      return m.cache.expiresIn
    case 'cache.miss':
      return m.cache.miss
    case 'cache.pings':
      return m.cache.pings
    case 'limit.five_hour.resetsIn':
    case 'limit.seven_day.resetsIn':
      // A window with no reset time is unknown: the trigger waits, a deny lets the call through.
      return limit ? resetsInMs(limit.resetsAt, m.now) : null
    default:
      return limit ? limit.pct : null
  }
}

// The one countdown metric: it holds as the figure falls to its threshold.
const AT_OR_BELOW: ReadonlySet<Metric> = new Set<Metric>(['cache.expiresIn'])

/** True for a metric that holds at or below its threshold; every other holds at or above it. */
export const holdsBelow = (metric: Metric): boolean => AT_OR_BELOW.has(metric)

// Brakes, holds and texts read the same trigger's conditions many times on one
// reading, so each is read once per Metrics. Neither a reading nor a trigger
// changes once made, so the memo never shows.
const conditionMemo = new WeakMap<Metrics, WeakMap<Trigger, readonly Condition[]>>()

/** Each metric of the trigger's AND with its live value. */
export function conditions(trigger: Trigger, m: Metrics): readonly Condition[] {
  let byTrigger = conditionMemo.get(m)
  if (!byTrigger) {
    byTrigger = new WeakMap()
    conditionMemo.set(m, byTrigger)
  }
  const hit = byTrigger.get(trigger)
  if (hit) return hit
  const out: Condition[] = []
  for (const metric of METRIC_ORDER) {
    const threshold = trigger.when[metric]
    if (!threshold) continue
    const limit = limitFor(metric, m)
    const value = valueOf(metric, threshold, m, limit)
    const holds = value !== null && (holdsBelow(metric) ? value - EPS <= threshold.value : value + EPS >= threshold.value)
    const estimated = metric === 'limit.any' ? Boolean(m.limits.five_hour?.estimated || m.limits.seven_day?.estimated) : limit?.estimated === true
    out.push({ metric, threshold, value, holds, limit, estimated })
  }
  byTrigger.set(trigger, out)
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
    expiresIn: m.cache.expiresIn,
    miss: m.cache.miss,
    missCause: m.cache.missCause,
    pings: m.cache.pings,
    now: m.now,
    liftsIn: liftsInMs(trigger, m),
  }
}

/** The figures of `m` as a context note's variables, with no trigger behind them (/ctx-guard:clear). */
export function readingVars(m: Metrics): FireVars {
  return {
    metric: 'context',
    threshold: null,
    tokens: m.tokens,
    percent: contextPercent(m),
    window: m.window,
    limit: null,
    cost: m.cost,
    idleMs: m.idleMs,
    expiresIn: m.cache.expiresIn,
    miss: m.cache.miss,
    missCause: m.cache.missCause,
    pings: m.cache.pings,
    now: m.now,
    liftsIn: null,
  }
}

/** What a text about the trigger needs on `m`, as for a fire at its first threshold (a lift's texts). */
export function fireVars(trigger: Trigger, m: Metrics): FireVars | null {
  const cs = conditions(trigger, m)
  return cs.length ? varsOf(trigger, cs, 0, m) : null
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
  const readAt = o.readAt === undefined || (typeof o.readAt === 'number' && Number.isFinite(o.readAt))
  return typeof o.step === 'number' && Number.isInteger(o.step) && o.step >= 0 && typeof o.at === 'number' && Number.isFinite(o.at) && readAt
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
 * and falls with the step, so the trigger re-arms; a window read as rolled over
 * is an estimate and drops no mark (only a reported figure, or a lift, does).
 * A trigger with an unknown metric is skipped and keeps its mark; marks of
 * another role, or of triggers no longer configured, are dropped.
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
    if (!allHold(cs)) {
      if (old && cs.every(c => c.holds || c.estimated)) byId[trigger.id] = old
      continue
    }
    const step = stepOf(trigger, cs)
    if (old && old.step >= step) {
      byId[trigger.id] = old.step === step ? old : { ...old, step }
      continue
    }
    byId[trigger.id] = { step, at: metrics.now }
    const actions = edgeActions(trigger)
    if (actions.length) fire.push({ trigger, actions, step, vars: varsOf(trigger, cs, step, metrics) })
  }
  return { fire, marks: { role, byId } }
}

/**
 * Holds back the fires of triggers that used up their `times` in this idle
 * period and counts the rest; uncapped triggers pass and are not counted, and
 * so do the `exempt` (a rising edge that corrects a lift run on estimates).
 */
export function applyTimes(
  fire: readonly Fire[],
  fired: Readonly<Record<string, number>>,
  exempt: ReadonlySet<string> = new Set(),
): { fire: Fire[]; fired: Record<string, number> } {
  const counts: Record<string, number> = { ...fired }
  const out: Fire[] = []
  for (const f of fire) {
    const cap = f.trigger.times
    if (cap === null || exempt.has(f.trigger.id)) {
      out.push(f)
      continue
    }
    const used = Object.hasOwn(counts, f.trigger.id) ? (counts[f.trigger.id] as number) : 0
    if (used >= cap) continue
    counts[f.trigger.id] = used + 1
    out.push(f)
  }
  return { fire: out, fired: counts }
}

/** Whether the trigger's whole AND holds on `m`; null when one of its metrics is unknown. */
export function triggerHolds(trigger: Trigger, m: Metrics): boolean | null {
  const cs = conditions(trigger, m)
  return known(cs) ? allHold(cs) : null
}

/**
 * The state of the trigger's AND for its lift: true when every metric is known
 * and holds, false as soon as one known metric does not (whatever the others
 * read), null otherwise.
 */
export function whenState(trigger: Trigger, m: Metrics): boolean | null {
  const cs = conditions(trigger, m)
  if (cs.some(c => c.value !== null && !c.holds)) return false
  return known(cs) && allHold(cs) ? true : null
}

/** Whether `m` rests on a window read as rolled over for any of the trigger's metrics. */
export function onEstimate(trigger: Trigger, m: Metrics): boolean {
  return conditions(trigger, m).some(c => c.estimated)
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

/** A context threshold in tokens on `window`; null when there is none, or it cannot be placed. */
export function placeContext(q: Quantity | null, window: number): { tokens: number; threshold: Quantity } | null {
  const tokens = q ? asTokens(q, window) : null
  return q && tokens !== null ? { tokens, threshold: q } : null
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
  // The first trigger asking for a warm ping; the caller sends it only when no prompt goes.
  ping: Fire | null
  // Every trigger asking for a prompt, in order; the caller sends at most one.
  prompts: Fire[]
}

/** Groups one evaluation's fires by action, so a burst of crossings costs one note. */
export function planActions(fire: readonly Fire[]): ActionPlan {
  const by = (a: EdgeAction): Fire[] => fire.filter(f => f.actions.includes(a))
  return { notes: by('note'), toasts: by('toast'), notifies: by('notify'), compact: by('compact')[0] ?? null, ping: by('ping')[0] ?? null, prompts: by('prompt') }
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

/** The tools a trigger denies, each once, in config order. */
export function denyTools(trigger: Trigger): string[] {
  return [...new Set(trigger.do.flatMap(a => (typeof a === 'object' ? a.deny : [])))]
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

// ---- holds and lifts -------------------------------------------------------------

export const isResetsIn = (metric: Metric): boolean => metric === 'limit.five_hour.resetsIn' || metric === 'limit.seven_day.resetsIn'

// Time until a window reads as rolled over: ROLL_OVER_GRACE_MS past its reset (see limitsFrom).
const rollsOverInMs = (resetsAt: string | null, now: number): number | null => resetsInMs(resetsAt, now - ROLL_OVER_GRACE_MS)

/**
 * Time until the trigger's AND stops holding: for a `.resetsIn` metric, until
 * the reset is nearer than its threshold; for usage percents alone, until the
 * window reads as rolled over, ROLL_OVER_GRACE_MS past its reset (for
 * `limit.any`, the latest among the windows at or past the threshold). Null when that time is unknown, or another metric (context,
 * cost) decides it.
 */
export function liftsInMs(trigger: Trigger, m: Metrics): number | null {
  const cs = conditions(trigger, m)
  if (!cs.length) return null
  const resets = cs.filter(c => isResetsIn(c.metric))
  const parts: (number | null)[] = []
  if (resets.length) for (const c of resets) parts.push(c.value === null ? null : Math.max(0, c.value - c.threshold.value))
  else {
    if (cs.some(c => !c.metric.startsWith('limit.'))) return null
    for (const c of cs) {
      if (c.metric !== 'limit.any') {
        parts.push(c.limit ? rollsOverInMs(c.limit.resetsAt, m.now) : null)
        continue
      }
      const over = (['five_hour', 'seven_day'] as const).map(k => m.limits[k]).filter((r): r is LimitReading => r !== null && r.pct + EPS >= c.threshold.value)
      const ms = over.map(r => rollsOverInMs(r.resetsAt, m.now))
      parts.push(ms.some(x => x === null) ? null : ms.length ? Math.max(...(ms as number[])) : 0)
    }
  }
  return parts.some(x => x === null) ? null : Math.min(...(parts as number[]))
}

/**
 * When `tool` comes free: the latest lift time among the triggers that deny it
 * and hold now, since it is free only once the last of them lets go. Null when
 * one of them is unknown, or none holds.
 */
export function toolLiftsIn(tool: string, triggers: readonly Trigger[], m: Metrics): number | null {
  const times = triggers.filter(t => denyTools(t).includes(tool) && triggerHolds(t, m) === true).map(t => liftsInMs(t, m))
  return !times.length || times.some(x => x === null) ? null : Math.max(...(times as number[]))
}

/** Whether another trigger whose AND is known to hold denies one of `tools`: the rule the call path applies. */
export function blockedBy(id: string, tools: readonly string[], triggers: readonly Trigger[], m: Metrics): string | null {
  const other = triggers.find(t => t.id !== id && triggerHolds(t, m) === true && denyTools(t).some(x => tools.includes(x)))
  return other ? other.id : null
}

/** Whether the trigger's deny tools are all free on `m`: its own AND known not to hold, and no other brake on them. */
export function toolsFree(trigger: Trigger, triggers: readonly Trigger[], m: Metrics): boolean {
  return whenState(trigger, m) === false && blockedBy(trigger.id, denyTools(trigger), triggers, m) === null
}

const sameTools = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

function newHold(trigger: Trigger, now: number, window: string | null): Hold {
  return { tools: denyTools(trigger), when: canonicalJson(trigger.when), startedAt: now, touchedAt: null, notedAt: null, phase: 'holding', tries: 0, window, liftedAt: null, reason: null, ran: false, liftNotedAt: null, stall: null }
}

// A hold whose condition let go: it lifts when its tools are free, else it waits for the last brake on them.
function letGo(h: Hold, trigger: Trigger, triggers: readonly Trigger[], m: Metrics): Hold {
  if (blockedBy(trigger.id, h.tools, triggers, m) !== null) return { ...h, phase: 'waiting', tries: 0, stall: null }
  return { ...h, phase: 'lifting', liftedAt: m.now, reason: null, ran: false, liftNotedAt: null, tries: 0, stall: null }
}

export type HoldOptions = {
  blocking: boolean
  // Usage reports so far: a stalled hold waits for a newer one (or its reset).
  reports: number
  // Holds a lift check covers: left as they are.
  frozen?: ReadonlySet<string>
}

/**
 * The holds after one reading, and the triggers that lifted on it, in config
 * order. A trigger with `lift` holds while its AND is known to hold; when one
 * of its metrics is known not to, it lifts once no other brake whose AND holds
 * denies one of its tools, and waits until then. An unknown reading changes
 * nothing. A lifting hold stays lifting (the caller decides it) unless its AND
 * holds again, or another such brake denies one of its tools, when it waits
 * again; a stalled one lifts again only after a newer usage report or its
 * reset. A frozen hold is left as it is. A hold whose trigger or lift a
 * reload removed, or whose `when` or deny tools it changed, is dropped, as is
 * every hold with `blocking` off: none of that is a lift. A reload that edits
 * the lift keeps the hold.
 */
export function stepHolds(prev: Readonly<Record<string, Hold>>, triggers: readonly Trigger[], m: Metrics, opts: HoldOptions): { holds: Record<string, Hold>; lifted: string[] } {
  const holds: Record<string, Hold> = {}
  const lifted: string[] = []
  if (!opts.blocking) return { holds, lifted }
  for (const t of triggers) {
    if (!t.lift) continue
    const tools = denyTools(t)
    if (!tools.length) continue
    const raw = Object.hasOwn(prev, t.id) ? prev[t.id] : undefined
    const old = raw && sameTools(raw.tools, tools) && raw.when === canonicalJson(t.when) ? raw : undefined
    if (old && opts.frozen?.has(t.id)) {
      holds[t.id] = old
      continue
    }
    const state = whenState(t, m)
    if (state === true) {
      const window = t.when['limit.any'] ? (limitFor('limit.any', m)?.kind ?? null) : null
      holds[t.id] = old ? { ...old, phase: 'holding', tries: 0, window: window ?? old.window, liftedAt: null, reason: null, ran: false, liftNotedAt: null, stall: null } : newHold(t, m.now, window)
      continue
    }
    if (!old) continue
    // Another brake denies a tool again before the lift ran its course: it waits for that brake, stamps kept.
    if (old.phase === 'lifting' && blockedBy(t.id, old.tools, triggers, m) !== null) {
      holds[t.id] = { ...old, phase: 'waiting', tries: 0 }
      continue
    }
    if (state === null || old.phase === 'lifting') {
      holds[t.id] = old
      continue
    }
    if (old.phase === 'stalled') {
      const stall = old.stall
      const free = !stall || opts.reports > stall.reports || (stall.until !== null && m.now >= stall.until)
      if (!free) {
        holds[t.id] = old
        continue
      }
    }
    const next = letGo(old, t, triggers, m)
    holds[t.id] = next
    if (next.phase === 'lifting') lifted.push(t.id)
  }
  return { holds, lifted }
}
