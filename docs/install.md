# Install and run

Echo runs from a source checkout. There is no packaged installer.

## Prerequisites

| Tool                     | Notes                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Silicon Mac        | `setup.sh` refuses to run elsewhere                                                                                                         |
| Xcode command line tools | `xcode-select --install`                                                                                                                    |
| Rust via rustup          | <https://rustup.rs>. `setup.sh` adds the `wasm32-unknown-unknown` target and installs the `wasm-bindgen-cli` version pinned in `Cargo.lock` |
| Node.js 22 or newer      | Also needed at runtime for Whisper Large V3                                                                                                 |
| pnpm                     | `corepack enable` or `brew install pnpm`                                                                                                    |
| Ollama (optional)        | Local notes. See [integrations](integrations.md#local-notes-ollama)                                                                         |

## setup.sh

```bash
./scripts/setup.sh
./scripts/setup.sh --build-only   # skip tool installs; rebuild outputs only
```

It checks the prerequisites, then:

1. adds the wasm Rust target, runs `pnpm install --frozen-lockfile`, and installs `wasm-bindgen-cli` if the version does not match (skipped with `--build-only`);
2. warns if the pinned Codex 0.160.0 helper is missing (ChatGPT notes are then unavailable);
3. builds browser assets (`pnpm build:assets`) and the extension (`pnpm build:extension`, output `extension/dist`);
4. builds the Dioxus app to wasm and runs `wasm-bindgen` into `public/assets`;
5. generates the asset manifest and builds the release server (`target/release/echo-server`).

It prints the URL to open when it finishes. It never downloads speech or Ollama models.

## start.sh

```bash
./scripts/start.sh
```

Verifies the build outputs exist, checks that the port is free, and runs `target/release/echo-server` in the foreground. Press Ctrl+C to stop. The server only binds loopback addresses.

## Configuration

`echo.config.json` in the repo root:

| Key                 | Default          | Meaning                                                                                                |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `bind`              | `127.0.0.1:3000` | Listen address. Must be a loopback IP and port                                                         |
| `dataDir`           | `.echo-data`     | Library folder. Relative paths resolve against the repo (resource root)                                |
| `codexBinary`       | `null`           | Path to the Codex 0.160.0 executable. Relative paths resolve against the repo                          |
| `googleRedirectUri` | derived          | Optional. Overrides the Google OAuth redirect URI, see [integrations](integrations.md#google-calendar) |

Unknown keys are rejected, except a retired `runner` key, which is ignored. Edit the file and restart.

Environment overrides:

| Variable             | Effect                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `ECHO_BIND`          | Overrides `bind` (also read by the scripts)                                              |
| `ECHO_DATA_DIR`      | Overrides `dataDir`                                                                      |
| `ECHO_RESOURCE_ROOT` | Folder that contains `public/`. Normally found automatically from the binary or the repo |
| `ECHO_CONFIG_FILE`   | Use another config file instead of `echo.config.json`                                    |
| `ECHO_CODEX_BIN`     | Overrides `codexBinary`                                                                  |

`.env` in the repo root is loaded at start and only holds the optional Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Copy `.env.example` to start.

If you change the port, the extension finds Echo automatically only on ports 3000 to 3005; otherwise open Echo in the browser once (it announces itself to the extension) or set the address under **Advanced** in the extension Setup page.

## Auto-start at login

```bash
./scripts/install-service.sh            # install and start the launchd agent
./scripts/install-service.sh --dry-run  # print the plist only
./scripts/uninstall-service.sh
```

The agent is `dev.echo-voice.server` (`~/Library/LaunchAgents/dev.echo-voice.server.plist`). It runs `target/release/echo-server` from the repo, restarts it if it exits with an error, and logs to `~/Library/Logs/Echo Voice/server.log`. Run `setup.sh` first. After a rebuild, macOS may ask again to allow Keychain access for the new binary; allow it, or the library stays locked. Restart the agent after rebuilding:

```bash
launchctl kickstart -k "gui/$(id -u)/dev.echo-voice.server"
```

## Updating

1. Finish recordings and let the extension upload pending audio.
2. Export a backup (**Settings → Storage → Export library**, see [storage](storage-and-recovery.md)).
3. Stop the server (Ctrl+C, or `uninstall-service.sh` / `launchctl bootout` if running as a service).
4. `git pull && ./scripts/setup.sh`
5. Start it again. If the extension changed, rebuild is already done by `setup.sh`; reload it at `brave://extensions` or `chrome://extensions`.

The server refuses to open a library written by a newer version and does not downgrade a migrated library.

## Uninstalling

1. Export a backup if you want to keep the recordings. The default `.echo-data` folder is inside the checkout.
2. `./scripts/uninstall-service.sh` if you installed the agent.
3. Remove the extension in the browser. This deletes recordings it has not yet uploaded.
4. Delete the checkout. The library key stays in Keychain; remove it with Keychain Access if you want it gone.

## Troubleshooting

| Symptom                          | Fix                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Port N is in use"               | `lsof -nP -iTCP:<port> -sTCP:LISTEN` to find the process, or set `ECHO_BIND=127.0.0.1:<other>`                                                                                                   |
| "Build outputs missing"          | Run `./scripts/setup.sh`                                                                                                                                                                         |
| Library locked / key unavailable | Unlock the login keychain and allow Echo's Keychain prompt, then restart. If the key is gone, [recover with the phrase](storage-and-recovery.md#recovering-a-library)                            |
| Speech model not ready           | Download it under **Models → Speech models**. Needs internet once                                                                                                                                |
| Large V3 unavailable             | Needs Node.js 22+ on the server's `PATH` and the dependencies from `pnpm install`. Under launchd, `install-service.sh` records Node's folder in the agent's `PATH`; rerun it after changing Node |
| ChatGPT helper missing           | `setup.sh` printed a warning. Run `pnpm install`, or set `codexBinary`                                                                                                                           |
| Extension will not connect       | Make sure the server is running, then use **Connect to Echo**. See [extension troubleshooting](extension.md#troubleshooting)                                                                     |
