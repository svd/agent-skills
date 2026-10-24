// Hook wiring of ctx-guard. Decisions live in the pure modules beside this file;
// this module only reads the engine's figures and acts on their verdicts.
// Hooks never throw: every piece of I/O is wrapped, and a failure leaves the
// session as it would be without ctx-guard.
import type { CommandRunInput, CommandRunResult, EngineInterface, FsStat, PromptSubmitInput, PromptSubmitResult, RenderSurface, Timer, TurnCompleteInput, TurnStepResult, TurnUsage } from 'claude-code'
import type { PluginState, Register } from 'claude-code'

import type {
  Activity,
  AgentKind,
  BackgroundTask,
  Band,
  BandCache,
  BandProbe,
  BandProbeSpec,
  CacheConfig,
  CacheState,
  Config,
  HeldStamp,
  Hold,
  ConfigFile,
  ClearAsk,
  ConfigState,
  LastCompact,
  LeaseState,
  LiftPending,
  Lifts,
  MainReading,
  Marks,
  Pause,
  PendingCompact,
  PendingResume,
  RoleSpec,
  SpawnedAgent,
  SubagentMark,
  Switches,
  Trigger,
  TtlSource,
  Work,
} from '../types'
import { bandLags, bandOf, bandSegments, bandText, sameBand, untrustedText } from './band'
import { asCache, cacheSegment, effectiveTtl, emptyCache, expiresInMs, newPeriod, onMainRequest, onPing, pingVerdict, startOver, ttlFromTranscript, withTtl } from './cache'
import {
  ARGUMENT_HINT,
  INIT_TRUST_HINT,
  MIN_VERSION,
  USAGE,
  checkText,
  collidingCommand,
  gitignoreWith,
  isPaused,
  parseCommand,
  parsePause,
  reportText,
  presetPath,
  presetProblem,
  wantsTrust,
  versionBelow,
  wakeLine,
  wakePlan,
  wakeSetText,
} from './commands'
import type { CacheReport, Preset, RestartReport, SubagentReport } from './commands'
import {
  DEFAULT_CACHE,
  DEFAULT_SELF_GAP,
  DEFAULT_SWITCHES,
  asConfigState,
  asTrustRecord,
  builtInConfig,
  canonicalJson,
  checkScripts,
  confinePath,
  effectiveConfig,
  liftHas,
  localPathFor,
  num,
  onCacheMetric,
  readSwitches,
  resolveWindow,
  roleSpec,
  sha256Hex,
  subagentBudget,
  trustFields,
  trustHash,
  trustKey,
  trustState,
} from './config'
import type { Effective, EngineWindow, FileLayer, ScriptHashes, TrustRecord, TrustState, WindowInfo } from './config'
import {
  NOT_ACTIVE,
  NOT_WOKEN,
  PREFIX,
  clearNoteText,
  collapseNotes,
  denyReason,
  effectiveMode,
  handoffPathFor,
  humanDuration,
  humanQuantity,
  isOwnPrompt,
  liftCheckFailedText,
  liftNoteText,
  liftReason,
  liftNotifyText,
  liftToastText,
  noteToastText,
  promptText,
  refusalNote,
  subagentDenyReason,
  subagentStopText,
  subagentWarnText,
  toastText,
  wakeCancelledText,
  wakePromptText,
  manualWakeText,
} from './messages'
import type { LiftInput, NoteContext, NotWoken } from './messages'
import {
  COMPACT_QUIET_MS,
  RACE_SETTLE_MS,
  STEP_SEEN_MS,
  asLastCompact,
  asPendingCompact,
  asPendingResume,
  checkDetail,
  checkLines,
  compactArgs,
  compactBusy,
  compactGate,
  compactRequest,
  blockingTasks,
  isReadyAnswer,
  clearAskHolds,
  isTypedPrompt,
  isUnder,
  nextLastCompact,
  parseStamp,
  pendingAction,
  pendingFresh,
  quietVerdict,
  raceVerdict,
  renoteRisk,
  restartFailedText,
  filledResumeArgs,
  resumeArgs,
  stampJson,
  stampPath,
  verdict,
} from './restart'
import type { CheckRun, Facts, HandoffFact, RefusalCode, StampRead, Verdict } from './restart'
import { claimFromResume, heartbeatDue, leasePath, leaseState, ownerJson, parseOwner, parseResumeArgs, parseRoleArg, resolveRole, roleForCommand, roleProblem } from './roles'
import type { Lease, ResumeClaim, RoleResolution } from './roles'
import {
  applyTimes,
  contextFloor,
  crossesGates,
  deniedBy,
  denyTools,
  evaluate,
  idleMs,
  inFlightTokens,
  liveDenies,
  markHeld,
  metricsOf,
  onEstimate,
  placeContext,
  planActions,
  readingVars,
  resetMarks,
  stepHolds,
  stepTokens,
  tokenGates,
  toolLiftsIn,
  toolsFree,
  triggerHolds,
  triggersFor,
  whenState,
  WAKE_ID,
  wakeHold,
  withWake,
} from './triggers'
import type { ActionPlan, CacheMetrics, Fire, LimitKind, Metrics, TokenGates } from './triggers'
import {
  PRUNE_AFTER_MS,
  asMarks,
  asSpawned,
  budgetFor,
  decide,
  fromMark,
  identityType,
  kindOf,
  listedIdentity,
  lowestGate,
  markOf,
  overCount,
  staleIds,
  staleSpawns,
  stopDeny,
  track,
} from './subagents'
import type { Tracked } from './subagents'
import { LIFT_CHECK_TIMEOUT_MS, LIFT_TRIES, asLifts, checkTries, earliestReset, emptyLifts, gateWhy, keepsWake, liftsFor, operatorInput, wakeVerdict, wakesOnLift } from './lifts'
import type { WakeGate } from './lifts'
import { parseProbe, probeSegment, probeState, scriptEnv } from './scripts'
import type { ProbeOutcome, ProbeRun, ScriptContext, ScriptPurpose } from './scripts'

const BAND = { plugin: 'ctx-guard', key: 'band' } as const
const MARKS = { plugin: 'ctx-guard', key: 'marks' } as const
const ROLE_CLAIM = { plugin: 'ctx-guard', key: 'roleClaim' } as const
const CONFIG = { plugin: 'ctx-guard', key: 'config' } as const
const PAUSE = { plugin: 'ctx-guard', key: 'pause' } as const
const LAST_CLEAR = { plugin: 'ctx-guard', key: 'lastClearAt' } as const
const LAST_RESTART = { plugin: 'ctx-guard', key: 'lastRestartAt' } as const
const CLEAR_ASK = { plugin: 'ctx-guard', key: 'clearAsk' } as const
const ACTIVITY = { plugin: 'ctx-guard', key: 'activity' } as const
const PENDING = { plugin: 'ctx-guard', key: 'pendingResume' } as const
const LAST_VERDICT = { plugin: 'ctx-guard', key: 'lastVerdict' } as const
const LEASE = { plugin: 'ctx-guard', key: 'lease' } as const
const WORK = { plugin: 'ctx-guard', key: 'work' } as const
const STAMP = { plugin: 'ctx-guard', key: 'stamp' } as const
const PENDING_COMPACT = { plugin: 'ctx-guard', key: 'pendingCompact' } as const
const LAST_COMPACT = { plugin: 'ctx-guard', key: 'lastCompact' } as const
const SUBAGENTS = { plugin: 'ctx-guard', key: 'subagents' } as const
const SPAWNED = { plugin: 'ctx-guard', key: 'spawned' } as const
const CACHE = { plugin: 'ctx-guard', key: 'cache' } as const
const LIFTS = { plugin: 'ctx-guard', key: 'lifts' } as const
// A /clear this soon after a not-cleared restart was dropped is that restart's, landing late.
const LATE_CLEAR_MS = 60 * 1000

const IDLE_TICK_MS = 60 * 1000
// Redraws the reset countdowns.
const BAND_TICK_MS = 5 * 60 * 1000
const MAX_SHOWN = 32
const STALE_TURN_MS = 6 * 60 * 60 * 1000
// The engine's window is read again this often, in measures, in case its settings moved.
const ENGINE_WINDOW_EVERY = 10

const NO_ROLE: RoleResolution = { role: null, source: null, problem: null }

// What the engine's figures look like from `$.session.usage()` and `session.measure` alike.
type Reading = {
  context: { tokens?: number; window: number }
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

// How an evaluation treats the band: written always, only when its figures changed, or not at all.
type BandWrite = 'always' | 'changed' | 'never'

// A failed ping or prompt and the tries made so far.
// `deferred`: a prompt that waits for lift work to end, which it does not hold back.
type Retry = { kind: 'ping' | 'prompt'; fire: Fire; tries: number; deferred?: boolean }

// Module state: lost on a hot reload, which fires session.start again and
// rebuilds it. Whatever must outlive a reload is in `$.state`, which `mem` (see state below) writes through to.
type Mod = {
  started: boolean
  interactive: boolean
  surface: RenderSurface | null
  // Another plugin owns /ctx-guard: ctx-guard does nothing at all.
  inert: boolean
  commandOwned: boolean
  env: string | undefined
  eff: Effective | null
  autoCompactWindow: unknown
  engineWindow: EngineWindow | null
  // The model window when engineWindow was read; a change means another model.
  engineModelWindow: number | null
  role: RoleResolution
  standIn: boolean
  timers: Timer[]
  // The newest main-loop fill, updated on every step with no I/O.
  lastMain: MainReading | null
  // Main-loop steps started; a tool call is counted against the step that was newest when it started.
  mainGen: number
  // The newest main step is still streaming: its tool calls run before its usage arrives.
  mainOpen: boolean
  // The output tokens of the last main step that reported usage.
  lastOut: number | null
  // Characters of main-loop tool results, by the step whose response called the tool.
  added: Map<number, number>
  // Where a step's tokens must land to matter; null evaluates the next step.
  gates: TokenGates | null
  // The step model the gates were placed for: percent gates move with its window.
  gatesModel: string | null
  measures: number
  // The repo's trust, read from $.store at each config load and by /ctx-guard trust.
  trust: TrustState | null
  // A restart flow is running in this environment.
  restarting: boolean
  // A /compact this copy sent has not answered yet.
  compacting: boolean
  // A queued compact is being tried; one try at a time.
  compactTrying: boolean
  // Ends the hold of a compact queued within the quiet period of the last one.
  compactTimer: Timer | null
  // Subagent ids seen stepping and when (NaN until the clock answers), dropped at their turn.complete;
  // `$.state.work` keeps them across a reload.
  steps: Map<string, number>
  // When each id's step was last written to `$.state.work`.
  stepWrites: Map<string, number>
  // Ids whose turn completed, so a step write that lands late does not bring them back.
  ended: Set<string>
  // The config has a subagent budget, so subagent steps are measured.
  budgeted: boolean
  // Subagents followed against their budgets, by id; the ones past a step are mirrored in `$.state.subagents`.
  agents: Map<string, Tracked>
  // Agents agent.spawn started, with their type and kind; `$.state.spawned` keeps them across a reload.
  spawned: Map<string, SpawnedAgent>
  // Moves when the budgets or the role do, so an evaluation that started before keeps no stale gate.
  budgetGen: number
  // Band probe timers and the probe list they were armed for ('' when none run).
  probeTimers: Timer[]
  probeKey: string
  // Probe ids with a run under way: a tick meanwhile is skipped.
  probeRunning: Set<string>
  // The last run of each probe, for the band and the report.
  probeResults: Map<string, ProbeRun>
  // The transcript path the last classic Stop named; null when none did.
  transcriptPath: string | null
  // A keep-warm ping is in flight (holdSlot): set until its fork settles or counts as gone.
  pinging: symbol | null
  // Counts /clears, so a ping that was in flight across one drops its answer.
  clears: number
  // A ping or prompt that failed, tried again on each idle tick while its trigger holds.
  retry: Retry | null
  // The `at` of the queued compact that waits for the end of ctx-guard's prompt turn.
  compactAfter: number | null
  // The text of the prompt ctx-guard is submitting; null when it submits none.
  ownText: string | null
  // The next main turn answers ctx-guard's own prompt.
  ownPrompt: boolean
  // The next main turn answers a prompt the person typed (isTypedPrompt).
  typedPrompt: boolean
  // That prompt is a lift's wake prompt.
  wakeNext: boolean
  // The holds a lift check's fork covers while it is out; null with none.
  checking: Set<string> | null
  // A lift check's fork has not settled yet, past its timeout too, until it counts as gone (holdSlot).
  liftForking: symbol | null
  // A lift check's fresh or failed evaluation is under way: its own fires wait, as for lift work.
  deciding: boolean
  // The `at` of the queued compact that waits for lift work to end.
  compactAfterLift: number | null
  // The last reading showed a usage window (a subscription); null before any reading.
  subscribed: boolean | null
}

const fresh = (): Mod => ({
  started: false,
  interactive: false,
  surface: null,
  inert: false,
  commandOwned: false,
  env: undefined,
  eff: null,
  autoCompactWindow: undefined,
  engineWindow: null,
  engineModelWindow: null,
  role: NO_ROLE,
  standIn: false,
  timers: [],
  lastMain: null,
  mainGen: 0,
  mainOpen: false,
  lastOut: null,
  added: new Map(),
  gates: null,
  gatesModel: null,
  measures: 0,
  trust: null,
  restarting: false,
  compacting: false,
  compactTrying: false,
  compactTimer: null,
  steps: new Map(),
  stepWrites: new Map(),
  ended: new Set(),
  budgeted: false,
  agents: new Map(),
  spawned: new Map(),
  budgetGen: 0,
  probeTimers: [],
  probeKey: '',
  probeRunning: new Set(),
  probeResults: new Map(),
  transcriptPath: null,
  pinging: null,
  clears: 0,
  retry: null,
  compactAfter: null,
  ownText: null,
  ownPrompt: false,
  typedPrompt: false,
  wakeNext: false,
  checking: null,
  liftForking: null,
  deciding: false,
  compactAfterLift: null,
  subscribed: null,
})

let mod: Mod = fresh()
// The userConfig switches, set each time register runs (a /config change reloads).
let switches: Switches = DEFAULT_SWITCHES
let switchErrors: string[] = []
let starting: Promise<void> | null = null

// One evaluation at a time, so a measure and a step that race never both fire
// the same rising edge.
let chain: Promise<void> = Promise.resolve()
function serial(fn: () => Promise<void>): Promise<void> {
  const run = chain.then(() => quietly(fn))
  chain = run
  return run
}

async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // A failed read or write leaves the session as it was.
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const active = (): boolean => mod.started && !mod.inert && mod.interactive && mod.eff?.enabled === true

const drawsBand = (surface: RenderSurface): boolean =>
  active() && mod.eff?.display === 'band' && (surface === 'terminal' || surface === 'desktop')

// Activity comes back from $.state, which another version may have written.
function asClearAsk(v: unknown): ClearAsk | null {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const at = num(o.at)
  return at !== null && typeof o.role === 'string' ? { at, role: o.role } : null
}

function asActivity(v: unknown): Activity {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const lm = typeof o.lastMain === 'object' && o.lastMain !== null ? (o.lastMain as Record<string, unknown>) : null
  const at = num(lm?.at)
  return {
    lastMainEndAt: num(o.lastMainEndAt),
    mainTurnAt: num(o.mainTurnAt),
    mainStartAt: num(o.mainStartAt),
    lastClosingStartAt: num(o.lastClosingStartAt),
    lastCutStartAt: num(o.lastCutStartAt),
    lastTypedStartAt: num(o.lastTypedStartAt),
    lastRole: typeof o.lastRole === 'string' ? o.lastRole : null,
    roleChangedAt: num(o.roleChangedAt),
    ownTurn: o.ownTurn === true,
    typedTurn: o.typedTurn === true,
    wokenTurn: o.wokenTurn === true,
    lastWokenEndAt: num(o.lastWokenEndAt),
    lastTurnEndAt: num(o.lastTurnEndAt),
    lastMain: lm && at !== null ? { tokens: num(lm.tokens), at } : null,
    shown: Array.isArray(o.shown) ? o.shown.filter((x): x is string => typeof x === 'string') : [],
  }
}

// ---- state ------------------------------------------------------------------

// What ctx-guard keeps lives in `mem`, a module variable, and every write goes
// through to `$.state` as well. Neither store alone outlives everything: a /clear
// empties `$.state` right after its session.end (it fires no session.start and
// does not reload the module), while a hot reload drops the module and keeps
// `$.state`. So every read comes from memory, every session.start fills memory
// from `$.state` (it fires on startup, resume and reload, never on /clear), and
// the first hook or timer after a /clear writes all of memory back to `$.state`.
// One gap is left: a hot reload landing after a /clear and before that first
// hook starts from the emptied `$.state`.
type Stored = PluginState['ctx-guard']
type Key = keyof Stored

const emptyMem = (): Stored => ({
  band: null,
  marks: null,
  roleClaim: null,
  config: null,
  pendingResume: null,
  pendingCompact: null,
  lastCompact: null,
  pause: null,
  lastClearAt: null,
  lastRestartAt: null,
  clearAsk: null,
  lastVerdict: null,
  lease: null,
  work: null,
  subagents: null,
  spawned: null,
  stamp: null,
  activity: null,
  cache: null,
  lifts: null,
})

let mem: Stored = emptyMem()
// Memory holds what `$.state` held at the last session start (or the first hook, after an install mid-session).
let hydrated = false
let hydrating: Promise<void> | null = null
let hydrations = 0
// Keys put while a hydrate reads: memory's value is the newer, so the read leaves them.
let putSince: Set<Key> | null = null
// A /clear emptied `$.state`: the next hook or timer writes memory back.
let flushOwed = false
// The session start could not read `$.state`: once a hook reads it, the start's work from memory runs again.
let recoverOwed = false
// A /clear came while a start ran: it is applied once the start is done.
let clearOwed = false
// The write of each key still under way, so `$.state` ends on the latest value.
const writing: Partial<Record<Key, Promise<void>>> = {}

// One literal ref per key: `claude plugin validate` reads each from the source.
function stateSet($: EngineInterface, key: Key, value: unknown): Promise<unknown> {
  switch (key) {
    case 'band':
      return $.state.set(BAND, value as Stored['band'])
    case 'marks':
      return $.state.set(MARKS, value as Stored['marks'])
    case 'roleClaim':
      return $.state.set(ROLE_CLAIM, value as Stored['roleClaim'])
    case 'config':
      return $.state.set(CONFIG, value as Stored['config'])
    case 'pendingResume':
      return $.state.set(PENDING, value as Stored['pendingResume'])
    case 'pendingCompact':
      return $.state.set(PENDING_COMPACT, value as Stored['pendingCompact'])
    case 'lastCompact':
      return $.state.set(LAST_COMPACT, value as Stored['lastCompact'])
    case 'pause':
      return $.state.set(PAUSE, value as Stored['pause'])
    case 'lastClearAt':
      return $.state.set(LAST_CLEAR, value as Stored['lastClearAt'])
    case 'lastRestartAt':
      return $.state.set(LAST_RESTART, value as Stored['lastRestartAt'])
    case 'clearAsk':
      return $.state.set(CLEAR_ASK, value as Stored['clearAsk'])
    case 'lastVerdict':
      return $.state.set(LAST_VERDICT, value as Stored['lastVerdict'])
    case 'lease':
      return $.state.set(LEASE, value as Stored['lease'])
    case 'work':
      return $.state.set(WORK, value as Stored['work'])
    case 'subagents':
      return $.state.set(SUBAGENTS, value as Stored['subagents'])
    case 'spawned':
      return $.state.set(SPAWNED, value as Stored['spawned'])
    case 'stamp':
      return $.state.set(STAMP, value as Stored['stamp'])
    case 'activity':
      return $.state.set(ACTIVITY, value as Stored['activity'])
    case 'cache':
      return $.state.set(CACHE, value as Stored['cache'])
    case 'lifts':
      return $.state.set(LIFTS, value as Stored['lifts'])
  }
}

// Queued behind the key's last write; a failed write is dropped, memory keeps the value.
function persist($: EngineInterface, key: Key, value: unknown): Promise<void> {
  const run = (writing[key] ?? Promise.resolve()).then(() => quietly(() => stateSet($, key, value)))
  writing[key] = run
  void run.then(() => {
    if (writing[key] === run) delete writing[key]
  })
  return run
}

function put<K extends Key>($: EngineInterface, key: K, value: Stored[K]): Promise<void> {
  mem[key] = value
  putSince?.add(key)
  return persist($, key, value)
}

// Read-modify-write on memory: synchronous, so two hooks never lose each other's change.
function change<K extends Key>($: EngineInterface, key: K, fn: (v: Stored[K]) => Stored[K]): Promise<void> {
  return put($, key, fn(mem[key]))
}

const writesSettled = (): Promise<unknown> => Promise.all(Object.values(writing))

// Shape-checked, as another version may have written them; a key never written is its default.
async function readStored($: EngineInterface): Promise<Stored> {
  const [band, marks, roleClaim, config, pendingResume, pendingCompact, lastCompact, pause, lastClearAt, lastRestartAt, clearAsk, lastVerdict, lease, work, subagents, spawned, stamp, activity, cache, lifts] = await Promise.all([
    $.state.get(BAND),
    $.state.get(MARKS),
    $.state.get(ROLE_CLAIM),
    $.state.get(CONFIG),
    $.state.get(PENDING),
    $.state.get(PENDING_COMPACT),
    $.state.get(LAST_COMPACT),
    $.state.get(PAUSE),
    $.state.get(LAST_CLEAR),
    $.state.get(LAST_RESTART),
    $.state.get(CLEAR_ASK),
    $.state.get(LAST_VERDICT),
    $.state.get(LEASE),
    $.state.get(WORK),
    $.state.get(SUBAGENTS),
    $.state.get(SPAWNED),
    $.state.get(STAMP),
    $.state.get(ACTIVITY),
    $.state.get(CACHE),
    $.state.get(LIFTS),
  ])
  const opt = <T,>(v: unknown, as: (v: unknown) => T): T | null => (v === undefined || v === null ? null : as(v))
  return {
    band: band.value ?? null,
    marks: marks.value ?? null,
    roleClaim: roleClaim.value ?? null,
    config: asConfigState(config.value),
    pendingResume: asPendingResume(pendingResume.value ?? null),
    pendingCompact: asPendingCompact(pendingCompact.value ?? null),
    lastCompact: asLastCompact(lastCompact.value ?? null),
    pause: pause.value ?? null,
    lastClearAt: num(lastClearAt.value),
    lastRestartAt: num(lastRestartAt.value),
    clearAsk: asClearAsk(clearAsk.value),
    lastVerdict: lastVerdict.value ?? null,
    lease: asLease(lease.value),
    work: opt(work.value, asWork),
    subagents: opt(subagents.value, asMarks),
    spawned: opt(spawned.value, asSpawned),
    stamp: asHeldStamp(stamp.value),
    activity: opt(activity.value, asActivity),
    cache: opt(cache.value, asCache),
    lifts: opt(lifts.value, asLifts),
  }
}

/** Memory replaced by what `$.state` holds, once this copy's own writes landed; a failed read keeps memory. */
function hydrate($: EngineInterface): Promise<void> {
  hydrated = false
  putSince = new Set()
  const run = fill($, ++hydrations)
  hydrating = run
  return run
}

async function fill($: EngineInterface, gen: number): Promise<void> {
  let next: Stored | null = null
  try {
    await writesSettled()
    next = await readStored($)
  } catch {
    // Unreadable: memory stays as it is, and the next hook tries again.
  }
  // A later hydrate replaced this one: its read is the newer.
  if (gen !== hydrations) return
  hydrating = null
  const kept = putSince
  putSince = null
  if (!next) return
  for (const key of kept ?? []) setMem(next, key, mem[key])
  mem = next
  hydrated = true
}

function setMem<K extends Key>(into: Stored, key: K, value: Stored[K]): void {
  into[key] = value
}

// Fire-and-forget: reads never wait on it, since they come from memory.
function flush($: EngineInterface): void {
  flushOwed = false
  for (const key of Object.keys(mem) as Key[]) void persist($, key, mem[key])
}

const needsReady = (): boolean => !hydrated || flushOwed || recoverOwed

// First thing in every hook and timer: memory filled, and `$.state` rewritten if a /clear emptied it.
async function ready($: EngineInterface): Promise<void> {
  while (!hydrated) {
    await (hydrating ?? hydrate($))
    // The read failed: this hook goes on with memory as it is.
    if (!hydrated && hydrating === null) break
  }
  if (flushOwed) flush($)
  if (recoverOwed && hydrated && mod.started) {
    recoverOwed = false
    // The role now, for this hook; the rest off its path, since a hook may run inside the evaluation chain.
    await quietly(() => resolveNow($))
    $.clock.after(0, () => void quietly(() => timed($, () => fromMemory($))))
  }
}

const activity = (): Activity => mem.activity ?? asActivity(null)

async function patchActivity($: EngineInterface, fn: (a: Activity) => Activity): Promise<void> {
  await change($, 'activity', a => fn(a ?? asActivity(null)))
}

const cacheState = (): CacheState => mem.cache ?? emptyCache()

// Memory on every call; `$.state` only when `durable`, so a step costs no write.
async function setCache($: EngineInterface, fn: (c: CacheState) => CacheState, durable = true): Promise<void> {
  const next = fn(cacheState())
  if (durable) return put($, 'cache', next)
  mem.cache = next
  // A hydrate under way keeps memory's value, as it does for a put.
  putSince?.add('cache')
}

// A toast once per session for `key`, reloads included.
async function noticeOnce($: EngineInterface, key: string, text: string): Promise<void> {
  if (activity().shown.includes(key)) return
  await patchActivity($, a => ({ ...a, shown: [...a.shown, key].slice(-MAX_SHOWN) }))
  $.ui.toast(text)
}

const paused = (now: number): boolean => isPaused(mem.pause, now)

// ---- config -----------------------------------------------------------------

const sameFiles = (a: readonly ConfigFile[], b: readonly ConfigFile[]): boolean =>
  a.length === b.length && a.every((f, i) => f.path === b[i]?.path && f.mtime === b[i]?.mtime)

// The engine's own compaction window: per-model settings, the env override and its defaults.
async function readEngineWindow($: EngineInterface): Promise<void> {
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const b = u?.context.breakdown
  const raw = num(b?.rawMaxTokens)
  mod.engineWindow = b && raw !== null && raw > 0 ? { tokens: raw, source: String(b.autocompactSource) } : null
  mod.engineModelWindow = num(u?.context.window)
}

/**
 * Reads the team and local files and builds the effective config; without
 * `force`, only when a file's mtime moved since the last load. An invalid
 * file keeps the last good config and toasts once per new set of errors.
 * Answers whether it loaded.
 */
async function loadConfig($: EngineInterface, force: boolean): Promise<boolean> {
  const root = await $.session.root()
  const prev = mem.config
  const rels = [switches.configPath, localPathFor(switches.configPath)]
  const readErrors: string[] = []
  const stats: ConfigFile[] = []
  const abs: (string | null)[] = []
  for (const rel of rels) {
    const c = confinePath(root, rel)
    if ('error' in c) {
      readErrors.push(`${rel}: ${c.error}`)
      abs.push(null)
      stats.push({ path: rel, mtime: null })
      continue
    }
    const st = await $.fs.stat(c.path).catch(() => null)
    abs.push(c.path)
    stats.push({ path: rel, mtime: st ? st.mtimeMs : null })
  }
  if (!force && mod.eff && prev && sameFiles(prev.files, stats)) return false

  const files: FileLayer[] = []
  for (const [i, f] of stats.entries()) {
    const path = abs[i]
    if (f.mtime === null || !path) {
      files.push({ path: f.path, text: null })
      continue
    }
    try {
      files.push({ path: f.path, text: await $.fs.read(path) })
    } catch (e) {
      readErrors.push(`${f.path}: could not be read: ${errorText(e)}`)
    }
  }
  const eff = effectiveConfig({ switches, files, lastGood: prev?.lastGood ?? null, readErrors })
  const errors = [...switchErrors, ...eff.errors]
  const state: ConfigState = {
    lastGood: eff.fallback ? (prev?.lastGood ?? null) : eff.config,
    source: eff.source,
    errors,
    files: stats,
    loadedAt: await $.clock.now(),
  }
  await put($, 'config', state)
  mod.eff = eff
  mod.gates = null
  mod.budgeted = Object.keys(eff.config.subagents).length > 0
  rejudgeAll()
  await readTrust($, root)
  const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
  mod.autoCompactWindow = settings.autoCompactWindow
  await readEngineWindow($)
  if (switches.enabled && mod.interactive && errors.length && JSON.stringify(errors) !== JSON.stringify(prev?.errors ?? [])) {
    const kept = eff.source === 'last-good' ? 'kept the last good config' : 'running on the built-in config'
    $.ui.toast(`ctx-guard: config has ${errors.length} error${errors.length === 1 ? '' : 's'}; ${kept}. /ctx-guard lists them.`)
  }
  await resolveNow($)
  return true
}

async function resolveNow($: EngineInterface): Promise<RoleResolution> {
  const eff = mod.eff
  if (!eff) return (mod.role = NO_ROLE)
  const r = resolveRole({
    claim: mem.roleClaim,
    env: mod.env,
    repoDefault: eff.config.defaultRole,
    switchDefault: eff.switchDefaultRole,
    interactive: mod.interactive,
    config: eff.config,
  })
  if (r.role !== mod.role.role) {
    mod.gates = null
    // The lifts are the role's: a check under way for the old role answers nothing.
    mod.checking = null
    rejudgeAll()
  }
  // Stored lifts of another role are dropped as soon as this role is resolved, so a role switched back to starts with none.
  // A /ctx-guard wake goes with them, and the operator who set it is told.
  if (mem.lifts && mem.lifts.role !== r.role) {
    const w = mem.lifts.holds[WAKE_ID]?.manual
    await put($, 'lifts', emptyLifts(r.role))
    if (w && mod.interactive) $.ui.toast(wakeCancelledText(w.window, { role: r.role }))
  }
  mod.role = r
  if (r.role !== null && r.role !== activity().lastRole) await quietly(() => noteRole($, r.role as string))
  if (r.problem && active()) await noticeOnce($, `role:${r.problem}`, `ctx-guard: ${r.problem}`)
  return r
}

// A resolved role other than the last one resolved is a role change; a spell with no role between is none.
async function noteRole($: EngineInterface, role: string): Promise<void> {
  const now = await $.clock.now()
  await patchActivity($, a => ({ ...a, lastRole: role, ...(a.lastRole !== null && a.lastRole !== role ? { roleChangedAt: now } : {}) }))
}

// ---- metrics and evaluation -------------------------------------------------

function windowFor(modelWindow: number): WindowInfo {
  const config = mod.eff?.config ?? builtInConfig()
  return resolveWindow(config.contextWindow, modelWindow, mod.engineWindow, mod.autoCompactWindow)
}

// A turn start with no end for hours is a lost turn.complete, not a running turn.
const turnRunningIn = (a: Activity, now: number): boolean => a.mainTurnAt !== null && now - a.mainTurnAt < STALE_TURN_MS

const cacheConfig = (): CacheConfig => mod.eff?.config.cache ?? DEFAULT_CACHE

// A reading with a usage window is a subscription's.
const subscribedIn = (m: Metrics): boolean => m.limits.five_hour !== null || m.limits.seven_day !== null

// The TTL in force.
function cacheTtl(subscribed: boolean): { ms: number; source: TtlSource } {
  return effectiveTtl(cacheState(), cacheConfig(), subscribed)
}

// A new prefix in a new idle period: after /clear, and for a session the stored record is not of.
const freshCache = (c: CacheState): CacheState => newPeriod(startOver({ ...c, transcriptTried: false }))

async function metricsFor($: EngineInterface, reading: Reading, now: number): Promise<Metrics> {
  const a = activity()
  const running = turnRunningIn(a, now)
  // ctx-guard's own prompt turn keeps the idle clock running: it is not the operator back. A woken turn
  // is work again: idle stands still through it and counts from its end.
  const woke = a.lastWokenEndAt !== null && (a.lastMainEndAt === null || a.lastWokenEndAt > a.lastMainEndAt)
  const idle = idleMs(woke ? a.lastWokenEndAt : a.lastMainEndAt, running && (!a.ownTurn || a.wokenTurn), now)
  const window = windowFor(reading.context.window).tokens
  const m = metricsOf({ tokens: reading.context.tokens, rateLimits: reading.rateLimits, cost: reading.cost }, window, idle, now)
  mod.subscribed = subscribedIn(m)
  const c = cacheState()
  const cache: CacheMetrics = { expiresIn: expiresInMs(c, cacheTtl(mod.subscribed).ms, running, now), miss: c.miss, missCause: c.missCause, pings: c.pings }
  return { ...m, cache }
}

// usage() can lag the newest main step mid-turn; the step's fill wins. While a
// step streams, its own fill is not reported yet: the estimate stands in, or
// usage() when the engine already has a larger figure.
async function currentReading($: EngineInterface): Promise<Reading> {
  const u = await $.session.usage()
  const last = mod.lastMain
  if (!last) return u
  if (last.tokens === null) return { ...u, context: { window: u.context.window } }
  const tokens = mod.mainOpen
    ? Math.max(inFlightTokens(last.tokens, mod.lastOut, mod.added.get(mod.mainGen - 1) ?? 0), num(u.context.tokens) ?? 0)
    : last.tokens
  return { ...u, context: { window: u.context.window, tokens } }
}

// A main-loop step begins: what it sends is the last one's context plus what was added since.
function openMainStep(): number {
  const gen = ++mod.mainGen
  mod.mainOpen = true
  for (const g of mod.added.keys()) if (g < gen - 1) mod.added.delete(g)
  return gen
}

// A main-loop tool result, as the model reads it, counted toward the next request.
function addResult(gen: number, text: unknown): void {
  if (typeof text === 'string' && text.length) mod.added.set(gen, (mod.added.get(gen) ?? 0) + text.length)
}

async function rememberMain($: EngineInterface, tokens: number | null, now: number): Promise<void> {
  const reading: MainReading = { tokens, at: now }
  mod.lastMain = reading
  await patchActivity($, a => ({ ...a, lastMain: reading }))
}

const roleTriggers = (): Trigger[] => (mod.eff ? triggersFor(mod.eff.config, mod.role.role) : [])

// Answers the ids of the triggers whose note went to the model.
async function act($: EngineInterface, plan: ActionPlan, isPaused: boolean, metrics: Metrics): Promise<string[]> {
  const eff = mod.eff
  const role = mod.role.role
  if (!eff) return []
  const spec = role === null ? null : roleSpec(eff.config, role)
  let noted: string[] = []
  // Fires whose toast the note toast stands for.
  let shown = new Set<Fire>()
  // Model notes only once a role is assigned: a user-scope install never changes model behaviour unasked.
  if (role !== null && spec && plan.notes.length) {
    const opts = { role, spec, readyToken: eff.config.readyToken, mode: effectiveMode(spec, { autoActions: eff.autoActions, trusted: mod.trust?.trusted === true, paused: isPaused }) }
    const text = collapseNotes(plan.notes, opts)
    let sent = false
    if (text) {
      await quietly(async () => {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        sent = true
      })
    }
    if (sent) noted = plan.notes.map(f => f.trigger.id)
    // The operator sees what the model was told: one toast for the note, in place of its fires' own.
    const toast = sent && eff.noteToasts ? noteToastText(plan.notes, opts) : null
    if (toast) {
      $.ui.toast(toast)
      shown = new Set(plan.notes)
    }
  }
  for (const text of new Set(plan.toasts.filter(f => !shown.has(f)).map(f => toastText(f.vars, role)))) $.ui.toast(text)
  for (const text of new Set(plan.notifies.map(f => toastText(f.vars, role)))) await quietly(() => $.ui.notify(text))
  // Ping and prompt act on their own, as compact does: trust, autoActions and no pause. The first
  // prompt not skipped at cache.prompt.maxUsage goes; a ping goes only without one, as a prompt's
  // turn warms the cache itself.
  let prompt: PromptOutcome | null = null
  if (role !== null && spec && (plan.ping || plan.prompts.length)) {
    const gate = compactGateNow(isPaused)
    if (gate) await noticeOnce($, `auto-skip:${gate.code}`, `ctx-guard: ping and prompt actions skipped: ${gate.text}.`)
    else {
      for (const f of plan.prompts) {
        prompt = await runPrompt($, f, role, spec, metrics, 1)
        if (prompt !== 'skipped') break
      }
      if (plan.ping && (prompt === null || prompt === 'skipped')) runPing($, plan.ping, metrics, 1)
    }
  }
  // Beside a prompt that went in or waits for a retry, the compact waits for that prompt's turn to end.
  if (plan.compact && role !== null && spec && prompt !== 'gave-up') {
    const afterPrompt = prompt === 'went' || prompt === 'retry'
    await quietly(() => requestCompact($, plan.compact as Fire, role, isPaused, afterPrompt))
  }
  return noted
}

async function setBand($: EngineInterface, metrics: Metrics, isPaused: boolean, write: BandWrite): Promise<void> {
  if (write === 'never') return
  const eff = mod.eff
  const denies =
    eff && mod.role.role !== null ? liveDenies(roleTriggers(), metrics, { blocking: eff.blocking, paused: isPaused }) : []
  const prev = mem.band
  const band: Band = { ...bandOf(mod.role.role, metrics, denies, prev), subagentsOver: subagentsOver(), probes: probeSegments(), untrusted: bandUntrusted(), cache: cacheBand(metrics) }
  if (write === 'changed' && sameBand(prev, band)) return
  await drawBand($, band)
}

// The countdown, from the same TTL and running turn as the cache.expiresIn metric.
function cacheBand(m: Metrics): BandCache | null {
  const cfg = cacheConfig()
  const c = cacheState()
  const ttl = cacheTtl(subscribedIn(m))
  const pinger = roleTriggers().find(t => t.do.includes('ping'))
  return cacheSegment({
    expiresIn: m.cache.expiresIn,
    ttl: ttl.ms,
    guessed: ttl.source === 'guess',
    busy: turnRunningIn(activity(), m.now),
    cold: c.coldShown,
    show: cfg.band.show,
    warn: cfg.band.warn,
    pings: c.pings,
    cap: pinger?.times ?? null,
  })
}

// Memory first, so the redraw shows it; `$.state` follows, and its write redraws the band too.
async function drawBand($: EngineInterface, band: Band): Promise<void> {
  const written = put($, 'band', band)
  if (!mod.standIn) $.ui.invalidate('ui.render')
  if (mod.standIn) $.ui.status(bandText(band) || undefined)
  await written
}

/**
 * Rising edges since the stored marks → note, toast, notify; the holds of
 * brakes with a lift, and their lifts; then the band. `check` is a lift
 * check's outcome: fresh figures, or its last try failed.
 */
async function evaluateNow($: EngineInterface, reading: Reading, write: BandWrite, check: LiftCheck | null = null): Promise<void> {
  if (!active()) return
  const now = await $.clock.now()
  const metrics = await metricsFor($, reading, now)
  const role = mod.role.role
  const triggers = roleTriggers()
  const prev = mem.marks
  const ev = evaluate(triggers, metrics, prev, role)
  // Written before acting, so a failed note never fires twice.
  if (JSON.stringify(ev.marks) !== JSON.stringify(prev)) {
    await put($, 'marks', ev.marks)
    await quietly(() => dropRearmedCompact($, ev.marks))
  }
  const exempt = role === null ? new Set<string>() : await stepLifts($, triggers, metrics)
  // Counted before acting too: a fire counts toward its trigger's `times` whether or not its actions succeed.
  const fired = cacheState().fired
  const capped = applyTimes(ev.fire, fired, exempt)
  if (JSON.stringify(capped.fired) !== JSON.stringify(fired)) await setCache($, c => ({ ...c, fired: capped.fired }))
  mod.gates = tokenGates(triggers, ev.marks, role, metrics.window)
  const isPaused = paused(now)
  const noted = await act($, planActions(capped.fire), isPaused, metrics)
  if (role !== null) {
    if (noted.length) await putLifts($, l => ({ ...l, holds: stamp(l.holds, noted, hold => ({ ...hold, notedAt: now })) }))
    await quietly(() => judgeLifts($, metrics, isPaused, check))
  }
  // A pause that ran out frees a blocked compact here.
  await quietly(() => unblockCompact($, isPaused))
  await setBand($, metrics, isPaused, write)
}

async function evaluateCurrent($: EngineInterface, write: BandWrite): Promise<void> {
  await evaluateNow($, await currentReading($), write)
}

// The band from the current reading, with no evaluation: timers and commands redraw it
// whole; a main step whose fill moved the shown figure redraws it only if it changed.
async function refreshBand($: EngineInterface, write: BandWrite = 'always'): Promise<void> {
  if (!active()) return
  const now = await $.clock.now()
  await setBand($, await metricsFor($, await currentReading($), now), paused(now), write)
}

// A main-loop step's evaluation, run off the step's critical path.
async function onMainStep($: EngineInterface, tokens: number, model: string | null): Promise<void> {
  if (!active()) return
  mod.gatesModel = model
  await rememberMain($, tokens, await $.clock.now())
  const u = await $.session.usage()
  await evaluateNow($, { ...u, context: { window: u.context.window, tokens } }, 'changed')
}

// The clock, read at once without holding up the caller; null when the read fails.
function clockRead($: EngineInterface): Promise<number | null> {
  let at: number | null = null
  return quietly(async () => {
    at = await $.clock.now()
  }).then(() => at)
}

// A main request: miss, anchor, observed TTL. A miss, or one clearing, is kept in `$.state` and evaluated at once.
// The request reads or writes the cache when it is sent: the step's open time is its anchor, now when that is unknown.
async function onCacheRequest($: EngineInterface, usage: TurnUsage, sentAt: Promise<number | null> | null): Promise<void> {
  if (!active()) return
  const now = await $.clock.now()
  const at = Math.min((await sentAt) ?? now, now)
  // The last reading tells a subscription; the usage is read only when there was none.
  const subscribed = mod.subscribed ?? subscribedIn(await metricsFor($, await currentReading($), now))
  const ttl = cacheTtl(subscribed).ms
  // After /clear the record takes the new session's id from its first request.
  const sid = cacheState().sessionId ?? (await $.session.id().catch(() => null))
  const before = cacheState().miss
  await setCache($, c => ({ ...onMainRequest(c, usage, ttl, at), sessionId: c.sessionId ?? sid }), false)
  if (cacheState().miss === 0 && before === 0) return
  await setCache($, c => c)
  await evaluateNow($, await currentReading($), 'changed')
}

async function onMeasure($: EngineInterface, e: Reading & { changed: readonly string[] }): Promise<void> {
  if (!active()) return
  mod.measures += 1
  // Another model, every Nth measure, or a context that started over (clear, compact).
  const startedOver = e.changed.includes('context') && e.context.tokens === undefined
  // The next request writes a new prefix: it is no miss against the old one.
  if (startedOver) await setCache($, startOver)
  if (e.context.window !== mod.engineModelWindow || mod.measures % ENGINE_WINDOW_EVERY === 0 || startedOver) {
    await readEngineWindow($)
  }
  await rememberMain($, num(e.context.tokens), await $.clock.now())
  // A usage report: a stalled hold waits for one.
  if (e.changed.includes('rateLimits') && Object.values(liftsNow().holds).some(hold => hold.phase === 'stalled')) {
    await putLifts($, l => ({ ...l, reports: l.reports + 1 }))
  }
  await evaluateNow($, e, 'changed')
  await quietly(() => leaseBeat($, false))
}

// A pending resume dropped as never cleared, in case its queued /clear still runs.
let dropped: { at: number; pending: PendingResume } | null = null

// A timer's work, after what a reload or a /clear may still owe, as every hook does first.
async function timed($: EngineInterface, fn: () => Promise<void>): Promise<void> {
  if (needsReady()) await quietly(() => ready($))
  await fn()
}

// ---- busy work ----------------------------------------------------------------

// A subagent's step is written to $.state at most this often, so a busy agent costs few writes.
const STEP_WRITE_MS = 60 * 1000

function asWork(v: unknown): Work {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const steps: Record<string, number> = {}
  if (typeof o.steps === 'object' && o.steps !== null) {
    for (const [id, at] of Object.entries(o.steps as Record<string, unknown>)) if (num(at) !== null) steps[id] = at as number
  }
  const bg = Array.isArray(o.background)
    ? o.background
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map(t => ({ id: String(t.id ?? ''), type: String(t.type ?? ''), status: String(t.status ?? ''), description: String(t.description ?? '') }))
    : null
  return { steps, background: bg }
}

const work = (): Work => mem.work ?? asWork(null)

// Off the step's path: the step returns first, then the time is read and written.
function noteStep($: EngineInterface, id: string): void {
  mod.ended.delete(id)
  if (!mod.steps.has(id)) mod.steps.set(id, Number.NaN)
  void quietly(async () => {
    const t = await $.clock.now()
    if (mod.ended.has(id)) return
    mod.steps.set(id, t)
    const last = mod.stepWrites.get(id)
    if (last !== undefined && t - last < STEP_WRITE_MS) return
    mod.stepWrites.set(id, t)
    if (mod.ended.has(id)) return
    const w = work()
    await put($, 'work', { ...w, steps: { ...w.steps, [id]: t } })
  })
}

async function endStep($: EngineInterface, id: string): Promise<void> {
  mod.ended.add(id)
  mod.steps.delete(id)
  mod.stepWrites.delete(id)
  const w = work()
  if (!(id in w.steps)) return
  const steps = { ...w.steps }
  delete steps[id]
  await put($, 'work', { ...w, steps })
}

// Ids seen stepping within STEP_SEEN_MS (this copy's and, across a reload, the stored ones).
async function recentSteps($: EngineInterface, now: number): Promise<string[]> {
  const ids = new Set<string>()
  for (const [id, at] of mod.steps) if (Number.isNaN(at) || now - at < STEP_SEEN_MS) ids.add(id)
  for (const [id, at] of Object.entries(work().steps)) if (now - at < STEP_SEEN_MS && !mod.ended.has(id)) ids.add(id)
  return [...ids]
}

// ---- subagent budgets ---------------------------------------------------------

// Budgets apply once the session has a role, like model notes: a user-scope install changes no subagent unasked.
const budgetsOn = (): boolean => active() && mod.budgeted && mod.role.role !== null

const subagentsOver = (): number => (mod.role.role === null ? 0 : overCount(mod.agents))

// The budgets or the role moved: every agent's next step is judged again, and an evaluation under way must not undo that.
function rejudgeAll(): void {
  mod.budgetGen += 1
  for (const t of mod.agents.values()) t.gate = 0
}

async function patchMarks($: EngineInterface, fn: (m: Record<string, SubagentMark>) => Record<string, SubagentMark>): Promise<void> {
  const cur = mem.subagents ?? {}
  const next = fn(cur)
  if (JSON.stringify(next) !== JSON.stringify(cur)) await put($, 'subagents', next)
}

async function patchSpawned($: EngineInterface, fn: (m: Record<string, SpawnedAgent>) => Record<string, SpawnedAgent>): Promise<void> {
  const cur = mem.spawned ?? {}
  const next = fn(cur)
  if (JSON.stringify(next) !== JSON.stringify(cur)) await put($, 'spawned', next)
}

/** An agent.spawn that started an agent: its type and kind, kept so its steps know what budget it has. */
async function onSpawn($: EngineInterface, id: string, type: string, kind: AgentKind): Promise<void> {
  const rec: SpawnedAgent = { type, kind, at: await $.clock.now() }
  mod.spawned.set(id, rec)
  // A step that came before the spawn answered found no name: it is judged again.
  const t = mod.agents.get(id)
  if (t) {
    t.identity = { type, kind }
    t.gate = 0
  }
  await patchSpawned($, m => (mod.spawned.get(id) === rec ? { ...m, [id]: rec } : m))
}

/**
 * A subagent step's fill, on the step's path: arithmetic only. A fill that
 * reaches the agent's gate schedules one evaluation off the path.
 */
function subagentStep($: EngineInterface, id: string, tokens: number | null): void {
  if (tokens === null) return
  let t = mod.agents.get(id)
  if (!t) {
    const known = mod.spawned.get(id)
    t = track(known ? { type: known.type, kind: known.kind } : null)
    mod.agents.set(id, t)
  }
  t.tokens = tokens
  if (tokens < t.gate) return
  // One evaluation at a time per agent; it sets the next gate.
  t.gate = Number.POSITIVE_INFINITY
  const tracked = t
  $.clock.after(0, () => void serial(() => timed($, () => judgeSubagent($, id, tracked))))
}

/** The budget of who the agent is (asked of `$.agent.list` only when no spawn named it), and the warn or stop note to the agent itself; marked before it is sent. */
async function judgeSubagent($: EngineInterface, id: string, t: Tracked): Promise<void> {
  const gen = mod.budgetGen
  let gate = 0
  try {
    const eff = mod.eff
    if (mod.agents.get(id) !== t || !budgetsOn() || !eff) return
    const now = await $.clock.now()
    t.seenAt = now
    if (t.identity === null) {
      try {
        t.identity = listedIdentity((await $.agent.list()).find(a => a.id === id))
      } catch {
        // Unknown for now: no budget, and the next evaluation asks again.
      }
    }
    const b = budgetFor(eff.config, t.identity)
    const d = decide(b, t.tokens, t.warned, t.stopped)
    // Unknown, any type's lowest step could be its own.
    gate = t.identity === null ? lowestGate(eff.config) : d.gate
    if (!d.step || !b || mod.agents.get(id) !== t) return
    t.warned = true
    if (d.step === 'stop') t.stopped = true
    t.warn = b.warn
    t.stop = b.stop
    const mark = markOf(t, now)
    if (mark) await patchMarks($, m => (mod.agents.get(id) === t ? { ...m, [id]: mark } : m))
    const vars = { type: identityType(t.identity) ?? b.type, tokens: t.tokens, warn: b.warn, stop: b.stop }
    const text = d.step === 'stop' ? subagentStopText(vars, b.message) : subagentWarnText(vars)
    await quietly(() => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId: id }))
    await quietly(() => patchBand($, 'subagentsOver', subagentsOver()))
  } finally {
    t.gate = gen === mod.budgetGen ? gate : 0
  }
}

async function forgetSubagents($: EngineInterface, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  for (const id of ids) {
    mod.agents.delete(id)
    mod.spawned.delete(id)
  }
  const drop = <T,>(m: Record<string, T>): Record<string, T> => {
    const out = { ...m }
    for (const id of ids) delete out[id]
    return out
  }
  await patchMarks($, drop)
  await patchSpawned($, drop)
  await patchBand($, 'subagentsOver', subagentsOver())
}

// On the band timer: agents whose turn.complete never came.
async function pruneSubagents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const stale = new Set(staleIds(mod.agents, mod.steps, now))
  for (const id of staleSpawns(Object.fromEntries(mod.spawned), mod.steps, now)) if (!mod.agents.has(id)) stale.add(id)
  await forgetSubagents($, [...stale])
}

/** At a session start: the spawns and the agents past a step before a reload are followed again, so a stop's deny holds. */
async function loadSubagents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const steps = new Map(Object.entries(work().steps))
  const spawned = mem.spawned ?? {}
  const oldSpawns = new Set(staleSpawns(spawned, steps, now))
  for (const [id, rec] of Object.entries(spawned)) if (!oldSpawns.has(id)) mod.spawned.set(id, rec)
  const stored = mem.subagents ?? {}
  const stale: string[] = []
  for (const [id, m] of Object.entries(stored)) {
    const step = steps.get(id)
    if (now - Math.max(m.at, step ?? m.at) >= PRUNE_AFTER_MS) stale.push(id)
    else mod.agents.set(id, fromMark(m))
  }
  if (stale.length) await patchMarks($, m => Object.fromEntries(Object.entries(m).filter(([id]) => !stale.includes(id))))
  if (oldSpawns.size) await patchSpawned($, m => Object.fromEntries(Object.entries(m).filter(([id]) => !oldSpawns.has(id))))
}

function subagentReport(config: Config, blocking: boolean, isPausedNow: boolean): SubagentReport {
  const budgets = Object.keys(config.subagents)
    .sort()
    .map(type => ({ type, budget: subagentBudget(config, type) }))
  const off = budgets.length && mod.role.role === null ? 'no role: not applied' : null
  const rows = [...mod.agents].flatMap(([id, t]) => {
    const b = budgetFor(config, t.identity)
    // Agents with no budget (engine forks, unnamed teammates) are no part of the table.
    if (!b && !t.warned) return []
    const state = t.stopped ? 'stopped' : t.warned ? 'warned' : 'under'
    return [{ id, type: identityType(t.identity), tokens: t.tokens, warn: b?.warn ?? null, stop: b?.stop ?? null, state } as const]
  })
  const noDeny = !blocking ? 'blocking is off in /config' : isPausedNow ? 'ctx-guard is paused' : null
  return { off, noDeny, budgets, rows: mod.role.role === null ? [] : rows }
}

// ---- trust ------------------------------------------------------------------

// The content hash of every ready-check argument that is a file under the root
// (checks run from the root); one that exists outside it is listed, the rest are plain words.
async function scriptHashes($: EngineInterface, config: Config, root: string): Promise<{ hashes: ScriptHashes; outside: string[] }> {
  const hashes: ScriptHashes = {}
  const outside: string[] = []
  const args = checkScripts(config)
  if (!args.length) return { hashes, outside }
  const realRoot = await realRootOf($, root)
  for (const p of args) {
    const abs = p.startsWith('/') ? p : `${root.replace(/[/\\]+$/, '')}/${p.replace(/^\.\//, '')}`
    try {
      if (!(await $.fs.exists(abs))) continue
      const at = await place($, abs, realRoot)
      if (at.kind === 'inside' && at.stat.kind === 'file') hashes[p] = sha256Hex(await $.fs.read(abs))
      else if (at.kind === 'outside') outside.push(p)
    } catch {
      outside.push(p)
    }
  }
  return { hashes, outside }
}

async function readTrust($: EngineInterface, root: string): Promise<TrustState | null> {
  const eff = mod.eff
  if (!eff) return (mod.trust = null)
  const record = asTrustRecord(await $.store.get(trustKey(root)).catch(() => undefined))
  const { hashes } = await scriptHashes($, eff.config, root).catch(() => ({ hashes: {} as ScriptHashes }))
  return (mod.trust = trustState(eff.config, record, hashes))
}

const trusted = (): boolean => mod.trust?.trusted === true

// The band's trust segment: only a repo with something trust gates (an automatic restart, a compact, ping or prompt trigger, a probe) shows one.
// True when an approval would turn something on: an automatic restart, a compact, ping or prompt trigger, a probe, a /ctx-guard wake.
function trustWanted(): boolean {
  const eff = mod.eff
  return eff !== null && (wantsTrust(eff.config) || configuredProbes().length > 0 || wakeSet())
}

function bandUntrusted(): string | null {
  return mod.eff ? untrustedText(mod.trust, trustWanted()) : null
}

function untrustedWhy(): string {
  const changed = mod.trust?.changed ?? []
  if (!mod.trust?.record) return 'never approved'
  return changed.length ? `changed since approval: ${changed.join(', ')}` : 'changed since approval'
}

// ---- paths under the root ---------------------------------------------------

type Place = { kind: 'absent' } | { kind: 'inside'; stat: FsStat } | { kind: 'outside' }

// A failed call on a path is a missing path only when the path does not exist either.
async function missing($: EngineInterface, abs: string): Promise<boolean> {
  return !(await $.fs.exists(abs).catch(() => true))
}

async function statOf($: EngineInterface, abs: string): Promise<FsStat | null> {
  try {
    return await $.fs.stat(abs, { resolve: true })
  } catch (e) {
    if (await missing($, abs)) return null
    throw e
  }
}

async function realRootOf($: EngineInterface, root: string): Promise<string> {
  const st = await $.fs.stat(root, { resolve: true })
  if (!st.realPath) throw new Error('the project root cannot be resolved')
  return st.realPath
}

/**
 * Where a path lands once every link is followed: a symlink out of the root
 * counts as outside, and so does a link that leads nowhere. A missing path
 * lands where its nearest existing folder does, so a write through a linked
 * parent is caught too.
 */
async function place($: EngineInterface, abs: string, realRoot: string): Promise<Place> {
  const own = await statOf($, abs)
  if (own) return own.realPath && isUnder(realRoot, own.realPath) ? { kind: 'inside', stat: own } : { kind: 'outside' }
  let dir = abs
  for (let i = 0; i < 64; i++) {
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (cut <= 0) return { kind: 'outside' }
    dir = dir.slice(0, cut)
    const st = await statOf($, dir)
    if (st) return st.kind === 'dir' && st.realPath && isUnder(realRoot, st.realPath) ? { kind: 'absent' } : { kind: 'outside' }
  }
  return { kind: 'outside' }
}

// The state folder, confined by spelling and by where it lands.
async function stateDirOf($: EngineInterface, root: string, realRoot: string, rel: string): Promise<string> {
  const c = confinePath(root, rel)
  if ('error' in c) throw new Error(`stateDir ${rel} ${c.error}`)
  if ((await place($, c.path, realRoot)).kind === 'outside') throw new Error(`stateDir ${rel} resolves outside the project root`)
  return c.path
}

async function handoffOf($: EngineInterface, root: string, realRoot: string, role: string, spec: RoleSpec): Promise<HandoffFact> {
  const rel = handoffPathFor(spec, role)
  const c = confinePath(root, rel)
  if ('error' in c) throw new Error(`handoff path ${rel} ${c.error}`)
  const p = await place($, c.path, realRoot)
  if (p.kind === 'outside') throw new Error(`handoff path ${rel} resolves outside the project root`)
  if (p.kind === 'absent') return { kind: 'absent', path: rel }
  if (p.stat.kind !== 'file') return { kind: 'absent', path: rel, why: 'is not a file' }
  if (p.stat.size <= 0) return { kind: 'absent', path: rel, why: 'is empty' }
  return { kind: 'present', path: rel, mtime: p.stat.mtimeMs }
}

async function readText($: EngineInterface, abs: string, realRoot: string): Promise<string | null> {
  const p = await place($, abs, realRoot)
  if (p.kind === 'outside') throw new Error(`${abs} resolves outside the project root`)
  return p.kind === 'absent' ? null : await $.fs.read(abs)
}

async function readStamp($: EngineInterface, abs: string, realRoot: string): Promise<{ stamp: StampRead; text: string | null }> {
  const p = await place($, abs, realRoot)
  if (p.kind === 'outside') throw new Error(`${abs} resolves outside the project root`)
  if (p.kind === 'absent') return { stamp: { kind: 'absent' }, text: null }
  try {
    const text = await $.fs.read(abs)
    return { stamp: parseStamp(text), text }
  } catch (e) {
    return { stamp: { kind: 'unreadable', detail: errorText(e) }, text: null }
  }
}

// ---- lease ------------------------------------------------------------------

function asLease(v: unknown): LeaseState | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  return {
    id: o.id,
    role: typeof o.role === 'string' ? o.role : null,
    beatAt: num(o.beatAt),
    sharedWith: typeof o.sharedWith === 'string' ? o.sharedWith : null,
  }
}

async function setLease($: EngineInterface, lease: LeaseState): Promise<void> {
  await put($, 'lease', lease)
}

// The id this session writes into owner files and stamps; minted once, kept across /clear and reloads.
async function leaseOf($: EngineInterface): Promise<LeaseState> {
  const held = mem.lease
  if (held) return held
  const sid = await $.session.id().catch(() => '')
  const lease: LeaseState = { id: sid || `session-${await $.clock.now()}`, role: null, beatAt: null, sharedWith: null }
  await setLease($, lease)
  return lease
}

async function ownerFile($: EngineInterface, role: string): Promise<{ abs: string; realRoot: string } | null> {
  const eff = mod.eff
  if (!eff) return null
  const root = await $.session.root()
  const realRoot = await realRootOf($, root)
  const dir = await stateDirOf($, root, realRoot, eff.config.stateDir)
  return { abs: leasePath(dir, role), realRoot }
}

async function readLease($: EngineInterface, role: string, id: string, now: number): Promise<Lease> {
  const f = await ownerFile($, role)
  if (!f) return { kind: 'free' }
  return leaseState(parseOwner(await readText($, f.abs, f.realRoot)), id, now)
}

async function releaseLease($: EngineInterface, lease: LeaseState): Promise<void> {
  if (lease.role === null) return
  const f = await ownerFile($, lease.role)
  if (!f) return
  const now = await $.clock.now()
  if (leaseState(parseOwner(await readText($, f.abs, f.realRoot)), lease.id, now).kind === 'mine') await $.fs.write(f.abs, ownerJson(lease.id, 0))
}

/**
 * The heartbeat of `{stateDir}/{role}.owner`, on measure and on the band
 * timer: written while the role is free (garbage counts as free) or this
 * session's, left alone (and toasted once) while another live session holds
 * it. A role change releases the old role first.
 */
async function leaseBeat($: EngineInterface, force: boolean): Promise<void> {
  if (!active()) return
  const role = mod.role.role
  let lease = await leaseOf($)
  if (lease.role !== role) {
    await quietly(() => releaseLease($, lease))
    lease = { ...lease, role, beatAt: null, sharedWith: null }
    await setLease($, lease)
  }
  if (role === null) return
  const now = await $.clock.now()
  if (!force && !heartbeatDue(lease.beatAt, now)) return
  const f = await ownerFile($, role)
  if (!f) return
  const held = leaseState(parseOwner(await readText($, f.abs, f.realRoot)), lease.id, now)
  if (held.kind === 'shared') {
    await noticeOnce(
      $,
      `lease:${role}:${held.sessionId}`,
      `ctx-guard: another live session (${held.sessionId}) holds role "${role}"; restarts here are refused (role-shared) until it ends.`,
    )
  } else await $.fs.write(f.abs, ownerJson(lease.id, now))
  await setLease($, { ...lease, beatAt: now, sharedWith: held.kind === 'shared' ? held.sessionId : null })
}

// ---- restart ----------------------------------------------------------------

// One band field changed with no new reading; nothing is written when it already holds `value`.
async function patchBand<K extends 'restartFailed' | 'subagentsOver'>($: EngineInterface, key: K, value: Band[K]): Promise<void> {
  if ((mem.band?.[key] ?? (key === 'subagentsOver' ? 0 : null)) === value) return
  const now = await $.clock.now()
  // Read after the await: a band written meanwhile is the base.
  const prev = mem.band
  const base: Band = prev ?? { role: mod.role.role, tokens: null, percent: null, window: null, cache: null, limits: [], probes: [], subagentsOver: 0, denies: [], restartFailed: null, untrusted: null, now }
  const band: Band = { ...base, [key]: value }
  await drawBand($, band)
}

async function setRestartFailed($: EngineInterface, text: string | null): Promise<void> {
  await patchBand($, 'restartFailed', text)
}

async function setVerdict($: EngineInterface, code: RefusalCode | 'ok', text: string): Promise<void> {
  await put($, 'lastVerdict', { code, text, at: await $.clock.now() })
}

async function refuse($: EngineInterface, code: RefusalCode, text: string): Promise<void> {
  const eff = mod.eff
  const token = eff?.config.readyToken ?? 'CTX-READY'
  const role = mod.role.role
  const via = eff && role !== null ? (roleSpec(eff.config, role)?.restart.via ?? 'clear') : 'clear'
  const line = refusalNote(token, code, text, via)
  await setVerdict($, code, text)
  $.ui.toast(line)
  await quietly(() => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: line }] } }))
}

type Gathered = {
  facts: Facts
  // Where the stamps are, for the race; null for via compact or a failed gather.
  stamps: { own: string; ownText: string | null; peers: { role: string; abs: string }[]; realRoot: string } | null
}

// What the module flags alone say is under way; read with no await, for a same-tick claim.
function syncBusy(): string | null {
  if (mod.compacting) return 'a /compact of this session is under way'
  if (mod.restarting) return 'a restart of this session is already under way'
  return null
}

async function busyText($: EngineInterface, now: number): Promise<string | null> {
  return syncBusy() ?? pendingBusy($, now)
}

async function restartBusy($: EngineInterface, now: number): Promise<string | null> {
  if (mod.restarting) return 'a restart of this session is already under way'
  return pendingBusy($, now)
}

async function pendingBusy($: EngineInterface, now: number): Promise<string | null> {
  const p = mem.pendingResume
  return pendingFresh(p, now) ? `a resume of ${p?.role ?? 'this role'} is pending since ${humanDuration(now - (p?.at ?? now))} ago` : null
}

// The fill now against the role's lowest context trigger threshold and its restart.minContext;
// unknown when it cannot be read.
async function contextFact($: EngineInterface, role: string, spec: RoleSpec): Promise<Facts['context']> {
  const eff = mod.eff
  try {
    const reading = await currentReading($)
    const triggers = eff ? triggersFor(eff.config, role) : []
    const window = windowFor(reading.context.window).tokens
    return { tokens: num(reading.context.tokens), floor: contextFloor(triggers, window), min: placeContext(spec.restart.minContext ?? null, window) }
  } catch {
    return { tokens: null, floor: null, min: null }
  }
}

// The operator's /ctx-guard:clear holds now (clearAskHolds).
function clearAsked(): boolean {
  const a = activity()
  return clearAskHolds(mem.clearAsk, mod.role.role, {
    restartAt: mem.lastRestartAt,
    clearAt: mem.lastClearAt,
    claimAt: mem.roleClaim?.at ?? null,
    roleChangedAt: a.roleChangedAt,
    closingStartAt: a.lastClosingStartAt,
    cutStartAt: a.lastCutStartAt,
    typedStartAt: a.lastTypedStartAt,
  })
}

/**
 * Every fact the verdict needs, read fresh: nothing cached by a timer is
 * trusted. `asked` is the clear ask as the token's turn ended, when a token's
 * restart gathers.
 */
async function gather($: EngineInterface, role: string, spec: RoleSpec, busy: string | null, asked = clearAsked()): Promise<Gathered> {
  // Fresh: a ready-check script edited since the last config load must not run under the old approval.
  try {
    await readTrust($, await $.session.root())
  } catch {
    mod.trust = null
  }
  const now = await $.clock.now()
  const via = spec.restart.via
  const facts: Facts = {
    via,
    role,
    trusted: trusted(),
    untrustedWhy: untrustedWhy(),
    busy,
    context: await contextFact($, role, spec),
    asked,
    lastRestartAt: mem.lastRestartAt,
    // A config another version stored may lack it.
    selfGap: spec.restart.selfGap ?? DEFAULT_SELF_GAP,
    command: via === 'compact' ? 'compact' : spec.restart.command,
    commands: [],
    agents: [],
    steps: [],
    background: null,
    lease: { kind: 'free' },
    handoff: { kind: 'absent', path: handoffPathFor(spec, role) },
    startedAt: 0,
    lastClearAt: null,
    ownStamp: { kind: 'absent' },
    peers: [],
    peerGap: spec.restart.peerGap,
    now,
    checks: null,
    error: null,
  }
  let stamps: Gathered['stamps'] = null
  try {
    facts.commands = (await $.command.list()).map(c => c.name)
    facts.agents = await $.agent.list()
    facts.steps = await recentSteps($, now)
    facts.background = blockingTasks(work().background, spec.restart.ignoreBackground ?? [])
    facts.startedAt = (await $.session.usage()).startedAt
    facts.lastClearAt = mem.lastClearAt
    if (via === 'clear') {
      const eff = mod.eff
      if (!eff) throw new Error('the config is not loaded')
      const root = await $.session.root()
      const realRoot = await realRootOf($, root)
      const dir = await stateDirOf($, root, realRoot, eff.config.stateDir)
      const lease = await leaseOf($)
      facts.lease = await readLease($, role, lease.id, now)
      facts.handoff = await handoffOf($, root, realRoot, role, spec)
      const own = await readStamp($, stampPath(dir, role), realRoot)
      facts.ownStamp = own.stamp
      const peers = spec.restart.peers.filter(p => p !== role).map(p => ({ role: p, abs: stampPath(dir, p) }))
      for (const p of peers) facts.peers = [...facts.peers, { role: p.role, stamp: (await readStamp($, p.abs, realRoot)).stamp }]
      stamps = { own: stampPath(dir, role), ownText: own.text, peers, realRoot }
    }
  } catch (e) {
    facts.error = errorText(e)
  }
  return { facts, stamps }
}

// What a script is told about the session; paths resolved against the root it runs from.
function scriptContextOf(
  root: string,
  purpose: ScriptPurpose,
  role: string | null,
  spec: RoleSpec | null,
  handoff: HandoffFact | null,
  startedAt: number,
  lastClearAt: number | null,
): ScriptContext {
  const at = (rel: string): string | null => {
    const c = confinePath(root, rel)
    return 'error' in c ? null : c.path
  }
  const via = spec ? spec.restart.via : null
  const held = via === 'clear' ? handoff : null
  return {
    purpose,
    role,
    root,
    stateDir: (mod.eff && at(mod.eff.config.stateDir)) ?? '',
    handoff: held ? at(held.path) : null,
    handoffMtime: held?.kind === 'present' ? held.mtime : null,
    startedAt,
    lastClearAt,
    via,
  }
}

// Exit 0 passes; any other exit, a start failure or a timeout fails. No output is kept.
async function runChecks($: EngineInterface, spec: RoleSpec, facts: Facts, purpose: 'ready-check' | 'dry-run'): Promise<CheckRun[]> {
  const root = await $.session.root()
  const env = scriptEnv(scriptContextOf(root, purpose, facts.role, spec, facts.handoff, facts.startedAt, facts.lastClearAt))
  const out: CheckRun[] = []
  for (const c of spec.restart.readyChecks) {
    let run: CheckRun
    try {
      const r = await $.process.run(c.run, { cwd: root, timeoutMs: c.timeout, env })
      run = { run: c.run, ok: r.exitCode === 0, detail: r.exitCode === 0 ? 'exited 0' : checkDetail(r.exitCode, r.stderr, r.stdout) }
    } catch (e) {
      run = { run: c.run, ok: false, detail: `did not finish within ${humanDuration(c.timeout)} or could not start (${errorText(e)})` }
    }
    out.push(run)
    if (!run.ok) break
  }
  return out
}

// The verdict before the race: facts, then the ready checks once everything else holds.
async function judge($: EngineInterface, g: Gathered, spec: RoleSpec): Promise<Verdict> {
  let v = verdict(g.facts)
  if (v.ok && g.facts.trusted) {
    g.facts.checks = await runChecks($, spec, g.facts, 'ready-check')
    v = verdict(g.facts)
  }
  return v
}

// The ready checks can take minutes: just before the stamp and again before /clear, nothing new may have started.
async function quiet($: EngineInterface, tokenAt: number): Promise<Verdict> {
  const now = await $.clock.now()
  const a = activity()
  return quietVerdict({
    tokenAt,
    turnRunning: turnRunningIn(a, now),
    lastMainEndAt: a.lastMainEndAt,
    agents: await $.agent.list(),
    steps: await recentSteps($, now),
    background: busyTasks(),
  })
}

// The last Stop's tasks that hold a restart or compact back, for the session's role (blockingTasks).
function busyTasks(): BackgroundTask[] | null {
  const role = mod.role.role
  const spec = mod.eff && role !== null ? roleSpec(mod.eff.config, role) : null
  return blockingTasks(work().background, spec?.restart.ignoreBackground ?? [])
}

const settle = ($: EngineInterface, ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    $.clock.after(ms, () => resolve())
  })

/**
 * The resume command, run once: pendingResume moves to `sent` first, so a
 * reload while it runs flags the band instead of sending it twice. A copy a
 * reload replaced leaves the band and pendingResume to the new copy.
 */
async function resume($: EngineInterface, p: PendingResume, gen: Mod): Promise<void> {
  const args = resumeArgs(p.role, p.handoff, p.prompt)
  await put($, 'pendingResume', { ...p, step: 'sent' })
  try {
    await $.command.run({ command: p.command, args })
    if (gen === mod) await setRestartFailed($, null)
  } catch (e) {
    if (gen !== mod) return
    await setRestartFailed($, restartFailedText(p.command, p.role, p.handoff))
    await setVerdict($, 'error', `cleared, but /${p.command} did not run: ${errorText(e)}`)
    $.ui.toast(`ctx-guard: ${p.role} was cleared, but /${p.command} did not run; type /${p.command} role=${p.role} handoff=${p.handoff}`)
  } finally {
    if (gen === mod) await put($, 'pendingResume', null)
  }
}

/**
 * The ready token's restart, run from a timer: gather, judge (ready checks
 * last), re-check that nothing started, write the own stamp, let a racing
 * peer's write land, judge the race, re-check again, then pendingResume →
 * /clear → resume → cleared. Fails closed: nothing is cleared unless every
 * check held, and a refusal after the stamp was written puts the old one back.
 */
async function restartFlow($: EngineInterface, tokenAt: number, asked: boolean): Promise<void> {
  const gen = mod
  const eff = mod.eff
  const role = mod.role.role
  const spec = eff && role !== null ? roleSpec(eff.config, role) : null
  if (!active() || !eff || role === null || !spec) return
  // Claimed before the first await, so a compact tried in the same tick sees it (and this sees a compact's).
  let busy = syncBusy()
  const claimed = busy === null
  if (claimed) gen.restarting = true
  let cleared = false
  let retryCompact = true
  try {
    if (busy === null) busy = await pendingBusy($, await $.clock.now())
    const g = await gather($, role, spec, busy, asked)
    const v = await judge($, g, spec)
    if (!v.ok) return await refuse($, v.code, v.text)
    if (gen !== mod) return
    if (spec.restart.via === 'compact') {
      if ((await compactRestart($, role, spec, tokenAt, gen)) === 'failed') retryCompact = false
      return
    }
    const stamps = g.stamps
    if (!stamps || g.facts.handoff.kind !== 'present') return await refuse($, 'error', 'the restart stamps could not be placed')
    const before = await quiet($, tokenAt)
    if (!before.ok) return await refuse($, before.code, before.text)
    const lease = await leaseOf($)
    const restore = async (): Promise<void> => {
      await $.fs.write(stamps.own, stamps.ownText ?? stampJson(lease.id, 0))
      await put($, 'stamp', null)
    }
    const at = await $.clock.now()
    await put($, 'stamp', { path: stamps.own, previous: stamps.ownText, at, owner: lease.id, peerGap: spec.restart.peerGap })
    await $.fs.write(stamps.own, stampJson(lease.id, at))
    await settle($, RACE_SETTLE_MS)
    if (gen !== mod) return await quietly(restore)
    const again: { role: string; stamp: StampRead }[] = []
    try {
      for (const p of stamps.peers) again.push({ role: p.role, stamp: (await readStamp($, p.abs, stamps.realRoot)).stamp })
    } catch (e) {
      await quietly(restore)
      return await refuse($, 'error', errorText(e))
    }
    const race = raceVerdict({ at, owner: lease.id }, again, spec.restart.peerGap, await $.clock.now())
    const last = race.ok ? await quiet($, tokenAt) : race
    if (!last.ok) {
      await quietly(restore)
      return await refuse($, last.code, last.text)
    }
    const pending: PendingResume = { role, handoff: g.facts.handoff.path, command: spec.restart.command, prompt: spec.restart.prompt, step: 'clear', at }
    await put($, 'pendingResume', pending)
    // From here the stamp stands for a real restart.
    await put($, 'stamp', null)
    await setVerdict($, 'ok', `cleared and resumed from ${pending.handoff}`)
    $.ui.toast(`ctx-guard: clearing ${role}; resuming from ${pending.handoff}`)
    try {
      await $.command.run({ command: 'clear' })
      cleared = true
      // The /clear emptied `$.state`: memory goes back into it.
      if (needsReady()) await ready($)
      await put($, 'lastRestartAt', await $.clock.now())
    } catch (e) {
      await put($, 'pendingResume', null)
      await quietly(restore)
      return await refuse($, 'error', `/clear was refused: ${errorText(e)}`)
    }
    // A reload during /clear leaves the resume to the new copy's session start.
    if (gen !== mod) return
    const next: PendingResume = { ...pending, step: 'resume' }
    await put($, 'pendingResume', next)
    await resume($, next, gen)
  } catch (e) {
    await refuse($, 'error', errorText(e))
  } finally {
    if (claimed) gen.restarting = false
    // Nothing was cleared: a compact queued for this turn end gets the try it gave up.
    if (claimed && !cleared && retryCompact && gen === mod) await quietly(() => compactAtTurnEnd($))
  }
}

// The main loop's answer ends on the ready token, and ctx-guard may act on it.
// Answers whether a restart was scheduled.
async function onReadyToken($: EngineInterface, token: boolean): Promise<boolean> {
  const eff = mod.eff
  const role = mod.role.role
  if (!token || !active() || !eff || role === null) return false
  const spec = roleSpec(eff.config, role)
  // Manual mode, auto actions off or a pause: the notes already told the model to ask the operator.
  if (!spec || spec.restart.mode !== 'auto' || !eff.autoActions) return false
  const now = await $.clock.now()
  if (paused(now)) return false
  // This turn's end, just recorded: any later turn means the session moved on.
  const tokenAt = activity().lastMainEndAt ?? now
  const asked = clearAsked()
  $.clock.after(0, () => void quietly(() => timed($, () => restartFlow($, tokenAt, asked))))
  return true
}

// The main turn ended on the ready token, whether or not ctx-guard acts on it.
const tokenAnswer = (e: TurnCompleteInput): boolean => e.reason === 'answer' && mod.eff !== null && isReadyAnswer(e.answer, mod.eff.config.readyToken)

// ---- compact ------------------------------------------------------------------

async function turnRunning($: EngineInterface, now: number): Promise<boolean> {
  return turnRunningIn(activity(), now)
}

const getPendingCompact = (): PendingCompact | null => mem.pendingCompact

async function noteCompact($: EngineInterface, outcome: LastCompact['outcome'], source: string, text: string): Promise<void> {
  const now = await $.clock.now()
  await change($, 'lastCompact', v => nextLastCompact(v, outcome, source, text, now))
}

async function dropCompact($: EngineInterface, p: PendingCompact, text: string, toast: boolean): Promise<void> {
  mod.compactAfter = null
  await put($, 'pendingCompact', null)
  await noteCompact($, 'dropped', p.triggerId, text)
  if (toast) $.ui.toast(`ctx-guard: the queued /compact for trigger "${p.triggerId}" was dropped: ${text}.`)
}

const rearmedText = (id: string): string => `trigger "${id}" re-armed before /compact could run: its figures fell back below the threshold`

// The same pending compact as `p`, still at `step`: nothing replaced or dropped it meanwhile.
const samePending = (cur: PendingCompact | null, p: PendingCompact, step: PendingCompact['step']): cur is PendingCompact =>
  cur !== null && cur.step === step && cur.at === p.at && cur.triggerId === p.triggerId

// Rewrites the pending compact only while it is still `p` at `step`; answers whether it did.
async function movePending($: EngineInterface, p: PendingCompact, step: PendingCompact['step'], fn: (cur: PendingCompact) => PendingCompact | null): Promise<boolean> {
  const cur = mem.pendingCompact
  if (!samePending(cur, p, step)) return false
  await put($, 'pendingCompact', fn(cur))
  return true
}

function compactGateNow(isPaused: boolean): ReturnType<typeof compactGate> {
  const eff = mod.eff
  return compactGate({ autoActions: eff?.autoActions === true, trusted: trusted(), paused: isPaused, untrustedWhy: untrustedWhy() })
}

function scheduleCompact($: EngineInterface, delay = 0): void {
  if (delay > 0) {
    // One hold timer at a time; a reload drops it and the session start sets it again.
    mod.compactTimer?.cancel()
    mod.compactTimer = $.clock.after(delay, () => {
      mod.compactTimer = null
      void quietly(() => timed($, () => tryCompact($)))
    })
    return
  }
  $.clock.after(0, () => void quietly(() => timed($, () => tryCompact($))))
}

/**
 * A compact trigger's rising edge: queued in $.state, so a reload keeps it,
 * and tried at once when no main turn runs, else at the next main-loop turn
 * end. Auto actions off, an untrusted repo or a pause leave it blocked, with
 * one toast per reason, until that lifts. One already waiting wins; one right
 * after a compact ran is held until the quiet period ends. `afterPrompt`: the
 * fire's prompt went in, so it waits for that prompt's turn to end, and the
 * re-arm that turn brings does not drop it.
 */
async function requestCompact($: EngineInterface, fire: Fire, role: string, isPaused: boolean, afterPrompt = false): Promise<void> {
  const id = fire.trigger.id
  const now = await $.clock.now()
  const r = compactRequest(getPendingCompact(), mem.lastCompact, now)
  if (r.kind !== 'queue') return
  const gate = compactGateNow(isPaused)
  const p: PendingCompact = { role, triggerId: id, step: gate ? 'blocked' : 'queued', at: now, notBefore: r.notBefore, waiting: gate?.text ?? null }
  await put($, 'pendingCompact', p)
  if (gate) {
    await noteCompact($, 'skipped', id, gate.text)
    await noticeOnce($, `compact-skip:${gate.code}`, `ctx-guard: /compact for trigger "${id}" skipped: ${gate.text}.`)
    return
  }
  if (r.notBefore !== null) await noteCompact($, 'held', id, `held until ${humanDuration(COMPACT_QUIET_MS)} after the last compact`)
  if (afterPrompt) {
    mod.compactAfter = p.at
    return
  }
  if (await turnRunning($, now)) return
  // Lift work under way: the compact waits for the next turn end, or for that work to end with none.
  if (liftWork()) {
    mod.compactAfterLift = p.at
    return
  }
  scheduleCompact($)
}

// The compact waiting for ctx-guard's prompt turn to end: its trigger's mark does not decide it meanwhile.
const afterPromptTurn = (p: PendingCompact): boolean => mod.compactAfter === p.at

/** A blocked compact whose gate lifted (trust approved, a pause over, auto actions on) is queued again. */
async function unblockCompact($: EngineInterface, isPaused: boolean): Promise<void> {
  const p = getPendingCompact()
  if (!p || p.step !== 'blocked' || compactGateNow(isPaused)) return
  if (!markHeld(mem.marks, mod.role.role, p.triggerId)) return await dropCompact($, p, rearmedText(p.triggerId), false)
  if (!(await movePending($, p, 'blocked', cur => ({ ...cur, step: 'queued', waiting: null })))) return
  if (!(await turnRunning($, await $.clock.now()))) scheduleCompact($)
}

// The marks just moved: a waiting compact whose trigger re-armed has nothing left to do.
async function dropRearmedCompact($: EngineInterface, marks: Marks): Promise<void> {
  const p = getPendingCompact()
  if (p && p.step !== 'sent' && !afterPromptTurn(p) && !markHeld(marks, p.role, p.triggerId)) await dropCompact($, p, rearmedText(p.triggerId), p.step === 'queued')
}

/** `/compact {instructions}`; the fill it leaves is unknown until the next reading. Throws when it did not run. */
async function runCompact($: EngineInterface, instructions: string | null, gen: Mod): Promise<void> {
  const args = compactArgs(instructions)
  await $.command.run(args ? { command: 'compact', args } : { command: 'compact' })
  if (gen !== mod) return
  const reading: MainReading = { tokens: null, at: await $.clock.now() }
  mod.lastMain = reading
  mod.gates = null
  await patchActivity($, a => ({ ...a, lastMain: reading }))
}

/**
 * A queued compact, tried at a main-loop turn end (or at once when queued
 * idle, or when its hold ends): run when ctx-guard is on for the same role,
 * auto actions are allowed, its trigger is still marked and no turn, restart,
 * agent or background task is busy. Busy, it stays queued for the next turn
 * end, with one toast.
 */
async function tryCompact($: EngineInterface): Promise<void> {
  if (mod.compactTrying || mod.compacting) return
  const gen = mod
  gen.compactTrying = true
  try {
    const p = getPendingCompact()
    if (!p || p.step !== 'queued') return
    const eff = mod.eff
    const role = mod.role.role
    const spec = eff && role !== null ? roleSpec(eff.config, role) : null
    if (!active() || !eff || !spec) return await dropCompact($, p, 'ctx-guard is off', false)
    if (role !== p.role) return await dropCompact($, p, `the role is now ${role ?? 'none'}`, true)
    const now = await $.clock.now()
    const gate = compactGateNow(paused(now))
    if (gate) {
      await movePending($, p, 'queued', cur => ({ ...cur, step: 'blocked', waiting: gate.text }))
      await noteCompact($, 'skipped', p.triggerId, gate.text)
      return await noticeOnce($, `compact-skip:${gate.code}`, `ctx-guard: /compact for trigger "${p.triggerId}" skipped: ${gate.text}.`)
    }
    // A compact behind ctx-guard's prompt skips the mark check; tried with no turn running, that turn is over and the exemption spent.
    const afterPrompt = afterPromptTurn(p)
    // Its prompt has not gone in yet: the compact waits for that prompt's turn.
    if (afterPrompt && mod.retry?.kind === 'prompt') return
    if (afterPrompt && !(await turnRunning($, now))) mod.compactAfter = null
    if (!afterPrompt && !markHeld(mem.marks, role, p.triggerId)) return await dropCompact($, p, rearmedText(p.triggerId), true)
    if (p.notBefore !== null && now < p.notBefore) {
      const held = `held until ${humanDuration(COMPACT_QUIET_MS)} after the last compact (${humanDuration(p.notBefore - now)} more)`
      await movePending($, p, 'queued', cur => ({ ...cur, waiting: held }))
      return scheduleCompact($, p.notBefore - now)
    }
    // Held after a compact, its edge may have come from a reading taken before it: the engine's own figures now decide.
    if (p.notBefore !== null) {
      const trigger = roleTriggers().find(t => t.id === p.triggerId)
      const u = await $.session.usage()
      const holds = trigger ? triggerHolds(trigger, await metricsFor($, u, now)) : false
      if (holds !== true) {
        // The engine's figure replaces the stale one, and the trigger re-arms, so only a real crossing fires it again.
        await rememberMain($, num(u.context.tokens), now)
        await clearMark($, role, p.triggerId)
        return await dropCompact($, p, holds === null ? 'no reading since the last compact' : 'the context since the last compact is below the threshold', true)
      }
    }
    // A lift check out or being decided: the compact waits for that work to end, or for the next turn end.
    if (mod.checking !== null || mod.deciding) {
      mod.compactAfterLift = p.at
      return
    }
    const busy = compactBusy({
      turnRunning: await turnRunning($, now),
      restart: await restartBusy($, now),
      agents: await $.agent.list(),
      steps: await recentSteps($, now),
      background: busyTasks(),
    })
    if (busy) {
      // One toast per wait: the first busy try, or the first after a hold ended.
      if (p.waiting === null || p.waiting.startsWith('held')) {
        $.ui.toast(`ctx-guard: /compact for trigger "${p.triggerId}" waits (${busy}); it runs at a main-loop turn end with nothing running.`)
      }
      await movePending($, p, 'queued', cur => ({ ...cur, waiting: busy }))
      return
    }
    // Queued → sent in one write, so a drop that landed meanwhile is never undone.
    if (!(await movePending($, p, 'queued', cur => ({ ...cur, step: 'sent' })))) return
    // A restart claims its flag before its first await: checked with no await since, the two never both go.
    if (mod.restarting || gen !== mod) {
      await movePending($, p, 'sent', cur => ({ ...cur, step: 'queued', waiting: 'a restart of this session is already under way' }))
      return
    }
    gen.compacting = true
    if (mod.compactAfterLift === p.at) mod.compactAfterLift = null
    // A wake prompt waiting to go is judged again from the start once the context is compacted, as
    // the same attempt: its hold keeps the attempt charged (`tries` 1), so the new check counts nothing.
    if (liftsNow().pending) {
      await putLifts($, l => (l.pending ? { ...l, pending: null, holds: stamp(l.holds, [l.pending.triggerId], hold => ({ ...hold, tries: 1 })) } : l))
    }
    $.ui.toast(`ctx-guard: compacting ${role} (trigger "${p.triggerId}")`)
    try {
      await runCompact($, spec.compact.instructions, gen)
      // Shared state, written whichever copy is current: no compact action follows it too soon.
      await noteCompact($, 'ran', p.triggerId, `compacted by trigger "${p.triggerId}"`)
    } catch (e) {
      if (gen === mod) {
        await noteCompact($, 'failed', p.triggerId, `/compact did not run: ${errorText(e)}`)
        $.ui.toast(`ctx-guard: /compact for trigger "${p.triggerId}" did not run: ${errorText(e)}`)
      }
    } finally {
      gen.compacting = false
      if (gen === mod) await put($, 'pendingCompact', null)
    }
  } finally {
    gen.compactTrying = false
  }
}

// A main-loop turn ended with no restart on its ready token: a queued compact gets its try.
async function compactAtTurnEnd($: EngineInterface): Promise<void> {
  if (!active()) return
  if ((getPendingCompact())?.step === 'queued') scheduleCompact($)
}

async function rearmCompactHold($: EngineInterface): Promise<void> {
  const p = getPendingCompact()
  const now = await $.clock.now()
  if (p?.step === 'queued' && p.notBefore !== null && now < p.notBefore) scheduleCompact($, p.notBefore - now)
}

/** At a session start: a waiting compact is tried again (or its hold set again); one a reload caught mid-send is never sent twice. */
async function compactAtStart($: EngineInterface): Promise<void> {
  const p = getPendingCompact()
  if (!p) return
  if (p.step === 'sent') return await dropCompact($, p, 'a reload came while /compact was being sent; it may not have run', false)
  const now = await $.clock.now()
  if (p.step === 'blocked') return await unblockCompact($, paused(now))
  if (p.notBefore !== null && now < p.notBefore) return scheduleCompact($, p.notBefore - now)
  if (!(await turnRunning($, now))) scheduleCompact($)
}

/**
 * `restart.via: compact` once the verdict (no handoff, peer or lease checks)
 * and the re-check held: `/compact {compact.instructions}`, no resume after.
 * A compact a trigger left waiting is marked sent first, so a reload while
 * this runs never sends a second one; it is served by this one.
 */
// Answers 'failed' when /compact itself did not run, so the queued compact is not retried at once.
async function compactRestart($: EngineInterface, role: string, spec: RoleSpec, tokenAt: number, gen: Mod): Promise<'failed' | 'done'> {
  const before = await quiet($, tokenAt)
  if (!before.ok) {
    await refuse($, before.code, before.text)
    return 'done'
  }
  gen.compacting = true
  const waiting = getPendingCompact()
  const served = waiting && waiting.step !== 'sent' && (await movePending($, waiting, waiting.step, cur => ({ ...cur, step: 'sent' }))) ? waiting : null
  try {
    await setVerdict($, 'ok', 'compacted on the ready token')
    $.ui.toast(`ctx-guard: compacting ${role} on the ready token`)
    await runCompact($, spec.compact.instructions, gen)
  } catch (e) {
    // Nothing ran: a compact the trigger queued waits again.
    if (served && gen === mod) await movePending($, served, 'sent', cur => ({ ...cur, step: served.step }))
    await refuse($, 'error', `/compact was refused: ${errorText(e)}`)
    return 'failed'
  } finally {
    gen.compacting = false
  }
  await put($, 'lastRestartAt', await $.clock.now())
  await noteCompact($, 'ran', 'ready token', 'compacted on the ready token')
  if (gen === mod && served) await movePending($, served, 'sent', () => null)
  return 'done'
}

async function clearMark($: EngineInterface, role: string, id: string): Promise<void> {
  const v = mem.marks
  if (v && v.role === role && typeof v.byId === 'object' && v.byId !== null && Object.hasOwn(v.byId, id)) {
    const byId = { ...v.byId }
    delete byId[id]
    await put($, 'marks', { ...v, byId })
  }
  mod.gates = null
}

/** A pending resume a reload left behind: finished once, flagged when sent or stale, dropped when never cleared. */
async function finishPending($: EngineInterface): Promise<void> {
  const p = mem.pendingResume
  if (!p) return
  await put($, 'pendingResume', null)
  const now = await $.clock.now()
  const a = pendingAction(p, mem.lastClearAt, now)
  const again = `type /${p.command} role=${p.role} handoff=${p.handoff}`
  switch (a.kind) {
    case 'resume': {
      const gen = mod
      gen.restarting = true
      try {
        await resume($, { ...p, step: 'resume' }, gen)
      } finally {
        gen.restarting = false
      }
      return
    }
    case 'sent':
      await setRestartFailed($, restartFailedText(p.command, p.role, p.handoff))
      await setVerdict($, 'error', `a reload came while /${p.command} was being sent; it may not have run`)
      $.ui.toast(`ctx-guard: a reload came while the resume of ${p.role} was being sent; if it did not run, ${again}`)
      return
    case 'stale':
      await setRestartFailed($, restartFailedText(p.command, p.role, p.handoff))
      await setVerdict($, 'error', `a restart of ${p.role} was interrupted ${humanDuration(now - p.at)} ago; too old to finish`)
      $.ui.toast(`ctx-guard: a restart of ${p.role} was interrupted and is too old to finish; ${again}`)
      return
    case 'not-cleared':
      dropped = { at: now, pending: p }
      await setVerdict($, 'error', 'a reload interrupted the restart before /clear; nothing was cleared')
      $.ui.toast('ctx-guard: a reload interrupted a restart before /clear; nothing was cleared.')
  }
}

// ---- keep-warm: ping and prompt ---------------------------------------------------

const PING_PROMPT = 'Reply with OK.'
const PING_TIMEOUT_MS = 2 * 60 * 1000
// A ping's or a lift check's fork not settled this long after it went counts as gone: its slot is free.
const FORK_GONE_MS = 2 * PING_TIMEOUT_MS
// A refused prompt is tried this many times in all.
const PROMPT_TRIES = 3

// The highest usage window, in percent; 0 with none.
const usageHigh = (m: Metrics): number => Math.max(m.limits.five_hour?.pct ?? 0, m.limits.seven_day?.pct ?? 0)

// No ping now: one is in flight, a main turn runs, the period went cold, the cache
// expired or a usage window is at ping.maxUsage. The caller checked role, trust and pause.
const pingSkipped = (m: Metrics): boolean =>
  mod.pinging !== null ||
  turnRunningIn(activity(), m.now) ||
  cacheState().cold ||
  (m.cache.expiresIn ?? 0) <= 0 ||
  usageHigh(m) >= cacheConfig().ping.maxUsage

/**
 * Marks a fork in `mod[key]` until the returned release runs (it settled) or
 * FORK_GONE_MS passes, whichever is first, so a fork that never settles
 * cannot hold the slot for good. A later fork's mark stays.
 */
function holdSlot($: EngineInterface, key: 'pinging' | 'liftForking'): () => void {
  const gen = mod
  const mark = Symbol(key)
  gen[key] = mark
  const release = (): void => {
    if (gen[key] === mark) gen[key] = null
  }
  const gone = $.clock.after(FORK_GONE_MS, release)
  return () => {
    gone.cancel()
    release()
  }
}

/**
 * A fork over the main thread's own prefix: the model never sees it, and a
 * warm read keeps the cache alive. It runs off `serial`, one at a time, so a
 * /clear, a measure or a command never waits on it; its answer is applied in
 * `serial`, and dropped when a /clear or a reload came meanwhile. An error or
 * a timeout leaves a retry for the next idle tick.
 */
function runPing($: EngineInterface, fire: Fire, m: Metrics, tries: number): void {
  // Lift work under way, or a lift check's fork still out: the ping waits for the next idle tick.
  if (liftWork() || forkOut(liftsNow(), m.now)) {
    if (mod.retry === null) mod.retry = { kind: 'ping', fire, tries }
    return
  }
  if (pingSkipped(m)) return
  const gen = mod
  const clears = mod.clears
  const release = holdSlot($, 'pinging')
  void quietly(async () => {
    const at = await $.clock.now()
    try {
      // Written before the fork, so a module copy after a reload knows it is out.
      await setCache($, c => ({ ...c, pingAt: at }))
      const fork = $.model.fork({ prompt: PING_PROMPT }).catch(() => null)
      let expire = (): void => {}
      const timeout = new Promise<'timeout'>(resolve => {
        expire = () => resolve('timeout')
      })
      const timer = $.clock.after(PING_TIMEOUT_MS, expire)
      const r = await Promise.race([fork, timeout])
      timer.cancel()
      await serial(async () => {
        if (gen !== mod || clears !== mod.clears) return
        if (r === 'timeout' || r === null || !r.isAnswered) {
          // A prompt waiting for its retry keeps the slot: a compact may wait behind it.
          if (mod.retry?.kind !== 'prompt') mod.retry = { kind: 'ping', fire, tries: tries + 1 }
          $.ui.log(`ctx-guard: ping failed (${r === 'timeout' ? 'timeout' : r === null ? 'error' : r.reason})`, { to: 'debug' })
          return
        }
        if (mod.retry?.kind === 'ping') mod.retry = null
        const now = await $.clock.now()
        await setCache($, c => onPing(c, pingVerdict(r.usage), now))
        $.ui.log(`ctx-guard: ping read ${r.usage.cache_read_input_tokens}, wrote ${r.usage.cache_creation_input_tokens}`, { to: 'debug' })
        await refreshBand($, 'changed')
      })
      // One request at a time: a timed-out fork still holds the slot until it is over, or counts as gone.
      await fork
    } finally {
      release()
      // A newer ping's stamp stays.
      await setCache($, c => (c.pingAt === at ? { ...c, pingAt: null } : c))
    }
  })
}

// A prompt went in, waits for a retry, gave up, or was skipped at cache.prompt.maxUsage.
type PromptOutcome = 'went' | 'retry' | 'gave-up' | 'skipped'

/**
 * A real turn: the model reads the text and answers, and its turn warms the
 * cache too. While a main turn runs it is put off to the next idle tick, no
 * try spent. A refusal (a hook's `drop`, or a throw) leaves a retry while
 * tries remain; after the last, a compact waiting behind it is dropped. Idle,
 * a prompt from a trigger on a cache metric is skipped while a usage window
 * is at cache.prompt.maxUsage.
 */
async function runPrompt($: EngineInterface, fire: Fire, role: string, spec: RoleSpec, m: Metrics, tries: number): Promise<PromptOutcome> {
  if (turnRunningIn(activity(), await $.clock.now())) {
    mod.retry = { kind: 'prompt', fire, tries }
    return 'retry'
  }
  // Lift work under way: the prompt waits for the next idle tick, and holds that work back meanwhile.
  if (liftWork()) {
    mod.retry = { kind: 'prompt', fire, tries, deferred: true }
    return 'retry'
  }
  if (onCacheMetric(fire.trigger) && usageHigh(m) >= cacheConfig().prompt.maxUsage) return 'skipped'
  const text = promptText(fire, { role, handoffPath: handoffPathFor(spec, role), readyToken: mod.eff?.config.readyToken ?? '' })
  let went = false
  await quietly(async () => {
    const r = await submitOwnPrompt($, text)
    went = r.drop === undefined
  })
  if (went) {
    if (mod.retry?.kind === 'prompt') mod.retry = null
    return 'went'
  }
  if (tries < PROMPT_TRIES) {
    mod.retry = { kind: 'prompt', fire, tries: tries + 1 }
    return 'retry'
  }
  await giveUpPrompt($, `its prompt was refused ${PROMPT_TRIES} times`)
  return 'gave-up'
}

// A prompt that will not go in: its retry ends, and so does a compact waiting behind it.
async function giveUpPrompt($: EngineInterface, why: string): Promise<void> {
  if (mod.retry?.kind === 'prompt') mod.retry = null
  const p = getPendingCompact()
  if (p && afterPromptTurn(p)) await dropCompact($, p, why, true)
}

// A retried prompt skipped at cache.prompt.maxUsage: its retry ends, and a compact waiting behind it
// goes ahead as an ordinary one, its trigger's mark deciding it again.
async function skipPromptRetry($: EngineInterface): Promise<void> {
  if (mod.retry?.kind === 'prompt') mod.retry = null
  const p = getPendingCompact()
  if (!p || !afterPromptTurn(p)) return
  mod.compactAfter = null
  if (!(await turnRunning($, await $.clock.now()))) scheduleCompact($)
}

/**
 * On an idle tick: a failed or put-off ping or prompt is tried again while
 * its trigger still holds (a ping also only while the cache is unexpired); the
 * trigger does not fire again for it. Trust lost, a pause or the role gone
 * drops it; a dropped prompt takes the compact waiting behind it along.
 */
async function retryAuto($: EngineInterface): Promise<void> {
  const r = mod.retry
  if (!r) return
  const role = mod.role.role
  const spec = role === null || !mod.eff ? null : roleSpec(mod.eff.config, role)
  const now = await $.clock.now()
  const drop = async (why: string): Promise<void> => {
    if (r.kind === 'prompt') await giveUpPrompt($, why)
    else mod.retry = null
  }
  if (!active() || role === null || !spec) return await drop('ctx-guard is off')
  const gate = compactGateNow(paused(now))
  if (gate) return await drop(gate.text)
  const m = await metricsFor($, await currentReading($), now)
  const expired = r.kind === 'ping' && (m.cache.expiresIn ?? 0) <= 0
  if (expired || triggerHolds(r.fire.trigger, m) !== true) return await drop(`trigger "${r.fire.trigger.id}" no longer holds`)
  if (r.kind === 'ping') runPing($, r.fire, m, r.tries)
  else if ((await runPrompt($, r.fire, role, spec, m, r.tries)) === 'skipped') await skipPromptRetry($)
}


// ---- lifts: holds, lift checks and wake prompts ----------------------------------

// A lift check's outcome, for the evaluation that follows it: fresh figures, or its last try failed.
type LiftCheck = 'fresh' | 'failed'

const liftsNow = (): Lifts => liftsFor(mem.lifts, mod.role.role)

// Read-modify-write on memory; nothing is written when nothing changed.
async function putLifts($: EngineInterface, fn: (l: Lifts) => Lifts): Promise<void> {
  const cur = liftsNow()
  const next = fn(cur)
  if (JSON.stringify(next) !== JSON.stringify(cur)) await put($, 'lifts', next)
}

// `holds` with `fn` applied to each of `ids` it has.
function stamp(holds: Readonly<Record<string, Hold>>, ids: readonly string[], fn: (hold: Hold, id: string) => Hold): Record<string, Hold> {
  const out = { ...holds }
  for (const id of ids) {
    const hold = Object.hasOwn(out, id) ? out[id] : undefined
    if (hold) out[id] = fn(hold, id)
  }
  return out
}

function without(holds: Readonly<Record<string, Hold>>, ids: readonly string[]): Record<string, Hold> {
  const out = { ...holds }
  for (const id of ids) delete out[id]
  return out
}

const liftTriggers = (): Trigger[] => roleTriggers().filter(t => t.lift !== null && t.lift !== undefined)

// A /ctx-guard wake is set for the role.
const wakeSet = (): boolean => Object.hasOwn(liftsNow().holds, WAKE_ID)

// Lifts are in play: a trigger with `lift`, or a /ctx-guard wake.
const liftsOn = (): boolean => liftTriggers().length > 0 || wakeSet()

// Lift work: a lift check in flight or being decided, or a wake prompt waiting to go. It does not overlap ctx-guard's other automatic actions.
const liftWork = (): boolean => mod.checking !== null || mod.deciding || liftsNow().pending !== null

const wakeGateNow = (isPaused: boolean): WakeGate => ({ trusted: trusted(), autoActions: mod.eff?.autoActions === true, paused: isPaused })

/**
 * What holds lift work back: a trigger prompt waiting in its retry slot, a
 * ping holding the fork slot, a compact or a restart running, or a compact
 * queued for the end of the turn (once a try found the session busy, it no
 * longer does). A compact that itself waits for lift work holds nothing back,
 * nor one behind a trigger prompt put off for that work.
 */
function liftHeldBack(): boolean {
  const deferred = mod.retry?.kind === 'prompt' && mod.retry.deferred === true
  if (mod.retry?.kind === 'prompt' && !deferred) return true
  if (mod.pinging !== null || mod.compacting || mod.compactTrying || mod.restarting) return true
  const p = mem.pendingCompact
  if (p === null || p.step !== 'queued' || p.waiting !== null || p.at === mod.compactAfterLift) return false
  return !(deferred && afterPromptTurn(p))
}

// A keep-warm ping's fork still out: this copy's until it settles, and one another copy started before a reload until its timeout.
function pingOut(now: number): boolean {
  const at = cacheState().pingAt
  return mod.pinging !== null || (at !== null && now - at < PING_TIMEOUT_MS)
}

// A lift check's or a ping's fork still out: this copy's until it settles, and one another copy started before a reload until its timeout.
const forkOut = (l: Lifts, now: number): boolean => mod.liftForking !== null || pingOut(now) || (mod.checking === null && l.forkAt !== null && now - l.forkAt < LIFT_CHECK_TIMEOUT_MS)

function noteContext(): NoteContext | null {
  const eff = mod.eff
  const role = mod.role.role
  const spec = eff && role !== null ? roleSpec(eff.config, role) : null
  return eff && spec && role !== null ? { role, handoffPath: handoffPathFor(spec, role), readyToken: eff.config.readyToken } : null
}

/**
 * The holds after this reading (stepHolds), written before anything acts.
 * Answers the triggers whose rising edge corrects a lift run on estimated
 * figures: the first reported figures show them holding, and that fire does
 * not count in their `times`.
 */
async function stepLifts($: EngineInterface, triggers: readonly Trigger[], m: Metrics): Promise<Set<string>> {
  const l = liftsNow()
  if (!triggers.some(t => t.lift) && !Object.keys(l.holds).length && !l.estimatedLift.length) return new Set()
  const step = stepHolds(l.holds, triggers, m, { blocking: mod.eff?.blocking === true, reports: l.reports, frozen: mod.checking ?? undefined })
  const byId = new Map(withWake(triggers, step.holds).map(t => [t.id, t]))
  const reported = (id: string): Trigger | null => {
    const t = byId.get(id)
    return t && !onEstimate(t, m) && whenState(t, m) !== null ? t : null
  }
  // What let each new lift go, in words, read on the figures it lifted on.
  const lifted = stamp(step.holds, step.lifted, (hold, id) => {
    const t = byId.get(id)
    return t ? { ...hold, reason: liftReason(t, m, hold.window) } : hold
  })
  const exempt = new Set(
    l.estimatedLift.filter(id => {
      const t = reported(id)
      return t !== null && whenState(t, m) === true
    }),
  )
  const estimatedLift = l.estimatedLift.filter(id => byId.has(id) && reported(id) === null)
  await putLifts($, x => ({ ...x, holds: lifted, estimatedLift }))
  return exempt
}

type LiftItem = { trigger: Trigger; hold: Hold; why: NotWoken | null; steer: boolean; wake: boolean }

const liftInput = (i: LiftItem, m: Metrics): LiftInput => ({ trigger: i.trigger, metrics: m, window: i.hold.window, reason: i.hold.reason })

/**
 * Runs the actions of lifts: one note, one toast and one notify for them all.
 * A lift seen mid-turn ran its own already (`ran`); `steer` (the operator
 * spoke since the brake touched the work) adds a toast and the lift note;
 * `why` adds the reason a wake did not run. `wakeId`'s note is withheld, as
 * its prompt carries the text, and when it is set no "Not woken" reason goes.
 * Each lift that runs clears its trigger's mark, so the condition holding
 * again is a new crossing. A hold in `keep` stays lifting (its prompt waits);
 * the others end.
 */
async function runLifts($: EngineInterface, items: readonly LiftItem[], m: Metrics, wakeId: string | null = null, keep: ReadonlySet<string> = new Set()): Promise<void> {
  const ctx = noteContext()
  const role = mod.role.role
  if (!items.length || !ctx || role === null) return
  const notes = items.filter(i => i.trigger.id !== wakeId && i.hold.liftNotedAt === null && (i.steer || liftHas(i.trigger, 'note')))
  const toasts = items.filter(i => i.steer || (!i.hold.ran && liftHas(i.trigger, 'toast')))
  const notifies = items.flatMap(i => {
    const why = wakeId === null ? i.why : null
    return (!i.hold.ran && liftHas(i.trigger, 'notify')) || why !== null ? [{ lift: liftInput(i, m), why }] : []
  })
  const text = liftNoteText(notes.map(i => liftInput(i, m)), ctx)
  let noted = false
  if (text) {
    await quietly(async () => {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      noted = true
    })
  }
  const toast = liftToastText(toasts.map(i => liftInput(i, m)))
  if (toast) $.ui.toast(toast)
  const notify = liftNotifyText(notifies)
  if (notify) await quietly(() => $.ui.notify(notify))
  for (const i of items) if (!i.hold.ran) await clearMark($, role, i.trigger.id)
  const notedIds = noted ? notes.map(i => i.trigger.id) : []
  const estimated = items.filter(i => !i.hold.ran && onEstimate(i.trigger, m)).map(i => i.trigger.id)
  const ended = items.map(i => i.trigger.id).filter(id => !keep.has(id))
  await putLifts($, l => ({
    ...l,
    holds: without(
      stamp(l.holds, [...keep], (hold, id) => ({ ...hold, ran: true, liftNotedAt: notedIds.includes(id) ? m.now : hold.liftNotedAt })),
      ended,
    ),
    estimatedLift: [...new Set([...l.estimatedLift, ...estimated])],
  }))
}

/**
 * The lifts of an evaluation, decided. Mid-turn each runs its actions on the
 * turn's own figures and a prompt waits for the turn's end. Idle, a prompt
 * passes rules 1–4 (wakeVerdict) and rule 5 (no turn, no lift work held
 * back); then every lift of the evaluation waits for one lift check, charged
 * to the first such trigger in config order. Lifts with no wake run at once.
 */
async function judgeLifts($: EngineInterface, m: Metrics, isPaused: boolean, check: LiftCheck | null): Promise<void> {
  if (check === null && mod.checking !== null) return
  if (!noteContext()) return
  const l = liftsNow()
  const triggers = withWake(roleTriggers(), l.holds)
  // A waiting prompt goes with its hold's lift, and with a reload that took `prompt` out of that lift.
  const p = l.pending
  const stale = p !== null && (l.holds[p.triggerId]?.phase !== 'lifting' || !triggers.some(t => t.id === p.triggerId && liftHas(t, 'prompt')))
  if (stale) await putLifts($, x => ({ ...x, pending: null }))
  const pending = stale ? null : p
  const items: LiftItem[] = triggers.flatMap(t => {
    const hold = Object.hasOwn(l.holds, t.id) ? l.holds[t.id] : undefined
    return t.lift && hold?.phase === 'lifting' ? [{ trigger: t, hold: hold, why: null, steer: false, wake: false }] : []
  })
  if (!items.length) return
  const running = turnRunningIn(activity(), m.now)
  if (running && check === null) {
    // The figures are the turn's own: each lift runs its actions now, and a prompt waits for the turn's end.
    const fresh = items.filter(i => !i.hold.ran)
    return await runLifts($, fresh, m, null, new Set(fresh.filter(i => liftHas(i.trigger, 'prompt')).map(i => i.trigger.id)))
  }
  let rest = items
  const live = pending ? items.find(i => i.trigger.id === pending.triggerId) : undefined
  if (pending && live) {
    if (check === null) await tryPending($, live, m, isPaused, triggers)
    rest = items.filter(i => i !== live)
  }
  const gate = wakeGateNow(isPaused)
  const a = activity()
  for (const i of rest) {
    if (!liftHas(i.trigger, 'prompt')) continue
    const v = wakeVerdict(i.hold, { lastTurnEndAt: a.lastTurnEndAt, operatorAt: l.operatorAt, gate, attempts: l.attempts[i.trigger.id] ?? 0, times: i.trigger.lift?.times ?? 0 })
    if (v.kind === 'steering') i.steer = true
    else if (v.kind === 'not-woken') i.why = v.why
    else if (v.kind === 'wake') i.wake = true
  }
  if (check === 'fresh') return await afterCheck($, rest, m, triggers, running)
  if (check === 'failed') return await checksFailed($, rest, m)
  const wakes = rest.filter(i => i.wake)
  const others = rest.filter(i => !i.wake)
  // Rule 5 holds the wakes back with their actions; the other lifts run now, on the figures at hand.
  if (!wakes.length || liftWork() || liftHeldBack() || forkOut(liftsNow(), m.now)) return await runLifts($, others, m)
  const charged = wakes.find(i => i.hold.tries > 0) ?? (wakes[0] as LiftItem)
  // A reload cut the last try short: that was the third.
  if (charged.hold.tries >= LIFT_TRIES) return await checksFailed($, rest, m)
  await startCheck($, charged, rest.map(i => i.trigger.id))
}

/**
 * The wake attempt: its tries (and, on the first, the charged trigger's
 * attempt) written before the fork, so a reload during it counts the try.
 */
async function startCheck($: EngineInterface, charged: LiftItem, ids: string[]): Promise<void> {
  const now = await $.clock.now()
  let before: string | null = null
  await quietly(async () => {
    before = JSON.stringify((await $.session.usage()).rateLimits)
  })
  const id = charged.trigger.id
  await putLifts($, l => {
    const hold = Object.hasOwn(l.holds, id) ? l.holds[id] : undefined
    if (!hold) return l
    const attempts = hold.tries === 0 ? { ...l.attempts, [id]: (l.attempts[id] ?? 0) + 1 } : l.attempts
    return { ...l, forkAt: now, attempts, holds: { ...l.holds, [id]: { ...hold, tries: hold.tries + 1 } } }
  })
  runLiftCheck($, new Set(ids), before, now)
}

/**
 * The lift check: the ping's fork, read for the account's current usage
 * windows, with none of the ping's guards or bookkeeping (cache.ping.maxUsage,
 * an expired or cold cache, `cache.pings`, the anchor). While it is out its
 * holds are frozen and no other check starts. An answer, or a failure whose
 * usage moved, is evaluated afresh; a timeout or another failure is a failed
 * try, and the third ends the attempt. A /clear, a reload or a role change
 * meanwhile drops its answer. The fork holds the slot until it settles, past
 * its timeout too (its late answer is dropped), or until it counts as gone
 * (holdSlot); the evaluation of its outcome is lift work until its lifts are
 * judged.
 */
function runLiftCheck($: EngineInterface, covers: Set<string>, before: string | null, forkAt: number): void {
  const gen = mod
  const clears = mod.clears
  mod.checking = covers
  const release = holdSlot($, 'liftForking')
  const decide = async (check: LiftCheck): Promise<void> => {
    gen.deciding = true
    try {
      await evaluateNow($, await currentReading($), 'changed', check)
    } finally {
      gen.deciding = false
    }
  }
  void quietly(async () => {
    const fork = $.model.fork({ prompt: PING_PROMPT }).catch(() => null)
    try {
      let expire = (): void => {}
      const timeout = new Promise<'timeout'>(resolve => {
        expire = () => resolve('timeout')
      })
      const timer = $.clock.after(LIFT_CHECK_TIMEOUT_MS, expire)
      const r = await Promise.race([fork, timeout])
      timer.cancel()
      await serial(async () => {
        if (gen !== mod || clears !== mod.clears || mod.checking !== covers) return
        mod.checking = null
        if (!active()) return
        const failure = r === 'timeout' ? 'timeout' : r === null ? 'error' : r.isAnswered ? null : r.reason
        const answered = failure === null
        $.ui.log(`ctx-guard: lift check ${answered ? 'read fresh usage' : `failed (${failure})`}`, { to: 'debug' })
        let moved = false
        if (!answered && before !== null) {
          await quietly(async () => {
            moved = JSON.stringify((await $.session.usage()).rateLimits) !== before
          })
        }
        if (answered || moved) return await decide('fresh')
        if (checkTries(liftsNow().holds, covers) >= LIFT_TRIES) await decide('failed')
      })
      await fork
    } finally {
      release()
      // A newer check's stamp stays.
      await putLifts($, l => (l.forkAt === forkAt ? { ...l, forkAt: null } : l))
    }
  })
}

/**
 * Step 2 of the check, on fresh figures: a lift whose tools are free runs
 * its actions, and the prompt goes from the charged trigger (else the first
 * other free one that passed rules 1–5). A turn running or lift work held
 * back leaves the prompt pending for the next idle tick.
 */
async function afterCheck($: EngineInterface, items: readonly LiftItem[], m: Metrics, triggers: readonly Trigger[], running: boolean): Promise<void> {
  const ctx = noteContext()
  if (!ctx) return
  const free = items.filter(i => toolsFree(i.trigger, triggers, m))
  const chosen = free.find(i => i.wake && i.hold.tries > 0) ?? free.find(i => i.wake) ?? null
  // The check answered: its tries are spent, whatever it found.
  const answered = free.map(i => i.trigger.id)
  await putLifts($, l => ({ ...l, holds: stamp(l.holds, answered, hold => ({ ...hold, tries: 0 })) }))
  if (!chosen) return await runLifts($, free, m)
  const id = chosen.trigger.id
  const manual = chosen.hold.manual
  const text = manual ? manualWakeText(manual.text, chosen.hold.reason ?? liftReason(chosen.trigger, m)) : wakePromptText(liftInput(chosen, m), ctx)
  const pending: LiftPending = { triggerId: id, text, tries: 0, at: chosen.hold.liftedAt ?? m.now }
  await putLifts($, l => ({ ...l, pending }))
  await runLifts($, free, m, id, new Set([id]))
  if (!running && !liftHeldBack()) await sendPending($)
}

/** The checks failed three times: the lifts that would wake stall, with one notify; the others run on the figures at hand. */
async function checksFailed($: EngineInterface, items: readonly LiftItem[], m: Metrics): Promise<void> {
  const stalls = items.filter(i => i.wake).map(i => i.trigger.id)
  const until = earliestReset(m)
  await putLifts($, l => ({ ...l, holds: stamp(l.holds, stalls, hold => ({ ...hold, phase: 'stalled', stall: { reports: l.reports, until } })) }))
  if (stalls.length) await quietly(() => $.ui.notify(liftCheckFailedText(stalls)))
  await runLifts($, items.filter(i => !i.wake), m)
}

/**
 * The wake prompt the check let through, on an idle tick: a failed try if
 * its trigger reads unknown; dropped with nothing appended if a brake holds
 * its tools again, dropped with a toast and its withheld note if the
 * operator spoke since the brake touched the work, turned into a notify (and
 * its withheld note) if a gate closed, held back like any lift work, else
 * sent.
 */
async function tryPending($: EngineInterface, item: LiftItem, m: Metrics, isPaused: boolean, triggers: readonly Trigger[]): Promise<void> {
  const id = item.trigger.id
  const state = whenState(item.trigger, m)
  if (state === null) return await pendingUnknown($, id, m)
  if (!toolsFree(item.trigger, triggers, m)) {
    // Braked again before the prompt went: no lift happened.
    return await putLifts($, l => ({ ...l, pending: null, holds: stamp(l.holds, [id], hold => ({ ...hold, phase: 'waiting', tries: 0 })) }))
  }
  // The operator spoke since the touch: their input may be in ahead of the drop it scheduled.
  const operatorAt = liftsNow().operatorAt
  if (!item.hold.manual && operatorAt !== null && item.hold.touchedAt !== null && operatorAt > item.hold.touchedAt) return await endPending($, m, null, true)
  const why = gateWhy(wakeGateNow(isPaused))
  if (why) return await endPending($, m, why, false)
  if (liftHeldBack()) return
  await sendPending($)
}

/**
 * The pending wake prompt's trigger reads unknown (a window gone from the
 * report, say): a failed try, as a refusal is. The third drops the prompt and
 * stalls its hold, with the notify of a failed check.
 */
async function pendingUnknown($: EngineInterface, id: string, m: Metrics): Promise<void> {
  const p = liftsNow().pending
  if (!p) return
  const tries = p.tries + 1
  if (tries < LIFT_TRIES) return await putLifts($, l => (l.pending ? { ...l, pending: { ...l.pending, tries } } : l))
  const until = earliestReset(m)
  await putLifts($, l => ({ ...l, pending: null, holds: stamp(l.holds, [id], hold => ({ ...hold, phase: 'stalled', stall: { reports: l.reports, until } })) }))
  await quietly(() => $.ui.notify(liftCheckFailedText([id])))
}

/**
 * Submits the pending wake prompt as ctx-guard's own, flagged so its turn
 * counts as work for `idle`. A refusal leaves it for the next idle tick; the
 * third ends it with a notify, and a compact that waited for the lift work
 * is dropped.
 */
async function sendPending($: EngineInterface): Promise<void> {
  const p = liftsNow().pending
  if (!p) return
  const tries = p.tries + 1
  await putLifts($, l => (l.pending ? { ...l, pending: { ...l.pending, tries } } : l))
  mod.wakeNext = true
  let went = false
  await quietly(async () => {
    went = (await submitOwnPrompt($, p.text)).drop === undefined
  })
  if (went) return await putLifts($, l => ({ ...l, pending: null, holds: without(l.holds, [p.triggerId]) }))
  mod.wakeNext = false
  if (tries < LIFT_TRIES) return
  const c = getPendingCompact()
  if (c && c.at === mod.compactAfterLift) await dropCompact($, c, `the wake prompt was refused ${LIFT_TRIES} times`, true)
  await endPending($, null, NOT_WOKEN.refused, false)
}

/**
 * The pending wake prompt dropped while its tools are free (operator input, a
 * freed tool used, a gate, refusals): its withheld note is appended, with a
 * toast for the operator's input or a notify for `why`; the lift is over.
 */
async function endPending($: EngineInterface, m: Metrics | null, why: NotWoken | null, steer: boolean): Promise<void> {
  const l = liftsNow()
  const p = l.pending
  if (!p) return
  await putLifts($, x => ({ ...x, pending: null }))
  const t = withWake(liftTriggers(), l.holds).find(x => x.id === p.triggerId)
  const hold = Object.hasOwn(l.holds, p.triggerId) ? l.holds[p.triggerId] : undefined
  if (!t || !hold) return
  const metrics = m ?? (await metricsFor($, await currentReading($), await $.clock.now()))
  await runLifts($, [{ trigger: t, hold: hold, why, steer, wake: false }], metrics)
}

// The commands whose own command.run handlers run onOperator.
const OWN_COMMANDS: ReadonlySet<string> = new Set(['ctx-guard:resume', 'ctx-guard:clear'])

/**
 * Operator input (a prompt or command from an operator origin, not
 * /ctx-guard): wake attempts count from zero again, and a pending wake prompt
 * is dropped; the operator is steering, so they get a toast and the model the
 * lift note. Their /clear would wipe that note: the prompt is dropped after
 * the clear, by their next input or the next idle tick (tryPending). Input
 * the person typed cancels a /ctx-guard wake: they are back. Input that
 * leaves the wake (keepsWake) leaves its waiting prompt too.
 */
async function onOperator($: EngineInterface, command: string | null, origin: string | undefined): Promise<void> {
  if (!active() || mod.role.role === null || !liftsOn()) return
  const restart = command !== null && mod.eff !== null && roleForCommand(mod.eff.config, command) !== null
  const keeps = keepsWake(command, origin !== undefined && isTypedPrompt({ origin: { kind: origin } }), restart)
  if (wakeSet() && !keeps) {
    const w = liftsNow().holds[WAKE_ID]?.manual
    await dropWake($)
    if (w) $.ui.toast(wakeCancelledText(w.window, 'back'))
  }
  if (!liftsOn()) return
  const now = await $.clock.now()
  const pending = liftsNow().pending
  await putLifts($, l => ({ ...l, operatorAt: now, attempts: {} }))
  if (pending && command !== 'clear' && !(keeps && pending.triggerId === WAKE_ID)) $.clock.after(0, () => void serial(() => timed($, () => endPending($, null, null, true))))
}

// The /ctx-guard wake gone, with its waiting prompt.
async function dropWake($: EngineInterface): Promise<void> {
  await putLifts($, l => ({ ...l, holds: without(l.holds, [WAKE_ID]), pending: l.pending?.triggerId === WAKE_ID ? null : l.pending }))
}

/**
 * A /clear: the new context never saw a brake, so each hold loses its touch
 * and note stamps, and a pending wake prompt is dropped (rule 1 fails, and the
 * lift note goes into the new context). An operator's /clear is input after
 * the touch (rule 2): the holds it steers keep their stamps, and their prompt
 * is dropped after the clear with a toast and the lift note. A /ctx-guard wake
 * is the operator's own: it keeps its stamps and its prompt.
 */
async function liftsOnClear($: EngineInterface): Promise<void> {
  await putLifts($, l => {
    const unseen = Object.entries(l.holds)
      .filter(([, hold]) => !hold.manual)
      .filter(([, hold]) => l.operatorAt === null || hold.touchedAt === null || l.operatorAt <= hold.touchedAt)
      .map(([id]) => id)
    const pending = l.pending && unseen.includes(l.pending.triggerId) ? null : l.pending
    return { ...l, pending, holds: stamp(l.holds, unseen, hold => ({ ...hold, touchedAt: null, notedAt: null, liftNotedAt: null })) }
  })
}

// A refused call of one of a hold's tools touches it, whichever trigger refused the call.
async function touchHolds($: EngineInterface, tool: string, now: number): Promise<void> {
  await putLifts($, l => ({ ...l, holds: stamp(l.holds, Object.keys(l.holds).filter(id => l.holds[id]?.tools.includes(tool)), hold => ({ ...hold, touchedAt: now })) }))
}

// A main step's work for the lifts: a hold's note read, a lift note read mid-turn, a usage report for a stall.
function liftStepDue(): boolean {
  return Object.values(liftsNow().holds).some(
    hold => (hold.notedAt !== null && (hold.touchedAt === null || hold.touchedAt < hold.notedAt)) || (hold.phase === 'lifting' && hold.ran && hold.liftNotedAt !== null) || hold.phase === 'stalled',
  )
}

/**
 * A main step went out: a hold whose note was appended before it is touched
 * (the model read the note); a lift seen mid-turn whose note it carries is
 * over (the model knows, so its prompt is dropped); and its response is a
 * usage report, which a stalled hold waits for.
 */
async function onLiftStep($: EngineInterface, sentAt: Promise<number | null> | null): Promise<void> {
  const at = (await sentAt) ?? (await $.clock.now())
  await putLifts($, l => {
    const holds: Record<string, Hold> = {}
    for (const [id, hold] of Object.entries(l.holds)) {
      if (hold.phase === 'lifting' && hold.ran && hold.liftNotedAt !== null && at > hold.liftNotedAt && l.pending?.triggerId !== id) continue
      holds[id] = hold.notedAt !== null && at > hold.notedAt && (hold.touchedAt === null || hold.touchedAt < hold.notedAt) ? { ...hold, touchedAt: at } : hold
    }
    return { ...l, holds, reports: Object.values(l.holds).some(hold => hold.phase === 'stalled') ? l.reports + 1 : l.reports }
  })
}

// A freed tool's call went through: a lift seen mid-turn, or a pending wake prompt, on that tool is over.
function liftFreedBy(tool: string): boolean {
  const l = liftsNow()
  return Object.entries(l.holds).some(([id, hold]) => hold.phase === 'lifting' && (hold.ran || l.pending?.triggerId === id) && hold.tools.includes(tool))
}

async function onFreedTool($: EngineInterface, tool: string): Promise<void> {
  const l = liftsNow()
  const p = l.pending
  if (p && l.holds[p.triggerId]?.tools.includes(tool)) await endPending($, null, null, false)
  await putLifts($, x => ({
    ...x,
    holds: without(
      x.holds,
      Object.keys(x.holds).filter(id => x.holds[id]?.phase === 'lifting' && x.holds[id]?.ran && x.holds[id]?.tools.includes(tool) && x.pending?.triggerId !== id),
    ),
  }))
}

// On an idle tick: a compact that waited for lift work runs once that work ended with no turn to end.
async function compactAfterLiftWork($: EngineInterface): Promise<void> {
  if (mod.compactAfterLift === null || liftWork()) return
  const p = getPendingCompact()
  if (!p || p.at !== mod.compactAfterLift || p.step !== 'queued') {
    mod.compactAfterLift = null
    return
  }
  if (await turnRunning($, await $.clock.now())) return
  mod.compactAfterLift = null
  scheduleCompact($)
}

// ---- session ----------------------------------------------------------------

function disarm(): void {
  for (const t of mod.timers) t.cancel()
  mod.timers = []
  mod.compactTimer?.cancel()
  mod.compactTimer = null
  for (const t of mod.probeTimers) t.cancel()
  mod.probeTimers = []
  mod.probeKey = ''
}

// ---- band probes --------------------------------------------------------------

/** Why probes do not run now; null when they do. */
function probesOff(): string | null {
  if (!active()) return 'ctx-guard is off'
  if (mod.eff?.display === 'off') return 'display off'
  if (!trusted()) return 'untrusted'
  return null
}

const configuredProbes = (): BandProbeSpec[] => mod.eff?.config.band?.probes ?? []

/**
 * Timers for the probes the config names, armed again only when the list or
 * whether they may run changed. Results of probes no longer run are dropped.
 */
function armProbes($: EngineInterface): void {
  const probes = probesOff() === null ? configuredProbes() : []
  const key = probes.length ? canonicalJson(probes) : ''
  if (key === mod.probeKey) return
  for (const t of mod.probeTimers) t.cancel()
  mod.probeTimers = []
  mod.probeKey = key
  const ids = new Set(probes.map(p => p.id))
  let dropped = false
  for (const id of [...mod.probeResults.keys()]) {
    if (!ids.has(id)) {
      mod.probeResults.delete(id)
      dropped = true
    }
  }
  for (const p of probes) mod.probeTimers.push($.clock.every(p.every, () => void runProbe($, p)))
  runAllProbes($)
  if (dropped || !probes.length) void serial(() => refreshBand($))
}

function runAllProbes($: EngineInterface): void {
  if (!mod.probeKey) return
  for (const p of configuredProbes()) void runProbe($, p)
}

/**
 * One run of a probe, off the `serial` chain so a slow script holds up no
 * evaluation; only the band redraw after it joins the chain. Trust is read
 * again first, so an edited script never runs under the old approval.
 */
async function runProbe($: EngineInterface, p: BandProbeSpec): Promise<void> {
  if (mod.probeRunning.has(p.id)) return
  const gen = mod
  gen.probeRunning.add(p.id)
  try {
    const root = await $.session.root()
    await readTrust($, root)
    if (probesOff() !== null) {
      armProbes($)
      return
    }
    const role = mod.role.role
    const spec = role === null || !mod.eff ? null : roleSpec(mod.eff.config, role)
    const handoff = role !== null && spec ? await handoffOf($, root, await realRootOf($, root), role, spec).catch(() => null) : null
    const startedAt = (await $.session.usage()).startedAt
    const env = scriptEnv(scriptContextOf(root, 'band-probe', role, spec, handoff, startedAt, mem.lastClearAt))
    let outcome: ProbeOutcome
    try {
      outcome = parseProbe(await $.process.run(p.run, { cwd: root, timeoutMs: p.timeout, env }))
    } catch (e) {
      outcome = parseProbe({ error: `did not finish within ${humanDuration(p.timeout)} or could not start (${errorText(e)})` })
    }
    // A reload, a config change or a withdrawn trust meanwhile: this run's result is not drawn.
    if (gen !== mod || !mod.probeKey || !configuredProbes().some(x => x.id === p.id)) return
    mod.probeResults.set(p.id, { outcome, at: await $.clock.now() })
    await serial(() => refreshBand($))
  } catch {
    // A probe that cannot run leaves the band as it was.
  } finally {
    gen.probeRunning.delete(p.id)
  }
}

/** The probe segments to draw, in config order: this run's results, else what the band kept across a reload. */
function probeSegments(): BandProbe[] {
  if (!mod.probeKey) return []
  const out: BandProbe[] = []
  for (const p of configuredProbes()) {
    const run = mod.probeResults.get(p.id)
    const seg = run ? probeSegment(p.id, run.outcome) : (mem.band?.probes ?? []).find(x => x.id === p.id) ?? null
    if (seg) out.push(seg)
  }
  return out
}

/**
 * Display and timers for whether ctx-guard is active now: armed when it is,
 * torn down (status line cleared) when it is not. Run after every load, so
 * an `enabled` flipped in a config file takes effect without a restart.
 */
async function syncActive($: EngineInterface): Promise<void> {
  if (!active()) {
    disarm()
    if (mod.standIn || mod.interactive) $.ui.status(undefined)
    mod.standIn = false
    return
  }
  const display = mod.eff?.display
  const surface = mod.surface
  mod.standIn = display === 'status' || (display === 'band' && surface !== 'terminal' && surface !== 'desktop')
  if (!mod.standIn) $.ui.status(undefined)
  // Timers die with a reload; session.start arms them again.
  if (!mod.timers.length) {
    // A compact held for the quiet period lost its timer with the disarm.
    void quietly(() => rearmCompactHold($))
    // 'changed': the cache countdown moves each minute; an unchanged band is not written.
    // A failed ping or prompt is tried again first, so the evaluation draws its outcome.
    mod.timers.push(
      $.clock.every(IDLE_TICK_MS, () =>
        void serial(() =>
          timed($, async () => {
            await quietly(() => retryAuto($))
            await evaluateCurrent($, 'changed')
            await quietly(() => compactAfterLiftWork($))
          }),
        ),
      ),
    )
    mod.timers.push(
      $.clock.every(BAND_TICK_MS, () =>
        void serial(async () => {
          if (needsReady()) await quietly(() => ready($))
          await quietly(() => pruneSubagents($))
          await refreshBand($)
          // The lease's heartbeat also beats here, so a quiet session keeps its role.
          await quietly(() => leaseBeat($, false))
        }),
      ),
    )
  }
  armProbes($)
}

async function start($: EngineInterface, isInteractive: boolean, surface: RenderSurface | null): Promise<void> {
  disarm()
  mod = fresh()
  // A start after a reload finds memory empty and `$.state` whole; one owing a flush still has the memory a /clear kept.
  if (flushOwed) flush($)
  else await hydrate($)
  mod.interactive = isInteractive
  mod.surface = surface

  const version = await $.session.version().catch(() => null)
  if (version && versionBelow(version, MIN_VERSION)) {
    await noticeOnce($, 'version', `ctx-guard needs Claude Code ${MIN_VERSION} or later; this is ${version.version}. Some checks may not work.`)
  }
  const clash = collidingCommand(await $.command.list().catch(() => []), 'ctx-guard', $.plugin.name)
  if (clash && clash.name === 'ctx-guard') {
    mod.inert = true
    mod.started = true
    const owner = clash.plugin ? `the ${clash.plugin} plugin` : `a ${clash.source} command`
    await noticeOnce($, 'collision', `ctx-guard is off: /ctx-guard already belongs to ${owner}.`)
    return
  }
  // Without its command ctx-guard still notes, blocks and draws: only the command is lost.
  let commandProblem = clash ? `the engine maps /ctx-guard to /${clash.name}` : null
  if (!commandProblem) {
    try {
      await $.command.register({
        name: 'ctx-guard',
        description: 'Context and usage guard: report, role, check, trust, reload, pause, init',
        argumentHint: ARGUMENT_HINT,
        immediate: true,
      })
      mod.commandOwned = true
    } catch (e) {
      commandProblem = errorText(e)
    }
  }
  if (commandProblem) await quietly(() => noticeOnce($, 'command', `ctx-guard: the /ctx-guard command is unavailable (${commandProblem}); notes, blocks and the band still work.`))
  mod.env = await $.env.get('CTX_GUARD_ROLE')
  // A hot reload keeps `$.state`: the cache stored for this session is kept, idle period and all. One
  // of another session starts over; one with no id yet is this session's since its /clear.
  if (hydrated) {
    const sid = await $.session.id().catch(() => null)
    const stored = mem.cache
    if (stored === null || (stored.sessionId !== null && stored.sessionId !== sid)) await setCache($, c => ({ ...freshCache(c), sessionId: sid }))
  }
  // A failed read leaves memory empty: the next hook reads again and this part runs again then.
  recoverOwed = !hydrated
  await fromMemory($)
}

// What a start builds from memory: the config's last good copy, the role claim, subagents, a
// held stamp, a pending resume or compact.
async function fromMemory($: EngineInterface): Promise<void> {
  await loadConfig($, true)
  mod.lastMain = activity().lastMain
  await quietly(() => loadSubagents($))
  mod.started = true
  // Again now that the session counts as started, so a role problem toasts.
  await resolveNow($)
  await syncActive($)
  if (!active()) return
  await serial(() => evaluateCurrent($, 'always'))
  await quietly(() => leaseBeat($, true))
  await quietly(() => undoHeldStamp($))
  // A reload dropped a restart's timer: its pending resume is finished off the start's path.
  if (mem.pendingResume) $.clock.after(0, () => void quietly(() => timed($, () => finishPending($))))
  await quietly(() => compactAtStart($))
}

function begin($: EngineInterface, isInteractive: boolean, surface: RenderSurface | null): Promise<void> {
  const run = quietly(async () => {
    await start($, isInteractive, surface)
    // A /clear that came while this start ran: done now that there is a session to clear.
    if (!clearOwed) return
    clearOwed = false
    if (mod.started && !mod.inert) await serial(() => onClear($))
  })
  starting = run
  void run.finally(() => {
    if (starting === run) starting = null
  })
  return run
}

// A session that loaded ctx-guard mid-way (an install) sees no session.start.
async function ensureStarted($: EngineInterface): Promise<void> {
  if (mod.started) return
  if (starting) return starting
  const surfaces = await $.session.surfaces().catch(() => [] as readonly RenderSurface[])
  if (mod.started || starting) return starting ?? undefined
  await begin($, surfaces.length > 0, surfaces[0] ?? null)
}

// Reloads the config, then re-arms or tears down what depends on it.
async function reloadConfig($: EngineInterface, force: boolean): Promise<void> {
  if (await loadConfig($, force)) await syncActive($)
}

async function onClear($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await put($, 'marks', resetMarks(mod.role.role, mem.marks, roleTriggers()))
  await put($, 'lastClearAt', now)
  mod.gates = null
  // The context starts over and is unknown until the next response; the usage windows go on.
  const reading: MainReading = { tokens: null, at: now }
  mod.lastMain = reading
  await patchActivity($, a => ({ ...a, mainTurnAt: null, mainStartAt: null, typedTurn: false, lastMain: reading }))
  // The next request writes a new prefix, in a new transcript that may tell the TTL.
  mod.transcriptPath = null
  // A ping in flight was for the old prefix; a pending retry is for the old period.
  mod.clears += 1
  mod.typedPrompt = false
  mod.retry = null
  mod.compactAfter = null
  // A lift check out was for the old context: its answer is dropped, and the holds are judged again.
  mod.checking = null
  await liftsOnClear($)
  await setCache($, c => ({ ...freshCache(c), sessionId: null }))
  const queued = getPendingCompact()
  if (queued && queued.step !== 'sent') await dropCompact($, queued, 'a /clear came first', false)
  const late = dropped
  dropped = null
  if (late && now - late.at < LATE_CLEAR_MS) {
    // The dropped restart's queued /clear ran after all: the context is gone and no resume follows.
    const p = late.pending
    await setRestartFailed($, restartFailedText(p.command, p.role, p.handoff))
    await setVerdict($, 'error', `the interrupted restart's /clear ran late; /${p.command} was not run`)
    $.ui.toast(`ctx-guard: the interrupted restart's /clear ran after all; type /${p.command} role=${p.role} handoff=${p.handoff}`)
  }
  if (!active()) return
  await setBand($, await metricsFor($, await currentReading($), now), paused(now), 'always')
  runAllProbes($)
}

function asHeldStamp(v: unknown): HeldStamp | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.path !== 'string' || typeof o.owner !== 'string' || num(o.at) === null || num(o.peerGap) === null) return null
  if (!(o.previous === null || typeof o.previous === 'string')) return null
  return { path: o.path, previous: o.previous, at: o.at as number, owner: o.owner, peerGap: o.peerGap as number }
}

/**
 * At a session start: a stamp a restart wrote before a reload cut it off
 * (no pendingResume, so it never reached /clear) is put back while it would
 * still hold the peers off, as long as it is still this session's own.
 */
async function undoHeldStamp($: EngineInterface): Promise<void> {
  const held = mem.stamp
  if (!held) return
  await put($, 'stamp', null)
  if (mem.pendingResume) return
  const now = await $.clock.now()
  if (now - held.at >= held.peerGap) return
  const realRoot = await realRootOf($, await $.session.root())
  const cur = (await readStamp($, held.path, realRoot)).stamp
  if (cur.kind === 'ok' && cur.owner === held.owner && cur.at === held.at) await $.fs.write(held.path, held.previous ?? stampJson(held.owner, 0))
}

/**
 * Submits ctx-guard's own prompt; the turn it starts is flagged as ctx-guard's.
 * The flag is set here, before the call: ctx-guard's own `prompt.submit` hook
 * is not run for a prompt raised beneath its own call. A refused prompt (a
 * hook's `drop`, or a throw) clears it, so the next turn is not taken for
 * ctx-guard's.
 */
async function submitOwnPrompt($: EngineInterface, text: string): Promise<PromptSubmitResult> {
  mod.ownText = text
  mod.ownPrompt = true
  mod.typedPrompt = false
  try {
    const r = await $.prompt.submit({ text })
    if (r.drop !== undefined) mod.ownPrompt = mod.wakeNext = false
    return r
  } catch (e) {
    mod.ownPrompt = mod.wakeNext = false
    throw e
  } finally {
    mod.ownText = null
  }
}

// A prompt the hook sees keeps the flag only when it is the one ctx-guard is
// submitting; its resume command and every other prompt clear it. The last
// prompt seen also says whether the next main turn answers a typed one; one
// delivered into a running turn is that turn's, not the next one's.
function noteOwnPrompt(e: PromptSubmitInput): void {
  mod.ownPrompt = isOwnPrompt(e, mod.ownText)
  mod.typedPrompt = e.turnId === undefined && isTypedPrompt(e)
}

// Every turn start, a subagent's too, marks a turn running; a main one also takes the own-prompt flag.
async function onTurnStart($: EngineInterface, main: boolean): Promise<void> {
  const now = await $.clock.now()
  const own = main && mod.ownPrompt
  const woken = own && mod.wakeNext
  const typed = main && mod.typedPrompt
  if (main) {
    mod.ownPrompt = false
    mod.wakeNext = false
    mod.typedPrompt = false
  }
  await patchActivity($, a => ({ ...a, mainTurnAt: now, ...(main ? { mainStartAt: now, ownTurn: own, wokenTurn: woken, typedTurn: typed } : {}) }))
}

// The end of the operator's turn starts a new idle period; ctx-guard's own
// prompt turn is not the operator back, so idle and the period go on. A
// woken turn's end is where idle counts from; every main turn's end is one
// a lift's wake rule reads. A typed prompt's turn that ends on an answer with
// no ready token closes: it ends a /ctx-guard:clear ask from before its start.
// A turn that ends other than on an answer is cut: it suspends the ask until a
// typed prompt's turn starts after it.
async function onMainTurnEnd($: EngineInterface, token: boolean, answered: boolean): Promise<void> {
  const now = await $.clock.now()
  const { ownTurn: own, wokenTurn: woken, typedTurn: typed, mainStartAt } = activity()
  const closing = typed && answered && !token && mainStartAt !== null
  const known = mainStartAt !== null
  await patchActivity($, a => ({
    ...a,
    mainTurnAt: null,
    mainStartAt: null,
    ...(closing ? { lastClosingStartAt: mainStartAt } : {}),
    ...(known && !answered ? { lastCutStartAt: mainStartAt } : {}),
    ...(known && typed ? { lastTypedStartAt: mainStartAt } : {}),
    ownTurn: false,
    wokenTurn: false,
    typedTurn: false,
    lastTurnEndAt: now,
    ...(own ? {} : { lastMainEndAt: now }),
    ...(woken ? { lastWokenEndAt: now } : {}),
  }))
  // The turn's requests moved the cache in memory only: written now, so a reload keeps the anchor.
  await setCache($, c => (own ? c : newPeriod(c)))
}

// A transcript this long with no cache write is not read again: each read takes the whole file.
const TRANSCRIPT_SCAN_MAX = 1024 * 1024

// The transcript's newest cache write tells the TTL. Read after each main turn
// until it does, early while the file is small; after a refused read, or one
// past TRANSCRIPT_SCAN_MAX with no cache write, not again until /clear or a
// new session.
async function detectTtl($: EngineInterface): Promise<void> {
  if (!active()) return
  const c = cacheState()
  if (c.transcriptTried || c.ttlSource === 'transcript' || cacheConfig().ttl !== 'auto') return
  const derived = await transcriptPathOf($).catch(() => null)
  const paths = [...new Set([derived, mod.transcriptPath].filter((p): p is string => p !== null))]
  for (const path of paths) {
    let text: string
    try {
      text = await $.fs.read(path)
    } catch {
      continue
    }
    const ttl = ttlFromTranscript(text)
    if (ttl !== null) await setCache($, x => withTtl(x, ttl, 'transcript'))
    else if (text.length > TRANSCRIPT_SCAN_MAX) await setCache($, x => ({ ...x, transcriptTried: true }))
    return
  }
  await setCache($, x => ({ ...x, transcriptTried: true }))
}

// Where the engine keeps this session's transcript: classic hooks, which also name it, may not run.
async function transcriptPathOf($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : null)
  if (!dir) return null
  const cwd = await $.session.cwd()
  return `${dir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${await $.session.id()}.jsonl`
}

// ---- the command ------------------------------------------------------------

async function report($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const eff = mod.eff
  const config = eff?.config ?? builtInConfig()
  const reading = await currentReading($)
  const metrics = await metricsFor($, reading, now)
  const role = mod.role.role
  const spec = role === null ? null : roleSpec(config, role)
  const pause = mem.pause
  const isPausedNow = isPaused(pause, now)
  const off = !eff
    ? 'config not loaded'
    : !eff.enabled
      ? 'enabled is false in userConfig or the project config'
      : !mod.interactive
        ? 'non-interactive session'
        : null
  return reportText({
    now,
    interactive: mod.interactive,
    off,
    pause,
    role: mod.role,
    claimAt: mem.roleClaim?.at ?? null,
    wake: wakeReport(now),
    configState: mem.config,
    config,
    switches: { blocking: eff?.blocking ?? true, autoActions: eff?.autoActions ?? false, noteToasts: eff?.noteToasts ?? true, display: eff?.display ?? 'band' },
    windowSource: windowFor(reading.context.window).source,
    mode: spec && eff ? effectiveMode(spec, { autoActions: eff.autoActions, trusted: mod.trust?.trusted === true, paused: isPausedNow }) : null,
    metrics,
    marks: mem.marks,
    triggers: roleTriggers(),
    denies: role === null || !eff ? [] : liveDenies(roleTriggers(), metrics, { blocking: eff.blocking, paused: isPausedNow }),
    lastClearAt: mem.lastClearAt,
    restart: await restartReport($, role, spec, now),
    subagents: subagentReport(config, eff?.blocking ?? true, isPausedNow),
    probes: configuredProbes().map(p => ({ id: p.id, state: probeState(mod.probeResults.get(p.id) ?? null, now, probesOff()) })),
    cache: cacheReport(metrics),
  })
}

// The report's cache line, from the same TTL and running turn as the band.
function cacheReport(m: Metrics): CacheReport {
  const c = cacheState()
  const ttl = cacheTtl(subscribedIn(m))
  const pinger = roleTriggers().find(t => t.do.includes('ping'))
  const r = mod.retry
  return {
    ttl: ttl.ms,
    source: ttl.source,
    expiresIn: m.cache.expiresIn,
    busy: turnRunningIn(activity(), m.now),
    pings: pinger ? { n: c.pings, cap: pinger.times } : null,
    cold: c.cold,
    miss: c.miss,
    missCause: c.missCause,
    retry: r ? { kind: r.kind, triggerId: r.fire.trigger.id, tries: r.tries } : null,
  }
}

async function restartReport($: EngineInterface, role: string | null, spec: RoleSpec | null, now: number): Promise<RestartReport> {
  const t = mod.trust
  const pending = mem.pendingResume
  const out: RestartReport = {
    trusted: t?.trusted === true,
    wanted: trustWanted(),
    changed: t?.changed ?? [],
    approvedAt: t?.record?.at ?? null,
    lastVerdict: mem.lastVerdict,
    handoff: null,
    lease: null,
    pending: pending ? `${pending.step} for ${pending.role}, ${humanDuration(now - pending.at)} ago` : null,
    pendingCompact: null,
    lastCompact: null,
  }
  const pc = getPendingCompact()
  if (pc) {
    const waiting = pc.waiting ? `; waiting: ${pc.waiting}` : ''
    out.pendingCompact = `${pc.step === 'sent' ? 'running' : pc.step} for trigger "${pc.triggerId}" (${pc.role}), ${humanDuration(now - pc.at)} ago${waiting}`
  }
  const lc = mem.lastCompact
  if (lc) out.lastCompact = `${lc.outcome} ${humanDuration(now - lc.at)} ago (${lc.source}): ${lc.text}`
  if (role === null || !spec) return out
  // A config another version stored may lack it.
  out.selfGap = { gap: spec.restart.selfGap ?? DEFAULT_SELF_GAP, lastRestartAt: mem.lastRestartAt }
  try {
    const root = await $.session.root()
    const found = await handoffOf($, root, await realRootOf($, root), role, spec)
    out.handoff = { path: found.path, mtime: found.kind === 'present' ? found.mtime : null }
  } catch (e) {
    out.handoff = { path: `${handoffPathFor(spec, role)} (${errorText(e)})`, mtime: null }
  }
  try {
    const lease = await leaseOf($)
    const f = await ownerFile($, role)
    const owner = f ? parseOwner(await readText($, f.abs, f.realRoot)) : null
    const held = leaseState(owner, lease.id, now)
    const beat = owner ? `, heartbeat ${humanDuration(now - owner.heartbeat)} ago` : ''
    out.lease = held.kind === 'mine' ? `held by this session${beat}` : held.kind === 'shared' ? `held by another live session (${held.sessionId}${beat})` : 'free'
  } catch (e) {
    out.lease = `unknown (${errorText(e)})`
  }
  return out
}

async function roleCommand($: EngineInterface, arg: string): Promise<string> {
  const parsed = parseRoleArg(arg)
  if (!parsed.ok) return `${PREFIX} ${parsed.error}`
  const config = mod.eff?.config ?? builtInConfig()
  if (parsed.role !== null) {
    const problem = roleProblem(parsed.role, config, 'command')
    if (problem) return `${PREFIX} ${problem.replace(/; running with no role$/, '')}; nothing changed.`
  }
  await put($, 'roleClaim', { role: parsed.role, source: 'command', at: await $.clock.now() })
  const r = await resolveNow($)
  await serial(() => evaluateCurrent($, 'always'))
  await quietly(() => leaseBeat($, true))
  const tail = mod.interactive ? '' : ' This session is not interactive, so it runs with no role.'
  return `${PREFIX} role is now ${r.role ?? 'none'}.${tail}`
}

async function pauseCommand($: EngineInterface, arg: string): Promise<string> {
  const p = parsePause(arg)
  if (!p.ok) return `${PREFIX} ${p.error}`
  const now = await $.clock.now()
  const pause: Pause | null = p.ms === null ? null : { until: now + p.ms }
  await put($, 'pause', pause)
  await serial(() => refreshBand($))
  if (!pause) await quietly(() => unblockCompact($, false))
  return pause
    ? `${PREFIX} paused for ${humanDuration(p.ms ?? 0)}: tool blocks and automatic actions are off; notes go on. /ctx-guard pause off lifts it.`
    : `${PREFIX} pause lifted.`
}

/**
 * `/ctx-guard wake <5h|7d> [text]`: a hold on that window's usage, touched by
 * the operator now, whose lift is one wake prompt (it replaces a wake already
 * set); `window` null cancels it.
 */
async function wakeCommand($: EngineInterface, window: LimitKind | null, text: string | null): Promise<string> {
  if (!active()) return `${PREFIX} ${NOT_ACTIVE}. Nothing changed.`
  if (mod.role.role === null) return `${PREFIX} this session has no role, so nothing can wake it; nothing changed.`
  if (window === null) {
    if (!wakeSet()) return `${PREFIX} no wake is set.`
    await dropWake($)
    return `${PREFIX} wake cancelled.`
  }
  const now = await $.clock.now()
  const plan = wakePlan(window, text, await metricsFor($, await currentReading($), now))
  if (!plan.ok) return `${PREFIX} ${plan.error}; nothing changed.`
  const hold = wakeHold(plan.wake, now)
  await putLifts($, l => {
    const { [WAKE_ID]: _, ...attempts } = l.attempts
    return { ...l, holds: { ...l.holds, [WAKE_ID]: hold }, attempts, pending: l.pending?.triggerId === WAKE_ID ? null : l.pending }
  })
  return wakeSetText(plan.wake, now, gateWhy(wakeGateNow(paused(now))))
}

// The report's line for a set /ctx-guard wake: its window, reset and phase.
function wakeReport(now: number): string | null {
  const l = liftsNow()
  const hold = Object.hasOwn(l.holds, WAKE_ID) ? l.holds[WAKE_ID] : undefined
  if (!hold?.manual) return null
  const phase =
    l.pending?.triggerId === WAKE_ID
      ? 'the window reset; the wake prompt waits for an idle moment'
      : hold.phase === 'lifting'
        ? 'the window may have reset; reading fresh usage'
        : hold.phase === 'stalled'
          ? 'fresh usage could not be read; tried again on the next usage report or reset'
          : 'waiting for the reset'
  return wakeLine(hold.manual, phase, now)
}

async function initCommand($: EngineInterface, preset: Preset): Promise<string> {
  const root = await $.session.root()
  const rel = switches.configPath
  const target = confinePath(root, rel)
  if ('error' in target) return `${PREFIX} configPath ${rel} ${target.error}; nothing written.`
  const lines: string[] = []
  let wrote = false
  if (await $.fs.exists(target.path)) lines.push(`${rel} exists; left as it is.`)
  else {
    const from = presetPath($.plugin.root, preset)
    let text: string
    try {
      text = await $.fs.read(from)
    } catch (e) {
      return `${PREFIX} the ${preset} preset could not be read from ${from} (${errorText(e)}); nothing written.`
    }
    const problem = presetProblem(text, preset)
    if (problem) return `${PREFIX} ${problem}; nothing written.`
    await $.fs.write(target.path, text)
    wrote = true
    lines.push(`wrote ${rel} (${preset} preset).`)
  }
  await reloadConfig($, true)
  if (wrote && mod.eff && !mod.eff.fallback && wantsTrust(mod.eff.config) && !trusted()) lines.push(INIT_TRUST_HINT)
  const stateDir = (mod.eff?.config ?? builtInConfig()).stateDir.replace(/\/+$/, '')
  const gitignore = `${root.replace(/[/\\]+$/, '')}/.gitignore`
  const existing = (await $.fs.exists(gitignore)) ? await $.fs.read(gitignore) : null
  const next = gitignoreWith(existing, [localPathFor(rel), `${stateDir}/`])
  if (next) {
    await $.fs.write(gitignore, next.text)
    lines.push(`added to .gitignore: ${next.added.join(', ')}.`)
  } else lines.push('.gitignore already lists the local config and the state folder.')
  await serial(() => evaluateCurrent($, 'always'))
  return `${PREFIX} ${lines.join(' ')}`
}

/**
 * `/ctx-guard:resume role=<r> …` typed by the person: a session with no role
 * takes it, the same role passes, a different held role is refused. Answers
 * the refusal text, or null to let the command run.
 */
async function resumeClaim($: EngineInterface, args: string): Promise<string | null> {
  const eff = mod.eff
  if (!eff) return null
  const typed = parseResumeArgs(args)
  // With no role= the session's own role is resumed; with none there is nothing to resume.
  if (!typed.errors.length && typed.role === null && mod.role.role === null) {
    return applyClaim($, 'ctx-guard:resume', { kind: 'refuse', reason: 'name a role with role=<role>: this session has none' })
  }
  return applyClaim($, 'ctx-guard:resume', claimFromResume(mod.role.role, typed, eff.config))
}

/**
 * A typed resume's arguments with what it left out filled in: the session's
 * own role when it names none, then that role's handoff path and restart
 * prompt, so `role=lead` (or nothing at all) runs as the automatic restart
 * would; null to pass it on as typed.
 */
function filledArgs(typed: string): string | null {
  const eff = mod.eff
  const a = parseResumeArgs(typed)
  const role = a.role ?? mod.role.role
  if (!eff || role === null || a.errors.length || (a.role !== null && a.handoff !== null && a.prompt !== '')) return null
  const spec = roleSpec(eff.config, role)
  return spec ? filledResumeArgs(a, role, handoffPathFor(spec, role), spec.restart.prompt) : null
}

/**
 * `/ctx-guard:clear` typed by the person: the note a stop-level context
 * trigger would send this role, by its effective restart mode, so the model
 * writes the handoff and ends with the ready token. Answers the note, or the
 * refusal text when no note can go.
 */
async function clearNote($: EngineInterface, origin: string): Promise<{ note: string; ask: ClearAsk | null } | { refusal: string }> {
  const declined = (why: string) => ({ refusal: `${PREFIX} /ctx-guard:clear refused: ${why}. Nothing ran.` })
  if (origin !== 'composer') return declined('only the operator can run it, typed in the prompt box')
  const eff = mod.eff
  if (!active() || !eff) return declined(NOT_ACTIVE)
  const role = mod.role.role
  if (role === null) return declined('this session has no role; set one with /ctx-guard role <name>')
  const spec = roleSpec(eff.config, role)
  if (!spec) return declined(`role "${role}" is not in the config`)
  const now = await $.clock.now()
  const mode = effectiveMode(spec, { autoActions: eff.autoActions, trusted: mod.trust?.trusted === true, paused: paused(now) })
  const vars = readingVars(await metricsFor($, await currentReading($), now))
  const note = clearNoteText({ role, spec, readyToken: eff.config.readyToken, mode, vars })
  if (note === null) return declined(`restart.mode is off for role "${role}"`)
  // Only auto mode asks for the token; in manual mode the note asks the operator to clear.
  return { note, ask: mode === 'auto' ? { at: now, role } : null }
}

/**
 * A role's own restart command typed by the person (`/restart-lead`) claims
 * that role, by the same rules as `/ctx-guard:resume role=`. Answers the
 * refusal text, or null to let the command run; a command that is no single
 * role's runs untouched.
 */
async function commandClaim($: EngineInterface, command: string): Promise<string | null> {
  const eff = mod.eff
  const role = eff ? roleForCommand(eff.config, command) : null
  if (!eff || role === null) return null
  return applyClaim($, command, claimFromResume(mod.role.role, { role, handoff: null, prompt: '', errors: [] }, eff.config))
}

async function applyClaim($: EngineInterface, command: string, c: ResumeClaim): Promise<string | null> {
  if (c.kind === 'refuse') {
    const text = `${PREFIX} /${command} refused: ${c.reason}. Nothing ran.`
    $.ui.toast(text)
    return text
  }
  if (c.kind === 'claim') {
    await put($, 'roleClaim', { role: c.role, source: 'resume', at: await $.clock.now() })
    await resolveNow($)
    await serial(() => evaluateCurrent($, 'always'))
    await quietly(() => leaseBeat($, true))
  }
  // The person is resuming by hand: a failed restart's flag has done its job.
  await setRestartFailed($, null)
  return null
}

/**
 * `/ctx-guard trust`: the config is read from disk again first, so what is
 * approved is what the files hold now, and every approved field is printed
 * as it stands, for the person to read before relying on it.
 */
async function trustCommand($: EngineInterface): Promise<string> {
  await reloadConfig($, true)
  const eff = mod.eff
  if (!eff) return `${PREFIX} the config is not loaded; nothing approved.`
  if (eff.fallback) return `${PREFIX} the config has errors (/ctx-guard lists them); fix them before approving it. Nothing approved.`
  const root = await $.session.root()
  const config = eff.config
  const { hashes, outside } = await scriptHashes($, config, root)
  const record: TrustRecord = { hash: trustHash(config, hashes), fields: trustFields(config, hashes), at: await $.clock.now() }
  await $.store.set(trustKey(root), record)
  mod.trust = trustState(config, record, hashes)
  armProbes($)
  const q = (v: unknown): string => JSON.stringify(v)
  const how = (run: readonly string[]): string => {
    const hashed = run.filter(a => hashes[a])
    const out = run.filter(a => outside.includes(a))
    return hashed.length
      ? `content hashed: ${hashed.join(', ')}`
      : out.length
        ? `outside the project root, trusted by name only: ${out.join(', ')}`
        : 'no file under the project root: trusted by name only'
  }
  const lines: string[] = [`${PREFIX} approved for ${root}:`, `  all roles: readyToken ${q(config.readyToken)}, stateDir ${q(config.stateDir)}`]
  for (const p of config.band.probes) {
    lines.push(`  band probe ${p.id}: ${q(p.run)}, every ${humanDuration(p.every)}, timeout ${humanDuration(p.timeout)} (${how(p.run)})`)
  }
  for (const name of Object.keys(config.roles).sort()) {
    const spec = roleSpec(config, name)
    if (!spec) continue
    const r = spec.restart
    lines.push(`  ${name}:`)
    lines.push(`    restart: mode ${r.mode}, via ${r.via}, command /${r.command}, prompt ${q(r.prompt)}, peers ${q(r.peers)}, peerGap ${humanDuration(r.peerGap)}, selfGap ${r.selfGap ? humanDuration(r.selfGap) : "0 (off)"}, minContext ${r.minContext ? humanQuantity(r.minContext) : 'off'}`)
    for (const c of r.readyChecks) lines.push(`    ready check: ${q(c.run)}, timeout ${humanDuration(c.timeout)} (${how(c.run)})`)
    if (!r.readyChecks.length) lines.push('    ready checks: none')
    lines.push(`    handoff: path ${q(spec.handoff.path)}`)
    if (spec.compact.instructions !== null) lines.push(`    compact.instructions: ${q(spec.compact.instructions)}`)
    const compactTriggers = spec.triggers.filter(t => t.do.includes('compact')).map(t => t.id)
    if (compactTriggers.length) lines.push(`    compact triggers: ${compactTriggers.join(', ')}`)
    for (const t of spec.triggers) {
      const kinds = (['ping', 'prompt'] as const).filter(k => t.do.includes(k))
      if (kinds.length) {
        const prompt = kinds.includes('prompt') ? `, prompt ${t.message === null ? 'default' : q(t.message)}` : ''
        lines.push(`    ${kinds.join(' and ')} trigger ${t.id}: ${t.times === null ? 'no times cap' : `times ${t.times}`}${prompt}`)
      }
      if (t.lift && liftHas(t, 'prompt')) {
        lines.push(`    lift prompt of trigger ${t.id}: lift.times ${t.lift.times ?? 'none'}, prompt ${t.lift.message === null ? 'default' : q(t.lift.message)}`)
      }
    }
  }
  lines.push(
    'Trusting a ready check trusts what its script does: a script under the project root is hashed, so editing it withdraws the approval; ' +
      'a command found elsewhere is trusted by name. Any change to these settings withdraws the approval until you run /ctx-guard trust again.',
  )
  await serial(() => evaluateCurrent($, 'always'))
  await quietly(async () => unblockCompact($, paused(await $.clock.now())))
  return lines.join('\n')
}

/** `/ctx-guard trust off`: the approval is dropped, so automatic actions, ready checks and probes stop until the next `trust`. */
async function trustOffCommand($: EngineInterface): Promise<string> {
  const root = await $.session.root()
  const had = asTrustRecord(await $.store.get(trustKey(root)).catch(() => undefined)) !== null
  if (had) await $.store.delete(trustKey(root))
  await readTrust($, root)
  armProbes($)
  await serial(() => evaluateCurrent($, 'always'))
  return had
    ? `${PREFIX} trust withdrawn for ${root}; automatic clear, compact, ping and prompt, ready checks and probes are off until you run /ctx-guard trust.`
    : `${PREFIX} ${root} has no approval to withdraw.`
}

/** `/ctx-guard check`: every check of a restart, nothing written, raced or cleared. */
async function checkCommand($: EngineInterface): Promise<string> {
  const eff = mod.eff
  const role = mod.role.role
  const spec = eff && role !== null ? roleSpec(eff.config, role) : null
  if (!eff || role === null || !spec) return checkText(null, null, null, null)
  const now = await $.clock.now()
  const g = await gather($, role, spec, await busyText($, now))
  if (g.facts.trusted && g.facts.error === null) g.facts.checks = await runChecks($, spec, g.facts, 'dry-run')
  const why: string[] = []
  if (spec.restart.mode !== 'auto') why.push(`restart mode is ${spec.restart.mode}`)
  if (!eff.autoActions) why.push('autoActions is off in /config')
  if (paused(now)) why.push('ctx-guard is paused')
  const notes = [why.length ? `note: the ready token is not acted on now (${why.join('; ')}).` : null, renoteRisk(g.facts)].filter(Boolean)
  return checkText(role, spec.restart.via, checkLines(g.facts), notes.length ? notes.join('\n') : null)
}

// Changing what ctx-guard does is the person's alone, never the model's or another plugin's.
const OPERATOR_ONLY = new Set(['role', 'pause', 'init', 'trust', 'trust-off', 'check'])

async function runCommand($: EngineInterface, e: CommandRunInput): Promise<CommandRunResult> {
  const sub = parseCommand(e.args)
  if (OPERATOR_ONLY.has(sub.kind) && e.origin.kind !== 'composer') {
    return { text: `${PREFIX} only the operator can run /ctx-guard ${sub.kind.replace('-', ' ')}; ask the operator to type it. Nothing changed.` }
  }
  switch (sub.kind) {
    case 'report':
      return { text: await report($) }
    case 'role':
      return { text: await roleCommand($, sub.arg) }
    case 'reload': {
      await reloadConfig($, true)
      await serial(() => evaluateCurrent($, 'always'))
      const cs = mem.config
      const errs = cs?.errors.length ?? 0
      return { text: `${PREFIX} reloaded: ${cs?.source ?? 'built-in'} config, ${errs} error${errs === 1 ? '' : 's'}; role ${mod.role.role ?? 'none'}.` }
    }
    case 'check':
      return { text: await checkCommand($) }
    case 'trust':
      return { text: await trustCommand($) }
    case 'trust-off':
      return { text: await trustOffCommand($) }
    case 'pause':
      return { text: await pauseCommand($, sub.arg) }
    case 'wake':
      // The person's, typed in the prompt box or from a remote client.
      if (!isTypedPrompt({ origin: e.origin })) return { text: `${PREFIX} only the operator can run /ctx-guard wake; ask the operator to type it. Nothing changed.` }
      return { text: await wakeCommand($, sub.window, sub.text) }
    case 'init':
      return { text: await initCommand($, sub.preset) }
    case 'usage':
      return { text: `${sub.error ? `${PREFIX} ${sub.error}.\n` : ''}${USAGE}` }
  }
}

// ---- tool denies ----------------------------------------------------------------

// A subagent past its stop budget: every call but the one returning its report refused until its
// turn ends, and nothing else of the main loop's applies.
async function subagentDeny($: EngineInterface, agentId: string, tool: string): Promise<string | null> {
  const eff = mod.eff
  if (!active() || !eff || !eff.blocking || mod.role.role === null) return null
  const t = mod.agents.get(agentId)
  const stop = budgetsOn() && t ? stopDeny(t, budgetFor(eff.config, t.identity), tool) : null
  if (stop === null || !t) return null
  if (paused(await $.clock.now())) return null
  return subagentDenyReason({ type: identityType(t.identity) ?? '*', tokens: t.tokens, warn: null, stop })
}

// Level-triggered: judged afresh from live usage on every main-loop call.
async function mainDeny($: EngineInterface, tool: string): Promise<string | null> {
  const eff = mod.eff
  if (!active() || !eff || !eff.blocking || mod.role.role === null) return null
  const triggers = roleTriggers()
  if (!triggers.some(t => t.do.some(a => typeof a === 'object' && a.deny.includes(tool)))) return null
  const now = await $.clock.now()
  const isPausedNow = paused(now)
  if (isPausedNow) return null
  const metrics = await metricsFor($, await currentReading($), now)
  const hit = deniedBy(tool, liveDenies(triggers, metrics, { blocking: eff.blocking, paused: isPausedNow }))
  const trigger = hit ? triggers.find(t => t.id === hit.triggerId) : undefined
  if (!trigger) return null
  await quietly(() => touchHolds($, tool, now))
  // When the tool comes free, and whether a brake on it will prompt the model then.
  const l = liftsNow()
  const gate = wakeGateNow(isPausedNow)
  const wakes = triggers.some(t => denyTools(t).includes(tool) && triggerHolds(t, metrics) === true && wakesOnLift(t, gate, l.attempts[t.id] ?? 0))
  return denyReason(tool, trigger, metrics, { liftsIn: toolLiftsIn(tool, triggers, metrics), wakes })
}

// ---- hooks --------------------------------------------------------------------

export const register: Register = (on, options) => {
  const read = readSwitches(options)
  switches = read.switches
  switchErrors = read.errors
  // A fresh load holds nothing yet: the session start (or the first hook) fills memory from `$.state`.
  mem = emptyMem()
  hydrated = false
  hydrating = null
  flushOwed = false
  recoverOwed = false
  clearOwed = false

  on('session.start', async ($, e, next) => {
    await begin($, e.isInteractive, e.surface)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await quietly(async () => {
      if (needsReady()) await ready($)
      await ensureStarted($)
      if (!mod.started || mod.inert || !mod.interactive) return
      // A config file edited since the last load takes effect here.
      await reloadConfig($, false)
      await serial(() => onMeasure($, e))
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (needsReady()) await quietly(() => ready($))
    await quietly(() => onTurnStart($, e.agentId === undefined))
    return next(e)
  })

  // Who sent the prompt the next main turn answers: ctx-guard itself, the person typing, or anyone else.
  on('prompt.submit', async ($, e, next) => {
    await quietly(async () => noteOwnPrompt(e))
    // The operator's own input: it resets the wake count and steers past a pending wake.
    // A command's submission is its command.run's, which counted it already.
    if (e.command === undefined && operatorInput(e.origin?.kind, null)) {
      if (needsReady()) await quietly(() => ready($))
      await quietly(() => onOperator($, e.command?.name ?? null, e.origin?.kind))
    }
    // A prompt dropped below, or one whose submission threw, starts no turn: the flag goes with it.
    try {
      const r = await next(e)
      if (r.drop !== undefined) mod.typedPrompt = false
      return r
    } catch (err) {
      mod.typedPrompt = false
      throw err
    }
  })

  // Mid-turn checks for the main loop, from each request's own usage. The
  // result goes back first; only a step whose fill crosses a gate schedules
  // an evaluation, off the turn's path. A step that crosses none but moves the
  // band's shown figure schedules a redraw only.
  on('turn.step', async function* ($, e, next) {
    if (needsReady()) await quietly(() => ready($))
    const main = e.agentId === undefined
    const gen = main ? openMainStep() : 0
    // Read as the request goes out, for the cache anchor; the step does not wait on it.
    const sentAt = main && active() ? clockRead($) : null
    let r: TurnStepResult
    try {
      r = yield* next(e)
    } finally {
      if (main && gen === mod.mainGen) mod.mainOpen = false
    }
    // Seen stepping: a workflow's agents are in no list, so this is the only sign they run.
    if (e.agentId !== undefined && active()) {
      noteStep($, e.agentId)
      if (budgetsOn()) subagentStep($, e.agentId, stepTokens(r.usage))
    }
    if (e.agentId === undefined && active() && liftStepDue()) {
      $.clock.after(0, () => void serial(() => timed($, () => onLiftStep($, sentAt))))
    }
    if (e.agentId === undefined && active()) {
      const usage = r.usage
      // Queued first, so the step's evaluation reads this request's cache figures.
      if (usage) $.clock.after(0, () => void serial(() => timed($, () => onCacheRequest($, usage, sentAt))))
      const tokens = stepTokens(r.usage)
      if (tokens !== null) {
        mod.lastMain = { tokens, at: mod.lastMain?.at ?? 0 }
        mod.lastOut = num(r.usage?.output_tokens)
        const model = r.usage?.model ?? null
        if (model !== mod.gatesModel || crossesGates(tokens, mod.gates)) {
          $.clock.after(0, () => void serial(() => timed($, () => onMainStep($, tokens, model))))
        } else if (bandLags(mem.band, tokens)) {
          // No gate crossed, but the band would read another figure: one long turn
          // ends no turn and fires no measure, so without this the band holds its start.
          $.clock.after(0, () => void serial(() => timed($, () => refreshBand($, 'changed'))))
        }
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (needsReady()) await quietly(() => ready($))
    if (e.agentId === undefined) {
      let token = false
      await quietly(async () => {
        token = tokenAnswer(e)
      })
      await quietly(() => onMainTurnEnd($, token, e.reason === 'answer'))
      // Off the hook's path, as the transcript can be large; in the chain, so a /clear never lands mid-read.
      $.clock.after(0, () => void serial(() => timed($, () => detectTtl($))))
      let restarting = false
      await quietly(async () => {
        restarting = await onReadyToken($, token)
      })
      // A restart on the ready token goes first; a queued compact waits for the next turn end.
      if (!restarting) await quietly(() => compactAtTurnEnd($))
    } else {
      const id = e.agentId
      await quietly(() => endStep($, id))
      if (mod.agents.delete(id)) await quietly(() => serial(() => forgetSubagents($, [id])))
    }
    return next(e)
  })

  // Background shell tasks show only here; the restart guard reads the last list.
  on('classic.Stop', async ($, e, next) => {
    if (needsReady()) await quietly(() => ready($))
    // No list at all is unknown, not empty: the guard refuses on unknown.
    const list = Array.isArray(e.background_tasks)
      ? e.background_tasks.map(t => ({ id: String(t.id ?? ''), type: String(t.type), status: String(t.status ?? ''), description: String(t.description ?? '') }))
      : null
    await quietly(() => change($, 'work', v => ({ ...(v ?? asWork(null)), background: list })))
    // An empty path is the engine's stamp for none.
    if (typeof e.transcript_path === 'string' && e.transcript_path !== '') mod.transcriptPath = e.transcript_path
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // In memory: the wipe that follows empties `$.state`, so the next hook writes it all back.
      if (mod.started && !mod.inert) await quietly(() => serial(() => onClear($)))
      else if (starting) clearOwed = true
      // Also while a start is still under way: what it hydrated (or is reading) is memory's now.
      if (hydrated || hydrating !== null) flushOwed = true
    } else {
      // A /clear keeps the session's role; any other end lets the role go.
      const lease = mem.lease
      if (lease && mod.started && !mod.inert) await quietly(() => releaseLease($, lease))
      // The session is over: no timer of it runs on, and nothing it kept reaches the next one in
      // this process, which starts and hydrates afresh.
      disarm()
      mod = fresh()
      await quietly(writesSettled)
      mem = emptyMem()
      hydrated = false
      // A read still under way belongs to the old session: its answer is dropped.
      hydrations += 1
      hydrating = null
      putSince = null
      flushOwed = false
      recoverOwed = false
      clearOwed = false
      dropped = null
    }
    return next(e)
  })

  // Who each agent is, from its own spawn: only agents named here or by `$.agent.list` get a budget.
  // Names used nowhere else in the file, so the directory can see the spawn passes on unchanged.
  on('agent.spawn', async ($, spawnEvent, passSpawn) => {
    if (needsReady()) await quietly(() => ready($))
    const r = await passSpawn(spawnEvent)
    const id = r.agentId
    if (id !== undefined && active()) await quietly(() => onSpawn($, id, spawnEvent.subagentType, kindOf(spawnEvent)))
    return r
  })

  // A resume typed by the person claims its role= for a session with none.
  on('command.run', { command: 'ctx-guard:resume' }, async ($, e, next) => {
    if (needsReady()) await quietly(() => ready($))
    if (operatorInput(e.origin.kind, e.command)) await quietly(() => onOperator($, e.command, e.origin.kind))
    if (!mod.commandOwned || !active() || e.origin.kind !== 'composer') return next(e)
    const refusal = await resumeClaim($, e.args)
    if (refusal !== null) return { text: refusal }
    const args = filledArgs(e.args)
    return next(args === null ? e : { ...e, args })
  }).catch(($, e, next) =>
    // A claim that could not be judged never lets the resume through unchecked.
    next.called ? next(e) : { text: `${PREFIX} /ctx-guard:resume could not check its role= claim; nothing ran. Try again, or set the role with /ctx-guard role first.` },
  )

  // A clear typed by the person: the role's restart note goes to the model as the command's arguments.
  on('command.run', { command: 'ctx-guard:clear' }, async ($, e, next) => {
    // Started first: a copy loaded fresh by a hot reload owns nothing until it starts.
    await quietly(async () => {
      if (needsReady()) await ready($)
      await ensureStarted($)
    })
    // The operator's command in every active copy, whichever owns /ctx-guard.
    if (operatorInput(e.origin.kind, e.command)) await quietly(() => onOperator($, e.command, e.origin.kind))
    // A copy that does not own /ctx-guard leaves the command to the copy that does; with no
    // copy to add the note, the command's own text tells the model to stop.
    if (!mod.commandOwned) return next(e)
    const r = await clearNote($, e.origin.kind)
    if ('refusal' in r) return { text: r.refusal }
    if (r.ask) await put($, 'clearAsk', r.ask)
    const typed = e.args.trim()
    return next({ ...e, args: typed ? `${r.note}\n\n${typed}` : r.note })
  }).catch(($, e, next) => (next.called ? next(e) : { text: `${PREFIX} /ctx-guard:clear failed; nothing ran.` }))

  // A role's own restart command typed by the person claims that role. Every
  // other command passes straight through; a claim that cannot be judged lets
  // the command run, as it did before restart commands claimed roles.
  on('command.run', async ($, e, next) => {
    // The operator's command (their /clear too): it resets the wake count and steers past a pending wake.
    // /ctx-guard:resume and /ctx-guard:clear count it in their own handlers.
    if (!OWN_COMMANDS.has(e.command) && operatorInput(e.origin.kind, e.command) && mod.eff && liftsOn()) {
      if (needsReady()) await quietly(() => ready($))
      await quietly(() => onOperator($, e.command, e.origin.kind))
    }
    // Judged from memory first, so any other command runs with no work done for it.
    const eff = mod.eff
    if (e.origin.kind !== 'composer' || !eff || roleForCommand(eff.config, e.command) === null) return next(e)
    if (needsReady()) await quietly(() => ready($))
    if (!mod.commandOwned || !active()) return next(e)
    let refusal: string | null = null
    await quietly(async () => {
      refusal = await commandClaim($, e.command)
    })
    return refusal === null ? next(e) : { text: refusal }
  })

  // The denies, then the main loop's result size for the in-flight estimate.
  // No .catch on purpose: a hook that fails is skipped, so a guard that
  // cannot read the figures blocks nothing (fail open).
  on('tool.call', async ($, e, next) => {
    if (needsReady()) await quietly(() => ready($))
    const tool = String(e.tool)
    if (e.agentId !== undefined) {
      const deny = await subagentDeny($, e.agentId, tool)
      return deny === null ? next(e) : { deny }
    }
    // Taken before the call runs: its result goes into the request after the step that called it.
    const gen = mod.mainGen
    const deny = await mainDeny($, tool)
    if (deny !== null) return { deny }
    // A freed tool went through: a lift seen in this turn has nothing left to wake for.
    if (active() && liftFreedBy(tool)) $.clock.after(0, () => void serial(() => timed($, () => onFreedTool($, tool))))
    const r = await next(e)
    // Only the model's own calls feed its context; a plugin's `$.tool.call` answers the plugin.
    if (next.origin.plugin === 'engine') addResult(gen, r.text)
    return r
  })

  on('command.run', { command: 'ctx-guard' }, async ($, e, next) => {
    if (needsReady()) await quietly(() => ready($))
    // Inert, the command is someone else's: pass it on untouched.
    if (!mod.commandOwned) return next(e)
    return runCommand($, e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: `${PREFIX} the command failed; nothing changed.` }))

  // The band above the prompt: the band ctx-guard holds in memory, never waiting on `$`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !drawsBand(e.surface)) return next(e)
    // Read on every draw, unawaited and unused: the read subscribes the drawing to the band's next write.
    void $.state.get(BAND).catch(() => undefined)
    const band = mem.band
    const segments = band ? bandSegments(band) : []
    if (!segments.length) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text wrap="truncate-end">
        {segments.map((s, i) => (
          <Text key={`s${i}`} color={s.color} dimColor={s.dim === true}>
            {s.text}
          </Text>
        ))}
      </Text>
    )
  })
}
