# Updates and recovery

This describes the development candidate's update safeguards. Public signed updates and clean-machine qualification remain pending in the [release checklist](release-checklist.md).

## Before updating

Finish active recordings and processing. Synchronize or export pending browser recordings, and keep the appropriate [recovery phrases and backup](storage-and-recovery.md). An application backup does not contain audio that is still pending inside the extension.

The macOS launcher's **Install update** verifies the download before stopping Echo. It then makes and checks an encrypted library snapshot before replacing the app. If active work is still running, installation waits for you to finish it. If the snapshot cannot be verified—for example, disk space is unavailable, the key is locked or saved audio is damaged—the app is not replaced and Echo attempts to resume its existing server. No plaintext snapshot is created to work around an encryption failure.

The snapshot includes the database, audio, transcript and note versions, vocabulary, saved preferences, protection/recovery records and supported saved credentials. It excludes model downloads, old browser profiles, executable configuration, helper caches and pending extension audio. Because it can contain account state, keep its folder private.

Ubuntu `.deb` updates are installed by the system package installer; this automatic macOS snapshot step does not run during a manual package installation. Make a portable backup in **Settings → Storage** before installing a verified `.deb`. Larger libraries require a stopped-library copy as described in the storage guide. Ubuntu update qualification is still pending.

## Find a pre-update snapshot

On macOS, use Finder's **Go → Go to Folder** and enter:

```text
~/Library/Application Support/Echo Voice-update-snapshots
```

Each completed snapshot is a dated folder containing `snapshot.json` and a `library` folder. The descriptor records the source and target app versions and creation time. A `.pending-…` directory is an interrupted attempt, not a verified snapshot. Completed snapshots remain until you deliberately remove them; Echo does not automatically delete or restore one.

These snapshots are on the same computer. Keep a separate backup for disk loss or device loss.

## Restore deliberately

1. Close other Echo instances and keep the current library intact.
2. Open a compatible Echo launcher, expand **Library and recovery**, and choose **Copy existing library…**.
3. Select the completed snapshot's **library** folder, rather than its parent folder.
4. Echo verifies another copy before selecting it. Confirm that expected meetings, audio, transcripts and notes open correctly.
5. If the operating system key is unavailable, use **Recover a locked library**, select that snapshot's `library` folder and enter its matching library recovery phrase privately. Then repeat the copy step.

Restoring does not merge meetings saved after the snapshot was made. Export or preserve the current library before switching. Optional accounts may require reconnection if their credentials have expired or been revoked.

## If an older app refuses a library

Echo records a library format version and the minimum reader version inside the protected database. A newer or damaged format is rejected before migration, checkpointing or schema changes. Reopen it with the matching newer release, or explicitly restore a verified compatible snapshot. Do not delete version records, protection files or database journal files to force it open.

This protection begins with releases that contain the format check; it cannot make previously distributed, older binaries enforce a check they did not contain. Application replacement never automatically rolls the library back.

For developers: the schema fence is `library_schema` plus SQLite's `user_version`; storage protection has its own version. Future migrations must validate before writes and update the schema/minimum reader metadata transactionally. Tests retain byte-identical database and WAL files on rejected versions; SQLite's transient shared-memory read marks are not durable library data. Snapshot validation authenticates every copied protected file in bounded reads and checks the database and indexed audio digests before publishing the snapshot directory.
