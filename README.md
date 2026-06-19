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

## Pricing

Both plugins use the same pricing table (USD per 1M tokens), matched by substring on the
model id. Cache write = 1.25× input, cache read = 0.1× input:

| Model         | Input | Output | Cache write | Cache read |
|---------------|-------|--------|-------------|------------|
| fable / mythos| 10.00 | 50.00  | 12.50       | 1.00       |
| opus          | 5.00  | 25.00  | 6.25        | 0.50       |
| sonnet        | 3.00  | 15.00  | 3.75        | 0.30       |
| haiku         | 1.00  | 5.00   | 1.25        | 0.10       |

Covers Fable 5, Mythos 5, Opus 4.5–4.8, Sonnet 4.5/4.6, Haiku 4.5 (`opus` = current Opus
4.5+ rate). Cost figures are estimates from token counts, not actual billing amounts.

## Development

Versions use commit-SHA tracking — every push to `main` ships the latest code to
users who run `/plugin marketplace update svd-agent-skills`.

Both scripts are pure Python 3 stdlib — no pip install required.
