# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick commands

```bash
# Run any plugin's script directly (subcommands vary — see SKILL.md)
python3 plugins/<plugin>/skills/<plugin>/scripts/<script>.py <subcommand> [args]

# The two test suites (session-analyzer and session-handoff)
python3 plugins/session-analyzer/skills/session-analyzer/scripts/smoke_test.py
python3 plugins/session-handoff/skills/session-handoff/scripts/smoke_test.py

# ctx-guard (TypeScript mod): manifest/module check, then its hooks/*.test.ts suite
claude plugin validate plugins/ctx-guard
claude plugin test plugins/ctx-guard

# claude.ai directory rules: a plugin folder, or a release against the last <plugin>-v* tag
python3 tools/check_directory_rules.py plugin plugins/<plugin>
python3 tools/check_directory_rules.py release plugins/<plugin>
python3 tools/smoke_test_directory_rules.py
```

## What this repo is

`svd-agent-skills` — personal Claude Code **plugin marketplace**. Each plugin under
`plugins/<name>/` is an independently versioned unit shipping one skill (occasionally more) plus
a stdlib-only Python helper script (`ctx-guard` is the exception: a TypeScript mod, see below).
There is no build step and no repo-wide version — plugins are distributed by commit SHA: every
push to `main` is live for anyone who runs `/plugin marketplace update svd-agent-skills`.

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
.claude/settings.json             # shared hooks: directory-rule check after each plugin edit
.githooks/pre-push                # directory-rule check before a push to main
docs/directory-rules.md           # the claude.ai plugin directory's rules, with sources
tools/check_directory_rules.py    # checker for those rules (stdlib), with its smoke test
```

Exception — `plugins/ctx-guard/` is a **mod** (TypeScript hooks module loaded in-process by
Claude Code), so it has no `scripts/` and adds:

```
plugins/ctx-guard/
  .claude-plugin/types/           # API types laid by the engine on load — gitignored, never commit
  tsconfig.json                   # extends ./.claude-plugin/types/tsconfig.json
  hooks/hooks.json                # { "modules": ["./register.tsx"] }
  hooks/register.tsx              # thin wiring: events → pure modules → `$` calls
  hooks/*.ts                      # pure logic (no `$`), each with a *.test.ts beside it
  hooks/register.<topic>.test.ts  # engine-kit tests of register.tsx, split by topic
  hooks/register.fixtures.ts      # their shared fake world, helpers and PRESET_TEXT
  types/index.d.ts                # the plugin's PluginState contract
  commands/*.md                   # slash commands (`/ctx-guard:resume`)
```

Current plugins: `manage-claude-projects`, `session-analyzer`, `session-handoff`, `ctx-guard`.
Two more are listed in `marketplace.json` but sourced from separate GitHub repos, not present
here: `mcp-client-kit` (`svd/mcp-client-kit`) and `mgraphctl` (`svd/mgraphctl`). Externally-sourced
entries pin an explicit tag `ref`; local plugins ship by commit SHA on `main`.

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

Exception: **ctx-guard** is a TypeScript mod, not skill + script. Claude Code runs
`hooks/register.tsx` itself on session events; `SKILL.md` only tells the model how to answer the
mod's `[ctx-guard]` notes and how to help configure it. Logic lives in pure modules
(`config.ts`, `roles.ts`, `triggers.ts`, `messages.ts`, `restart.ts`, …) with no `$` access;
`register.tsx` keeps the I/O thin, and hooks never throw. Still no build step and no
`package.json` — the engine loads the `.ts`/`.tsx` files directly.

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
- **ctx-guard** (`hooks/register.tsx`) — context and usage guard. Reads layered JSON config
  (built-ins → `userConfig` switches → `.claude/ctx-guard.json` → `.claude/ctx-guard.local.json`),
  resolves a role (`/ctx-guard role` > `CTX_GUARD_ROLE` > `defaultRole`), fires triggers (notes,
  toasts, notify, tool denies, compact), and on the ready token runs a fail-closed verdict before
  `/clear` + `/ctx-guard:resume` or `/compact`. Auto actions and ready checks need per-repo
  `/ctx-guard trust`. Every key is in `skills/guide/references/config-reference.md`.

## Directory rules (claude.ai/directory)

The plugins are listed in the claude.ai plugin directory, which scans every commit on `main`. Its
rules, each with a level (block, hold, warn, note) and a source, are in `docs/directory-rules.md`.
Read them before editing anything under `plugins/<plugin>/`, and above all `plugins/*/hooks/*`:
the mod rules (`h` and `Fragment` in `.tsx`, how `$` and `on` are passed, `ui.render` in
`register.tsx`) block a version.

`tools/check_directory_rules.py` checks them:

```bash
python3 tools/check_directory_rules.py plugin plugins/<plugin>    # official rules + mod rules
python3 tools/check_directory_rules.py release plugins/<plugin>   # plus version bump, README and permission hooks vs the last tag
```

Keep every file in a plugin folder, images aside, under 256 KiB: a bigger one holds the version
for a reviewer. Split a test file before it grows that large.

Two hooks run the checker. `.claude/settings.json` runs `tools/hooks/directory_rules_posttool.py`
after each Edit or Write in a plugin folder and hands block and hold findings back to the model.
`.githooks/pre-push` refuses a push to `main` that fails `release` for a changed plugin; it runs
only once the clone has `git config core.hooksPath .githooks`.

## Releasing

Use the `releasing-a-version` skill (`.claude/skills/releasing-a-version/SKILL.md`) rather than
bumping versions by hand — it encodes the exact convention:

- Bump `plugins/<plugin>/.claude-plugin/plugin.json` `"version"` and roll the plugin's
  `CHANGELOG.md` `[Unreleased]` section into a dated `[X.Y.Z]` header.
- One commit per plugin on `main` (`chore(<plugin>): release vX.Y.Z`), then an **annotated** tag
  `<plugin>-vX.Y.Z` (never a bare `vX.Y.Z` — plugins version independently) pushed after the
  commit.
- A GitHub release per tag (`gh release create <plugin>-vX.Y.Z --verify-tag --notes-file …`),
  its notes built from the CHANGELOG section with absolute links pinned to the tag.
- `marketplace.json` and the root `README.md` are **not** touched by a release (no version field
  to sync; README only changes when a plugin is added/removed); a plugin README's version badge,
  where there is one (`ctx-guard`), is bumped with `plugin.json`.
- Run a plugin's `smoke_test.py` (if it has one — currently `session-analyzer` and
  `session-handoff`) before releasing it; for a mod (`hooks/hooks.json`, currently `ctx-guard`),
  run `claude plugin validate` and `claude plugin test` on it instead.
- Run `python3 tools/check_directory_rules.py release plugins/<plugin> --fail-on hold` and
  `python3 tools/smoke_test_directory_rules.py` before releasing; exit 1 stops the release.

## Testing

`session-analyzer` and `session-handoff` each have a `smoke_test.py` — stdlib-only, no framework,
self-contained (they build their own fixtures in a temp tree, so they don't read real `~/.claude`
data). Each prints `N/N checks passed.` and exits non-zero on failure:

```bash
python3 plugins/session-analyzer/skills/session-analyzer/scripts/smoke_test.py
python3 plugins/session-handoff/skills/session-handoff/scripts/smoke_test.py
```

`manage-claude-projects` has no automated tests — verify changes to `projects.py` by running the
subcommand directly against real `~/.claude` data and inspecting the JSON output. Take particular
care with `remove`, the only destructive subcommand: dry-run first.

`ctx-guard` tests are `hooks/*.test.ts` (pure-module unit tests plus engine-kit tests against a
fake world, via `claude-code/testing`), run by `claude plugin test`. The engine-kit tests of
`register.tsx` are split by topic into `register.<topic>.test.ts`, sharing
`register.fixtures.ts`; add a topic file before one nears 256 KiB. `claude plugin validate`
checks the manifest, the module and the `PluginState` contract. Type-check with
`tsc -p plugins/ctx-guard` once a `claude --plugin-dir plugins/ctx-guard` session has laid
`.claude-plugin/types/`:

```bash
claude plugin validate plugins/ctx-guard
claude plugin test plugins/ctx-guard
tsc -p plugins/ctx-guard
```

The test kit can't read plugin files, so `register.fixtures.ts` serves inline copies of
`skills/guide/assets/presets/*.json` to `/ctx-guard init`. When you edit a preset, update its
copy (`PRESET_TEXT`) to match byte for byte.

The directory-rule checker has its own smoke test, in the same style: a throwaway plugin in a
temp git repo per rule, once violating it and once clean.

```bash
python3 tools/smoke_test_directory_rules.py
```

## Pricing table (shared across manage-claude-projects and session-analyzer)

Both `projects.py` (`deepstats`) and `parse_session.py` embed the same static USD-per-1M-token
pricing table, matched by substring against the model id (cache write = 1.25× input, or 2× input
for 1-hour-TTL writes; cache read = 0.1× input). Both dedupe usage to one row per API request
(`requestId`, else `request_id`, else `message.id`; last copy wins), because transcripts write
one record per content block and each repeats the request's usage. If you update pricing in one
script, update the other to match, the table in `docs/pricing.md`, and the ctx-guard tune
weights (`MODEL_WEIGHTS` in `plugins/ctx-guard/hooks/tune.ts`). Non-Claude models (e.g. `glm-5.1`) have no matching tier and are reported as
"tokens only", excluded from cost totals.
