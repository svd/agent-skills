# ctx-guard: context-boundary ledger, reach check and tuning — design

Date: 2026-10-24 · Plugin: `plugins/ctx-guard` (lands in `[Unreleased]`)

## Goal

ctx-guard's context triggers (`ctx-soft`, `ctx-hard`, `ctx-stop`) only help if sessions reach them
and the clear they lead to costs less than the context it removes. Today nothing tells the operator
whether that holds. This feature lets ctx-guard measure it in the repo where it runs and say which
boundary would cost least:

1. **Ledger** — record each main-loop request's context and cache figures, plus the events that
   reset or warn about context, in the repo's `stateDir`.
2. **Reach check** — in `/ctx-guard check` and the `/ctx-guard` report, say whether the context
   triggers fired in the recent past and whether the engine's own compaction got there first.
3. **Tune** — `/ctx-guard tune` replays the recorded sessions against candidate boundaries and
   recommends one per role; `/ctx-guard tune apply` writes it to the personal config file.

Every decision is arithmetic over recorded figures, computed in pure modules. No model call is
involved.

## Why: the measurement that prompted it

A manual replay of this repo's transcripts (2026-10-13 → 2026-10-24, 40 sessions, 3,413 main-loop
requests, Opus 5.5, 1M window, 1h cache TTL) found:

- The configured ladder (`40%`/`60%`/`75%` of 1M) never fired: the highest session peak was 329k.
  Context notes fired twice in 11 days, both under an earlier 300k threshold.
- The engine auto-compacted 10 times, each after ~55 min idle (cache about to expire), at
  203k–298k. It, not ctx-guard, bounded context.
- Role-driven clears (`lead` ending a part with the ready token) worked: ~14 clears, lead peaks
  98k–263k.
- A clear costs little: the next session starts at ~60k, of which ~30k is a fresh cache write,
  and the handoff is 2–6k output tokens.
- Cache reads are cheap (0.05× input on Opus 5.5). The context-dependent cost that matters is
  **cold cache rewrites**: 40 misses after idle cost ~18% of all spend, each proportional to the
  context at that moment.
- Tool-error rate was flat across context sizes (1.6–3.5%).
- Replaying with a clear at boundary B: cost was lowest at 125k–150k (−25% of the
  context-dependent cost, ~−12% of total), 200k gave −17%, 300k and above changed nothing. Below
  125k the clear overhead rose again.

The method of that replay is what `tune` automates.

## Decisions

- Data comes from ctx-guard's own hooks (`turn.step`, `session.end`, `session.compact`, its note
  and ready-token paths), written to a ledger. Transcripts are not parsed.
- Tuning is pure code (`hooks/ledger.ts`, `hooks/tune.ts`, no `$`), unit-tested like the other
  pure modules.
- ctx-guard never changes config on its own. `tune` recommends; `tune apply` writes only on the
  operator's command, and only to `.claude/ctx-guard.local.json`.
- Costs are relative weights per model family (multiples of the input price), not dollars, so
  subscription and API users get the same answer.

## 1. Ledger

### When it writes

Only while `ledger.enabled` is on (the default, see [Config](#config)), and only in a repo with a
ctx-guard config file (`.claude/ctx-guard.json` or its `.local.json`), so
a user-scope install leaves no files in repos that never opted in. Within such a repo it records
every interactive session, roleless ones under role `none`. Trust is not needed: the ledger takes
no action. *(Builder's call, made while writing this spec.)*

### Where

`<stateDir>/ledger/<YYYY-MM-DD>-<sessionId>.jsonl`, one file per session per day, so concurrent
sessions (a `main` and a `lead`) never write the same file. `stateDir` is already gitignored
(`.ctx-guard/`).

**Parts.** A session's day is written in parts: `<YYYY-MM-DD>-<sessionId>.jsonl`, then
`…-2.jsonl`, `…-3.jsonl` and so on. A part is closed once it reaches 256 KiB and the next record
opens a new part. No record is dropped for size. The size keeps each part far below the 4 MiB
`$.fs.read`/`$.fs.write` limit and keeps each rewrite cheap (see below). Readers take every part
of a session's day in numeric order.

**Retention.** At session start, files whose date is older than `ledger.days` (default 30) are
deleted, every part of them. Deletion touches only files in `<stateDir>/ledger/` whose names match
the ledger pattern.

**Engine facts.** `$.fs.write(path, text)` replaces the whole file, and `$.fs` has no append and no
delete. Hence:

- Writing a record means rewriting the open part with its full text. ctx-guard keeps the open
  part's text in memory, appends the new lines and writes it whole. That copy is bounded by the
  part size (256 KiB) and is dropped when the part closes, so memory never holds more than one
  part per session.
- Deleting old files needs a means outside `$.fs`, for example `$.process.run` of `rm` with the
  exact paths as arguments and no shell. The builder confirms what the engine allows. If no
  deletion means is available without trust, retention runs only in a trusted repo, and the reach
  check shows the ledger folder's size and file count so the operator can clean it up.

### Records

One JSON object per line. Every record has `t` (epoch ms), `k` (kind) and `role` (or `null`).

| `k` | When | Fields |
|---|---|---|
| `req` | each main-loop `turn.step` with usage | `ctx` (input + cache read + cache write), `cw`, `cr`, `out`, `model`, `miss` (tokens rewritten that should have been cached, else 0), `gap` (ms since the previous main request) |
| `note` | a context note is sent | `id`, `level`, `ctx`, `threshold` (tokens) |
| `ready` | the ready token is accepted | `ctx` |
| `clear` | `session.end` with reason `clear` | `by`: `ctx-guard` or `operator` |
| `compact` | `session.compact` of the main thread | `trigger` (`auto`, `manual`, or `ctx-guard` for the engine's `plugin`), `pre`, `post` |
| `start` | session start | `window` (resolved), `ttl` (if known) |

`miss` is `cache.ts`'s miss figure for the step, with one addition: a request whose cache write
exceeds 40k and half its `ctx` records that write as `miss` even where `cache.ts` counts none (the
first request after a cold ping, an idle past the TTL). These idle rewrites are the
context-dependent cost the tuning weighs most. Compactions with trigger `precompute` and subagent
compactions (`agentId` set) are not recorded. *(Builder's call.)*

Subagent steps are not recorded.

### Buffer and memory

New records go to an in-memory buffer. The buffer is flushed off the hook path, through the
existing `serial` chain, at each main-loop turn end, on `session.end` (a `/clear` included) and
before the config reload that turns the ledger off.

- After a successful write, the flushed records leave the buffer. The only text kept is the open
  part's (above), bounded by the part size.
- A failed write keeps the records for the next flush. The buffer holds at most 1,000 records: past
  that, the oldest are dropped and counted, and the reach check reports the count. A failure never
  throws out of a hook.
- On `session.end` that is not a `/clear`, the buffer and the open part's text are flushed and then
  released.
- With the ledger off, ctx-guard holds no ledger data in memory. All ledger state (buffer, open
  part's text, part number, previous request time, drop count, cached reach-check result) lives in
  one object, which is `null` while off. Off at start: never created. Turned off by a reload: one
  last flush, then `null` whether the flush succeeded or not. Tests check it stays `null`.

Tests cover the bounds: the buffer is empty after a successful flush, it never exceeds 1,000
records under repeated write failures, and the part text never exceeds the part size.

### Config

```jsonc
"ledger": { "enabled": true, "days": 30 }
```

A top-level key, shared by every role; a role cannot set it. On by default. It can be set in the
team file or, for one operator, in `.claude/ctx-guard.local.json`; the usual layering applies.

`"ledger": { "enabled": false }` turns the whole feature off:

- the `turn.step`, `session.end` and `session.compact` paths skip the ledger entirely: no record
  is built, no buffer is kept, no file is opened;
- no retention sweep runs at session start;
- the reach check is left out of `/ctx-guard check` and the report, and its toast never fires;
- `/ctx-guard tune` and `tune apply` answer "ledger is off (`ledger.enabled: false`)" and do
  nothing.

Files already in `<stateDir>/ledger/` are kept, so turning it back on resumes with that history.
Deleting the folder is the operator's choice. The switch takes effect on the next config reload,
like any other key.

### Performance

The feature adds work in four places. Each has a budget the tests check where they can:

| Where | Work | Budget |
|---|---|---|
| each main-loop request | build one record from figures `turn.step` already has, push it to an in-memory buffer | no I/O; well under 1 ms |
| each main-loop turn end | rewrite the open part (≤ 256 KiB) with the new records, then empty the buffer; off the hook path in the `serial` chain | one write of at most 256 KiB per turn; the turn does not wait on it |
| session start | list `<stateDir>/ledger/`, delete files past `days` | one directory read and one delete call, off the hook path |
| reach check (`check`, the report, the weekly toast) and `tune` | read and reduce up to `days` of files | only on command, or once per session start for the toast, off the hook path |

With the feature off, none of these run.

## 2. Reach check

Computed by `tune.ts` from the ledger over the last 14 days, per role (`none` counts as a role
here). Shown as a section of `/ctx-guard check` and one line in the `/ctx-guard` report.

It states:

- sessions and requests seen; peak context per session (median, p90, max);
- context notes fired, by level;
- clears by ready token, operator clears, compactions by trigger, with the engine auto-compact
  `pre` range;
- a **finding** when either holds:
  - *unreached*: the role's lowest context threshold is above the p90 session peak and no context
    note fired in the period;
  - *pre-empted*: the engine auto-compacted at a `pre` below the role's lowest context threshold.

With fewer than 5 sessions for a role it says "not enough data" instead of a finding.

When a finding is new (not shown in the last 7 days), ctx-guard toasts it once:
`ctx-guard: context triggers for main never fired in 14 days; engine compacted at 203k–298k. /ctx-guard tune`.
The 7-day memory lives in `$.store`, keyed by repo root.

## 3. Tune

### Which triggers are the context ladder

A role's **context triggers** are those whose `when` holds only `context` (plus an optional
`every`) and whose `do` holds no auto action (`compact`, `prompt`, `ping`). Sorted by threshold in
tokens (a percent resolves against the role's current window), the lowest is soft, the next hard,
the third stop. The reach check's "lowest context threshold" is the lowest of them. A context
condition ANDed with another metric is not part of the ladder. *(Builder's call.)*

### Model

For each role with enough data (≥ 10 sessions and ≥ 1,500 `req` records in the retention window):

1. Split the role's `req` records into segments at session start, `clear` and `compact`.
2. Replay each segment for a candidate boundary B: a virtual context `v` starts at the segment's
   first `ctx` and grows by each later request's increase (`max(0, ctx[i] − ctx[i−1])`); a drop of
   more than 30k resets `v` to the actual `ctx`.
3. Per request, cost in input-price units:
   - read: `v × w.read`;
   - miss: `min(v, miss × v / ctx) × w.write` — the lost share of the actual context, applied to
     `v`;
   - when `v ≥ B + overshoot`: one clear — `restartWrite × w.write + handoffOut × w.out` — and `v`
     becomes `restartStart`.
   Writes of new content are the same for every B and are left out.
4. Candidates: 100k to `ceiling` in 25k steps, plus "current" and "none".

Measured inputs, each the median over the ledger, with the fallback used until 5 samples exist:

| Input | Measured as | Fallback |
|---|---|---|
| `restartStart` | `ctx` of the 4th request after a ctx-guard clear | 65k |
| `restartWrite` | `cw` of the first request after a ctx-guard clear | 32k |
| `handoffOut` | `out` summed over the last 4 requests before an accepted ready token | 3k |
| `overshoot` | `ctx` at an accepted ready token minus the role's soft threshold in force, when positive | 25k |

Only clears feed `restartStart` and `restartWrite`; a restart through `/compact` is left out, as it
keeps a larger context. *(Builder's call.)*

`ceiling` is the lower of the resolved window and the lowest engine auto-compact `pre` seen minus
10k (the boundary must land before the engine acts).

Weights `w` per model family, relative to input price, kept in `tune.ts` beside the model-matching
rule used by `cache.ts`: Opus 5.5 — read 0.05, write (1h) 2, write (5m) 1.25, out 5; other Claude
models — read 0.1, write (1h) 2, write (5m) 1.25, out 5. The write weight follows the detected TTL.
Update them with `docs/pricing.md` (the repo's pricing note in `CLAUDE.md` lists this file too).

### Recommendation

- Best B: the highest candidate whose cost is within 2% of the minimum (fewer clears for the same
  money).
- Recommend only when it saves ≥ 5% of the role's context-dependent cost against the current
  ladder; otherwise "current boundary is fine".
- Ladder from B, in tokens: soft = B, hard = B + 50k, stop = B + 100k with `every: "25k"`, each
  capped at `ceiling`. Tokens, because the costs being weighed are absolute token counts. When
  replaying, a percent threshold in the current config resolves against the window in each
  session's `start` record. Each trigger's other fields (`do`, `level`, `message`, `deny`, `lift`) are kept from
  the current config.
- A role with no data, or below the data minimum, gets no recommendation.

### `/ctx-guard tune [role]`

Prints, per role (or the named one): data size and period, measured inputs (marked when a
fallback is used), the current ladder, a table of B → clears, cost relative to "none", and the
recommendation with its ladder.

### `/ctx-guard tune apply [role]`

Writes the recommended ladder into `.claude/ctx-guard.local.json` under `roles.<role>.triggers`,
creating the file if needed and preserving the rest of it. Because arrays replace by layer, it
writes the role's whole effective trigger list with only the three context triggers' `when.context`
(and `every`) changed. It then reloads the config and prints what changed. If a role's context
triggers do not follow the soft/hard/stop shape (none, or more than three context-only triggers),
apply refuses and names the triggers it could not map.

Apply prints, after writing, that the role's list is now pinned in the local file: later edits to
the team file's triggers for that role will not reach this operator until the local entry is
removed. If the change alters a trust-hashed field, it says that `/ctx-guard trust` is needed again.

## Non-goals

- Tuning non-context triggers (`limit.*`, `cache.*`, subagent budgets).
- Judging work quality after a clear (lost context, repeated work). Tool-error rate stays out of
  the model until a signal shows it moving with context size.
- Recording subagents' context.
- Reading history from before the ledger existed.

## Anti-goals

- Config that changes without the operator running a command.
- Any output that reads as dollars or a bill.
- Ledger writes on the hook path that slow a turn.

## Left to the builder

- Batching interval and file-handle strategy for ledger writes, within the existing `serial` chain.
- Exact wording of `tune` and `check` output, matching the existing report style.
- How `tune.ts` receives records (parsed lines or a streaming reducer), as long as a 30-day ledger
  for two roles fits the hook budget; run `tune` off the hook path if it does not.
- Tests: pure-module tests for `ledger.ts` (record shapes, retention, size cap) and `tune.ts` (the
  replay on fixed sequences, fallbacks, ceiling, hysteresis, ladder mapping and refusal), plus a
  `register.tune.test.ts` topic file for the hooks and commands, with `PRESET_TEXT` unchanged.
- Docs: `config-reference.md` (`ledger` key, `tune` command, reach check), `README.md`, the guide
  `SKILL.md` section on configuring thresholds, `CHANGELOG.md` `[Unreleased]`.
