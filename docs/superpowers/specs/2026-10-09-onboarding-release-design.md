# Echo onboarding and release design

> **Scope superseded October 9, 2026:** The user subsequently requested the web version with the browser extension only, and removal of all separate Mac/desktop application work. The original proposal below is retained as design history. A7 and all launcher, bundled installer, signing/notarization, installed-client OAuth and automatic application-update tasks are cancelled, not pending release gates. Current work retains the locally served web app, approved pairing flow, A4 guidance, A6 protection/recovery, library-schema safeguards, manual backup/source updates, native Large V3 speech helper and browser qualification on macOS/Ubuntu. Use the [current setup guide](../../install.md) and [readiness record](../../production-readiness-status.md) for the active scope. Initial local-server setup currently requires developer tools; the former terminal-free installation goal is not a shipped capability.

Status: planning, October 9, 2026. The user approved the Connect → approve pairing experience, then requested a detailed plan before product implementation. Documentation cleanup is authorized now. The broader release recommendations below are proposals, not shipped features or evidence of qualification.

## Outcome and audience

An everyday user should install Echo, connect the extension, record a meeting and obtain a transcript without a terminal, source checkout or developer account. Developers should retain documented source builds, explicit configuration and advanced troubleshooting. Both audiences use the same product and recording safeguards.

Success is a complete installation-to-recovery journey, not simply a store upload. Echo has two deliverables: a local application that stores/processes meetings, and the extension that records the user's existing meeting tab. Publishing the extension alone does not install the application.

## Constraints carried forward

- Existing Brave and Chrome meeting sessions; no separate meeting browser, copied cookies, automated guest, Docker or native meeting runner.
- Meet, Zoom Web and Teams Web remain intended providers. Advertise only combinations with recorded qualification evidence; preserve the full outstanding matrix.
- macOS and Ubuntu are the initial OS families. Recommend first installer targets of Apple Silicon on macOS 14+ and Ubuntu 24.04 x64. Intel Mac, Linux ARM, other Linux distributions and Windows need their own qualification before support claims.
- Manifest V3 and Chromium API floor 120; qualify current stable Brave and Chrome at release.
- Capture tab audio and deliberately permitted microphone only. Never request or capture camera.
- Unknown, muted or stale meeting controls exclude microphone. Participant consent and an explicit Start action remain mandatory.
- One active recording per profile; 16 kHz mono PCM16; eight-hour maximum; two GiB pending audio; five-second maximum persistence backlog; sequential export parts at most 30 minutes.
- Preserve offline recording, committed-prefix recovery, idempotent transfer, final transcripts/notes, native Large V3 and existing libraries.
- Optional live text uses existing Turbo; do not install models or choose cloud processing automatically.
- Normal /api access protections remain unchanged. No externally_connectable interface, arbitrary page-command bridge or broader browser permissions for pairing.
- Live Google account testing uses only sublimeinnovationtechnologies@gmail.com.
- Development scratch stays under the project tmp/ directory. Never delete another session's files or user libraries.
- Product changes remain local until review/fix/retest gates pass; push the current branch only when authorized gates are met. Store upload/submission, publication, fees and agreements remain distinct owner actions.

## Current evidence and gaps

The current branch implements extension recording, offline recovery, manual pairing and processing. The October 8 reviewed head passed CI; that result does not qualify new changes. Brave/macOS/Meet has partial human evidence. Chrome, Ubuntu, Zoom, Teams and remaining live/lifecycle cases are pending in the qualification guide.

Setup currently exposes address, browser name and a long code, requires switching screens, and loses its polling timer when the setup page closes. Provider controls are recreated periodically, risking keyboard-focus loss. The app guide starts with build commands. The runtime archive is Linux x64 and requires terminal startup; macOS has no tested consumer installer. Public release also lacks final store identity, hosted privacy policy, completed extension screenshots and a settled stored-data protection design.

## Approved pairing experience

1. Install/open Echo and install the extension.
2. Extension setup opens on first installation only. Choose **Connect to Echo**.
3. Echo opens in the same browser on **Connect this browser to Echo?** The user sees the recording-transfer scope and chooses **Connect** or **Cancel**.
4. The extension completes automatically and shows **Connected to Echo**. No code or address entry in the normal flow.
5. Setup guides meeting-service access and optional microphone permission. It shows **Ready to record** and explains how to return to the meeting tab and press Start.

The connection approval is a real consent boundary. No URL, page load or background retry may approve a request. Request names are unverified display text, not proof of publisher identity. Show the extension ID in details and remind users to continue only after initiating Connect themselves.

Advanced settings retain exact loopback address configuration, a browser name and manual code pairing. A 404/405 from the new begin route offers the old-server code flow. Network failure instead says **Open Echo, then try again**. Recording without Echo remains available as an explicit choice; permission denial offers **Record call audio only**.

## Pairing contract and recovery

The extension generates a UUID request ID and 32 cryptographically random bytes encoded as 64 hexadecimal characters. Persist the attempt in trusted extension-local storage before its first request; never expose its secret through UI state, URLs, logs or content scripts.

Add POST /extension/v1/pairing/begin with requestId, installationId, name and claimSecret. Reply includes protocolVersion=1, requestId, libraryId, status and expiresAt. Reuse the existing claim route, mapping claimSecret to its code field. Browser-initiated requests use kind=browser in the existing pairing table; migrated rows default to kind=manual. Only the secret hash is stored server-side. Browser claim prepares a credential without replacing the active connection; return activationRequired=true. The extension must durably save that receipt before POST /extension/v1/pairing/activate commits the replacement. Add activation_required defaulting to false for legacy rows; browser begin sets it true. On a new server, Advanced code pairing also sets deferredActivation=true on the existing request route and receives the same staged guarantees. Legacy clients omit it and remain compatible. Old-server manual fallback explicitly recommends updating Echo for reliable interrupted-pairing recovery; it must not promise the new activation guarantees.

Open the validated configured origin plus /extension-connect.html#request=<public UUID>. The approval page reads GET /api/extensions/requests/{id}, approves with the existing same-origin endpoint and rejects with a new endpoint. Only the public request ID appears in the URL. Do not accept arbitrary redirect/return URLs or add a cross-origin exception to /api.

Browser server state is pending → approved → prepared → claimed, with rejected/cancelled terminal alternatives before activation. Expiry for initial activation is fixed at 300 seconds from creation; retries do not extend it. Identical retries are idempotent, conflicting UUIDs return 409, and invalid secret/origin/installation cannot inspect or claim an attempt. Activation atomically authorizes the prepared credential and marks claimed. A committed activation can be reconciled after the original expiry only while its hash remains the current authorized connection. Retain its hashed receipt until replacement/revocation; expiry cleanup must not erase this evidence. Reconciliation never creates or restores a revoked connection.

Before activation, cancellation leaves the prior connection intact. Persist activation-sent before sending; from that point show **Finishing connection** and reconcile a lost response before allowing cancellation, disconnection or a newer attempt to discard it. If activation committed, finish storing the connection locally and then honor a requested disconnect through normal revocation. Never display Cancelled while a newly authorized credential is orphaned or a previous credential has unknowingly been invalidated. Browser closure/restart resumes reconciliation without a fresh approval; uncommitted expired requests require a new Connect action.

Preauthorization limits: at most 20 unexpired reservations globally; browser-initiated attempts use at most 16; at most four browser attempts per extension origin within the five-minute window. Exact retries are free. Rejected/cancelled rows continue counting until original expiry. Never evict another attempt. Browser-initiated requests appear only on their specific approval page, not as unsolicited general-settings approval banners.

Begin, claim, cancellation, disconnect and library confirmation share one extension connection-action queue. Every asynchronous result checks that its request ID is still current. Opening setup or restarting the worker resumes an existing unexpired attempt; neither creates a new one. The existing alarm can finish an approved claim while setup is closed. Tab-open failures show an explicit retry link.

A library switch checks all pending recordings, including after disconnect clears activeLibraryId. Bound recordings retain their original library and usable connection credentials. Unassigned recordings require explicit destination confirmation before activation when pending data exists. Cancelling that confirmation retains local audio and the previous connection; approval never silently reassigns old recordings. A reconnect to the same library updates its usable credential atomically after activation, so pending audio is not left relying on the superseded credential.

## Beginner onboarding and daily use

Use existing typography, controls, icons and spacing. The setup page has three short steps: connect Echo, choose meeting service, include microphone or choose call audio only. Completed steps collapse to summaries but remain editable. Recovery and technical details stay accessible below setup.

The popup prioritizes the active meeting, source status, consent and one Start action. It describes what prevents recording and provides one relevant action. A completed setup on a non-meeting tab says to open a meeting. Recording, saving, transfer and processing have separate statuses. Unknown microphone state says the call is being recorded but the user's voice is excluded.

The workspace distinguishes **Ready to record** from **Ready to transcribe**. Offer an explicit Turbo download with size, progress, cancellation and retry. Recording never depends on finishing a model download. Notes and Calendar are optional steps; missing integrations must not block the core flow.

Usability target for qualification: five first-time nontechnical testers complete installation, connection and a short recording without command-line instructions; at least four complete it without facilitator intervention. Exclude model download duration from the timed navigation measure; record any confusion rather than hiding failures. Keyboard-only operation, both themes, 320px workspace/setup and 150%/200% zoom are required.

## Companion application delivery — recommended design

Use a thin Tauri 2 launcher to own the existing Rust server and provide launch/status/update controls. It opens the workspace in the user's selected existing Brave or Chrome browser and remembers that choice; an unsupported system default such as Safari must not silently become the processing browser. Use a normal browser session without creating a profile or passing automation flags. Explain that changing browser/profile may need model downloads and extension setup again. It neither embeds nor controls meeting sessions. A small launcher window remains available on Ubuntu when the desktop does not show tray icons.

Separate immutable resources from the user's library/configuration, caches and logs. Use an explicit resource root and bundled helper paths instead of working-directory or PATH assumptions. Installed mode reads its explicit private configuration path, never an unrelated .env or echo.config.json discovered in the launch directory or its parents; source mode keeps deliberate repository configuration. Installed data belongs under the user's application-data directory; development overrides stay supported. Never create an empty replacement library silently during migration.

Bundle everything needed for advertised capabilities. Baseline Turbo requires no user Rust/Node/npm/Python installation. If full Large V3 is exposed, bundle the pinned Node runtime, native ONNX libraries and production speech dependencies. If ChatGPT notes are exposed, bundle the matching pinned Codex helper and maintain its separate credential environment. Ollama remains optional with guided installation/connection.

macOS release: signed, notarized, stapled app/DMG. Ubuntu release: .deb with desktop entry and declared dependencies. Do not instruct users to bypass security warnings. Authenticate an owned running instance using private per-user IPC; never trust an arbitrary service on port 3000 as Echo. Use a stable loopback origin and an actionable port-conflict screen.

Closing a workspace tab leaves Echo running. Quit and updates explain active processing; update application/schema only when safe. The launcher supervises owned children, bounds restart attempts and avoids orphaning helpers. Startup-at-login is opt-in.

## Security and optional integrations

Resolve stored-data protection as a separately reviewed design before public-release compliance claims. Cover pending browser PCM and metadata, local SQLite/audio, account credentials, temporary decoded PCM, backups and export. Define the threat model, key storage/recovery, migration, locked-key behavior and lost-key UX. Storing a key beside ciphertext is not evidence of protection against profile theft. Browser sandboxing, permission bits and disk-encryption advice must not be described as application encryption.

The Chrome Web Store FAQ covers local-only disclosures and at-rest protection; it separately exempts extension/native-program transmission on the same computer from the transmission-encryption requirement. Keep loopback isolation/authentication and verify current policy before submission. This planning pass does not certify compliance. See the [publishing guide](../../extension-publishing.md#privacy-policy-and-data-disclosures).

For nontechnical Calendar setup, replace developer .env requirements with the appropriate publisher-configured desktop OAuth/PKCE flow and required Google verification. Use the normal browser, read-only scopes and protected token storage. Do not put a confidential web-server client secret in a public app bundle. Until this is qualified, Calendar remains clearly optional and maintainer-configured; direct meeting recording works independently.

## Documentation contract

README: current availability, everyday-user quick start, first recording, recovery/help, developer entry point. Detailed source-build commands belong in development.md. Current guides describe shipped behavior; plans are labelled proposals. Feature coverage maps implemented behavior to limits. Dated test records remain historical evidence. Retired runner guides become clear pointers, not parallel installation instructions.

Maintain docs/README.md as the audience index. Link the current installation, publishing, recovery and qualification guides. Do not duplicate volatile limits or version strings in multiple places without a check. Never claim a download/store link exists until it does.

## Release sequence and definition of done

Deliver in independently reviewed stages: documentation cleanup; pairing/onboarding; local-app delivery; security/integration qualification; store/private beta; public release. Do not call the product production ready after completing only the first two stages.

Public launch requires exact-artifact automated checks, applicable human browser/provider matrix, clean-machine installation and update tests, recovery/security review, accurate support claims, complete store materials, owner-controlled accounts/hosting/signing and approved publication. Keep all findings tied to the tested commit and artifact hash. Use the Ubuntu handoff for tests unavailable on this Mac.
