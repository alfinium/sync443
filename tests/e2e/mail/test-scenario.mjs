// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * TEST ONLY: the mail end-to-end scenario, packaged by run_mail_test.py into
 * a TEST build of the extension (never into a release build). The real
 * background page (src/background.mjs) imports this module instead of
 * starting its usual syncs when the packaged test-config.json says
 * `scenario: true`, and calls
 *
 *   runScenario({ api, store, saveMailbox, removeMailbox, runSync, entries, echo, log, testConfig, meetings })
 *
 * (`entries.get(id).calendar` holds the calendar objects of a mailbox: { invitations, calendarStore,
 * scheduler, pim }; `meetings` reads and answers the confirmation question of a meeting message without
 * its window: current(), waiting(), answer(send), ask(mailboxId, question). See src/background.mjs.)
 *
 * The scenario acts as the settings page and as a user would: saveMailbox
 * and removeMailbox exactly as the page asks the background, runSync as the
 * page's "Synchroniser" (and "Confirmer les suppressions") does, and the
 * WebExtension messages / folders / compose APIs for the local actions. The
 * mock ActiveSync server (mock_eas.py) is driven by the runner, through
 * requests (sync443MailTest.rpc) between the steps.
 *
 * Three launches of Thunderbird on the same throw-away profile:
 *   1. mailboxes (refusals, then A and B), first sync, local actions,
 *      server changes (push), sending, mass deletion;
 *   2. after a restart: mappings kept, a local deletion and a local move
 *      made right away hit the right server items, push resumes;
 *   3. removal of B, A still synchronised, mail period changed (1 month,
 *      all, 1 month, all on a server that starts over), mail unchecked for A.
 *
 * The calendar, the tasks and the meetings have their own scenario, in
 * calendar-scenario.mjs (run by run_calendar_sync_test.py): when the
 * packaged configuration says `e2e.suite: "calendar"`, runScenario hands the
 * phase over to it, with this module's helpers.
 *
 * Output lines, in <profile>/sync443mail-e2e.txt:
 *   SYNC443MAIL-CHECK {label, ok, detail}    one check
 *   SYNC443MAIL-GAP   {label, detail}        behaviour not implemented in this version
 *   SYNC443MAIL-INFO  {key: value}           facts for the runner
 *   SYNC443MAIL-STEP  {name, at}
 *   SYNC443MAIL-LOG   {level, msg}           the extension's own log (end of phase)
 *   SYNC443MAIL-ERRORS [...]                 console errors of the session
 *   SYNC443MAIL-CRASH {error, stack}
 *   SYNC443MAIL-DONE  {phase, failures}
 */

const T = browser.sync443MailTest;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx = null;
let E = null; // testConfig.e2e: what the runner prepared
let failures = 0;
let steps = null; // phase 1 steps to run (null: all), from the phase file (run_mail_test.py --steps)
const want = (n) => !steps || steps.includes(n);

// Subjects of the messages the runner put on the server (fixture).
const S = Object.freeze({
  unread: "E2E non lu",
  readFlagged: "E2E lu suivi",
  fakeStatus: "E2E faux statut",
  noId: "E2E sans message-id",
  dup: "E2E doublon",
  toMove: "E2E a deplacer",
  toDelete: "E2E a supprimer",
  serverFlag: "E2E serveur drapeau",
  serverDelete: "E2E serveur supprime",
  serverMove: "E2E serveur deplace",
  restartDelete: "E2E redemarrage supprimer",
  restartMove: "E2E redemarrage deplacer",
  witness: "E2E temoin",
  toArchive: "E2E a archiver",
  toLocalOnly: "E2E vers dossier local",
  client: "E2E client",
  project: "E2E projet",
  in2026: "E2E dans 2026",
  alreadySent: "E2E deja envoye",
  alreadyDeleted: "E2E deja supprime",
  archive: "E2E archive serveur",
  invoice: "E2E facture",
  bob1: "E2E pour Bob 1",
  bob2: "E2E pour Bob 2",
  // Made during the scenario.
  push: "E2E arrivee par push",
  inServerFolder: "E2E dans dossier serveur",
  send: "E2E envoi par ActiveSync",
  pushAfterRestart: "E2E push apres redemarrage",
  afterRemoval: "E2E apres suppression de B",
  mailOff: "E2E courrier decoche",
  periodRecent: "E2E periode recent",
  period60: "E2E periode 60 jours",
  period400: "E2E periode 400 jours",
});

// ── Output ────────────────────────────────────────────────────────────────

async function emit(kind, value) {
  await T.print(`SYNC443MAIL-${kind} ${JSON.stringify(value ?? null)}`);
}

async function check(label, ok, detail) {
  if (!ok) failures++;
  await emit("CHECK", { label, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  return Boolean(ok);
}

const info = (key, value) => emit("INFO", { [key]: value });
const gap = (label, detail) => emit("GAP", { label, detail: detail ?? null });
const step = (name) => emit("STEP", { name, at: Date.now() });

// ── Runner (mock server) ──────────────────────────────────────────────────

async function rpc(op, fields = {}) {
  const r = await T.rpc({ op, ...fields }, 180_000);
  if (!r || r.ok !== true) throw new Error(`RPC ${op} : ${r?.error ?? "sans réponse"}`);
  return r.result;
}

/** A public method of the mock server (MockEasServer), on the "main" server unless said otherwise. */
const mock = (method, args = [], kwargs = {}, server = "main") => rpc("call", { server, method, args, kwargs });
/** Messages of a server folder: [{server_id, subject, message_id, read, flagged}] */
const serverMessages = (login, folder) => rpc("summary", { login, folder });
/** Where messages of this subject are on the server: [{folder, folder_id, server_id, read, flagged, message_id}] */
const serverFind = (login, subject) => rpc("find", { login, subject });
/** Folders of a user: [{server_id, parent_id, name, type, path, count}] */
const serverFolders = (login) => rpc("folders", { login });

async function waitFor(fn, { timeout = 60_000, interval = 500 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let value = null;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(interval);
  }
}

async function errorOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return { message: String(e?.message ?? e), field: e?.field ?? null };
  }
}

// ── Thunderbird ──────────────────────────────────────────────────────

async function folderAt(accountKey, path) {
  const list = await browser.folders.query({ accountId: accountKey, path });
  return (list ?? []).find((f) => f.accountId === accountKey && f.path === path) ?? null;
}

async function localFolders(accountKey) {
  const list = await browser.folders.query({ accountId: accountKey });
  return (list ?? []).filter((f) => f.accountId === accountKey && !f.isRoot).map((f) => ({ path: f.path, uses: f.specialUse ?? [] }));
}

/** Messages of a local folder (null if the folder does not exist). */
async function localMessages(accountKey, path) {
  const f = await folderAt(accountKey, path);
  if (!f) return null;
  const out = [];
  let page = await browser.messages.list(f.id);
  for (;;) {
    for (const m of page?.messages ?? []) {
      out.push({ id: m.id, subject: m.subject, mid: m.headerMessageId, read: m.read, flagged: m.flagged, tags: m.tags ?? [], path: m.folder?.path });
    }
    if (!page?.id) break;
    page = await browser.messages.continueList(page.id);
  }
  return out;
}

const withSubject = (list, subject) => (list ?? []).filter((m) => m.subject === subject);

async function rawText(id) {
  const raw = await browser.messages.getRaw(id, { data_format: "File" });
  return typeof raw === "string" ? raw : await raw.text();
}

async function deletePermanently(ids) {
  try {
    await browser.messages.delete(ids, { deletePermanently: true });
  } catch {
    await browser.messages.delete(ids, true);
  }
}

// ── Boîtes ─────────────────────────────────────────────────────────────

const mailboxById = (id) => ctx.store.getMailbox(id);

async function health(id) {
  return (await ctx.store.mailbox(id).get("health", null)) ?? {};
}

/** No pass in progress for this mailbox, and a successful one since `since`. */
function idle(id, since = 0, timeout = 180_000) {
  return waitFor(
    async () => {
      const e = ctx.entries.get(id);
      if (!e?.sync || e.inFlight || e.sync.running) return null;
      const h = await health(id);
      return (h.lastSuccessAt ?? 0) >= since ? h : null;
    },
    { timeout, interval: 300 },
  );
}

/** The journal of local changes is empty and no pass is running. */
function journalDone(id, timeout = 90_000) {
  return waitFor(
    async () => {
      const e = ctx.entries.get(id);
      if (!e?.sync || e.inFlight || e.sync.running) return null;
      return (await e.sync.journal.size()) === 0;
    },
    { timeout, interval: 300 },
  );
}

const input = (mb, overrides = {}) => ({
  id: mb?.id ?? null,
  email: mb?.email,
  username: mb?.username ?? "",
  name: mb?.name,
  server: mb?.server,
  syncMinutes: mb?.syncMinutes,
  filterType: mb?.filterType ?? "0",
  sync: mb?.sync,
  ...overrides,
});

async function sync443Logins(origin) {
  return (await T.rawLogins(origin)).filter((l) => l.httpRealm === "Sync443");
}

async function storageKeys() {
  return Object.keys(await browser.storage.local.get(null)).filter((k) => k === "mailboxes" || k.startsWith("mb/")).sort();
}

async function mailboxes() {
  const list = await ctx.store.listMailboxes();
  const A = list.find((m) => m.email === E.alice.login) ?? null;
  const B = list.find((m) => m.email === E.bob.login) ?? null;
  return { A, B, list };
}

/** Thunderbird's "Local Folders" must be its own account, never one of ours (it would stop being ours). */
async function checkLocalFolders(when) {
  const lf = await T.localFolders();
  await check(`« Dossiers locaux » de Thunderbird : un compte à part, jamais un compte de Sync443 (${when})`, lf.type === "none" && lf.hostname === "Local Folders" && !lf.owner, lf);
}

/**
 * One part of a phase: an exception (from the extension's own functions, or a
 * step that cannot go on) is a failed check, and the next part still runs.
 */
async function guard(name, fn) {
  try {
    await fn();
  } catch (e) {
    await check(`${name} : la partie se déroule sans exception`, false, { error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 1500) });
  }
}

// ── End of a phase ────────────────────────────────────────────────────────

async function finish(phase) {
  try {
    for (const e of ctx.log.getLog()) await emit("LOG", { level: e.level, msg: e.msg, t: e.t });
  } catch {
    // the log is a help, not a check
  }
  try {
    await emit("ERRORS", await T.consoleErrors());
  } catch (e) {
    await emit("ERRORS", [{ message: `consoleErrors: ${e}`, ours: false }]);
  }
  await emit("DONE", { phase, failures });
  await T.quit();
}

// ── Language of the interface ─────────────────────────────────────────────

/**
 * The extension's texts are in Thunderbird's language (--locale of the
 * runner, or the language of the build): the catalogue Thunderbird chose,
 * the manifest, the toolbar button, and the settings page as it really
 * shows, opened in a tab and read through extension.getViews().
 * E.catalogues: { language: { key: message } }, from src/_locales.
 */
async function checkLanguage(boxes) {
  await step("2b. Langue de l'interface");
  const ui = browser.i18n.getUILanguage();
  // The catalogue Thunderbird picks: the same tag, else the same language (es-AR → es_ES), else English.
  const wanted = String(E.uiLocale ?? ui).toLowerCase();
  const folders = Object.keys(E.catalogues ?? {});
  const tag = (folder) => folder.replace("_", "-").toLowerCase();
  const lang =
    folders.find((f) => tag(f) === wanted) ?? folders.find((f) => tag(f).split("-")[0] === wanted.split("-")[0]) ?? "en";
  const texts = E.catalogues?.[lang];
  await info("uiLanguage", { ui, requested: E.uiLocale ?? null, catalogue: lang });
  if (!(await check(`catalogue « ${lang} » transmis par le lanceur`, texts, Object.keys(E.catalogues ?? {})))) return;
  if (E.uiLocale) await check(`Thunderbird en ${E.uiLocale} (intl.locale.requested)`, ui.toLowerCase().startsWith(E.uiLocale.slice(0, 2).toLowerCase()), ui);
  const picked = { addMailbox: browser.i18n.getMessage("addMailbox"), languageTag: browser.i18n.getMessage("languageTag") };
  await check(`textes de l'extension pris dans le catalogue « ${lang} »`, picked.addMailbox === texts.addMailbox && picked.languageTag === texts.languageTag, picked);
  const manifest = browser.runtime.getManifest();
  await check("manifeste : nom et description traduits", manifest.name === texts.extensionName && manifest.description === texts.extensionDescription, {
    name: manifest.name,
    description: manifest.description,
  });
  const prefix = (key) => texts[key].split("$")[0];
  const title = await browser.browserAction.getTitle({});
  await check(
    "bouton de la barre d'outils : titre dans cette langue",
    [texts.actionSync, texts.syncRunning].includes(title) || title.startsWith(prefix("actionSyncLast")) || title.startsWith(prefix("actionCheckSettings")),
    title,
  );

  // The settings page, as it shows.
  const pageUrl = browser.runtime.getURL("options/options.html");
  await browser.runtime.openOptionsPage();
  const view = await waitFor(
    () => {
      const v = browser.extension.getViews({ type: "tab" }).find((w) => w.location.href.startsWith(pageUrl));
      return v && v.document.querySelectorAll("#mailboxes li .mb-status").length >= boxes && v.document.querySelector("#mailboxes li .mb-status").textContent ? v : null;
    },
    { timeout: 30_000 },
  );
  if (!(await check("page de réglages ouverte, boîtes listées", view, browser.extension.getViews().map((w) => w.location.href)))) return;
  const doc = view.document;
  const shown = {
    lang: doc.documentElement.lang,
    title: doc.title,
    add: doc.getElementById("add")?.textContent,
    heading: doc.getElementById("mailboxes-title")?.textContent,
    buttons: [...doc.querySelectorAll("#mailboxes li:first-child .mb-actions button")].map((b) => b.textContent),
    status: doc.querySelector("#mailboxes li .mb-status")?.textContent ?? "",
    frequency: doc.querySelector("#syncMinutes option")?.textContent,
    empty: [...doc.querySelectorAll("[data-i18n]")].filter((n) => !n.textContent.trim()).map((n) => n.dataset.i18n),
  };
  await info("optionsPage", shown);
  await check(
    `page de réglages en « ${lang} » : langue, titre, boutons, choix`,
    shown.lang === texts.languageTag &&
      shown.title === texts.optionsTitle &&
      shown.add === texts.addMailbox &&
      shown.heading === texts.mailboxesTitle &&
      shown.frequency === texts.freqPush &&
      JSON.stringify(shown.buttons) === JSON.stringify([texts.syncButton, texts.editButton, texts.removeButton]),
    shown,
  );
  await check("page de réglages : aucun texte resté vide", !shown.empty.length, shown.empty);
  const statuses = ["statusSyncedAt", "statusSyncedOn", "syncRunning", "statusError", "statusNever"].map(prefix);
  await check("page de réglages : état de la boîte dans cette langue", statuses.some((p) => shown.status.startsWith(p)), shown.status);
  const tab = await view.browser.tabs.getCurrent();
  if (tab) await browser.tabs.remove(tab.id);
}

// ── Phase 1 ───────────────────────────────────────────────────────────────

async function phase1() {
  const store = ctx.store;
  const origin = `https://127.0.0.1:${E.port}`;
  const bobOrigin = `https://localhost:${E.port}`;

  await step("1. Boîtes : refus, puis A et B");
  const fp = await T.trustAuthority(E.caBase64);
  await check("autorité du faux serveur ajoutée au profil jetable", String(fp).replace(/:/g, "") === E.caSha256, fp);
  await T.trustAuthority(E.unpinnedCaBase64); // trusted by Thunderbird, but not pinned by the mailboxes
  if (E.localFolders) await T.createLocalFolders(); // --local-folders; by default the profile has none, as when Sync443 is the only account
  await info("localFoldersAtStart", await T.localFolders());

  const before = await storageKeys();
  const accountsBefore = await browser.sync443Account.listAccounts();
  const A_IN = input(null, {
    email: E.alice.login,
    name: "Alice (A)",
    server: `127.0.0.1:${E.port}`,
    syncMinutes: 0,
    sync: { mail: true, calendar: true, contacts: true, tasks: true },
  });

  // Wrong password: refused on the password field, nothing created.
  const seqWrong = await mock("last_seq");
  const wrong = await errorOf(() => ctx.saveMailbox(A_IN, "mauvais-mot-de-passe"));
  await check("mauvais mot de passe : refusé, sur le champ « password »", wrong?.field === "password", wrong);
  const reqWrong = await rpc("requests", { since: seqWrong });
  await check("… le serveur a répondu 401 (le mot de passe a bien été essayé)", reqWrong.some((r) => r.http_status === 401), reqWrong.map((r) => `${r.cmd}:${r.http_status}`));

  // Servers whose certificate is not pinned (trusted by Thunderbird) or not trusted at all.
  for (const [name, port, why] of [
    ["unpinned", E.unpinnedPort, "autorité reconnue par Thunderbird mais non épinglée"],
    ["untrusted", E.untrustedPort, "autorité inconnue"],
  ]) {
    const err = await errorOf(() => ctx.saveMailbox({ ...A_IN, server: `127.0.0.1:${port}` }, E.alice.password));
    await check(`serveur au certificat refusé (${why}) : refusé, sur le champ « server »`, err?.field === "server", err);
    const reqs = await rpc("requests", { server: name });
    await check(
      `… ${name} : connexion tentée, ZÉRO octet applicatif reçu (aucune requête HTTP, aucun mot de passe)`,
      reqs.length >= 1 && reqs.every((r) => r.method === null && r.user === null),
      reqs.map((r) => r.error),
    );
  }
  const after = await storageKeys();
  await check("après ces refus : aucune boîte enregistrée", JSON.stringify(after) === JSON.stringify(before) && !(await store.listMailboxes()).length, after);
  const accountsAfter = await browser.sync443Account.listAccounts();
  await check("après ces refus : aucun compte Thunderbird créé", accountsAfter.length === accountsBefore.length, accountsAfter);
  await check("après ces refus : aucun mot de passe enregistré", !(await sync443Logins(origin)).length);

  // A: immediate delivery (push), the four kinds checked.
  const t0 = Date.now();
  const resA = await ctx.saveMailbox(A_IN, E.alice.password);
  const A = await mailboxById(resA.id);
  await check(
    "boîte A ajoutée (dès réception, courrier + agenda + contacts + tâches)",
    A && A.syncMinutes === 0 && A.sync.mail && A.sync.calendar && A.sync.contacts && A.sync.tasks && /^account\d+$/.test(A.accountKey ?? ""),
    A && { origin: A.origin, accountKey: A.accountKey, sync: A.sync },
  );
  await check("boîte A : l'autorité de test est épinglée", JSON.stringify(A?.tlsPins) === JSON.stringify([E.caSha256]), A?.tlsPins);
  const loginsA = await sync443Logins(origin);
  await check("boîte A : mot de passe dans le gestionnaire (domaine Sync443)", loginsA.length === 1 && loginsA[0].username === E.alice.login, loginsA);

  // B: every 5 minutes, mail only; another host name for the same server (permission granted as the page's request would).
  await T.grantOrigin("https://localhost/*");
  const B_IN = input(null, {
    email: E.bob.login,
    name: "Bob (B)",
    server: `localhost:${E.port}`,
    syncMinutes: 5,
    sync: { mail: true, calendar: false, contacts: false, tasks: false },
  });
  const resB = await ctx.saveMailbox(B_IN, E.bob.password);
  const B = await mailboxById(resB.id);
  await check("boîte B ajoutée (toutes les 5 min, courrier seulement)", B && B.syncMinutes === 5 && B.sync.mail && !B.sync.calendar && B.origin === bobOrigin, B && { origin: B.origin, sync: B.sync });
  await checkLocalFolders("après l'ajout des boîtes");
  await info("mailboxes", { A: { id: A.id, deviceId: A.deviceId, accountKey: A.accountKey, origin: A.origin }, B: { id: B.id, deviceId: B.deviceId, accountKey: B.accountKey, origin: B.origin } });
  const alarms = await browser.alarms.getAll();
  await check(
    "minuteries : A en filet de sécurité (30 min, dès réception), B toutes les 5 min",
    alarms.some((a) => a.name === `sync443:${A.id}` && a.periodInMinutes === 30) && alarms.some((a) => a.name === `sync443:${B.id}` && a.periodInMinutes === 5),
    alarms.map((a) => `${a.name}/${a.periodInMinutes}`),
  );

  // ── 2. First sync
  await step("2. Première synchronisation");
  const hA = await idle(A.id, t0);
  const hB = await idle(B.id, t0);
  await check("première synchro de A terminée sans erreur", hA && !hA.blocked, hA ?? (await health(A.id)));
  await check("première synchro de B terminée sans erreur", hB && !hB.blocked, hB ?? (await health(B.id)));
  await info("firstSyncMs", Date.now() - t0);

  const folders = await localFolders(A.accountKey);
  const paths = folders.map((f) => f.path).sort();
  await info("foldersA", folders);
  const expected = ["/Inbox", "/Inbox/Clients", "/Drafts", "/Sent", "/Trash", "/Junk Email", "/Projets", "/Projets/2026", "/Factures_ 2026", "/Masse"];
  await check("dossiers du serveur créés aux bons chemins (imbriqués, noms rendus valables)", expected.every((p) => paths.includes(p)), { missing: expected.filter((p) => !paths.includes(p)), paths });
  // The server's top-level "Archives" and the account's own "/Archives" (Thunderbird's archives folder):
  // either side by side ("/Archives (2)") or the server folder bound to "/Archives" itself.
  let serverArchivesAt = null;
  if (E.serverArchives) {
    for (const p of ["/Archives (2)", "/Archives"]) {
      if (paths.includes(p) && withSubject(await localMessages(A.accountKey, p), S.archive).length) serverArchivesAt ??= p;
    }
    await info("serverArchivesAtFirstSync", serverArchivesAt);
    await check("le dossier « Archives » du serveur a sa place locale (/Archives (2) à côté du dossier d'archives, ou /Archives lui-même)", serverArchivesAt !== null, paths);
  }
  const use = (p) => folders.find((f) => f.path === p)?.uses ?? [];
  await check(
    "dossiers spéciaux sur /Inbox /Drafts /Sent /Trash (par leur rôle)",
    use("/Inbox").includes("inbox") && use("/Drafts").includes("drafts") && use("/Sent").includes("sent") && use("/Trash").includes("trash"),
    { inbox: use("/Inbox"), drafts: use("/Drafts"), sent: use("/Sent"), trash: use("/Trash") },
  );
  const forbidden = ["Calendar", "Contacts", "Tasks", "Notes", "Journal", "Outbox", "Agenda perso", "Contacts perso", "Taches perso", "Deleted Items", "Sent Items"];
  const leaked = paths.filter((p) => forbidden.includes(p.slice(p.lastIndexOf("/") + 1)));
  await check("aucun dossier d'agenda, de contacts, de tâches (ni la boîte d'envoi) créé, bien que cochés pour A", !leaked.length, leaked);
  const asked = await rpc("collections_requested", { login: E.alice.login, device_id: A.deviceId });
  // Calendar and tasks, checked for A, are synchronised since stage 4, contacts since stage 5 (their own tests
  // check them): only the folders of the other classes (notes, journal, the recipient cache) must never be named.
  const pim = E.pimFolders.alice;
  const SYNCHRONISED = [7, 8, 13, 15, 9, 14];
  const never = (await serverFolders(E.alice.login)).filter((f) => pim.includes(f.server_id) && !SYNCHRONISED.includes(f.type)).map((f) => f.server_id);
  await check("A ne demande jamais au serveur un dossier de notes ou de journal (Sync, Ping…)", never.length > 0 && !asked.some((id) => never.includes(id)), { asked, never });

  const inbox = await localMessages(A.accountKey, "/Inbox");
  const one = (subject) => withSubject(inbox, subject)[0] ?? null;
  const u = one(S.unread);
  const rf = one(S.readFlagged);
  await check("message non lu importé non lu, sans drapeau", u && !u.read && !u.flagged, u);
  await check("message lu et suivi importé lu, avec drapeau", rf && rf.read && rf.flagged, rf);
  const fake = one(S.fakeStatus);
  const fakeRaw = fake ? await rawText(fake.id) : "";
  await check("X-Mozilla-Status / X-Mozilla-Keys du serveur ignorés : non lu, sans étiquette", fake && !fake.read && !fake.tags.length, fake);
  // Thunderbird writes its own X-Mozilla-* lines in a local folder: the server's ones must be gone, and
  // what remains must be exactly what Thunderbird wrote for an ordinary unread message imported the same way.
  const statusOf = (text) => (text.match(/^X-Mozilla-Status2?:.*$/gim) ?? []).map((l) => l.trim());
  const controlRaw = u ? await rawText(u.id) : "";
  await check(
    "… et retirés du message importé (plus de $label1 ni d'X-Account-Key ; état écrit par Thunderbird comme pour un message ordinaire)",
    fake && !/\$label1/.test(fakeRaw) && !/^X-Account-Key/im.test(fakeRaw) && statusOf(fakeRaw).length === 2
      && JSON.stringify(statusOf(fakeRaw)) === JSON.stringify(statusOf(controlRaw)),
    { imported: fakeRaw.slice(0, 260), ordinary: statusOf(controlRaw) },
  );
  await info("mboxStatusOfUnreadImport", statusOf(controlRaw));
  // The state Thunderbird keeps in the folder file itself (what a rebuilt summary, "Repair Folder", would read back).
  const mboxRead = (text) => {
    const m = /^X-Mozilla-Status:\s*([0-9a-f]{4})/im.exec(text);
    return m ? (parseInt(m[1], 16) & 1) === 1 : null;
  };
  await check(
    "message importé non lu : le fichier du dossier (X-Mozilla-Status) dit aussi non lu (sinon une reconstruction du résumé le marquerait lu)",
    u && mboxRead(controlRaw) === false,
    { headers: statusOf(controlRaw), read: u?.read },
  );
  const noId = one(S.noId);
  await check("message sans Message-ID : Message-ID synthétique <sha256@sync443.invalid>", noId?.mid === E.syntheticId, { got: noId?.mid, expected: E.syntheticId });
  const dups = withSubject(inbox, S.dup);
  const dupRaw = await Promise.all(dups.map((m) => rawText(m.id)));
  await check(
    "même Message-ID livré deux fois : deux copies locales (la seconde sous son propre Message-ID)",
    dups.length === 2 && dups.some((m) => m.mid === E.dupId) && dupRaw.some((t) => /^X-Sync443-Original-Message-ID:\s*<?[^>\r\n]*doublon/im.test(t)),
    dups.map((m) => m.mid),
  );
  const serverInbox = await serverMessages(E.alice.login, "Inbox");
  await check("autant de messages dans /Inbox que dans la boîte de réception du serveur", inbox.length === serverInbox.length, { local: inbox.length, server: serverInbox.length });
  const nested = await localMessages(A.accountKey, "/Projets/2026");
  await check("messages des dossiers imbriqués importés (/Projets/2026)", withSubject(nested, S.in2026).length === 1, nested?.map((m) => m.subject));
  const sub = await localMessages(A.accountKey, "/Inbox/Clients");
  await check("sous-dossier de la boîte de réception (/Inbox/Clients)", withSubject(sub, S.client).length === 1, sub?.map((m) => m.subject));
  const sent = await localMessages(A.accountKey, "/Sent");
  const trash = await localMessages(A.accountKey, "/Trash");
  const arch = serverArchivesAt ? await localMessages(A.accountKey, serverArchivesAt) : [{ subject: S.archive }];
  const inv = await localMessages(A.accountKey, "/Factures_ 2026");
  await check(
    "Éléments envoyés → /Sent, Éléments supprimés → /Trash, « Factures: 2026 » → /Factures_ 2026 (et le message de « Archives » importé)",
    withSubject(sent, S.alreadySent).length === 1 && withSubject(trash, S.alreadyDeleted).length === 1 && withSubject(arch, S.archive).length === 1 && withSubject(inv, S.invoice).length === 1,
    { sent: sent?.length, trash: trash?.length, archives: arch?.length, invoices: inv?.length },
  );
  const masse = await localMessages(A.accountKey, "/Masse");
  await check("dossier de 60 messages importé en entier (lots de 50, MoreAvailable)", masse?.length === 60, masse?.length);
  const ups = await rpc("actions", { login: E.alice.login, device_id: A.deviceId, kinds: ["sync_change", "sync_delete", "sync_add", "move", "folder_create", "folder_update", "folder_delete"] });
  await check("la première synchro ne renvoie rien au serveur (aucun changement, déplacement ni dossier)", !ups.length, ups);
  const bobInbox = await localMessages(B.accountKey, "/Inbox");
  await check("B : boîte de réception importée", withSubject(bobInbox, S.bob1).length === 1 && withSubject(bobInbox, S.bob2).length === 1, bobInbox?.map((m) => m.subject));
  const askedB = await rpc("collections_requested", { login: E.bob.login, device_id: B.deviceId });
  await check("B (courrier seulement) ne demande aucun dossier d'agenda, de contacts ou de tâches", !askedB.some((id) => E.pimFolders.bob.includes(id)), askedB);

  // ── 2b. Language of the interface (run_mail_test.py --locale)
  await guard("étape 2b", () => checkLanguage(2));

  const login = E.alice.login;

  // ── 3. Local actions
  if (want(3)) await guard("étape 3", async () => {
    await step("3. Actions locales");
    await browser.messages.update(u.id, { read: true });
    await browser.messages.update(u.id, { flagged: true });
    await browser.messages.update(rf.id, { read: false });
    await browser.messages.update(rf.id, { flagged: false });
    const flags = await waitFor(async () => {
      const [a] = await serverFind(login, S.unread);
      const [b] = await serverFind(login, S.readFlagged);
      return a?.read === true && a.flagged && b?.read === false && !b.flagged ? { a, b } : null;
    });
    await check("lu / non lu, drapeau / sans drapeau : appliqués sur le serveur", flags, flags ?? [await serverFind(login, S.unread), await serverFind(login, S.readFlagged)]);

    const projets = await folderAt(A.accountKey, "/Projets");
    await browser.messages.move([one(S.toMove).id], projets.id);
    const moved = await waitFor(async () => {
      const r = await serverFind(login, S.toMove);
      return r.length === 1 && r[0].folder === "Projets" ? r : null;
    });
    await check("déplacement local vers /Projets : déplacé sur le serveur (MoveItems)", moved, moved ?? (await serverFind(login, S.toMove)));

    await browser.messages.delete([one(S.toDelete).id]);
    const localDel = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Trash"), S.toDelete).length === 1);
    const del = await waitFor(async () => {
      const r = await serverFind(login, S.toDelete);
      return r.length === 1 && r[0].folder === "Deleted Items" ? r : null;
    });
    await check("suppression locale : dans /Trash localement, dans les Éléments supprimés du serveur", localDel && del, del ?? (await serverFind(login, S.toDelete)));

    const inTrash = withSubject(await localMessages(A.accountKey, "/Trash"), S.alreadyDeleted)[0];
    await deletePermanently([inTrash.id]);
    const purged = await waitFor(async () => !(await serverFind(login, S.alreadyDeleted)).length);
    await check("suppression définitive dans /Trash : supprimé du serveur", purged, await serverFind(login, S.alreadyDeleted));
    await check("… sans toucher au message supprimé juste avant (toujours dans les Éléments supprimés)", (await serverFind(login, S.toDelete))[0]?.folder === "Deleted Items");

    const root = (await browser.accounts.get(A.accountKey)).rootFolder;
    const created = await browser.folders.create(root.id, "E2E local");
    const fCreated = await waitFor(async () => (await serverFolders(login)).find((f) => f.name === "E2E local" && f.parent_id === "0" && f.type === 12));
    await check("dossier créé localement : créé sur le serveur (FolderCreate, à la racine)", fCreated, (await serverFolders(login)).map((f) => f.path));
    const renamed = await browser.folders.rename(created.id, "E2E local renomme");
    const fRenamed = await waitFor(async () => (await serverFolders(login)).find((f) => f.server_id === fCreated?.server_id && f.name === "E2E local renomme"));
    await check("dossier renommé localement : renommé sur le serveur", fRenamed, (await serverFolders(login)).map((f) => f.path));
    const movedF = await browser.folders.move(renamed.id, projets.id);
    const projetsSid = E.folders.alice.Projets;
    const fMoved = await waitFor(async () => (await serverFolders(login)).find((f) => f.server_id === fCreated?.server_id && f.parent_id === projetsSid));
    await check("dossier déplacé localement dans /Projets : déplacé sur le serveur", fMoved && movedF?.path === "/Projets/E2E local renomme", { local: movedF?.path, server: (await serverFolders(login)).map((f) => f.path) });
    await browser.folders.delete(movedF.id);
    const trashedLocal = await waitFor(() => folderAt(A.accountKey, "/Trash/E2E local renomme"));
    const deletedItems = E.folders.alice["Deleted Items"];
    const fTrashed = await waitFor(async () => (await serverFolders(login)).find((f) => f.server_id === fCreated?.server_id && f.parent_id === deletedItems));
    await check("dossier supprimé localement : dans /Trash, et dans les Éléments supprimés du serveur (pas détruit)", trashedLocal && fTrashed, (await serverFolders(login)).map((f) => f.path));
    if (trashedLocal) await browser.folders.delete(trashedLocal.id);
    const fGone = await waitFor(async () => !(await serverFolders(login)).some((f) => f.server_id === fCreated?.server_id));
    const goneLocal = !(await folderAt(A.accountKey, "/Trash/E2E local renomme"));
    await check("dossier supprimé depuis /Trash : supprimé du serveur (FolderDelete)", fGone && goneLocal, (await serverFolders(login)).map((f) => f.path));
    await check("journal des actions locales vidé (chaque entrée acquittée)", await journalDone(A.id), await ctx.entries.get(A.id)?.sync.journal.list());

  });

  // ── 4. Server changes (push)
  if (want(4)) await guard("étape 4", async () => {
    await step("4. Changements sur le serveur (Ping)");
    const pushStart = Date.now();
    const seqPush = await mock("last_seq");
    await mock("add_message", [login, "Inbox"], { subject: S.push });
    const arrived = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Inbox"), S.push)[0], { timeout: 150_000, interval: 300 });
    const latency = Date.now() - pushStart;
    const pings = (await rpc("requests", { since: seqPush, login, device_id: A.deviceId })).filter((r) => r.cmd === "Ping");
    await check("nouveau message : arrivé sans attendre le minuteur (Ping)", arrived && latency < 60_000, { latencyMs: latency, pings: pings.map((p) => p.ping) });

    const [sf] = await serverFind(login, S.serverFlag);
    await mock("set_flag", [login, "Inbox", sf.server_id, true]);
    await mock("set_read", [login, "Inbox", sf.server_id, true]);
    const flagged = await waitFor(async () => {
      const m = withSubject(await localMessages(A.accountKey, "/Inbox"), S.serverFlag)[0];
      return m?.flagged && m.read ? m : null;
    }, { timeout: 90_000 });
    await check("drapeau et lu posés sur le serveur : appliqués localement", flagged, withSubject(await localMessages(A.accountKey, "/Inbox"), S.serverFlag));

    const [sd] = await serverFind(login, S.serverDelete);
    await mock("delete_message", [login, "Inbox", sd.server_id]);
    const trashed = await waitFor(async () => {
      const inT = withSubject(await localMessages(A.accountKey, "/Trash"), S.serverDelete);
      const inI = withSubject(await localMessages(A.accountKey, "/Inbox"), S.serverDelete);
      return inT.length === 1 && !inI.length;
    }, { timeout: 90_000 });
    await check("message supprimé sur le serveur : copie locale mise dans /Trash", trashed);

    const [sm] = await serverFind(login, S.serverMove);
    await mock("move_message", [login, "Inbox", sm.server_id, "Projets"]);
    const movedLocal = await waitFor(async () => {
      const inP = withSubject(await localMessages(A.accountKey, "/Projets"), S.serverMove);
      const inI = withSubject(await localMessages(A.accountKey, "/Inbox"), S.serverMove);
      const inT = withSubject(await localMessages(A.accountKey, "/Trash"), S.serverMove);
      return inP.length === 1 && !inI.length && !inT.length;
    }, { timeout: 90_000 });
    await check("message déplacé sur le serveur : déplacé localement vers /Projets (pas de copie en trop)", movedLocal, {
      projets: withSubject(await localMessages(A.accountKey, "/Projets"), S.serverMove).length,
      inbox: withSubject(await localMessages(A.accountKey, "/Inbox"), S.serverMove).length,
      trash: withSubject(await localMessages(A.accountKey, "/Trash"), S.serverMove).length,
    });

    await mock("add_folder", [login, "E2E serveur"]);
    const fAdd = await waitFor(() => folderAt(A.accountKey, "/E2E serveur"), { timeout: 90_000 });
    await check("dossier ajouté sur le serveur : créé localement", fAdd);
    await mock("rename_folder", [login, "E2E serveur"], { name: "E2E serveur renomme" });
    const fRen = await waitFor(async () => (await folderAt(A.accountKey, "/E2E serveur renomme")) && !(await folderAt(A.accountKey, "/E2E serveur")), { timeout: 90_000 });
    await check("dossier renommé sur le serveur : renommé localement", fRen, (await localFolders(A.accountKey)).map((f) => f.path));
    await mock("rename_folder", [login, "E2E serveur renomme"], { parent: "Projets" });
    const fMov = await waitFor(async () => (await folderAt(A.accountKey, "/Projets/E2E serveur renomme")) && !(await folderAt(A.accountKey, "/E2E serveur renomme")), { timeout: 90_000 });
    await check("dossier déplacé sur le serveur : déplacé localement", fMov, (await localFolders(A.accountKey)).map((f) => f.path));
    await mock("add_message", [login, "Projets/E2E serveur renomme"], { subject: S.inServerFolder });
    const inSF = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Projets/E2E serveur renomme"), S.inServerFolder).length === 1, { timeout: 90_000 });
    await check("message dans ce dossier : importé", inSF);
    await mock("delete_folder", [login, "Projets/E2E serveur renomme"]);
    const fDel = await waitFor(async () => !(await folderAt(A.accountKey, "/Projets/E2E serveur renomme")) && (await folderAt(A.accountKey, "/Trash/E2E serveur renomme")), { timeout: 90_000 });
    const kept = await localMessages(A.accountKey, "/Trash/E2E serveur renomme");
    await check("dossier supprimé sur le serveur : copie locale mise dans /Trash, avec son message", fDel && withSubject(kept, S.inServerFolder).length === 1, (await localFolders(A.accountKey)).map((f) => f.path));

  });

  // ── 5. Sending
  if (want(5)) await guard("étape 5", async () => {
    await step("5. Envoi");
    const account = await browser.accounts.get(A.accountKey);
    const identity = account.identities[0];
    const insp = await T.inspect(A.accountKey);
    const smtp = insp?.identities?.[0]?.effectiveSmtp;
    // The neutral server: marked as ours, no user name, an address that cannot be a real SMTP server
    // (sync443.invalid in the first design, 127.0.0.1 port 1 since).
    await check(
      "identité de A : serveur sortant neutre (marqué, inutilisable, sans identifiant), jamais un SMTP réel",
      smtp?.owner === browser.runtime.id && !smtp.username && (smtp.hostname === "sync443.invalid" || (smtp.hostname === "127.0.0.1" && smtp.port === 1)),
      smtp,
    );
    const seqSend = await mock("last_seq");
    const owner = await browser.sync443Account.accountOfIdentity(identity.id);
    await check("l'identité de A est reconnue comme celle d'une boîte de l'extension", owner?.mailboxId === A.id, { identity: identity.id, owner });
    // Observes what onBeforeSend carries (returns nothing: changes nothing).
    const seen = [];
    const probe = (t, details) => {
      seen.push({ tab: t?.id, identityId: details?.identityId, from: details?.from, to: details?.to });
    };
    browser.compose.onBeforeSend.addListener(probe);
    const tab = await browser.compose.beginNew({ identityId: identity.id, to: [E.bob.login], subject: S.send, plainTextBody: "Bonjour Bob,\n\nmessage envoyé par ActiveSync.\n", isPlainText: true });
    const ready = await waitFor(async () => {
      const d = await browser.compose.getComposeDetails(tab.id);
      return d?.subject === S.send && d.identityId === identity.id && (d.to ?? []).length === 1 ? d : null;
    }, { timeout: 30_000, interval: 250 });
    await check("fenêtre de rédaction ouverte (sans interface), identité de A, destinataire et sujet en place", ready, ready && { identityId: ready.identityId, to: ready.to });
    // What Thunderbird says about signing and encryption for this identity (no OpenPGP key, no S/MIME certificate).
    const tech = ready && Object.prototype.hasOwnProperty.call(ready, "selectedEncryptionTechnology") ? ready.selectedEncryptionTechnology : "ABSENT";
    // Reported by the runner: send.mjs must accept what Thunderbird really gives for a plain message.
    await info("selectedEncryptionTechnology", tech);
    await sleep(1000);
    let sendOutcome = null;
    browser.compose
      .sendMessage(tab.id, { mode: "sendNow" })
      .then((r) => (sendOutcome = { resolved: r ?? null }))
      .catch((e) => (sendOutcome = { rejected: String(e?.message ?? e) }));
    const sentMail = await waitFor(async () => {
      const list = await rpc("sent", { login });
      return list.length && list.every((m) => m.status) ? list : null;
    }, { timeout: 60_000 });
    await sleep(5000);
    const sentList = await rpc("sent", { login });
    // Without a SendMail, what follows cannot happen: its checks fail at once instead of waiting.
    const fast = (ms) => (sentMail ? ms : 1000);
    await check("SendMail reçu exactement une fois, accepté (Status 1)", sentList.length === 1 && sentList[0].status === "1", sentList.map((m) => ({ status: m.status, error: m.error })));
    const m0 = sentList[0] ?? {};
    await check("MIME envoyé sans X-Mozilla-*, X-Account-Key, X-Identity-Key ni Fcc (en tête et dans chaque partie)", sentMail && !m0.internal_headers?.length && m0.parts >= 1, { internal: m0.internal_headers, parts: m0.parts });
    await check("… adressé à Bob, sujet intact, copie dans les Éléments envoyés du serveur", m0.subject === S.send && m0.recipients?.includes(E.bob.login) && m0.save_in_sent && m0.sent_copy, { subject: m0.subject, recipients: m0.recipients, sentCopy: m0.sent_copy });
    const closed = await waitFor(async () => {
      try {
        await browser.tabs.get(tab.id);
        return false;
      } catch {
        return true;
      }
    }, { timeout: fast(30_000) });
    await check("fenêtre de rédaction fermée après l'envoi", closed);
    await info("composeSendMessage", sendOutcome);
    await info("onBeforeSendSeen", seen);
    browser.compose.onBeforeSend.removeListener(probe);
    const draftGone = await waitFor(async () => !withSubject(await localMessages(A.accountKey, "/Drafts"), S.send).length, { timeout: 30_000 });
    await check("brouillon supprimé localement après l'envoi", sentMail && draftGone);
    const sentBack = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Sent"), S.send).length === 1, { timeout: fast(90_000) });
    await check("copie envoyée revenue par la synchro dans /Sent (une seule)", sentBack, withSubject(await localMessages(A.accountKey, "/Sent"), S.send).length);
    const localAccounts = (await browser.accounts.list()).filter((a) => a.type === "none" && !(ctx.entries && [...ctx.entries.values()].some((e) => e.mailbox.accountKey === a.id)));
    let queued = 0;
    for (const a of localAccounts) {
      for (const f of await browser.folders.query({ accountId: a.id, specialUse: ["outbox"] })) {
        queued += withSubject(await localMessages(a.id, f.path), S.send).length;
      }
    }
    await check("rien dans la file d'envoi de Thunderbird (Messages en attente)", queued === 0, queued);
    const smtpAttempts = (await rpc("requests", { since: seqSend })).filter((r) => r.cmd === "SendMail").length;
    await check("un seul SendMail de A (aucune autre voie d'envoi tentée)", smtpAttempts === 1, smtpAttempts);
    ctx.runSync(B.id, { reason: "user" });
    const bobGot = await waitFor(async () => withSubject(await localMessages(B.accountKey, "/Inbox"), S.send).length === 1, { timeout: fast(90_000) });
    await check("B reçoit le message (livré par le serveur, synchro de B)", bobGot);

  });

  // ── 6. Mass deletion
  if (want(6)) await guard("étape 6", async () => {
    await step("6. Suppression en masse");
    const masseSid = E.folders.alice.Masse;
    const doomed = await mock("mass_delete", [login, masseSid, 55]);
    const blocked = await waitFor(async () => ((await health(A.id)).blocked?.code === "MASS_DELETE" ? await health(A.id) : null), { timeout: 150_000 });
    const stillThere = await localMessages(A.accountKey, "/Masse");
    const pending = await ctx.entries.get(A.id).sync.pendingDeletes();
    await check("55 suppressions sur 60 : boîte bloquée (MASS_DELETE) dans sa santé", blocked, (await health(A.id)).blocked);
    await check("… rien supprimé localement (60 messages dans /Masse)", stillThere?.length === 60, stillThere?.length);
    await check("… 55 suppressions retenues", pending.count === 55 && doomed.length === 55, pending);
    ctx.runSync(A.id, { reason: "user", confirmDeletes: true }); // the settings page's "Confirmer les suppressions"
    const applied = await waitFor(async () => {
      const m = await localMessages(A.accountKey, "/Masse");
      const t = (await localMessages(A.accountKey, "/Trash")).filter((x) => /^E2E masse /.test(x.subject));
      const h = await health(A.id);
      return m?.length === 5 && t.length === 55 && !h.blocked ? { masse: m.length, trash: t.length } : null;
    }, { timeout: 120_000 });
    await check("confirmées : appliquées, les 55 copies dans /Trash, boîte débloquée", applied, {
      masse: (await localMessages(A.accountKey, "/Masse"))?.length,
      blocked: (await health(A.id)).blocked,
    });

  });

  if (want(7)) await guard("étape 7", () => archiveAndLocalOnly(A));

  await checkLocalFolders("fin de la phase 1");
  const listed = await browser.sync443Account.listAccounts();
  await check("les comptes de A et B sont toujours reconnus comme ceux de l'extension", listed.some((a) => a.accountKey === A.accountKey) && listed.some((a) => a.accountKey === B.accountKey), listed);

  // For phase 2: Thunderbird's ids of the messages acted upon after the restart.
  const inboxNow = await localMessages(A.accountKey, "/Inbox");
  await info("idsBeforeRestart", {
    [S.restartDelete]: withSubject(inboxNow, S.restartDelete)[0]?.id ?? null,
    [S.restartMove]: withSubject(inboxNow, S.restartMove)[0]?.id ?? null,
  });
  await idle(A.id, 0, 60_000);
}

// ── Phase 1, step 7: Thunderbird's Archive action, and a move to a local-only folder ──

async function archiveAndLocalOnly(A) {
  const login = E.alice.login;
  await step("7. Archivage, déplacement vers un dossier local seulement");
  const inbox = await localMessages(A.accountKey, "/Inbox");
  const toArchive = withSubject(inbox, S.toArchive)[0];
  const toLocal = withSubject(inbox, S.toLocalOnly)[0];
  if (!toArchive || !toLocal) throw new Error("messages de l'étape 7 absents de /Inbox");
  const before = (await serverFind(login, S.toArchive))[0];
  const foldersBefore = await serverFolders(login);
  const archivesBefore = foldersBefore.filter((f) => f.parent_id === "0" && f.name === "Archives");
  await check(
    E.serverArchives ? "avant l'archivage : un dossier « Archives » à la racine du serveur" : "avant l'archivage : aucun dossier « Archives » sur le serveur",
    archivesBefore.length === (E.serverArchives ? 1 : 0),
    archivesBefore,
  );

  // (1) Archive, as the "Archive" button does.
  const seqArchive = await mock("last_seq");
  await browser.messages.archive([toArchive.id]);
  const localArchived = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Archives"), S.toArchive).length === 1, { timeout: 30_000 });
  const underArchives = (await localFolders(A.accountKey)).map((f) => f.path).filter((p) => p.startsWith("/Archives/"));
  await check("archivé localement : dans /Archives, sans sous-dossier (ni année ni structure de dossiers)", localArchived && !underArchives.length, underArchives);
  const moved = await waitFor(async () => {
    const r = await serverFind(login, S.toArchive);
    return r.length === 1 && r[0].folder === "Archives" ? r : null;
  }, { timeout: 90_000 });
  const now = await serverFind(login, S.toArchive);
  await check("archivé sur le serveur : dans « Archives » à la racine", moved, now.map((m) => m.folder));
  const acts = await rpc("actions", { since: seqArchive, login, device_id: A.deviceId, kinds: ["move", "sync_delete", "folder_create", "folder_update", "folder_delete"] });
  const archives = (await serverFolders(login)).filter((f) => f.parent_id === "0" && f.name === "Archives");
  const archivesId = archives[0]?.server_id ?? null;
  await check(
    "… par MoveItems depuis la boîte de réception, jamais supprimé (aucun Delete, jamais dans les Éléments supprimés)",
    acts.some((a) => a.kind === "move" && a.src_msg_id === before?.server_id && a.dst_fld_id === archivesId && a.status === "3")
      && !acts.some((a) => a.kind === "sync_delete")
      && !now.some((m) => m.folder === "Deleted Items"),
    acts.map((a) => ({ kind: a.kind, src: a.src_msg_id ?? a.server_id, dst: a.dst_fld_id ?? a.parent_id, name: a.name, status: a.status })),
  );
  const created = acts.filter((a) => a.kind === "folder_create");
  if (E.serverArchives) {
    await check("… le dossier « Archives » existant du serveur est réutilisé (aucun FolderCreate, toujours un seul)", !created.length && archives.length === 1 && archivesId === archivesBefore[0]?.server_id, { created, archives });
  } else {
    await check(
      "… le dossier « Archives » créé à la racine du serveur par FolderCreate (dossier de courrier, un seul)",
      created.length === 1 && created[0].name === "Archives" && created[0].parent_id === "0" && created[0].status === "1" && archives.length === 1 && archives[0].type === 12,
      { created, archives },
    );
  }
  await check("… aucun sous-dossier sous « Archives » sur le serveur", archivesId !== null && !(await serverFolders(login)).some((f) => f.parent_id === archivesId), (await serverFolders(login)).map((f) => f.path));

  // What the engine binds once the next passes are over.
  await ctx.runSync(A.id, { reason: "user" });
  await idle(A.id, 0, 120_000);
  const binding = await ctx.store.mailbox(A.id).get("archives", null);
  const localPaths = (await localFolders(A.accountKey)).map((f) => f.path).filter((p) => p.startsWith("/Archives"));
  const inArchives = await localMessages(A.accountKey, "/Archives");
  const serverArchived = archivesId ? await serverMessages(login, archivesId) : [];
  const old = localPaths.includes("/Archives (2)") ? await localMessages(A.accountKey, "/Archives (2)") : null;
  await info("archivesBinding", {
    record: binding,
    serverArchives: archivesId,
    localFolders: localPaths,
    local: inArchives?.map((m) => m.subject),
    server: serverArchived.map((m) => m.subject),
    oldLocalFolder: old?.map((m) => m.subject) ?? null,
  });
  await check("le dossier local /Archives est lié au dossier « Archives » du serveur", binding?.serverId === archivesId, { binding, archivesId });
  await check(
    "/Archives et « Archives » du serveur ont les mêmes messages",
    inArchives && JSON.stringify(inArchives.map((m) => m.subject).sort()) === JSON.stringify(serverArchived.map((m) => m.subject).sort()),
    { local: inArchives?.map((m) => m.subject), server: serverArchived.map((m) => m.subject) },
  );
  if (E.serverArchives) {
    // The message the server already had in its "Archives" was first imported into "/Archives (2)".
    const all = [];
    for (const f of await localFolders(A.accountKey)) all.push(...withSubject(await localMessages(A.accountKey, f.path), S.archive).map(() => f.path));
    await check("le message déjà archivé sur le serveur n'est pas en double localement", all.length === 1, all);
  }

  // (2) A move to a folder of our account that has no server counterpart.
  const templates = await folderAt(A.accountKey, "/Templates");
  const keep = (await serverFind(login, S.toLocalOnly))[0];
  const seqLocal = await mock("last_seq");
  await browser.messages.move([toLocal.id], templates.id);
  const there = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Templates"), S.toLocalOnly).length === 1, { timeout: 30_000 });
  await check("déplacement vers /Templates (dossier sans équivalent sur le serveur) : fait localement", there);
  const drained = await journalDone(A.id);
  await check("… et le journal des actions locales se vide (rien n'y reste en attente)", drained, await ctx.entries.get(A.id)?.sync.journal.list());
  await ctx.runSync(A.id, { reason: "user" });
  await idle(A.id, 0, 120_000);
  const after = await serverFind(login, S.toLocalOnly);
  const touched = (await rpc("actions", { since: seqLocal, login, device_id: A.deviceId, kinds: ["move", "sync_delete", "sync_change"] }))
    .filter((a) => a.src_msg_id === keep?.server_id || a.server_id === keep?.server_id);
  await check(
    "… rien sur le serveur : ni Delete ni MoveItems, la copie du serveur reste dans la boîte de réception",
    !touched.length && after.length === 1 && after[0].folder === "Inbox" && after[0].server_id === keep?.server_id,
    { actions: touched, server: after.map((m) => `${m.folder}/${m.server_id}`) },
  );
  await check(
    "… et elle ne revient pas dans /Inbox (pas de réimport), la copie locale reste dans /Templates",
    !withSubject(await localMessages(A.accountKey, "/Inbox"), S.toLocalOnly).length && withSubject(await localMessages(A.accountKey, "/Templates"), S.toLocalOnly).length === 1,
  );
}

// ── Phase 2: after a restart ──────────────────────────────────────────────

async function phase2(previous) {
  const { A, B } = await mailboxes();
  const login = E.alice.login;
  await step("Redémarrage : correspondances, actions locales immédiates");
  await check("après redémarrage : les deux boîtes sont là, avec leur compte", A?.accountKey && B?.accountKey && ctx.entries.get(A.id)?.sync && ctx.entries.get(B.id)?.sync);
  await checkLocalFolders("après redémarrage");
  const inboxSid = E.folders.alice.Inbox;
  // Read as the engine reads it (its record format is its own business).
  const { loadCollection } = await import("./sync/mail.mjs");
  const table = await loadCollection(ctx.store.mailbox(A.id), inboxSid);
  await check("table ServerId → Message-ID de la boîte de réception conservée", table && table.syncKey !== "0" && table.items?.size >= 10, table && { syncKey: table.syncKey, items: table.items?.size });
  const seq0 = await mock("last_seq");
  const sidsBefore = {
    del: (await serverFind(login, S.restartDelete))[0],
    move: (await serverFind(login, S.restartMove))[0],
  };

  // Right away, before any sync. Thunderbird numbers messages in the order a session first sees them:
  // other folders are read first here, so the two messages get other ids than before the restart.
  for (const path of ["/Masse", "/Sent", "/Projets", "/Trash"]) await localMessages(A.accountKey, path);
  const inbox = await localMessages(A.accountKey, "/Inbox");
  const toDel = withSubject(inbox, S.restartDelete)[0];
  const toMove = withSubject(inbox, S.restartMove)[0];
  await info("idsAfterRestart", { [S.restartDelete]: toDel?.id ?? null, [S.restartMove]: toMove?.id ?? null, before: previous });
  await check(
    "Thunderbird a renuméroté ses messages au redémarrage (les deux messages visés ont d'autres identifiants)",
    previous && toDel && toMove && previous[S.restartDelete] !== toDel.id && previous[S.restartMove] !== toMove.id,
    { before: previous, after: { del: toDel?.id, move: toMove?.id } },
  );
  const projets = await folderAt(A.accountKey, "/Projets");
  await browser.messages.delete([toDel.id]);
  await browser.messages.move([toMove.id], projets.id);
  // What the background does at start-up, after its delay.
  for (const id of ctx.entries.keys()) ctx.runSync(id, { reason: "démarrage" });

  const ok = await waitFor(async () => {
    const d = await serverFind(login, S.restartDelete);
    const m = await serverFind(login, S.restartMove);
    return d.length === 1 && d[0].folder === "Deleted Items" && m.length === 1 && m[0].folder === "Projets" ? { d, m } : null;
  }, { timeout: 120_000 });
  await check("suppression locale juste après le redémarrage : le BON message va dans les Éléments supprimés", ok?.d, await serverFind(login, S.restartDelete));
  await check("déplacement local juste après le redémarrage : le BON message va dans Projets", ok?.m, await serverFind(login, S.restartMove));
  const moves = await rpc("actions", { since: seq0, login, device_id: A.deviceId, kinds: ["move", "sync_delete", "sync_change"] });
  await check(
    "… et aucun autre : exactement deux MoveItems, sur les ServerId de ces deux messages",
    moves.length === 2 && moves.every((m) => m.kind === "move" && m.status === "3") && moves.some((m) => m.src_msg_id === sidsBefore.del?.server_id) && moves.some((m) => m.src_msg_id === sidsBefore.move?.server_id),
    moves.map((m) => ({ kind: m.kind, src: m.src_msg_id, dst: m.dst_fld_id, status: m.status })),
  );
  const witness = await serverFind(login, S.witness);
  await check("le message témoin n'a pas bougé sur le serveur", witness.length === 1 && witness[0].folder === "Inbox", witness);
  await idle(A.id, 0, 120_000);
  const drained = await journalDone(A.id);
  await check("journal des actions locales vidé après le redémarrage", drained, await ctx.entries.get(A.id)?.sync.journal.list());

  const syncs = (await rpc("requests", { since: seq0, login, device_id: A.deviceId })).filter((r) => r.cmd === "Sync" || r.cmd === "FolderSync");
  const zero = syncs.filter((r) => (r.sync_keys ?? []).some((k) => k === "0"));
  await check("aucune resynchro complète après le redémarrage (aucune SyncKey « 0 »)", syncs.length && !zero.length, { requests: syncs.length, zero: zero.map((r) => r.cmd) });
  const counts = [];
  const pairs = [["/Inbox", "Inbox"], ["/Inbox/Clients", "Inbox/Clients"], ["/Projets", "Projets"], ["/Projets/2026", "Projets/2026"], ["/Sent", "Sent Items"], ["/Masse", "Masse"], ["/Factures_ 2026", "Factures: 2026"]];
  if ((await serverFolders(login)).some((f) => f.parent_id === "0" && f.name === "Archives")) pairs.push(["/Archives", "Archives"]);
  // A message moved to a local-only folder (phase 1, step 7) keeps its server copy: not counted on the server side.
  const keptOnServer = withSubject(await localMessages(A.accountKey, "/Templates"), S.toLocalOnly).length ? [S.toLocalOnly] : [];
  for (const [path, folder] of pairs) {
    const local = (await localMessages(A.accountKey, path))?.length ?? -1;
    const server = (await serverMessages(login, folder)).filter((m) => !(folder === "Inbox" && keptOnServer.includes(m.subject))).length;
    counts.push({ path, local, server });
  }
  await check("aucun doublon ni perte : autant de messages localement que sur le serveur, dossier par dossier", counts.every((c) => c.local === c.server), counts);

  await step("Redémarrage : le Ping reprend");
  const pinging = await waitFor(async () => (await mock("pings_waiting", [login, A.deviceId])).length >= 1, { timeout: 90_000 });
  await check("Ping de A de nouveau en attente sur le serveur", pinging);
  const t = Date.now();
  await mock("add_message", [login, "Inbox"], { subject: S.pushAfterRestart });
  const arrived = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Inbox"), S.pushAfterRestart).length === 1, { timeout: 120_000, interval: 300 });
  await check("nouveau message après redémarrage : arrivé par push", arrived && Date.now() - t < 60_000, `${Date.now() - t} ms`);
  await idle(A.id, 0, 60_000);
}

// ── Phase 3: removal of B, mail unchecked for A ───────────────────────────

async function phase3() {
  const { A, B } = await mailboxes();
  const login = E.alice.login;
  for (const id of ctx.entries.keys()) ctx.runSync(id, { reason: "démarrage" });
  await idle(A.id, 0, 120_000);
  await idle(B.id, 0, 120_000);

  await guard("Suppression de la boîte B", async () => {
    await step("Suppression de la boîte B");
    const inspB = await T.inspect(B.accountKey);
    await info("bAccount", { accountKey: B.accountKey, localPath: inspB?.localPath });
    const bobBefore = await serverFolders(E.bob.login);
    const seq0 = await mock("last_seq");
    await ctx.removeMailbox(B.id); // what the settings page asks
    await check("B retirée de la liste des boîtes", !(await ctx.store.getMailbox(B.id)) && !ctx.entries.has(B.id));
    const accounts = await browser.sync443Account.listAccounts();
    await check("compte Thunderbird de B supprimé (A gardé)", !accounts.some((a) => a.accountKey === B.accountKey) && accounts.some((a) => a.accountKey === A.accountKey), accounts);
    await check("dossier du compte de B supprimé du disque", inspB?.localPath && !(await T.exists(inspB.localPath)), inspB?.localPath);
    await check("mot de passe de B retiré du gestionnaire", !(await sync443Logins(B.origin)).length && (await sync443Logins(A.origin)).length === 1);
    const origins = (await browser.permissions.getAll()).origins ?? [];
    await check("permission d'hôte de B (https://localhost/*) rendue, celle de A gardée", !origins.includes("https://localhost/*") && origins.includes("https://127.0.0.1/*"), origins);
    const alarms = await browser.alarms.getAll();
    await check("minuterie de B retirée", !alarms.some((a) => a.name === `sync443:${B.id}`), alarms.map((a) => a.name));
    const keys = Object.keys(await browser.storage.local.get(null)).filter((k) => k.startsWith(`mb/${B.id}/`));
    await check("enregistrements de B effacés", !keys.length, keys);
    await sleep(3000);
    const bobAfter = await serverFolders(E.bob.login);
    const bobRequests = await rpc("requests", { since: seq0, login: E.bob.login });
    await check(
      "rien supprimé sur le serveur pour B (mêmes dossiers, mêmes messages, plus aucune requête de B)",
      JSON.stringify(bobAfter.map((f) => [f.server_id, f.count])) === JSON.stringify(bobBefore.map((f) => [f.server_id, f.count])) && !bobRequests.length,
      { before: bobBefore.map((f) => [f.name, f.count]), after: bobAfter.map((f) => [f.name, f.count]), requests: bobRequests.map((r) => r.cmd) },
    );
  });

  await guard("A après la suppression de B", async () => {
    await step("A fonctionne toujours");
    const t = Date.now();
    await mock("add_message", [login, "Inbox"], { subject: S.afterRemoval });
    const arrived = await waitFor(async () => withSubject(await localMessages(A.accountKey, "/Inbox"), S.afterRemoval).length === 1, { timeout: 120_000, interval: 300 });
    await check("A reçoit toujours son courrier (push)", arrived, `${Date.now() - t} ms`);
    await idle(A.id, 0, 60_000);
  });

  await guard("Période de courrier", () => periodChange(A));

  await guard("Courrier décoché pour A", async () => {
    await step("Courrier décoché pour A (agenda gardé)");
    const view = { ...A, server: `127.0.0.1:${E.port}` };
    const seqOff = await mock("last_seq");
    const savedAt = Date.now() / 1000;
    const templatesBefore = (await localMessages(A.accountKey, "/Templates").catch(() => [])).length;
    const res = await ctx.saveMailbox(input(view, { sync: { mail: false, calendar: true, contacts: false, tasks: false } }), null);
    const A2 = await mailboxById(A.id);
    await check("A enregistrée sans le courrier (mot de passe gardé, non retapé)", res?.id === A.id && A2 && !A2.sync.mail && A2.sync.calendar, A2?.sync);
    await sleep(4000);
    await mock("add_message", [login, "Inbox"], { subject: S.mailOff });
    await sleep(25_000);
    // The calendar, kept, goes on (FolderSync, its own Sync and Ping): no request may name a mail folder any more.
    // (The Ping the engine was waiting on when the mailbox was saved, cut short by the save, is listed too: it
    // began before.)
    const mailIds = (await serverFolders(login)).filter((f) => !E.pimFolders.alice.includes(f.server_id)).map((f) => f.server_id);
    const reqs = (await rpc("requests", { since: seqOff, login, device_id: A.deviceId })).filter((r) => r.cmd !== "Ping" || r.time >= savedAt);
    const ofMail = reqs.filter((r) => r.cmd === "MoveItems" || (r.cmd === "Sync" && (r.collections ?? []).some(([cid]) => mailIds.includes(cid))) || (r.cmd === "Ping" && (r.ping_folders ?? []).some((id) => mailIds.includes(id))));
    const pings = (await mock("pings_waiting", [login, A.deviceId])).filter((p) => (p.folders ?? []).some((id) => mailIds.includes(id)));
    await check(
      "plus aucune synchro de courrier pour A (ni Sync ni Ping d'un dossier de courrier, ni MoveItems ; l'agenda, gardé, continue)",
      !ofMail.length && !pings.length,
      { mail: ofMail.map((r) => [r.cmd, r.collections ?? r.ping_folders]), pings: pings.length, cmds: reqs.map((r) => r.cmd) },
    );
    await check("… le nouveau message du serveur n'est pas importé", !withSubject(await localMessages(A.accountKey, "/Inbox"), S.mailOff).length);
    const stillAccount = await T.inspect(A.accountKey);
    await check("courrier décoché : le compte de A reste en place (il porte l'identité des réunions)", Boolean(stillAccount), A.accountKey);
    const inboxLeft = await localMessages(A.accountKey, "/Inbox");
    await check("… les copies locales des messages du serveur ont quitté Thunderbird", inboxLeft.length === 0, inboxLeft.map((x) => x.subject).slice(0, 8));
    const templatesAfter = (await localMessages(A.accountKey, "/Templates").catch(() => [])).length;
    await check("… un message qui n'existe que dans Thunderbird (dossier purement local) reste", templatesAfter === templatesBefore && templatesBefore > 0, { before: templatesBefore, after: templatesAfter });
    const namesLeft = (await browser.storage.local.get(null));
    const mailRecords = Object.keys(namesLeft).filter((k) => k.startsWith(`mb/${A.id}/coll:`) || k === `mb/${A.id}/layout`);
    await check("… et plus rien n'est retenu pour le courrier de A", mailRecords.length === 0, mailRecords.slice(0, 5));
    // A local action in that account, now that mail is no longer synchronised.
    const m = withSubject(await localMessages(A.accountKey, "/Inbox"), S.witness)[0];
    if (m) {
      const jBefore = await ctx.entries.get(A.id).sync.journal.size();
      await browser.messages.update(m.id, { flagged: !m.flagged });
      await sleep(5000);
      const jAfter = await ctx.entries.get(A.id).sync.journal.size();
      const sent = (await rpc("actions", { since: seqOff, login, device_id: A.deviceId, kinds: ["sync_change"] })).length;
      await check("action locale dans ce compte : rien n'est envoyé au serveur", sent === 0, sent);
      if (jAfter > jBefore) {
        await gap("… mais elle s'ajoute au journal de A, qui ne sera jamais rejoué tant que le courrier reste décoché (et le serait s'il était recoché)", { before: jBefore, after: jAfter });
      }
    }
  });
}

/**
 * The mail period (FilterType) of A changed as the settings page does it:
 * 1 month, all, 1 month again, then all on a server that starts over when
 * the period changes (Status 3 for every collection). Nothing is lost,
 * nothing is imported twice, nothing changes on the server.
 */
async function periodChange(A) {
  await step("Période de courrier : 1 mois, tout, 1 mois, puis tout avec un serveur qui repart de zéro");
  const login = E.alice.login;
  const view = { ...A, server: `127.0.0.1:${E.port}` };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const subjects = [S.periodRecent, S.period60, S.period400];
  const counts = async () => {
    const list = await localMessages(A.accountKey, "/Inbox");
    return Object.fromEntries(subjects.map((subject) => [subject, withSubject(list, subject).length]));
  };
  /** Every local folder of A: [path, messages, messages whose Message-ID is already in the folder, subjects]. */
  const localState = async () => {
    const out = [];
    for (const { path } of await localFolders(A.accountKey)) {
      const list = (await localMessages(A.accountKey, path)) ?? [];
      out.push([path, list.length, list.length - new Set(list.map((m) => m.mid)).size, list.map((m) => m.subject).sort()]);
    }
    return out.sort(byPath);
  };
  const serverState = async () => (await serverFolders(login)).map((f) => [f.path, f.count]).sort(byPath);
  const minus = (xs, ys) => {
    const left = [...ys];
    return xs.filter((x) => {
      const i = left.indexOf(x);
      if (i < 0) return true;
      left.splice(i, 1);
      return false;
    });
  };
  /** What differs between two states: [{path, before, after, added, removed}] (counts, then subjects). */
  const changes = (before, after) => {
    const b = new Map(before.map(([path, ...rest]) => [path, rest]));
    const a = new Map(after.map(([path, ...rest]) => [path, rest]));
    const out = [];
    for (const path of new Set([...b.keys(), ...a.keys()])) {
      const x = b.get(path) ?? null;
      const y = a.get(path) ?? null;
      if (same(x, y)) continue;
      out.push({ path, before: x?.slice(0, 2) ?? null, after: y?.slice(0, 2) ?? null, added: minus(y?.[2] ?? [], x?.[2] ?? []), removed: minus(x?.[2] ?? [], y?.[2] ?? []) });
    }
    return out;
  };
  const diff = (local, server, after) => ({ local: changes(local, after[0]), server: changes(server, after[1]) });
  const syncsSince = async (seq) => (await rpc("requests", { since: seq, login, device_id: A.deviceId })).filter((r) => r.cmd === "Sync");
  // The mail period, in the Sync requests of mail folders (those of the calendar and the tasks carry their own filter).
  const periodsSent = (syncs) => syncs.flatMap((r) => (r.filters ?? []).filter(([cid]) => !E.pimFolders.alice.includes(cid)).map(([, ft]) => ft)).filter((ft) => ft !== null);
  const healthy = (h) => Boolean(h) && !h.blocked && (h.failures ?? 0) === 0;
  /** What the settings page does when the period is changed (password not typed again). */
  const setPeriod = async (filterType) => {
    const seq = await mock("last_seq");
    const since = Date.now();
    const err = await errorOf(() => ctx.saveMailbox(input(view, { filterType }), null));
    const saved = (await mailboxById(A.id))?.filterType ?? null;
    const h = await idle(A.id, since, 180_000);
    const journal = Boolean(await journalDone(A.id));
    return { seq, err, saved, h, journal, ok: !err && saved === filterType && healthy(h) && journal };
  };
  const outcome = (r) => ({ err: r.err, saved: r.saved, health: r.h, journalEmpty: r.journal });

  // 1. One month: the messages already there are recent; nothing changes.
  let local = await localState();
  let server = await serverState();
  let r = await setPeriod("5");
  await check("période passée à « 1 mois » : enregistrée sans erreur, synchro réussie, journal vide", r.ok, outcome(r));
  let sent = periodsSent(await syncsSince(r.seq));
  await check("… les synchros envoient la période « 1 mois » (FilterType 5)", sent.length > 0 && sent.every((ft) => ft === "5"), sent);
  let after = [await localState(), await serverState()];
  await check("… rien ne change, ni dans Thunderbird ni sur le serveur", same(after, [local, server]), diff(local, server, after));

  // Messages received now, 60 and 400 days ago.
  for (const [subject, days] of [[S.periodRecent, 0], [S.period60, 60], [S.period400, 400]]) {
    await rpc("add_dated", { login, folder: "Inbox", subject, days });
  }
  const recent = await waitFor(async () => (await counts())[S.periodRecent] === 1, { timeout: 120_000, interval: 300 });
  await idle(A.id, 0, 60_000);
  let c = await counts();
  await check("« 1 mois » : le message récent arrive (push), ceux de 60 et 400 jours ne sont pas téléchargés", recent && c[S.period60] === 0 && c[S.period400] === 0, c);

  // 2. All: the older messages arrive, once.
  local = await localState();
  server = await serverState();
  r = await setPeriod("0");
  await check("période passée à « tout » : enregistrée sans erreur, synchro réussie, journal vide", r.ok, outcome(r));
  sent = periodsSent(await syncsSince(r.seq));
  await check("… les synchros envoient la période « tout » (FilterType 0)", sent.length > 0 && sent.every((ft) => ft === "0"), sent);
  await waitFor(async () => {
    const k = await counts();
    return k[S.period60] > 0 && k[S.period400] > 0;
  }, { timeout: 60_000, interval: 300 });
  c = await counts();
  await check("« tout » : les messages de 60 et 400 jours arrivent, chacun une seule fois", subjects.every((subject) => c[subject] === 1), c);
  const expected = local.map(([path, n, twice, list]) => (path === "/Inbox" ? [path, n + 2, twice, [...list, S.period60, S.period400].sort()] : [path, n, twice, list]));
  after = [await localState(), await serverState()];
  await check("… aucun doublon ni autre changement dans Thunderbird, rien ne change sur le serveur", same(after, [expected, server]), diff(expected, server, after));

  // 3. One month again: the older messages leave the period (SoftDelete), their local copies stay.
  local = await localState();
  server = await serverState();
  r = await setPeriod("5");
  await check("retour à « 1 mois » : sans erreur, boîte non bloquée (sorties de période hors seuil de suppression), journal vide", r.ok, outcome(r));
  after = [await localState(), await serverState()];
  await check("… les copies locales des messages de 60 et 400 jours restent ; rien n'est supprimé ni déplacé sur le serveur", same(after, [local, server]), diff(local, server, after));

  // 4. All, on a server that starts over when the period changes.
  local = await localState();
  server = await serverState();
  await mock("set_option", ["status3_on_filter_change", true]);
  try {
    r = await setPeriod("0");
  } finally {
    await mock("set_option", ["status3_on_filter_change", false]);
  }
  const syncs = await syncsSince(r.seq);
  const restarted = syncs.some((x) => (x.collections ?? []).some(([cid, key]) => cid && key === "0"));
  await check("serveur qui repart de zéro quand la période change (statut 3) : resynchronisation complète, sans erreur, journal vide", restarted && r.ok, { restarted, ...outcome(r) });
  // The message moved to a local-only folder (phase 1, step 7) kept its server copy: a full resync
  // brings it back to the Inbox (accepted, docs/audits/stages-2-3.md). Nothing else may change.
  const keptOnServer = withSubject(await localMessages(A.accountKey, "/Templates"), S.toLocalOnly).length > 0;
  const withKept = local.map(([path, n, twice, list]) =>
    path === "/Inbox" && keptOnServer ? [path, n + 1, twice, [...list, S.toLocalOnly].sort()] : [path, n, twice, list]);
  await waitFor(async () => {
    const now = await localState();
    return same(now, local) || same(now, withKept);
  }, { timeout: 60_000, interval: 500 });
  after = [await localState(), await serverState()];
  c = await counts();
  const back = keptOnServer && !same(withKept, local) && same(after[0], withKept);
  await check(
    "… chaque message une seule fois, rien de réimporté ni de perdu dans aucun dossier, rien ne change sur le serveur",
    (same(after[0], local) || back) && same(after[1], server) && subjects.every((subject) => c[subject] === 1),
    { counts: c, ...diff(back ? withKept : local, server, after) },
  );
  if (back) {
    await gap(
      "resynchronisation complète : le message déplacé vers un dossier purement local (/Templates) revient aussi dans la boîte de réception, sa copie étant restée sur le serveur (écart accepté, docs/audits/stages-2-3.md)",
      { subject: S.toLocalOnly },
    );
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function runScenario(context) {
  ctx = context;
  E = context.testConfig?.e2e ?? null;
  let phase = 0;
  try {
    const p = await T.phase();
    phase = p.phase;
    steps = Array.isArray(p.steps) ? p.steps : null;
    if (E?.debugLog) await ctx.log.setDebugFor(3_600_000); // run_mail_test.py --debug-log (the log keeps its last entries only)
    await emit("START", { phase, at: Date.now(), version: (await browser.runtime.getBrowserInfo?.())?.version ?? null });
    if (!E) throw new Error("test-config.json sans e2e");
    if (E.suite === "calendar") {
      // Calendar, tasks and meetings: a scenario of its own (calendar-scenario.mjs), packaged by
      // run_calendar_sync_test.py only. It reports through the helpers of this module.
      const { runCalendarPhase } = await import("./calendar-scenario.mjs");
      await runCalendarPhase({ ctx, E, T, phase, request: p, emit, check, info, gap, step, guard, rpc, mock, waitFor, errorOf, sleep, health, idle, input, mailboxById, sync443Logins });
    } else if (phase === 1) await phase1();
    else if (phase === 2) await phase2(p.previous ?? null);
    else if (phase === 3) await phase3();
    else throw new Error(`phase inconnue : ${phase}`);
  } catch (e) {
    failures++;
    await emit("CRASH", { error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 2000) });
  }
  await finish(phase);
}
