---
name: updating-model-pricing
description: Use when refreshing, auditing, or adding Claude model prices in the svd-agent-skills repo - the PRICING dicts in session-analyzer and manage-claude-projects and the README pricing table. Specific to the agent-skills repo.
---

# Updating model pricing

The same per-1M-token price table lives in three places, and they must stay identical, because the
two plugins should report the same cost for the same session:

- `PRICING` in `plugins/session-analyzer/skills/session-analyzer/scripts/parse_session.py`
- `PRICING` in `plugins/manage-claude-projects/skills/manage-claude-projects/scripts/projects.py`
- the `## Pricing` section of `README.md` (table, multiplier note, `Covers ...` line, ordering note)

1. Read all three and note any drift between them.
2. Get current model ids and rates from the `claude-api` skill, or from
   https://platform.claude.com/docs/en/about-claude/pricing if it lacks something: input, output,
   cache read, 5m and 1h cache write, long-context tiers, fast-mode rates. Look every number up even
   when you feel confident; prices change after training. If a value can't be found, say which.
3. Present a table: model, matched key, current price, correct price, status. "Matched key" is the
   first `PRICING` key that is a substring of the model id, in dict order — that is how the scripts
   pick a row.
4. Check key order. Because the first substring hit wins, every specific key (`fable-5-1`,
   `opus-5-5`, `sonnet-5-5`) must sit above its family key (`fable`, `opus`, `sonnet`, and also
   `sonnet-5`, which matches `sonnet-5-5`). Otherwise the specific model is silently billed at the
   family rate.
5. Show the proposed dict and README table, then wait for the user's approval. Report rates the
   schema has no field for (long-context, fast mode) and leave adding fields to a separate request.
6. After approval: apply the same dict to both scripts, update the README, and add a
   `### Changed` bullet under `## [Unreleased]` in both plugins' `CHANGELOG.md`.
7. Run `python3 plugins/session-analyzer/skills/session-analyzer/scripts/smoke_test.py`. If a
   pinned expectation fails because a price legitimately changed, update the test and say so.
   Confirm the two dicts are identical.
8. Stop and report. Releasing is a separate step — point the user to the `releasing-a-version` skill.
