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
 *  - timers (alarms), the "Synchroniser" button and menus.
 *
 * Nothing here holds a password longer than the client that uses it.
 */

import { Store, checkMailbox, newIds } from "./sync/store.mjs";
import { parseServer, ServerAddressError } from "./core/server.mjs";
import { EasClient, EasError, ERR } from "./transport/client.mjs";
import { emailAddress, cleanText } from "./core/sanitize.mjs";
import { userInformationRequest, parseUserInformation } from "./core/protocol.mjs";
import { log, setDebugFor, getLog, clearLog, loadLog } from "./log.mjs";
import { installSendHandler } from "./send.mjs";
import { initialHealth } from "./sync/health.mjs";
import { MailboxSync } from "./sync/mailbox.mjs";
import { MailStore } from "./tb/mail-store.mjs";
import { LocalEvents } from "./tb/events.mjs";
import { EchoRegistry } from "./sync/echo.mjs";

const api = globalThis.browser;
const ALARM = "sync443:";
const PUSH_FALLBACK_MINUTES = 30; // safety net when "dès réception" is on
const LOCAL_DELAY_MS = 3000; // local actions are sent shortly after the last one
const STARTUP_DELAY_MS = 10_000;
const MAX_ROUNDS = 10; // passes in a row while the server has more to send
const FREQUENCIES = new Set([0, 1, 5, 15, 30, 60]);
const PERIODS = new Set(["0", "1", "2", "3", "4", "5"]);
const KINDS = ["mail", "calendar", "contacts", "tasks"];

const store = new Store(api.storage.local);
const echo = new EchoRegistry();
const entries = new Map(); // mailbox id -> { mailbox, sync, inFlight, again, timer }
const marked = new Set(); // account keys of our mailboxes
const removing = new Set(); // mailbox ids being removed (our own account removal fires accounts.onDeleted)
let testConfig = null; // only in test builds (test-config.json packaged)
let ready = null;

const notify = (message) =>
  api.notifications
    .create({ type: "basic", title: "Sync443", message: cleanText(String(message), { max: 300, singleLine: true, stripBidi: true }) })
    .catch(() => {});

// ── Sending: installed first, so no message can leave before it exists ─────

installSendHandler({
  clientFor: async (mailboxId) => {
    const mb = await store.getMailbox(mailboxId);
    if (!mb) throw new EasError(ERR.CONFIG, "Boîte inconnue.");
    return clientFor(mb);
  },
  accountOfIdentity: (identityId) => api.sync443Account.accountOfIdentity(identityId),
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
    throw new EasError(/^LOCKED:/.test(e?.message ?? "") ? ERR.NETWORK : ERR.CONFIG, "Mot de passe inaccessible pour le moment.");
  }
}

async function clientFor(mb, password = null) {
  const pw = password ?? (await passwordOf(mb));
  if (!pw) throw new EasError(ERR.CONFIG, "Mot de passe absent : modifiez la boîte pour le saisir.");
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

function attach(mb) {
  const old = entries.get(mb.id);
  if (old) {
    old.sync.cancel();
    old.sync.stopPush().catch(() => {});
    clearTimeout(old.timer);
  }
  const entry = { mailbox: mb, inFlight: null, again: false, timer: null, sync: null };
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
  return entry;
}

async function detach(id) {
  const entry = entries.get(id);
  entries.delete(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (entry.sync) {
    entry.sync.cancel();
    await entry.sync.stopPush().catch(() => {});
  }
  if (entry.mailbox.accountKey) marked.delete(entry.mailbox.accountKey);
}

async function setRunning(id, running) {
  await store.mailbox(id).set("status", { running }).catch(() => {});
}

/** Run passes for a mailbox; concurrent requests are merged into one more pass. */
function runSync(id, { reason = "auto", confirmDeletes = false } = {}) {
  const entry = entries.get(id);
  if (!entry?.sync) return Promise.resolve();
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
        const result = await entry.sync.run({ reason: why, confirmDeletes: confirm });
        if (!result?.moreAvailable) break;
        why = "suite";
        confirm = false;
      }
    } catch (e) {
      // The engine has already recorded the failure in the mailbox's health.
      log.warn(`Synchro de « ${entry.mailbox.name} » : ${e?.code ?? "erreur"}.`);
    } finally {
      await setRunning(id, false);
      entry.inFlight = null;
      updateBadge();
    }
    if (entry.again && entries.get(id) === entry) {
      const user = entry.againUser;
      const confirm = entry.againConfirm;
      entry.again = entry.againUser = entry.againConfirm = false;
      await runSync(id, { reason: user ? "user" : "suite", confirmDeletes: confirm });
      return;
    }
    if (entry.mailbox.syncMinutes === 0 && entries.get(id) === entry) entry.sync.startPush();
  })();
  return entry.inFlight;
}

// ── Local actions ────────────────────────────────────────────────────────

const events = new LocalEvents({
  echo,
  isMarked: (accountKey) => marked.has(accountKey),
  onIntent: async (accountKey, intent) => {
    const entry = [...entries.values()].find((e) => e.mailbox.accountKey === accountKey);
    if (!entry?.sync) return;
    await entry.sync.recordIntent(intent);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => runSync(entry.mailbox.id, { reason: "local" }), LOCAL_DELAY_MS);
  },
  log,
});

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

class FieldError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function checkInput(input) {
  if (!input || typeof input !== "object") throw new FieldError(null, "Demande invalide.");
  const email = emailAddress(String(input.email ?? ""));
  if (!email) throw new FieldError("email", "Adresse e-mail invalide.");
  const username = String(input.username ?? "").trim();
  if (username.length > 256 || /[\u0000-\u001f\u007f]/.test(username)) throw new FieldError("username", "Identifiant de connexion invalide.");
  const name = cleanText(String(input.name ?? ""), { max: 256, singleLine: true, stripBidi: true }).trim() || email;
  let server;
  try {
    server = serverOf(String(input.server ?? ""));
  } catch (e) {
    throw new FieldError("server", e instanceof ServerAddressError ? e.message : "Serveur invalide.");
  }
  const syncMinutes = Number(input.syncMinutes);
  if (!FREQUENCIES.has(syncMinutes)) throw new FieldError("syncMinutes", "Fréquence invalide.");
  const filterType = String(input.filterType);
  if (!PERIODS.has(filterType)) throw new FieldError("filterType", "Période invalide.");
  const sync = Object.fromEntries(KINDS.map((k) => [k, input.sync?.[k] === true]));
  if (!KINDS.some((k) => sync[k])) throw new FieldError("sync", "Choisissez au moins un élément à synchroniser.");
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

async function saveMailbox(input, password) {
  const v = checkInput(input);
  const id = input.id ? String(input.id) : null;
  const existing = id ? await store.getMailbox(id) : null;
  if (id && !existing) throw new FieldError(null, "Cette boîte n'existe plus.");
  const all = await store.listMailboxes();
  if (all.some((m) => m.id !== id && m.email.toLowerCase() === v.email.toLowerCase())) {
    throw new FieldError("email", "Cette adresse est déjà configurée.");
  }
  if (existing && existing.email.toLowerCase() !== v.email.toLowerCase()) {
    throw new FieldError("email", "L'adresse d'une boîte ne se change pas : supprimez-la et ajoutez-en une nouvelle.");
  }
  const login = v.username || v.email;
  // The password only ever goes to the origin and sign-in name it was typed for.
  const moved = existing && (existing.origin !== v.server.origin || loginOf(existing) !== login);
  if (typeof password === "string" && password.length) {
    if (password.length > 1024 || password.includes("\u0000")) throw new FieldError("password", "Mot de passe invalide.");
  } else if (!existing || moved) {
    throw new FieldError("password", existing ? "Le serveur ou l'identifiant a changé : retapez le mot de passe." : "Saisissez le mot de passe.");
  }
  const pattern = `https://${v.server.host}/*`;
  if (!(await api.permissions.contains({ origins: [pattern] }))) {
    throw new FieldError("server", "Accès au serveur non autorisé : acceptez la demande de Thunderbird.");
  }

  const ids = existing ? { mailboxId: existing.id, deviceId: existing.deviceId } : newIds();
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
    tlsPins: existing?.tlsPins ?? (testConfig?.pins ?? []),
    sync: v.sync,
  });

  // Prove the settings with an authenticated command before saving anything.
  // (For another server, the stored protocol state must not be reused.)
  let displayName = null;
  let proto = null;
  try {
    const client = await clientFor(
      moved ? { ...draft, id: newIds().mailboxId } : draft, // a fresh, empty record set for the check
      typeof password === "string" && password.length ? password : null,
    );
    const doc = await client.command("Settings", userInformationRequest(), { timeoutMs: 60_000 });
    displayName = doc ? parseUserInformation(doc).displayName : null;
    proto = { ...client.proto };
  } catch (e) {
    throw new FieldError(fieldOf(e), e instanceof EasError ? e.message : "Connexion au serveur impossible.");
  }

  if (moved) {
    await api.sync443Account.removePassword(existing.origin, loginOf(existing)).catch(() => {});
    await detach(existing.id);
    await store.mailbox(existing.id).clear(); // another server: what we learned no longer holds
  }
  if (!existing || moved) await store.mailbox(draft.id).set("proto", proto);
  if (typeof password === "string" && password.length) await api.sync443Account.setPassword(draft.origin, login, password);

  const account = await api.sync443Account.ensureAccount({
    mailboxId: draft.id,
    email: draft.email,
    name: draft.name,
    ...(displayName ? { fullName: cleanText(displayName, { max: 256, singleLine: true, stripBidi: true }) } : {}),
  });
  const saved = await store.putMailbox({ ...draft, accountKey: account.accountKey });
  attach(saved);
  await scheduleAlarms();
  await prunePermissions();
  log.info(`Boîte « ${saved.name} » ${existing ? "modifiée" : "ajoutée"}.`);
  runSync(saved.id, { reason: "user" });
  return { id: saved.id };
}

async function removeMailbox(id, { accountGone = false } = {}) {
  const mb = await store.getMailbox(String(id));
  if (!mb || removing.has(mb.id)) return;
  removing.add(mb.id);
  try {
    await removeMailboxNow(mb, accountGone);
  } finally {
    removing.delete(mb.id);
  }
}

async function removeMailboxNow(mb, accountGone) {
  await detach(mb.id);
  if (mb.accountKey && !accountGone) {
    await api.sync443Account.removeAccount(mb.accountKey).catch((e) => log.warn(`Compte Thunderbird non supprimé : ${String(e?.message ?? "").split(":")[0]}.`));
  }
  await api.sync443Account.removePassword(mb.origin, loginOf(mb)).catch(() => log.warn("Mot de passe non supprimé du gestionnaire."));
  await store.deleteMailbox(mb.id);
  await api.alarms.clear(ALARM + mb.id);
  await prunePermissions();
  updateBadge();
  log.info(`Boîte « ${mb.name} » retirée de Thunderbird (rien n'est supprimé sur le serveur).`);
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
    },
  };
}

const answer = (promise) =>
  promise.then(
    (value) => ({ ok: true, ...(value ?? {}) }),
    (e) => ({ ok: false, error: e instanceof FieldError || e instanceof EasError ? e.message : "Erreur inattendue.", field: e?.field ?? undefined }),
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
          if (!entries.has(String(msg.id))) throw new FieldError(null, "Boîte inconnue.");
          runSync(String(msg.id), { reason: "user", confirmDeletes: msg.confirmDeletes === true });
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
  if (!action) return;
  if ([...entries.values()].some((e) => e.inFlight)) {
    await action.setBadgeBackgroundColor({ color: "#0060df" });
    await action.setBadgeText({ text: "…" });
    await action.setTitle({ title: "Synchronisation en cours…" });
    return;
  }
  const views = await Promise.all((await store.listMailboxes()).map(mailboxView));
  const failing = views.filter((v) => v.status.blocked || (v.status.lastError && (v.status.lastSuccessAt ?? 0) < v.status.lastError.at));
  if (failing.length) {
    await action.setBadgeBackgroundColor({ color: "#c50042" });
    await action.setBadgeText({ text: "!" });
    await action.setTitle({ title: `Sync443 : ${failing.map((v) => v.name).join(", ")} à vérifier dans les réglages` });
    return;
  }
  await action.setBadgeText({ text: "" });
  const last = Math.max(0, ...views.map((v) => v.status.lastSuccessAt ?? 0));
  const when = last ? new Date(last).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null;
  await action.setTitle({ title: `Synchroniser${when ? ` (dernière synchro à ${when})` : ""}` });
}

api.browserAction?.onClicked.addListener(() => {
  if (!entries.size) api.runtime.openOptionsPage();
  else syncAll();
});

const MENU_SETTINGS = "sync443-settings";
const MENU_SYNC_ALL = "sync443-sync-all";
const MENU_SYNC_ONE = "sync443-sync-one";
const ignore = () => void api.runtime.lastError;
api.menus.create({ id: MENU_SYNC_ALL, title: "Synchroniser Sync443 maintenant", contexts: ["tools_menu"] }, ignore);
api.menus.create({ id: MENU_SETTINGS, title: "Réglages de Sync443…", contexts: ["tools_menu"] }, ignore);
api.menus.create({ id: MENU_SYNC_ONE, title: "Synchroniser maintenant (Sync443)", contexts: ["folder_pane"], visible: false }, ignore);

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

async function loadTestConfig() {
  // Test builds only: the end-to-end runner packages this file; release builds never contain it.
  try {
    const resp = await fetch(api.runtime.getURL("test-config.json"));
    if (resp.ok) testConfig = await resp.json();
  } catch {
    testConfig = null;
  }
}

async function startup() {
  await loadLog();
  await loadTestConfig();
  await store.init();
  const swept = await store.sweepOrphans();
  if (swept) log.info(`${swept} enregistrement(s) orphelin(s) retiré(s).`);
  // Our accounts as Thunderbird knows them: a mailbox whose account vanished gets a new one at its next save.
  const accounts = new Set((await api.sync443Account.listAccounts()).map((a) => a.accountKey));
  for (const mb of await store.listMailboxes()) attach(accounts.has(mb.accountKey) ? mb : { ...mb, accountKey: null });
  events.start();
  await scheduleAlarms();
  updateBadge();
}

ready = startup().catch((e) => {
  log.error(`Démarrage de Sync443 : ${String(e?.message ?? e).slice(0, 200)}`);
});

ready.then(async () => {
  if (testConfig?.scenario) {
    // Packaged by the end-to-end runner only (never in a release build).
    const { runScenario } = await import(api.runtime.getURL("test-scenario.mjs"));
    await runScenario({ api, store, saveMailbox, removeMailbox, runSync, entries, echo, log, testConfig });
    return;
  }
  setTimeout(() => {
    for (const id of entries.keys()) runSync(id, { reason: "démarrage" });
  }, STARTUP_DELAY_MS);
});
