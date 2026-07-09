#!/usr/bin/env python3
"""
Self-check for handoff_tool.py. Pure stdlib. Not part of normal per-handoff
usage — run this after editing handoff_tool.py to confirm it still works.

Usage:
  python3 scripts/smoke_test.py
"""

import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TOOL = Path(__file__).resolve().parent / "handoff_tool.py"

VALID_TEMPLATE = """# Session Handoff — Smoke Test

Created: 2026-01-01 00:00 · Project slug: `smoke-test` · Git HEAD: `abc123` · Parent: `{parent}`

Trust tags:
- `[V]` verified during this handoff run
- `[?]` unverified memory
- `[S]` stale-risk

## Summary
Smoke test handoff. [V]

## Current Goal
Verify handoff_tool.py works.

## Verified State
- dummy.py exists and was re-read just now. [V]

## Key Decisions
- Used a temp dir for isolation — why: keeps smoke test hermetic. [V]

## Traps to Avoid / Failed Approaches
- N/A for smoke test.

## Relevant Files / Sources
- `dummy.py` — dummy file created by the smoke test.

## Open Work
- Nothing pending.

## Parent / Chain Context
{parent_context}

## Resume Prompt

Before responding: read this handoff in full, then read every file/source listed under "Relevant
Files / Sources" — do not assume this document alone is enough context. If this is a repo, check
git status, git log, and git diff to confirm the working state still matches what's described
here. Treat every [?] and [S] item as a lead to verify, not a fact to trust blindly — do not rely
on unverified or stale-risk claims without checking them against the current state first. Once
you've done this, restate your understanding briefly, then wait for instructions.
"""

results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not condition else ""))


def run(args, cwd):
    return subprocess.run(
        [sys.executable, str(TOOL)] + args,
        capture_output=True, text=True, cwd=cwd, check=False,
    )


def parse_kv(stdout, key):
    for line in stdout.splitlines():
        if line.startswith(key + "="):
            return line[len(key) + 1:]
    return None


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        has_git = shutil.which("git") is not None

        if has_git:
            subprocess.run(["git", "init", "-q"], cwd=tmp, check=False)
            subprocess.run(["git", "config", "user.email", "smoke@test.local"], cwd=tmp, check=False)
            subprocess.run(["git", "config", "user.name", "smoke"], cwd=tmp, check=False)
            # Handoffs commonly live outside version control (WIP notes, may
            # reference local state) — ignore them so the "clean tree" case
            # below reflects real usage instead of the handoff files themselves.
            (tmp / ".gitignore").write_text(".claude/session-handoffs/\n")

        (tmp / "dummy.py").write_text("print('hello')\n")

        if has_git:
            subprocess.run(["git", "add", "."], cwd=tmp, check=False)
            subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmp, check=False)

        # 1. new (first handoff, no parent)
        r = run(["new", "smoke-test"], cwd=tmp)
        new_path = parse_kv(r.stdout, "NEW_PATH")
        parent_path = parse_kv(r.stdout, "PARENT_PATH")
        check("new: prints NEW_PATH", new_path is not None, r.stdout)
        check("new: no parent on first handoff", parent_path == "none", r.stdout)

        handoff_path = tmp / new_path
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        handoff_path.write_text(VALID_TEMPLATE.format(parent="none", parent_context="None — first handoff for this project."))

        # 2. validate (valid handoff)
        r = run(["validate", str(handoff_path)], cwd=tmp)
        check("validate: valid handoff passes", r.returncode == 0, r.stdout + r.stderr)

        # 3. inspect
        r = run(["inspect", str(handoff_path)], cwd=tmp)
        check("inspect: reports headings", "## Summary" in r.stdout, r.stdout)
        check("inspect: reports tag counts", "[V]=" in r.stdout, r.stdout)
        check("inspect: finds referenced local file", "✅" in r.stdout, r.stdout)

        # 4. list / latest
        r = run(["list", "smoke-test"], cwd=tmp)
        check("list: echoes handoff path", new_path in r.stdout, r.stdout)

        r = run(["latest", "smoke-test"], cwd=tmp)
        check("latest: echoes handoff path", new_path in r.stdout.strip(), r.stdout)

        # 5. new again -> parent should now be the first handoff
        time.sleep(0.05)  # ensure a distinct mtime — chain lookup now sorts by mtime, not filename
        r = run(["new", "smoke-test"], cwd=tmp)
        second_new_path = parse_kv(r.stdout, "NEW_PATH")
        second_parent = parse_kv(r.stdout, "PARENT_PATH")
        check("new: second handoff chains to first as parent", second_parent == new_path, f"got {second_parent!r}, expected {new_path!r}")

        # 6. regression: latest/new must sort by mtime, not by filename — a
        # same-minute handoff with a lexically-smaller random suffix used to
        # be treated as older even when it was actually written later.
        mtime_dir = tmp / ".claude" / "session-handoffs" / "mtime-test"
        mtime_dir.mkdir(parents=True, exist_ok=True)
        lexically_larger_but_older = mtime_dir / "20260101-0000-zzzz.md"
        lexically_smaller_but_newer = mtime_dir / "20260101-0000-aaaa.md"
        lexically_larger_but_older.write_text("older, lexically-larger name\n")
        time.sleep(0.05)
        lexically_smaller_but_newer.write_text("newer, lexically-smaller name\n")
        r = run(["latest", "mtime-test"], cwd=tmp)
        check(
            "latest: sorts by mtime, not filename",
            r.stdout.strip().endswith("aaaa.md"),
            r.stdout,
        )

        # 7. regression: validate must not be fooled by example/reference
        # content pasted inside a fenced code block.
        # (written into the gitignored handoff dir — see step 11's comment)
        fenced_path = handoff_path.parent / "fenced.md"
        fenced_bypass = (
            "# Session Handoff — Fence Bypass\n\n"
            "## Summary\nOnly real section in this file. [V]\n\n"
            "```\n" + VALID_TEMPLATE.format(parent="none", parent_context="None") + "\n```\n"
        )
        fenced_path.write_text(fenced_bypass)
        r = run(["validate", str(fenced_path)], cwd=tmp)
        check("validate: fenced example content doesn't satisfy required sections", r.returncode == 1, r.stdout)

        # 8. regression: mailto: (non-slash URI scheme) must not be flagged as
        # a missing local file.
        uri_scheme_path = handoff_path.parent / "uri-scheme.md"
        uri_scheme_handoff = VALID_TEMPLATE.format(parent="none", parent_context="None").replace(
            "- `dummy.py` — dummy file created by the smoke test.",
            "- `dummy.py` — dummy file created by the smoke test.\n"
            "- `mailto:foo@example.com` — contact for this project.",
        )
        uri_scheme_path.write_text(uri_scheme_handoff)
        r = run(["validate", str(uri_scheme_path)], cwd=tmp)
        check(
            "validate: mailto: link not flagged as missing file",
            "Referenced local file not found: `mailto:" not in r.stdout,
            r.stdout,
        )

        # 9. validate: missing required section -> error
        # (written into the gitignored handoff dir so it doesn't dirty the
        # working tree for the "clean repo" stale check below)
        missing_section_path = handoff_path.parent / "missing.md"
        broken = VALID_TEMPLATE.format(parent="none", parent_context="None").replace("## Open Work\n- Nothing pending.\n\n", "")
        missing_section_path.write_text(broken)
        r = run(["validate", str(missing_section_path)], cwd=tmp)
        check("validate: missing section fails", r.returncode == 1, r.stdout)

        # 10. validate: fake secret -> error
        secret_path = handoff_path.parent / "secret.md"
        with_secret = VALID_TEMPLATE.format(parent="none", parent_context="None") + "\nsk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
        secret_path.write_text(with_secret)
        r = run(["validate", str(secret_path)], cwd=tmp)
        check("validate: secret pattern fails", r.returncode == 1, r.stdout)

        # 11. stale — working tree is still clean relative to the "init" commit
        # (all handoff files live under the gitignored .claude/session-handoffs/)
        if has_git:
            r = run(["stale", "smoke-test"], cwd=tmp)
            check("stale: clean repo reports OK", r.returncode == 0, r.stdout)

            (tmp / "dummy.py").write_text("print('changed')\n")
            time.sleep(0.05)
            r = run(["stale", "smoke-test"], cwd=tmp)
            check("stale: uncommitted change detected", r.returncode == 2, r.stdout)
        else:
            print("[SKIP] stale checks — git not available")

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} checks passed.")
    if failed:
        print("Failed: " + ", ".join(failed))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
