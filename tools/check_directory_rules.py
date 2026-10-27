#!/usr/bin/env python3
"""
Check a plugin against the claude.ai plugin directory rules in docs/directory-rules.md.
Pure stdlib; reads TypeScript and JavaScript with its own small lexer, not tsc.

Usage:
  python3 tools/check_directory_rules.py files <path>...            # R1-R7 on these files
  python3 tools/check_directory_rules.py plugin <plugin-dir>        # official rules + R1-R7
  python3 tools/check_directory_rules.py release <plugin-dir> [--since <tag>]   # plugin + P1-P3

Options: --json, --fail-on block|hold|warn (default block).
Prints one finding per line, `file:line LEVEL RULE message`, and exits 1 when a finding is at
or above --fail-on.
"""

import argparse
import bisect
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

LEVELS = ["note", "warn", "hold", "block"]
CAPABILITY_CODE = "MOD_CAPABILITY_USE_NOT_PLAIN"
# Portal codes; a rule without one prints its own id.
CODES = {"R1": CAPABILITY_CODE, "R2": CAPABILITY_CODE}

SOURCE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
JSX_EXT = {".tsx", ".jsx"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
FONT_EXT = {".ttf", ".otf", ".woff", ".woff2", ".eot"}
SCRIPT_EXT = {".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".rb", ".pl"}
SYSTEM_FILES = {".ds_store", "thumbs.db", "desktop.ini"}
DEVICE_NAMES = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
RESERVED_NAMES = {"claude", "anthropic", "official", "plugin", "mcp", "test"}
COMPONENT_KEYS = ["commands", "agents", "skills", "hooks", "mcpServers", "lspServers", "outputStyles"]
REWRITING_ATTRS = {"filter", "ident", "working-tree-encoding", "eol", "text", "crlf"}
PACKAGE_SOURCE_FILES = {".npmrc", "bunfig.toml", "uv.toml", "pip.conf", ".yarnrc", ".yarnrc.yml", ".pypirc"}
DISCLOSURE_HEADING = "What it runs, reads, writes and sends"
# Top-level plugin.json fields in https://code.claude.com/docs/en/plugins-reference (2026-10-27).
MANIFEST_FIELDS = {
    "$schema", "name", "displayName", "version", "description", "author", "homepage", "repository",
    "license", "keywords", "metadata", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl",
    "termsOfServiceUrl", "defaultEnabled", "dependencies", "settings", "userConfig", "types",
    "channels", "skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles",
    "workflows", "experimental",
}
# Listed in the reference, yet the portal raised "Unrecognized field" on each (ctx-guard 0.6.0).
PORTAL_UNKNOWN_FIELDS = {"documentationUrl", "supportUrl", "types"}

KIB = 1024
MIB = 1024 * KIB


class Finding:
    def __init__(self, rule, level, file, line, message):
        self.rule, self.level, self.file, self.line, self.message = rule, level, file, line, message

    def code(self):
        return CODES.get(self.rule, self.rule)

    def text(self):
        prefix = f"[{self.rule}] " if self.rule in CODES else ""
        return f"{self.file}:{self.line} {self.level} {self.code()} {prefix}{self.message}"

    def as_json(self):
        return {"file": self.file, "line": self.line, "level": self.level, "rule": self.rule,
                "code": self.code(), "message": self.message}


# ---- lexer ---------------------------------------------------------------------------------

REGEX_BEFORE = set("(,=:[!&|?{};+-*%<>~^")
REGEX_KEYWORDS = {"return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "yield", "await", "else", "do"}


def strip_code(src):
    """Blank comments, string and regex literals, and template-literal text, keeping offsets and
    newlines. Quote delimiters stay, so a call still shows where its string argument was; the
    code inside `${...}` stays, with its `$` blanked."""
    out = list(src)
    n = len(src)
    tmpl = []  # brace depth inside each open `${`
    last = ""  # last code character
    last_word = ""

    def blank(a, b):
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    def template_text(i):
        # From just inside a backtick (or a closing `}` of `${`): blank to the end or the next `${`.
        start = i
        while i < n:
            c = src[i]
            if c == "\\":
                i += 2
                continue
            if c == "`":
                blank(start, i)
                return i + 1, False
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                blank(start, i + 1)  # the `$` too; `{` stays as code
                return i + 2, True
            i += 1
        blank(start, n)
        return n, False

    i = 0
    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1
            continue
        if tmpl and c == "}" and tmpl[-1] == 0:
            tmpl.pop()
            i, opened = template_text(i + 1)
            if opened:
                tmpl.append(0)
            last, last_word = "`", ""
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
            continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            blank(i + 1, j)
            i = j + 1
            last, last_word = c, ""
            continue
        if c == "`":
            i, opened = template_text(i + 1)
            if opened:
                tmpl.append(0)
            last, last_word = "`", ""
            continue
        if c == "/" and (last == "" or last in REGEX_BEFORE or last_word in REGEX_KEYWORDS):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            blank(i + 1, j)
            j += 1
            while j < n and (src[j].isalnum()):
                j += 1
            i = j
            last, last_word = "/", ""
            continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            last, last_word = src[j - 1], src[i:j]
            i = j
            continue
        if tmpl:
            if c == "{":
                tmpl[-1] += 1
            elif c == "}":
                tmpl[-1] -= 1
        last, last_word = c, ""
        i += 1
    return "".join(out)


ARROW_LEADERS = {"async", "return", "yield", "await", "throw", "in", "of", "case", "default", "else", "do", "typeof", "void", "delete", "extends"}
STATEMENT_KEYWORDS = {"const", "let", "var", "return", "if", "for", "while", "throw", "export", "function"}
TOKEN_RE = re.compile(r"[A-Za-z_$][\w$]*|\d[\w.]*|=>|\.\.\.|\?\.|[^\s\w]")
OPEN, CLOSE = "([{", ")]}"


class Source:
    """A lexed source file: blanked code, tokens, and each token's innermost open bracket."""

    def __init__(self, path, text):
        self.path, self.text = path, text
        self.code = strip_code(text)
        self.newlines = [m.start() for m in re.finditer("\n", text)]
        self.toks = [(m.group(), m.start()) for m in TOKEN_RE.finditer(self.code)]
        self.encl = []  # index of the innermost open bracket token, or -1
        self.match = {}
        stack = []
        for k, (t, _) in enumerate(self.toks):
            if t in CLOSE:
                if stack:
                    o = stack.pop()
                    self.match[o], self.match[k] = k, o
                self.encl.append(stack[-1] if stack else -1)
            else:
                self.encl.append(stack[-1] if stack else -1)
                if t in OPEN:
                    stack.append(k)

    def line(self, pos):
        return bisect.bisect_left(self.newlines, pos) + 1

    def tok(self, k):
        return self.toks[k][0] if 0 <= k < len(self.toks) else ""

    def bracket(self, k):
        e = self.encl[k]
        return self.tok(e) if e >= 0 else ""

    def is_key(self, k):
        # `{ name: ...}` or `{ name?: ...}`: an object or type key, not a binding.
        nxt = self.tok(k + 1)
        nxt = self.tok(k + 2) if nxt == "?" else nxt
        return nxt == ":" and self.bracket(k) == "{" and self.tok(k - 1) in ("{", ",")

    def is_member(self, k):
        return self.tok(k - 1) in (".", "?.")

    def before_generics(self, k):
        """The token index before k, stepping back over a type-parameter list `<...>`."""
        j = k - 1
        if self.tok(j) != ">":
            return j
        depth = 0
        while j >= 0:
            t = self.tok(j)
            depth += t == ">"
            depth -= t == "<"
            if depth == 0:
                return j - 1
            if t in (";", "{", "}", "="):
                return k - 1
            j -= 1
        return k - 1

    def is_params(self, open_k):
        """Whether the `(` at open_k opens a parameter list rather than call arguments."""
        b = self.before_generics(open_k)
        if b != open_k - 1:
            open_k_name = b
            if self.tok(open_k_name - 1) in ("function", "*") or self.tok(open_k_name) in ("function",):
                return True
        before = self.tok(open_k - 1)
        if before in ("function", "*"):
            return True
        if self.tok(open_k - 2) == "function" or (self.tok(open_k - 2) == "*" and self.tok(open_k - 3) == "function"):
            return True
        close = self.match.get(open_k)
        if close is None:
            return False
        after = self.tok(close + 1)
        if after == "=>":
            return True
        if after == ":":
            # `(...): Type =>` or a method `(...): Type {`; a `,` inside `<...>` or brackets is the type's.
            # A call in a ternary's branch (`a ? f(x) : ...`) is not a parameter list.
            callee = self.tok(self.before_generics(open_k))
            if callee in (")", "]", "?.", "!") or (re.match(r"[A-Za-z_$]", callee) and callee not in ARROW_LEADERS):
                return False  # a callee before `(`: call arguments, whatever follows the `:`
            depth = 0
            for k in range(close + 2, min(close + 60, len(self.toks))):
                t = self.tok(k)
                if t == "=>" and depth == 0:
                    return True
                if depth == 0 and (t in ("=", ";") or t in STATEMENT_KEYWORDS):
                    return False
                if t == "(" and depth == 0:
                    return False  # `a ? (...) : (...) =>`: an arrow after the `:` is the other branch
                if t in ("<", "(", "[", "{"):
                    depth += 1
                elif t in (">", ")", "]", "}"):
                    if depth == 0:
                        return False
                    depth -= 1
                elif t == "," and depth == 0:
                    return False
            return False
        # A method or function body: `name(...) {` with no `.` before the name.
        return after == "{" and before not in ("if", "for", "while", "switch", "catch", "with") and not self.is_member(open_k - 1)

    def string_at(self, k):
        """The original text of a string literal whose opening quote is token k."""
        if not 0 <= k < len(self.toks):
            return None
        t, pos = self.toks[k]
        return self.string_from(pos) if t in ("'", '"', "`") else None

    def string_from(self, pos):
        """The original text of the string literal whose opening quote is at pos."""
        q = self.text[pos]
        m = re.compile(rf"(?:\\.|[^\\{q}])*{q}", re.S).match(self.text, pos + 1)
        return self.text[pos + 1:m.end() - 1] if m else None

    def value_at(self, k):
        """The value of a string literal whose opening quote is token k, escapes decoded."""
        raw = self.string_at(k)
        return None if raw is None else js_unescape(raw)

    def top_level_functions(self):
        """{name: takes_dollar} for functions declared at the top of the file."""
        out = {}
        for k, (t, _) in enumerate(self.toks):
            if self.encl[k] != -1:
                continue
            if t == "function":
                j = k + 1 if self.tok(k + 1) != "*" else k + 2
                name = self.tok(j)
                o = j + 1
                if self.tok(o) == "<":
                    while o < len(self.toks) and self.tok(o) != "(":
                        o += 1
                if re.match(r"[A-Za-z_$]", name) and self.tok(o) == "(":
                    out[name] = self.tok(o + 1) == "$"
            elif t in ("const", "let", "var") and self.tok(k + 2) == "=":
                name = self.tok(k + 1)
                j = k + 3 if self.tok(k + 3) != "async" else k + 4
                if self.tok(j) == "(" and self.is_params(j):
                    out[name] = self.tok(j + 1) == "$"
                elif self.tok(j) == "function":
                    out[name] = self.tok(j + 2) == "$" or self.tok(j + 3) == "$"
        return out

    def imported_names(self):
        names = set()
        for m in re.finditer(r"^\s*import\b([^;]*?)\bfrom\b", self.code, re.M | re.S):
            names.update(re.findall(r"[A-Za-z_$][\w$]*", m.group(1)))
        return names - {"type", "as"}

    def register_param(self):
        """The name `register` gives its first parameter (the `on` function), or None."""
        for k, (t, _) in enumerate(self.toks):
            if t != "register" or self.encl[k] != -1:
                continue
            j = k + 1
            if self.tok(j) == "(":
                return self.tok(j + 1) or None
            while j < len(self.toks) and self.tok(j) != "=" and j < k + 8:
                j += 1
            j += 1
            if self.tok(j) == "async":
                j += 1
            if self.tok(j) == "(":
                return self.tok(j + 1) or None
            if self.tok(j) == "function":
                return self.tok(j + 2) or None
        return None

    def registrations(self, on_name):
        """[(token index of `on`, event, options text, open-paren index)] for `on("event", ...)` calls."""
        out = []
        for k, (t, _) in enumerate(self.toks):
            if t == on_name and self.tok(k + 1) == "(" and not self.is_member(k) and not self.is_params(k + 1):
                event = self.value_at(k + 2)
                if event is None:
                    continue
                opts = ""
                if self.tok(k + 4) == "," and self.tok(k + 5) == "{":
                    close = self.match.get(k + 5)
                    if close:
                        opts = re.sub(r"\s+", " ", self.text[self.toks[k + 5][1]:self.toks[close][1] + 1])
                out.append((k, event, opts, k + 1))
        return out

    def capability_calls(self):
        calls = set()
        for k, (t, _) in enumerate(self.toks):
            if t == "$" and not self.is_member(k) and self.tok(k + 1) == "." and self.tok(k + 3) == ".":
                calls.add(f"$.{self.tok(k + 2)}.{self.tok(k + 4)}")
        return calls


def is_test(path):
    return re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", str(path)) is not None


def is_source(path):
    return Path(path).suffix in SOURCE_EXT and not str(path).endswith(".d.ts")


# ---- R1-R7 -------------------------------------------------------------------------------

def check_r1(src, rel, out):
    """h and Fragment: never declared or used as a value in .tsx/.jsx; h may only be called."""
    for k, (t, pos) in enumerate(src.toks):
        if t not in ("h", "Fragment") or src.is_member(k) or src.is_key(k):
            continue
        prev = src.tok(k - 1)
        declared = prev in ("function", "const", "let", "var", "class") or (prev == "*" and src.tok(k - 2) == "function")
        if t == "h" and src.tok(k + 1) == "(" and not declared:
            continue
        out.append(Finding("R1", "block", rel, src.line(pos),
                           f"`{t}` is declared or used as a value; JSX compiles to `h` and `Fragment`, so rename it ({'only call h(...)' if t == 'h' else 'use <>...</>'})"))


def whole_argument(src, k):
    return src.tok(k - 1) in ("(", ",") and src.tok(k + 1) in (",", ")")


def check_passed(src, k, name, tops, imported, rel, out, what):
    """A bare `$` or `on` inside call arguments: allowed only as one whole argument to a function
    declared at the top of this file."""
    open_k = src.encl[k]
    callee_k = open_k - 1
    callee = src.tok(callee_k)
    if not whole_argument(src, k):
        out.append(Finding("R2", "block", rel, src.line(src.toks[k][1]),
                           f"`{name}` is not passed as one whole argument; {what}"))
    elif src.is_member(callee_k) or callee not in tops or callee in imported:
        why = "an imported function" if callee in imported else "a method" if src.is_member(callee_k) else f"`{callee}`, not a function declared at the top of this file"
        out.append(Finding("R2", "block", rel, src.line(src.toks[k][1]),
                           f"`{name}` is passed to {why}; {what}"))


def check_r2(src, rel, out):
    what = "pass $ or on only as one whole argument to a function declared at the top of the same file"
    tops = src.top_level_functions()
    imported = src.imported_names()
    for k, (t, pos) in enumerate(src.toks):
        if t != "$" or src.is_member(k):
            continue
        line = src.line(pos)
        if src.tok(k + 1) in (".", "?."):
            if src.tok(k + 1) == "?." or not re.match(r"[A-Za-z_]", src.tok(k + 2)) or src.tok(k + 3) != "." \
                    or not re.match(r"[A-Za-z_]", src.tok(k + 4)) or src.tok(k + 5) in (".", "?.", "["):
                out.append(Finding("R2", "block", rel, line, "write each capability call as $.noun.method(...)"))
            continue
        if src.tok(k + 1) == "=>":
            continue  # the parameter of `$ => ...`
        prev = src.tok(k - 1)
        if prev in ("=", "const", "let", "var") or src.tok(k + 1) == "=":
            out.append(Finding("R2", "block", rel, line, "`$` is aliased or assigned; use $ itself"))
            continue
        bracket = src.bracket(k)
        if bracket in ("{", "["):
            out.append(Finding("R2", "block", rel, line, f"`$` is put in an object or array; {what}"))
            continue
        if bracket != "(":
            out.append(Finding("R2", "block", rel, line, f"`$` is used as a value; {what}"))
            continue
        if src.tok(k + 1) == ":" or src.is_params(src.encl[k]):
            continue
        check_passed(src, k, "$", tops, imported, rel, out, what)

    # A top-level function that takes `$` lends its name to nothing else in the file.
    for name, takes in tops.items():
        if not takes:
            continue
        for k, (t, pos) in enumerate(src.toks):
            if t != name or src.is_member(k) or src.is_key(k):
                continue
            if src.tok(k - 1) == "function" and src.encl[k] == -1:
                continue  # the declaration itself
            if src.tok(k + 1) == "(" and src.tok(k - 1) not in ("const", "let", "var"):
                continue  # a call
            if src.tok(k - 1) in ("const", "let", "var") and src.encl[k] == -1:
                continue  # the top-level declaration `const name = (...) =>`
            out.append(Finding("R2", "block", rel, src.line(pos),
                               f"`{name}` names the top-level function that receives $; give this other use another name"))

    on_name = src.register_param()
    if not on_name:
        return
    regs = {r[0] for r in src.registrations(on_name)}
    for k, (t, pos) in enumerate(src.toks):
        if t != on_name or src.is_member(k) or src.is_key(k):
            continue
        line = src.line(pos)
        if k in regs:
            start = src.text.rfind("\n", 0, pos) + 1
            if src.code[start:pos].strip():
                out.append(Finding("R2", "block", rel, line, f"put each registration `{on_name}(\"event\", hook)` on a line of its own"))
            continue
        if src.tok(k + 1) == "=>" or (src.bracket(k) == "(" and src.is_params(src.encl[k])):
            continue
        if src.bracket(k) == "(":
            check_passed(src, k, on_name, tops, imported, rel, out, what)
        else:
            out.append(Finding("R2", "block", rel, line, f"`{on_name}` is used as a value; {what}"))


def check_r3(sources, entries, out):
    """ui.render is registered in the entry module itself."""
    for rel, src in sources.items():
        on_name = src.register_param() or "on"
        regs = [r for r in src.registrations(on_name) if r[1] == "ui.render"]
        others = [k for k, (t, _) in enumerate(src.toks)
                  if t not in (on_name,) and src.tok(k + 1) == "(" and src.value_at(k + 2) == "ui.render"
                  and not (src.is_member(k) and src.tok(k - 2) == "ui")]
        if rel in entries:
            uses_ui = "$.ui.resolve" in src.code or re.search(r"\$\.ui\.invalidate\(\s*'\s*'", src.code) and "ui.render" in src.text
            if uses_ui and not regs:
                out.append(Finding("R3", "block", rel, 1, "the module draws UI but registers no on('ui.render', ...) in this entry module"))
        else:
            for k in [r[0] for r in regs] + others:
                out.append(Finding("R3", "block", rel, src.line(src.toks[k][1]),
                                   "register ui.render in the entry module named in hooks/hooks.json, not here"))


def check_r4(text, rel, out):
    for m in re.finditer(r"__proto__", text):
        out.append(Finding("R4", "block", rel, text.count("\n", 0, m.start()) + 1,
                           "`__proto__` literal; check own keys with Object.hasOwn or a Set of names"))


PIPE_TO_SHELL = re.compile(r"\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:env\s+)?(?:ba|z|k|da|fi)?sh\b")


def check_r5(text, rel, out):
    for m in PIPE_TO_SHELL.finditer(text):
        out.append(Finding("R5", "block", rel, text.count("\n", 0, m.start()) + 1,
                           "pipe-to-shell (curl/wget ... | sh); link the installer page instead"))


# Events whose hook can change what is permitted: the portal holds a hook on one of them unless it
# can see the hook pass the event on unchanged (inferred from its findings on ctx-guard).
PERMISSION_EVENTS = {"config.set", "agent.register", "agent.spawn", "command.run", "fs.write",
                     "tool.check", "classic.PreToolUse", "classic.PermissionRequest"}
OP_CHARS = set("+-*/%&|^?")


def hook_params(src, open_k, close):
    """(event, next, first body token) of the first function in the call at open_k, or None. The
    event is None when its parameter is destructured, so the hook cannot pass the event itself on."""
    p_open = next((j for j in range(open_k + 1, close) if src.tok(j) == "(" and src.is_params(j)), None)
    if p_open is None:
        return None
    names, angle, default = [], 0, False  # `<` in a default value is a comparison, not a type's
    for j in range(p_open + 1, src.match[p_open]):
        if src.encl[j] != p_open:
            continue
        t = src.tok(j)
        if angle == 0 and t == ",":
            default = False
        elif angle == 0 and t == "=":
            default = True
        elif not default:
            angle += (t == "<") - (t == ">")
        if angle == 0 and src.tok(j - 1) in ("(", ","):
            names.append(t)
    if len(names) < 3 or not re.match(r"[A-Za-z_$]", names[2]):
        return None
    return (names[1] if re.match(r"[A-Za-z_$]", names[1]) else None), names[2], src.match[p_open] + 1


def adjacent(src, j):
    return src.toks[j + 1][1] == src.toks[j][1] + 1 if j + 1 < len(src.toks) else False


def assigns(src, m):
    """Whether an assignment or update operator starts at token m (the lexer splits `+=`, `===`)."""
    t = src.tok(m)
    if t in ("+", "-") and src.tok(m + 1) == t and adjacent(src, m):
        return True
    n = m
    while src.tok(n) in OP_CHARS and n < m + 3 and adjacent(src, n):
        n += 1
    return src.tok(n) == "=" and src.tok(n + 1) != "=" and (n == m or adjacent(src, n - 1))


def mutated(src, name, lo, hi):
    """Whether `name`, or a member of it, is assigned, updated or deleted between tokens lo and hi."""
    for j in range(lo, hi):
        if src.tok(j) != name or src.is_member(j) or src.is_key(j):
            continue
        if src.tok(j - 1) == "delete" or (src.tok(j - 1) in ("+", "-") and src.tok(j - 2) == src.tok(j - 1) and adjacent(src, j - 2)):
            return True
        if src.tok(j - 1) == "(" and src.tok(j - 2) == "assign" and src.tok(j - 4) == "Object":
            return True
        m = j + 1
        while src.tok(m) in (".", "?.") or src.tok(m) == "[":
            m = src.match.get(m, m) + 1 if src.tok(m) == "[" else m + 2
        if assigns(src, m):
            return True
    return False


def permission_hooks(src):
    return event_hooks(src, PERMISSION_EVENTS.__contains__)


def event_hooks(src, wanted):
    """Each hook on an event that wanted(event) accepts, with how it passes the event on:
    [{event, opts, text, line, changed: [lines of next(...) calls that pass something else], shared: [names],
    opaque: no inline `($, event, next)` function to read, params: [its event and next names]}].
    A `.catch(...)` handler chained on the registration counts as part of the same hook."""
    on_name = src.register_param()
    if not on_name:
        return []
    hooks = []
    for k, event, opts, open_k in src.registrations(on_name):
        close = src.match.get(open_k)
        if not wanted(event) or close is None:
            continue
        spans = [(open_k, close)]
        if src.tok(close + 1) == "." and src.tok(close + 2) == "catch" and src.tok(close + 3) == "(":
            spans.append((close + 3, src.match.get(close + 3, close + 3)))
        changed, shared, opaque, params = [], set(), False, []
        for lo, hi in spans:
            names = hook_params(src, lo, hi)
            if names is None:
                opaque |= lo == open_k  # no inline ($, event, next) function: how it passes on can't be read
                continue
            if lo == open_k:
                params = [n for n in names[:2] if n]
            ev, nx, body = names
            is_mutated = ev is not None and mutated(src, ev, body, hi)
            for j in range(body, hi):
                if src.tok(j) != nx or src.is_member(j) or src.is_key(j) or src.tok(j + 1) == "=>":
                    continue
                call = j + 2 if src.tok(j + 1) == "?." and src.tok(j + 2) == "(" else j + 1
                if src.tok(j + 1) in (".", "?.") and src.tok(j + 2) not in ("(", "call", "apply", "bind"):
                    continue  # a property of next, such as next.called
                if src.tok(call) != "(":
                    if not (src.bracket(j) == "(" and src.is_params(src.encl[j])):
                        changed.append(src.line(src.toks[j][1]))  # next handed on as a value
                    continue
                bare = ev is not None and src.match.get(call) == call + 2 and src.tok(call + 1) == ev
                if not bare or is_mutated:
                    changed.append(src.line(src.toks[j][1]))
            for name in filter(None, names[:2]):
                if any(t == name and not (open_k <= j <= spans[-1][1]) and not src.is_member(j) and not src.is_key(j)
                       for j, (t, _) in enumerate(src.toks)):
                    shared.add(name)
        text = re.sub(r"\s+", " ", src.text[src.toks[k][1]:src.toks[spans[-1][1]][1] + 1])
        hooks.append({"event": event, "opts": opts, "text": text, "line": src.line(src.toks[k][1]), "changed": changed, "shared": sorted(shared), "opaque": opaque, "params": params})
    return hooks


def check_r7(src, rel, out):
    """A hook on a permission event passes the event on unchanged, under names used nowhere else in
    the file, so the directory can see it does; an agent may not set its own permission mode."""
    for h in permission_hooks(src):
        rule = "R6" if h["event"] == "agent.spawn" else "R7"
        if h["changed"]:
            for line in h["changed"]:
                out.append(Finding(rule, "warn", rel, line,
                                   f"{h['event']} hook passes on something other than its own event; the directory holds a hook that can change what is permitted"))
        elif h["opaque"]:
            out.append(Finding(rule, "warn", rel, h["line"],
                               f"{h['event']} hook is not an inline ($, event, next) function; write it inline so the directory can see the event pass on unchanged"))
        elif h["shared"]:
            names = ", ".join(f"`{n}`" for n in h["shared"])
            out.append(Finding(rule, "warn", rel, h["line"],
                               f"{h['event']} hook parameter {names} is also used elsewhere in the file; name it uniquely so the directory can see the event pass on unchanged"))
    for k, (t, pos) in enumerate(src.toks):
        quoted = src.value_at(k) == "permissionMode" and src.tok(k + 2) == ":" and src.bracket(k) == "{" and src.tok(k - 1) in ("{", ",")
        if t != "permissionMode" and not quoted:
            continue
        shorthand = not quoted and src.bracket(k) == "{" and src.tok(k - 1) in ("{", ",") and src.tok(k + 1) in (",", "}")
        if not (quoted or src.is_key(k) or shorthand):
            continue
        call = src.encl[src.encl[k]] if src.encl[k] >= 0 else -1
        if src.tok(call) != "(" or src.tok(call - 1) not in ("register", "spawn") or src.tok(call - 3) != "agent" or src.tok(call - 5) != "$":
            continue
        v = k + 3 if quoted or src.tok(k + 1) != ":" else k + 2
        if not shorthand and src.value_at(v) == "default" and src.tok(v + 2) in (",", "}", "as", "satisfies"):
            continue
        out.append(Finding("R7", "warn", rel, src.line(pos),
                           f"$.agent.{src.tok(call - 1)} sets permissionMode; an agent with a mode other than 'default' changes what is permitted"))


def check_sources(paths_rel, read, entries=frozenset()):
    """R1-R7 on the given files. paths_rel: [(path, rel)]; read: path -> text."""
    out, sources = [], {}
    for path, rel in paths_rel:
        text = read(path)
        if text is None:
            continue
        check_r5(text, rel, out)
        if not is_source(path) and not str(path).endswith(".d.ts"):
            continue
        if is_test(path):
            continue
        check_r4(text, rel, out)
        if str(path).endswith(".d.ts"):
            continue
        src = Source(rel, text)
        sources[rel] = src
        if Path(path).suffix in JSX_EXT:
            check_r1(src, rel, out)
        check_r2(src, rel, out)
        check_r7(src, rel, out)
    check_r3(sources, entries, out)
    return out, sources


# ---- files in the plugin folder ----------------------------------------------------------------

def git(args, cwd):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


def git_bytes(args, cwd):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    return r.stdout if r.returncode == 0 else None


def repo_root(path):
    out = git(["rev-parse", "--show-toplevel"], path)
    return Path(out.strip()) if out else None


def list_entries(root, sub=""):
    """[(rel_path_from_root, mode)] for tracked and untracked-not-ignored files under sub."""
    entries = {}
    staged = git(["ls-files", "-z", "-s", "--", sub or "."], root) or ""
    for rec in staged.split("\0"):
        if rec:
            meta, path = rec.split("\t", 1)
            entries[path] = meta.split()[0]
    others = git(["ls-files", "-z", "--others", "--exclude-standard", "--", sub or "."], root) or ""
    for path in others.split("\0"):
        if path:
            full = root / path
            entries[path] = "120000" if full.is_symlink() else "100644"
    return sorted((p, m) for p, m in entries.items() if (root / p).exists() or (root / p).is_symlink() or m == "160000")


def read_text(path):
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def image_magic(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data.rstrip(b"\0").endswith(b"IEND\xaeB`\x82")
    if data.startswith(b"\xff\xd8\xff"):
        return data.rstrip(b"\0").endswith(b"\xff\xd9")
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return data.rstrip(b"\0").endswith(b";")
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return int.from_bytes(data[4:8], "little") + 8 <= len(data)
    return False


def font_magic(data):
    return data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"wOFF", b"wOF2", b"ttcf")


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def strip_fences(text):
    return re.sub(r"^(```|~~~)[^\n]*\n.*?^\1[^\n]*$", "", text, flags=re.M | re.S)


def check_names(rels, out, root_label):
    seen = {}
    for rel in rels:
        parts = rel.split("/")
        for i, part in enumerate(parts):
            path = "/".join(parts[:i + 1])
            low = path.lower()
            if low in seen and seen[low] != path:
                out.append(Finding("O3", "block", path, 1, f"differs from `{seen[low]}` only by capitalization (validation stops)"))
            seen.setdefault(low, path)
            if ":" in part or part.endswith((".", " ")) or part.split(".")[0].lower() in DEVICE_NAMES or any(c in part for c in '<>"\\|?*'):
                out.append(Finding("O3", "block", path, 1, "name not valid on Windows or macOS: colon, trailing dot or space, or a device name (validation stops)"))


def check_frontmatter(text, rel, out):
    if not text.startswith("---"):
        out.append(Finding("O11", "warn", rel, 1, "no YAML front matter"))
        return
    lines = text.split("\n")
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip() == "---"), None)
    if end is None:
        out.append(Finding("O11", "block", rel, 1, "front matter doesn't parse: no closing ---"))
        return
    desc = False
    for i in range(1, end):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#") or line[0] in " \t":
            continue
        m = re.match(r"([^\s:#][^:]*?)\s*:(?:\s+(.*))?$", line)
        if not m:
            out.append(Finding("O11", "block", rel, i + 1, "front matter doesn't parse: line is not `key: value`"))
            continue
        key, value = m.group(1), (m.group(2) or "").strip()
        if value and value[0] not in "'\"|>[{" and (": " in value or value.endswith(":") or value[0] in "@`%"):
            out.append(Finding("O11", "block", rel, i + 1, f"front matter doesn't parse: plain value of `{key}` holds `: ` or starts with a reserved character; quote it"))
        if value[:1] in ("'", '"') and not (len(value) > 1 and value.endswith(value[0])):
            out.append(Finding("O11", "block", rel, i + 1, f"front matter doesn't parse: unclosed quote in `{key}`"))
        if key == "description":
            desc = True
            nxt = next((lines[j] for j in range(i + 1, end) if lines[j].strip()), "")
            if value.startswith(("[", "{")) or (not value and re.match(r"\s+-\s", nxt)):
                out.append(Finding("O11", "block", rel, i + 1, "description is a list or mapping, not text"))
            elif not value and not re.match(r"\s", nxt):
                out.append(Finding("O11", "warn", rel, i + 1, "description is empty"))
    if not desc:
        out.append(Finding("O11", "warn", rel, 1, "no description in front matter"))


LAUNCHER_RE = re.compile(r"(?<![\w-])(npx|bunx|pnpm\s+dlx|yarn\s+dlx|uvx|pipx\s+run|uv\s+run)\b([^\n\"'`;|&]*)")


def check_launchers(text, rel, out):
    found = False
    for m in LAUNCHER_RE.finditer(text):
        found = True
        launcher, rest = re.sub(r"\s+", " ", m.group(1)), m.group(2)
        args = rest.split()
        if launcher == "uv run":
            if "--locked" not in args and "--frozen" not in args:
                out.append(Finding("O12", "block", rel, line_of(text, m.start()), "`uv run` without --locked or --frozen"))
            continue
        pkg = next((a for a in args if not a.startswith("-")), "")
        if launcher in ("uvx", "pipx run"):
            pinned = re.search(r"(==|@)\d+(\.\d+)*$", pkg) is not None
        else:
            pinned = re.search(r".@\d+\.\d+\.\d+([-+][\w.]+)?$", pkg) is not None
        if not pinned:
            out.append(Finding("O12", "block", rel, line_of(text, m.start()),
                               f"`{launcher} {pkg}` is not pinned to an exact version"))
    return found


SECRET_RES = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{36}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{40,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{32,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{35}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
]
ENV_CREDENTIAL_RE = re.compile(r"\$\{?[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|PASSWD)\}?")


def check_command_paths(cmd, rel, where, out):
    if not isinstance(cmd, str):
        return
    rest = cmd.replace("${CLAUDE_PLUGIN_ROOT}", "")
    problems = []
    if re.search(r"\$\{?[A-Za-z_]", rest):
        problems.append("a variable other than ${CLAUDE_PLUGIN_ROOT}")
    if "$(" in rest or "`" in rest:
        problems.append("a command substitution")
    if re.search(r"[*?\[]", rest):
        problems.append("a wildcard")
    if re.search(r"(^|\s)-[ce](\s|$)", rest):
        problems.append("an inline program (-c/-e)")
    for p in problems:
        out.append(Finding("O14", "block", rel, 1, f"{where} command has {p}; write each path in full from ${{CLAUDE_PLUGIN_ROOT}}"))


def check_plugin_files(plugin_dir, out):
    plugin_dir = plugin_dir.resolve()
    root = repo_root(plugin_dir) or plugin_dir
    sub = os.path.relpath(plugin_dir, root)
    sub = "" if sub == "." else sub
    label = lambda p: os.path.relpath(root / p)  # noqa: E731
    in_git = (root / ".git").exists()
    if in_git:
        entries = list_entries(root, sub)
        repo_entries = list_entries(root)
    else:
        entries = []
        for dp, dns, fns in os.walk(plugin_dir):
            for f in fns + [d for d in dns if os.path.islink(os.path.join(dp, d))]:
                full = Path(dp) / f
                entries.append((os.path.relpath(full, root), "120000" if full.is_symlink() else "100644"))
        repo_entries = entries
    rels = [p for p, _ in entries]

    # O4 folder names on the path to the plugin
    for part in Path(sub).parts:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", part):
            out.append(Finding("O4", "block", label(sub), 1, f"folder `{part}` on the plugin path uses characters other than letters, digits, . - _ (validation stops)"))

    # O3 names (plugin path and everything in the plugin folder)
    check_names(rels, out, sub)

    # O5 .gitattributes
    plugin_ancestors = {""} | {"/".join(Path(sub).parts[:i]) for i in range(1, len(Path(sub).parts) + 1)}
    for rel, _ in repo_entries:
        if Path(rel).name != ".gitattributes":
            continue
        text = read_text(root / rel) or ""
        folder = str(Path(rel).parent).replace(".", "") if str(Path(rel).parent) == "." else str(Path(rel).parent)
        near = folder in plugin_ancestors or (sub and (folder + "/").startswith(sub + "/"))
        for i, line in enumerate(text.splitlines(), 1):
            if line.strip().startswith("#"):
                continue
            attrs = {re.split(r"[=]", a.lstrip("-!"))[0] for a in line.split()[1:]}
            if attrs & {"export-ignore", "export-subst"}:
                out.append(Finding("O5", "block", label(rel), i, "export-ignore/export-subst in .gitattributes (validation stops)"))
            if near and attrs & REWRITING_ATTRS:
                out.append(Finding("O5", "block", label(rel), i, f"attribute that rewrites file contents ({', '.join(sorted(attrs & REWRITING_ATTRS))}) at the root, above or inside the plugin folder (validation stops)"))

    # O6 repository size
    count = len({p for p, _ in repo_entries} | {str(Path(p).parent) for p, _ in repo_entries})
    if count >= 10000:
        out.append(Finding("O6", "block", label(""), 0, f"{count} files and folders in the repository; keep it under 10,000 (validation stops)"))
    unpacked = sum((root / p).stat().st_size for p, m in repo_entries if m not in ("160000", "120000") and (root / p).is_file())
    if unpacked >= 256 * MIB:
        out.append(Finding("O6", "block", label(""), 0, f"repository is {unpacked // MIB} MiB unpacked; keep it under 256 MiB (validation stops)"))
    if in_git:
        archive = subprocess.run(["sh", "-c", "git archive --format=tar.gz HEAD | wc -c"], cwd=root, capture_output=True, text=True)
        size = int(archive.stdout.strip() or 0) if archive.returncode == 0 else 0
        if size >= 50 * MIB:
            out.append(Finding("O6", "block", label(""), 0, f"repository archive is {size // MIB} MiB; keep it under 50 MiB (validation stops)"))

    # O7 file count
    files = [(p, m) for p, m in entries if m not in ("160000",)]
    if len(files) > 512:
        out.append(Finding("O7", "hold", label(sub), 0, f"{len(files)} files in the plugin; keep it to 512 or fewer"))

    texts = {}
    images = []
    package_source = []
    launcher_found = False
    install_found = False
    for rel, mode in entries:
        full = root / rel
        name = Path(rel).name
        in_plugin = os.path.relpath(rel, sub) if sub else rel
        top = in_plugin.split("/")[0]
        # O1 system files
        if name.lower() in SYSTEM_FILES or "__MACOSX" in Path(rel).parts:
            out.append(Finding("O1", "block", label(rel), 1, "This is a macOS or Windows system file; remove it from the plugin folder"))
        # O2 symlinks, submodules, LFS pointers
        kind = {"120000": "symbolic link", "160000": "Git submodule"}.get(mode)
        if not kind and full.is_file() and full.stat().st_size < 1024:
            head = full.read_bytes()[:64]
            if head.startswith(b"version https://git-lfs.github.com/spec/v1"):
                kind = "Git LFS pointer"
        if kind:
            loaded = top in ("hooks", "skills", "commands", "agents", ".claude-plugin", "scripts", "bin", ".mcp.json", ".lsp.json", "output-styles")
            out.append(Finding("O2", "block" if loaded else "warn", label(rel), 1, f"{kind}; commit a regular file{'' if loaded else ' (outside what the plugin loads: warning)'}"))
            continue
        if not full.is_file():
            continue
        size = full.stat().st_size
        ext = Path(rel).suffix.lower()
        data = full.read_bytes()
        is_image, is_font = ext in IMAGE_EXT, ext in FONT_EXT
        # O6 per-file limit, O8 text-file size
        if size >= 5 * MIB:
            out.append(Finding("O6", "block", label(rel), 1, f"{size / MIB:.1f} MiB; keep every file in the plugin folder under 5 MiB (validation stops)"))
        elif not (is_image or is_font):
            if size >= 256 * KIB:
                out.append(Finding("O8", "hold", label(rel), 1, f"{size / KIB:.0f} KiB; keep every file that isn't an image or font under 256 KiB"))
            elif size >= 200 * KIB:
                out.append(Finding("O8", "warn", label(rel), 1, f"{size / KIB:.0f} KiB; close to the 256 KiB limit"))
        # O9 binary types
        text = None
        if b"\0" not in data[:8192]:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                text = None
        if text is None:
            if not (image_magic(data) or (is_font and font_magic(data))):
                out.append(Finding("O9", "hold", label(rel), 1, "binary file other than a complete PNG/JPEG/GIF/WebP image or a font"))
            else:
                out.append(Finding("BINARY_PASSED", "note", label(f"{sub}/.claude-plugin/plugin.json" if sub else ".claude-plugin/plugin.json"), 0,
                                   f"image or font `{in_plugin}` is let through without a code check (its printable text is still screened)"))
            if is_image:
                images.append(rel)
            continue
        if is_image:
            images.append(rel)
        texts[rel] = text
        if name in PACKAGE_SOURCE_FILES:
            package_source.append(rel)
        # O13 secrets
        for rx in SECRET_RES:
            for m in rx.finditer(text):
                out.append(Finding("O13", "block", label(rel), line_of(text, m.start()), "looks like a real credential; ask for it through userConfig with sensitive: true"))
        for m in ENV_CREDENTIAL_RE.finditer(text):
            out.append(Finding("O13", "hold", label(rel), line_of(text, m.start()), f"reads `{m.group()}` from the user's environment; ask for it through userConfig instead"))
        # O12 launchers in what the plugin runs
        runs = ext in SCRIPT_EXT or name in ("plugin.json", ".mcp.json", "hooks.json", ".lsp.json") or (ext == ".md" and top in ("skills", "commands", "agents"))
        if runs and not is_test(rel):
            scan = text if ext != ".md" else "\n".join(l for l in text.splitlines() if "!`" in l)
            launcher_found |= check_launchers(scan, label(rel), out)
            install_found |= re.search(r"\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b|\bpip3?\s+install\b|\buv\s+(pip\s+install|sync|add)\b", scan) is not None
        # O16 minified
        if ext in SOURCE_EXT or ext in (".py", ".sh"):
            lines = text.splitlines() or [""]
            if len(text) > 4096 and len(text) / len(lines) > 200:
                out.append(Finding("O16", "hold", label(rel), 1, "looks compiled, packed or minified; commit readable source"))

    # O15 package-manager configuration beside a launcher or install
    for rel in package_source:
        if launcher_found:
            out.append(Finding("O15", "block", label(rel), 1, "package-manager configuration in a plugin that uses a launcher"))
        elif install_found:
            out.append(Finding("O15", "hold", label(rel), 1, "package-manager configuration in a plugin that runs a package install"))

    # O10 images referenced only by Markdown image syntax in the README
    for img in images:
        base = Path(img).name
        for rel, text in texts.items():
            if base not in text:
                continue
            in_plugin = os.path.relpath(rel, sub) if sub else rel
            top = in_plugin.split("/")[0]
            ext = Path(rel).suffix.lower()
            if top in ("commands", "hooks") or "/scripts/" in "/" + in_plugin or ext in SCRIPT_EXT:
                out.append(Finding("O10", "hold", label(rel), line_of(text, text.find(base)), f"bundled image `{base}` referenced from a command, hook or script"))
            elif ext == ".md":
                code = re.finditer(r"^(```|~~~)[^\n]*\n.*?^\1[^\n]*$|`[^`\n]*`", text, re.M | re.S)
                for m in code:
                    if base in m.group():
                        out.append(Finding("O10", "hold", label(rel), line_of(text, m.start()), f"bundled image `{base}` written in backticks or a code block"))
                if Path(rel).name.lower().startswith("readme"):
                    prose = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", strip_fences(text))
                    prose = re.sub(r"`[^`\n]*`", "", prose)
                    if base in prose:
                        out.append(Finding("O10", "hold", label(rel), 1, f"bundled image `{base}` referenced other than with Markdown image syntax"))
    return root, sub, entries, texts


def check_manifest(plugin_dir, root, texts, out):
    plugin_dir = plugin_dir.resolve()
    mpath = plugin_dir / ".claude-plugin" / "plugin.json"
    rel = os.path.relpath(mpath)
    try:
        manifest = json.loads(mpath.read_text())
    except (OSError, ValueError) as e:
        out.append(Finding("O0", "block", rel, 1, f"no readable .claude-plugin/plugin.json: {e}"))
        return {}
    name = manifest.get("name", "")
    if not isinstance(name, str) or not name.isascii():
        out.append(Finding("O17", "block", rel, 1, "Non-ASCII identifier: name"))
    elif not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?", name):
        out.append(Finding("O17", "warn", rel, 1, "name: lowercase letters, digits and hyphens, up to 64 characters, starting and ending with a letter or digit"))
    if name in RESERVED_NAMES:
        out.append(Finding("O17", "block", rel, 1, f"Name is taken: `{name}` is a reserved word"))
    elif name and all(w in RESERVED_NAMES for w in name.split("-")):
        out.append(Finding("O17", "hold", rel, 1, f"Name may be confused with an existing listing: `{name}` is made only of generic words"))
    for field in ("description", "author", "version"):
        if not manifest.get(field):
            out.append(Finding("O18", "warn", rel, 1, f"set `{field}` in plugin.json"))
    author = manifest.get("author")
    for field, value in (("displayName", manifest.get("displayName")), ("author.name", author.get("name") if isinstance(author, dict) else author)):
        if not isinstance(value, str):
            continue
        scripts = {unicodedata.name(c, "?").split()[0] for c in value if c.isalpha()}
        invisible = [c for c in value if unicodedata.category(c) == "Cf"]
        if len(scripts) > 1 or invisible:
            out.append(Finding("O19", "block", rel, 1, f"{field} mixes writing systems ({', '.join(sorted(scripts))}) or holds invisible characters"))
    # component keys
    norm = {k.lower().replace("_", "").replace("-", ""): k for k in COMPONENT_KEYS}
    for key in manifest:
        want = norm.get(key.lower().replace("_", "").replace("-", ""))
        if want and key != want:
            out.append(Finding("O20", "block", rel, 1, f"component key `{key}` must be spelled `{want}`"))
    exp = manifest.get("experimental")
    if isinstance(exp, dict):
        for key in exp:
            if key in COMPONENT_KEYS:
                out.append(Finding("O20", "block", rel, 1, f"component key `{key}` inside `experimental`"))
    for key in manifest:
        if key == "icon":
            out.append(Finding("MANIFEST_FOREIGN_FIELD", "note", rel, 1, "`icon` is read by the directory for the listing and ignored by Claude Code"))
        elif key not in MANIFEST_FIELDS:
            out.append(Finding("UNKNOWN_KEY", "warn", rel, 1, f"`{key}` is not a plugin.json field in the plugins reference; check its spelling"))
        elif key in PORTAL_UNKNOWN_FIELDS:
            why = "the mod's PluginState contract" if key == "types" else "a directory listing field"
            out.append(Finding("UNKNOWN_KEY", "note", rel, 1, f"expected warning on `{key}`, {why}: the portal reads it as unknown although the plugins reference lists it"))
    for key in COMPONENT_KEYS + ["icon"]:
        values = manifest.get(key)
        values = [values] if isinstance(values, str) else values if isinstance(values, list) else []
        for v in values:
            if isinstance(v, str) and not (plugin_dir / v).resolve().is_relative_to(plugin_dir):
                out.append(Finding("O21", "block", rel, 1, f"`{key}` path `{v}` points outside the plugin folder"))
            if key == "hooks" and isinstance(v, str) and os.path.normpath(v) == os.path.normpath("hooks/hooks.json"):
                out.append(Finding("O22", "warn", rel, 1, "leave hooks/hooks.json out of `hooks`; Claude Code loads it automatically"))
    servers = manifest.get("mcpServers") if isinstance(manifest.get("mcpServers"), dict) else {}
    mcp = plugin_dir / ".mcp.json"
    if mcp.exists():
        try:
            data = json.loads(mcp.read_text())
            servers = {**servers, **data.get("mcpServers", data)}
        except ValueError:
            out.append(Finding("O23", "block", os.path.relpath(mcp), 1, ".mcp.json can’t be parsed"))
    for sname, spec in servers.items():
        if isinstance(spec, dict):
            check_command_paths(" ".join([str(spec.get("command", ""))] + [str(a) for a in spec.get("args", [])]), rel, f"MCP server `{sname}`", out)
            url = spec.get("url")
            if isinstance(url, str) and url and not url.startswith(("https://", "wss://", "${user_config.")):
                out.append(Finding("O23", "block", rel, 1, f"MCP server URL is not https: `{sname}`"))

    # README and license
    readmes = [p for p in plugin_dir.iterdir() if p.name.lower().startswith("readme") and p.is_file()]
    if not readmes:
        out.append(Finding("O24", "block", os.path.relpath(plugin_dir), 0, "README missing"))
    else:
        words = len(strip_fences(readmes[0].read_text(errors="replace")).split())
        if words < 40:
            out.append(Finding("O24", "block", os.path.relpath(readmes[0]), 1, f"README too short: {words} words outside code blocks, needs 40"))
    if not any(p.name.lower().startswith(("license", "licence")) for p in plugin_dir.iterdir()) and not manifest.get("license"):
        out.append(Finding("O25", "block", os.path.relpath(plugin_dir), 0, "License missing: add LICENSE or set `license` in plugin.json"))
    return manifest


def check_hooks_json(plugin_dir, out):
    path = plugin_dir / "hooks" / "hooks.json"
    if not path.exists():
        return []
    rel = os.path.relpath(path)
    try:
        data = json.loads(path.read_text())
    except ValueError:
        out.append(Finding("O26", "block", rel, 1, "hooks.json is invalid"))
        return []
    hooks, modules = (data.get("hooks"), data.get("modules")) if isinstance(data, dict) else (None, None)
    if not (isinstance(hooks, dict) or isinstance(modules, list)) or (hooks is not None and not isinstance(hooks, dict)) \
            or (modules is not None and not isinstance(modules, list)):
        out.append(Finding("O26", "block", rel, 1, "hooks.json is invalid: needs a `hooks` object, a `modules` array, or both"))
    for event, groups in (hooks or {}).items() if isinstance(hooks, dict) else []:
        for group in groups if isinstance(groups, list) else []:
            for h in group.get("hooks", []) if isinstance(group, dict) else []:
                if not isinstance(h, dict):
                    continue
                if h.get("type") == "command":
                    check_command_paths(h.get("command"), rel, f"{event} hook", out)
                if h.get("type") == "http" and not str(h.get("url", "")).startswith("https://"):
                    out.append(Finding("O26", "block", rel, 1, f"{event} HTTP hook needs an https:// URL"))
    if isinstance(data, dict):
        out.append(Finding("USES_HOOKS", "note", rel, 0, "the plugin ships hooks, which Claude Code runs on events; information only"))
    entries = []
    for m in modules or []:
        if isinstance(m, str):
            entries.append(os.path.relpath((path.parent / m).resolve()))
    return entries


# A file whose change alters how the project builds, what Claude Code permits, or what the model
# reads as instructions (inferred: the portal raised MOD_WRITES_BUILD_FILE on a computed path).
BUILD_FILE_RE = re.compile(r"(^|/)(package\.json|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|tsconfig[\w.-]*\.json"
                           r"|Makefile|Dockerfile|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|settings(\.local)?\.json"
                           r"|hooks\.json|plugin\.json|marketplace\.json|\.mcp\.json|CLAUDE(\.local)?\.md|AGENTS\.md"
                           r"|\.gitattributes|\.gitmodules|\.github/.*|\.githooks/.*|\.husky/.*)$")


JS_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def js_unescape(raw):
    """The value of a string literal's raw text."""
    def one(m):
        e = m.group(1)
        if len(e) > 1 and e[0] in "xu":
            code = int(e[1:].strip("{}"), 16)
            return chr(code) if code <= 0x10FFFF else m.group()
        return JS_ESCAPES.get(e, "" if e in "\r\n" else e)
    return re.sub(r"\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|\r\n|.)", one, raw, flags=re.S)


def literal_arg(src, open_k):
    """The first argument of the call opening at open_k when it is a string literal or an array of
    string literals: [values], else None."""
    def ends(j):  # the argument ends after token j, or after a type suffix on it
        j += 1
        while src.tok(j) == "!":
            j += 1
        if src.tok(j) in ("as", "satisfies"):
            return src.bracket(j) == "(" and src.encl[j] == open_k
        return src.tok(j) in (",", ")")

    k = open_k + 1
    if src.string_at(k) is not None and ends(k + 1):
        return [src.value_at(k)]
    if src.tok(k) == "[" and src.match.get(k) and ends(src.match[k]):
        out, j, end = [], k + 1, src.match[k]
        while j < end:
            if src.string_at(j) is None or src.tok(j + 2) not in (",", "]"):
                return None
            out.append(src.value_at(j))
            j += 3 if src.tok(j + 2) == "," else 2
        return out
    return None


def first_call(sources, calls, pred=lambda src, k: True):
    """(file, line, src, open-paren index) of the first `$.noun.method(` in `calls` that pred accepts,
    taking files in name order, or None."""
    for rel in sorted(sources):
        src = sources[rel]
        for k, (t, pos) in enumerate(src.toks):
            if t == "$" and not src.is_member(k) and src.tok(k + 1) == "." and src.tok(k + 3) == "." and src.tok(k + 5) == "(" \
                    and f"$.{src.tok(k + 2)}.{src.tok(k + 4)}" in calls and pred(src, k + 5):
                return rel, src.line(pos)
    return None


IMPORT_RE = re.compile(r"""\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)(['"`])""")


def type_only(code, at):
    """Whether the import or export statement that ends in `from` at `at` brings in types only."""
    start = at
    while True:  # back to the statement's own `import` or `export` keyword
        start = max(code.rfind("import", 0, start), code.rfind("export", 0, start))
        if start < 0:
            return False
        if re.match(r"(?<![\w$])(?:import|export)(?![\w$])", code[start:start + 7]) and (start == 0 or not re.match(r"[\w$]", code[start - 1])):
            break
    head = code[start:at]
    names = re.fullmatch(r"(?:import|export)\s*\{([^{}]*)\}\s*", head)
    return bool(re.match(r"(?:import|export)\s+type\b(?!\s*$)", head)) or bool(
        names and names.group(1).strip() and all(re.match(r"\s*type\s", n) for n in names.group(1).split(",") if n.strip()))


def reachable(sources, entries):
    """The sources the entry modules import at run time, directly or through each other (test-only
    helpers and type-only imports drop out)."""
    seen, todo = set(), [e for e in entries if e in sources]
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        seen.add(rel)
        src = sources[rel]
        for m in IMPORT_RE.finditer(src.code):
            spec = js_unescape(src.string_from(m.start(1)) or "")
            before = src.code[max(0, m.start() - 200):m.start()]
            line = before[before.rfind("\n") + 1:]
            if spec not in (".", "..") and not spec.startswith(("./", "../")) or "${" in spec \
                    or m.group().startswith("from") and type_only(src.code, m.start()) \
                    or m.group().startswith("require") and re.search(r"\bimport\s+type\s+\w+\s*=\s*$", line) \
                    or m.group().startswith("import") and (re.search(r"\btypeof\s*$", before)
                                                           or re.search(r"\btype\s+\w+\s*(<[^=;]*>)?\s*=[\w\s|&<>,.\[\]'\"]*$", before)):
                continue
            base = os.path.normpath(os.path.join(os.path.dirname(rel), spec))
            stem, ext = os.path.splitext(base)
            cands = [base] + [base + e for e in SOURCE_EXT] + [os.path.join(base, "index" + e) for e in SOURCE_EXT]
            if ext in SOURCE_EXT:  # `./x.js` names `x.ts` once compiled
                cands += [stem + e for e in SOURCE_EXT]
            todo += [c for c in cands if c in sources]
    return {rel: sources[rel] for rel in seen}


def expected_holds(sources, entries, readme, readme_rel, manifest_rel, out):
    """The Policy holds the portal raises on a mod for a reviewer, each where the portal raises it."""
    sources = reachable(sources, entries)

    def computed(src, k):
        return literal_arg(src, k) is None

    def build_path(src, k):
        lit = literal_arg(src, k)
        return lit is None or any(BUILD_FILE_RE.search(x.replace("\\", "/")) for x in lit)

    data = {"$.process.run", "$.model.fork", "$.prompt.submit"}
    holds = [
        ("MOD_RUNS_PROCESS", first_call(sources, {"$.process.run"}), "runs a process"),
        ("MOD_PROCESS_COMMAND_COMPUTED", first_call(sources, {"$.process.run"}, computed), "runs a command built at run time"),
        ("MOD_WRITES_BUILD_FILE", first_call(sources, {"$.fs.write"}, build_path), "writes a file at a computed path or a build, settings or instructions file"),
        ("MOD_LOCAL_DATA_LEAVES", first_call(sources, data), "local data can leave the machine"),
        ("MOD_SESSION_DATA_LEAVES", first_call(sources, data), "session data can leave the machine"),
        ("MOD_RUNS_SLASH_COMMAND", first_call(sources, {"$.command.run"}), "runs slash commands"),
        ("MOD_SUBMITS_PROMPT", first_call(sources, {"$.prompt.submit"}), "submits a prompt"),
    ]
    holds += [("MOD_INCLUDES_MOD", (rel, 0), "includes a mod") for rel in sorted(entries)]
    # Inferred: the portal holds ctx-guard 0.2.0, 0.3.1, 0.5.0 and 0.6.0 on plugin.json, no line, and
    # each calls $.settings.read, which hands the mod every settings key, `env` and the helper commands included.
    settings = first_call(sources, {"$.settings.read"})
    if settings:
        holds.append(("MOD_READS_CREDENTIAL", (manifest_rel, 0),
                      f"uses a credential from the user's machine: `$.settings.read` at {settings[0]}:{settings[1]} "
                      "returns the settings' `env` and helper commands"))
    perm = sorted((f.file, f.line) for f in out if f.rule in ("R6", "R7") and f.file in sources)
    if perm:
        holds.append(("MOD_CHANGES_PERMISSIONS", perm[0], "a hook can change what is permitted, see R6/R7"))
    holds = [(code, at, what) for code, at, what in holds if at]
    has_section = readme is not None and re.search(rf"^#+\s*{re.escape(DISCLOSURE_HEADING)}\s*$", readme, re.M | re.I)
    if holds and not has_section:
        out.append(Finding("O27", "warn", readme_rel, 1, f"expected Policy holds ({', '.join(c for c, _, _ in holds)}) need a README section \"{DISCLOSURE_HEADING}\""))
    for code, (rel, line), what in holds:
        out.append(Finding(code, "note", rel, line, f"expected Policy hold ({what}); answer it in the README section \"{DISCLOSURE_HEADING}\""))


# Events that are also the name of a call on `$` (EngineEventOf keys that are methods of
# CoreEngineInterface in the claude-code types): a hook on one sees the call when other code makes it.
CALL_EVENTS = {"tool.call", "tool.check", "agent.spawn", "prompt.submit", "prompt.fill", "prompt.suggest",
               "prompt.compose", "command.run", "config.set", "telemetry.log", "telemetry.mark",
               "session.compact", "session.send", "session.append", "ui.scroll", "ui.focus", "ui.resolve"}
# The calls the portal named "a call the directory doesn't recognize" (inferred: it raised the note
# at the first $.ui.notify on ctx-guard 0.2.0, 0.3.1, 0.5.0 and 0.6.0).
UNRECOGNIZED_CALLS = {"$.ui.notify"}


def first_hook(sources, pred):
    """(file, line) of the first hook that pred(event, hook) accepts, taking files in name order, or None."""
    for rel in sorted(sources):
        for h in event_hooks(sources[rel], lambda event: True):
            if pred(h["event"], h):
                return rel, h["line"]
    return None


def expected_notes(sources, entries, out):
    """The notes the portal raises on a mod, each at the first call or hook that raises it."""
    sources = reachable(sources, entries)
    notes = [
        ("MOD_UNRECOGNIZED_CALL", first_call(sources, UNRECOGNIZED_CALLS),
         "Mod makes a call the directory doesn’t recognize. If the call comes from another plugin, name that plugin in this plugin's README."),
        ("MOD_WRITES_FILES", first_call(sources, {"$.fs.write"}),
         "Mod writes files. Say in the plugin's README what the mod writes."),
        ("MOD_ADDS_TOOLS", first_call(sources, {"$.command.register", "$.tool.register", "$.agent.register"}),
         "Mod adds tools, commands, or agents. Nothing to change: the directory records that the mod adds tools, commands or agents."),
        # A hook that passes R6/R7's tests (an inline function passing its own event on unchanged, under
        # unique names) is left out:
        # the portal skipped such an agent.spawn hook on ctx-guard 0.2.0 and named the command.run after it.
        ("MOD_HOOKS_CALL_EVENT", first_hook(sources, lambda e, h: e in CALL_EVENTS and (h["changed"] or h["shared"] or h["opaque"])),
         "Mod hooks an event that is also the name of a call, so it may see or change that call when other code makes it. Say in the plugin's README what the hook does."),
        ("MOD_HOOKS_PASS_THROUGH_EVENT", first_hook(sources, lambda e, h: e.startswith("classic.")),
         "Mod hooks an event that settings, instructions, other hooks, or tool descriptions pass through. Say in the plugin's README what the hook changes."),
    ]
    for code, at, text in notes:
        if at:
            out.append(Finding(code, "note", at[0], at[1], text))


def run_plugin(plugin_dir):
    plugin_dir = Path(plugin_dir).resolve()
    out = []
    root, sub, entries, texts = check_plugin_files(plugin_dir, out)
    manifest = check_manifest(plugin_dir, root, texts, out)
    mod_entries = check_hooks_json(plugin_dir, out)
    for rel, text in texts.items():
        in_plugin = os.path.relpath(rel, sub) if sub else rel
        parts = in_plugin.split("/")
        if rel.endswith(".md") and (
            (parts[0] == "skills" and parts[-1] == "SKILL.md") or parts[0] in ("commands", "agents")):
            check_frontmatter(text, os.path.relpath(root / rel), out)
    paths = [(root / rel, os.path.relpath(root / rel)) for rel in texts]
    src_out, sources = check_sources(paths, lambda p: texts.get(os.path.relpath(p, root)), set(mod_entries))
    out += src_out
    if mod_entries:
        readme = plugin_dir / "README.md"
        expected_holds(sources, mod_entries, readme.read_text() if readme.exists() else None, os.path.relpath(readme),
                       os.path.relpath(plugin_dir / ".claude-plugin" / "plugin.json"), out)
        expected_notes(sources, mod_entries, out)
    return out, manifest, root, sub, mod_entries


# ---- P1-P3 ---------------------------------------------------------------------------------

def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v).split("-")[0])[:3])


def surface(texts):
    """{"$.noun.method"} and {"on event opts"} across non-test sources."""
    calls, hooks = set(), set()
    for rel, text in texts.items():
        if not is_source(rel) or is_test(rel):
            continue
        src = Source(rel, text)
        calls |= src.capability_calls()
        on_name = src.register_param()
        if on_name:
            hooks |= {f"{e} {o}".strip() for _, e, o, _ in src.registrations(on_name)}
    return calls, hooks


def hook_rows(readme):
    """{event: [rows]}: the rows of the README hook table (a table outside code fences whose header's
    first cell is `Hook`, in any case and emphasis) whose first cell names the event in backticks, each
    row as its cells with whitespace collapsed. Outer pipes are optional, as in GitHub tables."""
    rows, in_table = {}, False
    for line in strip_fences(readme or "").splitlines():
        line = line.strip()
        if "|" not in line:
            in_table = False
            continue
        cells = [" ".join(c.split()) for c in line.strip("|").split("|")]
        if not in_table:
            in_table = cells[0].strip("*_ ").lower() == "hook"  # the header row; a table's later rows follow it
            continue
        for event in re.findall(r"`([^`]+)`", cells[0]):
            rows.setdefault(event, []).append(cells)
    return rows


def opts_key(opts):
    """Options text as its tokens, string literals by value, so quotes and spacing drop out."""
    src, out, end = Source("", opts), [], -1
    for k, (t, pos) in enumerate(src.toks):
        if pos <= end:
            continue  # inside a string literal, or its closing quote
        raw = src.string_at(k)
        if raw is not None:
            out.append(json.dumps(src.value_at(k)))
            end = pos + len(raw) + 1
        else:
            out.append(t)
    return " ".join(out)


def flagged_hooks(texts):
    """{event: [{rel, line, text, flagged, opts, params, shape}]} of permission hooks in file and source
    order; flagged when R6/R7 has a finding on the hook. opts is opts_key of the options; shape is the
    hook text with its options dropped and its parameter names blanked."""
    out = {}
    for rel in sorted(texts):
        if not is_source(rel) or is_test(rel):
            continue
        for h in permission_hooks(Source(rel, texts[rel])):
            shape = h["text"].replace(h["opts"], "", 1) if h["opts"] else h["text"]
            for i, name in enumerate(h["params"]):
                shape = re.sub(rf"(?<![\w$.]){re.escape(name)}(?![\w$])", f"#{i}", shape)
            out.setdefault(h["event"], []).append({
                "rel": rel, "line": h["line"], "text": h["text"], "flagged": bool(h["changed"] or h["opaque"] or h["shared"]),
                "opts": opts_key(h["opts"]), "params": h["params"], "shape": shape})
    return out


# Passes that pair a hook with the tag's on the same event, by the fields that must match. Each pass
# gives every unpaired hook, in order, the first unpaired tag hook that matches; the pass on options
# alone pairs by order. In the passes on one field, a flagged hook takes a tag hook with no finding
# first, so a weak match can't pass a regression off as a hook that was already flagged.
PAIR_PASSES = (("opts", "text"), ("opts", "params", "shape"), ("opts", "params"), ("opts", "shape"), ("opts",),
               ("params", "shape"), ("params",), ("shape",))


def pair_hooks(old, new):
    """[(new hook, old hook or None)] for the hooks on one event."""
    left, pairs = list(old), {}
    for fields in PAIR_PASSES:
        for i, h in enumerate(new):
            if i in pairs or ("params" in fields and not h["params"]):
                continue
            match = [o for o in left if all(o[f] == h[f] for f in fields)]
            if h["flagged"] and len(fields) == 1:
                match.sort(key=lambda o: o["flagged"])
            if match:
                left.remove(match[0])
                pairs[i] = match[0]
    return [(h, pairs.get(i)) for i, h in enumerate(new)]


def run_release(plugin_dir, since):
    out, manifest, root, sub, mod_entries = run_plugin(plugin_dir)
    plugin_dir = Path(plugin_dir).resolve()
    name = manifest.get("name") or plugin_dir.name
    mrel = os.path.relpath(plugin_dir / ".claude-plugin" / "plugin.json")
    tag = since
    if not tag:
        tags = (git(["tag", "--list", f"{name}-v*", "--sort=-v:refname"], root) or "").split()
        tag = tags[0] if tags else None
    if not tag:
        out.append(Finding("P1", "note", mrel, 1, f"no {name}-v* tag yet; nothing to compare"))
        return out
    prefix = f"{sub}/" if sub else ""
    changed = [p for p in (git(["diff", "--name-only", tag, "--", sub or "."], root) or "").split("\n") if p]
    changed += [p for p in (git(["ls-files", "--others", "--exclude-standard", "--", sub or "."], root) or "").split("\n") if p]
    if not changed:
        out.append(Finding("P1", "note", mrel, 1, f"no changes since {tag}"))
        return out
    old_manifest = git(["show", f"{tag}:{prefix}.claude-plugin/plugin.json"], root)
    old_version = json.loads(old_manifest).get("version") if old_manifest else None
    new_version = manifest.get("version")
    if old_version and version_tuple(new_version) <= version_tuple(old_version):
        out.append(Finding("P1", "block", mrel, 1, f"{len(changed)} changed files since {tag} but version {new_version} is not above {old_version}; raise version with every release"))

    # P2: the capability calls and hooks against the tag
    old_files = [p for p in (git(["ls-tree", "-r", "--name-only", tag, "--", sub or "."], root) or "").split("\n") if p]
    old_texts = {}
    for p in old_files:
        if is_source(p) and not is_test(p):
            data = git_bytes(["show", f"{tag}:{p}"], root)
            if data is not None:
                old_texts[p] = data.decode("utf-8", "replace")
    new_texts = {}
    for p, _ in list_entries(root, sub):
        if is_source(p) and not is_test(p):
            t = read_text(root / p)
            if t is not None:
                new_texts[p] = t
    old_calls, old_hooks = surface(old_texts)
    new_calls, new_hooks = surface(new_texts)
    delta = [f"+{c}" for c in sorted(new_calls - old_calls)] + [f"-{c}" for c in sorted(old_calls - new_calls)] \
        + [f"+on {h}" for h in sorted(new_hooks - old_hooks)] + [f"-on {h}" for h in sorted(old_hooks - new_hooks)]
    readme_rel = f"{prefix}README.md"
    readme_path = os.path.relpath(root / readme_rel)
    if delta and readme_rel not in changed:
        out.append(Finding("P2", "block", readme_path, 1,
                           f"capability calls or hooks changed since {tag} ({', '.join(delta)}) but README.md did not; update \"{DISCLOSURE_HEADING}\" and the hook table"))
    readme = read_text(root / readme_rel) or ""
    for h in sorted(new_hooks - old_hooks):
        event = h.split()[0]
        if f"`{event}`" not in readme:
            out.append(Finding("P2", "block", readme_path, 1, f"new hook `{event}` is not in the README hook table"))

    # P3: a permission hook with an R6/R7 finding now that had none at the tag, or no counterpart there,
    # while its event's row in the README hook table is the same or gone
    old_rows = hook_rows(git(["show", f"{tag}:{readme_rel}"], root))
    new_rows = hook_rows(readme)
    old_flags = flagged_hooks(old_texts)
    for event, now in flagged_hooks(new_texts).items():
        if new_rows.get(event) and new_rows.get(event) != old_rows.get(event):
            continue
        rule = "R6" if event == "agent.spawn" else "R7"
        clear = f"describe the change in the `{event}` row of the README hook table, or pass the event on unchanged"
        for h, was in pair_hooks(old_flags.get(event, []), now):
            if not h["flagged"] or (was and was["flagged"]):
                continue
            what = (f"`{event}` hook passed its event on unchanged at {tag} and now has an {rule} finding" if was else
                    f"new `{event}` hook with no counterpart at {tag} has an {rule} finding")
            out.append(Finding("P3", "hold", os.path.relpath(root / h["rel"]), h["line"],
                               f"{what}, so the directory holds it as a change to what is permitted; {clear}"))
    return out


# ---- CLI -----------------------------------------------------------------------------------

def find_plugin_dir(path):
    p = Path(path).resolve()
    for d in [p] + list(p.parents):
        if (d / ".claude-plugin" / "plugin.json").exists():
            return d
    return None


def run_files(paths):
    out = []
    by_plugin = {}
    for p in paths:
        by_plugin.setdefault(find_plugin_dir(Path(p).parent), []).append(p)
    for plugin_dir, ps in by_plugin.items():
        entries = set()
        if plugin_dir is not None:
            scratch = []
            entries = set(check_hooks_json(plugin_dir, scratch))
        res, _ = check_sources([(Path(p), os.path.relpath(p)) for p in ps], read_text, entries)
        out += res
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check a plugin against the claude.ai plugin directory rules.")
    ap.add_argument("--json", action="store_true", help="print findings as JSON")
    ap.add_argument("--fail-on", choices=["block", "hold", "warn"], default="block")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("files", help="R1-R7 on the given files")
    f.add_argument("paths", nargs="+")
    p = sub.add_parser("plugin", help="official rules and R1-R7 on a plugin folder")
    p.add_argument("plugin_dir")
    r = sub.add_parser("release", help="plugin, plus P1-P3 against the last <plugin>-v* tag")
    r.add_argument("plugin_dir")
    r.add_argument("--since", help="tag to compare with (default: the last <plugin>-v* tag)")
    for s in (f, p, r):
        s.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        s.add_argument("--fail-on", choices=["block", "hold", "warn"], default=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    if args.cmd == "files":
        out = run_files(args.paths)
    elif args.cmd == "plugin":
        out = run_plugin(args.plugin_dir)[0]
    else:
        out = run_release(args.plugin_dir, args.since)
    seen = set()
    out = [x for x in out if not ((x.file, x.line, x.rule, x.message) in seen or seen.add((x.file, x.line, x.rule, x.message)))]
    out.sort(key=lambda x: (-LEVELS.index(x.level), x.file, x.line, x.rule))
    if args.json:
        print(json.dumps([x.as_json() for x in out], indent=2))
    else:
        for x in out:
            print(x.text())
    floor = LEVELS.index(args.fail_on)
    return 1 if any(LEVELS.index(x.level) >= floor for x in out) else 0


if __name__ == "__main__":
    sys.exit(main())
