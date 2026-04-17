const express = require('express');
const multer = require('multer');
const router = express.Router();
const Job = require('../models/Job');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// POST /api/detect
// Upload image/video, run detection, return image URL + bounding boxes
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { secure_url: imageUrl, width, height } = await uploadBufferToCloudinary(req.file.buffer);

    // TODO: replace with real multi-model detection service
    // Returns mock detections for frontend validation
    const detections = [];

    res.json({ imageUrl, width: width || 1024, height: height || 768, detections });
  } catch (err) {
    console.error('Detection error:', err);
    res.status(500).json({ error: 'Detection failed', message: err.message });
  }
});

// POST /api/detect/process
// Accept approved bounding boxes, queue a pre-cropped job for the pipeline
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
