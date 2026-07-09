# Session Handoff — <PROJECT NAME>

Created: <YYYY-MM-DD HH:MM> · Project slug: `<project-slug>` · Git HEAD: `<sha or no-git>` · Parent: `<path or none>`

Trust tags:
- `[V]` verified during this handoff run — re-read the file/re-ran the command just now.
- `[?]` unverified memory; carried over from conversation context, re-check before relying.
- `[S]` stale-risk; state that's likely to have drifted (repo, external service, upstream doc).

## Summary
<1-3 sentences: what this project is, what was accomplished THIS session only.>

## Current Goal
<What the next session should be working toward. One or two sentences.>

## Verified State
<Facts confirmed during this handoff run — file contents re-read, commands re-run, tests re-executed. Tag each with [V]. This is not "what I remember", it's "what I just checked".>
- <Fact> [V]

## Key Decisions
- <Decision 1> — <why> [V/?]
- <Decision 2> — <why> [V/?]

## Traps to Avoid / Failed Approaches
- <Approach tried and rejected, and why it failed> [V/?]
- <Thing the next session will be tempted to redo> [V/?]

## Relevant Files / Sources
- `path/to/file:L10-L45` — <what's there and why it matters>
- `<URL or document name>` — <what's there and why it matters>

## Open Work
<Described as STATUS, not instructions. Note dependencies explicitly.>
- <Item> is not yet <done/drafted/reviewed>. [V/?/S]
- <Item> depends on <other item> being finished first.

## Working Agreements (optional)
- <How the user prefers to interact, format conventions, tone, etc.>

## Parent / Chain Context
<If this handoff continues from an earlier one, name it and summarize in one line what changed since. Otherwise: "None — first handoff for this project.">

## Resume Prompt

Before responding: read this handoff in full, then read every file/source listed under "Relevant
Files / Sources" — do not assume this document alone is enough context. If this is a repo, check
`git status`, `git log`, and `git diff` to confirm the working state still matches what's
described here. Treat every `[?]` and `[S]` item as a lead to verify, not a fact to trust
blindly — do not rely on unverified or stale-risk claims without checking them against the
current state first. Once you've done this, restate your understanding briefly (a few lines),
then wait for instructions before taking any action.
