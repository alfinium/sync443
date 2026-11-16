// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * sync443Account end-to-end scenario, run inside a headless Thunderbird by
 * tests/e2e/account/run_account_test.py, in three phases (three launches
 * of Thunderbird on the same throw-away profile):
 *   1. on a fresh profile, Local Folders and the default outgoing server;
 *      then creation, update, the send route, archive and junk settings,
 *      refusals, passwords, files, removal of one account, refusal of a
 *      page other than the background page;
 *   2. after the restart: what was kept (marks, folders, identity, neutral
 *      outgoing server, settings, password), old neutral-server values
 *      planted by the runner, then removal of everything;
 *   3. the password functions with Thunderbird's Rust login store.
 *
 * Every check is printed as "SYNC443ACCOUNT-CHECK {label, ok, detail}";
 * "SYNC443ACCOUNT-INFO {...}" carries facts for the runner (paths on disk);
 * "SYNC443ACCOUNT-DONE {phase}" ends a phase.
 */

const api = browser.sync443Account;
const helper = browser.sync443AccountTest;
const EXT_ID = browser.runtime.id;

const M1 = "a1b2c3d4e5f6";
const M2 = "0123456789ab";
const M_UNMARKED = "fedcba987654";
const M_OTHER = "00000000beef";
const M_HALF = "111111111111";
const ORIGIN = "https://mail.example.com";
const ORIGIN_PORT = "https://mail.example.com:8443";
const KEEP = { origin: ORIGIN_PORT, username: "alice@example.com", password: "gardé après redémarrage ✓" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeJson = (value) =>
  JSON.stringify(value ?? null).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

let failures = 0;

async function emit(kind, value) {
  await helper.print(`SYNC443ACCOUNT-${kind} ${escapeJson(value)}`);
}

async function check(label, ok, detail) {
  if (!ok) failures++;
  await emit("CHECK", { label, ok: !!ok, detail: detail === undefined ? null : detail });
}

/**
 * The rejection message of a call, or null if it resolved. A function is
 * called here: the schema refuses a badly typed call synchronously.
 */
async function errorOf(call) {
  try {
    await (typeof call === "function" ? call() : call);
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

/** A value for a label: JSON, ASCII only (a bidirectional control stays escaped), cut to 40 characters. */
const shown = (value) => {
  const text = escapeJson(value);
  return text.length > 40 ? `${text.slice(0, 30)}\u2026 (${text.length} car.)` : text;
};
const hasCode = (message, code) => typeof message === "string" && message.startsWith(`${code}: `);

async function expectCode(label, promise, code) {
  const message = await errorOf(promise);
  await check(`${label} → ${code}`, hasCode(message, code), message);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (list) => [...list].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
const folder = (info, path) => info?.folders.find((f) => f.path === path) ?? null;
const holders = (info, use) => info.folders.filter((f) => f.uses.includes(use)).map((f) => f.path);
const neutralServers = (out) => out.servers.filter((s) => s.owner === EXT_ID);
/** 127.0.0.1, port 1, TLS (SSL = 3), no authentication (none = 1), no user name. */
const isSafeNeutral = (s) =>
  !!s && s.hostname === "127.0.0.1" && s.port === 1 && s.socketType === 3 && s.authMethod === 1 && s.username === "";

/**
 * Archive and junk settings of an account (identity: archive_granularity 0,
 * archive_keep_folder_structure false, archive_folder = archivesUri; server:
 * moveOnSpam false, stored and loaded): [ok, details].
 */
async function mailSettings(accountKey, archivesUri) {
  const info = await helper.inspect(accountKey);
  const identities = [];
  for (const identity of info.identities) identities.push(await helper.prefsOf(`mail.identity.${identity.key}.`));
  const server = await helper.prefsOf(`mail.server.${info.serverKey}.`);
  const ok =
    identities.length > 0 &&
    identities.every(
      (p) => p.archive_granularity === 0 && p.archive_keep_folder_structure === false && p.archive_folder === archivesUri,
    ) &&
    server.moveOnSpam === false &&
    info.moveOnSpamLoaded === false;
  const details = {
    identities: identities.map((p) => [p.archive_granularity, p.archive_keep_folder_structure, p.archive_folder]),
    moveOnSpam: server.moveOnSpam,
    loaded: info.moveOnSpamLoaded,
  };
  return [ok, details];
}

/** Polls `test` (async) until it is true or `ms` have passed; its last value. */
async function waitFor(test, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value || Date.now() > end) return value;
    await sleep(50);
  }
}

/** Does every identity of the account send through a marked neutral server with its safe values? */
async function routeClosed(accountKey) {
  const info = await helper.inspect(accountKey);
  const out = await helper.outgoing();
  return (
    !!info &&
    info.identities.length > 0 &&
    info.identities.every((i) => {
      const server = out.servers.find((s) => s.key === i.smtpServerKey);
      return server && server.owner === EXT_ID && isSafeNeutral(server) && i.effectiveSmtpKey === server.key;
    })
  );
}

// ── Phase 1 ─────────────────────────────────────────────────────────────

async function argumentChecks() {
  const ok = { mailboxId: M1, email: "alice@example.com", name: "Alice" };
  const badAccounts = [
    ["identifiant de boîte en majuscules", { ...ok, mailboxId: "A1B2C3D4E5F6" }],
    ["identifiant de boîte trop court", { ...ok, mailboxId: "a1b2c3" }],
    ["identifiant de boîte trop long", { ...ok, mailboxId: "a1b2c3d4e5f60" }],
    ["identifiant de boîte non hexadécimal", { ...ok, mailboxId: "a1b2c3d4e5fg" }],
    ["adresse sans @", { ...ok, email: "pas-une-adresse" }],
    ["adresse avec espace", { ...ok, email: "a b@example.com" }],
    ["adresse sans point dans le domaine", { ...ok, email: "alice@example" }],
    ["adresse avec deux @", { ...ok, email: "alice@@example.com" }],
    ["adresse entre chevrons", { ...ok, email: "<alice@example.com>" }],
    ["adresse avec saut de ligne", { ...ok, email: "alice@example.com\n" }],
    ["adresse avec caractère bidirectionnel", { ...ok, email: "ali\u202ece@example.com" }],
    ["adresse de 255 caractères", { ...ok, email: `${"a".repeat(64)}@${"b".repeat(186)}.com` }],
    ["nom vide", { ...ok, name: "" }],
    ["nom blanc", { ...ok, name: "   " }],
    ["nom avec caractère de contrôle", { ...ok, name: "a\u0007b" }],
    ["nom avec caractère bidirectionnel", { ...ok, name: "x\u202ey" }],
    ["nom avec caractère invisible", { ...ok, name: "x\u200by" }],
    ["nom de 257 caractères", { ...ok, name: "n".repeat(257) }],
    ["nom avec demi-paire de substitution", { ...ok, name: "x\ud800y" }],
    ["nom complet vide", { ...ok, fullName: "" }],
    ["nom complet avec saut de ligne", { ...ok, fullName: "a\nb" }],
    ["nom complet de 257 caractères", { ...ok, fullName: "f".repeat(257) }],
  ];
  for (const [what, options] of badAccounts) await expectCode(`ensureAccount, ${what}`, api.ensureAccount(options), "CONFIG");
  const schemaRefusal = await errorOf(() => api.ensureAccount({ mailboxId: "zz" }));
  await check("ensureAccount sans adresse ni nom : refusé dès le schéma", schemaRefusal !== null, schemaRefusal);
  const typeRefusal = await errorOf(() => api.removeAccount(42));
  await check("removeAccount(42) : type refusé dès le schéma", typeRefusal !== null, typeRefusal);

  for (const id of ["account1", "id", "id1x", "", "ID1", "id-1"]) {
    await expectCode(`accountOfIdentity(${shown(id)})`, api.accountOfIdentity(id), "CONFIG");
  }
  for (const key of ["id1", "account", "Account1", "../account1", "account1 ", ""]) {
    await expectCode(`removeAccount(${shown(key)})`, api.removeAccount(key), "CONFIG");
  }

  const badOrigins = [
    "http://mail.example.com",
    "https://Mail.example.com",
    "https://mail.example.com/",
    "https://mail.example.com/EWS",
    "https://mail.example.com:443",
    "https://mail.example.com:0",
    "https://mail.example.com:65536",
    "https://mail.example.com:08443",
    "https://mail.example.com:",
    "https://user@mail.example.com",
    "https://mail.example.com.",
    "https://mail_x.example.com",
    "https://127.1",
    "https://0x7f.0.0.1",
    "https://[::0001]",
    "https://[::ffff:127.0.0.1]",
    "https://[2001:DB8::1]",
    "https://2001:db8::1",
    " https://mail.example.com",
    "https://mail.example.com\n",
    "https://*.example.com",
    "https://",
    "mail.example.com",
  ];
  for (const origin of badOrigins) {
    await expectCode(`origine ${shown(origin)}`, api.getPassword(origin, "alice"), "CONFIG");
  }
  await expectCode("setPassword, origine non canonique", api.setPassword("https://mail.example.com:443", "alice", "x"), "CONFIG");
  await expectCode("removePassword, origine http", api.removePassword("http://mail.example.com", "alice"), "CONFIG");
  for (const [what, username] of [
    ["vide", ""],
    ["de 257 caractères", "u".repeat(257)],
    ["avec NUL", "a\u0000b"],
    ["avec tabulation", "a\tb"],
    ["avec saut de ligne", "a\nb"],
    ["avec caractère bidirectionnel", "a\u202eb"],
    ["avec demi-paire de substitution", "a\udc00b"],
  ]) {
    await expectCode(`identifiant ${what}`, api.setPassword(ORIGIN, username, "x"), "CONFIG");
  }
  for (const [what, password] of [
    ["vide", ""],
    ["de 1025 caractères", "p".repeat(1025)],
    ["avec NUL", "a\u0000b"],
    ["avec demi-paire de substitution", "a\ud800"],
  ]) {
    await expectCode(`mot de passe ${what}`, api.setPassword(ORIGIN, "alice", password), "CONFIG");
  }
  await check(
    "aucun mot de passe enregistré par les appels refusés",
    (await helper.rawLogins(ORIGIN)).length === 0 && (await helper.rawLogins("https://mail.example.com:443")).length === 0,
  );
}

/** Failures injected into Thunderbird: refusal before acting, undo after a failed creation. */
async function faultChecks() {
  const M_ROLLBACK = "bbbbbbbbbbbb";
  const want = { mailboxId: M_ROLLBACK, email: "rollback@example.com", name: "Rollback" };
  const accounts0 = await helper.accountKeys();
  const identities0 = await helper.identityKeys();
  const dir0 = await helper.mailDirEntries();
  if (await helper.stubOutgoing("missing")) {
    await expectCode("Thunderbird sans service des serveurs sortants : ensureAccount", api.ensureAccount(want), "UNSUPPORTED");
    await check("… rien n'est créé", same(await helper.accountKeys(), accounts0) && !(await helper.serverExists(M_ROLLBACK, "sync443.invalid")));
  } else {
    await emit("SKIP", { label: "service des serveurs sortants absent", detail: "remplacement impossible" });
  }
  if (await helper.stubOutgoing("failing")) {
    const message = await errorOf(api.ensureAccount(want));
    await check("création qui échoue en cours de route → INTERNAL, avec le seul nom de l'erreur de Thunderbird",
      hasCode(message, "INTERNAL") && message.includes("NS_ERROR_FAILURE") && !message.includes("simul"), message);
    await check("… tout est défait : ni compte, ni identité, ni serveur entrant",
      same(await helper.accountKeys(), accounts0) && same(await helper.identityKeys(), identities0) &&
        !(await helper.serverExists(M_ROLLBACK, "sync443.invalid")));
    await check("… ni fichiers dans <profil>/Mail", same(await helper.mailDirEntries(), dir0), await helper.mailDirEntries());
  } else {
    await emit("SKIP", { label: "annulation d'une création qui échoue", detail: "remplacement impossible" });
  }
  await helper.stubOutgoing("restore");
  const r = await api.ensureAccount(want);
  await check("après l'échec, la même boîte se crée normalement (rien ne bloque)", r.created === true, r);
  if (await helper.stubOutgoing("missing")) {
    await expectCode("Thunderbird sans service des serveurs sortants : removeAccount refusé avant d'agir", api.removeAccount(r.accountKey), "UNSUPPORTED");
    await helper.stubOutgoing("restore");
    await check("… le compte est toujours là", (await helper.inspect(r.accountKey))?.localPathExists === true);
  }
  await helper.stubOutgoing("restore");
  await check("removeAccount une fois le service rétabli", (await api.removeAccount(r.accountKey)) === true);
  await check("… plus de serveur neutre (aucune identité ne l'utilise)", neutralServers(await helper.outgoing()).length === 0);
}

/** Failures injected into the login manager: reported, never ignored; refusal before any write. */
async function loginFaultChecks() {
  if (await helper.breakLogins("locked")) {
    await expectCode("mot de passe principal non saisi : getPassword", api.getPassword(ORIGIN, "bob"), "LOCKED");
    await expectCode("mot de passe principal non saisi : setPassword", api.setPassword(ORIGIN, "bob", "x"), "LOCKED");
    await expectCode("mot de passe principal non saisi : removePassword ne l'ignore pas", api.removePassword(ORIGIN, "bob"), "LOCKED");
  } else {
    await emit("SKIP", { label: "gestionnaire de mots de passe verrouillé", detail: "remplacement impossible" });
  }
  await helper.breakLogins("restore");
  if (await helper.breakLogins("removeFails")) {
    await expectCode("suppression refusée par le gestionnaire : removePassword le signale", api.removePassword(ORIGIN, "bob"), "INTERNAL");
  } else {
    await emit("SKIP", { label: "suppression refusée par le gestionnaire", detail: "remplacement impossible" });
  }
  await helper.breakLogins("restore");
  if (await helper.breakLogins("noRemove")) {
    await expectCode("gestionnaire sans removeLoginAsync : removePassword", api.removePassword(ORIGIN, "bob"), "UNSUPPORTED");
    await expectCode("… setPassword refusé avant toute écriture", api.setPassword(ORIGIN, "dave", "x"), "UNSUPPORTED");
  } else {
    await emit("SKIP", { label: "gestionnaire sans removeLoginAsync", detail: "remplacement impossible" });
  }
  await helper.breakLogins("restore");
  if (await helper.breakLogins("noSearch")) {
    await expectCode("gestionnaire sans searchLoginsAsync : getPassword", api.getPassword(ORIGIN, "bob"), "UNSUPPORTED");
  } else {
    await emit("SKIP", { label: "gestionnaire sans searchLoginsAsync", detail: "remplacement impossible" });
  }
  await check("gestionnaire de mots de passe rétabli", await helper.breakLogins("restore"));
  await check("… le mot de passe de « bob » a survécu à ces échecs, rien n'a été écrit pour « dave »",
    (await api.getPassword(ORIGIN, "bob")) === "pw-bob" && (await api.getPassword(ORIGIN, "dave")) === null);
}

/** The send route: checkSendRoute, automatic repairs, the neutral server's safe values. */
async function sendRouteChecks(r1, r2, userSmtp) {
  await check("checkSendRoute() : tout est en ordre → false", (await api.checkSendRoute()) === false);
  await check("checkSendRoute(identité du compte) → false", (await api.checkSendRoute(r1.identityId)) === false);
  await expectCode("checkSendRoute d'un identifiant invalide", api.checkSendRoute("account1"), "CONFIG");
  await expectCode("checkSendRoute d'une identité inconnue (rien ne peut être garanti)", api.checkSendRoute("id987654"), "NOT_FOUND");

  // An identity added to the account by the user: no outgoing server chosen ("the default server").
  const alias = await helper.addIdentity(r1.accountKey, "alias@example.com");
  let info = await helper.inspect(r1.accountKey);
  const added = info.identities.find((i) => i.key === alias);
  await check("(identité ajoutée au compte par l'utilisateur : elle enverrait par le serveur par défaut)",
    !!added && added.effectiveSmtpKey === userSmtp, added);
  await check("checkSendRoute() la rattache au serveur neutre → true", (await api.checkSendRoute()) === true);
  await check("… route fermée pour toutes les identités du compte", await routeClosed(r1.accountKey));
  await check("… accountOfIdentity de la nouvelle identité", same(await api.accountOfIdentity(alias), { accountKey: r1.accountKey, mailboxId: M1 }));
  await check("checkSendRoute(nouvelle identité) → false", (await api.checkSendRoute(alias)) === false);

  // The neutral server's own preferences changed behind our back: repaired at
  // once, without any call (checkSendRoute's repair of old values is proven
  // in phase 2, where they were planted while Thunderbird was stopped).
  let neutral = neutralServers(await helper.outgoing())[0];
  const restored = async () => {
    const now = neutralServers(await helper.outgoing());
    return now.length === 1 && now[0].key === neutral.key && isSafeNeutral(now[0]);
  };
  await helper.editOutgoing(neutral.key, { hostname: "smtp.evil.example" });
  await check("hôte du serveur neutre changé en smtp.evil.example : rétabli aussitôt, sans appel à checkSendRoute",
    await waitFor(restored), neutralServers(await helper.outgoing()));
  await helper.editOutgoing(neutral.key, { hostname: "smtp.evil.example", port: 25, username: "victime", authMethod: 3, socketType: 0 });
  await check("valeurs du serveur neutre changées (smtp.evil.example:25, en clair, avec authentification) : rétablies aussitôt, même serveur",
    await waitFor(restored), neutralServers(await helper.outgoing()));
  for (const [what, values] of [
    ["port 25", { port: 25 }],
    ["sans TLS", { socketType: 0 }],
    ["mot de passe en clair", { authMethod: 3 }],
    ["avec un identifiant", { username: "victime" }],
    ["ancienne valeur sync443.invalid:465", { hostname: "sync443.invalid", port: 465 }],
  ]) {
    await helper.editOutgoing(neutral.key, values);
    await check(`serveur neutre ${what} : rétabli aussitôt`, await waitFor(restored), neutralServers(await helper.outgoing()));
  }
  await check("… checkSendRoute ensuite : rien à réparer → false", (await api.checkSendRoute()) === false);

  // Account Settings › Outgoing Server › Remove.
  await helper.removeOutgoingLikeSettings(neutral.key);
  await check("l'utilisateur supprime le serveur neutre (Paramètres › Serveur sortant) : refait et rattaché aussitôt",
    await waitFor(async () => (await routeClosed(r1.accountKey)) && (await routeClosed(r2.accountKey))),
    (await helper.inspect(r1.accountKey)).identities.map((i) => [i.key, i.smtpServerKey]));
  await check("… checkSendRoute ensuite → false", (await api.checkSendRoute()) === false);
  await check("… un seul serveur neutre", neutralServers(await helper.outgoing()).length === 1);

  // The neutral server deleted and its key given at once to a server of the user's.
  neutral = neutralServers(await helper.outgoing())[0];
  const reused = await helper.replaceOutgoing(neutral.key, "smtp.reused.example");
  await check("serveur neutre supprimé, sa clé reprise par un serveur de l'utilisateur : les identités n'y restent pas",
    await waitFor(async () => (await routeClosed(r1.accountKey)) && (await routeClosed(r2.accountKey))),
    { reused, sameKey: reused === neutral.key });
  const reusedServer = (await helper.outgoing()).servers.find((s) => s.key === reused);
  await check("… le serveur de l'utilisateur est intact et sans marque",
    reusedServer?.hostname === "smtp.reused.example" && reusedServer.owner === "", reusedServer);
  info = await helper.inspect(r1.accountKey);
  await check("… aucune identité de nos comptes ne l'utilise", !info.identities.some((i) => i.smtpServerKey === reused));
  await check("… checkSendRoute → false", (await api.checkSendRoute()) === false);
}

/** removeAccount deletes files only inside the profile's Mail folder, in a folder that is the account's own. */
async function fileChecks(lf) {
  const probe = await helper.probe();
  const cases = [
    ["un dossier hors du dossier Mail du profil", "d0d0d0d0d0d0", async () => helper.makeCanaryDir("hors-du-dossier-Mail")],
    ["le dossier de « Dossiers locaux »", "d1d1d1d1d1d1", async () => lf.localPath],
    ["le dossier Mail lui-même", "d2d2d2d2d2d2", async () => probe.mailDir],
  ];
  for (const [what, mailboxId, target] of cases) {
    const r = await api.ensureAccount({ mailboxId, email: "fichiers@example.com", name: "Fichiers" });
    const ownPath = (await helper.inspect(r.accountKey)).localPath;
    const path = await target();
    const before = await helper.dirEntries(path);
    const lfBefore = await helper.dirEntries(lf.localPath);
    await helper.setLocalPath(r.accountKey, path);
    await expectCode(`removeAccount, dossier du compte changé pour ${what} : compte supprimé sans ses fichiers`,
      api.removeAccount(r.accountKey), "FILES");
    await check(`… le compte est supprimé (${what})`, (await helper.inspect(r.accountKey)) === null && (await api.removeAccount(r.accountKey)) === false);
    await check(`… rien n'est effacé dans ${what}`, (await helper.exists(path)) && same(await helper.dirEntries(path), before),
      await helper.dirEntries(path));
    await check(`… « Dossiers locaux » intact (${what})`, same(await helper.dirEntries(lf.localPath), lfBefore));
    await check(`… l'ancien dossier du compte est resté aussi (${what})`, await helper.exists(ownPath), ownPath);
  }
}

async function inspectNewAccount(r, { email, name, fullName, mailboxId }, lf) {
  const info = await helper.inspect(r.accountKey);
  const out = await helper.outgoing();
  await check("compte créé : clé « accountN », identité « idN », created = true",
    /^account\d+$/.test(r.accountKey) && /^id\d+$/.test(r.identityId) && r.created === true, r);
  await check("marques : sync443.owner = identifiant de l'extension, sync443.mailbox = mailboxId",
    info?.marks.owner === EXT_ID && info?.marks.mailbox === mailboxId, info?.marks);
  await check("serveur entrant de type « none », hôte sync443.invalid, utilisateur = mailboxId",
    info?.type === "none" && info?.hostname === "sync443.invalid" && info?.username === mailboxId,
    [info?.type, info?.hostname, info?.username]);
  await check("nom du compte", info?.prettyName === name, info?.prettyName);
  const mailDir = (await helper.probe()).mailDir;
  await check("dossier du compte créé sur le disque, dans <profil>/Mail, distinct de « Dossiers locaux »",
    info?.localPathExists === true && info.localPath.startsWith(mailDir) && info.localPath !== lf.localPath,
    [info?.localPath, mailDir]);
  const expected = [["/Inbox", "inbox"], ["/Drafts", "drafts"], ["/Templates", "templates"], ["/Sent", "sent"], ["/Archives", "archives"], ["/Trash", "trash"]];
  for (const [path, use] of expected) {
    const f = folder(info, path);
    await check(`dossier par défaut ${path} avec l'usage « ${use} » et lui seul`, f && same(f.uses, [use]), f?.uses);
  }
  for (const use of ["inbox", "drafts", "templates", "sent", "archives", "trash"]) {
    await check(`un seul dossier « ${use} » dans le compte`, holders(info, use).length === 1, holders(info, use));
  }
  await emit("INFO", { defaultFolders: info?.folders.map((f) => [f.path, f.uses]) });
  const identity = info?.identities.find((i) => i.key === r.identityId);
  await check("une seule identité, celle renvoyée", info?.identities.length === 1 && !!identity, info?.identities.map((i) => i.key));
  await check("identité : adresse", identity?.email === email, identity?.email);
  await check("identité : nom complet", identity?.fullName === (fullName ?? ""), identity?.fullName);
  await check("identité : brouillons, envoyés, modèles, archives dans les dossiers du compte",
    identity?.draftsFolderURI === folder(info, "/Drafts")?.uri && identity?.fccFolderURI === folder(info, "/Sent")?.uri &&
      identity?.templatesFolderURI === folder(info, "/Templates")?.uri && identity?.archivesFolderURI === folder(info, "/Archives")?.uri,
    [identity?.draftsFolderURI, identity?.fccFolderURI, identity?.templatesFolderURI, identity?.archivesFolderURI]);
  const neutral = out.servers.find((s) => s.key === identity?.smtpServerKey);
  await check("serveur sortant de l'identité : le serveur neutre marqué, 127.0.0.1 port 1 (aucun nom à résoudre, port fermé)",
    !!neutral && neutral.owner === EXT_ID && isSafeNeutral(neutral), neutral);
  await check("serveur neutre : TLS (SSL), sans authentification ni identifiant",
    neutral?.socketType === 3 && neutral?.authMethod === 1 && neutral?.username === "", neutral);
  await check("Thunderbird choisirait ce serveur neutre pour cette identité", identity?.effectiveSmtpKey === neutral?.key,
    identity?.effectiveSmtpKey);
  const [settled, settings] = await mailSettings(r.accountKey, folder(info, "/Archives")?.uri);
  await check("archivage dans /Archives même (archive_granularity 0, archive_keep_folder_structure false, archive_folder), " +
    "indésirables jamais déplacés (moveOnSpam false, enregistré et chargé)", settled, settings);
  return { info, identity, neutral };
}

/**
 * A fresh profile: no "Local Folders", no outgoing server (Sync443 is the
 * only mail account). Thunderbird must never take our account for its Local
 * Folders, and our neutral server must not stay its default outgoing server.
 * Returns the user's outgoing server made on the way.
 */
async function freshProfileChecks() {
  const M0 = "c0c0c0c0c0c0";
  const M0B = "c1c1c1c1c1c1";
  const start = await helper.localFolders();
  await check("profil neuf : ni « Dossiers locaux », ni compte, ni serveur sortant",
    start.pref === "" && (await helper.accountKeys()).length === 0 && (await helper.outgoing()).servers.length === 0, start);
  await check("listAccounts sans compte de l'extension : rien n'est créé",
    (await api.listAccounts()).length === 0 && (await helper.localFolders()).pref === "" && (await helper.accountKeys()).length === 0);

  const r0 = await api.ensureAccount({ mailboxId: M0, email: "zero@example.com", name: "Zéro" });
  let lf = await helper.localFolders();
  const ours0 = await helper.inspect(r0.accountKey);
  await check("premier compte d'un profil sans « Dossiers locaux » : un vrai « Dossiers locaux » est créé d'abord",
    !!lf.server && lf.server.type === "none" && lf.server.hostname === "Local Folders" && lf.server.username === "nobody" &&
      lf.server.key !== ours0.serverKey && lf.server.marks.owner === "" && lf.server.accountKey !== r0.accountKey,
    lf);
  await check("… notre compte reste le nôtre (listAccounts, accountOfIdentity)",
    same(await api.listAccounts(), [{ accountKey: r0.accountKey, mailboxId: M0 }]) &&
      same(await api.accountOfIdentity(r0.identityId), { accountKey: r0.accountKey, mailboxId: M0 }));
  await check("… et Thunderbird lui-même (son accesseur, qui adopte un serveur « none » à défaut) désigne le vrai « Dossiers locaux »",
    (await helper.localFoldersViaGetter()) === lf.server.key, await helper.localFoldersViaGetter());
  await check("… ensureAccount à nouveau : le même compte (ni CONFLICT ni doublon)",
    (await api.ensureAccount({ mailboxId: M0, email: "zero@example.com", name: "Zéro" })).accountKey === r0.accountKey);

  // As Thunderbird's getter would have left it: the preference names our server.
  await helper.setLocalFoldersPref(ours0.serverKey);
  const listed = await api.listAccounts();
  lf = await helper.localFolders();
  await check("« Dossiers locaux » désignant notre compte : rétabli sur le vrai dès l'appel suivant, le compte reste le nôtre",
    same(listed, [{ accountKey: r0.accountKey, mailboxId: M0 }]) && lf.server?.hostname === "Local Folders" && lf.pref !== ours0.serverKey,
    [listed, lf.pref]);
  await helper.setLocalFoldersPref(ours0.serverKey);
  await check("… accountOfIdentity aussi (l'envoi reste fermé)",
    same(await api.accountOfIdentity(r0.identityId), { accountKey: r0.accountKey, mailboxId: M0 }) &&
      (await helper.localFolders()).server?.hostname === "Local Folders");

  // A preference naming a server that no longer exists: its key could be given to our next server.
  await helper.setLocalFoldersPref("server987");
  const r0b = await api.ensureAccount({ mailboxId: M0B, email: "zero.bis@example.com", name: "Zéro bis" });
  lf = await helper.localFolders();
  await check("« Dossiers locaux » désignant un serveur disparu : rétabli sur le vrai avant de créer le compte suivant",
    lf.server?.hostname === "Local Folders" && lf.server.key !== (await helper.inspect(r0b.accountKey)).serverKey &&
      (await api.listAccounts()).length === 2,
    lf);
  const accountsNow = await helper.accountKeys();
  await check("… un seul compte « Dossiers locaux » dans le profil (pas de doublon)",
    (await Promise.all(accountsNow.map((k) => helper.inspect(k)))).filter((i) => i?.hostname === "Local Folders").length === 1, accountsNow);

  // The neutral server is the profile's only outgoing server.
  let out = await helper.outgoing();
  await check("serveur neutre seul serveur sortant du profil : jamais désigné par défaut par l'extension",
    neutralServers(out).length === 1 && out.servers.length === 1 && out.defaultKey === "", out);
  const userSmtp = await helper.createUserSmtp("smtp.example.com", false);
  await check("un serveur de l'utilisateur ajouté (sans le désigner par défaut) : il devient le serveur par défaut, pas le neutre",
    await waitFor(async () => (await helper.outgoing()).defaultKey === userSmtp), (await helper.outgoing()).defaultKey);
  await check("… checkSendRoute : rien à réparer", (await api.checkSendRoute()) === false);
  await check("… Thunderbird envoie par défaut par le serveur de l'utilisateur", (await helper.effectiveDefaultSmtp()) === userSmtp);
  await helper.setDefaultSmtp(neutralServers(out)[0].key);
  await check("Thunderbird adopte le serveur neutre comme serveur par défaut : rendu aussitôt à celui de l'utilisateur",
    await waitFor(async () => (await helper.outgoing()).defaultKey === userSmtp), (await helper.outgoing()).defaultKey);

  for (const r of [r0, r0b]) await api.removeAccount(r.accountKey);
  out = await helper.outgoing();
  await check("comptes du profil neuf supprimés : plus de serveur neutre, celui de l'utilisateur reste par défaut",
    neutralServers(out).length === 0 && out.defaultKey === userSmtp && (await api.listAccounts()).length === 0, out);
  return userSmtp;
}

async function phase1() {
  const probe = await helper.probe();
  await emit("INFO", { probe });
  const userSmtp = await freshProfileChecks();
  const lf = await helper.ensureLocalFolders();
  await emit("INFO", { localFolders: lf, userSmtp });

  await argumentChecks();
  await faultChecks();

  // ── Creation
  const before = { accounts: await helper.accountKeys(), identities: await helper.identityKeys() };
  const want1 = { mailboxId: M1, email: "alice@example.com", name: "Alice (Sync443)", fullName: "Alice Martin" };
  const r1 = await api.ensureAccount(want1);
  const { info: info1, neutral } = await inspectNewAccount(r1, want1, lf);
  // What a new account sets in Thunderbird's preferences (identity, incoming server): for the record.
  await emit("INFO", {
    newAccountPrefs: {
      identity: await helper.prefsOf(`mail.identity.${r1.identityId}.`),
      server: await helper.prefsOf(`mail.server.${info1.serverKey}.`),
    },
  });
  let out = await helper.outgoing();
  await check("serveur sortant par défaut de l'utilisateur inchangé", out.defaultKey === userSmtp, out.defaultKey);

  // ── Idempotent re-ensure: update only
  const again = await api.ensureAccount({ mailboxId: M1, email: "alice.martin@example.com", name: "Alice", fullName: "Autre Nom" });
  let info = await helper.inspect(r1.accountKey);
  await check("ensureAccount à nouveau : même compte, même identité, created = false",
    again.accountKey === r1.accountKey && again.identityId === r1.identityId && again.created === false, again);
  await check("… aucun compte ni identité en plus",
    (await helper.accountKeys()).length === before.accounts.length + 1 && (await helper.identityKeys()).length === before.identities.length + 1);
  await check("… nom du compte mis à jour", info.prettyName === "Alice", info.prettyName);
  await check("… adresse mise à jour", info.identities[0].email === "alice.martin@example.com", info.identities[0].email);
  await check("… nom complet existant conservé", info.identities[0].fullName === "Alice Martin", info.identities[0].fullName);
  await check("… marques et dossiers inchangés", same(info.marks, info1.marks) && same(info.folders, info1.folders));

  await helper.setIdentity(r1.identityId, { fullName: "" });
  await api.ensureAccount({ mailboxId: M1, email: "alice.martin@example.com", name: "Alice", fullName: "Alice M." });
  info = await helper.inspect(r1.accountKey);
  await check("nom complet vide : renseigné par ensureAccount", info.identities[0].fullName === "Alice M.", info.identities[0].fullName);
  await api.ensureAccount({ mailboxId: M1, email: "alice.martin@example.com", name: "Alice" });
  info = await helper.inspect(r1.accountKey);
  await check("sans fullName : nom complet inchangé", info.identities[0].fullName === "Alice M.", info.identities[0].fullName);

  // ── Archive and junk settings changed (as the user might): put back
  const archivesUri = folder(info, "/Archives").uri;
  const breakSettings = async () => {
    await helper.setBranchPrefs(`mail.identity.${r1.identityId}.`, {
      archive_granularity: 2,
      archive_keep_folder_structure: true,
      archive_folder: folder(info, "/Inbox").uri,
    });
    await helper.setBranchPrefs(`mail.server.${info.serverKey}.`, { moveOnSpam: true });
    await helper.reloadSpamSettings(r1.accountKey);
    return !(await mailSettings(r1.accountKey, archivesUri))[0];
  };
  await check("(réglages d'archivage et d'indésirables changés : par mois, arborescence copiée, vers /Inbox, déplacement des indésirables)",
    await breakSettings());
  await api.ensureAccount({ mailboxId: M1, email: "alice.martin@example.com", name: "Alice" });
  let [settled, settings] = await mailSettings(r1.accountKey, archivesUri);
  await check("ensureAccount d'un compte existant rétablit l'archivage dans /Archives et moveOnSpam false", settled, settings);
  await check("(changés de nouveau)", await breakSettings());
  const routeAnswer = await api.checkSendRoute();
  [settled, settings] = await mailSettings(r1.accountKey, archivesUri);
  await check("checkSendRoute les rétablit aussi (sans les compter : la route n'avait rien → false)", settled && routeAnswer === false,
    [routeAnswer, settings]);

  // ── Closed sending restored (the user attaches the identity to their own outgoing server)
  await helper.setIdentity(r1.identityId, { smtpServerKey: userSmtp });
  await check("l'utilisateur rattache l'identité à son propre serveur sortant : rattachée de nouveau au serveur neutre, aussitôt",
    await waitFor(() => routeClosed(r1.accountKey)), (await helper.inspect(r1.accountKey)).identities[0]);
  await api.ensureAccount({ mailboxId: M1, email: "alice.martin@example.com", name: "Alice" });
  info = await helper.inspect(r1.accountKey);
  out = await helper.outgoing();
  await check("ensureAccount : identité sur le serveur neutre",
    info.identities[0].smtpServerKey === neutral.key && info.identities[0].effectiveSmtpKey === neutral.key, info.identities[0]);
  await check("… le serveur sortant de l'utilisateur est intact et reste celui par défaut",
    out.servers.some((s) => s.key === userSmtp && s.hostname === "smtp.example.com") && out.defaultKey === userSmtp);

  // ── Second mailbox, two concurrent calls
  const want2 = { mailboxId: M2, email: "bob@example.org", name: "Bob" };
  const [c1, c2] = await Promise.all([api.ensureAccount(want2), api.ensureAccount(want2)]);
  await check("deux ensureAccount simultanés pour une même boîte : un seul compte créé",
    c1.accountKey === c2.accountKey && c1.identityId === c2.identityId && [c1.created, c2.created].filter(Boolean).length === 1,
    [c1, c2]);
  const r2 = c1.created ? c1 : c2;
  const { info: info2 } = await inspectNewAccount(r2, want2, lf);
  await check("deuxième compte : dossier distinct du premier sur le disque", info2.localPath !== info1.localPath,
    [info1.localPath, info2.localPath]);
  out = await helper.outgoing();
  await check("un seul serveur neutre, partagé par les deux identités",
    neutralServers(out).length === 1 && info2.identities[0].smtpServerKey === neutral.key, neutralServers(out));

  // ── listAccounts, accountOfIdentity
  let list = await api.listAccounts();
  await check("listAccounts : les deux comptes de l'extension",
    same(sorted(list), sorted([{ accountKey: r1.accountKey, mailboxId: M1 }, { accountKey: r2.accountKey, mailboxId: M2 }])), list);
  await check("accountOfIdentity (premier compte)", same(await api.accountOfIdentity(r1.identityId), { accountKey: r1.accountKey, mailboxId: M1 }));
  await check("accountOfIdentity (deuxième compte)", same(await api.accountOfIdentity(r2.identityId), { accountKey: r2.accountKey, mailboxId: M2 }));
  const identitiesBefore = await helper.identityKeys();
  await check("accountOfIdentity d'une identité inconnue → null", (await api.accountOfIdentity("id987654")) === null);
  await check("… sans créer d'identité au passage", same(await helper.identityKeys(), identitiesBefore));

  await sendRouteChecks(r1, r2, userSmtp);

  // ── Accounts that are not ours
  const foreign = {
    unmarked: await helper.createForeignAccount({ username: M_UNMARKED, hostname: "sync443.invalid" }),
    otherExtension: await helper.createForeignAccount({ username: M_OTHER, hostname: "sync443.invalid", owner: "autre@extension.test", mailbox: M_OTHER }),
    otherHost: await helper.createForeignAccount({ username: "nobody", hostname: "autre.invalid" }),
    mismatched: await helper.createForeignAccount({ username: M_HALF, hostname: "sync443.invalid", owner: EXT_ID, mailbox: "222222222222" }),
  };
  await emit("INFO", { foreign });
  const accountsBefore = await helper.accountKeys();
  for (const [what, mailboxId] of [["sans marque", M_UNMARKED], ["marqué par une autre extension", M_OTHER], ["aux marques incohérentes", M_HALF]]) {
    await expectCode(`ensureAccount ne reprend jamais un serveur existant ${what}`,
      api.ensureAccount({ mailboxId, email: "x@example.com", name: "X" }), "CONFLICT");
  }
  await check("… et ne crée rien", same(await helper.accountKeys(), accountsBefore));
  const labels = {
    unmarked: "compte « none » sans marque (même hôte sync443.invalid)",
    otherExtension: "compte marqué par une autre extension",
    otherHost: "compte « none » d'un autre hôte",
    mismatched: "compte à notre marque mais mailbox ≠ utilisateur",
  };
  for (const [name, f] of Object.entries(foreign)) {
    const snapshot = await helper.inspect(f.accountKey);
    await expectCode(`${labels[name]} : removeAccount`, api.removeAccount(f.accountKey), "PERMISSION");
    await check(`${labels[name]} : accountOfIdentity → null`, (await api.accountOfIdentity(f.identityId)) === null);
    const after = await helper.inspect(f.accountKey);
    await check(`${labels[name]} : intact (marques, dossiers, fichiers)`,
      !!after && same(after.marks, snapshot.marks) && same(after.folders, snapshot.folders) && after.localPathExists === true);
  }
  list = await api.listAccounts();
  await check("listAccounts : toujours les deux seuls comptes de l'extension", list.length === 2 && list.every((a) => [M1, M2].includes(a.mailboxId)), list);

  // ── Local Folders, always refused
  await expectCode("« Dossiers locaux » : removeAccount", api.removeAccount(lf.accountKey), "PERMISSION");
  await helper.setMarks(lf.accountKey, EXT_ID, M1);
  await expectCode("« Dossiers locaux » portant nos marques : removeAccount quand même refusé", api.removeAccount(lf.accountKey), "PERMISSION");
  list = await api.listAccounts();
  await check("« Dossiers locaux » portant nos marques : absent de listAccounts", !list.some((a) => a.accountKey === lf.accountKey), list);
  await helper.setMarks(lf.accountKey, null, null);
  await check("« Dossiers locaux » toujours là, avec ses fichiers", (await helper.inspect(lf.accountKey))?.localPathExists === true);

  // ── Unknown accounts
  await check("removeAccount d'une clé inconnue → false", (await api.removeAccount("account987654")) === false);

  // ── Folders of the user's in the account: kept across the restart, never carried over to a new account
  await helper.createFolder(r1.accountKey, "/", "Projets");
  await helper.createFolder(r1.accountKey, "/Projets", "2026");
  await check("(dossiers de l'utilisateur créés dans le compte : /Projets/2026)", !!folder(await helper.inspect(r1.accountKey), "/Projets/2026"));

  // ── Passwords
  await check("getPassword sans mot de passe enregistré → null", (await api.getPassword(ORIGIN, "alice@example.com")) === null);
  const pw1 = "s3crèt ✓ avec\nligne et \"guillemets\"";
  await api.setPassword(ORIGIN, "alice@example.com", pw1);
  await check("setPassword puis getPassword : même valeur (accents, saut de ligne)", (await api.getPassword(ORIGIN, "alice@example.com")) === pw1);
  let raw = await helper.rawLogins(ORIGIN);
  await check("une entrée du gestionnaire : origine exacte, domaine « Sync443 », pas un formulaire",
    raw.length === 1 && raw[0].origin === ORIGIN && raw[0].httpRealm === "Sync443" && raw[0].formActionOrigin === null &&
      raw[0].username === "alice@example.com",
    raw.map((l) => [l.origin, l.httpRealm, l.formActionOrigin, l.username]));
  await api.setPassword(ORIGIN, "alice@example.com", "nouveau");
  raw = await helper.rawLogins(ORIGIN);
  await check("setPassword à nouveau : valeur remplacée, toujours une seule entrée",
    (await api.getPassword(ORIGIN, "alice@example.com")) === "nouveau" && raw.length === 1, raw.length);
  await api.setPassword(ORIGIN, "alice@example.com", "nouveau");
  await check("setPassword de la même valeur : toujours une seule entrée", (await helper.rawLogins(ORIGIN)).length === 1);
  await api.setPassword(ORIGIN, "bob", "pw-bob");
  await check("autre identifiant, même origine : mots de passe distincts",
    (await api.getPassword(ORIGIN, "bob")) === "pw-bob" && (await api.getPassword(ORIGIN, "alice@example.com")) === "nouveau");
  await check("identifiant à la casse près : rien", (await api.getPassword(ORIGIN, "Alice@example.com")) === null);
  await check("même hôte, autre port : rien", (await api.getPassword(ORIGIN_PORT, "bob")) === null);
  await api.setPassword(KEEP.origin, KEEP.username, KEEP.password);
  await check("origine avec port : enregistrée à part", (await api.getPassword(KEEP.origin, KEEP.username)) === KEEP.password);
  for (const origin of ["https://[2001:db8::1]:8443", "https://192.0.2.10", "https://xn--bcher-kva.example"]) {
    await api.setPassword(origin, "u", "p");
    const back = await api.getPassword(origin, "u");
    await api.removePassword(origin, "u");
    await check(`origine ${origin} acceptée (aller-retour puis suppression)`, back === "p" && (await api.getPassword(origin, "u")) === null);
  }
  const longUser = "u".repeat(256);
  const longPassword = "p".repeat(1023) + "é";
  await api.setPassword(ORIGIN, longUser, longPassword);
  await check("identifiant de 256 caractères, mot de passe de 1024 caractères acceptés", (await api.getPassword(ORIGIN, longUser)) === longPassword);
  await api.removePassword(ORIGIN, longUser);

  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => api.setPassword(ORIGIN, "carol", `valeur-${n}`).then(() => n)));
  raw = (await helper.rawLogins(ORIGIN)).filter((l) => l.username === "carol");
  await check("cinq setPassword simultanés : une seule entrée, la dernière valeur",
    results.length === 5 && raw.length === 1 && raw[0].password === "valeur-5", raw.map((l) => l.password));
  await api.removePassword(ORIGIN, "carol");

  await helper.addForeignLogin(ORIGIN, "alice@example.com", "mot-de-passe-d-un-autre", "Autre domaine", null);
  await helper.addForeignLogin(ORIGIN, "alice@example.com", "mot-de-passe-de-formulaire", null, ORIGIN);
  await check("une entrée d'un autre domaine ou d'un formulaire n'est jamais lue",
    (await api.getPassword(ORIGIN, "alice@example.com")) === "nouveau");
  await api.removePassword(ORIGIN, "alice@example.com");
  raw = await helper.rawLogins(ORIGIN);
  await check("removePassword : notre entrée supprimée", (await api.getPassword(ORIGIN, "alice@example.com")) === null);
  await check("… les entrées étrangères pour la même origine et le même identifiant restent",
    raw.filter((l) => l.username === "alice@example.com").length === 2 && !raw.some((l) => l.httpRealm === "Sync443" && l.username === "alice@example.com"),
    raw.map((l) => [l.httpRealm, l.formActionOrigin, l.username]));
  await check("… celle de « bob » aussi", (await api.getPassword(ORIGIN, "bob")) === "pw-bob");
  await check("removePassword sans entrée : résolu sans erreur", (await errorOf(api.removePassword(ORIGIN, "personne"))) === null);
  await loginFaultChecks();
  await api.removePassword(ORIGIN, "bob");

  // ── Only the background page
  const answer = new Promise((resolve) => {
    browser.runtime.onMessage.addListener((message) => {
      if (message?.viewTest) resolve(message.viewTest);
    });
  });
  let page = null;
  let tabError = null;
  try {
    const tab = await browser.tabs.create({
      url: `page.html?accountKey=${encodeURIComponent(r1.accountKey)}&identityId=${encodeURIComponent(r1.identityId)}`,
    });
    page = await Promise.race([answer, sleep(10000).then(() => null)]);
    await browser.tabs.remove(tab.id).catch(() => {});
  } catch (e) {
    tabError = String(e?.message ?? e);
  }
  if (page) {
    for (const [name, message] of Object.entries(page)) {
      await check(`page autre que l'arrière-plan : ${name} → PERMISSION`, hasCode(message, "PERMISSION"), message);
    }
    await check("… la page n'a rien changé", (await api.getPassword(ORIGIN_PORT, "alice")) === null && (await api.listAccounts()).length === 2);
  } else {
    await emit("SKIP", { label: "page autre que l'arrière-plan refusée", detail: tabError ?? "onglet sans réponse" });
  }

  await fileChecks(lf);

  // ── Removal of the second account
  // The neutral server in use now (it was made again during sendRouteChecks).
  const neutralKey = neutralServers(await helper.outgoing())[0]?.key;
  const r2Path = info2.localPath;
  await check("removeAccount du deuxième compte → true", (await api.removeAccount(r2.accountKey)) === true);
  await check("… compte disparu", (await helper.inspect(r2.accountKey)) === null);
  await check("… son identité aussi", !(await helper.identityKeys()).includes(r2.identityId));
  await check("… ses fichiers aussi", (await helper.exists(r2Path)) === false, r2Path);
  out = await helper.outgoing();
  await check("… le serveur neutre reste : le premier compte l'utilise", neutralServers(out).length === 1 && neutralServers(out)[0].key === neutralKey);
  list = await api.listAccounts();
  await check("… listAccounts : le premier compte seul", same(list, [{ accountKey: r1.accountKey, mailboxId: M1 }]), list);
  await check("… accountOfIdentity de l'identité supprimée → null", (await api.accountOfIdentity(r2.identityId)) === null);
  await check("removeAccount du même compte une seconde fois → false", (await api.removeAccount(r2.accountKey)) === false);
  await check("le premier compte et ses fichiers sont intacts", (await helper.inspect(r1.accountKey))?.localPathExists === true);

  const state = {
    r1,
    neutralKey,
    userSmtp,
    lf,
    foreign,
    r1Path: info1.localPath,
    r2Path,
    folders: (await helper.inspect(r1.accountKey)).folders,
  };
  await browser.storage.local.set({ phase1: state });
  await emit("INFO", { neutralKey });
  await emit("INFO", { paths: { r1: info1.localPath, r2: r2Path, localFolders: lf.localPath, foreign: Object.values(foreign).map((f) => f.localPath) } });
}

// ── Phase 2, after Thunderbird restarted ────────────────────────────────

async function phase2() {
  const { phase1: s } = await browser.storage.local.get("phase1");
  await check("état de la première phase retrouvé", !!s?.r1);
  const list = await api.listAccounts();
  await check("après redémarrage : listAccounts retrouve le compte par ses marques",
    same(list, [{ accountKey: s.r1.accountKey, mailboxId: M1 }]), list);
  const info = await helper.inspect(s.r1.accountKey);
  await check("… marques conservées", info?.marks.owner === EXT_ID && info?.marks.mailbox === M1, info?.marks);
  await check("… nom, adresse, nom complet conservés",
    info?.prettyName === "Alice" && info?.identities[0].email === "alice.martin@example.com" && info?.identities[0].fullName === "Alice M.");
  await check("… identité toujours rattachée au serveur neutre",
    info?.identities[0].smtpServerKey === s.neutralKey && info?.identities[0].effectiveSmtpKey === s.neutralKey, info?.identities[0]);
  // The neutral server's values of its first design, planted in prefs.js by the runner while Thunderbird was stopped (no notification).
  const out0 = await helper.outgoing();
  const planted = neutralServers(out0)[0];
  await check("… serveur neutre toujours marqué ; anciennes valeurs plantées hors de Thunderbird bien là (sync443.invalid:465)",
    neutralServers(out0).length === 1 && planted.key === s.neutralKey && planted.hostname === "sync443.invalid" && planted.port === 465,
    neutralServers(out0));
  const migrated = await api.checkSendRoute();
  const out1 = await helper.outgoing();
  await check("… checkSendRoute le passe à 127.0.0.1 port 1, TLS, sans authentification → true",
    migrated === true && neutralServers(out1).length === 1 && neutralServers(out1)[0].key === s.neutralKey && isSafeNeutral(neutralServers(out1)[0]),
    [migrated, neutralServers(out1)]);
  for (const [path, use] of [["/Inbox", "inbox"], ["/Drafts", "drafts"], ["/Sent", "sent"], ["/Archives", "archives"], ["/Trash", "trash"]]) {
    await check(`… usage « ${use} » de ${path} conservé`, folder(info, path)?.uses.includes(use), folder(info, path)?.uses);
  }
  await check("… dossiers de l'utilisateur conservés (/Projets/2026)", !!folder(info, "/Projets/2026"));
  await check("… accountOfIdentity", same(await api.accountOfIdentity(s.r1.identityId), { accountKey: s.r1.accountKey, mailboxId: M1 }));
  const [settled, settings] = await mailSettings(s.r1.accountKey, folder(info, "/Archives")?.uri);
  await check("… réglages d'archivage et d'indésirables conservés", settled, settings);
  await check("… mot de passe conservé", (await api.getPassword(KEEP.origin, KEEP.username)) === KEEP.password);
  await expectCode("… un compte sans marque est toujours refusé", api.removeAccount(s.foreign.unmarked.accountKey), "PERMISSION");
  await expectCode("… « Dossiers locaux » toujours refusé", api.removeAccount(s.lf.accountKey), "PERMISSION");

  // Removal of the last account.
  await check("removeAccount du dernier compte → true", (await api.removeAccount(s.r1.accountKey)) === true);
  const out = await helper.outgoing();
  await check("… le serveur neutre, plus utilisé, est supprimé", neutralServers(out).length === 0, neutralServers(out));
  await check("… le serveur sortant de l'utilisateur reste, et reste celui par défaut",
    out.servers.some((s2) => s2.key === s.userSmtp) && out.defaultKey === s.userSmtp, out);
  await check("… fichiers du compte supprimés", (await helper.exists(s.r1Path)) === false, s.r1Path);
  await check("… identité supprimée", !(await helper.identityKeys()).includes(s.r1.identityId));
  await check("… listAccounts vide", (await api.listAccounts()).length === 0);
  for (const [name, f] of Object.entries(s.foreign)) {
    await check(`… compte étranger « ${name} » intact`, (await helper.inspect(f.accountKey))?.localPathExists === true);
  }

  // A new account after that: a new neutral server, removed with it.
  const again = await api.ensureAccount({ mailboxId: M1, email: "alice@example.com", name: "Alice bis" });
  const infoAgain = await helper.inspect(again.accountKey);
  const out2 = await helper.outgoing();
  await check("nouvel ensureAccount pour la même boîte : compte neuf, nouveau serveur neutre",
    again.created === true && again.accountKey !== s.r1.accountKey && neutralServers(out2).length === 1 &&
      infoAgain.identities[0].smtpServerKey === neutralServers(out2)[0].key,
    again);
  await check("… rien de l'ancien compte n'est repris (dossiers d'un compte neuf seulement)",
    !infoAgain.folders.some((f) => f.path.startsWith("/Projets")), infoAgain.folders.map((f) => f.path));
  // As if Thunderbird had made the neutral server its default (it does so when it is the only one).
  await helper.setDefaultSmtp(neutralServers(out2)[0].key);
  await check("… removeAccount", (await api.removeAccount(again.accountKey)) === true);
  await check("… serveur neutre de nouveau supprimé", neutralServers(await helper.outgoing()).length === 0);
  const effectiveDefault = await helper.effectiveDefaultSmtp();
  await check("… s'il était le serveur sortant par défaut, Thunderbird en reprend un autre (celui de l'utilisateur)",
    effectiveDefault === s.userSmtp && (await helper.outgoing()).defaultKey === s.userSmtp, effectiveDefault);
  await check("… fichiers supprimés", (await helper.exists(infoAgain.localPath)) === false, infoAgain.localPath);

  await api.removePassword(KEEP.origin, KEEP.username);
  await check("removePassword : supprimé", (await api.getPassword(KEEP.origin, KEEP.username)) === null);
  await emit("INFO", { paths2: { again: infoAgain.localPath } });
}

// ── Phase 3: passwords again, with Thunderbird's other login store ───────

async function phase3() {
  const probe = await helper.probe();
  await emit("INFO", { probe3: probe });
  if (!probe.rustLogins) {
    await emit("SKIP", { label: "mots de passe avec le stockage Rust de Thunderbird", detail: "stockage Rust non activé par Thunderbird" });
    return;
  }
  await check("stockage Rust des mots de passe actif (logins.json migré)", true);
  let raw = await helper.rawLogins(ORIGIN);
  await check("… les entrées étrangères sont là", raw.length === 2 && !raw.some((l) => l.httpRealm === "Sync443"),
    raw.map((l) => [l.httpRealm, l.formActionOrigin]));
  await check("getPassword sans entrée → null", (await api.getPassword(ORIGIN, "alice@example.com")) === null);
  await api.setPassword(ORIGIN, "alice@example.com", "rust-1 \u00e9");
  await check("setPassword puis getPassword", (await api.getPassword(ORIGIN, "alice@example.com")) === "rust-1 \u00e9");
  await api.setPassword(ORIGIN, "alice@example.com", "rust-2");
  raw = (await helper.rawLogins(ORIGIN)).filter((l) => l.httpRealm === "Sync443");
  await check("setPassword à nouveau : remplacé, une seule entrée « Sync443 »",
    (await api.getPassword(ORIGIN, "alice@example.com")) === "rust-2" && raw.length === 1 && raw[0].formActionOrigin === null, raw.length);
  await Promise.all([1, 2, 3].map((n) => api.setPassword(ORIGIN, "carol", `r${n}`)));
  raw = (await helper.rawLogins(ORIGIN)).filter((l) => l.username === "carol");
  await check("trois setPassword simultanés : une entrée, la dernière valeur", raw.length === 1 && raw[0].password === "r3", raw.length);
  await api.removePassword(ORIGIN, "carol");
  await api.removePassword(ORIGIN, "alice@example.com");
  raw = await helper.rawLogins(ORIGIN);
  await check("removePassword : nos entrées supprimées, les étrangères restent",
    (await api.getPassword(ORIGIN, "alice@example.com")) === null && raw.length === 2 && !raw.some((l) => l.httpRealm === "Sync443"),
    raw.map((l) => [l.httpRealm, l.username]));
}

async function run() {
  const phase = await helper.phase();
  try {
    if (phase === 1) await phase1();
    else if (phase === 2) await phase2();
    else await phase3();
  } catch (e) {
    await emit("CRASH", { phase, error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
  await emit("DONE", { phase, failures });
  await helper.quit();
}

run().catch(async (e) => {
  await emit("CRASH", { error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  await helper.quit();
});
