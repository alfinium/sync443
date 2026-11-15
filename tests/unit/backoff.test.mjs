// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/** Backoff tests: growth, cap, jitter bounds, Retry-After precedence and cap (module header). */

import { test, assert, eq, prng } from "./harness.mjs";
import { retryDelay, BACKOFF } from "../../src/core/backoff.mjs";

const fixed = (x) => () => x;
const MIN = 60_000;
const DAY = 24 * 3600_000;

test("backoff : valeurs par défaut 30 s, 30 min, ±20 %", () => {
  eq(BACKOFF.base, 30_000);
  eq(BACKOFF.max, 30 * MIN);
  eq(BACKOFF.jitter, 0.2);
  assert(Object.isFrozen(BACKOFF), "BACKOFF doit être figé");
});

test("backoff : aucun échec → aucune attente", () => {
  eq(retryDelay(0), 0);
  eq(retryDelay(-3), 0);
});

test("backoff : croissance 30 s, 1 min, 2 min… sans aléa", () => {
  const mid = fixed(0.5); // 2·0.5−1 = 0: no jitter
  eq(retryDelay(1, { random: mid }), 30_000);
  eq(retryDelay(2, { random: mid }), MIN);
  eq(retryDelay(3, { random: mid }), 2 * MIN);
  eq(retryDelay(4, { random: mid }), 4 * MIN);
  eq(retryDelay(5, { random: mid }), 8 * MIN);
  eq(retryDelay(6, { random: mid }), 16 * MIN);
  eq(retryDelay(7, { random: mid }), 30 * MIN, "plafond atteint");
});

test("backoff : plafond de 30 min, même pour un très grand nombre d'échecs", () => {
  for (const n of [7, 8, 20, 31, 32, 100, 1e6, Number.MAX_SAFE_INTEGER]) {
    for (const r of [0, 0.5, 0.999999]) {
      const d = retryDelay(n, { random: fixed(r) });
      assert(Number.isFinite(d), `délai fini pour ${n}`);
      assert(d <= 30 * MIN, `plafond dépassé pour ${n} échecs : ${d}`);
      assert(d >= 0.8 * 30 * MIN, `trop court au plafond pour ${n} échecs : ${d}`);
    }
  }
});

test("backoff : aléa borné à ±20 %", () => {
  eq(retryDelay(3, { random: fixed(0) }), 0.8 * 2 * MIN, "aléa minimal");
  eq(retryDelay(3, { random: fixed(0.999999) }), 144_000, "aléa maximal (+20 %)");
  const rnd = prng(42);
  for (let i = 0; i < 2000; i++) {
    const failures = 1 + Math.floor(rnd() * 10);
    const exp = Math.min(30 * MIN, 30_000 * 2 ** (failures - 1));
    const d = retryDelay(failures, { random: rnd });
    assert(Number.isInteger(d), "délai entier en millisecondes");
    assert(d >= Math.max(15_000, Math.floor(0.8 * exp)) && d <= Math.min(30 * MIN, Math.ceil(1.2 * exp)), `hors bornes : ${failures} échecs → ${d}`);
  }
});

test("backoff : jamais moins de la moitié de la base, même avec un aléa extrême", () => {
  eq(retryDelay(1, { random: fixed(0), jitter: 0.9 }), 15_000);
  eq(retryDelay(1, { random: fixed(0), base: 1000, jitter: 1 }), 1000, "jamais moins d'une seconde");
});

test("backoff : paramètres base, max et jitter", () => {
  eq(retryDelay(1, { random: fixed(0.5), base: 1000, max: 5000 }), 1000);
  eq(retryDelay(3, { random: fixed(0.5), base: 1000, max: 5000 }), 4000);
  eq(retryDelay(4, { random: fixed(0.5), base: 1000, max: 5000 }), 5000);
  eq(retryDelay(2, { random: fixed(1), base: 1000, jitter: 0 }), 2000, "sans aléa");
});

test("backoff : Retry-After l'emporte quand il demande plus longtemps", () => {
  eq(retryDelay(1, { random: fixed(0.5), retryAfterMs: 10 * MIN }), 10 * MIN);
  eq(retryDelay(7, { random: fixed(0.5), retryAfterMs: 2 * 3600_000 }), 2 * 3600_000, "au-delà du plafond de 30 min");
});

test("backoff : Retry-After plus court que le délai calculé est ignoré", () => {
  eq(retryDelay(3, { random: fixed(0.5), retryAfterMs: 1000 }), 2 * MIN);
  eq(retryDelay(3, { random: fixed(0.5), retryAfterMs: 0 }), 2 * MIN);
  eq(retryDelay(3, { random: fixed(0.5), retryAfterMs: -5000 }), 2 * MIN, "valeur négative");
});

test("backoff : Retry-After plafonné à 24 h", () => {
  eq(retryDelay(1, { random: fixed(0.5), retryAfterMs: DAY + 1 }), DAY);
  eq(retryDelay(1, { random: fixed(0.5), retryAfterMs: 1e15 }), DAY);
  eq(retryDelay(1, { random: fixed(0.5), retryAfterMs: Infinity }), DAY);
});
