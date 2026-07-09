#!/usr/bin/env python3
"""
session-handoff helper script.

Pure stdlib, no dependencies. Run from the project root (the directory that
contains, or should contain, .claude/session-handoffs/).

Usage:
  python3 handoff_tool.py new <project-slug>
  python3 handoff_tool.py latest <project-slug>
  python3 handoff_tool.py list <project-slug>
  python3 handoff_tool.py validate <path-to-handoff.md>
  python3 handoff_tool.py stale <project-slug>
  python3 handoff_tool.py inspect <path-to-handoff.md>
"""

import random
import re
import string
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.cwd() / ".claude" / "session-handoffs"

REQUIRED_SECTIONS = [
    "## Summary",
    "## Current Goal",
    "## Verified State",
    "## Key Decisions",
    "## Traps to Avoid / Failed Approaches",
    "## Relevant Files / Sources",
    "## Open Work",
    "## Parent / Chain Context",
    "## Resume Prompt",
]

# Deliberately broad — false positives are fine, missed secrets are not.
SECRET_PATTERNS = [
    (r"sk-[A-Za-z0-9]{20,}", "OpenAI/Anthropic-style API key"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key block"),
    (r"ghp_[A-Za-z0-9]{30,}", "GitHub personal access token"),
    (r"xox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"(?i)password\s*[:=]\s*\S{6,}", "inline password"),
    (r"(?i)bearer\s+[A-Za-z0-9._-]{20,}", "bearer token"),
]

MANY_UNVERIFIED_THRESHOLD = 5

RESUME_PROMPT_KEYWORD_GROUPS = [
    ["read", "check"],
    ["verify", "current state", "confirm"],
    ["not trust", "don't trust", "untrusted", "blindly"],
]

HEADING_RE = re.compile(r"^## .+$", re.MULTILINE)
RELEVANT_FILES_ITEM_RE = re.compile(r"^-\s+`([^`]+)`", re.MULTILINE)
TRAILING_LINE_REF_RE = re.compile(r":(L?\d+(?:-L?\d+)?)$")
CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)

NON_SLASH_URI_SCHEMES = ("mailto:", "tel:", "urn:", "data:")


def slug_dir(project_slug: str) -> Path:
    return ROOT / project_slug


def _all_handoffs(project_slug: str):
    d = slug_dir(project_slug)
    if not d.exists():
        return []
    # Sort by actual mtime, not filename — the timestamp in the filename only
    # has minute resolution and the random suffix carries no time signal, so
    # name-based sort could pick the wrong "latest" for same-minute handoffs.
    # `p.name` is only a tie-breaker for a genuine mtime tie (same second,
    # coarse filesystem resolution, etc.) — on a true tie this still falls
    # back to an arbitrary-but-deterministic pick, same as before this fix.
    return sorted(d.glob("*.md"), key=lambda p: (p.stat().st_mtime, p.name), reverse=True)


def _strip_code_fences(text: str) -> str:
    """Blank out fenced code blocks before structural parsing (headings, tag
    counts, Resume Prompt keywords, relevant-files bullets) so a handoff can't
    satisfy those checks by pasting example/reference content in a ``` block
    instead of writing the real section. Secret scanning deliberately does NOT
    use this — a secret pasted inside a fence is still a real leak."""
    return CODE_FENCE_RE.sub("", text)


def _headings(text: str):
    return set(HEADING_RE.findall(text))


def _body(text: str) -> str:
    """Text from the first '## Summary' heading onward — excludes the trust-tag
    legend at the top of the template, whose example [V]/[?]/[S] tags would
    otherwise always be "found" regardless of what the handoff actually contains."""
    idx = text.find("## Summary")
    return text[idx:] if idx != -1 else text


def _looks_like_url(token: str) -> bool:
    return "://" in token or token.startswith(NON_SLASH_URI_SCHEMES)


def _parse_relevant_files(text: str):
    """Return list of (raw_token, resolved_path_or_None, is_url) for bullet
    items under '## Relevant Files / Sources'. resolved_path is None for URLs.
    Callers should pass fence-stripped text (see _strip_code_fences)."""
    section_start = text.find("## Relevant Files / Sources")
    if section_start == -1:
        return []
    rest = text[section_start:]
    next_heading = HEADING_RE.search(rest, pos=len("## Relevant Files / Sources"))
    section_text = rest[: next_heading.start()] if next_heading else rest

    results = []
    for token in RELEVANT_FILES_ITEM_RE.findall(section_text):
        if _looks_like_url(token):
            results.append((token, None, True))
            continue
        path_part = TRAILING_LINE_REF_RE.sub("", token)
        results.append((token, path_part, False))
    return results


def _check_local_files(text: str, cwd: Path):
    """Returns list of (raw_token, path_part, exists_bool) for non-URL entries,
    deduped by raw_token (exact bullet text) so a literally-repeated bullet
    doesn't produce duplicate found/missing lines. Deliberately NOT deduped by
    resolved path_part alone — two bullets for the same file with different
    line-range suffixes (e.g. `foo.py:L10-L20` vs `foo.py:L100-L200`) are
    distinct references and both should still show up in validate/inspect
    output, even though they resolve to the same on-disk existence check."""
    checked = []
    seen_tokens = set()
    for raw_token, path_part, is_url in _parse_relevant_files(text):
        if is_url:
            continue
        if raw_token in seen_tokens:
            continue
        seen_tokens.add(raw_token)
        exists = (cwd / path_part).exists()
        checked.append((raw_token, path_part, exists))
    return checked


def cmd_new(project_slug: str) -> None:
    parent = _all_handoffs(project_slug)
    parent_path = parent[0] if parent else None

    d = slug_dir(project_slug)
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M")
    rand_id = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    path = d / f"{ts}-{rand_id}.md"

    print(f"NEW_PATH={path}")
    print(f"PARENT_PATH={parent_path if parent_path else 'none'}")


def cmd_latest(project_slug: str) -> None:
    files = _all_handoffs(project_slug)
    if not files:
        print(f"No handoffs found for '{project_slug}' under {slug_dir(project_slug)}")
        sys.exit(1)
    print(files[0])


def cmd_list(project_slug: str) -> None:
    files = _all_handoffs(project_slug)
    if not files:
        print(f"No handoffs found for '{project_slug}' under {slug_dir(project_slug)}")
        return
    for f in files:
        print(f)


def _resume_prompt_issues(text: str):
    section_start = text.find("## Resume Prompt")
    if section_start == -1:
        return ["Missing '## Resume Prompt' section."]
    section_text = text[section_start:].lower()

    issues = []
    for group in RESUME_PROMPT_KEYWORD_GROUPS:
        if not any(kw in section_text for kw in group):
            issues.append(
                f"Resume Prompt doesn't clearly cover: {' / '.join(group)}."
            )
    return issues


def cmd_validate(path_str: str) -> None:
    path = Path(path_str)
    if not path.exists():
        print(f"❌ File not found: {path}")
        sys.exit(1)
    text = path.read_text(encoding="utf-8", errors="replace")
    # Structural checks (sections, tags, Resume Prompt, relevant-files bullets)
    # run on fence-stripped text so a handoff can't satisfy them by pasting
    # example content in a code block. Secret scanning stays on raw `text`.
    struct_text = _strip_code_fences(text)

    errors = []
    warnings = []

    found_headings = _headings(struct_text)
    missing = [s for s in REQUIRED_SECTIONS if s not in found_headings]
    if missing:
        errors.append("Missing required sections: " + ", ".join(missing))

    for pattern, label in SECRET_PATTERNS:
        if re.search(pattern, text):
            errors.append(f"Possible {label} found in file — remove before saving/committing.")

    errors.extend(_resume_prompt_issues(struct_text))

    body = _body(struct_text)
    v_count = body.count("[V]")
    q_count = body.count("[?]")
    s_count = body.count("[S]")

    if v_count == 0:
        warnings.append("No [V] (verified) tags found — nothing in this handoff was confirmed during writing.")

    if q_count > MANY_UNVERIFIED_THRESHOLD and "low-confidence" not in struct_text.lower():
        warnings.append(
            f"{q_count} [?] (unverified) tags found with no 'low-confidence' note — "
            "consider marking this handoff as low-confidence."
        )

    for raw_token, path_part, exists in _check_local_files(struct_text, Path.cwd()):
        if not exists:
            warnings.append(f"Referenced local file not found: {raw_token}")

    print(f"--- {path.name} ---")
    print(f"Tags: [V]={v_count} [?]={q_count} [S]={s_count}")
    if errors:
        print("❌ Errors:")
        for e in errors:
            print(f"  - {e}")
    if warnings:
        print("⚠️  Warnings:")
        for w in warnings:
            print(f"  - {w}")

    if errors:
        print(f"❌ Validation failed: {len(errors)} error(s), {len(warnings)} warning(s).")
        sys.exit(1)
    if warnings:
        print(f"✅ Validation passed with {len(warnings)} warning(s).")
        return
    print(f"✅ {path.name} looks good ({len(text.splitlines())} lines).")


def _git_last_commit_ts(cwd: Path):
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%ct"],
            capture_output=True, text=True, cwd=cwd, check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            return datetime.fromtimestamp(int(out.stdout.strip()), tz=timezone.utc)
    except FileNotFoundError:
        pass
    return None


def _git_status_short(cwd: Path):
    try:
        out = subprocess.run(
            ["git", "status", "--short"],
            capture_output=True, text=True, cwd=cwd, check=False,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except FileNotFoundError:
        pass
    return ""


def cmd_stale(project_slug: str) -> None:
    files = _all_handoffs(project_slug)
    if not files:
        print(f"No handoffs found for '{project_slug}' under {slug_dir(project_slug)}")
        sys.exit(1)
    latest = files[0]
    handoff_ts = datetime.fromtimestamp(latest.stat().st_mtime, tz=timezone.utc)
    text = latest.read_text(encoding="utf-8", errors="replace")
    struct_text = _strip_code_fences(text)

    warnings = []

    commit_ts = _git_last_commit_ts(Path.cwd())
    if commit_ts and commit_ts > handoff_ts:
        warnings.append(
            f"Repo has commits newer than the handoff (last commit {commit_ts.isoformat()}, "
            f"handoff {handoff_ts.isoformat()})."
        )

    status = _git_status_short(Path.cwd())
    if status:
        n = len(status.splitlines())
        warnings.append(f"Working tree has {n} uncommitted change(s) (git status --short).")

    for raw_token, path_part, exists in _check_local_files(struct_text, Path.cwd()):
        if not exists:
            continue
        mtime = datetime.fromtimestamp((Path.cwd() / path_part).stat().st_mtime, tz=timezone.utc)
        if mtime > handoff_ts:
            warnings.append(f"Referenced file modified since handoff: {raw_token}")

    if warnings:
        print(f"⚠️  Handoff may be stale: {latest}")
        for w in warnings:
            print(f"  - {w}")
        sys.exit(2)
    print(f"✅ {latest} appears current — no staleness indicators detected.")


def cmd_inspect(path_str: str) -> None:
    path = Path(path_str)
    if not path.exists():
        print(f"❌ File not found: {path}")
        sys.exit(1)
    text = path.read_text(encoding="utf-8", errors="replace")
    struct_text = _strip_code_fences(text)

    print(f"Path: {path}")

    created_line = next((line for line in text.splitlines() if line.startswith("Created:")), None)
    if created_line:
        parts = [p.strip() for p in created_line.split("·")]
        for p in parts:
            print(p)
    else:
        print("Created: (not found)")

    body = _body(struct_text)
    print(f"Tags: [V]={body.count('[V]')} [?]={body.count('[?]')} [S]={body.count('[S]')}")

    found_headings = _headings(struct_text)
    print("Sections found: " + ", ".join(sorted(found_headings)) if found_headings else "Sections found: none")
    missing = [s for s in REQUIRED_SECTIONS if s not in found_headings]
    if missing:
        print("Sections missing: " + ", ".join(missing))

    checked = _check_local_files(struct_text, Path.cwd())
    if checked:
        print("Relevant local files:")
        for raw_token, path_part, exists in checked:
            mark = "✅" if exists else "❌"
            print(f"  {mark} {raw_token}")
    else:
        print("Relevant local files: none referenced")


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    action, arg = sys.argv[1], sys.argv[2]
    actions = {
        "new": cmd_new,
        "latest": cmd_latest,
        "list": cmd_list,
        "validate": cmd_validate,
        "stale": cmd_stale,
        "inspect": cmd_inspect,
    }
    fn = actions.get(action)
    if not fn:
        print(f"Unknown action '{action}'. Expected one of: {', '.join(actions)}")
        sys.exit(1)
    fn(arg)


if __name__ == "__main__":
    main()
