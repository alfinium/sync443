// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Fail-closed sending (docs/CONCEPTION-COURRIER.md, "envoi fermé";
 * docs/SECURITE.md, rule 12).
 *
 * For an identity of an account this extension created (marked, see
 * experiments/sync443Account), Thunderbird's own sending is ALWAYS
 * cancelled: such a message leaves by ActiveSync or not at all.
 *  1. the message is saved as a draft (compose.saveMessage);
 *  2. the draft is read (messages.getRaw) and Thunderbird's internal headers
 *     are removed (cleanDraft, core/mime.mjs);
 *  3. it is sent with SendMail, the server keeping a copy in its Sent Items;
 *  4. the local draft is deleted for good, the compose window closed, and
 *     the background told (afterSend) so that it can synchronise.
 * On any failure the window and the draft stay, a notification says why,
 * and no other route is ever tried. A second click while the message is
 * being sent is ignored. When the account of the identity cannot be
 * determined, sending is cancelled too: in doubt, nothing leaves.
 *
 * Identities of other accounts are left alone: Thunderbird sends normally.
 *
 * The listener must exist before the user can send anything: call
 * installSendHandler at the top level of the background script, before any
 * await.
 *
 * Not handled: OpenPGP or S/MIME (Thunderbird signs and encrypts while it
 * sends, which never happens here). An encrypted draft is refused rather
 * than sent as it is.
 */

import { sendMailRequest, parseSendMail } from "./core/protocol.mjs";
import { cleanDraft } from "./core/mime.mjs";
import { cleanText } from "./core/sanitize.mjs";
import { ERR } from "./transport/client.mjs";
import { log as defaultLog } from "./log.mjs";

export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAILBOX_ID = /^[a-f0-9]{12}$/;
// compose.saveMessage can be refused while Thunderbird is still finishing the
// cancelled send: tried again after these delays (ms).
const SAVE_RETRIES = [250, 500, 1000, 2000];

/** Errors after which the request may have reached the server: the message may have left. */
const UNCERTAIN = new Set([ERR.NETWORK, ERR.TIMEOUT, ERR.CANCELLED, ERR.BAD_RESPONSE, ERR.TOO_LARGE]);

/** SendMail status codes ([MS-ASCMD] 2.2.2, common status codes). */
const STATUS_REASONS = new Map([
  ["107", "le serveur refuse le format du message"],
  ["110", "erreur du serveur"],
  ["111", "erreur temporaire du serveur, réessayez plus tard"],
  ["113", "la boîte est pleine sur le serveur"],
  ["114", "la boîte est momentanément indisponible sur le serveur"],
  ["115", "quota d'envoi du serveur dépassé"],
  ["116", "un destinataire n'a pas été reconnu par le serveur"],
  ["118", "le serveur indique que ce message a déjà été envoyé"],
  ["119", "le message n'a aucun destinataire"],
  ["120", "le serveur n'a pas pu remettre le message"],
  ["122", "pièce jointe trop volumineuse pour le serveur"],
]);

/** Top-level types of a message Thunderbird has encrypted (PGP/MIME, S/MIME). */
const ENCRYPTED_TYPES = new Set(["multipart/encrypted", "application/pkcs7-mime", "application/x-pkcs7-mime"]);

class SendFailure extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

/**
 * @param {object} deps
 * @param {(mailboxId: string) => (object|null|Promise<object|null>)} deps.clientFor
 *        the EasClient of a mailbox (null: unknown mailbox, or no password)
 * @param {(identityId: string) => Promise<{mailboxId: string}|null>} deps.accountOfIdentity
 *        sync443Account.accountOfIdentity: null for an identity of an account that is not ours
 * @param {(mailboxId: string) => any} [deps.afterSend]  after a message has left
 * @param {{info: Function, warn: Function, error: Function}} [deps.log]
 * @param {(message: string) => any} [deps.notify]  shows a French sentence to the user
 * @param {object} [deps.browser]  messenger / browser, or a test double
 * @param {(n: number) => Uint8Array} [deps.random]  CSPRNG
 * @param {(ms: number) => Promise<void>} [deps.delay]
 * @returns {{isSending(tabId: number): boolean, idle(): Promise<void>, uninstall(): void}}
 */
export function installSendHandler(deps) {
  const b = deps.browser ?? globalThis.messenger ?? globalThis.browser;
  const log = deps.log ?? defaultLog;
  const random = deps.random ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const notifyUser = deps.notify ?? defaultNotify(b);
  const notify = (message) => {
    try {
      Promise.resolve(notifyUser(message)).catch(() => {});
    } catch {
      /* a notification that fails must not change the outcome */
    }
  };

  const sending = new Set(); // compose tab ids with a send under way
  const jobs = new Set();

  async function onBeforeSend(tab, details) {
    let mailboxId;
    try {
      const identityId = details?.identityId;
      if (typeof identityId !== "string" || !identityId) throw new Error("no identity");
      const owner = await deps.accountOfIdentity(identityId);
      if (owner === null) return {}; // not one of ours: Thunderbird sends it
      mailboxId = owner?.mailboxId;
      if (typeof mailboxId !== "string" || !MAILBOX_ID.test(mailboxId)) throw new Error("bad owner");
      if (!Number.isInteger(tab?.id)) throw new Error("no tab");
    } catch {
      log.error("Envoi annulé : compte d'envoi impossible à vérifier.");
      notify("Message non envoyé : Sync443 n'a pas pu vérifier le compte d'envoi, donc rien n'est parti. Le message reste dans la fenêtre de rédaction.");
      return { cancel: true };
    }
    if (sending.has(tab.id)) {
      notify("Ce message est déjà en cours d'envoi.");
      return { cancel: true };
    }
    sending.add(tab.id);
    // Started once Thunderbird has had the answer: the send is cancelled first.
    const job = delay(0)
      .then(() => sendOne(tab, mailboxId))
      .catch(() => {
        log.error("Envoi interrompu par une erreur inattendue.");
        notify("Message non envoyé : erreur inattendue. Il reste dans la fenêtre de rédaction.");
      })
      .finally(() => {
        sending.delete(tab.id);
        jobs.delete(job);
      });
    jobs.add(job);
    return { cancel: true };
  }

  async function sendOne(tab, mailboxId) {
    let draftSaved = false;
    const fail = (code, reason, { uncertain = false } = {}) => {
      log.warn(uncertain ? `Envoi incertain (${code}).` : `Envoi échoué (${code}).`);
      notify(
        uncertain
          ? `Envoi incertain : ${reason} Vérifiez le dossier Envoyés avant de renvoyer le message, resté dans la fenêtre de rédaction.`
          : `Message non envoyé : ${reason} Il reste dans la fenêtre de rédaction${draftSaved ? " et dans les brouillons" : ""}.`,
      );
    };

    // 1. The draft.
    let draftId;
    try {
      draftId = await saveDraft(tab.id);
    } catch {
      return fail("DRAFT", "le brouillon n'a pas pu être enregistré.");
    }
    draftSaved = true;

    // 2. Its bytes, without Thunderbird's internal headers.
    let mime;
    try {
      const bytes = await readRaw(b, draftId);
      if (ENCRYPTED_TYPES.has(topContentType(bytes))) {
        throw new SendFailure("ENCRYPTED", "les messages chiffrés (OpenPGP, S/MIME) ne peuvent pas être envoyés par Sync443.");
      }
      mime = cleanDraft(bytes);
      if (!(mime instanceof Uint8Array) || mime.length === 0) throw new SendFailure("MIME", "le message n'a pas pu être préparé.");
    } catch (e) {
      if (e instanceof SendFailure) return fail(e.code, e.message);
      return fail("MIME", "le message n'a pas pu être préparé.");
    }

    // 3. SendMail.
    let client;
    try {
      client = await deps.clientFor(mailboxId);
    } catch (e) {
      const r = explain(e);
      return fail(r.code, r.reason);
    }
    if (!client || typeof client.command !== "function") {
      return fail("MAILBOX", "la boîte de ce compte est introuvable dans Sync443, ou son mot de passe manque.");
    }
    let request;
    try {
      request = sendMailRequest(newClientId(random), mime, { saveInSentItems: true });
    } catch {
      return fail("MIME", "le message n'a pas pu être préparé.");
    }
    let doc;
    try {
      doc = await client.command("SendMail", request, { timeoutMs: sendTimeout(mime.length), maxBytes: 64 * 1024 });
    } catch (e) {
      const r = explain(e);
      return fail(r.code, r.reason, { uncertain: r.uncertain });
    }
    let status = null;
    try {
      status = parseSendMail(doc ?? null);
    } catch {
      status = null;
    }
    if (status !== "1") {
      if (status === null) {
        return fail("STATUS", "réponse inattendue du serveur, le message est peut-être parti.", { uncertain: true });
      }
      return fail(`Status ${status}`, `${STATUS_REASONS.get(status) ?? "refus du serveur"} (Status ${status}).`);
    }

    // 4. Sent: the draft goes, the window closes.
    log.info("Message envoyé.");
    const leftovers = [];
    try {
      await deletePermanently(b, draftId);
    } catch {
      log.warn("Brouillon d'un message envoyé non supprimé.");
      leftovers.push("son brouillon n'a pas pu être supprimé");
    }
    try {
      await b.tabs.remove(tab.id);
    } catch {
      log.warn("Fenêtre de rédaction non fermée après l'envoi.");
      leftovers.push("la fenêtre de rédaction n'a pas pu être fermée");
    }
    if (leftovers.length) {
      notify(`Message envoyé, mais ${leftovers.join(" et ")} : ne le renvoyez pas.`);
    }
    try {
      await deps.afterSend?.(mailboxId);
    } catch {
      log.warn("Synchronisation après l'envoi impossible.");
    }
  }

  /** compose.saveMessage, tried again while Thunderbird finishes the cancelled send. → draft message id */
  async function saveDraft(tabId) {
    for (let attempt = 0; ; attempt++) {
      let saved;
      try {
        saved = await b.compose.saveMessage(tabId, { mode: "draft" });
      } catch (e) {
        if (attempt >= SAVE_RETRIES.length) throw e;
        await delay(SAVE_RETRIES[attempt]);
        continue;
      }
      const header = Array.isArray(saved?.messages) && saved.messages.length === 1 ? saved.messages[0] : null;
      if (!header || !Number.isInteger(header.id)) throw new SendFailure("DRAFT", "brouillon introuvable");
      return header.id;
    }
  }

  b.compose.onBeforeSend.addListener(onBeforeSend);
  return {
    isSending: (tabId) => sending.has(tabId),
    /** Resolves once every send under way has finished (tests, shutdown). */
    idle: async () => {
      while (jobs.size) await Promise.all([...jobs]);
    },
    uninstall: () => b.compose.onBeforeSend.removeListener(onBeforeSend),
  };
}

/** The draft's bytes (File, or the older binary string form), at most MAX_MESSAGE_BYTES. */
async function readRaw(b, id) {
  const tooLarge = () => new SendFailure("TOO_LARGE", `message trop volumineux (plus de ${MAX_MESSAGE_BYTES / 1048576} Mo).`);
  let raw;
  try {
    raw = await b.messages.getRaw(id, { data_format: "File" });
  } catch {
    throw new SendFailure("READ", "le brouillon n'a pas pu être lu.");
  }
  let bytes;
  if (raw && typeof raw.arrayBuffer === "function") {
    if (Number(raw.size) > MAX_MESSAGE_BYTES) throw tooLarge();
    bytes = new Uint8Array(await raw.arrayBuffer());
  } else if (typeof raw === "string") {
    if (raw.length > MAX_MESSAGE_BYTES) throw tooLarge();
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c > 0xff) throw new SendFailure("READ", "le brouillon n'a pas pu être lu.");
      bytes[i] = c;
    }
  } else {
    throw new SendFailure("READ", "le brouillon n'a pas pu être lu.");
  }
  if (bytes.length === 0) throw new SendFailure("READ", "le brouillon est vide.");
  if (bytes.length > MAX_MESSAGE_BYTES) throw tooLarge();
  return bytes;
}

/** Permanent deletion (never to the trash: a sent message's draft must not linger). */
async function deletePermanently(b, id) {
  try {
    await b.messages.delete([id], { deletePermanently: true });
  } catch {
    // Thunderbird versions whose Manifest V2 API takes a boolean (skipTrash).
    await b.messages.delete([id], true);
  }
}

/**
 * Media type of the top-level Content-Type header, lower case
 * ("text/plain" when there is none, as RFC 2045 says).
 */
export function topContentType(bytes) {
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  let end = limit;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (bytes[i + 1] === 0x0a || (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a)) {
      end = i;
      break;
    }
  }
  if (bytes[0] === 0x0a || (bytes[0] === 0x0d && bytes[1] === 0x0a)) end = 0;
  let text = "";
  for (let at = 0; at < end; at += 8192) {
    text += String.fromCharCode.apply(null, bytes.subarray(at, Math.min(at + 8192, end)));
  }
  const m = /^content-type[ \t]*:[ \t]*([^;\r\n]*)/im.exec(text.replace(/\r?\n[ \t]+/g, " "));
  const type = m ? m[1].trim().toLowerCase() : "";
  return type || "text/plain";
}

/** French reason for a failure of the client, never free text from an unknown error. */
function explain(e) {
  const code = typeof e?.code === "string" && /^[A-Z_]{2,20}$/.test(e.code) ? e.code : "UNKNOWN";
  if (e?.sent === true && UNCERTAIN.has(code)) {
    return { code, uncertain: true, reason: "la connexion s'est interrompue après l'envoi de la requête, le message est peut-être parti." };
  }
  const text = code === "UNKNOWN" ? "" : cleanText(typeof e?.message === "string" ? e.message : "", { max: 300, singleLine: true, stripBidi: true }).trim();
  const reason = text ? (/[.!?]$/.test(text) ? text : `${text}.`) : "erreur inattendue.";
  // "Identifiant refusé…" reads "Message non envoyé : identifiant refusé…"; "SendMail : …" stays as it is.
  return { code, uncertain: false, reason: /^\p{Lu}\p{Ll}*(?![\p{L}\d])/u.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason };
}

/** 32 hexadecimal digits from the CSPRNG: a fresh ClientId for every attempt. */
function newClientId(random) {
  const bytes = random(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error("random");
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Two minutes, plus one second per 16 KiB (slow uplinks), at most 30 minutes. */
export const sendTimeout = (bytes) => Math.min(1_800_000, 120_000 + Math.ceil(bytes / 16384) * 1000);

function defaultNotify(b) {
  return (message) =>
    b.notifications?.create({
      type: "basic",
      title: "Sync443",
      message,
      iconUrl: b.runtime?.getURL?.("icons/sync443.svg"),
    });
}
