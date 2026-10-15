"""ctx-guard band probe: how far the superpowers plan being executed has got,
e.g. `plan 6/7 releasing-a-version-v2`.

    python3 -I superpowers-plan.py

Reads the newest ledger the superpowers plugin's subagent-driven-development
and executing-plans skills keep at .superpowers/sdd/<plan>/progress.md. Its
first line `# SDD ledger — plan: <plan file>` names the plan; each
`Task <N>: complete` line is a finished task; the plan's `### Task <N>`
headings are the total (`N done` when the plan file is gone).

Prints nothing -- no segment -- when there is no ledger, the newest one is in
another format, no task is complete yet, or every task is. The ledger is the
superpowers plugin's own format (checked against 6.4.1), so a change there
draws nothing rather than a wrong count.
"""
import glob
import os
import re
import sys

FIRST = re.compile(r"^# SDD ledger — plan: (.+?)\s*$")
DONE = re.compile(r"^Task (\d+): complete\b")
TASK = re.compile(r"^### Task (\d+)\b")
DATED = re.compile(r"^\d{4}-\d{2}-\d{2}-")


def numbers(path, pattern):
    with open(path, encoding="utf-8", errors="replace") as f:
        return {m.group(1) for m in map(pattern.match, f) if m}


def main():
    root = os.environ.get("CTX_GUARD_ROOT") or os.getcwd()
    ledgers = glob.glob(os.path.join(root, ".superpowers", "sdd", "*", "progress.md"))
    if not ledgers:
        return 0
    ledger = max(ledgers, key=os.path.getmtime)
    with open(ledger, encoding="utf-8", errors="replace") as f:
        first = FIRST.match(f.readline())
    if not first:
        return 0
    done = len(numbers(ledger, DONE))
    if not done:
        return 0
    plan = os.path.join(root, first.group(1))
    total = len(numbers(plan, TASK)) if os.path.isfile(plan) else 0
    if total and done >= total:
        return 0
    name = DATED.sub("", os.path.basename(os.path.dirname(ledger)))
    # Count first: the band cuts a segment at 40 characters.
    print(f"plan {done}/{total} {name}" if total else f"plan {done} done {name}")
    print("inactive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
