# ctx-guard: handoff written by any skill — design

Date: 2026-10-14 · Plugin: `plugins/ctx-guard` (0.1.0, unreleased)

## Goal

Let a role's handoff be written by any skill the operator chooses, not only by the
`session-handoff` skill. The operator names the skill in `handoff.instructions`; ctx-guard needs
no special mode for it.

## Decisions (agreed with the operator)

- Remove `handoff.style` and its `session-handoff` branch. No compatibility alias: the plugin is
  unreleased.
- `handoff.path` stays exactly as it is today: one file, relative to the root, may hold `{role}`.
  Whatever skill writes the handoff, the result must end up at that path. The guard
  (`no-handoff`, `handoff-stale`, path confinement, trust) is unchanged.
- The skill and any extra steps are named in `handoff.instructions`.

## Changes

### 1. Config and types

- `types/index.d.ts`: drop `HandoffStyle`; `RoleSpec.handoff` becomes
  `{ path: string; instructions: string | null }`.
- `hooks/config.ts`: drop `STYLES`, the `style` parse and `'style'` from the handoff key list. A
  `style` key is then reported as an unknown key, like any other.
- `skills/guide/assets/ctx-guard.schema.json`: drop `handoff.style`.
- Trust hash (`trustMaterial`): `handoff` becomes `{ path }`; `style` goes. Instructions stay
  out of it, as today: they only shape the note, not the resume command line.

### 2. `{role}` in instructions

`handoff.instructions` gets `{role}` filled in, as `handoff.path` already does, so one string
serves several roles (for example a slug `ctx-guard-{role}`). Only `{role}`; other text is left
as written.

### 3. Note wording

`restartTail` (`hooks/messages.ts`) loses the `session-handoff` branch and its `slug` argument.
The handoff step reads, neutrally:

> … write the handoff to `<path>`: <instructions>. Then end your reply with a line holding only
> `CTX-READY`.

Without instructions: "… write the handoff to `<path>`." The manual mode and `via: compact`
variants change the same way. The guide skill still says how to write a handoff when the
instructions name no skill: rewrite the whole file with the Write tool, never append.

### 4. Handoff lookup

`hooks/register.tsx`:
- `handoffOf` always uses `handoffPathFor(spec, role)`; the directory scan goes.
- `notedHandoff` and the `handoffPath` override in `act`/`NoteOptions` go: the note's path is
  always the configured one.

`hooks/restart.ts`: drop `sessionHandoffDir`, `latestHandoff` and `HANDOFF_NAME` if nothing else
uses them. `hooks/messages.ts`: drop `sessionHandoffSlug`.

### 5. Docs

- `skills/guide/SKILL.md`, "Write the handoff": one rule — write the file the note names,
  following the instructions; if they name a skill, use it and make sure the result is at that
  path; if they name none, rewrite the whole file with the Write tool. Drop the session-handoff
  bullet.
- `skills/guide/references/config-reference.md`: drop the `handoff.style` row, the
  `style: session-handoff` note text, the `.claude/session-handoffs/` gitignore line and the
  session-handoff paragraph under path confinement; say that `handoff.instructions` takes
  `{role}` and may name a skill.
- `skills/guide/assets/ready-checks/clean-worktree.sh`: drop the session-handoff comment.
- `README.md`:
  - remove `"style": "file"` from the example at line ~233 and the `handoff.style` row;
  - rewrite recipe 11 "Handoffs through the session-handoff skill": where to get it — the
    `session-handoff` plugin in this repo (`plugins/session-handoff`), installed with
    `/plugin marketplace add svd/agent-skills` and
    `/plugin install session-handoff@svd-agent-skills` — and this config:

    ```json
    "handoff": {
      "path": ".ctx-guard/{role}-handoff.md",
      "instructions": "Write it with the session-handoff skill (project slug `ctx-guard-{role}`, its handoff tool run from the project root), then copy the result to this path. Sections: Goal, State, Next action."
    }
    ```

    with one line on why the copy is needed: the skill saves dated files under
    `.claude/session-handoffs/<slug>/`, while ctx-guard checks and resumes from `handoff.path`;
  - in the gitignore paragraph (~line 974), keep `.claude/session-handoffs/` only as advice for
    recipe 11.
- `CHANGELOG.md` `[Unreleased]`: replace the `handoff.style: "session-handoff"` entry with
  "`handoff.instructions` may name any skill that writes the handoff, and takes `{role}`".

## Tests

- `hooks/config.test.ts`: `handoff.style` is now an unknown-key error; the old enum test goes.
- `hooks/messages.test.ts`: the session-handoff test becomes "instructions naming a skill are
  passed through with `{role}` filled in"; the wording tests expect "write the handoff to".
- `hooks/register.test.ts`: the session-handoff style test goes; one test checks that a note
  carries the configured path and the filled-in instructions, and that the resume command uses
  `handoff.path`.
- Full suite passes.

## Out of scope

- Handoff directories or "newest file" lookup.
- Skill names as a separate config key.
- Changes to the `session-handoff` plugin.
