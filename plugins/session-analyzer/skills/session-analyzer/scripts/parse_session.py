#!/usr/bin/env python3
"""Parse a Claude Code session JSONL and output structured analysis JSON to stdout."""

import json
import sys
import os
import re
from datetime import datetime, timezone
from pathlib import Path


CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"


def _parse_iso(ts):
    """Parse an ISO 8601 timestamp string to a datetime (handles trailing Z)."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def find_session_files(target: str):
    """
    Resolve a session path or UUID to (main_jsonl, subagents_dir_or_None, session_id).
    Returns (list_of_jsonl, None, None) when multiple sessions found in a directory.
    Returns (None, None, None) when nothing found.
    """
    p = Path(os.path.expanduser(target))

    # Directory: look for UUID-named .jsonl files inside
    if p.is_dir():
        uuid_re = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
        jsonl_files = sorted(f for f in p.glob("*.jsonl") if uuid_re.match(f.stem))
        if not jsonl_files:
            jsonl_files = sorted(p.glob("*.jsonl"))
        if len(jsonl_files) > 1:
            return jsonl_files, None, None
        if len(jsonl_files) == 1:
            main = jsonl_files[0]
            session_id = main.stem
            subagents_dir = p / session_id / "subagents"
            return main, subagents_dir if subagents_dir.is_dir() else None, session_id
        return None, None, None

    # Direct file
    if p.is_file() and p.suffix == ".jsonl":
        session_id = p.stem
        subagents_dir = p.parent / session_id / "subagents"
        return p, subagents_dir if subagents_dir.is_dir() else None, session_id

    # UUID string: search ~/.claude/projects/**/<uuid>.jsonl
    uuid_str = p.name
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", uuid_str, re.I):
        for f in CLAUDE_PROJECTS_DIR.rglob(f"{uuid_str}.jsonl"):
            subagents_dir = f.parent / uuid_str / "subagents"
            return f, subagents_dir if subagents_dir.is_dir() else None, uuid_str

    return None, None, None


def parse_jsonl(path: Path):
    lines = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            raw = raw.strip()
            if raw:
                try:
                    lines.append(json.loads(raw))
                except json.JSONDecodeError:
                    pass
    return lines


def content_preview(content, max_len=400):
    if isinstance(content, str):
        return content[:max_len]
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(item.get("text", "") or item.get("content", "") or "")
            elif isinstance(item, str):
                parts.append(item)
        return " ".join(parts)[:max_len]
    return str(content)[:max_len]


def looks_like_error(content):
    text = content_preview(content, 600).lower()
    patterns = [
        r"exit code [1-9]",
        r"\berror:",
        r"traceback",
        r"exception",
        r"command not found",
        r"permission denied",
        r"no such file",
        r"failed:",
    ]
    return any(re.search(p, text) for p in patterns)


def analyze_session(path: Path, agent_type: str = None, agent_name: str = None):
    lines = parse_jsonl(path)

    tool_calls = []
    tool_results = {}
    usage_total = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    model = None
    turns = 0
    skills_in_context = []
    started_at = None
    ended_at = None

    for entry in lines:
        ts = entry.get("timestamp")
        if ts:
            if started_at is None:
                started_at = ts
            ended_at = ts

        t = entry.get("type")

        if t == "assistant":
            turns += 1
            msg = entry.get("message", {})
            if not model:
                model = msg.get("model")
            usage = msg.get("usage", {})
            for k in usage_total:
                usage_total[k] += usage.get(k, 0)
            for item in msg.get("content", []):
                if isinstance(item, dict) and item.get("type") == "tool_use":
                    tool_calls.append({
                        "id": item["id"],
                        "name": item.get("name", "?"),
                        "input_summary": json.dumps(item.get("input", {}))[:300],
                    })

        elif t == "user":
            for item in entry.get("message", {}).get("content", []):
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "tool_result":
                    tc_id = item.get("tool_use_id")
                    rc = item.get("content", "")
                    is_raw_error = bool(item.get("is_error"))
                    tool_results[tc_id] = {
                        "preview": content_preview(rc),
                        "is_error": is_raw_error or looks_like_error(rc),
                    }

        elif t == "attachment":
            # Hook outputs: extract skill names from system-reminder lists
            hook_content = (
                entry.get("attachment", {}).get("content", "")
                or entry.get("content", "")
                or ""
            )
            if isinstance(hook_content, str):
                for m in re.findall(
                    r"^- ([a-z][a-z0-9_:.-]+)(?:\s*:.+)?$",
                    hook_content,
                    re.MULTILINE,
                ):
                    skills_in_context.append(m)

    annotated = []
    errors = []
    for i, tc in enumerate(tool_calls):
        res = tool_results.get(tc["id"], {})
        entry = {
            "seq": i + 1,
            "id": tc["id"],
            "name": tc["name"],
            "input_summary": tc["input_summary"],
            "result_preview": res.get("preview", "")[:200],
            "is_error": res.get("is_error", False),
        }
        annotated.append(entry)
        if entry["is_error"]:
            errors.append(entry)

    wall_seconds = None
    if started_at and ended_at and started_at != ended_at:
        a, b = _parse_iso(started_at), _parse_iso(ended_at)
        if a and b:
            wall_seconds = round((b - a).total_seconds(), 1)

    return {
        "session_id": path.stem,
        "agent_type": agent_type,
        "agent_name": agent_name,
        "path": str(path),
        "model": model,
        "turns": turns,
        "tool_calls": annotated,
        "usage": usage_total,
        "errors": errors,
        "skills_in_context": list(dict.fromkeys(skills_in_context)),
        "started_at": started_at,
        "ended_at": ended_at,
        "wall_seconds": wall_seconds,
    }


# Per-MTok USD. Matched by substring on the model id; unmatched models are unpriced.
# Cache write = 1.25x input, cache read = 0.1x input (standard Anthropic prompt-cache rates).
PRICING = {
    "fable":  {"input": 10.0,  "output": 50.0,  "cache_write": 12.50, "cache_read": 1.00},
    "mythos": {"input": 10.0,  "output": 50.0,  "cache_write": 12.50, "cache_read": 1.00},
    "opus":   {"input": 5.0,   "output": 25.0,  "cache_write": 6.25,  "cache_read": 0.50},
    "sonnet": {"input": 3.0,   "output": 15.0,  "cache_write": 3.75,  "cache_read": 0.30},
    "haiku":  {"input": 1.0,   "output": 5.0,   "cache_write": 1.25,  "cache_read": 0.10},
}


def _match_price(model_str):
    ml = (model_str or "").lower()
    for key, price in PRICING.items():
        if key in ml:
            return price
    return None


def estimate_cost(usage, model_str):
    p = _match_price(model_str)
    if p is None:
        return None
    M = 1_000_000
    return round(
        usage["input_tokens"] * p["input"] / M
        + usage["output_tokens"] * p["output"] / M
        + usage["cache_creation_input_tokens"] * p["cache_write"] / M
        + usage["cache_read_input_tokens"] * p["cache_read"] / M,
        4,
    )


def find_workflow_runs(parent: Path, session_id: str):
    """
    Discover Workflow tool runs for a session.

    Workflow agents are NOT in <sid>/subagents/ alongside normal subagents — they
    live in <sid>/subagents/workflows/<wf_id>/agent-*.jsonl, with run metadata in
    <sid>/workflows/<wf_id>.json. Returns [(wf_id, wf_dir, meta_file_or_None), ...].
    """
    base = parent / session_id / "subagents" / "workflows"
    meta_dir = parent / session_id / "workflows"
    runs = []
    if base.is_dir():
        for wf_dir in sorted(d for d in base.iterdir() if d.is_dir()):
            wf_id = wf_dir.name
            meta_file = meta_dir / f"{wf_id}.json"
            runs.append((wf_id, wf_dir, meta_file if meta_file.is_file() else None))
    return runs


def analyze_workflow(wf_id: str, wf_dir: Path, meta_file: Path):
    """
    Analyze one workflow run: enrich each agent transcript with progress metadata
    (label/phase/state from <wf_id>.json), aggregate usage, and price per agent
    model. Returns a dict; `agents` reuses analyze_session output verbatim.
    """
    meta = {}
    if meta_file is not None:
        try:
            meta = json.loads(meta_file.read_text())
        except Exception:
            meta = {}

    # Map agentId -> progress entry (label, phase, model, state, cached).
    progress = {}
    for p in meta.get("workflowProgress", []):
        if isinstance(p, dict) and p.get("type") == "workflow_agent":
            progress[p.get("agentId")] = p
    default_model = meta.get("defaultModel")

    agents = []
    usage_total = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    errors = []
    phase_rollup = {}
    cost_sum, any_priced = 0.0, False

    for sa_file in sorted(wf_dir.glob("agent-*.jsonl")):
        agent_id = sa_file.stem
        if agent_id.startswith("agent-"):
            agent_id = agent_id[len("agent-"):]
        pe = progress.get(agent_id, {})
        label = pe.get("label") or "(prior-run/untracked)"
        data = analyze_session(sa_file, agent_type="workflow-subagent")
        data["agent_id"] = agent_id
        data["label"] = label
        data["phase"] = pe.get("phaseTitle")
        data["state"] = pe.get("state")
        data["cached"] = pe.get("cached")
        # Workflow agent model can differ from main loop (e.g. fable vs opus).
        if not data.get("model"):
            data["model"] = pe.get("model") or default_model
        agents.append(data)

        for k in usage_total:
            usage_total[k] += data["usage"].get(k, 0)
        c = estimate_cost(data["usage"], data.get("model") or "")
        if c is not None:
            cost_sum += c
            any_priced = True
        for e in data["errors"]:
            errors.append({**e, "agent_id": agent_id, "label": label,
                           "phase": pe.get("phaseTitle")})

        ph = pe.get("phaseTitle") or "(untracked)"
        r = phase_rollup.setdefault(ph, {"agents": 0, "tool_calls": 0, "errors": 0})
        r["agents"] += 1
        r["tool_calls"] += len(data["tool_calls"])
        r["errors"] += len(data["errors"])

    return {
        "wf_id": wf_id,
        "workflow_name": meta.get("workflowName"),
        "status": meta.get("status"),
        "args": (meta.get("args") if isinstance(meta.get("args"), str)
                 else json.dumps(meta.get("args")))[:300] if meta.get("args") is not None else None,
        "default_model": default_model,
        "duration_ms": meta.get("durationMs"),
        "agent_count": meta.get("agentCount"),
        "transcript_files": len(agents),
        "meta_total_tokens": meta.get("totalTokens"),
        "meta_total_tool_calls": meta.get("totalToolCalls"),
        "phases": meta.get("phases"),
        "phase_rollup": phase_rollup,
        "usage": usage_total,
        "estimated_cost_usd": round(cost_sum, 4) if any_priced else None,
        "agents": agents,
        "errors": errors,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse_session.py <path-or-session-uuid>"}))
        sys.exit(1)

    main_path, subagents_dir, session_id = find_session_files(sys.argv[1])

    if main_path is None:
        print(json.dumps({"error": f"No session found at: {sys.argv[1]}"}))
        sys.exit(1)

    if isinstance(main_path, list):
        print(json.dumps({
            "multiple_sessions": [str(f) for f in main_path],
            "error": "Multiple session files found — please specify one.",
        }))
        sys.exit(2)

    main_data = analyze_session(main_path)

    subagent_data = []
    if subagents_dir:
        for sa_file in sorted(subagents_dir.glob("agent-*.jsonl")):
            # Load companion meta file for agent type
            meta_file = subagents_dir / (sa_file.stem + ".meta.json")
            agent_type = None
            agent_name = None
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text())
                    agent_type = meta.get("agentType") or meta.get("description")
                    agent_name = meta.get("description")
                except Exception:
                    pass
            subagent_data.append(analyze_session(sa_file, agent_type=agent_type, agent_name=agent_name))

    # Workflow runs: agents live in <sid>/subagents/workflows/<wf_id>/, not above.
    workflow_data = []
    for wf_id, wf_dir, wf_meta in find_workflow_runs(Path(main_path).parent, session_id):
        workflow_data.append(analyze_workflow(wf_id, wf_dir, wf_meta))

    # Flatten workflow agents so they count toward totals / by-model / cost.
    workflow_agents = [a for wf in workflow_data for a in wf["agents"]]

    # Aggregate totals
    totals = dict(main_data["usage"])
    for sa in subagent_data + workflow_agents:
        for k in totals:
            totals[k] += sa["usage"].get(k, 0)

    # Cost each session at its own model, then sum — mixed-model sessions price right.
    per_session = [main_data] + subagent_data + workflow_agents
    session_costs, unpriced = [], []
    for s in per_session:
        m = s.get("model") or ""
        c = estimate_cost(s["usage"], m)
        s["estimated_cost_usd"] = c  # store on the dict; None if unpriced
        (unpriced.append(m or "unknown") if c is None else session_costs.append(c))
    totals["estimated_cost_usd"] = round(sum(session_costs), 4) if session_costs else None
    main_model = main_data.get("model") or ""
    totals["pricing_tier"] = next((k for k in PRICING if k in main_model.lower()), None)
    if unpriced:
        totals["unpriced_models"] = sorted(set(unpriced))
    # Wall time reflects the main session span; subagents/workflow agents run
    # concurrently within it, so summing their walls would double-count.
    totals["wall_seconds"] = main_data.get("wall_seconds")

    # Per-model breakdown — group sessions by model id, sum usage + cost.
    by_model = {}
    for s in per_session:
        m = s.get("model") or "unknown"
        b = by_model.setdefault(m, {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "sessions": 0,
            "estimated_cost_usd": 0.0,
            "priced": True,
        })
        for k in ("input_tokens", "output_tokens",
                  "cache_creation_input_tokens", "cache_read_input_tokens"):
            b[k] += s["usage"].get(k, 0)
        b["sessions"] += 1
        c = estimate_cost(s["usage"], m)
        if c is None:
            b["priced"] = False
        else:
            b["estimated_cost_usd"] = round(b["estimated_cost_usd"] + c, 4)
    totals["by_model"] = by_model

    # Per-agent-execution breakdown — group by execution unit:
    #   "main session", each subagent agent_type, each "workflow:<name>".
    by_agent_items = [("main session", main_data)]
    for sa in subagent_data:
        key = sa.get("agent_type") or "subagent"
        by_agent_items.append((key, sa))
    for wf in workflow_data:
        wf_key = "workflow:" + (wf.get("workflow_name") or wf["wf_id"])
        for ag in wf["agents"]:
            by_agent_items.append((wf_key, ag))

    by_agent = {}
    for key, s in by_agent_items:
        b = by_agent.setdefault(key, {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "instances": 0,
            "models": [],
            "estimated_cost_usd": 0.0,
            "priced": True,
        })
        for k in ("input_tokens", "output_tokens",
                  "cache_creation_input_tokens", "cache_read_input_tokens"):
            b[k] += s["usage"].get(k, 0)
        b["instances"] += 1
        m = s.get("model") or "unknown"
        if m not in b["models"]:
            b["models"].append(m)
        c = s.get("estimated_cost_usd")  # already computed in the cost loop above
        if c is None:
            b["priced"] = False
        else:
            b["estimated_cost_usd"] = round(b["estimated_cost_usd"] + c, 4)
    totals["by_agent"] = by_agent

    # Derive report_timestamp (UTC) for use in the default report filename.
    # Format: YYYY-mm-DD-HHMM (string slice — ISO already UTC so no tz conversion).
    # Fallback to file mtime when no JSONL entry carries a timestamp.
    raw_ts = main_data.get("started_at")
    if raw_ts and len(raw_ts) >= 16:
        # "2026-06-11T16:12:14.966Z" → "2026-06-11-1612"
        report_timestamp = raw_ts[:10] + "-" + raw_ts[11:13] + raw_ts[14:16]
    else:
        mtime_utc = datetime.fromtimestamp(Path(main_path).stat().st_mtime, tz=timezone.utc)
        report_timestamp = mtime_utc.strftime("%Y-%m-%d-%H%M")

    result = {
        "session_id": session_id,
        "session_dir": str(Path(main_path).parent),
        "report_timestamp": report_timestamp,
        "main_session": main_data,
        "subagent_sessions": subagent_data,
        "workflow_sessions": workflow_data,
        "totals": totals,
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
