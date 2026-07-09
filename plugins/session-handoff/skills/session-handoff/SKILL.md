---
name: session-handoff
description: Create and resume structured context handoffs between Claude Code (or any Claude) sessions on any project. Use whenever the user says "handoff", "hand off this session", "continue this in a new chat", "context is getting long", "start a new session for this", "park this project", "resume where we left off", or is about to close a long session and wants to pick it back up later without re-explaining everything. Also use proactively when a session is clearly approaching its context limit or has just finished a substantial chunk of work and is a natural pause point.
---

# Session Handoff

Writes and resumes structured handoff documents so work can pause in one session and resume in a
fresh one — new chat, new machine, next day, different agent — without losing state, decisions
already made, or mistakes already discovered.

## When to write a handoff

- Context is degrading or approaching the token/message limit.
- A natural checkpoint just happened (a milestone finished, a phase wrapped up).
- The user is about to switch sessions, machines, or pause for the day.
- The user explicitly asks to "hand off", "park", or "continue later".
- Before a long session ends, even if not asked — better to have it and not need it.

## Where handoffs live

```
.claude/session-handoffs/<project-slug>/<YYYYMMDD-HHMM>-<4-char-id>.md
```

`project-slug` is a short lowercase-hyphenated name for whatever's being worked on (e.g.
`garden-redesign`, `q3-analysis`, `novel-draft`). One subdirectory per project keeps unrelated
handoffs from mixing when several things are in flight at once.

If there's no filesystem access (e.g. plain claude.ai chat with no Claude Code project), skip the
file-writing mechanics below and instead just produce the handoff content directly in the
conversation, formatted per the template, so the user can copy it into their next chat.

Use `scripts/handoff_tool.py` for the mechanical bits whenever a filesystem is available (never
hand-roll filenames or timestamps):

```bash
python3 scripts/handoff_tool.py new <project-slug>       # prints NEW_PATH= and PARENT_PATH= (previous handoff, if any)
python3 scripts/handoff_tool.py latest <project-slug>    # prints the most recent handoff, if any
python3 scripts/handoff_tool.py list <project-slug>       # lists all handoffs, newest first
python3 scripts/handoff_tool.py validate <path>           # checks required sections, flags secrets/dead links, warns on low-confidence content
python3 scripts/handoff_tool.py stale <project-slug>      # warns if the repo/working tree changed since the handoff
python3 scripts/handoff_tool.py inspect <path>            # quick summary: header, tag counts, sections, referenced-file status
```

## Trust tags — the most important discipline here

Every claim in a handoff must be tagged:

- `[V]` — **verified during this handoff run.** You re-read the file, re-ran the command, or
  re-checked the state *right now*, in this session, before writing it down. Do not write `[V]`
  from memory — if you haven't just re-read the file/re-run the command, it isn't `[V]`.
- `[?]` — remembered from conversation or prior context but not freshly verified. This is the
  default for anything you're recalling rather than just having checked.
- `[S]` — stale-risk: state that's likely to have drifted (repo HEAD, an external service, an
  upstream doc) even if it was accurate earlier in the session.

If a handoff ends up mostly `[?]` tags, say so explicitly (e.g. a "Low-confidence handoff" note
in the Summary) — `validate` will otherwise just warn quietly and it's easy to miss.

A handoff is for continuity between sessions, not a durable architecture doc — it's fine for it to
go stale and get superseded by the next one.

## Writing a handoff

1. If a filesystem is available, run `handoff_tool.py new <project-slug>` to get `NEW_PATH` (the
   target path) and `PARENT_PATH` (the previous handoff for this project, if any — reference it in
   `## Parent / Chain Context`).
2. Fill in `assets/handoff-template.md` (copy it, don't just reference it). Tag every claim `[V]`,
   `[?]`, or `[S]` as you write it — see above.
3. Run `handoff_tool.py validate <path>` on the result and fix anything it flags — in particular,
   never let an API key, password, or other credential leak into a handoff file that might get
   committed to git or otherwise persist. `Open Work` should read as status ("the intro isn't
   drafted yet"), not imperative commands ("draft the intro next") — status survives being read
   out of context better than an instruction does.
4. After writing, output **only** a short pointer to the user — don't paste the full handoff
   content into chat as well (that defeats the point of keeping the session lean):

   ```
   Handoff written: <path>
   To resume: start a new session and say "resume handoff <path>"
   ```

   If there's no filesystem and the handoff was produced inline instead, just say so plainly and
   let the content stand as the deliverable.

### Section guide

- **Summary** — 1-3 sentences: what this project is, what was accomplished *this session only*
  (not the whole project history).
- **Current Goal** — what the next session should be working toward, one or two sentences.
- **Verified State** — facts you actually re-checked during this handoff run (re-read a file,
  re-ran a command, re-ran a test), each tagged `[V]`. Don't put remembered-but-unchecked facts
  here — that's what `[?]` is for elsewhere in the doc.
- **Key Decisions** — decisions made and why. The "why" matters more than the "what" — it's what
  stops a fresh session from re-litigating settled questions.
- **Traps to Avoid / Failed Approaches** — approaches already tried and rejected, and why they
  failed. This is usually the single highest-value section: it prevents the next session from
  repeating a mistake.
- **Relevant Files / Sources** — path (with line range if code), URL, or document name, plus a
  one-line note on what's there and why it matters. Don't paste full contents — point to them.
  `validate`/`stale`/`inspect` all parse this section to check the referenced local files exist
  and aren't stale, so keep entries to one path/URL per bullet, backtick-quoted. Paths are checked
  relative to cwd as POSIX-style (forward slashes) — on Windows, use forward slashes or the path
  will be treated as not found.
- **Open Work** — described as *status*, not instructions. Write "the intro section isn't drafted
  yet" rather than "draft the intro next" — status survives being read out of context better than
  a command does, and doesn't presuppose the next session's priorities. Note blocking dependencies
  explicitly ("B depends on A being finished first").
- **Working Agreements** (optional) — how the user prefers to interact, format conventions, tone,
  anything a fresh session would otherwise have to rediscover the hard way.
- **Parent / Chain Context** — if this handoff continues from an earlier one (see `PARENT_PATH`
  from `new`), name it and summarize in one line what changed since. Otherwise state plainly that
  this is the first handoff for the project.
- **Resume Prompt** — see below.

### Resume Prompt (goes at the end of every handoff)

Frame it as information for the next session, not commands, and force verification instead of
blind trust in the summary. It must cover: read the handoff and every listed file/source, check
`git status`/`log`/`diff` if it's a repo, treat `[?]`/`[S]` items as leads not facts, restate
understanding briefly, then wait for instruction. Use `assets/handoff-template.md`'s version
verbatim unless the project needs something extra — `validate` checks for this content and will
flag a Resume Prompt that's missing any of these concepts.

## Resuming from a handoff

1. If the user names a path, use it. If they only name a project, run
   `handoff_tool.py latest <project-slug>` to find the most recent one.
2. Run `handoff_tool.py stale <project-slug>` first, if a filesystem/git repo is available — it
   checks for newer commits, uncommitted working-tree changes, and referenced files modified since
   the handoff. If it warns, tell the user before proceeding — the handoff may describe a state
   that no longer matches reality. `handoff_tool.py inspect <path>` is a fast way to sanity-check a
   handoff's quality (tag counts, sections, referenced-file status) before committing to reading
   it in full.
3. Read the handoff, then read every file/source it lists — don't skip this even if the summary
   seems to cover it. Treat `[?]` and `[S]` items as leads to verify, not facts — re-check them
   against current state before relying on them.
4. Restate briefly (a few lines) what you now understand: what the project is, what's been
   decided, what's open. Then stop and wait for the user's next instruction rather than immediately
   acting on assumed priorities.

## Notes

- Keep handoffs free of credentials, full private documents, or anything sensitive — reference
  paths/URLs instead. `handoff_tool.py validate` flags common secret patterns but isn't a
  substitute for judgment.
- One handoff per pause is enough — don't create a new one if the previous one is still fresh and
  nothing has changed (`stale` will confirm either way).
- Over a multi-week project, the `<project-slug>/` directory becomes a lightweight timeline worth
  skimming with `list` when returning after a longer break, and each handoff's `Parent / Chain
  Context` traces the thread back through it.

## Installation

- **Claude Code, global** — copy or clone this folder to `~/.claude/skills/session-handoff` to use
  it across every project.
- **Claude Code, project-local** — copy this folder to `.claude/skills/session-handoff` inside a
  specific repo if you only want it there.
- **Plain Claude / chat with no filesystem tools** — there's nothing to install. Skip
  `handoff_tool.py` entirely and produce the handoff inline in the conversation, formatted per
  `assets/handoff-template.md`, for the user to copy into their next chat.

## Development / self-check

`scripts/smoke_test.py` is a stdlib-only self-check for `handoff_tool.py` — not part of normal
per-handoff usage. Run it after editing the script:

```bash
python3 scripts/smoke_test.py
```

It exercises `new`/`validate`/`inspect`/`list`/`latest`/`stale` (including parent-chaining, a
missing-section failure, a fake-secret failure, and both stale/clean git states) in a temp
directory and reports pass/fail per check.
