// ctx-guard's type contract: the shared config shapes the pure modules pass
// around, and the `$.state` values the hooks keep. Every stored value is JSON;
// an absent figure or an unset key is null, never undefined.

// ---- quantities ------------------------------------------------------------

export type QuantityKind = 'tokens' | 'percent' | 'duration' | 'usd'

// `value` is a token count, a percentage (0-100], milliseconds, or US dollars.
export type Quantity = { kind: QuantityKind; value: number }

// ---- config (normalized: every key present, defaults filled in) -------------

export type Level = 'soft' | 'hard' | 'stop'

export type EdgeAction = 'note' | 'toast' | 'notify' | 'compact'
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
  every: Quantity | null
  // The metric `every` steps; its kind is that metric's kind.
  everyMetric: Metric | null
}

export type Trigger = {
  id: string
  when: TriggerWhen
  do: Action[]
  level: Level | null
  message: string | null
}

export type RestartMode = 'auto' | 'manual' | 'off'
export type RestartVia = 'clear' | 'compact'

export type ReadyCheck = { run: string[]; timeout: number }

// A script whose output is a band segment; `every` and `timeout` in ms.
export type BandProbeSpec = { id: string; run: string[]; every: number; timeout: number }

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
}

export type Display = 'band' | 'status' | 'off'

// The machine-wide `userConfig` switches, normalized.
export type Switches = {
  enabled: boolean
  configPath: string
  defaultRole: string | null
  blocking: boolean
  autoActions: boolean
  display: Display
}

export type ConfigSource = 'files' | 'last-good' | 'built-in'

// ---- $.state values ----------------------------------------------------------

export type BandLimit = { kind: string; percentUsed: number; resetsAt: string | null }

// A band probe's segment as last drawn; `color` is a theme key, null for the default.
export type BandProbe = { id: string; text: string; color: string | null }

export type Band = {
  role: string | null
  tokens: number | null
  percent: number | null
  window: number | null
  limits: BandLimit[]
  subagentsOver: number
  denies: string[]
  restartFailed: string | null
  now: number
}

// One trigger's rising-edge mark: the highest `every` step fired (0 is the
// first threshold) and when.
export type Mark = { step: number; at: number }

export type Marks = { role: string | null; byId: { [triggerId: string]: Mark } }

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
  // When the running main-loop turn started; null between turns.
  mainTurnAt: number | null
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
      lastVerdict: LastVerdict | null
      lease: LeaseState | null
      work: Work | null
      // Subagents past their warn or stop budget, by agent id; dropped at their turn.complete.
      subagents: { [agentId: string]: SubagentMark } | null
      // Agents started through agent.spawn, by id: only these (and ones `$.agent.list` names) are budgeted.
      spawned: { [agentId: string]: SpawnedAgent } | null
      stamp: HeldStamp | null
      activity: Activity | null
    }
  }
}
