# Web updates and recovery

Echo's web server is updated from source. Backups and restoration are deliberate actions; there is no automatic application updater or pre-update snapshot. These steps apply on macOS and Ubuntu. See the [release checklist](release-checklist.md) for qualification status.

## Before updating

1. Finish active recordings and processing. Synchronize or export pending extension audio; a library backup does not include audio still in the browser.
2. In **Settings → Storage**, confirm your recovery phrase and export the encrypted library backup. Keep it outside the checkout. For a library beyond the export limit, stop the server and copy the entire data folder, including protection/recovery files and any database sidecar files. Do not copy a live database.
3. Record the actual data path from Storage. Preserve the original folder and matching phrase privately.
4. Stop the server normally, then follow [source update commands](development.md#update-a-source-checkout). Retain the same workspace hostname and port if you want to reuse its browser model cache.

## Verify the updated build

Start the new server against the intended library. Check meetings, playback, transcript and notes versions, vocabulary and settings. Confirm pending extension audio transfers to the expected library. Keep the backup until verification succeeds.

The server stores library-schema and minimum-reader versions. It rejects future or damaged schema metadata before database mutation. This protects against incompatible startup; it is not a backup and does not automatically undo a migration. Never remove schema/protection records to force an older build to open a library.

## Restore deliberately

For a portable backup, use a compatible running Echo version with an empty library and vocabulary, then import through **Settings → Storage**. Another library or computer needs the phrase associated with that backup. Reconnect optional accounts and pair the extension after restoration.

For a complete stopped-library copy, keep the failed/current directory intact and configure `dataDir` or `ECHO_DATA_DIR` to a separate copy of the backup. If its OS key is unavailable, follow [locked-library recovery](storage-and-recovery.md#recover-a-locked-library). A developer can run the retained `echo-server --check-library` command against the copy before starting the web server; validation can migrate an older library, so never treat it as a read-only check of your only copy.

Restoration does not merge meetings recorded after the backup. Account for those recordings separately before switching directories. Do not downgrade a migrated library in place or automatically replace it with an older snapshot.

## Extension updates

A same-item update should retain browser storage, but finish active capture before reloading or updating. Test it with the exact release candidate. A different extension ID owns separate storage: synchronize or export pending recordings, install and pair the new identity, verify imported audio, then remove the old installation. Keep every WAV part and timeline file from an export.
