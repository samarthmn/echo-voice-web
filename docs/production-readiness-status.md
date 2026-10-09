# Web and extension readiness record

**Current scope: Echo's local web workspace and Brave/Chrome extension only.** On October 9, 2026 the owner withdrew the desktop app requirement and requested removal of all installer work. That instruction supersedes A7 and the desktop-specific parts of the earlier [implementation plan](superpowers/plans/2026-10-09-production-readiness.md).

The existing optional native Large V3 speech helper remains part of the local web server. It is not a meeting browser or desktop app. OS credential-store support remains necessary for the approved encrypted-library design. No Docker, native meeting runner, Tauri launcher, application installer, Apple signing or notarization is required for this release.

Branch: `codex/large-v3-speakers-dark-mode`, PR #2. The earlier published baseline is `3eb45966017ec18247eb51d2cb46d455668f6c5c`. Local implementation/documentation checkpoints `3bf60b6` and `3447f2c` preceded the scope correction; their desktop work has been removed from the final tree. They have not been pushed. Nothing is publicly released.

## Current checklist

| Area | Owner | Status and evidence |
|---|---|---|
| Requirements | Codex | Web/extension scope confirmed; desktop requirements withdrawn |
| Interface | Codex | Shared controls, concise copy, first-transcript guidance, themes and responsive layouts implemented; affected checks rerun after scope correction |
| Pairing | Codex | Connect → approve once → connected implemented, including persistent attempts, cancellation, lost acknowledgements and library ownership |
| Recording/recovery | Codex | Encrypted PCM journal, offline recovery, transfer acknowledgement and microphone safeguards retained |
| Library protection | Codex | SQLCipher, authenticated audio/credentials, OS-held keys, recovery phrases, encrypted backups and schema compatibility fence retained |
| Desktop installers | — | Removed at the owner's request; no release dependency |
| Calendar | Codex | Retain configured Web OAuth with the same-origin callback, PKCE, encrypted tokens and read-only access; remove Desktop OAuth and packaged credentials |
| Speech/notes | Codex | Existing Turbo/native Large V3 and optional notes workflows retained; accuracy optimization excluded |
| Documentation | Codex | Current guides/site rewritten for the web and extension; historical plans explicitly superseded |
| Review/CI | Codex | Local regression and independent rollback review passed; push and fresh CodeRabbit remain pending |
| Distribution | Codex + account holder at restricted steps | Extension ZIP/listing/assets and web privacy/support pages prepared; actual store identity, hosting and publication pending |

## Scope correction and cleanup

- Removed the desktop workspace member, launcher code, native packaging/signing scripts, installer-specific tests/workflow, generated Mac app bundles and notarization archive.
- Removed installed-runtime control sockets, Desktop OAuth configuration, packaged-resource assumptions and GUI library-copy/update paths. Preserved the web server's explicit recovery/validation commands and encrypted backup validation.
- Removed current desktop installation/signing instructions and desktop-only evidence. Historical approval documents identify the scope change instead of presenting withdrawn work as planned delivery.
- The installer-only **Echo Voice Desktop** Google client was deleted in the approved project; Google's UI offers recovery for 30 days. The pre-existing **Echo Voice** Web application client remains. No project-wide Google authorization was revoked.
- Deleted the private Desktop credential build input and generated copies. No credential was committed. Test libraries, their owned Keychain entries and controlled account tabs were cleaned up. Apple's pre-existing signing certificates are unchanged. Nothing was submitted for notarization or publication.

## Verification

The [web-only verification record](../artifacts/readiness-2026-10-09/web-only-verification.json) covers the scope-correction working tree committed with this document. Results obtained before the scope correction remain prior evidence, not a pass for removed features or the new final tree.

| Check | Result |
|---|---|
| Web-only Rust server/app | Full source release/WASM build passed; server 80 passed / 1 native-volume test ignored; app 10 passed; formatting and strict server Clippy passed |
| Core JavaScript/REST/native helper | Current run: 159 JavaScript tests plus 3 shutdown/cleanup regressions, 10 native HTTP tests, 26 ChatGPT protocol tests, 13 protected-storage/pairing/Web OAuth checks passed; release fixture-key rejection passed |
| Extension | All 165 tests passed in isolated Brave, including actual extension/server pairing, encrypted journal recovery, transfer and popup layout |
| Browser workflows | Full isolated Brave suite passed: recording/import/retry, review/version history, settings/backup/recovery, optional notes, Web Calendar, onboarding and 52 accessibility states without findings. A premature test-server shutdown was fixed and the complete suite rerun passed; owned encrypted test storage was safely detached and removed |
| First-use UI | Current 10 app tests and isolated Brave onboarding scenarios passed, including light/dark 320px layouts. Earlier Chrome/spacing evidence remains separate; [Overview screenshot](../artifacts/readiness-2026-10-09/first-transcript.png) shows the retained web UI |
| Encryption review | Independent findings fixed: vault revocation race, authenticated journal ownership, import verification before deleting browser PCM, legacy capture/key safeguards and retained encrypted helper data with missing key metadata |
| Three AMI datasets | Existing scores and provenance limitations retained; no accuracy optimization or new accuracy claim |
| Documentation/site | Web-only review: 49 Markdown files and 328 local links/anchors checked without failures; site preview rebuilt; three extension images regenerated and visually checked |
| Extension ZIP | Rebuilt allowlisted package at `artifacts/echo-extension-0.1.0.zip`; no native application runtime or private credential included |
| Existing PR review | 18 existing inline threads resolved at published baseline; no fresh review on local changes claimed |

Independent rollback review found no actionable code regression. The real Brave workspace showed the revised optional Calendar/Web OAuth guidance and current extension setup instructions; owned browser tabs and the synthetic smoke library were closed/removed. No real account authorization was performed in this smoke test.

The current source dependency audit reports five moderate advisories in the `onnxruntime-node` installation dependency chain (`global-agent` / `roarr` / `sprintf-js`). No zero-vulnerability claim is made, and the removed desktop packager is not a mitigation for the source build. Dependency remediation remains part of release review.

The development host is Apple Silicon macOS 27.0.1, Brave 154.1.96.61 (Chromium 154.0.8037.98), Rust 1.96.1. This does not establish every browser, OS and meeting-service combination. The live installed-mode Calendar test belonged to the withdrawn desktop work and is not used as web-client qualification.

## Remaining release gates

- The web-only rollback has passed local regression/review. Complete the broader authorized push/CI/CodeRabbit cycle after remaining agreed release checks; keep review-service limits explicit.
- Record Brave/Chrome × macOS/Ubuntu × Meet/Zoom Web/Teams Web qualification individually. Existing bounded Meet evidence does not fill untested combinations.
- Complete actual extension installation/update, microphone/offline/recovery/live-text scenarios and first-time usability participation. Codex owns testing; humans provide only unavailable access, authentication and physical participation.
- Configure verified publisher/store/hosting access and Google public audience/verification as needed. Publisher: Samarth; support: samarth.m.n@gmail.com; intended site: echovoice.samarthmn.com.
- Get approval of the concrete candidate before store submission/publication. No installer or Apple developer enrollment is part of these gates.
