# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""
Self-test of provenance_check.py, on small files written to a temporary
directory:

    python3 -I tools/provenance_check_selftest.py

  a) a copy with every identifier renamed, other quotes, no semicolons,
     let/var for const and different comments is found by the normalised
     stream (exit status 1);
  b) unrelated code made of common idioms (imports, for loops, small
     helpers, one helper identical to the reference's) is not flagged at the
     default thresholds (exit status 0); a "TbSync" mention is listed; a
     lone-surrogate escape ("\ud800") does not crash the tool;
  c) a table re-expressed in another syntax (same facts, same order) is
     listed as a literal sequence, not as code (exit status 0);
  d) a reformatted copy of a whole file is a wholesale copy (exit status 1);
  e) tokenizer details (regex vs division, templates, quotes, numbers).
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "provenance_check.py")

# Stands for third-party code.
REF_RECURRENCE = r"""
/* Reference module: recurrence rules. */
import { readPath, toInt } from "./helpers.mjs";

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function parseRecurrence(node, startDate) {
  const rule = { freq: null, interval: 1, count: null, until: null, byDay: [] };
  const type = toInt(readPath(node, ["Recurrence", "Type"]));
  switch (type) {
    case 0: rule.freq = "DAILY"; break;
    case 1: rule.freq = "WEEKLY"; break;
    case 2: case 3: rule.freq = "MONTHLY"; break;
    case 5: case 6: rule.freq = "YEARLY"; break;
    default: return null;
  }
  const interval = toInt(readPath(node, ["Recurrence", "Interval"]));
  if (interval > 1) rule.interval = interval;
  const mask = toInt(readPath(node, ["Recurrence", "DayOfWeek"]));
  for (let bit = 0; bit < 7; bit++) {
    if (mask & (1 << bit)) rule.byDay.push(DAYS[bit]);
  }
  const occurrences = readPath(node, ["Recurrence", "Occurrences"]);
  if (occurrences) {
    rule.count = toInt(occurrences);
  } else if (startDate && rule.freq === "WEEKLY" && rule.byDay.length === 0) {
    rule.byDay.push(DAYS[startDate.getUTCDay()]);
  }
  return rule;
}
"""

REF_HELPERS = r"""
import { encode, decode } from "./codec.mjs";

export function isEmpty(obj) { return !obj || Object.keys(obj).length === 0; }

export function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function countBits(n) {
  let c = 0;
  for (let i = 0; i < 32; i++) {
    if (n & (1 << i)) c++;
  }
  return c;
}

export function readPath(node, path) {
  for (const tag of path) {
    node = node && node.children ? node.children.find((c) => c.tag === tag) : null;
    if (!node) return null;
  }
  return node.text;
}

export function roundTrip(text) {
  return decode(encode(text));
}
"""

REF_TABLE = r"""
export const TOKENS = {
  0x05: "Sync", 0x06: "Responses", 0x07: "Add", 0x08: "Change", 0x09: "Delete",
  0x0a: "Fetch", 0x0b: "SyncKey", 0x0c: "ClientId", 0x0d: "ServerId", 0x0e: "Status",
  0x0f: "Collection", 0x10: "Class", 0x12: "CollectionId", 0x13: "GetChanges",
  0x14: "MoreAvailable", 0x15: "WindowSize", 0x16: "Commands", 0x17: "Options",
  0x18: "FilterType", 0x1b: "Conflict", 0x1c: "Collections", 0x1d: "ApplicationData",
};
"""

# (a) Renamed copy of REF_RECURRENCE: identifiers, property names and string
# values changed, single quotes, no semicolons, let/var for const, other
# comments and layout.
TARGET_RENAMED = r"""
// Repeat pattern decoding.
import { pathValue, asNumber } from './util.mjs'

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export function decodeRepeat(elem, firstDay) {
  let r = { frequency: null, every: 1, times: null, end: null, days: [] }
  var kind = asNumber(pathValue(elem, ['Recurrence', 'Type']))
  switch (kind) {
    case 0: r.frequency = 'daily'; break
    case 1: r.frequency = 'weekly'; break
    case 2: case 3: r.frequency = 'monthly'; break
    case 5: case 6: r.frequency = 'yearly'; break
    default: return null
  }
  const every = asNumber(pathValue(elem, ['Recurrence', 'Interval']))
  if (every > 1) r.every = every
  const bits = asNumber(pathValue(elem, ['Recurrence', 'DayOfWeek']))
  for (let k = 0; k < 7; k++) {
    if (bits & (1 << k)) r.days.push(WEEKDAYS[k])
  }
  const n = pathValue(elem, ['Recurrence', 'Occurrences'])
  if (n) {
    r.times = asNumber(n)
  } else if (firstDay && r.frequency === 'weekly' && r.days.length === 0) {
    r.days.push(WEEKDAYS[firstDay.getUTCDay()])
  }
  return r
}
"""

# (b) Unrelated code built from the same common idioms.
TARGET_UNRELATED = r"""
// SPDX-License-Identifier: MIT
// Written from the specification; not derived from TbSync.
import { encode, decode } from "./codec.mjs";
import { log } from "./log.mjs";

export function isEmpty(obj) { return !obj || Object.keys(obj).length === 0; }

export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}

export function indexBy(items, key) {
  const out = new Map();
  for (const item of items) {
    out.set(item[key], item);
  }
  return out;
}

export function popCount(word) {
  let ones = 0;
  while (word) {
    word &= word - 1;
    ones++;
  }
  return ones;
}

export async function retry(fn, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      log(`attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  throw lastError;
}

export function echo(text) {
  return decode(encode(String(text)));
}

export const LONE_SURROGATE = "a\ud800b"; // must not crash the tool
"""

# (c) The facts of REF_TABLE, expressed differently.
TARGET_TABLE = r"""
const PAGE0 = [
  [5, "Sync"], [6, "Responses"], [7, "Add"], [8, "Change"], [9, "Delete"],
  [10, "Fetch"], [11, "SyncKey"], [12, "ClientId"], [13, "ServerId"], [14, "Status"],
  [15, "Collection"], [16, "Class"], [18, "CollectionId"], [19, "GetChanges"],
  [20, "MoreAvailable"], [21, "WindowSize"], [22, "Commands"], [23, "Options"],
  [24, "FilterType"], [27, "Conflict"], [28, "Collections"], [29, "ApplicationData"],
];
export const tagOf = (token) => new Map(PAGE0).get(token);
"""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def run(ref, target, work):
    out_json = os.path.join(work, "out.json")
    proc = subprocess.run(
        [sys.executable, "-I", TOOL, "--ref", ref, "--target", target, "--json", out_json],
        capture_output=True, text=True,
    )
    if proc.returncode not in (0, 1):
        raise RuntimeError(proc.stderr)
    with open(out_json, encoding="utf-8") as fh:
        return proc.returncode, json.load(fh), proc.stdout


def load_tool():
    sys.dont_write_bytecode = True  # no __pycache__ left in tools/
    spec = importlib.util.spec_from_file_location("provenance_check", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    results = []

    def check(name, cond, detail=""):
        results.append(cond)
        print(f"{'OK   ' if cond else 'ÉCHEC'} {name}" + (f" — {detail}" if detail else ""))

    with tempfile.TemporaryDirectory() as tmp:
        ref = os.path.join(tmp, "ref")
        write(os.path.join(ref, "recurrence.mjs"), REF_RECURRENCE)
        write(os.path.join(ref, "helpers.mjs"), REF_HELPERS)
        write(os.path.join(ref, "table.mjs"), REF_TABLE)

        # (a)
        ta = os.path.join(tmp, "a")
        write(os.path.join(ta, "repeat.mjs"), TARGET_RENAMED)
        code, res, _ = run(ref, ta, tmp)
        norm = [g for g in res["code"] if g["stream"] == "norm"]
        check("(a) copie renommée : statut de sortie 1", code == 1, f"statut {code}")
        check("(a) trouvée par le flux normalisé, classée code",
              len(norm) == 1 and norm[0]["class"] == "code" and norm[0]["ref"].startswith("ref/recurrence.mjs:")
              and norm[0]["length"] >= 60,
              f"{norm[0]['target']} ⇐ {norm[0]['ref']}, {norm[0]['length']} jetons normalisés" if norm else "rien")
        check("(a) le flux exact seul ne l'aurait pas trouvée",
              bool(norm) and norm[0]["exact_length"] < 30 and not any(g["stream"] == "exact" for g in res["code"]),
              "aucune partie exacte ≥ 30 jetons" if norm and not norm[0]["exact_length"] else "")

        # (b)
        tb = os.path.join(tmp, "b")
        write(os.path.join(tb, "util.mjs"), TARGET_UNRELATED)
        code, res, _ = run(ref, tb, tmp)
        check("(b) idiomes communs : statut de sortie 0", code == 0, f"statut {code}")
        check("(b) ni code, ni données, ni copie signalés",
              not res["code"] and not res["data"] and not res["wholesale"],
              f"code {len(res['code'])}, données {len(res['data'])}, copies {len(res['wholesale'])}")
        check("(b) la mention de TbSync est listée, en commentaire",
              any("TbSync" in m["labels"] and m["context"] == "commentaire" for m in res["mentions"]),
              f"{len(res['mentions'])} mention(s)")

        # (c)
        tc = os.path.join(tmp, "c")
        write(os.path.join(tc, "pages.mjs"), TARGET_TABLE)
        code, res, _ = run(ref, tc, tmp)
        check("(c) table re-exprimée : statut de sortie 0, pas de code", code == 0 and not res["code"], f"statut {code}")
        check("(c) listée comme suite de littéraux de type données",
              len(res["literal_sequences"]) == 1 and res["literal_sequences"][0]["class"] == "data"
              and res["literal_sequences"][0]["length"] == 44,
              ", ".join(f"{g['target']} ⇐ {g['ref']} ({g['length']} littéraux)" for g in res["literal_sequences"]))

        # (d)
        td = os.path.join(tmp, "d")
        write(os.path.join(td, "h.mjs"), "// copied\n" + REF_HELPERS.replace("  ", "\t").replace(";\n", "\n"))
        code, res, _ = run(ref, td, tmp)
        check("(d) copie intégrale reformatée : statut 1, signalée",
              code == 1 and len(res["wholesale"]) == 1 and res["wholesale"][0]["refs"] == ["ref/helpers.mjs"],
              json.dumps(res["wholesale"], ensure_ascii=False))

    # (e)
    pc = load_tool()
    keys = lambda src: [pc.exact_key(t) for t in pc.tokenize_js(src)[0]]
    toks = pc.tokenize_js("const a = b / 2 / c; const r = /ab+c/g.test(x); // note\n")[0]
    check("(e) regex et division distinguées",
          [t[1] for t in toks if t[0] == "re"] == ["/ab+c/g"] and sum(t[1] == "/" for t in toks) == 2)
    check("(e) gabarits imbriqués", keys("`x${a + `y${b}`}z`") ==
          ["P:`", "S:x", "P:${", "I:a", "P:+", "P:`", "S:y", "P:${", "I:b", "P:}", "P:`", "P:}", "S:z", "P:`"])
    check("(e) guillemets et échappements canonicalisés",
          keys("'it\\'s'") == keys('"it\'s"') == keys("`it's`") and keys('"\\u00e9"') == keys('"é"'))
    check("(e) nombres canonicalisés", keys("0x0a") == keys("10") and keys("1_000") == keys("1000.0"))
    check("(e) commentaires ignorés, mot-clé après un point = identifiant",
          keys("/* c */ a.default // d\n") == ["I:a", "P:.", "I:default"])

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} vérifications réussies.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
