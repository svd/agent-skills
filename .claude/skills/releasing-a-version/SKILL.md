---
name: releasing-a-version
description: Use when releasing, cutting, tagging, or shipping a new version of one or more plugins in the svd-agent-skills marketplace - bumping plugin.json, rolling the CHANGELOG [Unreleased] block into a dated version header, committing on main, and cutting a per-plugin annotated <plugin>-vX.Y.Z tag. Specific to the agent-skills repo.
---

# Releasing a version

Each plugin under `plugins/<plugin>/` is versioned on its own, so each released plugin gets its own
commit and its own tag. Every push to `main` ships to users at once (distribution is by commit SHA);
the version and CHANGELOG record what shipped.

1. Pick plugins and bumps. For each plugin, read the `## [Unreleased]` section of its `CHANGELOG.md`
   and the commits since its last tag (`git tag --list '<plugin>-v*'`, then
   `git log <tag>..HEAD -- plugins/<plugin>`). Release the plugins with unreleased changes, unless
   the user named others. The Unreleased bullets decide the semver bump: MAJOR for a breaking change
   to output, schema or CLI; MINOR for anything additive; PATCH for fixes, docs and refactors.
2. Run `git status`. The release commits should hold only the version bump, so if unrelated changes
   are present, ask the user how to handle them. Run each plugin's smoke test if it has one
   (`find plugins/<plugin> -name smoke_test.py`). If a test fails, stop and report: a push would ship it.
3. For each plugin, set `"version"` in `.claude-plugin/plugin.json`, and in `CHANGELOG.md` rename
   `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today, `date +%F`), keeping its bullets as they
   are. With no Unreleased section, write one from the commits and their diffs. Leave
   `marketplace.json` (it has no version field) and `README.md` (it changes only when a plugin is
   added or removed) as they are.
4. Commit each plugin separately, staging only its `plugin.json` and `CHANGELOG.md`, with the message
   `chore(<plugin>): release vX.Y.Z` and the CHANGELOG bullets as the body. Separate commits let
   each tag point at its own plugin's bump.
5. Stop and ask for approval before pushing or tagging, because a push ships to users and a published
   tag must never move. Show the old and new versions, `git log --stat` of the new commits, and the
   tag names and messages you will create.
6. After approval, push the commits first (`git push origin main`), so no tag points at a commit
   missing from `origin`. Then, per plugin, create an annotated tag on its release commit,
   `git tag -a <plugin>-vX.Y.Z <commit> -m "<plugin> vX.Y.Z: <one-line summary>"`, and push it with
   `git push origin <plugin>-vX.Y.Z`. The plugin prefix keeps independent version numbers from
   colliding, so use it rather than a bare `vX.Y.Z`. If a tag already exists, stop and ask instead of
   replacing it, since users may have pinned it.
7. Check: `git status` is clean, `git ls-remote origin` shows `main` at the last release commit and
   every new tag, and each tag's version matches its `plugin.json`. Then stop and report the
   plugins, versions, commits and tags.
