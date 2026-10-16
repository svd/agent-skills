# Use cases

[← ctx-guard README](../README.md) · [All docs](README.md)

Every example is a complete `.claude/ctx-guard.json` unless it says otherwise. After writing one
that restarts or compacts on its own, run `/ctx-guard trust`.

## 1. Just watch the figures

No file at all. Install the plugin and leave `defaultRole` empty: band plus toasts at 50 / 70 /
85 % context and 80 / 90 % usage. Prefer the status line? Set `display` to `status` in
`/config`.

## 2. Notes with manual restarts

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

At 40 % the model gets a note like this:

> [ctx-guard] Context is at 400k (40% of 1M), past 40%. Plan for a handoff: finish the item in
> hand and keep new work small. At the next safe point — no subagents running, current work
> recorded — write the handoff to `.ctx-guard/main-handoff.md`: Rewrite the whole file.
> Sections: Goal, State, Next action. Then tell the operator 'ready for /clear'.

It finishes the item in hand, writes the handoff and says "ready for /clear". Then:

1. Read `.ctx-guard/main-handoff.md` if you want to check it.
2. Type `/clear`.
3. Type `/ctx-guard:resume role=main handoff=.ctx-guard/main-handoff.md`. Text after the path
   is passed on as the prompt, e.g. `… Carry out Next action without waiting.`

Not a good moment? Keep working: the notes at 60 % and from 75 % (every 5 %) ask again. No
trust needed, since nothing runs without you. With `"via": "compact"` the note asks for no
handoff and the model says "ready for /compact": type `/compact` yourself.

## 3. Solo session with automatic clear and resume

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
      "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting.", "minContext": "40%" }
    }
  }
}
```

A `triggers` list replaces the whole built-in ladder, usage brakes included. Keep the preset's
`limit-*` and `week-*` triggers if you want them.

A role without `triggers` gets the built-in ladder, usage brakes and all, so the shortest
version is:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "handoff": { "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD. Sections: Goal, State, Next action." },
      "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting." }
    }
  }
}
```

At a safe point the model rewrites `.ctx-guard/main-handoff.md` and ends its reply with
`CTX-READY`. ctx-guard checks that no agent is running and the handoff is fresh, clears, and
resumes from the handoff.

## 4. Never clear with uncommitted work

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

Every check also gets `CTX_GUARD_*` environment variables (the role, the handoff path and
mtime, the bound the handoff must be newer than), so a project check can judge the handoff
itself; see [What a check is told](../skills/guide/references/config-reference.md#what-a-check-is-told).

## 5. Compact instead of clear

The session keeps its context, summarised, instead of starting over from a handoff (see
[Compact](handoff-and-restart.md#compact)). Notes ask for the ready token; `squeeze` compacts at 85 % even if the model has not sent it.

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

## 6. Coordinator and workers

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

## 7. Peer sessions

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

Cross-session messaging is on by default, with no setting to turn on; `/rename <name>` names a
session later, and `/peers` (alias of `/list-agents`) lists the sessions this one can reach. If
messages do not arrive, see
[Troubleshooting](troubleshooting.md#peer-sessions-do-not-receive-each-others-messages).

## 8. Usage-limit brake

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
or `/ctx-guard role main`. No trust is needed; nothing here runs on its own. To keep the cache
alive, see [18. Stepped away](#18-stepped-away).

## 9. Early-spend brake

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

## 10. Absolute thresholds on a large window

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

## 11. Handoffs through the session-handoff skill

Any skill can write the handoff: name it in `handoff.instructions`. This recipe uses the
`session-handoff` plugin from this repo (`plugins/session-handoff`). Install it:

```
/plugin marketplace add svd/agent-skills
/plugin install session-handoff@svd-agent-skills
```

Then point the role at it:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "handoff": {
        "path": ".ctx-guard/{role}-handoff.md",
        "instructions": "Write it with the session-handoff skill (project slug `ctx-guard-{role}`, its handoff tool run from the project root), then copy the result to this path. Sections: Goal, State, Next action."
      },
      "restart": { "mode": "auto" }
    }
  }
}
```

The copy is needed because the skill saves dated files under `.claude/session-handoffs/<slug>/`,
while ctx-guard checks and resumes from `handoff.path`.

## 12. Project status on the band

A band probe puts a project script's output on the band. Ask Claude to copy `git-branch.sh` from
the `guide` skill's `assets/probes/` folder into `.claude/ctx-guard/`, then:

```json
{
  "version": 1,
  "defaultRole": "main",
  "band": {
    "probes": [{ "id": "git", "run": ["sh", ".claude/ctx-guard/git-branch.sh"], "every": "60s" }]
  }
}
```

Run `/ctx-guard trust`: probes run only in a trusted repo, and trust hashes the script. The band
then reads `main · 312k (31%) · 5h 42% · feat/x`, the branch in warning colour while the
worktree has changes. A probe prints its segment on the first line and an optional colour on
the second; printing nothing draws nothing, and a failing probe draws `git ?`. `/ctx-guard`
reports each probe's last run. See
[Band probes](../skills/guide/references/config-reference.md#band-probes).

## 13. Builders in git worktrees

A lead session hands items to builder agents, each in its own `git worktree add` checkout, and
keeps its handoff in git so a peer can read it. Three ready checks keep a `/clear` from losing
that work: the handoff is committed (`handoff-committed.sh`), no worktree has uncommitted work
(`worktrees-committed.sh`), and the handoff was committed after the newest worktree commit
(`handoff-after-worktrees.sh`), so what it says about the builders is current. The `worktrees.sh`
probe puts each worktree's head on the band. Ask Claude to copy the four scripts from the `guide`
skill's `assets/ready-checks/` and `assets/probes/` folders into `.claude/ctx-guard/`, then:

```json
{
  "version": 1,
  "defaultRole": "lead",
  "defaults": {
    "handoff": { "path": "docs/handoff/{role}.md" },
    "restart": {
      "mode": "auto",
      "readyChecks": [{ "run": ["sh", ".claude/ctx-guard/handoff-committed.sh"], "timeout": "10s" }]
    }
  },
  "roles": {
    "lead": {
      "restart": {
        "readyChecks": [
          { "run": ["sh", ".claude/ctx-guard/handoff-committed.sh"], "timeout": "10s" },
          { "run": ["sh", ".claude/ctx-guard/worktrees-committed.sh"], "timeout": "20s" },
          { "run": ["sh", ".claude/ctx-guard/handoff-after-worktrees.sh"], "timeout": "10s" }
        ]
      }
    },
    "design": {}
  },
  "band": {
    "probes": [{ "id": "worktrees", "run": ["sh", ".claude/ctx-guard/worktrees.sh"], "every": "60s", "timeout": "10s" }]
  }
}
```

Arrays replace, so `lead` repeats `handoff-committed.sh`; `design` keeps the one from
`defaults`. The band reads `lead · 312k (31%) · wt-a 1d57fff +3`, in warning colour while a
worktree has uncommitted files or the role's handoff has uncommitted changes. ctx-guard already
waits for running subagents (`agents-running`), so a builder still at work refuses on its own.

## 14. Jobs that run outside the session

When a launcher runs work as separate processes, ctx-guard cannot see it the way it sees
subagents. `jobs-quiet.py` refuses a restart while a job is running, and while the handoff is
not newer than the newest job. Its contract: a job writes `<name>.pid` into a job folder when it
starts and `<name>.rc` when it exits. Copy it from `assets/ready-checks/`, then:

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "restart": {
        "mode": "auto",
        "readyChecks": [{ "run": ["python3", "-I", ".claude/ctx-guard/jobs-quiet.py", ".runs/*/jobs"], "timeout": "20s" }]
      }
    }
  }
}
```

The arguments are folder globs under the project root; with none it reads `.jobs`.

## 15. A superpowers plan's progress on the band

The superpowers plugin's subagent-driven-development and executing-plans skills keep a ledger
per plan at `.superpowers/sdd/<plan>/progress.md`. The `superpowers-plan.py` probe reads the
newest one and shows how many of the plan's tasks are complete. Copy it from `assets/probes/`,
then:

```json
{
  "version": 1,
  "band": {
    "probes": [{ "id": "plan", "run": ["python3", "-I", ".claude/ctx-guard/superpowers-plan.py"], "every": "60s" }]
  }
}
```

The band reads `plan 6/7 releasing-a-version-v2`, or `plan 8 done <name>` when the plan file is
gone. Nothing shows before the first task is complete or after the last. The ledger is the
superpowers plugin's own format, checked against 6.4.1; if it changes, the probe draws nothing
rather than a wrong count.

## 16. A personal override

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

## 17. Turning it down or off

| You want | Do |
|---|---|
| No blocks or automatic actions for a while | `/ctx-guard pause 1h` (`/ctx-guard pause off` to end it). Notes go on. |
| Never block tools on this machine | `/config` → `blocking` off. |
| Never clear or compact on its own on this machine | `/config` → `autoActions` off. Notes then ask the model to tell you. |
| No role in this session | `/ctx-guard role none`, or start with `CTX_GUARD_ROLE=none`. |
| Off in one project | `"enabled": false` in that project's config file. |
| Off everywhere | `/config` → `enabled` off. |

## 18. Stepped away

You leave a large session for lunch, a meeting or the night. The band counts down to the prompt
cache's expiry. Three cheap pings keep the cache alive; then ctx-guard asks the model for a
handoff, so the work is saved when you return. A toast flags any request that re-wrote a cache
that should have been warm.

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "triggers": [
        { "id": "warm", "when": { "cache.expiresIn": "8m", "context": "50k" }, "do": ["ping"], "times": 3 },
        { "id": "away", "when": { "cache.expiresIn": "8m", "cache.pings": 3 }, "do": ["prompt", "notify"], "times": 1 },
        { "id": "miss", "when": { "cache.miss": "50k" }, "do": ["toast"] }
      ],
      "handoff": { "instructions": "Rewrite the whole file. Sections: Goal, State, Next action." }
    }
  }
}
```

`triggers` replaces the built-in ladder, so add your context and usage triggers to this list
(use case 8 has a set). Pings and the prompt need `/ctx-guard trust`, and `autoActions` on in
`/config`.

Over a four-hour break with a 1-hour cache, `warm` pings about 52 minutes after your last
request, then at about 1 h 44 min and 2 h 36 min. Each warm ping moves the countdown back to an
hour, and the band reads `cache 9m · ping 2/3` as the next one nears. At about 3 h 28 min `away`
fires: it sends an OS notification and submits a turn that tells the model you are away and asks
it to write the handoff to `.ctx-guard/main-handoff.md` and stop. The model writes the file; an
hour later the cache expires and the band reads `cache cold`. When you return, the handoff is
there if you want to `/clear`. A session under 50k tokens gets neither pings nor the prompt: its
cache is cheap to re-write.

The `8m` threshold is there because Claude Code itself compacts an idle session about 6 minutes
before a 1-hour cache expires. A threshold of 6 minutes or less acts after that compaction.

With a 5-minute cache (`cache.ttl: "5m"`, or detected), use a `cache.expiresIn` threshold of
`"2m"` to `"3m"`. A trigger re-arms when the time left rises above its threshold, and ctx-guard
checks once a minute, so after a ping about 3 m 30 s are left; a threshold above that pings once.
