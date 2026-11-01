---
title: Troubleshooting
description: Fixes for common Echo problems, from build errors to a locked library and an extension that will not connect.
---

## Setup and start

| Symptom | Fix |
| --- | --- |
| `Echo requires Apple Silicon macOS.` | Echo only runs on Apple Silicon Macs |
| `Install Node.js 22.18 or newer.` | Upgrade Node (`brew upgrade node`), open a new Terminal, rerun `setup.sh` |
| `Build outputs missing` | Run `./scripts/setup.sh` |
| `Port N is in use` | Find the process with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, or use another port: `ECHO_BIND=127.0.0.1:3100 ./scripts/start.sh` (see [configuration](configuration.md#changing-the-port)) |
| `The bind address must be a loopback IP and port` | `bind` must look like `127.0.0.1:3000`; Echo never listens on other interfaces |
| Build fails after `git pull` | Run `./scripts/setup.sh` (not `--build-only`) so dependencies match the lockfiles |

## The library

| Symptom | Fix |
| --- | --- |
| Library locked, or the Keychain key is unavailable | Unlock the login keychain, allow Echo's Keychain prompt, and restart. After rebuilding, macOS asks again for the new binary |
| The Keychain key is gone | [Recover with the phrase](backups-and-recovery.md#recovering-a-library) |
| "Another Echo Voice server is using this data folder" | Only one server can open a data folder. Stop the other one (`start.sh`, `dev.sh` or the launchd agent) |
| Echo refuses a library written by a newer version | Update Echo; it never downgrades a migrated library |

To check a library offline, stop Echo and run `./target/release/echo-server --check-library` (see [CLI](cli.md)).

## Transcription

| Symptom | Fix |
| --- | --- |
| Speech model not ready | Download it under **Models → Speech models**. Needs the internet once |
| Turbo downloads again | It is cached per origin; a new port or host name means a new download |
| Large V3 unavailable | It needs Node.js 22.18+ on the server's `PATH` and the packages from `pnpm install`. Use **Check engine** on its model card. Under launchd, rerun `install-service.sh` after changing Node |
| Transcription stopped | Keep the Echo tab open while Turbo transcribes; reopen the meeting and choose **Create transcript** to retry |

## Notes

| Symptom | Fix |
| --- | --- |
| Ollama not reachable | Start Ollama, then **Models → Local notes → Check connection**. The URL must be loopback (default `http://127.0.0.1:11434`) |
| The saved model is not installed | Download it in **Models → Local notes**, or pick another installed model |

## The extension

| Symptom | Fix |
| --- | --- |
| "Echo isn't running on this Mac" | Start Echo, then **Retry** |
| Cannot find Echo on a custom port | Open Echo in the browser once, or set the address under **Advanced** in Setup |
| Waiting for approval forever | Open the Echo tab (**Show Echo tab**) and choose **Allow**; requests expire after 10 minutes |
| "Echo disconnected this browser" | The connection was revoked. **Connect again**; pending audio is kept |
| My voice is missing from the recording | Check you were unmuted in the meeting and that microphone access is allowed in Setup. On Zoom the extension reads the English mute labels |
| "Open a supported Google Meet, Zoom Web or Teams Web meeting tab" | Select the meeting tab before opening the popup |

More on the [extension](extension.md#troubleshooting) page.

## Logs

- `start.sh` prints the server log to Terminal.
- The launchd agent logs to `~/Library/Logs/Echo Voice/server.log`.
- Set `RUST_LOG=debug` for more detail.
- The extension's service worker log is under **Inspect views** on its card at `brave://extensions` or `chrome://extensions`.

If you are stuck, [open an issue](https://github.com/samarthmn/echo-voice-web/issues) with the symptom, your macOS and browser versions, and relevant log lines. Never paste recovery phrases, OAuth secrets or meeting content.
