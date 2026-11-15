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
 * Accepted: a valid chain ending in a built-in root, or a chain whose leaf
 * or root is a certificate the user explicitly chose to trust for this
 * server (a private authority), identified by its SHA-256 fingerprint.
 * Anything else is refused before the password is sent, including a
 * connection that only works through a certificate exception.
 *
 * `info` is what webRequest.getSecurityInfo(id, {certificateChain: true})
 * returns.
 */

import { cleanText } from "./sanitize.mjs";

const normalise = (fp) => String(fp ?? "").replace(/:/g, "").toUpperCase();

/** → { ok, reason, issuer, chain: [{ subject, issuer, sha256, builtInRoot }] } */
export function evaluateTls(info, { pins = [] } = {}) {
  const chain = (Array.isArray(info?.certificates) ? info.certificates : []).map((c) => ({
    subject: String(c?.subject ?? ""),
    issuer: String(c?.issuer ?? ""),
    sha256: normalise(c?.fingerprint?.sha256),
    builtInRoot: c?.isBuiltInRoot === true,
  }));
  // The issuer name is chosen by whoever made the certificate: cleaned before it is ever shown.
  const issuer = cleanText(chain[0]?.issuer ?? "", { max: 200, singleLine: true, stripBidi: true });
  const result = (ok, reason) => ({ ok, reason, issuer, chain });
  if (!info || info.state !== "secure") return result(false, "insecure");
  if (info.isUntrusted) return result(false, "untrusted");
  if (info.isDomainMismatch) return result(false, "domain-mismatch");
  if (info.isNotValidAtThisTime) return result(false, "expired");
  if (info.overridableErrorCategory) return result(false, "exception"); // works only through a certificate exception
  if (!chain.length) return result(false, "no-certificate");
  const pinned = new Set(pins.map(normalise).filter((p) => /^[0-9A-F]{64}$/.test(p)));
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
        `autorité publique${shown ? ` (émetteur annoncé : « ${shown} », un nom que n'importe qui peut choisir)` : ""}. ` +
        "Le réseau intercepte peut-être les connexions HTTPS. Si votre serveur utilise une autorité privée, " +
        "faites-lui confiance dans les réglages en vérifiant son empreinte auprès de l'administrateur."
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
