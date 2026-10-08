# Independent controller integration review

Reviewed controller handoff, binding spec/plan, app extension/calendar/main/review/settings integration, workspace import monitor and bridge final workflow, retired runner config/routes and legacy recovery, build/package/CI changes, design-token integration and current extension/install/migration/qualification/store docs. No implementation changes or commits.

## Actionable findings

**Re-review outcome: all three actionable findings below were fixed during review. No outstanding actionable blocker remains in this reviewed scope.** Their original evidence is retained below; current validation is recorded after the findings.

### [P1] Supported modern provider hosts cannot transfer to Echo

Location: `server/src/extensions.rs:508–515`, cross-component with `extension/src/core.ts:34–35`, extension manifest optional hosts, and `server/src/integrations.rs:423–424`.

The extension explicitly recognizes `https://app.zoom.com/wc/123456789/join` and `https://teams.cloud.microsoft/meet/123`; runtime tests assert these return supported Zoom/Teams providers. Calendar classification and granted permissions agree. The ingest start allowlist accepts only zoom.us/subdomains and teams.microsoft.com/teams.live.com, so both valid supported addresses fail `PUT /extension/v1/recordings/{id}` with 400 before any meeting/chunk mapping is created. Capture remains locally retained, but final processing/transfer never succeeds for these new hosts.

Fix the exact server host allowlist to match the extension and Calendar. Add authenticated start request positive tests for both modern hosts and hostile lookalike-host negatives. This is an integration blocker independent of real provider/browser qualification. Server owner and root were notified.

### [P2] Reloading Echo replays historical recordings as newly saved

Location: `web/extension-workspace.js:4–16`, consequence at `app/src/main.rs:268–271`.

`announced` starts empty on every page load. The initial poll emits `echo-recording-saved` for every historical complete recording, including ready recordings with existing transcripts. App's event listener unconditionally selects that meeting, navigates to Review, and says "Recording saved." A new/reopened Echo tab therefore replays all historical saves, can replace the user's current selection, and performs one meeting request plus library/settings refresh per old recording. The bridge skips existing transcripts, so this specific reproduced case does not duplicate transcript versions; unprocessed historical recordings may legitimately need final processing, but that should be reconciled separately from new-save navigation.

Independent reproduction instantiated two fresh monitors over one historical `ready` meeting with an existing transcript. Observed output: `{"savedEventsOnTwoWorkspaceLoads":["old","old"]}`. Existing workspace tests only check repeated polls within one monitor instance.

Separate initial historical reconciliation from newly completed recording announcements. Test startup with historical complete/transcribed recordings, restart/reopen, and a receiving-to-complete transition. Keep legitimate interrupted/offline final-processing recovery without replaying navigation/toasts for the whole library.

### [P2] Reopening a partial legacy import hides its recovery action

Locations: `server/src/legacy.rs:177–197` and `app/src/main.rs:449`.

Legacy recovery commits its 64 MiB chunks individually. If a later chunk fails, the existing meeting retains an incomplete `meeting-bot` track. After navigating away and reopening that ordinary legacy online meeting, `ExtensionRecordingStatus` is omitted because tracks are no longer empty and there is no `extensionRecording` metadata. This removes the recovery button needed to retry the remaining import through the UI. The original WAV remains preserved and a manual HTTP call can resume, but the normal migration recovery action is hidden precisely after an interrupted import. The same applies to a partial import left by the retired importer, whose chunk boundaries were also 64 MiB and are compatible.

Mount/discover legacy recovery for incomplete old audio even when a track already exists. Add a regression seeded with an original partial import, then verify full recovery/no duplicate tracks and a still-available recovery action after failure/reopening. A previous informal message incorrectly stated that the old importer used 8 MiB chunks; checking `git show HEAD:server/src/integrations.rs` established 64 MiB, and that unsupported boundary-mismatch allegation was retracted.

## Verification and qualifications

- Modern provider-host fix independently reviewed: ingest now permits only exact `app.zoom.com` and `teams.cloud.microsoft` in addition to previous scopes. Independently reran `start_accepts_current_and_legacy_meeting_hosts_but_rejects_lookalikes`: **1 passed, 0 failed**. Positive coverage includes seven host/provider variants; negative coverage includes eleven lookalikes/mismatches. Finding resolved.
- Historical save replay fix independently reviewed: initial reconciliation dispatches `echo-extension-import-ready` for processing only, while subsequent completion still sends the normal save/change UI events. The bridge consumes the silent event and preserves its existing auto-transcription guards. Independently reran updated workspace monitor tests: **3 passed, 0 failed**, including two fresh monitor instances over a historical complete recording. Finding resolved.
- Legacy recovery action fix independently reviewed: all online review pages mount the hook component; after discovery it renders nothing only when there is neither extension state nor a ready legacy source with existing tracks. A terminal finalized legacy source therefore keeps its recovery button after a partial track is persisted/reopening. Finding resolved by source review; physical disk-full and the exact failed-import UI journey were not exercised in this review.

- Independently ran `node --test tests/extension-workspace.test.mjs`: 2 passed, 0 failed. The separate restart probe above demonstrates a missing case despite those passes.
- Continuous playback/download and speaker-sample URLs use the unified extension WAV route; final inference retains ordered sequential tracks and accumulates decoded durations. No additional timeline blocker found in those reviewed paths.
- Config accepts/ignores deprecated runner fields, public runner routes/startup were removed, and legacy recovery refuses nonterminal/unfinalized WAVs. Existing active/uncertain deletion guards and original private profiles are retained.
- Build includes the extension; production ZIP uses an explicit asset list and rejects symlinks/unexpected executables; Linux app package includes extension/dist while source packaging remains tracked-file based. Packaging at this uncommitted stage intentionally requires new runtime files to become tracked before release.
- Shared design tokens are loaded by Echo and copied into the extension bundle. Current qualification docs label the live browser/OS/service matrix pending and do not invent physical fault/browser passes. The historical coverage document explicitly redirects current extension behavior to the new guides.
- Root's reported 144-test run, WASM build/clippy and ongoing browser launch investigation were context only; they were not independently rerun or treated as proof of the cases above.

## Server durability re-review

Original P1 in `server-task-review.md` is resolved by unconditional `sync_audio(file, containing_directory)` before indexing newly written/reused PCM or WAV files; indexed PCM retries also synchronize before acknowledgement. Independently reran `extensions::tests::orphan_retries_resync_files_and_directories_before_durable_ack`: 1 passed, 0 failed. The regression injects separate file/directory-sync failures over valid orphan bytes, checks no index/complete state is committed on failure, and checks retry repeats the failed barrier before acknowledgement. This qualifies the injected application path only; physical power loss and disk-full qualification remain pending. The separate modern-provider-host integration finding was also resolved and independently tested above.

Review-owned test scratch was removed. This requested review report is retained for controller use.

## Final Calendar-association addition review

Reviewed the in-memory Calendar association cache in `server/src/integrations.rs` and extension-start assignment in `server/src/extensions.rs`. The cache is populated only by the same-origin Calendar GET and retains event ID, URL and start/end plus its account/library/fetch scope. Ingest performs no Google request, requires current stored credentials with the same account, accepts a cache age from zero through five minutes, and declines missing/ambiguous/mismatched event candidates. Disconnect clears the cache; current-credential checking also defeats a stale in-flight cache response after credentials are removed or a different account connects. Only `calendarEventId` is copied into the normal meeting document; extension status does not expose Calendar events or credentials. No scope/security blocker found.

Independently reran `integrations::tests::calendar_association_requires_one_matching_current_event`: **1 passed, 0 failed**. Inspected positive matching and negative ambiguous event, different URL/time, hostile host, different account/library, stale cache and future fetch-time cases. This is application-path validation, not production OAuth qualification.

**[P2] Zoom invite and captured web-client paths do not share the association identity** — `server/src/integrations.rs:44–60`. The Calendar parser classifies `https://zoom.us/j/123456789` as Zoom, while extension capture accepts `https://zoom.us/wc/123456789/join`. Current canonicalization removes `/join` but keeps `/j/123456789` versus `/wc/123456789`, so even one same-host/time candidate cannot attach. Known Zoom invite/web paths should use a provider-validated numeric meeting identity with tests for path transition, wrong numeric ID, lookalikes, and ambiguity. Root was notified; re-review of its fix is pending.

**Resolved on final re-review:** Zoom URLs on allowed provider hosts now use `zoom:<numeric meeting ID>` for `/j/<ID>` and `/wc/<ID>` paths, so tenant invite hosts and the captured app.zoom.com web client match while a different numeric ID does not. Unknown unrelated paths return no association. Independently reran the updated `calendar_association_requires_one_matching_current_event`: **1 passed, 0 failed**, including company.zoom.us invite to app.zoom.com web-client transition, different ID and unrelated-profile-path cases. Existing ambiguity/account/library/expiry fences remain in place. Calendar association is approved within the reviewed scope; no actionable finding remains outstanding.

Root also reports the new REST fixture covers finalized legacy recovery with an existing `meeting-bot` track, terminal guards, idempotent retry and original-source preservation; eight full browser workflow scripts and 52 WCAG states passed after label updates. These are root-provided results, not tests independently rerun by this reviewer.
