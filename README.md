# svd-agent-skills

Personal Claude Code plugin marketplace. Marketplace name: `svd-agent-skills`.

## Install

```bash
# Add the marketplace (once)
/plugin marketplace add svd/agent-skills

# Install individual plugins
/plugin install manage-claude-projects@svd-agent-skills
/plugin install session-analyzer@svd-agent-skills
/plugin install mcp-client-kit@svd-agent-skills
/plugin install session-handoff@svd-agent-skills
/plugin install mgraphctl@svd-agent-skills
/plugin install ctx-guard@svd-agent-skills
```

## Plugins

### manage-claude-projects

Inventory, deep-stat, and safely clean up the projects Claude Code tracks under `~/.claude`.

Skills: `/manage-claude-projects:manage-claude-projects`

Trigger phrases: "list my claude projects", "how much have I spent on project X",
"token usage for this project", "clean up old claude projects", "delete this project from claude".

> **Warning:** The `remove` subcommand is destructive. It deletes session transcripts,
> rewrites `~/.claude.json`, and removes todos/file-history entries. Always use `--backup`
> (the skill enforces this). Avoid while other Claude Code sessions are running — `config`
> removal rewrites `~/.claude.json` and can race live session writes.

### session-analyzer

Parse a Claude Code session JSONL transcript into a structured Markdown report covering
tool calls, skill vs. LLM attribution, errors and recovery, token usage, and optimization
recommendations.

Skills: `/session-analyzer:session-analyzer`

Trigger phrases: "analyze this session", "session report", "how many tokens did it use",
"what errors occurred", "show me the tool calls", or any session UUID / path.

### mcp-client-kit

Generate typed Python wrappers for any MCP server — one `async def` per tool with
real return types, so you call tools from code instead of pushing JSON schemas
through the model's context window. Ships a CLI (`mcpgen`) plus skills that drive it.

Skills: `/mcp-client-kit:generate-mcp-wrappers`, `/mcp-client-kit:generate-mcp-runner`

Trigger phrases: "generate MCP wrappers", "typed wrappers for an MCP server",
"mcpgen", "smoke-test run.py for MCP wrappers".

### session-handoff

Write and resume structured context handoffs between Claude sessions — new chat, new
machine, next day — without losing state, decisions, or mistakes already found. Handoffs
use trust tags (`[V]` verified / `[?]` unverified memory / `[S]` stale-risk), track a
parent/chain across handoffs for the same project, and a stdlib-only helper script
(`handoff_tool.py`) creates/validates/inspects them and flags staleness against the repo's
git state.

Skills: `/session-handoff:session-handoff`

Trigger phrases: "handoff", "hand off this session", "continue this in a new chat",
"context is getting long", "park this project", "resume where we left off".

### mgraphctl

Work with Microsoft 365 through the Microsoft Graph API — Outlook mail and calendar, Teams
chats, channels and presence, meetings with transcripts and Copilot insights, SharePoint,
OneDrive, OneNote, Planner, To Do, people and org chart. Backed by a Python CLI (`mgraphctl`)
run with `uv`; every write verb supports `--dry-run`, and auth uses MSAL with a token cache in
the OS keychain.

Skills: `/mgraphctl:mgraphctl`

Trigger phrases: "check my inbox", "what meetings do I have", "send a Teams message",
"find that SharePoint doc", "summarize this meeting transcript", "my tasks".

### ctx-guard

Watch a session's context fill and usage limits, and act on them by config. ctx-guard draws a band
above the prompt (`lead · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h)`) and shows toasts. It sends
per-role `[ctx-guard]` notes to the model, blocks tools such as `Agent` near the limits and caps
each subagent's context by type. When the model ends a reply with a ready token, it runs a guarded
`/clear` and resumes from a handoff file, or runs `/compact`. Roles, thresholds, triggers, handoff
instructions and budgets live in a JSON file, so no code changes are needed.

```bash
/plugin install ctx-guard --marketplace svd/agent-skills
```

Requires Claude Code 2.1.293 or later. ctx-guard checks the version at session start and shows a
toast on an older one. Unlike the other plugins here it is a mod, a TypeScript hooks module that
Claude Code loads itself. Mods are a new plugin kind, and the mod API may still change.

Skills: `/ctx-guard:guide`. Commands: `/ctx-guard` (report, plus `role`, `check`, `trust`,
`reload`, `pause`, `init [solo|peers]`) and `/ctx-guard:resume`.

Trigger phrases: "set up ctx-guard", "configure a context guard", "auto clear at 60 %",
"subagent budgets", or any `[ctx-guard]` note.

**Zero config.** With no config file and no role, ctx-guard draws the band and shows toasts at
50 / 70 / 85 % context and at 80 / 90 % of any usage limit. It sends the model nothing, blocks
nothing and runs nothing on its own, so a user-scope install leaves the model's behaviour as it
was. Model notes start once a session has a role. Set the `defaultRole` switch to `main` in
`/config` for the built-in ladder: notes at 40 / 60 / 75 % context (then every 5 %) and at
80 / 90 / 95 % usage, `Agent` blocked at 95 %, and restarts left to you. Or write
`.claude/ctx-guard.json`; `/ctx-guard init` writes a starter.

**Config.** Layers, later wins: built-in defaults, the `/config` switches, the team file
`.claude/ctx-guard.json` (committed) and the personal `.claude/ctx-guard.local.json` (gitignored).
Every key, default and recipe is in the
[config reference](plugins/ctx-guard/skills/guide/references/config-reference.md).

**Trust.** Settings that run things unattended need your approval per repo: automatic restarts
(`restart.mode: "auto"` with its command and prompt), `compact` actions and `readyChecks`, plus
the paths, peers and ready token they use (the full list is under Trust in the config
reference). Type `/ctx-guard trust` to approve the current config; any later change to those
settings, or to a ready-check script under the repo, withdraws the approval. Until you approve, notes, toasts and blocks still work, but ready tokens are refused with
`untrusted` and no compact or ready check runs.

#### Roles & scenarios

A role selects triggers, handoff and restart settings from `roles`. A session takes the first role
it finds, in this order: `/ctx-guard role <name|none>` typed by you, the `CTX_GUARD_ROLE`
environment variable, the project's `defaultRole`, then the `defaultRole` switch. Only interactive
sessions get a role; `claude -p` runs with none.

**Solo session.** One long-running session, role `main`. A role without `triggers` gets the
built-in ladder above. At a safe point the model rewrites `.ctx-guard/main-handoff.md` and ends its
reply with `CTX-READY`. ctx-guard then checks that no agent is running and the handoff is fresh,
clears, and resumes from the handoff.

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

**Coordinator + workers.** One long-lived coordinator dispatches subagents. Per-type budgets keep
each worker small: a note at `warn`, then at `stop` the worker is told to report and its further
tool calls are denied. Near the usage limit the coordinator stops dispatching.

```json
{
  "version": 1,
  "defaultRole": "coordinator",
  "roles": {
    "coordinator": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-stop", "when": { "context": "70%", "every": "5%" }, "do": ["note", "toast"], "level": "stop" },
        { "id": "usage-brake", "when": { "limit.any": 90 }, "do": ["note", "notify", { "deny": ["Agent", "Workflow"] }], "level": "stop" }
      ],
      "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting." }
    }
  },
  "subagents": {
    "*": { "warn": "120k", "stop": "170k" },
    "Explore": { "stop": "150k", "message": "Budget of {stop} reached: return your findings now." }
  }
}
```

**Peer sessions talking via SendMessage.** Two or more long-lived interactive sessions, say `lead`
and `reviewer`, message each other by name. Cross-session messaging is on by default, with no
setting to turn on. Name each session at start with `claude --name <name>`, or later with
`/rename <name>`. `/peers` (alias of `/list-agents`) lists the sessions this one can reach. If
messages do not arrive, check that `crossSessionInbound` is not `hold` or `refuse` and that no
deny rule covers `SendMessage`.

Give each session its role with `CTX_GUARD_ROLE`, or type `/ctx-guard role reviewer` in a running
session:

```sh
CTX_GUARD_ROLE=lead claude --name lead
CTX_GUARD_ROLE=reviewer claude --name reviewer
```

`restart.peers` with `peerGap` keeps the sessions from clearing within ten minutes of each other.
`notes.suffix` adds a line to every note, here telling the session to message its peer before it
stops. Settings shared by both roles go in `defaults`.

```json
{
  "version": 1,
  "defaults": {
    "handoff": { "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD. Sections: Goal, State, Open questions for the peer, Next action." },
    "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting.", "peerGap": "10m" }
  },
  "roles": {
    "lead": {
      "notes": { "suffix": "Before you stop, message the reviewer session: what you finished and what you hand over." },
      "restart": { "peers": ["reviewer"] }
    },
    "reviewer": {
      "notes": { "suffix": "Before you stop, message the lead session: what you reviewed and what is still open." },
      "restart": { "peers": ["lead"] }
    }
  }
}
```

**Compact instead of clear.** The session keeps its context, compacted, instead of starting over
from a handoff. With `via: "compact"` the ready token runs `/compact` with the role's
instructions. The `compact` action compacts at 85 % even if the model has not sent the token.

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

Run `/ctx-guard trust` after writing any of these, since each runs restarts or compacts on its own.

## Pricing

Both plugins use the same pricing table (USD per 1M tokens), matched by substring on the
model id. Cache write = 1.25× input for the default 5-minute TTL, 2× input for the 1-hour TTL;
cache read = 0.1× input (0.025× on Fable/Mythos 5.1, 0.05× on Opus 5.5 and Sonnet 5.5). Haiku 5.5 rates apply to
prompts up to 100K tokens; a longer request bills every token type at 5×:

| Model                     | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|---------------------------|-------|--------|----------------|----------------|------------|
| fable-5-1 / mythos-5-1    | 10.00 | 50.00  | 12.50          | 20.00          | 0.25       |
| fable / mythos            | 10.00 | 50.00  | 12.50          | 20.00          | 1.00       |
| opus-5-5                  | 4.00  | 20.00  | 5.00           | 8.00           | 0.20       |
| opus                      | 5.00  | 25.00  | 6.25           | 10.00          | 0.50       |
| sonnet-5-5                | 2.00  | 10.00  | 2.50           | 4.00           | 0.10       |
| sonnet-5                  | 2.00  | 10.00  | 2.50           | 4.00           | 0.20       |
| sonnet                    | 3.00  | 15.00  | 3.75           | 6.00           | 0.30       |
| haiku-5-5 (≤100K prompt)  | 0.10  | 0.50   | 0.125          | 0.20           | 0.01       |
| haiku                     | 1.00  | 5.00   | 1.25           | 2.00           | 0.10       |

Covers Fable 5/5.1, Mythos 5/5.1, Opus 5.5, Opus 5, Opus 4.5–4.8, Sonnet 5.5, Sonnet 5, Sonnet 4.5/4.6,
Haiku 5.5, Haiku 4.5
(`opus` = Opus 4.5–5 rate). Row order matters — the first key that is a substring of the model id
wins, so `sonnet-5-5` must precede `sonnet-5` (which precedes `sonnet`), `haiku-5-5` must precede `haiku`,
`opus-5-5` must precede `opus`, and `fable-5-1` must precede `fable`. Fast-mode requests
(`usage.speed: "fast"`) are counted and flagged but priced at the standard rate. Cost figures are
estimates from token counts, not actual billing amounts.

## Development

Versions use commit-SHA tracking — every push to `main` ships the latest code to
users who run `/plugin marketplace update svd-agent-skills`.

The Python helper scripts are pure Python 3 stdlib — no pip install required. ctx-guard is a
TypeScript mod that Claude Code loads directly, with no build step.
