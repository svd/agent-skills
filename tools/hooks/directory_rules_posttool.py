#!/usr/bin/env python3
"""
PostToolUse hook (Edit|Write|MultiEdit): check an edited plugin file against the claude.ai
directory rules in docs/directory-rules.md. Pure stdlib.

Reads the hook's JSON from stdin and takes tool_input.file_path. For a file inside
plugins/<plugin>/, it runs `check_directory_rules.py files` on it (.ts, .tsx, .jsx, .md, .json)
and checks the file's size. Block and hold findings go to stderr with exit 2, so the model sees
them and fixes the file; anything else exits 0 silently.
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import check_directory_rules as cdr  # noqa: E402

CHECKED_EXT = {".ts", ".tsx", ".jsx", ".md", ".json"}
REPORTED = {"block", "hold"}


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    raw = (event.get("tool_input") or {}).get("file_path")
    if not raw:
        return 0
    path = Path(raw)
    if not path.is_absolute():
        path = Path(event.get("cwd") or os.getcwd()) / path
    path = path.resolve()
    plugins = (ROOT / "plugins").resolve()
    if not path.is_relative_to(plugins) or len(path.relative_to(plugins).parts) < 2 or not path.is_file():
        return 0

    rel = os.path.relpath(path, ROOT)
    findings = []
    if path.suffix.lower() in CHECKED_EXT:
        findings += cdr.run_files([str(path)])
    ext = path.suffix.lower()
    size = path.stat().st_size
    if size >= 5 * cdr.MIB:
        findings.append(cdr.Finding("O6", "block", rel, 1, f"{size / cdr.MIB:.1f} MiB; keep every file in the plugin folder under 5 MiB"))
    elif ext not in cdr.IMAGE_EXT | cdr.FONT_EXT and size >= 256 * cdr.KIB:
        findings.append(cdr.Finding("O8", "hold", rel, 1, f"{size / cdr.KIB:.0f} KiB; keep every file that isn't an image or font under 256 KiB (split it)"))

    findings = [f for f in findings if f.level in REPORTED]
    if not findings:
        return 0
    print("claude.ai directory rules (docs/directory-rules.md) — fix before committing:", file=sys.stderr)
    for f in findings:
        print(f.text(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
