# Browser extension

The Manifest V3 extension (Brave or Chrome 120+) records the audio of a meeting tab, optionally with your microphone, keeps it encrypted in the browser, and uploads it to the local Echo server. It never requests the camera and does not join meetings.

## Install

1. Build it: `./scripts/setup.sh` does this; to rebuild only the extension, run `pnpm build:extension`. Output: `<repo>/extension/dist`.
2. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Choose **Load unpacked** and select the absolute path shown in Echo under **Settings → Browser extension** (it is `<repo>/extension/dist`).
4. Pin the extension to the toolbar.

After rebuilding, click the reload icon on the extension's card. Reloading interrupts a recording in progress. The extension ID is fixed by the `key` in `extension/manifest.json`, so reloading keeps its stored data and connection.

## Connect

Either way, you approve once in Echo and nothing needs to be copied.

- **From the extension:** open the popup (or **Setup**) and choose **Connect to Echo**. It finds the server, opens an Echo tab asking "Allow this browser to send recordings to Echo?", and you choose **Allow**. The extension closes that tab itself.
- **From Echo:** open Echo, go to **Settings → Browser extension**, and choose **Connect browser extension**. If the extension is installed, this connects in one click. If not, the panel shows the install steps.

If you change Echo's port or discovery fails, enter the address under **Advanced** in the Setup page. A pending request expires after 10 minutes; **Cancel** withdraws it. Echo also shows the same Allow dialog on any page while a request is pending.

## Setup page

Open it from the popup's **Setup** button. Three steps:

1. **Connect to Echo**
2. **Meeting sites**: enable the services you use (Google Meet, Zoom Web, Microsoft Teams Web). Access is requested only for the ones you enable.
3. **Microphone**: **Allow microphone**, or **Record call audio only**.

It also lists **Local recordings & recovery** with retry and WAV export.

## Recording a meeting

Supported: Google Meet, Zoom web, and Teams web, in an existing tab in your browser. Join the meeting, then open the popup while that tab is selected.

1. Set a title, optionally tick **Include my microphone** and **Show live text in Echo**.
2. Tick **Participants have consented to recording.**
3. **Start recording.** Tab audio stays audible; closing the popup or switching tabs does not change what is recorded.
4. **Pause**, or **Stop & save**. Leaving the call, closing the tab or navigating away also ends the capture. Closing the whole browser interrupts it; the audio saved so far is kept.

**Shortcuts and remembered choices.** A grey **●** on the Echo icon means the current tab is a supported meeting that is ready to record. Tick **Remember for Google Meet** (or Zoom Web / Teams Web) next to the consent box to keep consent for that service; the live-text choice is remembered too. With consent remembered, **Control+Shift+R** on Mac (**Alt+Shift+R** elsewhere) starts recording the current meeting tab and stops it again. Without remembered consent, the shortcut opens the popup instead. Change the keys at `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`.

Your microphone is mixed in only while the extension positively sees an active, unmuted call. If the mute state is unknown, stale or conflicting, your voice is left out and a warning is shown. On Google Meet and Teams the mute state comes from the call's own button attributes, so any interface language works; on Zoom the extension reads the English mute button labels. During a recording, **Exclude my microphone** drops your voice regardless of mute state.

Limits: one recording at a time per browser profile, eight hours per recording, 2 GiB of pending audio. If storage runs out, capture stops and keeps what was saved.

## Offline behaviour

Audio is journaled in the browser's IndexedDB, encrypted with a non-extractable device key, in roughly one-second chunks. Echo does not need to be running. When the server is reachable and the extension is connected, pending recordings upload automatically. The popup footer shows "Echo is offline" in the meantime. The extension deletes its copy only after Echo confirms a complete import. If the connection was revoked, pending audio is kept until you connect again.

Uninstalling the extension or clearing its data deletes recordings not yet uploaded. From **Setup → Local recordings & recovery** you can export a recording as WAV parts of at most 30 minutes plus a timeline file; exports are not encrypted.

## Live text

If **Show live text in Echo** is on, an open Echo tab with the Turbo model downloaded produces provisional text while recording. Recording never depends on it. After upload, the final transcript is created in Echo with your chosen model and speaker grouping.

## Disconnect

Use **Disconnect this browser** in Setup, or **Settings → Browser extension → Disconnect** in Echo (revoke). Pending audio stays in the browser.

## Troubleshooting

| Symptom                                                           | Fix                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| "Echo isn't running on this Mac"                                  | Start it with `./scripts/start.sh`, then **Retry**                                                         |
| Cannot find Echo on a custom port                                 | Open Echo in the browser once, or set the address under **Advanced** in Setup                              |
| Waiting for approval forever                                      | Open the Echo tab (**Show Echo tab**) and click **Allow**; the request expires after 10 minutes            |
| "Echo disconnected this browser"                                  | The connection was revoked. **Connect again**; pending audio is kept                                       |
| Microphone missing from the recording                             | Check the mute state in the meeting, microphone permission in Setup, and that the meeting UI is in English |
| "Open a supported Google Meet, Zoom Web or Teams Web meeting tab" | Select the meeting tab before clicking the popup                                                           |
| "Connect to Echo to unlock this older recording."                 | It was encrypted by a retired scheme; connect to Echo so it can be migrated                                |

## Protocol

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
| `GET /vault`, `DELETE /vault`                                                                                                                                                       | bearer | Migration only, see below                                                                                                                                                                                                                                                                                                                                                              |

The credential is `hex(SHA256("echo-extension-v2\0" + claimSecret + "\0" + requestId + "\0" + installationId + "\0" + libraryId))`. It is deterministic so a retry after a lost response yields the same credential; the server stores only its SHA-256, with the installation id, name and origin. The workspace side (`/api/extensions/...`, same-origin only) lists connections and pending requests, approves or rejects a request, revokes an installation, and mints intents.

An Echo-initiated intent (`POST /api/extensions/intent`) is 32 random bytes in hex, valid 120 seconds, single use; only its SHA-256 is kept, in memory.

### Link state and discovery

The extension stores one sealed link state (sealed with the device key): `none`, `waiting {endpoint, requestId, claimSecret, expiresAt}`, or `connected {endpoint, libraryId, credential}`. The popup status derives from it: connected, echo-offline (connected but `/hello` unreachable), revoked (`/connection` returned 401), waiting, none.

Discovery probes `GET /hello` in parallel (700 ms timeout) and takes the first valid answer in this order: the manual address from Setup, the saved endpoint, the origin announced by an open Echo tab, then `http://127.0.0.1:3000`, `http://localhost:3000`, `http://127.0.0.1:3001` to `:3005`.

### Messages from Echo pages

The manifest declares `externally_connectable` for `http://localhost/*` and `http://127.0.0.1/*`. The extension verifies that the sender's origin itself answers `/hello` as Echo before trusting it.

| Message                             | Reply and effect                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `{type:"ECHO_PRESENT"}`             | `{installed:true, version, status}`. Sent by every Echo page on load, which also lets the extension remember the origin |
| `{type:"ECHO_APPROVED", requestId}` | Sent right after you click Allow; the extension claims immediately (it also polls every second while waiting)           |
| `{type:"ECHO_CONNECT", intent}`     | Echo-initiated connect: `POST /pair` with the intent, then claim. Reply `{ok, status}`                                  |

### At-rest encryption (storage v3)

Each recording has a random 32-byte key, wrapped with the non-extractable AES-GCM device key (IndexedDB `credential-device-key`, AAD `["recording-key", recordingId]`). Chunks are AES-GCM encrypted with AAD `["pcm", keyContext, id, seq, frames]`. Title and URL are encrypted; the list and badge read only plaintext summary fields (id, time, status, duration, provider, chunk count, size). Receipts for uploaded recordings are pruned after 7 days.

### Migration of older recordings

Earlier versions encrypted recordings under a separate "vault" identity. The server still holds escrowed vault records for such installations (`GET/DELETE /vault`). On startup the extension rewraps each older recording's key under the device key without re-encrypting the audio, recovering the vault key from the escrow. A recording that cannot be unlocked yet keeps its audio and shows "Connect to Echo to unlock this older recording." Once no older recordings remain and the extension is connected, it calls `DELETE /vault` to remove its escrow record (a 404 counts as already removed). At server start, pending (not yet approved) pairing rows are cleared; existing connections are untouched.

## Security notes

- Pairing needs an explicit approval in Echo (or a single-use intent that Echo created when you clicked **Connect browser extension**). Nothing else creates a credential.
- The server only accepts loopback `Host` headers and `chrome-extension://` origins on `/extension/v1`; the workspace `/api` routes are same-origin only.
- Credentials are bound to the origin that paired and are scoped to recording upload; they cannot read the library, settings, or Calendar tokens.
- Any page served from `localhost` or `127.0.0.1` can message the extension (that is what `externally_connectable` allows). So `ECHO_CONNECT` only pairs an extension that is not already connected, and only with a server that answers `/hello` as Echo. An unrelated local web server cannot take over an existing connection.
- The device key does not protect against someone who can run your unlocked browser profile.
