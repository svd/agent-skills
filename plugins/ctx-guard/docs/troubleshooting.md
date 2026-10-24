# Troubleshooting ctx-guard

[← ctx-guard README](../README.md) · [All docs](README.md)

## Troubleshooting

`/ctx-guard` is the first thing to run: it shows the role and its source, config errors, trust,
live figures, fired triggers, active blocks, the lease and the last restart verdict.
`/ctx-guard check` explains why a restart would or would not go through.

### Nothing shows up

| Symptom | Cause | Fix |
|---|---|---|
| No band, no toasts | `display` is `off`, or ctx-guard is disabled (`enabled` switch, or `"enabled": false` in the project). | Check `/config` and the project file. |
| No band, but `/ctx-guard` works | The surface draws no band above the prompt. | ctx-guard falls back to the status line; or set `display: status`. |
| No context figure on the band yet | Context is unknown before the first response and right after `/clear`. | Expected; it fills in after the next reply. |
| Toast "ctx-guard needs Claude Code 2.1.293 or later" | Old Claude Code. | Update Claude Code. |
| Toast "ctx-guard is off: /ctx-guard already belongs to …" | Another plugin registered `/ctx-guard`. | Disable that plugin; ctx-guard does nothing while it owns the name. |
| Toast "the /ctx-guard command is unavailable (…)" | A skill or command named `ctx-guard:ctx-guard` took the bare name, or registration failed. | Notes, blocks and the band still work; remove the clashing skill or command to get the command back. |

### The band is there, but the model gets no notes

The session has no role. ctx-guard toasts only until it has one. `/ctx-guard` shows
`role: none`. Fix one of:

- `defaultRole` in the project file, or the `defaultRole` switch;
- `CTX_GUARD_ROLE=<role> claude`;
- `/ctx-guard role <name>`.

Also check: `claude -p` runs never get a role; a role name must exist in `roles` (a typo gives no
role and a toast, not a fallback); and `CTX_GUARD_ROLE=none` beats `defaultRole`.

### My config is ignored

| Symptom | Cause | Fix |
|---|---|---|
| Toast "config has N errors; …" | Bad JSON, an unknown key or a bad value. ctx-guard keeps the last good config (or built-ins with automatic actions off). | `/ctx-guard` lists each error with its file and path. Validate against the schema in your editor. |
| An edit has no effect yet | Files are re-read after the next turn. | `/ctx-guard reload`. |
| My value is overridden | `.claude/ctx-guard.local.json` wins over the team file. | Check the local file; `/ctx-guard` shows the effective config. |
| Usage brakes disappeared | A `triggers` list replaces the built-in ladder as a whole. | Copy the `limit-*` and `week-*` triggers from the `solo` preset into your list. |
| `defaults.triggers` ignored for one role | That role has its own `triggers`; arrays replace. | Put the full list in the role, or remove the role's list. |
| Error on `every` | The `when` must have exactly one steppable metric (`context`, a `limit.*` percent or `cost`), and the step's unit must match. | `{ "context": "75%", "every": "5%" }`, not `"every": "50k"` on a percent. |
| Error on `.resetsIn` | It needs its window's percent in the same `when`. | `{ "limit.seven_day": 80, "limit.seven_day.resetsIn": "2d" }`. |
| Error on a path | `stateDir`, `handoff.path` and `configPath` must be relative, under the root, letters, digits and `. _ - /` only. | Use e.g. `.ctx-guard/{role}-handoff.md`. |
| Percents fire too late or too early | `contextWindow: "auto"` counts against the engine's compaction window (or the model window lowered to `autoCompactWindow`). | Set `contextWindow` to a token figure, or use token thresholds ([use case 10](use-cases.md#10-absolute-thresholds-on-a-large-window)). |

### The cache countdown is missing, wrong or says `cold`

| Symptom | Cause | Fix |
|---|---|---|
| No `cache` segment | It shows only while the session is idle, once the first main-loop request has run, and when the time left is within `cache.band.show` (15 minutes of a 1-hour cache by default). | Wait for the window, or set `cache.band.show` to `"always"`. |
| `cache ~8m` | The TTL is a guess: the transcript has not told it yet. | Set `cache.ttl` to `"5m"` or `"1h"`. |
| `cache cold` | The cache expired, or a ping found it already expired. | The next request re-writes the prefix; the band clears then. |
| A `ping` trigger never pings | It needs a role, `/ctx-guard trust`, `autoActions` on, no pause, `times` and `cache.expiresIn` in its `when`; the threshold must be below the TTL less 90 seconds (under 3m30s for a 5-minute cache), or the trigger pings once and never re-arms; a usage window at `cache.ping.maxUsage` also stops it. | Read `/ctx-guard`; the band shows `untrusted` when approval is missing. |

### The model says "ready for /clear" instead of restarting

A note promises an automatic restart only when ctx-guard would act on the token. It falls back
to asking you when:

- `restart.mode` is `manual` (or the local file sets it);
- the repo is not trusted, or trust was withdrawn by an edit: run `/ctx-guard trust`;
- `autoActions` is off in `/config`;
- ctx-guard is paused: `/ctx-guard pause off`.

### "CTX-READY ignored (code)"

The restart was refused and nothing was cleared. The model knows how to react to most codes;
the ones below need you.

| Code | Meaning | Fix |
|---|---|---|
| `untrusted` | Restart settings not approved, or changed since. The band shows `untrusted`. | Read `/ctx-guard`, then `/ctx-guard trust`. |
| `no-handoff`, `handoff-stale` | The handoff is missing, empty, or older than the session start or last `/clear`. | The model rewrites it and sends the token again. |
| `agents-running` | A subagent or workflow agent is still running (or was seen in the last 15 min with no end). | Let it finish or stop it. |
| `background-tasks` | Background tasks are running (the reason names each one's type and id), or no turn end has reported yet. | Let them finish, or stop one by its id; finish one turn. A type that runs on safely through a restart can go in `restart.ignoreBackground`. |
| `not-needed` | Context is below `restart.minContext`. | Nothing to do; the model goes on working. Lower `restart.minContext` or set it to `"off"`. |
| `too-soon` | This session restarted less than `restart.selfGap` (default `1m`) ago. | Wait, or set `"selfGap": "0"`. |
| `role-shared` | Another live session holds this role's lease. | End the other session or give it another role. A dead session's lease expires after 15 minutes. |
| `peer-restarting`, `race-lost` | A peer restarted less than `peerGap` ago, or won a simultaneous restart. | Wait out the gap. |
| `ready-check-failed` | A ready check exited non-zero, timed out or could not start. The reason ends with its output. | Fix what it flags (commit the work). See below for the clean-worktree pitfall. |
| `no-restart-command` | `/<restart.command>` is not a command in this session. | Fix `restart.command`, or install the plugin or project command it names. |
| `stamp-unreadable` | A `.ctx-guard/<role>.restart` stamp holds garbage. | Delete that file. |
| `already-busy` | A restart, compact or resume is already under way. | Wait. |
| `error` | Anything else: a path resolving outside the root through a symlink, `/clear` refused, a failed read. | Read the reason; `/ctx-guard check` shows each check. |

### `clean-worktree.sh` always fails

The handoff and ctx-guard's own files count as changes unless gitignored. `/ctx-guard init`
gitignores `.ctx-guard/`; add any `handoff.path` outside `stateDir`, and
`.claude/session-handoffs/` with [recipe 11](use-cases.md#11-handoffs-through-the-session-handoff-skill).
Or pass `--tracked-only` so untracked files are ignored.

### Tools are blocked

A deny reads `[ctx-guard] Agent is blocked by trigger "<id>": …` with the figures and what lifts
it. Denies lift by themselves once the condition stops holding (a window resets, or for the
early weekly brakes, the reset gets close enough). To lift them now: `/ctx-guard pause`, or turn
`blocking` off in `/config`. To change them, edit or drop the trigger. Denies match tool names
exactly, so `"Agent"` does not cover `"Workflow"`; list both if you want both blocked.

### A subagent's tool calls are refused

It passed its `stop` budget. It is told to return its report; the handback tools still work.
Raise `stop` for that type, set `"stop": "off"`, or pause ctx-guard. A reload does not lift the
deny; ctx-guard forgets the subagent when it completes.

### "only the operator can run /ctx-guard …"

The model (or another plugin) tried `role`, `check`, `trust`, `pause` or `init`. These are
yours alone. Type the command yourself if you want it.

### After a restart

| Symptom | Cause | Fix |
|---|---|---|
| Band shows "restart failed — type /…" | `/clear` ran but the resume command did not. | Type the command the band shows. |
| Toast "a reload interrupted a restart before /clear; nothing was cleared." | The plugin reloaded mid-restart. | Nothing lost; the model sends the token again at the next note. |
| The resume stops and lists mismatches | The handoff's git `HEAD` is not `HEAD` or an ancestor (history rewritten), or a named path is gone. | Check the handoff, fix it or tell the model how to go on. |
| A note asks for another restart right after one | The resumed session already passed the role's lowest context threshold (a large handoff or a heavy first step). | Shorten the handoff instructions, or raise the lowest threshold. `/ctx-guard check` warns about this. |
| A trigger fired once and never again | Edge actions fire once per rising edge and re-arm only when the metric drops below the threshold. | Expected. Use `every` for repeating notes. |

### Peer sessions do not receive each other's messages

Cross-session messaging is on by default. Name each session (`claude --name <name>`, or
`/rename <name>`), and list the reachable ones with `/peers`. If messages still do not arrive,
check that the `crossSessionInbound` setting is not `hold` or `refuse` and that no permission
deny rule covers `SendMessage`.

## Files ctx-guard writes

All under the project root, in `stateDir` (default `.ctx-guard/`, gitignored by `init`):

| File | What |
|---|---|
| `<role>-handoff.md` | The default handoff path; the model writes it. |
| `<role>.restart` | Restart stamp: when this role last restarted. Peers read it for `peerGap`. |
| `<role>.owner` | Role lease: session id and heartbeat, every 5 minutes. |

Trust approvals live in ctx-guard's own store on your machine, keyed by the project root, not
in the repo.
