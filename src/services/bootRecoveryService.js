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
// ── WHY THE STALENESS WINDOW EXISTS ─────────────────────────────────────────
// An ad being rendered RIGHT NOW by another live instance is also
// `status: 'rendering'` with a receipt. Peeking it is harmless, but stamping it
// `draft` underneath its owner would race the owner's own completion write.
// renderOne heartbeats `updatedAt` every 60s, so an ad untouched for
// RESUME_STALE_MIN minutes has missed several beats and is not being actively
// rendered by anyone. Default 5 = five missed heartbeats.

const Ad = require('../models/Ad');
const { HAS_RECEIPT } = require('./spendReceipt');
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
 * Find receipt-holding ads stranded in `rendering` and collect whatever the
 * provider finished. Returns a summary; NEVER throws — a recovery pass must not
 * be able to take down the boot it runs inside, which is the exact crash class
 * (an unhandled rejection in fire-and-forget work) that motivated all of this.
 */
async function resumeInFlightAds({
  limit = RESUME_MAX_ADS,
  staleMinutes = RESUME_STALE_MIN,
  // Injectable so the harness can exercise image recovery without network.
  recoverImage = recoverImageAd
} = {}) {
  const out = {
    considered: 0, recovered: 0, failed: 0, stillRunning: 0, unknown: 0, skipped: false,
    // Static images whose paid output was located but finishPlate/upload could
    // not complete this pass (fetch blip, geometry, etc.). Retried next sweep.
    // NOT "we refuse to collect" — collection is recoverImageAd below.
    recoverableNotCollected: 0
  };
  if (!enabled()) { out.skipped = 'RESUME_IN_FLIGHT_ON_BOOT=false'; return out; }

  let ads;
  try {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    // OWNER of the status:'rendering' + receipt population.
    // strandedRunSweeper owns queued/failed-run stranding; this service owns
    // mid-render / mid-QC crashes left in rendering. The worker reaper
    // (worker.js) deliberately leaves HAS_RECEIPT ads in rendering and only
    // requeues receiptFree — so recovery here cannot race a reaper requeue
    // into a second billable submit. RESUME_STALE_MIN (default 5) is also
    // lower than REAP_STALE_MIN (15): we collect before the reaper even
    // considers the row.
    ads = await Ad.find({ status: 'rendering', updatedAt: { $lt: cutoff }, ...HAS_RECEIPT })
      // imageGeneration is selected because HAS_RECEIPT matches on BOTH receipts
      // (veoPredictionId OR imageGeneration.predictionId) — see the routing note in
      // the loop below. Selecting only veoPredictionId is what made every stranded
      // STATIC ad fall through to the video resume and get written off as 'unknown'.
      // Full lean doc for recoverImageAd (platformFormat, mediaId, brandId, …).
      .sort({ updatedAt: 1 })          // oldest first — most likely already finished
      .limit(limit)
      .lean();
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
  resolveRecoveredVideoFailureCharge
};
