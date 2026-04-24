const express = require('express');
const router = express.Router();

const { generateAiLayouts, DEFAULT_VARIANTS, DEFAULT_ASPECT_RATIOS } = require('../services/aiLayoutStudioService');

// POST /api/ai-layouts/generate
// Body: { mediaId, variants?, aspectRatios?, quality? }
// Returns: { mediaId, brandName, productName, quality, generatedAt, references: [{variant, aspectRatio, imageUrl, extractedCanvas, status, error?}] }
//
// Quality defaults to 'low' (~$0.011/image @ 1024² or $0.016 @ 1024×1536).
// Variants default to all three (brand / product / social), ratios default
// to [1:1, 9:16, 1.91:1]. Full session default: 9 images, ~$0.15 total.
router.post('/generate', express.json(), async (req, res) => {
  try {
    const { mediaId, variants, aspectRatios, quality } = req.body || {};
    if (!mediaId) return res.status(400).json({ error: 'mediaId required' });
    const result = await generateAiLayouts({ mediaId, variants, aspectRatios, quality });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'AI layout generation failed' });
  }
});

// GET /api/ai-layouts/meta
// Diagnostic — what the service supports.
router.get('/meta', (req, res) => {
  res.json({
    variants:      DEFAULT_VARIANTS,
    aspect_ratios: DEFAULT_ASPECT_RATIOS,
    qualities:     ['low', 'medium', 'high']
  });
});

module.exports = router;
