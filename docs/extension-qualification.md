# Browser extension qualification

A successful build or mock test is not a live compatibility pass. Record exact OS/browser version, commit, service, identity (only approved test account), result, sanitized evidence, failure, fix commit and retest for each case. Keep credentials, private meeting links, verification screens and account tokens out of artifacts.

## Matrix

| Browser / OS | Google Meet | Zoom Web | Teams Web |
|---|---|---|---|
| Brave / macOS | Pending live qualification | Pending | Pending |
| Chrome / macOS | Pending live qualification | Pending | Pending |
| Brave / Ubuntu | Pending user desktop qualification | Pending | Pending |
| Chrome / Ubuntu | Pending user desktop qualification | Pending | Pending |

First-release adapters recognize English meeting interfaces. Unrecognized locale/layout must exclude microphone and show a limitation. Do not list any untested combination as supported. Zoom and Teams native clients, mobile extensions, Firefox/Safari and unattended attendance are outside scope.

## Ubuntu setup

Use a real Ubuntu desktop with audio output and a microphone, current Brave or Chrome, Rust stable, Node.js 22+ with npm, and build tools (`build-essential`, `pkg-config`, `libssl-dev`). No Docker, Python runner, virtual sink or separate recording browser is required.

1. Check out the implementation branch and run `bash scripts/build.sh`.
2. For isolated testing create `tmp/extension-ubuntu-review`, set `TMPDIR` there, and launch Echo with `ECHO_DATA_DIR` pointing to its `library` subdirectory. Use an available loopback port and matching OAuth callback config if Calendar is tested.
3. Load `extension/dist` unpacked in each browser following the installation guide. Complete pairing against only the isolated library. Grant microphone permission deliberately. No camera permission is expected.
4. Join each service normally in the existing browser session. Authorized live Google testing uses **sublimeinnovationtechnologies@gmail.com only**. If an account or test meeting is unavailable, report that case pending.
5. Keep test notes/evidence in the project scratch folder. Clean only the review's tabs, fixtures, processes and scratch after outcomes are preserved in the report. Do not delete another session's files or affect everyday browser tabs/libraries.

## Scenario checklist

For every service/browser/OS combination:

- Start after consent with tab audio plus microphone; no camera prompt. Play both sides and confirm no local microphone echo. Test microphone denied and explicit call-audio-only choice.
- Mute/unmute with meeting UI and keyboard shortcuts. Unknown controls, locale, stale observations and background-tab throttling exclude microphone. Exclusion cannot unmute the meeting. Change/disconnect device and verify warning.
- Pause/resume preserves playback and duration excludes gap. Switch tabs and close popup. Play a different tab's sound: it must be absent. Stop, leave the call, close its tab and navigate away in separate trials.
- Record while Echo starts offline; stop Echo mid-recording and return. Close processing tab, suspend/restart worker, sleep/wake, crash/restart browser. Committed audio recovers and capture never restarts without a fresh action.
- Inject slow persistence, failed writes/quota and eight-hour-limit transitions in the automated harness; verify bounded five-second backlog and preserved prefix. No deletion of old unsynchronized recordings. Export offline audio.
- Repeat create/chunk/complete; lose successful responses, reject hash conflicts/missing sequences. Wrong origins, stale pairing, revoked credentials, wrong library and deletion tombstone must fail. Meeting scripts cannot obtain credential or local request bridge. Ordinary API hostile-origin checks remain intact.
- Live on/off, model missing, server unavailable, slow processor, window-boundary words, repeated phrases, silence and long pauses. Two tabs must not overwrite drafts. Final transcription preempts live and keeps draft until successful final version. Notes consume final transcript.
- Playback continuous timeline, saved versions and speaker passages survive restart. Backup/restore preserves recording metadata and old libraries. In-person capture, upload, Turbo and native Large V3 remain usable. Check both themes, keyboard controls and Echo at 320 px width.

## Codex handoff prompt

Copy this into Codex while working in the checkout on Ubuntu:

> Review and qualify the Echo MV3 browser extension on this Ubuntu desktop. Read AGENTS.md, docs/browser-extension.md, docs/extension-qualification.md, docs/extension-migration.md, and docs/superpowers/specs/2026-10-05-browser-extension.md. Use Computer Use in Brave, then Chrome, testing existing meeting tabs for Google Meet, Zoom Web App and Teams Web. Google account testing must use only sublimeinnovationtechnologies@gmail.com. Never request or capture camera access. Use an isolated library and project tmp/ scratch, preserve existing user data and unrelated tabs, and load only the reviewed local extension/dist package with any required action-time approval. Run extension/Rust/JS checks, record exact browser/OS versions and commit, and execute the scenario checklist. Inspect captured audio for both sources and exclusion while meeting-muted/unknown/stale. Exercise offline recovery, crash/worker restart, quota/slow writes, transfer retries/security/tombstones, live overlap/lease/final preemption, and regression workflows. Use implementation subagents for bounded fixes followed by independent review/retest. Keep commits local until release conditions are satisfied; do not publish or accept store agreements. Record unavailable live scenarios as pending, never a pass. Keep tokens, cookies, login/verification screenshots and private meeting links out of logs/repository. Clean only review-owned processes/tabs/fixtures/scratch at the end of each loop. Update docs/extension-review.md with evidence, fixes, retests and remaining limitations.
