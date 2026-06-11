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
    "skills_in_context": ["staffing-assistant:staffing-analysis", "caveman:caveman-commit"]
  },
  "subagent_sessions": [...],
  "totals": {
    "input_tokens": 0, "output_tokens": 0,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    "estimated_cost_usd": 0.0,
    "pricing_tier": "sonnet",
    "by_model": {
      "claude-opus-4-8": {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "sessions": 1, "estimated_cost_usd": 0.0, "priced": true
      }
    }
  }
}
```

Exit code 2 means multiple sessions were found — the JSON lists them; ask the user to pick one.

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
4. If the LLM used a tool to recover from an error in a way not described by the skill → **LLM autonomous (error recovery)**.
5. If no skill rule accounts for the tool call → **LLM autonomous**.

When no reference files are provided, use `skills_in_context` from the parser output plus reasoning about common skill patterns to make best-effort attributions. Note the uncertainty in the report.

## Step 5 — Write the report

Write the report using the filename chosen in Step 3, to the output destination (default: session directory).

Use this exact structure:

```markdown
# Session Report: <brief title>

**Session ID:** `<uuid>`
**Date:** <from file mtime or session metadata>
**Model:** <from main_session.model>

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

## 2. Skill vs. LLM Attribution

| Source | Tool calls | % |
|--------|-----------|---|
| <skill-name> | N | X% |
| LLM autonomous | N | X% |

Explain the breakdown: which specific actions were skill-prescribed and which were LLM decisions.
Note if attribution is inferred (no reference files provided).

## 3. Errors and Recovery

For each error from `main_session.errors` and subagent errors:

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

| Metric | Main session | Subagents | Total |
|--------|-------------|-----------|-------|
| Input tokens | | | |
| Output tokens | | | |
| Cache writes | | | |
| Cache reads | | | |
| **Estimated cost** | | | **$X.XXXX** |

*Pricing: <tier> rates (~$X/MTok input, $X/MTok output, $X/MTok cache write, $X/MTok cache read).
Costs are approximate — actual billing may differ.*

### Cost by model

| Model | Sessions | Input | Output | Cache write | Cache read | Cost |
|-------|----------|-------|--------|-------------|------------|------|
| <model-id> | <N> | <n> | <n> | <n> | <n> | $X.XXXX |

*Rows from `totals.by_model`. Unpriced models (no matching pricing tier) show "—" for cost.*

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
- [ ] Every error in `errors[]` has a dedicated subsection in §3.
- [ ] Attribution in §2 is consistent with the per-row Attribution column in §1.
- [ ] Cost table totals match `totals.estimated_cost_usd`.
- [ ] Per-model cost rows sum to `totals.estimated_cost_usd` (ignoring unpriced models).
- [ ] §5 recommendations are specific to this session (not generic advice).
- [ ] Report path is stated in the final response to the user.

## Delivering the result

After writing the report, tell the user:
- The report path.
- How many tool calls, how many were errors, and the total estimated cost.
- Two or three of the most important optimization findings — one sentence each.

Do not dump the full report to chat.
