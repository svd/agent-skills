#!/usr/bin/env python3
"""
Self-check for check_directory_rules.py. Pure stdlib. Builds a throwaway plugin in a temp git
repo for every rule, once with the violation and once clean, and runs the checker on it.

Usage:
  python3 tools/smoke_test_directory_rules.py
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TOOL = Path(__file__).resolve().parent / "check_directory_rules.py"
sys.path.insert(0, str(TOOL.parent))
import check_directory_rules as cdr  # noqa: E402

results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not condition else ""))


def run(args, cwd):
    r = subprocess.run([sys.executable, str(TOOL), "--json", "--fail-on", "warn"] + args,
                       capture_output=True, text=True, cwd=cwd, check=False)
    try:
        findings = json.loads(r.stdout or "[]")
    except ValueError:
        findings = [{"rule": "CRASH", "level": "block", "message": r.stdout + r.stderr, "file": "", "line": 0}]
    return r.returncode, findings


def rules(findings, level=None):
    return {f["rule"] for f in findings if level is None or f["level"] == level}


def show(findings):
    return "; ".join(f"{f['file']}:{f['line']} {f['level']} {f['rule']} {f['message']}" for f in findings)


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


README = """# demo

Demo is a small plugin that exists only for this smoke test. It watches nothing, sends nothing
and stores nothing; it registers a few hooks that pass each event on unchanged, so that the
directory checker has something realistic to read. The words here only need to clear the
forty-word floor that the directory sets for a README.

## What it runs, reads, writes and sends

Nothing leaves the machine. It runs no programs and writes no files.

| Hook | What it does |
| --- | --- |
| `session.start` | Passes the event on unchanged. |
"""

REGISTER = """import type { Register } from 'claude-code'

function stamp($: EngineInterface): Promise<number> {
  return $.clock.now()
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await stamp($)
    return next(e)
  })
}
"""


def make_plugin(tmp, name, files=None, manifest=None):
    """A clean plugin at <tmp>/<name>/repo/plugins/demo, committed and tagged demo-v0.1.0."""
    repo = tmp / name / "repo"
    plugin = repo / "plugins" / "demo"
    m = {"name": "demo", "version": "0.1.0", "description": "Demo plugin.",
         "author": {"name": "Demo Author"}, "license": "MIT"}
    m.update(manifest or {})
    base = {
        ".claude-plugin/plugin.json": json.dumps({k: v for k, v in m.items() if v is not None}, indent=2),
        "README.md": README,
        "LICENSE": "MIT License\n",
        "hooks/hooks.json": '{ "modules": ["./register.tsx"] }\n',
        "hooks/register.tsx": REGISTER,
        "skills/demo/SKILL.md": "---\nname: demo\ndescription: Demo skill for the smoke test.\n---\n\nBody.\n",
    }
    base.update(files or {})
    for rel, content in base.items():
        if content is None:
            continue
        path = plugin / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "smoke@test.local")
    git(repo, "config", "user.name", "smoke")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    git(repo, "tag", "-a", "demo-v0.1.0", "-m", "demo v0.1.0")
    return repo, plugin


def files_case(plugin, rel, text):
    path = plugin / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return run(["files", str(path)], plugin)


def png(size):
    """A complete PNG padded with an ancillary chunk to about `size` bytes."""
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0)
    pad = chunk(b"tEXt", b"pad\0" + b"x" * max(0, size - 80))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + pad + chunk(b"IDAT", zlib.compress(b"\0\0")) + chunk(b"IEND", b"")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # ---- clean baseline -------------------------------------------------------------
        repo, plugin = make_plugin(tmp, "clean")
        rc, f = run(["plugin", str(plugin)], repo)
        bad = [x for x in f if x["level"] != "note"]
        check("baseline: clean plugin has no block/hold/warn", not bad and rc == 0, show(bad))

        # ---- R1 h / Fragment ------------------------------------------------------------
        repo, plugin = make_plugin(tmp, "r1")
        r1_bad = {
            "stamp(l.holds, ids, h => ({ ...h }))": "stamp(l.holds, ids, h => ({ ...h }))\n",
            "function stamp(..., fn: (h: Hold) => Hold)": "function stamp(xs: Hold[], fn: (h: Hold) => Hold): void {}\n",
            "const h = ...": "const h = holds[0]\n",
            "import { Fragment }": "import { Fragment } from 'react'\n",
            "function h() declared": "function h(): void {}\n",
        }
        for i, (label, code) in enumerate(r1_bad.items()):
            rc, f = files_case(plugin, f"hooks/r1bad{i}.tsx", code)
            check(f"R1 flags {label}", "R1" in rules(f, "block") and rc == 1, show(f))
        r1_clean = {
            "h inside a string": "const s = 'h'\nconst d = \"h\"\n",
            "h inside a comment": "// h is the JSX factory\n/* h */\nconst x = 1\n",
            "h inside a template literal": "const t = `h and ${x} and h`\n",
            "member x.h": "const v = x.h + y?.h\n",
            "object key { h: 1 }": "const o = { h: 1, g: 2 }\n",
            "call h(...)": "const el = h('div', null)\n",
        }
        for i, (label, code) in enumerate(r1_clean.items()):
            rc, f = files_case(plugin, f"hooks/r1ok{i}.tsx", code)
            check(f"R1 clean: {label}", "R1" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r1ts.ts", "const h = 1\n")
        check("R1 skips .ts files", "R1" not in rules(f), show(f))

        # ---- R2 $ and on ----------------------------------------------------------------
        r2_bad = {
            "parameter named after a function that takes $":
                "function persist($: E, k: string): void {}\nfunction setCache(persist: boolean): void {}\n",
            "{ $ }": "function f($: E): void {\n  g({ $ })\n}\nfunction g(x: unknown): void {}\n",
            "const x = $": "function f($: E): void {\n  const x = $\n}\n",
            "$ in an array": "function f($: E): void {\n  g([$])\n}\nfunction g(x: unknown): void {}\n",
            "$ to an imported function": "import { g } from './g'\nfunction f($: E): void {\n  g($)\n}\n",
            "$ to a method": "function f($: E): void {\n  obj.g($)\n}\n",
            "$.state['get']": "function f($: E): void {\n  $.state['get']('k')\n}\n",
            "on(...) not on its own line":
                "export const register: Register = (on, options) => {\n  void 0; on('session.start', async ($, e, next) => next(e))\n}\n",
            "on passed to an imported function":
                "import { wire } from './wire'\nexport const register: Register = (on, options) => {\n  wire(on)\n}\n",
        }
        for i, (label, code) in enumerate(r2_bad.items()):
            rc, f = files_case(plugin, f"hooks/r2bad{i}.tsx", code)
            check(f"R2 flags {label}", "R2" in rules(f, "block") and any(x["code"] == cdr.CAPABILITY_CODE for x in f), show(f))
        r2_clean = {
            "$.noun.method() and $ to a top-level function":
                "function f($: E): Promise<void> {\n  return $.state.get('k')\n}\nasync function g<K extends Key>($: E, k: K): Promise<void> {\n  await f($)\n  await quietly(() => f($))\n}\n",
            "on(...) each on its own line": REGISTER,
            "$ inside strings and template literals": "const a = '$'\nconst b = `${x} costs $5`\n",
            "$ and on as bare arrow parameters":
                "export const PEEK: Plugin = {\n  name: 'peek',\n  register: on => {\n    on('command.run', { command: 'peek' }, async $ => {\n      return { text: String(await $.clock.now()) }\n    })\n  },\n}\n",
        }
        for i, (label, code) in enumerate(r2_clean.items()):
            rc, f = files_case(plugin, f"hooks/r2ok{i}.tsx", code)
            check(f"R2 clean: {label}", "R2" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r2.test.ts", "const x = $\n")
        check("R2 skips test files", "R2" not in rules(f), show(f))

        # ---- R3 ui.render in the entry module ----------------------------------------------
        repo, plugin = make_plugin(tmp, "r3bad", {
            "hooks/band.tsx": "export function wire(on: On): void {\n  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => next(e))\n}\n",
            "hooks/register.tsx": REGISTER.replace("return next(e)", "$.ui.resolve(e)\n    return next(e)"),
        })
        rc, f = run(["plugin", str(plugin)], repo)
        check("R3 flags ui.render registered outside the entry module", "R3" in rules(f, "block"), show(f))
        repo, plugin = make_plugin(tmp, "r3ok", {
            "hooks/register.tsx": REGISTER.replace("  })\n}\n", "  })\n\n  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {\n    $.ui.resolve(e)\n    return next(e)\n  })\n}\n"),
        })
        rc, f = run(["plugin", str(plugin)], repo)
        check("R3 clean: ui.render registered in register.tsx", "R3" not in rules(f), show(f))

        # ---- R4 __proto__ ----------------------------------------------------------------
        rc, f = files_case(plugin, "hooks/proto.ts", "const bad = new Set(['__proto__'])\n")
        check("R4 flags __proto__ in a .ts file", "R4" in rules(f, "block"), show(f))
        rc, f = files_case(plugin, "hooks/proto.test.ts", "JSON.parse('{\"__proto__\": {}}')\n")
        check("R4 clean: __proto__ in a test file", "R4" not in rules(f), show(f))

        # ---- R5 pipe to shell ---------------------------------------------------------------
        rc, f = files_case(plugin, "docs/install.md", "Install: `curl -fsSL https://example.com/x | sh`\n")
        check("R5 flags curl x | sh in a .md file", "R5" in rules(f, "block"), show(f))
        rc, f = files_case(plugin, "hooks/fixture.test.ts", "const cmd = 'wget -qO- https://e.com/i | bash'\n")
        check("R5 flags wget | bash in a test fixture", "R5" in rules(f, "block"), show(f))
        rc, f = files_case(plugin, "docs/ok.md", "Download with `curl -o x.tgz https://example.com/x.tgz`.\n")
        check("R5 clean: curl without a pipe to a shell", "R5" not in rules(f), show(f))

        # ---- R6 agent.spawn parameter names ---------------------------------------------------
        spawn = "export const register: Register = (on, options) => {\n  on('turn.start', async ($, e, next) => next(e))\n\n  on('agent.spawn', async ($, {e}, {n}) => {n}({e}))\n}\n"
        rc, f = files_case(plugin, "hooks/r6bad.tsx", spawn.replace("{e}", "e").replace("{n}", "next"))
        check("R6 warns on agent.spawn sharing e/next", "R6" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r6ok.tsx", spawn.replace("{e}", "spawnEvent").replace("{n}", "passSpawn"))
        check("R6 clean: unique agent.spawn names", "R6" not in rules(f), show(f))

        # ---- official: files in the plugin folder -------------------------------------------------
        def plugin_case(label, files, rule, level, manifest=None, setup=None):
            repo, plugin = make_plugin(tmp, label.replace(" ", "_").replace("/", "_"), files, manifest)
            if setup:
                setup(repo, plugin)
            rc, f = run(["plugin", str(plugin)], repo)
            hit = any(x["rule"] == rule and x["level"] == level for x in f)
            check(f"{rule} {label}", hit if level else rule not in rules(f), show(f))

        plugin_case("flags .DS_Store", {".DS_Store": b"\0\0\0\1Bud1"}, "O1", "block")
        plugin_case("flags file of 260 KiB", {"docs/big.md": "x" * (260 * 1024)}, "O8", "hold")
        plugin_case("warns on file of 210 KiB", {"docs/big.md": "x" * (210 * 1024)}, "O8", "warn")
        plugin_case("clean: 300 KiB PNG image", {"assets/shot.png": png(300 * 1024)}, "O8", None)
        plugin_case("flags .zip binary", {"assets/x.zip": b"PK\x03\x04\0\0"}, "O9", "hold")
        plugin_case("flags Windows device name", {"docs/con.md": "x\n"}, "O3", "block")
        plugin_case("flags trailing dot", {"docs/notes.": "x\n"}, "O3", "block")
        plugin_case("flags more than 512 files", {f"docs/f{i}.md": "x\n" for i in range(513)}, "O7", "hold")
        plugin_case("flags export-ignore", {".gitattributes": "docs export-ignore\n"}, "O5", "block")
        plugin_case("flags symlink", {}, "O2", "block",
                    setup=lambda repo, plugin: (os.symlink("../README.md", plugin / "skills" / "link.md"),
                                                git(repo, "add", "-A"), git(repo, "commit", "-q", "-m", "link")))
        plugin_case("flags image in a command", {"assets/i.png": png(200), "commands/c.md": "---\ndescription: c\n---\nShow assets/i.png\n"}, "O10", "hold")
        plugin_case("flags image path in backticks", {"assets/i.png": png(200), "docs/x.md": "See `assets/i.png`.\n"}, "O10", "hold")
        plugin_case("clean: image by Markdown syntax in README", {"assets/i.png": png(200), "README.md": README + "\n![shot](assets/i.png)\n"}, "O10", None)

        # case pair: macOS folders are case-insensitive, so check the name rule directly
        out = []
        cdr.check_names(["docs/a.md", "docs/A.md"], out, "")
        check("O3 flags names that differ only by capitalization", any(x.rule == "O3" for x in out), "")

        # ---- official: manifest, README, license, hooks.json, front matter ----------------------------
        plugin_case("flags reserved name `test`", {}, "O17", "block", {"name": "test"})
        plugin_case("warns on uppercase name", {}, "O17", "warn", {"name": "Demo"})
        plugin_case("flags generic-only name", {}, "O17", "hold", {"name": "test-plugin"})
        plugin_case("warns without version", {}, "O18", "warn", {"version": None})
        plugin_case("flags mixed writing systems in author.name", {}, "O19", "block", {"author": {"name": "Dеmo"}})
        plugin_case("flags component key in experimental", {}, "O20", "block", {"experimental": {"hooks": "./h.json"}})
        plugin_case("flags path outside the plugin", {}, "O21", "block", {"commands": "../other"})
        plugin_case("flags short README", {"README.md": "# demo\n\nToo short.\n\n```\n" + "word " * 50 + "\n```\n"}, "O24", "block")
        plugin_case("flags missing license", {"LICENSE": None}, "O25", "block", {"license": None})
        plugin_case("flags invalid hooks.json", {"hooks/hooks.json": "{ modules: [] }"}, "O26", "block")
        plugin_case("flags hooks.json without hooks or modules", {"hooks/hooks.json": "{}"}, "O26", "block")
        plugin_case("flags description as a list", {"skills/demo/SKILL.md": "---\nname: demo\ndescription:\n  - a\n  - b\n---\n"}, "O11", "block")
        plugin_case("flags unquoted `: ` in front matter", {"skills/demo/SKILL.md": "---\nname: demo\ndescription: Use it: always\n---\n"}, "O11", "block")
        plugin_case("clean: quoted `: ` in front matter", {"skills/demo/SKILL.md": "---\nname: demo\ndescription: \"Use it: always\"\n---\n"}, "O11", None)

        # ---- official: launchers, secrets, hook paths ---------------------------------------------
        plugin_case("flags unpinned npx", {"scripts/run.sh": "npx some-pkg --help\n"}, "O12", "block")
        plugin_case("clean: pinned npx", {"scripts/run.sh": "npx some-pkg@1.2.3 --help\n"}, "O12", None)
        plugin_case("flags uv run without --locked", {"scripts/run.sh": "uv run tool.py\n"}, "O12", "block")
        plugin_case("clean: uv run --locked", {"scripts/run.sh": "uv run --locked tool.py\n"}, "O12", None)
        plugin_case("flags a GitHub token", {"docs/x.md": "token: ghp_" + "a1" * 18 + "\n"}, "O13", "block")
        plugin_case("flags $HOME in a hook command", {"hooks/hooks.json": json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "$HOME/x.sh"}]}]}})}, "O14", "block")
        plugin_case("clean: ${CLAUDE_PLUGIN_ROOT} hook command", {"hooks/hooks.json": json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/x.sh"}]}]}})}, "O14", None)
        plugin_case("flags .npmrc with a launcher", {"scripts/run.sh": "npx a@1.0.0\n", ".npmrc": "registry=https://r.example\n"}, "O15", "block")
        plugin_case("flags minified source", {"hooks/min.js": ("var a=1;" * 700 + "\n") * 2}, "O16", "hold")

        # ---- P1-P2 release -----------------------------------------------------------------------
        repo, plugin = make_plugin(tmp, "release")
        reg = plugin / "hooks" / "register.tsx"
        reg.write_text(REGISTER.replace("return $.clock.now()", "await $.fs.write('x', '')\n  return $.clock.now()"))
        git(repo, "commit", "-qam", "feat: write")
        rc, f = run(["release", str(plugin)], repo)
        check("P1 flags a change without a version bump", "P1" in rules(f, "block"), show(f))
        check("P2 flags a new capability call without a README change", "P2" in rules(f, "block")
              and any("$.fs.write" in x["message"] for x in f), show(f))
        man = plugin / ".claude-plugin" / "plugin.json"
        man.write_text(man.read_text().replace('"0.1.0"', '"0.1.1"'))
        (plugin / "README.md").write_text(README + "\nIt writes the file `x`.\n")
        git(repo, "commit", "-qam", "chore: release")
        rc, f = run(["release", str(plugin)], repo)
        check("P1/P2 clean after bump and README update", not rules(f) & {"P1", "P2"}, show(f))
        reg.write_text(reg.read_text().replace("  })\n}\n", "  })\n\n  on('tool.call', async ($, e, next) => next(e))\n}\n"))
        git(repo, "commit", "-qam", "feat: tool hook")
        rc, f = run(["release", str(plugin), "--since", "demo-v0.1.0"], repo)
        check("P2 flags a new hook missing from the README table", any(x["rule"] == "P2" and "tool.call" in x["message"] for x in f), show(f))

    failed = [name for name, ok, _ in results if not ok]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} checks passed.")
    if failed:
        print("Failed: " + ", ".join(failed))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
