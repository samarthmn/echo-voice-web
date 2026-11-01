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
./scripts/check.sh --rust   # only the Rust half: rustfmt, clippy, cargo test
./scripts/check.sh --app    # only the rest: prettier, typecheck, unit tests, builds, integration, e2e
```

| Command                           | What it runs                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test --locked --workspace` | Rust unit and server tests                                                                                                                                                                                                                                                                                                     |
| `pnpm knip`                       | Unused JS/TS files, exports and dependencies; configured entry points include browser bundles, extension bundles, scripts and tests |
| `pnpm test`                       | Node unit tests discovered from `tests/unit/**/*.test.ts`                                                                                                                                                                                                                                                                  |
| `pnpm test:integration`           | Server and extension integration tests (`tests/integration/rest.test.ts`, `server-lifecycle`, `extension-browser`, ...). Needs a debug server at `target/debug/echo-server` (`cargo build -p echo-server`, or `ECHO_TEST_BINARY`) and Playwright Chromium (`pnpm exec playwright install chromium`; `CHROMIUM_PATH` is set by `check.sh`) |
| `pnpm test:e2e`                   | Browser end to end tests via `scripts/test-browser.ts` (needs the debug server binary, the built assets from `setup.sh`, and Chromium)                                                                                                                                                                                        |
| `pnpm test:speakers`              | Loads the real PyAnnote and WavLM models and runs speaker grouping on sample audio; downloads models, needs internet                                                                                                                                                                                                           |

`check.sh` also runs `cargo clippy` (native workspace/all targets and `echo-app` for `wasm32-unknown-unknown`, warnings denied). Run `pnpm knip` separately; it is not part of `check.sh`.

Native speech HTTP lifecycle tests live in `tests/integration/native-speech-http.test.ts` and run with `pnpm test:integration`. They use sparse model fixtures, without downloading or running speech models.

Knip checks entry-point exports too. `@dynamicImport` marks exports exercised by tests that bundle modules by filename, which static analysis cannot follow. `onnxruntime-node` is retained explicitly because the Rust speech service loads it from a Node command; `onnxruntime-web` is a direct dependency because `scripts/copy-wasm.ts` resolves its assets.

## Formatting and types

```bash
cargo fmt --all
dx fmt                      # RSX; install: cargo install dioxus-cli --version ^0.7 --locked
pnpm format                 # prettier --write (pnpm format:check to verify)
pnpm lint                   # typed ESLint; errors and warnings both fail
pnpm lint:fix               # apply ESLint fixes
pnpm typecheck              # TypeScript Native 7.0.2 solution build
pnpm typecheck:compat       # TypeScript 6.0.3 compatibility build
```

`check.sh` skips the RSX check if `dx` is not installed.

ESLint uses `eslint.config.ts` with the recommended JavaScript rules, strict and stylistic type-checked TypeScript rules, and Prettier compatibility. It lints browser, extension, script and test TypeScript plus the config itself, using each project’s TypeScript types. Run `pnpm lint` separately; it is not yet wired into `check.sh` or CI.

Use Node.js 22.18 or newer, which runs `.ts` files through built-in type stripping. Browser, extension, script, and test projects extend `tsconfig.base.json`; relative TypeScript imports include `.ts`. TypeScript 6.0.3 provides the JavaScript API for editors and tooling, while `typescript-native` pins 7.0.2 for `pnpm typecheck`; `pnpm typecheck:compat` checks compiler drift. Both scripts use explicit compiler paths because both packages publish a `tsc` binary. Both compilers require declarations for cross-project references, so solution builds emit declarations and build metadata under `node_modules/.cache/tsbuild/`; esbuild owns JavaScript assets.

Tests are grouped into `tests/unit/`, `tests/integration/`, and `tests/e2e/`, with shared fixtures in `tests/helpers/`. Run one unit test with `node --test tests/unit/foo.test.ts`. Integration files run serially to isolate server and extension fixtures; `scripts/test-browser.ts` preserves the browser suite's defined order. Scripts and tests execute directly as TypeScript; generated browser bundle names remain unchanged.

## Building and packaging the extension

```bash
pnpm build:extension        # -> extension/dist
pnpm package:extension      # -> dist/echo-extension-<version>.zip
```

Packaging rebuilds, refuses symlinks and unexpected executables, and zips only the allowlisted files. `ECHO_EXTENSION_OUTDIR` changes the build output folder. Loading the extension and the stable extension ID are covered in [extension.md](extension.md#install). Its version comes from `extension/manifest.json`.

## CI

`.github/workflows/verify.yml` runs on pushes to `main` and on pull requests as two parallel `macos-14` jobs that together cover `./scripts/check.sh --all`:

- **Rust lint and tests**: stable Rust with the wasm target, then `./scripts/check.sh --rust`.
- **App build and browser tests**: Node 22.18+, pnpm, stable Rust, a prebuilt `wasm-bindgen` matching `Cargo.lock`, `./scripts/setup.sh`, Playwright Chromium, then `./scripts/check.sh --app`.

Both jobs keep their Rust build cache even when a run fails (`cache-on-failure`), so a red run still makes the next one fast. The cache is keyed on the Rust version, so the first run after a new stable Rust release rebuilds from scratch.

## Conventions

Rust lint levels live in the root `Cargo.toml` under `[workspace.lints]`; both crates inherit them. Unsafe code, Clippy's `all` group, `dbg!` and `todo!` are denied. Pedantic lints and production `unwrap`/`expect` calls warn, with a short, commented workspace allow-list; checks reject all warnings. Tests may use `unwrap`/`expect` through `clippy.toml`, which also records the Rust 1.96.1 MSRV shared by both manifests. The server additionally warns on unreachable public items. Dioxus RSX emits false positives for `unused_qualifications`, so the app documents a local override. Formatting settings live in `rustfmt.toml`.

Fix useful lint findings first. When an exception is justified, allow it on the smallest relevant item or block with an explanation, for example `#[allow(clippy::expect_used, reason = "This conversion is infallible because …")]`. Keep a descriptive `expect` message for infallible invariants and a `// SAFETY:` comment beside any allowed unsafe operation. CLI output has local allowances; server diagnostics use tracing.

- Scratch files go in `./tmp` inside the repo (it is git-ignored), never the system temp dir. The scripts set `TMPDIR` to it. Clean up what you create.
- Package manager is pnpm; keep `pnpm-lock.yaml` and `Cargo.lock` committed (builds use `--locked` and `--frozen-lockfile`).
- Config lives in `echo.config.json`; secrets only in `.env`.
- Layout: `app/` Dioxus UI, `server/` Axum, `web/` strict browser TypeScript, `extension/` MV3 extension, `scripts/`, `tests/`, `public/` static files and generated assets. See [architecture](architecture.md).
