# Live scoped re-review — round 1

Verdict: **changes required** because of one newly introduced Important cross-boundary regression. All three original findings are **ADDRESSED**. No new Critical findings.

Scope: the original three findings and breakage caused by their fixes. Read the appended live report, full live-rereview package, current live controller, new regression tests, and interacting server lease/draft code. The reported focused 48 and broad 97 tests were not rerun.

## Original findings

1. **ADDRESSED — authoritative draft after ownership acquisition.** `web/extension-live.js:236-244` initializes only from grant metadata, rejects absent authoritative metadata, and updates the scheduling record. `server/src/extensions.rs:956-981` reads and returns the draft/totalFrames under the same database lock as the generation grant. The stale-list regression at `tests/extension-live.test.mjs:112-130` verifies resumption at 30 s from an authoritative 35 s draft and preservation of both committed words. The added server immutable-word protection needs the correction below.

2. **ADDRESSED — recording-specific lease contention.** `web/extension-live.js:224-254` filters bounded per-recording backoff and tries subsequent candidates after a conflict. Tests at `tests/extension-live.test.mjs:162-189` cover the two-ready-recording case and the ten-second retry deadline. This removes the original indefinite starvation caused by an occupied first lease.

3. **ADDRESSED — expiry despite pending HTTP operations.** `web/extension-live.js:96-107` races every request against abort and an eight-second deadline, including transports that ignore AbortSignal. Lines 116-125 provide an independent watchdog and expiry timer; lines 135-146 check expiry before the renewal guard and before accepting a late renewal; lines 269-282 check before the polling guard and schedule independent checks. Expiry increments lifecycle, aborts all live work and pending requests, drops prepared PCM, and prevents late responses from reviving the old session. Dedicated tests exercise hung GET/renewal, expiry deadline, delayed extension replies, deadline recovery, and stale GET replies.

## New Important regression: immutable-prefix validation rejects valid temporal merges

Location: `server/src/extensions.rs:1055-1064`; interacting client merge at `web/extension-live.js:33-35`.

The new guard compares committed words with the first N entries of the new array. The approved algorithm assigns ownership by midpoint and sorts the persisted array by startFrame. An incoming word whose midpoint is after the old boundary can start slightly before a retained committed word. In that valid case the retained word remains byte-for-byte unchanged, but is no longer a prefix entry, so the server returns 409. Recovery reprocesses the same window and can repeat the rejection indefinitely.

Targeted reproduction using the actual merge and draft validator:

- First 0-20 s window commits `old committed` at [17.0, 17.9], midpoint 17.45, with boundary 17.5 s.
- Next 15-35 s window returns `new temporal owner` at relative [1.9, 3.2], absolute [16.9, 18.2], midpoint 17.55. It belongs to the new window under the binding midpoint rule.
- The merged draft passes `validateLiveDraft`, preserves `old committed` exactly, and correctly sorts to `[new temporal owner, old committed]`. The new server prefix comparison rejects it.

Preserve immutable words by comparing the temporally owned subset at or before the previous committed boundary with the prior committed-word sequence, rather than assuming that subset occupies a start-sorted prefix. Reject missing/replaced prior committed words and any inserted word owned by the prior interval. Add a server regression accepting this valid interleaving and continuing to reject changed committed content. This is a server-owned fix requiring coordination; the newly added server guard was explicitly within this re-review's interacting scope.

Specification verdict: original recovery, scheduling, and expiry gaps are closed; the new guard currently conflicts with midpoint temporal ownership. Code-quality verdict: request races and lifecycle fencing are sound in the reviewed changes, but the incompatible prefix invariant requires correction before approval.

Only this requested review report was written and is intentionally retained for integration. No production edits or scratch artifacts were created.

## Final integration disposition

The temporal-prefix regression above was subsequently corrected by the server owner: validation compares the prior midpoint-owned subset, accepting newly owned interleaving words while rejecting changes to committed ownership. The independent server reviewer reran the extension tests including this case (4 passed, 0 failed) and found no remaining temporal-draft blocker; see server-task-review.md. The controller final full Rust suite passed 43 tests. Original review findings are preserved here as review history; the earlier changes-required verdict is superseded by that fix/retest. Real Turbo throughput and meeting qualification remain pending.
