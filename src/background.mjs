// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Background page: wires the modules together.
 *
 *  - one MailboxSync per mailbox (sync/mailbox.mjs), one MailStore per
 *    Thunderbird account (tb/mail-store.mjs), one shared EchoRegistry;
 *  - every request goes through a verified connection (sync443Net) and an
 *    EasClient built with the mailbox's own origin, password and pins;
 *  - local actions (tb/events.mjs) become journal entries, sent shortly after;
 *  - fail-closed sending (send.mjs), installed before anything else;
 *  - the settings page talks to us through runtime.sendMessage (protocol in
 *    options/options.mjs) and follows our records through storage.onChanged;
 *  - timers (alarms), the "Synchronize" button and menus.
 *
 * What the user sees is in the language of Thunderbird (i18n.mjs); the log
 * stays in French. Nothing here holds a password longer than the client
 * that uses it.
 */

import { Store, checkMailbox, newIds, SYNC_KINDS } from "./sync/store.mjs";
import { parseServer } from "./core/server.mjs";
import { EasClient, EasError, ERR } from "./transport/client.mjs";
import { emailAddress, cleanText, personName } from "./core/sanitize.mjs";
import { userInformationRequest, parseUserInformation } from "./core/protocol.mjs";
import { log, setDebugFor, getLog, clearLog, loadLog, errorCode } from "./log.mjs";
import { installSendHandler } from "./send.mjs";
import { initialHealth } from "./sync/health.mjs";
import { MailboxSync } from "./sync/mailbox.mjs";
import { MailStore } from "./tb/mail-store.mjs";
import { LocalEvents } from "./tb/events.mjs";
import { EchoRegistry } from "./sync/echo.mjs";
import { t, uiLanguage, errorText, errorDetail, serverErrorText } from "./i18n.mjs";

const api = globalThis.browser;
const ALARM = "sync443:";
const PUSH_FALLBACK_MINUTES = 30; // safety net when immediate delivery (push) is on
const LOCAL_DELAY_MS = 3000; // local actions are sent shortly after the last one
const STARTUP_DELAY_MS = 10_000;
const MAX_ROUNDS = 10; // passes in a row while the server has more to send
const MAX_HANDOVER = 10_000; // local actions kept while an engine is being replaced
const FREQUENCIES = new Set([0, 1, 5, 15, 30, 60]);
const PERIODS = new Set(["0", "1", "2", "3", "4", "5"]);
// Refused in a sign-in name, as the account experiment refuses them (controls, invisible, bidirectional).
const LOGIN_REFUSED = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;

const store = new Store(api.storage.local);
const echo = new EchoRegistry();
const entries = new Map(); // mailbox id -> { mailbox, sync, inFlight, again, againUser, againConfirm, timer, closing, buffer, handover }
const marked = new Set(); // account keys of our mailboxes
// Test builds only. The blocks between "// <test-hooks>" and "// </test-hooks>"
// are removed by tools/build_xpi.py: in a published package this stays null.
let testConfig = null;
let ready = null;

/** How a mailbox is named in the log: never its address or display name (rule 13). */
const label = (mb) => `boîte ${mb.id}`;

/** clearTimeout, where there is one (the unit tests' JavaScript shell has none). */
const cancelTimer = (t) => {
  if (t !== null && t !== undefined && typeof clearTimeout === "function") clearTimeout(t);
};

const notify = (message) =>
  api.notifications
    .create({ type: "basic", title: "Sync443", message: cleanText(String(message), { max: 300, singleLine: true, stripBidi: true }) })
    .catch(() => {});

// ── Sending: installed first, so no message can leave before it exists ─────

installSendHandler({
  clientFor: async (mailboxId) => {
    const mb = await store.getMailbox(mailboxId);
    if (!mb) throw new EasError(ERR.CONFIG, "Boîte inconnue.", { key: "errorUnknownMailbox" });
    return clientFor(mb);
  },
  accountOfIdentity: (identityId) => api.sync443Account.accountOfIdentity(identityId),
  // The identity must still send through our neutral server (repaired if the user relinked it).
  checkSendRoute: (identityId) => api.sync443Account.checkSendRoute(identityId),
  afterSend: (mailboxId) => runSync(mailboxId, { reason: "envoi" }),
  log,
  notify,
});

// ── Clients ──────────────────────────────────────────────────────────────

const serverOf = (origin) => parseServer(origin, { allowLocal: Boolean(testConfig?.allowLocal) });
const loginOf = (mb) => mb.username || mb.email;

async function passwordOf(mb) {
  try {
    return await api.sync443Account.getPassword(mb.origin, loginOf(mb));
  } catch (e) {
    // LOCKED: the primary password was not entered; temporary, retried later.
    throw new EasError(/^LOCKED:/.test(e?.message ?? "") ? ERR.NETWORK : ERR.CONFIG, "Mot de passe inaccessible pour le moment.", {
      key: "errorPasswordLocked",
    });
  }
}

async function clientFor(mb, password = null) {
  const pw = password ?? (await passwordOf(mb));
  if (!pw) throw new EasError(ERR.CONFIG, "Mot de passe absent : modifiez la boîte pour le saisir.", { key: "errorPasswordAbsent" });
  const records = store.mailbox(mb.id);
  return new EasClient({
    server: serverOf(mb.origin),
    username: loginOf(mb),
    password: pw,
    deviceId: mb.deviceId,
    connector: api.sync443Net,
    pins: mb.tlsPins,
    proto: await records.get("proto", null),
    saveProto: (p) => records.set("proto", p),
    log,
  });
}

// ── One engine per mailbox ───────────────────────────────────────────────

/**
 * Stop an engine for good: no pass, no Ping, no storage write after this.
 * Local actions recorded meanwhile wait in `entry.buffer` (handed to the
 * next engine by attach()).
 */
async function retire(entry) {
  entry.closing = true;
  cancelTimer(entry.timer);
  if (!entry.sync) return;
  await entry.sync.close().catch((e) => log.warn(`Arrêt du moteur (${label(entry.mailbox)}) : ${errorCode(e)}.`));
  await entry.inFlight?.catch(() => {});
}

/**
 * (Re)start the engine of a mailbox. The previous engine, if any, is fully
 * stopped first, so two engines never work on the same records; actions
 * recorded in between are handed over in order.
 */
async function attach(mb) {
  const old = entries.get(mb.id);
  if (old) await retire(old);
  if (old?.mailbox.accountKey && old.mailbox.accountKey !== mb.accountKey) marked.delete(old.mailbox.accountKey);
  const entry = { mailbox: mb, inFlight: null, again: false, timer: null, sync: null, closing: false, buffer: old?.buffer ?? [], handover: true };
  if (mb.accountKey) {
    marked.add(mb.accountKey);
    entry.sync = new MailboxSync({
      mailbox: mb,
      store,
      clientFactory: () => clientFor(mb),
      mailStore: new MailStore({ accountKey: mb.accountKey, echo }),
      log,
      now: () => Date.now(),
    });
  }
  entries.set(mb.id, entry);
  // Actions that arrive while the buffer drains join its end: order is kept.
  let handed = 0;
  while (entry.buffer.length && entry.sync && !entry.closing) {
    const intent = entry.buffer.shift();
    await entry.sync.recordIntent(intent).then(
      () => handed++,
      (e) => log.warn(`Action locale non enregistrée (${label(mb)}) : ${errorCode(e)}.`),
    );
  }
  if (entry.buffer.length && !entry.closing) {
    log.warn(`${entry.buffer.length} action(s) locale(s) abandonnée(s) (${label(mb)} sans compte Thunderbird).`);
    entry.buffer = [];
  }
  entry.handover = false;
  if (handed && !entry.closing) scheduleLocal(entry);
  return entry;
}

async function detach(id) {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  await retire(entry);
  entry.buffer = [];
  if (entry.mailbox.accountKey && ![...entries.values()].some((e) => e.mailbox.accountKey === entry.mailbox.accountKey)) {
    marked.delete(entry.mailbox.accountKey);
  }
}

async function setRunning(id, running) {
  await store.mailbox(id).set("status", { running }).catch(() => {});
}

/** Run passes for a mailbox; concurrent requests are merged into one more pass. */
function runSync(id, { reason = "auto", confirmDeletes = false } = {}) {
  const entry = entries.get(id);
  if (!entry?.sync || entry.closing) return Promise.resolve();
  if (entry.inFlight) {
    entry.again = true;
    if (reason === "user") entry.againUser = true;
    if (confirmDeletes) entry.againConfirm = true;
    return entry.inFlight;
  }
  entry.inFlight = (async () => {
    await setRunning(id, true);
    updateBadge();
    try {
      let why = reason;
      let confirm = confirmDeletes;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        // `round`: passes of one run share its attempt count (journal entries are tried once per run).
        const result = await entry.sync.run({ reason: why, confirmDeletes: confirm, round });
        if (!result?.moreAvailable) break;
        why = "suite";
        confirm = false;
      }
    } catch (e) {
      // The engine has already recorded the failure in the mailbox's health.
      log.warn(`Synchro (${label(entry.mailbox)}) : ${errorCode(e)}.`);
    } finally {
      await setRunning(id, false);
      entry.inFlight = null;
      updateBadge();
    }
    const current = entries.get(id) === entry && !entry.closing;
    if (entry.again && current) {
      const user = entry.againUser;
      const confirm = entry.againConfirm;
      entry.again = entry.againUser = entry.againConfirm = false;
      await runSync(id, { reason: user ? "user" : "suite", confirmDeletes: confirm });
      return;
    }
    if (entry.mailbox.syncMinutes === 0 && current) entry.sync.startPush();
  })();
  return entry.inFlight;
}

// ── Local actions ────────────────────────────────────────────────────────

function scheduleLocal(entry) {
  cancelTimer(entry.timer);
  entry.timer = setTimeout(() => runSync(entry.mailbox.id, { reason: "local" }), LOCAL_DELAY_MS);
}

function keep(entry, intent) {
  if (entry.buffer.length < MAX_HANDOVER) entry.buffer.push(intent);
  else log.warn(`Action locale abandonnée (${label(entry.mailbox)} : trop d'actions en attente).`);
}

/** A local action on one of our accounts: into its journal, sent shortly after. */
async function onLocalIntent(accountKey, intent) {
  const entry = [...entries.values()].find((e) => e.mailbox.accountKey === accountKey);
  if (!entry?.sync && !entry?.handover) return;
  // Mail not synchronised (unchecked): nothing to send, nothing kept for later.
  if (entry.mailbox.sync?.mail !== true) return;
  // The engine is being replaced: the action waits for the next one.
  if (entry.closing || entry.handover) return keep(entry, intent);
  try {
    await entry.sync.recordIntent(intent);
  } catch (e) {
    if (e?.code !== "CLOSED") throw e;
    return keep(entry, intent);
  }
  scheduleLocal(entry);
}

const events = new LocalEvents({ echo, isMarked: (accountKey) => marked.has(accountKey), onIntent: onLocalIntent, log });

// The user removed one of our accounts in Thunderbird's account settings.
api.accounts.onDeleted.addListener(async (accountKey) => {
  const mb = (await store.listMailboxes()).find((m) => m.accountKey === accountKey);
  if (mb) await removeMailbox(mb.id, { accountGone: true });
});

// ── Timers ───────────────────────────────────────────────────────────────

async function scheduleAlarms() {
  const list = await store.listMailboxes();
  const existing = await api.alarms.getAll();
  for (const a of existing) {
    if (a.name.startsWith(ALARM) && !list.some((m) => ALARM + m.id === a.name)) await api.alarms.clear(a.name);
  }
  for (const mb of list) {
    const minutes = mb.syncMinutes === 0 ? PUSH_FALLBACK_MINUTES : mb.syncMinutes;
    const name = ALARM + mb.id;
    const current = existing.find((a) => a.name === name);
    if (!current || current.periodInMinutes !== minutes) api.alarms.create(name, { delayInMinutes: minutes, periodInMinutes: minutes });
  }
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM)) runSync(alarm.name.slice(ALARM.length), { reason: "auto" });
});

// ── Mailboxes (settings page) ────────────────────────────────────────────

/** A refusal for the settings page: `message` in the interface's language; `detail`: the engine's French reason, if any. */
class FieldError extends Error {
  constructor(field, message, detail = "") {
    super(message);
    this.field = field;
    this.detail = detail;
  }
}

function checkInput(input) {
  if (!input || typeof input !== "object") throw new FieldError(null, t("invalidRequest"));
  const email = emailAddress(String(input.email ?? ""));
  if (!email) throw new FieldError("email", t("invalidEmail"));
  const username = String(input.username ?? "").trim();
  // Basic authentication cannot carry a colon in the user name (RFC 7617).
  if (username.length > 256 || username.includes(":") || LOGIN_REFUSED.test(username) || !username.isWellFormed()) {
    throw new FieldError("username", t("invalidUsername"));
  }
  const name = personName(String(input.name ?? "")) ?? email;
  let server;
  try {
    server = serverOf(String(input.server ?? ""));
  } catch (e) {
    throw new FieldError("server", serverErrorText(e));
  }
  const syncMinutes = Number(input.syncMinutes);
  if (!FREQUENCIES.has(syncMinutes)) throw new FieldError("syncMinutes", t("invalidFrequency"));
  const filterType = String(input.filterType);
  if (!PERIODS.has(filterType)) throw new FieldError("filterType", t("invalidPeriod"));
  const sync = Object.fromEntries(SYNC_KINDS.map((k) => [k, input.sync?.[k] === true]));
  if (!SYNC_KINDS.some((k) => sync[k])) throw new FieldError("sync", t("chooseKind"));
  return { email, username, name, server, syncMinutes, filterType, sync };
}

/** Errors of the connection check, pointed at the field the user can fix. */
function fieldOf(e) {
  switch (e?.code) {
    case ERR.AUTH:
      return "password";
    case ERR.DENIED:
      return "email";
    default:
      return "server";
  }
}

// Saves and removals run one at a time: permissions, accounts, passwords and records are shared.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const saveMailbox = (input, password) => serial(() => saveMailboxNow(input, password));

async function saveMailboxNow(input, password) {
  try {
    return await saveMailboxChecked(input, password);
  } catch (e) {
    // A host permission accepted for a save that failed is given back.
    await prunePermissions().catch(() => {});
    throw e;
  }
}

async function saveMailboxChecked(input, password) {
  const v = checkInput(input);
  const id = input.id ? String(input.id) : null;
  const existing = id ? await store.getMailbox(id) : null;
  if (id && !existing) throw new FieldError(null, t("mailboxGone"));
  const all = await store.listMailboxes();
  if (all.some((m) => m.id !== id && m.email.toLowerCase() === v.email.toLowerCase())) {
    throw new FieldError("email", t("emailTaken"));
  }
  if (existing && existing.email.toLowerCase() !== v.email.toLowerCase()) {
    throw new FieldError("email", t("emailFixed"));
  }
  const login = v.username || v.email;
  if (all.some((m) => m.id !== id && m.origin === v.server.origin && loginOf(m).toLowerCase() === login.toLowerCase())) {
    throw new FieldError("username", t("loginTaken"));
  }
  const newPassword = typeof password === "string" && password.length ? password : null;
  // The password only ever goes to the origin and sign-in name it was typed for.
  const moved = Boolean(existing) && (existing.origin !== v.server.origin || loginOf(existing) !== login);
  if (newPassword) {
    if (newPassword.length > 1024 || newPassword.includes("\u0000")) throw new FieldError("password", t("invalidPassword"));
  } else if (!existing || moved) {
    throw new FieldError("password", existing ? t("passwordRetype") : t("passwordType"));
  }
  const pattern = `https://${v.server.host}/*`;
  if (!(await api.permissions.contains({ origins: [pattern] }))) {
    throw new FieldError("server", t("permissionRefused"));
  }

  const ids = existing ? { mailboxId: existing.id, deviceId: existing.deviceId } : newIds();
  const originChanged = Boolean(existing) && existing.origin !== v.server.origin;
  const draft = checkMailbox({
    id: ids.mailboxId,
    email: v.email,
    username: v.username,
    name: v.name,
    origin: v.server.origin,
    deviceId: ids.deviceId,
    syncMinutes: v.syncMinutes,
    filterType: v.filterType,
    accountKey: existing?.accountKey ?? null,
    // Pins hold for one server only (rule 3).
    tlsPins: existing && !originChanged ? existing.tlsPins : testConfig?.pins ?? [],
    sync: v.sync,
  });

  // Prove the settings with an authenticated command before changing anything.
  // (For another server, the stored protocol state must not be reused.)
  let displayName = null;
  let proto = null;
  try {
    const client = await clientFor(moved ? { ...draft, id: newIds().mailboxId } : draft, newPassword);
    const doc = await client.command("Settings", userInformationRequest(), { timeoutMs: 60_000 });
    displayName = doc ? parseUserInformation(doc).displayName : null;
    proto = { ...client.proto };
  } catch (e) {
    if (!(e instanceof EasError)) throw new FieldError("server", t("cannotConnect"));
    const message = errorText(e, "cannotConnect");
    throw new FieldError(fieldOf(e), message, errorDetail(e, message));
  }

  // 1. The Thunderbird account: the step most likely to be refused, done
  //    before anything is stored or erased.
  const fullName = displayName ? personName(displayName) : null;
  let account;
  try {
    account = await api.sync443Account.ensureAccount({ mailboxId: draft.id, email: draft.email, name: draft.name, ...(fullName ? { fullName } : {}) });
  } catch (e) {
    log.warn(`Compte Thunderbird non créé (${label(draft)}) : ${errorCode(e)}.`);
    throw new FieldError(null, t("accountNotPrepared", errorCode(e)));
  }
  // Only an account made for a new mailbox is taken back.
  const undoAccount = async () => {
    if (!existing) await api.sync443Account.removeAccount(account.accountKey).catch(() => {});
  };

  // 2. The new password.
  if (newPassword) {
    try {
      await api.sync443Account.setPassword(draft.origin, login, newPassword);
    } catch (e) {
      await undoAccount();
      log.warn(`Mot de passe non enregistré (${label(draft)}) : ${errorCode(e)}.`);
      throw new FieldError("password", t("passwordNotSaved"));
    }
  }

  // 3. Another server or sign-in name: what we learned no longer holds (the
  //    old engine stops first, so it cannot write any more).
  if (moved) {
    await detach(existing.id);
    await store.mailbox(existing.id).clear();
  }

  // 4. The records.
  let saved;
  try {
    if (!existing || moved) await store.mailbox(draft.id).set("proto", proto);
    saved = await store.putMailbox({ ...draft, accountKey: account.accountKey });
  } catch (e) {
    if (!existing) {
      await store.mailbox(draft.id).clear().catch(() => {});
      if (newPassword) await api.sync443Account.removePassword(draft.origin, login).catch(() => {});
      await undoAccount();
    } else if (moved) {
      // The record still names the old server, whose password is untouched: that mailbox starts again.
      await api.sync443Account.removePassword(draft.origin, login).catch(() => {});
      await attach(existing).catch(() => {});
    }
    log.error(`Boîte non enregistrée (${label(draft)}) : ${errorCode(e)}.`);
    throw new FieldError(null, t("mailboxNotSaved"));
  }
  if (moved) {
    await api.sync443Account.removePassword(existing.origin, loginOf(existing)).catch(() => log.warn(`Ancien mot de passe non supprimé (${label(existing)}).`));
  }

  await attach(saved);
  await scheduleAlarms();
  await prunePermissions();
  log.info(`${existing ? "Boîte modifiée" : "Boîte ajoutée"} (${label(saved)}).`);
  runSync(saved.id, { reason: "user" });
  return { id: saved.id };
}

const removeMailbox = (id, options) => serial(() => removeMailboxChecked(id, options));

async function removeMailboxChecked(id, { accountGone = false } = {}) {
  const mb = await store.getMailbox(String(id));
  // Our own account removal fires accounts.onDeleted: that second call waits in
  // the queue and then finds nothing left to remove.
  if (!mb) return;
  await removeMailboxNow(mb, accountGone);
}

async function removeMailboxNow(mb, accountGone) {
  await detach(mb.id);
  if (mb.accountKey && !accountGone) {
    await api.sync443Account.removeAccount(mb.accountKey).catch((e) =>
      // FILES: the account is gone, but its folder was not where Thunderbird keeps mail, so its files were left alone.
      errorCode(e) === "FILES"
        ? log.warn(`Compte Thunderbird retiré, fichiers laissés en place hors du dossier Mail du profil (${label(mb)}).`)
        : log.warn(`Compte Thunderbird non supprimé (${label(mb)}) : ${errorCode(e)}.`),
    );
  }
  await api.sync443Account.removePassword(mb.origin, loginOf(mb)).catch(() => log.warn(`Mot de passe non supprimé du gestionnaire (${label(mb)}).`));
  await store.deleteMailbox(mb.id);
  await api.alarms.clear(ALARM + mb.id);
  await prunePermissions();
  updateBadge();
  log.info(`Boîte retirée de Thunderbird, rien n'est supprimé sur le serveur (${label(mb)}).`);
}

/** Host permissions no mailbox uses any more are given back. */
async function prunePermissions() {
  const used = new Set((await store.listMailboxes()).map((m) => `https://${serverOf(m.origin).host}/*`));
  const granted = (await api.permissions.getAll()).origins ?? [];
  const unused = granted.filter((o) => /^https:\/\/[^*/]+\/\*$/.test(o) && !used.has(o));
  if (unused.length) await api.permissions.remove({ origins: unused }).catch(() => {});
}

async function mailboxView(mb) {
  const records = store.mailbox(mb.id);
  const health = { ...initialHealth(), ...(await records.get("health", {})) };
  const entry = entries.get(mb.id);
  let pending = 0;
  try {
    pending = entry?.sync ? (await entry.sync.pendingDeletes()).count : 0;
  } catch {
    pending = 0;
  }
  return {
    id: mb.id,
    email: mb.email,
    username: mb.username,
    name: mb.name,
    origin: mb.origin,
    server: serverOf(mb.origin).display,
    syncMinutes: mb.syncMinutes,
    filterType: mb.filterType,
    sync: mb.sync,
    status: {
      running: Boolean(entry?.inFlight),
      lastSuccessAt: health.lastSuccessAt,
      nextAttemptAt: health.nextAttemptAt,
      lastError: health.lastError,
      blocked: health.blocked,
      pendingDeletes: pending,
      failedItems: health.failedItems ?? 0,
    },
  };
}

/** The page's answer; a failure in the interface's language (FieldError), or chosen by its code (EasError). */
const answer = (promise) =>
  promise.then(
    (value) => ({ ok: true, ...(value ?? {}) }),
    (e) => {
      if (e instanceof FieldError) return { ok: false, error: e.message, field: e.field ?? undefined, ...(e.detail ? { detail: e.detail } : {}) };
      const error = e instanceof EasError ? errorText(e) : t("unexpectedError");
      const detail = e instanceof EasError ? errorDetail(e, error) : "";
      return { ok: false, error, ...(detail ? { detail } : {}) };
    },
  );

api.runtime.onMessage.addListener((msg, sender) => {
  // Only this extension's own pages.
  if (sender?.id !== api.runtime.id || !String(sender?.url ?? "").startsWith(api.runtime.getURL(""))) return undefined;
  switch (msg?.type) {
    case "listMailboxes":
      return answer(ready.then(async () => ({ mailboxes: await Promise.all((await store.listMailboxes()).map(mailboxView)) })));
    case "saveMailbox":
      return answer(ready.then(() => saveMailbox(msg.mailbox, typeof msg.password === "string" ? msg.password : null)));
    case "removeMailbox":
      return answer(ready.then(() => removeMailbox(msg.id)));
    case "syncMailbox":
      return answer(
        ready.then(() => {
          if (!entries.has(String(msg.id))) throw new FieldError(null, t("errorUnknownMailbox"));
          runSync(String(msg.id), { reason: "user", confirmDeletes: msg.confirmDeletes === true });
        }),
      );
    case "discardDeletes":
      // The user keeps the local copies instead of applying the retained deletions.
      return answer(
        ready.then(async () => {
          const entry = entries.get(String(msg.id));
          if (!entry?.sync) throw new FieldError(null, t("errorUnknownMailbox"));
          await entry.sync.discardPendingDeletes();
          log.info(`Suppressions retenues abandonnées, copies locales gardées (${label(entry.mailbox)}).`);
          runSync(entry.mailbox.id, { reason: "user" });
        }),
      );
    case "getLog":
      return answer(Promise.resolve({ entries: getLog(), debugUntil: log.debugUntil }));
    case "clearLog":
      return answer(clearLog());
    case "setDebug":
      return answer(setDebugFor(msg.enabled === true ? 3_600_000 : 0).then(() => ({ debugUntil: log.debugUntil })));
    default:
      return undefined;
  }
});

// ── Button and menus ─────────────────────────────────────────────────────

const syncAll = () => Promise.all([...entries.keys()].map((id) => runSync(id, { reason: "user" })));

let badgeUpdate = Promise.resolve();
function updateBadge() {
  badgeUpdate = badgeUpdate.then(applyBadge).catch(() => {});
}

async function applyBadge() {
  const action = api.browserAction;
  if ([...entries.values()].some((e) => e.inFlight)) {
    await action.setBadgeBackgroundColor({ color: "#0060df" });
    await action.setBadgeText({ text: "…" });
    await action.setTitle({ title: t("syncRunning") });
    return;
  }
  const views = await Promise.all((await store.listMailboxes()).map(mailboxView));
  const failing = views.filter((v) => v.status.blocked || (v.status.lastError && (v.status.lastSuccessAt ?? 0) < v.status.lastError.at));
  if (failing.length) {
    await action.setBadgeBackgroundColor({ color: "#c50042" });
    await action.setBadgeText({ text: "!" });
    await action.setTitle({ title: t("actionCheckSettings", failing.map((v) => v.name).join(", ")) });
    return;
  }
  await action.setBadgeText({ text: "" });
  const last = Math.max(0, ...views.map((v) => v.status.lastSuccessAt ?? 0));
  const when = last ? new Date(last).toLocaleTimeString(uiLanguage(), { hour: "2-digit", minute: "2-digit" }) : null;
  await action.setTitle({ title: when ? t("actionSyncLast", when) : t("actionSync") });
}

api.browserAction.onClicked.addListener(() => {
  if (!entries.size) api.runtime.openOptionsPage();
  else syncAll();
});

const MENU_SETTINGS = "sync443-settings";
const MENU_SYNC_ALL = "sync443-sync-all";
const MENU_SYNC_ONE = "sync443-sync-one";
const ignore = () => void api.runtime.lastError;
api.menus.create({ id: MENU_SYNC_ALL, title: t("menuSyncAll"), contexts: ["tools_menu"] }, ignore);
api.menus.create({ id: MENU_SETTINGS, title: t("menuSettings"), contexts: ["tools_menu"] }, ignore);
api.menus.create({ id: MENU_SYNC_ONE, title: t("menuSyncOne"), contexts: ["folder_pane"], visible: false }, ignore);

const mailboxOfMenu = (info) => {
  const accountKey = info.selectedAccount?.id ?? info.selectedFolders?.[0]?.accountId ?? info.selectedFolder?.accountId ?? null;
  return [...entries.values()].find((e) => e.mailbox.accountKey === accountKey) ?? null;
};
api.menus.onShown.addListener(async (info) => {
  if (!info.contexts?.includes("folder_pane")) return;
  await api.menus.update(MENU_SYNC_ONE, { visible: Boolean(mailboxOfMenu(info)) });
  api.menus.refresh();
});
api.menus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_SETTINGS) api.runtime.openOptionsPage();
  else if (info.menuItemId === MENU_SYNC_ALL) syncAll();
  else if (info.menuItemId === MENU_SYNC_ONE) {
    const entry = mailboxOfMenu(info);
    if (entry) runSync(entry.mailbox.id, { reason: "user" });
  }
});

// ── Start-up ─────────────────────────────────────────────────────────────

// <test-hooks>
async function loadTestConfig() {
  // Packaged by the end-to-end runner only.
  try {
    const resp = await fetch(api.runtime.getURL("test-config.json"));
    if (resp.ok) testConfig = await resp.json();
  } catch {
    testConfig = null;
  }
}
// </test-hooks>

async function startup() {
  await loadLog();
  // <test-hooks>
  await loadTestConfig();
  // </test-hooks>
  await store.init();
  const swept = await store.sweepOrphans();
  if (swept) log.info(`${swept} enregistrement(s) orphelin(s) retiré(s).`);
  // Our accounts as Thunderbird knows them: a mailbox whose account vanished gets a new one at its next save.
  const accounts = new Set((await api.sync443Account.listAccounts()).map((a) => a.accountKey));
  for (const mb of await store.listMailboxes()) await attach(accounts.has(mb.accountKey) ? mb : { ...mb, accountKey: null });
  // Our identities must send through the neutral server (repaired here if the user relinked them).
  if (accounts.size) {
    await api.sync443Account
      .checkSendRoute()
      .then((repaired) => repaired && log.warn("Serveur d'envoi des comptes Sync443 rétabli."))
      .catch((e) => log.error(`Serveur d'envoi des comptes Sync443 non vérifié : ${errorCode(e)}.`));
  }
  events.start();
  await scheduleAlarms();
  updateBadge();
}

ready = startup().catch((e) => {
  log.error(`Démarrage de Sync443 : ${String(e?.message ?? e).slice(0, 200)}`);
});

ready.then(async () => {
  // <test-hooks>
  if (testConfig?.scenario) {
    // Packaged by the end-to-end runner only (never in a release build).
    const { runScenario } = await import(api.runtime.getURL("test-scenario.mjs"));
    await runScenario({ api, store, saveMailbox, removeMailbox, runSync, entries, echo, log, testConfig, attach, detach, onLocalIntent });
    return;
  }
  // </test-hooks>
  setTimeout(() => {
    for (const id of entries.keys()) runSync(id, { reason: "démarrage" });
  }, STARTUP_DELAY_MS);
});
