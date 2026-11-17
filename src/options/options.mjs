// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Settings page: mailboxes, the mailbox form, the log.
 *
 * The page never writes storage, passwords or accounts itself: it asks the
 * background (runtime.sendMessage), which validates everything again. It
 * only reads: statuses are refreshed when storage changes
 * (storage.onChanged); the background never broadcasts to it.
 * Everything shown goes through textContent (never HTML), under the
 * default content security policy.
 *
 * ── Protocol: page → background (runtime.sendMessage) ─────────────────────
 *
 * Every answer is an object. Failure, for any request:
 *   { ok: false, error: "<sentence in the interface's language, shown as it is>", field?, detail? }
 *   detail: the engine's French reason, when `error` does not show it (a tooltip).
 *   field (saveMailbox): "email" | "username" | "password" | "name" | "server"
 *   | "syncMinutes" | "filterType" | "sync" | "calendarPeriod" | "taskFilter",
 *   the form field to point at.
 *
 * { type: "listMailboxes" }
 *   → { ok: true, mailboxes: [MailboxView] }, in display order
 *   MailboxView = { id, email, username, name, origin, server, syncMinutes,
 *                   filterType, calendarPeriod, taskFilter, sync, status }
 *     id           12 hexadecimal digits (store.newIds)
 *     username     "" when the e-mail address is the sign-in name
 *     origin       "https://host[:port]"; server: "host[:port]" (parseServer().display)
 *     syncMinutes  0 (as soon as mail arrives: Ping) | 1 | 5 | 15 | 30 | 60
 *     filterType   "1" 1 day | "2" 3 days | "3" 1 week | "4" 2 weeks | "5" 1 month | "0" all
 *     calendarPeriod  "4" 2 weeks | "5" 1 month | "6" 3 months | "7" 6 months | "0" all
 *                  (past events; future ones are always synchronized). Absent from a
 *                  mailbox saved before calendars were synchronized: "7".
 *     taskFilter   "0" all tasks | "8" incomplete tasks only. Absent as above: "0".
 *     sync         { mail, calendar, contacts, tasks } booleans, at least one true
 *     status       { running: boolean,
 *                    lastSuccessAt: ms | null,
 *                    nextAttemptAt: ms (0: none),
 *                    lastError: { code, message, at } | null,
 *                    blocked: { code, message, at } | null,
 *                    pendingDeletes: number,
 *                    failedItems: number,
 *                    failedCalendarItems: number }
 *                  blocked.code "MASS_DELETE": deletions from the server held
 *                  back by the mass-deletion threshold (pendingDeletes of them:
 *                  messages, folders, events and tasks together), waiting for
 *                  "Confirmer les suppressions" (syncMailbox with
 *                  confirmDeletes) or "Garder les copies locales" (discardDeletes).
 *                  failedItems: items whose import keeps failing, shown after
 *                  the status when there are any; failedCalendarItems: the
 *                  events and tasks among them (messages are tried again at
 *                  every sync, events and tasks are not).
 *
 * { type: "saveMailbox", mailbox: MailboxInput, password: string | null }
 *   → { ok: true, id }
 *   MailboxInput = { id: string | null (null: new mailbox), email,
 *                    username ("" = the e-mail address), name,
 *                    server (parseServer().display), syncMinutes, filterType,
 *                    calendarPeriod, taskFilter, sync }
 *   calendarPeriod and taskFilter are always sent, whether calendar and tasks
 *   are checked or not (their fields are hidden when they are not, and keep
 *   their value).
 *   password null keeps the stored password; it is refused for a new
 *   mailbox, and when the origin or the sign-in name changes (the password
 *   only ever goes to the origin it was typed for). Unchecking the calendar
 *   or the tasks of a mailbox that synchronised them removes their local
 *   copies at the next sync, and another server or sign-in name removes
 *   the mailbox's calendars before the new server is read; either way the
 *   changes not yet sent are lost: the page asks the user first
 *   (uncheckConfirm, moveConfirm), and sends nothing without a yes. The page has already
 *   obtained the host permission https://host/* (permissions.request, in the
 *   submit handler: Thunderbird only asks during a user action). The
 *   background checks everything again (parseServer, checkMailbox, the
 *   permission), creates or updates the Thunderbird account, stores the
 *   password, removes the host permissions no mailbox uses any more, and
 *   starts a sync.
 *
 * { type: "removeMailbox", id } → { ok: true }
 *   The mailbox, its records, its Thunderbird account, its calendars and its
 *   password go; so does the host permission if no other mailbox uses that server.
 *   Nothing is deleted on the server.
 *
 * { type: "syncMailbox", id, confirmDeletes?: true } → { ok: true }
 *   Sync now, whatever happened before (health.clearForUser). confirmDeletes:
 *   apply the deletions held back by the mass-deletion threshold (sent only
 *   by "Confirmer les suppressions").
 *
 * { type: "discardDeletes", id } → { ok: true }
 *   The deletions held back by the mass-deletion threshold are dropped: the
 *   local copies stay, the mail folders concerned are synchronised again
 *   with the server, the events and tasks kept are no longer linked to it,
 *   and a sync starts (sent only by "Garder les copies locales", after the
 *   user confirmed).
 *
 * { type: "getLog" }  → { ok: true, entries: [{ t, level, msg, details? }], debugUntil }
 *   (log.getLog(); debugUntil: ms since the epoch, 0 when debugging is off)
 * { type: "clearLog" } → { ok: true }
 * { type: "setDebug", enabled: boolean } → { ok: true, debugUntil }
 *   (log.setDebugFor(enabled ? one hour : 0))
 *
 * ── Storage keys the page watches (storage.local, read-only here) ─────────
 *   "mailboxes", "mb/<id>/health", "mb/<id>/pendingDeletes", "mb/<id>/status"
 *     → listMailboxes again (the background may write "mb/<id>/status",
 *       e.g. { running: true }, for the page to show a sync under way);
 *   "log", "settings" → getLog again.
 */

import {
  FREQUENCIES,
  PERIODS,
  KINDS,
  FIELD_ORDER,
  discardConfirm,
  uncheckConfirm,
  moveConfirm,
  validateForm,
  formValues,
  statusView,
  frequencyLabel,
  periodLabel,
  kindsLabel,
  logText,
  debugText,
  shown,
} from "./form.mjs";
import { MAILBOX_ID } from "../core/ids.mjs";
import { SYNC_KINDS } from "../sync/store.mjs";
import { t, localizePage } from "../i18n.mjs";

const api = globalThis.messenger ?? globalThis.browser;
const FIELDS = new Set(FIELD_ORDER);
// Fields read and filled through their value (the check boxes of the items are apart).
const VALUE_FIELDS = ["email", "password", "name", "server", "username", "syncMinutes", "period"];
/** The fields inside "More settings" (a details element, closed for a new mailbox). */
const MORE_FIELDS = new Set(["name", "username", "syncMinutes"]);
const WATCHED = /^mb\/[a-f0-9]{12}\/(?:health|pendingDeletes|status)$/;

const $ = (id) => document.getElementById(id);
const errorText = (res, fallback) => shown(res?.error) || fallback;
const labelOf = (mb) => shown(mb?.name) || shown(mb?.email) || t("unnamed");

let mailboxes = []; // as last listed by the background
let editing = null; // the mailbox in the form, null for a new one
let saving = false;
let listSeq = 0;
let logSeq = 0;
let debugTimer = null;
const confirming = new Set(); // mailboxes whose deletion awaits confirmation
const busy = new Set(); // mailboxes with a request under way
const items = new Map(); // mailbox id → its list item and parts
const timers = new Map(); // debounced refreshes

// ── Background ────────────────────────────────────────────────────────────

async function call(type, payload = {}) {
  let res;
  try {
    res = await api.runtime.sendMessage({ ...payload, type });
  } catch {
    return { ok: false, error: t("noAnswer") };
  }
  return res && typeof res === "object" ? res : { ok: false, error: t("badAnswer") };
}

function notice(text, { error = false } = {}) {
  const p = $("notice");
  p.textContent = text;
  p.classList.toggle("error", error);
  p.hidden = !text;
}

function later(name, fn, ms = 250) {
  if (timers.has(name)) return;
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      fn();
    }, ms),
  );
}

// ── Mailbox list ──────────────────────────────────────────────────────────

async function refreshMailboxes() {
  const seq = ++listSeq;
  const res = await call("listMailboxes");
  if (seq !== listSeq) return; // a newer answer is on its way
  if (res.ok !== true || !Array.isArray(res.mailboxes)) {
    notice(errorText(res, t("listFailed")), { error: true });
    return;
  }
  mailboxes = res.mailboxes.filter((m) => m && typeof m === "object" && typeof m.id === "string" && MAILBOX_ID.test(m.id));
  renderMailboxes();
  if (editing && !mailboxes.some((m) => m.id === editing.id)) {
    closeEditor();
    notice(t("editedRemoved"));
  }
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const b = element("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function createItem(id) {
  const li = element("li", "mailbox");
  const name = element("h3", "mb-name");
  name.id = `mb-${id}-name`;
  const email = element("span", "mb-email");
  const title = element("div", "mb-title");
  title.append(name, email);
  const meta = element("p", "mb-meta");
  const status = element("p", "mb-status");

  const mass = element("div", "mb-mass");
  const massButton = button(t("confirmDeletes"), "primary", () => syncNow(id, true));
  const keepButton = button(t("keepLocalCopies"), "", () => keepLocalCopies(id));
  mass.append(massButton, keepButton);

  const actions = element("div", "mb-actions");
  const syncButton = button(t("syncButton"), "", () => syncNow(id, false));
  const editButton = button(t("editButton"), "", () => openEditor(id));
  const removeButton = button(t("removeButton"), "danger", () => askRemove(id));
  actions.append(syncButton, editButton, removeButton);

  const confirm = element("div", "mb-confirm");
  const question = element("p");
  question.id = `mb-${id}-question`;
  confirm.setAttribute("role", "group");
  confirm.setAttribute("aria-labelledby", question.id);
  const yes = button(t("removeConfirmButton"), "danger", () => remove(id));
  const no = button(t("cancel"), "", () => cancelRemove(id));
  confirm.append(question, yes, no);

  // Each button says which mailbox it acts on.
  for (const b of [massButton, keepButton, syncButton, editButton, removeButton]) b.setAttribute("aria-describedby", name.id);
  li.append(title, meta, status, mass, actions, confirm);
  return { li, name, email, meta, status, mass, actions, confirm, question, removeButton, no, buttons: [massButton, keepButton, syncButton, editButton, removeButton, yes, no] };
}

function updateItem(item, mb) {
  const label = labelOf(mb);
  const email = shown(mb.email);
  item.name.textContent = label;
  item.email.textContent = email !== label ? email : "";
  const server = shown(mb.server);
  item.meta.textContent = [server, frequencyLabel(mb.syncMinutes), periodLabel(mb), kindsLabel(mb.sync)].join(" · ");
  const view = statusView(mb.status);
  item.status.textContent = view.text;
  item.status.title = view.detail ?? "";
  item.status.className = `mb-status tone-${view.tone}`;
  item.mass.hidden = view.massDelete === null;
  const asking = confirming.has(mb.id);
  item.confirm.hidden = !asking;
  item.actions.hidden = asking;
  item.question.textContent = t("removeQuestion", label);
  for (const b of item.buttons) b.disabled = busy.has(mb.id);
}

function renderMailboxes() {
  const list = $("mailboxes");
  $("mailboxes-empty").hidden = mailboxes.length > 0;
  const seen = new Set();
  let previous = null;
  for (const mb of mailboxes) {
    seen.add(mb.id);
    let item = items.get(mb.id);
    if (!item) {
      item = createItem(mb.id);
      items.set(mb.id, item);
    }
    updateItem(item, mb);
    // Moved only when out of place, so that focus stays where it is.
    const expected = previous ? previous.nextSibling : list.firstChild;
    if (expected !== item.li) list.insertBefore(item.li, expected);
    previous = item.li;
  }
  for (const [id, item] of items) {
    if (seen.has(id)) continue;
    item.li.remove();
    items.delete(id);
    confirming.delete(id);
  }
}

async function syncNow(id, confirmDeletes) {
  if (busy.has(id)) return;
  busy.add(id);
  renderMailboxes();
  const res = await call("syncMailbox", confirmDeletes ? { id, confirmDeletes: true } : { id });
  busy.delete(id);
  renderMailboxes();
  if (res.ok === true) notice(confirmDeletes ? t("deletesConfirmed") : t("syncStarted"));
  else notice(errorText(res, t("syncNotStarted")), { error: true });
}

async function keepLocalCopies(id) {
  if (busy.has(id) || !window.confirm(discardConfirm(mailboxes.find((m) => m.id === id)))) return;
  busy.add(id);
  renderMailboxes();
  const res = await call("discardDeletes", { id });
  busy.delete(id);
  renderMailboxes();
  if (res.ok === true) notice(t("localCopiesKept"));
  else notice(errorText(res, t("deletesNotDiscarded")), { error: true });
}

function askRemove(id) {
  confirming.add(id);
  renderMailboxes();
  items.get(id)?.no.focus(); // the safe choice has the focus
}

function cancelRemove(id) {
  confirming.delete(id);
  renderMailboxes();
  items.get(id)?.removeButton.focus();
}

async function remove(id) {
  if (busy.has(id)) return;
  const label = labelOf(mailboxes.find((m) => m.id === id));
  busy.add(id);
  renderMailboxes();
  const res = await call("removeMailbox", { id });
  busy.delete(id);
  confirming.delete(id);
  if (res.ok === true) {
    if (editing?.id === id) closeEditor();
    notice(t("mailboxRemoved", label));
  } else {
    notice(errorText(res, t("mailboxNotRemoved")), { error: true });
  }
  await refreshMailboxes();
  $("add").focus();
}

// ── Form ──────────────────────────────────────────────────────────────────

function buildForm() {
  const minutes = $("syncMinutes");
  for (const [value, label] of FREQUENCIES) minutes.append(new Option(label(), String(value)));
  const period = $("period");
  for (const [value, label] of PERIODS) period.append(new Option(label(), value));
  const kinds = $("kinds");
  for (const kind of KINDS) {
    const wrap = element("div");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `kind-${kind.key}`;
    const label = element("label", "", kind.label);
    label.htmlFor = box.id;
    wrap.append(box, " ", label);
    kinds.append(wrap);
  }
}

function fillForm(values) {
  for (const field of VALUE_FIELDS) $(field).value = values[field];
  for (const k of SYNC_KINDS) $(`kind-${k}`).checked = values.sync[k] === true;
}

function readForm() {
  const values = {};
  for (const field of VALUE_FIELDS) values[field] = $(field).value;
  values.sync = Object.fromEntries(SYNC_KINDS.map((k) => [k, $(`kind-${k}`).checked]));
  return values;
}

function clearErrors() {
  $("form-error").hidden = true;
  $("form-error").textContent = "";
  $("form-error").title = "";
  for (const field of FIELDS) {
    const p = $(`${field}-error`);
    p.hidden = true;
    p.textContent = "";
    p.title = "";
    $(field).removeAttribute("aria-invalid");
  }
}

/** errors: [{ field, message, detail? }]; detail: the engine's French reason, as a tooltip. */
function showErrors(errors) {
  let first = null;
  const general = [];
  const details = [];
  for (const { field, message, detail } of errors) {
    // An error on something the form does not ask goes above the form, where it can be read.
    if (!FIELDS.has(field)) {
      general.push(message);
      if (detail) details.push(detail);
      continue;
    }
    const p = $(`${field}-error`);
    p.textContent = message;
    p.title = detail ?? "";
    p.hidden = false;
    $(field).setAttribute("aria-invalid", "true");
    if (MORE_FIELDS.has(field)) $("more").open = true;
    first ??= field;
  }
  if (general.length) {
    $("form-error").textContent = general.join(" ");
    $("form-error").title = details.join(" ");
    $("form-error").hidden = false;
  }
  if (first === "sync") $(`kind-${SYNC_KINDS[0]}`).focus();
  else if (first) $(first).focus();
}

function openEditor(id = null) {
  const mb = id ? mailboxes.find((m) => m.id === id) : null;
  if (id && !mb) return;
  editing = mb;
  clearErrors();
  fillForm(formValues(mb));
  // Closed for a new mailbox: the address, the password and the server are enough.
  $("more").open = Boolean(mb);
  $("editor-title").textContent = mb ? t("editMailbox", labelOf(mb)) : t("newMailbox");
  $("password-hint").textContent = mb ? t("passwordHintEdit") : t("passwordHintNew");
  $("editor").hidden = false;
  $("editor").scrollIntoView({ block: "nearest" });
  $("email").focus();
}

function closeEditor() {
  $("editor").hidden = true;
  $("password").value = "";
  editing = null;
  clearErrors();
}

function setFormBusy(on) {
  $("save").disabled = on;
  $("save").textContent = on ? t("saving") : t("save");
}

function onSubmit(event) {
  event.preventDefault();
  if (saving) return;
  clearErrors();
  // The latest copy of the mailbox being edited (the list may have been refreshed).
  const existing = editing ? mailboxes.find((m) => m.id === editing.id) ?? editing : null;
  const result = validateForm(readForm(), existing);
  if (!result.ok) {
    showErrors(result.errors);
    return;
  }
  // Calendar or tasks unchecked: their local copies would go at the next sync. Nothing is sent without a yes.
  const question = existing ? uncheckConfirm(existing, result.request.mailbox.sync, labelOf(existing)) : "";
  if (question && !window.confirm(question)) return;
  // Another server or sign-in name: the calendars made from the old one leave Thunderbird, with what was not sent yet.
  const moving = existing ? moveConfirm(existing, result.server, result.request.mailbox, labelOf(existing)) : "";
  if (moving && !window.confirm(moving)) return;
  // Asked now, before any await: Thunderbird shows the request only during a user action.
  let permission;
  try {
    permission = api.permissions.request({ origins: [result.permission] });
  } catch (e) {
    permission = Promise.reject(e);
  }
  saving = true;
  setFormBusy(true);
  save(result, permission, existing).finally(() => {
    saving = false;
    setFormBusy(false);
  });
}

async function save(result, permission, existing) {
  let granted = false;
  try {
    granted = (await permission) === true;
  } catch {
    granted = false;
  }
  if (!granted) {
    showErrors([
      {
        field: "server",
        message: t("permissionMissing", result.server.display),
      },
    ]);
    return;
  }
  const res = await call("saveMailbox", result.request);
  if (res.ok !== true) {
    showErrors([{ field: FIELDS.has(res.field) ? res.field : null, message: errorText(res, t("mailboxNotSaved")), detail: shown(res.detail) }]);
    return;
  }
  const label = shown(result.request.mailbox.name);
  closeEditor();
  notice(existing ? t("mailboxSaved", label) : t("mailboxAdded", label));
  await refreshMailboxes();
  $("add").focus();
}

// ── Diagnostic ────────────────────────────────────────────────────────────

async function refreshLog() {
  const seq = ++logSeq;
  const res = await call("getLog");
  if (seq !== logSeq) return;
  if (res.ok !== true) {
    $("log").textContent = errorText(res, t("logUnavailable"));
    return;
  }
  $("log").textContent = logText(Array.isArray(res.entries) ? res.entries : []);
  setDebugState(Number(res.debugUntil) || 0);
}

function setDebugState(until) {
  const now = Date.now();
  $("debug").checked = until > now;
  $("debug-status").textContent = debugText(until, now);
  if (debugTimer !== null) clearTimeout(debugTimer);
  debugTimer = null;
  // Shown as off once it has switched itself off.
  if (until > now) debugTimer = setTimeout(refreshLog, Math.min(until - now + 500, 3_700_000));
}

async function onDebugChange() {
  const box = $("debug");
  const enabled = box.checked;
  box.disabled = true;
  const res = await call("setDebug", { enabled });
  box.disabled = false;
  if (res.ok === true) {
    setDebugState(Number(res.debugUntil) || 0);
  } else {
    box.checked = !enabled;
    notice(errorText(res, t("debugNotChanged")), { error: true });
  }
  await refreshLog();
}

async function onClearLog() {
  const res = await call("clearLog");
  if (res.ok !== true) notice(errorText(res, t("logNotCleared")), { error: true });
  await refreshLog();
}

// ── Start ─────────────────────────────────────────────────────────────────

function start() {
  if (!api?.runtime?.sendMessage || !api?.i18n) {
    // Opened outside Thunderbird: no text but this one, in English (the default language).
    $("outside").hidden = false;
    return;
  }
  localizePage(document);
  buildForm();
  $("add").addEventListener("click", () => openEditor(null));
  $("form").addEventListener("submit", onSubmit);
  $("cancel").addEventListener("click", () => {
    closeEditor();
    $("add").focus();
  });
  $("debug").addEventListener("change", onDebugChange);
  $("log-refresh").addEventListener("click", () => refreshLog());
  $("log-clear").addEventListener("click", onClearLog);
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes || typeof changes !== "object") return;
    const keys = Object.keys(changes);
    if (keys.some((k) => k === "mailboxes" || WATCHED.test(k))) later("list", refreshMailboxes);
    if (keys.some((k) => k === "log" || k === "settings")) later("log", refreshLog);
  };
  api.storage.onChanged.addListener(onStorage);
  // Removed while the page can still reach the extension: Thunderbird 140 would
  // otherwise remove it after closing the page's channel, and log an error.
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) api.storage.onChanged.removeListener(onStorage);
  });
  // Times shown ("Next attempt at 14:05", today or another day) stay right as time passes.
  setInterval(() => later("list", refreshMailboxes), 60_000);
  refreshMailboxes();
  refreshLog();
}

start();
