import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_SWITCHES,
  builtInConfig,
  canonicalJson,
  confinePath,
  deepMerge,
  defaultTriggers,
  effectiveConfig,
  effectiveWindow,
  asConfig,
  asConfigState,
  resolveWindow,
  localPathFor,
  mergeLayers,
  parseLayer,
  parseQuantity,
  pathError,
  readSwitches,
  roleSpec,
  sha256Hex,
  subagentBudget,
  asTrustRecord,
  checkScripts,
  trustFields,
  trustHash,
  trustKey,
  trustState,
  validate,
  zeroConfigTriggers,
} from './config'
import type { FileLayer } from './config'
import type { Config } from '../types'

const TEAM = '.claude/ctx-guard.json'
const LOCAL = '.claude/ctx-guard.local.json'

const file = (path: string, value: unknown): FileLayer => ({ path, text: JSON.stringify(value) })
const absent = (path: string): FileLayer => ({ path, text: null })

function ok(raw: unknown): Config {
  const r = validate(raw)
  expect(r.errors).toEqual([])
  return r.config as Config
}

function errorsOf(raw: unknown): string[] {
  const r = validate(raw)
  expect(r.config).toBeNull()
  return r.errors
}

const role = (spec: unknown) => ({ version: 1, roles: { lead: spec } })

describe('quantities', () => {
  test('tokens: suffixes, plain numbers, numeric strings', () => {
    const t = ['tokens'] as const
    expect(parseQuantity('300k', t, 'tokens')).toEqual({ kind: 'tokens', value: 300_000 })
    expect(parseQuantity('300K', t, 'tokens')).toEqual({ kind: 'tokens', value: 300_000 })
    expect(parseQuantity('1.2M', t, 'tokens')).toEqual({ kind: 'tokens', value: 1_200_000 })
    expect(parseQuantity('1.2m', t, 'tokens')).toEqual({ kind: 'tokens', value: 1_200_000 })
    expect(parseQuantity(' 150k ', t, 'tokens')).toEqual({ kind: 'tokens', value: 150_000 })
    expect(parseQuantity(150000, t, 'tokens')).toEqual({ kind: 'tokens', value: 150_000 })
    expect(parseQuantity('150000', t, 'tokens')).toEqual({ kind: 'tokens', value: 150_000 })
    expect(parseQuantity(1234.6, t, 'tokens')).toEqual({ kind: 'tokens', value: 1235 })
  })

  test('percent: with %, or bare where the field says so', () => {
    expect(parseQuantity('40%', ['tokens', 'percent'], 'tokens')).toEqual({ kind: 'percent', value: 40 })
    expect(parseQuantity('12.5 %', ['percent'])).toEqual({ kind: 'percent', value: 12.5 })
    expect(parseQuantity(80, ['percent'], 'percent')).toEqual({ kind: 'percent', value: 80 })
    expect(parseQuantity('80', ['percent'], 'percent')).toEqual({ kind: 'percent', value: 80 })
    expect(parseQuantity('100%', ['percent'])).toEqual({ kind: 'percent', value: 100 })
    expect(parseQuantity('101%', ['percent'])).toBeNull()
    expect(parseQuantity(150, ['percent'], 'percent')).toBeNull()
  })

  test('durations: ms, s, m, h, d', () => {
    const d = ['duration'] as const
    expect(parseQuantity('10s', d)).toEqual({ kind: 'duration', value: 10_000 })
    expect(parseQuantity('10m', d)).toEqual({ kind: 'duration', value: 600_000 })
    expect(parseQuantity('50m', d)).toEqual({ kind: 'duration', value: 3_000_000 })
    expect(parseQuantity('2h', d)).toEqual({ kind: 'duration', value: 7_200_000 })
    expect(parseQuantity('1d', d)).toEqual({ kind: 'duration', value: 86_400_000 })
    expect(parseQuantity('250ms', d)).toEqual({ kind: 'duration', value: 250 })
    expect(parseQuantity('1.5h', d)).toEqual({ kind: 'duration', value: 5_400_000 })
  })

  test('a bare number is no duration', () => {
    expect(parseQuantity(600, ['duration'])).toBeNull()
    expect(parseQuantity('600', ['duration'])).toBeNull()
  })

  test('"10m" is minutes or millions by field, never both', () => {
    expect(parseQuantity('10m', ['duration'])?.kind).toBe('duration')
    expect(parseQuantity('10m', ['tokens'], 'tokens')?.kind).toBe('tokens')
  })

  test('USD with $ or bare', () => {
    expect(parseQuantity('$2.50', ['usd'], 'usd')).toEqual({ kind: 'usd', value: 2.5 })
    expect(parseQuantity(5, ['usd'], 'usd')).toEqual({ kind: 'usd', value: 5 })
    expect(parseQuantity('5', ['usd'], 'usd')).toEqual({ kind: 'usd', value: 5 })
  })

  test('kinds are distinct: a field refuses kinds it does not take', () => {
    expect(parseQuantity('40%', ['tokens'], 'tokens')).toBeNull()
    expect(parseQuantity('300k', ['percent'], 'percent')).toBeNull()
    expect(parseQuantity('10m', ['percent'], 'percent')).toBeNull()
    expect(parseQuantity('$2', ['tokens'], 'tokens')).toBeNull()
    expect(parseQuantity('2h', ['tokens'], 'tokens')).toBeNull()
  })

  test('garbage, zero, negatives and non-finite numbers are refused', () => {
    const any = ['tokens', 'percent', 'usd'] as const
    for (const bad of ['', 'abc', '300kk', 'k300', '1,000', '-5', '-5k', '0', '0k', '0%', '1e6', '30 tokens', 'NaN']) {
      expect(parseQuantity(bad, any, 'tokens')).toBeNull()
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, {}, []]) {
      expect(parseQuantity(bad, any, 'tokens')).toBeNull()
    }
    expect(parseQuantity('5x', ['duration'])).toBeNull()
    expect(parseQuantity('0s', ['duration'])).toBeNull()
  })
})

describe('merge', () => {
  test('objects deep-merge, later wins', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 4, e: 5 }, f: 6 })).toEqual({
      a: 1,
      b: { c: 2, d: 4, e: 5 },
      f: 6,
    })
  })

  test('arrays replace, never concatenate', () => {
    expect(deepMerge({ xs: [1, 2, 3] }, { xs: [9] })).toEqual({ xs: [9] })
    expect(mergeLayers({ t: [{ id: 'a' }] }, { t: [] })).toEqual({ t: [] })
  })

  test('scalars replace; null deletes; absent keeps', () => {
    expect(deepMerge({ a: { b: 1 }, c: 2 }, { a: null })).toEqual({ c: 2 })
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: null } })).toEqual({ a: { c: 2 } })
    expect(deepMerge({ a: 1 }, { a: 'x' })).toEqual({ a: 'x' })
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 })
  })

  test('inputs are not mutated', () => {
    const base = { a: { b: 1 } }
    deepMerge(base, { a: { b: 2 } })
    expect(base).toEqual({ a: { b: 1 } })
  })

  test('prototype keys are dropped', () => {
    const merged = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}')) as Record<string, unknown>
    expect(merged.ok).toBe(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false)
  })
})

describe('validation', () => {
  test('the plan example validates', () => {
    const c = ok({
      version: 1,
      enabled: true,
      stateDir: '.ctx-guard',
      readyToken: 'CTX-READY',
      defaultRole: null,
      contextWindow: 'auto',
      defaults: {},
      roles: {
        lead: {
          description: 'long-running coordinator',
          triggers: [
            { id: 'ctx-soft', when: { context: '30%' }, do: ['note'], level: 'soft' },
            { id: 'ctx-hard', when: { context: '50%' }, do: ['note'], level: 'hard' },
            { id: 'ctx-stop', when: { context: '70%', every: '10%' }, do: ['note', { deny: ['Agent'] }], level: 'stop' },
            { id: '5h', when: { 'limit.five_hour': 80 }, do: ['note', 'toast'] },
            { id: 'brake', when: { 'limit.any': 95 }, do: [{ deny: ['Agent', 'Workflow'] }] },
            { id: 'idle', when: { idle: '50m', context: '150k' }, do: ['notify'] },
            { id: 'squeeze', when: { context: '85%' }, do: ['compact'] },
            { id: 'spend', when: { cost: '$20' }, do: ['toast'], message: 'Spent {limit}' },
          ],
          notes: { suffix: 'Tell the peer session before you stop.' },
          handoff: { path: '.ctx-guard/{role}-handoff.md', instructions: 'Rewrite whole.' },
          restart: {
            mode: 'auto',
            via: 'clear',
            command: 'ctx-guard:resume',
            prompt: 'Carry out Next action without waiting.',
            peers: ['master'],
            peerGap: '10m',
            readyChecks: [{ run: ['./scripts/ready-check.sh'], timeout: '10s' }],
          },
          compact: { instructions: 'Keep open tasks, decisions, file paths.' },
        },
      },
      subagents: { '*': { warn: '120k', stop: '170k' }, Explore: { stop: '150k', message: 'Budget reached.' } },
    })
    const lead = c.roles.lead
    expect(lead?.triggers).toHaveLength(8)
    expect(lead?.triggers[2]?.when.every).toEqual({ kind: 'percent', value: 10 })
    expect(lead?.triggers[2]?.when.everyMetric).toBe('context')
    expect(lead?.triggers[0]?.when.everyMetric).toBeNull()
    expect(lead?.triggers[2]?.when.context).toEqual({ kind: 'percent', value: 70 })
    expect(lead?.triggers[3]?.when['limit.five_hour']).toEqual({ kind: 'percent', value: 80 })
    expect(lead?.triggers[3]?.level).toBeNull()
    expect(lead?.triggers[5]?.when.idle).toEqual({ kind: 'duration', value: 3_000_000 })
    expect(lead?.triggers[5]?.when.context).toEqual({ kind: 'tokens', value: 150_000 })
    expect(lead?.triggers[7]?.when.cost).toEqual({ kind: 'usd', value: 20 })
    expect(lead?.restart.peerGap).toBe(600_000)
    expect(lead?.restart.readyChecks).toEqual([{ run: ['./scripts/ready-check.sh'], timeout: 10_000 }])
    expect(c.subagents).toEqual({
      '*': { warn: 120_000, stop: 170_000, message: null },
      Explore: { warn: null, stop: 150_000, message: 'Budget reached.' },
    })
  })

  test('bad role names', () => {
    for (const name of ['Lead', '1lead', 'lead_x', '-x', 'a'.repeat(33), '']) {
      const errors = errorsOf({ roles: { [name]: {} } })
      expect(errors.join('\n')).toContain('role name must match')
    }
    ok({ roles: { a: {}, 'peer-2': {}, ['a'.repeat(32)]: {} } })
  })

  test('duplicate trigger id within a role', () => {
    const errors = errorsOf(
      role({
        triggers: [
          { id: 'x', when: { context: '10%' }, do: ['note'] },
          { id: 'x', when: { context: '20%' }, do: ['note'] },
        ],
      }),
    )
    expect(errors).toEqual(['config: roles.lead.triggers[1].id: duplicate trigger id "x"'])
  })

  test('the same id in two roles is fine', () => {
    const t = [{ id: 'x', when: { context: '10%' }, do: ['note'] }]
    ok({ roles: { a: { triggers: t }, b: { triggers: t } } })
  })

  test('unknown metric', () => {
    const errors = errorsOf(role({ triggers: [{ id: 'x', when: { context: '10%', tokens: 5 }, do: ['note'] }] }))
    expect(errors.join('\n')).toContain('roles.lead.triggers[0].when.tokens: unknown key')
  })

  test('a trigger needs a metric; every alone is none', () => {
    expect(errorsOf(role({ triggers: [{ id: 'x', when: {}, do: ['note'] }] })).join('\n')).toContain('needs at least one metric')
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { every: '10%' }, do: ['note'] }] })).join('\n')).toContain(
      'needs at least one metric',
    )
  })

  test('every needs exactly one stepped metric and parses as it', () => {
    expect(
      errorsOf(role({ triggers: [{ id: 'x', when: { context: '10%', 'limit.any': 80, every: '5%' }, do: ['note'] }] })).join('\n'),
    ).toContain('when.every: needs exactly one')
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { idle: '5m', every: '5m' }, do: ['notify'] }] })).join('\n')).toContain(
      'when.every: needs exactly one of context, limit.five_hour, limit.seven_day, limit.any, cost to step; none is set',
    )
    expect(
      errorsOf(role({ triggers: [{ id: 'x', when: { 'limit.five_hour': 80, 'limit.seven_day': 80, every: 5 }, do: ['note'] }] })).join('\n'),
    ).toContain('limit.five_hour and limit.seven_day are all set')
    const c = ok(role({ triggers: [{ id: 'x', when: { 'limit.any': 80, every: 5 }, do: ['note'] }] }))
    expect(c.roles.lead?.triggers[0]?.when.every).toEqual({ kind: 'percent', value: 5 })
    const t = ok(role({ triggers: [{ id: 'x', when: { context: '300k', every: '100k' }, do: ['note'] }] }))
    expect(t.roles.lead?.triggers[0]?.when.every).toEqual({ kind: 'tokens', value: 100_000 })
    expect(t.roles.lead?.triggers[0]?.when.everyMetric).toBe('context')
    expect(c.roles.lead?.triggers[0]?.when.everyMetric).toBe('limit.any')
    // A step must be the stepped threshold's own kind.
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { context: '70%', every: '100k' }, do: ['note'] }] })).join('\n')).toContain(
      'when.every: expected a percent',
    )
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { context: '300k', every: '10%' }, do: ['note'] }] })).join('\n')).toContain(
      'when.every: expected tokens',
    )
    const bare = ok(role({ triggers: [{ id: 'x', when: { context: '70%', every: 5 }, do: ['note'] }] }))
    expect(bare.roles.lead?.triggers[0]?.when.every).toEqual({ kind: 'percent', value: 5 })
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { cost: 5, every: '10%' }, do: ['note'] }] })).join('\n')).toContain(
      'when.every: expected US dollars',
    )
  })

  test('metric values of the wrong kind', () => {
    const e1 = errorsOf(role({ triggers: [{ id: 'x', when: { context: 'lots' }, do: ['note'] }] }))
    expect(e1).toEqual([
      'config: roles.lead.triggers[0].when.context: expected tokens ("300k", "1.2M", 150000) or a percent ("40%"), got "lots"',
    ])
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { 'limit.five_hour': '300k' }, do: ['note'] }] })).join('\n')).toContain(
      'when.limit.five_hour: expected a percent',
    )
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { idle: 50 }, do: ['notify'] }] })).join('\n')).toContain(
      'when.idle: expected a duration',
    )
  })

  test('resetsIn takes a duration and needs its own window beside it', () => {
    const c = ok(role({ triggers: [{ id: 'x', when: { 'limit.seven_day': 80, 'limit.seven_day.resetsIn': '2d', every: 5 }, do: ['note'] }] }))
    const when = c.roles.lead?.triggers[0]?.when
    expect(when?.['limit.seven_day.resetsIn']).toEqual({ kind: 'duration', value: 2 * 24 * 3_600_000 })
    expect(when?.everyMetric).toBe('limit.seven_day')
    expect(errorsOf(role({ triggers: [{ id: 'x', when: { 'limit.seven_day.resetsIn': '2d' }, do: ['note'] }] }))).toEqual([
      'config: roles.lead.triggers[0].when.limit.seven_day.resetsIn: needs limit.seven_day in the same `when`',
    ])
    expect(
      errorsOf(role({ triggers: [{ id: 'x', when: { 'limit.five_hour': 80, 'limit.seven_day.resetsIn': '2d' }, do: ['note'] }] })),
    ).toEqual(['config: roles.lead.triggers[0].when.limit.seven_day.resetsIn: needs limit.seven_day in the same `when`'])
    expect(
      errorsOf(role({ triggers: [{ id: 'x', when: { 'limit.five_hour': 80, 'limit.five_hour.resetsIn': 60 }, do: ['note'] }] })).join('\n'),
    ).toContain('when.limit.five_hour.resetsIn: expected a duration')
  })

  test('bad level', () => {
    const errors = errorsOf(role({ triggers: [{ id: 'x', when: { context: '10%' }, do: ['note'], level: 'urgent' }] }))
    expect(errors).toEqual(['config: roles.lead.triggers[0].level: expected one of soft, hard, stop, got "urgent"'])
  })

  test('bad actions', () => {
    const t = (d: unknown) => role({ triggers: [{ id: 'x', when: { context: '10%' }, do: d }] })
    expect(errorsOf(t([])).join('\n')).toContain('do: expected a non-empty list of actions')
    expect(errorsOf(t('note')).join('\n')).toContain('do: expected a non-empty list of actions')
    expect(errorsOf(t(['shout'])).join('\n')).toContain('do[0]: expected one of note, toast, notify, compact')
    expect(errorsOf(t([{ deny: [] }])).join('\n')).toContain('do[0].deny: expected a non-empty list of tool names')
    expect(errorsOf(t([{ deny: ['Agent'], also: 1 }])).join('\n')).toContain('do[0].also: unknown key')
    const idle = role({ triggers: [{ id: 'x', when: { idle: '5m' }, do: [{ deny: ['Agent'] }] }] })
    expect(errorsOf(idle).join('\n')).toContain('deny cannot be combined with an idle metric')
  })

  test('trigger needs id, when and do; id has a shape', () => {
    const errors = errorsOf(role({ triggers: [{}] }))
    expect(errors).toContain('config: roles.lead.triggers[0].id: required')
    expect(errors).toContain('config: roles.lead.triggers[0].when: required')
    expect(errorsOf(role({ triggers: [{ id: 'has space', when: { context: '1%' }, do: ['note'] }] })).join('\n')).toContain(
      'triggers[0].id: "has space" must match',
    )
  })

  test('unknown keys at every level', () => {
    const errors = errorsOf({
      version: 1,
      colour: 'red',
      roles: {
        lead: {
          extra: 1,
          handoff: { where: 'x' },
          restart: { mode: 'auto', when: 'now' },
          notes: { prefix: 'x' },
          compact: { how: 'x' },
          triggers: [{ id: 'x', when: { context: '1%' }, do: ['note'], why: 'x' }],
        },
      },
      subagents: { Explore: { stop: '10k', limit: 5 } },
    })
    for (const path of [
      'colour',
      'roles.lead.extra',
      'roles.lead.handoff.where',
      'roles.lead.restart.when',
      'roles.lead.notes.prefix',
      'roles.lead.compact.how',
      'roles.lead.triggers[0].why',
      'subagents.Explore.limit',
    ]) {
      expect(errors.join('\n')).toContain(`config: ${path}: unknown key`)
    }
  })

  test('scalar fields', () => {
    expect(errorsOf({ version: 2 })).toEqual(['config: version: unsupported version 2; this ctx-guard reads version 1'])
    expect(errorsOf({ enabled: 'yes' })[0]).toContain('enabled: expected true or false')
    expect(errorsOf({ readyToken: 'ready now' })[0]).toContain('readyToken: "ready now" must match')
    expect(errorsOf({ defaultRole: 'Lead' })[0]).toContain('defaultRole: "Lead" must match')
    expect(errorsOf({ contextWindow: '50%' })[0]).toContain('contextWindow: expected "auto" or tokens')
    expect(ok({ contextWindow: '200k' }).contextWindow).toBe(200_000)
    expect(ok({ contextWindow: 'auto' }).contextWindow).toBe('auto')
    expect(ok({ defaultRole: '' }).defaultRole).toBeNull()
    expect(errorsOf([1, 2])[0]).toBe('config: (top level): expected an object, got [1,2]')
  })

  test('restart, handoff and ready checks', () => {
    const r = (restart: unknown) => role({ restart })
    expect(errorsOf(r({ mode: 'sometimes' }))[0]).toContain('restart.mode: expected one of auto, manual, off')
    expect(errorsOf(r({ via: 'reboot' }))[0]).toContain('restart.via: expected one of clear, compact')
    expect(errorsOf(r({ peers: ['Master'] }))[0]).toContain('restart.peers[0]: "Master" must match')
    expect(errorsOf(r({ peerGap: 10 }))[0]).toContain('restart.peerGap: expected a duration')
    expect(ok(r({ selfGap: '2m' })).roles.lead?.restart.selfGap).toBe(120_000)
    expect(ok(r({ selfGap: '0' })).roles.lead?.restart.selfGap).toBe(0)
    expect(ok(r({ selfGap: 0 })).roles.lead?.restart.selfGap).toBe(0)
    expect(errorsOf(r({ selfGap: 5 }))[0]).toContain('restart.selfGap: expected a duration')
    expect(errorsOf(r({ selfGap: '-1m' }))[0]).toContain('restart.selfGap: expected a duration')
    expect(ok(r({ minContext: '40%' })).roles.lead?.restart.minContext).toEqual({ kind: 'percent', value: 40 })
    expect(ok(r({ minContext: '300k' })).roles.lead?.restart.minContext).toEqual({ kind: 'tokens', value: 300_000 })
    expect(ok(r({ minContext: 300000 })).roles.lead?.restart.minContext).toEqual({ kind: 'tokens', value: 300_000 })
    expect(ok(r({ minContext: 'off' })).roles.lead?.restart.minContext).toBeNull()
    expect(errorsOf(r({ minContext: '$2' }))[0]).toContain('restart.minContext: expected')
    for (const bad of ['two words', 'a;rm -rf', 'x.y', 'cmd\n']) {
      expect(errorsOf(r({ command: bad }))[0]).toContain('is not a command name')
    }
    expect(ok(r({ command: 'plugin:restart_lead-2' })).roles.lead?.restart.command).toBe('plugin:restart_lead-2')
    expect(errorsOf(r({ readyChecks: [{ run: [] }] }))[0]).toContain('readyChecks[0].run: expected a non-empty list')
    expect(errorsOf(r({ readyChecks: [{ run: 'make check' }] }))[0]).toContain('readyChecks[0].run')
    expect(errorsOf(r({ readyChecks: [{ run: ['x'], timeout: '11m' }] }))[0]).toContain('longer than the 10m maximum')
    expect(ok(r({ command: '/restart-lead' })).roles.lead?.restart.command).toBe('restart-lead')
    expect(ok(r({ readyChecks: [{ run: ['make', 'check'] }] })).roles.lead?.restart.readyChecks).toEqual([
      { run: ['make', 'check'], timeout: 30_000 },
    ])
    expect(errorsOf(role({ handoff: { style: 'session-handoff' } }))[0]).toContain('handoff.style: unknown key')
    expect(errorsOf(role({ handoff: { path: 'notes/{who}.md' } }))[0]).toContain('unknown placeholder or a stray brace')
    expect(errorsOf(role({ handoff: { path: 'notes/{role.md' } }))[0]).toContain('unknown placeholder or a stray brace')
    for (const bad of ['my handoff.md', 'a/{role} x.md', 'h.md; rm -rf x', 'a\tb.md', 'h$(x).md']) {
      expect(errorsOf(role({ handoff: { path: bad } }))[0]).toContain('may hold only letters, digits')
    }
    expect(ok(role({ handoff: { path: 'docs/{role}/handoff.md' } })).roles.lead?.handoff.path).toBe('docs/{role}/handoff.md')
    expect(errorsOf({ stateDir: 'state {role}' })[0]).toContain('stateDir: "state {role}" may hold only')
    expect(errorsOf({ stateDir: '{role}' })[0]).toEndWith('may hold only letters, digits and . _ - /')
    expect(errorsOf(role({ handoff: { path: '../outside.md' } }))[0]).toContain('must stay under the project root')
    expect(errorsOf(role({ handoff: { path: '/etc/passwd' } }))[0]).toContain('must be relative to the project root')
    expect(errorsOf({ stateDir: '../x' })[0]).toContain('stateDir: "../x" must stay under')
  })

  test('subagent budgets', () => {
    expect(errorsOf({ subagents: { Explore: { warn: '20%' } } })[0]).toContain('subagents.Explore.warn: expected tokens')
    expect(errorsOf({ subagents: { Explore: { warn: '200k', stop: '100k' } } })[0]).toContain('warn (200000) must be below stop (100000)')
    expect(errorsOf({ subagents: { Explore: {} } })[0]).toContain('subagents.Explore: needs warn, stop or message')
    expect(errorsOf({ subagents: { Explore: 5 } })[0]).toContain('subagents.Explore: expected {"warn"')
    expect(errorsOf({ subagents: { Explore: { stop: 'never' } } })[0]).toContain('subagents.Explore.stop: expected tokens ("120k") or "off"')
    // The check sees what a type inherits from "*".
    expect(errorsOf({ subagents: { '*': { warn: '120k' }, Explore: { stop: '100k' } } })[0]).toContain(
      'subagents.Explore: warn (120000 from "*") must be below stop (100000)',
    )
    expect(ok({ subagents: { '*': { warn: '120k' }, Explore: { warn: 'off', stop: '100k' } } }).subagents.Explore?.warn).toBe('off')
  })

  test('a type merges field by field over "*"; "off" drops a step, an unset or null one inherits', () => {
    const c = ok({
      subagents: {
        '*': { warn: '120k', stop: '170k', message: 'star' },
        Explore: { stop: '150k', message: 'mine' },
        Plan: { warn: 'off' },
        quiet: { warn: 'off', stop: 'off' },
        nulls: { warn: null, stop: '160k' },
      },
    })
    expect(c.subagents.Plan).toEqual({ warn: 'off', stop: null, message: null })
    expect(subagentBudget(c, 'Explore')).toEqual({ type: 'Explore', warn: 120_000, stop: 150_000, message: 'mine' })
    expect(subagentBudget(c, 'Plan')).toEqual({ type: 'Plan', warn: null, stop: 170_000, message: 'star' })
    expect(subagentBudget(c, 'quiet')).toBeNull()
    expect(subagentBudget(c, 'nulls')).toEqual({ type: 'nulls', warn: 120_000, stop: 160_000, message: 'star' })
    // An unknown type, or none known, runs under "*".
    expect(subagentBudget(c, 'general-purpose')).toEqual({ type: '*', warn: 120_000, stop: 170_000, message: 'star' })
    expect(subagentBudget(c, null)).toEqual(subagentBudget(c, '*'))
    expect(subagentBudget(ok({ subagents: { Explore: { stop: '10k' } } }), 'general-purpose')).toBeNull()
    // A merge the validation never saw: a warn at or past the stop is dropped.
    const odd = { ...c, subagents: { '*': { warn: 200_000, stop: null, message: null }, Explore: { warn: null, stop: 150_000, message: null } } }
    expect(subagentBudget(odd as Config, 'Explore')).toEqual({ type: 'Explore', warn: null, stop: 150_000, message: null })
  })

  test('a local "off" turns off a team step; a local null brings back the "*" value', () => {
    const team = file(TEAM, { subagents: { '*': { warn: '100k', stop: '200k' }, Explore: { warn: '50k', stop: '150k' } } })
    const local = file(LOCAL, { subagents: { Explore: { warn: null, stop: 'off' } } })
    const e = effectiveConfig({ switches: DEFAULT_SWITCHES, files: [team, local], lastGood: null })
    expect(e.errors).toEqual([])
    expect(subagentBudget(e.config, 'Explore')).toEqual({ type: 'Explore', warn: 100_000, stop: null, message: null })
  })

  test('reserved names are refused as roles and subagent types', () => {
    for (const name of ['constructor', 'prototype']) {
      expect(errorsOf(JSON.parse(`{"roles": {"${name}": {}}}`))).toEqual([`config: roles.${name}: role name is reserved`])
    }
    expect(errorsOf(JSON.parse('{"roles": {"__proto__": {}}}'))[0]).toContain('roles.__proto__: role name must match')
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(errorsOf(JSON.parse(`{"subagents": {"${type}": {"stop": "10k"}}}`))[0]).toContain(`subagents.${type}: expected "*"`)
    }
  })

  test('lookups never reach Object.prototype, even after a JSON round trip', () => {
    const c = ok({ roles: { lead: {} }, subagents: { Explore: { stop: '10k' } } })
    const copy = JSON.parse(JSON.stringify(c)) as Config
    for (const cfg of [c, copy]) {
      expect(roleSpec(cfg, 'constructor')).toBeNull()
      expect(roleSpec(cfg, 'toString')).toBeNull()
      expect(roleSpec(cfg, 'lead')?.restart.mode).toBe('manual')
      expect(subagentBudget(cfg, 'constructor')).toBeNull()
      expect(subagentBudget(cfg, 'Explore')?.stop).toBe(10_000)
    }
    expect(c.roles.constructor).toBeUndefined()
  })

  test('within one layer a null key is the same as absent', () => {
    const c = ok({
      defaultRole: null,
      stateDir: null,
      roles: { lead: { notes: null, restart: { mode: null, prompt: null }, handoff: { instructions: null } } },
      subagents: { Explore: { warn: null, stop: '10k' } },
    })
    expect(c.defaultRole).toBeNull()
    expect(c.stateDir).toBe('.ctx-guard')
    expect(c.roles.lead?.restart).toMatchObject({ mode: 'manual', prompt: null })
    expect(c.subagents.Explore).toEqual({ warn: null, stop: 10_000, message: null })
    expect(errorsOf(role({ triggers: [null] }))[0]).toContain('triggers[0]: expected a trigger object')
    expect(errorsOf(role({ triggers: [{ id: null, when: { context: '1%' }, do: ['note'] }] }))[0]).toContain('triggers[0].id: required')
  })

  test('errors are collected, not thrown, and never crash on odd input', () => {
    for (const raw of [null, 5, 'x', { roles: 5 }, { roles: { lead: 5 } }, { defaults: [] }, { subagents: [] }, role({ triggers: 'x' })]) {
      const r = validate(raw)
      expect(r.config).toBeNull()
      expect(r.errors.length).toBeGreaterThan(0)
    }
  })
})

describe('defaults inheritance', () => {
  test('a role inherits defaults, its own keys win, arrays replace', () => {
    const c = ok({
      defaults: {
        notes: { suffix: 'from defaults' },
        handoff: { instructions: 'default handoff' },
        restart: { mode: 'auto', peers: ['b'], peerGap: '5m' },
        triggers: [{ id: 'd', when: { context: '50%' }, do: ['note'] }],
      },
      roles: {
        a: {},
        b: {
          restart: { peers: ['a'] },
          triggers: [{ id: 'own', when: { context: '20%' }, do: ['toast'] }],
        },
      },
    })
    expect(c.roles.a?.notes.suffix).toBe('from defaults')
    expect(c.roles.a?.restart).toMatchObject({ mode: 'auto', peers: ['b'], peerGap: 300_000 })
    expect(c.roles.a?.triggers.map(t => t.id)).toEqual(['d'])
    expect(c.roles.b?.restart).toMatchObject({ mode: 'auto', peers: ['a'], peerGap: 300_000 })
    expect(c.roles.b?.triggers.map(t => t.id)).toEqual(['own'])
    expect(c.roles.b?.handoff.instructions).toBe('default handoff')
    expect(c.defaults.notes.suffix).toBe('from defaults')
  })

  test('with no triggers anywhere a role gets the built-in ladder', () => {
    const c = ok({ roles: { a: {} } })
    expect(c.roles.a?.triggers).toEqual(defaultTriggers())
    expect(c.roles.a?.triggers.map(t => t.id)).toEqual(['ctx-soft', 'ctx-hard', 'ctx-stop', 'limit-soft', 'limit-hard', 'week-80-early', 'week-90-early', 'limit-stop'])
  })

  test('an empty triggers list means none', () => {
    expect(ok({ roles: { a: { triggers: [] } } }).roles.a?.triggers).toEqual([])
  })

  test('built-in role values, with the handoff under stateDir', () => {
    const c = ok({ stateDir: './state/', roles: { a: {} } })
    expect(c.stateDir).toBe('state')
    expect(c.roles.a?.handoff).toEqual({ path: 'state/{role}-handoff.md', instructions: null })
    expect(c.roles.a?.restart).toEqual({
      mode: 'manual',
      via: 'clear',
      command: 'ctx-guard:resume',
      prompt: null,
      peers: [],
      peerGap: 600_000,
      selfGap: 300_000,
      minContext: null,
      readyChecks: [],
    })
  })

  test('an error in defaults is reported once, under defaults', () => {
    const errors = errorsOf({ defaults: { restart: { mode: 'x' } }, roles: { a: {}, b: {} } })
    expect(errors).toEqual(['config: defaults.restart.mode: expected one of auto, manual, off, got "x"'])
  })
})

describe('layers and fallback', () => {
  const sw = DEFAULT_SWITCHES

  test('zero-config: no files gives the built-ins, nothing falls back', () => {
    const e = effectiveConfig({ switches: sw, files: [absent(TEAM), absent(LOCAL)], lastGood: null })
    expect(e.source).toBe('built-in')
    expect(e.fallback).toBe(false)
    expect(e.errors).toEqual([])
    expect(e.autoActions).toBe(true)
    expect(e.config.defaultRole).toBeNull()
    expect(Object.keys(e.config.roles)).toEqual(['main'])
    expect(e.config.subagents).toEqual({})
    expect(e.config).toEqual(builtInConfig())
  })

  test('zero-config triggers only toast, at 50/70/85% context and 80/90% usage', () => {
    const z = zeroConfigTriggers()
    expect(z.every(t => t.do.length === 1 && t.do[0] === 'toast')).toBe(true)
    expect(z.filter(t => t.when.context).map(t => t.when.context?.value)).toEqual([50, 70, 85])
    expect(z.filter(t => t.when['limit.any']).map(t => t.when['limit.any']?.value)).toEqual([80, 90])
  })

  test('team then local: objects merge, arrays replace', () => {
    const team = file(TEAM, {
      version: 1,
      roles: {
        lead: {
          notes: { suffix: 'team' },
          restart: { mode: 'auto', peers: ['b', 'c'] },
          triggers: [{ id: 't', when: { context: '50%' }, do: ['note'] }],
        },
      },
    })
    const local = file(LOCAL, { roles: { lead: { restart: { peers: ['z'] }, triggers: [{ id: 'l', when: { context: '10%' }, do: ['toast'] }] } } })
    const e = effectiveConfig({ switches: sw, files: [team, local], lastGood: null })
    expect(e.errors).toEqual([])
    expect(e.source).toBe('files')
    const lead = e.config.roles.lead
    expect(lead?.notes.suffix).toBe('team')
    expect(lead?.restart.mode).toBe('auto')
    expect(lead?.restart.peers).toEqual(['z'])
    expect(lead?.triggers.map(t => t.id)).toEqual(['l'])
    expect(Object.keys(e.config.roles).sort()).toEqual(['lead', 'main'])
  })

  test('userConfig defaultRole stays beside the merge, so a repo null cannot erase it', () => {
    const switches = { ...sw, defaultRole: 'main' }
    const none = effectiveConfig({ switches, files: [], lastGood: null })
    expect(none.config.defaultRole).toBeNull()
    expect(none.switchDefaultRole).toBe('main')
    const nulled = effectiveConfig({ switches, files: [file(TEAM, { version: 1, defaultRole: null })], lastGood: null })
    expect(nulled.errors).toEqual([])
    expect(nulled.config.defaultRole).toBeNull()
    expect(nulled.switchDefaultRole).toBe('main')
    const team = file(TEAM, { defaultRole: 'lead', roles: { lead: {} } })
    const both = effectiveConfig({ switches, files: [team], lastGood: null })
    expect(both.config.defaultRole).toBe('lead')
    expect(both.switchDefaultRole).toBe('main')
    expect(effectiveConfig({ switches: sw, files: [], lastGood: null }).switchDefaultRole).toBeNull()
  })

  test('a local null deletes the team key: the built-in or inherited value applies', () => {
    const team = file(TEAM, {
      defaults: { notes: { suffix: 'from defaults' } },
      roles: { lead: { notes: { suffix: 'team' }, restart: { mode: 'auto', prompt: 'go' } } },
      subagents: { Explore: { stop: '150k' }, '*': { stop: '200k' } },
    })
    const local = file(LOCAL, {
      roles: { main: null, lead: { notes: { suffix: null }, restart: { mode: null, prompt: null } } },
      subagents: { Explore: null },
    })
    const e = effectiveConfig({ switches: sw, files: [team, local], lastGood: null })
    expect(e.errors).toEqual([])
    expect(Object.keys(e.config.roles)).toEqual(['lead'])
    expect(e.config.roles.lead?.restart).toMatchObject({ mode: 'manual', prompt: null })
    expect(e.config.roles.lead?.notes.suffix).toBe('from defaults')
    expect(Object.keys(e.config.subagents)).toEqual(['*'])
  })

  test('a local file with no team file', () => {
    const local = file(LOCAL, { roles: { solo: { restart: { mode: 'off' } } } })
    const e = effectiveConfig({ switches: sw, files: [absent(TEAM), local], lastGood: null })
    expect(e.errors).toEqual([])
    expect(e.source).toBe('files')
    expect(e.config.roles.solo?.restart.mode).toBe('off')
  })

  test('an error only the merge shows still keeps the last good config', () => {
    const good = effectiveConfig({ switches: sw, files: [file(TEAM, { roles: { lead: {} } })], lastGood: null }).config
    const team = file(TEAM, { subagents: { Explore: { stop: '150k' } } })
    const local = file(LOCAL, { subagents: { Explore: { warn: '200k' } } })
    const e = effectiveConfig({ switches: sw, files: [team, local], lastGood: good })
    expect(e.source).toBe('last-good')
    expect(e.fallback).toBe(true)
    expect(e.autoActions).toBe(true)
    expect(e.config).toEqual(good)
    expect(e.errors).toEqual(['effective config: subagents.Explore: warn (200000) must be below stop (150000)'])
  })

  test('an invalid file keeps the last good config, errors name the file', () => {
    const good = effectiveConfig({ switches: sw, files: [file(TEAM, { roles: { lead: {} } })], lastGood: null })
    const bad = effectiveConfig({
      switches: sw,
      files: [file(TEAM, { roles: { Lead: {} } }), absent(LOCAL)],
      lastGood: good.config,
    })
    expect(bad.source).toBe('last-good')
    expect(bad.fallback).toBe(true)
    expect(bad.config).toEqual(good.config)
    expect(bad.autoActions).toBe(true)
    expect(bad.errors).toEqual([`${TEAM}: roles.Lead: role name must match ^[a-z][a-z0-9-]{0,31}$`])
  })

  test('an invalid local file blocks the team file too', () => {
    const e = effectiveConfig({
      switches: sw,
      files: [file(TEAM, { roles: { lead: {} } }), { path: LOCAL, text: '{ not json' }],
      lastGood: null,
    })
    expect(e.errors).toHaveLength(1)
    expect(e.errors[0]).toStartWith(`${LOCAL}: invalid JSON:`)
    expect(e.source).toBe('built-in')
  })

  test('invalid with no last good: built-ins with auto actions off', () => {
    const e = effectiveConfig({ switches: sw, files: [file(TEAM, { version: 3 })], lastGood: null })
    expect(e.source).toBe('built-in')
    expect(e.fallback).toBe(true)
    expect(e.autoActions).toBe(false)
    expect(e.config).toEqual(builtInConfig())
    expect(e.errors).toEqual([`${TEAM}: version: unsupported version 3; this ctx-guard reads version 1`])
  })

  test('layers valid alone but not together are reported on the merge', () => {
    const team = file(TEAM, { subagents: { Explore: { stop: '150k' } } })
    const local = file(LOCAL, { subagents: { Explore: { warn: '200k' } } })
    const e = effectiveConfig({ switches: sw, files: [team, local], lastGood: null })
    expect(e.fallback).toBe(true)
    expect(e.errors).toEqual(['effective config: subagents.Explore: warn (200000) must be below stop (150000)'])
  })

  test('switches: enabled ANDs with the file, kill switches pass through', () => {
    const off = file(TEAM, { enabled: false })
    expect(effectiveConfig({ switches: sw, files: [off], lastGood: null }).enabled).toBe(false)
    expect(effectiveConfig({ switches: { ...sw, enabled: false }, files: [], lastGood: null }).enabled).toBe(false)
    const e = effectiveConfig({ switches: { ...sw, blocking: false, autoActions: false, display: 'status' }, files: [], lastGood: null })
    expect(e).toMatchObject({ enabled: true, blocking: false, autoActions: false, display: 'status' })
  })

  test('parseLayer: absent, bad JSON, non-object', () => {
    expect(parseLayer(absent(TEAM))).toEqual({ raw: null, errors: [] })
    expect(parseLayer({ path: TEAM, text: '[]' }).errors).toEqual([`${TEAM}: expected a JSON object at the top level`])
    expect(parseLayer({ path: TEAM, text: '' }).errors[0]).toStartWith(`${TEAM}: invalid JSON`)
  })

  test('readSwitches fills defaults and refuses bad values', () => {
    expect(readSwitches({})).toEqual({ switches: DEFAULT_SWITCHES, errors: [] })
    const r = readSwitches({ defaultRole: ' main ', display: 'status', configPath: 'cfg/guard.json' })
    expect(r.switches).toMatchObject({ defaultRole: 'main', display: 'status', configPath: 'cfg/guard.json' })
    const bad = readSwitches({ defaultRole: 'Main', display: 'loud', configPath: '/etc/x.json', blocking: 'no' })
    expect(bad.switches).toEqual(DEFAULT_SWITCHES)
    expect(bad.errors).toHaveLength(4)
  })

  test('local override path', () => {
    expect(localPathFor('.claude/ctx-guard.json')).toBe('.claude/ctx-guard.local.json')
    expect(localPathFor('cfg/guard')).toBe('cfg/guard.local.json')
  })
})

describe('paths', () => {
  test('confined joins', () => {
    expect(confinePath('/repo', '.ctx-guard/lead-handoff.md')).toEqual({ path: '/repo/.ctx-guard/lead-handoff.md' })
    expect(confinePath('/repo/', './a//b/../c')).toEqual({ path: '/repo/a/c' })
  })

  test('escapes and absolute paths are refused', () => {
    for (const bad of ['/etc/passwd', '\\\\server\\x', '~/x', 'C:\\x', '..', '../x', 'a/../../x', 'a\\..\\..\\x', '', '.', './', 'a\0b']) {
      expect(pathError(bad)).not.toBeNull()
      expect('error' in confinePath('/repo', bad)).toBe(true)
    }
    expect(pathError(5)).toBe('expected a relative path')
    expect(pathError('a/../b')).toBeNull()
  })
})

describe('trust hash', () => {
  const base = {
    version: 1,
    roles: {
      lead: {
        triggers: [
          { id: 'n', when: { context: '50%' }, do: ['note'] },
          { id: 'sq', when: { context: '85%' }, do: ['compact'] },
        ],
        notes: { suffix: 's' },
        handoff: { instructions: 'h' },
        restart: { mode: 'auto', command: 'ctx-guard:resume', prompt: 'go', peers: ['b'], readyChecks: [{ run: ['make', 'ok'] }] },
        compact: { instructions: 'keep tasks' },
      },
    },
    subagents: { '*': { stop: '100k' } },
  }
  const hashOf = (over: unknown) => trustHash(ok(mergeLayers(base, over)))
  const h0 = hashOf({})

  test('sha256 matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(sha256Hex('é€😀')).toBe('df9226927fd572c1ee66eec85de1bb139497614899f36e4e90474cb71f6ef9d0')
  })

  test('stable: same config, same hash; key order does not matter', () => {
    expect(hashOf({})).toBe(h0)
    expect(h0).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
    const reordered = { subagents: base.subagents, roles: base.roles, version: 1 }
    expect(trustHash(ok(reordered))).toBe(h0)
  })

  test('a value a role overrides does not reach its hash through defaults', () => {
    expect(hashOf({ defaults: { restart: { prompt: 'inherited' } } })).toBe(h0)
  })

  test('non-sensitive changes keep the hash', () => {
    for (const over of [
      { roles: { lead: { notes: { suffix: 'other' } } } },
      { roles: { lead: { handoff: { instructions: 'other' } } } },
      { roles: { lead: { description: 'new' } } },
      { subagents: { '*': { stop: '50k' } } },
      {
        roles: {
          lead: {
            triggers: [
              { id: 'n', when: { context: '20%' }, do: ['note', 'toast'] },
              { id: 'sq', when: { context: '85%' }, do: ['compact'] },
            ],
          },
        },
      },
    ]) {
      expect(hashOf(over)).toBe(h0)
    }
  })

  test('each sensitive field changes the hash', () => {
    for (const over of [
      { roles: { lead: { restart: { mode: 'manual' } } } },
      { roles: { lead: { restart: { via: 'compact' } } } },
      { roles: { lead: { restart: { command: 'restart-lead' } } } },
      { roles: { lead: { restart: { prompt: 'go now' } } } },
      { roles: { lead: { restart: { readyChecks: [{ run: ['make', 'evil'] }] } } } },
      { roles: { lead: { restart: { readyChecks: [{ run: ['make', 'ok'], timeout: '5m' }] } } } },
      { roles: { lead: { compact: { instructions: 'drop everything' } } } },
      { roles: { lead: { handoff: { path: 'elsewhere/{role}.md' } } } },
      { stateDir: 'state' },
      { readyToken: 'GO' },
      { roles: { lead: { restart: { peers: ['c'] } } } },
      { roles: { lead: { restart: { peerGap: '30m' } } } },
      {
        roles: {
          lead: {
            triggers: [
              { id: 'n', when: { context: '50%' }, do: ['note'] },
              { id: 'sq', when: { context: '60%' }, do: ['compact'] },
            ],
          },
        },
      },
      { roles: { lead: { triggers: [{ id: 'n', when: { context: '50%' }, do: ['note', 'compact'] }] } } },
      { roles: { other: { restart: { mode: 'auto' } } } },
      { defaults: { restart: { via: 'compact' } } },
      { roles: { lead: { restart: { selfGap: '0' } } } },
      { roles: { lead: { restart: { minContext: '40%' } } } },
    ]) {
      expect(hashOf(over)).not.toBe(h0)
    }
  })

  test('trust state: approved hash trusts; a change names its field; none approved lists all', () => {
    const c0 = ok(mergeLayers(base, {}))
    const record = { hash: trustHash(c0), fields: trustFields(c0), at: 5 }
    expect(trustState(c0, record)).toEqual({ trusted: true, changed: [], record })
    const c1 = ok(mergeLayers(base, { roles: { lead: { restart: { readyChecks: [{ run: ['make', 'evil'] }] } } } }))
    expect(trustState(c1, record)).toEqual({ trusted: false, changed: ['lead.restart'], record })
    const c2 = ok(mergeLayers(base, { roles: { other: { restart: { mode: 'auto' } } } }))
    expect(trustState(c2, record).changed).toEqual(['other.compact', 'other.compactTriggers', 'other.handoff', 'other.restart'])
    const c3 = ok(mergeLayers(base, { readyToken: 'GO' }))
    expect(trustState(c3, record).changed).toEqual(['*.readyToken'])
    // A script's content is part of the approval.
    const withScript = { hash: trustHash(c0, { './ready.sh': 'aa' }), fields: trustFields(c0, { './ready.sh': 'aa' }), at: 5 }
    expect(trustState(c0, withScript, { './ready.sh': 'aa' }).trusted).toBe(true)
    expect(trustState(c0, withScript, { './ready.sh': 'bb' }).changed).toEqual(['script:./ready.sh'])
    expect(checkScripts(ok(mergeLayers(base, { roles: { lead: { restart: { readyChecks: [{ run: ['./a.sh'] }, { run: ['bash', 'scripts/b.sh', '--fast'] }] } } } })))).toEqual(['./a.sh', 'bash', 'scripts/b.sh'])
    expect(Object.keys(trustFields(c0))).toContain('lead.handoff')
  })

  test('none approved lists only the fields that hold something', () => {
    // `base` holds compact instructions and a compact trigger: both need approval.
    expect(trustState(ok(mergeLayers(base, {})), null).changed).toEqual(expect.arrayContaining(['lead.compact', 'lead.compactTriggers']))
    const plain = ok({ version: 1, roles: { lead: { restart: { mode: 'auto' } } } })
    const all = Object.keys(trustFields(plain)).sort()
    expect(all).toContain('lead.compact')
    expect(trustState(plain, null)).toEqual({ trusted: false, changed: all.filter(k => !k.endsWith('.compact') && !k.endsWith('.compactTriggers')), record: null })
    expect(trustState(plain, null, { './ready.sh': 'aa' }).changed).toContain('script:./ready.sh')
  })

  test('trust records are checked and keyed by root', () => {
    expect(trustKey('/repo/')).toBe('trust:/repo')
    expect(asTrustRecord({ hash: 'h', fields: { a: 'x', b: 3 }, at: 1 })).toEqual({ hash: 'h', fields: { a: 'x' }, at: 1 })
    expect(asTrustRecord({ hash: 1 })).toBeNull()
    expect(asTrustRecord(undefined)).toBeNull()
  })
})

describe('effectiveWindow', () => {
  test('a fixed window wins over everything', () => {
    expect(effectiveWindow(200_000, 1_000_000, 150_000)).toBe(200_000)
  })

  test('auto is the model window, lowered by autoCompactWindow', () => {
    expect(effectiveWindow('auto', 1_000_000, undefined)).toBe(1_000_000)
    expect(effectiveWindow('auto', 1_000_000, 400_000)).toBe(400_000)
    expect(effectiveWindow('auto', 200_000, 400_000)).toBe(200_000)
  })

  test('a junk autoCompactWindow is ignored', () => {
    for (const junk of ['300000', -5, 0, Number.NaN, null]) expect(effectiveWindow('auto', 1_000_000, junk)).toBe(1_000_000)
  })
})

describe('effectiveConfig read errors', () => {
  test('a file that could not be read keeps the last good config', () => {
    const good = effectiveConfig({ switches: DEFAULT_SWITCHES, files: [file(TEAM, { version: 1, roles: { lead: {} } })], lastGood: null })
    const r = effectiveConfig({ switches: DEFAULT_SWITCHES, files: [], lastGood: good.config, readErrors: [`${TEAM}: unreadable`] })
    expect(r.source).toBe('last-good')
    expect(r.errors).toEqual([`${TEAM}: unreadable`])
    expect(roleSpec(r.config, 'lead')).not.toBeNull()
  })
})

describe('resolveWindow', () => {
  test('a fixed window comes from the config', () => {
    expect(resolveWindow(200_000, 1_000_000, { tokens: 150_000, source: 'settings' }, 100_000)).toEqual({ tokens: 200_000, source: 'config' })
  })

  test('auto takes the engine window, capped at the model window', () => {
    expect(resolveWindow('auto', 1_000_000, { tokens: 400_000, source: 'env' }, undefined)).toEqual({ tokens: 400_000, source: 'engine: env' })
    expect(resolveWindow('auto', 200_000, { tokens: 400_000, source: 'model-default' }, undefined).tokens).toBe(200_000)
  })

  test('with no engine window, the settings fallback', () => {
    expect(resolveWindow('auto', 1_000_000, null, 300_000)).toEqual({ tokens: 300_000, source: 'autoCompactWindow setting' })
    expect(resolveWindow('auto', 1_000_000, { tokens: 0, source: 'x' }, undefined)).toEqual({ tokens: 1_000_000, source: 'model window' })
  })
})

describe('stored config state', () => {
  const good = builtInConfig()

  test('a normalized config passes, junk does not', () => {
    expect(asConfig(good)).toBe(good)
    expect(asConfig(JSON.parse(JSON.stringify(good)))).not.toBeNull()
    for (const junk of [null, 1, {}, { ...good, version: 2 }, { ...good, roles: { x: { triggers: 'no' } } }, { ...good, contextWindow: -1 }]) {
      expect(asConfig(junk)).toBeNull()
    }
  })

  test('a bad lastGood is dropped, the rest kept', () => {
    const s = asConfigState({ lastGood: { version: 1 }, source: 'files', errors: ['e'], files: [{ path: 'a', mtime: 1 }, 'x'], loadedAt: 5 })
    expect(s).toEqual({ lastGood: null, source: 'files', errors: ['e'], files: [{ path: 'a', mtime: 1 }], loadedAt: 5 })
    expect(asConfigState({ errors: 'x' })).toBeNull()
    expect(asConfigState(null)).toBeNull()
  })
})

describe('band probes', () => {
  const band = (probes: unknown) => ({ version: 1, band: { probes } })

  test('defaults, and a full entry', () => {
    expect(ok({ version: 1 }).band).toEqual({ probes: [] })
    expect(ok(band([{ id: 'run', run: ['./probe.sh'] }])).band.probes).toEqual([{ id: 'run', run: ['./probe.sh'], every: 60_000, timeout: 5_000 }])
    expect(ok(band([{ id: 'run', run: ['sh', 'p.sh'], every: '15s', timeout: '30s' }])).band.probes[0]).toEqual({ id: 'run', run: ['sh', 'p.sh'], every: 15_000, timeout: 30_000 })
  })

  test('errors', () => {
    expect(errorsOf(band('x'))[0]).toContain('band.probes: expected a list')
    expect(errorsOf(band([{ run: ['./p.sh'] }]))[0]).toContain('band.probes[0].id: is required')
    expect(errorsOf(band([{ id: 'Run', run: ['./p.sh'] }]))[0]).toContain('band.probes[0].id')
    expect(errorsOf(band([{ id: 'run', run: [] }]))[0]).toContain('band.probes[0].run: expected a non-empty list')
    expect(errorsOf(band([{ id: 'run', run: ['./p.sh'], every: '10s' }]))[0]).toContain('shorter than the 15s minimum')
    expect(errorsOf(band([{ id: 'run', run: ['./p.sh'], timeout: '31s' }]))[0]).toContain('longer than the 30s maximum')
    expect(errorsOf(band([{ id: 'run', run: ['./a.sh'] }, { id: 'run', run: ['./b.sh'] }]))[0]).toContain('duplicate probe id "run"')
    const five = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, run: ['./p.sh'] }))
    expect(errorsOf(band(five))[0]).toContain('band.probes: at most 4 probes, got 5')
    expect(errorsOf(band([{ id: 'run', run: ['./p.sh'], shell: true }]))[0]).toContain('band.probes[0].shell: unknown key')
    expect(errorsOf({ version: 1, band: { segments: [] } })[0]).toContain('band.segments: unknown key')
  })

  test('a later layer replaces the list', () => {
    const merged = mergeLayers(band([{ id: 'a', run: ['./a.sh'] }, { id: 'b', run: ['./b.sh'] }]), band([{ id: 'c', run: ['./c.sh'] }]))
    expect(ok(merged).band.probes.map(p => p.id)).toEqual(['c'])
  })

  test('a stored config from before band reads as no probes; a bad band is not a config', () => {
    const stored = JSON.parse(JSON.stringify(builtInConfig())) as Record<string, unknown>
    delete stored.band
    expect(asConfig(stored)?.band).toEqual({ probes: [] })
    expect(asConfig({ ...stored, band: { probes: 'x' } })).toBeNull()
    expect(asConfig({ ...stored, band: { probes: [{ id: 'run' }] } })).toBeNull()
  })

  test('trust: probes and their scripts are approved; no probes leaves an old approval valid', () => {
    const plain = ok({ version: 1, roles: { lead: { restart: { mode: 'auto' } } } })
    expect(Object.keys(trustFields(plain))).not.toContain('*.band')
    // The hash of a config without probes is what it was before band existed.
    const material = JSON.parse(JSON.stringify(plain)) as Record<string, unknown>
    delete material.band
    expect(trustHash(plain)).toBe(trustHash(material as never))
    const withProbe = ok({ version: 1, roles: { lead: { restart: { mode: 'auto' } } }, band: { probes: [{ id: 'run', run: ['./probe.sh', '--fast'] }] } })
    const record = { hash: trustHash(plain), fields: trustFields(plain), at: 1 }
    expect(trustState(withProbe, record).changed).toEqual(['*.band'])
    expect(checkScripts(withProbe)).toEqual(['./probe.sh'])
  })
})
