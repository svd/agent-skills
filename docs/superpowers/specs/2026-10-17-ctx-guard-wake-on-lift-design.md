# ctx-guard: wake the session when a brake lifts — proposal

Date: 2026-10-17 · Plugin: `plugins/ctx-guard` (0.3.1 released; this would land in `[Unreleased]`)

## Problem

A trigger with a `deny` is a brake. An early-spend brake such as

```jsonc
{ "id": "week-60-early",
  "when": { "limit.seven_day": 60, "limit.seven_day.resetsIn": "4d" },
  "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard",
  "message": "With {resetsIn} still to the weekly reset, start no new subagents so the rest of the window lasts; do small steps in this session." }
```

lifts by itself: once less than four days remain, the condition stops holding and the next
`Agent` call goes through. That pacing works as intended.

What is missing is the other half. ctx-guard acts on a rising edge (the note) but does nothing on
the falling edge. A session whose work needs subagents ends its turn under the brake and then sits
idle. Nobody tells it the brake has lifted, so it waits until the operator types "go on", which
can be hours after the lift, or never during an unattended run.

## What ctx-guard already has

Read from `hooks/triggers.ts`, `hooks/register.tsx` and the config reference:

- **Denies are level-triggered.** `liveDenies(triggers, metrics, { blocking, paused })` gives the
  deny set on each tool call, empty while paused or with `blocking` off; an unknown metric denies
  nothing. `deniedBy` names the first trigger in config order that blocks a tool.
- **Edge actions use marks.** A trigger's mark clears when its condition stops holding (a
  percent drops below its threshold, a `.resetsIn` passes); the trigger re-arms then. Nothing
  runs at that moment.
- **Evaluation** runs on `session.measure`, on a step whose fill crosses a context gate, and on a
  one-minute timer (it is how `idle` and `cache.expiresIn` fire). `triggerHolds` answers true,
  false, or null when a metric is unknown.
- **Notes** are appended to the transcript as user messages; the model reads one on its next
  request.
- **`prompt`** submits a real turn through `submitOwnPrompt`, gated by `/ctx-guard trust`,
  `autoActions` and no pause; a gated prompt is skipped with a one-time notice. A refused or
  put-off prompt waits in `mod.retry`, tried on idle ticks while its trigger holds. Its turn does
  not start a new idle period, and the `idle` clock keeps running through it.
- **Prompt origins.** The `prompt.submit` and `command.run` hooks see each input's origin
  (`composer`, `bridge`, `sdk`, `peer`, `scheduled-trigger`, `task-notification`, `plugin`, …).
  ctx-guard tells its own prompts from others (`isOwnPrompt`, and the own-prompt flag for one
  raised beneath its own hook call, which its hook does not see).
- **Automatic actions that wait.** A compact queued by the same fire as a prompt waits for that
  prompt's turn (`mod.retry`); a queued compact that finds the session busy is tried again at
  the next main turn end; a ping waits for a free fork slot (`mod.pinging`).
- **`$.state`** is kept by the host for the session and survives a hot reload; ctx-guard writes
  its memory back after a `/clear`. A `--resume` starts from an empty state.
- **Usage figures are those of the last response.** `session.measure` reports "the rate-limit
  windows the last response reported". While the session is idle no response arrives, so after a
  window resets its `percentUsed` stays at the old figure; `resetsInMs` clamps a past reset to 0.

The last point matters for wake: a `.resetsIn` brake lifts on the timer (time passes), but a
percent-only brake such as `limit-stop` (`limit.any` ≥ 95 %) never lifts while idle, because the
stale 95 % keeps holding after the window has in fact reset.

## Proposal

### 1. Holds and lifts

ctx-guard keeps a **hold** for each trigger that has a `lift` block (section 2) while its
condition holds. A hold is judged from the trigger's `when` alone, so a pause neither ends a hold
nor starts one; the pause only suspends the deny on the call path, as today.

On every evaluation, for each trigger with `lift`:

- **Condition known true** (every metric known, every condition met): a hold starts if there is
  none; an existing hold goes on.
- **Condition known false** (at least one condition known false, whatever the others read): the
  trigger's brake lets go. The hold **lifts** once none of its deny tools is denied by another
  trigger of the role whose condition is known true, the same rule the call path applies. Until
  then the hold *waits*; it lifts when the last of its tools comes free, and goes back to holding
  if its own condition holds again first.
- **Otherwise** (some metric unknown, none known false): nothing changes. A dropped usage report
  neither ends a hold nor wakes the session.

A lift frees all of its trigger's deny tools at once. With `week-60-early` and `week-70-early`
both holding, the 60 % brake letting go waits for the 70 % one; the session hears of a lift only
when `Agent` is usable.

**These are not lifts.** The hold is dropped with no lift action when:

- a reload removes the trigger, its `lift`, or changes its `when` or its deny tools;
- `blocking` is off (no hold starts while it stays off);
- the role changes (all holds go).

**A lift that runs its actions clears the trigger's mark**, so if the condition holds again
later, the trigger fires its rising edge (its note) as for any new crossing. When the lift ran on
estimated figures (section 5) and the first reported figures after it show the condition holding,
that rising edge does not count in the trigger's `times`: it corrects the lift.

**Several lifts in one evaluation.** If one of them makes a wake attempt (section 3), all of that
evaluation's lifts wait for the one lift check (section 6), which re-evaluates every one: those
still free lift and run their actions, those held again do not. Otherwise they all run at once on
the figures at hand. Their notes go out as one appended message and their notifications as one
`notify`, as rising-edge actions do. At most one prompt goes (section 3).

### 2. A `lift` block on the trigger

```jsonc
{ "id": "week-60-early",
  "when": { "limit.seven_day": 60, "limit.seven_day.resetsIn": "4d" },
  "do": ["note", { "deny": ["Agent", "Workflow"] }], "level": "hard",
  "message": "…",
  "lift": { "do": ["note", "prompt"], "times": 3 } }
```

| Key | Required | Meaning |
|---|---|---|
| `lift.do` | yes | Actions run when the hold lifts: `note`, `toast`, `notify`, `prompt`. |
| `lift.times` | with `prompt` | A whole number of at least 1: the most wake attempts (section 3) of this trigger between two operator inputs. |
| `lift.message` | no | Text for the lift note and the wake prompt, in place of the defaults below; template variables as for `message` (`{id}` and `{tools}` among them), plus `{liftReason}`, which only lift texts have. |

Lift variables:

| Variable | Example | Meaning |
|---|---|---|
| `{id}` | `limit-stop` | The trigger that lifted. |
| `{tools}` | `Agent, Workflow` | The trigger's deny tools, all free now. |
| `{liftReason}` | `the 5-hour usage window reset` | The condition that let go: `the 5-hour usage window reset` or `the weekly usage window reset` for a window past its reset (section 5); `weekly usage is below 60 %` for a reported percent; `the weekly reset is less than 4d away` for a `.resetsIn` condition; `its condition no longer holds` for any other metric. For `limit.any` it names the window that held the brake. |

`{limit}` reads the window's percent, which after a reset is an estimate (section 5); the default
texts leave it out.

`lift` is valid only on a trigger whose `do` has a `deny`. The actions are the ones the operator
picks between:

| Choice | `lift.do` | Effect |
|---|---|---|
| Tell the operator | `["notify"]` (or `toast`) | OS notification; the operator decides whether to say "go on". Works untrusted. |
| Tell the model | `["note"]` | The model reads it on its next request. Useful mid-turn; an idle session still waits. |
| Wake the model | `["prompt"]` | Submits a turn so an idle session resumes on its own. Needs trust, `autoActions` and no pause; when it cannot run, the operator gets a `notify` (section 3). |

A lift without `prompt` runs its actions on the figures at hand, with no lift check: after a long
wait those may be an estimate (section 5), and the config reference says so. Only a lift that
would wake the session pays for fresh figures.

Default texts:

| Text | Default |
|---|---|
| Lift note | `[ctx-guard] Trigger "{id}" has lifted: {liftReason}. {tools} are allowed again.` |
| Wake prompt | `[ctx-guard] Trigger "{id}" has lifted: {liftReason}. {tools} are allowed again. You paused your work because of it. Time has passed since then, so first check where the work stands (task list, git status, the handoff if you wrote one), before you start any subagent. Then carry on with the work you paused. If nothing is left to do, say so in one line and stop.` |
| Toast and `notify` | `ctx-guard: "{id}" lifted ({liftReason}); {tools} allowed again.` |
| `notify` for a wake that did not run | The toast text plus `Not woken: <why>.`, `<why>` one of `the repo is not trusted`, `autoActions is off`, `ctx-guard is paused`, `lift.times is spent`, `the prompt was refused`. |
| `notify` after failed checks | `ctx-guard: "{id}" may have lifted, but fresh usage could not be read (the window may still be full). Not woken; ctx-guard tries again when usage is next reported or the window resets.` |

When the wake prompt goes, the lift note is not appended: the prompt carries the same text.

- The wake prompt asks for a check first because hours or days may lie between the pause and the
  wake: the session may have been compacted, and other sessions may have committed.
- The way out ("say so in one line and stop") keeps a wake with nothing to do cheap and keeps the
  model from inventing work.
- If fresh figures brake the session again on its first request, the trigger's rising edge (its
  mark was cleared by the lift) and its deny say so; the prompt does not mention it.

### 3. When `prompt` wakes the session

A lift whose `lift.do` has `prompt` is judged in this order on the evaluation that finds it
(a measure or a timer tick alike) and again on each idle tick while it waits; the first rule that
stops it decides what happens. Until it is decided, its hold stays, in the phase *lifting*; a
lift that rule 5 holds back keeps its non-prompt actions with it when rules 1–4 passed, and runs
them at once otherwise.

1. **The brake touched the work.** During this hold a call to one of its tools was refused (by
   any trigger), or the trigger's note was read (a main step started after the note was
   appended); and a main turn ended after that. A session that finished its task before the
   brake fired, or never reached for a denied tool, is not woken: the prompt is dropped, with no
   `notify`, and the lift's other actions run as usual. A `/clear` that is not operator input
   (ctx-guard's own restart) starts a context the brake never touched: it drops each hold's touch
   and note stamps, and a pending wake prompt.
2. **No operator input after the last touch.** Operator input is a prompt or command the
   `prompt.submit` or `command.run` hook sees with origin `composer`, `bridge`, `sdk`, `peer`,
   `coordinator`, `channel` or `slack-ping`, whether it starts a turn or is delivered into a
   running one. `/ctx-guard` and its subcommands do not count; `/ctx-guard:resume` typed by the
   operator does. Every other origin (`plugin`, `peer-send-message`, `task-notification`,
   `scheduled-trigger`, `auto-continuation`, `observer`, `observer-activity`, `projects-relay`,
   `unclassified`) is not operator input, nor is a prompt ctx-guard submits itself. The input
   that hit the brake comes before the touch, so "go on" → refused → turn ends → operator away
   still wakes. `peer` counts because another session's message is an instruction, as from a
   lead to its worker. If the operator spoke after the last touch, they are steering: the prompt is
   dropped, a toast says the brake lifted, and the lift note goes on their next turn even when
   `lift.do` has no `note`.
3. **Gates.** If the repo is untrusted, `autoActions` is off or ctx-guard is paused, the prompt
   becomes a `notify` with its reason and the lift runs as one without `prompt`. This counts no
   attempt. A trigger's own `prompt` held back by these gates is skipped with a one-time notice; a
   lift sends a `notify` because the lift is the moment the operator needs to know.
4. **`lift.times`.** Past it, the lift runs as one without `prompt` (on the figures at hand, no
   check) and its `notify` says `lift.times is spent`.
5. **Idle.** No main turn runs and no lift work is held back (see "Lift work and other
   automatic actions" below). Otherwise the lift waits for the next idle tick and is judged
   again from rule 1.
6. **The tools are still free on fresh figures**, read by the lift check (section 6). This is
   the **wake attempt**: the lift waits for the check, with every other lift of its evaluation
   (section 1).

A `notify` already in `lift.do` is sent once. When a brake holds on fresh figures there is no
`notify`: nothing was freed. When a prompt goes, the "Not woken" notifies of other lifts in the
same evaluation are dropped.

**Which trigger the attempt is charged to.** Before the fork, ctx-guard picks the first lifting
trigger in config order whose prompt passed rules 1–5. That trigger counts the attempt, whatever
the check finds. After the check, the prompt goes from it if its tools are free, else from the
first other lifting trigger that passed rules 1–5 and is free; that one counts nothing. The other
lifts' prompts are dropped and count nothing.

**Counting.** `lift.times` caps a trigger's wake attempts between two operator inputs; the count
resets on operator input. An attempt counts once, whether its prompt went (or was refused three
times), a brake held on fresh figures, or the check's three tries failed. A trigger's own `times`
does not count wake attempts, and `lift.times` does not count the trigger's rising-edge fires.

**A lift seen while a main turn runs** has figures from that turn's own responses, so it runs
its non-prompt actions at once, with no check, and clears the mark. Its prompt stays pending and
is dropped when, before the turn ends, the model reads the lift note or a call to one of the
freed tools goes through: the model already knows. Otherwise it is judged at the next idle tick
under rules 1–6.

**The lift note while a prompt is pending.** A lift whose prompt is pending after the check (see
below) withholds its note: the prompt carries the same text. If the pending prompt is dropped
while the tools are still free (operator input, a freed tool used), the note is appended then. If
fresh figures brake the session again before the prompt goes, nothing is appended: no lift
happened, and the trigger's rising edge says so if its mark was cleared.

**After the check.** If operator input came while the fork ran, rule 2 applies. If another main
turn started, the prompt waits for the next idle tick, with no new fork and no new count; it is
then sent only if the tools are still free on the current figures. A call to one of the freed
tools that goes through in that turn drops the prompt, and the withheld note is appended. The
gates are read again too; a gate now closed sends its `notify`.

**A refused submit** (a hook's `drop`, or a throw) is retried on idle ticks, up to three tries in
all, while rules 1–3 hold and the tools stay free on the current figures, with the same text and
no new fork or count. After the last try the operator gets the `notify` with
`the prompt was refused`.

**Lift work and other automatic actions.** *Lift work* is a lift check, or a lift prompt that is
pending or waiting for its retry. It does not overlap ctx-guard's other automatic actions; among
those, the existing rules stand.

- Lift work is held back while a trigger prompt waits in `mod.retry`, a ping holds the fork slot,
  a compact or a ctx-guard restart is running, or a compact is queued for the end of the current
  turn. At a main turn end the queued compact is tried first; if it stays queued because the
  session is busy, lift work goes ahead, since the compact's next try comes at the next turn
  end. So the woken turn does not run on the context that called for a compact, and a busy
  compact cannot stall the wake.
- A trigger prompt, a ping or a compact that arises while lift work is under way waits for the
  next idle tick (a compact, for the next turn end).
- The lift prompt and its retry keep their own slot beside `mod.retry`, so neither displaces the
  other. A lift prompt refused three times drops a compact that waited behind its turn, as a
  trigger prompt's does today.

**The woken turn** does not start a new idle period: trigger `times`, `lastMainEndAt` and the
cache's period go on, as for any ctx-guard prompt. Unlike a trigger's prompt, it counts as
activity for the `idle` metric: `idle` does not grow during the woken turn and counts from its
end, so an `idle` trigger measures the quiet after the woken work; a trigger prompt's turn keeps
today's rule. Its end also counts as "a main turn ended" for rule 1, so a woken turn that hits
the brake again can be woken again. This needs three `Activity` fields (State).

### 4. Tell the model when the brake will lift, and whether it will be woken

The model needs this to choose between working around the brake and stopping cleanly.

- New template variable `{liftsIn}`: for a trigger with a `.resetsIn` condition, the time until
  that condition stops holding (`resetsIn − threshold`; 4d5h left against `"4d"` gives `5h`); for
  a percent-only limit trigger, the time until the window reads as rolled over, a minute past its
  reset (section 5; for `limit.any`, the latest among the windows at or over the threshold);
  `unknown` otherwise.
- A refused call's deny reason names when the tool comes free: the latest `{liftsIn}` among all
  triggers that deny the tool and hold (`unknown` if any is unknown), since the tool is free only
  when the last of them lets go.
- The reason gains "ctx-guard is set to prompt you when the tool comes free" when one of those
  triggers has `prompt` in `lift.do`, the repo is trusted, `autoActions` is on, ctx-guard is not
  paused and that trigger's `lift.times` is not spent. The refusal is itself a touch, so
  section 3's rules 1 and 2 are met for this turn.
- The trigger's note, which today carries no lift time, can use `{liftsIn}`.
- The guide skill's "When a tool is blocked" section adds: if the remaining work needs the denied
  tool and ctx-guard says it is set to prompt you, record where you stopped, say so in one line
  and end the turn; do not poll, sleep or set your own timer. If the operator speaks first, or
  fresh usage shows the window still full, no prompt comes.

### 5. Treat a passed reset as a reset

To let percent-only brakes lift while idle, `limitsFrom` takes `now` and reads a window whose
`resetsAt` is a minute or more in the past (`ROLL_OVER_GRACE_MS`, so clock skew or a reset time
rounded down does not turn a fresh 97 % into 0 %) as rolled over: `pct: 0`, `resetsAt: null` (so its `.resetsIn` is
unknown), marked as an estimate, until the next response reports fresh figures. This also stops
`/ctx-guard` and the band from showing a stale 95 % after the reset. Without it, `lift` on
`limit-stop` or on any five-hour brake would never fire while idle, which is the case where
waking helps most.

Rolled-over figures are an estimate, and two rules follow:

- **They do not clear marks.** A percent mark clears only on a reported figure below its
  threshold, or when a lift runs (section 1). A check that finds the window full again keeps the
  mark, so the trigger does not fire its note again for what is still one hold.
- **They change the call path for every trigger, with or without `lift`.** Once a window's reset
  time passes, a percent brake on it stops denying until the next response reports figures; the
  first request after a reset is judged on 0 %, and if the window is in fact full its response
  brakes the session again from the next request. The same 0 % feeds `cache.ping.maxUsage` and
  `cache.prompt.maxUsage`, so keep-warm pings and cache prompts may run again after a reset until
  fresh figures arrive. The CHANGELOG lists both under Changed.

### 6. Fresh figures before a wake

While a session waits, its usage figures are those of its own last response. Other sessions on
the same account (with or without ctx-guard, on any machine, on claude.ai) keep spending.
Example: a session stops at 80 % of the weekly window with two days left, under a brake that
lifts one day before the reset. By then other sessions have taken the window to 95 %. On its own
figures the brake lifts, and a wake would be for nothing.

So before a wake, ctx-guard reads fresh figures with a fork, the *lift check*. While it runs, the
holds it covers are *checking*: other evaluations (a tick, the fork's own `session.measure`)
neither start a second check nor run their lifts.

**Tries and the charged attempt.** When a try starts, before the fork, ctx-guard writes to
`$.state` the hold's `tries` (one more) and, on the first try, the charged trigger's attempt
count (one more). `tries` above 0 means the attempt is already charged: a later try of the same
check counts nothing. `tries` goes back to 0 when a check answers (free or held), when a stall
is left, and when the hold ends. The hold's *stamps* are its start time, the time of its last
touch and the time its note was appended; a check and a stall keep them.

**Reloads and timeouts.** The checking phase lives in memory, and the fork's start time is written
to `$.state` (`forkAt`). A hot reload or `/clear` during the fork drops the fork's answer; the holds
are read back as *lifting*, with the `tries` already written, so the interrupted fork is one failed
try and the next idle tick judges them again from rule 1 as the same attempt (after a `/clear` that
is not the operator's, rule 1 finds them untouched). A new module copy starts no fork until the
2-minute timeout has passed since `forkAt`, so a reload never runs two forks at once. A keep-warm
ping writes its fork's start the same way (`pingAt` in the cache state), and a new module copy
starts no lift check beside it until it settles or the ping's 2-minute timeout passes. A fork that
has not answered by the timeout is a failed try, but it holds the slot until it settles or 4 minutes
have passed since it began (twice the timeout), when it counts as gone: the next try waits until
then, and its late answer is ignored. A keep-warm ping's fork holds its slot by the same bound.

1. **Fork.** `$.model.fork({ prompt: "Reply with OK." })`, the request a `ping` sends. Once it
   resolves, ctx-guard reads `$.session.usage()`, which now holds the account's current windows
   (`session.measure` fires only when a window moved a whole point, so it may not come).
2. **Evaluate again** on those figures: every lifting trigger and every other trigger that denies
   one of their tools. A trigger whose tools are free lifts: its actions run and the prompt is
   sent. One on which a brake holds does not lift: the hold goes on with its stamps, no lift
   action runs, and the next time its condition lets go is a new lift.
3. **The fork fails** (an API error, an empty reply, `nothing-to-fork`, the 2-minute timeout):
   no prompt now. A failure here may be the limit itself (a full window answers with an error),
   and a prompt would fail the same way. If `$.session.usage()` changed with the failure (an
   error response can carry rate-limit figures), step 2 runs on those figures. Otherwise the
   check is tried again on each idle tick while the hold still lets go on the current figures,
   up to three tries in all. After the third the operator gets the failed-checks `notify`, and
   the hold becomes *stalled*: it keeps its stamps and does not let go again until the figures
   change (a response or `session.measure` reports usage) or the earliest reset among all
   known windows passes, whichever comes first; a window read as rolled over resets again one
   window length after it rolled over. The window that failed the fork may not be the
   hold's own: a full five-hour window can fail the check of a weekly brake. Leaving the stall
   is judged from rule 1 as a new attempt. Only the lifts that would prompt stall; the other
   lifts that waited for the same check run on the figures at hand, as lifts without `prompt`
   do (section 2).

After `--resume` the session starts with no holds and no figures; every limit metric is unknown
until the first response, and holds start from there. The operator who resumed the session is
at the keyboard.

**Rules for the lift check.** It shares the fork call, its prompt, its timeout and the
one-request-at-a-time slot with `ping`, and none of the ping's guards or accounting:

- It ignores `cache.ping.maxUsage` and `cache.prompt.maxUsage`. Those stop spending to keep a
  cache warm near a limit; the lift check reads the limit, and the lifts that matter most come
  near one (`week-90-early` lifts by time while the weekly window is still at 90 % or more).
- It runs with the cache expired or the idle period marked cold, which after a long wait is the
  usual case; the ping skips both.
- It leaves the cache state as it found it: it does not count in `cache.pings`, take the ping's
  retry slot, move the countdown's anchor or change `cold`. After a long wait the cache was
  expired or cold before the check and stays so, so a brake that holds on fresh figures brings
  no band countdown, no `cache.expiresIn` warning and no keep-warm ping back to the waiting
  session. When the prompt goes, its own main-loop request restarts the countdown, as any main
  request does; it reads the prefix the fork wrote, so it counts no miss.
- It runs only for a wake attempt (section 3, rules 1–5 passed), with a role.

What the fork costs: it resends the main thread's prefix. After hours of waiting the cache has
expired, so the fork writes the whole context into it, as the wake's own first request would.
When the tools are still free, the wake that follows reads that cache warm, so fork and wake
together cost about one cold request. When a brake holds again, the fork is the whole cost and
no turn runs.

**Spikes (2026-10-18, Claude Code 2.1.300, throwaway mods):**

- `$.model.fork` brings fresh figures. Session A read `five_hour` 11 % after its main turn and
  held its `turn.complete` hook open (`claude -p --input-format stream-json`, since plain `-p`
  ends a hook about a minute after the answer). Session B then spent the window to 12 %. A's
  figures still read 11 %; A forked (`Reply with OK.`: 13 input, 4 output, 14.9k cache read,
  16.4k cache write), `session.measure` fired with `changed: ["rateLimits", "cost"]`, and the
  figures read 13 % (B and other sessions together).
- A fork before the session's first main response, also after `--resume`, answers
  `nothing-to-fork`.

The wake prompt asks the model to check where the work stands before it starts any subagent: the
figures are fresh, but the work may have moved while the session waited.

**Disclosure.** The directory's security scan looks for behaviour a plugin does not disclose
(https://claude.com/docs/plugins/pre-submission-checklist). The README, `docs/configuration.md`
and the config reference state that a lift `prompt` first sends one model request over the
session's context to read fresh usage, then starts a turn on its own; both spend usage.

### 7. Built-ins and presets

- Built-in `week-80-early`, `week-90-early` and `limit-stop` get `"lift": { "do": ["note"] }`:
  it costs nothing and tells a working model the tools are back.
- The presets add `"lift": { "do": ["note", "notify"] }` to their brakes, with `prompt` shown in
  the config reference's early-spend recipe as the unattended option, since it spends usage on
  its own.

## State

A new `$.state` key `lifts`, written like `marks`:

- `holds`: per trigger id, the deny tools, the stamps (start, last touch, note appended), its
  phase (holding, waiting, lifting, stalled; *checking* is kept in memory only, section 6), the
  check's `tries`, and for a stalled hold the figures' report time and the earliest reset it
  waits for. A lift seen mid-turn keeps its hold, in the phase *lifting*, while its prompt is
  pending, so rules 1–6 have the tools and stamps at the next idle tick.
- `estimatedLift`: per trigger id, set when its lift ran on estimated figures and cleared by the
  first reported figures, for the `times` rule of section 1.
- `forkAt`: the start time of the fork in flight, or null.
- `attempts`: per trigger id, the wake attempts since the last operator input.
- `pending`: the lift prompt waiting for an idle tick or a retry: its trigger id, its text, the
  submit tries, and the time of the lift for the mid-turn rule (section 3).
- `operatorAt`: the time of the last operator input.

It is kept over a hot reload and over `/clear`, and dropped on a role change; a `--resume` starts
without it (section 6). An operator's `/clear` is operator input (section 3, rule 2); the
`/clear` of ctx-guard's own restart is its own and is not; it drops the holds' touch and note
stamps and `pending` (section 3, rule 1).

`Activity` (in `types/index.d.ts`) gains three fields for the woken turn (section 3), beside
`ownTurn`, which keeps its meaning (the running main turn is ctx-guard's own):

- `wokenTurn`: the running own turn is a lift wake;
- `lastWokenEndAt`: the end of the last woken turn. `idle` counts from the later of
  `lastMainEndAt` and `lastWokenEndAt`, and does not grow while a woken turn runs; a trigger
  prompt's turn moves neither;
- `lastTurnEndAt`: the end of the last main turn of any kind, which rule 1's "a main turn ended
  after that" reads.

`lastMainEndAt` keeps its meaning, so the ready-token checks are unchanged.

## Validation

- `lift` on a trigger without a `deny`: error ("lift needs a deny to lift").
- `lift.do` empty, or holding `deny`, `compact` or `ping`: error.
- `lift.message` empty or whitespace: error, as for `message`.
- `prompt` in `lift.do` without `lift.times`, or `lift.times` not a whole number of at least 1:
  error. `lift.times` without `prompt`: error.
- Trust: `trustMaterial` counts a trigger whose `lift.do` has `prompt` among the auto triggers.
  `trustedTrigger` adds `lift` to the hashed trigger only when it is set, as it does for `times`,
  so approvals given before `lift` existed still match. Adding or editing any `lift` on a
  trigger in the trust material (one with `compact`, `ping` or `prompt` in `do`, or `prompt` in
  `lift.do`) needs a fresh `/ctx-guard trust`.
- Schema: `skills/guide/assets/ctx-guard.schema.json` gains `lift`.

## Code layout

- `types/index.d.ts`: `lift` on `Trigger`; the `lifts` state key in the `PluginState` contract;
  `Activity.wokenTurn`, `Activity.lastWokenEndAt` and `Activity.lastTurnEndAt` (State).
- `triggers.ts`: an `estimated` flag on `LimitReading`; `limitsFrom(rateLimits, now)`;
  `whenState(trigger, metrics)` (true, false when any condition is known false, null otherwise);
  `stepHolds(holds, triggers, metrics, now)` → next holds and lifts (pure); marks kept on
  estimated figures and cleared by a lift; `liftsInMs(trigger, metrics)` and the per-tool latest
  lift time.
- `config.ts`: `lift` in `TRIGGER_KEYS`, parse and validate it; built-ins; `trustMaterial` and
  `trustedTrigger` as in Validation.
- `messages.ts`: the default texts of section 2, `{tools}`, `{id}`, `{liftReason}`, `{liftsIn}`
  (`TEMPLATE_VARS` and `templateVars`, which gain the trigger), the deny reason's lift time and
  tail.
- `register.tsx`: holds and lifts on each evaluation; the touch (from a refusal, and from a main
  step after the note); operator input from the `prompt.submit` and `command.run` origins; the
  rules of section 3 in order, the charged trigger and the count; the mid-turn pending prompt and
  the withheld note; the lift check through the ping's call, timeout and slot but not
  `pingSkipped` or `onPing`, the in-memory checking phase, then `$.session.usage()` and a second
  evaluation; the stalled phase; the re-check after the fork; `submitOwnPrompt` with its own
  retry slot; one automatic action at a time (trigger prompts, compacts and pings also wait
  behind a lift check or a pending lift prompt); dropping holds on reload, `blocking` off and
  role change; the woken turn's activity for `idle`.
- `skills/guide/SKILL.md`, `references/config-reference.md`, `docs/configuration.md`,
  `docs/use-cases.md` (the early-spend recipe), README feature list, CHANGELOG `[Unreleased]`.
- `register.test.ts`: update `PRESET_TEXT` if the presets change.

## Tests

Holds and lifts:

- Stacked brakes: 60 % lets go while 70 % holds → the 60 % hold waits, no lift; 70 % lets go →
  both lift in one evaluation, one note message, one lift check, one prompt (the first in config
  order), one attempt counted.
- Stacked brakes with `lift` only on `week-60-early`: 60 % lets go first, 70 % later → 60 %'s lift
  fires when 70 % lets go.
- A waiting hold whose condition holds again → back to holding, no lift.
- Another trigger on the same tool with an unknown metric → does not hold the lift back.
- `limit-stop` lets go while `week-90-early` still denies `Agent` → waits; `week-90-early` lets go
  → `limit-stop`'s lift, `{tools}` lists all four tools.
- `.resetsIn` lift on the timer: 4d1m left → hold; 3d59m left, idle → one wake.
- AND with one condition known false and one unknown → lets go; all unknown → no change.
- `/ctx-guard pause` during a hold → no lift; the real lift during the pause → note and a
  `notify` "ctx-guard is paused", no attempt counted; the real lift after the pause → one wake.
- `blocking: false` → holds dropped, no lift; none starts while it stays off.
- Reload that removes the trigger, its `lift`, one of its deny tools, or changes its `when` →
  hold dropped, no lift; hot reload with the same config keeps holds, attempts and the pending
  prompt; role change drops them.
- `--resume` → no holds, no lift until the first response.
- A lift that runs clears the mark; the condition holding again fires the trigger's note.

Waking:

- Not touched (no refusal, note never read) → no prompt, no `notify` for it;
  `lift.do: ["notify","prompt"]` → the `notify` from `lift.do` still goes.
- Touched by a refusal that `deniedBy` attributes to another trigger → touched.
- Operator input after the last touch → toast and the lift note on the next turn, no prompt.
- "Go on" → refused by the brake → turn ends → lift → wake runs.
- Operator input delivered into a running turn after the touch → counts.
- `/ctx-guard:resume` from a restart, `task-notification`, `scheduled-trigger`, `unclassified`,
  `peer-send-message`, `/ctx-guard status` typed at the composer → not operator input; `peer`
  and `/ctx-guard:resume` typed at the composer → operator input. An operator's `/clear` (seen by
  `command.run`) → operator input.
- Lift mid-turn with `["note","prompt"]`: the note read by a later step → no prompt; a call to
  `Agent` goes through after the lift → no prompt; turn ends with neither → wake attempt at the
  next idle tick.
- Lift mid-turn whose idle-tick check finds the brake holding → no prompt; the note already sent
  stands, and the trigger's rising edge (mark cleared) notes again.
- Lift while a compact is queued, a trigger prompt waits in `mod.retry`, or a ping holds the fork
  slot → the wake waits for the next idle tick; nothing displaces anything.
- Untrusted repo, `autoActions` off, paused, touched and no operator input → `notify` with its
  reason at once, no fork, no attempt counted. Same gates, not touched → no `notify` for the
  prompt; operator input after the touch → toast and note, no `notify`.
- Several lifts in one evaluation under a closed gate → one `notify` naming them.
- Mixed lifts: A `["note","prompt"]` and B `["note"]` lift together, A makes a wake attempt → B's
  note waits for the check; check frees both → B's note appended, A's text goes as the prompt,
  no A note; check holds A only → B's note appended, A nothing.
- Charged trigger: stacked brakes both held again on fresh figures → the first in config order
  that passed rules 1–5 counts one attempt, the other none.
- Trigger A past `lift.times`, trigger B's prompt goes in the same evaluation → no "Not woken"
  `notify` for A.
- Past `lift.times` with `notify` already in `lift.do` → one `notify`.
- A trigger prompt arising while a lift check runs or a lift prompt waits for its retry → it
  waits for the next idle tick; and the other way round.
- A compact queued while a lift prompt is pending and unsent → the compact goes first, the lift is
  judged again from rule 1 afterwards.
- A lift prompt refused three times with a compact waiting behind its turn → the compact is
  dropped.
- `limit-stop` `["note"]` and `week-60-early` `["note","prompt"]` lift together, the check fails
  three times → `limit-stop`'s note goes on the figures at hand; `week-60-early` stalls.
- Operator input while a refused lift prompt waits to retry → retry dropped, toast and note.
- A woken turn hits the brake again and ends → the next lift can wake again (`lastTurnEndAt`).
- A non-operator turn starts during the fork, check frees the tools → no note appended while the
  prompt waits; the prompt goes next tick with the text; dropped by operator input → note
  appended then.
- `lift.do: ["notify","prompt"]` with the prompt turned into a `notify` → one notification.
- Wake prompt goes → no separate lift note appended.
- Woken turn → `idle` does not grow during it and counts from its end; trigger `times`,
  `lastMainEndAt` and the cache period go on; a woken turn ending with the ready token is judged
  as today.
- Deny reason: lift time is the latest among the holding triggers on the tool; the tail appears
  with `prompt`, trust, `autoActions`, no pause and `lift.times` unspent, and is missing when any
  fails.

Counting:

- `lift.times: 2`, `["note","prompt"]`: brake → check (holds) → brake → check (holds) → the third
  lift sends its note and a `notify` "lift.times is spent", no fork.
- Three failed tries of one check count once.
- Operator input resets the count; a ctx-guard restart's resume does not.

Lift check:

- Fresh figures hold the brake: lift at 80 % on the estimate, fork reports 95 % → no lift action,
  no `notify`, mark kept, the hold keeps its stamps; the next time it lets go wakes without a new
  touch.
- Fork reports figures equal to the stale ones (no `session.measure`) → evaluated from
  `$.session.usage()`, no hang.
- The fork's own `session.measure` and an idle tick during the fork → no second check, no second
  lift.
- Fresh figures free the tools: fork reports 70 % → prompt runs.
- Operator types while the fork runs → no prompt; toast and note on their turn.
- A non-operator turn starts while the fork runs → prompt at the next idle tick if the tools are
  still free on that turn's figures, no new fork or count; held again → no prompt.
- Trust withdrawn or a pause during the fork → `notify` with its reason, no prompt.
- Lift check near a limit: `week-90-early` lifts by time at 92 % with `cache.ping.maxUsage` 90 and
  the cache expired → the fork runs; a `ping` in the same state is skipped.
- Bookkeeping: `cache.pings`, the anchor and `cold` unchanged. Brake holds on fresh figures with
  the cache expired → no band countdown, no `cache.expiresIn` fire, no ping.
- Prompt goes after the check → its main request restarts the countdown and counts no miss.
- Fork fails three times (API error, or `nothing-to-fork`) → no prompt, the failed-checks
  `notify`, hold stalled; the following idle ticks run no fork while the figures are unchanged.
  A new response reporting usage → a new attempt. The earliest reset among the known windows
  (the five-hour one, under a weekly brake) passing → a new attempt.
- A failed fork after which `$.session.usage()` changed → evaluated on those figures.
- Hot reload or `/clear` during the fork → the holds are judged again on the next idle tick as
  the same attempt; the interrupted fork counts as one failed try; nothing stays checking; no
  second fork starts until 2 minutes after `forkAt`. After a `/clear` that is not the operator's
  the hold is untouched: no second fork, no prompt, the lift note in the new context.
- ctx-guard's own `/clear` while the wake prompt waits → no prompt; the lift note in the new
  context, no toast.
- A fork that does not answer within 2 minutes → one failed try; no fork starts until it settles;
  its late answer changes nothing.
- A fork that never settles → the next try 4 minutes after it began; a keep-warm ping's fork that
  never settles → its retry 4 minutes after it went.
- `tries` and the attempt count are written before the fork; a check that answers held resets
  `tries`, so the next let-go of that hold is a new attempt and counts.
- A trigger prompt turn → `idle` keeps growing and `lastWokenEndAt` is unchanged; a woken turn →
  `idle` counts from its end.
- A compact queued at a turn end and still busy → lift work is not held back; a compact queued
  and free at the turn end → it runs before the lift is judged.
- Non-operator turn during the fork, a freed tool used in it → prompt dropped, note appended.
- A lift found by a measure evaluation while idle → judged at once; held back by rule 5 with
  rules 1–4 passed → its note waits with it.
- A custom `lift.message` with `{id}`, `{tools}` and `{liftReason}` renders in the note and the
  prompt.
- A trigger without `lift` keeps its mark over a rolled-over window; the first reported figures
  still over the threshold fire no second note.
- `cache.ping.maxUsage` and `cache.prompt.maxUsage` read 0 % after a passed reset.
- `lift` on a context trigger is accepted.
- A stalled hold leaves the stall on a main response whose percent did not move (no
  `session.measure`), read at the turn's figures.
- Lift on estimated figures, first response shows the condition holding → the rising edge fires
  and does not count in the trigger's `times`.
- Refused submit → retried with the lift text up to three tries while the tools stay free; then
  `notify` "the prompt was refused"; no second fork, no second count.

Figures and texts:

- Stale window: `resetsAt` passed, pct 95 → read as 0 and estimated, `limit-stop` lets go on the
  timer; fresh 95 % from the check keeps the mark, no second note.
- Call path after a passed reset, trigger without `lift` → no deny until the next response.
- Band and `/ctx-guard` report after a passed reset → 0 %, not the stale figure.
- `{liftsIn}` for `.resetsIn`, percent-only, `limit.any` with both windows over, and context
  triggers.
- `{liftReason}` for a five-hour reset, a weekly reset, a reported percent, a `.resetsIn` lift,
  `limit.any` and a context trigger.
- Default lift note, wake prompt, toast and each `notify` text render as in section 2.
- The guide skill's "When a tool is blocked" text names the stop-and-wait rule.

Validation and trust:

- Each Validation rule: one failing config per rule, with its error.
- A trust approval given before `lift` existed still matches a config without `lift`; adding or
  editing `lift` on an auto trigger needs a fresh `/ctx-guard trust`.

## Out of scope

- Brakes on context metrics lift after `/compact` or `/clear`, which ctx-guard's own restart
  already follows with `/ctx-guard:resume`. `lift` is allowed there; no built-in gets one.
- Waking on a schedule unrelated to a brake (`/loop`, cron routines): those stay the operator's
  tools.
- Coordinating peers: each session wakes itself; a lead that needs its workers resumed tells
  them, as it would after any pause.
