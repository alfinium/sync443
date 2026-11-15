// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Minimal test harness for the JavaScriptCore shell (`jsc -m`), which has
 * no Node, no DOM and no TextEncoder: the code under test must not need
 * them either (the core is written that way on purpose).
 *
 *   import { test, assert, eq, throws, rejects } from "./harness.mjs";
 *   test("name", () => { ... });            // sync or async
 *
 * tests/unit/run-all.mjs imports every *.test.mjs file, then calls run().
 */

const out = globalThis.print ?? ((...a) => console.log(...a)); // eslint-disable-line no-console
const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export class AssertionError extends Error {}

export function assert(condition, message = "assertion échouée") {
  if (!condition) throw new AssertionError(message);
}

const show = (x) => {
  try {
    if (x instanceof Uint8Array) return `Uint8Array[${Array.from(x.slice(0, 32)).join(",")}${x.length > 32 ? ",…" : ""}]`;
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
};

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function eq(actual, expected, message = "") {
  if (!deepEqual(actual, expected)) {
    throw new AssertionError(`${message ? `${message} : ` : ""}attendu ${show(expected)}, obtenu ${show(actual)}`);
  }
}

/** fn must throw; `check` (optional) is a class or a predicate on the error. */
export function throws(fn, check, message = "") {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (!thrown) throw new AssertionError(`${message ? `${message} : ` : ""}aucune exception levée`);
  if (check && !(typeof check === "function" && check.prototype ? thrown instanceof check : check(thrown))) {
    throw new AssertionError(`${message ? `${message} : ` : ""}exception inattendue ${thrown?.name}: ${thrown?.message}`);
  }
  return thrown;
}

export async function rejects(promiseOrFn, check, message = "") {
  let thrown = null;
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    thrown = e;
  }
  if (!thrown) throw new AssertionError(`${message ? `${message} : ` : ""}aucune exception levée`);
  if (check && !(typeof check === "function" && check.prototype ? thrown instanceof check : check(thrown))) {
    throw new AssertionError(`${message ? `${message} : ` : ""}exception inattendue ${thrown?.name}: ${thrown?.message}`);
  }
  return thrown;
}

/** Deterministic pseudo-random generator (mulberry32), for reproducible fuzzing. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The JavaScriptCore shell has no AbortController: a small stand-in with the
// part of the API the code uses (signal.aborted, signal.reason, abort events).
if (typeof globalThis.AbortController !== "function") {
  class Signal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.listeners = new Set();
    }
    addEventListener(type, fn) {
      if (type === "abort") this.listeners.add(fn);
    }
    removeEventListener(type, fn) {
      if (type === "abort") this.listeners.delete(fn);
    }
  }
  globalThis.AbortController = class {
    constructor() {
      this.signal = new Signal();
    }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      for (const fn of [...this.signal.listeners]) fn({ type: "abort" });
    }
  };
}

export async function run() {
  let failed = 0;
  const started = Date.now();
  for (const t of tests) {
    try {
      await t.fn();
      out(`  ok    ${t.name}`);
    } catch (e) {
      failed++;
      out(`  ÉCHEC ${t.name}\n        ${e?.message ?? e}`);
    }
  }
  out(`\n${tests.length - failed}/${tests.length} tests réussis en ${Date.now() - started} ms.`);
  if (failed) throw new Error(`${failed} test(s) en échec`);
}
