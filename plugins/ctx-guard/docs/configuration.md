# Configuration

[← ctx-guard README](../README.md) · [All docs](README.md)

## Where settings live

Layers apply in this order; a later layer wins.

| # | Layer | Where | Holds |
|---|---|---|---|
| 1 | Built-ins | the plugin | One role `main` with the built-in ladder. |
| 2 | Switches | `/config` → ctx-guard | Machine-wide switches only (below). |
| 3 | Team file | `.claude/ctx-guard.json` | Roles, triggers, handoff, restart, budgets. Committed. |
| 4 | Local file | `.claude/ctx-guard.local.json` | Your personal overrides. Gitignored. |

Merge rules: objects merge key by key, **arrays replace** (a role's `triggers` list replaces the
built-in ladder as a whole), and `null` deletes a key so the built-in default applies. Each file
is validated on its own and must be valid alone. Unknown keys are errors.

ctx-guard re-reads the files at session start, on `/ctx-guard reload`, and after each turn when
a file's modification time changed. An invalid file shows a toast and keeps the last good
config; `/ctx-guard` lists the errors.

For editor completion, point `$schema` at the schema (ctx-guard ignores the key):

```json
{
  "$schema": "https://raw.githubusercontent.com/svd/agent-skills/main/plugins/ctx-guard/skills/guide/assets/ctx-guard.schema.json",
  "version": 1
}
```

## Switches (`/config`)

| Switch | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns ctx-guard off in every project. |
| `configPath` | `.claude/ctx-guard.json` | The team file, relative to the project root; the local file sits beside it as `*.local.json`. |
| `defaultRole` | `""` | Role when nothing else sets one. Empty for none. |
| `blocking` | `true` | `false` lifts every deny; notes and toasts go on. |
| `autoActions` | `true` | `false` stops automatic clear, compact, ping and prompt; notes then ask the model to tell you. |
| `noteToasts` | `true` | `false` stops the toast that shows each note sent to the model. |
| `display` | `band` | `band`, `status` (status-line text only) or `off`. |

## Anatomy of a config file

```jsonc
{
  "version": 1,                         // required, always 1
  "defaultRole": "main",                // role for sessions nothing else assigns
  "contextWindow": "auto",              // or tokens, e.g. "400k": what context % counts against
  "stateDir": ".ctx-guard",             // stamps, leases, default handoffs
  "readyToken": "CTX-READY",

  "defaults": {                         // every role inherits these (objects deep-merge)
    "handoff": { "instructions": "…" },
    "restart": { "mode": "auto" }
  },

  "roles": {
    "main": {
      "description": "what the role is for",
      "triggers": [                     // replaces the built-in ladder
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" }
      ],
      "notes":   { "suffix": "A line appended to every note." },
      "handoff": { "path": ".ctx-guard/{role}-handoff.md", "instructions": "…" },
      "restart": {
        "mode": "auto",                 // auto | manual | off
        "via": "clear",                 // clear | compact
        "command": "ctx-guard:resume",  // run after /clear
        "prompt": "Carry out Next action without waiting.",
        "selfGap": "1m",                // min gap between this session's own restarts
        "minContext": "off",            // refuse the ready token below this fill ("40%", "300k")
        "peers": [], "peerGap": "10m",  // roles that must not restart within peerGap
        "readyChecks": []               // commands that must exit 0 before a restart
      },
      "compact": { "instructions": "What /compact must keep." }
    }
  },

  "subagents": {                        // per-type context budgets
    "*": { "warn": "120k", "stop": "170k" }
  },

  "band": { "probes": [] },             // project scripts drawn on the band, shared by every role

  "cache": {                            // prompt cache: TTL, band countdown, keep-warm limits
    "ttl": "auto",                      // or "5m" / "1h"
    "band": { "show": "25%", "warn": "10m" },
    "ping": { "maxUsage": 90 },         // no ping while a usage window is at or above this %
    "prompt": { "maxUsage": 90 }        // the same for a prompt from a trigger on a cache metric
  }
}
```

(Comments are for this README only; the file is plain JSON.)

## Quantities

The field decides how a value reads: `"10m"` is ten minutes in a duration field and ten million
tokens in a token field.

| Kind | Forms |
|---|---|
| tokens | `150000`, `"300k"`, `"1.2M"` |
| percent | `"40%"`, or `80` where the field is a percent only (`limit.*`) |
| duration | `"500ms"`, `"10s"`, `"10m"`, `"2h"`, `"1d"` (unit required) |
| usd | `2.5`, `"$2.50"` |
| count | `3` |

## Triggers

```jsonc
// one entry of a role's "triggers" list
{ "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note", "toast"], "level": "stop" }
```

**`when`** is an AND of metrics, each holding at or above its threshold (`cache.expiresIn` holds at or below it):

| Metric | Takes | Reads |
|---|---|---|
| `context` | tokens or percent | Main-loop context fill. A percent counts against `contextWindow`. |
| `limit.five_hour` | percent | 5-hour usage window. |
| `limit.seven_day` | percent | Weekly usage window. |
| `limit.any` | percent | The higher of the two. |
| `limit.five_hour.resetsIn` | duration | At least this long until the 5-hour reset. Needs `limit.five_hour` beside it. |
| `limit.seven_day.resetsIn` | duration | At least this long until the weekly reset. Needs `limit.seven_day` beside it. |
| `cost` | usd | Session cost. |
| `idle` | duration | Time since the last turn ended. |
| `cache.expiresIn` | duration | At most this long until the main thread's prompt cache expires. |
| `cache.miss` | tokens | Tokens the latest request re-wrote of a cache that should have been warm. |
| `cache.pings` | count | Warm pings in the current idle period. |

`every` repeats a trigger in steps past its first threshold (`75%`, `80%`, `85%`, …). It works
on one of `context`, `limit.*` percents or `cost`.

**`do`** is a list of actions:

| Action | Fires | Does |
|---|---|---|
| `"note"` | once, on the rising edge | Sends the model a note (needs a role). Each note also shows a toast, so you see what the model was told (`noteToasts`). |
| `"toast"` | once | A toast in the session. |
| `"notify"` | once | An OS notification. |
| `"compact"` | once | Runs `/compact` at the next safe turn end. Needs trust. |
| `"ping"` | once | Sends one tool-less request over the main thread's prefix to refresh the prompt cache. Needs trust, `times` and `cache.expiresIn` in the same `when`. |
| `"prompt"` | once | Submits a turn that tells the model you are away and asks for the handoff. Needs trust and `times`. |
| `{ "deny": ["Agent", "Workflow"] }` | while the AND holds | Refuses those main-loop tool calls. |

Edge actions fire once when the condition starts to hold, then re-arm when a metric drops below
its threshold (after `/compact`, when a usage window reports a lower figure). `/clear` re-arms
every trigger with a `context` condition.

Usage figures are those of the last response. From a minute after a window's reset time, with no
response since, ctx-guard reads that window as 0 % until the next response reports it: a usage brake
stops denying, the band and the report show 0 %, and keep-warm pings and cache prompts may run again
until fresh figures arrive. The estimate re-arms no trigger, so a window still full at the next
response sends no second note.

**`level`** (`soft`, `hard`, `stop`) picks the note wording; **`message`** adds your own text
to a note and, for a `prompt` action, replaces the default prompt text, with variables such as `{role}`, `{tokens}`, `{percent}`, `{threshold}`, `{window}`, `{limit}`,
`{resetsIn}`, `{handoffPath}`, `{readyToken}`, `{idle}`, `{expiresIn}`, `{id}`, `{tools}` and
`{liftsIn}` (when the brake lifts).

**`times`** caps a trigger at that many fires per idle period; a trigger with `ping` or `prompt`
must have it.

**`lift`** (on a trigger with a `deny`) says what runs when the brake lets go and its tools are
free again:

```jsonc
{ "id": "limit-brake", "when": { "limit.any": 95 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "stop",
  "lift": { "do": ["note", "notify"] } }
```

| `lift.do` | Effect |
|---|---|
| `"note"` | The model reads that the tools are back on its next request. |
| `"toast"`, `"notify"` | You hear of it. |
| `"prompt"` | An idle session is woken with a turn of its own. Needs trust, `autoActions`, no pause and `lift.times` (the most wake attempts between two of your inputs). |

A wake goes only when the brake touched the work (a refused call, or its note read), a turn ended
since, and you have not typed since. A brake that never touched the work lifts with its other
actions alone. If you typed, you get a toast, and the model reads the lift note on your next turn.
An untrusted repo, `autoActions` off, a pause, a spent `lift.times`, a refused prompt or failed
usage checks each send you a `notify` with the reason. Before it,
ctx-guard sends one request over the session's context to read fresh usage, since other sessions
may have spent the window meanwhile; if a brake holds again, nothing more happens. **A lift prompt
spends usage on its own**: that request, then the woken turn. Deny reasons tell the model when
the tool comes free and whether ctx-guard will prompt it then. Details:
[Lifts](../skills/guide/references/config-reference.md#lifts).

### Prompt cache

The band shows a countdown to the prompt cache's expiry (`cache 8m`) while the session is idle. A
trigger on `cache.miss` flags a request that re-wrote a cache that should have been warm, and
`ping` and `prompt` keep it warm while you are away. The TTL, when the countdown shows and the
ping limit are set by the top-level `cache` block. The `/ctx-guard` report has a `cache:` line
with the TTL and the time left. Details and an example:
[Prompt cache](../skills/guide/references/config-reference.md#prompt-cache) and
[use case 18](use-cases.md#18-stepped-away).

## What to block

A `deny` takes any main-loop tool by its exact name, built-in or MCP. Rules:

- Names match exactly: no wildcards, no prefixes. An MCP tool is written in full,
  `mcp__<server>__<tool>`. The model sees tool names in its tool list; `/mcp` shows a server's
  tools.
- Only main-loop calls are denied. A subagent's tools are left alone (use
  [subagent budgets](use-cases.md#6-coordinator-and-workers) for those).
- Denies apply only once the session has a role.
- A deny holds while its trigger's condition holds, judged afresh at every call, and lifts by
  itself when the condition stops holding. `/ctx-guard pause` or `blocking: false` lifts it now.
  A `lift` on the trigger tells the model, you, or wakes the session when it does.
- A deny cannot share a trigger with `idle` or a `cache.*` metric.
- It fails open: an unknown metric or a failed check denies nothing.

Good candidates, when a usage window runs low:

| Tool | Why |
|---|---|
| `Agent` | Subagents: usually the biggest spender, each runs a whole context of its own. |
| `Workflow` | Multi-agent workflows: many subagents per call. |
| `WebSearch`, `WebFetch` | Search and page fetches pull large results into the context. |
| `mcp__claude-in-chrome__navigate`, `mcp__playwright__browser_navigate`, … | Browser automation: screenshots and page dumps are heavy. Block the navigation tools and the session cannot open new pages. |
| Your own heavy MCP tools | Anything that returns big documents, runs remote jobs or costs money per call. |

Leave these alone:

| Tool | Why not |
|---|---|
| `Write` | The model writes the handoff with it; blocking it breaks restarts with `no-handoff`. |
| `Read`, `Edit`, `Bash`, `Grep`, `Glob` | The session could not even bring its work to a safe point. |
| `SubagentHandback`, `StructuredOutput`, `ReportFindings` | They hand results back; blocking them loses work already paid for. |

A brake at 95 % that stops subagents, workflows and the web (the built-in `limit-stop` does
this):

```jsonc
// one entry of a role's "triggers" list
{ "id": "limit-brake", "when": { "limit.any": 95 }, "do": ["note", "toast", { "deny": ["Agent", "Workflow", "WebSearch", "WebFetch"] }], "level": "stop" }
```

A staged brake: subagents first, then the web and the browser as the window keeps filling:

```jsonc
{ "id": "brake-agents", "when": { "limit.any": 85 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard" },
{ "id": "brake-web",    "when": { "limit.any": 95 }, "do": ["note", "toast", { "deny": ["WebSearch", "WebFetch", "mcp__claude-in-chrome__navigate"] }], "level": "stop" }
```

Both triggers hold at 95 %, so their denies add up: everything in both lists is blocked.

A deny also works on context, not only usage. This one stops new subagents once the main
context is past 70 %, when their reports would crowd out what is left:

```jsonc
{ "id": "ctx-no-agents", "when": { "context": "70%" }, "do": [{ "deny": ["Agent", "Workflow"] }] }
```

The `guide` skill tells the model not to route around a block with another tool that does the
same job (for example a shell command through `Bash` instead of `WebFetch`). That is an instruction, not
an enforcement: to be strict, add a permission rule as well.

## Roles

A session takes the first role it finds:

1. `/ctx-guard role <name|none>`, typed by you (or, in a session with no role,
   `/ctx-guard:resume role=<name> …` or a role's own `restart.command`, such as `/restart-lead`);
2. the `CTX_GUARD_ROLE` environment variable (`none` means no role);
3. the project's `defaultRole`, then the `defaultRole` switch.

Role names match `^[a-z][a-z0-9-]{0,31}$` and must exist in `roles`. A bad name gives no role
and a toast; it never falls through to the next source. One live session holds a role at a
time (a lease in `.ctx-guard/<role>.owner`); a second one gets a warning and cannot restart.

## Commands

| Command | Who | Does |
|---|---|---|
| `/ctx-guard` | anyone | Report. |
| `/ctx-guard role <name\|none>` | you | Set this session's role. |
| `/ctx-guard check` | you | Dry-run the restart verdict. |
| `/ctx-guard trust` | you | Approve the repo's restart, ready-check, compact, ping and prompt settings. |
| `/ctx-guard trust off` | you | Withdraw that approval. |
| `/ctx-guard reload` | anyone | Re-read the config files now. |
| `/ctx-guard pause [30m\|off]` | you | Lift blocks and automatic actions for a while (default 30 min); notes go on. |
| `/ctx-guard init [solo\|peers]` | you | Write a starter config if there is none, plus `.gitignore` lines. |
| `/ctx-guard:resume [role=<r>] [handoff=<path>] [prompt]` | ctx-guard or you | Resume from a handoff after `/clear`. What you leave out comes from the config: the session's role, its handoff path and restart prompt. |
| `/ctx-guard:guide` | anyone | The skill: how the model answers notes, and how to configure ctx-guard. |

"You" means typed in the prompt box. ctx-guard refuses these subcommands when the model or
another plugin sends them, so the model cannot pause, trust or re-role itself out of a note.
