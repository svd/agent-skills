// Hook wiring of ctx-guard. Decisions live in the pure modules beside this file;
// this module only reads the engine's figures and acts on their verdicts.
// Hooks never throw: every piece of I/O is wrapped, and a failure leaves the
// session as it would be without ctx-guard.
import { update } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, FsStat, RenderSurface, Timer, TurnCompleteInput } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, Band, Config, HeldStamp, ConfigFile, ConfigState, LeaseState, MainReading, Marks, Pause, PendingResume, RoleSpec, Switches, Trigger, Work } from '../types'
import { bandOf, bandText, registerBand, sameBand } from './band'
import {
  ARGUMENT_HINT,
  MIN_VERSION,
  USAGE,
  checkText,
  collidingCommand,
  gitignoreWith,
  isPaused,
  parseCommand,
  parsePause,
  reportText,
  starterConfig,
  versionBelow,
} from './commands'
import type { Preset, RestartReport } from './commands'
import {
  DEFAULT_SWITCHES,
  asConfigState,
  asTrustRecord,
  builtInConfig,
  checkScripts,
  confinePath,
  effectiveConfig,
  localPathFor,
  readSwitches,
  resolveWindow,
  roleSpec,
  sha256Hex,
  trustFields,
  trustHash,
  trustKey,
  trustState,
} from './config'
import type { Effective, EngineWindow, FileLayer, ScriptHashes, TrustRecord, TrustState, WindowInfo } from './config'
import { PREFIX, collapseNotes, denyReason, effectiveMode, handoffPathFor, humanDuration, refusalNote, toastText } from './messages'
import {
  RACE_SETTLE_MS,
  STEP_SEEN_MS,
  asPendingResume,
  checkLines,
  isReadyAnswer,
  isUnder,
  latestHandoff,
  parseStamp,
  pendingAction,
  pendingFresh,
  quietVerdict,
  raceVerdict,
  restartFailedText,
  resumeArgs,
  sessionHandoffDir,
  stampJson,
  stampPath,
  verdict,
} from './restart'
import type { CheckRun, Facts, HandoffFact, RefusalCode, StampRead, Verdict } from './restart'
import { claimFromResume, heartbeatDue, leasePath, leaseState, ownerJson, parseOwner, parseResumeArgs, parseRoleArg, resolveRole, roleProblem } from './roles'
import type { Lease, RoleResolution } from './roles'
import {
  crossesGates,
  deniedBy,
  evaluate,
  idleMs,
  liveDenies,
  metricsOf,
  planActions,
  resetMarks,
  stepTokens,
  tokenGates,
  triggersFor,
} from './triggers'
import type { ActionPlan, Metrics, TokenGates } from './triggers'

const BAND = { plugin: 'ctx-guard', key: 'band' } as const
const MARKS = { plugin: 'ctx-guard', key: 'marks' } as const
const ROLE_CLAIM = { plugin: 'ctx-guard', key: 'roleClaim' } as const
const CONFIG = { plugin: 'ctx-guard', key: 'config' } as const
const PAUSE = { plugin: 'ctx-guard', key: 'pause' } as const
const LAST_CLEAR = { plugin: 'ctx-guard', key: 'lastClearAt' } as const
const ACTIVITY = { plugin: 'ctx-guard', key: 'activity' } as const
const PENDING = { plugin: 'ctx-guard', key: 'pendingResume' } as const
const LAST_VERDICT = { plugin: 'ctx-guard', key: 'lastVerdict' } as const
const LEASE = { plugin: 'ctx-guard', key: 'lease' } as const
const WORK = { plugin: 'ctx-guard', key: 'work' } as const
const STAMP = { plugin: 'ctx-guard', key: 'stamp' } as const
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

// Module state: lost on a hot reload, which fires session.start again and
// rebuilds it. Whatever must outlive a reload is in `$.state`.
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
  // Where a step's tokens must land to matter; null evaluates the next step.
  gates: TokenGates | null
  // The step model the gates were placed for: percent gates move with its window.
  gatesModel: string | null
  measures: number
  // The repo's trust, read from $.store at each config load and by /ctx-guard trust.
  trust: TrustState | null
  // A restart flow is running in this environment.
  restarting: boolean
  // Subagent ids seen stepping and when (NaN until the clock answers), dropped at their turn.complete;
  // `$.state.work` keeps them across a reload.
  steps: Map<string, number>
  // When each id's step was last written to `$.state.work`.
  stepWrites: Map<string, number>
  // Ids whose turn completed, so a step write that lands late does not bring them back.
  ended: Set<string>
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
  gates: null,
  gatesModel: null,
  measures: 0,
  trust: null,
  restarting: false,
  steps: new Map(),
  stepWrites: new Map(),
  ended: new Set(),
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

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// Activity comes back from $.state, which another version may have written.
function asActivity(v: unknown): Activity {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const lm = typeof o.lastMain === 'object' && o.lastMain !== null ? (o.lastMain as Record<string, unknown>) : null
  const at = num(lm?.at)
  return {
    lastMainEndAt: num(o.lastMainEndAt),
    mainTurnAt: num(o.mainTurnAt),
    lastMain: lm && at !== null ? { tokens: num(lm.tokens), at } : null,
    shown: Array.isArray(o.shown) ? o.shown.filter((x): x is string => typeof x === 'string') : [],
  }
}

// ---- state ------------------------------------------------------------------

async function activity($: EngineInterface): Promise<Activity> {
  return asActivity((await $.state.get(ACTIVITY)).value)
}

// Read-modify-write with ifVersion, so two hooks never lose each other's change.
async function patchActivity($: EngineInterface, fn: (a: Activity) => Activity): Promise<void> {
  await update($, ACTIVITY, v => fn(asActivity(v)))
}

// A toast once per session for `key`, reloads included.
async function noticeOnce($: EngineInterface, key: string, text: string): Promise<void> {
  let isNew = false
  await patchActivity($, a => {
    isNew = !a.shown.includes(key)
    return isNew ? { ...a, shown: [...a.shown, key].slice(-MAX_SHOWN) } : a
  })
  if (isNew) $.ui.toast(text)
}

async function paused($: EngineInterface, now: number): Promise<boolean> {
  return isPaused((await $.state.get(PAUSE)).value ?? null, now)
}

// ---- config -----------------------------------------------------------------

const sameFiles = (a: readonly ConfigFile[], b: readonly ConfigFile[]): boolean =>
  a.length === b.length && a.every((f, i) => f.path === b[i]?.path && f.mtime === b[i]?.mtime)

async function storedConfig($: EngineInterface): Promise<ConfigState | null> {
  return asConfigState((await $.state.get(CONFIG)).value)
}

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
  const prev = await storedConfig($)
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
  await $.state.set(CONFIG, state)
  mod.eff = eff
  mod.gates = null
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
  const claim = (await $.state.get(ROLE_CLAIM)).value ?? null
  const r = resolveRole({
    claim,
    env: mod.env,
    repoDefault: eff.config.defaultRole,
    switchDefault: eff.switchDefaultRole,
    interactive: mod.interactive,
    config: eff.config,
  })
  if (r.role !== mod.role.role) mod.gates = null
  mod.role = r
  if (r.problem && active()) await noticeOnce($, `role:${r.problem}`, `ctx-guard: ${r.problem}`)
  return r
}

// ---- metrics and evaluation -------------------------------------------------

function windowFor(modelWindow: number): WindowInfo {
  const config = mod.eff?.config ?? builtInConfig()
  return resolveWindow(config.contextWindow, modelWindow, mod.engineWindow, mod.autoCompactWindow)
}

async function metricsFor($: EngineInterface, reading: Reading, now: number): Promise<Metrics> {
  const a = await activity($)
  // A turn start with no end for hours is a lost turn.complete, not a running turn.
  const busy = a.mainTurnAt !== null && now - a.mainTurnAt < STALE_TURN_MS
  const idle = idleMs(a.lastMainEndAt, busy, now)
  const window = windowFor(reading.context.window).tokens
  return metricsOf({ tokens: reading.context.tokens, rateLimits: reading.rateLimits, cost: reading.cost }, window, idle, now)
}

// usage() can lag the newest main step mid-turn; the step's fill wins.
async function currentReading($: EngineInterface): Promise<Reading> {
  const u = await $.session.usage()
  const last = mod.lastMain
  if (!last) return u
  return { ...u, context: last.tokens === null ? { window: u.context.window } : { window: u.context.window, tokens: last.tokens } }
}

async function rememberMain($: EngineInterface, tokens: number | null, now: number): Promise<void> {
  const reading: MainReading = { tokens, at: now }
  mod.lastMain = reading
  await patchActivity($, a => ({ ...a, lastMain: reading }))
}

const roleTriggers = (): Trigger[] => (mod.eff ? triggersFor(mod.eff.config, mod.role.role) : [])

async function act($: EngineInterface, plan: ActionPlan, isPaused: boolean): Promise<void> {
  const eff = mod.eff
  const role = mod.role.role
  if (!eff) return
  const spec = role === null ? null : roleSpec(eff.config, role)
  // Model notes only once a role is assigned: a user-scope install never changes model behaviour unasked.
  if (role !== null && spec && plan.notes.length) {
    const mode = effectiveMode(spec, { autoActions: eff.autoActions, trusted: mod.trust?.trusted === true, paused: isPaused })
    const handoffPath = spec.handoff.style === 'session-handoff' ? await notedHandoff($, role, spec) : undefined
    const text = collapseNotes(plan.notes, { role, spec, readyToken: eff.config.readyToken, mode, ...(handoffPath ? { handoffPath } : {}) })
    if (text) await quietly(() => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }))
  }
  for (const text of new Set(plan.toasts.map(f => toastText(f.vars, role)))) $.ui.toast(text)
  for (const text of new Set(plan.notifies.map(f => toastText(f.vars, role)))) await quietly(() => $.ui.notify(text))
  // TODO(build step 5, compact): `plan.compact` asks for /compact {compact.instructions}
  // at the next main-loop turn end, under the busy-work guard. Nothing runs it yet.
}

async function setBand($: EngineInterface, metrics: Metrics, isPaused: boolean, write: BandWrite): Promise<void> {
  if (write === 'never') return
  const eff = mod.eff
  const denies =
    eff && mod.role.role !== null ? liveDenies(roleTriggers(), metrics, { blocking: eff.blocking, paused: isPaused }) : []
  const prev = (await $.state.get(BAND)).value ?? null
  const band = bandOf(mod.role.role, metrics, denies, prev)
  if (write === 'changed' && sameBand(prev, band)) return
  await $.state.set(BAND, band)
  if (mod.standIn) $.ui.status(bandText(band) || undefined)
}

/** Rising edges since the stored marks → note, toast, notify; then the band. */
async function evaluateNow($: EngineInterface, reading: Reading, write: BandWrite): Promise<void> {
  if (!active()) return
  const now = await $.clock.now()
  const metrics = await metricsFor($, reading, now)
  const role = mod.role.role
  const triggers = roleTriggers()
  const prev = (await $.state.get(MARKS)).value ?? null
  const ev = evaluate(triggers, metrics, prev, role)
  // Written before acting, so a failed note never fires twice.
  if (JSON.stringify(ev.marks) !== JSON.stringify(prev)) await $.state.set(MARKS, ev.marks)
  mod.gates = tokenGates(triggers, ev.marks, role, metrics.window)
  const isPaused = await paused($, now)
  await act($, planActions(ev.fire), isPaused)
  await setBand($, metrics, isPaused, write)
}

async function evaluateCurrent($: EngineInterface, write: BandWrite): Promise<void> {
  await evaluateNow($, await currentReading($), write)
}

async function refreshBand($: EngineInterface): Promise<void> {
  if (!active()) return
  const now = await $.clock.now()
  await setBand($, await metricsFor($, await currentReading($), now), await paused($, now), 'always')
}

// A main-loop step's evaluation, run off the step's critical path.
async function onMainStep($: EngineInterface, tokens: number, model: string | null): Promise<void> {
  if (!active()) return
  mod.gatesModel = model
  await rememberMain($, tokens, await $.clock.now())
  const u = await $.session.usage()
  await evaluateNow($, { ...u, context: { window: u.context.window, tokens } }, 'changed')
}

async function onMeasure($: EngineInterface, e: Reading & { changed: readonly string[] }): Promise<void> {
  if (!active()) return
  mod.measures += 1
  // Another model, every Nth measure, or a context that started over (clear, compact).
  const startedOver = e.changed.includes('context') && e.context.tokens === undefined
  if (e.context.window !== mod.engineModelWindow || mod.measures % ENGINE_WINDOW_EVERY === 0 || startedOver) {
    await readEngineWindow($)
  }
  await rememberMain($, num(e.context.tokens), await $.clock.now())
  await evaluateNow($, e, 'changed')
  await quietly(() => leaseBeat($, false))
}

// ---- state that must outlive /clear -------------------------------------------

// `$.state` is held "for the session" and survives a hot reload (documented);
// whether it survives a /clear (a new session id, no session.start) is what
// the live probe must confirm. /clear does not reload the module, so these
// mirrors carry the lease id, the last clear and a pending resume across it
// should `$.state` come back empty: only a reload and a wipe at once lose them.
type Carry = {
  lease: LeaseState | null
  lastClearAt: number | null
  pending: PendingResume | null
  // A pending resume dropped as never cleared, in case its queued /clear still runs.
  dropped: { at: number; pending: PendingResume } | null
}
const emptyCarry = (): Carry => ({ lease: null, lastClearAt: null, pending: null, dropped: null })
let carry: Carry = emptyCarry()

async function getPending($: EngineInterface): Promise<PendingResume | null> {
  const v = (await $.state.get(PENDING)).value
  return v === undefined ? carry.pending : asPendingResume(v)
}

async function setPending($: EngineInterface, p: PendingResume | null): Promise<void> {
  carry.pending = p
  await $.state.set(PENDING, p)
}

async function getLastClear($: EngineInterface): Promise<number | null> {
  const v = (await $.state.get(LAST_CLEAR)).value
  return v === undefined ? carry.lastClearAt : num(v)
}

async function setLastClear($: EngineInterface, at: number): Promise<void> {
  carry.lastClearAt = at
  await $.state.set(LAST_CLEAR, at)
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
        .map(t => ({ type: String(t.type ?? ''), description: String(t.description ?? '') }))
    : null
  return { steps, background: bg }
}

async function work($: EngineInterface): Promise<Work> {
  return asWork((await $.state.get(WORK)).value)
}

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
    await update($, WORK, v => {
      const w = asWork(v)
      return mod.ended.has(id) ? w : { ...w, steps: { ...w.steps, [id]: t } }
    })
  })
}

async function endStep($: EngineInterface, id: string): Promise<void> {
  mod.ended.add(id)
  mod.steps.delete(id)
  mod.stepWrites.delete(id)
  await update($, WORK, v => {
    const w = asWork(v)
    if (!(id in w.steps)) return w
    const steps = { ...w.steps }
    delete steps[id]
    return { ...w, steps }
  })
}

// Ids seen stepping within STEP_SEEN_MS (this copy's and, across a reload, the stored ones).
async function recentSteps($: EngineInterface, now: number): Promise<string[]> {
  const ids = new Set<string>()
  for (const [id, at] of mod.steps) if (Number.isNaN(at) || now - at < STEP_SEEN_MS) ids.add(id)
  for (const [id, at] of Object.entries((await work($)).steps)) if (now - at < STEP_SEEN_MS && !mod.ended.has(id)) ids.add(id)
  return [...ids]
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
  let rel: string
  if (spec.handoff.style === 'session-handoff') {
    const dir = sessionHandoffDir(role)
    const abs = `${root.replace(/[/\\]+$/, '')}/${dir}`
    const entries = await $.fs.list(abs).catch(async e => {
      if (await missing($, abs)) return []
      throw e
    })
    const latest = latestHandoff(entries)
    if (!latest) return { kind: 'absent', path: `${dir}/*.md` }
    rel = `${dir}/${latest.name}`
  } else rel = handoffPathFor(spec, role)
  const c = confinePath(root, rel)
  if ('error' in c) throw new Error(`handoff path ${rel} ${c.error}`)
  const p = await place($, c.path, realRoot)
  if (p.kind === 'outside') throw new Error(`handoff path ${rel} resolves outside the project root`)
  if (p.kind === 'absent') return { kind: 'absent', path: rel }
  if (p.stat.kind !== 'file') return { kind: 'absent', path: rel, why: 'is not a file' }
  if (p.stat.size <= 0) return { kind: 'absent', path: rel, why: 'is empty' }
  return { kind: 'present', path: rel, mtime: p.stat.mtimeMs }
}

// The newest session-handoff file for a note's {handoffPath}; undefined when there is none.
async function notedHandoff($: EngineInterface, role: string, spec: RoleSpec): Promise<string | undefined> {
  try {
    const root = await $.session.root()
    const h = await handoffOf($, root, await realRootOf($, root), role, spec)
    return h.kind === 'present' ? h.path : undefined
  } catch {
    return undefined
  }
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
  carry.lease = lease
  await $.state.set(LEASE, lease)
}

// The id this session writes into owner files and stamps; minted once, kept across /clear and reloads.
async function leaseOf($: EngineInterface): Promise<LeaseState> {
  const v = (await $.state.get(LEASE)).value
  const held = v === undefined ? carry.lease : asLease(v)
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

async function setRestartFailed($: EngineInterface, text: string | null): Promise<void> {
  const now = await $.clock.now()
  const prev = (await $.state.get(BAND)).value ?? null
  if ((prev?.restartFailed ?? null) === text) return
  const base: Band = prev ?? { role: mod.role.role, tokens: null, percent: null, window: null, limits: [], subagentsOver: 0, denies: [], restartFailed: null, now }
  const band: Band = { ...base, restartFailed: text }
  await $.state.set(BAND, band)
  if (mod.standIn) $.ui.status(bandText(band) || undefined)
}

async function setVerdict($: EngineInterface, code: RefusalCode | 'ok', text: string): Promise<void> {
  await $.state.set(LAST_VERDICT, { code, text, at: await $.clock.now() })
}

async function refuse($: EngineInterface, code: RefusalCode, text: string): Promise<void> {
  const token = mod.eff?.config.readyToken ?? 'CTX-READY'
  const line = refusalNote(token, code, text)
  await setVerdict($, code, text)
  $.ui.toast(line)
  await quietly(() => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: line }] } }))
}

type Gathered = {
  facts: Facts
  // Where the stamps are, for the race; null for via compact or a failed gather.
  stamps: { own: string; ownText: string | null; peers: { role: string; abs: string }[]; realRoot: string } | null
}

async function busyText($: EngineInterface, now: number): Promise<string | null> {
  if (mod.restarting) return 'a restart of this session is already under way'
  const p = await getPending($)
  return pendingFresh(p, now) ? `a resume of ${p?.role ?? 'this role'} is pending since ${humanDuration(now - (p?.at ?? now))} ago` : null
}

/** Every fact the verdict needs, read fresh: nothing cached by a timer is trusted. */
async function gather($: EngineInterface, role: string, spec: RoleSpec, busy: string | null): Promise<Gathered> {
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
    facts.background = (await work($)).background
    facts.startedAt = (await $.session.usage()).startedAt
    facts.lastClearAt = await getLastClear($)
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

// Exit 0 passes; any other exit, a start failure or a timeout fails. No output is kept.
async function runChecks($: EngineInterface, spec: RoleSpec): Promise<CheckRun[]> {
  const root = await $.session.root()
  const out: CheckRun[] = []
  for (const c of spec.restart.readyChecks) {
    let run: CheckRun
    try {
      const r = await $.process.run(c.run, { cwd: root, timeoutMs: c.timeout })
      run = { run: c.run, ok: r.exitCode === 0, detail: `exited ${r.exitCode}` }
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
    g.facts.checks = await runChecks($, spec)
    v = verdict(g.facts)
  }
  return v
}

// The ready checks can take minutes: just before the stamp and again before /clear, nothing new may have started.
async function quiet($: EngineInterface, tokenAt: number): Promise<Verdict> {
  const now = await $.clock.now()
  const a = await activity($)
  return quietVerdict({
    tokenAt,
    turnRunning: a.mainTurnAt !== null && now - a.mainTurnAt < STALE_TURN_MS,
    lastMainEndAt: a.lastMainEndAt,
    agents: await $.agent.list(),
    steps: await recentSteps($, now),
    background: (await work($)).background,
  })
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
  await setPending($, { ...p, step: 'sent' })
  try {
    await $.command.run({ command: p.command, args })
    if (gen === mod) await setRestartFailed($, null)
  } catch (e) {
    if (gen !== mod) return
    await setRestartFailed($, restartFailedText(p.command, p.role, p.handoff))
    await setVerdict($, 'error', `cleared, but /${p.command} did not run: ${errorText(e)}`)
    $.ui.toast(`ctx-guard: ${p.role} was cleared, but /${p.command} did not run; type /${p.command} role=${p.role} handoff=${p.handoff}`)
  } finally {
    if (gen === mod) await setPending($, null)
  }
}

/**
 * The ready token's restart, run from a timer: gather, judge (ready checks
 * last), re-check that nothing started, write the own stamp, let a racing
 * peer's write land, judge the race, re-check again, then pendingResume →
 * /clear → resume → cleared. Fails closed: nothing is cleared unless every
 * check held, and a refusal after the stamp was written puts the old one back.
 */
async function restartFlow($: EngineInterface, tokenAt: number): Promise<void> {
  const gen = mod
  const eff = mod.eff
  const role = mod.role.role
  const spec = eff && role !== null ? roleSpec(eff.config, role) : null
  if (!active() || !eff || role === null || !spec) return
  const busy = await busyText($, await $.clock.now())
  if (busy === null) gen.restarting = true
  try {
    const g = await gather($, role, spec, busy)
    const v = await judge($, g, spec)
    if (!v.ok) return await refuse($, v.code, v.text)
    if (gen !== mod) return
    if (spec.restart.via === 'compact') {
      // TODO(build step 5, compact): run /compact {compact.instructions} here, under the same verdict and quiet re-check.
      return await refuse($, 'error', 'via compact is not wired in this version')
    }
    const stamps = g.stamps
    if (!stamps || g.facts.handoff.kind !== 'present') return await refuse($, 'error', 'the restart stamps could not be placed')
    const before = await quiet($, tokenAt)
    if (!before.ok) return await refuse($, before.code, before.text)
    const lease = await leaseOf($)
    const restore = async (): Promise<void> => {
      await $.fs.write(stamps.own, stamps.ownText ?? stampJson(lease.id, 0))
      await $.state.set(STAMP, null)
    }
    const at = await $.clock.now()
    await $.state.set(STAMP, { path: stamps.own, previous: stamps.ownText, at, owner: lease.id, peerGap: spec.restart.peerGap })
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
    await setPending($, pending)
    // From here the stamp stands for a real restart.
    await $.state.set(STAMP, null)
    await setVerdict($, 'ok', `cleared and resumed from ${pending.handoff}`)
    $.ui.toast(`ctx-guard: clearing ${role}; resuming from ${pending.handoff}`)
    try {
      await $.command.run({ command: 'clear' })
    } catch (e) {
      await setPending($, null)
      await quietly(restore)
      return await refuse($, 'error', `/clear was refused: ${errorText(e)}`)
    }
    // A reload during /clear leaves the resume to the new copy's session start.
    if (gen !== mod) return
    const next: PendingResume = { ...pending, step: 'resume' }
    await setPending($, next)
    await resume($, next, gen)
  } catch (e) {
    await refuse($, 'error', errorText(e))
  } finally {
    if (busy === null) gen.restarting = false
  }
}

// The main loop's answer ends on the ready token, and ctx-guard may act on it.
async function onReadyToken($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const eff = mod.eff
  const role = mod.role.role
  if (!active() || !eff || role === null || e.reason !== 'answer') return
  if (!isReadyAnswer(e.answer, eff.config.readyToken)) return
  const spec = roleSpec(eff.config, role)
  // Manual mode, auto actions off or a pause: the notes already told the model to ask the operator.
  if (!spec || spec.restart.mode !== 'auto' || !eff.autoActions) return
  const now = await $.clock.now()
  if (await paused($, now)) return
  // This turn's end, just recorded: any later turn means the session moved on.
  const tokenAt = (await activity($)).lastMainEndAt ?? now
  $.clock.after(0, () => void quietly(() => restartFlow($, tokenAt)))
}

/** A pending resume a reload left behind: finished once, flagged when sent or stale, dropped when never cleared. */
async function finishPending($: EngineInterface): Promise<void> {
  let taken: PendingResume | null = null
  await update($, PENDING, v => {
    taken = asPendingResume(v ?? null)
    return null
  })
  carry.pending = null
  const p = taken as PendingResume | null
  if (!p) return
  const now = await $.clock.now()
  const a = pendingAction(p, await getLastClear($), now)
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
      carry.dropped = { at: now, pending: p }
      await setVerdict($, 'error', 'a reload interrupted the restart before /clear; nothing was cleared')
      $.ui.toast('ctx-guard: a reload interrupted a restart before /clear; nothing was cleared.')
  }
}

// ---- session ----------------------------------------------------------------

function disarm(): void {
  for (const t of mod.timers) t.cancel()
  mod.timers = []
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
    mod.timers.push($.clock.every(IDLE_TICK_MS, () => void serial(() => evaluateCurrent($, 'never'))))
    mod.timers.push(
      $.clock.every(BAND_TICK_MS, () =>
        void serial(async () => {
          await refreshBand($)
          // The lease's heartbeat also beats here, so a quiet session keeps its role.
          await quietly(() => leaseBeat($, false))
        }),
      ),
    )
  }
}

async function start($: EngineInterface, isInteractive: boolean, surface: RenderSurface | null): Promise<void> {
  disarm()
  mod = fresh()
  mod.interactive = isInteractive
  mod.surface = surface

  const version = await $.session.version().catch(() => null)
  if (version && versionBelow(version, MIN_VERSION)) {
    await noticeOnce($, 'version', `ctx-guard needs Claude Code ${MIN_VERSION} or later; this is ${version.version}. Some checks may not work.`)
  }
  const clash = collidingCommand(await $.command.list().catch(() => []), 'ctx-guard', $.plugin.name)
  if (clash) {
    mod.inert = true
    mod.started = true
    const owner = clash.plugin ? `the ${clash.plugin} plugin` : `a ${clash.source} command`
    await noticeOnce($, 'collision', `ctx-guard is off: /ctx-guard already belongs to ${owner}.`)
    return
  }
  await $.command.register({
    name: 'ctx-guard',
    description: 'Context and usage guard: report, role, check, trust, reload, pause, init',
    argumentHint: ARGUMENT_HINT,
    immediate: true,
  })
  mod.commandOwned = true
  mod.env = await $.env.get('CTX_GUARD_ROLE')
  await loadConfig($, true)
  mod.lastMain = (await activity($)).lastMain
  mod.started = true
  // Again now that the session counts as started, so a role problem toasts.
  await resolveNow($)
  await syncActive($)
  if (!active()) return
  await serial(() => evaluateCurrent($, 'always'))
  await quietly(() => leaseBeat($, true))
  await quietly(() => undoHeldStamp($))
  // A reload dropped a restart's timer: its pending resume is finished off the start's path.
  if (await getPending($)) $.clock.after(0, () => void quietly(() => finishPending($)))
}

function begin($: EngineInterface, isInteractive: boolean, surface: RenderSurface | null): Promise<void> {
  const run = quietly(() => start($, isInteractive, surface))
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
  const empty: Marks = resetMarks(mod.role.role)
  await $.state.set(MARKS, empty)
  await setLastClear($, now)
  mod.gates = null
  // The context starts over and is unknown until the next response; the usage windows go on.
  const reading: MainReading = { tokens: null, at: now }
  mod.lastMain = reading
  await patchActivity($, a => ({ ...a, mainTurnAt: null, lastMain: reading }))
  const late = carry.dropped
  carry.dropped = null
  if (late && now - late.at < LATE_CLEAR_MS) {
    // The dropped restart's queued /clear ran after all: the context is gone and no resume follows.
    const p = late.pending
    await setRestartFailed($, restartFailedText(p.command, p.role, p.handoff))
    await setVerdict($, 'error', `the interrupted restart's /clear ran late; /${p.command} was not run`)
    $.ui.toast(`ctx-guard: the interrupted restart's /clear ran after all; type /${p.command} role=${p.role} handoff=${p.handoff}`)
  }
  if (!active()) return
  await setBand($, await metricsFor($, await currentReading($), now), await paused($, now), 'always')
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
  const held = asHeldStamp((await $.state.get(STAMP)).value)
  if (!held) return
  await $.state.set(STAMP, null)
  if (await getPending($)) return
  const now = await $.clock.now()
  if (now - held.at >= held.peerGap) return
  const realRoot = await realRootOf($, await $.session.root())
  const cur = (await readStamp($, held.path, realRoot)).stamp
  if (cur.kind === 'ok' && cur.owner === held.owner && cur.at === held.at) await $.fs.write(held.path, held.previous ?? stampJson(held.owner, 0))
}

async function onMainTurnStart($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await patchActivity($, a => ({ ...a, mainTurnAt: now }))
}

async function onMainTurnEnd($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await patchActivity($, a => ({ ...a, mainTurnAt: null, lastMainEndAt: now }))
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
  const pause = (await $.state.get(PAUSE)).value ?? null
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
    configState: await storedConfig($),
    config,
    switches: { blocking: eff?.blocking ?? true, autoActions: eff?.autoActions ?? false, display: eff?.display ?? 'band' },
    windowSource: windowFor(reading.context.window).source,
    mode: spec && eff ? effectiveMode(spec, { autoActions: eff.autoActions, trusted: mod.trust?.trusted === true, paused: isPausedNow }) : null,
    metrics,
    marks: (await $.state.get(MARKS)).value ?? null,
    triggers: roleTriggers(),
    denies: role === null || !eff ? [] : liveDenies(roleTriggers(), metrics, { blocking: eff.blocking, paused: isPausedNow }),
    lastClearAt: await getLastClear($),
    restart: await restartReport($, role, spec, now),
  })
}

async function restartReport($: EngineInterface, role: string | null, spec: RoleSpec | null, now: number): Promise<RestartReport> {
  const t = mod.trust
  const pending = await getPending($)
  const out: RestartReport = {
    trusted: t?.trusted === true,
    changed: t?.changed ?? [],
    approvedAt: t?.record?.at ?? null,
    lastVerdict: (await $.state.get(LAST_VERDICT)).value ?? null,
    handoff: null,
    lease: null,
    pending: pending ? `${pending.step} for ${pending.role}, ${humanDuration(now - pending.at)} ago` : null,
  }
  if (role === null || !spec) return out
  try {
    const root = await $.session.root()
    const h = await handoffOf($, root, await realRootOf($, root), role, spec)
    out.handoff = { path: h.path, mtime: h.kind === 'present' ? h.mtime : null }
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
  await $.state.set(ROLE_CLAIM, { role: parsed.role, source: 'command', at: await $.clock.now() })
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
  await $.state.set(PAUSE, pause)
  await serial(() => refreshBand($))
  return pause
    ? `${PREFIX} paused for ${humanDuration(p.ms ?? 0)}: tool blocks and automatic actions are off; notes go on. /ctx-guard pause off lifts it.`
    : `${PREFIX} pause lifted.`
}

async function initCommand($: EngineInterface, preset: Preset): Promise<string> {
  const root = await $.session.root()
  const rel = switches.configPath
  const target = confinePath(root, rel)
  if ('error' in target) return `${PREFIX} configPath ${rel} ${target.error}; nothing written.`
  const lines: string[] = []
  if (await $.fs.exists(target.path)) lines.push(`${rel} exists; left as it is.`)
  else {
    await $.fs.write(target.path, starterConfig(preset))
    lines.push(`wrote ${rel} (${preset} starter).`)
  }
  await reloadConfig($, true)
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
  const c = claimFromResume(mod.role.role, parseResumeArgs(args), eff.config)
  if (c.kind === 'refuse') {
    const text = `${PREFIX} /ctx-guard:resume refused: ${c.reason}. Nothing ran.`
    $.ui.toast(text)
    return text
  }
  if (c.kind === 'claim') {
    await $.state.set(ROLE_CLAIM, { role: c.role, source: 'resume', at: await $.clock.now() })
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
  const q = (v: unknown): string => JSON.stringify(v)
  const lines: string[] = [`${PREFIX} approved for ${root}:`, `  all roles: readyToken ${q(config.readyToken)}, stateDir ${q(config.stateDir)}`]
  for (const name of Object.keys(config.roles).sort()) {
    const spec = roleSpec(config, name)
    if (!spec) continue
    const r = spec.restart
    lines.push(`  ${name}:`)
    lines.push(`    restart: mode ${r.mode}, via ${r.via}, command /${r.command}, prompt ${q(r.prompt)}, peers ${q(r.peers)}, peerGap ${humanDuration(r.peerGap)}`)
    for (const c of r.readyChecks) {
      const hashed = c.run.filter(a => hashes[a])
      const out = c.run.filter(a => outside.includes(a))
      const how = hashed.length
        ? `content hashed: ${hashed.join(', ')}`
        : out.length
          ? `outside the project root, trusted by name only: ${out.join(', ')}`
          : 'no file under the project root: trusted by name only'
      lines.push(`    ready check: ${q(c.run)}, timeout ${humanDuration(c.timeout)} (${how})`)
    }
    if (!r.readyChecks.length) lines.push('    ready checks: none')
    lines.push(`    handoff: path ${q(spec.handoff.path)}, style ${spec.handoff.style}`)
    lines.push(`    compact.instructions: ${q(spec.compact.instructions)}`)
    const compactTriggers = spec.triggers.filter(t => t.do.includes('compact')).map(t => t.id)
    if (compactTriggers.length) lines.push(`    compact triggers: ${compactTriggers.join(', ')}`)
  }
  lines.push(
    'Trusting a ready check trusts what its script does: a script under the project root is hashed, so editing it withdraws the approval; ' +
      'a command found elsewhere is trusted by name. Any change to these settings withdraws the approval until you run /ctx-guard trust again.',
  )
  await serial(() => evaluateCurrent($, 'always'))
  return lines.join('\n')
}

/** `/ctx-guard check`: every check of a restart, nothing written, raced or cleared. */
async function checkCommand($: EngineInterface): Promise<string> {
  const eff = mod.eff
  const role = mod.role.role
  const spec = eff && role !== null ? roleSpec(eff.config, role) : null
  if (!eff || role === null || !spec) return checkText(null, null, null, null)
  const now = await $.clock.now()
  const g = await gather($, role, spec, await busyText($, now))
  if (g.facts.trusted && g.facts.error === null) g.facts.checks = await runChecks($, spec)
  const why: string[] = []
  if (spec.restart.mode !== 'auto') why.push(`restart mode is ${spec.restart.mode}`)
  if (!eff.autoActions) why.push('autoActions is off in /config')
  if (await paused($, now)) why.push('ctx-guard is paused')
  const note = why.length ? `note: the ready token is not acted on now (${why.join('; ')}).` : null
  return checkText(role, spec.restart.via, checkLines(g.facts), note)
}

// Changing what ctx-guard does is the person's alone, never the model's or another plugin's.
const OPERATOR_ONLY = new Set(['role', 'pause', 'init', 'trust', 'check'])

async function runCommand($: EngineInterface, e: CommandRunInput): Promise<CommandRunResult> {
  const sub = parseCommand(e.args)
  if (OPERATOR_ONLY.has(sub.kind) && e.origin.kind !== 'composer') {
    return { text: `${PREFIX} only the operator can run /ctx-guard ${sub.kind}; ask the operator to type it. Nothing changed.` }
  }
  switch (sub.kind) {
    case 'report':
      return { text: await report($) }
    case 'role':
      return { text: await roleCommand($, sub.arg) }
    case 'reload': {
      await reloadConfig($, true)
      await serial(() => evaluateCurrent($, 'always'))
      const cs = await storedConfig($)
      const errs = cs?.errors.length ?? 0
      return { text: `${PREFIX} reloaded: ${cs?.source ?? 'built-in'} config, ${errs} error${errs === 1 ? '' : 's'}; role ${mod.role.role ?? 'none'}.` }
    }
    case 'check':
      return { text: await checkCommand($) }
    case 'trust':
      return { text: await trustCommand($) }
    case 'pause':
      return { text: await pauseCommand($, sub.arg) }
    case 'init':
      return { text: await initCommand($, sub.preset) }
    case 'usage':
      return { text: `${sub.error ? `${PREFIX} ${sub.error}.\n` : ''}${USAGE}` }
  }
}

// ---- hooks --------------------------------------------------------------------

export const register: Register = (on, options) => {
  const read = readSwitches(options)
  switches = read.switches
  switchErrors = read.errors

  on('session.start', async ($, e, next) => {
    await begin($, e.isInteractive, e.surface)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await quietly(async () => {
      await ensureStarted($)
      if (!mod.started || mod.inert || !mod.interactive) return
      // A config file edited since the last load takes effect here.
      await reloadConfig($, false)
      await serial(() => onMeasure($, e))
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await quietly(() => onMainTurnStart($))
    return next(e)
  })

  // Mid-turn checks for the main loop, from each request's own usage. The
  // result goes back first; only a step whose fill crosses a gate schedules
  // an evaluation, off the turn's path.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    // Seen stepping: a workflow's agents are in no list, so this is the only sign they run.
    if (e.agentId !== undefined && active()) noteStep($, e.agentId)
    if (e.agentId === undefined && active()) {
      const tokens = stepTokens(r.usage)
      if (tokens !== null) {
        mod.lastMain = { tokens, at: mod.lastMain?.at ?? 0 }
        const model = r.usage?.model ?? null
        if (model !== mod.gatesModel || crossesGates(tokens, mod.gates)) {
          $.clock.after(0, () => void serial(() => onMainStep($, tokens, model)))
        }
      }
    }
    // Subagent fill and budgets (build step 6) are measured here too, from `e.agentId`.
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await quietly(() => onMainTurnEnd($))
      await quietly(() => onReadyToken($, e))
    } else {
      const id = e.agentId
      await quietly(() => endStep($, id))
    }
    return next(e)
  })

  // Background shell tasks show only here; the restart guard reads the last list.
  on('classic.Stop', async ($, e, next) => {
    // No list at all is unknown, not empty: the guard refuses on unknown.
    const list = Array.isArray(e.background_tasks)
      ? e.background_tasks.map(t => ({ type: String(t.type), description: String(t.description ?? '') }))
      : null
    await quietly(() => update($, WORK, v => ({ ...asWork(v), background: list })))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (mod.started && !mod.inert) {
      if (e.reason === 'clear') await quietly(() => serial(() => onClear($)))
      // A /clear keeps the session's role; any other end lets the role go.
      else {
        await quietly(async () => releaseLease($, await leaseOf($)))
        // The session is over: nothing it mirrored may reach the next one in this process.
        carry = emptyCarry()
      }
    }
    return next(e)
  })

  // A resume typed by the person claims its role= for a session with none.
  on('command.run', { command: 'ctx-guard:resume' }, async ($, e, next) => {
    if (!mod.commandOwned || !active() || e.origin.kind !== 'composer') return next(e)
    const refusal = await resumeClaim($, e.args)
    return refusal === null ? next(e) : { text: refusal }
  }).catch(($, e, next) =>
    // A claim that could not be judged never lets the resume through unchecked.
    next.called ? next(e) : { text: `${PREFIX} /ctx-guard:resume could not check its role= claim; nothing ran. Try again, or set the role with /ctx-guard role first.` },
  )

  // Level-triggered: judged afresh from live usage on every main-loop call.
  // No .catch on purpose: a hook that fails is skipped, so a guard that
  // cannot read the figures blocks nothing (fail open).
  on('tool.call', async ($, e, next) => {
    const eff = mod.eff
    if (!active() || !eff || !eff.blocking || e.agentId !== undefined || mod.role.role === null) return next(e)
    const tool = String(e.tool)
    const triggers = roleTriggers()
    if (!triggers.some(t => t.do.some(a => typeof a === 'object' && a.deny.includes(tool)))) return next(e)
    const now = await $.clock.now()
    const isPausedNow = await paused($, now)
    if (isPausedNow) return next(e)
    const metrics = await metricsFor($, await currentReading($), now)
    const hit = deniedBy(tool, liveDenies(triggers, metrics, { blocking: eff.blocking, paused: isPausedNow }))
    const trigger = hit ? triggers.find(t => t.id === hit.triggerId) : undefined
    return trigger ? { deny: denyReason(tool, trigger, metrics) } : next(e)
  })

  on('command.run', { command: 'ctx-guard' }, async ($, e, next) => {
    // Inert, the command is someone else's: pass it on untouched.
    if (!mod.commandOwned) return next(e)
    return runCommand($, e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: `${PREFIX} the command failed; nothing changed.` }))

  registerBand(on, drawsBand)
}
