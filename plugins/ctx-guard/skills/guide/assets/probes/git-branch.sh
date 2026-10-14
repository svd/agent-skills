#!/bin/sh
# ctx-guard band probe: the current git branch, in warning colour when the
# worktree has changes. Line 1 is the segment, line 2 its colour; printing
# nothing draws no segment. Runs from the project root (CTX_GUARD_ROOT).
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
echo "$branch"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then echo warning; fi
