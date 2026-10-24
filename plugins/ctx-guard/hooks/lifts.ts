// ctx-guard lifts: the stored shape of holds and wake attempts, and the rules
// that decide whether a lift may wake the session. Pure: no `$`, never throws.
import type { Hold, HoldPhase, LiftPending, Lifts, ManualWake, Trigger } from '../types'
import { DEFAULT_RESTART_COMMAND, isObj, liftHas, num } from './config'
import { NOT_WOKEN } from './messages'
import type { NotWoken } from './messages'
import { WINDOW_MS } from './triggers'
import type { LimitKind, Metrics } from './triggers'

// A lift check's fork that has not answered by then is a failed try.
export const LIFT_CHECK_TIMEOUT_MS = 2 * 60 * 1000
// Tries of one lift check, and submits of one wake prompt, in all.
export const LIFT_TRIES = 3

export function emptyLifts(role: string | null): Lifts {
  return { role, holds: {}, estimatedLift: [], forkAt: null, attempts: {}, pending: null, operatorAt: null, reports: 0 }
}

const PHASES: readonly HoldPhase[] = ['holding', 'waiting', 'lifting', 'stalled']

function asHold(v: unknown): Hold | null {
  const o = isObj(v) ? v : null
  if (!o || !Array.isArray(o.tools) || !o.tools.every(t => typeof t === 'string') || typeof o.when !== 'string') return null
  const startedAt = num(o.startedAt)
  if (startedAt === null || typeof o.phase !== 'string' || !(PHASES as string[]).includes(o.phase)) return null
  const st = isObj(o.stall) ? o.stall : null
  const reports = num(st?.reports)
  const manual = asManual(o.manual)
  return {
    tools: [...(o.tools as string[])],
    when: o.when,
    startedAt,
    touchedAt: num(o.touchedAt),
    notedAt: num(o.notedAt),
    phase: o.phase as HoldPhase,
    tries: Math.max(0, num(o.tries) ?? 0),
    window: typeof o.window === 'string' ? o.window : null,
    liftedAt: num(o.liftedAt),
    reason: typeof o.reason === 'string' ? o.reason : null,
    ran: o.ran === true,
    liftNotedAt: num(o.liftNotedAt),
    stall: st && reports !== null ? { reports, until: num(st.until) } : null,
    ...(manual ? { manual } : {}),
  }
}

function asManual(v: unknown): ManualWake | null {
  const o = isObj(v) ? v : null
  const pct = num(o?.pct)
  if (!o || (o.window !== 'five_hour' && o.window !== 'seven_day') || pct === null) return null
  return { window: o.window, pct, text: typeof o.text === 'string' ? o.text : null, resetsAt: typeof o.resetsAt === 'string' ? o.resetsAt : null }
}

function asPending(v: unknown): LiftPending | null {
  const o = isObj(v) ? v : null
  const at = num(o?.at)
  if (!o || typeof o.triggerId !== 'string' || typeof o.text !== 'string' || at === null) return null
  return { triggerId: o.triggerId, text: o.text, tries: Math.max(0, num(o.tries) ?? 0), at }
}

/** The stored lifts, checked field by field: another version may have written them. */
export function asLifts(v: unknown): Lifts {
  const o = isObj(v) ? v : {}
  const holds: Record<string, Hold> = {}
  for (const [id, h] of Object.entries(isObj(o.holds) ? o.holds : {})) {
    const hold = asHold(h)
    if (hold) holds[id] = hold
  }
  const attempts: Record<string, number> = {}
  for (const [id, n] of Object.entries(isObj(o.attempts) ? o.attempts : {})) if (num(n) !== null) attempts[id] = n as number
  return {
    role: typeof o.role === 'string' ? o.role : null,
    holds,
    estimatedLift: Array.isArray(o.estimatedLift) ? o.estimatedLift.filter((x): x is string => typeof x === 'string') : [],
    forkAt: num(o.forkAt),
    attempts,
    pending: asPending(o.pending),
    operatorAt: num(o.operatorAt),
    reports: Math.max(0, num(o.reports) ?? 0),
  }
}

/** The lifts of `role`: those stored for another role are dropped, with all their holds and attempts. */
export function liftsFor(v: Lifts | null, role: string | null): Lifts {
  return v && v.role === role ? v : emptyLifts(role)
}

// ---- waking ---------------------------------------------------------------------

// The origins whose prompts and commands are the operator's: typed, sent from a
// phone, an SDK host's turn, another session's or a coordinator's instruction, a
// channel or a Slack ping. Notifications, schedules and plugins are not.
const OPERATOR_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'peer', 'coordinator', 'channel', 'slack-ping'])

/** Whether a prompt or command is operator input: an operator origin, and not `/ctx-guard` itself. */
export function operatorInput(origin: string | undefined, command: string | null): boolean {
  return origin !== undefined && OPERATOR_ORIGINS.has(origin) && command !== 'ctx-guard'
}

// The operator's commands that leave a /ctx-guard wake set: a context action before stepping away.
// The default restart command is every role's that names none.
const KEEP_WAKE: ReadonlySet<string> = new Set(['clear', 'compact', 'ctx-guard:clear', DEFAULT_RESTART_COMMAND])

/**
 * Whether operator input leaves a /ctx-guard wake set, and its waiting
 * prompt: input the person did not type, and their /clear, /compact,
 * /ctx-guard:clear and a role's restart command (`restart`, or the default
 * /ctx-guard:resume).
 */
export function keepsWake(command: string | null, typed: boolean, restart: boolean): boolean {
  return !typed || restart || (command !== null && KEEP_WAKE.has(command))
}

export type WakeGate = { trusted: boolean; autoActions: boolean; paused: boolean }

/** Why the gates hold a wake back; null when they let it through. */
export function gateWhy(g: WakeGate): NotWoken | null {
  if (!g.trusted) return NOT_WOKEN.untrusted
  if (!g.autoActions) return NOT_WOKEN.autoActions
  if (g.paused) return NOT_WOKEN.paused
  return null
}

export type WakeFacts = {
  // The end of the last main turn of any kind.
  lastTurnEndAt: number | null
  operatorAt: number | null
  gate: WakeGate
  // Wake attempts of the trigger since the last operator input, and its cap.
  attempts: number
  times: number
}

// What rules 1–4 say of a lift's prompt: dropped quietly (the brake never
// touched the work), dropped for the operator (they spoke since), turned into
// a notify (a gate, or lift.times spent), or on to the wake attempt.
export type WakeVerdict = { kind: 'untouched' } | { kind: 'steering' } | { kind: 'not-woken'; why: NotWoken } | { kind: 'wake' }

/**
 * Rules 1–4 for a lift's prompt, in order: the brake touched the work (a
 * refused call or its note read) and a main turn ended after that; no operator
 * input since the last touch; the gates are open; `lift.times` is not spent.
 * A hold whose attempt is already charged (`tries` above 0) skips the count.
 * The /ctx-guard wake's hold skips rules 1 and 2: the operator asked for the
 * wake, and their typed input cancels it outright, but for the input that
 * keepsWake names.
 */
export function wakeVerdict(h: Hold, f: WakeFacts): WakeVerdict {
  if (!h.manual) {
    const touched = h.touchedAt !== null && f.lastTurnEndAt !== null && f.lastTurnEndAt >= h.touchedAt
    if (!touched) return { kind: 'untouched' }
    if (f.operatorAt !== null && f.operatorAt > (h.touchedAt as number)) return { kind: 'steering' }
  }
  const why = gateWhy(f.gate)
  if (why) return { kind: 'not-woken', why }
  if (h.tries === 0 && f.attempts >= f.times) return { kind: 'not-woken', why: NOT_WOKEN.spent }
  return { kind: 'wake' }
}

/** Whether the trigger would wake the session when it lifts: prompt in lift.do, the gates open, lift.times not spent. */
export function wakesOnLift(t: Trigger, gate: WakeGate, attempts: number): boolean {
  return liftHas(t, 'prompt') && gateWhy(gate) === null && attempts < (t.lift?.times ?? 0)
}

/** The tries made by a lift check: the most of any lifting hold among those it covers. */
export function checkTries(holds: Readonly<Record<string, Hold>>, covers: ReadonlySet<string>): number {
  const tries = [...covers].map(id => {
    const h = Object.hasOwn(holds, id) ? holds[id] : undefined
    return h?.phase === 'lifting' ? h.tries : 0
  })
  return Math.max(0, ...tries)
}

/**
 * The earliest reset among the windows with a known reset time; a rolled-over
 * window's is one window length after it rolled over. Null when none has one.
 */
export function earliestReset(m: Metrics): number | null {
  const resetOf = (kind: LimitKind): number => {
    const r = m.limits[kind]
    if (r?.resetsAt) return Date.parse(r.resetsAt)
    return r?.estimated && r.rolledAt ? Date.parse(r.rolledAt) + WINDOW_MS[kind] : Number.NaN
  }
  const at = [resetOf('five_hour'), resetOf('seven_day')].filter(Number.isFinite)
  return at.length ? Math.min(...at) : null
}
