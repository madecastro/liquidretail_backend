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
// ── NO IMAGE SUBMIT, STRUCTURALLY ──────────────────────────────────────────
// This module must never import or reach a generate/edit path. Asserted on the
// source by scripts/verifyImageRecovery.js — that assertion is the money
// guarantee for image submits.
//
// Provider / LLM calls that ARE allowed (never image generation):
//   · peekImagePrediction — free GET of an already-paid prediction
//   · judgeRender (adVisionQcService) — billable vision LLM (~$0.01–0.03) when
//     AD_VISION_QC_ENABLED; zero gpt-image-2/edit submits. The spend is
//     short-circuited before the call when the ad already holds a visionQc
//     verdict or is no longer recoverable (see maybeQcRecoveredPlate).

const Ad    = require('../models/Ad');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const { peekImagePrediction } = require('./atlasImageService');
const { finishPlate, safeBoxInDeliveredPx, deliveryGeometryFor } = require('./directImageRenderService');
const { finalizeFlatCost } = require('./costTracker');
const { uploadBufferToCloudinary } = require('./cloudinaryService');

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
    // 'failed' includes charge evidence so the boot path can stamp honestly.
    return {
      state: peek.state,
      message: peek.message || null,
      predictionId,
      price: peek.price,
      priceConfirmed: peek.priceConfirmed
    };
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
    ? await Brand.findById(ad.brandId).select('logoUrl name').lean()
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

  // ── Vision QC on recovered plate (vision LLM ONLY — zero image submits) ──
  // A restart mid-QC would otherwise stamp draft with no verdict and ship
  // uninspected while AD_VISION_QC_ENABLED claims every static ad is checked.
  // Prefer judge once (cheap ~$0.01–0.03). NEVER regenerate here — the plate
  // is already paid; recovery must stay free of new image submits (money).
  // Fail closed on a bad verdict → status:'failed' (not draft/exportable),
  // still KEEP the recovered asset (invariant 4).
  const visionQc = await maybeQcRecoveredPlate({
    ad, brand, surface, dims, renderUrl
  });

  // QC fail closed mirrors the live path (routes/ads failure → status failed
  // with paid render kept). A plain draft would put competitor-mark ads into
  // the ready-to-export pool. Skipped/uninspected still lands draft — same as
  // live shipping with a skipped stamp.
  const qcFailed = !!(
    visionQc
    && visionQc.passed === false
    && !visionQc.skipped
    && !visionQc.disabled
    && Array.isArray(visionQc.attempts)
    && visionQc.attempts.length > 0
  );

  const setFields = {
    status:      qcFailed ? 'failed' : 'draft',
    renderUrl,
    kind:        'image',
    width:       dims.width,
    height:      dims.height,
    bytes:       plate.buffer.length,
    renderedAt:  new Date(),
    updatedAt:   new Date(),
    cloudinaryPublicId: upload?.public_id || null,
    renderStage: qcFailed
      ? `recovered from receipt ${predictionId}; vision QC failed`
      : `recovered from receipt ${predictionId}`
  };
  if (visionQc) setFields.visionQc = visionQc;
  if (qcFailed) {
    const lastSummary = (visionQc.attempts || []).slice(-1)[0]?.summary || 'vision QC fail';
    setFields.renderError = {
      message: `vision QC failed on recovered plate (no regeneration): ${lastSummary}`,
      stage: 'vision-qc-recovery',
      at: new Date(),
      predictionId,
      charged: true
    };
  }

  // WRITE idempotency only — the filter makes concurrent recoveries /
  // late-finishing live renders a no-op on the loser. The VISION spend is
  // guarded earlier inside maybeQcRecoveredPlate (re-read status + existing
  // visionQc before any billable judge call). Do not treat this filter as a
  // money guard; it is not.
  const res = await Ad.updateOne(
    { _id: ad._id, status: { $nin: ['draft', 'live', 'archived'] } },
    { $set: setFields }
  );
  if (!res.modifiedCount) {
    return { state: 'unrecoverable', predictionId, message: 'ad already resolved by another pass' };
  }
  return {
    state: 'recovered',
    predictionId,
    renderUrl,
    logoComposited: plate.logoComposited,
    visionQc: visionQc || null,
    qcFailed
  };
}

/**
 * Resolve the ORIGINAL product photo for a recovered ad so judgeRender can
 * compare product vs finished plate. Preference order mirrors the live path's
 * first reference:
 *   1. imageGeneration.images[0].sourceUrl (submission audit — best)
 *   2. Media.fileUrl for ad.mediaId
 *   3. CatalogProduct.imageUrl for ad.productId
 * Returns null when nothing is recoverable → caller stamps skipped.
 */
async function resolveOriginalProductUrl(ad) {
  const fromSubmission = ad?.imageGeneration?.images?.[0]?.sourceUrl;
  if (fromSubmission && /^https?:\/\//i.test(String(fromSubmission))) {
    return String(fromSubmission);
  }
  if (ad?.mediaId) {
    try {
      const m = await Media.findById(ad.mediaId).select('fileUrl').lean();
      if (m?.fileUrl) return m.fileUrl;
    } catch { /* ignore — fall through */ }
  }
  if (ad?.productId) {
    try {
      const p = await CatalogProduct.findById(ad.productId).select('imageUrl').lean();
      if (p?.imageUrl) return p.imageUrl;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Reconstruct expected on-ad text for recovery QC.
 *
 * Preference:
 *   1. Parse the submission audit (Ad.imageGeneration.prompt) — the exact
 *      strings handed to the image model ("role -> text" lines). Faithful.
 *   2. Otherwise UNKNOWN — do NOT invent [] (that means "pure product, no
 *      text allowed" and false-fails every brand-line/CTA/rating ad).
 *
 * Full live rebuild (buildIntentData + buildPrompt) is deliberately NOT used:
 * it needs concept + layout + brand/product proof that may have drifted since
 * submit, and can produce a different list than the pixels already paid for.
 *
 * @returns {{ expectedText: string[]|null, expectedTextUnknown: boolean }}
 */
function resolveExpectedTextForRecovery(ad) {
  const fromPrompt = extractExpectedTextFromSubmissionPrompt(ad?.imageGeneration?.prompt);
  if (fromPrompt && fromPrompt.length) {
    return { expectedText: fromPrompt, expectedTextUnknown: false };
  }
  // Prompt says "THIS AD CARRIES NO TEXT AT ALL" → known empty list.
  if (typeof ad?.imageGeneration?.prompt === 'string'
      && /THIS AD CARRIES NO TEXT AT ALL/i.test(ad.imageGeneration.prompt)) {
    return { expectedText: [], expectedTextUnknown: false };
  }
  return { expectedText: null, expectedTextUnknown: true };
}

/**
 * Parse "  brand line -> Actual copy" lines from the static prompt's
 * SET EXACTLY THESE STRINGS block (staticAdIntents.js textBlock).
 * Returns null when nothing parseable (caller falls to UNKNOWN).
 */
function extractExpectedTextFromSubmissionPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;
  // Lines look like: "  brand line -> Shop the wool runner"
  // Role is left of arrow (lowercased in the prompt); text is right.
  const out = [];
  const re = /^\s+[a-z][a-z0-9 /_-]*\s*->\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const str = String(m[1] || '').trim();
    if (str) out.push(str);
  }
  return out.length ? out : null;
}

/**
 * When AD_VISION_QC_ENABLED, inspect the recovered plate once (vision LLM only).
 * MONEY: no editImage / generateImage. Never discards paid pixels.
 * Returns a persisted-verdict shape always — including a stamped
 * {skipped:true, disabled:true} verdict when QC is disabled, so a recovered
 * ad reads as "not inspected" the same way a live-shipped one does (see
 * adVisionQcService.warnQcDisabledOnce's comment for the production
 * incident this closes: gate-off used to mean visionQc stayed null, which
 * this function's own caller already special-cased via `.disabled` in its
 * qcFailed guard below — that check was simply unreachable dead code until
 * this fix, because `null` short-circuited before it could ever run).
 *
 * PRE-SPEND IDEMPOTENCY: re-reads the ad and short-circuits BEFORE the
 * billable judgeRender when (a) a REAL visionQc verdict already exists
 * (inspected, or explicitly skipped for this pass — NOT a `disabled:true`
 * gate-off stamp; see below), or (b) the ad is no longer in a recoverable
 * status. Paying then losing the write is the a84437d-class hole this
 * closes.
 *
 * `disabled:true` is deliberately EXCLUDED from that idempotency check: it
 * only records that the gate was off, not that this ad was ever inspected.
 * Letting it satisfy the guard would mean an ad recovered once while the
 * gate is off can never be QC'd again, even after an operator flips
 * AD_VISION_QC_ENABLED back on and this ad is recovered a second time — the
 * exact opposite of what enabling the gate is for.
 */
async function maybeQcRecoveredPlate({ ad, brand, surface, dims, renderUrl }) {
  let adVisionQc;
  try {
    adVisionQc = require('./adVisionQcService');
  } catch (err) {
    console.warn(`   ⚠️  imageRecovery: adVisionQc load failed: ${err.message}`);
    return null;
  }
  // AWAIT the real gate — see the matching comment in
  // directImageRenderService.js / brandScriptExecutor.js. This function is
  // already `async` (it awaits the billable vision call below), so there is no reason to
  // read the racy sync isEnabled() cache peek: a call landing just past the
  // 5s TTL (the normal case for recovery, which runs on its own poll cadence,
  // not in lockstep with the cache) would read a cache miss as "off" even
  // when SystemConfig.adVisionQcEnabled is genuinely true.
  // This module recovers STATIC ads only (see the file header — video
  // recovery is bootRecoveryService, on the WORKER), so it reads the STATIC
  // gate: resolveStaticEnabled() (2026-08-21 split; was the single
  // resolveEnabled() gate before then).
  const qcEnabledNow = await adVisionQc.resolveStaticEnabled();
  if (!qcEnabledNow) {
    adVisionQc.warnQcDisabledOnce('recovered ad');
    return adVisionQc.buildPersistedVerdict({
      passed: false, skipped: true, disabled: true,
      reason: 'AD_VISION_QC_ENABLED=false', finalAttempt: null, attempts: []
    });
  }

  const adId = ad?._id ? String(ad._id) : null;
  const brandId = ad?.brandId || null;
  const productId = ad?.productId || null;
  const brandName = brand?.name || null;
  const runId = Array.isArray(ad?.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[0]
    : null;
  const appUrl = adVisionQc.buildAppPreviewUrl({
    campaignRunId: runId,
    campaignId: ad?.campaignId || null,
    brandId
  });

  // ── PRE-SPEND short-circuit (money) ──────────────────────────────────
  // Two overlapping recovery passes must not both pay the vision LLM.
  // Re-read immediately before any billable call.
  try {
    const fresh = await Ad.findById(ad._id).select('status visionQc').lean();
    if (!fresh) return null;
    // Already resolved by another pass / late-finishing live render — do not spend.
    if (['draft', 'live', 'archived'].includes(fresh.status)) {
      return fresh.visionQc || null;
    }
    // Already inspected (or already stamped a real skip for THIS pass) — do
    // not re-pay. A `disabled:true` stamp is NOT a real inspection — it only
    // records that the gate was off. Treating it as "already inspected"
    // would permanently neuter QC on this ad the moment an operator flips
    // AD_VISION_QC_ENABLED back on and this ad is recovered again: the
    // stale disabled stamp would satisfy this guard forever and the real
    // judgeRender call below would never run. Same !disabled pattern as the
    // qcFailed computation in recoverImageAd above — match it here too.
    if (fresh.visionQc != null && typeof fresh.visionQc === 'object' && !fresh.visionQc.disabled) {
      return fresh.visionQc;
    }
  } catch (err) {
    console.warn(`   ⚠️  imageRecovery: pre-QC re-read failed: ${err.message}`);
    // Fail closed on spend: if we cannot confirm recoverability, do not bill.
    return adVisionQc.buildSkippedVerdict(`recovery pre-QC re-read failed: ${err.message}`);
  }

  const originalProductUrl = await resolveOriginalProductUrl(ad);
  if (!originalProductUrl || !renderUrl) {
    // Original not recoverable cleanly — stamp skipped rather than pretending
    // inspected, still KEEP the recovered asset.
    const reason = 'recovered without QC';
    const verdict = adVisionQc.buildSkippedVerdict(reason);
    adVisionQc.alertQcSkipped({
      adId, brandId, productId, brandName, reason
    });
    return verdict;
  }

  let safeBox;
  try {
    safeBox = safeBoxInDeliveredPx(surface, dims);
  } catch {
    safeBox = {};
  }

  const { expectedText, expectedTextUnknown } = resolveExpectedTextForRecovery(ad);

  try {
    // VISION ONLY — one free-of-image-submit call. No regenerate path here.
    const raw = await adVisionQc.judgeRender({
      originalProductUrl,
      renderUrl,
      brandName,
      safeBox,
      deliveryDims: dims,
      expectedText: expectedTextUnknown ? null : expectedText,
      expectedTextUnknown: !!expectedTextUnknown,
      brandId,
      productId,
      adId,
      campaignId: ad?.campaignId || null
    });
    const verdict = adVisionQc.buildPersistedVerdict({
      passed: !!raw.pass,
      finalAttempt: 1,
      attempts: [{
        attempt: 1,
        pass: !!raw.pass,
        categories: raw.categories,
        findings: raw.findings || [],
        summary: raw.summary || null,
        renderUrl,
        discarded: false
      }]
    });
    if (!raw.pass) {
      // Fail closed on scores — stamp + alert, KEEP recovered asset.
      // regenerated:false — recovery never burns a second image submit.
      // Same failureDetail capture as the live path (directImageRenderService.js)
      // — alertQcFailure's return is the exact Slack text; stamp it onto the
      // SAME `verdict` object this function returns (→ setFields.visionQc).
      const failureDetail = adVisionQc.alertQcFailure({
        adId, brandId, productId, brandName, visionQc: verdict, appUrl,
        regenerated: false
      });
      if (failureDetail) verdict.failureDetail = failureDetail;
      adVisionQc.noteQcFailToRunFeed({
        campaignRunId: runId,
        adId,
        template: ad?.template || null,
        aspectRatio: ad?.aspectRatio || null,
        platformFormat: ad?.platformFormat || null,
        visionQc: verdict,
        previewUrl: renderUrl,
        appUrl
      });
    } else {
      adVisionQc.noteQcPassToRunFeed({
        campaignRunId: runId,
        adId,
        template: ad?.template || null,
        aspectRatio: ad?.aspectRatio || null,
        platformFormat: ad?.platformFormat || null,
        visionQc: verdict,
        previewUrl: renderUrl,
        appUrl
      });
    }
    return verdict;
  } catch (err) {
    // Vision infrastructure throw — same as live path: ship uninspected + alert.
    // Do NOT treat as image failure (must NOT consume regeneration budget;
    // recovery has no regen path either).
    const reason = `recovery vision call failed: ${err.message || err}`;
    console.warn(`   ⚠️  imageRecovery: ${reason}`);
    const verdict = adVisionQc.buildSkippedVerdict(reason);
    adVisionQc.alertQcSkipped({
      adId, brandId, productId, brandName, reason
    });
    return verdict;
  }
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

module.exports = {
  recoverImageAd,
  surfaceForAd,
  settleChargeState,
  // Exported for harness / recovery tooling (pure-ish helpers).
  resolveOriginalProductUrl,
  maybeQcRecoveredPlate,
  resolveExpectedTextForRecovery,
  extractExpectedTextFromSubmissionPrompt
};
