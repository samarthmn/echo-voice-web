# Developer guide

Use this guide to build Echo from source, change it, or prepare a package for someone else. For everyday recording and setup, start with the [README](../README.md).

Linux with desktop Chromium is the qualified build and runtime environment. macOS and Windows/WSL instructions below are setup options that still need end-to-end validation.

## Install the build tools

You'll need stable Rust installed with `rustup`, Node.js 22 or newer with npm, Git, Bash, and a C toolchain for bundled SQLite. You don't need a separate database installation.

### Ubuntu or Debian

Install the system prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev git curl
```

Install the default stable Rust toolchain from [rustup.rs](https://rustup.rs/), then install Node.js 22 or newer using the [Node.js installation instructions](https://nodejs.org/en/download).

### macOS

Install Apple's command-line tools:

```bash
xcode-select --install
```

Complete the installation window, then install stable Rust and Node.js as above. Build on the Mac itself; the Linux package won't run there. The source app has been exercised on macOS. Meeting capture uses the browser extension in an existing Brave or Chrome session; see the [extension guide](browser-extension.md).

### Windows with WSL

There is no tested native Windows installer. WSL provides a Linux environment inside Windows; this route hasn't been qualified end to end. Check [Microsoft's WSL guide](https://learn.microsoft.com/en-us/windows/wsl/install) for supported versions and troubleshooting.

In an administrator PowerShell window:

```powershell
wsl --install -d Ubuntu
```

Restart if prompted. Open Ubuntu, create the Linux username and password, and follow the Ubuntu steps above **inside Ubuntu**, including Rust and Node.js installation. Tools installed only on Windows won't be available there automatically.

Once the server is running, try `http://localhost:3000` in Chrome on Windows. Browser microphone permissions, localhost forwarding, OAuth callbacks, and meeting-tab capture need separate validation. If forwarding fails, use Microsoft's troubleshooting guide. Keep Echo local.

Ollama must be reachable on the Linux server's loopback address. An Ollama installation on Windows isn't automatically the same service as one inside WSL.

### Check your tools

Reopen the terminal after installing Rust and Node.js. Each command should print a version:

```bash
rustc --version
cargo --version
rustup --version
node --version
npm --version
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

The build script installs the WASM target, runs `npm ci --ignore-scripts`, bundles the recorder and Transformers.js inference bridge, copies ONNX runtime assets, installs the `wasm-bindgen` CLI version matching `Cargo.lock`, and builds the release app and server. Completion prints **“Echo Voice is built.”** It doesn't download speech or Ollama models.

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

Rebuild after changing Rust UI or browser bridge code, then reload the browser. For server changes, stop the server, rebuild, and restart. CSS changes only need a browser reload. `cargo check` doesn't regenerate the browser bundle, and the start script doesn't provide hot reload.

## Configuration

Basic recording works with the shipped `echo.config.json`. Public runtime settings are initialized once at startup from that file; edit it and restart the server after changing settings.

| Config field | Use |
| --- | --- |
| `bind` | Default `127.0.0.1:3000`. Only loopback IP listeners are accepted; public and wildcard interfaces are rejected. |
| `dataDir` | Library location, default `.echo-data`. The extension pairs explicitly to this library. |
| `googleRedirectUri` | Calendar callback, default `http://localhost:3000/api/integrations/google/callback`. Match it in Google Cloud Console. |
| `codexBinary` | Optional path to the official Codex 0.160.0 executable; `null` enables bundled/npm/PATH discovery. |
| `runner` | Deprecated configurations are accepted and ignored; new configuration omits this section. |

Only optional Google Calendar credentials belong in `.env`:

```bash
cp .env.example .env
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart the server. There is no OpenAI API-key setting or API-billing fallback. ChatGPT uses account sign-in through Models. No origin override is supported for this local product.

Extension credentials are generated by user-approved pairing and stored hashed by Echo. Portable backups exclude credentials; re-pair after restoring into a different library.

For isolated development/tests, shell overrides `ECHO_BIND`, `ECHO_DATA_DIR`, and `ECHO_CODEX_BIN` remain available. `ECHO_CONFIG_FILE` selects an alternate shared JSON file. These overrides are not needed in a user's `.env`; the listener still enforces loopback. For a different Calendar port, also update `googleRedirectUri` and the registered Google redirect. A different origin has a separate speech-model cache.

Configure Ollama in Echo's Settings. The default address is `http://127.0.0.1:11434`; only local connections are accepted. To download the default model from a terminal:

```bash
ollama pull qwen2.5:3b
```

ChatGPT uses an isolated helper home under the data directory and requires the pinned version. It doesn't read an existing Codex login or use an OpenAI API key. See the [ChatGPT guide](chatgpt.md) for installation, sign-in, account limits, and recovery.

## Storage and large-library backups

Check **Settings → Storage** for the actual data path. Default locations are:

| Data | Location |
| --- | --- |
| Meeting text, settings, vocabulary, and versions | `.echo-data/workspace.sqlite` |
| Recorded and imported audio | `.echo-data/audio/` |
| ChatGPT credentials and helper state | `.echo-data/chatgpt/` |
| Google credentials | Private server data folder |
| Turbo and speaker models | Browser profile storage for the app's origin |
| Full Large V3 speech model | `.echo-data/models/native-large-v3/` |
| Ollama models | Ollama's model folder |
| Original Meet guest recordings | Runner data folder; copied into Echo when saved |

Supported library exports include audio and meeting data but exclude credentials, models, and executables. Restoring requires an empty library and vocabulary. Per-meeting data exports exclude audio; use original-track downloads or a full library backup when you need audio too.

For libraries beyond the in-app backup limit, stop Echo and any old helper, then copy the **whole data folder**. Keep the copy private because it can include account credentials. Only one server can own a library at a time. Don't delete lock files to bypass another running server.

Browser uploads accept supported audio/video containers up to 500 MB. In-app library restore has a smaller limit, including a 180 MB audio limit. Speech decoding is bounded to 512 MB or two hours; legacy finalized WAV recovery is limited to 512 MB; extension recordings use sequential 30-minute processing parts. Large recordings can exhaust browser memory or take substantial CPU time. Independent exports and backups remain after deleting a meeting in Echo.

Echo serves `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so supported browsers can use ONNX WebAssembly CPU threads. The worker uses half the reported CPU cores, capped at four, and falls back to one thread without cross-origin isolation. Bundled JavaScript and WASM remain on the local origin; remote model downloads use CORS. Calendar sign-in uses top-level navigation, and ChatGPT sign-in does not depend on an opener. If you add an external embedded asset or popup integration, check its compatibility with these policies. See [ONNX threading requirements](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html) and the [browser isolation guide](https://web.dev/articles/coop-coep).

## Update a source checkout

Back up the library, note its location, and stop Echo and any old helper first. For an unmodified Git checkout:

```bash
git pull --ff-only
bash scripts/build.sh
bash scripts/start.sh
```

If Git reports local changes or conflicts, resolve them without deleting work. For a source ZIP, extract the new version into a separate folder, build it, and follow the README's [data transfer steps](../README.md#install-a-newer-package). Keep the old app and backup until meetings and audio work in the new version.

## Run tests

Build first to create the release server and current browser assets. Native speech API and AMI provenance tests need Python 3. Browser tests need Chromium. Install Playwright's browser and Linux system dependencies if needed:

```bash
npx playwright install --with-deps chromium
export CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "@playwright/test"; process.stdout.write(chromium.executablePath())')"
export ECHO_TEST_BINARY=target/release/echo-server

cargo test --locked -p echo-server
cargo check --locked -p echo-app --target wasm32-unknown-unknown
npm test
python3 -B -m unittest discover -s tests -p '*_test.py' -v
npm run test:extension
npm run test:e2e
```

Installing Linux browser dependencies may need administrator permission. If a compatible Chromium is already installed, set `CHROMIUM_PATH` to that executable's absolute path. Tests default to `/usr/bin/chromium`.

Keep **`ECHO_TEST_BINARY` set for release-only builds**. Without it, server-launching tests look for `target/debug/echo-server`. Build that with `cargo build -p echo-server` if you want debug tests. CI removes a cached debug executable before browser tests to catch accidental reliance on it.

`npm test` covers inference, recorder behavior, REST storage/lifecycle, and simulated Codex protocol cases. Browser tests cover recording, imports and recovery, navigation, settings, meeting review, account consent, and accessibility. The combined launcher creates temporary libraries. Don't point fixture scripts at a real meeting library.

The [verification workflow](../.github/workflows/verify.yml) runs on pushes to `main` and pull requests. Local checks and external-service qualification limits are documented in the [verification record](verification.md). Simulated account and model responses don't verify real sign-in, plan eligibility, or inference output.

## Make a downloadable package

On Linux x64, after building and checking Echo:

```bash
node scripts/package.mjs
```

The script creates:

- `artifacts/echo-voice-source.tar.gz`: source files that still need building.
- `artifacts/echo-voice-linux-x64.tar.gz`: compiled server and browser assets. It includes the native Codex 0.160.0 helper and its license when the official Linux x64 platform package is installed.

Packaging copies Git-tracked source and selected release assets. Add intended new source files to Git before packaging. It leaves out meeting data, `.env`, model downloads, and `node_modules`. It uses the existing binary; it doesn't cross-compile, create Mac/Windows installers, or publish a GitHub release.

Test the extracted archive before sharing it. Use the exact ready-to-run filename above when distributing it so users can follow the README.

## Diagnose build and runtime errors

- Missing `cargo`, `rustup`, `node`, or `npm`: finish installing the tool and reopen the terminal. Under WSL, install inside Ubuntu.
- Missing compiler/linker or `cc`: install your OS build tools, check disk space, and read the first build error.
- “Permission denied” or “Exec format error”: check the OS and processor, extract into a folder owned by your normal user, and use a matching package.
- “Address already in use”: check for an existing Echo server before changing ports. Stop it normally with Ctrl+C.
- Library already in use: stop the process that owns it. Don't delete database or lock files to bypass the protection.
- Ollama unavailable: start it in the same environment as Echo, check port 11434, and download the selected model.

When sharing logs, include the OS, browser, package/build route, command, and error text. Remove tokens, `.env` secrets, and private meeting content.
