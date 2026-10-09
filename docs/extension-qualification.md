# Desktop and browser qualification

Use this guide to qualify the exact release candidate on Apple Silicon macOS 14+ and Ubuntu 24.04 x64. Build success, a mocked provider page and store approval are different kinds of evidence; none substitutes for a live recording test.

Codex owns setup, builds, testing, audio analysis, diagnosis, fixes and cleanup. A person supplies only unavailable account authentication, browser/OS actions blocked by the tool, physical audio/device participation, a real Ubuntu desktop and first-time usability participation. User installation must work without Rust, Node, npm, Python or a terminal.

## Current compatibility matrix

Results below remain pending for the new protected-storage/desktop candidate. [Earlier extension evidence](extension-review.md) records a bounded Brave/macOS Meet test; it must be repeated against the release commit. Record each cell independently.

| Browser | OS | Google Meet | Zoom Web App | Teams Web |
|---|---|---|---|---|
| Brave | Apple Silicon macOS 14+ | Pending fresh qualification; earlier partial capture evidence | Pending | Pending |
| Chrome | Apple Silicon macOS 14+ | Pending | Pending | Pending |
| Brave | Ubuntu 24.04 x64 | Pending desktop access | Pending desktop access | Pending desktop access |
| Chrome | Ubuntu 24.04 x64 | Pending desktop access | Pending desktop access | Pending desktop access |

Use current stable browser versions and record the precise versions. Initial adapters recognize English controls. Unknown or localized controls must exclude the microphone with a warning. Native Zoom/Teams apps, mobile extensions, Safari, Firefox and unattended meeting attendance are outside this release. Do not advertise a pending combination as supported.

All authorized Google account tests use **sublimeinnovationtechnologies@gmail.com only**. Do not open or choose another account. Never grant or request camera access. Use synthetic speech and consenting test participants; keep account tokens, recovery phrases, cookies, private meeting links and verification screens out of evidence.

## Prepare Ubuntu once it is available

1. Open this checkout in Codex on the real Ubuntu 24.04 x64 desktop and provide the handoff below. Codex checks the branch, preserves local work and records the candidate commit. No command needs to be run by the user.
2. Codex checks the desktop session, available space, browsers, audio devices and unlocked Secret Service keyring. Use a dedicated qualification OS account or isolated development data path; preserve everyday libraries and browser profiles. A keyring locked at login must produce a recoverable error, never a plaintext fallback.
3. For source builds, Codex installs only missing build prerequisites through the available approval mechanism. The [developer guide](development.md#install-the-build-tools) covers Rust/Node; desktop packages additionally need `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` and `patchelf`. A running user D-Bus session and Secret Service provider are runtime requirements; a normal GNOME desktop commonly supplies them.
4. Codex builds native assets, server, extension and bundled desktop runtime, then produces the Ubuntu `.deb`. It inventories the artifact, hashes it and records its paths. The build uses `npm run package:desktop` and the `tauri-x86_64-unknown-linux-gnu.json` overlay described below; it must run on Ubuntu x64, not cross-compile a Mac artifact.
5. Install the resulting candidate on a clean Ubuntu desktop or fresh qualification account. The clean-machine run has no development tools and uses the actual OS keyring, not synthetic test-key overrides. Launch Echo through Applications, choose Brave or Chrome and complete the installation journey.
6. Load the reviewed local extension when store distribution is unavailable. Codex performs accessible actions; ask the person for an exact permission/install/reload click only when the browser tool cannot. Later repeat the test using the assigned, store-installed identity before claiming a store-ready release.

### Commands for Codex, not installation instructions for users

Run from the repository root. Keep scratch and tool caches in a unique directory under `tmp/`; remove only that session's files afterward.

```bash
mkdir -p tmp/ubuntu-qualification
export TMPDIR="$PWD/tmp/ubuntu-qualification"
export npm_config_cache="$TMPDIR/npm-cache"
bash scripts/build.sh
cargo build --locked -p echo-server
export ECHO_TEST_BINARY="$PWD/target/debug/echo-server"
cargo test --locked -p echo-server -p echo-desktop
npm test
npm run test:extension
npm run test:runtime-paths
npm run test:desktop-package
node --test tests/protected-storage.test.mjs tests/extension-pairing.test.mjs
node --test tests/release-key-policy.test.mjs
npm run package:desktop
cd desktop
npm exec --yes --package @tauri-apps/cli@2.12.1 -- tauri build --bundles deb --config ../artifacts/desktop-runtime/tauri-x86_64-unknown-linux-gnu.json
```

Select a compatible automated-test browser using `CHROMIUM_PATH` as described in [Run tests](development.md#run-tests). Run formatting, Clippy, WASM, Python and browser E2E checks from that guide too. Inspect `target/release/bundle/deb/` for the actual output filename; do not invent a release download URL.

Automated fixtures explicitly use an isolated library and synthetic key with a debug server. This exercises encrypted data paths without touching personal keys. Real keyring, installer, recovery and update qualification must not set `ECHO_TEST_MODE` or `ECHO_TEST_STORAGE_KEY`. The release-key-policy test verifies that release binaries reject test-key overrides. Debug-only `ECHO_DESKTOP_DATA_DIR` can isolate development GUI testing, but it does not replace clean installed-app qualification.

## Acceptance scenarios

Record pass, fail or pending with evidence for each case. A pass requires the expected result, not merely completion of clicks.

| Area | Required check and expected result |
|---|---|
| Clean installation | Install through the OS software UI, launch from Applications, open the chosen existing browser and create a first recording without developer tools. Installed resources remain unchanged; data uses OS application-data paths. |
| Lifecycle | Duplicate launch attaches safely; a port conflict gives a useful action; quitting with recording/processing warns; crash/restart recovers. Uninstall retains the separate library, and reinstall opens it. |
| Pairing | Connect → approve once → Connected. Close Setup, suspend the worker, restart Echo, cancel, expire approval and lose successful responses. Existing authorization survives cancellation; a different library requires explicit destination confirmation. |
| Consent and audio | Explicit Start and consent capture the original tab and permitted microphone. No camera request, microphone speaker echo or unrelated-tab audio. Denied microphone has an explicit call-audio-only path. |
| Microphone gate | Record distinct spoken phrases while unmuted, meeting-muted, unknown/stale, Echo-excluded and restored. Measure source samples/audio, not just transcript output. Muted/excluded phrases are absent; restored speech returns. Exercise provider keyboard shortcuts, background throttling, device switch and disconnection. |
| Capture lifecycle | Popup closure and tab switching preserve capture. Pause excludes both sources and records a timeline gap; playback continues. Stop, confirmed call exit, tab closure and cross-document navigation finalize only the original recording. |
| Offline capture | Start with Echo closed, stop Echo mid-call and restart it. Audio remains committed locally and resumes transfer. Worker suspension must not stop offscreen capture; browser restart recovers committed audio without silently restarting capture. |
| Storage limits | Automated injection covers quota/write failure, slow writes, bounded five-second backlog and eight-hour finalization. Preserve the committed prefix; never delete other pending audio automatically. Include actual sleep/wake and audio-context suspension on desktop. |
| Protected library | Keyring unlock/relock and missing-key errors fail safely. Save/confirm a synthetic library phrase, recover after removal of only its qualification key, and verify audio and text. Wrong phrases and damaged data do not replace keys or delete evidence. |
| Protected extension | Save a separate synthetic extension phrase; restart with Echo absent, capture new audio with old history locked, then recover/export old history. Authorized Echo unlocks automatically; disconnect/revocation remains locked despite delayed responses. |
| Companion compatibility | An older protocol-1 app without protected-storage/durable-receipt capability produces **Update Echo** and receives no recording metadata or PCM. Current compatible Echo transfers normally. Advanced pairing cannot bypass this requirement. |
| Transfer integrity | Retry create/chunk/complete and lose acknowledgements without duplicates. Reject missing/conflicting chunks, altered encrypted audio and altered library ownership. Retain browser audio until authenticated durable completion; deletion tombstones prevent resurrection. |
| Authorization | Wrong origin, expired pairing, revoked credentials and cross-installation/library access fail. Ordinary `/api` protections remain intact; meeting scripts cannot obtain credentials, private vault material or a general local-request bridge. |
| Live and final text | Test live off/on, missing model, closed processing tab, server outage, slow catch-up, boundary words, repeated phrases and silence. Two tabs share one fenced processing owner. Final processing preempts live backlog and retains draft until success; notes use final text. |
| Regression | In-person recording, uploads, playback, Turbo, native Large V3, versions, optional Calendar connect/disconnect and notes work. Calendar retains read-only scope. Optional helper failure does not break recording. |
| Migration and backup | Copy a stopped old library without changing the source. Reject live locks, symlinks, damaged audio and unsafe legacy runner work. Test encrypted same-library and cross-library backup restore, wrong phrase, interruption and legacy plaintext import. |
| Updates | Actual previous-version installation → candidate preserves library, keys, versions and pending audio. Invalid signatures, incompatible schema/version, bad download and busy work fail safely. Record rollback/recovery. Same-item extension update and different-ID export/synchronize/reconnect are separate scenarios. |
| Usability/accessibility | Keyboard focus, accessible labels, light/dark, zoom, readable popup and 320px workspace. Conduct the [five-person first-use study](first-use-qualification.md); simulated users do not count. |

The macOS updater requires a configured release signing key and qualified feed. Development checks of signed metadata are not an installed update pass. Ubuntu currently directs users to a verified matching package; test that route explicitly. Signing, notarization, feed hosting, store identity and clean-machine evidence remain individual release gates.

## Evidence and cleanup

For each test record: case ID; exact OS/browser/service; app and extension versions; commit and package hashes; prior version when relevant; expected result; observed result; sanitized measurement/screenshot paths; failure; fix commit; retest; remaining dependency. Use pseudonymous participant IDs. Record only that the authorized Google identity was checked, not account screens or private URLs.

Keep scratch under the review's project `tmp/` directory. Promote useful sanitized evidence into a dated `docs/` report before cleaning. Stop only owned processes, leave meetings created for this review, close review-owned tabs, and delete only synthetic fixtures authorized for deletion. Never delete an everyday library, account, browser profile or another review's scratch. Report any retained diagnostic material and why it remains.

## Codex handoff prompt

Copy this prompt into Codex on Ubuntu with the repository open:

> Implement and qualify the approved Echo production-readiness candidate on this Ubuntu 24.04 x64 desktop. Read AGENTS.md, docs/production-readiness-status.md, docs/install.md, docs/storage-and-recovery.md, docs/development.md, docs/browser-extension.md, docs/extension-qualification.md and docs/first-use-qualification.md. Inspect existing work and continue it without overwriting user changes. You own all builds, dependency setup, packaging, tests, measurements, diagnosis, bounded subagent fixes, independent review and cleanup. Use Computer Use in Brave and then Chrome, recording meetings in the user's existing session for Meet, Zoom Web and Teams Web. Google live tests must use only sublimeinnovationtechnologies@gmail.com; never access a camera. Ask the person only for tool-blocked permissions/install actions, personal login/2FA, physical speech/device participation or account-holder decisions. Do not make them run commands or interpret errors. Use isolated synthetic data and project tmp/ scratch; preserve everyday libraries, profiles and unrelated tabs. Build the native .deb and qualify it without developer tools using the real OS Secret Service keyring. Verify pairing cancellation/restart/lost acknowledgement; measured microphone gate; offline/crash recovery; encryption, both recovery phrases, tampering and key failures; import idempotence/tombstones; live lease/overlap/final priority; native Large V3; backups, migration, uninstall and actual updates. Automated debug test keys must never substitute for a real-keyring or release-binary test. Record every browser/OS/provider cell individually with exact versions, commit, artifact hashes, results, fixes and retests. Keep untested combinations pending. Keep credentials, phrases, private links and verification screens out of evidence. Human usability participants must be real and first-time. Commit verified work locally; do not push, publish, accept agreements or change release scope before the existing release gates and authorization are satisfied. Clean review-owned tabs/processes/fixtures/scratch after each loop. Update the readiness record and dated review evidence, then report remaining human-only dependencies precisely.
