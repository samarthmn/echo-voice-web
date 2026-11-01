---
title: Browser extension
description: Install the Echo extension in Brave or Chrome, connect it to your local Echo, and record Google Meet, Zoom and Teams tabs.
---

The Manifest V3 extension (Brave or Chrome 120+) records the audio of a meeting tab, optionally with your microphone, keeps it encrypted in the browser, and uploads it to the local Echo server. It never requests the camera and does not join meetings.

## Install

### Load unpacked (from your checkout)

1. Build it: `./scripts/setup.sh` does this; to rebuild only the extension, run `pnpm build:extension`. Output: `<repo>/extension/dist`.
2. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Choose **Load unpacked** and select the absolute path shown in Echo under **Settings → Browser extension** (it is `<repo>/extension/dist`).
4. Pin the extension to the toolbar.

### Chrome Web Store

A Chrome Web Store listing is planned. Until it is published, load the extension unpacked as above. Both builds connect to your local Echo in the same way, and Echo recognises either one.

### After rebuilding

Click the reload icon on the extension's card. Reloading interrupts a recording in progress. The extension ID is fixed by the `key` in `extension/manifest.json`, so reloading keeps its stored data and connection.

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

## Security notes

The wire protocol is documented in the [HTTP API reference](http-api.md#extension-api-extensionv1). In short:

- Pairing requires a click in extension Setup for an Echo-initiated request, plus approval in Echo if its single-use intent is no longer valid. Extension-initiated pairing requires approval in Echo.
- The server only accepts loopback `Host` headers and `chrome-extension://` origins on `/extension/v1`; the workspace `/api` routes are same-origin only.
- Credentials are bound to the origin that paired and are scoped to recording upload; they cannot read the library, settings, or Calendar tokens.
- Any page served from `localhost` or `127.0.0.1` can message the extension. `ECHO_CONNECT` only opens Setup; it cannot pair or replace a connection without a click there. Setup shows the requested endpoint and identifies any connection being replaced. A `/hello` response alone does not establish trust.
- The device key does not protect against someone who can run your unlocked browser profile.
