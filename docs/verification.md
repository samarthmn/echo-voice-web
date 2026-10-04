# Verification record — 4 October 2026

Implementation: Dioxus 0.7.10 browser WASM, Rust/Axum REST server, SQLite, browser media/inference bridges. Tests use isolated temporary libraries and controlled recording fixtures. No real user meeting or Google account was used.

The subsequent [macOS Brave verification](brave-local-verification.md) records two full visible-browser passes, a rebuilt dependency fix, real Whisper/Ollama processing, and cached transcription after a server/browser restart with external HTTP blocked. The Linux checks and earlier qualification limits below describe the original run; the linked record extends local coverage without claiming live cloud or meeting integrations.

## Completed checks

| Check | Result | What it establishes |
| --- | --- | --- |
| Release browser build + wasm-bindgen | Pass | Rust Dioxus UI compiles to a standalone WebAssembly browser bundle. |
| Release server build | Pass | The local Axum/SQLite server builds as a native Linux executable. |
| `cargo test -p echo-server` | 23 passed | Storage/version isolation, invalid payloads, host/origin/OAuth guards, local notes protocol/evidence validation, bot recovery and large interrupted bot imports. |
| JavaScript unit tests + real REST smoke | 38 passed | Recorder/inference queue, cancellation, recovery, vocabulary and model cache behavior; actual server CRUD/audio/ranges/history/backup lifecycle; 26 isolated Codex protocol checks. |
| Python runner tests | 3 passed | Token/URL/consent validation and interrupted-session behavior without joining a real meeting. |
| Chromium microphone integration | 5 workflow groups passed | Explicit permission timing, periodic real MediaRecorder uploads, decoded playable audio, pause/mute, resource release, source loss, retained failed chunks and duplicate-free retry. |
| Chromium audio import | Passed | A 17 MB WAV uploads in ordered 8 MB chunks, resumes an injected failed chunk, preserves byte count/duration, and respects automatic-transcription settings/readiness. |
| Dioxus workspace browser flow | 6 workflow groups passed | Actual on-screen record/pause/mute/resume/stop, navigation while recording, permission-denied recovery, search shortcuts, calendar readiness, mobile overflow and zero browser errors. |
| Dioxus review browser flow | 11 workflow groups passed | Real REST transcript/notes edits, history, speaker names/samples, long evidence links, moments, action edits, playback, exports, confirmation dialogs and deletion. |
| Dioxus settings browser flow | 7 tests passed | Persisted preferences and model/language validation, ChatGPT provider consent defaults, setup round-trip draft retention/discard, vocabulary, archives, microphone access and responsive tabs. |
| Dioxus accessibility browser flow | 12 states passed | Automated WCAG A/AA and best-practice checks, keyboard containment/Escape/return focus, skip navigation, mobile layouts, and shortcut isolation. |
| Release browser console | Pass | No uncaught runtime or console errors in the tested workspace/review release flows. |

The late capture-bridge fix normalizes JavaScript `undefined` before returning to Rust and carries browser error messages across the boundary. The on-screen recording test, which caught this issue, passed after the fix. Permission failures also no longer leave the UI locked behind a nonexistent pending recording.

## Reproduce

```bash
cargo build -p echo-server
cargo test -p echo-server
npm test
python -m unittest discover -s tests -p '*_test.py'
# Build the latest UI first; uses /usr/bin/chromium unless CHROMIUM_PATH is set.
npm run test:e2e
```

Build release assets with `./scripts/build.sh`. Browser tests use temporary server workspaces; the settings/review scripts can also target explicitly supplied isolated test URLs. The test launcher starts its own isolated server. Recorder/import scripts reserve fresh ports and refuse a failed server startup rather than accidentally testing an existing workspace.

## Not externally qualified

- **Live ChatGPT subscription:** managed sign-in, account eligibility, cloud generation and actual subscription usage were not exercised with a real account. The official pinned helper successfully initialized signed out with the final strict configuration and private data folder; protocol and browser journeys use explicitly simulated accounts/results.

- **Real speech model inference:** this environment blocks the Hugging Face model host. The actual worker/bundle loads, and blocked download handling was checked in Chromium, but no real downloaded Whisper model was benchmarked or accuracy-tested here.
- **Real local language-model output:** Ollama protocol, timeout/redirect rules, parsing and evidence checks were tested with a local fixture provider. A installed real Ollama model is a local setup prerequisite.
- **Google OAuth and live Meet:** no Google client credentials or host-admitted meeting were available. The complete routes and local runner exist; actual authorization, admission, changing Meet UI and audible meeting capture require validation in the user's environment.
- **Platform/browser coverage:** automated browser checks ran on Linux Chromium with a synthetic microphone and generated audio fixtures. Safari, Firefox, mobile recording, real hardware and non-Linux meeting bots are not qualified.
- **Full original-plan parity:** the [coverage matrix](feature-coverage.md) explicitly records unimplemented advanced features. No successful test of core capture/review implies these features exist.

## Final combined browser run

The final `ECHO_TEST_BINARY=target/release/echo-server npm run test:e2e` completed successfully against the final release WASM and local asset bundle. It ran microphone integration, chunked import/retry, the on-screen workspace flow, all six settings tests (including delayed initial settings loading), and all eleven review groups. The scripts clean their temporary workspaces. This was the final combined functional check after the capture bridge and settings hydration fixes.

## GitHub handoff and UI review follow-up

The initial implementation was pushed to `samarthmn/echo-voice-web` on `main`. A fresh run passed all 32 core tests (17 Rust, 12 JavaScript/REST, and 3 Python). The subsequent [UI review](ui-review.md) corrected contrast, mobile sizing/tabs, dialog and drawer focus, pending microphone setup controls, upload progress, stable speaker colors, and vocabulary-editor focus.

The updated combined browser suite passed: five recorder groups, import/retry and automatic-transcription checks, six workspace groups, 12 accessibility states, six settings tests, and 11 review groups. A separate 16-state desktop/mobile review/settings audit also found no automated accessibility issues, runtime errors, or overflow. A final display-only fix normalizes empty audio storage to `0 B`; it was rebuilt and checked in Details after the combined suite.

Test launchers verify that their server owns the expected temporary workspace and use bounded startup/shutdown, avoiding accidental use of an existing library. The GitHub workflow builds the release server/UI and repeats the local suite on pushes to `main` and pull requests. Local verification and the first remote CI run are separate; adding the workflow does not imply a successful GitHub run.

## ChatGPT extension and fresh-context design review

The optional connection uses the official Codex 0.160.0 helper. All **64 core tests passed** after the extension: 23 Rust, 38 JavaScript/REST/protocol, and 3 Python. The 26 protocol cases launch an executable fake helper and a real isolated Rust server. They verify consent before transcript access, immediate login completion, cancellation, account/model selection, quota and unknown-allowance rejection, no local-provider fallback, credential environment separation, incompatible helper versions, relative executable paths, crashes/restart, tool-request and final-payload tool rejection, structured evidence, usage provenance, and unchanged previous notes on failure.

Both the release WASM interface and release native server were rebuilt. A separate real-helper smoke check initialized the installed official native executable with `--strict-config`, confirmed a signed-out state and a private `0700` helper directory, then shut down cleanly. It did not initiate login or inference.

A reviewer started with **no inherited conversation context**, inspected fresh desktop/mobile screenshots, and exercised product journeys on a disposable workspace. Its [detailed review](design-review-fresh.md) records findings and rechecks. Changes cover Models information order/navigation, mobile hidden-menu focus, persistent settings drafts and Save/Discard access, first-use priorities, and unavailable connection status/retry. Automated browser tests include regressions for the functional findings.

See [ChatGPT setup and qualification](chatgpt.md) for supported versions, allowance semantics, data sent, credential storage, and external qualification limits.

The final combined `ECHO_TEST_BINARY=target/release/echo-server npm run test:e2e` passed against the updated release UI/server: five microphone groups, chunked import/recovery, six workspace groups, 12 core accessibility states, seven settings tests, 11 review groups, 12 ChatGPT-notes groups, and nine account-connection groups with seven further desktop/mobile axe audits. Browser account and generation fixtures block real authentication, inference, downloads, and external traffic. No unexpected browser errors or horizontal overflow were found in these checked flows.

## CI binary-selection correction

The initial browser run still used a cached debug server for the recorder subtest: that script hard-coded `target/debug/echo-server` despite CI selecting the release binary through `ECHO_TEST_BINARY`. Removing the debug executable reproduced CI's `ENOENT` failure. The recorder now honors the configured binary, retaining the debug path only as its default. CI removes any cached debug executable before browser tests to keep this boundary checked.

The complete browser suite then passed locally with `ECHO_TEST_BINARY=target/release/echo-server` and the debug executable temporarily unavailable. The local binary was restored afterward. This validates the release-only server selection; it does not claim the subsequent GitHub Actions run has completed.

The subsequent LLM-directed Brave review, fixes, and restart verification are recorded in [agent-browser product review](agent-browser-review.md).
