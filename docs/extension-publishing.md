# Publish Echo for Chrome and Brave

This is the operator's release guide. The extension is currently a development package; this document does not establish that it is ready for public release. Follow the [qualification matrix](extension-qualification.md) and [release blockers](#release-blockers) before making support claims. Store requirements below were checked against official documentation on October 9, 2026; check them again when submitting.

One Chrome Web Store listing can serve desktop Chrome and Brave. Brave users open that same listing and choose **Add to Brave**. A separate Brave store submission is unnecessary. Actual recording compatibility still needs testing in both browsers. [Brave installation instructions](https://support.brave.app/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)

## What users must install

The extension records and temporarily saves audio in the browser. For transcripts, notes, and the Echo meeting library, users also need the local Echo application installed and running on the same computer. Installing the extension does not install or launch that application.

- **Local Echo application:** the development candidate includes a desktop launcher and bundled runtime for Apple Silicon macOS and Ubuntu x64. Signed distribution and clean-machine qualification remain pending. See [application setup](../README.md#set-up-echo) and [packaging](development.md#make-a-downloadable-package).
- **Extension:** a store installation will replace the current Developer mode / Load unpacked procedure for end users. Until then, follow [development installation](browser-extension.md#development-installation).
- **Speech model:** download the selected model in Echo before transcription. Turbo runs in the browser. Desktop runtimes bundle Large V3's Node.js/native dependencies; source builds install them separately. See [native speech setup](native-speech.md).

For a nontechnical public audience, deliver and test the local application's download, launch, update, backup, and uninstall flows alongside the extension. A store listing alone does not solve those steps.

The candidate connection flow is **Connect to Echo → approve once in Echo → Connected**. Codes remain under Advanced. Recovery-phrase setup precedes protected recording. Use the [installation guide](browser-extension.md), and verify these steps against the exact store candidate before submitting.

## 1. Set up the publisher account

The account owner completes these steps; do not put account credentials or verification screens in this repository.

1. Choose the long-term publisher Google account and open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). Google says the developer account's email cannot be changed directly; changing ownership later requires an item transfer.
2. Register, accept the developer agreement and policies, and pay the one-time fee shown by the dashboard. The registration documentation confirms a fee but does not state an amount; use the dashboard's current amount. [Registration instructions](https://developer.chrome.com/docs/webstore/register)
3. Enable [2-Step Verification](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification), which is required before publishing or updating an extension.
4. Supply the publisher name and verify the contact email. Complete any additional information requested for the account and distribution choices. Google requires a physical address for items offering purchases, additional paid features, or subscriptions. [Account setup](https://developer.chrome.com/docs/webstore/set-up-account)

Registration, payment, accepting agreements, and submission/publication require the owner's explicit approval. This guide and the packaging commands do not perform those actions.

## 2. Build and inspect the extension archive

Use the intended release commit. The packaging script needs Node.js/npm and Python 3. From the repository root:

```bash
npm ci --ignore-scripts
npm run test:extension:unit
npm run package:extension
```

The last command builds the extension and prints its archive path and stable development ID. With the current manifest version, the output is `artifacts/echo-extension-0.1.0.zip`. Its filename follows `extension/manifest.json`'s version; use the printed path after version changes.

Inspect the file list before uploading. For the current version:

```bash
python3 -m zipfile -l artifacts/echo-extension-0.1.0.zip
```

The manifest must be at the archive root. The archive should contain only the allowlisted extension pages, bundled JavaScript, styles, icons, fonts, and font license. It must contain no recordings, local libraries, account credentials, test fixtures, browser profiles, or logs. Packaging has allowlist and symlink checks, but passing them is not a live recording or store-policy qualification.

Run the [full project verification](development.md#run-tests) and applicable [extension qualification](extension-qualification.md) against this same commit. Record the commit, manifest version, tested platforms, and outcomes in the release evidence. Keep temporary inspection output under this repository's `tmp/` directory and remove only the files created for that inspection.

## 3. Create the store draft and establish its identity

In the developer dashboard, choose **Add new item**, then upload the ZIP. Uploading a draft is separate from submitting it for review. [Official upload workflow](https://developer.chrome.com/docs/webstore/publish)

The current manifest contains a fixed development public key. Do not assume its development extension ID is the store item's assigned ID. After creating the draft:

1. Record the assigned item ID and open **Package → View public key**.
2. Follow Google's [consistent extension ID instructions](https://developer.chrome.com/docs/extensions/reference/manifest/key/) to align the development manifest with the store public key if development and store installations should share that identity.
3. Update the repository's expected development-ID test deliberately if the key changes. Rebuild, verify the displayed extension ID against the dashboard, and retest connection authorization and update behavior.

A public key is not a private signing key. Never add private keys or publisher account tokens to the repository.

Treat a switch from the existing unpacked ID to a different store ID as a new installation. Browser storage and permissions belong to the extension identity: synchronize or export all pending audio **before** uninstalling the old build. Pair the new installation with Echo and verify its destination library. Do not promise that pending recordings, permissions, or pairing credentials will migrate automatically. Keep the old installation until its pending recordings are accounted for, and avoid recording in both installations at once.

## 4. Complete the listing and review information

Use the [listing draft](extension-store.md) after updating it to match the release's verified capabilities. Align its product name with the manifest and explain prominently that the local Echo application is required for transcripts and notes.

**Single-purpose description:** Record audio from a browser meeting the user attends, then transfer it to the user's paired local Echo application for transcripts and notes.

Do not describe unqualified browser/service combinations as supported. Explain the English meeting-interface limitation for microphone-state detection. Account login stays in the user's normal meeting tab; Echo does not attend meetings independently.

Complete the dashboard's Store Listing, Privacy, Distribution, and Test instructions sections. Reviewer instructions should provide an accessible local-app build and installation path, current pairing steps, a short recording/import/transcript walkthrough, and permission/recovery checks. Do not provide personal accounts, private meeting links, or real recordings. [Dashboard submission sections](https://developer.chrome.com/docs/webstore/publish)

### Images

Google requires a 128×128 PNG extension icon, a 440×280 small promotional image, and at least one screenshot. It accepts up to five screenshots, each 1280×800 or 640×400 with no external padding. [Official image specifications](https://developer.chrome.com/docs/webstore/images)

The repository already includes 16, 32, 48, and 128 pixel icons. Prepare genuine, sanitized screenshots showing setup/connection, recording with source indicators, pause, pending audio/recovery, and final review in Echo. Demonstrate the local-app requirement clearly. Do not fabricate screenshots or use account verification screens.

The existing [desktop overview](extension-assets/echo-overview.png) is 1280×800; it illustrates the companion app. The [mobile overview](extension-assets/echo-overview-mobile.png) is 320×740 and is not a correctly sized store screenshot. Neither substitutes for extension interaction evidence. The [draft promotional tile and genuine initial-setup screenshots](extension-assets/README.md) are prepared with capture provenance. Connected, recording, pause and saved-history states still need current qualification captures.

### Permission explanations

Copy these only after confirming the release manifest still uses these permissions. Each explanation should describe the implemented user-facing need. [Google's privacy fields guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

| Permission or access | Reason |
|---|---|
| `activeTab` | Identify the meeting tab selected by the user's explicit recording action. |
| `tabCapture` | Capture that tab's audio after the user starts recording; video capture is disabled. |
| `scripting` | Install the enabled provider's observer to read only call and microphone-mute controls. |
| `offscreen` | Keep the audio graph and recording storage active when the popup closes. |
| `storage` | Persist extension preferences, installation identity, and the scoped local connection credential. |
| `unlimitedStorage` | Preserve recoverable local audio while Echo is unavailable; it does not guarantee unlimited disk space. |
| `alarms` | Retry transfer and coordinate recovery when the extension service worker resumes. |
| Loopback hosts | Connect to the configured local Echo application on this computer. Requests use pairing authorization and an exact configured destination. |
| Optional meeting-provider hosts | Observe call/mute state on the service the user enables: Meet, Zoom Web, or Teams Web. No chat, participant profiles, credentials, or page transcripts are collected by these observers. |
| Microphone, requested at runtime | Include the user's voice only after permission and while a fresh meeting observation permits it. This is separate from the manifest permission list. |

The extension bundles its executable code and does not download remote executable code. This statement applies to the extension package; separately disclose the local Echo application's speech-model downloads. Do not claim camera, cookies, browsing history, native messaging, debugger, or all-website permissions are required: the current manifest does not request them.

### Privacy policy and data disclosures

Publish a real, publicly accessible privacy policy and supply its URL in the dashboard. The approved publisher is **Samarth**, contact **samarth.m.n@gmail.com**, with planned hosting at **echovoice.samarthmn.com**. See [publisher facts](../release/publisher.json). Hosting and publication still require the tested candidate and release approval. A local Markdown file is not a hosted policy URL.

The policy and dashboard answers must describe audio, recording titles and meeting identifiers, call/mute observations, installation identity, local connection credentials, and any live transcript preview that the extension handles. State the purposes, local storage locations, transfer destination, retention, export/deletion behavior, uninstall/profile-loss risk, and any explicit optional cloud-note workflow in the companion app. Do not answer “no user data” merely because storage is local. Include the applicable Limited Use statement and make it consistent with actual behavior. [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

Verify the candidate's storage protections before certifying compliance: encrypted browser PCM/metadata, SQLCipher library metadata, authenticated audio files, OS-held library keys and separately saved recovery phrases. Independent review and helper-state protection remain release gates; read the [readiness record](production-readiness-status.md), not only the primitive tests. Google's FAQ calls for strong at-rest encryption. The same FAQ explicitly exempts transmissions between an extension and a native program **on the same computer** from its transmission-encryption requirement. That supports the local loopback architecture; it does not establish an exemption for stored recordings or remote network transfers. Document the final protection design and any clarification obtained from the store. Do not advertise application-level encryption that is absent. [Secure handling and local-program exception](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

## 5. Choose an initial audience and submit

Start with **Private** for named trusted testers, or **Unlisted** when anyone with the listing URL should be able to install it. Unlisted is not access control. Public, private, and unlisted items all follow the same policy requirements and review process. Limit any initial rollout to the cases actually qualified and disclose the remaining limitations. [Distribution settings](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)

After the owner's approval and completion of the relevant release gates, submit for review. Select deferred publishing if the owner wants to inspect the approved item before making it installable. Review duration depends on the item; do not promise an approval date. [Submission and deferred publishing](https://developer.chrome.com/docs/webstore/publish)

Once available, test an actual store installation in clean Chrome and Brave profiles. Verify permissions, local-app discovery/connection, capture, offline recovery, import, export, and restart. Keep Google live testing limited to the authorized test identity recorded in the qualification guide. Store approval is not evidence that these scenarios passed.

## 6. Release updates without losing recordings

Increase `version` in `extension/manifest.json`, test the upgrade from the installed previous version, rebuild, and upload a complete ZIP to the **same store item**. Update the listing, privacy details, screenshots, and reviewer instructions when behavior changes, then submit the update. [Update instructions](https://developer.chrome.com/docs/webstore/update)

Test that an update preserves connection settings and committed pending audio. An active recording may be interrupted by extension reload/update, so verify recoverable audio and accurate interruption status; never promise uninterrupted capture across an update. Do not delete and recreate the store item for routine releases. Store installations receive browser-managed updates, while local companion-app updates remain a separate delivery responsibility.

## Release blockers

Track these as work remaining, not completed launch claims:

- Complete the claimed browser/OS/service scenarios. The current matrix is only partially qualified for Brave/macOS Meet; Chrome, Ubuntu capture, Zoom Web, Teams Web, and remaining lifecycle/live cases are pending.
- Deliver and test the companion-app installation and launch flow for each advertised OS. The new launcher and bundled runtimes require signed artifacts and clean-machine Mac/Ubuntu evidence.
- Qualify the implemented simpler pairing flow in the actual store-installed candidate before advertising it. Preserve explicit local approval and correct-library transfer checks.
- Finish independent storage/security review and retests; publish accurate privacy disclosures using the approved publisher facts only after release approval.
- Finish the connection/recording/recovery screenshots, accessible local-app download, and reviewer instructions; refresh the prepared draft images against the final candidate.
- Establish the actual store identity, verify authorization with it, and test migration from the development installation plus a subsequent store update.
- Complete owner registration, verification, approval, store review, and controlled rollout. No publishing step in this document has been carried out automatically.
