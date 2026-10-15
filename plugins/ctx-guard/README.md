# ctx-guard

**Autopilot with brakes for long Claude Code sessions.**

ctx-guard watches your context window and your 5-hour and weekly usage limits, and turns
thresholds into actions. It tells the model when to wrap up, brakes subagents and web tools
before a limit runs out, caps each subagent's context, and restarts the session from a handoff
only when 11 checks say your work is safe. One JSON file, no code.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Claude Code 2.1.293+](https://img.shields.io/badge/Claude%20Code-2.1.293%2B-d97757)
![version 0.1.0](https://img.shields.io/badge/version-0.1.0-informational)
![500+ tests](https://img.shields.io/badge/tests-500%2B-brightgreen)

```text
main · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h)
```

<!-- TODO: docs/assets/demo.gif — 15 s: the band turns amber, a note arrives, the model writes
the handoff and ends with CTX-READY, ctx-guard clears and the fresh session carries on. -->

```text
/plugin marketplace add svd/agent-skills
/plugin install ctx-guard@svd-agent-skills
```

## Why

Long Claude Code sessions go wrong in three ways:

- **Auto-compact forgets what mattered.** It fires late, in the middle of a turn, and its
  summary can drop the decisions and corrections you made along the way
  ([anthropics/claude-code#36068](https://github.com/anthropics/claude-code/issues/36068)).
- **Subagents eat the week.** In one month-long log study, subagents took 48% of all tokens
  ([dev.to](https://dev.to/aidiveyt/the-september-cut-took-17-of-my-claude-code-week-subagents-were-taking-48-98n)).
  You find out when the weekly window is gone on Wednesday.
- **Restarting is either manual or blind.** Watching the meter and typing `/clear` yourself
  breaks your flow; a `/clear` while a subagent runs, or with work not yet committed, loses work
  you already paid for.

## What it does

| See | Steer | Restart safely |
|---|---|---|
| A **band** above the prompt with context fill, both usage windows and their resets, plus your own project probes (branch, worktrees, plan progress). | **Triggers** on context, usage, time to reset, cost and idle send the model `soft` → `hard` → `stop` notes, show toasts and OS notifications, **deny tools** such as `Agent`, `WebFetch` or browser navigation while a window runs hot, and cap each **subagent's** tokens by type. | The model rewrites a **handoff** and ends its reply with `CTX-READY`. ctx-guard runs an 11-check **verdict**; if every check passes it runs `/clear` and resumes from the handoff, which is checked against the repo first. Prefer `/compact`? One setting. |

A note, as the model sees it:

> [ctx-guard] Context is at 400k (40% of 1M), past 40%. Plan for a handoff: finish the item in
> hand and keep new work small. At the next safe point — no subagents running, current work
> recorded — write the handoff to `.ctx-guard/main-handoff.md`: Rewrite the whole file.
> Sections: Goal, State, Next action. Then tell the operator 'ready for /clear'.

Each note also shows a toast, so you see what the model was told (`noteToasts`).

## How a restart works

```mermaid
flowchart LR
    A["40%: soft note<br/>finish the item in hand"] --> B["60%: hard note<br/>start nothing new"]
    B --> C["75%: stop note<br/>write the handoff,<br/>end with CTX-READY"]
    C --> D{"Verdict:<br/>11 checks"}
    D -->|all pass| E["/clear, then<br/>/ctx-guard:resume"]
    E --> F["Resume checks git HEAD<br/>and paths, then runs<br/>the Next action"]
    D -->|any fails| G["Nothing is cleared;<br/>the model is told why"]
```

The verdict refuses a restart when the repo's automatic settings are not approved; a restart,
compact or resume is already under way; context is below the role's minimum; this session
restarted too recently; the resume command is missing; a subagent, workflow or background shell
is running; another live session holds the role; the handoff is missing, empty or stale; a peer
role restarted recently or wins a simultaneous restart; or any of your own ready checks (say,
"the worktree is clean") fails. Details: [Handoff, restart and compact](docs/handoff-and-restart.md).

## Quick start

1. **Install** (above) and start a new session. The band appears after the first response.
   Nothing else changes: with no config ctx-guard only draws the band and shows toasts at
   50 / 70 / 85 % context and 80 / 90 % of either usage window. It sends the model nothing,
   blocks nothing and runs nothing on its own.
2. **Turn on notes.** Open `/config`, find ctx-guard, set **Default role** to `main`. Every
   interactive session now gets the built-in ladder: notes at 40 / 60 / 75 % context, notes as
   the usage windows fill, and `Agent` and `Workflow` blocked when the week fills early or a
   window passes 95 % (web tools too, at 95 %). Restarts stay manual: the model writes a
   handoff and tells you "ready for /clear".
3. **Go automatic in a repo.**

   ```text
   /ctx-guard init      # writes .claude/ctx-guard.json (the solo preset) and .gitignore lines
   /ctx-guard trust     # approves automatic restarts for this repo
   /ctx-guard check     # dry run of the restart verdict, check by check
   ```

   Review and commit `.claude/ctx-guard.json`: it is the team file.

Type `/ctx-guard` any time for a report: role, config and its errors, live figures, fired
triggers, active blocks and trust. Full walk-through: [Getting started](docs/getting-started.md).

## Safety by design

- **Restarts fail closed.** Any failed check refuses the restart, and nothing is cleared.
- **Nothing runs unattended without your approval.** Automatic restarts, `compact` actions,
  ready checks and band probes need `/ctx-guard trust` per repo. Trust covers the exact settings
  and the scripts' contents; any change withdraws it until you approve again.
- **The model cannot talk its way out.** `role`, `check`, `trust`, `pause` and `init` work only
  when you type them; ctx-guard refuses them from the model or another plugin.
- **Blocks fail open and lift themselves.** An unknown metric or a failed check denies nothing,
  and a deny lifts once its condition stops holding (a window resets, the reset gets close).
- **ctx-guard never writes your handoff.** The model writes it with the whole conversation in
  view; the resume checks the recorded `HEAD` is `HEAD` or an ancestor and that every named path
  exists, and stops to ask you on any mismatch.
- **Easy to turn down.** `/ctx-guard pause 1h`, or the `blocking`, `autoActions` and `enabled`
  switches in `/config`.

## Pick your setup

| You want | Start from |
|---|---|
| Just the figures, nothing else | [1. Just watch the figures](docs/use-cases.md#1-just-watch-the-figures) |
| Notes, but you decide when to clear | [2. Notes with manual restarts](docs/use-cases.md#2-notes-with-manual-restarts) |
| One long session that restarts itself | [3. Solo session with automatic clear and resume](docs/use-cases.md#3-solo-session-with-automatic-clear-and-resume) |
| Never clear with uncommitted work | [4. Never clear with uncommitted work](docs/use-cases.md#4-never-clear-with-uncommitted-work) |
| `/compact` instead of `/clear` | [5. Compact instead of clear](docs/use-cases.md#5-compact-instead-of-clear) |
| A coordinator with subagent budgets | [6. Coordinator and workers](docs/use-cases.md#6-coordinator-and-workers) |
| Two sessions, lead and reviewer | [7. Peer sessions](docs/use-cases.md#7-peer-sessions) |
| Make the weekly limit last | [8. Usage-limit brake](docs/use-cases.md#8-usage-limit-brake), [9. Early-spend brake](docs/use-cases.md#9-early-spend-brake) |
| Builders in git worktrees | [13. Builders in git worktrees](docs/use-cases.md#13-builders-in-git-worktrees) |

All 17 recipes: [Use cases](docs/use-cases.md).

## How it compares

| Kind of tool | Examples | What ctx-guard adds |
|---|---|---|
| Usage monitors and status lines | ccusage, Claude-Code-Usage-Monitor, ccstatusline, claude-hud | They show the figures; ctx-guard acts on them. Keep using them side by side. |
| Handoff and clear-resume plugins | ctx-handoff-mod, claude-code-auto-handoff, clear-resume, claude-handoff | Usage-limit brakes, subagent budgets, multi-session roles and a fail-closed restart verdict with your own checks. |
| Built-in auto-compact | Claude Code | A restart at a safe point, from a handoff you can read and the resume verifies, instead of a mid-turn summary. |

The full feature matrix, including where other tools do better: [Comparison](docs/comparison.md).

## Requirements and limitations

- **Claude Code 2.1.293 or later.** On an older version ctx-guard shows a toast at session start
  and some checks may not work.
- **A mod.** ctx-guard is a TypeScript hooks module that Claude Code loads in-process: nothing to
  build, no `npm install`. Mods are a new plugin kind, and their API may still change.
- **Interactive sessions.** `claude -p` runs get no role, so they only see the band and toasts.
- **Claude Code only.** It does not watch Codex, Cursor or other agents.
- **Restarts need the model's cooperation** to write the handoff and send the token. For a
  backstop that needs none, a trigger can run `compact` on its own.
- **No prompt-cache keep-warm.** An `idle` trigger can notify you before a large context's cache
  expires, but ctx-guard sends no keep-alive requests.

## FAQ

**Does it cost tokens?** The band and toasts cost none. Notes are a few lines each, sent once
when a threshold is crossed (or every step past it, with `every`).

**Can the model restart the session on its own?** Only after a context note asked for it, with
a fresh handoff on disk and every check passing. The token inside a sentence, or from a subagent,
never counts.

**Will it clear while a subagent is running?** No. The verdict refuses with `agents-running`.

**Does it work with superpowers or session-handoff?** Yes. A band probe shows a superpowers
plan's progress, and any skill can write the handoff
([recipe 11](docs/use-cases.md#11-handoffs-through-the-session-handoff-skill),
[recipe 15](docs/use-cases.md#15-a-superpowers-plans-progress-on-the-band)).

**Something does not work.** Run `/ctx-guard`, then `/ctx-guard check`, then see
[Troubleshooting](docs/troubleshooting.md).

## Documentation

| Doc | What is in it |
|---|---|
| [Getting started](docs/getting-started.md) | Concepts, install, the built-in ladder, the first project config, trust. |
| [Configuration](docs/configuration.md) | Layers and switches, quantities, triggers, what to block, roles, commands. |
| [Handoff, restart and compact](docs/handoff-and-restart.md) | Restart modes, the handoff file, the ready token, the verdict, compact. |
| [Use cases](docs/use-cases.md) | 17 complete configs, from watch-only to worktree builders. |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, refusal codes and fixes; files ctx-guard writes. |
| [Comparison](docs/comparison.md) | ctx-guard next to monitors, handoff plugins and built-ins. |
| [Config reference](skills/guide/references/config-reference.md) | Every key, default, refusal code and trust rule. |
| [JSON Schema](skills/guide/assets/ctx-guard.schema.json) | For editor completion: point `$schema` at it. |
| [CHANGELOG](CHANGELOG.md) | What changed, release by release. |

## License

MIT, see [LICENSE](LICENSE).
