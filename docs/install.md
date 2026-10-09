# Set up and open Echo

**Development preview:** Echo is a locally served web app, with a browser extension for online meetings. Initial server setup currently requires the [source-build steps](development.md#build-and-start). There is no separate Echo desktop application. A Chrome Web Store listing has not been published; check the [readiness record](production-readiness-status.md) for tested builds and remaining work.

## Open the web app

If Echo is already running on your computer, open [http://localhost:3000](http://localhost:3000) in your existing Brave or Chrome browser. Use the same browser profile for the workspace and meeting extension. A different configured port or hostname must also be used when connecting the extension.

If the address cannot be reached, start the local server. The [developer guide](development.md) covers the one-time Rust/Node build setup and the build/start scripts. This preview does not provide installation without developer tools. Once started, the workspace is used through the browser; Echo does not host your library on a cloud service.

Keep the server running for library access, transcription and recording transfers. Keep the workspace tab open during in-person capture and browser transcription. Closing the whole browser interrupts extension recording; closing only the popup does not. An initialized extension can record with the server stopped and transfer when it returns.

## First use

1. Save the library recovery phrase in **Settings → Storage**.
2. Try the [short in-person recording](../README.md#record-your-first-conversation), then play it back.
3. Follow **First transcript** on Overview. It checks the selected model and links to its download or your saved recording. Download the model deliberately, then create the transcript.
4. For online calls, [install and set up the extension](browser-extension.md). It records from the existing meeting tab and needs its own saved recovery phrase.

Google Calendar and notes providers are optional. Turbo runs in the browser; the full Large V3 model requires the separate [native speech setup](native-speech.md).

## Existing library

Keep a backup and stop the old server before copying a library. The default library is `.echo-data` inside the project; **Settings → Storage** shows the actual path. Copy the whole folder to a separate location and point the new server's `dataDir` or `ECHO_DATA_DIR` at that copy. Keep the original until meetings, audio and saved versions work. See [storage and recovery](storage-and-recovery.md) for encrypted backups, locked keys and migration checks. Never use two servers against one library or remove locks to bypass an active process.

## Updates

Follow [web updates and recovery](update-recovery.md): back up, finish recording and processing, stop the server, update/rebuild, then start it with the intended data directory. No automatic application update or pre-update snapshot is provided.

Extension updates are separate. Reloading an unpacked extension can interrupt capture. Moving from the development identity to a store identity creates a different browser installation: finish transfers or exports, install and pair the new extension, and verify the destination before removing the old one.

## Remove Echo

Stop the server and finish or export pending extension recordings first. Back up the library outside the project folder before deleting a checkout: the default `.echo-data` folder is inside it. Removing the source folder can otherwise delete your recordings. Custom data directories remain until separately removed.

Uninstalling the extension or deleting its browser profile can erase pending audio. A recovery phrase can unlock existing data; it cannot recreate deleted files.
