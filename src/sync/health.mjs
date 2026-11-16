// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Health of a mailbox: may an automatic sync run now?
 *
 * - After a FATAL failure (wrong password, access denied, remote wipe
 *   request, bad configuration) the mailbox is
 *   "blocked": no automatic attempt at all until the user acts (saves the
 *   mailbox, or clicks Synchronise). This avoids hammering the server with
 *   a wrong password until its intrusion filter bans the address.
 * - After another failure (network, timeout, busy server…) the next
 *   automatic attempt waits, longer each time (core/backoff.mjs), or as
 *   long as the server asked (Retry-After).
 *
 * Pure functions over a plain, storable object.
 */

import { retryDelay } from "../core/backoff.mjs";
import { FATAL } from "../transport/client.mjs";

/** failedItems: server items whose import keeps failing (fetched again at every pass, sync/mail.mjs), as the last pass counted them. */
export const initialHealth = () => ({ failures: 0, nextAttemptAt: 0, blocked: null, lastError: null, lastSuccessAt: null, failedItems: 0 });

/** A pass succeeded: everything before it is cleared. */
export function recordSuccess(now, { failedItems = 0 } = {}) {
  return { ...initialHealth(), lastSuccessAt: now, failedItems: Number.isSafeInteger(failedItems) && failedItems > 0 ? failedItems : 0 };
}

/** `error`: { code, message, retryAfterMs? } (an EasError or alike). */
export function recordFailure(health, error, now, { random = Math.random } = {}) {
  const h = { ...initialHealth(), ...health };
  const lastError = { code: String(error?.code ?? "UNKNOWN"), message: String(error?.message ?? "").slice(0, 500), at: now };
  if (FATAL.has(lastError.code)) {
    return { ...h, blocked: { code: lastError.code, message: lastError.message, at: now }, lastError };
  }
  const failures = h.failures + 1;
  const delay = retryDelay(failures, { retryAfterMs: Number(error?.retryAfterMs) || 0, random });
  return { ...h, failures, nextAttemptAt: now + delay, lastError };
}

/** → { ok: true } or { ok: false, reason: "blocked" | "backoff", until? } */
export function canSyncAutomatically(health, now) {
  const h = { ...initialHealth(), ...health };
  if (h.blocked) return { ok: false, reason: "blocked" };
  if (now < h.nextAttemptAt) return { ok: false, reason: "backoff", until: h.nextAttemptAt };
  return { ok: true };
}

/** The user asked for a sync (or saved the mailbox): try now, whatever happened before. */
export function clearForUser(health) {
  const h = { ...initialHealth(), ...health };
  return { ...h, blocked: null, nextAttemptAt: 0 };
}
