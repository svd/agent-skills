# Changelog

All notable changes to the `session-analyzer` plugin are documented here.

## [Unreleased]

### Added
- **Teammate session discovery.** The `Agent` tool's second spawn mode creates a full, independent
  Claude Code session whose transcript lives in the project directory matching the *teammate's own*
  cwd — no filesystem containment, no meta sidecar, so the parser could not see it. Teammates are
  now found by scanning session heads for `teamName == "session-" + <leader id>[:8]`, recursively,
  including each teammate's own subagents and workflow agents. On a validated real run this moved
  the reported figures from 11 sessions / 1,019 tool calls / $333.32 to 54 / 3,589 / $793.34.
- `teammate_sessions[]` in the output, each entry carrying `role` (a labelled heuristic read of the
  opening brief), `agent_name`, `team_name`, `depth`, `project_slug`, `cwd`, and `git_branch`.
  Teammate usage folds into `totals`, `by_model`, and `by_agent` (keyed `teammate:<role>`).
- `totals.coverage`: counts the parent-side spawn list and the filesystem-side transcript list
  separately — they disagree in both directions by design — plus two independent flags, `complete`
  ("is the total a floor?") and `reconciled` ("is every session explained?"), and a human-readable
  `incomplete_reasons`. The report now leads with a coverage banner, so a partial total can no
  longer be presented as a total.
- `totals.span_wall_seconds`, `agent_seconds`, `concurrency_ratio`, and `wall_seconds_covers_team`,
  since teammates can run outside the main session's span.
- `--no-teammates` to skip the scan, and `scripts/smoke_test.py` (45 checks, stdlib only, entirely
  synthetic fixtures — it never reads real `~/.claude` data).

### Changed
- **`totals.estimated_cost_usd` is now the all-in figure** and will exceed what earlier versions
  reported for any session that used teammates. `totals.core_cost_usd` preserves the previous
  main+subagents+workflows value and `totals.cost_scope` names which is which.

### Unchanged
- The Claude Desktop path is byte-for-byte identical: it emits no `teammate_sessions` key, no
  `coverage`, and no new `totals` keys.

## [0.4.0] - 2026-07-14

### Added
- Claude Desktop agent-mode `audit.jsonl` support alongside Claude Code transcripts. Format is
  auto-detected structurally (never by path), so a copied-out or renamed Desktop log still works.
- One Desktop `audit.jsonl` is segmented into its individual runs (`init`→`result` boundaries,
  correctly handling interrupted runs and reused session IDs) — one report per run, not per file.
- `--list-desktop [--root PATH]` discovers Desktop conversations across the standard macOS roots
  plus any custom `--user-data-dir` instance.
- Run totals use the `result` event's ground-truth `modelUsage`/`total_cost_usd` when available,
  since Desktop's per-content-block streamed `assistant` records are not reliably summable.

## [0.3.0] - 2026-07-02

### Changed
- Sonnet 5 introductory pricing ($2/$10 vs $3/$15 standard, through 2026-08-31) is now applied
  per-session based on `started_at`, so mixed-window reports price correctly instead of always
  using standard rates.

## [0.2.0] - 2026-06-30

### Added
- `totals.by_agent`: cost grouped by execution unit (main session, subagent `agent_type`,
  `workflow:<name>`) with instance count and model list — finer granularity than `by_model` alone.
- `estimated_cost_usd` on each subagent/workflow-agent dict, and `agent_name` (from
  `meta.json` `description`) for per-instance identification.
- Report §4 "Cost by agent execution": grouped table plus a per-instance subagent detail table
  (omitted for solo main-session runs).

## [0.1.0] - 2026-06-11

### Added
- Initial release: parses Claude Code session JSONL transcripts into structured Markdown reports
  — tool-call attribution (skill-driven vs. LLM autonomous), error analysis, token usage, and
  per-model cost breakdown.
- Report filenames prefixed with `report_timestamp` (derived from the first JSONL entry, UTC)
  so reports sort chronologically on disk; slug length bumped to 6–8 chars.
- Workflow tool runs (`<sid>/subagents/workflows/<wf_id>/`) discovered and folded into the
  report: per-agent label/phase/state/cached metadata, per-agent-model pricing, `workflow_sessions[]`.
- Session wall time (`wall_seconds`) computed from first/last transcript timestamp, surfaced in
  the report header and the workflow table's Duration column.
