// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the free/busy lookup against [MS-ASCMD] 2.2.1.15
 * (ResolveRecipients with Availability), 2.2.3.16, 2.2.3.107 and the
 * example of 4.18.4.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import { availabilityRequest, parseAvailability, ProtocolError, MAX_AVAILABILITY_MS, MAX_AVAILABILITY_RECIPIENTS } from "../../src/core/protocol.mjs";
import { intervalsOf, lookupAvailability, MAX_SPAN_MS } from "../../src/sync/availability.mjs";
import { el, encode, decode, text, child } from "../../src/core/wbxml.mjs";

const HALF = 1_800_000;
const T0 = Date.UTC(2026, 11, 1, 8, 0, 0);
const R = (tag, content) => el(`ResolveRecipients:${tag}`, content);
const wire = (node) => decode(encode(node));
const isProtocol = (e) => e instanceof ProtocolError;

/** A response for one address: a Response with one Recipient and its Availability. */
function response(to, { status = "1", availability = "1", merged = null, recipients = 1 } = {}) {
  const recipient = (n) =>
    R("Recipient", [R("Type", "1"), R("DisplayName", `Personne ${n}`), R("EmailAddress", to), availability === null ? null : R("Availability", [R("Status", availability), merged === null ? null : R("MergedFreeBusy", merged)])]);
  return R("Response", [R("To", to), R("Status", status), R("RecipientCount", String(recipients)), ...Array.from({ length: recipients }, (_, n) => recipient(n))]);
}
const answer = (...responses) => wire(R("ResolveRecipients", [R("Status", "1"), ...responses]));

test("availability: the request asks the addresses, the span, and nothing else", () => {
  const doc = wire(availabilityRequest(["Anne@example.org", "bruno@example.org"], T0, T0 + 2 * 86_400_000));
  eq([doc.ns, doc.tag], ["ResolveRecipients", "ResolveRecipients"]);
  eq(doc.children.filter((c) => c.tag === "To").map((c) => text(c)), ["Anne@example.org", "bruno@example.org"]);
  const options = child(doc, "Options");
  eq(options.children.map((c) => c.tag), ["MaxAmbiguousRecipients", "Availability"]);
  const availability = child(options, "Availability");
  eq([text(availability, "StartTime"), text(availability, "EndTime")], ["2026-12-01T08:00:00.000Z", "2026-12-03T08:00:00.000Z"]);
});

test("availability: invalid requests are refused before anything is sent", () => {
  const ok = ["a@example.org"];
  for (const bad of [
    () => availabilityRequest([], T0, T0 + HALF),
    () => availabilityRequest(Array.from({ length: MAX_AVAILABILITY_RECIPIENTS + 1 }, (_, i) => `a${i}@example.org`), T0, T0 + HALF),
    () => availabilityRequest(["pas une adresse"], T0, T0 + HALF),
    () => availabilityRequest(["a@example.org", "A@example.org"], T0, T0 + HALF),
    () => availabilityRequest(ok, T0, T0 + HALF - 1),
    () => availabilityRequest(ok, T0, T0 + MAX_AVAILABILITY_MS + 1),
    () => availabilityRequest(ok, T0 + HALF, T0),
    () => availabilityRequest(ok, 1.5, T0),
    () => availabilityRequest("a@example.org", T0, T0 + HALF),
  ]) {
    throws(bad, isProtocol);
  }
});

test("availability: the answer of the specification's example is read", () => {
  const merged = "002000000000000000000000001002002200000010000000";
  const map = parseAvailability(answer(response("all@example.org", { availability: "162" }), response("Chris@example.org", { merged }), response("tom@example.org", { status: "3", recipients: 2, availability: null })));
  eq(map.get("all@example.org"), { status: "162", merged: null });
  eq(map.get("chris@example.org"), { status: "1", merged });
  eq(map.get("tom@example.org"), { status: null, merged: null }, "suggestions are nobody's availability");
});

test("availability: a failed command, or data that is not digits, gives nothing", () => {
  throws(() => parseAvailability(wire(R("ResolveRecipients", [R("Status", "5")]))), isProtocol);
  throws(() => parseAvailability(wire(el("AirSync:Sync", []))), isProtocol);
  for (const merged of ["", "0125", "12a", "9", " 1"]) eq(parseAvailability(answer(response("a@example.org", { merged }))).get("a@example.org").merged, null);
  eq(parseAvailability(answer(response("a@example.org", { merged: "1".repeat(32768) }))).get("a@example.org").merged.length, 32768);
  eq(parseAvailability(answer(response("a@example.org", { merged: "1".repeat(32769) }))).get("a@example.org").merged, null);
});

test("availability: digits become intervals, neighbours joined, free time left out", () => {
  eq(intervalsOf("32201", T0), [
    { start: T0, end: T0 + HALF, type: "oof" },
    { start: T0 + HALF, end: T0 + 3 * HALF, type: "busy" },
    { start: T0 + 4 * HALF, end: T0 + 5 * HALF, type: "tentative" },
  ]);
  eq(intervalsOf("0000", T0), []);
  eq(intervalsOf("4", T0), [{ start: T0, end: T0 + HALF, type: "unknown" }]);
  eq(intervalsOf("2x2", T0).length, 2);
  eq(intervalsOf(null, T0), []);
});

/** A client double: its version, and one answer per command. */
function client(version, reply) {
  const sent = [];
  return {
    sent,
    proto: { asVersion: version },
    async ensureVersion() {},
    async command(cmd, root) {
      const doc = wire(root);
      sent.push({ cmd, doc });
      return reply(doc);
    },
  };
}
const replyAll = (digit) => (doc) => {
  const a = child(child(doc, "Options"), "Availability");
  const halves = Math.ceil((Date.parse(text(a, "EndTime")) - Date.parse(text(a, "StartTime"))) / HALF);
  return answer(response(text(doc, "To"), { merged: digit.repeat(halves) }));
};

test("availability: a lookup asks whole half hours and returns the intervals", async () => {
  const c = client("14.1", () => answer(response("anne@example.org", { merged: "0220" })));
  const got = await lookupAvailability({ client: c, email: "anne@example.org", start: T0 + 60_000, end: T0 + 2 * HALF - 60_000 });
  eq(got, [{ start: T0 + HALF, end: T0 + 2 * HALF, type: "busy" }], "never more digits than the span asked has half hours");
  const a = child(child(c.sent[0].doc, "Options"), "Availability");
  eq([c.sent[0].cmd, text(a, "StartTime"), text(a, "EndTime")], ["ResolveRecipients", "2026-12-01T08:00:00.000Z", "2026-12-01T09:00:00.000Z"]);
});

test("availability: a long span is asked in two requests, and joined", async () => {
  const c = client("14.0", replyAll("2"));
  const span = MAX_AVAILABILITY_MS + 86_400_000;
  eq(await lookupAvailability({ client: c, email: "anne@example.org", start: T0, end: T0 + span }), [{ start: T0, end: T0 + span, type: "busy" }]);
  eq(c.sent.length, 2);
});

test("availability: nothing is asked when it cannot be answered", async () => {
  for (const version of ["12.1", null, "16.1"]) {
    const c = client(version, replyAll("2"));
    eq(await lookupAvailability({ client: c, email: "anne@example.org", start: T0, end: T0 + HALF }), []);
    eq(c.sent.length, 0);
  }
  const c = client("14.1", replyAll("2"));
  for (const bad of [
    { email: "pas une adresse", start: T0, end: T0 + HALF },
    { email: "anne@example.org", start: T0, end: T0 },
    { email: "anne@example.org", start: T0, end: T0 + MAX_SPAN_MS + HALF },
    { email: "anne@example.org", start: "x", end: T0 },
  ]) {
    eq(await lookupAvailability({ client: c, ...bad }), []);
  }
  eq(c.sent.length, 0);
});

test("availability: a recipient without data, or an empty answer, gives no interval", async () => {
  eq(await lookupAvailability({ client: client("14.1", () => answer(response("anne@example.org", { availability: "163" }))), email: "anne@example.org", start: T0, end: T0 + HALF }), []);
  eq(await lookupAvailability({ client: client("14.1", () => null), email: "anne@example.org", start: T0, end: T0 + HALF }), []);
  // An answer about somebody else is not this person's.
  eq(await lookupAvailability({ client: client("14.1", () => answer(response("autre@example.org", { merged: "2" }))), email: "anne@example.org", start: T0, end: T0 + HALF }), []);
  assert(true);
});
