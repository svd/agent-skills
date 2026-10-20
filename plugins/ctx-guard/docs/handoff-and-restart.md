# Handoff, restart and compact

[← ctx-guard README](../README.md) · [All docs](README.md)

## Handoff and restart

A restart frees the context by `/clear` and carries the work over through a **handoff**: a
file the model writes before the clear and the fresh session reads after it. ctx-guard never
writes the handoff itself; it tells the model when and what to write, checks the file is
there and fresh, and runs the clear and the resume.

### Restart modes

`restart.mode` decides how a note ends and what the ready token does.

| Mode | The note ends with | The ready token |
|---|---|---|
| `auto` | "At the next safe point — no subagents running, current work recorded — write the handoff to `<handoff>`: *instructions* Then end your reply with a line holding only `CTX-READY`." | Starts a guarded `/clear` and resume. |
| `manual` (default) | The same, but "Then tell the operator 'ready for /clear'." | Ignored. You run `/clear` and the resume yourself. |
| `off` | Nothing about a handoff. | Ignored. |

Only a note with a fired **context** trigger asks for a handoff. A note about usage, cost or
idle alone asks for none, since a restart would not lower those figures.

A note promises `auto` only when ctx-guard would act on the token. With the repo untrusted,
`autoActions` off or ctx-guard paused, an `auto` role's notes read as `manual`.

### The handoff file

| Key | Default | Meaning |
|---|---|---|
| `handoff.path` | `.ctx-guard/{role}-handoff.md` | Where the model writes it. `{role}` is filled in. Relative, under the project root. |
| `handoff.instructions` | none | What the handoff must hold, and the skill that writes it if any (recipe 11). Quoted in the note with `{role}` filled in, so this is where you shape it. |

Unless the instructions name a skill, the model rewrites the whole file each time, never appends. Make every claim checkable: the
resume verifies the recorded git `HEAD` and every path named. A handoff written with the
preset's instructions looks like this:

```markdown
# Handoff — main
Written: 2026-10-14 15:42. HEAD: 3f9c2e1 (branch feat/export).

## Goal
CSV export for the reports page, behind the `export.csv` flag.

## State
- Done and committed: `src/export/csv.ts`, tests in `src/export/csv.test.ts` (green).
- Not started: wiring the button in `src/pages/reports.tsx`.
- Decided: quote every field; no streaming for now (max 10k rows).

## Next action
Add the Export button to `src/pages/reports.tsx`, call `toCsv()`, run `npm test`.
```

### The ready token

The model asks for a restart by ending its reply with a line holding only the token (default
`CTX-READY`, set by `readyToken`). Surrounding punctuation is fine (`**CTX-READY**` counts);
the token inside a sentence, or in a subagent's answer, never counts. The `guide` skill tells
the model never to send it before the handoff is written or without a note asking for it.

To restart before any trigger asks, type `/ctx-guard:clear` (text after it reaches the model too).
ctx-guard sends the note a `stop`-level context trigger would send your role, so the model writes
the handoff and ends with the token, or, in manual mode, tells you 'ready for /clear'. The token
then meets the usual verdict, except `restart.minContext`: you asked, so the restart is needed. The
command needs a role and a restart mode other than `off`.

### The verdict

When the token arrives in `auto` mode, ctx-guard runs these checks in order right after the
turn. The first that fails refuses the restart with a toast and a note to the model
(`[ctx-guard] CTX-READY ignored (<code>): <reason>. Nothing was cleared.`); nothing is cleared.

1. `untrusted`: the repo's restart settings are approved.
2. `already-busy`: no restart, compact or resume is under way.
3. `not-needed`: context is at or above `restart.minContext` (default `"off"`: not checked).
4. `too-soon`: this session's last restart was at least `restart.selfGap` (default `1m`) ago.
5. `no-restart-command`: the resume command exists in this session.
6. `agents-running`, `background-tasks`: no subagent, workflow agent or background shell runs.
7. `role-shared`: no other live session holds this role.
8. `no-handoff`, `handoff-stale`: the handoff exists, is not empty, and was written after the
   session start or the last `/clear`.
9. `stamp-unreadable`, `peer-restarting`: no peer role restarted within `restart.peerGap`.
10. `ready-check-failed`: every `restart.readyChecks` command exits 0.
11. `race-lost`: no peer started its restart at the same moment.

`/ctx-guard check` runs the same checks as a dry run. The full list with fixes is under
[Troubleshooting](troubleshooting.md#ctx-ready-ignored-code).

### What a restart does

1. Re-checks that no turn, agent or background task started since the token.
2. Writes its stamp `.ctx-guard/<role>.restart`, waits 1.5 s and reads the peers' stamps again.
   Of two sessions that got this far, the older stamp wins; the other refuses with `race-lost`.
3. Re-checks once more and runs `/clear`.
4. Runs `/<restart.command> role=<role> handoff=<path> <restart.prompt>`, by default
   `/ctx-guard:resume role=main handoff=.ctx-guard/main-handoff.md Carry out Next action without waiting.`

The resume command then:

1. reads the handoff whole (missing or empty: it stops and says so);
2. checks its claims: the recorded commit is `HEAD` or an ancestor of it
   (`git merge-base --is-ancestor`), every named file and folder exists, every branch, run or
   task named as in progress still exists;
3. if all hold, carries out the Next action at once, following `restart.prompt`;
4. if any fails, does nothing else, lists each mismatch and waits for you.

If the plugin reloads between `/clear` and the resume, the resume runs at the next session
start, as long as it is under 5 minutes old. A resume that does not run puts
"restart failed — type /…" on the band.

`restart.command` can name your own project command instead of `ctx-guard:resume`; it gets the
same `role=… handoff=… <prompt>` arguments. Typed by you in a session with no role, it claims the
role it belongs to, as the resume does; in a session that holds another role it is refused and
does not run.

### A manual restart

With `mode: "manual"`, do by hand what ctx-guard would do: when the model says
"ready for /clear", type `/clear`, then
`/ctx-guard:resume` (or `/ctx-guard:resume role=<role>` in a session with no role yet).
ctx-guard fills in the session's role, then its `handoff.path` and `restart.prompt`, so it runs as
the automatic restart would; a `role=`, `handoff=` or prompt you type yourself wins. With no
`role=` in a session that has no role, the resume is refused and nothing runs. Typed in a session with no role, the resume also claims that role.

## Compact

Instead of clearing and starting over from a handoff, a session can `/compact`: Claude Code
summarises the conversation and keeps going in the same session. No handoff, no resume.

| | Clear and resume | Compact |
|---|---|---|
| What survives | Only what the model wrote into the handoff. | A summary of the whole conversation. |
| Context after | Nearly empty: the handoff plus the first step. | The summary, usually larger than a handoff. |
| Checkable | Yes: the resume verifies `HEAD` and paths. | No: the summary is the engine's. |
| Peers, lease, stamps | Checked. | Skipped. |
| Best for | Long multi-step work with a clear next action. | Exploratory work where the conversation itself matters. |

### Two ways to compact

**On the ready token: `restart.via: "compact"`.** Notes plan for a compaction ("Plan for a
compaction: finish the item in hand and keep new work small.") and ask for no handoff. The
note's tail reads "At the next safe point — no subagents running, current work recorded — end
your reply with a line holding only `CTX-READY`; ctx-guard then compacts the session." The
token runs the verdict minus the lease, handoff, stamp, peer and race checks, then
`/compact <compact.instructions>`. A refusal ends "Nothing was compacted." In manual mode the
note asks the model to tell you "ready for /compact".

**On a trigger: the `compact` action.** A trigger with `"do": ["compact"]` queues `/compact`
when it fires, with no token and no cooperation from the model. Use it as a backstop above
your note thresholds:

```jsonc
// in roles.<name>
"triggers": [
  { "id": "ctx-stop", "when": { "context": "70%" }, "do": ["note"], "level": "stop" },
  { "id": "squeeze",  "when": { "context": "85%" }, "do": ["compact"] }
],
"compact": { "instructions": "Keep open tasks, decisions made, and the file paths in play." }
```

`compact.instructions` is passed to `/compact` either way: say what the summary must keep.

### When a queued compact runs

| State | When | What happens |
|---|---|---|
| queued | The trigger fired. | Runs at once if no turn is running, else at the next turn end once no turn, restart, agent or background task is busy. One toast while it waits. |
| held | It fired within 5 minutes of a compact that ran. | Waits out the 5 minutes, then runs only if the context still crosses the threshold; otherwise it is dropped and the trigger re-arms. |
| blocked | `autoActions` off, repo untrusted, or ctx-guard paused. | One toast per reason. Runs once that lifts, if the trigger is still marked. |
| sent | `/compact` is running. | A ready token now refuses with `already-busy`. |

At most one compact waits. A queued compact is dropped when its trigger re-arms first, and on
`/clear`. A ready-token restart at the same turn end goes first; if it is refused, the compact
runs. Both ways need trust, `autoActions` on and no pause.
