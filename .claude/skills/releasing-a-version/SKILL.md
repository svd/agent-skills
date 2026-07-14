---
name: releasing-a-version
description: Use when releasing, cutting, tagging, or shipping a new version of one or more plugins in the svd-agent-skills marketplace - bumping plugin.json, rolling the CHANGELOG [Unreleased] block into a dated version header, committing on main, and cutting a per-plugin annotated <plugin>-vX.Y.Z tag. Specific to the agent-skills repo.
---

# Releasing a version

This repo is a **multi-plugin marketplace**. Each plugin under `plugins/<name>/` versions
**independently** — there is no repo-wide version. A release run can cover one plugin or
several; each gets its own commit and its own tag.

| Per plugin | Version files | Tag form | Tag branch |
|---|---|---|---|
| `plugins/<plugin>/` | `.claude-plugin/plugin.json` `.version`, `CHANGELOG.md` header | `<plugin>-vX.Y.Z` (annotated) | `main` only |

Not touched by a release:
- `.claude-plugin/marketplace.json` — carries no version field at all, per-plugin or
  otherwise. Nothing to sync there.
- `README.md` — only changes when a plugin is added/removed, not on a version bump.

No `dev` branch, no worktrees, no `-SNAPSHOT`, no stash dance, no PR/MR. This is GitHub,
single `main` branch, and distribution is **commit-SHA**: every push to `main` ships to
users who run `/plugin marketplace update`. The version fields and CHANGELOGs are
documentation metadata, decoupled from delivery — but still worth keeping accurate.

---

## Step 1 - Pick plugins and bumps

For each plugin you're releasing this run:

```bash
git tag --list '<plugin>-v*'                      # last release for this plugin, if any
git log <plugin>-vLAST..HEAD --oneline -- plugins/<plugin>   # commits since, if a tag exists
```

No tags exist yet for a plugin on its first release — use its full history under
`plugins/<plugin>/` and its CHANGELOG `[Unreleased]` block instead.

No `VERSIONING.md` in this repo. Apply plain semver by judgment:

| Bump | Trigger |
|---|---|
| MAJOR | Breaking output/schema change (report/JSON format change, field removed/renamed, CLI flag removed, workspace-layout change) |
| MINOR | New skill/subagent, new CLI flag/command, additive schema field, new supported input format (e.g. a new source format the plugin can parse) |
| PATCH | Bug fix, docs, refactor, test-only change |

If the plugin's `CHANGELOG.md` already has an `## [Unreleased]` section, its bullets are
your source of truth for both the bump and the release notes — don't re-derive from scratch.

---

## Step 2 - Precheck

```bash
git status                          # working tree must be clean, or only contain the intended release edits
```

Any unrelated in-flight work (modified files, untracked docs, etc.) must be committed
separately **before** starting the release — the release commit(s) should contain only the
version bump for that plugin. Don't fold unrelated changes into a `chore(release)` commit.

Run each released plugin's smoke test if one exists:

```bash
find plugins/<plugin> -name smoke_test.py
python3 plugins/<plugin>/skills/<plugin>/scripts/smoke_test.py   # path varies; use the found path
```

Skip cleanly (no failure) if a plugin has no smoke test.

---

## Step 3 - Per-plugin release edits

Repeat for each plugin in this run.

**`plugins/<plugin>/.claude-plugin/plugin.json`** - set `"version"` to the release version:

```json
"version": "X.Y.Z"
```

Plain version, no `-SNAPSHOT` suffix exists in this repo's convention - this is a direct
edit, not a strip.

**`plugins/<plugin>/CHANGELOG.md`** - Keep a Changelog style, semver headers, `YYYY-MM-DD`
dates:

- If an `## [Unreleased]` section exists, rename it to `## [X.Y.Z] - YYYY-MM-DD` (today's
  date via `date +%F`), keeping its `### Added` / `### Changed` / `### Fixed` subsections
  and bullets as-is.
- If no `[Unreleased]` section exists, insert a new section directly below the file's intro
  line (above the previous newest entry):
  ```
  ## [X.Y.Z] - YYYY-MM-DD

  ### Added
  - bullet describing what changed
  ```
  Derive bullets from `git log` (Step 1) plus reading the actual diffs for anything
  non-obvious from commit subjects alone.

---

## Step 4 - Commit on `main`

One commit per plugin, so each tag lands on the right commit and the log stays scoped
(matches this repo's `chore(<plugin>): ...` convention):

```bash
git add plugins/<plugin>/.claude-plugin/plugin.json plugins/<plugin>/CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(<plugin>): release vX.Y.Z

- bullet one (from the CHANGELOG entry)
- bullet two
EOF
)"
```

After all plugins in this run are committed:

```bash
git push origin main
```

---

## Step 5 - Tag on `main`

**This step is irreversible. Never move a published tag.**

Per plugin, after the push:

```bash
grep '"version"' plugins/<plugin>/.claude-plugin/plugin.json   # confirm it shows bare X.Y.Z

git tag -a <plugin>-vX.Y.Z -m "<plugin> vX.Y.Z: <one-line summary of the release>"
git push origin <plugin>-vX.Y.Z
```

Guards:
- Tag only on `main`.
- Tag name is namespaced with the plugin (`<plugin>-vX.Y.Z`), never a bare `vX.Y.Z` -
  plugins version independently, so an unqualified tag would be ambiguous across plugins.
- Tag version must equal that plugin's `plugin.json` `"version"` field.
- Tags are always annotated (`-a`), never lightweight.

---

## Step 6 - Verify

```bash
git status                        # clean
git log --oneline -N              # shows the chore(<plugin>): release commit(s)
git tag --list '<plugin>-v*'      # new tag present, for each released plugin
```

No next-version bump step here - this repo has no SNAPSHOT convention. New work simply
accumulates under a fresh `## [Unreleased]` section in the plugin's CHANGELOG as it lands.

---

## Common mistakes

| Mistake | Effect |
|---|---|
| Folded unrelated changes into the release commit | Release commit no longer scoped to the version bump; harder to review/revert |
| Forgot to date the CHANGELOG header (left `[Unreleased]`) | Release not recorded; next run may double-insert |
| Bumped `plugin.json` but not `CHANGELOG.md` (or vice versa) | Version surface inconsistency between the two files |
| Used a bare `vX.Y.Z` tag instead of `<plugin>-vX.Y.Z` | Collides across plugins with independent version numbers |
| Lightweight tag instead of annotated | Missing the release annotation/summary |
| Tagged before pushing the release commit | Tag points at a commit not yet on `origin/main` |
| Touched `marketplace.json` "to keep versions in sync" | It carries no version field at all - nothing to sync |
| Moved a published tag | Consumers pinned to it break - never do this |
