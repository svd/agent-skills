# Changelog

All notable changes to the `manage-claude-projects` plugin are documented here.

## [Unreleased]

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
