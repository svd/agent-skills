import { expect, test } from 'claude-code/testing'
import type { Engine, MockSession, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  HOUR,
  newWorld,
  world,
  writeConfig,
  start,
  measure,
  step,
  ctxGuard,
  notes,
  agentDenied,
  LEAD_BRAKE,
  run,
  turn,
  status,
} from './register.fixtures'

// ---- subagent budgets -----------------------------------------------------------

const BUDGETS = {
  version: 1,
  roles: { lead: {} },
  subagents: {
    '*': { warn: '120k', stop: '170k' },
    Explore: { stop: '150k', message: 'Budget {stop} reached: return your findings now.' },
    Plan: { warn: 'off' },
  },
}

// Each loop's step answers its own fill: by agent id, main under ''.
function fillBottom(on: On, fills: Record<string, number>): void {
  on('turn.step', async function* ($, e) {
    const t = fills[e.agentId ?? ''] ?? 100_000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as never,
      usage: { input_tokens: 1_000, cache_read_input_tokens: t - 3_000, cache_creation_input_tokens: 2_000, output_tokens: 50, model: 'm' },
    }
  })
}

const agentNotes = (s: MockSession, agentId?: string): string[] =>
  s
    .appended()
    .filter(r => r.door === 'note' && r.agentId === agentId)
    .map(r => JSON.stringify(r.message.content))

async function bashBy($: Engine, agentId?: string): Promise<string | undefined> {
  const r = await $.tool.call({ tool: 'Bash', command: 'true', ...(agentId ? { agentId } : {}) } as never)
  return r.deny
}

const subDone = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId })

const PEEK_SUB: Plugin = {
  name: 'peek-sub',
  register: on => {
    on('command.run', { command: 'peek-sub' }, async $ => {
      const subagents = (await $.state.get({ plugin: 'ctx-guard', key: 'subagents' })).value ?? null
      const band = (await $.state.get({ plugin: 'ctx-guard', key: 'band' })).value ?? null
      return { text: JSON.stringify({ subagents, over: band?.subagentsOver ?? null }) }
    })
  },
}

async function peekSub($: Engine): Promise<{ subagents: Record<string, { step: string; tokens: number }> | null; over: number | null }> {
  const r = await $.command.run({ command: 'peek-sub', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 120 } })
  return JSON.parse(r.text ?? 'null')
}

const runningAgent = (id: string, type: string) => ({ id, status: 'running', description: 'probe', type })

// An Agent call starting `id` as the engine raises it.
async function spawn($: Engine, id: string, subagentType: string, how: { fork?: boolean; isTeammate?: true } = {}): Promise<void> {
  await $.agent.spawn({
    tool_use_id: 'tu',
    prompt: 'go',
    description: id,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' } as never,
    parentModel: 'm',
    background: false,
    fork: how.fork ?? false,
    ...(how.isTeammate ? { isTeammate: true as const } : {}),
  })
}

test('a subagent fill is input + cache read + cache creation; the warn goes once, to that agent', async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 110_000 }
  fillBottom(on, fills)
  const w = newWorld()
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'sub-1', 'general-purpose')
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')).toEqual([])
  fills['sub-1'] = 125_000
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-1')
  const sent = agentNotes(session, 'sub-1')
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain("Your context is at 125k, past this subagent's 120k budget. At 170k your tool calls are refused, except the one that returns your report.")
  expect(agentNotes(session)).toEqual([])
  // Warned, not stopped: its calls still run.
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  // Its spawn named it: no list lookup.
  expect(w.agentListCalls).toBe(0)
})

test('the stop goes once, then that agent alone is refused', async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 175_000, 'sub-2': 50_000 }
  fillBottom(on, fills)
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose'), runningAgent('sub-2', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-2')
  fills['sub-1'] = 180_000
  await step($, clock, 'sub-1')
  // Past both at once: only the stop, in the built-in words.
  expect(agentNotes(session, 'sub-1')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 170k reached; return your final report now. Tool calls are refused, except the one that returns your report.' }])])
  expect(await bashBy($, 'sub-1')).toBe('[ctx-guard] context budget 170k reached; return your final report now. Tool calls are refused, except the one that returns your report.')
  expect(await bashBy($, 'sub-2')).toBeUndefined()
  expect(await bashBy($)).toBeUndefined()
  expect(agentNotes(session, 'sub-2')).toEqual([])
  // The report still goes back.
  const handback = await $.tool.call({ tool: 'SubagentHandback', message: 'the report', agentId: 'sub-1' } as never)
  expect(handback.deny).toBeUndefined()
  expect(handback.result).toBe('ran')
})

test('blocking off or a pause: the stop note goes, no call is refused', { options: { blocking: false } }, async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1').length).toBe(1)
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  expect(await ctxGuard($, '')).toContain('stopped (tool calls allowed: blocking is off in /config)')
})

test('a pause suspends the stop deny until it is lifted', async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await ctxGuard($, 'pause 10m')
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1').length).toBe(1)
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  await ctxGuard($, 'pause off')
  expect(await bashBy($, 'sub-1')).toContain('context budget 170k reached')
})

test('a type entry merges over "*": its own stop and message, the "*" warn; "off" drops a step', async ($, on) => {
  const fills: Record<string, number> = { ex: 125_000, plan: 160_000 }
  fillBottom(on, fills)
  const w = newWorld({ agents: [runningAgent('ex', 'Explore'), runningAgent('plan', 'Plan')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'ex')
  expect(agentNotes(session, 'ex')[0]).toContain("past this subagent's 120k budget. At 150k")
  fills.ex = 151_000
  await step($, clock, 'ex')
  expect(agentNotes(session, 'ex')[1]).toContain('[ctx-guard] Budget 150k reached: return your findings now.')
  expect(await bashBy($, 'ex')).toBe('[ctx-guard] context budget 150k reached; return your final report now. Tool calls are refused, except the one that returns your report.')
  // Plan has no warn: nothing at 160k, the "*" stop at 170k.
  await step($, clock, 'plan')
  expect(agentNotes(session, 'plan')).toEqual([])
  fills.plan = 171_000
  await step($, clock, 'plan')
  expect(agentNotes(session, 'plan')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 170k reached; return your final report now. Tool calls are refused, except the one that returns your report.' }])])
})

test('engine forks, Agent forks and teammates get no budget unless an entry names them', async ($, on) => {
  const fills: Record<string, number> = { compact: 500_000, fk: 500_000, mate: 500_000, wf: 125_000 }
  fillBottom(on, fills)
  // A teammate the list names after a reload lost its spawn.
  const w = newWorld({ agents: [{ ...runningAgent('mate-2', 'teammate'), teammateId: 'mate-2@team' } as never] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'fk', 'fork', { fork: true })
  await spawn($, 'mate', 'reviewer', { isTeammate: true })
  // A workflow's agent is raised by agent.spawn too, and named there.
  await spawn($, 'wf', 'Explore')
  fills['mate-2'] = 500_000
  for (const id of ['compact', 'fk', 'mate', 'mate-2', 'wf']) await step($, clock, id)
  for (const id of ['compact', 'fk', 'mate', 'mate-2']) {
    expect(agentNotes(session, id)).toEqual([])
    expect(await bashBy($, id)).toBeUndefined()
  }
  expect(agentNotes(session, 'wf')[0]).toContain("past this subagent's 120k budget. At 150k")
  // Only budgeted agents make the table.
  expect(await ctxGuard($, '')).toMatch(/subagents:\n {2}id +type.*\n {2}wf +Explore +125k +120k +150k +warned$/)
})

test('a "teammate" or "fork" entry budgets them', async ($, on) => {
  fillBottom(on, { fk: 310_000, mate: 410_000 })
  const w = newWorld()
  writeConfig(w, { ...BUDGETS, subagents: { ...BUDGETS.subagents, fork: { stop: '300k' }, teammate: { warn: 'off', stop: '400k' } } })
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'fk', 'fork', { fork: true })
  await spawn($, 'mate', 'reviewer', { isTeammate: true })
  await step($, clock, 'fk')
  await step($, clock, 'mate')
  expect(agentNotes(session, 'fk')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 300k reached; return your final report now. Tool calls are refused, except the one that returns your report.' }])])
  expect(await bashBy($, 'mate')).toBe('[ctx-guard] context budget 400k reached; return your final report now. Tool calls are refused, except the one that returns your report.')
})

test('a list that throws: no budget yet, asked again once the fill reaches the lowest step of any type', async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 15_000 }
  fillBottom(on, fills)
  const w = newWorld({ failAgentList: true, agents: [runningAgent('sub-1', 'Explore')] })
  writeConfig(w, { ...BUDGETS, subagents: { '*': { warn: '120k', stop: '170k' }, Explore: { warn: '10k', stop: '20k' } } })
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')).toEqual([])
  expect(w.agentListCalls).toBe(1)
  w.failAgentList = false
  // Below the lowest step (10k): not asked.
  fills['sub-1'] = 9_000
  await step($, clock, 'sub-1')
  expect(w.agentListCalls).toBe(1)
  fills['sub-1'] = 21_000
  await step($, clock, 'sub-1')
  expect(w.agentListCalls).toBe(2)
  expect(agentNotes(session, 'sub-1')).toEqual([JSON.stringify([{ type: 'text', text: '[ctx-guard] context budget 20k reached; return your final report now. Tool calls are refused, except the one that returns your report.' }])])
  expect(await ctxGuard($, '')).toMatch(/sub-1 +Explore +21k +10k +20k +stopped \(tool calls refused\)/)
})

test('a config reload while an evaluation is under way still re-judges the next step', async ($, on) => {
  fillBottom(on, { 'sub-1': 50_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')], listHang: 1_000 })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  // The evaluation waits on the list, judging under the old budgets.
  await step($, clock, 'sub-1')
  writeConfig(w, { ...BUDGETS, subagents: { '*': { warn: '40k', stop: '170k' } } })
  const reload = ctxGuard($, 'reload')
  await clock.settle()
  await clock.advance(1_000)
  await reload
  expect(agentNotes(session, 'sub-1')).toEqual([])
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')[0]).toContain("past this subagent's 40k budget")
})

test("an agent's turn.complete prunes it: the deny lifts and the band count drops", { plugins: [PEEK_SUB] }, async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000, 'sub-2': 130_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose'), runningAgent('sub-2', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-2')
  expect((await peekSub($)).over).toBe(2)
  expect(await ctxGuard($, '')).toContain('subagent budgets: * warn 120k, stop 170k; Explore warn 120k, stop 150k, own stop message; Plan stop 170k')
  await subDone($, 'sub-1')
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  const after = await peekSub($)
  expect(Object.keys(after.subagents ?? {})).toEqual(['sub-2'])
  expect(after.over).toBe(1)
  await subDone($, 'sub-2')
  expect((await peekSub($)).over).toBe(0)
  expect(await ctxGuard($, '')).toContain('subagents: none followed')
})

test('the band shows sub N! while an agent is past its warn', { plugins: [PEEK_SUB] }, async ($, on) => {
  fillBottom(on, { 'sub-1': 130_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($, 'vscode')
  await step($, clock, 'sub-1')
  expect(w.statuses.at(-1)).toContain('sub 1!')
  await measure($, w, 200_000)
  expect(w.statuses.at(-1)).toContain('sub 1!')
  await subDone($, 'sub-1')
  expect(w.statuses.at(-1)).not.toContain('sub')
})

test('a stop survives a reload: the deny holds and no note is sent again', { plugins: [PEEK_SUB] }, async ($, on) => {
  const fills: Record<string, number> = { 'sub-1': 175_000, 'sub-2': 100_000 }
  fillBottom(on, fills)
  const w = newWorld()
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await spawn($, 'sub-1', 'general-purpose')
  await spawn($, 'sub-2', 'Explore')
  await step($, clock, 'sub-1')
  await step($, clock, 'sub-2')
  expect((await peekSub($)).subagents?.['sub-1']?.step).toBe('stop')
  await start($)
  expect(await bashBy($, 'sub-1')).toContain('context budget 170k reached')
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1').length).toBe(1)
  expect((await peekSub($)).over).toBe(1)
  // The spawn's type is kept too: Explore's own stop, no list lookup.
  fills['sub-2'] = 151_000
  await step($, clock, 'sub-2')
  expect(agentNotes(session, 'sub-2').at(-1)).toContain('Budget 150k reached')
  expect(w.agentListCalls).toBe(0)
})

test('an agent not seen for hours is dropped by the band timer', { plugins: [PEEK_SUB] }, async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock, 'sub-1')
  await clock.advance(HOUR)
  expect(await bashBy($, 'sub-1')).toContain('context budget')
  await clock.advance(HOUR + 10 * 60 * 1000)
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  expect((await peekSub($)).subagents).toEqual({})
})

test('no role, no budgets: no note, no deny, no lookup', async ($, on) => {
  fillBottom(on, { 'sub-1': 175_000 })
  const w = newWorld({ agents: [runningAgent('sub-1', 'general-purpose')] })
  writeConfig(w, BUDGETS)
  const { session, clock } = world(on, w)
  await start($)
  await step($, clock, 'sub-1')
  expect(agentNotes(session, 'sub-1')).toEqual([])
  expect(await bashBy($, 'sub-1')).toBeUndefined()
  expect(w.agentListCalls).toBe(0)
  expect(await ctxGuard($, '')).toContain('(no role: not applied)')
})

test('main-loop steps and denies are untouched by subagent budgets', async ($, on) => {
  fillBottom(on, { '': 175_000 })
  const w = newWorld({ limits: [{ kind: 'five_hour', percentUsed: 50 }] })
  writeConfig(w, { ...BUDGETS, roles: LEAD_BRAKE.roles })
  const { session, clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await step($, clock)
  expect(notes(session)).toEqual([])
  expect(await bashBy($)).toBeUndefined()
  expect(await agentDenied($)).toBeUndefined()
  expect(w.agentListCalls).toBe(0)
})
