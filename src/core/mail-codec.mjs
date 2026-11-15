// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * E-mail items of a Sync collection: what the extension reads from
 * ApplicationData and what it writes back ([MS-ASEMAIL] for Read and Flag,
 * [MS-ASAIRS] for Body, [MS-ASCMD] for the Sync options).
 *
 *   readEmail(applicationData, { maxMimeBytes? }) → { read, flagged, mime, truncated }
 *   changeEmail({ read?, flagged? })             → ApplicationData children of a Change
 *   mailOptions({ filterType })                  → Options children of a Sync collection
 *
 * The message itself is always the full MIME form (Body Type 4), imported
 * as it is after mime.mjs has removed internal headers. Reading never
 * throws: what is missing or invalid comes back as null.
 */

import { el, child, text, bytes as rawBytes } from "./wbxml.mjs";
import * as v from "./sanitize.mjs";
import { ProtocolError } from "./protocol.mjs";

/** Largest MIME message taken from a Sync response unless the caller says otherwise. */
export const DEFAULT_MAX_MIME_BYTES = 64 * 1024 * 1024;
/**
 * FilterType values allowed for e-mail ([MS-ASCMD] 2.2.3.71.2): 0 all,
 * 1 one day, 2 three days, 3 one week, 4 two weeks, 5 one month. 6 and 7
 * (three and six months) are for calendars only, 8 for tasks only.
 */
export const MAIL_FILTER_TYPES = Object.freeze(["0", "1", "2", "3", "4", "5"]);
/** FlagType sent with a new follow-up flag ([MS-ASEMAIL] 2.2.2.33). */
export const FLAG_TYPE = "for Follow Up";

const BODY_MIME = 4; // AirSyncBase:Type of a full MIME body ([MS-ASAIRS] 2.2.2.22.1)
const MIME_SUPPORT_ALL = "2"; // MIME for every message, not only S/MIME ones ([MS-ASCMD] 2.2.3.100.3)

const isElement = (node) => Boolean(node) && typeof node === "object" && Array.isArray(node.children);
const isEmpty = (node) => node.children.length === 0 && !(node.value && node.value.length);

/**
 * Flag state ([MS-ASEMAIL] 2.2.2.27, 2.2.2.69): Status 2 is an active
 * flag; 0 (cleared) and 1 (complete) are not flagged; an empty <Flag/>
 * clears the flag. A Flag with content but no valid Status is unknown.
 */
function flagState(flag) {
  if (!flag) return null;
  const status = child(flag, "Email:Status");
  if (!status) return isEmpty(flag) ? false : null;
  const value = v.status(text(status));
  if (value === "2") return true;
  if (value === "0" || value === "1") return false;
  return null;
}

/**
 * The parts of an e-mail ApplicationData the extension uses:
 *  - read, flagged: true, false, or null when absent or invalid (the
 *    caller then leaves the local state alone);
 *  - mime: the raw message (Uint8Array) from the first Body of Type 4, or
 *    null when there is none, it is empty, or it is larger than
 *    `maxMimeBytes` (default 64 MiB);
 *  - truncated: true when that Body says Truncated (mime then holds only
 *    the beginning of the message) or exceeds `maxMimeBytes` (mime null).
 */
export function readEmail(applicationData, { maxMimeBytes = DEFAULT_MAX_MIME_BYTES } = {}) {
  const cap = Number.isFinite(maxMimeBytes) && maxMimeBytes >= 0 ? maxMimeBytes : DEFAULT_MAX_MIME_BYTES;
  const result = { read: null, flagged: null, mime: null, truncated: false };
  if (!isElement(applicationData)) return result;
  result.read = v.flag(text(applicationData, "Email:Read"));
  result.flagged = flagState(child(applicationData, "Email:Flag"));
  for (const body of applicationData.children) {
    if (body.ns !== "AirSyncBase" || body.tag !== "Body") continue;
    if (v.integer(text(body, "AirSyncBase:Type"), { min: 1, max: 255 }) !== BODY_MIME) continue;
    result.truncated = v.flag(text(body, "AirSyncBase:Truncated")) === true;
    const data = child(body, "AirSyncBase:Data");
    const mime = data ? rawBytes(data) : null;
    if (mime && mime.length > cap) {
      result.truncated = true;
    } else if (mime && mime.length > 0) {
      result.mime = mime;
    }
    break; // the first MIME body only
  }
  return result;
}

/**
 * ApplicationData children for a Change of an e-mail ([MS-ASEMAIL] 3.1.5.3,
 * properties a client may change): Read "1"/"0"; a flag is set with
 * Status 2 and FlagType "for Follow Up", and cleared with an empty Flag.
 * A property left undefined (or null) is not sent; with neither, the
 * result is empty and nothing should be sent. Anything but a boolean is
 * refused (ProtocolError).
 */
export function changeEmail({ read, flagged } = {}) {
  const out = [];
  if (read !== undefined && read !== null) {
    if (typeof read !== "boolean") throw new ProtocolError("état « lu » invalide");
    out.push(el("Email:Read", read ? "1" : "0"));
  }
  if (flagged !== undefined && flagged !== null) {
    if (typeof flagged !== "boolean") throw new ProtocolError("état du drapeau invalide");
    out.push(flagged ? el("Email:Flag", [el("Email:Status", "2"), el("Email:FlagType", FLAG_TYPE)]) : el("Email:Flag"));
  }
  return out;
}

/**
 * Options children of a Sync collection of e-mail ([MS-ASCMD] 2.2.3.115.5):
 * the period (FilterType, "0" to "5" or 0 to 5, see MAIL_FILTER_TYPES),
 * MIME for every message (MIMESupport 2) and the body as full MIME
 * (BodyPreference Type 4, without TruncationSize: the whole message). Any
 * other period is refused (ProtocolError).
 */
export function mailOptions({ filterType } = {}) {
  const ft = typeof filterType === "string" || typeof filterType === "number" ? String(filterType) : "";
  if (!MAIL_FILTER_TYPES.includes(ft)) throw new ProtocolError("période invalide pour le courrier");
  return [
    el("AirSync:FilterType", ft),
    el("AirSync:MIMESupport", MIME_SUPPORT_ALL),
    el("AirSyncBase:BodyPreference", [el("AirSyncBase:Type", String(BODY_MIME))]),
  ];
}
