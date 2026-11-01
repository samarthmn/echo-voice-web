---
title: Chrome Web Store listing
description: The copy, permission justifications and privacy answers for publishing the Echo extension on the Chrome Web Store.
---

Everything needed to publish the extension, ready to paste into the Chrome Web Store developer dashboard. Publishing is done by hand from the maintainer's developer account.

## Upload

Build the store zip, which leaves out the manifest `key` (the store assigns its own ID):

```bash
node scripts/package-extension.ts --store   # dist/echo-extension-store-<version>.zip
```

Release builds attach the same zip to each GitHub release. After the first upload, put the ID the store assigns into `STORE_EXTENSION_ID` in `scripts/build-extension.ts`, so the Echo web app can talk to the store build as well as the unpacked one.

## Store listing

**Name:** Echo: local meeting recorder

**Summary (132 characters max):**

> Record Google Meet, Zoom and Teams tabs to your own Mac. Transcribed locally by Echo, with no bot in the call and nothing in the cloud.

**Category:** Productivity

**Description:**

```text
Echo records the meetings you join in Brave or Chrome and sends the audio only to Echo, the open-source meeting recorder you run on your own Mac. There is no Echo account and no cloud: transcription, speaker grouping and notes all happen on your computer.

This extension is the recording half of Echo. You need Echo itself running on an Apple Silicon Mac; see https://echo-web.samarthmn.com/docs/install/.

What it does:
• Records the audio of a Google Meet, Zoom (web) or Microsoft Teams (web) tab you have open, and optionally your microphone while you are unmuted.
• Never joins the call as a bot, and never uses your camera.
• Keeps recordings encrypted in the browser until your Echo is reachable, then uploads them to it over localhost.
• Asks you to confirm that participants consented before each recording.

You are responsible for getting consent and following the recording laws where you and the other participants are.

Echo is free and open source (MIT): https://github.com/samarthmn/echo-voice-web
```

**Screenshots (1280×800):** `brand/store/screenshot-1.png` to `screenshot-4.png`.

**Small promo tile (440×280):** `brand/store/tile-440x280.png`. **Icon:** `brand/store/icon-128.png`.

**Homepage:** <https://echo-web.samarthmn.com>. **Support:** <https://github.com/samarthmn/echo-voice-web/issues>.

## Single purpose

> Record the audio of a meeting tab the user is in, and deliver it to the user's own locally running Echo app for transcription.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `tabCapture` | Captures the audio of the meeting tab the user chooses to record. This is the extension's core function. |
| `activeTab` | Identifies the meeting tab the user is on when they open the popup or press the recording shortcut. |
| `offscreen` | Manifest V3 service workers cannot process audio; an offscreen document mixes and encodes the captured audio while recording. |
| `scripting` | Injects the meeting-page observer into the meeting sites the user enables, to detect an open meeting and the microphone mute state. |
| `storage` | Keeps settings and the connection to the user's local Echo. |
| `unlimitedStorage` | Holds encrypted recordings in the browser until the user's Echo is reachable, so a long meeting is not lost while Echo is closed. |
| `alarms` | Retries uploads to the local Echo on a schedule while it is unreachable. |
| Optional host access to `meet.google.com`, `*.zoom.us`, `app.zoom.com`, `teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft` | Requested only for the meeting services the user enables, to detect meetings and mute state on those pages. |
| Host access to `http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*` | Uploads recordings to the Echo app running on the user's own computer. No other server is contacted. |

Check this table against `extension/manifest.json` before each submission; the manifest is the source of truth.

## Privacy practices

- **Data collected:** none by the developer. Audio is captured only when the user starts a recording and is sent only to the user's own Echo on localhost.
- **Remote code:** none. All code is in the package.
- **Data use certifications:** the developer does not sell or transfer user data to third parties, does not use it for unrelated purposes, and does not use it for creditworthiness or lending.
- **Privacy policy URL:** <https://echo-web.samarthmn.com/privacy/>
