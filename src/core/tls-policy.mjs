// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * May this TLS connection carry the password?
 *
 * Basic authentication sends the password with every request, so a proxy
 * that decrypts HTTPS (with a certificate authority installed on the
 * computer, as some company or hotel networks do) would read it. Gecko
 * tells us which root the verified chain ends in: one of Mozilla's built-in
 * public authorities, or an authority added locally.
 *
 * Accepted: a valid chain ending in a built-in root, or a valid chain whose
 * leaf or root has a SHA-256 fingerprint pinned for this server. Pins are
 * set only by test builds for now (no setting offers them yet), so a
 * private authority is not supported. Anything else is refused before the
 * password is sent, including a connection that only works through a
 * certificate exception.
 *
 * `info` is what webRequest.getSecurityInfo(id, {certificateChain: true})
 * returns.
 */

import { cleanText, cut } from "./sanitize.mjs";
import { TLS_PIN } from "./ids.mjs";

const normalise = (fp) => String(fp ?? "").replace(/:/g, "").toUpperCase();

/** → { ok, reason, issuer } */
export function evaluateTls(info, { pins = [] } = {}) {
  const chain = (Array.isArray(info?.certificates) ? info.certificates : []).map((c) => ({
    issuer: String(c?.issuer ?? ""),
    sha256: normalise(c?.fingerprint?.sha256),
    builtInRoot: c?.isBuiltInRoot === true,
  }));
  // The issuer name is chosen by whoever made the certificate: cleaned before it is ever shown.
  const issuer = cleanText(chain[0]?.issuer ?? "", { max: 200, singleLine: true, stripBidi: true });
  const result = (ok, reason) => ({ ok, reason, issuer });
  if (!info || info.state !== "secure") return result(false, "insecure");
  if (info.isUntrusted) return result(false, "untrusted");
  if (info.isDomainMismatch) return result(false, "domain-mismatch");
  if (info.isNotValidAtThisTime) return result(false, "expired");
  if (info.overridableErrorCategory) return result(false, "exception"); // works only through a certificate exception
  if (!chain.length) return result(false, "no-certificate");
  const pinned = new Set(pins.map(normalise).filter((p) => TLS_PIN.test(p)));
  const leaf = chain[0];
  const root = chain[chain.length - 1];
  if (pinned.has(leaf.sha256) || pinned.has(root.sha256)) return result(true, "pinned");
  if (root.builtInRoot) return result(true, "public-root");
  return result(false, "not-public-root");
}

/** Longest reason shown to the user (src/i18n.mjs cuts there): the whole message must fit. */
export const TLS_MESSAGE_MAX = 300;

/**
 * Message for the user, in French. The issuer name, which whoever made the
 * certificate chooses, comes last and is cut to fit: it can never push the
 * warning out of the message, nor leave its closing quote off.
 */
export function tlsMessage(reason, issuer = "") {
  const shown = cleanText(String(issuer ?? ""), { max: 200, singleLine: true, stripBidi: true }).trim();
  switch (reason) {
    case "not-public-root": {
      const warning =
        "Connexion refusée avant l'envoi du mot de passe : autorité du certificat non reconnue par " +
        "Thunderbird. Le réseau intercepte peut-être les connexions HTTPS ; les autorités privées ne " +
        "sont pas prises en charge.";
      if (!shown) return warning;
      const before = " Émetteur, un nom que n'importe qui peut choisir : « ";
      const after = " ».";
      const room = TLS_MESSAGE_MAX - warning.length - before.length - after.length;
      const name = shown.length > room ? `${cut(shown, room - 1).trimEnd()}…` : shown;
      return warning + before + name + after;
    }
    case "untrusted":
      return "Connexion refusée : certificat du serveur non reconnu.";
    case "domain-mismatch":
      return "Connexion refusée : le certificat ne correspond pas au nom du serveur.";
    case "expired":
      return "Connexion refusée : le certificat du serveur est expiré ou pas encore valide.";
    case "exception":
      return "Connexion refusée : le certificat du serveur n'est accepté que par une exception de sécurité.";
    default:
      return "Connexion refusée : la connexion au serveur n'est pas chiffrée correctement.";
  }
}
