# Browser extension implementation contract

The approved plan in this conversation is binding. This file records the cross-component wire contract so bounded implementers can work independently.

## Product constraints

MV3, TypeScript, Chromium 120+, Brave/Chrome on macOS/Ubuntu. Capture the existing Google Meet, Zoom Web or Teams Web tab after an explicit Start action and consent. No camera, browser account login, Docker, unattended joining or native meeting runner. Preserve native Large V3 speech. Optional live text defaults off. Unknown/stale meeting mute state excludes microphone. Local durable PCM16 mono 16 kHz storage owns recovery; Echo downtime never stops healthy recording. Maximum 8 hours, 2 GiB pending storage, five seconds persistence backlog. Sequential WAV parts at most 30 minutes are one recording timeline. Never purge unsynchronized audio automatically.

## HTTP protocol v1

Every JSON reply includes `protocolVersion: 1`. Exact loopback URL is configured in extension settings; fetch uses `redirect: 'error'`. Trusted extension contexts own credentials; content scripts receive no credential, endpoint, or arbitrary request bridge. Bearer credentials are scoped to installation/library and persisted only hashed on server.

Same-origin Echo routes under `/api/extensions`:

- GET `/connections` → `{libraryId, connections:[{installationId,name,createdAt}], requests:[{requestId,installationId,name,expiresAt}]}`.
- POST `/pairing` → `{code, expiresAt, libraryId}` (five minutes, single use).
- POST `/requests/{requestId}/approve` → approval; DELETE `/connections/{installationId}` revokes.
- GET `/recordings` → extension-owned recording metadata for workspace/live scheduling.
- POST `/recordings/{recordingId}/controls` body `{action:'pause'|'resume'|'stop',commandId}` queues idempotent recording-specific controls.
- POST `/recordings/{recordingId}/lease` body `{ownerId}` → `{generation,expiresAt,totalFrames,draft:null|{throughFrame,committedThroughFrame,words,language,modelRevision}}` atomically on lease grant (60 seconds; `expiresAt` is Unix seconds; renew every 10 seconds). Initialize the processor from this authoritative lease draft.
- POST `/recordings/{recordingId}/draft` body `{ownerId,generation,throughFrame,committedThroughFrame,words,language,modelRevision}` with words `{text,startFrame,endFrame,provisional}`; fence writes by lease generation, reject cursor regression, and preserve the exact prior-owned word sequence (words whose midpoint is at or before the previous committed cursor); newly owned overlapping words may sort before prior-owned words by start time. Provisional ownership is `startFrame+endFrame > 2*committedThroughFrame`.
- GET `/meetings/{meetingId}/audio` → one virtual WAV over sequential saved parts, streamed with byte-range and optional `?download=1` support.
- GET `/recordings/{recordingId}/pcm?startFrame=N&frameCount=N` → bounded PCM16 bytes for at most 20 seconds, authenticated same-origin processing only.

Separate extension router `/extension/v1` preserves normal `/api` origin protection:

- POST `/pairing/request` `{code,installationId,name}` → `{requestId,libraryId,expiresAt}`.
- POST `/pairing/claim` `{requestId,installationId,code}` → pending `{status:'pending'}` or approved `{status:'approved',credential,libraryId}`. Claim atomically consumes approval; duplicate uncertain claim can use same code until its expiry to recover the same credential without approving again. Invalid/expired denied.
- PUT `/recordings/{recordingId}` `{title,provider,meetingUrl,consent:true,liveTranscription,sampleRate:16000,channels:1,createdAt}` → status below. recordingId/installationId are UUIDs.
- GET `/recordings/{recordingId}` → `{recordingId,libraryId,meetingId,status:'receiving'|'complete'|'deleted',nextSequence,totalFrames,liveTranscription,controls:[{commandId,action}],draft?}`.
- PUT `/recordings/{recordingId}/chunks/{sequence}` raw little-endian PCM16, `X-Echo-Frames`, `X-Echo-SHA256`; sequence is contiguous from 0, at most 16000 frames/chunk. Identical retry succeeds, mismatch conflicts. Hash and length validated before durable acknowledgement.
- POST `/recordings/{recordingId}/controls/{commandId}/ack` → acknowledgement.
- POST `/recordings/{recordingId}/complete` `{chunkCount,totalFrames,gaps:[{atFrame,pauseMs}],interrupted:boolean}` → status `complete` only after durable WAV import into mapped Echo meeting. Repeatable and validates whole manifest; preserve tombstone after meeting deletion. Gaps optional empty default. PCM part duration is sequential, not separate speakers.

Extension sends chunks only after IndexedDB commit. It keeps audio after ambiguous completion acknowledgement; verifies complete/libraryId before deletion, retains receipt. Pairing another library with pending recordings requires confirmation.

## Live processing

Echo tab consumes bounded PCM via same-origin API with fenced processing lease. Worker ASR-only operation stays warm, skips speaker recognition, provides word timestamps. Windows 20 s/stride 15 s; midpoint temporal ownership commits through end minus 2.5 s, provisional tail is replaced, not text deduplicated. Persist cursor/draft separately from final transcript versions. Job-scoped cancellation and one prepared window maximum. Final processing preempts live and retains draft until successful final transcript. Missing model never triggers automatic model download/cloud use.

## Ownership and gates

Extension implementer owns `extension/**`, extension build/package scripts and extension test files. Server implementer owns `server/src/extensions.rs`, store schema integration needed for metadata/tombstones, and server module/router integration. Live implementer owns `web/extension-live.js`, inference worker/controller changes and live tests. Controller owns Calendar/settings UI, runner retirement, configuration, broader packaging/CI/docs and integration wiring. Coordinate before touching another owner's files.

All transient output under project `tmp/`. Commits remain local; controller commits integration after review. Only approved live test identity: sublimeinnovationtechnologies@gmail.com. Never commit credentials/session cookies/private meeting URLs. Report unqualified browser/OS/service combinations as pending. Human browser interaction uses Computer Use.
