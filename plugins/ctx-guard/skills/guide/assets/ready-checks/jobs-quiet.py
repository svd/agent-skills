"""ctx-guard ready check: refuse a restart while a job started outside the
session is still running, or while the handoff is older than the newest job.

    python3 -I jobs-quiet.py [FOLDER_GLOB ...]     default: .jobs

ctx-guard already waits for the session's own subagents and background tasks;
this is for work a launcher runs as separate processes. The contract: a job
writes <name>.pid into a job folder when it starts and <name>.rc when it
exits, so a .pid with no .rc is a running job. FOLDER_GLOB is relative to the
project root, e.g. ".runs/*/jobs". Self-contained on purpose: trust hashes
only the files named in `run`.
"""
import datetime
import glob
import os
import sys


def scan(root, patterns):
    """Each job as (folder, name, started epoch ms, running)."""
    jobs = []
    for pattern in patterns:
        for folder in sorted(glob.glob(os.path.join(root, pattern))):
            if not os.path.isdir(folder):
                continue
            names = set(os.listdir(folder))
            for entry in sorted(names):
                if not entry.endswith(".pid"):
                    continue
                name = entry[: -len(".pid")]
                started = os.path.getmtime(os.path.join(folder, entry)) * 1000
                jobs.append((os.path.relpath(folder, root), name, started, name + ".rc" not in names))
    return jobs


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat(timespec="seconds")


def main(argv):
    root = os.environ.get("CTX_GUARD_ROOT") or os.getcwd()
    try:
        jobs = scan(root, argv or [".jobs"])
    except OSError as e:
        print(f"jobs-quiet: job folders could not be read: {e}", file=sys.stderr)
        return 1
    running = [f"{folder}/{name}" for folder, name, _, live in jobs if live]
    if running:
        print(f"jobs-quiet: jobs still running: {', '.join(running)}", file=sys.stderr)
        return 1
    mtime = os.environ.get("CTX_GUARD_HANDOFF_MTIME_MS", "")
    # Empty for a compact (no handoff) or an absent handoff, which ctx-guard refuses itself.
    if mtime and jobs:
        last = max(started for _, _, started, _ in jobs)
        if int(mtime) <= last:
            print(
                f"jobs-quiet: {os.environ.get('CTX_GUARD_HANDOFF') or 'the handoff'} was written {iso(int(mtime))}, "
                f"not after the newest job started at {iso(last)}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
