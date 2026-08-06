'use strict';
//
// IMAGE RECOVERY — finish a static ad we have ALREADY PAID FOR.
//
// WHY (2026-08-05). Atlas retains a prediction for 30 days, so a paid generation
// is never really lost — only the pointer to it is. Measured that day: a deploy
// SIGTERM killed nine openai/gpt-image-2/edit predictions mid-poll; all nine were
// still COMPLETED at Atlas hours later, $0.5663 already billed, and the only
// reason they looked unrecoverable is that nothing had written the prediction id
// anywhere durable. #86 fixed that (receipt at the charge point) and #91 fixed the
// ledger row. This module is the part that turns a receipt back into an ad.
//
// ── THE RULE THIS MODULE EXISTS TO HONOUR ──────────────────────────────────
// Re-running a stranded render buys the same image twice. Recovering it costs
// $0. So wherever a receipt exists, recovery must be TRIED BEFORE any requeue.
//
// ── WHY THIS IS NOT bootRecoveryService ────────────────────────────────────
// bootRecoveryService runs on the WORKER and handles video, whose master IS the
// deliverable. A static ad's Atlas output is NOT a deliverable: it still needs
// the delivery crop and the logomark (directImageRenderService.finishPlate). That
// is also why this cannot simply stamp `renderUrl` with the Atlas URL — doing so
// would ship an uncropped, unbranded image AS a successful render, which is worse
// than not recovering it.
//
// ── NO SUBMIT, STRUCTURALLY ────────────────────────────────────────────────
// The only provider call here is peekImagePrediction, a free GET. This module
// must never import or reach a generate/edit path. Asserted on the source by
// scripts/verifyImageRecovery.js — that assertion is the money guarantee.

const Ad    = require('../models/Ad');
const Brand = require('../models/Brand');
const { peekImagePrediction } = require('./atlasImageService');
const { finishPlate } = require('./directImageRenderService');
const { finalizeFlatCost } = require('./costTracker');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { deliveryGeometryFor } = require('./directImageRenderService');

/**
 * Recover ONE static ad from its spend receipt.
 *
 * Returns a verdict rather than throwing, so a caller sweeping many ads is never
 * derailed by one bad row:
 *   { state: 'recovered', renderUrl }      finished and persisted
 *   { state: 'no-receipt' }                nothing was ever bought for this ad
 *   { state: 'processing' }                still running at Atlas; try later
 *   { state: 'failed', message }           Atlas says the task failed
 *   { state: 'unrecoverable', message }    receipt exists but cannot be finished
 */
async function recoverImageAd({ ad, dryRun = false } = {}) {
  const predictionId = ad?.imageGeneration?.predictionId || null;
  if (!predictionId) return { state: 'no-receipt' };

  const peek = await peekImagePrediction(predictionId);
  if (peek.state !== 'done' || !peek.imageUrl) {
    // 'processing' and 'unknown' are deliberately NOT written off. Acting on
    // ignorance is how a paid asset gets discarded; the next pass retries.
    return { state: peek.state, message: peek.message || null, predictionId };
  }

  // The charge is CONFIRMED here, not assumed (owner rule): peek read `price`
  // back off the settled prediction. Reconcile the ledger to the real figure
  // while we have it — this is often the first time the true price is knowable,
  // because the render died before scheduleCostReconcile could run.
  if (peek.priceConfirmed && Number(peek.price) > 0) {
    // FULL record, not just the id+price. finalizeFlatCost falls back to an
    // INSERT when no charge-point row exists — which is exactly the case for any
    // render that predates the #91 charge-point ledger — and CostLog requires
    // `stage`, so a partial meta is silently DROPPED by persistCost's validation.
    // Caught by the first live dry run; the repo already documents this
    // schema-drift-drops-the-row trap and it bit here immediately.
    finalizeFlatCost({
      providerRequestId: predictionId,
      stage:      'direct_image_recovered',
      provider:   'atlas',
      model:      ad.imageGeneration?.model || 'unknown',
      brandId:    ad.brandId || null,
      campaignId: ad.campaignId || null,
      adId:       String(ad._id),
      costUsd:    Number(peek.price),
      costSource: 'actual',
      status:     'ok'
    }).catch(() => {});
  }

  // Rebuild the delivery geometry from the AD, not from anything cached in the
  // dead render's memory. `built.surface` is the only shape finishPlate needs.
  let surface, dims;
  try {
    ({ surface, dims } = surfaceForAd(ad));
    deliveryGeometryFor(surface);          // throws if the geometry is unusable
  } catch (err) {
    return { state: 'unrecoverable', predictionId, message: `geometry: ${err.message}` };
  }

  let rawFrame;
  try {
    const res = await fetch(peek.imageUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rawFrame = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // The image is still at Atlas for 30 days; a fetch blip is not terminal.
    return { state: 'processing', predictionId, message: `fetch failed: ${err.message}` };
  }

  const brand = ad.brandId
    ? await Brand.findById(ad.brandId).select('logoUrl').lean()
    : null;

  let plate;
  try {
    plate = await finishPlate({
      rawFrame,
      built:   { surface },
      dims,
      genSize: surface.generate,
      surface: surface.key,
      adId:    String(ad._id),
      logoUrl: brand?.logoUrl || null
    });
  } catch (err) {
    return { state: 'unrecoverable', predictionId, message: `finishPlate: ${err.message}` };
  }

  if (dryRun) {
    return { state: 'recovered', predictionId, dryRun: true, bytes: plate.buffer.length };
  }

  let upload;
  try {
    upload = await uploadBufferToCloudinary(plate.buffer, {
      folder: `ads/${ad.brandId || 'unknown'}`,
      // Deterministic id including the prediction, so a re-run of recovery
      // overwrites its own output instead of littering Cloudinary with copies.
      publicId: `${String(ad.platformFormat || 'surface')}-recovered-${predictionId.slice(0, 12)}`,
      resourceType: 'image',
      overwrite: true
    });
  } catch (err) {
    return { state: 'unrecoverable', predictionId, message: `upload: ${err.message}` };
  }
  const renderUrl = upload?.secure_url || upload?.url || null;
  if (!renderUrl) return { state: 'unrecoverable', predictionId, message: 'upload returned no url' };

  // `status: { $ne: 'draft' }` in the FILTER makes this idempotent without a
  // lease: if another pass (or the original render, finishing late) already
  // landed this ad, the write becomes a no-op instead of clobbering it.
  const res = await Ad.updateOne(
    { _id: ad._id, status: { $nin: ['draft', 'live', 'archived'] } },
    { $set: {
        status:      'draft',
        renderUrl,
        kind:        'image',
        width:       dims.width,
        height:      dims.height,
        bytes:       plate.buffer.length,
        renderedAt:  new Date(),
        updatedAt:   new Date(),
        cloudinaryPublicId: upload?.public_id || null,
        renderStage: `recovered from receipt ${predictionId}`
    } }
  );
  if (!res.modifiedCount) {
    return { state: 'unrecoverable', predictionId, message: 'ad already resolved by another pass' };
  }
  return { state: 'recovered', predictionId, renderUrl, logoComposited: plate.logoComposited };
}

/**
 * Rebuild the surface descriptor finishPlate needs from the Ad's own fields.
 *
 * Deliberately reads platformFormats rather than trusting anything stored on the
 * Ad: the delivery geometry is a property of the SURFACE, and a stale copy on an
 * old row is exactly how a recovered ad would end up cropped differently from a
 * freshly rendered one.
 */
function surfaceForAd(ad) {
  const { computeSurface } = require('./staticAdIntents');
  const key = ad.platformFormat || 'meta_feed_1_1';
  // computeSurface is THE derivation the live render path uses, keyed off the
  // platformFormat alone. Calling it (rather than reading anything cached on the
  // Ad) is what guarantees a recovered ad is cropped identically to a freshly
  // rendered one — a stale copy on an old row is exactly how the two would drift.
  const surface = computeSurface(key);
  if (!surface) throw new Error(`no surface descriptor for platformFormat '${key}'`);
  const [w, h] = String(surface.deliver || '').split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`surface '${key}' has no deliver dims (${surface.deliver})`);
  return { surface, dims: { width: w, height: h } };
}

/**
 * SETTLE an ad whose charge state is UNKNOWN, from the provider's own record.
 *
 * WHY THIS BEATS MERELY RECORDING "unknown" (2026-08-05). atlasErrorPolicy's
 * FALLBACK carries `charged: null` for any failure shape it cannot classify — a
 * bare Cloudflare 502 mid-poll is exactly that — and renderService used to
 * collapse it to `false`, i.e. to "free". But the answer is KNOWABLE: Atlas
 * publishes `price` on the settled prediction and keeps it 30 days, and reading
 * it is a free GET. So 'unknown' is a to-do, not a resting state.
 *
 * Money direction that matters: this can only ever move a row from "we do not
 * know" to a CONFIRMED figure. It never invents a charge, and it never marks
 * something not-charged on a guess — if the price has not been published yet,
 * the row stays 'unknown' and the next pass retries.
 *
 * NEVER SUBMITS: the only provider call is peekImagePrediction.
 *
 * @returns {Promise<{state:'charged'|'not-charged'|'unknown'|'no-receipt', price?:number}>}
 */
async function settleChargeState({ ad } = {}) {
  const predictionId = ad?.renderError?.predictionId
    || ad?.imageGeneration?.predictionId
    || null;
  if (!predictionId) return { state: 'no-receipt' };

  const peek = await peekImagePrediction(predictionId);

  // A price we can read is the authoritative answer either way.
  if (peek.priceConfirmed) {
    const price = Number(peek.price) || 0;
    const state = price > 0 ? 'charged' : 'not-charged';
    await Ad.updateOne({ _id: ad._id }, { $set: {
      'renderError.chargeState': state,
      // `charged` still means "we KNOW it was billed", so it only ever goes true.
      ...(state === 'charged' ? { 'renderError.charged': true } : {}),
      updatedAt: new Date()
    } });
    if (price > 0) {
      // Ledger the real figure. A COMPLETE record: finalizeFlatCost falls back to
      // an insert when no charge-point row exists (true for anything predating
      // #91), and CostLog silently drops a row without `stage`.
      finalizeFlatCost({
        providerRequestId: predictionId,
        stage:      'direct_image_settled',
        provider:   'atlas',
        model:      ad.imageGeneration?.model || 'unknown',
        brandId:    ad.brandId || null,
        campaignId: ad.campaignId || null,
        adId:       String(ad._id),
        costUsd:    price,
        costSource: 'actual',
        status:     'charged-no-output'
      }).catch(() => {});
    }
    return { state, price };
  }

  // Atlas reported a definitive FAILURE and published no price. Failed tasks are
  // refunded per the documented policy, so this is a real 'not-charged' — the one
  // case where absence of a price is itself the answer.
  if (peek.state === 'failed') {
    // CORRECT THE OPERATOR-FACING REASON TOO. The stored message was written by
    // whatever the poll loop happened to SEE at the time, which can be wildly
    // misleading: the two ads that triggered this work still read "Atlas image
    // unknown (HTTP 502 … Cloudflare …)" when the truth — visible right here in
    // the settled prediction — is "Input Prompt violates policy", i.e. a
    // deterministic content rejection that no retry can fix. Leaving a known-wrong
    // diagnosis in place sends someone chasing an outage that never happened.
    //
    // Only overwrite when peek actually named a cause, and keep the original
    // verbatim so nothing is destroyed by a correction.
    const set = { 'renderError.chargeState': 'not-charged', updatedAt: new Date() };
    if (peek.message && ad.renderError?.message && !ad.renderError.message.includes(peek.message)) {
      set['renderError.message'] = `${peek.message} [settled from prediction ${predictionId}] — was recorded as: ${String(ad.renderError.message).slice(0, 160)}`;
      set['renderError.stage']   = 'settled';
    }
    await Ad.updateOne({ _id: ad._id }, { $set: set });
    return { state: 'not-charged', price: 0, reason: peek.message || null };
  }

  // Still processing, or we could not reach Atlas. Leave it 'unknown' — guessing
  // here is how spend goes unrecorded.
  return { state: 'unknown', message: peek.message || peek.state };
}

module.exports = { recoverImageAd, surfaceForAd, settleChargeState };
