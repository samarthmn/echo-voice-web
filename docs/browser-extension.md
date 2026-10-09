# Echo browser extension

Use Echo to record a meeting you attend in your existing desktop Brave or Chrome tab. Join normally with your usual account. The extension captures audio; it never requests your camera or joins a meeting for you.

You need the local [Echo app](../README.md#set-up-echo) for transcripts, notes, and the meeting library. You can record while that app is closed and transfer the audio later. Google Calendar is optional.

## Development installation

The extension currently uses a development installation. There is no published store-installation path documented for this build.

1. Get the built extension folder from the person supplying Echo. If they supplied `echo-extension-<version>.zip`, extract it first. Keep the extracted folder somewhere permanent. GitHub's source ZIP is different and needs [building](#for-developers).
2. In Brave, type `brave://extensions` in the address bar. In Chrome, use `chrome://extensions`.
3. Turn on **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`. For a source build, this is `extension/dist`.
4. Use the browser's Extensions menu to pin Echo to the toolbar. Open Echo's popup, then **Setup**.
5. Follow the recovery, connection, service and microphone steps in Setup below.

Use a build from a source you trust; loading an unpacked extension grants its requested browser access. Actual browser, operating-system, and meeting-service results are tracked in the [qualification matrix](extension-qualification.md), which remains incomplete.

## Connect to the Echo app

The development candidate uses **Connect to Echo → approve once → Connected**. It does not require a copied code in the normal flow. Final release qualification is tracked in the [readiness record](production-readiness-status.md).

1. In extension Setup, choose **Create recovery phrase**. Save its 24 words privately and confirm the requested words. This phrase protects the browser's pending recordings and is separate from the Echo library phrase.
2. Start the local Echo app.
3. Choose **Connect to Echo** in extension Setup. Echo opens an approval page in this browser.
4. Check the requesting browser and destination library, then approve. Setup finishes automatically and shows the connection status.
5. Enable your meeting service and choose **Allow microphone** or **Record call audio only**.
6. Return to the meeting tab and open Echo from the toolbar. Setup does not start recording.

You can close Setup while approval is pending and return later. **Open approval page** returns to the request; **Cancel connection** cancels it. Start a new attempt if it expires. An unavailable or incompatible Echo app produces a specific next step. The server address defaults to `http://localhost:3000`; a different loopback address and legacy code pairing are under **Advanced connection settings**.

Changing libraries asks you to confirm the destination. Recordings already assigned to one library retain that assignment; confirmation does not silently move them. Keep the original connection until pending audio is accounted for. **Record without Echo** allows capture after protection setup; transfer and automatic history unlock need the paired app.

## Recording

1. Join the meeting normally, then open Echo from the toolbar while that meeting tab is selected.
2. Set a recording title. Choose **Include my microphone** and its device if you want your voice recorded. Leave it unchecked for call audio only.
3. Choose whether to enable **Live transcript**; it is off by default and needs the setup described below.
4. Confirm that participants have agreed to recording, then choose **Start recording**. If microphone permission is denied, choose **Record call audio only** explicitly.

Call audio keeps playing. Echo never plays your microphone through your speakers. It includes your voice only while it can confirm that the call is active and your meeting microphone is unmuted. If it cannot read that state, or your microphone disconnects, it excludes your voice and shows a warning. Current meeting controls must be in English; an unrecognized interface can prevent microphone recording.

During recording, **Exclude my microphone** can additionally exclude your voice. Turning it off still respects the meeting's mute state. It cannot unmute the meeting or add your microphone to a recording started with call audio only.

**Pause** stops saving both audio sources while call playback continues. **Resume** continues the same recording; its saved duration excludes paused time. Switching tabs or closing the popup keeps the original meeting as the audio source. **Stop**, leaving the call, closing its tab, or navigating to another page ends capture. Closing the entire browser interrupts it. Every new call needs a new Start action and consent.

Limits are one active recording per browser profile, eight hours per recording, and 2 GiB of pending audio. Echo warns before the time limit. If storage runs out or saving fails, capture stops and retains audio already saved. It does not delete older pending recordings to make room.

## Offline recording and recovery

The extension saves audio in your browser while recording, using about 115 MB per recorded hour. Echo can be closed before or during capture. When the paired app returns, transfer continues from where it was last confirmed.

| Status | What to do |
|---|---|
| **Saved in this browser** | Open the paired Echo app to transfer, or export the audio from the extension. |
| **Transferring to Echo** | Keep Echo available until transfer finishes. |
| **Saved in Echo** | Choose **Open in Echo** to review the imported recording. |
| **Interrupted — saved audio available** | Review or export the saved portion. Capture will not restart automatically. |
| **Needs attention** | Read the accompanying error. Keep the local recording until transfer or export succeeds. |

Pending recordings can be exported without Echo after unlocking saved history with the extension recovery phrase. After a browser restart, authorized Echo normally unlocks history automatically when available. New offline recording uses the stored public encryption material and does not require unlocking older history. Longer exports contain numbered WAV files of up to 30 minutes each; play them in order. **Uninstalling the extension or deleting its browser profile can remove pending audio. Export or synchronize it first.** Browser storage still depends on available disk space.

Echo confirms the complete import before the extension removes its duplicate audio. **Remove receipt** only removes the extension's record of that transfer; the meeting remains in Echo. **Delete local audio** permanently removes an untransferred recording after confirmation and is unavailable while recording. Export a backup before deleting audio you still need. A failed or uncertain transfer keeps the local copy.

## Live and final transcription

For live text, download **Turbo** in the Echo app's **Models** page and leave an Echo workspace tab open. The extension does not download a model or choose a cloud provider automatically.

Recording continues if Echo or its model is unavailable. Live text reports whether it is paused, needs a model, is busy, is catching up, or is live. It may lag behind speech on slower computers. Closing the processing tab pauses live text; reopening Echo resumes from saved progress.

The popup shows a short preview. **Open Echo** opens the paired workspace. Live text is provisional: after import, final transcription takes priority and uses the selected speech model and speaker grouping. Generate notes from the final transcript. The draft remains until final processing succeeds. Review words and speaker labels for mistakes, especially where people speak over one another.

## Permissions and privacy

- Meeting-service access lets Echo read call and mute controls. It does not read chat, participant profiles, account credentials, or page transcripts.
- Tab and microphone permission enable the audio sources you choose. The camera is never requested or captured.
- Authenticated encryption protects pending audio and sensitive recording details. Saved history unlocks through authorized Echo or the extension recovery phrase. Non-identifying counters and status remain visible while locked.
- Connection secrets use a browser device key. This does not protect a runnable stolen browser profile or an already-unlocked browser. WAV and timeline exports are unencrypted.
- Local-app access transfers recordings into the library you approve. The extension cannot browse existing meetings, delete them, change app settings, or retrieve Calendar credentials.

Audio stays local. If you explicitly confirm a ChatGPT notes request in Echo, the selected final transcript version, including speaker labels, is sent to OpenAI; audio is not sent. Selecting passages does not narrow that transcript. See [ChatGPT data handling](chatgpt.md).

To end the connection, use **Disconnect from Echo** in extension Setup or revoke the installation in Echo. If Echo is unavailable, Setup retains the connection and asks you to retry so it can confirm revocation. Pending audio remains available locally.

## For developers

Build the app and extension with `bash scripts/build.sh`. For the extension alone, run `npm ci --ignore-scripts` followed by `npm run build:extension`. The output is `extension/dist`. See the [developer guide](development.md#develop-the-extension) for rebuilds and isolated testing.

The extension uses Manifest V3 with a Chromium 120 API floor. Audio is journaled as encrypted mono 16 kHz PCM16 in IndexedDB, with roughly one-second durable chunks and a bounded saving backlog. Transfer deletes local PCM only after a separate complete-import acknowledgement check. Export/processing parts represent one sequential timeline. Browser restart recovers committed audio without resuming capture.

Microphone inclusion needs a fresh positive observation of an active, unmuted meeting. Missing, conflicting, disconnected, or stale observations close the microphone gate. Live inference uses a fenced server lease to prevent two Echo tabs from overwriting the same draft. Calendar association requires one unambiguous, recently loaded matching event; otherwise the recording remains an ordinary online meeting.

All executable code is bundled. The manifest requests no cookies, history, debugger, native messaging, desktop capture, camera, or all-site access. The [permission table](extension-publishing.md#permission-explanations) explains each API and host permission. See [architecture](architecture.md) and [qualification](extension-qualification.md) for technical boundaries and tests.

## Preparing a store package

Run `npm run package:extension` after verification. The archive contains only allowlisted extension assets, with no test fixtures, recordings, credentials, local libraries, or logs. Follow the [publishing guide](extension-publishing.md) and [store materials](extension-store.md). Packaging does not submit or publish the extension; those actions and developer agreements need the owner's approval.
