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
