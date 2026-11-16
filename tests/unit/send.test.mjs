// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * src/send.mjs: fail-closed sending. Thunderbird (compose, messages, tabs),
 * the privileged account lookup and the ActiveSync client are doubles that
 * record every call. Addresses are from the reserved example.com domain.
 */

import { test, eq, assert } from "./harness.mjs";
import { installSendHandler, topContentType, protectionAsked, sendTimeout, MAX_MESSAGE_BYTES } from "../../src/send.mjs";
import { el, text, at, child } from "../../src/core/wbxml.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { CATALOGS, render, withLanguage } from "./i18n-fake.mjs";

const MAILBOX = "0123456789ab";
const ACCOUNT = "account7";
const OURS = "id3";
const OTHER = "id1";
const SUBJECT = "Rendez-vous secret";
const CLEAR = Object.freeze({ name: "OpenPGP", encryptBody: false, encryptSubject: false, signMessage: false });

const DRAFT = [
  "X-Mozilla-Status: 0001",
  "X-Mozilla-Status2: 00000000",
  "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0",
  "Fcc: mailbox://nobody@Local%20Folders/Sent",
  "From: Alice <alice@example.com>",
  "To: bob@example.com",
  `Subject: ${SUBJECT}`,
  "Message-ID: <draft-1@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Bonjour Bob.",
  "",
].join("\r\n");

const fileOf = (bytes) => ({ size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });

function setup(o = {}) {
  const calls = [];
  const notes = [];
  const logs = [];
  const state = {
    saveFails: o.saveFails ?? 0,
    saveResult: "saveResult" in o ? o.saveResult : { mode: "draft", messages: [{ id: 77 }] },
    raw: "raw" in o ? o.raw : fileOf(encodeUtf8(DRAFT)),
    deleteFails: o.deleteFails ?? false,
    removeFails: o.removeFails ?? false,
    response: o.response ?? null,
    commandError: o.commandError ?? null,
    gate: o.gate ?? null,
    // What compose.getComposeDetails tells after the draft is saved.
    current: o.current ?? null,
    header: "header" in o ? o.header : undefined,
  };
  let listener = null;
  let counter = 0;
  const browser = {
    compose: {
      onBeforeSend: {
        addListener: (fn) => {
          listener = fn;
        },
        removeListener: (fn) => {
          if (listener === fn) listener = null;
        },
      },
      async getComposeDetails(tabId) {
        calls.push(["getComposeDetails", tabId]);
        if (state.current instanceof Error) throw state.current;
        return state.current ?? { identityId: OURS, selectedEncryptionTechnology: CLEAR };
      },
      async saveMessage(tabId, options) {
        calls.push(["saveMessage", tabId, options]);
        if (state.saveFails-- > 0) throw new Error("Window is busy");
        return state.saveResult;
      },
    },
    messages: {
      async get(id) {
        calls.push(["messages.get", id]);
        if (state.header instanceof Error) throw state.header;
        return state.header !== undefined ? state.header : { id, folder: { accountId: ACCOUNT, path: "/Drafts", type: "drafts" } };
      },
      async getRaw(id, options) {
        calls.push(["getRaw", id, options]);
        return state.raw;
      },
      async delete(ids, option) {
        calls.push(["delete", ids, option]);
        if (state.deleteFails) throw new Error("no message");
      },
    },
    tabs: {
      async remove(id) {
        calls.push(["tabs.remove", id]);
        if (state.removeFails) throw new Error("no tab");
      },
    },
  };
  const client = {
    async command(cmd, root, options) {
      calls.push(["command", cmd, root, options]);
      if (state.gate) await state.gate;
      if (state.commandError) throw state.commandError;
      return state.response;
    },
  };
  const handler = installSendHandler({
    browser,
    accountOfIdentity:
      o.accountOfIdentity ??
      (async (identityId) => {
        calls.push(["accountOfIdentity", identityId]);
        if (o.ownerGate) await o.ownerGate;
        return identityId === OURS ? { accountKey: ACCOUNT, mailboxId: MAILBOX } : null;
      }),
    checkSendRoute: o.checkSendRoute,
    clientFor:
      o.clientFor ??
      (async (id) => {
        calls.push(["clientFor", id]);
        return client;
      }),
    afterSend:
      o.afterSend ??
      ((id) => {
        calls.push(["afterSend", id]);
      }),
    log: {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
      error: (m) => logs.push(["error", m]),
    },
    notify: o.notify ?? ((m) => notes.push(m)),
    random: (n) => Uint8Array.from({ length: n }, (_, i) => (i + counter++) & 0xff),
    delay: async () => {},
  });
  const fire = (tab, details) => listener(tab, details);
  const send = (tabId = 5, identityId = OURS, technology = CLEAR) =>
    fire({ id: tabId, windowId: 9, type: "messageCompose" }, { identityId, subject: SUBJECT, selectedEncryptionTechnology: technology });
  const names = () => calls.map((c) => c[0]);
  const sent = () => calls.filter((c) => c[0] === "command");
  return { calls, notes, logs, handler, fire, send, names, sent, state, hasListener: () => listener !== null };
}

const mimeOf = (call) => decodeUtf8(at(call[2], "Mime").value);

test("envoi : identité d'un autre compte, Thunderbird envoie lui-même", async () => {
  const t = setup();
  eq(await t.send(5, OTHER), {});
  await t.handler.idle();
  eq(t.names(), ["accountOfIdentity"]);
  eq(t.notes, []);
});

test("envoi : identité d'un compte marqué, envoi de Thunderbird annulé, SendMail, brouillon supprimé, fenêtre fermée", async () => {
  const t = setup();
  eq(await t.send(5), { cancel: true });
  await t.handler.idle();
  eq(t.names(), ["accountOfIdentity", "saveMessage", "getComposeDetails", "messages.get", "getRaw", "clientFor", "command", "delete", "tabs.remove", "afterSend"]);
  eq(t.calls[1], ["saveMessage", 5, { mode: "draft" }]);
  eq(t.calls[2], ["getComposeDetails", 5]);
  eq(t.calls[3], ["messages.get", 77]);
  eq(t.calls[4], ["getRaw", 77, { data_format: "File" }]);
  eq(t.calls[5], ["clientFor", MAILBOX]);
  const [, cmd, root, options] = t.calls[6];
  eq(cmd, "SendMail");
  eq([root.ns, root.tag], ["ComposeMail", "SendMail"]);
  assert(/^[0-9a-f]{32}$/.test(text(root, "ClientId")), "ClientId de 32 chiffres hexadécimaux");
  assert(child(root, "SaveInSentItems") !== null, "copie dans les Envoyés du serveur");
  const mime = mimeOf(t.calls[6]);
  assert(!/X-Mozilla-/i.test(mime) && !/^Fcc:/im.test(mime), "en-têtes internes retirés");
  assert(mime.includes(`Subject: ${SUBJECT}`) && mime.includes("Bonjour Bob."), "message intact");
  eq(options.maxBytes, 64 * 1024);
  eq(options.timeoutMs, sendTimeout(at(root, "Mime").value.length));
  eq(t.calls[7], ["delete", [77], { deletePermanently: true }]);
  eq(t.calls[8], ["tabs.remove", 5]);
  eq(t.calls[9], ["afterSend", MAILBOX]);
  eq(t.notes, []);
  eq(t.logs, [["info", "Message envoyé."]]);
  eq(t.handler.isSending(5), false);
});

test("envoi : réponse non vide avec Status 1, succès", async () => {
  const t = setup({ response: el("ComposeMail:SendMail", [el("Status", "1")]) });
  await t.send();
  await t.handler.idle();
  assert(t.names().includes("tabs.remove"));
  eq(t.notes, []);
});

test("envoi : un ClientId neuf à chaque essai", async () => {
  const t = setup();
  await t.send(5);
  await t.handler.idle();
  await t.send(6);
  await t.handler.idle();
  const [a, b] = t.sent().map((c) => text(c[2], "ClientId"));
  assert(a !== b, "ClientId différents");
});

test("envoi fermé : compte impossible à déterminer, annulé et signalé", async () => {
  const cases = [
    async () => {
      throw new Error("NOT_READY: experiment");
    },
    async () => undefined,
    async () => ({ mailboxId: "../autre" }),
    async () => ({ mailboxId: MAILBOX }),
    async () => ({ mailboxId: MAILBOX, accountKey: "account7; x" }),
    async () => ({}),
    async () => "0123456789ab",
  ];
  for (const accountOfIdentity of cases) {
    const t = setup({ accountOfIdentity });
    eq(await t.send(5), { cancel: true });
    await t.handler.idle();
    eq(t.names(), [], "rien d'autre");
    eq(t.notes.length, 1);
    assert(t.notes[0].startsWith("Message non envoyé :"), t.notes[0]);
    eq(t.logs, [["error", "Envoi annulé : compte d'envoi impossible à vérifier."]]);
  }
});

test("envoi fermé : identité ou onglet absent, annulé sans consulter les comptes", async () => {
  const cases = [
    [{ id: 5 }, {}],
    [{ id: 5 }, { identityId: "" }],
    [{ id: 5 }, { identityId: 3 }],
    [{ id: 5 }, null],
  ];
  for (const [tab, details] of cases) {
    const t = setup();
    eq(await t.fire(tab, details), { cancel: true }, JSON.stringify(details));
    await t.handler.idle();
    eq(t.names(), [], "comptes non consultés");
    eq(t.notes.length, 1);
  }
  for (const tab of [{}, null, { id: "5" }]) {
    const t = setup();
    eq(await t.fire(tab, { identityId: OURS }), { cancel: true }, JSON.stringify(tab));
    await t.handler.idle();
    eq(t.names(), ["accountOfIdentity"], "rien d'autre");
    eq(t.handler.isSending(5), false);
    eq(t.notes.length, 1);
  }
});

test("envoi : deuxième clic pendant l'envoi ignoré, avec une notification", async () => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const t = setup({ gate });
  eq(await t.send(5), { cancel: true });
  // Let the first send reach SendMail.
  for (let i = 0; i < 20 && !t.sent().length; i++) await null;
  eq(t.sent().length, 1);
  eq(t.handler.isSending(5), true);
  eq(await t.send(5), { cancel: true });
  eq(t.notes, ["Ce message est déjà en cours d'envoi."]);
  open();
  await t.handler.idle();
  eq(t.sent().length, 1, "un seul SendMail");
  eq(t.names().filter((n) => n === "saveMessage").length, 1);
  eq(t.handler.isSending(5), false);
});

test("envoi : deux fenêtres différentes envoient chacune", async () => {
  const t = setup();
  await t.send(5);
  await t.send(6);
  await t.handler.idle();
  eq(t.sent().length, 2);
  eq(t.notes, []);
});

test("échec : mot de passe refusé, fenêtre et brouillon gardés, raison affichée", async () => {
  const t = setup({ commandError: new EasError(ERR.AUTH, "Identifiant ou mot de passe refusé par le serveur.", { status: 401 }) });
  await t.send();
  await t.handler.idle();
  eq(t.names(), ["accountOfIdentity", "saveMessage", "getComposeDetails", "messages.get", "getRaw", "clientFor", "command"]);
  eq(t.notes, ["Message non envoyé : identifiant ou mot de passe refusé par le serveur. Il reste dans la fenêtre de rédaction et dans les brouillons."]);
  eq(t.logs, [["warn", "Envoi échoué (AUTH)."]]);
});

test("échec, dans d'autres langues : raison choisie par le code ; minuscule seulement si la langue le veut", async () => {
  const fail = async () => {
    const t = setup({ commandError: new EasError(ERR.AUTH, "Identifiant ou mot de passe refusé par le serveur.", { status: 401 }) });
    await t.send();
    await t.handler.idle();
    return t.notes;
  };
  await withLanguage("en", async () => {
    eq(await fail(), ["Message not sent: the server refused the sign-in name or the password. It remains in the compose window and in the drafts."]);
  });
  // German keeps the capital of the reason (sendReasonLowercase: no), whatever its first word.
  await withLanguage("de", async () => {
    const reason = render(CATALOGS.de.errorAuth, ["x"]);
    eq(await fail(), [render(CATALOGS.de.sendFailedDraft, [/[.!?]$/.test(reason) ? reason : `${reason}.`])]);
  });
});

test("échec : message de serveur occupé gardé tel quel (commande en tête)", async () => {
  const t = setup({ commandError: new EasError(ERR.BUSY, "SendMail : serveur occupé (HTTP 503)", { status: 503 }) });
  await t.send();
  await t.handler.idle();
  eq(t.notes, ["Message non envoyé : SendMail : serveur occupé (HTTP 503). Il reste dans la fenêtre de rédaction et dans les brouillons."]);
});

test("échec incertain : connexion coupée après l'envoi de la requête", async () => {
  for (const code of [ERR.NETWORK, ERR.TIMEOUT, ERR.BAD_RESPONSE]) {
    const t = setup({ commandError: new EasError(code, "coupé", { sent: true }) });
    await t.send();
    await t.handler.idle();
    eq(t.names().includes("delete"), false);
    eq(t.notes.length, 1);
    assert(t.notes[0].startsWith("Envoi incertain :") && t.notes[0].includes("Envoyés"), t.notes[0]);
    eq(t.logs, [["warn", `Envoi incertain (${code}).`]]);
  }
  // Refused before anything was written: certain failure.
  const t = setup({ commandError: new EasError(ERR.TLS, "Connexion refusée : certificat du serveur non valide.") });
  await t.send();
  await t.handler.idle();
  assert(t.notes[0].startsWith("Message non envoyé : connexion refusée"), t.notes[0]);
});

test("échec : erreur inattendue, aucun texte libre affiché", async () => {
  const t = setup({ commandError: new TypeError(`cannot read ${SUBJECT}`) });
  await t.send();
  await t.handler.idle();
  eq(t.notes, ["Message non envoyé : erreur inattendue. Il reste dans la fenêtre de rédaction et dans les brouillons."]);
});

test("échec : Status de SendMail expliqué", async () => {
  const t = setup({ response: el("ComposeMail:SendMail", [el("Status", "116")]) });
  await t.send();
  await t.handler.idle();
  eq(t.names().includes("delete"), false);
  eq(t.names().includes("tabs.remove"), false);
  eq(t.notes, [
    "Message non envoyé : un destinataire n'a pas été reconnu par le serveur (Status 116). Il reste dans la fenêtre de rédaction et dans les brouillons.",
  ]);
  const u = setup({ response: el("ComposeMail:SendMail", [el("Status", "160")]) });
  await u.send();
  await u.handler.idle();
  assert(u.notes[0].includes("refus du serveur (Status 160)."), u.notes[0]);
});

test("échec incertain : réponse illisible", async () => {
  for (const response of [el("ComposeMail:SendMail", []), el("FolderHierarchy:FolderSync", [el("Status", "1")])]) {
    const t = setup({ response });
    await t.send();
    await t.handler.idle();
    eq(t.names().includes("delete"), false);
    assert(t.notes[0].startsWith("Envoi incertain :"), t.notes[0]);
  }
});

test("brouillon : enregistrement refusé un moment puis accepté", async () => {
  const t = setup({ saveFails: 2 });
  await t.send();
  await t.handler.idle();
  eq(t.names().filter((n) => n === "saveMessage").length, 3);
  eq(t.sent().length, 1);
  eq(t.notes, []);
});

test("brouillon : enregistrement impossible, rien n'est envoyé", async () => {
  const t = setup({ saveFails: 100 });
  await t.send();
  await t.handler.idle();
  eq(t.names().filter((n) => n === "saveMessage").length, 5);
  eq(t.sent().length, 0);
  eq(t.notes, ["Message non envoyé : le brouillon n'a pas pu être enregistré. Il reste dans la fenêtre de rédaction."]);
  for (const saveResult of [{ messages: [] }, { messages: [{ id: "77" }] }, null, { messages: [{ id: 1 }, { id: 2 }] }]) {
    const u = setup({ saveResult });
    await u.send();
    await u.handler.idle();
    eq(u.sent().length, 0, JSON.stringify(saveResult));
    eq(u.notes.length, 1);
  }
});

test("brouillon : contenu illisible ou vide refusé", async () => {
  // Only a File is read (data_format "File"): any other form is refused.
  for (const raw of [null, 42, "", DRAFT, fileOf(new Uint8Array(0))]) {
    const u = setup({ raw });
    await u.send();
    await u.handler.idle();
    eq(u.sent().length, 0);
    assert(u.notes[0].startsWith("Message non envoyé : le brouillon"), u.notes[0]);
  }
});

test("brouillon : trop volumineux, refusé avant lecture", async () => {
  let read = false;
  const t = setup({
    raw: {
      size: MAX_MESSAGE_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    },
  });
  await t.send();
  await t.handler.idle();
  eq(read, false);
  eq(t.sent().length, 0);
  assert(t.notes[0].includes("trop volumineux (plus de 50 Mo)"), t.notes[0]);
});

test("brouillon chiffré (OpenPGP, S/MIME) : refusé, jamais envoyé tel quel", async () => {
  for (const type of ['multipart/encrypted; protocol="application/pgp-encrypted"', "application/pkcs7-mime; smime-type=enveloped-data", "Application/X-PKCS7-MIME"]) {
    const t = setup({ raw: fileOf(encodeUtf8(DRAFT.replace("Content-Type: text/plain; charset=UTF-8", `Content-Type: ${type}`))) });
    await t.send();
    await t.handler.idle();
    eq(t.sent().length, 0, type);
    assert(t.notes[0].includes("chiffrés"), t.notes[0]);
  }
});

test("boîte introuvable ou sans mot de passe (EasError de clientFor) : rien n'est envoyé", async () => {
  const t = setup({
    clientFor: async () => {
      throw new EasError(ERR.CONFIG, "Identifiant ou mot de passe manquant.");
    },
  });
  await t.send();
  await t.handler.idle();
  eq(t.notes[0], "Message non envoyé : identifiant ou mot de passe manquant. Il reste dans la fenêtre de rédaction et dans les brouillons.");
});

test("après l'envoi : brouillon ou fenêtre impossible à retirer, signalé sans parler d'échec", async () => {
  const t = setup({ deleteFails: true, removeFails: true });
  await t.send();
  await t.handler.idle();
  eq(t.notes, ["Message envoyé, mais son brouillon n'a pas pu être supprimé et la fenêtre de rédaction n'a pas pu être fermée : ne le renvoyez pas."]);
  assert(t.names().includes("afterSend"), "synchro quand même");
});

test("après l'envoi : une erreur de afterSend ou de notification ne change rien", async () => {
  const t = setup({
    afterSend: () => {
      throw new Error("x");
    },
    notify: () => {
      throw new Error("pas de notification");
    },
  });
  await t.send();
  await t.handler.idle();
  eq(t.logs, [["info", "Message envoyé."], ["warn", "Synchronisation après l'envoi impossible."]]);
  const u = setup({
    commandError: new EasError(ERR.AUTH, "refusé"),
    notify: async () => {
      throw new Error("rejet");
    },
  });
  await u.send();
  await u.handler.idle();
  eq(u.handler.isSending(5), false);
});

test("journal : ni objet, ni adresse, ni contenu", async () => {
  const t = setup({ commandError: new EasError(ERR.HTTP, `SendMail : erreur HTTP 500 ${SUBJECT}`) });
  await t.send();
  await t.handler.idle();
  const u = setup();
  await u.send();
  await u.handler.idle();
  for (const [, m] of [...t.logs, ...u.logs]) {
    assert(!m.includes(SUBJECT) && !m.includes("@"), m);
  }
});

test("uninstall retire l'écouteur", () => {
  const t = setup();
  assert(t.hasListener());
  t.handler.uninstall();
  eq(t.hasListener(), false);
});

test("topContentType : en-tête de tête seulement, replié ou non, CRLF ou LF", () => {
  const bytes = (s) => encodeUtf8(s);
  eq(topContentType(bytes("Subject: x\r\nContent-Type: Multipart/Encrypted;\r\n protocol=x\r\n\r\nbody")), "multipart/encrypted");
  eq(topContentType(bytes("Subject: x\nContent-Type:\n multipart/encrypted\n\nbody")), "multipart/encrypted");
  eq(topContentType(bytes("Subject: x\r\n\r\nContent-Type: multipart/encrypted\r\n")), "text/plain");
  eq(topContentType(bytes("\r\nContent-Type: multipart/encrypted\r\n")), "text/plain");
  eq(topContentType(bytes("X-Content-Type: multipart/encrypted\r\nContent-Type: text/html\r\n\r\n")), "text/html");
  eq(topContentType(bytes("Content-Type: \r\n\r\n")), "text/plain");
  eq(topContentType(new Uint8Array(0)), "text/plain");
});

test("délai d'envoi : deux minutes, plus selon la taille, au plus trente minutes", () => {
  eq(sendTimeout(0), 120_000);
  eq(sendTimeout(16384), 121_000);
  eq(sendTimeout(16385), 122_000);
  eq(sendTimeout(MAX_MESSAGE_BYTES * 10), 1_800_000);
});

// ── Audit: signing and encryption (F4) ───────────────────────────────────

test("chiffrement ou signature demandés : annulé avant tout enregistrement", async () => {
  const cases = [
    { name: "OpenPGP", encryptBody: true, encryptSubject: true, signMessage: false },
    { name: "OpenPGP", encryptBody: false, encryptSubject: false, signMessage: true },
    { name: "S/MIME", encryptBody: true, signMessage: true },
    { name: "S/MIME", encryptBody: false, signMessage: true },
  ];
  for (const technology of cases) {
    const t = setup();
    eq(await t.send(5, OURS, technology), { cancel: true }, JSON.stringify(technology));
    await t.handler.idle();
    eq(t.names(), ["accountOfIdentity"], "rien n'est enregistré ni envoyé");
    eq(t.notes.length, 1);
    assert(t.notes[0].includes("OpenPGP, S/MIME"), t.notes[0]);
    eq(t.handler.isSending(5), false);
  }
});

test("chiffrement : état impossible à établir, annulé (envoi fermé)", async () => {
  const details = [
    ...[null, "OpenPGP", { name: "OpenPGP" }, { encryptBody: "false", signMessage: false }, { encryptBody: false, signMessage: 0 }].map(
      (technology) => ({ identityId: OURS, selectedEncryptionTechnology: technology }),
    ),
  ];
  for (const d of details) {
    const t = setup();
    eq(await t.fire({ id: 5 }, d), { cancel: true }, JSON.stringify(d));
    await t.handler.idle();
    eq(t.sent().length, 0);
    eq(t.names().includes("saveMessage"), false);
    eq(t.notes.length, 1);
  }
  // S/MIME without signing or encryption: sent.
  const t = setup();
  await t.send(5, OURS, { name: "S/MIME", encryptBody: false, signMessage: false });
  await t.handler.idle();
  eq(t.sent().length, 1);
});

test("chiffrement : champ absent (identité sans OpenPGP ni S/MIME, Thunderbird 160), envoyé", async () => {
  const t = setup({ current: { identityId: OURS } });
  eq(await t.fire({ id: 5 }, { identityId: OURS, subject: "x" }), { cancel: true }, "annulé pour Thunderbird, envoyé par ActiveSync");
  await t.handler.idle();
  eq(t.sent().length, 1);
});

test("chiffrement demandé après le clic : refusé après l'enregistrement, rien n'est envoyé", async () => {
  for (const technology of [{ name: "OpenPGP", encryptBody: true, encryptSubject: true, signMessage: false }, null]) {
    const t = setup({ current: { identityId: OURS, selectedEncryptionTechnology: technology } });
    await t.send();
    await t.handler.idle();
    eq(t.sent().length, 0);
    eq(t.names().includes("getRaw"), false);
    assert(t.notes[0].startsWith("Message non envoyé : la signature ou le chiffrement"), t.notes[0]);
  }
});

test("protectionAsked : vrai si demandé ou indéterminable", () => {
  eq(protectionAsked({ selectedEncryptionTechnology: CLEAR }), false);
  eq(protectionAsked({ selectedEncryptionTechnology: { ...CLEAR, encryptBody: true } }), true);
  eq(protectionAsked({ selectedEncryptionTechnology: { ...CLEAR, signMessage: true } }), true);
  eq(protectionAsked({}), false, "champ absent : rien ne peut être signé ni chiffré");
  eq(protectionAsked({ selectedEncryptionTechnology: null }), true);
  eq(protectionAsked(null), true);
  eq(protectionAsked("x"), true);
});

// ── Audit: the compose window during a send (F6) ─────────────────────────

test("verrou par fenêtre : un autre envoi de la même fenêtre est annulé, même depuis une autre identité", async () => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const t = setup({ gate });
  await t.send(5);
  for (let i = 0; i < 30 && !t.sent().length; i++) await null;
  eq(t.sent().length, 1);
  const before = t.calls.filter((c) => c[0] === "accountOfIdentity").length;
  // From switched to an identity of another account: still cancelled, not even looked up.
  eq(await t.send(5, OTHER), { cancel: true });
  eq(t.calls.filter((c) => c[0] === "accountOfIdentity").length, before);
  eq(t.notes, ["Ce message est déjà en cours d'envoi."]);
  // Another window is not concerned.
  eq(await t.send(6, OTHER), {});
  open();
  await t.handler.idle();
  eq(t.sent().length, 1);
  // Once ours is over, the window sends normally again.
  eq(await t.send(5, OTHER), {});
});

test("verrou par fenêtre : tenu dès le premier clic, pendant la vérification du compte", async () => {
  let open;
  const ownerGate = new Promise((resolve) => {
    open = resolve;
  });
  const t = setup({ ownerGate });
  const first = t.send(5);
  eq(t.handler.isSending(5), true);
  eq(await t.send(5, OTHER), { cancel: true });
  open();
  eq(await first, { cancel: true });
  await t.handler.idle();
  eq(t.sent().length, 1);
  // Not ours: the window is released at once.
  const u = setup();
  eq(await u.send(7, OTHER), {});
  eq(u.handler.isSending(7), false);
});

test("expéditeur changé après le clic : refusé, rien n'est envoyé", async () => {
  const t = setup({ current: { identityId: OTHER, selectedEncryptionTechnology: CLEAR } });
  await t.send();
  await t.handler.idle();
  eq(t.sent().length, 0);
  eq(t.names().includes("getRaw"), false);
  assert(t.notes[0].includes("l'expéditeur a changé"), t.notes[0]);
  const u = setup({ current: new Error("tab closed") });
  await u.send();
  await u.handler.idle();
  eq(u.sent().length, 0);
});

test("brouillon hors du compte de l'identité : refusé, jamais lu ni envoyé", async () => {
  const headers = [
    { id: 77, folder: { accountId: "account1", path: "/Drafts" } },
    { id: 77, folder: {} },
    { id: 77 },
    null,
    new Error("message inconnu"),
  ];
  for (const header of headers) {
    const t = setup({ header });
    await t.send();
    await t.handler.idle();
    eq(t.sent().length, 0, JSON.stringify(header));
    eq(t.names().includes("getRaw"), false);
    assert(t.notes[0].includes("pas été enregistré dans le compte Sync443"), t.notes[0]);
  }
});

// ── Audit: outgoing route of the identity (F2) ───────────────────────────

test("serveur d'envoi neutre : vérifié avant de décider, échec = annulé et signalé", async () => {
  const seen = [];
  const t = setup({
    checkSendRoute: async (identityId) => {
      seen.push(identityId);
      return false; // resolved: counts as checked
    },
  });
  eq(await t.send(5), { cancel: true });
  await t.handler.idle();
  eq(seen, [OURS]);
  eq(t.sent().length, 1);
  // Not called for an identity that is not ours.
  eq(await t.send(6, OTHER), {});
  eq(seen, [OURS]);

  const u = setup({
    checkSendRoute: async () => {
      throw new Error("PERMISSION: serveur sortant non marqué");
    },
  });
  eq(await u.send(5), { cancel: true });
  await u.handler.idle();
  eq(u.names(), ["accountOfIdentity"]);
  eq(u.notes, ["Message non envoyé : Sync443 n'a pas pu vérifier le serveur d'envoi de ce compte, donc rien n'est parti. Le message reste dans la fenêtre de rédaction."]);
  eq(u.logs, [["error", "Envoi annulé : serveur d'envoi neutre impossible à vérifier."]]);
  eq(u.handler.isSending(5), false);

  const v = setup({ checkSendRoute: "pas une fonction" });
  eq(await v.send(5), { cancel: true });
  await v.handler.idle();
  eq(v.sent().length, 0);
});
