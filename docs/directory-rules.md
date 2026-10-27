# Plugin directory rules

The rules a plugin in this repo has to meet before it goes to the claude.ai plugin directory
(claude.ai/directory), and the checker that tests them:
[`tools/check_directory_rules.py`](../tools/check_directory_rules.py).

```bash
python3 tools/check_directory_rules.py files <path>...          # R1-R7 on these files (editor hook)
python3 tools/check_directory_rules.py plugin plugins/<name>     # official rules + R1-R7
python3 tools/check_directory_rules.py release plugins/<name>    # plugin + P1-P2 since the last <name>-v* tag
python3 tools/smoke_test_directory_rules.py                      # the checker's own tests
```

Output is one line per finding, `file:line LEVEL RULE message`. `RULE` is the portal's code where
the portal has one (`MOD_CAPABILITY_USE_NOT_PLAIN`), else the rule id below. `--json` prints the
findings as JSON; `--fail-on block|hold|warn` (default `block`) sets the lowest level that makes
the exit code 1.

## Levels

As the portal's report gives them
([Read a validation result](https://claude.com/docs/plugins/pre-submission-checklist#read-a-validation-result)):

| Level | Report | Meaning |
| --- | --- | --- |
| `block` | **Blocking** | The plugin can't be submitted until it is fixed. |
| `hold` | **Policy hold** | It can be submitted; an Anthropic reviewer reads the version before it goes live. The scan can raise the same hold on each new version. |
| `warn` | Warning | Shown; submitting is allowed. |
| `note` | Note | Information; nothing to fix. |

Some checks stop validation before there is a report ("Validation stops", **Couldn’t validate
that repository** or **Repository too large to validate**). The checker reports them as `block`
and says "validation stops" in the message.

## Sources

Each rule names its source:

- **official** — the public
  [Plugin pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist),
  with the section the rule comes from.
- **portal-finding** — a finding the developer portal raised on one of our plugins: the code,
  the plugin version it was raised on, and the fix (commit, version, date).
- **inferred** — our own reading, not confirmed by the directory's text.

Checklist sections without their own anchor are linked through
[Review what validation and the scan check](https://claude.com/docs/plugins/pre-submission-checklist#review-what-validation-and-the-scan-check)
and named.

## Official rules

The plugin folder is the folder that holds `.claude-plugin/plugin.json`.

### Repository and folder layout

Source: official, *Review what validation and the scan check › Repository and folder layout*.

| Id | Rule | Level |
| --- | --- | --- |
| O1 | No `.DS_Store`, `Thumbs.db`, `desktop.ini` or `__MACOSX` entries in the plugin folder. | block |
| O2 | Regular files and folders for everything the plugin loads: no symbolic links, Git submodules or Git LFS pointer files. | block where the plugin loads the entry; warn elsewhere |
| O3 | File and folder names valid on both Windows and macOS: no colon, no trailing dot or space, no Windows device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, with any extension, such as `con.md`), no two names that differ only by capitalization. | block (validation stops) |
| O4 | Every folder on the path to the plugin is named with letters, digits, dots, hyphens and underscores only. | block (validation stops) |
| O5 | No `export-ignore` or `export-subst` in any `.gitattributes`. No `filter` (Git LFS included) or other attribute that rewrites file contents in a `.gitattributes` at the repository root, above the plugin folder, or inside it. | block (validation stops) |
| O6 | Repository under 50 MiB as GitHub archives it, under 256 MiB unpacked, with fewer than 10,000 files and folders; every file in the plugin folder under 5 MiB. | block (validation stops) |

The checker reads the attributes `filter`, `ident`, `working-tree-encoding`, `eol`, `text` and
`crlf` as the ones that rewrite file contents (inferred: the checklist names only `filter`). It
measures the archive with `git archive --format=tar.gz HEAD`, so the 50 MiB figure is an
estimate of GitHub's. O2 treats `hooks/`, `skills/`, `commands/`, `agents/`, `scripts/`,
`bin/`, `output-styles/`, `.claude-plugin/`, `.mcp.json` and `.lsp.json` as what the plugin
loads (inferred).

### Files in the plugin folder

Source: official,
[Files in the plugin folder](https://claude.com/docs/plugins/pre-submission-checklist#files-in-the-plugin-folder).
These apply to every file in the plugin folder, images and documents included.

| Id | Rule | Level |
| --- | --- | --- |
| O7 | 512 files or fewer. | hold |
| O8 | Every file that isn't an image or font under 256 KiB. | hold |
| O8 | A file from 200 KiB up gets an early warning. **Source: inferred** — not in the checklist. | warn |
| O9 | Only text files (SVG included), complete PNG, JPEG, GIF and WebP images, and font files. Any other binary (`.ico`, `.pdf`, `.zip`, an executable) is held. | hold |
| O10 | A bundled image is shown in the README with Markdown image syntax only; no bundled image or font is referred to from commands, hooks or scripts, or written in backticks or a code block. | hold |

### Manifest and plugin name

Source: official, *Review what validation and the scan check › Manifest and plugin name*.
The checklist also says: "raise `version` with every release" (see P1).

| Id | Rule | Level |
| --- | --- | --- |
| O17 | `name` made of lowercase letters, digits and hyphens, up to 64 characters, starting and ending with a letter or digit. | block for non-ASCII (**Non-ASCII identifier**); warn for any other break |
| O17 | `name` is not a reserved word as the whole name: `claude`, `anthropic`, `official`, `plugin`, `mcp`, `test`. | block (**Name is taken**) |
| O17 | `name` is not made only of generic words, such as `test-plugin`. | hold (**Name may be confused with an existing listing**) |
| O18 | `description`, `author` and `version` are set. | warn |
| O19 | `displayName` and `author.name` in one writing system, without look-alike letters or invisible characters. | block |
| O20 | Component keys (`commands`, `agents`, `skills`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`) spelled exactly, and not inside `experimental`. | block |
| O21 | Every component path in `plugin.json` points inside the plugin folder. (Same section: *Repository and folder layout*.) | block |

Fields the portal reports on `plugin.json` (source: portal-finding, ctx-guard 0.6.0, c53a5dc):

| Code | Rule | Level |
| --- | --- | --- |
| `UNKNOWN_KEY` | A top-level field not in the [plugins reference](https://code.claude.com/docs/en/plugins-reference) (read 2026-10-27), one finding per field. | warn |
| `UNKNOWN_KEY` | `documentationUrl`, `supportUrl` and `types`: the reference lists them, yet the portal raised "Unrecognized field in plugin.json" on each. `types` is the mod's `PluginState` contract. | note |
| `MANIFEST_FOREIGN_FIELD` (**provisional** code) | `icon`: "Field from another tool's manifest"; the directory reads it for the listing, Claude Code ignores it. | note |
| `BINARY_PASSED` (**provisional** code) | Each complete image or font: "Images and fonts passed without a code check" (their printable text is still screened). | note |
| `USES_HOOKS` (**provisional** code) | `hooks/hooks.json` exists: "Uses hooks", information only. | note |

The checker counts a name as generic-only when every hyphen-separated word is one of the reserved
words (inferred). Name collisions with other listings, brands and forks need the directory's
data and are not checked.

### README and license

Source: official, *Review what validation and the scan check › README and license*.

| Id | Rule | Level |
| --- | --- | --- |
| O24 | A README of at least 40 words in the plugin folder, preferably `README.md`; words inside code blocks don't count. | block (**README missing**, **README too short**) |
| O25 | A `LICENSE` file in the plugin folder, or `license` in `plugin.json`. | block (**License missing**) |

### What the plugin runs and connects to

Source: official, *Review what validation and the scan check › Review what the plugin runs and
connects to*. A launcher is `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `uvx`, `pipx run` or `uv run`.

| Id | Rule | Level |
| --- | --- | --- |
| O12 | Every package a launcher runs is pinned to an exact version (`npx <package>@1.2.3`, `uvx <package>==1.2.3`); `uv run` runs with `--locked` or `--frozen`. | block |
| O13 | No real credentials in any file, documentation and examples included. | block |
| O13 | No credential read from the user's environment (such as `$GITHUB_TOKEN`) and sent to a server, even in a README example. | hold |
| O14 | In a hook's or MCP server's command, every path written in full from `${CLAUDE_PLUGIN_ROOT}`, with no other variable, command substitution, wildcard or inline program (`python3 -c`). | block when the plugin folder is a subfolder of the repository |
| O15 | No package-manager configuration that sets a package source (`.npmrc`, `bunfig.toml`, `uv.toml`) in a plugin that uses a launcher or runs a package install. | block with a launcher; hold with an install |
| O23 | `.mcp.json` is valid JSON; a remote MCP server's `url` is `https://`, `wss://`, a `${user_config.KEY}` reference or `""`. | block |

The checker looks for launchers in scripts, `plugin.json`, `.mcp.json`, `hooks/hooks.json`,
`.lsp.json`, and the `` !`…` `` lines of skills, commands and agents. Its secret patterns cover
common token formats (AWS, GitHub, Anthropic, OpenAI-style `sk-`, Slack, Google API keys, private
keys); it is not a full secret scanner.

### Hooks, skills, commands and agents

Source: official, *Review what validation and the scan check › Hooks, skills, commands, and
agents*.

| Id | Rule | Level |
| --- | --- | --- |
| O26 | `hooks/hooks.json` is valid JSON with a top-level `hooks` object, a `modules` array for a mod, or both; each HTTP hook has an `https://` URL. | block (**hooks.json is invalid**) |
| O22 | `hooks/hooks.json` is left out of the `hooks` field in `plugin.json`. | warn |
| O11 | Valid YAML front matter in each skill, command and agent file, with `description` as a single text value, not a list. | block; warn for no front matter or no `description` |

The checker has no YAML library: it finds the front-matter errors seen in practice (a line that is
not `key: value`, an unquoted `: ` in a plain value, an unclosed quote, a `description` that is a
list or mapping), not every YAML error.

### Security scan

Source: official,
[Prepare for the security scan](https://claude.com/docs/plugins/pre-submission-checklist#prepare-for-the-security-scan).

| Id | Rule | Level |
| --- | --- | --- |
| O27 | The README describes everything the plugin runs, sends or fetches. | not checked as such; see below |
| O16 | Readable source, not compiled, packed or minified code. Code the scan can't read is held. | hold |

For a mod, the checker reports the Policy holds the portal raised on ctx-guard as `note`, and
warns (O27) when the README has no section "What it runs, reads, writes and sends" to answer
them. Which capability call raises which hold is inferred. O16 counts a source file as minified
when it is over 4 KiB with lines averaging over 200 characters (inferred).

## Mod rules (portal findings)

For mods: plugins whose `hooks/hooks.json` has `modules`. The checker applies R1, R2, R6 and R7 to
the plugin's `.ts`/`.tsx`/`.js`/`.jsx` sources; it skips test files (`*.test.*`, `*.spec.*`),
which no module imports (inferred: the portal has not flagged ours). Before searching, it blanks
comments, string and regex literals, and template-literal text (the code inside `${…}` stays).

| Id | Rule | Level | Source |
| --- | --- | --- | --- |
| R1 | In `.tsx`/`.jsx`, the names `h` and `Fragment` are never declared or used as a value: no parameter, variable, function, import, assignment or destructuring. `h` may only be called. Object keys (`{ h: 1 }`) and members (`x.h`) are fine. | block | portal-finding `MOD_CAPABILITY_USE_NOT_PLAIN` on ctx-guard 0.1.0, fixed in 0.2.0 (70e93e3, 2026-10-15); again on 0.4.0, fixed in 0.4.1 (e170ff7, 2026-10-21) |
| R2 | The directory's text: "Write each call on the capability object as `$.noun.method(...)`, each registration as `on("event", hook)` on a line of its own, and pass `$` or the `on` function only as one whole argument to a function declared at the top of the same file." So: no alias of `$`, no `$` in an object or array, no `$` passed to an imported function or a method; each `on(...)` on its own line. | block | portal-finding `MOD_CAPABILITY_USE_NOT_PLAIN` (directory text) |
| R2 | The name of a top-level function that receives `$` is used for nothing else in the file. | block | portal-finding `MOD_CAPABILITY_USE_NOT_PLAIN` on ctx-guard 0.3.0 (a `setCache` parameter named `persist`), fixed in 0.3.1 (c56cb24, 2026-10-17) |
| R3 | `ui.render` is registered in the entry module named in `hooks/hooks.json` (`register.tsx`), not in a module it imports. | block | portal-finding on ctx-guard 0.1.0, fixed in 0.2.0 (82c2c23, 2026-10-15) |
| R4 | No `__proto__` literal in non-test `.ts`/`.tsx`. | block | portal-finding on ctx-guard 0.1.0, fixed in 0.2.0 (61b9589, 2026-10-15). That tests and the JSON schema are exempt is **inferred**: the portal passed them |
| R5 | No pipe-to-shell (`curl … \| sh`, `wget … \| bash`) anywhere in the plugin folder, docs and test fixtures included. | block | portal-finding on ctx-guard 0.1.0, fixed in 0.2.0 (10dab1f, 2026-10-15) |
| R6 | An `agent.spawn` hook passes its own event to `next` unchanged and names its parameters with names used nowhere else in the file. | warn | **inferred**, from the `agent.spawn` fix in ctx-guard 0.2.0 (0bb0909, 2026-10-15) |
| R7 | A hook on `config.set`, `agent.register`, `command.run`, `fs.write`, `tool.check`, `classic.PreToolUse` or `classic.PermissionRequest` passes its own event to `next` unchanged (not rebuilt or destructured; no assignment, `++`, `delete` or `Object.assign` on it), does not hand `next` on as a value, and names its event and `next` parameters with names used nowhere else in the file. A `.catch(...)` handler chained on the registration counts as part of the hook. `permissionMode` in `$.agent.register` or `$.agent.spawn` options is the literal `'default'`. | warn | **inferred**, from the portal's permission hold on ctx-guard 0.2.0, 0.3.1, 0.5.0 and 0.6.0 |

Which events count is **inferred** from the types: these are the calls whose hook can change
what is permitted. The portal names one line per version, the first such hook in the file: the
changed `next({ ...e, args })` in the `ctx-guard:resume` hook up to 0.5.0, the registration of a
`command.run` hook that passes `e` on unchanged but shares the names `e` and `next` in 0.6.0. So
the checker reports a hook that passes something changed at each such `next(...)` call and no
name finding for it; a hook that only shares names is reported at its registration. Whether the
portal exempts `return next(e)` with shared names is unknown. R6 is the same check for
`agent.spawn`, under its own id.

Limits: a nested function inside the hook that reuses the `next` name counts as handing `next`
on; options built in a variable and passed as `$.agent.register(spec)` are not checked for
`permissionMode`.

No call or setting changes Remote Control: the types only report it, as `origin.kind: 'bridge'`.
The checker has nothing to look for there.

### Expected Policy holds

Not blockers. The portal holds a mod that uses these capabilities for a reviewer; the README
section "What it runs, reads, writes and sends" answers each one.

| Code | Raised by (inferred) |
| --- | --- |
| `MOD_WRITES_BUILD_FILE` | `$.fs.write` |
| `MOD_LOCAL_DATA_LEAVES` | `$.process.run`, `$.model.fork`, `$.prompt.submit` |
| `MOD_SESSION_DATA_LEAVES` | `$.process.run`, `$.model.fork`, `$.prompt.submit` |
| `MOD_PROCESS_COMMAND_COMPUTED` | `$.process.run` with a command built at run time |
| `MOD_RUNS_PROCESS` | `$.process.run` |

## Release rules

Source: official, "raise `version` with every release" (*Manifest and plugin name*) and "Describe
in the README everything the plugin runs, sends, or fetches"
([Prepare for the security scan](https://claude.com/docs/plugins/pre-submission-checklist#prepare-for-the-security-scan)).
The directory scans each new commit on the branch it follows, so every push to `main` that
changes a plugin is a release to it.

`release` compares the last `<plugin>-v*` tag (or `--since <tag>`) with the working tree.

| Id | Rule | Level |
| --- | --- | --- |
| P1 | A change to the plugin folder since the tag raises `version` in `plugin.json` above the tag's. | block |
| P2 | When the set of `$.noun.method` calls or `on(...)` hooks differs from the tag's, `README.md` changes in the same range (section "What it runs, reads, writes and sends" and the hook table), and each new hook's event appears in the README. The finding lists the calls and hooks added (`+`) and removed (`-`). | block |
