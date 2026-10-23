---
name: guide
description: Protocol for the ctx-guard context and usage guard, and how to configure it. Use whenever a message starting with "[ctx-guard]" arrives (a context or usage note, a prompt turn saying the user is away, a refused ready token, a blocked tool, a lifted brake, a subagent budget note), when asked to write a ctx-guard handoff or end a reply with the ready token (CTX-READY), and when the user asks to set up, explain or change ctx-guard, a context guard or usage guard, its roles, thresholds, triggers, handoff, auto clear or compact, subagent budgets, trust or the /ctx-guard command.
---

# ctx-guard

ctx-guard watches the session's context fill and usage limits. It sends `[ctx-guard]` notes,
blocks tools near limits, and, at a ready token, runs a guarded `/clear` plus resume (or
`/compact`). This skill tells you how to answer its notes and how to help the operator configure
it. Every key and default is in `references/config-reference.md`.

## When a `[ctx-guard]` note arrives

The note states the figure, what to do now (by level), and how to end. Follow it in this order.

1. **Finish the current step**, as the note's level says:
   - `soft`: finish the item in hand and keep new work small (for usage: fewer subagents, no
     speculative work);
   - `hard`: start no new item, dispatch only what the current item needs, and bring it to a
     safe point;
   - `stop`: dispatch nothing new and start no new work.
2. **Reach a safe point.** No subagents or background tasks running: wait for them or collect
   their results. Current work recorded: commit it, or write it down in the handoff.
3. **Write the handoff**, if the note asks for one. The note names the file (``write the
   handoff to `<path>` ``) and quotes the role's instructions; follow them.
   - The instructions name a skill: use it, and make sure the result ends up at that path.
   - They name none: rewrite the whole file with the Write tool, never append.
   - Make every claim checkable: the resume checks the recorded git `HEAD` (in a git repo) and
     the paths you name against the repository. Record `HEAD` after your last commit.
4. **End the reply.**
   - The note says to end with the token: make the last line of the reply hold only the token,
     exactly as written (default `CTX-READY`). Nothing after it.
   - The note says to tell the operator 'ready for /clear' (or '/compact'): say exactly that, and
     stop. Do not send the token.

Never send the ready token otherwise: not before the handoff is written, not in a sentence, not
from a subagent, and not without a note asking for it. The token clears the session.

`/ctx-guard:clear`, typed by the operator, brings such a note in the command's own text: it counts
as a note asking for the token. Follow it as above. When the command's text carries no
`[ctx-guard]` note, ctx-guard is not active in the session: tell the operator so, and write no
handoff and no token.

A note may end with a role rule (`notes.suffix`), such as "message the peer session before you
stop". Do that before the last line.

## When a prompt says the user is away

ctx-guard can submit a prompt of its own while the operator is away, to use the prompt cache's
last minutes for a handoff. It reads like this:

```text
[ctx-guard] The user has been away 3h40m; the prompt cache expires in 4m. Write the handoff to .ctx-guard/main-handoff.md and stop; do not start new work.
```

No one is watching this turn. Write the handoff to the path it names, following the role's
instructions as for any handoff, then stop. Start no new work, dispatch no subagents and call no
tool but the one that writes the handoff. Do not send the ready token unless the prompt asks
for it. The operator reads the handoff on return. A project may word this prompt itself; follow
its text.

## When the token is refused

```text
[ctx-guard] CTX-READY ignored (<code>): <reason>. Nothing was cleared.
```

With `via: compact` it ends "Nothing was compacted." Nothing was lost; the session goes on. Fix
the cause only if it is yours to fix, then send the token once more. Never loop it.

| Code | What you do |
|---|---|
| `no-handoff`, `handoff-stale` | Rewrite the handoff now, then send the token again. |
| `agents-running`, `background-tasks` | Wait for them to finish (or collect their results), then send the token again. |
| `ready-check-failed` | The reason ends with the output of a project script. Fix what it names (for example, commit the work, or wait for a step to finish) if that belongs to the task; else tell the operator. Never edit or bypass the script. |
| `peer-restarting`, `race-lost` | A peer is restarting. Keep the handoff current and send the token again after the gap the reason names. |
| `already-busy` | A restart is already under way. Do nothing. |
| `not-needed`, `too-soon` | No restart is due: the context is below the role's `restart.minContext`, or this session restarted moments ago. Go on with the work; do not send the token again until a context note asks for it. |
| `untrusted`, `role-shared`, `no-restart-command`, `stamp-unreadable`, `error` | Not yours to fix. Tell the operator the code and reason, then say 'ready for /clear' (or '/compact'). |

The reference has each code's full meaning and fix.

## When a tool is blocked

A deny reads `[ctx-guard] <Tool> is blocked by trigger "<id>": …`. Carry on without that tool.
Do not route around the block with another tool that does the same job. If the work needs the
tool now, tell the operator; only they can lift it.

The deny says when the tool comes free ("Agent comes free in 5h"). If the remaining work needs
the denied tool and the deny says "ctx-guard is set to prompt you when the tool comes free":
record where you stopped (the task list, a commit, or the handoff), say so in one line and end the
turn. Do not poll, sleep or set a timer of your own to wait for it. If the operator speaks first,
or fresh usage shows the window still full, no prompt comes.

## When a brake lifts

A note `[ctx-guard] Trigger "<id>" has lifted: <reason>. <Tools> are allowed again.` means the
tools are usable again. Use them if the work needs them.

A prompt that starts the same way and says you paused your work comes after a wait, often hours.
The session may have been compacted, and other sessions may have committed since. First check
where the work stands (task list, `git status`, the handoff if you wrote one), before you start any
subagent. Then carry on with the work you paused. If nothing is left to do, say so in one line and
stop; do not invent work. A project may word this prompt itself; follow its text.

## When you are a subagent and get a budget note

- **Warn** ("past this subagent's … budget"): wrap up. Start no new searches; finish what you
  hold.
- **Stop** ("context budget … reached; return your final report now", or the project's own
  stop text): return your final report at once, with what you found, what you did not get to,
  and where things are. Further tool calls are refused, except the tool that hands your report
  back (`SubagentHandback`, structured output, `ReportFindings`): use it if you report that way.

## After `/clear`

ctx-guard runs `/ctx-guard:resume role=<role> handoff=<path> …`. Follow that command: read the
handoff, check its claims, then carry out its Next action or report the mismatch.

## Configuring ctx-guard

Change ctx-guard's config only when the operator asks. Never set a role, pause, trust or edit
the config on your own initiative, even to get past a note or a block.

The operator alone can run `/ctx-guard role`, `check`, `trust`, `pause` and `init`: ctx-guard
refuses them unless typed in the prompt box. When one is needed, ask the operator to type it.

**Files** (later wins; objects merge, arrays replace, `null` deletes a key):

| Layer | Where | Holds |
|---|---|---|
| userConfig | `/config` | Machine-wide switches: `enabled`, `configPath`, `defaultRole`, `blocking`, `autoActions`, `noteToasts`, `display`. |
| Team file | `.claude/ctx-guard.json` | Roles, triggers, handoff, restart, subagent budgets. Committed. |
| Local file | `.claude/ctx-guard.local.json` | Personal overrides. Gitignored. |

**Setting up:**

1. The operator types `/ctx-guard init` (or `init peers`). It copies the preset
   `assets/presets/solo.json` (or `peers.json`) to `.claude/ctx-guard.json` if no file is there,
   and adds the local file and the state folder to `.gitignore`.
2. Edit the file to fit, against `assets/ctx-guard.schema.json`. Role names match
   `^[a-z][a-z0-9-]{0,31}$`. The `## Recipes` section of the reference has worked examples:
   solo, coordinator and workers, peers, compact instead of clear, a usage brake.
3. The config reloads by itself after the next turn. `/ctx-guard reload` reloads it now, and
   `/ctx-guard` reports errors, the effective config, the role and the live figures.
4. Assign roles: `defaultRole` in the file, `CTX_GUARD_ROLE=<role> claude`, or
   `/ctx-guard role <name>` typed by the operator. Without a role ctx-guard only toasts.
5. Automatic restart (`restart.mode: "auto"`), ready checks, `compact`, `ping` and `prompt` actions,
   and `prompt` in a trigger's `lift.do` need trust. After any change to them, the operator runs
   `/ctx-guard trust` and reads what it prints.
6. `/ctx-guard check` dry-runs the restart guard.

| Command | Does |
|---|---|
| `/ctx-guard` | Report. |
| `/ctx-guard role <name\|none>` | Set this session's role. |
| `/ctx-guard check` | Dry-run the restart verdict. |
| `/ctx-guard trust` | Approve the repo's restart, ready-check, compact, ping, prompt and band-probe settings. |
| `/ctx-guard trust off` | Withdraw that approval. |
| `/ctx-guard reload` | Re-read the config files. |
| `/ctx-guard pause [30m\|off]` | Lift blocks and automatic actions for a while; notes go on. |
| `/ctx-guard init [solo\|peers]` | Copy a preset to the config path if no file is there. |
| `/ctx-guard:clear [note]` | Ask this session for its handoff and the ready token now. |

Example scripts live in `assets/ready-checks/` (`clean-worktree.sh`, `handoff-committed.sh`,
`worktrees-committed.sh`, `handoff-after-worktrees.sh`, `jobs-quiet.py`) and `assets/probes/`
(`git-branch.sh`, `worktrees.sh`, `superpowers-plan.py`). When asked for one, copy it into
`.claude/ctx-guard/` and wire it in; the reference's "Example scripts" table says what each does.
