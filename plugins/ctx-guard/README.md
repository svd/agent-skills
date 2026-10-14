# ctx-guard

A context and usage guard for Claude Code. ctx-guard watches how full the session's context is
and how much of your 5-hour and weekly usage windows is spent, and acts on what it sees by
config:

- draws a **band** above the prompt: `main · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h)`;
- shows **toasts** and OS **notifications** at thresholds you pick;
- sends the model **`[ctx-guard]` notes** that tell it to plan a handoff, wrap up or stop;
- **blocks tools** such as `Agent` while a usage window is nearly spent;
- caps each **subagent's** context by type;
- when the model ends a reply with a **ready token** (`CTX-READY`), runs a guarded `/clear` and
  resumes from a handoff file, or runs `/compact`.

Roles, thresholds, triggers, handoff instructions and budgets live in a JSON file in your repo.
No code changes are needed.

## Contents

- [Requirements](#requirements)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Handoff and restart](#handoff-and-restart)
- [Compact](#compact)
- [Use cases](#use-cases)
- [Troubleshooting](#troubleshooting)
- [Files ctx-guard writes](#files-ctx-guard-writes)
- [Further reading](#further-reading)

## Requirements

- Claude Code **2.1.293 or later**. On an older version ctx-guard shows a toast at session start
  and some checks may not work.
- ctx-guard is a **mod**: a TypeScript hooks module that Claude Code loads in-process. There is
  nothing to build and no `npm install`. Mods are a new plugin kind, and their API may still
  change.
- Interactive sessions. `claude -p` runs get no role, so they only see the band and toasts.

## How it works

| Concept | In one line |
|---|---|
| **Band** | One line of figures above the prompt (or on the status line). Always on unless `display: off`. |
| **Role** | A named set of settings (`main`, `lead`, `reviewer`, …). A session with no role gets toasts only; notes, blocks, budgets and restarts start once it has one. |
| **Trigger** | `when` a metric crosses a threshold, `do` actions. Metrics: context fill, 5-hour and weekly usage, time to a window's reset, session cost, idle time. |
| **Note** | A `[ctx-guard]` message to the model. Its wording follows the trigger's `level`: `soft` (plan a handoff), `hard` (wrap up), `stop` (start nothing new). |
| **Deny** | A trigger action that refuses named tool calls while its condition holds, and lifts by itself once it no longer does. |
| **Handoff** | A file the model rewrites before a restart: goal, state, next action. The resume reads it back. |
| **Ready token** | A last line holding only `CTX-READY`. With `restart.mode: "auto"` it starts a guarded restart. |
| **Verdict** | The checks a restart must pass: no agents or background tasks running, a fresh handoff, no peer restarting, your ready checks green, and more. Any failure refuses the restart and nothing is cleared. |
| **Trust** | Settings that run things unattended need your per-repo approval: `/ctx-guard trust`. |
| **Subagent budget** | Per-type token caps for subagents: a note at `warn`, a stop note and refused tool calls at `stop`. |

A typical cycle with automatic restart:

1. Context reaches 40 %. The model gets a `soft` note: finish the item in hand, keep new work
   small.
2. At 60 % a `hard` note: start no new item, bring the current one to a safe point.
3. At 75 % a `stop` note asks the model to rewrite `.ctx-guard/main-handoff.md` at the next safe
   point and end its reply with `CTX-READY`.
4. ctx-guard runs the verdict. If every check passes, it runs `/clear`, then
   `/ctx-guard:resume role=main handoff=.ctx-guard/main-handoff.md …`.
5. The fresh session reads the handoff, checks its claims against the repo (the recorded git
   `HEAD` is `HEAD` or an ancestor, the named paths exist) and carries out its Next action.

## Getting started

### 1. Install

```bash
# Add the marketplace (once)
/plugin marketplace add svd/agent-skills

# Install the plugin
/plugin install ctx-guard@svd-agent-skills
```

Start a new session. The band appears above the prompt after the first response.

### 2. Zero config: watch only

With no config file and no role, ctx-guard draws the band and shows toasts at 50 / 70 / 85 %
context and at 80 / 90 % of either usage window. It sends the model nothing, blocks nothing and
runs nothing on its own, so a user-scope install leaves the model's behaviour as it was.

Type `/ctx-guard` at any time for a report: role and where it came from, config files and their
errors, the effective config, live figures, fired triggers, active blocks and trust.

### 3. Turn on notes everywhere (no file)

Open `/config`, find ctx-guard and set **Default role** to `main`. Every interactive session now
gets the built-in ladder:

| Trigger | When | Does | Level |
|---|---|---|---|
| `ctx-soft` | context ≥ 40 % | note | soft |
| `ctx-hard` | context ≥ 60 % | note | hard |
| `ctx-stop` | context ≥ 75 %, then every 5 % | note | stop |
| `limit-soft` | either usage window ≥ 80 % | note | soft |
| `limit-hard` | either usage window ≥ 90 % | note, toast | hard |
| `week-80-early` | weekly ≥ 80 % with ≥ 2 days to its reset | note, deny `Agent`, `Workflow` | hard |
| `week-90-early` | weekly ≥ 90 % with ≥ 1 day to its reset | note, deny `Agent`, `Workflow` | hard |
| `limit-stop` | either usage window ≥ 95 % | note, toast, deny `Agent`, `Workflow`, `WebSearch`, `WebFetch` | stop |

Restarts stay manual: the notes ask the model to write a handoff and tell you "ready for
/clear". You run `/clear` yourself.

### 4. Add a project config

In the repo, type:

```text
/ctx-guard init
```

It writes the `solo` preset to `.claude/ctx-guard.json` (only if no file is there; it never
overwrites) and adds `.claude/ctx-guard.local.json` and `.ctx-guard/` to `.gitignore`. Use
`/ctx-guard init peers` for the two-session preset.

The `solo` preset is the built-in ladder written out, plus a handoff and **automatic** restart:

```jsonc
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "description": "the one long-running session in this project",
      "triggers": [ /* the eight triggers of the ladder above */ ],
      "handoff": {
        "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD, if this is a git repo. Sections: Goal, State, Next action."
      },
      "restart": {
        "mode": "auto",
        "prompt": "Carry out Next action without waiting."
      }
    }
  }
}
```

Review the file, change what you need, and commit it: it is the team file.

### 5. Approve automatic actions

Automatic restarts, `compact` actions and ready checks run without you, so they need approval
per repo:

```text
/ctx-guard trust
```

It re-reads the config and prints every approved value. Any later change to those settings, or
to a ready-check script in the repo, withdraws the approval until you run it again. Until then
notes, toasts and blocks still work, but the notes ask the model to tell you instead of sending
the token.

### 6. Check it

```text
/ctx-guard          # report: role "main" (source: project defaultRole), trust: approved
/ctx-guard check    # dry run of the restart verdict, check by check
```

`/ctx-guard check` writes nothing, clears nothing and races nobody. It shows which checks would
pass right now.

## Configuration

### Where settings live

Layers apply in this order; a later layer wins.

| # | Layer | Where | Holds |
|---|---|---|---|
| 1 | Built-ins | the plugin | One role `main` with the built-in ladder. |
| 2 | Switches | `/config` → ctx-guard | Machine-wide switches only (below). |
| 3 | Team file | `.claude/ctx-guard.json` | Roles, triggers, handoff, restart, budgets. Committed. |
| 4 | Local file | `.claude/ctx-guard.local.json` | Your personal overrides. Gitignored. |

Merge rules: objects merge key by key, **arrays replace** (a role's `triggers` list replaces the
built-in ladder as a whole), and `null` deletes a key so the built-in default applies. Each file
is validated on its own and must be valid alone. Unknown keys are errors.

ctx-guard re-reads the files at session start, on `/ctx-guard reload`, and after each turn when
a file's modification time changed. An invalid file shows a toast and keeps the last good
config; `/ctx-guard` lists the errors.

For editor completion, point `$schema` at the schema (ctx-guard ignores the key):

```json
{
  "$schema": "https://raw.githubusercontent.com/svd/agent-skills/main/plugins/ctx-guard/skills/guide/assets/ctx-guard.schema.json",
  "version": 1
}
```

### Switches (`/config`)

| Switch | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns ctx-guard off in every project. |
| `configPath` | `.claude/ctx-guard.json` | The team file, relative to the project root; the local file sits beside it as `*.local.json`. |
| `defaultRole` | `""` | Role when nothing else sets one. Empty for none. |
| `blocking` | `true` | `false` lifts every deny; notes and toasts go on. |
| `autoActions` | `true` | `false` stops automatic clear and compact; notes then ask the model to tell you. |
| `display` | `band` | `band`, `status` (status-line text only) or `off`. |

### Anatomy of a config file

```jsonc
{
  "version": 1,                         // required, always 1
  "defaultRole": "main",                // role for sessions nothing else assigns
  "contextWindow": "auto",              // or tokens, e.g. "400k": what context % counts against
  "stateDir": ".ctx-guard",             // stamps, leases, default handoffs
  "readyToken": "CTX-READY",

  "defaults": {                         // every role inherits these (objects deep-merge)
    "handoff": { "instructions": "…" },
    "restart": { "mode": "auto" }
  },

  "roles": {
    "main": {
      "description": "what the role is for",
      "triggers": [                     // replaces the built-in ladder
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" }
      ],
      "notes":   { "suffix": "A line appended to every note." },
      "handoff": { "path": ".ctx-guard/{role}-handoff.md", "style": "file", "instructions": "…" },
      "restart": {
        "mode": "auto",                 // auto | manual | off
        "via": "clear",                 // clear | compact
        "command": "ctx-guard:resume",  // run after /clear
        "prompt": "Carry out Next action without waiting.",
        "selfGap": "5m",                // min gap between this session's own restarts
        "minContext": "off",            // refuse the ready token below this fill ("40%", "300k")
        "peers": [], "peerGap": "10m",  // roles that must not restart within peerGap
        "readyChecks": []               // commands that must exit 0 before a restart
      },
      "compact": { "instructions": "What /compact must keep." }
    }
  },

  "subagents": {                        // per-type context budgets
    "*": { "warn": "120k", "stop": "170k" }
  }
}
```

(Comments are for this README only; the file is plain JSON.)

### Quantities

The field decides how a value reads: `"10m"` is ten minutes in a duration field and ten million
tokens in a token field.

| Kind | Forms |
|---|---|
| tokens | `150000`, `"300k"`, `"1.2M"` |
| percent | `"40%"`, or `80` where the field is a percent only (`limit.*`) |
| duration | `"500ms"`, `"10s"`, `"10m"`, `"2h"`, `"1d"` (unit required) |
| usd | `2.5`, `"$2.50"` |

### Triggers

```jsonc
// one entry of a role's "triggers" list
{ "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note", "toast"], "level": "stop" }
```

**`when`** is an AND of metrics, each holding at or above its threshold:

| Metric | Takes | Reads |
|---|---|---|
| `context` | tokens or percent | Main-loop context fill. A percent counts against `contextWindow`. |
| `limit.five_hour` | percent | 5-hour usage window. |
| `limit.seven_day` | percent | Weekly usage window. |
| `limit.any` | percent | The higher of the two. |
| `limit.five_hour.resetsIn` | duration | At least this long until the 5-hour reset. Needs `limit.five_hour` beside it. |
| `limit.seven_day.resetsIn` | duration | At least this long until the weekly reset. Needs `limit.seven_day` beside it. |
| `cost` | usd | Session cost. |
| `idle` | duration | Time since the last turn ended. |

`every` repeats a trigger in steps past its first threshold (`75%`, `80%`, `85%`, …). It works
on one of `context`, `limit.*` percents or `cost`.

**`do`** is a list of actions:

| Action | Fires | Does |
|---|---|---|
| `"note"` | once, on the rising edge | Sends the model a note (needs a role). |
| `"toast"` | once | A toast in the session. |
| `"notify"` | once | An OS notification. |
| `"compact"` | once | Runs `/compact` at the next safe turn end. Needs trust. |
| `{ "deny": ["Agent", "Workflow"] }` | while the AND holds | Refuses those main-loop tool calls. |

Edge actions fire once when the condition starts to hold, then re-arm when a metric drops below
its threshold (after `/compact`, after a usage window resets). `/clear` re-arms every trigger with
a `context` condition.

**`level`** (`soft`, `hard`, `stop`) picks the note wording; **`message`** adds your own text,
with variables such as `{role}`, `{tokens}`, `{percent}`, `{threshold}`, `{window}`, `{limit}`,
`{resetsIn}`, `{handoffPath}` and `{readyToken}`.

### What to block

A `deny` takes any main-loop tool by its exact name, built-in or MCP. Rules:

- Names match exactly: no wildcards, no prefixes. An MCP tool is written in full,
  `mcp__<server>__<tool>`. The model sees tool names in its tool list; `/mcp` shows a server's
  tools.
- Only main-loop calls are denied. A subagent's tools are left alone (use
  [subagent budgets](#6-coordinator-and-workers) for those).
- Denies apply only once the session has a role.
- A deny holds while its trigger's condition holds, judged afresh at every call, and lifts by
  itself when the condition stops holding. `/ctx-guard pause` or `blocking: false` lifts it now.
- A deny cannot share a trigger with `idle`.
- It fails open: an unknown metric or a failed check denies nothing.

Good candidates, when a usage window runs low:

| Tool | Why |
|---|---|
| `Agent` | Subagents: usually the biggest spender, each runs a whole context of its own. |
| `Workflow` | Multi-agent workflows: many subagents per call. |
| `WebSearch`, `WebFetch` | Search and page fetches pull large results into the context. |
| `mcp__claude-in-chrome__navigate`, `mcp__playwright__browser_navigate`, … | Browser automation: screenshots and page dumps are heavy. Block the navigation tools and the session cannot open new pages. |
| Your own heavy MCP tools | Anything that returns big documents, runs remote jobs or costs money per call. |

Leave these alone:

| Tool | Why not |
|---|---|
| `Write` | The model writes the handoff with it; blocking it breaks restarts with `no-handoff`. |
| `Read`, `Edit`, `Bash`, `Grep`, `Glob` | The session could not even bring its work to a safe point. |
| `SubagentHandback`, `StructuredOutput`, `ReportFindings` | They hand results back; blocking them loses work already paid for. |

A brake at 95 % that stops subagents, workflows and the web (the built-in `limit-stop` does
this):

```jsonc
// one entry of a role's "triggers" list
{ "id": "limit-brake", "when": { "limit.any": 95 }, "do": ["note", "toast", { "deny": ["Agent", "Workflow", "WebSearch", "WebFetch"] }], "level": "stop" }
```

A staged brake: subagents first, then the web and the browser as the window keeps filling:

```jsonc
{ "id": "brake-agents", "when": { "limit.any": 85 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard" },
{ "id": "brake-web",    "when": { "limit.any": 95 }, "do": ["note", "toast", { "deny": ["WebSearch", "WebFetch", "mcp__claude-in-chrome__navigate"] }], "level": "stop" }
```

Both triggers hold at 95 %, so their denies add up: everything in both lists is blocked.

A deny also works on context, not only usage. This one stops new subagents once the main
context is past 70 %, when their reports would crowd out what is left:

```jsonc
{ "id": "ctx-no-agents", "when": { "context": "70%" }, "do": [{ "deny": ["Agent", "Workflow"] }] }
```

The `guide` skill tells the model not to route around a block with another tool that does the
same job (for example `curl` through `Bash` instead of `WebFetch`). That is an instruction, not
an enforcement: to be strict, add a permission rule as well.

### Roles

A session takes the first role it finds:

1. `/ctx-guard role <name|none>`, typed by you (or `/ctx-guard:resume role=<name> …` in a
   session with no role);
2. the `CTX_GUARD_ROLE` environment variable (`none` means no role);
3. the project's `defaultRole`, then the `defaultRole` switch.

Role names match `^[a-z][a-z0-9-]{0,31}$` and must exist in `roles`. A bad name gives no role
and a toast; it never falls through to the next source. One live session holds a role at a
time (a lease in `.ctx-guard/<role>.owner`); a second one gets a warning and cannot restart.

### Commands

| Command | Who | Does |
|---|---|---|
| `/ctx-guard` | anyone | Report. |
| `/ctx-guard role <name\|none>` | you | Set this session's role. |
| `/ctx-guard check` | you | Dry-run the restart verdict. |
| `/ctx-guard trust` | you | Approve the repo's restart, ready-check and compact settings. |
| `/ctx-guard reload` | anyone | Re-read the config files now. |
| `/ctx-guard pause [30m\|off]` | you | Lift blocks and automatic actions for a while (default 30 min); notes go on. |
| `/ctx-guard init [solo\|peers]` | you | Write a starter config if there is none, plus `.gitignore` lines. |
| `/ctx-guard:resume role=<r> handoff=<path> [prompt]` | ctx-guard or you | Resume from a handoff after `/clear`. |
| `/ctx-guard:guide` | anyone | The skill: how the model answers notes, and how to configure ctx-guard. |

"You" means typed in the prompt box. ctx-guard refuses these subcommands when the model or
another plugin sends them, so the model cannot pause, trust or re-role itself out of a note.

## Handoff and restart

A restart frees the context by `/clear` and carries the work over through a **handoff**: a
file the model writes before the clear and the fresh session reads after it. ctx-guard never
writes the handoff itself; it tells the model when and what to write, checks the file is
there and fresh, and runs the clear and the resume.

### Restart modes

`restart.mode` decides how a note ends and what the ready token does.

| Mode | The note ends with | The ready token |
|---|---|---|
| `auto` | "At the next safe point — no subagents running, current work recorded — rewrite `<handoff>`: *instructions* Then end your reply with a line holding only `CTX-READY`." | Starts a guarded `/clear` and resume. |
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
| `handoff.style` | `file` | `file`: the model rewrites the path with the Write tool. `session-handoff`: it uses the session-handoff skill, and the handoff is the newest `.md` in `.claude/session-handoffs/ctx-guard-<role>/`. |
| `handoff.instructions` | none | What the handoff must hold. Quoted in the note, so this is where you shape it. |

The model rewrites the whole file each time, never appends. Make every claim checkable: the
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

### The verdict

When the token arrives in `auto` mode, ctx-guard runs these checks in order right after the
turn. The first that fails refuses the restart with a toast and a note to the model
(`[ctx-guard] CTX-READY ignored (<code>): <reason>. Nothing was cleared.`); nothing is cleared.

1. `untrusted`: the repo's restart settings are approved.
2. `already-busy`: no restart, compact or resume is under way.
3. `not-needed`: context is at or above `restart.minContext` (default `"off"`: not checked).
4. `too-soon`: this session's last restart was at least `restart.selfGap` (default `5m`) ago.
5. `no-restart-command`: the resume command exists in this session.
6. `agents-running`, `background-tasks`: no subagent, workflow agent or background shell runs.
7. `role-shared`: no other live session holds this role.
8. `no-handoff`, `handoff-stale`: the handoff exists, is not empty, and was written after the
   session start or the last `/clear`.
9. `stamp-unreadable`, `peer-restarting`: no peer role restarted within `restart.peerGap`.
10. `ready-check-failed`: every `restart.readyChecks` command exits 0.
11. `race-lost`: no peer started its restart at the same moment.

`/ctx-guard check` runs the same checks as a dry run. The full list with fixes is under
[Troubleshooting](#ctx-ready-ignored-code).

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
same `role=… handoff=… <prompt>` arguments.

### A manual restart

With `mode: "manual"`, do by hand what ctx-guard would do: when the model says
"ready for /clear", type `/clear`, then
`/ctx-guard:resume role=<role> handoff=<path>`. Typed in a session with no role, the resume
also claims that role.

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

## Use cases

Every example is a complete `.claude/ctx-guard.json` unless it says otherwise. After writing one
that restarts or compacts on its own, run `/ctx-guard trust`.

### 1. Just watch the figures

No file at all. Install the plugin and leave `defaultRole` empty: band plus toasts at 50 / 70 /
85 % context and 80 / 90 % usage. Prefer the status line? Set `display` to `status` in
`/config`.

### 2. Notes with manual restarts

The model gets the built-in ladder and tells you when it is ready; you decide when to clear.
Either set the `defaultRole` switch to `main` (all projects), or commit this (one project):

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "handoff": { "instructions": "Rewrite the whole file. Sections: Goal, State, Next action." },
      "restart": { "mode": "manual" }
    }
  }
}
```

When the model says "ready for /clear", type `/clear` and then
`/ctx-guard:resume role=main handoff=.ctx-guard/main-handoff.md`. No trust needed.

### 3. Solo session with automatic clear and resume

One long-running session that keeps working across many context windows. This is the `solo`
preset (`/ctx-guard init`), shown here without its usage triggers:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-hard", "when": { "context": "60%" }, "do": ["note"], "level": "hard" },
        { "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note"], "level": "stop" }
      ],
      "handoff": {
        "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD, if this is a git repo. Sections: Goal, State, Next action."
      },
      "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting." }
    }
  }
}
```

A `triggers` list replaces the whole built-in ladder, usage brakes included. Keep the preset's
`limit-*` and `week-*` triggers if you want them.

### 4. Never clear with uncommitted work

Add a ready check that refuses the restart while `git status` shows changes. Ask Claude to copy
`clean-worktree.sh` from the `guide` skill's `assets/ready-checks/` folder into
`.claude/ctx-guard/`, then:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "restart": {
        "mode": "auto",
        "readyChecks": [{ "run": ["sh", ".claude/ctx-guard/clean-worktree.sh", "--tracked-only"], "timeout": "10s" }]
      }
    }
  }
}
```

A failing check refuses with `ready-check-failed` and quotes the script's output, so the model
sees what to commit. Checks run without a shell, from the project root, in order; exit 0
passes. Trust hashes the script, so editing it needs `/ctx-guard trust` again.

### 5. Compact instead of clear

The session keeps its context, summarised, instead of starting over from a handoff (see
[Compact](#compact)). Notes ask for the ready token; `squeeze` compacts at 85 % even if the model has not sent it.

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "50%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-stop", "when": { "context": "70%" }, "do": ["note"], "level": "stop" },
        { "id": "squeeze", "when": { "context": "85%" }, "do": ["compact"] }
      ],
      "restart": { "mode": "auto", "via": "compact" },
      "compact": { "instructions": "Keep open tasks, decisions made, and the file paths in play." }
    }
  }
}
```

A queued compact waits for a turn end with no agent or background task running. A second
compact within 5 minutes of one that ran is held and dropped if the context has already fallen.

### 6. Coordinator and workers

One long-lived coordinator dispatches subagents. Budgets keep each worker small, and the
coordinator stops dispatching near the usage limit.

```json
{
  "version": 1,
  "defaultRole": "coordinator",
  "roles": {
    "coordinator": {
      "description": "plans the work, dispatches subagents and reviews their results",
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-hard", "when": { "context": "60%" }, "do": ["note"], "level": "hard" },
        { "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note", "toast"], "level": "stop" },
        { "id": "usage-hard", "when": { "limit.any": 85 }, "do": ["note"], "level": "hard" },
        { "id": "usage-brake", "when": { "limit.any": 95 }, "do": ["note", "notify", { "deny": ["Agent", "Workflow"] }], "level": "stop" }
      ],
      "handoff": {
        "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD. Sections: Goal, Dispatched work and results, Next action."
      },
      "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting." }
    }
  },
  "subagents": {
    "*": { "warn": "120k", "stop": "170k" },
    "Explore": { "warn": "100k", "stop": "150k", "message": "Budget of {stop} reached: return your findings now." },
    "fork": { "warn": "off", "stop": "250k" }
  }
}
```

How budgets work:

- A plain subagent uses its type's entry merged over `"*"`. A fork or a teammate gets a budget
  only from an entry naming its type, `fork` or `teammate`.
- Past `warn` the subagent gets one note to wrap up. Past `stop` it gets a stop note, and its
  further tool calls are refused, except the ones that hand its report back
  (`SubagentHandback`, `StructuredOutput`, `ReportFindings`).
- `"off"` drops a step. Budgets are tokens only, since a subagent's model may differ.
- The band shows `sub N!` while N subagents are past `warn`.

### 7. Peer sessions

Two long-lived sessions, `lead` and `reviewer`, that message each other by name. This is the
`peers` preset (`/ctx-guard init peers`), trimmed:

```json
{
  "version": 1,
  "defaults": {
    "handoff": {
      "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD. Sections: Goal, State, Open questions for the peer, Next action."
    },
    "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting.", "peerGap": "10m" }
  },
  "roles": {
    "lead": {
      "notes": { "suffix": "Before you stop, send the reviewer session a short message: what you finished and what you hand over." },
      "restart": { "peers": ["reviewer"] }
    },
    "reviewer": {
      "notes": { "suffix": "Before you stop, send the lead session a short message: what you reviewed and what is still open." },
      "restart": { "peers": ["lead"] }
    }
  }
}
```

Start each session with its role and a name the other can address:

```sh
CTX_GUARD_ROLE=lead claude --name lead
CTX_GUARD_ROLE=reviewer claude --name reviewer
```

Or type `/ctx-guard role reviewer` in a running session. `restart.peers` with `peerGap` keeps the
two from clearing within ten minutes of each other; if both pass every check at once, the older
stamp wins and the other refuses with `race-lost`.

### 8. Usage-limit brake

Notes as the usage windows fill, a desktop notification near the weekly limit, no new subagents
past 95 %, a toast at $25 of session cost, and a reminder when a big context sits idle long
enough for the prompt cache to expire.

```json
{
  "version": 1,
  "roles": {
    "main": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-hard", "when": { "context": "60%" }, "do": ["note"], "level": "hard" },
        { "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note"], "level": "stop" },
        { "id": "five-hour", "when": { "limit.five_hour": 80 }, "do": ["note", "toast"], "level": "soft" },
        { "id": "weekly", "when": { "limit.seven_day": 90 }, "do": ["note", "notify"], "level": "hard" },
        { "id": "brake", "when": { "limit.any": 95 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "stop" },
        { "id": "spend", "when": { "cost": "$25" }, "do": ["toast"] },
        { "id": "idle-cache", "when": { "idle": "50m", "context": "150k" }, "do": ["notify"] }
      ]
    }
  }
}
```

This file has no `defaultRole`: the role comes from the `defaultRole` switch, `CTX_GUARD_ROLE`
or `/ctx-guard role main`. No trust is needed; nothing here runs on its own.

### 9. Early-spend brake

A weekly window spent fast early on leaves days with little to work with. These triggers stop
new subagents sooner the earlier the window fills, and lift by themselves as the reset nears:

```jsonc
// entries for a role's "triggers" list
{ "id": "week-80-early", "when": { "limit.seven_day": 80, "limit.seven_day.resetsIn": "2d" }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard" },
{ "id": "week-90-early", "when": { "limit.seven_day": 90, "limit.seven_day.resetsIn": "1d" }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard" },
{ "id": "week-95",       "when": { "limit.seven_day": 95 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "stop" }
```

At 85 % with 30 hours left, `week-80-early` no longer holds (under two days) and `week-90-early`
has not started (under 90 %), so subagents run again. The two early triggers are in the built-in
ladder already, beside `limit-stop` at 95 % of either window; copy them into your own `triggers`
list, since that list replaces the ladder.

### 10. Absolute thresholds on a large window

Percent thresholds count against `contextWindow`. On a 1M-token model 40 % is 400k, which may
be later than you want. Use tokens instead, or pin the window:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "200k" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-hard", "when": { "context": "300k" }, "do": ["note"], "level": "hard" },
        { "id": "ctx-stop", "when": { "context": "400k", "every": "50k" }, "do": ["note"], "level": "stop" }
      ]
    }
  }
}
```

Or keep percents and set `"contextWindow": "500k"`: then 40 % is 200k on every model.

### 11. Handoffs through the session-handoff skill

If you use the `session-handoff` plugin from this marketplace, let it write the handoff:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "handoff": { "style": "session-handoff" },
      "restart": { "mode": "auto" }
    }
  }
}
```

Notes then ask for a handoff with the skill under the project slug `ctx-guard-main`, and the
restart reads the newest `.md` in `.claude/session-handoffs/ctx-guard-main/`.

### 12. A personal override

`.claude/ctx-guard.local.json` changes the team file for you alone. This one keeps restarts
manual for `lead` and drops the team's note suffix:

```json
{
  "version": 1,
  "roles": {
    "lead": {
      "notes": { "suffix": null },
      "restart": { "mode": "manual" }
    }
  }
}
```

### 13. Turning it down or off

| You want | Do |
|---|---|
| No blocks or automatic actions for a while | `/ctx-guard pause 1h` (`/ctx-guard pause off` to end it). Notes go on. |
| Never block tools on this machine | `/config` → `blocking` off. |
| Never clear or compact on its own on this machine | `/config` → `autoActions` off. Notes then ask the model to tell you. |
| No role in this session | `/ctx-guard role none`, or start with `CTX_GUARD_ROLE=none`. |
| Off in one project | `"enabled": false` in that project's config file. |
| Off everywhere | `/config` → `enabled` off. |

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
| Percents fire too late or too early | `contextWindow: "auto"` counts against the engine's compaction window (or the model window lowered to `autoCompactWindow`). | Set `contextWindow` to a token figure, or use token thresholds ([use case 10](#10-absolute-thresholds-on-a-large-window)). |

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
| `untrusted` | Restart settings not approved, or changed since. | Read `/ctx-guard`, then `/ctx-guard trust`. |
| `no-handoff`, `handoff-stale` | The handoff is missing, empty, or older than the session start or last `/clear`. | The model rewrites it and sends the token again. |
| `agents-running` | A subagent or workflow agent is still running (or was seen in the last 15 min with no end). | Let it finish or stop it. |
| `background-tasks` | Background shells are running, or no turn end has reported yet. | Stop them; finish one turn. |
| `not-needed` | Context is below `restart.minContext`. | Nothing to do; the model goes on working. Lower `restart.minContext` or set it to `"off"`. |
| `too-soon` | This session restarted less than `restart.selfGap` (default `5m`) ago. | Wait, or set `"selfGap": "0"`. |
| `role-shared` | Another live session holds this role's lease. | End the other session or give it another role. A dead session's lease expires after 15 minutes. |
| `peer-restarting`, `race-lost` | A peer restarted less than `peerGap` ago, or won a simultaneous restart. | Wait out the gap. |
| `ready-check-failed` | A ready check exited non-zero, timed out or could not start. The reason ends with its output. | Fix what it flags (commit the work). See below for the clean-worktree pitfall. |
| `no-restart-command` | `/<restart.command>` is not a command in this session. | Fix `restart.command`, or install the plugin or project command it names. |
| `stamp-unreadable` | A `.ctx-guard/<role>.restart` stamp holds garbage. | Delete that file. |
| `already-busy` | A restart, compact or resume is already under way. | Wait. |
| `error` | Anything else: a path resolving outside the root through a symlink, `/clear` refused, a failed read. | Read the reason; `/ctx-guard check` shows each check. |

### `clean-worktree.sh` always fails

The handoff and ctx-guard's own files count as changes unless gitignored. `/ctx-guard init`
gitignores `.ctx-guard/`; add `.claude/session-handoffs/` for `handoff.style:
"session-handoff"`, and any `handoff.path` outside `stateDir`. Or pass `--tracked-only` so
untracked files are ignored.

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

## Further reading

- [Config reference](skills/guide/references/config-reference.md): every key, default, refusal
  code and trust rule, plus recipes.
- [JSON Schema](skills/guide/assets/ctx-guard.schema.json) for config v1.
- Presets: [solo](skills/guide/assets/presets/solo.json),
  [peers](skills/guide/assets/presets/peers.json).
- [Ready-check example](skills/guide/assets/ready-checks/clean-worktree.sh).
- [The guide skill](skills/guide/SKILL.md): how the model answers notes, refusals and budgets.
- [CHANGELOG](CHANGELOG.md).
