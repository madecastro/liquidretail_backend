// Detect pipeline — /api/detect flow (detect.html).
// Takes a social-media-style image or video and produces a layered analysis:
// YOLO product bounding boxes, GPT-4.1 subjects + text regions, safe-envelope
// smart crops (5:4, 1:1, 4:5), extended-ratio AI candidates (9:16, 1.91:1) via
// OpenAI + Gemini, plus — for videos — Whisper transcription and time-stamped
// named entity extraction.
//
// Downstream: approved product crops can be queued into the Inventory pipeline
// via pipelines/bridge.js (pre-cropped jobs).

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

const { downloadBuffer, setStage, finalizeStage } = require('./shared');

// ──────────────────────────────────────────────────────────────
//  Main handler — image or video → full detection result
// ──────────────────────────────────────────────────────────────
async function processDetectJob(job) {
  const isVideo = job.fileType === 'detect-video';
  const fileBuffer = await downloadBuffer(job.fileUrl, 'file-download');

  // Stage-timing accumulator; setStage/finalizeStage from shared.js push to job._stageTimings.
  job._stageTimings = {};
  job._stageStartedAt = Date.now();

  const result = isVideo
    ? await runDetectVideoPipeline(job, fileBuffer)
    : await runDetectImagePipeline(job, fileBuffer);

  finalizeStage(job);
  result.stageTimings = job._stageTimings;

  job.status = 'completed';
  job.detectionStage = 'done';
  job.detectionResult = result;
  job.completedAt = new Date();
  await job.save();
  console.log(`🎉 Detect job ${job._id} completed in ${Object.values(job._stageTimings).reduce((a, n) => a + n, 0)}ms`);
}

async function runDetectImagePipeline(job, buffer) {
  await setStage(job, 'yolo');
  let products = [];
  try {
    const yolo = await detectMultipleProducts(buffer);
    products = yolo.detections;
    console.log(`🔍 YOLO: ${products.length} product(s)`);
  } catch (err) { console.warn('⚠️  YOLO:', err.message); }

  await setStage(job, 'yolo-identify');
  try {
    if (products.length) {
      const ids = await identifyYoloDetections(products, {
        brand: job.metadata?.brand,
        category: job.metadata?.category
      });
      console.log(`🏷️   YOLO identify: ${ids.length} detection(s) enriched`);
    }
  } catch (err) { console.warn('⚠️  YOLO identify:', err.message); }

  await setStage(job, 'subjects-text');
  let subjects = [], text = [], background = null;
  try {
    const st = await detectSubjectsAndText(job.fileUrl, {
      brand: job.metadata?.brand,
      category: job.metadata?.category,
      caption: job.metadata?.caption
    });
    subjects = st.subjects; text = st.text; background = st.background;
  } catch (err) { console.warn('⚠️  Subject/text:', err.message); }

  const imgW = products[0]?.imgWidth  || 1024;
  const imgH = products[0]?.imgHeight || 768;

  await setStage(job, 'smart-crops');
  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);
  const crops = generateSmartCrops(imgW, imgH, subjects, text, safeRect);

  await setStage(job, 'judge');
  let judge = null;
  try {
    judge = await judgeDetections({ imageUrl: job.fileUrl, products, subjects, text, crops, safeRect });
  } catch (err) { console.warn('⚠️  Judge:', err.message); }

  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  await setStage(job, 'extended-crops');
  let extendedCrops = {}, extendedErrors = {}, extendedJudge = {};
  try {
    const { candidates, errors } = await generateExtendedCrops({
      sourceImageUrl: job.fileUrl,
      sourceVideoUrl: null,
      smartCrops: crops, judge, primarySubject: primarySubjectDesc,
      background, isVideo: false
    });
    extendedCrops = candidates;
    extendedErrors = errors;
    const totalCandidates = Object.values(extendedCrops).reduce((a, arr) => a + arr.length, 0);
    console.log(`🖼️   Extended crops: ${totalCandidates} candidate(s) across ${Object.keys(extendedCrops).length} ratios`);
    if (totalCandidates > 0) {
      await setStage(job, 'judge-extended');
      extendedJudge = await judgeExtendedCrops({
        candidates: extendedCrops,
        sourceImageUrl: job.fileUrl,
        text,
        primarySubject: primarySubjectDesc
      });
    }
  } catch (err) { console.warn('⚠️  Extended crops:', err.message); }

  await setStage(job, 'product-match');
  let productMatches = null;
  try {
    productMatches = await findProductMatches({
      brand:          job.metadata?.brand,
      category:       job.metadata?.category,
      caption:        job.metadata?.caption,
      primarySubject: primarySubjectDesc,
      textDetected:   text.map(t => t.content).filter(Boolean),
      imageUrl:       job.fileUrl
    });
    console.log(`🔗 Product match: ${productMatches.totalMatches} total across ${Object.keys(productMatches.providers).length} provider(s)`);
  } catch (err) { console.warn('⚠️  Product match:', err.message); }

  await setStage(job, 'overlay-zones');
  let overlayZones = {};
  try {
    overlayZones = await runOverlayZoneAnalysis({
      sourceImageUrl: job.fileUrl,
      crops, judge, extendedCrops
    });
  } catch (err) { console.warn('⚠️  Overlay zones:', err.message); }

  return {
    type: 'image',
    imageUrl: job.fileUrl,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, background, crops, judge, safeRect,
    primarySubjectDesc,
    extendedCrops, extendedErrors, extendedJudge,
    productMatches,
    overlayZones
  };
}

async function runDetectVideoPipeline(job, buffer) {
  await setStage(job, 'yolo-video');
  let products = [];
  let heroImageUrl = null;
  let heroFrameSec = null;
  let heroReason = null;
  let videoDurationSec = null;
  let imgW = 1024, imgH = 768;

  try {
    const yolo = await detectFromVideo(buffer, job.fileName);
    products = yolo.detections;
    imgW = yolo.width || imgW;
    imgH = yolo.height || imgH;
    heroFrameSec = yolo.heroFrameSec;
    heroReason = yolo.heroReason;
    videoDurationSec = yolo.videoDurationSec;
    if (yolo.heroFrameBase64) {
      const heroBuf = Buffer.from(yolo.heroFrameBase64, 'base64');
      const up = await uploadBufferToCloudinary(heroBuf, { resourceType: 'image' });
      heroImageUrl = up.secure_url;
      console.log(`🖼️  Hero frame @ ${heroFrameSec}s (${heroReason}): ${heroImageUrl}`);
    }
  } catch (err) { console.warn('⚠️  YOLO video:', err.message); }

  await setStage(job, 'yolo-identify');
  try {
    if (products.length) {
      const ids = await identifyYoloDetections(products, {
        brand: job.metadata?.brand,
        category: job.metadata?.category
      });
      console.log(`🏷️   YOLO identify: ${ids.length} detection(s) enriched`);
    }
  } catch (err) { console.warn('⚠️  YOLO identify:', err.message); }

  await setStage(job, 'transcribe');
  let transcript = null, entities = [];
  try {
    transcript = await transcribeAudio(buffer, job.fileName);
    if (transcript) {
      console.log(`🎙️  Transcript: ${transcript.segments.length} segments, ${transcript.duration.toFixed(1)}s`);
      await setStage(job, 'ner');
      entities = await extractEntities(transcript);
      console.log(`🏷️  NER: ${entities.length} entities`);
    }
  } catch (err) { console.warn('⚠️  Transcription/NER:', err.message); }

  let subjects = [], text = [], background = null;
  if (heroImageUrl) {
    await setStage(job, 'subjects-text');
    try {
      const st = await detectSubjectsAndText(heroImageUrl, {
        brand: job.metadata?.brand,
        category: job.metadata?.category,
        caption: job.metadata?.caption
      });
      subjects = st.subjects; text = st.text; background = st.background;
    } catch (err) { console.warn('⚠️  Subject/text:', err.message); }
  }

  await setStage(job, 'smart-crops');
  // Safe envelope = union of all deduped YOLO detections (each captured from
  // the frame where it first appeared) + primary GPT subjects on the hero frame.
  // This approximates where the subject-of-interest lives across the whole clip.
  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);
  const crops = generateSmartCrops(imgW, imgH, subjects, text, safeRect);

  // Attach a Cloudinary video-transform URL to each crop candidate so the UI
  // can preview the fully cropped clip (every frame re-framed to the ratio).
  for (const ratio of Object.keys(crops)) {
    for (const c of crops[ratio]) {
      c.videoUrl = buildCloudinaryCropUrl(job.fileUrl, c);
    }
  }

  let judge = null;
  if (heroImageUrl) {
    await setStage(job, 'judge');
    try {
      judge = await judgeDetections({ imageUrl: heroImageUrl, products, subjects, text, crops, safeRect });
    } catch (err) { console.warn('⚠️  Judge:', err.message); }
  }

  // Hoisted so both the extended-crops and product-match stages can see it.
  // Judge's primaryId is preferred over GPT's role field — the judge sees YOLO
  // + GPT subjects together and can arbitrate when they disagree.
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  let extendedCrops = {}, extendedErrors = {}, extendedJudge = {};
  if (heroImageUrl) {
    await setStage(job, 'extended-crops');
    try {
      const { candidates, errors } = await generateExtendedCrops({
        sourceImageUrl: heroImageUrl,
        sourceVideoUrl: job.fileUrl,
        smartCrops: crops, judge, primarySubject: primarySubjectDesc,
        background, isVideo: true
      });
      extendedCrops = candidates;
      extendedErrors = errors;
      const totalCandidates = Object.values(extendedCrops).reduce((a, arr) => a + arr.length, 0);
      console.log(`🖼️   Extended crops (video): ${totalCandidates} candidate(s)`);
      if (totalCandidates > 0) {
        await setStage(job, 'judge-extended');
        extendedJudge = await judgeExtendedCrops({
          candidates: extendedCrops,
          sourceImageUrl: heroImageUrl,
          text,
          primarySubject: primarySubjectDesc
        });
      }
    } catch (err) { console.warn('⚠️  Extended crops:', err.message); }
  }

  await setStage(job, 'product-match');
  let productMatches = null;
  try {
    productMatches = await findProductMatches({
      brand:          job.metadata?.brand,
      category:       job.metadata?.category,
      caption:        job.metadata?.caption,
      primarySubject: primarySubjectDesc,
      textDetected:   text.map(t => t.content).filter(Boolean),
      imageUrl:       heroImageUrl
    });
    console.log(`🔗 Product match: ${productMatches.totalMatches} total across ${Object.keys(productMatches.providers).length} provider(s)`);
  } catch (err) { console.warn('⚠️  Product match:', err.message); }

  await setStage(job, 'overlay-zones');
  let overlayZones = {};
  if (heroImageUrl) {
    try {
      overlayZones = await runOverlayZoneAnalysis({
        sourceImageUrl: heroImageUrl,
        crops, judge, extendedCrops
      });
    } catch (err) { console.warn('⚠️  Overlay zones:', err.message); }
  }

  return {
    type: 'video',
    videoUrl: job.fileUrl,
    imageUrl: heroImageUrl,
    heroFrameSec, heroReason, videoDurationSec,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, background, crops, judge, safeRect,
    primarySubjectDesc,
    extendedCrops, extendedErrors, extendedJudge,
    productMatches,
    overlayZones,
    transcript: transcript ? {
      text: transcript.text,
      duration: transcript.duration,
      segments: transcript.segments,
      entities
    } : null
  };
}

// Build a Cloudinary video transform URL that crops every frame to a given rect.
// Source URL shape: https://res.cloudinary.com/<cloud>/video/upload/v123.../path.mp4
// Insert the transform after existing ones (anchored on /v<num>/) so downstream
// transforms can be chained without transform-order bugs.
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
// Artifact shape — stable contract for downstream ad-layout generator:
//   {
//     '5:4':   { base:             { candidateId, imageUrl, analysis } },
//     '1:1':   { base:             { ... } },
//     '4:5':   { base:             { ... } },
//     '9:16':  { gemini_extension: { ... }, gemini_generation: { ... } },
//     '1.91:1':{ gemini_extension: { ... }, gemini_generation: { ... } }
//   }
// Always: artifact[ratio][variantKey]. `analysis` is null when Gemini failed
// for that specific image (non-fatal; other slots still populate).
//
// TODO — video-specific refinements. Currently both the image and video
// pipelines run this stage identically against a single still (hero frame for
// video), which means zones are derived from a single moment in time and can
// collide with the subject later in the clip. In priority order:
//   A. Pass the cross-frame `safeRect` (already computed on video jobs — union
//      of YOLO detections across frames + primary GPT subjects) into the
//      Gemini prompt as an explicit forbidden rect. Eliminates the worst
//      class of failure (overlay ends up under the subject mid-playback).
//      ~15-line change: thread safeRect through runOverlayZoneAnalysis and
//      inject into analyzeOverlayZones's prompt when present.
//   B. Multi-frame analysis. Sample 3 frames (start / middle / end) per
//      ratio, union the forbidden rects, intersect the safe zones, take the
//      worst contrastBg per zone. 3× API cost per video job.
//   C. Analyze the actually-rendered self-underlay video. Use Cloudinary
//      `so_<sec>` transform to extract N frames from the composed output URL
//      (what users actually see playing), not the hero frame. Highest
//      fidelity, highest cost. Only worth doing once the ad-layout generator
//      exists and surfaces real overlay-on-video failures.
async function runOverlayZoneAnalysis({ sourceImageUrl, crops, judge, extendedCrops }) {
  const inputs = pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops });
  if (!inputs.length) return {};

  const settled = await Promise.allSettled(inputs.map(i =>
    analyzeOverlayZones({ imageUrl: i.imageUrl, label: i.label, ratio: i.ratio })
  ));

  const artifact = {};
  inputs.forEach((input, idx) => {
    const analysis = settled[idx].status === 'fulfilled' ? settled[idx].value : null;
    artifact[input.ratio] = artifact[input.ratio] || {};
    artifact[input.ratio][input.variantKey] = {
      candidateId: input.candidateId,
      imageUrl:    input.imageUrl,
      analysis
    };
  });

  const ok = inputs.reduce((a, input) =>
    a + (artifact[input.ratio][input.variantKey].analysis ? 1 : 0), 0);
  console.log(`🎯 Overlay zones: ${ok}/${inputs.length} analyses complete`);
  return artifact;
}

// Select the images to analyze. Base ratios → judge winner cropped from the
// source via Cloudinary c_crop. Extended ratios → Gemini extension + Gemini
// generation candidates (both, as requested — OpenAI variants are skipped
// here; fidelity bias against them has been confirmed).
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
      ratio,
      variantKey:  'base',
      candidateId: winner.id,
      imageUrl,
      label: `${ratio} base`
    });
  }

  for (const ratio of ['9:16', '1.91:1']) {
    const list = extendedCrops?.[ratio] || [];
    for (const variant of ['extension', 'generation']) {
      const cand = list.find(c => c.provider === 'gemini' && c.variant === variant);
      if (!cand?.imageUrl) continue;
      inputs.push({
        ratio,
        variantKey:  `gemini_${variant}`,
        candidateId: cand.id,
        imageUrl:    cand.imageUrl,
        label: `${ratio} gem-${variant}`
      });
    }
  }

  return inputs;
}

// Primary-subject description resolver. The judge sees both YOLO products and
// GPT subjects at once, so its `judge.subjects.primaryId` is the authoritative
// pick when available. Fall back to GPT's own role=primary tag when the judge
// didn't run (e.g. its stage failed) or didn't identify a primary.
function resolvePrimarySubjectDesc(subjects, judge) {
  if (!subjects || subjects.length === 0) return null;
  const judgePrimaryId = judge?.subjects?.primaryId;
  const byJudge = judgePrimaryId ? subjects.find(s => s.id === judgePrimaryId) : null;
  const byRole  = subjects.find(s => s.role === 'primary');
  return (byJudge || byRole || {}).description || null;
}

module.exports = { processDetectJob };
