// Ad regenerate-with-prompt — re-runs the render pipeline for a single
// existing Ad with an operator-supplied refinement prompt threaded into
// the relevant LLM(s).
//
// Two modes (chosen by routes/ads.js based on ad.kind):
//
//   image (2026-08-02 — Stage 1 catalog pipeline exclusive):
//     1. Re-run the LIVE static renderer (directImageRenderService /
//        gpt-image-2/edit) from the Ad's own fields — layoutInput, concept,
//        media, platformFormat. No aiCanvasArtifactId, no HTML Gen, no
//        Puppeteer. Exactly ONE billable image submit per invocation.
//     2. Upload the finished PNG to Cloudinary (overwrite publicId so
//        Ad.renderUrl stays stable across regens).
//     3. Stamp renderUrl + imageGeneration + intentResolution.
//
//   video (always "full" — LIGHT mode was retired with the HTML/Puppeteer
//   chrome pipeline; brand-script chrome is deterministic and cheap
//   enough that separating chrome-only from video-only isn't worth the
//   surface area. Chrome-only tweaks now happen at the template level
//   via the Brand page video card).
//     1. Storyboard regenerated with operatorPrompt threaded in.
//     2. New Grok video via videoRouter.generateForAd.
//     3. Brand-script canvas overlay via brandScriptExecutor.
//        renderBrandScriptAndSave — resolver picks the right script by
//        format; no chrome when brand has neither styleScript* nor
//        styleTheme.
//
// State updates throughout: Ad.regenerationStage tracks progress so the
// frontend's 5s poll can show stage labels ("Re-rolling video…",
// "Compositing…"). On completion, regenerating flips false, stage
// clears, history gets the appended entry.
//
// The `mode` param on the API route is now advisory only for video
// (always full); it's preserved for image ads (always full anyway) and
// backward-compat with the current frontend UI that may still send
// mode='light'.

const Ad                    = require('../models/Ad');
const Media                 = require('../models/Media');
const Brand                 = require('../models/Brand');
const veoService            = require('./videoRouter');
const brandScriptExecutor   = require('./brandScriptExecutor');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const directImage           = require('./directImageRenderService');

const HISTORY_CAP   = 5;
const DAILY_CAP     = Math.max(1, parseInt(process.env.REGENERATE_DAILY_CAP, 10) || 10);

// ── Public API ────────────────────────────────────────────────────────

// Validate: not exported, not regenerating, under daily cap. Throws an
// Error with .status (400/409/429) so the route can return clean codes.
async function preflight(adId, brandId) {
  const ad = await Ad.findOne({ _id: adId, brandId }).lean();
  if (!ad) { const e = new Error('Ad not found');                         e.status = 404; throw e; }
  if (ad.metaSyncStatus === 'synced') {
    const e = new Error('Ad has been exported to Meta — regeneration disabled (the synced version is canonical).');
    e.status = 409; throw e;
  }
  if (ad.regenerating) {
    const e = new Error('A regeneration is already in progress for this ad.');
    e.status = 409; throw e;
  }
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (ad.regenerationHistory || []).filter(h =>
    h.at && new Date(h.at).getTime() > since
  );
  if (recent.length >= DAILY_CAP) {
    const e = new Error(`Daily regenerate cap reached (${DAILY_CAP} per ad per 24h). Try again later.`);
    e.status = 429; throw e;
  }
  return ad;
}

// Entry point. Spawned via setImmediate from the route handler — the
// route responds 202 with { regenerating: true } and the worker runs
// in the background. The frontend polls /api/catalog/:id/ads-detail
// every 5s watching Ad.regenerating.
async function regenerateAd({ ad, prompt, mode, requestedBy, videoModel = null, promptOverride = null }) {
  const adId      = String(ad._id);
  const kind      = ad.kind || 'image';
  // Video always regens fully (new Grok video + brand-script chrome).
  // The `mode` argument is preserved for backward-compat with existing
  // frontend clients that may still send 'light' — we normalize it here.
  const effMode   = 'full';
  const startedAt = Date.now();
  const historyEntry = {
    prompt:        String(prompt || '').slice(0, 1000),
    mode:          effMode,
    requestedBy:   requestedBy || null,
    videoModel:    videoModel || null,
    // true when this run used a verbatim prompt-text override (operator
    // edited the exact prompt in the Generation Details modal) rather
    // than the refinement-note path. The full text is what the image
    // model receives (see resolveImagePromptOverride); history only flags.
    rawPromptEdit: !!promptOverride,
    at:            new Date(startedAt),
    status:        'pending'
  };

  console.log(
    `🔁 regenerate[ad=${adId}]: kind=${kind} mode=${effMode}` +
    (videoModel ? ` videoModel=${videoModel}` : '') +
    (promptOverride ? ' rawPromptEdit=true' : ` prompt="${historyEntry.prompt.slice(0, 60)}${historyEntry.prompt.length > 60 ? '…' : ''}"`)
  );

  // Atomic lock + append in-flight history entry. Filter requires
  // regenerating ≠ true so two concurrent workers cannot both win the
  // race past preflight; the loser sees modifiedCount === 0 and exits
  // without spending provider quota or touching progress.
  const lockResult = await Ad.updateOne(
    { _id: adId, regenerating: { $ne: true } },
    {
      $set: {
        regenerating:      true,
        regenerationStage: 'pending',
        updatedAt:         new Date()
      },
      $push: {
        regenerationHistory: { $each: [historyEntry], $slice: -HISTORY_CAP }
      }
    }
  );
  if (lockResult.modifiedCount === 0) {
    console.log(`🔁 regenerate[ad=${adId}]: already in flight — skipped`);
    return;
  }

  // Unified progress row (ActivityDock). Cancel is honored between
  // stages (veo → composite / image-gen) — the in-flight provider call
  // finishes, then the regenerate stops and the ad keeps its previous
  // render.
  const { startRun, CancelledError } = require('./progressService');
  const brandDoc = await require('../models/Brand').findById(ad.brandId).select('advertiserId').lean().catch(() => null);
  const progressRun = await startRun({
    kind: 'ad-regenerate', advertiserId: brandDoc?.advertiserId, brandId: ad.brandId,
    label: kind === 'video' ? 'Video ad regenerate' : 'Ad regenerate'
  });

  try {
    if (kind === 'video') {
      await runVideoFull(adId, prompt, progressRun, videoModel);
    } else {
      await runImage(adId, prompt, progressRun, promptOverride);
    }

    const durationMs = Date.now() - startedAt;
    await markComplete(adId, { status: 'done', durationMs });
    // progress-row failures must not re-enter the outer catch (which
    // would markComplete status:'failed' over a real success).
    try {
      await progressRun.succeed({ durationMs });
    } catch (progErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: progressRun.succeed failed (non-fatal) — ${progErr.message}`);
    }
    console.log(`🔁 regenerate[ad=${adId}]: done in ${Math.round(durationMs / 1000)}s`);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof CancelledError) {
      console.log(`🔁 regenerate[ad=${adId}]: cancelled by operator after ${Math.round(durationMs / 1000)}s`);
      await markComplete(adId, { status: 'failed', durationMs, error: 'cancelled by operator' });
      return;
    }
    console.error(`❌ regenerate[ad=${adId}]: failed after ${Math.round(durationMs / 1000)}s — ${err.message}`);
    await markComplete(adId, { status: 'failed', durationMs, error: err.message || String(err) });
    await progressRun.fail(err);
  }
}

// ── Per-mode workers ──────────────────────────────────────────────────

// Load brand — one Media + one Brand lookup — with all fields the
// brand-script executor's format-aware resolver needs.
async function loadBrand(adId) {
  const ad = await Ad.findById(adId).select('mediaId').lean();
  const media = ad?.mediaId ? await Media.findById(ad.mediaId).select('brandId').lean() : null;
  return media?.brandId
    ? await Brand.findById(media.brandId)
        .select('name styleScript styleScriptVertical styleScriptLandscape styleTheme tagline logoUrl websiteUrl primaryColor secondaryColor accentColor fontFamily fontSource curatedFields tailwindTheme websiteFontUsage customFonts videoSettings titleStyleSpec titleStylePreset').lean()
    : null;
}

// Video regen — always full. Regenerates the storyboard + Grok base
// video, then applies brand-script chrome (or no chrome, per resolver).
async function runVideoFull(adId, prompt, progressRun = null, videoModel = null) {
  // Stage 1 — context prep (model + aspect resolution, layoutInput
  // warm). storyboard is null on the Atlas path — the Ken Burns prompt
  // directs motion; the operator's refinement prompt is threaded into
  // the video prompt itself in Stage 2. videoModel (the regenerate
  // dropdown's per-run override) goes to BOTH stages so they resolve
  // the same model.
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('generating video'); }
  await setStage(adId, 'veo');
  const ad1 = await Ad.findById(adId).lean();
  const { storyboard } = await veoService.prepareStoryboard({ ad: ad1, operatorPrompt: prompt, modelOverride: videoModel });

  if (storyboard) {
    await Ad.updateOne({ _id: adId }, { $set: { veoStoryboard: storyboard, updatedAt: new Date() } });
  }

  // Stage 2 — new base video (model per override → settings → default).
  const veoResult = await veoService.generateForAd({ ad: ad1, operatorPrompt: prompt, storyboard, modelOverride: videoModel });
  if (veoResult.skipped) throw new Error(`Veo skipped: ${veoResult.reason}`);

  // Stamp the raw render before chrome so a chrome failure still
  // leaves a viewable fallback (the bare Grok video).
  await Ad.updateOne({ _id: adId }, {
    $set: {
      veoVideoUrl:    veoResult.videoUrl,
      veoAspectRatio: veoResult.aspectRatio || null,
      veoPrompt:      veoResult.prompt || null,
      veoStoryboard:  veoResult.storyboard || storyboard || null,
      veoModel:       veoResult.model || null,
      veoReferenceImages: veoResult.referenceImages || [],
      renderUrl:      veoResult.videoUrl,
      renderedAt:     new Date(),
      updatedAt:      new Date()
    }
  });

  // Stage 3 — brand-script canvas overlay. Resolver picks the right
  // script by format; returns skipped when no chrome is configured
  // (raw Grok video stays as renderUrl in that case). Failure is
  // non-fatal for the same reason.
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('compositing'); }
  await setStage(adId, 'composite');
  const brand = await loadBrand(adId);
  if (brand) {
    const adFinal = await Ad.findById(adId).lean();
    try {
      await brandScriptExecutor.renderBrandScriptAndSave({ ad: adFinal, brand });
    } catch (scriptErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: brand-script failed (non-fatal) — ${scriptErr.message}`);
    }
  }
}

// IMAGE regeneration via the live direct_image renderer.
//
// Re-derives everything renderDirectImage needs from the Ad row itself:
// layoutInputArtifactId, aspectRatio, mediaId, productId, template,
// conceptArtifactId/conceptId, platformFormat, referenceMediaIds /
// mediaIds. Does NOT require aiCanvasArtifactId (the previous
// precondition that made regenerate fail for every ad the current
// pipeline produces — directImageRenderService never stamps it).
//
// MONEY: renderDirectImage performs exactly one editImage submit.
// There is no retry-on-failure here. If the provider already charged
// (err.charged), the failure is recorded and the caller does not
// re-submit — same convention as renderService's direct-image path.
async function runImage(adId, prompt, progressRun = null, promptOverride = null) {
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('generating image'); }
  await setStage(adId, 'image-gen');
  const ad = await Ad.findById(adId).lean();
  if (!ad) throw new Error(`Ad ${adId} not found`);

  // Reference stack: same precedence as renderService (operator stack
  // wins; else Director concept mediaIds; else seed media alone inside
  // renderDirectImage).
  const hasOperatorRefs = Array.isArray(ad.referenceMediaIds) && ad.referenceMediaIds.length > 0;
  const referenceMediaIds = hasOperatorRefs
    ? ad.referenceMediaIds
    : (Array.isArray(ad.mediaIds) ? ad.mediaIds : []);
  const referenceSource = hasOperatorRefs ? 'operator' : 'director';

  let output;
  try {
    output = await directImage.renderDirectImage({
      layoutInputArtifactId: ad.layoutInputArtifactId || null,
      aspectRatio:           ad.aspectRatio,
      mediaId:               ad.mediaId,
      productId:             ad.productId || null,
      brandId:               ad.brandId || null,
      adConceptArtifactId:   ad.conceptArtifactId || null,
      adConceptId:           ad.conceptId || null,
      template:              ad.template,
      platformFormat:        ad.platformFormat || 'meta_feed_1_1',
      referenceMediaIds,
      referenceSource,
      // Refinement note (Product Ads modal) OR verbatim override
      // (Generation Details). Override wins inside renderDirectImage.
      operatorPrompt:        prompt || null,
      rawPromptOverride:     promptOverride || null
    });
  } catch (err) {
    // Carry charged/predictionId so a charged failure is visible in
    // logs and progress, and so no outer layer invents a second submit.
    if (err.charged) {
      console.error(
        `💸 regenerate[ad=${adId}]: image submit was charged` +
        (err.predictionId ? ` (prediction ${err.predictionId})` : '') +
        ` before failing — not retrying`
      );
    }
    throw err;
  }

  if (output?.skipped) {
    throw new Error(`direct-image regenerate skipped: ${output.reason || 'unknown'}`);
  }
  if (!output?.buffer) {
    throw new Error('direct-image regenerate returned no image buffer');
  }

  // Upload — overwrite existing publicId when present so the Ad's
  // renderUrl stays stable across regens (same contract as the old path).
  const publicId = ad.cloudinaryPublicId || undefined;
  const uploaded = await uploadBufferToCloudinary(output.buffer, {
    folder:       'liquidretail/ad_renders',
    publicId,
    resourceType: 'image',
    overwrite:    true
  });

  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        renderUrl:          uploaded.secure_url,
        cloudinaryPublicId: uploaded.public_id,
        width:              output.width  || uploaded.width  || null,
        height:             output.height || uploaded.height || null,
        bytes:              output.bytes  || uploaded.bytes  || null,
        imageGeneration:    output.imageGeneration  || null,
        intentResolution:   output.intentResolution || null,
        renderedAt:         new Date(),
        updatedAt:          new Date()
      }
    }
  );
}

// ── State helpers ──────────────────────────────────────────────────────

async function setStage(adId, stage) {
  await Ad.updateOne(
    { _id: adId },
    { $set: { regenerationStage: stage, updatedAt: new Date() } }
  );
}

async function markComplete(adId, { status, durationMs, error }) {
  // Atomic update of the pending history entry via arrayFilters.
  // With the atomic lock in regenerateAd at most one pending entry
  // exists, so matching e.status:'pending' is safe and avoids the
  // prior read-modify-write that could stomp a concurrent push.
  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        regenerating:                          false,
        regenerationStage:                     null,
        'regenerationHistory.$[e].status':     status,
        'regenerationHistory.$[e].durationMs': durationMs,
        'regenerationHistory.$[e].error':      error || null,
        updatedAt:                             new Date()
      }
    },
    { arrayFilters: [{ 'e.status': 'pending' }] }
  );
}

module.exports = {
  preflight,
  regenerateAd,
  // Exported so the offline harness can assert the direct-image path
  // (no aiCanvasArtifactId precondition) without invoking providers.
  runImage,
  DAILY_CAP
};
