// Detect pipeline — operates on a DetectRun (Media-keyed). Writes per-stage
// artifacts to dedicated collections so each pipeline stage owns its own
// data. The frontend's status endpoint assembles a unified result on the fly
// (see routes/detect.js).
//
// Lifecycle (run.stage values):
//   queued → detect-fanout → crop-judge → enrich-fanout → finalize → done
//
// Within each phase, sub-stages run as follows. Each sub-stage's duration is
// recorded in run.stageTimings under its own key (e.g. yolo, subjects-text,
// product-match) so the UI's timing panel still shows per-stage breakdowns.
//
//   detect-fanout (Promise.allSettled)
//     image:  [yolo → yolo-identify]  ‖  [subjects-text]
//     video:  [yolo-video (hero-frame) → image pipeline on the hero JPEG]
//              — whisper transcription + NER were removed 2026-08-17;
//              captions are surface-level, the visual hero carries more
//              product signal. services/whisperService.js and
//              services/nerService.js were deleted 2026-08-28 as confirmed
//              dead code (the "retained for standalone use elsewhere" claim
//              above did not hold up — zero callers existed anywhere in the
//              repo).
//
//   crop-judge (sequential — judge depends on YOLO + subjects + crops)
//     smart-crops → judge → CropArtifact persist
//
//   enrich-fanout (Promise.allSettled — independent post-judge work)
//     [extended-crops → judge-extended → overlay-zones → ExtendedCrop+OverlayZone persist]
//     ‖  [product-match → ProductMatchArtifact persist + side-effects]
//
// Each artifact is written immediately after its branch completes so a run
// that fails midway still leaves the partial work persisted.
//
// Errors inside a stage are caught locally and degrade the run gracefully
// (e.g. YOLO failure → products=[], pipeline continues). Promise.allSettled
// at fan-out boundaries means one branch can still succeed if its sibling
// blows up entirely.

const { detectMultipleProducts, detectFromVideo } = require('../services/yoloService');
const { uploadBufferToCloudinary, uploadUrlToCloudinary } = require('../services/cloudinaryService');
const { detectSubjectsAndText } = require('../services/subjectTextService');
const { generateSmartCrops, computeSafeRect } = require('../services/smartCropService');
const { judgeDetections, judgeExtendedCrops } = require('../services/judgeService');
const { generateExtendedCrops } = require('../services/extendedCropsService');
const { findProductMatches, findPerProductMatches } = require('../services/productMatchService');
const { analyzeOverlayZones } = require('../services/overlayZoneService');
const { computeFocus } = require('../services/imageQualityService');
const {
  classifyShotStyle,
  isEnabled: isShotHeuristicEnabled
} = require('../services/imageShotHeuristicService');
const { scoreMedia } = require('../services/adSuitabilityService');
const { identifyYoloDetections } = require('../services/yoloIdentifyService');
const { identifyYoloDetectionsGemini, isEnabled: isGeminiIdentifyEnabled } = require('../services/geminiIdentifyService');
const { reconcileEnrichments } = require('../services/enrichmentReconciler');
const { refineDetectionCrops, dedupYoloDetections } = require('../services/cropRefineService');
const { maybePostMatchReply } = require('../services/instagramCommentService');
// Phase 2b: per-match draft creation now lives in productMatchService.
// catalogProductDraftService is kept only for the manual Upload-7 escape
// hatch (routes/media.js).
// Brand catalog mutations no longer happen inside the detect pipeline
// — Brand creation + enrichment is a user-driven concern triggered by
// POST /api/brand (or PATCH /api/brand/:id). Detect can still
// IDENTIFY a brand name on the Media, but linking that to the
// Advertiser's brand catalog is the picker / members UI's job.

const Media               = require('../models/Media');
const DetectionArtifact   = require('../models/DetectionArtifact');
const CropArtifact        = require('../models/CropArtifact');
const ExtendedCropArtifact = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact  = require('../models/OverlayZoneArtifact');
const CatalogProduct       = require('../models/CatalogProduct');
const Comment              = require('../models/Comment');

const { downloadBuffer } = require('./shared');

// ──────────────────────────────────────────────────────────────
//  Entry point — worker calls this for every queued DetectRun
// ──────────────────────────────────────────────────────────────
async function processDetectRun(run) {
  const media = await Media.findById(run.mediaId);
  if (!media) throw new Error(`Media ${run.mediaId} not found`);
  if (!media.fileUrl) throw new Error(`Media ${run.mediaId} has no fileUrl`);

  const buffer = await downloadBuffer(media.fileUrl, 'file-download');

  run.stageTimings = {};

  // Rescore-only branch: reuse prior DetectionArtifact + CropArtifact
  // and re-run ONLY the match phase against current code. 10× cheaper
  // than a full rerun (no YOLO, no identify, no crops, no subjects/text
  // recompute). Meant for reprocessing historical runs against a
  // matcher-code improvement — e.g. adbadba's reasoner realignment +
  // text-scorer overhaul + semantic tier. Enqueued via
  // match.rescoreOnly capability. Refuses catalog-source Media (they
  // skip matching entirely by design).
  if (run.flags?.rescoreOnly) {
    if (media.source === 'catalog-product') {
      throw new Error('catalog-product media do not run the match chain; rescore-only is not applicable');
    }
    await processRescoreOnly(run, media, buffer);
  } else if (media.source === 'catalog-product') {
    // Catalog images are clean, isolated, single-product. Skip the
    // YOLO/identify/match chain (we already know what the product is)
    // and run a trimmed pipeline focused on building ad-ready crops.
    // Hero gets crops + judge; alts get crops only.
    await runCatalogProductPipeline(run, media, buffer);
  } else if (media.fileType === 'video') {
    await runVideoPipeline(run, media, buffer);
  } else {
    await runImagePipeline(run, media, buffer);
  }

  run.status = 'completed';
  run.stage = 'done';
  run.completedAt = new Date();
  // flags is Mixed — Mongoose won't auto-detect nested mutation,
  // so explicitly mark it modified before save.
  if (run.flags && Object.keys(run.flags).length) run.markModified('flags');
  await run.save();

  const totalMs = Object.values(run.stageTimings || {}).reduce((a, n) => a + n, 0);
  console.log(`🎉 DetectRun ${run._id} completed in ${totalMs}ms`);
}

// ──────────────────────────────────────────────────────────────
//  Image pipeline
//
//  Optional sourceUrlOverride lets the video pipeline reuse this
//  function on a hero-frame JPEG without monkey-patching media.fileUrl.
//  When set, every "analyze the source image" call (Gemini Vision,
//  judge, product match, extended crops) targets the override URL
//  while the Media doc itself keeps its real (.mp4) fileUrl on disk.
// ──────────────────────────────────────────────────────────────
async function runImagePipeline(run, media, buffer, sourceUrlOverride = null) {
  const sourceUrl = sourceUrlOverride || media.fileUrl;

  // Read true image dimensions via sharp BEFORE the YOLO chain so smart
  // crops are always generated in the correct pixel space, even when
  // YOLO returns no products (formerly fell back to 1024×768 — that
  // produced wildly off Cloudinary c_crop URLs against the real asset).
  const sharp = require('sharp');
  let imgW = 1024;
  let imgH = 768;
  try {
    const meta = await sharp(buffer).metadata();
    imgW = meta.width  || imgW;
    imgH = meta.height || imgH;
  } catch (err) {
    console.warn(`   ⚠️  sharp metadata failed for ${media._id}: ${err.message} — using ${imgW}x${imgH}`);
    stampStageFailure(run, 'dims', err);
  }

  // ── Phase 1: detect fan-out ──
  await setRunPhase(run, 'detect-fanout');
  const [yoloRes, subjectsRes] = await Promise.allSettled([
    runYoloChain(run, buffer, media, sourceUrl, { imgW, imgH }),
    runSubjectsTextChain(run, sourceUrl, media)
  ]);
  if (yoloRes.status === 'rejected') {
    console.warn('⚠️  YOLO chain rejected:', yoloRes.reason?.message);
    run.flags = run.flags || {};
    run.flags.yoloFailed = true;
    run.flags.yoloError  = yoloRes.reason?.message || 'chain rejected';
  }
  if (subjectsRes.status === 'rejected') {
    console.warn('⚠️  Subjects/text chain rejected:', subjectsRes.reason?.message);
    stampStageFailure(run, 'subjects', subjectsRes.reason);
  }

  const yoloChainOut = yoloRes.status === 'fulfilled'
    ? yoloRes.value
    : { products: [], refinedProducts: [] };
  const products = yoloChainOut.products;
  const refinedProducts = yoloChainOut.refinedProducts;
  const { subjects, text, background, primarySubjectLabel, secondaryElementsTags,
          contentNature, contentNatureConfidence, contentNatureReason,
          shotType, shotTypeConfidence, shotTypeReason } = subjectsRes.status === 'fulfilled'
    ? subjectsRes.value
    : emptySubjectsText();

  // Persist Media dimensions so consumers can query without loading artifacts.
  media.width  = imgW;
  media.height = imgH;
  await media.save();

  // ── Detection artifact (preliminary — primary subject filled in after judge) ──
  const detectionDoc = await DetectionArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    type: 'image',
    width: imgW, height: imgH,
    imageUrl: sourceUrl,
    yoloProducts: products.map(({ cropBuffer, ...p }) => p),
    refinedProducts,
    subjects, text, background
  });

  // ── Phase 2: crop-judge bridge ──
  await setRunPhase(run, 'crop-judge');

  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);

  const crops = await timeStage(run, 'smart-crops', async () =>
    generateSmartCrops(imgW, imgH, subjects, text, safeRect)
  );

  const judge = await timeStage(run, 'judge', async () => {
    try {
      return await judgeDetections({
        imageUrl: sourceUrl, products, subjects, text, crops, safeRect,
        brandId: run.brandId || media.brandId || null,
        productId: media.metadata?.catalogProductId || null
      });
    } catch (err) {
      console.warn('⚠️  Judge:', err.message);
      stampStageFailure(run, 'judge', err);
      return null;
    }
  });

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  // Backfill the detection artifact with judge-arbitrated primary + safeRect.
  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  // Phase 2c — promote vision analysis onto Media (denormalized cache of
  // the latest run's output). DetectionArtifact stays as the per-run
  // audit record; Media has the LATEST.
  //
  // Written via updateOne rather than media.save() — these fields are
  // array-bearing, which makes Mongoose include __v in the save filter.
  // The partial unique index on DetectRun already guarantees one
  // in-flight run per Media, so optimistic concurrency adds no safety
  // here; on a stale in-memory __v (e.g. when postSyncService's
  // findOneAndUpdate-then-updateOne creation sequence leaves the doc at
  // __v=0 in DB while the in-memory tracker disagrees), save() throws
  // "No matching document found ... version 0". updateOne sidesteps
  // both — last-write-wins is correct for this denorm cache.
  const denorm = {
    subjects:             (subjects || []).map(s => ({ ...s })),
    text:                 (text     || []).map(t => ({ ...t })),
    background:           background || null,
    primarySubjectId:     primarySubjectId   || null,
    primarySubjectDesc:   primarySubjectDesc || null,
    primarySubjectLabel:  primarySubjectLabel || null,
    secondaryElementsTags: secondaryElementsTags || [],
    safeRect:             safeRect || null,
    refinedProducts:      (refinedProducts || []).map(rp => ({ ...rp })),
    lastDetectedAt:       new Date()
  };
  // Content-nature + shot-type classification — written via dot-notation
  // so other classification keys (socialPostType, detectSummary) survive.
  // contentNature filters time-bound UGC out of the seed pool;
  // shotType picks the visual hero for product_image ads.
  const classificationDenorm = {
    'classification.contentNature':           contentNature || 'unknown',
    'classification.contentNatureConfidence': typeof contentNatureConfidence === 'number' ? contentNatureConfidence : 0,
    'classification.contentNatureReason':     contentNatureReason || null,
    'classification.shotType':                shotType || 'unknown',
    'classification.shotTypeConfidence':      typeof shotTypeConfidence === 'number' ? shotTypeConfidence : 0,
    'classification.shotTypeReason':          shotTypeReason || null
  };
  await Media.updateOne({ _id: media._id }, { $set: { ...denorm, ...classificationDenorm } });
  // Keep the in-memory media in sync — subsequent stages (productMatch,
  // applyMediaLibraryDerivations) read these fields directly off the doc.
  Object.assign(media, denorm);
  media.classification = media.classification || {};
  media.classification.contentNature           = contentNature || 'unknown';
  media.classification.contentNatureConfidence = typeof contentNatureConfidence === 'number' ? contentNatureConfidence : 0;
  media.classification.contentNatureReason     = contentNatureReason || null;
  media.classification.shotType                = shotType || 'unknown';
  media.classification.shotTypeConfidence      = typeof shotTypeConfidence === 'number' ? shotTypeConfidence : 0;
  media.classification.shotTypeReason          = shotTypeReason || null;

  const cropDoc = await CropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    smartCrops: crops,
    judge,
    winners: {
      '5:4': judge?.crop_5_4?.winnerId || null,
      '1:1': judge?.crop_1_1?.winnerId || null,
      '4:5': judge?.crop_4_5?.winnerId || null
    }
  });

  // ── Phase 3: product-match (critical path) ──
  // Extended-crops + overlay-zones are NOT on the critical path —
  // they're polish for ad rendering and the renderer can fall back
  // to defaults when missing. Keeping them inline blocks the run for
  // ~15-25s per post (Gemini image gen + overlay-zone analysis fan-
  // out). Defer them to a fire-and-forget lazy chain that backfills
  // Media.latestArtifacts when it lands.
  await setRunPhase(run, 'enrich-fanout');
  const matchRes = await runProductMatchChain(run, media, sourceUrl, products, primarySubjectDesc, text, refinedProducts)
    .catch(err => {
      console.warn('⚠️  Product match chain rejected:', err.message);
      stampStageFailure(run, 'match', err);
      return null;
    });
  const { productMatches, matchDoc, matchDocs } = matchRes || { productMatches: null, matchDoc: null, matchDocs: [] };

  // V3 #3 — auto-comment on the original IG post when this Media came
  // from Instagram and produced a confident product_match with a
  // productUrl. Fire-and-forget; the service guards on brand opt-in,
  // daily cap, and idempotency. Errors are swallowed so detect never
  // fails because of an opportunistic comment.
  if (productMatches && media.source === 'instagram') {
    maybePostMatchReply({ media, productMatch: productMatches })
      .catch(err => console.warn(`   ⚠️  comment-reply async failure: ${err.message}`));
  }

  // ── Finalize critical path ──
  // Phase 2b note: per-match draft CatalogProduct creation now happens
  // inside productMatchService.enrichOneMatchInPlace (ensureCatalog-
  // ProductForMatch). The legacy maybeCreateDraftFromMatch path was
  // creating rows AFTER per-match enrichment, so the FK never propagated
  // back to ProductMatchArtifact / Media.matchedProducts. Removed here;
  // routes/media.js still uses the legacy service for the manual
  // Upload-7 "Save as draft" escape hatch.
  await setRunPhase(run, 'finalize');
  await updateMediaLatestArtifacts(media, {
    detection:    detectionDoc._id,
    crops:        cropDoc._id,
    match:        matchDoc?._id,
    matches:      (matchDocs || []).map(d => d._id)
    // extended + overlayZones land via the lazy chain below.
  });

  // ── Lazy enrichment (off the critical path) ──
  // Fire-and-forget. The DetectRun's status flips to 'completed' as
  // soon as this function returns (caller calls run.save()); these
  // artifacts populate Media.latestArtifacts when they're ready.
  // Failure is logged but non-fatal — extended-crops + overlay-zones
  // are optional polish. applyMediaLibraryDerivations rides along
  // since it consumes overlayDoc.
  //
  // INGEST_EXTENDED_CROPS_ENABLED (2026-09-02, default false). Extended
  // crops (nano-banana-2/edit generation of 9:16 + 1.91:1 variants) fail
  // ~75% of the time on this brand's UGC path because nano-banana rejects
  // those aspect_ratio values ("Request parameters are invalid"). Measured:
  // 486 calls / 366 failures / ~$7 wasted per resync AND the successful
  // 25% add another $3 in real spend — for a pipeline whose output is
  // already covered by the reframe path at ad-gen time (yolo-crop /
  // composite-mask / composite-outpaint from da22486 + ecbea9c handle
  // 9:16 and 16:9; 1.91:1 goes through the same reframe worker).
  //
  // Default off means UGC gets the same treatment catalog-product already
  // had via the hardcoded skipExtendedCrops:true a few sites down. Ops can
  // flip INGEST_EXTENDED_CROPS_ENABLED=true to restore the old speculative
  // pre-compute if the reframe path is regressed for a specific brand and
  // we need the ingest-time cache back.
  const extendedCropsIngestEnabled = String(process.env.INGEST_EXTENDED_CROPS_ENABLED || 'false')
    .toLowerCase().trim() === 'true';
  runExtendedAndOverlayChain(run, media, sourceUrl, null, crops, judge, primarySubjectDesc, background, text, false, { safeRect, imgW, imgH, skipExtendedCrops: !extendedCropsIngestEnabled })
    .then(async ({ extendedDoc, overlayDoc }) => {
      await updateMediaLatestArtifacts(media, {
        extended:     extendedDoc?._id,
        overlayZones: overlayDoc?._id
      });
      await applyMediaLibraryDerivations(media, buffer, overlayDoc, productMatches, run._id);
      console.log(`🎨 lazy enrichment landed for media ${media._id}`);
    })
    .catch(err => {
      console.warn(`   ⚠️  lazy enrichment failed for media ${media._id}: ${err.message}`);
      persistLateStageFailure(run._id, 'lazyEnrichment', err);
    });
}

// ──────────────────────────────────────────────────────────────
//  Video pipeline
// ──────────────────────────────────────────────────────────────
// V3 video path — analyze the hero frame as if it were an image.
//
// We extract the canonical hero frame from the video (existing
// runYoloVideoChain), then hand the JPEG to runImagePipeline so it
// goes through the full subjects/text/judge/product-match/extended
// chain. After the image pipeline returns we patch the resulting
// DetectionArtifact + CropArtifact with video-specific data:
//
//   - DetectionArtifact.type → 'video', videoUrl + frame metadata
//   - CropArtifact.smartCrops[*][*].videoUrl → Cloudinary c_crop URL
//     against the source .mp4, so the UI ribbon plays cropped clips
//
// Cost trade: we pay image-pipeline cost (~\$0.05 + ~25s) per video
// to get product attribution. Whisper/NER stays disabled — captions
// are surface-level, the visual hero carries more product signal.
async function runVideoPipeline(run, media, buffer) {
  const sourceVideoUrl = media.fileUrl;

  // ── Phase 1: pick a hero frame ──
  //
  // Two-source policy, IG-thumbnail-first:
  //
  //   1. IG/Reel cover thumbnail (media.metadata.thumbnailUrl) — present
  //      for every IG video post syncService captures. Cheap (1 Cloudinary
  //      mirror call) and the creator's chosen cover is typically more
  //      product-forward than YOLO's "highest-detection-count" sampling.
  //
  //   2. YOLO video chain (queue-bottlenecked, ~30-60s, ~90% no-hero-frame
  //      failure rate observed) — only for media without a thumbnail
  //      (manual desktop uploads, non-IG sources).
  //
  // Flipping the order from YOLO-first → thumbnail-first save the entire
  // YOLO video round-trip on every IG video, which is a huge chunk of
  // the worker's wall-clock and YOLO's queue depth.
  await setRunPhase(run, 'detect-fanout');
  let heroImageUrl = null;
  let heroFrameSec = null;
  let heroReason   = null;
  let videoDurationSec = null;
  let imgW = 1024;
  let imgH = 768;

  if (media.metadata?.thumbnailUrl) {
    try {
      const mirrored = await uploadUrlToCloudinary(media.metadata.thumbnailUrl, {
        resourceType: 'image',
        folder:       'instagram'
      });
      heroImageUrl = mirrored.secure_url;
      heroFrameSec = 0;
      heroReason   = 'ig-thumbnail';
      console.log(`🪝 IG thumbnail hero for ${media._id} → ${heroImageUrl}`);
    } catch (err) {
      console.warn(`⚠️  IG thumbnail mirror failed for ${media._id}: ${err.message}`);
    }
  }

  // YOLO video fallback — only when there's no thumbnail to use.
  if (!heroImageUrl) {
    let videoOut;
    try {
      videoOut = await runYoloVideoChain(run, buffer, media);
    } catch (err) {
      console.warn('⚠️  YOLO video chain rejected:', err.message);
      videoOut = {
        heroImageUrl: null, heroFrameSec: null, heroReason: 'yolo-rejected',
        videoDurationSec: null, imgW: 1024, imgH: 768
      };
    }
    heroImageUrl     = videoOut.heroImageUrl;
    heroFrameSec     = videoOut.heroFrameSec;
    heroReason       = videoOut.heroReason;
    videoDurationSec = videoOut.videoDurationSec;
    imgW             = videoOut.imgW || imgW;
    imgH             = videoOut.imgH || imgH;
  }

  if (videoDurationSec) media.durationSec = videoDurationSec;

  if (!heroImageUrl) {
    console.warn(`⚠️  Video ${media._id} produced no hero frame — minimal artifacts only`);
    media.lastDetectedAt = new Date();
    await media.save();
    const detectionDoc = await DetectionArtifact.create({
      mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
      type: 'video', width: imgW, height: imgH,
      imageUrl: null, videoUrl: sourceVideoUrl,
      heroFrameSec: null, heroReason: heroReason || 'no-hero-frame', videoDurationSec,
      yoloProducts: [], refinedProducts: [], subjects: [], text: [], background: null, transcript: null,
      safeRect: null, primarySubjectId: null, primarySubjectDesc: null
    });
    await setRunPhase(run, 'finalize');
    await updateMediaLatestArtifacts(media, { detection: detectionDoc._id });
    return;
  }

  // ── Phase 2: download hero JPEG and run the full image pipeline ──
  const heroBuffer = await downloadBuffer(heroImageUrl, 'video-hero-download');
  await runImagePipeline(run, media, heroBuffer, heroImageUrl);

  // ── Phase 3: augment artifacts with video-specific data ──
  // The image pipeline persisted DetectionArtifact.type = 'image' and
  // didn't know about the .mp4. Patch both the detection record and
  // the crop record so consumers can play cropped clips and the UI
  // can tell this came from a video.
  await DetectionArtifact.updateOne(
    { mediaId: media._id, runId: run._id },
    { $set: {
        type:             'video',
        videoUrl:         sourceVideoUrl,
        heroFrameSec,
        heroReason,
        videoDurationSec
    }}
  );

  // The image pipeline's CropArtifact has coordinate-only smartCrops.
  // Decorate each candidate with a Cloudinary c_crop video URL so the
  // ribbon's cropped-clip playback works (mirrors the image-pipeline
  // crops which carry imageUrl-only — frontend builds video URLs on
  // the fly via buildCloudinaryVideoCropUrl from format.ts).
  const cropDoc = await CropArtifact.findOne({ mediaId: media._id, runId: run._id });
  if (cropDoc?.smartCrops) {
    for (const ratio of Object.keys(cropDoc.smartCrops)) {
      const list = cropDoc.smartCrops[ratio];
      if (!Array.isArray(list)) continue;
      for (const cand of list) {
        cand.videoUrl = buildCloudinaryCropUrl(sourceVideoUrl, cand);
      }
    }
    cropDoc.markModified('smartCrops');
    await cropDoc.save();
  }
}

// ──────────────────────────────────────────────────────────────
//  Catalog-product pipeline (the product path)
//
//  Trimmed pipeline for clean, isolated catalog images. Skips
//  YOLO/identify/match/reasoner/safety (we already know the product)
//  and focuses on producing ad-ready crops + a color palette.
//
//  Hero (metadata.imageRole === 'hero') — full trim:
//      smart-crops → judge → CropArtifact persist
//  Alt  (metadata.imageRole === 'alt')  — stripped:
//      smart-crops → CropArtifact persist (no judge, no winners)
//
//  Cost per hero ≈ $0.010 (judge); per alt ≈ $0.
//  Time per hero ≈ 3-5s; per alt ≈ 1-2s.
// ──────────────────────────────────────────────────────────────
async function runCatalogProductPipeline(run, media, buffer) {
  const sourceUrl = media.fileUrl;
  const isHero = media.metadata?.imageRole !== 'alt';

  // True image dimensions via sharp BEFORE the fan-out so smart crops
  // are always generated against the asset's actual pixel space.
  // Catalog images often have YOLO produce zero detections (clean
  // studio shots), and falling back to 1024x1024 made downstream
  // c_crop URLs land on the wrong region.
  const sharp = require('sharp');
  let imgW = 1024;
  let imgH = 1024;
  try {
    const meta = await sharp(buffer).metadata();
    imgW = meta.width  || imgW;
    imgH = meta.height || imgH;
  } catch (err) {
    console.warn(`   ⚠️  sharp metadata failed for catalog ${media._id}: ${err.message} — using ${imgW}x${imgH}`);
    stampStageFailure(run, 'dims', err);
  }

  // ── Phase 1: detect fan-out — YOLO (skip identify) ‖ subjects/text ──
  // We run the same vision passes as UGC media so catalog images carry
  // safe-overlay zones, density + brightness grids, palette, etc. — the
  // ad pipeline can then use catalog images as first-class creative
  // sources. The only stage we skip is the dual-engine product identify
  // (catalog metadata is the source of truth for brand/category/label).
  await setRunPhase(run, 'detect-fanout');
  const [yoloRes, subjectsRes] = await Promise.allSettled([
    runYoloChain(run, buffer, media, sourceUrl, { skipIdentify: true, imgW, imgH }),
    runSubjectsTextChain(run, sourceUrl, media)
  ]);
  if (yoloRes.status === 'rejected') {
    console.warn('⚠️  Catalog YOLO chain rejected:', yoloRes.reason?.message);
    run.flags = run.flags || {};
    run.flags.yoloFailed = true;
    run.flags.yoloError  = yoloRes.reason?.message || 'chain rejected';
  }
  if (subjectsRes.status === 'rejected') {
    console.warn('⚠️  Catalog subjects/text chain rejected:', subjectsRes.reason?.message);
    stampStageFailure(run, 'subjects', subjectsRes.reason);
  }

  const yoloChainOut = yoloRes.status === 'fulfilled'
    ? yoloRes.value
    : { products: [], refinedProducts: [] };
  const products = yoloChainOut.products;
  const refinedProducts = yoloChainOut.refinedProducts;
  const { subjects, text, background, primarySubjectLabel, secondaryElementsTags,
          contentNature, contentNatureConfidence, contentNatureReason,
          shotType, shotTypeConfidence, shotTypeReason } = subjectsRes.status === 'fulfilled'
    ? subjectsRes.value
    : emptySubjectsText();

  media.width  = imgW;
  media.height = imgH;
  await media.save();

  const detectionDoc = await DetectionArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    type: 'image',
    width: imgW, height: imgH,
    imageUrl: sourceUrl,
    yoloProducts: products.map(({ cropBuffer, ...p }) => p),
    refinedProducts,
    subjects, text, background
  });

  // ── Phase 2: crop-judge (sequential — judge depends on YOLO + subjects + crops) ──
  await setRunPhase(run, 'crop-judge');

  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Catalog safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);

  const crops = await timeStage(run, 'smart-crops', async () =>
    generateSmartCrops(imgW, imgH, subjects, text, safeRect)
  );

  // Judge only on hero — alts share the same SKU and don't need their
  // own per-ratio winner picks (matching uses the YOLO refined crops,
  // not the judged framings).
  let judge = null;
  if (isHero) {
    judge = await timeStage(run, 'judge', async () => {
      try {
        return await judgeDetections({
          imageUrl: sourceUrl, products, subjects, text, crops, safeRect,
          brandId: run.brandId || media.brandId || null,
          productId: media.metadata?.catalogProductId || null
        });
      } catch (err) {
        console.warn('⚠️  Catalog-path judge:', err.message);
        stampStageFailure(run, 'judge', err);
        return null;
      }
    });
  }

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  // Promote vision analysis onto Media (denormalized cache of latest run).
  // updateOne, not save() — see runImagePipeline for the rationale
  // (array-bearing save() trips Mongoose's __v check on a fresh Media
  // doc whose in-memory version is stale relative to DB).
  const denormCp = {
    subjects:              (subjects || []).map(s => ({ ...s })),
    text:                  (text     || []).map(t => ({ ...t })),
    background:            background || null,
    primarySubjectId:      primarySubjectId   || null,
    primarySubjectDesc:    primarySubjectDesc || null,
    primarySubjectLabel:   primarySubjectLabel || null,
    secondaryElementsTags: secondaryElementsTags || [],
    safeRect:              safeRect || null,
    refinedProducts:       (refinedProducts || []).map(rp => ({ ...rp })),
    lastDetectedAt:        new Date()
  };
  const classificationDenormCp = {
    'classification.contentNature':           contentNature || 'unknown',
    'classification.contentNatureConfidence': typeof contentNatureConfidence === 'number' ? contentNatureConfidence : 0,
    'classification.contentNatureReason':     contentNatureReason || null,
    'classification.shotType':                shotType || 'unknown',
    'classification.shotTypeConfidence':      typeof shotTypeConfidence === 'number' ? shotTypeConfidence : 0,
    'classification.shotTypeReason':          shotTypeReason || null
  };
  await Media.updateOne({ _id: media._id }, { $set: { ...denormCp, ...classificationDenormCp } });
  Object.assign(media, denormCp);
  media.classification = media.classification || {};
  media.classification.contentNature           = contentNature || 'unknown';
  media.classification.contentNatureConfidence = typeof contentNatureConfidence === 'number' ? contentNatureConfidence : 0;
  media.classification.contentNatureReason     = contentNatureReason || null;
  media.classification.shotType                = shotType || 'unknown';
  media.classification.shotTypeConfidence      = typeof shotTypeConfidence === 'number' ? shotTypeConfidence : 0;
  media.classification.shotTypeReason          = shotTypeReason || null;

  const cropDoc = await CropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    smartCrops: crops,
    judge,
    winners: {
      '5:4': judge?.crop_5_4?.winnerId || null,
      '1:1': judge?.crop_1_1?.winnerId || null,
      '4:5': judge?.crop_4_5?.winnerId || null
    }
  });

  // ── Finalize critical path — no match phase for catalog products ──
  await setRunPhase(run, 'finalize');
  await updateMediaLatestArtifacts(media, {
    detection: detectionDoc._id,
    crops:     cropDoc._id
    // extended + overlayZones land via the lazy chain below.
  });

  // ── Lazy enrichment — overlay-zones only (extended-crops skipped) ──
  // Overlay zones power brightness-grid + safe-zone restrictions on
  // catalog product images so overlay-mode templates render properly.
  // Extended-crops (gpt-image-1 / Gemini Imagen variant generation) is
  // skipped — catalog hero shots are clean and isolated; AI extension
  // costs $0.10-0.30 per Media without meaningful quality lift over
  // Cloudinary c_crop on a centered product.
  runExtendedAndOverlayChain(run, media, sourceUrl, null, crops, judge, primarySubjectDesc, background, text, false, { safeRect, imgW, imgH, skipExtendedCrops: true })
    .then(async ({ extendedDoc, overlayDoc }) => {
      await updateMediaLatestArtifacts(media, {
        extended:     extendedDoc?._id,
        overlayZones: overlayDoc?._id
      });
      await applyMediaLibraryDerivations(media, buffer, overlayDoc, null, run._id);
      console.log(`🎨 catalog-product lazy enrichment landed for media ${media._id}`);
    })
    .catch(err => {
      console.warn(`   ⚠️  catalog-product lazy enrichment failed for media ${media._id}: ${err.message}`);
      persistLateStageFailure(run._id, 'lazyEnrichment', err);
    });

  // E1 — back-link Media.matchedProducts to the catalog product this
  // wrapper Media represents. Catalog-source runs skip the match phase
  // entirely (SKU is source-of-truth), which used to leave
  // Media.matchedProducts empty on 100% of catalog Media even though
  // metadata.catalogProductId was populated. Consumers reading
  // matchedProducts (Media Library, alt seed paths) went blind on the
  // brand's own catalog rows. Restores the Media-keyed schema invariant.
  const cpId = media.metadata?.catalogProductId;
  if (cpId) {
    try {
      // Idempotent: remove any prior detect-derived entry for this
      // same catalog product, then insert the fresh one. Operator
      // entries (source:'operator') are preserved by the source filter.
      await Media.updateOne(
        { _id: media._id },
        { $pull: { matchedProducts: { source: 'detect', catalogProductId: cpId } } }
      );
      await Media.updateOne(
        { _id: media._id },
        { $push: { matchedProducts: {
            catalogProductId: cpId,
            matchKind:        'catalog',
            outcome:          'product_match',
            confidence:       1.0,
            source:           'detect'
        } } }
      );
    } catch (err) {
      console.warn(`   ⚠️  catalog-product back-link failed for media ${media._id}: ${err.message}`);
    }
  }

  console.log(`📦 catalog-product detect (${isHero ? 'hero' : 'alt'}) done — YOLO=${products.length}, refined=${refinedProducts.length}, subjects=${subjects.length}, judge=${judge ? 'yes' : 'skipped'}`);
}

// ──────────────────────────────────────────────────────────────
//  Stage chains — each is a self-contained leaf of the fan-out
//  graph. They share the run object only to record per-sub-stage
//  timings into run.stageTimings; persistence to MongoDB happens
//  at phase boundaries (setRunPhase) so concurrent branches don't
//  race on save().
// ──────────────────────────────────────────────────────────────

// Env knobs for A3 (downscale) — YOLO_DOWNSCALE_ENABLED gates the resize;
// YOLO_MAX_INPUT_WIDTH is the ceiling. Default 1600 keeps catalog product
// plates (typically 1999×2372) safely inside the axios 120s client
// timeout — measured p90 dropped from 136s to well below the limit when
// tile count halved from 12→6. Off by default for UGC where fine-detail
// recall (small logos, spec labels) matters; catalog callers opt in via
// options.downscale.
const YOLO_DOWNSCALE_ENABLED = process.env.YOLO_DOWNSCALE_ENABLED !== 'false';
const YOLO_MAX_INPUT_WIDTH   = Math.max(512, parseInt(process.env.YOLO_MAX_INPUT_WIDTH, 10) || 1600);

// Best-effort downscale before YOLO submit. Returns the same buffer on
// any failure — never blocks the pipeline over a resize issue.
async function maybeDownscaleForYolo(buffer, imgW) {
  if (!YOLO_DOWNSCALE_ENABLED) return { buffer, resized: false };
  if (!imgW || imgW <= YOLO_MAX_INPUT_WIDTH) return { buffer, resized: false };
  try {
    const sharp = require('sharp');
    const resized = await sharp(buffer)
      .resize({ width: YOLO_MAX_INPUT_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { buffer: resized, resized: true, fromWidth: imgW, toWidth: YOLO_MAX_INPUT_WIDTH };
  } catch (err) {
    console.warn(`   ⚠️  YOLO downscale failed (${err.message}) — sending original buffer`);
    return { buffer, resized: false };
  }
}

// ──────────────────────────────────────────────────────────────
//  Rescore-only path — reuse prior DetectionArtifact + CropArtifact
//  and re-run ONLY the match phase against current code.
//
//  Purpose: reprocess historical runs against a matcher-code
//  improvement without paying for YOLO / identify / crops again.
//  Cost: ~$0.005 per run (Gemini vision candidate scoring only) vs
//  ~$0.05 for a full rerun. ~5-10s wall clock vs 30-60s.
//
//  Data flow:
//    1. Load the latest OTHER completed DetectRun for this Media
//    2. Load its DetectionArtifact + CropArtifact
//    3. Reuse refinedProducts / subjects / text / primarySubjectDesc
//    4. Persist a fresh DetectionArtifact + CropArtifact tied to the
//       current run._id (mirrors of the prior; keeps referential
//       integrity for Media.latestArtifacts)
//    5. Run only runProductMatchChain
//    6. Update Media.latestArtifacts.match/matches to point at fresh docs
//
//  Refuses when no prior completed run exists — the caller (executor)
//  is expected to check first.
// ──────────────────────────────────────────────────────────────
async function processRescoreOnly(run, media, buffer) {
  await setRunPhase(run, 'detect-fanout');

  // Look up the most recent OTHER completed run for this Media.
  const priorRun = await require('../models/DetectRun').findOne({
    mediaId: media._id,
    status:  'completed',
    _id:     { $ne: run._id }
  }).sort({ createdAt: -1 }).lean();
  if (!priorRun) {
    throw new Error('no prior completed DetectRun to rescore from — run a full detect.rematch first');
  }
  const priorDet  = await DetectionArtifact.findOne({ runId: priorRun._id }).lean();
  if (!priorDet) {
    throw new Error(`prior run ${priorRun._id} has no DetectionArtifact — full rerun required`);
  }
  const priorCrop = await CropArtifact.findOne({ runId: priorRun._id }).lean();

  console.log(`♻️  rescore-only: reusing DetectionArtifact from prior run ${priorRun._id}`);

  // Mirror the prior detection into a fresh doc for run._id. Keeps
  // Media.latestArtifacts pointer-consistent when the new run is
  // eventually the "latest" by createdAt.
  const detectionDoc = await DetectionArtifact.create({
    mediaId:            media._id,
    runId:              run._id,
    advertiserId:       media.advertiserId,
    brandId:            media.brandId,
    type:               priorDet.type || 'image',
    width:              priorDet.width,
    height:             priorDet.height,
    imageUrl:           priorDet.imageUrl,
    yoloProducts:       priorDet.yoloProducts       || [],
    refinedProducts:    priorDet.refinedProducts    || [],
    subjects:           priorDet.subjects           || [],
    text:               priorDet.text               || [],
    background:         priorDet.background         || null,
    primarySubjectId:   priorDet.primarySubjectId   || null,
    primarySubjectDesc: priorDet.primarySubjectDesc || null,
    safeRect:           priorDet.safeRect           || null
  });
  const cropDoc = priorCrop
    ? await CropArtifact.create({
        mediaId:      media._id,
        runId:        run._id,
        advertiserId: media.advertiserId,
        brandId:      media.brandId,
        smartCrops:   priorCrop.smartCrops || {},
        judge:        priorCrop.judge || {},
        winners:      priorCrop.winners || {}
      })
    : null;

  // Copy the prior YOLO downscale flag so the yoloDownscaled telemetry
  // stays consistent across the rescored run's history.
  if (priorRun.flags?.yoloDownscaled) {
    run.flags = run.flags || {};
    run.flags.yoloDownscaled = priorRun.flags.yoloDownscaled;
  }

  await setRunPhase(run, 'enrich-fanout');
  const products         = priorDet.yoloProducts       || [];
  const refinedProducts  = priorDet.refinedProducts    || [];
  const primarySubjectDesc = priorDet.primarySubjectDesc || null;
  const text             = priorDet.text || [];
  const sourceImageUrl   = priorDet.imageUrl || media.fileUrl;

  const matchRes = await runProductMatchChain(run, media, sourceImageUrl, products, primarySubjectDesc, text, refinedProducts);

  await setRunPhase(run, 'finalize');
  await updateMediaLatestArtifacts(media, {
    detection: detectionDoc._id,
    crops:     cropDoc?._id || null,
    match:     matchRes?.matchDoc?._id || null,
    matches:   (matchRes?.matchDocs || []).map(d => d._id)
    // extended + overlayZones untouched — the prior run's copies stay
    // valid; no need to overwrite them from a rescore.
  });

  console.log(`♻️  rescore-only complete for media ${media._id} — reused prior detect, wrote ${(matchRes?.matchDocs || []).length} fresh ProductMatchArtifact(s)`);
}

async function runYoloChain(run, buffer, media, sourceUrlOverride = null, options = {}) {
  const refineSourceUrl = sourceUrlOverride || media.fileUrl;
  // skipIdentify: catalog-product images already know their SKU from the
  // catalog row. Run YOLO + crop-refine to get tight per-product crops,
  // but skip the dual-engine identify + reconciler (the brand/category
  // would just disagree with the source-of-truth catalog metadata).
  // refineDetectionCrops then treats every detection as a survivor.
  const skipIdentify = !!options.skipIdentify;
  // imgW/imgH passed in from the outer pipeline (computed via sharp
  // BEFORE this chain runs). Used by A3 downscale + A4 fallback bbox.
  const imgW = options.imgW || null;
  const imgH = options.imgH || null;
  const products = await timeStage(run, 'yolo', async () => {
    try {
      const { buffer: yoloBuffer, resized, fromWidth, toWidth } = await maybeDownscaleForYolo(buffer, imgW);
      if (resized) {
        console.log(`   · YOLO downscale: ${fromWidth}px → ${toWidth}px (A3)`);
        run.flags = run.flags || {};
        run.flags.yoloDownscaled = { from: fromWidth, to: toWidth };
      }
      const yolo = await detectMultipleProducts(yoloBuffer);
      console.log(`🔍 YOLO: ${yolo.detections.length} product(s)`);
      // Bbox-dedup before identify so the dual-engine call only runs
      // on distinct objects. YOLO sometimes returns two overlapping
      // detections for the same physical thing; running identify on
      // both wastes a full GPT + Gemini round-trip per duplicate, and
      // the redundancy is only caught later in dedupRefinedProducts.
      const deduped = dedupYoloDetections(yolo.detections);
      const dropped = yolo.detections.length - deduped.length;
      if (dropped > 0) {
        console.log(`   · YOLO bbox-dedup: collapsed ${dropped} overlapping detection(s) (${deduped.length} kept)`);
      }
      // A3 rescale: coords returned by YOLO are relative to the (possibly
      // downscaled) buffer we sent. Rescale bboxes back to the source
      // image's pixel space so crop-refine, safeRect, smart-crops, and
      // catalog-side crop URLs all land on the right region.
      if (resized && fromWidth && toWidth && fromWidth !== toWidth) {
        const scale = fromWidth / toWidth;
        for (const d of deduped) {
          d.x1 = Math.round((d.x1 || 0) * scale);
          d.y1 = Math.round((d.y1 || 0) * scale);
          d.x2 = Math.round((d.x2 || 0) * scale);
          d.y2 = Math.round((d.y2 || 0) * scale);
          d.imgWidth  = imgW || d.imgWidth;
          d.imgHeight = imgH || d.imgHeight;
        }
      }
      return deduped;
    } catch (err) {
      // Stamp a non-fatal flag so the rematch endpoint can target
      // these runs specifically — without it, a YOLO timeout looks
      // identical to a legitimately empty image (default centered
      // crops, completed status).
      console.warn('⚠️  YOLO:', err.message);
      run.flags = run.flags || {};
      run.flags.yoloFailed = true;
      run.flags.yoloError  = err.message || 'yolo call failed';
      if (err.yoloKind) run.flags.yoloErrorKind = err.yoloKind;
      // A4 — YOLO fallback bbox. Return one synthesized "full-image"
      // detection so downstream identify + match still fires; recovers
      // brand-level attribution on the 23% of runs that previously
      // produced ZERO ProductMatchArtifacts (measured 2026-08-13).
      //
      // Fires when:
      //   1. imgW/imgH are known (from the outer pipeline via options)
      //   2. AND either the source is an image, OR a video-hero-frame
      //      pass (media.fileType='video' but the video pipeline handed
      //      us a hero JPEG via sourceUrlOverride, so `buffer` IS an
      //      image). Broadened 2026-08-17 — previously only images,
      //      which meant a YOLO timeout on a video hero still produced
      //      zero refined products and zero downstream matches.
      // Skipped on raw video buffers where a full-image bbox is
      // meaningless (buffer is the .mp4, not a still).
      const isHeroFrameOfVideo = media.fileType === 'video' && !!sourceUrlOverride;
      if (imgW && imgH && (media.fileType === 'image' || isHeroFrameOfVideo)) {
        run.flags.yoloFallbackSynth = true;
        return [{
          id:           'p1',
          cropBuffer:   buffer,           // full source; refine will re-crop
          confidence:   0.1,
          x1:           0,
          y1:           0,
          x2:           imgW,
          y2:           imgH,
          className:    'object',
          imgWidth:     imgW,
          imgHeight:    imgH,
          firstSeenSec: null,
          _synthesized: true
        }];
      }
      return [];
    }
  });

  if (products.length && !skipIdentify) {
    // Phase 1.5c — dual-engine enrichment. GPT-4.1 and Gemini Vision run in
    // parallel on the same crops; reconciler merges per-detection products[]
    // into engines.reconciled.products[] and updates the legacy
    // det.identification alias. Gemini failures are non-fatal (GPT carries
    // the run with single-engine penalty applied during reconciliation).
    await timeStage(run, 'yolo-identify', async () => {
      const hints = {
        brand: media.metadata?.brand,
        category: media.metadata?.category,
        brandId: run.brandId || media.brandId || null,
        productId: media.metadata?.catalogProductId || null
      };
      const tasks = [identifyYoloDetections(products, hints).catch(err => {
        console.warn('⚠️  GPT yolo-identify:', err.message);
        stampStageFailure(run, 'identifyGpt', err);
        return null;
      })];
      if (isGeminiIdentifyEnabled()) {
        tasks.push(identifyYoloDetectionsGemini(products, hints).catch(err => {
          console.warn('⚠️  Gemini yolo-identify:', err.message);
          stampStageFailure(run, 'identifyGemini', err);
          return null;
        }));
      } else {
        // Mark every detection as having no Gemini engine so reconciler
        // applies the single-engine penalty to GPT-only outputs.
        products.forEach(p => { p.engines = p.engines || {}; p.engines.gemini = null; });
      }
      await Promise.all(tasks);
      reconcileEnrichments(products);
      const summary = products.reduce((acc, d) => {
        const r = d.engines?.reconciled?.products || [];
        acc.totalProducts    += r.length;
        acc.agreed           += r.filter(p => p.agreement === 'agree').length;
        acc.categoryConfirmed += r.filter(p => p.agreement === 'category-confirmed').length;
        acc.gptOnly          += r.filter(p => p.agreement === 'gpt-only').length;
        acc.geminiOnly       += r.filter(p => p.agreement === 'gemini-only').length;
        return acc;
      }, { totalProducts: 0, agreed: 0, categoryConfirmed: 0, gptOnly: 0, geminiOnly: 0 });
      console.log(
        `🏷️   YOLO identify (dual-engine): ${products.length} crop(s) → ` +
        `${summary.totalProducts} reconciled product(s) ` +
        `[${summary.agreed} agreed, ${summary.categoryConfirmed} category-confirmed, ` +
        `${summary.gptOnly} gpt-only, ${summary.geminiOnly} gemini-only]`
      );
    });
  }

  // Phase 1.6 — bbox refinement on real-product survivors. Image-only for
  // v1; video falls back to yoloIdentifications in Phase 1.7 (the
  // microservice samples detections across frames so there's no single
  // source URL to crop against the bboxes).
  // When skipIdentify is on (catalog-product path), there is no
  // identification.label to gate on — treat every detection as a survivor
  // since YOLO crops of catalog images are presumed to BE the product.
  let refinedProducts = [];
  const survivors = skipIdentify
    ? products.slice()
    : products.filter(p =>
        p.identification?.label && p.identification.label !== 'non-product'
      );
  // Allow refinement to run for video media too — when called from
  // runVideoPipeline, sourceUrlOverride is the hero-frame JPEG URL,
  // so refineDetectionCrops can do its image-side work normally.
  const canRefine = !!refineSourceUrl && (media.fileType === 'image' || sourceUrlOverride);
  if (survivors.length && canRefine) {
    refinedProducts = await timeStage(run, 'crop-refine', async () => {
      try {
        const refined = await refineDetectionCrops(survivors, refineSourceUrl, {
          brandId: run.brandId || media.brandId || null,
          productId: media.metadata?.catalogProductId || null
        });
        console.log(`✂️   crop-refine: ${refined.length} refined product(s) from ${survivors.length} surviving detection(s)`);
        return refined;
      } catch (err) {
        console.warn('⚠️  crop-refine:', err.message);
        stampStageFailure(run, 'refine', err);
        return [];
      }
    });
  }

  return { products, refinedProducts };
}

async function runYoloVideoChain(run, buffer, media) {
  return await timeStage(run, 'yolo-video', async () => {
    try {
      const yolo = await detectFromVideo(buffer, media.fileName);
      let heroImageUrl = null;
      if (yolo.heroFrameBase64) {
        const heroBuf = Buffer.from(yolo.heroFrameBase64, 'base64');
        const up = await uploadBufferToCloudinary(heroBuf, { resourceType: 'image' });
        heroImageUrl = up.secure_url;
        console.log(`🖼️  Hero frame @ ${yolo.heroFrameSec}s (${yolo.heroReason}): ${heroImageUrl}`);
      }
      console.log(`🔍 YOLO (video): ${yolo.detections.length} product(s)`);
      return {
        products:         yolo.detections,
        imgW:             yolo.width  || 1024,
        imgH:             yolo.height || 768,
        heroFrameSec:     yolo.heroFrameSec,
        heroReason:       yolo.heroReason,
        videoDurationSec: yolo.videoDurationSec,
        heroImageUrl
      };
    } catch (err) {
      console.warn('⚠️  YOLO video:', err.message);
      // Same non-fatal flag the image path uses — when YOLO video
      // crashes, the run lands at minimal artifacts and the rematch
      // endpoint should be able to find it.
      run.flags = run.flags || {};
      run.flags.yoloFailed = true;
      run.flags.yoloError  = err.message || 'yolo-video call failed';
      return {
        products: [], imgW: 1024, imgH: 768, heroImageUrl: null,
        heroFrameSec: null, heroReason: null, videoDurationSec: null
      };
    }
  });
}

async function runSubjectsTextChain(run, imageUrl, media) {
  return await timeStage(run, 'subjects-text', async () => {
    if (!imageUrl) return emptySubjectsText();
    try {
      const st = await detectSubjectsAndText(imageUrl, {
        brand: media.metadata?.brand,
        category: media.metadata?.category,
        caption: media.metadata?.caption,
        brandId: run.brandId || media.brandId || null,
        productId: media.metadata?.catalogProductId || null
      });
      return {
        subjects: st.subjects,
        text: st.text,
        background: st.background,
        primarySubjectLabel: st.primarySubjectLabel || null,
        secondaryElementsTags: st.secondaryElementsTags || [],
        contentNature:           st.contentNature           || 'unknown',
        contentNatureConfidence: typeof st.contentNatureConfidence === 'number' ? st.contentNatureConfidence : 0.5,
        contentNatureReason:     st.contentNatureReason     || null,
        shotType:                st.shotType                || 'unknown',
        shotTypeConfidence:      typeof st.shotTypeConfidence === 'number' ? st.shotTypeConfidence : 0.5,
        shotTypeReason:          st.shotTypeReason          || null
      };
    } catch (err) {
      console.warn('⚠️  Subject/text:', err.message);
      stampStageFailure(run, 'subjects', err);
      return emptySubjectsText();
    }
  });
}

function emptySubjectsText() {
  return {
    subjects: [], text: [], background: null,
    primarySubjectLabel: null, secondaryElementsTags: [],
    contentNature: 'unknown', contentNatureConfidence: 0, contentNatureReason: null,
    shotType: 'unknown', shotTypeConfidence: 0, shotTypeReason: null
  };
}

async function runProductMatchChain(run, media, sourceImageUrl, products, primarySubjectDesc, text, refinedProducts = []) {
  const productMatches = await timeStage(run, 'product-match', async () => {
    try {
      // Inbound comments — fed into brand-safety eval inside
      // productMatchService alongside caption + OCR text. The Comment
      // collection is populated on demand by mediaInsightsService
      // (operator hits Refresh on the Media detail tab); when nothing
      // is stored yet, brand-safety silently degrades to caption +
      // OCR only — same behavior as before this wiring landed.
      const commentRows = await Comment.find({ mediaId: media._id })
        .select('text')
        .limit(500)
        .lean()
        .catch(() => []);
      const commentTexts = commentRows.map(c => c.text).filter(Boolean);

      // Phase 1.7 — per-product orchestrator. Uses refinedProducts (Phase 1.6
      // output) for catalog-first matching when available; falls back to
      // single scene-level match when refinedProducts is empty.
      const result = await findPerProductMatches({
        brand:          media.metadata?.brand,
        brandUrl:       media.metadata?.brandUrl,
        advertiserId:   media.advertiserId || null,
        brandId:        media.brandId || null,
        mediaId:        media._id,                // Phase 2a/2b — for Category.firstSeenMediaId + catalog detectedFromMediaId
        category:       media.metadata?.category,
        caption:        media.metadata?.caption,
        primarySubject: primarySubjectDesc,
        textDetected:   (text || []).map(t => t.content).filter(Boolean),
        comments:       commentTexts,
        imageUrl:       sourceImageUrl,
        yoloIdentifications: products,
        refinedProducts
      });
      const matchCount = (result.matches || []).length;
      console.log(`🔗 Product match: ${matchCount} per-product match(es) | scene-level totalMatches=${result.totalMatches} across ${Object.keys(result.providers || {}).length} provider(s)${result.matchSource ? ` (primary source=${result.matchSource})` : ''}`);
      return result;
    } catch (err) {
      console.warn('⚠️  Product match:', err.message);
      stampStageFailure(run, 'match', err);
      return null;
    }
  });

  // Phase 1.7 — write ONE ProductMatchArtifact per match in result.matches.
  // The legacy single-doc path (no refinedProducts) results in matches[1]
  // and a single artifact written, so existing readers see the same shape.
  const matchDocs = [];
  if (productMatches?.matches?.length) {
    for (const m of productMatches.matches) {
      try {
        // Phase 2e — strip identification.details. Commerce fields (rating,
        // reviews, sellers, specs, price, url, imageUrl, description) now
        // live on the linked CatalogProduct row and are read via
        // productMatchHydration. Identification keeps its evidence fields
        // (productName, brand, certainty, reasoning, primaryUrl, etc.).
        const ident = m.identification ? stripDetailsFromIdentification(m.identification) : null;
        const doc = await ProductMatchArtifact.create({
          mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
          productIndex:         m.productIndex || null,
          query:                m.query || productMatches.query,
          providers:            m.providers || {},
          errors:               m.errors    || {},
          totalMatches:         productMatches.totalMatches || 0,
          identification:       ident,
          outcome:              m.outcome || null,
          outcomeReasoning:     m.outcomeReasoning || null,
          winner:               m.winner || null,
          matchSource:          m.matchSource || null,
          catalogProductId:     m.catalogProductId || null,
          catalogMatch:         m.catalogMatch || null,
          // ?? not || so a real 0 (Gemini returned isMatch:false) isn't
          // conflated with null (visual never called). 2026-08-19.
          catalogVisualScore:   m.catalogVisualScore   ?? null,
          catalogCombinedScore: m.catalogCombinedScore ?? null,
          categoryId:           m.categoryId || null,          // Phase 2a — FK to Category leaf
          enrichmentTiers:      m.enrichmentTiers || [],      // Phase 1.7b
          recommendedProducts:  m.recommendedProducts || []   // Phase 1.7b
        });
        matchDocs.push(doc);
      } catch (err) {
        console.warn(`   ⚠️  ProductMatchArtifact.create failed for ${m.productIndex || 'primary'}: ${err.message}`);
      }
    }
  }

  // Primary match doc — for backward-compat Media.latestArtifacts.match (singular).
  // Picks the highest-confidence catalog winner if any, else the first match.
  const primaryDoc = pickPrimaryDoc(matchDocs, productMatches?.matches || []);

  // Phase 2d — denormalized match arrays on Media. Source of truth stays
  // ProductMatchArtifact (per-run audit); these are the LATEST current
  // state for fast reads ("what does this Media match right now?").
  // Cleared and rewritten each detect run.
  const matchedProducts   = [];
  const matchedCategories = [];
  const matches    = productMatches?.matches    || [];
  matches.forEach((m, i) => {
    const artifactId = matchDocs[i]?._id || null;
    if (m.outcome === 'product_match' || m.outcome === 'product_category') {
      const matchKind = m.winner === 'catalog'
                          ? 'catalog'
                          : (m.catalogProductId ? 'detect-identified' : 'inferred-no-row');
      matchedProducts.push({
        refinedProductId:        m.productIndex || null,
        catalogProductId:        m.catalogProductId || null,
        matchKind,
        outcome:                 m.outcome,
        confidence:              m.catalogCombinedScore ?? m.identification?.certainty ?? 0,
        matchEvidenceArtifactId: artifactId
      });
    }
    if (m.categoryId) {
      matchedCategories.push({
        categoryId:              m.categoryId,
        refinedProductId:        m.productIndex || null,
        confidence:              m.catalogCombinedScore ?? m.identification?.certainty ?? 0,
        matchEvidenceArtifactId: artifactId
      });
    }
  });
  // Stamp source='detect' on every entry so operator-added entries
  // (source='operator') can be distinguished + preserved on re-run.
  // Load-bearing — see the Media schema comment + verifier §34.
  for (const mp of matchedProducts)   mp.source = 'detect';
  for (const mc of matchedCategories) mc.source = 'detect';
  media.matchedProducts   = matchedProducts;
  media.matchedCategories = matchedCategories;

  // Run-scoped detect summary (Phase 0b — populates Media.classification.detectSummary).
  if (productMatches?.detectSummary) {
    media.classification = media.classification || {};
    media.classification.detectSummary = productMatches.detectSummary;
  }
  // Update pattern (2026-08-10, UGC-ads Phase 1): $pull existing
  // detect entries → $push fresh ones. Operator entries survive
  // because $pull filters on source:'detect'. Prior code was
  // $set: matchedProducts (wholesale overwrite) — that would wipe
  // every operator attachment on every detect re-run. If a future
  // refactor goes back to $set, the verifier's UGC-attachment
  // regression guard fires.
  try {
    // Two-step: pull all detect entries, then push the new set.
    // Can't merge into one updateOne — $pull and $push on the same
    // path in the same command are ambiguous and Mongo rejects.
    await Media.updateOne(
      { _id: media._id },
      { $pull: {
          matchedProducts:   { source: 'detect' },
          matchedCategories: { source: 'detect' }
      } }
    );
    await Media.updateOne(
      { _id: media._id },
      {
        $push: {
          matchedProducts:   { $each: matchedProducts },
          matchedCategories: { $each: matchedCategories }
        },
        ...(productMatches?.detectSummary
            ? { $set: { 'classification.detectSummary': productMatches.detectSummary } }
            : {})
      }
    );
  } catch (err) {
    console.warn(`   ⚠️  failed to persist Media match denormalization: ${err.message}`);
  }

  // Bidirectional denormalization — mirror matchedProducts onto each
  // CatalogProduct.matchedMedia so seedsFromProduct can iterate without
  // querying ProductMatchArtifact. Re-runs replace prior entries for
  // this Media (pull-then-push pattern) so the array doesn't accumulate
  // duplicates across DetectRuns.
  await mirrorMatchesToCatalogProducts(media._id, matchedProducts);

  return { productMatches, matchDoc: primaryDoc, matchDocs };
}

// Group matchedProducts by catalogProductId and bulkWrite a
// pull-current-then-push-new sweep per product. Idempotent: re-running
// detect for the same Media replaces the prior entries rather than
// accumulating duplicates.
async function mirrorMatchesToCatalogProducts(mediaId, matchedProducts) {
  const byCatalogProduct = new Map();
  for (const mp of matchedProducts) {
    if (!mp.catalogProductId) continue;
    const cpId = String(mp.catalogProductId);
    const tier = mp.outcome === 'product_match' ? 'product_match' : 'product_category';
    const entry = {
      mediaId,
      matchTier:               tier,
      confidence:              mp.confidence,
      refinedProductId:        mp.refinedProductId,
      matchEvidenceArtifactId: mp.matchEvidenceArtifactId,
      matchedAt:               new Date(),
      source:                  'detect'   // required — must not $pull operator entries
    };
    if (!byCatalogProduct.has(cpId)) byCatalogProduct.set(cpId, []);
    byCatalogProduct.get(cpId).push(entry);
  }
  if (!byCatalogProduct.size) return;

  // Inheritance fan-out: matches always resolve to the variant family's
  // PRIMARY (productMatchService filters to primaries only). To make
  // operator picks of non-primary SKUs (e.g. the 12-pack of an oil)
  // surface the same UGC, mirror the matchedMedia entries to every
  // variant in the same family. variantsByPrimary[cpId] = ids of all
  // non-primary CatalogProducts pointing at this primary.
  const primaryIds = [...byCatalogProduct.keys()];
  const variants = await CatalogProduct.find({
    primaryProductId: { $in: primaryIds }
  }).select('_id primaryProductId').lean();
  const variantsByPrimary = new Map();
  for (const v of variants) {
    const key = String(v.primaryProductId);
    if (!variantsByPrimary.has(key)) variantsByPrimary.set(key, []);
    variantsByPrimary.get(key).push(v._id);
  }

  const bulkOps = [];
  for (const [cpId, entries] of byCatalogProduct.entries()) {
    // Targets = primary itself + its variants. Each gets the same
    // pull+push so re-runs replace rather than duplicate the entry.
    const targetIds = [cpId, ...(variantsByPrimary.get(String(cpId)) || []).map(String)];
    for (const targetId of targetIds) {
      // Only $pull DETECT entries for this media — operator-added
      // matchedMedia entries survive detect re-runs. Load-bearing
      // for the UGC-ads Phase 1 attachment preservation invariant.
      bulkOps.push({
        updateOne: {
          filter: { _id: targetId },
          update: { $pull: { matchedMedia: { mediaId, source: 'detect' } } }
        }
      });
      bulkOps.push({
        updateOne: {
          filter: { _id: targetId },
          update: { $push: { matchedMedia: { $each: entries } } }
        }
      });
    }
  }
  try {
    await CatalogProduct.bulkWrite(bulkOps, { ordered: true });
  } catch (err) {
    console.warn(`   ⚠️  failed to mirror matches to CatalogProduct.matchedMedia: ${err.message}`);
  }
}

function pickPrimaryDoc(docs, matches) {
  if (!docs.length) return null;
  // Match each doc back to its source match record by productIndex
  const byIndex = new Map();
  matches.forEach(m => byIndex.set(m.productIndex || null, m));
  // Catalog winner ranks first, then by combined catalog score, then by certainty
  return docs.slice().sort((a, b) => {
    const ma = byIndex.get(a.productIndex || null) || {};
    const mb = byIndex.get(b.productIndex || null) || {};
    const aCat = ma.winner === 'catalog' ? 1 : 0;
    const bCat = mb.winner === 'catalog' ? 1 : 0;
    if (aCat !== bCat) return bCat - aCat;
    const aScore = ma.catalogCombinedScore ?? ma.identification?.certainty ?? 0;
    const bScore = mb.catalogCombinedScore ?? mb.identification?.certainty ?? 0;
    return bScore - aScore;
  })[0];
}

async function runExtendedAndOverlayChain(run, media, sourceImageUrl, sourceVideoUrl, crops, judge, primarySubjectDesc, background, text, isVideo, ctx = {}) {
  let extendedCandidates = {}, extendedErrors = {}, extendedJudgeRes = {};

  // ctx.skipExtendedCrops bypasses the gpt-image-1 / Gemini Imagen
  // generation entirely. Catalog product images are clean isolated
  // studio shots — AI extension to 9:16 / 1.91:1 wastes $0.10-0.30
  // per Media without meaningful quality lift over plain Cloudinary
  // c_crop. Overlay-zones (brightness grid + restrictions) still
  // runs because it's cheap (~$0.01) and powers the overlay-mode
  // contrast guards.
  const skipExtended = !!ctx.skipExtendedCrops;

  if (sourceImageUrl && !skipExtended) {
    await timeStage(run, 'extended-crops', async () => {
      try {
        const { candidates, errors } = await generateExtendedCrops({
          sourceImageUrl, sourceVideoUrl,
          smartCrops: crops, judge, primarySubject: primarySubjectDesc,
          background, isVideo,
          brandId: run.brandId || media.brandId || null,
          productId: media.metadata?.catalogProductId || null
        });
        extendedCandidates = candidates;
        extendedErrors = errors;
        const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
        console.log(`🖼️   Extended crops${isVideo ? ' (video)' : ''}: ${totalCandidates} candidate(s) across ${Object.keys(extendedCandidates).length} ratios`);
      } catch (err) {
        console.warn('⚠️  Extended crops:', err.message);
        stampStageFailure(run, 'extended', err);
        // Lazy path — run.save has already fired, so mirror onto the persisted doc.
        persistLateStageFailure(run._id, 'extended', err);
      }
    });

    const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
    if (totalCandidates > 0) {
      await timeStage(run, 'judge-extended', async () => {
        try {
          extendedJudgeRes = await judgeExtendedCrops({
            candidates: extendedCandidates,
            sourceImageUrl,
            text,
            primarySubject: primarySubjectDesc,
            brandId: run.brandId || media.brandId || null,
            productId: media.metadata?.catalogProductId || null
          });
        } catch (err) {
          console.warn('⚠️  Judge extended:', err.message);
          stampStageFailure(run, 'judgeExtended', err);
          persistLateStageFailure(run._id, 'judgeExtended', err);
        }
      });
    }
  }

  const extendedDoc = await ExtendedCropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    candidates: extendedCandidates,
    errors: extendedErrors,
    judge: extendedJudgeRes,
    selectedWinners: deriveSelectedWinners(extendedCandidates, extendedJudgeRes)
  });

  // For video media, derive forbidden rects (in 0..1 fractions) from
  // the cross-frame safeRect (already unioned across YOLO firstSeenSec
  // bounds + primary subjects + text) plus platform UI bands for Reels.
  // Single-still overlay analysis would otherwise miss subjects that
  // appear briefly mid-clip and IG's caption / action overlays that
  // aren't in the source frame at all.
  const forbiddenRectsPct = isVideo
    ? buildVideoForbiddenRects({ safeRect: ctx.safeRect, imgW: ctx.imgW, imgH: ctx.imgH, postType: media.metadata?.postType })
    : null;

  let overlayZones = {};
  if (sourceImageUrl) {
    await timeStage(run, 'overlay-zones', async () => {
      try {
        overlayZones = await runOverlayZoneAnalysis({
          sourceImageUrl, crops, judge, extendedCrops: extendedCandidates,
          forbiddenRectsPct,
          brandId: run.brandId || media.brandId || null,
          productId: media.metadata?.catalogProductId || null
        });
      } catch (err) {
        console.warn('⚠️  Overlay zones:', err.message);
        stampStageFailure(run, 'overlay', err);
        persistLateStageFailure(run._id, 'overlay', err);
      }
    });
  }

  const overlayDoc = await OverlayZoneArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    zones: overlayZones
  });

  return { extendedDoc, overlayDoc };
}

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

// Phase boundary — writes run.stage and persists. Called at each fan-out /
// bridge transition; sub-stage timings within a phase don't trigger saves
// so concurrent branches can't race on Mongoose's serialization.
async function setRunPhase(run, phase) {
  run.stage = phase;
  await run.save();
  console.log(`   ⇒ phase: ${phase}`);
}

// Stamp a non-fatal stage failure onto run.flags so it's queryable
// post-hoc via detect.listFailedRuns / DetectRun.flags.<name>Failed
// without needing to grep logs. Same idiom as yoloFailed. `name`
// should be short + camelCase and match the enum in the
// detect.listFailedRuns capability: judge, judgeExtended, refine,
// match, subjects, identifyGpt, identifyGemini, extended, overlay,
// derivations, lazyEnrichment, dims, denorm, mirror.
//
// Silent in-catch failures used to leave zero trace on the DetectRun,
// so a run where (say) Judge Gemini call 500'd would land at
// status:completed with no flag and no error — invisible to any
// post-hoc analysis that isn't tailing the live log. Measured
// 2026-08-17: 100% of non-YOLO catch blocks were unflagged.
function stampStageFailure(run, name, err) {
  if (!run || !name) return;
  run.flags = run.flags || {};
  run.flags[`${name}Failed`] = true;
  const msg = err?.message || String(err || 'unknown');
  run.flags[`${name}Error`] = msg.slice(0, 200);
}

// Companion for LAZY paths that fire AFTER run.status='completed' has
// already been persisted — extended-crops + overlay-zones + media
// library derivations. run.save() has already fired, so mutating
// run.flags in-memory doesn't reach Mongo. Direct updateOne writes
// the flag onto the persisted doc. Best-effort — a failure here is
// itself non-fatal.
async function persistLateStageFailure(runId, name, err) {
  if (!runId || !name) return;
  try {
    const DetectRun = require('../models/DetectRun');
    const msg = err?.message || String(err || 'unknown');
    await DetectRun.updateOne(
      { _id: runId },
      { $set: {
          [`flags.${name}Failed`]: true,
          [`flags.${name}Error`]:  msg.slice(0, 200)
      } }
    );
  } catch (e) {
    console.warn(`   ⚠️  persistLateStageFailure(${name}): ${e.message}`);
  }
}

// Sub-stage timing wrapper. Records elapsed ms in run.stageTimings under
// `name`, even when the inner fn throws (try/finally). Multiple stages
// within the same phase can run concurrently and each safely accumulates
// its own duration — Node's single-threaded event loop ensures the
// in-memory mutations are atomic; persistence happens on the next
// setRunPhase() save.
async function timeStage(run, name, fn) {
  const t0 = Date.now();
  console.log(`   → ${name}`);
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - t0;
    run.stageTimings = run.stageTimings || {};
    run.stageTimings[name] = (run.stageTimings[name] || 0) + elapsed;
    run.markModified('stageTimings');
  }
}

// Cloudinary video-transform URL: crop every frame to a given rect.
// Convert the cross-frame safeRect (pixel coords, union of YOLO
// first-seen bounds + subjects + text across the clip) into 0..1
// fractions for the Gemini overlay-zone prompt, plus stamp Reels-
// specific platform UI bands (caption strip, share/save column,
// audio/profile header) that aren't visible in the hero still but
// will sit on top of the rendered creative at runtime. The result is
// fed in as hard rules so the layout generator never places overlays
// where the subject moves OR where IG's chrome will obscure them.
function buildVideoForbiddenRects({ safeRect, imgW, imgH, postType }) {
  const rects = [];

  if (safeRect && imgW > 0 && imgH > 0) {
    rects.push({
      x1:     safeRect.x1 / imgW,
      y1:     safeRect.y1 / imgH,
      x2:     safeRect.x2 / imgW,
      y2:     safeRect.y2 / imgH,
      reason: 'cross-frame subject motion (union of YOLO + subjects + text across the video)'
    });
  }

  // Reels carry a fixed UI overlay across all playback surfaces.
  // Approximate bands (validated against IG mobile screenshots — exact
  // pixels vary by device but these envelopes cover all of them):
  //   top    ~6%   profile / audio chip
  //   right  ~12%  like/comment/share/save column (last ~70% of height)
  //   bottom ~22%  username + caption + sound credits
  if (postType === 'REEL') {
    rects.push({ x1: 0,    y1: 0,    x2: 1,    y2: 0.06, reason: 'Reels top UI (profile / audio)' });
    rects.push({ x1: 0,    y1: 0.78, x2: 1,    y2: 1,    reason: 'Reels bottom UI (caption / sound credit)' });
    rects.push({ x1: 0.88, y1: 0.30, x2: 1,    y2: 0.95, reason: 'Reels right action column (like / comment / share / save)' });
  }

  return rects.length > 0 ? rects : null;
}

function buildCloudinaryCropUrl(videoUrl, crop) {
  if (!videoUrl || !videoUrl.includes('/upload/')) return null;
  const w = Math.max(1, crop.x2 - crop.x1);
  const h = Math.max(1, crop.y2 - crop.y1);
  const transform = `c_crop,w_${w},h_${h},x_${crop.x1},y_${crop.y1}`;
  if (/\/v\d+\//.test(videoUrl)) {
    return videoUrl.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  }
  return videoUrl.replace('/upload/', `/upload/${transform}/`);
}

// Layout-preprocessing stage. Picks the input images (base-ratio judge winners
// + both Gemini-extended candidates per extended ratio) and asks Gemini Vision
// for overlay zones per image, in parallel.
//
// Output shape (schemaVersion 3.0) — per-ratio ARRAY of variant entries so
// adding a new provider is purely additive and consumers can iterate without
// knowing variant-key names ahead of time:
//   {
//     '<ratio>': [
//       { provider, variant, candidateId, imageUrl, analysis }  // ...or null analysis on per-image failure
//     ]
//   }
//
// Video handling: this stage still analyzes a single still (hero frame),
// but callers now pass a `forbiddenRectsPct` array via runExtendedAndOverlayChain
// → buildVideoForbiddenRects. That array carries the cross-frame safeRect
// (union of YOLO first-seen bounds + subjects + text across the clip)
// plus Reels-specific platform-UI bands (top ~6% audio chip, bottom ~22%
// caption strip, right ~12% action column). Gemini gets them as hard rules
// via the prompt, so the worst class of failure (overlay ends up under the
// subject mid-playback OR under IG chrome at runtime) is closed by
// construction. See buildVideoForbiddenRects for the exact envelopes.
//
// Still open:
//   - Multi-frame analysis. Sample 3 frames (start / middle / end) per
//     ratio, union the forbidden rects, intersect the safe zones. ~3×
//     Gemini calls per video; cost/benefit unmeasured.
//   - Analyze the actually-rendered self-underlay video. Use Cloudinary
//     `so_<sec>` transform to extract N frames from the composed output
//     URL. Cheap, but serializes compose→analyze which is currently parallel.
async function runOverlayZoneAnalysis({ sourceImageUrl, crops, judge, extendedCrops, forbiddenRectsPct, brandId = null, productId = null, adId = null, campaignRunId = null }) {
  const inputs = pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops });
  if (!inputs.length) return {};

  const settled = await Promise.allSettled(inputs.map(i =>
    analyzeOverlayZones({ imageUrl: i.imageUrl, label: i.label, ratio: i.ratio, forbiddenRectsPct, brandId, productId, adId, campaignRunId })
  ));

  const artifact = {};
  inputs.forEach((input, idx) => {
    const analysis = settled[idx].status === 'fulfilled' ? settled[idx].value : null;
    artifact[input.ratio] = artifact[input.ratio] || [];
    artifact[input.ratio].push({
      provider:    input.provider,
      variant:     input.variant,
      candidateId: input.candidateId,
      imageUrl:    input.imageUrl,
      analysis
    });
  });

  const ok = Object.values(artifact).flat().filter(e => e.analysis).length;
  console.log(`🎯 Overlay zones: ${ok}/${inputs.length} analyses complete`);
  return artifact;
}

function pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops }) {
  const inputs = [];
  if (!sourceImageUrl) return inputs;

  const baseRatios = [
    { ratio: '5:4', judgeKey: 'crop_5_4' },
    { ratio: '1:1', judgeKey: 'crop_1_1' },
    { ratio: '4:5', judgeKey: 'crop_4_5' }
  ];
  for (const { ratio, judgeKey } of baseRatios) {
    const winnerId = judge?.[judgeKey]?.winnerId;
    const list = crops?.[ratio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0];
    if (!winner) continue;
    const imageUrl = buildCloudinaryCropUrl(sourceImageUrl, winner);
    if (!imageUrl) continue;
    inputs.push({
      ratio, provider: null, variant: 'base', candidateId: winner.id, imageUrl,
      label: `${ratio} base`
    });
  }

  for (const ratio of ['9:16', '1.91:1']) {
    const list = extendedCrops?.[ratio] || [];
    for (const variant of ['extension', 'generation']) {
      const cand = list.find(c => c.provider === 'gemini' && c.variant === variant);
      if (!cand?.imageUrl) continue;
      inputs.push({
        ratio, provider: 'gemini', variant, candidateId: cand.id, imageUrl: cand.imageUrl,
        label: `${ratio} gem-${variant}`
      });
    }
  }
  return inputs;
}

// Primary-subject resolution. Judge.subjects.primaryId is preferred (the
// judge sees YOLO + GPT subjects together and can break ties). Fall back to
// GPT's role-based selection.
function resolvePrimarySubjectId(subjects, judge) {
  const judgeId = judge?.subjects?.primaryId;
  if (judgeId && subjects?.find(s => s.id === judgeId)) return judgeId;
  return subjects?.find(s => s.role === 'primary')?.id || null;
}
function resolvePrimarySubjectDesc(subjects, judge) {
  if (!subjects?.length) return null;
  const id = resolvePrimarySubjectId(subjects, judge);
  return subjects.find(s => s.id === id)?.description || null;
}

// Phase A-0 — finalize-stage Media Library derivations. Cheap, runs at
// detect end. Pulls focus + packshot/lifestyle heuristic from the source-
// image buffer (when available), pulls brightness/density averages from
// the overlay-zone grids, composites the ad-readiness score + bullets
// via adSuitabilityService, and writes everything onto
// Media.{technicalInsights, adSuitability}. The shot-style heuristic
// never writes classification.shotType (LLM owns that field).
//
// All sub-steps are best-effort — a missing buffer, missing overlay
// artifact, or heuristic failure only suppresses the dependent metric,
// never fails the run.
async function applyMediaLibraryDerivations(media, sourceBuffer, overlayDoc, productMatches, runId = null) {
  try {
    // 1. Focus — Laplacian variance on the source buffer
    let focus = null;
    if (sourceBuffer) {
      try { focus = await computeFocus(sourceBuffer); }
      catch (err) { console.warn(`   ⚠️  focus derivation failed: ${err.message}`); }
    }

    // 1b. Packshot/lifestyle heuristic — zero-cost sharp only.
    //     Independent of classification.shotType (LLM). Best-effort: a null
    //     or throw never fails the DetectRun (mirrors computeFocus).
    //
    //     Skip recompute when materializeImage already copied an ingest-time
    //     style onto technicalInsights (CatalogProduct.imageShotStyles →
    //     Media). Detect remains the fallback for anything ingest missed.
    let shotStyle = null;
    const carried = media?.technicalInsights?.shotStyle;
    if (carried === 'packshot' || carried === 'lifestyle' || carried === 'ambiguous') {
      shotStyle = {
        style: carried,
        confidence: media.technicalInsights.shotStyleConfidence ?? null,
        metrics: media.technicalInsights.shotStyleMetrics ?? null
      };
    } else if (sourceBuffer && isShotHeuristicEnabled()) {
      try { shotStyle = await classifyShotStyle(sourceBuffer); }
      catch (err) { console.warn(`   ⚠️  shot-style heuristic failed: ${err.message}`); }
    }

    // 2. Brightness + density averages — from the OverlayZoneArtifact's
    //    primary base-ratio grid (5:4 base if available, else any first
    //    available variant). The grid was already computed during overlay-
    //    zone analysis; we just average its cells.
    const overlayZones = pickPrimaryOverlayZoneAnalysis(overlayDoc);
    const brightnessAvg = averageGrid(overlayZones?.brightnessGrid);
    const densityAvg    = averageGrid(overlayZones?.densityGrid);

    const technicalInsights = {
      brightnessAvg:        brightnessAvg ?? null,
      densityAvg:           densityAvg    ?? null,
      focusScore:           focus?.focusScore ?? null,
      focusBucket:          focus?.focusBucket || null,
      // Dot-notation-ready fields under technicalInsights — declared on
      // Media schema. Do NOT write classification.shotType here.
      shotStyle:            shotStyle?.style ?? null,
      shotStyleConfidence:  shotStyle?.confidence ?? null,
      shotStyleMetrics:     shotStyle?.metrics ?? null,
      updatedAt:            new Date()
    };
    media.technicalInsights = technicalInsights;

    // 3. Ad readiness — composite score + reason bullets
    const detectSummaryOutcome = media.classification?.detectSummary?.outcome || null;
    const primarySubjectRectPct = subjectRectPctFromOverlay(overlayZones)
                               || subjectRectPctFromMedia(media);
    const suitability = scoreMedia({
      refinedProducts: media.refinedProducts || [],
      overlayZones,
      focus,
      text: media.text || [],
      detectSummaryOutcome,
      primarySubjectRectPct
    });
    const adSuitability = {
      score:     suitability.score,
      reasons:   suitability.reasons,
      metrics:   suitability.metrics,
      updatedAt: new Date()
    };
    media.adSuitability = adSuitability;

    // updateOne, not save() — same rationale as the denorm + match
    // writes earlier in the pipeline. Save() would re-flush stale
    // dirty fields with a stale __v.
    await Media.updateOne(
      { _id: media._id },
      { $set: { technicalInsights, adSuitability } }
    );
    const positives = suitability.reasons.filter(r => r.severity === 'positive').length;
    const cautions  = suitability.reasons.filter(r => r.severity === 'caution').length;
    const negatives = suitability.reasons.filter(r => r.severity === 'negative').length;
    console.log(`📊 ad-readiness: ${suitability.score.toFixed(1)}/10 (✓${positives} ⚠${cautions} ✗${negatives})${focus ? ` focus=${focus.focusBucket}` : ''}${brightnessAvg != null ? ` bright=${brightnessAvg.toFixed(2)}` : ''}${densityAvg != null ? ` density=${densityAvg.toFixed(2)}` : ''}`);
  } catch (err) {
    console.warn(`   ⚠️  media-library derivations failed (non-fatal): ${err.message}`);
    if (runId) persistLateStageFailure(runId, 'derivations', err);
  }
}

// Pick the canonical overlay-zone analysis to use for technical insights.
// OverlayZoneArtifact stores a per-ratio map; the 5:4 base variant is the
// most representative of the source frame, falling back to whatever ran.
function pickPrimaryOverlayZoneAnalysis(overlayDoc) {
  if (!overlayDoc?.zones) return null;
  const zones = overlayDoc.zones;
  // Prefer base ratios (5:4, 1:1, 4:5) over extension/generation crops
  for (const ratio of ['5:4', '1:1', '4:5']) {
    const variants = zones[ratio];
    if (Array.isArray(variants)) {
      const baseVariant = variants.find(v => v?.variant === 'base' && v?.analysis) || variants.find(v => v?.analysis);
      if (baseVariant?.analysis) return baseVariant.analysis;
    }
  }
  // Fallback — any ratio with an analysis
  for (const ratio of Object.keys(zones)) {
    const variants = zones[ratio];
    if (Array.isArray(variants)) {
      const v = variants.find(x => x?.analysis);
      if (v?.analysis) return v.analysis;
    }
  }
  return null;
}

function averageGrid(grid) {
  if (!grid?.cells?.length) return null;
  const flat = grid.cells.flat();
  if (!flat.length) return null;
  return flat.reduce((s, v) => s + (Number(v) || 0), 0) / flat.length;
}

// Try to source a primary-subject rectPct from the overlay-zone analysis
// first (already-derived hard-rule product rect), fall back to deriving
// from the Media.subjects[] primary entry.
function subjectRectPctFromOverlay(overlayZones) {
  return overlayZones?.primarySubjectRectPct || null;
}

function subjectRectPctFromMedia(media) {
  const primaryId = media.primarySubjectId;
  const ps = (media.subjects || []).find(s => s?.id === primaryId)
          || (media.subjects || []).find(s => s?.role === 'primary');
  if (!ps) return null;
  return { x1: ps.x1, y1: ps.y1, x2: ps.x2, y2: ps.y2 };
}

// Phase 2e — drop identification.details before persisting the artifact.
// Commerce fields (rating, reviews, sellers, specs, price, url, imageUrl,
// description) now live on the linked CatalogProduct; productMatchHydration
// reattaches them at read time.
function stripDetailsFromIdentification(ident) {
  if (!ident || typeof ident !== 'object') return ident;
  const { details, ...rest } = ident;
  return rest;
}

// For each extended ratio, surface the judge's pick on the artifact for
// downstream consumers that don't want to re-derive it from the scores map.
function deriveSelectedWinners(candidates, judge) {
  const out = {};
  for (const ratio of Object.keys(candidates || {})) {
    const judgeWinner = judge?.[ratio]?.winnerId || null;
    if (judgeWinner) {
      out[ratio] = { candidateId: judgeWinner, source: 'judge' };
    }
  }
  return out;
}

// Update Media.latestArtifacts to point at the freshest artifacts. Skip slots
// where the run produced nothing (preserve any existing pointer from a prior
// successful run rather than clearing it).
//
// Phase 1.7 — `match` (singular) is the primary match (highest combined
// catalog score, catalog winners outrank). `matches[]` is the full list
// of per-product matches. Existing readers that only know about `match`
// see the primary; multi-product readers can iterate `matches[]`.
async function updateMediaLatestArtifacts(media, ids) {
  const existing = media.latestArtifacts || {};
  const latestArtifacts = {
    detection:    ids.detection    || existing.detection    || null,
    crops:        ids.crops        || existing.crops        || null,
    extended:     ids.extended     || existing.extended     || null,
    match:        ids.match        || existing.match        || null,
    matches:      Array.isArray(ids.matches) && ids.matches.length
                    ? ids.matches
                    : (existing.matches || []),
    overlayZones: ids.overlayZones || existing.overlayZones || null
  };
  media.latestArtifacts = latestArtifacts;
  // updateOne, not save() — earlier pipeline phases populated
  // subjects/text/refinedProducts/etc. via Object.assign after
  // their own updateOne writes; those fields remain flagged in
  // Mongoose's dirty tracker on this in-memory doc, so save()
  // would try to flush them too with a stale __v and trip
  // "No matching document found ... version 0".
  await Media.updateOne({ _id: media._id }, { $set: { latestArtifacts } });
}

module.exports = {
  processDetectRun,
  // Exported for offline harnesses (verifyIngestShotClassify H3/H4) that
  // must exercise the carried-style branch for real — not re-implement it.
  applyMediaLibraryDerivations
};
