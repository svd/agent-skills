#!/usr/bin/env python3
"""Parse a Claude Code session JSONL and output structured analysis JSON to stdout."""

import json
import sys
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path


CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)

# Backstop only. Real teams observed at depth 2; the cap exists so a pathological
# tree can't run away, and hitting it is reported (coverage.discovery.depth_capped)
# rather than silently truncating.
MAX_TEAM_DEPTH = 5

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
        jsonl_files = sorted(f for f in p.glob("*.jsonl") if UUID_RE.match(f.stem))
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
    if UUID_RE.match(uuid_str):
        for f in CLAUDE_PROJECTS_DIR.rglob(f"{uuid_str}.jsonl"):
            subagents_dir = f.parent / uuid_str / "subagents"
            return f, subagents_dir if subagents_dir.is_dir() else None, uuid_str

    return None, None, None


# Memoized per projects_dir so recursion never rescans the tree.
# Value: (index, stats) where index is {teamName: [Path, ...]}.
_TEAM_INDEX_CACHE = {}


def scan_team_index(projects_dir=None):
    """
    Build {teamName: [session_jsonl, ...]} by peeking at the head of every top-level
    session transcript under `projects_dir`.

    Teammate sessions (the `Agent` tool's second spawn mode) are full, independent
    Claude Code sessions. Their transcript lives in the project directory matching the
    *teammate's own cwd*, which is frequently a different directory than the leader's —
    so there is no filesystem containment to exploit and no meta sidecar. The only
    reliable link is the `teamName` field the teammate's own records carry.

    A broad scan is deliberate: worktree/slug/cwd heuristics were measured to miss real
    teammates (one observed team spans two project slugs because a teammate's cwd was a
    subdirectory), and the scan is cheap — ~890 files in well under a second, because
    each file is peeked at 10 lines with a substring pre-filter before any json.loads.

    `projects_dir` is a parameter so tests can point at a temp tree instead of real
    ~/.claude data; it defaults at CALL time, not import time, so the default stays
    overridable. Unreadable files are collected, never raised.
    """
    projects_dir = Path(projects_dir if projects_dir is not None else CLAUDE_PROJECTS_DIR)
    key = str(projects_dir)
    if key in _TEAM_INDEX_CACHE:
        return _TEAM_INDEX_CACHE[key]

    index = {}
    files_scanned = 0
    unreadable = []
    started = time.time()

    for f in sorted(projects_dir.glob("*/*.jsonl")):
        if not UUID_RE.match(f.stem):
            continue
        files_scanned += 1
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                for i, raw in enumerate(fh):
                    if i >= 10:
                        break
                    # `teamName` is always written within the first few records; the
                    # substring test keeps us from json-parsing ~88% of all files.
                    if '"teamName"' not in raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    team = rec.get("teamName")
                    if team:
                        index.setdefault(team, []).append(f)
                        break
        except OSError as e:
            unreadable.append({"path": str(f), "error": str(e)})

    stats = {
        "files_scanned": files_scanned,
        "scan_seconds": round(time.time() - started, 2),
        "unreadable_files": unreadable,
    }
    _TEAM_INDEX_CACHE[key] = (index, stats)
    return index, stats


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


# "you are implementing X" / "you are reviewing Y" / "you are red-teaming Z".
# Generic verb capture rather than a fixed allowlist, so an unseen role still
# classifies instead of collapsing into "unclassified".
_ROLE_RE = re.compile(r"\byou are ([a-z]+(?:-[a-z]+)?)ing\b", re.I)

# The regex captures the stem before "-ing", which for the four common roles is
# already the role name.
_ROLE_ALIASES = {
    "implement": "implement",
    "review": "review",
    "audit": "audit",
    "red-team": "red-team",
}


def infer_role(lines):
    """
    Heuristic read of a teammate's role from the opening brief it was spawned with.

    Returns (role_or_None, role_source, brief_excerpt). `role_source` is
    "brief_heuristic" on a match and "unmatched" otherwise — the caller labels the
    role as a heuristic in the report so it is never mistaken for recorded metadata.
    """
    brief = ""
    for entry in lines:
        if entry.get("type") != "user":
            continue
        content = entry.get("message", {}).get("content")
        if isinstance(content, str) and "<teammate-message" in content:
            brief = content
            break

    excerpt = brief[:160]
    if not brief:
        return None, "unmatched", excerpt

    m = _ROLE_RE.search(brief)
    if not m:
        return None, "unmatched", excerpt

    stem = m.group(1).lower()
    if stem in _ROLE_ALIASES:
        return _ROLE_ALIASES[stem], "brief_heuristic", excerpt
    # English doubles a final consonant before "-ing" ("running" -> stem "runn"),
    # so undo the gemination to recover the verb ("run").
    if len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
        stem = stem[:-1]
    return stem, "brief_heuristic", excerpt


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


def analyze_subagents(subagents_dir: Path):
    """
    Analyze every in-process subagent transcript in a `<sid>/subagents/` directory,
    reading each `agent-*.meta.json` sidecar for the agent type/description.

    Both the analyzed target and any adopted teammate can own such a directory, so
    this loop lives here rather than inline in main().
    """
    out = []
    if not subagents_dir or not Path(subagents_dir).is_dir():
        return out
    subagents_dir = Path(subagents_dir)
    for sa_file in sorted(subagents_dir.glob("agent-*.jsonl")):
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
        out.append(analyze_session(sa_file, agent_type=agent_type, agent_name=agent_name))
    return out


def extract_agent_spawns(lines):
    """
    Parent-side view of `Agent` tool usage, for the coverage block only.

    The `Agent` tool has two spawn modes and the discriminator is structural: a
    tool_use whose `input` carries a `name` key spawns a **teammate** (an independent
    session with its own transcript elsewhere on disk); one without spawns an
    **in-process subagent** (transcript under `<sid>/subagents/`). The tool_result
    text is deliberately not parsed — it is internal metadata whose wording can change.

    This is reporting only. It must never gate teammate discovery: adopted teammates
    with no `Agent` call anywhere in the parent are real and routinely observed.
    """
    spawns = {}
    order = []
    in_process = 0
    agent_calls = 0
    results = {}

    for entry in lines:
        t = entry.get("type")
        if t == "assistant":
            for item in entry.get("message", {}).get("content", []) or []:
                if not isinstance(item, dict) or item.get("type") != "tool_use":
                    continue
                if item.get("name") != "Agent":
                    continue
                agent_calls += 1
                inp = item.get("input") or {}
                name = inp.get("name")
                if not name:
                    in_process += 1
                    continue
                tool_use_id = item.get("id")
                spawns[name] = {
                    "description": inp.get("description"),
                    "subagent_type": inp.get("subagent_type"),
                    "tool_use_id": tool_use_id,
                }
                order.append((name, tool_use_id))
        elif t == "user":
            for item in entry.get("message", {}).get("content", []) or []:
                if isinstance(item, dict) and item.get("type") == "tool_result":
                    rc = item.get("content", "")
                    results[item.get("tool_use_id")] = {
                        "is_error": bool(item.get("is_error")) or looks_like_error(rc),
                        "preview": content_preview(rc, 300),
                    }

    failed = []
    for name, tool_use_id in order:
        res = results.get(tool_use_id)
        if res and res["is_error"]:
            failed.append({
                "name": name,
                "error": res["preview"],
                "tool_use_id": tool_use_id,
            })

    return {
        "agent_tool_calls": agent_calls,
        "in_process_subagent_spawns": in_process,
        "teammate_spawns": spawns,
        "failed_spawns": failed,
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


def team_name_for(session_id: str):
    """The teamName a session's own teammates carry: "session-" + first 8 hex."""
    return "session-" + (session_id or "")[:8]


def analyze_teammate(path: Path, depth: int, parent_sid: str, spawn_meta=None):
    """
    Analyze one adopted teammate transcript and stamp the team metadata onto it.

    `agent_type` is set to "teammate:<role>" so the existing by_agent accumulation in
    build_result groups teammates by role with no further change. Keying by role
    rather than by agentName is deliberate: a 35-teammate run would otherwise produce
    35 singleton rows in the cost table and bury the model-mix signal (implement runs
    hot on opus, review on sonnet) that is the actionable finding. Per-name detail
    stays available in teammate_sessions[].

    Deliberately does not sum tokens or call estimate_cost — build_result owns all
    pricing and rollups.

    Returns `(data, spawn_info)`. The teammate's own `Agent` calls are extracted here,
    off the lines already in hand, because a teammate can spawn further teammates and
    coverage has to see those spawns too — a nested spawn with no transcript is missing
    volume exactly like a top-level one.
    """
    lines = parse_jsonl(path)
    role, role_source, brief_excerpt = infer_role(lines)

    agent_name = None
    team_name = None
    cwd = None
    git_branch = None
    for rec in lines:
        agent_name = agent_name or rec.get("agentName")
        team_name = team_name or rec.get("teamName")
        cwd = cwd or rec.get("cwd")
        git_branch = git_branch or rec.get("gitBranch")
        if agent_name and team_name and cwd and git_branch:
            break

    data = analyze_session(
        path,
        agent_type="teammate:" + (role or "unclassified"),
        agent_name=agent_name,
        lines=lines,
    )
    data.update({
        "kind": "teammate",
        "agent_name": agent_name,
        "role": role,
        "role_source": role_source,
        "team_name": team_name,
        "depth": depth,
        "parent_session_id": parent_sid,
        "project_slug": path.parent.name,
        "cwd": cwd,
        "git_branch": git_branch,
        "spawn_description": (
            (spawn_meta or {}).get("description") or brief_excerpt or None
        ),
        "matched_spawn": spawn_meta is not None,
    })
    return data, extract_agent_spawns(lines)


def _windows_overlap(a_start, a_end, b_start, b_end):
    """True when [a_start, a_end] and [b_start, b_end] intersect. Unknown bounds
    are treated as overlapping — absence of a timestamp is not evidence of a gap."""
    a0, a1 = _parse_iso(a_start), _parse_iso(a_end)
    b0, b1 = _parse_iso(b_start), _parse_iso(b_end)
    if not (a0 and a1 and b0 and b1):
        return True
    return a0 <= b1 and b0 <= a1


def new_team_state():
    """Mutable accumulator threaded through collect_team for the coverage block."""
    return {
        "team_claims": {},
        "project_slugs": set(),
        "depth_capped": [],
        "window_mismatches": [],
        "ambiguous_team_name": False,
        "max_depth_reached": 0,
        "windows": {},
        # {child_sid: spawn_info} for every adopted teammate, so build_coverage can
        # reconcile spawns raised at ANY depth, not only the target's own.
        "spawn_tables": {},
    }


def collect_team(parent_sid, index, visited, depth=0, max_depth=MAX_TEAM_DEPTH,
                 spawns=None, state=None):
    """
    Discover every teammate session led by `parent_sid`, plus each teammate's own
    in-process subagents and workflow agents. Returns a FLAT list — flatness is what
    lets build_result fold them into the existing rollups unchanged.

    Confirmation predicate is `teamName` equality alone, plus "not the target itself"
    and "not already visited". There is deliberately no time-window gate: teammates
    get resumed after the leader's last written line, the leader's ended_at is only
    its last record, and cross-process clock skew is unbounded — so a hard window test
    would drop real sessions. Prefix collision was measured at zero across ~890 local
    sessions (P ~ 9e-5), and a non-overlapping adoption is instead recorded as a soft
    `window_mismatches` warning and adopted anyway.

    `visited` is one set owned by the caller, keyed by BOTH resolved path and session
    id, seeded with the target's own file before any traversal, and inserted at
    discovery time. That, not predicate cleverness, is what prevents a descendant from
    re-adopting an ancestor: every ancestor is in the set before its descendants are
    scanned. Traversal is breadth-first by depth so nearest-ancestor attribution is
    deterministic.
    """
    state = state if state is not None else new_team_state()
    out = []
    queue = [(parent_sid, depth, spawns)]

    while queue:
        next_queue = []
        for sid, d, sid_spawns in queue:
            team = team_name_for(sid)
            candidates = index.get(team, [])
            if not candidates:
                continue

            # Two distinct sessions sharing an 8-hex prefix would both claim one
            # teamName. First claimant wins (BFS makes that the lowest depth); the
            # whole team is flagged so the report can distrust the attribution.
            claimant = state["team_claims"].get(team)
            if claimant is None:
                state["team_claims"][team] = sid
            elif claimant != sid:
                state["ambiguous_team_name"] = True
                continue

            if d + 1 > max_depth:
                state["depth_capped"].append(sid)
                continue

            parent_window = state["windows"].get(sid, (None, None))

            for path in candidates:
                resolved = str(Path(path).resolve())
                child_sid = Path(path).stem
                if resolved in visited or child_sid in visited:
                    continue
                if child_sid == sid:
                    continue  # self-adoption guard
                visited.add(resolved)
                visited.add(child_sid)

                tm, child_spawns = analyze_teammate(path, d + 1, sid, spawn_meta=None)
                state["spawn_tables"][child_sid] = child_spawns
                # Match by the teammate's own agentName against the parent's spawn
                # table; the spawn list is a strict subset of reality, so a miss is
                # normal and only affects reporting.
                meta = (sid_spawns or {}).get(tm.get("agent_name"))
                if meta:
                    tm["spawn_description"] = meta.get("description") or tm["spawn_description"]
                    tm["matched_spawn"] = True
                    tm["spawn_tool_use_id"] = meta.get("tool_use_id")
                out.append(tm)

                state["project_slugs"].add(Path(path).parent.name)
                state["max_depth_reached"] = max(state["max_depth_reached"], d + 1)
                state["windows"][child_sid] = (tm.get("started_at"), tm.get("ended_at"))

                if not _windows_overlap(parent_window[0], parent_window[1],
                                        tm.get("started_at"), tm.get("ended_at")):
                    state["window_mismatches"].append({
                        "session_id": child_sid,
                        "agent_name": tm.get("agent_name"),
                        "parent_session_id": sid,
                        "teammate_started_at": tm.get("started_at"),
                        "teammate_ended_at": tm.get("ended_at"),
                    })

                role_suffix = tm.get("role") or "unclassified"

                # A teammate is a full session, so it can own in-process subagents
                # and workflow runs of its own — both are attributed to the teammate
                # that owns them and flattened as siblings.
                for sa in analyze_subagents(Path(path).parent / child_sid / "subagents"):
                    sa["kind"] = "teammate-subagent"
                    sa["depth"] = d + 2
                    sa["parent_session_id"] = child_sid
                    sa["agent_type"] = "teammate-subagent:" + role_suffix
                    out.append(sa)

                for wf_id, wf_dir, wf_meta in find_workflow_runs(Path(path).parent, child_sid):
                    wf = analyze_workflow(wf_id, wf_dir, wf_meta)
                    wf_key = "teammate-workflow:" + (wf.get("workflow_name") or wf_id)
                    for ag in wf["agents"]:
                        ag["kind"] = "teammate-workflow-agent"
                        ag["depth"] = d + 2
                        ag["parent_session_id"] = child_sid
                        ag["agent_type"] = wf_key
                        out.append(ag)

                # Each level carries its own spawn table down, so a teammate spawned by
                # a teammate is matched (and, when its transcript is missing, reported
                # as unresolved) the same way a top-level spawn is.
                next_queue.append((child_sid, d + 1, child_spawns["teammate_spawns"]))
        queue = next_queue

    return out


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


def build_result(session_id, session_dir, main_data, subagent_data, workflow_data,
                 report_timestamp, teammate_data=None, coverage=None):
    """
    Assemble the shared output shape (totals / by_model / by_agent rollups) from
    already-analyzed main/subagent/workflow data. Used by both the Claude Code and
    Desktop flows so they emit byte-identical downstream JSON.

    `teammate_data` / `coverage` are keyword-only in practice: the Desktop flow calls
    this with six positional arguments and must stay bit-for-bit unaffected, so every
    teammate-related key is emitted only when `coverage` is supplied.
    """
    # Flatten workflow agents so they count toward totals / by-model / cost.
    workflow_agents = [a for wf in workflow_data for a in wf["agents"]]
    teammate_data = teammate_data or []

    # Aggregate totals
    totals = dict(main_data["usage"])
    for sa in subagent_data + workflow_agents + teammate_data:
        for k in totals:
            totals[k] += sa["usage"].get(k, 0)

    # Cost each session at its own model, then sum — mixed-model sessions price right.
    core_sessions = [main_data] + subagent_data + workflow_agents
    per_session = core_sessions + teammate_data
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

    if coverage is not None:
        # Teammates break the "children run inside the parent's span" assumption, so
        # the existing wall_seconds key keeps its meaning (report header and the
        # shared Desktop path depend on it) and the team-wide span is added beside it.
        core_costs = [s.get("estimated_cost_usd") for s in core_sessions]
        core_priced = [c for c in core_costs if c is not None]
        totals["core_cost_usd"] = round(sum(core_priced), 4) if core_priced else None
        totals["cost_scope"] = (
            "main+subagents+teammates" if teammate_data else "main+subagents"
        )

        starts = [_parse_iso(s.get("started_at")) for s in per_session]
        ends = [_parse_iso(s.get("ended_at")) for s in per_session]
        starts = [d for d in starts if d]
        ends = [d for d in ends if d]
        span = round((max(ends) - min(starts)).total_seconds(), 1) if starts and ends else None
        totals["span_wall_seconds"] = span
        agent_seconds = round(sum(s.get("wall_seconds") or 0 for s in per_session), 1)
        totals["agent_seconds"] = agent_seconds
        totals["concurrency_ratio"] = (
            round(agent_seconds / span, 2) if span else None
        )
        wall = totals.get("wall_seconds")
        totals["wall_seconds_covers_team"] = not (
            span is not None and wall is not None and span > wall
        )
        totals["coverage"] = coverage

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
    for tm in teammate_data:
        by_agent_items.append((tm.get("agent_type") or "teammate:unclassified", tm))

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

    result = {
        "session_id": session_id,
        "session_dir": session_dir,
        "report_timestamp": report_timestamp,
        "main_session": main_data,
        "subagent_sessions": subagent_data,
        "workflow_sessions": workflow_data,
        "totals": totals,
    }
    if coverage is not None:
        result["teammate_sessions"] = teammate_data
    return result


def build_coverage(enabled, team_name, spawn_info, teammate_data, state, scan_stats):
    """
    Assemble totals["coverage"].

    Two populations are counted in OPPOSITE directions, so they get two objects and
    never one "N of M": parent-side `Agent` calls (some of which never produced a
    transcript) and filesystem-side transcripts (some of which match no `Agent` call).
    No attempt is made to reconcile them — mismatches in both directions are normal.

    The spawn side is team-wide, not target-only: `state["spawn_tables"]` carries every
    adopted teammate's own `Agent` calls, and they are merged in here. Without that, a
    teammate spawned by a teammate whose transcript is missing would be invisible and
    `complete` would stay true while its tokens and cost were absent. Because that merge
    spans N transcripts and agent names are only unique within one, the spawn side is
    reconciled by count per name, never by set membership.

    `scan_stats is None` means the filesystem scan never ran (disabled, or no projects
    root on this machine — e.g. an exported transcript). That is NOT a scan that found
    nothing: discovery is unreliable, so `broad_scan` and `complete` are both false.
    """
    spawn_info = spawn_info or {"agent_tool_calls": 0, "in_process_subagent_spawns": 0,
                                "teammate_spawns": {}, "failed_spawns": []}
    state = state or new_team_state()
    scan_ran = scan_stats is not None
    scan_stats = scan_stats or {"files_scanned": 0, "scan_seconds": 0.0, "unreadable_files": []}

    teammates = [t for t in teammate_data if t.get("kind") == "teammate"]
    adopted_names = {t.get("agent_name") for t in teammates if t.get("agent_name")}

    # A session whose own candidates were never scanned (BFS stopped at the depth cap)
    # has a spawn table, but its spawns were never LOOKED for. Counting them as
    # "no transcript" would name specific agents as missing on no evidence; the
    # depth_capped reason already clears `complete` for them.
    capped = set(state["depth_capped"])

    # Target's table first, then each teammate's, so a name spawned at two depths keeps
    # the shallowest metadata — matching the BFS attribution collect_team already uses.
    detected = dict(spawn_info["teammate_spawns"])
    failed_list = list(spawn_info["failed_spawns"])
    agent_tool_calls = spawn_info["agent_tool_calls"]
    in_process = spawn_info["in_process_subagent_spawns"]
    # Reconciliation is by COUNT, not by set membership: agent names are only unique
    # within one transcript, and the team-wide merge spans N of them. Two sessions each
    # spawning "reviewer" when one transcript exists is one missing teammate, and a
    # name-keyed match would call it fully covered.
    searched_counts = {n: 1 for n in spawn_info["teammate_spawns"]}
    for sid, child in state["spawn_tables"].items():
        for name, meta in child["teammate_spawns"].items():
            detected.setdefault(name, meta)
            if sid not in capped:
                searched_counts[name] = searched_counts.get(name, 0) + 1
        failed_list.extend(child["failed_spawns"])
        agent_tool_calls += child["agent_tool_calls"]
        in_process += child["in_process_subagent_spawns"]

    adopted_counts = {}
    for t in teammates:
        n = t.get("agent_name")
        if n:
            adopted_counts[n] = adopted_counts.get(n, 0) + 1
    failed_counts = {}
    for f in failed_list:
        failed_counts[f["name"]] = failed_counts.get(f["name"], 0) + 1

    matched = sorted(n for n in detected if n in adopted_names)
    unresolved = sorted(
        n for n, c in searched_counts.items()
        if c > adopted_counts.get(n, 0) + failed_counts.get(n, 0)
    )
    orphans = sorted(
        ({"agent_name": t.get("agent_name"), "session_id": t.get("session_id")}
         for t in teammates if t.get("agent_name") not in detected),
        key=lambda r: (r["agent_name"] or "", r["session_id"] or ""),
    )

    unparseable = scan_stats["unreadable_files"]
    depth_capped = list(state["depth_capped"])
    ambiguous = bool(state["ambiguous_team_name"])

    reasons = []
    if not enabled:
        reasons.append("teammate scanning disabled (--no-teammates)")
    elif not scan_ran:
        reasons.append(
            f"teammate index scan did not run ({CLAUDE_PROJECTS_DIR} not found); "
            "no transcript could be discovered"
        )
    if unresolved:
        reasons.append(
            f"{len(unresolved)} teammate spawn(s) have no transcript: "
            + ", ".join(unresolved)
        )
    if depth_capped:
        reasons.append(
            f"recursion hit MAX_TEAM_DEPTH={MAX_TEAM_DEPTH} at "
            + ", ".join(depth_capped)
        )
    if unparseable:
        reasons.append(f"{len(unparseable)} session file(s) could not be read")
    if ambiguous:
        reasons.append("two sessions claim the same teamName; adoption may be wrong")

    # `complete` answers "is the total a floor, or the real number?" — orphans are
    # EXTRA coverage, not missing coverage, so they never clear it. A failed spawn
    # provably never started, so it produced no tokens to miss.
    complete = (enabled and scan_ran and not unresolved and not depth_capped
                and not unparseable and not ambiguous)
    # `reconciled` answers the different question "is every adopted session explained?"
    reconciled = complete and not orphans
    if complete and orphans:
        reasons.append(
            f"{len(orphans)} adopted teammate(s) have no matching Agent call"
        )

    return {
        "enabled": enabled,
        "team_name": team_name,
        "spawns": {
            "agent_tool_calls": agent_tool_calls,
            "resolved_in_process": in_process,
            "detected_teammate": len(detected),
            "matched_to_transcript": len(matched),
            "failed": len(failed_list),
        },
        "teammates": {
            "adopted": len(teammates),
            "matched_to_spawn": sum(1 for t in teammates if t.get("matched_spawn")),
            "orphan_adopted": len(orphans),
        },
        "unresolved_spawns": unresolved,
        "failed_spawns": [
            {"name": f["name"], "reason": f["error"], "tool_use_id": f["tool_use_id"]}
            for f in failed_list
        ],
        "orphan_teammates": orphans,
        "discovery": {
            "broad_scan": enabled and scan_ran,
            "files_scanned": scan_stats["files_scanned"],
            "scan_seconds": scan_stats["scan_seconds"],
            "max_depth_reached": state["max_depth_reached"],
            "depth_capped": depth_capped,
            "unparseable_files": unparseable,
            "project_slugs": sorted(state["project_slugs"]),
        },
        "window_mismatches": state["window_mismatches"],
        "ambiguous_team_name": ambiguous,
        "complete": complete,
        "reconciled": reconciled,
        "incomplete_reasons": reasons,
    }


def assert_disjoint(subagent_data, workflow_data, teammate_data):
    """
    Guard against double counting: a session reachable both as a subagent and as a
    teammate would be priced twice and inflate the headline total. Fail loudly.
    """
    groups = {
        "subagent_sessions": [s.get("session_id") for s in subagent_data],
        "workflow_agents": [a.get("session_id") for wf in workflow_data for a in wf["agents"]],
        "teammate_sessions": [t.get("session_id") for t in teammate_data],
    }
    names = list(groups)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            dupes = set(groups[a]) & set(groups[b])
            if dupes:
                raise AssertionError(
                    f"session id(s) counted in both {a} and {b}: {sorted(dupes)}"
                )


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
            "error": "Usage: parse_session.py [--no-teammates] <path-or-session-uuid> "
                     "| --list-desktop [--root PATH]",
        }))
        sys.exit(1)

    teammates_enabled = "--no-teammates" not in argv
    argv = [a for a in argv if a != "--no-teammates"]
    if not argv:
        print(json.dumps({"error": "No session target given."}))
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
    main_lines = reuse_lines if reuse_lines is not None else parse_jsonl(main_path)
    main_data = analyze_session(main_path, lines=main_lines)

    subagent_data = analyze_subagents(subagents_dir)

    # Workflow runs: agents live in <sid>/subagents/workflows/<wf_id>/, not above.
    workflow_data = []
    for wf_id, wf_dir, wf_meta in find_workflow_runs(Path(main_path).parent, session_id):
        workflow_data.append(analyze_workflow(wf_id, wf_dir, wf_meta))

    # The analyzed target may itself be somebody's teammate. Surface that membership,
    # but never adopt on the target's own teamName — only on the teams it leads.
    own_team = None
    own_agent_name = None
    for rec in main_lines:
        own_team = own_team or rec.get("teamName")
        own_agent_name = own_agent_name or rec.get("agentName")
        if own_team and own_agent_name:
            break
    main_data["team_membership"] = (
        {"team_name": own_team, "agent_name": own_agent_name} if own_team else None
    )

    teammate_data = []
    coverage = None
    if teammates_enabled:
        spawn_info = extract_agent_spawns(main_lines)
        index, scan_stats = ({}, None)
        state = new_team_state()
        if CLAUDE_PROJECTS_DIR.is_dir():
            index, scan_stats = scan_team_index(CLAUDE_PROJECTS_DIR)
        # Seed `visited` with the target itself, by both keys, before any traversal —
        # this is what stops a descendant from re-adopting the target.
        visited = {str(Path(main_path).resolve()), session_id}
        state["windows"][session_id] = (main_data.get("started_at"), main_data.get("ended_at"))
        teammate_data = collect_team(
            session_id, index, visited, spawns=spawn_info["teammate_spawns"], state=state
        )
        coverage = build_coverage(
            True, team_name_for(session_id), spawn_info, teammate_data, state, scan_stats
        )
    else:
        coverage = build_coverage(
            False, team_name_for(session_id), None, [], None, None
        )

    assert_disjoint(subagent_data, workflow_data, teammate_data)

    report_timestamp = derive_report_timestamp(main_data.get("started_at"), Path(main_path))

    result = build_result(session_id, str(Path(main_path).parent), main_data,
                           subagent_data, workflow_data, report_timestamp,
                           teammate_data=teammate_data, coverage=coverage)
    result["format"] = "claude-code"

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
