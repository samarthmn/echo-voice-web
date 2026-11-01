---
title: HTTP API
description: An overview of Echo's local HTTP API for contributors, including the extension protocol under /extension/v1.
---

Echo's server exposes two route trees on its loopback address. Neither is a public API: they exist for Echo's own web app and extension, and they can change between versions. This page is for contributors.

## Workspace API (`/api`)

Used by the Echo web app. Requests must come from Echo's own origin with a loopback `Host`; responses are `no-store`. Errors are JSON `{"error": "..."}` with a 4xx or 5xx status.

| Area | Routes |
| --- | --- |
| Health | `GET /api/health`: `{status, version, library, keychain, diskFreeBytes}` once the library is open; `?deep` also reports whether Ollama is reachable |
| Meetings | `GET /api/meetings`, `GET /api/meetings/{id}` (plus update and delete), `GET /api/meetings/{id}/audio/{track}` (range requests), `GET /api/meetings/{id}/export` |
| Versions | `POST /api/meetings/{id}/transcripts`, `POST /api/meetings/{id}/notes`, `POST /api/meetings/{id}/moments` |
| Processing | `POST /api/processing/heartbeat` |
| Settings | `GET /api/settings` (plus update), `GET /api/vocabulary` (plus update) |
| Storage | `GET /api/storage`, `GET /api/storage/export`, restore, recovery phrase |
| Native speech | `GET /api/speech`, `POST /api/speech/jobs`, `GET /api/speech/jobs/{id}`, `DELETE /api/speech/model` |
| Notes (Ollama) | `GET /api/notes`, `POST /api/notes/models` |
| Calendar | `GET /api/integrations/status`, `GET /api/integrations/calendar`, `GET /api/integrations/google/connect`, `GET /api/integrations/google/callback`, `POST /api/integrations/google/cancel` |
| Extensions | `/api/extensions/...`: list connections and pending requests, approve or reject, revoke, mint intents |

The route definitions live in `server/src/api.rs`, `speech.rs`, `notes.rs`, `integrations.rs` and `extensions/workspace.rs`.

## Extension API (`/extension/v1`)

The extension talks to the local server under `/extension/v1`. The server accepts only a loopback `Host` and an `Origin` of the form `chrome-extension://<32 chars a-p>`, answers CORS only to that origin, and binds each credential to the origin that paired.

### Endpoints

| Method and path                                                                                                                                                                     | Auth   | Purpose                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /hello`                                                                                                                                                                        | none   | Discovery: `{service:"echo-voice", protocolVersion:2, libraryId}`. No database writes                                                                                                                                                                                                                                                                                                  |
| `POST /pair`                                                                                                                                                                        | none   | Body `{installationId, name, claimSecret, intent?}`; `claimSecret` is 32 random bytes in hex. Returns `{requestId, status:"pending"\|"approved", expiresAt, libraryId}`. Idempotent for the same installation and secret; a new request from an installation cancels its older pending one. A valid single-use `intent` creates the request already approved. Requests live 10 minutes |
| `POST /pair/claim`                                                                                                                                                                  | none   | Body `{requestId, installationId, claimSecret}`. `{status:"pending"}`, or `{status:"approved", credential, libraryId}`, or `403 {status:"rejected"\|"expired"\|"unknown"}`                                                                                                                                                                                                             |
| `DELETE /pair/{requestId}`                                                                                                                                                          | none   | Cancel; body `{installationId, claimSecret}`; `204`, idempotent                                                                                                                                                                                                                                                                                                                        |
| `GET /connection`, `DELETE /connection`                                                                                                                                             | bearer | Connection info (`401` once revoked), and extension-side disconnect                                                                                                                                                                                                                                                                                                                    |
| `PUT/GET /recordings/{id}`, `PUT /recordings/{id}/chunks/{sequence}`, `POST /recordings/{id}/complete`, `POST /recordings/{id}/controls/{command}/ack`, `GET /recordings/{id}/live` | bearer | Recording upload, remote pause/resume/stop acknowledgement, live text                                                                                                                                                                                                                                                                                                                  |

The credential is `hex(SHA256("echo-extension-v2\0" + claimSecret + "\0" + requestId + "\0" + installationId + "\0" + libraryId))`. It is deterministic so a retry after a lost response yields the same credential; the server stores only its SHA-256, with the installation id, name and origin. The workspace side (`/api/extensions/...`, same-origin only) lists connections and pending requests, approves or rejects a request, revokes an installation, and mints intents.

At server start, pending pairing rows are cleared; existing connections are preserved.

An Echo-initiated intent (`POST /api/extensions/intent`) is 32 random bytes in hex, valid 120 seconds, single use; only its SHA-256 is kept, in memory.

### Link state and discovery

The extension stores one sealed link state (sealed with the device key): `none`, `waiting {endpoint, requestId, claimSecret, expiresAt}`, or `connected {endpoint, libraryId, credential}`. The popup status derives from it: connected, echo-offline (connected but `/hello` unreachable), revoked (`/connection` returned 401), waiting, none.

Discovery probes `GET /hello` in parallel (700 ms timeout) and takes the first valid answer in this order: the manual address from Setup, the saved endpoint, the origin announced by an open Echo tab, then `http://127.0.0.1:3000`, `http://localhost:3000`, `http://127.0.0.1:3001` to `:3005`.

### Messages from Echo pages

The manifest declares `externally_connectable` for `http://localhost/*` and `http://127.0.0.1/*`. The extension verifies that the sender's origin itself answers `/hello` as Echo before trusting it.

| Message                             | Reply and effect                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `{type:"ECHO_PRESENT"}`             | `{installed:true, version, status}`. Sent by every Echo page on load, which also lets the extension remember the origin                         |
| `{type:"ECHO_APPROVED", requestId}` | Sent right after you click Allow; the extension claims immediately (it also polls every second while waiting)                                   |
| `{type:"ECHO_CONNECT", intent}`     | Opens Setup for confirmation. Reply `{ok:true, status:"confirm-in-extension"}`; Connect then pairs with the intent or requests approval in Echo |

### At-rest encryption (storage v3)

Each recording has a random 32-byte key, wrapped with the non-extractable AES-GCM device key (IndexedDB `credential-device-key`, AAD `["recording-key", recordingId]`). Chunks are AES-GCM encrypted with AAD `["pcm", keyContext, id, seq, frames]`. Title and URL are encrypted; the list and badge read only plaintext summary fields (id, time, status, duration, provider, chunk count, size). Receipts for uploaded recordings are pruned after 7 days.
