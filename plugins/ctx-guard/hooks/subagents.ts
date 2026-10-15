// ctx-guard's subagent budgets: which agents a budget covers, each one's fill,
// the step its budget calls for, what is kept across a reload, and when an
// entry is stale. Pure: no `$`, never throws.
import type { AgentKind, Budget, Config, SpawnedAgent, SubagentMark } from '../types'
import { isReservedKey, subagentBudget } from './config'

// An agent not seen stepping this long is dropped, so a lost turn.complete cannot grow the map for good.
export const PRUNE_AFTER_MS = 2 * 60 * 60 * 1000

export type BudgetStep = 'warn' | 'stop'

// Who an agent is: its type and kind; 'unlisted' when neither agent.spawn nor
// `$.agent.list` named it (the engine's compaction and memory forks), null not yet known.
export type Identity = { type: string; kind: AgentKind } | 'unlisted' | null

// One subagent as this copy follows it.
export type Tracked = {
  identity: Identity
  tokens: number
  warned: boolean
  stopped: boolean
  // The budget at the last step sent, for the mark.
  warn: number | null
  stop: number | null
  seenAt: number | null
  // A step whose fill reaches this is evaluated; 0 evaluates the next one, Infinity none.
  gate: number
}

export function track(identity: Identity = null): Tracked {
  return { identity, tokens: 0, warned: false, stopped: false, warn: null, stop: null, seenAt: null, gate: 0 }
}

/** A mark kept across a reload, followed again; its next step is evaluated (and sends nothing it already sent). */
export function fromMark(m: SubagentMark): Tracked {
  return {
    identity: { type: m.type, kind: m.kind },
    tokens: m.tokens,
    warned: true,
    stopped: m.step === 'stop',
    warn: m.warn,
    stop: m.stop,
    seenAt: m.at,
    gate: 0,
  }
}

/** A spawn's kind: a fork, a teammate, or a plain agent (a workflow's too). */
export function kindOf(e: { fork: boolean; isTeammate?: true }): AgentKind {
  return e.fork ? 'fork' : e.isTeammate ? 'teammate' : 'agent'
}

/** An agent `$.agent.list` names, for one agent.spawn never showed (a reload lost it, or it started before ctx-guard). */
export function listedIdentity(info: { type: string; teammateId?: string } | undefined): Identity {
  if (!info) return 'unlisted'
  return { type: info.type, kind: info.teammateId ? 'teammate' : info.type === 'fork' ? 'fork' : 'agent' }
}

/**
 * The budget an agent runs under: a plain agent its type's (else "*"); a
 * fork or a teammate only an entry naming its type, `fork` or `teammate`;
 * an unlisted or unknown one none.
 */
export function budgetFor(config: Config, id: Identity): Budget | null {
  if (id === null || id === 'unlisted') return null
  if (id.kind === 'agent') return subagentBudget(config, id.type)
  const named = [id.type, id.kind].find(n => n !== '*' && Object.hasOwn(config.subagents, n))
  return named ? subagentBudget(config, named) : null
}

/** The lowest budget step any entry has: below it no type's budget can fire. */
export function lowestGate(config: Config): number {
  let low = Number.POSITIVE_INFINITY
  for (const b of Object.values(config.subagents)) {
    for (const v of [b.warn, b.stop]) if (typeof v === 'number' && v < low) low = v
  }
  return low
}

export type Decision = { step: BudgetStep | null; gate: number }

/**
 * The note a fill calls for, once per step: stop past the stop budget, else
 * warn past the warn budget; a fill past both sends only the stop. `gate` is
 * the next budget not yet passed.
 */
export function decide(b: Budget | null, tokens: number, warned: boolean, stopped: boolean): Decision {
  if (!b) return { step: null, gate: Number.POSITIVE_INFINITY }
  let step: BudgetStep | null = null
  if (!stopped && b.stop !== null && tokens >= b.stop) step = 'stop'
  else if (!warned && !stopped && b.warn !== null && tokens >= b.warn) step = 'warn'
  const w = warned || stopped || step !== null
  const s = stopped || step === 'stop'
  const next = [!w ? b.warn : null, !s ? b.stop : null].filter((x): x is number => x !== null)
  return { step, gate: next.length ? Math.min(...next) : Number.POSITIVE_INFINITY }
}

// The tools a subagent hands its result back with: refusing one past the stop budget would lose the report.
export const RESULT_TOOLS: ReadonlySet<string> = new Set(['SubagentHandback', 'StructuredOutput', 'ReportFindings'])

/** The stop budget a tool call of this agent is refused under, or null: a stop note went and the fill is still past it. */
export function stopDeny(t: Tracked | undefined, b: Budget | null, tool: string): number | null {
  if (!t?.stopped || !b || b.stop === null || RESULT_TOOLS.has(tool)) return null
  return t.tokens >= b.stop ? b.stop : null
}

export function markOf(t: Tracked, now: number): SubagentMark | null {
  if ((!t.warned && !t.stopped) || t.identity === null || t.identity === 'unlisted') return null
  const { type, kind } = t.identity
  return { type, kind, tokens: t.tokens, step: t.stopped ? 'stop' : 'warn', warn: t.warn, stop: t.stop, at: now }
}

export const identityType = (id: Identity): string | null => (id === null || id === 'unlisted' ? null : id.type)

/** Agents over their warn budget (stopped ones included), for the band. */
export function overCount(agents: ReadonlyMap<string, Tracked>): number {
  let n = 0
  for (const t of agents.values()) if (t.warned || t.stopped) n += 1
  return n
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const lastSeen = (seen: (number | null | undefined)[]): number | null => {
  const xs = seen.filter(finite)
  return xs.length ? Math.max(...xs) : null
}

/** Ids last seen (evaluated, or stepping per `steps`) at least PRUNE_AFTER_MS ago. */
export function staleIds(agents: ReadonlyMap<string, Tracked>, steps: ReadonlyMap<string, number>, now: number): string[] {
  const out: string[] = []
  for (const [id, t] of agents) {
    const seen = lastSeen([t.seenAt, steps.get(id)])
    if (seen !== null && now - seen >= PRUNE_AFTER_MS) out.push(id)
  }
  return out
}

/** Spawn records older than PRUNE_AFTER_MS whose agent has not stepped since. */
export function staleSpawns(spawned: Readonly<Record<string, SpawnedAgent>>, steps: ReadonlyMap<string, number>, now: number): string[] {
  return Object.entries(spawned)
    .filter(([id, s]) => now - (lastSeen([s.at, steps.get(id)]) ?? s.at) >= PRUNE_AFTER_MS)
    .map(([id]) => id)
}

const numOrNull = (v: unknown): number | null => (finite(v) ? v : null)
const KINDS: readonly string[] = ['agent', 'fork', 'teammate']
const isKind = (v: unknown): v is AgentKind => typeof v === 'string' && KINDS.includes(v)

function entries(v: unknown): [string, Record<string, unknown>][] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return []
  return Object.entries(v as Record<string, unknown>).filter(
    (e): e is [string, Record<string, unknown>] => !isReservedKey(e[0]) && typeof e[1] === 'object' && e[1] !== null,
  )
}

/** The stored marks, read defensively: another version may have written them. */
export function asMarks(v: unknown): Record<string, SubagentMark> {
  const out: Record<string, SubagentMark> = {}
  for (const [id, o] of entries(v)) {
    if ((o.step !== 'warn' && o.step !== 'stop') || typeof o.type !== 'string' || !isKind(o.kind) || !finite(o.tokens) || !finite(o.at)) continue
    out[id] = { type: o.type, kind: o.kind, tokens: o.tokens, step: o.step, warn: numOrNull(o.warn), stop: numOrNull(o.stop), at: o.at }
  }
  return out
}

/** The stored spawn records, read defensively. */
export function asSpawned(v: unknown): Record<string, SpawnedAgent> {
  const out: Record<string, SpawnedAgent> = {}
  for (const [id, o] of entries(v)) {
    if (typeof o.type !== 'string' || !isKind(o.kind) || !finite(o.at)) continue
    out[id] = { type: o.type, kind: o.kind, at: o.at }
  }
  return out
}

export const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id)
