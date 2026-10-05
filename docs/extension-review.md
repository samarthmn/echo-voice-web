# Browser extension implementation review

Status: implementation, automated review/fix loops and independent code review complete. Live release qualification remains pending. Commits remain local; no release push or CodeRabbit round has started. Live compatibility is not yet qualified. See [qualification matrix and Ubuntu/Codex handoff](extension-qualification.md).

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

Independent controller review also approved conservative Calendar association: only fresh authorized account/library events with one matching provider identity and time range can be associated. Ambiguous, stale or unmatched recordings remain ordinary online meetings. No outstanding concrete defect remains in the reviewed implementation.

Active microphone exclusion during an ongoing recording is deferred; pre-start microphone selection and an explicit call-audio-only choice are available. This is a product limitation, not a tested active control.

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
