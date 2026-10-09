# What Echo can do

This describes the current implementation as of October 9, 2026. Working code and automated tests do not establish compatibility with every browser, device or meeting service. For installation, start with the [README](../README.md). For the latest live test results, use the [extension qualification matrix](extension-qualification.md).

## Recording and meeting review

| Feature | Current behavior | Limits |
| --- | --- | --- |
| In-person recording | Record a room microphone with explicit permission and participant consent; pause, resume, stop and save. | Keep the workspace open. Device loss, browser termination or storage failure can interrupt recording. Saved audio remains available. |
| Browser meetings | The extension records the meeting tab and optional permitted microphone in the user's existing Brave or Chrome session. | Meet, Zoom Web and Teams Web adapters are implemented; live qualification is incomplete. No unattended joining, native meeting-app capture or mobile extension support. |
| Microphone exclusion | Meeting mute, unknown/stale controls and Echo's exclusion control prevent microphone contribution. | English controls are recognized first. Unrecognized layouts exclude the microphone and show a warning. Provider UI observation is not sample-perfect synchronization. |
| Offline extension recording | Capture continues with Echo closed. Audio is saved in the browser and transferred after Echo returns. | One active recording per browser profile; eight hours per recording; two GiB of pending audio. Browser closure interrupts capture. Only committed audio can recover. |
| File import | Upload recorded audio and retain the original source for playback. | The upload interface allows up to 500 MB; browser decoding separately limits an individual processing input to 512 MB or two hours. Codec and memory constraints still apply. |
| Playback | Play/pause, seek, speed control, timestamp links and Follow playback. Sequential extension parts represent one timeline. | Source tracks are not isolated speaker audio. A detailed multi-track waveform editor is unavailable. |
| Transcript review | Search text/speakers, correct passages, rename speakers, compare or restore saved versions. | Recognition and timestamps can be wrong. Corrections preserve the original recording rather than erasing speech from it. |
| Saved moments | Highlight passages, bookmark playback positions, add labels and return to the source. | Highlights apply to whole passages. There is no shared annotation or separate task-management system. |
| Notes | Generate and edit summaries, decisions and action items with passage references and version history. | Notes are drafts; references do not guarantee correctness. Notes use a final transcript, not provisional live text. |
| Vocabulary | Manage preferred spellings and explicit aliases; import/export entries and preserve the vocabulary used by a transcript version. | No pronunciation training or fuzzy matching. |

## Processing

- **Whisper Large V3 Turbo:** the default speech model runs in the browser. Download it in Models before transcription. Speaker grouping also runs locally.
- **Whisper Large V3:** the full model uses Echo's local native speech helper. The current source/runtime setup needs Node.js 22+ and installed dependencies; see [native speech setup](native-speech.md).
- **Speaker labels:** local PyAnnote segmentation and WavLM voice embeddings group similar voices. Labels are provisional identities for review, not verified people. Overlapping speech and short samples can be inaccurate.
- **Optional live text:** the extension's pre-start switch uses an open Echo workspace and downloaded Turbo model. Recording continues when processing pauses or falls behind. Drafts persist separately; final transcription takes priority after import. Implementation exists, but remaining live qualification is listed in the [matrix](extension-qualification.md).
- **Local notes:** Ollama must be installed, running and have the chosen model available.
- **Optional ChatGPT notes:** uses the pinned Codex helper and the connected account's eligible Codex allowance. Every generation requires consent to send the whole selected transcript version, including speaker labels. Audio stays local. See [ChatGPT setup and limits](chatgpt.md).

Echo does not silently switch models, providers or billing methods when a request fails. Existing audio, transcripts and notes remain available. Model downloads require internet access initially; local processing can work with already downloaded models.

## Connections and storage

| Area | Current behavior | Limits |
| --- | --- | --- |
| Extension connection | Connect to Echo opens one local approval; activation finishes automatically. Persistent attempts, cancellation, scoped revocation and advanced code pairing are implemented. | Fresh release qualification and store-identity upgrade tests remain pending; see the [readiness record](production-readiness-status.md). |
| Google Calendar | Optional read-only connection; shows primary-calendar events and opens recognized meeting links. | The current build requires maintainer OAuth configuration. Opening a link never starts capture. See [Calendar setup](integrations.md). |
| Meeting association | Uses an unambiguous, fresh Calendar event match when available. | Stale, ambiguous, disconnected or different-account views leave a normal online recording. |
| Local library | SQLCipher metadata, authenticated encrypted audio, OS-protected keys and recovery phrases. Browser pending recordings use their own public-key envelopes. | Independent review/retests are in progress. Exports can be readable files; protection does not secure an unlocked application or compromised account. |
| Backup and restore | Encrypted library archive; restore into an empty destination using its saved phrase when changing keys/computers. Legacy plaintext web backups still import. Credentials are excluded. | The portable path is bounded. Larger libraries need a stopped-server whole-folder copy and the corresponding phrase. Pending extension audio is separate. |
| Export and deletion | Export transcript text/SRT, notes Markdown, meeting metadata/history JSON and original audio. Deletion confirms scope and protects active work. | Meeting JSON does not include audio. Other exports/backups remain independent copies. No destructive passage-and-audio redaction. |
| Legacy recovery | Recover finalized recordings left by the retired meeting runner. | The runner, Docker environment and separate recording-browser login are no longer part of current setup. See [migration](extension-migration.md). |

## Delivery and qualification

Echo runs as a local web server opened in Brave or Chrome. Initial setup uses the source-build guide; separate desktop applications and installers have been removed from scope. Full Large V3 still requires the local Node/native speech setup. Browser/service qualification on macOS and Ubuntu remains incomplete. The extension is loaded unpacked; there is no published store listing supplied by this repository. See the [publishing guide](extension-publishing.md) and [developer guide](development.md).

The interface includes light/dark themes, responsive layouts, labelled controls, keyboard navigation and automated accessibility checks. These checks do not constitute complete assistive-technology qualification. A responsive page does not imply mobile recording support.

## Evidence

- [PR review and automated checks — October 8](pr-review-2026-10-08.md)
- [Extension human review and remaining scenarios](extension-review.md)
- [Browser/OS/provider qualification and Ubuntu handoff](extension-qualification.md)
- [AMI transcript accuracy report](ami-accuracy-2026-10-05.md)
- [Original October 4 verification](verification.md) — historical baseline

Use the date, commit and scenario in each record when interpreting results. Listed tests, planned work and successful mock workflows are not substitutes for live microphone, account or meeting-service evidence.
