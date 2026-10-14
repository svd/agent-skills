import { describe, expect, test } from 'claude-code/testing'

import { parseProbe, probeSegment, probeState, scriptEnv } from './scripts'
import type { ScriptContext } from './scripts'

const NOW = Date.parse('2026-10-14T12:00:00Z')

const base: ScriptContext = {
  purpose: 'ready-check',
  role: 'lead',
  root: '/repo',
  stateDir: '/repo/.ctx-guard',
  handoff: '/repo/.ctx-guard/lead-handoff.md',
  handoffMtime: NOW + 60_000,
  startedAt: NOW,
  lastClearAt: null,
  via: 'clear',
}

describe('scriptEnv', () => {
  test('every variable, as strings', () => {
    expect(scriptEnv(base)).toEqual({
      CTX_GUARD_PURPOSE: 'ready-check',
      CTX_GUARD_SCRIPT_ROLE: 'lead',
      CTX_GUARD_ROOT: '/repo',
      CTX_GUARD_STATE_DIR: '/repo/.ctx-guard',
      CTX_GUARD_HANDOFF: '/repo/.ctx-guard/lead-handoff.md',
      CTX_GUARD_HANDOFF_MTIME_MS: String(NOW + 60_000),
      CTX_GUARD_SINCE_MS: String(NOW),
      CTX_GUARD_VIA: 'clear',
    })
  })

  test('what does not apply is the empty string, never absent', () => {
    const env = scriptEnv({ ...base, purpose: 'band-probe', role: null, handoff: null, handoffMtime: null, via: null })
    expect(Object.keys(env).length).toBe(8)
    expect(env.CTX_GUARD_SCRIPT_ROLE).toBe('')
    expect(env.CTX_GUARD_HANDOFF).toBe('')
    expect(env.CTX_GUARD_HANDOFF_MTIME_MS).toBe('')
    expect(env.CTX_GUARD_VIA).toBe('')
    expect(env.CTX_GUARD_PURPOSE).toBe('band-probe')
  })

  test('the bound is the later of the session start and the last /clear', () => {
    expect(scriptEnv({ ...base, lastClearAt: NOW + 5000 }).CTX_GUARD_SINCE_MS).toBe(String(NOW + 5000))
    expect(scriptEnv({ ...base, lastClearAt: NOW - 5000 }).CTX_GUARD_SINCE_MS).toBe(String(NOW))
  })

  test('never the variable ctx-guard reads its role from', () => {
    expect('CTX_GUARD_ROLE' in scriptEnv(base)).toBe(false)
  })
})

describe('parseProbe', () => {
  const ok = (stdout: string) => parseProbe({ exitCode: 0, stdout, stderr: '' })

  test('empty or blank output is no segment', () => {
    expect(ok('')).toEqual({ kind: 'none' })
    expect(ok('\n  \n')).toEqual({ kind: 'none' })
  })

  test('first non-blank line is the text; the next one a colour', () => {
    expect(ok('\nstep 03 sonnet 12m\n')).toEqual({ kind: 'segment', text: 'step 03 sonnet 12m', color: null })
    expect(ok('step 03\nwarning\n')).toEqual({ kind: 'segment', text: 'step 03', color: 'warning' })
    expect(ok('step 03\npurple\n')).toEqual({ kind: 'segment', text: 'step 03', color: null })
  })

  test('escapes and control characters go; a long line is cut to 40', () => {
    expect(ok('\u001b[31mred\u001b[0m\tdone\r\n')).toEqual({ kind: 'segment', text: 'red done', color: null })
    const long = ok('x'.repeat(100))
    expect(long.kind === 'segment' && long.text).toBe(`${'x'.repeat(39)}…`)
    expect(ok('x'.repeat(40))).toEqual({ kind: 'segment', text: 'x'.repeat(40), color: null })
  })

  test('a non-zero exit or a failure to run is a failure with its detail', () => {
    expect(parseProbe({ exitCode: 2, stdout: '', stderr: 'no .runs\n' })).toEqual({ kind: 'failed', detail: 'exited 2: no .runs' })
    expect(parseProbe({ error: 'did not finish within 5s' })).toEqual({ kind: 'failed', detail: 'did not finish within 5s' })
  })
})

describe('probe segments and state', () => {
  test('a segment, none, or `<id> ?` on failure', () => {
    expect(probeSegment('run', { kind: 'segment', text: 'step 03', color: 'warning' })).toEqual({ id: 'run', text: 'step 03', color: 'warning' })
    expect(probeSegment('run', { kind: 'none' })).toBeNull()
    expect(probeSegment('run', { kind: 'failed', detail: 'exited 1' })).toEqual({ id: 'run', text: 'run ?', color: 'warning' })
  })

  test('the report line', () => {
    expect(probeState(null, NOW, 'untrusted')).toBe('not run (untrusted)')
    expect(probeState(null, NOW, null)).toBe('not run yet')
    expect(probeState({ outcome: { kind: 'segment', text: 'step 03', color: 'warning' }, at: NOW - 120_000 }, NOW, null)).toBe('"step 03" (warning), 2m ago')
    expect(probeState({ outcome: { kind: 'none' }, at: NOW - 120_000 }, NOW, null)).toBe('no segment, 2m ago')
    expect(probeState({ outcome: { kind: 'failed', detail: 'exited 1: boom' }, at: NOW - 120_000 }, NOW, null)).toBe('failed 2m ago: exited 1: boom')
  })
})
