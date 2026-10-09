# Echo onboarding and production readiness implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let everyday users install Echo, connect its extension, record, transcribe, recover and update without developer tools, while preserving a complete developer workflow.

**Architecture:** Keep the existing Rust/Dioxus workspace and MV3 recorder. Add persistent browser-initiated pairing with one explicit approval in Echo, guided readiness, and a thin Tauri launcher that runs the local server and opens the user's browser. Deliver pairing, application distribution and release qualification as separately reviewable stages; stored-data protection needs its own reviewed design before implementation.

**Tech Stack:** Rust, Axum, SQLite, Dioxus/WASM, TypeScript, Manifest V3, esbuild, existing browser/native speech engines; proposed Tauri 2 launcher and platform packaging.

**Spec:** [Onboarding and release design](../specs/2026-10-09-onboarding-release-design.md). Read that document with this plan.

Status: implementation approved October 9, 2026. This file is the detailed Codex implementation plan; [human-only dependencies](2026-10-09-human-tasks.md) are separate. [Execution status](../../production-readiness-status.md) records current evidence and remaining work. Existing extension functionality is the starting point, not work to rebuild. The user also approved automatic authorized unlock through Echo, with a locally saved recovery phrase for opening/exporting encrypted audio after a browser restart without Echo; recording remains possible offline after initial setup. This decision supersedes earlier text leaving that user experience open.

## Global Constraints

- Use existing Brave/Chrome meeting tabs. No separate meeting browser, cookie copying, automated guest, Docker, or native meeting runner.
- Intended providers are Meet, Zoom Web and Teams Web. Advertise only qualified browser/OS/provider combinations.
- Proposed first installers: Apple Silicon macOS 14+ and Ubuntu 24.04 x64. Qualify other architectures separately. These targets do not claim current support or remove existing source-build options.
- Manifest V3, Chromium API floor 120, current stable Brave/Chrome qualification. No new externally_connectable bridge or broad website permissions.
- Never request camera access. Explicit recording action and consent; unknown, muted or stale provider state excludes microphone.
- Preserve one active recording per profile, mono 16 kHz PCM16, eight-hour limit, two GiB pending audio, five-second persistence backlog and sequential parts of at most 30 minutes.
- Preserve offline recording, committed-prefix recovery, idempotent imports, existing libraries and versions, and native Large V3. Live text remains optional and uses Turbo.
- No automatic model download, cloud upload or notes-provider selection. Calendar and notes remain optional.
- Keep ordinary /api protections. Pairing approval requires an explicit same-origin action, never a URL load.
- Google live tests use only sublimeinnovationtechnologies@gmail.com. Never commit tokens, private meeting links, account screens or browser profiles.
- Development scratch belongs in this project's tmp/. Clean only session-owned files/tabs/processes. Installed application data uses private OS application directories.
- Commit locally through each review/fix/retest gate. Push the existing branch after the relevant release checks, then inspect fresh CodeRabbit results, fix applicable findings, retest and repush. Do not mark unavailable human tests passed.
- Store upload/submission/publication, developer agreements, payments and signing-account actions require the owner's separate approval. Preparing files does not perform those actions.

## Review Focus

1. Echo is absent, an older Echo is running, or another program owns port 3000: show distinct recovery actions; never connect to an arbitrary service. Tasks 2, 4 and 8 test these cases.
2. Approval arrives after cancellation/disconnection or after a newer attempt: stale work must not replace the current connection. Tasks 2–3 test ordering and revocation.
3. Pending recordings exist after disconnect or belong to another library: approval must not silently move or delete them. Task 3 tests both bound and unassigned audio.
4. An update/crash occurs with pending audio or a partially migrated library: retain the recoverable original, preserve identity, and prevent destructive rollback. Tasks 6, 10 and 11 test this.
5. A key/device permission/model becomes unavailable after setup: show the actual state and preserve audio; stored readiness flags are not proof of current availability. Tasks 4–5 and the security subplan test this.

## Scope, ownership and dependency order

| Stage | Tasks | Reviewable outcome | Can run independently |
|---|---|---|---|
| Documentation | 1 | Accurate user/developer paths today | Current planning pass |
| Connection | 2–4 | One Connect action and one real approval; reliable recovery | Server and extension work after contract agreement |
| First recording | 5 | Clear recording/transcription readiness | After connection interfaces are fixed |
| Application delivery | 6–8 | Clean-machine installation and launch | Resource-path work can parallel connection work |
| Security/integrations | 9 | Reviewed protection design and explicitly scoped optional features | Investigation can start early; release is gated |
| Updates/qualification | 10–11 | Evidence for install, capture, recovery and upgrades | Tests can be prepared earlier |
| Distribution | 12 | Reviewed artifacts and staged release | Draft materials can be prepared earlier |

Use bounded implementation agents and a reviewer independent of the author. Reserve shared files (package.json, manifests, build scripts and server routing) for one integrator at a time. Each task ends with local verification and a focused commit; a later failed gate does not justify pushing an unqualified release.

Existing commands in this plan are verified against package.json/Cargo.toml. New test/script names are explicitly introduced by their task. Tests should fail for the intended missing behavior before implementation. Do not repeatedly run the full suite after documentation-only edits.

## Task 1: Separate current user instructions, developer references and history

**Files:** README.md; docs/README.md; docs/development.md; docs/browser-extension.md; docs/architecture.md; docs/feature-coverage.md; docs/integrations.md; docs/extension-publishing.md; docs/extension-store.md; historical banners in docs/product-plan.md, docs/implementation-plan.md and docs/verification.md.

**Contract:** Current guides describe implemented behavior; this plan describes proposals. README starts with how to use Echo, the developer guide owns source commands, and the docs index links both. Preserve dated evidence and old-data recovery instructions.

- [x] Review changed current-guide instructions against the UI/code. Retain current manual code pairing, terminal startup, Linux-only runtime archive and pending platform qualification until replacements actually ship.
- [x] Remove repeated development detail and conversational/history text from current guides. Correct local/cloud notes disclosures: selected transcript text goes to OpenAI only after confirmation; audio is not sent by that flow.
- [x] Validate changed relative links and anchors, including incoming README anchors. Run `git diff --check`; expected no whitespace errors. Read the complete beginner path without assuming a source checkout or an available release file.
- [ ] Commit only documentation: `docs: clarify user and developer setup and release status`.

## Task 2: Add browser-initiated pairing without weakening authorization

**Files:** server/src/extensions.rs; tests/extension-pairing.test.mjs (new HTTP integration tests); server/src/extensions.rs test module. Keep ingest behavior out of this change.

**Interfaces:**

| Route | Request / response contract |
|---|---|
| POST /extension/v1/pairing/begin | `{requestId, installationId, name, claimSecret}` → `{protocolVersion:1, requestId, libraryId, status, expiresAt}` |
| POST /extension/v1/pairing/request | Existing code flow accepts optional deferredActivation=true on new servers so Advanced uses staged activation too. Old clients/servers retain legacy behavior, clearly distinguished by the extension. |
| POST /extension/v1/pairing/claim | Existing `{requestId, installationId, code}`; browser flow uses claimSecret as code. Browser requests return a prepared credential with activationRequired=true, without replacing the active connection. Manual behavior remains compatible. |
| POST /extension/v1/pairing/activate | Same identifying fields as claim; atomically activate the prepared credential, then return status/library confirmation. Idempotent committed retries cannot restore revoked credentials. |
| POST /extension/v1/pairing/cancel | Same identifying fields as claim → terminal status; authenticated by secret plus bound origin/installation. |
| GET /api/extensions/requests/{id} | Same-origin metadata only: request/installation ID, escaped display name, extension origin, status and expiry; never secret/hash/credential. |
| POST /api/extensions/requests/{id}/approve | Existing endpoint, idempotent for an already-approved request. No credential in response. |
| POST /api/extensions/requests/{id}/reject | Same-origin explicit denial; idempotent terminal response. |

- [ ] Add HTTP tests named `browser_pair_requires_explicit_approval`, `begin_retry_preserves_expiry`, `stale_claim_cannot_restore_revoked_connection`, and `ordinary_api_still_rejects_extension_origin`. Assert begin creates no connection, GET creates no approval, identical begin preserves request/expiry, conflicting payload returns 409, and unauthorized normal API access remains rejected.
- [ ] Run `node --test tests/extension-pairing.test.mjs` against the current built test server; expect the new-route tests to fail with 404 before implementation. Use the repository's isolated-server test helpers and project tmp/.
- [ ] Migrate extension_pairing with `kind TEXT NOT NULL DEFAULT 'manual'` and `activation_required INTEGER NOT NULL DEFAULT 0`. Browser begin sets activation_required=1; the new optional deferredActivation=true manual request flag does too. Validate UUIDs, name length 1–100, exactly 64 lower-case hexadecimal browser-secret characters, allowed fields, bounded body and extension origin. Hash secrets; retain exact configured loopback validation and no redirects.
- [ ] Implement browser pending → approved → prepared → claimed plus rejected/cancelled before activation. Initial activation requires the fixed 300-second lifetime; a prepared credential has no ingest access and cannot invalidate the previous connection. Activation and state change are one transaction. Keep manual request/claim compatible.
- [ ] Test lost claim response followed by cancel leaves the previous connection usable; test lost activation response can reconcile after expiry/restart. Retain the hashed claimed receipt while its credential is current and allow only reconciliation, never fresh authorization, after expiry. Replacement/revocation invalidates it. Expiry cleanup removes abandoned attempts without erasing current-connection evidence. Cancellation after committed activation reports claimed rather than pretending to revoke it.
- [ ] Enforce transactionally: at most 20 unexpired reservations globally, 16 browser requests globally and four browser attempts per extension origin per five minutes. Count rejected/cancelled until original expiry; never extend/evict. Add boundary tests: the fifth same-origin attempt and seventeenth browser reservation return 429, exact retries succeed, and manual slots remain available within the global cap. Concurrent requests cannot exceed limits.
- [ ] Hide kind=browser from general Settings pending-request lists; explicit request metadata remains available only through the normal same-origin route. Test hostile origin, missing/wrong secret, wrong installation, expired request, restart and same-ID/different-name conflict. Treat an extension origin as a binding, not trusted publisher identity.
- [ ] Rebuild server and run new HTTP tests plus `cargo test --locked -p echo-server`; expected all pass. Independent authorization review before local commit `feat: add approved browser initiated extension pairing`.

## Task 3: Make connection attempts survive closed pages and worker restarts

**Files:** extension/src/pairing.ts (new); extension/src/background.ts; extension/src/settings.ts; extension/src/core.ts; extension/src/connection.ts; extension/src/protocol.ts; tests/extension-pairing-runtime.test.mjs (new); package.json unit-test list.

**Interfaces:** `PairingAttempt` contains requestId, installationId, endpoint, claimSecret, createdAtMs, expiresAtMs, libraryId, phase and optional staged credential; secret-bearing state is trusted-storage only. Persist phase=activation-sent plus staged credential before the activation request. `PairingView` exposes requestId, phase, expiry, display endpoint, pendingCount and recoverable error code only. Export `beginPairing(endpoint: string, name: string): Promise<PairingView>`, `resumePairing(): Promise<PairingView>`, `cancelPairing(): Promise<PairingView>` and `confirmPairingLibrary(requestId: string): Promise<PairingView>`. Wire trusted-page messages PAIR_BEGIN, PAIR_STATUS, PAIR_CANCEL and PAIR_CONFIRM_LIBRARY; retain manual messages.

- [ ] Add tests for saved-before-send, setup reload, service-worker restart, lost begin/claim acknowledgement, late claim after cancel, two concurrent begin actions and claim racing disconnect. Assert only the current request can change activeLibraryId and no secret appears in STATE/PairingView/content-script responses.
- [ ] Add the new test file to `test:extension:unit`, run it to observe intended failures, then implement using existing connectionAction serialization. Persist before first network send in TRUSTED_CONTEXTS storage.local; treat expiry from the server as authoritative and validate units.
- [ ] Resume the same attempt from setup open, startup and the existing 30-second recovery alarm. Visible setup can poll every two seconds. Do not hold the service worker awake or depend on a setup timer. Do not recreate expired attempts without a new Connect action; reconcile already-sent activation separately even after expiry.
- [ ] Validate responses before applying them; compare requestId after every awaited operation. Before activation, Cancel prevents future activation and attempts server cancellation. Once activation-sent is durable, show **Finishing connection**; a cancellation/disconnection/new-attempt action must first reconcile the commit. Do not discard its credential/receipt on timeout. If activation succeeded, store the connection and perform normal revocation if disconnect was requested. Test crash immediately before send, committed activation with lost response, and restart after expiry. Serialize all connection mutations through the same queue.
- [ ] Implement pending-library confirmation before activation even when activeLibraryId is null. Test bound recordings retain original destinations/credentials and unassigned recordings require destination confirmation. Cancelling this confirmation leaves prior settings/audio unchanged; disconnect still waits for server revocation and never deletes recordings. Same-library reconnect updates the usable credential atomically so pending audio can resume. A library switch cannot authorize transfer merely by changing a global default.
- [ ] Distinguish old-server 404/405 from connection refused/timeout, 429, denial, expiry and revoked connection. On new servers Advanced code pairing requests deferred activation; test that it follows the same safe cancellation rules. On old servers preserve the legacy flow but recommend updating Echo for reliable interrupted-pairing recovery and do not imply staged guarantees. Keep credentials out of generic errors and logs. If opening the approval tab fails, return a safe recoverable action with the same request ID.
- [ ] Run `npm run test:extension:unit` and `npm run test:extension:integration`; expected no lost settings or capture/recovery regression. Commit `feat: persist extension pairing and recovery` after independent race/recovery review.

## Task 4: Deliver the approved connection and permission experience

**Files:** public/extension-connect.html (new); web/extension-connect.js (new); scripts/build-assets.mjs; public/app.css; extension/setup.html; extension/popup.html; extension/styles.css; extension/src/setup.ts; extension/src/popup.ts; app/src/extension.rs; public/extension-guide.html; tests/extension-layout.test.mjs; tests/extension-onboarding.test.mjs (new); scripts/test-browser.mjs.

**Interfaces:** Approval URL is exactly the validated Echo origin plus `/extension-connect.html#request=<UUID>`. No claim secret, credential, arbitrary callback or return URL. Approval page uses Task 2's same-origin API; extension uses Task 3's sanitized PairingView.

- [ ] Add browser tests for Connect → approval → Connected, Cancel, expiry, approved-with-setup-closed, failed tab open, older server and unavailable server. Assert loading the approval URL never approves, request labels are text rather than HTML, and no arbitrary redirect is accepted.
- [ ] Build the local approval page with existing design tokens and bundled JS. Heading: **Connect this browser to Echo?** Explain scoped recording transfer and revocation in one short paragraph. Buttons: **Connect** and **Cancel**. Show extension ID and unverified installation label in details. After approval show success and return-to-extension guidance; background claim completes without requiring the user to keep this page open.
- [ ] Replace manual-first setup with Connect, meeting service and optional microphone steps. Keep codes, custom address and installation name under **Advanced**. Provide **Record without Echo** as an explicit offline route; no recording starts during setup.
- [ ] Create provider controls once and update their state in place. Verify actual host permission and microphone permission; saved micGranted alone is insufficient. Request permissions only after the relevant action. Denial offers **Record call audio only**. Return to the meeting and require a fresh Start after permission setup changes tabs.
- [ ] Open setup on first install only, not on update. Keep completed steps editable. Show friendly connection summaries, with technical library identifiers in details. Use actionable copy for permission revoked, no supported meeting, wrong interface/mute unknown and Echo unavailable.
- [ ] Verify keyboard focus survives at least two refresh cycles, labels and live regions are accessible, and Start/error controls remain readable in both themes. Check popup widths 360–420 CSS px, 150%/200% zoom, and 320px setup/workspace layouts. Do not force desktop-width content inside narrow popup cards.
- [ ] Run `npm run build:assets`, `npm run build:extension`, `node --test tests/extension-onboarding.test.mjs tests/extension-layout.test.mjs`, then `npm run test:e2e` with a rebuilt test server. Record human Brave and Chrome results separately. Update current guides only after behavior passes. Commit `feat: simplify extension connection and setup`.

## Task 5: Make first recording and first transcript understandable

**Files:** app/src/main.rs; app/src/models.rs; app/src/settings.rs; app/src/ui.rs; app/src/extension.rs; web/bridge.js; tests/automatic-transcription.test.mjs; tests/extension-workspace.test.mjs; scripts/test-browser.mjs; docs/browser-extension.md; README.md.

**Interfaces:** Reuse existing model download/progress and automatic-transcription APIs. Add a presentation-only `SetupReadiness` in app/src/ui.rs with recordingReady, selectedSpeechModelReady and optionalNotesReady; derive from actual current capability results, never persist as authority.

- [ ] Add UI scenarios for no speech model, interrupted download, ready model, missing optional notes and disconnected Calendar. Assert recording remains available without a model and notes/Calendar do not block the core journey.
- [ ] Add a concise first-use checklist: record, download a speech model when requested, create transcript, optionally set up notes. Separate **Ready to record** and **Ready to transcribe**. Offer model size, disk requirements, progress, cancel and retry using existing mechanisms. Do not silently switch the selected speech model.
- [ ] Link saved/imported recordings directly to their next action. Preserve Saved in this browser / Saved in Echo / Processing distinctions and provisional live-text labeling. Notes always use a final selected transcript version.
- [ ] Verify in-person and upload routes still work, automatic transcription does not duplicate jobs, and missing optional services have one clear recovery action. Run `npm test` and `npm run test:e2e`; human-check a fresh empty library in both themes and at 320px.
- [ ] Update the relevant user instructions and locally commit `feat: guide first recording and transcription`.

## Task 6: Remove working-directory assumptions from the local runtime

**Files:** server/src/paths.rs (new); server/src/main.rs; server/src/config.rs; server/src/store.rs; server/src/speech.rs; server/src/chatgpt.rs; scripts/package.mjs; tests/runtime-paths.test.mjs (new).

**Interfaces:** `RuntimePaths { resource_root, data_dir, cache_dir, log_dir, runtime_dir }`; `RuntimePaths::resolve() -> Result<RuntimePaths, PathError>`. Installed launcher supplies ECHO_RESOURCE_DIR and ECHO_DATA_DIR; source mode preserves existing defaults and ECHO_CONFIG_FILE. Helpers use explicit executable/resource paths. App version and library schema version are distinct.

- [ ] Add tests launching from a directory outside the checkout, a path containing spaces/non-ASCII characters and a read-only resource folder. Assert assets/helpers resolve, the library stays at its selected location, and no files appear next to installed binaries.
- [ ] Resolve immutable assets separately from library/configuration and private runtime files. macOS data defaults to `~/Library/Application Support/Echo Voice/`; Ubuntu follows XDG_DATA_HOME with `~/.local/share/echo-voice/` fallback, and corresponding cache/state directories. Validate ownership/permissions and reject accidental simultaneous library owners. Installed mode reads an explicit private config path and does not run cwd/parent dotenv discovery; source mode retains deliberate repository configuration. Test a launch directory containing unrelated .env and echo.config.json: neither may change the installed library, OAuth client or helper path.
- [ ] Add a deliberate first-launch migration selector for an existing library; validate it before copying/opening. Preserve library UUID, paired installations, meetings, audio, versions and optional account state. Never silently start a new empty library because migration failed. Do not scan unrelated browser profiles.
- [ ] Test migration interrupted before/after activation, insufficient disk, incompatible newer schema and legacy runner markers. Back up before changing schema; leave source data and recovery WAVs intact. Prevent legacy active writers from being bypassed.
- [ ] Run `cargo test --locked -p echo-server` and the new runtime path tests, plus native speech and ChatGPT helper tests. Commit `refactor: separate installed resources from user data`.

## Task 7: Package runtime dependencies and clean-machine artifacts

**Files:** scripts/package-desktop.mjs (new); scripts/runtime-dependencies.json (new pinned versions/checksums/licenses); scripts/package.mjs; .github/workflows/release-desktop.yml (new manual build workflow); tests/package-desktop.test.mjs (new); docs/desktop-installation.md (new after functional artifacts).

**Interfaces:** Produce a versioned sidecar resource directory containing echo-server, public assets and only required platform helpers. Emit a manifest with target triple, app/protocol/schema versions and SHA-256 for each shipped file. No runtime reliance on the source checkout.

- [ ] Add archive-inspection tests rejecting .env, data libraries, recordings, profiles, model caches, test audio, logs, symlinks outside the bundle and unexpected files. Assert all referenced helpers exist for the target architecture.
- [ ] Define pinned bundles for aarch64-apple-darwin and x86_64-unknown-linux-gnu. Baseline Turbo must run without user-installed Node/Rust/npm/Python. For advertised native Large V3, bundle the compatible Node runtime and production speech/ONNX dependencies; verify redistributable licenses and CPU compatibility. Preserve source-build support.
- [ ] Bundle the pinned platform Codex helper only where optional ChatGPT is advertised; preserve its isolated credential home. Never inherit unrelated Codex authentication. Ollama stays an explicit optional dependency with a guided connection check.
- [ ] Build artifacts in CI per native platform, generate license inventory and hashes, and test extracted resources from a clean user directory. Download speech models only through an explicit user action; test recovery of an interrupted model download.
- [ ] Add `package:desktop` and `test:desktop-package` scripts when their implementations exist. Expected checks: deterministic allowed contents and passing clean-environment smoke tests. Commit `build: package complete macOS and Ubuntu runtimes`.

## Task 8: Add an installable launcher with clear lifecycle controls

**Files:** desktop/Cargo.toml; desktop/tauri.conf.json; desktop/src/main.rs; desktop/src/runtime.rs; desktop/src/instance.rs; desktop/ui/index.html and status.js (new); server/src/runtime_control.rs (new); server/src/main.rs; Cargo.toml workspace membership; scripts/package-desktop.mjs; docs/desktop-installation.md.

**Interfaces:** In desktop/src/runtime.rs, `LaunchPaths` holds resource, data, cache, log and runtime directories and becomes explicit environment values for Task 6; it does not import private types from the server binary. `RuntimeSupervisor::start(paths: LaunchPaths) -> Result<RunningInstance, LaunchError>` and `request_shutdown(reason: ShutdownReason) -> Result<ShutdownOutcome, LaunchError>`. RunningInstance includes the verified workspace URL and owned child handle. Private per-user IPC authenticates an existing owned launcher; ordinary port reachability is insufficient.

- [ ] Add supervisor tests for already-owned instance, unrelated process on 3000, startup failure, child exit, lost helper, quit while ingest/processing is active and repeated crashes. Assert no second server writes the same library, no unrelated process is killed and retries stop after three failures within five minutes.
- [ ] Implement a thin Tauri 2 status window with **Open Echo**, running/problem status, **Quit**, and **Check for updates** once Task 10 is ready. Ask once for an installed Brave/Chrome choice and remember it; an unsupported default browser must not be opened silently. Open its normal existing session without a new profile or automation flags. If no supported browser is installed, provide an explicit installation link and Retry. Keep a window route available when Ubuntu has no tray integration.
- [ ] Test Safari/unsupported system default, one/both/no supported browsers installed, a remembered browser removed, and multiple browser profiles. Explain that browser models and extension setup belong to the chosen profile/origin; switching does not move them automatically. Do not read/copy profile data or promise to target an arbitrary profile through unsupported OS APIs.
- [ ] Start the owned server with Task 6 paths and Task 7 resources. Use a stable default loopback origin. A port conflict gives clear retry/help and Advanced configuration; do not probe a broad port range or auto-pair to another local service. Automatic start at login is opt-in.
- [ ] Add an optional launcher-owned Unix-domain control socket, created under its mode-0700 runtime directory with mode-0600 permissions. Pass a per-launch random control secret through a private inherited channel, not a URL/command argument/log. Its bounded versioned messages are `status` (owned instance ID, workspace URL, active ingest/processing counts) and `shutdown` (expected instance ID, deliberate-force flag). Authenticate both directions against the launched instance; no new shutdown endpoint on the public loopback router. Source mode without a launcher continues using Ctrl+C. Test a forged socket response, invalid secret, wrong instance ID and lost acknowledgement.
- [ ] Quit checks active ingest/processing and offers wait/cancel; if the user deliberately quits, explain that extension capture can remain local and resume transfer later. Only terminate owned children and use bounded graceful shutdown. Closing the workspace tab is independent of server lifetime.
- [ ] Produce signed, notarized, stapled macOS app/DMG and Ubuntu .deb with desktop entry and declared OS dependencies. Signing credentials stay in owner-controlled secret storage. No documentation that bypasses operating-system trust warnings.
- [ ] Add `cargo test --locked -p echo-desktop` with the new crate. On clean target machines, install via GUI, launch without a terminal, record/transcribe/export, quit/reopen and uninstall while retaining user data. Unqualified targets remain pending. Commit `feat: add local Echo desktop launcher`.

## Task 9: Resolve stored-data protection and optional account onboarding

This stage contains two bounded subprojects. The storage design is a **public-release blocker**, not an invitation to improvise cryptography during UI work. Investigation can run alongside Tasks 2–8. Complete approved subplans before claiming their capabilities.

**Files:** docs/superpowers/specs/2026-10-09-storage-protection.md and matching implementation plan (new during execution); docs/security-data-handling.md (new); extension/src/storage.ts; server/src/store.rs; server/src/integrations.rs; server/src/chatgpt.rs; docs/integrations.md; docs/chatgpt.md. Additional storage files are determined by that reviewed subplan, not assumed here.

- [ ] Inventory pending PCM/metadata, SQLite/audio, Google/ChatGPT credentials, decoded temporary audio, exports and backups. State what protects against profile theft, disk theft and malicious software running as the user. Record current plaintext accurately; file permissions are not encryption.
- [ ] Compare viable key lifecycles for offline browser recording and OS-backed server keys. Specify browser-restart recovery, locked OS key store, unavailable Echo, passphrase/recovery choice if needed, key rotation, device migration, deletion, tamper detection and lost-key behavior. Do not claim a key stored next to ciphertext protects a copied profile.
- [ ] Review the concrete storage design independently and with the user where it changes offline/unlock/recovery behavior. Produce its file-level migration and test plan, then implement it. Required tests include corrupted/truncated chunks, key unavailable after restart, migration interruption, wrong key, disk full and recovery/export without silent plaintext fallback. Preserve committed audio or make a blocking limitation explicit before launch.
- [ ] Recheck current store policy with the publisher; local processing still needs disclosures. The same-computer transmission exception is not evidence that plaintext storage is compliant. Publish accurate implemented protections, not a promise of future encryption.
- [ ] For beginner Calendar support, create a separate OAuth subplan using a publisher-configured installed-app client, normal-browser authorization, PKCE/state validation, loopback callback, read-only scope and protected token storage. No confidential web-client secret in the app. Cover denied/expired/revoked grants, wrong-account cancellation, restart and disconnect. Follow required Google verification before public distribution. Until qualified, keep Calendar optional and maintainer-configured without blocking direct meeting recording.
- [ ] Verify optional notes setup uses the bundled helper or a clearly guided Ollama installation. Real-account qualification is separate from simulated tests. ChatGPT retains per-request disclosure of the complete selected transcript and no paid API fallback.
- [ ] Complete security and account subplan checks, update accurate privacy/user guides, then commit each independently. Do not mark this task complete because a draft policy exists.

## Task 10: Make upgrades predictable and recoverable

**Files:** desktop/src/update.rs (new); desktop/tauri.conf.json; scripts/package-desktop.mjs; extension/manifest.json; extension/src/protocol.ts; server/src/extensions.rs; tests/extension-upgrade.test.mjs (new); docs/desktop-installation.md; docs/extension-publishing.md.

**Interfaces:** Release metadata declares appVersion, extensionVersion, extensionProtocolMin/Max, librarySchemaVersion, target, artifact SHA-256 and signed update metadata. Version checks return `compatible`, `update-app` or `update-extension` without changing data. Existing protocol v1 remains accepted through the additive pairing rollout.

- [ ] Test old extension/new app, new extension/old app, unsupported protocol, revoked credentials, an active capture, pending unsynchronized audio and a newer database opened by an older binary. Recording/export must remain available locally when transfer is incompatible.
- [ ] Use signed Tauri updates for the macOS app; keep the updater trust key separate from library/extension credentials. For the first Ubuntu .deb release, provide a verified download/install action and clear instructions; do not claim an AppImage updater upgrades a .deb. A signed APT channel is a separately scoped future option.
- [ ] Defer app update while active processing/ingest requires it. Back up and migrate schemas transactionally; preserve a recoverable pre-migration copy. Roll back binaries only when schema-compatible or through an explicit verified data restore. Never silently roll back a database.
- [ ] Test unpacked-to-store ID transition without assuming browser storage transfers between extension IDs. Export/synchronize pending audio first, then re-pair if identity changes. Test a subsequent same-ID store update preserves committed audio and credentials; an interrupted active capture must recover rather than claim uninterrupted recording.
- [ ] Add and run `node --test tests/extension-upgrade.test.mjs` plus desktop update tests. Verify signatures, corrupt-download rejection and restart on clean target machines. Commit `feat: add safe application and extension update paths`.

## Task 11: Run complete review, fix and qualification loops

**Files:** docs/extension-qualification.md; docs/extension-review.md; docs/production-release-checklist.md (new); tests/extension-browser.test.mjs; tests/extension-capture.test.mjs; tests/extension-controls.test.mjs; scripts/test-browser.mjs. Save only sanitized, relevant final evidence outside tmp/.

- [ ] Create a checklist tied to exact commit, OS/browser versions and artifact SHA-256. Include the twelve OS/browser/provider combinations, with each cell pass/fail/pending and links to observations. Follow the existing Ubuntu/Codex handoff; unexecuted Linux tests remain pending until the user's results are reviewed.
- [ ] Run the normal Rust, JS, extension, Python and browser checks listed in docs/development.md and .github/workflows/verify.yml, plus new task tests. Check production package contents and CSP/no remote executable code. Automated fixture results do not replace actual provider tests.
- [ ] Human-test the lifecycle: first install/pair; live on/off; tab+mic; provider mute/keyboard mute; unknown detection; device loss; Echo mic exclusion; pause/resume; popup close/tab switch; unrelated-tab sound exclusion; call exit/navigation; import/playback/final transcript/notes; revoke/reconnect; deletion and backup/restore. No camera request at any point.
- [ ] Test offline start, server loss/restart, worker suspension, browser crash, sleep/wake, slow/failed writes, quota/backlog limits, maximum duration, pending export, lost acknowledgements and finalization retry. Measure committed sample counts and silence in excluded segments; a plausible transcript is not evidence of correct microphone gating.
- [ ] Test live overlap/repeated phrases, missing model, slow processing, two workspace tabs and final preemption. Verify native Large V3 and Turbo regressions. Reuse the existing three AMI accuracy results as a baseline; report scores/limitations, do not expand into accuracy optimization.
- [ ] Conduct the five-person beginner test from the spec: at least four complete installation, pairing and a short recording without facilitator intervention or terminal use. Record failures; distinguish model-download time from navigation time. Include keyboard-only, 320px and zoom/theme checks.
- [ ] Have an independent reviewer inspect authorization, recovery, migrations and final diff. Fix material findings, rerun relevant tests and repeat affected human flows until no release-blocking issue remains. Clean session-owned test tabs/processes/scratch after each loop; preserve only useful sanitized evidence. Log a known limitation with its support consequence rather than hiding it.
- [ ] Commit the verified result locally. Push only after applicable agreed gates; retrieve the fresh CodeRabbit review for that commit, distinguish stale comments, fix relevant issues, rerun tests and repush. Keep source/tests within its plan limit, reviewing documentation/evidence separately as the user requested. If review cannot run, record that as pending, not approval.

## Task 12: Prepare and release one store listing for Chrome and Brave

**Files:** docs/extension-publishing.md; docs/extension-store.md; docs/production-release-checklist.md; extension/manifest.json; scripts/package-extension.mjs; artifacts for final release; hosted privacy/support/download content after owner approves its destination.

- [ ] Obtain owner inputs: publisher identity/contact, privacy/support/download URLs, Chrome developer account with required verification, Apple signing/notarization access, store distribution choice and actual store item ID. These are release inputs, not reasons to stop preparing code/docs now.
- [ ] Prepare accurate single-purpose listing and permission justifications, 128px icon, 440×280 promotional image and one to five 1280×800 or 640×400 screenshots. Use actual sanitized UI from the release candidate; list only qualified support and explain the separate local app/model requirements.
- [ ] Prepare reviewer instructions for local-app installation, pairing, synthetic recording, offline recovery and privacy. Provide no real account secrets or private meetings. Confirm data disclosures match shipped encryption, local storage, optional model downloads and explicitly selected cloud notes.
- [ ] Build the allowlisted extension ZIP, inspect it, record its SHA-256 and verify its manifest version. A draft store item assigns the official extension identity; align allowed origins/development public key and retest without treating ID alone as authorization. Account/upload actions require owner approval.
- [ ] Start with a private tester distribution; use unlisted only if anyone with the URL may install. Neither bypasses store review. After owner approval submit with deferred publishing, then install the actual store build in clean Brave/Chrome profiles and complete update/pairing/recovery checks. Store approval alone does not qualify behavior.
- [ ] Release publicly only after the candidate checklist passes and the owner approves publication. Monitor support reports through an explicitly chosen process; keep a known-issues and rollback procedure. Do not create an automation or submit agreements implicitly.
- [ ] Replace development-only primary instructions with verified download/store links once available. Keep unpacked/source setup under the developer path. Document uninstall/export safeguards and how local app and extension updates differ.

## Completion and owner handoff

The deliverable is complete when a nontechnical person can use the tested install-to-transcript path, recordings survive the specified interruptions, upgrades preserve data, both developer and user guides match the shipped version, and supported combinations have evidence. A green build, a ZIP or a store approval alone is insufficient.

The owner ultimately supplies accounts/signing/hosting and approves publication; the Ubuntu desktop supplies real Ubuntu evidence. Work can proceed on all independent implementation tasks before those inputs are available. If a capability remains unqualified, explicitly limit the release scope and seek the owner's agreement rather than quietly dropping it from the plan.

## References checked October 9, 2026

- [Chrome/Brave publishing steps and current release gaps](../../extension-publishing.md)
- [Chrome user data policy FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Tauri distribution](https://v2.tauri.app/distribute/) and [signed updater](https://v2.tauri.app/plugin/updater/)
- [Google installed-application OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

Recheck external release requirements at execution/submission time. These references inform the proposed design; they do not certify this build.
