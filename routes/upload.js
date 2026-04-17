const express = require('express');
const multer = require('multer');
const router = express.Router();
const Job = require('../models/Job');

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska'];
const MAX_SIZE_MB = 100;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 }
});

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { buffer, mimetype } = req.file;
    const fileType = VIDEO_TYPES.includes(mimetype) ? 'video' : 'image';
    const metadata = req.body;

    const job = new Job({
      fileBuffer: buffer,
      fileType,
      status: 'queued',
      metadata: {
        truck_number: metadata.truck_number,
        price: metadata.price,
        delivery_date: metadata.delivery_date,
        delivery_time: metadata.delivery_time,
        delivery_location: metadata.delivery_location
      }
    });

    await job.save();
    console.log(`🆕 Job queued: ${job._id} (${fileType})`);
    res.status(202).json({ jobId: job._id, fileType });
  } catch (err) {
    console.error('❌ Failed to queue upload:', err);
    res.status(500).json({ error: 'Upload failed', message: err.message });
  }
});

module.exports = router;
