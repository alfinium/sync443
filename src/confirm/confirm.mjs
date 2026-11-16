// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Confirmation window: asks before a meeting message (invitation, update or
 * cancellation) leaves for other people. The background opens it as
 * confirm/confirm.html?token=<random> (windows.create, type "popup") and
 * sends nothing until this page answers (security rule 23: no message is
 * sent without the user's own action).
 *
 * What the page holds to:
 *   - what the background says would be sent is checked again here (kind,
 *     title, start, 1 to 100 valid addresses, the address that sends); if
 *     anything is not as agreed, the question and its Send button are never
 *     shown;
 *   - the title is cleaned here, as everything shown is where it is shown
 *     (i18n.mjs itemTitle): one line, nothing invisible or bidirectional,
 *     whatever the event's title went through before;
 *   - the mailbox that sends is named by its address: with several
 *     mailboxes, the user sees in whose name the message would leave;
 *   - every recipient is listed, in a list that scrolls: a long title or a
 *     long list never pushes the buttons out of the window (confirm.css);
 *   - everything goes through textContent, never HTML, under the default
 *     content security policy;
 *   - the focus starts on "Don't send"; Escape and closing the window mean
 *     "Don't send"; "Send" works once, then both buttons are disabled;
 *   - the window never closes on a message still on its way: it closes once
 *     the background has answered, and says nothing while it is being closed
 *     (a message that can no longer be answered is reported by Thunderbird
 *     as an error of the extension);
 *   - an unknown, used or expired token gives an explanation and a Close
 *     button, and sends nothing.
 *
 * ── Protocol: page → background (runtime.sendMessage) ─────────────────────
 *
 * { type: "meetingConfirmInfo", token }
 *   → { kind: "invite" | "update" | "cancel", summary, start, allDay, recipients: [email], from: email }
 *     summary     the event's title ("" when it has none)
 *     start       "YYYY-MM-DDTHH:MM:SSZ", or "YYYY-MM-DD" when allDay is true
 *                 (the UTC and DATE forms of the item description)
 *     recipients  1 to 100 addresses, each one valid (sanitize.mjs emailAddress)
 *     from        the address of the mailbox that would send, valid too
 *   { ok: false, … } (the token is unknown, used or expired) or anything
 *   else: there is nothing to confirm.
 *
 * { type: "meetingConfirm", token, send: boolean }
 *   The user's answer, sent at most once: Send, Don't send (Escape too), or
 *   Close on a window that has nothing to offer while the background may
 *   still be waiting. A window closed without an answer sends nothing: the
 *   background sees it go (windows.onRemoved) and takes that, like a token
 *   older than 10 minutes, as "Don't send".
 *   → { ok: false, … }: the token was no longer valid, nothing was sent.
 *     Any other answer: the background took it.
 */

import { t, uiLanguage, localizePage, itemTitle } from "../i18n.mjs";
import { emailAddress } from "../core/sanitize.mjs";

/** A meeting message never has more recipients than this (security rule 25). */
export const MAX_RECIPIENTS = 100;

const TOKEN = /^[\x21-\x7e]{1,256}$/;
const UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The question asked for each kind of message. */
const QUESTIONS = new Map([
  ["invite", () => t("confirmAskInvite")],
  ["update", () => t("confirmAskUpdate")],
  ["cancel", () => t("confirmAskCancel")],
]);

const pad = (n) => String(n).padStart(2, "0");

/** The token of the page's address ("?token=…"): 1 to 256 visible ASCII characters, given once; null otherwise. */
export function tokenOf(search) {
  if (typeof search !== "string") return null;
  let token = null;
  for (const part of search.replace(/^\?/, "").split("&")) {
    const at = part.indexOf("=");
    if ((at < 0 ? part : part.slice(0, at)) !== "token") continue;
    if (token !== null) return null; // given twice: neither is answered
    try {
      token = decodeURIComponent(at < 0 ? "" : part.slice(at + 1));
    } catch {
      return null;
    }
  }
  return token !== null && TOKEN.test(token) ? token : null;
}

/**
 * When an event starts, in milliseconds: from "YYYY-MM-DDTHH:MM:SSZ", or from
 * "YYYY-MM-DD" (midnight UTC of that day) when it lasts all day. null when
 * `start` is not exactly that: a real day, between 1900 and 2200.
 */
export function startTime(start, allDay) {
  if (typeof start !== "string" || typeof allDay !== "boolean") return null;
  const m = (allDay ? DATE : UTC).exec(start);
  if (!m) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = m.slice(1).map(Number);
  if (year < 1900 || year > 2200 || hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(time);
  // 31 February would otherwise pass as a day of March.
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? time : null;
}

/**
 * What the background says would be sent, checked.
 * → { kind, summary, allDay, time, recipients, from }, or null when anything
 * is not as agreed: the window then has nothing to offer.
 */
export function checkInfo(answer) {
  if (!answer || typeof answer !== "object" || answer.ok === false) return null;
  if (typeof answer.kind !== "string" || !QUESTIONS.has(answer.kind)) return null;
  if (typeof answer.summary !== "string") return null;
  const time = startTime(answer.start, answer.allDay);
  if (time === null) return null;
  const list = answer.recipients;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RECIPIENTS) return null;
  // All of them or nothing: a list that left one out would hide who is written to.
  const recipients = [];
  for (let i = 0; i < list.length; i++) {
    const address = list[i];
    if (typeof address !== "string" || emailAddress(address) !== address) return null;
    recipients.push(address);
  }
  // Who sends is part of what is confirmed: without a valid address, nothing is offered.
  if (typeof answer.from !== "string" || emailAddress(answer.from) !== answer.from) return null;
  return { kind: answer.kind, summary: itemTitle(answer.summary), allDay: answer.allDay, time, recipients, from: answer.from };
}

/** Intl formatting in the interface's language; `fallback` where Intl cannot do it. */
function format(time, options, fallback) {
  try {
    return new Intl.DateTimeFormat(uiLanguage(), options).format(new Date(time));
  } catch {
    return fallback;
  }
}

/**
 * When the event starts, as the interface's language writes it: the day in
 * full and the time, in the computer's time zone (`timeZone`: another one,
 * for the tests); an all-day event has its day, and no time.
 */
export function whenText({ allDay, time }, { timeZone } = {}) {
  const d = new Date(time);
  if (allDay) {
    // A day, not an instant: the same day whatever the computer's time zone.
    const day = d.toISOString().slice(0, 10);
    return t("confirmAllDay", format(time, { dateStyle: "full", timeZone: "UTC" }, day));
  }
  // The fallback when the interface cannot format the date: day and time, as numbers.
  const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(pad).join("-");
  const local = `${day} ${[d.getHours(), d.getMinutes()].map(pad).join(":")}`;
  return format(time, { dateStyle: "full", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }, local);
}

/** "1 recipient", "12 recipients". */
export const recipientsText = (count) => (count === 1 ? t("confirmRecipientsOne") : t("confirmRecipientsMany", count));

/** The question of the window for `kind` ("" for another kind). */
export const questionText = (kind) => QUESTIONS.get(kind)?.() ?? "";

const expiredText = () => `${t("confirmExpired")} ${t("confirmNothingSent")}`;
const unexpectedText = () => `${t("badAnswer")} ${t("confirmNothingSent")}`;

/**
 * Runs the window. `doc` and `win`: the page's document and window; `api`:
 * messenger (or browser). → a promise, settled once the window shows its
 * question, or why it has none.
 */
export function startConfirm({ doc, win, api }) {
  const $ = (id) => doc.getElementById(id);
  const token = tokenOf(win.location?.search);
  let asking = false; // the question is shown, and has no answer yet
  let pending = false; // the background may still be waiting for this window
  let answered = false; // an answer has left: there is never a second one

  /** The user's answer, at most once. → the background's reply (a promise); throws when it cannot be sent. */
  function tell(send) {
    answered = true;
    return api.runtime.sendMessage({ type: "meetingConfirm", token, send });
  }

  /** Nothing to confirm (any more): why, and a Close button. */
  function over(text) {
    asking = false;
    $("ask").hidden = true;
    $("over-text").textContent = text;
    $("over").hidden = false;
    $("close").focus();
  }

  function show(info) {
    $("question").textContent = questionText(info.kind);
    $("summary").textContent = info.summary;
    $("when").textContent = whenText(info);
    $("from").textContent = info.from;
    $("count").textContent = recipientsText(info.recipients.length);
    const items = info.recipients.map((address) => {
      const li = doc.createElement("li");
      li.textContent = address;
      return li;
    });
    $("recipients").replaceChildren(...items);
    // Shown only once everything above is in place.
    $("ask").hidden = false;
    asking = true;
    $("dont-send").focus(); // the safe choice: a key pressed too early sends nothing
  }

  /** "Send" or "Don't send": once, and only while the question is shown. */
  async function answer(send) {
    if (!asking || answered) return;
    asking = false;
    $("send").disabled = true;
    $("dont-send").disabled = true;
    if (send) $("progress").textContent = t("confirmSending");
    let reply;
    let reached = true;
    try {
      reply = await tell(send);
    } catch {
      reached = false;
    }
    pending = false;
    $("progress").textContent = "";
    if (!send) win.close();
    else if (!reached) over(t("confirmUncertain"));
    else if (reply && typeof reply === "object" && reply.ok === false) over(expiredText());
    else win.close();
  }

  /**
   * The window is going (its own close button, the background closing it,
   * Thunderbird quitting): nothing more happens here, and nothing is said.
   * The background sees the window go, and takes it as "Don't send".
   */
  function gone() {
    asking = false;
    pending = false;
  }

  /**
   * Close, or Escape when there is no question to answer: "Don't send" is
   * said to the background if it may still be waiting, and the window
   * closes once it has answered (or cannot be reached).
   */
  function leave() {
    asking = false;
    if (!pending || answered) {
      win.close();
      return;
    }
    pending = false;
    const close = () => win.close();
    try {
      Promise.resolve(tell(false)).then(close, close);
    } catch {
      close();
    }
  }

  async function load() {
    if (token === null) {
      over(expiredText());
      return;
    }
    pending = true;
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: "meetingConfirmInfo", token });
    } catch {
      pending = false;
      over(unexpectedText());
      return;
    }
    if (answered || !pending) return; // the window was left meanwhile
    const info = checkInfo(reply);
    if (info) {
      try {
        show(info);
        return;
      } catch {
        // Falls through: nothing half shown is offered.
      }
    } else if (reply && typeof reply === "object" && reply.ok === false) {
      pending = false; // the background knows this token no more
      over(expiredText());
      return;
    }
    over(unexpectedText());
  }

  localizePage(doc);
  $("send").addEventListener("click", () => answer(true));
  $("dont-send").addEventListener("click", () => answer(false));
  $("close").addEventListener("click", leave);
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (asking) answer(false);
    else if (!answered) leave();
    else if (!$("over").hidden) win.close();
  });
  // The window's own close button, the background closing it, or Thunderbird quitting.
  win.addEventListener("pagehide", gone);
  return load();
}

if (typeof document !== "undefined") {
  const api = globalThis.messenger ?? globalThis.browser;
  // Outside Thunderbird there is nothing to confirm, and no text to show: the page stays empty.
  if (api?.runtime?.sendMessage && api?.i18n) startConfirm({ doc: document, win: window, api });
}
