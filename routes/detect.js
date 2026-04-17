const express = require('express');
const multer = require('multer');
const router = express.Router();
const Job = require('../models/Job');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { detectMultipleProducts, detectFromVideo } = require('../services/yoloService');
const { detectSubjectsAndText } = require('../services/subjectTextService');
const { generateSmartCrops } = require('../services/smartCropService');
const { judgeDetections } = require('../services/judgeService');
const { transcribeAudio } = require('../services/whisperService');
const { extractEntities } = require('../services/nerService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// POST /api/detect
// Detects video vs image by mime type and runs appropriate pipeline.
router.post('/', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });

  const isVideo = (req.file.mimetype || '').startsWith('video/');
  try {
    const result = isVideo
      ? await runVideoPipeline(req.file)
      : await runImagePipeline(req.file);
    res.json(result);
  } catch (err) {
    console.error('Detection error:', err);
    res.status(500).json({ error: 'Detection failed', message: err.message });
  }
});

// POST /api/detect/process
// Accept approved detections, queue a pre-cropped job
router.post('/process', express.json(), async (req, res) => {
  try {
    const { imageUrl, approvedBoxes, metadata } = req.body;
    if (!approvedBoxes?.length) {
      return res.status(400).json({ error: 'No approved boxes provided' });
    }
    const job = new Job({
      fileType: 'pre-cropped',
      status: 'queued',
      metadata,
      detectionData: { imageUrl, approvedBoxes }
    });
    await job.save();
    console.log(`🆕 Pre-cropped job queued: ${job._id} (${approvedBoxes.length} crops)`);
    res.status(202).json({ jobId: job._id });
  } catch (err) {
    console.error('Process error:', err);
    res.status(500).json({ error: 'Failed to queue job', message: err.message });
  }
});

// ── Image pipeline ────────────────────────────────────────────
async function runImagePipeline(file) {
  const { secure_url: imageUrl, width, height } = await uploadBufferToCloudinary(file.buffer);
  console.log(`📸 Image uploaded: ${imageUrl} (${width}x${height})`);

  let products = [];
  try {
    const yolo = await detectMultipleProducts(file.buffer);
    products = yolo.detections;
    console.log(`🔍 YOLO: ${products.length} product(s)`);
  } catch (err) { console.warn('⚠️  YOLO:', err.message); }

  let subjects = [], text = [];
  try {
    const st = await detectSubjectsAndText(imageUrl);
    subjects = st.subjects; text = st.text;
    console.log(`🧠 GPT: ${subjects.length} subject(s), ${text.length} text region(s)`);
  } catch (err) { console.warn('⚠️  Subject/text:', err.message); }

  const imgW = width || 1024;
  const imgH = height || 768;
  const crops = generateSmartCrops(imgW, imgH, subjects, text);

  let judge = null;
  try {
    judge = await judgeDetections({ imageUrl, products, subjects, text, crops });
  } catch (err) { console.warn('⚠️  Judge:', err.message); }

  return {
    type: 'image',
    imageUrl,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, crops, judge
  };
}

// ── Video pipeline ────────────────────────────────────────────
// 1. Upload video to Cloudinary (for reference playback)
// 2. YOLO /detect-video → deduped product clippings + hero frame + per-detection timestamps
// 3. Upload hero frame as separate image → heroImageUrl (used by subject/text/crop panels)
// 4. Whisper transcription of audio
// 5. GPT-4.1 NER on transcript segments
// 6. Subjects/text/crops/judge on hero frame
async function runVideoPipeline(file) {
  const videoUpload = await uploadBufferToCloudinary(file.buffer, { resourceType: 'video' });
  const videoUrl = videoUpload.secure_url;
  console.log(`🎞️  Video uploaded: ${videoUrl}`);

  let products = [];
  let heroBuffer = null;
  let heroImageUrl = null;
  let imgW = 1024, imgH = 768;

  try {
    const yolo = await detectFromVideo(file.buffer, file.originalname);
    products = yolo.detections;
    imgW = yolo.width || imgW;
    imgH = yolo.height || imgH;
    if (yolo.heroFrameBase64) {
      heroBuffer = Buffer.from(yolo.heroFrameBase64, 'base64');
      const up = await uploadBufferToCloudinary(heroBuffer, { resourceType: 'image' });
      heroImageUrl = up.secure_url;
      console.log(`🖼️  Hero frame uploaded: ${heroImageUrl}`);
    }
    console.log(`🔍 YOLO video: ${products.length} product(s)`);
  } catch (err) { console.warn('⚠️  YOLO video:', err.message); }

  let transcript = null;
  let entities = [];
  try {
    transcript = await transcribeAudio(file.buffer, file.originalname);
    if (transcript) {
      console.log(`🎙️  Transcript: ${transcript.segments.length} segment(s), ${transcript.duration.toFixed(1)}s`);
      entities = await extractEntities(transcript);
      console.log(`🏷️  NER: ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`);
    }
  } catch (err) { console.warn('⚠️  Transcription/NER:', err.message); }

  let subjects = [], text = [];
  if (heroImageUrl) {
    try {
      const st = await detectSubjectsAndText(heroImageUrl);
      subjects = st.subjects; text = st.text;
    } catch (err) { console.warn('⚠️  Subject/text:', err.message); }
  }

  const crops = generateSmartCrops(imgW, imgH, subjects, text);

  let judge = null;
  if (heroImageUrl) {
    try {
      judge = await judgeDetections({ imageUrl: heroImageUrl, products, subjects, text, crops });
    } catch (err) { console.warn('⚠️  Judge:', err.message); }
  }

  return {
    type: 'video',
    videoUrl,
    imageUrl: heroImageUrl,         // used by panels for overlays
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, crops, judge,
    transcript: transcript ? {
      text: transcript.text,
      duration: transcript.duration,
      segments: transcript.segments,
      entities
    } : null
  };
}

module.exports = router;
