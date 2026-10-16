# ctx-guard prompt-cache help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a prompt-cache countdown in the band, `cache.miss` alerts, and bounded keep-warm (`ping` through a fork, `prompt` through a real turn) to the ctx-guard mod, all expressed as trigger metrics and actions.

**Architecture:** A new pure module `hooks/cache.ts` owns every cache rule (TTL, anchor, miss, ping verdict, band segment, idle-period counters). `config.ts`, `triggers.ts`, `band.tsx` and `messages.ts` learn the new keys, metrics, actions and texts. `register.tsx` stays thin: it feeds main-request usage into `cache.ts`, keeps a `cache` record in `$.state`, and runs `$.model.fork` / `$.prompt.submit` for fired triggers.

**Tech Stack:** TypeScript mod loaded in-process by Claude Code (no build, no package.json); tests with `claude-code/testing` run by `claude plugin test`.

**Spec:** `docs/superpowers/specs/2026-10-16-ctx-guard-cache-design.md` (read it first; this plan argues from it).

## Global Constraints

- Pure modules (`cache.ts`, `config.ts`, `triggers.ts`, `band.tsx`, `messages.ts`) have no `$` access and never throw.
- Hooks never throw: every `$` call in `register.tsx` goes through `quietly`.
- Every stored value is JSON; an absent figure is `null`, never `undefined` (`types/index.d.ts` header).
- A value read back from `$.state` may come from another version: check its shape before use (`asCache`, as `asActivity` does).
- Margin taken off the TTL: 30 s. Miss noise floor: 2k tokens. Warm request: `cache_read ≥ 90 %` of the previous fill. Warm ping: `cache_read > 0` and `cache_creation < 10 %` of `cache_read`.
- Defaults: `cache.ttl: "auto"`, `cache.band.show: "17%"`, `cache.band.warn: "3m"`, `cache.ping.maxUsage: 90`.
- `ping` and `prompt` need `/ctx-guard trust` and the `autoActions` switch, like `compact`.
- A trigger with `ping` or `prompt` must have `times`; `ping` must have `cache.expiresIn` in its `when`.
- Ping prompt text: `Reply with OK.`; fork timeout: 2 minutes.
- Default prompt text: `[ctx-guard] The user has been away {idle}; the prompt cache expires in {expiresIn}. Write the handoff to {handoffPath} and stop; do not start new work.`
- Docs and comments state what the code does; they never contrast with options that existed only in the design discussion.
- Commits: conventional style, `feat(ctx-guard): …`, `test(ctx-guard): …`, `docs(ctx-guard): …`; one per task.
- After every task: `claude plugin test plugins/ctx-guard` passes. After the last: `claude plugin validate plugins/ctx-guard` and `tsc -p plugins/ctx-guard` too.

## Review Focus

1. **A `prompt` turn re-arming idle triggers.** While ctx-guard's own prompt turn runs, `idle` must keep counting (not drop to 0), or an `idle` notify fires a second time after it. Test in Task 7.
2. **A cold or failing ping looping.** A ping that finds the cache cold must stop the series for the period; a failing one must not fire the trigger again. Tests in Tasks 2 and 8.
3. **A `/compact` or `/clear` reported as a cache miss.** The first request after either rewrites the whole prefix and must read `cache.miss = 0`. Tests in Tasks 2 and 7.
4. **An old stored band or config (no `cache` key) after an upgrade.** `asConfig` and `bandSegments` must accept them. Tests in Tasks 1 and 4.
5. **An existing trust approval invalidated by the upgrade.** The trust hash must stay the same for a config with no `ping`/`prompt` trigger. Test in Task 1.

---

## File map

| File | Change |
|---|---|
| `plugins/ctx-guard/types/index.d.ts` | `count` quantity; `ping`/`prompt` actions; three `cache.*` metrics; `Trigger.times`; `CacheConfig`; `BandCache`; `CacheState`; `Activity.ownTurn`; `PluginState.cache` |
| `plugins/ctx-guard/hooks/config.ts` | `cache` block, metrics, actions, `times`, validation, `asConfig` default, trust material |
| `plugins/ctx-guard/hooks/commands.ts` | `wantsTrust` counts `ping`/`prompt` |
| `plugins/ctx-guard/hooks/cache.ts` (new) | all cache rules |
| `plugins/ctx-guard/hooks/triggers.ts` | cache metrics in `Metrics`/`FireVars`, `≤` for `cache.expiresIn`, `applyTimes`, `planActions` |
| `plugins/ctx-guard/hooks/band.tsx` | cache segment |
| `plugins/ctx-guard/hooks/messages.ts` | texts, `{idle}`/`{expiresIn}`, prompt text |
| `plugins/ctx-guard/hooks/register.tsx` | wiring |
| `plugins/ctx-guard/skills/guide/assets/ctx-guard.schema.json` | new keys |
| `plugins/ctx-guard/skills/guide/assets/presets/{solo,peers}.json` + `register.test.ts` `PRESET_TEXT` | `cache-miss` toast trigger |
| docs | config reference, guide SKILL.md, README, comparison, use cases, CHANGELOG |

Tests sit beside each module: `cache.test.ts` (new), `config.test.ts`, `triggers.test.ts`, `band.test.ts`, `messages.test.ts`, `register.test.ts`.

Run tests from the repo root: `claude plugin test plugins/ctx-guard`. To run one file's tests the kit has no filter flag; run the whole suite and read the file's section of the output.

---

### Task 1: Config — types, `cache` block, metrics, actions, `times`, trust

**Files:**
- Modify: `plugins/ctx-guard/types/index.d.ts`
- Modify: `plugins/ctx-guard/hooks/config.ts` (quantities ~61-109; schema ~342-473; `normalizeConfig` ~686-738; `asConfig` ~954; `trustMaterial` ~1014)
- Modify: `plugins/ctx-guard/hooks/commands.ts:121-126` (`wantsTrust`)
- Modify: `plugins/ctx-guard/hooks/messages.ts:51-62` (`humanQuantity` gets `count`)
- Modify: `plugins/ctx-guard/skills/guide/assets/ctx-guard.schema.json`
- Test: `plugins/ctx-guard/hooks/config.test.ts`

**Interfaces:**
- Produces (types, used by every later task):

```ts
export type QuantityKind = 'tokens' | 'percent' | 'duration' | 'usd' | 'count'
export type EdgeAction = 'note' | 'toast' | 'notify' | 'compact' | 'ping' | 'prompt'
export type Metric = /* existing */ | 'cache.expiresIn' | 'cache.miss' | 'cache.pings'
// TriggerWhen gains: 'cache.expiresIn': Quantity | null; 'cache.miss': Quantity | null; 'cache.pings': Quantity | null
export type Trigger = { id: string; when: TriggerWhen; do: Action[]; level: Level | null; message: string | null; times: number | null }
export type CacheShow = Quantity | 'always' | 'off'   // Quantity is duration or percent of the TTL
export type CacheConfig = {
  ttl: 'auto' | number          // ms: 300000 or 3600000
  band: { show: CacheShow; warn: Quantity }
  ping: { maxUsage: number }    // percent
}
// Config gains: cache: CacheConfig
```

- Produces (functions): `DEFAULT_CACHE: CacheConfig` exported from `config.ts`.

- [ ] **Step 1: Write the failing tests** — append to `plugins/ctx-guard/hooks/config.test.ts`:

```ts
describe('cache config', () => {
  const role = (triggers: unknown[]) => ({ version: 1, roles: { lead: { triggers } } })

  test('defaults when the block is absent', () => {
    const r = validate({ version: 1 })
    expect(r.errors).toEqual([])
    expect(r.config?.cache).toEqual({
      ttl: 'auto',
      band: { show: { kind: 'percent', value: 17 }, warn: { kind: 'duration', value: 180_000 } },
      ping: { maxUsage: 90 },
    })
  })

  test('ttl, show and warn forms', () => {
    const r = validate({ version: 1, cache: { ttl: '1h', band: { show: '30m', warn: '10%' }, ping: { maxUsage: 80 } } })
    expect(r.errors).toEqual([])
    expect(r.config?.cache).toEqual({
      ttl: 3_600_000,
      band: { show: { kind: 'duration', value: 1_800_000 }, warn: { kind: 'percent', value: 10 } },
      ping: { maxUsage: 80 },
    })
    expect(validate({ version: 1, cache: { band: { show: 'always' } } }).config?.cache.band.show).toBe('always')
    expect(validate({ version: 1, cache: { band: { show: false } } }).config?.cache.band.show).toBe('off')
  })

  test('bad cache values are errors', () => {
    expect(validate({ version: 1, cache: { ttl: '10m' } }).errors.join()).toContain('cache.ttl')
    expect(validate({ version: 1, cache: { band: { show: '5k' } } }).errors.join()).toContain('cache.band.show')
    expect(validate({ version: 1, cache: { ping: { maxUsage: 120 } } }).errors.join()).toContain('cache.ping.maxUsage')
    expect(validate({ version: 1, cache: { nope: 1 } }).errors.join()).toContain('nope')
  })

  test('cache metrics parse', () => {
    const r = validate(role([{ id: 'w', when: { 'cache.expiresIn': '5m', 'cache.pings': 3, 'cache.miss': '50k' }, do: ['toast'] }]))
    expect(r.errors).toEqual([])
    const w = r.config?.roles.lead?.triggers[0]?.when
    expect(w?.['cache.expiresIn']).toEqual({ kind: 'duration', value: 300_000 })
    expect(w?.['cache.pings']).toEqual({ kind: 'count', value: 3 })
    expect(w?.['cache.miss']).toEqual({ kind: 'tokens', value: 50_000 })
  })

  test('ping and prompt with times', () => {
    const r = validate(role([
      { id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 3 },
      { id: 'away', when: { 'cache.expiresIn': '5m', 'cache.pings': 3 }, do: ['prompt', 'notify'], times: 1 },
    ]))
    expect(r.errors).toEqual([])
    expect(r.config?.roles.lead?.triggers.map(t => t.times)).toEqual([3, 1])
  })

  test('times is optional elsewhere and must be a whole number of at least 1', () => {
    expect(validate(role([{ id: 't', when: { idle: '5m' }, do: ['toast'] }])).config?.roles.lead?.triggers[0]?.times).toBeNull()
    expect(validate(role([{ id: 't', when: { idle: '5m' }, do: ['toast'], times: 0 }])).errors.join()).toContain('times')
    expect(validate(role([{ id: 't', when: { idle: '5m' }, do: ['toast'], times: 1.5 }])).errors.join()).toContain('times')
  })

  test('ping and prompt rules', () => {
    expect(validate(role([{ id: 'p', when: { context: '50k' }, do: ['ping'], times: 1 }])).errors.join()).toContain('needs cache.expiresIn')
    expect(validate(role([{ id: 'p', when: { 'cache.expiresIn': '5m' }, do: ['ping'] }])).errors.join()).toContain('needs times')
    expect(validate(role([{ id: 'p', when: { idle: '50m' }, do: ['prompt'] }])).errors.join()).toContain('needs times')
    expect(validate(role([{ id: 'd', when: { 'cache.miss': '10k' }, do: [{ deny: ['Agent'] }] }])).errors.join()).toContain('deny cannot be combined')
  })

  test('a stored config from before the cache block reads with the defaults', () => {
    const c = validate({ version: 1 }).config as Config
    const { cache: _drop, ...old } = c
    expect(asConfig(old)?.cache).toEqual(c.cache)
  })

  test('the trust hash of a config with no ping or prompt is unchanged by the cache block', () => {
    const plain = validate(role([{ id: 'c', when: { context: '60%' }, do: ['compact'] }])).config as Config
    const tuned = validate({ ...role([{ id: 'c', when: { context: '60%' }, do: ['compact'] }]), cache: { ttl: '1h' } }).config as Config
    expect(trustHash(tuned)).toBe(trustHash(plain))
    const warm = validate(role([{ id: 'c', when: { context: '60%' }, do: ['compact'] }, { id: 'w', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 3 }])).config as Config
    expect(trustHash(warm)).not.toBe(trustHash(plain))
    expect(Object.keys(trustFields(warm))).toContain('lead.autoTriggers')
  })
})
```

Add `Config` to the file's type imports if missing (`import type { Config } from '../types'`).

The trust-hash test pins Review Focus 5: an approval given before this change must still match.

- [ ] **Step 2: Run, verify they fail**

Run: `claude plugin test plugins/ctx-guard`
Expected: the `cache config` tests FAIL (unknown key `cache`, unknown metric, unknown action `ping`).

- [ ] **Step 3: Types** — in `plugins/ctx-guard/types/index.d.ts`:

```ts
export type QuantityKind = 'tokens' | 'percent' | 'duration' | 'usd' | 'count'

// `value` is a token count, a percentage (0-100], milliseconds, US dollars, or a whole count.
export type Quantity = { kind: QuantityKind; value: number }

export type EdgeAction = 'note' | 'toast' | 'notify' | 'compact' | 'ping' | 'prompt'

export type Metric =
  | 'context'
  | 'limit.five_hour'
  | 'limit.seven_day'
  | 'limit.any'
  | 'limit.five_hour.resetsIn'
  | 'limit.seven_day.resetsIn'
  | 'cost'
  | 'idle'
  | 'cache.expiresIn'
  | 'cache.miss'
  | 'cache.pings'
```

Add to `TriggerWhen` (after `idle`):

```ts
  // Time left before the main thread's prompt cache expires; holds at or below its threshold.
  'cache.expiresIn': Quantity | null
  // Tokens the latest main request rewrote although the cache was expected warm.
  'cache.miss': Quantity | null
  // Warm pings in the current idle period.
  'cache.pings': Quantity | null
```

`Trigger` gains `times: number | null` with the comment `// At most this many fires per idle period; null is no cap.`

Add after `BandProbeSpec`:

```ts
// When the band shows the cache countdown: within a duration or a percent of the TTL, always, or never.
export type CacheShow = Quantity | 'always' | 'off'

export type CacheConfig = {
  // 'auto' detects the TTL; a number (ms) is 300000 or 3600000.
  ttl: 'auto' | number
  band: { show: CacheShow; warn: Quantity }
  // No ping while any usage window is at or above this percent.
  ping: { maxUsage: number }
}
```

`Config` gains `cache: CacheConfig` after `band`.

- [ ] **Step 4: Quantities** — in `config.ts`:

```ts
const COUNT = /^\d+$/
```

`KIND_TEXT` gains `count: 'a whole number (3)',`. In `quantity()`, reject a non-integer count: add `if (kind === 'count' && !Number.isInteger(value)) return null` before rounding. In `parseQuantity`, a bare number with `bare === 'count'` already goes through `quantity`; no other form is needed.

In `messages.ts` `humanQuantity` add `case 'count': return String(q.value)`.

- [ ] **Step 5: Metrics, actions, `times`** — in `config.ts` schema section:

```ts
const TRIGGER_KEYS = ['id', 'when', 'do', 'level', 'message', 'times']
const CACHE_METRICS = ['cache.expiresIn', 'cache.miss', 'cache.pings'] as const
const METRICS = ['context', ...LIMIT_METRICS, ...RESETS_IN_METRICS, 'cost', 'idle', ...CACHE_METRICS] as const
const EDGE_ACTIONS = ['note', 'toast', 'notify', 'compact', 'ping', 'prompt'] as const
const TOP_KEYS = ['$schema', 'version', 'enabled', 'stateDir', 'readyToken', 'defaultRole', 'contextWindow', 'defaults', 'roles', 'subagents', 'band', 'cache']
```

`METRIC_KINDS` gains:

```ts
  'cache.expiresIn': { allowed: ['duration'] },
  'cache.miss': { allowed: ['tokens'], bare: 'tokens' },
  'cache.pings': { allowed: ['count'], bare: 'count' },
```

`emptyWhen()` gains the three keys as `null`. `STEPPABLE` is unchanged, so `every` never steps them.

In `normalizeTrigger`, after the existing idle/deny check:

```ts
  const usesCache = CACHE_METRICS.some(m => when?.[m])
  // A deny is judged at each tool call; the cache figures move only between requests.
  if (usesCache && actions.some(a => typeof a === 'object')) {
    err(ctx, join(path, 'do'), 'deny cannot be combined with a cache metric')
  }
  const auto = actions.filter((a): a is 'ping' | 'prompt' => a === 'ping' || a === 'prompt')
  if (actions.includes('ping') && when && !when['cache.expiresIn']) {
    err(ctx, join(path, 'do'), 'ping needs cache.expiresIn in the same `when`')
  }
  let times: number | null = null
  if (v.times !== undefined) {
    if (typeof v.times === 'number' && Number.isInteger(v.times) && v.times >= 1) times = v.times
    else err(ctx, join(path, 'times'), `expected a whole number of at least 1, got ${shown(v.times)}`)
  } else if (auto.length) {
    err(ctx, join(path, 'times'), `${auto.join(' and ')} needs times, so automatic spending has a cap`)
  }
```

and return `{ id, when, do: actions, level, message, times }`. The error texts must contain `needs cache.expiresIn`, `needs times` and `deny cannot be combined` (the tests match on them).

Update `normalizeAction`'s error text automatically through `EDGE_ACTIONS`.

- [ ] **Step 6: `cache` block** — in `config.ts`, export defaults and a normalizer near `normalizeBand`:

```ts
const TTLS: Record<string, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

export const DEFAULT_CACHE: CacheConfig = {
  ttl: 'auto',
  band: { show: { kind: 'percent', value: 17 }, warn: { kind: 'duration', value: 3 * MINUTE } },
  ping: { maxUsage: 90 },
}

function normalizeCache(ctx: Ctx, path: string, v: unknown): CacheConfig {
  const o = objAt(ctx, path, v)
  checkKeys(ctx, path, o, ['ttl', 'band', 'ping'])
  let ttl: CacheConfig['ttl'] = DEFAULT_CACHE.ttl
  if (o.ttl !== undefined && o.ttl !== 'auto') {
    const ms = typeof o.ttl === 'string' ? TTLS[o.ttl.trim()] : undefined
    if (ms === undefined) err(ctx, join(path, 'ttl'), `expected "auto", "5m" or "1h", got ${shown(o.ttl)}`)
    else ttl = ms
  }
  const band = objAt(ctx, join(path, 'band'), o.band)
  checkKeys(ctx, join(path, 'band'), band, ['show', 'warn'])
  let show: CacheShow = DEFAULT_CACHE.band.show
  if (band.show === false || band.show === 'off') show = 'off'
  else if (band.show === 'always') show = 'always'
  else if (band.show !== undefined) show = qtyAt(ctx, join(path, 'band.show'), band.show, ['duration', 'percent']) ?? DEFAULT_CACHE.band.show
  const warn = band.warn === undefined ? DEFAULT_CACHE.band.warn : (qtyAt(ctx, join(path, 'band.warn'), band.warn, ['duration', 'percent']) ?? DEFAULT_CACHE.band.warn)
  const ping = objAt(ctx, join(path, 'ping'), o.ping)
  checkKeys(ctx, join(path, 'ping'), ping, ['maxUsage'])
  const maxUsage = ping.maxUsage === undefined ? DEFAULT_CACHE.ping.maxUsage : (qtyAt(ctx, join(path, 'ping.maxUsage'), ping.maxUsage, ['percent'], 'percent')?.value ?? DEFAULT_CACHE.ping.maxUsage)
  return { ttl, band: { show, warn }, ping: { maxUsage } }
}
```

Check that `qtyAt` reports an error naming the path for `"5k"` on `band.show` and for `120` on `maxUsage` (percent over 100 is rejected by `quantity`); the tests match `cache.band.show` and `cache.ping.maxUsage`. Import `CacheConfig` and `CacheShow` types.

`normalizeConfig` returns `cache: normalizeCache(ctx, 'cache', o.cache),` after `band`.

`asConfig`: before `return v as unknown as Config`, default a missing block:

```ts
  // A config stored before cache existed reads with the defaults.
  const withCache = isObj(v.cache) ? v : { ...v, cache: DEFAULT_CACHE }
```

and use `withCache` in both return paths (the `band === undefined` branch too).

- [ ] **Step 7: Trust** — in `trustMaterial`, inside the per-role object, add the key only when it has content, so earlier approvals still match:

```ts
    const auto = spec.triggers.filter(t => t.do.includes('ping') || t.do.includes('prompt'))
    out[name] = {
      restart: { mode, via, command, prompt, readyChecks, peers, peerGap, selfGap, minContext },
      handoff: { path: spec.handoff.path },
      compact: spec.compact.instructions,
      compactTriggers: spec.triggers.filter(t => t.do.includes('compact')),
      // Only when there are some, so an approval given before ping and prompt existed still matches.
      ...(auto.length ? { autoTriggers: auto } : {}),
    }
```

`compactTriggers` now carry `times: null`; check the hash test still passes (a `times: null` key changes `canonicalJson`). If it changes the hash, strip `times` when null inside `trustMaterial`: `spec.triggers.filter(...).map(({ times, ...t }) => (times === null ? t : { ...t, times }))`, for both lists.

In `commands.ts` `wantsTrust`:

```ts
    return spec !== null && (spec.restart.mode === 'auto' || spec.triggers.some(t => t.do.some(a => a === 'compact' || a === 'ping' || a === 'prompt')))
```

- [ ] **Step 8: JSON schema** — in `skills/guide/assets/ctx-guard.schema.json`:
  - top level `properties`: add `"cache"` — object, `additionalProperties: false`, with `ttl` (`enum: ["auto", "5m", "1h"]`), `band` (object: `show` = duration string, percent string, `"always"`, or `false`; `warn` = duration or percent string), `ping` (object: `maxUsage` = number 1-100 or percent string). Reuse the existing duration/percent `$defs` the file already has for `idle` and `limit.*`.
  - the trigger `when` object: add `cache.expiresIn` (duration), `cache.miss` (tokens, as `context` tokens), `cache.pings` (integer ≥ 1).
  - the trigger action enum (near line 737, where `"compact"` is listed): add `"ping"`, `"prompt"`.
  - the trigger object: add `"times": { "type": "integer", "minimum": 1 }`.

Validate the JSON parses: `python3 -c "import json;json.load(open('plugins/ctx-guard/skills/guide/assets/ctx-guard.schema.json'))"`.

- [ ] **Step 9: Run tests**

Run: `claude plugin test plugins/ctx-guard`
Expected: all PASS. Existing tests that build `Trigger` literals by hand fail to type-check without `times`; add `times: null` to them.

- [ ] **Step 10: Commit**

```bash
git add plugins/ctx-guard/types/index.d.ts plugins/ctx-guard/hooks/config.ts plugins/ctx-guard/hooks/commands.ts plugins/ctx-guard/hooks/messages.ts plugins/ctx-guard/hooks/*.test.ts plugins/ctx-guard/skills/guide/assets/ctx-guard.schema.json
git commit -m "feat(ctx-guard): cache config block, cache metrics, ping and prompt actions, times"
```

---

### Task 2: `cache.ts` — the cache rules

**Files:**
- Create: `plugins/ctx-guard/hooks/cache.ts`
- Modify: `plugins/ctx-guard/types/index.d.ts` (`CacheState`, `TtlSource`, `BandCache`)
- Test: `plugins/ctx-guard/hooks/cache.test.ts` (new)

**Interfaces:**
- Consumes: `CacheConfig`, `CacheShow`, `Quantity` (Task 1).
- Produces:

```ts
// types/index.d.ts
export type TtlSource = 'config' | 'transcript' | 'observed' | 'guess'
export type CacheState = {
  // Detected TTL in ms and where it came from; null until detected (a guess is not stored).
  ttl: number | null
  ttlSource: TtlSource | null
  // The transcript was read for the TTL (or could not be): not again until /clear or a new session.
  transcriptTried: boolean
  // When the main prefix was last written or read: the latest main request or warm ping; null when unknown.
  anchor: number | null
  // The previous main request's fill (input + cache read + cache write); null after a start-over.
  prevFill: number | null
  // A main request read at least 90 % of the previous fill since the last start-over.
  warmSeen: boolean
  model: string | null
  // The latest main request's miss in tokens (0 below the floor) and its cause.
  miss: number
  missCause: 'model' | 'prefix' | null
  // Warm pings in the current idle period; the period's ping found the cache gone.
  pings: number
  cold: boolean
  // Fires per trigger id in the current idle period, for `times`.
  fired: { [triggerId: string]: number }
}
// The band's cache segment as last drawn; `color` is a theme key, null for the default.
export type BandCache = { text: string; color: string | null; dim: boolean }
```

```ts
// hooks/cache.ts
export const MARGIN_MS: number            // 30_000
export const FIVE_MIN: number             // 300_000
export const HOUR: number                 // 3_600_000
export const MISS_FLOOR: number           // 2_000
export function emptyCache(): CacheState
export function asCache(v: unknown): CacheState
export function newPeriod(c: CacheState): CacheState
export function startOver(c: CacheState): CacheState
export function ttlFromTranscript(text: string): number | null
export function withTtl(c: CacheState, ttl: number, source: TtlSource): CacheState
export function effectiveTtl(c: CacheState, cfg: CacheConfig, hasRateLimits: boolean): { ms: number; source: TtlSource }
export function expiresInMs(c: CacheState, ttl: number, busy: boolean, now: number): number | null
export type CacheUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model?: string | null }
export function onMainRequest(c: CacheState, u: CacheUsage, ttl: number, now: number): CacheState
export type PingVerdict = 'warm' | 'cold'
export function pingVerdict(u: CacheUsage | null | undefined): PingVerdict
export function onPing(c: CacheState, verdict: PingVerdict, now: number): CacheState
export type SegmentInput = { expiresIn: number | null; ttl: number; guessed: boolean; busy: boolean; cold: boolean; show: CacheShow; warn: Quantity; pings: number; cap: number | null }
export function cacheSegment(i: SegmentInput): BandCache | null
```

- [ ] **Step 1: Write the failing tests** — create `plugins/ctx-guard/hooks/cache.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CACHE } from './config'
import { HOUR, FIVE_MIN, MARGIN_MS, asCache, cacheSegment, effectiveTtl, emptyCache, expiresInMs, newPeriod, onMainRequest, onPing, pingVerdict, startOver, ttlFromTranscript, withTtl } from './cache'
import type { CacheState } from '../types'

const NOW = 1_000_000_000
const MIN = 60_000
const u = (read: number, write: number, model = 'm', input = 10) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, model })

describe('ttl', () => {
  test('from the newest cache_creation row of the transcript', () => {
    const rows = [
      '{"message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":900,"ephemeral_1h_input_tokens":0}}}}',
      '{"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":25528,"ephemeral_5m_input_tokens":0}}}}',
    ].join('\n')
    expect(ttlFromTranscript(rows)).toBe(HOUR)
    expect(ttlFromTranscript(rows.split('\n')[0] as string)).toBe(FIVE_MIN)
    expect(ttlFromTranscript('{"x":1}')).toBeNull()
    expect(ttlFromTranscript('{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}}')).toBeNull()
  })

  test('a stronger source replaces a weaker one, never the reverse', () => {
    let c = withTtl(emptyCache(), FIVE_MIN, 'observed')
    c = withTtl(c, HOUR, 'transcript')
    expect([c.ttl, c.ttlSource]).toEqual([HOUR, 'transcript'])
    c = withTtl(c, FIVE_MIN, 'observed')
    expect([c.ttl, c.ttlSource]).toEqual([HOUR, 'transcript'])
  })

  test('config wins; else the detected value; else a guess from the account', () => {
    expect(effectiveTtl(emptyCache(), { ...DEFAULT_CACHE, ttl: FIVE_MIN }, true)).toEqual({ ms: FIVE_MIN, source: 'config' })
    expect(effectiveTtl(withTtl(emptyCache(), FIVE_MIN, 'transcript'), DEFAULT_CACHE, true)).toEqual({ ms: FIVE_MIN, source: 'transcript' })
    expect(effectiveTtl(emptyCache(), DEFAULT_CACHE, true)).toEqual({ ms: HOUR, source: 'guess' })
    expect(effectiveTtl(emptyCache(), DEFAULT_CACHE, false)).toEqual({ ms: FIVE_MIN, source: 'guess' })
  })
})

describe('expiresIn', () => {
  const at = (anchor: number | null, over: Partial<CacheState> = {}): CacheState => ({ ...emptyCache(), anchor, ...over })
  test('ttl minus the margin from the anchor', () => {
    expect(expiresInMs(at(NOW), HOUR, false, NOW + 10 * MIN)).toBe(HOUR - MARGIN_MS - 10 * MIN)
  })
  test('zero once past, never negative', () => {
    expect(expiresInMs(at(NOW), FIVE_MIN, false, NOW + 2 * HOUR)).toBe(0)
  })
  test('the full ttl while a main turn runs', () => {
    expect(expiresInMs(at(NOW), HOUR, true, NOW + 50 * MIN)).toBe(HOUR)
  })
  test('unknown with no anchor; zero once a ping found it cold', () => {
    expect(expiresInMs(at(null), HOUR, false, NOW)).toBeNull()
    expect(expiresInMs(at(NOW, { cold: true }), HOUR, false, NOW + MIN)).toBe(0)
  })
})

describe('main requests', () => {
  test('the first requests set a baseline and never count a miss', () => {
    let c = onMainRequest(emptyCache(), u(10_583, 25_528), HOUR, NOW)
    expect([c.miss, c.anchor, c.prevFill, c.warmSeen]).toEqual([0, NOW, 36_121, false])
    // The spike's second request: most of the prefix rewritten, still before any warm request.
    c = onMainRequest(c, u(13_615, 22_726), HOUR, NOW + MIN)
    expect(c.miss).toBe(0)
    c = onMainRequest(c, u(36_300, 100), HOUR, NOW + 2 * MIN)
    expect(c.warmSeen).toBe(true)
  })

  test('after a warm request, a rewrite of the prefix is a miss', () => {
    let c: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    c = onMainRequest(c, u(10_000, 141_000), HOUR, NOW + 2 * MIN)
    expect([c.miss, c.missCause]).toEqual([140_000, 'prefix'])
    c = onMainRequest(c, u(151_000, 500), HOUR, NOW + 3 * MIN)
    expect([c.miss, c.missCause]).toEqual([0, null])
  })

  test('a miss below the floor is zero; a model switch names its cause', () => {
    const base: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    expect(onMainRequest(base, u(148_500, 2_000), HOUR, NOW + MIN).miss).toBe(0)
    const sw = onMainRequest(base, u(0, 151_000, 'other'), HOUR, NOW + MIN)
    expect([sw.miss, sw.missCause, sw.model]).toEqual([150_000, 'model', 'other'])
  })

  test('a rewrite after the cache expired is not a miss', () => {
    const c: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    expect(onMainRequest(c, u(0, 151_000), FIVE_MIN, NOW + 20 * MIN).miss).toBe(0)
  })

  test('a start-over (/clear, /compact) forgets the baseline, so the next rewrite is no miss', () => {
    const c = startOver({ ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm', miss: 5_000, missCause: 'prefix' })
    expect([c.anchor, c.prevFill, c.warmSeen, c.miss, c.missCause]).toEqual([null, null, false, 0, null])
    expect(onMainRequest(c, u(0, 40_000), HOUR, NOW + MIN).miss).toBe(0)
  })

  test('a warm request after more than five minutes proves a one-hour ttl', () => {
    const c: CacheState = { ...emptyCache(), anchor: NOW, prevFill: 150_000, warmSeen: true, model: 'm' }
    const next = onMainRequest(c, u(150_000, 500), FIVE_MIN, NOW + 20 * MIN)
    expect([next.ttl, next.ttlSource]).toEqual([HOUR, 'observed'])
  })
})

describe('pings', () => {
  test('verdicts', () => {
    expect(pingVerdict(u(36_116, 0))).toBe('warm')
    expect(pingVerdict(u(36_193, 153))).toBe('warm')
    expect(pingVerdict(u(13_615, 22_501))).toBe('cold')
    expect(pingVerdict(u(0, 40_000))).toBe('cold')
    expect(pingVerdict(null)).toBe('cold')
  })
  test('a warm ping counts and moves the anchor; a cold one marks the period', () => {
    const c: CacheState = { ...emptyCache(), anchor: NOW }
    expect(onPing(c, 'warm', NOW + 55 * MIN)).toMatchObject({ pings: 1, anchor: NOW + 55 * MIN, cold: false })
    expect(onPing(c, 'cold', NOW + 55 * MIN)).toMatchObject({ pings: 0, anchor: NOW, cold: true })
  })
  test('a new period clears pings, fire counts and cold', () => {
    const c = newPeriod({ ...emptyCache(), pings: 3, cold: true, fired: { warm: 3 }, anchor: NOW })
    expect([c.pings, c.cold, c.fired, c.anchor]).toEqual([0, false, {}, NOW])
  })
})

describe('segment', () => {
  const seg = (over: Partial<Parameters<typeof cacheSegment>[0]> = {}) =>
    cacheSegment({ expiresIn: 8 * MIN, ttl: HOUR, guessed: false, busy: false, cold: false, show: { kind: 'percent', value: 17 }, warn: { kind: 'duration', value: 3 * MIN }, pings: 0, cap: null, ...over })

  test('17 % of a one-hour ttl shows from about ten minutes', () => {
    expect(seg({ expiresIn: 11 * MIN })).toBeNull()
    expect(seg({ expiresIn: 10 * MIN })).toEqual({ text: 'cache 10m', color: null, dim: false })
  })
  test('17 % of a five-minute ttl shows from about fifty seconds', () => {
    expect(seg({ ttl: FIVE_MIN, expiresIn: 60_000 })).toBeNull()
    expect(seg({ ttl: FIVE_MIN, expiresIn: 45_000 })?.text).toBe('cache <1m')
  })
  test('warning colour under warn, ~ while guessed, pings with their cap', () => {
    expect(seg({ expiresIn: 2 * MIN })?.color).toBe('warning')
    expect(seg({ guessed: true })?.text).toBe('cache ~8m')
    expect(seg({ pings: 2, cap: 3 })?.text).toBe('cache 8m · ping 2/3')
  })
  test('cold, busy, always and off', () => {
    expect(seg({ expiresIn: 0 })).toEqual({ text: 'cache cold', color: null, dim: true })
    expect(seg({ cold: true, expiresIn: 0 })).toEqual({ text: 'cache cold', color: null, dim: true })
    expect(seg({ busy: true })).toBeNull()
    expect(seg({ show: 'always', expiresIn: 50 * MIN })?.text).toBe('cache 50m')
    expect(seg({ show: 'off' })).toBeNull()
    expect(seg({ expiresIn: null })).toBeNull()
  })
})

test('asCache keeps what it can read of another version\'s value', () => {
  expect(asCache(null)).toEqual(emptyCache())
  expect(asCache({ anchor: 5, pings: 2, fired: { a: 1, b: 'x' }, ttl: 3_600_000, ttlSource: 'observed' })).toMatchObject({ anchor: 5, pings: 2, fired: { a: 1 }, ttl: 3_600_000, ttlSource: 'observed' })
  expect(asCache({ ttlSource: 'nonsense', ttl: 3_600_000 })).toMatchObject({ ttl: null, ttlSource: null })
})
```

- [ ] **Step 2: Run, verify they fail**

Run: `claude plugin test plugins/ctx-guard`
Expected: `cache.test.ts` FAILS (module `./cache` not found).

- [ ] **Step 3: Types** — add `TtlSource`, `CacheState`, `BandCache` (exact text in **Interfaces** above) to `types/index.d.ts`, after `BandProbe`.

- [ ] **Step 4: Implement `hooks/cache.ts`**

```ts
// ctx-guard prompt cache: the TTL, when the main thread's cache expires, a
// request that rewrote a cache expected warm, ping verdicts, idle-period
// counters and the band's countdown. Pure: no `$`, never throws.
import type { BandCache, CacheConfig, CacheShow, CacheState, Quantity, TtlSource } from '../types'
import { humanDuration } from './messages'

export const MARGIN_MS = 30_000
export const FIVE_MIN = 5 * 60_000
export const HOUR = 60 * 60_000
export const MISS_FLOOR = 2_000
// A request reading this share of the previous fill found the cache warm.
const WARM_COVER = 0.9
// A ping writing more than this share of what it read found the prefix gone.
const PING_WRITE_LIMIT = 0.1

const RANK: Record<TtlSource, number> = { guess: 0, observed: 1, transcript: 2, config: 3 }
const SOURCES = Object.keys(RANK) as TtlSource[]

export function emptyCache(): CacheState {
  return { ttl: null, ttlSource: null, transcriptTried: false, anchor: null, prevFill: null, warmSeen: false, model: null, miss: 0, missCause: null, pings: 0, cold: false, fired: {} }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The stored value, checked field by field: another version may have written it. */
export function asCache(v: unknown): CacheState {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const source = typeof o.ttlSource === 'string' && (SOURCES as string[]).includes(o.ttlSource) ? (o.ttlSource as TtlSource) : null
  const ttl = num(o.ttl)
  const fired: Record<string, number> = {}
  if (typeof o.fired === 'object' && o.fired !== null) {
    for (const [k, n] of Object.entries(o.fired as Record<string, unknown>)) if (num(n) !== null) fired[k] = n as number
  }
  return {
    ttl: source && ttl !== null ? ttl : null,
    ttlSource: source && ttl !== null ? source : null,
    transcriptTried: o.transcriptTried === true,
    anchor: num(o.anchor),
    prevFill: num(o.prevFill),
    warmSeen: o.warmSeen === true,
    model: typeof o.model === 'string' ? o.model : null,
    miss: num(o.miss) ?? 0,
    missCause: o.missCause === 'model' || o.missCause === 'prefix' ? o.missCause : null,
    pings: num(o.pings) ?? 0,
    cold: o.cold === true,
    fired,
  }
}

/** A new idle period: the operator's own turn ended, or the session started over. */
export function newPeriod(c: CacheState): CacheState {
  return { ...c, pings: 0, cold: false, fired: {} }
}

/** The context started over (/clear, /compact): the next request writes a new prefix. */
export function startOver(c: CacheState): CacheState {
  return { ...c, anchor: null, prevFill: null, warmSeen: false, miss: 0, missCause: null }
}

/** The TTL the newest `cache_creation` usage in a transcript shows; null when none tells. */
export function ttlFromTranscript(text: string): number | null {
  const rows = text.match(/"cache_creation"\s*:\s*\{[^}]*\}/g)
  for (let i = (rows?.length ?? 0) - 1; i >= 0; i--) {
    const row = rows?.[i] ?? ''
    const hour = Number(/"ephemeral_1h_input_tokens"\s*:\s*(\d+)/.exec(row)?.[1] ?? 0)
    const five = Number(/"ephemeral_5m_input_tokens"\s*:\s*(\d+)/.exec(row)?.[1] ?? 0)
    if (hour > 0) return HOUR
    if (five > 0) return FIVE_MIN
  }
  return null
}

/** Records a detected TTL unless a stronger source already gave one. */
export function withTtl(c: CacheState, ttl: number, source: TtlSource): CacheState {
  if (c.ttlSource !== null && RANK[c.ttlSource] > RANK[source]) return c
  return { ...c, ttl, ttlSource: source }
}

/** The TTL in force: the config's, the detected one, else a guess (a subscription caches for an hour). */
export function effectiveTtl(c: CacheState, cfg: CacheConfig, hasRateLimits: boolean): { ms: number; source: TtlSource } {
  if (typeof cfg.ttl === 'number') return { ms: cfg.ttl, source: 'config' }
  if (c.ttl !== null && c.ttlSource !== null) return { ms: c.ttl, source: c.ttlSource }
  return { ms: hasRateLimits ? HOUR : FIVE_MIN, source: 'guess' }
}

/**
 * Time before the main thread's cache expires, less the margin. The full TTL
 * while a main turn runs (the cache is in use); 0 once past or once a ping
 * found it cold; null with no anchor.
 */
export function expiresInMs(c: CacheState, ttl: number, busy: boolean, now: number): number | null {
  if (c.anchor === null) return null
  if (busy) return ttl
  if (c.cold) return 0
  return Math.max(0, c.anchor + ttl - MARGIN_MS - now)
}

export type CacheUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model?: string | null }

const fillOf = (u: CacheUsage): number => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/**
 * One main-thread request: the miss against the previous fill when the cache
 * was expected warm, a one-hour TTL proved by a warm read after more than five
 * minutes, and the new anchor and baseline.
 */
export function onMainRequest(c: CacheState, u: CacheUsage, ttl: number, now: number): CacheState {
  const read = u.cache_read_input_tokens
  const model = u.model ?? c.model
  const expectedWarm = c.anchor !== null && c.prevFill !== null && now - c.anchor < ttl - MARGIN_MS
  const warm = c.prevFill !== null && c.prevFill > 0 && read >= WARM_COVER * c.prevFill
  let miss = 0
  let missCause: CacheState['missCause'] = null
  const switched = c.model !== null && model !== null && model !== c.model
  if (expectedWarm && c.warmSeen && c.prevFill !== null) {
    const lost = Math.max(0, c.prevFill - read)
    if (lost >= MISS_FLOOR) {
      miss = lost
      missCause = switched ? 'model' : 'prefix'
    }
  }
  let next: CacheState = { ...c, anchor: now, prevFill: fillOf(u), warmSeen: c.warmSeen || warm, model, miss, missCause }
  if (warm && c.anchor !== null && now - c.anchor > FIVE_MIN) next = withTtl(next, HOUR, 'observed')
  return next
}

export type PingVerdict = 'warm' | 'cold'

export function pingVerdict(u: CacheUsage | null | undefined): PingVerdict {
  if (!u) return 'cold'
  const read = u.cache_read_input_tokens
  return read > 0 && u.cache_creation_input_tokens < PING_WRITE_LIMIT * read ? 'warm' : 'cold'
}

export function onPing(c: CacheState, verdict: PingVerdict, now: number): CacheState {
  return verdict === 'warm' ? { ...c, pings: c.pings + 1, anchor: now, cold: false } : { ...c, cold: true }
}

export type SegmentInput = {
  expiresIn: number | null
  ttl: number
  guessed: boolean
  busy: boolean
  cold: boolean
  show: CacheShow
  warn: Quantity
  pings: number
  // `times` of the trigger that pings; null with none.
  cap: number | null
}

const within = (q: Quantity, ttl: number): number => (q.kind === 'percent' ? (q.value / 100) * ttl : q.value)

/** `cache 8m`, `cache ~8m · ping 2/3`, `cache <1m`, `cache cold`; null when hidden. */
export function cacheSegment(i: SegmentInput): BandCache | null {
  if (i.show === 'off' || i.busy || i.expiresIn === null) return null
  if (i.cold || i.expiresIn <= 0) return { text: 'cache cold', color: null, dim: true }
  if (i.show !== 'always' && i.expiresIn > within(i.show, i.ttl)) return null
  const left = i.expiresIn < 60_000 ? '<1m' : humanDuration(Math.floor(i.expiresIn / 60_000) * 60_000)
  const pings = i.pings > 0 && i.cap !== null ? ` · ping ${i.pings}/${i.cap}` : ''
  const color = i.expiresIn <= within(i.warn, i.ttl) ? 'warning' : null
  return { text: `cache ${i.guessed ? '~' : ''}${left}${pings}`, color, dim: false }
}
```

Note on `onMainRequest`: nothing counts as a miss before the first warm request (`warmSeen`), a model switch included: the session's first requests rewrite part of the prefix as a matter of course (spec, `cache.miss`).

- [ ] **Step 5: Run tests** — `claude plugin test plugins/ctx-guard`; expected all PASS. If `humanDuration` imports create a cycle (`messages.ts` imports nothing from `cache.ts`), none is expected.

- [ ] **Step 6: Commit**

```bash
git add plugins/ctx-guard/hooks/cache.ts plugins/ctx-guard/hooks/cache.test.ts plugins/ctx-guard/types/index.d.ts
git commit -m "feat(ctx-guard): cache rules: ttl, expiry, misses, ping verdicts, band countdown"
```

---

### Task 3: Triggers — cache metrics, `≤` for expiry, `times`, actions

**Files:**
- Modify: `plugins/ctx-guard/hooks/triggers.ts`
- Test: `plugins/ctx-guard/hooks/triggers.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:

```ts
export type CacheMetrics = { expiresIn: number | null; miss: number | null; missCause: 'model' | 'prefix' | null; pings: number | null }
export const NO_CACHE: CacheMetrics
// Metrics gains: cache: CacheMetrics
// FireVars gains: expiresIn: number | null; miss: number | null; missCause: 'model' | 'prefix' | null; pings: number | null
export function metricsOf(src: MetricsSource, window: number, idle: number | null, now: number, cache?: CacheMetrics): Metrics
export function applyTimes(fire: readonly Fire[], fired: Readonly<Record<string, number>>): { fire: Fire[]; fired: Record<string, number> }
// ActionPlan gains: ping: Fire | null; prompt: Fire | null
```

- [ ] **Step 1: Failing tests** — append to `triggers.test.ts` (extend the `m()` helper with `cache: NO_CACHE` in its base object, and import `NO_CACHE`, `applyTimes`):

```ts
describe('cache metrics', () => {
  const c = (over: Partial<typeof NO_CACHE>) => m({ cache: { ...NO_CACHE, ...over } })

  test('expiresIn holds at or below its threshold', () => {
    const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['toast'] })
    expect(run(t, [c({ expiresIn: 6 * 60_000 }), c({ expiresIn: 5 * 60_000 }), c({ expiresIn: 60_000 })]).fired).toEqual([[], ['warm@0'], []])
  })

  test('expiry rising again re-arms it, as a warm ping does', () => {
    const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['toast'] })
    expect(run(t, [c({ expiresIn: 4 * 60_000 }), c({ expiresIn: 59 * 60_000 }), c({ expiresIn: 4 * 60_000 })]).fired).toEqual([['warm@0'], [], ['warm@0']])
  })

  test('miss and pings hold at or above', () => {
    const t = trigs(
      { id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] },
      { id: 'away', when: { 'cache.expiresIn': '5m', 'cache.pings': 3 }, do: ['toast'] },
    )
    expect(run(t, [c({ miss: 40_000 }), c({ miss: 140_000 }), c({ expiresIn: 4 * 60_000, pings: 2 }), c({ expiresIn: 4 * 60_000, pings: 3 })]).fired).toEqual([[], ['miss@0'], [], ['away@0']])
  })

  test('unknown cache figures fire nothing', () => {
    const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['toast'] })
    expect(run(t, [c({ expiresIn: null })]).fired).toEqual([[]])
  })

  test('fire vars carry the cache figures', () => {
    const t = trigs({ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] })
    const e = evaluate(t, c({ miss: 140_000, missCause: 'model' }), null, 'lead')
    expect(e.fire[0]?.vars).toMatchObject({ metric: 'cache.miss', miss: 140_000, missCause: 'model' })
  })
})

describe('times', () => {
  const t = trigs({ id: 'warm', when: { 'cache.expiresIn': '5m' }, do: ['ping'], times: 2 }, { id: 'loud', when: { idle: '5m' }, do: ['toast'] })
  const fires = (ids: string[]) => evaluate(t, m({ idleMs: 6 * 60_000, cache: { ...NO_CACHE, expiresIn: 60_000 } }), null, 'lead').fire.filter(f => ids.includes(f.trigger.id))

  test('a capped trigger fires up to its times, then not', () => {
    let fired: Record<string, number> = {}
    const one = applyTimes(fires(['warm']), fired)
    expect(one.fire.map(f => f.trigger.id)).toEqual(['warm'])
    fired = one.fired
    fired = applyTimes(fires(['warm']), fired).fired
    expect(fired).toEqual({ warm: 2 })
    expect(applyTimes(fires(['warm']), fired).fire).toEqual([])
  })

  test('an uncapped trigger is never held back, and not counted', () => {
    const r = applyTimes(fires(['loud']), { loud: 99 })
    expect(r.fire.length).toBe(1)
    expect(r.fired).toEqual({ loud: 99 })
  })
})

describe('plan', () => {
  const fire = (id: string, actions: string[]) => ({ trigger: { id } as never, actions: actions as never, step: 0, vars: {} as never })

  test('prompt wins over ping in one evaluation', () => {
    const p = planActions([fire('warm', ['ping']), fire('away', ['prompt', 'notify'])])
    expect(p.ping).toBeNull()
    expect(p.prompt?.trigger.id).toBe('away')
    expect(p.notifies.length).toBe(1)
  })

  test('one ping per evaluation', () => {
    expect(planActions([fire('a', ['ping']), fire('b', ['ping'])]).ping?.trigger.id).toBe('a')
  })
})
```

- [ ] **Step 2: Run, verify they fail** — `claude plugin test plugins/ctx-guard`; FAIL on `NO_CACHE`/`applyTimes` missing.

- [ ] **Step 3: Implement** in `triggers.ts`:

```ts
// The main thread's prompt cache, as cache.ts reads it; null is unknown.
export type CacheMetrics = { expiresIn: number | null; miss: number | null; missCause: 'model' | 'prefix' | null; pings: number | null }
export const NO_CACHE: CacheMetrics = { expiresIn: null, miss: null, missCause: null, pings: null }
```

`Metrics` gains `cache: CacheMetrics`. `metricsOf(src, window, idle, now, cache: CacheMetrics = NO_CACHE)` sets `cache`. `FireVars` gains `expiresIn`, `miss`, `missCause`, `pings` (types above); `varsOf` fills them from `m.cache`.

`METRIC_ORDER` appends `'cache.expiresIn', 'cache.miss', 'cache.pings'`.

`valueOf` gains:

```ts
    case 'cache.expiresIn':
      return m.cache.expiresIn
    case 'cache.miss':
      return m.cache.miss
    case 'cache.pings':
      return m.cache.pings
```

`conditions` computes `holds` per direction:

```ts
// The one countdown metric: it holds as the figure falls to its threshold.
const AT_OR_BELOW: ReadonlySet<Metric> = new Set(['cache.expiresIn'])
...
    const holds = value !== null && (AT_OR_BELOW.has(metric) ? value - EPS <= threshold.value : value + EPS >= threshold.value)
    out.push({ metric, threshold, value, holds, limit })
```

`applyTimes`:

```ts
/**
 * Holds back the fires of triggers that used up their `times` in this idle
 * period and counts the rest; uncapped triggers pass and are not counted.
 */
export function applyTimes(fire: readonly Fire[], fired: Readonly<Record<string, number>>): { fire: Fire[]; fired: Record<string, number> } {
  const counts: Record<string, number> = { ...fired }
  const out: Fire[] = []
  for (const f of fire) {
    const cap = f.trigger.times
    if (cap === null) {
      out.push(f)
      continue
    }
    const used = counts[f.trigger.id] ?? 0
    if (used >= cap) continue
    counts[f.trigger.id] = used + 1
    out.push(f)
  }
  return { fire: out, fired: counts }
}
```

`ActionPlan` gains `ping: Fire | null` and `prompt: Fire | null`:

```ts
export function planActions(fire: readonly Fire[]): ActionPlan {
  const by = (a: EdgeAction): Fire[] => fire.filter(f => f.actions.includes(a))
  const prompt = by('prompt')[0] ?? null
  // A prompt's turn warms the cache itself, so a ping beside it is dropped.
  const ping = prompt ? null : (by('ping')[0] ?? null)
  return { notes: by('note'), toasts: by('toast'), notifies: by('notify'), compact: by('compact')[0] ?? null, ping, prompt }
}
```

`liveDenies` needs no change (cache metrics cannot carry `deny`).

- [ ] **Step 4: Run tests** — all PASS. Fix the other `Metrics` literals in tests (`band.test.ts`, `messages.test.ts`) by adding `cache: NO_CACHE` where they build `Metrics` by hand; prefer `metricsOf` where a test already uses it.

- [ ] **Step 5: Commit**

```bash
git add plugins/ctx-guard/hooks/triggers.ts plugins/ctx-guard/hooks/*.test.ts
git commit -m "feat(ctx-guard): cache metrics in triggers, times per idle period, ping and prompt plans"
```

---

### Task 4: Band — the cache segment

**Files:**
- Modify: `plugins/ctx-guard/types/index.d.ts` (`Band.cache`)
- Modify: `plugins/ctx-guard/hooks/band.tsx`
- Test: `plugins/ctx-guard/hooks/band.test.ts`

**Interfaces:**
- Consumes: `BandCache` (Task 2).
- Produces: `Band.cache: BandCache | null`; `bandOf` keeps `prev?.cache ?? null` (the caller sets it, as with `probes`).

- [ ] **Step 1: Failing tests** — in `band.test.ts`, add `cache: null` to `base`, then:

```ts
describe('cache segment', () => {
  test('right after the context figure', () => {
    const b: Band = { ...base, role: 'lead', tokens: 312_000, percent: 31.2, window: 1_000_000, limits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: null }], cache: { text: 'cache 8m', color: null, dim: false } }
    expect(bandText(b)).toBe('lead · 312k (31%) · cache 8m · 5h 42%')
  })
  test('colour and dim carry to the segment', () => {
    const segs = bandSegments({ ...base, cache: { text: 'cache cold', color: null, dim: true } })
    expect(segs).toContainEqual({ text: 'cache cold', dim: true })
    expect(bandSegments({ ...base, cache: { text: 'cache 2m', color: 'warning', dim: false } })).toContainEqual({ text: 'cache 2m', color: 'warning' })
  })
  test('a band stored before the cache segment existed draws', () => {
    const { cache: _drop, ...old } = { ...base, tokens: 1000 }
    expect(bandText(old as Band)).toBe('1k')
  })
  test('a changed countdown is a changed band', () => {
    expect(sameBand({ ...base, cache: { text: 'cache 8m', color: null, dim: false } }, { ...base, cache: { text: 'cache 7m', color: null, dim: false } })).toBe(false)
  })
})
```

Check the exact token formatting `humanTokens(1000)` produces (`1k` or `1.0k`) and adjust the expected text to it.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — `types/index.d.ts` `Band` gains `// The prompt cache countdown as last drawn; null when hidden.\n cache: BandCache | null` after `percent`/`window`. In `band.tsx` `bandSegments`, right after the context push:

```ts
  // A band another version stored may have none.
  const c = b.cache ?? null
  if (c) out.push(c.dim ? { text: c.text, dim: true } : c.color ? { text: c.text, color: c.color } : { text: c.text })
```

`bandOf` returns `cache: prev?.cache ?? null`. Update the doc comment's example line to include `· cache 8m` after the context figure.

- [ ] **Step 4: Run tests** — PASS (fix any `Band` literal in `register.test.ts` that now lacks `cache`).

- [ ] **Step 5: Commit** — `git commit -m "feat(ctx-guard): prompt cache countdown in the band"` (stage `types/index.d.ts`, `hooks/band.tsx`, `hooks/band.test.ts`, touched tests).

---

### Task 5: Messages — cache texts, `{idle}`/`{expiresIn}`, prompt text

**Files:**
- Modify: `plugins/ctx-guard/hooks/messages.ts`
- Test: `plugins/ctx-guard/hooks/messages.test.ts`

**Interfaces:**
- Consumes: `FireVars` cache fields (Task 3).
- Produces: `DEFAULT_PROMPT: string`; `promptText(fire: Fire, ctx: NoteContext): string`; `TEMPLATE_VARS` gains `'idle'`, `'expiresIn'`.

- [ ] **Step 1: Failing tests** — append to `messages.test.ts` (build `FireVars` with the file's existing helper, adding the cache fields):

```ts
describe('cache texts', () => {
  const vars = (over: Partial<FireVars>): FireVars => ({ metric: 'cache.miss', threshold: { kind: 'tokens', value: 50_000 }, tokens: 150_000, percent: 15, window: 1_000_000, limit: null, cost: null, idleMs: 55 * 60_000, now: 0, expiresIn: 4 * 60_000, miss: null, missCause: null, pings: 0, ...over })

  test('toasts', () => {
    expect(toastText(vars({ miss: 140_000, missCause: 'model' }), 'main')).toBe('ctx-guard: main: cache miss, 140k re-written (model switch)')
    expect(toastText(vars({ miss: 140_000, missCause: 'prefix' }), 'main')).toBe('ctx-guard: main: cache miss, 140k re-written (prefix changed: CLAUDE.md, tools or MCP?)')
    expect(toastText(vars({ metric: 'cache.expiresIn', threshold: { kind: 'duration', value: 300_000 } }), 'main')).toBe('ctx-guard: main: prompt cache expires in 4m, idle 55m')
    expect(toastText(vars({ metric: 'cache.pings', threshold: { kind: 'count', value: 3 }, pings: 3 }), null)).toBe('ctx-guard: prompt cache kept warm by 3 pings, expires in 4m')
  })

  test('template variables idle and expiresIn', () => {
    const v = templateVars(vars({}), { role: 'main', handoffPath: '.ctx-guard/main-handoff.md', readyToken: 'CTX-READY' })
    expect([v.idle, v.expiresIn]).toEqual(['55m', '4m'])
    expect(TEMPLATE_VARS).toContain('idle')
    expect(TEMPLATE_VARS).toContain('expiresIn')
  })

  test('the prompt text, default and from the trigger message', () => {
    const f = (message: string | null) => ({ trigger: { id: 'away', message } as never, actions: ['prompt'] as never, step: 0, vars: vars({ metric: 'cache.expiresIn' }) })
    const ctx = { role: 'main', handoffPath: '.ctx-guard/main-handoff.md', readyToken: 'CTX-READY' }
    expect(promptText(f(null), ctx)).toBe('[ctx-guard] The user has been away 55m; the prompt cache expires in 4m. Write the handoff to .ctx-guard/main-handoff.md and stop; do not start new work.')
    expect(promptText(f('Away {idle}. Note it in {handoffPath}.'), ctx)).toBe('Away 55m. Note it in .ctx-guard/main-handoff.md.')
  })

  test('note head for a cache trigger', () => {
    // collapseNotes on one cache.miss fire: the head names the rewrite.
    const text = collapseNotes([{ trigger: { id: 'miss', level: null, message: null } as never, actions: ['note'] as never, step: 0, vars: vars({ miss: 140_000, missCause: 'prefix' }) }], NOTE_OPTS)
    expect(text).toContain('A request rewrote 140k tokens of a prompt cache that should have been warm')
  })
})
```

Use the file's existing `NoteOptions` fixture for `NOTE_OPTS` (look for how other `collapseNotes` tests build it; reuse that constant or copy its literal).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** in `messages.ts`:

```ts
export const TEMPLATE_VARS = ['role', 'tokens', 'percent', 'threshold', 'window', 'limit', 'resetsIn', 'handoffPath', 'readyToken', 'idle', 'expiresIn'] as const

export const DEFAULT_PROMPT =
  `${PREFIX} The user has been away {idle}; the prompt cache expires in {expiresIn}. Write the handoff to {handoffPath} and stop; do not start new work.`
```

`templateVars` adds:

```ts
    idle: vars.idleMs === null ? UNKNOWN : humanDuration(vars.idleMs),
    expiresIn: vars.expiresIn === null ? UNKNOWN : humanDuration(vars.expiresIn),
```

A cause phrase:

```ts
const MISS_CAUSE = { model: 'model switch', prefix: 'prefix changed: CLAUDE.md, tools or MCP?' } as const
const missWhy = (v: FireVars): string => (v.missCause ? ` (${MISS_CAUSE[v.missCause]})` : '')
```

`toastText` gains, before the context fallback:

```ts
  else if (vars.metric === 'cache.miss') what = `cache miss, ${vars.miss === null ? UNKNOWN : humanTokens(vars.miss)} re-written${missWhy(vars)}`
  else if (vars.metric === 'cache.expiresIn') what = `prompt cache expires in ${v.expiresIn}, idle ${v.idle}`
  else if (vars.metric === 'cache.pings') what = `prompt cache kept warm by ${vars.pings ?? 0} pings, expires in ${v.expiresIn}`
```

`head` gains:

```ts
  if (vars.metric === 'cache.miss') {
    return `A request rewrote ${vars.miss === null ? UNKNOWN : humanTokens(vars.miss)} tokens of a prompt cache that should have been warm${missWhy(vars)}.`
  }
  if (vars.metric === 'cache.expiresIn' || vars.metric === 'cache.pings') {
    return `The prompt cache expires in ${v.expiresIn}; the session has been idle for ${v.idle}.`
  }
```

`promptText`:

```ts
/** What a `prompt` action submits: the trigger's message, else the default, with template variables filled. */
export function promptText(fire: Fire, ctx: NoteContext): string {
  return render(fire.trigger.message ?? DEFAULT_PROMPT, templateVars(fire.vars, ctx))
}
```

Check `render` leaves unknown `{x}` untouched (the existing behaviour) — the test only uses known names.

If the config validates `message` placeholders against `TEMPLATE_VARS` anywhere, the new names now pass; grep `TEMPLATE_VARS` to confirm.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(ctx-guard): cache note, toast and prompt texts"` (stage `hooks/messages.ts`, `hooks/messages.test.ts`).

---

### Task 6: Wiring A — cache state, anchor, miss, TTL detection, band countdown

**Files:**
- Modify: `plugins/ctx-guard/types/index.d.ts` (`PluginState['ctx-guard'].cache: CacheState | null`; `Activity.ownTurn: boolean`)
- Modify: `plugins/ctx-guard/hooks/register.tsx`
- Test: `plugins/ctx-guard/hooks/register.test.ts`

**Interfaces:**
- Consumes: everything in `cache.ts`; `metricsOf(..., cache)`; `Band.cache`.
- Produces (module-internal, used by Tasks 7-8):

```ts
const CACHE = { plugin: 'ctx-guard', key: 'cache' } as const
const cacheState = (): CacheState => mem.cache ?? emptyCache()
function setCache($: EngineInterface, fn: (c: CacheState) => CacheState, persist?: boolean): Promise<void>
function cacheTtl(reading: Reading): { ms: number; source: TtlSource }
// Mod gains: transcriptPath: string | null; pinging: boolean; ownPrompt: boolean
```

- [ ] **Step 1: Failing tests** — add to `register.test.ts`. Use the existing `world`, `stepBottom`, `start`, `step`, `turn`, `writeConfig` helpers. Add a variant of `stepBottom` that answers given usage:

```ts
// The step bottom answers each call with the next usage in `usages` (the last one repeats).
function usageBottom(on: On, usages: { read: number; write: number; model?: string }[]): void {
  let i = 0
  on('turn.step', async function* ($, e) {
    const u = usages[Math.min(i++, usages.length - 1)] as { read: number; write: number; model?: string }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as never,
      usage: { input_tokens: 10, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, output_tokens: 50, model: u.model ?? 'm' } }
  })
}

const CACHE_ROLE = (triggers: unknown[], cache: unknown = { ttl: '1h' }) => ({ version: 1, cache, roles: { lead: { triggers } } })

test('the band counts down the prompt cache once idle', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.advance(45 * 60 * 1000)
  expect(bandOfWorld(w)).not.toContain('cache')
  await clock.advance(6 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
  await clock.advance(10 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache cold')
})

test('a rewrite of a warm cache fires a cache.miss toast; a /clear does not', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'miss', when: { 'cache.miss': '50k' }, do: ['toast'] }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 50_000, write: 100_000 }, { read: 150_000, write: 0 }, { read: 10_000, write: 140_000 }, { read: 0, write: 30_000 }])
  await start($)
  await step($, clock)
  await step($, clock)
  expect(w.toasts.filter(t => t.includes('cache miss'))).toEqual([])
  await step($, clock)
  expect(w.toasts.filter(t => t.includes('cache miss'))).toEqual(['ctx-guard: lead: cache miss, 140k re-written (prefix changed: CLAUDE.md, tools or MCP?)'])
  // A /clear as the engine raises it: use the file's existing clear helper if it has one (search `reason: 'clear'`).
  await $.session.end({ reason: 'clear', sessionId: w.sessionId } as never)
  await step($, clock)
  expect(w.toasts.filter(t => t.includes('cache miss')).length).toBe(1)
})

test('the ttl comes from the transcript after the first turn', async ($, on) => {
  const w = newWorld({ limits: [] })
  writeConfig(w, CACHE_ROLE([], {}))
  w.files[TRANSCRIPT] = { text: '{"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":25528,"ephemeral_5m_input_tokens":0}}}}\n', mtimeMs: NOW }
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead', HOME: '/home/u' })
  usageBottom(on, [{ read: 100_000, write: 0 }])
  await start($, 'vscode')
  await turn($, 'start')
  await step($, clock)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT } as never)
  await turn($, 'end')
  await clock.settle()
  // No rate limits would guess five minutes; the transcript says one hour, so 50 min idle is still warm.
  await clock.advance(51 * 60 * 1000)
  expect(bandOfWorld(w)).toContain('cache 8m')
  expect(bandOfWorld(w)).not.toContain('~')
})
```

Define next to them:

```ts
const TRANSCRIPT = '/home/u/.claude/projects/-repo/sid.jsonl'
// The band as the stand-in status line drew it last (tests start with surface 'vscode').
const bandOfWorld = (w: World): string => w.statuses.at(-1) ?? ''
```

and call `await start($, 'vscode')` in these tests instead of `await start($)`, as the file's other band assertions do (`w.statuses.at(-1)`). Use the file's `ROOT` and `w.sessionId` to build `TRANSCRIPT` if they differ from `/repo` and `sid`.

`register.test.ts` lists every `$.state` key in `STATE_KEYS` (and a second list near line 484); add `'cache'` to both.

If the kit's `classic.Stop` stamps `transcript_path` itself, the fixture path must match what it stamps; otherwise derive it as the code does (`HOME`, cwd `/repo` → `-repo`, session id).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Types** — `Activity` gains `// The running main turn is ctx-guard's own prompt: idle keeps counting through it.\n ownTurn: boolean`; `PluginState['ctx-guard']` gains `// The main thread's prompt cache: TTL, anchor, misses and this idle period's pings and fire counts.\n cache: CacheState | null`. `asActivity` reads `ownTurn: o.ownTurn === true`; `emptyMem` gets `cache: null`; `readStored`/`fill` follow the existing per-key pattern (search for `activity` in them and mirror it for `cache` with `asCache`).

- [ ] **Step 4: State helpers** (register.tsx, near `patchActivity`):

```ts
const cacheState = (): CacheState => mem.cache ?? emptyCache()

// Memory on every call; `$.state` only when `persist`, so a step costs no write.
async function setCache($: EngineInterface, fn: (c: CacheState) => CacheState, persist = true): Promise<void> {
  const next = fn(cacheState())
  if (persist) await put($, 'cache', next)
  else setMem(mem, 'cache', next)
}

function cacheTtl(reading: Reading): { ms: number; source: TtlSource } {
  return effectiveTtl(cacheState(), mod.eff?.config.cache ?? DEFAULT_CACHE, reading.rateLimits.length > 0)
}
```

`Mod` gains `transcriptPath: string | null`, `pinging: boolean`, `ownPrompt: boolean`, all `null`/`false` in `fresh()`.

- [ ] **Step 5: Metrics** — `metricsFor` passes the cache figures:

```ts
async function metricsFor($: EngineInterface, reading: Reading, now: number): Promise<Metrics> {
  const a = activity()
  const running = a.mainTurnAt !== null && now - a.mainTurnAt < STALE_TURN_MS
  // ctx-guard's own prompt turn keeps the idle clock running: it is not the operator back.
  const busy = running && !a.ownTurn
  const idle = idleMs(a.lastMainEndAt, busy, now)
  const window = windowFor(reading.context.window).tokens
  const c = cacheState()
  const ttl = cacheTtl(reading)
  const cache: CacheMetrics = { expiresIn: expiresInMs(c, ttl.ms, running, now), miss: c.miss, missCause: c.missCause, pings: c.pings }
  return metricsOf({ tokens: reading.context.tokens, rateLimits: reading.rateLimits, cost: reading.cost }, window, idle, now, cache)
}
```

`evaluateNow` applies `times` and stores the counts before acting:

```ts
  const ev = evaluate(triggers, metrics, prev, role)
  // Counted before acting, like the marks, so a failed action never fires twice.
  const capped = applyTimes(ev.fire, cacheState().fired)
  if (JSON.stringify(capped.fired) !== JSON.stringify(cacheState().fired)) await setCache($, c => ({ ...c, fired: capped.fired }))
  ...
  await act($, planActions(capped.fire), isPaused, metrics)
```

(`act` gains a `metrics` parameter in Task 8; pass it now and ignore it until then.)

- [ ] **Step 6: Band** — `setBand` adds the segment:

```ts
  const band: Band = { ...bandOf(mod.role.role, metrics, denies, prev), subagentsOver: subagentsOver(), probes: probeSegments(), untrusted: bandUntrusted(), cache: cacheBand(metrics) }
```

```ts
function cacheBand(m: Metrics): BandCache | null {
  const cfg = mod.eff?.config.cache ?? DEFAULT_CACHE
  const c = cacheState()
  const ttl = effectiveTtl(c, cfg, m.limits.five_hour !== null || m.limits.seven_day !== null)
  const a = activity()
  const running = a.mainTurnAt !== null && m.now - a.mainTurnAt < STALE_TURN_MS
  const pinger = roleTriggers().find(t => t.do.includes('ping'))
  return cacheSegment({ expiresIn: m.cache.expiresIn, ttl: ttl.ms, guessed: ttl.source === 'guess', busy: running, cold: c.cold, show: cfg.band.show, warn: cfg.band.warn, pings: c.pings, cap: pinger?.times ?? null })
}
```

The idle tick in `syncActive` changes from `evaluateCurrent($, 'never')` to `evaluateCurrent($, 'changed')`, with the comment `// 'changed': the cache countdown moves each minute; an unchanged band is not written.`

- [ ] **Step 7: Main requests** — in the `turn.step` hook's main branch, after `const tokens = stepTokens(r.usage)` and only when `r.usage` is present:

```ts
        const usage = r.usage
        $.clock.after(0, () => void serial(() => timed($, () => onCacheRequest($, usage))))
```

```ts
// A main request: miss, anchor, observed TTL. A miss (or one clearing) is evaluated at once.
async function onCacheRequest($: EngineInterface, usage: TurnUsage): Promise<void> {
  if (!active()) return
  const now = await $.clock.now()
  const reading = await currentReading($)
  const before = cacheState().miss
  await setCache($, c => onMainRequest(c, usage, cacheTtl(reading).ms, now), false)
  if (cacheState().miss > 0 || before > 0) await evaluateNow($, reading, 'changed')
}
```

Import `TurnUsage` from `claude-code` if the type is exported there; otherwise type the parameter as `CacheUsage` from `cache.ts`.

- [ ] **Step 8: Start-overs and periods**
  - `onClear`: `await setCache($, c => newPeriod(startOver({ ...c, transcriptTried: false })))`.
  - `onMeasure`: where `startedOver` is computed, `if (startedOver) await setCache($, startOver)`.
  - session start (`start()` after hydration, where activity is restored): `await setCache($, newPeriod)`.
  - `onMainTurnEnd`: persist the cache (`await setCache($, c => c)`) so a reload keeps the anchor; the period logic lands in Task 7.

- [ ] **Step 9: TTL from the transcript** — the `classic.Stop` hook stores `mod.transcriptPath = typeof e.transcript_path === 'string' ? e.transcript_path : mod.transcriptPath`. After `onMainTurnEnd` in `turn.complete` (main), call `await quietly(() => detectTtl($))`:

```ts
// The transcript's newest cache write tells the TTL. Read once, early, while the file is small.
async function detectTtl($: EngineInterface): Promise<void> {
  const c = cacheState()
  if (c.transcriptTried || c.ttlSource === 'transcript' || mod.eff?.config.cache.ttl !== 'auto') return
  await setCache($, x => ({ ...x, transcriptTried: true }))
  const path = mod.transcriptPath ?? (await transcriptPathOf($))
  if (!path) return
  const text = await $.fs.read(path)
  const ttl = typeof text === 'string' ? ttlFromTranscript(text) : null
  if (ttl !== null) await setCache($, x => withTtl(x, ttl, 'transcript'))
}

// classic.* hooks may not run (an organization's managed settings), so the path is also derived.
async function transcriptPathOf($: EngineInterface): Promise<string | null> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ((await $.env.get('HOME')) ? `${await $.env.get('HOME')}/.claude` : null)
  if (!dir) return null
  const cwd = await $.session.cwd()
  return `${dir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${await $.session.id()}.jsonl`
}
```

A rejected read (over 4 MiB, denied) throws inside `quietly`; `transcriptTried` is already true, so it is not retried.

- [ ] **Step 10: Run tests** — PASS, including all existing ones (the idle-tick redraw change may add band writes some tests count; update those counts with a comment explaining the countdown redraw).

- [ ] **Step 11: Commit** — `git commit -m "feat(ctx-guard): track the main prompt cache: anchor, misses, ttl, band countdown"`.

---

### Task 7: Wiring B — idle periods and ctx-guard's own turns

**Files:**
- Modify: `plugins/ctx-guard/hooks/register.tsx`
- Test: `plugins/ctx-guard/hooks/register.test.ts`

**Interfaces:**
- Consumes: `Mod.ownPrompt`, `Activity.ownTurn`, `newPeriod`.
- Produces: a `prompt.submit` hook; `onMainTurnStart`/`onMainTurnEnd` honour own turns.

- [ ] **Step 1: Failing tests**

```ts
test('ctx-guard\'s own prompt turn neither starts an idle period nor re-arms idle triggers', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'idle', when: { idle: '5m' }, do: ['notify'] }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(1)
  // ctx-guard's own prompt, then its turn.
  await $.prompt.submit({ text: '[ctx-guard] x', origin: { kind: 'plugin', name: 'ctx-guard' } } as never)
  await turn($, 'start')
  await clock.advance(60 * 1000)
  await turn($, 'end')
  await clock.advance(60 * 1000)
  expect(w.notifies.length).toBe(1)
})

test('the operator\'s turn starts a new idle period: times counts start over', async ($, on) => {
  const w = newWorld()
  writeConfig(w, CACHE_ROLE([{ id: 'idle', when: { idle: '5m' }, do: ['notify'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  await start($)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(6 * 60 * 1000)
  expect(w.notifies.length).toBe(2)
})
```

The kit's `$.prompt.submit` needs a bottom: add `on('prompt.submit', ($, e) => ({ text: e.text }))` to `world()` if it lacks one (check whether `mock.session` answers it first).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```ts
  // Who sent the next prompt: ctx-guard's own `prompt` action, or anyone else.
  on('prompt.submit', async ($, e, next) => {
    mod.ownPrompt = e.origin?.kind === 'plugin' && e.origin.name === 'ctx-guard'
    return next(e)
  })
```

`turn.start` hook: pass whether the turn is the main one: `await quietly(() => onMainTurnStart($, e.agentId === undefined))`.

```ts
async function onMainTurnStart($: EngineInterface, main: boolean): Promise<void> {
  const now = await $.clock.now()
  const own = main && mod.ownPrompt
  if (main) mod.ownPrompt = false
  await patchActivity($, a => ({ ...a, mainTurnAt: now, ownTurn: own }))
}

async function onMainTurnEnd($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const own = activity().ownTurn
  // ctx-guard's own prompt turn is not the operator back: idle and the period go on.
  await patchActivity($, a => ({ ...a, mainTurnAt: null, ownTurn: false, ...(own ? {} : { lastMainEndAt: now }) }))
  await setCache($, c => (own ? c : newPeriod(c)))
}
```

If `turn.start` today runs `onMainTurnStart` for subagent turns as well, keep that behaviour for `mainTurnAt` exactly as it is (only `ownTurn` depends on `main`); read the hook before changing it.

- [ ] **Step 4: Run tests** — PASS (Review Focus 1).

- [ ] **Step 5: Commit** — `git commit -m "feat(ctx-guard): idle periods; ctx-guard's own prompt turns do not reset idle"`.

---

### Task 8: Wiring C — `ping` and `prompt` actions

**Files:**
- Modify: `plugins/ctx-guard/hooks/register.tsx` (`act`, `requestCompact`, idle tick)
- Test: `plugins/ctx-guard/hooks/register.test.ts`

**Interfaces:**
- Consumes: `planActions` `ping`/`prompt`; `pingVerdict`, `onPing`; `promptText`; `compactGate`; `trusted()`.
- Produces: `runPing`, `runPrompt`, a retry slot `mod.retry: { kind: 'ping' | 'prompt'; fire: Fire; tries: number } | null`.

- [ ] **Step 1: Failing tests** — the full example from the spec, plus failure paths:

```ts
const KEEP_WARM = CACHE_ROLE([
  { id: 'warm', when: { 'cache.expiresIn': '5m', context: '50k' }, do: ['ping'], times: 3 },
  { id: 'away', when: { 'cache.expiresIn': '5m', 'cache.pings': 3 }, do: ['prompt', 'notify'], times: 1 },
])

function forkBottom(on: On, answers: () => { read: number; write: number } | 'error', calls: string[]): void {
  on('model.fork', ($, e) => {
    calls.push(e.prompt)
    const a = answers()
    if (a === 'error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: undefined } } as never
    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } } as never
  })
}

async function trustedKeepWarm($: Engine, on: On, w: World): Promise<{ clock: MockClock; forks: string[]; prompts: string[] }> {
  writeConfig(w, KEEP_WARM)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 150_000, write: 0 }])
  const forks: string[] = []
  const prompts: string[] = []
  forkBottom(on, () => ({ read: 150_000, write: 0 }), forks)
  on('prompt.submit', ($, e) => (prompts.push(e.text), { text: e.text }))
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  return { clock, forks, prompts }
}

test('keep-warm: three pings, then one prompt and a notify, then nothing', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  const { clock, forks, prompts } = await trustedKeepWarm($, on, w)
  await clock.advance(55 * 60 * 1000)
  expect(forks).toEqual(['Reply with OK.'])
  await clock.advance(55 * 60 * 1000)
  await clock.advance(55 * 60 * 1000)
  expect(forks.length).toBe(3)
  expect(prompts).toEqual([])
  await clock.advance(55 * 60 * 1000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Write the handoff to .ctx-guard/lead-handoff.md')
  // The notify is about the trigger's first metric, cache.expiresIn.
  expect(w.notifies.some(n => n.includes('prompt cache expires in'))).toBe(true)
  await clock.advance(3 * 60 * 60 * 1000)
  expect([forks.length, prompts.length]).toEqual([3, 1])
})

test('keep-warm: a cold ping stops the series for the period', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  writeConfig(w, KEEP_WARM)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 150_000, write: 0 }])
  const forks: string[] = []
  forkBottom(on, () => ({ read: 10_000, write: 140_000 }), forks)
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.advance(4 * 60 * 60 * 1000)
  expect(forks.length).toBe(1)
})

test('keep-warm: a failed ping is retried on the next tick, not fired again', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  writeConfig(w, KEEP_WARM)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 150_000, write: 0 }])
  const forks: string[] = []
  let n = 0
  forkBottom(on, () => (n++ === 0 ? 'error' : { read: 150_000, write: 0 }), forks)
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.advance(55 * 60 * 1000)
  expect(forks.length).toBe(1)
  await clock.advance(60 * 1000)
  expect(forks.length).toBe(2)
  // The retry was warm: the next ping comes a full TTL later, and only two fires of `warm` remain.
  await clock.advance(2 * 55 * 60 * 1000)
  expect(forks.length).toBe(4)
})

test('keep-warm: nothing is sent without trust', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  writeConfig(w, KEEP_WARM)
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  usageBottom(on, [{ read: 150_000, write: 0 }])
  const forks: string[] = []
  forkBottom(on, () => ({ read: 150_000, write: 0 }), forks)
  await start($)
  await turn($, 'start')
  await step($, clock)
  await turn($, 'end')
  await clock.advance(4 * 60 * 60 * 1000)
  expect(forks).toEqual([])
})

test('keep-warm: no ping while a usage window is at maxUsage', async ($, on) => {
  const w = newWorld({ tokens: 150_000, limits: [{ kind: 'five_hour', percentUsed: 92 }] })
  const { clock, forks } = await trustedKeepWarm($, on, w)
  await clock.advance(55 * 60 * 1000)
  expect(forks).toEqual([])
})

test('prompt then compact: /compact runs at the prompt turn\'s end', async ($, on) => {
  const w = newWorld({ tokens: 150_000 })
  writeConfig(w, CACHE_ROLE([{ id: 'away', when: { idle: '50m' }, do: ['prompt', 'compact'], times: 1 }]))
  const { clock } = world(on, w, { CTX_GUARD_ROLE: 'lead' })
  const prompts: string[] = []
  on('prompt.submit', ($, e) => (prompts.push(e.text), { text: e.text }))
  await start($)
  await ctxGuard($, 'trust')
  await turn($, 'start')
  await turn($, 'end')
  await clock.advance(51 * 60 * 1000)
  expect(prompts.length).toBe(1)
  expect(w.ran.filter(r => r.startsWith('compact'))).toEqual([])
  await turn($, 'start')
  await turn($, 'end')
  await clock.settle()
  expect(w.ran.filter(r => r.startsWith('compact')).length).toBe(1)
})
```

Adjust the `limits` literal and the `w.ran` format to the `World` type (`ran` holds `name args`). If `idle` alone with `prompt` should be allowed (it is: only `ping` needs `cache.expiresIn`), the last test stands as written.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — `act(…, metrics)` gains, after notifies and before compact:

```ts
  const gate = compactGateNow(isPaused)
  if (role !== null && spec && (plan.ping || plan.prompt)) {
    if (gate) await noticeOnce($, `auto-skip:${gate.code}`, `ctx-guard: ping and prompt actions skipped: ${gate.text}.`)
    else if (plan.prompt) await runPrompt($, plan.prompt, role, spec, 1)
    else if (plan.ping) await runPing($, plan.ping, metrics, 1)
  }
  if (plan.compact && role !== null && spec) await quietly(() => requestCompact($, plan.compact as Fire, role, isPaused, plan.prompt !== null))
```

`requestCompact` gains `afterTurn = false`; when true it queues but does not call `scheduleCompact` (the prompt's turn end runs `compactAtTurnEnd`):

```ts
  if (!afterTurn && !(await turnRunning($, now))) scheduleCompact($)
```

Ping:

```ts
const PING_PROMPT = 'Reply with OK.'
const PING_TIMEOUT_MS = 2 * 60 * 1000
const MAX_TRIES = 3

// A fork over the main thread's own prefix: the model never sees it, and a warm read keeps the cache alive.
async function runPing($: EngineInterface, fire: Fire, m: Metrics, tries: number): Promise<void> {
  const cfg = mod.eff?.config.cache ?? DEFAULT_CACHE
  const usage = Math.max(m.limits.five_hour?.pct ?? 0, m.limits.seven_day?.pct ?? 0)
  const c = cacheState()
  if (mod.pinging || c.cold || (m.cache.expiresIn ?? 0) <= 0 || usage >= cfg.ping.maxUsage || (await turnRunning($, m.now))) return
  mod.pinging = true
  try {
    const timeout = new Promise<null>(resolve => $.clock.after(PING_TIMEOUT_MS, () => resolve(null)))
    const r = await Promise.race([$.model.fork({ prompt: PING_PROMPT }), timeout])
    if (!r || !r.isAnswered) {
      mod.retry = tries < MAX_TRIES ? { kind: 'ping', fire, tries: tries + 1 } : null
      $.ui.log(`ctx-guard: ping failed (${r ? r.reason : 'timeout'})`, { to: 'debug' })
      return
    }
    mod.retry = null
    const now = await $.clock.now()
    await setCache($, x => onPing(x, pingVerdict(r.usage), now))
    $.ui.log(`ctx-guard: ping read ${r.usage?.cache_read_input_tokens ?? 0}, wrote ${r.usage?.cache_creation_input_tokens ?? 0}`, { to: 'debug' })
  } finally {
    mod.pinging = false
  }
}
```

Check `$.ui.log`'s options shape in the types (`@param options \`to\``) and the `ModelForkResult` field names (`reason`, `usage`) against `.claude-plugin/types/claude-code/index.d.ts` before writing.

Prompt:

```ts
// A real turn: the model reads the text and answers; its turn warms the cache too.
async function runPrompt($: EngineInterface, fire: Fire, role: string, spec: RoleSpec, tries: number): Promise<void> {
  const text = promptText(fire, { role, handoffPath: handoffPathFor(spec, role), readyToken: mod.eff?.config.readyToken ?? '' })
  try {
    await $.prompt.submit({ text })
    mod.retry = null
  } catch {
    mod.retry = tries < MAX_TRIES ? { kind: 'prompt', fire, tries: tries + 1 } : null
  }
}
```

If `$.prompt.submit` resolves with `{ drop }` or `{ deny }` rather than throwing when a hook refuses it, treat that shape as a failure as well (read `PromptSubmitResult` in the types).

Retries: `Mod` gains `retry: { kind: 'ping' | 'prompt'; fire: Fire; tries: number } | null` (`null` in `fresh()`). The idle tick runs it before evaluating:

```ts
    mod.timers.push($.clock.every(IDLE_TICK_MS, () => void serial(() => timed($, async () => {
      await retryAuto($)
      await evaluateCurrent($, 'changed')
    }))))
```

```ts
// A failed ping or prompt is tried again while its trigger still holds; the trigger does not fire again for it.
async function retryAuto($: EngineInterface): Promise<void> {
  const r = mod.retry
  const role = mod.role.role
  const spec = role === null || !mod.eff ? null : roleSpec(mod.eff.config, role)
  if (!r || !active() || role === null || !spec) return
  const now = await $.clock.now()
  const m = await metricsFor($, await currentReading($), now)
  if (compactGateNow(paused(now)) || triggerHolds(r.fire.trigger, m) !== true) {
    mod.retry = null
    return
  }
  if (r.kind === 'ping') await runPing($, r.fire, m, r.tries)
  else await runPrompt($, r.fire, role, spec, r.tries)
}
```

`trustWanted()` already follows `wantsTrust` (Task 1), so the band shows `untrusted` for a keep-warm config without approval.

- [ ] **Step 4: Run tests** — PASS (Review Focus 2).

- [ ] **Step 5: Commit** — `git commit -m "feat(ctx-guard): ping and prompt actions for keeping the prompt cache warm"`.

---

### Task 9: Presets — `cache-miss` toast

**Files:**
- Modify: `plugins/ctx-guard/hooks/config.ts` (`DEFAULT_TRIGGERS_RAW`)
- Modify: `plugins/ctx-guard/skills/guide/assets/presets/solo.json`, `peers.json`
- Modify: `plugins/ctx-guard/hooks/register.test.ts` (`PRESET_TEXT`)
- Test: `plugins/ctx-guard/hooks/config.test.ts`

- [ ] **Step 1: Failing test** — in `config.test.ts`:

```ts
test('the built-in ladder toasts a cache miss', () => {
  const t = defaultTriggers().find(x => x.id === 'cache-miss')
  expect(t?.when['cache.miss']).toEqual({ kind: 'tokens', value: 50_000 })
  expect(t?.do).toEqual(['toast'])
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**
  - `DEFAULT_TRIGGERS_RAW` appends `{ id: 'cache-miss', when: { 'cache.miss': '50k' }, do: ['toast'] },` with the comment `// A rewrite of a cache that should have been warm costs a full prefix: say so.`
  - `solo.json`: append to `roles.main.triggers`, keeping the one-line style:
    `{ "id": "cache-miss", "when": { "cache.miss": "50k" }, "do": ["toast"] }`
  - `peers.json`: append the same line to `defaults.triggers`.
  - `register.test.ts` `PRESET_TEXT`: update `solo` and `peers` to the new file contents byte for byte. Generate the escaped strings with `python3 -c "import json;print(json.dumps(open('plugins/ctx-guard/skills/guide/assets/presets/solo.json').read()))"` (and the same for `peers.json`) and paste the output.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(ctx-guard): built-in ladder and presets toast a prompt cache miss"`.

---

### Task 10: Docs

**Files:**
- Modify: `plugins/ctx-guard/skills/guide/references/config-reference.md`
- Modify: `plugins/ctx-guard/skills/guide/SKILL.md`
- Modify: `plugins/ctx-guard/README.md`
- Modify: `plugins/ctx-guard/docs/comparison.md`, `plugins/ctx-guard/docs/use-cases.md`
- Modify: `plugins/ctx-guard/CHANGELOG.md`

Follow the writing-clearly-and-concisely skill. State what the feature does; no comparison with design alternatives.

- [ ] **Step 1: `config-reference.md`**
  - **Top-level keys** table: add `cache` with a pointer to a new `## Prompt cache` section.
  - **Quantities**: add `count` (a whole number, `3`).
  - **Metrics** table: add the three rows (unit, meaning; `cache.expiresIn` holds at or below its threshold).
  - **Actions** table: add `ping` (rising edge; fork over the main prefix; needs trust, `autoActions`, `times`, and `cache.expiresIn`) and `prompt` (rising edge; submits a real turn; needs trust, `autoActions`, `times`).
  - Trigger keys: `times`.
  - **Built-in ladder**: the `cache-miss` row.
  - **Notes and template variables**: `{idle}`, `{expiresIn}`.
  - New `## Prompt cache` section: the `cache` block table (from the spec's Configuration section), TTL detection order, anchor and idle period, the band segment, `cache.miss` rules, ping and prompt behaviour, the keep-warm example from the spec, and the cost note (a ping reads the whole prefix at the cache-read rate; a rewrite costs the cache-write rate).
  - Replace the existing `idle-cache` example's explanation if the new section supersedes it; keep the example if it still reads right.
  - Update **Contents**.

- [ ] **Step 2: `SKILL.md`** — under the `[ctx-guard]` protocol, add how to answer a ctx-guard prompt turn: it says the user is away; write the handoff to the named path, stop, start no new work, do not call tools beyond writing the handoff.

- [ ] **Step 3: `README.md`** — replace the "No prompt-cache keep-warm" limitation with a feature bullet (countdown, miss toast, opt-in keep-warm with `ping`/`prompt`, capped by `times`, needs trust). Keep the version badge untouched (it moves at release).

- [ ] **Step 4: `docs/comparison.md`** — ctx-guard's "Prompt-cache help" cell becomes ●; its notes paragraph names the countdown, misses and keep-warm; the "Where other tools do better" keep-warm bullet goes (ctx-guard covers it).

- [ ] **Step 5: `docs/use-cases.md`** — section 8 (usage brake) keeps working; add a new section "Stepped away" with the keep-warm example and one paragraph on what happens over four hours (three pings, then a handoff prompt, then the cache expires).

- [ ] **Step 6: `CHANGELOG.md`** — under `[Unreleased]` → `### Added`: cache countdown in the band; `cache.expiresIn`, `cache.miss`, `cache.pings` metrics; `ping` and `prompt` actions; `times`; `cache` config block; `cache-miss` toast in the built-in ladder and presets; `{idle}` and `{expiresIn}` template variables.

- [ ] **Step 7: Verify**

```bash
claude plugin validate plugins/ctx-guard
claude plugin test plugins/ctx-guard
tsc -p plugins/ctx-guard
```

Expected: validate passes (warnings as before), all tests pass, no type errors.

- [ ] **Step 8: Commit** — `git commit -m "docs(ctx-guard): prompt cache countdown, misses and keep-warm"`.
