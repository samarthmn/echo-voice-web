# PR review fixes — 2026-10-04

Reviewed all CodeRabbit comments on [PR #1](https://github.com/samarthmn/echo-voice-web/pull/1), including nitpicks, security architecture concerns, and verification warnings.

| Review note | Change and qualification |
| --- | --- |
| Non-JSON HTTP errors were reported as unreadable responses | The browser API preserves JSON error messages when available and otherwise reports the HTTP status. Malformed successful JSON remains a distinct error. |
| Search had no keyboard focus cue | The search wrapper now has a visible `:focus-within` outline. Deprecated wrapping and unnecessary font quotes in the same stylesheet were also corrected. |
| A macOS executable could be labeled Linux x64 | Packaging rejects unsupported hosts before staging source or copying binaries. Linux x64 packaging retains its existing assets and archive names. |
| Models duplicated the speech catalog | Models reads IDs and metadata from `window.echoInference.models`, the shared `web/models.js` allowlist. |
| CI did not validate config with the real Codex helper | CI initializes the optional pinned 0.160.0 helper with the final managed config and `--strict-config`. Missing optional platform packages explicitly skip the smoke test; installed incompatible helpers or rejected config fail it. No login or generation is performed. |
| A remotely bound server could trust forged browser headers | Startup rejects all non-loopback and wildcard listener addresses. The origin override was removed; browser-origin and Host checks remain additional local protections. |
| Failed starts could leave a recording guest active | Starts reserve a durable unique ID before contacting the runner. Ambiguous responses and finalization errors cancel that exact ID. Cancellation is persisted as a fence against delayed starts; unresolved intent survives restart, blocks deletion, remains accessible through Stop bot, and is retried in the background. |
| Function documentation coverage was low | Added function contracts throughout Rust, browser bridges, and the Python runner. CodeRabbit must recalculate its advisory percentage on the updated branch. |
| CodeRabbit's Clippy execution timed out | Local server Clippy passed with all targets and warnings treated as errors; CI now runs the same check. |

Public defaults are initialized from `echo.config.json`. `.env.example` contains only Google client ID and secret. ChatGPT uses subscription sign-in without OpenAI API-key fallback. Runner authentication remains enabled through an automatically generated per-library credential with private permissions, rather than a shared secret committed to source. The runner URL, callback URL, data directory, listener, helper path, browser mode, and admission timeout belong in config. Isolated developer/test shell overrides are documented separately.

Validation passed:

- 25 Rust server tests and server Clippy with `-D warnings`.
- 45 JavaScript/REST tests, including seven recording recovery cases: normal acceptance, response loss, post-acceptance filesystem failure, offline cancellation, startup recovery, reservation-write failure, and background retry.
- Four Python runner tests, including duplicate requests, cancellation before a delayed start, scoped cancellation, and retry identity across restart. The Rust-created credential is readable by the Python initializer without changing it.
- Release WebAssembly and browser asset build.
- Real pinned Codex strict-config initialization using a disposable signed-out home.
- Non-Linux packaging rejection before staging.
- LLM-directed agent-browser review in a fresh isolated Brave profile: visible search outline, model metadata sourced from the shared catalog, mobile model cards without horizontal overflow, and plaintext 502, empty 404, structured 422, and malformed 200 response feedback. Reload restored all temporary response hooks and catalog metadata.

No real Calendar grant, Meet admission, microphone capture, or cloud generation was needed for these changes. Recorder protocol tests use local doubles and never join Google Meet. Existing platform and external-integration qualification limits continue to apply. The isolated browser, test server, and task scratch were cleaned after verification; personal tabs and the user's library were preserved.

## Follow-up CodeRabbit review — 2026-10-04

All four unresolved follow-up findings were valid:

| Review note | Fix |
| --- | --- |
| Cancel cleared the Models busy state before the download settled | Only download cleanup clears busy. A generation check after storage persistence also prevents a cancelled download from starting its worker later. |
| Admission failure always claimed five minutes | The deadline and error message now use the same configured timeout in seconds. |
| Runner `--doctor` always reported no credential | Doctor inspects the existing shared credential without creating or changing files. Missing, malformed, unreadable, non-UTF-8, directory, and symlink credentials report false. Validation matches the runner initializer's accepted token syntax. |
| A plain Stop bot request held the global start lock during runner I/O | The lock still protects pending-start cancellation, but is released before a plain session DELETE. |

Validation passed: 25 Rust tests, 47 JavaScript/REST tests, five Python tests, Rust formatting, server Clippy with warnings denied, and the release WebAssembly/browser asset build. New regression checks reproduced the persistence cancellation, credential false negative, and stalled-stop lock bugs before the fixes, then passed after them. An isolated Brave browser check confirmed that Cancel retains busy until the download settles and that a subsequent download completes normally. Browser downloads were mocked; no model files or real meeting sessions were created.
