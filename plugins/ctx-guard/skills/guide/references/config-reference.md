# ctx-guard config reference

Every key, default and rule of config schema v1, then recipes. The JSON Schema is
`assets/ctx-guard.schema.json`; the presets `/ctx-guard init` writes are in `assets/presets/`.

## Contents

- [Files and layers](#files-and-layers)
- [Zero-config behaviour](#zero-config-behaviour)
- [Quantities](#quantities)
- [Top-level keys](#top-level-keys)
- [Role keys](#role-keys)
- [Triggers](#triggers)
- [Lifts](#lifts)
- [Notes and template variables](#notes-and-template-variables)
- [Restart](#restart)
- [Ready checks](#ready-checks)
- [Band probes](#band-probes)
- [Compact](#compact)
- [Prompt cache](#prompt-cache)
- [Subagent budgets](#subagent-budgets)
- [Trust](#trust)
- [Path confinement](#path-confinement)
- [Roles](#roles)
- [userConfig switches](#userconfig-switches)
- [The `/ctx-guard` command](#the-ctx-guard-command)
- [Recipes](#recipes)

## Files and layers

Layers apply in this order; a later layer wins.

1. Built-in defaults, including one role `main` with no settings of its own.
2. `userConfig` switches (`/config`): machine-wide on/off switches only, see
   [userConfig switches](#userconfig-switches).
3. The team file `<root>/.claude/ctx-guard.json` (the `configPath` switch), committed.
4. The personal file beside it, `<root>/.claude/ctx-guard.local.json`, gitignored by
   `/ctx-guard init`. It gets the same trust as the team file.

Merging: objects merge key by key, arrays and scalars replace, and `null` deletes the key so the
built-in default applies. Within one file, `null` means the same as an absent key. Each file is
validated on its own, so errors name the file, and a file must be valid alone.

ctx-guard reads the files at session start, on `/ctx-guard reload`, and whenever a file's
modification time changes (checked after each main-loop turn).

An invalid file (bad JSON, unknown key, bad value) is a toast and a list of errors in the
`/ctx-guard` report. ctx-guard keeps the last good config. With no good config yet, it runs the
built-ins with automatic clear, compact, ping and prompt off. Hooks never throw.

## Zero-config behaviour

With no role from any source (no config file and no `defaultRole`), ctx-guard draws the band
and toasts. It sends no
model notes, denies no tools and runs no automatic actions, so a user-scope install never changes
the model's behaviour unasked.

| Trigger id | When | Does |
|---|---|---|
| `ctx-50` | context ≥ 50 % | toast |
| `ctx-70` | context ≥ 70 % | toast |
| `ctx-85` | context ≥ 85 % | toast |
| `limit-80` | `limit.any` ≥ 80 % | toast |
| `limit-90` | `limit.any` ≥ 90 % | toast |

Model notes start once the session has a role. The built-in role `main` makes this a one-step
opt-in: set the `defaultRole` switch to `main` in `/config` and every interactive session gets the
[built-in ladder](#built-in-ladder) with manual restart.

## Quantities

The field decides how a value reads, so `"10m"` is ten minutes in a duration field and ten
million tokens in a token field.

| Kind | Forms | Notes |
|---|---|---|
| tokens | `150000`, `"300k"`, `"1.2M"` | `k`/`K` = 1,000, `m`/`M` = 1,000,000; rounded to a whole number |
| percent | `"40%"`; `80` where the field is a percent only | above 0, at most 100 |
| duration | `"500ms"`, `"10s"`, `"10m"`, `"2h"`, `"1d"` | unit required, rounded to whole milliseconds |
| usd | `2.5`, `"$2.50"` | US dollars |
| count | `3` | a whole number |

Every quantity must be above zero.

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | — | Ignored by ctx-guard; lets an editor find the schema. |
| `version` | `1` | `1` | Any other value is an error. |
| `enabled` | boolean | `true` | `false` turns ctx-guard off in this project. |
| `stateDir` | path | `".ctx-guard"` | Folder for restart stamps (`<role>.restart`), role leases (`<role>.owner`) and default handoffs. |
| `readyToken` | string matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` | `"CTX-READY"` | The line that asks for a restart. |
| `defaultRole` | role name, `""` or `null` | none | Role for an interactive session that no command or `CTX_GUARD_ROLE` sets. |
| `contextWindow` | `"auto"` or tokens | `"auto"` | What context percents count against. `auto` uses the engine's own compaction window when it reports one (never above the model window), else the model window lowered to the `autoCompactWindow` setting. |
| `defaults` | role object | `{}` | Settings every role inherits. Objects deep-merge under each role; arrays (such as `triggers`) replace. |
| `roles` | object of role name → role object | `{ "main": {} }` | The roles. Names match `^[a-z][a-z0-9-]{0,31}$`. The built-in `main` stays unless a layer sets `"main": null`, so a userConfig `defaultRole` of `main` works in every repo. Once the project names roles of its own, `/ctx-guard` and role errors leave out a `main` that has no settings of its own and is neither the `defaultRole` nor the session's role. |
| `subagents` | object of subagent type (or `*`, `fork`, `teammate`) → budget | `{}` | [Subagent budgets](#subagent-budgets). |
| `band` | object | `{ "probes": [] }` | [Band probes](#band-probes): project scripts whose output is a band segment. Shared by every role. |
| `cache` | object | see [Prompt cache](#prompt-cache) | The cache TTL, the band countdown and the ping limit. Shared by every role. |

## Role keys

The same keys go in `defaults` and in each entry of `roles`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `description` | text | none | What the role is for. |
| `triggers` | list of triggers | the [built-in ladder](#built-in-ladder) | Replaces the built-in ladder as a whole. |
| `notes.suffix` | text | none | Appended to every note for this role. Template variables apply. |
| `handoff.path` | path; `{role}` is filled in | `"<stateDir>/{role}-handoff.md"` | The handoff file the notes name and the restart checks. |
| `handoff.instructions` | text; `{role}` is filled in | none | What the handoff must hold, and the skill that writes it if any; quoted in the note. |
| `restart.mode` | `"auto"`, `"manual"` or `"off"` | `"manual"` | `auto`: the ready token triggers a guarded restart. `manual`: notes ask the model to tell the operator. `off`: notes carry no handoff request. |
| `restart.via` | `"clear"` or `"compact"` | `"clear"` | `clear` runs `/clear` then the resume command; `compact` runs `/compact`. |
| `restart.command` | command name, leading `/` optional | `"ctx-guard:resume"` | Run after `/clear` as `/<command> role=<role> handoff=<path> <prompt>`. A project command works too. |
| `restart.prompt` | text | none | Appended to the resume command line. |
| `restart.peers` | list of role names | `[]` | Roles that must not restart within `peerGap` of this one. |
| `restart.peerGap` | duration | `"10m"` | Minimum gap between a peer's restart and this role's. |
| `restart.selfGap` | duration, or `"0"` for none | `"1m"` | Minimum gap between this session's own restarts on the ready token (`too-soon`). |
| `restart.minContext` | tokens or percent, or `"off"` | `"off"` | Context fill below which the ready token is refused (`not-needed`). Set on its own, never read from the triggers. |
| `restart.readyChecks` | list of [ready checks](#ready-checks) | `[]` | Commands that must pass before a restart. |
| `compact.instructions` | text | none | Passed to `/compact`. |

Text values must hold more than whitespace. Unknown keys are errors at every level.

## Triggers

```jsonc
{ "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note", { "deny": ["Agent"] }], "level": "stop" }
```

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; unique within the role's list. Marks are kept per id. |
| `when` | yes | An AND of metrics, plus an optional `every`. |
| `do` | yes | A non-empty list of [actions](#actions). |
| `level` | no | `soft`, `hard` or `stop`: picks the built-in note wording. |
| `message` | no | A note template that replaces the built-in wording for this trigger. For a `prompt` action it is the prompt's text. |
| `times` | no (yes with `ping` or `prompt`) | A whole number of at least 1: the most fires of this trigger in one idle period. See [`times`](#times). |
| `lift` | no | What runs when the trigger's `deny` lets go: a note, a toast, a notify, or a prompt that wakes the session. Only on a trigger with a `deny`. See [Lifts](#lifts). |

### Metrics

| Metric | Takes | Reads |
|---|---|---|
| `context` | tokens or percent | Main-loop context fill: input, cache-read and cache-write tokens of the newest request. A percent counts against `contextWindow`. A bare number is tokens. |
| `limit.five_hour` | percent | Percent used of the 5-hour usage window. |
| `limit.seven_day` | percent | Percent used of the weekly usage window. |
| `limit.any` | percent | The higher of the two windows. |
| `limit.five_hour.resetsIn` | duration | Time left until the 5-hour window resets, at least. Needs `limit.five_hour` in the same `when`. |
| `limit.seven_day.resetsIn` | duration | Time left until the weekly window resets, at least. Needs `limit.seven_day` in the same `when`. |
| `cost` | usd | Session cost. |
| `idle` | duration | Time since the last main-loop turn ended. Zero while a turn runs. The turn of a `prompt` action does not reset it; a turn a lift woke counts as work (see [Lifts](#lifts)). |
| `cache.expiresIn` | duration | Time left before the main thread's prompt cache expires, at most: it holds at or **below** its threshold. See [Prompt cache](#prompt-cache). |
| `cache.miss` | tokens | Tokens the latest main-loop request re-wrote of a cache that should have been warm. `0` for a request with no miss. |
| `cache.pings` | count | Warm pings in the current idle period. |

ctx-guard evaluates triggers after each main-loop turn (and when a usage window moves), mid-turn
after a main-loop request whose fill crosses a threshold, and on a one-minute timer that catches
`idle`.

**Rising edge.** Edge actions (`note`, `toast`, `notify`, `compact`, `ping`, `prompt`) fire once,
when the whole AND starts to hold. The trigger's mark then stays until a metric drops below its
threshold (after `/compact`, or when a usage window reports a figure below it); the trigger re-arms
then. `cache.expiresIn` is the reverse: its trigger re-arms when the time left rises above the
threshold, as after a warm ping. `/clear` resets the mark of every trigger with a `context`
condition; a trigger on `limit.*`, `cost` or `idle` alone keeps its mark, since a `/clear` leaves
those figures as they were, and re-arms only when its figure drops.
Marks survive a hot reload. A role change drops the old role's marks.

**Unknown metrics.** Context is unknown before the first response and right after `/clear`;
usage windows are unknown until the engine reports them, and a `.resetsIn` metric while its
window reports no reset time. `cache.expiresIn` is unknown before the first main-loop request
and after `/clear` or `/compact` until the next one. A trigger with an unknown metric is skipped and keeps its mark.

**A passed reset.** Usage figures are those of the last response; while the session is idle no
response comes. A minute after a window's reset time, ctx-guard reads that window as rolled
over: 0 %, reset time unknown, until the next response reports it. This is an estimate:

- It clears no mark. A percent trigger re-arms only on a reported figure below its threshold, or
  when its [lift](#lifts) runs, so the first response after the reset, if the window is still
  full, sends no second note for what is one crossing.
- It applies to every trigger. A percent brake on that window stops denying until the next
  response reports figures; the first request after the reset is judged on 0 %, and if the window
  is in fact full its response brakes the session again from the next request. The same 0 % feeds
  `cache.ping.maxUsage` and `cache.prompt.maxUsage`, so keep-warm pings and cache prompts may run
  again after a reset until fresh figures arrive.
- The band and the `/ctx-guard` report show 0 % (the report marks it estimated).

**Time left to a reset.** Every metric but `cache.expiresIn` holds at or above its threshold, so a `.resetsIn`
threshold means "at least this long until the reset". It pairs a usage level with how early it
came: `{ "limit.seven_day": 80, "limit.seven_day.resetsIn": "2d" }` holds at 80 % of the weekly
window only while two days or more remain. As the reset nears the condition stops holding, so a
deny on it lifts then and an edge action re-arms. See the
[early-spend brake](#an-early-spend-brake) recipe.

### `every`

`every` repeats a trigger in steps past its first threshold. With `"context": "75%", "every":
"5%"` the trigger fires at 75 %, 80 %, 85 % and so on. A jump across several steps fires once, at
the highest. The step falls with the metric, so a drop re-arms the lower steps.

- The `when` needs exactly one of `context`, `limit.five_hour`, `limit.seven_day`, `limit.any`,
  `cost`. `idle`, the `.resetsIn` metrics and the `cache.*` metrics cannot step.
- `every` takes the stepped threshold's unit: a percent step on a percent threshold, tokens on
  tokens. A bare number means that unit.

### `times`

`times: N` caps a trigger at N fires per idle period. An idle period starts when the operator's
own turn ends, at session start and after `/clear`; the turn of a `prompt` action does not start
one. A new period resets every trigger's count and `cache.pings`. With `every`, each step is one
fire. A fire counts whether or not its actions succeed. A trigger that used up its `times` keeps
re-arming as usual but does not act until the next period. A trigger without `times` fires as
often as its condition re-arms.

A trigger with `ping` or `prompt` must have `times`, so automatic spending has a cap.

### Actions

| Action | Fires | Does |
|---|---|---|
| `"note"` | rising edge | Sends the model a note (only when the session has a role). Several notes in one evaluation collapse into one. Each note also shows a toast, so the operator sees what the model was told (`noteToasts`); it stands in for a `"toast"` on the same trigger. |
| `"toast"` | rising edge | A toast in the session. |
| `"notify"` | rising edge | An OS-level notification. |
| `"compact"` | rising edge | Runs `/compact <compact.instructions>` at the next main-loop turn end, under the busy-work guard. Needs trust, `autoActions` on and no pause. |
| `"ping"` | rising edge | Sends one tool-less model request over the main thread's own prefix (`Reply with OK.`) and discards the reply. A warm read refreshes the cache's lifetime. Needs trust, `autoActions` on, no pause, `times`, and `cache.expiresIn` in the same `when`. See [Prompt cache](#prompt-cache). |
| `"prompt"` | rising edge | Submits a real turn with the trigger's `message`, or a default asking for the handoff. Needs trust, `autoActions` on, no pause and `times`. See [Prompt cache](#prompt-cache). |
| `{ "deny": ["Agent", …] }` | while the AND holds | Denies those main-loop tool calls. See below. |

**Denies** are level-triggered: each main-loop tool call is judged afresh from live usage, so a deny
lifts as soon as its metrics drop. They match tool names exactly, apply only once the session has a
role, and fail open: an unknown metric or a failed check denies nothing. The reason names the
trigger, its figures and what lifts it (for a `.resetsIn` condition, also when the reset comes close
enough), then when the tool comes free: the latest `{liftsIn}` among all the triggers that deny it
and hold, or "at a time not known yet". When one of them has `prompt` in `lift.do` and would wake
the session (trusted, `autoActions` on, no pause, `lift.times` not spent), it adds "ctx-guard is set
to prompt you when the tool comes free". `/ctx-guard pause` and the `blocking` switch lift every
deny. A deny cannot share a trigger with `idle` or a `cache.*` metric. A response's tool calls start
before its usage arrives, so a call made while the response streams is judged on an estimate of that
request's context: the previous request's input and output plus the tool results since, at 4
characters a token (the person's prompt and any note are not counted).

### Levels

The note wording follows the level, never the number of triggers.

| Level | Context wording | Usage wording |
|---|---|---|
| none | Keep this in mind as you plan the next steps. | (same) |
| `soft` | Plan for a handoff: finish the item in hand and keep new work small. | Prefer cheaper steps: fewer subagents and no speculative work. |
| `hard` | Wrap up: start no new item and bring the current one to a safe point. | Wrap up: start no new item, dispatch only what the current one needs, and bring it to a safe point. |
| `stop` | Stop: dispatch nothing new and start no new work. | (same as context) |

With `restart.via: compact` the soft context wording reads "Plan for a compaction: …" instead.

### Built-in ladder

A role with no `triggers` of its own (and none in `defaults`) gets:

| Trigger id | When | Does | Level |
|---|---|---|---|
| `ctx-soft` | context ≥ 40 % | note | soft |
| `ctx-hard` | context ≥ 60 % | note | hard |
| `ctx-stop` | context ≥ 75 %, every 5 % | note | stop |
| `limit-soft` | `limit.any` ≥ 80 % | note | soft |
| `limit-hard` | `limit.any` ≥ 90 % | note, toast | hard |
| `week-80-early` | `limit.seven_day` ≥ 80 % and its reset ≥ 2 days away | note, deny `Agent`, `Workflow`; lift: note | hard |
| `week-90-early` | `limit.seven_day` ≥ 90 % and its reset ≥ 1 day away | note, deny `Agent`, `Workflow`; lift: note | hard |
| `limit-stop` | `limit.any` ≥ 95 % | note, toast, deny `Agent`, `Workflow`, `WebSearch`, `WebFetch`; lift: note | stop |

The two `week-*-early` triggers carry their own note: "With {resetsIn} still to the weekly
reset, start no new subagents so the rest of the window lasts; do small steps in this session."
They stop subagents and workflows sooner the earlier the weekly window fills, and lift by themselves as the
reset nears (see [Time left to a reset](#metrics)). A window that reports no reset time leaves
them unknown, so only `limit-stop` blocks then. The three brakes lift with a note alone, which the
model reads on its next request.

## Lifts

A trigger with a `deny` is a brake. Its `lift` names what runs when the brake lets go:

```jsonc
{ "id": "week-60-early",
  "when": { "limit.seven_day": 60, "limit.seven_day.resetsIn": "4d" },
  "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard",
  "lift": { "do": ["note", "prompt"], "times": 3 } }
```

| Key | Required | Meaning |
|---|---|---|
| `lift.do` | yes | Actions run when the brake lifts: `note`, `toast`, `notify`, `prompt`. |
| `lift.times` | with `prompt`, and only with it | A whole number of at least 1: the most wake attempts of this trigger between two operator inputs. |
| `lift.message` | no | Text for the lift note and the wake prompt, in place of the defaults below. All template variables apply (`{id}` and `{tools}` among them), and `{liftReason}`, which only lift texts have. |

| Choice | `lift.do` | Effect |
|---|---|---|
| Tell the operator | `["notify"]` (or `toast`) | OS notification; the operator decides whether to say "go on". Works untrusted. |
| Tell the model | `["note"]` | The model reads it on its next request. Useful mid-turn; an idle session still waits. |
| Wake the model | `["prompt"]` | Submits a turn so an idle session resumes on its own. It spends usage on its own (see [Cost](#the-lift-check)). Needs trust, `autoActions` and no pause. When the prompt does not go: a brake that never touched the work runs its other actions alone; after operator input, the operator gets a toast and the model the lift note on the next turn; a closed gate (untrusted, `autoActions` off, paused), a spent `lift.times`, a refused prompt or failed checks each send the operator a `notify`. |

**Holds.** ctx-guard keeps a hold for each trigger with `lift` while its whole `when` holds. A
pause neither ends a hold nor starts one. When one metric is known not to hold (whatever the
others read), the brake lets go; the hold **lifts** once no other trigger of the role whose
`when` holds denies one of its tools, the rule the call path applies. Until then it waits, and it
goes back to holding if its own condition holds again first. A lift frees all of its trigger's
deny tools at once: with two stacked brakes on `Agent`, the session hears of a lift only when
`Agent` is usable. An unknown reading changes nothing, so a dropped usage report neither ends a
hold nor wakes the session.

These are not lifts: the hold is dropped with no lift action when a reload removes the trigger or
its `lift`, or changes its `when` or its deny tools; when `blocking` is off (no hold starts while
it stays off); and on a role change. After `--resume` the session has no holds until the first
response reports figures.

**What runs.** A lift without `prompt` runs its actions at once, on the figures at hand: after a
long wait those may be the [estimate of a passed reset](#metrics). Several lifts in one
evaluation send one note and one notify. A lift that runs clears its trigger's mark, so if the
condition holds again later the trigger fires its note as for any new crossing; when the lift ran
on estimated figures and the first reported figures show the condition holding, that fire does
not count in the trigger's `times`.

**Default texts.**

| Text | Default |
|---|---|
| Lift note | `[ctx-guard] Trigger "{id}" has lifted: {liftReason}. {tools} are allowed again.` |
| Wake prompt | `[ctx-guard] Trigger "{id}" has lifted: {liftReason}. {tools} are allowed again. You paused your work because of it. Time has passed since then, so first check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. Then carry on with the work you paused. If nothing is left to do, say so in one line and stop.` |
| Toast and `notify` | `ctx-guard: "{id}" lifted ({liftReason}); {tools} allowed again.` |
| `notify` for a wake that did not run | The toast text plus `Not woken: <why>.`: `the repo is not trusted`, `autoActions is off`, `ctx-guard is paused`, `lift.times is spent` or `the prompt was refused`. |
| `notify` after failed checks | `ctx-guard: "{id}" may have lifted, but fresh usage could not be read (the window may still be full). Not woken; ctx-guard tries again when usage is next reported or the window resets.` |

With one deny tool the defaults read "is allowed again". When the wake prompt goes, the lift note
is not appended: the prompt carries the same text. `{limit}` reads the window's percent, which
after a reset is an estimate; the default texts leave it out.

### Waking the session

A lift with `prompt` is judged in this order when it is found, and again on each idle tick while
it waits. The first rule that stops it decides.

1. **The brake touched the work.** During the hold a call to one of its tools was refused (by any
   trigger), or its note was read (a main-loop request went out after the note was appended); and
   a main-loop turn ended after that. Otherwise the prompt is dropped with no `notify`, and the
   rest of the lift runs. A hold that starts while its brake has already fired (a reload gave the
   trigger its `lift`) takes that earlier note as its own: it counts as read when a main-loop
   step ended after it and no `/clear` came since. A `/clear` other than the operator's (ctx-guard's restart) starts a
   context the brake never touched: a hold's earlier touch no longer counts, and a wake prompt
   waiting to go is dropped.
2. **No operator input since the last touch.** Operator input is a prompt or command with origin
   `composer`, `bridge`, `sdk`, `peer`, `coordinator`, `channel` or `slack-ping`, whether it
   starts a turn or arrives in a running one; an operator's `/clear` and a typed
   `/ctx-guard:resume` count, `/ctx-guard` itself does not. Notifications, schedules, other
   plugins (ctx-guard's restart included) and SendMessage deliveries are not operator input. If
   the operator spoke, they are steering: the prompt is dropped, a toast says the brake lifted,
   and the lift note goes to the model even when `lift.do` has no `note`.
3. **Gates.** In an untrusted repo, with `autoActions` off or while paused, the prompt becomes a
   `notify` with its reason. This counts no attempt.
4. **`lift.times`.** Past it, the lift runs without `prompt` and its `notify` says `lift.times is
   spent`. The count resets on operator input; a trigger's own `times` does not count wake
   attempts, and `lift.times` does not count its fires.
5. **Idle.** No main-loop turn runs and no lift work is held back (below). Otherwise the lift
   waits for the next idle tick, its other actions with it.
6. **Fresh figures.** A lift check (below) reads the account's current usage. This is the wake
   attempt; every other lift of the same evaluation waits for it. On fresh figures, a lift whose
   tools are free runs its actions and the prompt goes; one a brake holds again does nothing, keeps
   its stamps, and its next let-go is a new lift.

The attempt is charged before the check to the first trigger in config order that passed rules
1–5, whatever the check finds. The prompt goes from that trigger if its tools are free, else from
the first other one that passed and is free. At most one prompt goes; when it does, the other
lifts' "Not woken" notifies are dropped, and a `notify` in `lift.do` is sent once.

**Mid-turn.** A lift found while a main-loop turn runs has figures from that turn's own
responses: it runs its actions at once, with no check. Its prompt waits for the turn's end and
is dropped when the model reads the lift note or a call to one of the freed tools goes through;
otherwise it is judged at the next idle tick. A prompt the check let through while a turn
started meanwhile waits for the next idle tick, with no new check, and goes only if the tools are
still free; its lift note is held back meanwhile, and appended if the prompt is dropped while the
tools are free (operator input, a freed tool used).

**Refused.** A wake prompt a hook drops (or a submit that throws) is tried again on idle ticks,
up to three tries in all, with the same text and no new check; then the operator gets the
`notify` with `the prompt was refused`.

**The woken turn** does not start an idle period: trigger `times` and the cache's period go on, as
for a `prompt` action's turn. Unlike that turn, it counts as work for `idle`: `idle` does not grow
during it and counts from its end. A woken turn that hits the brake again can be woken again.

**Lift work and other automatic actions.** A lift check, or a wake prompt waiting to go, does not
overlap ctx-guard's other automatic actions. It waits while a trigger's prompt waits for its
retry, a ping is in flight, a compact or a restart runs, or a compact is queued for the end of the
turn and has not yet found the session busy. A trigger prompt, ping or
compact that arises while lift work is under way waits for the next idle tick (a compact, for the
next turn end, or for the lift work to end with no turn). A compact that runs while a wake prompt
waits to go comes first; the lift is then judged again from rule 1. A wake prompt refused three
times drops a compact that waited for it.

### The lift check

While a session waits, its usage figures are its own last response's; other sessions on the same
account keep spending. Before a wake, ctx-guard sends the request a `ping` sends
(`Reply with OK.`) over the session's context, then reads the usage windows that request
reported. It shares the ping's request, its 2-minute timeout and its one-at-a-time slot, and none
of its guards or bookkeeping: it ignores `cache.ping.maxUsage` and `cache.prompt.maxUsage`, runs
with the cache expired or cold, and leaves `cache.pings`, the countdown and the cold mark as it
found them.

A check that fails (an API error, an empty reply, nothing to fork yet, the timeout) is tried again
on each idle tick while the hold still lets go, three tries in all, counted as one attempt. A
failure whose usage figures moved is judged on those. After the third, the operator gets the
failed-checks `notify` and the hold stalls: it lifts again only after a new usage report or once
the earliest known window reset passes (a window read as rolled over resets again one window
length after it rolled over). The window that fails the check need not be the brake's own: a
full five-hour window can fail the check of a weekly brake. Leaving the stall is a new attempt,
judged again from rule 1. The other lifts that waited for the check run on the
figures at hand. A hot reload or `/clear` during the fork counts it as a failed try; a new module
starts no check until 2 minutes after the fork began. A request past its timeout still holds the
slot until it answers, or until 4 minutes after it went.

**Cost.** A lift `prompt` spends usage on its own: the check resends the session's context (after
hours of waiting the cache has expired, so it writes the whole context once), and the wake prompt
then runs a turn, which reads that cache warm. When a brake holds on fresh figures, the check is
the whole cost and no turn runs.

## Notes and template variables

A note starts with `[ctx-guard]`, then holds:

1. one sentence per figure that crossed, at its highest threshold ("Context is at 312k (31% of
   1M), past 300k.");
2. the wording of the highest level among those triggers;
3. each fired trigger's own `message`, rendered;
4. the restart tail for the role's mode, only when a fired trigger has a `context` condition: a
   restart frees context, so a note on usage, cost or idle alone asks for none;
5. `notes.suffix`, rendered.

Each note also shows a toast, so the operator sees what the model was told (`noteToasts`). It
names the level, the figure of the highest-level trigger and its threshold, and the ask in a few
words: `ctx-guard → model (hard): context 52k past 50k — wrap up; write the handoff, then end with
CTX-READY`. A trigger that also has `"toast"` shows this toast alone, not two. Subagent budget
notes, deny reasons and refusals show no such toast.

**Restart tail.** With `mode: auto` and `via: clear`:

> At the next safe point — no subagents running, current work recorded — write the handoff to
> `.ctx-guard/lead-handoff.md`: *instructions* Then end your reply with a line holding only
> `CTX-READY`.

- `mode: manual` ends with "Then tell the operator 'ready for /clear'."
- Without instructions it reads "… write the handoff to `.ctx-guard/lead-handoff.md`." When
  the instructions name a skill, the model writes the handoff with it, to that path.
- `via: compact` asks for no handoff: it ends on the token ("…; ctx-guard then compacts the
  session."), or in manual mode on "tell the operator 'ready for /compact'".
- `mode: off` adds no tail.
- A note promises `auto` only when ctx-guard would act on the token. With `autoActions` off, an
  untrusted repo or a pause, it reads as `manual`.

**Template variables** fill `message` and `notes.suffix`. Values are numbers, names and paths,
never file contents. A missing value reads `unknown`; an unknown `{name}` stays as written.

| Variable | Example | Meaning |
|---|---|---|
| `{role}` | `lead` | The session's role. |
| `{tokens}` | `312k` | Context fill. |
| `{percent}` | `31%` | Fill as a percent of the window. |
| `{threshold}` | `75%` | The threshold (or `every` step) that fired. |
| `{window}` | `1M` | The effective context window. |
| `{limit}` | `5-hour 82%` | The usage window behind a limit metric. |
| `{resetsIn}` | `2h10m` | Time until that window resets. |
| `{handoffPath}` | `.ctx-guard/lead-handoff.md` | The role's handoff file. |
| `{readyToken}` | `CTX-READY` | The ready token. |
| `{idle}` | `3h40m` | Time since the last main-loop turn ended. |
| `{expiresIn}` | `5m` | Time left before the main thread's prompt cache expires. |
| `{id}` | `week-60-early` | The trigger's id. |
| `{tools}` | `Agent, Workflow` | The trigger's deny tools. |
| `{liftsIn}` | `5h` | When the trigger's condition stops holding: for a `.resetsIn` condition, the time left less its threshold; for usage percents alone, the time until the window reads as rolled over, a minute past its reset (for `limit.any`, the latest among the windows at or past the threshold); `unknown` otherwise. |
| `{liftReason}` | `the 5-hour usage window reset` | In lift texts only: what let the brake go. `the 5-hour usage window reset` or `the weekly usage window reset` for a window past its reset; `weekly usage is below 60%` for a reported percent; `the weekly reset is less than 4d away` for a `.resetsIn` condition; `its condition no longer holds` for any other metric. For `limit.any` it names the window that held the brake. |

## Restart

### The ready token

The token counts when the main loop's answer ends on a line that holds only the token, give or
take anything but letters and digits around it (`**CTX-READY**` counts). The token inside a
sentence never counts, and neither does a subagent's answer.

ctx-guard acts on it when the role's `restart.mode` is `auto`, the `autoActions` switch is on and
ctx-guard is not paused. Otherwise it ignores the token silently: the notes already told the model
to ask the operator.

### Asking for a restart: `/ctx-guard:clear`

The operator can ask for a restart before any trigger does. `/ctx-guard:clear [note]`, typed in
the prompt box, hands the model the note a `stop`-level context trigger would send the session's
role: the stop wording, the restart tail for the role's effective mode, then `notes.suffix` (its
figures read `unknown`). The note travels as the command's text; anything typed after the command
follows it. In `auto` mode (trusted, `autoActions` on, not paused) the model writes the handoff and
ends with the ready token; otherwise it tells the operator 'ready for /clear' (or '/compact'). The
token then meets the verdict below like any other, `selfGap` included, except `restart.minContext`:
the operator asked for the restart, so it is not judged. The ask holds until the operator's next
input or the next restart.

For role `main` with `handoff.instructions` "Sections: Goal, State, Next action.", no
`notes.suffix`, in `auto` mode, `/ctx-guard:clear Commit the test first.` reaches the model as the
command's prompt followed by:

```text
[ctx-guard] The operator asked for a restart with /ctx-guard:clear. Stop: dispatch nothing new and start no new work. At the next safe point — no subagents running, current work recorded — write the handoff to `.ctx-guard/main-handoff.md`: Sections: Goal, State, Next action. Then end your reply with a line holding only `CTX-READY`.

Commit the test first.
```

ctx-guard refuses the command, and nothing runs, when it was not typed in the prompt box, when
ctx-guard is not active, when the session has no role, or when the role's `restart.mode` is `off`.

### The verdict

The restart runs right after the turn ends. Checks run in this order; the first that fails refuses
the restart, and nothing is cleared. A refusal is a toast and this note to the model:

```text
[ctx-guard] CTX-READY ignored (<code>): <reason>. Nothing was cleared.
```

With `via: compact` it ends "Nothing was compacted."

| Code | Refused when | Fix |
|---|---|---|
| `untrusted` | The repo's restart settings are not approved, or changed since. | The operator reads `/ctx-guard` and runs `/ctx-guard trust`. |
| `already-busy` | A restart or compact is under way, a resume is pending (under 5 min old), or a turn started after the token. | Wait for it to finish. Do not repeat the token. |
| `not-needed` | The context is known and below `restart.minContext` (a percent read against the window): a restart would free too little. Not judged when `restart.minContext` is off (the default), when the context is unknown, or when the operator asked for the restart with `/ctx-guard:clear` (until their next input). | Go on working; a context note asks for the restart when it is due. Lower `restart.minContext`, or set it to `"off"`. |
| `too-soon` | This session's own last restart on the ready token (a `/clear` or a `/compact`) was less than `restart.selfGap` ago. | Go on working; do not repeat the token. Set `selfGap: "0"` to turn the gap off. |
| `no-restart-command` | `/<restart.command>` (`/compact` for `via: compact`) is not among the session's commands. | Fix `restart.command`, or install the plugin or project command it names. |
| `agents-running` | A listed agent is pending, running or waiting, or an agent was seen stepping in the last 15 min with no end (this covers workflow agents). | Let the agents finish or stop them, then send the token again. |
| `background-tasks` | The last Stop reported background tasks, or no Stop has reported yet. | Finish or stop the background shells, then send the token again. |
| `role-shared` | Another live session holds this role's lease. | End the other session, or give one of them another role. |
| `no-handoff` | The handoff file is missing, empty or not a file. | Write the handoff, then send the token again. |
| `handoff-stale` | The handoff was not written after the session start or the last `/clear`. | Rewrite it in this session, then send the token again. |
| `stamp-unreadable` | This role's or a peer's stamp `<stateDir>/<role>.restart` holds garbage. | Delete the damaged stamp file. |
| `peer-restarting` | A peer restarted less than `peerGap` ago. | Wait out the gap, then send the token again. |
| `ready-check-failed` | A ready check exited non-zero, timed out or could not start. The reason holds the end of its output. | Fix what the check flags (for example, commit the work), then send the token again. |
| `race-lost` | A peer that also passed every check started its restart first. | Wait out `peerGap`, then send the token again. |
| `error` | Anything else: a path outside the root, the config not loaded, `/clear` refused, a failed read. | Read the reason; `/ctx-guard check` shows each check. |

`via: compact` skips the lease, handoff, stamp, peer and race checks (`role-shared`, `no-handoff`,
`handoff-stale`, `stamp-unreadable`, `peer-restarting`, `race-lost`).

`/ctx-guard check` runs the same checks as a dry run: it writes no stamp, races nobody and
clears nothing. It runs the ready checks only when the repo is trusted. Within 5 minutes (or
`selfGap`, if longer) of a restart it warns when the context is already past the role's lowest
context threshold: the next note may ask for another restart at once.

### A successful restart

1. ctx-guard re-checks that no turn, agent or background task started since the token.
2. It writes its stamp `<stateDir>/<role>.restart`, waits 1.5 s, and reads the peers' stamps
   again. Of two sessions that got this far, the older stamp wins; the loser refuses with
   `race-lost` and puts its old stamp back.
3. It re-checks once more, records a pending resume, and runs `/clear`.
4. It runs `/<restart.command> role=<role> handoff=<path> <prompt>`.

The default command, `/ctx-guard:resume`, reads the handoff, checks its claims against the
repository (that its git commit is `HEAD` or an ancestor, that the paths it names exist), then
carries out its Next action, or stops and reports each mismatch.

A hot reload between `/clear` and the resume finishes the resume at the next session start, if
the pending resume is under 5 minutes old. A resume that does not run puts "restart failed — type
/…" on the band.

## Ready checks

```json
{
  "version": 1,
  "roles": {
    "main": {
      "restart": {
        "mode": "auto",
        "readyChecks": [{ "run": ["sh", ".claude/ctx-guard/clean-worktree.sh"], "timeout": "10s" }]
      }
    }
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `run` | non-empty list of strings | — | The command, then its arguments. Runs without a shell, from the project root. |
| `timeout` | duration | `"30s"` | At most `"10m"`. |

Exit 0 passes. Any other exit, a timeout or a start failure refuses with `ready-check-failed`.
Checks run in order and stop at the first failure. They run only in a trusted repo, and only
once the checks above them in the verdict have passed. A failed check's refusal names its exit
code and the last 300 characters of its stderr (stdout when stderr is empty), on one line, so
make a check print why it failed.

### What a check is told

A check runs with these environment variables, taken from the facts the verdict gathered:

| Variable | Value |
|---|---|
| `CTX_GUARD_PURPOSE` | `ready-check`; `dry-run` under `/ctx-guard check` |
| `CTX_GUARD_SCRIPT_ROLE` | the role |
| `CTX_GUARD_ROOT` | the project root as the session reports it (the script's working directory) |
| `CTX_GUARD_STATE_DIR` | `stateDir`, absolute |
| `CTX_GUARD_HANDOFF` | the configured handoff path, absolute, whether or not the file exists |
| `CTX_GUARD_HANDOFF_MTIME_MS` | the handoff's mtime, epoch ms; empty when the file is absent or unusable |
| `CTX_GUARD_SINCE_MS` | the later of the session start and the last `/clear`, epoch ms: the bound `handoff-stale` uses |
| `CTX_GUARD_VIA` | `clear` or `compact` |

Every variable is always set. A value that does not apply (no role, the handoff under
`via: compact`, an absent handoff's mtime) is the empty string, so test for empty rather than
for unset. Values are decimal integers or plain strings, never quoted.

`/ctx-guard check` runs the checks with `CTX_GUARD_PURPOSE=dry-run`, so a check with side
effects can skip them.

The role is in `CTX_GUARD_SCRIPT_ROLE`, not `CTX_GUARD_ROLE`: ctx-guard reads `CTX_GUARD_ROLE`
to pick a session's role, so a script that starts `claude` would otherwise hand its role on.

The `guide` skill ships example checks; see [Example scripts](#example-scripts).

Files ctx-guard or the handoff writes count as changes unless gitignored:

- `stateDir` (`/ctx-guard init` adds it to `.gitignore`);
- a `handoff.path` outside `stateDir`;
- anything else a skill named in `handoff.instructions` writes.

Ignore them, or pass `--tracked-only` if they are never committed.

## Band probes

A probe is a project script whose output is a segment on the band. Probes show status only:
they never gate a restart, a deny or a note.

```json
{
  "version": 1,
  "band": {
    "probes": [
      { "id": "git", "run": ["sh", ".claude/ctx-guard/git-branch.sh"], "every": "60s", "timeout": "5s" }
    ]
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `band.probes` | list | `[]` | At most 4 probes, shared by every role. A later layer's list replaces an earlier one. |
| `id` | string matching `^[a-z][a-z0-9-]{0,31}$` | — | Unique in the list. Names the probe in the report and in its failure segment. |
| `run` | non-empty list of strings | — | The command, then its arguments. Runs without a shell, from the project root. |
| `every` | duration | `"60s"` | How often it runs. At least `"15s"`. |
| `timeout` | duration | `"5s"` | At most `"30s"`. |

**Output.** Exit 0 with no output (or only blank lines) draws no segment. Otherwise the first
non-blank line is the segment's text: terminal escapes and control characters are removed, and
text longer than 40 characters is cut to 39 plus `…`. An optional next line picks a colour:
`inactive`, `green`, `warning`, `error` or `subtle`; any other value keeps the default. A
non-zero exit, a timeout or a start failure draws `<id> ?` in `warning`; the last 300
characters of stderr (stdout when stderr is empty) go to the report, never to the band.

**Environment.** The [ready-check variables](#what-a-check-is-told), with
`CTX_GUARD_PURPOSE=band-probe`. `CTX_GUARD_SCRIPT_ROLE`, `CTX_GUARD_HANDOFF` and
`CTX_GUARD_HANDOFF_MTIME_MS` are empty when the session has no role.

**When they run.** On their own timers, from the session start and again right after a `/clear`.
Never from a turn, a tool call or a context measure, so a slow probe holds nothing up. A tick
while the probe's last run is still going is skipped. Probes do not run when ctx-guard is off,
when `display` is `off`, or when the repo is not [trusted](#trust); a pause does not stop them.
After a config reload a removed probe's segment goes, and the last result of the others stays
drawn until their next run.

**Trust.** `band.probes` is approved with the other settings, and every probe argument that is a
file under the project root is hashed, so editing the script withdraws the approval. A config
without probes approves as before they existed.

**Report.** `/ctx-guard` lists each probe: `probe git: "main" (warning), 2m ago`, `no segment`,
`failed 2m ago: exited 1: …` or `not run (untrusted)`.

`assets/probes/git-branch.sh` is an example: the branch name, in `warning` while the worktree
has changes. Copy it into `.claude/ctx-guard/` as with the ready-check example, then run
`/ctx-guard trust`.

### Example scripts

The `guide` skill ships these under `assets/`. To use one, ask Claude to copy it into
`.claude/ctx-guard/` (or copy it from the plugin's repository by hand), wire it in, then run
`/ctx-guard trust`, since trust hashes the script. Each file is self-contained: trust hashes
only the files named in `run`, so a helper a script imports would go unchecked.

| File | Kind | What it does |
|---|---|---|
| `ready-checks/clean-worktree.sh` | ready check | Fails while `git status --porcelain` lists changes, and prints them. `--tracked-only` ignores untracked files. |
| `ready-checks/handoff-committed.sh` | ready check | Fails until the handoff is tracked by git and committed, so a peer or the next session reads it from git. Passes for a compact. |
| `ready-checks/worktrees-committed.sh` | ready check | Fails while a linked git worktree (`git worktree add`, where a builder or parallel task works) has uncommitted changes; the main checkout is not checked. `--tracked-only` as above. |
| `ready-checks/handoff-after-worktrees.sh` | ready check | Fails while the handoff was committed before the newest commit in any linked worktree, so what it says about that work is current. Passes for a compact. |
| `ready-checks/jobs-quiet.py` | ready check | For jobs a launcher runs as separate processes: fails while a job is running (`<name>.pid` with no `<name>.rc`) and while the handoff is not newer than the newest job. Arguments are job-folder globs, default `.jobs`. |
| `probes/git-branch.sh` | band probe | The branch name, in `warning` while the worktree has changes. |
| `probes/worktrees.sh` | band probe | Each linked worktree as `<folder> <head>`, `+N` for uncommitted files, then `handoff uncommitted` while the role's handoff has changes; `warning` on either, else `inactive`. |
| `probes/superpowers-plan.py` | band probe | `plan 6/7 <name>`: tasks complete in the newest superpowers ledger (`.superpowers/sdd/<plan>/progress.md`) against the plan's `### Task` headings. Nothing before the first task is complete or after the last; checked against superpowers 6.4.1. |

Run `.sh` files as `["sh", "<path>"]` and `.py` files as `["python3", "-I", "<path>"]`. [Use cases](../../../docs/use-cases.md)
4, 12, 13, 14 and 15 show them wired in.

## Compact

Two ways to compact instead of clearing:

- **`restart.via: "compact"`.** The ready token runs the verdict without the lease, handoff,
  stamp, peer and race checks, then `/compact <compact.instructions>`. No resume follows. Notes
  ask for no handoff, and a refusal ends "Nothing was compacted."
- **The `compact` action.** A trigger with `"do": ["compact"]` queues `/compact
  <compact.instructions>` on its rising edge; it needs no ready token.

A queued compact is in one of these states:

| State | When | What happens |
|---|---|---|
| queued | The trigger fired. | Runs at once when no main-loop turn runs, else at the next main-loop turn end, once no turn, restart, agent or background task is busy (one toast while it waits). A ready-token restart at the same turn end goes first; a refused one lets the compact run. |
| held | It fired within 5 minutes of a compact that ran. | Waits out the 5 minutes, then runs only if the engine's own figures still cross the threshold; otherwise it is dropped and the trigger re-arms. A reading from before the compaction cannot start another. |
| blocked | `autoActions` is off, the repo is untrusted, or ctx-guard is paused. | One toast per reason and a report line. Runs once that lifts (`/ctx-guard trust`, the pause ends, `autoActions` on), if the trigger is still marked. |
| sent | `/compact` is running. | A ready token now refuses with `already-busy`. A reload while it is sent never sends it twice. |

At most one compact waits. A queued compact is dropped when its trigger re-arms first and on
`/clear`. The report shows the queued compact and the last one.

Both ways need trust, `autoActions` on and no pause.

## Prompt cache

Claude Code caches the main thread's prompt prefix for a time (the TTL); a request after that
re-writes the whole prefix at the cache-write rate. ctx-guard counts down to the expiry, flags a
request that re-wrote a cache that should have been warm, and can keep the cache alive while you
are away.

```json
{
  "version": 1,
  "cache": {
    "ttl": "auto",
    "band": { "show": "25%", "warn": "10m" },
    "ping": { "maxUsage": 90 },
    "prompt": { "maxUsage": 90 }
  }
}
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `cache.ttl` | `"auto"`, `"5m"`, `"1h"` | `"auto"` | The cache's lifetime. `"5m"` or `"1h"` overrides detection. |
| `cache.band.show` | duration, percent of the TTL, `"always"` or `false` | `"25%"` | The countdown shows while the session is idle and the time left is at or below this. `25%` is 15 minutes of a 1-hour TTL and 75 seconds of a 5-minute one. `"always"` shows it for the whole idle period; `false` hides it. |
| `cache.band.warn` | duration or percent of the TTL | `"10m"` | At or below this the segment takes the warning colour. Claude Code compacts an idle session itself about 6 minutes before a 1-hour cache expires; the default warns 4 minutes ahead of that. |
| `cache.ping.maxUsage` | percent | `90` | No ping while either usage window is at or above this. A window a minute past its reset reads 0 % until a response reports it again. |
| `cache.prompt.maxUsage` | percent | `90` | No prompt from a trigger on a cache metric while either usage window is at or above this. A window a minute past its reset reads 0 % until a response reports it again. |

Unknown keys in `cache` are errors.

### The TTL

With `ttl: "auto"` the TTL comes from the first source that answers; a later, stronger answer
replaces a weaker one.

1. **The transcript.** After a main-loop turn ends, ctx-guard reads the session's transcript
   (`<claude config dir>/projects/<working directory with every non-alphanumeric character as "-">/<session id>.jsonl`,
   where the config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`; also the path a Stop hook names,
   where those run) and takes the newest request that
   wrote to the cache. A write to the 1-hour tier means `1h`; to the 5-minute tier, `5m`. It reads
   again after each turn until a request tells. A refused read, or a read of a file over 1 MiB
   with no cache write in it, is not retried until `/clear`.
2. **Observation.** A main-loop request that finds the cache warm after a gap of more than 5
   minutes proves `1h`.
3. **A guess.** A session with usage windows (a subscription) guesses `1h`, any other `5m`. The
   band marks a guessed TTL with `~`: `cache ~8m`.

### The countdown

`cache.expiresIn` is the time left before the main thread's cache expires: the latest main-loop
request or warm ping, plus the TTL, less 30 seconds because the exact moment of the cache write is
unknown. It is `0` once expired and unknown before the first main-loop request and after `/clear` or `/compact`.
While a main-loop turn runs it is the full TTL, since the cache is in use. Subagent requests do
not move it: their prefix differs.

The band shows the countdown right after the context figure, only while the session is idle and
the time left is within `band.show`:

| Band | Meaning |
|---|---|
| `cache 8m` | Time left, in whole minutes; `cache <1m` in the last minute. |
| `cache ~8m` | The same, with a guessed TTL. |
| `cache 8m · ping 2/3` | Two of the three pings the pinging trigger allows have found the cache warm. |
| `cache cold` | The cache expired, or a ping found it already expired. Cleared by the next main-loop request. |

The segment is the `warning` colour at or below `band.warn`; `cache cold` is dim. The one-minute
idle tick redraws the band, and it is written only when the band changed.

The `/ctx-guard` report has one `cache:` line: the TTL and its source (`a guess` for a guessed
one), the time left, `pings 2/3` when a trigger pings, `cold` after a cold ping, the last miss, and
a ping or prompt waiting for its retry:
`cache: TTL 1h (observed); expires in 12m; pings 1/3; last miss 140k (prefix changed)`.

### Idle periods

An idle period begins when the operator's own turn ends, at session start and after `/clear`. It
resets `cache.pings`, every trigger's `times` count and the `cold` mark of a ping. The turn of a
`prompt` action is ctx-guard's own: it moves the anchor of the countdown but does not begin a
period, and `idle` keeps counting from the operator's last turn. A turn a [lift](#lifts) woke does
not begin a period either, but `idle` counts from its end. A turn after a restart's resume is real
work and begins one.

### Cache misses

`cache.miss` is read once per main-loop request. When the cache should have been warm (the
previous request, or ping, is within the TTL), it is the number of tokens the request re-wrote:
the previous request's fill less what this one read from the cache. Less than 2k tokens counts as
`0`. A miss is not counted:

- until the session has had one warm request (one that read at least 90 % of the previous fill);
  the first requests of a session re-write part of the prefix as a matter of course;
- for the first request after `/clear`, `/compact` or a resume, which writes a new prefix;
- for a request whose fill falls below half the previous one: the context started over;
- for the first request after a ping that found the cache cold.

A trigger on `cache.miss` fires on the request with the miss and re-arms on the next request
without one. A miss after a model switch is named as such in the text; any other reads `prefix
changed: CLAUDE.md, tools or MCP?`. The toast reads `ctx-guard: main: cache miss, 140k re-written
(model switch)`. A trigger on `cache.miss` raises it; the `solo` and `peers` presets carry a `cache-miss` toast at 50k.

### Keeping the cache warm

Keep-warm is off until a trigger asks for it. Two actions do it, both capped by `times`:

- **`ping`** sends one tool-less model request over the main thread's own prefix and discards the
  reply. A request that reads the prefix refreshes the cache's lifetime, so a warm ping keeps it
  alive. The trigger must hold `cache.expiresIn` in its `when`. A `cache.expiresIn` trigger
  re-arms when the time left rises above its threshold, and the first check after a warm ping is
  the next one-minute tick, when about the TTL less 90 seconds is left. Pick a threshold below
  that (under `3m30s` for a 5-minute cache) and at least `2m`; a higher one pings once. With a
  1-hour cache, pick one above `6m`: Claude Code itself compacts an idle session about 6 minutes
  before the cache expires, and a lower threshold acts after that.
- **`prompt`** submits a real turn as ctx-guard. The default text is "[ctx-guard] The user has been
  away {idle}; the prompt cache expires in {expiresIn}. Write the handoff to {handoffPath} and
  stop; do not start new work." The trigger's `message` replaces it; template variables apply. The
  `guide` skill tells the model how to answer.

```json
{
  "version": 1,
  "roles": {
    "main": {
      "triggers": [
        { "id": "warm", "when": { "cache.expiresIn": "8m", "context": "50k" }, "do": ["ping"], "times": 3 },
        { "id": "away", "when": { "cache.expiresIn": "8m", "cache.pings": 3 }, "do": ["prompt", "notify"], "times": 1 },
        { "id": "miss", "when": { "cache.miss": "50k" }, "do": ["toast"] }
      ]
    }
  }
}
```

Here, with a 1-hour TTL, `warm` pings about 52 minutes after the last request, as long as the
context is at least 50k tokens. Each warm ping moves the countdown back to an hour and counts in
`cache.pings`. After the third, `away` fires at the next 8-minute mark: it submits the handoff
prompt and sends an OS notification. The session then goes quiet; the cache expires an hour after
the prompt's turn.

**Rules for a ping:**

- It runs only with a role, a trusted repo, `autoActions` on and no pause, and not while a main-loop
  turn runs, while another ping is in flight, once the cache expired or while either usage window
  is at or above `cache.ping.maxUsage`.
- A ping is warm when it read from the cache and wrote less than a tenth of what it read. A warm
  ping adds one to `cache.pings` and moves the countdown's start to now.
- A ping that finds the cache cold stops pings for the rest of the idle period, and the band shows
  `cache cold` until the next main-loop request. The first request after it counts no miss.
- A ping that fails (an error, an empty reply, a 2-minute timeout) does not count in
  `cache.pings`. It is tried again on each idle tick while the cache is unexpired and the trigger
  holds; the trigger does not fire again for it.

**Rules for a prompt:**

- It runs only with a role, a trusted repo, `autoActions` on and no pause. While a main-loop turn
  runs it waits for the next idle tick.
- A prompt from a trigger with a cache metric in its `when` is skipped while the session is idle
  and either usage window is at or above `cache.prompt.maxUsage`. The fire counts in `times`; a
  `compact` beside it does not wait for a prompt turn, and a `ping` or another trigger's prompt in
  the same evaluation goes instead. A retry skipped this way ends, and the compact waiting behind
  it goes ahead while its trigger holds. A prompt from any other trigger, such as one on a usage
  window, is not skipped.
- A prompt that is refused (a hook of another plugin drops it, or the submit throws) is tried again
  on each idle tick while the trigger holds, up to three tries in all.
- A `prompt` and a `ping` in one evaluation run the prompt alone: its turn warms the cache. Of
  several prompts in one evaluation, the first that is not skipped goes.
- With `compact` in the same fire, the compact waits for the end of the prompt's turn. If the
  prompt gives up, the compact is dropped.

**Without approval.** In an untrusted repo, with `autoActions` off or while paused, `ping` and
`prompt` do not run; the rest of the fire does. A toast says why ("automatic actions are not
approved" for an untrusted repo). Only an untrusted repo shows `untrusted` on the band.
`/ctx-guard trust` lists each
`ping` and `prompt` trigger it approves with its `times` and, for a prompt, its text (`default`
for the default one): `prompt trigger away: times 1, prompt default`.

**Cost.** A ping reads the whole prefix at the cache-read rate, one tenth of the input rate. A
cache that expired costs a re-write at the cache-write rate: 1.25 times the input rate for the
5-minute tier, twice for the 1-hour tier.

## Subagent budgets

```json
{
  "version": 1,
  "subagents": {
    "*": { "warn": "120k", "stop": "170k" },
    "Explore": { "stop": "150k", "message": "Budget of {stop} reached: return your findings now." },
    "fork": { "warn": "off", "stop": "250k" }
  }
}
```

**Which budget.** ctx-guard learns each subagent's type and kind when it spawns (workflow agents
included), with the agent list as a fallback.

- A plain subagent uses its type's entry merged over `"*"`, or `"*"` alone.
- A fork or a teammate gets a budget only from an entry naming its type, `fork` or `teammate`
  (merged over `"*"` too). Without one it runs unbudgeted.
- An agent ctx-guard cannot name (the engine's own compaction and memory agents) runs
  unbudgeted.

**Entry keys.** A type's entry merges field by field over `"*"`: an unset or `null` field
inherits, and `"off"` drops that step.

| Key | Type | Meaning |
|---|---|---|
| `warn` | tokens or `"off"` | Past this, the subagent gets one note: wrap up and return a report soon. |
| `stop` | tokens or `"off"` | Past this, the subagent gets one stop note, and every later tool call of that subagent is refused while its fill stays past `stop`, except the tools that hand its result back (`SubagentHandback`, `StructuredOutput`, `ReportFindings`), so the report still arrives. |
| `message` | text | The stop note. Variables: `{type}`, `{tokens}`, `{warn}`, `{stop}`. Default: "context budget *stop* reached; return your final report now. Tool calls are refused, except the one that returns your report." |

Each entry needs `warn`, `stop` or `message`. After the merge over `"*"`, `warn` must be below
`stop`. Budgets take tokens only, since a subagent's model and window may differ from the main
loop's. Fill is the subagent's own input, cache-read and cache-write tokens of its latest
request.

**Behaviour.**

- Budgets apply only once the session has a role.
- A fill past both steps at once sends only the stop note.
- `blocking: false` and `/ctx-guard pause` lift the stop denies; the notes still go.
- A subagent past a step stays followed across a reload, so a reload does not lift its deny.
  ctx-guard forgets it when it completes, or after 2 hours unseen.
- The band shows `sub N!` while N subagents are past `warn`. The report lists the merged budgets
  and each followed agent.

## Trust

Some settings can run commands or prompts unattended. A repo's config needs per-repo approval
before ctx-guard acts on them.

**What needs approval:**

- `readyToken` and `stateDir`, and, for all roles, `band.probes`;
- per role: `restart.mode`, `via`, `command`, `prompt`, `peers`, `peerGap`, `selfGap`, `minContext` and `readyChecks`;
  `handoff.path`; `compact.instructions`; every trigger with a `compact`, `ping` or `prompt`
  action, or with `prompt` in its `lift.do`, including its `lift`;
- the content of every ready-check or band-probe argument that is a file under the project root (SHA-256).
  Editing such a script withdraws the approval. A command outside the root is trusted by name.
  Only files named in `run` are hashed: a module the script imports or a file it reads is not, so
  editing one keeps the approval. Keep a check or probe in one file, or name its helpers in `run`.

**Approving.** The operator types `/ctx-guard trust`. It re-reads the files and prints every
approved value, a lift prompt as `lift prompt of trigger week-60-early: lift.times 3, prompt
default`. ctx-guard keeps the approval in its own store on this machine, keyed by the project
root. A config with errors cannot be approved.

**Revoking.** Any change to an approved field or script withdraws the approval until the operator
runs `/ctx-guard trust` again. The report lists what changed (`needs approval: lead.restart,
script:.claude/ctx-guard/clean-worktree.sh`). `/ctx-guard trust off`, typed by the operator,
drops the approval outright. To stop automatic actions but keep the approval, set `restart.mode`
to `manual` or turn `autoActions` off.

**Untrusted,** notes, toasts and denies still work; they carry no more power than CLAUDE.md text.
Ready-token restarts refuse with `untrusted`; `compact`, `ping` and `prompt` actions, ready checks
and band probes do not run; and notes ask the model to tell the operator instead. Where something
needs trust (an automatic restart, a `compact`, `ping` or `prompt` trigger or a band probe), the
band shows `untrusted`, or
`untrusted (changed)` once an approval no longer matches. Where nothing does, the band shows
nothing and `/ctx-guard` reports `trust: not needed`.

## Path confinement

`configPath`, `stateDir` and `handoff.path` are relative paths under the project root:

- letters, digits and `. _ - /` only (`handoff.path` also takes `{role}`; no other placeholder);
- not absolute, no `..` that leaves the root, and not the root itself.

At run time ctx-guard follows links. A state folder, handoff, stamp or lease file that resolves
outside the root, through a symlink or a linked parent folder, refuses the restart with `error`.

## Roles

**Precedence:** command > env > default. The first source that asks for a role decides. A bad
name there gives no role and a toast; it never falls through to another source.

1. `/ctx-guard role <name|none>` typed by the operator. Typing `/ctx-guard:resume role=<name> …`
   in a session with no role claims that role too; a different role already held refuses the
   resume. A typed resume that leaves out `role=` resumes the session's own role
   (refused when it has none); one that leaves out `handoff=` or the prompt gets the role's
   `handoff.path` and `restart.prompt`. So does typing a role's own `restart.command` (`/restart-lead`), when exactly one role
   with `via: "clear"` names that command. A claim survives a hot reload.
2. The `CTX_GUARD_ROLE` environment variable, the only one ctx-guard reads. It is trimmed and
   unquoted; empty counts as unset, and `none` (any case) means no role.
3. The project's `defaultRole`, then the `defaultRole` switch.

Only interactive sessions get a role; `claude -p` sessions run with none. A name must match
`^[a-z][a-z0-9-]{0,31}$` and exist in `roles`.

**Lease.** The session holding a role writes `<stateDir>/<role>.owner` (`{sessionId,
heartbeat}`) every 5 minutes; a heartbeat older than 15 minutes is a dead session's. A second
live session with the same role gets a warning toast, and its restarts refuse with
`role-shared`. The lease is released when the session ends, and kept across `/clear`.

## userConfig switches

Set in `/config`, machine-wide.

| Switch | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` turns ctx-guard off in every project. |
| `configPath` | path | `.claude/ctx-guard.json` | The team file; the local file sits beside it as `*.local.json`. |
| `defaultRole` | string | `""` | Role when nothing else sets one. Empty for none. |
| `blocking` | boolean | `true` | `false` lifts every deny; notes and toasts go on. |
| `autoActions` | boolean | `true` | `false` stops automatic clear, compact, ping and prompt; notes then ask the model to tell the operator. |
| `noteToasts` | boolean | `true` | `false` stops the toast that shows each note sent to the model. |
| `display` | `band`, `status` or `off` | `band` | `band`: a line above the prompt where the surface has one, else status-line text. `status`: status-line text only. `off`: nothing drawn. |

The band reads like `lead · 312k (31%) · cache 8m · 5h 42% (2h10m) · wk 61% (3d4h) · sub 1! · deny Agent`.
The cache countdown follows the context figure ([Prompt cache](#prompt-cache)). Band probes follow the usage windows, then `untrusted` while settings that need trust wait for it.

## The `/ctx-guard` command

| Subcommand | Typed by | Does |
|---|---|---|
| *(none)* | anyone | Report: role and its source, config files and errors, effective config, metrics, marks, live denies, band probes, trust, handoff age, lease, last verdict, self gap (`selfGap` and the time left before the ready token is no longer `too-soon`). |
| `role <name\|none>` | operator | Sets this session's role. |
| `check` | operator | Dry-runs the restart verdict. |
| `trust` | operator | Approves the repo's restart, ready-check, compact, ping, prompt and band-probe settings. |
| `trust off` | operator | Withdraws that approval. |
| `reload` | anyone | Re-reads the config files. |
| `pause [30m\|off]` | operator | Lifts denies and automatic actions for a while (default 30 min); notes go on. `off` ends the pause. |
| `init [solo\|peers]` | operator | Copies the preset `assets/presets/<name>.json` to `configPath` if no file is there (never overwrites), and adds the local file and `stateDir` to `.gitignore`. Default `solo`. When the preset restarts or compacts on its own, the reply says to review it and run `/ctx-guard trust`. |

"Operator" means typed in the prompt box. ctx-guard refuses these subcommands from the model or
another plugin.

## Recipes

Recipes use generic role names; rename them to fit your project.

### Solo session

One long-running session, role `main`. `assets/presets/solo.json` spells out the built-in ladder:
notes at 40 / 60 / 75 % (then every 5 %), usage notes at 80 / 90 %, an early brake that denies
`Agent` and `Workflow` while the weekly window is at 80 % with two days or more to its reset (90 %
with one day or more), and a brake at 95 % that also denies `WebSearch` and `WebFetch`; each brake
notes and notifies when it lifts. It adds a toast for a prompt cache miss of 50k tokens or more. The
handoff goes to `.ctx-guard/main-handoff.md`, with automatic clear and resume, and
`restart.minContext: "40%"` refuses the ready token below the first context note. `/ctx-guard init`
writes it to `.claude/ctx-guard.json`; review it, then run `/ctx-guard trust`.

### Coordinator and workers

One long-lived coordinator dispatches subagents. Budgets keep each worker small, and the
coordinator stops dispatching near the usage limit.

```json
{
  "version": 1,
  "defaultRole": "coordinator",
  "roles": {
    "coordinator": {
      "description": "plans the work, dispatches subagents and reviews their results",
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-hard", "when": { "context": "60%" }, "do": ["note"], "level": "hard" },
        { "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note", "toast"], "level": "stop" },
        { "id": "usage-hard", "when": { "limit.any": 85 }, "do": ["note"], "level": "hard" },
        { "id": "usage-brake", "when": { "limit.any": 95 }, "do": ["note", "notify", { "deny": ["Agent", "Workflow"] }], "level": "stop" }
      ],
      "handoff": {
        "instructions": "Rewrite the whole file. Header: when it was written and the git HEAD, if this is a git repo. Sections: Goal, Dispatched work and results, Next action."
      },
      "restart": { "mode": "auto", "prompt": "Carry out Next action without waiting." }
    }
  },
  "subagents": {
    "*": { "warn": "120k", "stop": "170k" },
    "Explore": { "warn": "100k", "stop": "150k", "message": "Budget of {stop} reached: return your findings now." }
  }
}
```

### Peer sessions

Two or more long-lived interactive sessions that message each other by name.
`assets/presets/peers.json` (`/ctx-guard init peers`) defines `lead` and `reviewer`:

- shared triggers, handoff and restart settings in `defaults`;
- `restart.peers` and `peerGap: "10m"`, so the two never clear within ten minutes of each other;
- a brake at 95 % that notes and notifies when it lifts;
- a `notes.suffix` per role telling the session to message its peer before it stops;
- subagent budgets.

Start each session with its role and a name the other can address:

```sh
CTX_GUARD_ROLE=lead claude --name lead
CTX_GUARD_ROLE=reviewer claude --name reviewer
```

Or type `/ctx-guard role reviewer` in a running session.

### Compact instead of clear

The session keeps its context, compacted, instead of starting over from a handoff.

```json
{
  "version": 1,
  "defaultRole": "main",
  "roles": {
    "main": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "50%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-stop", "when": { "context": "70%" }, "do": ["note"], "level": "stop" },
        { "id": "squeeze", "when": { "context": "85%" }, "do": ["compact"] }
      ],
      "restart": { "mode": "auto", "via": "compact" },
      "compact": { "instructions": "Keep open tasks, decisions made, and the file paths in play." }
    }
  }
}
```

The notes ask for the ready token; `squeeze` compacts anyway at 85 % if the model has not.

### A usage-limit brake

Notes as the usage windows fill, a desktop notification near the weekly limit, and no new
subagents past 95 %. `triggers` replaces the built-in ladder, so the context triggers are listed
again.

```json
{
  "version": 1,
  "roles": {
    "main": {
      "triggers": [
        { "id": "ctx-soft", "when": { "context": "40%" }, "do": ["note"], "level": "soft" },
        { "id": "ctx-hard", "when": { "context": "60%" }, "do": ["note"], "level": "hard" },
        { "id": "ctx-stop", "when": { "context": "75%", "every": "5%" }, "do": ["note"], "level": "stop" },
        { "id": "five-hour", "when": { "limit.five_hour": 80 }, "do": ["note", "toast"], "level": "soft" },
        { "id": "weekly", "when": { "limit.seven_day": 90 }, "do": ["note", "notify"], "level": "hard" },
        { "id": "brake", "when": { "limit.any": 95 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "stop" },
        { "id": "spend", "when": { "cost": "$25" }, "do": ["toast"] },
        { "id": "idle-cache", "when": { "idle": "50m", "context": "150k" }, "do": ["notify"] }
      ]
    }
  }
}
```

`idle-cache` reminds you that a large context left idle will be re-read at full price. To keep
the cache warm, see [Prompt cache](#prompt-cache).

### An early-spend brake

A weekly window spent fast early on leaves days with little to work with. This brake stops new
subagents sooner the earlier the window fills: at 80 % with two days or more to the reset, at
90 % with one day or more, and at 95 % at any time. The 5-hour window gets a plain brake at 95 %.
Only the `deny` triggers are shown; they replace the built-in ladder, so list your context
triggers too.

```json
{
  "version": 1,
  "roles": {
    "main": {
      "triggers": [
        { "id": "week-80-early", "when": { "limit.seven_day": 80, "limit.seven_day.resetsIn": "2d" }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard" },
        { "id": "week-90-early", "when": { "limit.seven_day": 90, "limit.seven_day.resetsIn": "1d" }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard" },
        { "id": "week-95", "when": { "limit.seven_day": 95 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "stop" },
        { "id": "five-hour-95", "when": { "limit.five_hour": 95 }, "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "stop" }
      ]
    }
  }
}
```

These are the built-in ladder's own early brakes plus a 5-hour one. The early triggers lift by
themselves once the reset is close enough: at 85 % with 30 hours
left, `week-80-early` has stopped holding (under two days) and `week-90-early` has not started
(under 90 %), so subagents run again. A window that reports no reset time leaves the early
triggers unknown, so they deny nothing; `week-95` still applies.

A session whose work needs subagents ends its turn under the brake and waits. To have it carry on
when the brake lifts, add a `lift` to each brake:

```jsonc
{ "id": "week-80-early", …, "lift": { "do": ["note", "notify"] } }
```

tells the model (if it is working) and the operator. For an unattended run, let the lift wake the
session:

```jsonc
{ "id": "week-80-early", …, "lift": { "do": ["note", "prompt"], "times": 3 } }
```

A wake goes only when the brake touched the work (a refused `Agent` call, or its note read) and
the operator has not spoken since; it first reads fresh usage with one request over the session's
context, then starts a turn: both spend usage. Put it on every brake that denies the same tools,
since a lift waits for the last of them. The note can say when the brake lifts: `"message": "With
{resetsIn} still to the weekly reset, start no new subagents; they are back in {liftsIn}."` See
[Lifts](#lifts).

### A personal override

`.claude/ctx-guard.local.json` changes the team file for you alone. This one keeps restarts
manual for `lead` and drops the team's note suffix:

```json
{
  "version": 1,
  "roles": {
    "lead": {
      "notes": { "suffix": null },
      "restart": { "mode": "manual" }
    }
  }
}
```
