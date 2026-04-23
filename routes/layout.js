const express = require('express');
const router = express.Router();

const { buildLayoutInput, TEMPLATES, ASPECT_RATIOS } = require('../services/layoutInputService');

// POST /api/layout-input
// Body: { mediaId, template, aspect_ratio, options?, refresh? }
// Returns the assembled RS Social Proof Creative Input JSON (cached by
// (mediaId, template, aspect_ratio) unless refresh=true).
router.post('/', express.json(), async (req, res) => {
  try {
    const { mediaId, template, aspect_ratio: aspectRatio, options, refresh } = req.body || {};
    if (!mediaId || !template || !aspectRatio) {
      return res.status(400).json({ error: 'mediaId, template, aspect_ratio required' });
    }
    const input = await buildLayoutInput({ mediaId, template, aspectRatio, options, refresh: !!refresh });
    res.json(input);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Layout input generation failed' });
  }
});

// GET /api/layout-input/meta
// Diagnostic — returns the templates and aspect ratios this service supports.
router.get('/meta', (req, res) => {
  res.json({ templates: TEMPLATES, aspect_ratios: ASPECT_RATIOS });
});

module.exports = router;
