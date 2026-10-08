# Runner Sign-in Implementation Plan

> Historical plan, superseded by the [browser extension plan](2026-10-05-browser-extension.md). The meeting runner was removed; do not use this document as current setup or implementation guidance. See [migration](../../extension-migration.md).

> **For agentic workers:** Execute the explicitly authorized parallel subtasks below, then perform independent review and human Brave verification before pushing.

**Goal:** Persist a dedicated Google Meet browser session with account-matched UI sign-in.

**Architecture:** The Python runner owns a private persistent Chromium profile and a thread-bound interactive login session. Rust derives the expected account from Calendar credentials and proxies bounded authenticated commands. The existing Calendar UI displays the remote browser and manages the session.

**Tech Stack:** Python Playwright, Chromium/Xvfb, Rust/Axum, Dioxus/WASM, browser JavaScript.

**Spec:** ../specs/2026-10-05-runner-signin-design.md

## Global constraints

- Only sublimeinnovationtechnologies@gmail.com for live testing; camera and microphone always denied.
- Temporary files only under project tmp; credentials/private browser profile excluded from artifacts and backups.
- Keep the existing branch; commit locally until qualification/review is complete.

## Review focus

- Account switching between login and join: recheck server-derived identity at both boundaries.
- Multiple tabs/processes: exact login-session IDs and exclusive profile ownership.
- Abandoned login or stalled command: bounded waits, cancellation, and cleanup.
- Mobile input and scaled screenshots: coordinate conversion, ordered events, accessible controls.
- Credential exposure: no login payload logs, screenshot retention, profile exports, or public control ports.

## Tasks

- [x] Runner: add private profile/auth manager, screenshot/input transport, persistence/expiry, exact active-account checks, exclusive ownership, virtual display setup and signed-in recording. Add focused Python tests for lock, account, input and permission boundaries.
- [x] Server: add /api/integrations/runner/auth and finish/cancel/screen/input operations; derive account from Calendar, bound responses, gate joins and report separate auth status. Add Rust tests for validation/account mismatch.
- [x] UI: add Calendar sign-in/status/sign-out, responsive interactive browser dialog, session-scoped cleanup and meaningful JS lifecycle tests. Rebuild WASM/assets.
- [ ] Integration: run JS, Rust, Python and strict lint checks; build Docker; test real interactive browser transport and denied media permissions. Verify desktop/mobile Brave UI, then hand off only the unavoidable Google login.
- [ ] Review: independently inspect the integrated diff, fix findings, retest affected behavior, update docs/evidence, clean owned scratch/tabs, and commit locally. Push and request CodeRabbit only after the authorized end-to-end flow is qualified or the user explicitly changes scope.
