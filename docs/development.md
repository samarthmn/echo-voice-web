# Development

## Dev loop

```bash
./scripts/dev.sh
```

Builds the assets and a debug wasm app, then runs the debug server (`cargo run --locked -p echo-server`) at <http://localhost:3100> with its own data folder `.echo-dev-data`, so your real library is untouched. It still uses the Keychain for the library key. Debug builds only: setting `ECHO_TEST_MODE=1`, `ECHO_DATA_DIR` and `ECHO_TEST_STORAGE_KEY` (base64, 32 bytes) uses that key instead of Keychain; this is how the integration tests run. Release builds reject `ECHO_TEST_STORAGE_KEY`.

There is no hot reload. After changing Rust UI or `web/` code, rerun `./scripts/dev.sh`; CSS changes only need a browser reload. For extension changes run `pnpm build:extension` and reload the extension.

## Checks and tests

```bash
./scripts/check.sh          # fast: formatting, clippy, cargo test, prettier, typecheck, unit tests
./scripts/check.sh --all    # also release build, integration tests, e2e
```

| Command                           | What it runs                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test --locked --workspace` | Rust unit and server tests                                                                                                                                                                                                                                                                                                     |
| `pnpm test`                       | Node unit tests (`tests/*.test.mjs` listed in `package.json`)                                                                                                                                                                                                                                                                  |
| `pnpm test:integration`           | Server and extension integration tests (`tests/rest.test.mjs`, `server-lifecycle`, `extension-browser`, ...). Needs a debug server at `target/debug/echo-server` (`cargo build -p echo-server`, or `ECHO_TEST_BINARY`) and Playwright Chromium (`pnpm exec playwright install chromium`; `CHROMIUM_PATH` is set by `check.sh`) |
| `pnpm test:e2e`                   | Browser end to end tests via `scripts/test-browser.mjs` (needs the debug server binary, the built assets from `setup.sh`, and Chromium)                                                                                                                                                                                        |
| `pnpm test:speakers`              | Loads the real PyAnnote and WavLM models and runs speaker grouping on sample audio; downloads models, needs internet                                                                                                                                                                                                           |

`check.sh` also runs `cargo clippy` (native and wasm, warnings denied).

## Formatting and types

```bash
cargo fmt --all
dx fmt                      # RSX; install: cargo install dioxus-cli --version ^0.7 --locked
pnpm format                 # prettier --write (pnpm format:check to verify)
pnpm typecheck              # tsc -p extension
```

`check.sh` skips the RSX check if `dx` is not installed.

## Building and packaging the extension

```bash
pnpm build:extension        # -> extension/dist
pnpm package:extension      # -> dist/echo-extension-<version>.zip
```

Packaging rebuilds, refuses symlinks and unexpected executables, and zips only the allowlisted files. `ECHO_EXTENSION_OUTDIR` changes the build output folder. Loading the extension and the stable extension ID are covered in [extension.md](extension.md#install). Its version comes from `extension/manifest.json`.

## CI

`.github/workflows/verify.yml` runs on pushes to `main` and on pull requests, on `macos-14`: Node 22, pnpm, stable Rust with the wasm target, `./scripts/setup.sh`, Playwright Chromium, then `./scripts/check.sh --all`.

## Conventions

- Scratch files go in `./tmp` inside the repo (it is git-ignored), never the system temp dir. The scripts set `TMPDIR` to it. Clean up what you create.
- Package manager is pnpm; keep `pnpm-lock.yaml` and `Cargo.lock` committed (builds use `--locked` and `--frozen-lockfile`).
- Config lives in `echo.config.json`; secrets only in `.env`.
- Layout: `app/` Dioxus UI, `server/` Axum, `web/` browser JS, `extension/` MV3 extension, `scripts/`, `tests/`, `public/` static files and generated assets. See [architecture](architecture.md).
