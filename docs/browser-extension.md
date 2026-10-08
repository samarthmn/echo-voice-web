# Echo browser extension

The extension records a meeting you attend in an existing Brave or Chrome tab. Join the meeting normally with your usual browser account. It does not join unattended meetings or bypass admission. Google Calendar is optional and only opens meeting links. Echo associates a recording with an event only when a freshly loaded Calendar view contains one matching meeting near the recording time; stale, ambiguous, disconnected or different-account views leave it as a normal online recording.

## Development installation

1. Build the app and extension with `bash scripts/build.sh`, or run `npm ci --ignore-scripts` followed by `npm run build:extension` for the extension alone.
2. Open `brave://extensions` in Brave or `chrome://extensions` in Chrome. Enable Developer mode, choose **Load unpacked**, and select this repository's `extension/dist` directory.
3. Pin Echo to the toolbar. Open its setup page, enable the meeting service you will use, and grant microphone permission if you want your own voice included. No camera permission is requested.
4. To transfer recordings, start Echo and open Calendar or Settings → General. Choose **Connect an extension**. Enter the five-minute code in the extension setup page with Echo's exact loopback address (usually `http://localhost:3000`). Return to Echo and approve the named installation. Finish connecting in the extension.
5. Return to the meeting tab before starting. Permission setup or switching to another tab requires a fresh **Start recording** action in the meeting tab.

The Manifest V3 API floor is Chromium 120. Current Brave/Chrome must still be qualified with your meeting service and operating system. Loading an unpacked package trusts code from this checkout; inspect/review it before installing. Do not load random copies or share a package containing browser-profile files.

## Recording

Open the Echo toolbar popup while the meeting is active. Set a title, microphone choice and device, and optional **Live transcript**. Confirm participant permission and choose **Start recording**. Live text is off by default. If microphone permission is denied, explicitly choose call-audio-only recording.

Call audio keeps playing normally. The extension never plays your microphone through your speakers. Your microphone is recorded only when the provider adapter sees an active call and a fresh, positively unmuted state. Meeting mute, an unknown interface, a missing control, a disconnected device, or a stale observation excludes your microphone. A warning means call audio can continue but your voice may be missing. Clear **Include my microphone** before starting for call audio only. Changing that choice during recording is not available yet; Echo never unmutes the meeting.

**Pause** stops adding both audio sources; call playback continues. **Resume** continues the same recording. Saved duration excludes paused time and the recording records timeline gaps. Switching tabs or closing the popup does not switch the audio source. Closing the captured tab, leaving the call, cross-document navigation, or choosing **Stop** finalizes recording. Closing the entire browser interrupts capture. A new call requires a new Start action and consent.

One recording may be active per browser profile. The maximum is eight hours; the extension warns before finalization. Pending audio is limited to two GiB. Storage failure stops capture safely and keeps the last committed audio. It never deletes older unsynchronized recordings to make space.

## Offline recording and recovery

Echo may be closed before or during recording. Audio is journaled locally in the extension's IndexedDB database as mono 16 kHz PCM16, about 115 MB per recorded hour. Transfer resumes from Echo's acknowledged progress when it returns. Closing Echo or its processing tab does not stop the extension recording.

The extension library distinguishes **Saved in this browser**, **Transferring to Echo**, **Saved in Echo**, **Interrupted — saved audio available**, and **Needs attention**. Only full durable import acknowledgement means saved in Echo. Interrupted capture recovers the committed prefix after browser restart; it never resumes microphone or tab capture automatically.

Pending recordings can be exported without Echo. Exports are sequential WAV parts of at most 30 minutes, representing one continuous timeline. Delete unsynchronized audio only after checking the warning and making your own backup. **Uninstalling the extension or deleting its browser profile can remove pending audio. Export or synchronize it first.** Browser disk space is finite despite the unlimitedStorage permission.

After complete import, redundant local PCM is removed and a receipt links to Echo. Ambiguous or missing acknowledgements retain local audio. Pairing to another library requires explicit confirmation before transferring pending recordings there; verify the destination carefully.

## Live and final transcription

Live processing runs in an open Echo workspace using its existing local Turbo model. Download Turbo deliberately in Models before using live text. The extension never installs models, runs inference, or selects a cloud provider automatically.

If Echo or the model is unavailable, recording continues. Live text reports paused, model needed, processing busy, catching up, or live. Processing lag depends on the computer. Closing the processing tab pauses live text; reopening Echo resumes from saved progress. Two Echo tabs use a fenced processing lease so only one writes the draft.

Live text is provisional. Final transcription takes priority after import and uses the recording's selected speech model and normal speaker-recognition workflow. Generate notes from the final transcript. The draft is retained until final processing succeeds. Speaker grouping does not guarantee verified identities or accurate overlap separation.

## Permissions and privacy

- **activeTab/tabCapture/scripting:** capture the chosen meeting's audio after an explicit user action and read only meeting call/mute controls.
- **offscreen:** keep audio resources running when the popup closes.
- **storage/unlimitedStorage:** store settings, trusted connection credentials and durable local audio. This does not guarantee unlimited free disk space.
- **alarms:** coordinate transfer/recovery while the service worker can suspend.
- **Optional provider host access:** enable supported meeting state observations for the selected service. No chat, attendee profiles, credentials or meeting transcripts are scraped.
- **Loopback host access:** transfer to the configured Echo installation on this computer. A revocable scoped credential authorizes only this extension's recording ingest, status, controls and live drafts.
- **Microphone:** runtime permission only when you enable your voice; video is always disabled.

No cookies, browsing history, debugger, native messaging, desktop capture, camera, or all-site access is requested. Code is bundled locally. The extension cannot list existing Echo meetings, delete them, change settings, or retrieve Calendar credentials. Disconnect it in Echo to revoke future access. Audio remains local unless you explicitly choose an existing cloud notes workflow in Echo after final transcription.

## Preparing a store package

Run `npm run package:extension` after the build and tests. The archive contains only the production manifest, bundled extension code, styles, pages and icons. It must exclude test fixtures, recordings, credentials, local libraries and logs. See [store preparation](extension-store.md). Store submission, developer agreements and publishing require separate user approval.
