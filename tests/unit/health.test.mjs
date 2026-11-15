// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

import { test, eq, assert } from "./harness.mjs";
import { initialHealth, recordSuccess, recordFailure, canSyncAutomatically, clearForUser } from "../../src/sync/health.mjs";

const half = () => 0.5; // no jitter

test("santé : une boîte neuve peut se synchroniser", () => {
  eq(canSyncAutomatically(initialHealth(), 0), { ok: true });
});

test("santé : mot de passe refusé → plus aucune tentative automatique", () => {
  const h = recordFailure(initialHealth(), { code: "AUTH", message: "refusé" }, 1000, { random: half });
  eq(canSyncAutomatically(h, 10 ** 12).reason, "blocked");
  eq(h.blocked.code, "AUTH");
});

test("santé : chaque code fatal bloque", () => {
  for (const code of ["AUTH", "DENIED", "WIPE_REQUESTED", "CONFIG"]) {
    assert(recordFailure(initialHealth(), { code }, 0).blocked, code);
  }
  // A refused certificate: nothing was sent, and a captive portal goes away by itself → retried, spaced out.
  for (const code of ["TLS", "PROXY_AUTH", "NETWORK", "TIMEOUT", "HTTP", "BUSY", "BAD_RESPONSE", "TOO_LARGE"]) {
    assert(!recordFailure(initialHealth(), { code }, 0).blocked, code);
  }
});

test("santé : recul croissant après des erreurs réseau", () => {
  let h = initialHealth();
  const waits = [];
  for (let i = 0; i < 8; i++) {
    h = recordFailure(h, { code: "NETWORK" }, 0, { random: half });
    waits.push(h.nextAttemptAt);
  }
  eq(waits.slice(0, 4), [30_000, 60_000, 120_000, 240_000]);
  eq(waits[7], 30 * 60_000, "plafonné à 30 min");
  eq(canSyncAutomatically(h, 1000).reason, "backoff");
  eq(canSyncAutomatically(h, 30 * 60_000).ok, true);
});

test("santé : Retry-After du serveur respecté s'il est plus long", () => {
  const h = recordFailure(initialHealth(), { code: "BUSY", retryAfterMs: 3_600_000 }, 0, { random: half });
  eq(h.nextAttemptAt, 3_600_000);
});

test("santé : un succès efface tout", () => {
  const h = recordSuccess(recordFailure(initialHealth(), { code: "NETWORK" }, 0), 5000);
  eq(h.failures, 0);
  eq(h.lastSuccessAt, 5000);
  eq(canSyncAutomatically(h, 5000), { ok: true });
});

test("santé : l'utilisateur relance une boîte bloquée", () => {
  const blocked = recordFailure(initialHealth(), { code: "AUTH" }, 0);
  const h = clearForUser(blocked);
  eq(canSyncAutomatically(h, 0), { ok: true });
  eq(h.lastError.code, "AUTH", "l'erreur reste affichable");
});

test("santé : message d'erreur tronqué", () => {
  const h = recordFailure(initialHealth(), { code: "HTTP", message: "x".repeat(5000) }, 0);
  eq(h.lastError.message.length, 500);
});
