// ctx-guard config: quantities, layer merge, schema v1 validation, the
// effective-config fallback rule and the trust hash. Pure: no `$`, never throws.
import type {
  Action,
  BandProbeSpec,
  Budget,
  CacheConfig,
  CacheShow,
  Config,
  ConfigSource,
  ConfigState,
  Display,
  Level,
  LiftAction,
  Quantity,
  QuantityKind,
  ReadyCheck,
  RestartMode,
  RestartVia,
  RoleSpec,
  SubagentBudget,
  Switches,
  Trigger,
  TriggerLift,
  TriggerWhen,
} from '../types'

export const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/
const TRIGGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const READY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
// Paths end up inside the resume command line, so no whitespace or shell-ish characters.
const PATH_CHARS = /^[A-Za-z0-9._/-]+$/
const TEMPLATE_PATH_CHARS = /^[A-Za-z0-9._/{}-]+$/
const NO_SPACE = /^\S+$/

const SECOND = 1000
const MINUTE = 60 * SECOND
// $.process.run refuses a timeout past 10 minutes.
const MAX_CHECK_TIMEOUT = 10 * MINUTE

export const DEFAULT_STATE_DIR = '.ctx-guard'
export const DEFAULT_READY_TOKEN = 'CTX-READY'
export const DEFAULT_RESTART_COMMAND = 'ctx-guard:resume'
export const DEFAULT_PEER_GAP = 10 * MINUTE
export const DEFAULT_SELF_GAP = 5 * MINUTE
export const DEFAULT_CHECK_TIMEOUT = 30 * SECOND
export const DEFAULT_PROBE_EVERY = 60 * SECOND
export const MIN_PROBE_EVERY = 15 * SECOND
export const DEFAULT_PROBE_TIMEOUT = 5 * SECOND
export const MAX_PROBE_TIMEOUT = 30 * SECOND
export const MAX_PROBES = 4
export const DISPLAYS: readonly Display[] = ['band', 'status', 'off']

export const DEFAULT_SWITCHES: Switches = {
  enabled: true,
  configPath: '.claude/ctx-guard.json',
  defaultRole: null,
  blocking: true,
  autoActions: true,
  noteToasts: true,
  display: 'band',
}

// ---- quantities --------------------------------------------------------------

const NUM = '(\\d+(?:\\.\\d+)?)'
const BARE = new RegExp(`^${NUM}$`)
const PERCENT = new RegExp(`^${NUM}\\s*%$`)
const TOKENS = new RegExp(`^${NUM}\\s*([kKmM])$`)
const DURATION = new RegExp(`^${NUM}\\s*(ms|s|m|h|d)$`)
const USD = new RegExp(`^\\$\\s*${NUM}$`)

const TOKEN_UNIT: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 }
const DURATION_UNIT: Record<string, number> = { ms: 1, s: SECOND, m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }

const KIND_TEXT: Record<QuantityKind, string> = {
  tokens: 'tokens ("300k", "1.2M", 150000)',
  percent: 'a percent ("40%")',
  duration: 'a duration ("10s", "10m", "2h", "1d")',
  usd: 'US dollars ("$2.50")',
  count: 'a whole number (3)',
}

function quantity(kind: QuantityKind, value: number): Quantity | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (kind === 'count' && !Number.isInteger(value)) return null
  if (kind === 'percent' && value > 100) return null
  const rounded = kind === 'tokens' || kind === 'duration' ? Math.round(value) : value
  return rounded > 0 ? { kind, value: rounded } : null
}

/**
 * Parses a threshold. `allowed` lists the kinds the field takes; `bare` is the
 * kind a plain number (or numeric string) means there. A field never allows
 * both tokens and duration, so "10m" is ten minutes or ten million tokens by
 * field, never both. Anything else, zero, negatives and percents over 100 → null.
 */
export function parseQuantity(input: unknown, allowed: readonly QuantityKind[], bare?: QuantityKind): Quantity | null {
  const bareKind = bare !== undefined && allowed.includes(bare) ? bare : null
  if (typeof input === 'number') return bareKind ? quantity(bareKind, input) : null
  if (typeof input !== 'string') return null
  const s = input.trim()
  let m = BARE.exec(s)
  if (m) return bareKind ? quantity(bareKind, Number(m[1])) : null
  if (allowed.includes('percent') && (m = PERCENT.exec(s))) return quantity('percent', Number(m[1]))
  if (allowed.includes('tokens') && (m = TOKENS.exec(s))) {
    return quantity('tokens', Number(m[1]) * (TOKEN_UNIT[m[2] ?? ''] ?? NaN))
  }
  if (allowed.includes('duration') && (m = DURATION.exec(s))) {
    return quantity('duration', Number(m[1]) * (DURATION_UNIT[m[2] ?? ''] ?? NaN))
  }
  if (allowed.includes('usd') && (m = USD.exec(s))) return quantity('usd', Number(m[1]))
  return null
}

// ---- paths -------------------------------------------------------------------

/**
 * Why a config path is not a relative path that stays under the root, or null.
 * `template` lets `{placeholder}` braces through.
 */
export function pathError(rel: unknown, template = false): string | null {
  if (typeof rel !== 'string' || rel === '') return 'expected a relative path'
  if (/^([/\\~]|[A-Za-z]:)/.test(rel)) return 'must be relative to the project root, not absolute'
  if (!(template ? TEMPLATE_PATH_CHARS : PATH_CHARS).test(rel)) {
    return `may hold only letters, digits and . _ - /${template ? ' { }' : ''}`
  }
  const parts: string[] = []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return 'must stay under the project root (".." escapes it)'
      parts.pop()
    } else parts.push(seg)
  }
  return parts.length === 0 ? 'must name a path under the project root, not the root itself' : null
}

function normalizePath(rel: string): string {
  const parts: string[] = []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/**
 * Joins a relative path template under `root`, refusing absolute paths and
 * `..` escapes at string level. Symlinks are checked later through the fs.
 */
export function confinePath(root: string, rel: string, template = false): { path: string } | { error: string } {
  const error = pathError(rel, template)
  if (error) return { error }
  const base = root.replace(/[/\\]+$/, '')
  return { path: `${base}/${normalizePath(rel)}` }
}

// ---- merge -------------------------------------------------------------------

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Names that collide with Object.prototype (its own names include the
// prototype accessor), refused as role or subagent keys and never copied by a
// merge, so a config file cannot reach the prototype.
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])

export function isReservedKey(k: string): boolean {
  return RESERVED_KEYS.has(k)
}

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/**
 * Later wins; plain objects merge key by key, arrays and scalars replace, and
 * a null in the later layer deletes the key so the built-in default applies.
 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base
  if (!isObj(base) || !isObj(over)) return over
  const out = dict<unknown>()
  for (const [k, v] of Object.entries(base)) if (!RESERVED_KEYS.has(k)) out[k] = v
  for (const [k, v] of Object.entries(over)) {
    if (RESERVED_KEYS.has(k)) continue
    if (v === null) delete out[k]
    else out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out
}

// Within one layer a null key means the same as an absent one.
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (!isObj(v)) return v
  const out = dict<unknown>()
  for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = stripNulls(x)
  return out
}

function own<T>(map: Record<string, T>, key: string): T | null {
  return Object.hasOwn(map, key) ? (map[key] ?? null) : null
}

/** A role's effective spec, safe for any name (maps lose their null prototype in $.state). */
export function roleSpec(config: Config, name: string): RoleSpec | null {
  return own(config.roles, name)
}

/** A subagent type's own entry merged field by field over "*": unset inherits, "off" has no such step. */
function resolveBudget(map: Record<string, SubagentBudget>, type: string): Budget | null {
  const star = own(map, '*')
  const mine = type === '*' ? null : own(map, type)
  if (!star && !mine) return null
  const pick = (k: 'warn' | 'stop'): number | null => {
    const v = mine?.[k] ?? star?.[k] ?? null
    return v === 'off' ? null : v
  }
  return { type: mine ? type : '*', warn: pick('warn'), stop: pick('stop'), message: mine?.message ?? star?.message ?? null }
}

/**
 * The budget a subagent of `type` runs under (an unknown type or none, "*"),
 * or null when no step applies.
 */
export function subagentBudget(config: Config, type: string | null): Budget | null {
  const b = resolveBudget(config.subagents, type ?? '*')
  if (!b || (b.warn === null && b.stop === null)) return null
  // A warn at or past the stop says nothing the stop note does not (a merge the validation never saw).
  return b.warn !== null && b.stop !== null && b.warn >= b.stop ? { ...b, warn: null } : b
}

export function mergeLayers(...layers: unknown[]): unknown {
  return layers.reduce<unknown>((acc, layer) => deepMerge(acc, layer), {})
}

// ---- validation helpers ------------------------------------------------------

type Ctx = { errors: string[]; label: string }

const silent = (): Ctx => ({ errors: [], label: '' })

function err(ctx: Ctx, path: string, msg: string): void {
  ctx.errors.push(`${ctx.label}: ${path || '(top level)'}: ${msg}`)
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key)

function shown(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    if (s === undefined) return String(v)
    return s.length > 60 ? `${s.slice(0, 57)}...` : s
  } catch {
    return String(v)
  }
}

function checkKeys(ctx: Ctx, path: string, o: Obj, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) err(ctx, join(path, k), `unknown key; expected one of ${allowed.join(', ')}`)
  }
}

function objAt(ctx: Ctx, path: string, v: unknown): Obj {
  if (v === undefined) return {}
  if (isObj(v)) return v
  err(ctx, path, `expected an object, got ${shown(v)}`)
  return {}
}

function boolAt(ctx: Ctx, path: string, v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback
  if (typeof v === 'boolean') return v
  err(ctx, path, `expected true or false, got ${shown(v)}`)
  return fallback
}

function strAt(ctx: Ctx, path: string, v: unknown, fallback: string, pattern?: RegExp): string {
  if (v === undefined) return fallback
  if (typeof v !== 'string' || v.trim() === '') {
    err(ctx, path, `expected a non-empty string, got ${shown(v)}`)
    return fallback
  }
  if (pattern && !pattern.test(v)) {
    err(ctx, path, `${shown(v)} must match ${pattern.source}`)
    return fallback
  }
  return v
}

// Optional free text; null and absent both mean none.
function textAt(ctx: Ctx, path: string, v: unknown, fallback: string | null): string | null {
  if (v === undefined) return fallback
  if (v === null) return null
  if (typeof v === 'string' && v.trim() !== '') return v
  err(ctx, path, `expected a non-empty string or null, got ${shown(v)}`)
  return fallback
}

function enumAt<T extends string>(ctx: Ctx, path: string, v: unknown, values: readonly T[], fallback: T): T {
  if (v === undefined) return fallback
  if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T
  err(ctx, path, `expected one of ${values.join(', ')}, got ${shown(v)}`)
  return fallback
}

function qtyAt(ctx: Ctx, path: string, v: unknown, allowed: readonly QuantityKind[], bare?: QuantityKind): Quantity | null {
  const q = parseQuantity(v, allowed, bare)
  if (!q) err(ctx, path, `expected ${allowed.map(k => KIND_TEXT[k]).join(' or ')}, got ${shown(v)}`)
  return q
}

function durationAt(ctx: Ctx, path: string, v: unknown, fallback: number, max?: number): number {
  if (v === undefined) return fallback
  const q = qtyAt(ctx, path, v, ['duration'])
  if (!q) return fallback
  if (max !== undefined && q.value > max) {
    err(ctx, path, `${shown(v)} is longer than the ${max / MINUTE}m maximum`)
    return fallback
  }
  return q.value
}

// A duration where "0" (or 0) turns the gap off.
function gapAt(ctx: Ctx, path: string, v: unknown, fallback: number): number {
  if (v === 0 || (typeof v === 'string' && /^\s*0\s*$/.test(v))) return 0
  return durationAt(ctx, path, v, fallback)
}

function pathAt(ctx: Ctx, path: string, v: unknown, fallback: string, template = false): string {
  if (v === undefined) return fallback
  const e = pathError(v, template)
  if (e) {
    err(ctx, path, `${shown(v)} ${e}`)
    return fallback
  }
  return normalizePath(v as string)
}

// ---- schema v1 ---------------------------------------------------------------

const TOP_KEYS = ['$schema', 'version', 'enabled', 'stateDir', 'readyToken', 'defaultRole', 'contextWindow', 'defaults', 'roles', 'subagents', 'band', 'cache']
const ROLE_KEYS = ['description', 'triggers', 'notes', 'handoff', 'restart', 'compact']
const TRIGGER_KEYS = ['id', 'when', 'do', 'level', 'message', 'times', 'lift']
const LIMIT_METRICS = ['limit.five_hour', 'limit.seven_day', 'limit.any'] as const
// Time left to a window's reset; each needs its window's percent metric beside it.
const RESETS_IN = { 'limit.five_hour.resetsIn': 'limit.five_hour', 'limit.seven_day.resetsIn': 'limit.seven_day' } as const
const RESETS_IN_METRICS = Object.keys(RESETS_IN) as (keyof typeof RESETS_IN)[]
const CACHE_METRICS = ['cache.expiresIn', 'cache.miss', 'cache.pings'] as const
const METRICS = ['context', ...LIMIT_METRICS, ...RESETS_IN_METRICS, 'cost', 'idle', ...CACHE_METRICS] as const
const WHEN_KEYS = [...METRICS, 'every']
const STEPPABLE = ['context', ...LIMIT_METRICS, 'cost'] as const
const EDGE_ACTIONS = ['note', 'toast', 'notify', 'compact', 'ping', 'prompt'] as const
const LIFT_ACTIONS: readonly LiftAction[] = ['note', 'toast', 'notify', 'prompt']
const LEVELS: readonly Level[] = ['soft', 'hard', 'stop']
const MODES: readonly RestartMode[] = ['auto', 'manual', 'off']
const VIAS: readonly RestartVia[] = ['clear', 'compact']

type MetricKey = (typeof METRICS)[number]

// What each metric (and `every` stepping it) parses as.
const METRIC_KINDS: Record<MetricKey, { allowed: readonly QuantityKind[]; bare?: QuantityKind }> = {
  context: { allowed: ['tokens', 'percent'], bare: 'tokens' },
  'limit.five_hour': { allowed: ['percent'], bare: 'percent' },
  'limit.seven_day': { allowed: ['percent'], bare: 'percent' },
  'limit.any': { allowed: ['percent'], bare: 'percent' },
  'limit.five_hour.resetsIn': { allowed: ['duration'] },
  'limit.seven_day.resetsIn': { allowed: ['duration'] },
  cost: { allowed: ['usd'], bare: 'usd' },
  idle: { allowed: ['duration'] },
  'cache.expiresIn': { allowed: ['duration'] },
  'cache.miss': { allowed: ['tokens'], bare: 'tokens' },
  'cache.pings': { allowed: ['count'], bare: 'count' },
}

function emptyWhen(): TriggerWhen {
  return {
    context: null,
    'limit.five_hour': null,
    'limit.seven_day': null,
    'limit.any': null,
    'limit.five_hour.resetsIn': null,
    'limit.seven_day.resetsIn': null,
    cost: null,
    idle: null,
    'cache.expiresIn': null,
    'cache.miss': null,
    'cache.pings': null,
    every: null,
    everyMetric: null,
  }
}

function normalizeWhen(ctx: Ctx, path: string, v: unknown): TriggerWhen | null {
  if (!isObj(v)) {
    err(ctx, path, `expected an object of metrics (${METRICS.join(', ')}), got ${shown(v)}`)
    return null
  }
  checkKeys(ctx, path, v, WHEN_KEYS)
  const when = emptyWhen()
  let ok = true
  for (const metric of METRICS) {
    if (v[metric] === undefined) continue
    const { allowed, bare } = METRIC_KINDS[metric]
    when[metric] = qtyAt(ctx, join(path, metric), v[metric], allowed, bare)
    if (!when[metric]) ok = false
  }
  if (!METRICS.some(m => v[m] !== undefined)) {
    err(ctx, path, `needs at least one metric: ${METRICS.join(', ')}`)
    return null
  }
  // Time left alone says nothing about how much of the window is used.
  for (const metric of RESETS_IN_METRICS) {
    const window = RESETS_IN[metric]
    if (v[metric] !== undefined && v[window] === undefined) {
      err(ctx, join(path, metric), `needs ${window} in the same \`when\``)
      ok = false
    }
  }
  if (v.every !== undefined) {
    const stepped = STEPPABLE.filter(m => v[m] !== undefined)
    const only = stepped.length === 1 ? stepped[0] : undefined
    if (only === undefined) {
      const why = stepped.length === 0 ? 'none is set' : `${stepped.join(' and ')} are all set`
      err(ctx, join(path, 'every'), `needs exactly one of ${STEPPABLE.join(', ')} to step; ${why}`)
      ok = false
    } else if (when[only]) {
      // A step of another kind (tokens on a percent threshold) would need the window to compare.
      const kind = when[only].kind
      when.every = qtyAt(ctx, join(path, 'every'), v.every, [kind], kind)
      when.everyMetric = only
      if (!when.every) ok = false
    }
  }
  return ok ? when : null
}

function normalizeAction(ctx: Ctx, path: string, v: unknown): Action | null {
  if (typeof v === 'string' && (EDGE_ACTIONS as readonly string[]).includes(v)) return v as Action
  if (isObj(v)) {
    checkKeys(ctx, path, v, ['deny'])
    const tools = v.deny
    if (Array.isArray(tools) && tools.length > 0 && tools.every(t => typeof t === 'string' && NO_SPACE.test(t))) {
      return { deny: [...(tools as string[])] }
    }
    err(ctx, join(path, 'deny'), `expected a non-empty list of tool names, got ${shown(tools)}`)
    return null
  }
  err(ctx, path, `expected one of ${EDGE_ACTIONS.join(', ')} or {"deny": [tools]}, got ${shown(v)}`)
  return null
}

const WHOLE = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1

/**
 * A trigger's `lift`: what runs when its deny lets go. Only a trigger that
 * denies has one; `prompt` needs `times`, which caps wake attempts and means
 * nothing without it.
 */
function normalizeLift(ctx: Ctx, path: string, v: unknown, denies: boolean): TriggerLift | null {
  if (!isObj(v)) {
    err(ctx, path, `expected {"do": [actions], "times": 3, "message": "..."}, got ${shown(v)}`)
    return null
  }
  checkKeys(ctx, path, v, ['do', 'times', 'message'])
  const before = ctx.errors.length
  if (!denies) err(ctx, path, 'lift needs a deny to lift')
  const actions: LiftAction[] = []
  const dp = join(path, 'do')
  if (!Array.isArray(v.do) || v.do.length === 0) err(ctx, dp, `expected a non-empty list of ${LIFT_ACTIONS.join(', ')}, got ${shown(v.do)}`)
  else {
    v.do.forEach((a, i) => {
      if (typeof a === 'string' && (LIFT_ACTIONS as readonly string[]).includes(a)) actions.push(a as LiftAction)
      else err(ctx, `${dp}[${i}]`, `expected one of ${LIFT_ACTIONS.join(', ')}, got ${shown(a)}`)
    })
  }
  const prompt = actions.includes('prompt')
  let times: number | null = null
  if (v.times !== undefined) {
    if (!WHOLE(v.times)) err(ctx, join(path, 'times'), `expected a whole number of at least 1, got ${shown(v.times)}`)
    else if (!prompt) err(ctx, join(path, 'times'), 'caps wake prompts, so it needs prompt in lift.do')
    else times = v.times
  } else if (prompt) err(ctx, join(path, 'times'), 'prompt needs times, so automatic spending has a cap')
  const message = textAt(ctx, join(path, 'message'), v.message, null)
  return ctx.errors.length > before ? null : { do: actions, times, message }
}

function normalizeTrigger(ctx: Ctx, path: string, v: unknown): Trigger | null {
  if (!isObj(v)) {
    err(ctx, path, `expected a trigger object, got ${shown(v)}`)
    return null
  }
  checkKeys(ctx, path, v, TRIGGER_KEYS)
  const before = ctx.errors.length
  const id = v.id === undefined ? (err(ctx, join(path, 'id'), 'required'), '') : strAt(ctx, join(path, 'id'), v.id, '', TRIGGER_ID)
  const when = v.when === undefined ? (err(ctx, join(path, 'when'), 'required'), null) : normalizeWhen(ctx, join(path, 'when'), v.when)
  const actions: Action[] = []
  if (!Array.isArray(v.do) || v.do.length === 0) {
    err(ctx, join(path, 'do'), `expected a non-empty list of actions, got ${shown(v.do)}`)
  } else {
    v.do.forEach((a, i) => {
      const action = normalizeAction(ctx, `${join(path, 'do')}[${i}]`, a)
      if (action) actions.push(action)
    })
  }
  // A deny is judged at each tool call, when the session is never idle.
  if (when?.idle && actions.some(a => typeof a === 'object')) {
    err(ctx, join(path, 'do'), 'deny cannot be combined with an idle metric')
  }
  // A deny is judged at each tool call; the cache figures move only between requests.
  if (CACHE_METRICS.some(m => when?.[m]) && actions.some(a => typeof a === 'object')) {
    err(ctx, join(path, 'do'), 'deny cannot be combined with a cache metric')
  }
  const auto = actions.filter((a): a is 'ping' | 'prompt' => a === 'ping' || a === 'prompt')
  if (actions.includes('ping') && when && !when['cache.expiresIn']) {
    err(ctx, join(path, 'do'), 'ping needs cache.expiresIn in the same `when`')
  }
  let times: number | null = null
  if (v.times !== undefined) {
    if (WHOLE(v.times)) times = v.times
    else err(ctx, join(path, 'times'), `expected a whole number of at least 1, got ${shown(v.times)}`)
  } else if (auto.length) {
    err(ctx, join(path, 'times'), `${auto.join(' and ')} needs times, so automatic spending has a cap`)
  }
  const level = v.level === undefined ? null : enumAt<Level>(ctx, join(path, 'level'), v.level, LEVELS, 'soft')
  const message = textAt(ctx, join(path, 'message'), v.message, null)
  const lift = v.lift === undefined ? null : normalizeLift(ctx, join(path, 'lift'), v.lift, actions.some(a => typeof a === 'object'))
  if (ctx.errors.length > before || !when) return null
  return { id, when, do: actions, level, message, times, lift }
}

function normalizeTriggers(ctx: Ctx, path: string, v: unknown): Trigger[] {
  if (v === undefined) return defaultTriggers()
  if (!Array.isArray(v)) {
    err(ctx, path, `expected a list of triggers, got ${shown(v)}`)
    return defaultTriggers()
  }
  const out: Trigger[] = []
  const seen = new Set<string>()
  v.forEach((t, i) => {
    const p = `${path}[${i}]`
    const trigger = normalizeTrigger(ctx, p, t)
    if (!trigger) return
    if (seen.has(trigger.id)) {
      err(ctx, join(p, 'id'), `duplicate trigger id ${shown(trigger.id)}`)
      return
    }
    seen.add(trigger.id)
    out.push(trigger)
  })
  return out
}

// A command and its arguments, run without a shell; null after reporting what is wrong.
function runAt(ctx: Ctx, path: string, run: unknown): string[] | null {
  if (!Array.isArray(run) || run.length === 0 || !run.every(a => typeof a === 'string') || (run[0] as string).trim() === '') {
    err(ctx, path, `expected a non-empty list of strings (command, then args), got ${shown(run)}`)
    return null
  }
  return [...(run as string[])]
}

// A duration held between `min` and `max` (null for no bound), told in seconds.
function secondsAt(ctx: Ctx, path: string, v: unknown, fallback: number, min: number | null, max: number | null): number {
  if (v === undefined) return fallback
  const q = qtyAt(ctx, path, v, ['duration'])
  if (!q) return fallback
  if (min !== null && q.value < min) {
    err(ctx, path, `${shown(v)} is shorter than the ${min / SECOND}s minimum`)
    return fallback
  }
  if (max !== null && q.value > max) {
    err(ctx, path, `${shown(v)} is longer than the ${max / SECOND}s maximum`)
    return fallback
  }
  return q.value
}

function normalizeReadyCheck(ctx: Ctx, path: string, v: unknown): ReadyCheck | null {
  if (!isObj(v)) {
    err(ctx, path, `expected {"run": [command, ...args], "timeout": "10s"}, got ${shown(v)}`)
    return null
  }
  checkKeys(ctx, path, v, ['run', 'timeout'])
  const before = ctx.errors.length
  const run = runAt(ctx, join(path, 'run'), v.run)
  const timeout = durationAt(ctx, join(path, 'timeout'), v.timeout, DEFAULT_CHECK_TIMEOUT, MAX_CHECK_TIMEOUT)
  return ctx.errors.length > before || !run ? null : { run, timeout }
}

function normalizeProbe(ctx: Ctx, path: string, v: unknown): BandProbeSpec | null {
  if (!isObj(v)) {
    err(ctx, path, `expected {"id": "run", "run": [command, ...args], "every": "60s", "timeout": "5s"}, got ${shown(v)}`)
    return null
  }
  checkKeys(ctx, path, v, ['id', 'run', 'every', 'timeout'])
  const before = ctx.errors.length
  if (v.id === undefined) err(ctx, join(path, 'id'), 'is required')
  const id = strAt(ctx, join(path, 'id'), v.id, '', ROLE_NAME)
  const run = runAt(ctx, join(path, 'run'), v.run)
  const every = secondsAt(ctx, join(path, 'every'), v.every, DEFAULT_PROBE_EVERY, MIN_PROBE_EVERY, null)
  const timeout = secondsAt(ctx, join(path, 'timeout'), v.timeout, DEFAULT_PROBE_TIMEOUT, null, MAX_PROBE_TIMEOUT)
  return ctx.errors.length > before || !run ? null : { id, run, every, timeout }
}

function normalizeBand(ctx: Ctx, path: string, v: unknown): Config['band'] {
  const o = objAt(ctx, path, v)
  checkKeys(ctx, path, o, ['probes'])
  const probes: BandProbeSpec[] = []
  if (o.probes === undefined) return { probes }
  const pp = join(path, 'probes')
  if (!Array.isArray(o.probes)) {
    err(ctx, pp, `expected a list, got ${shown(o.probes)}`)
    return { probes }
  }
  if (o.probes.length > MAX_PROBES) err(ctx, pp, `at most ${MAX_PROBES} probes, got ${o.probes.length}`)
  o.probes.forEach((raw, i) => {
    const p = normalizeProbe(ctx, `${pp}[${i}]`, raw)
    if (!p) return
    if (probes.some(x => x.id === p.id)) err(ctx, `${pp}[${i}].id`, `duplicate probe id "${p.id}"`)
    else probes.push(p)
  })
  return { probes }
}

const TTLS: Record<string, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

export const DEFAULT_CACHE: CacheConfig = {
  ttl: 'auto',
  band: { show: { kind: 'percent', value: 25 }, warn: { kind: 'duration', value: 10 * MINUTE } },
  ping: { maxUsage: 90 },
  prompt: { maxUsage: 90 },
}

function normalizeCache(ctx: Ctx, path: string, v: unknown): CacheConfig {
  const o = objAt(ctx, path, v)
  checkKeys(ctx, path, o, ['ttl', 'band', 'ping', 'prompt'])
  let ttl: CacheConfig['ttl'] = DEFAULT_CACHE.ttl
  if (o.ttl !== undefined && o.ttl !== 'auto') {
    const key = typeof o.ttl === 'string' ? o.ttl.trim() : ''
    const ms = Object.hasOwn(TTLS, key) ? TTLS[key] : undefined
    if (ms === undefined) err(ctx, join(path, 'ttl'), `expected "auto", "5m" or "1h", got ${shown(o.ttl)}`)
    else ttl = ms
  }
  const band = objAt(ctx, join(path, 'band'), o.band)
  checkKeys(ctx, join(path, 'band'), band, ['show', 'warn'])
  let show: CacheShow = DEFAULT_CACHE.band.show
  if (band.show === false) show = 'off'
  else if (band.show === 'always') show = 'always'
  else if (band.show !== undefined) show = qtyAt(ctx, join(path, 'band.show'), band.show, ['duration', 'percent']) ?? DEFAULT_CACHE.band.show
  const warn =
    band.warn === undefined ? DEFAULT_CACHE.band.warn : (qtyAt(ctx, join(path, 'band.warn'), band.warn, ['duration', 'percent']) ?? DEFAULT_CACHE.band.warn)
  const maxUsage = (key: 'ping' | 'prompt'): number => {
    const block = objAt(ctx, join(path, key), o[key])
    checkKeys(ctx, join(path, key), block, ['maxUsage'])
    const fallback = DEFAULT_CACHE[key].maxUsage
    if (block.maxUsage === undefined) return fallback
    return qtyAt(ctx, join(path, `${key}.maxUsage`), block.maxUsage, ['percent'], 'percent')?.value ?? fallback
  }
  return { ttl, band: { show, warn }, ping: { maxUsage: maxUsage('ping') }, prompt: { maxUsage: maxUsage('prompt') } }
}

/** A trigger with a cache metric in its `when`: its prompt keeps the cache warm, and stops at cache.prompt.maxUsage. */
export const onCacheMetric = (t: Trigger): boolean => CACHE_METRICS.some(m => t.when[m] != null)

function handoffPathAt(ctx: Ctx, path: string, v: unknown, fallback: string): string {
  const p = pathAt(ctx, path, v, fallback, true)
  if (v === undefined || p === fallback) return p
  if (/[{}]/.test(String(v).replace(/\{role\}/g, ''))) {
    err(ctx, path, `${shown(v)} holds an unknown placeholder or a stray brace; only {role} is filled in`)
    return fallback
  }
  return p
}

function normalizeRole(ctx: Ctx, path: string, v: unknown, stateDir: string): RoleSpec {
  const o = objAt(ctx, path, v)
  checkKeys(ctx, path, o, ROLE_KEYS)
  const notes = objAt(ctx, join(path, 'notes'), o.notes)
  checkKeys(ctx, join(path, 'notes'), notes, ['suffix'])
  const handoff = objAt(ctx, join(path, 'handoff'), o.handoff)
  const hp = join(path, 'handoff')
  checkKeys(ctx, hp, handoff, ['path', 'instructions'])
  const restart = objAt(ctx, join(path, 'restart'), o.restart)
  const rp = join(path, 'restart')
  checkKeys(ctx, rp, restart, ['mode', 'via', 'command', 'prompt', 'peers', 'peerGap', 'selfGap', 'minContext', 'readyChecks'])
  const compact = objAt(ctx, join(path, 'compact'), o.compact)
  checkKeys(ctx, join(path, 'compact'), compact, ['instructions'])

  const peers: string[] = []
  if (restart.peers !== undefined) {
    if (!Array.isArray(restart.peers)) err(ctx, join(rp, 'peers'), `expected a list of role names, got ${shown(restart.peers)}`)
    else {
      restart.peers.forEach((p, i) => {
        if (typeof p === 'string' && ROLE_NAME.test(p)) peers.push(p)
        else err(ctx, `${join(rp, 'peers')}[${i}]`, `${shown(p)} must match ${ROLE_NAME.source}`)
      })
    }
  }
  const readyChecks: ReadyCheck[] = []
  if (restart.readyChecks !== undefined) {
    if (!Array.isArray(restart.readyChecks)) err(ctx, join(rp, 'readyChecks'), `expected a list, got ${shown(restart.readyChecks)}`)
    else {
      restart.readyChecks.forEach((c, i) => {
        const check = normalizeReadyCheck(ctx, `${join(rp, 'readyChecks')}[${i}]`, c)
        if (check) readyChecks.push(check)
      })
    }
  }
  const command = strAt(ctx, join(rp, 'command'), restart.command, DEFAULT_RESTART_COMMAND).replace(/^\//, '')
  if (!COMMAND_NAME.test(command)) err(ctx, join(rp, 'command'), `${shown(restart.command)} is not a command name`)

  return {
    description: textAt(ctx, join(path, 'description'), o.description, null),
    triggers: normalizeTriggers(ctx, join(path, 'triggers'), o.triggers),
    notes: { suffix: textAt(ctx, join(path, 'notes.suffix'), notes.suffix, null) },
    handoff: {
      path: handoffPathAt(ctx, join(hp, 'path'), handoff.path, `${stateDir}/{role}-handoff.md`),
      instructions: textAt(ctx, join(hp, 'instructions'), handoff.instructions, null),
    },
    restart: {
      mode: enumAt(ctx, join(rp, 'mode'), restart.mode, MODES, 'manual'),
      via: enumAt(ctx, join(rp, 'via'), restart.via, VIAS, 'clear'),
      command,
      prompt: textAt(ctx, join(rp, 'prompt'), restart.prompt, null),
      peers,
      peerGap: durationAt(ctx, join(rp, 'peerGap'), restart.peerGap, DEFAULT_PEER_GAP),
      selfGap: gapAt(ctx, join(rp, 'selfGap'), restart.selfGap, DEFAULT_SELF_GAP),
      minContext: restart.minContext === undefined || restart.minContext === 'off' ? null : qtyAt(ctx, join(rp, 'minContext'), restart.minContext, ['tokens', 'percent'], 'tokens'),
      readyChecks,
    },
    compact: { instructions: textAt(ctx, join(path, 'compact.instructions'), compact.instructions, null) },
  }
}

// A budget step: tokens, or "off" for none (null, as everywhere, leaves the key unset: the "*" value applies).
function budgetAt(ctx: Ctx, path: string, v: unknown): number | 'off' | null {
  if (v === undefined) return null
  if (v === 'off') return 'off'
  // Tokens only: a subagent's model and window may differ from the main loop's.
  const q = parseQuantity(v, ['tokens'], 'tokens')
  if (!q) err(ctx, path, `expected tokens ("120k") or "off", got ${shown(v)}`)
  return q ? q.value : null
}

function normalizeSubagents(ctx: Ctx, path: string, v: unknown): Record<string, SubagentBudget> {
  const o = objAt(ctx, path, v)
  const out = dict<SubagentBudget>()
  for (const [type, raw] of Object.entries(o)) {
    const p = join(path, type)
    if (!NO_SPACE.test(type) || RESERVED_KEYS.has(type)) {
      err(ctx, p, 'expected "*" or a subagent type name')
      continue
    }
    if (!isObj(raw)) {
      err(ctx, p, `expected {"warn": "120k", "stop": "170k", "message": "..."}, got ${shown(raw)}`)
      continue
    }
    checkKeys(ctx, p, raw, ['warn', 'stop', 'message'])
    const before = ctx.errors.length
    const warn = budgetAt(ctx, join(p, 'warn'), raw.warn)
    const stop = budgetAt(ctx, join(p, 'stop'), raw.stop)
    const message = textAt(ctx, join(p, 'message'), raw.message, null)
    if (ctx.errors.length > before) continue
    if (warn === null && stop === null && message === null) {
      err(ctx, p, 'needs warn, stop or message')
      continue
    }
    out[type] = { warn, stop, message }
  }
  // Checked once merged with "*", since a type inherits what it leaves unset.
  for (const type of Object.keys(out)) {
    const b = resolveBudget(out, type)
    if (b?.warn != null && b.stop != null && b.warn >= b.stop) {
      const from = (k: 'warn' | 'stop'): string => (type !== '*' && out[type]?.[k] === null ? ' from "*"' : '')
      err(ctx, join(path, type), `warn (${b.warn}${from('warn')}) must be below stop (${b.stop}${from('stop')})`)
      delete out[type]
    }
  }
  return out
}

function normalizeConfig(ctx: Ctx, raw: unknown): Config {
  const o = objAt(ctx, '', raw)
  checkKeys(ctx, '', o, TOP_KEYS)
  if (o.version !== undefined && o.version !== 1) {
    err(ctx, 'version', `unsupported version ${shown(o.version)}; this ctx-guard reads version 1`)
  }
  const stateDir = pathAt(ctx, 'stateDir', o.stateDir, DEFAULT_STATE_DIR)
  let defaultRole: string | null = null
  if (o.defaultRole !== undefined && o.defaultRole !== '') {
    defaultRole = strAt(ctx, 'defaultRole', o.defaultRole, '', ROLE_NAME) || null
  }
  let contextWindow: number | 'auto' = 'auto'
  if (o.contextWindow !== undefined && o.contextWindow !== 'auto') {
    const q = parseQuantity(o.contextWindow, ['tokens'], 'tokens')
    if (q) contextWindow = q.value
    else err(ctx, 'contextWindow', `expected "auto" or ${KIND_TEXT.tokens}, got ${shown(o.contextWindow)}`)
  }

  const rawDefaults = objAt(ctx, 'defaults', o.defaults)
  const defaults = normalizeRole(ctx, 'defaults', rawDefaults, stateDir)
  const roles = dict<RoleSpec>()
  for (const [name, rawRole] of Object.entries(objAt(ctx, 'roles', o.roles))) {
    const p = join('roles', name)
    if (!ROLE_NAME.test(name)) {
      err(ctx, p, `role name must match ${ROLE_NAME.source}`)
      continue
    }
    if (RESERVED_KEYS.has(name)) {
      err(ctx, p, 'role name is reserved')
      continue
    }
    if (!isObj(rawRole)) {
      err(ctx, p, `expected a role object, got ${shown(rawRole)}`)
      continue
    }
    // Report the role's own keys at its path; inherited ones were reported under defaults.
    normalizeRole(ctx, p, rawRole, stateDir)
    roles[name] = normalizeRole(silent(), p, deepMerge(rawDefaults, rawRole), stateDir)
  }

  return {
    version: 1,
    enabled: boolAt(ctx, 'enabled', o.enabled, true),
    stateDir,
    readyToken: strAt(ctx, 'readyToken', o.readyToken, DEFAULT_READY_TOKEN, READY_TOKEN),
    defaultRole,
    contextWindow,
    defaults,
    roles,
    subagents: normalizeSubagents(ctx, 'subagents', o.subagents),
    band: normalizeBand(ctx, 'band', o.band),
    cache: normalizeCache(ctx, 'cache', o.cache),
  }
}

/**
 * Validates one config object against schema v1, filling built-in defaults
 * for every absent key. Errors are `<label>: <path>: <reason>`; with any
 * error the config is null.
 */
export function validate(raw: unknown, label = 'config'): { config: Config | null; errors: string[] } {
  const ctx: Ctx = { errors: [], label }
  try {
    const config = normalizeConfig(ctx, stripNulls(raw))
    return { config: ctx.errors.length ? null : config, errors: ctx.errors }
  } catch (e) {
    return { config: null, errors: [...ctx.errors, `${label}: internal error: ${e instanceof Error ? e.message : String(e)}`] }
  }
}

// ---- built-ins ---------------------------------------------------------------

// Says nothing of a block: with `blocking` off there is none.
const EARLY_WEEK = 'With {resetsIn} still to the weekly reset, start no new subagents so the rest of the window lasts; do small steps in this session.'

// A brake's lift: tells a working model the tools are back, at no cost.
const LIFT_NOTE = { do: ['note'] }

// The ladder a role gets when neither it nor `defaults` lists triggers.
const DEFAULT_TRIGGERS_RAW = [
  { id: 'ctx-soft', when: { context: '40%' }, do: ['note'], level: 'soft' },
  { id: 'ctx-hard', when: { context: '60%' }, do: ['note'], level: 'hard' },
  { id: 'ctx-stop', when: { context: '75%', every: '5%' }, do: ['note'], level: 'stop' },
  { id: 'limit-soft', when: { 'limit.any': 80 }, do: ['note'], level: 'soft' },
  { id: 'limit-hard', when: { 'limit.any': 90 }, do: ['note', 'toast'], level: 'hard' },
  // The weekly window filling early: no new subagents (Workflow fans out more) while that much time is left, so the week lasts.
  { id: 'week-80-early', when: { 'limit.seven_day': 80, 'limit.seven_day.resetsIn': '2d' }, do: ['note', { deny: ['Agent', 'Workflow'] }], level: 'hard', message: EARLY_WEEK, lift: LIFT_NOTE },
  { id: 'week-90-early', when: { 'limit.seven_day': 90, 'limit.seven_day.resetsIn': '1d' }, do: ['note', { deny: ['Agent', 'Workflow'] }], level: 'hard', message: EARLY_WEEK, lift: LIFT_NOTE },
  { id: 'limit-stop', when: { 'limit.any': 95 }, do: ['note', 'toast', { deny: ['Agent', 'Workflow', 'WebSearch', 'WebFetch'] }], level: 'stop', lift: LIFT_NOTE },
]

// With no role: band plus toasts only, so a user-scope install changes no model behaviour.
const ZERO_CONFIG_TRIGGERS_RAW = [
  { id: 'ctx-50', when: { context: '50%' }, do: ['toast'], level: 'soft' },
  { id: 'ctx-70', when: { context: '70%' }, do: ['toast'], level: 'hard' },
  { id: 'ctx-85', when: { context: '85%' }, do: ['toast'], level: 'stop' },
  { id: 'limit-80', when: { 'limit.any': 80 }, do: ['toast'], level: 'soft' },
  { id: 'limit-90', when: { 'limit.any': 90 }, do: ['toast'], level: 'hard' },
]

function builtTriggers(raw: unknown[]): Trigger[] {
  return raw.map((t, i) => normalizeTrigger(silent(), `built-in[${i}]`, t)).filter((t): t is Trigger => t !== null)
}

export function defaultTriggers(): Trigger[] {
  return builtTriggers(DEFAULT_TRIGGERS_RAW)
}

/** The triggers a session with no role runs. */
export function zeroConfigTriggers(): Trigger[] {
  return builtTriggers(ZERO_CONFIG_TRIGGERS_RAW)
}

// Layer 1. `main` exists so `defaultRole: "main"` works with no project file.
export const BUILTIN_LAYER = { version: 1, roles: { main: {} } }

export function builtInConfig(): Config {
  // BUILTIN_LAYER is valid by construction.
  return validate(BUILTIN_LAYER, 'built-in').config as Config
}

// ---- switches and layers -----------------------------------------------------

/** Normalizes the `userConfig` values; a bad value falls back to its default. */
export function readSwitches(options: Readonly<Record<string, unknown>>): { switches: Switches; errors: string[] } {
  const ctx: Ctx = { errors: [], label: 'userConfig' }
  const d = DEFAULT_SWITCHES
  const configPath = pathAt(ctx, 'configPath', options.configPath, d.configPath)
  let defaultRole: string | null = null
  const dr = options.defaultRole
  if (typeof dr === 'string' && dr.trim() !== '') {
    if (ROLE_NAME.test(dr.trim())) defaultRole = dr.trim()
    else err(ctx, 'defaultRole', `${shown(dr)} must match ${ROLE_NAME.source}`)
  }
  return {
    switches: {
      enabled: boolAt(ctx, 'enabled', options.enabled, d.enabled),
      configPath,
      defaultRole,
      blocking: boolAt(ctx, 'blocking', options.blocking, d.blocking),
      autoActions: boolAt(ctx, 'autoActions', options.autoActions, d.autoActions),
      noteToasts: boolAt(ctx, 'noteToasts', options.noteToasts, d.noteToasts),
      display: enumAt(ctx, 'display', options.display, DISPLAYS, d.display),
    },
    errors: ctx.errors,
  }
}

/** `.claude/ctx-guard.json` → `.claude/ctx-guard.local.json`. */
export function localPathFor(configPath: string): string {
  return /\.json$/i.test(configPath) ? configPath.replace(/\.json$/i, '.local.json') : `${configPath}.local.json`
}

// A config file as read: `text` null when the file is absent.
export type FileLayer = { path: string; text: string | null }

export function parseLayer(file: FileLayer): { raw: Obj | null; errors: string[] } {
  if (file.text === null) return { raw: null, errors: [] }
  let raw: unknown
  try {
    raw = JSON.parse(file.text)
  } catch (e) {
    return { raw: null, errors: [`${file.path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (!isObj(raw)) return { raw: null, errors: [`${file.path}: expected a JSON object at the top level`] }
  return { raw, errors: [] }
}

export type Effective = {
  config: Config
  source: ConfigSource
  // True when a file was invalid and `config` is the last good one or the built-ins.
  fallback: boolean
  errors: string[]
  enabled: boolean
  blocking: boolean
  autoActions: boolean
  noteToasts: boolean
  display: Display
  // userConfig.defaultRole, kept out of the merge so a repo `defaultRole: null`
  // cannot erase it; roles resolve repo → this and report which one won.
  switchDefaultRole: string | null
}

/**
 * Layers built-ins → `files` (team, then local), each file checked
 * on its own so errors name it. Any invalid file keeps `lastGood`; with none,
 * the built-ins run with auto actions off.
 */
export function effectiveConfig(input: {
  switches: Switches
  files: readonly FileLayer[]
  lastGood: Config | null
  // Files that exist but could not be read count as invalid.
  readErrors?: readonly string[]
}): Effective {
  const { switches, files, lastGood } = input
  const errors: string[] = [...(input.readErrors ?? [])]
  const raws: Obj[] = []
  for (const file of files) {
    const { raw, errors: parseErrors } = parseLayer(file)
    errors.push(...parseErrors)
    if (!raw) continue
    errors.push(...validate(raw, file.path).errors)
    raws.push(raw)
  }
  const result = (config: Config, source: ConfigSource, fallback: boolean, autoActions: boolean): Effective => ({
    config,
    source,
    fallback,
    errors,
    enabled: switches.enabled && config.enabled,
    blocking: switches.blocking,
    autoActions,
    noteToasts: switches.noteToasts,
    display: switches.display,
    switchDefaultRole: switches.defaultRole,
  })

  if (errors.length === 0) {
    const merged = validate(mergeLayers(BUILTIN_LAYER, ...raws), 'effective config')
    if (merged.config) return result(merged.config, raws.length ? 'files' : 'built-in', false, switches.autoActions)
    errors.push(...merged.errors)
  }
  if (lastGood) return result(lastGood, 'last-good', true, switches.autoActions)
  return result(builtInConfig(), 'built-in', true, false)
}

/**
 * The window percentages count against: a fixed `contextWindow`, or with
 * `auto` the model's window, lowered to `autoCompactWindow` when settings set
 * one (compaction starts there, so the model never sees the rest).
 */
export function effectiveWindow(contextWindow: number | 'auto', modelWindow: number, autoCompactWindow: unknown): number {
  if (typeof contextWindow === 'number') return contextWindow
  const acw = typeof autoCompactWindow === 'number' && Number.isFinite(autoCompactWindow) && autoCompactWindow > 0 ? autoCompactWindow : null
  if (!(Number.isFinite(modelWindow) && modelWindow > 0)) return acw ?? 0
  return acw === null ? modelWindow : Math.min(modelWindow, acw)
}

// The window the engine itself settled (`context.breakdown.rawMaxTokens`)
// and how (`autocompactSource`): per-model settings, the env override and the
// engine's defaults included.
export type EngineWindow = { tokens: number; source: string }

export type WindowInfo = { tokens: number; source: string }

/**
 * The window percentages count against, and where it came from: a fixed
 * `contextWindow`; else the engine's own compaction window when it answered
 * one; else effectiveWindow()'s model window lowered by `autoCompactWindow`.
 */
export function resolveWindow(
  contextWindow: number | 'auto',
  modelWindow: number,
  engine: EngineWindow | null,
  autoCompactWindow: unknown,
): WindowInfo {
  if (typeof contextWindow === 'number') return { tokens: contextWindow, source: 'config' }
  if (engine && Number.isFinite(engine.tokens) && engine.tokens > 0) {
    const tokens = Number.isFinite(modelWindow) && modelWindow > 0 ? Math.min(modelWindow, engine.tokens) : engine.tokens
    return { tokens, source: `engine: ${engine.source}` }
  }
  const tokens = effectiveWindow('auto', modelWindow, autoCompactWindow)
  return { tokens, source: tokens < modelWindow ? 'autoCompactWindow setting' : 'model window' }
}

// ---- stored config state -----------------------------------------------------

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

function isSpecShape(v: unknown): boolean {
  if (!isObj(v)) return false
  const { triggers, notes, handoff, restart, compact } = v
  return (
    Array.isArray(triggers) &&
    triggers.every(t => isObj(t) && typeof t.id === 'string' && isObj(t.when) && Array.isArray(t.do)) &&
    isObj(notes) &&
    isObj(handoff) &&
    typeof handoff.path === 'string' &&
    isObj(restart) &&
    typeof restart.mode === 'string' &&
    isStrArray(restart.peers) &&
    Array.isArray(restart.readyChecks) &&
    isObj(compact)
  )
}

const isProbeShape = (p: unknown): boolean =>
  isObj(p) && typeof p.id === 'string' && isStrArray(p.run) && typeof p.every === 'number' && typeof p.timeout === 'number'

const isStoredQuantity = (q: unknown): boolean => isObj(q) && typeof q.kind === 'string' && typeof q.value === 'number' && q.value > 0

function isCacheShape(c: unknown): boolean {
  if (!isObj(c) || !isObj(c.band) || !isObj(c.ping) || !isObj(c.prompt)) return false
  const { ttl } = c
  const { show, warn } = c.band
  return (
    (ttl === 'auto' || (typeof ttl === 'number' && ttl > 0)) &&
    (show === 'always' || show === 'off' || isStoredQuantity(show)) &&
    isStoredQuantity(warn) &&
    typeof c.ping.maxUsage === 'number' &&
    typeof c.prompt.maxUsage === 'number'
  )
}

// A stored lift in the shape validate gives it; another (an older build's) reads as no lift.
const isStoredLift = (v: unknown): v is TriggerLift =>
  isObj(v) &&
  Array.isArray(v.do) &&
  v.do.every(a => (LIFT_ACTIONS as readonly unknown[]).includes(a)) &&
  (v.times === null || typeof v.times === 'number') &&
  (v.message === null || typeof v.message === 'string')

// A trigger stored before `times`, `lift` and the cache metrics existed reads with them unset (null).
// A trigger that already has them comes back as the same object.
function storedTrigger(t: unknown): unknown {
  if (!isObj(t) || !isObj(t.when)) return t
  const when = t.when
  const lift = isStoredLift(t.lift) ? t.lift : null
  if ((typeof t.times === 'number' || t.times === null) && (t.lift === null || isStoredLift(t.lift))) {
    if (CACHE_METRICS.every(m => when[m] !== undefined)) return t
  }
  const filled: Obj = { ...when }
  for (const m of CACHE_METRICS) if (filled[m] === undefined) filled[m] = null
  return { ...t, when: filled, times: typeof t.times === 'number' ? t.times : null, lift }
}

function storedSpec(spec: unknown): unknown {
  if (!isObj(spec) || !Array.isArray(spec.triggers)) return spec
  const list: unknown[] = spec.triggers
  const triggers = list.map(storedTrigger)
  return triggers.every((t, i) => t === list[i]) ? spec : { ...spec, triggers }
}

function storedRoles(roles: unknown): unknown {
  if (!isObj(roles)) return roles
  const out = dict<unknown>()
  let same = true
  for (const [name, spec] of Object.entries(roles)) {
    out[name] = storedSpec(spec)
    if (out[name] !== spec) same = false
  }
  return same ? roles : out
}

/** A normalized Config as another version of ctx-guard may have stored it; null when it does not look like one. */
export function asConfig(v: unknown): Config | null {
  if (!isObj(v) || v.version !== 1 || typeof v.enabled !== 'boolean') return null
  if (typeof v.stateDir !== 'string' || typeof v.readyToken !== 'string') return null
  if (!(v.defaultRole === null || typeof v.defaultRole === 'string')) return null
  if (!(v.contextWindow === 'auto' || (typeof v.contextWindow === 'number' && v.contextWindow > 0))) return null
  if (!isSpecShape(v.defaults) || !isObj(v.roles) || !Object.values(v.roles).every(isSpecShape) || !isObj(v.subagents)) return null
  // A config stored before cache existed reads with the defaults; before band, with no probes.
  const cache = isCacheShape(v.cache) ? v.cache : DEFAULT_CACHE
  const defaults = storedSpec(v.defaults)
  const roles = storedRoles(v.roles)
  const same = cache === v.cache && defaults === v.defaults && roles === v.roles
  const stored = same ? v : { ...v, cache, defaults, roles }
  if (v.band === undefined) return { ...stored, band: { probes: [] } } as unknown as Config
  if (!isObj(v.band) || !Array.isArray(v.band.probes) || !v.band.probes.every(isProbeShape)) return null
  return stored as unknown as Config
}

/** The stored ConfigState, checked; a lastGood that does not look like a config is dropped. */
export function asConfigState(v: unknown): ConfigState | null {
  if (!isObj(v) || !isStrArray(v.errors) || !Array.isArray(v.files) || typeof v.source !== 'string') return null
  const files = v.files.filter(
    (f): f is ConfigState['files'][number] => isObj(f) && typeof f.path === 'string' && (f.mtime === null || typeof f.mtime === 'number'),
  )
  return {
    lastGood: asConfig(v.lastGood),
    source: v.source as ConfigSource,
    errors: v.errors,
    files,
    loadedAt: typeof v.loadedAt === 'number' ? v.loadedAt : 0,
  }
}

// ---- trust -------------------------------------------------------------------

/** JSON with object keys sorted at every depth, so equal values hash equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

// A trigger as the trust hash sees it: the cache metrics, `times` and `lift` appear only when set,
// so an approval given before they existed still matches.
function trustedTrigger(t: Trigger): Obj {
  const when: Obj = { ...t.when }
  for (const m of CACHE_METRICS) if (when[m] === null || when[m] === undefined) delete when[m]
  const { times, lift, ...rest } = t
  const out: Obj = { ...rest, when }
  if (times !== null && times !== undefined) out.times = times
  if (lift !== null && lift !== undefined) out.lift = lift
  return out
}

/** Whether the trigger's lift runs action `a`; with `prompt`, its lift may wake the session with a prompt of its own. */
export const liftHas = (t: Trigger, a: LiftAction): boolean => t.lift?.do.includes(a) === true

/**
 * The fields that can run code or prompts unattended, or steer where and when
 * that happens, per role; `*` holds the config-wide ones.
 */
export function trustMaterial(config: Config): unknown {
  const probes = config.band?.probes ?? []
  // Only when there are probes, so an approval given before band existed still matches.
  const all: Obj = { readyToken: config.readyToken, stateDir: config.stateDir }
  if (probes.length) all.band = probes
  const out: Obj = { '*': all }
  for (const name of Object.keys(config.roles).sort()) {
    const spec = roleSpec(config, name)
    if (!spec) continue
    const { mode, via, command, prompt, readyChecks, peers, peerGap, selfGap, minContext } = spec.restart
    const auto = spec.triggers.filter(t => t.do.includes('ping') || t.do.includes('prompt') || liftHas(t, 'prompt'))
    out[name] = {
      restart: { mode, via, command, prompt, readyChecks, peers, peerGap, selfGap, minContext },
      // The handoff path lands in the resume command line.
      handoff: { path: spec.handoff.path },
      compact: spec.compact.instructions,
      compactTriggers: spec.triggers.filter(t => t.do.includes('compact')).map(trustedTrigger),
      // Only when there are some, so an approval given before ping and prompt existed still matches.
      ...(auto.length ? { autoTriggers: auto.map(trustedTrigger) } : {}),
    }
  }
  return out
}

// Ready-check scripts under the root, by their argv[0], to a hash of their content.
export type ScriptHashes = Record<string, string>

/**
 * SHA-256 (hex) over the canonical trust material and, when given, the
 * content hashes of the ready-check scripts, so editing a script withdraws trust.
 */
export function trustHash(config: Config, scripts: ScriptHashes = {}): string {
  const material = trustMaterial(config)
  return sha256Hex(canonicalJson(Object.keys(scripts).length ? { material, scripts } : material))
}

/**
 * Every distinct argument of every ready check and band probe (the command and its args):
 * each one that turns out to be a file under the root is hashed, so
 * `["bash", "scripts/check.sh"]` covers the script as `["./check.sh"]` does.
 */
export function checkScripts(config: Config): string[] {
  const out = new Set<string>()
  for (const name of Object.keys(config.roles)) {
    for (const c of roleSpec(config, name)?.restart.readyChecks ?? []) for (const arg of c.run) if (arg && !arg.startsWith('-')) out.add(arg)
  }
  for (const p of config.band?.probes ?? []) for (const arg of p.run) if (arg && !arg.startsWith('-')) out.add(arg)
  return [...out].sort()
}

/** One hash per `<role>.<field>` of the trust material (and `script:<path>`), so a report can name what changed. */
export function trustFields(config: Config, scripts: ScriptHashes = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(scripts).sort()) out[`script:${k}`] = scripts[k] as string
  const material = trustMaterial(config) as Record<string, Record<string, unknown>>
  for (const role of Object.keys(material).sort()) {
    const fields = material[role] ?? {}
    for (const k of Object.keys(fields).sort()) out[`${role}.${k}`] = sha256Hex(canonicalJson(fields[k]))
  }
  return out
}

// What `/ctx-guard trust` keeps in `$.store`, keyed by the repo root.
export type TrustRecord = { hash: string; fields: Record<string, string>; at: number }

export function trustKey(root: string): string {
  return `trust:${root.replace(/[/\\]+$/, '')}`
}

export function asTrustRecord(v: unknown): TrustRecord | null {
  if (!isObj(v) || typeof v.hash !== 'string' || !isObj(v.fields) || typeof v.at !== 'number') return null
  const fields: Record<string, string> = {}
  for (const [k, h] of Object.entries(v.fields)) if (typeof h === 'string') fields[k] = h
  return { hash: v.hash, fields, at: v.at }
}

export type TrustState = { trusted: boolean; changed: string[]; record: TrustRecord | null }

/**
 * Trusted iff the approved hash is the current one. Otherwise `changed` names
 * the fields that differ from the approval (all of them when none was given).
 */
export function trustState(config: Config, record: TrustRecord | null, scripts: ScriptHashes = {}): TrustState {
  if (record && record.hash === trustHash(config, scripts)) return { trusted: true, changed: [], record }
  const now = trustFields(config, scripts)
  const keys = [...new Set([...Object.keys(now), ...Object.keys(record?.fields ?? {})])].sort()
  const changed = record ? keys.filter(k => now[k] !== record.fields[k]) : keys.filter(k => hasContent(config, k))
  return { trusted: false, changed, record }
}

// With nothing approved yet, a field that holds nothing (no compact instructions, no compact trigger) needs no approval.
function hasContent(config: Config, key: string): boolean {
  const dot = key.indexOf('.')
  if (key.startsWith('script:') || dot < 0) return true
  const material = trustMaterial(config) as Record<string, Record<string, unknown>>
  const v = material[key.slice(0, dot)]?.[key.slice(dot + 1)]
  return !(v === null || v === undefined || (Array.isArray(v) && v.length === 0))
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

// No crypto in a mod, and a trust gate needs more than a 32-bit FNV.
export function sha256Hex(text: string): string {
  const bytes = utf8(text)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000)
  for (const word of [hi, bitLen >>> 0]) bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255)

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64).fill(0)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = (((bytes[j] ?? 0) << 24) | ((bytes[j + 1] ?? 0) << 16) | ((bytes[j + 2] ?? 0) << 8) | (bytes[j + 3] ?? 0)) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0
      const w2 = w[i - 2] ?? 0
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('')
}
