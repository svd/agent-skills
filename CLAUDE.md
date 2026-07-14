# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick commands

```bash
# Run any plugin's script directly (subcommands vary — see SKILL.md)
python3 plugins/<plugin>/skills/<plugin>/scripts/<script>.py <subcommand> [args]

# The one existing test suite (session-handoff only)
python3 plugins/session-handoff/skills/session-handoff/scripts/smoke_test.py
```

## What this repo is

`svd-agent-skills` — personal Claude Code **plugin marketplace**. Each plugin under
`plugins/<name>/` is an independently versioned unit shipping one skill (occasionally more) plus
a stdlib-only Python helper script. There is no build step and no repo-wide version — plugins are
distributed by commit SHA: every push to `main` is live for anyone who runs
`/plugin marketplace update svd-agent-skills`.

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest — lists all plugins, no version field
plugins/<name>/
  .claude-plugin/plugin.json      # per-plugin manifest: name, version, description
  CHANGELOG.md                    # Keep a Changelog style, per-plugin
  skills/<name>/
    SKILL.md                      # the skill definition (frontmatter: name, description)
    scripts/*.py                  # stdlib-only Python helpers, invoked via ${CLAUDE_PLUGIN_ROOT}
    references/*.md               # supplementary docs loaded on demand by the skill
    assets/*                      # templates etc.
.claude/skills/releasing-a-version/  # repo-local skill for cutting releases (see below)
```

Current plugins: `manage-claude-projects`, `session-analyzer`, `session-handoff`. A fourth,
`mcp-client-kit`, is listed in `marketplace.json` but sourced from a separate GitHub repo
(`svd/mcp-client-kit`), not present here.

## Architecture pattern (applies to every plugin)

Each plugin follows the same split:

- **`SKILL.md` is the orchestrator.** It's what Claude reads and follows — it drives an
  interactive flow (resolve input → run script → present results → offer next actions), not the
  script. Read the relevant `SKILL.md` in full before touching a plugin; it documents exact step
  ordering, output formatting rules, and guardrails around destructive actions.
- **`scripts/*.py` do the mechanical work.** Pure Python 3 stdlib (no pip installs, no
  requirements.txt anywhere in the repo). Each script is invoked as a CLI with subcommands and
  prints JSON (or, for `handoff_tool.py`, plain key=value lines) to stdout for the calling model
  to parse and render — scripts never format output for direct human reading.
- Scripts are referenced from `SKILL.md` via `${CLAUDE_PLUGIN_ROOT}` or `$CLAUDE_PLUGIN_ROOT`
  (the plugin's own root), not hardcoded paths.

Per-plugin specifics:

- **manage-claude-projects** (`scripts/projects.py`) — subcommands `list`, `stats`, `deepstats`,
  `traces`, `remove`. Operates on `~/.claude.json` (`projects{}` registry) and
  `~/.claude/projects/<encoded-path>/` (session transcripts), where encoding replaces every
  non-alphanumeric character with `-`. `remove` is the only destructive subcommand — the skill
  enforces dry-run-first, category selection, and `--backup`.
- **session-analyzer** (`scripts/parse_session.py`) — parses a Claude Code JSONL transcript or a
  Claude Desktop `audit.jsonl` log (format auto-detected structurally, never by path/filename),
  emitting one analysis object (Claude Code) or a `runs[]` array of them (Desktop, one per
  `system/init`→`result` boundary in the append-only log). Also discovers `Workflow` tool
  fan-outs under `<sid>/subagents/workflows/<wf_id>/`. The skill turns this into a Markdown
  report with a fixed section structure (tool calls, skill/LLM attribution, errors, cost, recs).
- **session-handoff** (`scripts/handoff_tool.py`) — subcommands `new`, `latest`, `list`,
  `validate`, `stale`, `inspect`. Handoffs live at
  `.claude/session-handoffs/<project-slug>/<YYYYMMDD-HHMM>-<4-char-id>.md` (gitignored — see
  `.gitignore`). The skill enforces trust-tagging every claim `[V]`/`[?]`/`[S]` when writing one.

## Releasing

Use the `releasing-a-version` skill (`.claude/skills/releasing-a-version/SKILL.md`) rather than
bumping versions by hand — it encodes the exact convention:

- Bump `plugins/<plugin>/.claude-plugin/plugin.json` `"version"` and roll the plugin's
  `CHANGELOG.md` `[Unreleased]` section into a dated `[X.Y.Z]` header.
- One commit per plugin on `main` (`chore(<plugin>): release vX.Y.Z`), then an **annotated** tag
  `<plugin>-vX.Y.Z` (never a bare `vX.Y.Z` — plugins version independently) pushed after the
  commit.
- `marketplace.json` and `README.md` are **not** touched by a release (no version field to sync;
  README only changes when a plugin is added/removed).
- Run a plugin's `smoke_test.py` (if it has one — currently only `session-handoff`) before
  releasing it.

## Testing

Only `session-handoff` has a test script, stdlib-only, no framework:

```bash
python3 plugins/session-handoff/skills/session-handoff/scripts/smoke_test.py
```

The other two plugins have no automated tests — verify changes to `projects.py` or
`parse_session.py` by running the subcommand directly against real `~/.claude` data or a sample
transcript and inspecting the JSON output.

## Pricing table (shared across manage-claude-projects and session-analyzer)

Both `projects.py` (`deepstats`) and `parse_session.py` embed the same static USD-per-1M-token
pricing table, matched by substring against the model id (cache write = 1.25× input, cache read =
0.1× input). If you update pricing in one script, update the other to match — see the table in
`README.md`. Non-Claude models (e.g. `glm-5.1`) have no matching tier and are reported as
"tokens only", excluded from cost totals.
