#!/usr/bin/env python3
"""Inventory, deep-stat, and safely remove Claude Code projects from ~/.claude.

Stdlib only. All subcommands print JSON to stdout so the calling model can
render it. File deletion happens only via `remove` and only for the explicitly
named categories; everything else is read-only.

Source of truth for "a project":
  - ~/.claude.json  -> projects{<absolute cwd path>: {...config, cost, tokens}}
  - ~/.claude/projects/<encoded>/  -> session transcript dir (one .jsonl per session)

Encoded dir name = re.sub(r'[^a-zA-Z0-9]', '-', absolute_path)  (case preserved).
A session id is the stem of a <id>.jsonl file. That id keys the project's
traces elsewhere: todos/<id>-*, file-history/<id>/.
"""
import argparse
import json
import os
import re
import sys
import tarfile
import time
from pathlib import Path

HOME = Path.home()
CLAUDE = HOME / ".claude"
CONFIG = HOME / ".claude.json"
PROJECTS = CLAUDE / "projects"
TODOS = CLAUDE / "todos"
FILE_HISTORY = CLAUDE / "file-history"
BACKUPS = CLAUDE / "backups"
HISTORY = CLAUDE / "history.jsonl"

# Per-MTok USD. Matched by substring on the model id; unmatched models report tokens only.
# Cache write = 1.25x input, cache read = 0.1x input (standard Anthropic prompt-cache rates).
PRICING = {
    "fable":  {"input": 10.0, "output": 50.0,  "cache_write": 12.50, "cache_read": 1.00},
    "mythos": {"input": 10.0, "output": 50.0,  "cache_write": 12.50, "cache_read": 1.00},
    "opus":   {"input": 5.0,  "output": 25.0,  "cache_write": 6.25,  "cache_read": 0.50},
    "sonnet": {"input": 3.0,  "output": 15.0,  "cache_write": 3.75,  "cache_read": 0.30},
    "haiku":  {"input": 1.0,  "output": 5.0,   "cache_write": 1.25,  "cache_read": 0.10},
}


def encode_path(p: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "-", p)


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except Exception:
        return {}


def human(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return f"{f:.0f}{unit}" if unit == "B" else f"{f:.1f}{unit}"
        f /= 1024
    return f"{f:.1f}TB"


def dir_size(p: Path) -> int:
    total = 0
    if not p.exists():
        return 0
    for root, _dirs, files in os.walk(p):
        for fn in files:
            try:
                total += (Path(root) / fn).stat().st_size
            except OSError:
                pass
    return total


def session_dir(path: str) -> Path:
    return PROJECTS / encode_path(path)


def session_files(path: str):
    d = session_dir(path)
    return sorted(d.glob("*.jsonl")) if d.exists() else []


def session_ids(path: str):
    return [f.stem for f in session_files(path)]


def count_dir(p: Path, pattern: str) -> int:
    return len(list(p.glob(pattern))) if p.exists() else 0


def project_assets(path: str) -> dict:
    """Skills / agents / commands defined inside the project's own .claude dir."""
    proj = Path(path)
    cdir = proj / ".claude"
    skills = [d.name for d in (cdir / "skills").glob("*") if (d / "SKILL.md").exists()] if (cdir / "skills").exists() else []
    agents = [f.stem for f in (cdir / "agents").glob("*.md")] if (cdir / "agents").exists() else []
    commands = [f.stem for f in (cdir / "commands").glob("*.md")] if (cdir / "commands").exists() else []
    return {"skills": skills, "agents": agents, "commands": commands}


def project_mcps(path: str, cfg_entry: dict) -> dict:
    """MCP servers visible to a project: config entry + project-local .mcp.json."""
    servers = set()
    for k in ("mcpServers",):
        v = cfg_entry.get(k) or {}
        if isinstance(v, dict):
            servers.update(v.keys())
    for k in ("enabledMcpjsonServers",):
        v = cfg_entry.get(k) or []
        if isinstance(v, list):
            servers.update(v)
    mcp_json = Path(path) / ".mcp.json"
    if mcp_json.exists():
        try:
            servers.update((json.loads(mcp_json.read_text()).get("mcpServers") or {}).keys())
        except Exception:
            pass
    return {"mcps": sorted(servers)}


def project_plugins(path: str) -> list:
    plugins = set()
    for fn in (".claude/settings.json", ".claude/settings.local.json"):
        f = Path(path) / fn
        if f.exists():
            try:
                ep = json.loads(f.read_text()).get("enabledPlugins") or {}
                if isinstance(ep, dict):
                    plugins.update(ep.keys())
                elif isinstance(ep, list):
                    plugins.update(ep)
            except Exception:
                pass
    return sorted(plugins)


def last_modified(path: str):
    files = session_files(path)
    if not files:
        return None
    return max(f.stat().st_mtime for f in files)


def basic_stats(path: str, cfg: dict) -> dict:
    entry = (cfg.get("projects") or {}).get(path, {})
    assets = project_assets(path)
    mcps = project_mcps(path, entry)
    sd = session_dir(path)
    lm = last_modified(path)
    sz = dir_size(sd)
    return {
        "path": path,
        "in_config": path in (cfg.get("projects") or {}),
        "session_dir": str(sd),
        "session_dir_exists": sd.exists(),
        "sessions": len(session_files(path)),
        "skills": assets["skills"],
        "agents": assets["agents"],
        "commands": assets["commands"],
        "mcps": mcps["mcps"],
        "plugins": project_plugins(path),
        "size_bytes": sz,
        "size_human": human(sz),
        "last_modified": lm,
        "last_modified_iso": time.strftime("%Y-%m-%d %H:%M", time.localtime(lm)) if lm else None,
        "last_cost_usd": entry.get("lastCost"),
        "last_session_first_prompt": entry.get("lastSessionFirstPrompt"),
    }


def cmd_list(args):
    cfg = load_config()
    cwd = args.cwd
    registered = list((cfg.get("projects") or {}).keys())

    # Orphan session dirs: encoded dir present but no config entry.
    encoded_registered = {encode_path(p) for p in registered}
    orphans = []
    if PROJECTS.exists():
        for d in PROJECTS.iterdir():
            if d.is_dir() and d.name not in encoded_registered:
                orphans.append(d.name)

    out = []
    for p in registered:
        s = basic_stats(p, cfg)
        s["kind"] = "registered"
        s["is_cwd"] = (cwd is not None and os.path.abspath(cwd) == os.path.abspath(p))
        out.append(s)
    for name in sorted(orphans):
        sd = PROJECTS / name
        out.append({
            "path": None,
            "encoded_name": name,
            "kind": "orphan_session_dir",
            "in_config": False,
            "session_dir": str(sd),
            "session_dir_exists": True,
            "sessions": len(list(sd.glob("*.jsonl"))),
            "size_bytes": dir_size(sd),
            "size_human": human(dir_size(sd)),
            "is_cwd": False,
        })

    # sort registered by last activity desc, cwd first
    out.sort(key=lambda x: (not x.get("is_cwd"), -(x.get("last_modified") or 0)))
    print(json.dumps({"cwd": cwd, "count": len(out), "projects": out}, indent=2))


def cmd_stats(args):
    cfg = load_config()
    print(json.dumps(basic_stats(args.path, cfg), indent=2))


def cmd_deepstats(args):
    path = args.path
    by_model = {}
    sessions = 0
    first_ts = None
    last_ts = None
    sd = session_dir(path)
    main_files = session_files(path)
    sessions = len(main_files)
    scan_files = list(main_files)
    for mf in main_files:
        sub = sd / mf.stem / "subagents"
        if sub.is_dir():
            scan_files.extend(sorted(sub.glob("agent-*.jsonl")))
    for f in scan_files:
        for line in _iter_lines(f):
            try:
                d = json.loads(line)
            except Exception:
                continue
            ts = d.get("timestamp")
            if ts:
                first_ts = ts if first_ts is None or ts < first_ts else first_ts
                last_ts = ts if last_ts is None or ts > last_ts else last_ts
            msg = d.get("message") or {}
            usage = msg.get("usage")
            if not usage:
                continue
            model = msg.get("model") or "unknown"
            m = by_model.setdefault(model, {
                "input_tokens": 0, "output_tokens": 0,
                "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                "messages": 0,
            })
            m["messages"] += 1
            for k in ("input_tokens", "output_tokens",
                      "cache_creation_input_tokens", "cache_read_input_tokens"):
                m[k] += usage.get(k) or 0

    total_cost = 0.0
    priced_any = False
    unpriced = []
    for model, m in by_model.items():
        price = _match_price(model)
        if price:
            cost = (
                m["input_tokens"] * price["input"]
                + m["output_tokens"] * price["output"]
                + m["cache_creation_input_tokens"] * price["cache_write"]
                + m["cache_read_input_tokens"] * price["cache_read"]
            ) / 1_000_000
            m["est_cost_usd"] = round(cost, 4)
            total_cost += cost
            priced_any = True
        else:
            m["est_cost_usd"] = None
            unpriced.append(model)

    print(json.dumps({
        "path": path,
        "sessions": sessions,
        "first_activity": first_ts,
        "last_activity": last_ts,
        "by_model": by_model,
        "total_est_cost_usd": round(total_cost, 2) if priced_any else None,
        "unpriced_models": unpriced,
        "note": "Cost is an estimate from token counts and a static Claude price table. "
                "Unpriced models report tokens only.",
    }, indent=2))


def _iter_lines(f: Path):
    try:
        with f.open("r", errors="replace") as fh:
            for line in fh:
                yield line
    except OSError:
        return


def _match_price(model: str):
    ml = model.lower()
    for key, price in PRICING.items():
        if key in ml:
            return price
    return None


def cmd_traces(args):
    print(json.dumps(_collect_traces(args.path), indent=2))


def _collect_traces(path: str) -> dict:
    ids = set(session_ids(path))
    sd = session_dir(path)

    # history.jsonl lines matching this project cwd
    hist_matches = 0
    if HISTORY.exists():
        for line in _iter_lines(HISTORY):
            try:
                if json.loads(line).get("project") == path:
                    hist_matches += 1
            except Exception:
                pass

    # todos keyed by session id prefix
    todo_files = []
    if TODOS.exists():
        for f in TODOS.glob("*"):
            if any(f.name.startswith(i) for i in ids):
                todo_files.append(f.name)

    # file-history dirs/files keyed by session id
    fh_matches = []
    if FILE_HISTORY.exists():
        for f in FILE_HISTORY.glob("*"):
            if f.name in ids or any(f.name.startswith(i) for i in ids):
                fh_matches.append(f.name)

    cfg = load_config()
    return {
        "path": path,
        "categories": {
            "sessions": {
                "description": "Session transcript dir",
                "target": str(sd),
                "exists": sd.exists(),
                "files": len(session_files(path)),
                "size_human": human(dir_size(sd)),
            },
            "config": {
                "description": "~/.claude.json projects entry",
                "target": "~/.claude.json projects[" + path + "]",
                "exists": path in (cfg.get("projects") or {}),
            },
            "history": {
                "description": "Prompt history lines (history.jsonl)",
                "target": str(HISTORY),
                "matches": hist_matches,
            },
            "todos": {
                "description": "Saved todo lists for this project's sessions",
                "target": str(TODOS),
                "matches": len(todo_files),
            },
            "filehistory": {
                "description": "Edited-file backups for this project's sessions",
                "target": str(FILE_HISTORY),
                "matches": len(fh_matches),
            },
        },
        "_session_ids": sorted(ids),
        "_todo_files": sorted(todo_files),
        "_filehistory": sorted(fh_matches),
    }


def cmd_remove(args):
    path = args.path
    cats = [c.strip() for c in args.categories.split(",") if c.strip()]
    valid = {"sessions", "config", "history", "todos", "filehistory"}
    bad = set(cats) - valid
    if bad:
        print(json.dumps({"error": f"unknown categories: {sorted(bad)}", "valid": sorted(valid)}))
        sys.exit(2)

    traces = _collect_traces(path)
    ids = set(traces["_session_ids"])
    plan = {"path": path, "categories": cats, "dry_run": args.dry_run, "backup": None, "deleted": {}}

    # Gather concrete file targets per category.
    targets = {}  # category -> list[Path]
    if "sessions" in cats:
        sd = session_dir(path)
        targets["sessions"] = [sd] if sd.exists() else []
    if "todos" in cats:
        targets["todos"] = [TODOS / n for n in traces["_todo_files"]]
    if "filehistory" in cats:
        targets["filehistory"] = [FILE_HISTORY / n for n in traces["_filehistory"]]

    if args.dry_run:
        plan["would_delete"] = {k: [str(p) for p in v] for k, v in targets.items()}
        if "config" in cats:
            plan["would_delete"]["config"] = [f"~/.claude.json projects[{path}]"]
        if "history" in cats:
            plan["would_delete"]["history"] = [f"{traces['categories']['history']['matches']} lines in history.jsonl"]
        print(json.dumps(plan, indent=2))
        return

    if not args.backup:
        print(json.dumps({"warning": "--backup not set; deletion is unrecoverable"}),
              file=sys.stderr)

    # Backup before any destructive op.
    if args.backup:
        BACKUPS.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", os.path.basename(path.rstrip("/")) or "project").strip("-")
        tar_path = BACKUPS / f"{slug}-{stamp}.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            for cat, paths in targets.items():
                for p in paths:
                    if p.exists():
                        tar.add(p, arcname=f"{cat}/{p.name}")
            # back up config entry + matching history lines as json blobs
            cfg = load_config()
            if "config" in cats and path in (cfg.get("projects") or {}):
                _tar_bytes(tar, "config/entry.json",
                           json.dumps(cfg["projects"][path], indent=2).encode())
            if "history" in cats and HISTORY.exists():
                kept = [l for l in _iter_lines(HISTORY)
                        if _safe_project(l) == path]
                _tar_bytes(tar, "history/removed-lines.jsonl", "".join(kept).encode())
        plan["backup"] = str(tar_path)

    deleted = {}
    # sessions / todos / filehistory: filesystem deletes
    import shutil
    for cat in ("sessions", "todos", "filehistory"):
        if cat in cats:
            n = 0
            for p in targets.get(cat, []):
                try:
                    if p.is_dir():
                        shutil.rmtree(p)
                    elif p.exists():
                        p.unlink()
                    n += 1
                except OSError as e:
                    deleted.setdefault("_errors", []).append(f"{p}: {e}")
            deleted[cat] = n

    # config: drop the projects entry, rewrite .claude.json atomically
    if "config" in cats:
        cfg = load_config()
        if path in (cfg.get("projects") or {}):
            del cfg["projects"][path]
            tmp = CONFIG.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(cfg, indent=2))
            os.replace(tmp, CONFIG)
            deleted["config"] = 1
        else:
            deleted["config"] = 0

    # history: filter out matching lines
    if "history" in cats and HISTORY.exists():
        kept = [l for l in _iter_lines(HISTORY) if _safe_project(l) != path]
        removed = sum(1 for _ in _iter_lines(HISTORY)) - len(kept)
        HISTORY.write_text("".join(kept))
        deleted["history"] = removed

    plan["deleted"] = deleted
    print(json.dumps(plan, indent=2))


def _tar_bytes(tar, name, data: bytes):
    import io
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mtime = int(time.time())
    tar.addfile(info, io.BytesIO(data))


def _safe_project(line: str):
    try:
        return json.loads(line).get("project")
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="inventory all registered + orphan projects")
    p.add_argument("--cwd", default=None, help="current dir, to mark the preselected project")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("stats", help="basic stats for one project")
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("deepstats", help="token usage + estimated cost for one project")
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_deepstats)

    p = sub.add_parser("traces", help="enumerate removable traces for one project")
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_traces)

    p = sub.add_parser("remove", help="remove selected trace categories (backs up first)")
    p.add_argument("--path", required=True)
    p.add_argument("--categories", required=True,
                   help="comma list: sessions,config,history,todos,filehistory")
    p.add_argument("--backup", action="store_true", help="tar.gz traces to ~/.claude/backups first")
    p.add_argument("--dry-run", action="store_true", help="show what would be deleted, do nothing")
    p.set_defaults(func=cmd_remove)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
