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

import { cleanText } from "./sanitize.mjs";
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

/** Message for the user, in French. */
export function tlsMessage(reason, issuer = "") {
  const shown = cleanText(String(issuer ?? ""), { max: 200, singleLine: true, stripBidi: true });
  switch (reason) {
    case "not-public-root":
      return (
        "Connexion refusée avant l'envoi du mot de passe : le certificat présenté n'est pas émis par une " +
        `autorité que Thunderbird reconnaît${shown ? ` (émetteur annoncé : « ${shown} », un nom que n'importe qui peut choisir)` : ""}. ` +
        "Le réseau intercepte peut-être les connexions HTTPS. Les autorités privées ne sont pas prises en charge " +
        "dans cette version."
      );
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
