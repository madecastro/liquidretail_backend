'use strict';
// renderer role — Phase 1b real static path.
//
// Replaces the Phase 1a mockRender with the actual static ad-gen pipeline:
//   1. Atomic claim (unchanged from Phase 1a — proven working)
//   2. Load Ad + concept + brand + product + media
//   3. Derive LayoutInputArtifact (layoutInputService.buildLayoutInput)
//   4. Submit to Atlas gpt-image-2/edit + Sharp crop + Cloudinary upload +
//      final Ad stamp (directImageRenderService.renderDirectImage)
//   5. Update CampaignRun succeeded/failed counters
//   6. Release claim + move on
//
// Money invariants preserved by using the SAME functions backend uses:
//   - Ad.imageGeneration.predictionId stamped inside atlasImageService.submitAndPoll
//   - CostLog rows written by atlasImageService (recordFlatCost, reconcileCost)
//   - Atomic claim via findOneAndUpdate — same shape as backend claimAdsForRun
//
// Video path (renderRoute:'veo') is NOT wired here — Phase 1c. The claim
// filter still permits video masters/derives to be claimed, but the
// dispatch below throws "video not yet supported" and releases the claim.
// A concurrent backend deploy with ADGEN_RENDERER_ENABLED=true would
// therefore only cover the static half. Leave the flag off in prod until
// Phase 1c ships.

const { POLL_MS, WORKER_ID, isAdgenRendererEnabled } = require('../config');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const Ad          = require('../models/Ad');
const Brand       = require('../models/Brand');
const Media       = require('../models/Media');
const CampaignRun = require('../models/CampaignRun');
const directImage = require('./directImageRenderService');
const { buildLayoutInput } = require('./layoutInputService');
const { adStage, noteRenderIssue } = require('./adStage');
const { resolveDeriveFromMaster } = require('./campaignAdsGenerationService');
const atlasVideo = require('./atlasVideoService');
const { renderBrandScriptAndSave } = require('./brandScriptExecutor');
const { veoPrepareStoryboard } = require('./videoRouter');

// Bounded wait for a derive-only ad's sibling master to complete. Mirrors
// backend's renderDeriveOnlyVideoAd — the derive ad row polls Mongo for
// its master's veoVideoUrl, up to DERIVE_MASTER_WAIT_MS. When the wait
// expires the ad is requeued for a peer worker to try again (bounded by
// deriveWaitAttempts so it can't spin forever).
const DERIVE_MASTER_WAIT_MS   = Number(process.env.DERIVE_MASTER_WAIT_MS   || 720_000); // 12 min
const DERIVE_MASTER_POLL_MS   = Number(process.env.DERIVE_MASTER_POLL_MS   || 10_000);
const MAX_DERIVE_WAIT_ATTEMPTS = Number(process.env.MAX_DERIVE_WAIT_ATTEMPTS || 30);

let stopping = false;

async function claimOne() {
  // Claim any static (html_gen) or video (veo) ad that's in status:'rendering'
  // and unowned. NOTE: derives ARE claimable here even without their own
  // veoVideoUrl — the sibling-master wait happens INSIDE renderVideo() via
  // findSiblingMasterAd, not at claim time. Gating derives on their OWN
  // veoVideoUrl (Phase 1a design mistake) meant no derive was ever claimable,
  // because the veoVideoUrl gets INHERITED from the master during render,
  // never before. Cost of the fix: a derive worker holds a slot for up to
  // DERIVE_MASTER_WAIT_MS (12min) if the master hasn't landed yet. Bounded
  // by MAX_DERIVE_WAIT_ATTEMPTS at requeue time. Matches backend behavior.
  return Ad.findOneAndUpdate(
    {
      status:          'rendering',
      claimedByWorker: null,
      renderRoute:     { $in: ['html_gen', 'veo'] }
    },
    { $set: { claimedByWorker: WORKER_ID, claimedAt: new Date() } },
    { new: true, sort: { createdAt: 1 } }
  );
}

async function releaseClaim(adId, reason = null) {
  try {
    await Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID },
      { $set: { claimedByWorker: null, claimedAt: null } }
    );
    if (reason) console.warn(`renderer[${WORKER_ID}]: released claim on ${String(adId).slice(-6)} — ${reason}`);
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: release claim failed for ${adId}: ${err.message}`);
  }
}

// Increment run counter atomically. Backend keeps this too — both writers
// converge on the same field because Mongo $inc is atomic. Missing
// runIds (ad ended up on a run with no CampaignRun row — shouldn't happen
// but shouldn't crash if it does) are silently skipped.
async function bumpRunCounter(campaignRunIds, field) {
  if (!Array.isArray(campaignRunIds) || !campaignRunIds.length) return;
  const runId = campaignRunIds[campaignRunIds.length - 1]; // most recent claim wins
  try {
    await CampaignRun.updateOne(
      { runId },
      { $inc: { [field]: 1 }, $set: { updatedAt: new Date(), lastHeartbeatAt: new Date() } }
    );
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: bumpRunCounter(${field}) failed for ${runId}: ${err.message}`);
  }
}

// Static-path render. Called for renderRoute === 'html_gen'.
// The Ad row has been claimed atomically; on any throw we release the
// claim so a peer worker can retry (bounded by renderAttempts in backend's
// existing sweepers).
async function renderStatic(ad) {
  const adId = String(ad._id);
  const shortId = adId.slice(-6);
  console.log(
    `renderer[${WORKER_ID}]: STATIC render start ad=${shortId} template=${ad.template} ` +
    `format=${ad.platformFormat} concept=${ad.conceptId || 'legacy'}`
  );
  const t0 = Date.now();

  // Step 1 — derive LayoutInputArtifact. Same shape backend uses in
  // renderService.deriveStage → buildLayoutInput.
  const layoutOpts = {
    productId:    ad.productId ? String(ad.productId) : null,
    variantKind:  ad.variantKind || null,
    paletteSource: ad.paletteSource || 'media',
    campaignKind:  ad.campaignKind || null,
    platformFormat: ad.platformFormat || 'meta_feed_1_1',
    funnelStage:   ad.funnelStage || null,
    campaignId:    ad.campaignId ? String(ad.campaignId) : null,
    brandId:       ad.brandId ? String(ad.brandId) : null,
    // Concept-driven ads pass the artifact + concept id so buildLayoutInput
    // can pull the Director's copy / proof / media picks.
    adConceptArtifactId: ad.conceptArtifactId ? String(ad.conceptArtifactId) : null,
    adConceptId:         ad.conceptId || null,
    // adId lets buildLayoutInput noteRenderIssue on this row on failure.
    adId
  };

  const { input, layoutInputArtifactId } = await buildLayoutInput({
    mediaId:      String(ad.mediaId),
    template:     ad.template,
    aspectRatio:  ad.aspectRatio,
    options:      layoutOpts,
    refresh:      false
  });

  // Step 2 — actual render. Directly through directImageRenderService,
  // bypassing renderService.renderCreative (which we deleted because it
  // pulled in puppeteer and legacy HTML paths).
  const runId = Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
    : null;

  const result = await directImage.renderDirectImage({
    adId,
    layoutInputArtifactId,
    aspectRatio:         ad.aspectRatio,
    mediaId:             String(ad.mediaId),
    productId:           ad.productId ? String(ad.productId) : null,
    brandId:             ad.brandId ? String(ad.brandId) : null,
    campaignId:          ad.campaignId ? String(ad.campaignId) : null,
    campaignRunId:       runId,
    adConceptArtifactId: ad.conceptArtifactId ? String(ad.conceptArtifactId) : null,
    adConceptId:         ad.conceptId || null,
    template:            ad.template,
    referenceMediaIds:   Array.isArray(ad.mediaIds) ? ad.mediaIds.map(String) : [],
    referenceSource:     ad.paletteSource === 'brand' ? 'director' : 'operator',
    platformFormat:      ad.platformFormat || 'meta_feed_1_1',
    variantKind:         ad.variantKind || null,
    funnelStage:         ad.funnelStage || null,
    // No regenerate/prompt override on the fresh render path.
    operatorPrompt:      null,
    rawPromptOverride:   null,
    skipVisionQc:        false
  });

  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  if (result && result.skipped) {
    console.log(`renderer[${WORKER_ID}]: STATIC skipped ad=${shortId} reason=${result.reason || '-'} wall=${wallSec}s`);
    // A skip is not a success and not a failure — mirror backend's behavior:
    // the ad transitions to 'skipped' inside renderDirectImage or upstream;
    // if the ad is still 'rendering', we leave the claim for a peer to retry.
    // Increment run.skipped counter.
    await bumpRunCounter(ad.campaignRunIds, 'skipped');
    // If renderDirectImage did NOT flip status, treat as failed for our
    // book-keeping so we don't strand the claim.
    const fresh = await Ad.findById(adId).select('status').lean();
    if (fresh?.status === 'rendering') {
      await Ad.updateOne({ _id: adId }, { $set: { status: 'failed', claimedByWorker: null, updatedAt: new Date() } });
    }
  } else {
    // renderDirectImage stamped renderUrl + status='draft' internally.
    console.log(`renderer[${WORKER_ID}]: STATIC done ad=${shortId} wall=${wallSec}s`);
    await bumpRunCounter(ad.campaignRunIds, 'succeeded');
    // Release claim on the terminal-state row — renderDirectImage set
    // status='draft' but may not have cleared claimedByWorker.
    await releaseClaim(ad._id);
  }
}

// Sibling master lookup. Mirrors backend's findSiblingMasterAd in
// routes/ads.js — a derive ad's master is same-campaign, same-product,
// video kind, with the requested platformFormat, and NO deriveFromMaster
// / funnelStage of its own (true master, not another retitle).
async function findSiblingMasterAd(ad, masterPlatformFormat) {
  const base = {
    campaignId: ad.campaignId,
    productId:  ad.productId,
    platformFormat: masterPlatformFormat,
    kind:      'video',
    _id:       { $ne: ad._id },
    $and: [
      { $or: [{ deriveFromMaster: null }, { deriveFromMaster: { $exists: false } }] },
      { $or: [{ funnelStage: null },       { funnelStage: { $exists: false } }] }
    ]
  };
  const runIds = Array.isArray(ad.campaignRunIds) ? ad.campaignRunIds.map(String).filter(Boolean) : [];
  if (runIds.length) {
    const inRun = await Ad.findOne({ ...base, campaignRunIds: { $in: runIds } })
      .sort({ generatedAt: -1 }).lean();
    if (inRun) return inRun;
  }
  return Ad.findOne(base).sort({ generatedAt: -1 }).lean();
}

// Requeue a derive whose master isn't ready yet. Bumps deriveWaitAttempts
// (NOT renderAttempts — that would spuriously trip the stranded-sweeper).
// The claim is released so a peer worker can retry after the master lands.
async function requeueDeriveForRetry(ad, reason) {
  await Ad.updateOne(
    { _id: ad._id, claimedByWorker: WORKER_ID },
    {
      $set: {
        status:          'rendering',
        claimedByWorker: null,
        claimedAt:       null,
        updatedAt:       new Date()
      },
      $inc: { deriveWaitAttempts: 1 }
    }
  );
  console.log(`renderer[${WORKER_ID}]: derive requeued ad=${String(ad._id).slice(-6)} — ${reason}`);
}

// Video render path — handles BOTH the billable master submit (Atlas Omni)
// AND the free derive-only crops/retitles of an existing master. Money-
// critical gate: renderDeriveOnlyVideoAd MUST NEVER call atlasVideo.
// generateForAd — that would submit a paid Omni master on a "free" derive
// row. The check is resolveDeriveFromMaster (imported, single definition,
// fail-closed on pmax_video_1_1 by construction).
async function renderVideo(ad) {
  const adId = String(ad._id);
  const shortId = adId.slice(-6);
  const t0 = Date.now();
  const runId = Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
    : null;

  const deriveFromFmt = resolveDeriveFromMaster(ad);

  if (deriveFromFmt) {
    // ── DERIVE PATH — no Omni submit, ever ─────────────────────────────
    console.log(`renderer[${WORKER_ID}]: VIDEO DERIVE start ad=${shortId} deriveFrom=${deriveFromFmt}`);

    if ((ad.deriveWaitAttempts || 0) >= MAX_DERIVE_WAIT_ATTEMPTS) {
      throw new Error(`derive exceeded max wait attempts (${MAX_DERIVE_WAIT_ATTEMPTS}); sibling master never landed`);
    }

    // Poll for the sibling master's veoVideoUrl up to DERIVE_MASTER_WAIT_MS.
    const deadline = Date.now() + DERIVE_MASTER_WAIT_MS;
    let master = null;
    while (Date.now() < deadline) {
      master = await findSiblingMasterAd(ad, deriveFromFmt);
      if (master?.veoVideoUrl) break;
      if (master?.status === 'failed') {
        throw new Error(`sibling master ${String(master._id).slice(-6)} failed — cannot derive`);
      }
      await new Promise((r) => setTimeout(r, DERIVE_MASTER_POLL_MS));
    }
    if (!master?.veoVideoUrl) {
      await requeueDeriveForRetry(ad, 'sibling master not yet ready — retry later');
      return; // NOT counted as failure; requeue is the intent
    }

    // Inherit the paid master's veoVideoUrl / cloudinary asset onto the derive
    // and stamp titling-debt marker so sweepers can find this row if we crash
    // between here and the final renderUrl write.
    await Ad.updateOne(
      { _id: ad._id },
      {
        $set: {
          veoVideoUrl:        master.veoVideoUrl,
          veoAspectRatio:     master.veoAspectRatio || ad.aspectRatio,
          veoModel:           master.veoModel || null,
          renderUrl:          master.veoVideoUrl,
          sourceFileType:     'video',
          renderedAt:         new Date(),
          updatedAt:          new Date(),
          titlingResumeState: 'claimed'
        },
        $inc: { renderAttempts: 1 }
      }
    );

    // Load brand for titling
    const sourceMedia = ad.mediaId ? await Media.findById(ad.mediaId).select('brandId').lean() : null;
    const brandDoc = sourceMedia?.brandId
      ? await Brand.findById(sourceMedia.brandId).lean()
      : (ad.brandId ? await Brand.findById(ad.brandId).lean() : null);

    if (brandDoc) {
      adStage(adId, `titling ${ad.aspectRatio || '9:16'} (derive)`);
      const adFinal = await Ad.findById(adId).lean();
      const chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
      if (chromeOut?.skipped) {
        console.log(`renderer[${WORKER_ID}]: VIDEO DERIVE no-chrome ad=${shortId} — shipping master`);
      }
    }

    // Success stamp — clear titling debt, terminal state.
    await Ad.updateOne(
      { _id: ad._id },
      {
        $set: {
          status:             'draft',
          titlingResumeState: null,
          claimedByWorker:    null,
          claimedAt:          null,
          updatedAt:          new Date()
        }
      }
    );
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`renderer[${WORKER_ID}]: VIDEO DERIVE done ad=${shortId} wall=${wallSec}s`);
    await bumpRunCounter(ad.campaignRunIds, 'succeeded');
    return;
  }

  // ── MASTER PATH — billable Atlas Omni submit ──────────────────────────
  console.log(`renderer[${WORKER_ID}]: VIDEO MASTER start ad=${shortId} format=${ad.platformFormat}`);

  const sourceMedia = ad.mediaId ? await Media.findById(ad.mediaId).select('fileType fileUrl brandId').lean() : null;
  const brandDoc = sourceMedia?.brandId
    ? await Brand.findById(sourceMedia.brandId).lean()
    : (ad.brandId ? await Brand.findById(ad.brandId).lean() : null);

  // Stage 1 — prepare storyboard / prompt context. On Atlas the storyboard
  // is null and the Ken Burns prompt directs motion; kept as-called for
  // compat with legacy vertex path (which noop-returns).
  adStage(adId, 'preparing video context');
  const { storyboard } = await veoPrepareStoryboard({ ad });

  // Stage 2 — the billable Omni submit + poll. Stamps veoPredictionId
  // (spend receipt) inside atlasVideoService before polling.
  adStage(adId, `master video generation (${ad.aspectRatio || '9:16'})`);
  const veoResult = await atlasVideo.generateForAd({ ad, storyboard, campaignRunId: runId });
  if (veoResult.skipped) {
    throw new Error(veoResult.reason || 'video generation skipped by provider');
  }

  // Persist master + titling debt marker in one write (see backend
  // routes/ads.js:2940 — this shape is the money-critical stamp that
  // makes the paid asset reclaimable if the process dies mid-titling).
  await Ad.updateOne(
    { _id: ad._id },
    {
      $set: {
        veoVideoUrl:          veoResult.videoUrl,
        veoAspectRatio:       veoResult.aspectRatio || ad.aspectRatio,
        veoPrompt:            veoResult.prompt || null,
        veoStoryboard:        veoResult.storyboard || storyboard || null,
        veoCloudinaryPublicId: veoResult.cloudinaryPublicId || null,
        veoModel:             veoResult.model || null,
        veoReferenceImages:   veoResult.referenceImages || [],
        renderUrl:            veoResult.videoUrl,
        sourceFileType:       'video',
        renderedAt:           new Date(),
        updatedAt:            new Date(),
        titlingResumeState:   'claimed'
      },
      $inc: { renderAttempts: 1 }
    }
  );

  // Stage 3 — Remotion titling on the paid master.
  if (brandDoc) {
    adStage(adId, `titling ${ad.aspectRatio || '9:16'}`);
    const adFinal = await Ad.findById(adId).lean();
    const chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
    if (chromeOut?.skipped) {
      console.log(`renderer[${WORKER_ID}]: VIDEO MASTER no-chrome ad=${shortId} — shipping master`);
    }
  }

  // Terminal — clear titling debt + claim.
  await Ad.updateOne(
    { _id: ad._id },
    {
      $set: {
        status:             'draft',
        titlingResumeState: null,
        claimedByWorker:    null,
        claimedAt:          null,
        updatedAt:          new Date()
      }
    }
  );
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`renderer[${WORKER_ID}]: VIDEO MASTER done ad=${shortId} wall=${wallSec}s`);
  await bumpRunCounter(ad.campaignRunIds, 'succeeded');
}

async function poll() {
  const start = Date.now();
  try {
    if (!isAdgenRendererEnabled()) {
      resetReconnectAttempts();
      scheduleNext(start);
      return;
    }

    const ad = await claimOne();
    resetReconnectAttempts();
    if (!ad) {
      scheduleNext(start);
      return;
    }

    try {
      if (ad.renderRoute === 'html_gen') {
        await renderStatic(ad);
      } else if (ad.renderRoute === 'veo') {
        await renderVideo(ad);
      } else {
        throw new Error(`unknown renderRoute: ${ad.renderRoute}`);
      }
    } catch (err) {
      console.error(`renderer[${WORKER_ID}]: render failed ad=${String(ad._id).slice(-6)} route=${ad.renderRoute}: ${err.message}`);
      try { noteRenderIssue(ad._id, { message: err.message, stage: 'render' }); } catch (_) {}
      // Best-effort: mark the ad failed so it does not sit in status:'rendering'
      // forever. Backend's reaper would eventually requeue, but a clean
      // failed state is the honest outcome here.
      await Ad.updateOne(
        { _id: ad._id, claimedByWorker: WORKER_ID },
        {
          $set: {
            status:          'failed',
            claimedByWorker: null,
            claimedAt:       null,
            renderError:     { message: err.message.slice(0, 400), stage: 'render', at: new Date(), code: err.code || null },
            updatedAt:       new Date()
          }
        }
      ).catch(() => {});
      await bumpRunCounter(ad.campaignRunIds, 'failed');
    }
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: poll error — ${err.message}`);
    if (isStaleTopologyError(err)) {
      reconnectAfterStaleTopology();
    }
  }
  scheduleNext(start);
}

function scheduleNext(startTs) {
  const elapsed = Date.now() - startTs;
  const wait = Math.max(50, POLL_MS - elapsed);
  if (!stopping) setTimeout(poll, wait);
}

async function run() {
  const gated = isAdgenRendererEnabled();
  console.log(
    `renderer[${WORKER_ID}] starting — poll interval ${POLL_MS}ms, handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}`
  );
  poll();
  setInterval(() => {
    if (stopping) return;
    const g = isAdgenRendererEnabled();
    console.log(`renderer[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s, handoff ${g ? 'ON' : 'OFF'}`);
  }, 30_000).unref();
}

function shutdown() {
  stopping = true;
  console.log(`renderer[${WORKER_ID}] shutting down`);
}

module.exports = { run, shutdown };
