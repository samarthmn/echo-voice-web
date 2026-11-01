---
title: Install
description: Install Echo on a fresh Apple Silicon Mac, step by step, and start it for the first time.
---

This page takes a fresh Mac to a running Echo in about ten minutes, plus download time. Every command runs in Terminal.

## 1. Install the developer tools

```bash
xcode-select --install
```

Follow the dialog, then confirm it worked with `xcode-select -p`.

## 2. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Accept the defaults, then open a new Terminal window (or run `source "$HOME/.cargo/env"`) and check `cargo --version`.

## 3. Install Node.js and pnpm

Echo needs Node.js 22.18 or newer. With [Homebrew](https://brew.sh):

```bash
brew install node pnpm
node --version   # v22.18.0 or newer
```

Any other Node installer works too (nvm, fnm, the nodejs.org package). For pnpm, `corepack enable` is an alternative to Homebrew.

## 4. Get the code

```bash
git clone https://github.com/samarthmn/echo-voice-web.git
cd echo-voice-web
```

## 5. Build everything

```bash
./scripts/setup.sh
```

`setup.sh` checks the prerequisites, then:

1. adds the `wasm32-unknown-unknown` Rust target, runs `pnpm install --frozen-lockfile`, and installs the `wasm-bindgen-cli` version pinned in `Cargo.lock`;
2. builds the browser assets and the extension (output in `extension/dist`);
3. builds the Dioxus web app to WebAssembly;
4. builds the release server, `target/release/echo-server`.

The first run takes a few minutes. It never downloads speech or Ollama models. To rebuild after a change without reinstalling tools, run `./scripts/setup.sh --build-only`.

## 6. Start Echo

```bash
./scripts/start.sh
```

It checks the build outputs and that the port is free, then runs the server in the foreground. Open <http://localhost:3000>. Press Ctrl+C in Terminal to stop it.

The first time Echo opens its library, macOS asks to let `echo-server` use the Keychain. Choose **Always Allow**: the library key lives there.

To start Echo automatically at login instead, see [auto-start](auto-start.md).

## 7. Install the browser extension

1. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `extension/dist` folder inside your checkout. Echo shows the exact path under **Settings → Browser extension**.
3. Pin the extension and choose **Connect to Echo** in its popup. Approve the request in the Echo tab that opens.

Details are on the [extension](extension.md) page.

## 8. Protect your library

Before recording anything important, open **Settings → Storage → Protect your library** and save the 24-word recovery phrase. It is the only way back in if the Keychain key is lost. See [backups and recovery](backups-and-recovery.md).

## Next

- [Your first recording](first-recording.md)
- Optional: [local notes with Ollama](notes-ollama.md) and [Google Calendar](calendar.md)
- If something fails: [troubleshooting](troubleshooting.md)
