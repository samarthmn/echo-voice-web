# Echo Voice web product plan

This is a proposed product plan for a web version of Echo Voice, based on the current app's documented features and visible user controls. It describes what users should be able to do, without prescribing technologies or implementation. Features below are planned web behavior, not claims that a web product already exists.

## 1. Product purpose

Echo Voice for the web is a private meeting workspace where people can record conversations, read and correct transcripts, generate useful notes, and verify those notes against the original audio.

The central journey is: choose a recording mode → record → review the transcript → check notes against evidence → save useful moments → export or delete.

The product should preserve Echo Voice's current local-only privacy promise: meeting content remains under the user's control and is not sent to external services. A web interface must not quietly introduce accounts, hosted meeting processing, automatic sharing, or cloud storage. Any future change to that promise would be a separate product decision.

## 2. Intended users and situations

- People attending online meetings who want a searchable record without a meeting bot.
- People recording in-person discussions using a room microphone.
- People who need accurate names, terminology, and speaker labels through manual review.
- People who revisit long discussions to find decisions, commitments, and the words supporting them.
- Existing Echo Voice users who want a familiar browser workspace and continuity with their saved library.

## 3. Workspace and navigation

The main workspace should contain a date-grouped meeting library, search, a prominent New Meeting action, and a meeting review area. Each meeting opens to Notes when available, otherwise Transcript. Once the user chooses a view, background processing should preserve that choice.

Meeting details should collect recording information, processing status, selected processing choices, result provenance, transcript history, and saved highlights and bookmarks. Settings and the Setup Guide should remain easy to find.

Active recording controls must remain visible while the user browses other meetings. The interface must distinguish the active recording from the meeting being reviewed.

## 4. First-use experience and readiness

- Offer a short Setup Guide with separate recording and transcription readiness.
- Let users finish setup later and return to it at any time.
- Explain the privacy promise before the first recording.
- Request permissions only when the user chooses the corresponding action.
- Show whether access is available, denied, or needs attention, with a useful next step.
- Allow recording before transcription or notes setup is complete; clearly explain that processing will wait.
- Make optional downloads, access terms, and additional setup explicit choices.
- Provide a useful empty-library screen with actions to start a meeting or import an existing library.

## 5. Meeting setup and recording modes

**Online meeting:** let the user name the meeting, select the meeting-audio source, and choose a microphone. Preserve meeting audio and microphone audio independently. Explain the exact capture scope before starting. Recording only one source must be an explicit choice.

**In person:** record the selected room microphone without requiring a meeting-audio source. Offer optional speaker grouping after recording. Explain that grouping labels voices in a shared recording and does not create isolated recordings of each person.

Both modes should include participant-consent acknowledgement, an optional input test with discarded test audio, clear input names, a live-transcription choice, and an option to begin with Echo Voice's microphone capture muted. Per-meeting processing overrides should be available without complicating the default setup.

For online meetings, offer headphone and speakerphone listening choices where supported. Speakerphone processing should preserve the original microphone and meeting recordings and label any cleaned microphone audio separately.

**Web qualification requirement:** define and publish which sources and recording controls are actually available in each supported browser and device environment. Do not promise unrestricted desktop-application capture or silently widen capture when a selected source is unavailable. Show unsupported options clearly and give the user an explicit alternative.

## 6. Recording controls

- Start, pause, resume, stop, and save a recording.
- Show elapsed time, selected sources, source levels, microphone mute state, and recording status.
- Keep a prominent Stop Recording action available throughout the workspace.
- Explain that muting capture in Echo Voice does not mute the user's microphone in the meeting application.
- Preserve microphone mute state when changing inputs; muted time should remain a visible gap rather than invented audio or text.
- Allow explicit input changes during recording wherever supported, retaining saved material and clearly marking interruptions.
- Never choose a replacement microphone or broader audio source automatically.
- Warn when a selected source disappears, access is lost, storage is running low, or the recording needs attention.
- Explain any requirement to keep the recording workspace open. Make leaving or closing an active recording an explicit, understandable situation.

Speech or notes processing failures must not deliberately end recording or discard saved audio. Actual browser and device behavior must be qualified before this reliability promise is advertised.

## 7. Live transcription

Users should choose whether to show live transcription before starting. Live text should be visibly provisional until finalized, with uncertainty and gaps presented honestly.

If live transcription is enabled, users can stop it for the rest of that meeting while audio recording continues. Existing text remains visible, and final processing completes the remainder after recording stops. Pausing, resuming, or recovering the meeting must preserve this choice. Restarting live transcription requires a new meeting.

The workspace should distinguish recording status from transcription status so a processing delay is not mistaken for lost audio.

## 8. Transcript reading and correction

- Display timestamped passages, speaker labels, and provisional or uncertain text.
- Support long meetings with manageable transcript sections and navigation.
- Search the meeting library and transcript content, opening the relevant passage from a result.
- Let users edit passage text, copy selected text, and rename meetings.
- Keep corrected text available when subsequent processing fails.
- Preserve evidence links and timing relationships during review.
- Make approximate word timing and passage-level timing understandable.
- Show speaker-attribution boundaries where available without changing the spoken text.

## 9. Audio replay

Replay should connect the transcript to the original recording. Users can click a timestamp or aligned word to seek, play or pause, scrub through the timeline, jump five seconds backward or forward, and choose playback speed.

Offer Conversation playback and the available individual tracks: meeting audio, microphone or room microphone, and cleaned microphone. Do not imply individual speaker recordings exist when only a shared room recording is available.

The active passage and aligned words should follow playback. Manual scrolling or text selection should suspend automatic following, with an explicit Follow Playback action to resume it. Missing, muted, and interrupted intervals should remain visible.

## 10. Speaker grouping and review

- Offer optional grouping of voices into generic meeting-scoped labels.
- Allow grouping to run after recording, including when it was initially disabled.
- Provide short speaker samples and a next-sample action to help users name labels.
- Let users rename labels throughout a meeting.
- Mark uncertain attribution and overlapping voices.
- Provide a section-based retry for difficult long recordings; section-local labels must remain clearly scoped.
- Explain that speaker labels are editable attribution aids, not verified identities.

## 11. Meeting notes and evidence

Generated notes should contain Summary, Decisions, and Action Items. Action items can include an owner and due date when supported by the meeting evidence, and users can correct those fields.

Every supported note should link to the relevant transcript passage so users can check what was said and replay its audio. Generated text should be presented as a draft for review.

Users should be able to edit notes, save an edited version, browse earlier versions, and generate a new draft without losing earlier work. Partial drafts and notes made outdated by transcript or speaker changes must carry clear labels. Failure should preserve completed drafts and reviewed text.

Action items remain part of the meeting record; this plan does not add a separate task-management system.

## 12. Highlights and bookmarks

- Highlight selected words or whole passages.
- Bookmark any point in the recording, including silence or a gap.
- Browse all saved moments in meeting details and jump to the associated passage or time.
- Add or edit labels and remove saved moments.
- Filter the transcript to highlights while making clear that audio playback still follows the full recording.
- Include saved moments in relevant exports.

## 13. Vocabulary and preferred spellings

Maintain a reusable vocabulary for names, organizations, acronyms, and specialist terms. Each entry should support a preferred spelling, literal “heard as” aliases, an enabled state, and prioritization where supported.

Users should be able to search, add, edit, disable, or remove entries and import or export a vocabulary list. Similar-sounding correction should be optional and off by default.

Each transcription run should retain the vocabulary choices used for that version. Regeneration should offer a clear choice to use the current vocabulary.

## 14. Transcript regeneration and history

Let users regenerate a transcript from saved audio with an explicitly selected speech-processing choice. Keep the current transcript readable while regeneration runs and preserve it if the new run fails or is cancelled.

Retain earlier transcript versions, edits, notes, and annotations. Show which version is active and let users activate a completed version when conflicting recording, playback, or editing has finished. Notes regeneration should be a separate action. Changes affecting the evidence should mark dependent notes outdated.

## 15. Processing choices and transparency

Provide separate choices for speech recognition, meeting notes, and speaker grouping. Users can inspect available options, set defaults explicitly, turn optional processing off, and override choices for an individual meeting where supported.

Setup should show required storage, readiness, download progress, cancellation, retry, verification, and removal. Downloads may continue during recording; activation should wait until it can happen without interrupting current work. Saved text must survive removal of a processing option.

Meeting details should distinguish a selected option from one that actually produced a result, and retain historical provenance. Queued work must wait for its original selection rather than silently switching. Support the existing optional compatible local notes-provider workflow where qualified for the web experience, without automatic provider fallback or external meeting processing.

## 16. Processing progress and recovery

Show separate progress for audio preparation, transcription, speaker grouping, and notes. Failures should have a reason and a specific retry or setup action while successful results remain available.

Support queued meetings and Retry Unfinished Processing. A new recording should take priority without discarding earlier processing progress, and queued work should resume when appropriate.

After an unexpected interruption, identify the affected meeting and offer either reviewing inputs and consent before resuming or processing the audio already saved. Recording must never restart automatically. Preserve saved material, expose gaps, and make recovery from interrupted deletion understandable. Problems with one meeting should not prevent access to healthy meetings wherever possible.

## 17. Library and storage

Provide a searchable meeting library grouped by date, readable processing states, meeting renaming, storage information, and export or deletion controls.

Offer importing an existing Echo Voice library into an empty destination. Explain that this copies the source, preserves it, and does not merge two populated libraries. Review migration compatibility before claiming complete desktop-to-web continuity; do not import credentials or executable processing tools as part of a meeting library.

Support storage-efficient retention of completed audio without changing the original audio samples. Give clear low-storage warnings and preserve saved material if recording must stop. Provide understandable backup and recovery guidance and explain the consequences of clearing local browser data wherever applicable.

## 18. Export and deletion

**Export:** provide readable transcripts, timestamped and speaker-labelled transcripts, notes with evidence references, highlights and bookmarks, labelled audio tracks, and meeting information needed to interpret the original timeline and its gaps. Exports should be independent copies. A failed export must leave the meeting intact and must not appear complete.

**Delete a meeting:** explain the affected recordings, text, notes, and pending work, require confirmation, and remove the app-managed meeting. Explain that independent exports and external backups remain.

**Delete a passage and its audio:** preview the time interval and affected content, including simultaneous speech across all managed tracks. Remove affected transcript history and dependent recognition material, retain later timestamps, and show a gap. Explain when imprecise timing requires removing an entire overlapping passage. This action has no Undo and should be unavailable during recording.

## 19. Settings, help, and accessibility

Preserve settings for General and Setup, Processing Choices, Vocabulary, Audio and Permissions, Storage and Import, and About and Help. Include permission troubleshooting, input guidance, privacy information, support, product-version information, and browser compatibility information.

Provide keyboard navigation, accessible labels, readable status messages, and practical shortcuts for new meetings, search, recording controls, playback, and settings. Adapt review layouts to smaller screens. Publish recording support separately from layout support; a usable mobile layout is not a promise of mobile recording parity.

## 20. Delivery priorities

**Phase 1 — Recording and review foundation:** setup, privacy and consent, browser/source qualification, both recording modes, separate audio preservation, recording controls, durable saved meetings, transcript reading and correction, basic search, synchronized playback, progress, recovery, export, and meeting deletion.

**Phase 2 — Complete review workflow:** live-transcription controls, evidence-linked notes, note editing and versions, speaker grouping and samples, highlights, bookmarks, vocabulary, transcript regeneration and history, saved processing provenance, and passage deletion.

**Phase 3 — Complete parity and qualification:** compatible library migration, processing-choice management, optional local notes-provider workflow, qualified speakerphone handling and input changes, long-meeting recovery, storage efficiency, accessibility, and supported-browser/device validation.

All features in this plan remain part of the intended full product. Phases indicate order, not removal of scope. Do not present the web version as complete feature parity until the relevant workflows are qualified.

## 21. Product success criteria

- A first-time user understands the recording scope and starts a supported meeting without completing unnecessary setup.
- Recording and saved audio remain useful when transcription or notes need attention.
- A user can find a passage, replay it, correct it, and inspect the evidence behind a note.
- Regeneration and retries preserve reviewed work and history.
- Source changes, capture gaps, uncertainty, and unsupported environments are visible and understandable.
- Users can move supported libraries, create independent exports, and delete managed content with a clear understanding of the outcome.
- The advertised privacy and compatibility promises match the qualified product behavior.

This plan carries forward Echo Voice's existing meeting workflow. Accounts, automatic cloud synchronization, team collaboration, shared links, calendar integrations, meeting bots, screenshots, and visual-context analysis would be separate future proposals rather than assumed features.
