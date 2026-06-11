---
name: manage-claude-projects
description: >-
  Inspect, audit, and clean up your local Claude Code projects under ~/.claude.
  Use this whenever the user wants to see which projects Claude Code has tracked
  on this machine, get statistics about a project (session count, project-local
  skills/agents/commands/MCPs/plugins, disk usage, token usage, estimated cost),
  or remove/clean up a project's traces from ~/.claude. Trigger on phrases like
  "manage my claude projects", "list my claude code projects", "how many sessions
  / how much have I spent on project X", "token usage for this project", "delete
  this project from claude", "remove project X from ~/.claude", "clean up old
  claude projects", "which projects are taking up disk space", or any request to
  audit or purge local Claude Code project data — even when the user names a path
  or project instead of saying "project".
---

# Manage Claude Code Projects

Inventory, deep-stat, and safely clean up the projects Claude Code tracks under
`~/.claude`. All heavy lifting is done by `scripts/projects.py` (stdlib Python,
prints JSON). Your job is to drive the interactive flow: pick a project, show
stats, offer actions, and confirm anything destructive.

Run everything as: `python3 "${CLAUDE_PLUGIN_ROOT}/skills/manage-claude-projects/scripts/projects.py" <subcommand>`

## Where the data lives (so you can explain it)

A "project" exists in two places:
- `~/.claude.json` → `projects{<absolute path>: {...}}` — the registered project
  with its config, MCP servers, and last-session cost/token snapshot.
- `~/.claude/projects/<encoded-path>/` — one `.jsonl` transcript per session.
  Encoded name = every non-alphanumeric char of the path replaced with `-`.

Each session id (the `.jsonl` filename) also keys traces elsewhere:
`todos/<id>-*`, `file-history/<id>/`, and `history.jsonl` lines (matched by the
project's absolute path). These are what removal targets.

## Step 1 — Identify the project

Resolve the target before doing anything else, in this order:

1. **User gave a path or name** — if they passed an absolute path, use it. If they
   gave a partial name (e.g. "staffing-assistant"), run `list` and match it
   against the project paths; if more than one matches, show the matches and ask
   which one.
2. **No project given** — run:
   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/manage-claude-projects/scripts/projects.py" list --cwd "$PWD"
   ```
   This returns every registered project plus orphan session dirs, sorted by last
   activity, with the current directory flagged `is_cwd: true`. Present a
   **multi-select** list with `AskUserQuestion` (or a numbered list if there are
   many). If one project has `is_cwd: true`, mark it "(current directory)" and put
   it first as the natural default. Let the user pick one or several.

Tell the user what you found rather than dumping raw JSON — e.g. a short table of
`name | sessions | size | last active`.

## Step 2 — Show basic stats

For each selected project run `stats --path "<path>"` and present a compact
summary:

- **Sessions** — number of transcripts
- **Project-local skills / agents / commands** — defined in `<project>/.claude/`
- **MCP servers** — from config + the project's `.mcp.json`
- **Plugins** — enabled in project settings
- **Disk usage** and **last active** date
- **Last session cost** (from the config snapshot) if present

Render it readably (a small table or bullet list). Don't print the JSON verbatim.

## Step 3 — Offer actions

Ask what the user wants to do next (use `AskUserQuestion`). Offer at least:

- **Deep statistics** — full token usage and estimated cost across all sessions
- **Remove / clean up** — delete some or all of the project's traces from `~/.claude`
- **Compare** — if several projects were selected, show their stats side by side
- **Done** — nothing further

Surface other useful angles when they fit: biggest disk hogs, stalest projects,
orphan session dirs with no config entry (safe cleanup candidates).

## Step 4a — Deep statistics

Run `deepstats --path "<path>"`. It scans every transcript and aggregates token
usage **per model**, then estimates cost from a static Claude price table
(cache-write billed at 1.25× input, cache-read at 0.1× input). Present:

- A per-model row: input / output / cache tokens and estimated `$`
- **Total estimated cost** across priced models
- Any **unpriced models** (e.g. non-Claude like `glm-5.1`) shown as "tokens only"

Always state that the dollar figure is an **estimate** from token counts, not a
billed amount, and that non-Claude models are excluded from the total.

## Step 4b — Remove / clean up  (destructive — be careful)

Removal is irreversible apart from the backup. Follow this exactly:

1. **Enumerate** what exists — run `traces --path "<path>"`. It reports five
   categories with counts/sizes:
   - `sessions` — the transcript directory
   - `config` — the `~/.claude.json` entry
   - `history` — matching lines in `history.jsonl`
   - `todos` — saved todo lists for this project's sessions
   - `filehistory` — edited-file backups for this project's sessions

   (`shell-snapshots` are **not** removed — they aren't reliably attributable to a
   single project. Mention this if the user asks for a total wipe.)

2. **Let the user choose categories** — show what was found and ask, with
   `AskUserQuestion` (multi-select), which categories to delete. Pre-check
   `sessions` + `config` (the core of "this project") and leave the shared logs
   (`history`, `todos`, `filehistory`) for the user to opt into. The user picked
   per-run selection on purpose — never assume a full purge.

3. **Dry-run first** — run `remove` with `--dry-run` and the chosen
   `--categories`, and show the concrete file targets so the user sees exactly
   what will go.

4. **Confirm explicitly** — state plainly that this deletes the listed data, that
   a backup will be written to `~/.claude/backups/`, and ask for a clear yes
   before proceeding. Do not proceed on ambiguous assent.

5. **Execute** — run for real, always with `--backup`:
   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/manage-claude-projects/scripts/projects.py" remove --path "<path>" \
     --categories sessions,config,history,todos,filehistory --backup
   ```
   (Pass only the categories the user approved.) Report the backup path and the
   per-category deletion counts it returns.

**Caveat to mention before deleting `config`:** rewriting `~/.claude.json` while
another Claude Code session is live could race that session's own writes. If the
user is running other sessions, suggest closing them first, or skip the `config`
category and remove it when no other session is active.

## Output style

Be concise and concrete. Tables over prose for stats. For anything destructive,
slow down: enumerate, dry-run, confirm, then act — and always back up.

See `references/data-model.md` for the full `~/.claude` layout and command
reference.
