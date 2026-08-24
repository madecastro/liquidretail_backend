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

const { POLL_MS, WORKER_ID, MAX_INFLIGHT, isAdgenRendererEnabled } = require('../config');
const { concurrency } = require('./concurrency');
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
const {
  buildLayoutInput,
  resolveQuoteAssemblyOptions,
  applyStagedQuotePick
} = require('./layoutInputService');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const crypto = require('crypto');
const { adStage, noteRenderIssue } = require('./adStage');

// Extracted from backend renderService.persistStage's `copy` field builder.
// Preferred: renderedCopy from directImage output (post-density-budget
// truth) — the actual strings the model was told to typeset. Fallback:
// layoutInput.copy (pre-render marketing copy). See CLAUDE.md § 5 for
// why the two can drift.
function extractCopySnapshot(input, rendered = null) {
  const price = input?.product?.price;
  const priceStr = typeof price === 'string' ? price
                 : typeof price === 'number' ? `$${price.toFixed(2)}`
                 : (price?.display || '');
  const useRendered = rendered && typeof rendered === 'object';
  return {
    headline:     useRendered ? (rendered.headline || '') : (input?.copy?.headline                    || ''),
    cta_text:     useRendered ? (rendered.cta_text  || '') : (input?.cta?.text                         || ''),
    quote:        useRendered ? (rendered.quote     || '') : (input?.social_proof?.primary_quote?.text || ''),
    productName:  input?.product?.name                     || '',
    productPrice: priceStr
  };
}

// Extracted from renderService.uploadStage. Same Cloudinary folder / publicId
// shape backend uses — so re-renders of the same ad OVERWRITE (money invariant:
// one identity digest = one Cloudinary asset) rather than accumulate orphans.
async function uploadRenderToCloudinary(renderOutput, ctx) {
  const folder = `ads/${ctx.brandId}/${ctx.campaignId}`;
  const shortMedia = String(ctx.mediaId).slice(-8);
  const shortDigest = (ctx.identityDigest || '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
  const publicId = `${ctx.aspectRatio.replace(/[:.]/g, '_')}-${ctx.template}-${shortMedia}-${shortDigest}`;
  const result = await uploadBufferToCloudinary(renderOutput.buffer, {
    folder,
    publicId,
    resourceType: 'image',
    overwrite:    true
  });
  return {
    cloudinaryPublicId: result.public_id,
    renderUrl:          result.secure_url || result.url,
    posterUrl:          null,
    bytes:              result.bytes  || renderOutput.bytes,
    width:              result.width  || renderOutput.width,
    height:             result.height || renderOutput.height,
    durationMs:         null
  };
}
const { resolveDeriveFromMaster } = require('./campaignAdsGenerationService');
const { classifyRunAdOutcome, buildRunReconciliationUpdate } = require('./campaignRunGuards');
const atlasVideo = require('./atlasVideoService');
const { renderBrandScriptAndSave } = require('./brandScriptExecutor');
// videoRouter exports `prepareStoryboard`; the backend's routes/ads.js binds it
// under the local alias `veoPrepareStoryboard`. Phase 1c ported the CALL from
// there but kept the alias on the require(), destructuring a key that does not
// exist — so this was `undefined` and every first-time video master threw
// "veoPrepareStoryboard is not a function". Alias explicitly instead.
const { prepareStoryboard: veoPrepareStoryboard } = require('./videoRouter');

// Bounded wait for a derive-only ad's sibling master to complete. Kept
// SHORT (60s default) so an unwaiting derive releases its worker slot
// quickly for another ad — peer workers pick it up when the master
// lands. A backend-style 12-min wait would hog MAX_INFLIGHT slots and
// starve throughput. deriveWaitAttempts bounds infinite requeue loops.
const DERIVE_MASTER_WAIT_MS    = Number(process.env.DERIVE_MASTER_WAIT_MS    || 60_000);  // 60s
const DERIVE_MASTER_POLL_MS    = Number(process.env.DERIVE_MASTER_POLL_MS    || 5_000);   // 5s poll
const MAX_DERIVE_WAIT_ATTEMPTS = Number(process.env.MAX_DERIVE_WAIT_ATTEMPTS || 60);      // 60 × ~60s = 60 min ceiling per derive

// ── PER-AD TITLING HEARTBEAT ──────────────────────────────────────────────
// Ported from liquidretail_backend routes/ads.js:2704. Read that, and
// services/campaignRunHeartbeat.js, before changing anything here — the
// gating and the cap below are load-bearing, not ceremony.
//
// WHY IT EXISTS. models/Ad.js is `timestamps: false`, so `updatedAt` only
// moves when written explicitly, and claimOne() writes only claimedByWorker
// /claimedAt. During the Atlas Omni poll we are fine — pollPrediction calls
// adStage every ~5s and that $sets updatedAt. But after the master persists
// we enter Remotion titling, which queues behind REMOTION_QUEUE_CONCURRENCY
// with NO Ad write while it waits. Backend's worker runs bootRecoveryService
// against this SAME collection, ungated on ADGEN_RENDERER_ENABLED, selecting
// { status:'rendering', updatedAt < now-5min, HAS_RECEIPT } — so a perfectly
// healthy adgen titling job becomes eligible to be "recovered" out from
// under us, after which backend web's titlingResumeService titles the same
// paid master concurrently. Two Remotion renders, one ~$0.90 asset, both
// writing renderUrl.
//
// The OOM fix made this MORE likely, not less: REMOTION_QUEUE_CONCURRENCY
// went 4 -> 2 (measured 1.97 GiB/slot, not the committed ~0.9), so per-ad
// queue wait is longer and the 5-minute window is easier to reach.
//
// bootRecovery's own comment (backend services/bootRecoveryService.js:34-36)
// says the quiet part: "renderOne heartbeats updatedAt every 60s, so an ad
// untouched for RESUME_STALE_MIN minutes has missed several beats and is not
// being actively rendered by anyone." That calibration assumes a 60s beat
// EXISTS. adgen has never had one, so RESUME_STALE_MIN has been measuring
// nothing for every adgen row — this does not just close a steal window, it
// makes an existing safety margin mean what its own comment says it means.
const AD_HEARTBEAT_MS_RAW = Number(process.env.AD_HEARTBEAT_MS || 60_000);   // 60s, as backend

// SAFETY CLAMP ON THE INTERVAL ITSELF — CLAMP, not fail-boot, and not a
// mere warn. Adversarial review (2026-08-24, second pass) found the earlier
// warn-only version could be silenced by wrapping its condition in dead code
// (`if (false && ...)`) while the unsafe value still flowed through — a
// presence check on the warn text proved nothing about the actual interval
// used. Clamping the VALUE itself has no boolean gate to defeat: as long as
// this statement exists at all, AD_HEARTBEAT_MS can never exceed the safe
// ceiling, regardless of what happens to any warning around it.
//
// Why clamp instead of the fail-boot pattern src/config.js uses for
// ADGEN_ROLE: ADGEN_ROLE has no safe default, so refusing to boot is the
// only honest option there. AD_HEARTBEAT_MS has a perfectly good default —
// failing to boot over a misconfigured interval would take the entire
// renderer down, a strictly worse outage than one stolen titling job. There
// is also no legitimate reason to ever set this interval at or above the
// staleness window it exists to defeat, so clamping overrides no real
// operator intent.
//
// 90s is 1/3.3 of backend's RESUME_STALE_MIN default (5min/300_000ms) —
// inside the "five missed heartbeats" margin bootRecoveryService's own
// comment describes.
const AD_HEARTBEAT_SAFE_MAX_MS = 90_000;
if (AD_HEARTBEAT_MS_RAW > AD_HEARTBEAT_SAFE_MAX_MS) {
  console.error(
    `renderer[${WORKER_ID}]: AD_HEARTBEAT_MS=${AD_HEARTBEAT_MS_RAW}ms is above backend ` +
    `RESUME_STALE_MIN (default 5min) — CLAMPING to ${AD_HEARTBEAT_SAFE_MAX_MS}ms so a live ` +
    'titling job cannot be recovered out from under this render. Fix the env var — this clamp ' +
    'keeps the renderer running safely, it does not fix the misconfiguration.'
  );
}
const AD_HEARTBEAT_MS = Math.min(AD_HEARTBEAT_MS_RAW, AD_HEARTBEAT_SAFE_MAX_MS);

// TOTAL LIFETIME CAP — mandatory, and the hazard here is WORSE than the run
// case campaignRunHeartbeat guards. An uncapped beat on a Remotion render
// that never settles keeps this row out of bootRecoveryService's reach
// FOREVER, and the thing stranded is a master we have already paid ~$0.90
// for. Past the cap the beat stops, updatedAt goes stale, and recovery
// behaves exactly as it did before this existed. Adversarial review caught
// the absence of the equivalent cap in the run heartbeat; not repeating it.
//
// DERIVED FROM LIVE CONCURRENCY, not hardcoded — REMOTION_QUEUE_CONCURRENCY
// was 4 before the 2026-08-21 OOM and is 2 today; a future re-raise (more RAM)
// or another drop must not silently invalidate a number baked in at review
// time. Worst-case queue depth is MAX_INFLIGHT ads all queued behind
// REMOTION_QUEUE_CONCURRENCY titling slots, at a MEASURED single-render time
// of 76s (concurrency.js REMOTION_QUEUE_CONCURRENCY 'why'). 3x that for
// headroom — 76s is one measurement, not a distribution, and 1080p render
// time is not guaranteed linear in queue depth if memory pressure forces
// swapping under concurrency.
//
// STATE THE REAL NUMBER, do not let the floor read as the size. At today's
// live values (MAX_INFLIGHT=32, REMOTION_QUEUE_CONCURRENCY=2) this resolves
// to 3 * ceil(32/2) * 76_000ms = 3,648,000ms = 60.8 MINUTES. The 10-minute
// floor NEVER BINDS at these values — the derived term is 6x larger — it
// only matters if concurrency is raised enough to shrink the formula under
// it. Do not lower this to "something that feels right" (10min, 20min): the
// cap must outlast a LEGITIMATE worst-case queue wait, which really is
// ceil(MAX_INFLIGHT / REMOTION_QUEUE_CONCURRENCY) renders deep, or the cap
// fires mid-legitimate-wait and hands a healthy ad to bootRecovery — the
// exact bug this file exists to fix, reintroduced by a more reassuring
// number. The design self-corrects the direction that matters: the cap is
// inversely proportional to REMOTION_QUEUE_CONCURRENCY, so it is 60.8min
// today only BECAUSE that knob was dropped 4 -> 2 after the OOM; restoring 4
// halves it to ~30min automatically. A hung render on an otherwise-idle box
// looks alive and holds a paid master untitled for up to 60.8 minutes before
// bootRecovery can even consider it. Left far below the 4h run cap so the
// two heartbeats can never disagree about a wedged render — that does not
// make 60.8min small, only smaller than 4h.
const REMOTION_RENDER_MS_MEASURED = 76_000;
const AD_HEARTBEAT_MAX_MS = Number(process.env.AD_HEARTBEAT_MAX_MS) || Math.max(
  10 * 60 * 1000,
  3 * Math.ceil(MAX_INFLIGHT / concurrency.REMOTION_QUEUE_CONCURRENCY) * REMOTION_RENDER_MS_MEASURED
);

// ACCEPTED RESIDUAL — stopping the beat does not stop the render, and does
// NOT release the claim. When the cap fires we stop telling Mongo about this
// row; Remotion keeps running in THIS process, and claimedByWorker stays set
// on purpose (see the divergence note below) so no OTHER adgen worker can
// claim it and resubmit a second paid Omni master. What we give up is only
// the protection against BACKEND recovery: if the render is still genuinely
// alive past the cap (not hung, just slow — the swapping/memory-pressure
// case above), the row now reads as abandoned to bootRecoveryService, which
// can hand it to titlingResumeService for a SECOND Remotion render on the
// same paid asset while ours is still in-process.
//
// THIS IS NOT THE SAME HAZARD CLASS campaignRunHeartbeat's 4h cap accepts,
// and treating it as directly equivalent overstates how settled this is.
// Stopping a RUN beat lets the reaper reclaim a whole batch — coarse, but a
// clean handoff. Stopping THIS beat risks a live dual-title race on one
// asset, for however long the render keeps running past the cap —
// CONCRETELY: two concurrent Remotion renders of the same clip on a box
// that has already OOM-killed twice today at ~2 GiB/slot. That is a memory
// event, not merely wasted CPU — say that plainly rather than leaning on
// "different hazard class" as an abstraction. Both traded away an uncapped
// beat's worse failure (a paid master stranded out of recovery's reach
// forever) for a bounded, smaller one — that part IS the same shape — but
// the smaller ones are not the same size or the same kind of smaller.
// Actually cancelling the in-flight Remotion job at the cap would close
// this properly; that reaches into remotionRenderService's queue and
// is out of scope here. The cap's calibration above is the mitigation
// available at this layer — keep it comfortably above measured render time,
// not tight, and do not read "60.8 minutes" as "effectively never happens."

/**
 * Beat one claimed ad's `updatedAt` while THIS worker is titling it.
 * Returns { stop } — call it in a finally; a double stop is a no-op.
 *
 * WRITES ONLY updatedAt. Never status, never titlingResumeState, never a
 * counter — same rule as campaignRunHeartbeat, for the same reason: a
 * heartbeat that touched outcome state would tell an operator work happened
 * that did not.
 *
 * DELIBERATE DIVERGENCE FROM THE PORTED SHAPE — the claimedByWorker term.
 * Backend's beat cannot express it because backend never sets that field;
 * renderer.js is the only writer of it in either repo. Requiring it here
 * means that if we somehow no longer own the claim we STOP beating, instead
 * of keeping another owner's row artificially alive and out of reach of the
 * recovery that should now have it. This is an improvement on the original,
 * not drift — do not "fix" it back when diffing the two copies.
 */
function startAdHeartbeat(adId) {
  const openedAt = Date.now();
  let stopped = false;
  const timer = setInterval(() => {
    // The cap. See AD_HEARTBEAT_MAX_MS.
    if (Date.now() - openedAt > AD_HEARTBEAT_MAX_MS) {
      clearInterval(timer);
      stopped = true;
      console.warn(
        `renderer[${WORKER_ID}]: titling heartbeat for ad=${String(adId).slice(-6)} hit the ` +
        `${Math.round(AD_HEARTBEAT_MAX_MS / 60000)}m cap — stopping liveness updates. Claim stays ` +
        `held (claimedByWorker unchanged) so no other adgen worker resubmits; backend recovery ` +
        `can now consider this row abandoned if the render is genuinely still running`
      );
      return;
    }
    Ad.updateOne(
      {
        _id: adId,
        claimedByWorker: WORKER_ID,
        $or: [
          { status: 'rendering' },
          { status: 'draft', titlingResumeState: 'claimed' }
        ]
      },
      { $set: { updatedAt: new Date() } }
    ).catch(() => {});   // a missed beat is survivable; the next one lands
  }, AD_HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}

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
  await maybeFinalizeRun(runId);
}

/**
 * Drive a CampaignRun to its terminal state once every claimed Ad has settled.
 *
 * WHY THIS EXISTS. The backend's own terminal write (routes/ads.js:2048,
 * `buildTerminalDoneFilter` -> status:'done' + completedAt) sits ~325 lines
 * AFTER runRenderLoop's adgen early-return, so with ADGEN_RENDERER_ENABLED
 * true it is unreachable. Nothing in adgen wrote it either: bumpRunCounter
 * only $inc'd counters. MEASURED in production: run_1787557633213_a0ccdd01
 * held succeeded=2 failed=1 total=3 — every ad settled — while status stayed
 * 'running' with completedAt null for ~20 minutes.
 *
 * That is not merely cosmetic. While updatedAt is stale past REAP_STALE_MIN
 * (15m) the backend's duplicate-generation gate loses its running arm, so an
 * identical /generate is admitted with no 409 — and for static that is a
 * second BILLED gpt-image-2 fan-out.
 *
 * WHY IT REUSES THE VENDORED BUILDERS rather than inventing semantics:
 * classifyRunAdOutcome + buildRunReconciliationUpdate are already vendored in
 * campaignRunGuards.js — byte-identical to the backend's — and were simply
 * never called from anywhere in src/. The backend reaper (worker.js:496-526)
 * makes exactly these calls. Using them means both services derive the same
 * verdict from the same Ad truth instead of two implementations drifting.
 *
 * SAFE AGAINST THE BACKEND REAPER BY CONSTRUCTION. The write is CAS-guarded on
 * status:'running', which is the identical guard worker.js:522 uses. Whichever
 * runs first wins; the loser's updateOne matches nothing and is a no-op. No
 * lock, no coordination, no double-write.
 *
 * DELIBERATELY DOES NOT HANDLE needsRetry. When some sibling ad has been
 * requeued away, buildRunReconciliationUpdate takes its stale-reaper branch,
 * whose operator-facing message reads "no update from the render loop for over
 * Xm" — true when a 15-minute reaper says it, a lie when we say it moments
 * after an ad settled. That case is left to the backend reaper, which has the
 * elapsed-time context to describe it honestly. Finalizing early is not worth
 * writing a false explanation into a row an operator reads.
 *
 * Failure is swallowed: this is a post-settle convenience, and the backend
 * reaper remains the backstop. It must never be able to fail a render.
 */
async function maybeFinalizeRun(runId) {
  if (!runId) return;
  try {
    // Match the backend reaper's query EXACTLY (worker.js:508): ads are found
    // by the runId STRING on campaignRunIds, not by the CampaignRun _id.
    const claimedAds = await Ad.find({ campaignRunIds: runId })
      .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage')
      .lean();
    if (!claimedAds.length) return;

    const outcome = classifyRunAdOutcome(claimedAds);
    if (!outcome.isSettled) return;       // something is still rendering
    if (outcome.needsRetry) return;       // see the header — backend reaper owns this

    const update = buildRunReconciliationUpdate(outcome, { now: new Date() });
    const res = await CampaignRun.updateOne({ runId, status: 'running' }, update);
    if (res && (res.modifiedCount || res.nModified)) {
      console.log(
        `renderer[${WORKER_ID}]: run ${runId} finalized -> done ` +
        `(succeeded=${outcome.succeeded} failed=${outcome.failed})`
      );
    }
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: maybeFinalizeRun(${runId}) failed: ${err.message}`);
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

  // Step 1 — derive LayoutInputArtifact. MIRRORS backend's
  // renderService.deriveStage exactly. Three moves:
  //   a. resolveQuoteAssemblyOptions — pre-computes funnel-stage + concept
  //      angle so the quote pool + stage-aware pick land consistently.
  //   b. buildLayoutInput — returns the derived input (NOT the artifact).
  //   c. LayoutInputArtifact.findOne — separate lookup for the persisted
  //      artifact's _id (buildLayoutInput does NOT return it — a Phase 1b
  //      wrong-destructure bug meant renderDirectImage always saw
  //      layoutInputArtifactId=undefined and fell back to a "generic
  //      layout" on every static render).
  //   d. applyStagedQuotePick — re-picks the printed quote against the
  //      stored pool so a cache-hit artifact written by another stage
  //      cannot leak.
  const quoteAssembly = await resolveQuoteAssemblyOptions({
    funnelStage:       ad.funnelStage || null,
    conceptArtifactId: ad.conceptArtifactId ? String(ad.conceptArtifactId) : null,
    conceptId:         ad.conceptId || null,
    conceptAngle:      null
  });

  const rawInput = await buildLayoutInput({
    mediaId:     String(ad.mediaId),
    template:    ad.template,
    aspectRatio: ad.aspectRatio,
    refresh:     false,
    options: {
      campaignKind:       ad.campaignKind || null,
      promotionalDetails: null,
      ctaText:            ad.ctaText || null,
      ctaUrl:             ad.ctaUrl  || null,
      variantKind:        ad.variantKind || 'ugc',
      productId:          ad.productId ? String(ad.productId) : null,
      paletteSource:      ad.paletteSource || 'media',
      rafflePrizeMediaId: ad.rafflePrizeMediaId ? String(ad.rafflePrizeMediaId) : null,
      funnelStage:        quoteAssembly.funnelStage,
      conceptAngle:       quoteAssembly.conceptAngle
    }
  });

  // Cache-key fields match buildLayoutInput's findOneAndReplace filter
  // (mediaId, template, aspectRatio, productId, variantKind) so the
  // FK re-read matches exactly the row buildLayoutInput just wrote.
  const artifact = await LayoutInputArtifact.findOne({
    mediaId:     String(ad.mediaId),
    template:    ad.template,
    aspectRatio: ad.aspectRatio,
    productId:   ad.productId ? String(ad.productId) : null,
    variantKind: ad.variantKind || 'ugc'
  }).select('_id').lean();

  const layoutInputArtifactId = artifact?._id || null;
  const input = applyStagedQuotePick(rawInput, {
    funnelStage:  quoteAssembly.funnelStage,
    conceptAngle: quoteAssembly.conceptAngle
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
    await Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID },
      { $set: {
          status: 'failed',
          renderError: { message: `skipped: ${result.reason || 'no reason'}`, stage: 'render', at: new Date() },
          claimedByWorker: null,
          claimedAt: null,
          updatedAt: new Date()
      }}
    );
    await bumpRunCounter(ad.campaignRunIds, 'skipped');
    return;
  }

  // renderDirectImage returned a paid buffer + metadata. Now upload to
  // Cloudinary (previously renderService.uploadStage) then persist the
  // full field set (previously renderService.persistStage). Doing this
  // in ONE Ad.updateOne closes the money bug where the ad stayed in
  // status:'rendering', got re-claimed, and re-billed a fresh Atlas
  // submit ($0.072/loop) — observed 21× on ad b46703 pre-fix, ~$1.44 lost.
  if (!result?.buffer) {
    throw new Error('renderDirectImage returned no buffer — cannot upload');
  }
  const upload = await uploadRenderToCloudinary(result, {
    brandId:        ad.brandId ? String(ad.brandId) : 'unknown',
    campaignId:     ad.campaignId ? String(ad.campaignId) : 'unknown',
    mediaId:        String(ad.mediaId),
    template:       ad.template,
    aspectRatio:    ad.aspectRatio,
    identityDigest: ad.identityDigest
  });

  const copy = extractCopySnapshot(input, result.renderedCopy || null);

  await Ad.updateOne(
    { _id: ad._id, claimedByWorker: WORKER_ID, status: 'rendering' },
    {
      $set: {
        layoutInputArtifactId,
        sourceFileType:     null,
        kind:               result.kind || 'image',
        renderUrl:          upload.renderUrl,
        posterUrl:          upload.posterUrl,
        cloudinaryPublicId: upload.cloudinaryPublicId,
        width:              upload.width,
        height:             upload.height,
        bytes:              upload.bytes,
        durationMs:         upload.durationMs,
        fontResolution:     result.fontResolution || null,
        imageGeneration:    result.imageGeneration || null,
        intentResolution:   result.intentResolution || null,
        visionQc:           result.visionQc || null,
        copy,
        status:             'draft',
        renderedAt:         new Date(),
        updatedAt:          new Date(),
        claimedByWorker:    null,
        claimedAt:          null
      },
      $inc: { renderAttempts: 1 }
    }
  );

  console.log(`renderer[${WORKER_ID}]: STATIC done ad=${shortId} wall=${wallSec}s url=${upload.renderUrl.slice(0, 60)}…`);
  await bumpRunCounter(ad.campaignRunIds, 'succeeded');
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

/**
 * Fallback half of the video terminal stamp, shared by both branches.
 * Reached ONLY when the guarded promote-to-draft write matched nothing,
 * i.e. something already stamped a terminal verdict. Returns
 * { status, counter }.
 *
 * The promote write itself stays INLINE in each branch on purpose: two
 * harnesses read the literal out of the branch body — verifyPmaxVideoExpansion
 * E1b wants `status: 'draft'` inside the derive body, and
 * verifyRendererAtomicClaim D1 wants status and `claimedByWorker: null` in the
 * SAME update document. Hoisting it here would blind both.
 *
 * THE GUARD IS THE POINT. Titling runs before this and can stamp its OWN
 * terminal verdict: services/brandScriptExecutor.js buildVideoQcFailureFields
 * sets status:'failed' when vision QC really fails (PR #282 — "deliver a
 * QC-failed ad as failed with the exact Slack reason"). This write used to be
 * a bare { _id }, so it overwrote that verdict with 'draft' and then counted
 * the ad 'succeeded'. Measured in prod 2026-08-24: 47 video ads with
 * visionQc.passed:false sitting in status:'draft', and ZERO in 'failed' —
 * B=0 is the signature; the verdict never survived even once.
 *
 * WHY $nin AND NOT status:'rendering'. Copying renderStatic's
 * { _id, claimedByWorker, status:'rendering' } filter here looks right and is
 * wrong: uploadRenderAndStamp (brandScriptExecutor.js) already promoted this
 * row to 'draft' during titling, so a 'rendering' guard would no-op on every
 * SUCCESSFUL render — stranding claimedByWorker forever (claimOne needs it
 * null, and nothing in either repo ever clears it) and leaving the titling
 * debt for titlingResumeService to re-render. $nin preserves any terminal
 * verdict, whoever wrote it, without blocking the happy path.
 * AN ALLOWLIST, NOT A DENYLIST, AND THAT DIRECTION IS THE SAFETY PROPERTY.
 * A $nin:['failed','archived'] denylist fails OPEN: any status nobody
 * enumerated gets overwritten with 'draft'. That resurrects a row a backend
 * requeue just moved to 'queued' (processAlerts SIGTERM / the crash catches),
 * and it DEMOTES an ad an operator promoted to 'live'. The allowlist admits
 * only the two states this function legitimately owns at this point —
 * 'rendering' (no-chrome / no-brand: titling never ran) and 'draft' (the
 * normal case: uploadRenderAndStamp already promoted it) — so every unknown
 * status falls to the settle-only arm, which releases the claim and clears
 * the debt WITHOUT touching status. Unknown state => leave it alone.
 * These literals live in the FILTER, never the update, so renderer.js still
 * never WRITES 'archived' — see scripts/verifyRendererAdStatusEnum.js B3.
 *
 * The claim + debt are settled on BOTH branches. A no-op that skipped them
 * would trade a clobbered verdict for a permanently unclaimable row.
 */
async function settleNonDraftTerminal(ad, label) {
  const shortId = String(ad._id).slice(-6);
  // A terminal verdict was already stamped. Do NOT resurrect it — but the
  // claim and the titling debt are still ours to settle.
  const after = await Ad.findOneAndUpdate(
    { _id: ad._id },
    {
      $set: {
        titlingResumeState: null,
        claimedByWorker:    null,
        claimedAt:          null,
        updatedAt:          new Date()
      }
    },
    { new: true, projection: { status: 1 } }
  ).lean();
  const kept = (after && after.status) || 'failed';
  console.warn(
    `renderer[${WORKER_ID}]: ${label} ad=${shortId} kept terminal status='${kept}' ` +
    `(NOT overwritten with draft) — claim released, titling debt cleared`
  );
  // 'archived' is an operator action, not a render failure; only a real
  // 'failed' verdict counts against the run.
  return { status: kept, counter: kept === 'failed' ? 'failed' : 'succeeded' };
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
      // Beat updatedAt for the whole titling window — including the queue
      // wait, which writes nothing otherwise. See startAdHeartbeat.
      const beat = startAdHeartbeat(adId);
      let chromeOut;
      try {
        chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
      } finally {
        beat.stop();   // must not outlive the render, on success OR throw
      }
      if (chromeOut?.skipped) {
        console.log(`renderer[${WORKER_ID}]: VIDEO DERIVE no-chrome ad=${shortId} — shipping master`);
      }
    }

    // Success stamp — clear titling debt, terminal state. GUARDED: titling
    // may already have stamped status:'failed' (vision QC). See
    // settleNonDraftTerminal for the full reasoning.
    const derivePromoted = await Ad.updateOne(
      { _id: ad._id, status: { $in: ['rendering', 'draft'] } },
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
    const deriveSettled = derivePromoted.matchedCount
      ? { status: 'draft', counter: 'succeeded' }
      : await settleNonDraftTerminal(ad, 'VIDEO DERIVE');
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `renderer[${WORKER_ID}]: VIDEO DERIVE done ad=${shortId} wall=${wallSec}s status=${deriveSettled.status}`
    );
    await bumpRunCounter(ad.campaignRunIds, deriveSettled.counter);
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
    // Beat updatedAt for the whole titling window — including the queue
    // wait, which writes nothing otherwise. See startAdHeartbeat.
    const beat = startAdHeartbeat(adId);
    let chromeOut;
    try {
      chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
    } finally {
      beat.stop();   // must not outlive the render, on success OR throw
    }
    if (chromeOut?.skipped) {
      console.log(`renderer[${WORKER_ID}]: VIDEO MASTER no-chrome ad=${shortId} — shipping master`);
    }
  }

  // Terminal — clear titling debt + claim. GUARDED: titling may already have
  // stamped status:'failed' (vision QC). See settleNonDraftTerminal.
  const masterPromoted = await Ad.updateOne(
    { _id: ad._id, status: { $in: ['rendering', 'draft'] } },
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
  const masterSettled = masterPromoted.matchedCount
    ? { status: 'draft', counter: 'succeeded' }
    : await settleNonDraftTerminal(ad, 'VIDEO MASTER');
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `renderer[${WORKER_ID}]: VIDEO MASTER done ad=${shortId} wall=${wallSec}s status=${masterSettled.status}`
  );
  await bumpRunCounter(ad.campaignRunIds, masterSettled.counter);
}

// In-process concurrent-render tracking. Every processAd() invocation
// increments this on entry and decrements on completion (finally). poll()
// burst-claims up to MAX_INFLIGHT and fires each render as an unawaited
// promise, so one instance can run many concurrent ads.
let inFlight = 0;

// End-to-end render for one claimed ad. Wrapped so poll() can dispatch
// via .finally() without holding the poll loop.
async function processAd(ad) {
  const started = Date.now();
  try {
    if (ad.renderRoute === 'html_gen') {
      await renderStatic(ad);
    } else if (ad.renderRoute === 'veo') {
      await renderVideo(ad);
    } else {
      throw new Error(`unknown renderRoute: ${ad.renderRoute}`);
    }
  } catch (err) {
    const shortId = String(ad._id).slice(-6);
    const wallSec = ((Date.now() - started) / 1000).toFixed(1);
    console.error(`renderer[${WORKER_ID}]: render failed ad=${shortId} route=${ad.renderRoute} wall=${wallSec}s: ${err.message}`);
    try { noteRenderIssue(ad._id, { message: err.message, stage: 'render' }); } catch (_) {}
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
}

async function poll() {
  const start = Date.now();
  try {
    if (!isAdgenRendererEnabled()) {
      resetReconnectAttempts();
      scheduleNext(start);
      return;
    }

    // Burst-claim: keep pulling ads while there's spare capacity. Each
    // claim is an atomic findOneAndUpdate (fast ~ms) and the render fires
    // as an unawaited promise so N concurrent renders share this single
    // Node event loop. Loop guarded by MAX_INFLIGHT so we never over-
    // subscribe local resources (Sharp memory, Remotion pool, etc).
    while (inFlight < MAX_INFLIGHT) {
      const ad = await claimOne();
      if (!ad) break;   // queue empty for now — next poll will re-check
      inFlight++;
      // Fire-and-forget: processAd manages its own error state and Ad row.
      // .finally releases the slot regardless of outcome.
      processAd(ad).finally(() => { inFlight--; });
    }
    resetReconnectAttempts();
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
    `renderer[${WORKER_ID}] starting — poll interval ${POLL_MS}ms, max-inflight ${MAX_INFLIGHT}, handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}`
  );
  poll();
  setInterval(() => {
    if (stopping) return;
    const g = isAdgenRendererEnabled();
    console.log(`renderer[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s, inflight ${inFlight}/${MAX_INFLIGHT}, handoff ${g ? 'ON' : 'OFF'}`);
  }, 30_000).unref();
}

function shutdown() {
  stopping = true;
  console.log(`renderer[${WORKER_ID}] shutting down`);
}

module.exports = { run, shutdown };
