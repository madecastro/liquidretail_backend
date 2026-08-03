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

const mongoose              = require('mongoose');
const Ad                    = require('../models/Ad');
const Media                 = require('../models/Media');
const Brand                 = require('../models/Brand');
const veoService            = require('./videoRouter');
const brandScriptExecutor   = require('./brandScriptExecutor');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const directImage           = require('./directImageRenderService');

const HISTORY_CAP   = 5;
const DAILY_CAP     = Math.max(1, parseInt(process.env.REGENERATE_DAILY_CAP, 10) || 10);

// ── Catalog-first reseed on regenerate ────────────────────────────────
//
// THE PROBLEM. Regenerate used to REPLAY a stored reference stack and never
// re-derive it. Ads queued while DIRECTOR_UNIVERSE_TOP_N was 10 still hold 3+
// entries in Ad.mediaIds, so regenerating them today still sends 3+ references
// — forever, on every future regen.
//
// WHY THIS IS NOT A TRIM. Trimming Ad.mediaIds to its first element would be
// actively harmful. Those historical stacks were ordered by the shotType
// ranking (services/shotTypeRank.js), which sorts LIFESTYLE FIRST, over a pool
// that MERGES catalog media with product_match UGC. So mediaIds[0] on an old ad
// is frequently a UGC/lifestyle post; trimming to [0] would permanently lock a
// social image in as the seed — the exact outcome the owner is guarding
// against. So we RE-DERIVE from the catalog instead.
//
// THE DERIVATION mirrors the live "Feed-order hero" cascade at
// campaignAdsGenerationService.js:2085 (imageRole hero → earliest createdAt →
// nothing) and the owner rule documented for
// seededUniverseService.promoteFirstCatalogImage: "the first image that came
// from the catalog". It is REIMPLEMENTED LOCALLY rather than imported because
// campaignAdsGenerationService is mid-edit in a separate change and importing a
// symbol out of it would couple this behaviour to that file's in-flight state.
// buildSeededUniverse is deliberately NOT called: it is heavier, also mid-edit,
// and its ranked pool contains UGC by construction.
//
// STRUCTURALLY CATALOG-ONLY. Every query pins source:'catalog-product', and
// every candidate is re-checked by isCatalogMediaForProduct() before it can be
// selected. imageRole is never queried on its own — a UGC doc carrying
// metadata.imageRole:'hero' can therefore never be picked. Scope is BOTH the
// ad's own product (metadata.catalogProductId) AND the ad's brand
// (Media.brandId), so neither a cross-product nor a cross-tenant photo can
// leak into the ad.
//
// MONEY (CLAUDE.md §2). This changes WHICH image seeds the ad, never HOW MANY
// submits happen. renderDirectImage still performs exactly one gpt-image-2/edit
// submit per invocation, and reference COUNT does not move the price (flat
// model base_price, no images.length multiplier — atlasImageService.js:75-104).
//
// NOT PERSISTED. The derived stack is computed at regenerate time and passed
// into the render call only. Writing it back onto Ad.mediaIds would silently
// rewrite historical rows and make the kill switch useless for anything already
// regenerated once.
//
// KILL SWITCH: REGEN_RESEED_CATALOG_FIRST, DEFAULT ON. This changes how
// ALREADY-GENERATED ads look when regenerated, so it must be reversible without
// a code deploy.

const RESEED_SKIP = {
  FLAG_OFF:          'REGEN_RESEED_CATALOG_FIRST=false',
  VIDEO:             'video regenerate (static-only behaviour)',
  NOT_PRODUCT_IMAGE: 'variantKind is not product_image (UGC path is unoptimized — owner)',
  OPERATOR_REFS:     'operator referenceMediaIds present (explicit pick always wins)',
  NO_PRODUCT:        'ad has no productId',
  NO_CATALOG_MEDIA:  'no catalog-product Media for this product+brand'
};

// Kill switch. Follows the repo's boolean-flag idiom
// (atlasVideoService.isRepeatPrimaryReferenceEnabled) — unset/empty falls to the
// documented default, and only an explicit 0/false/no/off turns it off. Default
// here is ON because the owner asked for this behaviour.
function isRegenReseedCatalogFirstEnabled() {
  const raw = process.env.REGEN_RESEED_CATALOG_FIRST;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// PURE. The whole gate, in one place, so the offline harness can assert it
// without a DB. Returns { reseed, reason } — reason is the log-ready skip
// reason, null when reseeding.
//
// ALL FOUR conditions must hold. Any one false → behave exactly as before.
function reseedDecision({ ad, flagEnabled }) {
  if (!flagEnabled)                        return { reseed: false, reason: RESEED_SKIP.FLAG_OFF };
  // (a) STATIC only. runImage is the static worker (regenerateAd routes
  //     kind==='video' to runVideoFull), but the gate is restated here so the
  //     pure function is the single source of truth and the harness can prove
  //     a video ad is never reseeded.
  if ((ad?.kind || 'image') === 'video')   return { reseed: false, reason: RESEED_SKIP.VIDEO };
  // (b) HARD OWNER REQUIREMENT, verbatim: "UGC ads shouldn't be affected by
  //     this change, we haven't optimized that path yet." A variantKind:'ugc'
  //     ad is SUPPOSED to seed from a social image — re-deriving it to a
  //     catalog photo breaks it by design. NOT OPTIONAL.
  if (ad?.variantKind !== 'product_image') return { reseed: false, reason: RESEED_SKIP.NOT_PRODUCT_IMAGE };
  // (c) A non-empty referenceMediaIds is an explicit operator pick — owner:
  //     "unless the user overrides it".
  if (Array.isArray(ad?.referenceMediaIds) && ad.referenceMediaIds.length > 0) {
    return { reseed: false, reason: RESEED_SKIP.OPERATOR_REFS };
  }
  // (d) No product → nothing to derive from.
  if (!ad?.productId)                      return { reseed: false, reason: RESEED_SKIP.NO_PRODUCT };
  return { reseed: true, reason: null };
}

function shouldReseedFromCatalog({ ad, flagEnabled }) {
  return reseedDecision({ ad, flagEnabled }).reseed;
}

// PURE. The single predicate that makes the cascade structurally incapable of
// returning non-catalog / cross-product / cross-tenant media. Nothing is
// selectable unless it passes this, regardless of which query produced it.
function isCatalogMediaForProduct(doc, { productId, brandId }) {
  if (!doc || !doc._id) return false;
  if (doc.source !== 'catalog-product') return false;
  // source==='catalog-product' is NOT "is an image". Catalog VIDEOS share that
  // source (shopifyPublicIngestService.js:513-546 writes fileType:'video' +
  // metadata.imageRole:'video' and does resolve catalogProductId), so without
  // this the tier-2 earliest-createdAt branch could seed a STATIC image
  // regenerate with an .mp4. Tier 1 is safe only incidentally, via the hero
  // stamp. Excluding an EXPLICIT video rather than demanding fileType==='image'
  // keeps legacy rows with an absent fileType eligible — the same reasoning as
  // seededUniverseService.promoteFirstCatalogImage, so the two cascades agree.
  if (doc.fileType === 'video') return false;
  if (doc.metadata?.imageRole === 'video') return false;
  // A derived id is only usable if it actually resolves to an image the renderer
  // can fetch. An empty/absent fileUrl means renderDirectImage would resolve zero
  // references and silently fall back to the ad's original seed while we had
  // already logged a successful reseed — see the SELECT comment below.
  if (typeof doc.fileUrl !== 'string' || !doc.fileUrl.trim()) return false;
  const docProduct = doc.metadata?.catalogProductId;
  if (docProduct == null || String(docProduct) !== String(productId)) return false;
  if (doc.brandId == null || String(doc.brandId) !== String(brandId)) return false;
  return true;
}

// PURE tier selection over an in-memory candidate list. Mirrors the tier order
// at campaignAdsGenerationService.js:2085.
//   TIER 1  metadata.imageRole === 'hero'
//   TIER 2  else earliest createdAt
//   TIER 3  else null → derive NOTHING
// Returns { mediaId, tier } | null.
function pickFirstCatalogMediaId(candidates, { productId, brandId }) {
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter((doc) => isCatalogMediaForProduct(doc, { productId, brandId }));
  if (!eligible.length) return null;

  const hero = eligible.find((doc) => doc.metadata?.imageRole === 'hero');
  if (hero) return { mediaId: hero._id, tier: 'hero' };

  // Stable earliest-createdAt: ties keep input (feed) order. A missing
  // createdAt sorts last so a stamped doc always beats an unstamped one.
  const ts = (doc) => {
    const t = doc.createdAt ? new Date(doc.createdAt).getTime() : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  let earliest = eligible[0];
  for (const doc of eligible.slice(1)) if (ts(doc) < ts(earliest)) earliest = doc;
  return { mediaId: earliest._id, tier: 'earliest-createdAt' };
}

// DB side. Two findOne queries, both pinning source + product + brand, then the
// pure guard above vets the result.
//
// NOT identical to the generation-time cascade, and the difference is deliberate:
// the deterministic-video cascade (campaignAdsGenerationService.js:2085) scopes by
// source + metadata.catalogProductId ONLY, relying on catalogProductId being
// globally unique. We additionally require brandId. Consequence, stated honestly
// rather than glossed: a legacy catalog Media row with a null or wrong brandId is
// selectable by the generation-time promotion (which gates on role, not brandId)
// but NOT here — this returns nothing and the regenerate keeps today's behaviour.
// That is failing CLOSED (no change to the ad) rather than risking a cross-tenant
// seed, which is the right direction for the trade, but it does mean the two paths
// can disagree on such a row. Do not "align" them by dropping brandId.
//
// metadata is a Mixed path, so mongoose does NOT cast a string id inside it;
// the ObjectId conversion is load-bearing, not cosmetic.
async function deriveFirstCatalogMediaId({ productId, brandId }) {
  if (!productId || !brandId) return null;
  let productOid, brandOid;
  try {
    productOid = new mongoose.Types.ObjectId(String(productId));
    brandOid   = new mongoose.Types.ObjectId(String(brandId));
  } catch { return null; }

  // fileType MUST be projected: the guard below rejects fileType==='video', and
  // an unprojected field is undefined, which would silently pass that check and
  // leave only the metadata.imageRole half of the video defence working.
  //
  // fileUrl MUST be projected for the same class of reason, and it is the more
  // dangerous omission. Without it the guard cannot tell a usable Media from a
  // deleted or half-materialised one, so we would log
  // "catalog reseed — stack 3 ref(s) → 1" and hand renderDirectImage an id that
  // resolves to nothing; it then finds zero reference candidates and falls back
  // to media.fileUrl — the ad's ORIGINAL seed, which on the historical rows this
  // feature exists to fix is frequently the UGC/lifestyle image. That is the
  // worst available outcome: a success log over a silent UGC seed, costing a real
  // billable submit. Requiring fileUrl turns it into an honest tier-3 skip.
  const SELECT = '_id source brandId fileType fileUrl metadata createdAt';
  // $ne:'video' also matches docs where fileType is absent or null, which is the
  // behaviour we want — legacy untyped rows stay eligible for tier 2 rather than
  // falling through to tier 3. The post-query guard re-checks it regardless.
  const scope  = {
    source: 'catalog-product',
    brandId: brandOid,
    'metadata.catalogProductId': productOid,
    fileType: { $ne: 'video' },
  };

  // TIER 1 — the hero stamp. Note imageRole is only ever an ADDITIONAL filter
  // on top of the catalog scope; it is never queried alone.
  const hero = await Media.findOne({ ...scope, 'metadata.imageRole': 'hero' }).select(SELECT).lean();
  if (isCatalogMediaForProduct(hero, { productId: productOid, brandId: brandOid })) {
    return { mediaId: hero._id, tier: 'hero' };
  }

  // TIER 2 — earliest catalog entry in feed order.
  const earliest = await Media.findOne(scope).sort({ createdAt: 1 }).select(SELECT).lean();
  if (isCatalogMediaForProduct(earliest, { productId: productOid, brandId: brandOid })) {
    return { mediaId: earliest._id, tier: 'earliest-createdAt' };
  }

  // TIER 3 — nothing. Caller leaves existing behaviour completely untouched.
  return null;
}

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
  let referenceMediaIds = hasOperatorRefs
    ? ad.referenceMediaIds
    : (Array.isArray(ad.mediaIds) ? ad.mediaIds : []);
  let referenceSource = hasOperatorRefs ? 'operator' : 'director';

  // CATALOG-FIRST RESEED. Replaces the replayed Director stack with the ad's
  // first catalog image (see the block header above). Nothing is written back to
  // the Ad — the derived stack goes into this render call only. Still exactly
  // one billable submit either way.
  const reseed = reseedDecision({ ad, flagEnabled: isRegenReseedCatalogFirstEnabled() });
  if (!reseed.reseed) {
    console.log(`🔁 regenerate[ad=${adId}]: catalog reseed skipped — ${reseed.reason}`);
  } else {
    const derived = await deriveFirstCatalogMediaId({ productId: ad.productId, brandId: ad.brandId });
    if (!derived) {
      console.log(`🔁 regenerate[ad=${adId}]: catalog reseed skipped — ${RESEED_SKIP.NO_CATALOG_MEDIA}`);
    } else {
      console.log(
        `🔁 regenerate[ad=${adId}]: catalog reseed — stack ${referenceMediaIds.length} ref(s) → ` +
        `1 (${derived.tier} ${derived.mediaId})`
      );
      referenceMediaIds = [derived.mediaId];
      // 'catalog-first', NOT 'catalog-hero': tier 2 resolves by earliest
      // createdAt, so the chosen image often carries no hero stamp at all, and
      // the owner explicitly moved off "hero" as the naming for this rule
      // (2026-08-03) precisely because it implied a label that may be absent.
      referenceSource   = 'catalog-first';
    }
  }

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
  DAILY_CAP,
  // Catalog-first reseed. The decision and the tier selection are pure so
  // scripts/verifyRegeneration.js can assert them with no DB, network or key.
  RESEED_SKIP,
  isRegenReseedCatalogFirstEnabled,
  reseedDecision,
  shouldReseedFromCatalog,
  isCatalogMediaForProduct,
  pickFirstCatalogMediaId
};
