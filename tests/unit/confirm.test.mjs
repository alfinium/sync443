// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * src/confirm: the window that asks before a meeting message is sent.
 *
 * The page's script runs here against a small stand-in for the DOM, built
 * from the real confirm.html (so an id the script uses and the page lacks
 * fails a test), with a background that records every message it receives.
 * A stand-in element refuses innerHTML: everything must go through
 * textContent. Characters that cannot be seen are built at run time.
 */

import { test, eq, assert } from "./harness.mjs";
import { readText, withLanguage, LOCALES } from "./i18n-fake.mjs";
import { tokenOf, startTime, checkInfo, whenText, recipientsText, questionText, startConfirm, MAX_RECIPIENTS } from "../../src/confirm/confirm.mjs";

const HTML = await readText("../../src/confirm/confirm.html");
const CSS = await readText("../../src/confirm/confirm.css");
const OPTIONS_CSS = await readText("../../src/options/options.css");

const RLO = String.fromCharCode(0x202e); // right-to-left override
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const NUL = String.fromCharCode(0);

const info = (over = {}) => ({
  kind: "invite",
  summary: "Point budget",
  start: "2026-11-16T14:30:00Z",
  allDay: false,
  recipients: ["alice@example.com", "bob@example.org"],
  from: "moi@example.com",
  ...over,
});

// ── A stand-in for the DOM ────────────────────────────────────────────────

const VOID = new Set(["meta", "link", "img", "br", "input"]);

class FakeElement {
  constructor(doc, tag, attributes = new Map()) {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.id = attributes.get("id") ?? "";
    this.hidden = attributes.has("hidden");
    this.disabled = false;
    this.parent = null;
    this.children = [];
    this.listeners = new Map();
    this.text = "";
    this.dataset = {};
    for (const [name, value] of attributes) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  get innerHTML() {
    throw new Error("innerHTML read");
  }
  set innerHTML(_) {
    throw new Error("innerHTML written");
  }
  set outerHTML(_) {
    throw new Error("outerHTML written");
  }
  insertAdjacentHTML() {
    throw new Error("insertAdjacentHTML");
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.text = "";
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  /** The event reaches the listeners whatever the element's state (what a script could do). */
  fire(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  /** Whether the user can see it: neither it nor an ancestor is hidden. */
  get shown() {
    for (let node = this; node; node = node.parent) if (node.hidden) return false;
    return true;
  }
  /** A click by the user: only on a button that is shown and enabled. */
  click() {
    if (!this.shown || this.disabled) return false;
    this.fire("click");
    return true;
  }
  focus() {
    if (this.shown && !this.disabled) this.doc.activeElement = this;
  }
}

/** The page as the script sees it: document, window, and a background recording what it is sent. */
function page({ search = "?token=abc123", background } = {}) {
  const doc = { activeElement: null, all: [], listeners: new Map() };
  const root = new FakeElement(doc, "#document");
  const stack = [root];
  const source = HTML.replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/i, "");
  for (const m of source.matchAll(/<(\/?)([a-z][a-z0-9]*)((?:\s[^<>]*)?)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      assert(!m[4].trim() || stack[stack.length - 1].tagName === "TITLE", `hard-coded text in the page: ${m[4].trim()}`);
      continue;
    }
    if (m[1]) {
      eq(stack.pop().tagName, m[2].toUpperCase(), "tags not closed properly");
      continue;
    }
    const attributes = new Map([...m[3].matchAll(/([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? ""]));
    const node = new FakeElement(doc, m[2], attributes);
    stack[stack.length - 1].append(node);
    doc.all.push(node);
    if (!VOID.has(m[2])) stack.push(node);
  }
  eq(stack.length, 1, "tags not closed properly");
  doc.documentElement = doc.all.find((n) => n.tagName === "HTML");
  doc.getElementById = (id) => doc.all.find((n) => n.id === id) ?? null;
  doc.querySelectorAll = (selector) => {
    const name = /^\[([a-z0-9-]+)\]$/.exec(selector)?.[1];
    assert(name, `selector not supported by the stand-in: ${selector}`);
    return doc.all.filter((n) => n.attributes.has(name));
  };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.addEventListener = (type, fn) => doc.listeners.set(type, [...(doc.listeners.get(type) ?? []), fn]);

  const win = { location: { search }, closed: 0, listeners: new Map() };
  win.close = () => {
    win.closed++;
  };
  win.addEventListener = (type, fn) => win.listeners.set(type, [...(win.listeners.get(type) ?? []), fn]);

  const sent = [];
  const api = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return background(message);
      },
    },
  };
  const $ = (id) => doc.getElementById(id);
  const key = (name) => {
    const event = { key: name, prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of doc.listeners.get("keydown") ?? []) fn(event);
    return event;
  };
  const hide = () => {
    for (const fn of win.listeners.get("pagehide") ?? []) fn({ persisted: false });
  };
  return { doc, win, api, sent, $, key, hide };
}

/** Lets pending promises settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await null;
}

/** A background that describes `described` and takes the answer. */
const background = (described, confirm = () => ({ ok: true })) => async (message) => {
  if (message.type === "meetingConfirmInfo") return typeof described === "function" ? described(message) : described;
  if (message.type === "meetingConfirm") return confirm(message);
  return undefined;
};

const answers = (p) => p.sent.filter((m) => m.type === "meetingConfirm");

// ── Token ─────────────────────────────────────────────────────────────────

test("confirm: token read from the address, given once, bounded", () => {
  eq(tokenOf("?token=abc123"), "abc123");
  eq(tokenOf("token=abc123"), "abc123");
  eq(tokenOf("?x=1&token=A-b_9.%2B%2F%3D&y=2"), "A-b_9.+/=");
  eq(tokenOf("?token=a+b"), "a+b", "a plus sign stays as it is");
  eq(tokenOf(`?token=${"f".repeat(256)}`), "f".repeat(256));
  for (const search of ["", "?", "?token", "?token=", "?other=abc", "?Token=abc", "?token=a&token=a", "?token=a&token=b", `?token=${"f".repeat(257)}`, "?token=a%20b", "?token=a%00b", "?token=%E0%A4%A", "?token=%C3%A9", "?token=a%0Ab"]) {
    eq(tokenOf(search), null, search);
  }
  for (const search of [null, undefined, 42, {}, ["?token=abc"]]) eq(tokenOf(search), null, String(search));
});

// ── What the background describes ─────────────────────────────────────────

test("confirm: start of an event, exact UTC or DATE form, real day, bounded years", () => {
  eq(startTime("2026-11-16T14:30:00Z", false), Date.UTC(2026, 10, 16, 14, 30, 0));
  eq(startTime("2026-11-16", true), Date.UTC(2026, 10, 16));
  eq(startTime("2028-02-29", true), Date.UTC(2028, 1, 29), "leap year");
  eq(startTime("1900-01-01", true), Date.UTC(1900, 0, 1));
  eq(startTime("2200-12-31T23:59:59Z", false), Date.UTC(2200, 11, 31, 23, 59, 59));
  // The form goes with allDay.
  eq(startTime("2026-11-16", false), null);
  eq(startTime("2026-11-16T14:30:00Z", true), null);
  for (const start of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-31", "1899-12-31", "2201-01-01", "26-11-16", "2026-11-16 ", " 2026-11-16", "2026/11/16", "20261116", ""]) {
    eq(startTime(start, true), null, start);
  }
  for (const start of ["2026-11-16T24:00:00Z", "2026-11-16T14:60:00Z", "2026-11-16T14:30:60Z", "2026-11-16T14:30:00", "2026-11-16T14:30:00+01:00", "2026-11-16T14:30:00.000Z", "2026-11-16t14:30:00z", "2026-02-30T10:00:00Z", "20261116T143000Z", "2026-11-16T14:30:00Z\n"]) {
    eq(startTime(start, false), null, start);
  }
  for (const start of [null, undefined, 1794839400000, new Date(0), ["2026-11-16"]]) eq(startTime(start, true), null, String(start));
  for (const allDay of [null, undefined, 0, 1, "true", "false"]) eq(startTime("2026-11-16", allDay), null, String(allDay));
});

test("confirm: description accepted as agreed, title cleaned", () => {
  eq(checkInfo(info()), {
    kind: "invite",
    summary: "Point budget",
    allDay: false,
    time: Date.UTC(2026, 10, 16, 14, 30, 0),
    recipients: ["alice@example.com", "bob@example.org"],
    from: "moi@example.com",
  });
  eq(checkInfo({ ok: true, ...info({ kind: "update" }) }).kind, "update", "with ok: true, like the background's other answers");
  eq(checkInfo(info({ kind: "cancel", start: "2026-11-16", allDay: true })).allDay, true);
  eq(checkInfo(info({ summary: "" })).summary, "(sans titre)");
  eq(checkInfo(info({ summary: ` ${ZWSP} ` })).summary, "(sans titre)");
  eq(checkInfo(info({ summary: `Réunion${RLO} gpj.exe\nligne 2${NUL}` })).summary, "Réunion gpj.exe ligne 2");
  eq(checkInfo(info({ summary: "x".repeat(5000) })).summary.length, 1024);
  // The window's own cleaning: joiners, which the readers of the server's items keep in a title, and every other
  // character nobody sees, are not shown; half a character hides none of them.
  for (const code of [0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfff9, 0xe0041]) {
    const hidden = String.fromCodePoint(code);
    eq(checkInfo(info({ summary: `Point${hidden} bud${hidden}get` })).summary, "Point budget", `U+${code.toString(16)}`);
    eq(checkInfo(info({ summary: `Point budget${String.fromCharCode(0xd83d)}${hidden}` })).summary, `Point budget${String.fromCharCode(0xfffd)}`, `half a character, then U+${code.toString(16)}`);
  }
  eq(checkInfo(info({ recipients: ["seul@example.com"] })).recipients, ["seul@example.com"]);
  const hundred = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `p${i}@example.com`);
  eq(checkInfo(info({ recipients: hundred })).recipients, hundred);
  eq(MAX_RECIPIENTS, 100);
});

test("confirm: description refused as soon as one part is not as agreed", () => {
  for (const answer of [null, undefined, "invite", 42, [], {}, { ok: false, error: "x" }, { ok: false, ...info() }]) {
    eq(checkInfo(answer), null, JSON.stringify(answer));
  }
  for (const kind of ["", "INVITE", "reply", "accepted", "__proto__", "constructor", "toString", null, 1, ["invite"]]) {
    eq(checkInfo(info({ kind })), null, `kind ${String(kind)}`);
  }
  for (const summary of [null, undefined, 42, ["x"], { toString: () => "x" }]) eq(checkInfo(info({ summary })), null, `summary ${String(summary)}`);
  eq(checkInfo(info({ start: "2026-02-30T10:00:00Z" })), null);
  eq(checkInfo(info({ allDay: true })), null, "allDay without a date-only start");
  eq(checkInfo(info({ allDay: undefined })), null);
});

test("confirm: the mailbox that sends is named by a valid address, or nothing is offered", () => {
  eq(checkInfo(info({ from: "Autre.Boite+cal@Example.ORG" })).from, "Autre.Boite+cal@Example.ORG");
  const without = info();
  delete without.from;
  eq(checkInfo(without), null, "a background that does not say who sends");
  for (const from of [
    null, undefined, "", 42, ["moi@example.com"], { toString: () => "moi@example.com" }, "moi", "moi@", "moi@example", " moi@example.com", "moi@example.com ", "Moi <moi@example.com>",
    "moi@example.com, eve@evil.example", `moi@example.com${NUL}`, `moi${RLO}@example.com`, `moi@example.com\nBcc: eve@evil.example`, `${"x".repeat(250)}@example.com`,
  ]) {
    eq(checkInfo(info({ from })), null, `from ${JSON.stringify(from)}`);
  }
});

test("confirm: every recipient valid and shown, or nothing is offered", () => {
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@example.com`);
  const sparse = ["alice@example.com", "bob@example.org"];
  sparse.length = 3;
  const holed = new Array(2);
  holed[1] = "bob@example.org";
  const lists = [
    [],
    many,
    sparse,
    holed,
    null,
    undefined,
    "alice@example.com",
    { 0: "alice@example.com", length: 1 },
    ["alice@example.com", null],
    ["alice@example.com", 42],
    ["alice@example.com", ["bob@example.org"]],
    ["alice@example.com", ""],
    ["alice@example.com", "bob"],
    ["alice@example.com", "bob@localhost"],
    ["alice@example.com", " bob@example.org"],
    ["alice@example.com", "bob@example.org "],
    ["alice@example.com", "Bob <bob@example.org>"],
    ["alice@example.com", "bob@example.org, carol@example.net"],
    ["alice@example.com", "bob@example.org\ncarol@example.net"],
    ["alice@example.com", `bob${RLO}@example.org`],
    ["alice@example.com", `bob@exa${ZWSP}mple.org`],
    ["alice@example.com", "bób@example.org"],
    ["alice@example.com", `${"a".repeat(250)}@example.org`],
  ];
  for (const recipients of lists) eq(checkInfo(info({ recipients })), null, JSON.stringify(recipients)?.slice(0, 80));
});

// ── Texts ─────────────────────────────────────────────────────────────────

test("confirm: date and time in the interface language, an all-day event without a time", async () => {
  const timed = { allDay: false, time: Date.UTC(2026, 10, 16, 14, 30) };
  const day = { allDay: true, time: Date.UTC(2026, 10, 16) };
  eq(whenText(timed, { timeZone: "UTC" }), "lundi 16 novembre 2026 à 14:30");
  eq(whenText(timed, { timeZone: "Asia/Tokyo" }), "lundi 16 novembre 2026 à 23:30");
  eq(whenText(timed, { timeZone: "Pacific/Auckland" }).startsWith("mardi 17 novembre 2026"), true, "in the given time zone");
  assert(whenText(timed).includes("2026"), "the computer's time zone by default");
  // An all-day event is a day, not an instant: the same day in every time zone, and no time.
  eq(whenText(day), "lundi 16 novembre 2026 (toute la journée)");
  eq(whenText(day, { timeZone: "Pacific/Auckland" }), "lundi 16 novembre 2026 (toute la journée)");
  eq(whenText(day, { timeZone: "America/Los_Angeles" }), "lundi 16 novembre 2026 (toute la journée)");
  await withLanguage("en", () => {
    assert(/^Monday, November 16, 2026 at 2:30\sPM$/.test(whenText(timed, { timeZone: "UTC" })), whenText(timed, { timeZone: "UTC" }));
    eq(whenText(day), "Monday, November 16, 2026 (all day)");
  });
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      for (const text of [whenText(timed, { timeZone: "UTC" }), whenText(day)]) {
        assert(text.includes("2026") && text.includes("16"), `${lang}: ${text}`);
        assert(!/\$[A-Za-z0-9_@]+\$|\$\d/.test(text), `${lang}: placeholder left: ${text}`);
      }
      assert(!/\d{1,2}[:.]\d{2}|\d時/.test(whenText(day)), `${lang}: an all-day event has no time: ${whenText(day)}`);
    });
  }
});

test("confirm: question for each kind of message, number of recipients", async () => {
  eq(questionText("invite"), "Envoyer l'invitation à cette réunion ?");
  eq(questionText("update"), "Envoyer la mise à jour de l'invitation à cette réunion ?");
  eq(questionText("cancel"), "Envoyer l'annulation de cette réunion ?");
  eq(questionText("reply"), "");
  eq(questionText("__proto__"), "");
  eq([recipientsText(1), recipientsText(2), recipientsText(100)], ["1 destinataire", "2 destinataires", "100 destinataires"]);
  await withLanguage("en", () => {
    eq([questionText("invite"), questionText("update"), questionText("cancel")], ["Send the invitation to this meeting?", "Send the updated invitation to this meeting?", "Send the cancellation of this meeting?"]);
    eq([recipientsText(1), recipientsText(37)], ["1 recipient", "37 recipients"]);
  });
  // Languages whose plural depends on the number: the number after a colon.
  for (const lang of ["pl", "cs", "ru"]) {
    await withLanguage(lang, () => {
      for (const n of [2, 5, 22, 100]) assert(recipientsText(n).endsWith(`: ${n}`), `${lang}: ${recipientsText(n)}`);
    });
  }
});

// ── The window ────────────────────────────────────────────────────────────

test("confirm window: what will be sent, to whom, and the safe choice under the keyboard", async () => {
  const p = page({ background: background(info()) });
  await startConfirm(p);
  eq(p.sent, [{ type: "meetingConfirmInfo", token: "abc123" }]);
  eq(p.$("ask").hidden, false);
  eq(p.$("over").hidden, true);
  eq(p.$("question").textContent, "Envoyer l'invitation à cette réunion ?");
  eq(p.$("summary").textContent, "Point budget");
  assert(p.$("when").textContent.includes("novembre 2026"), p.$("when").textContent);
  // Which mailbox sends: its address, under a label of its own, before the recipients.
  eq(p.$("from").textContent, "moi@example.com");
  eq(p.$("from").children, []);
  const labels = p.doc.all.filter((n) => n.tagName === "DT").map((n) => [n.textContent, n.parent.children.find((c) => c.tagName === "DD")?.id]);
  eq(labels, [["Événement", "summary"], ["Date", "when"], ["Expéditeur", "from"]]);
  eq(p.$("count").textContent, "2 destinataires");
  eq(p.$("recipients").children.map((li) => [li.tagName, li.textContent]), [["LI", "alice@example.com"], ["LI", "bob@example.org"]]);
  eq([p.$("send").textContent, p.$("dont-send").textContent], ["Envoyer", "Ne pas envoyer"]);
  eq([p.$("send").disabled, p.$("dont-send").disabled], [false, false]);
  eq(p.doc.activeElement?.id, "dont-send", "the safe choice has the focus");
  eq(p.doc.documentElement.lang, "fr");
  eq(p.doc.all.find((n) => n.tagName === "TITLE").textContent, "Sync443 – Confirmer l'envoi");
  eq(p.win.closed, 0);
});

test("confirm window: update, cancellation, all-day event, a single recipient", async () => {
  const p = page({ background: background(info({ kind: "cancel", summary: "", start: "2026-12-24", allDay: true, recipients: ["seul@example.com"] })) });
  await startConfirm(p);
  eq(p.$("question").textContent, "Envoyer l'annulation de cette réunion ?");
  eq(p.$("summary").textContent, "(sans titre)");
  eq(p.$("when").textContent, "jeudi 24 décembre 2026 (toute la journée)");
  eq(p.$("count").textContent, "1 destinataire");
  const q = page({ background: background({ ok: true, ...info({ kind: "update" }) }) });
  await startConfirm(q);
  eq(q.$("question").textContent, "Envoyer la mise à jour de l'invitation à cette réunion ?");
});

test("confirm window: everything from the background is text, never markup", async () => {
  const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script>${RLO}&lt;b&gt;`;
  const p = page({ background: background(info({ summary: hostile, recipients: ["a&b@example.com", "o'neil+x=y@example.com"] })) });
  await startConfirm(p); // a stand-in element throws on innerHTML, outerHTML and insertAdjacentHTML
  eq(p.$("summary").textContent, "<img src=x onerror=alert(1)><script>alert(2)</script>&lt;b&gt;");
  eq(p.$("summary").children, [], "no element made from the title");
  eq(p.$("recipients").children.map((li) => li.textContent), ["a&b@example.com", "o'neil+x=y@example.com"]);
  for (const li of p.$("recipients").children) eq(li.children, []);
  // A sender that is not an address is never shown, as text or otherwise: the window offers nothing.
  const forged = page({ background: background(info({ from: "<img src=x onerror=alert(1)>@example.com" })) });
  await startConfirm(forged);
  eq([forged.$("ask").hidden, forged.$("over").hidden, forged.$("from").textContent], [true, false, ""]);
  const source = await readText("../../src/confirm/confirm.mjs");
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(source), "confirm.mjs writes markup or code");
});

test("confirm window: a hundred recipients, all of them in the list", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `personne${i}@example.com`);
  const p = page({ background: background(info({ recipients: hundred, summary: "t".repeat(1024) })) });
  await startConfirm(p);
  eq(p.$("count").textContent, "100 destinataires");
  eq(p.$("recipients").children.map((li) => li.textContent), hundred);
  eq(p.$("summary").textContent.length, 1024);
});

test("confirm window: Send works once, then both buttons are disabled", async () => {
  let release;
  const taken = new Promise((resolve) => {
    release = resolve;
  });
  const p = page({ background: background(info(), () => taken) });
  await startConfirm(p);
  eq(p.$("send").click(), true);
  // Before the background has answered: already sent, already disabled.
  eq(answers(p), [{ type: "meetingConfirm", token: "abc123", send: true }]);
  eq([p.$("send").disabled, p.$("dont-send").disabled], [true, true]);
  eq(p.$("progress").textContent, "Envoi en cours…");
  eq(p.$("send").click(), false, "disabled button");
  eq(p.$("dont-send").click(), false, "disabled button");
  // Even if a click reached the listeners again, or Escape, or the window closing.
  p.$("send").fire("click");
  p.$("dont-send").fire("click");
  p.key("Escape");
  p.hide();
  await settle();
  eq(answers(p).length, 1, "a single answer");
  eq(p.win.closed, 0, "the window waits until the background has taken the answer");
  release({ ok: true });
  await settle();
  eq(p.win.closed, 1);
  p.hide();
  eq(answers(p).length, 1);
});

test("confirm window: Don't send, Escape and closing the window all mean Don't send", async () => {
  const dont = page({ background: background(info()) });
  await startConfirm(dont);
  eq(dont.$("dont-send").click(), true);
  eq([dont.$("send").disabled, dont.$("dont-send").disabled], [true, true]);
  await settle();
  eq(answers(dont), [{ type: "meetingConfirm", token: "abc123", send: false }]);
  eq(dont.win.closed, 1);
  dont.$("send").fire("click");
  dont.hide();
  await settle();
  eq(answers(dont).length, 1);

  const escape = page({ background: background(info()) });
  await startConfirm(escape);
  eq(escape.key("Escape").prevented, true);
  await settle();
  eq(answers(escape), [{ type: "meetingConfirm", token: "abc123", send: false }]);
  eq(escape.win.closed, 1);
  eq(escape.key("Enter").prevented, false, "other keys are left alone");

  // The window's own close button, or the background closing it: the page says nothing while it goes (a message
  // that can no longer be answered is an error in Thunderbird's console). The background sees the window go.
  const closed = page({ background: background(info()) });
  await startConfirm(closed);
  closed.hide();
  closed.hide();
  await settle();
  eq(answers(closed), [], "no message from a page that is being closed");
  closed.$("send").fire("click");
  closed.$("dont-send").fire("click");
  closed.key("Escape");
  await settle();
  eq(answers(closed).filter((m) => m.send === true), [], "and never a Send once the window is closed");
});

test("confirm window: left while loading, nothing is offered afterwards", async () => {
  let describe;
  const described = new Promise((resolve) => {
    describe = resolve;
  });
  const p = page({ background: background(() => described) });
  const started = startConfirm(p);
  p.key("Escape");
  eq(answers(p), [{ type: "meetingConfirm", token: "abc123", send: false }]);
  eq(p.win.closed, 0, "the window waits for the background's answer before it closes");
  await settle();
  eq(p.win.closed, 1);
  describe(info());
  await started;
  eq(p.$("ask").hidden, true, "the question no longer appears");
  p.$("send").fire("click");
  await settle();
  eq(answers(p).length, 1);
});

test("confirm window: unknown, used or expired token: an explanation, Close, and nothing is sent", async () => {
  const p = page({ background: background({ ok: false, error: "Demande invalide." }) });
  await startConfirm(p);
  eq(p.$("ask").hidden, true);
  eq(p.$("over").hidden, false);
  eq(p.$("over-text").textContent, "Cette demande n'est plus valable : elle a déjà reçu une réponse, ou elle a expiré. Rien ne sera envoyé depuis cette fenêtre.");
  eq(p.$("close").textContent, "Fermer");
  eq(p.doc.activeElement?.id, "close");
  eq(p.$("send").click(), false, "the Send button is out of reach");
  p.$("send").fire("click");
  p.$("dont-send").fire("click");
  await settle();
  eq(p.$("close").click(), true);
  p.hide();
  await settle();
  eq(p.sent, [{ type: "meetingConfirmInfo", token: "abc123" }], "no answer for a token the background no longer knows");
  eq(p.win.closed, 1);
});

test("confirm window: without a token in the address, the background is not even asked", async () => {
  for (const search of ["", "?token=", "?token=a&token=b", "?token=a%20b"]) {
    const p = page({ search, background: background(info()) });
    await startConfirm(p);
    eq(p.$("over").hidden, false, search);
    eq(p.$("ask").hidden, true, search);
    p.$("send").fire("click");
    eq(p.key("Escape").prevented, true);
    await settle();
    eq(p.sent, [], search);
    eq(p.win.closed, 1, "Escape closes the window");
  }
});

test("confirm window: unexpected description, no Send button; Close tells the background Don't send", async () => {
  const many = Array.from({ length: 101 }, (_, i) => `p${i}@example.com`);
  for (const described of [info({ recipients: many }), info({ recipients: ["alice@example.com", "Bob <bob@example.org>"] }), info({ kind: "reply" }), info({ start: "demain" }), undefined, null, "ok", { ok: true }]) {
    const p = page({ background: background(described) });
    await startConfirm(p);
    eq(p.$("ask").hidden, true);
    eq(p.$("over").hidden, false);
    eq(p.$("over-text").textContent, "Réponse inattendue de l'extension. Rien ne sera envoyé depuis cette fenêtre.");
    eq(p.$("send").click(), false);
    p.$("send").fire("click");
    await settle();
    eq(answers(p), [], "never a sending without the question");
    eq(p.$("close").click(), true);
    await settle();
    // The token may still be waiting in the background: it is told "Don't send".
    eq(answers(p), [{ type: "meetingConfirm", token: "abc123", send: false }]);
    eq(p.win.closed, 1);
  }
});

test("confirm window: Close tells the background, and the window closes only once it has answered (or cannot be reached)", async () => {
  for (const outcome of ["taken", "refused", "rejects", "throws"]) {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const p = page({
      background: (message) => {
        if (message.type === "meetingConfirmInfo") return Promise.resolve(info({ kind: "reply" })); // nothing to offer, the token still live
        if (outcome === "throws") throw new Error("extension unloaded");
        return gate.then(() => {
          if (outcome === "rejects") throw new Error("Could not establish connection");
          return { ok: outcome === "taken" };
        });
      },
    });
    await startConfirm(p);
    eq(p.$("over").hidden, false, outcome);
    p.$("close").click();
    eq(answers(p), [{ type: "meetingConfirm", token: "abc123", send: false }], outcome);
    await settle();
    // A window closed under a message still on its way is an error in Thunderbird's console.
    eq(p.win.closed, outcome === "throws" ? 1 : 0, `${outcome}: not while the message is on its way`);
    release();
    await settle();
    eq(p.win.closed, 1, outcome);
    eq(answers(p).length, 1, outcome);
  }
});

test("confirm window: the background does not answer", async () => {
  // To the first question: nothing can be confirmed, nothing more is asked.
  const mute = page({
    background: async () => {
      throw new Error("Could not establish connection");
    },
  });
  await startConfirm(mute);
  eq(mute.$("over-text").textContent, "Réponse inattendue de l'extension. Rien ne sera envoyé depuis cette fenêtre.");
  mute.$("close").click();
  await settle();
  eq(mute.sent.length, 1);
  eq(mute.win.closed, 1);

  // A synchronous failure is no different.
  const broken = page({
    background: () => {
      throw new Error("extension unloaded");
    },
  });
  await startConfirm(broken);
  eq(broken.$("over").hidden, false);

  // After Send: the message may or may not have left, and the window says so instead of closing.
  const lost = page({
    background: background(info(), async () => {
      throw new Error("Could not establish connection");
    }),
  });
  await startConfirm(lost);
  lost.$("send").click();
  await settle();
  eq(lost.$("ask").hidden, true);
  eq(lost.$("over-text").textContent, "Sync443 n'a pas répondu : le message n'a peut-être pas été envoyé. Vérifiez le dossier Envoyés avant de le renvoyer.");
  eq(lost.win.closed, 0);
  eq(lost.doc.activeElement?.id, "close");
  lost.$("send").fire("click");
  eq(lost.key("Escape").prevented, true);
  lost.hide();
  await settle();
  eq(answers(lost), [{ type: "meetingConfirm", token: "abc123", send: true }], "never sent again");
  eq(lost.win.closed, 1, "Escape closes the window");

  // After Don't send: nothing to report, the window closes.
  const quiet = page({
    background: background(info(), async () => {
      throw new Error("Could not establish connection");
    }),
  });
  await startConfirm(quiet);
  quiet.$("dont-send").click();
  await settle();
  eq(quiet.win.closed, 1);
  eq(quiet.$("over").hidden, true);
});

test("confirm window: token expired between the question and Send", async () => {
  const p = page({ background: background(info(), () => ({ ok: false, error: "Demande invalide." })) });
  await startConfirm(p);
  p.$("send").click();
  await settle();
  eq(p.$("ask").hidden, true);
  eq(p.$("over-text").textContent, "Cette demande n'est plus valable : elle a déjà reçu une réponse, ou elle a expiré. Rien ne sera envoyé depuis cette fenêtre.");
  eq(p.win.closed, 0);
  p.$("close").click();
  await settle();
  eq(answers(p).length, 1);
  eq(p.win.closed, 1);
});

test("confirm window: a background that says nothing about the answer has taken it", async () => {
  for (const reply of [undefined, null, true, {}, { ok: true }]) {
    const p = page({ background: background(info(), () => reply) });
    await startConfirm(p);
    p.$("send").click();
    await settle();
    eq(p.win.closed, 1, JSON.stringify(reply));
    eq(p.$("over").hidden, true);
  }
});

// ── The page and its stylesheet ───────────────────────────────────────────

test("confirm page: no inline script or style, local files only", () => {
  const html = HTML.replace(/<!--[\s\S]*?-->/g, "");
  assert(!/\son[a-z]+\s*=/i.test(html), "inline event handler");
  assert(!/\sstyle\s*=/i.test(html), "inline style");
  eq([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => [m[1].trim(), m[2].trim()]), [['type="module" src="confirm.mjs"', ""]]);
  eq([...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]).sort(), ["../icons/sync443.svg", "confirm.css", "confirm.mjs"]);
  // The two buttons, Send first; neither is the default button of a form.
  assert(!/<form\b/i.test(html), "no form: no key sends by default");
  eq([...html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]), ["send", "dont-send", "close"]);
  for (const m of html.matchAll(/<button\b([^>]*)>/g)) assert(/\btype="button"/.test(m[1]), `button without type="button": ${m[1]}`);
});

test("confirm page: same colours as the settings page, light and dark", () => {
  const palettes = (css) => [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  eq(palettes(CSS).length, 2, "light, then dark");
  eq(palettes(CSS), palettes(OPTIONS_CSS));
  assert(/@media \(prefers-color-scheme: dark\)/.test(CSS), "dark theme");
  // Every colour comes from the palette: nothing is readable in one theme only.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:root\s*\{[^}]*\}/g, "");
  eq([...rules.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)].map((m) => m[0]), []);
});

test("confirm page: the list scrolls, the buttons stay in the window", () => {
  const rule = (selector) => {
    const at = CSS.indexOf(`\n${selector} {`);
    assert(at >= 0, `missing rule: ${selector}`);
    return CSS.slice(at, CSS.indexOf("}", at));
  };
  assert(/overflow: auto/.test(rule(".content > .recipients")) && /flex: 1 1 /.test(rule(".content > .recipients")), "list of recipients");
  assert(/max-height:/.test(rule(".summary")) && /overflow-y: auto/.test(rule(".summary")), "bounded title");
  assert(/min-height: 0/.test(rule(".content")) && /overflow: auto/.test(rule(".content")), "content");
  assert(/flex: none/.test(rule(".actions")), "buttons");
  assert(/height: 100%/.test(rule(".pane")) && /flex-direction: column/.test(rule(".pane")), "the window is a column");
});
