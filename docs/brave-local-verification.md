# Local Brave verification — 4 October 2026

Tested the source build on macOS 27.0.1 / Apple Silicon with visible, isolated Brave sessions (Brave 1.96.61, Chromium 154.0.8037.98). Built the release server and Dioxus/WebAssembly assets locally. Test libraries, generated speech, browser profiles, screenshots, and logs stayed under the project's ignored `tmp/` directory; existing user meetings and browser profiles were not used for test mutations.

## Test and restart loop

1. Built the app with `bash scripts/build.sh` and ran all eight browser suites in Brave. All passed.
2. Updated the vulnerable transitive `sharp` dependency using an npm override, preserving Transformers.js 3.8.1. The lockfile resolves sharp 0.35.5 and patched libvips packages. Rebuilt from the updated lockfile, started fresh server libraries and Brave sessions, and repeated all eight suites. All passed again.
3. Downloaded and initialized the real Whisper Tiny English model in Brave. Uploaded a generated 13.93-second spoken WAV through the UI, created a real local transcript, and generated real local notes with the already-installed Ollama model `gemma4:e4b-mlx`.
4. Restarted both the server and Brave with the saved disposable library/profile. Blocked every external HTTP request and regenerated the transcript using the cached speech model. It succeeded with zero external requests. Original audio, earlier transcripts, notes, and model cache remained available. Checked source-version restoration, evidence navigation, original-audio playback, and playback speed.

| Check | Final result |
| --- | --- |
| Release browser assets and native macOS server | Passed |
| `npm test` | 38 passed, 0 failed; repeated after dependency update |
| `cargo test --locked -p echo-server` | 23 passed, 0 failed |
| Python meeting-runner tests | 3 passed, 0 failed |
| Brave recording/recovery and imports | Both full passes passed, including decoded MediaRecorder audio, source loss, denied permission, upload retry, and 17 MB chunked import |
| Brave workspace and settings | Both passes passed: navigation, search, recording controls, persisted preferences, drafts, vocabulary, backups/restores, and mobile layouts |
| Brave meeting review | Both passes passed: transcript corrections, speakers/samples, highlights/bookmarks, notes/actions, version history, exports, playback, and deletion |
| Brave ChatGPT setup and notes fixtures | Both passes passed: connection/recovery, model preferences, allowance states, explicit cloud consent, provider provenance, and error handling |
| Accessibility | Both passes passed: 12 core page/dialog states, seven account-connection audits, desktop/mobile cloud-consent audits, keyboard focus and Escape behavior |
| Real Whisper download and local inference | Passed; the short generated fixture transcribed accurately |
| Real local Ollama generation | Passed: summary, Friday website-launch decision, Sam's release-checklist action, Maya's design-review action, and valid passage evidence |
| Restart and cached inference with external HTTP blocked | Passed; zero external requests |
| `npm audit` | 0 vulnerabilities after rebuild |
| `git diff --check` | Passed |

The additional diagnostic scripts initially needed two corrected expectations: downloaded-model status includes an adjacent Default label, and regenerated transcripts use new passage IDs. Older notes correctly disable evidence links until their original source transcript is restored from Details. These were test expectation corrections, not application failures.

## Scope

Recording checks used Brave's generated microphone stream; the real inference fixture used macOS speech synthesis. These establish browser capture/save/playback and the local processing path, not physical-microphone quality or recognition accuracy across languages and devices. Only Whisper Tiny English and the installed Ollama model above were exercised with real inference.

Live ChatGPT login/generation, Google OAuth/Calendar synchronization, and live Google Meet joining were not exercised. Their local UI/error/consent behavior was tested with fixtures or unavailable-service states. The optional meeting guest remains Linux-only. No real account was signed in and no user transcript was sent to a cloud provider.

Generated test artifacts and disposable data/profiles were removed after verification. The source build remains available in `target/release/` and `public/`.
