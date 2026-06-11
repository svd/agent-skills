# ~/.claude data model & command reference

## Layout

| Location | What it holds | Per-project? |
|---|---|---|
| `~/.claude.json` → `projects{<abs path>}` | Registered project: config, `mcpServers`, `enabledMcpjsonServers`, last-session `lastCost`/token snapshot, `lastSessionFirstPrompt` | keyed by absolute path |
| `~/.claude/projects/<encoded>/` | Session transcripts, one `<sessionId>.jsonl` each | encoded path |
| `~/.claude/todos/<sessionId>-*` | Saved todo lists | by session id |
| `~/.claude/file-history/<sessionId>/` | Edited-file backups | by session id |
| `~/.claude/history.jsonl` | Prompt history; each line has `project` (cwd) + `sessionId` | by `project` path |
| `~/.claude/shell-snapshots/` | `snapshot-zsh-<ts>-<rand>.sh` — **not** project-attributable | no |
| `<project>/.claude/{skills,agents,commands}` | Project-local skills/agents/commands | in the project tree, not `~/.claude` |
| `<project>/.mcp.json` | Project MCP servers | in the project tree |

## Path encoding

Session dir name = `re.sub(r'[^a-zA-Z0-9]', '-', absolute_path)` (case preserved).
So `/Users/x/src/staffing-assistant` → `-Users-x-src-staffing-assistant`, and
`/x/.worktrees/y` → `-x--worktrees-y` (the `/.` becomes `--`). The mapping is
forward-only and lossy — derive the dir from the real path in `~/.claude.json`,
never try to reverse an encoded name back to a path.

An **orphan session dir** is an encoded dir with no matching `~/.claude.json`
entry — usually a deleted/renamed checkout. Safe cleanup candidate.

## Token usage & cost

Each assistant line in a transcript carries `message.usage` with
`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, and `message.model`. `deepstats` sums these per model.

Static price table (USD per 1M tokens), matched by substring on the model id.
Cache write = 1.25× input, cache read = 0.1× input (standard Anthropic prompt-cache rates):

| Match | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| `fable` | 10 | 50 | 12.50 | 1.00 |
| `mythos` | 10 | 50 | 12.50 | 1.00 |
| `opus` | 5 | 25 | 6.25 | 0.50 |
| `sonnet` | 3 | 15 | 3.75 | 0.30 |
| `haiku` | 1 | 5 | 1.25 | 0.10 |

Covers Fable 5, Mythos 5, Opus 4.5–4.8, Sonnet 4.5/4.6, Haiku 4.5. `opus` rates are the
current Opus 4.5+ prices; the deprecated Opus 4 / 4.1 billed at 15/75 and still match the
`opus` key, so their cost would be under-reported. Models not matching any key (e.g.
`glm-5.1`, `<synthetic>`) are reported tokens-only and excluded from the dollar total.
Update `PRICING` in `scripts/projects.py` if rates change.

## Commands

```
projects.py list  [--cwd PATH]        # inventory all projects + orphans (JSON)
projects.py stats     --path PATH     # basic stats for one project
projects.py deepstats --path PATH     # per-model token usage + est. cost
projects.py traces    --path PATH     # removable trace categories + counts
projects.py remove    --path PATH --categories sessions,config,history,todos,filehistory \
                      [--backup] [--dry-run]
```

Removal categories: `sessions` (transcript dir), `config` (`.claude.json` entry),
`history` (matching `history.jsonl` lines), `todos`, `filehistory`. `--backup`
tars the targets — including the config entry and removed history lines — to
`~/.claude/backups/<slug>-<timestamp>.tar.gz` before deleting. Always pass it.

`remove` rewrites `~/.claude.json` when `config` is included; avoid while another
live session may write that file.
