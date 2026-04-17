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
// Async: upload file to Cloudinary, queue a detect-* job, return 202 { jobId }.
// The worker picks it up and runs the full pipeline (see worker.js).
router.post('/', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });

  const isVideo = (req.file.mimetype || '').startsWith('video/');
  const sizeMB = (req.file.size / 1024 / 1024).toFixed(1);
  console.log(`📥 /api/detect ${isVideo ? 'VIDEO' : 'IMAGE'} ${req.file.originalname} (${sizeMB}MB)`);

  let metadata = {};
  try { metadata = JSON.parse(req.body.metadata || '{}'); } catch {}

  try {
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      resourceType: isVideo ? 'video' : 'image'
    });

    const job = new Job({
      fileType: isVideo ? 'detect-video' : 'detect-image',
      fileUrl: uploaded.secure_url,
      fileMimeType: req.file.mimetype,
      fileName: req.file.originalname,
      status: 'queued',
      detectionStage: 'queued',
      metadata
    });
    await job.save();
    console.log(`🆕 Detect job queued: ${job._id} (${job.fileType})`);
    res.status(202).json({ jobId: job._id });
  } catch (err) {
    console.error('Upload/queue error:', err);
    res.status(500).json({ error: 'Failed to queue detection job', message: err.message });
  }
});

// GET /api/detect/status/:jobId
// Poll endpoint for the frontend
router.get('/status/:jobId', async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      jobId: job._id,
      status: job.status,
      stage: job.detectionStage,
      result: job.status === 'completed' ? job.detectionResult : null,
      error: job.status === 'failed' ? job.error : null,
      errorStage: job.status === 'failed' ? job.errorStage : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status', message: err.message });
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
