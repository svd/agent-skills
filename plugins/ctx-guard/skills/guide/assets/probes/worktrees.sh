#!/bin/sh
# ctx-guard band probe: each linked git worktree (`git worktree add`, where a
# builder agent or a parallel task works) as `<folder> <head>`, with `+N` when
# N files there are uncommitted, then `handoff uncommitted` while the role's
# handoff has changes. Line 2 is the colour: warning on either, else inactive.
# No linked worktree and a committed handoff print nothing: no segment.
# Runs from the project root (CTX_GUARD_ROOT).
parts=$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | sed 1d | while IFS= read -r wt; do
  [ -d "$wt" ] || continue
  head=$(git -C "$wt" rev-parse --short HEAD 2>/dev/null) || head='?'
  n=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then printf '%s %s +%s\n' "${wt##*/}" "$head" "$n"; else printf '%s %s\n' "${wt##*/}" "$head"; fi
done)

warn=
case $parts in *' +'[0-9]*) warn=1 ;; esac
text=$(printf '%s' "$parts" | tr '\n' ',' | sed 's/,/, /g')
h=${CTX_GUARD_HANDOFF:-}
if [ -n "$h" ] && [ -e "$h" ] && ! git diff --quiet HEAD -- "$h" 2>/dev/null; then
  text="${text:+$text, }handoff uncommitted"
  warn=1
fi

[ -n "$text" ] || exit 0
echo "$text"
if [ -n "$warn" ]; then echo warning; else echo inactive; fi
