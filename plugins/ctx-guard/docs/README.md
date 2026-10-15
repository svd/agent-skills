# ctx-guard docs

[← ctx-guard README](../README.md)

| Doc | What is in it |
|---|---|
| [Getting started](getting-started.md) | Concepts in one table, a typical cycle, install, zero-config behaviour, the built-in ladder, the first project config, trust, `/ctx-guard check`. |
| [Configuration](configuration.md) | Where settings live, the `/config` switches, the anatomy of a config file, quantities, triggers, what to block, roles, commands. |
| [Handoff, restart and compact](handoff-and-restart.md) | Restart modes, the handoff file, the ready token, the verdict, what a restart does, manual restarts, compact. |
| [Use cases](use-cases.md) | 17 complete configs: watch only, manual and automatic restarts, clean-worktree checks, compact, coordinator and workers, peer sessions, usage brakes, worktree builders, external jobs, band probes, personal overrides. |
| [Troubleshooting](troubleshooting.md) | Symptoms and fixes, every refusal code, the files ctx-guard writes. |
| [Comparison](comparison.md) | ctx-guard next to usage monitors, handoff plugins and Claude Code's built-ins. |

Reference material lives with the `guide` skill, which the model also reads:

- [Config reference](../skills/guide/references/config-reference.md): every key, default, refusal
  code and trust rule, plus recipes.
- [JSON Schema](../skills/guide/assets/ctx-guard.schema.json) for config v1.
- Presets: [solo](../skills/guide/assets/presets/solo.json),
  [peers](../skills/guide/assets/presets/peers.json).
- Example scripts: [ready checks](../skills/guide/assets/ready-checks/),
  [band probes](../skills/guide/assets/probes/).
- [The guide skill](../skills/guide/SKILL.md): how the model answers notes, refusals and budgets.
