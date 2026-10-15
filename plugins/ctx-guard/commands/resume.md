---
description: Resume a role's work from its ctx-guard handoff after a /clear
argument-hint: role=<role> [handoff=<path>] [prompt]
---

Resume from a handoff. The arguments are: `$ARGUMENTS`

They read `role=<role> handoff=<path>`, then an optional prompt. `role` is the role this session
works as. `handoff` is the handoff file, relative to the project root. The prompt, if any, is
the operator's instruction for this resume. When the operator typed only `role=`, ctx-guard has
already filled in the role's configured handoff path and restart prompt.

1. Read the handoff file whole. If it is missing or empty, stop and say so.
2. Check its claims against the repository before you act on any of them:
   - If it records a git commit (for example a `HEAD` line), check that the commit is the
     current `HEAD` or an ancestor of it (`git merge-base --is-ancestor <commit> HEAD`).
   - Check that every file and directory it names exists.
   - Check that any branch, run or task it names as in progress still exists.
3. If every check holds, carry out its Next action now, without waiting for confirmation,
   following the prompt above if one was given.
4. If any check fails, do nothing else: report each mismatch (what the handoff says and what
   the repository shows) and wait for the operator.
