// ctx-guard tuning from the ledger: which triggers are a role's context
// ladder, the ledger parts of the last days grouped per session, and the reach
// check (how far each role's sessions got against its lowest context trigger,
// with the findings it toasts once a week), and the tune (the replay of each
// role's requests for candidate boundaries, its recommendation and the trigger
// list `/ctx-guard tune apply` writes). Pure: no `$`, never throws.
import type { EdgeAction, Trigger, TriggerWhen } from '../types'
import { isObj, parseQuantity } from './config'
import { listParts, parseLines, thresholdTokens, utcDay } from './ledger'
import type { LedgerRecord, ReqRecord } from './ledger'
import { humanTokens } from './messages'

export const REACH_DAYS = 14
// Fewer sessions of a role than this give "not enough data", never a finding.
export const REACH_MIN_SESSIONS = 5
// A finding shown within this long is not toasted again.
export const FINDING_MEMORY_MS = 7 * 24 * 60 * 60_000

const DAY_MS = 24 * 60 * 60_000

export type SessionRecords = { sessionId: string; records: LedgerRecord[] }

// A context trigger and its threshold in tokens.
export type Rung = { id: string; tokens: number }

// `when` keys a context trigger may hold besides `context`.
const LADDER_KEYS: ReadonlySet<string> = new Set(['context', 'every', 'everyMetric'])
const AUTO_ACTIONS: readonly EdgeAction[] = ['compact', 'prompt', 'ping']

/**
 * A role's context triggers, lowest threshold first (ties by id): `when` holds
 * only `context` (plus `every`) and `do` no compact, prompt or ping. A percent
 * resolves on `window`.
 */
export function contextLadder(triggers: readonly Trigger[], window: number): Rung[] {
  const out: Rung[] = []
  for (const t of triggers) {
    const when = t.when as Partial<TriggerWhen>
    if (when.context == null) continue
    if (Object.entries(when).some(([k, v]) => v != null && !LADDER_KEYS.has(k))) continue
    if (t.do.some(a => typeof a === 'string' && AUTO_ACTIONS.includes(a))) continue
    const tokens = thresholdTokens(when.context, window)
    if (tokens !== null) out.push({ id: t.id, tokens })
  }
  return out.sort((a, b) => a.tokens - b.tokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The ledger parts dated within `days` days before `now` (UTC), per session, by day then part. */
export function windowParts(names: readonly string[], now: number, days = REACH_DAYS): { sessionId: string; parts: string[] }[] {
  const cutoff = utcDay(now - days * DAY_MS)
  const bySession = new Map<string, string[]>()
  for (const g of listParts(names)) {
    if (g.day < cutoff) continue
    bySession.set(g.sessionId, [...(bySession.get(g.sessionId) ?? []), ...g.parts])
  }
  return [...bySession].map(([sessionId, parts]) => ({ sessionId, parts }))
}

/** The records per session: parts' texts parsed (bad lines skipped), then `extra` (unlanded buffers) merged by session id. */
export function groupSessions(parts: readonly { sessionId: string; text: string }[], extra: readonly SessionRecords[]): SessionRecords[] {
  const by = new Map<string, LedgerRecord[]>()
  const add = (id: string, rs: readonly LedgerRecord[]): void => {
    const list = by.get(id) ?? []
    list.push(...rs)
    by.set(id, list)
  }
  for (const p of parts) add(p.sessionId, parseLines(p.text))
  for (const e of extra) add(e.sessionId, e.records)
  return [...by].map(([sessionId, records]) => ({ sessionId, records }))
}

export type Peaks = { median: number; p90: number; max: number }
export type Range = { min: number; max: number }

export type RoleReach = {
  // 'none' for a session with no role.
  role: string
  // Sessions with at least one request of the role, and those requests.
  sessions: number
  requests: number
  // Peak context per session; null with no request.
  peak: Peaks | null
  notes: { soft: number; hard: number; stop: number; other: number }
  clears: { ready: number; operator: number }
  compacts: { auto: number; manual: number; 'ctx-guard': number }
  // The engine auto-compacts' `pre`, and those below the lowest context trigger.
  autoPre: Range | null
  below: Range | null
  // Null: no context trigger, or the role is not in the config now.
  lowest: Rung | null
  verdict: 'few' | 'unconfigured' | 'no-ladder' | 'ok' | 'findings'
  findings: ('unreached' | 'pre-empted')[]
}

export type ReachInput = {
  sessions: readonly SessionRecords[]
  now: number
  days?: number
  // A role's triggers now; null when the role is not in the config.
  triggers: (role: string) => Trigger[] | null
  // The current resolved window: percent thresholds use it when the role has no `start` record in the period.
  window: number
}

function peaks(values: number[]): Peaks | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  const median = s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2)
  return { median, p90: s[Math.ceil(0.9 * s.length) - 1] as number, max: s[s.length - 1] as number }
}

function range(values: readonly number[]): Range | null {
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null
}

type Acc = {
  peaks: Map<string, number>
  requests: number
  notes: RoleReach['notes']
  clears: RoleReach['clears']
  compacts: RoleReach['compacts']
  autoPre: number[]
  // The ids of the notes fired.
  noteIds: Set<string>
  start: { t: number; window: number } | null
}

function newAcc(): Acc {
  return {
    peaks: new Map(),
    requests: 0,
    notes: { soft: 0, hard: 0, stop: 0, other: 0 },
    clears: { ready: 0, operator: 0 },
    compacts: { auto: 0, manual: 0, 'ctx-guard': 0 },
    autoPre: [],
    noteIds: new Set(),
    start: null,
  }
}

function count(a: Acc, sessionId: string, r: LedgerRecord): void {
  switch (r.k) {
    case 'req':
      a.requests++
      a.peaks.set(sessionId, Math.max(a.peaks.get(sessionId) ?? 0, r.ctx))
      break
    case 'note':
      a.notes[r.level ?? 'other']++
      a.noteIds.add(r.id)
      break
    case 'clear':
      a.clears[r.by === 'ctx-guard' ? 'ready' : 'operator']++
      break
    case 'compact':
      a.compacts[r.trigger]++
      if (r.trigger === 'auto' && r.pre !== null) a.autoPre.push(r.pre)
      break
    case 'start':
      if (!a.start || r.t >= a.start.t) a.start = { t: r.t, window: r.window }
      break
  }
}

function judge(role: string, a: Acc, i: ReachInput): RoleReach {
  const peak = peaks([...a.peaks.values()])
  const triggers = i.triggers(role)
  const window = a.start?.window ?? i.window
  const ladder = triggers ? contextLadder(triggers, window) : []
  const lowest = ladder[0] ?? null
  const below = lowest ? range(a.autoPre.filter(p => p < lowest.tokens)) : null
  const base = { role, sessions: a.peaks.size, requests: a.requests, peak, notes: a.notes, clears: a.clears, compacts: a.compacts, autoPre: range(a.autoPre), below, lowest }
  if (!triggers) return { ...base, verdict: 'unconfigured', findings: [] }
  if (!lowest) return { ...base, verdict: 'no-ladder', findings: [] }
  if (a.peaks.size < REACH_MIN_SESSIONS) return { ...base, verdict: 'few', findings: [] }
  const findings: RoleReach['findings'] = []
  // A context note: one of the ladder's triggers fired.
  const noted = ladder.some(rung => a.noteIds.has(rung.id))
  if (peak && lowest.tokens > peak.p90 && !noted) findings.push('unreached')
  if (below) findings.push('pre-empted')
  return { ...base, verdict: findings.length ? 'findings' : 'ok', findings }
}

/** The reach check per role with a request in the period (role null as 'none'), by name with 'none' last. */
export function reach(i: ReachInput): RoleReach[] {
  const from = i.now - (i.days ?? REACH_DAYS) * DAY_MS
  const roles = new Map<string, Acc>()
  for (const s of i.sessions) {
    for (const r of s.records) {
      if (r.t < from || r.t > i.now) continue
      const role = r.role ?? 'none'
      const a = roles.get(role) ?? newAcc()
      roles.set(role, a)
      count(a, s.sessionId, r)
    }
  }
  const out: RoleReach[] = []
  for (const [role, a] of roles) {
    // A role with no request in the period (only a session's start record, say) is no session.
    if (!a.peaks.size) continue
    try {
      out.push(judge(role, a, i))
    } catch {
      // a role whose triggers cannot be read is left out
    }
  }
  return out.sort((a, b) => (a.role === 'none' ? 1 : b.role === 'none' ? -1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
}

// `${role}:${finding}` → when it was last toasted.
export type ReachMemory = { shown: Record<string, number> }

/** The plugin-store key of a repo's reach memory. */
export function reachKey(root: string): string {
  return `reach:${root.replace(/[/\\]+$/, '')}`
}

export function asReachMemory(v: unknown): ReachMemory {
  const shown: Record<string, number> = {}
  const s = typeof v === 'object' && v !== null ? (v as { shown?: unknown }).shown : null
  if (typeof s === 'object' && s !== null && !Array.isArray(s)) {
    for (const [k, at] of Object.entries(s)) if (typeof at === 'number' && Number.isFinite(at)) shown[k] = at
  }
  return { shown }
}

/** One toast per finding not shown in the last 7 days, over `days` days; `next` is the memory to store first. */
export function newFindings(r: readonly RoleReach[], m: ReachMemory, now: number, days = REACH_DAYS): { toasts: string[]; next: ReachMemory } {
  const shown: Record<string, number> = {}
  for (const [k, at] of Object.entries(m.shown)) if (now - at < FINDING_MEMORY_MS) shown[k] = at
  const toasts: string[] = []
  for (const role of r) {
    for (const f of role.findings) {
      const k = `${role.role}:${f}`
      if (shown[k] !== undefined) continue
      shown[k] = now
      toasts.push(reachToast(role, f, days))
    }
  }
  return { toasts, next: { shown } }
}

/** `203k–298k`, or `203k` for one value. */
export function rangeText(r: Range): string {
  return r.min === r.max ? humanTokens(r.min) : `${humanTokens(r.min)}–${humanTokens(r.max)}`
}

/** The toast for one finding of a role, over `days` days. */
export function reachToast(r: RoleReach, f: RoleReach['findings'][number], days = REACH_DAYS): string {
  const lowest = r.lowest ? humanTokens(r.lowest.tokens) : '?'
  if (f === 'unreached') {
    const why = r.autoPre ? `engine compacted at ${rangeText(r.autoPre)}` : `sessions peaked at ${r.peak ? humanTokens(r.peak.p90) : '?'} (p90), the lowest is ${lowest}`
    return `ctx-guard: context triggers for ${r.role} never fired in ${days} days; ${why}. /ctx-guard tune`
  }
  return `ctx-guard: the engine compacted ${r.role} at ${r.below ? rangeText(r.below) : '?'}, below its lowest context trigger (${lowest}). /ctx-guard tune`
}

// ---- tune --------------------------------------------------------------------
// The replay of a role's requests for candidate context boundaries, the
// recommendation, and the trigger list `/ctx-guard tune apply` writes.

// Below either minimum (over the ledger's days) a role gets no rows.
export const TUNE_MIN_SESSIONS = 10
export const TUNE_MIN_REQUESTS = 1_500
// A context drop larger than this resets the replay's virtual context to the actual one.
export const DROP_RESET = 30_000
// Candidate boundaries: FIRST up to the ceiling in STEP steps.
export const FIRST = 100_000
export const STEP = 25_000
// The boundary must land this far before the lowest engine auto-compact.
export const CEILING_MARGIN = 10_000
// Best: the highest candidate within NEAR_MIN of the cheapest; recommended at MIN_SAVING against current.
export const NEAR_MIN = 0.02
export const MIN_SAVING = 0.05
// The ladder from a boundary B: hard at B + HARD_GAP, stop at B + STOP_GAP stepping STOP_EVERY.
export const HARD_GAP = 50_000
export const STOP_GAP = 100_000
export const STOP_EVERY = 25_000
// A measured input uses its fallback until it has this many samples.
export const MIN_SAMPLES = 5
// A ctx-guard clear's next session is the role's first start within this long.
export const CLEAR_LINK_MS = 60_000

const HOUR_MS = 60 * 60_000

export type InputName = 'restartStart' | 'restartWrite' | 'handoffOut' | 'overshoot'
export const FALLBACK: Readonly<Record<InputName, number>> = { restartStart: 65_000, restartWrite: 32_000, handoffOut: 3_000, overshoot: 25_000 }

// Token weights relative to the model's input price.
export type Weights = { read: number; write1h: number; write5m: number; out: number }

const weights = (read: number): Weights => ({ read, write1h: 2, write5m: 1.25, out: 5 })

// Follows docs/pricing.md (read = cache read / input of the model's row); update the two
// together. A model id matches by substring, as the pricing table does; the first match
// wins, and the last entry (match null) takes every other id.
export const MODEL_WEIGHTS: readonly { match: string | null; label: string; w: Weights }[] = [
  { match: 'opus-5-5', label: 'Opus 5.5', w: weights(0.05) },
  { match: 'sonnet-5-5', label: 'Sonnet 5.5', w: weights(0.05) },
  { match: 'fable-5-1', label: 'Fable 5.1', w: weights(0.025) },
  { match: 'mythos-5-1', label: 'Mythos 5.1', w: weights(0.025) },
  { match: null, label: 'other Claude models', w: weights(0.1) },
]

export function weightsFor(model: string | null): { label: string; w: Weights } {
  const id = (model ?? '').toLowerCase()
  const row = MODEL_WEIGHTS.find(r => r.match === null || id.includes(r.match)) as (typeof MODEL_WEIGHTS)[number]
  return { label: row.label, w: row.w }
}

/** The cache-write weight for the TTL in ms: 1h at an hour or more, else (5m, or unknown) 5m. */
export const writeWeight = (w: Weights, ttl: number | null): number => (ttl !== null && ttl >= HOUR_MS ? w.write1h : w.write5m)

/** `150k`: thousands, rounded down; the form apply writes. */
export const tokenText = (n: number): string => `${Math.floor(n / 1000)}k`

export type Measured = { value: number; samples: number; fallback: boolean }
export type Inputs = Record<InputName, Measured>

function measured(name: InputName, values: number[]): Measured {
  if (values.length < MIN_SAMPLES) return { value: FALLBACK[name], samples: values.length, fallback: true }
  return { value: (peaks(values) as Peaks).median, samples: values.length, fallback: false }
}

const byTime = (rs: readonly LedgerRecord[]): LedgerRecord[] => [...rs].sort((a, b) => a.t - b.t)
const roleOf = (r: LedgerRecord): string => r.role ?? 'none'

// The requests after records[from] up to the next start, clear or compact.
function reqsAfter(records: readonly LedgerRecord[], from: number): ReqRecord[] {
  const out: ReqRecord[] = []
  for (let i = from + 1; i < records.length; i++) {
    const r = records[i] as LedgerRecord
    if (r.k === 'start' || r.k === 'clear' || r.k === 'compact') break
    if (r.k === 'req') out.push(r)
  }
  return out
}

// The window in force at each record: the latest start before it, else the session's first start, else `fallback`.
function windowAt(records: readonly LedgerRecord[], i: number, fallback: number): number {
  for (let j = i; j >= 0; j--) {
    const r = records[j] as LedgerRecord
    if (r.k === 'start') return r.window
  }
  const first = records.find(r => r.k === 'start')
  return first?.k === 'start' ? first.window : fallback
}

/**
 * The measured inputs of `role` (records of other roles are skipped). `soft` is
 * the soft threshold in force on a window; `window` is used where a session has
 * no start record.
 */
export function measureInputs(sessions: readonly SessionRecords[], role: string, soft: (window: number) => number | null, window: number): Inputs {
  const own = sessions.map(s => byTime(s.records.filter(r => roleOf(r) === role)))
  const starts = own.flatMap((rs, s) => rs.flatMap((r, i) => (r.k === 'start' ? [{ s, i, t: r.t }] : [])))
  const v: Record<InputName, number[]> = { restartStart: [], restartWrite: [], handoffOut: [], overshoot: [] }
  for (const rs of own) {
    rs.forEach((r, i) => {
      if (r.k === 'clear' && r.by === 'ctx-guard') {
        const next = starts.filter(st => st.t >= r.t && st.t - r.t <= CLEAR_LINK_MS).sort((a, b) => a.t - b.t)[0]
        if (!next) return
        const after = reqsAfter(own[next.s] as LedgerRecord[], next.i)
        if (after[0]) v.restartWrite.push(after[0].cw)
        if (after[3]) v.restartStart.push(after[3].ctx)
      } else if (r.k === 'ready') {
        const before = rs.slice(0, i).filter((x): x is ReqRecord => x.k === 'req').slice(-4)
        if (before.length) v.handoffOut.push(before.reduce((n, x) => n + x.out, 0))
        const s = soft(windowAt(rs, i, window))
        if (r.ctx !== null && s !== null && r.ctx > s) v.overshoot.push(r.ctx - s)
      }
    })
  }
  return {
    restartStart: measured('restartStart', v.restartStart),
    restartWrite: measured('restartWrite', v.restartWrite),
    handoffOut: measured('handoffOut', v.handoffOut),
    overshoot: measured('overshoot', v.overshoot),
  }
}

/** The lower of `window` and the lowest engine auto-compact `pre` minus CEILING_MARGIN. */
export function ceilingFor(window: number, records: readonly LedgerRecord[]): number {
  let c = window
  for (const r of records) if (r.k === 'compact' && r.trigger === 'auto' && r.pre !== null) c = Math.min(c, r.pre - CEILING_MARGIN)
  return c
}

// A boundary in tokens, 'current' (the role's soft threshold on each segment's window) or null (none).
export type Candidate = { label: string; boundary: number | 'current' | null }

/** FIRST to `ceiling` in STEP steps, then current and none. */
export function candidates(ceiling: number): Candidate[] {
  const out: Candidate[] = []
  for (let b = FIRST; b <= ceiling; b += STEP) out.push({ label: humanTokens(b), boundary: b })
  return [...out, { label: 'current', boundary: 'current' }, { label: 'none', boundary: null }]
}

// A run of a session's requests between starts, clears and compacts, with the window and TTL of the start before it.
export type Segment = { reqs: ReqRecord[]; window: number | null; ttl: number | null }

/** One session's records split at start, clear and compact; empty segments are dropped. */
export function segments(records: readonly LedgerRecord[]): Segment[] {
  const out: Segment[] = []
  let window: number | null = null
  let ttl: number | null = null
  let cur: ReqRecord[] = []
  const close = (): void => {
    if (cur.length) out.push({ reqs: cur, window, ttl })
    cur = []
  }
  for (const r of byTime(records)) {
    if (r.k === 'req') cur.push(r)
    else if (r.k === 'start' || r.k === 'clear' || r.k === 'compact') {
      close()
      if (r.k === 'start') {
        window = r.window
        ttl = r.ttl ?? null
      }
    }
  }
  close()
  return out
}

export type ReplayCtx = { inputs: Record<InputName, number>; window: number }
export type ReplayCost = { cost: number; clears: number }

/**
 * The context-dependent cost of `segs` in input-price units with a boundary on
 * each segment's window (null: none). A virtual context grows by each request's
 * increase (a drop over DROP_RESET resets it); each request costs its read and
 * its miss on that context; at boundary + overshoot it clears once.
 */
export function replay(segs: readonly Segment[], boundary: (window: number) => number | null, c: ReplayCtx): ReplayCost {
  const { restartStart, restartWrite, handoffOut, overshoot } = c.inputs
  let cost = 0
  let clears = 0
  for (const seg of segs) {
    const b = boundary(seg.window ?? c.window)
    let v = 0
    let prev = 0
    seg.reqs.forEach((r, i) => {
      if (i === 0 || prev - r.ctx > DROP_RESET) v = r.ctx
      else v += Math.max(0, r.ctx - prev)
      prev = r.ctx
      const { w } = weightsFor(r.model)
      const write = writeWeight(w, seg.ttl)
      cost += v * w.read
      if (r.ctx > 0) cost += Math.min(v, (r.miss * v) / r.ctx) * write
      if (b !== null && v >= b + overshoot) {
        clears++
        cost += restartWrite * write + handoffOut * w.out
        v = restartStart
      }
    })
  }
  return { cost, clears }
}

export type Ladder = { soft: number; hard: number; stop: number }

/** The ladder from boundary `b`, each rung capped at `ceiling`. */
export function ladderFrom(b: number, ceiling: number): Ladder {
  return { soft: Math.min(b, ceiling), hard: Math.min(b + HARD_GAP, ceiling), stop: Math.min(b + STOP_GAP, ceiling) }
}

// One candidate's result: cost relative to none (1 = the same).
export type TuneRow = { label: string; boundary: number | 'current' | null; clears: number; cost: number; vsNone: number }

export type RoleTune = {
  role: string
  sessions: number
  requests: number
  // The first and last record's time; null with none.
  from: number | null
  to: number | null
  window: number
  ceiling: number
  inputs: Inputs
  // The weights' label (from the latest request's model) and the latest start's TTL in ms, null when unknown.
  weights: string
  ttl: number | null
  current: Rung[]
  rows: TuneRow[]
  // few: below the data minimum; unconfigured: not in the config now; no-ladder: no context triggers;
  // fine: no candidate saves MIN_SAVING (or none fits under the ceiling).
  verdict: 'few' | 'unconfigured' | 'no-ladder' | 'fine' | 'recommend'
  best: TuneRow | null
  // (current − best) / current; null without a best.
  saving: number | null
  ladder: Ladder | null
}

export type TuneInput = {
  sessions: readonly SessionRecords[]
  now: number
  days: number
  // A role's triggers now; null when the role is not in the config.
  triggers: (role: string) => Trigger[] | null
  // The current resolved window, for a role with no start record in the period.
  window: number
  // Only this role; null or absent: every role with a request in the period.
  role?: string | null
}

function tuneRole(role: string, sessions: SessionRecords[], i: TuneInput): RoleTune {
  const all = sessions.flatMap(s => s.records)
  const reqs = all.filter((r): r is ReqRecord => r.k === 'req').sort((a, b) => a.t - b.t)
  const starts = all.filter((r): r is Extract<LedgerRecord, { k: 'start' }> => r.k === 'start').sort((a, b) => a.t - b.t)
  const latest = starts[starts.length - 1]
  const window = latest?.window ?? i.window
  let from: number | null = null
  let to: number | null = null
  for (const r of all) {
    if (from === null || r.t < from) from = r.t
    if (to === null || r.t > to) to = r.t
  }
  const triggers = i.triggers(role)
  const soft = (w: number): number | null => (triggers ? (contextLadder(triggers, w)[0]?.tokens ?? null) : null)
  const current = triggers ? contextLadder(triggers, window) : []
  const ceiling = ceilingFor(window, all)
  const inputs = measureInputs(sessions, role, soft, window)
  const ttl = [...starts].reverse().find(s => s.ttl !== undefined)?.ttl ?? null
  const base = {
    role,
    sessions: sessions.filter(s => s.records.some(r => r.k === 'req')).length,
    requests: reqs.length,
    from,
    to,
    window,
    ceiling,
    inputs,
    weights: weightsFor(reqs[reqs.length - 1]?.model ?? null).label,
    ttl,
    current,
    rows: [] as TuneRow[],
    best: null,
    saving: null,
    ladder: null,
  }
  if (base.sessions < TUNE_MIN_SESSIONS || base.requests < TUNE_MIN_REQUESTS) return { ...base, verdict: 'few' }
  const segs = sessions.flatMap(s => segments(s.records))
  const ctx: ReplayCtx = {
    window,
    inputs: { restartStart: inputs.restartStart.value, restartWrite: inputs.restartWrite.value, handoffOut: inputs.handoffOut.value, overshoot: inputs.overshoot.value },
  }
  const costs = candidates(ceiling).map(c => ({ c, r: replay(segs, w => (c.boundary === 'current' ? soft(w) : c.boundary), ctx) }))
  const none = costs[costs.length - 1]?.r.cost ?? 0
  const rows: TuneRow[] = costs.map(({ c, r }) => ({ label: c.label, boundary: c.boundary, clears: r.clears, cost: r.cost, vsNone: none > 0 ? r.cost / none : 1 }))
  if (!triggers) return { ...base, rows, verdict: 'unconfigured' }
  if (!current.length) return { ...base, rows, verdict: 'no-ladder' }
  const c = choose(rows)
  if (!c.best) return { ...base, rows, verdict: 'fine' }
  return { ...base, rows, ...c, ladder: c.verdict === 'recommend' ? ladderFrom(c.best.boundary, ceiling) : null }
}

/** The best row (the highest numeric boundary within NEAR_MIN of the cheapest row), its saving against current, and the verdict. */
export function choose(rows: readonly TuneRow[]): { best: (TuneRow & { boundary: number }) | null; saving: number | null; verdict: 'fine' | 'recommend' } {
  const min = Math.min(...rows.map(r => r.cost))
  const near = rows.filter((r): r is TuneRow & { boundary: number } => typeof r.boundary === 'number' && r.cost <= min * (1 + NEAR_MIN))
  const best = near.sort((a, b) => b.boundary - a.boundary)[0] ?? null
  const cur = rows.find(r => r.boundary === 'current')
  if (!best || !cur) return { best: null, saving: null, verdict: 'fine' }
  const saving = cur.cost > 0 ? (cur.cost - best.cost) / cur.cost : 0
  // A hair of rounding must not turn an exact 5% into fine.
  return { best, saving, verdict: saving >= MIN_SAVING - 1e-9 ? 'recommend' : 'fine' }
}

/** The tune per role with a request in the last `days` days (role null as 'none'), by name with 'none' last. */
export function tune(i: TuneInput): RoleTune[] {
  const from = i.now - i.days * DAY_MS
  const roles = new Map<string, SessionRecords[]>()
  for (const s of i.sessions) {
    const by = new Map<string, LedgerRecord[]>()
    for (const r of s.records) {
      if (r.t < from || r.t > i.now) continue
      const role = roleOf(r)
      if (i.role != null && role !== i.role) continue
      const list = by.get(role)
      if (list) list.push(r)
      else by.set(role, [r])
    }
    for (const [role, records] of by) {
      const list = roles.get(role)
      if (list) list.push({ sessionId: s.sessionId, records })
      else roles.set(role, [{ sessionId: s.sessionId, records }])
    }
  }
  const out: RoleTune[] = []
  for (const [role, sessions] of roles) {
    if (!sessions.some(s => s.records.some(r => r.k === 'req'))) continue
    try {
      out.push(tuneRole(role, sessions, i))
    } catch {
      // a role whose triggers cannot be read is left out
    }
  }
  return out.sort((a, b) => (a.role === 'none' ? 1 : b.role === 'none' ? -1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
}

// ---- tune apply --------------------------------------------------------------

export type LadderChange = { id: string; from: string; to: string }
export type ApplyPlan = { ok: true; triggers: unknown[]; changed: LadderChange[] } | { ok: false; unmapped: string[]; reason: string }

const RUNG_NAMES: readonly (keyof Ladder)[] = ['soft', 'hard', 'stop']

function quantityText(v: unknown): string {
  return typeof v === 'number' ? humanTokens(v) : String(v)
}

function whenText(when: Record<string, unknown>): string {
  return `${quantityText(when.context)}${when.every == null ? '' : ` every ${quantityText(when.every)}`}`
}

// A soft or hard rung's `every` in tokens: a percent resolves on `window`, rounded down to 1k (at least 1k).
function everyTokens(every: unknown, window: number): unknown {
  const q = parseQuantity(every, ['tokens', 'percent'], 'tokens')
  if (!q || q.kind !== 'percent') return every
  return tokenText(Math.max(1000, (q.value / 100) * window))
}

/**
 * The role's raw trigger list with its context ladder (`current`, from
 * contextLadder) moved to boundary `b`: in order soft, hard and stop take
 * ladderFrom's thresholds, stop steps STOP_EVERY, and a percent `every` on soft
 * or hard turns to tokens on `window`. Every other field and entry is kept.
 * Refused with no context-only trigger, more than three, or one whose id is not
 * in `raw`.
 */
export function applyLadder(raw: readonly unknown[], current: readonly Rung[], b: number, ceiling: number, window: number): ApplyPlan {
  if (!current.length) return { ok: false, unmapped: [], reason: 'no context-only triggers' }
  if (current.length > RUNG_NAMES.length) return { ok: false, unmapped: current.map(r => r.id), reason: 'more than three context-only triggers' }
  const missing = current.filter(r => !raw.some(t => isObj(t) && t.id === r.id)).map(r => r.id)
  if (missing.length) return { ok: false, unmapped: missing, reason: 'not found in the config files' }
  const target = ladderFrom(b, ceiling)
  const triggers = [...raw]
  const changed: LadderChange[] = []
  current.forEach((rung, n) => {
    const name = RUNG_NAMES[n] as keyof Ladder
    const at = triggers.findIndex(t => isObj(t) && t.id === rung.id)
    const t = triggers[at] as Record<string, unknown>
    const old = isObj(t.when) ? t.when : {}
    const when: Record<string, unknown> = { ...old, context: tokenText(target[name]) }
    if (name === 'stop') when.every = tokenText(STOP_EVERY)
    else if (when.every != null) when.every = everyTokens(when.every, window)
    triggers[at] = { ...t, when }
    changed.push({ id: rung.id, from: whenText(old), to: whenText(when) })
  })
  return { ok: true, triggers, changed }
}
