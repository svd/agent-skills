import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import {
  NOW,
  ROOT,
  newWorld,
  world,
  writeConfig,
  start,
  measure,
  step,
  ctxGuard,
  notes,
  LEAD_SOFT,
  stepBottom,
  run,
  turn,
  MIN,
  RACE_SETTLE_MS,
  STATE,
  HANDOFF,
  RESUME,
  RESTART_COMMANDS,
  autoConfig,
  restartWorld,
  writeHandoff,
  ready,
  refusals,
  armed,
  PEEK_RESTART,
  peekRestart,
  KEEP,
  compactConfig,
  compactArmed,
  mainTurnEnd,
  status,
} from './register.fixtures'
import type { World } from './register.fixtures'

// ---- restart: ready token → clear + resume ----------------------------------

// The band's context figure, as ctx-guard last drew it.
async function bandTokens($: Engine): Promise<number | null> {
  return ((await peekRestart($)).band as { tokens: number | null } | null)?.tokens ?? null
}

test('the band follows main-loop steps mid-turn, not only gate crossings', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  let stepTokens = 120_000
  stepBottom(on, () => stepTokens)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 100_000)
  expect(await bandTokens($)).toBe(100_000)
  await step($, clock)
  expect(await bandTokens($)).toBe(120_000)
  // No gate between 120k and 150k (the soft note is at 300k): the band moves all the same.
  stepTokens = 150_000
  await step($, clock)
  expect(await bandTokens($)).toBe(150_000)
  // A step that leaves the shown figure as it reads ("150k") does not redraw.
  stepTokens = 150_200
  await step($, clock)
  expect(await bandTokens($)).toBe(150_000)
  // A subagent's step never moves the main band.
  stepTokens = 200_000
  await step($, clock, 'sub-1')
  expect(await bandTokens($)).toBe(150_000)
  expect(notes(session)).toEqual([])
})

test('a trusted ready token: pendingResume, then /clear, then the resume, then cleared', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 1000, 'ctx-guard:resume': 1000 } })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual(['clear'])
  expect((await peekRestart($)).pendingResume?.step).toBe('clear')
  await clock.advance(1000)
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).pendingResume?.step).toBe('sent')
  await clock.advance(1000)
  expect(refusals(session)).toEqual([])
  const after = await peekRestart($)
  expect(after.pendingResume).toBeNull()
  expect(after.lastVerdict?.code).toBe('ok')
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}')).toEqual({ owner: 's1', at: clock.now() - RACE_SETTLE_MS - 2000 })
  expect(await ctxGuard($, '')).toContain('last verdict: ok')
})

test('a ready token mid-line or on an earlier line does nothing', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await ready($, clock, 'I will end with CTX-READY once done.')
  await ready($, clock, 'CTX-READY\nnot yet')
  expect(w.ran).toEqual([])
  expect(refusals(session)).toEqual([])
  await ready($, clock, 'Done.\n`CTX-READY`.')
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a subagent answer or an interrupted turn ending on the token does nothing', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'sub-1' })
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('manual mode never clears', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, autoConfig({ mode: 'manual' }))
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(refusals(session)).toEqual([])
})

test('autoActions off never clears', { options: { autoActions: false } }, async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual([])
})

test('a pause holds the restart back', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await ctxGuard($, 'pause 10m')
  await ready($, clock)
  expect(w.ran).toEqual([])
})

test('untrusted: refused, never clears, never runs a ready check; the note asks for the operator', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await writeHandoff(w, clock)
  await measure($, w, 310_000)
  expect(notes(session)[0]).toContain("tell the operator 'ready for /clear'")
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(w.processes).toEqual([])
  expect(refusals(session)[0]).toContain('CTX-READY ignored (untrusted)')
  expect(refusals(session)[0]).toContain('Nothing was cleared.')
  const report = await ctxGuard($, '')
  expect(report).toContain('trust: not approved (needs approval: *.readyToken, *.stateDir, lead.handoff, lead.restart,')
  // No compact settings: nothing of them to approve.
  expect(report).not.toContain('lead.compact')
  expect(report).toContain('last verdict: untrusted')
  expect(await ctxGuard($, 'check')).toContain('--   ready-check-failed: not run: the repo is not trusted')
  expect(w.processes).toEqual([])
})

test('trust is the operator\'s, and any change to a trusted field withdraws it', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  expect(await ctxGuard($, 'trust', 'plugin')).toContain('only the operator can run /ctx-guard trust')
  expect(await ctxGuard($, '')).toContain('trust: approved')
  await clock.advance(1000)
  writeConfig(w, autoConfig({ readyChecks: [{ run: ['./other.sh'] }] }))
  await measure($, w, 100_000)
  expect(await ctxGuard($, '')).toContain('trust: not approved (needs approval: lead.restart)')
  expect(await ctxGuard($, '')).toContain('; automatic clear, compact, ping, prompt, lift prompts and ready checks stay off until')
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(refusals(session)[0]).toContain('(untrusted)')
  // A change outside the trusted fields keeps it.
  await ctxGuard($, 'trust')
  await clock.advance(1000)
  writeConfig(w, { ...autoConfig({ readyChecks: [{ run: ['./other.sh'] }] }), readyToken: 'CTX-READY' })
  await measure($, w, 100_000)
  expect(await ctxGuard($, '')).toContain('trust: approved')
})

test('a role with nothing automatic needs no trust: the report says so and the band shows none', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld()
  world(on, w, { CTX_GUARD_ROLE: 'main' })
  await start($)
  expect(await ctxGuard($, '')).toContain('trust: not needed (nothing automatic: no auto restart, compact, ping or prompt trigger, lift prompt, or probe)')
  expect((await peekRestart($)).band?.untrusted ?? null).toBeNull()
})

test('trust off withdraws the approval, and the band says so until the next trust', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  expect((await peekRestart($)).band?.untrusted).toBeNull()
  expect(await ctxGuard($, 'trust off', 'plugin')).toContain('only the operator can run /ctx-guard trust off')
  expect(await ctxGuard($, '')).toContain('trust: approved')
  expect(await ctxGuard($, 'trust off')).toContain('trust withdrawn for /repo')
  expect(await ctxGuard($, '')).toContain('trust: not approved')
  expect((await peekRestart($)).band?.untrusted).toBe('untrusted')
  await ready($, clock)
  expect(w.ran).toEqual([])
  expect(refusals(session)[0]).toContain('(untrusted)')
  expect(await ctxGuard($, 'trust off')).toContain('/repo has no approval to withdraw')
  await ctxGuard($, 'trust')
  expect((await peekRestart($)).band?.untrusted).toBeNull()
})

test('already-busy: a second token while the restart runs', async ($, on) => {
  const w = restartWorld({ hang: { clear: 30_000 } })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  await ready($, clock)
  expect(refusals(session).map(r => r.includes('(already-busy)'))).toEqual([true])
  await clock.advance(30_000)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('no-restart-command', async ($, on) => {
  const w = restartWorld({ commands: [{ name: 'clear', source: 'builtin' }] })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain("(no-restart-command): /ctx-guard:resume is not among the session's commands")
  expect(w.ran).toEqual([])
})

test('agents-running: a listed agent', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'review the diff', type: 'general-purpose' }] })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: review the diff')
  expect(w.ran).toEqual([])
})

test('agents-running: an unlisted agent seen stepping, until its turn completes', async ($, on) => {
  const w = restartWorld()
  stepBottom(on, () => 20_000)
  const { clock, session } = await armed($, on, w)
  await step($, clock, 'wf-1')
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: agent wf-1 (stepped recently)')
  await $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'wf-1' })
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('background-tasks from the last Stop', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await ready($, clock, undefined, [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }])
  expect(refusals(session)[0]).toContain('(background-tasks): background tasks still running: npm run watch')
  // A Stop with no list is unknown, not empty.
  await ready($, clock, undefined, 'none')
  expect(refusals(session)[1]).toContain('(background-tasks): background tasks unknown')
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('role-shared: another live session holds the lease; one warning toast', async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/lead.owner`] = { text: JSON.stringify({ sessionId: 'other', heartbeat: NOW }), mtimeMs: NOW }
  const { clock, session } = await armed($, on, w)
  await measure($, w, 310_000)
  await clock.advance(6 * MIN)
  await measure($, w, 310_000)
  expect(w.toasts.filter(t => t.includes('another live session (other) holds role "lead"')).length).toBe(1)
  expect(JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}').sessionId).toBe('other')
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(role-shared): another live session (other) holds role')
  expect(await ctxGuard($, '')).toContain('lease: held by another live session (other')
  expect(w.ran).toEqual([])
})

test('the lease: written on start, beaten by the band timer and on measure, released at the end but not on /clear', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  const owner = () => JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}')
  expect(owner()).toEqual({ sessionId: 's1', heartbeat: NOW })
  // No measure at all: the 5-minute band timer beats.
  await clock.advance(4 * MIN)
  expect(owner().heartbeat).toBe(NOW + 5 * MIN)
  await clock.advance(5 * MIN)
  await measure($, w, 100_000)
  expect(owner().heartbeat).toBe(NOW + 10 * MIN)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  expect(owner().heartbeat).toBe(clock.now())
  expect(await ctxGuard($, '')).toContain('lease: held by this session')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's2', resume: {} as never })
  expect(owner().heartbeat).toBe(0)
})

test('no-handoff', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig())
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff): .ctx-guard/lead-handoff.md does not exist')
})

test('handoff-stale: written before the session start, or before the last /clear', async ($, on) => {
  const w = restartWorld()
  w.files[HANDOFF] = { text: '# old\n', mtimeMs: NOW - 1 }
  writeConfig(w, autoConfig())
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'trust')
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(handoff-stale)')
  await writeHandoff(w, clock)
  await clock.advance(MIN)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await ready($, clock)
  expect(refusals(session)[1]).toContain('(handoff-stale)')
  expect(w.ran).toEqual([])
})

test('stamp-unreadable', async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/reviewer.restart`] = { text: 'garbage', mtimeMs: NOW }
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(stamp-unreadable): the restart stamp of reviewer cannot be read')
})

test('peer-restarting: a peer stamp younger than peerGap', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'other', at: clock.now() - 4 * MIN }), mtimeMs: NOW }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(peer-restarting): the reviewer session restarted 4m ago, under peerGap 10m')
  await clock.advance(6 * MIN)
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('ready-check-failed: a non-zero exit or a timeout; exit 0 passes', async ($, on) => {
  const w = restartWorld({ exitCode: 3, stderr: 'clean-worktree: uncommitted changes:\n M src/a.ts\n' })
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh', '--strict'], timeout: '10s' }] }))
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(ready-check-failed): ./ready.sh --strict: exited 3: clean-worktree: uncommitted changes: M src/a.ts')
  w.exitCode = 'timeout'
  await ready($, clock)
  expect(refusals(session)[1]).toContain('(ready-check-failed): ./ready.sh --strict: did not finish within 10s')
  w.exitCode = 0
  await ready($, clock)
  expect(w.processes).toEqual([
    ['./ready.sh', '--strict'],
    ['./ready.sh', '--strict'],
    ['./ready.sh', '--strict'],
  ])
  expect(w.ran).toEqual(['clear', RESUME])
})

test('race-lost: a peer stamp written first; the own stamp is put back', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.onWrite = path => {
    if (path !== `${STATE}/lead.restart` || w.files[`${STATE}/reviewer.restart`]) return
    w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'other', at: clock.now() - 1 }), mtimeMs: clock.now() }
  }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(race-lost): the reviewer session started its restart first')
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(0)
  expect(w.ran).toEqual([])
})

test('error: a handoff that is a symlink out of the root', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.links[HANDOFF] = '/elsewhere/secret.md'
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): handoff path .ctx-guard/lead-handoff.md resolves outside the project root')
  expect(w.ran).toEqual([])
})

test('error: a state folder that is a symlink out of the root', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.links[STATE] = '/tmp/elsewhere'
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): stateDir .ctx-guard resolves outside the project root')
  expect(w.ran).toEqual([])
})

test('error: /clear refused puts the stamp back and clears pendingResume', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ failCommand: 'clear' })
  const { clock, session } = await armed($, on, w)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): /clear was refused')
  expect((await peekRestart($)).pendingResume).toBeNull()
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(0)
})

test('a resume that fails after /clear flags the band', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ failCommand: 'ctx-guard:resume' })
  writeConfig(w, autoConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  await ctxGuard($, 'trust')
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
  const failed = 'restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md'
  expect((await peekRestart($)).band?.restartFailed).toBe(failed)
  expect(w.statuses.at(-1)).toContain(failed)
  expect((await peekRestart($)).pendingResume).toBeNull()
  // Typing the resume by hand clears the flag.
  w.failCommand = null
  await $.command.run({ command: 'ctx-guard:resume', args: 'role=lead handoff=.ctx-guard/lead-handoff.md', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  expect((await peekRestart($)).band?.restartFailed).toBeNull()
})

test('a reload during /clear: the next session start finishes the resume once', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60_000 } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect((await peekRestart($)).pendingResume?.step).toBe('clear')
  // The clear goes through, then the module reloads before the old timer resumes.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await start($)
  await clock.settle()
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).pendingResume).toBeNull()
  await clock.advance(60_000)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a pending resume too old to finish is dropped and flagged', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60 * MIN } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await clock.advance(6 * MIN)
  await start($)
  await clock.settle()
  expect(w.ran).toEqual(['clear'])
  const after = await peekRestart($)
  expect(after.pendingResume).toBeNull()
  expect(after.band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
  expect(w.toasts.some(t => t.includes('too old to finish'))).toBe(true)
})

test('a pending resume whose /clear never ran is dropped: nothing was cleared', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60 * MIN } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  await start($)
  await clock.settle()
  expect(w.ran).toEqual(['clear'])
  expect((await peekRestart($)).pendingResume).toBeNull()
  expect(w.toasts.some(t => t.includes('nothing was cleared'))).toBe(true)
})

test('instructions naming a skill: the note keeps the configured path, the restart resumes from it', async ($, on) => {
  const w = restartWorld()
  const instructions = 'Write it with the session-handoff skill (project slug `ctx-guard-{role}`), then copy the result to this path.'
  const { clock, session } = await armed($, on, w, autoConfig({}, { instructions }))
  await measure($, w, 100_000)
  await measure($, w, 310_000)
  expect(notes(session).at(-1)).toContain(
    'write the handoff to `.ctx-guard/lead-handoff.md`: Write it with the session-handoff skill (project slug `ctx-guard-lead`), then copy the result to this path.',
  )
  await ready($, clock)
  expect(w.ran).toEqual(['clear', 'ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md Carry on.'])
})

test('/ctx-guard check: each check, a dry run that writes, races and clears nothing', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  const files = Object.keys(w.files).sort()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(await ctxGuard($, 'check', 'plugin')).toContain('only the operator can run /ctx-guard check')
  expect(w.processes).toEqual([])
  const ok = await ctxGuard($, 'check')
  expect(ok).toContain('ctx-guard check (dry run, role lead, via clear; nothing written or cleared):')
  expect(ok).toContain('ok   untrusted: repo trusted')
  expect(ok).toContain('ok   no-handoff: .ctx-guard/lead-handoff.md found')
  expect(ok).toContain('ok   ready-check-failed: 1 ready check passed')
  expect(ok).toContain('--   race-lost: judged after the stamp is written')
  expect(ok).toContain('verdict: would restart')
  expect(w.processes).toEqual([['./ready.sh']])
  expect(w.ran).toEqual([])
  expect(Object.keys(w.files).sort()).toEqual(files)
  w.agents = [{ id: 'a1', status: 'waiting', description: 'scan', type: 'Explore' }]
  delete w.files[HANDOFF]
  const refused = await ctxGuard($, 'check')
  expect(refused).toContain('FAIL agents-running: agents still running: scan')
  expect(refused).toContain('FAIL no-handoff: .ctx-guard/lead-handoff.md does not exist')
  expect(refused).toContain('verdict: refused (agents-running)')
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('/ctx-guard check with no role, and in manual mode', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig({ mode: 'manual' }))
  world(on, w)
  await start($)
  expect(await ctxGuard($, 'check')).toBe('ctx-guard check: no role, so no restart to check')
  await ctxGuard($, 'role lead')
  expect(await ctxGuard($, 'check')).toContain('note: the ready token is not acted on now (restart mode is manual)')
})

test('a typed resume claims its role for a session with none; a different held role is refused', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig())
  world(on, w)
  await start($)
  const run = (args: string, kind: 'composer' | 'plugin' = 'composer') =>
    $.command.run({ command: 'ctx-guard:resume', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })
  await run('role=lead handoff=.ctx-guard/lead-handoff.md Carry on.')
  expect(w.ran).toEqual(['ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md Carry on.'])
  expect(await ctxGuard($, '')).toContain('role: lead (from /ctx-guard:resume or a restart command, set ')
  const refused = await run('role=reviewer handoff=x.md')
  expect(refused.text).toContain('/ctx-guard:resume refused: this session holds role "lead"')
  expect(w.ran.length).toBe(1)
  // Not typed by the person: no claim and no refusal.
  await run('role=reviewer handoff=x.md', 'plugin')
  expect(w.ran.length).toBe(2)
  expect(await ctxGuard($, '')).toContain('role: lead (from /ctx-guard:resume or a restart command, set ')
  expect((await run('role=Bad!')).text).toContain('bad arguments')
  expect((await run('role=ghost')).text).toContain('refused')
})

test('a typed resume with only role= gets its role\'s handoff path and restart prompt', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig({ prompt: 'Check ListAgents first.' }, { path: 'docs/handoff/{role}-now.md' }))
  world(on, w)
  await start($)
  const run = (args: string, kind: 'composer' | 'plugin' = 'composer') =>
    $.command.run({ command: 'ctx-guard:resume', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })
  await run('role=lead')
  await run('role=lead handoff=x.md')
  await run('role=lead Go on.')
  await run('role=lead handoff=x.md Go on.')
  // Not typed by the person: passed on as it came.
  await run('role=lead', 'plugin')
  expect(w.ran).toEqual([
    'ctx-guard:resume role=lead handoff=docs/handoff/lead-now.md Check ListAgents first.',
    'ctx-guard:resume role=lead handoff=x.md Check ListAgents first.',
    'ctx-guard:resume role=lead handoff=docs/handoff/lead-now.md Go on.',
    'ctx-guard:resume role=lead handoff=x.md Go on.',
    'ctx-guard:resume role=lead',
  ])
})

test('a typed resume with no role= takes the session\'s role; with none it is refused', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig({ prompt: 'Check ListAgents first.' }, { path: 'docs/handoff/{role}-now.md' }))
  world(on, w)
  await start($)
  const run = (args: string) =>
    $.command.run({ command: 'ctx-guard:resume', args, origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  expect((await run('')).text).toContain('/ctx-guard:resume refused: name a role with role=<role>: this session has none. Nothing ran.')
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, 'role lead')).toContain('role is now lead')
  await run('')
  await run('Go on.')
  await run('handoff=x.md')
  expect(w.ran).toEqual([
    'ctx-guard:resume role=lead handoff=docs/handoff/lead-now.md Check ListAgents first.',
    'ctx-guard:resume role=lead handoff=docs/handoff/lead-now.md Go on.',
    'ctx-guard:resume role=lead handoff=x.md Check ListAgents first.',
  ])
})

// ---- /ctx-guard:clear: the operator asks for the restart -------------------

const CLEAR_COMMANDS: World['commands'] = [...RESTART_COMMANDS, { name: 'ctx-guard:clear', source: 'plugin', plugin: 'ctx-guard' }]
const CLEAR_TAIL =
  'At the next safe point — no subagents running, current work recorded — write the handoff to `.ctx-guard/lead-handoff.md`: ' +
  'Sections: Goal, State, Next action. Then end your reply with a line holding only `CTX-READY`.'
const CLEAR_NOTE = `[ctx-guard] The operator asked for a restart with /ctx-guard:clear. Stop: dispatch nothing new and start no new work. ${CLEAR_TAIL}`

const clearRun = ($: Engine, args = '', kind = 'composer') =>
  $.command.run({ command: 'ctx-guard:clear', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })

test('a typed /ctx-guard:clear sends the restart tail a context note carries; the token then restarts as usual', async ($, on) => {
  const w = restartWorld({ commands: CLEAR_COMMANDS })
  const { clock, session } = await armed($, on, w)
  await clearRun($)
  await clearRun($, 'Commit the test first.')
  expect(w.ran).toEqual([`ctx-guard:clear ${CLEAR_NOTE}`, `ctx-guard:clear ${CLEAR_NOTE}\n\nCommit the test first.`])
  // The 300k trigger's note, re-armed now the repo is trusted, ends with the same tail.
  await measure($, w, 250_000)
  await measure($, w, 320_000)
  expect(notes(session).at(-1)).toEndWith(`${JSON.stringify(CLEAR_TAIL).slice(1, -1)}"}]`)
  await ready($, clock)
  expect(w.ran.slice(2)).toEqual(['clear', RESUME])
})

test('/ctx-guard:clear lets the token past restart.minContext until the operator speaks again', async ($, on) => {
  const w = restartWorld({ commands: CLEAR_COMMANDS, tokens: 100_000 })
  const { clock, session } = await armed($, on, w, autoConfig({ minContext: '200k' }))
  await measure($, w, 100_000)
  // Any other input of the operator's ends the ask: the token meets restart.minContext again.
  await clearRun($)
  await $.prompt.submit({ text: 'Not yet.', origin: { kind: 'composer' } } as never)
  await ready($, clock)
  expect(refusals(session).at(-1)).toContain('CTX-READY ignored (not-needed): context is at 100k, under restart.minContext 200k')
  expect(w.ran).toEqual([`ctx-guard:clear ${CLEAR_NOTE}`])
  await clearRun($)
  await ready($, clock)
  expect(w.ran.slice(1)).toEqual([`ctx-guard:clear ${CLEAR_NOTE}`, 'clear', RESUME])
})

test('/ctx-guard:clear not typed by the person is refused and runs nothing', async ($, on) => {
  const w = restartWorld({ commands: CLEAR_COMMANDS })
  await armed($, on, w)
  for (const kind of ['plugin', 'peer', 'sdk']) {
    expect((await clearRun($, '', kind)).text).toBe(
      '[ctx-guard] /ctx-guard:clear refused: only the operator can run it, typed in the prompt box. Nothing ran.',
    )
  }
  expect(w.ran).toEqual([])
})

test('/ctx-guard:clear with no role or restart off is refused; untrusted, the note asks the operator to clear', async ($, on) => {
  const w = restartWorld({ commands: CLEAR_COMMANDS })
  writeConfig(w, { ...autoConfig(), roles: { ...autoConfig().roles, quiet: { restart: { mode: 'off' } } } })
  world(on, w)
  await start($)
  expect((await clearRun($)).text).toBe(
    '[ctx-guard] /ctx-guard:clear refused: this session has no role; set one with /ctx-guard role <name>. Nothing ran.',
  )
  await ctxGuard($, 'role quiet')
  expect((await clearRun($)).text).toBe('[ctx-guard] /ctx-guard:clear refused: restart.mode is off for role "quiet". Nothing ran.')
  expect(w.ran).toEqual([])
  await ctxGuard($, 'role lead')
  await clearRun($)
  expect(w.ran.length).toBe(1)
  expect(w.ran[0]).toEndWith("Sections: Goal, State, Next action. Then tell the operator 'ready for /clear'.")
  expect(w.ran[0]).not.toContain('CTX-READY')
})

test('a typed resume with no role= takes a role from CTX_GUARD_ROLE too', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig())
  world(on, w, { CTX_GUARD_ROLE: 'reviewer' })
  await start($)
  await $.command.run({ command: 'ctx-guard:resume', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.ran).toEqual(['ctx-guard:resume role=reviewer handoff=.ctx-guard/reviewer-handoff.md'])
})

test('a typed restart command claims its role; another role refuses and the command does not run', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, { version: 1, roles: { lead: { restart: { command: 'restart-lead' } }, design: { restart: { command: 'restart-design' } } } })
  world(on, w)
  await start($)
  const run = (command: string, kind: 'composer' | 'plugin' = 'composer') =>
    $.command.run({ command, args: '', origin: { kind } as never, presentation: { isFullscreen: false, columns: 120 } })
  await run('restart-lead')
  expect(w.ran).toEqual(['restart-lead'])
  expect(await ctxGuard($, '')).toContain('role: lead (from /ctx-guard:resume or a restart command, set ')
  // The same role passes.
  await run('restart-lead')
  expect(w.ran.length).toBe(2)
  const refused = await run('restart-design')
  expect(refused.text).toContain('/restart-design refused: this session holds role "lead"')
  expect(w.ran.length).toBe(2)
  // Not typed by the person: no claim and no refusal.
  await run('restart-design', 'plugin')
  expect(w.ran.length).toBe(3)
  expect(await ctxGuard($, '')).toContain('role: lead (')
  // Any other command is left alone.
  await run('commit')
  expect(w.ran.length).toBe(4)
})

test('the report shows trust, the last verdict, the handoff age and the lease owner', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  await clock.advance(2 * MIN)
  const report = await ctxGuard($, '')
  expect(report).toContain('trust: approved 3m ago')
  expect(report).toContain('last verdict: none')
  expect(report).toContain('handoff: .ctx-guard/lead-handoff.md, written 2m ago')
  expect(report).toContain('lease: held by this session, heartbeat 3m ago')
  expect(report).toContain('restart: auto')
})

// ---- restart: review follow-ups -------------------------------------------------

async function tokenTurn($: Engine, clock: MockClock): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
}

test('a turn started between the token and /clear refuses, and the stamp is put back', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await tokenTurn($, clock)
  // The flow waits out the race's settle period; the person types meanwhile.
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(RACE_SETTLE_MS)
  expect(refusals(session)[0]).toContain('(already-busy): a turn started after the ready token')
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(0)
  expect(w.ran).toEqual([])
})

test('a whole turn run between the token and /clear refuses', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await tokenTurn($, clock)
  await clock.advance(500)
  await $.turn.start({ text: 'status?', turnId: 't2' })
  await $.turn.complete({ answer: 'All good.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(RACE_SETTLE_MS)
  expect(refusals(session)[0]).toContain('(already-busy): another turn ran after the ready token')
  expect(w.ran).toEqual([])
})

test('an agent started during the ready checks refuses at the re-check', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  w.onProcess = () => {
    w.agents = [{ id: 'a9', status: 'running', description: 'late dispatch', type: 'Explore' }]
  }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: late dispatch (started after the checks)')
  expect(w.ran).toEqual([])
})

test('race: a peer that wrote its stamp while our checks ran wins; we put ours back', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  // The peer passed its own checks first and wrote its stamp before ours.
  w.onProcess = () => {
    w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'peer', at: clock.now() }), mtimeMs: clock.now() }
  }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(race-lost): the reviewer session started its restart first')
  expect(w.ran).toEqual([])
})

test('race: a peer stamp newer than ours that lands in the settle period loses to us', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.onWrite = path => {
    if (path !== `${STATE}/lead.restart` || w.files[`${STATE}/reviewer.restart`]) return
    w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'peer', at: clock.now() + 700 }), mtimeMs: clock.now() }
  }
  await ready($, clock)
  expect(refusals(session)).toEqual([])
  expect(w.ran).toEqual(['clear', RESUME])
})

test('busy work survives a reload: a running background task and a stepping agent still refuse', async ($, on) => {
  const w = restartWorld()
  stepBottom(on, () => 20_000)
  const { clock, session } = await armed($, on, w)
  await step($, clock, 'wf-1')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }] })
  await start($)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(refusals(session)[0]).toContain('(agents-running): agents still running: agent wf-1 (stepped recently)')
  await $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'wf-1' })
  await start($)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(refusals(session)[1]).toContain('(background-tasks): background tasks still running: npm run watch')
  expect(w.ran).toEqual([])
})

test('background tasks never reported are unknown: refused', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  await $.turn.complete({ answer: 'CTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(refusals(session)[0]).toContain('(background-tasks): background tasks unknown')
})

test('error: a missing handoff whose parent folder is a symlink out of the root', async ($, on) => {
  const w = restartWorld()
  w.links[`${ROOT}/notes`] = '/elsewhere/notes'
  const { clock, session } = await armed($, on, w, autoConfig({}, { path: 'notes/{role}.md' }))
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(error): handoff path notes/lead.md resolves outside the project root')
})

test('no-handoff: an empty handoff file does not count', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w)
  w.files[HANDOFF] = { text: '', mtimeMs: clock.now() }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff): .ctx-guard/lead-handoff.md is empty')
})

test('a garbage owner file counts as free and is taken over', async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/lead.owner`] = { text: 'not json', mtimeMs: NOW }
  const { clock, session } = await armed($, on, w)
  expect(JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}').sessionId).toBe('s1')
  expect(w.toasts.some(t => t.includes('another live session'))).toBe(false)
  await ready($, clock)
  expect(refusals(session)).toEqual([])
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a reload while the resume is being sent flags the band and never sends it twice', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { 'ctx-guard:resume': 60_000 } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).pendingResume?.step).toBe('sent')
  await start($)
  await clock.settle()
  const after = await peekRestart($)
  expect(after.pendingResume).toBeNull()
  expect(after.band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
  await clock.advance(60_000)
  expect(w.ran).toEqual(['clear', RESUME])
  expect((await peekRestart($)).band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
})

test('trust reads the files again and prints every approved field; a script under the root is hashed', async ($, on) => {
  const w = restartWorld()
  w.files[`${ROOT}/ready.sh`] = { text: '#!/bin/sh\ngit diff --quiet\n', mtimeMs: NOW }
  writeConfig(w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }, { run: ['git', 'diff', '--quiet'] }] }))
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  // Edited on disk with no measure since: trust approves what the file holds now.
  await clock.advance(1000)
  writeConfig(w, autoConfig({ prompt: 'Go on.', readyChecks: [{ run: ['./ready.sh'] }, { run: ['git', 'diff', '--quiet'] }] }))
  const text = await ctxGuard($, 'trust')
  for (const want of [
    'all roles: readyToken "CTX-READY", stateDir ".ctx-guard"',
    'restart: mode auto, via clear, command /ctx-guard:resume, prompt "Go on.", peers ["reviewer"], peerGap 10m',
    'ready check: ["./ready.sh"], timeout 30s (content hashed: ./ready.sh)',
    'ready check: ["git","diff","--quiet"], timeout 30s (no file under the project root: trusted by name only)',
    'handoff: path ".ctx-guard/{role}-handoff.md"',
    'Trusting a ready check trusts what its script does',
  ]) {
    expect(text).toContain(want)
  }
  // No compact settings: no line for them.
  expect(text).not.toContain('compact')
  expect(text).not.toContain('style')
  expect(await ctxGuard($, '')).toContain('trust: approved')
  // Editing the script withdraws the approval at the next restart, the config files untouched.
  w.files[`${ROOT}/ready.sh`] = { text: '#!/bin/sh\nrm -rf /\n', mtimeMs: clock.now() }
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(untrusted): this repo\'s restart settings are not approved (changed since approval: script:./ready.sh)')
  expect(w.processes).toEqual([])
  expect(await ctxGuard($, '')).toContain('trust: not approved (needs approval: script:./ready.sh)')
})

test('a script passed as an argument is hashed too', async ($, on) => {
  const w = restartWorld()
  w.files[`${ROOT}/scripts/check.sh`] = { text: 'exit 0\n', mtimeMs: NOW }
  const { clock, session } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['bash', 'scripts/check.sh', '--fast'] }] }))
  w.files[`${ROOT}/scripts/check.sh`] = { text: 'exit 1\n', mtimeMs: clock.now() }
  await ready($, clock)
  expect(refusals(session)[0]).toContain('changed since approval: script:scripts/check.sh')
  expect(w.processes).toEqual([])
})

test('a reload during the settle period puts the own stamp back', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld()
  w.files[`${STATE}/lead.restart`] = { text: JSON.stringify({ owner: 's1', at: NOW - 60 * MIN }), mtimeMs: NOW }
  const before = w.files[`${STATE}/lead.restart`]?.text
  const { clock } = await armed($, on, w)
  await tokenTurn($, clock)
  expect(JSON.parse(w.files[`${STATE}/lead.restart`]?.text ?? '{}').at).toBe(clock.now())
  await start($)
  expect(w.files[`${STATE}/lead.restart`]?.text).toBe(before)
  await clock.advance(RACE_SETTLE_MS)
  expect(w.ran).toEqual([])
})

test('a dropped restart whose queued /clear lands late flags the band', { plugins: [PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60 * MIN } })
  const { clock } = await armed($, on, w)
  await ready($, clock)
  await start($)
  await clock.settle()
  expect((await peekRestart($)).band?.restartFailed ?? null).toBeNull()
  // The old copy's /clear runs after all.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  expect((await peekRestart($)).band?.restartFailed).toBe('restart failed — type /ctx-guard:resume role=lead handoff=.ctx-guard/lead-handoff.md')
  expect(w.toasts.some(t => t.includes("the interrupted restart's /clear ran after all"))).toBe(true)
})

// ---- compact: the compact action and restart via compact ---------------------

const COMPACTED = `compact ${KEEP}`

// Restart via compact, with a note trigger the world's 310k is past, so the ready token has context to free.
function viaCompact() {
  const config = compactConfig({ mode: 'auto', via: 'compact' })
  config.roles.lead.triggers = [...config.roles.lead.triggers, { id: 'soft', when: { context: '300k' }, do: ['note'] }]
  return config
}

test('compact action: fires once at the threshold with the role\'s instructions, never clears', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 800_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  await measure($, w, 870_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  expect(w.toasts).toContain('ctx-guard: compacting lead (trigger "squeeze")')
  expect(await ctxGuard($, '')).toContain('last compact: ran 0s ago (squeeze): compacted by trigger "squeeze"')
})

test('compact action: no instructions runs a bare /compact', async ($, on) => {
  const w = restartWorld()
  const config = compactConfig()
  delete (config.roles.lead as Record<string, unknown>).compact
  const { clock } = await compactArmed($, on, w, config)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual(['compact'])
})

test('compact action: queued while a turn runs, run at its end', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('queued compact: queued for trigger "squeeze" (lead), 0s ago')
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
  expect(await ctxGuard($, '')).not.toContain('queued compact:')
})

test('compact action: busy work keeps it queued with one toast; the next quiet turn end runs it', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  const waits = (): string[] => w.toasts.filter(t => t.includes('waits (agents still running: scan)'))
  expect(waits().length).toBe(1)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(waits().length).toBe(1)
  expect(await ctxGuard($, '')).toContain('waiting: agents still running: scan')
  w.agents = []
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }] })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(w.ran).toEqual([])
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a queued compact whose figures fall back is dropped with a toast', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 500_000)
  expect(w.toasts.some(t => t.includes('the queued /compact for trigger "squeeze" was dropped: trigger "squeeze" re-armed'))).toBe(true)
  w.agents = []
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('last compact: dropped')
})

test('compact action: a /clear drops a queued compact', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('last compact: dropped 0s ago (squeeze): a /clear came first')
})

test('compact action: untrusted, it is skipped with one toast and a report line', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 500_000)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts.filter(t => t.includes('/compact for trigger "squeeze" skipped')).length).toBe(1)
  expect(w.toasts.find(t => t.includes('skipped'))).toContain("this repo's automatic actions are not approved (never approved)")
  expect(await ctxGuard($, '')).toContain('last compact: skipped 0s ago (squeeze)')
})

test('compact action: autoActions off skips it', { options: { autoActions: false } }, async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('skipped: autoActions is off in /config'))).toBe(true)
})

test('compact action: a pause skips it', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await ctxGuard($, 'pause 10m')
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(w.toasts.some(t => t.includes('skipped: ctx-guard is paused'))).toBe(true)
})

test('compact action: a pause that starts while it is queued skips it at the turn end', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ctxGuard($, 'pause 10m')
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('last compact: skipped')
})

test('compact action: a queued compact survives a reload and runs at the next turn end', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await start($)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('queued compact: queued for trigger "squeeze"')
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: queued while idle across a reload, the session start runs it', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  w.agents = []
  await start($)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a reload while /compact runs never sends it twice', async ($, on) => {
  const w = restartWorld({ hang: { compact: 60_000 } })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  await start($)
  await mainTurnEnd($, clock)
  await clock.advance(60_000)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
  // The old copy's compact still counts as the last that ran.
  expect(await ctxGuard($, '')).toContain('last compact: ran')
})

test('compact action: right after one ran, a new edge is held; a fresh reading below drops it', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  // A fresh reading below the threshold re-arms; a stale one past it right after is held, not run.
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  const report = await ctxGuard($, '')
  expect(report).toContain('last compact: held 0s ago (squeeze)')
  expect(report).toContain('queued compact: queued for trigger "squeeze" (lead), 0s ago; waiting: held until 5m after the last compact')
  await measure($, w, 200_000)
  await clock.advance(6 * MIN)
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a held compact runs once the quiet period ends, across a reload too', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await clock.advance(MIN)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
  await start($)
  await clock.settle()
  await clock.advance(3 * MIN)
  expect(w.ran).toEqual([COMPACTED])
  await clock.advance(MIN + 1000)
  expect(w.ran).toEqual([COMPACTED, COMPACTED])
})

test('compact action: when the hold ends, the engine\'s own figures decide; a stale edge is dropped and re-armed', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  // No reading since: the engine knows nothing yet, so nothing runs.
  w.tokens = undefined
  await clock.advance(6 * MIN)
  expect(w.ran).toEqual([COMPACTED])
  expect(w.toasts.some(t => t.includes('dropped: no reading since the last compact'))).toBe(true)
  // The mark re-armed: a real crossing fires again.
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED, COMPACTED])
})

test('compact action: a held edge whose context is below the threshold by the hold\'s end is dropped', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  w.tokens = 300_000
  await clock.advance(6 * MIN)
  expect(w.ran).toEqual([COMPACTED])
  expect(w.toasts.some(t => t.includes('dropped: the context since the last compact is below the threshold'))).toBe(true)
})

test('compact action: a hold timer is set again when ctx-guard is turned off and on', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  await measure($, w, 200_000)
  await measure($, w, 860_000)
  await clock.advance(MIN)
  writeConfig(w, { ...compactConfig(), enabled: false })
  await measure($, w, 860_000)
  await clock.advance(MIN)
  writeConfig(w, compactConfig())
  await measure($, w, 860_000)
  await clock.settle()
  await clock.advance(4 * MIN)
  expect(w.ran).toEqual([COMPACTED, COMPACTED])
})

test('via compact: a failed /compact does not retry the queued compact at once', async ($, on) => {
  const w = restartWorld({ failCommand: 'compact' })
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  await clock.settle()
  expect(refusals(session)[0]).toContain('/compact was refused')
  expect(w.ran).toEqual([COMPACTED])
  expect(await ctxGuard($, '')).toContain('queued compact: queued for trigger "squeeze"')
})

test('compact action: a refused ready token at the same turn end lets the queued compact run', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', prompt: 'Carry on.' }))
  delete w.files[HANDOFF]
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(no-handoff)')
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: skipped while untrusted, it runs once the operator approves the repo', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  expect(await ctxGuard($, '')).toContain('queued compact: blocked for trigger "squeeze"')
  await ctxGuard($, 'trust')
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: skipped while paused, it runs when the pause is lifted', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await ctxGuard($, 'pause 10m')
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.ran).toEqual([])
  await ctxGuard($, 'pause off')
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: skipped while paused, it runs once the pause runs out', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w)
  await ctxGuard($, 'pause 10m')
  await measure($, w, 860_000)
  await clock.settle()
  await clock.advance(9 * MIN)
  expect(w.ran).toEqual([])
  await clock.advance(2 * MIN)
  await clock.settle()
  expect(w.ran).toEqual([COMPACTED])
})

test('compact action: a blocked compact whose figures fall back is dropped, not run after approval', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await measure($, w, 860_000)
  await measure($, w, 500_000)
  await ctxGuard($, 'trust')
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('race: a compact and a ready-token restart in the same tick never both run (compact first)', async ($, on) => {
  const w = restartWorld({ hang: { compact: 30_000 } })
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', prompt: 'Carry on.' }))
  await measure($, w, 860_000)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(already-busy): a /compact of this session is under way')
  await clock.advance(30_000)
  expect(w.ran).toEqual([COMPACTED])
})

test('race: a compact and a ready-token restart in the same tick never both run (restart first)', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w, compactConfig({ mode: 'auto', prompt: 'Carry on.' }))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ answer: 'Done.\n\nCTX-READY', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await measure($, w, 860_000)
  await clock.settle()
  await clock.advance(RACE_SETTLE_MS)
  await clock.settle()
  expect(w.ran).toEqual(['clear', RESUME])
})

test('compact action: a failed /compact toasts and is reported', async ($, on) => {
  const w = restartWorld({ failCommand: 'compact' })
  const { clock } = await compactArmed($, on, w)
  await measure($, w, 860_000)
  await clock.settle()
  expect(w.toasts.some(t => t.includes('/compact for trigger "squeeze" did not run:'))).toBe(true)
  expect(await ctxGuard($, '')).toContain('last compact: failed')
})

test('compact action: a ready-token restart at the same turn end goes first', async ($, on) => {
  const w = restartWorld()
  const config = compactConfig({ mode: 'auto', prompt: 'Carry on.' })
  const { clock } = await compactArmed($, on, w, config)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  expect(w.ran).toEqual(['clear', RESUME])
})

test('via compact: runs /compact with the instructions, no clear or resume; handoff, peer and lease are not checked', async ($, on) => {
  const w = restartWorld()
  const { clock, session } = await armed($, on, w, viaCompact())
  delete w.files[HANDOFF]
  w.files[`${STATE}/reviewer.restart`] = { text: JSON.stringify({ owner: 'other', at: clock.now() }), mtimeMs: clock.now() }
  w.files[`${STATE}/lead.owner`] = { text: JSON.stringify({ sessionId: 'other', heartbeat: clock.now() }), mtimeMs: clock.now() }
  await ready($, clock)
  expect(refusals(session)).toEqual([])
  expect(w.ran).toEqual([COMPACTED])
  expect(w.files[`${STATE}/lead.restart`]).toBeUndefined()
  const report = await ctxGuard($, '')
  expect(report).toContain('last verdict: ok')
  expect(report).toContain('(ready token): compacted on the ready token')
})

test('via compact: already-busy while the compact runs; the refusal says nothing was compacted', async ($, on) => {
  const w = restartWorld({ hang: { compact: 30_000 } })
  const { clock, session } = await armed($, on, w, viaCompact())
  await ready($, clock)
  await ready($, clock)
  expect(refusals(session).length).toBe(1)
  expect(refusals(session)[0]).toContain('CTX-READY ignored (already-busy): a /compact of this session is under way. Nothing was compacted.')
  await clock.advance(30_000)
  expect(w.ran).toEqual([COMPACTED])
})

test('via compact: a compact action in flight makes the ready token already-busy', async ($, on) => {
  const w = restartWorld({ hang: { compact: 30_000 } })
  const { clock, session } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await measure($, w, 860_000)
  await clock.settle()
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(already-busy)')
  await clock.advance(30_000)
  expect(w.ran).toEqual([COMPACTED])
})

test('via compact: refused while an agent runs or untrusted, and a refused /compact is an error', async ($, on) => {
  const w = restartWorld({ agents: [{ id: 'a1', status: 'running', description: 'scan', type: 'Explore' }] })
  const { clock, session } = await armed($, on, w, viaCompact())
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(agents-running)')
  w.agents = []
  w.failCommand = 'compact'
  await ready($, clock)
  expect(refusals(session)[1]).toMatch(/\(error\): \/compact was refused: .*\. Nothing was compacted\./)
  expect(w.ran).toEqual([COMPACTED])
})

test('via compact: untrusted refuses', async ($, on) => {
  const w = restartWorld()
  writeConfig(w, compactConfig({ mode: 'auto', via: 'compact' }))
  const { clock, session } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('(untrusted)')
  expect(w.ran).toEqual([])
})

test('via compact: a compact the trigger queued is served by the ready token\'s', async ($, on) => {
  const w = restartWorld()
  const { clock } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
})

test('/ctx-guard check via compact skips the handoff, lease and peer checks', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w, viaCompact())
  delete w.files[HANDOFF]
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  const out = await ctxGuard($, 'check')
  expect(out).toContain('ctx-guard check (dry run, role lead, via compact; nothing written or cleared):')
  expect(out).toContain('ok   no-restart-command: /compact found')
  expect(out).toContain('--   no-handoff: not used by via compact')
  expect(out).toContain('--   role-shared: not used by via compact')
  expect(out).toContain('--   peer-restarting: not used by via compact')
  expect(out).toContain('verdict: would restart')
  await clock.settle()
  expect(w.ran).toEqual([])
})

test('via compact: a reload while it runs never sends a second /compact for the queued trigger', async ($, on) => {
  const w = restartWorld({ hang: { compact: 60_000 } })
  const { clock } = await compactArmed($, on, w, compactConfig({ mode: 'auto', via: 'compact' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, w, 860_000)
  await ready($, clock)
  expect(w.ran).toEqual([COMPACTED])
  await start($)
  await mainTurnEnd($, clock)
  await clock.advance(60_000)
  await mainTurnEnd($, clock)
  expect(w.ran).toEqual([COMPACTED])
  expect(await ctxGuard($, '')).toContain('last compact: ran')
})
