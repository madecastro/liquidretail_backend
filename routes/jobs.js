const express = require('express');
const router = express.Router();
const Job = require('../models/Job');

router.get('/:id/status', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).populate('products');
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.status(200).json({
      status: job.status,
      error: job.error,
      products: job.products || []
    });
  } catch (err) {
    console.error('Job status check error:', err);
    res.status(500).json({ error: 'Failed to fetch job status' });
  }
});

module.exports = router;
