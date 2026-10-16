// ctx-guard prompt cache: the TTL, when the main thread's cache expires, a
// request that rewrote a cache expected warm, ping verdicts, idle-period
// counters and the band's countdown. Pure: no `$`, never throws.
import type { BandCache, CacheConfig, CacheShow, CacheState, Quantity, TtlSource } from '../types'
import { humanDuration } from './messages'

export const MARGIN_MS = 30_000
export const FIVE_MIN = 5 * 60_000
export const HOUR = 60 * 60_000
export const MISS_FLOOR = 2_000
// A request reading this share of the previous fill found the cache warm.
const WARM_COVER = 0.9
// A ping writing more than this share of what it read found the prefix gone.
const PING_WRITE_LIMIT = 0.1

const RANK: Record<TtlSource, number> = { guess: 0, observed: 1, transcript: 2, config: 3 }
const SOURCES = Object.keys(RANK) as TtlSource[]

export function emptyCache(): CacheState {
  return { ttl: null, ttlSource: null, transcriptTried: false, anchor: null, prevFill: null, warmSeen: false, model: null, miss: 0, missCause: null, pings: 0, cold: false, coldShown: false, fired: {} }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The stored value, checked field by field: another version may have written it. */
export function asCache(v: unknown): CacheState {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const source = typeof o.ttlSource === 'string' && (SOURCES as string[]).includes(o.ttlSource) ? (o.ttlSource as TtlSource) : null
  const ttl = num(o.ttl)
  const fired: Record<string, number> = {}
  if (typeof o.fired === 'object' && o.fired !== null) {
    for (const [k, n] of Object.entries(o.fired as Record<string, unknown>)) if (num(n) !== null) fired[k] = n as number
  }
  return {
    ttl: source && ttl !== null ? ttl : null,
    ttlSource: source && ttl !== null ? source : null,
    transcriptTried: o.transcriptTried === true,
    anchor: num(o.anchor),
    prevFill: num(o.prevFill),
    warmSeen: o.warmSeen === true,
    model: typeof o.model === 'string' ? o.model : null,
    miss: Math.max(0, num(o.miss) ?? 0),
    missCause: o.missCause === 'model' || o.missCause === 'prefix' ? o.missCause : null,
    pings: Math.max(0, num(o.pings) ?? 0),
    cold: o.cold === true,
    coldShown: o.coldShown === true,
    fired,
  }
}

/** A new idle period: the operator's own turn ended, or the session started over. */
export function newPeriod(c: CacheState): CacheState {
  return { ...c, pings: 0, cold: false, coldShown: false, fired: {} }
}

/** The context started over (/clear, /compact): the next request writes a new prefix. */
export function startOver(c: CacheState): CacheState {
  return { ...c, anchor: null, prevFill: null, warmSeen: false, miss: 0, missCause: null, coldShown: false }
}

/** The TTL the newest `cache_creation` usage in a transcript shows; a row with both counts 0 tells nothing, so older rows are tried. Null when none tells. */
export function ttlFromTranscript(text: string): number | null {
  const rows = text.match(/"cache_creation"\s*:\s*\{[^}]*\}/g)
  for (let i = (rows?.length ?? 0) - 1; i >= 0; i--) {
    const row = rows?.[i] ?? ''
    const hour = Number(/"ephemeral_1h_input_tokens"\s*:\s*(\d+)/.exec(row)?.[1] ?? 0)
    const five = Number(/"ephemeral_5m_input_tokens"\s*:\s*(\d+)/.exec(row)?.[1] ?? 0)
    if (hour > 0) return HOUR
    if (five > 0) return FIVE_MIN
  }
  return null
}

/** Records a detected TTL unless a stronger source already gave one. */
export function withTtl(c: CacheState, ttl: number, source: TtlSource): CacheState {
  if (c.ttlSource !== null && RANK[c.ttlSource] > RANK[source]) return c
  return { ...c, ttl, ttlSource: source }
}

/** The TTL in force: the config's, the detected one, else a guess (a subscription caches for an hour). */
export function effectiveTtl(c: CacheState, cfg: CacheConfig, hasRateLimits: boolean): { ms: number; source: TtlSource } {
  if (typeof cfg.ttl === 'number') return { ms: cfg.ttl, source: 'config' }
  if (c.ttl !== null && c.ttlSource !== null) return { ms: c.ttl, source: c.ttlSource }
  return { ms: hasRateLimits ? HOUR : FIVE_MIN, source: 'guess' }
}

/**
 * Time before the main thread's cache expires, less the margin. The full TTL
 * while a main turn runs (the cache is in use); 0 once past or while a ping's
 * cold verdict is the latest news (until the next main request); null with no
 * anchor.
 */
export function expiresInMs(c: CacheState, ttl: number, busy: boolean, now: number): number | null {
  if (c.anchor === null) return null
  if (busy) return ttl
  if (c.coldShown) return 0
  return Math.max(0, c.anchor + ttl - MARGIN_MS - now)
}

export type CacheUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model?: string | null }

const fillOf = (u: CacheUsage): number => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/**
 * One main-thread request: the miss against the previous fill when the cache
 * was expected warm (unexpired, with a baseline), a one-hour TTL proved by a
 * warm read after more than five minutes, and the new anchor and baseline. The
 * first request after a cold ping has no baseline, so it counts no miss.
 */
export function onMainRequest(c: CacheState, u: CacheUsage, ttl: number, now: number): CacheState {
  const read = u.cache_read_input_tokens
  const model = u.model ?? c.model
  const expectedWarm = c.anchor !== null && c.prevFill !== null && now - c.anchor < ttl - MARGIN_MS
  const warm = c.prevFill !== null && c.prevFill > 0 && read >= WARM_COVER * c.prevFill
  let miss = 0
  let missCause: CacheState['missCause'] = null
  const switched = c.model !== null && model !== null && model !== c.model
  if (expectedWarm && c.warmSeen && c.prevFill !== null) {
    const lost = Math.max(0, c.prevFill - read)
    if (lost >= MISS_FLOOR) {
      miss = lost
      missCause = switched ? 'model' : 'prefix'
    }
  }
  let next: CacheState = { ...c, anchor: now, prevFill: fillOf(u), warmSeen: c.warmSeen || warm, model, miss, missCause, coldShown: false }
  if (warm && c.anchor !== null && now - c.anchor > FIVE_MIN) next = withTtl(next, HOUR, 'observed')
  return next
}

export type PingVerdict = 'warm' | 'cold'

export function pingVerdict(u: CacheUsage | null | undefined): PingVerdict {
  if (!u) return 'cold'
  const read = u.cache_read_input_tokens
  return read > 0 && u.cache_creation_input_tokens < PING_WRITE_LIMIT * read ? 'warm' : 'cold'
}

export function onPing(c: CacheState, verdict: PingVerdict, now: number): CacheState {
  if (verdict === 'warm') return { ...c, pings: c.pings + 1, anchor: now, cold: false, coldShown: false }
  // The prefix is gone: the next main request writes a new one, so it has no baseline to miss against.
  return { ...c, cold: true, coldShown: true, prevFill: null }
}

export type SegmentInput = {
  expiresIn: number | null
  ttl: number
  guessed: boolean
  busy: boolean
  cold: boolean
  show: CacheShow
  warn: Quantity
  pings: number
  // `times` of the trigger that pings; null with none.
  cap: number | null
}

const within = (q: Quantity, ttl: number): number => (q.kind === 'percent' ? (q.value / 100) * ttl : q.value)

/** `cache 8m`, `cache ~8m · ping 2/3`, `cache <1m`, `cache cold`; null when hidden. */
export function cacheSegment(i: SegmentInput): BandCache | null {
  if (i.show === 'off' || i.busy || i.expiresIn === null) return null
  if (i.cold || i.expiresIn <= 0) return { text: 'cache cold', color: null, dim: true }
  if (i.show !== 'always' && i.expiresIn > within(i.show, i.ttl)) return null
  const left = i.expiresIn < 60_000 ? '<1m' : humanDuration(Math.floor(i.expiresIn / 60_000) * 60_000)
  const pings = i.pings > 0 && i.cap !== null ? ` · ping ${i.pings}/${i.cap}` : ''
  const color = i.expiresIn <= within(i.warn, i.ttl) ? 'warning' : null
  return { text: `cache ${i.guessed ? '~' : ''}${left}${pings}`, color, dim: false }
}
