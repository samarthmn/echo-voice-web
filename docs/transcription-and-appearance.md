# Transcription and appearance

The speech catalog contains Whisper Large V3 Turbo and Whisper Large V3. Turbo is the default. Saved Tiny/Base preferences and meetings resolve to Turbo when transcribed; existing transcript versions remain intact.

Both downloads include PyAnnote segmentation and WavLM speaker embeddings. Audio, embeddings, and voice clustering run in the browser. Embeddings exist only during processing and are not stored in the meeting library or shared between meetings. No account or new server service is required.

After Whisper generates word timestamps, its model is disposed before speaker inference loads to reduce peak memory. Ten-second segmentation windows overlap by two seconds; only their central regions enter the final timeline. Clean speech from each local channel provides a voice embedding. Matching normalized vectors across windows and saved audio tracks preserves anonymous speaker labels. Distinct channels in one window cannot merge. Words are assigned by overlap with detected turns and merged only within the same speaker; uncertain or overlapping speech is marked for review. Select a speaker label to rename all its passages using the existing versioned transcript editor.

The automatic grouping is approximate, particularly for brief responses, noise, similar voices, and simultaneous speech. Unknown or overlapping turns require review. Browser processing uses WASM and quantized Whisper/WavLM weights; full Large V3 needs considerable memory. Models and speaker companions must finish downloading before offline processing. Cancelling preserves saved audio and completed cache files.

Appearance initially follows the operating system. The top-bar toggle saves light/dark preference in browser storage and applies before the app loads. Another tab changing the preference also updates the current tab. Shared surface, text, border, and state colors cover all four application stylesheets. Mobile layouts use one column and touch-sized controls, with larger input text to prevent mobile browser zoom.

Verification includes voice-cluster continuity and turn/word alignment tests, cache/cancellation tests, existing speaker-renaming workflows, and accessibility/overflow audits of the major screens in both themes at 320, 390, 768, and 1440 pixels. Actual model output and hardware memory limits need end-to-end checks with real recordings; fixture tests do not establish diarization accuracy.
