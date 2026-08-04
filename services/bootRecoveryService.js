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
const { resumeForAd } = require('./atlasVideoService');
const alerts = require('./alertService');

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
 * Find receipt-holding ads stranded in `rendering` and collect whatever the
 * provider finished. Returns a summary; NEVER throws — a recovery pass must not
 * be able to take down the boot it runs inside, which is the exact crash class
 * (an unhandled rejection in fire-and-forget work) that motivated all of this.
 */
async function resumeInFlightAds({ limit = RESUME_MAX_ADS, staleMinutes = RESUME_STALE_MIN } = {}) {
  const out = { considered: 0, recovered: 0, failed: 0, stillRunning: 0, unknown: 0, skipped: false };
  if (!enabled()) { out.skipped = 'RESUME_IN_FLIGHT_ON_BOOT=false'; return out; }

  let ads;
  try {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    ads = await Ad.find({ status: 'rendering', updatedAt: { $lt: cutoff }, ...HAS_RECEIPT })
      .select('_id veoPredictionId')
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
    let r;
    try {
      r = await resumeForAd({ ad });
    } catch (err) {
      // resumeForAd is not supposed to throw; if it ever does, that must not end
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
        // reaper-safe money guard from CLAUDE.md §00 step 4. Titling has NOT run,
        // so this ad is deliberately untitled; §00 is explicit that an untitled
        // master is not success, and it stays draft until titling completes
        // through the normal path. The alternative — leaving it `rendering` —
        // invites the reaper and a re-buy, which is the whole thing we are fixing.
        const res = await Ad.updateOne(
          { _id: ad._id, status: 'rendering' },
          { $set: { veoVideoUrl: r.videoUrl, status: 'draft', updatedAt: new Date() } }
        );
        if (res.modifiedCount > 0) {
          out.recovered++;
          console.log(`   ✅ bootRecovery[${ad._id}]: master recovered from receipt ${r.predictionId} — stamped draft (untitled)`);
        }
      } catch (err) {
        console.warn(`   ⚠️  bootRecovery[${ad._id}]: recovered but could not persist — ${err.message}`);
        out.unknown++;
      }
      continue;
    }

    if (r.state === 'failed') {
      try {
        await Ad.updateOne(
          { _id: ad._id, status: 'rendering' },
          { $set: {
            status: 'failed',
            updatedAt: new Date(),
            // charged: true is not a guess. A receipt exists, so the provider
            // billed us. Recording it false would understate spend, and an
            // understated ledger is the one direction that is never correctable.
            'renderError.message':      r.message || 'prediction failed',
            'renderError.stage':        'resume',
            'renderError.at':           new Date(),
            'renderError.predictionId': ad.veoPredictionId,
            'renderError.charged':      true
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

  const touched = out.recovered + out.failed;
  if (touched > 0) {
    console.log(
      `♻️  bootRecovery: ${out.recovered} recovered · ${out.failed} failed · ` +
      `${out.stillRunning} still running · ${out.unknown} unknown`
    );
    // Worth waking someone for: money was recovered, or money was confirmed lost.
    alerts.notifyAsync({
      level: out.recovered > 0 ? 'info' : 'warn',
      title: out.recovered > 0
        ? `Recovered ${out.recovered} paid generation(s) after a restart`
        : `${out.failed} paid generation(s) confirmed failed after a restart`,
      key: 'boot-recovery',
      fields: {
        recovered: out.recovered || undefined,
        failed: out.failed || undefined,
        'still running': out.stillRunning || undefined,
        unknown: out.unknown || undefined
      }
    });
  }
  return out;
}

module.exports = { resumeInFlightAds, RESUME_STALE_MIN, RESUME_MAX_ADS, enabled };
