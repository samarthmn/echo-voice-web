# Storage, backup and recovery

This guide describes the protected-storage development candidate. Independent security review and full release qualification are tracked in the [readiness record](production-readiness-status.md). Keep a backup of an older installation before opening it in this build.

## Two places to protect

| Place | What it holds | How it unlocks |
|---|---|---|
| Echo library | Imported audio, transcripts, notes, versions, settings and account state | The local app uses a key held by your operating system. The library recovery phrase can restore that key. |
| Browser extension | Pending recordings, recording details and local transfer state | Authorized Echo unlocks it automatically. After a browser restart without Echo, use the separate extension recovery phrase for saved history and exports. |

The library phrase and extension phrase are different. Label them when saving them. Keep them outside the browser/application data they protect. Anyone with the relevant phrase and encrypted data can open that data. Echo cannot replace a lost phrase.

Protection covers saved data. It cannot protect content from someone using an already-unlocked application or a compromised user account. Connection credentials use a browser device key; a stolen runnable browser profile is not an isolated hardware security boundary. Exported WAV, transcript, notes and timeline files are readable files.

## Save the library recovery phrase

1. Open **Settings → Storage → Protect your library**.
2. Choose **Save recovery phrase**.
3. Save all 24 words in order, privately.
4. Choose **I saved the phrase**, then enter the requested three words.
5. Confirm that Echo shows **Recovery phrase saved**.

A new phrase does not change old backups. Keep the phrase associated with each retained backup. Never send a phrase in a support request, screenshot or chat.

## Make and restore a backup

Finish saving and processing first. Choose **Settings → Storage → Export library** and save the file somewhere separate from the library. A successful export contains an encrypted archive of supported meeting data, audio, versions, settings and vocabulary. It excludes credentials, model downloads, executables and pending extension recordings.

Restore into an empty meeting library and vocabulary. Select the archive in Storage. Echo can unlock an archive from the same library automatically; another library/computer asks for the archive's recovery phrase. Wrong phrases or damaged encrypted archives are rejected before import. Reconnect optional accounts and the extension afterward.

Legacy plaintext web-library backups can still be imported. They remain readable files; importing one does not encrypt or delete the original backup. The unrelated older desktop Echo backup format is not supported.

The portable backup is size-bounded. For a larger library, stop Echo and copy the entire library directory, including its protection and recovery files. Keep the library phrase with your private recovery records, separately from the copy. Do not copy a live database or delete a lock file to bypass an active process. [Developer storage details](development.md#storage-and-large-library-backups) explain the limits.

## Recover a locked library

An unavailable credential store is different from a lost key. First unlock your macOS login keychain or Ubuntu desktop keyring, then retry Echo. The app must not replace missing keys or fall back to saving plaintext.

If the saved key was lost, open the launcher, expand **Library and recovery**, choose **Recover a locked library**, and enter the library's 24-word phrase. The app verifies the database before restoring its key to the OS credential store. To recover another library folder, select **Choose another library folder**. Keep the original folder intact until it opens and its audio plays correctly.

If you have neither a usable OS key nor the matching recovery phrase, the protected data cannot be recovered by support. An earlier backup and its phrase may still be usable. Do not repeatedly create replacement libraries over the existing directory.

## Recover extension recordings

Extension Setup creates and confirms its own phrase before protected recording starts. After a browser restart, open the paired Echo app to unlock authorized history automatically. If Echo is unavailable, use **Unlock saved history** in Setup and enter the extension phrase. Initial setup must have completed, but new recording can then work offline without unlocking older recordings.

An interrupted recording retains its committed audio; capture never restarts silently. Open **Local recordings & recovery** to retry transfer or export. Exports use ordered WAV parts of at most 30 minutes and a timeline file. Keep every part. WAV exports are unencrypted.

**Saved in Echo** means the server has confirmed a complete durable import. Only then can the extension discard its redundant audio. If transfer fails or its final response is uncertain, the browser retains the local recording. Do not uninstall the extension, clear its data, delete its profile or switch extension IDs while unsynchronized audio remains.

Deleting unsynchronized audio requires confirmation and cannot be undone. A recovery phrase unlocks data that still exists; it cannot recreate deleted files.

## Moving from an older installation

Back up the old library and stop its server and any retired recording helper. In the launcher choose **Copy existing library…**. Echo copies a supported library into a new location, verifies it and then selects the copy. The original remains unchanged. Browser profiles, caches and old application configuration are not copied. Legacy runner files require the [runner recovery checks](extension-migration.md).

The server migrates older plaintext library data to protected storage. Migration can require additional free disk space. If it fails, preserve the source and error details; never force startup by deleting protection files. Qualification must include interrupted migration, damaged audio and wrong keys before this workflow is advertised as a released capability.
