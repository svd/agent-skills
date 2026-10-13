# Changelog

All notable changes to the `ctx-guard` plugin are documented here.

## [Unreleased]

### Added

- Plugin scaffold: manifest with `userConfig` switches (`enabled`, `configPath`, `defaultRole`,
  `blocking`, `autoActions`, `display`), the `$.state` type contract, and a config loader that
  merges built-in defaults, the switches, the project file and its `.local.json` override,
  validates them against schema v1 with path-qualified errors, keeps the last good config when a
  file is invalid, parses quantities (`"300k"`, `"1.2M"`, `"40%"`, `"10m"`, `"$2"`), and hashes
  the trust-sensitive fields.
- Role resolution (command > `CTX_GUARD_ROLE` > project `defaultRole` > userConfig `defaultRole`,
  interactive sessions only), `/ctx-guard role` and `/ctx-guard:resume` argument parsing, and the
  role lease decision.
- Trigger evaluation: rising edges per trigger id with JSON marks, `every` steps, AND metrics,
  re-arm on drop and on `/clear`, unknown metrics skipped, and the level-triggered deny set.
- Note, toast, deny-reason, refusal and subagent-budget texts, worded by level and restart mode.
- Hook wiring: config loaded at session start, on `/ctx-guard reload` and when a config file's
  mtime changes (an invalid file toasts once and keeps the last good config); triggers evaluated
  on `session.measure`, after a main-loop model request whose fill crosses a threshold
  (mid-turn, off the request's path) and on a one-minute idle timer, with notes, toasts and OS
  notifications on the rising edge; marks, the running-turn flag and the newest fill kept across
  hot reloads, marks reset on `/clear`; main-loop tool calls denied while a deny trigger holds
  (fails open, lifted by `blocking: false` or a pause). With no role, toasts only.
  `contextWindow: "auto"` uses the engine's own compaction window when it reports one.
- The band above the prompt (`lead · 312k (31%) · 5h 42% (2h10m) · wk 61% (3d4h) · deny Agent`),
  or the same text on the status line on other surfaces or with `display: status`.
- `/ctx-guard` command: report (role and its source, config files and errors, effective config
  and where its window came from, metrics, marks, live blocks), `reload`, and, typed by the
  person only, `role <name|none>` (survives a reload), `pause [30m|off]`, and
  `init [solo|peers]`, which writes a starter config
  only when there is none and adds the local config and state folder to `.gitignore`.
- Start-up checks: a toast and no hooks when another plugin owns `/ctx-guard`, and a toast on
  Claude Code older than 2.1.293.
