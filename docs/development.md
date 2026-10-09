# Developer guide

Use this guide to build Echo, run checks, or prepare a package. For everyday recording and setup, start with the [README](../README.md). The [documentation index](README.md) separates current guides, release work, and historical evidence.

The local web server and extension are being qualified on Apple Silicon macOS 14+ and Ubuntu 24.04 x64. Windows/WSL is unqualified. No packaging command publishes a release. Consult the [extension qualification matrix](extension-qualification.md) for actual browser/service results.

- [Build and start](#build-and-start)
- [Develop the extension](#develop-the-extension)
- [Configuration](#configuration)
- [Run tests](#run-tests)
- [Package the local app](#make-a-downloadable-package) or [publish the extension](extension-publishing.md)

## Install the build tools

Install stable Rust through `rustup`, Node.js 22 or newer with npm, Git, Bash, and a C toolchain for bundled SQLite. Python 3 is needed for extension packaging and Python tests. There is no separate database service or meeting-runner runtime to install.

### Ubuntu or Debian

Install the system prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev libdbus-1-dev git curl
```

Install the default stable Rust toolchain from [rustup.rs](https://rustup.rs/), then install Node.js 22 or newer using the [Node.js installation instructions](https://nodejs.org/en/download).

### macOS

Install Apple's command-line tools:

```bash
xcode-select --install
```

Complete the installation window, then install stable Rust and Node.js as above. Build on the Mac itself; the Linux package won't run there. The source app has been exercised on macOS. Meeting capture uses the browser extension in an existing Brave or Chrome session; see the [extension guide](browser-extension.md).

### Windows with WSL

WSL is an experimental source-build route, not a supported installer. Follow [Microsoft's WSL setup](https://learn.microsoft.com/en-us/windows/wsl/install), then install the Ubuntu prerequisites inside WSL. Windows browser access to the Linux server, microphone permissions, callback addresses, extension capture, and local Ollama access still require qualification. A successful Linux build does not verify those boundaries.

### Check your tools

Reopen the terminal after installing Rust and Node.js. Each command should print a version:

```bash
rustc --version
cargo --version
rustup --version
node --version
npm --version
python3 --version
```

If a command isn't found, finish its installation before building. The Node.js version must be `v22` or later.

## Build and start

```bash
git clone https://github.com/samarthmn/echo-voice-web.git
cd echo-voice-web
bash scripts/build.sh
bash scripts/start.sh
```

Use a GitHub account with repository access if required. You can also extract **Code → Download ZIP**, open a terminal in that extracted folder, and run the two scripts there. Its folder name may differ from `echo-voice-web`.

The build script installs the WASM target, runs `npm ci --ignore-scripts`, builds browser assets and the extension, installs the matching `wasm-bindgen` CLI, and builds the release app and server. It does not download speech or Ollama models.

Open [http://localhost:3000](http://localhost:3000) and keep the terminal open. The compiled app and browser-based Turbo model don't need Rust or Node.js at runtime. Full Large V3 requires Node.js 22+ and the dependencies installed by `npm ci --ignore-scripts`; the server supervises its native CPU helper. An optional Codex npm wrapper may also need Node.js; a bundled Codex executable doesn't.

## Find and change the code

| Folder | Contents |
| --- | --- |
| `app/src/` | Dioxus components and browser interface |
| `server/src/` | Axum REST APIs, SQLite/file storage, and integrations |
| `web/` | Browser recording and speech-inference bridges |
| `public/` | Styles, fonts, and generated browser assets |
| `extension/` | MV3 TypeScript audio capture, journal, adapters and connection UI |
| `tests/` | JavaScript, REST, Python, and browser tests |
| `docs/` | Architecture, setup, coverage, and review records |

Rust server tests also live alongside the server code. See the [architecture guide](architecture.md) for how the parts connect.

Rebuild after changing Rust UI or browser bridge code, then reload the browser. For server changes, stop the server, rebuild, and restart. App CSS changes only need a browser reload. `cargo check` does not regenerate browser bundles; the start script does not provide hot reload.

## Develop the extension

```bash
npm run build:extension
```

Load `extension/dist` through **Load unpacked** in Chrome or Brave's extension manager. Follow [installation and recording](browser-extension.md): save the extension recovery phrase, choose Connect to Echo, and approve once in the app. Codes/custom addresses remain under Advanced.

Rebuild after extension changes and reload the unpacked installation. Finish active recordings and verify saved audio before reloading; reloads can interrupt capture. The stable development ID is derived from the manifest's public key. Store identity and migration need a deliberate check; see [publishing](extension-publishing.md#3-create-the-store-draft-and-establish-its-identity).

Use an isolated test library for recording experiments. Keep generated audio, profiles, screenshots, and logs under this repository's `tmp/` directory; delete only scratch created for your review. Never aim fixture scripts at an everyday meeting library. Current capture does not require Docker, a separate meeting browser, or the retired Python runner. The native Large V3 speech helper is separate and remains in use.

## Configuration

Basic recording works with the shipped `echo.config.json`. Public runtime settings are initialized once at startup from that file; edit it and restart the server after changing settings.

| Config field | Use |
| --- | --- |
| `bind` | Default `127.0.0.1:3000`. Only loopback IP listeners are accepted; public and wildcard interfaces are rejected. |
| `dataDir` | Library location, default `.echo-data` in the project. The extension pairs explicitly to one library. |
| `googleRedirectUri` | Calendar callback, default `http://localhost:3000/api/integrations/google/callback`. Match it in Google Cloud Console. |
| `codexBinary` | Optional path to the official Codex 0.160.0 executable; `null` enables bundled/npm/PATH discovery. |
| `runner` | Deprecated configurations are accepted and ignored; new configuration omits this section. |

Only optional Google Calendar web-client credentials belong in `.env`:

```bash
cp .env.example .env
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, register the matching callback and restart the server; follow the [Calendar setup](integrations.md#configure-the-local-server). There is no OpenAI API-key setting or API-billing fallback. ChatGPT uses account sign-in through Models. No origin override is supported for this local product.

Extension credentials are generated by user-approved pairing and stored hashed by Echo. The extension encrypts its scoped credential with a nonextractable browser device key in trusted extension storage. This is not protection against a runnable stolen browser profile. Portable backups exclude credentials; re-pair after restoring into a different library. Pairing and revocation must not weaken ordinary `/api` same-origin protections.

For isolated development/tests, shell overrides `ECHO_BIND`, `ECHO_DATA_DIR`, and `ECHO_CODEX_BIN` remain available. `ECHO_CONFIG_FILE` selects an alternate shared JSON file. These overrides are not needed in a user's `.env`; the listener still enforces loopback. For a different Calendar port, also update `googleRedirectUri` and the registered Google redirect. A different origin has a separate speech-model cache.

Configure Ollama in Echo's Settings. The default address is `http://127.0.0.1:11434`; only local connections are accepted. To download the default model from a terminal:

```bash
ollama pull qwen2.5:3b
```

ChatGPT requires the pinned version, OS keyring credentials and a protected helper runtime. macOS uses a native encrypted image and Linux uses an owned verified tmpfs location; failure to obtain protected storage disables the optional integration rather than falling back to plaintext. It doesn't read an existing Codex login or use an OpenAI API key. See the [ChatGPT guide](chatgpt.md) for installation, sign-in, account limits, and recovery.

## Storage and large-library backups

Check **Settings → Storage** for the actual data path. Default locations are:

| Data | Location |
| --- | --- |
| Meeting text, settings, vocabulary, and versions | `.echo-data/workspace.sqlite` |
| Recorded and imported audio | `.echo-data/audio/` |
| ChatGPT credentials and helper state | OS keyring and protected helper runtime; not included in portable backups |
| Google credentials | Private server data folder |
| Turbo and speaker models | Browser profile storage for the app's origin |
| Full Large V3 speech model | `.echo-data/models/native-large-v3/` |
| Ollama models | Ollama's model folder |
| Pending extension recordings | Extension profile IndexedDB; transferred to the paired Echo library after durable acknowledgement |
| Legacy Meet guest recordings | Existing data folder's `bot/<meeting-id>/meeting.wav`; see [recovery](extension-migration.md) |

Supported library exports include imported audio and meeting data but exclude credentials, models, executables, and audio still pending in the extension. Synchronize or export that pending audio separately. Restoring requires an empty library and vocabulary. Per-meeting data exports exclude audio; use original-track downloads or a full library backup when you need audio too.

For libraries beyond the in-app backup limit, finish recordings and processing, stop Echo, then copy the **whole data folder**. If an old installation still has a meeting runner, complete its [shutdown/recovery](extension-migration.md) first. Keep the copy private because it can include account credentials. The database uses SQLCipher; audio and sensitive file metadata use authenticated encryption. The OS keyring holds the library master key. Copy protection/recovery metadata with the library and retain its recovery phrase separately. Browser pending audio uses a separate recovery identity. Only one server can own a library at a time; do not delete lock files to bypass a running server.

Browser uploads accept supported audio/video containers up to 500 MB. In-app library restore has a smaller limit, including a 180 MB audio limit. Speech decoding is bounded to 512 MB or two hours; legacy finalized WAV recovery is limited to 512 MB; extension recordings use sequential 30-minute processing parts. Large recordings can exhaust browser memory or take substantial CPU time. Independent exports and backups remain after deleting a meeting in Echo.

## Browser inference and isolation

Echo serves `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for ONNX WebAssembly CPU threads. The worker uses half the reported CPU cores, capped at four, and falls back to one thread without cross-origin isolation. Bundled JavaScript/WASM use the local origin; model downloads use CORS.

Calendar sign-in uses top-level navigation, and ChatGPT sign-in does not depend on an opener. Check these policies when adding embedded assets or popup integrations. See [ONNX threading](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html), [browser isolation](https://web.dev/articles/coop-coep), and [native Large V3](native-speech.md).

## Update a source checkout

Back up the library, note its location, finish recordings, and stop Echo first. Follow [runner migration](extension-migration.md) if updating an older installation that still captures through its retired helper. For an unmodified Git checkout:

```bash
git pull --ff-only
bash scripts/build.sh
bash scripts/start.sh
```

If Git reports local changes or conflicts, resolve them without deleting work. For a source ZIP, extract the new version into a separate folder, build it, and follow the README's [data transfer steps](install.md#existing-library). Keep the old app and backup until meetings and audio work in the new version.

## Run tests

Build first to create the release server and current browser assets. Install Playwright's Chromium and Linux system dependencies if needed. Keep scratch in the repository:

```bash
mkdir -p tmp
export TMPDIR="$PWD/tmp"
npx playwright install --with-deps chromium
export CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "@playwright/test"; process.stdout.write(chromium.executablePath())')"
cargo build --locked -p echo-server
export ECHO_TEST_BINARY=target/debug/echo-server

cargo test --locked -p echo-server
cargo fmt --all -- --check
cargo clippy --locked -p echo-server --all-targets -- -D warnings
cargo check --locked -p echo-app --target wasm32-unknown-unknown
npm test
python3 -B -m unittest discover -s tests -p '*_test.py' -v
npm run test:extension
npm run test:e2e
```

Installing Linux browser dependencies may need administrator permission. If a compatible Chromium is already installed, set `CHROMIUM_PATH` to that executable's absolute path. Tests default to `/usr/bin/chromium`.

HTTP/browser fixtures use a debug binary with an explicit isolated data directory and a synthetic test key. This still exercises encrypted storage without accessing the user's OS keyring. Release binaries deliberately reject that key override; verify the boundary with `node --test tests/release-key-policy.test.mjs` after building release. Do not weaken the release key policy to make headless CI work.

Run `node --test tests/protected-storage.test.mjs tests/extension-pairing.test.mjs` for protected storage and authorization. Real OS keyring, recovery and browser qualification must use no test-key override.

`npm test` covers inference, recording, REST lifecycle, and simulated account responses. `npm run test:extension` includes extension unit, runtime integration, and layout checks; `npm run test:extension:unit` is the faster subset. `npm run test:e2e` creates isolated libraries and exercises the application recording/import/review/settings/accessibility flows. These fixtures do not establish live provider compatibility or speech accuracy.

The [CI workflow](../.github/workflows/verify.yml) is the authoritative automated command list, including the pinned Codex helper smoke check. It runs on pushes to `main` and pull requests. Current outcomes and gaps are in the [PR review](pr-review-2026-10-08.md), [extension review](extension-review.md), and [qualification matrix](extension-qualification.md). The [original verification record](verification.md) describes an earlier implementation, not the current full test count.

## Make a downloadable package

The web server and source archives are developer artifacts, not a GUI installer. Build on the matching platform; packaging does not cross-compile or publish.

```bash
bash scripts/build.sh
node scripts/package.mjs
```

`package.mjs` produces a Linux x64 server archive and source archive using Git-tracked files. Inspect the exact contents before distribution; keep credentials, libraries, logs and recordings out. The native Large V3 runtime remains a separate prerequisite described in [native speech setup](native-speech.md).

The extension is packaged separately:

```bash
npm run package:extension
```

This produces `artifacts/echo-extension-<manifest-version>.zip`. It does not upload or publish it. Follow the [Chrome/Brave publishing guide](extension-publishing.md) for account setup, store identity, local-app prerequisites, privacy, screenshots, review, and update testing.

## Diagnose build and runtime errors

- Missing `cargo`, `rustup`, `node`, or `npm`: finish installing the tool and reopen the terminal. Under WSL, install inside Ubuntu.
- Missing compiler/linker or `cc`: install your OS build tools, check disk space, and read the first build error.
- “Permission denied” or “Exec format error”: check the OS and processor, extract into a folder owned by your normal user, and use a matching package.
- “Address already in use”: check for an existing Echo server before changing ports. Stop it normally with Ctrl+C.
- Library already in use: stop the process that owns it. Don't delete database or lock files to bypass the protection.
- Ollama unavailable: start it in the same environment as Echo, check port 11434, and download the selected model.

When sharing logs, include the OS, browser, package/build route, command, and error text. Remove tokens, `.env` secrets, and private meeting content.
