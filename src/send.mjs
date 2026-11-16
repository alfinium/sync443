// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Fail-closed sending (docs/CONCEPTION-COURRIER.md, "envoi fermé";
 * docs/SECURITE.md, rule 12).
 *
 * For an identity of an account this extension created (marked, see
 * experiments/sync443Account), Thunderbird's own sending is ALWAYS
 * cancelled: such a message leaves by ActiveSync or not at all.
 *  0. before deciding: the outgoing route of the identity is checked
 *     (checkSendRoute, when given), and signing or encryption must not have
 *     been asked for (see below);
 *  1. the message is saved as a draft (compose.saveMessage); the window must
 *     still send as the identity that was checked, unsigned and unencrypted,
 *     and the draft must be in a folder of that identity's own account;
 *  2. the draft is read (messages.getRaw) and Thunderbird's internal headers
 *     are removed (cleanDraft, core/mime.mjs);
 *  3. it is sent with SendMail, the server keeping a copy in its Sent Items;
 *  4. the local draft is deleted for good, the compose window closed, and
 *     the background told (afterSend) so that it can synchronise.
 * On any failure the window and the draft stay, a notification says why,
 * and no other route is ever tried. When the account of the identity, its
 * route or the signing and encryption state cannot be determined, sending
 * is cancelled too: in doubt, nothing leaves.
 *
 * One send at a time per compose window: from the first click until our
 * send is over, any other Send from that window is cancelled, whatever its
 * sender (the window is usable again while ours runs, and its From could
 * have been switched to another account's identity).
 *
 * Identities of other accounts are left alone: Thunderbird sends normally.
 *
 * The listener must exist before the user can send anything: call
 * installSendHandler at the top level of the background script, before any
 * await.
 *
 * Not handled: OpenPGP or S/MIME. Thunderbird signs and encrypts while it
 * sends, which never happens here, and a draft is only encrypted when the
 * identity says so: a message for which signing or encryption is selected
 * is refused, and so is a draft that is encrypted anyway.
 *
 * Bcc: ActiveSync has no envelope. The Bcc header travels inside the MIME
 * message to the server, which takes the recipients from To, Cc and Bcc and
 * removes Bcc before delivery (as Exchange and SOGo do). Sync443 cannot
 * remove it itself without losing those recipients.
 */

import { sendMailRequest, parseSendMail } from "./core/protocol.mjs";
import { cleanDraft } from "./core/mime.mjs";
import { cleanText } from "./core/sanitize.mjs";
import { ERR } from "./transport/client.mjs";
import { MAILBOX_ID, ACCOUNT_KEY } from "./core/ids.mjs";
import { toHex } from "./core/sha256.mjs";

export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const BUSY = "Ce message est déjà en cours d'envoi.";
const PROTECTED =
  "Message non envoyé : la signature et le chiffrement (OpenPGP, S/MIME) ne sont pas encore pris en charge par Sync443, ou leur état n'a pas pu être vérifié. Désactivez-les pour ce message. Il reste dans la fenêtre de rédaction.";
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
 * @param {(mailboxId: string) => Promise<object>} deps.clientFor
 *        the EasClient of a mailbox; throws an EasError (unknown mailbox, no password…)
 * @param {(identityId: string) => Promise<{accountKey: string, mailboxId: string}|null>} deps.accountOfIdentity
 *        sync443Account.accountOfIdentity: null for an identity of an account that is not ours
 * @param {(identityId: string) => Promise<any>} [deps.checkSendRoute]
 *        privileged check (and repair) that a marked identity sends through the neutral
 *        outgoing server. It must THROW when the route is not safe: whatever it resolves
 *        to, even false, counts as checked.
 * @param {(mailboxId: string) => any} [deps.afterSend]  after a message has left
 * @param {{info: Function, warn: Function, error: Function}} deps.log
 * @param {(message: string) => any} deps.notify  shows a French sentence to the user
 * @param {object} [deps.browser]  messenger / browser, or a test double
 * @param {(n: number) => Uint8Array} [deps.random]  CSPRNG
 * @param {(ms: number) => Promise<void>} [deps.delay]
 * @returns {{isSending(tabId: number): boolean, idle(): Promise<void>, uninstall(): void}} (tests)
 */
export function installSendHandler(deps) {
  const b = deps.browser ?? globalThis.messenger ?? globalThis.browser;
  const { log } = deps;
  const random = deps.random ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const notify = (message) => {
    try {
      Promise.resolve(deps.notify(message)).catch(() => {});
    } catch {
      /* a notification that fails must not change the outcome */
    }
  };

  const sending = new Set(); // compose tab ids with a send under way
  const jobs = new Set();

  async function onBeforeSend(tab, details) {
    const tabId = Number.isInteger(tab?.id) ? tab.id : null;
    // Held from the first click, whatever identity the next one uses.
    if (tabId !== null && sending.has(tabId)) {
      notify(BUSY);
      return { cancel: true };
    }
    if (tabId !== null) sending.add(tabId);
    let started = false;
    try {
      let identityId;
      let owner;
      try {
        identityId = details?.identityId;
        if (typeof identityId !== "string" || !identityId) throw new Error("no identity");
        const found = await deps.accountOfIdentity(identityId);
        if (found === null) return {}; // not one of ours: Thunderbird sends it
        if (!found || typeof found.mailboxId !== "string" || !MAILBOX_ID.test(found.mailboxId)) throw new Error("bad owner");
        if (typeof found.accountKey !== "string" || !ACCOUNT_KEY.test(found.accountKey)) throw new Error("bad account");
        if (tabId === null) throw new Error("no tab");
        owner = { mailboxId: found.mailboxId, accountKey: found.accountKey };
      } catch {
        log.error("Envoi annulé : compte d'envoi impossible à vérifier.");
        notify("Message non envoyé : Sync443 n'a pas pu vérifier le compte d'envoi, donc rien n'est parti. Le message reste dans la fenêtre de rédaction.");
        return { cancel: true };
      }
      try {
        if (deps.checkSendRoute !== undefined) await deps.checkSendRoute(identityId);
      } catch {
        log.error("Envoi annulé : serveur d'envoi neutre impossible à vérifier.");
        notify("Message non envoyé : Sync443 n'a pas pu vérifier le serveur d'envoi de ce compte, donc rien n'est parti. Le message reste dans la fenêtre de rédaction.");
        return { cancel: true };
      }
      if (protectionAsked(details)) {
        log.warn("Envoi refusé : signature ou chiffrement demandé, ou état inconnu.");
        notify(PROTECTED);
        return { cancel: true };
      }
      started = true;
      // Started once Thunderbird has had the answer: the send is cancelled first.
      const job = delay(0)
        .then(() => sendOne(tabId, identityId, owner))
        .catch(() => {
          log.error("Envoi interrompu par une erreur inattendue.");
          notify("Message non envoyé : erreur inattendue. Il reste dans la fenêtre de rédaction.");
        })
        .finally(() => {
          sending.delete(tabId);
          jobs.delete(job);
        });
      jobs.add(job);
      return { cancel: true };
    } finally {
      if (!started && tabId !== null) sending.delete(tabId);
    }
  }

  async function sendOne(tabId, identityId, { mailboxId, accountKey }) {
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
      draftId = await saveDraft(tabId);
    } catch {
      return fail("DRAFT", "le brouillon n'a pas pu être enregistré.");
    }
    draftSaved = true;

    // What was saved: the identity that was checked, unsigned and unencrypted
    // (the window was usable again meanwhile), in that identity's own account.
    let current;
    try {
      current = await b.compose.getComposeDetails(tabId);
    } catch {
      return fail("DETAILS", "la fenêtre de rédaction n'a pas pu être relue.");
    }
    if (current?.identityId !== identityId) {
      return fail("IDENTITY", "l'expéditeur a changé pendant l'envoi. Cliquez de nouveau sur Envoyer.");
    }
    if (protectionAsked(current)) {
      return fail("PROTECTION", "la signature ou le chiffrement (OpenPGP, S/MIME) a été demandé, ce que Sync443 ne prend pas encore en charge.");
    }
    let header;
    try {
      header = await b.messages.get(draftId);
    } catch {
      header = null;
    }
    if (!header || header.folder?.accountId !== accountKey) {
      return fail("FOLDER", "le brouillon n'a pas été enregistré dans le compte Sync443 de cet expéditeur. Vérifiez le dossier des brouillons de l'identité.");
    }

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
      await b.tabs.remove(tabId);
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
  // (tests)
  return {
    isSending: (tabId) => sending.has(tabId),
    /** Resolves once every send under way has finished. */
    idle: async () => {
      while (jobs.size) await Promise.all([...jobs]);
    },
    uninstall: () => b.compose.onBeforeSend.removeListener(onBeforeSend),
  };
}

/** The draft's bytes (a File since data_format "File"), at most MAX_MESSAGE_BYTES. */
async function readRaw(b, id) {
  const tooLarge = () => new SendFailure("TOO_LARGE", `message trop volumineux (plus de ${MAX_MESSAGE_BYTES / 1048576} Mo).`);
  let raw;
  try {
    raw = await b.messages.getRaw(id, { data_format: "File" });
  } catch {
    throw new SendFailure("READ", "le brouillon n'a pas pu être lu.");
  }
  if (!raw || typeof raw.arrayBuffer !== "function") throw new SendFailure("READ", "le brouillon n'a pas pu être lu.");
  if (Number(raw.size) > MAX_MESSAGE_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await raw.arrayBuffer());
  if (bytes.length === 0) throw new SendFailure("READ", "le brouillon est vide.");
  return bytes;
}

/** Permanent deletion (never to the trash: a sent message's draft must not linger). */
async function deletePermanently(b, id) {
  await b.messages.delete([id], { deletePermanently: true });
}

/**
 * Did the user ask for signing or encryption (compose details,
 * selectedEncryptionTechnology)? Also true when it cannot be told: no
 * details, or a field that is not the expected booleans. An absent field
 * means none is possible (no OpenPGP key, no S/MIME certificate).
 */
export function protectionAsked(details) {
  if (!details || typeof details !== "object") return true;
  const t = details.selectedEncryptionTechnology;
  // Left out by Thunderbird when encryption is off and the identity has no
  // OpenPGP key and no S/MIME certificate (seen in Thunderbird 160): nothing
  // can be signed or encrypted then. The top-level Content-Type of the saved
  // draft is still checked before sending.
  if (t === undefined) return false;
  if (!t || typeof t !== "object") return true;
  if (typeof t.encryptBody !== "boolean" || typeof t.signMessage !== "boolean") return true;
  return t.encryptBody || t.signMessage;
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
  return toHex(bytes);
}

/** Two minutes, plus one second per 16 KiB (slow uplinks), at most 30 minutes. */
export const sendTimeout = (bytes) => Math.min(1_800_000, 120_000 + Math.ceil(bytes / 16384) * 1000);
