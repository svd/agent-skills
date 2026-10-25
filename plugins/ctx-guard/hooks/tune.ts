// ctx-guard tuning from the ledger: which triggers are a role's context
// ladder, the ledger parts of the last days grouped per session, and the reach
// check (how far each role's sessions got against its lowest context trigger,
// with the findings it toasts once a week). Pure: no `$`, never throws.
import type { EdgeAction, Trigger, TriggerWhen } from '../types'
import { listParts, parseLines, thresholdTokens, utcDay } from './ledger'
import type { LedgerRecord } from './ledger'
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
