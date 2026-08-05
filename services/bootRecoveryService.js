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
// Static-image counterpart. Also a free, no-submit GET — see its header for why a
// located image is not yet a deliverable ad.
const { resumeImageForAd } = require('./atlasImageService');
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
 * Find receipt-holding ads stranded in `rendering` and collect whatever the
 * provider finished. Returns a summary; NEVER throws — a recovery pass must not
 * be able to take down the boot it runs inside, which is the exact crash class
 * (an unhandled rejection in fire-and-forget work) that motivated all of this.
 */
async function resumeInFlightAds({ limit = RESUME_MAX_ADS, staleMinutes = RESUME_STALE_MIN } = {}) {
  const out = {
    considered: 0, recovered: 0, failed: 0, stillRunning: 0, unknown: 0, skipped: false,
    // Static images whose paid output EXISTS at Atlas but cannot be delivered yet
    // (needs the post-model crop + logo + upload). Counted separately and never
    // folded into `recovered` — reporting these as recovered would claim ads that
    // are not on the ads page.
    recoverableNotCollected: 0
  };
  if (!enabled()) { out.skipped = 'RESUME_IN_FLIGHT_ON_BOOT=false'; return out; }

  let ads;
  try {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    ads = await Ad.find({ status: 'rendering', updatedAt: { $lt: cutoff }, ...HAS_RECEIPT })
      // imageGeneration is selected because HAS_RECEIPT matches on BOTH receipts
      // (veoPredictionId OR imageGeneration.predictionId) — see the routing note in
      // the loop below. Selecting only veoPredictionId is what made every stranded
      // STATIC ad fall through to the video resume and get written off as 'unknown'.
      .select('_id veoPredictionId imageGeneration kind')
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

    let r;
    try {
      r = isImageReceipt ? await resumeImageForAd({ ad }) : await resumeForAd({ ad });
    } catch (err) {
      // Neither resume is supposed to throw; if one ever does, that must not end
      // the pass and lose the remaining ads.
      out.unknown++;
      console.warn(`   ⚠️  bootRecovery[${ad._id}]: resume threw — ${err.message}`);
      continue;
    }

    // ── STATIC IMAGE, ASSET LOCATED BUT NOT DELIVERABLE ─────────────────────
    // A static ad's Atlas output is NOT a finished ad: directImageRenderService
    // still has to apply the delivery crop and the logo composite (~:1090) and
    // upload to Cloudinary. Stamping r.imageUrl onto renderUrl would ship an
    // uncropped, unbranded image AS IF the render had succeeded — the one outcome
    // worse than not recovering it. So this reports and alerts, and deliberately
    // does NOT transition the ad. The money is already spent either way; what is
    // missing is the post-model half of the render, which is not yet callable
    // standalone. Tracked as the remaining piece of image recovery.
    if (isImageReceipt && r.state === 'done' && r.imageUrl) {
      out.recoverableNotCollected++;
      console.warn(
        `   💸 bootRecovery[${ad._id}]: PAID image is available at receipt ${r.predictionId} ` +
        `but cannot be delivered yet (needs crop + logo + upload) — left in 'rendering'. ` +
        `Atlas output: ${r.imageUrl}`
      );
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
        }
      } catch (err) {
        console.warn(`   ⚠️  bootRecovery[${ad._id}]: recovered but could not persist — ${err.message}`);
        out.unknown++;
      }
      continue;
    }

    if (r.state === 'failed') {
      try {
        // ── CHARGE: CONFIRMED, NOT ASSUMED (owner rule, CLAUDE.md §2) ────────
        // A receipt proves a SUBMIT happened; it does not prove a CHARGE. Atlas
        // refunds failed tasks, and the authoritative figure is `price` on the
        // settled prediction — so for images, where peekImagePrediction reads that
        // price back, the flag comes from Atlas's own answer:
        //
        //   priceConfirmed && price > 0  -> charged (and reconcile to the real
        //                                   number, which base_price understates
        //                                   by ~7.17x on gpt-image-2)
        //   priceConfirmed && price == 0 -> genuinely not charged (refunded)
        //   !priceConfirmed              -> UNKNOWN. See the honesty gap below.
        //
        // ⚠️ HONESTY GAP, deliberately surfaced rather than papered over:
        // models/Ad.js declares `renderError.charged` as {type: Boolean,
        // default:false}, so the schema CANNOT represent "unknown" — and
        // renderService.js:1440 already collapses a null policy.charged to false
        // via `err.charged === true`. So an unconfirmed charge is stored as
        // `false`, i.e. as "free", which understates spend — the one direction the
        // ledger can never be corrected in. Representing it truthfully needs a
        // schema change (tri-state, or a companion `chargeConfirmed`), which is
        // NOT bundled here. What this code does instead is refuse to make the
        // opposite error: it never claims `true` without Atlas saying so, and it
        // records the uncertainty in the message so the row is not silently wrong.
        const isImage = isImageReceipt;
        const confirmedCharge = isImage
          ? (r.priceConfirmed === true && Number(r.price) > 0)
          // VIDEO IS UNCHANGED ON PURPOSE. atlasVideoService.peekPrediction does
          // not read `price` back, so there is nothing to confirm against; some
          // video models also bill on completion rather than submit. Changing
          // video's billing semantics is its own reviewed change, not a
          // side-effect of the image fix.
          : true;
        const chargeNote = isImage && r.priceConfirmed !== true
          ? ' [charge UNCONFIRMED — Atlas published no price for this prediction; stored as not-charged because the schema cannot express "unknown"]'
          : '';

        await Ad.updateOne(
          { _id: ad._id, status: 'rendering' },
          { $set: {
            status: 'failed',
            updatedAt: new Date(),
            'renderError.message':      (r.message || 'prediction failed') + chargeNote,
            'renderError.stage':        'resume',
            'renderError.at':           new Date(),
            // Whichever receipt this ad actually holds — hardcoding veoPredictionId
            // wrote null for every static ad, losing the only handle to the spend.
            'renderError.predictionId': ad.veoPredictionId || ad.imageGeneration?.predictionId || null,
            'renderError.charged':      confirmedCharge
          } }
        );
        // Upgrade the ledger to Atlas's real figure when we have it. Non-fatal:
        // reconcileCost only touches rows still marked costSource:'estimated'.
        if (isImage && r.priceConfirmed === true && Number(r.price) > 0 && r.predictionId) {
          reconcileCost({ providerRequestId: r.predictionId, costUsd: Number(r.price) })
            .catch(() => {});
        }
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
          ? `${out.recoverableNotCollected} paid image(s) available at Atlas but not yet deliverable`
          : `${out.failed} paid generation(s) confirmed failed after a restart`,
      key: 'boot-recovery',
      fields: {
        recovered: out.recovered || undefined,
        failed: out.failed || undefined,
        'paid but uncollected': out.recoverableNotCollected || undefined,
        'still running': out.stillRunning || undefined,
        unknown: out.unknown || undefined
      }
    });
  }
  return out;
}

module.exports = { resumeInFlightAds, RESUME_STALE_MIN, RESUME_MAX_ADS, enabled };
