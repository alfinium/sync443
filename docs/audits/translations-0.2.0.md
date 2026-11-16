# Security audit — interface in ten languages (0.2.0)

**Scope:** everything that changes between the published 0.1.0 and 0.2.0, essentially the translation
layer:
- `src/i18n.mjs` and the `src/_locales/<locale>/messages.json` catalogs;
- the manifest's `__MSG_…__` keys;
- the settings page, the texts of `src/background.mjs` and `src/send.mjs`;
- the checks in `tools/build_xpi.py`.

**Method:** independent, read-only review by a reviewer who had not written the
code. Each accepted finding was traced in the code; each fix is covered by a test.

**Summary:** no High or Medium vulnerability. Three Low and three Hardening findings, all fixed.

| Severity | Finding | Fix |
|---|---|---|
| Low | Refused certificate: the announced issuer, which an attacker chooses, was placed in the middle of the message, which the display truncates at 300 characters. A long name could push out the interception warning and leave attacker text at the end, without a closing quotation mark (pre-existing) | Warning first, issuer last, shortened so that the whole message fits, closing quotation mark always present |
| Low | Refused certificate, in the nine languages other than French: the message no longer said that the network may be intercepting HTTPS connections | Warning added in every language |
| Low | Sending refused because the server is busy: the message promised a new attempt, which sending does not make | Promise removed in every language; the sync status already gives the time of the next attempt |
| Hardening | A text that could not be built could throw an exception before a sending notification | `t()` never throws: a missing text gives an empty string |
| Hardening | The catalogs were checked only on the raw file text: an invisible character written as a JSON escape got through | `build_xpi.py` checks each message after parsing: invisible or control characters, markup and links refused; `check_source_chars.py` recognizes more invisible characters |
| Hardening | Two message names identical except for case passed the build check; Thunderbird keeps only one of them | Refused |

**Checked, no finding:**
- **Display:** no `innerHTML` or equivalent in `src`. Translated texts are set as text (`textContent`, attributes, `title`).
- **Parameters:** their substitution does not reinterpret inserted text.
- **Confirmations:** none contains text coming from the server.
- **Error codes:** an unknown code leads to the generic message.
- **Manifest:** permissions and content security policy unchanged.
- **Sending:** closed sending and the refusal of messages to be signed or encrypted are unchanged.
- **Log:** it still contains no address, subject or password.
- **Package:** it is still reproducible, with no test code.
- **Translations:** the security texts were reviewed in several languages; none is weakened or reversed.

**Not verified:** only English and French have been seen in a real Thunderbird. The other eight
languages are verified by the unit tests and by the build check.
