# Independent extension runtime review — 2026-10-05

Reviewer: server implementation agent, independently reviewing runtime authored by the runtime agent. No runtime/server implementation edits or commits made during this review. Only review scratch and this requested report were written. Scope: `extension/**`, manifest/pages/UI, build/package scripts, runtime/capture/browser tests, approved browser-extension spec and runtime owner report.

## Final verdict

No remaining concrete runtime defect found in the final reviewed source. Six actionable defects found during review were fixed by the runtime owner and independently rechecked. Automated validation passes: 20 runtime/capture tests and two actual unpacked Brave tests, including real isolated Echo pairing, ingestion and verified completion. Final release ZIP matches all 21 unpacked assets.

This verdict does not qualify real meeting capture or a browser/provider/OS combination. The human qualification matrix remains pending, as listed below. The browser test now proves real HTTP transfer; it does not prove tabCapture audio or live provider controls.

## Findings and disposition

Line references below identify the current fix sites; all findings are resolved.

| Priority | File / lines | Finding, fix and independent evidence |
|---|---|---|
| P1 | `extension/src/background.ts:75-78`, `core.ts:31-34`, `setup.ts:43` | Pairing required string `expiresAt`, but the Rust server sends integer Unix seconds; every actual pairing request failed validation. Runtime now validates integer seconds and converts to milliseconds only for UI. Independent server-shaped fixture succeeds and real Brave requests/approval/claim complete against the Rust server. |
| P1 | `extension/src/background.ts:28-41,110-122`, `offscreen.ts` GATE branch, `worklet.ts` gate branch | Older unmuted observations could cross asynchronous owner restoration/persistence and replace newer muted observations. Gates also lacked recording identity. Runtime now synchronously advances observations, rechecks observation ownership after awaits, serializes gate publication and fences each gate by recording ID plus increasing revision in offscreen/worklet. Independent reversed owner-restore completion fixture emits only `allowed:false`; worklet/capture tests reject old revisions and wrong recordings. Expiry remains enforced independently by worklet sample clock and absolute deadline. |
| P1 | `extension/src/offscreen.ts:14-18`, `background.ts:99-102`, `ui.ts:15,22`, `setup.ts` refresh/export | Quota failure could stop capture while failure metadata also failed, leaving a readable PCM prefix labelled `recording`. The old UI hid Export and dropped the recovery error. Runtime now surfaces recovery errors and treats inactive stale capture rows as interrupted for display/export. Independent quota+metadata-failure injection confirms inactive capture, retained chunk and recovery error; actual browser renders Export for an inactive row still labelled recording and exports its interrupted timeline. |
| P2 | `extension/src/protocol.ts:55-74` | A newer unreachable recording/library consumed every transfer pass, permanently starving older healthy library audio after the pass budget was introduced. Runtime now rotates attempt order, prioritizes active capture and backs off unavailable/revoked libraries. Independent two-library fixture: newest endpoint consumes a simulated 16-second timeout; older healthy library completes on the second pass. Final checked-in test additionally covers unreachable active library priority. |
| P1 | `extension/src/protocol.ts:6-11,50`, `tests/extension-browser.test.mjs:71` | Actual privileged Brave GET omitted Origin; server rejected completion verification with403 even after all65chunks completed, so local PCM could never be purged safely. Explicit Origin derived from validated trusted `chrome.runtime.getURL('')` now accompanies requests. Server origin middleware remains unchanged. Independent actual Brave/server test confirms completed manifest, matching receipt and PCM removal. Original failed verification correctly retained PCM. |
| P1 | `extension/src/background.ts:10`, `manifest.json` minimum120, `tests/extension-runtime.test.mjs:133` | Background used `chrome.offscreen.hasDocument()` despite minimum Chromium120. Current official API documentation labels this method Chrome150+, while runtime.getContexts is available116+. Replaced with exact offscreen-URL runtime.getContexts helper. Static regression and actual Brave rerun pass; official API version check substantiates compatibility choice. No Chromium120 binary was run. |

The official API references checked were [Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) and [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture). The offscreen boundary uses only chrome.runtime; service-worker stream IDs may be consumed in offscreen documents since116. Tab playback restoration follows the documented separate MediaStreamSource connection.

## Security and lifecycle review

- Manifest grants MV3 runtime/audio/storage capabilities; meeting hosts are optional and provider-scoped. Loopback endpoint parser accepts exact HTTP localhost/127.0.0.1/[::1], rejects credentials, nonroot path, query/hash and lookalike hosts. No externally_connectable, web-accessible resources, static content bridge, remote code, camera request, native messaging or account/session extraction found.
- Settings restrict chrome.storage.local to trusted contexts before reading/storing credentials. Session access is likewise trusted. Public STATE deliberately omits credential pairs. Only exact bundled popup/setup pages can issue Start/control/pair actions. Only exact offscreen URL obtains trusted settings; offscreen authenticates own extension ID, absent sender.tab and exact background.js sender URL. Browser test verifies that real service-worker sender URL and rejects setup-page settings RPC.
- Content is an isolated one-way observer, never receives credentials, endpoints or PCM. Top frame/document ID/URL equality/sequence/freshness checks bind observations. No window-message/request bridge found. Real provider DOM adapters are conservative English selectors: missing, ambiguous/localized, prejoin and ended results exclude microphone. Selector correctness in real providers remains unqualified.
- Start binds a tab ID and canonical meeting identity, explicit consent, chosen mic and local recording ID. Tab stream uses audio-only constraints. Microphone acquisition is separate, explicit and video:false; denial requires a tab-only retry. Mic connects only to the worklet, while tab playback has a separate speaker connection. Mic disconnect revokes inclusion without stopping healthy tab audio. Navigation/document/identity/tab-ended paths stop or interrupt capture; popup closure and another active tab do not switch ownership.
- Gate freshness is two seconds. Old observations cannot renew it; delayed worklet gates include original absolute expiry, and revision/recording checks prevent reordered or prior-recording unmute. Resume resets mic inclusion before fresh gates.
- Worklet resampling maintains phase across blocks, produces mono PCM16 little-endian16kHz and fixed headroom. Autonomous worklet generation stops at80,000 frames not acknowledged by IDB, independently of renderer scheduling. Offscreen bounds its queued frames and cleans up tracks on persistence failure.
- IndexedDB strict transactions atomically commit PCM, sequence, hash, frame totals and global pending bytes. Only completed transactions acknowledge worklet persistence. Eight-hour and2GiB checks retain the committed prefix. Pause flushes before changing state; gaps use frame position plus pause duration. Recovery marks interrupted without automatic capture restart.
- Network sends committed chunks, fences recording/library/cursor acknowledgements and retains PCM on conflict/deletion/wrong ownership or ambiguous completion. An independent matching complete status precedes atomic receipt retention and PCM deletion. Old library credentials and recording association are retained when a new library is confirmed. Network request timeout is15seconds; the five-second transfer cutoff is checked between requests and may be exceeded by an in-flight request. Capture persistence is independent of transfer.
- Offline export checks per-chunk hashes, yields sequential WAV parts at most30minutes and includes frame/gap timeline. UI does not automatically discard unsynchronized PCM. Build/package use a fixed21asset production list, reject symlinks/unexpected executable output and exclude private stale files. Final ZIP/dist match, with trusted-origin, revision and getContexts fixes present in built JS.

## Independent verification commands and exact results

All scratch was under `tmp/extension-runtime-review`. To avoid colliding with the runtime owner's tests, runtime/browser test files were copied unchanged except absolute repo/import paths and the scratch directory name. Capture test was run directly. These copies have since been cleaned after preserving results here; original checked-in tests are equivalent and reproducible with a project TMPDIR.

1. `TMPDIR="$PWD/tmp/extension-runtime-review" node --test tmp/extension-runtime-review/extension-runtime.test.mjs tests/extension-capture.test.mjs`

   Final result: tests20, pass20, fail0, skipped0, duration218.013ms. Covers expiry, exact host/endpoint, freshness, conservative adapters,44.1/48kHz resampling/headroom, stale/wrong-recording worklet gates,80,000frame backlog, lost completion response, wrong library/conflict retention, bounded turns, unavailable-active-library fairness, manifest boundaries, strict packaging, offscreen trusted runtime boundary, both source routing, permission denial, mic disconnect, pause/gaps, quota and quota+metadata failure.

2. `TMPDIR="$PWD/tmp/extension-runtime-review" node --test tmp/extension-runtime-review/extension-browser.test.mjs`

   Initial sandbox launch aborted with SIGABRT/EPERM; not treated as a product failure. The same isolated test was rerun with approved sandbox escalation. Final result: tests2, pass2, fail0, skipped0, duration7133.210875ms. First test834.750584ms; second3123.97575ms.

   Actual unpacked extension/Brave evidence: service-worker/offscreen runtime messaging, credential RPC denial, actual IDB PCM commit/duplicate rejection, reload+explicit interruption recovery, stableSHA256, WAV header/length, receipt ownership, bounds, inactive stale-row Export and interrupted timeline. Second test launches an isolated real Rust Echo server and uses real setup pairing UI, same-origin approval, pending claim then approved claim,65strictly committed1-secondchunks, complete status/receipt matching1,040,000frames, local PCM removal and same-origin imported meeting lookup. Synthetic audio and isolated profiles/libraries only. No everyday browser profile, real meeting or account was used.

3. Independent delayed observation and expiry fixture: bundled current background with controlled owner-restore promises, reverse completion of unmutedseq1/mutedseq2; output `Latest fix passes: delayed older unmuted observation cannot replace newer muted gate.` Server numeric expiry fixture output `Latest fix passes: server-shaped numeric expiry is accepted and adapted to UI milliseconds.` Both assertions pass on final getContexts helper.

4. Independent two-library timeout fixture: newest offline-library request advances virtual clock16seconds and fails; healthy older library accepts exact manifest. After two passes output `Latest fix passes: older healthy-library recording completes on the second pass despite newest library timeout; backoff and attempt rotation prevent starvation.`

5. Release read-only comparison: every ZIP entry equals corresponding `extension/dist` asset; all21assets match. Minimum Chromium120. Unpacked `background.js` SHA256 `dc30ec53895c3159c3e797896c75a7107bd1561365bf2fd379960e3d762f55a6`; reviewed `protocol.ts` SHA256 `42064b1ef7cf8eaf9729ded4eda387c7ad56ccf071c35560a2d62389ae425c2c`.

Environment: macOS27.0.1; Brave installed CFBundleShortVersionString154.1.96.61, bundle version196.61. Stable extension ID `poonbmodjfijfbfiopememgfijahgbag`. Review was of shared uncommitted implementation; no immutable commit hash yet.

## Qualification gaps and practical limits

These are release qualification gaps, not additional confirmed code findings:

- No real toolbar Start/activeTab invocation/tabCapture stream plus offscreen getUserMedia was exercised. Media-routing tests use a mocked AudioContext, media devices and worklet. Actual browser tests seed synthetic PCM directly into IDB. Human permission/user gesture handling, both audible sources, speaker playback and echo behavior remain pending.
- Real Meet/Zoom/Teams English mute controls, shortcuts, prejoin/leave/navigation and background throttling remain pending. Unknown/localized controls intentionally exclude microphone. No provider/browser/OS combination should be labelled live-qualified on these tests.
- Real browser crash/whole-browser restart/offscreen destruction, worker suspension/restart, sleep/wake and physical device unplug remain pending. Browser recovery test uses page reload and explicitly calls markInterrupted; it is not a browser-crash test. Durable-prefix/backlog/quota failures are meaningful synthetic injections; physical disk-full/power-loss was not tested.
- Brave/macOS actual MV3/IDB/HTTP wire passes. Chrome, Ubuntu, minimum120 binary and store-installed package identity remain unrun. API compatibility choice is documented/static, not a120binary result.
- Eight-hour/twoGiB boundary tests set metadata to limits; they do not record8hours or allocate2GiB. Sequential30minute export implementation was reviewed, but long-duration browser memory and wall-clock performance were not qualified.
- Native LargeV3 live/final scheduling, actual meeting recordings through final ASR, provider Calendar matching, cross-library backup/restore and normal upload/in-person regression are outside this independent runtime review and belong to controller/server/live validation. Active microphone exclusion during a running capture was explicitly deferred by root; tab-only choice is present before Start.

The runtime owner final report was consulted. The final report correctly distinguishes actual wire transfer from pending real meeting/audio qualification.

## Cleanup

Isolated Brave contexts and Echo test process were closed by test finalizers; browser profiles/libraries were removed. Reviewer scratch copies, fixtures, logs and bundles in `tmp/extension-runtime-review` were removed after writing this report. This requested review report and the earlier requested server report remain for controller review. No implementation file edits, commits or pushes were made during review.
