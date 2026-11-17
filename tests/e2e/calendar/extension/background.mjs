// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * sync443Calendar end-to-end scenario, run inside a headless Thunderbird by
 * tests/e2e/calendar/run_calendar_test.py, in two phases (two launches of
 * Thunderbird on the same throw-away profile):
 *   1. the provider registered at startup; calendars; items of every shape
 *      written from descriptions and read back through Thunderbird's own
 *      API; changes made through the calendar objects; hostile
 *      descriptions; scheduling; limits;
 *   2. after the restart: the provider and its calendars again, what was
 *      kept (items, zones, pending changes), then removal of everything.
 *
 * Every check is printed as "SYNC443CALENDAR-CHECK {label, ok, detail}";
 * "SYNC443CALENDAR-INFO {...}" carries facts for the runner,
 * "SYNC443CALENDAR-NOTE "..."" a remark for its report, and
 * "SYNC443CALENDAR-DONE {phase}" ends a phase. A step that could freeze
 * Thunderbird if a fix regressed is announced by "SYNC443CALENDAR-GUARD
 * {label, seconds}" and closed by "SYNC443CALENDAR-UNGUARD": the runner
 * stops Thunderbird when such a step does not return in time.
 */

const api = browser.sync443Calendar;
const T = browser.sync443CalendarTest;
const H = (name, args) => T.run(name, args);
const EXT_ID = browser.runtime.id;

const M1 = "a1b2c3d4e5f6";
const M2 = "0123456789ab";
const OWN = "alice@example.com";
const C1 = `sync443-${M1}-1`; // main calendar of M1: events and tasks
const C2 = `sync443-${M1}-2`; // a further calendar folder of M1 (ServerId "5")
const C3 = `sync443-${M2}-1`; // main calendar of M2: tasks only
const FORGED_STORAGE = `sync443-${M1}-7`; // Thunderbird's storage type, with our marks
const FORGED_OWNER = `sync443-${M1}-8`; // our type, marked for another extension
const FORGED_BARE = `sync443-${M1}-9`; // our type, without marks
const EVENTS = "1"; // collection of the events of C1
const TASKS = "2"; // collection of its tasks
const M3 = "ffeeddccbbaa"; // a mailbox for the calendars the last checks make
let Ci_CAL_IS_READONLY = null; // Thunderbird's result code for a write to what is read-only (from the helper's probe)
const SETTLE_MS = 2000; // the module holds an answer to an invitation back for that long (its SETTLE_MS)
const MAX_ITEMS = 50000; // the items one calendar holds (the module's MAX_ITEMS)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeJson = (value) =>
  JSON.stringify(value ?? null).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

let failures = 0;

async function emit(kind, value) {
  await T.print(`SYNC443CALENDAR-${kind} ${escapeJson(value)}`);
}

async function check(label, ok, detail) {
  if (!ok) failures++;
  await emit("CHECK", { label, ok: !!ok, detail: detail === undefined ? null : detail });
}

/** The rejection message of a call, or null if it resolved. */
async function errorOf(call) {
  try {
    await call();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

async function expectCode(label, call, code) {
  const message = await errorOf(call);
  await check(`${label} → ${code}`, typeof message === "string" && message.startsWith(`${code}: `), message);
}

const short = (value) => {
  const text = escapeJson(value);
  return text.length > 80 ? `${text.slice(0, 70)}… (${text.length})` : text;
};

/**
 * Where two values differ ("path: a ≠ b"), or null if they are the same.
 * With `partial`, `b` only says what must be found in `a` (objects may have
 * more keys; arrays are compared whole, element by element).
 */
function diff(a, b, partial = false, path = "") {
  if (a === b) return null;
  const both = (v) => v !== null && typeof v === "object";
  if (!both(a) || !both(b) || Array.isArray(a) !== Array.isArray(b)) return `${path || "value"}: ${short(a)} ≠ ${short(b)}`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], partial, `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = partial ? Object.keys(b) : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${path}.${key}: ${Object.hasOwn(a, key) ? "unexpected" : "missing"}`;
    const d = diff(a[key], b[key], partial, `${path}.${key}`);
    if (d) return d;
  }
  return null;
}

const same = (a, b) => diff(a, b) === null;
const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * A step that must return at once, and that would freeze Thunderbird if a
 * fix regressed: the runner is told before it starts, and stops Thunderbird
 * if it has not returned after `seconds`. → what the step resolves to, or
 * the string "no answer" if it only never answers.
 */
async function guarded(label, seconds, step) {
  await emit("GUARD", { label, seconds });
  try {
    return await Promise.race([step(), sleep(seconds * 1000).then(() => "no answer")]);
  } finally {
    await emit("UNGUARD", { label });
  }
}

// ── Descriptions ────────────────────────────────────────────────────────

const change = ([month, week, weekday, hour, minute]) => ({ month, week, weekday, hour, minute });
const zone = (bias, standard, daylightBias, daylight) => ({
  bias,
  standard: { bias: 0, change: standard ? change(standard) : null },
  daylight: { bias: daylightBias, change: daylight ? change(daylight) : null },
});
// Windows rules: standard time begins the last Sunday of October at 03:00, daylight time the last Sunday of March at 02:00…
const Z_PARIS = zone(-60, [10, 5, 0, 3, 0], -60, [3, 5, 0, 2, 0]);
const Z_NEW_YORK = zone(300, [11, 1, 0, 2, 0], -60, [3, 2, 0, 2, 0]);
const Z_SYDNEY = zone(-600, [4, 1, 0, 3, 0], -60, [10, 1, 0, 2, 0]);
const Z_INDIA = zone(-330, null, -60, null);
const Z_UTC = zone(0, null, 0, null);
const Z_ODD = zone(-345, [10, 5, 0, 3, 0], -60, [3, 5, 0, 2, 0]); // UTC+5:45 with European changes: no such zone exists

const NOT_A_MEETING = { role: "none", cancelled: false, responseRequested: false, response: "none", allowNewTime: true };
const rule = (more) => ({ freq: "daily", interval: 1, count: null, until: null, byDay: [], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null, ...more });

const event = (uid, more) => ({
  kind: "event",
  uid,
  summary: uid,
  location: "",
  description: "",
  allDay: false,
  start: "2027-03-10T09:00:00Z",
  end: "2027-03-10T10:00:00Z",
  timezone: null,
  busy: "busy",
  privacy: "public",
  reminder: null,
  categories: [],
  organizer: null,
  attendees: [],
  meeting: { ...NOT_A_MEETING },
  recurrence: null,
  exceptions: [],
  stamp: "2027-01-02T03:04:05Z",
  sequence: 0,
  readOnly: null,
  ...more,
});

const task = (uid, more) => ({
  kind: "task",
  uid,
  summary: uid,
  description: "",
  categories: [],
  privacy: "public",
  start: null,
  due: null,
  completed: false,
  completedAt: null,
  priority: "normal",
  reminderAt: null,
  recurrence: null,
  readOnly: null,
  ...more,
});

const put = (collectionId, serverId, item) => ({ op: "put", collectionId, serverId, item });
const remove = (collectionId, serverId) => ({ op: "remove", collectionId, serverId });
const detach = (collectionId, serverId) => ({ op: "detach", collectionId, serverId });
const person = (email, name, role = "required", status = "unknown") => ({ email, name, role, status });

/**
 * Every shape of the contract, in the form the module gives back (so that
 * the round trip can be compared as a whole): [ServerId, collection,
 * description, what Thunderbird's own API must show].
 */
const SHAPES = [
  [
    "e1",
    EVENTS,
    event("uid-e1", {
      summary: "Réunion d'équipe",
      location: "Salle A, 2e étage",
      description: "Ligne 1\nLigne 2\n\tretrait",
      start: "2027-03-10T09:00:00Z",
      end: "2027-03-10T10:30:00Z",
      timezone: Z_PARIS,
      busy: "tentative",
      privacy: "private",
      reminder: 15,
      categories: ["Travail", "a,b", "Été"],
    }),
    {
      kind: "event",
      calendarId: C1,
      title: "Réunion d'équipe",
      location: "Salle A, 2e étage",
      description: "Ligne 1\nLigne 2\n\tretrait",
      start: { date: false, tzid: "Europe/Paris", local: "2027-03-10T10:00:00", utc: "2027-03-10T09:00:00Z", offset: 3600 },
      end: { date: false, tzid: "Europe/Paris", local: "2027-03-10T11:30:00", utc: "2027-03-10T10:30:00Z" },
      transp: "OPAQUE",
      privacy: "PRIVATE",
      categories: ["Travail", "a,b", "Été"],
      alarms: [{ offset: -900, at: null, action: "DISPLAY" }],
      organizer: null,
      attendees: [],
      stamp: { utc: "2027-01-02T03:04:05Z" },
      rules: [],
    },
  ],
  [
    "e2",
    EVENTS,
    event("uid-e2", { allDay: true, start: "2027-03-10", end: "2027-03-12", timezone: Z_NEW_YORK, busy: "free", reminder: 0, privacy: "confidential" }),
    {
      start: { date: true, local: "2027-03-10", utc: null },
      end: { date: true, local: "2027-03-12" },
      transp: "TRANSPARENT",
      privacy: "CONFIDENTIAL",
      alarms: [{ offset: 0, action: "DISPLAY" }],
    },
  ],
  [
    "e3",
    EVENTS,
    event("uid-e3", { start: "2027-07-01T14:00:00Z", end: "2027-07-01T15:00:00Z", timezone: Z_NEW_YORK, busy: "away" }),
    {
      start: { tzid: "America/New_York", local: "2027-07-01T10:00:00", utc: "2027-07-01T14:00:00Z", offset: -14400 },
      end: { tzid: "America/New_York", local: "2027-07-01T11:00:00" },
      privacy: "PUBLIC",
    },
  ],
  [
    "e4",
    EVENTS,
    event("uid-e4", {
      start: "2027-01-15T00:00:00Z",
      end: "2027-01-15T01:00:00Z",
      timezone: Z_SYDNEY,
      recurrence: rule({ freq: "monthly", count: 8, byMonthDay: 15 }),
    }),
    { start: { tzid: "Australia/Sydney", local: "2027-01-15T11:00:00", utc: "2027-01-15T00:00:00Z", offset: 39600 } },
  ],
  [
    "e5",
    EVENTS,
    event("uid-e5", {
      summary: "Point hebdomadaire",
      start: "2027-03-23T08:00:00Z",
      end: "2027-03-23T08:45:00Z",
      timezone: Z_PARIS,
      reminder: 10,
      recurrence: rule({ freq: "weekly", count: 6, byDay: ["TU", "TH"] }),
      exceptions: [
        { originalStart: "2027-03-25T08:00:00Z", deleted: true, changes: {} },
        {
          originalStart: "2027-03-30T07:00:00Z",
          deleted: false,
          changes: { summary: "Déplacé", location: "Salle B", start: "2027-03-30T12:00:00Z", end: "2027-03-30T13:00:00Z", reminder: null },
        },
      ],
    }),
    {
      start: { tzid: "Europe/Paris", local: "2027-03-23T09:00:00" },
      removed: [{ utc: "2027-03-25T08:00:00Z", negative: true }],
      exceptions: [
        {
          title: "Déplacé",
          location: "Salle B",
          recurrenceId: { utc: "2027-03-30T07:00:00Z" },
          start: { local: "2027-03-30T14:00:00", utc: "2027-03-30T12:00:00Z" },
          end: { utc: "2027-03-30T13:00:00Z" },
          alarms: [],
        },
      ],
    },
  ],
  [
    "e6",
    EVENTS,
    event("uid-e6", {
      summary: "Comité",
      organizer: { email: OWN, name: "Alice A." },
      attendees: [
        person("bob@example.com", "O'Neil, Bob; (Sales): x", "required", "accepted"),
        person("carol@example.com", "Carol", "optional", "tentative"),
        person("room-12@example.com", "Salle 12", "resource", "unknown"),
        person("dave@example.com", "Dave \"le Grand\" D^x", "required", "declined"),
        person("erin@example.com", "Erin", "required", "not-responded"),
      ],
      meeting: { role: "organizer", cancelled: false, responseRequested: true, response: "none", allowNewTime: false },
      sequence: 3,
    }),
    {
      organizer: { id: `mailto:${OWN}`, cn: "Alice A." },
      attendees: [
        { id: "mailto:bob@example.com", cn: "O'Neil, Bob; (Sales): x", role: "REQ-PARTICIPANT", partstat: "ACCEPTED", type: "INDIVIDUAL", rsvp: "TRUE" },
        { id: "mailto:carol@example.com", cn: "Carol", role: "OPT-PARTICIPANT", partstat: "TENTATIVE" },
        { id: "mailto:room-12@example.com", role: "NON-PARTICIPANT", partstat: "NEEDS-ACTION", type: "RESOURCE" },
        { id: "mailto:dave@example.com", cn: "Dave \"le Grand\" D^x", partstat: "DECLINED" },
        { id: "mailto:erin@example.com", partstat: "NEEDS-ACTION" },
      ],
    },
  ],
  [
    "e7",
    EVENTS,
    event("uid-e7", {
      summary: "Invitation",
      organizer: { email: "bob@example.com", name: "Bob" },
      attendees: [person(OWN, "Alice", "required", "unknown"), person("carol@example.com", "Carol", "optional", "accepted")],
      meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "not-responded", allowNewTime: true },
    }),
    {
      organizer: { id: "mailto:bob@example.com", cn: "Bob" },
      attendees: [
        { id: `mailto:${OWN}`, partstat: "NEEDS-ACTION", rsvp: "TRUE" },
        { id: "mailto:carol@example.com", partstat: "ACCEPTED" },
      ],
    },
  ],
  [
    "e8",
    EVENTS,
    event("uid-e8", {
      summary: "Annulée, réponse provisoire",
      organizer: { email: "bob@example.com", name: "" },
      attendees: [person("carol@example.com", "Carol")],
      meeting: { role: "attendee", cancelled: true, responseRequested: false, response: "tentative", allowNewTime: false },
    }),
    {
      status: "CANCELLED",
      // The user's own entry is added: Thunderbird then shows the answer and offers to change it.
      attendees: [
        { id: "mailto:carol@example.com", partstat: "NEEDS-ACTION", rsvp: "FALSE" },
        { id: `mailto:${OWN}`, partstat: "TENTATIVE" },
      ],
    },
  ],
  [
    "e9",
    EVENTS,
    event("uid-e9", {
      start: "2027-01-12T10:00:00Z",
      end: "2027-01-12T11:00:00Z",
      timezone: Z_UTC,
      recurrence: rule({ freq: "monthly", until: "2027-12-31T23:59:59Z", byDay: ["TU"], bySetPos: 2 }),
    }),
    { start: { tzid: "UTC", local: "2027-01-12T10:00:00" } },
  ],
  [
    "e10",
    EVENTS,
    event("uid-e10", {
      start: "2027-01-29T04:30:00Z",
      end: "2027-01-29T05:30:00Z",
      timezone: Z_INDIA,
      recurrence: rule({ freq: "monthly", interval: 2, count: 4, byDay: ["MO", "TU", "WE", "TH", "FR"], bySetPos: -1 }),
    }),
    { start: { local: "2027-01-29T10:00:00", offset: 19800 } },
  ],
  [
    "e11",
    EVENTS,
    event("uid-e11", {
      allDay: true,
      start: "2027-05-17",
      end: "2027-05-18",
      timezone: Z_PARIS,
      recurrence: rule({ freq: "yearly", byMonthDay: 17, byMonth: 5 }),
      exceptions: [{ originalStart: "2028-05-17", deleted: true, changes: {} }],
    }),
    { start: { date: true, local: "2027-05-17" }, removed: [{ date: true, local: "2028-05-17", negative: true }] },
  ],
  [
    "e12",
    EVENTS,
    event("uid-e12", {
      start: "2027-01-10T04:15:00Z",
      end: "2027-01-10T05:15:00Z",
      timezone: Z_ODD,
      recurrence: rule({ freq: "monthly", count: 8, byMonthDay: 10 }),
    }),
    { start: { local: "2027-01-10T10:00:00", utc: "2027-01-10T04:15:00Z", offset: 20700 } },
  ],
  [
    "e13",
    EVENTS,
    event("uid-e13", {
      start: "2027-02-01T09:00:00Z",
      end: "2027-02-01T09:30:00Z",
      recurrence: rule({ interval: 3, until: "2027-03-01T09:00:00Z", weekStart: "SU" }),
    }),
    { start: { tzid: "Europe/Paris" } },
  ],
  [
    "e14",
    EVENTS,
    event("uid-e14", {
      start: "2027-06-07T08:00:00Z",
      end: "2027-06-07T09:00:00Z",
      recurrence: rule({ freq: "yearly", count: 3, byDay: ["MO"], bySetPos: 1, byMonth: 6 }),
    }),
    {},
  ],
  [
    "e15",
    EVENTS,
    event("uid-e15", { summary: "Sans durée", start: "2027-09-01T12:00:00Z", end: "2027-09-01T12:00:00Z", timezone: Z_PARIS, readOnly: null }),
    { start: { local: "2027-09-01T14:00:00", tzid: "Europe/Paris" }, end: { local: "2027-09-01T14:00:00", utc: "2027-09-01T12:00:00Z" } },
  ],
  [
    "e16",
    EVENTS,
    event("uid-e16", {
      summary: "Série à participants",
      start: "2027-11-02T09:00:00Z",
      end: "2027-11-02T10:00:00Z",
      timezone: Z_PARIS,
      organizer: { email: OWN, name: "" },
      attendees: [person("bob@example.com", "Bob", "required", "accepted"), person("carol@example.com", "Carol", "optional", "unknown")],
      meeting: { role: "organizer", cancelled: false, responseRequested: true, response: "none", allowNewTime: true },
      recurrence: rule({ count: 5 }),
      exceptions: [
        {
          originalStart: "2027-11-03T09:00:00Z",
          deleted: false,
          changes: { start: "2027-11-03T09:00:00Z", end: "2027-11-03T10:00:00Z", attendees: [person("bob@example.com", "Bob", "required", "declined")], cancelled: true },
        },
        {
          originalStart: "2027-11-04T09:00:00Z",
          deleted: false,
          changes: { description: "Toute la journée", allDay: true, start: "2027-11-04", end: "2027-11-05", busy: "free", privacy: "private", categories: ["Spécial"] },
        },
      ],
    }),
    {
      attendees: [{ id: "mailto:bob@example.com", partstat: "ACCEPTED" }, { id: "mailto:carol@example.com", role: "OPT-PARTICIPANT" }],
      exceptions: [
        { recurrenceId: { utc: "2027-11-03T09:00:00Z" }, status: "CANCELLED", attendees: [{ id: "mailto:bob@example.com", partstat: "DECLINED" }], start: { local: "2027-11-03T10:00:00" } },
        {
          recurrenceId: { utc: "2027-11-04T09:00:00Z" },
          start: { date: true, local: "2027-11-04" },
          end: { date: true, local: "2027-11-05" },
          transp: "TRANSPARENT",
          privacy: "PRIVATE",
          categories: ["Spécial"],
          description: "Toute la journée",
        },
      ],
    },
  ],
  [
    "t1",
    TASKS,
    task("uid-t1", {
      summary: "Déclarer les impôts",
      description: "Avant la date limite",
      categories: ["Maison"],
      privacy: "private",
      start: "2027-04-01",
      due: "2027-04-05",
      priority: "high",
      reminderAt: "2027-04-04T08:00:00Z",
    }),
    {
      kind: "task",
      calendarId: C1,
      title: "Déclarer les impôts",
      description: "Avant la date limite",
      start: { date: true, local: "2027-04-01" },
      due: { date: true, local: "2027-04-05" },
      priority: 1,
      privacy: "PRIVATE",
      completed: false,
      categories: ["Maison"],
      alarms: [{ offset: null, at: { utc: "2027-04-04T08:00:00Z" } }],
    },
  ],
  [
    "t2",
    TASKS,
    task("uid-t2", { completed: true, completedAt: "2027-04-02T10:30:00Z", priority: "low" }),
    { completed: true, completedAt: { utc: "2027-04-02T10:30:00Z" }, percent: 100, status: "COMPLETED", priority: 9, start: null, due: null },
  ],
  ["t3", TASKS, task("uid-t3", { start: "2027-05-03", due: "2027-05-04", recurrence: rule({ interval: 2, count: 5 }) }), { priority: 5 }],
];

const shape = (serverId) => SHAPES.find(([id]) => id === serverId);
const described = (serverId) => copy(shape(serverId)[2]);
const allPuts = () => SHAPES.map(([serverId, collectionId, item]) => put(collectionId, serverId, copy(item)));

// ── Local changes ───────────────────────────────────────────────────────

const localChanges = (calendarId = C1) => api.readLocalChanges(calendarId, { max: 200 });

/**
 * The same, once nothing is held back any more: the user's own answer to
 * someone else's meeting is not read during the two seconds that follow it.
 */
async function settledChanges(calendarId = C1) {
  await sleep(SETTLE_MS + 200);
  return localChanges(calendarId);
}

/** The description of a local change against what is expected, the date Thunderbird stamps aside. */
const unstamped = (d) => (d && d.kind === "event" ? { ...d, stamp: null } : d);
const itemDiff = (change, expected) => diff(unstamped(change?.item), unstamped(expected));

let announced = [];
api.onLocalChange.addListener((calendarId) => announced.push(calendarId));
async function announcedSince() {
  await sleep(60);
  const seen = announced;
  announced = [];
  return seen;
}

// ── Phase 1 ─────────────────────────────────────────────────────────────

async function startup() {
  // Before anything of sync443Calendar is called.
  const state = await H("calendars");
  await check("the provider type sync443 is registered when the extension starts", state.registered === true);
  await check("a fresh profile has no calendar of ours", !state.calendars.some((c) => c.type === "sync443"), state.calendars);
  await check("listCalendars() on a fresh profile → []", same(await api.listCalendars(), []));
}

async function argumentChecks() {
  const ok = { mailboxId: M1, slot: "main", name: "Alice", events: true, tasks: true, organizerEmail: OWN };
  const bad = [
    ["mailboxId in upper case", { ...ok, mailboxId: "A1B2C3D4E5F6" }],
    ["mailboxId too short", { ...ok, mailboxId: "a1b2" }],
    ["mailboxId with a dot", { ...ok, mailboxId: "a1b2c3d4e5.6" }],
    ["empty slot", { ...ok, slot: "" }],
    ["slot of 65 characters", { ...ok, slot: "s".repeat(65) }],
    ["slot with a line break", { ...ok, slot: "a\nb" }],
    ["empty name", { ...ok, name: "" }],
    ["blank name", { ...ok, name: "   " }],
    ["name of 257 characters", { ...ok, name: "n".repeat(257) }],
    ["name with a bidirectional override", { ...ok, name: `Ali${String.fromCharCode(0x202e)}ce` }],
    ["name with a control character", { ...ok, name: `Ali${String.fromCharCode(7)}ce` }],
    ["neither events nor tasks", { ...ok, events: false, tasks: false }],
    ["address without a domain", { ...ok, organizerEmail: "alice" }],
    ["address with a display name", { ...ok, organizerEmail: "Alice <alice@example.com>" }],
  ];
  for (const [label, options] of bad) await expectCode(`ensureCalendar: ${label}`, () => api.ensureCalendar(options), "CONFIG");
  await check("no calendar was created by the refused calls", same(await api.listCalendars(), []));
  for (const id of ["", "sync443", "sync443-a1b2c3d4e5f6-0", "sync443-a1b2c3d4e5f6-12345", "__proto__", `${C1}.x`, "../x"]) {
    await expectCode(`applyServerChanges on the calendar id ${short(id)}`, () => api.applyServerChanges(id, []), "CONFIG");
  }
  await expectCode("applyServerChanges on a calendar that does not exist", () => api.applyServerChanges(C1, []), "NOT_FOUND");
  await expectCode("readLocalChanges on a calendar that does not exist", () => api.readLocalChanges(C1, {}), "NOT_FOUND");
  await check("removeCalendar on a calendar that does not exist → false", (await api.removeCalendar(C1)) === false);
}

async function calendars() {
  const user = await H("createUserCalendar", { name: "Personnel" });
  await H("userAdd", { calendarId: user, spec: { id: "user-event", start: "20270601T100000", end: "20270601T110000", ops: [{ title: "À moi" }] } });
  await H("forge", { type: "storage", id: FORGED_STORAGE, owner: EXT_ID, mailbox: M1, slot: "main", name: "Stockage marqué" });
  await H("userAdd", { calendarId: FORGED_STORAGE, spec: { id: "forged-event", start: "20270601T100000", end: "20270601T110000" } });
  await H("forge", { type: "sync443", id: FORGED_OWNER, owner: "other@extension.test", mailbox: M1, slot: "main", name: "Autre extension" });
  await H("forge", { type: "sync443", id: FORGED_BARE, mailbox: M1, name: "Sans marque" });
  await check("calendars that look like ours are not listed (storage type with our marks, our type with foreign or no marks)",
    same(await api.listCalendars(), []), await api.listCalendars());

  const wanted = { mailboxId: M1, slot: "main", name: "Alice (travail)", events: true, tasks: false, organizerEmail: OWN };
  const made = await api.ensureCalendar(wanted);
  await check("ensureCalendar creates the calendar: id sync443-<mailboxId>-<n>, first free number", same(made, { calendarId: C1, created: true }), made);
  await check("ensureCalendar never adopts a calendar it did not mark (same mailbox, same slot, foreign marks)", made.calendarId !== FORGED_OWNER);
  await check("ensureCalendar again: same calendar, nothing created", same(await api.ensureCalendar(wanted), { calendarId: C1, created: false }));
  await check("listCalendars shows it, and only it",
    same(await api.listCalendars(), [{ calendarId: C1, mailboxId: M1, slot: "main", name: "Alice (travail)", events: true, tasks: false }]), await api.listCalendars());

  const names = [
    "cache.supported", "cache.enabled", "capabilities.removeModes", "requiresNetwork", "organizerId", "itip.transport",
    "capabilities.events.supported", "capabilities.tasks.supported", "imip.identity", "imip.identity.disabled", "refreshInterval",
    "capabilities.timezones.floating.supported", "capabilities.alarms.maxCount", "capabilities.attachments.supported", "disabled", "readOnly",
  ];
  let info = await H("calendarInfo", { calendarId: C1, properties: names });
  await check("the calendar is registered with the type sync443 and an address of ours", info.type === "sync443" && info.uri === `sync443://${M1}/1`, [info.type, info.uri]);
  await check("marks and values are stored as calendar properties (preferences calendar.registry.<id>.*)",
    diff(info.prefs, {
      [`calendar.registry.${C1}.sync443.owner`]: EXT_ID,
      [`calendar.registry.${C1}.sync443.mailbox`]: M1,
      [`calendar.registry.${C1}.sync443.slot`]: "main",
      [`calendar.registry.${C1}.sync443.events`]: true,
      [`calendar.registry.${C1}.sync443.tasks`]: false,
      [`calendar.registry.${C1}.sync443.email`]: OWN,
      [`calendar.registry.${C1}.type`]: "sync443",
      [`calendar.registry.${C1}.name`]: "Alice (travail)",
    }, true) === null, info.prefs);
  await check("fixed properties: no cache, no removal from the interface, no network, no refresh, organizerId = the mailbox's address",
    diff(info.values, {
      "cache.supported": false, "cache.enabled": false, "capabilities.removeModes": [], requiresNetwork: false, refreshInterval: 0,
      organizerId: `mailto:${OWN}`, "itip.transport": { type: "sync443", scheme: "mailto" }, "imip.identity": null, "imip.identity.disabled": true,
      "capabilities.events.supported": true, "capabilities.tasks.supported": false, "capabilities.timezones.floating.supported": false,
      "capabilities.alarms.maxCount": 1, "capabilities.attachments.supported": false,
    }, true) === null && !info.values.disabled && !info.values.readOnly, info.values);
  await check("providerID is null and the calendar cannot be refreshed", info.providerID === null && info.canRefresh === false, [info.providerID, info.canRefresh]);
  await check("supportsScheduling, and canNotify() is true for every method", info.supportsScheduling && info.canNotify.every((v) => v === true), info.canNotify);
  await check("Thunderbird takes it for a scheduling calendar (invitations can be accepted into it)", info.schedulingCalendar === true);

  // What Thunderbird (or anything else) may try to set on the calendar object.
  await H("setProperty", { calendarId: C1, name: "cache.enabled", value: true });
  await H("setProperty", { calendarId: C1, name: "sync443.owner", value: "other@extension.test" });
  await H("setProperty", { calendarId: C1, name: "sync443.mailbox", value: M2 });
  await H("setProperty", { calendarId: C1, name: "organizerId", value: "mailto:mallory@example.com" });
  info = await H("calendarInfo", { calendarId: C1, properties: ["cache.enabled", "organizerId"] });
  await check("the cache cannot be switched on, marks and organizerId cannot be changed through the calendar object",
    info.values["cache.enabled"] === false && info.values.organizerId === `mailto:${OWN}` && info.prefs[`calendar.registry.${C1}.sync443.owner`] === EXT_ID &&
      info.prefs[`calendar.registry.${C1}.sync443.mailbox`] === M1 && (await api.listCalendars()).length === 1, info);

  const updated = await api.ensureCalendar({ ...wanted, name: "Alice", tasks: true, organizerEmail: OWN });
  info = await H("calendarInfo", { calendarId: C1, properties: ["capabilities.tasks.supported"] });
  await check("ensureCalendar updates the name and the kinds of items",
    same(updated, { calendarId: C1, created: false }) && info.name === "Alice" && info.values["capabilities.tasks.supported"] === true, info);

  const folder = await api.ensureCalendar({ mailboxId: M1, slot: "5", name: "Équipe", events: true, tasks: false, organizerEmail: OWN });
  const other = await api.ensureCalendar({ mailboxId: M2, slot: "main", name: "Bob", events: false, tasks: true, organizerEmail: "bob@example.org" });
  await check("a further folder and another mailbox get calendars of their own", same(folder, { calendarId: C2, created: true }) && same(other, { calendarId: C3, created: true }), [folder, other]);
  await check("listCalendars: the three calendars, sorted, nothing else",
    same(await api.listCalendars(), [
      { calendarId: C3, mailboxId: M2, slot: "main", name: "Bob", events: false, tasks: true },
      { calendarId: C1, mailboxId: M1, slot: "main", name: "Alice", events: true, tasks: true },
      { calendarId: C2, mailboxId: M1, slot: "5", name: "Équipe", events: true, tasks: false },
    ]), await api.listCalendars());

  for (const id of [FORGED_STORAGE, FORGED_OWNER, FORGED_BARE]) {
    await expectCode(`applyServerChanges on ${id} (not ours)`, () => api.applyServerChanges(id, [put(EVENTS, "x", event("x"))]), "NOT_FOUND");
    await expectCode(`readLocalChanges on ${id} (not ours)`, () => api.readLocalChanges(id, {}), "NOT_FOUND");
    await check(`removeCalendar on ${id} (not ours) → false`, (await api.removeCalendar(id)) === false);
  }
  const all = (await H("calendars")).calendars.map((c) => c.id);
  await check("the user's calendar and the forged ones are still registered, with their items",
    [user, FORGED_STORAGE, FORGED_OWNER, FORGED_BARE].every((id) => all.includes(id)) && (await H("items", { calendarId: user })).length === 1 &&
      (await H("items", { calendarId: FORGED_STORAGE })).length === 1 && (await H("items", { calendarId: FORGED_OWNER })).length === 0, all);
  return user;
}

async function serverWrites() {
  await H("watch", { calendarId: C1 });
  const results = await api.applyServerChanges(C1, allPuts());
  await check("applyServerChanges: every shape of the contract is accepted",
    same(results, SHAPES.map(([serverId]) => ({ serverId, ok: true }))), results.filter((r) => !r.ok));
  let seen = await H("watched", { calendarId: C1 });
  await check("one batch and one onLoad for the whole call, one onAddItem per item",
    same(seen, { onStartBatch: 1, onEndBatch: 1, onLoad: 1, onAddItem: SHAPES.length, onModifyItem: 0, onDeleteItem: 0, onError: 0 }), seen);
  await check("writes from the server record no local change", same(await localChanges(), []) && same(await announcedSince(), []));

  for (const [serverId, , d, expected] of SHAPES) {
    const item = await H("item", { calendarId: C1, itemId: d.uid });
    await check(`${serverId} read back through Thunderbird's API, field by field`, !!item && diff(item, { id: d.uid, calendarId: C1, ...expected }, true) === null,
      item ? diff(item, { id: d.uid, calendarId: C1, ...expected }, true) : "no such item");
    await check(`${serverId}: no X-MOZ property, no local state`, !!item && Object.keys(item.x).every((name) => !name.startsWith("X-MOZ")) && item.lastAck === null, item?.x);
  }
  const listed = await H("items", { calendarId: C1 });
  await check("getItems lists exactly these items", same(listed.map((i) => i.id).sort(), SHAPES.map(([, , d]) => d.uid).sort()), listed.map((i) => i.id));
  const rules = async (serverId) => (await H("item", { calendarId: C1, itemId: shape(serverId)[2].uid })).rules.join();
  await check("the rules are Thunderbird's own: BYDAY=2TU with UNTIL, BYSETPOS=-1 over the weekdays, WKST=SU with INTERVAL=3",
    /BYDAY=2TU/.test(await rules("e9")) && /UNTIL=20271231T235959Z/.test(await rules("e9")) && /BYSETPOS=-1/.test(await rules("e10")) && /BYDAY=MO,TU,WE,TH,FR/.test(await rules("e10")) &&
      /WKST=SU/.test(await rules("e13")) && /INTERVAL=3/.test(await rules("e13")) && /COUNT=6/.test(await rules("e5")), [await rules("e9"), await rules("e10"), await rules("e13")]);

  // What Thunderbird computes from them.
  const starts = async (serverId, from, to) => (await H("occurrences", { calendarId: C1, itemId: shape(serverId)[2].uid, from, to })).map((o) => o.start.utc ?? o.start.local);
  await check("e5 (Paris): Thunderbird's occurrences keep 09:00 across the change of time, without the deleted one, with the moved one",
    same(await starts("e5", "2027-03-01T00:00:00Z", "2027-05-01T00:00:00Z"),
      ["2027-03-23T08:00:00Z", "2027-03-30T12:00:00Z", "2027-04-01T07:00:00Z", "2027-04-06T07:00:00Z", "2027-04-08T07:00:00Z"]),
    await starts("e5", "2027-03-01T00:00:00Z", "2027-05-01T00:00:00Z"));
  await check("e4 (Sydney, southern zone): 11:00 local all year, UTC+11 until April, UTC+10 after",
    same(await starts("e4", "2027-01-01T00:00:00Z", "2027-12-31T00:00:00Z"),
      ["2027-01-15T00:00:00Z", "2027-02-15T00:00:00Z", "2027-03-15T00:00:00Z", "2027-04-15T01:00:00Z", "2027-05-15T01:00:00Z", "2027-06-15T01:00:00Z",
        "2027-07-15T01:00:00Z", "2027-08-15T01:00:00Z"]),
    await starts("e4", "2027-01-01T00:00:00Z", "2027-12-31T00:00:00Z"));
  const india = await H("item", { calendarId: C1, itemId: "uid-e10" });
  await check("e10: UTC+5:30 without daylight time is a zone of Thunderbird's list", ["Asia/Kolkata", "Asia/Calcutta"].includes(india.start.tzid), india.start.tzid);
  const odd = await H("item", { calendarId: C1, itemId: "uid-e12" });
  const oddStarts = await starts("e12", "2027-01-01T00:00:00Z", "2027-12-31T00:00:00Z");
  await check("e12 (rules no zone of Thunderbird has): 10:00 local all year, UTC+5:45 in winter, UTC+6:45 in summer",
    same(oddStarts, ["2027-01-10T04:15:00Z", "2027-02-10T04:15:00Z", "2027-03-10T04:15:00Z", "2027-04-10T03:15:00Z", "2027-05-10T03:15:00Z", "2027-06-10T03:15:00Z",
      "2027-07-10T03:15:00Z", "2027-08-10T03:15:00Z"]), oddStarts);
  await check("e12 is in a zone of ours, made from the rules (not UTC)", odd.start.tzid.startsWith("Sync443/"), odd.start.tzid);
  await emit("NOTE", `rules matching no zone of Thunderbird's list give the zone "${odd.start.tzid}"`);
  await check("e9: \"the second Tuesday\" of each month, as Thunderbird computes it",
    same((await starts("e9", "2027-01-01T00:00:00Z", "2027-05-01T00:00:00Z")).map((s) => s.slice(0, 10)), ["2027-01-12", "2027-02-09", "2027-03-09", "2027-04-13"]));
  await check("e10: \"the last weekday\" every second month, four times",
    same((await starts("e10", "2027-01-01T00:00:00Z", "2028-12-31T00:00:00Z")).map((s) => s.slice(0, 10)), ["2027-01-29", "2027-03-31", "2027-05-31", "2027-07-30"]),
    await starts("e10", "2027-01-01T00:00:00Z", "2028-12-31T00:00:00Z"));
  await check("e14: \"the first Monday of June\" three years in a row",
    same((await starts("e14", "2027-01-01T00:00:00Z", "2031-12-31T00:00:00Z")).map((s) => s.slice(0, 10)), ["2027-06-07", "2028-06-05", "2029-06-04"]),
    await starts("e14", "2027-01-01T00:00:00Z", "2031-12-31T00:00:00Z"));
  await check("e11: a yearly whole day, without the year removed",
    same(await starts("e11", "2027-01-01T00:00:00Z", "2030-01-01T00:00:00Z"), ["2027-05-17", "2029-05-17"]), await starts("e11", "2027-01-01T00:00:00Z", "2030-01-01T00:00:00Z"));

  await check("serverIds: the items held, by collection",
    same((await api.serverIds(C1, EVENTS)).sort(), SHAPES.filter(([, c]) => c === EVENTS).map(([id]) => id).sort()) &&
      same((await api.serverIds(C1, TASKS)).sort(), ["t1", "t2", "t3"]) && same(await api.serverIds(C1, "none"), []) && same(await api.serverIds(C2, EVENTS), []));

  // The same descriptions again: nothing is written, nothing is announced.
  const again = await api.applyServerChanges(C1, allPuts());
  seen = await H("watched", { calendarId: C1 });
  await check("the same descriptions again: accepted, and not one notification",
    again.every((r) => r.ok) && Object.values(seen).every((n) => n === 0), seen);

  // Local state survives a change from the server.
  await H("userEdit", { calendarId: C1, itemId: "uid-e1", ops: [{ lastAck: "2027-03-10T08:50:00Z" }, { prop: "X-MOZ-SNOOZE-TIME", value: "20270310T085500Z" }] });
  await H("watched", { calendarId: C1 });
  const moved = { ...described("e1"), summary: "Réunion d'équipe (déplacée)", start: "2027-03-11T09:00:00Z", end: "2027-03-11T10:30:00Z" };
  const changed = await api.applyServerChanges(C1, [put(EVENTS, "e1", moved)]);
  seen = await H("watched", { calendarId: C1 });
  let e1 = await H("item", { calendarId: C1, itemId: "uid-e1" });
  await check("a change from the server modifies the item in place (one onModifyItem), and keeps the reminder already answered",
    changed[0].ok && seen.onModifyItem === 1 && seen.onAddItem === 0 && e1.title === "Réunion d'équipe (déplacée)" && e1.start.utc === "2027-03-11T09:00:00Z" &&
      e1.lastAck?.utc === "2027-03-10T08:50:00Z" && e1.x["X-MOZ-SNOOZE-TIME"] === "20270310T085500Z", [seen, e1.title, e1.lastAck, e1.x]);
  await check("… and still no local change", same(await localChanges(), []) && same(await announcedSince(), []));
  await api.applyServerChanges(C1, [put(EVENTS, "e1", described("e1"))]);

  // Removal, and removal of what is not there.
  const extra = await api.applyServerChanges(C1, [put(EVENTS, "gone", event("uid-gone")), remove(EVENTS, "gone"), remove(EVENTS, "never-there")]);
  await check("remove takes the item away; removing what is not held is not an error",
    extra.every((r) => r.ok) && (await H("item", { calendarId: C1, itemId: "uid-gone" })) === null && !(await api.serverIds(C1, EVENTS)).includes("gone"), extra);

  // The calendar read-only for the user: the server still writes.
  await H("setProperty", { calendarId: C1, name: "readOnly", value: true });
  const refusedAdd = await errorOf(() => H("userAdd", { calendarId: C1, spec: { start: "20270701T100000", end: "20270701T110000" } }));
  const refusedEdit = await errorOf(() => H("userEdit", { calendarId: C1, itemId: "uid-e3", ops: [{ title: "non" }] }));
  const written = await api.applyServerChanges(C1, [put(EVENTS, "ro", event("uid-ro"))]);
  await check("a calendar switched to read-only refuses the user's changes, not the server's",
    refusedAdd !== null && refusedEdit !== null && written[0].ok && (await H("item", { calendarId: C1, itemId: "uid-ro" })) !== null && same(await localChanges(), []),
    [refusedAdd, refusedEdit, written]);
  await H("setProperty", { calendarId: C1, name: "readOnly", value: false });
  await api.applyServerChanges(C1, [remove(EVENTS, "ro")]);

  // A kind the calendar does not hold.
  const kinds = await api.applyServerChanges(C3, [put(EVENTS, "k1", event("uid-k1")), put(TASKS, "k2", task("uid-k2"))]);
  await check("a calendar of tasks refuses an event (KIND) and takes the task of the same call",
    same(kinds, [{ serverId: "k1", ok: false, code: "KIND" }, { serverId: "k2", ok: true }]) && (await H("items", { calendarId: C3 })).length === 1, kinds);
}

async function roundTrip() {
  // A change by the user on every item, so that the module says what it holds: `previous` is the
  // description an item built from a description gives back; `item` the same with the change.
  for (const [, , d] of SHAPES) await H("userEdit", { calendarId: C1, itemId: d.uid, ops: [{ title: `${d.summary} *` }] });
  await check("onLocalChange announces the calendar", (await announcedSince()).includes(C1));
  let changes = await settledChanges(); // two of the shapes are invitations
  await check("one change per item changed", changes.length === SHAPES.length, changes.length);
  for (const [serverId, collectionId, d] of SHAPES) {
    const c = changes.find((x) => x.serverId === serverId);
    await check(`${serverId}: round trip description → item → description gives the same description`,
      !!c && c.op === "modify" && c.kind === d.kind && c.collectionId === collectionId && c.problem === null && c.detached === false && diff(c.previous, d) === null,
      c ? (diff(c.previous, d) ?? [c.op, c.kind, c.collectionId, c.problem]) : "no change read");
    await check(`${serverId}: the change by the user, and nothing else, differs`, !!c && itemDiff(c, { ...d, summary: `${d.summary} *` }) === null,
      c ? itemDiff(c, { ...d, summary: `${d.summary} *` }) : null);
  }
  // Undone one by one: the synchronized version comes back.
  const dropped = [];
  for (const c of changes) dropped.push(await api.dropLocalChange(C1, c.changeId));
  await check("dropLocalChange restores every item", dropped.every((v) => v === true) && same(await localChanges(), []), dropped);
  for (const [serverId, , d, expected] of SHAPES) {
    const item = await H("item", { calendarId: C1, itemId: d.uid });
    await check(`${serverId}: as the server described it again`, !!item && item.title === d.summary && diff(item, expected, true) === null, item ? diff(item, expected, true) : null);
  }
  // A second trip from the restored items: still the same descriptions.
  for (const [, , d] of SHAPES) await H("userEdit", { calendarId: C1, itemId: d.uid, ops: [{ title: `${d.summary} **` }] });
  changes = await settledChanges();
  await check("a second round trip gives the same descriptions again",
    changes.length === SHAPES.length && SHAPES.every(([serverId, , d]) => diff(changes.find((x) => x.serverId === serverId)?.previous, d) === null));
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  await announcedSince();

  // Descriptions that are not in that form come back in it, and stay so.
  const loose = event("uid-loose", {
    // The same offsets and changes as Paris, written another way.
    timezone: { bias: 0, standard: { bias: -60, change: change([10, 5, 0, 3, 0]) }, daylight: { bias: -120, change: change([3, 5, 0, 2, 0]) } },
    attendees: [person("bob@example.com", "Bob"), person("BOB@example.com", "Bob again")], // not a meeting, an address twice
    organizer: { email: "bob@example.com", name: "Bob" },
    recurrence: rule({ freq: "weekly", count: 4, byDay: ["WE", "MO"], weekStart: "MO" }),
    start: "2027-03-08T09:00:00Z",
    end: "2027-03-08T10:00:00Z",
    exceptions: [
      { originalStart: "2027-03-17T09:00:00Z", deleted: false, changes: { summary: "Autre titre", busy: "free" } },
      { originalStart: "2027-03-10T09:00:00Z", deleted: true, changes: { summary: "ignored" } },
    ],
  });
  await api.applyServerChanges(C1, [put(EVENTS, "loose", loose)]);
  await check("a zone written another way is still Thunderbird's default zone", (await H("item", { calendarId: C1, itemId: "uid-loose" })).start.tzid === "Europe/Paris");
  await H("userEdit", { calendarId: C1, itemId: "uid-loose", ops: [{ location: "Ici" }] });
  const [c] = await localChanges();
  const expected = {
    ...loose,
    organizer: null, // an appointment that is not a meeting has neither organizer nor attendees
    attendees: [],
    exceptions: [
      { originalStart: "2027-03-10T09:00:00Z", deleted: true, changes: {} },
      { originalStart: "2027-03-17T09:00:00Z", deleted: false, changes: { summary: "Autre titre", start: "2027-03-17T09:00:00Z", end: "2027-03-17T10:00:00Z", busy: "free" } },
    ],
  };
  await check("a description in another form: its zone, its order of days and its first day of the week are kept; exceptions come sorted, each with its dates",
    diff(c?.previous, expected) === null && itemDiff(c, { ...expected, location: "Ici" }) === null, diff(c?.previous, expected) ?? itemDiff(c, { ...expected, location: "Ici" }));
  await api.dropLocalChange(C1, c.changeId);
  // A whole day without a zone, and a time without a zone.
  await api.applyServerChanges(C1, [put(EVENTS, "day", event("uid-day", { allDay: true, start: "2027-07-14", end: "2027-07-15" })), put(EVENTS, "bare", event("uid-bare"))]);
  await H("userEdit", { calendarId: C1, itemId: "uid-day", ops: [{ location: "Paris" }] });
  await H("userEdit", { calendarId: C1, itemId: "uid-bare", ops: [{ location: "Paris" }] });
  const [day, bare] = await localChanges();
  await check("a whole day always says a zone on its way out: the user's (Thunderbird's default zone) when it came with none",
    same(day?.previous?.timezone, Z_PARIS) && same(day?.item?.timezone, Z_PARIS) && day?.item?.start === "2027-07-14" && day?.item?.end === "2027-07-15", [day?.previous?.timezone, day?.item]);
  await check("a time that came without a zone is shown in the default zone and goes back without one",
    bare?.previous?.timezone === null && bare?.item?.timezone === null && (await H("item", { calendarId: C1, itemId: "uid-bare" })).start.tzid === "Europe/Paris", bare?.item?.timezone);
  await api.dropLocalChange(C1, day.changeId);
  await api.dropLocalChange(C1, bare.changeId);
  // An instant in the hour the clock lives twice: Thunderbird's local time cannot say which one; the instant is kept.
  const twice = event("uid-twice", { start: "2027-10-31T00:30:00Z", end: "2027-10-31T01:30:00Z", timezone: Z_PARIS });
  const edge = event("uid-edge", { start: "2027-03-28T01:00:00Z", end: "2027-03-28T02:00:00Z", timezone: Z_PARIS });
  await api.applyServerChanges(C1, [put(EVENTS, "twice", twice), put(EVENTS, "edge", edge)]);
  const [first, second] = [await H("item", { calendarId: C1, itemId: "uid-twice" }), await H("item", { calendarId: C1, itemId: "uid-edge" })];
  await check("instants around the changes of time are exact, whatever the zone can say (02:30 before the clock goes back; 03:00 as it goes forward)",
    first.start.utc === "2027-10-31T00:30:00Z" && first.end.utc === "2027-10-31T01:30:00Z" && second.start.utc === "2027-03-28T01:00:00Z" && second.start.local === "2027-03-28T03:00:00" &&
      second.start.tzid === "Europe/Paris", [first.start, first.end, second.start]);
  await api.applyServerChanges(C1, [remove(EVENTS, "loose"), remove(EVENTS, "day"), remove(EVENTS, "bare"), remove(EVENTS, "twice"), remove(EVENTS, "edge")]);
}

async function userChanges() {
  await announcedSince();
  // ── Added, changed before it is read: one creation.
  const id = await H("userAdd", {
    calendarId: C1,
    spec: { start: "20270920T140000", end: "20270920T150000", tzid: "America/New_York", ops: [{ title: "Créé ici" }, { alarm: 30 }, { categories: ["Perso"] }, { transp: "TRANSPARENT" }] },
  });
  await check("an event added through the calendar object is announced", same(await announcedSince(), [C1]));
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ location: "Bureau" }] });
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ description: "Notes" }] });
  let changes = await localChanges();
  const local = event(id, {
    summary: "Créé ici", location: "Bureau", description: "Notes", start: "2027-09-20T18:00:00Z", end: "2027-09-20T19:00:00Z", timezone: Z_NEW_YORK,
    busy: "free", reminder: 30, categories: ["Perso"],
  });
  await check("added then modified twice: one change, an \"add\", with the item as it is now",
    changes.length === 1 && changes[0].op === "add" && changes[0].kind === "event" && changes[0].serverId === null && changes[0].collectionId === null &&
      changes[0].previous === null && changes[0].problem === null && changes[0].detached === false && /^[a-f0-9]{32}\.[0-9]+$/.test(changes[0].changeId) &&
      itemDiff(changes[0], local) === null, changes.length === 1 ? (itemDiff(changes[0], local) ?? changes[0]) : changes.length);
  await check("the zone of an item of Thunderbird is described by its offsets and its two changes of the year", same(changes[0]?.item?.timezone, Z_NEW_YORK), changes[0]?.item?.timezone);
  await check("reading twice gives the same change", same(await localChanges(), changes));
  await expectCode("ackLocalChange of a creation without ServerId", () => api.ackLocalChange(C1, changes[0].changeId, {}), "CONFIG");
  await expectCode("ackLocalChange of a creation in the main calendar without collection", () => api.ackLocalChange(C1, changes[0].changeId, { serverId: "n1" }), "CONFIG");
  await expectCode("ackLocalChange with a description that is not valid", () => api.ackLocalChange(C1, changes[0].changeId, { serverId: "n1", collectionId: EVENTS, item: { kind: "event" } }), "CONFIG");
  await check("ackLocalChange binds the item to its ServerId",
    (await api.ackLocalChange(C1, changes[0].changeId, { serverId: "n1", collectionId: EVENTS, item: changes[0].item })) === true && same(await localChanges(), []) &&
      (await api.serverIds(C1, EVENTS)).includes("n1"));
  await check("an acknowledged change cannot be acknowledged or dropped again",
    (await api.ackLocalChange(C1, changes[0].changeId, { serverId: "n1", collectionId: EVENTS })) === false && (await api.dropLocalChange(C1, changes[0].changeId)) === false &&
      (await H("item", { calendarId: C1, itemId: id })) !== null);
  await check("a change id that was never given is unknown", (await api.dropLocalChange(C1, `${"0".repeat(32)}.1`)) === false);
  await expectCode("a malformed change id", () => api.dropLocalChange(C1, "1.1"), "CONFIG");

  // ── Modified: previous is what was acknowledged.
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Renommé" }] });
  changes = await localChanges();
  await check("modified after the acknowledgement: a \"modify\" with the acknowledged description as previous",
    changes.length === 1 && changes[0].op === "modify" && changes[0].serverId === "n1" && changes[0].collectionId === EVENTS &&
      itemDiff({ item: changes[0].previous }, local) === null && itemDiff(changes[0], { ...local, summary: "Renommé" }) === null, changes);
  // Changed again while the first change is on its way.
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Renommé deux fois" }] });
  await check("acknowledging a change the user has overtaken → false; what was sent becomes the synchronized version, the rest stays to send",
    (await api.ackLocalChange(C1, changes[0].changeId, { item: changes[0].item })) === false);
  let next = await localChanges();
  await check("… the next reading gives the newer change against the acknowledged one",
    next.length === 1 && next[0].op === "modify" && next[0].changeId !== changes[0].changeId && next[0].previous?.summary === "Renommé" && next[0].item?.summary === "Renommé deux fois", next);
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Renommé trois fois" }] });
  await check("dropping a change the user has overtaken → false, nothing undone",
    (await api.dropLocalChange(C1, next[0].changeId)) === false && (await H("item", { calendarId: C1, itemId: id })).title === "Renommé trois fois");
  next = await localChanges();
  await check("dropLocalChange restores the last synchronized version",
    (await api.dropLocalChange(C1, next[0].changeId)) === true && (await H("item", { calendarId: C1, itemId: id })).title === "Renommé" && same(await localChanges(), []));

  // ── Changed, then changed back: nothing.
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Hésitation" }] });
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Renommé" }] });
  await check("modified then put back as it was: nothing to send", same(await localChanges(), []));

  // ── Local-only properties.
  await announcedSince();
  await H("userEdit", { calendarId: C1, itemId: id, ops: [
    { lastAck: "2027-09-20T17:30:00Z" }, { prop: "X-MOZ-SNOOZE-TIME", value: "20270920T174500Z" }, { prop: "X-MOZ-GENERATION", value: "4" },
    { prop: "X-MOZ-RECEIVED-SEQUENCE", value: "2" }, { prop: "X-MOZ-RECEIVED-DTSTAMP", value: "20270901T000000Z" },
    { prop: "X-MOZ-INVITED-ATTENDEE", value: "mailto:alias@example.com" }, { prop: "X-MOZ-SEND-INVITATIONS", value: "TRUE" },
    { prop: "X-MOZ-SEND-INVITATIONS-UNDISCLOSED", value: "FALSE" },
  ] });
  let stored = await H("item", { calendarId: C1, itemId: id });
  await check("a reminder answered or snoozed and Thunderbird's own marks are stored, and make no change to send",
    stored.lastAck?.utc === "2027-09-20T17:30:00Z" && stored.x["X-MOZ-SNOOZE-TIME"] === "20270920T174500Z" && stored.x["X-MOZ-GENERATION"] === "4" &&
      stored.x["X-MOZ-INVITED-ATTENDEE"] === "mailto:alias@example.com" && same(await localChanges(), []) && same(await announcedSince(), []), [stored.x, await localChanges()]);
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Avec marques" }] });
  changes = await localChanges();
  await check("X-MOZ-* never appears in a description", changes.length === 1 && !JSON.stringify(changes[0]).includes("X-MOZ") && !JSON.stringify(changes[0]).includes("alias@"), changes);
  await api.ackLocalChange(C1, changes[0].changeId, { item: changes[0].item });

  // ── Deleted: the deletion waits, then is dropped, then acknowledged.
  await H("watched", { calendarId: C1 });
  await H("userDelete", { calendarId: C1, itemId: id });
  changes = await localChanges();
  let seen = await H("watched", { calendarId: C1 });
  await check("a deleted item leaves the calendar at once, and its deletion is read with its ServerId and its last description",
    (await H("item", { calendarId: C1, itemId: id })) === null && !(await H("items", { calendarId: C1 })).some((i) => i.id === id) && seen.onDeleteItem === 1 &&
      changes.length === 1 && changes[0].op === "delete" && changes[0].serverId === "n1" && changes[0].item === null && changes[0].previous?.summary === "Avec marques" &&
      (await api.serverIds(C1, EVENTS)).includes("n1"), changes);
  await check("dropLocalChange brings a deleted item back, as last synchronized",
    (await api.dropLocalChange(C1, changes[0].changeId)) === true && (await H("item", { calendarId: C1, itemId: id }))?.title === "Avec marques" && same(await localChanges(), []) &&
      (await H("watched", { calendarId: C1 })).onAddItem === 1);
  await H("userDelete", { calendarId: C1, itemId: id });
  changes = await localChanges();
  await check("ackLocalChange of a deletion: nothing is left of the item",
    (await api.ackLocalChange(C1, changes[0].changeId, {})) === true && same(await localChanges(), []) && !(await api.serverIds(C1, EVENTS)).includes("n1") &&
      (await H("item", { calendarId: C1, itemId: id })) === null);

  // ── Added then deleted before anything is read: nothing.
  const brief = await H("userAdd", { calendarId: C1, spec: { start: "20270921T100000", end: "20270921T110000" } });
  await H("userDelete", { calendarId: C1, itemId: brief });
  await check("added then deleted before it is read: nothing to send, nothing kept", same(await localChanges(), []) && (await H("item", { calendarId: C1, itemId: brief })) === null);

  // ── Added, read (on its way to the server), deleted, then acknowledged: the deletion follows.
  const hasty = await H("userAdd", { calendarId: C1, spec: { start: "20270922T100000", end: "20270922T110000", ops: [{ title: "Pressé" }] } });
  changes = await localChanges();
  await H("userDelete", { calendarId: C1, itemId: hasty });
  await check("deleted while its creation is on its way: nothing to read until the server answers", same(await localChanges(), []));
  await check("the creation acknowledged afterwards → false, and the deletion is then read with the new ServerId",
    (await api.ackLocalChange(C1, changes[0].changeId, { serverId: "n2", collectionId: EVENTS, item: changes[0].item })) === false);
  next = await localChanges();
  await check("… a \"delete\" for that ServerId", next.length === 1 && next[0].op === "delete" && next[0].serverId === "n2", next);
  await check("… acknowledged in turn", (await api.ackLocalChange(C1, next[0].changeId)) === true && same(await localChanges(), []) && !(await api.serverIds(C1, EVENTS)).includes("n2"));
  // The same, the creation being refused.
  const refused = await H("userAdd", { calendarId: C1, spec: { start: "20270923T100000", end: "20270923T110000" } });
  changes = await localChanges();
  await H("userDelete", { calendarId: C1, itemId: refused });
  await check("deleted while its creation is on its way, creation dropped: nothing is left",
    (await api.dropLocalChange(C1, changes[0].changeId)) === true && same(await localChanges(), []));
  // A creation refused by the server: the item is the user's, and stays, as a copy that is no longer synchronized.
  const unlucky = await H("userAdd", { calendarId: C1, spec: { start: "20270924T100000", end: "20270924T110000", ops: [{ title: "Refusé par le serveur" }] } });
  changes = await localChanges();
  await check("dropLocalChange of a creation never deletes the item: it stays in the calendar, with nothing to send",
    (await api.dropLocalChange(C1, changes[0].changeId)) === true && (await H("item", { calendarId: C1, itemId: unlucky }))?.title === "Refusé par le serveur" &&
      same(await localChanges(), []) && (await api.dropLocalChange(C1, changes[0].changeId)) === false, await H("item", { calendarId: C1, itemId: unlucky }));
  await H("userEdit", { calendarId: C1, itemId: unlucky, ops: [{ location: "Encore là" }] });
  next = await localChanges();
  await check("… as a detached copy: changed again, it is read as an \"add\" marked detached, under a new change id",
    next.length === 1 && next[0].op === "add" && next[0].detached === true && next[0].serverId === null && next[0].item?.location === "Encore là" && next[0].changeId !== changes[0].changeId, next);
  await api.dropLocalChange(C1, next[0].changeId);
  await H("userDelete", { calendarId: C1, itemId: unlucky });
  await check("… and the user deleting it leaves nothing", (await H("item", { calendarId: C1, itemId: unlucky })) === null && same(await localChanges(), []));

  // ── A deleted item put back (undo in Thunderbird): a modification again.
  await H("userDelete", { calendarId: C1, itemId: "uid-e3" });
  changes = await localChanges();
  await H("userAdd", { calendarId: C1, spec: { id: "uid-e3", start: "20270701T100000", end: "20270701T110000", tzid: "America/New_York", ops: [{ title: "uid-e3" }] } });
  next = await localChanges();
  await check("deleted then added again under the same id (undo): no deletion left, a modification at most",
    changes[0]?.op === "delete" && next.every((c) => c.op === "modify" && c.serverId === "e3") && (await H("item", { calendarId: C1, itemId: "uid-e3" })) !== null, next);
  await check("the deletion read before, acknowledged late: the item was deleted on the server, it is a creation again",
    (await api.ackLocalChange(C1, changes[0].changeId)) === false && same((await localChanges()).map((c) => [c.op, c.serverId, c.previous]), [["add", null, null]]) &&
      !(await api.serverIds(C1, EVENTS)).includes("e3"), await localChanges());
  changes = await localChanges();
  await api.ackLocalChange(C1, changes[0].changeId, { serverId: "e3", collectionId: EVENTS, item: changes[0].item });
  await api.applyServerChanges(C1, [put(EVENTS, "e3", described("e3"))]);

  // ── One occurrence deleted, another changed, as the interface does.
  await H("userDeleteOccurrence", { calendarId: C1, itemId: "uid-e5", rid: "2027-04-06T07:00:00Z" });
  changes = await localChanges();
  const e5 = described("e5");
  const withDeleted = { ...e5, exceptions: [...e5.exceptions, { originalStart: "2027-04-06T07:00:00Z", deleted: true, changes: {} }] };
  await check("an occurrence deleted: a \"modify\" of the series with one more deleted exception",
    changes.length === 1 && changes[0].op === "modify" && changes[0].serverId === "e5" && itemDiff(changes[0], withDeleted) === null && diff(changes[0].previous, e5) === null,
    changes.length === 1 ? itemDiff(changes[0], withDeleted) : changes.length);
  await H("userEditOccurrence", { calendarId: C1, itemId: "uid-e5", rid: "2027-04-08T07:00:00Z", ops: [{ title: "Dernier point" }, { shift: 90 }, { alarm: 5 }] });
  changes = await localChanges();
  const withChanged = { ...withDeleted, exceptions: [...withDeleted.exceptions,
    { originalStart: "2027-04-08T07:00:00Z", deleted: false, changes: { summary: "Dernier point", start: "2027-04-08T08:30:00Z", end: "2027-04-08T09:15:00Z", reminder: 5 } }] };
  await check("an occurrence changed: still one \"modify\", with a changed exception holding what differs and its dates",
    changes.length === 1 && itemDiff(changes[0], withChanged) === null && diff(changes[0].previous, e5) === null, changes.length === 1 ? itemDiff(changes[0], withChanged) : changes.length);
  await check("… and Thunderbird shows the series accordingly",
    same((await H("occurrences", { calendarId: C1, itemId: "uid-e5", from: "2027-04-01T00:00:00Z", to: "2027-05-01T00:00:00Z" })).map((o) => [o.title, o.start.utc]),
      [["Point hebdomadaire", "2027-04-01T07:00:00Z"], ["Dernier point", "2027-04-08T08:30:00Z"]]));
  await api.ackLocalChange(C1, changes[0].changeId, { item: changes[0].item });
  await H("userEdit", { calendarId: C1, itemId: "uid-e5", ops: [{ location: "Partout" }] });
  changes = await localChanges();
  await check("the acknowledged series is the new previous", diff(changes[0]?.previous, { ...withChanged, stamp: changes[0]?.previous?.stamp }) === null && changes[0]?.item?.location === "Partout",
    diff(changes[0]?.previous, { ...withChanged, stamp: changes[0]?.previous?.stamp }));
  await api.dropLocalChange(C1, changes[0].changeId);

  // ── The user's own participation status.
  await H("userEdit", { calendarId: C1, itemId: "uid-e7", ops: [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }] });
  changes = await settledChanges();
  const e7 = described("e7");
  await check("accepting an invitation: a \"modify\" whose only difference is meeting.response",
    changes.length === 1 && changes[0].serverId === "e7" && diff(changes[0].previous, e7) === null && itemDiff(changes[0], { ...e7, meeting: { ...e7.meeting, response: "accepted" } }) === null,
    changes.length === 1 ? itemDiff(changes[0], { ...e7, meeting: { ...e7.meeting, response: "accepted" } }) : changes.length);
  await api.ackLocalChange(C1, changes[0].changeId, { item: changes[0].item });
  await H("userEdit", { calendarId: C1, itemId: "uid-e7", ops: [{ partstat: { id: `mailto:${OWN}`, value: "DECLINED" } }] });
  changes = await settledChanges();
  await check("then declining it: previous says accepted, the item says declined",
    changes[0]?.previous?.meeting.response === "accepted" && changes[0]?.item?.meeting.response === "declined", changes[0]?.item?.meeting);
  await api.dropLocalChange(C1, changes[0].changeId);
  await H("userEdit", { calendarId: C1, itemId: "uid-e8", ops: [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }] });
  changes = await settledChanges();
  await check("the user's own entry, added for Thunderbird, never appears among the attendees of a description",
    changes[0]?.item?.meeting.response === "accepted" && same(changes[0]?.item?.attendees, described("e8").attendees), changes[0]?.item?.attendees);
  await api.dropLocalChange(C1, changes[0].changeId);
  // An attendee added by the organizer.
  await H("userEdit", { calendarId: C1, itemId: "uid-e6", ops: [{ addAttendee: { id: "mailto:frank@example.com", cn: "Frank" } }] });
  changes = await localChanges();
  await check("an attendee added to a meeting the user organizes",
    same(changes[0]?.item?.attendees, [...described("e6").attendees, person("frank@example.com", "Frank", "required", "not-responded")]) && changes[0]?.item?.meeting.role === "organizer",
    changes[0]?.item?.attendees);
  await api.dropLocalChange(C1, changes[0].changeId);

  // ── Tasks.
  const todo = await H("userAdd", { calendarId: C1, spec: { kind: "task", start: "20270610", due: "20270612T170000", ops: [{ title: "Tâche locale" }, { priority: 9 }] } });
  changes = await localChanges();
  await check("a task added: an \"add\" of kind task, its dates as days",
    changes.length === 1 && changes[0].kind === "task" && changes[0].op === "add" &&
      diff(changes[0].item, task(todo, { summary: "Tâche locale", start: "2027-06-10", due: "2027-06-12", priority: "low" })) === null, changes[0]);
  // The engine names a task by a UID of its own, made from the ServerId.
  await api.ackLocalChange(C1, changes[0].changeId, { serverId: "t9", collectionId: TASKS, item: { ...changes[0].item, uid: "task-t9" } });
  await H("userEdit", { calendarId: C1, itemId: todo, ops: [{ title: "Tâche locale, suite" }] });
  changes = await localChanges();
  await check("the UID acknowledged for an item is the one said from then on, whatever id Thunderbird gave it",
    changes.length === 1 && changes[0].op === "modify" && changes[0].serverId === "t9" && changes[0].item?.uid === "task-t9" && changes[0].previous?.uid === "task-t9" &&
      (await H("item", { calendarId: C1, itemId: todo })) !== null, changes);
  await api.dropLocalChange(C1, changes[0].changeId);
  const before = (await H("items", { calendarId: C1 })).length;
  await api.applyServerChanges(C1, [put(TASKS, "t9", task("task-t9", { summary: "Tâche vue du serveur", start: "2027-06-10", due: "2027-06-12", priority: "low" }))]);
  await check("… and the server's description under that UID updates the same item: it is found by its ServerId",
    (await H("items", { calendarId: C1 })).length === before && (await H("item", { calendarId: C1, itemId: todo }))?.title === "Tâche vue du serveur" && same(await localChanges(), []));
  await H("userEdit", { calendarId: C1, itemId: "uid-t1", ops: [{ complete: true }] });
  changes = await localChanges();
  await check("a task completed in Thunderbird: completed, with the time it was done",
    changes.length === 1 && changes[0].serverId === "t1" && changes[0].item?.completed === true && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(changes[0].item?.completedAt ?? "") &&
      diff({ ...changes[0].item, completed: false, completedAt: null }, described("t1")) === null, changes[0]?.item);
  await api.dropLocalChange(C1, changes[0].changeId);
  await check("… dropped: not completed any more", (await H("item", { calendarId: C1, itemId: "uid-t1" })).completed === false);
  await api.applyServerChanges(C1, [remove(TASKS, "t9")]);

  // ── A calendar for one folder: its collection is known.
  await announcedSince();
  const inFolder = await H("userAdd", { calendarId: C2, spec: { start: "20270925T100000", end: "20270925T110000" } });
  changes = await localChanges(C2);
  await check("an item added in a folder's calendar: its collection is the folder, and that calendar is the one announced",
    changes.length === 1 && changes[0].collectionId === "5" && same(await announcedSince(), [C2]), changes);
  await check("… bound without naming the collection, refused with another one",
    (await errorOf(() => api.ackLocalChange(C2, changes[0].changeId, { serverId: "f1", collectionId: "6" })))?.startsWith("CONFIG: ") &&
      (await api.ackLocalChange(C2, changes[0].changeId, { serverId: "f1" })) === true && same(await api.serverIds(C2, "5"), ["f1"]) && (await H("item", { calendarId: C2, itemId: inFolder })) !== null);
  await H("userEdit", { calendarId: C1, itemId: "uid-e13", ops: [{ title: "un" }] });
  await H("userEdit", { calendarId: C1, itemId: "uid-e14", ops: [{ title: "deux" }] });
  const one = await api.readLocalChanges(C1, { max: 1 });
  changes = await api.readLocalChanges(C1);
  await check("readLocalChanges honours max (oldest first), defaults to everything, and refuses a bad max",
    one.length === 1 && one[0].serverId === "e13" && same(changes.map((c) => c.serverId), ["e13", "e14"]) &&
      (await errorOf(() => api.readLocalChanges(C1, { max: 201 })))?.startsWith("CONFIG: ") && (await errorOf(() => api.readLocalChanges(C1, { max: 0 })))?.startsWith("CONFIG: "), changes);
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  // The series and the invitation as the server described them, for what follows.
  await api.applyServerChanges(C1, [put(EVENTS, "e5", described("e5")), put(EVENTS, "e7", described("e7"))]);
  await check("(as the server described them again, nothing to send)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length,
    (await H("items", { calendarId: C1 })).length);
}

async function whatCannotBeDescribed() {
  const cases = [
    ["two rules", { rrule: ["FREQ=WEEKLY;COUNT=3", "FREQ=MONTHLY;COUNT=2"] }],
    ["an hourly rule", { rrule: "FREQ=HOURLY;COUNT=3" }],
    ["a rule by hour", { rrule: "FREQ=DAILY;COUNT=3;BYHOUR=9,15" }],
    ["a rule by week number", { rrule: "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO" }],
    ["a rule by day of the year", { rrule: "FREQ=YEARLY;BYYEARDAY=100" }],
    ["a count above 999", { rrule: "FREQ=DAILY;COUNT=1000" }],
    ["an interval above 999", { rrule: "FREQ=DAILY;INTERVAL=1000;COUNT=2" }],
    ["several days of the month", { rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15" }],
    ["a day counted from the end of the month", { rrule: "FREQ=MONTHLY;BYMONTHDAY=-1" }],
    ["the fifth Monday", { rrule: "FREQ=MONTHLY;BYDAY=5MO" }],
    ["two numbered days", { rrule: "FREQ=MONTHLY;BYDAY=1MO,3MO" }],
  ];
  const ids = [];
  for (const [, op] of cases) ids.push(await H("userAdd", { calendarId: C1, spec: { start: "20271004T100000", end: "20271004T110000", ops: [op] } }));
  const extra = await H("userAdd", { calendarId: C1, spec: { start: "20271004T100000", end: "20271004T110000", ops: [{ rrule: "FREQ=DAILY;COUNT=3" }, { rdate: "2027-10-20T08:00:00Z" }] } });
  const big = await H("userAdd", { calendarId: C1, spec: { start: "20271004T100000", end: "20271004T110000", ops: [{ description: "x".repeat(40000) }] } });
  const far = await H("userAdd", { calendarId: C1, spec: { start: "23010101T100000", end: "23010101T110000" } });
  const crowded = await H("userAdd", { calendarId: C1, spec: { start: "20271004T100000", end: "20271004T110000", organizer: { id: `mailto:${OWN}` },
    attendees: Array.from({ length: 501 }, (_, i) => ({ id: `mailto:guest${i}@example.com` })) } });
  const labelled = await H("userAdd", { calendarId: C1, spec: { start: "20271004T100000", end: "20271004T110000", ops: [{ categories: Array.from({ length: 51 }, (_, i) => `c${i}`) }] } });
  const fine = await H("userAdd", { calendarId: C1, spec: { start: "20271004T100000", end: "20271004T110000", ops: [{ rrule: "FREQ=WEEKLY;COUNT=999;BYDAY=MO,WE" }] } });
  const changes = await localChanges();
  const fineChange = changes[cases.length + 5];
  for (let i = 0; i < cases.length; i++) {
    await check(`a recurrence made in Thunderbird that the contract cannot hold (${cases[i][0]}) → problem "recurrence", no item`,
      changes[i]?.op === "add" && changes[i]?.problem === "recurrence" && changes[i]?.item === null, changes[i]);
  }
  await check("a series with an added date (RDATE) → problem \"recurrence\"", changes[cases.length]?.problem === "recurrence" && changes[cases.length]?.item === null, changes[cases.length]);
  await check("a description of 40,000 characters → problem \"too-large\"", changes[cases.length + 1]?.problem === "too-large" && changes[cases.length + 1]?.item === null);
  await check("a date outside the years of the contract → problem \"too-large\"", changes[cases.length + 2]?.problem === "too-large" && changes[cases.length + 2]?.item === null);
  await check("501 attendees, or 51 categories → problem \"too-large\"",
    changes[cases.length + 3]?.problem === "too-large" && changes[cases.length + 3]?.item === null && changes[cases.length + 4]?.problem === "too-large", [crowded, labelled]);
  await check("a rule at the bounds of the contract (count 999) is described",
    changes.length === cases.length + 6 && fineChange?.problem === null && fineChange?.item?.uid === fine && fineChange?.item?.recurrence?.count === 999, [ids.length, extra, big, far, fineChange]);
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  const made = [...ids, extra, big, far, crowded, labelled, fine];
  await check("dropLocalChange of what could not be described deletes none of it: the items stay, with nothing to send",
    same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length + made.length, (await H("items", { calendarId: C1 })).length);
  for (const id of made) await H("userDelete", { calendarId: C1, itemId: id });
  await check("(deleted by the user: nothing is left of them, nothing to send)",
    same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);

  // A task whose occurrence was completed alone: a description of a task has no exception.
  await H("userEditOccurrence", { calendarId: C1, itemId: "uid-t3", rid: "2027-05-05T00:00:00Z", ops: [{ title: "Une seule fois" }] });
  let [c] = await localChanges();
  await check("a task with one occurrence changed → problem \"recurrence\"; dropped, the series is whole again",
    c?.problem === "recurrence" && c?.serverId === "t3" && (await api.dropLocalChange(C1, c.changeId)) === true && (await H("item", { calendarId: C1, itemId: "uid-t3" })).exceptions.length === 0, c);

  // Read-only items: Thunderbird itself is told, before anything is changed.
  const readOnly = [["ro1", EVENTS, event("uid-ro1", { readOnly: "calendar-type" })], ["ro2", TASKS, task("uid-ro2", { readOnly: "regenerating" })],
    ["ro3", EVENTS, event("uid-ro3", { readOnly: "incomplete" })], ["ro4", TASKS, task("uid-ro4", { readOnly: "incomplete" })],
    ["ro5", EVENTS, event("uid-ro5", { readOnly: "unsupported-recurrence" })],
    ["ro6", EVENTS, event("uid-ro6", { readOnly: "incomplete", organizer: { email: "bob@example.com", name: "Bob" }, attendees: [person(OWN, "Alice")],
      meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "not-responded", allowNewTime: true } })],
    ["ro7", EVENTS, event("uid-ro7", { readOnly: "incomplete", timezone: copy(Z_UTC), recurrence: rule({ count: 4 }) })]];
  await api.applyServerChanges(C1, [...readOnly.map(([serverId, collection, d]) => put(collection, serverId, d)), put(EVENTS, "rw1", event("uid-rw1")), put(TASKS, "rw2", task("uid-rw2"))]);
  const asked = {};
  for (const [, , d] of readOnly) asked[d.uid] = await H("access", { calendarId: C1, itemId: d.uid, hold: true });
  const occurrenceAccess = await H("access", { calendarId: C1, itemId: "uid-ro7", rid: "2027-03-11T09:00:00Z" });
  await check("Thunderbird is told that an item whose description is read-only (any of the reasons, event or task, one occurrence of a series) cannot be modified nor answered: its dialog opens as a summary",
    Object.values(asked).every((a) => a && a.modify === false && a.respond === false && a.dialog === "summary") && occurrenceAccess.modify === false && occurrenceAccess.dialog === "summary",
    [asked, occurrenceAccess]);
  const free = [await H("access", { calendarId: C1, itemId: "uid-rw1", hold: true }), await H("access", { calendarId: C1, itemId: "uid-rw2" }), await H("access", { calendarId: C1, itemId: "uid-e5", rid: "2027-04-06T07:00:00Z" })];
  const invitationAccess = await H("access", { calendarId: C1, itemId: "uid-e7" });
  await check("… while the items beside them can be: the editing dialog for an event, a task, an occurrence; an invitation can be answered as before",
    free.every((a) => a.modify === true && a.respond === true && a.dialog === "edit") && invitationAccess.modify === true && invitationAccess.respond === true &&
      invitationAccess.invitation === true && invitationAccess.dialog === "summary", [free, invitationAccess]);
  await check("… and the calendar itself is as before: writable, items can be added and deleted, no access entry of its own (who the user is, is not changed)",
    same(free[0].calendar, { writable: true, add: true, remove: true, entry: "none" }) && same(asked["uid-ro1"].calendar, free[0].calendar), free[0].calendar);
  // What Thunderbird does not ask about (a deletion, a move in the month view, a task ticked off, the invitation bar) is refused by the calendar.
  await H("watch", { calendarId: C1 });
  await announcedSince();
  const attempts = [
    ["the event dialog saving a title", () => H("uiEdit", { calendarId: C1, itemId: "uid-ro1", ops: [{ title: "modifié quand même" }] })],
    ["a drag to another time", () => H("uiEdit", { calendarId: C1, itemId: "uid-ro5", ops: [{ shift: 30 }] })],
    ["a deletion from a view", () => H("uiDelete", { calendarId: C1, itemId: "uid-ro3" })],
    ["a task deleted", () => H("uiDelete", { calendarId: C1, itemId: "uid-ro2" })],
    ["a task ticked off", () => H("uiEdit", { calendarId: C1, itemId: "uid-ro4", ops: [{ complete: true }] })],
    ["an answer from the views", () => H("uiEdit", { calendarId: C1, itemId: "uid-ro6", ops: [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }], mode: "AUTO" })],
    ["one occurrence deleted", () => H("uiDeleteOccurrence", { calendarId: C1, itemId: "uid-ro7", rid: "2027-03-11T09:00:00Z" })],
    ["one occurrence changed", () => H("uiEditOccurrence", { calendarId: C1, itemId: "uid-ro7", rid: "2027-03-12T09:00:00Z", ops: [{ title: "une seule" }] })],
    ["a change made without Thunderbird's transactions", () => H("userEdit", { calendarId: C1, itemId: "uid-ro3", ops: [{ location: "ailleurs" }] })],
    ["a deletion made without Thunderbird's transactions", () => H("userDelete", { calendarId: C1, itemId: "uid-ro1" })],
  ];
  const snapshot = async () => JSON.stringify(await Promise.all(readOnly.map(([, , d]) => H("item", { calendarId: C1, itemId: d.uid }))));
  const untouched = await snapshot();
  for (const [label, attempt] of attempts) {
    const refusal = await errorOf(attempt);
    await check(`a read-only item cannot be changed through Thunderbird: ${label} is refused (the calendar says read-only), nothing is changed and nothing is to send`,
      typeof refusal === "string" && refusal.includes(`[${Ci_CAL_IS_READONLY}]`) && (await snapshot()) === untouched && same(await localChanges(), []), refusal);
  }
  const quiet = await H("watched", { calendarId: C1 });
  await check("… not one notification of a change, not one announcement", Object.values(quiet).every((n) => n === 0) && same(await announcedSince(), []), quiet);
  // What only Thunderbird keeps of an item is still stored: a reminder answered.
  await H("userEdit", { calendarId: C1, itemId: "uid-ro3", ops: [{ lastAck: "2027-03-10T08:50:00Z" }] });
  await check("a reminder answered on a read-only item is still stored (it changes nothing to send)",
    (await H("item", { calendarId: C1, itemId: "uid-ro3" })).lastAck?.utc === "2027-03-10T08:50:00Z" && same(await localChanges(), []));
  // The same paths on the items beside them.
  await H("uiEdit", { calendarId: C1, itemId: "uid-rw1", ops: [{ title: "modifié" }] });
  await H("uiDelete", { calendarId: C1, itemId: "uid-rw2" });
  let beside = await localChanges();
  await check("the same paths on an ordinary item beside them go through: a modification and a deletion to send",
    same(beside.map((b) => [b.op, b.serverId, b.problem]), [["modify", "rw1", null], ["delete", "rw2", null]]) && (await H("item", { calendarId: C1, itemId: "uid-rw1" })).title === "modifié", beside.map((b) => [b.op, b.serverId]));
  for (const b of beside) await api.dropLocalChange(C1, b.changeId);
  // The server's next version can be read again: the item is an ordinary one, also for whoever kept a copy of it.
  await api.applyServerChanges(C1, [put(EVENTS, "ro1", event("uid-ro1", { summary: "Lisible à nouveau" })), put(EVENTS, "rw1", event("uid-rw1", { readOnly: "incomplete" }))]);
  const again = await H("access", { calendarId: C1, itemId: "uid-ro1" });
  const turned = await H("access", { calendarId: C1, itemId: "uid-rw1" });
  await check("an item that becomes writable again (a later readable put) is editable again, and one that becomes read-only is not any more: also for a copy taken before",
    again.modify === true && again.dialog === "edit" && again.held?.modify === true && turned.modify === false && turned.dialog === "summary" && turned.held?.modify === false, [again, turned]);
  await H("uiEdit", { calendarId: C1, itemId: "uid-ro1", ops: [{ location: "Salle 3" }] });
  const turnedRefusal = await errorOf(() => H("uiEdit", { calendarId: C1, itemId: "uid-rw1", ops: [{ location: "Salle 3" }] }));
  beside = await localChanges();
  await check("… through Thunderbird's editing path: the first is changed, the second refused",
    same(beside.map((b) => [b.op, b.serverId, b.problem, b.item?.location]), [["modify", "ro1", null, "Salle 3"]]) && typeof turnedRefusal === "string", [beside.map((b) => [b.op, b.serverId]), turnedRefusal]);
  for (const b of beside) await api.dropLocalChange(C1, b.changeId);
  // The backstop: a change made while the item could be changed, read after it became read-only.
  await api.applyServerChanges(C1, [put(EVENTS, "late", event("uid-late")), put(TASKS, "late2", task("uid-late2"))]);
  await H("uiEdit", { calendarId: C1, itemId: "uid-late", ops: [{ title: "modifié juste avant" }] });
  await H("uiDelete", { calendarId: C1, itemId: "uid-late2" });
  await api.applyServerChanges(C1, [put(EVENTS, "late", event("uid-late", { readOnly: "calendar-type" })), put(TASKS, "late2", task("uid-late2", { readOnly: "regenerating" }))]);
  const refused = await localChanges();
  await check("a change that waited while its item became read-only is still reported with the problem \"read-only\", modification or deletion",
    same(refused.map((r) => [r.op, r.serverId, r.problem, r.item, r.previous?.readOnly, r.rewritten]), [["modify", "late", "read-only", null, "calendar-type", true], ["delete", "late2", "read-only", null, "regenerating", true]]), refused);
  for (const r of refused) await api.dropLocalChange(C1, r.changeId);
  await check("… dropped: the event is as the server has it, the deleted task is back",
    (await H("item", { calendarId: C1, itemId: "uid-late" })).title === "uid-late" && (await H("item", { calendarId: C1, itemId: "uid-late2" })) !== null && same(await localChanges(), []));
  await api.applyServerChanges(C1, [...readOnly.map(([serverId, collection]) => remove(collection, serverId)), remove(EVENTS, "rw1"), remove(TASKS, "rw2"), remove(EVENTS, "late"), remove(TASKS, "late2")]);
  // Text typed in Thunderbird is cleaned on its way out.
  const dirty = await H("userAdd", { calendarId: C1, spec: { start: "20271005T100000", end: "20271005T110000",
    ops: [{ title: `Titre${String.fromCharCode(0x202e)} sur\ndeux lignes${String.fromCharCode(7)}` }, { description: `a\r\nb${String.fromCharCode(0x2028)}c` }] } });
  [c] = await localChanges();
  await check("control and bidirectional characters typed in Thunderbird never reach a description", c?.item?.summary === "Titre sur deux lignes" && c?.item?.description === "a\nb\nc", c?.item);
  await api.dropLocalChange(C1, c.changeId);
  await H("userDelete", { calendarId: C1, itemId: dirty });
  await check("(the item is gone)", (await H("item", { calendarId: C1, itemId: dirty })) === null);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

async function detached() {
  await api.applyServerChanges(C1, [put(EVENTS, "d1", event("uid-d1")), put(EVENTS, "d2", event("uid-d2")), put(EVENTS, "d3", event("uid-d3")), put(EVENTS, "d4", event("uid-d4"))]);
  await H("userEdit", { calendarId: C1, itemId: "uid-d3", ops: [{ title: "changé avant" }] });
  await H("userDelete", { calendarId: C1, itemId: "uid-d4" });
  await H("watched", { calendarId: C1 });
  await announcedSince();
  const results = await api.applyServerChanges(C1, [detach(EVENTS, "d1"), detach(EVENTS, "d2"), detach(EVENTS, "d3"), detach(EVENTS, "d4"), detach(EVENTS, "never-there")]);
  const seen = await H("watched", { calendarId: C1 });
  await check("detach: accepted for each, also for what is not held",
    same(results, ["d1", "d2", "d3", "d4", "never-there"].map((serverId) => ({ serverId, ok: true }))), results);
  await check("a detached item stays in the calendar, loses its ServerId, and no change is reported (one made before is forgotten)",
    (await H("item", { calendarId: C1, itemId: "uid-d1" }))?.title === "uid-d1" && (await H("item", { calendarId: C1, itemId: "uid-d3" }))?.title === "changé avant" &&
      (await H("item", { calendarId: C1, itemId: "uid-d4" })) === null && !(await api.serverIds(C1, EVENTS)).some((id) => /^d[1-4]$/.test(id)) && same(await localChanges(), []) &&
      same(await announcedSince(), []) && Object.values(seen).every((n) => n === 0), [await localChanges(), seen]);
  await H("userEdit", { calendarId: C1, itemId: "uid-d1", ops: [{ lastAck: "2027-03-10T08:50:00Z" }] });
  await check("a reminder answered on a detached item reports nothing", same(await localChanges(), []));
  await H("userEdit", { calendarId: C1, itemId: "uid-d1", ops: [{ title: "copie modifiée" }] });
  let changes = await localChanges();
  await check("a detached item the user changes later: an \"add\" without ServerId, marked detached",
    changes.length === 1 && changes[0].op === "add" && changes[0].serverId === null && changes[0].previous === null && changes[0].detached === true &&
      changes[0].item?.summary === "copie modifiée" && changes[0].item?.uid === "uid-d1", changes);
  await check("dropping that change keeps the copy the user chose to keep, as it is, with nothing to send",
    (await api.dropLocalChange(C1, changes[0].changeId)) === true && (await H("item", { calendarId: C1, itemId: "uid-d1" }))?.title === "copie modifiée" && same(await localChanges(), []));
  await H("userEdit", { calendarId: C1, itemId: "uid-d1", ops: [{ title: "copie renvoyée" }] });
  changes = await localChanges();
  await check("changed again: reported again as a detached \"add\"; acknowledged with a ServerId, it is an ordinary item again",
    changes[0]?.detached === true && (await api.ackLocalChange(C1, changes[0].changeId, { serverId: "d1bis", collectionId: EVENTS, item: changes[0].item })) === true &&
      (await api.serverIds(C1, EVENTS)).includes("d1bis"));
  await H("userEdit", { calendarId: C1, itemId: "uid-d1", ops: [{ title: "encore" }] });
  changes = await localChanges();
  await check("… whose next change is a \"modify\", not detached", changes.length === 1 && changes[0].op === "modify" && changes[0].detached === false && changes[0].serverId === "d1bis", changes);
  await api.dropLocalChange(C1, changes[0].changeId);
  await H("userDelete", { calendarId: C1, itemId: "uid-d2" });
  await check("a detached item the user deletes is just removed: nothing to report",
    (await H("item", { calendarId: C1, itemId: "uid-d2" })) === null && same(await localChanges(), []));
  // The server gives the same event again: it is another item (the UID selects nothing).
  await api.applyServerChanges(C1, [put(EVENTS, "d3new", event("uid-d3"))]);
  const copies = (await H("items", { calendarId: C1 })).filter((i) => i.title === "changé avant" || i.title === "uid-d3");
  await check("the server giving a detached item's UID again makes a second item, the copy is untouched", copies.length === 2, copies.map((i) => [i.id, i.title]));
  await api.applyServerChanges(C1, [remove(EVENTS, "d3new"), remove(EVENTS, "d1bis")]);
  await H("userDelete", { calendarId: C1, itemId: "uid-d3" });
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

async function hostile() {
  const base = () => event("uid-h", { timezone: copy(Z_PARIS), recurrence: rule({ freq: "weekly", count: 3, byDay: ["MO"] }), start: "2027-03-08T09:00:00Z", end: "2027-03-08T10:00:00Z",
    organizer: { email: "bob@example.com", name: "Bob" }, attendees: [person("carol@example.com", "Carol")], meeting: { ...NOT_A_MEETING, role: "attendee" } });
  const withKey = (object, key, value) => JSON.parse(`${JSON.stringify(object).slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify(value)}}`);
  const bidi = String.fromCharCode(0x202e);
  const cases = [
    ["a key missing", (d) => delete d.busy],
    ["an unknown key", (d) => (d.extra = 1)],
    ["uid empty", (d) => (d.uid = "")],
    ["uid of 301 characters", (d) => (d.uid = "u".repeat(301))],
    ["uid on two lines", (d) => (d.uid = "a\nb")],
    ["uid with a bidirectional override", (d) => (d.uid = `a${bidi}b`)],
    ["uid that is a number", (d) => (d.uid = 12)],
    ["summary of 1025 characters", (d) => (d.summary = "s".repeat(1025))],
    ["summary with a NUL", (d) => (d.summary = `a${String.fromCharCode(0)}b`)],
    ["summary with a lone surrogate", (d) => (d.summary = `a${String.fromCharCode(0xd800)}b`)],
    ["location with a tab", (d) => (d.location = "a\tb")],
    ["description of 32769 characters", (d) => (d.description = "d".repeat(32769))],
    ["description with a carriage return", (d) => (d.description = "a\rb")],
    ["allDay that is not a boolean", (d) => (d.allDay = "false")],
    ["a whole day with times", (d) => (d.allDay = true)],
    ["a timed event with days", (d) => Object.assign(d, { start: "2027-03-08", end: "2027-03-09" })],
    ["a whole day that ends the day it starts", (d) => Object.assign(d, { allDay: true, start: "2027-03-08", end: "2027-03-08" })],
    ["end before start", (d) => (d.end = "2027-03-08T08:59:59Z")],
    ["the 30th of February", (d) => (d.start = "2027-02-30T09:00:00Z")],
    ["month 13", (d) => (d.start = "2027-13-01T09:00:00Z")],
    ["hour 24", (d) => (d.start = "2027-03-08T24:00:00Z")],
    ["year 1899", (d) => (d.start = "1899-03-08T09:00:00Z")],
    ["year 2201", (d) => (d.end = "2201-03-08T09:00:00Z")],
    ["a date with an offset", (d) => (d.start = "2027-03-08T09:00:00+01:00")],
    ["a date with spaces", (d) => (d.start = " 2027-03-08T09:00:00Z")],
    ["a date that is an object", (d) => (d.start = { toString: "2027-03-08T09:00:00Z" })],
    ["zone bias 841", (d) => (d.timezone.bias = 841)],
    ["zone bias that is a string", (d) => (d.timezone.bias = "-60")],
    ["zone with one change only", (d) => (d.timezone.daylight.change = null)],
    ["zone change in month 13", (d) => (d.timezone.standard.change.month = 13)],
    ["zone change in week 6", (d) => (d.timezone.standard.change.week = 6)],
    ["zone change at minute 60", (d) => (d.timezone.standard.change.minute = 60)],
    ["zone with an unknown key (a name)", (d) => (d.timezone.name = "Europe/Paris")],
    ["zone whose offsets exceed 14 hours", (d) => Object.assign(d.timezone, { bias: 840 }, { standard: { bias: 840, change: d.timezone.standard.change } })],
    ["busy unknown", (d) => (d.busy = "weird")],
    ["busy \"__proto__\"", (d) => (d.busy = "__proto__")],
    ["privacy \"constructor\"", (d) => (d.privacy = "constructor")],
    ["privacy \"hasOwnProperty\"", (d) => (d.privacy = "hasOwnProperty")],
    ["reminder -1", (d) => (d.reminder = -1)],
    ["reminder 40321", (d) => (d.reminder = 40321)],
    ["reminder 1.5", (d) => (d.reminder = 1.5)],
    ["reminder \"15\"", (d) => (d.reminder = "15")],
    ["51 categories", (d) => (d.categories = Array.from({ length: 51 }, (_, i) => `c${i}`))],
    ["an empty category", (d) => (d.categories = [""])],
    ["a category of 256 characters", (d) => (d.categories = ["c".repeat(256)])],
    ["categories that are not a list", (d) => (d.categories = { length: 0 })],
    ["organizer with an invalid address", (d) => (d.organizer.email = "bob@@example.com")],
    ["organizer with a name on two lines", (d) => (d.organizer.name = "Bob\nBcc: x@example.com")],
    ["organizer with an unknown key", (d) => (d.organizer.role = "chair")],
    ["501 attendees", (d) => (d.attendees = Array.from({ length: 501 }, (_, i) => person(`p${i}@example.com`, "")))],
    ["an attendee with an unknown role", (d) => (d.attendees[0].role = "chair")],
    ["an attendee with an unknown status", (d) => (d.attendees[0].status = "valueOf")],
    ["an attendee address of 255 characters", (d) => (d.attendees[0].email = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(7)}`)],
    ["an attendee address with a display name", (d) => (d.attendees[0].email = "Carol <carol@example.com>")],
    ["meeting without a key", (d) => delete d.meeting.allowNewTime],
    ["meeting with an unknown role", (d) => (d.meeting.role = "owner")],
    ["meeting with an unknown response", (d) => (d.meeting.response = "maybe")],
    ["recurrence freq \"hourly\"", (d) => (d.recurrence.freq = "hourly")],
    ["recurrence freq \"toString\"", (d) => (d.recurrence.freq = "toString")],
    ["interval 0", (d) => (d.recurrence.interval = 0)],
    ["interval 1000", (d) => (d.recurrence.interval = 1000)],
    ["count 0", (d) => (d.recurrence.count = 0)],
    ["count 1000", (d) => (d.recurrence.count = 1000)],
    ["count and until together", (d) => (d.recurrence.until = "2027-06-01T00:00:00Z")],
    ["until that is not a date", (d) => Object.assign(d.recurrence, { count: null, until: "20270601T000000Z" })],
    ["eight days", (d) => (d.recurrence.byDay = ["SU", "MO", "TU", "WE", "TH", "FR", "SA", "SU"])],
    ["a day twice", (d) => (d.recurrence.byDay = ["MO", "MO"])],
    ["a numbered day (\"2TU\")", (d) => (d.recurrence.byDay = ["2TU"])],
    ["bySetPos 0", (d) => (d.recurrence.bySetPos = 0)],
    ["bySetPos 5", (d) => (d.recurrence.bySetPos = 5)],
    ["bySetPos -2", (d) => (d.recurrence.bySetPos = -2)],
    ["byMonthDay 32", (d) => (d.recurrence.byMonthDay = 32)],
    ["byMonth 0", (d) => (d.recurrence.byMonth = 0)],
    ["weekStart \"XX\"", (d) => (d.recurrence.weekStart = "XX")],
    ["a rule by hour", (d) => (d.recurrence.byHour = [9])],
    ["10,000 exceptions", (d) => (d.exceptions = Array.from({ length: 10000 }, (_, i) => ({ originalStart: `2027-03-08T09:${String(i % 60).padStart(2, "0")}:00Z`, deleted: true, changes: {} })))],
    ["257 exceptions", (d) => (d.exceptions = Array.from({ length: 257 }, (_, i) => ({ originalStart: new Date(Date.UTC(2027, 2, 8 + 7 * i, 9)).toISOString().replace(".000", ""), deleted: true, changes: {} })))],
    ["two exceptions for one occurrence", (d) => (d.exceptions = [0, 1].map(() => ({ originalStart: "2027-03-15T09:00:00Z", deleted: true, changes: {} })))],
    ["an exception dated by a day in a timed series", (d) => (d.exceptions = [{ originalStart: "2027-03-15", deleted: true, changes: {} }])],
    ["an exception with an unknown change", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: false, changes: { uid: "other" } }])],
    ["an exception changing the recurrence", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: false, changes: { recurrence: null } }])],
    ["an exception whose end is before its start", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: false, changes: { start: "2027-03-15T10:00:00Z", end: "2027-03-15T09:59:59Z" } }])],
    ["an exception that is a whole day ending the day it starts", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: false, changes: { allDay: true, start: "2027-03-15", end: "2027-03-15" } }])],
    ["an exception becoming a whole day without dates", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: false, changes: { allDay: true } }])],
    ["an exception with an invalid deleted", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: 1, changes: {} }])],
    ["an exception without changes", (d) => (d.exceptions = [{ originalStart: "2027-03-15T09:00:00Z", deleted: false }])],
    ["exceptions without a recurrence", (d) => Object.assign(d, { recurrence: null, exceptions: [{ originalStart: "2027-03-15T09:00:00Z", deleted: true, changes: {} }] })],
    ["stamp that is a day", (d) => (d.stamp = "2027-01-02")],
    ["sequence -1", (d) => (d.sequence = -1)],
    ["sequence 2147483648", (d) => (d.sequence = 2147483648)],
    ["readOnly unknown", (d) => (d.readOnly = "yes")],
    ["readOnly of a task on an event", (d) => (d.readOnly = "regenerating")],
    ["readOnly \"__proto__\"", (d) => (d.readOnly = "__proto__")],
    ["kind \"note\"", (d) => (d.kind = "note")],
    ["kind \"task\" with the keys of an event", (d) => (d.kind = "task")],
  ];
  const made = cases.map(([label, mutate]) => {
    const d = base();
    mutate(d);
    return [label, d];
  });
  made.push(["every value in a \"__proto__\" key, no key of its own", JSON.parse(`{"__proto__":${JSON.stringify(base())}}`)]);
  made.push(["a zone whose values are all in a \"__proto__\" key", { ...base(), timezone: JSON.parse(`{"__proto__":${JSON.stringify(Z_PARIS)}}`) }]);
  made.push(["a list", [base()]]);
  made.push(["a string of iCalendar", "BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT"]);
  made.push(["a number", 7]);
  const tasks = [
    ["a task due before it starts", task("uid-h", { start: "2027-04-05", due: "2027-04-01" })],
    ["a task completed without the time it was done", task("uid-h", { completed: true })],
    ["a task with a start that has a time", task("uid-h", { start: "2027-04-05T00:00:00Z" })],
    ["a task with an unknown priority", task("uid-h", { priority: "urgent" })],
    ["a task repeating 256 times", task("uid-h", { start: "2027-04-05", recurrence: rule({ count: 256 }) })],
    ["a task repeating without a first day", task("uid-h", { recurrence: rule({ count: 3 }) })],
    ["a task with the read-only reason of an event", task("uid-h", { readOnly: "calendar-type" })],
    ["a task with a location", { ...task("uid-h"), location: "x" }],
  ];
  const before = (await H("items", { calendarId: C1 })).map((i) => i.id);
  const all = [...made, ...tasks];
  const results = [];
  for (let i = 0; i < all.length; i += 40) {
    results.push(...(await api.applyServerChanges(C1, all.slice(i, i + 40).map(([, d], n) => put(EVENTS, `h${i + n}`, d)))));
  }
  for (let i = 0; i < all.length; i++) {
    await check(`hostile description refused whole: ${all[i][0]}`, same(results[i], { serverId: `h${i}`, ok: false, code: "INVALID" }), results[i]);
  }
  const large = { ...base(), recurrence: rule({ count: 60 }), exceptions: Array.from({ length: 40 }, (_, i) => ({
    originalStart: new Date(Date.UTC(2027, 2, 9 + i, 9)).toISOString().replace(".000", ""), deleted: false, changes: { description: "x".repeat(32768) } })) };
  const tooLarge = await api.applyServerChanges(C1, [put(EVENTS, "huge", large)]);
  await check("a description whose parts are within bounds but that exceeds one megabyte as a whole → TOO_LARGE", same(tooLarge, [{ serverId: "huge", ok: false, code: "TOO_LARGE" }]), tooLarge);
  // Keys named after what every object inherits. Thunderbird's own passage of arguments from a page to privileged
  // code leaves such keys out, so the module may never see them: either way they must have no effect.
  const sneaky = [
    ["an own key \"__proto__\" carrying other values", withKey(base(), "__proto__", { busy: "free", summary: "smuggled" })],
    ["an own key \"__proto__\" in the meeting", { ...base(), meeting: withKey(base().meeting, "__proto__", { role: "organizer", cancelled: true }) }],
    ["an own key \"constructor\"", withKey(base(), "constructor", "x")],
    ["an own key \"toString\"", withKey(base(), "toString", "x")],
  ];
  for (const [label, d] of sneaky) {
    const [r] = await api.applyServerChanges(C1, [put(EVENTS, "sneaky", d)]);
    const stored = await H("item", { calendarId: C1, itemId: "uid-h" });
    await check(`${label}: refused, or without any effect`,
      same(r, { serverId: "sneaky", ok: false, code: "INVALID" }) ||
        (r.ok && stored.title === "uid-h" && stored.transp === "OPAQUE" && stored.status === null && stored.organizer?.id === "mailto:bob@example.com"), [r, stored?.title, stored?.transp, stored?.status]);
    await api.applyServerChanges(C1, [remove(EVENTS, "sneaky")]);
  }
  // A missing description: refused, by the module (INVALID) or by Thunderbird's own check of the call's types.
  const none = await api.applyServerChanges(C1, [put(EVENTS, "nothing", null)]).catch((e) => String(e?.message ?? e));
  await check("a description that is null is refused", same(none, [{ serverId: "nothing", ok: false, code: "INVALID" }]) || (typeof none === "string" && /^CONFIG: |Type error/.test(none)), none);
  const mixed = await api.applyServerChanges(C1, [put(EVENTS, "m1", event("uid-m1")), put(EVENTS, "m2", { ...event("uid-m2"), end: "nope" }), put(EVENTS, "m3", event("uid-m3"))]);
  await check("a refused description does not stop the others of the call", same(mixed, [{ serverId: "m1", ok: true }, { serverId: "m2", ok: false, code: "INVALID" }, { serverId: "m3", ok: true }]), mixed);
  await api.applyServerChanges(C1, [remove(EVENTS, "m1"), remove(EVENTS, "m3")]);
  const after = (await H("items", { calendarId: C1 })).map((i) => i.id);
  await check("nothing of a refused description was written: same items, same ServerIds, no local change",
    same(after, before) && !(await api.serverIds(C1, EVENTS)).some((id) => /^(h[0-9]+|huge|m2|nothing)$/.test(id)) && same(await localChanges(), []), after.filter((id) => !before.includes(id)));

  // A refused description for an item already held leaves it as it was.
  const kept = await api.applyServerChanges(C1, [put(EVENTS, "e2", { ...described("e2"), summary: "x".repeat(2000) })]);
  await check("a refused description for an item already held changes nothing of it", kept[0].ok === false && (await H("item", { calendarId: C1, itemId: "uid-e2" })).title === "uid-e2");

  // The call itself.
  const good = put(EVENTS, "x", event("uid-x"));
  const calls = [
    ["201 changes", Array.from({ length: 201 }, () => remove(EVENTS, "x"))],
    ["an unknown operation", [{ ...good, op: "merge" }]],
    ["an operation \"__proto__\"", [{ ...good, op: "__proto__" }]],
    ["a ServerId of 65 characters", [{ ...good, serverId: "s".repeat(65) }]],
    ["a ServerId with a line break", [{ ...good, serverId: "a\nb" }]],
    ["an empty collection", [{ ...good, collectionId: "" }]],
    ["a put without item", [{ op: "put", collectionId: EVENTS, serverId: "x" }]],
    ["a remove with an item", [{ ...good, op: "remove" }]],
    ["a detach with an item", [{ ...good, op: "detach" }]],
    ["an unknown key in a change", [{ ...good, force: true }]],
  ];
  for (const [label, changes] of calls) await expectCode(`applyServerChanges: ${label} (whole call refused)`, () => api.applyServerChanges(C1, changes), "CONFIG");
  const nullChange = await errorOf(() => api.applyServerChanges(C1, [null]));
  await check("applyServerChanges: a change that is null (whole call refused, by the module or by Thunderbird's check of the types)", /^CONFIG: |Type error/.test(nullChange ?? ""), nullChange);
  await check("… and nothing of those calls was applied", same((await H("items", { calendarId: C1 })).map((i) => i.id), before));
  await expectCode("serverIds with an invalid collection", () => api.serverIds(C1, ""), "CONFIG");
}

async function sameUid() {
  const first = event("shared-uid", { summary: "Premier" });
  const second = event("shared-uid", { summary: "Second", start: "2027-08-02T09:00:00Z", end: "2027-08-02T10:00:00Z" });
  const results = await api.applyServerChanges(C1, [put(EVENTS, "u1", first), put(EVENTS, "u2", second), put("7", "u1", event("shared-uid", { summary: "Autre collection" }))]);
  const items = (await H("items", { calendarId: C1 })).filter((i) => ["Premier", "Second", "Autre collection"].includes(i.title));
  const ids = items.map((i) => i.id).sort();
  await check("items with one UID under different ServerIds (or collections) all exist, each with an id of its own",
    results.every((r) => r.ok) && items.length === 3 && new Set(ids).size === 3 && ids.includes("shared-uid") && ids.filter((id) => /^sync443-[0-9a-f-]{36}$/.test(id)).length === 2, ids);
  const secondId = items.find((i) => i.title === "Second").id;
  await H("userEdit", { calendarId: C1, itemId: secondId, ops: [{ location: "Ailleurs" }] });
  let changes = await localChanges();
  await check("the item that got an id of ours still says its true UID, and is sent to its own ServerId",
    changes.length === 1 && changes[0].serverId === "u2" && changes[0].item?.uid === "shared-uid" && diff(changes[0].previous, second) === null && changes[0].item?.summary === "Second", changes);
  await api.dropLocalChange(C1, changes[0].changeId);
  // The server changes the second one: only that one moves.
  await api.applyServerChanges(C1, [put(EVENTS, "u2", { ...second, summary: "Second (bis)" })]);
  const titles = (await H("items", { calendarId: C1 })).map((i) => i.title);
  await check("a change for one of them touches that one only", titles.includes("Premier") && titles.includes("Second (bis)") && titles.includes("Autre collection") && !titles.includes("Second"));
  // An item the user made, then the same UID from the server.
  const mine = await H("userAdd", { calendarId: C1, spec: { id: "invited-uid", start: "20270803T100000", end: "20270803T110000", ops: [{ title: "Ajouté ici" }] } });
  await api.applyServerChanges(C1, [put(EVENTS, "u3", event("invited-uid", { summary: "Venu du serveur" }))]);
  const pair = (await H("items", { calendarId: C1 })).filter((i) => ["Ajouté ici", "Venu du serveur"].includes(i.title));
  changes = await localChanges();
  await check("a UID from the server never selects an item made here: both exist, the local one is still to send",
    pair.length === 2 && pair.find((i) => i.title === "Ajouté ici").id === mine && changes.length === 1 && changes[0].op === "add" && changes[0].item?.summary === "Ajouté ici", pair.map((i) => [i.id, i.title]));
  // The server names, for the local one, the item it already gave: one item is left, bound to it.
  await check("acknowledging the local item with a ServerId already held: it takes that place, the copy leaves",
    (await api.ackLocalChange(C1, changes[0].changeId, { serverId: "u3", collectionId: EVENTS, item: changes[0].item })) === true &&
      (await H("items", { calendarId: C1 })).filter((i) => ["Ajouté ici", "Venu du serveur"].includes(i.title)).map((i) => i.title).join() === "Ajouté ici" &&
      (await api.serverIds(C1, EVENTS)).filter((id) => id === "u3").length === 1);
  await api.applyServerChanges(C1, [remove(EVENTS, "u1"), remove(EVENTS, "u2"), remove("7", "u1"), remove(EVENTS, "u3")]);
  await check("(cleaned up)", (await H("items", { calendarId: C1 })).length === SHAPES.length && same(await localChanges(), []));
}

// ── Text: what the content of an item keeps, what nothing keeps ─────────

const ZWNJ = String.fromCharCode(0x200c); // zero-width non-joiner
const ZWJ = String.fromCharCode(0x200d); // zero-width joiner
const hex = (code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

async function texts() {
  // Joiners are part of words (Persian, Indic scripts) and of emoji: the server's text is kept as it is.
  const family = `${String.fromCodePoint(0x1f468)}${ZWJ}${String.fromCodePoint(0x1f469)}${ZWJ}${String.fromCodePoint(0x1f467)}`;
  const word = `${String.fromCharCode(0x0645, 0x06cc)}${ZWNJ}${String.fromCharCode(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)}`;
  const joined = event("uid-joined", {
    summary: `Famille ${family}`,
    location: word,
    description: `${word}\n${family}`,
    categories: [`Cat ${family}`, word],
    recurrence: rule({ count: 3 }),
    exceptions: [{ originalStart: "2027-03-11T09:00:00Z", deleted: false, changes: { summary: `Autre ${family}`, start: "2027-03-11T09:00:00Z", end: "2027-03-11T10:00:00Z" } }],
  });
  const taskJoined = task("uid-task-joined", { summary: word, description: family, categories: [family] });
  const kept = await api.applyServerChanges(C1, [put(EVENTS, "zw", joined), put(TASKS, "zwt", taskJoined)]);
  const shown = await H("item", { calendarId: C1, itemId: joined.uid });
  await check("the zero-width joiner and non-joiner are accepted in the content of an item (title, place, notes, categories, a changed occurrence)",
    kept.every((r) => r.ok) && shown?.title === joined.summary && shown?.location === word && shown?.description === joined.description && same(shown?.categories, joined.categories) &&
      shown?.exceptions[0]?.title === `Autre ${family}`, [kept, shown?.title]);
  await H("userEdit", { calendarId: C1, itemId: joined.uid, ops: [{ transp: "TRANSPARENT" }] });
  await H("userEdit", { calendarId: C1, itemId: "uid-task-joined", ops: [{ priority: 1 }] });
  let changes = await localChanges();
  await check("… and come back as they were given: the server's text is not rewritten by a change of something else",
    changes.length === 2 && diff(changes[0].previous, joined) === null && changes[0].item?.summary === joined.summary && changes[0].item?.location === word &&
      changes[0].item?.description === joined.description && same(changes[0].item?.categories, joined.categories) && diff(changes[1].previous, taskJoined) === null &&
      changes[1].item?.summary === word, changes.length === 2 ? (diff(changes[0].previous, joined) ?? diff(changes[1].previous, taskJoined)) : changes.length);
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);

  // An identifier is whatever its sender wrote: letters of any script, joiners as in a text. The item is found
  // by it all the same (Thunderbird's storage, asked through its XPCOM face, would not find an id above U+00FF).
  const far = event(`uid-${word}-${String.fromCharCode(0x65e5, 0x672c)}`, { summary: "Identifiant d'ailleurs" });
  await H("watch", { calendarId: C1 });
  const taken = await api.applyServerChanges(C1, [put(EVENTS, "far", far)]);
  const found = await H("directItem", { calendarId: C1, itemId: far.uid });
  await H("watched", { calendarId: C1 });
  const moved = await api.applyServerChanges(C1, [put(EVENTS, "far", { ...far, location: "Ailleurs" })]);
  const seen = await H("watched", { calendarId: C1 });
  await check("an item whose identifier has letters of other scripts and a joiner is held under that id, and a change from the server modifies it in place",
    taken[0].ok && found?.id === far.uid && found?.title === "Identifiant d'ailleurs" && moved[0].ok && seen.onModifyItem === 1 && seen.onAddItem === 0 &&
      (await H("items", { calendarId: C1 })).filter((i) => i.title === "Identifiant d'ailleurs").length === 1, [taken, found?.id === far.uid, seen]);
  await H("directEdit", { calendarId: C1, itemId: far.uid, ops: [{ title: "Renommé ici" }] });
  changes = await localChanges();
  await check("… and a change the user makes to it is read, with its identifier",
    changes.length === 1 && changes[0].op === "modify" && changes[0].serverId === "far" && changes[0].item?.uid === far.uid && changes[0].item?.summary === "Renommé ici", changes);
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  await api.applyServerChanges(C1, [remove(EVENTS, "far")]);

  // Everything else that cannot be seen is refused, wherever it is.
  const invisible = [0x00ad, 0x180e, 0x200b, 0x2060, 0xfeff, 0xfff9, 0xfffa, 0xfffb, 0xfffe, 0xffff, 0xe0001, 0xe0041, 0xe007f];
  const refused = [];
  for (const code of invisible) refused.push([`${hex(code)} in a title`, event("uid-inv", { summary: `a${String.fromCodePoint(code)}b` })]);
  const hidden = String.fromCodePoint(0x200b);
  const tag = String.fromCodePoint(0xe0062);
  refused.push(["an invisible character in the notes", event("uid-inv", { description: `a\n${hidden}b` })]);
  refused.push(["a tag character in the notes", event("uid-inv", { description: `a${tag}b` })]);
  refused.push(["an invisible character in a place", event("uid-inv", { location: `a${String.fromCodePoint(0xfeff)}` })]);
  refused.push(["an invisible character in a category", event("uid-inv", { categories: [`a${hidden}`] })]);
  refused.push(["a tag character in an identifier", event(`uid-inv${tag}`)]);
  refused.push(["an invisible character in a changed occurrence", event("uid-inv", { recurrence: rule({ count: 3 }),
    exceptions: [{ originalStart: "2027-03-11T09:00:00Z", deleted: false, changes: { summary: `a${hidden}b` } }] })]);
  refused.push(["an invisible character in the notes of a task", task("uid-inv", { description: `a${String.fromCodePoint(0x2060)}b` })]);
  // Names of people: not even the joiners (two names must not look alike).
  const meeting = (more) => event("uid-inv", { organizer: { email: "bob@example.com", name: "Bob" }, attendees: [person("carol@example.com", "Carol")],
    meeting: { ...NOT_A_MEETING, role: "attendee", response: "not-responded" }, ...more });
  refused.push(["a joiner in the organizer's name", meeting({ organizer: { email: "bob@example.com", name: `Bo${ZWJ}b` } })]);
  refused.push(["a non-joiner in an attendee's name", meeting({ attendees: [person("carol@example.com", `Ca${ZWNJ}rol`)] })]);
  refused.push(["a tag character in an attendee's name", meeting({ attendees: [person("carol@example.com", `Carol${tag}`)] })]);
  refused.push(["a joiner in the name of an attendee of one occurrence", meeting({ recurrence: rule({ count: 3 }),
    exceptions: [{ originalStart: "2027-03-11T09:00:00Z", deleted: false, changes: { attendees: [person("dave@example.com", `Da${ZWJ}ve`)] } }] })]);
  const results = await api.applyServerChanges(C1, refused.map(([, d], n) => put(d.kind === "task" ? TASKS : EVENTS, `inv${n}`, d)));
  for (let i = 0; i < refused.length; i++) {
    await check(`refused whole: ${refused[i][0]}`, same(results[i], { serverId: `inv${i}`, ok: false, code: "INVALID" }), results[i]);
  }
  await check("(a meeting with plain names is accepted: the refusals above are about the names)",
    (await api.applyServerChanges(C1, [put(EVENTS, "plain-names", meeting({}))]))[0].ok === true && (await api.applyServerChanges(C1, [remove(EVENTS, "plain-names")]))[0].ok === true);
  // The name of a calendar.
  const named = { mailboxId: M3, slot: "main", events: true, tasks: false, organizerEmail: OWN };
  await expectCode("ensureCalendar: a name with a zero-width joiner", () => api.ensureCalendar({ ...named, name: `Ag${ZWJ}enda` }), "CONFIG");
  await expectCode("ensureCalendar: a name with a zero-width space", () => api.ensureCalendar({ ...named, name: `Ag${hidden}enda` }), "CONFIG");
  await expectCode("ensureCalendar: a name with a tag character", () => api.ensureCalendar({ ...named, name: `Agenda${tag}` }), "CONFIG");
  await expectCode("ensureCalendar: a name with U+FFFF", () => api.ensureCalendar({ ...named, name: `Agenda${String.fromCharCode(0xffff)}` }), "CONFIG");

  // Typed in Thunderbird: the joiners stay in the content, nothing else that is invisible, and no joiner in a name.
  const typed = await H("userAdd", { calendarId: C1, spec: { start: "20271006T100000", end: "20271006T110000", organizer: { id: `mailto:${OWN}` },
    attendees: [{ id: "mailto:zed@example.com", cn: `Z${ZWJ}ed${hidden}` }],
    ops: [{ title: `Ti${ZWJ}tre${hidden} vu${tag}${String.fromCharCode(0xfffe)}` }, { location: `${word}${String.fromCodePoint(0x00ad)}` }, { description: `${family}${String.fromCodePoint(0xfff9)}` }] } });
  changes = await localChanges();
  await check("typed in Thunderbird: joiners are kept in the content, the other invisible characters are removed, and a name keeps none of them",
    changes.length === 1 && changes[0].item?.summary === `Ti${ZWJ}tre vu` && changes[0].item?.location === word && changes[0].item?.description === family &&
      changes[0].item?.attendees[0]?.name === "Zed", changes[0]?.item);
  await api.dropLocalChange(C1, changes[0].changeId);
  await H("userDelete", { calendarId: C1, itemId: typed });
  await api.applyServerChanges(C1, [remove(EVENTS, "zw"), remove(TASKS, "zwt")]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

// ── What the server does not say ────────────────────────────────────────

async function unsaid() {
  // A Change that carries no body: the notes held are kept.
  const noted = event("uid-nb", { summary: "Avec notes", description: "Ordre du jour\nLigne 2" });
  await api.applyServerChanges(C1, [put(EVENTS, "nb", noted), put(TASKS, "nbt", task("uid-nbt", { description: "Notes de la tâche" }))]);
  await H("watch", { calendarId: C1 });
  const again = await api.applyServerChanges(C1, [put(EVENTS, "nb", { ...noted, summary: "Renommé par le serveur", description: null }),
    put(TASKS, "nbt", { ...task("uid-nbt"), summary: "Tâche renommée", description: null })]);
  let stored = await H("item", { calendarId: C1, itemId: "uid-nb" });
  const storedTask = await H("item", { calendarId: C1, itemId: "uid-nbt" });
  await check("a put whose description is null keeps the description held, for an event and for a task, and applies the rest",
    again.every((r) => r.ok) && stored.title === "Renommé par le serveur" && stored.description === "Ordre du jour\nLigne 2" && storedTask.title === "Tâche renommée" &&
      storedTask.description === "Notes de la tâche", [again, stored.description, storedTask.description]);
  await H("watched", { calendarId: C1 });
  const replay = await api.applyServerChanges(C1, [put(EVENTS, "nb", { ...noted, summary: "Renommé par le serveur", description: null })]);
  await check("… the same put again writes nothing", replay[0].ok && Object.values(await H("watched", { calendarId: C1 })).every((n) => n === 0));
  await api.applyServerChanges(C1, [put(EVENTS, "nb2", { ...event("uid-nb2"), description: null })]);
  await H("userEdit", { calendarId: C1, itemId: "uid-nb", ops: [{ location: "Ici" }] });
  await H("userEdit", { calendarId: C1, itemId: "uid-nb2", ops: [{ location: "Ici" }] });
  let changes = await localChanges();
  await check("null is never stored or returned: the synchronized description says the notes held, and an empty text for an item that is new",
    changes.length === 2 && changes[0].previous?.description === "Ordre du jour\nLigne 2" && changes[0].item?.description === "Ordre du jour\nLigne 2" &&
      changes[0].previous?.summary === "Renommé par le serveur" && changes[1].previous?.description === "" && changes[1].item?.description === "" &&
      (await H("item", { calendarId: C1, itemId: "uid-nb2" })).description === null, changes.map((c) => [c.previous?.description, c.item?.description]));
  await expectCode("ackLocalChange with a description that says null for the notes", () => api.ackLocalChange(C1, changes[0].changeId, { item: { ...changes[0].item, description: null } }), "CONFIG");
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  await api.applyServerChanges(C1, [put(EVENTS, "nb", { ...noted, description: "" })]);
  await check("an empty description, said, does empty the notes", (await H("item", { calendarId: C1, itemId: "uid-nb" })).description === null);

  // A server that does not give the user's own answer (ActiveSync before 14.0).
  const invited = (more, response) => event("uid-ns", { summary: "Sans réponse dite", organizer: { email: "bob@example.com", name: "Bob" },
    attendees: [person(OWN, "Alice"), person("carol@example.com", "Carol")], meeting: { role: "attendee", cancelled: false, responseRequested: true, response, allowNewTime: true }, ...more });
  const first = await api.applyServerChanges(C1, [put(EVENTS, "ns", invited({}, null))]);
  const mine = async () => (await H("item", { calendarId: C1, itemId: "uid-ns" })).attendees.find((a) => a.id === `mailto:${OWN}`)?.partstat;
  await check("a put whose meeting.response is null, on an item that is new: not answered", first[0].ok && (await mine()) === "NEEDS-ACTION", [first, await mine()]);
  await H("userEdit", { calendarId: C1, itemId: "uid-ns", ops: [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }] });
  changes = await settledChanges();
  await check("… synchronized as \"not-responded\", never as null; the user then accepts",
    changes.length === 1 && changes[0].previous?.meeting.response === "not-responded" && changes[0].item?.meeting.response === "accepted", changes[0]?.previous?.meeting);
  await api.ackLocalChange(C1, changes[0].changeId, { item: changes[0].item });
  const later = await api.applyServerChanges(C1, [put(EVENTS, "ns", invited({ summary: "Changé sur le serveur" }, null))]);
  stored = await H("item", { calendarId: C1, itemId: "uid-ns" });
  await check("the server changes the item and still does not say the answer: the answer held is kept", later[0].ok && stored.title === "Changé sur le serveur" && (await mine()) === "ACCEPTED",
    [later, stored.title, await mine()]);
  await H("userEdit", { calendarId: C1, itemId: "uid-ns", ops: [{ alarm: 15 }] });
  changes = await settledChanges();
  await check("… and the synchronized description says \"accepted\"", changes.length === 1 && changes[0].previous?.meeting.response === "accepted" && changes[0].previous?.summary === "Changé sur le serveur" &&
    changes[0].item?.meeting.response === "accepted", changes[0]?.previous?.meeting);
  await expectCode("ackLocalChange with a description that says null for the answer",
    () => api.ackLocalChange(C1, changes[0].changeId, { item: { ...changes[0].item, meeting: { ...changes[0].item.meeting, response: null } } }), "CONFIG");
  await api.dropLocalChange(C1, changes[0].changeId);
  await api.applyServerChanges(C1, [put(EVENTS, "ns", invited({ summary: "Changé sur le serveur" }, "declined"))]);
  await check("an answer the server does say replaces the one held", (await mine()) === "DECLINED", await mine());
  const plain = await api.applyServerChanges(C1, [put(EVENTS, "ns2", { ...event("uid-ns2"), meeting: { ...NOT_A_MEETING, response: null } })]);
  await H("userEdit", { calendarId: C1, itemId: "uid-ns2", ops: [{ location: "Ici" }] });
  changes = await localChanges();
  await check("null for the answer of an appointment that is no meeting: \"none\"", plain[0].ok && changes[0]?.previous?.meeting.response === "none", changes[0]?.previous?.meeting);
  await api.dropLocalChange(C1, changes[0].changeId);

  // What the server orders its tasks by: kept with the synchronized description, said again with it.
  const ordered = task("uid-ord", { summary: "Ordonnée", start: "2027-06-01", due: "2027-06-02", ordinalDate: "2027-05-03T08:00:00.000Z", subOrdinalDate: "5637145091" });
  const taken = await api.applyServerChanges(C1, [put(TASKS, "ord", ordered)]);
  await H("userEdit", { calendarId: C1, itemId: "uid-ord", ops: [{ title: "Ordonnée, renommée" }] });
  changes = await localChanges();
  await check("a task's ordinalDate and subOrdinalDate are kept with its synchronized description and said again with the item",
    taken[0].ok && changes.length === 1 && diff(changes[0].previous, ordered) === null && diff(changes[0].item, { ...ordered, summary: "Ordonnée, renommée" }) === null,
    changes.length === 1 ? (diff(changes[0].previous, ordered) ?? diff(changes[0].item, { ...ordered, summary: "Ordonnée, renommée" })) : taken);
  await api.ackLocalChange(C1, changes[0].changeId, { item: changes[0].item });
  await H("userEdit", { calendarId: C1, itemId: "uid-ord", ops: [{ priority: 1 }] });
  changes = await localChanges();
  await check("… also once a change was acknowledged with them", changes[0]?.previous?.ordinalDate === ordered.ordinalDate && changes[0]?.item?.subOrdinalDate === ordered.subOrdinalDate, changes[0]?.item);
  await api.dropLocalChange(C1, changes[0].changeId);
  const bare = task("uid-ord", { summary: "Ordonnée", start: "2027-06-01", due: "2027-06-02" });
  await api.applyServerChanges(C1, [put(TASKS, "ord", { ...bare, ordinalDate: null, subOrdinalDate: null })]);
  await H("userEdit", { calendarId: C1, itemId: "uid-ord", ops: [{ priority: 9 }] });
  changes = await localChanges();
  await check("a task that says none (absent, or null) has none: the keys are not there", diff(changes[0]?.previous, bare) === null && !("ordinalDate" in (changes[0]?.item ?? { ordinalDate: 1 })),
    diff(changes[0]?.previous, bare));
  await api.dropLocalChange(C1, changes[0].changeId);
  const badOrdinals = await api.applyServerChanges(C1, [
    put(TASKS, "o1", { ...task("uid-o1"), ordinalDate: "x".repeat(41) }),
    put(TASKS, "o2", { ...task("uid-o2"), subOrdinalDate: `a${String.fromCharCode(10)}b` }),
    put(TASKS, "o3", { ...task("uid-o3"), ordinalDate: 20270503 }),
    put(TASKS, "o4", { ...task("uid-o4"), subOrdinalDate: `a${String.fromCharCode(0x202e)}b` }),
    put(TASKS, "o5", { ...task("uid-o5"), ordinal: "x" }),
    put(EVENTS, "o6", { ...event("uid-o6"), ordinalDate: "2027-05-03T08:00:00.000Z" }),
  ]);
  await check("ordinalDate and subOrdinalDate are bounded text of a task: 41 characters, a line break, a number, a bidirectional control, another key, or an event that has one → INVALID",
    same(badOrdinals, ["o1", "o2", "o3", "o4", "o5", "o6"].map((serverId) => ({ serverId, ok: false, code: "INVALID" }))), badOrdinals);
  await api.applyServerChanges(C1, [remove(EVENTS, "nb"), remove(TASKS, "nbt"), remove(EVENTS, "nb2"), remove(EVENTS, "ns"), remove(EVENTS, "ns2"), remove(TASKS, "ord")]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

// ── Recurrences that must never reach Thunderbird ───────────────────────

async function recurrences() {
  const timed = (day, more, length = 3600) => event("uid-rec", { start: `${day}T09:00:00Z`, end: new Date(Date.parse(`${day}T09:00:00Z`) + length * 1000).toISOString().replace(".000", ""),
    timezone: copy(Z_UTC), recurrence: rule(more) });
  const days = (start, end, more) => event("uid-rec", { allDay: true, start, end, timezone: copy(Z_UTC), recurrence: rule(more) });
  const DAY_S = 86400;
  const hostileRules = [
    // The day never comes in the first four periods: Thunderbird 140 fails for the whole calendar.
    ["day 31 every 12 months from a February", timed("2027-02-10", { freq: "monthly", interval: 12, byMonthDay: 31 })],
    ["day 31 every 12 months from an April", timed("2027-04-10", { freq: "monthly", interval: 12, byMonthDay: 31 })],
    ["day 31 every 24 months from a June", timed("2027-06-10", { freq: "monthly", interval: 24, byMonthDay: 31 })],
    ["day 30 every 12 months from a February", timed("2027-02-10", { freq: "monthly", interval: 12, byMonthDay: 30 })],
    ["day 29 every 24 months from February 2027", timed("2027-02-10", { freq: "monthly", interval: 24, byMonthDay: 29 })],
    ["day 29 every 12 months from February 2097 (2100 is not a leap year)", timed("2097-02-10", { freq: "monthly", interval: 12, byMonthDay: 29 })],
    ["29 February every 2 years from 2027", timed("2027-03-01", { freq: "yearly", interval: 2, byMonth: 2, byMonthDay: 29 })],
    ["29 February every 4 years from 2029", timed("2029-01-15", { freq: "yearly", interval: 4, byMonth: 2, byMonthDay: 29 })],
    ["a whole day: day 31 every 12 months from a September", days("2027-09-10", "2027-09-11", { freq: "monthly", interval: 12, byMonthDay: 31 })],
    ["a task: day 31 every 12 months from a February", task("uid-rec", { start: "2027-02-10", recurrence: rule({ freq: "monthly", interval: 12, byMonthDay: 31 }) })],
    ["a task with a due date only: day 30 every 12 months from a February", task("uid-rec", { due: "2027-02-10", recurrence: rule({ freq: "monthly", interval: 12, byMonthDay: 30 }) })],
    ["the first day as Thunderbird reads it: 31 January 23:30 UTC is 1 February in Paris, day 31 every 12 months",
      { ...timed("2027-01-31", { freq: "monthly", interval: 12, byMonthDay: 31 }), start: "2027-01-31T23:30:00Z", end: "2027-01-31T23:45:00Z", timezone: copy(Z_PARIS) }],
    // Shapes ActiveSync does not have: several never end in Thunderbird 140.
    ["daily on a day of a month", timed("2027-03-10", { freq: "daily", byMonthDay: 30, byMonth: 2 })],
    ["daily on the last Monday", timed("2027-03-10", { freq: "daily", byDay: ["MO"], bySetPos: -1 })],
    ["daily in a month", timed("2027-03-10", { freq: "daily", byMonth: 2 })],
    ["every 2 days on Mondays", timed("2027-03-10", { freq: "daily", interval: 2, byDay: ["MO"] })],
    ["weekly on a day of the month", timed("2027-03-10", { freq: "weekly", byMonthDay: 1 })],
    ["weekly with a rank", timed("2027-03-10", { freq: "weekly", byDay: ["MO"], bySetPos: 1 })],
    ["weekly in a month", timed("2027-03-10", { freq: "weekly", byMonth: 3 })],
    ["monthly in a month", timed("2027-03-10", { freq: "monthly", byMonth: 2 })],
    ["monthly on days without a rank", timed("2027-03-10", { freq: "monthly", byDay: ["MO"] })],
    ["monthly with a rank without days", timed("2027-03-10", { freq: "monthly", bySetPos: 1 })],
    ["monthly on a day number and on days", timed("2027-03-10", { freq: "monthly", byMonthDay: 10, byDay: ["WE"], bySetPos: 1 })],
    ["yearly on 30 February", timed("2027-03-10", { freq: "yearly", byMonth: 2, byMonthDay: 30 })],
    ["yearly on 31 April", timed("2027-03-10", { freq: "yearly", byMonth: 4, byMonthDay: 31 })],
    ["yearly on a day number without a month", timed("2027-03-10", { freq: "yearly", byMonthDay: 10 })],
    ["yearly on ranked days without a month", timed("2027-03-10", { freq: "yearly", byDay: ["MO"], bySetPos: 1 })],
    ["yearly on days without a rank", timed("2027-03-10", { freq: "yearly", byMonth: 3, byDay: ["MO"] })],
    ["yearly from 31 March, in April, on the day of the start", timed("2027-03-31", { freq: "yearly", byMonth: 4 })],
    ["a timed series that ends on a day", timed("2027-03-10", { until: "2027-06-01" })],
    ["a series of whole days that ends at an instant", days("2027-03-10", "2027-03-11", { until: "2027-06-01T00:00:00Z" })],
    ["a task that repeats until an instant", task("uid-rec", { start: "2027-03-10", recurrence: rule({ until: "2027-06-01T00:00:00Z" }) })],
    // Longer than its own period: every occurrence since the first one would lie over any day asked for.
    ["every day from 1900 to 2200, as one event", { ...timed("1900-01-01", {}), start: "1900-01-01T00:00:00Z", end: "2200-12-31T00:00:00Z" }],
    ["daily, one second longer than a day", timed("2027-03-10", {}, DAY_S + 1)],
    ["every 2 days, one second longer than 2 days", timed("2027-03-10", { interval: 2 }, 2 * DAY_S + 1)],
    ["weekly, one second longer than a week", timed("2027-03-10", { freq: "weekly" }, 7 * DAY_S + 1)],
    ["monthly, one second longer than 31 days", timed("2027-03-10", { freq: "monthly", byMonthDay: 10 }, 31 * DAY_S + 1)],
    ["yearly, one second longer than 366 days", timed("2027-03-10", { freq: "yearly", byMonth: 3, byMonthDay: 10 }, 366 * DAY_S + 1)],
    ["whole days: daily, two days long", days("2027-03-10", "2027-03-12", {})],
    ["whole days: monthly, 32 days long", days("2027-03-10", "2027-04-11", { freq: "monthly", byMonthDay: 10 })],
    ["a task: monthly, due 32 days after it starts", task("uid-rec", { start: "2027-03-10", due: "2027-04-11", recurrence: rule({ freq: "monthly", byMonthDay: 10 }) })],
    ["a task: daily, due two days after it starts", task("uid-rec", { start: "2027-03-10", due: "2027-03-12", recurrence: rule({}) })],
  ];
  const before = (await H("items", { calendarId: C1 })).map((i) => i.id);
  for (const [label, d] of hostileRules) {
    const collection = d.kind === "task" ? TASKS : EVENTS;
    const result = await guarded(`hostile recurrence: ${label}`, 15, () => api.applyServerChanges(C1, [put(collection, "rec", d)]));
    await check(`a recurrence Thunderbird must not be given is refused (UNSUPPORTED): ${label}`, same(result, [{ serverId: "rec", ok: false, code: "UNSUPPORTED" }]), result);
  }
  const seen = await guarded("the calendar is still readable as a view reads it", 20, () => H("viewItems", { calendarId: C1, from: "2027-01-01T00:00:00Z", to: "2028-01-01T00:00:00Z" }));
  await check("nothing of them was stored, and the calendar still gives its occurrences as a view asks for them",
    same((await H("items", { calendarId: C1 })).map((i) => i.id), before) && !(await api.serverIds(C1, EVENTS)).includes("rec") && !(await api.serverIds(C1, TASKS)).includes("rec") &&
      seen?.error === null && seen?.count > SHAPES.length, seen);

  // The same rules at their bounds are given to Thunderbird, which expands them. (For Thunderbird the first day
  // of an item is an occurrence whatever its rule says, and a day number that a month lacks skips that month.)
  const sound = [
    ["day 31 every month from a February (March has it)", timed("2027-02-10", { freq: "monthly", byMonthDay: 31, count: 6 }),
      ["2027-02-10", "2027-03-31", "2027-05-31", "2027-07-31", "2027-08-31", "2027-10-31", "2027-12-31"], "2027-01-01T00:00:00Z", "2028-06-01T00:00:00Z"],
    ["day 29 every 24 months from February 2026 (2028 has it)", timed("2026-02-10", { freq: "monthly", interval: 24, byMonthDay: 29, count: 2 }),
      ["2026-02-10", "2028-02-29", "2032-02-29"], "2026-01-01T00:00:00Z", "2033-01-01T00:00:00Z"],
    ["29 February every year from 2027", timed("2027-03-01", { freq: "yearly", byMonth: 2, byMonthDay: 29, count: 2 }), ["2027-03-01", "2028-02-29"], "2027-01-01T00:00:00Z", "2033-01-01T00:00:00Z"],
    ["monthly from the 31st, on the day of the start", timed("2027-01-31", { freq: "monthly", count: 3 }), ["2027-01-31", "2027-03-31", "2027-05-31"], "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z"],
    ["31 January 23:30 UTC, day 31 every 12 months, in UTC", { ...timed("2027-01-31", { freq: "monthly", interval: 12, byMonthDay: 31, count: 2 }), start: "2027-01-31T23:30:00Z", end: "2027-01-31T23:45:00Z" },
      ["2027-01-31", "2028-01-31"], "2027-01-01T00:00:00Z", "2029-01-01T00:00:00Z"],
    ["every weekday", timed("2027-03-10", { byDay: ["MO", "TU", "WE", "TH", "FR"], count: 4 }), ["2027-03-10", "2027-03-11", "2027-03-12", "2027-03-15"], "2027-03-01T00:00:00Z", "2027-04-01T00:00:00Z"],
    ["daily, exactly one day long", timed("2027-03-10", { count: 2 }, DAY_S), ["2027-03-10", "2027-03-11"], "2027-03-01T00:00:00Z", "2027-04-01T00:00:00Z"],
    ["whole days: weekly, exactly a week long", days("2027-03-10", "2027-03-17", { freq: "weekly", count: 2 }), ["2027-03-10", "2027-03-17"], "2027-03-01T00:00:00Z", "2027-04-01T00:00:00Z"],
    ["yearly, exactly 366 days long", timed("2027-03-10", { freq: "yearly", byMonth: 3, byMonthDay: 10, count: 2 }, 366 * DAY_S), ["2027-03-10", "2028-03-10"], "2027-01-01T00:00:00Z", "2029-01-01T00:00:00Z"],
    ["monthly, exactly 31 days long", timed("2027-03-10", { freq: "monthly", byMonthDay: 10, count: 2 }, 31 * DAY_S), ["2027-03-10", "2027-04-10"], "2027-03-01T00:00:00Z", "2027-06-01T00:00:00Z"],
    ["whole days: monthly, exactly 31 days long", days("2027-03-10", "2027-04-10", { freq: "monthly", byMonthDay: 10, count: 2 }), ["2027-03-10", "2027-04-10"], "2027-03-01T00:00:00Z", "2027-06-01T00:00:00Z"],
  ];
  for (const [label, d, expected, from, to] of sound) {
    const result = await guarded(`sound recurrence: ${label}`, 15, async () => {
      const applied = await api.applyServerChanges(C1, [put(EVENTS, "rec", d)]);
      const starts = applied[0]?.ok ? (await H("occurrences", { calendarId: C1, itemId: "uid-rec", from, to })).map((o) => (o.start.utc ?? o.start.local).slice(0, 10)) : null;
      await api.applyServerChanges(C1, [remove(EVENTS, "rec")]);
      return { applied, starts };
    });
    await check(`a recurrence at the bounds is accepted, and Thunderbird expands it: ${label}`, result?.applied?.[0]?.ok === true && same(result.starts, expected), result);
  }

  // The last line of defence: whatever the rules above let through, a series Thunderbird fails to expand is not stored.
  const odd = timed("2027-03-10", { interval: 997, count: 2 });
  await H("failExpansion", { on: true, interval: 997 });
  let failed = null;
  try {
    failed = await guarded("a series Thunderbird fails to expand", 15, () => api.applyServerChanges(C1, [put(EVENTS, "rec", odd), put(EVENTS, "rec-fine", timed("2027-03-10", { count: 2 }))]));
  } finally {
    await H("failExpansion", { on: false });
  }
  await check("a series that Thunderbird fails to expand is refused (UNSUPPORTED) before it is stored; the next item of the call is taken",
    same(failed, [{ serverId: "rec", ok: false, code: "UNSUPPORTED" }, { serverId: "rec-fine", ok: true }]) && !(await api.serverIds(C1, EVENTS)).includes("rec"), failed);
  const fine = await api.applyServerChanges(C1, [put(EVENTS, "rec", odd)]);
  await check("(the same series is accepted once Thunderbird expands it)", fine[0].ok === true, fine);
  await api.applyServerChanges(C1, [remove(EVENTS, "rec"), remove(EVENTS, "rec-fine")]);

  // Made in Thunderbird: the same rules say what cannot be sent, and the item stays the user's.
  const local = [
    ["a daily rule in one month", { start: "20271004T100000", end: "20271004T110000", ops: [{ rrule: "FREQ=DAILY;BYMONTH=11;COUNT=3" }] }],
    ["a daily series three days long", { start: "20271004T100000", end: "20271007T100000", ops: [{ rrule: "FREQ=DAILY;COUNT=3" }] }],
  ];
  const ids = [];
  for (const [label, spec] of local) ids.push(await guarded(`made in Thunderbird: ${label}`, 15, () => H("userAdd", { calendarId: C1, spec })));
  const changes = await localChanges();
  for (let i = 0; i < local.length; i++) {
    await check(`made in Thunderbird, ${local[i][0]} → problem "recurrence", no item`, changes[i]?.op === "add" && changes[i]?.problem === "recurrence" && changes[i]?.item === null, changes[i]);
  }
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  for (const id of ids) await H("userDelete", { calendarId: C1, itemId: id });
  await check("(cleaned up)", same(await localChanges(), []) && same((await H("items", { calendarId: C1 })).map((i) => i.id), before));
}

// ── The server changed an item while a change of the user waited ────────

async function rewritten() {
  const d = event("uid-rw", { summary: "Point", location: "Salle 1" });
  await api.applyServerChanges(C1, [put(EVENTS, "rw", d)]);
  await H("userEdit", { calendarId: C1, itemId: "uid-rw", ops: [{ categories: ["Important"] }] });
  let [c] = await localChanges();
  await check("a change of the user that the server did not cross is not marked rewritten", c?.op === "modify" && c.rewritten === false && c.replyAsked === false, c);
  await api.applyServerChanges(C1, [put(EVENTS, "rw", d)]);
  await check("… nor when the server only says again what it had said", (await localChanges())[0]?.rewritten === false);
  // Another device moves the meeting while the change waits.
  const moved = { ...d, start: "2027-03-11T14:00:00Z", end: "2027-03-11T15:00:00Z", location: "Salle 9" };
  const applied = await api.applyServerChanges(C1, [put(EVENTS, "rw", moved)]);
  [c] = await localChanges();
  let stored = await H("item", { calendarId: C1, itemId: "uid-rw" });
  await check("the server changes the item while the change waits: the change is marked rewritten, its previous is the server's new version, and the item is still the user's",
    applied[0].ok && c?.op === "modify" && c.rewritten === true && diff(c.previous, moved) === null && c.item?.location === "Salle 1" && same(c.item?.categories, ["Important"]) &&
      stored.start.utc === "2027-03-10T09:00:00Z" && stored.location === "Salle 1", [c?.rewritten, diff(c?.previous, moved), stored.start.utc]);
  await api.applyServerChanges(C1, [put(EVENTS, "rw", moved)]);
  await check("… the mark stays until the change is settled, whatever the server says next", (await localChanges())[0]?.rewritten === true);
  // The server wins: the engine drops the change.
  const dropped = await api.dropLocalChange(C1, c.changeId);
  stored = await H("item", { calendarId: C1, itemId: "uid-rw" });
  await check("dropped, the server's version is shown and nothing is left to send",
    dropped === true && stored.start.utc === "2027-03-11T14:00:00Z" && stored.location === "Salle 9" && same(stored.categories, []) && same(await localChanges(), []), [stored.start.utc, stored.location, stored.categories]);
  await H("userEdit", { calendarId: C1, itemId: "uid-rw", ops: [{ title: "Point (suite)" }] });
  [c] = await localChanges();
  await check("the next change of the same item is not marked", c?.rewritten === false && c?.previous?.location === "Salle 9", c);
  // The mark is in the journal: the engine acknowledging another reading does not lose it, and a deletion carries it too.
  await api.dropLocalChange(C1, c.changeId);
  await H("userDelete", { calendarId: C1, itemId: "uid-rw" });
  await api.applyServerChanges(C1, [put(EVENTS, "rw", { ...moved, summary: "Point, renommé ailleurs" })]);
  [c] = await localChanges();
  await check("a deletion that waited while the server changed the item is marked too", c?.op === "delete" && c.rewritten === true && c.previous?.summary === "Point, renommé ailleurs", c);
  await check("… dropped, the item is back as the server now has it",
    (await api.dropLocalChange(C1, c.changeId)) === true && (await H("item", { calendarId: C1, itemId: "uid-rw" }))?.title === "Point, renommé ailleurs" && same(await localChanges(), []));
  // An item made here has no server version to be rewritten.
  const mine = await H("userAdd", { calendarId: C1, spec: { start: "20271007T100000", end: "20271007T110000" } });
  [c] = await localChanges();
  await check("an \"add\" is never marked rewritten", c?.op === "add" && c.rewritten === false && c.replyAsked === false, c);
  await api.dropLocalChange(C1, c.changeId);
  await H("userDelete", { calendarId: C1, itemId: mine });
  await api.applyServerChanges(C1, [remove(EVENTS, "rw")]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

// ── A change of the server that cannot be read ──────────────────────────

async function locked() {
  const d = event("uid-lk", { summary: "Lisible", location: "Salle 1" });
  await api.applyServerChanges(C1, [put(EVENTS, "lk", d)]);
  await H("watch", { calendarId: C1 });
  const results = await api.applyServerChanges(C1, [{ op: "lock", collectionId: EVENTS, serverId: "lk" }, { op: "lock", collectionId: EVENTS, serverId: "never-there" }]);
  let stored = await H("item", { calendarId: C1, itemId: "uid-lk" });
  await check("lock: accepted (also for what is not held); the item keeps its content, stays linked, and nothing is to send",
    same(results, [{ serverId: "lk", ok: true }, { serverId: "never-there", ok: true }]) && stored?.title === "Lisible" && stored?.location === "Salle 1" &&
      (await api.serverIds(C1, EVENTS)).includes("lk") && same(await localChanges(), []) && Object.values(await H("watched", { calendarId: C1 })).every((n) => n === 0), [results, stored?.title]);
  const lockedAccess = await H("access", { calendarId: C1, itemId: "uid-lk" });
  const edited = await errorOf(() => H("uiEdit", { calendarId: C1, itemId: "uid-lk", ops: [{ title: "Modifié après" }] }));
  const deleted = await errorOf(() => H("uiDelete", { calendarId: C1, itemId: "uid-lk" }));
  await check("a locked item is read-only for Thunderbird: it says so when asked, and a change or a deletion through Thunderbird's editing paths is refused; nothing made from the stale copy is sent",
    lockedAccess.modify === false && lockedAccess.dialog === "summary" && typeof edited === "string" && typeof deleted === "string" &&
      (await H("item", { calendarId: C1, itemId: "uid-lk" }))?.title === "Lisible" && same(await localChanges(), []), [lockedAccess, edited, deleted]);
  let c = null;
  // A later version that can be read replaces the item as usual, even the very description applied before.
  const unlocked = await api.applyServerChanges(C1, [put(EVENTS, "lk", d)]);
  const unlockedAccess = await H("access", { calendarId: C1, itemId: "uid-lk" });
  await H("uiEdit", { calendarId: C1, itemId: "uid-lk", ops: [{ title: "Modifiable" }] });
  [c] = await localChanges();
  await check("a later readable version, even the same as before, makes the item an ordinary one again: editable in Thunderbird, its change read",
    unlocked[0].ok && unlockedAccess.modify === true && unlockedAccess.dialog === "edit" && c?.problem === null && c.previous?.readOnly === null && c.item?.summary === "Modifiable" && c.rewritten === false, [unlockedAccess, c]);
  // Locked while a change waits: the server did change the item.
  await api.applyServerChanges(C1, [{ op: "lock", collectionId: EVENTS, serverId: "lk" }]);
  [c] = await localChanges();
  await check("locked while a change of the user waits: that change says \"read-only\" and rewritten", c?.problem === "read-only" && c.rewritten === true && c.item === null, c);
  await api.dropLocalChange(C1, c.changeId);
  stored = await H("item", { calendarId: C1, itemId: "uid-lk" });
  await check("… and is undone when dropped", stored.title === "Lisible" && same(await localChanges(), []), stored.title);
  await expectCode("applyServerChanges: a lock with an item (whole call refused)", () => api.applyServerChanges(C1, [{ op: "lock", collectionId: EVENTS, serverId: "lk", item: d }]), "CONFIG");
  // A task, and a calendar that holds nothing of that kind.
  await api.applyServerChanges(C1, [put(TASKS, "lkt", task("uid-lkt"))]);
  await H("uiEdit", { calendarId: C1, itemId: "uid-lkt", ops: [{ priority: 1 }] });
  await api.applyServerChanges(C1, [{ op: "lock", collectionId: TASKS, serverId: "lkt" }]);
  [c] = await localChanges();
  const ticked = await errorOf(() => H("uiEdit", { calendarId: C1, itemId: "uid-lkt", ops: [{ complete: true }] }));
  await check("a locked task: the same (the change that waited says \"read-only\", a new one is refused)",
    c?.kind === "task" && c.problem === "read-only" && c.previous?.readOnly === "incomplete" && typeof ticked === "string", [c, ticked]);
  await api.dropLocalChange(C1, c.changeId);
  await api.applyServerChanges(C1, [remove(EVENTS, "lk"), remove(TASKS, "lkt")]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

// ── A reply needs the user's answer: what Thunderbird asks, and when ────

const ics = (method, uid, partstat = "NEEDS-ACTION") =>
  [
    "BEGIN:VCALENDAR",
    "PRODID:-//Sync443 test//EN",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20270102T030405Z",
    "SEQUENCE:0",
    "DTSTART:20270310T090000Z",
    "DTEND:20270310T100000Z",
    `SUMMARY:${uid}`,
    "ORGANIZER;CN=Bob:mailto:bob@example.com",
    `ATTENDEE;PARTSTAT=${partstat};RSVP=TRUE;CN=Alice:mailto:${OWN}`,
    "ATTENDEE;PARTSTAT=ACCEPTED;CN=Carol:mailto:carol@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

async function replies() {
  const invitation = (uid) => event(uid, { organizer: { email: "bob@example.com", name: "Bob" }, attendees: [person(OWN, "Alice"), person("carol@example.com", "Carol", "optional", "accepted")],
    meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "not-responded", allowNewTime: true } });
  await api.applyServerChanges(C1, [put(EVENTS, "ask", invitation("uid-ask"))]);
  const accept = [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }];
  const decline = [{ partstat: { id: `mailto:${OWN}`, value: "DECLINED" } }];
  const edit = (ops, mode) => H("uiEdit", { calendarId: C1, itemId: "uid-ask", ops, mode });
  /** The one change to send, once it can be read. */
  const only = async () => {
    const list = await settledChanges();
    return list.length === 1 ? list[0] : { count: list.length, list };
  };
  /** The change is undone (an added item then stays as a copy: deleted too). */
  const forget = async (c, itemId) => {
    for (const one of c?.list ?? [c]) {
      if (typeof one?.changeId === "string") await api.dropLocalChange(C1, one.changeId);
    }
    if (itemId && (await H("item", { calendarId: C1, itemId }))) await H("userDelete", { calendarId: C1, itemId });
  };

  // Thunderbird asks the calendar once the item is changed: the change is not read before that could come.
  await announcedSince();
  const started = Date.now();
  await edit(accept, "AUTO");
  const early = await localChanges();
  const first = await announcedSince();
  await check("an answer to an invitation is announced at once, but is not read during the two seconds that follow it", same(early, []) && first.includes(C1), [early, first]);
  await check("(read again meanwhile: still nothing)", same(await localChanges(), []));
  let again = [];
  while (Date.now() - started < 2 * SETTLE_MS && !again.includes(C1)) again = again.concat(await announcedSince());
  const waited = Date.now() - started;
  let changes = await localChanges();
  await check("onLocalChange fires again when the change can be read, about two seconds after it was made", again.includes(C1) && waited >= SETTLE_MS - 100 && waited < 2 * SETTLE_MS, [again, waited]);
  await check("accepted in Thunderbird with \"send a response now\": Thunderbird asks to send the reply, the change says replyAsked",
    changes.length === 1 && changes[0].op === "modify" && changes[0].serverId === "ask" && changes[0].item?.meeting.response === "accepted" && changes[0].replyAsked === true && changes[0].rewritten === false, changes);
  await check("reading twice gives the same change", same(await localChanges(), changes));
  await forget(changes[0]);

  await edit(accept, "NONE");
  let c = await only();
  await check("accepted with \"do not send a response\": Thunderbird does not ask, the change does not say replyAsked", c.item?.meeting.response === "accepted" && c.replyAsked === false, c);
  await forget(c);

  await H("userEdit", { calendarId: C1, itemId: "uid-ask", ops: accept });
  c = await only();
  await check("the status changed by what is not an answer in Thunderbird's interface (no scheduling step): not asked", c.item?.meeting.response === "accepted" && c.replyAsked === false, c);
  await forget(c);

  await edit(decline, "DEFAULT");
  c = await only();
  await check("declined where Thunderbird would ask the user before sending (no mode given): it asks the calendar, replyAsked", c.item?.meeting.response === "declined" && c.replyAsked === true, c);
  await forget(c);

  await edit(accept, "AUTO");
  await edit(decline, "NONE");
  c = await only();
  await check("accepted with a response, then declined without one before anything is read: the answer the item carries was not asked for",
    c.item?.meeting.response === "declined" && c.replyAsked === false, c);
  await forget(c);

  await edit(accept, "AUTO");
  await edit(decline, "NONE");
  await edit(accept, "NONE");
  c = await only();
  await check("… then accepted again without one: the first question does not stand for the last answer", c.item?.meeting.response === "accepted" && c.replyAsked === false, c);
  await forget(c);

  await edit(accept, "AUTO");
  c = await only();
  await edit([{ alarm: 30 }], "AUTO");
  const partial = await api.ackLocalChange(C1, c.changeId, { item: c.item });
  const rest = await only();
  await check("the answer is acknowledged while the user changed something else: what stays to send does not say replyAsked",
    c.replyAsked === true && partial === false && rest.op === "modify" && rest.previous?.meeting.response === "accepted" && rest.item?.reminder === 30 && rest.replyAsked === false, [partial, rest]);
  await forget(rest);
  await api.applyServerChanges(C1, [put(EVENTS, "ask", invitation("uid-ask"))]);

  await edit(accept, "AUTO");
  await edit([{ alarm: 10 }], "AUTO");
  c = await only();
  await check("accepted with a response, then something else is changed: the reply is still asked for", c.item?.meeting.response === "accepted" && c.item?.reminder === 10 && c.replyAsked === true, c);
  await api.ackLocalChange(C1, c.changeId, { item: c.item });
  await edit([{ alarm: 20 }], "AUTO");
  c = await only();
  await check("once that change is acknowledged, the next change of the item does not say replyAsked", c.previous?.meeting.response === "accepted" && c.item?.reminder === 20 && c.replyAsked === false, c);
  await forget(c);

  await H("uiDelete", { calendarId: C1, itemId: "uid-ask", mode: "AUTO" });
  changes = await settledChanges();
  await check("an invitation deleted in Thunderbird (which would send \"declined\"): a \"delete\" that never says replyAsked",
    changes.length === 1 && changes[0].op === "delete" && changes[0].replyAsked === false, changes);
  await forget(changes[0]);
  await api.applyServerChanges(C1, [put(EVENTS, "ask", invitation("uid-ask"))]);

  // The invitation bar of the message: Thunderbird's own processing of the calendar part.
  let bar = await H("itipAnswer", { calendarId: C1, ics: ics("REQUEST", "uid-ask"), partstat: "ACCEPTED", mode: "AUTO" });
  c = await only();
  await check("the invitation bar, \"Accept\": replyAsked", bar.ok === true && c.op === "modify" && c.item?.meeting.response === "accepted" && c.replyAsked === true, [bar, c]);
  await forget(c);
  bar = await H("itipAnswer", { calendarId: C1, ics: ics("REQUEST", "uid-ask"), partstat: "ACCEPTED", mode: "NONE" });
  c = await only();
  await check("the invitation bar, \"Accept\" then \"Do not send a response\": not asked", bar.ok === true && c.item?.meeting.response === "accepted" && c.replyAsked === false, [bar, c]);
  await forget(c);

  bar = await H("itipAnswer", { calendarId: C1, ics: ics("REQUEST", "uid-ask2"), partstat: "TENTATIVE", mode: "AUTO" });
  c = await only();
  await check("the invitation bar on an event the calendar does not hold yet: an \"add\" that carries the answer, replyAsked",
    bar.ok === true && c.op === "add" && c.item?.uid === "uid-ask2" && c.item?.meeting.response === "tentative" && c.replyAsked === true, [bar, c]);
  await forget(c, "uid-ask2");
  bar = await H("itipAnswer", { calendarId: C1, ics: ics("REQUEST", "uid-ask3"), partstat: "ACCEPTED", mode: "NONE" });
  c = await only();
  await check("… with \"Do not send a response\": an \"add\" that carries the answer, not asked", bar.ok === true && c.op === "add" && c.item?.meeting.response === "accepted" && c.replyAsked === false, [bar, c]);
  await forget(c, "uid-ask3");

  // An answer nobody gave: written in what the user only added to the calendar.
  bar = await H("itipAnswer", { calendarId: C1, ics: ics("PUBLISH", "uid-ask4", "ACCEPTED"), partstat: "", mode: "AUTO" });
  c = await only();
  await check("\"Add to calendar\" of a published event that says the user accepted: an \"add\", never replyAsked",
    bar.ok === true && c.op === "add" && c.item?.meeting.role === "attendee" && c.item?.meeting.response === "accepted" && c.replyAsked === false, [bar, c]);
  await forget(c, "uid-ask4");
  const imported = await H("importItems", { calendarId: C1, specs: [{ id: "uid-ask5", start: "20270312T100000", end: "20270312T110000", organizer: { id: "mailto:mallory@example.net" },
    attendees: [{ id: `mailto:${OWN}`, partstat: "ACCEPTED", rsvp: "TRUE" }] }] });
  c = await only();
  await check("imported from a file in which the user's acceptance is already written: an \"add\", never replyAsked",
    imported.imported === 1 && imported.failed === null && c.op === "add" && c.item?.meeting.role === "attendee" && c.item?.meeting.response === "accepted" && c.replyAsked === false, [imported, c]);
  await forget(c, "uid-ask5");
  await api.applyServerChanges(C1, [remove(EVENTS, "ask")]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

// ── A change id names one change, for ever ──────────────────────────────

async function revisions() {
  const token = (c) => c.changeId.split(".")[0];
  const number = (c) => Number(c.changeId.split(".")[1]);
  const id = await H("userAdd", { calendarId: C1, spec: { start: "20271011T100000", end: "20271011T110000", ops: [{ title: "Premier état" }] } });
  const [a] = await localChanges();
  await api.ackLocalChange(C1, a.changeId, { serverId: "rev", collectionId: EVENTS, item: a.item });
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Deuxième état" }] });
  const [b] = await localChanges();
  await check("the change that follows an acknowledged one gets a new id: the revision of an item never restarts",
    b.changeId !== a.changeId && token(b) === token(a) && number(b) > number(a), [a.changeId, b.changeId]);
  // The acknowledgement of the first change comes a second time (a request replayed).
  const late = await api.ackLocalChange(C1, a.changeId, { item: a.item });
  const [still] = await localChanges();
  await check("an acknowledgement that comes twice settles nothing: the newer change is still to send, against the right version",
    late === false && still?.changeId === b.changeId && still.item?.summary === "Deuxième état" && still.previous?.summary === "Premier état" &&
      (await api.dropLocalChange(C1, a.changeId)) === false && (await H("item", { calendarId: C1, itemId: id })).title === "Deuxième état", [late, still]);
  await check("… while the acknowledgement of that change does settle it", (await api.ackLocalChange(C1, b.changeId, { item: b.item })) === true && same(await localChanges(), []));
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Troisième état" }] });
  const [c] = await localChanges();
  // The first acknowledgement comes yet again, now that a later change was read: it must not put its old
  // description back as the synchronized one.
  const replayed = await api.ackLocalChange(C1, a.changeId, { item: a.item });
  const [same3] = await localChanges();
  await check("an old acknowledgement replayed while a later change is on its way changes nothing: the synchronized version stays the last one acknowledged",
    replayed === false && same3?.changeId === c.changeId && same3.previous?.summary === "Deuxième état" && same3.item?.summary === "Troisième état", [replayed, same3?.previous?.summary]);
  await api.dropLocalChange(C1, c.changeId);
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Quatrième état" }] });
  const [d] = await localChanges();
  await check("after a change was dropped too: a new id, and dropping the old one again undoes nothing",
    number(d) > number(c) && number(c) > number(b) && (await api.dropLocalChange(C1, c.changeId)) === false && (await H("item", { calendarId: C1, itemId: id })).title === "Quatrième état", [c.changeId, d.changeId]);
  await api.dropLocalChange(C1, d.changeId);
  // A version from the server in between does not restart the count either.
  await api.applyServerChanges(C1, [put(EVENTS, "rev", { ...b.item, summary: "État du serveur" })]);
  await H("userEdit", { calendarId: C1, itemId: id, ops: [{ title: "Cinquième état" }] });
  const [e] = await localChanges();
  await check("nor does a version from the server restart it", number(e) > number(d) && token(e) === token(a) && e.previous?.summary === "État du serveur", [d.changeId, e.changeId]);
  await api.dropLocalChange(C1, e.changeId);
  await api.applyServerChanges(C1, [remove(EVENTS, "rev")]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length, (await H("items", { calendarId: C1 })).length);
}

// ── An item of the user is never replaced ───────────────────────────────

async function usersItems() {
  const { duplicateId } = await H("probe");
  const refusedAs = (message) => typeof message === "string" && message.includes(`[${duplicateId}]`);
  const before = await H("item", { calendarId: C1, itemId: "uid-e2" });
  const intruder = { id: "uid-e2", start: "20290101T100000", end: "20290101T110000", ops: [{ title: "Remplaçant" }] };
  // Someone who knows the UID of an event of the user sends a file; the user imports it into this calendar.
  const imported = await H("importItems", { calendarId: C1, specs: [intruder] });
  await check("Thunderbird's import of an item whose id the calendar already holds is refused as a duplicate (DUPLICATE_ID): the user's item is not replaced, nothing is to send",
    imported.imported === 0 && imported.failed === duplicateId && same(await H("item", { calendarId: C1, itemId: "uid-e2" }), before) && same(await localChanges(), []), [imported, duplicateId]);
  const added = await errorOf(() => H("userAdd", { calendarId: C1, spec: intruder }));
  await check("addItem under an id the calendar holds: refused with DUPLICATE_ID, as Thunderbird's own storage refuses it",
    refusedAs(added) && same(await H("item", { calendarId: C1, itemId: "uid-e2" }), before) && same(await localChanges(), []), added);
  const mine = await H("userAdd", { calendarId: C1, spec: { start: "20271012T100000", end: "20271012T110000", ops: [{ title: "À moi" }] } });
  const twice = await errorOf(() => H("userAdd", { calendarId: C1, spec: { ...intruder, id: mine } }));
  let changes = await localChanges();
  await check("… also for an item made here that is still to send: one \"add\", as the user made it",
    refusedAs(twice) && changes.length === 1 && changes[0].op === "add" && changes[0].item?.summary === "À moi", [twice, changes]);
  await api.dropLocalChange(C1, changes[0].changeId);
  const third = await errorOf(() => H("userAdd", { calendarId: C1, spec: { ...intruder, id: mine } }));
  await check("… and for a copy that is no longer synchronized", refusedAs(third) && (await H("item", { calendarId: C1, itemId: mine }))?.title === "À moi" && same(await localChanges(), []), third);
  await H("userDelete", { calendarId: C1, itemId: mine });
  const fresh = await H("importItems", { calendarId: C1, specs: [{ id: "imported-1", start: "20271013T100000", end: "20271013T110000" }, { id: "imported-2", start: "20271014T100000", end: "20271014T110000" }] });
  changes = await localChanges();
  await check("items with ids of their own are imported as before: one \"add\" each",
    fresh.imported === 2 && fresh.failed === null && same(changes.map((c) => [c.op, c.item?.uid, c.replyAsked]), [["add", "imported-1", false], ["add", "imported-2", false]]), [fresh, changes.map((c) => c.op)]);
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  for (const id of ["imported-1", "imported-2"]) await H("userDelete", { calendarId: C1, itemId: id });
  // "Undo" of a deletion is an addition under an id the calendar still holds, as a deletion that waits.
  await H("uiDelete", { calendarId: C1, itemId: "uid-e3" });
  const deleted = await localChanges();
  await H("uiUndo");
  const back = await H("item", { calendarId: C1, itemId: "uid-e3" });
  await check("Thunderbird's \"undo\" of a deletion still brings the item back under its id",
    deleted.length === 1 && deleted[0].op === "delete" && back?.title === "uid-e3" && (await localChanges()).every((c) => c.op !== "delete"), [deleted.map((c) => c.op), back?.title]);
  await api.dropLocalChange(C1, deleted[0].changeId);
  for (const c of await localChanges()) await api.dropLocalChange(C1, c.changeId);
  await api.applyServerChanges(C1, [put(EVENTS, "e3", described("e3"))]);
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length && (await api.serverIds(C1, EVENTS)).includes("e3"),
    [(await H("items", { calendarId: C1 })).length, await localChanges()]);
}

// ── Journal, items and calendars: what must hold whatever happens ───────

async function lifeCycle(user) {
  // Lists with holes: map() would skip them, for…of would not.
  const sparse = (length, values) => {
    const list = new Array(length);
    for (const [index, value] of values) list[index] = value;
    return list;
  };
  const meeting = { organizer: { email: "bob@example.com", name: "Bob" }, meeting: { ...NOT_A_MEETING, role: "attendee", response: "not-responded" } };
  const holes = [
    ["attendees that are all holes", { ...event("uid-hole", meeting), attendees: new Array(3) }],
    ["attendees with one hole", { ...event("uid-hole", meeting), attendees: sparse(3, [[0, person("carol@example.com", "Carol")], [2, person("dave@example.com", "Dave")]]) }],
    ["categories with a hole", { ...event("uid-hole"), categories: sparse(2, [[1, "Perso"]]) }],
    ["exceptions that are all holes", { ...event("uid-hole", { recurrence: rule({ count: 5 }) }), exceptions: new Array(2) }],
    ["days of the week with a hole", event("uid-hole", { recurrence: { ...rule({ freq: "weekly", count: 3 }), byDay: new Array(1) } })],
    ["the attendees of one occurrence with a hole", event("uid-hole", { ...meeting, recurrence: rule({ count: 3 }),
      exceptions: [{ originalStart: "2027-03-11T09:00:00Z", deleted: false, changes: { attendees: sparse(2, [[1, person("carol@example.com", "Carol")]]) } }] })],
  ];
  // An occurrence whose end, worked out from the length of its series, falls after the last year of the contract.
  const beyond = [
    ["a whole-day occurrence moved to the last day of 2200", event("uid-hole", { allDay: true, start: "2200-12-28", end: "2200-12-29", timezone: copy(Z_UTC), recurrence: rule({ count: 3 }),
      exceptions: [{ originalStart: "2200-12-29", deleted: false, changes: { start: "2200-12-31" } }] })],
    ["a timed occurrence moved to the last half-hour of 2200", event("uid-hole", { start: "2200-12-28T09:00:00Z", end: "2200-12-28T10:00:00Z", timezone: copy(Z_UTC), recurrence: rule({ count: 3 }),
      exceptions: [{ originalStart: "2200-12-29T09:00:00Z", deleted: false, changes: { start: "2200-12-31T23:30:00Z" } }] })],
  ];
  const cases = [...holes, ...beyond];
  const results = await api.applyServerChanges(C1, cases.map(([, d], n) => put(EVENTS, `hole${n}`, d)));
  for (let i = 0; i < cases.length; i++) {
    await check(`refused whole (INVALID): ${cases[i][0]}`, same(results[i], { serverId: `hole${i}`, ok: false, code: "INVALID" }), results[i]);
  }
  await check("… and nothing of them was stored", (await H("item", { calendarId: C1, itemId: "uid-hole" })) === null && !(await api.serverIds(C1, EVENTS)).some((id) => id.startsWith("hole")));

  // A series with changed occurrences is described in one pass: no occurrence is built again from its series to
  // tell what it changed (that cost twice the work for every put, reading and change of a large meeting).
  const changed = Array.from({ length: 5 }, (_, i) => ({ originalStart: `2027-03-${11 + i}T09:00:00Z`, deleted: false,
    changes: { summary: `Occurrence ${i}`, start: `2027-03-${11 + i}T09:00:00Z`, end: `2027-03-${11 + i}T10:00:00Z` } }));
  const series = event("uid-once", { timezone: copy(Z_UTC), reminder: 15, recurrence: rule({ count: 10 }), exceptions: changed });
  await api.applyServerChanges(C1, [put(EVENTS, "once", series)]);
  await H("userEdit", { calendarId: C1, itemId: "uid-once", ops: [{ transp: "TRANSPARENT" }] });
  await H("countProxies", { on: true });
  let described = [];
  let proxies = null;
  try {
    described = await localChanges();
  } finally {
    proxies = await H("countProxies", { on: false });
  }
  await check("a series with changed occurrences is described without building any of them again from the series, and says the same",
    described.length === 1 && diff(described[0].previous, series) === null && itemDiff(described[0], { ...series, busy: "free" }) === null && proxies === 0,
    [proxies, described.length === 1 ? (diff(described[0].previous, series) ?? itemDiff(described[0], { ...series, busy: "free" })) : described.length]);
  for (const c of described) await api.dropLocalChange(C1, c.changeId);
  await api.applyServerChanges(C1, [remove(EVENTS, "once")]);

  // The journal: Thunderbird's storage deletes the old row, then inserts the new one, and only logs an insertion
  // that fails. A row that is not written is an error for whoever asked, never a silent loss.
  await api.applyServerChanges(C1, [put(EVENTS, "jr", event("uid-jr", { summary: "Écrit" }))]);
  await H("failJournalInserts", { calendarId: C1, on: true });
  let lost = null;
  let edit = null;
  let add = null;
  let read = null;
  try {
    lost = await api.applyServerChanges(C1, [put(EVENTS, "jr", event("uid-jr", { summary: "Jamais écrit" })), put(EVENTS, "jr2", event("uid-jr2")), detach(EVENTS, "jr"),
      { op: "lock", collectionId: EVENTS, serverId: "jr" }]);
    edit = await errorOf(() => H("userEdit", { calendarId: C1, itemId: "uid-jr", ops: [{ title: "Perdu" }] }));
    add = await errorOf(() => H("userAdd", { calendarId: C1, spec: { id: "never-journaled", start: "20271015T100000", end: "20271015T110000" } }));
    read = await errorOf(() => localChanges());
  } finally {
    await H("failJournalInserts", { calendarId: C1, on: false });
  }
  await check("a journal row that the storage does not write: every change from the server that needed it answers INTERNAL",
    same(lost, ["jr", "jr2", "jr", "jr"].map((serverId) => ({ serverId, ok: false, code: "INTERNAL" }))), lost);
  await check("… a change of the user is refused to Thunderbird (the user sees it fail) instead of being stored without its journal",
    edit !== null && add !== null && (await H("item", { calendarId: C1, itemId: "uid-jr" }))?.title === "Écrit" && (await H("item", { calendarId: C1, itemId: "never-journaled" })) === null &&
      (await H("item", { calendarId: C1, itemId: "uid-jr2" })) === null, [edit, add]);
  await check("… and what the module knows is as before: the item is still linked, nothing is to send", read === null && (await api.serverIds(C1, EVENTS)).includes("jr") &&
    !(await api.serverIds(C1, EVENTS)).includes("jr2") && same(await localChanges(), []), read);
  const healed = await api.applyServerChanges(C1, [put(EVENTS, "jr", event("uid-jr", { summary: "Écrit ensuite" }))]);
  await H("userEdit", { calendarId: C1, itemId: "uid-jr", ops: [{ location: "Ici" }] });
  let changes = await localChanges();
  await check("once the storage writes again, the same item is written and journaled as usual",
    healed[0].ok && changes.length === 1 && changes[0].serverId === "jr" && changes[0].previous?.summary === "Écrit ensuite" && changes[0].item?.location === "Ici", [healed, changes]);
  await api.dropLocalChange(C1, changes[0].changeId);
  await api.applyServerChanges(C1, [remove(EVENTS, "jr")]);

  // Every item is stored under our calendar: Thunderbird asks the calendar of an item whether to send its messages.
  const all = (lists) => lists.every((list) => Array.isArray(list) && list.length > 0 && list.every((id) => id === C1));
  const claimed = await H("userEditAs", { calendarId: C1, itemId: "uid-e2", ops: [{ location: "Ailleurs" }], foreignId: user });
  await check("modifyItem with an item on which the caller left another calendar: stored, returned and announced under our calendar", all([claimed.returned, claimed.told, claimed.stored]), claimed);
  const occurrence = await H("userEditAs", { calendarId: C1, itemId: "uid-e5", ops: [{ title: "Occurrence venue d'ailleurs" }], foreignId: user, rid: "2027-04-06T07:00:00Z" });
  await check("… also when one occurrence carries it: the series and each of its changed occurrences are ours",
    all([occurrence.returned, occurrence.told, occurrence.stored]) && occurrence.stored.length === 3, occurrence);
  changes = await localChanges();
  await check("(both are ordinary changes to send)", same(changes.map((c) => [c.op, c.serverId]), [["modify", "e2"], ["modify", "e5"]]), changes.map((c) => [c.op, c.serverId]));
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  await H("userAdd", { calendarId: user, spec: { id: "moved-series", start: "20271108T100000", end: "20271108T110000", ops: [{ title: "Série d'ailleurs" }, { rrule: "FREQ=DAILY;COUNT=4" }] } });
  await H("userEditOccurrence", { calendarId: user, itemId: "moved-series", rid: "2027-11-09T09:00:00Z", ops: [{ title: "Occurrence changée là-bas" }] });
  const movedIn = await H("copyIn", { calendarId: C1, fromId: user, itemId: "moved-series" });
  await check("an item moved in from another calendar with an occurrence it changed there: the series and that occurrence are under our calendar",
    Array.isArray(movedIn) && movedIn.length === 2 && movedIn.every((id) => id === C1), movedIn);
  changes = await localChanges();
  for (const c of changes) await api.dropLocalChange(C1, c.changeId);
  await H("userDelete", { calendarId: C1, itemId: "moved-series" });
  await H("userDelete", { calendarId: user, itemId: "moved-series" });
  await check("(cleaned up)", same(await localChanges(), []) && (await H("items", { calendarId: C1 })).length === SHAPES.length && (await H("items", { calendarId: user })).length === 1,
    [(await H("items", { calendarId: C1 })).length, (await H("items", { calendarId: user })).length]);

  // A calendar that cannot be created whole is not registered at all.
  const wanted = { mailboxId: M3, slot: "main", name: "Premier", events: true, tasks: true, organizerEmail: OWN };
  const registered = (await H("calendars")).calendars.length;
  await H("failStore", { on: true });
  const refusals = [];
  try {
    for (let n = 0; n < 3; n++) refusals.push(await errorOf(() => api.ensureCalendar(wanted)));
  } finally {
    await H("failStore", { on: false });
  }
  await check("a calendar whose store cannot be opened is refused (INTERNAL), each time, and nothing of it stays: not registered, no preference, not listed",
    refusals.every((message) => message?.startsWith("INTERNAL: ")) && (await H("calendars")).calendars.length === registered &&
      same(await H("prefs", { prefix: `calendar.registry.sync443-${M3}-` }), {}) && (await api.listCalendars()).length === 3,
    [refusals, (await H("calendars")).calendars.length, registered]);

  // A new calendar never inherits the rows of an earlier one.
  const first = await api.ensureCalendar(wanted);
  const K = first.calendarId;
  await api.applyServerChanges(K, [put("1", "k1", event("uid-k1")), put("2", "k2", task("uid-k2"))]);
  await H("userAdd", { calendarId: K, spec: { id: "k3", start: "20271020T100000", end: "20271020T110000" } });
  const left = await H("storeRows", { calendarId: K });
  const gone = await H("unsubscribe", { calendarId: K });
  const stillThere = await H("storeRows", { calendarId: K });
  const second = await api.ensureCalendar({ ...wanted, name: "Second" });
  await check("(the first free id is that of the calendar that could not be created before)", same(first, { calendarId: `sync443-${M3}-1`, created: true }), first);
  await check("a calendar that left Thunderbird's list without removeCalendar leaves its items and its journal in the store",
    gone === true && left.cal_events === 2 && left.cal_todos === 1 && left.cal_metadata === 3 && same(stillThere, left), [left, stillThere]);
  await check("… and the next calendar created under that id starts empty: no item, no ServerId, nothing to send, no row",
    same(second, { calendarId: K, created: true }) && (await H("items", { calendarId: K })).length === 0 && same(await localChanges(K), []) && same(await api.serverIds(K, "1"), []) &&
      same(await api.serverIds(K, "2"), []) && Object.values(await H("storeRows", { calendarId: K })).every((n) => n === 0),
    [second, (await H("items", { calendarId: K })).length, await H("storeRows", { calendarId: K })]);
  await check("(removed again)", (await api.removeCalendar(K)) === true && (await api.listCalendars()).length === 3);
}

// ── A calendar holds so many items and no more ──────────────────────────

async function full() {
  const made = await api.ensureCalendar({ mailboxId: M3, slot: "full", name: "Plein", events: true, tasks: false, organizerEmail: OWN });
  const F = made.calendarId;
  // Its journal is filled before the module reads it: as many items as a calendar may hold.
  await H("fillJournal", { calendarId: F, collectionId: "9", prefix: "L", count: MAX_ITEMS });
  const results = await api.applyServerChanges(F, [put("9", "one-more", event("uid-one-more")), put("9", "L7", event("uid-l7", { summary: "Déjà compté" })), put("9", "another", event("uid-another"))]);
  await check(`a calendar that holds ${MAX_ITEMS} items: a put that would add one answers LIMIT, a put for an item it holds is applied, and the batch goes on`,
    same(results, [{ serverId: "one-more", ok: false, code: "LIMIT" }, { serverId: "L7", ok: true }, { serverId: "another", ok: false, code: "LIMIT" }]) &&
      (await api.serverIds(F, "9")).length === MAX_ITEMS && (await H("items", { calendarId: F })).map((i) => i.title).join() === "Déjà compté", results);
  const room = await api.applyServerChanges(F, [remove("9", "L8"), put("9", "one-more", event("uid-one-more")), put("9", "another", event("uid-another"))]);
  await check("… one item leaves: there is room for one, not for two",
    same(room, [{ serverId: "L8", ok: true }, { serverId: "one-more", ok: true }, { serverId: "another", ok: false, code: "LIMIT" }]) && (await api.serverIds(F, "9")).length === MAX_ITEMS, room);
  const own = await H("userAdd", { calendarId: F, spec: { start: "20271021T100000", end: "20271021T110000", ops: [{ title: "Le mien" }] } });
  await check("… and what the user adds is never refused for that", (await H("item", { calendarId: F, itemId: own }))?.title === "Le mien" && (await localChanges(F)).length === 1);
  await check("(removed)", (await api.removeCalendar(F)) === true && Object.values(await H("storeRows", { calendarId: F })).every((n) => n === 0) && (await api.listCalendars()).length === 3);
}

async function scheduling(user) {
  // The same meeting in the user's own storage calendar: the control, where Thunderbird does send.
  await H("userAdd", { calendarId: user, spec: { id: "control-meeting", start: "20271110T100000", end: "20271110T110000", organizer: { id: `mailto:${OWN}`, cn: "Alice" },
    attendees: [{ id: "mailto:bob@example.com" }, { id: "mailto:carol@example.com" }], ops: [{ title: "Contrôle" }] } });
  await H("userAdd", { calendarId: user, spec: { id: "control-invitation", start: "20271111T100000", end: "20271111T110000", organizer: { id: "mailto:bob@example.com", cn: "Bob" },
    attendees: [{ id: `mailto:${OWN}` }, { id: "mailto:carol@example.com" }], ops: [{ title: "Contrôle" }] } });
  const control = await H("scheduling", { calendarId: user, itemId: "control-meeting" });
  await check("control (a storage calendar of the user, a meeting the user organizes): Thunderbird's sending path does reach a transport",
    control.transportCalls === 8 && control.checkAndSend >= 2, control);
  const answered = [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }];
  const controlReply = await H("scheduling", { calendarId: user, itemId: "control-invitation", changed: answered });
  await check("control (the same calendar, an invitation the user answers): the reply does reach a transport", controlReply.checkAndSend >= 1, controlReply);
  const organized = await H("scheduling", { calendarId: C1, itemId: "uid-e6" });
  await check("a meeting of ours that the user organizes: CalItipOutgoingMessage.send() returns without calling any transport, for every method",
    organized.transportCalls === 0 && Object.values(organized.returned).every((v) => v === true), organized);
  await check("… and adding, changing or deleting it through Thunderbird's own path (cal.itip.checkAndSend) sends nothing", organized.checkAndSend === 0, organized);
  // An invitation, answered: the reply is not sent by Thunderbird either, even with the mark that picks a mail identity.
  await H("userEdit", { calendarId: C1, itemId: "uid-e7", ops: [{ prop: "X-MOZ-INVITED-ATTENDEE", value: `mailto:${OWN}` }] });
  const invited = await H("scheduling", { calendarId: C1, itemId: "uid-e7", changed: answered });
  await check("an invitation of ours, accepted or deleted: no reply leaves through Thunderbird", invited.transportCalls === 0 && invited.checkAndSend === 0, invited);
  await check("(none of this recorded a change to send)", same(await localChanges(), []));
  await H("userDelete", { calendarId: user, itemId: "control-meeting" });
  await H("userDelete", { calendarId: user, itemId: "control-invitation" });
}

async function viewTest() {
  const answer = new Promise((resolve) => {
    browser.runtime.onMessage.addListener((message) => {
      if (message?.viewTest) resolve(message.viewTest);
    });
  });
  const tab = await browser.tabs.create({ url: `page.html?calendarId=${encodeURIComponent(C1)}` });
  const result = await Promise.race([answer, sleep(15000).then(() => null)]);
  await browser.tabs.remove(tab.id).catch(() => {});
  await check("a page of the extension that is not the background page is refused by every function (PERMISSION)",
    !!result && Object.keys(result).length === 8 && Object.values(result).every((message) => String(message).startsWith("PERMISSION: ")), result);
  await check("… and changed nothing", (await api.listCalendars()).length === 3);
}

async function limit() {
  const made = [];
  let error = null;
  for (let n = 1; n <= 48 && error === null; n++) {
    try {
      made.push((await api.ensureCalendar({ mailboxId: M2, slot: `limit-${n}`, name: `Limite ${n}`, events: true, tasks: false, organizerEmail: "bob@example.org" })).calendarId);
    } catch (e) {
      error = String(e?.message ?? e);
    }
  }
  await check("at most 50 calendars of ours: the 51st is refused (LIMIT)", made.length === 47 && error?.startsWith("LIMIT: ") && (await api.listCalendars()).length === 50, [made.length, error]);
  let removed = 0;
  for (const id of made) removed += (await api.removeCalendar(id)) === true ? 1 : 0;
  const left = await H("prefs", { prefix: `calendar.registry.sync443-${M2}-` });
  await check("removeCalendar takes them away again, preferences included",
    removed === 47 && (await api.listCalendars()).length === 3 && Object.keys(left).every((name) => name.startsWith(`calendar.registry.${C3}.`)), Object.keys(left).slice(0, 5));
}

async function leaveForRestart(user) {
  // What the second launch must find again.
  await H("userEdit", { calendarId: C1, itemId: "uid-e1", ops: [{ title: "Après le redémarrage" }] });
  await H("userDelete", { calendarId: C1, itemId: "uid-t2" });
  await H("userAdd", { calendarId: C1, spec: { id: "pending-add", start: "20271201T100000", end: "20271201T110000", ops: [{ title: "Pas encore envoyé" }] } });
  await api.applyServerChanges(C1, [put(EVENTS, "kept-copy", event("uid-kept-copy")), detach(EVENTS, "kept-copy")]);
  await api.applyServerChanges(C2, [put("5", "f2", event("uid-f2"))]);
  // A change the server crossed, and an answer Thunderbird asked to send: both marks are in the journal.
  await api.applyServerChanges(C1, [put(EVENTS, "crossed", event("uid-crossed", { summary: "Avant" })), put(EVENTS, "answered", event("uid-answered", { organizer: { email: "bob@example.com", name: "Bob" },
    attendees: [person(OWN, "Alice")], meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "not-responded", allowNewTime: true } }))]);
  // A read-only item: it must still be one for Thunderbird after the restart.
  await api.applyServerChanges(C1, [put(EVENTS, "ro-kept", event("uid-ro-kept", { readOnly: "incomplete" }))]);
  await H("userEdit", { calendarId: C1, itemId: "uid-crossed", ops: [{ location: "Ici" }] });
  await api.applyServerChanges(C1, [put(EVENTS, "crossed", event("uid-crossed", { summary: "Changé sur le serveur" }))]);
  await H("uiEdit", { calendarId: C1, itemId: "uid-answered", ops: [{ partstat: { id: `mailto:${OWN}`, value: "ACCEPTED" } }], mode: "AUTO" });
  // An item created here whose creation was read (it is on its way to the server), then deleted: the deletion
  // must follow the acknowledgement, also when Thunderbird restarts in between.
  const hasty = await H("userAdd", { calendarId: C1, spec: { id: "created-then-deleted", start: "20271202T100000", end: "20271202T110000" } });
  const creation = (await localChanges()).find((c) => c.item?.uid === hasty);
  await H("userDelete", { calendarId: C1, itemId: hasty });
  await browser.storage.local.set({ creation: creation?.changeId ?? null });
  const pending = await settledChanges();
  await check("left for the restart: a modification, a deletion and a creation to send, a change the server crossed and an answer to send",
    same(pending.map((c) => [c.op, c.serverId, c.rewritten, c.replyAsked]),
      [["modify", "e1", false, false], ["delete", "t2", false, false], ["add", null, false, false], ["modify", "crossed", true, false], ["modify", "answered", false, true]]),
    pending.map((c) => [c.op, c.serverId, c.rewritten, c.replyAsked]));
  await check("… and a creation that was read, then deleted: nothing is said of it until the server answers", typeof creation?.changeId === "string" && !pending.some((c) => c.item?.uid === hasty));
  await emit("INFO", { kept: { ours: [C1, C2, C3], foreign: [FORGED_STORAGE, FORGED_OWNER, FORGED_BARE], user } });
}

/**
 * Free/busy data of attendees: asked of the extension only for the
 * attendee window of one of our calendars, answered once, checked.
 */
async function freeBusy(user) {
  const T0 = Date.UTC(2027, 0, 11, 8, 0, 0);
  const HALF = 1_800_000;
  const asked = [];
  let reply = (r) => api.answerFreeBusy(r.requestId, [{ start: r.start, end: r.start + HALF, type: "busy" }]);
  // (Thunderbird's attendee window asks by itself for the organizer, as soon as it opens: only our question counts.)
  const own = [];
  const listener = (r) => {
    if (r.email !== "anne@example.org") {
      own.push(r);
      api.answerFreeBusy(r.requestId, []);
      return;
    }
    asked.push(r);
    reply(r);
  };
  api.onFreeBusyRequest.addListener(listener);
  const ask = (waitMs) => H("freeBusyAsk", { email: "anne@example.org", from: T0, to: T0 + 4 * HALF, waitMs });
  const types = await H("freeBusyTypes");

  let got = await ask();
  await check("free/busy: without an attendee window nothing is asked of the extension, and Thunderbird gets an answer at once", got.done && got.results.length === 0 && asked.length === 0, [got, asked]);

  await H("openAttendees", { calendarId: user });
  got = await ask();
  await check("free/busy: for a meeting of a calendar that is not ours, the address never leaves", got.done && got.results.length === 0 && asked.length === 0, [got, asked]);
  await H("closeAttendees");

  const type = await H("openAttendees", { calendarId: C1 });
  got = await ask();
  await check("free/busy: for a meeting of our calendar, the mailbox of that calendar is asked", type === "Calendar:EventDialog:Attendees" && asked.length === 1 &&
    asked[0].mailboxId === M1 && asked[0].email === "anne@example.org" && asked[0].start === T0 && asked[0].end === T0 + 4 * HALF, [type, asked]);
  await check("free/busy: the window itself asked for the organizer of that calendar, through the same mailbox", own.length >= 1 && own.every((r) => r.mailboxId === M1 && r.email === OWN), own);
  await check("free/busy: the answer reaches Thunderbird as a busy interval", got.done && same(got.results, [{ type: types.busy, start: T0, end: T0 + HALF }]), got);

  reply = (r) => api.answerFreeBusy(r.requestId, [
    { start: r.start, end: r.start + HALF, type: "tentative" }, { start: r.start + HALF, end: r.start + 2 * HALF, type: "oof" },
    { start: r.start + 2 * HALF, end: r.start + 3 * HALF, type: "unknown" },
    { start: r.start + HALF, end: r.start, type: "busy" }, { start: "x", end: 3, type: "busy" }, { start: r.start, end: r.start + HALF, type: "free" }, {},
  ]);
  got = await ask();
  await check("free/busy: each kind of interval is given as Thunderbird's own, and what is not an interval is left out",
    got.done && same(got.results.map((x) => x.type), [types.tentative, types.oof, types.unknown]), got);

  let second = null;
  reply = async (r) => {
    await api.answerFreeBusy(r.requestId, []);
    second = await api.answerFreeBusy(r.requestId, [{ start: r.start, end: r.start + HALF, type: "busy" }]);
  };
  got = await ask();
  await sleep(200);
  await check("free/busy: a request is answered once", got.done && got.results.length === 0 && second === false, [got, second]);
  await check("free/busy: an answer to a request that was never made is refused or ignored",
    (await api.answerFreeBusy("fb-999999", []).catch(() => "refused")) === false && (await api.answerFreeBusy("autre", []).then(() => "ok", () => "refused")) === "refused");

  await H("openAttendees", { calendarId: C3 });
  const before = asked.length;
  got = await ask();
  await check("free/busy: attendee windows of two mailboxes: nobody can tell which one asked, nothing is asked", got.done && got.results.length === 0 && asked.length === before, [got, asked.length - before]);
  await H("closeAttendees");

  api.onFreeBusyRequest.removeListener(listener);
  await H("openAttendees", { calendarId: C1 });
  got = await ask();
  await check("free/busy: with nobody listening Thunderbird is answered at once", got.done && got.results.length === 0, got);
  await H("closeAttendees");
}

async function phase1() {
  await emit("INFO", { probe: await H("probe") });
  Ci_CAL_IS_READONLY = (await H("probe")).readOnly;
  await startup();
  await H("createIdentity", { email: OWN });
  await argumentChecks();
  const user = await calendars();
  const flags = await H("offlineFlagProbe", { calendarId: user });
  await emit("NOTE", `Thunderbird's storage, item flagged "deleted offline" still listed in the same session: single ${flags.single}, recurring ${flags.recurring}`);
  await serverWrites();
  await roundTrip();
  await userChanges();
  await whatCannotBeDescribed();
  await detached();
  await hostile();
  await sameUid();
  await texts();
  await unsaid();
  await recurrences();
  await rewritten();
  await locked();
  await replies();
  await revisions();
  await usersItems();
  await lifeCycle(user);
  await full();
  await scheduling(user);
  await freeBusy(user);
  await viewTest();
  await limit();
  const rows = await H("storeRows", { calendarId: C1 });
  await check("the inner store holds the items and one journal row per item",
    rows.cal_events >= SHAPES.filter(([, c]) => c === EVENTS).length && rows.cal_todos === 3 && rows.cal_metadata === SHAPES.length, rows);
  await leaveForRestart(user);
}

// ── Phase 2 ─────────────────────────────────────────────────────────────

async function phase2() {
  const state = await H("calendars");
  const mine = state.calendars.filter((c) => [C1, C2, C3].includes(c.id));
  await check("after a restart with calendars: the provider type is registered again when the extension starts", state.registered === true);
  await check("… and our calendars are real calendars of that type, not disabled stand-ins",
    mine.length === 3 && mine.every((c) => c.type === "sync443" && !c.disabled && !c.forceDisabled), mine);
  await check("listCalendars: the same three calendars",
    same(await api.listCalendars(), [
      { calendarId: C3, mailboxId: M2, slot: "main", name: "Bob", events: false, tasks: true },
      { calendarId: C1, mailboxId: M1, slot: "main", name: "Alice", events: true, tasks: true },
      { calendarId: C2, mailboxId: M1, slot: "5", name: "Équipe", events: true, tasks: false },
    ]), await api.listCalendars());
  const user = state.calendars.find((c) => c.name === "Personnel")?.id;
  await check("the user's calendar and the forged ones are still there, untouched",
    !!user && (await H("items", { calendarId: user })).map((i) => i.id).join() === "user-event" && (await H("items", { calendarId: FORGED_STORAGE })).length === 1 &&
      [FORGED_OWNER, FORGED_BARE].every((id) => state.calendars.some((c) => c.id === id)), state.calendars.map((c) => c.id));

  // Asked before anything of sync443Calendar touched this calendar: a read-only item is still one.
  const keptAccess = await H("access", { calendarId: C1, itemId: "uid-ro-kept" });
  const keptRefusal = await errorOf(() => H("uiEdit", { calendarId: C1, itemId: "uid-ro-kept", ops: [{ title: "après le redémarrage" }] }));
  const keptDeletion = await errorOf(() => H("uiDelete", { calendarId: C1, itemId: "uid-ro-kept" }));
  await check("after the restart, a read-only item is still read-only for Thunderbird: it says so, and a change or a deletion through Thunderbird's editing paths is refused",
    keptAccess?.modify === false && keptAccess.dialog === "summary" && typeof keptRefusal === "string" && typeof keptDeletion === "string" &&
      (await H("item", { calendarId: C1, itemId: "uid-ro-kept" }))?.title === "uid-ro-kept", [keptAccess, keptRefusal, keptDeletion]);
  await api.applyServerChanges(C1, [remove(EVENTS, "ro-kept")]);
  // The pending changes, read from the journal: nothing is held back after a restart.
  let changes = await localChanges();
  await check("the changes left before the restart are still to send, in the order they were made",
    same(changes.map((c) => [c.op, c.serverId, c.kind, c.problem, c.detached]), [["modify", "e1", "event", null, false], ["delete", "t2", "task", null, false], ["add", null, "event", null, false],
      ["modify", "crossed", "event", null, false], ["modify", "answered", "event", null, false]]),
    changes.map((c) => [c.op, c.serverId, c.kind, c.problem, c.detached]));
  await check("… with their marks, kept in the journal: the change the server crossed says rewritten, the answer says replyAsked, the others neither",
    same(changes.map((c) => [c.rewritten, c.replyAsked]), [[false, false], [false, false], [false, false], [true, false], [false, true]]) &&
      changes[3]?.previous?.summary === "Changé sur le serveur" && changes[4]?.item?.meeting.response === "accepted", changes.map((c) => [c.rewritten, c.replyAsked]));
  for (const c of changes.splice(3)) await api.dropLocalChange(C1, c.changeId);
  await check("(both dropped: the server's version of the first is shown, the answer of the second is undone)",
    (await H("item", { calendarId: C1, itemId: "uid-crossed" }))?.title === "Changé sur le serveur" &&
      (await H("item", { calendarId: C1, itemId: "uid-answered" }))?.attendees[0]?.partstat === "NEEDS-ACTION" && (await localChanges()).length === 3);
  await api.applyServerChanges(C1, [remove(EVENTS, "crossed"), remove(EVENTS, "answered")]);
  // The item created, read, then deleted before the restart: its creation is acknowledged now.
  const { creation } = await browser.storage.local.get("creation");
  const bound = typeof creation === "string" ? await api.ackLocalChange(C1, creation, { serverId: "born-late", collectionId: EVENTS }) : null;
  const follows = (await localChanges()).filter((c) => c.serverId === "born-late");
  await check("a creation that was read, then deleted, then acknowledged after a restart: its deletion follows, for the ServerId the server gave",
    bound === false && follows.length === 1 && follows[0].op === "delete" && (await api.serverIds(C1, EVENTS)).includes("born-late"), [creation, bound, follows]);
  await check("… and is acknowledged in turn: nothing is left of the item",
    follows.length === 1 && (await api.ackLocalChange(C1, follows[0].changeId)) === true && !(await api.serverIds(C1, EVENTS)).includes("born-late") &&
      (await H("item", { calendarId: C1, itemId: "created-then-deleted" })) === null && (await localChanges()).length === 3);
  await check("… with their descriptions: previous as synchronized, the item as changed",
    diff(changes[0]?.previous, described("e1")) === null && itemDiff(changes[0], { ...described("e1"), summary: "Après le redémarrage" }) === null &&
      diff(changes[1]?.previous, described("t2")) === null && changes[2]?.item?.summary === "Pas encore envoyé",
    diff(changes[0]?.previous, described("e1")) ?? itemDiff(changes[0], { ...described("e1"), summary: "Après le redémarrage" }));
  await check("the deleted task is not in the calendar, the detached copy is, and has nothing to send",
    (await H("item", { calendarId: C1, itemId: "uid-t2" })) === null && (await H("item", { calendarId: C1, itemId: "uid-kept-copy" })) !== null && !(await api.serverIds(C1, EVENTS)).includes("kept-copy"));
  await H("userEdit", { calendarId: C1, itemId: "uid-kept-copy", ops: [{ title: "copie changée après le redémarrage" }] });
  await check("the detached copy, changed after the restart: an \"add\" marked detached",
    same((await localChanges()).slice(3).map((c) => [c.op, c.serverId, c.detached]), [["add", null, true]]), (await localChanges()).slice(3));
  await H("userDelete", { calendarId: C1, itemId: "uid-kept-copy" });
  await check("acknowledged and dropped after the restart",
    (await api.dropLocalChange(C1, changes[0].changeId)) === true && (await api.ackLocalChange(C1, changes[1].changeId)) === true &&
      (await api.ackLocalChange(C1, changes[2].changeId, { serverId: "late", collectionId: EVENTS, item: changes[2].item })) === true && same(await localChanges(), []));

  // Everything read from the database this time.
  for (const [serverId, , d, expected] of SHAPES.filter(([id]) => id !== "t2")) {
    const item = await H("item", { calendarId: C1, itemId: d.uid });
    await check(`${serverId} read from the database after the restart, field by field`, !!item && diff(item, { id: d.uid, calendarId: C1, ...expected }, true) === null,
      item ? diff(item, { id: d.uid, calendarId: C1, ...expected }, true) : "no such item");
  }
  const odd = await H("occurrences", { calendarId: C1, itemId: "uid-e12", from: "2027-01-01T00:00:00Z", to: "2027-12-31T00:00:00Z" });
  await check("e12: the zone of ours, read back from the database, still gives UTC+5:45 in winter and UTC+6:45 in summer",
    same(odd.map((o) => [o.start.local.slice(11), o.start.offset]), [...Array(3).fill(["10:00:00", 20700]), ...Array(5).fill(["10:00:00", 24300])]), odd.map((o) => [o.start.utc, o.start.offset]));
  // The same descriptions from the server: found by ServerId, nothing duplicated, nothing rewritten.
  await H("watch", { calendarId: C1 });
  const again = await api.applyServerChanges(C1, allPuts().filter((c) => c.serverId !== "t2"));
  const seen = await H("watched", { calendarId: C1 });
  await check("the same descriptions again after the restart: no duplicate, not one notification",
    again.every((r) => r.ok) && Object.values(seen).every((n) => n === 0) && (await H("items", { calendarId: C1 })).length === SHAPES.length, [seen, (await H("items", { calendarId: C1 })).length]);
  // And the round trip from the stored items. Thunderbird's storage gives each changed occurrence a copy of what
  // it took from its series: once read from the database, such an occurrence keeps the title its series had.
  const renamed = (d) => ({
    ...d,
    summary: `${d.summary} *`,
    ...(d.kind === "event" ? { exceptions: d.exceptions.map((e) => (e.deleted || "summary" in e.changes ? e : { ...e, changes: { ...e.changes, summary: d.summary } })) } : {}),
  });
  for (const [, , d] of SHAPES.filter(([id]) => id !== "t2")) await H("userEdit", { calendarId: C1, itemId: d.uid, ops: [{ title: `${d.summary} *` }] });
  changes = await settledChanges();
  for (const [serverId, , d] of SHAPES.filter(([id]) => id !== "t2")) {
    const c = changes.find((x) => x.serverId === serverId);
    await check(`${serverId}: round trip from the item read in the database`, !!c && diff(c.previous, d) === null && itemDiff(c, renamed(d)) === null,
      c ? (diff(c.previous, d) ?? itemDiff(c, renamed(d))) : "no change read");
  }
  // Left pending on purpose: removal must take pending changes away too.

  // Removal.
  const before = await H("storeRows", { calendarId: C1 });
  await check("removeCalendar → true, then false", (await api.removeCalendar(C1)) === true && (await api.removeCalendar(C1)) === false, before);
  const rows = await H("storeRows", { calendarId: C1 });
  await check("its items and its journal are deleted from the inner store", before.cal_events > 0 && before.cal_metadata > 0 && Object.values(rows).every((n) => n === 0), rows);
  await check("it is no longer registered in Thunderbird, and nothing is left of it in the preferences",
    !(await H("calendars")).calendars.some((c) => c.id === C1) && same(await H("prefs", { prefix: `calendar.registry.${C1}.` }), {}) &&
      !Object.values(await H("prefs", { prefix: "calendar.list.sortOrder" })).some((v) => String(v).split(" ").includes(C1)), await H("prefs", { prefix: `calendar.registry.${C1}.` }));
  await expectCode("a removed calendar does not exist any more", () => api.readLocalChanges(C1, {}), "NOT_FOUND");
  await check("the other calendars keep their items", (await H("items", { calendarId: C2 })).map((i) => i.id).includes("uid-f2") && (await H("items", { calendarId: C3 })).length === 1);
  await check("the same slot can be created again: a new, empty calendar under the first free number",
    same(await api.ensureCalendar({ mailboxId: M1, slot: "main", name: "Alice", events: true, tasks: true, organizerEmail: OWN }), { calendarId: C1, created: true }) &&
      (await H("items", { calendarId: C1 })).length === 0 && same(await localChanges(), []) && same(await api.serverIds(C1, EVENTS), []));
  for (const id of [C1, C2, C3]) await api.removeCalendar(id);
  const left = (await H("calendars")).calendars;
  await check("everything of ours removed: listCalendars → [], the user's and the forged calendars remain",
    same(await api.listCalendars(), []) && [user, FORGED_STORAGE, FORGED_OWNER, FORGED_BARE].every((id) => left.some((c) => c.id === id)) && !left.some((c) => [C1, C2, C3].includes(c.id)),
    left.map((c) => c.id));
  await check("the user's event is still in the user's calendar", (await H("items", { calendarId: user })).map((i) => i.title).join() === "À moi");

  // The extension stops while Thunderbird goes on. Nothing of sync443Calendar answers after this: the last checks.
  const last = await api.ensureCalendar({ mailboxId: M3, slot: "main", name: "Dernier", events: true, tasks: false, organizerEmail: OWN });
  await api.applyServerChanges(last.calendarId, [put("1", "z1", event("uid-z1", { summary: "Avant l'arrêt" }))]);
  const rowsBefore = await H("storeRows", { calendarId: last.calendarId });
  const after = await H("shutdownWhileHeld", { calendarId: last.calendarId, itemId: "uid-z1" });
  await check("the extension stops while a calendar object is still held (an open dialog, the undo list): every write through it is refused",
    after.providerRegistered === false && after.modify.startsWith("refused") && after.add.startsWith("refused") && after.remove.startsWith("refused"), after);
  await check("… what it holds can still be read, and nothing was written: the item, the rows of the store",
    after.stillRead === "Avant l'arrêt" && (await H("storedTitle", { calendarId: last.calendarId, itemId: "uid-z1" })) === "Avant l'arrêt" &&
      same(await H("storeRows", { calendarId: last.calendarId }), rowsBefore) && rowsBefore.cal_events === 1 && rowsBefore.cal_metadata === 1, [after, rowsBefore]);
  await expectCode("after that, sync443Calendar itself answers nothing more", () => api.listCalendars(), "UNSUPPORTED");
}

async function run() {
  const phase = await T.phase();
  try {
    if (phase === 1) await phase1();
    else await phase2();
  } catch (e) {
    await emit("CRASH", { phase, error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
  await emit("DONE", { phase, failures });
  await T.quit();
}

run().catch(async (e) => {
  await emit("CRASH", { error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  await T.quit();
});
