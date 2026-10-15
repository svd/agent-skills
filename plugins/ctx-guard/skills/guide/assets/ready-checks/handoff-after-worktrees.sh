#!/bin/sh
# ctx-guard ready check: refuse a /clear while the handoff was committed before
# the newest commit in any linked git worktree, so what it says about that work
# (a branch head, which items are done) is not out of date. Commit times, not
# file times: pair it with handoff-committed.sh. A compact passes.
#
#   sh handoff-after-worktrees.sh
#
# ctx-guard passes the handoff path in CTX_GUARD_HANDOFF.
set -u

[ "${CTX_GUARD_VIA:-}" = compact ] && exit 0
h=${CTX_GUARD_HANDOFF:-}
if [ -z "$h" ]; then
  echo "handoff-after-worktrees: no handoff path (the session has no role)" >&2
  exit 1
fi
ht=$(git log -1 --format=%ct -- "$h" 2>/dev/null)
if [ -z "$ht" ]; then
  echo "handoff-after-worktrees: $h has no commit" >&2
  exit 1
fi

# The first entry is the main checkout.
newer=$(git worktree list --porcelain | sed -n 's/^worktree //p' | sed 1d | while IFS= read -r wt; do
  [ -d "$wt" ] || continue
  t=$(git -C "$wt" log -1 --format=%ct 2>/dev/null) || continue
  if [ -n "$t" ] && [ "$t" -gt "$ht" ]; then
    printf '%s at %s\n' "$wt" "$(git -C "$wt" rev-parse --short HEAD)"
  fi
done)

if [ -n "$newer" ]; then
  echo "handoff-after-worktrees: $h was committed before the newest commit in:" >&2
  printf '%s\n' "$newer" >&2
  echo "update the handoff, commit it, then send the ready token again" >&2
  exit 1
fi
exit 0
