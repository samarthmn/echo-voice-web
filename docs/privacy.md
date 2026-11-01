---
title: Privacy
description: Every network request the Echo app can make, when it makes it, and what it sends. Echo has no telemetry.
---

Echo has no accounts, no telemetry, no analytics, no crash reporting and no update checks. Your recordings, transcripts and notes never leave your Mac. This page lists every network request the self-hosted app and extension can make.

## Requests to the internet

| When | Destination | What is sent |
| --- | --- | --- |
| You download Whisper Large V3 Turbo or the speaker models | `huggingface.co` (from your browser) | Standard requests for public model files |
| You download Whisper Large V3 | `huggingface.co` (from the Node helper Echo starts) | Standard requests for public model files |
| You connect Google Calendar, and while it is connected | `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `www.googleapis.com` | The OAuth sign-in with your own client, then read-only requests for your primary calendar's events |

Nothing else. Speech recognition, speaker grouping and note writing run on your Mac.

## Requests on your Mac

| From | To | Why |
| --- | --- | --- |
| The Echo web app | Echo's server at `localhost` | Everything the app does |
| The extension | Echo's server at `localhost` or `127.0.0.1`, ports 3000–3005 or the address you set | Finding Echo, pairing, uploading recordings |
| Echo's server | Ollama at `127.0.0.1:11434` (or the loopback URL you set) | Generating notes, listing and pulling models |

When you pull a model from **Models → Local notes**, Echo asks your local Ollama to download it; Ollama fetches it from its own registry.

## The browser extension

The extension can read pages only on the meeting sites you enable (Google Meet, Zoom web, Teams web), to know when a meeting is open and whether you are muted. It captures audio only after you start a recording. It sends audio only to your own Echo server, never anywhere else. It does not use the camera.

## The website

The project website, echo-web.samarthmn.com, is separate from the app. It uses cookieless Cloudflare Web Analytics; see the [site privacy page](https://echo-web.samarthmn.com/privacy/). The app never loads anything from the website.
