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

export type Metric = 'context' | 'limit.five_hour' | 'limit.seven_day' | 'limit.any' | 'cost' | 'idle'

// An AND of metrics; a null metric is not part of the trigger. `every` steps
// the trigger's one context, limit or cost metric past its first threshold.
export type TriggerWhen = {
  context: Quantity | null
  'limit.five_hour': Quantity | null
  'limit.seven_day': Quantity | null
  'limit.any': Quantity | null
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

export type HandoffStyle = 'file' | 'session-handoff'
export type RestartMode = 'auto' | 'manual' | 'off'
export type RestartVia = 'clear' | 'compact'

export type ReadyCheck = { run: string[]; timeout: number }

export type RoleSpec = {
  description: string | null
  triggers: Trigger[]
  notes: { suffix: string | null }
  // `path` is relative to the root and may hold `{role}`.
  handoff: { path: string; style: HandoffStyle; instructions: string | null }
  restart: {
    mode: RestartMode
    via: RestartVia
    command: string
    prompt: string | null
    peers: string[]
    peerGap: number
    readyChecks: ReadyCheck[]
  }
  compact: { instructions: string | null }
}

// Token budgets; null leaves that step out.
export type SubagentBudget = { warn: number | null; stop: number | null; message: string | null }

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
      pause: Pause | null
      // When this session last cleared: a handoff must be newer to count.
      lastClearAt: number | null
      lastVerdict: LastVerdict | null
      lease: LeaseState | null
      work: Work | null
      stamp: HeldStamp | null
      activity: Activity | null
    }
  }
}
