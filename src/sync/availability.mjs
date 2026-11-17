// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Free/busy data of the people invited to a meeting, asked of the
 * mailbox's own server ([MS-ASCMD] ResolveRecipients with Availability).
 *
 *   intervalsOf(merged, startMs)                       → [{ start, end, type }]
 *   await lookupAvailability({ client, email, start, end, signal })
 *                                                      → [{ start, end, type }]
 *
 * It is a reading: nothing is sent to anybody, and nothing is stored. The
 * address asked goes to the server of the mailbox, as it would in an
 * invitation. A server that does not answer (a protocol before 14.0, a
 * recipient it does not know, no data) gives an empty list: Thunderbird
 * then shows nothing for that person, as it does without this module.
 *
 * `type` is "tentative", "busy", "oof" (out of office) or "unknown" (the
 * server has no data for that time). Free time is not listed.
 */

import { availabilityRequest, parseAvailability, MAX_AVAILABILITY_MS } from "../core/protocol.mjs";
import * as v from "../core/sanitize.mjs";

const HALF_HOUR = 1_800_000;
/** The longest span answered: two requests. A longer one is not asked at all. */
export const MAX_SPAN_MS = 2 * MAX_AVAILABILITY_MS;
const TYPES = ["free", "tentative", "busy", "oof", "unknown"];
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 256 * 1024;

/**
 * A MergedFreeBusy string (one digit per half hour from `startMs`) → the
 * intervals that are not free, neighbours of one type joined, in order.
 */
export function intervalsOf(merged, startMs) {
  const out = [];
  if (typeof merged !== "string" || !Number.isSafeInteger(startMs)) return out;
  let last = null;
  for (let i = 0; i < merged.length; i++) {
    const type = TYPES[merged.charCodeAt(i) - 48];
    if (!type || type === "free") {
      last = null;
      continue;
    }
    const start = startMs + i * HALF_HOUR;
    if (last && last.type === type) last.end = start + HALF_HOUR;
    else out.push((last = { start, end: start + HALF_HOUR, type }));
  }
  return out;
}

/**
 * The intervals of one address between `start` and `end` (milliseconds).
 * → [] when the address or the span is not one that can be asked, when the
 * server speaks a protocol before 14.0, or has no data. Throws what the
 * client throws (network, authentication): the caller decides what to
 * tell.
 */
export async function lookupAvailability({ client, email, start, end, signal = null }) {
  const address = v.emailAddress(email);
  if (!address || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return [];
  // Whole half hours, so that each digit of the answer is one of ours.
  const from = Math.floor(start / HALF_HOUR) * HALF_HOUR;
  const to = Math.ceil(end / HALF_HOUR) * HALF_HOUR;
  if (to - from < HALF_HOUR || to - from > MAX_SPAN_MS) return [];
  await client.ensureVersion({ signal });
  const version = client.proto?.asVersion ?? null;
  if (version !== "14.0" && version !== "14.1") return [];
  const out = [];
  for (let at = from; at < to; at += MAX_AVAILABILITY_MS) {
    const until = Math.min(to, at + MAX_AVAILABILITY_MS);
    const doc = await client.command("ResolveRecipients", availabilityRequest([address], at, until), { signal, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    if (!doc) continue;
    const entry = parseAvailability(doc).get(address.toLowerCase());
    if (!entry?.merged) continue;
    // Never more digits than the span asked has half hours.
    const digits = entry.merged.slice(0, Math.ceil((until - at) / HALF_HOUR));
    for (const interval of intervalsOf(digits, at)) {
      const last = out[out.length - 1];
      if (last && last.type === interval.type && last.end === interval.start) last.end = interval.end;
      else out.push(interval);
    }
  }
  return out;
}
