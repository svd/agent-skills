#!/bin/sh
# ctx-guard ready check: refuse a /clear until the role's handoff is tracked by
# git and committed, so the next session -- or a peer in another checkout --
# reads it from git. A compact writes no handoff, so it passes.
#
#   sh handoff-committed.sh
#
# ctx-guard passes the handoff path in CTX_GUARD_HANDOFF. Keep handoff.path
# out of ctx-guard's gitignored state folder, e.g. "docs/handoff/{role}.md".
set -u

[ "${CTX_GUARD_VIA:-}" = compact ] && exit 0
h=${CTX_GUARD_HANDOFF:-}
if [ -z "$h" ]; then
  echo "handoff-committed: no handoff path (the session has no role)" >&2
  exit 1
fi
if ! git ls-files --error-unmatch -- "$h" >/dev/null 2>&1; then
  echo "handoff-committed: $h is not tracked by git; commit it, then send the ready token again" >&2
  exit 1
fi
if ! git diff --quiet HEAD -- "$h"; then
  echo "handoff-committed: $h has uncommitted changes; commit it, then send the ready token again" >&2
  exit 1
fi
exit 0
