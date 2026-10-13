// Hook wiring of ctx-guard. Decisions live in the pure modules beside this file;
// this module only reads the engine's figures and acts on their verdicts.
// Hooks never throw: every piece of I/O is wrapped, and a failure leaves the
// session as it would be without ctx-guard.
import { update } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, RenderSurface, Timer } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, ConfigFile, ConfigState, MainReading, Marks, Pause, Switches, Trigger } from '../types'
import { bandOf, bandText, registerBand, sameBand } from './band'
import {
  ARGUMENT_HINT,
  MIN_VERSION,
  USAGE,
  collidingCommand,
  gitignoreWith,
  isPaused,
  parseCommand,
  parsePause,
  reportText,
  starterConfig,
  versionBelow,
} from './commands'
import type { Preset } from './commands'
import {
  DEFAULT_SWITCHES,
  asConfigState,
  builtInConfig,
  confinePath,
  effectiveConfig,
  localPathFor,
  readSwitches,
  resolveWindow,
  roleSpec,
} from './config'
import type { Effective, EngineWindow, FileLayer, WindowInfo } from './config'
import { PREFIX, collapseNotes, denyReason, effectiveMode, humanDuration, toastText } from './messages'
import { parseRoleArg, resolveRole, roleProblem } from './roles'
import type { RoleResolution } from './roles'
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

const IDLE_TICK_MS = 60 * 1000
// Redraws the reset countdowns.
const BAND_TICK_MS = 5 * 60 * 1000
const MAX_SHOWN = 32
const STALE_TURN_MS = 6 * 60 * 60 * 1000
// The engine's window is read again this often, in measures, in case its settings moved.
const ENGINE_WINDOW_EVERY = 10

// Trust arrives with the restart gate; until then nothing runs unattended,
// so an `auto` restart tail reads as manual.
const TRUSTED = false

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
    const mode = effectiveMode(spec, { autoActions: eff.autoActions, trusted: TRUSTED, paused: isPaused })
    const text = collapseNotes(plan.notes, { role, spec, readyToken: eff.config.readyToken, mode })
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
    mod.timers.push($.clock.every(BAND_TICK_MS, () => void serial(() => refreshBand($))))
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
    description: 'Context and usage guard: report, role, reload, pause, init',
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
  if (active()) await serial(() => evaluateCurrent($, 'always'))
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
  await $.state.set(LAST_CLEAR, now)
  mod.gates = null
  // The context starts over and is unknown until the next response; the usage windows go on.
  const reading: MainReading = { tokens: null, at: now }
  mod.lastMain = reading
  await patchActivity($, a => ({ ...a, mainTurnAt: null, lastMain: reading }))
  if (!active()) return
  await setBand($, await metricsFor($, await currentReading($), now), await paused($, now), 'always')
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
    mode: spec && eff ? effectiveMode(spec, { autoActions: eff.autoActions, trusted: TRUSTED, paused: isPausedNow }) : null,
    metrics,
    marks: (await $.state.get(MARKS)).value ?? null,
    triggers: roleTriggers(),
    denies: role === null || !eff ? [] : liveDenies(roleTriggers(), metrics, { blocking: eff.blocking, paused: isPausedNow }),
    lastClearAt: (await $.state.get(LAST_CLEAR)).value ?? null,
  })
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

// Changing what ctx-guard does is the person's alone, never the model's or another plugin's.
const OPERATOR_ONLY = new Set(['role', 'pause', 'init'])

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
    if (e.agentId === undefined) await quietly(() => onMainTurnEnd($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && mod.started && !mod.inert) await quietly(() => serial(() => onClear($)))
    return next(e)
  })

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
