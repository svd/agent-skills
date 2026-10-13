#!/bin/sh
# ctx-guard ready check: refuse a restart while the work tree has uncommitted
# changes, so nothing unsaved is lost to /clear. Exit 0 lets the restart go on.
#
#   sh clean-worktree.sh                  tracked changes and untracked files count
#   sh clean-worktree.sh --tracked-only   untracked files are ignored
#
# ctx-guard runs it from the project root. Gitignore ctx-guard's state folder
# (/ctx-guard init does this) and, with handoff.style "session-handoff",
# .claude/session-handoffs/ -- or pass --tracked-only -- else the handoff and
# ctx-guard's own files count as changes.
set -u

untracked=normal
case "${1:-}" in
  --tracked-only) untracked=no ;;
  '') ;;
  *) echo "clean-worktree: unknown argument: $1" >&2; exit 2 ;;
esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "clean-worktree: not inside a git work tree" >&2
  exit 2
fi

if ! changes=$(git status --porcelain --untracked-files="$untracked"); then
  echo "clean-worktree: git status failed" >&2
  exit 2
fi

if [ -n "$changes" ]; then
  echo "clean-worktree: uncommitted changes:" >&2
  printf '%s\n' "$changes" >&2
  exit 1
fi
exit 0
