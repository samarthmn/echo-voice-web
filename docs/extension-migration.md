# Migrating from the retired meeting runner

The browser extension replaces native/Docker meeting joining. No separate Chrome profile, runner login, Python recording process, macOS audio helper, PulseAudio setup or Docker container is needed. The native Large V3 speech helper remains supported and unchanged in purpose.

Before updating a previously running installation, use its old **Stop bot** control or stop its owned helper, and wait for active recordings to finalize. Do not update while an old helper is still capturing. Echo does not kill unrelated user browser processes or import their cookies.

Existing `runner` configuration is accepted and ignored for compatibility. New configurations omit it. Calendar authorization, meetings, transcript/notes versions, imported audio and completed runner WAV files remain in the library. Old private browser profiles are unused, not automatically deleted or copied into the extension. Remove them only when you explicitly choose to after backing up needed files.

## Recover finalized audio

Old managed recordings are under your configured data directory's `bot/<meeting-id>/meeting.wav`, with `session.json`. Keep the original until recovery and playback are verified.

Echo exposes same-origin discovery at `GET /api/extensions/legacy-recordings`. A `ready:true` record has a terminal session and a finalized WAV. Explicit recovery uses `POST /api/extensions/legacy-recordings/<meeting-id>/recover`; it imports into the existing meeting with deterministic track/chunk identities, so a lost acknowledgement can be retried. The original WAV and private browser profile are preserved. If processed transcript/notes already exist, they are retained.

Use the recovery control in the old meeting's review page when available. A zero-length or incomplete WAV cannot be imported automatically. Active/uncertain start markers remain deletion guards; they are not silently removed. A matching terminal session permits retirement of its corresponding start marker only after recovery succeeds.

For WAV files over 512 MB or audio outside the managed library, stop the old helper, copy the finalized file into a backup folder, split it into smaller standalone audio files if necessary, and import them using Echo's existing upload workflow. Never treat unfinished WebM fragments or unfinalized PCM headers as complete recordings.

Back up the whole stopped library before manual reconciliation. If an uncertain marker has no terminal session, keep it and diagnose the old helper state; do not remove deletion guards while a writer may remain active. A full data-folder backup may contain private account credentials and must remain private.

## Regression checks

Reopen old meetings and play their audio; inspect transcript and notes version history. Verify read-only Calendar connection still works. Test in-person recording, ordinary file upload, Turbo and native Large V3 separately. Export/restore preserves extension recording metadata and existing audio, while connection credentials stay outside portable exports; re-pair on the restored installation.
