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

Cost figures are estimates from token counts; rates are in [docs/pricing.md](docs/pricing.md).

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

Cost figures are estimates from token counts; rates are in [docs/pricing.md](docs/pricing.md).

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
80 / 90 / 95 % usage, `Agent`, `Workflow`, `WebSearch` and `WebFetch` blocked at 95 % (and
`Agent` and `Workflow` earlier while the weekly limit fills fast: at 80 % with two days or more
to its reset, at 90 % with one day or more), and restarts left to you. Or write
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

**Roles.** A role selects triggers, handoff and restart settings from `roles`. A session takes
the first role it finds: `/ctx-guard role <name|none>` typed by you, the `CTX_GUARD_ROLE`
environment variable, the project's `defaultRole`, then the `defaultRole` switch. Only interactive
sessions get a role; `claude -p` runs with none.

Setup steps, configs for common scenarios (solo session, coordinator and workers, peer sessions,
compact instead of clear, usage brakes) and troubleshooting are in the
[ctx-guard README](plugins/ctx-guard/README.md).

## Development

Versions use commit-SHA tracking — every push to `main` ships the latest code to
users who run `/plugin marketplace update svd-agent-skills`.

The Python helper scripts are pure Python 3 stdlib — no pip install required. ctx-guard is a
TypeScript mod that Claude Code loads directly, with no build step.

## License

MIT, see [LICENSE](LICENSE). Each plugin declares the same license in its `plugin.json`.
