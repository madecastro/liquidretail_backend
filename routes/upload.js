const express = require('express');
const multer = require('multer');
const router = express.Router();
const Job = require('../models/Job'); // <-- new Job model

const upload = multer(); // in-memory

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { buffer } = req.file;
    const metadata = req.body;

    const job = new Job({
      fileBuffer: buffer,
      status: 'queued',
      // attach relevant metadata for the worker to access
      metadata: {
        truck_number: metadata.truck_number,
        price: metadata.price,
        delivery_date: metadata.delivery_date,
        delivery_time: metadata.delivery_time,
        delivery_location: metadata.delivery_location
      }
    });

    await job.save();

    console.log(`🆕 Job queued: ${job._id}`);
    res.status(202).json({ jobId: job._id });
  } catch (err) {
    console.error('❌ Failed to queue upload:', err);
    res.status(500).json({ error: 'Upload failed', message: err.message });
  }
});

module.exports = router;
