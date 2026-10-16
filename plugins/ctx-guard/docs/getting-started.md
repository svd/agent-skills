# Getting started with ctx-guard

[← ctx-guard README](../README.md) · [All docs](README.md)

## How it works

| Concept | In one line |
|---|---|
| **Band** | One line of figures above the prompt (or on the status line). Always on unless `display: off`. |
| **Role** | A named set of settings (`main`, `lead`, `reviewer`, …). A session with no role gets toasts only; notes, blocks, budgets and restarts start once it has one. |
| **Trigger** | `when` a metric crosses a threshold, `do` actions. Metrics: context fill, 5-hour and weekly usage, time to a window's reset, session cost, idle time, prompt cache expiry, misses and pings. |
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
        "prompt": "Carry out Next action without waiting.",
        "minContext": "40%"
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
