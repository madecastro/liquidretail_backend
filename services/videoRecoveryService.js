'use strict';
//
// VIDEO RECOVERY — finish a stranded video ad we have ALREADY PAID FOR.
//
// WHY (2026-08-19). services/strandedRunSweeper.js recovers stranded `queued`
// ads BEFORE requeuing them, on the rule "a receipt-holding ad is already paid
// for; recover it for $0 instead of buying it again." Its default recovery
// function was recoverImageAd alone — which is structurally image-only: it
// reads only ad.imageGeneration.predictionId and returns 'no-receipt' for
// anything where that is empty. A video ad's receipt lives on a DIFFERENT
// field, Ad.veoPredictionId (services/spendReceipt.js), which recoverImageAd
// never looks at. So every renderRoute:'veo' ad reaching the sweeper's
// recovery pass was reported 'no-receipt' regardless of whether it actually
// held a receipt, and fell straight through to a fresh, billable Omni submit.
//
// This module is the video counterpart, mirroring imageRecoveryService's
// contract exactly so services/strandedRunSweeper.js can dispatch to either by
// ad.renderRoute (see recoverStrandedAd there) without changing its own
// pass-1/pass-2 loop:
//   { state: 'recovered', predictionId, videoUrl }   finished and persisted
//   { state: 'no-receipt' }                          nothing was ever bought
//   { state: 'processing' }                          still running; try later
//   { state: 'unknown', message }                    could not tell; DO NOT act
//   { state: 'failed', message }                     Atlas says the task failed
//   { state: 'unrecoverable', message }              receipt exists, can't finish
//
// ── CLAIM FIRST, PEEK SECOND ────────────────────────────────────────────────
// recoverVideoAd used to peek the receipt (resumeForAd → peekPrediction, a GET
// with a 20s axios timeout) WHILE the ad was still status:'queued', and only
// afterward write anything. A guard on that later write cannot undo a SUBMIT
// that already happened on a completely separate code path:
//
//   For the entire peek window (up to ~20s) the ad is still status:'queued' —
//   the exact pool selectAdsForRun / claimAdsForRun claim from, and NEITHER
//   has any receipt exclusion. A concurrent "Generate more" can win this SAME
//   ad and submit a fresh, billable Omni request (routes/ads.js render path →
//   atlasVideoService.submitGeneration, with no existing-receipt check) WHILE
//   this module is still peeking the OLD receipt. The two Ad.updateOne calls
//   that used to sit after the peek (guarded on status:'queued' +
//   veoPredictionId) correctly prevent that concurrent claim's in-flight
//   render from being CLOBBERED by this module's later write — modifiedCount
//   becomes 0 and we back off — but preventing clobber is not the same as
//   preventing the double-bill; the double-bill already happened the moment
//   the concurrent claim's submit fired.
//
//   So we take the ad OFF the claimable 'queued' pool FIRST (atomic
//   status:'queued' → 'rendering' CAS on the same receipt), THEN peek. If
//   the CAS loses, another process already owns the ad and we return
//   unrecoverable without ever calling the network. If it wins, the ad is
//   no longer selectable by selectAdsForRun / claimAdsForRun for the rest
//   of this function, including the peek.
//
// ── WHY THIS IS NOT bootRecoveryService ─────────────────────────────────────
// bootRecoveryService recovers ads stranded in `status:'rendering'` (a
// mid-render / mid-QC crash) and runs with no claim/lease, because autoscaling
// means several instances may boot at once. strandedRunSweeper recovers ads
// stranded in `status:'queued'` by a SIGTERM requeue whose run was marked
// failed — a different scope with its own filter (buildStrandedAdFilter). This
// module's first act is to claim those queued rows into 'rendering' so a
// concurrent Generate-more cannot re-buy them; after that, a still-running /
// unknown / failed peek is already in the state bootRecoveryService's
// periodic recoverTick (HAS_RECEIPT + status:'rendering') owns. Both
// ultimately peek the SAME receipt via the SAME no-submit helper
// (atlasVideoService.resumeForAd) and write the SAME draft-plus-titling-pending
// shape on success, by design: one write shape, read by titlingResumeService,
// however the ad got stranded.
//
// ── NO VIDEO SUBMIT, STRUCTURALLY ───────────────────────────────────────────
// This module must never import or reach atlasVideoService.submitGeneration (or
// any other submit path). Its only provider call is resumeForAd, itself a
// single free GET (atlasVideoService.peekPrediction) — asserted never to
// submit by scripts/verifyVideoResume.js. Asserted on THIS module's source by
// scripts/verifyStrandedSweep.js.

const Ad = require('../models/Ad');
const { resumeForAd, reconcileVideoCostFromTerminal } = require('./atlasVideoService');
// Same writer titlingResumeService reads — reusing these (rather than
// re-deriving the poster or inventing a new sentinel) is what keeps
// bootRecoveryService's video-recovery write and this one from drifting apart.
const {
  STATE_PENDING,
  TITLING_PENDING,
  fallbackPosterUrl
} = require('./titlingResumeService');

/**
 * Recover ONE video ad from its spend receipt (Ad.veoPredictionId).
 *
 * Returns a verdict rather than throwing — a caller sweeping many ads must
 * never be derailed by one bad row. Mirrors recoverImageAd's contract so
 * services/strandedRunSweeper.js's pass-1 loop (recovered / no-receipt /
 * processing|unknown / anything else) needs no change to handle video too.
 */
async function recoverVideoAd({ ad } = {}) {
  const predictionId = ad?.veoPredictionId || null;
  if (!predictionId) return { state: 'no-receipt' };

  // Take the ad off the claimable 'queued' pool BEFORE any network call. A
  // concurrent selectAdsForRun / claimAdsForRun has no receipt exclusion, and
  // the render path submits a fresh Omni request with no existing-receipt
  // check — so peeking while still 'queued' is a live double-bill window of
  // up to ~20s (peekPrediction's axios timeout). A later write-guard cannot
  // undo a submit that already happened on that other path. If this CAS
  // loses, another process already owns the row; do not peek.
  const claim = await Ad.updateOne(
    { _id: ad._id, status: 'queued', veoPredictionId: predictionId },
    { $set: { status: 'rendering', updatedAt: new Date() } }
  );
  if (!claim.modifiedCount) {
    return { state: 'unrecoverable', predictionId, message: 'ad already claimed by another pass' };
  }

  // resumeForAd wraps peekPrediction — a single free GET, never a submit (see
  // module header). Never re-implemented here so the two recovery call sites
  // (this one and bootRecoveryService) read the receipt identically. Safe to
  // call only because the claim above already moved us off 'queued'.
  const r = await resumeForAd({ ad });

  if (r.state === 'done' && r.videoUrl) {
    const poster = fallbackPosterUrl(r.videoUrl);
    // We already hold the exclusive claim (status is now 'rendering'). Guard
    // the persist write on that plus the same receipt so a concurrent writer
    // that somehow also holds the row is still a no-op rather than a clobber.
    // Defense in depth — the claim above should make this the only writer.
    const res = await Ad.updateOne(
      { _id: ad._id, status: 'rendering', veoPredictionId: predictionId },
      { $set: {
        veoVideoUrl:        r.videoUrl,
        status:             'draft',
        kind:               'video',
        renderUrl:          r.videoUrl,
        posterUrl:          poster || r.videoUrl,
        // Real state titlingResumeService queries; renderStage below is a
        // human-readable breadcrumb only (adStage overwrites it once titling
        // starts) — same split bootRecoveryService documents.
        titlingResumeState: STATE_PENDING,
        renderStage:        TITLING_PENDING,
        renderStageAt:      new Date(),
        updatedAt:          new Date()
      } }
    );
    if (!res.modifiedCount) {
      return { state: 'unrecoverable', predictionId, message: 'ad already resolved by another pass' };
    }
    // Fire-and-forget, like every other reconcile call on this path — telemetry
    // must never gate or delay the recovery write above, which already happened.
    reconcileVideoCostFromTerminal(predictionId, { price: r.price ?? null });
    return { state: 'recovered', predictionId, videoUrl: r.videoUrl };
  }

  if (r.state === 'processing' || r.state === 'unknown' || r.state === 'failed') {
    // Hand-off is already done: the claim above moved the ad to
    // status:'rendering' with its receipt intact, which is exactly the state
    // bootRecoveryService's periodic recoverTick (HAS_RECEIPT +
    // status:'rendering') already owns and resolves for all three of these
    // states (processing/unknown: leave, retry next tick; failed:
    // resolveRecoveredVideoFailureCharge). Do not issue a second write.
    // recoverTick runs periodically, not boot-only. RESUME_STALE_MIN keeps
    // it off this row until it is actually stale (updatedAt was just set by
    // the claim). A failed submit may still have been charged
    // (spendReceipt.js) — never requeue.
    return { state: r.state, predictionId, message: r.message || null };
  }

  return { state: 'unrecoverable', predictionId, message: `unexpected resume state '${r.state}'` };
}

module.exports = { recoverVideoAd };
