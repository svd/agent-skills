#!/usr/bin/env python3
"""Parse a Claude Code session JSONL and output structured analysis JSON to stdout."""

import json
import sys
import os
import re
from datetime import datetime, timezone
from pathlib import Path


CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# Standard macOS Claude Desktop user-data roots. Desktop's actual root is wherever
# the app was launched with (--user-data-dir); these two are just the defaults
# --list-desktop scans automatically. Never treat this as exhaustive — callers pass
# --root for anything else (e.g. a custom --user-data-dir instance).
DEFAULT_DESKTOP_ROOTS = [
    Path.home() / "Library" / "Application Support" / "Claude",
    Path.home() / "Library" / "Application Support" / "Claude-3p",
]


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


def analyze_records(lines, ts_key="timestamp", agent_type=None, agent_name=None,
                     session_id=None, path=None, extra_skills=None):
    """
    Core per-record analysis loop, shared by both formats. `ts_key` selects the
    envelope's timestamp field ("timestamp" for Claude Code, "_audit_timestamp" for
    Desktop) — the inner `message` object (tool_use/tool_result/usage extraction) is
    identical between formats, so only the envelope-level field name varies.
    """
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
    skills_in_context = list(extra_skills or [])
    started_at = None
    ended_at = None
    # Desktop's audit log emits one "assistant" JSONL record per streamed content
    # block (thinking, tool_use, text, ...), all sharing one snake_case "request_id"
    # and each carrying an identical *copy* of that call's usage — not a per-block
    # delta. Summing every record double/triple-counts usage. Claude Code has no
    # such field (its request id is camelCase "requestId" at the envelope level, a
    # different key), so this dedup is a no-op there. Only usage/turns are deduped;
    # tool_use content is extracted from every record since the tool_use block
    # itself typically appears on only one of the duplicate records.
    #
    # Some Desktop records additionally omit "request_id" (null) while still
    # duplicating via a shared message.id with identical usage (verified on real
    # logs) — fall back to message.id as the dedup key, but ONLY for Desktop
    # (ts_key == "_audit_timestamp"). Claude Code assistant records legitimately
    # reuse the same message.id across genuinely separate JSONL turns (verified:
    # applying this fallback there corrupted turns/usage by ~2x on a real
    # transcript), so it must never apply to the Claude Code path.
    is_desktop = ts_key == "_audit_timestamp"
    counted_dedup_keys = set()

    for entry in lines:
        ts = entry.get(ts_key)
        if ts:
            if started_at is None:
                started_at = ts
            ended_at = ts

        t = entry.get("type")

        if t == "assistant":
            msg = entry.get("message", {})
            dedup_key = entry.get("request_id")
            if dedup_key is None and is_desktop:
                dedup_key = msg.get("id")
            if dedup_key is None or dedup_key not in counted_dedup_keys:
                if dedup_key is not None:
                    counted_dedup_keys.add(dedup_key)
                turns += 1
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
        "session_id": session_id,
        "agent_type": agent_type,
        "agent_name": agent_name,
        "path": path,
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


def analyze_session(path: Path, agent_type: str = None, agent_name: str = None, lines=None):
    """Claude Code entry point: reads path.stem as session_id, "timestamp" envelope key.
    Pass `lines` when the caller already parsed this file (e.g. for format detection)
    to avoid reading and re-parsing a large transcript twice."""
    if lines is None:
        lines = parse_jsonl(path)
    return analyze_records(lines, ts_key="timestamp", agent_type=agent_type,
                            agent_name=agent_name, session_id=path.stem, path=str(path))


# Per-MTok USD. Matched by substring on the model id; unmatched models are unpriced.
# Cache write = 1.25x input, cache read = 0.1x input (standard Anthropic prompt-cache rates).
PRICING = {
    "fable":  {"input": 10.0,  "output": 50.0,  "cache_write": 12.50, "cache_read": 1.00},
    "mythos": {"input": 10.0,  "output": 50.0,  "cache_write": 12.50, "cache_read": 1.00},
    "opus":   {"input": 5.0,   "output": 25.0,  "cache_write": 6.25,  "cache_read": 0.50},
    "sonnet": {"input": 3.0,   "output": 15.0,  "cache_write": 3.75,  "cache_read": 0.30},
    "haiku":  {"input": 1.0,   "output": 5.0,   "cache_write": 1.25,  "cache_read": 0.10},
}

# Sonnet 5 introductory pricing, effective through 2026-08-31 (inclusive).
# Applied only when a session's own start time falls in the window; standard
# PRICING["sonnet"] used otherwise.
SONNET_INTRO_PRICING = {"input": 2.0, "output": 10.0, "cache_write": 2.50, "cache_read": 0.20}
SONNET_INTRO_START = datetime(2026, 7, 1, tzinfo=timezone.utc)
SONNET_INTRO_END = datetime(2026, 9, 1, tzinfo=timezone.utc)  # exclusive -> Aug 31 fully included


def _match_price(model_str, session_dt=None):
    ml = (model_str or "").lower()
    for key, price in PRICING.items():
        if key in ml:
            if (key == "sonnet" and session_dt is not None
                    and SONNET_INTRO_START <= session_dt < SONNET_INTRO_END):
                return SONNET_INTRO_PRICING
            return price
    return None


def estimate_cost(usage, model_str, session_ts=None):
    session_dt = _parse_iso(session_ts) if session_ts else None
    p = _match_price(model_str, session_dt)
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
        c = estimate_cost(data["usage"], data.get("model") or "", data.get("started_at"))
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


def derive_report_timestamp(raw_ts, mtime_source: Path):
    """
    Format YYYY-mm-DD-HHMM (UTC) for the default report filename, from an ISO
    timestamp string when available, else the source file's mtime.
    """
    if raw_ts and len(raw_ts) >= 16:
        # "2026-06-11T16:12:14.966Z" → "2026-06-11-1612"
        return raw_ts[:10] + "-" + raw_ts[11:13] + raw_ts[14:16]
    mtime_utc = datetime.fromtimestamp(mtime_source.stat().st_mtime, tz=timezone.utc)
    return mtime_utc.strftime("%Y-%m-%d-%H%M")


def build_result(session_id, session_dir, main_data, subagent_data, workflow_data, report_timestamp):
    """
    Assemble the shared output shape (totals / by_model / by_agent rollups) from
    already-analyzed main/subagent/workflow data. Used by both the Claude Code and
    Desktop flows so they emit byte-identical downstream JSON.
    """
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
        c = estimate_cost(s["usage"], m, s.get("started_at"))
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
        c = estimate_cost(s["usage"], m, s.get("started_at"))
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

    return {
        "session_id": session_id,
        "session_dir": session_dir,
        "report_timestamp": report_timestamp,
        "main_session": main_data,
        "subagent_sessions": subagent_data,
        "workflow_sessions": workflow_data,
        "totals": totals,
    }


def detect_format(lines):
    """Structural detection, never path-based — a Desktop root can be anywhere the
    app's --user-data-dir pointed, and logs are often copied out of that dir for
    analysis. Every Desktop record carries snake_case _audit_timestamp; no Claude
    Code record does."""
    return "desktop" if any("_audit_timestamp" in e for e in lines) else "claude-code"


def segment_desktop_runs(lines):
    """
    Split one audit.jsonl into runs. A Desktop conversation directory's audit.jsonl
    is an append-only log of every run (one user prompt → completion) ever executed
    in that conversation — NOT one session. Each run is a self-contained
    (user prompt) … system/init … result block with its own internal CLI
    session_id. Two runs can even share the same session_id, so grouping by
    session_id (instead of by run boundary) would silently merge unrelated runs.

    Boundary is normally the `result` event, not `init`: the record(s) immediately
    preceding `init` are the user prompt that triggered that run (observed: a
    `user` record carrying the *conversation*-level session_id sits before `init`,
    which then opens with the run's own internal session_id) — they belong to the
    run that follows, not a prior one. So a bare `init` never closes the current
    run by itself.

    Exception: a run can be interrupted before it ever gets a `result` — the
    conversation then starts a genuinely new run with its own `init` (observed on
    real logs: `init, init, ..., result`, no result between the two inits). Once
    the current run already has an `init`, a second `init` means the first was
    abandoned — close it (partial, no result) and start fresh from the new `init`.
    Without this, the abandoned run's content silently merges into the next run's
    totals and takes on its `session_id`.
    """
    runs = []
    current = []
    current_has_init = False
    for entry in lines:
        is_init = entry.get("type") == "system" and entry.get("subtype") == "init"
        if is_init and current_has_init:
            runs.append(current)
            current = []
            current_has_init = False
        current.append(entry)
        if is_init:
            current_has_init = True
        if entry.get("type") == "result":
            runs.append(current)
            current = []
            current_has_init = False
    if current:
        runs.append(current)  # trailing partial run: no result event yet
    return runs


def analyze_desktop_run(records, conversation_id, source_path, run_index):
    """Analyze one init→result run: main-session records (no parent_tool_use_id)
    plus subagents grouped by parent_tool_use_id (Desktop subagents are inline in
    the same file, not separate transcripts)."""
    init = next((e for e in records if e.get("type") == "system" and e.get("subtype") == "init"), None)
    result_event = next((e for e in records if e.get("type") == "result"), None)
    run_sid = (
        (init or {}).get("session_id")
        or next((e.get("session_id") for e in records if e.get("session_id")), None)
        or f"{conversation_id}-run{run_index}"
    )

    extra_skills = []
    if init:
        extra_skills = list(init.get("skills") or []) + list(init.get("agents") or [])

    main_records = [e for e in records if not e.get("parent_tool_use_id")]
    main_data = analyze_records(main_records, ts_key="_audit_timestamp", session_id=run_sid,
                                 path=source_path, extra_skills=extra_skills)

    sub_groups = {}
    order = []
    for e in records:
        ptid = e.get("parent_tool_use_id")
        if ptid:
            if ptid not in sub_groups:
                sub_groups[ptid] = []
                order.append(ptid)
            sub_groups[ptid].append(e)

    subagent_data = []
    for ptid in order:
        grp = sub_groups[ptid]
        first = grp[0]
        subagent_data.append(analyze_records(
            grp, ts_key="_audit_timestamp",
            agent_type=first.get("subagent_type"),
            agent_name=first.get("task_description"),
            session_id=f"{run_sid}:{ptid}",
            path=source_path,
        ))

    workflow_data = []  # Desktop has no Workflow tool.

    report_timestamp = derive_report_timestamp(
        (init or {}).get("_audit_timestamp") or main_data.get("started_at"),
        Path(source_path),
    )

    result_obj = build_result(run_sid, str(Path(source_path).parent), main_data,
                               subagent_data, workflow_data, report_timestamp)

    # Prefer the result event's modelUsage as the run TOTAL's usage/cost source.
    # Empirically, Desktop emits one "assistant" JSONL record per streamed content
    # block (thinking, tool_use, text, ...) rather than one per completed turn, and
    # even after deduping by request_id, summing per-record usage still
    # undercounts output_tokens by ~4-5x against the result event's modelUsage on
    # inspected samples. The per-record sum (main_session/subagent_sessions usage,
    # by_agent split) is kept as-is for its correctly-attributed relative shape
    # (main vs. subagent, tool-call sequence, errors) but is NOT trustworthy as an
    # absolute total, so it is not used for totals/by_model when ground truth exists.
    totals = result_obj["totals"]
    totals["transcript_estimate_usd"] = totals["estimated_cost_usd"]
    model_usage = (result_event or {}).get("modelUsage")
    if model_usage:
        gt_by_model = {}
        gt_usage = {"input_tokens": 0, "output_tokens": 0,
                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
        gt_cost = 0.0
        for model_id, mu in model_usage.items():
            row = {
                "input_tokens": mu.get("inputTokens", 0),
                "output_tokens": mu.get("outputTokens", 0),
                "cache_creation_input_tokens": mu.get("cacheCreationInputTokens", 0),
                "cache_read_input_tokens": mu.get("cacheReadInputTokens", 0),
                "sessions": 1,
                "estimated_cost_usd": round(mu.get("costUSD", 0.0), 4),
                "priced": True,
            }
            gt_by_model[model_id] = row
            for k in gt_usage:
                gt_usage[k] += row[k]
            gt_cost += row["estimated_cost_usd"]
        for k in gt_usage:
            totals[k] = gt_usage[k]
        totals["estimated_cost_usd"] = round(gt_cost, 4)
        totals["by_model"] = gt_by_model
        totals["usage_source"] = "result_event_groundtruth"
        # by_agent (main vs. subagent split) still comes from the per-record
        # estimate above and is NOT guaranteed to sum to the groundtruth total.
        totals["by_agent_is_estimate"] = True
    elif result_event is not None and result_event.get("total_cost_usd") is not None:
        totals["estimated_cost_usd_groundtruth"] = result_event["total_cost_usd"]
        totals["usage_source"] = "transcript_estimate_cost_confirmed"
    else:
        totals["usage_source"] = "transcript_estimate"

    result_obj["run_index"] = run_index
    result_obj["conversation_id"] = conversation_id
    result_obj["partial"] = result_event is None
    return result_obj


def analyze_desktop_file(path: Path, lines):
    # Prefer content over path: any record before the first `init` still carries
    # the *conversation*-level session_id (the run's own id is only assigned
    # inside `init` — see segment_desktop_runs). Verified on all 111 real audit
    # logs on this machine: that leading session_id always matches the
    # local_<uuid> directory name. Deriving it from content instead means a copied
    # or renamed log (explicitly supported by structural detection) still gets its
    # real conversation id instead of an arbitrary parent-directory name.
    conversation_id = None
    for e in lines:
        if e.get("type") == "system" and e.get("subtype") == "init":
            break
        if e.get("session_id"):
            conversation_id = e["session_id"]
            break
    if conversation_id is None:
        conversation_id = path.parent.name
        if conversation_id.startswith("local_"):
            conversation_id = conversation_id[len("local_"):]
    runs = segment_desktop_runs(lines)
    run_results = [
        analyze_desktop_run(records, conversation_id, str(path), i)
        for i, records in enumerate(runs, start=1)
    ]
    return {
        "format": "desktop",
        "source_file": str(path),
        "conversation_id": conversation_id,
        "run_count": len(run_results),
        "runs": run_results,
    }


def resolve_desktop_candidate(target: str):
    """Return a Path to an audit.jsonl if `target` names one directly or names a
    directory containing one (e.g. a local_<uuid> conversation dir); else None."""
    p = Path(os.path.expanduser(target))
    if p.is_file():
        return p
    if p.is_dir() and (p / "audit.jsonl").is_file():
        return p / "audit.jsonl"
    return None


def list_desktop_sessions(roots):
    """Scan Desktop roots for local_<uuid> conversations. Roots are always supplied
    by the caller (DEFAULT_DESKTOP_ROOTS + any --root) — never hardcode a discovered
    path, since a Desktop root is wherever the user's --user-data-dir pointed."""
    out = []
    seen = set()
    for root in roots:
        base = root / "local-agent-mode-sessions"
        if not base.is_dir():
            continue
        for audit in sorted(base.glob("*/*/local_*/audit.jsonl")):
            conv_dir = audit.parent
            key = str(conv_dir.resolve())
            if key in seen:
                continue
            seen.add(key)
            conversation_id = conv_dir.name
            if conversation_id.startswith("local_"):
                conversation_id = conversation_id[len("local_"):]
            meta_file = conv_dir.parent / f"{conv_dir.name}.json"
            title = None
            if meta_file.is_file():
                try:
                    title = json.loads(meta_file.read_text()).get("title")
                except Exception:
                    pass
            lines = parse_jsonl(audit)
            run_count = sum(
                1 for e in lines if e.get("type") == "system" and e.get("subtype") == "init"
            )
            last_ts = None
            for e in reversed(lines):
                if e.get("_audit_timestamp"):
                    last_ts = e["_audit_timestamp"]
                    break
            out.append({
                "root": str(root),
                "conversation_id": conversation_id,
                "path": str(audit),
                "title": title,
                "run_count": run_count,
                "last_timestamp": last_ts,
            })
    out.sort(key=lambda r: r.get("last_timestamp") or "", reverse=True)
    return out


def main():
    argv = sys.argv[1:]
    if not argv:
        print(json.dumps({
            "error": "Usage: parse_session.py <path-or-session-uuid> | --list-desktop [--root PATH]",
        }))
        sys.exit(1)

    if argv[0] == "--list-desktop":
        roots = list(DEFAULT_DESKTOP_ROOTS)
        if "--root" in argv:
            idx = argv.index("--root")
            if idx + 1 < len(argv):
                roots.append(Path(os.path.expanduser(argv[idx + 1])))
        print(json.dumps(list_desktop_sessions(roots), indent=2))
        return

    target = argv[0]

    # Desktop paths don't fit the Claude Code UUID/dir shape (file is always named
    # audit.jsonl; dir is local_<uuid>), so try structural detection first. This is
    # deliberately NOT gated on filename shape (e.g. skipped for "looks like a
    # <uuid>.jsonl") — a Desktop log copied out for analysis can be renamed to
    # anything, including something UUID-shaped, and must still be detected by
    # content (_audit_timestamp), not by path.
    candidate = resolve_desktop_candidate(target)
    candidate_lines = None
    if candidate is not None:
        candidate_lines = parse_jsonl(candidate)
        if candidate_lines and detect_format(candidate_lines) == "desktop":
            print(json.dumps(analyze_desktop_file(candidate, candidate_lines), indent=2))
            return

    # --- Claude Code flow (unchanged) ---
    main_path, subagents_dir, session_id = find_session_files(target)

    if main_path is None:
        print(json.dumps({"error": f"No session found at: {target}"}))
        sys.exit(1)

    if isinstance(main_path, list):
        print(json.dumps({
            "multiple_sessions": [str(f) for f in main_path],
            "error": "Multiple session files found — please specify one.",
        }))
        sys.exit(2)

    # Reuse the file we already parsed for format detection above (the common case:
    # target names main_path directly) instead of reading it a second time.
    reuse_lines = candidate_lines if candidate is not None and candidate.resolve() == Path(main_path).resolve() else None
    main_data = analyze_session(main_path, lines=reuse_lines)

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

    report_timestamp = derive_report_timestamp(main_data.get("started_at"), Path(main_path))

    result = build_result(session_id, str(Path(main_path).parent), main_data,
                           subagent_data, workflow_data, report_timestamp)
    result["format"] = "claude-code"

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
