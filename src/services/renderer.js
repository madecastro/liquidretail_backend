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
const CampaignRun = require('../models/CampaignRun');
const directImage = require('./directImageRenderService');
const { buildLayoutInput } = require('./layoutInputService');
const { adStage, noteRenderIssue } = require('./adStage');

let stopping = false;

async function claimOne() {
  return Ad.findOneAndUpdate(
    {
      status:          'rendering',
      claimedByWorker: null,
      $or: [
        { renderRoute: 'html_gen' },
        { renderRoute: 'veo', deriveFromMaster: null },
        { renderRoute: 'veo', deriveFromMaster: { $ne: null }, veoVideoUrl: { $ne: null } }
      ]
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

// Video path — Phase 1c. For now, throw honest so the claim releases and
// backend can be flipped back to ADGEN_RENDERER_ENABLED=false for video
// runs. When Phase 1c ships, this branch calls into atlasVideoService +
// brandScriptExecutor + Remotion.
async function renderVideo(ad) {
  const err = new Error(`video render not yet extracted (Phase 1c) — ad ${String(ad._id).slice(-6)} route=veo`);
  err.notYetImplemented = true;
  throw err;
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
