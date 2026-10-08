# Chrome Web Store preparation

Do not submit this development package until browser/OS/service qualification and the independent capture, authorization and recovery review gates are complete. Submission and accepting developer agreements require separate approval.

## Listing draft

**Name:** Echo Voice — meeting recorder

**Short description:** Record browser meetings locally, then transcribe and create notes in your Echo workspace.

**Description:** Record the meeting you attend in your existing browser tab. Echo captures call audio and, with permission, your microphone while your meeting identifies it as unmuted. Camera access is never requested. Recordings remain in your browser if your local Echo workspace is offline, with recovery and WAV export. Pair with your local Echo library to transfer recordings for final transcripts and notes. Optional live text uses Echo's existing local Turbo model in an open workspace tab. Echo does not join calls automatically or bypass host admission. Supported browser/service combinations must be qualified before release; English meeting controls are required for microphone-state detection.

## Permission justification

Use the exact scope explanations in docs/browser-extension.md. tabCapture and activeTab require a Start action on the meeting tab; scripting observes only call/mute state; offscreen owns background audio; storage/unlimitedStorage persist recovery data and settings; alarms coordinate retries; optional provider hosts are service-specific; loopback hosts reach the configured local Echo only. No cookies, history, camera, debugger, native messaging, desktop capture or broad website access.

## Required materials and checks

Production archive: `npm run package:extension`. Inspect its file list and validate Manifest V3/CSP/bundled code and stable development identity separately from the assigned store identity. Icons must include 16, 32, 48 and 128 pixel PNG assets. Use sanitized product screenshots of setup, recording/source indicators, paused recording, pending library and final Echo review. Do not fabricate qualification screenshots or include private account content.

Sanitized application overview assets: [desktop](extension-assets/echo-overview.png) and [320 px mobile](extension-assets/echo-overview-mobile.png). These illustrate Echo layout. A [final Echo transcript](extension-assets/clean-mute-transcript.jpg) records the bounded Brave/macOS Meet test. Extension setup, recording/source, pause and pending-library screenshots still require the corresponding live scenarios; the available images do not establish full browser/service qualification.

Privacy explanation must cover local browser/IndexedDB audio, scoped local server transfer, explicit microphone and participant permission, ungated-mic exclusion, retention/redundant-copy removal, export/delete, browser-profile uninstall loss, and optional existing Echo notes services. No additional analytics or telemetry are introduced by this feature.

Before release check the published [Chrome Web Store policies](https://developer.chrome.com/docs/webstore/program-policies/) and [Manifest V3 remote-code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code). The package must contain no fixtures, tests, local libraries, credentials, recordings, log files or downloaded executables. Manual store review and service policy/account requirements remain independent of automated tests.
