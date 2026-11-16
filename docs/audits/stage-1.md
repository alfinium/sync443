# Security audit — stage 1 (foundations)

**Scope:** the stage 1 code, that is, everything that carries the password and reads the server's responses.
- `src/core/`: WBXML, validation, protocol, server address, certificate policy, HTTP/1.1, retry backoff.
- `src/transport/client.mjs`: ActiveSync client.
- `src/experiments/sync443Net/`: verified connection, privileged code.
- `src/sync/`: storage, mailbox health.

**Method:**
- Four independent reviews, by reviewers who had not written the code:
  - the core;
  - the first transport;
  - HTTP/1.1 and the client;
  - the privileged module.
- Each finding was verified before being accepted, most of them with a proof of concept.
- The test authors also found defects.
- Each fix is covered by a regression test: `tests/unit/audit-*.test.mjs`, and `tests/e2e/net/` for the privileged module.

**Summary:**
- All vulnerabilities found are fixed.
- The most serious one led to a design change: the certificate was checked only after the password had been sent.

## The design change

**First design:**
- Thunderbird's HTTP stack carried the requests, and the extension inspected the certificate with `webRequest`.
- The audit showed that an extension sees the certificate only when the response arrives, that is, **after** the request and its password have been written.
- A preliminary request without a password protects only its own connection. An interceptor that lets it through can capture the password on the next connection; the reviewer did so.

**Chosen design:**
- The extension opens each connection itself, directly or through the system proxy (SOCKS, or a `CONNECT` tunnel for an HTTP proxy).
- It waits for the TLS handshake to complete and evaluates the certificate chain.
- It writes the request only on that same connection, and only if the chain is accepted.
- The end-to-end test in a real Thunderbird proves it: 164 checks, over a direct connection, through an HTTP proxy and through a SOCKS proxy, with TLS 1.2 and 1.3. On any refused connection, the server receives **zero bytes** of the request.

## Findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| High | Certificate checked after the password was sent (Thunderbird's HTTP stack) | Verified connection opened by the extension (see above) |
| Medium | Non-canonical IPv6 address: the certificate check did not recognize the server and let it through | IPv6 addresses written in canonical form, as Thunderbird does; consistency check against its URL parser |
| Medium | WBXML decoder: text chunks were not counted against the limits (more than 1 GB of memory from 16 MB) | Chunks counted as elements, empty chunks ignored, values copied |
| Medium | Privileged module: writes queued without limit, Thunderbird's memory could be exhausted | One write at a time per connection, at most 1 MiB per write, splitting on the client side |
| Medium | Certificate check bypassed during a direct negotiation of the server's policies | Check before any request, whatever the path |
| Medium | Connection host not bound to the declared origin: the password could go to another host | Host and port checked against the origin, then frozen |
| Low | Refusal of the local machine could be bypassed (`127.1`, `0x7f.0.0.1`, `[::ffff:127.0.0.1]`, the `localhost.localdomain` alias…) | Strict address parsing; known local aliases refused |
| Low | Issuer name of an intercepting certificate shown as is | Name sanitized and presented as forgeable; pinning limited to the server certificate or the root |
| Low | Folder names: invisible, filler or stacked characters | NFC normalization, invisible characters removed, names without a visible character refused |
| Low | Folder name silently rewritten before being sent to the server | Refused instead of being rewritten |
| Low | Protocol responses: invalid elements kept, duplicates, uncapped lists | Discarded and counted, duplicates refused, caps |
| Low | Debug log: control and text-direction characters coming from the server | Neutralized |
| Low | Response cut off by the network taken for an empty response (a success) | No more `Connection: close`; every response must state its length |
| Low | After sending, a TLS error presented itself as "certificate refused, nothing was sent" | `sent` flag; error reclassified |
| Low | Sending not bounded in time | Single deadline for the whole exchange |
| Low | Transient conditions treated as fatal (too many connections, non-integer delays) | Reclassified, integer delays |
| Low | Cancellation lost while the connection was opening, or after the last read | Taken into account at every stage |
| Low | Any port of the allowed server reachable, including those Thunderbird forbids | Forbidden ports refused |
| Low | A server could trigger Thunderbird's client certificate picker | Anonymous connections |
| Low | Mailbox removed during a write: data left behind | Write and index under a single lock, writes refused after removal, cleanup at startup |
| Low | Backoff delays could be non-numeric | Delay always finite, between 1 s and one day |
| Info | Server policies acknowledged as applied | Acknowledged as not applied (status 3) |
| Info | Invisible characters in the source code ("Trojan Source") | Removed; `tools/check_source_chars.py` now refuses them |

## Known issues, not fixed at this stage

- **Any extension page can reach the background script,** and therefore the privileged module. Restricting it to the background script is a secondary safeguard: all pages are treated as equally sensitive.
- **Proxy that requires its own authentication:** not supported. The extension reports it and sends nothing.
- **Linux with the system's certificate authorities (p11-kit):** "built-in root" behavior to be verified on these distributions.
- **Thunderbird 140 ESR:** since verified, on 140.17.0 ESR. A refused certificate was reported there as an interrupted connection (connection correctly refused, misleading message); fixed, see [the audit of stages 2 and 3](stages-2-3.md#thunderbird-140-esr).
