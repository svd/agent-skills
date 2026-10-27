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

        # ---- R6/R7 hooks on permission events -------------------------------------------------
        def hook_mod(event, body, params="$, e, next"):
            return ("export const register: Register = (on, options) => {\n  on('turn.start', async ($, e, next) => next(e))\n\n"
                    f"  on('{event}', async ({params}) => {{\n{body}\n  }})\n}}\n")
        indirect = "    const r = await {n}({e})\n    return r"
        rc, f = files_case(plugin, "hooks/r6bad.tsx", hook_mod("agent.spawn", indirect.format(e="e", n="next")))
        check("R6 warns on agent.spawn sharing e/next", "R6" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r6ok.tsx", hook_mod("agent.spawn", indirect.format(e="spawnEvent", n="passSpawn"), "$, spawnEvent, passSpawn"))
        check("R6 clean: unique agent.spawn names", "R6" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r7changed.tsx", hook_mod("command.run", "    return passRun({ ...runEvent, args: '' })", "$, runEvent, passRun"))
        check("R7 warns on command.run passing a changed event", "R7" in rules(f, "warn") and any(x["line"] == 5 for x in f), show(f))
        rc, f = files_case(plugin, "hooks/r7mutated.tsx", hook_mod("fs.write", "    writeEvent.path = 'x'\n    return passWrite(writeEvent)", "$, writeEvent, passWrite"))
        check("R7 warns on fs.write mutating its event", "R7" in rules(f, "warn"), show(f))
        for label, body in [("+=", "    runEvent.n += 1"), ("++", "    runEvent.n++"), ("prefix ++", "    ++runEvent.n"),
                            ("delete", "    delete runEvent.args"), ("Object.assign", "    Object.assign(runEvent, { args: '' })")]:
            rc, f = files_case(plugin, "hooks/r7update.tsx", hook_mod("command.run", body + "\n    return passRun(runEvent)", "$, runEvent, passRun"))
            check(f"R7 warns on command.run event changed by {label}", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7compare.tsx", hook_mod("command.run", "    if (runEvent.n === 1 || runEvent.n == 2 || runEvent.n >= 3) return { text: 'no' }\n    return passRun(runEvent)", "$, runEvent, passRun"))
        check("R7 clean: comparisons on the event", "R7" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r7destructured.tsx", hook_mod("command.run", "    return passRun({ args })", "$, { args }, passRun"))
        check("R7 warns on a destructured event rebuilt for next", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7value.tsx", hook_mod("command.run", "    return later(passRun, runEvent)", "$, runEvent, passRun"))
        check("R7 warns on next handed on as a value", "R7" in rules(f, "warn"), show(f))
        for label, body in [("next?.()", "    return passRun?.({ ...runEvent })"), ("next.call", "    return passRun.call(null, runEvent)")]:
            rc, f = files_case(plugin, "hooks/r7call.tsx", hook_mod("command.run", body, "$, runEvent, passRun"))
            check(f"R7 warns on {label}", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7defaults.tsx", hook_mod("command.run", "    return passRun.called ? passRun(runEvent) : passRun(runEvent)", "$, runEvent = {}, passRun"))
        check("R7 clean: a parameter default and next.called", "R7" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r7shared.tsx", hook_mod("tool.check", indirect.format(e="e", n="next")))
        check("R7 warns on tool.check sharing e/next", "R7" in rules(f, "warn") and any(x["line"] == 4 for x in f), show(f))
        rc, f = files_case(plugin, "hooks/r7refuse.tsx", hook_mod("command.run", "    if (runEvent.args) return { text: 'no' }\n    return passRun(runEvent)", "$, runEvent, passRun"))
        check("R7 clean: refusal or unchanged pass, unique names", "R7" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r7other.tsx", hook_mod("turn.end", "    return next({ ...e })"))
        check("R7 clean: changed event on a non-permission hook", "R7" not in rules(f), show(f))
        spec = "export async function setup($: Api) {\n  await $.agent.register({ name: 'x', permissionMode: {m} })\n}\n"
        rc, f = files_case(plugin, "hooks/r7mode.ts", spec.replace("{m}", "'bypassPermissions'"))
        check("R7 warns on $.agent.register permissionMode 'bypassPermissions'", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7shorthand.ts", spec.replace("permissionMode: {m}", "permissionMode"))
        check("R7 warns on shorthand permissionMode", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7quoted.ts", spec.replace("permissionMode: {m}", "'permissionMode': 'plan'"))
        check("R7 warns on quoted permissionMode key", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7escaped.ts", spec.replace("permissionMode: {m}", "'permission\\x4dode': 'plan'"))
        check("R7 warns on an escaped permissionMode key", "R7" in rules(f, "warn"), show(f))
        rc, f = files_case(plugin, "hooks/r7asconst.ts", spec.replace("{m}", "'default' as const"))
        check("R7 clean: permissionMode 'default' as const", "R7" not in rules(f), show(f))
        rc, f = files_case(plugin, "hooks/r7default.ts", spec.replace("{m}", "'default'"))
        check("R7 clean: permissionMode 'default'", "R7" not in rules(f), show(f))

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
        plugin_case("warns on a field the plugins reference doesn't list", {}, "UNKNOWN_KEY", "warn", {"documentatonUrl": "https://e.com"})
        plugin_case("notes `icon`", {"assets/i.png": png(200)}, "MANIFEST_FOREIGN_FIELD", "note", {"icon": "./assets/i.png"})
        plugin_case("notes an image let through without a code check", {"assets/i.png": png(200)}, "BINARY_PASSED", "note")
        plugin_case("notes hooks.json", {}, "USES_HOOKS", "note")
        repo, plugin = make_plugin(tmp, "infonotes", {"assets/i.png": png(200)},
                                   {"icon": "./assets/i.png", "documentationUrl": "https://e.com", "types": "./types/index.d.ts"})
        rc, f = run(["plugin", str(plugin)], repo)
        bad = [x for x in f if x["level"] != "note"]
        check("manifest clean: icon, listing fields, image and hooks give notes only", not bad and rc == 0, show(bad))
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

        # ---- expected Policy holds, each at the call that raises it --------------------------------
        def hold_case(label, files, code, at):
            repo, plugin = make_plugin(tmp, f"hold_{len(results)}", files)
            rc, f = run(["plugin", str(plugin)], repo)
            got = [(x["file"].split("plugins/demo/")[-1], x["line"]) for x in f if x["rule"] == code]
            check(f"{code} {label}", got == [at] if at else not got, show(f))

        def stamp_with(call):
            return {"hooks/register.tsx": REGISTER.replace("  return $.clock.now()", f"  await {call}\n  return $.clock.now()")}
        reg = "hooks/register.tsx"
        for code in ("MOD_RUNS_PROCESS", "MOD_PROCESS_COMMAND_COMPUTED", "MOD_LOCAL_DATA_LEAVES", "MOD_SESSION_DATA_LEAVES"):
            hold_case("at a computed $.process.run", stamp_with("$.process.run(cmd)"), code, (reg, 4))
        hold_case("at a literal $.process.run", stamp_with("$.process.run(['git', 'status'])"), "MOD_RUNS_PROCESS", (reg, 4))
        hold_case("clean: literal $.process.run argv", stamp_with("$.process.run(['git', 'status'])"), "MOD_PROCESS_COMMAND_COMPUTED", None)
        hold_case("at $.fs.write to a computed path", stamp_with("$.fs.write(p, '')"), "MOD_WRITES_BUILD_FILE", (reg, 4))
        hold_case("at $.fs.write to package.json", stamp_with("$.fs.write('package.json', '')"), "MOD_WRITES_BUILD_FILE", (reg, 4))
        hold_case("clean: $.fs.write to a plain literal path", stamp_with("$.fs.write('notes.txt', '')"), "MOD_WRITES_BUILD_FILE", None)
        hold_case("at $.command.run", stamp_with("$.command.run({ command: 'x' })"), "MOD_RUNS_SLASH_COMMAND", (reg, 4))
        hold_case("at $.prompt.submit", stamp_with("$.prompt.submit({ text: 'x' })"), "MOD_SUBMITS_PROMPT", (reg, 4))
        hold_case("at $.prompt.submit", stamp_with("$.prompt.submit({ text: 'x' })"), "MOD_SESSION_DATA_LEAVES", (reg, 4))
        hold_case("clean: no capability call", {}, "MOD_RUNS_PROCESS", None)
        hold_case("at the entry module", {}, "MOD_INCLUDES_MOD", (reg, 0))
        hold_case("clean: hooks.json without modules", {"hooks/hooks.json": '{ "hooks": {} }\n'}, "MOD_INCLUDES_MOD", None)
        rebuilt = REGISTER.replace("  })\n}\n", "  })\n\n  on('command.run', async ($, runEvent, passRun) => passRun({ ...runEvent }))\n}\n")
        hold_case("at the first R7 finding", {reg: rebuilt}, "MOD_CHANGES_PERMISSIONS", (reg, 13))
        hold_case("clean: hooks pass their events on", {}, "MOD_CHANGES_PERMISSIONS", None)
        helper = {"hooks/helper.ts": "export async function run($: EngineInterface) {\n  await $.process.run(cmd)\n}\n"}
        hold_case("clean: a call in a module the entry does not import", helper, "MOD_RUNS_PROCESS", None)
        hold_case("at a call in an imported module", {**helper, reg: "import { run } from './helper'\n" + REGISTER},
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        def importing(line, rel="hooks/helper.ts"):
            return {rel: helper["hooks/helper.ts"], reg: line + "\n" + REGISTER}
        hold_case("at a call in a dotted module name", importing("import { run } from './helper.fixtures'", "hooks/helper.fixtures.ts"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.fixtures.ts", 2))
        hold_case("at a call in a directory's index", importing("import { run } from './lib'", "hooks/lib/index.ts"),
                  "MOD_RUNS_PROCESS", ("hooks/lib/index.ts", 2))
        hold_case("at a call in a module imported as .js", importing("import { run } from './helper.js'"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("at a call in a required module", importing("const { run } = require('./helper')"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("clean: an import in a comment", importing("// import { run } from './helper'"), "MOD_RUNS_PROCESS", None)
        hold_case("clean: a type-only import", importing("import type { Run } from './helper'"), "MOD_RUNS_PROCESS", None)
        hold_case("clean: inline type-only names", importing("import { type Run, type Mode } from './helper'"), "MOD_RUNS_PROCESS", None)
        hold_case("at a call in the folder's own index", importing("import { run } from '.'", "hooks/index.ts"),
                  "MOD_RUNS_PROCESS", ("hooks/index.ts", 2))
        hold_case("at a call in a module imported by a template literal", importing("const h = await import(`./helper`)"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("clean: import() in a type", importing("type Run = typeof import('./helper').run"), "MOD_RUNS_PROCESS", None)
        hold_case("clean: import() as a type alias", importing("type Mod = import('./helper').Mod"), "MOD_RUNS_PROCESS", None)
        hold_case("clean: import type = require()", importing("import type H = require('./helper')"), "MOD_RUNS_PROCESS", None)
        hold_case("at a default import named type", importing("import type from './helper'"), "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("at a call in a module imported in an object", importing("const m = { lazy: () => 1, mod: import('./helper') }"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("at a call in a module imported after ||", importing("const m = ready || import('./helper')"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("clean: import() in a type alias over two lines", importing("type Mod =\n  import('./helper')"), "MOD_RUNS_PROCESS", None)
        many = ",\n".join(f"  Type{i}" for i in range(600))
        hold_case("clean: a long type-only import", importing("import type {\n" + many + "\n} from './helper'"), "MOD_RUNS_PROCESS", None)
        hold_case("at $.fs.write to an escaped CLAUDE.md", stamp_with("$.fs.write('CLAUDE\\x2emd', '')"), "MOD_WRITES_BUILD_FILE", (reg, 4))
        hold_case("at a call in a module imported by an escaped path", importing("import { run } from './\\x68elper'"),
                  "MOD_RUNS_PROCESS", ("hooks/helper.ts", 2))
        hold_case("clean: import() in a union type alias", importing("type T = Foo | import('./helper').Run"), "MOD_RUNS_PROCESS", None)
        plugin_case("no crash on a bad escape", stamp_with("$.fs.write('\\x' + '\\u{110000}', '')"), "MOD_WRITES_BUILD_FILE", "note")
        hold_case("clean: literal argv as const", stamp_with("$.process.run(['git', 'status'] as const)"), "MOD_PROCESS_COMMAND_COMPUTED", None)
        hold_case("at $.fs.write to an escaped package.json", stamp_with("$.fs.write('a\\'b/package.json', '')"), "MOD_WRITES_BUILD_FILE", (reg, 4))
        plugin_case("no crash on a call cut off at the end", {reg: REGISTER + "export function cut($: any) {\n  $.process.run("}, "MOD_RUNS_PROCESS", "note")
        hold_case("clean: a call in a comment or string", stamp_with("'$.process.run(cmd)' // $.process.run(cmd)"), "MOD_RUNS_PROCESS", None)
        unimported = {"hooks/register.fixtures.ts": "export function wire(on: any) {\n  on('command.run', async ($: any, runEvent: any, passRun: any) => passRun({ ...runEvent }))\n}\n"}
        hold_case("clean: an R7 finding in a module the entry does not import", unimported, "MOD_CHANGES_PERMISSIONS", None)

        # ---- portal notes, each at the first call or hook that raises it ---------------------------
        hold_case("at $.ui.notify", stamp_with("$.ui.notify('x')"), "MOD_UNRECOGNIZED_CALL", (reg, 4))
        hold_case("clean: no $.ui.notify", stamp_with("$.ui.toast('x')"), "MOD_UNRECOGNIZED_CALL", None)
        hold_case("at $.fs.write to a plain literal path", stamp_with("$.fs.write('notes.txt', '')"), "MOD_WRITES_FILES", (reg, 4))
        hold_case("clean: no $.fs.write", stamp_with("$.fs.read('notes.txt')"), "MOD_WRITES_FILES", None)
        for call in ("$.command.register({ name: 'x' })", "$.tool.register({ name: 'x' })", "$.agent.register({ name: 'x' })"):
            hold_case(f"at {call.split('(')[0]}", stamp_with(call), "MOD_ADDS_TOOLS", (reg, 4))
        hold_case("clean: no registration", stamp_with("$.command.list()"), "MOD_ADDS_TOOLS", None)
        def hooked(*lines):
            return {reg: REGISTER.replace("  })\n}\n", "  })\n\n" + "".join(f"  {x}\n" for x in lines) + "}\n")}
        shared_call = "on('tool.call', async ($, e, next) => next(e))"
        unique_call = "on('agent.spawn', async ($, spawnEvent, passSpawn) => passSpawn(spawnEvent))"
        hold_case("at a call-named hook with shared names", hooked(shared_call), "MOD_HOOKS_CALL_EVENT", (reg, 13))
        hold_case("at a call-named hook that changes the event", hooked("on('command.run', async ($, runEvent, passRun) => passRun({ ...runEvent }))"),
                  "MOD_HOOKS_CALL_EVENT", (reg, 13))
        hold_case("clean: a call-named hook that passes R6", hooked(unique_call), "MOD_HOOKS_CALL_EVENT", None)
        hold_case("past a call-named hook that passes R6", hooked(unique_call, shared_call), "MOD_HOOKS_CALL_EVENT", (reg, 14))
        hold_case("clean: hooks on events that are not calls", {}, "MOD_HOOKS_CALL_EVENT", None)
        hold_case("at a call-named hook with no next parameter", hooked("on('tool.call', async ($, callEvent) => { return })"),
                  "MOD_HOOKS_CALL_EVENT", (reg, 13))
        hold_case("at a call-named hook given by name", hooked("on('tool.call', passOn)"), "MOD_HOOKS_CALL_EVENT", (reg, 13))
        plugin_case("R7 warns on a permission hook given by name", hooked("on('command.run', passOn)"), "R7", "warn")
        top = "function helper($: E): void {}\n"
        for i, code in enumerate(("const x = ok ? obj.m($) : () => 0\n", "const x = ok ? obj.m($) : (a: number) => a\n",
                                  "const x = ok ? obj.m($) : { a: 1 }\nconst y = () => 2\n",
                                  "const x = ok ? obj.m($) : (y)\nconst g = () => 1\n",
                                  "const x = ok ? obj.m($) : g(a)\nconst k = () => 1\n")):
            plugin_case(f"R2 flags $ in a call before a ternary's arrow {i}", {reg: REGISTER + top + code}, "R2", "block")
        for code in ("const x = ok ? await obj.m($) : () => 0\n", "const x = ok ? new X($) : () => 0\n",
                     "const x = ok ? obj.m?.($) : () => 0\n", "const x = ok ? a[0]($) : () => 0\n",
                     "const x = ok ? f<T>($) : () => 0\n", "switch (a) { case obj.m($): () => 1 }\n",
                     "switch (a) { case obj.m($): x => 1 }\n", "const x = ok ? ($) : () => 0\n",
                     "const x = ok ? (a, $) : () => 0\n", "const x = ok ? (void $) : () => 0\n"):
            plugin_case(f"R2 flags $ in `{code.strip()}`", {reg: REGISTER + top + code}, "R2", "block")
        for code in ("const x = ok ? ($): R => 0 : null\n", "function f() {\n  return ($, e): R => 0\n}\n",
                     "const g = <T,>($: T, e): R => 0\n", "const o = ($, e): { a: string; b: number } => 0\n"):
            plugin_case(f"clean: an arrow with a return type `{code.strip()}`", {reg: REGISTER + top + code}, "R2", None)
        plugin_case("R2 flags on in a call before a ternary's arrow",
                    {reg: REGISTER.replace("  on('session.start'", "  const w = options ? wire.x(on) : () => 0\n  on('session.start'")}, "R2", "block")
        plugin_case("R7 flags next in a call before a ternary's arrow",
                    hooked("on('fs.write', async ($, wEv, passW) => { const r = wEv ? keep(passW) : () => 0; return passW(wEv) })"), "R7", "warn")
        plugin_case("clean: a hook with < in a default value", hooked("on('fs.write', async ($, wEv = n < 1 ? d : d, passW) => passW(wEv))"), "R7", None)
        plugin_case("R6 warns on an agent.spawn hook given by name", hooked("on('agent.spawn', spawnHook)"), "R6", "warn")
        for label, hook in (("a return type with a comma", "async ($, runEv, passRun): Promise<Map<string, number>> => passRun(runEv)"),
                            ("a $-led next name", "async ($, runEv, $next) => $next(runEv)"),
                            ("a $-led event name", "async ($, $ev, passRun) => passRun($ev)"),
                            ("generics in a parameter type", "async ($: Api<A, B>, runEv, passRun) => passRun(runEv)"),
                            ("a matcher before the hook", "{ command: 'x' }, async ($, runEv, passRun) => passRun(runEv)"),
                            ("a wrapped hook", "wrap(async ($, runEv, passRun) => passRun(runEv))")):
            plugin_case(f"clean: a hook with {label}", hooked(f"on('command.run', {hook})"), "R7", None)
            hold_case(f"clean: a hook with {label}", hooked(f"on('command.run', {hook})"), "MOD_HOOKS_CALL_EVENT", None)
        hold_case("at a classic hook", hooked("on('classic.Stop', async ($, e, next) => next(e))"), "MOD_HOOKS_PASS_THROUGH_EVENT", (reg, 13))
        hold_case("clean: no classic hook", hooked(shared_call), "MOD_HOOKS_PASS_THROUGH_EVENT", None)
        hold_case("clean: a call in a module the entry does not import", helper | {"hooks/helper.ts": helper["hooks/helper.ts"].replace("process.run(cmd)", "fs.write(p, '')")},
                  "MOD_WRITES_FILES", None)
        no_section = README.replace("## What it runs, reads, writes and sends", "## Notes")
        plugin_case("O27 warns on holds with no disclosure section", {**stamp_with("$.process.run(cmd)"), "README.md": no_section}, "O27", "warn")
        plugin_case("O27 clean: disclosure section present", stamp_with("$.process.run(cmd)"), "O27", None)
        plugin_case("O27 warns on a mod with no capability call and no section", {"README.md": no_section}, "O27", "warn")

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
