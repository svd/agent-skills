// ctx-guard's restart guard: the ready token, the restart stamps, the facts a
// restart is judged on and the fail-closed verdict over them, the peer race,
// and what to do with a pending resume found after a reload. Pure: no `$`,
// never throws.
import type { LastCompact, PendingCompact, PendingResume, Quantity, RestartVia } from '../types'
import type { Lease } from './roles'
import { humanDuration, humanQuantity, humanTokens } from './messages'

// In the order they are checked; the first that holds refuses.
export const REFUSAL_CODES = [
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
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

export type Verdict = { ok: true } | { ok: false; code: RefusalCode; text: string }

// A pending resume older than this is not finished after a reload: the person
// has likely moved on, and a stale prompt would land in an unrelated turn.
export const PENDING_RESUME_MS = 5 * 60 * 1000
// A subagent step seen this recently, with no turn.complete since, counts as running.
export const STEP_SEEN_MS = 15 * 60 * 1000
// How long a session waits after writing its stamp before reading its peers'
// again: a peer that read the stamps just before this write has written its own by then.
export const RACE_SETTLE_MS = 1500

const BUSY_STATUSES: readonly string[] = ['pending', 'running', 'waiting']

// ---- the ready token ---------------------------------------------------------

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when the answer's last non-blank line holds the token alone, give or
 * take anything but letters and digits around it (`**CTX-READY**`,
 * `` `CTX-READY`. ``). The token inside a sentence never counts.
 */
export function isReadyAnswer(answer: unknown, token: string): boolean {
  if (typeof answer !== 'string' || token === '') return false
  const lines = answer.split(/\r?\n/).filter(l => l.trim() !== '')
  const last = lines.at(-1)
  if (last === undefined) return false
  return new RegExp(`^[^\\p{L}\\p{N}]*${escapeRegExp(token)}[^\\p{L}\\p{N}]*$`, 'u').test(last.trim())
}

// Where a prompt the person typed comes from: the prompt box, or a remote client of this session.
const TYPED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])

/**
 * A prompt the person typed: from the prompt box or a remote client, shown as
 * typed, and not /compact. A main turn it starts can end the /ctx-guard:clear ask.
 */
export function isTypedPrompt(e: { origin?: { kind: string }; command?: { name: string }; isMeta?: true }): boolean {
  return e.origin !== undefined && TYPED_ORIGINS.has(e.origin.kind) && e.isMeta !== true && e.command?.name !== 'compact'
}

// ---- stamps ------------------------------------------------------------------

// A role's last restart: when, and which lease id wrote it (the tie-break).
export type StampRead = { kind: 'absent' } | { kind: 'ok'; at: number; owner: string } | { kind: 'unreadable'; detail: string }

/** The restart stamp of `role`, relative to the root (stateDir is already confined). */
export function stampPath(stateDir: string, role: string): string {
  return `${stateDir.replace(/\/+$/, '')}/${role}.restart`
}

export function stampJson(owner: string, at: number): string {
  return `${JSON.stringify({ owner, at })}\n`
}

/** Stamp-file text → its stamp; null text is an absent file. */
export function parseStamp(text: string | null): StampRead {
  if (text === null) return { kind: 'absent' }
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>
      if (typeof o.owner === 'string' && typeof o.at === 'number' && Number.isFinite(o.at)) return { kind: 'ok', at: o.at, owner: o.owner }
    }
  } catch {
    // Falls through to unreadable.
  }
  return { kind: 'unreadable', detail: 'does not hold {"owner", "at"}' }
}

// ---- the handoff ---------------------------------------------------------------

/** True when `real` is `root` or beneath it; both already resolved. */
export function isUnder(root: string, real: string): boolean {
  const base = root.replace(/[/\\]+$/, '')
  return real === base || real.startsWith(`${base}/`) || real.startsWith(`${base}\\`)
}

// ---- facts and verdict ---------------------------------------------------------

// `why` says what is wrong with a path that is there but cannot serve (empty, not a file).
export type HandoffFact = { kind: 'absent'; path: string; why?: string } | { kind: 'present'; path: string; mtime: number }

export type CheckRun = { run: readonly string[]; ok: boolean; detail: string }

export type AgentRow = { id: string; status: string; description?: string; type?: string }

type Placed = { tokens: number; threshold: Quantity }

export type Facts = {
  via: RestartVia
  role: string
  trusted: boolean
  // What needs approval, for the untrusted text.
  untrustedWhy: string
  // Why a restart is already in progress; null when none is.
  busy: string | null
  // The context fill now (null: unknown, as right after a /clear), the role's lowest context
  // trigger threshold in tokens (null: the role has no context trigger, or one cannot be placed),
  // and its restart.minContext in tokens (null: unset or off, or it cannot be placed).
  context: { tokens: number | null; floor: Placed | null; min: Placed | null }
  // The operator asked for this restart with /ctx-guard:clear: restart.minContext is not judged.
  asked: boolean
  // When this session's last restart went through (a /clear or a /compact on the token); null before any.
  lastRestartAt: number | null
  // 0 turns the self gap off.
  selfGap: number
  command: string
  commands: readonly string[]
  agents: readonly AgentRow[]
  // Agent ids seen stepping within STEP_SEEN_MS with no turn.complete since.
  steps: readonly string[]
  // null: unknown (no Stop reported its list since the session started).
  background: readonly { type: string; description: string }[] | null
  lease: Lease
  handoff: HandoffFact
  startedAt: number
  lastClearAt: number | null
  ownStamp: StampRead
  peers: readonly { role: string; stamp: StampRead }[]
  peerGap: number
  now: number
  // null: not run (yet, or untrusted).
  checks: readonly CheckRun[] | null
  // Gathering failed; the restart cannot be judged.
  error: string | null
}

export type CheckStatus = 'pass' | 'fail' | 'skip'
export type CheckLine = { code: RefusalCode; status: CheckStatus; text: string }

const iso = (ms: number): string => new Date(ms).toISOString()

function busyAgents(agents: readonly AgentRow[], steps: readonly string[]): string[] {
  const names = agents.filter(a => BUSY_STATUSES.includes(a.status)).map(a => a.description || a.type || a.id)
  const listed = new Set(agents.map(a => a.id))
  // A workflow's agents are not listed: a recent step with no end is the only sign of them.
  for (const id of steps) if (!listed.has(id)) names.push(`agent ${id} (stepped recently)`)
  return names
}

function agentsFail(agents: readonly AgentRow[], steps: readonly string[]): string | null {
  const busy = busyAgents(agents, steps)
  return busy.length ? `agents still running: ${busy.join(', ')}` : null
}

function backgroundFail(bg: Facts['background']): string | null {
  if (bg === null) return 'background tasks unknown: no Stop has reported them since the session started'
  const names = bg.map(t => t.description || t.type)
  return names.length ? `background tasks still running: ${names.join(', ')}` : null
}

function youngPeer(f: Facts): { role: string; at: number } | null {
  for (const p of f.peers) {
    if (p.stamp.kind === 'ok' && f.now - p.stamp.at < f.peerGap) return { role: p.role, at: p.stamp.at }
  }
  return null
}

function line(code: RefusalCode, fail: string | null, pass: string): CheckLine {
  return fail === null ? { code, status: 'pass', text: pass } : { code, status: 'fail', text: fail }
}

const skip = (code: RefusalCode, text: string): CheckLine => ({ code, status: 'skip', text })

// A restart frees context: below restart.minContext there is too little to free, and a note on
// usage alone would only come back after the /clear. A restart the operator asked for is needed.
function neededLine(f: Facts): CheckLine {
  if (f.asked) return skip('not-needed', 'the operator asked for it with /ctx-guard:clear')
  const { tokens, min } = f.context
  if (min === null) return skip('not-needed', 'restart.minContext is off')
  if (tokens === null) return skip('not-needed', 'context unknown')
  const at = floorText(min)
  return line(
    'not-needed',
    tokens < min.tokens ? `context is at ${humanTokens(tokens)}, under restart.minContext ${at}: a restart frees nothing yet` : null,
    `context ${humanTokens(tokens)} is past restart.minContext ${at}`,
  )
}

const floorText = (floor: Placed): string =>
  floor.threshold.kind === 'tokens' ? humanTokens(floor.tokens) : `${humanQuantity(floor.threshold)} (${humanTokens(floor.tokens)})`

// How long after a restart a context already past the lowest threshold is worth a warning.
export const RECENT_RESTART_MS = 5 * 60 * 1000

/**
 * For `/ctx-guard check`: a restart ran moments ago and the context is already
 * at or past the role's lowest context threshold, so the next reading may note
 * and ask for another restart at once. A warning line, never a refusal.
 */
export function renoteRisk(f: Facts): string | null {
  const { tokens, floor } = f.context
  const last = f.lastRestartAt
  if (floor === null || tokens === null || last === null || tokens < floor.tokens) return null
  if (f.now - last >= Math.max(f.selfGap, RECENT_RESTART_MS)) return null
  return (
    `warning: ${humanDuration(f.now - last)} after the last restart the context (${humanTokens(tokens)}) is already past the lowest ` +
    `context threshold ${floorText(floor)}; the next note may ask for another restart at once. Raise that threshold, or load less on resume.`
  )
}

function soonLine(f: Facts): CheckLine {
  if (f.selfGap <= 0) return skip('too-soon', 'selfGap is 0: off')
  const last = f.lastRestartAt
  if (last === null) return { code: 'too-soon', status: 'pass', text: 'no restart yet in this session' }
  return line(
    'too-soon',
    f.now - last < f.selfGap ? `this session restarted ${humanDuration(f.now - last)} ago, under selfGap ${humanDuration(f.selfGap)}` : null,
    `last restart ${humanDuration(f.now - last)} ago`,
  )
}

/**
 * Every check of a restart, in order, each passed, failed or skipped, the race
 * included as skipped (it needs the stamp written). `via: compact` keeps no
 * handoff and clears nobody's context but its own, so the handoff, lease and
 * peer checks are skipped for it.
 */
export function checkLines(f: Facts): CheckLine[] {
  const out: CheckLine[] = []
  out.push(line('untrusted', f.trusted ? null : `this repo's restart settings are not approved (${f.untrustedWhy}); the operator runs /ctx-guard trust`, 'repo trusted'))
  out.push(line('already-busy', f.busy, 'no restart in progress'))
  out.push(neededLine(f))
  out.push(soonLine(f))
  if (f.error !== null) {
    out.push(skip('no-restart-command', 'not judged'))
    out.push({ code: 'error', status: 'fail', text: f.error })
    return out
  }
  const compact = f.via === 'compact'
  out.push(line('no-restart-command', f.commands.includes(f.command) ? null : `/${f.command} is not among the session's commands`, `/${f.command} found`))
  out.push(line('agents-running', agentsFail(f.agents, f.steps), 'no agent running'))
  out.push(line('background-tasks', backgroundFail(f.background), 'no background task'))
  if (compact) {
    for (const code of ['role-shared', 'no-handoff', 'handoff-stale', 'stamp-unreadable', 'peer-restarting'] as const) out.push(skip(code, 'not used by via compact'))
  } else {
    out.push(
      line(
        'role-shared',
        f.lease.kind === 'shared' ? `another live session (${f.lease.sessionId}) holds role "${f.role}"` : null,
        `role "${f.role}" lease ${f.lease.kind === 'mine' ? 'held here' : 'free'}`,
      ),
    )
    out.push(line('no-handoff', f.handoff.kind === 'absent' ? `${f.handoff.path} ${f.handoff.why ?? 'does not exist'}` : null, `${f.handoff.path} found`))
    if (f.handoff.kind === 'present') {
      const bound = Math.max(f.startedAt, f.lastClearAt ?? 0)
      out.push(
        line(
          'handoff-stale',
          f.handoff.mtime <= bound
            ? `${f.handoff.path} was written ${iso(f.handoff.mtime)}, not after ${iso(bound)} (the session start or the last /clear)`
            : null,
          `${f.handoff.path} written ${humanDuration(f.now - f.handoff.mtime)} ago`,
        ),
      )
    } else out.push(skip('handoff-stale', 'no handoff'))
    const bad = [{ role: f.role, stamp: f.ownStamp }, ...f.peers].filter(p => p.stamp.kind === 'unreadable').map(p => p.role)
    out.push(line('stamp-unreadable', bad.length ? `the restart stamp of ${bad.join(', ')} cannot be read` : null, 'stamps readable'))
    const peer = youngPeer(f)
    out.push(
      line(
        'peer-restarting',
        peer ? `the ${peer.role} session restarted ${humanDuration(f.now - peer.at)} ago, under peerGap ${humanDuration(f.peerGap)}` : null,
        f.peers.length ? `no peer restarted within ${humanDuration(f.peerGap)}` : 'no peers',
      ),
    )
  }
  if (f.checks === null) out.push(skip('ready-check-failed', f.trusted ? 'not run' : 'not run: the repo is not trusted'))
  else {
    const failed = f.checks.find(c => !c.ok)
    out.push(
      line(
        'ready-check-failed',
        failed ? `${failed.run.join(' ')}: ${failed.detail}` : null,
        f.checks.length ? `${f.checks.length} ready check${f.checks.length === 1 ? '' : 's'} passed` : 'no ready checks',
      ),
    )
  }
  out.push(skip('race-lost', compact ? 'not used by via compact' : 'judged after the stamp is written'))
  return out
}

/** The first failing check, or ok; checks that were skipped never refuse. */
export function verdict(f: Facts): Verdict {
  const failed = checkLines(f).find(l => l.status === 'fail')
  return failed ? { ok: false, code: failed.code, text: failed.text } : { ok: true }
}

/**
 * After writing the own stamp and reading the peers' again: the oldest young
 * stamp wins, a tie going to the smaller owner id, so of two sessions that
 * both got this far exactly one goes on. A peer stamp that can no longer be
 * read loses the race too.
 */
export function raceVerdict(
  own: { at: number; owner: string },
  peers: readonly { role: string; stamp: StampRead }[],
  peerGap: number,
  now: number,
): Verdict {
  for (const p of peers) {
    const s = p.stamp
    if (s.kind === 'unreadable') return { ok: false, code: 'race-lost', text: `the ${p.role} restart stamp could not be read after writing ours` }
    if (s.kind !== 'ok' || now - s.at >= peerGap) continue
    if (s.at < own.at || (s.at === own.at && s.owner < own.owner)) {
      return { ok: false, code: 'race-lost', text: `the ${p.role} session started its restart first` }
    }
  }
  return { ok: true }
}

// The session as it stands just before the stamp is written and again just
// before /clear: the ready-token turn must still be the last one, and no work
// may have started since the facts were judged.
export type Quiet = {
  // When the ready-token turn ended.
  tokenAt: number
  // A main-loop turn is running now.
  turnRunning: boolean
  lastMainEndAt: number | null
  agents: readonly AgentRow[]
  steps: readonly string[]
  background: Facts['background']
}

/** The re-check before the stamp and before /clear; existing codes, so the person reads one vocabulary. */
export function quietVerdict(q: Quiet): Verdict {
  if (q.turnRunning) return { ok: false, code: 'already-busy', text: 'a turn started after the ready token' }
  if (q.lastMainEndAt !== null && q.lastMainEndAt > q.tokenAt) return { ok: false, code: 'already-busy', text: 'another turn ran after the ready token' }
  const agents = agentsFail(q.agents, q.steps)
  if (agents) return { ok: false, code: 'agents-running', text: `${agents} (started after the checks)` }
  const bg = backgroundFail(q.background)
  if (bg) return { ok: false, code: 'background-tasks', text: bg }
  return { ok: true }
}

// ---- ready-check output --------------------------------------------------------

// Enough of a failing check's output for the model to act on, short enough for one note.
export const CHECK_TAIL_CHARS = 300

/**
 * The end of a failed check's stderr (stdout when stderr is empty) on one
 * line: control characters dropped, whitespace runs collapsed, at most
 * CHECK_TAIL_CHARS, led by "…" when cut. Empty when there was no output.
 */
export function outputTail(stderr: unknown, stdout: unknown, max = CHECK_TAIL_CHARS): string {
  const clean = (v: unknown): string =>
    (typeof v === 'string' ? v : '')
      .replace(/[\t\n\r\f\v]+/g, ' ')
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  const text = clean(stderr) || clean(stdout)
  if (text.length <= max) return text
  return `…${text.slice(text.length - (max - 1)).trimStart()}`
}

/** A check's refusal detail: its exit code, then the output tail when there is one. */
export function checkDetail(exitCode: number, stderr: unknown, stdout: unknown): string {
  const tail = outputTail(stderr, stdout)
  return tail ? `exited ${exitCode}: ${tail}` : `exited ${exitCode}`
}

// ---- resume ------------------------------------------------------------------

/** `role=<r> handoff=<path> <prompt>`, what the restart command is run with. */
export function resumeArgs(role: string, handoff: string, prompt: string | null): string {
  const p = (prompt ?? '').trim()
  return `role=${role} handoff=${handoff}${p ? ` ${p}` : ''}`
}

/**
 * A typed resume's arguments with what it left out taken from its role: the
 * handoff path and the restart prompt. What it gave stays as given, so a
 * typed `role=lead` runs as the automatic restart would.
 */
export function filledResumeArgs(typed: { handoff: string | null; prompt: string }, role: string, handoff: string, prompt: string | null): string {
  return resumeArgs(role, typed.handoff ?? handoff, typed.prompt || prompt)
}

/** The band's line after a resume that did not run. */
export function restartFailedText(command: string, role: string, handoff: string): string {
  return `restart failed — type /${command} role=${role} handoff=${handoff}`
}

export type PendingAction =
  | { kind: 'resume'; pending: PendingResume }
  | { kind: 'stale'; pending: PendingResume }
  | { kind: 'not-cleared'; pending: PendingResume }
  | { kind: 'sent'; pending: PendingResume }

/**
 * A pending resume found at session start (a reload dropped the flow): drop
 * one whose /clear never ran, since nothing was cleared; one whose resume was
 * already sent is never sent again, only flagged; finish a fresh one whose
 * /clear did run; drop a stale one and flag it for the person.
 */
export function pendingAction(p: PendingResume, lastClearAt: number | null, now: number): PendingAction {
  if (p.step === 'sent') return { kind: 'sent', pending: p }
  const cleared = p.step === 'resume' || (lastClearAt !== null && lastClearAt >= p.at)
  if (!cleared) return { kind: 'not-cleared', pending: p }
  const stale = now - p.at > PENDING_RESUME_MS || p.at > now + PENDING_RESUME_MS
  return stale ? { kind: 'stale', pending: p } : { kind: 'resume', pending: p }
}

/** A pending resume as $.state may hold it (another version may have written it); null when it is not one. */
export function asPendingResume(v: unknown): PendingResume | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.role !== 'string' || typeof o.handoff !== 'string' || typeof o.command !== 'string') return null
  if (!(o.prompt === null || typeof o.prompt === 'string')) return null
  if (o.step !== 'clear' && o.step !== 'resume' && o.step !== 'sent') return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  return { role: o.role, handoff: o.handoff, command: o.command, prompt: o.prompt, step: o.step, at: o.at }
}

/** True while a pending resume is young enough to count as a restart in progress. */
export function pendingFresh(p: PendingResume | null, now: number): boolean {
  return p !== null && now - p.at <= PENDING_RESUME_MS
}

// ---- compact -------------------------------------------------------------------

// A compact action asked for this soon after one ran is dropped: the figures
// it fired on may predate the compaction, and the marks re-arm once a fresh
// reading lands below the threshold.
export const COMPACT_QUIET_MS = 5 * 60 * 1000

export type CompactGates = { autoActions: boolean; trusted: boolean; paused: boolean; untrustedWhy: string }
export type CompactGate = { code: 'autoActions' | 'untrusted' | 'paused'; text: string }

/** Why ctx-guard may not compact on its own now, or null when it may. */
export function compactGate(g: CompactGates): CompactGate | null {
  if (!g.autoActions) return { code: 'autoActions', text: 'autoActions is off in /config' }
  if (!g.trusted) return { code: 'untrusted', text: `this repo's automatic actions are not approved (${g.untrustedWhy}); the operator runs /ctx-guard trust` }
  if (g.paused) return { code: 'paused', text: 'ctx-guard is paused' }
  return null
}

export type CompactRequest = { kind: 'queue'; notBefore: number | null } | { kind: 'queued-already' }

/**
 * A compact trigger's rising edge: queue it, or keep the one already waiting
 * (at most one compact waits). Within COMPACT_QUIET_MS of the last compact
 * that ran it is queued with `notBefore`, held until the quiet period ends;
 * a fresh reading below the threshold re-arms the trigger and drops it.
 */
export function compactRequest(pending: PendingCompact | null, last: LastCompact | null, now: number): CompactRequest {
  if (pending) return { kind: 'queued-already' }
  const ranAt = last?.ranAt ?? null
  const held = ranAt !== null && now - ranAt >= 0 && now - ranAt < COMPACT_QUIET_MS
  return { kind: 'queue', notBefore: held ? ranAt + COMPACT_QUIET_MS : null }
}

export type CompactBusy = {
  turnRunning: boolean
  // Why a restart is in progress; null when none is.
  restart: string | null
  agents: readonly AgentRow[]
  steps: readonly string[]
  background: Facts['background']
}

/** What holds a queued compact back, or null when it may run: the restart guard's busy facts. */
export function compactBusy(q: CompactBusy): string | null {
  if (q.turnRunning) return 'a turn is running'
  if (q.restart) return q.restart
  return agentsFail(q.agents, q.steps) ?? backgroundFail(q.background)
}

/** `/compact`'s arguments: the role's instructions, trimmed; none when empty. */
export function compactArgs(instructions: string | null): string {
  return (instructions ?? '').trim()
}

/** A pending compact as $.state may hold it; null when it is not one. */
export function asPendingCompact(v: unknown): PendingCompact | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.role !== 'string' || typeof o.triggerId !== 'string') return null
  if (o.step !== 'queued' && o.step !== 'sent' && o.step !== 'blocked') return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  const notBefore = typeof o.notBefore === 'number' && Number.isFinite(o.notBefore) ? o.notBefore : null
  return { role: o.role, triggerId: o.triggerId, step: o.step, at: o.at, notBefore, waiting: typeof o.waiting === 'string' ? o.waiting : null }
}

const OUTCOMES: readonly LastCompact['outcome'][] = ['ran', 'failed', 'skipped', 'held', 'dropped']

/** The last compact as $.state may hold it; null when it is not one. */
export function asLastCompact(v: unknown): LastCompact | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!OUTCOMES.includes(o.outcome as LastCompact['outcome'])) return null
  if (typeof o.source !== 'string' || typeof o.text !== 'string') return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  const ranAt = typeof o.ranAt === 'number' && Number.isFinite(o.ranAt) ? o.ranAt : null
  return { outcome: o.outcome as LastCompact['outcome'], source: o.source, text: o.text, at: o.at, ranAt }
}

/** The next last-compact record: `ranAt` moves only when this one ran. */
export function nextLastCompact(prev: LastCompact | null, outcome: LastCompact['outcome'], source: string, text: string, now: number): LastCompact {
  return { outcome, source, text, at: now, ranAt: outcome === 'ran' ? now : (prev?.ranAt ?? null) }
}
