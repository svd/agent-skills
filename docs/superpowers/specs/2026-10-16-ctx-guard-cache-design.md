# ctx-guard: prompt-cache countdown, miss alerts and keep-warm — design

Date: 2026-10-16 · Plugin: `plugins/ctx-guard` (0.2.0 released; this lands in `[Unreleased]`)

## Goal

Give ctx-guard real prompt-cache help, built on the trigger model it already has:

1. Show the time left before the main thread's prompt cache expires, in the band.
2. Warn when a request rewrote a cache that should have been warm.
3. Keep the cache warm while the operator is away, for a bounded number of pings, and then
   optionally have the model write a handoff (or compact).

Today ctx-guard only offers an `idle` trigger that can notify; it sends nothing to keep the cache
alive (`README.md` "No prompt-cache keep-warm", `docs/comparison.md`).

## Decisions (agreed with the operator)

- Cache help is expressed as new metrics and actions in the existing trigger model, plus a
  `cache` config block for the TTL, the band segment and ping limits.
- Duration metrics follow the `resetsIn` naming: the time left is `cache.expiresIn`.
- Keep-warm is sequenced by a counter metric, `cache.pings`, and a per-trigger `times` cap.
- The band countdown's default threshold is a share of the TTL: `show: "17%"` (10 min at 1h,
  ~50 s at 5m). A duration or `"always"` overrides it; `false` turns it off.
- Keep-warm is off by default. Presets get only the band countdown and a `cache.miss` toast.

## Prior art (read from source, 2026-10-16)

| Tool | Keep-warm | TTL | Guards |
|---|---|---|---|
| cablate/ctx-handoff-mod | `$.model.fork("reply OK")`, invisible | assumes 1h, pings at 55 min | 3 pings, then an "away" handoff; ≥30k tokens |
| Amel-DZRV/claude-code-auto-handoff | `$.model.fork("Reply: warm")`, opt-in | manual, pings 10 min early | stops when a ping finds the cache cold (`read > 0 && creation < 10 % of read`) |
| yujiachen-y/cache-keepalive | Stop hook blocks → visible turn | 5m | 7 loops |
| claude-thermos | proxy resends body with `max_tokens=1` | 5m | 2 cycles |
| ccstatusline | countdown from last assistant row | manual | — |
| claude-hud | reads `prompt_cache.ttl/expires_at` from status-line stdin | real | — |

The real TTL reaches status lines but not mods. Transcript rows carry
`usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` (verified in a
local transcript); no tool above reads them.

## Engine facts this design relies on

From `.claude-plugin/types/claude-code/index.d.ts`:

- `$.session.append` writes a transcript row only; the model reads it with the next request. A
  note sent while idle is therefore useless for keep-warm.
- `$.prompt.submit({ text })` starts a real turn once the session is idle.
- `$.model.fork({ prompt })` runs one tool-less completion over the session's own transcript —
  same prefix, nothing appended, not a turn. Returns `{ isAnswered, usage, reason }`.
- `$.fs.read(path)` reads text, rejects over 4 MiB. `classic.*` events carry `transcript_path`,
  but `classic.*` hooks do not run in a plugin the person installs where an organization manages
  Claude Code (`claude plugin validate` warns about it), so nothing here depends on them.
- `ModelUsage` has only `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` — no TTL split. `TurnUsage` adds `model`.
- A plugin's `$.prompt.submit` reaches the `prompt.submit` hooks with
  `origin: { kind: 'plugin', name }`; `turn.start` carries no origin.

## Configuration

```json
{
  "cache": {
    "ttl": "auto",
    "band": { "show": "17%", "warn": "3m" },
    "ping": { "maxUsage": 90 }
  },
  "roles": {
    "main": {
      "triggers": [
        { "id": "warm", "when": { "cache.expiresIn": "5m", "context": "50k" }, "do": ["ping"], "times": 3 },
        { "id": "away", "when": { "cache.expiresIn": "5m", "cache.pings": 3 }, "do": ["prompt", "notify"], "times": 1 },
        { "id": "miss", "when": { "cache.miss": "50k" }, "do": ["toast"] }
      ]
    }
  }
}
```

### `cache` block (top level, layered like other keys)

| Key | Values | Default | Meaning |
|---|---|---|---|
| `ttl` | `"auto"`, `"5m"`, `"1h"` | `"auto"` | An explicit value overrides detection. |
| `band.show` | duration, percent of TTL, `"always"`, `false` | `"17%"` | Show the countdown when idle and `cache.expiresIn ≤ show`. |
| `band.warn` | duration or percent | `"3m"` | Below this the segment takes the warning colour. |
| `ping.maxUsage` | percent | `90` | No ping while any usage window is at or above this. |

### New metrics

| Metric | Unit | Value |
|---|---|---|
| `cache.expiresIn` | duration | `anchor + ttl − 30 s − now`; `0` once expired; `null` before the first main request or after `/clear` until the next one. While a main turn runs, it is the full TTL (the cache is in use). |
| `cache.miss` | tokens | Per main request: `max(0, previous fill − cache_read)` when the cache was expected warm; `0` otherwise. |
| `cache.pings` | count | Successful pings in the current idle period. |

Thresholds are `≥` for `cache.miss` and `cache.pings`, as for every other metric.
`cache.expiresIn` is a countdown: it holds when the value is at or **below** the threshold, the
only metric that does. None of the three is steppable with `every`.

### New actions

`ping` and `prompt` join `note | toast | notify | compact` as edge actions.

### `times`

`times: N` (integer ≥ 1) on any trigger: at most N fires per idle period. Without it, behaviour is
unchanged. With `every`, each step counts as one fire. Every fire counts, whether or not its
actions succeed. An exhausted trigger keeps its marks re-arming normally but does not act.

### Validation

- `ping` requires `cache.expiresIn` in the same `when` (no pinging on a context threshold).
- `times` must be an integer ≥ 1.
- A trigger with `ping` or `prompt` requires `times`, so automatic spending always has a cap.
- `deny` with any `cache.*` metric is rejected, as `deny` with `idle` is today.
- Unknown keys in `cache` are reported like any other unknown key.

## TTL detection (`ttl: "auto"`)

Sources, strongest first; the first that answers wins, and a stronger one replaces a weaker one
later:

1. **Transcript.** After a main turn ends, if the TTL is not yet known from the transcript, read
   the session's transcript with `$.fs.read`. Its path is
   `~/.claude/projects/<cwd with every non-alphanumeric character as "-">/<session id>.jsonl`
   (`$.session.id()`, the session's cwd). Take the newest assistant row with
   `usage.cache_creation`, and read `ephemeral_1h_input_tokens > 0` → `1h`,
   `ephemeral_5m_input_tokens > 0` → `5m`. Read early, while the file is small. On rejection
   (over 4 MiB, denied, bad JSON) do not retry until a new session or `/clear`.
2. **Observation.** A main request after a gap of more than 5 min since the anchor with
   `cache_read` covering most of the previous fill proves `1h`.
3. **Heuristic.** `rateLimits` present (a subscription) → `1h`, else `5m`.

The source is kept in state (`ttlSource: 'config' | 'transcript' | 'observed' | 'guess'`). A
guessed TTL shows as `~` in the band.

## Anchor and idle period

- **Anchor**: the time of the latest main-thread request (`turn.step` of the main agent) or of the
  latest warm ping. Subagent requests do not move it: their prefix differs. 30 s are taken off
  the TTL because the exact cache-write moment is unknown.
- **Idle period**: starts when a main turn ends, except a turn started by `prompt`; also at
  session start and after `/clear`. Turns after a ctx-guard resume are real work and start a
  period. A new period resets `cache.pings`, every `times` counter and the `cold` flag.
- A `prompt` turn moves the anchor but not the period, and not `idle` either: `idle` keeps
  counting from the operator's last turn, also while the `prompt` turn runs, so idle triggers do
  not re-arm and fire again.
- State lives in `$.state` so a module reload keeps it.

## Band segment

- Placed right after the context percent: `ctx 42% · cache 8m`.
- Shown only while idle and `cache.expiresIn ≤ show`. Minutes, `<1m` in the last minute.
- Normal colour above `warn`, warning colour below, dim `cache cold` once expired (until the next
  turn). `~` prefix while the TTL is guessed (`cache ~8m`).
- With pings in the period: `cache 8m · ping 2/3` (the cap from the trigger that pings).
- `sameBand` compares the segment, so the countdown redraws. The 60 s idle tick redraws the
  band with `'changed'`: it is written only when a segment's text changed.

## `cache.miss`

- Checked on each main request whose anchor said the cache was warm (`cache.expiresIn > 0` at the
  request).
- Noise floor 2k tokens: smaller values count as `0`.
- Not counted until the session has had one warm main request (`cache_read` covering at least
  90 % of the previous fill), and again after `/clear`, `/compact` or a resume. The first requests
  of a session rewrite part of the prefix as a matter of course: in the spike the second main
  request read 13.6k and wrote 22.7k of a 36k prefix.
- A model switch (`usage.model` differs from the previous main request's) is counted — a real,
  costly rewrite — and named as the cause in the text. Otherwise the text suggests
  `prefix changed: CLAUDE.md, tools or MCP?`.
- The value belongs to one request: a trigger fires on a request with `miss ≥` threshold and
  re-arms on the next request without a miss.
- Toast and note text: `ctx-guard: main: cache miss, 140k re-written (model switch)`.

## `ping`

- `$.model.fork({ prompt: "Reply with OK." })` raced against a 2-minute timeout. The reply is
  discarded; usage goes to `$.ui.log` at debug.
- Skipped when a main turn runs, ctx-guard is paused, there is no role, `cache.expiresIn ≤ 0`, the
  period is marked `cold`, or any usage window is at or above `ping.maxUsage`.
- One ping in flight at a time (runs inside `serial`).
- Result:
  - **warm** (`cache_read > 0` and `cache_creation < 10 % of cache_read`): `cache.pings += 1`,
    the anchor moves to now;
  - **cold**: mark the period `cold`, stop pinging until the next period; band shows
    `cache cold`;
  - **error** (`nothing-to-fork`, `api-error`, `empty-reply`, `aborted`, timeout): not counted
    in `cache.pings`, anchor unchanged. The ping is retried on each idle tick while
    `cache.expiresIn > 0`; the trigger itself does not fire again for it.

## `prompt`

- `$.prompt.submit({ text })`, text from the trigger's `message` with the usual template
  variables plus `{idle}` and `{expiresIn}`. Default:
  `[ctx-guard] The user has been away {idle}; the prompt cache expires in {expiresIn}. Write the handoff to {handoffPath} and stop; do not start new work.`
- ctx-guard's `prompt.submit` hook sees its own prompt with
  `origin: { kind: 'plugin', name: 'ctx-guard' }` and flags the next main `turn.start` as
  ctx-guard's. Any other origin clears the flag.
- With `compact` in the same fire: the prompt first, then `/compact` at that turn's end through
  the existing `compactAtTurnEnd` path.
- With `ping` in the same tick: only `prompt` runs; its turn warms the cache.
- Rejected (`deny` from another plugin, a thrown error): retried on each idle tick while the
  trigger's condition still holds, at most three tries; the trigger itself does not fire again
  for it.

## Trust

`ping` and `prompt` act on their own and spend money and limits, so they behave like `compact`:
they need `/ctx-guard trust` for the repo and `autoActions` on. Without either, the fire runs
only its non-automatic actions (`note`, `toast`, `notify`) and the band shows `untrusted`, as it
does for `compact` today. Check that `trustMaterial` covers the new actions and `message`.

## Errors

Hooks never throw; every `$` call goes through `quietly`. Failure paths are listed per feature
above. A failed transcript read falls back to observation and the heuristic.

## Code layout

- New pure module `hooks/cache.ts` (no `$`):
  `resolveTtl`, `expiresIn`, `missOf`, `pingVerdict`, `cacheSegment`.
- `hooks/triggers.ts`: the three metrics, `times`, idle-period counters, `ping`/`prompt` in
  `planActions` (prompt wins over ping; prompt then compact).
- `hooks/config.ts`: `cache` block, new actions, `times`, validation.
- `hooks/band.tsx`: the segment; `sameBand` includes it.
- `hooks/messages.ts`: miss text, default prompt text, `{idle}`/`{expiresIn}`.
- `hooks/register.tsx`: wiring only — fork, submit, own-prompt flag in `prompt.submit`,
  transcript read, anchor and model in `turn.step`, idle-tick redraw.
- `types/index.d.ts`: `PluginState.cache: { ttl, ttlSource, anchor, pings, epoch, cold, times }`.
- `skills/guide/assets/ctx-guard.schema.json`: the new keys.
- Presets: band countdown on, `miss` toast trigger. Update `PRESET_TEXT` in `register.test.ts`
  byte for byte.

## Tests

- `cache.test.ts`: TTL resolution per source and precedence; 30 s margin; miss noise floor and
  exclusions; ping verdict; segment for `17%` at 5m and 1h, `always`, `false`, `~`, `cold`.
- `triggers.test.ts`: `times` per period and reset; `cache.pings` with `times`; ping and prompt
  in one tick; `cache.expiresIn` holds at or below its threshold.
- `config.test.ts`: `ping` without `cache.expiresIn` rejected; `times < 1` rejected; `show`
  forms parsed.
- `register.test.ts` (engine kit, fake world): the example end to end — three pings, then
  `prompt`; the prompt turn does not reset the period; an operator turn does; a cold ping stops
  the series; untrusted → no ping, no prompt.
- `claude plugin validate plugins/ctx-guard`, `claude plugin test plugins/ctx-guard`,
  `tsc -p plugins/ctx-guard`.

## Docs

- `skills/guide/references/config-reference.md`: `cache` block, metrics, actions, `times`.
- `skills/guide/SKILL.md`: how the model answers a `prompt` turn — write the handoff, stop, start
  no new work.
- `README.md`: drop "No prompt-cache keep-warm"; add cache help to the feature list.
- `docs/comparison.md`: "Prompt-cache help" ◐ → ●; rewrite the keep-warm line under "Where other
  tools do better".
- `docs/use-cases.md`: a "stepped away" scenario using the example config.
- `CHANGELOG.md`: `[Unreleased]` entries.

## Spike results (2026-10-16)

A throwaway mod run with `claude -p --plugin-dir`, and a throwaway engine-kit test:

1. `$.fs.read` of the transcript outside the cwd works without a permission prompt. After one
   turn the file was 339 KB and its rows held `ephemeral_1h_input_tokens: 25528`.
2. A fork reads the main thread's cache entry. After the second main request (read 13.6k,
   write 22.7k), a fork read 36.2k and wrote 153 tokens; a second fork in a row read 36.1k and
   wrote 0. A cache hit refreshes the entry's TTL (Anthropic prompt-caching behaviour), so a warm
   ping keeps the main prefix alive. Not measured across a full hour.
3. `turn.start` carries no origin; a plugin's prompt arrives framed (`The cache-spike plugin
   sent a message: …`). The `prompt.submit` hook sees `origin: { kind: 'plugin', name }`, also
   for the calling plugin's own prompt.
4. The test kit fakes both: `on('model.fork', () => ({ value: <ModelForkResult> }))` and
   `on('prompt.submit', ($, e) => ({ text: e.text }))` as bottom hooks.

## Out of scope

- Reading the real TTL from status-line data (not available to mods).
- A configurable ping prompt or `max_tokens` for the fork.
- Dollar estimates for pings or rewrites.
