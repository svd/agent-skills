import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock, MockSession, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  NOW,
  ROOT,
  PRESET_TEXT,
  newWorld,
  world,
  writeConfig,
  start,
  measure,
  step,
  ctxGuard,
  notes,
  PEEK,
  peek,
  LEAD_SOFT,
  run,
  WIPE,
  DENY_READS,
  wipeState,
  turn,
  MIN,
  STATE,
  HANDOFF,
  RESUME,
  autoConfig,
  restartWorld,
  writeHandoff,
  ready,
  refusals,
  armed,
  PEEK_RESTART,
  peekRestart,
  KEEP,
  compactArmed,
  mainTurnEnd,
  status,
} from './register.fixtures'
import type {
  World,
} from './register.fixtures'

const STATE_KEYS = ['band', 'cache', 'marks', 'roleClaim', 'config', 'pendingResume', 'pendingCompact', 'lastCompact', 'pause', 'lastClearAt', 'lastRestartAt', 'lastVerdict', 'lease', 'work', 'subagents', 'spawned', 'stamp', 'activity', 'lifts']

// ---- state: memory first, written through to $.state ------------------------

// Every ctx-guard key as $.state holds it, undefined left out.
const PEEK_ALL: Plugin = {
  name: 'peek-all',
  register: on => {
    on('command.run', { command: 'peek-all' }, async $ => {
      const all: Record<string, unknown> = {
        band: (await $.state.get({ plugin: 'ctx-guard', key: 'band' })).value,
        marks: (await $.state.get({ plugin: 'ctx-guard', key: 'marks' })).value,
        roleClaim: (await $.state.get({ plugin: 'ctx-guard', key: 'roleClaim' })).value,
        config: (await $.state.get({ plugin: 'ctx-guard', key: 'config' })).value,
        pause: (await $.state.get({ plugin: 'ctx-guard', key: 'pause' })).value,
        lastClearAt: (await $.state.get({ plugin: 'ctx-guard', key: 'lastClearAt' })).value,
        lastVerdict: (await $.state.get({ plugin: 'ctx-guard', key: 'lastVerdict' })).value,
        lease: (await $.state.get({ plugin: 'ctx-guard', key: 'lease' })).value,
        activity: (await $.state.get({ plugin: 'ctx-guard', key: 'activity' })).value,
      }
      return { text: JSON.stringify(all) }
    })
  },
}

type Peeked = {
  band?: { role: string | null } | null
  marks?: { byId: Record<string, unknown> } | null
  roleClaim?: { role: string | null } | null
  config?: { source: string } | null
  pause?: { until: number } | null
  lastClearAt?: number | null
  lastVerdict?: { code: string } | null
  lease?: { id: string } | null
  activity?: unknown
}

async function peekAll($: Engine): Promise<Peeked> {
  return JSON.parse((await run($, 'peek-all')).text ?? '{}')
}

// Stands for another copy's $.state: after /override-pause, the pause reads as two hours past NOW.
const OVERRIDE: Plugin = {
  name: 'override',
  register: on => {
    let pause: { until: number } | null = null
    on('command.run', { command: 'override-pause' }, () => {
      pause = { until: Date.parse('2026-10-13T14:00:00Z') }
      return { text: '' }
    })
    on('state.get', { plugin: 'ctx-guard', key: 'pause' }, async ($, e, next) => {
      const r = await next(e)
      return pause && 'value' in r && r.value ? { value: { value: pause, version: r.value.version } } : r
    })
  },
}

test('after a /clear, a $.state that stays empty: the report still has the pause, role, verdict and config', { plugins: [WIPE, PEEK_ALL] }, async ($, on) => {
  const w = restartWorld()
  writeConfig(w, autoConfig())
  const { clock, session } = world(on, w)
  await start($)
  expect(await ctxGuard($, 'role lead')).toContain('role is now lead')
  await writeHandoff(w, clock)
  await ready($, clock)
  expect(refusals(session)[0]).toContain('CTX-READY ignored (untrusted)')
  expect(await ctxGuard($, 'pause 30m')).toContain('paused for 30m')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await run($, 'wipe-hold')
  // $.state has nothing ctx-guard could read back.
  const peeked = await peekAll($)
  expect(peeked.roleClaim).toBeUndefined()
  expect(peeked.pause).toBeUndefined()
  expect(peeked.config).toBeUndefined()
  const report = await ctxGuard($, '')
  expect(report).toContain('ctx-guard: paused for')
  expect(report).toContain('role: lead (from /ctx-guard role, set ')
  expect(report).toContain('last verdict: untrusted')
  expect(report).toContain('config: files')
  expect(report).toContain('last /clear: 0s ago')
  expect(await ctxGuard($, 'role')).toContain('role')
  expect(await ctxGuard($, 'pause off')).toContain('pause lifted')
  expect(await ctxGuard($, '')).toContain('ctx-guard: on')
})

test('after a /clear wiped $.state, the first hook writes every key back', { plugins: [WIPE, PEEK_ALL] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await ctxGuard($, 'pause 30m')
  await measure($, w, 310_000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await wipeState($)
  expect(await peekAll($)).toEqual({})
  // A hook that writes nothing of its own but the activity.
  await $.turn.start({ text: 'go', turnId: 't2' })
  const after = await peekAll($)
  expect(after.roleClaim?.role).toBe('lead')
  expect(typeof after.pause?.until).toBe('number')
  expect(after.config?.source).toBe('files')
  expect(after.lastClearAt).toBe(NOW)
  expect(after.marks?.byId).toEqual({})
  expect(after.band?.role).toBe('lead')
  expect(after.lease?.id).toBe('s1')
  expect(after.lastVerdict).toBeNull()
  // Every key went back once; later hooks write only what they change.
  const sets = JSON.parse((await run($, 'wipe-sets')).text ?? '{}') as Record<string, number>
  for (const k of STATE_KEYS) expect(sets[k] ?? 0).toBeGreaterThan(0)
  await $.turn.start({ text: 'go', turnId: 't3' })
  const again = JSON.parse((await run($, 'wipe-sets')).text ?? '{}') as Record<string, number>
  expect(again.roleClaim).toBe(sets.roleClaim)
})

test('a session start fills memory from $.state; until then memory stands', { plugins: [OVERRIDE] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  expect(await ctxGuard($, '')).toContain('ctx-guard: on')
  await run($, 'override-pause')
  // Reads come from memory, not $.state.
  expect(await ctxGuard($, '')).toContain('ctx-guard: on')
  // A reload fires session.start: memory is what $.state holds.
  await start($)
  expect(await ctxGuard($, '')).toContain('ctx-guard: paused for 2h')
})

test('a session end other than /clear forgets the session: no role claim or pause reaches the next one', { plugins: [WIPE, DENY_READS] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await ctxGuard($, 'pause 30m')
  // A /clear left memory to be written back; the session then ends before any hook did.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} as never })
  // The next conversation's $.state holds nothing of this one.
  await wipeState($)
  await start($)
  const after = await ctxGuard($, '')
  expect(after).toContain('role: none')
  expect(after).toContain('ctx-guard: on')
})

test('a session end other than /clear empties memory itself: an unreadable $.state leaves nothing of the old session', { plugins: [DENY_READS] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await ctxGuard($, 'pause 30m')
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} as never })
  // $.state still holds the old session, but cannot be read: memory is all the next start has.
  await run($, 'deny-reads')
  await start($)
  const after = await ctxGuard($, '')
  expect(after).toContain('role: none')
  expect(after).toContain('ctx-guard: on')
})

test('a session end other than /clear stops the timers: the released role is not claimed again', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w)
  const owner = () => JSON.parse(w.files[`${STATE}/lead.owner`]?.text ?? '{}')
  expect(owner().sessionId).toBe('s1')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} as never })
  expect(owner().heartbeat).toBe(0)
  await clock.advance(20 * MIN)
  await clock.settle()
  expect(owner().heartbeat).toBe(0)
})

test('a failed read at a session start is tried again by the next hook', { plugins: [OVERRIDE, DENY_READS] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await run($, 'override-pause')
  await run($, 'deny-reads')
  await start($)
  expect(await ctxGuard($, '')).toContain('ctx-guard: on')
  await run($, 'allow-reads')
  expect(await ctxGuard($, '')).toContain('ctx-guard: paused for 2h')
})

// Holds ctx-guard's clock reads (/hold-clock) or the answer of its roleClaim reads (/hold-claim:
// read at once, answered on release), or the command list (/hold-list), until /release.
const HOLD: Plugin = {
  name: 'hold',
  register: on => {
    const gates: Record<string, { p: Promise<void>; open: () => void }> = {}
    const hold = (k: string): void => {
      let open: () => void = () => undefined
      const p = new Promise<void>(r => {
        open = r
      })
      gates[k] = { p, open }
    }
    for (const k of ['clock', 'claim', 'list']) {
      on('command.run', { command: `hold-${k}` }, () => {
        hold(k)
        return { text: '' }
      })
      on('command.run', { command: `release-${k}` }, () => {
        gates[k]?.open()
        delete gates[k]
        return { text: '' }
      })
    }
    on('clock.now', async ($, e, next) => {
      if (gates.clock) await gates.clock.p
      return next(e)
    })
    let claimed = 0
    on('command.run', { command: 'claim-waits' }, () => ({ text: String(claimed) }))
    on('state.get', { plugin: 'ctx-guard', key: 'roleClaim' }, async ($, e, next) => {
      const r = await next(e)
      if (gates.claim) {
        claimed += 1
        await gates.claim.p
      }
      return r
    })
    let listed = 0
    on('command.run', { command: 'list-waits' }, () => ({ text: String(listed) }))
    on('command.list', async ($, e, next) => {
      if (gates.list) {
        listed += 1
        await gates.list.p
      }
      return next(e)
    })
  },
}

test('a write that lands while a session start reads $.state is kept in memory', { plugins: [HOLD, PEEK] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  // The command is under way, waiting on the clock, when the reload's start reads the old claim.
  await run($, 'hold-clock')
  const cmd = ctxGuard($, 'role none')
  await run($, 'hold-claim')
  const started = start($)
  await run($, 'release-clock')
  expect(await cmd).toContain('role is now none')
  await run($, 'release-claim')
  await started
  expect((await peek($)).roleClaim?.role).toBeNull()
  expect(await ctxGuard($, '')).toContain('role: none')
})

test('a /clear while a session start is still under way is written back too, and applied once the start is done', { plugins: [HOLD, WIPE, PEEK] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  const { session } = world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
  await run($, 'hold-list')
  const started = start($)
  // The start is past its read of $.state, waiting on the command list.
  for (let i = 0; i < 50 && (await run($, 'list-waits')).text === '0'; i++) await Promise.resolve()
  expect((await run($, 'list-waits')).text).toBe('1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await wipeState($)
  await run($, 'release-list')
  await started
  await $.turn.start({ text: 'go', turnId: 't2' })
  expect((await peek($)).roleClaim?.role).toBe('lead')
  // The clear re-armed the context trigger and is on the report.
  expect(await ctxGuard($, '')).toContain('last /clear: 0s ago')
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(2)
})

test('a session end while a start reads $.state drops that read', { plugins: [HOLD, WIPE] }, async ($, on) => {
  const w = newWorld()
  writeConfig(w, LEAD_SOFT)
  world(on, w)
  await start($)
  await ctxGuard($, 'role lead')
  await run($, 'hold-claim')
  const started = start($)
  for (let i = 0; i < 50 && (await run($, 'claim-waits')).text === '0'; i++) await Promise.resolve()
  expect((await run($, 'claim-waits')).text).toBe('1')
  // The old session's read answers after it ended, and the next conversation holds nothing of it.
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} as never })
  await wipeState($)
  await run($, 'release-claim')
  await started
  const report = await ctxGuard($, '')
  expect(report).toContain('role: none')
  expect(report).not.toContain('role: lead')
})

test('a failed read at a session start: the retry restores the claimed role and finishes the pending resume', { plugins: [DENY_READS, PEEK_RESTART] }, async ($, on) => {
  const w = restartWorld({ hang: { clear: 60_000 } })
  writeConfig(w, autoConfig())
  const { clock } = world(on, w)
  await start($)
  expect(await ctxGuard($, 'role lead')).toContain('role is now lead')
  expect(await ctxGuard($, 'trust')).toContain('approved for /repo')
  await writeHandoff(w, clock)
  await ready($, clock)
  expect((await peekRestart($)).pendingResume?.step).toBe('clear')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  // A reload whose new copy starts with no memory, and cannot read $.state at first.
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} as never })
  await run($, 'deny-reads')
  await start($)
  expect(w.ran).toEqual(['clear'])
  await run($, 'allow-reads')
  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.settle()
  expect(w.ran).toEqual(['clear', RESUME])
  expect(await ctxGuard($, '')).toContain('role: lead (from /ctx-guard role, set ')
})

test('an idle tick right after a /clear that wiped $.state still sees the pause', { plugins: [WIPE] }, async ($, on) => {
  const w = restartWorld()
  const config = { version: 1, roles: { lead: { triggers: [{ id: 'nap', when: { idle: '5m' }, do: ['compact'] }], compact: { instructions: KEEP } } } }
  const { clock } = await compactArmed($, on, w, config)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await mainTurnEnd($, clock)
  expect(await ctxGuard($, 'pause 30m')).toContain('paused for 30m')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await run($, 'wipe-hold')
  // The idle tick is the first of ctx-guard's code to run.
  await clock.advance(6 * MIN)
  await clock.settle()
  expect(w.toasts).toContain('ctx-guard: /compact for trigger "nap" skipped: ctx-guard is paused.')
  expect(w.ran).toEqual([])
})

// Counts the band's reads: every draw of the band reads it once. The kit draws again when the drawing is next read.
const COUNT_BAND: Plugin = {
  name: 'count-band',
  register: on => {
    let reads = 0
    on('command.run', { command: 'band-reads' }, () => ({ text: String(reads) }))
    on('state.get', { plugin: 'ctx-guard', key: 'band' }, async ($, e, next) => {
      reads += 1
      return next(e)
    })
  },
}

const bandReads = async ($: Engine): Promise<number> => Number((await run($, 'band-reads')).text)

test('the band draws from memory after a wiping /clear and repaints when the write-back lands', { plugins: [WIPE, COUNT_BAND] }, async ($, on) => {
  const w = newWorld({ tokens: 312_000 })
  writeConfig(w, LEAD_SOFT)
  world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  const ui = await $.ui.mount({ plugin: 'ctx-guard', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  expect((await ui.findAll({ type: 'Text', text: '312k (31%)' })).length).toBeGreaterThan(0)
  // A hook that writes no band draws nothing again.
  const quiet = await bandReads($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await ui.drawn()
  expect(await bandReads($)).toBe(quiet)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await wipeState($)
  await ui.drawn()
  const cleared = await bandReads($)
  // The first hook writes the band back into $.state, which draws it again, from memory: the role, no fill.
  await $.turn.start({ text: 'go', turnId: 't2' })
  await ui.drawn()
  expect(await bandReads($)).toBe(cleared + 1)
  expect((await ui.findAll({ type: 'Text', text: 'lead' })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ type: 'Text', text: '312k (31%)' })).length).toBe(0)
})

// A week past 80% used to loop: the limit note asked for a restart, the /clear re-armed its mark,
// and the note came straight back after the resume.
test('a usage note never loops a restart: no tail, not-needed, its mark survives /clear, too-soon', { plugins: [WIPE] }, async ($, on) => {
  const w = restartWorld({ tokens: 100_000, limits: [], hang: { clear: 1000 } })
  writeConfig(w, PRESET_TEXT.solo)
  const { clock, session } = world(on, w)
  await start($)
  expect(await ctxGuard($, 'trust')).toContain('approved for /repo')
  await writeHandoff(w, clock, `${STATE}/main-handoff.md`)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  w.limits = [{ kind: 'seven_day', percentUsed: 89 }]
  await measure($, w, 100_000)
  const weekly = (): string[] => notes(session).filter(n => n.includes('Weekly usage is at 89%'))
  expect(weekly().length).toBe(1)
  expect(weekly()[0]).not.toContain('CTX-READY')
  expect(weekly()[0]).toContain('Prefer cheaper steps')
  // A token anyway: there is no context to free.
  await ready($, clock)
  expect(refusals(session).at(-1)).toContain('CTX-READY ignored (not-needed): context is at 100k, under restart.minContext 40% (400k)')
  expect(w.ran).toEqual([])
  // Past the context threshold the restart goes through.
  await measure($, w, 450_000)
  expect(notes(session).at(-1)).toContain('CTX-READY')
  await ready($, clock)
  // As a session runs it: /clear ends the session and empties $.state before the resume.
  expect(w.ran).toEqual(['clear'])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await wipeState($)
  await clock.advance(1000)
  await clock.settle()
  expect(w.ran).toEqual(['clear', 'ctx-guard:resume role=main handoff=.ctx-guard/main-handoff.md Carry out Next action without waiting.'])
  await measure($, w, undefined)
  await measure($, w, 60_000)
  // The week is still at 89%: no second note, so nothing asks for a restart.
  expect(weekly().length).toBe(1)
  // A reload: what it reads back is what the write-back after the wipe left in $.state.
  await start($)
  await measure($, w, 60_000)
  expect(weekly().length).toBe(1)
  // A context crossing soon after does note, but a token within selfGap is refused.
  await measure($, w, 450_000)
  // A fresh handoff at once: writeHandoff's minute would outlast the 1m selfGap.
  w.files[`${STATE}/main-handoff.md`] = { text: '# handoff\n', mtimeMs: clock.now() }
  expect(await ctxGuard($, 'check')).toContain('warning: ')
  await ready($, clock)
  expect(refusals(session).at(-1)).toContain('CTX-READY ignored (too-soon): this session restarted')
  expect(refusals(session).at(-1)).toContain('under selfGap 1m')
  expect(w.ran.length).toBe(2)
  expect(await ctxGuard($, 'check')).toContain('FAIL too-soon')
})

test('a ready check runs with the restart context; a dry run says so', async ($, on) => {
  const w = restartWorld()
  const { clock } = await armed($, on, w, autoConfig({ readyChecks: [{ run: ['./ready.sh'] }] }))
  const handoffAt = w.files[HANDOFF]?.mtimeMs
  expect(await ctxGuard($, 'check')).toContain('ok   ready-check-failed: 1 ready check passed')
  expect(w.inits[0]?.cwd).toBe(ROOT)
  expect(w.inits[0]?.env).toEqual({
    CTX_GUARD_PURPOSE: 'dry-run',
    CTX_GUARD_SCRIPT_ROLE: 'lead',
    CTX_GUARD_ROOT: ROOT,
    CTX_GUARD_STATE_DIR: `${ROOT}/.ctx-guard`,
    CTX_GUARD_HANDOFF: `${ROOT}/.ctx-guard/lead-handoff.md`,
    CTX_GUARD_HANDOFF_MTIME_MS: String(handoffAt),
    CTX_GUARD_SINCE_MS: String(NOW),
    CTX_GUARD_VIA: 'clear',
  })
  await ready($, clock)
  expect(w.inits[1]?.env?.CTX_GUARD_PURPOSE).toBe('ready-check')
  expect(w.inits[1]?.env?.CTX_GUARD_HANDOFF_MTIME_MS).toBe(String(handoffAt))
  expect(w.ran).toEqual(['clear', RESUME])
})

test('a ready check under via compact gets no handoff', async ($, on) => {
  const w = restartWorld()
  await armed($, on, w, autoConfig({ via: 'compact', readyChecks: [{ run: ['./ready.sh'] }] }))
  await ctxGuard($, 'check')
  const env = w.inits[0]?.env
  expect(env?.CTX_GUARD_VIA).toBe('compact')
  expect(env?.CTX_GUARD_HANDOFF).toBe('')
  expect(env?.CTX_GUARD_HANDOFF_MTIME_MS).toBe('')
})

const PROBE_CMD = './probe.sh'

function probeConfig(probes: unknown[] = [{ id: 'run', run: [PROBE_CMD] }]) {
  return { version: 1, roles: { lead: {} }, band: { probes } }
}

// A trusted lead on a surface with no band, so the band's text lands on the status line.
async function probed($: Engine, on: On, w: World, config: unknown = probeConfig()): Promise<{ clock: MockClock; session: MockSession }> {
  w.files[`${ROOT}/probe.sh`] = { text: '#!/bin/sh\necho step\n', mtimeMs: NOW }
  writeConfig(w, config)
  const env = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  expect(await ctxGuard($, 'trust')).toContain('band probe run: ["./probe.sh"]')
  await env.clock.settle()
  return env
}

const probeRuns = (w: World): number => w.processes.filter(p => p[0] === PROBE_CMD).length

test('a band probe draws its line, with the probe environment', async ($, on) => {
  const w = newWorld({ stdout: { [PROBE_CMD]: 'step 03 sonnet 12m\nwarning\n' } })
  const { clock } = await probed($, on, w)
  expect(status(w)).toContain('step 03 sonnet 12m')
  const i = w.processes.findIndex(p => p[0] === PROBE_CMD)
  expect(w.inits[i]?.cwd).toBe(ROOT)
  expect(w.inits[i]?.env).toEqual({
    CTX_GUARD_PURPOSE: 'band-probe',
    CTX_GUARD_SCRIPT_ROLE: 'lead',
    CTX_GUARD_ROOT: ROOT,
    CTX_GUARD_STATE_DIR: `${ROOT}/.ctx-guard`,
    CTX_GUARD_HANDOFF: `${ROOT}/.ctx-guard/lead-handoff.md`,
    CTX_GUARD_HANDOFF_MTIME_MS: '',
    CTX_GUARD_SINCE_MS: String(NOW),
    CTX_GUARD_VIA: 'clear',
  })
  // The next tick redraws; empty output drops the segment; a failure shows `run ?`.
  w.stdout[PROBE_CMD] = 'step 04\n'
  await clock.advance(60_000)
  await clock.settle()
  expect(status(w)).toContain('step 04')
  w.stdout[PROBE_CMD] = ''
  await clock.advance(60_000)
  await clock.settle()
  expect(status(w)).not.toContain('step 0')
  w.exitCode = 3
  await clock.advance(60_000)
  await clock.settle()
  expect(status(w)).toContain('run ?')
})

test('untrusted: a probe never runs', async ($, on) => {
  const w = newWorld({ stdout: { [PROBE_CMD]: 'step 03\n' } })
  writeConfig(w, probeConfig())
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  await clock.advance(120_000)
  await clock.settle()
  expect(probeRuns(w)).toBe(0)
  expect(status(w)).not.toContain('step 03')
  expect(status(w)).toBe('lead · 100k (10%) · untrusted')
})

test('a hanging probe holds nothing up; its ticks are skipped', async ($, on) => {
  const w = newWorld({ processHang: 10 * 60_000, stdout: { [PROBE_CMD]: 'slow\n' } })
  const { clock, session } = await probed($, on, w, {
    ...probeConfig([{ id: 'run', run: [PROBE_CMD], every: '15s', timeout: '30s' }]),
    roles: { lead: { triggers: [{ id: 'soft', when: { context: '300k' }, do: ['note'], level: 'soft' }] } },
  })
  await clock.advance(60_000)
  expect(probeRuns(w)).toBe(1)
  // A note still goes out while the probe hangs.
  await measure($, w, 310_000)
  expect(notes(session).length).toBe(1)
})

test('a /clear runs the probes again', async ($, on) => {
  const w = newWorld({ stdout: { [PROBE_CMD]: 'step 03\n' } })
  const { clock } = await probed($, on, w)
  const before = probeRuns(w)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await measure($, w, 1000)
  await clock.settle()
  expect(probeRuns(w)).toBe(before + 1)
})

test('a probe removed from the config, or its script edited, stops drawing', async ($, on) => {
  const w = newWorld({ stdout: { [PROBE_CMD]: 'step 03\n' } })
  const { clock } = await probed($, on, w)
  expect(status(w)).toContain('step 03')
  // The script edited: trust is withdrawn at the next run, which then does not run it.
  w.files[`${ROOT}/probe.sh`] = { text: '#!/bin/sh\nrm -rf /\n', mtimeMs: clock.now() }
  const runs = probeRuns(w)
  await clock.advance(60_000)
  await clock.settle()
  expect(probeRuns(w)).toBe(runs)
  expect(status(w)).not.toContain('step 03')
  expect(status(w)).toContain('untrusted (changed)')
  expect(await ctxGuard($, '')).toContain('probe run: not run (untrusted)')
})
