---
title: What Echo is
description: Echo is an open-source meeting recorder, transcriber and note-taker that you run on your own Mac. Nothing leaves your computer.
---

Echo records your meetings, transcribes them with Whisper and writes notes with a local language model, all on your own Mac. It is an open-source, self-hosted alternative to cloud notetakers such as Fireflies, Otter.ai and Fathom.

## What Echo is

- **A product you run yourself.** You build Echo from source and run it on your laptop. There is no Echo account, no Echo cloud and no subscription.
- **Local by design.** The server binds only to your Mac's loopback address. Audio, transcripts and notes are stored in an encrypted library on your disk. Speech recognition runs on your Mac; notes come from [Ollama](https://ollama.com) running on your Mac.
- **No bot in your call.** A browser extension records the meeting tab you are already in (Google Meet, Zoom web, Microsoft Teams web). Nobody sees a "notetaker has joined" tile.
- **For one person.** Echo is a single-user tool: your meetings, on your computer.

## What Echo is not

- **Not a service.** Nobody operates Echo for you, and the project never receives your recordings. The public website only hosts documentation.
- **Not a team product.** There is no sharing, no multi-user workspace and no admin console.
- **Not a packaged app (yet).** Echo runs from a source checkout. You need to be comfortable with Terminal.
- **Not for every platform.** Echo targets Apple Silicon Macs and the Brave or Chrome browser.

## How it fits together

1. The **browser extension** captures the meeting tab's audio, and optionally your microphone, and keeps it encrypted in the browser until Echo is reachable.
2. The **Echo server** (Rust) stores everything in an encrypted SQLCipher library whose key lives in the macOS Keychain.
3. The **Echo web app**, open at `http://localhost:3000`, transcribes with Whisper, groups speakers, and lets you review, edit and export.
4. **Ollama** turns a transcript into notes, if you install it.

## Next steps

- Check the [requirements](requirements.md).
- [Install Echo](install.md) on a fresh Mac.
- Make your [first recording](first-recording.md).
