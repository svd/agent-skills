import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_SELF_GAP } from './config'
import {
  CHECK_TAIL_CHARS,
  COMPACT_QUIET_MS,
  PENDING_RESUME_MS,
  REFUSAL_CODES,
  asLastCompact,
  asPendingCompact,
  asPendingResume,
  checkDetail,
  checkLines,
  compactArgs,
  compactBusy,
  compactGate,
  compactRequest,
  isReadyAnswer,
  isUnder,
  nextLastCompact,
  parseStamp,
  pendingAction,
  pendingFresh,
  quietVerdict,
  raceVerdict,
  restartFailedText,
  filledResumeArgs,
  resumeArgs,
  stampJson,
  stampPath,
  renoteRisk,
  verdict,
  outputTail,
} from './restart'
import type { Facts } from './restart'
import type { LastCompact, PendingCompact, PendingResume } from '../types'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const MIN = 60 * 1000

// Facts under which a clear restart goes ahead; each test breaks one.
function facts(over: Partial<Facts> = {}): Facts {
  return {
    via: 'clear',
    role: 'lead',
    trusted: true,
    untrustedWhy: 'never approved',
    busy: null,
    context: { tokens: 320_000, floor: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } }, min: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } } },
    asked: false,
    lastRestartAt: null,
    selfGap: 5 * MIN,
    command: 'ctx-guard:resume',
    commands: ['clear', 'compact', 'ctx-guard', 'ctx-guard:resume'],
    agents: [{ id: 'a1', status: 'completed', description: 'old work' }],
    steps: [],
    background: [],
    lease: { kind: 'mine' },
    handoff: { kind: 'present', path: '.ctx-guard/lead-handoff.md', mtime: NOW - MIN },
    startedAt: NOW - 60 * MIN,
    lastClearAt: null,
    ownStamp: { kind: 'absent' },
    peers: [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW - 30 * MIN, owner: 'other' } }],
    peerGap: 10 * MIN,
    now: NOW,
    checks: [{ run: ['./ready.sh'], ok: true, detail: 'exited 0' }],
    error: null,
    ...over,
  }
}

const refusal = (f: Facts): string | null => {
  const v = verdict(f)
  return v.ok ? null : v.code
}

describe('verdict: one refusal per code', () => {
  test('all facts holding: go ahead', () => {
    expect(verdict(facts())).toEqual({ ok: true })
  })

  test('untrusted', () => {
    const v = verdict(facts({ trusted: false, untrustedWhy: 'changed since approval: lead.restart' }))
    expect(v).toEqual({
      ok: false,
      code: 'untrusted',
      text: "this repo's restart settings are not approved (changed since approval: lead.restart); the operator runs /ctx-guard trust",
    })
  })

  test('already-busy', () => {
    expect(refusal(facts({ busy: 'a restart of this session is already under way' }))).toBe('already-busy')
  })

  test('not-needed: the context is under restart.minContext, whatever the triggers say', () => {
    const min = { tokens: 400_000, threshold: { kind: 'percent', value: 40 } } as const
    const floor = { tokens: 100_000, threshold: { kind: 'tokens', value: 100_000 } } as const
    expect(verdict(facts({ context: { tokens: 120_000, floor, min } }))).toEqual({
      ok: false,
      code: 'not-needed',
      text: 'context is at 120k, under restart.minContext 40% (400k): a restart frees nothing yet',
    })
    expect(verdict(facts({ context: { tokens: 400_000, floor, min } }))).toEqual({ ok: true })
    // minContext off, or no figure (right after a /clear): not judged, even under every trigger.
    expect(verdict(facts({ context: { tokens: 50_000, floor, min: null } }))).toEqual({ ok: true })
    expect(checkLines(facts({ context: { tokens: 50_000, floor, min: null } })).find(l => l.code === 'not-needed')).toEqual({ code: 'not-needed', status: 'skip', text: 'restart.minContext is off' })
    expect(checkLines(facts({ context: { tokens: null, floor, min } })).find(l => l.code === 'not-needed')).toEqual({ code: 'not-needed', status: 'skip', text: 'context unknown' })
    // A restart the operator asked for with /ctx-guard:clear is not judged either.
    expect(verdict(facts({ context: { tokens: 120_000, floor, min }, asked: true }))).toEqual({ ok: true })
    expect(checkLines(facts({ context: { tokens: 120_000, floor, min }, asked: true })).find(l => l.code === 'not-needed')).toEqual({
      code: 'not-needed',
      status: 'skip',
      text: 'the operator asked for it with /ctx-guard:clear',
    })
  })

  test('too-soon: this session restarted within selfGap; 0 turns it off', () => {
    expect(verdict(facts({ lastRestartAt: NOW - 2 * MIN }))).toEqual({
      ok: false,
      code: 'too-soon',
      text: 'this session restarted 2m ago, under selfGap 5m',
    })
    expect(verdict(facts({ lastRestartAt: NOW - 5 * MIN }))).toEqual({ ok: true })
    expect(verdict(facts({ lastRestartAt: NOW - MIN, selfGap: 0 }))).toEqual({ ok: true })
    expect(checkLines(facts({ selfGap: 0 })).find(l => l.code === 'too-soon')?.status).toBe('skip')
  })

  test('too-soon under the default selfGap of 1m: refused at 30s, allowed at 1m', () => {
    const at = (ago: number) => verdict(facts({ lastRestartAt: NOW - ago, selfGap: DEFAULT_SELF_GAP }))
    expect(at(30_000)).toEqual({ ok: false, code: 'too-soon', text: 'this session restarted 30s ago, under selfGap 1m' })
    expect(at(MIN)).toEqual({ ok: true })
  })

  test('renoteRisk: a context past the lowest threshold just after a restart warns, never refuses', () => {
    expect(renoteRisk(facts({ lastRestartAt: NOW - MIN }))).toBe(
      'warning: 1m after the last restart the context (320k) is already past the lowest context threshold 300k; the next note may ask for another restart at once. Raise that threshold, or load less on resume.',
    )
    expect(renoteRisk(facts({ lastRestartAt: NOW - 6 * MIN }))).toBeNull()
    expect(renoteRisk(facts({ lastRestartAt: null }))).toBeNull()
    expect(renoteRisk(facts({ lastRestartAt: NOW - MIN, context: { tokens: 100_000, floor: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } }, min: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } } } }))).toBeNull()
  })

  test('no-restart-command', () => {
    const v = verdict(facts({ commands: ['clear'] }))
    expect(v).toEqual({ ok: false, code: 'no-restart-command', text: "/ctx-guard:resume is not among the session's commands" })
  })

  test('agents-running: a pending, running or waiting agent', () => {
    for (const status of ['pending', 'running', 'waiting']) {
      const v = verdict(facts({ agents: [{ id: 'a2', status, description: 'review the diff' }] }))
      expect(v).toEqual({ ok: false, code: 'agents-running', text: 'agents still running: review the diff' })
    }
  })

  test('agents-running: a recent step from an agent no list shows (a workflow)', () => {
    const v = verdict(facts({ steps: ['wf-7'] }))
    expect(v).toEqual({ ok: false, code: 'agents-running', text: 'agents still running: agent wf-7 (stepped recently)' })
  })

  test('a listed agent that ended does not hold the restart back, even with a step seen', () => {
    expect(verdict(facts({ steps: ['a1'] }))).toEqual({ ok: true })
  })

  test('background-tasks', () => {
    const v = verdict(facts({ background: [{ type: 'shell', description: 'npm run watch' }] }))
    expect(v).toEqual({ ok: false, code: 'background-tasks', text: 'background tasks still running: npm run watch' })
  })

  test('background-tasks: an unknown list refuses', () => {
    expect(verdict(facts({ background: null }))).toEqual({
      ok: false,
      code: 'background-tasks',
      text: 'background tasks unknown: no Stop has reported them since the session started',
    })
  })

  test('role-shared', () => {
    const v = verdict(facts({ lease: { kind: 'shared', sessionId: 'sess-2' } }))
    expect(v).toEqual({ ok: false, code: 'role-shared', text: 'another live session (sess-2) holds role "lead"' })
  })

  test('no-handoff', () => {
    const v = verdict(facts({ handoff: { kind: 'absent', path: '.ctx-guard/lead-handoff.md' } }))
    expect(v).toEqual({ ok: false, code: 'no-handoff', text: '.ctx-guard/lead-handoff.md does not exist' })
  })

  test('handoff-stale: not after the session start', () => {
    const v = verdict(facts({ handoff: { kind: 'present', path: 'h.md', mtime: NOW - 61 * MIN } }))
    expect(v.ok ? '' : v.code).toBe('handoff-stale')
    expect(v.ok ? '' : v.text).toContain('(the session start or the last /clear)')
  })

  test('handoff-stale: not after the last clear; equal counts as stale', () => {
    expect(refusal(facts({ lastClearAt: NOW - 2 * MIN, handoff: { kind: 'present', path: 'h.md', mtime: NOW - 3 * MIN } }))).toBe('handoff-stale')
    expect(refusal(facts({ lastClearAt: NOW - 2 * MIN, handoff: { kind: 'present', path: 'h.md', mtime: NOW - 2 * MIN } }))).toBe('handoff-stale')
    expect(refusal(facts({ lastClearAt: NOW - 2 * MIN, handoff: { kind: 'present', path: 'h.md', mtime: NOW - MIN } }))).toBeNull()
  })

  test('stamp-unreadable: own or a peer', () => {
    expect(verdict(facts({ ownStamp: { kind: 'unreadable', detail: 'x' } }))).toEqual({
      ok: false,
      code: 'stamp-unreadable',
      text: 'the restart stamp of lead cannot be read',
    })
    expect(refusal(facts({ peers: [{ role: 'reviewer', stamp: { kind: 'unreadable', detail: 'x' } }] }))).toBe('stamp-unreadable')
  })

  test('peer-restarting: a peer stamp younger than peerGap', () => {
    const v = verdict(facts({ peers: [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW - 4 * MIN, owner: 'x' } }] }))
    expect(v).toEqual({ ok: false, code: 'peer-restarting', text: 'the reviewer session restarted 4m ago, under peerGap 10m' })
    expect(refusal(facts({ peers: [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW - 10 * MIN, owner: 'x' } }] }))).toBeNull()
  })

  test('ready-check-failed: the first failing check is named', () => {
    const v = verdict(
      facts({
        checks: [
          { run: ['./a.sh'], ok: true, detail: 'exited 0' },
          { run: ['./b.sh', '--quick'], ok: false, detail: 'exited 2' },
        ],
      }),
    )
    expect(v).toEqual({ ok: false, code: 'ready-check-failed', text: './b.sh --quick: exited 2' })
  })

  test('race-lost: an older young peer stamp wins; a tie goes to the smaller id', () => {
    const own = { at: NOW, owner: 's-b' }
    expect(raceVerdict(own, [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW - 1, owner: 's-z' } }], 10 * MIN, NOW)).toEqual({
      ok: false,
      code: 'race-lost',
      text: 'the reviewer session started its restart first',
    })
    expect(raceVerdict(own, [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW, owner: 's-a' } }], 10 * MIN, NOW).ok).toBe(false)
    // The newer one, or the same time with a larger id, loses on its own side.
    expect(raceVerdict(own, [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW, owner: 's-c' } }], 10 * MIN, NOW)).toEqual({ ok: true })
    expect(raceVerdict(own, [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW + 5, owner: 's-a' } }], 10 * MIN, NOW)).toEqual({ ok: true })
    expect(raceVerdict(own, [{ role: 'reviewer', stamp: { kind: 'ok', at: NOW - 11 * MIN, owner: 's-a' } }], 10 * MIN, NOW)).toEqual({ ok: true })
    expect(raceVerdict(own, [{ role: 'reviewer', stamp: { kind: 'unreadable', detail: '' } }], 10 * MIN, NOW).ok).toBe(false)
  })

  test('two sessions that both wrote their stamps: exactly one wins', () => {
    const a = { at: NOW, owner: 's-a' }
    const b = { at: NOW + 3, owner: 's-b' }
    const sees = (s: { at: number; owner: string }) => [{ role: 'peer', stamp: { kind: 'ok' as const, ...s } }]
    const wins = [raceVerdict(a, sees(b), 10 * MIN, NOW + 3).ok, raceVerdict(b, sees(a), 10 * MIN, NOW + 3).ok]
    expect(wins).toEqual([true, false])
  })

  test('error: facts that could not be gathered', () => {
    expect(verdict(facts({ error: 'handoff path h.md resolves outside the project root' }))).toEqual({
      ok: false,
      code: 'error',
      text: 'handoff path h.md resolves outside the project root',
    })
  })

  test('every code is covered and in the plan order', () => {
    expect([...REFUSAL_CODES]).toEqual([
      'untrusted',
      'already-busy',
      'not-needed',
      'too-soon',
      'no-restart-command',
      'agents-running',
      'background-tasks',
      'role-shared',
      'no-handoff',
      'handoff-stale',
      'stamp-unreadable',
      'peer-restarting',
      'ready-check-failed',
      'race-lost',
      'error',
    ])
  })
})

describe('verdict order and the check list', () => {
  test('the first failing check wins', () => {
    const all = facts({
      trusted: false,
      busy: 'busy',
      context: { tokens: 100_000, floor: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } }, min: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } } },
      lastRestartAt: NOW - MIN,
      commands: [],
      agents: [{ id: 'x', status: 'running' }],
      background: [{ type: 'shell', description: 'x' }],
      lease: { kind: 'shared', sessionId: 'y' },
      handoff: { kind: 'absent', path: 'h.md' },
      ownStamp: { kind: 'unreadable', detail: '' },
      peers: [{ role: 'p', stamp: { kind: 'ok', at: NOW, owner: 'z' } }],
      checks: [{ run: ['x'], ok: false, detail: 'exited 1' }],
    })
    const order: string[] = []
    let f = all
    const fixes: Partial<Facts>[] = [
      { trusted: true },
      { busy: null },
      { context: { tokens: 320_000, floor: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } }, min: { tokens: 300_000, threshold: { kind: 'tokens', value: 300_000 } } } },
      { lastRestartAt: NOW - 10 * MIN },
      { commands: ['ctx-guard:resume'] },
      { agents: [] },
      { background: [] },
      { lease: { kind: 'free' } },
      { handoff: { kind: 'present', path: 'h.md', mtime: NOW - MIN } },
      { ownStamp: { kind: 'absent' } },
      { peers: [] },
      { checks: [] },
    ]
    for (const fix of fixes) {
      order.push(refusal(f) ?? 'ok')
      f = { ...f, ...fix }
    }
    order.push(refusal(f) ?? 'ok')
    expect(order).toEqual([
      'untrusted',
      'already-busy',
      'not-needed',
      'too-soon',
      'no-restart-command',
      'agents-running',
      'background-tasks',
      'role-shared',
      'no-handoff',
      'stamp-unreadable',
      'peer-restarting',
      'ready-check-failed',
      'ok',
    ])
  })

  test('via compact skips the lease, handoff and peer checks', () => {
    const f = facts({
      via: 'compact',
      command: 'compact',
      lease: { kind: 'shared', sessionId: 'y' },
      handoff: { kind: 'absent', path: 'h.md' },
      peers: [{ role: 'p', stamp: { kind: 'ok', at: NOW, owner: 'z' } }],
    })
    expect(verdict(f)).toEqual({ ok: true })
    const lines = checkLines(f)
    expect(lines.filter(l => l.status === 'skip').map(l => l.code)).toEqual(['role-shared', 'no-handoff', 'handoff-stale', 'stamp-unreadable', 'peer-restarting', 'race-lost'])
    expect(refusal({ ...f, agents: [{ id: 'x', status: 'running' }] })).toBe('agents-running')
    expect(refusal({ ...f, commands: [] })).toBe('no-restart-command')
  })

  test('unrun ready checks are skipped, never a pass that hides them', () => {
    const lines = checkLines(facts({ checks: null }))
    expect(lines.find(l => l.code === 'ready-check-failed')).toEqual({ code: 'ready-check-failed', status: 'skip', text: 'not run' })
    expect(checkLines(facts({ trusted: false, checks: null })).find(l => l.code === 'ready-check-failed')?.text).toBe('not run: the repo is not trusted')
  })

  test('a gather error lists the in-memory gates, then the error', () => {
    const lines = checkLines(facts({ error: 'boom' }))
    expect(lines.map(l => `${l.code}:${l.status}`)).toEqual(['untrusted:pass', 'already-busy:pass', 'not-needed:pass', 'too-soon:pass', 'no-restart-command:skip', 'error:fail'])
  })

  test('one line per code otherwise, race last and skipped', () => {
    const lines = checkLines(facts())
    expect(lines.map(l => l.code)).toEqual(REFUSAL_CODES.filter(c => c !== 'error'))
    expect(lines.at(-1)).toEqual({ code: 'race-lost', status: 'skip', text: 'judged after the stamp is written' })
  })
})

describe('the ready token', () => {
  test('the last non-blank line alone, with punctuation or markup around it', () => {
    for (const answer of ['Done.\n\nCTX-READY', 'CTX-READY', 'Done.\n`CTX-READY`\n\n  ', '**CTX-READY**', '> CTX-READY.', 'x\r\n`CTX-READY`.\r\n']) {
      expect(isReadyAnswer(answer, 'CTX-READY')).toBe(true)
    }
  })

  test('mid-line, an earlier line, a longer word or another token does not count', () => {
    for (const answer of [
      'I will say CTX-READY later',
      'CTX-READY\nbut not yet',
      'CTX-READY-NOW',
      'XCTX-READY',
      'CTX_READY',
      '',
      '\n\n',
      'ctx-ready',
    ]) {
      expect(isReadyAnswer(answer, 'CTX-READY')).toBe(false)
    }
    expect(isReadyAnswer('GO', 'GO')).toBe(true)
    expect(isReadyAnswer(42 as never, 'GO')).toBe(false)
  })

  test('regex characters in the token are literal', () => {
    expect(isReadyAnswer('A.B', 'A.B')).toBe(true)
    expect(isReadyAnswer('AxB', 'A.B')).toBe(false)
  })
})

describe('stamps, handoffs, resume', () => {
  test('stamp text round-trips; garbage is unreadable; null is absent', () => {
    expect(parseStamp(stampJson('s1', 42))).toEqual({ kind: 'ok', at: 42, owner: 's1' })
    expect(parseStamp(null)).toEqual({ kind: 'absent' })
    expect(parseStamp('12345').kind).toBe('unreadable')
    expect(parseStamp('{"at":"x","owner":"s"}').kind).toBe('unreadable')
    expect(stampPath('.ctx-guard/', 'lead')).toBe('.ctx-guard/lead.restart')
  })

  test('isUnder needs a separator after the root', () => {
    expect(isUnder('/repo', '/repo/a')).toBe(true)
    expect(isUnder('/repo/', '/repo/a')).toBe(true)
    expect(isUnder('/repo', '/repo2/a')).toBe(false)
    expect(isUnder('/repo', '/elsewhere')).toBe(false)
  })

  test('resume arguments and the failed-restart line', () => {
    expect(resumeArgs('lead', '.ctx-guard/lead-handoff.md', ' Carry on. ')).toBe('role=lead handoff=.ctx-guard/lead-handoff.md Carry on.')
    expect(resumeArgs('lead', 'h.md', null)).toBe('role=lead handoff=h.md')
  })

  test('a typed resume gets what it left out from its role; what it gave stays', () => {
    const fill = (handoff: string | null, prompt: string) => filledResumeArgs({ handoff, prompt }, 'lead', 'docs/lead-now.md', 'Check ListAgents.')
    expect(fill(null, '')).toBe('role=lead handoff=docs/lead-now.md Check ListAgents.')
    expect(fill('x.md', '')).toBe('role=lead handoff=x.md Check ListAgents.')
    expect(fill(null, 'Go on.')).toBe('role=lead handoff=docs/lead-now.md Go on.')
    expect(fill('x.md', 'Go on.')).toBe('role=lead handoff=x.md Go on.')
    expect(filledResumeArgs({ handoff: null, prompt: '' }, 'lead', 'docs/lead-now.md', null)).toBe('role=lead handoff=docs/lead-now.md')
    expect(restartFailedText('ctx-guard:resume', 'lead', 'h.md')).toBe('restart failed — type /ctx-guard:resume role=lead handoff=h.md')
  })
})

describe('pending resume after a reload', () => {
  const p = (over: Partial<PendingResume> = {}): PendingResume => ({
    role: 'lead',
    handoff: 'h.md',
    command: 'ctx-guard:resume',
    prompt: null,
    step: 'clear',
    at: NOW,
    ...over,
  })

  test('cleared and fresh: resume', () => {
    expect(pendingAction(p(), NOW + 10, NOW + MIN).kind).toBe('resume')
    expect(pendingAction(p({ step: 'resume' }), null, NOW + MIN).kind).toBe('resume')
  })

  test('cleared but stale: flag', () => {
    expect(pendingAction(p({ step: 'resume' }), null, NOW + PENDING_RESUME_MS + 1).kind).toBe('stale')
  })

  test('never cleared: dropped, nothing to resume', () => {
    expect(pendingAction(p(), NOW - 1, NOW + MIN).kind).toBe('not-cleared')
    expect(pendingAction(p(), null, NOW + MIN).kind).toBe('not-cleared')
  })

  test('stored values are checked; freshness bounds already-busy', () => {
    expect(asPendingResume(p())).toEqual(p())
    expect(asPendingResume({ ...p(), step: 'later' })).toBeNull()
    expect(asPendingResume(null)).toBeNull()
    expect(pendingFresh(p(), NOW + MIN)).toBe(true)
    expect(pendingFresh(p(), NOW + PENDING_RESUME_MS + 1)).toBe(false)
    expect(pendingFresh(null, NOW)).toBe(false)
  })
})

describe('the quiet re-check before the stamp and before /clear', () => {
  const q = { tokenAt: NOW, turnRunning: false, lastMainEndAt: NOW, agents: [], steps: [], background: [] }

  test('nothing new: go ahead', () => {
    expect(quietVerdict(q)).toEqual({ ok: true })
  })

  test('a turn running or one that ran after the token', () => {
    expect(quietVerdict({ ...q, turnRunning: true })).toEqual({ ok: false, code: 'already-busy', text: 'a turn started after the ready token' })
    expect(quietVerdict({ ...q, lastMainEndAt: NOW + 1 })).toEqual({ ok: false, code: 'already-busy', text: 'another turn ran after the ready token' })
  })

  test('agents, steps and background work, known or not', () => {
    expect(quietVerdict({ ...q, agents: [{ id: 'a', status: 'pending', description: 'x' }] }).ok ? '' : 'agents-running').toBe('agents-running')
    expect(quietVerdict({ ...q, steps: ['wf'] })).toEqual({ ok: false, code: 'agents-running', text: 'agents still running: agent wf (stepped recently) (started after the checks)' })
    expect(quietVerdict({ ...q, background: null }).ok).toBe(false)
    expect(quietVerdict({ ...q, background: [{ type: 'shell', description: 'tail' }] }).ok).toBe(false)
  })

  test('a sent resume is only flagged after a reload', () => {
    const p: PendingResume = { role: 'lead', handoff: 'h.md', command: 'c', prompt: null, step: 'sent', at: NOW }
    expect(pendingAction(p, null, NOW + 1).kind).toBe('sent')
    expect(asPendingResume(p)).toEqual(p)
  })

  test('the token match ignores non-letters around it, letters in any script count as words', () => {
    expect(isReadyAnswer('— CTX-READY ✅', 'CTX-READY')).toBe(true)
    expect(isReadyAnswer('éCTX-READY', 'CTX-READY')).toBe(false)
    expect(isReadyAnswer('CTX-READY_', 'CTX-READY')).toBe(true)
  })
})

describe('compact', () => {
  const gates = { autoActions: true, trusted: true, paused: false, untrustedWhy: 'never approved' }
  const queued: PendingCompact = { role: 'lead', triggerId: 'squeeze', step: 'queued', at: NOW, notBefore: null, waiting: null }
  const ran: LastCompact = { outcome: 'ran', source: 'squeeze', text: 'compacted', at: NOW, ranAt: NOW }

  test('the gate: auto actions, then trust, then a pause', () => {
    expect(compactGate(gates)).toBeNull()
    expect(compactGate({ ...gates, autoActions: false, trusted: false })?.code).toBe('autoActions')
    expect(compactGate({ ...gates, trusted: false, paused: true })).toEqual({
      code: 'untrusted',
      text: "this repo's automatic actions are not approved (never approved); the operator runs /ctx-guard trust",
    })
    expect(compactGate({ ...gates, paused: true })?.code).toBe('paused')
  })

  test('a request: queued, one already waiting wins, held until the quiet period after one ran', () => {
    expect(compactRequest(null, null, NOW)).toEqual({ kind: 'queue', notBefore: null })
    expect(compactRequest(queued, null, NOW)).toEqual({ kind: 'queued-already' })
    expect(compactRequest({ ...queued, step: 'blocked' }, null, NOW)).toEqual({ kind: 'queued-already' })
    expect(compactRequest(null, ran, NOW + COMPACT_QUIET_MS - 1)).toEqual({ kind: 'queue', notBefore: NOW + COMPACT_QUIET_MS })
    expect(compactRequest(null, ran, NOW + COMPACT_QUIET_MS)).toEqual({ kind: 'queue', notBefore: null })
    expect(compactRequest(null, { ...ran, outcome: 'skipped', ranAt: null }, NOW)).toEqual({ kind: 'queue', notBefore: null })
    // A clock that went back is no reason to hold off.
    expect(compactRequest(null, ran, NOW - 1)).toEqual({ kind: 'queue', notBefore: null })
  })

  test('busy work: a turn, a restart, agents and background tasks, known or not', () => {
    const q = { turnRunning: false, restart: null, agents: [], steps: [], background: [] }
    expect(compactBusy(q)).toBeNull()
    expect(compactBusy({ ...q, turnRunning: true })).toBe('a turn is running')
    expect(compactBusy({ ...q, restart: 'a restart is under way' })).toBe('a restart is under way')
    expect(compactBusy({ ...q, agents: [{ id: 'a', status: 'running', description: 'scan' }] })).toBe('agents still running: scan')
    expect(compactBusy({ ...q, steps: ['wf'] })).toBe('agents still running: agent wf (stepped recently)')
    expect(compactBusy({ ...q, background: null })).toContain('background tasks unknown')
    expect(compactBusy({ ...q, background: [{ type: 'shell', description: 'tail' }] })).toBe('background tasks still running: tail')
  })

  test('arguments, and the stored shapes read back', () => {
    expect(compactArgs('  Keep the plan.  ')).toBe('Keep the plan.')
    expect(compactArgs(null)).toBe('')
    expect(asPendingCompact(queued)).toEqual(queued)
    expect(asPendingCompact({ ...queued, step: 'done' })).toBeNull()
    expect(asPendingCompact({ ...queued, waiting: 7, notBefore: 'x' })).toEqual(queued)
    expect(asPendingCompact({ ...queued, step: 'blocked', notBefore: NOW })).toEqual({ ...queued, step: 'blocked', notBefore: NOW })
    expect(asPendingCompact('x')).toBeNull()
    expect(asLastCompact(ran)).toEqual(ran)
    expect(asLastCompact({ ...ran, outcome: 'maybe' })).toBeNull()
    expect(asLastCompact({ ...ran, ranAt: 'x' })).toEqual({ ...ran, ranAt: null })
  })

  test('the last-compact record keeps when the last one ran', () => {
    expect(nextLastCompact(null, 'ran', 'squeeze', 't', NOW)).toEqual({ outcome: 'ran', source: 'squeeze', text: 't', at: NOW, ranAt: NOW })
    expect(nextLastCompact(ran, 'skipped', 'squeeze', 'off', NOW + 1)).toEqual({ outcome: 'skipped', source: 'squeeze', text: 'off', at: NOW + 1, ranAt: NOW })
    expect(nextLastCompact(null, 'dropped', 'squeeze', 'x', NOW).ranAt).toBeNull()
  })
})

describe('ready-check output', () => {
  test('stderr wins; stdout when stderr is empty; nothing when both are', () => {
    expect(outputTail('boom\n', 'ignored')).toBe('boom')
    expect(outputTail('  \n', 'from stdout')).toBe('from stdout')
    expect(outputTail('', '')).toBe('')
    expect(outputTail(undefined, null)).toBe('')
  })

  test('one line: control characters dropped, whitespace collapsed', () => {
    expect(outputTail('a\r\n\tb\u001b[31m red\u0007\n\n', '')).toBe('a b[31m red')
  })

  test('long output keeps its end, led by an ellipsis', () => {
    const tail = outputTail(`${'x'.repeat(1000)} the end`, '')
    expect(tail.length).toBe(CHECK_TAIL_CHARS)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.endsWith('the end')).toBe(true)
  })

  test('checkDetail adds the tail to the exit code', () => {
    expect(checkDetail(1, 'uncommitted changes: M a.ts', '')).toBe('exited 1: uncommitted changes: M a.ts')
    expect(checkDetail(3, '', '')).toBe('exited 3')
  })
})
