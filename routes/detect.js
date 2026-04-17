const express = require('express');
const multer = require('multer');
const router = express.Router();
const Job = require('../models/Job');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { detectMultipleProducts } = require('../services/yoloService');
const { detectSubjectsAndText } = require('../services/subjectTextService');
const { generateSmartCrops } = require('../services/smartCropService');
const { judgeDetections } = require('../services/judgeService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// POST /api/detect
// Upload image, run full detection pipeline: YOLO + GPT subjects/text + smart crops + judge
router.post('/', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file required' });

  try {
    // 1. Upload original to Cloudinary
    const { secure_url: imageUrl, width, height } = await uploadBufferToCloudinary(req.file.buffer);
    console.log(`📸 Uploaded to Cloudinary: ${imageUrl} (${width}x${height})`);

    // 2. YOLO product detection (runs against Cloudinary URL via buffer)
    let products = [];
    try {
      const yolo = await detectMultipleProducts(req.file.buffer);
      products = yolo.detections;
      console.log(`🔍 YOLO: ${products.length} product(s)`);
    } catch (err) {
      console.warn('⚠️  YOLO detection returned nothing:', err.message);
    }

    // 3. GPT-4.1: subjects + text (runs in parallel with nothing to block it)
    let subjects = [], text = [];
    try {
      const st = await detectSubjectsAndText(imageUrl);
      subjects = st.subjects;
      text = st.text;
      console.log(`🧠 GPT: ${subjects.length} subject(s), ${text.length} text region(s)`);
    } catch (err) {
      console.warn('⚠️  Subject/text detection failed:', err.message);
    }

    // 4. Smart crops (pure algorithm — no network call)
    const imgW = width || 1024;
    const imgH = height || 768;
    const crops = generateSmartCrops(imgW, imgH, subjects, text);

    // 5. GPT-4.1 judge
    let judge = null;
    try {
      judge = await judgeDetections({ imageUrl, products, subjects, text, crops });
      console.log(`⚖️  Judge complete`);
    } catch (err) {
      console.warn('⚠️  Judge failed:', err.message);
    }

    // Strip base64 buffers before sending (they're just for internal use)
    const productsOut = products.map(({ cropBuffer, ...p }) => p);

    res.json({ imageUrl, width: imgW, height: imgH, products: productsOut, subjects, text, crops, judge });
  } catch (err) {
    console.error('Detection error:', err);
    res.status(500).json({ error: 'Detection failed', message: err.message });
  }
});

// POST /api/detect/process
// Accept approved detections, queue a pre-cropped job for the main pipeline
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

module.exports = router;
