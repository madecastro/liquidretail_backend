// Detect pipeline — operates on a DetectRun (Media-keyed). Writes per-stage
// artifacts to dedicated collections so each pipeline stage owns its own
// data. The frontend's status endpoint assembles a unified result on the fly
// (see routes/detect.js).
//
// Stage order is identical for image + video; video adds yolo-video,
// transcribe, ner, and a few different inputs.
//
//   yolo  →  yolo-identify  →  (transcribe → ner)?  →  subjects-text  →
//   smart-crops  →  judge  →  extended-crops  →  judge-extended  →
//   product-match  →  overlay-zones
//
// Each artifact is written immediately after its stage cluster completes so a
// run that fails midway still leaves the partial work persisted.

const { detectMultipleProducts, detectFromVideo } = require('../services/yoloService');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { detectSubjectsAndText } = require('../services/subjectTextService');
const { generateSmartCrops, computeSafeRect } = require('../services/smartCropService');
const { judgeDetections, judgeExtendedCrops } = require('../services/judgeService');
const { generateExtendedCrops } = require('../services/extendedCropsService');
const { transcribeAudio } = require('../services/whisperService');
const { extractEntities } = require('../services/nerService');
const { findProductMatches } = require('../services/productMatchService');
const { analyzeOverlayZones } = require('../services/overlayZoneService');
const { identifyYoloDetections } = require('../services/yoloIdentifyService');
const { maybePostMatchReply } = require('../services/instagramCommentService');
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

const { downloadBuffer } = require('./shared');

// ──────────────────────────────────────────────────────────────
//  Entry point — worker calls this for every queued DetectRun
// ──────────────────────────────────────────────────────────────
async function processDetectRun(run) {
  const media = await Media.findById(run.mediaId);
  if (!media) throw new Error(`Media ${run.mediaId} not found`);
  if (!media.fileUrl) throw new Error(`Media ${run.mediaId} has no fileUrl`);

  const buffer = await downloadBuffer(media.fileUrl, 'file-download');

  // Per-run stage timing accumulator. Reset on each run so reruns don't carry
  // residual numbers from a prior partial attempt.
  run.stageTimings = {};
  run._stageCurrent = null;
  run._stageStartedAt = null;

  if (media.fileType === 'video') {
    await runVideoPipeline(run, media, buffer);
  } else {
    await runImagePipeline(run, media, buffer);
  }

  finalizeRunStage(run);

  run.status = 'completed';
  run.stage = 'done';
  run.completedAt = new Date();
  await run.save();

  const totalMs = Object.values(run.stageTimings || {}).reduce((a, n) => a + n, 0);
  console.log(`🎉 DetectRun ${run._id} completed in ${totalMs}ms`);
}

// ──────────────────────────────────────────────────────────────
//  Image pipeline
// ──────────────────────────────────────────────────────────────
async function runImagePipeline(run, media, buffer) {
  const sourceUrl = media.fileUrl;

  // ── YOLO ──
  await setRunStage(run, 'yolo');
  let products = [];
  try {
    const yolo = await detectMultipleProducts(buffer);
    products = yolo.detections;
    console.log(`🔍 YOLO: ${products.length} product(s)`);
  } catch (err) { console.warn('⚠️  YOLO:', err.message); }

  // ── YOLO identify ──
  await setRunStage(run, 'yolo-identify');
  try {
    if (products.length) {
      const ids = await identifyYoloDetections(products, {
        brand: media.metadata?.brand,
        category: media.metadata?.category
      });
      console.log(`🏷️   YOLO identify: ${ids.length} detection(s) enriched`);
    }
  } catch (err) { console.warn('⚠️  YOLO identify:', err.message); }

  // ── Subjects + text + background ──
  await setRunStage(run, 'subjects-text');
  let subjects = [], text = [], background = null;
  try {
    const st = await detectSubjectsAndText(sourceUrl, {
      brand: media.metadata?.brand,
      category: media.metadata?.category,
      caption: media.metadata?.caption
    });
    subjects = st.subjects; text = st.text; background = st.background;
  } catch (err) { console.warn('⚠️  Subject/text:', err.message); }

  const imgW = products[0]?.imgWidth  || 1024;
  const imgH = products[0]?.imgHeight || 768;

  // Persist Media dimensions so consumers can query without loading artifacts.
  media.width  = imgW;
  media.height = imgH;
  await media.save();

  // ── Detection artifact (preliminary — primary subject filled in after judge) ──
  const detectionDoc = await DetectionArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    type: 'image',
    width: imgW, height: imgH,
    imageUrl: sourceUrl,
    yoloProducts: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, background
  });

  // ── Smart crops ──
  await setRunStage(run, 'smart-crops');
  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);
  const crops = generateSmartCrops(imgW, imgH, subjects, text, safeRect);

  // ── Judge ──
  await setRunStage(run, 'judge');
  let judge = null;
  try {
    judge = await judgeDetections({ imageUrl: sourceUrl, products, subjects, text, crops, safeRect });
  } catch (err) { console.warn('⚠️  Judge:', err.message); }

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  // Backfill the detection artifact with judge-arbitrated primary + safeRect.
  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  const cropDoc = await CropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    smartCrops: crops,
    judge,
    winners: {
      '5:4': judge?.crop_5_4?.winnerId || null,
      '1:1': judge?.crop_1_1?.winnerId || null,
      '4:5': judge?.crop_4_5?.winnerId || null
    }
  });

  // ── Extended crops + judge ──
  await setRunStage(run, 'extended-crops');
  let extendedCandidates = {}, extendedErrors = {}, extendedJudgeRes = {};
  try {
    const { candidates, errors } = await generateExtendedCrops({
      sourceImageUrl: sourceUrl, sourceVideoUrl: null,
      smartCrops: crops, judge, primarySubject: primarySubjectDesc,
      background, isVideo: false
    });
    extendedCandidates = candidates;
    extendedErrors = errors;
    const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
    console.log(`🖼️   Extended crops: ${totalCandidates} candidate(s) across ${Object.keys(extendedCandidates).length} ratios`);
    if (totalCandidates > 0) {
      await setRunStage(run, 'judge-extended');
      extendedJudgeRes = await judgeExtendedCrops({
        candidates: extendedCandidates,
        sourceImageUrl: sourceUrl,
        text,
        primarySubject: primarySubjectDesc
      });
    }
  } catch (err) { console.warn('⚠️  Extended crops:', err.message); }

  const extendedDoc = await ExtendedCropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    candidates: extendedCandidates,
    errors: extendedErrors,
    judge: extendedJudgeRes,
    selectedWinners: deriveSelectedWinners(extendedCandidates, extendedJudgeRes)
  });

  // ── Product match ──
  await setRunStage(run, 'product-match');
  let productMatches = null;
  try {
    productMatches = await findProductMatches({
      brand:          media.metadata?.brand,
      brandUrl:       media.metadata?.brandUrl,
      advertiserId:   media.advertiserId || null,
      brandId:        media.brandId || null,
      category:       media.metadata?.category,
      caption:        media.metadata?.caption,
      primarySubject: primarySubjectDesc,
      textDetected:   text.map(t => t.content).filter(Boolean),
      imageUrl:       sourceUrl,
      // YOLO+GPT enriched identifications drive the decision tree
      // (multi-brand contention, confidence comparison vs Gemini).
      yoloIdentifications: products
    });
    console.log(`🔗 Product match: ${productMatches.totalMatches} total across ${Object.keys(productMatches.providers).length} provider(s)${productMatches.matchSource ? ` (source=${productMatches.matchSource})` : ''}`);
  } catch (err) { console.warn('⚠️  Product match:', err.message); }

  const matchDoc = productMatches ? await ProductMatchArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    query:            productMatches.query,
    providers:        productMatches.providers,
    errors:           productMatches.errors,
    totalMatches:     productMatches.totalMatches,
    identification:   productMatches.identification || null,
    outcome:          productMatches.outcome || null,
    outcomeReasoning: productMatches.outcomeReasoning || null,
    winner:           productMatches.winner || null,
    brandCategory:    productMatches.brandCategory || null,
    brandReviews:     productMatches.brandReviews || null,
    matchSource:      productMatches.matchSource || null,
    catalogProductId: productMatches.catalogMatch?.product?._id || null,
    catalogMatch:     productMatches.catalogMatch ? {
      productId:   productMatches.catalogMatch.product._id,
      title:       productMatches.catalogMatch.product.title,
      score:       productMatches.catalogMatch.score,
      reasoning:   productMatches.catalogMatch.reasoning,
      signalsUsed: productMatches.catalogMatch.signalsUsed
    } : null,
    productReviews:   productMatches.productReviews || null
  }) : null;

  // V3 #3 — auto-comment on the original IG post when this Media came
  // from Instagram and produced a confident product_match with a
  // productUrl. Fire-and-forget; the service guards on brand opt-in,
  // daily cap, and idempotency. Errors are swallowed so detect never
  // fails because of an opportunistic comment.
  if (productMatches && media.source === 'instagram') {
    maybePostMatchReply({ media, productMatch: productMatches })
      .catch(err => console.warn(`   ⚠️  comment-reply async failure: ${err.message}`));
  }

  // (Brand-catalog upsert removed — brands are now created intentionally
  // via the picker / members UI, not auto-stubbed from media uploads.
  // The matching service still resolves productMatches.identification.brand
  // as a name string for downstream copy generation; if the user wants
  // that brand in their catalog, they create it explicitly.)

  // ── Overlay zones ──
  await setRunStage(run, 'overlay-zones');
  let overlayZones = {};
  try {
    overlayZones = await runOverlayZoneAnalysis({
      sourceImageUrl: sourceUrl, crops, judge, extendedCrops: extendedCandidates
    });
  } catch (err) { console.warn('⚠️  Overlay zones:', err.message); }

  const overlayDoc = await OverlayZoneArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    zones: overlayZones
  });

  await updateMediaLatestArtifacts(media, {
    detection:    detectionDoc._id,
    crops:        cropDoc._id,
    extended:     extendedDoc._id,
    match:        matchDoc?._id,
    overlayZones: overlayDoc._id
  });
}

// ──────────────────────────────────────────────────────────────
//  Video pipeline
// ──────────────────────────────────────────────────────────────
async function runVideoPipeline(run, media, buffer) {
  const sourceVideoUrl = media.fileUrl;

  // ── YOLO over the clip ──
  await setRunStage(run, 'yolo-video');
  let products = [];
  let heroImageUrl = null;
  let heroFrameSec = null, heroReason = null, videoDurationSec = null;
  let imgW = 1024, imgH = 768;

  try {
    const yolo = await detectFromVideo(buffer, media.fileName);
    products = yolo.detections;
    imgW = yolo.width  || imgW;
    imgH = yolo.height || imgH;
    heroFrameSec     = yolo.heroFrameSec;
    heroReason       = yolo.heroReason;
    videoDurationSec = yolo.videoDurationSec;
    if (yolo.heroFrameBase64) {
      const heroBuf = Buffer.from(yolo.heroFrameBase64, 'base64');
      const up = await uploadBufferToCloudinary(heroBuf, { resourceType: 'image' });
      heroImageUrl = up.secure_url;
      console.log(`🖼️  Hero frame @ ${heroFrameSec}s (${heroReason}): ${heroImageUrl}`);
    }
  } catch (err) { console.warn('⚠️  YOLO video:', err.message); }

  // ── YOLO identify ──
  await setRunStage(run, 'yolo-identify');
  try {
    if (products.length) {
      const ids = await identifyYoloDetections(products, {
        brand: media.metadata?.brand,
        category: media.metadata?.category
      });
      console.log(`🏷️   YOLO identify: ${ids.length} detection(s) enriched`);
    }
  } catch (err) { console.warn('⚠️  YOLO identify:', err.message); }

  // ── Transcribe + NER ──
  await setRunStage(run, 'transcribe');
  let transcript = null, entities = [];
  try {
    transcript = await transcribeAudio(buffer, media.fileName);
    if (transcript) {
      console.log(`🎙️  Transcript: ${transcript.segments.length} segments, ${transcript.duration.toFixed(1)}s`);
      await setRunStage(run, 'ner');
      entities = await extractEntities(transcript);
      console.log(`🏷️  NER: ${entities.length} entities`);
    }
  } catch (err) { console.warn('⚠️  Transcription/NER:', err.message); }

  // ── Subjects + text + background (on hero frame only) ──
  let subjects = [], text = [], background = null;
  if (heroImageUrl) {
    await setRunStage(run, 'subjects-text');
    try {
      const st = await detectSubjectsAndText(heroImageUrl, {
        brand: media.metadata?.brand,
        category: media.metadata?.category,
        caption: media.metadata?.caption
      });
      subjects = st.subjects; text = st.text; background = st.background;
    } catch (err) { console.warn('⚠️  Subject/text:', err.message); }
  }

  // Persist Media dimensions + duration.
  media.width = imgW; media.height = imgH;
  if (videoDurationSec) media.durationSec = videoDurationSec;
  await media.save();

  const detectionDoc = await DetectionArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    type: 'video',
    width: imgW, height: imgH,
    imageUrl: heroImageUrl,                 // hero frame (the canonical "still" for this video)
    videoUrl: sourceVideoUrl,
    heroFrameSec, heroReason, videoDurationSec,
    yoloProducts: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, background,
    transcript: transcript ? {
      text: transcript.text,
      duration: transcript.duration,
      segments: transcript.segments,
      entities
    } : null
  });

  // ── Smart crops ──
  await setRunStage(run, 'smart-crops');
  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);
  const crops = generateSmartCrops(imgW, imgH, subjects, text, safeRect);

  // Attach a Cloudinary video-transform URL to each crop candidate so the UI
  // can preview the fully cropped clip.
  for (const ratio of Object.keys(crops)) {
    for (const c of crops[ratio]) {
      c.videoUrl = buildCloudinaryCropUrl(sourceVideoUrl, c);
    }
  }

  // ── Judge ──
  let judge = null;
  if (heroImageUrl) {
    await setRunStage(run, 'judge');
    try {
      judge = await judgeDetections({ imageUrl: heroImageUrl, products, subjects, text, crops, safeRect });
    } catch (err) { console.warn('⚠️  Judge:', err.message); }
  }

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  const cropDoc = await CropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    smartCrops: crops,
    judge,
    winners: {
      '5:4': judge?.crop_5_4?.winnerId || null,
      '1:1': judge?.crop_1_1?.winnerId || null,
      '4:5': judge?.crop_4_5?.winnerId || null
    }
  });

  // ── Extended crops + judge ──
  let extendedCandidates = {}, extendedErrors = {}, extendedJudgeRes = {};
  if (heroImageUrl) {
    await setRunStage(run, 'extended-crops');
    try {
      const { candidates, errors } = await generateExtendedCrops({
        sourceImageUrl: heroImageUrl,
        sourceVideoUrl: sourceVideoUrl,
        smartCrops: crops, judge, primarySubject: primarySubjectDesc,
        background, isVideo: true
      });
      extendedCandidates = candidates;
      extendedErrors = errors;
      const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
      console.log(`🖼️   Extended crops (video): ${totalCandidates} candidate(s)`);
      if (totalCandidates > 0) {
        await setRunStage(run, 'judge-extended');
        extendedJudgeRes = await judgeExtendedCrops({
          candidates: extendedCandidates,
          sourceImageUrl: heroImageUrl,
          text,
          primarySubject: primarySubjectDesc
        });
      }
    } catch (err) { console.warn('⚠️  Extended crops:', err.message); }
  }

  const extendedDoc = await ExtendedCropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    candidates: extendedCandidates,
    errors: extendedErrors,
    judge: extendedJudgeRes,
    selectedWinners: deriveSelectedWinners(extendedCandidates, extendedJudgeRes)
  });

  // ── Product match ──
  await setRunStage(run, 'product-match');
  let productMatches = null;
  try {
    productMatches = await findProductMatches({
      brand:          media.metadata?.brand,
      brandUrl:       media.metadata?.brandUrl,
      advertiserId:   media.advertiserId || null,
      brandId:        media.brandId || null,
      category:       media.metadata?.category,
      caption:        media.metadata?.caption,
      primarySubject: primarySubjectDesc,
      textDetected:   text.map(t => t.content).filter(Boolean),
      imageUrl:       heroImageUrl,
      yoloIdentifications: products
    });
    console.log(`🔗 Product match: ${productMatches.totalMatches} total across ${Object.keys(productMatches.providers).length} provider(s)${productMatches.matchSource ? ` (source=${productMatches.matchSource})` : ''}`);
  } catch (err) { console.warn('⚠️  Product match:', err.message); }

  const matchDoc = productMatches ? await ProductMatchArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    query:            productMatches.query,
    providers:        productMatches.providers,
    errors:           productMatches.errors,
    totalMatches:     productMatches.totalMatches,
    identification:   productMatches.identification || null,
    outcome:          productMatches.outcome || null,
    outcomeReasoning: productMatches.outcomeReasoning || null,
    winner:           productMatches.winner || null,
    brandCategory:    productMatches.brandCategory || null,
    brandReviews:     productMatches.brandReviews || null,
    matchSource:      productMatches.matchSource || null,
    catalogProductId: productMatches.catalogMatch?.product?._id || null,
    catalogMatch:     productMatches.catalogMatch ? {
      productId:   productMatches.catalogMatch.product._id,
      title:       productMatches.catalogMatch.product.title,
      score:       productMatches.catalogMatch.score,
      reasoning:   productMatches.catalogMatch.reasoning,
      signalsUsed: productMatches.catalogMatch.signalsUsed
    } : null,
    productReviews:   productMatches.productReviews || null
  }) : null;

  // V3 #3 — auto-comment on the original IG post when this Media came
  // from Instagram and produced a confident product_match with a
  // productUrl. Fire-and-forget; the service guards on brand opt-in,
  // daily cap, and idempotency. Errors are swallowed so detect never
  // fails because of an opportunistic comment.
  if (productMatches && media.source === 'instagram') {
    maybePostMatchReply({ media, productMatch: productMatches })
      .catch(err => console.warn(`   ⚠️  comment-reply async failure: ${err.message}`));
  }

  // (Brand-catalog upsert removed — brands are now created intentionally
  // via the picker / members UI, not auto-stubbed from media uploads.
  // The matching service still resolves productMatches.identification.brand
  // as a name string for downstream copy generation; if the user wants
  // that brand in their catalog, they create it explicitly.)

  // ── Overlay zones ──
  await setRunStage(run, 'overlay-zones');
  let overlayZones = {};
  if (heroImageUrl) {
    try {
      overlayZones = await runOverlayZoneAnalysis({
        sourceImageUrl: heroImageUrl, crops, judge, extendedCrops: extendedCandidates
      });
    } catch (err) { console.warn('⚠️  Overlay zones:', err.message); }
  }

  const overlayDoc = await OverlayZoneArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId,
    zones: overlayZones
  });

  await updateMediaLatestArtifacts(media, {
    detection:    detectionDoc._id,
    crops:        cropDoc._id,
    extended:     extendedDoc._id,
    match:        matchDoc?._id,
    overlayZones: overlayDoc._id
  });
}

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

// Local stage helpers — write to run.stage + run.stageTimings (Mixed field
// needs markModified to persist). The shared.setStage variant writes to
// `detectionStage` which is the legacy Job model's field.
async function setRunStage(run, stage) {
  finalizeRunStage(run);
  run._stageCurrent = stage;
  run._stageStartedAt = Date.now();
  run.stage = stage;
  await run.save();
  console.log(`   → ${stage}`);
}

function finalizeRunStage(run) {
  if (run._stageCurrent && run._stageStartedAt) {
    const elapsed = Date.now() - run._stageStartedAt;
    const timings = run.stageTimings || {};
    timings[run._stageCurrent] = (timings[run._stageCurrent] || 0) + elapsed;
    run.stageTimings = timings;
    run.markModified('stageTimings');
  }
}

// Cloudinary video-transform URL: crop every frame to a given rect.
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
async function runOverlayZoneAnalysis({ sourceImageUrl, crops, judge, extendedCrops }) {
  const inputs = pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops });
  if (!inputs.length) return {};

  const settled = await Promise.allSettled(inputs.map(i =>
    analyzeOverlayZones({ imageUrl: i.imageUrl, label: i.label, ratio: i.ratio })
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

// For each extended ratio, derive who actually got picked (after the override
// rule in judgeService.judgeExtendedCrops's stopgap).
function deriveSelectedWinners(candidates, judge) {
  const out = {};
  for (const ratio of Object.keys(candidates || {})) {
    const judgeWinner = judge?.[ratio]?.winnerId || null;
    const reasoning   = judge?.[ratio]?.reasoning || '';
    const isOverride  = reasoning.startsWith('[override]');
    if (judgeWinner) {
      out[ratio] = { candidateId: judgeWinner, source: isOverride ? 'override' : 'judge' };
    }
  }
  return out;
}

// Update Media.latestArtifacts to point at the freshest artifacts. Skip slots
// where the run produced nothing (preserve any existing pointer from a prior
// successful run rather than clearing it).
async function updateMediaLatestArtifacts(media, ids) {
  const existing = media.latestArtifacts || {};
  media.latestArtifacts = {
    detection:    ids.detection    || existing.detection    || null,
    crops:        ids.crops        || existing.crops        || null,
    extended:     ids.extended     || existing.extended     || null,
    match:        ids.match        || existing.match        || null,
    overlayZones: ids.overlayZones || existing.overlayZones || null
  };
  await media.save();
}

module.exports = { processDetectRun };
