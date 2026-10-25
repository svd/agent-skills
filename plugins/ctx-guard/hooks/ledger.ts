// ctx-guard ledger: the records of what each session's requests and
// boundaries cost, the in-memory buffer, how buffered records land in
// `<stateDir>/ledger/<YYYY-MM-DD>-<sessionId>[-N].jsonl` parts, and which
// files retention deletes. Pure: no `$`, never throws.
import type { Level, Quantity } from '../types'
import type { CacheUsage } from './cache'
import { placeContext } from './triggers'

// A part is closed once the next line would take it past this size.
export const PART_BYTES = 256 * 1024
// Records held while writes fail; past it the oldest are dropped and counted.
export const BUFFER_MAX = 1000
// A cache write above this, and above half the context, rewrote a prefix that went cold.
export const COLD_WRITE_FLOOR = 40_000

const DAY_MS = 24 * 60 * 60_000

export type CompactTrigger = 'auto' | 'manual' | 'ctx-guard'

export type LedgerRecord =
  | { t: number; k: 'req'; role: string | null; ctx: number; cw: number; cr: number; out: number; model: string | null; miss: number; gap: number | null }
  | { t: number; k: 'note'; role: string | null; id: string; level: Level | null; ctx: number | null; threshold: number | null }
  | { t: number; k: 'ready'; role: string | null; ctx: number | null }
  | { t: number; k: 'clear'; role: string | null; by: 'ctx-guard' | 'operator' }
  | { t: number; k: 'compact'; role: string | null; trigger: CompactTrigger; pre: number | null; post: number | null }
  | { t: number; k: 'start'; role: string | null; window: number; ttl?: number }

export type ReqRecord = Extract<LedgerRecord, { k: 'req' }>

// The part being written: its whole text so far, since a write replaces the file.
export type LedgerOpen = { dir: string; day: string; sessionId: string; part: number; text: string; bytes: number }

// All ledger state; register.tsx holds null while the ledger is off.
export type LedgerMem = {
  buffer: LedgerRecord[]
  // Records dropped from a full buffer.
  dropped: number
  open: LedgerOpen | null
  // Null after a /clear until the next flush reads the new session's id.
  sessionId: string | null
  // The folder its parts land in, resolved once when it starts; null lands nothing.
  dir: string | null
  // Part names already in the ledger folder: a new part never reuses one.
  known: string[]
  lastReqAt: number | null
  // The session before a /clear, when its last flush failed: landed under its own id later.
  held: LedgerMem | null
}

export type LedgerUsage = CacheUsage & { output_tokens: number }

// `records` are the buffered records the writes land.
export type LedgerPlan = { writes: { name: string; text: string }[]; open: LedgerOpen | null; known: string[]; records: LedgerRecord[] }

export function newLedger(sessionId: string | null, known: readonly string[], dir: string | null = null): LedgerMem {
  return { buffer: [], dropped: 0, open: null, sessionId, dir, known: [...known], lastReqAt: null, held: null }
}

/** Adds a record; past `max` the oldest go and are counted. */
export function pushRecord(l: LedgerMem, r: LedgerRecord, max = BUFFER_MAX): void {
  l.buffer.push(r)
  while (l.buffer.length > Math.max(0, max)) {
    l.buffer.shift()
    l.dropped += 1
  }
}

const tokens = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** `cache.ts`'s miss when it counts one; else a cold write over the floor and half the context, else 0. */
export function ledgerMiss(cacheMiss: number, cw: number, ctx: number): number {
  if (tokens(cacheMiss) > 0) return cacheMiss
  return cw > COLD_WRITE_FLOOR && cw > ctx / 2 ? cw : 0
}

/** One main-loop request; `gap` is the time since the previous one, null for the first. */
export function reqRecord(i: { t: number; role: string | null; usage: LedgerUsage; cacheMiss: number; lastReqAt: number | null }): ReqRecord {
  const cw = tokens(i.usage.cache_creation_input_tokens)
  const cr = tokens(i.usage.cache_read_input_tokens)
  const ctx = tokens(i.usage.input_tokens) + cr + cw
  return {
    t: i.t,
    k: 'req',
    role: i.role,
    ctx,
    cw,
    cr,
    out: tokens(i.usage.output_tokens),
    model: typeof i.usage.model === 'string' ? i.usage.model : null,
    miss: ledgerMiss(i.cacheMiss, cw, ctx),
    gap: i.lastReqAt === null ? null : Math.max(0, i.t - i.lastReqAt),
  }
}

/** A context threshold in tokens on `window`; null with none, or one that cannot be placed. */
export function thresholdTokens(q: Quantity | null, window: number): number | null {
  return placeContext(q, window)?.tokens ?? null
}

/** The engine's compact trigger as recorded: a plugin's or ctx-guard's own is `ctx-guard`; `precompute` and unknown ones are not recorded. */
export function compactTrigger(t: string, ours: boolean): CompactTrigger | null {
  if (t === 'precompute') return null
  if (t === 'plugin' || ours) return 'ctx-guard'
  return t === 'auto' || t === 'manual' ? t : null
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(t: number): string {
  const d = new Date(Number.isFinite(t) ? t : 0)
  return Number.isNaN(d.getTime()) ? '1970-01-01' : d.toISOString().slice(0, 10)
}

/** Part 1 has no suffix; then `-2`, `-3` and so on. */
export function partName(day: string, sessionId: string, part: number): string {
  const id = fileId(sessionId)
  return part > 1 ? `${day}-${id}-${part}.jsonl` : `${day}-${id}.jsonl`
}

// A session id: a UUID, or segments where none after the first is all digits (so a part suffix reads as one).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SID = `(?:${UUID}|[A-Za-z0-9_]+(?:-[A-Za-z0-9_]*[A-Za-z_][A-Za-z0-9_]*)*)`
const PART_NAME = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-(${SID})(?:-([2-9]|[1-9]\\d+))?\\.jsonl$`)
const SID_ONLY = new RegExp(`^${SID}$`)

// 32-bit FNV-1a of the UTF-16 code units, in base 36.
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(36)
}

/**
 * The session id as it appears in a part name: one `parsePartName` reads back
 * as is; any other has each character outside `[A-Za-z0-9_]` made `_` and
 * `-h<hash of the id>` added, so two ids never share a name.
 */
export function fileId(sessionId: string): string {
  if (SID_ONLY.test(sessionId)) return sessionId
  return `${sessionId.replace(/[^A-Za-z0-9_]/g, '_') || '_'}-h${fnv1a(sessionId)}`
}

/** A ledger part's day, session and part number; null for any other name. */
export function parsePartName(name: string): { day: string; sessionId: string; part: number } | null {
  const m = PART_NAME.exec(name)
  if (!m?.[1] || !m[2]) return null
  return { day: m[1], sessionId: m[2], part: m[3] ? Number(m[3]) : 1 }
}

/** The next part of a session's day: one past the highest in `known`, else 1. */
export function nextPart(known: readonly string[], day: string, sessionId: string): number {
  let max = 0
  const prefix = `${day}-${fileId(sessionId)}-`
  for (const name of known) {
    if (name === partName(day, sessionId, 1)) max = Math.max(max, 1)
    else if (name.startsWith(prefix) && name.endsWith('.jsonl')) {
      const n = name.slice(prefix.length, -'.jsonl'.length)
      if (/^[1-9]\d*$/.test(n) && Number(n) > 1) max = Math.max(max, Number(n))
    }
  }
  return max + 1
}

/** UTF-8 length of `s`. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/**
 * The writes that land the buffer, in order: each part touched, whole, last
 * text wins. A record of another day, session or folder opens that one's next
 * part; a line that would take a non-empty part past `cap` closes it. The plan
 * follows from the state alone, so a retry after a failed write rewrites the
 * same files. `open` and `known` are the state once every write succeeded.
 */
export function planFlush(l: LedgerMem, dir: string, sessionId: string, cap = PART_BYTES): LedgerPlan {
  const known = [...l.known]
  const writes: { name: string; text: string }[] = []
  let open = l.open
  let dirty = false
  const flush = (): void => {
    if (open && dirty) writes.push({ name: partName(open.day, open.sessionId, open.part), text: open.text })
    dirty = false
  }
  const close = (): void => {
    flush()
    if (open && open.dir === dir) {
      const name = partName(open.day, open.sessionId, open.part)
      if (!known.includes(name)) known.push(name)
    }
  }
  for (const r of l.buffer) {
    const line = `${JSON.stringify(r)}\n`
    const size = utf8Bytes(line)
    const day = utcDay(r.t)
    if (!open || open.dir !== dir || open.day !== day || open.sessionId !== sessionId) {
      close()
      // A same-folder part left open stays on disk; the next one never reuses its name.
      open = { dir, day, sessionId, part: nextPart(known, day, sessionId), text: '', bytes: 0 }
    } else if (open.bytes > 0 && open.bytes + size > cap) {
      close()
      open = { ...open, part: open.part + 1, text: '', bytes: 0 }
    }
    open = { ...open, text: open.text + line, bytes: open.bytes + size }
    dirty = true
  }
  flush()
  return { writes, open, known, records: [...l.buffer] }
}

/**
 * The plan's state, once all its writes succeeded: the records it landed leave
 * the buffer; ones pushed while its writes ran stay. A landed record a full
 * buffer dropped meanwhile is not counted as dropped.
 */
export function commitFlush(l: LedgerMem, plan: LedgerPlan): void {
  l.open = plan.open
  l.known = plan.known
  const landed = new Set(plan.records)
  const before = l.buffer.length
  l.buffer = l.buffer.filter(r => !landed.has(r))
  l.dropped = Math.max(0, l.dropped - (plan.records.length - (before - l.buffer.length)))
}

/** Ledger part names dated more than `days` days before `now` (UTC); other names are never listed. */
export function expiredParts(names: readonly string[], now: number, days: number): string[] {
  const cutoff = utcDay(now - days * DAY_MS)
  return names.filter(n => {
    const p = parsePartName(n)
    return p !== null && p.day < cutoff
  })
}

/** Ledger parts grouped per session day, by day then session, each group's parts in numeric order. */
export function listParts(names: readonly string[]): { day: string; sessionId: string; parts: string[] }[] {
  const groups = new Map<string, { day: string; sessionId: string; parts: { name: string; part: number }[] }>()
  for (const name of names) {
    const p = parsePartName(name)
    if (!p) continue
    const key = `${p.day} ${p.sessionId}`
    const g = groups.get(key) ?? { day: p.day, sessionId: p.sessionId, parts: [] }
    g.parts.push({ name, part: p.part })
    groups.set(key, g)
  }
  return [...groups.values()]
    .sort((a, b) => (a.day === b.day ? (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) : a.day < b.day ? -1 : 1))
    .map(g => ({ day: g.day, sessionId: g.sessionId, parts: g.parts.sort((a, b) => a.part - b.part).map(x => x.name) }))
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): boolean => v === null || isNum(v)
const LEVELS: readonly unknown[] = ['soft', 'hard', 'stop']

function isRecord(v: unknown): v is LedgerRecord {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!isNum(o.t) || !(o.role === null || typeof o.role === 'string')) return false
  switch (o.k) {
    case 'req':
      return [o.ctx, o.cw, o.cr, o.out, o.miss].every(isNum) && numOrNull(o.gap) && (o.model === null || typeof o.model === 'string')
    case 'note':
      return typeof o.id === 'string' && (o.level === null || LEVELS.includes(o.level)) && numOrNull(o.ctx) && numOrNull(o.threshold)
    case 'ready':
      return numOrNull(o.ctx)
    case 'clear':
      return o.by === 'ctx-guard' || o.by === 'operator'
    case 'compact':
      return (o.trigger === 'auto' || o.trigger === 'manual' || o.trigger === 'ctx-guard') && numOrNull(o.pre) && numOrNull(o.post)
    case 'start':
      return isNum(o.window) && (o.ttl === undefined || isNum(o.ttl))
    default:
      return false
  }
}

/** The records of a part's text; a line that is not one (torn, foreign, another version's) is skipped. */
export function parseLines(text: string): LedgerRecord[] {
  const out: LedgerRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (isRecord(v)) out.push(v)
    } catch {
      // skipped
    }
  }
  return out
}
