# Independent extension server review

Reviewed `server/src/extensions.rs`, the changed portions of `store.rs`, `main.rs` and `security.rs`, the implementation report, and the binding extension spec/plan. No implementation edits, staging, or commits were performed.

## Blocking finding

**Re-review status: this P1 is resolved.** File and containing-directory synchronization now run unconditionally before indexing a new/reused valid PCM or WAV file; indexed PCM retries resynchronize before acknowledgement as well. Independently reran `orphan_retries_resync_files_and_directories_before_durable_ack`: **1 passed, 0 failed**. It injects file/directory sync failures over valid orphan bytes, checks no index/completion is committed, and checks retry repeats the failed barrier. Physical power-loss qualification remains pending.

A subsequent controller integration review found the modern Zoom/Teams host mismatch; that was fixed and independently validated by `start_accepts_current_and_legacy_meeting_hosts_but_rejects_lookalikes`: **1 passed, 0 failed**. Details and controller re-review are in `controller-task-review.md`.

**[P1] Reused uncommitted PCM/WAV files bypass the durability barrier** — `server/src/extensions.rs:718–724` and `server/src/extensions.rs:866–872`.

Both recovery paths verify an already existing file and skip `write_private` and `synced_directory` when its bytes match. A previous attempt can leave a complete readable file when `file.sync_all()` fails, when the following directory sync fails, or when the process is interrupted before that directory sync. The transaction then rolls back, leaving an unindexed orphan. The retry reads/hashes this orphan, skips both file and destination-directory synchronization, and commits SQLite before acknowledging the chunk or complete recording. A subsequent power failure can therefore lose audio that the extension believes was durably imported; after verified completion it may already have removed local PCM. Synchronizing the directory's parent in the chunk path does not synchronize the file entry inside that directory.

Fix: before indexing either a newly written or reused valid file, synchronize the file and its containing directory successfully. Keep all relevant directory creation/rename barriers before SQLite commit. Add an injected file/directory-sync failure test that leaves matching orphan bytes, then checks the retry performs the barriers and does not acknowledge if either barrier fails. The reviewed tests exercise partial bytes and restart recovery, but do not exercise this valid-orphan sync-failure branch. This finding is from the explicit code ordering; no physical power-loss success/failure is claimed.

## Verification and scope conclusions

Independent command: `TMPDIR="$PWD/tmp/extension-server-review" cargo test -p echo-server extensions::tests -- --test-threads=1`.

Result: **4 passed, 0 failed**, including origin/Host/CORS and pairing replay/revocation isolation, installation ownership, chunk retry conflicts and corruption, SQLite close/reopen, completion validation and tombstones, lease generation/expiry fences, immutable midpoint-owned words with new overlapping words, sequential part boundary playback, and credential-free portable receipt restoration. Those existing tests were inspected as well as rerun.

No additional actionable blocker was found in the reviewed authorization scopes, approval/claim binding, tombstones and resurrection checks, continuous WAV byte-range composition, or temporal draft fencing. Complete and final-processing preemption remove the lease; successful final transcript creation clears the draft in the same transaction. Exported receipts omit credentials, codes and live drafts; receiving recordings explicitly block portable backups.

## Qualification gaps, not test passes

- Physical disk-full, process/power-loss interruption at individual persistence barriers, and storage-device durability remain unqualified. The unit tests and SQLite reopen establish the tested application paths only. The blocker above requires a code fix before this qualification can support a durable-acknowledgement claim.
- Completed status validates files' type/existence/length, but does not rehash a same-size WAV modified after completion. This is explicitly reported by the implementer; initial completion hashes/validates PCM. Treat later same-size corruption detection as a known limit rather than claiming it tested.
- Real Chrome/Brave capture and Google Meet/Zoom Web/Teams Web on macOS/Ubuntu were outside this server review and remain pending as documented.

Review scratch test libraries were removed by the tests; the review-owned empty `tmp/extension-server-review` directory was removed. This requested report is retained for the controller.
