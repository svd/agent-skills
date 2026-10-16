import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CACHE } from './config'
import { HOUR, FIVE_MIN, MARGIN_MS, asCache, cacheSegment, effectiveTtl, emptyCache, expiresInMs, newPeriod, onMainRequest, onPing, pingVerdict, startOver, ttlFromTranscript, withTtl } from './cache'
import type { CacheState } from '../types'

const NOW = 1_000_000_000
const MIN = 60_000
const u = (read: number, write: number, model = 'm', input = 10) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, model })

describe('ttl', () => {
  test('from the newest cache_creation row of the transcript', () => {
    const rows = [
      '{"message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":900,"ephemeral_1h_input_tokens":0}}}}',
      '{"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":25528,"ephemeral_5m_input_tokens":0}}}}',
    ].join('\n')
    expect(ttlFromTranscript(rows)).toBe(HOUR)
    expect(ttlFromTranscript(rows.split('\n')[0] as string)).toBe(FIVE_MIN)
    expect(ttlFromTranscript('{"x":1}')).toBeNull()
    expect(ttlFromTranscript('{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}}')).toBeNull()
  })

  test('a stronger source replaces a weaker one, never the reverse', () => {
    let c = withTtl(emptyCache(), FIVE_MIN, 'observed')
    c = withTtl(c, HOUR, 'transcript')
    expect([c.ttl, c.ttlSource]).toEqual([HOUR, 'transcript'])
    c = withTtl(c, FIVE_MIN, 'observed')
    expect([c.ttl, c.ttlSource]).toEqual([HOUR, 'transcript'])
  })

  test('config wins; else the detected value; else a guess from the account', () => {
    expect(effectiveTtl(emptyCache(), { ...DEFAULT_CACHE, ttl: FIVE_MIN }, true)).toEqual({ ms: FIVE_MIN, source: 'config' })
    expect(effectiveTtl(withTtl(emptyCache(), FIVE_MIN, 'transcript'), DEFAULT_CACHE, true)).toEqual({ ms: FIVE_MIN, source: 'transcript' })
    expect(effectiveTtl(emptyCache(), DEFAULT_CACHE, true)).toEqual({ ms: HOUR, source: 'guess' })
    expect(effectiveTtl(emptyCache(), DEFAULT_CACHE, false)).toEqual({ ms: FIVE_MIN, source: 'guess' })
  })
})

describe('expiresIn', () => {
  const at = (anchor: number | null, over: Partial<CacheState> = {}): CacheState => ({ ...emptyCache(), anchor, ...over })
  test('ttl minus the margin from the anchor', () => {
    expect(expiresInMs(at(NOW), HOUR, false, NOW + 10 * MIN)).toBe(HOUR - MARGIN_MS - 10 * MIN)
  })
  test('zero once past, never negative', () => {
    expect(expiresInMs(at(NOW), FIVE_MIN, false, NOW + 2 * HOUR)).toBe(0)
  })
  test('the full ttl while a main turn runs', () => {
    expect(expiresInMs(at(NOW), HOUR, true, NOW + 50 * MIN)).toBe(HOUR)
  })
  test('unknown with no anchor; zero once a ping found it cold', () => {
    expect(expiresInMs(at(null), HOUR, false, NOW)).toBeNull()
    expect(expiresInMs(at(NOW, { cold: true, coldShown: true }), HOUR, false, NOW + MIN)).toBe(0)
  })
})

describe('main requests', () => {
  test('the first requests set a baseline and never count a miss', () => {
    let c = onMainRequest(emptyCache(), u(10_583, 25_528), HOUR, NOW)
    expect([c.miss, c.anchor, c.prevFill, c.warmSeen]).toEqual([0, NOW, 36_121, false])
    // The spike's second request: most of the prefix rewritten, still before any warm request.
    c = onMainRequest(c, u(13_615, 22_726), HOUR, NOW + MIN)
    expect(c.miss).toBe(0)
    c = onMainRequest(c, u(36_300, 100), HOUR, NOW + 2 * MIN)
    expect(c.warmSeen).toBe(true)
  })

  test('after a warm request, a rewrite of the prefix is a miss', () => {
    let c: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    c = onMainRequest(c, u(10_000, 141_000), HOUR, NOW + 2 * MIN)
    expect([c.miss, c.missCause]).toEqual([140_000, 'prefix'])
    c = onMainRequest(c, u(151_000, 500), HOUR, NOW + 3 * MIN)
    expect([c.miss, c.missCause]).toEqual([0, null])
  })

  test('a miss below the floor is zero; a model switch names its cause', () => {
    const base: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    expect(onMainRequest(base, u(148_500, 2_000), HOUR, NOW + MIN).miss).toBe(0)
    const sw = onMainRequest(base, u(0, 151_000, 'other'), HOUR, NOW + MIN)
    expect([sw.miss, sw.missCause, sw.model]).toEqual([150_000, 'model', 'other'])
  })

  test('a rewrite after the cache expired is not a miss', () => {
    const c: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    expect(onMainRequest(c, u(0, 151_000), FIVE_MIN, NOW + 20 * MIN).miss).toBe(0)
  })

  test('a rewrite after a ping found the cache cold is not a miss; later requests are checked again', () => {
    const warm: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    let c = onPing(warm, 'cold', NOW + 55 * MIN)
    expect([c.cold, c.prevFill]).toEqual([true, null])
    c = onMainRequest(c, u(0, 151_000), HOUR, NOW + 56 * MIN)
    expect(c.miss).toBe(0)
    c = onMainRequest(c, u(151_000, 500), HOUR, NOW + 57 * MIN)
    expect(c.miss).toBe(0)
    c = onMainRequest(c, u(10_000, 142_000), HOUR, NOW + 58 * MIN)
    expect([c.miss, c.missCause]).toEqual([141_510, 'prefix'])
  })

  test('after a cold ping the countdown reads 0 until the next main request, and pings stay blocked', () => {
    const warm: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    let c = onPing(warm, 'cold', NOW + 55 * MIN)
    expect(expiresInMs(c, HOUR, false, NOW + 56 * MIN)).toBe(0)
    c = onMainRequest(c, u(0, 151_000), HOUR, NOW + 56 * MIN)
    expect(expiresInMs(c, HOUR, false, NOW + 60 * MIN)).toBe(HOUR - MARGIN_MS - 4 * MIN)
    expect(c.cold).toBe(true)
    expect(newPeriod(c).cold).toBe(false)
  })

  test('the miss gate is strict at ttl minus the margin; a model switch before any warm request is no miss', () => {
    const base: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    expect(onMainRequest(base, u(0, 151_000), HOUR, NOW + HOUR - MARGIN_MS - 1).miss).toBe(150_000)
    expect(onMainRequest(base, u(0, 151_000), HOUR, NOW + HOUR - MARGIN_MS).miss).toBe(0)
    const early: CacheState = { ...base, warmSeen: false }
    expect(onMainRequest(early, u(0, 151_000, 'other'), HOUR, NOW + MIN)).toMatchObject({ miss: 0, missCause: null, model: 'other' })
  })

  test('a start-over (/clear, /compact) forgets the baseline, so the next rewrite is no miss', () => {
    const c = startOver({ ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm', miss: 5_000, missCause: 'prefix' })
    expect([c.anchor, c.prevFill, c.warmSeen, c.miss, c.missCause]).toEqual([null, null, false, 0, null])
    expect(onMainRequest(c, u(0, 40_000), HOUR, NOW + MIN).miss).toBe(0)
  })

  test('a warm request after more than five minutes proves a one-hour ttl', () => {
    const c: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    const next = onMainRequest(c, u(150_000, 500), FIVE_MIN, NOW + 20 * MIN)
    expect([next.ttl, next.ttlSource]).toEqual([HOUR, 'observed'])
  })
})

describe('pings', () => {
  test('verdicts', () => {
    expect(pingVerdict(u(36_116, 0))).toBe('warm')
    expect(pingVerdict(u(36_193, 153))).toBe('warm')
    expect(pingVerdict(u(13_615, 22_501))).toBe('cold')
    expect(pingVerdict(u(1_000, 99))).toBe('warm')
    expect(pingVerdict(u(1_000, 100))).toBe('cold')
    expect(pingVerdict(u(0, 40_000))).toBe('cold')
    expect(pingVerdict(null)).toBe('cold')
  })
  test('a warm ping counts and moves the anchor; a cold one marks the period', () => {
    const c: CacheState = { ...emptyCache(), anchor: NOW }
    expect(onPing(c, 'warm', NOW + 55 * MIN)).toMatchObject({ pings: 1, anchor: NOW + 55 * MIN, cold: false })
    expect(onPing(c, 'cold', NOW + 55 * MIN)).toMatchObject({ pings: 0, anchor: NOW, cold: true })
  })
  test('a new period clears pings, fire counts and cold', () => {
    const c = newPeriod({ ...emptyCache(), pings: 3, cold: true, fired: { warm: 3 }, anchor: NOW })
    expect([c.pings, c.cold, c.fired, c.anchor]).toEqual([0, false, {}, NOW])
  })
})

describe('segment', () => {
  const seg = (over: Partial<Parameters<typeof cacheSegment>[0]> = {}) =>
    cacheSegment({ expiresIn: 8 * MIN, ttl: HOUR, guessed: false, busy: false, cold: false, show: { kind: 'percent', value: 17 }, warn: { kind: 'duration', value: 3 * MIN }, pings: 0, cap: null, ...over })

  test('17 % of a one-hour ttl shows from about ten minutes', () => {
    expect(seg({ expiresIn: 11 * MIN })).toBeNull()
    expect(seg({ expiresIn: 10 * MIN })).toEqual({ text: 'cache 10m', color: null, dim: false })
  })
  test('17 % of a five-minute ttl shows from about fifty seconds', () => {
    expect(seg({ ttl: FIVE_MIN, expiresIn: 60_000 })).toBeNull()
    expect(seg({ ttl: FIVE_MIN, expiresIn: 45_000 })?.text).toBe('cache <1m')
  })
  test('warning colour under warn, ~ while guessed, pings with their cap', () => {
    expect(seg({ expiresIn: 2 * MIN })?.color).toBe('warning')
    expect(seg({ guessed: true })?.text).toBe('cache ~8m')
    expect(seg({ pings: 2, cap: 3 })?.text).toBe('cache 8m · ping 2/3')
  })
  test('cold, busy, always and off', () => {
    expect(seg({ expiresIn: 0 })).toEqual({ text: 'cache cold', color: null, dim: true })
    expect(seg({ cold: true, expiresIn: 0 })).toEqual({ text: 'cache cold', color: null, dim: true })
    expect(seg({ busy: true })).toBeNull()
    expect(seg({ show: 'always', expiresIn: 50 * MIN })?.text).toBe('cache 50m')
    expect(seg({ show: 'off' })).toBeNull()
    expect(seg({ expiresIn: null })).toBeNull()
  })
})

test('asCache keeps what it can read of another version\'s value', () => {
  expect(asCache(null)).toEqual(emptyCache())
  expect(asCache({ anchor: 5, pings: 2, fired: { a: 1, b: 'x' }, ttl: 3_600_000, ttlSource: 'observed' })).toMatchObject({ anchor: 5, pings: 2, fired: { a: 1 }, ttl: 3_600_000, ttlSource: 'observed' })
  expect(asCache({ coldShown: true, pings: -2, miss: -5 })).toMatchObject({ coldShown: true, pings: 0, miss: 0 })
  expect(asCache({ ttlSource: 'nonsense', ttl: 3_600_000 })).toMatchObject({ ttl: null, ttlSource: null })
})
