# Changelog

All notable changes to the `manage-claude-projects` plugin are documented here.

## [Unreleased]

### Fixed

- Claude Opus 5.5 cost estimates. Its model id matched the generic `opus` key, which prices it
  at the Opus 4.5–5 rate ($5/$25, cache write $6.25, cache read $0.50/MTok) instead of the
  actual $4/$20, cache write $5.00, cache read $0.20/MTok (0.05x base input). Added an
  `opus-5-5` tier ahead of `opus`.

## [0.1.2] - 2026-09-04

### Fixed

- Claude Fable 5.1 and Mythos 5.1 cost estimates. Their model ids matched the `fable` /
  `mythos` keys, which price cache reads at $1.00/MTok — 4x the actual $0.25/MTok (0.025x
  base input, where every other model uses 0.1x). Added `fable-5-1` / `mythos-5-1` tiers
  ahead of those keys; input, output, and cache write are unchanged from 5.0.

## [0.1.1] - 2026-08-11

### Changed
- **`deepstats` prices Sonnet 5 at its own rate.** Anthropic made Sonnet 5's $2/$10 the standard
  price, cancelling the increase to $3/$15 scheduled for 2026-09-01. The `PRICING` table had only a
  generic `sonnet` entry at $3/$15, so Sonnet 5 usage was estimated at the Sonnet 4.x rate; a
  `sonnet-5` entry at 2.00/10.00/2.50/0.20 now sits ahead of it. Sonnet 4.5/4.6 continue to price at
  $3/$15 via the generic key. Because `PRICING` keys match by substring and the first hit wins, the
  specific key must precede the family key — the table is order-dependent and must not be sorted.
  This aligns the table with `session-analyzer`'s, which the two plugins keep in sync.

## [0.1.0] - 2026-06-11

### Added
- Initial release: inspects, audits, and cleans up local Claude Code projects under `~/.claude`
  — lists projects/sessions, reports disk usage and token/cost estimates, and supports removing a
  project's traces.
