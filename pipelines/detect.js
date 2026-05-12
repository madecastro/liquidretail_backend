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
//     video:  [yolo-video → yolo-identify → subjects-text(hero)]  ‖  [transcribe → ner]
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
const { transcribeAudio } = require('../services/whisperService');
const { extractEntities } = require('../services/nerService');
const { findProductMatches, findPerProductMatches } = require('../services/productMatchService');
const { analyzeOverlayZones } = require('../services/overlayZoneService');
const { computeFocus } = require('../services/imageQualityService');
const { scoreMedia } = require('../services/adSuitabilityService');
const { identifyYoloDetections } = require('../services/yoloIdentifyService');
const { identifyYoloDetectionsGemini, isEnabled: isGeminiIdentifyEnabled } = require('../services/geminiIdentifyService');
const { reconcileEnrichments } = require('../services/enrichmentReconciler');
const { refineDetectionCrops } = require('../services/cropRefineService');
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

  if (media.source === 'catalog-product') {
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
  }

  // ── Phase 1: detect fan-out ──
  await setRunPhase(run, 'detect-fanout');
  const [yoloRes, subjectsRes] = await Promise.allSettled([
    runYoloChain(run, buffer, media, sourceUrl),
    runSubjectsTextChain(run, sourceUrl, media)
  ]);
  if (yoloRes.status === 'rejected') {
    console.warn('⚠️  YOLO chain rejected:', yoloRes.reason?.message);
    run.flags = run.flags || {};
    run.flags.yoloFailed = true;
    run.flags.yoloError  = yoloRes.reason?.message || 'chain rejected';
  }
  if (subjectsRes.status === 'rejected') console.warn('⚠️  Subjects/text chain rejected:', subjectsRes.reason?.message);

  const yoloChainOut = yoloRes.status === 'fulfilled'
    ? yoloRes.value
    : { products: [], refinedProducts: [] };
  const products = yoloChainOut.products;
  const refinedProducts = yoloChainOut.refinedProducts;
  const { subjects, text, background, primarySubjectLabel, secondaryElementsTags } = subjectsRes.status === 'fulfilled'
    ? subjectsRes.value
    : { subjects: [], text: [], background: null, primarySubjectLabel: null, secondaryElementsTags: [] };

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
      return await judgeDetections({ imageUrl: sourceUrl, products, subjects, text, crops, safeRect });
    } catch (err) { console.warn('⚠️  Judge:', err.message); return null; }
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
  media.subjects             = (subjects || []).map(s => ({ ...s }));
  media.text                 = (text     || []).map(t => ({ ...t }));
  media.background           = background || null;
  media.primarySubjectId     = primarySubjectId   || null;
  media.primarySubjectDesc   = primarySubjectDesc || null;
  // Phase A-0 — concise label + tags from subjectTextService extension
  media.primarySubjectLabel  = primarySubjectLabel || null;
  media.secondaryElementsTags = secondaryElementsTags || [];
  media.safeRect             = safeRect || null;
  media.refinedProducts      = (refinedProducts || []).map(rp => ({ ...rp }));
  media.lastDetectedAt       = new Date();
  await media.save();

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
  runExtendedAndOverlayChain(run, media, sourceUrl, null, crops, judge, primarySubjectDesc, background, text, false, { safeRect, imgW, imgH })
    .then(async ({ extendedDoc, overlayDoc }) => {
      await updateMediaLatestArtifacts(media, {
        extended:     extendedDoc?._id,
        overlayZones: overlayDoc?._id
      });
      await applyMediaLibraryDerivations(media, buffer, overlayDoc, productMatches);
      console.log(`🎨 lazy enrichment landed for media ${media._id}`);
    })
    .catch(err => console.warn(`   ⚠️  lazy enrichment failed for media ${media._id}: ${err.message}`));
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
  }

  // ── Phase 1: detect fan-out — YOLO (skip identify) ‖ subjects/text ──
  // We run the same vision passes as UGC media so catalog images carry
  // safe-overlay zones, density + brightness grids, palette, etc. — the
  // ad pipeline can then use catalog images as first-class creative
  // sources. The only stage we skip is the dual-engine product identify
  // (catalog metadata is the source of truth for brand/category/label).
  await setRunPhase(run, 'detect-fanout');
  const [yoloRes, subjectsRes] = await Promise.allSettled([
    runYoloChain(run, buffer, media, sourceUrl, { skipIdentify: true }),
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
  }

  const yoloChainOut = yoloRes.status === 'fulfilled'
    ? yoloRes.value
    : { products: [], refinedProducts: [] };
  const products = yoloChainOut.products;
  const refinedProducts = yoloChainOut.refinedProducts;
  const { subjects, text, background, primarySubjectLabel, secondaryElementsTags } = subjectsRes.status === 'fulfilled'
    ? subjectsRes.value
    : { subjects: [], text: [], background: null, primarySubjectLabel: null, secondaryElementsTags: [] };

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
        return await judgeDetections({ imageUrl: sourceUrl, products, subjects, text, crops, safeRect });
      } catch (err) { console.warn('⚠️  Catalog-path judge:', err.message); return null; }
    });
  }

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  // Promote vision analysis onto Media (denormalized cache of latest run).
  media.subjects              = (subjects || []).map(s => ({ ...s }));
  media.text                  = (text     || []).map(t => ({ ...t }));
  media.background            = background || null;
  media.primarySubjectId      = primarySubjectId   || null;
  media.primarySubjectDesc    = primarySubjectDesc || null;
  media.primarySubjectLabel   = primarySubjectLabel || null;
  media.secondaryElementsTags = secondaryElementsTags || [];
  media.safeRect              = safeRect || null;
  media.refinedProducts       = (refinedProducts || []).map(rp => ({ ...rp }));
  media.lastDetectedAt        = new Date();
  await media.save();

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
      await applyMediaLibraryDerivations(media, buffer, overlayDoc, null);
      console.log(`🎨 catalog-product lazy enrichment landed for media ${media._id}`);
    })
    .catch(err => console.warn(`   ⚠️  catalog-product lazy enrichment failed for media ${media._id}: ${err.message}`));

  console.log(`📦 catalog-product detect (${isHero ? 'hero' : 'alt'}) done — YOLO=${products.length}, refined=${refinedProducts.length}, subjects=${subjects.length}, judge=${judge ? 'yes' : 'skipped'}`);
}

// ──────────────────────────────────────────────────────────────
//  Stage chains — each is a self-contained leaf of the fan-out
//  graph. They share the run object only to record per-sub-stage
//  timings into run.stageTimings; persistence to MongoDB happens
//  at phase boundaries (setRunPhase) so concurrent branches don't
//  race on save().
// ──────────────────────────────────────────────────────────────

async function runYoloChain(run, buffer, media, sourceUrlOverride = null, options = {}) {
  const refineSourceUrl = sourceUrlOverride || media.fileUrl;
  // skipIdentify: catalog-product images already know their SKU from the
  // catalog row. Run YOLO + crop-refine to get tight per-product crops,
  // but skip the dual-engine identify + reconciler (the brand/category
  // would just disagree with the source-of-truth catalog metadata).
  // refineDetectionCrops then treats every detection as a survivor.
  const skipIdentify = !!options.skipIdentify;
  const products = await timeStage(run, 'yolo', async () => {
    try {
      const yolo = await detectMultipleProducts(buffer);
      console.log(`🔍 YOLO: ${yolo.detections.length} product(s)`);
      return yolo.detections;
    } catch (err) {
      // Stamp a non-fatal flag so the rematch endpoint can target
      // these runs specifically — without it, a YOLO timeout looks
      // identical to a legitimately empty image (default centered
      // crops, completed status).
      console.warn('⚠️  YOLO:', err.message);
      run.flags = run.flags || {};
      run.flags.yoloFailed = true;
      run.flags.yoloError  = err.message || 'yolo call failed';
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
      const hints = { brand: media.metadata?.brand, category: media.metadata?.category };
      const tasks = [identifyYoloDetections(products, hints).catch(err => {
        console.warn('⚠️  GPT yolo-identify:', err.message);
        return null;
      })];
      if (isGeminiIdentifyEnabled()) {
        tasks.push(identifyYoloDetectionsGemini(products, hints).catch(err => {
          console.warn('⚠️  Gemini yolo-identify:', err.message);
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
        const refined = await refineDetectionCrops(survivors, refineSourceUrl);
        console.log(`✂️   crop-refine: ${refined.length} refined product(s) from ${survivors.length} surviving detection(s)`);
        return refined;
      } catch (err) {
        console.warn('⚠️  crop-refine:', err.message);
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
    if (!imageUrl) return { subjects: [], text: [], background: null, primarySubjectLabel: null, secondaryElementsTags: [] };
    try {
      const st = await detectSubjectsAndText(imageUrl, {
        brand: media.metadata?.brand,
        category: media.metadata?.category,
        caption: media.metadata?.caption
      });
      return {
        subjects: st.subjects,
        text: st.text,
        background: st.background,
        primarySubjectLabel: st.primarySubjectLabel || null,
        secondaryElementsTags: st.secondaryElementsTags || []
      };
    } catch (err) {
      console.warn('⚠️  Subject/text:', err.message);
      return { subjects: [], text: [], background: null, primarySubjectLabel: null, secondaryElementsTags: [] };
    }
  });
}

async function runTranscribeNerChain(run, buffer, media) {
  let transcript = null;
  let entities = [];
  await timeStage(run, 'transcribe', async () => {
    try {
      transcript = await transcribeAudio(buffer, media.fileName);
      if (transcript) console.log(`🎙️  Transcript: ${transcript.segments.length} segments, ${transcript.duration.toFixed(1)}s`);
    } catch (err) { console.warn('⚠️  Transcription:', err.message); }
  });
  if (transcript) {
    await timeStage(run, 'ner', async () => {
      try {
        entities = await extractEntities(transcript);
        console.log(`🏷️  NER: ${entities.length} entities`);
      } catch (err) { console.warn('⚠️  NER:', err.message); }
    });
  }
  return { transcript, entities };
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
          catalogVisualScore:   m.catalogVisualScore   || null,
          catalogCombinedScore: m.catalogCombinedScore || null,
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
  media.matchedProducts   = matchedProducts;
  media.matchedCategories = matchedCategories;

  // Run-scoped detect summary (Phase 0b — populates Media.classification.detectSummary).
  if (productMatches?.detectSummary) {
    media.classification = media.classification || {};
    media.classification.detectSummary = productMatches.detectSummary;
  }
  try { await media.save(); } catch (err) { console.warn(`   ⚠️  failed to persist Media match denormalization: ${err.message}`); }

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
      matchedAt:               new Date()
    };
    if (!byCatalogProduct.has(cpId)) byCatalogProduct.set(cpId, []);
    byCatalogProduct.get(cpId).push(entry);
  }
  if (!byCatalogProduct.size) return;

  const bulkOps = [];
  for (const [cpId, entries] of byCatalogProduct.entries()) {
    bulkOps.push({
      updateOne: {
        filter: { _id: cpId },
        update: { $pull: { matchedMedia: { mediaId } } }
      }
    });
    bulkOps.push({
      updateOne: {
        filter: { _id: cpId },
        update: { $push: { matchedMedia: { $each: entries } } }
      }
    });
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
          background, isVideo
        });
        extendedCandidates = candidates;
        extendedErrors = errors;
        const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
        console.log(`🖼️   Extended crops${isVideo ? ' (video)' : ''}: ${totalCandidates} candidate(s) across ${Object.keys(extendedCandidates).length} ratios`);
      } catch (err) { console.warn('⚠️  Extended crops:', err.message); }
    });

    const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
    if (totalCandidates > 0) {
      await timeStage(run, 'judge-extended', async () => {
        try {
          extendedJudgeRes = await judgeExtendedCrops({
            candidates: extendedCandidates,
            sourceImageUrl,
            text,
            primarySubject: primarySubjectDesc
          });
        } catch (err) { console.warn('⚠️  Judge extended:', err.message); }
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
          forbiddenRectsPct
        });
      } catch (err) { console.warn('⚠️  Overlay zones:', err.message); }
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
// TODO — video-specific refinements. Currently both the image and video
// pipelines run this stage identically against a single still (hero frame for
// video), which means zones are derived from a single moment in time and can
// collide with the subject later in the clip. In priority order:
//   A. Pass the cross-frame `safeRect` (already computed on video jobs — union
//      of YOLO detections across frames + primary GPT subjects) into the
//      Gemini prompt as an explicit forbidden rect. Eliminates the worst
//      class of failure (overlay ends up under the subject mid-playback).
//   B. Multi-frame analysis. Sample 3 frames (start / middle / end) per
//      ratio, union the forbidden rects, intersect the safe zones.
//   C. Analyze the actually-rendered self-underlay video. Use Cloudinary
//      `so_<sec>` transform to extract N frames from the composed output URL.
async function runOverlayZoneAnalysis({ sourceImageUrl, crops, judge, extendedCrops, forbiddenRectsPct }) {
  const inputs = pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops });
  if (!inputs.length) return {};

  const settled = await Promise.allSettled(inputs.map(i =>
    analyzeOverlayZones({ imageUrl: i.imageUrl, label: i.label, ratio: i.ratio, forbiddenRectsPct })
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
// detect end. Pulls focus from the source-image buffer (when available),
// pulls brightness/density averages from the overlay-zone grids,
// composites the ad-readiness score + bullets via adSuitabilityService,
// and writes everything onto Media.{technicalInsights, adSuitability}.
//
// All sub-steps are best-effort — a missing buffer or missing overlay
// artifact only suppresses the dependent metric, never fails the run.
async function applyMediaLibraryDerivations(media, sourceBuffer, overlayDoc, productMatches) {
  try {
    // 1. Focus — Laplacian variance on the source buffer
    let focus = null;
    if (sourceBuffer) {
      try { focus = await computeFocus(sourceBuffer); }
      catch (err) { console.warn(`   ⚠️  focus derivation failed: ${err.message}`); }
    }

    // 2. Brightness + density averages — from the OverlayZoneArtifact's
    //    primary base-ratio grid (5:4 base if available, else any first
    //    available variant). The grid was already computed during overlay-
    //    zone analysis; we just average its cells.
    const overlayZones = pickPrimaryOverlayZoneAnalysis(overlayDoc);
    const brightnessAvg = averageGrid(overlayZones?.brightnessGrid);
    const densityAvg    = averageGrid(overlayZones?.densityGrid);

    media.technicalInsights = {
      brightnessAvg: brightnessAvg ?? null,
      densityAvg:    densityAvg    ?? null,
      focusScore:    focus?.focusScore ?? null,
      focusBucket:   focus?.focusBucket || null,
      updatedAt:     new Date()
    };

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
    media.adSuitability = {
      score:     suitability.score,
      reasons:   suitability.reasons,
      metrics:   suitability.metrics,
      updatedAt: new Date()
    };

    await media.save();
    const positives = suitability.reasons.filter(r => r.severity === 'positive').length;
    const cautions  = suitability.reasons.filter(r => r.severity === 'caution').length;
    const negatives = suitability.reasons.filter(r => r.severity === 'negative').length;
    console.log(`📊 ad-readiness: ${suitability.score.toFixed(1)}/10 (✓${positives} ⚠${cautions} ✗${negatives})${focus ? ` focus=${focus.focusBucket}` : ''}${brightnessAvg != null ? ` bright=${brightnessAvg.toFixed(2)}` : ''}${densityAvg != null ? ` density=${densityAvg.toFixed(2)}` : ''}`);
  } catch (err) {
    console.warn(`   ⚠️  media-library derivations failed (non-fatal): ${err.message}`);
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
  media.latestArtifacts = {
    detection:    ids.detection    || existing.detection    || null,
    crops:        ids.crops        || existing.crops        || null,
    extended:     ids.extended     || existing.extended     || null,
    match:        ids.match        || existing.match        || null,
    matches:      Array.isArray(ids.matches) && ids.matches.length
                    ? ids.matches
                    : (existing.matches || []),
    overlayZones: ids.overlayZones || existing.overlayZones || null
  };
  await media.save();
}

module.exports = { processDetectRun };
