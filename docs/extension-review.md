# Browser extension implementation review

Status: implementation and review/fix loops are ongoing. Live testing found capture defects, and a plan audit found missing extension library controls. Commits remain local; no release push or CodeRabbit round has started. Live compatibility is not yet qualified. See [qualification matrix and Ubuntu/Codex handoff](extension-qualification.md).

## Verified evidence

- Core JavaScript/native speech/REST regression suite: 145 checks passed. Extension runtime/capture/live/inference/workspace unit suite: 53 checks passed.
- Full isolated Brave application browser suite: all eight scripts passed. Includes real in-person capture/pause/mute/resume/source-end/network recovery, 17 MB upload retry, processing guards, library/settings/review workflows, Calendar dialog keyboard behavior, and 52 page states with zero automated accessibility findings. Both themes and widths 320/390/768/1440 were exercised.
- Rust extension server: final full suite 43 checks passed, including Calendar association; strict all-target server checks and locked build passed.
- WASM release build and strict app code checks passed. Independent runtime recheck: 20 capture/runtime checks and two actual unpacked Brave/server tests passed; all 21 release ZIP assets match unpacked output. Environment: macOS 27.0.1, Brave 154.1.96.61 (bundle 196.61), development extension poonbmodjfijfbfiopememgfijahgbag.
- Human Computer Use in an isolated Brave review window: Calendar uses the approved sublimeinnovationtechnologies@gmail.com account and existing read-only permission; Calendar at 320 px has no horizontal overflow. These observations do not qualify meeting audio capture.

## Review/fix loops

Independent review resolved authoritative live-draft lease initialization, fair lease ownership retry, and deadline enforcement during stalled requests. Temporal ownership now preserves prior committed words without rejecting newly owned words whose start overlaps an older passage.

Server review found that a retry of a valid orphan audio file could bypass file/directory synchronization. The fix repeats both durability barriers before database acknowledgement, with injected failures and independent retest. Modern Zoom/Teams exact hosts now match extension/Calendar allowlists, with positive and hostile-lookalike checks.

Controller review resolved historical import notifications replaying navigation on workspace reload, and preserved legacy recovery actions after a partial track already exists. Finalized legacy recovery was exercised against a real isolated REST server with a preexisting track, retries, active-state rejection, and preservation of the original WAV.

Runtime review found actual wire mismatches in pairing expiry and final import verification, delayed mute-message ordering, disk-full metadata failure hiding the committed prefix, transfer scheduling fairness, and compatibility of the offscreen-document lookup API with the declared Chromium floor. All six fixes passed independent re-review. Actual Brave/server pairing, approval, authenticated transfer of 65 chunks (1,040,000 frames), complete-import verification and redundant local PCM removal passed. Browser tests use synthetic PCM committed to IndexedDB; they do not exercise a real toolbar Start or meeting tabCapture stream.

Independent controller review also approved conservative Calendar association: only fresh authorized account/library events with one matching provider identity and time range can be associated. Ambiguous, stale or unmatched recordings remain ordinary online meetings. That bounded review was complete; subsequent human testing and plan auditing identified the additional defects and missing controls documented below.

Active microphone exclusion, connection revocation, live preview and local recording controls are being completed in the current review loop. Their source checks are recorded separately from live qualification.

Sanitized application overview images are provided in extension-assets. Recording/source-state store screenshots remain pending live qualification.

## Pending gates

Real provider tab-capture/microphone recording and mute/navigation/offline behavior in Brave and Chrome on macOS; all Ubuntu combinations; real sleep/wake, physical disk-full/power-loss tests; installed Turbo/native Large V3 final inference from an extension meeting; store recording screenshots; and release review.

Computer Use policy rejects control of chrome-extension: pages and browser-internal extension management. The user loaded the local package manually. Live qualification therefore requires the user to operate extension setup/start/stop controls while the agent tests Echo and the meeting page. Automated unpacked-profile tests are recorded separately and are not substituted for human/live compatibility passes.

Only the approved test identity may be used. Camera permission is never granted. Credentials, private meeting links, login/verification screens and account tokens must not be recorded in review artifacts.

## Preserved independent review notes

- [Runtime and capture](extension-reviews/runtime-task-review.md)
- [Server authorization and durability](extension-reviews/server-task-review.md)
- [Controller, migration and Calendar](extension-reviews/controller-task-review.md)
- [Live processing initial review](extension-reviews/live-task-review.md) and [fix re-review with final integration disposition](extension-reviews/live-rereview.md)

These notes preserve findings and their disposition. Automated tests reviewed the integrated working tree before the local implementation commit; no executable changes were made afterward.

## Local checkpoint and cleanup

Implementation commit: `08b3fae35422dd3626729d7eeb5c0d09e0d99467` on `codex/large-v3-speakers-dark-mode`. No push or CodeRabbit review was started. Independent review notes and sanitized screenshots are preserved in this documentation. Session-owned scratch reports, logs and failed browser-test profiles were removed after consolidation. The isolated human-test library at `tmp/extension-human-review/library` and its local server on port 3000 remain available for pending live qualification; its private Calendar credential stays outside Git. Existing user libraries and old private runner profiles remain untouched.

## October 8 live attempt and fix loop

Pairing succeeded in the user’s Brave installation and Echo showed Connected. The approved Google test account joined an isolated one-participant Meet call. Brave site permissions showed camera blocked before joining; the call confirmed camera off. The user reported starting recording, but the later screenshot showed the start form and Google Meet not enabled. Echo had no ingest session. This attempt therefore does not qualify live capture, and no microphone exclusion or transfer success is claimed.

The screenshot exposed a narrow toolbar popup: viewport-dependent CSS produced a circular intrinsic sizing problem. The popup now establishes390px width and uses compact spacing. An independent layout test passed with an initial190px viewport, a328px title field, one-line heading and Start visible within600px at normal size. Controls remain reachable at150%/200% CSS scaling; setup remains responsive at320px. Actual toolbar sizing after reload still needs the user’s check.

Investigation also reproduced lost settings updates: concurrent microphone/provider saves could erase provider enablement, and concurrent first reads could create multiple installation IDs. Settings initialization and updates are now serialized in the service worker; provider lists and pairing maps are derived inside the queued update. Existing pairing is preserved. Setup labels Enabled/Not enabled explicitly, and an open popup refreshes its provider hint. This race is a confirmed code defect; the screenshot alone does not prove it caused this user’s missing preference.

Validation after the fixes:57 extension unit checks passed, including four new settings/UI-state regressions; isolated layout check1/1 passed; extension build and production ZIP packaging passed. A separate real AudioWorklet probe on an ordinary isolated local page produced65,365PCMframes in4.19seconds with no processor/page errors. It used synthetic sources and does not qualify actual meeting-tab capture. Changes remain local, with manual extension reload and real recording retest pending.

## October 8 real microphone capture retest

Tested local commit `bd330a5` after the user reloaded the unpacked extension in Brave on macOS. The approved account remained in a one-participant Google Meet call, with camera access blocked. Actual toolbar Start produced an ingest session and streamed committed PCM to the isolated Echo library.

The saved recording contains 183 chunks, 2,923,776 mono 16 kHz frames (182.736 seconds), and no pause gaps. Audio was nonzero while the meeting microphone was on. Following an explicitly observed muted state and the user's confirmation that they spoke the muted test phrase, every sample from second 149 through the end was zero. This verifies microphone exclusion for that observed interval; it does not qualify every mute shortcut, stale-state scenario, or provider.

The recording unexpectedly ended as interrupted while the call remained open. The user confirmed they did not stop recording or reload either the extension or meeting. Complete durable import succeeded and the audio remains available in Echo. The attempt ended before the speaker-test tone, so meeting-tab audio, pause/resume, and uninterrupted capture are still pending. The current build did not preserve an interruption cause after transfer; the partial final chunk indicates a flushed stop, but does not identify its trigger. Treat this as an unresolved live qualification failure, not a compatibility pass.

The test recording has been renamed to “Echo E2E — microphone and mute” to keep private meeting identifiers out of review evidence. Local scratch measurements and the isolated library are retained while investigation and retesting continue. Final transcription with Turbo completed and persisted nine passages, including the requested microphone sentence. All passages were marked Unknown speaker / Needs review. It also included the muted test phrase. An earlier unexpected unmute occurred before the repeated explicit mute, and transcript timing was uncertain; therefore phrase exclusion is inconclusive despite the verified zero-valued later interval. Repeat with a distinct phrase in a fresh recording. Silence also produced short spurious words; transcript accuracy improvements remain outside this change, as requested.

The follow-up diagnostic change records a bounded reason, timestamp, and committed frame for interruption paths, including tab loading/closure, document or meeting changes, provider-ended observations, tab audio track ending, suspension, local-save failures, and recorder recovery. It contains no page content or private URL. The reason remains in the local receipt after successful transfer and is shown in the extension library. This repairs missing diagnostics; the unexplained live stop is not yet fixed or qualified. Root source review, 67 extension unit checks, the extension build, production package, and whitespace checks passed. Additional real-browser receipt assertions were added but have not been run in this loop. A new user-operated capture is required to identify the trigger.

The diagnostic change is committed locally as `fe8ddf8`. Local Ollama notes generation with `gemma4:e4b-mlx` also completed and persisted a version referencing the final transcript. The model returned empty summary/decisions/actions arrays for this microphone-check recording, so this verifies the generation/save workflow, not useful meeting-summary quality. No cloud notes provider was used. The next call-audio capture awaits the user's extension reload and Start action; nothing has been pushed.

## Confirmed loading-event interruption and fix

The next call-audio-only attempt imported 74 chunks / 1,169,493 frames (73.093 seconds), then stopped before the speaker tone. The user read its retained diagnostic: “The meeting tab began loading.” This occurred while opening Meet's audio settings with the same call still active. The generic `tabs.onUpdated` loading event was therefore too broad a stop condition.

Capture now pins Chrome's top-frame document identity at Start. Loading/completion events verify that identity; unchanged documents continue, while replacement or failed verification stops capture conservatively. Browser-trusted `pagehide`, meeting identity changes, tab closure, provider-ended observations and captured-track ending still stop recording. Lifecycle departure excludes the microphone even if newer mute observations arrive. Reinjection replaces the observer/timer/listener and preserves sequence ordering. No new permissions or meeting-page content reads were added.

A separate deterministic test reproduced concurrent popup initialization overriding an explicit microphone exclusion. Popup refreshes are now serialized. Microphone startup reports permission, unavailable device, device-open and startup-interruption failures separately, with no silent call-audio fallback. Neither this race nor a specific device error is claimed as the cause of the user's initial microphone error; their explicit call-audio-only retry did start successfully.

Root reviewed the changes and reran all 86 extension unit tests successfully. Extension build, production packaging and whitespace checks passed. Live retesting of the same Meet settings interaction is pending. A parallel plan audit identified missing Open Echo/Open in Echo, local-delete, extension-side disconnect, live-preview and active microphone-exclusion controls; these remain implementation work, not passed acceptance checks.

## October 8 loading-fix retest — passed bounded capture scenarios

Tested local commit `a49884f` in Brave 154.1.96.61 on macOS 27.0.1. The approved account joined Google Meet normally, with camera blocked and the meeting microphone muted. The user explicitly started **Record call audio only**, live text off, titled “Echo E2E — settings retest”.

- Opening Meet audio settings did not interrupt capture. Meet's speaker-test tone appeared in PCM chunks 74–77 and again after resume in chunks 130–133.
- Echo's Pause command held the committed prefix at 1,824,085 frames / 115 chunks, including another speaker test. Resume continued the same recording. The final manifest retained a 40,014 ms gap at that frame.
- Echo was stopped during recording, with its listener confirmed unavailable. A speaker-test tone played during the outage appeared in chunks 158–161 after restarting the same isolated library. Transfer resumed automatically from acknowledged progress.
- Playing the earlier voice recording in a different Echo tab contributed no audio to the captured Meet tab: every sample in chunks 311–337 was zero during that playback interval.
- Echo's Stop command completed durable import with **356 chunks, 5,679,701 mono 16 kHz frames (354.981 seconds), and `interrupted: false`**. Final transcription of this tone-only recording was deliberately cancelled; the saved audio remained available. This is retention/cancellation evidence, not an ASR accuracy test.

[Saved recording screenshot](extension-assets/capture-retest-saved.jpg). The microphone capture's [final transcript screenshot](extension-assets/microphone-transcript-review.jpg) is retained separately; its mute-phrase result remains inconclusive as explained above. No camera access was requested or granted. The test call was left and both review-owned browser tabs were closed after the loop.

The loading-event interruption is fixed for this reproduced scenario. Microphone phrase exclusion, active microphone exclusion, live inference, actual cross-document departure, and the other provider/browser/OS combinations still require qualification. The loop also found delayed library-row/duration refresh and misleading persistent command-pending feedback; those fixes are under source review before another build. All commits remain local.

## Muted-phrase investigation

The user explicitly reported that the microphone/mute test transcript contained speech they intended to exclude. Inspection confirms that text is present. The saved passage has identical start/end timestamps of 142.98 seconds and is marked uncertain. Raw PCM is exactly zero from second 136 through the saved end; the earlier 115–135 second interval contains audio, including speech-sized peaks at 123–131 seconds. Consequently, the passage timestamp cannot establish a microphone leak during the later confirmed mute interval. A fresh, uniquely worded before/muted/after test is required before clearing this gate. No transcript-accuracy change is claimed or used to hide the result.

## Recording controls and status completion

The next local build adds active microphone exclusion, Open Echo and saved-recording links, confirmed local deletion, scoped live previews, and extension-side disconnect. Microphone exclusion has an independent recording-scoped worklet latch: clearing it still requires a new positive provider gate and cannot add a stream to call-audio-only capture. Disconnect retains local audio, requires confirmed server revocation, and retains pairing when offline. Preview/status responses are recording/installation/library scoped, bounded to 600 Unicode characters, and exclude credentials/full drafts. Saved audio awaiting manual final processing is distinct from actual finalization.

Independent review checked link authorization, shared delete/transfer locking, atomic local storage accounting and command acknowledgement. A small deletion/status race was fixed so deletion of one pending row does not abort other transfers. Echo now receives newly recording library rows and increasing duration without overwriting title/transcript edits or starting processing early. Local control feedback advances from pending to an exact command acknowledgement; it does not infer a global paused state from an old acknowledgement.

Root integration checks: **149 core JavaScript tests, 110 extension unit tests and 45 server tests passed**. Seven Rust app tests passed in the implementation agent. Strict all-target server/app Clippy, release WASM compilation, app assets, debug server, extension build and ZIP packaging passed. An initial core-suite invocation hit the known macOS `/var` versus `/private/var` temp-path assertion; rerunning with the required project-local TMPDIR passed all 149. New isolated-browser wire assertions were added but not run in this loop; current browser control restrictions are not bypassed. The updated server is running against the same isolated test library. Human verification of these new controls remains pending.

The independent mute audit checked adapter semantics, startup exclusion, stale/unknown states, ordering, document identity, offscreen revisions and actual worklet output at 16/44.1/48 kHz. It found no utterance-sized leakage; at most one resampler carry sample (62.5 microseconds at 16 kHz) can follow closure. This does not clear the original user-reported phrase failure: the fresh human retest remains necessary.
