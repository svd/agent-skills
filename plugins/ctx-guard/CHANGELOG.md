# Changelog

All notable changes to the `ctx-guard` plugin are documented here.

## [0.5.0] - 2026-10-21

### Added

- Command `/ctx-guard:clear [note]`: the operator asks the session to restart now. ctx-guard hands
  the model the note a `stop`-level context trigger would send the session's role (the restart
  tail by the effective mode, then `notes.suffix`), ahead of any text typed after the command.
  The ready token then meets the usual verdict, except `restart.minContext`, which is not judged
  until the operator's next input or the next restart. Refused, with nothing run, unless typed in
  the prompt box, and with no role or with the role's `restart.mode` off.

### Changed

- The engine-kit tests in `hooks/register.test.ts` are split by topic into
  `hooks/register.{core,restart,subagents,state,cache,lifts}.test.ts`, with their shared
  fixtures and helpers in `hooks/register.fixtures.ts`, so no file in the plugin reaches the
  claude.ai plugin directory's 256 KiB limit. No change in behaviour.

## [0.4.1] - 2026-10-21

### Fixed

- The plugin passes the claude.ai plugin directory's check on JSX names (`MOD_CAPABILITY_USE_NOT_PLAIN`):
  the lift code in `register.tsx` no longer names a variable or parameter `h`, the name JSX
  compiles to. No change in behaviour.
- README: "Sends to the model" names the lift note, sent when a brake lets go.

## [0.4.0] - 2026-10-20

### Added

- Trigger key `lift` on a trigger with a `deny`: what runs when the brake lets go and no other
  trigger still denies its tools. `lift.do` takes `note`, `toast`, `notify` and `prompt`;
  `lift.times` (required with `prompt`) caps the wake attempts between two operator inputs;
  `lift.message` replaces the default lift note and wake prompt. Validation: `lift` needs a
  `deny` in the trigger's `do`, `prompt` in `lift.do` needs `lift.times`, and `lift.times` needs
  `prompt`.
- The config schema (`ctx-guard.schema.json`) gains `lift`.
- A lift `prompt` wakes an idle session that stopped under the brake: only when the brake touched
  the work (a refused call, or its note read) and a turn ended since, the operator has not spoken
  since, the repo is trusted, `autoActions` is on and ctx-guard is not paused. A brake that never
  touched the work lifts with its other actions alone. After operator input, the operator gets a
  toast and the model the lift note on the next turn. A closed gate (untrusted, `autoActions` off,
  paused), a spent `lift.times`, a refused prompt or failed checks each send the operator a `notify`
  saying why the session was not woken. Before the wake, a lift check sends one tool-less request
  over the session's context (`$.model.fork`, as a `ping` does) to read the account's current usage;
  a brake that holds on those figures sends nothing. **A lift prompt spends usage**: the check's
  request, then the woken turn. Three failed checks stall the hold until usage is next reported or a
  window resets.
- The woken turn counts as work for `idle`: `idle` stands still through it and counts from its
  end. It starts no idle period, so trigger `times` and the cache's period go on.
- Operator input, for lifts: prompts and commands from the `composer`, `bridge`, `sdk`, `peer`,
  `coordinator`, `channel` and `slack-ping` origins, except `/ctx-guard`.
- Template variables `{id}`, `{tools}`, `{liftsIn}` (when the trigger's condition stops holding)
  and, in lift texts, `{liftReason}`.
- Deny reasons say when the tool comes free, and that ctx-guard will prompt the model then when a
  brake on it would wake the session. The `guide` skill tells the model to record where it
  stopped and end its turn then, and how to answer a wake prompt.
- The built-in `week-80-early`, `week-90-early` and `limit-stop` lift with a note; the `solo` and
  `peers` presets' brakes lift with a note and a notify.
- `/ctx-guard trust` lists each lift prompt with its `lift.times` and text; the report's trigger
  lines show a trigger's lift. A trigger with a lift prompt is part of what trust approves:
  editing it, its lift prompt included, needs a fresh `/ctx-guard trust`.

### Changed

- The default `restart.selfGap` is 1m (was 5m). `restart.selfGap` is part of what
  `/ctx-guard trust` approves, so a repo trusted while it was unset at the 5m default reads as
  untrusted after the update; run `/ctx-guard trust` there again.
- A usage window whose reset time passed a minute or more ago reads as rolled over (0 %, reset
  unknown) until the next response reports it. Usage figures are those of the last response, so
  before this a window kept its last figure through an idle reset. This changes the call path for
  every trigger: a percent brake on that window stops denying until a response reports figures, and
  the first request after the reset is judged on 0 %. The same 0 % feeds `cache.ping.maxUsage` and
  `cache.prompt.maxUsage`, so keep-warm pings and cache prompts may run again after a reset until
  fresh figures arrive. The band and the `/ctx-guard` report show 0 %, the report marked as an
  estimate.
- A rolled-over window re-arms no trigger: a percent trigger's mark clears on a reported figure
  below its threshold, or when its lift runs.

## [0.3.1] - 2026-10-17

### Fixed

- The plugin passes the claude.ai plugin directory's check on `$` use (`MOD_CAPABILITY_USE_NOT_PLAIN`):
  a `setCache` parameter no longer shares its name with the top-level `persist` function that
  receives `$`.

## [0.3.0] - 2026-10-17

### Added

- A prompt cache countdown in the band (`cache 8m`, `cache ~8m` for a guessed TTL, `cache cold`
  once expired), shown while the session is idle and the time left is within `cache.band.show`
  (default `25%` of the TTL; the warning colour from `cache.band.warn`, default `10m`). With pings in the period it reads `cache 8m · ping 2/3`.
- A top-level `cache` config block: `ttl` (`auto`, `5m`, `1h`), `band.show` (a duration, a percent
  of the TTL, `always` or `false`), `band.warn`, `ping.maxUsage` and `prompt.maxUsage` (no ping, or
  no prompt from a trigger on a cache metric, while a usage window is at or above it; default
  `90`). With `ttl: auto` the TTL comes from the session transcript, then from a warm read after a
  gap of more than 5 minutes, then from a guess (a subscription caches for an hour).
- Metrics `cache.expiresIn` (holds at or below its threshold), `cache.miss` and `cache.pings`.
- Actions `ping` and `prompt`. `ping` sends a tool-less model request over the main thread's
  prefix to keep the cache warm; `prompt` submits a turn that asks the model for a handoff while
  the user is away. Both need `/ctx-guard trust` and the `autoActions` switch; `/ctx-guard trust`
  lists their triggers with `times` and the prompt text. A `prompt` is tried up to three times when refused, and a `compact` in
  the same fire waits for its turn to end.
- Trigger key `times`: at most that many fires per idle period. A trigger with `ping` or `prompt`
  must have it, and a `ping` trigger must have `cache.expiresIn` in its `when`.
- A `cache:` line in the `/ctx-guard` report: the TTL and its source, the time left, pings, a cold
  ping, the last miss and a pending retry. Trigger lines show `times` and `≤` for
  `cache.expiresIn`.
- Quantity kind `count` (a whole number), used by `cache.pings`.
- Template variables `{idle}` and `{expiresIn}`, and a default text for the `prompt` action.
- A `cache-miss` toast at 50k tokens in the `solo` and `peers` presets.
- A `prompt.submit` hook that tells ctx-guard's own prompt from the user's, so the prompt's turn
  neither starts a new idle period nor resets `idle`.
- The guide skill tells the model how to answer a prompt that says the user is away: write the
  handoff, then stop.

### Changed

- The `autoActions` switch, the trust approval, the band's `untrusted` segment and the
  `/ctx-guard` report cover `ping` and `prompt` as well as clear and compact. The text of a
  skipped automatic action reads "automatic actions are not approved".
- The README's section on what ctx-guard runs, reads, writes and sends covers the transcript read,
  the ping and the prompt.

## [0.2.0] - 2026-10-15

### Added

- An icon and homepage, repository, documentation and support links in `plugin.json`, for the
  plugin directory listing.
- A README section on what ctx-guard runs, reads, writes and sends, and what each hook changes.

### Fixed

- `/ctx-guard:resume`'s `argument-hint` is quoted, so its front matter parses as YAML.

### Changed

- The demo GIF lives outside the plugin, in the repo's `docs/assets/ctx-guard/`, so installing
  ctx-guard no longer downloads 2.7 MB of image; the README links it by URL.
- The band's render hook is registered in `register.tsx` itself, where the plugin directory's
  checks can read it.

## [0.1.0] - 2026-10-15

### Added

- A toast each time a note goes to the model, naming its level, the figure and threshold that
  crossed, and what the model was asked (`ctx-guard → model (hard): context 52k past 50k — wrap
  up; write the handoff, then end with CTX-READY`). It follows the effective restart mode and
  `via`, gives one toast for a collapsed note and stands in for a `"toast"` on the same trigger.
  New `userConfig` switch `noteToasts` (default `true`) turns it off; the `/ctx-guard` report
  shows it on its `switches:` line.
- Plugin scaffold: manifest with `userConfig` switches (`enabled`, `configPath`, `defaultRole`,
  `blocking`, `autoActions`, `display`), the `$.state` type contract, and a config loader that
  merges built-in defaults, the switches, the project file and its `.local.json` override,
  validates them against schema v1 with path-qualified errors, keeps the last good config when a
  file is invalid, parses quantities (`"300k"`, `"1.2M"`, `"40%"`, `"10m"`, `"$2"`), and hashes
  the trust-sensitive fields.
- Role resolution (command > `CTX_GUARD_ROLE` > project `defaultRole` > userConfig `defaultRole`,
  interactive sessions only), `/ctx-guard role` and `/ctx-guard:resume` argument parsing, and the
  role lease decision.
- Example scripts in the `guide` skill: ready checks `handoff-committed.sh`,
  `worktrees-committed.sh`, `handoff-after-worktrees.sh` and `jobs-quiet.py`, band probes
  `worktrees.sh` and `superpowers-plan.py`, with a table in the config reference and README use
  cases 13-15 (builders in git worktrees, jobs outside the session, a superpowers plan's progress).
- `/ctx-guard` reports `trust: not needed` when an approval would turn nothing on (no automatic
  restart, `compact` trigger or band probe), instead of an untrusted line the band does not show.
- `/ctx-guard` reports the role's `selfGap` and, after this session's last restart on the ready
  token, how long the token stays refused as `too-soon`.
- Role lists (`/ctx-guard`, an unknown-role error) leave out the built-in `main` once the
  project names roles of its own and gives `main` nothing: no settings, not the `defaultRole`,
  not the session's role. It still resolves, so a userConfig `defaultRole` of `main` keeps working.
- Trigger evaluation: rising edges per trigger id with JSON marks, `every` steps, AND metrics,
  re-arm on drop and, for triggers with a `context` condition, on `/clear` (a trigger on usage,
  cost or idle alone keeps its mark across `/clear`), unknown metrics skipped, and the
  level-triggered deny set.
- `limit.five_hour.resetsIn` and `limit.seven_day.resetsIn` metrics: time left to that window's
  reset, at least, allowed only beside the same window's percent metric. They express a brake
  that tightens the earlier a window fills (`{ "limit.seven_day": 80,
  "limit.seven_day.resetsIn": "2d" }`); unknown while the window reports no reset time, and a
  deny on one names when the reset comes close enough to lift it. The built-in ladder (and the
  `solo` preset) uses them: `week-80-early` and `week-90-early` note and deny `Agent` and
  `Workflow` while the weekly window is at 80 % with two days or more to its reset, or at 90 %
  with one day or more.
- Note, toast, deny-reason, refusal and subagent-budget texts, worded by level and restart mode.
  Only a note with a fired context trigger carries the restart tail: a restart frees context, so
  a note on usage, cost or idle alone asks for none.
- Hook wiring: config loaded at session start, on `/ctx-guard reload` and when a config file's
  mtime changes (an invalid file toasts once and keeps the last good config); triggers evaluated
  on `session.measure`, after a main-loop model request whose fill crosses a threshold
  (mid-turn, off the request's path) and on a one-minute idle timer, with notes, toasts and OS
  notifications on the rising edge; marks, the running-turn flag and the newest fill kept across
  hot reloads, context marks reset on `/clear`; main-loop tool calls denied while a deny trigger holds
  (fails open, lifted by `blocking: false` or a pause). A call made while its response still
  streams is judged on that request's fill, estimated as the last request's input and output plus
  the tool results since (4 characters a token), since its usage arrives only at the stream's
  end. With no role, toasts only.
  `contextWindow: "auto"` uses the engine's own compaction window when it reports one.
- The band above the prompt (`lead · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h) · deny Agent`),
  or the same text on the status line on other surfaces or with `display: status`. It draws the
  band last written, never waiting on a busy session start. Context is green below 50 %, warning
  below 75 % and error from there; each usage window green below 80 %, warning below 90 %.
- `/ctx-guard` command: report (role and its source, with a claimed role's age — a claim lasts the
  whole session, through `/clear` and a reinstall of the plugin — config files and errors, effective config
  and where its window came from, metrics, marks, live blocks), `reload`, and, typed by the
  person only, `role <name|none>` (survives a reload), `pause [30m|off]`, and
  `init [solo|peers]`, which writes a starter config
  only when there is none and adds the local config and state folder to `.gitignore`.
- Start-up checks: a toast and no hooks when another plugin owns `/ctx-guard`, and a toast on
  Claude Code older than 2.1.293. When the command cannot be had (a skill or command listed as
  `ctx-guard:ctx-guard` takes the bare name, or the engine refuses the registration) one toast
  names why, and notes, blocks and the band still work.
- State across `/clear` and reloads: everything ctx-guard keeps is held in memory and written
  through to `$.state`. A session start fills memory from `$.state` (a reload keeps `$.state`
  but not memory); a `/clear` keeps memory but empties `$.state`, so its marks are reset and the
  first hook or timer after it writes every key back. A session that ends any other way forgets
  what it held. A reload landing after a `/clear` and before that first hook starts from the
  emptied `$.state`.
- Guarded restart on the ready token: when the main loop's answer ends on a line holding only
  `readyToken` and the role's `restart.mode` is `auto`, a fail-closed verdict runs, refusing in
  order with `untrusted`, `already-busy`, `not-needed` (the context is below the role's
  `restart.minContext`, a tokens or percent value set apart from the triggers; `"off"`, the
  default, skips the check), `too-soon` (this session restarted less than `restart.selfGap`, default
  `5m`, ago; `"0"` turns it off), `no-restart-command`, `agents-running` (listed agents,
  or an agent seen stepping with no end, which covers workflow agents), `background-tasks` (the
  last Stop's list; none reported counts as unknown and refuses), `role-shared`, `no-handoff`, `handoff-stale`, `stamp-unreadable`,
  `peer-restarting`, `ready-check-failed`, `race-lost` or `error`. A refusal toasts and notes
  why; nothing is cleared. Just before its stamp and again just before `/clear` it re-checks that no turn,
  agent or background task started since the token. On success it writes `pendingResume`, runs
  `/clear`, then `/<restart.command> role=<role> handoff=<path> <prompt>`. A reload in between
  finishes the resume at the next session start (dropped and flagged once it is over 5 minutes
  old); a reload while the resume is being sent only flags it, so it never runs twice; a resume
  that fails shows "restart failed — type /…" on the band. Subagent steps and the last Stop's
  background list are kept across reloads.
- Restart stamps `{stateDir}/{role}.restart` with a peer race: after writing its own stamp a
  session waits 1.5 s and reads its peers' again; the oldest young stamp wins, and a loser puts
  its stamp back, as does the next session start when a reload cut a restart off before
  `/clear`. A `/clear` from such a restart that lands late flags the band.
- `/ctx-guard:resume` command: reads the handoff, checks its claims against the repository, then
  carries out its Next action or reports the mismatch. Typed by the person in a session with no
  role, its `role=` claims that role; a different role already held is refused.
- `handoff.instructions` may name any skill that writes the handoff, and takes `{role}`.
- Role lease `{stateDir}/{role}.owner`: a heartbeat on measure and every 5 minutes, one warning toast when another
  live session holds the role, released when the session ends (not on `/clear`).
- Per-repo trust: `/ctx-guard trust` (typed by the person) re-reads the config, approves the
  restart (mode, via, command, prompt, peers, peerGap), ready-check, handoff and compact
  settings plus `readyToken` and `stateDir`, and prints each as approved; every ready-check
  argument that is a file under the project root is hashed by content and checked again before
  each restart. Any change to them withdraws the approval. Untrusted, notes and blocks still work, but
  nothing clears, compacts or runs a ready check, and notes ask for the operator instead.
  `/ctx-guard trust off` (typed by the person) withdraws the approval. While a repo that restarts
  on its own, compacts or runs band probes is untrusted, the band shows `untrusted`, or
  `untrusted (changed)` once an approval no longer matches.
- Path confinement through the file system: a state folder, handoff, stamp or owner file that
  resolves outside the project root (a symlink, or a missing file under a linked folder) refuses
  the restart with `error`.
- `/ctx-guard check` (typed by the person): a dry run of every restart check (ready checks run when trusted), with no
  stamp written, no race and no clear; it warns when, minutes after a restart, the context is
  already past the role's lowest context threshold. The report adds trust (and which fields need approval;
  with nothing approved yet, only those that hold something),
  the last verdict, the handoff's age, the lease owner and a pending resume.
- Compact: a trigger's `compact` action queues `/compact {compact.instructions}` (kept across
  reloads) and runs it at once when no main turn runs, else at the next main-loop turn end, once
  no turn, restart, agent or background task is busy (one toast while it waits). A queued compact
  is dropped when its trigger re-arms first, by a `/clear`, or by a reload while it was being sent
  (never sent twice). While auto actions are off, the repo is untrusted or ctx-guard is paused it
  is blocked, with one toast per reason and a report line, and runs once that lifts (`/ctx-guard
  trust`, a pause lifted or run out, auto actions on) if its trigger is still marked. A compact
  action within 5 minutes of one that ran is held until then and runs only if the engine's own
  figures still cross the threshold (otherwise it is dropped and the trigger re-arms), so a
  reading from before the compaction cannot start another; a ready-token restart at the same turn end goes first,
  and a refused one lets the queued compact run.
- `restart.via: "compact"`: the ready token runs the restart checks minus the handoff, lease and
  peer ones, then `/compact {compact.instructions}`, with no resume after it. A ready token while
  a compact runs is refused with `already-busy`, and a via-compact refusal says nothing was
  compacted. The report shows a queued compact and the last one; `/ctx-guard check` covers via
  compact. Notes of such a role plan for a compaction, not a handoff.
- Subagent budgets: each subagent's fill (input + cache read + cache creation of its latest
  request) is measured on its `turn.step`, with arithmetic only on the request's path. Its type
  and kind come from its `agent.spawn` (workflow agents included), kept across reloads, with
  `$.agent.list` as the fallback; an agent neither names (the engine's compaction and memory
  forks) gets no budget, and forks and teammates get one only from an entry naming their type,
  `fork` or `teammate`. A type's `subagents` entry merges field by field
  over `"*"` (unset or `null` inherits, `"off"` drops that step). Past `warn` the agent gets one
  note; past `stop` it gets one stop note (the entry's `message`, or "context budget {stop}
  reached; return your final report now. Tool calls are refused, except the one that returns your
  report.") and every later tool call of that agent is refused with that reason, unless blocking
  is off or ctx-guard is paused (the notes still go). The tools that hand a result back
  (`SubagentHandback`, `StructuredOutput`, `ReportFindings`) are never refused, so the report
  arrives. Budgets
  apply only once the session has a role. Agents past a step are kept across reloads, so a reload
  does not lift a deny; an agent is dropped at its `turn.complete`, or after 2 hours unseen. The
  band shows `sub N!` while N agents are past their warn, and the report lists the merged budgets
  and a table of followed agents (id, type, fill, warn, stop, state).
- `guide` skill (`/ctx-guard:guide`; a skill named `ctx-guard` would take the bare `/ctx-guard`
  command): the protocol for answering `[ctx-guard]` notes (safe point, handoff, ready
  token, refusals, blocked tools, subagent budget notes) and for configuring the plugin; a config
  reference with every key, default, refusal code, trust rule and recipes (solo, coordinator and
  workers, peers, compact instead of clear, a usage brake, a personal override); a JSON Schema of
  config v1; the `solo` and `peers` presets; and a `clean-worktree.sh` ready-check example.
  `/ctx-guard init` now copies the shipped preset file byte for byte, and its reply asks for
  `/ctx-guard trust` when the preset restarts or compacts on its own.
- A failed ready check's refusal now ends with the last 300 characters of its stderr (stdout
  when stderr is empty), on one line with control characters dropped.
- The built-in brakes and both presets block `Workflow` wherever they block `Agent`, since a
  workflow fans out subagents past an `Agent` block. The 95 % brake (`limit-stop`, and
  `limit-brake` in the presets) also blocks `WebSearch` and `WebFetch`.
- Ready checks run with `CTX_GUARD_*` environment variables: the role
  (`CTX_GUARD_SCRIPT_ROLE`), the handoff path and mtime, the bound a handoff must be newer than,
  the state dir and `via`; `CTX_GUARD_PURPOSE` is `dry-run` under `/ctx-guard check`.
- A typed `/ctx-guard:resume` fills in what it leaves out: the session's own role when it names
  none (refused when the session has none), then that role's `handoff.path` and
  `restart.prompt`, so `/ctx-guard:resume` alone runs as the automatic restart would.
- A role's own `restart.command` typed by the operator (`/restart-lead`) claims that role in a
  session with none, by the same rules as `/ctx-guard:resume role=`; in a session holding another
  role it is refused and does not run. A command several roles share claims nothing.
- `band.probes`: up to four project scripts whose output is a band segment, run on their own
  timers in a trusted repo; `/ctx-guard` reports their last run.
- The band follows the main loop mid-turn: a step whose context fill would read differently on
  the band (`150k` → `152k`) redraws it off the turn's path, without an evaluation. Before, a long
  turn showed its starting figure until a trigger's threshold was crossed or the turn ended.
- Documentation: the README is now a short overview (why, what it does, how a restart works,
  quick start, safety, setups, comparison, limitations, FAQ), and the detail moved verbatim to
  `docs/`: getting started, configuration, handoff and restart, use cases and troubleshooting,
  plus `docs/comparison.md`, a dated feature matrix against related tools.
