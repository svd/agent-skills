// ctx-guard's type contract: the shared config shapes the pure modules pass
// around, and the `$.state` values the hooks keep. Every stored value is JSON;
// an absent figure or an unset key is null, never undefined.

// ---- quantities ------------------------------------------------------------

export type QuantityKind = 'tokens' | 'percent' | 'duration' | 'usd' | 'count'

// `value` is a token count, a percentage (0-100], milliseconds, US dollars, or a whole count.
export type Quantity = { kind: QuantityKind; value: number }

// ---- config (normalized: every key present, defaults filled in) -------------

export type Level = 'soft' | 'hard' | 'stop'

export type EdgeAction = 'note' | 'toast' | 'notify' | 'compact' | 'ping' | 'prompt'
export type DenyAction = { deny: string[] }
export type Action = EdgeAction | DenyAction

export type Metric =
  | 'context'
  | 'limit.five_hour'
  | 'limit.seven_day'
  | 'limit.any'
  | 'limit.five_hour.resetsIn'
  | 'limit.seven_day.resetsIn'
  | 'cost'
  | 'idle'
  | 'cache.expiresIn'
  | 'cache.miss'
  | 'cache.pings'

// An AND of metrics; a null metric is not part of the trigger. `every` steps
// the trigger's one context, limit or cost metric past its first threshold.
// A `.resetsIn` metric (time left to that window's reset, at least) comes
// only with the same window's percent metric.
export type TriggerWhen = {
  context: Quantity | null
  'limit.five_hour': Quantity | null
  'limit.seven_day': Quantity | null
  'limit.any': Quantity | null
  'limit.five_hour.resetsIn': Quantity | null
  'limit.seven_day.resetsIn': Quantity | null
  cost: Quantity | null
  idle: Quantity | null
  // Time left before the main thread's prompt cache expires; holds at or below its threshold.
  'cache.expiresIn': Quantity | null
  // Tokens the latest main request rewrote although the cache was expected warm.
  'cache.miss': Quantity | null
  // Warm pings in the current idle period.
  'cache.pings': Quantity | null
  every: Quantity | null
  // The metric `every` steps; its kind is that metric's kind.
  everyMetric: Metric | null
}

// What a brake's lift does: tell the model, tell the operator, or wake the session.
export type LiftAction = 'note' | 'toast' | 'notify' | 'prompt'

// The falling edge of a trigger's deny. `times` caps the wake attempts between
// two operator inputs (set with `prompt` only); `message` replaces the default
// lift note and wake prompt.
export type TriggerLift = { do: LiftAction[]; times: number | null; message: string | null }

export type Trigger = {
  id: string
  when: TriggerWhen
  do: Action[]
  level: Level | null
  message: string | null
  // At most this many fires per idle period; null is no cap.
  times: number | null
  // What runs when the trigger's deny lets go; null is nothing.
  lift: TriggerLift | null
}

export type RestartMode = 'auto' | 'manual' | 'off'
export type RestartVia = 'clear' | 'compact'

export type ReadyCheck = { run: string[]; timeout: number }

// A script whose output is a band segment; `every` and `timeout` in ms.
export type BandProbeSpec = { id: string; run: string[]; every: number; timeout: number }

// When the band shows the cache countdown: within a duration or a percent of the TTL, always, or never.
export type CacheShow = Quantity | 'always' | 'off'

export type CacheConfig = {
  // 'auto' detects the TTL; a number (ms) is 300000 or 3600000.
  ttl: 'auto' | number
  band: { show: CacheShow; warn: Quantity }
  // No ping while any usage window is at or above this percent.
  ping: { maxUsage: number }
  // No prompt from a trigger on a cache metric while any usage window is at or above this percent.
  prompt: { maxUsage: number }
}

export type RoleSpec = {
  description: string | null
  triggers: Trigger[]
  notes: { suffix: string | null }
  // `path` is relative to the root and may hold `{role}`; so may `instructions`.
  handoff: { path: string; instructions: string | null }
  restart: {
    mode: RestartMode
    via: RestartVia
    command: string
    prompt: string | null
    peers: string[]
    peerGap: number
    // How soon after its own last restart this session may restart again; 0 is no gap.
    selfGap: number
    // Below this context fill the ready token is refused (not-needed); null is no such check.
    minContext: Quantity | null
    readyChecks: ReadyCheck[]
  }
  compact: { instructions: string | null }
}

// One `subagents` entry: token budgets, "off" for no such step, null for
// unset (a type then inherits the "*" entry's value).
export type SubagentBudget = { warn: number | 'off' | null; stop: number | 'off' | null; message: string | null }

// A type's entry merged over "*": what a subagent runs under. `type` is the
// entry that matched ("*" when the type has none); a null step is no step.
export type Budget = { type: string; warn: number | null; stop: number | null; message: string | null }

export type Config = {
  version: 1
  enabled: boolean
  stateDir: string
  readyToken: string
  defaultRole: string | null
  contextWindow: number | 'auto'
  defaults: RoleSpec
  // Effective specs: `defaults` already merged under each role.
  roles: { [name: string]: RoleSpec }
  subagents: { [type: string]: SubagentBudget }
  // Probes shared by every role; empty when none.
  band: { probes: BandProbeSpec[] }
  cache: CacheConfig
}

export type Display = 'band' | 'status' | 'off'

// The machine-wide `userConfig` switches, normalized.
export type Switches = {
  enabled: boolean
  configPath: string
  defaultRole: string | null
  blocking: boolean
  autoActions: boolean
  noteToasts: boolean
  display: Display
}

export type ConfigSource = 'files' | 'last-good' | 'built-in'

// ---- $.state values ----------------------------------------------------------

export type BandLimit = { kind: string; percentUsed: number; resetsAt: string | null }

// A band probe's segment as last drawn; `color` is a theme key, null for the default.
export type BandProbe = { id: string; text: string; color: string | null }

export type TtlSource = 'config' | 'transcript' | 'observed' | 'guess'

// The main thread's prompt cache, as last observed.
export type CacheState = {
  // The session the record belongs to; null after /clear until a main request reads the new id.
  sessionId: string | null
  // Detected TTL in ms and where it came from; null until detected (a guess is not stored).
  ttl: number | null
  ttlSource: TtlSource | null
  // The transcript was read for the TTL (or could not be): not again until /clear or a new session.
  transcriptTried: boolean
  // When the main prefix was last written or read: the latest main request or warm ping; null when unknown.
  anchor: number | null
  // The previous main request's fill (input + cache read + cache write); null after a start-over.
  prevFill: number | null
  // A main request read at least 90 % of the previous fill since the last start-over.
  warmSeen: boolean
  model: string | null
  // The latest main request's miss in tokens (0 below the floor) and its cause.
  miss: number
  missCause: 'model' | 'prefix' | null
  // Warm pings in the current idle period; the period's ping found the cache gone.
  pings: number
  cold: boolean
  // The cold verdict is the latest news: the countdown reads 0 until the next main request rewrites the prefix.
  coldShown: boolean
  // Fires per trigger id in the current idle period, for `times`.
  fired: { [triggerId: string]: number }
  // When a keep-warm ping's fork started; null once it settled. A module copy after a reload honours it until the ping's timeout.
  pingAt: number | null
}

// The band's cache segment as last drawn; `color` is a theme key, null for the default.
export type BandCache = { text: string; color: string | null; dim: boolean }

export type Band = {
  role: string | null
  tokens: number | null
  percent: number | null
  window: number | null
  // The prompt cache countdown as last drawn; null when hidden.
  cache: BandCache | null
  limits: BandLimit[]
  // Band probe segments in config order, as last drawn.
  probes: BandProbe[]
  subagentsOver: number
  denies: string[]
  restartFailed: string | null
  // `untrusted` while settings that need /ctx-guard trust wait for it; null otherwise.
  untrusted: string | null
  now: number
}

// The operator's /ctx-guard:clear: when it ran and the session's role then.
export type ClearAsk = { at: number; role: string }

// One trigger's rising-edge mark: the highest `every` step fired (0 is the
// first threshold) and when.
export type Mark = { step: number; at: number }

export type Marks = { role: string | null; byId: { [triggerId: string]: Mark } }

// A hold's phase: its condition holds; it let go but another brake still denies
// one of its tools; it lifted and its actions or wake are being decided; or its
// lift checks failed and it waits for new figures or a reset.
export type HoldPhase = 'holding' | 'waiting' | 'lifting' | 'stalled'

// A trigger with `lift` whose deny holds (or held). The stamps (`startedAt`,
// `touchedAt`, `notedAt`) outlive a check and a stall.
export type Hold = {
  tools: string[]
  // The trigger's `when` as canonical JSON: a reload that changes it drops the hold.
  when: string
  startedAt: number
  // The last refused call of one of its tools, or the step that read its note.
  touchedAt: number | null
  // When the trigger's rising-edge note was appended.
  notedAt: number | null
  phase: HoldPhase
  // Tries of the lift check under way; above 0 the attempt is already charged.
  tries: number
  // The window `limit.any` read while it held, for the lift's reason.
  window: string | null
  // When it lifted (phase lifting), and what let it go, in words.
  liftedAt: number | null
  reason: string | null
  // Its lift's non-prompt actions already ran, and when its lift note went (a lift seen mid-turn).
  ran: boolean
  liftNotedAt: number | null
  // Stalled: the usage report count it stalled on, and the earliest reset it waits for.
  stall: { reports: number; until: number | null } | null
}

// The wake prompt the lift check let through, waiting for an idle tick or a
// retry: its trigger, its text, the submit tries so far and when it lifted.
export type LiftPending = { triggerId: string; text: string; tries: number; at: number }

// The lifts of a role: holds by trigger id, triggers whose lift ran on
// estimated figures, the lift check's fork start, wake attempts since the last
// operator input, the pending wake prompt, the last operator input and how
// many usage reports have come (a stall waits for the next).
export type Lifts = {
  role: string | null
  holds: { [triggerId: string]: Hold }
  estimatedLift: string[]
  forkAt: number | null
  attempts: { [triggerId: string]: number }
  pending: LiftPending | null
  operatorAt: number | null
  reports: number
}

// A role claimed by `/ctx-guard role` or `/ctx-guard:resume role=`; a null
// role is an explicit "none".
export type RoleClaim = { role: string | null; source: 'command' | 'resume'; at: number }

export type ConfigFile = { path: string; mtime: number | null }

export type ConfigState = {
  // The last good config, kept across reloads as the fallback for a bad file.
  lastGood: Config | null
  source: ConfigSource
  errors: string[]
  files: ConfigFile[]
  loadedAt: number
}

// A restart under way: written before /clear (`step: 'clear'`), moved to
// `resume` once it ran and to `sent` just before the resume command is run,
// cleared after it. A reload in between finishes a `clear`/`resume` one at the
// next session start; a `sent` one is only flagged, never sent twice.
export type PendingResume = {
  role: string
  handoff: string
  command: string
  prompt: string | null
  step: 'clear' | 'resume' | 'sent'
  at: number
}

// A compact a trigger asked for, waiting for a main-loop turn end with no busy
// work: `queued` until it is sent, `sent` while /compact runs, `blocked` while
// auto actions are off, the repo is untrusted or ctx-guard is paused (it is
// queued again once that lifts, as long as its trigger is still marked).
// `notBefore` holds it until the quiet period after the last compact ends;
// `waiting` says what held it back at the last try (null before any).
export type PendingCompact = {
  role: string
  triggerId: string
  step: 'queued' | 'sent' | 'blocked'
  at: number
  notBefore: number | null
  waiting: string | null
}

// The last compact ctx-guard ran, held back or gave up on, and why; `source` is the
// trigger id or `ready token`. `ranAt` is the last one that ran, kept across
// later outcomes: no compact action runs again soon after it.
export type LastCompact = {
  outcome: 'ran' | 'failed' | 'skipped' | 'held' | 'dropped'
  source: string
  text: string
  at: number
  ranAt: number | null
}

export type Pause = { until: number }

// The last ready-token verdict: a refusal code, or `ok` for a restart that went ahead.
export type LastVerdict = { code: string; text: string; at: number }

// This session's role lease: the id it writes into owner files and restart
// stamps (kept across /clear, which changes the session id, and reloads), the
// role it holds, its last heartbeat, and who else held the role at the last look.
export type LeaseState = {
  id: string
  role: string | null
  beatAt: number | null
  sharedWith: string | null
}

// The newest main-loop context fill and when it was read; tokens null is unknown (after /clear).
export type MainReading = { tokens: number | null; at: number }

export type Activity = {
  // When the last main-loop turn ended; null before the first. Idle counts from it.
  lastMainEndAt: number | null
  // When the running turn started, a subagent's start included; null between turns.
  mainTurnAt: number | null
  // When the running main-loop turn itself started; null between main turns.
  mainStartAt: number | null
  // When the last closing main turn started: one on a prompt the person typed that ended on an
  // answer with no ready token. Written at its end; a turn whose start is unknown is none.
  lastClosingStartAt: number | null
  // The running main turn is ctx-guard's own prompt: idle keeps counting through it.
  ownTurn: boolean
  // The running main turn answers a prompt the person typed (composer or bridge, not /compact).
  typedTurn: boolean
  // The running own turn is a lift's wake prompt: idle does not grow during it.
  wokenTurn: boolean
  // When the last woken turn ended; idle counts from the later of this and lastMainEndAt.
  lastWokenEndAt: number | null
  // When the last main-loop turn of any kind ended (the operator's, a prompt's, a wake's).
  lastTurnEndAt: number | null
  // Newer than `$.session.usage()` can be mid-turn, so evaluations off a step read it first.
  lastMain: MainReading | null
  // One-time notices already toasted (version, collision, a role problem), so a reload does not repeat them.
  shown: string[]
}

export type BackgroundTask = { type: string; description: string }

// Work the restart guard must see finished, kept across reloads: subagent ids
// seen stepping (and when) with no turn.complete since, and what the last
// Stop listed as in flight (null until a Stop reported a list).
export type Work = {
  steps: { [agentId: string]: number }
  background: BackgroundTask[] | null
}

// How an agent was started: a plain subagent (a workflow's included), a fork
// of its parent, or a teammate. Forks and teammates get a budget only from an
// entry that names them.
export type AgentKind = 'agent' | 'fork' | 'teammate'

// An agent as `agent.spawn` started it: its type and kind, and when.
export type SpawnedAgent = { type: string; kind: AgentKind; at: number }

// A subagent past a budget step, kept across reloads so a stop's deny is not
// lifted by one: its type and kind, its fill and the step and budget at that
// time, and when it was last written.
export type SubagentMark = { type: string; kind: AgentKind; tokens: number; step: 'warn' | 'stop'; warn: number | null; stop: number | null; at: number }

// The own restart stamp while a restart has written it but not yet reached
// /clear: where, what it replaced, and its own value, so a session start after
// a reload in between puts the old one back instead of holding peers off.
export type HeldStamp = { path: string; previous: string | null; at: number; owner: string; peerGap: number }

declare module 'claude-code' {
  interface PluginState {
    'ctx-guard': {
      band: Band | null
      marks: Marks | null
      roleClaim: RoleClaim | null
      config: ConfigState | null
      pendingResume: PendingResume | null
      pendingCompact: PendingCompact | null
      lastCompact: LastCompact | null
      pause: Pause | null
      // When this session last cleared: a handoff must be newer to count.
      lastClearAt: number | null
      // When this session's last restart on the ready token went through: none follows within selfGap.
      lastRestartAt: number | null
      // The operator's last /ctx-guard:clear in auto mode, and the role it was for. It holds until
      // the first main turn after it ends, a /clear (ctx-guard's restart or the operator's), or a role change.
      clearAsk: ClearAsk | null
      lastVerdict: LastVerdict | null
      lease: LeaseState | null
      work: Work | null
      // Subagents past their warn or stop budget, by agent id; dropped at their turn.complete.
      subagents: { [agentId: string]: SubagentMark } | null
      // Agents started through agent.spawn, by id: only these (and ones `$.agent.list` names) are budgeted.
      spawned: { [agentId: string]: SpawnedAgent } | null
      stamp: HeldStamp | null
      activity: Activity | null
      // The main thread's prompt cache: TTL, anchor, misses and this idle period's pings and fire counts.
      cache: CacheState | null
      // Brakes with `lift`: their holds, the wake attempts and the pending wake prompt.
      lifts: Lifts | null
    }
  }
}
