#!/bin/sh
# ctx-guard ready check: refuse a restart while any linked git worktree (one
# made by `git worktree add`, where a builder agent or a parallel task works)
# has uncommitted changes, so a fresh session finds that work in git. The main
# checkout is not checked; clean-worktree.sh covers it.
#
#   sh worktrees-committed.sh                  tracked changes and untracked files count
#   sh worktrees-committed.sh --tracked-only   untracked files are ignored
#
# ctx-guard runs it from the project root.
set -u

untracked=normal
case "${1:-}" in
  --tracked-only) untracked=no ;;
  '') ;;
  *) echo "worktrees-committed: unknown argument: $1" >&2; exit 2 ;;
esac

if ! list=$(git worktree list --porcelain 2>&1); then
  echo "worktrees-committed: git worktree list failed: $list" >&2
  exit 2
fi

# The first entry is the main checkout.
dirty=$(printf '%s\n' "$list" | sed -n 's/^worktree //p' | sed 1d | while IFS= read -r wt; do
  [ -d "$wt" ] || continue
  if ! s=$(git -C "$wt" status --porcelain --untracked-files="$untracked" 2>&1); then
    printf '%s (unreadable: %s)\n' "$wt" "$s"
  elif [ -n "$s" ]; then
    printf '%s (%s uncommitted)\n' "$wt" "$(printf '%s\n' "$s" | wc -l | tr -d ' ')"
  fi
done)

if [ -n "$dirty" ]; then
  echo "worktrees-committed: commit the work in these worktrees first:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi
exit 0
