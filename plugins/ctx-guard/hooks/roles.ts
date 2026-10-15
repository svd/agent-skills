// ctx-guard roles: which role a session runs as, the `/ctx-guard role` and
// `/ctx-guard:resume` argument parsers, and the role lease. Pure: no `$`, never throws.
import type { Config, RoleClaim } from '../types'
import { DEFAULT_RESTART_COMMAND, ROLE_NAME, roleSpec } from './config'

// The one env var ctx-guard reads; `$.env.get` takes only a literal.
export const ROLE_ENV = 'CTX_GUARD_ROLE'

export type RoleSource = 'command' | 'resume' | 'env' | 'repo-default' | 'user-default'

export type RoleResolution = {
  role: string | null
  // Where the role (or an explicit "none") came from; null when nothing set one.
  source: RoleSource | null
  // Why a requested role was not taken, for a toast and the report.
  problem: string | null
}

const SOURCE_TEXT: Record<RoleSource, string> = {
  command: '/ctx-guard role',
  resume: '/ctx-guard:resume role=',
  env: ROLE_ENV,
  'repo-default': 'the project defaultRole',
  'user-default': 'the userConfig defaultRole',
}

const isNone = (v: string): boolean => v.toLowerCase() === 'none'

/** A value with one pair of matching quotes around it, unquoted. */
export function unquote(v: string): string {
  const m = /^(["'])(.*)\1$/s.exec(v)
  return m ? (m[2] ?? '') : v
}

// unset: nothing asked, the defaults apply. none: an explicit "no role".
export type EnvRole = { kind: 'unset' } | { kind: 'none' } | { kind: 'role'; name: string }

/** An env value as a role request: trimmed and unquoted; empty is unset, `none` (any case) is no role. */
export function envRole(raw: string | null | undefined): EnvRole {
  if (typeof raw !== 'string') return { kind: 'unset' }
  const v = unquote(raw.trim()).trim()
  if (v === '') return { kind: 'unset' }
  return isNone(v) ? { kind: 'none' } : { kind: 'role', name: v }
}

/**
 * The role names to show, sorted. The built-in `main` is left out once the project names roles of
 * its own and gives `main` nothing (no settings, not its defaultRole), unless `keep` (the session's
 * role) is `main`. It still resolves, so a userConfig defaultRole of `main` works in every repo.
 */
export function listedRoles(config: Config, keep: string | null = null): string[] {
  const names = Object.keys(config.roles).sort()
  const main = config.roles.main
  const bare =
    main !== undefined &&
    names.length > 1 &&
    keep !== 'main' &&
    config.defaultRole !== 'main' &&
    JSON.stringify(main) === JSON.stringify(config.defaults)
  return bare ? names.filter(n => n !== 'main') : names
}

function knownRoles(config: Config): string {
  const names = listedRoles(config)
  return names.length ? names.join(', ') : 'none configured'
}

/** Why `name` cannot be a role under `config`, or null when it can. */
export function roleProblem(name: string, config: Config, source: RoleSource): string | null {
  const from = SOURCE_TEXT[source]
  if (!ROLE_NAME.test(name)) {
    return `role ${JSON.stringify(name)} from ${from} is not a valid role name (${ROLE_NAME.source}); running with no role`
  }
  if (!roleSpec(config, name)) {
    return `role "${name}" from ${from} is not in the config (roles: ${knownRoles(config)}); running with no role`
  }
  return null
}

export type ResolveInput = {
  claim: RoleClaim | null
  env: string | null | undefined
  repoDefault: string | null
  switchDefault: string | null
  interactive: boolean
  config: Config
}

/**
 * Command claim > env > repo defaultRole > userConfig defaultRole. The first
 * layer that asks for something decides: a bad name there gives no role and a
 * problem rather than falling through, so a typo never silently picks another
 * role. `none` (claimed or in env) is an explicit no-role that stops the walk.
 * Non-interactive (`-p`) sessions get no role.
 */
export function resolveRole(input: ResolveInput): RoleResolution {
  const { claim, env, repoDefault, switchDefault, interactive, config } = input
  if (!interactive) return { role: null, source: null, problem: null }
  const pick = (name: string, source: RoleSource): RoleResolution => {
    const problem = roleProblem(name, config, source)
    return problem ? { role: null, source: null, problem } : { role: name, source, problem: null }
  }
  if (claim) {
    const source: RoleSource = claim.source === 'resume' ? 'resume' : 'command'
    return claim.role === null ? { role: null, source, problem: null } : pick(claim.role, source)
  }
  const fromEnv = envRole(env)
  if (fromEnv.kind === 'none') return { role: null, source: 'env', problem: null }
  if (fromEnv.kind === 'role') return pick(fromEnv.name, 'env')
  if (repoDefault) return pick(repoDefault, 'repo-default')
  if (switchDefault) return pick(switchDefault, 'user-default')
  return { role: null, source: null, problem: null }
}

// ---- command arguments -------------------------------------------------------

export type RoleArg = { ok: true; role: string | null } | { ok: false; error: string }

/** The argument of `/ctx-guard role <name|none>`; null role is an explicit none. */
export function parseRoleArg(arg: string): RoleArg {
  const parts = (typeof arg === 'string' ? arg : '').trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 1) return { ok: false, error: 'usage: /ctx-guard role <name|none>' }
  const name = unquote(parts[0] as string)
  if (isNone(name)) return { ok: true, role: null }
  if (!ROLE_NAME.test(name)) return { ok: false, error: `${JSON.stringify(name)} is not a valid role name (${ROLE_NAME.source})` }
  return { ok: true, role: name }
}

export type ResumeArgs = {
  role: string | null
  handoff: string | null
  // Everything after the leading key=value pairs, as typed (trimmed).
  prompt: string
  errors: string[]
}

const RESUME_KEYS = ['role', 'handoff'] as const
// A value is "double quoted", 'single quoted' (spaces allowed) or bare.
const LEADING_PAIR = /^\s*([A-Za-z]+)=(?:"([^"]*)"|'([^']*)'|(\S*))(?=\s|$)/

/**
 * `$ARGUMENTS` of `/ctx-guard:resume role=<r> handoff=<p> <prompt>`. Only
 * leading `role=` / `handoff=` pairs are read (keys in any case, either
 * order, values optionally quoted); the first other token starts the prompt,
 * which keeps its own spaces and `=` signs.
 */
export function parseResumeArgs(args: string): ResumeArgs {
  const out: ResumeArgs = { role: null, handoff: null, prompt: '', errors: [] }
  let rest = typeof args === 'string' ? args : ''
  const seen = new Set<string>()
  for (;;) {
    const m = LEADING_PAIR.exec(rest)
    const key = m?.[1]?.toLowerCase()
    if (!m || !key || !(RESUME_KEYS as readonly string[]).includes(key)) break
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    rest = rest.slice(m[0].length)
    if (seen.has(key)) {
      out.errors.push(`${key}= given twice`)
      continue
    }
    seen.add(key)
    if (value === '') out.errors.push(`${key}= is empty`)
    else if (key === 'role') {
      if (ROLE_NAME.test(value)) out.role = value
      else out.errors.push(`role=${value} is not a valid role name (${ROLE_NAME.source})`)
    } else out.handoff = value
  }
  out.prompt = rest.trim()
  return out
}

export type ResumeClaim =
  | { kind: 'claim'; role: string }
  | { kind: 'same'; role: string }
  | { kind: 'skip' }
  | { kind: 'refuse'; reason: string }

/**
 * What `/ctx-guard:resume` does to the role the session holds now: a session
 * with none takes the requested role, the same role is a no-op, and a
 * different held role is refused, so one session never resumes another
 * role's handoff. Arguments that did not parse are refused outright.
 */
export function claimFromResume(held: string | null, args: ResumeArgs, config: Config): ResumeClaim {
  if (args.errors.length) return { kind: 'refuse', reason: `bad arguments: ${args.errors.join('; ')}` }
  const requested = args.role
  if (requested === null) return { kind: 'skip' }
  if (held === requested) return { kind: 'same', role: held }
  if (held !== null) {
    return {
      kind: 'refuse',
      reason: `this session holds role "${held}" and a session keeps one role; resume "${requested}" in its own session, or run /ctx-guard role none first`,
    }
  }
  const problem = roleProblem(requested, config, 'resume')
  if (problem) return { kind: 'refuse', reason: problem.replace(/; running with no role$/, '') }
  return { kind: 'claim', role: requested }
}

/**
 * The role whose own restart command `command` is, so typing it claims that
 * role as `/ctx-guard:resume role=` does. Null when it is no role's, when
 * several roles share it (it then says nothing about which), for
 * `/ctx-guard:resume` (it names its role itself) and for a role that compacts
 * (it runs no restart command).
 */
export function roleForCommand(config: Config, command: string): string | null {
  if (command === DEFAULT_RESTART_COMMAND) return null
  let found: string | null = null
  for (const name of Object.keys(config.roles)) {
    const spec = roleSpec(config, name)
    if (!spec || spec.restart.via !== 'clear' || spec.restart.command !== command) continue
    if (found !== null) return null
    found = name
  }
  return found
}

// ---- lease -------------------------------------------------------------------

// The owner file is rewritten at most this often (on measure and the band timer).
export const LEASE_HEARTBEAT_MS = 5 * 60 * 1000
// A heartbeat older than this is a dead session's; three missed beats.
export const LEASE_TTL_MS = 3 * LEASE_HEARTBEAT_MS

export type Owner = { sessionId: string; heartbeat: number }

export type Lease = { kind: 'free' } | { kind: 'mine' } | { kind: 'shared'; sessionId: string }

/** The owner file for `role`, relative to the root (stateDir is already confined). */
export function leasePath(stateDir: string, role: string): string {
  return `${stateDir.replace(/\/+$/, '')}/${role}.owner`
}

/** Owner-file text → its owner, or null for absent or garbage content. */
export function parseOwner(text: string | null): Owner | null {
  if (text === null) return null
  try {
    return asOwner(JSON.parse(text))
  } catch {
    return null
  }
}

function asOwner(v: unknown): Owner | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.sessionId !== 'string' || o.sessionId === '') return null
  if (typeof o.heartbeat !== 'number' || !Number.isFinite(o.heartbeat)) return null
  return { sessionId: o.sessionId, heartbeat: o.heartbeat }
}

/**
 * free (absent, garbage or stale), mine, or held by another live session. A
 * heartbeat further ahead than the TTL is garbage too, or a skewed clock could
 * hold a role forever.
 */
export function leaseState(owner: unknown, sessionId: string, now: number, ttl = LEASE_TTL_MS): Lease {
  const o = asOwner(owner)
  if (!o || o.heartbeat > now + ttl) return { kind: 'free' }
  if (o.sessionId === sessionId) return { kind: 'mine' }
  return now - o.heartbeat > ttl ? { kind: 'free' } : { kind: 'shared', sessionId: o.sessionId }
}

export function heartbeatDue(lastWrite: number | null, now: number): boolean {
  return lastWrite === null || now - lastWrite >= LEASE_HEARTBEAT_MS
}

export function ownerJson(sessionId: string, now: number): string {
  return `${JSON.stringify({ sessionId, heartbeat: now } satisfies Owner)}\n`
}
