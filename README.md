# Echo

Echo is a single-user meeting recorder and transcriber that runs entirely on your Mac. A local server keeps an encrypted library; transcription runs on-device with Whisper; a Brave/Chrome extension records meeting tabs (Meet, Zoom web, Teams web) and uploads them to the server. Notes come from local Ollama.

## Requirements

- Apple Silicon Mac (macOS 14+)
- Xcode command line tools, Rust (rustup), Node.js 22.18+, pnpm
- Brave or Chrome
- Optional: [Ollama](https://ollama.com/download) for local notes

## Quick start

```bash
git clone https://github.com/samarthmn/echo-voice-web.git && cd echo-voice-web
./scripts/setup.sh      # installs dependencies and builds everything
./scripts/start.sh      # serves Echo on http://localhost:3000
open http://localhost:3000
# Brave/Chrome: brave://extensions -> Developer mode -> Load unpacked -> extension/dist
```

Prerequisite details: [docs/install.md](docs/install.md). Extension setup: [docs/extension.md](docs/extension.md).

## Daily use

1. Run `./scripts/start.sh` (or install the launchd agent, see [start at login](docs/auto-start.md)) and open <http://localhost:3000>.
2. Before important recordings, save the library recovery phrase in **Settings → Storage → Protect your library**.
3. Meetings: join normally, open the Echo extension popup, confirm consent, **Start recording**. In person: **New meeting → In person**. Existing audio: **Upload a recording**.
4. Download a speech model under **Models**, then open the meeting and choose **Create transcript**.
5. Optionally generate notes from the meeting's **Notes** tab.
6. Export a backup from **Settings → Storage → Export library** now and then.

## Documentation

The full documentation is in [`docs/`](docs/index.md) and on [echo-web.samarthmn.com/docs](https://echo-web.samarthmn.com/docs/).

| Start here | |
| --- | --- |
| [Requirements](docs/requirements.md) and [install](docs/install.md) | From a fresh Mac to a running Echo |
| [Browser extension](docs/extension.md) and [recording](docs/recording.md) | Recording meetings |
| [Configuration](docs/configuration.md), [backups and recovery](docs/backups-and-recovery.md) | Running it day to day |
| [Security model](docs/security-model.md) and [privacy](docs/privacy.md) | What stays on your Mac, and why |
| [Development](docs/development.md) | Building, testing and contributing |
