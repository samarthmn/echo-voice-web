# Independent live-task review

Verdict: **changes required** for specification compliance and code quality. No critical findings; three important findings. Reviewed the binding spec, implementer report, captured live diff, actual live controller/inference worker/controller, and interacting server lease/draft/final-save definitions. No production files changed. The reported unchanged 89-test suite was not rerun. Three small in-memory reproduction fixtures exercised gaps absent from that suite.

## Important: obtain the durable draft after acquiring ownership

Location: `web/extension-live.js:207-209` (the recording snapshot is read at lines 177-179). Interacting server behavior: `server/src/extensions.rs:983-995`.

The controller acquires its lease after reading the draft, then initializes its session using the earlier snapshot. A previous owner can advance the durable draft while the GET reply is delayed, and its lease can expire before the new owner obtains a generation. The new owner then preserves only words committed in the older snapshot. Because the server permits equal/forward cursors without protecting existing committed words, its next draft can permanently replace previously committed words.

Targeted reproduction: the GET snapshot contains throughFrame=20 s and the word `first`; before granting the new lease, durable state advances to throughFrame=35 s with `first` and `already committed second`. The new controller reprocesses 15-35 s from the old snapshot with an empty result. The server's actual cursor acceptance rules permit the 35 s write, leaving only `first`. This violates recovery and immutable temporal ownership.

Reload the durable recording/draft after the lease grant, with lifecycle/session fencing, or return the authoritative draft atomically with the lease. Protecting already committed words in the server provides defense against stale acknowledgements too. The live-side ownership race is a blocking finding; server guard changes require coordination with its owner.

## Important: a recording leased elsewhere starves every later ready recording

Location: `web/extension-live.js:197-210`.

The scheduler selects the first ready recording and returns immediately when its lease request reports 409. If that recording is processed by another Echo tab, every subsequent poll retries the same recording, and a second recording with a complete window and a free lease is never considered. The existing test covers an earlier recording without enough audio, but does not cover lease contention.

Targeted reproduction: two ready receiving recordings; the first lease always reports 409 and the second lease would succeed. Four polls requested `[first, first, first, first]`, with zero PCM requests. The second state remained `waiting-audio` indefinitely. Attempt other ready candidates after a recording-specific lease conflict, with bounded backoff/fair scheduling so another owner can continue its recording independently.

## Important: pending HTTP requests disable the lease-expiry cancellation path

Location: `web/extension-live.js:112-115` and `225-229`; requests at `94-97` have no deadline.

If a recording-list GET remains pending, `polling` prevents the one-second timer from entering `tick`. If a renewal request also remains pending, the `renewing` guard returns before checking local lease expiry. There is no independent expiry watchdog. Consequently an active ASR operation and its prepared PCM remain alive beyond the lease deadline when Echo hangs or the connection stalls. Fenced writes still prevent stale persistence, but the required lease-expiry cancellation/resource release does not happen.

Targeted reproduction: initial grant expires at 1,060,000 ms; start an active pending inference and prepared window; leave subsequent GET and renewal pending; advance the clock to 1,070,001 ms; invoke renewal again. The controller still reports the expired lease, active job, and prepared audio, and no cancellation was called. Check expiry independently of pending requests, and bound network calls so stale promises cannot indefinitely monopolize polling/renewal after cancellation.

## Requirements verified by inspection

- Dedicated warm Turbo ASR worker; live handler bypasses speaker models and validates actual word timestamps and model revision. Normal native Large V3 speech/diarization path is preserved.
- Live cancellation is job scoped and does not advance normal inference generation or cancel native/final/download jobs. Normal processing preempts the dedicated live runtime.
- Full 20-second windows, 15-second stride, midpoint ownership at end minus 2.5 seconds, entire provisional-tail replacement, and a maximum of one prepared window are present.
- Same-origin bounded PCM uses redirect rejection and exact byte-length validation. Model loading is cache-only; absent model produces a paused state without automatic download or cloud fallback.
- Wire lease expiry is seconds, renew interval is ten seconds, server grants sixty seconds, generation fences writes. Normal ambiguous acknowledgement recovery reloads the list before retrying, subject to the ownership race above.
- Controller retains draft on final preemption/failure. Server final transcript save clears it only after successful transactional save; completion keeps it until then.

## Cross-boundary scope

Root's import/UI/automatic-final wiring is outside this task review. Current `web/bridge.js:184-185` installs the live controller. Server preemption and successful-final cleanup definitions were inspected solely to validate live draft behavior. The stale-draft race needs coordinated live/server ownership changes if server-side protection is added. Real Turbo throughput and browser/service/OS capture qualification remain pending as the implementer report states.

The requested review report is intentionally retained here for integration; no other scratch files were created.
