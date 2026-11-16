// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * TEST ONLY: the end-to-end scenario of the calendar, the tasks and the
 * meetings, packaged by run_calendar_sync_test.py into a TEST build of the
 * extension (never into a release build). test-scenario.mjs hands a phase
 * over to runCalendarPhase() when the packaged configuration says
 * `e2e.suite: "calendar"`, with its own helpers (check, rpc, waitFor…).
 *
 * Who does what:
 *  - the server side is the mock ActiveSync server (mock_eas.py), driven
 *    through the runner (rpc, mock);
 *  - the settings are changed as the settings page changes them
 *    (ctx.saveMailbox, ctx.removeMailbox, ctx.runSync), or through the real
 *    page when the step is about what it shows (held deletions);
 *  - the user's actions in the calendar go through Thunderbird's own
 *    calendar interfaces, never through browser.sync443Calendar (the
 *    extension's own channel): the privileged test helper
 *    sync443CalendarTest finds the calendars in cal.manager and commits the
 *    transactions Thunderbird's event dialog and views commit (addItem,
 *    modifyItem, deleteItem, then Thunderbird's own scheduling step), or
 *    runs Thunderbird's iTIP processing as the invitation bar of a message
 *    does;
 *  - a meeting question is read through the test hook (ctx.meetings) and
 *    through the real confirmation window, and answered by that window's
 *    own buttons, by closing it, by letting it expire, or by the hook.
 *
 * Two launches of Thunderbird on the same throw-away profile:
 *   1. three mailboxes (A: mail, calendar and tasks, immediate delivery;
 *      B: calendar and tasks only, on the same server; C: on a server that
 *      only speaks ActiveSync 12.1) and a calendar of the user's own, then
 *      the steps below;
 *   2. after a restart: calendars and items still there and usable, the
 *      change made just before quitting sent, the unanswered question asked
 *      again; then removal of A.
 *
 * Steps (run_calendar_sync_test.py --steps=…; the setup always runs):
 *   1  server to Thunderbird          6  settings (period, filter, kinds)
 *   2  Thunderbird to server          7  mass deletion held
 *   3  read-only items                8  restart
 *   4  invitations received           9  removal of a mailbox, other calendars
 *   5  meetings organized
 * What must hold all along is checked at the end of each phase: nothing
 * handed to a mail transport of Thunderbird nor to its SMTP code, nothing
 * of one mailbox in another one's calendars, the user's own calendar
 * untouched, and no personal content in the extension's log (read every
 * second, at debug level unless the runner is told otherwise).
 */

const H = (name, args) => browser.sync443CalendarTest.run(name, args ?? {});
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const PARIS = "Europe/Paris";

// From test-scenario.mjs (runCalendarPhase).
let ctx = null;
let E = null;
let T = null;
let check = null;
let info = null;
let gap = null;
let step = null;
let guard = null;
let rpc = null;
let mock = null;
let waitFor = null;
let errorOf = null;
let sleep = null;
let health = null;
let idle = null;
let input = null;
let mailboxById = null;

let steps = null; // the steps to run (null: all), from the phase file
const want = (n) => !steps || steps.includes(n);
let BASE = 0; // a Monday at 00:00 UTC, three weeks ahead at least: every date of the scenario is counted from it
const at = (day, hour = 0, minute = 0) => BASE + day * DAY + hour * HOUR + minute * MINUTE;

// Titles. Everything personal the scenario writes starts with "E2E " or lives in example.test: the log is searched for it
// (with the space: "E2E" alone is found in the hexadecimal of a SyncKey now and then).
const S = Object.freeze({
  timed: "E2E agenda chronométré",
  timedChanged: "E2E agenda chronométré modifié sur le serveur",
  allDay: "E2E agenda journée entière",
  zoned: "E2E agenda New York",
  serverMeeting: "E2E agenda réunion venue du serveur",
  serverMeetingChanged: "E2E agenda réunion déplacée par le serveur",
  series: "E2E agenda série",
  seriesChanged: "E2E agenda série, occurrence déplacée",
  readOnlyEvent: "E2E agenda calendrier hébraïque",
  pushed: "E2E agenda arrivé par push",
  secondary: "E2E agenda du second dossier",
  task: "E2E tâche simple",
  taskDone: "E2E tâche terminée",
  taskDue: "E2E tâche à échéance",
  taskRegen: "E2E tâche qui se régénère",
  secondaryTask: "E2E tâche du second dossier",
  bobEvent: "E2E agenda de Bob",
  bobTask: "E2E tâche de Bob",
  bobLocal: "E2E agenda créé par Bob",
  carolEvent: "E2E agenda de Carol",
  userEvent: "E2E personnel rendez-vous",
  userMeeting: "E2E personnel réunion",
  userControl: "E2E personnel témoin d'envoi",
  localEvent: "E2E agenda créé ici",
  localEventChanged: "E2E agenda créé ici puis modifié",
  localKept: "E2E agenda créé ici et gardé",
  localSecondary: "E2E agenda créé dans le second dossier",
  localTask: "E2E tâche créée ici",
  localTaskChanged: "E2E tâche créée ici puis modifiée",
  localSecondaryTask: "E2E tâche créée dans le second dossier",
  localSeries: "E2E agenda série créée ici",
  localSeriesChanged: "E2E agenda série créée ici, occurrence modifiée",
  refused: "E2E agenda titre refusé par le serveur",
  conflictLocal: "E2E agenda titre d'ici, en conflit",
  conflictServer: "E2E agenda titre du serveur, en conflit",
  pastSoft: "E2E agenda qui sort de la période",
  roEdit: "E2E agenda modifié malgré tout",
  inv1: "E2E invitation acceptée puis refusée",
  inv2: "E2E invitation absente de l'agenda",
  inv3: "E2E invitation dont la réponse échoue",
  inv4: "E2E invitation en 12.1",
  inv5: "E2E invitation de Bob",
  inv6: "E2E invitation supprimée de l'agenda",
  inv7: "E2E invitation déléguée",
  inv8: "E2E invitation en 12.1 sans courrier",
  invShared: "E2E invitation commune à deux boîtes",
  invOther: "E2E invitation acceptée dans le second agenda",
  invSilent: "E2E invitation acceptée sans envoyer de réponse",
  invDirect: "E2E invitation dont le statut change sans Thunderbird",
  invForged: "E2E invitation doublée d'un faux message",
  invRewritten: "E2E invitation réécrite par le serveur avant la réponse",
  day31: "E2E agenda le 31 tous les douze mois",
  tooLong: "E2E agenda plus long que sa période",
  joiners: "E2E agenda aux liants",
  invisible: "E2E agenda au caractère invisible",
  meetingEmptied: "E2E réunion vidée de ses participants",
  softMass: "E2E masse sortie de période",
  carolBis: "E2E agenda de l'autre identifiant",
  meeting: "E2E réunion organisée",
  meetingNoSend: "E2E réunion sans envoi",
  meetingCrowd: "E2E réunion de 101 participants",
  meetingRestart: "E2E réunion posée avant de quitter",
  past10: "E2E agenda d'il y a 10 jours",
  past60: "E2E agenda d'il y a 60 jours",
  past400: "E2E agenda d'il y a 400 jours",
  mass: "E2E masse confirmée",
  mass2: "E2E masse refusée",
  restartEvent: "E2E agenda avant redémarrage",
  restartEdited: "E2E agenda modifié juste avant de quitter",
  afterRestart: "E2E agenda créé après redémarrage",
  serverAfterRestart: "E2E agenda du serveur après redémarrage",
});
const WHERE = Object.freeze({ alpha: "Salle Alpha E2E", beta: "Salle Beta E2E", gamma: "Salle Gamma E2E" });
const NOTES = Object.freeze({ timed: "Description confidentielle E2E", local: "Notes confidentielles E2E", task: "Notes de tâche E2E" });
const PEOPLE = Object.freeze({
  olivia: { email: "olivia@example.test", name: "Olivia Organisatrice" },
  dave: { email: "dave@example.test", name: "Dave Externe" },
  frank: { email: "frank@example.test", name: "Frank Externe" },
  me: { email: "moi@example.test", name: "Moi" },
  guest: { email: "invite-prive@example.test", name: "Invité Privé" },
});
const FOLDERS = Object.freeze({ calendar: "Agenda perso", tasks: "Taches perso", mass: "Masse agenda", mass2: "Masse agenda bis", mass3: "Masse agenda ter" });
const USER_CALENDAR = "Personnel E2E";
// What the extension's log must never show (rule 13): titles, addresses, names, places, notes, folder and calendar names.
const NEEDLES = Object.freeze(["E2E ", "example.test", "Alice", "Bob", "Carol", "Olivia", "Dave", "Frank", "Invité", "Salle", "onfidentiel", ...Object.values(FOLDERS), "Personnel"]);

// Windows time-zone rules, as the mock takes them (make_timezone).
const zone = (bias, standard, daylight) => ({
  bias,
  standard: { bias: 0, change: standard ? { month: standard[0], week: standard[1], weekday: standard[2], hour: standard[3], minute: 0 } : null },
  daylight: { bias: daylight ? -60 : 0, change: daylight ? { month: daylight[0], week: daylight[1], weekday: daylight[2], hour: daylight[3], minute: 0 } : null },
});
const Z_PARIS = zone(-60, [10, 5, 0, 3], [3, 5, 0, 2]);
const Z_NEW_YORK = zone(300, [11, 1, 0, 2], [3, 2, 0, 2]);

// ── Dates ─────────────────────────────────────────────────────────────────

const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Minutes east of UTC of a zone at an instant, from the JavaScript engine's own zone data. */
function offsetAt(tz, ms) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000) / MINUTE);
}
/** "YYYY-MM-DDTHH:MM:SS", the wall clock of a zone at an instant. */
const localOf = (tz, ms) => new Date(ms + offsetAt(tz, ms) * MINUTE).toISOString().slice(0, 19);
/** "YYYYMMDDTHHMMSS", as the helper takes a local time. */
const compact = (tz, ms) => localOf(tz, ms).replace(/[-:]/g, "");
/** The instant a day begins in a zone (the day being given by its UTC midnight). */
const midnightIn = (tz, dayMs) => dayMs - offsetAt(tz, dayMs) * MINUTE;

function baseMonday() {
  const now = new Date();
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 21 * DAY;
  while (new Date(t).getUTCDay() !== 1) t += DAY;
  return t;
}

// ── Mock server ───────────────────────────────────────────────────────────

const seqNow = (server = "main") => mock("last_seq", [], {}, server);
const srvEvents = (login, subject, server = "main") => mock("find_events", [login], { subject }, server);
const srvTasks = (login, subject, server = "main") => mock("find_tasks", [login], { subject }, server);
const allEvents = (login, folder, server = "main") => mock("events", [login, folder], {}, server);
const allTasks = (login, folder, server = "main") => mock("tasks", [login, folder], {}, server);
const partsSince = (seq, login, server = "main") => mock("sent_calendar_parts", [login], { since: seq }, server);
const responsesSince = (seq, login, server = "main") => mock("meeting_responses", [login], { since: seq }, server);
const actionsSince = (seq, login, kinds, server = "main") => rpc("actions", { since: seq, login, kinds, server });
const sendMailsSince = async (seq, login, server = "main") => (await rpc("requests", { since: seq, login, server })).filter((r) => r.cmd === "SendMail");
const UPLOADS = ["sync_add", "sync_change", "sync_delete"];

/** The calendar and task folders of a user on the server: { calendar, tasks, byName: Map<name, ServerId>, ids } */
async function pimFolders(login, server = "main") {
  const list = await rpc("folders", { login, server });
  const pim = list.filter((f) => [7, 8, 13, 15].includes(f.type));
  return {
    calendar: pim.find((f) => f.type === 8)?.server_id ?? null,
    tasks: pim.find((f) => f.type === 7)?.server_id ?? null,
    byName: new Map(pim.map((f) => [f.name, f.server_id])),
    ids: pim.map((f) => f.server_id),
    events: pim.filter((f) => f.type === 8 || f.type === 13).map((f) => f.server_id),
    taskIds: pim.filter((f) => f.type === 7 || f.type === 15).map((f) => f.server_id),
    mail: list.filter((f) => ![7, 8, 9, 10, 11, 13, 14, 15, 16, 17].includes(f.type)).map((f) => f.server_id),
  };
}

/** Every event and task of a user on the server, as [folder, ServerId, version] sorted: what must not change. */
async function serverState(login, server = "main") {
  const folders = await pimFolders(login, server);
  const out = [];
  for (const id of folders.events) for (const e of await allEvents(login, id, server)) out.push([id, e.server_id, e.version]);
  for (const id of folders.taskIds) for (const t of await allTasks(login, id, server)) out.push([id, t.server_id, t.version]);
  return out.sort((a, b) => (a.join("/") < b.join("/") ? -1 : 1));
}

// ── Thunderbird's calendars ───────────────────────────────────────────────

/** The calendars of a mailbox, as Thunderbird's calendar manager lists them. */
async function calendarsOf(mb) {
  return (await H("calendars")).calendars.filter((c) => c.id.startsWith(`sync443-${mb.id}-`));
}
const named = (list, name) => list.find((c) => c.name === name) ?? null;
const itemsOf = (calendarId) => H("items", { calendarId });
const titled = (items, title) => (items ?? []).filter((i) => i.title === title);
async function localOne(calendarId, title) {
  const found = titled(await itemsOf(calendarId), title);
  return found.length === 1 ? found[0] : null;
}
const localCount = async (calendarId, title) => titled(await itemsOf(calendarId), title).length;
/** Titles of a calendar, sorted (with repetitions): what a settings change must give back unchanged. */
const titlesOf = async (calendarId) => (await itemsOf(calendarId)).map((i) => `${i.kind}:${i.title}`).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Two { key: value } tables hold the same, whatever the order of their keys. */
const sameTable = (a, b) => same(Object.entries(a ?? {}).sort(), Object.entries(b ?? {}).sort());
const lower = (s) => String(s ?? "").toLowerCase();
const mailto = (email) => `mailto:${email}`;
/** The id Thunderbird has for an attendee of this address on an item. */
const attendeeId = (item, email) => item?.attendees.find((a) => lower(a.id) === lower(mailto(email)))?.id ?? null;
const partstatOf = (item, email) => item?.attendees.find((a) => lower(a.id) === lower(mailto(email)))?.partstat ?? null;

/** The ServerIds the extension holds for a collection of a calendar (read only: what is bound to the server). */
async function boundIds(mb, calendarId, collectionId) {
  return ctx.entries.get(mb.id).calendar.calendarStore.serverIds(calendarId, collectionId);
}

// ── Passes ────────────────────────────────────────────────────────────────

/** "Synchronize" of the settings page, and the end of the passes it starts. */
async function syncNow(mb, timeout = 180_000) {
  const since = Date.now();
  ctx.runSync(mb.id, { reason: "user" });
  return idle(mb.id, since, timeout);
}

/** Two more passes: what would be sent twice, or come back twice, has had its chance. */
async function twoPasses(mb) {
  await syncNow(mb);
  await syncNow(mb);
}

const sending = (mb) => ctx.entries.get(mb.id)?.sync.delivering === true;
const question = (timeout = 45_000) => waitFor(() => ctx.meetings.current(), { timeout, interval: 150 });
/** No question open or waiting, and no delivery going on. */
const quiet = (mb, timeout = 60_000) => waitFor(() => !ctx.meetings.current() && !ctx.meetings.waiting().length && !sending(mb), { timeout, interval: 150 });
const asked = (q) => (q ? { mailboxId: q.mailboxId, kind: q.kind, summary: q.summary, start: q.start, allDay: q.allDay, recipients: q.recipients } : null);
/** Messages sent through SendMail since `seq`, as written: [{ seq, to (the header itself), text (the plain-text part) }]. */
const sentRaw = (seq, login, server = "main") => rpc("sent_raw", { since: seq, login, server });
/** The extension's three-second timer of a mailbox, disarmed once the extension has armed it for a change just made. */
async function holdTimer(mb, before) {
  const entry = ctx.entries.get(mb.id);
  const armed = await waitFor(() => entry.timer !== before, { timeout: 2500, interval: 20 });
  clearTimeout(entry.timer);
  return Boolean(armed);
}

/** The window of the open question, once its page shows it: its document's own window. */
function confirmView(q, timeout = 15_000) {
  return waitFor(
    () => {
      const view = browser.extension.getViews().find((w) => {
        try {
          return w.location.href === q.url;
        } catch {
          return false;
        }
      });
      const pane = view?.document.getElementById("ask");
      return pane && !pane.hidden ? view : null;
    },
    { timeout, interval: 150 },
  );
}

const shownBy = (view) => ({
  question: view.document.getElementById("question").textContent,
  summary: view.document.getElementById("summary").textContent,
  when: view.document.getElementById("when").textContent,
  count: view.document.getElementById("count").textContent,
  recipients: [...view.document.querySelectorAll("#recipients li")].map((li) => li.textContent),
});

/** The browser window that shows a page of ours (the confirmation window of a question). */
async function windowOf(url) {
  for (const w of await browser.windows.getAll({ populate: true })) if ((w.tabs ?? []).some((t) => t.url === url)) return w;
  return null;
}

// ── Notifications ─────────────────────────────────────────────────────────

const notices = []; // what the extension showed the user: { at, message }
let noticesSeen = false;

/** The extension's notifications are recorded on their way to Thunderbird (and still shown). */
function watchNotifications() {
  const api = browser.notifications;
  const original = api.create;
  try {
    api.create = function (...args) {
      const options = args.length > 1 ? args[1] : args[0];
      notices.push({ at: Date.now(), message: String(options?.message ?? "") });
      return original.apply(api, args);
    };
    noticesSeen = api.create !== original;
  } catch {
    noticesSeen = false;
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A notification made from the catalogue's message `key` for this title,
 * shown since `since`: its other placeholders may hold anything.
 */
function noticed(key, title, since, timeout = 30_000) {
  const [a, b, c] = ["<<1>>", "<<2>>", "<<3>>"];
  const pattern = new RegExp(`^${escapeRegExp(browser.i18n.getMessage(key, [a, b, c])).replace(a, escapeRegExp(title)).replace(b, ".*").replace(c, ".*")}$`, "s");
  return waitFor(() => notices.find((n) => n.at >= since && pattern.test(n.message)) ?? null, { timeout, interval: 200 });
}

// ── The log, read all along ───────────────────────────────────────────────

const leaks = new Map(); // needle → where it was seen
const logSeen = new Set();
let logTimer = null;

function scanLog() {
  try {
    for (const e of ctx.log.getLog()) {
      const key = `${e.t}|${e.level}|${e.msg}|${(e.details ?? "").length}`;
      if (logSeen.has(key)) continue;
      logSeen.add(key);
      const text = `${e.msg}\n${e.details ?? ""}`;
      for (const needle of NEEDLES) {
        const i = text.indexOf(needle);
        if (i >= 0 && !leaks.has(needle)) leaks.set(needle, text.slice(Math.max(0, i - 100), i + 100));
      }
    }
  } catch {
    // read again a second later
  }
}

// ── iCalendar, as sent ────────────────────────────────────────────────────

const icsLines = (text) => String(text ?? "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
const icsLine = (lines, name) => lines.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`)) ?? null;
const icsAll = (lines, name) => lines.filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
const icsAddress = (line) => lower(/mailto:([^\s;]+)$/i.exec(line ?? "")?.[1] ?? "");

/** DTSTART of a message is this instant: in UTC, or as the wall clock of the event's zone (Paris here). */
function startIs(lines, ms) {
  const line = icsLine(lines, "DTSTART") ?? "";
  const value = line.slice(line.lastIndexOf(":") + 1);
  return value.endsWith("Z") ? value === `${iso(ms).replace(/[-:]/g, "").slice(0, 15)}Z` : value === compact(PARIS, ms);
}

/** What one message sent through SendMail says: { to, method, lines (of its VEVENT), uid, sequence, organizer, attendees }. */
function described(part) {
  const all = icsLines(part?.parts?.[0]?.text);
  // The event itself: a VTIMEZONE before it has DTSTART lines of its own.
  const lines = all.slice(Math.max(0, all.indexOf("BEGIN:VEVENT")));
  return {
    to: [...(part?.to ?? [])].map(lower).sort(),
    others: [...(part?.cc ?? []), ...(part?.bcc ?? [])],
    sender: lower(/<([^<>]+)>\s*$/.exec(part?.sender ?? "")?.[1] ?? part?.sender),
    subject: part?.subject ?? null,
    count: part?.parts?.length ?? 0,
    method: part?.parts?.[0]?.method ?? null,
    inside: (icsLine(all, "METHOD") ?? "").slice(7),
    events: all.filter((l) => l === "BEGIN:VEVENT").length,
    uid: (icsLine(lines, "UID") ?? "").slice(4),
    sequence: Number((icsLine(lines, "SEQUENCE") ?? "SEQUENCE:-1").slice(9)),
    organizer: icsAddress(icsLine(lines, "ORGANIZER")),
    attendees: icsAll(lines, "ATTENDEE").map(icsAddress).sort(),
    partstats: icsAll(lines, "ATTENDEE").map((l) => /PARTSTAT=([A-Z-]+)/.exec(l)?.[1] ?? null),
    lines,
  };
}

const sorted = (list) => [...list].map(lower).sort();

// ── Mailboxes ─────────────────────────────────────────────────────────────

async function mailboxes() {
  const list = await ctx.store.listMailboxes();
  const of = (who) => list.find((m) => m.email === who.login) ?? null;
  return { A: of(E.alice), B: of(E.bob), C: of(E.carol) };
}

/** A mailbox as the settings form holds it: its server as typed (host and port of its origin). */
const viewOf = (mb) => ({ ...mb, server: mb.origin.replace(/^https:\/\//, "") });

/** The mailbox saved again as the settings page saves it (password not typed again), then its passes over. */
async function saveAgain(mb, overrides) {
  const since = Date.now();
  const err = await errorOf(() => ctx.saveMailbox(input(viewOf(mb), { calendarPeriod: mb.calendarPeriod, taskFilter: mb.taskFilter, ...overrides }), null));
  const h = await idle(mb.id, since, 180_000);
  return { err, saved: await mailboxById(mb.id), health: h, ok: !err && Boolean(h) && !h.blocked };
}

// ── What must hold all along ──────────────────────────────────────────────

let userCalendar = null; // { id, items } of the user's own calendar, as first made

async function userSnapshot(id) {
  return (await itemsOf(id)).map((i) => ({ id: i.id, title: i.title, start: i.start?.utc ?? i.start?.local, organizer: i.organizer?.id ?? null, attendees: i.attendees.map((a) => a.id).sort() }));
}

/** Nothing of a mailbox in another one's calendars: every item of each calendar set is one that mailbox's server holds. */
async function checkSeparation(when) {
  const boxes = await mailboxes();
  const sets = [];
  for (const [name, mb, who, server] of [["A", boxes.A, E.alice, "main"], ["B", boxes.B, E.bob, "main"], ["C", boxes.C, E.carol, "old"]]) {
    if (!mb) continue;
    const titles = new Set();
    for (const c of await calendarsOf(mb)) for (const i of await itemsOf(c.id)) titles.add(i.title);
    const folders = await pimFolders(who.login, server);
    const own = new Set();
    for (const id of folders.events) for (const e of await allEvents(who.login, id, server)) own.add(e.subject);
    for (const id of folders.taskIds) for (const t of await allTasks(who.login, id, server)) own.add(t.subject);
    sets.push({ name, titles, own });
  }
  for (const a of sets) {
    for (const b of sets) {
      if (a === b) continue;
      // What only the other mailbox's server holds, found in this one's calendars.
      const strays = [...a.titles].filter((t) => b.own.has(t) && !a.own.has(t));
      await check(`rien de ${b.name} dans les agendas de ${a.name} (${when})`, !strays.length, strays);
    }
  }
}

async function endOfPhase(phase) {
  await step(`Fin de la phase ${phase} : ce qui doit tenir tout du long`);
  await checkSeparation(`fin de la phase ${phase}`);

  // The user's own calendar.
  if (userCalendar) {
    const now = await userSnapshot(userCalendar.id);
    await check("l'agenda personnel de l'utilisateur (type storage, hors Sync443) n'a pas été touché : mêmes éléments, mêmes participants", same(now, userCalendar.items), { now, before: userCalendar.items });
    const hits = await rpc("leaks", { needles: [S.userEvent, S.userMeeting, S.userControl, PEOPLE.guest.email, PEOPLE.me.email, "E2E personnel"] });
    await check("… et rien de lui n'est jamais parvenu à aucun serveur (ni élément synchronisé, ni message envoyé, ni requête)", hits.length === 0, hits.slice(0, 5));
  }

  // Nothing through SMTP, nor through any mail transport of Thunderbird's scheduling code.
  const seen = await H("sendingSeen");
  await info(`sendingSeen${phase}`, seen);
  const ours = seen.transports.filter((t) => String(t.calendarId ?? "").startsWith("sync443-") || t.transport === "calendar");
  const control = seen.transports.filter((t) => t.calendarId === userCalendar?.id);
  await check("le code de planification de Thunderbird n'a rien remis à un transport de courrier pour un agenda de Sync443 (ni invitation, ni réponse, ni annulation)", seen.watching && ours.length === 0, ours);
  await check(
    "… tous ses appels à un transport viennent de l'agenda personnel témoin (preuve que le guet voit ce que Thunderbird voudrait envoyer)",
    seen.transports.length === control.length,
    seen.transports.filter((t) => t.calendarId !== userCalendar?.id),
  );
  await check("aucune connexion SMTP tentée par Thunderbird de toute la phase (SmtpClient.connect), aucun envoi demandé à un serveur sortant (SmtpServer.sendMailMessage)", seen.smtp.watched.length === 2 && seen.smtp.connects === 0 && seen.smtp.sends === 0, seen.smtp);
  const unsent = await H("unsentMessages");
  await check("rien dans la file d'envoi de Thunderbird (Messages en attente), dans aucun compte", unsent.queued === 0, unsent);
  const outgoing = (await T.outgoing()).servers;
  const real = outgoing.filter((s) => !(s.owner === browser.runtime.id && !s.username && (s.hostname === "sync443.invalid" || (s.hostname === "127.0.0.1" && s.port === 1))));
  await check("les seuls serveurs sortants du profil sont les serveurs neutres de Sync443 (aucun SMTP utilisable)", real.length === 0, real);

  // The log.
  scanLog();
  if (logTimer !== null) clearInterval(logTimer);
  await info(`logLinesRead${phase}`, logSeen.size);
  await check(
    `journal de l'extension (${E.debugLog ? "niveau débogage" : "niveau habituel"}, lu chaque seconde) : jamais un titre, une adresse, un nom, un lieu, une description ni un nom de dossier`,
    logSeen.size > 0 && leaks.size === 0,
    { lines: logSeen.size, leaks: [...leaks] },
  );
  await check("les notifications de l'extension ont pu être observées (pour les contrôles qui en dépendent)", noticesSeen);
}

// ── Setup: the server's content, the user's own calendar, the mailboxes ───

const SERIES_START = () => at(0, 10, 30);

async function serverFixture() {
  const a = E.alice.login;
  const b = E.bob.login;
  const c = E.carol.login;
  await mock("add_event", [a, 8], { subject: S.timed, start: iso(at(0, 9)), end: iso(at(0, 10)), location: WHERE.alpha, body: NOTES.timed, reminder: 15, categories: ["Travail"], busy_status: 2 });
  const day = at(1);
  await mock("add_event", [a, 8], { subject: S.allDay, all_day: true, timezone: Z_PARIS, start: iso(midnightIn(PARIS, day)), end: iso(midnightIn(PARIS, day + DAY)), busy_status: 0 });
  await mock("add_event", [a, 8], { subject: S.zoned, timezone: Z_NEW_YORK, start: iso(at(2, 15)), end: iso(at(2, 16)) });
  await mock("add_event", [a, 8], {
    subject: S.serverMeeting,
    start: iso(at(3, 9)),
    end: iso(at(3, 10)),
    organizer_email: a,
    organizer_name: "Alice Test",
    attendees: [{ email: b, name: "Bob Test", type: 1 }, { email: PEOPLE.dave.email, name: PEOPLE.dave.name, type: 2 }],
  });
  const start = SERIES_START();
  await mock("add_event", [a, 8], {
    subject: S.series,
    start: iso(start),
    end: iso(start + 30 * MINUTE),
    recurrence: { type: 1, interval: 1, occurrences: 5, day_of_week: 2 },
    exceptions: [
      { exception_start: iso(start + 7 * DAY), subject: S.seriesChanged, start: iso(start + 7 * DAY + 2 * HOUR), end: iso(start + 7 * DAY + 2 * HOUR + 30 * MINUTE) },
      { exception_start: iso(start + 14 * DAY), deleted: true },
    ],
  });
  const hebrew = new Date(at(4));
  await mock("add_event", [a, 8], {
    subject: S.readOnlyEvent,
    start: iso(at(4, 10)),
    end: iso(at(4, 11)),
    recurrence: { type: 5, interval: 1, day_of_month: hebrew.getUTCDate(), month_of_year: hebrew.getUTCMonth() + 1, calendar_type: 8 },
  });
  await mock("add_task", [a, 7], { subject: S.task, body: NOTES.task });
  await mock("add_task", [a, 7], { subject: S.taskDone, complete: true, date_completed: iso(Date.now() - DAY) });
  await mock("add_task", [a, 7], { subject: S.taskDue, start_date: iso(at(0)), utc_start_date: iso(at(0)), due_date: iso(at(2)), utc_due_date: iso(at(2)), importance: 2 });
  await mock("add_task", [a, 7], { subject: S.taskRegen, recurrence: { type: 0, start: iso(at(0)), interval: 1, regenerate: 1 } });
  const second = await mock("add_folder", [a, FOLDERS.calendar], { type_: 13 });
  await mock("add_event", [a, second], { subject: S.secondary, start: iso(at(5, 9)), end: iso(at(5, 10)) });
  const secondTasks = await mock("add_folder", [a, FOLDERS.tasks], { type_: 15 });
  await mock("add_task", [a, secondTasks], { subject: S.secondaryTask });
  await mock("add_event", [b, 8], { subject: S.bobEvent, start: iso(at(0, 9)), end: iso(at(0, 10)) });
  await mock("add_task", [b, 7], { subject: S.bobTask });
  await mock("add_event", [c, 8], { subject: S.carolEvent, start: iso(at(0, 9)), end: iso(at(0, 10)) }, "old");
}

async function setup() {
  await step("0. Mise en place : serveur, agenda personnel, boîtes A, B et C");
  const fp = await T.trustAuthority(E.caBase64);
  await check("autorité du faux serveur ajoutée au profil jetable", String(fp).replace(/:/g, "") === E.caSha256, fp);
  const probe = await H("probe");
  await info("calendarProbe", probe);
  await check("fuseau par défaut de Thunderbird fixé pour le test (Europe/Paris)", probe.defaultZone === PARIS, probe);
  await serverFixture();

  // A calendar of the user's own, of Thunderbird's storage type, made before any mailbox exists.
  const id = await H("createUserCalendar", { name: USER_CALENDAR });
  await H("userAdd", { calendarId: id, spec: { id: "user-event", start: compact(PARIS, at(0, 12)), end: compact(PARIS, at(0, 13)), tzid: PARIS, ops: [{ title: S.userEvent }] } });
  await H("userAdd", {
    calendarId: id,
    spec: {
      id: "user-meeting",
      start: compact(PARIS, at(1, 12)),
      end: compact(PARIS, at(1, 13)),
      tzid: PARIS,
      organizer: { id: mailto(PEOPLE.me.email), cn: PEOPLE.me.name },
      attendees: [{ id: mailto(PEOPLE.guest.email), cn: PEOPLE.guest.name }],
      ops: [{ title: S.userMeeting }],
    },
  });
  userCalendar = { id, items: await userSnapshot(id) };
  await check("agenda personnel de l'utilisateur créé (type storage), avec un rendez-vous et une réunion à participants", userCalendar.items.length === 2 && userCalendar.items[1].attendees.length === 1, userCalendar.items);

  const t0 = Date.now();
  const save = async (who, name, server, sync, syncMinutes) => {
    const res = await ctx.saveMailbox(input(null, { email: who.login, name, server, syncMinutes, sync }), who.password);
    return mailboxById(res.id);
  };
  const A = await save(E.alice, "Alice (A)", `127.0.0.1:${E.port}`, { mail: true, calendar: true, contacts: false, tasks: true }, 0);
  await T.grantOrigin("https://localhost/*");
  const B = await save(E.bob, "Bob (B)", `localhost:${E.port}`, { mail: false, calendar: true, contacts: false, tasks: true }, 5);
  const C = await save(E.carol, "Carol (C)", `127.0.0.1:${E.oldPort}`, { mail: true, calendar: true, contacts: false, tasks: false }, 5);
  await check("boîte A ajoutée (courrier + agenda + tâches, dès réception)", A?.sync.mail && A.sync.calendar && A.sync.tasks && A.syncMinutes === 0, A?.sync);
  await check("boîte B ajoutée, courrier décoché (agenda + tâches seulement)", B && !B.sync.mail && B.sync.calendar && B.sync.tasks, B?.sync);
  await check("boîte C ajoutée, sur le serveur qui ne parle qu'ActiveSync 12.1 (courrier + agenda)", C?.sync.mail && C.sync.calendar && !C.sync.tasks, C?.sync);
  await check("réglages par défaut : agenda sur 6 mois (« 7 »), toutes les tâches (« 0 »)", A?.calendarPeriod === "7" && A.taskFilter === "0", { calendarPeriod: A?.calendarPeriod, taskFilter: A?.taskFilter });
  const done = [await idle(A.id, t0), await idle(B.id, t0), await idle(C.id, t0)];
  await check("première synchronisation des trois boîtes terminée sans erreur", done.every((h) => h && !h.blocked && !h.lastError), done);
  const versions = {};
  for (const [name, mb] of [["A", A], ["B", B], ["C", C]]) versions[name] = (await ctx.store.mailbox(mb.id).get("proto", null))?.asVersion ?? null;
  await check("versions négociées : 14.1 pour A et B, 12.1 pour C", versions.A === "14.1" && versions.B === "14.1" && versions.C === "12.1", versions);
  await info("mailboxes", { A: { id: A.id, deviceId: A.deviceId, origin: A.origin }, B: { id: B.id, deviceId: B.deviceId, origin: B.origin }, C: { id: C.id, deviceId: C.deviceId, origin: C.origin } });
  return { A, B, C };
}

/** The calendars of A by their role. */
async function calendarsA(A) {
  const list = await calendarsOf(A);
  return { list, main: named(list, A.name), second: named(list, FOLDERS.calendar), secondTasks: named(list, FOLDERS.tasks) };
}

// ── 1. Server to Thunderbird ──────────────────────────────────────────────

async function serverToThunderbird({ A, B, C }) {
  await step("1. Du serveur vers Thunderbird");
  const login = E.alice.login;
  const folders = await pimFolders(login);
  const { list, main, second, secondTasks } = await calendarsA(A);
  await check("A : trois agendas dans Thunderbird, du type de l'extension (celui de la boîte, à son nom, et un par dossier secondaire)", list.length === 3 && main && second && secondTasks && list.every((c) => c.type === "sync443" && !c.disabled && !c.readOnly), list);
  if (!main || !second || !secondTasks) return;
  const kinds = {};
  for (const c of [main, second, secondTasks]) {
    const v = (await H("calendarInfo", { calendarId: c.id, properties: ["capabilities.events.supported", "capabilities.tasks.supported", "organizerId"] })).values;
    kinds[c.name] = [v["capabilities.events.supported"], v["capabilities.tasks.supported"], v.organizerId];
  }
  await check(
    "… l'agenda de la boîte reçoit événements et tâches, celui du dossier d'agenda les événements seuls, celui du dossier de tâches les tâches seules ; organisateur = l'adresse de la boîte",
    same(kinds[A.name], [true, true, mailto(login)]) && same(kinds[FOLDERS.calendar], [true, false, mailto(login)]) && same(kinds[FOLDERS.tasks], [false, true, mailto(login)]),
    kinds,
  );

  const items = await itemsOf(main.id);
  const one = (title) => titled(items, title)[0] ?? null;
  const expectedTitles = [S.timed, S.allDay, S.zoned, S.serverMeeting, S.series, S.readOnlyEvent, S.task, S.taskDone, S.taskDue, S.taskRegen];
  await check("agenda de A : chaque événement et chaque tâche des dossiers par défaut du serveur, une seule fois", items.length === expectedTitles.length && expectedTitles.every((t) => titled(items, t).length === 1), items.map((i) => i.title));

  const timed = one(S.timed);
  await check(
    "événement chronométré : heures, lieu, description, rappel de 15 minutes, catégorie",
    timed?.kind === "event" && timed.start.utc === iso(at(0, 9)) && timed.end.utc === iso(at(0, 10)) && timed.location === WHERE.alpha && timed.description === NOTES.timed && same(timed.alarms.map((x) => x.offset), [-900]) && same(timed.categories, ["Travail"]),
    timed && { start: timed.start, end: timed.end, location: timed.location, description: timed.description, alarms: timed.alarms, categories: timed.categories },
  );
  const allDay = one(S.allDay);
  await check("événement sur la journée entière (minuit à minuit, heure de Paris) : un jour entier, le bon", allDay?.start.date === true && allDay.start.local === dayOf(at(1)) && allDay.end.local === dayOf(at(2)), allDay && { start: allDay.start, end: allDay.end });
  const zoned = one(S.zoned);
  await check(
    "événement dans un autre fuseau (règles de New York) : même instant, fuseau America/New_York de Thunderbird",
    zoned?.start.utc === iso(at(2, 15)) && zoned.start.tzid === "America/New_York" && zoned.start.local === localOf("America/New_York", at(2, 15)) && zoned.end.utc === iso(at(2, 16)),
    zoned && { start: zoned.start, end: zoned.end },
  );
  const meeting = one(S.serverMeeting);
  await check(
    "réunion organisée par A : organisateur et participants (obligatoire, facultatif)",
    lower(meeting?.organizer?.id) === mailto(login) && same(meeting.attendees.map((x) => [lower(x.id), x.role]).sort(), [[mailto(E.bob.login), "REQ-PARTICIPANT"], [mailto(PEOPLE.dave.email), "OPT-PARTICIPANT"]].sort()),
    meeting && { organizer: meeting.organizer, attendees: meeting.attendees },
  );
  const series = one(S.series);
  const start = SERIES_START();
  const occurrences = series ? await H("occurrences", { calendarId: main.id, itemId: series.id, from: iso(start - DAY), to: iso(start + 60 * DAY) }) : [];
  await check(
    "série hebdomadaire de 5 occurrences : la règle, une occurrence modifiée, une occurrence supprimée",
    series?.rules.length === 1 && /FREQ=WEEKLY/.test(series.rules[0]) && /COUNT=5/.test(series.rules[0]) && series.exceptions.length === 1 && series.exceptions[0].title === S.seriesChanged && series.removed.length === 1,
    series && { rules: series.rules, exceptions: series.exceptions.map((x) => [x.title, x.recurrenceId?.utc, x.start?.utc]), removed: series.removed },
  );
  const expectedOccurrences = [[S.series, iso(start)], [S.seriesChanged, iso(start + 7 * DAY + 2 * HOUR)], [S.series, iso(start + 21 * DAY)], [S.series, iso(start + 28 * DAY)]];
  await check(
    "… Thunderbird en calcule quatre occurrences : la déplacée à sa nouvelle heure sous son titre, aucune à la date supprimée",
    same(occurrences.map((o) => [o.title, o.start.utc]).sort((x, y) => (x[1] < y[1] ? -1 : 1)), expectedOccurrences),
    occurrences.map((o) => [o.title, o.start.utc]),
  );
  const task = one(S.task);
  const done = one(S.taskDone);
  const due = one(S.taskDue);
  await check("tâche simple : une tâche non terminée, avec ses notes", task?.kind === "task" && task.completed === false && task.description === NOTES.task, task && { completed: task.completed, description: task.description });
  await check("tâche terminée : terminée, avec sa date d'achèvement", done?.completed === true && Boolean(done.completedAt), done && { completed: done.completed, completedAt: done.completedAt });
  await check("tâche à échéance : début, échéance et priorité haute", due?.start?.local.startsWith(dayOf(at(0))) && due.due?.local.startsWith(dayOf(at(2))) && due.priority === 1, due && { start: due.start, due: due.due, priority: due.priority });

  const inSecond = await itemsOf(second.id);
  const inSecondTasks = await itemsOf(secondTasks.id);
  await check("dossier d'agenda secondaire : son événement dans son propre agenda, et rien d'autre", inSecond.length === 1 && inSecond[0].title === S.secondary && inSecond[0].kind === "event", inSecond.map((i) => i.title));
  await check("dossier de tâches secondaire : sa tâche dans son propre agenda, et rien d'autre", inSecondTasks.length === 1 && inSecondTasks[0].title === S.secondaryTask && inSecondTasks[0].kind === "task", inSecondTasks.map((i) => i.title));

  const ups = await actionsSince(0, login, UPLOADS);
  await check("la première synchronisation ne renvoie rien au serveur (aucun ajout, changement ni suppression d'événement ou de tâche)", !ups.filter((x) => folders.ids.includes(x.collection_id)).length, ups);

  // B and C: their own, and only their own.
  const calsB = await calendarsOf(B);
  const itemsB = [];
  for (const c of calsB) itemsB.push(...(await itemsOf(c.id)));
  await check("B (courrier décoché) : un agenda à son nom, avec son événement et sa tâche", calsB.length === 1 && calsB[0].name === B.name && same(itemsB.map((i) => i.title).sort(), [S.bobEvent, S.bobTask].sort()), { calendars: calsB.map((c) => c.name), items: itemsB.map((i) => i.title) });
  const askedB = await rpc("collections_requested", { login: E.bob.login, device_id: B.deviceId });
  const foldersB = await pimFolders(E.bob.login);
  await check("B ne demande au serveur aucun dossier de courrier (Sync, Ping) : ses dossiers d'agenda et de tâches seulement", askedB.length > 0 && askedB.every((id) => foldersB.ids.includes(id)), { asked: askedB, pim: foldersB.ids });
  const calsC = await calendarsOf(C);
  const itemsC = calsC.length ? await itemsOf(calsC[0].id) : [];
  await check("C (ActiveSync 12.1, tâches décochées) : un agenda d'événements seulement, avec son événement", calsC.length === 1 && same(itemsC.map((i) => i.title), [S.carolEvent]), { calendars: calsC.map((c) => c.name), items: itemsC.map((i) => i.title) });
  await checkSeparation("après la première synchronisation");

  // Later changes and deletions.
  const [e] = await srvEvents(login, S.timed);
  await mock("change_event", [login, 8, e.server_id], { subject: S.timedChanged, start: iso(at(0, 13)), end: iso(at(0, 14)), location: WHERE.beta });
  const [z] = await srvEvents(login, S.zoned);
  await mock("delete_event", [login, 8, z.server_id]);
  const [t] = await srvTasks(login, S.task);
  await mock("change_task", [login, 7, t.server_id], { complete: true });
  const [d] = await srvTasks(login, S.taskDue);
  await mock("delete_task", [login, 7, d.server_id]);
  await syncNow(A);
  const after = await itemsOf(main.id);
  const changed = titled(after, S.timedChanged)[0];
  await check("événement modifié sur le serveur (titre, heures, lieu) : modifié ici, sans doublon", changed?.start.utc === iso(at(0, 13)) && changed.location === WHERE.beta && !titled(after, S.timed).length && changed.id === timed?.id, changed && { start: changed.start, location: changed.location });
  await check("événement supprimé sur le serveur : retiré ici", !titled(after, S.zoned).length);
  await check("tâche terminée sur le serveur : terminée ici", titled(after, S.task)[0]?.completed === true);
  await check("tâche supprimée sur le serveur : retirée ici", !titled(after, S.taskDue).length);
  await check("… et rien d'autre n'a bougé (mêmes autres éléments, une fois chacun)", after.length === items.length - 2, after.map((i) => i.title));

  // A new event, without asking: the Ping of A covers its calendar folders.
  const pinging = await waitFor(async () => (await mock("pings_waiting", [login, A.deviceId])).find((p) => (p.folders ?? []).includes(folders.calendar)), { timeout: 60_000 });
  await check("le Ping de A surveille aussi ses dossiers d'agenda et de tâches", pinging && folders.ids.every((id) => pinging.folders.includes(id)), { ping: pinging?.folders, pim: folders.ids });
  const t0 = Date.now();
  await mock("add_event", [login, 8], { subject: S.pushed, start: iso(at(6, 9)), end: iso(at(6, 10)) });
  const arrived = await waitFor(() => localOne(main.id, S.pushed), { timeout: 90_000, interval: 300 });
  await check("nouvel événement sur le serveur : arrivé sans attendre (Ping), une seule fois", arrived && Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);
  await idle(A.id, 0, 60_000);
}

// ── 2. Thunderbird to server ──────────────────────────────────────────────

async function thunderbirdToServer({ A, B }) {
  await step("2. De Thunderbird vers le serveur");
  const login = E.alice.login;
  const folders = await pimFolders(login);
  const { main, second } = await calendarsA(A);
  const seq0 = await seqNow();

  // An event: created, changed, deleted.
  const id = await H("uiAdd", {
    calendarId: main.id,
    spec: { start: compact(PARIS, at(7, 9)), end: compact(PARIS, at(7, 10)), tzid: PARIS, ops: [{ title: S.localEvent }, { location: WHERE.gamma }, { description: NOTES.local }, { alarm: 30 }, { categories: ["Perso"] }] },
  });
  const created = await waitFor(async () => (await srvEvents(login, S.localEvent))[0], { timeout: 60_000 });
  await check(
    "événement créé ici : créé sur le serveur, dans le dossier d'agenda par défaut, avec ses heures, son lieu, sa description, son rappel, sa catégorie",
    created?.folder_id === folders.calendar && created.start === iso(at(7, 9)) && created.end === iso(at(7, 10)) && created.location === WHERE.gamma && created.body === NOTES.local && created.reminder === 30 && same(created.categories, ["Perso"]),
    created,
  );
  await check("… avec le fuseau de l'événement (règles de Paris), jamais un nom de fuseau", created && same([created.zone?.bias, created.zone?.standard?.change, created.zone?.daylight?.change, created.zone?.standard?.name, created.zone?.daylight?.name], [-60, Z_PARIS.standard.change, Z_PARIS.daylight.change, "", ""]), created?.zone);
  await check("… et son UID est celui que Thunderbird lui a donné", created?.uid === id, { server: created?.uid, local: id });
  await idle(A.id, 0, 60_000);
  const bound = created ? await boundIds(A, main.id, folders.calendar) : [];
  await check("l'identifiant donné par le serveur est acquitté : l'événement local est lié à ce ServerId", created && bound.includes(created.server_id), { serverId: created?.server_id, bound: bound.length });
  await twoPasses(A);
  const adds = (await actionsSince(seq0, login, ["sync_add"])).filter((x) => x.collection_id === folders.calendar);
  await check("aucun doublon après deux autres passages : un seul ajout envoyé, un seul événement sur le serveur, un seul ici", adds.length === 1 && (await srvEvents(login, S.localEvent)).length === 1 && (await localCount(main.id, S.localEvent)) === 1, { adds: adds.length, server: (await srvEvents(login, S.localEvent)).length });

  await H("uiEdit", { calendarId: main.id, itemId: id, ops: [{ title: S.localEventChanged }, { shift: 60 }] });
  const changed = await waitFor(async () => (await srvEvents(login, S.localEventChanged))[0], { timeout: 60_000 });
  await check("événement modifié ici (titre, une heure plus tard) : modifié sur le serveur, le même élément", changed?.server_id === created?.server_id && changed.start === iso(at(7, 10)) && changed.end === iso(at(7, 11)) && changed.location === WHERE.gamma && !(await srvEvents(login, S.localEvent)).length, changed);
  await H("uiDelete", { calendarId: main.id, itemId: id });
  const gone = await waitFor(async () => !(await srvEvents(login, S.localEventChanged)).length, { timeout: 60_000 });
  await check("événement supprimé ici : supprimé du serveur", gone, await srvEvents(login, S.localEventChanged));

  // One that stays, and one in the secondary calendar folder.
  await H("uiAdd", { calendarId: main.id, spec: { start: compact(PARIS, at(8, 9)), end: compact(PARIS, at(8, 10)), tzid: PARIS, ops: [{ title: S.localKept }] } });
  await H("uiAdd", { calendarId: second.id, spec: { start: compact(PARIS, at(8, 11)), end: compact(PARIS, at(8, 12)), tzid: PARIS, ops: [{ title: S.localSecondary }] } });
  const inSecond = await waitFor(async () => (await srvEvents(login, S.localSecondary))[0], { timeout: 60_000 });
  await check("événement créé dans l'agenda du dossier secondaire : créé dans ce dossier-là du serveur", inSecond?.folder_id === folders.byName.get(FOLDERS.calendar), inSecond && { folder: inSecond.folder_id, expected: folders.byName.get(FOLDERS.calendar) });

  // A task.
  const taskId = await H("uiAdd", { calendarId: main.id, spec: { kind: "task", start: compact(PARIS, at(7)).slice(0, 8), due: compact(PARIS, at(9)).slice(0, 8), ops: [{ title: S.localTask }, { description: NOTES.task }, { priority: 1 }] } });
  const task = await waitFor(async () => (await srvTasks(login, S.localTask))[0], { timeout: 60_000 });
  await check(
    "tâche créée ici : créée sur le serveur, dans le dossier de tâches par défaut, avec début, échéance, notes et priorité haute",
    task?.folder_id === folders.tasks && task.complete === false && String(task.start_date).startsWith(dayOf(at(7))) && String(task.due_date).startsWith(dayOf(at(9))) && task.body === NOTES.task && task.importance === 2,
    task,
  );
  await H("uiEdit", { calendarId: main.id, itemId: taskId, ops: [{ title: S.localTaskChanged }, { complete: true }] });
  const taskDone = await waitFor(async () => (await srvTasks(login, S.localTaskChanged))[0], { timeout: 60_000 });
  await check("tâche renommée et terminée ici : modifiée sur le serveur (terminée, avec sa date), le même élément", taskDone?.server_id === task?.server_id && taskDone.complete === true && Boolean(taskDone.date_completed), taskDone);
  await H("uiDelete", { calendarId: main.id, itemId: taskId });
  const taskGone = await waitFor(async () => !(await srvTasks(login, S.localTaskChanged)).length, { timeout: 60_000 });
  await check("tâche supprimée ici : supprimée du serveur", taskGone);

  const { secondTasks } = await calendarsA(A);
  await H("uiAdd", { calendarId: secondTasks.id, spec: { kind: "task", ops: [{ title: S.localSecondaryTask }] } });
  const taskInSecond = await waitFor(async () => (await srvTasks(login, S.localSecondaryTask))[0], { timeout: 60_000 });
  await check("tâche créée dans l'agenda du dossier de tâches secondaire : créée dans ce dossier-là du serveur", taskInSecond?.folder_id === folders.byName.get(FOLDERS.tasks), taskInSecond && { folder: taskInSecond.folder_id, expected: folders.byName.get(FOLDERS.tasks) });

  // A series, then two exceptions.
  const seriesId = await H("uiAdd", { calendarId: main.id, spec: { start: compact(PARIS, at(7, 14)), end: compact(PARIS, at(7, 15)), tzid: PARIS, ops: [{ title: S.localSeries }, { rrule: "FREQ=WEEKLY;COUNT=4" }] } });
  const serverSeries = await waitFor(async () => (await srvEvents(login, S.localSeries))[0], { timeout: 60_000 });
  await check("série créée ici (chaque semaine, 4 fois) : créée sur le serveur avec sa récurrence", serverSeries?.recurrence?.type === 1 && serverSeries.recurrence.occurrences === 4 && serverSeries.recurrence.interval === 1 && !serverSeries.exceptions.length, serverSeries && { recurrence: serverSeries.recurrence, exceptions: serverSeries.exceptions });
  const occ = (await H("occurrences", { calendarId: main.id, itemId: seriesId, from: iso(at(6)), to: iso(at(40)) })).map((o) => o.start.utc);
  await H("uiEditOccurrence", { calendarId: main.id, itemId: seriesId, rid: occ[1], ops: [{ title: S.localSeriesChanged }, { shift: 90 }] });
  await H("uiDeleteOccurrence", { calendarId: main.id, itemId: seriesId, rid: occ[2] });
  const withExceptions = await waitFor(async () => {
    const [x] = await srvEvents(login, S.localSeries);
    return x?.exceptions.length === 2 ? x : null;
  }, { timeout: 60_000 });
  const ex = (when) => withExceptions?.exceptions.find((x) => x.exception_start === when) ?? null;
  await check(
    "une occurrence modifiée et une occurrence supprimée ici : deux exceptions sur le serveur, la série intacte",
    withExceptions?.server_id === serverSeries?.server_id && withExceptions.recurrence.occurrences === 4 && ex(occ[1])?.subject === S.localSeriesChanged && ex(occ[1]).start === iso(Date.parse(occ[1]) + 90 * MINUTE) && !ex(occ[1]).deleted && ex(occ[2])?.deleted === true,
    withExceptions ? { occurrences: occ, exceptions: withExceptions.exceptions } : await srvEvents(login, S.localSeries),
  );

  // B, whose mail is unchecked, sends its calendar too.
  const [calB] = await calendarsOf(B);
  await H("uiAdd", { calendarId: calB.id, spec: { start: compact(PARIS, at(8, 9)), end: compact(PARIS, at(8, 10)), tzid: PARIS, ops: [{ title: S.bobLocal }] } });
  const fromB = await waitFor(async () => (await srvEvents(E.bob.login, S.bobLocal))[0], { timeout: 60_000 });
  await check("B (courrier décoché) : son événement créé ici arrive sur le serveur, chez Bob et nulle part ailleurs", fromB && !(await srvEvents(login, S.bobLocal)).length, fromB);

  // One change the server refuses.
  const [kept] = await srvEvents(login, S.localKept);
  const keptLocal = await localOne(main.id, S.localKept);
  const seq1 = await seqNow();
  const t1 = Date.now();
  await mock("set_option", ["fail_next_calendar_change", 6]);
  await H("uiEdit", { calendarId: main.id, itemId: keptLocal.id, ops: [{ title: S.refused }] });
  const refusedAt = await waitFor(async () => (await actionsSince(seq1, login, ["sync_change"])).find((x) => x.injected === "6"), { timeout: 60_000 });
  const told = await noticed("calendarChangeRefused", S.refused, t1);
  await idle(A.id, 0, 60_000);
  await check("changement refusé par le serveur (statut 6 simulé) : la demande est bien partie, pour cet élément", refusedAt?.server_id === kept?.server_id, refusedAt);
  await check("… l'utilisateur en est averti par une notification qui nomme l'élément", told, notices.slice(-3));
  const restored = await waitFor(() => localOne(main.id, S.localKept), { timeout: 30_000 });
  await check("… le changement est annulé ici : l'événement reprend la version du serveur", restored && !(await localCount(main.id, S.refused)), (await itemsOf(main.id)).map((i) => i.title).filter((x) => x.includes("gardé") || x.includes("refusé")));
  await twoPasses(A);
  const resent = (await actionsSince(seq1, login, ["sync_change"])).filter((x) => x.server_id === kept?.server_id);
  const h = await health(A.id);
  await check("… il n'est pas renvoyé aux passages suivants, le serveur garde sa version, la boîte reste saine", resent.length === 1 && (await srvEvents(login, S.localKept)).length === 1 && !h.blocked && !h.lastError, { resent: resent.length, health: h });
  await H("uiEdit", { calendarId: main.id, itemId: keptLocal.id, ops: [{ location: WHERE.alpha }] });
  const usable = await waitFor(async () => ((await srvEvents(login, S.localKept))[0]?.location === WHERE.alpha ? true : null), { timeout: 60_000 });
  await check("… et l'événement reste modifiable : un changement suivant passe", usable, await srvEvents(login, S.localKept));
  await idle(A.id, 0, 60_000);

  // A conflict: the same event changed here and then on the server, both before a pass. The change is old enough
  // to be read (the module holds a change back about two seconds), so it leaves, and the server refuses it.
  const seq2 = await seqNow();
  const t2 = Date.now();
  const timer = ctx.entries.get(A.id).timer;
  await H("uiEdit", { calendarId: main.id, itemId: keptLocal.id, ops: [{ title: S.conflictLocal }] });
  await holdTimer(A, timer);
  await sleep(2600);
  await mock("change_event", [login, 8, kept.server_id], { subject: S.conflictServer, location: WHERE.beta });
  ctx.runSync(A.id, { reason: "user" });
  const conflict = await waitFor(async () => (await actionsSince(seq2, login, ["sync_change"])).find((x) => x.server_id === kept.server_id), { timeout: 60_000 });
  const toldConflict = await noticed("calendarChangeRefused", S.conflictLocal, t2);
  const won = await waitFor(() => localOne(main.id, S.conflictServer), { timeout: 60_000 });
  await twoPasses(A);
  const after = await srvEvents(login, S.conflictServer);
  const tries = (await actionsSince(seq2, login, ["sync_change"])).filter((x) => x.server_id === kept.server_id);
  await check("conflit (événement changé ici, puis sur le serveur avant l'envoi) : le changement d'ici part, et le serveur le refuse (statut 7)", conflict?.status === "7" && conflict.conflict === true, conflict);
  await check(
    "… le serveur l'emporte : sa version remplace celle d'ici (titre et lieu), l'utilisateur est averti, et rien n'est renvoyé ensuite",
    won?.location === WHERE.beta && toldConflict && !(await localCount(main.id, S.conflictLocal)) && after.length === 1 && after[0].location === WHERE.beta && tries.length === 1 && !(await srvEvents(login, S.conflictLocal)).length,
    { local: won && { title: won.title, location: won.location }, told: Boolean(toldConflict), server: after.map((e) => e.subject), tries: tries.map((x) => x.status) },
  );

  await mock("change_event", [login, 8, kept.server_id], { subject: S.localKept, location: WHERE.alpha });
  await syncNow(A);

  // A server that is unwell for one request (collection status 5): nothing is undone, the change waits and goes later.
  const seq4 = await seqNow();
  const t4 = Date.now();
  await mock("set_option", ["fail_next_calendar_change", 5]);
  await H("uiEdit", { calendarId: main.id, itemId: keptLocal.id, ops: [{ location: WHERE.gamma }] });
  const unwell = await waitFor(async () => (await actionsSince(seq4, login, ["sync_change"])).find((x) => x.injected === "5"), { timeout: 60_000 });
  await waitFor(() => !ctx.entries.get(A.id)?.inFlight, { timeout: 60_000, interval: 200 });
  const during = { local: (await localOne(main.id, S.localKept))?.location, server: (await srvEvents(login, S.localKept))[0]?.location, health: await health(A.id) };
  await check("panne passagère du serveur (statut 5 pour le dossier, simulé) : rien n'est annulé ici, le changement attend, l'erreur est notée comme passagère", unwell && during.local === WHERE.gamma && during.server === WHERE.alpha && !during.health.blocked && Boolean(during.health.lastError), during);
  await syncNow(A);
  const recovered = await waitFor(async () => ((await srvEvents(login, S.localKept))[0]?.location === WHERE.gamma ? true : null), { timeout: 60_000 });
  await twoPasses(A);
  const sentTwice = (await actionsSince(seq4, login, ["sync_change"])).filter((x) => x.server_id === kept.server_id && x.status === "1");
  const h4 = await health(A.id);
  await check(
    "… au passage suivant le changement arrive sur le serveur, une seule fois, sans aucune notification d'annulation, et la boîte redevient saine",
    recovered && sentTwice.length === 1 && (await localOne(main.id, S.localKept))?.location === WHERE.gamma && !notices.some((n) => n.at >= t4) && !h4.blocked,
    { applied: sentTwice.length, notices: notices.filter((n) => n.at >= t4), health: h4 },
  );
  await mock("change_event", [login, 8, kept.server_id], { subject: S.localKept });
  await syncNow(A);
  await check("(l'événement reprend son titre, pour la suite)", (await localCount(main.id, S.localKept)) === 1);
}

// ── 3. Read-only items ────────────────────────────────────────────────────

async function readOnlyItems({ A }) {
  await step("3. Éléments en lecture seule");
  const login = E.alice.login;
  const { main } = await calendarsA(A);
  const event = await localOne(main.id, S.readOnlyEvent);
  const task = await localOne(main.id, S.taskRegen);
  const [serverEvent] = await srvEvents(login, S.readOnlyEvent);
  const [serverTask] = await srvTasks(login, S.taskRegen);
  await check("l'événement d'un calendrier non grégorien et la tâche qui se régénère sont là, sans récurrence calculée ici", event && task && !event.rules.length && !task.rules.length, { event: event?.rules, task: task?.rules });
  if (!event || !task) return;
  const before = await serverState(login);
  const seq0 = await seqNow();

  // What Thunderbird's interface asks before it lets the user touch an item.
  const access = { event: await H("access", { calendarId: main.id, itemId: event.id }), task: await H("access", { calendarId: main.id, itemId: task.id }) };
  const ordinary = await localOne(main.id, S.series);
  const control = ordinary ? await H("access", { calendarId: main.id, itemId: ordinary.id }) : null;
  await check(
    "Thunderbird les tient pour non modifiables (cal.acl) et les ouvre dans sa fenêtre de lecture, pas d'édition ; un événement ordinaire du même agenda reste modifiable",
    access.event?.modify === false && access.event.dialog === "summary" && access.task?.modify === false && access.task.dialog === "summary" && (!control || (control.modify === true && control.dialog === "edit")) && access.event.calendar.writable === true,
    { access, control },
  );

  const t0 = Date.now();
  const edit = await errorOf(() => H("uiEdit", { calendarId: main.id, itemId: event.id, ops: [{ title: S.roEdit }, { shift: 30 }] }));
  const afterEdit = await localOne(main.id, S.readOnlyEvent);
  await check("événement en lecture seule modifié ici : Thunderbird refuse le changement (agenda en lecture seule pour cet élément), qui garde titre et heure", edit !== null && /readonly|read-only|80004005|8053/i.test(edit.message) && afterEdit?.start.utc === event.start.utc && !(await localCount(main.id, S.roEdit)), edit);
  const complete = await errorOf(() => H("uiEdit", { calendarId: main.id, itemId: task.id, ops: [{ complete: true }] }));
  await check("tâche qui se régénère terminée ici : refusé de même, elle reste non terminée", complete !== null && (await localOne(main.id, S.taskRegen))?.completed === false, complete);
  const removal = await errorOf(() => H("uiDelete", { calendarId: main.id, itemId: event.id }));
  await check("événement en lecture seule supprimé ici : refusé de même, il reste dans l'agenda", removal !== null && (await localCount(main.id, S.readOnlyEvent)) === 1, removal);
  await info("readOnlyRefusal", { edit, complete, removal });

  // Recurrences Thunderbird cannot hold: the item comes without its recurrence, read-only, and the calendar stays whole.
  const year = new Date(BASE).getUTCFullYear() + 1;
  const feb = Date.UTC(year, 1, 10, 9);
  const day31 = await mock("add_event", [login, 8], { subject: S.day31, start: iso(feb), end: iso(feb + HOUR), recurrence: { type: 2, interval: 12, day_of_month: 31 } });
  const tooLong = await mock("add_event", [login, 8], { subject: S.tooLong, start: iso(at(5, 9)), end: iso(at(7, 9)), recurrence: { type: 0, interval: 1, occurrences: 5 } });
  const zwnj = String.fromCharCode(0x200c);
  const zwj = String.fromCharCode(0x200d);
  const joined = `${S.joiners} mi${zwnj}khaham a${zwj}b`;
  const hidden = `${S.invisible} a${String.fromCharCode(0x200b)}b`;
  const joinedId = await mock("add_event", [login, 8], { subject: joined, start: iso(at(5, 12)), end: iso(at(5, 13)) });
  const hiddenId = await mock("add_event", [login, 8], { subject: hidden, start: iso(at(5, 14)), end: iso(at(5, 15)) });
  await syncNow(A);
  const all = await itemsOf(main.id);
  const odd = [titled(all, S.day31)[0], titled(all, S.tooLong)[0]];
  const oddAccess = [];
  for (const i of odd) oddAccess.push(i ? await H("access", { calendarId: main.id, itemId: i.id }) : null);
  await check(
    "récurrences que Thunderbird ne sait pas tenir (le 31 tous les douze mois à partir de février ; événement de deux jours répété chaque jour) : les éléments arrivent sans récurrence, en lecture seule",
    odd.every((i) => i && !i.rules.length) && oddAccess.every((x) => x?.modify === false) && odd[0].start.utc === iso(feb),
    { rules: odd.map((i) => i?.rules ?? null), access: oddAccess.map((x) => x?.modify ?? null) },
  );
  const view = await H("viewItems", { calendarId: main.id, from: iso(at(-2)), to: iso(at(45)) });
  const viewFar = await H("viewItems", { calendarId: main.id, from: iso(feb - 5 * DAY), to: iso(feb + 400 * DAY) });
  const stillThere = [S.series, S.readOnlyEvent, S.allDay].map((t) => titled(all, t).length);
  await check("… et l'agenda reste entièrement affiché : Thunderbird rend les occurrences des autres événements sur ces périodes, sans erreur", view.error === null && view.count >= 6 && viewFar.error === null && viewFar.count >= 1 && same(stillThere, [1, 1, 1]), { view, viewFar, stillThere });
  await info("oddRecurrences", { day31, tooLong, view, viewFar });

  const withJoiners = all.find((i) => i.title.startsWith(S.joiners));
  const withHidden = all.find((i) => i.title.startsWith(S.invisible));
  await check("titre contenant U+200C et U+200D : gardé tel quel, caractère pour caractère", withJoiners?.title === joined, withJoiners && { length: withJoiners.title.length, expected: joined.length });
  if (withJoiners) {
    await H("uiEdit", { calendarId: main.id, itemId: withJoiners.id, ops: [{ location: WHERE.beta }] });
    const back = await waitFor(async () => {
      const e = await mock("event", [login, 8, joinedId]);
      return e?.location === WHERE.beta ? e : null;
    }, { timeout: 60_000 });
    await check("… et un changement fait ici (le lieu) le renvoie au serveur sans toucher à ces caractères", back?.subject === joined, back && { length: back.subject.length, expected: joined.length });
  }
  const hiddenAccess = withHidden ? await H("access", { calendarId: main.id, itemId: withHidden.id }) : null;
  const hiddenEdit = withHidden ? await errorOf(() => H("uiEdit", { calendarId: main.id, itemId: withHidden.id, ops: [{ location: WHERE.beta }] })) : null;
  await check(
    "titre contenant un autre caractère invisible (U+200B) : l'élément arrive, mais en lecture seule (rien ne sera réécrit sur le serveur), et Thunderbird refuse de le modifier",
    withHidden && hiddenAccess?.modify === false && hiddenEdit !== null && (await mock("event", [login, 8, hiddenId]))?.subject === hidden,
    { arrived: Boolean(withHidden), access: hiddenAccess?.modify, edit: hiddenEdit },
  );

  await sleep(6000); // longer than the delay after which a recorded change would be sent
  await twoPasses(A);
  const sent = (await actionsSince(seq0, login, UPLOADS)).filter((x) => [serverEvent?.server_id, serverTask?.server_id, hiddenId, day31, tooLong].includes(x.server_id));
  const now = await serverState(login);
  await check("rien n'a été envoyé au serveur pour ces éléments (ni changement ni suppression), qui y sont intacts", !sent.length && before.every((row) => now.some((x) => same(x, row))), sent);
  const said = notices.filter((n) => n.at >= t0);
  await check("… aucun changement n'a été enregistré : aucune notification ne suit (rien à annuler), la boîte reste saine", !said.length && !(await health(A.id)).lastError, said);
}

// ── 4. Invitations received ───────────────────────────────────────────────

/** The calendar part of the invitation mail of this subject, as Thunderbird holds the message. */
async function invitationPart(accountKey, subject) {
  const [inbox] = await browser.folders.query({ accountId: accountKey, path: "/Inbox" });
  const found = await waitFor(async () => {
    let page = await browser.messages.list(inbox.id);
    for (;;) {
      const m = (page?.messages ?? []).find((x) => x.subject === subject);
      if (m) return m;
      if (!page?.id) return null;
      page = await browser.messages.continueList(page.id);
    }
  }, { timeout: 60_000 });
  if (!found) return null;
  const raw = await browser.messages.getRaw(found.id, { data_format: "File" });
  const text = new TextDecoder("utf-8").decode(new Uint8Array(await (typeof raw === "string" ? new Blob([raw]) : raw).arrayBuffer()));
  // The mock writes the calendar part 8bit, between two boundary lines.
  const m = /Content-Type: text\/calendar[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--/i.exec(text);
  return m ? m[1] : null;
}

async function invitations({ A, B, C }) {
  await step("4. Invitations reçues");
  const login = E.alice.login;
  const folders = await pimFolders(login);
  const { main } = await calendarsA(A);
  const organizer = PEOPLE.olivia;
  const replySubject = (kind, title) => browser.i18n.getMessage(kind, [title]);

  // (a) 14.1, the server puts the invitation in the calendar: accepted from the invitation bar, then declined from the event.
  await guard("invitation acceptée puis refusée", async () => {
    const seq = await seqNow();
    const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv1, start: iso(at(10, 9)), end: iso(at(10, 10)), location: WHERE.alpha });
    await syncNow(A);
    const local = await waitFor(() => localOne(main.id, S.inv1), { timeout: 60_000 });
    await check(
      "invitation reçue : l'événement apparaît dans l'agenda, organisé par l'expéditeur, sans réponse encore (NEEDS-ACTION)",
      lower(local?.organizer?.id) === mailto(organizer.email) && partstatOf(local, login) === "NEEDS-ACTION" && local.start.utc === iso(at(10, 9)) && local.id === inv.uid,
      local && { organizer: local.organizer, attendees: local.attendees, id: local.id, uid: inv.uid },
    );
    const ics = await invitationPart(A.accountKey, S.inv1);
    await check("… et son message est dans la boîte de réception, avec sa partie text/calendar", ics && /METHOD:REQUEST/.test(ics) && ics.includes(inv.uid), ics?.slice(0, 200));
    if (!local || !ics) return;

    const answer = await H("itipAnswer", { calendarId: main.id, ics, partstat: "ACCEPTED", sender: organizer.email, identity: login });
    await info("itipAnswerFound", answer);
    await check("« Accepter » de la barre d'invitation (traitement iTIP de Thunderbird) : l'événement de l'agenda est modifié, pas ajouté une seconde fois", answer.ok && answer.found === 1 && (await localCount(main.id, S.inv1)) === 1, answer);
    const responses = await waitFor(async () => {
      const r = await responsesSince(seq, login);
      return r.length ? r : null;
    }, { timeout: 60_000 });
    await quiet(A);
    await idle(A.id, 0, 60_000);
    const r = responses?.[0];
    await check(
      "acceptée : un seul MeetingResponse, « accepté » (1), sur l'élément d'agenda du serveur (ActiveSync 14.1), accepté par le serveur",
      responses?.length === 1 && r.response === 1 && r.source === "calendar" && r.collection_id === folders.calendar && r.request_id === inv.calendar_id && r.status === "1" && r.uid === inv.uid && r.instance_id === null,
      responses,
    );
    const parts = await waitFor(async () => {
      const p = await partsSince(seq, login);
      return p.length ? p : null;
    }, { timeout: 30_000 });
    const reply = described(parts?.[0]);
    await check(
      "… puis une seule réponse, à l'organisateur seul, par SendMail : REPLY, le participant est la boîte, PARTSTAT=ACCEPTED, même UID",
      parts?.length === 1 && same(reply.to, [organizer.email]) && !reply.others.length && reply.sender === login && reply.count === 1 && lower(reply.method) === "reply" && reply.inside === "REPLY" && reply.uid === inv.uid && reply.organizer === organizer.email && same(reply.attendees, [login]) && same(reply.partstats, ["ACCEPTED"]),
      parts?.map((p) => ({ to: p.to, subject: p.subject, ics: p.parts?.[0]?.text?.slice(0, 600) })),
    );
    await check("… son sujet est celui du catalogue (« Accepté : … »), et aucune question n'a été posée à l'utilisateur", reply.subject === replySubject("meetingSubjectAccepted", S.inv1) && ctx.meetings.current() === null, { subject: reply.subject, expected: replySubject("meetingSubjectAccepted", S.inv1) });
    const rawReply = await sentRaw(seq, login);
    await check("… sa partie texte donne l'heure en UTC, dite comme telle (pas le fuseau de l'ordinateur), et son To est l'adresse seule", rawReply.length === 1 && /UTC/.test(rawReply[0].text) && rawReply[0].to.trim().toLowerCase() === organizer.email, rawReply);
    const accepted = await localOne(main.id, S.inv1);
    const [onServer] = await srvEvents(login, S.inv1);
    await check("… l'événement reste accepté ici, et l'est sur le serveur (ResponseType 3)", partstatOf(accepted, login) === "ACCEPTED" && onServer?.response_type === 3, { local: accepted?.attendees, server: onServer?.response_type });
    await twoPasses(A);
    await check("… rien de plus aux passages suivants (toujours un MeetingResponse, une réponse, un événement)", (await responsesSince(seq, login)).length === 1 && (await partsSince(seq, login)).length === 1 && (await localCount(main.id, S.inv1)) === 1 && (await srvEvents(login, S.inv1)).length === 1);

    // Declined afterwards, from the event itself.
    const seq2 = await seqNow();
    await H("uiEdit", { calendarId: main.id, itemId: accepted.id, ops: [{ partstat: { id: attendeeId(accepted, login), value: "DECLINED" } }] });
    const declined = await waitFor(async () => {
      const list = await responsesSince(seq2, login);
      return list.length ? list : null;
    }, { timeout: 60_000 });
    await quiet(A);
    const d = declined?.[0];
    await check("refusée ensuite depuis l'événement : un seul MeetingResponse, « refusé » (3), sur l'élément d'agenda, accepté par le serveur", declined?.length === 1 && d.response === 3 && d.source === "calendar" && d.request_id === inv.calendar_id && d.status === "1", declined);
    const parts2 = await waitFor(async () => {
      const p = await partsSince(seq2, login);
      return p.length ? p : null;
    }, { timeout: 30_000 });
    const reply2 = described(parts2?.[0]);
    await check(
      "… puis une seule réponse à l'organisateur : REPLY, PARTSTAT=DECLINED (« Refusé : … »)",
      parts2?.length === 1 && same(reply2.to, [organizer.email]) && reply2.inside === "REPLY" && same(reply2.partstats, ["DECLINED"]) && reply2.uid === inv.uid && reply2.subject === replySubject("meetingSubjectDeclined", S.inv1),
      parts2?.map((p) => ({ to: p.to, subject: p.subject })),
    );
    await syncNow(A);
    const leftServer = !(await srvEvents(login, S.inv1)).length;
    const leftLocal = await waitFor(async () => ((await localCount(main.id, S.inv1)) === 0 ? true : null), { timeout: 30_000 });
    await check("… le serveur retire l'événement refusé de son agenda, et il disparaît d'ici au passage suivant", leftServer && leftLocal, { server: leftServer, local: await localCount(main.id, S.inv1) });
  });

  // (b) A server that does not put invitations in the calendar: accepting adds the event.
  await guard("invitation absente de l'agenda", async () => {
    await mock("set_option", ["invitation_in_calendar", false]);
    try {
      const seq = await seqNow();
      const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv2, start: iso(at(11, 9)), end: iso(at(11, 10)) });
      await syncNow(A);
      const ics = await invitationPart(A.accountKey, S.inv2);
      await check("serveur qui ne met pas l'invitation dans l'agenda : le message arrive, aucun événement ni ici ni sur le serveur", ics && inv.calendar_id === null && !(await localCount(main.id, S.inv2)) && !(await srvEvents(login, S.inv2)).length, { calendarId: inv.calendar_id });
      if (!ics) return;
      const answer = await H("itipAnswer", { calendarId: main.id, ics, partstat: "ACCEPTED", sender: organizer.email, identity: login });
      await check("« Accepter » de la barre d'invitation : Thunderbird ajoute l'événement à l'agenda de la boîte", answer.ok && answer.found === 0 && (await localCount(main.id, S.inv2)) === 1, answer);
      const responses = await waitFor(async () => {
        const r = await responsesSince(seq, login);
        return r.length ? r : null;
      }, { timeout: 60_000 });
      await quiet(A);
      await idle(A.id, 0, 60_000);
      const r = responses?.[0];
      await check(
        "… un seul MeetingResponse, « accepté », sur le message d'invitation de la boîte de réception, accepté par le serveur qui crée l'élément d'agenda",
        responses?.length === 1 && r.response === 1 && r.source === "mail" && r.request_id === inv.mail_id && r.collection_id === inv.collection_id && r.status === "1" && Boolean(r.calendar_id),
        responses,
      );
      await twoPasses(A);
      const onServer = await srvEvents(login, S.inv2);
      const bound = await boundIds(A, main.id, folders.calendar);
      const adds = (await actionsSince(seq, login, ["sync_add"])).filter((x) => x.collection_id === folders.calendar);
      await check(
        "… l'événement ajouté ici est lié à cet élément (CalendarId) : un seul sur le serveur, un seul ici, aucun ajout envoyé en double",
        onServer.length === 1 && onServer[0].server_id === r?.calendar_id && bound.includes(r?.calendar_id) && (await localCount(main.id, S.inv2)) === 1 && !adds.length,
        { server: onServer.map((e) => e.server_id), calendarId: r?.calendar_id, adds },
      );
      const parts = await partsSince(seq, login);
      const reply = described(parts[0]);
      await check("… et une seule réponse REPLY/ACCEPTED à l'organisateur", parts.length === 1 && same(reply.to, [organizer.email]) && reply.inside === "REPLY" && same(reply.partstats, ["ACCEPTED"]) && reply.uid === inv.uid, parts.map((p) => ({ to: p.to, subject: p.subject })));
    } finally {
      await mock("set_option", ["invitation_in_calendar", true]);
    }
  });

  // (c) The server fails to record the answer.
  await guard("réponse refusée par le serveur", async () => {
    const seq = await seqNow();
    await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv3, start: iso(at(12, 9)), end: iso(at(12, 10)) });
    await syncNow(A);
    const local = await waitFor(() => localOne(main.id, S.inv3), { timeout: 60_000 });
    if (!(await check("troisième invitation dans l'agenda", local))) return;
    const t0 = Date.now();
    await mock("set_option", ["fail_next_meeting_response", 4]);
    await H("uiEdit", { calendarId: main.id, itemId: local.id, ops: [{ partstat: { id: attendeeId(local, login), value: "ACCEPTED" } }] });
    const told = await noticed("calendarAnswerFailed", S.inv3, t0, 60_000);
    await quiet(A);
    await idle(A.id, 0, 60_000);
    const responses = await responsesSince(seq, login);
    await check("MeetingResponse en échec sur le serveur (statut 4 simulé) : la réponse est bien partie, une fois", responses.length === 1 && responses[0].status === "4" && responses[0].response === 1, responses);
    await check("… l'utilisateur est averti par une notification qui nomme l'événement", told, notices.slice(-3));
    const undone = await waitFor(async () => (partstatOf(await localOne(main.id, S.inv3), login) === "NEEDS-ACTION" ? true : null), { timeout: 30_000 });
    await check("… la réponse est annulée ici : l'événement redevient « sans réponse »", undone, (await localOne(main.id, S.inv3))?.attendees);
    await twoPasses(A);
    await check("… aucune réponse n'est partie vers l'organisateur, et rien n'est retenté tout seul", !(await partsSince(seq, login)).length && (await responsesSince(seq, login)).length === 1, await partsSince(seq, login));
  });

  // (d) ActiveSync 12.1: the answer goes on the invitation mail, even with the event in the calendar.
  await guard("invitation en ActiveSync 12.1", async () => {
    const who = E.carol.login;
    const [calC] = await calendarsOf(C);
    const seq = await seqNow("old");
    const inv = await mock("deliver_invitation", [who], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv4, start: iso(at(10, 9)), end: iso(at(10, 10)) }, "old");
    await syncNow(C);
    const local = await waitFor(() => localOne(calC.id, S.inv4), { timeout: 60_000 });
    const ics = await invitationPart(C.accountKey, S.inv4);
    if (!(await check("C (12.1) : l'invitation est dans son agenda et son message dans sa boîte de réception", local && ics, { local: Boolean(local), mail: Boolean(ics) }))) return;
    const answer = await H("itipAnswer", { calendarId: calC.id, ics, partstat: "TENTATIVE", sender: organizer.email, identity: who });
    const responses = await waitFor(async () => {
      const r = await responsesSince(seq, who, "old");
      return r.length ? r : null;
    }, { timeout: 60_000 });
    await quiet(C);
    await idle(C.id, 0, 60_000);
    const r = responses?.[0];
    await check(
      "C accepte provisoirement : un seul MeetingResponse, « provisoire » (2), sur le message d'invitation (12.1 n'en connaît pas d'autre), accepté",
      answer.ok && responses?.length === 1 && r.response === 2 && r.source === "mail" && r.request_id === inv.mail_id && r.status === "1",
      { answer, responses },
    );
    const parts = await waitFor(async () => {
      const p = await partsSince(seq, who, "old");
      return p.length ? p : null;
    }, { timeout: 30_000 });
    const reply = described(parts?.[0]);
    await check("… et une seule réponse REPLY/TENTATIVE à l'organisateur, par SendMail sur ce serveur-là", parts?.length === 1 && same(reply.to, [organizer.email]) && reply.inside === "REPLY" && same(reply.partstats, ["TENTATIVE"]) && same(reply.attendees, [who]), parts?.map((p) => ({ to: p.to, subject: p.subject })));
    await twoPasses(C);
    const kept = await localOne(calC.id, S.inv4);
    const onServer = await srvEvents(who, S.inv4, "old");
    await check("… un seul événement chez C, ici et sur le serveur", (await localCount(calC.id, S.inv4)) === 1 && onServer.length === 1 && onServer[0].response_type === 2, { local: await localCount(calC.id, S.inv4), server: onServer.map((x) => x.response_type) });
    // What the server sends back in 12.1 cannot say what the user answered (ResponseType exists from 14.0 on).
    if (partstatOf(kept, who) === "TENTATIVE") await check("… et il reste « provisoire » ici après les passages suivants", true);
    else {
      await gap(
        "ActiveSync 12.1 : la réponse part bien (MeetingResponse et REPLY), mais l'élément que le serveur renvoie ensuite ne peut pas dire ce que l'utilisateur a répondu (ResponseType n'existe qu'à partir de 14.0) : au passage suivant l'événement redevient « sans réponse » dans Thunderbird, qui propose de nouveau d'y répondre. CALENDAR-DESIGN ne dit pas où garder cette réponse en 12.1.",
        { partstat: partstatOf(kept, who), server: onServer.map((x) => x.response_type) },
      );
    }
    await check("… aucune erreur de protocole sur le serveur 12.1", !(await rpc("protocol_errors", { server: "old" })).length, await rpc("protocol_errors", { server: "old" }));
  });

  // (e) B: no mail synchronized, 14.1: the answer goes on the calendar item.
  await guard("invitation d'une boîte sans courrier", async () => {
    const who = E.bob.login;
    const [calB] = await calendarsOf(B);
    const seq = await seqNow();
    const inv = await mock("deliver_invitation", [who], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv5, start: iso(at(10, 14)), end: iso(at(10, 15)) });
    await syncNow(B);
    const local = await waitFor(() => localOne(calB.id, S.inv5), { timeout: 60_000 });
    if (!(await check("B (courrier décoché) : l'invitation est dans son agenda", local))) return;
    await H("uiEdit", { calendarId: calB.id, itemId: local.id, ops: [{ partstat: { id: attendeeId(local, who), value: "ACCEPTED" } }] });
    const responses = await waitFor(async () => {
      const r = await responsesSince(seq, who);
      return r.length ? r : null;
    }, { timeout: 60_000 });
    await quiet(B);
    const parts = await waitFor(async () => {
      const p = await partsSince(seq, who);
      return p.length ? p : null;
    }, { timeout: 30_000 });
    const reply = described(parts?.[0]);
    await check(
      "B accepte depuis l'événement : MeetingResponse sur l'élément d'agenda (sans courrier synchronisé), puis une réponse REPLY/ACCEPTED de Bob à l'organisateur",
      responses?.length === 1 && responses[0].source === "calendar" && responses[0].request_id === inv.calendar_id && responses[0].status === "1" && parts?.length === 1 && same(reply.to, [organizer.email]) && reply.sender === who && same(reply.attendees, [who]),
      { responses, parts: parts?.map((p) => ({ to: p.to, from: p.sender })) },
    );
    await check("… et rien n'est parti au nom de A pour cette invitation", !(await partsSince(seq, login)).length && !(await responsesSince(seq, login)).length);
  });

  // (i) One meeting, two mailboxes of this profile invited: the same UID in two calendars, each with its own answer.
  await guard("invitation commune à deux boîtes", async () => {
    const who = E.bob.login;
    const [calB] = await calendarsOf(B);
    const seq = await seqNow();
    const both = [{ email: login, name: "Alice Test", type: 1 }, { email: who, name: "Bob Test", type: 1 }];
    const invA = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.invShared, start: iso(at(13, 14)), end: iso(at(13, 15)), attendees: both });
    await mock("deliver_invitation", [who], { organizer: organizer.email, organizer_name: organizer.name, subject: S.invShared, start: iso(at(13, 14)), end: iso(at(13, 15)), attendees: both, uid: invA.uid });
    await syncNow(A);
    await syncNow(B);
    const inA = await waitFor(() => localOne(main.id, S.invShared), { timeout: 60_000 });
    const inB = await waitFor(() => localOne(calB.id, S.invShared), { timeout: 60_000 });
    await check("la même réunion (même UID) reçue par A et par B : un événement dans l'agenda de chacune, chacun sans réponse", inA && inB && inA.id === invA.uid && inB.id === invA.uid && partstatOf(inA, login) === "NEEDS-ACTION" && partstatOf(inB, who) === "NEEDS-ACTION", { a: inA?.attendees, b: inB?.attendees });
    if (!inA || !inB) return;
    await H("uiEdit", { calendarId: calB.id, itemId: inB.id, ops: [{ partstat: { id: attendeeId(inB, who), value: "ACCEPTED" } }] });
    const responses = await waitFor(async () => {
      const r = await responsesSince(seq, who);
      return r.length ? r : null;
    }, { timeout: 60_000 });
    await quiet(B);
    await twoPasses(B);
    await twoPasses(A);
    const stillA = await localOne(main.id, S.invShared);
    await check(
      "B accepte : seule la réponse de B part (MeetingResponse et REPLY de Bob), l'événement de A n'a pas bougé et A n'a rien envoyé",
      responses?.length === 1 && responses[0].status === "1" && partstatOf(await localOne(calB.id, S.invShared), who) === "ACCEPTED" && same(stillA, inA) && !(await responsesSince(seq, login)).length && !(await partsSince(seq, login)).length && (await partsSince(seq, who)).length === 1,
      { responses, a: stillA?.attendees },
    );
  });

  // (j) Accepted into the calendar of a secondary folder (the choice Thunderbird offers when several calendars
  // can take an invitation): the server keeps meetings in its default calendar. The design does not say what
  // becomes of the copy; what is reported here is what happens.
  await guard("invitation acceptée dans le second agenda", async () => {
    const { second } = await calendarsA(A);
    await mock("set_option", ["invitation_in_calendar", false]);
    try {
      const seq = await seqNow();
      const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.invOther, start: iso(at(13, 16)), end: iso(at(13, 17)) });
      await syncNow(A);
      const ics = await invitationPart(A.accountKey, S.invOther);
      if (!(await check("invitation absente de l'agenda, à accepter dans l'agenda du dossier secondaire", ics && second))) return;
      const answer = await H("itipAnswer", { calendarId: second.id, ics, partstat: "ACCEPTED", sender: organizer.email, identity: login });
      const responses = await waitFor(async () => {
        const r = await responsesSince(seq, login);
        return r.length ? r : null;
      }, { timeout: 60_000 });
      await quiet(A);
      await twoPasses(A);
      const where = { main: await localCount(main.id, S.invOther), second: await localCount(second.id, S.invOther) };
      const onServer = await srvEvents(login, S.invOther);
      const parts = await partsSince(seq, login);
      await check(
        "acceptée dans l'agenda du dossier secondaire : une seule réponse part (MeetingResponse sur le message, REPLY à l'organisateur), un seul élément sur le serveur, dans son agenda par défaut",
        answer.ok && responses?.length === 1 && responses[0].source === "mail" && responses[0].status === "1" && parts.length === 1 && onServer.length === 1 && onServer[0].folder_id === folders.calendar && onServer[0].uid === inv.uid,
        { answer, responses, server: onServer.map((e) => e.folder_id) },
      );
      const copy = await localOne(second.id, S.invOther);
      const boundSecond = await boundIds(A, second.id, folders.byName.get(FOLDERS.calendar));
      const adds = (await actionsSince(seq, login, ["sync_add"])).length;
      await check(
        "… ici l'élément du serveur arrive, accepté, dans l'agenda de la boîte ; la copie faite dans l'agenda secondaire n'est pas supprimée, elle y reste sans être envoyée au serveur (aucun ajout)",
        where.main === 1 && where.second === 1 && partstatOf(await localOne(main.id, S.invOther), login) === "ACCEPTED" && adds === 0 && boundSecond.length === (await srvEvents(login, S.localSecondary)).length + (await srvEvents(login, S.secondary)).length,
        { where, adds, boundSecond: boundSecond.length },
      );
      await info("acceptedElsewhere", { where, notices: notices.slice(-2).map((n) => n.message) });
      // (Removed by hand, as its user would: the steps that follow compare the calendars item by item.)
      if (copy) await H("userDelete", { calendarId: second.id, itemId: copy.id });
      await sleep(4000);
      await twoPasses(A);
      await check("… cette copie supprimée ensuite ici ne supprime rien sur le serveur", (await srvEvents(login, S.invOther)).length === 1 && (await localCount(main.id, S.invOther)) === 1);
    } finally {
      await mock("set_option", ["invitation_in_calendar", true]);
    }
  });

  // (k) "Do not send a response", and a status changed without Thunderbird asking to send anything: the server is
  // told (MeetingResponse), the organizer gets no message.
  await guard("réponses non demandées", async () => {
    for (const [title, how, when] of [[S.invSilent, "itip", 9], [S.invDirect, "direct", 11]]) {
      const seq = await seqNow();
      const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: title, start: iso(at(20, when)), end: iso(at(20, when + 1)) });
      await syncNow(A);
      const local = await waitFor(() => localOne(main.id, title), { timeout: 60_000 });
      const ics = await invitationPart(A.accountKey, title);
      if (!(await check(`invitation dans l'agenda (${how === "itip" ? "à accepter sans envoyer de réponse" : "dont le statut sera changé directement"})`, local && ics))) continue;
      if (how === "itip") await H("itipAnswer", { calendarId: main.id, ics, partstat: "ACCEPTED", sender: organizer.email, identity: login, mode: "NONE" });
      else await H("userEdit", { calendarId: main.id, itemId: local.id, ops: [{ partstat: { id: attendeeId(local, login), value: "ACCEPTED" } }] });
      const responses = await waitFor(async () => {
        const r = await responsesSince(seq, login);
        return r.length ? r : null;
      }, { timeout: 60_000 });
      await quiet(A);
      await twoPasses(A);
      await quiet(A);
      await check(
        how === "itip"
          ? "« Accepter » avec « ne pas envoyer de réponse » : le serveur est informé (un MeetingResponse), aucune réponse ne part vers l'organisateur"
          : "statut changé par un modifyItem direct (Thunderbird n'a demandé aucun envoi) : le serveur est informé (un MeetingResponse), aucune réponse ne part vers l'organisateur",
        responses?.length === 1 && responses[0].response === 1 && responses[0].status === "1" && responses[0].request_id === inv.calendar_id && !(await partsSince(seq, login)).length && !(await sendMailsSince(seq, login)).length && partstatOf(await localOne(main.id, title), login) === "ACCEPTED",
        { responses, parts: await partsSince(seq, login) },
      );
    }
  });

  // (n) The server rewrites the invitation while the user's answer is still held back by the module (about two
  // seconds): the server wins, and nothing at all is sent for that answer.
  await guard("invitation réécrite avant la réponse", async () => {
    const seq = await seqNow();
    const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.invRewritten, start: iso(at(21, 14)), end: iso(at(21, 15)) });
    await syncNow(A);
    const local = await waitFor(() => localOne(main.id, S.invRewritten), { timeout: 60_000 });
    if (!(await check("invitation dans l'agenda, avant sa réécriture", local))) return;
    const t0 = Date.now();
    await H("uiEdit", { calendarId: main.id, itemId: local.id, ops: [{ partstat: { id: attendeeId(local, login), value: "ACCEPTED" } }] });
    await mock("change_event", [login, 8, inv.calendar_id], { location: WHERE.gamma });
    ctx.runSync(A.id, { reason: "user" });
    const told = await noticed("calendarServerChanged", S.invRewritten, t0, 60_000);
    await quiet(A);
    await twoPasses(A);
    const now = await localOne(main.id, S.invRewritten);
    await check(
      "invitation réécrite par le serveur pendant que la réponse d'ici attendait : la version du serveur est montrée (sans réponse), l'utilisateur est averti, et rien n'est envoyé à personne (ni MeetingResponse, ni REPLY, ni changement)",
      told && now?.location === WHERE.gamma && partstatOf(now, login) === "NEEDS-ACTION" && !(await responsesSince(seq, login)).length && !(await partsSince(seq, login)).length && !(await actionsSince(seq, login, UPLOADS)).filter((x) => x.server_id === inv.calendar_id).length,
      { told: Boolean(told), local: now && { location: now.location, attendees: now.attendees }, responses: await responsesSince(seq, login), notices: notices.filter((n) => n.at >= t0).map((n) => n.message) },
    );
  });

  // (m) A later mail that reuses the meeting's UID under another organizer and another start: it is never the one answered.
  await guard("faux message d'invitation", async () => {
    await mock("set_option", ["invitation_in_calendar", false]);
    try {
      const seq = await seqNow();
      const mallory = "mallory@example.test";
      const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.invForged, start: iso(at(21, 9)), end: iso(at(21, 10)) });
      await syncNow(A);
      const ics = await invitationPart(A.accountKey, S.invForged);
      const forged = await mock("deliver_invitation", [login], { organizer: mallory, organizer_name: "Mallory", subject: `${S.invForged} (bis)`, start: iso(at(22, 9)), end: iso(at(22, 10)), uid: inv.uid });
      await syncNow(A);
      if (!(await check("invitation, puis message plus récent de même UID venu d'un autre organisateur, à une autre date", ics && forged.mail_id !== inv.mail_id))) return;
      const t0 = Date.now();
      await H("itipAnswer", { calendarId: main.id, ics, partstat: "ACCEPTED", sender: organizer.email, identity: login });
      await sleep(8000);
      await quiet(A);
      await twoPasses(A);
      const responses = await responsesSince(seq, login);
      const parts = (await partsSince(seq, login)).map(described);
      await check(
        "« Accepter » la vraie invitation : le faux message n'est jamais celui auquel on répond, et rien ne part vers son expéditeur",
        !responses.some((r) => r.request_id === forged.mail_id) && !parts.some((x) => x.to.includes(mallory) || x.organizer === mallory) && !(await sentRaw(seq, login)).some((m) => m.to.includes(mallory)),
        { responses, to: parts.map((x) => x.to) },
      );
      await info("forgedInvitationOutcome", { responses: responses.map((r) => ({ source: r.source, request: r.request_id, genuine: inv.mail_id, status: r.status })), replies: parts.map((x) => [x.inside, x.to]), notices: notices.filter((n) => n.at >= t0).map((n) => n.message), local: await localCount(main.id, S.invForged), server: (await srvEvents(login, S.invForged)).length });
      await check("… l'événement accepté reste dans l'agenda, une seule fois ici et sur le serveur", (await localCount(main.id, S.invForged)) === 1 && (await srvEvents(login, S.invForged)).length === 1, { local: await localCount(main.id, S.invForged), server: (await srvEvents(login, S.invForged)).length });
    } finally {
      await mock("set_option", ["invitation_in_calendar", true]);
    }
  });

  // (f) The event of an invitation deleted here: deleted on the server, and nothing is sent.
  await guard("événement d'une invitation supprimé", async () => {
    const seq = await seqNow();
    const inv = await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv6, start: iso(at(12, 14)), end: iso(at(12, 15)) });
    await syncNow(A);
    const local = await waitFor(() => localOne(main.id, S.inv6), { timeout: 60_000 });
    if (!(await check("invitation dans l'agenda, laissée sans réponse", local))) return;
    await H("uiDelete", { calendarId: main.id, itemId: local.id });
    const gone = await waitFor(async () => !(await srvEvents(login, S.inv6)).length, { timeout: 60_000 });
    await quiet(A);
    await twoPasses(A);
    const deletes = (await actionsSince(seq, login, ["sync_delete"])).filter((x) => x.server_id === inv.calendar_id);
    await check(
      "événement d'une invitation supprimé ici : supprimé de l'agenda du serveur, et rien n'est envoyé (ni MeetingResponse, ni réponse, ni question)",
      gone && deletes.length === 1 && !(await responsesSince(seq, login)).length && !(await partsSince(seq, login)).length && !(await sendMailsSince(seq, login)).length && ctx.meetings.current() === null && !(await localCount(main.id, S.inv6)),
      { deletes: deletes.length, responses: await responsesSince(seq, login) },
    );
  });

  // (g) A delegate's copy (MeetingMessageType 6, ActiveSync 14.1) is not to be answered.
  await guard("invitation déléguée", async () => {
    await mock("set_option", ["invitation_in_calendar", false]);
    try {
      const seq = await seqNow();
      await mock("deliver_invitation", [login], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv7, start: iso(at(13, 9)), end: iso(at(13, 10)), message_type: 6 });
      await syncNow(A);
      const ics = await invitationPart(A.accountKey, S.inv7);
      if (!(await check("copie d'une invitation déléguée (MeetingMessageType 6) : son message arrive", ics))) return;
      const t0 = Date.now();
      const answer = await H("itipAnswer", { calendarId: main.id, ics, partstat: "ACCEPTED", sender: organizer.email, identity: login });
      const told = await noticed("calendarReplyNotSent", S.inv7, t0, 60_000);
      await quiet(A);
      await idle(A.id, 0, 60_000);
      await twoPasses(A);
      const onServer = await srvEvents(login, S.inv7);
      await check(
        "« Accepter » sur cette copie : aucune réponse n'est envoyée (ni MeetingResponse, ni REPLY) et l'utilisateur en est averti (« aucune réponse envoyée à l'organisateur »)",
        answer.ok && told && !(await responsesSince(seq, login)).length && !(await partsSince(seq, login)).length && !(await sendMailsSince(seq, login)).length,
        { answer, told: Boolean(told), responses: await responsesSince(seq, login), notices: notices.filter((n) => n.at >= t0) },
      );
      await check("… l'événement ajouté n'est pas retiré : il reste dans l'agenda et y est synchronisé comme un événement ordinaire (un seul sur le serveur)", (await localCount(main.id, S.inv7)) === 1 && onServer.length === 1, { local: await localCount(main.id, S.inv7), server: onServer.length });
    } finally {
      await mock("set_option", ["invitation_in_calendar", true]);
    }
  });

  // (h) ActiveSync 12.1 without mail: the answer cannot be given, and the user is told why.
  await guard("invitation en 12.1 sans courrier", async () => {
    const who = E.carol.login;
    let mb = await mailboxById(C.id);
    const off = await saveAgain(mb, { sync: { ...mb.sync, mail: false } });
    mb = off.saved ?? mb;
    try {
      const [calC] = await calendarsOf(C);
      const seq = await seqNow("old");
      await mock("deliver_invitation", [who], { organizer: organizer.email, organizer_name: organizer.name, subject: S.inv8, start: iso(at(11, 9)), end: iso(at(11, 10)) }, "old");
      await syncNow(C);
      const local = await waitFor(() => localOne(calC.id, S.inv8), { timeout: 60_000 });
      if (!(await check("C, courrier décoché (12.1) : l'invitation est dans son agenda", off.ok && local, { saved: off.err }))) return;
      const t0 = Date.now();
      await H("uiEdit", { calendarId: calC.id, itemId: local.id, ops: [{ partstat: { id: attendeeId(local, who), value: "ACCEPTED" } }] });
      const told = await noticed("calendarAnswerNeedsMail", S.inv8, t0, 60_000);
      await quiet(C);
      await idle(C.id, 0, 60_000);
      const undone = await waitFor(async () => (partstatOf(await localOne(calC.id, S.inv8), who) === "NEEDS-ACTION" ? true : null), { timeout: 30_000 });
      await twoPasses(C);
      await check(
        "C accepte : la réponse est annulée avec une explication (le courrier doit être synchronisé), et rien n'est envoyé (ni MeetingResponse, ni REPLY)",
        told && undone && !(await responsesSince(seq, who, "old")).length && !(await partsSince(seq, who, "old")).length,
        { told: Boolean(told), undone: Boolean(undone), responses: await responsesSince(seq, who, "old"), notices: notices.slice(-2) },
      );
    } finally {
      const on = await saveAgain(mb, { sync: { ...mb.sync, mail: true } });
      await check("C : courrier recoché, synchronisation réussie", on.ok, { err: on.err, health: on.health });
    }
  });
}

// ── 5. Meetings organized ─────────────────────────────────────────────────

async function meetings({ A }) {
  await step("5. Réunions organisées");
  const login = E.alice.login;
  const bob = E.bob.login;
  const dave = PEOPLE.dave.email;
  const { main } = await calendarsA(A);
  const subjectOf = (kind, title) => browser.i18n.getMessage({ invite: "meetingSubjectInvite", update: "meetingSubjectUpdate", cancel: "meetingSubjectCancel" }[kind], [title]);
  const people = (list) => list.map((email) => ({ id: mailto(email), cn: email.split("@")[0] }));
  const expected = (kind, title, startMs, recipients) => ({ mailboxId: A.id, kind, summary: title, start: iso(startMs), allDay: false, recipients });
  let meetingId = null;
  let firstSequence = null;

  await guard("réunion créée, envoyée", async () => {
    const seq = await seqNow();
    meetingId = await H("uiAdd", {
      calendarId: main.id,
      notify: true,
      spec: { start: compact(PARIS, at(14, 9)), end: compact(PARIS, at(14, 10)), tzid: PARIS, organizer: { id: mailto(login), cn: "Alice Test" }, attendees: people([bob, dave]), ops: [{ title: S.meeting }, { location: WHERE.alpha }] },
    });
    const q = await question();
    await check("réunion créée ici avec deux participants : une question est posée, et elle dit exactement quoi (invitation, titre, début, destinataires)", same(asked(q), expected("invite", S.meeting, at(14, 9), [bob, dave])), asked(q));
    await check("… et de quelle boîte le message partira (l'adresse de A)", q?.from === login, q?.from);
    const onServer = await srvEvents(login, S.meeting);
    await check(
      "… l'événement est déjà synchronisé (réunion dont A est l'organisateur, avec ses participants), et rien n'est encore parti",
      onServer.length === 1 && same(sorted(onServer[0].attendees.map((x) => x.email)), sorted([bob, dave])) && lower(onServer[0].organizer_email ?? login) === login && (onServer[0].meeting_status & 1) === 1 && !(await partsSince(seq, null)).length && !(await sendMailsSince(seq, login)).length,
      onServer.map((e) => ({ attendees: e.attendees, organizer: e.organizer_email, status: e.meeting_status })),
    );
    if (!q) return;
    // The real window: what it shows, and its own "Send" button.
    const view = await confirmView(q);
    const shown = view ? shownBy(view) : null;
    await check("la fenêtre de confirmation de Sync443 est ouverte et montre ce titre et ces destinataires, tous", shown?.summary === S.meeting && same(shown.recipients, [bob, dave]) && Boolean(shown.question) && Boolean(shown.when), shown);
    await check("… la fenêtre montre aussi l'adresse de la boîte qui envoie (ligne « De »)", view?.document.getElementById("from")?.textContent === login, view?.document.getElementById("from")?.textContent);
    await info("confirmWindow", shown);
    if (view) view.document.getElementById("send").click();
    else ctx.meetings.answer(true);
    await quiet(A);
    const parts = await partsSince(seq, null);
    const m = described(parts[0]);
    firstSequence = m.sequence;
    await check(
      "« Envoyer » (le bouton de la fenêtre) : exactement un message, à ces deux destinataires et à personne d'autre, par SendMail de A",
      parts.length === 1 && parts[0].user === login && same(m.to, sorted([bob, dave])) && !m.others.length && m.sender === login && (await sendMailsSince(seq, login)).length === 1,
      parts.map((p) => ({ user: p.user, to: p.to, cc: p.cc, bcc: p.bcc })),
    );
    await check(
      "… une seule partie text/calendar : REQUEST, l'UID de l'événement, A pour organisateur, les deux participants, le bon début",
      m.count === 1 && m.events === 1 && lower(m.method) === "request" && m.inside === "REQUEST" && m.uid === meetingId && m.organizer === login && same(m.attendees, sorted([bob, dave])) && startIs(m.lines, at(14, 9)) && m.sequence >= 0,
      { method: m.method, events: m.events, uid: m.uid, expected: meetingId, organizer: m.organizer, attendees: m.attendees, start: icsLine(m.lines, "DTSTART"), sequence: m.sequence },
    );
    const raw = await sentRaw(seq, login);
    await check("… son en-tête To ne porte que des adresses (aucun nom affiché)", raw.length === 1 && same(raw[0].to.split(",").map((x) => x.trim().toLowerCase()).sort(), sorted([bob, dave])), raw.map((m) => m.to));
    const sent = (await rpc("sent", { login })).filter((x) => x.subject === subjectOf("invite", S.meeting));
    await check("… sujet du catalogue (« Invitation : … »), copie gardée dans les Éléments envoyés du serveur", sent.length === 1 && sent[0].status === "1" && sent[0].save_in_sent && Boolean(sent[0].sent_copy), sent);
    await twoPasses(A);
    await check("… rien de plus aux passages suivants : pas d'autre question, pas d'autre message, un seul événement", ctx.meetings.current() === null && (await partsSince(seq, null)).length === 1 && (await srvEvents(login, S.meeting)).length === 1 && (await localCount(main.id, S.meeting)) === 1);
  });

  await guard("réunion déplacée", async () => {
    if (!meetingId) return;
    const seq = await seqNow();
    await H("uiEdit", { calendarId: main.id, itemId: meetingId, notify: true, ops: [{ shift: 60 }] });
    const q = await question();
    await check("réunion déplacée d'une heure : la question annonce une mise à jour, avec la nouvelle heure, pour les deux participants", same(asked(q), expected("update", S.meeting, at(14, 10), [bob, dave])), asked(q));
    await check("… le serveur a déjà la nouvelle heure", (await srvEvents(login, S.meeting))[0]?.start === iso(at(14, 10)));
    ctx.meetings.answer(true);
    await quiet(A);
    const parts = await partsSince(seq, null);
    const m = described(parts[0]);
    await check(
      "« Envoyer » : exactement une mise à jour (REQUEST, même UID, SEQUENCE plus grande, nouvelle heure) aux deux participants, sous le sujet « Invitation mise à jour : … »",
      parts.length === 1 && same(m.to, sorted([bob, dave])) && m.inside === "REQUEST" && m.uid === meetingId && m.sequence > firstSequence && startIs(m.lines, at(14, 10)) && m.subject === subjectOf("update", S.meeting),
      { to: m.to, method: m.inside, sequence: [firstSequence, m.sequence], start: icsLine(m.lines, "DTSTART"), subject: m.subject },
    );
    firstSequence = m.sequence;
  });

  await guard("participant retiré", async () => {
    if (!meetingId) return;
    const seq = await seqNow();
    const local = await localOne(main.id, S.meeting);
    await H("uiEdit", { calendarId: main.id, itemId: meetingId, notify: true, ops: [{ removeAttendee: attendeeId(local, dave) }] });
    const q1 = await question();
    await check("un participant retiré : première question, une mise à jour pour celui qui reste", same(asked(q1), expected("update", S.meeting, at(14, 10), [bob])), asked(q1));
    const token = q1?.token;
    ctx.meetings.answer(true);
    const q2 = await waitFor(() => (ctx.meetings.current()?.token !== token ? ctx.meetings.current() : null), { timeout: 30_000, interval: 150 });
    await check("… puis seconde question, une annulation pour celui qui a été retiré", same(asked(q2), expected("cancel", S.meeting, at(14, 10), [dave])), asked(q2));
    ctx.meetings.answer(true);
    await quiet(A);
    const parts = (await partsSince(seq, null)).map(described);
    const update = parts.find((p) => p.inside === "REQUEST");
    const cancel = parts.find((p) => p.inside === "CANCEL");
    await check(
      "« Envoyer » deux fois : deux messages en tout, un REQUEST pour celui qui reste (seul participant listé), un CANCEL pour le retiré",
      parts.length === 2 && same(update?.to, [bob]) && same(update.attendees, [bob]) && same(cancel?.to, [dave]) && lower(cancel.method) === "cancel" && cancel.uid === meetingId && update.uid === meetingId && update.sequence > firstSequence && cancel.subject === subjectOf("cancel", S.meeting),
      parts.map((p) => ({ to: p.to, method: p.inside, attendees: p.attendees, sequence: p.sequence, subject: p.subject })),
    );
    await check("… le serveur n'a plus que le participant qui reste", same(sorted(((await srvEvents(login, S.meeting))[0]?.attendees ?? []).map((x) => x.email)), [bob]));
  });

  await guard("réunion supprimée", async () => {
    if (!meetingId) return;
    const seq = await seqNow();
    await H("uiDelete", { calendarId: main.id, itemId: meetingId });
    const q = await question();
    await check("réunion supprimée ici : la question annonce une annulation, pour le participant restant", same(asked(q), expected("cancel", S.meeting, at(14, 10), [bob])), asked(q));
    await check("… elle est déjà supprimée du serveur", !(await srvEvents(login, S.meeting)).length);
    ctx.meetings.answer(true);
    await quiet(A);
    const parts = (await partsSince(seq, null)).map(described);
    await check("« Envoyer » : exactement une annulation (CANCEL, même UID) à ce participant", parts.length === 1 && same(parts[0].to, [bob]) && parts[0].inside === "CANCEL" && parts[0].uid === meetingId && parts[0].organizer === login, parts.map((p) => ({ to: p.to, method: p.inside })));
  });

  // Don't send, a window closed, a question that expires: nothing leaves.
  let quietId = null;
  await guard("réunion non envoyée", async () => {
    const seq = await seqNow();
    quietId = await H("uiAdd", {
      calendarId: main.id,
      notify: true,
      spec: { start: compact(PARIS, at(15, 9)), end: compact(PARIS, at(15, 10)), tzid: PARIS, organizer: { id: mailto(login), cn: "Alice Test" }, attendees: people([bob, PEOPLE.frank.email]), ops: [{ title: S.meetingNoSend }] },
    });
    const q = await question();
    await check("seconde réunion : question d'invitation", same(asked(q), expected("invite", S.meetingNoSend, at(15, 9), [bob, PEOPLE.frank.email])), asked(q));
    if (!q) return;
    const view = await confirmView(q);
    if (view) view.document.getElementById("dont-send").click();
    else ctx.meetings.answer(false);
    await quiet(A);
    await twoPasses(A);
    await quiet(A);
    const onServer = await srvEvents(login, S.meetingNoSend);
    await check("« Ne pas envoyer » (le bouton de la fenêtre) : rien ne part (aucun SendMail, aucune partie d'agenda), et la question n'est pas reposée", !(await partsSince(seq, null)).length && !(await sendMailsSince(seq, login)).length && ctx.meetings.current() === null && (await ctx.entries.get(A.id).calendar.scheduler.pending()) === 0, await partsSince(seq, null));
    await check("… l'événement reste comme enregistré, synchronisé avec ses participants", onServer.length === 1 && same(sorted(onServer[0].attendees.map((x) => x.email)), sorted([bob, PEOPLE.frank.email])) && (await localCount(main.id, S.meetingNoSend)) === 1, onServer.map((e) => e.attendees));

    // The window closed without an answer.
    const seq2 = await seqNow();
    await H("uiEdit", { calendarId: main.id, itemId: quietId, notify: true, ops: [{ shift: 60 }] });
    const q2 = await question();
    await check("réunion déplacée : question de mise à jour", same(asked(q2), expected("update", S.meetingNoSend, at(15, 10), [bob, PEOPLE.frank.email])), asked(q2));
    await confirmView(q2);
    const win = q2 ? await windowOf(q2.url) : null;
    if (win) await browser.windows.remove(win.id);
    const closed = await waitFor(() => ctx.meetings.current() === null, { timeout: 15_000, interval: 150 });
    await quiet(A);
    await twoPasses(A);
    await check("fenêtre fermée sans réponse : la question est close, rien ne part, et elle n'est pas reposée", win && closed && !(await partsSince(seq2, null)).length && !(await sendMailsSince(seq2, login)).length && ctx.meetings.current() === null, { window: Boolean(win), closed: Boolean(closed) });
    await check("… le changement, lui, est synchronisé", (await srvEvents(login, S.meetingNoSend))[0]?.start === iso(at(15, 10)));

    // A question nobody answers: its token runs out.
    const seq3 = await seqNow();
    ctx.testConfig.confirmTtlMs = 4000;
    let q3 = null;
    const tExpire = Date.now();
    try {
      await H("uiEdit", { calendarId: main.id, itemId: quietId, notify: true, ops: [{ location: WHERE.beta }] });
      q3 = await question();
      await check("lieu changé : question de mise à jour, laissée sans réponse", same(asked(q3), expected("update", S.meetingNoSend, at(15, 10), [bob, PEOPLE.frank.email])), asked(q3));
      const expired = await waitFor(() => ctx.meetings.current() === null, { timeout: 20_000, interval: 150 });
      await quiet(A);
      await check("jeton expiré (durée de vie raccourcie pour le test) : la question se clôt d'elle-même", expired);
      await check("… et l'utilisateur est averti que le message n'a pas été envoyé faute de réponse à temps", await noticed("calendarNotSentExpired", S.meetingNoSend, tExpire, 20_000), notices.filter((n) => n.at >= tExpire));
    } finally {
      delete ctx.testConfig.confirmTtlMs;
    }
    // The stale address, opened again: its page has nothing to send.
    if (q3) {
      const stale = await browser.windows.create({ url: q3.url, type: "popup", width: 520, height: 440 });
      const over = await waitFor(() => {
        const v = browser.extension.getViews().find((w) => {
          try {
            return w.location.href === q3.url;
          } catch {
            return false;
          }
        });
        return v && !v.document.getElementById("over").hidden ? v : null;
      }, { timeout: 15_000, interval: 150 });
      await check("… la page rouverte avec ce jeton mort ne propose plus d'envoyer (question close)", over && over.document.getElementById("ask").hidden, { opened: Boolean(over) });
      await browser.windows.remove(stale.id).catch(() => {});
    }
    await twoPasses(A);
    await check("… rien n'est parti, rien n'est reposé", !(await partsSince(seq3, null)).length && !(await sendMailsSince(seq3, login)).length && ctx.meetings.current() === null && (await ctx.entries.get(A.id).calendar.scheduler.pending()) === 0);
  });

  // A change that comes from the server never asks nor sends.
  await guard("réunion changée par le serveur", async () => {
    const seq = await seqNow();
    const [e] = await srvEvents(login, S.serverMeeting);
    await mock("change_event", [login, 8, e.server_id], { subject: S.serverMeetingChanged, start: iso(at(3, 14)), end: iso(at(3, 15)), location: WHERE.gamma });
    await mock("set_attendee_status", [login, 8, e.server_id, bob, "accepted"]);
    await syncNow(A);
    const moved = await waitFor(() => localOne(main.id, S.serverMeetingChanged), { timeout: 60_000 });
    await check("réunion de A changée sur le serveur (titre, heure, lieu, réponse d'un participant) : appliquée ici", moved?.start.utc === iso(at(3, 14)) && moved.location === WHERE.gamma && partstatOf(moved, bob) === "ACCEPTED", moved && { start: moved.start, attendees: moved.attendees });
    await mock("cancel_meeting", [login, 8, e.server_id]);
    await syncNow(A);
    const cancelled = await waitFor(async () => ((await localOne(main.id, S.serverMeetingChanged))?.status === "CANCELLED" ? true : null), { timeout: 60_000 });
    await check("… puis annulée sur le serveur : annulée ici", cancelled, (await localOne(main.id, S.serverMeetingChanged))?.status);
    await twoPasses(A);
    await quiet(A);
    await check(
      "… jamais de question, jamais de message : aucun SendMail, aucune partie d'agenda, rien en attente, rien renvoyé au serveur",
      ctx.meetings.current() === null && !ctx.meetings.waiting().length && (await ctx.entries.get(A.id).calendar.scheduler.pending()) === 0 && !(await partsSince(seq, null)).length && !(await sendMailsSince(seq, login)).length && !(await actionsSince(seq, login, UPLOADS)).filter((x) => x.server_id === e.server_id).length,
      { parts: await partsSince(seq, null), uploads: (await actionsSince(seq, login, UPLOADS)).filter((x) => x.server_id === e.server_id) },
    );
  });

  // More than 100 attendees.
  // Every attendee removed from one's own meeting, nothing else changed: a cancellation is proposed to those who were invited.
  await guard("réunion vidée de ses participants", async () => {
    const seq = await seqNow();
    const id = await H("uiAdd", {
      calendarId: main.id,
      notify: true,
      spec: { start: compact(PARIS, at(15, 14)), end: compact(PARIS, at(15, 15)), tzid: PARIS, organizer: { id: mailto(login), cn: "Alice Test" }, attendees: people([PEOPLE.frank.email]), ops: [{ title: S.meetingEmptied }] },
    });
    if (!(await check("troisième réunion : question d'invitation, envoyée", (await question())?.kind === "invite"))) return;
    ctx.meetings.answer(true);
    await quiet(A);
    const local = await localOne(main.id, S.meetingEmptied);
    await H("uiEdit", { calendarId: main.id, itemId: id, notify: true, ops: [{ removeAttendee: attendeeId(local, PEOPLE.frank.email) }] });
    const q = await question();
    await check("son seul participant retiré : la question propose une annulation, pour lui", same(asked(q), expected("cancel", S.meetingEmptied, at(15, 14), [PEOPLE.frank.email])), asked(q));
    ctx.meetings.answer(true);
    await quiet(A);
    const parts = (await partsSince(seq, null)).map(described);
    const onServer = await srvEvents(login, S.meetingEmptied);
    await check(
      "« Envoyer » : un CANCEL part vers l'ancien participant (après l'invitation), et l'événement reste, sans participant, ici et sur le serveur",
      parts.length === 2 && parts[1].inside === "CANCEL" && same(parts[1].to, [PEOPLE.frank.email]) && parts[1].uid === id && onServer.length === 1 && !(onServer[0].attendees ?? []).length && (await localCount(main.id, S.meetingEmptied)) === 1,
      { parts: parts.map((x) => [x.inside, x.to]), server: onServer.map((e) => e.attendees) },
    );
  });

  // More than 100 attendees.
  await guard("réunion de 101 participants", async () => {
    const seq = await seqNow();
    const t0 = Date.now();
    const crowd = Array.from({ length: 101 }, (_, i) => `participant${String(i + 1).padStart(3, "0")}@example.test`);
    const crowdId = await H("uiAdd", {
      calendarId: main.id,
      notify: true,
      spec: { start: compact(PARIS, at(16, 9)), end: compact(PARIS, at(16, 10)), tzid: PARIS, organizer: { id: mailto(login), cn: "Alice Test" }, attendees: people(crowd), ops: [{ title: S.meetingCrowd }] },
    });
    const told = await noticed("calendarKeptLocalTooManyAttendees", S.meetingCrowd, t0, 60_000);
    await idle(A.id, 0, 60_000);
    await check("réunion de 101 participants créée ici : refusée, avec une notification qui donne la limite (100) et dit qu'elle reste comme copie locale", told && told.message.includes("100"), notices.filter((n) => n.at >= t0));
    await twoPasses(A);
    const kept = await localOne(main.id, S.meetingCrowd);
    await check(
      "… avant tout envoi : rien n'est créé sur le serveur, aucune question, aucun message ; l'événement n'est pas supprimé d'ici, il reste avec ses 101 participants, détaché (plus rien n'est tenté pour lui)",
      kept?.attendees.length === 101 && !(await srvEvents(login, S.meetingCrowd)).length && !(await actionsSince(seq, login, ["sync_add"])).length && ctx.meetings.current() === null && !(await partsSince(seq, null)).length && !(await sendMailsSince(seq, login)).length && notices.filter((n) => n.at >= t0).length === 1,
      { local: kept?.attendees.length ?? null, server: (await srvEvents(login, S.meetingCrowd)).length, notices: notices.filter((n) => n.at >= t0).length },
    );
    // The local copy is the user's to remove: nothing is said to the server.
    await H("uiDelete", { calendarId: main.id, itemId: crowdId });
    await sleep(6000);
    await twoPasses(A);
    await check("… la copie locale supprimée ensuite par l'utilisateur disparaît sans rien envoyer", !(await localCount(main.id, S.meetingCrowd)) && !(await actionsSince(seq, login, UPLOADS)).length && ctx.meetings.current() === null, await actionsSince(seq, login, UPLOADS));

    // An existing meeting brought over the limit: the change is undone, the meeting stays as the server has it.
    const noSend = await localOne(main.id, S.meetingNoSend);
    if (noSend) {
      const seq2 = await seqNow();
      const t1 = Date.now();
      await H("uiEdit", { calendarId: main.id, itemId: noSend.id, notify: true, ops: [{ addAttendees: people(crowd) }] });
      const told2 = await noticed("calendarTooManyAttendees", S.meetingNoSend, t1, 60_000);
      await idle(A.id, 0, 60_000);
      const back = await waitFor(async () => ((await localOne(main.id, S.meetingNoSend))?.attendees.length === 2 ? true : null), { timeout: 30_000 });
      await twoPasses(A);
      await check(
        "réunion existante portée à 103 participants : le changement est annulé (elle retrouve ses 2 participants), avec la notification de la limite, et rien n'est envoyé",
        told2 && told2.message.includes("100") && back && !(await actionsSince(seq2, login, UPLOADS)).length && ctx.meetings.current() === null && !(await partsSince(seq2, null)).length,
        { told: Boolean(told2), attendees: (await localOne(main.id, S.meetingNoSend))?.attendees.length, uploads: await actionsSince(seq2, login, UPLOADS) },
      );
    }
  });

  // Control: the same kind of change in a calendar of the user's own does reach a transport of Thunderbird.
  await guard("témoin d'envoi", async () => {
    const before = (await H("sendingSeen")).transports.length;
    await H("uiAdd", {
      calendarId: userCalendar.id,
      notify: true,
      spec: { id: "user-control", start: compact(PARIS, at(2, 12)), end: compact(PARIS, at(2, 13)), tzid: PARIS, organizer: { id: mailto(PEOPLE.me.email), cn: PEOPLE.me.name }, attendees: [{ id: mailto(PEOPLE.guest.email), cn: PEOPLE.guest.name }], ops: [{ title: S.userControl }] },
    });
    const after = (await H("sendingSeen")).transports;
    await check("témoin : la même création dans l'agenda personnel (hors Sync443) est bien remise par Thunderbird à son transport de courrier (retenue par le test, non envoyée)", after.length === before + 1 && after.at(-1).calendarId === userCalendar.id, after.slice(before));
    await H("userDelete", { calendarId: userCalendar.id, itemId: "user-control" });
  });
}

// ── 6. Settings ───────────────────────────────────────────────────────────

async function settings({ A }) {
  await step("6. Réglages : période de l'agenda, filtre des tâches, éléments décochés");
  const login = E.alice.login;
  let mb = await mailboxById(A.id);
  const { main, second } = await calendarsA(A);
  const folders = await pimFolders(login);
  const now = Date.now();
  for (const [subject, days] of [[S.past10, 10], [S.past60, 60], [S.past400, 400]]) {
    await mock("add_event", [login, 8], { subject, start: iso(now - days * DAY), end: iso(now - days * DAY + HOUR) });
  }
  await syncNow(A);
  const counts = async () => Object.fromEntries(await Promise.all([S.past10, S.past60, S.past400].map(async (s) => [s, await localCount(main.id, s)])));
  let c = await counts();
  await check("période par défaut (6 mois) : les événements d'il y a 10 et 60 jours arrivent, pas celui d'il y a 400 jours", c[S.past10] === 1 && c[S.past60] === 1 && c[S.past400] === 0, c);

  const server = await serverState(login);
  /** One change of settings: restarted collections, filters sent, what is here before and after, nothing changed on the server. */
  const change = async (label, overrides, { restarted, filter, removed = [], added = [] }) => {
    const before = { main: await titlesOf(main.id), second: await titlesOf(second.id) };
    const seq = await seqNow();
    const r = await saveAgain(mb, overrides);
    mb = r.saved ?? mb;
    await syncNow(A);
    const syncs = (await rpc("requests", { since: seq, login, device_id: A.deviceId })).filter((x) => x.cmd === "Sync");
    const zero = new Set(syncs.flatMap((x) => (x.collections ?? []).filter(([, key]) => key === "0").map(([cid]) => cid)));
    const filters = syncs.flatMap((x) => (x.filters ?? []).filter(([cid]) => restarted.includes(cid)).map(([, ft]) => ft));
    await check(`${label} : enregistré sans erreur, synchronisation réussie`, r.ok, { err: r.err, health: r.health });
    await check(`… les dossiers concernés repartent de zéro (SyncKey 0), avec le nouveau filtre (FilterType ${filter}), et eux seuls`, restarted.every((cid) => zero.has(cid)) && [...zero].every((cid) => restarted.includes(cid)) && filters.length > 0 && filters.every((ft) => ft === filter), { zero: [...zero], restarted, filters: [...new Set(filters)] });
    const expected = [...before.main.filter((t) => !removed.includes(t)), ...added].sort();
    const after = { main: await titlesOf(main.id), second: await titlesOf(second.id) };
    await check("… ici : aucun doublon, aucune perte (exactement les éléments attendus, une fois chacun)", same(after.main, expected) && same(after.second, before.second), { missing: expected.filter((t) => !after.main.includes(t)), extra: after.main.filter((t) => !expected.includes(t)) });
    const ups = (await actionsSince(seq, login, UPLOADS)).filter((x) => folders.ids.includes(x.collection_id));
    await check("… sur le serveur : rien n'est supprimé ni modifié (mêmes éléments, mêmes versions, aucune commande envoyée)", same(await serverState(login), server) && !ups.length, ups);
  };

  await change("période de l'agenda passée à « 2 semaines »", { calendarPeriod: "4" }, { restarted: folders.events, filter: "4", removed: [`event:${S.past60}`] });
  await change("période de l'agenda passée à « tout »", { calendarPeriod: "0" }, { restarted: folders.events, filter: "0", added: [`event:${S.past60}`, `event:${S.past400}`] });
  await change("période de l'agenda revenue à « 6 mois »", { calendarPeriod: "7" }, { restarted: folders.events, filter: "7", removed: [`event:${S.past400}`] });
  const doneTasks = (await itemsOf(main.id)).filter((i) => i.kind === "task" && i.completed).map((i) => `task:${i.title}`);
  await check("(des tâches terminées sont là pour le filtre)", doneTasks.length >= 1, doneTasks);
  await change("filtre des tâches passé à « non terminées seulement »", { taskFilter: "8" }, { restarted: folders.taskIds, filter: "8", removed: doneTasks });
  await change("filtre des tâches revenu à « toutes »", { taskFilter: "0" }, { restarted: folders.taskIds, filter: "0", added: doneTasks });

  // The calendar unchecked, then checked again.
  const before = { main: await titlesOf(main.id), second: await titlesOf(second.id) };
  const seq = await seqNow();
  let r = await saveAgain(mb, { sync: { ...mb.sync, calendar: false } });
  mb = r.saved ?? mb;
  await syncNow(A);
  const list = await calendarsOf(A);
  const left = await titlesOf(main.id);
  await check("agenda décoché (tâches gardées) : enregistré sans erreur", r.ok && mb.sync.calendar === false && mb.sync.tasks === true, { err: r.err, sync: mb.sync });
  await check(
    "… les événements quittent Thunderbird (l'agenda de la boîte ne garde que ses tâches, celui du dossier d'agenda disparaît), les tâches restent",
    same(left, before.main.filter((t) => t.startsWith("task:"))) && !named(list, FOLDERS.calendar) && named(list, FOLDERS.tasks) && named(list, A.name),
    { left, calendars: list.map((x) => x.name) },
  );
  const info1 = (await H("calendarInfo", { calendarId: main.id, properties: ["capabilities.events.supported", "capabilities.tasks.supported"] })).values;
  await check("… l'agenda de la boîte n'accepte plus que des tâches", info1["capabilities.events.supported"] === false && info1["capabilities.tasks.supported"] === true, info1);
  const seqOff = await seqNow();
  await twoPasses(A);
  const askedOff = await rpc("collections_requested", { login, device_id: A.deviceId, since: seqOff });
  await check("… plus aucun dossier d'agenda n'est demandé au serveur, et rien n'y est supprimé", !askedOff.some((id) => folders.events.includes(id)) && same(await serverState(login), server) && !(await actionsSince(seq, login, UPLOADS)).filter((x) => folders.ids.includes(x.collection_id)).length, { asked: askedOff });

  r = await saveAgain(mb, { sync: { ...mb.sync, calendar: true } });
  mb = r.saved ?? mb;
  await syncNow(A);
  const again = await calendarsA(A);
  const now6 = { main: await titlesOf(again.main.id), second: again.second ? await titlesOf(again.second.id) : null };
  await check("agenda recoché : enregistré sans erreur, l'agenda du dossier secondaire revient", r.ok && Boolean(again.second), { err: r.err, calendars: again.list.map((x) => x.name) });
  await check(
    "… chaque événement revient une seule fois, les tâches n'ont pas bougé, rien n'a changé sur le serveur",
    same(await titlesOf(again.main.id), before.main) && again.second && same(await titlesOf(again.second.id), before.second) && same(await serverState(login), server) && !(await actionsSince(seq, login, UPLOADS)).filter((x) => folders.ids.includes(x.collection_id)).length,
    { missing: before.main.filter((t) => !now6.main.includes(t)), extra: now6.main.filter((t) => !before.main.includes(t)), second: [before.second, now6.second] },
  );
  await check("… l'agenda de la boîte accepte de nouveau les événements, sous le même identifiant", again.main.id === main.id && (await H("calendarInfo", { calendarId: main.id, properties: ["capabilities.events.supported"] })).values["capabilities.events.supported"] === true);

  // An event that leaves the period by itself (SoftDelete): its copy goes, and that is no deletion.
  const softId = await mock("add_event", [login, 8], { subject: S.pastSoft, start: iso(now - 10 * DAY), end: iso(now - 10 * DAY + HOUR) });
  await syncNow(A);
  const wasThere = (await localCount(main.id, S.pastSoft)) === 1;
  const seqSoft = await seqNow();
  await mock("change_event", [login, 8, softId], { start: iso(now - 200 * DAY), end: iso(now - 200 * DAY + HOUR) });
  await syncNow(A);
  const aged = await waitFor(async () => ((await localCount(main.id, S.pastSoft)) === 0 ? true : null), { timeout: 60_000 });
  await twoPasses(A);
  const held = await ctx.entries.get(A.id).sync.pendingDeletes();
  const h = await health(A.id);
  await check(
    "événement qui sort de la période (daté sur le serveur d'il y a 200 jours) : sa copie quitte Thunderbird, sans compter comme une suppression, et reste sur le serveur",
    wasThere && aged && held.count === 0 && !h.blocked && (await srvEvents(login, S.pastSoft)).length === 1 && !(await actionsSince(seqSoft, login, UPLOADS)).filter((x) => x.server_id === softId).length,
    { wasThere, aged: Boolean(aged), held, server: (await srvEvents(login, S.pastSoft)).length },
  );
}

// ── 7. Mass deletion held ─────────────────────────────────────────────────

/** The settings page, open in a tab, once it lists this mailbox: its window. */
async function settingsPage(mb) {
  const url = browser.runtime.getURL("options/options.html");
  await browser.runtime.openOptionsPage();
  return waitFor(() => {
    const v = browser.extension.getViews({ type: "tab" }).find((w) => w.location.href.startsWith(url));
    return v?.document.getElementById(`mb-${mb.id}-name`) ? v : null;
  }, { timeout: 30_000 });
}

/** The row of a mailbox in the settings page: its status and its buttons for held deletions. */
function rowOf(view, mb) {
  const li = view.document.getElementById(`mb-${mb.id}-name`)?.closest("li");
  const mass = li?.querySelector(".mb-mass");
  return { status: li?.querySelector(".mb-status")?.textContent ?? "", tone: li?.querySelector(".mb-status")?.className ?? "", massShown: mass ? !mass.hidden : false, buttons: [...(mass?.querySelectorAll("button") ?? [])] };
}

async function massDeletion({ A }) {
  await step("7. Suppression en masse retenue");
  const login = E.alice.login;
  const view = await settingsPage(A);
  if (!(await check("page de réglages ouverte, la boîte A listée", view))) return;

  const run = async (name, title, confirm) => {
    const folderId = await mock("add_folder", [login, name], { type_: 13 });
    for (let n = 1; n <= 60; n++) {
      await mock("add_event", [login, folderId], { subject: `${title} ${String(n).padStart(2, "0")}`, start: iso(at(20 + (n % 20), 8 + (n % 8))), end: iso(at(20 + (n % 20), 9 + (n % 8))) });
    }
    await syncNow(A);
    const calendar = await waitFor(async () => named(await calendarsOf(A), name), { timeout: 60_000 });
    const all = calendar ? await itemsOf(calendar.id) : [];
    await check(`dossier d'agenda « ${name} » de 60 événements : son agenda ici, complet (lots de 50)`, all.length === 60, all.length);
    if (!calendar) return;
    const seq = await seqNow();
    const doomed = await mock("mass_delete", [login, folderId, 55]);
    ctx.runSync(A.id, { reason: "user" }); // (the Ping may have started this pass already)
    const blocked = await waitFor(async () => ((await health(A.id)).blocked?.code === "MASS_DELETE" ? await health(A.id) : null), { timeout: 90_000 });
    await waitFor(() => !ctx.entries.get(A.id)?.inFlight, { timeout: 60_000, interval: 200 });
    const pending = await ctx.entries.get(A.id).sync.pendingDeletes();
    await check("le serveur supprime 55 événements sur 60 : boîte suspendue (MASS_DELETE), 55 suppressions retenues, toutes d'agenda", blocked && doomed.length === 55 && pending.count === 55 && pending.calendar === 55, { blocked: (await health(A.id)).blocked, pending });
    await check("… rien n'est supprimé ici (60 événements)", (await itemsOf(calendar.id)).length === 60);
    const shown = await waitFor(() => (rowOf(view, A).massShown ? rowOf(view, A) : null), { timeout: 30_000 });
    await check(
      "… la page de réglages le dit dans l'état de la boîte (55 éléments), et propose « Confirmer les suppressions » et « Garder les copies locales »",
      shown?.status === browser.i18n.getMessage("statusMassDelete", ["55"]) && same(shown.buttons.map((b) => b.textContent), [browser.i18n.getMessage("confirmDeletes"), browser.i18n.getMessage("keepLocalCopies")]),
      shown && { status: shown.status, buttons: shown.buttons.map((b) => b.textContent) },
    );
    if (!shown) return;
    if (confirm) {
      shown.buttons[0].click();
      const applied = await waitFor(async () => ((await itemsOf(calendar.id)).length === 5 && !(await health(A.id)).blocked ? true : null), { timeout: 120_000 });
      await idle(A.id, 0, 60_000);
      const left = await ctx.entries.get(A.id).sync.pendingDeletes();
      await check("« Confirmer les suppressions » (le bouton de la page) : les 55 événements sont retirés, il en reste 5, la boîte repart", applied && left.count === 0, { local: (await itemsOf(calendar.id)).length, blocked: (await health(A.id)).blocked, left });
      await check("… la page ne propose plus rien à confirmer", await waitFor(() => !rowOf(view, A).massShown, { timeout: 30_000 }));
    } else {
      // The page asks "are you sure?" in a dialog of the browser: answered yes, as the user would.
      view.confirm = () => true;
      shown.buttons[1].click();
      const kept = await waitFor(async () => (!(await health(A.id)).blocked && (await ctx.entries.get(A.id).sync.pendingDeletes()).count === 0 ? true : null), { timeout: 120_000 });
      await idle(A.id, 0, 60_000);
      await twoPasses(A);
      const local = await itemsOf(calendar.id);
      const bound = await boundIds(A, calendar.id, folderId);
      await check("« Garder les copies locales » (le bouton de la page) : la boîte repart, les 60 événements restent ici", kept && local.length === 60, { local: local.length, blocked: (await health(A.id)).blocked });
      await check("… les 55 copies gardées sont détachées du serveur (5 éléments encore liés), et rien n'est renvoyé au serveur (ni ajout ni suppression)", bound.length === 5 && (await allEvents(login, folderId)).length === 5 && !(await actionsSince(seq, login, UPLOADS)).filter((x) => x.collection_id === folderId).length, { bound: bound.length, server: (await allEvents(login, folderId)).length });
    }
    const h = await health(A.id);
    await check("… la boîte est saine ensuite", !h.blocked && !h.lastError, h);
  };

  await guard("suppressions confirmées", () => run(FOLDERS.mass, S.mass, true));
  await guard("suppressions refusées", () => run(FOLDERS.mass2, S.mass2, false));
  await guard("sorties de période en masse", async () => {
    const now = Date.now();
    const folderId = await mock("add_folder", [login, FOLDERS.mass3], { type_: 13 });
    const ids = [];
    for (let n = 1; n <= 60; n++) ids.push(await mock("add_event", [login, folderId], { subject: `${S.softMass} ${String(n).padStart(2, "0")}`, start: iso(now - 10 * DAY + n * MINUTE), end: iso(now - 10 * DAY + n * MINUTE + HOUR) }));
    await syncNow(A);
    const calendar = await waitFor(async () => named(await calendarsOf(A), FOLDERS.mass3), { timeout: 60_000 });
    if (!(await check("troisième dossier de 60 événements, d'il y a 10 jours", calendar && (await itemsOf(calendar.id)).length === 60))) return;
    const seq = await seqNow();
    for (const id of ids.slice(0, 55)) await mock("change_event", [login, folderId, id], { start: iso(now - 200 * DAY), end: iso(now - 200 * DAY + HOUR) });
    ctx.runSync(A.id, { reason: "user" });
    const blocked = await waitFor(async () => ((await health(A.id)).blocked?.code === "MASS_DELETE" ? true : null), { timeout: 90_000 });
    await waitFor(() => !ctx.entries.get(A.id)?.inFlight, { timeout: 60_000, interval: 200 });
    const pending = await ctx.entries.get(A.id).sync.pendingDeletes();
    await check(
      "55 événements sur 60 sortent de la période d'un coup (SoftDelete) : retenus comme des suppressions, la boîte est suspendue, rien n'est retiré ici",
      blocked && pending.count === 55 && pending.calendar === 55 && (await itemsOf(calendar.id)).length === 60,
      { blocked: (await health(A.id)).blocked, pending, local: (await itemsOf(calendar.id)).length },
    );
    await ctx.entries.get(A.id).sync.discardPendingDeletes(); // "Keep the local copies"
    await syncNow(A);
    await twoPasses(A);
    const h = await health(A.id);
    await check("… copies gardées : la boîte repart, les 60 événements restent ici, rien n'est envoyé au serveur", !h.blocked && (await itemsOf(calendar.id)).length === 60 && !(await actionsSince(seq, login, UPLOADS)).filter((x) => x.collection_id === folderId).length, { health: h, local: (await itemsOf(calendar.id)).length });
  });
  const tab = await view.browser.tabs.getCurrent();
  if (tab) await browser.tabs.remove(tab.id);
}

// ── 8. Restart ────────────────────────────────────────────────────────────

/** Last actions of phase 1: a meeting whose question stays open, and a change made as Thunderbird quits. */
async function beforeRestart({ A, B, C }) {
  await step("8. Avant de quitter : une question laissée ouverte, un changement de dernière seconde");
  const login = E.alice.login;
  const { main } = await calendarsA(A);
  const out = { calendars: {}, counts: {}, base: BASE };
  await H("uiAdd", { calendarId: main.id, spec: { start: compact(PARIS, at(17, 9)), end: compact(PARIS, at(17, 10)), tzid: PARIS, ops: [{ title: S.restartEvent }] } });
  const there = await waitFor(async () => (await srvEvents(login, S.restartEvent))[0], { timeout: 60_000 });
  await idle(A.id, 0, 60_000);
  if (!(await check("événement créé ici et synchronisé, pour être modifié au dernier moment", there))) return out;

  const seq = await seqNow();
  const meetingId = await H("uiAdd", {
    calendarId: main.id,
    notify: true,
    spec: { start: compact(PARIS, at(18, 9)), end: compact(PARIS, at(18, 10)), tzid: PARIS, organizer: { id: mailto(login), cn: "Alice Test" }, attendees: [{ id: mailto(PEOPLE.dave.email), cn: PEOPLE.dave.name }], ops: [{ title: S.meetingRestart }] },
  });
  const q = await question();
  await check("réunion créée : sa question est ouverte, et le reste sans réponse", q?.kind === "invite" && q.summary === S.meetingRestart && same(q.recipients, [PEOPLE.dave.email]), asked(q));
  await idle(A.id, 0, 60_000);

  for (const mb of [A, B, C]) {
    for (const cal of await calendarsOf(mb)) {
      out.calendars[cal.id] = cal.name;
      out.counts[cal.id] = (await itemsOf(cal.id)).length;
    }
  }
  // What the user chose in the calendar list: one of our calendars hidden, another one taking the new items.
  const { secondTasks } = await calendarsA(A);
  const hidden = await H("windowChoose", { calendarId: secondTasks.id, shown: false });
  const chosen = await H("windowChoose", { calendarId: main.id, isDefault: true });
  await check("dans la liste d'agendas de la fenêtre : un agenda de A masqué, celui de la boîte choisi pour les nouveaux éléments", hidden.shown === false && chosen.defaultId === main.id, { hidden, chosen });
  out.hidden = secondTasks.id;
  out.defaultId = main.id;
  // The last thing the user does: a change, and Thunderbird quits before the three seconds after which it would be sent.
  const local = await localOne(main.id, S.restartEvent);
  const entry = ctx.entries.get(A.id);
  const timer = entry.timer;
  await H("uiEdit", { calendarId: main.id, itemId: local.id, ops: [{ title: S.restartEdited }] });
  // The extension hears of the change a moment later and arms its three-second timer: disarmed here, as if
  // Thunderbird had quit within those three seconds (the end of the phase may take longer than that).
  const armed = await waitFor(() => entry.timer !== timer, { timeout: 2500, interval: 20 });
  clearTimeout(entry.timer);
  await check("… l'extension a bien été prévenue de ce changement (son envoi était programmé)", armed);
  const [unsent] = await srvEvents(login, S.restartEvent);
  await check("changement fait à l'instant de quitter : pas encore sur le serveur", unsent && !(await srvEvents(login, S.restartEdited)).length);
  await check("… et rien n'est parti pour la réunion dont la question est restée ouverte", !(await partsSince(seq, null)).length && ctx.meetings.current()?.summary === S.meetingRestart);
  // (These last actions come after the phase's own check of what Thunderbird sent.)
  const seen = await H("sendingSeen");
  const ours = seen.transports.filter((t) => String(t.calendarId ?? "").startsWith("sync443-") || t.transport === "calendar");
  await check("… ni par Thunderbird lui-même, jusqu'au dernier moment (aucun transport de courrier, aucune connexion SMTP)", ours.length === 0 && seen.smtp.connects === 0 && seen.smtp.sends === 0, { transports: ours, smtp: seen.smtp });
  return { ...out, seq, meetingId, eventServerId: there.server_id };
}

async function afterRestart({ A, B, C }, previous) {
  await step("8. Après redémarrage");
  const login = E.alice.login;
  const state = await H("calendars");
  const ours = state.calendars.filter((c) => c.type === "sync443");
  const expected = Object.keys(previous?.calendars ?? {}).sort();
  await check("le type d'agenda de l'extension est de nouveau enregistré dans Thunderbird", state.registered === true, state.registered);
  await check(
    "tous les agendas d'avant sont là, sous les mêmes identifiants et les mêmes noms, actifs (ni désactivés, ni en lecture seule)",
    expected.length > 0 && same(ours.map((c) => c.id).sort(), expected) && ours.every((c) => c.name === previous.calendars[c.id] && !c.disabled && !c.forceDisabled && !c.readOnly),
    ours,
  );
  const counts = {};
  for (const c of ours) counts[c.id] = (await itemsOf(c.id)).length;
  await check("… avec leurs éléments (autant qu'avant de quitter, dans chaque agenda)", previous && sameTable(counts, previous.counts), { now: counts, before: previous?.counts });
  const win = await H("windowCalendars");
  await info("windowCalendars", win);
  const visible = expected.filter((id) => id !== previous.hidden);
  await check(
    "la fenêtre principale de Thunderbird les a dans ses vues (agenda composite), prêts, et leurs éléments lui sont servis",
    win && visible.every((id) => win.calendars.some((c) => c.id === id && !c.disabled && c.ready)) && visible.every((id) => (win.items[id] ?? 0) === previous.counts[id]),
    win && { calendars: win.calendars, items: win.items },
  );
  await check(
    "… les choix de l'utilisateur sont gardés : l'agenda masqué avant de quitter l'est toujours, l'agenda des nouveaux éléments est le même",
    win && previous.hidden && !win.calendars.some((c) => c.id === previous.hidden) && !(previous.hidden in win.items) && win.defaultId === previous.defaultId,
    win && { shown: win.calendars.map((c) => c.id), hidden: previous.hidden, defaultId: win.defaultId, expected: previous.defaultId },
  );
  await check(
    "… et dans sa liste d'agendas, sous leur nom, ni désactivés, ni en échec de lecture, ni en lecture seule",
    win?.componentLoaded && expected.every((id) => win.rows[id] && win.rows[id].name === previous.calendars[id] && !win.rows[id].disabled && !win.rows[id].failed && !win.rows[id].readOnly),
    win?.rows,
  );
  // What the early start of our calendar type could leave: a calendar Thunderbird had to stand in for is marked
  // "disabled" and "auto-enabled" in the preferences until its type is registered.
  const marks = [];
  for (const id of expected) marks.push(...Object.keys(await H("prefs", { prefix: `calendar.registry.${id}.` })).filter((name) => /\.(disabled|auto-enabled|force-disabled)$/.test(name)));
  await check("… aucun n'est marqué désactivé ni « à réactiver » dans les préférences", marks.length === 0, marks);
  const mine = userCalendar ? win?.rows[userCalendar.id] : null;
  await check(
    "l'agenda personnel de l'utilisateur est lui aussi dans la liste et dans les vues, actif, avec ses éléments",
    userCalendar && mine && !mine.disabled && !mine.failed && (win.items[userCalendar.id] ?? 0) === userCalendar.items.length,
    { row: mine, items: win?.items[userCalendar?.id] },
  );
  const { main } = await calendarsA(A);
  await check("le changement de dernière seconde est toujours là, et pas encore envoyé (rien n'a tourné depuis le démarrage)", (await localCount(main.id, S.restartEdited)) === 1 && (await srvEvents(login, S.restartEvent)).length === 1);
  await check("aucune question n'est ouverte au démarrage : celle d'avant n'a plus de jeton", ctx.meetings.current() === null && !ctx.meetings.waiting().length);

  // What the background does at start-up, after its delay.
  const seq0 = await seqNow();
  const seqOld = await seqNow("old");
  for (const id of ctx.entries.keys()) ctx.runSync(id, { reason: "démarrage" });
  const sent = await waitFor(async () => (await srvEvents(login, S.restartEdited))[0], { timeout: 90_000 });
  await check("au premier passage, le changement fait avant de quitter part vers le serveur, sur le bon élément", sent?.server_id === previous?.eventServerId && !(await srvEvents(login, S.restartEvent)).length, sent);
  const q = await question(60_000);
  await check(
    "la question restée sans réponse est reposée (même invitation, même titre, même destinataire), sous un nouveau jeton",
    q?.kind === "invite" && q.summary === S.meetingRestart && same(q.recipients, [PEOPLE.dave.email]) && q.start === iso(at(18, 9)) && q.mailboxId === A.id,
    asked(q),
  );
  await check("… et rien n'est parti entre-temps pour cette réunion", previous && !(await partsSince(previous.seq, null)).length, await partsSince(previous?.seq ?? 0, null));
  ctx.meetings.answer(true);
  await quiet(A);
  await idle(A.id, 0, 90_000);
  await twoPasses(A);
  const parts = (await partsSince(previous?.seq ?? seq0, null)).map(described);
  await check("« Envoyer » : l'invitation part une seule fois (REQUEST, à ce destinataire), et n'est plus redemandée", parts.length === 1 && parts[0].inside === "REQUEST" && same(parts[0].to, [PEOPLE.dave.email]) && parts[0].uid === previous?.meetingId && ctx.meetings.current() === null, parts.map((p) => ({ to: p.to, method: p.inside })));
  const edits = (await actionsSince(seq0, login, ["sync_change"])).filter((x) => x.server_id === previous?.eventServerId);
  await check("… le changement d'avant le redémarrage n'a été envoyé qu'une fois", edits.length === 1, edits.length);

  for (const mb of [B, C]) await idle(mb.id, 0, 90_000);
  const zero = [];
  for (const [who, mb, server, since] of [[E.alice, A, "main", seq0], [E.bob, B, "main", seq0], [E.carol, C, "old", seqOld]]) {
    const pim = (await pimFolders(who.login, server)).ids;
    for (const r of await rpc("requests", { since, login: who.login, device_id: mb.deviceId, server })) {
      if (r.cmd === "Sync") for (const [cid, key] of r.collections ?? []) if (key === "0" && pim.includes(cid)) zero.push([who.login.split("@")[0], cid]);
    }
  }
  await check("aucun agenda ne repart de zéro après le redémarrage (aucune SyncKey « 0 » pour un dossier d'agenda ou de tâches)", !zero.length, zero);
  const after = {};
  for (const c of ours) after[c.id] = (await itemsOf(c.id)).length;
  await check("… ni doublon ni perte : autant d'éléments qu'avant dans chaque agenda", previous && sameTable(after, previous.counts), { now: after, before: previous?.counts });

  // Usable: both directions still work.
  await H("uiAdd", { calendarId: main.id, spec: { start: compact(PARIS, at(19, 9)), end: compact(PARIS, at(19, 10)), tzid: PARIS, ops: [{ title: S.afterRestart }] } });
  const up = await waitFor(async () => (await srvEvents(login, S.afterRestart))[0], { timeout: 60_000 });
  await mock("add_event", [login, 8], { subject: S.serverAfterRestart, start: iso(at(19, 11)), end: iso(at(19, 12)) });
  const down = await waitFor(() => localOne(main.id, S.serverAfterRestart), { timeout: 90_000, interval: 300 });
  await check("les agendas sont utilisables : un événement créé ici part vers le serveur, un événement du serveur arrive ici (Ping)", up && down, { up: Boolean(up), down: Boolean(down) });
  await idle(A.id, 0, 60_000);
  const win2 = await H("windowCalendars");
  await check("… et les vues de la fenêtre principale reçoivent ces deux nouveaux événements", previous && win2?.items[main.id] === previous.counts[main.id] + 2, { now: win2?.items[main.id], before: previous?.counts[main.id] });
}

// ── 9. Removal of a mailbox ───────────────────────────────────────────────

async function removal({ A, B, C }) {
  await step("9. Suppression de la boîte A");
  const login = E.alice.login;
  const before = await calendarsOf(A);
  const others = [...(await calendarsOf(B)), ...(await calendarsOf(C))];
  const othersBefore = {};
  for (const c of others) othersBefore[c.id] = await titlesOf(c.id);
  const server = await serverState(login);
  const rowsBefore = {};
  for (const c of before) rowsBefore[c.id] = await H("storeRows", { calendarId: c.id });
  await check("avant : A a ses agendas, avec des éléments dans la base de l'extension", before.length >= 3 && Object.values(rowsBefore).some((r) => r && r.cal_events + r.cal_todos > 0), { calendars: before.map((c) => c.name) });
  const seq = await seqNow();
  await ctx.removeMailbox(A.id); // what the settings page asks
  await sleep(3000);
  const now = (await H("calendars")).calendars;
  await check("boîte A supprimée : ses agendas ont quitté Thunderbird", !(await ctx.store.getMailbox(A.id)) && !now.some((c) => before.some((b) => b.id === c.id)), now.filter((c) => c.id.includes(A.id)));
  const prefs = await H("prefsMentioning", { text: A.id });
  await check("… aucune préférence ne les mentionne plus (ni registre des agendas, ni ordre d'affichage, ni compte)", prefs.length === 0, prefs);
  const keys = Object.keys(await browser.storage.local.get(null)).filter((k) => k.includes(A.id));
  await check("… ses enregistrements sont effacés (collections, file des messages de réunion, suppressions retenues…)", keys.length === 0, keys);
  const rows = {};
  for (const c of before) rows[c.id] = await H("storeRows", { calendarId: c.id });
  await check("… ses éléments et son journal sont retirés de la base de l'extension", Object.values(rows).every((r) => r && Object.values(r).every((n) => n === 0)), rows);
  await check("… aucune question de réunion ne reste ouverte pour elle", ctx.meetings.current() === null && !ctx.meetings.waiting().length);
  const requests = await rpc("requests", { since: seq, login });
  await check("rien n'est touché sur le serveur : mêmes événements et tâches, et plus aucune requête de A", same(await serverState(login), server) && !requests.length, requests.map((r) => r.cmd));
  const othersAfter = {};
  for (const c of others) othersAfter[c.id] = await titlesOf(c.id).catch(() => null);
  await check("les agendas de B et de C sont intacts", sameTable(othersAfter, othersBefore), { before: othersBefore, after: othersAfter });
  await info("removed", { mailboxId: A.id, calendarIds: before.map((c) => c.id) });
  await info("kept", { calendarIds: others.map((c) => c.id), userCalendarId: userCalendar?.id ?? null });
}

/** The sign-in name of C changed (another user of the same server): its calendars leave before the new one is read. */
async function moveMailbox({ C }) {
  await step("9. Autre identifiant pour la boîte C");
  const who = E.carolBis;
  await mock("add_event", [who.login, 8], { subject: S.carolBis, start: iso(at(3, 9)), end: iso(at(3, 10)) }, "old");
  const before = await calendarsOf(C);
  const titles = [];
  for (const c of before) titles.push(...(await titlesOf(c.id)));
  const server = await serverState(E.carol.login, "old");
  const seq = await seqNow("old");
  const mb = await mailboxById(C.id);
  const since = Date.now();
  const err = await errorOf(() => ctx.saveMailbox(input(viewOf(mb), { username: who.login, calendarPeriod: mb.calendarPeriod, taskFilter: mb.taskFilter }), who.password));
  const h = await idle(C.id, since, 180_000);
  await syncNow(C);
  const after = await calendarsOf(C);
  const now = [];
  for (const c of after) now.push(...(await titlesOf(c.id)));
  await check("identifiant de connexion de C changé (mot de passe retapé) : enregistré, synchronisation réussie", !err && h && !h.blocked, { err, health: h });
  await check(
    "… les agendas tenus de l'ancien identifiant ont quitté Thunderbird : l'agenda de C ne contient plus que ce que le nouveau détient, rien de l'ancien",
    titles.length >= 1 && same(now, [`event:${S.carolBis}`]) && after.length === 1,
    { before: titles, after: now, ids: [before.map((c) => c.id), after.map((c) => c.id)] },
  );
  const ups = [...(await actionsSince(seq, E.carol.login, UPLOADS, "old")), ...(await actionsSince(seq, who.login, UPLOADS, "old"))];
  await check("… rien n'est supprimé ni envoyé sur le serveur, ni pour l'ancien identifiant ni pour le nouveau", same(await serverState(E.carol.login, "old"), server) && !ups.length, ups);
}

// ── Phases ────────────────────────────────────────────────────────────────

async function phase1() {
  BASE = baseMonday();
  const boxes = await setup();
  if (want(1)) await guard("étape 1", () => serverToThunderbird(boxes));
  if (want(2)) await guard("étape 2", () => thunderbirdToServer(boxes));
  if (want(3)) await guard("étape 3", () => readOnlyItems(boxes));
  if (want(4)) await guard("étape 4", () => invitations(boxes));
  if (want(5)) await guard("étape 5", () => meetings(boxes));
  if (want(6)) await guard("étape 6", () => settings(boxes));
  if (want(7)) await guard("étape 7", () => massDeletion(boxes));
  await endOfPhase(1);
  // Last of all: nothing may run between these actions and the end of Thunderbird.
  let pre = null;
  if (want(8)) await guard("étape 8", async () => (pre = await beforeRestart(boxes)));
  await info("forNextPhase", { base: BASE, userCalendar, pre });
}

async function phase2(previous) {
  BASE = previous?.base ?? baseMonday();
  userCalendar = previous?.userCalendar ?? null;
  const boxes = await mailboxes();
  await check("après redémarrage : les trois boîtes sont là, avec leurs objets d'agenda", [boxes.A, boxes.B, boxes.C].every((mb) => mb && ctx.entries.get(mb.id)?.calendar));
  if (want(8) && previous?.pre) await guard("étape 8", () => afterRestart(boxes, previous.pre));
  else for (const id of ctx.entries.keys()) await syncNow({ id });
  if (want(9)) await guard("étape 9", () => removal(boxes));
  if (want(9)) await guard("étape 9 (identifiant)", () => moveMailbox(boxes));
  await endOfPhase(2);
  // Last of all, a control of the SMTP watch itself (it makes the count of connections move).
  await guard("témoin SMTP", async () => {
    const control = await H("smtpControl");
    await check(
      "témoin : une connexion SMTP demandée exprès à Thunderbird (« vérifier la connexion » d'un serveur sortant neutre) est bien comptée par le guet, et échoue (rien n'écoute)",
      control.server && control.after === control.before + 1 && control.failed,
      control,
    );
  });
}

export async function runCalendarPhase(lib) {
  ({ ctx, E, T, check, info, gap, step, guard, rpc, mock, waitFor, errorOf, sleep, health, idle, input, mailboxById } = lib);
  steps = Array.isArray(lib.request.steps) ? lib.request.steps : null;
  watchNotifications();
  logTimer = setInterval(scanLog, 1000);
  await H("watchAllSending");
  if (lib.phase === 1) await phase1();
  else if (lib.phase === 2) await phase2(lib.request.previous ?? null);
  else throw new Error(`phase inconnue : ${lib.phase}`);
}
