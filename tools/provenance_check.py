# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""
Code-provenance check: looks, in the project's files, for code taken from
third-party reference trees (MOSS-like winnowing, standard library only).

    python3 -I tools/provenance_check.py --ref DIR_OR_FILE [--ref ...] [--target DIR ...]

What it does
  1. Tokenizes JavaScript / MJS / JSON (comments and whitespace dropped,
     ";" and trailing commas dropped as pure formatting) into three streams:
       - exact      identifiers and literal values kept (quotes, number
                    spelling and escapes canonicalised: 'a' == "a", 0x0a == 10);
       - normalised identifiers -> ID, strings -> STR, numbers -> NUM,
                    keywords and punctuation kept, except the trivial swaps
                    const/let/var and ===/== (finds renamed copies);
                    not used for JSON, where everything is a string;
       - literals   only the strings and numbers, in order (finds a table
                    re-expressed in another syntax; CSV cells feed it too).
  2. Winnowing (Schleimer, Wilkerson, Aiken 2003) over k-gram hashes of each
     stream; shared fingerprints are verified then extended into maximal
     runs. k = threshold // 3 and window w = threshold - k + 1, so every
     shared run at least as long as the threshold is guaranteed to be found.
  3. Each run is classified "data" (mostly literals inside arrays/objects)
     or "code", from the target-side tokens.
  4. Also: files copied wholesale (same bytes, same token stream, or same
     text modulo whitespace), license / third-party mentions, identical long
     string literals and regular expressions, identical comment or text lines.

Exit status: 1 if a "code" match (exact or normalised stream) or a wholesale
copy is found, 0 otherwise, 2 on a usage error. Everything else is reported
for a human to judge.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
from collections import defaultdict, deque

# ── Files ──────────────────────────────────────────────────────────────────

JS_EXT = (".js", ".mjs", ".cjs", ".jsm", ".json", ".ts")
CSV_EXT = (".csv",)
SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", "dist"}
DOC_NAMES = ("readme", "notice", "license", "licence", "copying", "authors", "changes", "changelog")
SELF_FILES = ("provenance_check.py", "provenance_check_selftest.py")

# ── Tokenizer ──────────────────────────────────────────────────────────────

KEYWORDS = frozenset(
    """await break case catch class const continue debugger default delete do
    else enum export extends false finally for function if import in instanceof
    let new null return static super switch this throw true try typeof undefined
    var void while with yield""".split()
)
LITERAL_KW = frozenset(("true", "false", "null", "undefined"))
REGEX_AFTER_KW = frozenset(
    "return typeof instanceof in of new delete void throw case do else yield await".split()
)
PUNCTS = sorted(
    """>>>= ... === !== **= <<= >>= >>> &&= ||= ??= => == != <= >= && || ?? ?.
    ++ -- += -= *= /= %= &= |= ^= ** << >> { } ( ) [ ] ; , < > + - * / % & | ^
    ! ~ ? : = . @""".split(),
    key=len,
    reverse=True,
)
PUNCT_RE = re.compile("|".join(re.escape(p) for p in PUNCTS))
WS_RE = re.compile(r"[ \t\r\n\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
NUM_RE = re.compile(
    r"(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+"
    r"|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?"
)
ID_RE = re.compile(r"(?:[^\W\d]|\$)(?:\w|\$)*")
STR_RE = {
    "'": re.compile(r"'((?:[^'\\\n]|\\[\s\S])*)'?"),
    '"': re.compile(r'"((?:[^"\\\n]|\\[\s\S])*)"?'),
}
REGEX_RE = re.compile(r"/(?![*/])(?:[^/\\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+/[A-Za-z]*")
ESC_RE = re.compile(r"\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])")
ESC_SIMPLE = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def _unescape(m):
    e = m.group(1)
    if e.startswith("u{"):
        try:
            return chr(int(e[2:-1], 16))
        except (ValueError, OverflowError):
            return e
    if e[0] in "ux" and len(e) > 1:
        return chr(int(e[1:], 16))
    if e in ("\n", "\r\n", "\r", "\u2028", "\u2029"):
        return ""  # line continuation
    return ESC_SIMPLE.get(e, e)


def js_string_value(raw):
    return ESC_RE.sub(_unescape, raw) if "\\" in raw else raw


def js_number_value(raw):
    s = raw.replace("_", "")
    try:
        if s.endswith("n"):
            return str(int(s[:-1], 0)) + "n"
        if s[:2].lower() in ("0x", "0o", "0b"):
            return str(int(s, 0))
        v = float(s)
        return str(int(v)) if v.is_integer() and abs(v) < 2**53 else repr(v)
    except ValueError:
        return raw


def tokenize_js(src):
    """Returns (tokens, comments). A token is (kind, value, line, end_line);
    kind is id, kw, str, tpl (a template chunk), num, re or punct. A comment
    is (line, text)."""
    toks, comments = [], []
    n, pos, line = len(src), 0, 1
    stack = []  # "{" for a brace, "`" for a template interpolation

    def prev():
        return toks[-1] if toks else None

    def regex_allowed():
        p = prev()
        if p is None:
            return True
        kind, val = p[0], p[1]
        if kind == "punct":
            return val not in (")", "]", "}")
        if kind == "kw":
            return val in REGEX_AFTER_KW
        return False

    def scan_template(start, first):
        """Scans a template chunk starting at `start`. Returns the new position."""
        nonlocal line
        i, buf = start, []
        while i < n:
            ch = src[i]
            if ch == "\\":
                buf.append(src[i : i + 2])
                i += 2
                continue
            if ch == "`" or (ch == "$" and src.startswith("${", i)):
                break
            buf.append(ch)
            i += 1
        raw = "".join(buf)
        end_line = line + raw.count("\n")
        closing = src[i : i + 1]
        if first and closing == "`":
            toks.append(("str", js_string_value(raw), line, end_line))  # no interpolation
        else:
            if first:
                toks.append(("punct", "`", line, line))
            if raw:
                toks.append(("tpl", js_string_value(raw), line, end_line))
            if closing == "`":
                toks.append(("punct", "`", end_line, end_line))
            elif i < n:
                toks.append(("punct", "${", end_line, end_line))
                stack.append("`")
        line = end_line
        if i >= n:
            return n
        return i + (1 if closing == "`" else 2)

    if src.startswith("#!"):
        pos = src.find("\n")
        pos = n if pos < 0 else pos
    while pos < n:
        c = src[pos]
        if c in " \t\r\n\f\v\u00a0\ufeff\u2028\u2029" or c in "\u1680\u202f\u205f\u3000" or "\u2000" <= c <= "\u200a":
            m = WS_RE.match(src, pos)
            line += src.count("\n", pos, m.end())
            pos = m.end()
            continue
        if c == "/":
            nx = src[pos + 1 : pos + 2]
            if nx == "/":
                end = src.find("\n", pos)
                end = n if end < 0 else end
                comments.append((line, src[pos:end]))
                pos = end
                continue
            if nx == "*":
                end = src.find("*/", pos + 2)
                end = n if end < 0 else end + 2
                text = src[pos:end]
                comments.append((line, text))
                line += text.count("\n")
                pos = end
                continue
            if regex_allowed():
                m = REGEX_RE.match(src, pos)
                if m:
                    toks.append(("re", m.group(0), line, line))
                    pos = m.end()
                    continue
        if c == "'" or c == '"':
            m = STR_RE[c].match(src, pos)
            raw = m.group(1)
            end_line = line + raw.count("\n")
            toks.append(("str", js_string_value(raw), line, end_line))
            line = end_line
            pos = m.end()
            continue
        if c == "`":
            pos = scan_template(pos + 1, True)
            continue
        if c == "}" and stack and stack[-1] == "`":
            stack.pop()
            toks.append(("punct", "}", line, line))
            pos = scan_template(pos + 1, False)
            continue
        if c.isdigit() or (c == "." and src[pos + 1 : pos + 2].isdigit()):
            m = NUM_RE.match(src, pos)
            if m and m.end() > pos:
                toks.append(("num", js_number_value(m.group(0)), line, line))
                pos = m.end()
                continue
        if c == "#":
            m = ID_RE.match(src, pos + 1)
            if m:
                toks.append(("id", "#" + m.group(0), line, line))
                pos = m.end()
                continue
        m = ID_RE.match(src, pos)
        if m:
            word = m.group(0)
            p = prev()
            after_dot = p is not None and p[0] == "punct" and p[1] in (".", "?.")
            kind = "kw" if word in KEYWORDS and not after_dot else "id"
            toks.append((kind, word, line, line))
            pos = m.end()
            continue
        m = PUNCT_RE.match(src, pos)
        if m:
            p = m.group(0)
            if p == "?." and src[pos + 2 : pos + 3].isdigit():
                p = "?"
            if p == "{":
                stack.append("{")
            elif p == "}" and stack:
                stack.pop()
            toks.append(("punct", p, line, line))
            pos += len(p)
            continue
        toks.append(("punct", c, line, line))  # unknown character, kept as is
        pos += 1
    return toks, comments


def tokenize_csv(text):
    toks = []
    for lineno, row in enumerate(csv.reader(io.StringIO(text)), 1):
        for cell in row:
            cell = cell.strip()
            if cell:
                toks.append(("str", cell, lineno, lineno))
    return toks


# ── Source files and streams ───────────────────────────────────────────────

_INTERN = {}


def intern(key):
    v = _INTERN.get(key)
    if v is None:
        v = _INTERN[key] = len(_INTERN)
    return v


def exact_key(t):
    kind, val = t[0], t[1]
    if kind in ("str", "tpl"):
        return "S:" + val
    if kind == "num":
        return "N:" + val
    if kind == "id":
        return "I:" + val
    if kind == "kw":
        return "K:" + val
    if kind == "re":
        return "R:" + val
    return "P:" + val


NORM_SYNONYMS = {"K:var": "K:decl", "K:let": "K:decl", "K:const": "K:decl", "P:===": "P:==", "P:!==": "P:!="}


def norm_key(t):
    kind = t[0]
    if kind in ("str", "tpl"):
        return "STR"
    if kind == "num":
        return "NUM"
    if kind == "id":
        return "ID"
    if kind == "re":
        return "RE"
    key = exact_key(t)
    return NORM_SYNONYMS.get(key, key)  # trivial swaps: const/let/var, ===/==


class SrcFile:
    def __init__(self, path, rel):
        self.path, self.rel = path, rel
        with open(path, "rb") as fh:
            self.raw = fh.read()
        self.binary = b"\0" in self.raw[:8192]
        self.text = "" if self.binary else self.raw.decode("utf-8", errors="replace")
        self.lines = self.text.splitlines()
        low = path.lower()
        self.kind = "binary" if self.binary else "js" if low.endswith(JS_EXT) else "csv" if low.endswith(CSV_EXT) else "text"
        self.is_json = low.endswith(".json")
        self.toks, self.comments = [], []
        if self.kind == "js":
            self.toks, self.comments = tokenize_js(self.text)
        elif self.kind == "csv":
            self.toks = tokenize_csv(self.text)
        # Kept tokens: ";" and a comma before a closing bracket are formatting.
        sel = []
        toks = self.toks
        for i, t in enumerate(toks):
            if t[0] == "punct":
                if t[1] == ";":
                    continue
                if t[1] == "," and i + 1 < len(toks) and toks[i + 1][0] == "punct" and toks[i + 1][1] in (")", "]", "}"):
                    continue
            sel.append(i)
        self.sel = sel
        self.exact = [intern(exact_key(toks[i])) for i in sel] if self.kind == "js" else []
        self.norm = [intern(norm_key(toks[i])) for i in sel] if self.kind == "js" and not self.is_json else []
        self.lit_pos = [j for j, i in enumerate(sel) if toks[i][0] in ("str", "tpl", "num")]
        self.lit = [intern(exact_key(toks[sel[j]])) for j in self.lit_pos]
        self._comment_lines = None
        self._code_lines = None

    def tok(self, j):
        return self.toks[self.sel[j]]

    def line_span(self, s, e):
        """Source line range of kept tokens s..e-1."""
        return self.tok(s)[2], self.tok(e - 1)[3]

    def comment_lines(self):
        if self._comment_lines is None:
            cl = set()
            for line, text in self.comments:
                cl.update(range(line, line + text.count("\n") + 1))
            self._comment_lines = cl
            code = set()
            for t in self.toks:
                code.update(range(t[2], t[3] + 1))
            self._code_lines = code
        return self._comment_lines

    def line_context(self, lineno):
        base = os.path.basename(self.rel).lower()
        if self.kind == "text" and (base.endswith((".md", ".txt", ".rst")) or base.startswith(DOC_NAMES)):
            return "documentation"
        if self.kind == "js":
            cl = self.comment_lines()
            if lineno in cl and lineno not in self._code_lines:
                return "commentaire"
            if lineno in cl:
                return "code + commentaire"
            return "code"
        if self.kind == "text":
            s = self.lines[lineno - 1].lstrip() if lineno <= len(self.lines) else ""
            if s.startswith(("#", "//", "<!--", "*", ";")):
                return "commentaire"
        return "texte"


def collect(roots, exclude):
    """Returns the files under `roots` (directories or single files)."""
    roots = [os.path.abspath(r) for r in roots]
    parents = [os.path.dirname(r.rstrip(os.sep)) for r in roots]
    base = os.path.commonpath(parents) if parents else os.getcwd()
    paths = []
    for r in roots:
        if os.path.isfile(r):
            paths.append(r)
            continue
        for dirpath, dirnames, filenames in os.walk(r):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for fn in sorted(filenames):
                paths.append(os.path.join(dirpath, fn))
    files, seen = [], set()
    for p in paths:
        rp = os.path.realpath(p)
        if rp in seen or not os.path.isfile(rp):
            continue
        seen.add(rp)
        rel = os.path.relpath(p, base)
        if any(re.search(x, rel) for x in exclude):
            continue
        try:
            files.append(SrcFile(p, rel))
        except OSError as e:
            print(f"avertissement : {rel} illisible ({e})", file=sys.stderr)
    return files


# ── Winnowing and runs ─────────────────────────────────────────────────────


def winnow(seq, k, w):
    """Robust winnowing: (hash, position) of the rightmost minimal k-gram hash
    of every window of w consecutive k-grams, each selected position once."""
    n = len(seq) - k + 1
    if n <= 0:
        return []
    hs = [hash(tuple(seq[i : i + k])) for i in range(n)]
    if n < w:
        m = min(range(n), key=lambda i: (hs[i], -i))
        return [(hs[m], m)]
    out, dq, last = [], deque(), -1
    for i, h in enumerate(hs):
        while dq and hs[dq[-1]] >= h:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - w:
            dq.popleft()
        if i >= w - 1 and dq[0] != last:
            last = dq[0]
            out.append((hs[last], last))
    return out


def params(threshold):
    k = max(4, threshold // 3)
    return k, max(1, threshold - k + 1)


def shared_runs(targets, refs, stream, threshold):
    """Maximal runs of equal tokens shared by a target and a reference file,
    at least `threshold` tokens long: (ti, ri, t_start, t_end, r_start, r_end)."""
    k, w = params(threshold)
    index = defaultdict(list)
    for ri, rf in enumerate(refs):
        for h, p in winnow(getattr(rf, stream), k, w):
            index[h].append((ri, p))
    runs = []
    for ti, tf in enumerate(targets):
        tseq = getattr(tf, stream)
        tn = len(tseq)
        last = {}
        for h, tp in winnow(tseq, k, w):
            for ri, rp in index.get(h, ()):
                key = (ri, tp - rp)
                lr = last.get(key)
                if lr is not None and lr[0] <= tp < lr[1]:
                    continue  # already inside a run found on this diagonal
                rseq = getattr(refs[ri], stream)
                if tseq[tp : tp + k] != rseq[rp : rp + k]:
                    continue  # hash collision
                ts, rs = tp, rp
                while ts > 0 and rs > 0 and tseq[ts - 1] == rseq[rs - 1]:
                    ts -= 1
                    rs -= 1
                te, re_ = tp + k, rp + k
                rn = len(rseq)
                while te < tn and re_ < rn and tseq[te] == rseq[re_]:
                    te += 1
                    re_ += 1
                last[key] = (ts, te)
                if te - ts >= threshold:
                    runs.append((ti, ri, ts, te, rs, re_))
    return runs


# ── Classification ─────────────────────────────────────────────────────────

STRUCT = frozenset(", : [ ] { } ( )".split())


def composition(f, s, e):
    """Share of literal tokens (strings, numbers, true/false/null, object keys)
    and of 'other' tokens (identifiers, keywords, operators) in kept tokens s..e-1."""
    lit = other = 0
    n = e - s
    for j in range(s, e):
        kind, val = f.tok(j)[0], f.tok(j)[1]
        if kind in ("str", "tpl", "num") or (kind == "kw" and val in LITERAL_KW):
            lit += 1
            continue
        if kind == "punct":
            if val in STRUCT:
                continue
            if val in ("-", "+") and j + 1 < len(f.sel) and f.tok(j + 1)[0] == "num":
                continue  # sign of a number in a table
            other += 1
            continue
        nxt = f.tok(j + 1) if j + 1 < len(f.sel) else None
        prv = f.tok(j - 1) if j > 0 else None
        if (
            kind in ("id", "kw")
            and nxt is not None and nxt[0] == "punct" and nxt[1] == ":"
            and prv is not None and prv[0] == "punct" and prv[1] in ("{", ",")
        ):
            lit += 1  # key of an object literal
            continue
        other += 1
    return lit / max(n, 1), other / max(n, 1)


def classify(f, s, e):
    lit, other = composition(f, s, e)
    return ("data" if lit >= 0.30 and other <= 0.20 else "code"), lit, other


def literal_agreement(tf, ts, te, rf, rs):
    """For a normalised run: share of its literal tokens whose values are equal
    on both sides (1.0 when it has no literal)."""
    same = total = 0
    for d in range(te - ts):
        a, b = tf.tok(ts + d), rf.tok(rs + d)
        if a[0] in ("str", "tpl", "num"):
            total += 1
            same += exact_key(a) == exact_key(b)
    return same / total if total else 1.0


# ── Grouping ───────────────────────────────────────────────────────────────


class Group:
    def __init__(self, stream, tf, ts, te, rf, rs, re_):
        self.stream, self.tf, self.ts, self.te = stream, tf, ts, te
        self.rf, self.rs, self.re = rf, rs, re_
        self.length = te - ts  # in the stream's own units
        self.exact_len = 0
        self.alts = []  # (rf, rs, re) in kept-token coordinates
        self.cls, self.lit, self.other = classify(tf, ts, te)
        self.note = ""

    def overlap(self, ts, te):
        return max(0, min(self.te, te) - max(self.ts, ts))

    def add_alt(self, rf, rs, re_):
        if (rf, rs) != (self.rf, self.rs) and all((a[0], a[1]) != (rf, rs) for a in self.alts):
            self.alts.append((rf, rs, re_))


def to_kept(f, stream, s, e):
    if stream == "lit":
        return f.lit_pos[s], f.lit_pos[e - 1] + 1
    return s, e


def group_runs(runs, stream, targets, refs, groups_by_file, new_groups):
    """Adds the runs of `stream` to the groups (one group per target region)."""
    for ti, ri, ts, te, rs, re_ in sorted(runs, key=lambda r: r[2] - r[3]):
        tf, rf = targets[ti], refs[ri]
        kts, kte = to_kept(tf, stream, ts, te)
        krs, kre = to_kept(rf, stream, rs, re_)
        length = kte - kts
        for g in groups_by_file[ti]:
            if g.overlap(kts, kte) >= 0.5 * min(length, g.te - g.ts):
                if stream == "exact" and g.stream == "norm":
                    g.exact_len = max(g.exact_len, te - ts)
                if stream == g.stream:
                    g.add_alt(rf, krs, kre)
                break
        else:
            g = Group(stream, tf, kts, kte, rf, krs, kre)
            g.length = te - ts
            if stream == "exact":
                g.exact_len = te - ts
            groups_by_file[ti].append(g)
            new_groups.append(g)


# ── Other checks ───────────────────────────────────────────────────────────

MENTIONS = [
    ("en-tête MPL", re.compile(r"This Source Code Form is subject to", re.I)),
    ("MPL", re.compile(r"Mozilla Public\s+Licen[sc]e|\bMPL\b|mozilla\.org/MPL", re.I)),
    ("EAS-4-TbSync", re.compile(r"EAS-4-TbSync", re.I)),
    ("TbSync", re.compile(r"tbsync", re.I)),
    ("webext-experiments", re.compile(r"webext-experiments", re.I)),
    ("auteur tiers", re.compile(r"jobisoft|Kewisch", re.I)),
    ("ical.js", re.compile(r"\bical(?:\.min)?\.js\b", re.I)),
]


def find_mentions(targets):
    out = []
    for f in targets:
        if f.binary:
            continue
        for i, text in enumerate(f.lines, 1):
            labels = [lab for lab, rx in MENTIONS if rx.search(text)]
            if "EAS-4-TbSync" in labels and "TbSync" in labels:
                labels.remove("TbSync")
            if labels:
                out.append({"file": f.rel, "line": i, "labels": labels, "context": f.line_context(i), "text": text.strip()})
    return out


def wholesale_keys(f):
    keys = []
    if len(f.raw) >= 100:
        keys.append(("octets identiques", hashlib.sha256(f.raw).hexdigest()))
    if f.kind == "js" and len(f.exact) >= 20:
        h = hashlib.sha256("\x00".join(exact_key(f.tok(j)) for j in range(len(f.sel))).encode("utf-8", "surrogatepass")).hexdigest()
        keys.append(("mêmes jetons (copie reformatée)", h))
    elif f.kind in ("text", "csv"):
        norm = "\n".join(" ".join(l.split()) for l in f.lines if l.strip())
        if len(norm) >= 100:
            keys.append(("même texte aux espaces près", hashlib.sha256(norm.encode("utf-8", "surrogatepass")).hexdigest()))
    return keys


def find_wholesale(targets, refs):
    idx = defaultdict(list)
    for rf in refs:
        for how, h in wholesale_keys(rf):
            idx[h].append(rf)
    out = []
    for tf in targets:
        for how, h in wholesale_keys(tf):
            if h in idx:
                out.append({"file": tf.rel, "how": how, "refs": [r.rel for r in idx[h]]})
                break
    return out


def string_tokens(f, min_len, min_regex):
    """Long strings (template chunks and CSV cells included) and long regex literals."""
    for t in f.toks:
        if (t[0] in ("str", "tpl") and len(t[1]) >= min_len) or (t[0] == "re" and len(t[1]) >= min_regex):
            yield t[0], t[1], t[2]


def find_long_strings(targets, refs, min_len, min_regex):
    idx = defaultdict(list)
    for rf in refs:
        for kind, s, line in string_tokens(rf, min_len, min_regex):
            idx[(kind == "re", s)].append(f"{rf.rel}:{line}")
    out, seen = [], set()
    for tf in targets:
        for kind, s, line in string_tokens(tf, min_len, min_regex):
            key = (kind == "re", s)
            if key in idx and (tf.rel, line, key) not in seen:
                seen.add((tf.rel, line, key))
                out.append({"file": tf.rel, "line": line, "kind": "regex" if kind == "re" else "string",
                            "length": len(s), "refs": idx[key][:5], "text": s})
    return out


COMMENT_MARK_RE = re.compile(r"^(?:/\*+|\*+/|\*+|//+|#+|<!--|-->|;+)\s*")


def norm_text_line(s):
    s = COMMENT_MARK_RE.sub("", s.strip())
    s = re.sub(r"\s*\*/\s*$", "", s)
    return " ".join(s.split())


def text_lines(f):
    """(line number, normalised text) of the comment lines of a JS file, or of
    every line of a text file."""
    if f.kind == "js":
        for line, text in f.comments:
            for d, part in enumerate(text.split("\n")):
                yield line + d, norm_text_line(part)
    elif f.kind == "text":
        for i, text in enumerate(f.lines, 1):
            yield i, norm_text_line(text)


def find_text_lines(targets, refs, min_len):
    idx = defaultdict(list)
    for rf in refs:
        for line, s in text_lines(rf):
            if len(s) >= min_len:
                idx[s].append(f"{rf.rel}:{line}")
    out = []
    for tf in targets:
        for line, s in text_lines(tf):
            if len(s) >= min_len and s in idx:
                out.append({"file": tf.rel, "line": line, "refs": idx[s][:3], "text": s})
    return out


# ── Report ─────────────────────────────────────────────────────────────────


def snippet(f, first_line, count=3, width=140):
    out = []
    for ln in range(first_line, min(first_line + count, len(f.lines) + 1)):
        text = f.lines[ln - 1].rstrip().expandtabs(4)
        if len(text) > width:
            text = text[: width - 1] + "…"
        out.append(f"{ln:>6} │ {text}")
    return out


def loc(f, s, e):
    a, b = f.line_span(s, e)
    return f"{f.rel}:{a}" if a == b else f"{f.rel}:{a}-{b}"


STREAM_FR = {"norm": "normalisé", "exact": "exact", "lit": "littéraux"}


def describe_group(g, tag, max_alts=5):
    unit = "littéraux" if g.stream == "lit" else "jetons"
    lines = [f"[{tag}] {loc(g.tf, g.ts, g.te)}  ⇐  {loc(g.rf, g.rs, g.re)}"]
    detail = f"flux {STREAM_FR[g.stream]} : {g.length} {unit}"
    if g.stream == "norm":
        detail += f" (plus longue partie identique à l'exact : {g.exact_len} jetons)" if g.exact_len else " (aucune partie exacte ≥ seuil)"
    detail += f" ; composition côté cible : littéraux {g.lit:.0%}, autres {g.other:.0%}"
    if g.stream == "lit":
        detail += " → table de données" if g.cls == "data" else " → littéraux dispersés dans du code"
    lines.append("      " + detail)
    if g.note:
        lines.append("      " + g.note)
    for rf, rs, re_ in g.alts[:max_alts]:
        lines.append(f"      aussi : {loc(rf, rs, re_)}")
    if len(g.alts) > max_alts:
        lines.append(f"      … et {len(g.alts) - max_alts} autre(s) emplacement(s) dans les références")
    lines.append("      cible :")
    lines += ["      " + s for s in snippet(g.tf, g.tf.line_span(g.ts, g.te)[0])]
    lines.append("      référence :")
    lines += ["      " + s for s in snippet(g.rf, g.rf.line_span(g.rs, g.re)[0])]
    return lines


def merged_regions(runs, targets):
    """Locations of the target regions covered by `runs`, overlapping runs merged."""
    spans = defaultdict(list)
    for ti, _ri, ts, te, _rs, _re in runs:
        spans[ti].append((ts, te))
    out = []
    for ti in sorted(spans, key=lambda i: targets[i].rel):
        cur = None
        for s, e in sorted(spans[ti]) + [(None, None)]:
            if cur and s is not None and s <= cur[1]:
                cur[1] = max(cur[1], e)
                continue
            if cur:
                out.append(loc(targets[ti], cur[0], cur[1]))
            cur = [s, e] if s is not None else None
    return out


def lit_coverage(groups):
    """{target file: (literals inside a shared literal sequence, literals in the file)}."""
    covered = defaultdict(set)
    files = {}
    for g in groups:
        files[g.tf.rel] = g.tf
        covered[g.tf.rel].update(j for j in range(g.ts, g.te) if g.tf.tok(j)[0] in ("str", "tpl", "num"))
    return {rel: (len(covered[rel]), len(f.lit)) for rel, f in files.items()}


def group_json(g):
    return {
        "stream": g.stream,
        "class": g.cls,
        "target": loc(g.tf, g.ts, g.te),
        "ref": loc(g.rf, g.rs, g.re),
        "length": g.length,
        "exact_length": g.exact_len,
        "literal_share": round(g.lit, 3),
        "other_share": round(g.other, 3),
        "also": [loc(rf, rs, re_) for rf, rs, re_ in g.alts],
        "note": g.note,
    }


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    ap = argparse.ArgumentParser(description="Recherche de code tiers copié dans le projet (winnowing).")
    ap.add_argument("--ref", action="append", required=True, help="dossier ou fichier de référence (répétable)")
    ap.add_argument("--target", action="append", help="dossier ou fichier à contrôler (défaut : src/, tests/, tools/ du dépôt)")
    ap.add_argument("--exclude", action="append", default=[], help="regex sur le chemin relatif, fichiers ignorés (répétable)")
    ap.add_argument("--min-norm", type=int, default=60, help="seuil du flux normalisé, en jetons (défaut 60)")
    ap.add_argument("--min-exact", type=int, default=30, help="seuil du flux exact, en jetons (défaut 30)")
    ap.add_argument("--min-literals", type=int, default=40, help="seuil du flux des littéraux (défaut 40)")
    ap.add_argument("--min-string", type=int, default=80, help="longueur minimale des chaînes identiques (défaut 80)")
    ap.add_argument("--min-regex", type=int, default=30, help="longueur minimale des expressions régulières identiques (défaut 30)")
    ap.add_argument("--min-comment", type=int, default=40, help="longueur minimale des lignes de commentaire identiques (défaut 40)")
    ap.add_argument("--json", metavar="FICHIER", help="écrit aussi les résultats en JSON")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(errors="backslashreplace")  # lone surrogates from "\ud800" escapes
    for name in ("min_norm", "min_exact", "min_literals"):
        if getattr(args, name) < 8:
            ap.error(f"--{name.replace('_', '-')} doit valoir au moins 8")
    for r in args.ref + (args.target or []):
        if not os.path.exists(r):
            ap.error(f"introuvable : {r}")
    target_roots = args.target or [p for p in (os.path.join(repo, d) for d in ("src", "tests", "tools")) if os.path.isdir(p)]
    if not target_roots:
        ap.error("aucune cible : passer --target")

    refs = collect(args.ref, [])
    ref_real = {os.path.realpath(f.path) for f in refs}
    self_real = {os.path.realpath(os.path.join(here, n)) for n in SELF_FILES}
    targets, excluded = [], []
    for f in collect(target_roots, args.exclude):
        rp = os.path.realpath(f.path)
        if rp in self_real or rp in ref_real:
            excluded.append(f.rel)
        else:
            targets.append(f)

    # Token runs, longest first, grouped by target region.
    groups_by_file = defaultdict(list)
    groups, suppressed = [], []
    norm_runs = shared_runs(targets, refs, "norm", args.min_norm)
    kept_norm = []
    for r in norm_runs:
        ti, ri, ts, te, rs, re_ = r
        cls = classify(targets[ti], ts, te)[0]
        if cls == "data" and literal_agreement(targets[ti], ts, te, refs[ri], rs) < 0.5:
            suppressed.append(r)  # same table shape, different values: not evidence
        else:
            kept_norm.append(r)
    group_runs(kept_norm, "norm", targets, refs, groups_by_file, groups)
    group_runs(shared_runs(targets, refs, "exact", args.min_exact), "exact", targets, refs, groups_by_file, groups)
    lit_groups = []
    group_runs(shared_runs(targets, refs, "lit", args.min_literals), "lit", targets, refs, groups_by_file, lit_groups)
    for g in groups + lit_groups:
        if g.cls == "data":
            strs = [g.tf.tok(j)[1] for j in range(g.ts, g.te) if g.tf.tok(j)[0] in ("str", "tpl")]
            if strs and sum(len(s) for s in strs) / len(strs) > 40:
                g.note = "attention : chaînes longues en moyenne (texte rédigé plutôt que noms ou valeurs ?)"
    key = lambda g: (g.tf.rel, g.ts)
    code = sorted((g for g in groups if g.cls == "code"), key=key)
    data = sorted((g for g in groups if g.cls == "data"), key=key)
    lits = sorted(lit_groups, key=key)

    wholesale = find_wholesale(targets, refs)
    strings = find_long_strings(targets, refs, args.min_string, args.min_regex)
    textlines = find_text_lines(targets, refs, args.min_comment)
    mentions = find_mentions(targets)
    failed = bool(code or wholesale)
    shape_only = merged_regions(suppressed, targets)

    def count(fs, attr):
        return sum(len(getattr(f, attr)) for f in fs)

    out = []
    p = out.append
    p("Contrôle de provenance du code")
    p("=" * 30)
    p(f"Cible       : {', '.join(target_roots)}")
    p(f"              {len(targets)} fichiers, dont {sum(f.kind == 'js' for f in targets)} JS/JSON ({count(targets, 'exact')} jetons)")
    p(f"Références  : {', '.join(args.ref)}")
    p(f"              {len(refs)} fichiers, dont {sum(f.kind == 'js' for f in refs)} JS/JSON ({count(refs, 'exact')} jetons) et {sum(f.kind == 'csv' for f in refs)} CSV")
    p(f"Seuils      : normalisé ≥ {args.min_norm} jetons, exact ≥ {args.min_exact} jetons, littéraux ≥ {args.min_literals}, "
      f"chaînes ≥ {args.min_string} car., regex ≥ {args.min_regex} car., lignes de commentaire ≥ {args.min_comment} car.")
    if excluded:
        p(f"Exclus      : {', '.join(excluded)}")
    p("")
    p("Résumé")
    p("------")
    p(f"  Copies intégrales de fichiers                 : {len(wholesale)}")
    p(f"  Correspondances de CODE                       : {len(code)}")
    p(f"  Correspondances de DONNÉES (tables)           : {len(data)}")
    p(f"  Suites de littéraux communes (faits, ordre)   : {len(lits)}")
    p(f"  Chaînes ou regex longues identiques           : {len(strings)}")
    p(f"  Lignes de commentaire ou de texte identiques  : {len(textlines)}")
    p(f"  Mentions (licence MPL, projets ou auteurs)    : {len(mentions)}")
    if shape_only:
        p(f"  Ignorées (même forme de table, valeurs différentes) : {', '.join(shape_only[:5])}"
          + (f" et {len(shape_only) - 5} autre(s)" if len(shape_only) > 5 else ""))
    if failed:
        p("  Verdict : ÉCHEC — code ou fichier repris des références, à corriger.")
    else:
        p("  Verdict : OK — aucune correspondance de code ni copie intégrale ; le reste est à juger par un humain.")
    p("")

    def section(title, items, render, preface=()):
        p(title)
        p("-" * len(title))
        out.extend(preface)
        if not items:
            p("  (aucune)")
        for i, it in enumerate(items, 1):
            out.extend("  " + l for l in render(i, it))
            p("")
        p("")

    section("1. Copies intégrales de fichiers", wholesale,
            lambda i, w: [f"[F{i}] {w['file']} = {', '.join(w['refs'])} ({w['how']})"])
    section("2. Correspondances de code", code, lambda i, g: describe_group(g, f"C{i}"))
    section("3. Correspondances de données (tables : faits possibles, à juger)", data, lambda i, g: describe_group(g, f"D{i}"))
    coverage = [f"  Couverture : {rel} a {c} de ses {t} littéraux ({c / max(t, 1):.0%}) dans ces suites"
                for rel, (c, t) in sorted(lit_coverage(lits).items())]
    section("4. Suites de littéraux communes (mêmes valeurs dans le même ordre, syntaxe libre)", lits,
            lambda i, g: describe_group(g, f"L{i}"), coverage + ([""] if coverage else []))
    section("5. Chaînes et expressions régulières longues identiques", strings,
            lambda i, s: [f"[S{i}] {s['file']}:{s['line']} ({s['kind']}, {s['length']} car.) = {', '.join(s['refs'])}",
                          f"      « {s['text'][:120]}{'…' if len(s['text']) > 120 else ''} »"])
    section("6. Lignes de commentaire ou de texte identiques", textlines,
            lambda i, t: [f"[T{i}] {t['file']}:{t['line']} = {', '.join(t['refs'])}", f"      « {t['text'][:140]} »"])
    section("7. Mentions (licence MPL, projets ou auteurs tiers)", mentions,
            lambda i, m: [f"[M{i}] {m['file']}:{m['line']} [{', '.join(m['labels'])}] ({m['context']})",
                          f"      {m['text'][:160]}"])
    p("Rappel : seules les sections 1 et 2 font échouer le contrôle ; les sections 3 à 7 listent des")
    p("recoupements (faits du protocole, données publiques, mentions explicatives) qu'un humain doit juger.")
    sys.stdout.write("\n".join(out) + "\n")

    if args.json:
        with open(args.json, "w", encoding="utf-8", errors="backslashreplace") as fh:
            json.dump({
                "failed": failed,
                "wholesale": wholesale,
                "code": [group_json(g) for g in code],
                "data": [group_json(g) for g in data],
                "literal_sequences": [group_json(g) for g in lits],
                "long_strings": strings,
                "text_lines": textlines,
                "mentions": mentions,
                "suppressed_shape_only": shape_only,
                "excluded": excluded,
            }, fh, ensure_ascii=False, indent=2)
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # a crash must not read as "copy found" (status 1)
        import traceback
        traceback.print_exc()
        print(f"erreur interne : {exc}", file=sys.stderr)
        sys.exit(2)
