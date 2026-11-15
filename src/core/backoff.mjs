// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Exponential backoff with jitter, for automatic retries after a failure:
 * 30 s, 1 min, 2 min… up to 30 min, ±20 %. A server's Retry-After wins
 * when it asks for longer.
 */

export const BACKOFF = Object.freeze({ base: 30_000, max: 30 * 60_000, jitter: 0.2 });

export function retryDelay(failures, { retryAfterMs = 0, random = Math.random, base = BACKOFF.base, max = BACKOFF.max, jitter = BACKOFF.jitter } = {}) {
  failures = Number.isFinite(failures) ? Math.floor(failures) : 1; // unknown count: as after one failure
  retryAfterMs = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : 0; // NaN → 0, Infinity → the cap below
  const DAY = 24 * 3600_000;
  const asked = Math.min(retryAfterMs, DAY);
  if (failures <= 0) return asked;
  const exp = Math.min(max, base * 2 ** Math.min(failures - 1, 30));
  const r = Number(random());
  const spread = exp * jitter * (2 * (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5) - 1);
  const delay = Math.round(Math.min(max, Math.max(base / 2, exp + spread)));
  const result = Math.max(delay, asked);
  // Whatever the options, a finite delay between 1 s and one day.
  return Number.isFinite(result) ? Math.min(Math.max(result, 1000), DAY) : BACKOFF.base;
}
