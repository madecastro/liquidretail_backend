## 2026-08-10 (later) — VIDEO: retry a generation Atlas ran and failed, gated on a CONFIRMED non-charge. PR #113, live `71d73010`

Owner saw `atlasVideo: prediction failed: Generation failed: task processing failed
(code: generation_failed)`. Unrelated to the Claude 5 fix above — different endpoint
(`/api/v1/model/generateVideo`), no `temperature` anywhere in `atlasVideoService`, and the
first identical failure (15:56) predated that deploy (16:58).

**Provider-side fault, not ours.** Atlas accepts the job and fails it without rendering a
frame: `executionTime: 0`, `timings.inference: 0`, `outputs: null`. **6 failures across ~23
submits in one day (~26%).**

**BILLING — there is no Atlas billing endpoint. The authority is `data.price` on the settled
prediction** (already how `atlasImageService`/`costTracker` treat it). Measured across ten
real predictions:

| | `data.price` |
|---|---|
| succeeded | `"0.75"` full-length / `"0.08"` short — **5 of 5** |
| failed | **absent entirely** — 5 of 5 |

So a `generation_failed` is **not billed** — matching the note already in `atlasImageService`
("Atlas refunds the reservation on a failed task and never bills a rejection"). **A video is
$0.75**, so those six were ~$4.50 of value lost, not spent.

**The policy was already right and simply unread.** `predictionFailed` has always said
`action:'retry', maxAttempts:2, charged:false`. The video path classified and threw.
`generateForAd` now retries behind `mayRetryAfterFailure()`, which needs ALL of: policy
retryable (excludes `moderationBlocked` — it would just re-block), under the attempt ceiling,
and `confirmedCharge() === false` read from `data.price`. **`null` (unknown) never retries** —
a non-charge may only be asserted from a confirmed price, exactly as a charge may.

**Two poll defects, both from Atlas putting a COMPLETE verdict inside an HTTP 500:**
- The poll's `axios.get` had no `validateStatus`, so a 500 threw into the generic 5xx branch.
  `cec47abe…` was polled **12 times over 3 minutes** after it had already failed, then
  surfaced as "12 consecutive poll failures" — reads like an outage, and discards the
  classification so a moderation block arriving as a 500 would never be named.
- `peekPrediction` bailed on `res.status !== 200` **before** reading the body → recovery got
  `unknown` for a definitively failed video and its charge state never resolved.

⚠️ **The status code is NOT a discriminator.** The same prediction returned 200 early in its
life and 500 later. Branch on the body, never the code.

### Two things I got wrong, caught before shipping — both worth remembering
1. **Invented a `costSource: 'confirmed'`.** The enum is `actual|estimated|none`. Mongoose
   **update validators are OFF by default**, so it would have been written straight past the
   enum into the DB. Check the schema; don't assume a plausible value is legal.
2. **Adversarial review found a ship-blocker: the charge-point `recordFlatCost` never stamped
   `providerRequestId`.** `finalizeFlatCost` keys on it, so the correction would have matched
   nothing, fallen back to an INSERT, and left the failed attempt's $0.75 estimate beside the
   retry's — **$1.50 booked for one delivered video**, the exact double-count the change
   existed to prevent. My harness false-passed it: it proved the correction *looked* right and
   never proved its KEY existed. **A ledger check must assert the join key on BOTH rows.**

**Fence:** `scripts/verifyVideoRetryOnUnbilledFailure.js` — 23 offline checks, revert-proven
four ways (unknown-charge retry, poll promotion, peek guard, ledger key). Full detail in
`docs/ATLAS.md` §10.

**Residual risk, accepted and stated:** if Atlas ever bills at accept and attaches `price` to a
failed body only later, a "no price" read would retry a real charge. Nothing in the data
suggests it (5/5 failed rows never gained a price across repeated reads); closing it needs a
delayed second peek or a refund API. **Tripwire: if the video bill ever exceeds delivered
videos, this is the cause.**
