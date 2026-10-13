import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_PAUSE_MS,
  PRESETS,
  collidingCommand,
  gitignoreWith,
  isPaused,
  parseCommand,
  parsePause,
  reportText,
  starterConfig,
  triggerLine,
  versionBelow,
} from './commands'
import type { ReportInput } from './commands'
import { builtInConfig, roleSpec, validate } from './config'
import { metricsOf } from './triggers'

describe('parseCommand', () => {
  test('no args is the report', () => {
    expect(parseCommand('')).toEqual({ kind: 'report' })
    expect(parseCommand('   ')).toEqual({ kind: 'report' })
  })

  test('subcommands and their arguments', () => {
    expect(parseCommand('role lead')).toEqual({ kind: 'role', arg: 'lead' })
    expect(parseCommand('ROLE  none')).toEqual({ kind: 'role', arg: 'none' })
    expect(parseCommand('reload')).toEqual({ kind: 'reload' })
    expect(parseCommand('pause 10m')).toEqual({ kind: 'pause', arg: '10m' })
    expect(parseCommand('pause')).toEqual({ kind: 'pause', arg: '' })
    expect(parseCommand('init')).toEqual({ kind: 'init', preset: 'solo' })
    expect(parseCommand('init peers')).toEqual({ kind: 'init', preset: 'peers' })
  })

  test('anything else is usage with the reason', () => {
    expect(parseCommand('reload now')).toEqual({ kind: 'usage', error: 'reload takes no arguments' })
    expect(parseCommand('init team')).toEqual({ kind: 'usage', error: 'unknown preset "team"; use solo or peers' })
    expect(parseCommand('check')).toEqual({ kind: 'usage', error: 'unknown subcommand "check"' })
  })
})

describe('pause', () => {
  test('default, a duration, and off', () => {
    expect(parsePause('')).toEqual({ ok: true, ms: DEFAULT_PAUSE_MS })
    expect(parsePause('10m')).toEqual({ ok: true, ms: 600_000 })
    expect(parsePause('2h')).toEqual({ ok: true, ms: 7_200_000 })
    expect(parsePause('off')).toEqual({ ok: true, ms: null })
  })

  test('a bare number or junk is refused', () => {
    expect(parsePause('10').ok).toBe(false)
    expect(parsePause('soon').ok).toBe(false)
  })

  test('isPaused until the end time', () => {
    expect(isPaused({ until: 100 }, 99)).toBe(true)
    expect(isPaused({ until: 100 }, 100)).toBe(false)
    expect(isPaused(null, 0)).toBe(false)
    expect(isPaused({ until: 'x' } as never, 0)).toBe(false)
  })
})

describe('starters', () => {
  test('each preset is a valid config', () => {
    for (const p of PRESETS) {
      const r = validate(JSON.parse(starterConfig(p)), p)
      expect(r.errors).toEqual([])
    }
  })

  test('solo defaults to main; peers name each other', () => {
    const solo = validate(JSON.parse(starterConfig('solo'))).config
    expect(solo?.defaultRole).toBe('main')
    const peers = validate(JSON.parse(starterConfig('peers'))).config
    expect(peers ? roleSpec(peers, 'lead')?.restart.peers : null).toEqual(['reviewer'])
    expect(peers ? roleSpec(peers, 'reviewer')?.restart.peers : null).toEqual(['lead'])
    expect(peers?.defaultRole).toBeNull()
  })
})

describe('gitignoreWith', () => {
  const LINES = ['.claude/ctx-guard.local.json', '.ctx-guard/']

  test('a missing file gets every line', () => {
    expect(gitignoreWith(null, LINES)).toEqual({ text: '.claude/ctx-guard.local.json\n.ctx-guard/\n', added: LINES })
  })

  test('appends after a last line with no newline', () => {
    expect(gitignoreWith('node_modules/', LINES)?.text).toBe('node_modules/\n.claude/ctx-guard.local.json\n.ctx-guard/\n')
  })

  test('lines already there, in any slash spelling, are not added again', () => {
    expect(gitignoreWith('/.claude/ctx-guard.local.json\n.ctx-guard\n', LINES)).toBeNull()
    expect(gitignoreWith('.ctx-guard/\n', LINES)).toEqual({ text: '.ctx-guard/\n.claude/ctx-guard.local.json\n', added: [LINES[0] as string] })
  })
})

describe('start-up checks', () => {
  test('versionBelow compares the release triple', () => {
    expect(versionBelow({ version: '2.1.280' }, '2.1.293')).toBe(true)
    expect(versionBelow({ version: '2.1.293' }, '2.1.293')).toBe(false)
    expect(versionBelow({ version: '2.2.0' }, '2.1.293')).toBe(false)
    expect(versionBelow({ version: '2.1.300-dev.20261001', base: '2.1.300-dev' }, '2.1.293')).toBe(false)
    expect(versionBelow({ version: '1.9.999' }, '2.1.293')).toBe(true)
    expect(versionBelow({ version: 'custom' }, '2.1.293')).toBe(false)
  })

  test('collidingCommand ignores this plugin and builds of unnamed plugin commands', () => {
    const self = 'ctx-guard'
    expect(collidingCommand([{ name: 'ctx-guard', source: 'plugin', plugin: 'ctx-guard' }], 'ctx-guard', self)).toBeNull()
    expect(collidingCommand([{ name: 'ctx-guard', source: 'plugin' }], 'ctx-guard', self)).toBeNull()
    expect(collidingCommand([{ name: 'ctx-guard:resume', source: 'plugin', plugin: 'x' }], 'ctx-guard', self)).toBeNull()
    expect(collidingCommand([{ name: 'ctx-guard', source: 'plugin', plugin: 'x' }], 'ctx-guard', self)?.plugin).toBe('x')
    expect(collidingCommand([{ name: 'ctx-guard', source: 'user' }], 'ctx-guard', self)?.source).toBe('user')
  })
})

describe('report', () => {
  const config = (() => {
    const r = validate({
      version: 1,
      roles: { lead: { triggers: [{ id: 'stop', when: { context: '70%', every: '10%' }, do: ['note', { deny: ['Agent'] }], level: 'stop' }] } },
    })
    return r.config ?? builtInConfig()
  })()
  const lead = roleSpec(config, 'lead')

  test('triggerLine', () => {
    expect(lead ? triggerLine(lead.triggers[0] as never) : '').toBe('stop: context ≥ 70% and every 10% → note, deny Agent [stop]')
  })

  test('the report names role, config, metrics, marks and blocks', () => {
    const input: ReportInput = {
      now: 10_000_000,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'lead', source: 'env', problem: null },
      configState: {
        lastGood: config,
        source: 'files',
        errors: ['.claude/ctx-guard.local.json: roles.x: bad'],
        files: [
          { path: '.claude/ctx-guard.json', mtime: 10_000_000 - 120_000 },
          { path: '.claude/ctx-guard.local.json', mtime: null },
        ],
        loadedAt: 0,
      },
      config,
      switches: { blocking: true, autoActions: true, display: 'band' },
      windowSource: 'engine: settings',
      mode: 'manual',
      metrics: metricsOf({ tokens: 750_000, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }], cost: { usd: 1.5 } }, 1_000_000, 0, 10_000_000),
      marks: { role: 'lead', byId: { stop: { step: 0, at: 10_000_000 - 60_000 } } },
      triggers: lead?.triggers ?? [],
      denies: [{ tool: 'Agent', triggerId: 'stop' }],
      lastClearAt: null,
    }
    const text = reportText(input)
    for (const want of [
      'ctx-guard: on',
      'role: lead (from CTX_GUARD_ROLE)',
      'config: files',
      '.claude/ctx-guard.json: modified 2m ago',
      '.claude/ctx-guard.local.json: absent',
      'error: .claude/ctx-guard.local.json: roles.x: bad',
      'contextWindow auto = 1M (engine: settings)',
      'stop: context ≥ 70% and every 10% → note, deny Agent [stop]',
      'restart: manual',
      'context: 750k (75% of 1M)',
      'usage 5-hour: 42%',
      'cost: $1.50',
      'idle: a turn is running',
      'marks: stop (1m ago)',
      'blocks: Agent (stop)',
    ]) {
      expect(text).toContain(want)
    }
  })

  test('off, paused and no role read so', () => {
    const base: ReportInput = {
      now: 0,
      interactive: false,
      off: 'enabled is false',
      pause: null,
      role: { role: null, source: null, problem: null },
      configState: null,
      config: builtInConfig(),
      switches: { blocking: false, autoActions: false, display: 'off' },
      windowSource: 'model window',
      mode: null,
      metrics: metricsOf({}, 1_000_000, null, 0),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
    }
    const off = reportText(base)
    expect(off).toContain('ctx-guard: off (enabled is false)')
    expect(off).toContain('role: none (non-interactive session: no role)')
    expect(off).toContain('context: unknown')
    expect(off).toContain('blocks: none')
    expect(reportText({ ...base, off: null, pause: { until: 600_000 } })).toContain('ctx-guard: paused for 10m more')
  })
})
