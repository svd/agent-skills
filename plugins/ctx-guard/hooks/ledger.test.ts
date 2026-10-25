import { describe, expect, test } from 'claude-code/testing'

import {
  BUFFER_MAX,
  PART_BYTES,
  commitFlush,
  compactTrigger,
  expiredParts,
  fileId,
  ledgerMiss,
  listParts,
  newLedger,
  nextPart,
  parseLines,
  parsePartName,
  partName,
  planFlush,
  pushRecord,
  reqRecord,
  thresholdTokens,
  utcDay,
  utf8Bytes,
} from './ledger'
import type { LedgerRecord } from './ledger'

// 2026-10-25T12:00:00Z
const NOW = Date.UTC(2026, 9, 25, 12)
const DAY = 24 * 60 * 60_000
const DIR = '.ctx-guard/ledger'
const SID = '0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b'
const u = (input: number, read: number, write: number, out = 50, model = 'm') => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: out,
  model,
})
const req = (t: number, over: Partial<LedgerRecord> = {}): LedgerRecord =>
  ({ ...reqRecord({ t, role: 'lead', usage: u(10, 1000, 100), cacheMiss: 0, lastReqAt: null }), ...over }) as LedgerRecord

describe('records', () => {
  test('a request carries the spec fields; ctx is input + read + write, gap from the previous request', () => {
    const r = reqRecord({ t: NOW, role: 'lead', usage: u(10, 90_000, 2_000, 700, 'claude-x'), cacheMiss: 0, lastReqAt: NOW - 5_000 })
    expect(r).toEqual({ t: NOW, k: 'req', role: 'lead', ctx: 92_010, cw: 2_000, cr: 90_000, out: 700, model: 'claude-x', miss: 0, gap: 5_000 })
    expect(reqRecord({ t: NOW, role: null, usage: u(1, 2, 3), cacheMiss: 0, lastReqAt: null })).toMatchObject({ role: null, gap: null })
  })

  test('every kind keeps its fields through a part and back', () => {
    const all: LedgerRecord[] = [
      req(NOW),
      { t: NOW + 1, k: 'note', role: 'lead', id: 'ctx-soft', level: 'soft', ctx: 80_000, threshold: 80_000 },
      { t: NOW + 2, k: 'ready', role: 'lead', ctx: 120_000 },
      { t: NOW + 3, k: 'clear', role: 'lead', by: 'operator' },
      { t: NOW + 4, k: 'compact', role: null, trigger: 'auto', pre: 160_000, post: 20_000 },
      { t: NOW + 5, k: 'start', role: 'lead', window: 200_000, ttl: 3_600_000 },
      { t: NOW + 6, k: 'start', role: 'lead', window: 200_000 },
    ]
    const l = newLedger(SID, [])
    for (const r of all) pushRecord(l, r)
    const plan = planFlush(l, DIR, SID)
    expect(plan.writes.length).toBe(1)
    expect(parseLines(plan.writes[0]?.text ?? '')).toEqual(all)
    expect(Object.keys(parseLines(plan.writes[0]?.text ?? '')[6] ?? {})).not.toContain('ttl')
  })

  test('the miss is cache.ts\'s when it counts one', () => {
    expect(ledgerMiss(140_000, 141_000, 150_000)).toBe(140_000)
    expect(ledgerMiss(3_000, 0, 150_000)).toBe(3_000)
    expect(reqRecord({ t: NOW, role: 'lead', usage: u(10, 10_000, 141_000), cacheMiss: 140_000, lastReqAt: null }).miss).toBe(140_000)
  })

  test('a cold write over 40k and half the context counts as a miss; a smaller one does not', () => {
    expect(ledgerMiss(0, 150_000, 152_000)).toBe(150_000)
    expect(ledgerMiss(0, 40_000, 41_000)).toBe(0)
    expect(ledgerMiss(0, 45_000, 100_000)).toBe(0)
    expect(reqRecord({ t: NOW, role: 'lead', usage: u(10, 0, 60_000), cacheMiss: 0, lastReqAt: null }).miss).toBe(60_000)
  })

  test('a context threshold in tokens: a percent of the window, or tokens as given', () => {
    expect(thresholdTokens({ kind: 'percent', value: 40 }, 200_000)).toBe(80_000)
    expect(thresholdTokens({ kind: 'tokens', value: 50_000 }, 200_000)).toBe(50_000)
    expect(thresholdTokens(null, 200_000)).toBeNull()
  })

  test('compact triggers: precompute is not recorded; plugin and ours read ctx-guard', () => {
    expect(compactTrigger('precompute', false)).toBeNull()
    expect(compactTrigger('precompute', true)).toBeNull()
    expect(compactTrigger('plugin', false)).toBe('ctx-guard')
    expect(compactTrigger('manual', true)).toBe('ctx-guard')
    expect(compactTrigger('auto', false)).toBe('auto')
    expect(compactTrigger('manual', false)).toBe('manual')
    expect(compactTrigger('other', false)).toBeNull()
  })
})

describe('part names', () => {
  test('a name round-trips; part 1 has no suffix; foreign names are rejected', () => {
    expect(utcDay(NOW)).toBe('2026-10-25')
    expect(partName('2026-10-25', SID, 1)).toBe(`2026-10-25-${SID}.jsonl`)
    expect(partName('2026-10-25', SID, 3)).toBe(`2026-10-25-${SID}-3.jsonl`)
    for (const [sid, part] of [[SID, 1], [SID, 2], [SID, 12], ['s1', 1], ['s1', 4]] as const) {
      expect(parsePartName(partName('2026-10-25', sid, part))).toEqual({ day: '2026-10-25', sessionId: sid, part })
    }
    for (const bad of ['notes.md', `2026-10-25-${SID}.json`, `2026-10-25-${SID}-1.jsonl`, `2026-10-25-${SID}-02.jsonl`, `26-10-25-${SID}.jsonl`, `2026-10-25-.jsonl`, '../2026-10-25-s1.jsonl', `2026-10-25-${SID}.jsonl.tmp`]) {
      expect(parsePartName(bad)).toBeNull()
    }
  })

  test('the next part continues past the highest known one', () => {
    const day = '2026-10-25'
    expect(nextPart([], day, SID)).toBe(1)
    expect(nextPart([partName(day, SID, 1)], day, SID)).toBe(2)
    expect(nextPart([partName(day, SID, 1), partName(day, SID, 3), partName(day, 'other', 9), partName('2026-10-24', SID, 7)], day, SID)).toBe(4)
  })
})

describe('flush', () => {
  test('a part rolls before 256 KiB; no part is over the cap', () => {
    const l = newLedger(SID, [])
    const pad = 'x'.repeat(2_000)
    for (let i = 0; i < 300; i++) pushRecord(l, req(NOW + i, { model: pad }))
    const plan = planFlush(l, DIR, SID)
    expect(plan.writes.map(w => w.name)).toEqual([partName('2026-10-25', SID, 1), partName('2026-10-25', SID, 2), partName('2026-10-25', SID, 3)])
    for (const w of plan.writes) expect(utf8Bytes(w.text)).toBeLessThanOrEqual(PART_BYTES)
    expect(plan.writes.flatMap(w => parseLines(w.text)).length).toBe(300)
    expect(plan.open?.part).toBe(3)
    expect(plan.open?.bytes).toBe(utf8Bytes(plan.open?.text ?? ''))
    expect(plan.known).toEqual([partName('2026-10-25', SID, 1), partName('2026-10-25', SID, 2)])
  })

  test('a new day or session opens a new file', () => {
    const l = newLedger(SID, [])
    pushRecord(l, req(NOW))
    pushRecord(l, req(NOW + DAY))
    let plan = planFlush(l, DIR, SID)
    expect(plan.writes.map(w => w.name)).toEqual([partName('2026-10-25', SID, 1), partName('2026-10-26', SID, 1)])
    commitFlush(l, plan)
    pushRecord(l, req(NOW + DAY + 1))
    plan = planFlush(l, DIR, 's2')
    expect(plan.writes.map(w => w.name)).toEqual([partName('2026-10-26', 's2', 1)])
    expect(plan.known).toContain(partName('2026-10-26', SID, 1))
  })

  test('the open part is rewritten whole, its earlier lines first; a retry plans the same writes', () => {
    const l = newLedger(SID, [])
    pushRecord(l, req(NOW))
    commitFlush(l, planFlush(l, DIR, SID))
    expect(l.buffer).toEqual([])
    pushRecord(l, req(NOW + 1))
    const plan = planFlush(l, DIR, SID)
    expect(planFlush(l, DIR, SID)).toEqual(plan)
    expect(plan.writes.length).toBe(1)
    expect(parseLines(plan.writes[0]?.text ?? '').map(r => r.t)).toEqual([NOW, NOW + 1])
    commitFlush(l, plan)
    expect(planFlush(l, DIR, SID).writes).toEqual([])
  })

  test('records pushed while the writes run stay for the next flush; ones a full buffer dropped meanwhile are not counted', () => {
    const l = newLedger(SID, [])
    pushRecord(l, req(NOW), 3)
    pushRecord(l, req(NOW + 1), 3)
    const plan = planFlush(l, DIR, SID)
    pushRecord(l, req(NOW + 2), 3)
    pushRecord(l, req(NOW + 3), 3)
    expect(l.dropped).toBe(1)
    commitFlush(l, plan)
    expect(l.buffer.map(r => r.t)).toEqual([NOW + 2, NOW + 3])
    expect(l.dropped).toBe(0)
  })

  test('a session id the part pattern cannot read is written as one it can, and read back', () => {
    for (const id of ['abc-123', 'a.b/c', '', 'x-1-2']) {
      const name = partName('2026-10-25', id, 2)
      const p = parsePartName(name)
      expect(p).toEqual({ day: '2026-10-25', sessionId: fileId(id), part: 2 })
      expect(expiredParts([name], NOW + 400 * DAY, 30)).toEqual([name])
      expect(nextPart([partName('2026-10-25', id, 1), name], '2026-10-25', id)).toBe(3)
    }
    expect(fileId(SID)).toBe(SID)
    expect(fileId('s1')).toBe('s1')
  })

  test('distinct session ids never share a part name', () => {
    for (const ids of [['a.b', 'a_b', 'a b'], ['', '_'], ['1-2', '1_2']]) {
      const files = ids.map(fileId)
      expect(new Set(files).size).toBe(ids.length)
      for (const [i, id] of ids.entries()) {
        expect(parsePartName(partName('2026-10-25', id, 1))).toEqual({ day: '2026-10-25', sessionId: files[i], part: 1 })
        expect(parsePartName(partName('2026-10-25', id, 3))).toEqual({ day: '2026-10-25', sessionId: files[i], part: 3 })
      }
    }
  })

  test('a session already on disk continues in its next part', () => {
    const l = newLedger(SID, [partName('2026-10-25', SID, 1), partName('2026-10-25', SID, 2)])
    pushRecord(l, req(NOW))
    expect(planFlush(l, DIR, SID).writes.map(w => w.name)).toEqual([partName('2026-10-25', SID, 3)])
  })
})

describe('buffer', () => {
  test('holds at most 1,000 records, drops the oldest and counts them', () => {
    const l = newLedger(SID, [])
    for (let i = 0; i < BUFFER_MAX + 5; i++) pushRecord(l, req(NOW + i))
    expect(l.buffer.length).toBe(BUFFER_MAX)
    expect(l.dropped).toBe(5)
    expect(l.buffer[0]?.t).toBe(NOW + 5)
    pushRecord(l, req(NOW), 2)
    expect(l.buffer.length).toBe(2)
  })
})

describe('retention and reading', () => {
  test('keeps today and the last days, deletes older parts, ignores other names', () => {
    const name = (daysAgo: number, part = 1) => partName(utcDay(NOW - daysAgo * DAY), SID, part)
    const names = [name(0), name(29), name(30), name(31), name(31, 2), name(400), 'notes.md', '2020-01-01.jsonl', 'x-2020-01-01-s1.jsonl']
    expect(expiredParts(names, NOW, 30)).toEqual([name(31), name(31, 2), name(400)])
    expect(expiredParts(names, NOW, 1)).toEqual([name(29), name(30), name(31), name(31, 2), name(400)])
  })

  test('parts per session day in numeric order', () => {
    const day = '2026-10-25'
    const names = [partName(day, SID, 10), partName(day, SID, 2), 'junk', partName(day, SID, 1), partName('2026-10-24', 's1', 1)]
    expect(listParts(names)).toEqual([
      { day: '2026-10-24', sessionId: 's1', parts: [partName('2026-10-24', 's1', 1)] },
      { day, sessionId: SID, parts: [partName(day, SID, 1), partName(day, SID, 2), partName(day, SID, 10)] },
    ])
  })

  test('malformed lines are skipped', () => {
    const good = JSON.stringify(req(NOW))
    const text = [good, '{"t":1,"k":"req"', 'null', '{"t":1,"k":"nope","role":null}', '{"t":"1","k":"ready","role":null,"ctx":1}', '', good].join('\n')
    expect(parseLines(text).length).toBe(2)
    expect(parseLines('')).toEqual([])
  })

  test('utf-8 byte length', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('€')).toBe(3)
    expect(utf8Bytes('😀')).toBe(4)
  })
})
