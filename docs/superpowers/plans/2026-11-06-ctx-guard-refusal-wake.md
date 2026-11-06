# ctx-guard: wake the model on a refused ready token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ctx-guard refuses the ready token (`CTX-READY`), it submits the refusal as a prompt turn, so the idle model learns why and can fix the cause or go on.

**Architecture:** `refuse()` in `plugins/ctx-guard/hooks/register.tsx` today toasts and appends `refusalNote(...)` with `$.session.append`, which starts no turn. It will submit the note plus one guidance line through `submitOwnPrompt($, text, false)` (the path `runPrompt` uses), and fall back to the append when the prompt is dropped or throws, when the code is `already-busy`, when a main turn runs, or when the loop guard says no. The loop guard is a pure module piece (`restart.ts`) over a new persisted state key `refusalStreak`.

**Tech Stack:** TypeScript mod loaded by Claude Code (no build, no `package.json`); tests with `claude-code/testing` run by `claude plugin test plugins/ctx-guard`.

**Spec:** The Goal section of `.ctx-guard/main-handoff.md` (gitignored, so its decisions are copied below).

## Global Constraints

- Branch `feat/ctx-guard-refusal-wake` (from `dev`). One commit at the end: `feat(ctx-guard): wake the model when the ready token is refused`. No trailers. No push. Each task ends with a temporary commit `wip(ctx-guard): task <N>` (no trailers); the controller squashes them into the one commit after the final review.
- Loop guard: at most one wake per refusal code in a row; at most 3 wakes per streak (`REFUSAL_WAKE_CAP = 3`). The streak resets after a restart that went through (a `/clear` or a `/compact` on the token) or after a typed prompt's turn. The streak is persisted in `$.state`, so a reload keeps it.
- No wake for code `already-busy`, and none while a main turn runs (`turnRunningIn(activity(), now)`); those refusals append the note as today and leave the streak as it is.
- Wake prompt text: the `refusalNote(...)` line, a newline, then exactly: `Fix it if it is yours to fix, then send <token> once more; else go on with the task or tell the operator.` with `<token>` the configured ready token.
- A wake that went in replaces the append (one note, not two). A dropped (`drop`) or thrown submit falls back to the append.
- This change adds no config key.
- `register.tsx` is ~200 KB: read it by line ranges (`sed -n A,Bp`), never whole. Every file in the plugin folder stays under 256 KiB.
- Mod rules (`docs/directory-rules.md` "Mod rules"): `$` only as a whole argument to a top-level function of the same file; calls written as `$.noun.method(...)`; no `$` alias; no `h`/`Fragment` as values in `.tsx`. The new code only calls existing helpers (`submitOwnPrompt`, `quietly`, `put`), so it stays inside these rules.
- Checks, one at a time: `claude plugin test plugins/ctx-guard`, `claude plugin validate plugins/ctx-guard`, `python3 tools/check_directory_rules.py plugin plugins/ctx-guard --fail-on hold`.

## Review Focus

1. The woken turn ends on the token while the operator's `/ctx-guard:clear` ask holds: the token must still count as asked (`clearAskHolds`, `restart.ts:99`). The woken turn is an own prompt (not typed, not a wake turn), so it is neither closing nor cut when it ends on an answer. Pinned by a Task 2 test.
2. A reload between two refusals of one code: the second must not wake. Pinned by a Task 2 test.
3. `restartFlow`'s `finally` (`register.tsx:2188-2192`) retries a queued compact (`compactAtTurnEnd`) when nothing was cleared. After a wake that went in, the compact must wait for the woken turn's end instead of firing over it. Pinned by a Task 2 test.
4. A refusal while the operator's next turn already runs (token turn ended, a new main turn started before the timer) must not submit a prompt into it. Pinned by a Task 2 test.
5. The woken turn's own end must not reset the streak (it is not typed), or the cap never bites. Pinned by the cap test in Task 2.

---

### Task 1: Pure pieces — prompt text and loop guard

**Files:**
- Modify: `plugins/ctx-guard/hooks/messages.ts` (next to `refusalNote`, line 562)
- Modify: `plugins/ctx-guard/hooks/restart.ts` (next to `clearAskHolds`, line 99)
- Modify: `plugins/ctx-guard/types/index.d.ts` (type next to `LastVerdict`, line 351; key in `PluginState['ctx-guard']`, after `lastVerdict`, line 449)
- Test: `plugins/ctx-guard/hooks/messages.test.ts` (beside the `refusalNote` test, line 561), `plugins/ctx-guard/hooks/restart.test.ts`

**Interfaces:**
- Produces, `types/index.d.ts`:
  - `export type RefusalStreak = { code: string; wakes: number; at: number }` — the last wake-eligible refusal's code and time, and the wakes so far in this streak. Comment: one line, as the neighbors have.
  - `PluginState['ctx-guard'].refusalStreak: RefusalStreak | null`, with a one-line comment (the refusals since the last restart or typed turn, for the loop guard).
- Produces, `messages.ts`:
  - `export function refusalPrompt(readyToken: string, code: string, text: string, via: RestartVia = 'clear'): string`
- Produces, `restart.ts`:
  - `export const REFUSAL_WAKE_CAP = 3`
  - `export type StreakMarks = { restartAt: number | null; typedStartAt: number | null }`
  - `export function liveStreak(s: RefusalStreak | null, m: StreakMarks): RefusalStreak | null` — `null` when `s` is null, or `m.restartAt !== null && m.restartAt >= s.at`, or `m.typedStartAt !== null && m.typedStartAt > s.at`; else `s`. (Restart is `>=`: the mock clock may not move between a refusal and a restart. Typed is strictly `>`: the token's own typed turn starts at or before the refusal.)
  - `export function wakesOnRefusal(live: RefusalStreak | null, code: RefusalCode): boolean` — false for `already-busy`; false when `live?.code === code`; false when `(live?.wakes ?? 0) >= REFUSAL_WAKE_CAP`; else true.
  - `export function nextStreak(live: RefusalStreak | null, code: RefusalCode, woke: boolean, now: number): RefusalStreak` — `{ code, wakes: (live?.wakes ?? 0) + (woke ? 1 : 0), at: now }`.
  - `export function asRefusalStreak(v: unknown): RefusalStreak | null` — shape check for `readStored`: an object with string `code`, finite integer `wakes >= 0`, finite number `at`; else null.

- [ ] **Step 1: Write the failing tests**

`messages.test.ts`:
```ts
test('refusalPrompt: the refusal note, then what to do', () => {
  expect(refusalPrompt('CTX-READY', 'agents-running', 'two subagents are still running.')).toBe(
    '[ctx-guard] CTX-READY ignored (agents-running): two subagents are still running. Nothing was cleared.\n' +
      'Fix it if it is yours to fix, then send CTX-READY once more; else go on with the task or tell the operator.',
  )
})
test('refusalPrompt: via compact, and a custom token', () => {
  const p = refusalPrompt('GO', 'error', '/compact was refused: no', 'compact')
  expect(p.split('\n')[0]).toBe('[ctx-guard] GO ignored (error): /compact was refused: no. Nothing was compacted.')
  expect(p.split('\n')[1]).toContain('then send GO once more')
})
```

`restart.test.ts`:
```ts
const S = (code: string, wakes: number, at: number) => ({ code, wakes, at })
test('liveStreak: a restart at or after the last refusal, or a typed turn started after it, ends the streak', () => {
  expect(liveStreak(null, { restartAt: null, typedStartAt: null })).toBe(null)
  expect(liveStreak(S('no-handoff', 1, 100), { restartAt: 99, typedStartAt: 100 })).toEqual(S('no-handoff', 1, 100))
  expect(liveStreak(S('no-handoff', 1, 100), { restartAt: 100, typedStartAt: null })).toBe(null)
  expect(liveStreak(S('no-handoff', 1, 100), { restartAt: null, typedStartAt: 101 })).toBe(null)
})
test('wakesOnRefusal: one wake per code in a row, at most REFUSAL_WAKE_CAP, never for already-busy', () => {
  expect(REFUSAL_WAKE_CAP).toBe(3)
  expect(wakesOnRefusal(null, 'no-handoff')).toBe(true)
  expect(wakesOnRefusal(null, 'already-busy')).toBe(false)
  expect(wakesOnRefusal(S('no-handoff', 1, 1), 'no-handoff')).toBe(false)
  expect(wakesOnRefusal(S('no-handoff', 1, 1), 'background-tasks')).toBe(true)
  expect(wakesOnRefusal(S('no-handoff', 3, 1), 'background-tasks')).toBe(false)
})
test('nextStreak: counts only wakes that went in', () => {
  expect(nextStreak(null, 'no-handoff', true, 5)).toEqual(S('no-handoff', 1, 5))
  expect(nextStreak(S('no-handoff', 1, 5), 'background-tasks', false, 9)).toEqual(S('background-tasks', 1, 9))
})
test('asRefusalStreak: shape-checked', () => {
  expect(asRefusalStreak(S('error', 2, 7))).toEqual(S('error', 2, 7))
  expect(asRefusalStreak({ code: 'error', wakes: -1, at: 7 })).toBe(null)
  expect(asRefusalStreak({ code: 1, wakes: 0, at: 7 })).toBe(null)
  expect(asRefusalStreak('x')).toBe(null)
})
```

- [ ] **Step 2: Run and see them fail**

Run: `claude plugin test plugins/ctx-guard`
Expected: FAIL — the new names are not exported.

- [ ] **Step 3: Implement the Interfaces above.** `refusalPrompt` builds on `refusalNote`.

- [ ] **Step 4: Run and see them pass**

Run: `claude plugin test plugins/ctx-guard` — expected: all pass.
Run: `claude plugin validate plugins/ctx-guard` — expected: passes. If it reports the new `refusalStreak` key has no literal ref in `register.tsx`, that is Task 2's work; note it and go on.

- [ ] **Step 5: Commit (temporary):** `git add plugins/ctx-guard docs/superpowers/plans && git commit -m "wip(ctx-guard): task 1"`

---

### Task 2: Wire the wake into `register.tsx`

**Files:**
- Modify: `plugins/ctx-guard/hooks/register.tsx`
  - state key: consts `register.tsx:218-238` (add `const REFUSAL_STREAK = { plugin: 'ctx-guard', key: 'refusalStreak' } as const`), `emptyMem` `:500-521`, `stateSet` switch `:545-588`, `readStored` `:623-668` (with `asRefusalStreak`), imports `:100-215`
  - `refuse()` `:1865-1873`
  - `restartFlow` `finally` `:2188-2192`
- Modify: `plugins/ctx-guard/hooks/register.fixtures.ts` — `refusals` `:499`; the WIPE plugin's key list `:~417` (add `'refusalStreak'`); `PEEK_RESTART` `:511-526` may add `refusalStreak` if a test needs it
- Test: `plugins/ctx-guard/hooks/register.restart.test.ts`; existing refusal assertions in it and in `register.state.test.ts`

**Interfaces:**
- Consumes (Task 1): `refusalPrompt`, `REFUSAL_WAKE_CAP`, `liveStreak`, `wakesOnRefusal`, `nextStreak`, `asRefusalStreak`, `RefusalStreak`.
- Existing, used as is: `submitOwnPrompt($, text, false): Promise<PromptSubmitResult>` (`:3599`), `turnRunningIn(activity(), now)`, `quietly`, `put($, key, value)`, `activity().lastTypedStartAt`, `mem.lastRestartAt`, `mod.ownPrompt` (true from a submit that went in until its turn starts).
- Produces: `refuse()` keeps its signature `($, code, text): Promise<void>`. The fixture `refusals(s: MockSession, w: World): string[]` returns the refusal lines from both doors: appended notes, then `w.prompts` lines containing `ignored (`.

`refuse()` after the change, in order: compute `token`, `role`, `via`, `line` as today; `setVerdict`; toast `line`; then
1. `now = await $.clock.now()`; `live = liveStreak(mem.refusalStreak, { restartAt: mem.lastRestartAt, typedStartAt: activity().lastTypedStartAt })`.
2. Eligible = `code !== 'already-busy' && !turnRunningIn(activity(), now)`. Not eligible → append `line` (today's call) and return; the streak is not touched.
3. `woke = false`; if `wakesOnRefusal(live, code)`, inside `quietly`: `woke = (await submitOwnPrompt($, refusalPrompt(token, code, text, via), false)).drop === undefined`.
4. `await put($, 'refusalStreak', nextStreak(live, code, woke, now))`.
5. Not `woke` → append `line` as today.

`restartFlow` `finally`: the compact retry also needs `!mod.ownPrompt`, so a queued compact waits for the woken turn's end (`turn.complete` runs `compactAtTurnEnd` there).

- [ ] **Step 1: Write the failing tests** in `register.restart.test.ts`, a new section `// ---- restart: a refusal wakes the model ----`. Use `armed`/`restartWorld`/`ready`/`ownPrompts`/`refusals` from the fixtures. A `background-tasks` refusal comes from `ready($, clock, 'Handoff written.\n\nCTX-READY', [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run watch' }])`; a `no-handoff` one from deleting `w.files[HANDOFF]` before `ready`. Use `autoConfig({ selfGap: '0' })` where a test restarts and then refuses again.

  - `'a refused token wakes the model with the reason, and appends no note'` — one `ownPrompts(w)` entry; its first line contains `CTX-READY ignored (background-tasks)` and ends `Nothing was cleared.`; its second line is the fix line; `notes(session).filter(n => n.includes('ignored ('))` is `[]`; `w.ran` has no `clear`.
  - `'already-busy is not woken: the note is appended'` — mirror the setup of the test at `register.restart.test.ts:2141`; `ownPrompts(w)` holds no `ignored (` line; one appended refusal note.
  - `'no wake while a main turn runs'` — `$.classic.Stop` with a running task, `$.turn.complete` on the token, then `await turn($, 'start')` before `clock.settle()`/`clock.advance(RACE_SETTLE_MS)`; no `ignored (` prompt; one appended note.
  - `'the same code twice in a row wakes once'` — two `background-tasks` refusals (the second after a woken turn: `turn($, 'start')`, then `ready(...)` with the task still running); one prompt, then one appended note.
  - `'a new code wakes again'` — `background-tasks`, then `no-handoff`; two `ignored (` prompts.
  - `'at most 3 wakes in a streak'` — alternate `background-tasks`, `no-handoff`, `background-tasks`, `no-handoff`, each after a woken turn; 3 `ignored (` prompts, the 4th refusal appended.
  - `'a dropped wake falls back to the note'` — `w.dropPrompt = 'busy'`; one appended refusal note; `w.prompts` holds the dropped prompt once.
  - `'a restart that goes through resets the streak'` — refusal (woken), then a token with nothing running clears (`w.ran` has `clear`), rewrite the handoff, then the same code refused again → a second `ignored (` prompt.
  - `'a typed turn resets the streak'` — refusal (woken), then a typed prompt's turn (as the `/ctx-guard:clear` tests at `register.restart.test.ts:844` drive one), then the same code → a second prompt.
  - `'the streak survives a reload'` — refusal (woken), reload the module as `register.restart.test.ts:627` does, same code again → no second prompt, one appended note.
  - `'the woken turn's token still counts as asked under /ctx-guard:clear'` — mirror `register.restart.test.ts:822` (`restart.minContext` above the fill, so only the ask lets the token by): after `/ctx-guard:clear`, the token turn is refused `background-tasks` and woken; the woken turn (`turn($, 'start')`, then `ready` with no tasks) clears: `w.ran` has `clear`, no `not-needed` refusal.
  - `'via compact: the wake says nothing was compacted'` — `compactArmed`, `background-tasks` refusal; the prompt's first line ends `Nothing was compacted.`
  - `'a queued compact waits for the woken turn'` — a compact queued for the turn end (as the compact-trigger tests set one up), then a refused token that wakes; no `compact` in `w.ran` until the woken turn ends; after it ends (`mainTurnEnd`), the compact runs.

- [ ] **Step 2: Run and see them fail**

Run: `claude plugin test plugins/ctx-guard`
Expected: the new tests FAIL (no prompt submitted; notes appended).

- [ ] **Step 3: Implement** the state key, `refuse()` and the `finally` change as specified above; change `refusals` to `(s, w)` and pass `w` at every call site (`register.restart.test.ts`, `register.state.test.ts`).

- [ ] **Step 4: Run the whole suite**

Run: `claude plugin test plugins/ctx-guard`
Expected: all pass. An existing test that fails only because its refusal now arrives as a prompt (an index into `refusals`, a count of `w.prompts`, `notes(session)` holding the refusal) gets its assertion moved to the prompt. Any other failure is a regression: fix the code, not the test; if unsure, stop and report.

- [ ] **Step 5: Validate and check the mod rules**

Run: `claude plugin validate plugins/ctx-guard` — expected: passes (the `PluginState` contract has `refusalStreak`, with its literal ref).
Run: `python3 tools/check_directory_rules.py plugin plugins/ctx-guard --fail-on hold` — expected: exit 0, no block or hold.
Run: `tsc -p plugins/ctx-guard` only if `plugins/ctx-guard/.claude-plugin/types/` exists; else skip and say so.

- [ ] **Step 6: Commit (temporary):** `git add plugins/ctx-guard && git commit -m "wip(ctx-guard): task 2"`

---

### Task 3: Docs, final checks, commit

**Files:**
- Modify: `plugins/ctx-guard/skills/guide/SKILL.md` "When the token is refused" (`:63-80`)
- Modify: `plugins/ctx-guard/skills/guide/references/config-reference.md` "The verdict" (`:610-618`)
- Modify: `plugins/ctx-guard/README.md` "Sends to the model" (`:166-178`)
- Modify: `plugins/ctx-guard/CHANGELOG.md` — add `## [Unreleased]` with `### Changed` above `## [0.7.0]`

- [ ] **Step 1: Write the docs.** Facts to state, each where it fits:
  - A refusal reaches the model as a prompt turn (it starts a turn): the note line, then the fix line. With `already-busy`, while a turn runs, when the prompt is refused, or when the loop guard holds it back, the note is added to the conversation as before, with no turn.
  - The loop guard: one wake per code in a row, at most 3 per streak; a restart that goes through or a typed prompt's turn starts a new streak; a reload keeps it.
  - SKILL.md: the model answers the woken turn per the code table; "Never loop it" stays.
  - README: the refusal prompt is a third kind of submitted turn, capped by the loop guard. It comes whenever ctx-guard acts on the token at all (`restart.mode: "auto"`, `autoActions` on, no pause), so an untrusted repo gets it too, with code `untrusted`.
  - CHANGELOG `### Changed`: one entry stating the above.
  - Follow the repo's writing rule: state what the change is; compare only with what the repo had.

- [ ] **Step 2: Run the checks, one at a time**

1. `claude plugin test plugins/ctx-guard` — all pass.
2. `claude plugin validate plugins/ctx-guard` — passes.
3. `python3 tools/check_directory_rules.py plugin plugins/ctx-guard --fail-on hold` — exit 0.

- [ ] **Step 3: Commit (temporary; squashed later)**

```bash
git add plugins/ctx-guard docs/superpowers/plans/2026-11-06-ctx-guard-refusal-wake.md
git commit -m "wip(ctx-guard): task 3"
```
