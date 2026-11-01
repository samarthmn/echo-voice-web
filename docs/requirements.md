---
title: Requirements
description: Hardware, software and disk space you need to run Echo on your Mac.
---

## Hardware

| | Requirement |
| --- | --- |
| Computer | A Mac with Apple Silicon (M1 or later). `setup.sh` refuses to run on other machines. |
| macOS | macOS 14 Sonoma or later |
| Memory | 16 GB recommended. Speech models, the browser and an Ollama model all share memory while they run |
| Disk | About 5 GB for the build, Node packages and speech models, plus your recordings (see below) |

## Software

| Tool | Why |
| --- | --- |
| Xcode command line tools | Compilers for the Rust server |
| Rust (via rustup) | Builds the server and the web app. `setup.sh` adds the WebAssembly target and the pinned `wasm-bindgen-cli` |
| Node.js 22.18 or newer | Builds the web assets, and runs Whisper Large V3 at runtime |
| pnpm | Installs the JavaScript dependencies |
| Brave or Chrome 120+ | Runs the Echo web app and the recording extension |
| Ollama (optional) | Generates meeting notes locally |

[Install](install.md) walks through each one on a fresh Mac.

## Disk space for recordings

Echo stores meeting audio as encrypted 16 kHz mono PCM, about **115 MB per hour** of recording. Uploaded files are stored as they are, so their size depends on the format. Transcripts and notes are small by comparison.

| Item | Size |
| --- | --- |
| One hour of recorded meeting audio | about 115 MB |
| Whisper Large V3 Turbo, with the speaker models | about 1.2 GB, cached in the browser |
| Whisper Large V3 | about 1.7 GB, under the data folder |
| A recommended Ollama model (`qwen2.5:3b`, `llama3.2:3b`, `gemma3:4b`) | about 2–3.5 GB each, stored by Ollama |

Models are downloaded once, when you choose to. Echo never downloads them on its own.

## Network

Echo needs the internet only to build it and to download the models you pick. After that, recording, transcription and notes work offline. See [privacy](privacy.md) for every request Echo can make.
