# ctx-guard: project scripts for ready checks and the band — design

Date: 2026-10-14 · Plugin: `plugins/ctx-guard` (0.1.0, unreleased) · Branch: `feat/ctx-guard-probes` (from `dev`)

## Goal

Let a project keep its own gates and status in scripts in its own repo, so ctx-guard stays
generic. The driving case is replacing a project-local guard mod (two roles, an orchestrator
that dispatches detached steps) with ctx-guard. That guard had three project-specific features:

1. refuse a restart while a dispatched step is still open;
2. treat the handoff as stale unless it was written after the last dispatch;
3. show the newest open step as a segment on the band.

(1) and (2) are ready checks that need to know which handoff and which time bound they judge.
(3) needs a way to put a script's output on the band. None of the project logic moves into the
plugin.

## Decisions (agreed with the operator)

- Scope: context for ready checks, plus band probes. No probe-driven trigger metrics.
- Approach: extend what exists. `restart.readyChecks` keep their contract and gain an
  environment; a new top-level `band.probes` list adds script segments. Shared pure helpers go
  in a new `hooks/scripts.ts`.
- Context is passed in environment variables only. No stdin, no JSON.
- The role goes in `CTX_GUARD_SCRIPT_ROLE`, not `CTX_GUARD_ROLE`: ctx-guard reads the latter
  to pick a session's role, so a script that starts `claude` would hand its role on.
- Probes are display only. They never gate a restart, a deny or a note.
- Nothing about any particular project's run layout goes into the plugin, its docs or its
  examples.

## 1. Ready-check context

`runChecks` (`hooks/register.tsx`) passes `env` to `$.process.run(c.run, { cwd, timeoutMs, env })`.
The values come from the facts the verdict already gathered; nothing is read again.

| Variable | Value |
|---|---|
| `CTX_GUARD_PURPOSE` | `ready-check`; `dry-run` under `/ctx-guard check` |
| `CTX_GUARD_SCRIPT_ROLE` | the role |
| `CTX_GUARD_ROOT` | the project root as the session reports it (the script's working directory) |
| `CTX_GUARD_STATE_DIR` | `stateDir`, absolute |
| `CTX_GUARD_HANDOFF` | the configured handoff path, absolute (set whether or not the file exists) |
| `CTX_GUARD_HANDOFF_MTIME_MS` | the handoff's mtime, epoch ms; empty when the file is absent or unusable |
| `CTX_GUARD_SINCE_MS` | `max(startedAt, lastClearAt)`: the bound `handoff-stale` uses |
| `CTX_GUARD_VIA` | `clear` or `compact` |

Rules:

- Every variable is always set. A value that does not apply (no role, `via: compact`, an absent
  handoff's mtime) is the empty string, so a script tests for empty rather than for unset.
- Values are decimal integers or plain strings; no quoting.
- `scriptEnv(input)` in `hooks/scripts.ts` builds the map from plain values. It is pure.
- Order, trust and failure handling are unchanged: checks run last, only in a trusted repo,
  stop at the first failure, and a failure refuses with `ready-check-failed` quoting the tail
  of the output.
- `/ctx-guard check` passes the same variables with `CTX_GUARD_PURPOSE=dry-run`, so a check
  with side effects can skip them.

## 2. Band probes

### Config

A new top-level key; probes are shared by every role (a script that cares reads
`CTX_GUARD_SCRIPT_ROLE`).

```json
"band": {
  "probes": [
    { "id": "run", "run": ["python3", ".claude/ctx-guard/run-status.py"], "every": "60s", "timeout": "5s" }
  ]
}
```

| Key | Type | Default | Rule |
|---|---|---|---|
| `band.probes` | list | `[]` | At most 4 entries. |
| `id` | string | — | `^[a-z][a-z0-9-]{0,31}$`, unique in the list. |
| `run` | non-empty list of strings | — | Runs without a shell, from the project root, like a ready check. |
| `every` | duration | `"60s"` | At least `"15s"`. |
| `timeout` | duration | `"5s"` | At most `"30s"`. |

Layers merge as elsewhere: `band` is an object (merges by key), `probes` is an array (replaces).
Unknown keys are errors. The schema gains the same.

### Environment

The ready-check variables with `CTX_GUARD_PURPOSE=band-probe`. `CTX_GUARD_SCRIPT_ROLE`,
`CTX_GUARD_HANDOFF` and `CTX_GUARD_HANDOFF_MTIME_MS` are empty when the session has no role;
`CTX_GUARD_SINCE_MS` is always set.

### Output protocol

`parseProbe(result)` in `hooks/scripts.ts`, pure:

- Exit 0, empty stdout (or only blank lines): no segment.
- Exit 0, first non-blank line: the segment text. Control characters are removed; text longer
  than 40 characters is cut to 39 plus `…`.
- Optional next line: a colour, one of `inactive`, `green`, `warning`, `error`, `subtle`. Any
  other value is ignored (default colour).
- Non-zero exit, timeout or a start failure: the segment `<id> ?` in `warning`. The last 300
  characters of stderr (stdout when stderr is empty) are kept for the report, never drawn.

### Running

- From `$.clock.every(probe.every)` timers armed with the others, once at session start and
  once after `/clear`. Never from `turn.*`, `tool.call` or `session.measure`.
- At most one run per probe at a time: a tick while the last run is still going is skipped.
- Not run when `display` is `off`, when ctx-guard is inert or disabled, or when the repo is not
  trusted. Untrusted, no probe segment is drawn and `/ctx-guard` reports
  `probe <id>: not run (untrusted)`.
- A pause does not stop probes: they only draw.
- A config reload re-arms the timers for the new list and drops results of removed ids.

### Trust

- `trustMaterial` gains `band` (the probe list) under `'*'`, only when the list is non-empty, so
  an approval given before this change still holds for a config without probes.
- `checkScripts` also collects the arguments of probe `run`s, so a probe script under the root
  is hashed and editing it withdraws trust.
- `/ctx-guard trust` prints each probe (`band probe <id>: [run], every …, timeout … (content
  hashed: …)`) with the other approved values, and arms the probes right after approving.

### Band

- `Band` in `types/index.d.ts` (the `PluginState` contract) gains
  `probes: { id: string; text: string; color: string | null }[]`.
- `bandSegments` draws them after the usage windows and before `sub N!`, `deny …` and the
  restart failure, in config order.
- Results are kept in memory and in `$.state`; after a reload the last result is drawn until
  the next run.

### Report

`/ctx-guard` lists each probe: its id, last text (or "no segment"), how long ago it ran, and the
kept error tail when it failed.

## 3. Docs

- `skills/guide/references/config-reference.md`: the variable table under Ready checks; a new
  "Band probes" section (config, protocol, limits, trust); `band.probes` in the trust list.
- `skills/guide/assets/ctx-guard.schema.json`: `band.probes`.
- `skills/guide/assets/probes/git-branch.sh`: a generic example probe (branch name, `warning`
  when the worktree is dirty).
- `README.md`: recipe 4 mentions the variables; a new recipe "Project status on the band";
  the "Files ctx-guard writes" section is unchanged (probes write nothing).
- `skills/guide/SKILL.md`: one line — a `ready-check-failed` refusal quotes a project script;
  fix what it names, do not edit the script.
- `CHANGELOG.md` `[Unreleased]`: both features.

## 4. Tests

- `hooks/scripts.test.ts`: `scriptEnv` (all keys present, empty strings, `dry-run`),
  `parseProbe` (empty, text, colour, unknown colour, truncation, control characters, failure).
- `hooks/config.test.ts`: `band.probes` parse and errors (bad id, duplicate id, `every` under
  15s, `timeout` over 30s, more than 4, unknown key); merge (array replaces).
- `hooks/band.test.ts`: segment order with probes.
- `hooks/register.test.ts`:
  - a ready check sees the variables (verdict and `check`);
  - a probe timer tick draws its segment; failure draws `<id> ?`; empty output draws nothing;
  - untrusted: the probe does not run;
  - an overlapping tick is skipped;
  - a reload with a removed probe drops its segment;
  - trust withdraws when a probe script changes.
- `claude plugin validate` and `claude plugin test` pass; `tsc -p plugins/ctx-guard` is clean.

## 5. Validation against `dev`

Work happens on `feat/ctx-guard-probes`, branched from `dev`. The parallel change
(`2026-10-14-handoff-any-skill-design.md`: drop `handoff.style`, rework `handoffOf`,
`restartTail`, `trustMaterial`) is already merged into `dev` (`be4a7e5`). Checked there:

1. `trustMaterial` (`'*'` holds `readyToken`, `stateDir`; per role `restart`, `handoff.path`,
   compact) and `checkScripts` (collects ready-check args per role): as assumed. `band` goes
   under `'*'`; `checkScripts` adds probe args.
2. `runChecks($, spec)` takes only the spec. It gains the gathered facts and a purpose:
   `runChecks($, spec, g, purpose)`. `g.facts` has `role`, `startedAt`, `lastClearAt` and
   `handoff` (`HandoffFact`; its `path` is **relative** to the root, so the variable is
   `root + '/' + path`); `g.stamps.realRoot` has the real root. The state dir is resolved in
   `gather` (`stateDirOf`) but not kept: keep it on `Gathered`. Both callers (`judge` and
   `checkCommand`) pass `g`.
3. Test kit: the fake `process.run` (`register.test.ts`) records only `e.argv` and always
   returns empty stdout. The event carries `init` (`{ cwd, env, stdin, timeoutMs }`), so the
   fake records `e.init` too and takes a per-argv stdout. `clock.advance(ms)` drives
   `$.clock.every`.
4. `Band` (`types/index.d.ts`): `role, tokens, percent, window, limits, subagentsOver, denies,
   restartFailed, now`. `probes` is added; `bandSegments` order as in section 2.
5. No top-level `band` config key exists (`'band'` is only a `display` value).

Re-check items 1–4 if `dev` moves before the first code change.

## Out of scope

- Probe results as trigger metrics or deny conditions.
- Stdin or JSON input to scripts.
- Per-role probes.
- Project-specific scripts. The consuming project writes its own ready check and probe and
  migrates its config separately, after ctx-guard is released.
