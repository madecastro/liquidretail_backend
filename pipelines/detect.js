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

  await setStage(job, 'subjects-text');
  let subjects = [], text = [];
  try {
    const st = await detectSubjectsAndText(job.fileUrl);
    subjects = st.subjects; text = st.text;
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

  await setStage(job, 'extended-crops');
  const primarySubjectDesc = (subjects.find(s => s.role === 'primary') || {}).description || null;
  let extendedCrops = {}, extendedErrors = {}, extendedJudge = {};
  try {
    const { candidates, errors } = await generateExtendedCrops({
      sourceImageUrl: job.fileUrl,
      sourceVideoUrl: null,
      smartCrops: crops, judge, primarySubject: primarySubjectDesc, isVideo: false
    });
    extendedCrops = candidates;
    extendedErrors = errors;
    const totalCandidates = Object.values(extendedCrops).reduce((a, arr) => a + arr.length, 0);
    console.log(`🖼️   Extended crops: ${totalCandidates} candidate(s) across ${Object.keys(extendedCrops).length} ratios`);
    if (totalCandidates > 0) {
      await setStage(job, 'judge-extended');
      extendedJudge = await judgeExtendedCrops(extendedCrops);
    }
  } catch (err) { console.warn('⚠️  Extended crops:', err.message); }

  return {
    type: 'image',
    imageUrl: job.fileUrl,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, crops, judge, safeRect,
    extendedCrops, extendedErrors, extendedJudge
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

  let subjects = [], text = [];
  if (heroImageUrl) {
    await setStage(job, 'subjects-text');
    try {
      const st = await detectSubjectsAndText(heroImageUrl);
      subjects = st.subjects; text = st.text;
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

  let extendedCrops = {}, extendedErrors = {}, extendedJudge = {};
  if (heroImageUrl) {
    await setStage(job, 'extended-crops');
    const primarySubjectDesc = (subjects.find(s => s.role === 'primary') || {}).description || null;
    try {
      const { candidates, errors } = await generateExtendedCrops({
        sourceImageUrl: heroImageUrl,
        sourceVideoUrl: job.fileUrl,
        smartCrops: crops, judge, primarySubject: primarySubjectDesc, isVideo: true
      });
      extendedCrops = candidates;
      extendedErrors = errors;
      const totalCandidates = Object.values(extendedCrops).reduce((a, arr) => a + arr.length, 0);
      console.log(`🖼️   Extended crops (video): ${totalCandidates} candidate(s)`);
      if (totalCandidates > 0) {
        await setStage(job, 'judge-extended');
        extendedJudge = await judgeExtendedCrops(extendedCrops);
      }
    } catch (err) { console.warn('⚠️  Extended crops:', err.message); }
  }

  return {
    type: 'video',
    videoUrl: job.fileUrl,
    imageUrl: heroImageUrl,
    heroFrameSec, heroReason, videoDurationSec,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, crops, judge, safeRect,
    extendedCrops, extendedErrors, extendedJudge,
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
function buildCloudinaryCropUrl(videoUrl, crop) {
  if (!videoUrl || !videoUrl.includes('/upload/')) return null;
  const w = Math.max(1, crop.x2 - crop.x1);
  const h = Math.max(1, crop.y2 - crop.y1);
  const transform = `c_crop,w_${w},h_${h},x_${crop.x1},y_${crop.y1}`;
  return videoUrl.replace('/upload/', `/upload/${transform}/`);
}

module.exports = { processDetectJob };
