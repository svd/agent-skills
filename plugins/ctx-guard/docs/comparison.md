# ctx-guard compared

[← ctx-guard README](../README.md) · [All docs](README.md)

*Checked on 2026-10-15 against each project's own README or documentation. Tools change fast:
if anything here is wrong or out of date, please
[open an issue](https://github.com/svd/agent-skills/issues) and it will be fixed.*

ctx-guard is a policy layer: it reads context fill and both usage windows, and acts on rules you
write. Most tools in this space either show those figures or carry state across `/clear`. They
are often better used together with ctx-guard than instead of it.

## Feature matrix

● does it · ◐ partly (see notes) · — not described in the project's README

| | Shows context and limits | Warns the model | Usage-limit brakes | Subagent budgets | Clears and resumes on its own | Checks before clearing | Multi-session coordination | Prompt-cache help | Other agents |
|---|---|---|---|---|---|---|---|---|---|
| **ctx-guard** | ● | ● | ● | ● | ● | ● | ● | ● | — |
| [ctx-handoff-mod](https://github.com/cablate/ctx-handoff-mod) | — | — | — | — | ● | ◐ | — | ● | — |
| [claude-code-auto-handoff](https://github.com/Amel-DZRV/claude-code-auto-handoff) | ◐ | ◐ | — | — | ● | ◐ | — | ◐ | — |
| [claude-handoff](https://github.com/samzilverberg/claude-handoff) | — | ◐ | — | — | ◐ | ◐ | — | — | — |
| [clear-resume](https://github.com/m4cd4r4/clear-resume) | — | ◐ | — | — | — | ◐ | — | — | — |
| [cc-context-awareness](https://github.com/sdi2200262/cc-context-awareness) | — | ● | — | — | — | — | — | — | — |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline), [claude-hud](https://github.com/jarrodwatts/claude-hud) | ● | — | — | — | — | — | — | ◐ | — |
| [ccusage](https://github.com/ryoppippi/ccusage), [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | ● | — | — | — | — | — | — | — | ● |
| Claude Code built-ins | ● | — | — | ◐ | ◐ | — | — | ◐ | — |

## Notes per tool

**ctx-guard.** Triggers on context, the 5-hour and weekly windows, time to reset, session cost
and idle time; notes at three levels; tool denies while a condition holds; per-type subagent
token budgets; a guarded `/clear` and resume (or `/compact`) behind an 11-check verdict plus your
own ready-check scripts; role leases and peer gaps for several long-lived sessions. Prompt cache:
a band countdown to the cache's expiry, a `cache.miss` trigger (a toast in the presets) for a request that re-wrote a cache that should
have been warm, and opt-in keep-warm (a `ping` request or a `prompt` turn, capped by `times`,
behind `/ctx-guard trust`).

**ctx-handoff-mod** (a mod). Hands off to a fresh conversation at a token threshold, after Claude
and its subagents finish; its summary separates verified from unverified work. Keeps the prompt
cache warm while you are away (up to about four hours), turns repeated corrections into project
notes, and nudges the model on untested "done" claims. No usage-limit handling is described.

**claude-code-auto-handoff** (a mod). A context bar with a handoff mark, a prompt-cache
countdown and per-request token figures. At the threshold it asks for a summary, saves it, runs
`/clear` and loads the summary; it waits for background agents first. Its README notes the
threshold trigger is not yet verified live.

**claude-handoff** (hooks and a skill). At turn end above a token threshold, asks Claude for a
structured handoff and checks that all nine sections are there. It clears on its own only in the
T3 Code host; elsewhere you type `/clear`. macOS only.

**clear-resume** (hooks and a skill). You run a handover command, then `/clear`; a session-start
hook loads the brief for your branch and asks the new session to re-check it against git. An
opt-in nudge asks for a handover past a token threshold. It cannot run `/clear` itself. Syncs
handovers across machines.

**cc-context-awareness.** A status-line bridge writes the context figure to a file and a
pre-tool hook injects warnings at thresholds. It can instruct the model but cannot clear or
compact.

**ccstatusline, claude-hud.** Status lines: context, usage windows, reset timers; ccstatusline
also shows a cache hit rate, claude-hud running subagents. Display only.

**ccusage, Claude-Code-Usage-Monitor.** Usage history and live burn rate with forecasts, from
local logs and the status-line feed; ccusage reads many agents' logs. They report; they do not
act inside the session.

**Claude Code built-ins.** `/context`, `/usage` and the status-line feed show the figures.
Auto-compact runs at a configurable window, `/compact` takes instructions, and `PreCompact` and
`SessionStart` hooks can save and restore state. A subagent can have its own compact window.
Claude Code can wait for a usage reset and continue, and offers to compact before resuming a
large session that sat idle. There is no hook on a context threshold
yet ([#50978](https://github.com/anthropics/claude-code/issues/50978)), and no built-in
clear-and-resume ([#90089](https://github.com/anthropics/claude-code/issues/90089)).

## Where other tools do better

- **Learning from your corrections**: ctx-handoff-mod's project notes.
- **History and cross-agent reports**: ccusage, for Claude Code, Codex and others.
- **Validating handoff structure out of the box**: claude-handoff checks its nine sections.
  In ctx-guard a ready check can do it, but you write it.
- **Carrying a handoff to another machine**: clear-resume's sync.
- **Getting started**: most of these work with less to learn. ctx-guard's watch-only mode needs
  no config, but its automatic restarts ask you to understand roles, the verdict and trust.

## Use them together

- A **status line or monitor** (ccstatusline, claude-hud, ccusage) for history and dashboards;
  ctx-guard for what happens when a figure crosses a line.
- **Output filters** such as [RTK](https://github.com/rtk-ai/rtk) or
  [context-mode](https://github.com/mksglu/context-mode) to put less into the context; ctx-guard to
  decide what to do as it fills.
- **Handoff skills** such as `session-handoff` (this repo) or superpowers' plans: name the skill in
  `handoff.instructions` and ctx-guard runs the restart around it
  ([recipe 11](use-cases.md#11-handoffs-through-the-session-handoff-skill)).
