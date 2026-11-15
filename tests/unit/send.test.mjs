// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * src/send.mjs: fail-closed sending. Thunderbird (compose, messages, tabs),
 * the privileged account lookup and the ActiveSync client are doubles that
 * record every call. Addresses are from the reserved example.com domain.
 */

import { test, eq, assert } from "./harness.mjs";
import { installSendHandler, topContentType, sendTimeout, MAX_MESSAGE_BYTES } from "../../src/send.mjs";
import { el, text, at, child } from "../../src/core/wbxml.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";

const MAILBOX = "0123456789ab";
const OURS = "id3";
const OTHER = "id1";
const SUBJECT = "Rendez-vous secret";

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
    deleteObjectFails: o.deleteObjectFails ?? false,
    deleteFails: o.deleteFails ?? false,
    removeFails: o.removeFails ?? false,
    response: o.response ?? null,
    commandError: o.commandError ?? null,
    gate: o.gate ?? null,
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
      async saveMessage(tabId, options) {
        calls.push(["saveMessage", tabId, options]);
        if (state.saveFails-- > 0) throw new Error("Window is busy");
        return state.saveResult;
      },
    },
    messages: {
      async getRaw(id, options) {
        calls.push(["getRaw", id, options]);
        return state.raw;
      },
      async delete(ids, option) {
        calls.push(["delete", ids, option]);
        if (state.deleteFails || (state.deleteObjectFails && typeof option === "object")) throw new Error("Type error for parameter skipTrash");
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
        return identityId === OURS ? { accountKey: "account7", mailboxId: MAILBOX } : null;
      }),
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
  const send = (tabId = 5, identityId = OURS) => fire({ id: tabId, windowId: 9, type: "messageCompose" }, { identityId, subject: SUBJECT });
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
  eq(t.names(), ["accountOfIdentity", "saveMessage", "getRaw", "clientFor", "command", "delete", "tabs.remove", "afterSend"]);
  eq(t.calls[1], ["saveMessage", 5, { mode: "draft" }]);
  eq(t.calls[2], ["getRaw", 77, { data_format: "File" }]);
  eq(t.calls[3], ["clientFor", MAILBOX]);
  const [, cmd, root, options] = t.calls[4];
  eq(cmd, "SendMail");
  eq([root.ns, root.tag], ["ComposeMail", "SendMail"]);
  assert(/^[0-9a-f]{32}$/.test(text(root, "ClientId")), "ClientId de 32 chiffres hexadécimaux");
  assert(child(root, "SaveInSentItems") !== null, "copie dans les Envoyés du serveur");
  const mime = mimeOf(t.calls[4]);
  assert(!/X-Mozilla-/i.test(mime) && !/^Fcc:/im.test(mime), "en-têtes internes retirés");
  assert(mime.includes(`Subject: ${SUBJECT}`) && mime.includes("Bonjour Bob."), "message intact");
  eq(options.maxBytes, 64 * 1024);
  eq(options.timeoutMs, sendTimeout(at(root, "Mime").value.length));
  eq(t.calls[5], ["delete", [77], { deletePermanently: true }]);
  eq(t.calls[6], ["tabs.remove", 5]);
  eq(t.calls[7], ["afterSend", MAILBOX]);
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
  eq(t.names(), ["accountOfIdentity", "saveMessage", "getRaw", "clientFor", "command"]);
  eq(t.notes, ["Message non envoyé : identifiant ou mot de passe refusé par le serveur. Il reste dans la fenêtre de rédaction et dans les brouillons."]);
  eq(t.logs, [["warn", "Envoi échoué (AUTH)."]]);
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

test("brouillon : forme texte binaire acceptée, contenu illisible refusé", async () => {
  const t = setup({ raw: DRAFT });
  await t.send();
  await t.handler.idle();
  eq(t.sent().length, 1);
  assert(mimeOf(t.sent()[0]).includes("Bonjour Bob."));
  for (const raw of [null, 42, "", "Āabc", fileOf(new Uint8Array(0))]) {
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

test("boîte introuvable ou sans mot de passe : rien n'est envoyé", async () => {
  for (const clientFor of [async () => null, async () => ({}), () => undefined]) {
    const t = setup({ clientFor });
    await t.send();
    await t.handler.idle();
    eq(t.sent().length, 0);
    assert(t.notes[0].includes("introuvable"), t.notes[0]);
  }
  const t = setup({
    clientFor: async () => {
      throw new EasError(ERR.CONFIG, "Identifiant ou mot de passe manquant.");
    },
  });
  await t.send();
  await t.handler.idle();
  eq(t.notes[0], "Message non envoyé : identifiant ou mot de passe manquant. Il reste dans la fenêtre de rédaction et dans les brouillons.");
});

test("après l'envoi : suppression définitive en booléen sur les versions qui l'exigent", async () => {
  const t = setup({ deleteObjectFails: true });
  await t.send();
  await t.handler.idle();
  eq(
    t.calls.filter((c) => c[0] === "delete"),
    [
      ["delete", [77], { deletePermanently: true }],
      ["delete", [77], true],
    ],
  );
  eq(t.notes, []);
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
