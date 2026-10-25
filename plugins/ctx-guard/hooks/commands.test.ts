import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_PAUSE_MS,
  PRESETS,
  PRESET_DIR,
  cacheLine,
  collidingCommand,
  gitignoreWith,
  isPaused,
  parseCommand,
  parsePause,
  presetPath,
  presetProblem,
  reachLine,
  reachLines,
  reportText,
  triggerLine,
  versionBelow,
  wakePlan,
  wantsTrust,
} from './commands'
import type { CacheReport, ReportInput, RestartReport } from './commands'
import type { RoleReach } from './tune'
import { BUILTIN_LAYER, builtInConfig, mergeLayers, roleSpec, validate } from './config'
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

  test('wake: a window and text, or off', () => {
    expect(parseCommand('wake 5h')).toEqual({ kind: 'wake', window: 'five_hour', text: null })
    expect(parseCommand('wake 7D  run the suite ')).toEqual({ kind: 'wake', window: 'seven_day', text: 'run the suite' })
    expect(parseCommand('wake off')).toEqual({ kind: 'wake', window: null, text: null })
    expect(parseCommand('wake off now')).toEqual({ kind: 'usage', error: 'wake off takes no text' })
    expect(parseCommand('wake')).toEqual({ kind: 'usage', error: 'wake takes 5h, 7d or off' })
    expect(parseCommand('wake 1d')).toEqual({ kind: 'usage', error: 'wake takes 5h, 7d or off, not "1d"' })
  })

  test('wakePlan: the window\'s usage now, refused with none, a reset window or under 5 %', () => {
    const m = (rateLimits: unknown) => metricsOf({ rateLimits } as never, 1_000_000, null, Date.parse('2026-10-13T12:00:00Z'))
    const five = [{ kind: 'five_hour', percentUsed: 60, resetsAt: '2026-10-13T14:00:00Z' }]
    expect(wakePlan('five_hour', 'go', m(five))).toEqual({ ok: true, wake: { window: 'five_hour', pct: 60, text: 'go', resetsAt: '2026-10-13T14:00:00Z' } })
    expect(wakePlan('seven_day', null, m(five))).toEqual({ ok: false, error: 'no weekly usage figures yet; try again after the next reply' })
    expect(wakePlan('five_hour', null, m([{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-10-13T14:00:00Z' }])).ok).toBe(false)
    expect(wakePlan('five_hour', null, m([{ kind: 'five_hour', percentUsed: 60, resetsAt: '2026-10-13T11:00:00Z' }]))).toEqual({ ok: false, error: 'the 5-hour usage window has already reset' })
  })

  test('anything else is usage with the reason', () => {
    expect(parseCommand('reload now')).toEqual({ kind: 'usage', error: 'reload takes no arguments' })
    expect(parseCommand('init team')).toEqual({ kind: 'usage', error: 'unknown preset "team"; use solo or peers' })
    expect(parseCommand('frobnicate')).toEqual({ kind: 'usage', error: 'unknown subcommand "frobnicate"' })
    expect(parseCommand('check')).toEqual({ kind: 'check' })
    expect(parseCommand('TRUST')).toEqual({ kind: 'trust' })
    expect(parseCommand('trust me')).toEqual({ kind: 'usage', error: 'trust takes no arguments but off' })
    expect(parseCommand('trust OFF')).toEqual({ kind: 'trust-off' })
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

describe('presets', () => {
  test('each preset is a file under the skill assets, named after it', () => {
    expect(PRESET_DIR).toBe('skills/guide/assets/presets')
    for (const p of PRESETS) expect(presetPath('/plugins/ctx-guard/', p)).toBe(`/plugins/ctx-guard/skills/guide/assets/presets/${p}.json`)
  })

  test('presetProblem passes a valid config and names what is wrong otherwise', () => {
    expect(presetProblem('{"version": 1, "defaultRole": "main"}', 'solo')).toBeNull()
    expect(presetProblem('{nope', 'solo')).toContain('the solo preset is not valid JSON')
    expect(presetProblem('{"version": 2}', 'peers')).toContain('peers preset: version')
  })

  test('wantsTrust: an auto restart or a compact trigger needs approval', () => {
    const cfg = (role: unknown) => validate({ version: 1, roles: { main: role } }).config ?? builtInConfig()
    expect(wantsTrust(builtInConfig())).toBe(false)
    expect(wantsTrust(cfg({ restart: { mode: 'auto' } }))).toBe(true)
    expect(wantsTrust(cfg({ triggers: [{ id: 'sq', when: { context: '85%' }, do: ['compact'] }] }))).toBe(true)
    expect(wantsTrust(cfg({ restart: { mode: 'manual' } }))).toBe(false)
    const brake = (lift: unknown) => ({ id: 'b', when: { 'limit.any': 95 }, do: [{ deny: ['Agent'] }], lift })
    expect(wantsTrust(cfg({ triggers: [brake({ do: ['note', 'notify'] })] }))).toBe(false)
    expect(wantsTrust(cfg({ triggers: [brake({ do: ['prompt'], times: 2 })] }))).toBe(true)
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

  test('collidingCommand reports a skill named after the plugin, which the bare command maps to', () => {
    const self = 'ctx-guard'
    const skill = { name: 'ctx-guard:ctx-guard', source: 'plugin', plugin: 'ctx-guard' }
    expect(collidingCommand([skill], 'ctx-guard', self)?.name).toBe('ctx-guard:ctx-guard')
    expect(collidingCommand([{ name: 'ctx-guard:guide', source: 'plugin', plugin: 'ctx-guard' }], 'ctx-guard', self)).toBeNull()
    // Another owner of the bare name wins: that one leaves ctx-guard inert.
    expect(collidingCommand([skill, { name: 'ctx-guard', source: 'user' }], 'ctx-guard', self)?.name).toBe('ctx-guard')
  })
})

describe('report', () => {
  test('the report lists band probes', () => {
    const base: ReportInput = {
      now: 0,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'lead', source: 'env', problem: null },
      configState: null,
      config: builtInConfig(),
      switches: { blocking: true, autoActions: true, noteToasts: true, display: 'band' },
      windowSource: 'model window',
      mode: null,
      metrics: metricsOf({}, 1_000_000, null, 0),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
    }
    const text = reportText({ ...base, probes: [{ id: 'run', state: '"step 03" (warning), 2m ago' }, { id: 'git', state: 'not run (untrusted)' }] })
    expect(text).toContain('probe run: "step 03" (warning), 2m ago')
    expect(text).toContain('probe git: not run (untrusted)')
    expect(reportText({ ...base, probes: [] })).toContain('band probes: none')
    expect(reportText(base)).not.toContain('band probes')
  })

  test('the cache line: TTL and its source, time left, pings, cold, the last miss and a retry', () => {
    const c: CacheReport = { ttl: 3_600_000, source: 'observed', expiresIn: 12 * 60_000, busy: false, pings: { n: 1, cap: 3 }, cold: false, miss: 0, missCause: null, retry: null }
    expect(cacheLine(c)).toBe('cache: TTL 1h (observed); expires in 12m; pings 1/3')
    expect(cacheLine({ ...c, ttl: 300_000, source: 'guess', expiresIn: null, pings: null })).toBe('cache: TTL 5m (a guess); no main request yet')
    expect(cacheLine({ ...c, busy: true })).toBe('cache: TTL 1h (observed); in use by the running turn; pings 1/3')
    expect(
      cacheLine({ ...c, source: 'config', expiresIn: 0, pings: { n: 2, cap: null }, cold: true, miss: 140_000, missCause: 'prefix', retry: { kind: 'prompt', triggerId: 'away', tries: 2 } }),
    ).toBe('cache: TTL 1h (from config); expired; pings 2; cold (a ping found it gone); last miss 140k (prefix changed); prompt of "away" waits for its retry (try 2)')
    expect(cacheLine({ ...c, source: 'transcript', miss: 50_000, missCause: 'model' })).toBe('cache: TTL 1h (from the transcript); expires in 12m; pings 1/3; last miss 50k (model switch)')
    const base: ReportInput = {
      now: 0,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'lead', source: 'env', problem: null },
      configState: null,
      config: builtInConfig(),
      switches: { blocking: true, autoActions: true, noteToasts: true, display: 'band' },
      windowSource: 'model window',
      mode: null,
      metrics: metricsOf({}, 1_000_000, null, 0),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
    }
    const lines = reportText({ ...base, cache: c }).split('\n')
    expect(lines[lines.findIndex(l => l.startsWith('idle:')) + 1]).toBe('cache: TTL 1h (observed); expires in 12m; pings 1/3')
    expect(reportText(base)).not.toContain('cache:')
  })

  test('the bare built-in main is left out of the roles, unless the session runs it', () => {
    const merged = validate(mergeLayers(BUILTIN_LAYER, { version: 1, roles: { lead: {}, design: {} } })).config ?? builtInConfig()
    const base: ReportInput = {
      now: 0,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'lead', source: 'env', problem: null },
      configState: null,
      config: merged,
      switches: { blocking: true, autoActions: true, noteToasts: true, display: 'band' },
      windowSource: 'model window',
      mode: null,
      metrics: metricsOf({}, 1_000_000, null, 0),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
    }
    expect(reportText(base)).toContain('effective: roles design, lead;')
    expect(reportText({ ...base, role: { role: 'main', source: 'user-default', problem: null } })).toContain('effective: roles design, lead, main;')
  })

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

  test('triggerLine: cache.expiresIn holds at or below its threshold, and times is shown', () => {
    const r = validate({
      version: 1,
      roles: {
        lead: {
          triggers: [
            { id: 'warm', when: { 'cache.expiresIn': '5m', context: '50k' }, do: ['ping'], times: 3 },
            { id: 'kept', when: { 'cache.expiresIn': '5m', 'cache.pings': 3 }, do: ['toast'] },
          ],
        },
      },
    })
    const [warm, kept] = roleSpec(r.config ?? builtInConfig(), 'lead')?.triggers ?? []
    expect(warm ? triggerLine(warm) : '').toBe('warm: context ≥ 50k and cache.expiresIn ≤ 5m → ping (times 3)')
    expect(kept ? triggerLine(kept) : '').toBe('kept: cache.expiresIn ≤ 5m and cache.pings ≥ 3 → toast')
  })

  test('triggerLine shows a lift and its times', () => {
    const r = validate({
      version: 1,
      roles: { lead: { triggers: [{ id: 'b', when: { 'limit.any': 95 }, do: ['note', { deny: ['Agent'] }], lift: { do: ['note', 'prompt'], times: 3 } }] } },
    })
    const [b] = roleSpec(r.config ?? builtInConfig(), 'lead')?.triggers ?? []
    expect(b ? triggerLine(b) : '').toBe('b: limit.any ≥ 95% → note, deny Agent; lift → note, prompt (times 3)')
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
      switches: { blocking: true, autoActions: true, noteToasts: true, display: 'band' },
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
      switches: { blocking: false, autoActions: false, noteToasts: false, display: 'off' },
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
    expect(off).toContain('switches: blocking off; autoActions off; noteToasts off; display off')
    expect(reportText({ ...base, off: null, pause: { until: 600_000 } })).toContain('ctx-guard: paused for 10m more')
  })

  test('a claimed role shows how long ago it was set; other sources do not', () => {
    const base: ReportInput = {
      now: 7_200_000,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'main', source: 'command', problem: null },
      claimAt: 0,
      configState: null,
      config: builtInConfig(),
      switches: { blocking: true, autoActions: false, noteToasts: true, display: 'band' },
      windowSource: 'model window',
      mode: null,
      metrics: metricsOf({}, 1_000_000, null, 7_200_000),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
    }
    expect(reportText(base)).toContain('role: main (from /ctx-guard role, set 2h ago)')
    expect(reportText({ ...base, role: { role: 'main', source: 'resume', problem: null } })).toContain('role: main (from /ctx-guard:resume or a restart command, set 2h ago)')
    expect(reportText({ ...base, role: { role: 'main', source: 'repo-default', problem: null } })).toContain('role: main (from project defaultRole)\n')
    expect(reportText({ ...base, claimAt: null })).toContain('role: main (from /ctx-guard role)\n')
  })

  test('the self gap line says how long the ready token stays refused as too-soon', () => {
    const now = 7_200_000
    const restart: RestartReport = {
      trusted: true,
      changed: [],
      approvedAt: null,
      lastVerdict: null,
      handoff: null,
      lease: null,
      pending: null,
    }
    const base: ReportInput = {
      now,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'main', source: 'user-default', problem: null },
      configState: null,
      config: builtInConfig(),
      switches: { blocking: true, autoActions: true, noteToasts: true, display: 'band' },
      windowSource: 'model window',
      mode: 'auto',
      metrics: metricsOf({}, 1_000_000, null, now),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
    }
    const at = (selfGap: RestartReport['selfGap']) => reportText({ ...base, restart: { ...restart, selfGap } })
    expect(at({ gap: 300_000, lastRestartAt: now - 120_000 })).toContain(
      'self gap: 5m; last restart 2m ago, ready token refused (too-soon) for 3m more',
    )
    expect(at({ gap: 300_000, lastRestartAt: now - 420_000 })).toContain('self gap: 5m; last restart 7m ago, passed')
    expect(at({ gap: 300_000, lastRestartAt: null })).toContain('self gap: 5m; no restart yet in this session')
    expect(at({ gap: 0, lastRestartAt: now - 1_000 })).toContain('self gap: off (selfGap 0)')
    expect(at(null)).not.toContain('self gap')
  })
})

describe('reach', () => {
  const H = 60 * 60_000
  const lead: RoleReach = {
    role: 'lead',
    sessions: 23,
    requests: 1912,
    peak: { median: 142_000, p90: 231_000, max: 329_000 },
    notes: { soft: 0, hard: 0, stop: 0, other: 0 },
    clears: { ready: 14, operator: 3 },
    compacts: { auto: 6, manual: 1, 'ctx-guard': 0 },
    autoPre: { min: 203_000, max: 298_000 },
    below: { min: 203_000, max: 203_000 },
    lowest: { id: 'ctx-soft', tokens: 400_000 },
    verdict: 'findings',
    findings: ['unreached', 'pre-empted'],
  }
  const none: RoleReach = {
    ...lead,
    role: 'none',
    sessions: 3,
    requests: 120,
    peak: { median: 60_000, p90: 90_000, max: 95_000 },
    notes: { soft: 1, hard: 0, stop: 0, other: 2 },
    clears: { ready: 0, operator: 1 },
    compacts: { auto: 0, manual: 0, 'ctx-guard': 0 },
    autoPre: null,
    below: null,
    verdict: 'few',
    findings: [],
  }
  const ok: RoleReach = { ...lead, verdict: 'ok', findings: [] }

  test('the check section: stats per role, findings, not enough data, no ladder, not in the config', () => {
    expect(reachLines({ at: 0, days: 14, roles: [lead, none] })).toEqual([
      'reach (last 14 days, from the ledger):',
      '  lead: 23 sessions, 1912 requests; peak per session median 142k, p90 231k, max 329k',
      '    notes: soft 0, hard 0, stop 0; clears: 14 by ready token, 3 by operator; compacts: auto 6 (203k–298k), manual 1, ctx-guard 0',
      '    finding: unreached: the lowest context trigger, ctx-soft at 400k, is above the p90 peak (231k) and no context note fired',
      '    finding: pre-empted: the engine compacted at 203k, below ctx-soft (400k)',
      '  none: 3 sessions, 120 requests; peak per session median 60k, p90 90k, max 95k',
      '    notes: soft 1, hard 0, stop 0, other 2; clears: 0 by ready token, 1 by operator; compacts: auto 0, manual 0, ctx-guard 0',
      '    not enough data (3 sessions; a finding needs 5)',
      '  /ctx-guard tune proposes context thresholds that fit these sessions',
    ])
    const other = reachLines({
      at: 0,
      days: 14,
      roles: [ok, { ...lead, role: 'dev', verdict: 'no-ladder', lowest: null, findings: [] }, { ...lead, role: 'gone', verdict: 'unconfigured', lowest: null, findings: [], sessions: 1, requests: 1, peak: null }],
    })
    expect(other.filter(l => l.startsWith('    ') && !l.startsWith('    notes'))).toEqual(['    no finding', '    no context triggers', '    not in the config now; no finding'])
    expect(other).toContain('  gone: 1 session, 1 request')
    expect(other.some(l => l.includes('/ctx-guard tune'))).toBe(false)
  })

  test('the report line and the off states', () => {
    expect(reachLine({ at: 0, days: 14, roles: [lead, none] }, H)).toBe('reach (14 days): lead unreached, pre-empted; none not enough data')
    expect(reachLine({ at: 0, days: 14, roles: [ok, { ...ok, role: 'none' }] }, 0)).toBe('reach (14 days): no finding (lead, none)')
    expect(reachLine({ at: 0, days: 14, roles: [ok] }, 2 * H)).toBe('reach (14 days, as of 2h ago): no finding (lead)')
    expect(reachLine({ at: 0, days: 14, roles: [ok, { ...lead, role: 'gone', verdict: 'unconfigured' }] }, 0)).toBe('reach (14 days): lead no finding; gone not in the config now')
    for (const f of [(s: Parameters<typeof reachLine>[0]) => reachLine(s, 0), (s: Parameters<typeof reachLine>[0]) => reachLines(s).join('\n')]) {
      expect(f('off')).toBe('reach: off (ledger.enabled is false)')
      expect(f('no ledger')).toBe('reach: no ledger (no ctx-guard config file in this repo)')
      expect(f({ at: 0, days: 14, roles: [] })).toBe('reach: no sessions recorded in the last 14 days')
    }
    // ledger.days below 14 keeps fewer days, and the reach check says so.
    expect(reachLine({ at: 0, days: 7, roles: [lead] }, 0)).toBe('reach (7 days): lead unreached, pre-empted')
    expect(reachLines({ at: 0, days: 7, roles: [lead] })[0]).toBe('reach (last 7 days, from the ledger):')
    expect(reachLines({ at: 0, days: 7, roles: [] })).toEqual(['reach: no sessions recorded in the last 7 days'])
  })

  test('the report shows the reach line after the cache line, and leaves it out when absent', () => {
    const base: ReportInput = {
      now: 0,
      interactive: true,
      off: null,
      pause: null,
      role: { role: 'lead', source: 'env', problem: null },
      configState: null,
      config: builtInConfig(),
      switches: { blocking: true, autoActions: true, noteToasts: true, display: 'band' },
      windowSource: 'model window',
      mode: null,
      metrics: metricsOf({}, 1_000_000, null, 0),
      marks: null,
      triggers: [],
      denies: [],
      lastClearAt: null,
      cache: { ttl: 3_600_000, source: 'observed', expiresIn: null, busy: false, pings: null, cold: false, miss: 0, missCause: null, retry: null },
    }
    const lines = reportText({ ...base, reach: 'off' }).split('\n')
    expect(lines[lines.findIndex(l => l.startsWith('cache:')) + 1]).toBe('reach: off (ledger.enabled is false)')
    const without = reportText(base).split('\n')
    expect(without.some(l => l.startsWith('reach'))).toBe(false)
    expect(lines.filter(l => !l.startsWith('reach'))).toEqual(without)
  })
})
