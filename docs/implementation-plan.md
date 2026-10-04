# Echo Voice Implementation Plan

**Goal:** Build a usable local browser meeting workspace from the attached plan and requested calendar/bot amendment.
**Architecture:** Dioxus + Axum REST application; local SQLite/files; browser speech worker; optional local notes and meeting runner.
**Tech Stack:** Dioxus 0.7, Rust, Axum, rusqlite, Transformers.js, Playwright.
**Spec:** `docs/architecture.md`, `docs/product-plan.md`.

## Global constraints
- Stable Rust and Node >=22 for source builds; Rust binary only at runtime. Local server binds loopback by default.
- No hosted inference, implicit model fallback, unlabelled demo content, or fabricated meeting success.
- Errors preserve saved recordings and reviewed text. Recording starts only after explicit consent.

## Work packages
1. REST storage: `server/src/store.rs`, `server/src/security.rs`, meeting/settings/vocabulary/storage routes. Validate malformed bodies; preserve histories; reject traversal; retain chunks across process failure. Run Rust and REST tests.
2. Local inference: `web/inference*.js`, `web/recorder.js`, worker and model definitions; actual download/progress/cache/removal, transcribe decoded audio, local notes provider. Verify permission rejection and cancellation preserve audio.
3. Integrations: `server/src/integrations.rs`, integrations routes, `runner/`; OAuth state/refresh/disconnect, calendar events, actual local runner lifecycle. Test URL/CSRF/runner failures. Document unavailable provider qualification.
4. Interface: application shell, overview, searchable library, review tabs, persistent recorder, new meeting/consent, calendar, model manager, settings/vocabulary/storage/setup. Verify real API writes and mobile overflow through Playwright.
5. Delivery: production build, automated checks, browser screenshots, feature matrix and README with exact local run commands. Fix discovered issues and state unverified external workflows precisely.

## Review focus
- Interrupted uploads and tabs preserve committed audio and expose incomplete state.
- Regeneration failure does not overwrite reviewed versions.
- OAuth callback errors do not leak credentials or report connection success.
- Empty library, no microphone, unsupported codec, disconnected provider and unavailable model are useful states.
- Import rejects invalid archives and refuses merges into populated libraries.
