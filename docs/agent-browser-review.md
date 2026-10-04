# Brave product review with agent-browser

Reviewed on 4 October 2026 using headed Brave and agent-browser 0.31.1 against `http://localhost:3001`. Actions were chosen from the visible page, as an exploratory user session. No scripted E2E suite was used for this review.

## Result

Two confirmed issues were fixed. The rebuilt app passed a second review after restarting both Brave and the local server with an empty disposable library. No browser console errors were observed during the normal review sessions. Existing user meetings were never modified.

| Issue | Before | Fix and repeat verification |
|---|---|---|
| Meeting timestamps silently displayed UTC | A meeting created at 13:32 showed 08:02, with no timezone label. Dates in cards also used the UTC date. | Cards, headers, details, and version history now use the browser's local timezone. The restored meeting displayed `2026-10-04 · 13:32:32 UTC+05:30`. |
| Notifications intercepted bottom controls | Persistent success/error messages covered the settings Save button. They also obscured the mobile audio player. | Notification placement now accounts for the measured height of settings, playback, and recording controls, including responsive wrapping. Repeated desktop and mobile saves worked without dismissing the previous message. The mobile player and notification had a 12px gap. |

Before: [incorrect time](../artifacts/agent-browser-review/issue-001-utc-time.png), [covered save button](../artifacts/agent-browser-review/issue-002-save-notification.png).

After: [local time and restored notes](../artifacts/agent-browser-review/fixed-time-restored-notes.png), [desktop save](../artifacts/agent-browser-review/fixed-desktop-save.png), [mobile save](../artifacts/agent-browser-review/fixed-mobile-save.png), [mobile playback](../artifacts/agent-browser-review/fixed-mobile-player.png).

## Workflows reviewed

- Empty overview, labelled sample meeting, workspace navigation, setup/help, and privacy information.
- Recording consent gate, microphone access, navigation while recording, pause/resume, mute/unmute, starting muted, saving, native playback, timestamps, and speed controls. Recording controls were repeated after restart, including at a mobile viewport.
- Missing speech model recovery, a real Whisper Tiny download, download completion across navigation, and cached-model recognition after browser restart.
- Uploading a generated spoken WAV, five real transcript passages, correcting a recognition error, speaker naming, searching, highlighting, bookmarks, bookmark labels, and meeting rename.
- Real local Ollama notes with `gemma4:e4b-mlx`: summary, Friday release decision, Sam/Maya action owners, evidence navigation, action completion, manual edits, and notes version history. Generation completed while navigating away.
- Transcript regeneration and restoring the edited version: notes correctly flagged their earlier source, disabled stale evidence, and restored working links when that source became active again.
- Workspace preferences save/discard, vocabulary aliases and export, library search by transcript content, and meeting filters.
- JSON, TXT, SRT, Markdown, original audio, and whole-library exports. Exported text included the corrected transcript and edited/completed action item.
- Full backup restore into a fresh empty library: two meetings, vocabulary, preferences, audio, three original transcript versions, four notes versions, saved moments, and completion state. Downloaded restored audio matched the original WAV byte for byte.
- Meeting deletion confirmation, Escape cancellation, permanent deletion of the disposable recording, and return to the library.
- Desktop 1440×1050, tablet 768×1024, and mobile 390×844 layouts and mobile navigation.

## Method limits

Microphone permission and recording controls used Brave's fake media device in an isolated profile. Recognition and local notes used actual installed models and generated speech, without mocked inference responses. A physical microphone and system/tab-audio capture were not validated in this pass.

Library import uses a detached native file input. A temporary, one-use DOM adapter attached that input so agent-browser could select the exported file; parsing, archive validation, confirmation, and restoration used the normal product flow. The adapter changed no application source or server data directly. Video capture was attempted but changed the automation context's pointer behavior, so the browser was relaunched and screenshot evidence retained instead.

Google Calendar and the meeting runner were reviewed in their unconfigured setup states; live account connection and joining a real meeting were not exercised. ChatGPT was reviewed while signed out. Automatic approval review rejected clicking generation with ChatGPT selected because it could transmit transcript text to OpenAI without specific authorization; no transcript was sent and that cloud generation check remains unverified.

The WASM release build and browser asset build succeeded after the fixes. All disposable profiles, recordings, downloads, runtime sockets, and scratch files were removed after the review. Only this report and selected screenshots were retained.

## Cleanup follow-up

The remaining local server on port 3000 was stopped at the user's request after testing. No review browser or agent-browser daemon remained, and the task's temporary directory, isolated browser profiles, cached speech model, downloads, socket files, and scratch files were absent. Brave's visible window contained personal tabs with no review tab or file chooser; those personal tabs were left intact. No Ollama model runner remained loaded. App dependencies, runnable build output, code fixes, and the selected review evidence were retained.
