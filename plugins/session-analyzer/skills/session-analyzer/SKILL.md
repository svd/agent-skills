---
name: session-analyzer
description: >
  Analyze a Claude Code session transcript (JSONL) and produce a structured Markdown report.
  The report covers: all tool calls and their types, attribution of each action to a skill/agent
  rule vs. LLM autonomous decision, steps that caused errors and how the LLM recovered,
  total token usage and estimated cost, and optimization recommendations.

  Trigger when the user asks to "review", "analyze", "audit", or "report on" a Claude session,
  mentions a session directory path, a session UUID, or asks things like "what happened in that
  session", "what did Claude do in that run", "how many tokens did it use", "why did it retry",
  "what errors occurred", or "show me the tool calls". Also trigger when the user says "session
  report", "session summary", or references a session file by path or ID.
---

# Session Analyzer

Produces a structured Markdown report from a Claude Code session JSONL transcript. Report filename is chosen interactively (default: `session-report-<slug>.md`).

## Step 1 — Resolve the session

The user provides one of:
- **Filesystem path** — a directory containing `*.jsonl`, or a direct `.jsonl` file path.
- **Session UUID** — a 36-char UUID like `7d6b74af-3bfb-4447-bebe-bb3aa141a12d`. Search `~/.claude/projects/**/<uuid>.jsonl`.
- **Output destination** — optional separate directory where the report should be written. Default: same directory as the session JSONL.
- **Skills/agents reference path** — optional path to a plugin/skill directory. Use this to improve attribution accuracy (Step 4 — Load skill/agent reference files).

If a directory contains multiple `.jsonl` files and none was specified, **ask the user which session to analyze** before continuing.

## Step 2 — Parse the session

Run the bundled parser script. It is at `$CLAUDE_PLUGIN_ROOT/scripts/parse_session.py`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/parse_session.py" "<session-path-or-uuid>"
```

The script outputs JSON to stdout:

```json
{
  "session_id": "...",
  "session_dir": "/path/to/dir",
  "main_session": {
    "model": "claude-sonnet-4-6",
    "turns": 12,
    "tool_calls": [
      {"seq": 1, "name": "Bash", "input_summary": "...", "result_preview": "...", "is_error": false}
    ],
    "usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
    "errors": [...],
    "skills_in_context": ["staffing-assistant:staffing-analysis", "caveman:caveman-commit"],
    "started_at": "2026-06-11T16:12:14.966Z",
    "ended_at": "2026-06-11T16:24:17.340Z",
    "wall_seconds": 722.4
  },
  "subagent_sessions": [
    {
      "session_id": "agent-abc123", "agent_type": "Explore",
      "agent_name": "Explore session-analyzer plugin",
      "model": "claude-sonnet-4-6", "turns": 4,
      "tool_calls": [...], "errors": [],
      "usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
      "estimated_cost_usd": 0.012
    }
  ],
  "workflow_sessions": [
    {
      "wf_id": "wf_8960abc0-585",
      "workflow_name": "deep-research",
      "status": "killed",
      "args": "Landscape research ...",
      "default_model": "claude-fable-5[1m]",
      "duration_ms": 947795,
      "agent_count": 100,
      "transcript_files": 197,
      "meta_total_tokens": 1907679,
      "meta_total_tool_calls": 384,
      "phases": [{"title": "Scope", "detail": "..."}],
      "phase_rollup": {"Verify": {"agents": 75, "tool_calls": 302, "errors": 39}},
      "usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
      "estimated_cost_usd": 160.49,
      "agents": [
        {"label": "scope", "phase": "Scope", "state": "done", "cached": true,
         "model": "claude-fable-5", "tool_calls": [...], "errors": [...], "usage": {},
         "estimated_cost_usd": 1.23}
      ],
      "errors": [{"label": "verify:claim-3", "phase": "Verify", "name": "WebFetch", "result_preview": "...", "agent_id": "..."}]
    }
  ],
  "totals": {
    "input_tokens": 0, "output_tokens": 0,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    "estimated_cost_usd": 0.0,
    "pricing_tier": "sonnet",
    "wall_seconds": 722.4,
    "by_model": {
      "claude-opus-4-8": {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "sessions": 1, "estimated_cost_usd": 0.0, "priced": true
      }
    },
    "by_agent": {
      "main session": {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "instances": 1, "models": ["claude-opus-4-8"],
        "estimated_cost_usd": 0.0, "priced": true
      },
      "Explore": {
        "instances": 3, "models": ["claude-sonnet-4-6"],
        "estimated_cost_usd": 0.036, "priced": true
      },
      "workflow:deep-research": {
        "instances": 100, "models": ["claude-fable-5"],
        "estimated_cost_usd": 160.49, "priced": true
      }
    }
  }
}
```

Exit code 2 means multiple sessions were found — the JSON lists them; ask the user to pick one.

### Workflows (the `Workflow` tool)

When a session invokes the **Workflow** tool, its fan-out agents are **not** in
`<sid>/subagents/` — they live in `<sid>/subagents/workflows/<wf_id>/agent-*.jsonl`,
with run metadata in `<sid>/workflows/<wf_id>.json` and the script in
`<sid>/workflows/scripts/`. The parser discovers these automatically and emits one
entry per run in `workflow_sessions`. Notes:

- **`agents[]`** reuses the same per-session shape as subagents, enriched with
  `label` / `phase` / `state` (`done`/`error`/`progress`) / `cached` from the run's
  `workflowProgress`. Agents from prior resume runs that aren't in the final
  progress map get `label: "(prior-run/untracked)"` but are still counted.
- **`transcript_files`** (actual jsonl count, incl. resumed runs) usually exceeds
  **`agent_count`** / **`meta_total_tokens`** (which track only the final run). The
  parser's `usage` and `estimated_cost_usd` sum **all** transcripts — true compute
  spent — so they will be larger than the metadata's headline numbers. Report both
  and note the difference.
- Workflow agent usage is **already folded into `totals` and `by_model`**, priced
  at each agent's own model (workflow agents often run a different/cheaper model
  than the main loop — e.g. `fable` workflow under an `opus` main session).

## Step 3 — Determine report filename

After parsing you have `session_id` and `report_timestamp` (both in the parser output).

**Slug:** take the **last 6–8 characters** of `session_id` (8 if they're all hex characters with no hyphens, 6 otherwise).

**Default filename:** `<report_timestamp>-session-<slug>.md`

`report_timestamp` is already formatted `YYYY-mm-DD-HHMM` in UTC by the parser (derived from the first JSONL entry `timestamp`, or JSONL file mtime as fallback).

Example: `report_timestamp` = `2026-06-11-1612`, session ID `7d6b74af-3bfb-4447-bebe-bb3aa141a12d` → slug `b2edbc` → `2026-06-11-1612-session-b2edbc.md`

**Also propose 1–2 short content-based names** by scanning:
- `skills_in_context` — dominant skill name gives a strong hint (e.g. `pptx` → `pptx-gen`)
- First 3–5 tool call `input_summary` values — extract the task theme (e.g. `debug-auth`, `data-extract`, `rfp-review`)
- The session title or first user message if visible

Content-based name format: `<report_timestamp>-<topic>.md` where `<topic>` is 2–4 words joined by hyphens, lowercase, ASCII only.

Example: `2026-06-11-1612-pptx-gen.md`

Use `AskUserQuestion` to present the choice with the default as the first option and the 1–2 content-based names as additional options (plus "Other" for free text). If the user has already specified an output filename in their request, skip this step.

## Step 4 — Load skill/agent reference files (optional but valuable)

If the user provided a skills/agents directory, read the relevant SKILL.md and agent `.md` files from it. Use their contents to determine which tool calls were **explicitly prescribed** by a skill or agent rule vs. which were **LLM autonomous** decisions not mentioned in any rule.

Attribution heuristics (apply in order):
1. If a skill/agent file explicitly names the tool (e.g. "Run `Bash` with `staffing-extract`") → **skill-driven**.
2. If the tool call matches a pattern described in the skill (e.g. spawning N `Agent` calls for evaluation) → **skill-driven**.
3. If `skills_in_context` lists a skill and the action fits that skill's documented workflow → **skill-driven**.
4. If the tool call belongs to a workflow agent (it appears under a
   `workflow_sessions[].agents[]`) → **workflow-driven** (attribute to
   `workflow:<workflow_name>`, optionally with the agent `phase`). These are
   prescribed by the workflow script, not autonomous.
5. If the LLM used a tool to recover from an error in a way not described by the skill → **LLM autonomous (error recovery)**.
6. If no skill rule accounts for the tool call → **LLM autonomous**.

When no reference files are provided, use `skills_in_context` from the parser output plus reasoning about common skill patterns to make best-effort attributions. Note the uncertainty in the report.

## Step 5 — Write the report

Write the report using the filename chosen in Step 3, to the output destination (default: session directory).

Use this exact structure:

```markdown
# Session Report: <brief title>

**Session ID:** `<uuid>`
**Date:** <from file mtime or session metadata>
**Model:** <from main_session.model>
**Wall time:** <totals.wall_seconds formatted as Hh Mm Ss — e.g. "12m 3s"; omit this line when wall_seconds is null>

---

## 1. Tool Calls Summary

### Main Session (<N> total)

| # | Tool | Count | Attribution |
|---|------|-------|-------------|
| 1 | <tool-name> | <count> | <skill-name or "LLM autonomous"> |
...

### Subagent Sessions (if any)

For each distinct subagent type, summarize: type, count of instances, tool calls per instance.

| Agent type | Instances | Key tools used | Errors |
|-----------|-----------|----------------|--------|

### Workflows (if any)

One row per `workflow_sessions[]` run. State the `status` plainly — if `killed`
or `error`, say how many agents failed (`errors` count vs `transcript_files`).

| Workflow | Status | Agents | Tool calls | Errors | Tokens | Cost | Duration |
|----------|--------|--------|-----------|--------|--------|------|----------|
| <workflow_name> | <status> | <transcript_files> | <meta_total_tool_calls> | <len(errors)> | <usage sum> | $X.XX | <duration_ms formatted as Hh Mm Ss, or "—" if null> |

Then a per-phase breakdown from `phase_rollup`:

| Phase | Agents | Tool calls | Errors |
|-------|--------|-----------|--------|
| <phase> | <n> | <n> | <n> |

Note any gap between `transcript_files` / summed `usage` (all runs, incl. resumes)
and `agent_count` / `meta_total_tokens` (final tracked run only).

## 2. Skill vs. LLM Attribution

| Source | Tool calls | % |
|--------|-----------|---|
| <skill-name> | N | X% |
| LLM autonomous | N | X% |

Explain the breakdown: which specific actions were skill-prescribed and which were LLM decisions.
Note if attribution is inferred (no reference files provided).

## 3. Errors and Recovery

For each error from `main_session.errors`, subagent errors, **and
`workflow_sessions[].errors`** (these carry `label`/`phase`/`agent_id` — use them
to identify which workflow agent failed):

### Error <N> — <tool-name> (turn <seq>)

**What happened:** <description of the error>

**Error output:**
```
<result_preview, trimmed>
```

**How the LLM recovered:** <what happened next — next tool call and result>

**Root cause and fix options:**
- Option A: ...
- Option B: ...

## 4. Token Usage and Cost

| Metric | Main session | Subagents | Workflows | Total |
|--------|-------------|-----------|-----------|-------|
| Input tokens | | | | |
| Output tokens | | | | |
| Cache writes | | | | |
| Cache reads | | | | |
| **Estimated cost** | | | | **$X.XXXX** |

(Omit the Workflows column when `workflow_sessions` is empty.)

*Pricing is per-model — each session/agent is priced at its own model's rates, then
summed (see Cost by model below). Costs are approximate — actual billing may differ.
When a workflow ran a different model than the main loop, list both tiers' rates.*

### Cost by model

| Model | Sessions | Input | Output | Cache write | Cache read | Cost |
|-------|----------|-------|--------|-------------|------------|------|
| <model-id> | <N> | <n> | <n> | <n> | <n> | $X.XXXX |

*Rows from `totals.by_model`. Unpriced models (no matching pricing tier) show "—" for cost.*

### Cost by agent execution

*(Include this subsection only when `subagent_sessions` or `workflow_sessions[].agents`
is non-empty — skip entirely for a solo main-session run.)*

| Execution | Instances | Models | Input | Output | Cache write | Cache read | Cost |
|-----------|-----------|--------|-------|--------|-------------|------------|------|
| main session | 1 | <model> | <n> | <n> | <n> | <n> | $X.XXXX |
| <agent_type> | <N> | <model(s)> | <n> | <n> | <n> | <n> | $X.XXXX |
| workflow:<name> | <N> | <model(s)> | <n> | <n> | <n> | <n> | $X.XXXX |

*Rows from `totals.by_agent`. Subagent groups use the `agent_type` field as the key
(e.g. `Explore`, `Plan`, `caveman:cavecrew-builder`). Workflow groups use
`workflow:<workflow_name>`. Unpriced groups show "—" for cost.*

When `subagent_sessions` is non-empty, add a per-instance detail table
(subagents only — workflow agents stay in the grouped table above to avoid flooding):

| # | Agent type | Name | Model | Input | Output | Cache write | Cache read | Cost |
|---|-----------|------|-------|-------|--------|-------------|------------|------|
| 1 | <agent_type> | <agent_name or "—"> | <model> | <n> | <n> | <n> | <n> | $X.XXXX |

*Rows from `subagent_sessions[]`, each carrying `estimated_cost_usd` and `agent_name`
(the task description from the Agent tool call). Show "—" when `agent_name` is null.
Omit this table when no `subagent_sessions` ran.*

## 5. Optimization Recommendations

<numbered list of concrete, specific recommendations based on observed patterns:>
- Token waste patterns (redundant reads, large inputs, poor caching)
- Error-prone steps and how to make them robust
- Skill/agent prompt improvements
- Parallelism or batching opportunities
- Cache utilization (low cache-read ratio suggests cold context)
```

## Report quality checklist

Before finishing:
- [ ] Header shows **Wall time** when `totals.wall_seconds` is non-null; line is omitted (not shown as "—") when null.
- [ ] Every workflow row in the §1 Workflows table has a **Duration** column; "—" when `duration_ms` is null.
- [ ] Every error in `errors[]` has a dedicated subsection in §3. When a workflow
      produced many similar errors, group them by `phase`/error kind with counts
      rather than one subsection each, but cover every distinct failure mode.
- [ ] Every `workflow_sessions[]` run appears in the §1 Workflows table with its
      status, agent count, and per-phase breakdown.
- [ ] Attribution in §2 is consistent with the per-row Attribution column in §1.
- [ ] Cost table totals match `totals.estimated_cost_usd`.
- [ ] Per-model cost rows sum to `totals.estimated_cost_usd` (ignoring unpriced models).
- [ ] Cost by agent execution rows sum to `totals.estimated_cost_usd` (ignoring unpriced groups); section omitted when only the main session ran.
- [ ] §5 recommendations are specific to this session (not generic advice).
- [ ] Report path is stated in the final response to the user.

## Delivering the result

After writing the report, tell the user:
- The report path.
- How many tool calls, how many were errors, and the total estimated cost.
- Two or three of the most important optimization findings — one sentence each.

Do not dump the full report to chat.
