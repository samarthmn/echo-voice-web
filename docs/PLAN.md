# Production release plan: Echo as an open-source, self-hosted product

Status: **approved 2026-10-31** · Written 2026-10-31 · Branch `claude/production-hardening`

Approved by Samarth on 2026-10-31.

## 1. Intent

Until now Echo has been a personal tool. It's a meeting recorder and transcriber that runs entirely on one Mac, with an encrypted local library, on-device Whisper, a Brave/Chrome extension that records meeting tabs, and Ollama for notes. Next it becomes a product that other people can find on GitHub, install on their own Mac, and trust.

Echo is a **product, not a service**. We host nothing for users. There are no accounts, no cloud, no sign-up, no hosted transcription, and no "Echo servers". The only thing on the internet is the marketing and docs site. Every word on the site, the README, the docs and the store listing has to make that clear.

Positioning: **"Echo: open-source, local-first AI meeting notes. A private alternative to Fireflies, Otter.ai and Fathom."** No bot joins your call, nothing leaves your laptop, and it's free and MIT-licensed.

## 2. Goals, non-goals, anti-goals

### Goals

1. A Mac developer can go from finding the repo to their first transcribed meeting using only the docs.
2. The codebase is clean: dead code is gone, all JavaScript becomes strict TypeScript, and lint, type and format gates run in CI for Rust, TS, CSS, shell, Markdown and workflows.
3. One visual identity, the **Organic** design system (`design-system/`) with a new abstract soft-blob logo, covers the landing page, the docs, the self-hosted app and the extension, in light and dark.
4. A landing page plus Starlight docs at `echo-web.samarthmn.com` (docs under `/docs`), deployed by Cloudflare. The docs have **one source**, the repo's `docs/` folder, which renders on both GitHub and the site.
5. It's discoverable. The README, repo metadata, site SEO and comparison content target "Fireflies alternative", "Otter alternative", "local AI meeting notes" and "open-source meeting recorder".
6. Release hygiene: versioned releases, a changelog, community and security files, supply-chain checks, health and diagnostics, and a Chrome Web Store listing.

### Non-goals (for this release)

- Linux or Windows support, Intel Macs, prebuilt server binaries, a signed `.app` or an installer. The audience is Mac developers who build from source.
- Any hosted component beyond the static site.
- ChatGPT or any cloud notes provider. It's being removed, not hidden.
- New recording or transcription features.

### Anti-goals (failure even if it technically "works")

- Any copy, metadata or UI that implies a service ("sign up", "plans", "our servers", "we store").
- The local app making third-party network requests it doesn't make today (for example Google Fonts). Fonts and icons get self-hosted.
- Breaking existing libraries. A library or backup made before this work must still open, validate, export and import.
- A redesign that loses accessibility. The axe e2e suite stays green in both themes, and body text meets WCAG AA (4.5:1).
- Comparison claims about competitors that we can't source. Every claim in the comparison table is factual, dated and linked.

## 3. Decisions (from the Q&A on 2026-10-31)

| Topic | Decision |
| --- | --- |
| Audience and install | Mac (Apple Silicon) developers, build from source via `setup.sh` |
| ChatGPT/Codex notes | Remove entirely (server, UI, deps, tests, docs). Ollama is the only notes engine |
| Legacy-vault migration | Remove (no legacy recordings remain) |
| Design source | `design-system/` folder (Organic) added to the repo |
| Naming | Keep "Echo", always qualified, e.g. "Echo: local AI meeting notes". Repo stays `echo-voice-web` |
| Dark mode | Derive a warm Organic dark theme from the same OKLCH ramps; keep the light/dark/system toggle |
| Restyle scope | Landing, docs (Starlight theme), self-hosted web app, browser extension |
| TS conversion | Everything: `web/*.js`, `scripts/*.mjs`, `tests/*.mjs` all become strict `.ts` |
| Extension distribution | Load unpacked + release zip **and** a Chrome Web Store listing |
| Competitor positioning | Name them, with a factual comparison table |
| Site deploy | Cloudflare Git integration (the dashboard builds `site/`; no secrets in GitHub) |
| Site analytics | Cloudflare Web Analytics (cookieless) on the public site only, never in the app |
| Extras | Community files, supply-chain checks, versioned releases, diagnostics and health |
| Delivery | One branch (`claude/production-hardening`), one PR at the end, a commit per phase |
| Logo | Abstract soft blob (organic pebble with a cut-out wave). Three concepts, you pick one |
| Who writes code | Codex (`gpt-6.1-sol`, `high` effort, `-s workspace-write`). Claude scopes, briefs, reviews and verifies |

## 4. How the work gets done

- **Workers:** each task in §6 becomes a Codex brief covering context, exact scope, what not to touch, acceptance criteria, verification commands and the report format. Run with `codex exec - < tmp/briefs/<id>.md -m gpt-6.1-sol -c model_reasoning_effort="high" -s workspace-write -o tmp/codex/<id>.md > tmp/codex/<id>.log 2>&1` in the background.
- **Parallelism:** only for tasks whose file sets can't overlap (marked ∥ in §6). Only one worker at a time may run the integration or e2e suites, since they bind ports.
- **Review:** after every task Claude reads the final message and the full diff, re-runs the task's verification, and sends problems back with `codex exec resume <session>`. Nothing gets committed unverified.
- **Commits:** one or more commits per phase on `claude/production-hardening`, each leaving `./scripts/check.sh` green. A single PR to `main` at the end.
- **Checkpoints with you** (work pauses for your call): logo pick (§6.3), app restyle screenshots (§6.4), landing page review (§6.5), and anything outward-facing (repo metadata edits, store listing text) before it's published.
- **Scratch:** `tmp/` in the repo only, cleaned up at the end of each task.

## 5. Current state (recon summary)

- **Server:** Rust/Axum (`server/`), SQLCipher library, Keychain-held key, launchd agent.
- **UI:** Dioxus/WASM (`app/`). ~8.2k lines of CSS across `public/{styles,review,settings,theme,design-tokens}.css`, Inter font.
- **Browser JS:** `web/*.js` (~4k lines), bundled by esbuild. Already-strict TS in `extension/src`. `scripts/*.mjs` and `tests/*.mjs` (≈45 test files), plus one Python test (`tests/native_speech_http_test.py`) that no check runs.
- **ChatGPT footprint:** `server/src/{chatgpt,chatgpt_runtime}.rs`, `chatgpt-config.toml`, branches in `notes.rs`, `config.rs` (`codexBinary`), `protected_storage.rs`, `store/{mod,settings,validation,library_io}.rs`, `library_validation.rs`, `app/src/{main,review}.rs`, `@openai/codex` dep, `setup.sh` helper check, `scripts/smoke-codex.mjs`, `tests/chatgpt-protocol.test.mjs`, `tests/fixtures/codex-helper.mjs`, CSS and docs. The docs also list an `app/src/chatgpt.rs` that no longer exists.
- **Extension:** MV3 with a fixed `key`, so the ID is `poonbmodjfijfbfiopememgfijahgbag`, read by the web app from `public/js/extension-id.json`. Legacy-vault migration in `extension/src/legacy-vault.ts` and `server/src/extensions/vault.rs`.
- **Lint today:** rustfmt, clippy `-D warnings` (native + wasm), prettier, `tsc -p extension` (TypeScript 7.0.2). No ESLint, stylelint, shellcheck or markdownlint.
- **CI:** two `macos-14` jobs covering `check.sh --rust` and `--app`.
- **Repo metadata:** no description, no topics, no homepage. README is personal ("runs entirely on your Mac").

## 6. Work breakdown

Phases run in order. Inside a phase, tasks marked ∥ can run as parallel workers.

### Phase 0: Baseline

- **0.1** Run `./scripts/check.sh --all` on the branch and record the result as the baseline. Fix nothing yet; note any pre-existing failures.
- **0.2** Commit `design-system/` as the design source of truth. Add `site/dist/`, `site/.astro/` and `.wrangler/` to `.gitignore` (`/tmp/` is already there).

### Phase 1: Cleanup

- **1.1 Remove ChatGPT/Codex** from everything listed in §5.
  - *Compatibility rule:* notes versions already saved with a ChatGPT provider still display, export and import, labelled "ChatGPT (legacy)". Libraries and backups that contain the old encrypted ChatGPT state still open and pass `--check-library`.
  - The server stops creating or protecting `<dataDir>/chatgpt` but never deletes it automatically. The docs explain how to remove it by hand.
  - `echo.config.json` drops `codexBinary`. Unknown keys get a warning, not a failure, so old configs still load.
  - *Verify:* `check.sh --all`, plus a fixture library containing ChatGPT notes (`server/examples/storage-fixture.rs`) round-trips.
- **1.2 Dead-code sweep** ∥ (after 1.1).
  - `cargo machete` / `cargo udeps` for unused crates.
  - `knip` for unused files, exports and deps on the TS side.
  - Audit `#[allow(...)]`, unused CSS selectors (with a coverage pass from the e2e run), stale scripts, and the unwired Python test. Port the Python test to a TS test or delete it if the Rust/Node tests already cover it.
  - Rename `package.json` `name` to `echo`.
- **1.3 Remove the legacy-vault migration** ∥: `extension/src/legacy-vault.ts`, `server/src/extensions/vault.rs`, their routes, callers (`background.ts`, `setup.ts`), tests and docs. Decided 2026-10-31: there are no legacy recordings left to migrate.
- **1.4 Fix stale docs references** (folded into Phase 5's docs rewrite).

### Phase 2: Linting and strict typing

- **2.1 Rust lints:**
  - `[workspace.lints]` in `Cargo.toml`, with `rust.unsafe_code = "deny"` and a targeted `#[allow]` plus `// SAFETY:` comments for the one `libc` call in `paths.rs`.
  - `rust.missing_debug_implementations` and `rust_2018_idioms` set to warn.
  - `clippy.all` deny; `clippy.pedantic` warn, with a short, documented allow-list (`module_name_repetitions`, `must_use_candidate`, ...).
  - `clippy.unwrap_used` / `expect_used` warn outside tests.
  - Add `rustfmt.toml` and `clippy.toml`. Keep `-D warnings` in `check.sh`.
- **2.2 Shared TS config:**
  - `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (so Node can strip types).
  - Project references for `web/`, `extension/`, `scripts/`, `tests/` and `site/`. `pnpm typecheck` → `tsc -b`.
- **2.3 Convert `web/*.js` → `.ts`** ∥.
  - Type the Rust↔JS boundary in `web/types/bridge.d.ts`: the window globals Dioxus calls, and the payloads of every exported function.
  - Workers and transformers.js get real types. Zero `any`: `unknown` + narrowing at every `fetch`/JSON/`postMessage` boundary, with small validators in `web/guards.ts`.
  - esbuild entry points switch to `.ts`.
- **2.4 Convert `scripts/*.mjs` and `tests/*.mjs` → `.ts`** ∥ (disjoint from 2.3).
  - Run via Node's built-in type stripping; `engines.node` goes to `>=22.18`.
  - `node --test` globs replace the hand-maintained file lists in `package.json`.
- **2.5 ESLint flat config** (`eslint.config.ts`):
  - `@eslint/js` recommended + `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` with `projectService`.
  - `eslint-config-prettier`; `eslint-plugin-astro` for `site/`.
  - Rules: `no-console` except in scripts/tests, `@typescript-eslint/no-explicit-any` error, `consistent-type-imports`.
- **2.6 Other linters:**
  - `stylelint` (+ `stylelint-config-standard`), with a rule banning raw hex/px colours outside the token files. This mirrors `design-system/_adherence.oxlintrc.json`.
  - `shellcheck` for `scripts/*.sh`, `markdownlint-cli2` for `docs/` and the root `.md` files, `actionlint` for workflows.
  - Prettier extends to `.ts`, `.astro`, `.md` and `.json`.
- **2.7 Wire into `check.sh`** (new `lint` step) and CI. Add a third, fast `ubuntu-latest` CI job for lint, typecheck and site build, since these don't need macOS.
- *Risk:* TypeScript 7 (the native port) may not expose the compiler API that `typescript-eslint` needs. Mitigation: check first. If it doesn't, pin `typescript@5.x/6.x` as the ESLint parser peer and keep `tsc` 7 for `pnpm typecheck`.

### Phase 3: Brand and design system

- **3.1 Logo:** three soft-blob concepts as SVG (an organic pebble with a cut-out wave or ripple; terracotta `--color-accent` and sage `--color-accent-2`). They render on the Organic ground in light and dark, and at 16 px. **Checkpoint: you pick one.**
  - The chosen logo goes into `brand/`: master SVG, monochrome SVG, favicon SVG/ICO, apple-touch 180, extension PNGs 16/32/48/128, an OG image (1200×630), a GitHub social preview (1280×640), and store assets (128 icon, 440×280 tile, 1280×800 screenshots).
- **3.2 Shared tokens:**
  - `design-system/styles.css` stays the source. A build step (`scripts/build-tokens.ts`) emits one `tokens.css` that the app (`public/`), the extension and `site/` all consume. It replaces `public/design-tokens.css`.
  - Add the **Organic dark** theme under `[data-theme='dark']`: dark earth ground and surface from the neutral 800–900 steps, accents shifted per the design readme (pressed state = accent-400 on dark). Keep `theme.json` and `readme.md` in step.
  - Add a contrast test (`tests/contrast.test.ts`) that asserts AA for text/ground pairs in both themes.
- **3.3 Self-host fonts and icons:**
  - Mulish variable woff2 (OFL, licence file included) replaces Inter and the Google Fonts `@import`, for headings and body. (Changed from Caprasimo + Figtree at the Phase 4 checkpoint, 2026-11-01.)
  - Lucide SVGs at stroke 2.75, inlined where the app and extension draw icons today.

### Phase 4: Restyle the self-hosted app and extension

- **4.1 App CSS:**
  - Rebuild `public/*.css` on the Organic tokens and component classes (`.btn`, `.field`, `.card`, `.nav`, `.table`, `.dialog`, `.tag`, `.seg`) and its direction: left-aligned, over-rounded, pill buttons, generous air.
  - Collapse `theme.css` overrides into tokens. Target: substantially fewer than today's 8.2k lines.
  - Update the Dioxus markup (`app/src/*.rs`) only where class names or structure have to change. Behaviour doesn't change.
  - Boot screen and brand mark use the new logo.
- **4.2 Extension** ∥ (disjoint from 4.1): popup, setup and connect pages on the same tokens, fonts and icons; new icons.
- **4.3 Visual QA:**
  - Playwright screenshots of every screen (onboarding, library, meeting review, transcript, notes, settings tabs, models, extension connect, popup, setup) in light and dark, saved to `tmp/screens/`.
  - axe e2e green. **Checkpoint: you review the screenshots.**

### Phase 5: Site (landing + docs) and the docs rewrite

- **5.1 Scaffold `site/`:** Astro + Starlight as a pnpm workspace package. `site` is `https://echo-web.samarthmn.com`.
  - Landing at `/`, adapted from `design-system/templates/landing/`.
  - Starlight serves `/docs/**`. Its content collection uses a `glob` loader with base `../docs`, so `docs/` stays the one source and renders on GitHub as-is.
  - `PLAN.md` and `superpowers/` are excluded.
  - A small remark plugin rewrites repo-relative `.md` links (`./install.md#x`) to site routes. `starlight-links-validator` fails the build on broken links.
- **5.2 Starlight theme** ∥ (after 3.2): map the Organic tokens onto `--sl-color-*` and `--sl-font*`, light and dark, with the logo in the header. Search is Pagefind (built in, no third party).
- **5.3 Landing page** ∥. Sections:
  1. Hero: "Open-source AI meeting notes that never leave your laptop", with a CTA to "Self-host in 10 minutes" (docs) and the GitHub link.
  2. How it works: extension → local server → on-device Whisper → Ollama notes.
  3. Features: no bot in your call, speaker grouping, encrypted library, recovery phrase, calendar, upload existing audio.
  4. Privacy and data flow diagram.
  5. **Comparison table**: Echo vs Fireflies vs Otter.ai vs Fathom. Columns: runs locally, joins as a bot, account required, price, open source, data location. Each competitor cell is sourced and dated in a footnote.
  6. Requirements: Apple Silicon Mac.
  7. FAQ.
  8. Footer: MIT, GitHub, docs, privacy, plus a "not a service" note.
  - Real app screenshots from 4.3 go in `.washed` frames.
- **5.4 Docs rewrite** ∥. Information architecture (files live in `docs/`, each with Starlight frontmatter `title` + `description`):
  - **Getting started:** `index` (what Echo is and isn't), `requirements` (hardware, disk per hour of audio, RAM per model), `install` (step by step from a fresh Mac: Xcode CLT, rustup, Node, pnpm, clone, `setup.sh`, `start.sh`), `first-recording`.
  - **Using Echo:** `extension` (unpacked and Chrome Web Store), `recording` (online, in person, upload), `transcription-models`, `speakers`, `notes-ollama` (models, sizing), `calendar` (create your own Google OAuth client step by step, scopes, test-user mode).
  - **Self-hosting:**
    - `configuration` (full `echo.config.json` and env var reference, ports, bind address, data dir)
    - `auto-start` (launchd)
    - `updating` (with `scripts/update.sh`)
    - `backups-and-recovery`
    - `security-model` (loopback-only, Keychain, encryption, extension pairing, threat model, what is and isn't protected)
    - `privacy` (every network request Echo can make, and when)
    - `troubleshooting` (wired to `doctor.sh` output)
    - `uninstall`
    - `faq`
  - **Reference:** `architecture`, `cli` (`--recover-library`, `--check-library`, `--version`), `http-api` (overview of `/api` and `/extension/v1` for contributors), `changelog` (symlinked or included).
  - **Contributing:** `development`, `releasing`.
  - Remove stale references (ChatGPT, `app/src/chatgpt.rs`).
- **5.5 SEO:**
  - Unique `<title>` and meta description per page; canonical URLs; `@astrojs/sitemap`; `robots.txt`; OG and Twitter cards with the 3.1 image.
  - JSON-LD: `SoftwareApplication` (free, macOS, MIT) on the landing page, `FAQPage` on the FAQ.
  - Alternative pages `/alternatives/fireflies`, `/alternatives/otter`, `/alternatives/fathom` (short and factual, linking to the comparison).
  - Semantic headings, image alt text. Target Lighthouse ≥ 95 on all four categories.
- **5.6 Cloudflare:**
  - `site/wrangler.jsonc` (Workers static assets, `not_found_handling: "404-page"`) and `site/public/_headers` (CSP, HSTS, nosniff, referrer-policy, permissions-policy).
  - The Cloudflare Web Analytics beacon goes on the site only; the token comes from you.
  - A `docs/releasing.md` section on the dashboard setup (Git integration, root `site/`, build `pnpm build`, custom domain `echo-web.samarthmn.com`).
  - Add a `/privacy` page for the site analytics and for the extension (required by the store).

### Phase 6: Production-readiness extras

- **6.1 Community files:**
  - `CONTRIBUTING.md` (dev setup, checks, commit style, how to propose features), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (GitHub private vulnerability reporting, supported versions, scope: local-only threat model).
  - `.github/ISSUE_TEMPLATE/{bug,feature,config}.yml`, with the bug form asking for `doctor.sh` output; `.github/pull_request_template.md`; `CHANGELOG.md` (Keep a Changelog).
  - A recording-consent notice ("you're responsible for consent and local recording laws") in the README, docs, onboarding and store listing.
- **6.2 Supply chain:**
  - `.github/dependabot.yml` (cargo, npm, github-actions; weekly; grouped).
  - `deny.toml` + `cargo deny check` (advisories, licences against an allow-list, bans, sources) and `pnpm audit --prod` in CI.
  - Pin all actions to commit SHAs; minimal `permissions`.
  - A licence inventory in `docs/licenses.md`: deps, fonts (OFL) and model licences (Whisper, pyannote, WavLM).
- **6.3 Versioned releases:**
  - One version source. The Cargo workspace version is canonical; a `scripts/version.ts` syncs `package.json` and `extension/manifest.json`. Launch at **`v1.0.0`** (my call; see §9).
  - `echo-server --version`. The version shows in Settings → About.
  - `.github/workflows/release.yml` on `v*` tags: build on `macos-14`, run checks, package the extension zip (unpacked build) and a store zip (no `key`), write SHA-256 checksums, and create a GitHub Release with that version's CHANGELOG section.
  - `docs/releasing.md` documents the steps.
- **6.4 Chrome Web Store readiness:**
  - The store build drops `manifest.key`. `public/js/extension-id.json` becomes `{ "ids": [storeId, unpackedId] }`, and the web app and connect page try both. The server's origin check already accepts any valid ID, so the pairing flow is unchanged; confirm with a test.
  - Listing copy, single-purpose statement, a justification for each permission (`tabCapture`, `offscreen`, `scripting`, optional hosts), privacy practices answers, and screenshots. All of it goes in `docs/store-listing.md` for you to paste in.
  - Publishing is manual from your developer account.
- **6.5 Diagnostics and health:**
  - `GET /api/health` (version, library state, Keychain reachable, disk free, Ollama reachable). Loopback-only like the rest; no secrets.
  - `scripts/doctor.sh` preflight: macOS version and arch, Xcode CLT, rustup + wasm target, Node/pnpm versions, `wasm-bindgen` matches `Cargo.lock`, port free, data dir writable, Keychain item present, Ollama reachable, extension built, disk space. Prints fixes.
  - Clearer first-run errors in `setup.sh` and `start.sh` that point to the docs pages.
  - `scripts/update.sh`: `git pull --ff-only`, `setup.sh`, restart launchd if installed.

### Phase 7: GitHub presence and SEO

- **7.1 README rewrite** (concise, scannable):
  - H1 "Echo: open-source, local AI meeting notes"; a one-line pitch naming Fireflies/Otter; badges (CI, licence, release, Chrome Web Store when live); hero screenshot/GIF.
  - Why Echo; feature list; condensed comparison table; 5-step quick start; links into the site docs; requirements; privacy and consent; contributing; licence.
- **7.2 Repo metadata** (outward-facing; **I'll show you the exact command before running it**):
  - `gh repo edit` with description *"Open-source, local-first AI meeting notes for Mac. A private Fireflies / Otter.ai alternative: record, transcribe (Whisper) and summarize (Ollama) without your audio leaving your laptop."*
  - Homepage `https://echo-web.samarthmn.com`.
  - Topics: `meeting-notes`, `meeting-recorder`, `transcription`, `speech-to-text`, `whisper`, `ollama`, `local-first`, `self-hosted`, `privacy`, `fireflies-alternative`, `otter-alternative`, `ai-notes`, `speaker-diarization`, `chrome-extension`, `rust`, `macos`, `open-source`.
  - Enable Discussions and private vulnerability reporting.
- **7.3 Social preview:** upload the 3.1 image (GitHub has no API for this; you do it in Settings, and I'll give you the file).

### Phase 8: Verification and PR

- `./scripts/check.sh --all` green locally and in CI; lint and typecheck clean; site builds with zero broken links; Lighthouse ≥ 95; axe green in both themes.
- **Fresh-clone rehearsal:** in a clean directory, follow `docs/install.md` word for word through the first transcribed meeting, and fix the docs wherever reality differs.
- A library made on `main` before this branch opens on the branch (the compatibility rule from 1.1).
- Open one PR `claude/production-hardening → main` with a summary per phase, screenshots, and the list of manual steps (§8).

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `typescript-eslint` doesn't support TS 7 | Pin a JS-API TypeScript as the parser peer; keep `tsc` 7 for typecheck (2.7) |
| ChatGPT removal breaks old libraries or backups | Explicit compatibility rule and fixture round-trip test (1.1) |
| Restyle regresses accessibility or flows | Behaviour unchanged, axe + e2e gate, screenshot checkpoint (4.3) |
| A Dioxus restyle needs markup churn across 2k-line files | Prefer CSS-only mapping; change RSX only where needed; review per screen |
| Starlight sourcing from `../docs` + GitHub-friendly links | Remark link rewrite + links validator; verify both renderings |
| Two extension IDs (store vs unpacked) | ID list in `extension-id.json`; tests for both (6.4) |
| Competitor facts go stale | Footnoted sources with "as of" dates; listed in `docs/releasing.md` as a pre-release check |
| Node type stripping limits (no enums or namespaces) | `erasableSyntaxOnly` in the base tsconfig catches this at typecheck time |

## 8. Manual steps only you can do

1. Pick the logo (3.1) and review the app screenshots (4.3) and the landing page (5.3).
2. Cloudflare: connect the repo via Git integration (root `site/`), add the custom domain `echo-web.samarthmn.com`, enable Web Analytics and give me the beacon token.
3. Chrome Web Store: developer account (one-time fee), create the item, paste the listing from `docs/store-listing.md`, upload the store zip, submit for review. Send me the assigned store ID for `extension-id.json`.
4. GitHub: approve the `gh repo edit` command (7.2), upload the social preview (7.3), and tag `v1.0.0` after the PR merges (this triggers the release workflow).

## 9. Open questions and calls I made

**Resolved:** legacy-vault migration is removed in Phase 1 (1.3).

**My calls (override any of these):**

- Launch version `v1.0.0`. Alternatively `v0.3.0` if you'd rather signal "early".
- Docs source stays in `docs/` (not `site/src/content/docs`) so GitHub and the site share files.
- Old ChatGPT notes stay readable and labelled "legacy"; the `<dataDir>/chatgpt` folder is never auto-deleted.
- Fonts and icons are self-hosted; no Google Fonts anywhere, including the site.
- A third CI job on `ubuntu-latest` for lint, typecheck and site build (cheaper and faster than macOS).
- `doctor.sh`, `update.sh` and `/api/health` were added as part of "diagnostics".
- Contributor Covenant 2.1 and Keep a Changelog formats.
- Package `name` becomes `echo`; repo name unchanged.
