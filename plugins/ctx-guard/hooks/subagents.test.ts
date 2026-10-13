import { describe, expect, test } from 'claude-code/testing'
import type { Budget, Config } from '../types'
import { validate } from './config'
import {
  PRUNE_AFTER_MS,
  asMarks,
  asSpawned,
  budgetFor,
  decide,
  fromMark,
  kindOf,
  listedIdentity,
  lowestGate,
  markOf,
  overCount,
  shortId,
  staleIds,
  staleSpawns,
  stopDeny,
  track,
} from './subagents'

const B: Budget = { type: '*', warn: 120_000, stop: 170_000, message: null }
const INF = Number.POSITIVE_INFINITY

describe('decide', () => {
  test('warn once past warn, stop once past stop; the gate is the next budget', () => {
    expect(decide(B, 100_000, false, false)).toEqual({ step: null, gate: 120_000 })
    expect(decide(B, 125_000, false, false)).toEqual({ step: 'warn', gate: 170_000 })
    expect(decide(B, 130_000, true, false)).toEqual({ step: null, gate: 170_000 })
    expect(decide(B, 175_000, true, false)).toEqual({ step: 'stop', gate: INF })
    expect(decide(B, 180_000, true, true)).toEqual({ step: null, gate: INF })
  })

  test('past both at once sends the stop alone', () => {
    expect(decide(B, 200_000, false, false)).toEqual({ step: 'stop', gate: INF })
  })

  test('a missing step is skipped; no budget never fires', () => {
    expect(decide({ ...B, warn: null }, 150_000, false, false)).toEqual({ step: null, gate: 170_000 })
    expect(decide({ ...B, stop: null }, 150_000, false, false)).toEqual({ step: 'warn', gate: INF })
    expect(decide(null, 1e9, false, false)).toEqual({ step: null, gate: INF })
  })
})

describe('stopDeny', () => {
  test('only a stopped agent still past the stop is refused', () => {
    const t = { ...track(), tokens: 175_000, warned: true, stopped: true }
    expect(stopDeny(t, B, 'Bash')).toBe(170_000)
    expect(stopDeny({ ...t, stopped: false }, B, 'Bash')).toBeNull()
    expect(stopDeny(undefined, B, 'Bash')).toBeNull()
    expect(stopDeny(t, { ...B, stop: null }, 'Bash')).toBeNull()
    // The budget was raised since: the deny lifts.
    expect(stopDeny(t, { ...B, stop: 200_000 }, 'Bash')).toBeNull()
  })

  test('the tools that hand the result back are never refused', () => {
    const t = { ...track(), tokens: 175_000, warned: true, stopped: true }
    for (const tool of ['SubagentHandback', 'StructuredOutput', 'ReportFindings']) expect(stopDeny(t, B, tool)).toBeNull()
    expect(stopDeny(t, B, 'Agent')).toBe(170_000)
  })
})

describe('marks', () => {
  test('a mark round-trips into a followed agent that sends nothing again', () => {
    const t = { ...track({ type: 'Explore', kind: 'agent' }), tokens: 155_000, warned: true, stopped: true, warn: 120_000, stop: 150_000 }
    expect(markOf(track(), 1)).toBeNull()
    // An agent no one named carries no budget, so nothing to keep.
    expect(markOf({ ...t, identity: 'unlisted' }, 1)).toBeNull()
    const m = markOf(t, 5)
    expect(m).toEqual({ type: 'Explore', kind: 'agent', tokens: 155_000, step: 'stop', warn: 120_000, stop: 150_000, at: 5 })
    const back = fromMark(JSON.parse(JSON.stringify(m)))
    expect(back).toMatchObject({ identity: { type: 'Explore', kind: 'agent' }, warned: true, stopped: true, gate: 0 })
    expect(decide({ ...B, stop: 150_000 }, back.tokens, back.warned, back.stopped).step).toBeNull()
  })

  test('garbage from $.state is dropped, never thrown', () => {
    const bad = [null, 5, 'x', [], { a: null }, { a: { step: 'go', tokens: 1, at: 1 } }, { a: { step: 'warn', type: 't', kind: 'agent', tokens: 'x', at: 1 } }]
    for (const v of bad) expect(asMarks(v)).toEqual({})
    expect(asMarks({ a: { step: 'warn', type: 't', kind: 'agent', tokens: 1, at: 2, warn: 'x' } })).toEqual({
      a: { type: 't', kind: 'agent', tokens: 1, step: 'warn', warn: null, stop: null, at: 2 },
    })
    expect(asMarks({ a: { step: 'warn', type: 't', kind: 'robot', tokens: 1, at: 2 } })).toEqual({})
    expect(asSpawned({ a: { type: 'Explore', kind: 'fork', at: 1 }, b: { type: 5, kind: 'agent', at: 1 }, c: 'x' })).toEqual({ a: { type: 'Explore', kind: 'fork', at: 1 } })
  })
})

describe('who is budgeted', () => {
  const cfg = (subagents: unknown): Config => validate({ version: 1, subagents }).config as Config
  const c = cfg({ '*': { warn: '120k', stop: '170k' }, Explore: { stop: '150k' } })

  test('a plain agent: its type, else "*"; an unlisted or unknown one: none', () => {
    expect(budgetFor(c, { type: 'Explore', kind: 'agent' })).toMatchObject({ type: 'Explore', warn: 120_000, stop: 150_000 })
    expect(budgetFor(c, { type: 'general-purpose', kind: 'agent' })).toMatchObject({ type: '*', stop: 170_000 })
    expect(budgetFor(c, 'unlisted')).toBeNull()
    expect(budgetFor(c, null)).toBeNull()
  })

  test('forks and teammates only under an entry that names them, merged over "*"', () => {
    expect(budgetFor(c, { type: 'fork', kind: 'fork' })).toBeNull()
    expect(budgetFor(c, { type: 'teammate', kind: 'teammate' })).toBeNull()
    expect(budgetFor(c, { type: 'Explore', kind: 'teammate' })).toMatchObject({ type: 'Explore', stop: 150_000 })
    const named = cfg({ '*': { warn: '120k', stop: '170k' }, fork: { stop: '300k' }, teammate: { warn: 'off', stop: '400k' } })
    expect(budgetFor(named, { type: 'fork', kind: 'fork' })).toEqual({ type: 'fork', warn: 120_000, stop: 300_000, message: null })
    expect(budgetFor(named, { type: 'reviewer', kind: 'teammate' })).toEqual({ type: 'teammate', warn: null, stop: 400_000, message: null })
  })

  test('kinds from a spawn and from the list', () => {
    expect(kindOf({ fork: true })).toBe('fork')
    expect(kindOf({ fork: false, isTeammate: true })).toBe('teammate')
    expect(kindOf({ fork: false })).toBe('agent')
    expect(listedIdentity(undefined)).toBe('unlisted')
    expect(listedIdentity({ type: 'Explore' })).toEqual({ type: 'Explore', kind: 'agent' })
    expect(listedIdentity({ type: 'reviewer', teammateId: 'reviewer@team' })).toEqual({ type: 'reviewer', kind: 'teammate' })
    expect(listedIdentity({ type: 'fork' })).toEqual({ type: 'fork', kind: 'fork' })
  })

  test('lowestGate is the lowest step of any entry', () => {
    expect(lowestGate(cfg({ '*': { warn: '120k', stop: '170k' }, Explore: { warn: 'off', stop: '50k' } }))).toBe(50_000)
    expect(lowestGate(cfg({}))).toBe(INF)
  })
})

describe('counting and pruning', () => {
  test('overCount counts warned and stopped agents', () => {
    const m = new Map([
      ['a', { ...track(), warned: true }],
      ['b', { ...track(), warned: true, stopped: true }],
      ['c', track()],
    ])
    expect(overCount(m)).toBe(2)
  })

  test('stale: not evaluated nor stepping for PRUNE_AFTER_MS', () => {
    const now = 10 * PRUNE_AFTER_MS
    const m = new Map([
      ['old', { ...track(), seenAt: now - PRUNE_AFTER_MS }],
      ['stepping', { ...track(), seenAt: now - PRUNE_AFTER_MS }],
      ['fresh', { ...track(), seenAt: now - 1 }],
      ['never', track()],
    ])
    expect(staleIds(m, new Map([['stepping', now - 1], ['never', Number.NaN]]), now)).toEqual(['old'])
  })

  test('stale spawn records: old and not stepping since', () => {
    const now = 10 * PRUNE_AFTER_MS
    const spawned = { old: { type: 'x', kind: 'agent' as const, at: now - PRUNE_AFTER_MS }, busy: { type: 'x', kind: 'agent' as const, at: 0 }, fresh: { type: 'x', kind: 'agent' as const, at: now } }
    expect(staleSpawns(spawned, new Map([['busy', now - 1]]), now)).toEqual(['old'])
  })

  test('shortId', () => {
    expect(shortId('a1b2c3d4e5f6')).toBe('a1b2c3d4')
    expect(shortId('wf-1')).toBe('wf-1')
  })
})
