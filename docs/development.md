# Development

## Dev loop

```bash
./scripts/dev.sh
```

Builds the assets and a debug wasm app, then runs the debug server (`cargo run --locked -p echo-server`) at <http://localhost:3100> with its own data folder `.echo-dev-data`, so your real library is untouched. It still uses the Keychain for the library key. Debug builds only: setting `ECHO_TEST_MODE=1`, `ECHO_DATA_DIR` and `ECHO_TEST_STORAGE_KEY` (base64, 32 bytes) uses that key instead of Keychain; this is how the integration tests run. Release builds reject `ECHO_TEST_STORAGE_KEY`.

There is no hot reload. After changing Rust UI or `web/` code, rerun `./scripts/dev.sh`; CSS changes only need a browser reload. For extension changes run `pnpm build:extension` and reload the extension.

## Checks and tests

```bash
./scripts/check.sh          # Rust, lint and unit tests
./scripts/check.sh --all    # every check, including builds, integration and e2e
./scripts/check.sh --rust   # rustfmt, RSX formatting, clippy, wasm clippy, Rust tests
./scripts/check.sh --lint   # formatting, linters, both TypeScript compilers, knip
./scripts/check.sh --app    # unit tests, release/debug builds, integration, e2e
```

| Command                                    | What it runs                                                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                        | Prettier checks for TypeScript, JSON, HTML and public CSS                                                                                                                                                                                                |
| `pnpm lint`                                | Typed ESLint for browser, extension, scripts, tests and its config                                                                                                                                                                                       |
| `pnpm lint:css`                            | Stylelint for `public/*.css` and `extension/*.css`, with no warnings                                                                                                                                                                                     |
| `pnpm lint:md`                             | Markdownlint for root Markdown files and `docs/**/*.md`                                                                                                                                                                                                  |
| `shellcheck scripts/*.sh`                  | Shell scripts at default severity, including style findings                                                                                                                                                                                              |
| `actionlint .github/workflows/*.yml`       | GitHub Actions workflows and ShellCheck for shell steps                                                                                                                                                                                                  |
| `pnpm typecheck` / `pnpm typecheck:compat` | Native TypeScript and compatibility solution builds                                                                                                                                                                                                      |
| `pnpm knip`                                | Unused JS/TS files, exports and dependencies; browser bundles, extension bundles, scripts and tests are entry points                                                                                                                                     |
| `cargo test --locked --workspace`          | Rust unit and server tests                                                                                                                                                                                                                               |
| `pnpm test`                                | Node unit tests discovered from `tests/unit/**/*.test.ts`                                                                                                                                                                                                |
| `pnpm test:integration`                    | Server and extension integration tests. Needs a debug server at `target/debug/echo-server` (`cargo build -p echo-server`, or `ECHO_TEST_BINARY`) and Playwright Chromium (`pnpm exec playwright install chromium`; `CHROMIUM_PATH` is set by `check.sh`) |
| `pnpm test:e2e`                            | Browser end to end tests via `scripts/test-browser.ts`; needs the debug server, assets from `setup.sh` and Chromium                                                                                                                                      |
| `pnpm test:speakers`                       | Loads real PyAnnote and WavLM models and runs speaker grouping on sample audio; downloads models and needs internet                                                                                                                                      |

`check.sh` also runs `cargo clippy` (native workspace/all targets and `echo-app` for `wasm32-unknown-unknown`, warnings denied). No argument runs Rust, lint and unit tests; `--all` adds release and debug builds, integration tests and e2e tests. The three explicit modes partition `--all` for CI.

Native speech HTTP lifecycle tests live in `tests/integration/native-speech-http.test.ts` and run with `pnpm test:integration`. They use sparse model fixtures, without downloading or running speech models.

Knip checks entry-point exports too. `@dynamicImport` marks exports exercised by tests that bundle modules by filename, which static analysis cannot follow. `onnxruntime-node` is retained explicitly because the Rust speech service loads it from a Node command; `onnxruntime-web` is a direct dependency because `scripts/copy-wasm.ts` resolves its assets.

## Formatting and types

```bash
cargo fmt --all
dx fmt                      # RSX; install: cargo install dioxus-cli --version ^0.7 --locked
pnpm format                 # prettier --write (pnpm format:check to verify)
pnpm lint                   # typed ESLint; errors and warnings both fail
pnpm lint:fix               # apply ESLint fixes
pnpm lint:css               # Stylelint; errors and warnings both fail
pnpm lint:md                # Markdownlint
shellcheck scripts/*.sh     # install: brew install shellcheck actionlint
actionlint .github/workflows/*.yml
pnpm typecheck              # TypeScript Native 7.0.2 solution build
pnpm typecheck:compat       # TypeScript 6.0.3 compatibility build
```

`check.sh` skips the RSX check if `dx` is not installed. Missing `shellcheck` or `actionlint` prints a skip with `brew install shellcheck actionlint` locally; when `CI` is set, either missing tool fails the check. ShellCheck follows the existing `source=scripts/lib.sh` annotations without a `.shellcheckrc`; no ShellCheck rules are disabled.

ESLint uses `eslint.config.ts` with the recommended JavaScript rules, strict and stylistic type-checked TypeScript rules, and Prettier compatibility. It lints browser, extension, script and test TypeScript plus the config itself, using each project’s TypeScript types. It runs in `check.sh --lint` and CI.

Stylelint extends `stylelint-config-standard` in `.stylelintrc.json`. Raw hex colors are banned in app and extension CSS: colours come from the design tokens. The generated `public/tokens.css` is ignored. Pixel units remain allowed until the Phase 4 restyle. Exceptions are documented here because JSON has no comments:

- `// rule-empty-line-before: null` keeps the existing compact spacing between CSS rules; Prettier owns public CSS formatting.
- `// declaration-block-single-line-max-declarations: null` preserves the extension's compact CSS blocks.
- `// no-descending-specificity: null` preserves the existing ordered component, theme and responsive overrides.
- `// no-duplicate-selectors: null` preserves repeated selectors that layer later overrides without moving declarations in the cascade.
- `// ignoreFiles: public/tokens.css` skips the generated token file, which legitimately holds hex values.

Three local Stylelint exceptions retain existing behavior, each with a reason beside the declaration: `property-no-deprecated` for the screen-reader-only `clip` fallback in `public/review.css`, `property-no-vendor-prefix` for the WebKit `appearance` fallback, and `declaration-property-value-keyword-no-deprecated` for emergency `word-break: break-word` wrapping in `public/theme.css`.

Markdownlint uses `.markdownlint-cli2.jsonc` for root `*.md` and `docs/**/*.md`, excluding `design-system/`, `node_modules/`, `tmp/` and `target/`. Only `MD013` (line length) is disabled, so prose can keep its existing long lines. No inline HTML elements are allowlisted; the existing documents use code spans for HTML examples.

Use Node.js 22.18 or newer, which runs `.ts` files through built-in type stripping. Browser, extension, script, and test projects extend `tsconfig.base.json`; relative TypeScript imports include `.ts`. TypeScript 6.0.3 provides the JavaScript API for editors and tooling, while `typescript-native` pins 7.0.2 for `pnpm typecheck`; `pnpm typecheck:compat` checks compiler drift. Both scripts use explicit compiler paths because both packages publish a `tsc` binary. Both compilers require declarations for cross-project references, so solution builds emit declarations and build metadata under `node_modules/.cache/tsbuild/`; esbuild owns JavaScript assets.

Tests are grouped into `tests/unit/`, `tests/integration/`, and `tests/e2e/`, with shared fixtures in `tests/helpers/`. Run one unit test with `node --test tests/unit/foo.test.ts`. Integration files run serially to isolate server and extension fixtures; `scripts/test-browser.ts` preserves the browser suite's defined order. Scripts and tests execute directly as TypeScript; generated browser bundle names remain unchanged.

## Design tokens, fonts and icons

The look comes from the Organic design system in `design-system/`. `design-system/styles.css` is the single source of design tokens: colour ramps, semantic roles (`--color-text-muted`, `--color-accent-text`, `--color-on-accent`, status pairs and so on), type, spacing, radii and shadows, for the light theme in `:root` and Organic dark in `[data-theme='dark']`.

`scripts/build-tokens.ts` (`pnpm build:tokens`) extracts those two blocks and writes `tokens.css`: the self-hosted `@font-face` rules, the light tokens, the dark tokens, and the dark tokens again under `prefers-color-scheme: dark` unless the page sets `data-theme='light'`. `pnpm build:assets` writes `public/tokens.css` and `pnpm build:extension` writes the extension's copy. Both are build outputs and are not committed. To change a colour, edit `design-system/styles.css` (and `theme.json`/`readme.md` if a role changes), then rebuild.

`tests/unit/contrast.test.ts` reads the same source and asserts WCAG AA (4.5:1 for text, 3:1 for focus rings and accent fills) for every text/ground pairing the UI uses, in both themes. Add a pair there when you introduce a new combination.

Fonts are self-hosted in `public/fonts/`: Mulish (variable weight) for headings and body text, under the SIL OFL. `public/fonts/README.md` records the pinned source and how to update them. Nothing loads from a font CDN.

Icons are [Lucide](https://lucide.dev) at stroke width 2.75. `scripts/build-icons.ts` (`pnpm build:icons`) reads the pinned `lucide-static` devDependency and generates `app/src/icons.rs`, which maps the app's icon names (`Icon { name: "mic" }`) to Lucide markup. To add an icon, add a line to the name map in the script and rerun it. `check.sh --lint` fails (`icons-fresh`) if the generated file is stale.

The logo and every raster brand asset (favicons, extension and store icons, social images) live in `brand/`; see [brand/README.md](../brand/README.md). `pnpm build:brand` re-renders them from `brand/logo.svg` with Chromium.

## Building and packaging the extension

```bash
pnpm build:extension        # -> extension/dist
pnpm package:extension      # -> dist/echo-extension-<version>.zip
```

Packaging rebuilds, refuses symlinks and unexpected executables, and zips only the allowlisted files. `ECHO_EXTENSION_OUTDIR` changes the build output folder. Loading the extension and the stable extension ID are covered in [extension.md](extension.md#install). Its version comes from `extension/manifest.json`.

## CI

`.github/workflows/verify.yml` runs on pushes to `main` and on pull requests as three parallel jobs that together cover `./scripts/check.sh --all`:

- **Rust lint and tests** (`macos-14`): stable Rust with the wasm target, then `./scripts/check.sh --rust`.
- **App build and browser tests** (`macos-14`): Node 22.18+, pnpm, stable Rust, a prebuilt `wasm-bindgen` matching `Cargo.lock`, `./scripts/setup.sh`, Playwright Chromium, then `./scripts/check.sh --app`.
- **Lint and types** (`ubuntu-latest`, 15-minute timeout): Node 22.18+, pnpm with its dependency cache, a frozen lockfile install, prebuilt actionlint 1.7.12 and a version check for preinstalled ShellCheck, then `./scripts/check.sh --lint`. No Rust toolchain is needed.

The two macOS jobs keep their Rust build cache even when a run fails (`cache-on-failure`), so a red run still makes the next one fast. The cache is keyed on the Rust version, so the first run after a new stable Rust release rebuilds from scratch.

## Conventions

Rust lint levels live in the root `Cargo.toml` under `[workspace.lints]`; both crates inherit them. Unsafe code, Clippy's `all` group, `dbg!` and `todo!` are denied. Pedantic lints and production `unwrap`/`expect` calls warn, with a short, commented workspace allow-list; checks reject all warnings. Tests may use `unwrap`/`expect` through `clippy.toml`, which also records the Rust 1.96.1 MSRV shared by both manifests. The server additionally warns on unreachable public items. Dioxus RSX emits false positives for `unused_qualifications`, so the app documents a local override. Formatting settings live in `rustfmt.toml`.

Fix useful lint findings first. When an exception is justified, allow it on the smallest relevant item or block with an explanation, for example `#[allow(clippy::expect_used, reason = "This conversion is infallible because …")]`. Keep a descriptive `expect` message for infallible invariants and a `// SAFETY:` comment beside any allowed unsafe operation. CLI output has local allowances; server diagnostics use tracing.

- Scratch files go in `./tmp` inside the repo (it is git-ignored), never the system temp dir. The scripts set `TMPDIR` to it. Clean up what you create.
- Package manager is pnpm; keep `pnpm-lock.yaml` and `Cargo.lock` committed (builds use `--locked` and `--frozen-lockfile`).
- Config lives in `echo.config.json`; secrets only in `.env`.
- Layout: `app/` Dioxus UI, `server/` Axum, `web/` strict browser TypeScript, `extension/` MV3 extension, `scripts/`, `tests/`, `public/` static files and generated assets. See [architecture](architecture.md).
