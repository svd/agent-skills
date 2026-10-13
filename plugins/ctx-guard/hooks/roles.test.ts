import { describe, expect, test } from 'claude-code/testing'

import { validate } from './config'
import {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  claimFromResume,
  envRole,
  heartbeatDue,
  leasePath,
  leaseState,
  ownerJson,
  parseOwner,
  parseResumeArgs,
  parseRoleArg,
  resolveRole,
} from './roles'
import type { ResolveInput } from './roles'
import type { Config, RoleClaim } from '../types'

const config = validate({ version: 1, roles: { lead: {}, reviewer: {}, main: {} } }).config as Config

const claim = (role: string | null): RoleClaim => ({ role, source: 'command', at: 1 })

function resolve(over: Partial<ResolveInput>) {
  return resolveRole({ claim: null, env: undefined, repoDefault: null, switchDefault: null, interactive: true, config, ...over })
}

describe('resolveRole precedence', () => {
  const all = { claim: claim('lead'), env: 'reviewer', repoDefault: 'main', switchDefault: 'reviewer' }

  test('command beats env, repo default and user default', () => {
    expect(resolve(all)).toEqual({ role: 'lead', source: 'command', problem: null })
  })

  test('env beats both defaults', () => {
    expect(resolve({ ...all, claim: null })).toEqual({ role: 'reviewer', source: 'env', problem: null })
  })

  test('repo default beats user default', () => {
    expect(resolve({ ...all, claim: null, env: undefined, switchDefault: 'lead' })).toEqual({
      role: 'main',
      source: 'repo-default',
      problem: null,
    })
  })

  test('user default last', () => {
    expect(resolve({ switchDefault: 'lead' })).toEqual({ role: 'lead', source: 'user-default', problem: null })
  })

  test('nothing set: no role, no source, no problem', () => {
    expect(resolve({})).toEqual({ role: null, source: null, problem: null })
  })

  test('a claim of none beats env and defaults', () => {
    expect(resolve({ ...all, claim: claim(null) })).toEqual({ role: null, source: 'command', problem: null })
  })

  test('a resume claim beats env and reports its own source', () => {
    expect(resolve({ claim: { role: 'lead', source: 'resume', at: 1 }, env: 'reviewer' })).toEqual({ role: 'lead', source: 'resume', problem: null })
    expect(resolve({ claim: { role: 'ghost', source: 'resume', at: 1 } }).problem).toMatch(/ctx-guard:resume/)
  })

  test('non-interactive sessions get no role, whatever is set', () => {
    expect(resolve({ ...all, interactive: false })).toEqual({ role: null, source: null, problem: null })
  })
})

describe('env values', () => {
  test('trimmed and unquoted; empty and whitespace are unset; none in any case is no role', () => {
    expect(envRole('  lead \n')).toEqual({ kind: 'role', name: 'lead' })
    expect(envRole('"lead"')).toEqual({ kind: 'role', name: 'lead' })
    expect(envRole("'lead'")).toEqual({ kind: 'role', name: 'lead' })
    for (const v of ['', '   ', '""', undefined, null]) expect(envRole(v)).toEqual({ kind: 'unset' })
    for (const v of ['none', 'NONE', ' None ', '"none"']) expect(envRole(v)).toEqual({ kind: 'none' })
  })

  test('unset env falls through to the defaults', () => {
    for (const env of ['', ' ', '\t\n']) {
      expect(resolve({ env, switchDefault: 'lead' })).toEqual({ role: 'lead', source: 'user-default', problem: null })
    }
  })

  test('env none is an explicit no role that beats the defaults', () => {
    for (const env of ['none', 'NONE', ' none ']) {
      expect(resolve({ env, repoDefault: 'main', switchDefault: 'lead' })).toEqual({ role: null, source: 'env', problem: null })
    }
  })

  test('a command claim still beats env none', () => {
    expect(resolve({ claim: claim('lead'), env: 'none' }).role).toBe('lead')
  })

  test('whitespace around a name is ignored', () => {
    expect(resolve({ env: ' reviewer ' }).role).toBe('reviewer')
  })
})

describe('bad roles', () => {
  test('an unknown role gives no role and names the source and the known roles', () => {
    const r = resolve({ env: 'ghost', switchDefault: 'lead' })
    expect(r.role).toBeNull()
    expect(r.source).toBeNull()
    expect(r.problem).toMatch(/"ghost"/)
    expect(r.problem).toMatch(/CTX_GUARD_ROLE/)
    expect(r.problem).toMatch(/lead, main, reviewer/)
  })

  test('an invalid name is a problem, not a fall-through', () => {
    const r = resolve({ env: 'Lead' })
    expect(r.role).toBeNull()
    expect(r.problem).toMatch(/not a valid role name/)
  })

  test('an unknown claimed, repo or user default role is a problem naming its source', () => {
    expect(resolve({ claim: claim('ghost') }).problem).toMatch(/\/ctx-guard role/)
    expect(resolve({ repoDefault: 'ghost' }).problem).toMatch(/project defaultRole/)
    expect(resolve({ switchDefault: 'ghost' }).problem).toMatch(/userConfig defaultRole/)
  })

  test('prototype names are not roles', () => {
    expect(resolve({ env: 'constructor' }).role).toBeNull()
  })
})

describe('/ctx-guard role argument', () => {
  test('a name, none, or an error', () => {
    expect(parseRoleArg(' lead ')).toEqual({ ok: true, role: 'lead' })
    expect(parseRoleArg('none')).toEqual({ ok: true, role: null })
    expect(parseRoleArg('NONE')).toEqual({ ok: true, role: null })
    expect(parseRoleArg('"lead"')).toEqual({ ok: true, role: 'lead' })
    expect(parseRoleArg("'none'")).toEqual({ ok: true, role: null })
    expect(parseRoleArg('"lead').ok).toBe(false)
    expect(parseRoleArg('').ok).toBe(false)
    expect(parseRoleArg('lead reviewer').ok).toBe(false)
    expect(parseRoleArg('Lead')).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid role name/) })
  })
})

describe('/ctx-guard:resume arguments', () => {
  test('role, handoff and a prompt with spaces and = signs', () => {
    expect(parseResumeArgs('role=lead handoff=.ctx-guard/lead-handoff.md Carry on: set x=1 and  y=2 now')).toEqual({
      role: 'lead',
      handoff: '.ctx-guard/lead-handoff.md',
      prompt: 'Carry on: set x=1 and  y=2 now',
      errors: [],
    })
  })

  test('pairs in either order; no prompt', () => {
    expect(parseResumeArgs('  handoff=a/b.md role=reviewer  ')).toEqual({ role: 'reviewer', handoff: 'a/b.md', prompt: '', errors: [] })
  })

  test('only leading pairs are read; a later role= is prompt text', () => {
    const r = parseResumeArgs('role=lead go on role=reviewer')
    expect(r.role).toBe('lead')
    expect(r.prompt).toBe('go on role=reviewer')
  })

  test('another key=value starts the prompt', () => {
    expect(parseResumeArgs('mode=fast role=lead')).toEqual({ role: null, handoff: null, prompt: 'mode=fast role=lead', errors: [] })
  })

  test('empty, duplicate and invalid values are errors', () => {
    expect(parseResumeArgs('role= go').errors).toEqual(['role= is empty'])
    expect(parseResumeArgs('role=lead role=main go')).toMatchObject({ role: 'lead', errors: ['role= given twice'], prompt: 'go' })
    expect(parseResumeArgs('role=Lead go')).toMatchObject({ role: null, errors: [expect.stringMatching(/not a valid role name/)] })
  })

  test('keys in any case; quoted values, with spaces in quotes', () => {
    expect(parseResumeArgs(`ROLE="lead" Handoff='notes/my handoff.md' go "now"`)).toEqual({
      role: 'lead',
      handoff: 'notes/my handoff.md',
      prompt: 'go "now"',
      errors: [],
    })
  })

  test('no arguments', () => {
    expect(parseResumeArgs('')).toEqual({ role: null, handoff: null, prompt: '', errors: [] })
  })
})

describe('claimFromResume', () => {
  const args = (s: string) => parseResumeArgs(s)

  test('claims when none is held', () => {
    expect(claimFromResume(null, args('role=lead go'), config)).toEqual({ kind: 'claim', role: 'lead' })
  })

  test('same role is fine', () => {
    expect(claimFromResume('lead', args('role=lead'), config)).toEqual({ kind: 'same', role: 'lead' })
  })

  test('a conflicting held role is refused with a reason', () => {
    const r = claimFromResume('reviewer', args('role=lead'), config)
    expect(r.kind).toBe('refuse')
    if (r.kind === 'refuse') expect(r.reason).toMatch(/holds role "reviewer"/)
  })

  test('no role= leaves the role alone', () => {
    expect(claimFromResume('lead', args('handoff=h.md go'), config)).toEqual({ kind: 'skip' })
  })

  test('an unknown role is refused', () => {
    expect(claimFromResume(null, args('role=ghost'), config).kind).toBe('refuse')
  })

  test('arguments with errors are refused, even with a good role', () => {
    const r = claimFromResume(null, args('role=lead role=main go'), config)
    expect(r).toEqual({ kind: 'refuse', reason: 'bad arguments: role= given twice' })
  })
})

describe('lease', () => {
  const now = 10_000_000
  const me = 'session-a'

  test('path under the state dir', () => {
    expect(leasePath('.ctx-guard', 'lead')).toBe('.ctx-guard/lead.owner')
    expect(leasePath('state/', 'lead')).toBe('state/lead.owner')
  })

  test('free when absent', () => {
    expect(leaseState(null, me, now)).toEqual({ kind: 'free' })
    expect(leaseState(parseOwner(null), me, now)).toEqual({ kind: 'free' })
  })

  test('mine', () => {
    expect(leaseState(parseOwner(ownerJson(me, now - LEASE_TTL_MS * 10)), me, now)).toEqual({ kind: 'mine' })
  })

  test('shared with a live other session', () => {
    expect(leaseState({ sessionId: 'session-b', heartbeat: now - LEASE_TTL_MS }, me, now)).toEqual({ kind: 'shared', sessionId: 'session-b' })
  })

  test('free when the other session is stale', () => {
    expect(leaseState({ sessionId: 'session-b', heartbeat: now - LEASE_TTL_MS - 1 }, me, now)).toEqual({ kind: 'free' })
  })

  test('a heartbeat further ahead than the TTL is garbage', () => {
    expect(leaseState({ sessionId: 'session-b', heartbeat: now + LEASE_TTL_MS + 1 }, me, now)).toEqual({ kind: 'free' })
    expect(leaseState({ sessionId: 'session-b', heartbeat: now + 1000 }, me, now)).toEqual({ kind: 'shared', sessionId: 'session-b' })
  })

  test('free on garbage', () => {
    for (const text of ['', 'not json', '[]', '"x"', '{"sessionId":""}', '{"sessionId":"b","heartbeat":"1"}', '{"heartbeat":1}']) {
      expect(leaseState(parseOwner(text), me, now)).toEqual({ kind: 'free' })
    }
    expect(leaseState(42, me, now)).toEqual({ kind: 'free' })
  })

  test('owner JSON round-trips', () => {
    expect(parseOwner(ownerJson(me, now))).toEqual({ sessionId: me, heartbeat: now })
  })

  test('TTL is three heartbeats; heartbeat due after one interval', () => {
    expect(LEASE_TTL_MS).toBe(3 * LEASE_HEARTBEAT_MS)
    expect(heartbeatDue(null, now)).toBe(true)
    expect(heartbeatDue(now - LEASE_HEARTBEAT_MS + 1, now)).toBe(false)
    expect(heartbeatDue(now - LEASE_HEARTBEAT_MS, now)).toBe(true)
  })
})
