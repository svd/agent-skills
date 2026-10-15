// ctx-guard's band: one line of figures above the prompt, or the same text on
// the status line where no band is drawn. The text builders are pure; the one
// render hook draws the band ctx-guard holds in memory, never waiting on `$`.
import type { On, RenderSurface } from 'claude-code'
import type { Band, BandLimit } from '../types'
import { humanDuration, humanPercent, humanTokens, resetsInMs } from './messages'
import type { TrustState } from './config'
import type { DenyEntry, Metrics } from './triggers'
import { contextPercent } from './triggers'

const BAND = { plugin: 'ctx-guard', key: 'band' } as const

export type Segment = { text: string; color?: string; dim?: boolean }

const SEP = ' · '

// Theme keys, so the band follows the person's theme: green below `warn`, so a figure that is fine reads as fine.
const level = (pct: number, warn: number, high: number): string =>
  pct >= high ? 'error' : pct >= warn ? 'warning' : 'green'

const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }

function limitSegment(l: BandLimit, now: number): Segment {
  const left = resetsInMs(l.resetsAt, now)
  const name = SHORT[l.kind] ?? l.kind
  const text = `${name} ${humanPercent(l.percentUsed)}${left === null ? '' : ` (${humanDuration(left)})`}`
  return { text, color: level(l.percentUsed, 80, 90) }
}

/**
 * `lead · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h) · step 03 · untrusted · sub 1! · deny Agent`;
 * figures that are unknown are left out, so a fresh session shows little.
 */
export function bandSegments(b: Band): Segment[] {
  const out: Segment[] = []
  if (b.role) out.push({ text: b.role })
  if (b.tokens !== null) {
    const pct = b.percent
    const text = pct === null ? humanTokens(b.tokens) : `${humanTokens(b.tokens)} (${humanPercent(pct)})`
    const color = pct === null ? undefined : level(pct, 50, 75)
    out.push(color ? { text, color } : { text })
  }
  for (const l of b.limits) out.push(limitSegment(l, b.now))
  // A band another version stored may have none.
  for (const p of b.probes ?? []) out.push(p.color ? { text: p.text, color: p.color } : { text: p.text })
  if (b.untrusted) out.push({ text: b.untrusted, color: 'warning' })
  if (b.subagentsOver > 0) out.push({ text: `sub ${b.subagentsOver}!`, color: 'warning' })
  if (b.denies.length) out.push({ text: `deny ${b.denies.join(', ')}`, color: 'error' })
  if (b.restartFailed) out.push({ text: b.restartFailed, color: 'error' })
  const joined: Segment[] = []
  out.forEach((s, i) => {
    if (i > 0) joined.push({ text: SEP, dim: true })
    joined.push(s)
  })
  return joined
}

export function bandText(b: Band): string {
  return bandSegments(b)
    .map(s => s.text)
    .join('')
}

/** The band for a reading; the subagent count and restart failure carry over from `prev`. */
export function bandOf(role: string | null, m: Metrics, denies: readonly DenyEntry[], prev: Band | null): Band {
  const limits: BandLimit[] = []
  if (m.limits.five_hour) limits.push({ kind: 'five_hour', percentUsed: m.limits.five_hour.pct, resetsAt: m.limits.five_hour.resetsAt })
  if (m.limits.seven_day) limits.push({ kind: 'seven_day', percentUsed: m.limits.seven_day.pct, resetsAt: m.limits.seven_day.resetsAt })
  return {
    role,
    tokens: m.tokens,
    percent: contextPercent(m),
    window: m.window > 0 ? m.window : null,
    limits,
    probes: prev?.probes ?? [],
    subagentsOver: prev?.subagentsOver ?? 0,
    denies: [...new Set(denies.map(d => d.tool))],
    restartFailed: prev?.restartFailed ?? null,
    untrusted: prev?.untrusted ?? null,
    now: m.now,
  }
}

/**
 * The band's trust segment: `untrusted` while a repo that wants trust (an automatic
 * restart, a compact trigger, a probe) has none, `untrusted (changed)` once an approval no longer matches.
 */
export function untrustedText(t: TrustState | null, wanted: boolean): string | null {
  if (!wanted || !t || t.trusted) return null
  return t.record ? 'untrusted (changed)' : 'untrusted'
}

/**
 * A main-loop step's fill reads differently from the band's context figure, so the
 * band should be redrawn mid-turn; a step that leaves `150k` as `150k` need not write.
 */
export function bandLags(b: Band | null, tokens: number): boolean {
  return !b || b.tokens === null || humanTokens(b.tokens) !== humanTokens(tokens)
}

/** Same figures, ignoring when they were read; a step need not rewrite an unchanged band. */
export function sameBand(a: Band | null, b: Band | null): boolean {
  if (!a || !b) return a === b
  return JSON.stringify({ ...a, now: 0 }) === JSON.stringify({ ...b, now: 0 })
}

/**
 * Draws the band above the prompt wherever `shouldDraw` says the surface has
 * one, from `current` (ctx-guard's memory), never waiting on `$`: a session
 * start's work can hold `$` calls for seconds, and a /clear empties `$.state`.
 */
export function registerBand(on: On, shouldDraw: (surface: RenderSurface) => boolean, current: () => Band | null): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !shouldDraw(e.surface)) return next(e)
    // Read on every draw, unawaited and unused: the read subscribes the drawing to the band's next write.
    void $.state.get(BAND).catch(() => undefined)
    const band = current()
    const segments = band ? bandSegments(band) : []
    if (!segments.length) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text wrap="truncate-end">
        {segments.map((s, i) => (
          <Text key={`s${i}`} color={s.color} dimColor={s.dim === true}>
            {s.text}
          </Text>
        ))}
      </Text>
    )
  })
}
