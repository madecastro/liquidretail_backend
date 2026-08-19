# 2026-08-19 — The undispatched-tail fix: no run has ever delivered its full claim

Branch `fix/stranded-run-tail`. Owner framing: *"No generation run has ever produced a
complete set of creatives... This is the highest-value deliverability bug in the
product right now."* Measured across 14 real runs the same night: **307 ordered, 224
delivered (73%), 37 explicitly failed (12%), 46 silently stranded (15%) — `queued`
with no `renderStage`, indistinguishable from work nobody had claimed.** No run of
39 creatives had ever completed; every run that delivered 100% was small enough
(2-12 ads) to fit inside `VEO_CONCURRENCY` in one pass.

## Root cause — NOT a bug in the render loop's dispatch logic

The instinct (mine, and the coordinator's framing) was "the pool must be truncating
its own queue — concurrency is a rate limit, not a work limit, so raising the cap
or fixing a dispatch-recursion bug is the fix." That instinct was **wrong**, and the
evidence proved it wrong before I wrote a line of code.

Traced `runRenderLoop`'s pool dispatch (`routes/ads.js` ~1700-1790) by hand: each
pool's `dispatch()` recursion is sound. Every completion (`.finally()`) that finds
`pool.next < pool.queue.length` calls `dispatch()` again, which claims the next
queue slot as soon as one frees. Given enough wall-clock time in a live process,
the loop drains its full queue — bounded by concurrency, never truncated by it, as
designed. I could not find a code path where the loop itself gives up early.

**Then I went to Mongo and Render's real logs for the actual documents and the
actual timeline**, rather than trusting the arithmetic pattern alone. Queried
`run_1787136860887_654ed621` (39 claimed, `queued`-with-no-stage count 9,
matching `21 video − VEO_CONCURRENCY 12 = 9` exactly — the pattern everyone,
including me, initially over-trusted as "the loop stopped after one wave"):

- CampaignRun: `status:'failed'`, with an `errors[]` entry stamped by
  `worker.js`'s reaper: *"no update from the render loop for over 15m — the
  process holding this run likely restarted or stalled."*
- `lastHeartbeatAt` froze at `11:04:32Z`. The reaper fired at `11:21:43Z` (17
  min of silence, past `REAP_STALE_MIN`=15).
- The 9 stranded ads: `status:'queued'`, `wasRendering:true`, `renderStage:null`,
  `renderAttempts:0`, `deriveWaitAttempts:0`, `updatedAt` == the reap tick to
  the millisecond. **Never touched by `adStage()` at all** — genuinely never
  dispatched, not a derive-wait polite-requeue (which stamps its own stage).
- The other 12 video ads (the "first wave" by creation order) DID succeed —
  but their `renderStageAt` timestamps run from `11:23:37Z` to `11:34:28Z`,
  **10-30 minutes AFTER the reap already fired**. The render loop kept
  producing real completions for this run long after its own CampaignRun had
  been marked `failed`.
- Render logs for the web service (`srv-d1vuktqli9vc73ft07ng`) in that window:
  `🚀 Server running on port 10000` at `11:02:12` AND AGAIN at `11:04:42`, plus
  a platform `Instance ... restarted` line at `11:05:33`. Three
  boots/restarts inside the run's own lifetime.

**So this specific incident is an ordinary web-instance replacement** (deploy,
autoscale, or the documented Remotion/Chrome RSS-exhaustion failure mode —
`services/concurrency.js`'s own `REMOTION_QUEUE_CONCURRENCY` comment already
names this exact failure shape) landing mid-run, not a logic defect in the
dispatch loop. The loop's own heartbeat (`services/campaignRunHeartbeat.js`,
shipped 2026-08-18 for a related but different incident) correctly dies with
the process it lives in — that is its documented, deliberate design, so a
genuinely wedged run still gets reaped. I did **not** fully reconcile why the
*same run* kept completing ads 10-30 minutes past the last heartbeat (a
replacement process almost certainly recovered the two receipted masters via
`bootRecoveryService` and drove the dependent derive ads from there, not the
literal original in-memory pool surviving) — recorded honestly as unresolved
in `session.d/KNOWN-OPEN.md` rather than asserted with more confidence than
the evidence supports.

## The actual defect: the requeue write, not the dispatch loop

Once a run's owning process is gone, **something** has to release its claimed
ads back to `queued` so a later attempt can pick them up — that machinery
already existed and is correct: `worker.js`'s 15-min reaper, and
`processAlerts.js`'s SIGTERM handler for a graceful shutdown, both release
receipt-free `rendering` ads (never touching receipt-holding ones — money
guard unchanged). Two more sites do the same thing from inside a
`runRenderLoop` crash catch, in both `/generate` and `/runs`.

**All four of those sites release the ad with `wasRendering: true` (the
existing `REQUEUE_MARK`) but never touch `renderStage`.** For an ad that was
already mid-render when the process died, that is harmless — `adStage()`
already wrote something real, and `services/strandedRunSweeper.js` picks it
up on its own 10-minute tick once the run is `failed`. **For an ad still
sitting in `pool.queue.slice(pool.next)` — claimed at the top of
`runRenderLoop`, never yet handed to `renderOne` — `adStage()` was never
called, so it has no stage at all**, and it is released looking byte-for-byte
identical to a fresh mint leftover an operator has simply not claimed yet.
`strandedRunSweeper`'s `renderStage` requirement exists *specifically* to
separate those two populations — CLAUDE.md is explicit that widening it is
the wrong, money-adjacent fix, because that requirement is what stops the
sweeper draining ads nobody has claimed at all. So the population this bug
affects was invisible to the one mechanism that exists to rescue it, by
design, forever — until an operator manually noticed and pressed "Generate
more" (which, measured, was not reliably happening).

## The fix

`services/adArchiveDigest.js` — the file that already owns the `REQUEUE_MARK`
/ `PRE_DISPATCH` ledger — gains `buildRequeueSetStage` / `buildRequeuePipeline`:
an aggregation-pipeline `$set` that writes `status:'queued'`,
`wasRendering:true` (identical to before), and a `renderStage` breadcrumb
**only when the row does not already have one** (`$cond` on "empty", where
empty is deliberately the SAME null-or-`''` test the sweeper's own filter
uses — a bare `$ifNull` alone would have missed a legacy `renderStage: ''`
row). A row that had already begun rendering keeps its real, more specific
stage untouched.

All four `REQUEUE_MARK` sites now call this instead of spreading the bare
marker:
- `worker.js` `reapOrphans()`
- `services/processAlerts.js` `persistOrphans()`
- `routes/ads.js` `/generate`'s `runRenderLoop` crash catch
  (`run-crash:generate`)
- `routes/ads.js` `/runs`'s `runRenderLoop` crash catch (`run-crash:runs`)

**`services/strandedRunSweeper.js` itself has zero lines changed.** The fix is
entirely upstream, at the point of release, exactly as required. No new claim
path was introduced — recovery still runs through the existing
`requeueStrandedAds` → `claimAdsForRun` atomic `status:'queued'` CAS, unchanged,
so the double-bill hazard the brief called out (a reaped ad still claimable by
a concurrent `selectAdsForRun` while a stale process's pool still holds it) is
not touched by this change in either direction.

## Verification

- **Offline, revert-proven.** `scripts/verifyArchiveDigestRelease.js` gained
  E16 (behavioral: `buildRequeueSetStage` stamps the marker + breadcrumb,
  preserves a real existing stage, treats `''` as empty, throws on a missing
  breadcrumb) and E16a (structural: all four real sites call it, none reverted
  to a bare spread). Its existing E14 source-scanner had to be taught the new
  call shape (`buildRequeuePipeline(...)` carries neither the literal
  `status: 'queued'` text nor `...REQUEUE_MARK` at the call site — both live
  inside the shared function now) — added a synthesis step in
  `siteTextWithPayloads` plus a new self-probe shape in E14a's `shapes` map,
  so the scanner's "every site must declare its verdict" invariant still holds
  for the new shape, not just the old one.
- `scripts/verifyReceiptAwareRequeue.js` needed the identical teaching: its
  `adRequeueBlock` helper and the exhaustive `X1` scan both anchored on the
  literal `"$set: { status: 'queued'"` text, which no longer appears at two of
  the four sites. Widened both to also anchor on `buildRequeuePipeline(` —
  the underlying `receiptFree(...)` filter is unchanged at every site, so once
  the block is found the real money guard is still what gets checked, not a
  copy.
- `scripts/verifyRunStatusTruthfulness.js` D3 used a fixed 1200-char window
  from an anchor string to find the queued-drain crash handler's `$push`; the
  few comment lines this fix added pushed that text to +1314 chars. Widened
  the span to 1600 (the one call site that uses this helper; no blast radius
  elsewhere).
- **Revert-proved by hand, not just asserted:** reverted one site
  (`worker.js`) to the old bare spread and confirmed `E14`/`E16a` in
  `verifyArchiveDigestRelease.js` failed with the exact expected messages;
  separately reverted the `$cond`-based empty-string handling to a plain
  `$ifNull` and confirmed E16's dedicated assertion for that case failed;
  separately removed `receiptFree(...)` from the worker.js call and confirmed
  `verifyReceiptAwareRequeue`'s W1 caught it. Restored all three and
  re-confirmed green before moving on.
- **Full suite: 169/169 `scripts/verify*.{js,mjs}` green**, `npm run lint`
  clean repo-wide. The three `sharp`-dependent scripts
  (`verifyLogoSilhouette`, `verifyLogoColorPreservation`,
  `verifyStaticTextInk`) needed `npm install sharp@^0.33.5
  https-proxy-agent@5.0.1 --no-save` in this worktree (per CLAUDE.md's own
  documented remedy — this worktree simply never had them installed) before
  they'd run at all; once installed they pass cleanly, confirming the
  coordinator's note that PR #238 fixed the underlying install gap.
- **Real-run proof, partially completed.** Confirmed via a dry run against
  the live database that the fix's exact `$set` stage, applied to the 9 real
  stranded ads in `run_1787136860887_654ed621`, produces the intended
  breadcrumb and would make them match `strandedRunSweeper`'s
  `buildStrandedAdFilter` on its own unmodified terms. **Did not apply the
  live write** — the Claude Code permission classifier blocked the DB write
  (a real production mutation), and per policy I did not attempt to route
  around that block. The backfill script is prepared, dry-run verified, and
  additive-only (touches `renderStage`/`renderStageAt` alone on rows already
  confirmed `queued`+`wasRendering:true`); it needs a human with write
  approval to run it, or the fix ships and this specific pre-existing batch
  is left to a manual "Generate more" as before. Recorded in
  `session.d/KNOWN-OPEN.md`.

## What I did NOT verify

- The live backfill + observed real-money-free drain of the 9 pre-existing
  stranded ads (blocked, see above) — the closest this session got was a
  dry-run computation against the real documents, not an observed live
  completion.
- Whether the SAME class of bug (a claimed ad genuinely never entering
  `renderOne`) can also originate from a cause other than process replacement
  — e.g. whether `progressRun.checkpoint()` can ever legitimately halt new
  dispatch without the operator-Stop path running (which archives, not
  requeues) — I traced this far enough to rule it out for THIS incident
  (`checkpoint()` only throws on a genuine `cancelRequested` flag, verified
  by reading `services/progressService.js`, and this run never went through
  the `cancelled` archive branch) but did not exhaustively prove no other
  trigger exists.
- Whether `STRANDED_SWEEP_ENABLED`/`STRANDED_SWEEP_REQUEUE` are genuinely
  `true` in the live Render dashboard right now — reading dashboard env vars
  was itself blocked by the permission classifier (secret-adjacent). Trusted
  the code default (`true`) and the CLAUDE.md §4a migration note that
  non-secrets were removed from the dashboard, but did not directly confirm.

## Files touched

- `services/adArchiveDigest.js` — `buildRequeueSetStage`/`buildRequeuePipeline`
  + updated module-header narrative ("THE UNDISPATCHED-TAIL GAP").
- `worker.js`, `services/processAlerts.js`, `routes/ads.js` (two crash catches)
  — adopt the new builder at all four `REQUEUE_MARK` sites.
- `scripts/verifyArchiveDigestRelease.js` (+E16/E16a, scanner taught the new
  shape), `scripts/verifyReceiptAwareRequeue.js` (anchors widened),
  `scripts/verifyRunStatusTruthfulness.js` (D3 span widened).
- `CLAUDE.md`, `docs/ALERTING.md` — the "NOT FIXED BY THIS" bullets closed out,
  pointing here for the narrative (per the new doc-restructuring convention).
