'use strict';
//
// BOOT RECOVERY — collect generations we already paid for.
//
// WHY (2026-08-04): providers charge at SUBMIT. When a process dies mid-render,
// the ad is left in `rendering` holding a spend receipt (Ad.veoPredictionId) for
// work Atlas may have gone on to finish. Nothing ever looked at that receipt, so
// the asset was abandoned and the next run re-bought it. Measured: a 411s Omni
// master completed at 17:27:09 and the shutdown requeue swept its run one second
// later.
//
// services/spendReceipt.js stopped the re-buy (a requeue can no longer touch a
// receipt-holding ad). This module is the other half: it goes and FETCHES the
// asset. Nothing here can submit — it calls atlasVideoService.resumeForAd, whose
// no-submit guarantee is asserted on its source by scripts/verifyVideoResume.js.
//
// ── NO CLAIM, ON PURPOSE ────────────────────────────────────────────────────
// Autoscaling means several instances boot at once and will all run this. There
// is deliberately NO claim/lease, for two reasons:
//
//   1. The only provider call is a free GET. Two instances peeking the same
//      prediction wastes one HTTP request and nothing else.
//   2. Every write is guarded by `status: 'rendering'` in its own filter, so the
//      first writer transitions the ad and every later writer is a no-op. That
//      is cheaper and far less fragile than a lease, and it needs no new schema
//      field — which matters, because mongoose strict mode SILENTLY DROPS writes
//      to undeclared paths (this repo has already lost `renderError.predictionId`
//      that way; see models/Ad.js).
//
// ── ADGEN OWNERSHIP — the PRIMARY guard, added 2026-08-26 ──────────────────
// This module had two independent gaps, not one. The claim-awareness
// section below closes the narrower one. This section closes the wider one:
// until now, this sweep had ZERO awareness that liquidretail_adgen might
// own rendering at all — no reference anywhere to ADGEN_RENDERER_ENABLED /
// isAdgenRendererEnabled, unlike its sibling services/titlingResumeService.js
// (`resumeUntitledMasters`), which has stood down on that flag since the
// adgen cutover: `if (isAdgenRendererEnabled()) return out;`. Boot recovery
// was simply never given the same treatment, so worker.js's recoverTick
// (called unconditionally, every REAP_INTERVAL_MIN) kept sweeping the exact
// collection adgen's renderer/titler claims rows in, regardless of the flag.
//
// adgen carries its OWN vendored copy of this file, wired from its renderer
// (`startBootRecoverySweep`) and gated on isAdgenRendererEnabled() on ITS
// side — i.e. it runs precisely when adgen owns rendering. THIS FIX MAKES A
// NARROWER CLAIM THAN "coverage moves to a claim-aware sweeper" — say that
// plainly, because it is tempting to overstate. Adgen's vendored copy, as
// of this writing, is UNAUDITED FROM HERE and still runs the ORIGINAL
// claim-blind query (no claimedByWorker awareness at all) — this PR does
// not touch or verify it, and whether it is actually running in production
// cannot be proven from this repo (its own docs disagree with each other on
// the wiring date). What standing down here DOES prove, unconditionally: a
// live adgen title can no longer be stomped BY BACKEND while the flag is
// on — this process simply never peeks or writes a video-receipt row in
// that mode. It does NOT prove the dual-render race is closed against
// EVERY actor, and it does NOT reduce the number of sweepers polling the
// collection (adgen's own still runs) — at most it removes one VIDEO
// WRITER from the race, which is the claim this comment makes.
//
// One more handoff this changes, worth stating rather than leaving implicit:
// adgen's own per-ad heartbeat has a deliberate lifetime cap
// (AD_HEARTBEAT_MAX_MS, liquidretail_adgen/src/services/renderer.js), past
// which adgen intentionally stops refreshing updatedAt WHILE KEEPING THE
// CLAIM HELD, on the documented reasoning that backend recovery should be
// able to take the row from there if the render is genuinely stuck. With
// this gate on, backend declines that handoff for as long as the flag
// reads true — failover for a stuck-past-the-cap claim now depends entirely
// on adgen's own sweep (if it is running).
//
// SCOPED TO VIDEO RECOVERY ONLY — this is the constraint that matters most.
// Static-image recovery (recoverImageAd, below) stays unconditional, and so
// does its cost-reconcile call, because it was never exposed to the race
// video is: a recovered image is ONE atomic peek-then-write with no
// asynchronous hand-off to a second process, so two peekers racing it is
// exactly the harmless case the "NO CLAIM, ON PURPOSE" reasoning above
// already covers. Video is different SPECIFICALLY because a recovered
// master hands off to a SEPARATE titling pass (titlingResumeState:'pending')
// — that hand-off is the thing a live adgen claim must not have stolen out
// from under it. Gating the whole function (or the query) would also have
// silently stopped the per-ad cost-reconcile calls threaded through this
// loop, which is a worse bug than the one being fixed — so the gate sits
// at the one call site that actually races (see resumeInFlightAds).
//
// ── Ad.claimedByWorker IS A DIFFERENT THING — SECONDARY, defense in depth ──
// The "no claim" reasoning at the top of this file is about concurrent
// bootRecoveryService peekers racing each other. Ad.claimedByWorker is
// adgen's ownership marker for a row this sweep must not touch while the
// claiming worker is alive — not a concurrency-dedup lease among peekers.
// With the ownership gate above as the primary defense, this claim-aware
// filter mostly matters for the TRANSITION window around a flag flip (a
// row adgen claimed while the flag was on, still mid-render when an
// operator flips it back off) — but it stays unconditional and per-row
// rather than assuming the flag is the only signal, because a stale claim
// marker left over from ANY prior owner deserves the same caution
// regardless of what the flag currently reads. Adgen's renderer DOES run
// its own per-ad heartbeat during titling (mirrors this repo's renderOne,
// routes/ads.js:2822 — every 60s, unlike renderOne it also covers a claimed
// row stuck at status:'rendering' through the WHOLE titling pass, since
// adgen does not flip to 'draft' until titling terminates), but this sweep
// must not assume that heartbeat is reliable: it can lag under event-loop
// contention from a CPU-heavy Remotion pass, silently miss individual
// writes (a caught-and-swallowed error — "the next one lands"), or stop
// entirely once adgen's own heartbeat lifetime cap is hit while work is
// still genuinely in flight (adgen's own code documents that exact residual
// as accepted, deferring to backend recovery). Any of those looks identical
// from here: an untouched updatedAt. Sweeping a still-live claim on the
// strength of RESUME_STALE_MIN (5m, calibrated for OUR OWN renderOne's
// beat, not another process's) would stamp status:'draft' +
// titlingResumeState:'pending' out from under the live worker (dual
// Remotion render on one paid master). Claimed rows therefore get
// RESUME_CLAIM_STALE_MIN (default 15, same "generous on purpose" convention
// as titlingResumeService.CLAIM_STALE_MIN) — long enough that a
// merely-lagging beat is never mistaken for a dead one, short enough that a
// dead worker's paid master is still recovered; this sweep must never
// become a permanent no-op for claimed rows.
//
// ⚠️ NEITHER GUARD IS COMPLETE ON ITS OWN, and neither closes every known
// race — stated plainly rather than implied. The ownership gate is a
// process-wide switch, not a per-row lock: `Ad.updateOne` below is still
// guarded only by `{ _id, status:'rendering' }`, so a row that looked
// unclaimed at query time but gets claimed by adgen a moment later (between
// the find and the write) can still be stomped — pre-existing behaviour,
// not introduced or closed here. And adgen's OWN vendored copy of this
// file is a SEPARATE, unaudited codebase this fix cannot reach — closing
// this gap here does not prove the adgen-side sweeper is claim-aware or
// correctly gated. Both are known, out-of-scope-for-this-file residuals;
// do not read this fix as "the dual-render race is closed."
//
// ── WHY THE STALENESS WINDOW EXISTS ─────────────────────────────────────────
// An ad being rendered RIGHT NOW by another live instance is also
// `status: 'rendering'` with a receipt. Peeking it is harmless, but stamping it
// `draft` underneath its owner would race the owner's own completion write.
// renderOne heartbeats `updatedAt` every 60s, so an ad untouched for
// RESUME_STALE_MIN minutes has missed several beats and is not being actively
// rendered by anyone. Default 5 = five missed heartbeats.

const Ad = require('../models/Ad');
const { HAS_RECEIPT } = require('./spendReceipt');
// Same helper titlingResumeService.js gates its own stand-down on — never a
// second inline process.env read (the exact "unbound identifier shipped
// with a green harness" class of incident this repo has already had twice;
// importing the shared helper means both stand-downs can never disagree
// about what the flag says).
const { isAdgenRendererEnabled } = require('./adgenBridge');
// reconcileVideoCostFromTerminal upgrades the video charge-point CostLog row
// to a settled price the same way a normal (non-recovered) completion does —
// imported, not re-implemented, so the two paths can never compute the charge
// differently. See the recovered-master branch below.
const { resumeForAd, reconcileVideoCostFromTerminal, resolveFailureCostReconcile } = require('./atlasVideoService');
// Static-image counterpart: recoverImageAd peeks (free GET), finishPlate (local
// crop + logo), Cloudinary upload, optional vision QC. ZERO image submits.
// See imageRecoveryService header for the money contract.
const { recoverImageAd } = require('./imageRecoveryService');
// Upgrades an 'estimated' ledger row to Atlas's own settled `price`. The owner rule
// is that a charge must be CONFIRMED, never assumed — see the charge block below.
const { reconcileCost } = require('./costTracker');
const alerts = require('./alertService');
// Single source of the recovery→titling state and the poster derivation, so the
// writer here and the reader there can never drift. Requiring this module is cheap
// on the worker: titlingResumeService lazy-requires brandScriptExecutor, so no
// remotion/ffmpeg weight is pulled in at boot (asserted by verifyTitlingResume).
const {
  STATE_PENDING,
  TITLING_PENDING,
  fallbackPosterUrl
} = require('./titlingResumeService');

// Five missed 60s heartbeats. Lower than REAP_STALE_MIN (15) on purpose: the
// point is to recover the asset BEFORE the reaper or a re-run gets involved.
const RESUME_STALE_MIN = Math.max(1, parseInt(process.env.RESUME_STALE_MIN, 10) || 5);
// Bound the boot cost. Recovery is fire-and-forget and must never make startup
// slow or unbounded; whatever is missed is picked up on the next sweep.
const RESUME_MAX_ADS   = Math.max(1, parseInt(process.env.RESUME_MAX_ADS, 10) || 25);
// Generous on purpose — mirrors titlingResumeService's TITLING_RESUME_STALE_MIN=15.
// Must be materially larger than RESUME_STALE_MIN (5): RESUME_STALE_MIN is
// calibrated to OUR OWN renderOne's 60s beat (routes/ads.js:2822); a claim
// held by a DIFFERENT process has no such guarantee from here — its own
// heartbeat (if any) can lag under load, miss a write, or stop while work is
// still genuinely in flight, and titling can legitimately run long when
// serialized behind REMOTION_QUEUE_CONCURRENCY, so a short window would steal a
// live claim. A long one costs, at worst, wasted CPU on a redundant second pass
// IF the claim really is dead — never a double-SPEND (resumeForAd only peeks a
// free GET and only writes when the provider says done; this sweep never submits).
//
// Floored at RESUME_STALE_MIN, not a bare 1 — adversarial finding: a bare
// `Math.max(1, ...)` let an operator set RESUME_CLAIM_STALE_MIN=1 (or raise
// RESUME_STALE_MIN above the claimed default) and INVERT the whole point of
// this constant, making a claimed row easier to steal than an unclaimed one.
// That is exactly the misconfiguration that looks fine in a diff and only
// shows up as a dual Remotion render at 3am. Clamping here means the
// invariant holds for every caller of buildRecoverySweepFilter, not just the
// default-value assertions in F1/F1b below, which check defaults only.
const RESUME_CLAIM_STALE_MIN = Math.max(RESUME_STALE_MIN, parseInt(process.env.RESUME_CLAIM_STALE_MIN, 10) || 15);

function enabled() {
  return String(process.env.RESUME_IN_FLIGHT_ON_BOOT ?? 'true').toLowerCase() !== 'false';
}

/**
 * Pure decision for a recovered VIDEO prediction that settled FAILED: what to
 * write as the confirmed-charge flag, and whether the CostLog estimate needs
 * correcting to the settled figure. Extracted so the money-relevant part is
 * directly callable/testable (scripts/verifyVideoTimeoutReconcile.js) without
 * a DB or a fake `resumeForAd` — mirrors atlasVideoService.resolveTimeoutOutcome
 * / submitRetryDecision's role for other money decisions in this codebase.
 *
 * `r` is `resumeForAd`'s return shape for a failed peek: `{ charged, priceUsd,
 * predictionId, message, ... }`, where `charged` is the SAME tri-state
 * (true|false|null) atlasVideoService.confirmedCharge produces.
 *
 * @param {{charged?:*, priceUsd?:*, predictionId?:string}} r
 * @returns {{confirmedCharge:boolean, reconcile:{costUsd:number}|null}}
 */
function resolveRecoveredVideoFailureCharge(r) {
  const confirmedCharge = r?.charged === true;
  // Delegates to atlasVideoService.resolveFailureCostReconcile — the SAME
  // tri-state rule ("charged:false -> zero", "charged:true + real price ->
  // correct to it", "anything else -> leave untouched, never guess") now
  // governs both this recovered-after-restart path and the failed-in-the-
  // same-process path (atlasVideoService.generateForAd's final-failure
  // branch). Kept as a thin wrapper, not inlined, so this function's
  // `{charged, priceUsd}` shape (from resumeForAd/peekPrediction) stays the
  // public contract scripts/verifyVideoTimeoutReconcile.js pins.
  const reconcile = resolveFailureCostReconcile({
    chargeConfirmed: r?.charged,
    chargePriceUsd:  r?.priceUsd
  });
  return { confirmedCharge, reconcile };
}

/**
 * The sweep's candidate filter, as a pure function of both staleness
 * cutoffs. Exported so a harness can evaluate it against real document
 * shapes instead of regexing this file.
 *
 * Claim-aware (2026-08-26): an ad actively claimed by an adgen worker
 * (Ad.claimedByWorker set) can legitimately sit status:'rendering' with
 * a stale updatedAt while Remotion titling runs — the claiming process's
 * own heartbeat (if any) is not something this sweep can verify or rely
 * on. Sweeping it here would stamp status:'draft' +
 * titlingResumeState:'pending' out from under the live claim, corrupting
 * the status:'rendering' guard the claiming worker's own completion
 * write relies on to know it still owns the row — the DUAL-RENDER hole.
 * So a claimed row gets a MUCH longer staleness allowance
 * (RESUME_CLAIM_STALE_MIN, default 15m, mirrors
 * titlingResumeService.CLAIM_STALE_MIN's "generous on purpose"
 * convention) before this sweep treats the claiming worker as dead and
 * takes the row over anyway — this sweep's whole purpose is recovering
 * a paid asset a dead process can no longer deliver, so it must never
 * become a permanent no-op for claimed rows.
 *
 * HAS_RECEIPT is nested inside `$and`, never spread next to the claim
 * `$or`. HAS_RECEIPT is itself `{ $or: [...] }`; two top-level `$or`
 * keys in one object would silently drop the receipt guard.
 *
 * TWO CLOCKS on the claimed arm, both required stale, on purpose. `claimedAt`
 * is stamped ONCE, at claim time, and never refreshed — it answers "how old
 * is this ownership", not "is the work still moving". `updatedAt` is what
 * (if anything) heartbeats during the work itself. Gating on `updatedAt`
 * alone has a real hole: a HANDOFF — the titler clearing a claim for
 * reclaim, or a fresh `claimOne()` winning it — writes `claimedByWorker`
 * without touching `updatedAt` at all (adversarial finding), so a row could
 * carry a SECONDS-old claim sitting on an `updatedAt` that predates it by
 * well over claimCutoff and be swept immediately. Requiring `claimedAt` to
 * ALSO be stale closes exactly that: a brand-new claim's `claimedAt` is
 * fresh regardless of what `updatedAt` last said, so it is protected from
 * the moment it is taken, not only once something first heartbeats it.
 * `claimedAt: null` (legacy/unstamped claims) sorts before any real Date in
 * Mongo's BSON ordering, so `$lt` still matches — such a claim gets no
 * EXTRA protection from this clause, which is the correct fallback: rely on
 * `updatedAt` alone, exactly as before this clause existed.
 *
 * `receiptKinds` narrows WHICH receipt a candidate must hold — 'both' (the
 * original HAS_RECEIPT $or), 'image', or 'video'. Exists so the video
 * ownership gate in resumeInFlightAds can EXCLUDE video rows from the query
 * itself, not just skip them once loaded (adversarial finding, second
 * round): `.limit(limit)` is shared across both kinds, sorted oldest-first,
 * and a deferred video row is never written — so it stays a candidate on
 * EVERY subsequent pass. Filtering it out only inside the loop still lets
 * it occupy a limit slot forever; once enough stranded video rows
 * accumulate (one mixed Meta+PMax product alone is 21 video rows) they can
 * fill the whole limit and starve image recovery entirely, which is exactly
 * the "must keep running" job this gate is not supposed to touch. Excluding
 * video at the query level keeps every limit slot available for the work
 * this process still owns.
 *
 * @param {Date} cutoff       unclaimed rows older than this are swept
 * @param {Date} claimCutoff  claimed rows older than this are swept
 * @param {'both'|'image'|'video'} [receiptKinds='both']
 */
function buildRecoverySweepFilter({ cutoff, claimCutoff, receiptKinds = 'both' }) {
  // 'image' and 'video' must be MUTUALLY EXCLUSIVE and together cover
  // exactly what HAS_RECEIPT covers, matching the loop's own tie-break rule
  // below (`isImageReceipt = !ad.veoPredictionId && !!ad.imageGeneration
  // ?.predictionId` — video wins a tie). A row holding BOTH receipts is
  // 'video' kind, never 'image' kind, so 'image' must ALSO require
  // veoPredictionId to be absent/empty — omitting that half would let a
  // dual-receipt row pass the video ownership gate's query-level exclusion
  // (it has an image receipt) and then still fall into the video branch in
  // the loop (video wins the tie), defeating the gate for that row.
  const receiptClause = receiptKinds === 'image'
    ? { veoPredictionId: { $in: [null, ''] }, 'imageGeneration.predictionId': { $nin: [null, ''] } }
    : receiptKinds === 'video'
      ? { veoPredictionId: { $nin: [null, ''] } }
      : HAS_RECEIPT;
  return {
    status: 'rendering',
    $and: [
      receiptClause,
      {
        $or: [
          { claimedByWorker: null, updatedAt: { $lt: cutoff } },
          {
            claimedByWorker: { $ne: null },
            updatedAt: { $lt: claimCutoff },
            claimedAt: { $lt: claimCutoff }
          }
        ]
      }
    ]
  };
}

/**
 * Find receipt-holding ads stranded in `rendering` and collect whatever the
 * provider finished. Returns a summary; NEVER throws — a recovery pass must not
 * be able to take down the boot it runs inside, which is the exact crash class
 * (an unhandled rejection in fire-and-forget work) that motivated all of this.
 */
async function resumeInFlightAds({
  limit = RESUME_MAX_ADS,
  staleMinutes = RESUME_STALE_MIN,
  claimStaleMinutes = RESUME_CLAIM_STALE_MIN,
  // Injectable so the harness can exercise image recovery without network.
  recoverImage = recoverImageAd
} = {}) {
  const out = {
    considered: 0, recovered: 0, failed: 0, stillRunning: 0, unknown: 0, skipped: false,
    // Static images whose paid output was located but finishPlate/upload could
    // not complete this pass (fetch blip, geometry, etc.). Retried next sweep.
    // NOT "we refuse to collect" — collection is recoverImageAd below.
    recoverableNotCollected: 0,
    // Video-receipt rows left untouched because adgen owns rendering — see
    // the ADGEN OWNERSHIP header comment. Counted separately from
    // recoverableNotCollected: this is not "we tried and couldn't", it is
    // "someone else's job right now", and the two must not be conflated in
    // an operator-facing summary.
    deferredToAdgen: 0
  };
  if (!enabled()) { out.skipped = 'RESUME_IN_FLIGHT_ON_BOOT=false'; return out; }
  // Read once per pass, not per ad — a flag flip mid-pass should not treat
  // ads claimed in the same batch inconsistently. Call-time read (not a
  // module-load-time constant) so a dashboard flip still takes effect on
  // the very next pass with no redeploy, matching adgenBridge's own contract.
  const adgenOwnsRendering = isAdgenRendererEnabled();

  let ads;
  try {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const claimCutoff = new Date(Date.now() - claimStaleMinutes * 60 * 1000);
    // OWNER of the status:'rendering' + receipt population.
    // strandedRunSweeper owns queued/failed-run stranding; this service owns
    // mid-render / mid-QC crashes left in rendering. The worker reaper
    // (worker.js) deliberately leaves HAS_RECEIPT ads in rendering and only
    // requeues receiptFree — so recovery here cannot race a reaper requeue
    // into a second billable submit. RESUME_STALE_MIN (default 5) is also
    // lower than REAP_STALE_MIN (15): we collect before the reaper even
    // considers the row.
    //
    // Claim-aware: an adgen-claimed row can sit status:'rendering' with a
    // stale updatedAt through titling — its own heartbeat, if any, is not
    // something this process can verify. The 5-min unclaimed window would
    // steal a live claim and stamp draft + titlingResumeState pending out
    // from under the worker. Claimed rows use claimCutoff
    // (RESUME_CLAIM_STALE_MIN, default 15) so a dead worker is still
    // recovered. Filter is buildRecoverySweepFilter — HAS_RECEIPT nested
    // in $and, never spread next to the claim $or.
    //
    // ADGEN OWNS RENDERING: the query itself excludes video-receipt rows
    // (receiptKinds:'image'), not just the loop below — adversarial finding,
    // second round. `.limit(limit)` is shared and a deferred video row is
    // never written, so it would stay a candidate on EVERY subsequent pass;
    // excluding it here (rather than fetching then skipping) keeps every
    // limit slot available for the image recovery this process still owns.
    // See the ADGEN OWNERSHIP header comment for the full argument.
    const receiptKinds = adgenOwnsRendering ? 'image' : 'both';
    ads = await Ad.find(buildRecoverySweepFilter({ cutoff, claimCutoff, receiptKinds }))
      // imageGeneration is selected because HAS_RECEIPT/the 'image' clause
      // matches on imageGeneration.predictionId — see the routing note in
      // the loop below. Selecting only veoPredictionId is what made every stranded
      // STATIC ad fall through to the video resume and get written off as 'unknown'.
      // Full lean doc for recoverImageAd (platformFormat, mediaId, brandId, …).
      .sort({ updatedAt: 1 })          // oldest first — most likely already finished
      .limit(limit)
      .lean();

    // Deferred-video VISIBILITY only — a separate, limit-free count so the
    // operator-facing summary still says how many paid masters are sitting
    // out there, without letting them consume a single slot of `limit` that
    // image recovery needs. Never gates or delays the find above; a count
    // failure is non-fatal and simply leaves deferredToAdgen at 0 for this
    // pass (retried next tick, same as everything else in this file).
    if (adgenOwnsRendering) {
      out.deferredToAdgen = await Ad.countDocuments(
        buildRecoverySweepFilter({ cutoff, claimCutoff, receiptKinds: 'video' })
      ).catch((err) => {
        console.warn(`⚠️  bootRecovery: could not count deferred video ads — ${err.message}`);
        return 0;
      });
      if (out.deferredToAdgen > 0) {
        console.log(
          `♻️  bootRecovery: ${out.deferredToAdgen} video-receipt ad(s) left untouched — ` +
          `adgen owns rendering (ADGEN_RENDERER_ENABLED=true)`
        );
      }
    }
  } catch (err) {
    console.warn(`⚠️  bootRecovery: could not query stranded ads — ${err.message}`);
    return out;
  }
  out.considered = ads.length;
  if (!ads.length) return out;

  console.log(
    `♻️  bootRecovery: ${ads.length} ad(s) stranded in rendering with a spend receipt ` +
    `(>${staleMinutes}m stale) — polling receipts, never re-submitting`
  );

  for (const ad of ads) {
    // ROUTE BY WHICH RECEIPT THE AD ACTUALLY HOLDS, never by ad.kind — kind is not
    // always populated on a stranded row, whereas the receipt is the thing that
    // proves what was bought. Video wins a tie: if somehow both are present, the
    // Omni master is the expensive one (~$1.00 vs ~$0.07).
    const isImageReceipt = !ad.veoPredictionId && !!ad.imageGeneration?.predictionId;

    // ── ADGEN OWNS RENDERING: belt-and-braces, should be unreachable ──────
    // The query above already excludes video rows when adgenOwnsRendering,
    // so `ads` should never contain one here. Kept anyway: the query filter
    // and this check are two independently-maintainable mechanisms, and a
    // future edit to ONE of them (e.g. a new receipt shape, a refactored
    // query) must not silently reopen the video-recovery-while-adgen-owns-
    // rendering hole this file exists to close. Does not touch
    // deferredToAdgen — that counter is owned by the countDocuments call
    // above; if this branch ever fires it means the two mechanisms have
    // drifted apart, which is worth a distinct log line, not a silent merge
    // into the same counter.
    if (!isImageReceipt && adgenOwnsRendering) {
      console.warn(
        `⚠️  bootRecovery[${ad._id}]: video row reached the loop while adgen owns rendering — ` +
        `the query-level exclusion should have prevented this; skipping without acting`
      );
      continue;
    }

    // ── STATIC IMAGE: finish the already-paid plate (crop + logo + upload) ──
    // recoverImageAd peeks, fetches, finishPlate, uploads, optional vision QC.
    // ZERO image submits. Status-filtered write; never stamps raw Atlas URL.
    if (isImageReceipt) {
      let ir;
      try {
        ir = await recoverImage({ ad });
      } catch (err) {
        out.unknown++;
        console.warn(`   ⚠️  bootRecovery[${ad._id}]: image recover threw — ${err.message}`);
        continue;
      }
      if (ir.state === 'recovered') {
        out.recovered++;
        console.log(
          `   ✅ bootRecovery[${ad._id}]: static plate recovered from receipt ${ir.predictionId}` +
          `${ir.qcFailed ? ' (vision QC failed — kept paid render, status failed)' : ''} — $0 image submit`
        );
        continue;
      }
      if (ir.state === 'processing' || ir.state === 'unknown') {
        out.stillRunning++;
        continue;
      }
      if (ir.state === 'failed') {
        // Atlas says the prediction failed. Charge is CONFIRMED only when peek
        // published a positive price (same rule as the video failure path).
        try {
          const confirmedCharge = ir.priceConfirmed === true && Number(ir.price) > 0;
          const chargeNote = ir.priceConfirmed !== true
            ? ' [charge UNCONFIRMED — Atlas published no price for this prediction; stored as not-charged because the schema cannot express "unknown"]'
            : '';
          await Ad.updateOne(
            { _id: ad._id, status: 'rendering' },
            { $set: {
              status: 'failed',
              updatedAt: new Date(),
              'renderError.message': (ir.message || 'prediction failed') + chargeNote,
              'renderError.stage': 'resume',
              'renderError.at': new Date(),
              'renderError.predictionId': ad.imageGeneration?.predictionId || null,
              'renderError.charged': confirmedCharge
            } }
          );
          if (confirmedCharge && ir.predictionId) {
            reconcileCost({ providerRequestId: ir.predictionId, costUsd: Number(ir.price) })
              .catch(() => {});
          }
          out.failed++;
        } catch (err) {
          console.warn(`   ⚠️  bootRecovery[${ad._id}]: could not record image failure — ${err.message}`);
          out.unknown++;
        }
        continue;
      }
      if (ir.state === 'no-receipt') {
        out.unknown++;
        continue;
      }
      // unrecoverable this pass (geometry / upload / already resolved) — leave
      // in rendering for a later retry, or already-resolved is a no-op.
      out.recoverableNotCollected++;
      console.warn(
        `   ⚠️  bootRecovery[${ad._id}]: image recover ${ir.state} — ${ir.message || 'no detail'}`
      );
      continue;
    }

    let r;
    try {
      r = await resumeForAd({ ad });
    } catch (err) {
      // resume is not supposed to throw; if it does, that must not end
      // the pass and lose the remaining ads.
      out.unknown++;
      console.warn(`   ⚠️  bootRecovery[${ad._id}]: resume threw — ${err.message}`);
      continue;
    }

    if (r.state === 'done' && r.videoUrl) {
      try {
        // `status: 'rendering'` in the FILTER is what makes this safe without a
        // lease: a concurrent instance that got there first has already moved the
        // ad, so this becomes a no-op instead of a conflicting write.
        //
        // `draft` is the canonical resting state for a landed master — the
        // reaper-safe money guard from CLAUDE.md §00 step 4. The ad is now
        // immediately VIEWABLE (renderUrl / posterUrl / kind written so
        // projectAd can serialise an asset) and is claimed for titling via the
        // renderStage sentinel (TITLING_PENDING). Do NOT requeue — the normal
        // render path declares veoVideoUrl fresh and never reads ad.veoVideoUrl,
        // so a requeue would re-submit to Omni. Titling is resumed by
        // services/titlingResumeService on the web process.
        // The alternative — leaving it `rendering` — invites the reaper and a
        // re-buy, which is the whole thing we are fixing.
        const poster = fallbackPosterUrl(r.videoUrl);
        const res = await Ad.updateOne(
          { _id: ad._id, status: 'rendering' },
          {
            $set: {
              veoVideoUrl: r.videoUrl,
              status: 'draft',
              kind: 'video',
              renderUrl: r.videoUrl,
              posterUrl: poster || r.videoUrl,
              // The real state the sweeper queries. NOT renderStage — adStage
              // (adStage.js:82-85) $sets renderStage all through titling, so a
              // sentinel parked there is clobbered seconds in and a crashed
              // render could never be re-swept. renderStage below is a
              // human-readable breadcrumb only.
              titlingResumeState: STATE_PENDING,
              renderStage: TITLING_PENDING,
              renderStageAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        if (res.modifiedCount > 0) {
          out.recovered++;
          console.log(
            `   ✅ bootRecovery[${ad._id}]: master recovered from receipt ${r.predictionId} — queued for titling`
          );
          // COST RECONCILE (2026-08-19). Recovering the asset used to leave the
          // charge-point CostLog row exactly as it was written at submit —
          // costSource:'estimated', status:'submitted' — forever. A recovered
          // master IS a settled prediction (peekPrediction's done branch now
          // reads `price` back, same as pollPrediction's own success path), so
          // reconcile it the same way a normal completion would.
          // reconcileVideoCostFromTerminal is itself fire-and-forget (it never
          // returns a promise the caller must await) — matches every other
          // reconcile call on this path: telemetry must never gate or delay the
          // recovery write above, which has already happened.
          reconcileVideoCostFromTerminal(r.predictionId, { price: r.price ?? null });
        }
      } catch (err) {
        console.warn(`   ⚠️  bootRecovery[${ad._id}]: recovered but could not persist — ${err.message}`);
        out.unknown++;
      }
      continue;
    }

    if (r.state === 'failed') {
      try {
        // VIDEO failure path. Static receipts never reach this branch (handled
        // in the image branch above via recoverImageAd).
        //
        // ── CHARGE: CONFIRMED, NOT ASSUMED (owner rule, CLAUDE.md §2) ────────
        // FIXED 2026-08-19 — this used to hardcode `confirmedCharge = true` for
        // every video failure, with a comment claiming "peekPrediction does not
        // read price back, so there is nothing to confirm against". That is no
        // longer true (and measured 2026-08-10 in CLAUDE.md §2 that 5/5 FAILED
        // video predictions carry NO price field — Atlas refunds a failed
        // generation): peekPrediction's failed branch already spreads
        // confirmedCharge(data) into its return, so `r.charged` /
        // `r.priceUsd` are the SAME confirmed-price read the mid-poll branch
        // uses, just never consulted here. The hardcoded `true` meant a
        // recovered failed master permanently overstated spend by the full
        // ~$0.90–1.20 estimate even when Atlas confirms it never billed.
        // `r.charged` is a TRI-STATE (true|false|null) — null (unknown) leaves
        // the ledger exactly as it was, matching the "unknown stays unknown"
        // rule everywhere else in this file.
        const { confirmedCharge, reconcile } = resolveRecoveredVideoFailureCharge(r);
        if (reconcile) {
          reconcileCost({ providerRequestId: r.predictionId, costUsd: reconcile.costUsd }).catch(() => {});
        }
        await Ad.updateOne(
          { _id: ad._id, status: 'rendering' },
          { $set: {
            status: 'failed',
            updatedAt: new Date(),
            'renderError.message':      r.message || 'prediction failed',
            'renderError.stage':        'resume',
            'renderError.at':           new Date(),
            'renderError.predictionId': ad.veoPredictionId || ad.imageGeneration?.predictionId || null,
            'renderError.charged':      confirmedCharge
          } }
        );
        out.failed++;
      } catch (err) {
        console.warn(`   ⚠️  bootRecovery[${ad._id}]: could not record failure — ${err.message}`);
      }
      continue;
    }

    // 'processing' — genuinely still running at the provider. LEAVE IT ALONE.
    // 'unknown'    — we could not tell (transport error, non-200, missing key).
    //                Also leave it alone: acting on ignorance is how a paid asset
    //                gets written off. Both are retried on the next pass.
    if (r.state === 'processing') out.stillRunning++;
    else out.unknown++;
  }

  // A located-but-uncollected paid image is also worth waking someone for: the money
  // is spent and the asset is sitting at Atlas, so it belongs in the same report
  // rather than only in a log line nobody greps.
  const touched = out.recovered + out.failed + out.recoverableNotCollected;
  if (touched > 0) {
    console.log(
      `♻️  bootRecovery: ${out.recovered} recovered · ${out.failed} failed · ` +
      `${out.recoverableNotCollected} paid-but-uncollected · ` +
      `${out.stillRunning} still running · ${out.unknown} unknown`
    );
    // Worth waking someone for: money was recovered, confirmed lost, or is sitting
    // paid-for and undelivered.
    alerts.notifyAsync({
      level: out.recovered > 0 ? 'info' : 'warn',
      title: out.recovered > 0
        ? `Recovered ${out.recovered} paid generation(s) after a restart`
        : out.recoverableNotCollected > 0
          ? `${out.recoverableNotCollected} paid image(s) located but not finished this pass`
          : `${out.failed} paid generation(s) confirmed failed after a restart`,
      key: 'boot-recovery',
      fields: {
        recovered: out.recovered || undefined,
        failed: out.failed || undefined,
        'not finished this pass': out.recoverableNotCollected || undefined,
        'still running': out.stillRunning || undefined,
        unknown: out.unknown || undefined
      }
    });
  }
  return out;
}

module.exports = {
  resumeInFlightAds, RESUME_STALE_MIN, RESUME_MAX_ADS, enabled,
  // Money-decision pure function — scripts/verifyVideoTimeoutReconcile.js.
  resolveRecoveredVideoFailureCharge,
  // Claim-aware sweep filter + the longer claimed-row TTL. Exported so a
  // harness can evaluate the real query against real document shapes.
  buildRecoverySweepFilter, RESUME_CLAIM_STALE_MIN
};
