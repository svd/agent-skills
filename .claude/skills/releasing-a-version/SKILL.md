---
name: releasing-a-version
description: Use when releasing, cutting, tagging, or shipping a new version of one or more plugins in the svd-agent-skills marketplace - bumping plugin.json, rolling the CHANGELOG [Unreleased] block into a dated version header, committing on main, cutting a per-plugin annotated <plugin>-vX.Y.Z tag, and publishing its GitHub release. Specific to the agent-skills repo.
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
   (`find plugins/<plugin> -name smoke_test.py`). When the plugin has `hooks/hooks.json` (a mod),
   run `claude plugin validate plugins/<plugin>` and `claude plugin test plugins/<plugin>`. If a
   check fails, stop and report: a push would ship it. Run `gh auth status` too: step 7 publishes
   the GitHub releases with `gh`, so a missing login is better found now than after the tags.
3. For each plugin, set `"version"` in `.claude-plugin/plugin.json`, and in `CHANGELOG.md` rename
   `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today, `date +%F`), keeping its bullets as they
   are. With no Unreleased section, write one from the commits and their diffs. If the plugin's
   own `README.md` shows a version badge (`grep -n 'badge/version-' plugins/<plugin>/README.md`),
   set it to X.Y.Z. Leave `marketplace.json` (it has no version field) and the root `README.md`
   (it changes only when a plugin is added or removed) as they are.
4. Commit each plugin separately, staging only its `plugin.json`, `CHANGELOG.md` and, when its
   badge changed, its `README.md`, with the message
   `chore(<plugin>): release vX.Y.Z` and the CHANGELOG bullets as the body. Separate commits let
   each tag point at its own plugin's bump.
5. Draft each plugin's release notes in a file outside the repo (`mktemp`), so the release
   commit stays clean:

   ````markdown
   <the plugin's one-line pitch: the bold line under its README title, else plugin.json description>

   ## Install

   ```text
   /plugin marketplace add svd/agent-skills
   /plugin install <plugin>@svd-agent-skills
   ```

   ## What's new in X.Y.Z

   <the bullets of its new CHANGELOG section, as they are>

   [README](https://github.com/svd/agent-skills/tree/<plugin>-vX.Y.Z/plugins/<plugin>) ·
   [Full changelog](https://github.com/svd/agent-skills/blob/<plugin>-vX.Y.Z/plugins/<plugin>/CHANGELOG.md)
   ````

   Release notes do not resolve relative links, so every link and image is an absolute URL pinned
   to the tag (`https://raw.githubusercontent.com/svd/agent-skills/<plugin>-vX.Y.Z/...` for an
   image). For a plugin's first release, put its README's opening paragraph under the pitch.
6. Stop and ask for approval before pushing, tagging or publishing, because a push ships to users,
   a published tag must never move and a release is public. Show the old and new versions,
   `git log --stat` of the new commits, the tag names and messages you will create, and each
   release's notes.
7. After approval, push the commits first (`git push origin main`), so no tag points at a commit
   missing from `origin`. Then, per plugin, create an annotated tag on its release commit,
   `git tag -a <plugin>-vX.Y.Z <commit> -m "<plugin> vX.Y.Z: <one-line summary>"`, and push it with
   `git push origin <plugin>-vX.Y.Z`. The plugin prefix keeps independent version numbers from
   colliding, so use it rather than a bare `vX.Y.Z`. If a tag already exists, stop and ask instead of
   replacing it, since users may have pinned it. Then publish each plugin's release on its pushed
   tag: `gh release create <plugin>-vX.Y.Z --verify-tag --title "<plugin> X.Y.Z" --notes-file <notes>`.
   `--verify-tag` makes `gh` refuse rather than create a tag of its own from `main`. GitHub marks
   the newest release as Latest, whichever plugin it belongs to; pass `--latest=false` only when
   the user asks to keep another plugin's release on top.
8. Check: `git status` is clean, `git ls-remote origin` shows `main` at the last release commit and
   every new tag, each tag's version matches its `plugin.json`, and `gh release view <tag>` shows
   each release with its notes. Then stop and report the plugins, versions, commits, tags and
   release URLs.
