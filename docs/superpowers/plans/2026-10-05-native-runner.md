# Native macOS and Linux Runner Implementation Plan

> Historical plan, superseded by the [browser extension plan](2026-10-05-browser-extension.md). The meeting runner was removed; do not use this document as current setup or implementation guidance. See [migration](../../extension-migration.md).

**Goal:** Open and reuse a dedicated native Google browser on macOS and Linux, with Docker completely removed.

**Architecture:** A native auth manager owns installed Chrome and a private profile. Existing loopback APIs expose native-window actions. A separate Swift helper captures only the dedicated browser application's playback.

**Tech Stack:** Python/Playwright, installed Google Chrome, Rust/Axum, Dioxus/JavaScript, Swift/ScreenCaptureKit.

**Spec:** ../specs/2026-10-05-native-runner-design.md

## Constraints and review focus

- Use only the approved Google test account; block camera/microphone before navigation.
- No credential/profile transfer, automated credential entry, or security bypass.
- Never terminate everyday Chrome or capture other applications; missing process identity fails closed.
- Preserve exact session ownership, cancellation fences, account checks and private storage.
- Keep changes local until the complete qualified flow passes; scratch belongs in project tmp.

## Tasks

- [ ] Add native auth manager and process/profile lifecycle tests; verify ordinary Chrome launch and saved account checks.
- [ ] Add native-window Calendar status/actions and JS lifecycle tests; use the native flow on both platforms.
- [ ] Integrate native readiness, account manager selection and server mode filtering; build and verify auth flow in Brave.
- [ ] Compile application-specific Swift capture helper, verify permission handling and graceful WAV finalization, then integrate recording lifecycle.
- [ ] Remove Docker deployment files, container branches and setup instructions; qualify Linux on the user's desktop.
- [ ] Ask user to complete Google authentication and any required OS permission; qualify account reuse and isolated audio before live meeting.
- [ ] Independently review, retest findings, update evidence, clean owned resources, commit locally, then follow original push/CodeRabbit sequence once qualified.

## Current verification

Native manager, Calendar controls, platform audio adapters, unified launcher and Docker removal are implemented locally. Independent review findings are fixed. Automated checks and the real macOS synthetic native-browser session check pass. macOS capture permission, real Google session reuse/live capture, cross-application isolation, and the user's Ubuntu execution remain pending. The Ubuntu handoff is in `docs/ubuntu-native-runner-test.md`; no native live success or push is claimed.
