# Production readiness execution record

Approved plan: [Codex implementation](superpowers/plans/2026-10-09-production-readiness.md). [Human-only dependencies](superpowers/plans/2026-10-09-human-tasks.md). Implementation authorized October 9, 2026 after review. This record reports evidence, not release promises.

Baseline: `3eb45966017ec18247eb51d2cb46d455668f6c5c` on `codex/large-v3-speakers-dark-mode`, PR #2. Existing recording, recovery and processing code is retained and reverified. Documentation drafts from planning are now authorized for review/integration. No publication is authorized until the release candidate is approved.

| Task | Owner | Status | Evidence / dependency |
|---|---|---|---|
| A1 Requirements and existing work | Codex | Reconciled | Baseline, prior review and all approved tasks reconciled; active checks recorded here |
| A2 Shared components and layout | Codex | In progress | Shared workspace/extension tokens retained; launcher aligned; 320px workspace, 390px popup, zoom and theme checks pass; fresh native launcher inspected |
| A3 Persistent approved pairing | Codex | In progress | Connect/approve/automatic activation implemented; persistent cancellation and lost-ack handling tested |
| A4 First meeting guidance | Codex | In progress | Capability-derived first transcript guidance, model readiness and concise next actions implemented; isolated Brave/Chrome tests passed. First-time human study pending |
| A5 Capture, recovery, processing | Codex | Automated regression passed; live matrix pending | Full isolated Brave lifecycle passed. Existing bounded live Meet evidence is not a fresh full qualification |
| A6 Protected storage and recovery | Codex | Automated and independent review passed; installed qualification pending | SQLCipher, authenticated audio, encrypted browser journal, phrases and backups integrated. Independent findings fixed and re-reviewed, including retained encrypted helper files with missing key metadata. |
| A7 Installed Mac/Ubuntu runtime | Codex | In progress | Native Mac development build, bundled runtime, private lifecycle IPC, copied-library validation and recovery implemented; signed/clean-machine Mac and real Ubuntu qualification pending |
| A8 Integrations and safe updates | Codex | In progress | Schema compatibility fence and verified Mac pre-update snapshots implemented and reviewed; Ubuntu manual updates require an explicit backup. Signed updater remains disabled in unqualified builds. Real OAuth exchange and update qualification pending |
| A9 Documentation | Codex | Reviewed local drafts | 334 documentation links/anchors and 44 built-site references checked; 16 Brave site renders pass. Current Overview desktop/mobile captures replace stale artwork. Final instructions must match signed candidate |
| A10 Full review and qualification | Codex | Review/fix loops active | Local results below; real Ubuntu access and full live matrix pending |
| A11 Commit, push, CodeRabbit | Codex | Implementation committed locally | Implementation/tests in `3bf60b6`; documentation commit follows. Existing PR's 18 threads are resolved, but no fresh pushed review is claimed. |
| A12 Distribution | Codex | Materials prepared; candidate pending | Publisher facts confirmed; listing, privacy/support site, icons, promotional art and genuine setup screenshots prepared. Signing/hosting access and tested-candidate approval remain dependencies |

## Implementation decisions and overlap checks

| Tasks / boundary | Decision and consequence |
|---|---|
| A1–A12 versus current branch | Work on the already-requested feature branch. Do not replace the user's checkout or discard draft changes. |
| A2/A3/A4 extension files | One extension agent owns pairing state, setup and popup; storage work must coordinate integrations. |
| A3 server versus A6 storage | Pairing agent owns extension router first. Storage/security changes enter after its interface is reviewed. |
| A7 runtime versus A6 storage | Runtime agent owns path resolution and launcher; encrypted library code preserves its resource/data separation. |
| A6 approved behavior versus older written spec | Latest approved automatic unlock plus offline recovery phrase supersedes the older open-design text. No camera/native messaging/profile copying is introduced. |
| A9 docs versus A10 tests | Describe shipped behavior only after fresh tests; intended support stays distinct from qualified support. |
| A11/A12 approvals | The user authorized implementation and eventual gated push. Store publication still needs candidate approval; external account approvals do not move operational work to the user. |
| Scratch versus skill defaults | Use only project tmp/readiness-2026-10-09 for controller scratch; retained evidence belongs in docs. |

## Results

No release-ready claim yet. Implementation/tests were verified and then committed as `3bf60b6`; final source checks covered the same unchanged source bytes. This identifies the engineering checkpoint, not a qualified public release. The development host is Apple Silicon macOS 27.0.1 (26A434), Brave 154.1.96.61 (Chromium 154.0.8037.98), Rust 1.96.1. The installed runtime pins Node 22.23.3. This host does not establish macOS 14 compatibility.

| Verification | Result and scope |
|---|---|
| Rust server + desktop + app | Final aggregate: 124 passed (85 server, 29 desktop, 10 app), one native encrypted-volume test excluded from the routine run and passed separately on this Mac. Calendar tests include PKCE exchange/refresh with a synthetic Desktop credential. Source remained unchanged during the final run. |
| Application JavaScript and REST | 159 passed; subsequent credential/recovery and independent backup-decoder regressions: 28 passed. |
| Extension | 164 passed, including actual isolated Brave MV3/IndexedDB, one-approval pairing, encrypted history/restart, corrupt-import retention, layouts and live scheduling. Final focused run: 91 pairing, vault, actual browser storage, capture/control and recovery regressions passed. Production ZIP contains 21 allowlisted files and no test/private-data paths. |
| Native speech HTTP + AMI score provenance | 10 native HTTP tests and 8 AMI reproduction tests passed. No accuracy optimization or new live accuracy claim. |
| Full isolated Brave workflows | Recording, pause/mute/resume, source end, upload retry, imports, processing eligibility, search, Calendar unavailable state, backup/recovery, review/version history, optional account fixtures and mobile navigation passed. 52 page accessibility states had zero automated findings. No real account or inference request in mocked account flows. |
| Calendar desktop integration | Four installed-mode HTTP tests and 12 mocked Brave UI scenarios passed. Private packaging input supports Google's required Desktop credential with strict bounds, fixed HTTPS token endpoints and no secret in authorization URLs/status/logs. Inherited web-client overrides are ignored. Legacy or revoked credentials remain recoverable and prompt reconnect. |
| Protected storage and runtime boundaries | 7 tests passed for authenticated playback/wrong keys, installed resources/foreign cwd isolation and launcher controls. Pairing HTTP coverage is included in the extension count. |
| Packaging/signing preparation | 17 scoped tests passed across the packaging/signing/launcher suites; independent signing/package re-review passed 11 tests. Native runtime contains 1,882 inspected files before later public OAuth descriptor integration, has no `sprintf-js`/`global-agent`/`roarr`/installer `tar`, and imports the native speech engine and helper successfully. Signing is not yet performed. |
| Native launcher through Computer Use | Opened isolated library in existing Brave, checked browser choice, recovery form/cancellation, disabled update action, tab-close behavior and clean quit. See [actual launcher screenshot](../artifacts/readiness-2026-10-09/mac-launcher.png). No real library or credential store was used. |
| Workspace through Computer Use | Settings/Storage, light and dark appearance, navigation and 320px width inspected; no horizontal overflow. [Storage screenshot](../artifacts/readiness-2026-10-09/storage-light.jpg). |
| First-use guidance | Ten app Rust tests and isolated Brave/Chrome first-use scenarios pass, including 320px light/dark, denied microphone, missing/different/ready model, download recovery, saved-recording next action and removal after the first final transcript. Actual Brave review caught and fixed the guide's section gap; the retest asserts at least 24px spacing. [Current first-use screen](../artifacts/readiness-2026-10-09/first-transcript.png). No automatic model download or permission request. |
| Documentation/site | 334 local Markdown references/anchors and 44 built-site routes/assets valid. Four pages × two widths × two themes: 16 isolated Brave renders; no horizontal overflow or Axe WCAG2A/AA/2.1AA findings. Current genuine desktop/mobile Overview captures include source/image provenance and verified 24px section spacing. Draft only. |
| Formatting/lint | Rust formatting, strict server/desktop Clippy with all targets and diff checks passed. Rerun after Calendar integration passed. Current release server also passed the fixture-key rejection test before creating a database. |

### Independent review fixes

- Async vault unlock can no longer resurrect a disconnected/revoked identity; invalidation is one atomic session-storage update, including worker termination races.
- Clear journal ownership/receipt fields can no longer override authenticated recording metadata.
- Complete import acknowledgement authenticates every audio block and its manifest digest before browser audio is removed. Actual server/Brave corruption testing confirms retained PCM.
- Legacy meeting IDs use the existing safe-ID rules; path traversal and non-UUID extension identities remain rejected.
- Active legacy capture and unresolved start markers are checked before key creation/database conversion. Finalized legacy audio is authenticated across all blocks.
- Library copies preserve client-scoped ChatGPT credentials and fail safely on conflicts. Damaged optional Google credentials and recovery envelopes now fail validation before selection; independent re-review accepted these fixes.
- Desktop packaging includes the lazily imported speech error module; copied encrypted legacy sessions reach server verification; a second launcher re-reads the authoritative selected library after acquiring ownership.
- Signing checks the staged server’s production key policy before accessing the signing identity; development fixture-key acceptance prevents signing. Google publisher configuration stays in a private ignored build input; the checked-in template is unconfigured. Desktop credentials in a native package are extractable and are never treated as proof of user identity.
- Calendar denial/cancellation preserves prior credentials; expired or revoked credentials show reconnect, and a late response cannot invalidate a newer connection.
- Protected prerelease builds with both prerelease and build metadata remain compatible; older apps still receive no recording metadata or PCM without protection capabilities.
- Missing library key metadata now rejects retained encrypted ChatGPT auth/history before creating a replacement key or database. Six focused protected-storage tests and independent re-review passed; plaintext legacy migration remains available.
- Mac update preparation completes fallible runtime checks before stopping the server. Snapshot or installation failure preserves the verified backup and restarts the prior server. Newer or corrupt library schemas are rejected before writable opening or migration.

### Dependency review

The source npm audit has five moderate entries from one [unbounded-format-precision advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) in `sprintf-js <=1.1.3`; the advisory lists no patched release. The path is ONNX's npm installer → `global-agent` → `roarr` → `sprintf-js`. The pinned ONNX runtime imports `onnxruntime-common`; only its installer uses the flagged chain. Builds disable install scripts. Desktop packaging now computes the inference dependency closure, removes installer-only packages and the unused installer, checks that the flagged package is absent, and runs the bundled engine/module smoke. The source lock remains unchanged for these dependencies; this is a verified packaged-runtime mitigation, not a claim that the source audit is clean. Reassess the exclusion when changing ONNX's version.

### Remaining gates

- Installed Calendar configuration and PKCE are implemented and independently reviewed. The approved Desktop client was created in the Echo Voice project. The first real exchange exposed Google's required Desktop credential parameter; validated private packaging support corrected it. After the authorized user created the credential, real Brave consent, token exchange, Calendar refresh and server-restart persistence passed for the approved test account, using OS-Keychain-backed storage. The saved Google credential file had the authenticated encrypted format. Disconnect removed the isolated library's saved credential. The owned test server, browser tab, library and Keychain entry were cleaned up; the approved private publisher build input remains available for packaging. Google branding/public verification remains pending.
- The current configured release-mode Mac app bundle and pinned speech-runtime smoke passed; exact rebuilt hashes and source inventory are in [packaging evidence](../artifacts/readiness-2026-10-09/macos-release-packaging.json). Developer ID identity confirmation, signing, notarization, actual installed Large V3/account qualification and clean-machine installation are pending. Later source fixes require rebuilding and repeating affected checks.
- Brave/Chrome × macOS/Ubuntu × Meet/Zoom Web/Teams Web cells remain individually pending unless their own current evidence says otherwise. Synthetic browser tests do not fill those cells.
- Ubuntu desktop access and five first-time participants remain human-only dependencies with prepared Codex instructions.
- Real store identity/install/update, hosted pages, updater release trust and approved publication are pending.
- Implementation/tests are committed locally; push and fresh CodeRabbit review remain pending the agreed gates. The existing PR is still at `3eb4596`, with 18 resolved review threads. Native packaging and verification CI configuration are prepared; no remote pass on the new implementation is claimed.
