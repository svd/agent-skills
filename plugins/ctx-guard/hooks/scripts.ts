// ctx-guard's project scripts: the environment a ready check or a band probe
// runs with, and what a probe's output draws. Pure: no `$`, never throws.
import type { BandProbe } from '../types'
import { humanDuration } from './messages'
import { checkDetail } from './restart'

export type ScriptPurpose = 'ready-check' | 'dry-run' | 'band-probe'

// Paths are absolute; null is "does not apply" (no role, via compact, no file).
export type ScriptContext = {
  purpose: ScriptPurpose
  role: string | null
  root: string
  stateDir: string
  handoff: string | null
  handoffMtime: number | null
  startedAt: number
  lastClearAt: number | null
  via: 'clear' | 'compact' | null
}

const int = (n: number | null): string => (n === null || !Number.isFinite(n) ? '' : String(Math.floor(n)))

/**
 * The variables a script sees, every one always set ('' when it does not
 * apply). The role is not CTX_GUARD_ROLE: ctx-guard reads that one, so a
 * script that starts `claude` would hand its role on.
 */
export function scriptEnv(c: ScriptContext): Record<string, string> {
  return {
    CTX_GUARD_PURPOSE: c.purpose,
    CTX_GUARD_SCRIPT_ROLE: c.role ?? '',
    CTX_GUARD_ROOT: c.root,
    CTX_GUARD_STATE_DIR: c.stateDir,
    CTX_GUARD_HANDOFF: c.handoff ?? '',
    CTX_GUARD_HANDOFF_MTIME_MS: int(c.handoffMtime),
    // The bound handoff-stale judges against.
    CTX_GUARD_SINCE_MS: int(Math.max(c.startedAt, c.lastClearAt ?? 0)),
    CTX_GUARD_VIA: c.via ?? '',
  }
}

// ---- band probes -------------------------------------------------------------

export const PROBE_COLORS = ['inactive', 'green', 'warning', 'error', 'subtle'] as const
export type ProbeColor = (typeof PROBE_COLORS)[number]

export const PROBE_TEXT_MAX = 40

export type ProbeOutcome =
  | { kind: 'segment'; text: string; color: ProbeColor | null }
  | { kind: 'none' }
  | { kind: 'failed'; detail: string }

export type ProbeRun = { outcome: ProbeOutcome; at: number }

// Terminal escapes first, then every control character; tabs read as spaces.
const clean = (s: string): string =>
  s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\t/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

function cut(text: string): string {
  const chars = [...text]
  return chars.length <= PROBE_TEXT_MAX ? text : `${chars.slice(0, PROBE_TEXT_MAX - 1).join('')}…`
}

const isColor = (v: string): v is ProbeColor => (PROBE_COLORS as readonly string[]).includes(v)

/** A probe's run as a segment: the first non-blank line, then an optional colour line. */
export function parseProbe(r: { exitCode: number; stdout: string; stderr: string } | { error: string }): ProbeOutcome {
  if ('error' in r) return { kind: 'failed', detail: r.error }
  if (r.exitCode !== 0) return { kind: 'failed', detail: checkDetail(r.exitCode, r.stderr, r.stdout) }
  const lines = r.stdout.split('\n').map(clean).filter(l => l !== '')
  const text = lines[0]
  if (text === undefined) return { kind: 'none' }
  const color = lines[1] !== undefined && isColor(lines[1]) ? lines[1] : null
  return { kind: 'segment', text: cut(text), color }
}

/** What the band draws for an outcome: its text, nothing, or `<id> ?` when it failed. */
export function probeSegment(id: string, o: ProbeOutcome): BandProbe | null {
  if (o.kind === 'none') return null
  if (o.kind === 'failed') return { id, text: `${id} ?`, color: 'warning' }
  return { id, text: o.text, color: o.color }
}

/** One probe's report line; `off` says why probes do not run now. */
export function probeState(run: ProbeRun | null, now: number, off: string | null): string {
  if (off !== null) return `not run (${off})`
  if (!run) return 'not run yet'
  const ago = `${humanDuration(Math.max(0, now - run.at))} ago`
  const o = run.outcome
  if (o.kind === 'none') return `no segment, ${ago}`
  if (o.kind === 'failed') return `failed ${ago}: ${o.detail}`
  return `"${o.text}"${o.color ? ` (${o.color})` : ''}, ${ago}`
}
