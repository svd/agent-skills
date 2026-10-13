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
