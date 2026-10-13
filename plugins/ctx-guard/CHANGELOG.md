# Changelog

All notable changes to the `ctx-guard` plugin are documented here.

## [Unreleased]

### Added

- Plugin scaffold: manifest with `userConfig` switches (`enabled`, `configPath`, `defaultRole`,
  `blocking`, `autoActions`, `display`), the `$.state` type contract, and a config loader that
  merges built-in defaults, the switches, the project file and its `.local.json` override,
  validates them against schema v1 with path-qualified errors, keeps the last good config when a
  file is invalid, parses quantities (`"300k"`, `"1.2M"`, `"40%"`, `"10m"`, `"$2"`), and hashes
  the trust-sensitive fields.
- Role resolution (command > `CTX_GUARD_ROLE` > project `defaultRole` > userConfig `defaultRole`,
  interactive sessions only), `/ctx-guard role` and `/ctx-guard:resume` argument parsing, and the
  role lease decision.
- Trigger evaluation: rising edges per trigger id with JSON marks, `every` steps, AND metrics,
  re-arm on drop and on `/clear`, unknown metrics skipped, and the level-triggered deny set.
- Note, toast, deny-reason, refusal and subagent-budget texts, worded by level and restart mode.
- Hook wiring: config loaded at session start, on `/ctx-guard reload` and when a config file's
  mtime changes (an invalid file toasts once and keeps the last good config); triggers evaluated
  on `session.measure`, after a main-loop model request whose fill crosses a threshold
  (mid-turn, off the request's path) and on a one-minute idle timer, with notes, toasts and OS
  notifications on the rising edge; marks, the running-turn flag and the newest fill kept across
  hot reloads, marks reset on `/clear`; main-loop tool calls denied while a deny trigger holds
  (fails open, lifted by `blocking: false` or a pause). With no role, toasts only.
  `contextWindow: "auto"` uses the engine's own compaction window when it reports one.
- The band above the prompt (`lead · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h) · deny Agent`),
  or the same text on the status line on other surfaces or with `display: status`.
- `/ctx-guard` command: report (role and its source, config files and errors, effective config
  and where its window came from, metrics, marks, live blocks), `reload`, and, typed by the
  person only, `role <name|none>` (survives a reload), `pause [30m|off]`, and
  `init [solo|peers]`, which writes a starter config
  only when there is none and adds the local config and state folder to `.gitignore`.
- Start-up checks: a toast and no hooks when another plugin owns `/ctx-guard`, and a toast on
  Claude Code older than 2.1.293.
- Guarded restart on the ready token: when the main loop's answer ends on a line holding only
  `readyToken` and the role's `restart.mode` is `auto`, a fail-closed verdict runs, refusing in
  order with `untrusted`, `already-busy`, `no-restart-command`, `agents-running` (listed agents,
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
- `handoff.style: "session-handoff"`: the handoff is the newest non-empty `.md` under
  `.claude/session-handoffs/ctx-guard-<role>/`, and notes name the skill, that project slug and
  that its tool runs from the project root.
- Role lease `{stateDir}/{role}.owner`: a heartbeat on measure and every 5 minutes, one warning toast when another
  live session holds the role, released when the session ends (not on `/clear`).
- Per-repo trust: `/ctx-guard trust` (typed by the person) re-reads the config, approves the
  restart (mode, via, command, prompt, peers, peerGap), ready-check, handoff and compact
  settings plus `readyToken` and `stateDir`, and prints each as approved; every ready-check
  argument that is a file under the project root is hashed by content and checked again before
  each restart. Any change to them withdraws the approval. Untrusted, notes and blocks still work, but
  nothing clears, compacts or runs a ready check, and notes ask for the operator instead.
- Path confinement through the file system: a state folder, handoff, stamp or owner file that
  resolves outside the project root (a symlink, or a missing file under a linked folder) refuses
  the restart with `error`.
- `/ctx-guard check` (typed by the person): a dry run of every restart check (ready checks run when trusted), with no
  stamp written, no race and no clear. The report adds trust (and which fields need approval),
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
  compact.
- Subagent budgets: each subagent's fill (input + cache read + cache creation of its latest
  request) is measured on its `turn.step`, with arithmetic only on the request's path. Its type
  and kind come from its `agent.spawn` (workflow agents included), kept across reloads, with
  `$.agent.list` as the fallback; an agent neither names (the engine's compaction and memory
  forks) gets no budget, and forks and teammates get one only from an entry naming their type,
  `fork` or `teammate`. A type's `subagents` entry merges field by field
  over `"*"` (unset or `null` inherits, `"off"` drops that step). Past `warn` the agent gets one
  note; past `stop` it gets one stop note (the entry's `message`, or "context budget {stop}
  reached; return your final report now.") and every later tool call of that agent is refused
  with that reason, unless blocking is off or ctx-guard is paused (the notes still go). Budgets
  apply only once the session has a role. Agents past a step are kept across reloads, so a reload
  does not lift a deny; an agent is dropped at its `turn.complete`, or after 2 hours unseen. The
  band shows `sub N!` while N agents are past their warn, and the report lists the merged budgets
  and a table of followed agents (id, type, fill, warn, stop, state).
