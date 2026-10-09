# Chrome Web Store release materials

**Local preparation only.** No draft has been submitted or published by this document. The candidate still needs the [qualification matrix](extension-qualification.md), independent security review, verified local web-server setup, real store-install testing and release approval. The [publishing guide](extension-publishing.md) owns the operator procedure.

## Publisher and destinations

| Field | Confirmed value / status |
|---|---|
| Publisher | Samarth |
| Monitored contact | samarth.m.n@gmail.com |
| Website | `https://echovoice.samarthmn.com` — hosting not yet configured/verified |
| Privacy | `https://echovoice.samarthmn.com/privacy` — local draft, not a published policy |
| Support | `https://echovoice.samarthmn.com/support` — local draft |
| Companion-app downloads | `https://echovoice.samarthmn.com/downloads` — no qualified downloads published |
| Store item ID and URL | Pending actual draft creation |

Facts are shared with [release/publisher.json](../release/publisher.json). [Site sources](../site/README.md) prepare these pages with the product's shared tokens, fonts and icon. Do not enter an unhosted policy or unavailable app download as if a reviewer can access it. Publisher registration, identity verification, financial/legal commitments and final release approval remain specific human checkpoints; Codex prepares and performs the accessible surrounding operations.

## Listing draft

**Name:** Echo Meeting Recorder — matches the current manifest.

**Short description:** Record meeting audio in your browser, then send it to your local Echo app for transcripts and notes.

**Single purpose:** Record audio from a browser meeting the user attends, save it locally and transfer it to the paired Echo app for transcripts and notes.

**Description:**

> Record the meeting you attend in your existing browser tab. Choose whether to include your microphone. Echo excludes your voice while the meeting reports it muted, and when it cannot confirm the mute state. It never requests camera access.
>
> Start and stop recording yourself, with participant consent. Pause when needed. Closing the popup does not stop the recording. If the local Echo app is closed, the extension keeps committed audio in the browser for later transfer or WAV export.
>
> The local Echo web server is required for your meeting library, final transcripts and notes. A speech model download is required for local transcription. Optional live text uses the local Turbo model in an open Echo workspace; recording continues when live processing is unavailable.
>
> Setup protects pending recordings with a recovery phrase and connects to Echo with one approval. Keep the phrase privately. After a browser restart without Echo, use it to unlock older recordings. Uninstalling the extension or deleting its browser data can erase pending audio; synchronize or export first.
>
> Echo records calls you attend. It does not join meetings, bypass admission or start scheduled recordings automatically. English meeting controls are required for microphone-state detection.

Before submission, append the **actual qualified browser/OS/service list and tested limitations**. Do not publish the entire intended matrix as supported. Put the real companion-app download link prominently beside the prerequisite. This draft deliberately has no invented store ID, pricing, certification or qualification claim.

## Reviewer instructions to complete for the candidate

Replace the artifact fields with immutable, verified links after qualification. Supply synthetic content; never share a personal account, token, recovery phrase or private meeting URL. A reviewer uses their own permitted test meeting and login.

| Candidate field | Required value |
|---|---|
| Source commit / app version / extension version | Pending release commit |
| Local web-server commit, build prerequisites and asset hashes | Pending qualified candidate |
| Minimum OS and qualified browsers/services | Pending per-cell evidence |
| Store extension ID | Pending assigned ID |
| Model choice and displayed download size | Verify in the candidate Models screen |
| Known limitations / reproduction notes | Link immutable release notes |

Reviewer journey:

1. Build and start the matching local Echo web server using the supplied source instructions, then open its URL in an existing qualified Brave or Chrome browser. The extension does not install or start the server. This setup currently needs developer tools; disclose those prerequisites to reviewers.
2. In Echo Settings → Storage, save and confirm the library recovery phrase privately. Open extension Setup and complete its **separate** recovery-phrase confirmation.
3. Select **Connect to Echo**, approve the installation in Echo and return to Setup. It should show Connected automatically. Codes and custom addresses are under Advanced; they are not needed on the default local address.
4. Enable the qualified meeting service and optionally permit the microphone. Open a test meeting normally with camera permission denied. The extension neither signs into nor joins it for you.
5. If the extension says **Update Echo**, update the companion app before transfer. The extension keeps audio local until Echo declares compatible protected storage and durable-receipt support. Advanced pairing does not bypass this safety check.
6. Open the popup on that meeting tab, enter a synthetic title, select microphone inclusion or explicit call-audio-only recording, leave live text off for this first trial and confirm participant consent. Start recording.
7. Speak a short test phrase, mute using the meeting UI, speak a different phrase, then unmute. Close/reopen the popup, pause/resume and stop. Verify audio against these states; a transcript alone cannot establish exclusion.
8. Open Echo and verify one imported recording, the correct duration/timeline and playback. Choose/download the candidate's local speech model explicitly, create a final transcript and verify it persists after restart. Notes and Calendar are optional.
9. For offline recovery, close Echo before another short recording. Stop and verify Saved in this browser. Restart the browser; unlock history using the extension phrase, export WAV, then reopen Echo and verify transfer. Confirm the destination before sending pending audio to a different library.
10. Confirm extension disconnect/revocation and the permission-denied paths. Do not clear data or uninstall until the synthetic recordings are synchronized/exported. Delete only that test's fixtures.

Optional live-text, quota/crash, tampering and upgrade evidence should accompany the review notes, with reproducible test instructions where practical. These must come from the qualification record; this walkthrough does not certify them.

## Permissions and data declarations

Verify the exact candidate manifest before copying these justifications into the dashboard.

| Capability | Implemented purpose |
|---|---|
| `activeTab`, `tabCapture` | Capture audio from the meeting tab selected through the user's Start action; video is disabled. |
| `scripting` and optional provider hosts | Observe the enabled service's call/microphone controls to gate the user's voice safely. |
| `offscreen` | Keep the audio graph and committed storage running when the popup closes. |
| `storage`, `unlimitedStorage` | Save preferences, scoped connection state, protected pending recordings and recovery metadata. Disk failures still require safe handling. |
| `alarms` | Resume connection/transfer work as the service worker wakes. |
| Loopback hosts | Authenticated requests to the exact configured Echo destination on this computer. |
| Runtime microphone permission | Include the user's voice only after permission and positive unmuted call observations. |

No camera, cookies, browsing history, debugger, native messaging, desktop capture or all-site access is requested. Provider observers do not read chat, participant profiles or page transcripts. Executable extension code is bundled locally; speech-model downloads belong to the companion app.

Dashboard disclosure must include handled audio/personal communications, user-entered titles, meeting addresses/identifiers, call/mute observations, scoped credentials, installation identity and optional live text. Local storage still counts as data handling. The privacy draft describes encrypted browser PCM/sensitive metadata, readable operational state, SQLCipher library metadata, authenticated audio, OS-held library keys, separate recovery phrases and readable exports. It also describes optional Calendar and cloud notes in the companion app. Storage protection is under qualification; do not describe it as independently certified.

The exact checkbox mapping depends on the current dashboard wording. Codex must inspect it and reconcile each answer against the manifest, implementation and hosted privacy policy; do not blindly check “no user data.” Google requires local-only processing to be disclosed. Its FAQ exempts extension-to-native-program traffic on the same computer from the transmission-encryption requirement, not stored data or remote transfers. [Official User Data FAQ, checked October 9, 2026](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

Publish an accurate privacy policy and a Limited Use statement accessible from the product site, then use the same facts in the listing and dashboard. The policy must explain purpose, recipients, retention, deletion, access and optional services. Hosting request logs and support-message retention still need concrete operational values before the draft becomes public. [Privacy policy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy), [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)

## Image and package inventory

Google currently requires a 128×128 PNG icon, a 440×280 promotional image and at least one screenshot; up to five screenshots are accepted at 1280×800 or 640×400. Screenshots show the real experience without added padding. Its square-icon guidance uses 96×96 artwork inside the 128×128 image. Verify final pixels and current requirements when submitting. [Official image specifications, checked October 9, 2026](https://developer.chrome.com/docs/webstore/images)

| Material | Current state / next action |
|---|---|
| Extension ZIP | Generate with `npm run package:extension` from the qualified commit; inspect allowlist, CSP and root manifest. Never upload tests, libraries, recordings or credentials. |
| Manifest icons 16/32/48/128 | Present under `extension/icons/`; inspect padding/contrast in the actual store draft. |
| 440×280 promotional image | [Draft branded tile](extension-assets/promo-440x280.png); exact RGB dimensions verified. |
| Setup screenshots | [Protection and connection choices](extension-assets/setup-protection-1280x800.png) and [service/microphone choices](extension-assets/setup-choices-1280x800.png) captured from the real isolated extension. [Provenance](extension-assets/README.md). Connected state remains pending. |
| Recording/source indicators | Pending actual qualified call with private links/account details excluded. |
| Pause and saved-state screenshot | Pending actual candidate capture. |
| Pending history/recovery screenshot | Pending synthetic candidate capture; never show recovery words. |
| Workspace overview | [Current workspace guide](extension-assets/echo-overview.png), 1440×1050; a documentation preview, requiring a store-sized capture before submission. [Provenance](extension-assets/workspace-capture-provenance.json). |
| Mobile overview | [Current 390px guide](extension-assets/echo-overview-mobile.png), a documentation preview, not a valid store screenshot size. |
| Final transcript/notes review screenshot | Pending actual qualified candidate capture with private content excluded. |
| Earlier mute transcript | [Bounded test evidence](extension-assets/clean-mute-transcript.jpg), not proof of fresh full qualification. |

The extension's independent capture, durable offline storage and export give it functionality beyond opening Echo. Demonstrate those working features in review; a launcher-only extension or broken functionality does not meet the store's minimum-functionality policy. [Official minimum functionality policy](https://developer.chrome.com/docs/webstore/program-policies/minimum-functionality)

## Final preparation gate

Codex verifies artifact provenance and hashes, hosting URLs, install/update paths, single-purpose scope, minimum permissions, remote-code restrictions, dashboard/policy agreement, real screenshots and reviewer access. Use a private initial audience, then test the actual store-installed build in both claimed browsers before public rollout. Store review is an external dependency; approval is not a recording-accuracy or compatibility certification. See the [official publication workflow](https://developer.chrome.com/docs/webstore/publish) and keep its outcome in the [readiness record](production-readiness-status.md).
