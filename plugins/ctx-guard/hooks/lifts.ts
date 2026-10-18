// ctx-guard lifts: the stored shape of holds and wake attempts, and the rules
// that decide whether a lift may wake the session. Pure: no `$`, never throws.
import type { Hold, HoldPhase, LiftPending, Lifts } from '../types'

// A lift check's fork that has not answered by then is a failed try.
export const LIFT_CHECK_TIMEOUT_MS = 2 * 60 * 1000
// Tries of one lift check, and submits of one wake prompt, in all.
export const LIFT_TRIES = 3

export function emptyLifts(role: string | null): Lifts {
  return { role, holds: {}, estimatedLift: [], forkAt: null, attempts: {}, pending: null, operatorAt: null, reports: 0 }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const PHASES: readonly HoldPhase[] = ['holding', 'waiting', 'lifting', 'stalled']

function asHold(v: unknown): Hold | null {
  const o = obj(v)
  if (!o || !Array.isArray(o.tools) || !o.tools.every(t => typeof t === 'string') || typeof o.when !== 'string') return null
  const startedAt = num(o.startedAt)
  if (startedAt === null || typeof o.phase !== 'string' || !(PHASES as string[]).includes(o.phase)) return null
  const st = obj(o.stall)
  const reports = num(st?.reports)
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
    ran: o.ran === true,
    liftNotedAt: num(o.liftNotedAt),
    stall: st && reports !== null ? { reports, until: num(st.until) } : null,
  }
}

function asPending(v: unknown): LiftPending | null {
  const o = obj(v)
  const at = num(o?.at)
  if (!o || typeof o.triggerId !== 'string' || typeof o.text !== 'string' || at === null) return null
  return { triggerId: o.triggerId, text: o.text, tries: Math.max(0, num(o.tries) ?? 0), at, checked: o.checked === true }
}

/** The stored lifts, checked field by field: another version may have written them. */
export function asLifts(v: unknown): Lifts {
  const o = obj(v) ?? {}
  const holds: Record<string, Hold> = {}
  for (const [id, h] of Object.entries(obj(o.holds) ?? {})) {
    const hold = asHold(h)
    if (hold) holds[id] = hold
  }
  const attempts: Record<string, number> = {}
  for (const [id, n] of Object.entries(obj(o.attempts) ?? {})) if (num(n) !== null) attempts[id] = n as number
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
