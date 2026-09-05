'use strict';
//
// Pure CampaignRun predicates. Extracted so a harness can evaluate the
// REAL filter against REAL document shapes instead of regexing a 4000-line
// route handler. A source-text assertion cannot tell a working query from
// one that merely still contains the right words.
//
// CampaignRun.status enum is ['preparing','running','done','failed']
// (models/CampaignRun.js). There is NO 'cancelled' on this collection —
// operator stop is OperationRun.status='cancelled' via progressService
// (STATUSES = running|succeeded|failed|cancelled|cancelling). A
// CampaignRun that finishes after an operator stop still lands on 'done'.
//
// ── THE PREPARING/RUNNING WINDOW SPLIT (2026-08-18) ────────────────────────
//
// Two staleness windows live here, and mixing them up costs money:
//
//   preparingStaleMin (PREPARE_STALE_MIN, 30) governs the whole 'preparing'
//     lifecycle — buildStalePreparingFilter, buildRunningFlipFilter's age
//     guard, AND the 'preparing' arm of buildActiveRunsFilter. All three key
//     on MINT AGE (startedAt/createdAt), because a preparing run never writes
//     to its own row.
//   runningStaleMin  (REAP_STALE_MIN, 15) governs claimed work — the Ad
//     reaper, the 'running' run reaper, and the 'running' arm of
//     buildActiveRunsFilter. These key on LIVENESS (updatedAt). The gate's
//     running arm and the worker's running reaper therefore share BOTH the
//     number AND the clock, which is what makes "the gate sees it" and "the
//     reaper would spare it" the same statement. They are not merely tuned to
//     the same value — they are the same predicate on the same field.
//
// THE INVARIANT, stated once here and enforced behaviourally by
// scripts/verifyPreparingReap.js Group G: the window in which the flip is
// still allowed must not exceed the window in which the gate still counts
// that preparing run as in-flight. If the flip outlives the gate, a duplicate
// request is admitted while the original can still flip — two billed
// generations for one operator intent. Both therefore read the SAME
// preparingStaleMin, so the relationship is equality by construction rather
// than two numbers someone has to remember to keep in step.
//
// Why 30 and not 15: PREPARE_STALE_MIN used to be 15, which is BELOW the
// system's own documented healthy expansion ceiling (~18-20 min — see
// worker.js and services/staleness.js). An expansion finishing at T=18 min
// therefore lost its own flip, the claimed ads were released back to queued,
// and the run read 'failed' to the operator. Nothing was double-billed, but
// perfectly good runs were being thrown away.

// In-flight statuses that may legally transition to 'done'. Terminal
// 'failed' (reaper) and 'done' must stay put; an allow-list (not a
// $nin of guessed names) is what keeps a future 'cancelled' on this
// collection from being flipped back to 'done'.
// The ONE staleness parser (services/staleness.js). Required here only for
// positiveMinutes() + the two documented defaults, so buildActiveRunsFilter can
// refuse a nonsense window instead of emitting `new Date(NaN)`. This module
// stays pure — it reads no process.env of its own.
const {
  positiveMinutes,
  REAP_STALE_MIN_DEFAULT,
  PREPARE_STALE_MIN_DEFAULT
} = require('./staleness');
// THE canonical "where is this ad right now" derivation — services/adPhase.js.
// classifyRunAdOutcome below used to count `draft` as unconditionally
// "succeeded" (the renderUrl-means-delivered heuristic that stranded 13
// untitled masters as "delivered" on 2026-08-20; the fix landed here first,
// direct on isVideoTitlingSettled/adTitlingTruth.js), then independently
// bucketed `failed` from a bare `status === 'failed'` with no notion of a
// QC-failed-but-kept-asset ad. adPhase.js is the file that now owns BOTH of
// those distinctions in one place — see its header for the three-way drift
// (this function, the Product Ads tile, Slack's run feed) that motivated
// it — so classifyRunAdOutcome is retrofitted below to read deriveAdPhase()'s
// answer instead of re-deriving isAdHonestlyDelivered / isQc itself.
// isVideoTitlingSettled/adTitlingTruth.js is still the ultimate source of
// truth; it is just reached through adPhase.js now, not directly.
const { deriveAdPhase } = require('./adPhase');

const DONE_ELIGIBLE_STATUSES = Object.freeze(['preparing', 'running']);

/**
 * Filter for the render-loop's terminal `done` write.
 * A run the reaper already marked `failed` must not become `done`.
 */
function buildTerminalDoneFilter(id) {
  return { _id: id, status: { $in: [...DONE_ELIGIBLE_STATUSES] } };
}

/**
 * The concurrency gate's in-flight set (routes/ads.js POST /api/ads/generate).
 * Extracted for two reasons, both load-bearing:
 *
 *   1. It is used TWICE — the pre-check before generationGateDecision, and the
 *      mint-then-verify re-read fed to pickSupersedingRun. Those two must see
 *      the SAME population or the race check protects a different set than the
 *      pre-check did. Inline duplication is how that drifts.
 *   2. The 'preparing' arm's bound is half of the coherence invariant in the
 *      module header, so it has to be something a harness can evaluate against
 *      real document shapes rather than regex out of a 4000-line route file.
 *
 * TWO ARMS, NOT ONE $in. This used to be a single
 * `{ status: { $in: ['preparing','running'] }, createdAt: { $gte: now - REAP } }`,
 * which forced both lifecycles onto the 15-minute claimed-doc window. That is
 * what made the preparing lifecycle incoherent: the flip guard needed to reach
 * ~18-20 min to cover a healthy expansion, but any value above the gate's own
 * window opens the double-bill described in the header. Splitting the arms lets
 * the preparing side move to 30 while running stays at 15 — no widening of the
 * running window, no delay to orphan requeue.
 *
 * ⚠️ THE TWO ARMS USE DIFFERENT CLOCKS, AND THAT IS THE POINT.
 *
 *   preparing → createdAt (MINT AGE). A preparing run makes zero writes to its
 *     own row between mint and the flip, so updatedAt === createdAt for the
 *     whole expansion. Mint age is its only available clock.
 *   running   → updatedAt (LIVENESS). A running run heartbeats: every per-ad
 *     $inc(succeeded|failed|skipped) is an update on a timestamps:true schema,
 *     so mongoose refreshes updatedAt (verified against mongoose 7.8.7 — a bare
 *     $inc really does get $set:{updatedAt} injected), and the flip's own $set
 *     refreshes it too.
 *
 * KEYING THE RUNNING ARM ON createdAt WAS A CONFIRMED P0 (found by adversarial
 * review, 2026-08-18, and it is reachable precisely BECAUSE the preparing window
 * was raised to 30):
 *
 *   t=0     run A minted, preparing. Gate's preparing arm sees it → duplicates 409.
 *   t=18    expansion finishes; the flip CAS now SUCCEEDS (that is the fix).
 *           Row becomes status:'running'; createdAt is still t=0.
 *           runRenderLoop starts submitting BILLABLE statics.
 *   t=18+ε  duplicate /generate arrives. Preparing arm: status mismatch.
 *           Running arm on createdAt: 18 > 15 → MISS. The gate sees NO active
 *           run, admits the duplicate SILENTLY (no 409, no confirm), and it
 *           mints and bills its own statics. Static ads scope identityDigest by
 *           generationRunId, so the unique index does not catch it and this gate
 *           is the ONLY protection (CLAUDE.md §2).
 *
 * Before the 15→30 change the t=18 flip LOST its CAS, so only one side ever
 * billed; raising the window is what makes the 15-30min band newly legal, and
 * that band is exactly the band a createdAt-keyed running arm is blind to.
 * The same blindness ALSO pre-existed for fast expansions (flip at t=2, batch
 * still rendering past t=15 → gate-blind while actively billing), which matters
 * far more now that MAX_CREATIVES_PER_RUN is effectively uncapped at 1000 and
 * long batches are the norm. Both are closed by the same one-word change.
 *
 * On updatedAt, gate visibility becomes exactly "the reaper would not reap
 * this": worker.js's running sweep is
 * `{ status:'running', updatedAt: { $lt: cutoff } }` on the SAME
 * REAP_STALE_MIN. Same number, same clock, same meaning — alive. A live run
 * stays visible however old its mint is; a dead one leaves the gate at the
 * instant the reaper's cutoff passes.
 *
 * THE RESIDUAL THIS COMMENT USED TO RECORD IS NOW CLOSED (2026-08-18). It said
 * CampaignRun had "no periodic heartbeat of its own", so updatedAt moved only
 * when an ad in the wave settled, and a wave whose renders all stalled could go
 * quiet long enough to be reaped while genuinely alive. That stopped being a
 * hypothetical the same week — run_1787105727540_e8c94542 was stamped 'failed'
 * at 02:36Z with `errors: []` while it was still rendering, and 9 of its ads
 * were stranded. services/campaignRunHeartbeat.js now beats this row every ~60s
 * for as long as the render loop reports real in-flight work, so both this arm
 * and the reaper are reading a genuine liveness signal rather than a completion
 * notification. The beat is gated on that in-flight count and capped at
 * RUN_HEARTBEAT_MAX_MS, so a wedged run still ages out of both.
 *
 * Index note: models/CampaignRun.js declares { campaignId:1, status:1,
 * createdAt:-1 }. The preparing arm is an exact status equality plus a
 * createdAt range — a single contiguous range on that index. The running arm
 * now ranges on updatedAt, which that index does not cover, so it is a
 * status-bounded scan of one campaign's runs. Acceptable and deliberate: the
 * leading campaignId+status keys make the candidate set a single campaign's
 * running runs (in practice 0-2 rows), and correctness here is worth more than
 * an index-only probe. Add { campaignId:1, status:1, updatedAt:-1 } if a
 * campaign ever accumulates enough running rows to matter.
 *
 * Minutes are validated through the SAME parser the env getters use
 * (services/staleness.positiveMinutes) rather than trusted raw: a missing or
 * nonsense value would otherwise produce `new Date(NaN)` and an arm that
 * matches nothing, i.e. a silently disabled half of the duplicate gate. This is
 * not a second parser — it is the one parser, called with an explicit fallback.
 */
function buildActiveRunsFilter({
  campaignId,
  now,
  runningStaleMin,
  preparingStaleMin
} = {}) {
  const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  const since = (min, fallback) =>
    new Date(t - positiveMinutes(min, fallback) * 60 * 1000);
  return {
    campaignId,
    $or: [
      // MINT AGE — a preparing run never writes to its own row.
      { status: 'preparing', createdAt: { $gte: since(preparingStaleMin, PREPARE_STALE_MIN_DEFAULT) } },
      // LIVENESS — must mirror worker.js's running reaper exactly, which keys
      // on updatedAt. createdAt here was the 2026-08-18 P0; see the JSDoc.
      { status: 'running',   updatedAt: { $gte: since(runningStaleMin,   REAP_STALE_MIN_DEFAULT) } }
    ]
  };
}

/**
 * worker.js reapOrphans() — CampaignRuns stuck in 'preparing'. Keyed on
 * PREPARE_STALE_MIN, the same preparing-lifecycle window the flip guard and
 * the gate's preparing arm use (module header).
 *
 * VISIBILITY, not the money guard — see buildRunningFlipFilter below for that.
 * The distinction still holds after the 15→30 change: this sweep decides when a
 * dead-looking row gets stamped 'failed' so it stops reading as a silent no-op;
 * the flip's own age check is what makes a slow run unable to resurrect itself,
 * and it works whether or not this sweep has ever ticked.
 *
 * A 'preparing' run never heartbeats: expandWizardJob (Director + Judge,
 * then the atomic Ad claim) makes ZERO writes to the CampaignRun row before
 * the 'running' flip, so updatedAt === startedAt for the entire expansion.
 * That is why this keys on startedAt, unlike the 'running' sweep in worker.js,
 * which safely uses updatedAt because a live batch now BEATS
 * (services/campaignRunHeartbeat.js, ~60s while the render loop has work in
 * flight). Until 2026-08-18 this parenthetical credited the per-ad $inc with
 * that guarantee instead; it never had it, and a run was reaped alive on the
 * strength of it — see buildStaleRunningFilter below. Using updatedAt HERE
 * would still be no different from using startedAt (a preparing run writes
 * nothing and does not beat), so startedAt states the real semantics.
 *
 * This sweep runs on a 5-minute cadence (REAP_INTERVAL_MIN) and can lag
 * arbitrarily further if the worker process itself is down — so it CANNOT
 * be the thing that closes the double-spend window on its own. That guard
 * is buildRunningFlipFilter's age check, which is self-contained and does
 * not depend on this sweep having run at all. This function only decides
 * when to stamp a dead-looking row 'failed' for visibility/cleanup; a run
 * this sweep hasn't gotten to yet is already money-safe because the flip
 * below independently refuses to resurrect anything past the gate's own
 * staleness window.
 */
function buildStalePreparingFilter({ now, staleMin }) {
  const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  return {
    status: 'preparing',
    startedAt: { $lt: new Date(t - staleMin * 60 * 1000) }
  };
}

/**
 * worker.js reapOrphans() — CampaignRuns stuck in 'running'. Keyed on
 * REAP_STALE_MIN and on `updatedAt` (SILENCE), which is the same field and
 * bound buildActiveRunsFilter's running arm uses, so "the gate still sees it"
 * and "the reaper would spare it" stay one statement rather than two numbers
 * someone has to keep in step.
 *
 * EXTRACTED FROM THE INLINE QUERY 2026-08-18, and the extraction is the point:
 * this predicate is what falsely failed run_1787105727540_e8c94542 while it was
 * legitimately rendering, so scripts/verifyCampaignRunHeartbeat.js has to
 * evaluate the REAL filter against REAL document shapes. A harness that
 * reimplements `{ status:'running', updatedAt: { $lt: cutoff } }` proves only
 * that the harness agrees with itself.
 *
 * ⚠️ THE PREDICATE IS ONLY AS TRUE AS ITS HEARTBEAT. `updatedAt` on a
 * CampaignRun used to move ONLY when an ad settled (the per-ad
 * `$inc {succeeded|failed|skipped}`, refreshed by timestamps:true), so this
 * read "no ad has settled recently", not "this run is dead". Those diverge the
 * moment a run's work is long and serialised — 18 statics finished, then 15
 * minutes of video titling behind REMOTION_QUEUE_CONCURRENCY, and the reaper
 * stamped a working run 'failed' with `errors: []`. services/campaignRunHeartbeat.js
 * is what now makes the silence real; do not weaken it and leave this filter
 * asserting a liveness it no longer has.
 *
 * Note the CLOCK, which differs from buildStalePreparingFilter above on
 * purpose: a running run HAS a liveness signal, a preparing one does not.
 * Keying this on startedAt would fail every run older than the window
 * regardless of health — a serialized video batch legitimately runs 25-35 min.
 */
function buildStaleRunningFilter({ now, staleMin }) {
  const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  return {
    status: 'running',
    updatedAt: { $lt: new Date(t - staleMin * 60 * 1000) }
  };
}

/**
 * The UPDATE half of buildStaleRunningFilter above — what worker.js's
 * reapOrphans() actually writes to a run it just decided is dead.
 *
 * Until this existed it was `{ status: 'failed', completedAt: new Date() }`
 * and NOTHING ELSE — no `errors[]` entry. So the run's own header comment
 * ("Nothing threw. It was still rendering.") was true from the reaper's side
 * too: an operator looking at GET /api/ads/runs/:id for a reaped run saw
 * `status:'failed'` with `errors: []`, `failed: 0` — a hard stop with zero
 * explanation, the exact "operator-blind" gap this run-status work exists to
 * close. Slack's aggregate `worker.js` alert ("Dropped work reclaimed …")
 * already says *this class* of thing happened, in a channel; the run poller
 * itself said nothing. `staleMin` is threaded through (not hardcoded) so the
 * message states the REAL configured window rather than a number that can
 * silently drift from REAP_STALE_MIN.
 *
 * Exported and pure so a harness can assert the exact `$push` shape reaches
 * Mongo, the same reasoning buildStaleRunningFilter's own header gives for
 * extracting the filter — a source-text check cannot prove the write landed.
 */
function buildStaleRunningReapUpdate(staleMin) {
  return {
    $set: { status: 'failed', completedAt: new Date() },
    $push: {
      errors: {
        index: 0,
        stage: 'reaper',
        message: `no update from the render loop for over ${staleMin}m — the process holding ` +
          'this run likely restarted or stalled; any of its claimed ads were reset to \'queued\' ' +
          'and need a new "Generate more" to finish'
      }
    }
  };
}

/**
 * THE MISSING LINK, found investigating a 2026-08-20 incident
 * (run_1787263897396_ef1fcb32, and its sibling shape run_1787105727540_e8c94542
 * — see session.d/ for both write-ups): CampaignRun.status is written ONLY by
 * process-local code (runRenderLoop's post-`Promise.all` write, or the blind
 * reaper below). NOTHING ever re-derives it from the Ads the run actually
 * claimed. So a run whose owning process died can sit `'running'` forever
 * even after every one of its Ads is genuinely `draft`+renderUrl (delivered
 * by a completely different path — titlingResumeService, bootRecoveryService
 * — that never touches CampaignRun at all); and the SAME gap runs the other
 * direction, where the reaper's blind `failed` stamp leaves stale
 * succeeded/failed counters that undercount real, already-delivered work
 * (the observed `status:'failed', succeeded:18` while all 39 Ads had a
 * `renderUrl`).
 *
 * `classifyRunAdOutcome` is the read side of the fix: given the REAL Ad
 * documents a run claimed (`Ad.find({ campaignRunIds: run.runId })`, called
 * by worker.js AFTER its own Ad-sweep above has already requeued whatever
 * receipt-free stale rows it found — so a `'queued'` row here means "this
 * run's claim on it is genuinely void", not "not looked at yet"), decide
 * whether the run is actually finished and what its honest counters are.
 *
 * Ad.status enum (models/Ad.js): queued | rendering | draft | live |
 * archived | failed. `draft`/`live`/`archived` are the delivered shapes
 * (CLAUDE.md documents `draft` as the terminal "delivered" state for both
 * static and video Ads) — PROVIDED titling has actually settled for a video
 * Ad; see `isVideoTitlingSettled` below. `failed` is a settled failure;
 * `queued`/`rendering` are the only two non-terminal shapes.
 *
 * ⚠️ `draft` ALONE IS NOT "SUCCEEDED" FOR A VIDEO AD (fixed 2026-08-20).
 * The normal render path, `bootRecoveryService`, and `titlingResumeService`
 * all stamp `status:'draft'` + `renderUrl:veoVideoUrl` the INSTANT a paid
 * master lands — before Remotion titling has even started — specifically so
 * the asset is viewable immediately (see routes/ads.js's money-guard comment
 * and titlingResumeService.js's header). If the process then dies mid-title
 * (measured 2026-08-20: an autoscale replacement mid-Remotion-render), the
 * Ad sits `draft`+untitled forever unless titlingResumeService's own
 * stale-claim sweep gets to it. Counting that as `succeeded` here — the
 * exact bug this reconciliation function exists to fix in the OTHER
 * direction (undercounting) — would launder an untitled master into a
 * `'done'` run with an honest-looking succeeded count. `isVideoTitlingSettled`
 * is the one function in this repo that tells a real composite apart from a
 * raw master parked on `renderUrl`; see services/adTitlingTruth.js.
 *
 * RETROFITTED 2026-08-31 (services/adPhase.js parity pass — that file's own
 * header names this function as one of three independent "what state is
 * this ad in" derivations it exists to unify). succeeded/failed are now read
 * off THE canonical `deriveAdPhase()` phase for each ad instead of
 * re-deriving "is this delivered" from `isVideoTitlingSettled` directly and
 * "is this a failure" from a bare `status === 'failed'`. Every case this
 * function has ever needed to get right is unchanged, and the mapping below
 * is provably equivalent to the pre-adPhase switch, not just similar:
 *
 *   - phase `'complete'` is returned ONLY for status ∈ {draft,live,archived}
 *     with `isAdHonestlyDelivered(ad)` true, which for exactly those three
 *     statuses IS `isVideoTitlingSettled(ad)` (adTitlingTruth.js) — the same
 *     boolean the old switch computed, reached through one more named layer.
 *   - phase `'failed-terminal'` / `'qc-failed-kept'` are returned ONLY when
 *     `status === 'failed'` (adPhase.js's own unconditional guard at the top
 *     of `deriveAdPhase`), so folding either into `failed++` is exactly the
 *     old `case 'failed': failed++` — this function does not need to (and
 *     does not) distinguish a QC-failed-but-kept-asset ad from any other
 *     failure; both settle the run's `failed` counter identically.
 *   - every OTHER phase `deriveAdPhase` can return for a draft/live/archived
 *     ad — `awaiting-master`, `titling`, `awaiting-titler`, `quality-check`,
 *     `claimed`, `generating-master`, `deferred-retrying`,
 *     `skipped-derivative`, `stalled` — is reachable ONLY when
 *     `isAdHonestlyDelivered(ad)` is false, which for a draft/live/archived
 *     ad means ONLY a video ad whose titling has not settled: an image ad's
 *     `isVideoTitlingSettled` is unconditionally `true` (no titling step
 *     exists for statics — adTitlingTruth.js), so an image ad on one of
 *     those three statuses ALWAYS resolves to `'complete'` and never reaches
 *     this branch. So bucketing every non-`'complete'` draft/live/archived
 *     ad into `titlingIncomplete` is exactly the old behaviour too.
 *   - `stillRendering` vs `requeuedAway` are NOT determinable from phase
 *     alone and are deliberately NOT retrofitted onto it: the identical
 *     phase (e.g. `'awaiting-master'`, a free derive waiting on its sibling
 *     master) can arise from either `status:'rendering'` (claim still held,
 *     actively polling) or `status:'queued'` (claim released back to the
 *     pool after `DERIVE_MASTER_WAIT_MS` expired) — and the OLD switch's
 *     bucket for those two statuses was decided purely by `ad.status`,
 *     never by any finer distinction. Reading raw `ad.status` for exactly
 *     this one split is therefore not "re-deriving" anything adPhase.js
 *     already owns — it is the same read the pre-adPhase code made, kept
 *     because deriveAdPhase's phase vocabulary genuinely cannot disambiguate
 *     it.
 *
 * Proven equivalent by scripts/verifyClassifyRunAdOutcomeParity.js against
 * a frozen copy of the pre-adPhase switch.
 */
function classifyRunAdOutcome(adDocs) {
  let succeeded = 0, failed = 0, stillRendering = 0, requeuedAway = 0, titlingIncomplete = 0;
  for (const ad of (adDocs || [])) {
    if (!ad) continue;
    const phase = deriveAdPhase(ad);
    if (phase === 'complete') { succeeded++; continue; }
    if (phase === 'failed-terminal' || phase === 'qc-failed-kept') { failed++; continue; }
    // Not yet settled. WHICH counter this hits stays keyed on the raw
    // Ad.status the reaper/gate itself cares about — see the header above
    // for why that split cannot move onto deriveAdPhase's finer vocabulary.
    switch (ad.status) {
      case 'rendering': stillRendering++; break;
      case 'queued':    requeuedAway++; break;
      case 'draft':
      case 'live':
      case 'archived':
        // Reaching here means deriveAdPhase did NOT return 'complete' for a
        // delivered-shaped status, which (see header) is possible only for
        // a video ad whose titling has not genuinely settled.
        titlingIncomplete++;
        break;
      // Anything else (missing/unrecognised) is not counted either way —
      // the same posture the render loop's own $inc sites already take.
      default: break;
    }
  }
  return {
    succeeded,
    failed,
    stillRendering,
    requeuedAway,
    // Video Ads sitting `draft`+untitled-master. Distinct from
    // `stillRendering` (that is Ad.status:'rendering'; this is Ad.status:
    // 'draft' with an unsettled titling debt) but the SAME posture: real,
    // already-billed work that titlingResumeService is (or will be, on its
    // next sweep) actively finishing for free. Never counted as succeeded
    // OR failed — see isSettled below.
    titlingIncomplete,
    // A receipt-holding Ad is deliberately left `'rendering'` by the reaper's
    // Ad-sweep (services/spendReceipt.js) specifically so it can finish for
    // FREE instead of being requeued into a second paid submit. So
    // `stillRendering > 0` here means real, already-billed work is still
    // outstanding — the run must not be finalized either way this cycle;
    // the next reap tick (REAP_INTERVAL_MIN later) re-checks. An untitled
    // master mid-recovery is the SAME kind of outstanding, unbilled-again
    // work, so it defers the run identically rather than being laundered
    // into a dishonest 'done'.
    isSettled: stillRendering === 0 && titlingIncomplete === 0,
    // Only a genuinely lost claim (an Ad reset to 'queued', needing a fresh
    // "Generate more") justifies the run reading 'failed'. A settled run
    // with a mix of succeeded/failed Ads and nothing lost is still a
    // COMPLETED run — 'done' already means "finished", not "everything
    // succeeded"; that is the exact semantics runRenderLoop's own terminal
    // write uses (it does not itself check the succeeded/failed mix either).
    needsRetry: requeuedAway > 0
  };
}

/**
 * The RECONCILED terminal write — used ONLY after classifyRunAdOutcome has
 * confirmed `isSettled` from the real Ad documents. This is deliberately a
 * DIFFERENT function from buildStaleRunningReapUpdate, not an extra
 * parameter on it: that function's contract (pinned by
 * scripts/verifyRunStatusTruthfulness.js C1) is a BLIND write that never
 * inspects a single Ad, so it must never guess at succeeded/failed/skipped —
 * a guess would be exactly the "corrupt the run's own audit trail" hazard
 * that test guards against. Here the counters are not a guess: they are
 * recomputed from verified truth, so stamping them is the fix for the
 * observed `status:'failed', succeeded:18` shape while every one of 39 Ads
 * already carried a `renderUrl` — not a new risk.
 *
 * `needsRetry` (some claimed Ad was genuinely lost back to 'queued') still
 * produces the SAME reaper explanation as buildStaleRunningReapUpdate — this
 * just layers real counters on top of it, spreading from that one function
 * rather than duplicating its message text.
 */
function buildRunReconciliationUpdate(outcome, { staleMin, now } = {}) {
  const at = now instanceof Date ? now : new Date();
  const counters = { succeeded: outcome.succeeded, failed: outcome.failed };
  if (outcome.needsRetry) {
    const base = buildStaleRunningReapUpdate(staleMin);
    return { ...base, $set: { ...base.$set, completedAt: at, ...counters } };
  }
  return { $set: { status: 'done', completedAt: at, ...counters } };
}

/**
 * routes/ads.js — the compare-and-swap for the 'preparing' → 'running' flip.
 * THIS is the actual money guard, not the reaper sweep above.
 *
 * `status:'preparing'` alone is necessary but not sufficient. Adversarial
 * review caught the gap: the concurrency gate (routes/ads.js, via
 * buildActiveRunsFilter above) stops treating a 'preparing' run as active once
 * its `createdAt` is older than the preparing window. That gate check fires on
 * every request, independent of whether the worker's reaper has actually
 * ticked. So without an age check HERE too, a run whose expansion is merely
 * slow (not dead) can outlive the gate's window — a duplicate request then
 * sails through as "not a duplicate" (the stale row is invisible to the gate),
 * a sibling run bills a fresh generation, and MINUTES LATER the original's
 * expansion finally finishes and this flip — checking only {_id,
 * status:'preparing'} — would have succeeded too, billing a second time
 * for the same operator intent. Passing `staleMin` closes this: the flip
 * refuses at the exact instant the gate's PREPARING ARM stopped honoring its
 * exclusivity, regardless of reaper cadence. `staleMin` is optional only so the
 * pure-logic tests can exercise the bare status guard in isolation; every real
 * caller must pass it.
 *
 * SCOPE OF THAT "exact instant" CLAIM — it is about the PREPARING arm only.
 * Once this flip succeeds the run is 'running', and the gate tracks it on the
 * OTHER arm, which keys on updatedAt/liveness rather than mint age. So the
 * handoff is: preparing-by-mint-age → (flip) → running-by-liveness. Both sides
 * of that handoff must be continuous, which is why the flip's own $set
 * refreshes updatedAt and hands the running arm a fresh clock. An earlier
 * version of this comment claimed the flip and "the gate" agreed full stop;
 * that overstated it and helped hide the createdAt P0 on the running arm.
 *
 * ⚠️ `staleMin` HERE MEANS THE PREPARING WINDOW (PREPARE_STALE_MIN, 30) — NOT
 * REAP_STALE_MIN. Corrected 2026-08-18, and the correction is the whole point
 * of this change. The original wiring passed the gate's REAP_STALE_MIN (15) and
 * argued that was right because both sides used one const. The reasoning about
 * *agreement* was sound; the *value* was not. 15 is the claimed-doc heartbeat
 * window, and a 'preparing' run does not heartbeat — its legitimate runtime is
 * the Director + Judge ladder, which worker.js's own arithmetic puts at ~18-20
 * min. So a perfectly healthy expansion finishing at T=18 lost its own flip:
 * ads released back to 'queued', run stamped 'failed', operator shown a crash
 * that never happened. The fix is not to drop the guard (that reopens the
 * double-spend) but to key BOTH the guard and the gate's preparing arm on the
 * preparing window. See the module header for the inequality that makes
 * "both", rather than "either", the load-bearing word.
 *
 * INCIDENTAL BUT LOAD-BEARING: this filter keys on `startedAt`; the gate
 * (routes/ads.js) keys on `createdAt`. That is safe only because
 * `startedAt <= createdAt` always holds — `startedAt` is set by JS at
 * CampaignRun.create() (routes/ads.js) plus a schema default of `Date.now`
 * (models/CampaignRun.js), while `createdAt` is stamped by mongoose
 * `timestamps` at the same save, a few ms later. So this flip goes stale
 * marginally BEFORE the gate stops honoring the run's exclusivity — the
 * safe direction. Nothing in this codebase ever rewrites `startedAt` after
 * mint (verified: every write is inside a CampaignRun.create() call, never
 * a $set on an existing doc — see scripts/verifyPreparingReap.js Group F).
 * If that ever changes — a retry/resume path that bumps `startedAt` — this
 * ordering inverts and the double-spend window silently reopens with
 * nothing here to catch it. Adversarial review flagged this as real but
 * incidental; if `startedAt` ever needs to move, key this filter on
 * `createdAt` instead, matching the gate exactly rather than relying on
 * the ordering.
 */
function buildRunningFlipFilter(runDocId, { now, staleMin } = {}) {
  const filter = { _id: runDocId, status: 'preparing' };
  if (staleMin != null) {
    const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
    filter.startedAt = { $gte: new Date(t - staleMin * 60 * 1000) };
  }
  return filter;
}

/**
 * THE GENERAL SAFETY NET — 'failed' is not necessarily FINAL truth, only the
 * last thing written. Found investigating a 2026-08-20 incident: TWO runs
 * (operator brian@egami.tv) sat at `status:'failed', succeeded:18, total:39`
 * while every one of the 39 claimed Ads was, by the time anyone looked,
 * genuinely `draft` with a real `renderUrl` — 100% delivered, reported as
 * 46%. `classifyRunAdOutcome`/`buildRunReconciliationUpdate` above already
 * fix the running-reaper's OWN blind stamp, but that is only ONE of several
 * writers that can land a run on `status:'failed'` without ever looking at
 * its Ads:
 *
 *   - services/processAlerts.js persistOrphans — the SIGTERM/crash stamp,
 *     fires on every deploy and autoscale replacement.
 *   - routes/ads.js's crash handlers (the queued-drain run-crash handler,
 *     the prep/render crash handler) — a post-claim throw stamps 'failed'
 *     with no recount.
 *   - a run this SAME reaper reconciled correctly with `needsRetry` (some
 *     claimed Ad had genuinely been reset to 'queued' at that moment) whose
 *     "lost" Ads services/strandedRunSweeper.js later drained into a
 *     SUCCESSFUL re-render — that service fixes the Ad, never the
 *     CampaignRun row it came from. The ~15-minute gap between the measured
 *     incidents' `lastHeartbeatAt` and `completedAt` matches this reaper's
 *     own staleness window almost exactly, which is why this is believed to
 *     be the dominant path in production, not merely a hypothetical.
 *
 * Patching every individual writer is a losing game — a future one will
 * exist that nobody remembers to route through classifyRunAdOutcome. So
 * 'failed' runs get the SAME re-derivation as 'running' ones, on the same
 * worker cadence, bounded to a recency window (`completedAt` within
 * `windowMin`) so this stays a cheap indexed scan of yesterday's handful of
 * failures — not a crawl of the collection's entire history. A run outside
 * the window is old enough that nothing is still quietly delivering more of
 * its Ads in the background; re-scanning it forever would only cost cycles
 * for no correctness gain.
 */
function buildRecentlyFailedFilter({ now, windowMin }) {
  const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  return {
    status: 'failed',
    completedAt: { $gte: new Date(t - windowMin * 60 * 1000) }
  };
}

module.exports = {
  DONE_ELIGIBLE_STATUSES,
  buildTerminalDoneFilter,
  buildActiveRunsFilter,
  buildStalePreparingFilter,
  buildStaleRunningFilter,
  buildStaleRunningReapUpdate,
  classifyRunAdOutcome,
  buildRunReconciliationUpdate,
  buildRunningFlipFilter,
  buildRecentlyFailedFilter
};
