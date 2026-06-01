// Test endpoint for the AI canvas spec generator. Lets us iterate on
// the prompt + validator against real Media before wiring AI templates
// into the cartesian.
//
// POST /api/ai-layouts/spec/test
// Body: {
//   mediaId,                 required
//   productId,               optional — seeds the input for product_image variants
//   aspectRatio:    '1:1',   Phase 1a: 1:1 only
//   creativeStyle:  'brand_led',
//   variantKind:    null | 'ugc' | 'product_image',
//   paletteSource:  'media' | 'brand',
//   sourceTemplate: 'ugc_split_screen',   default — the hand-authored template
//                                          we borrow to derive copy + scene
//                                          context. Doesn't affect the AI
//                                          output beyond what flows into
//                                          the canonical input.
//   refresh:        false
// }
// Returns: { spec, cached, artifactId, warnings, input }

const express = require('express');
const router  = express.Router();

const { buildLayoutInput } = require('../services/layoutInputService');
const { getOrGenerate, CREATIVE_STYLES } = require('../services/aiCanvasSpecService');
const { assertMediaInTenant } = require('../middleware/tenantHelpers');
const Media = require('../models/Media');

const DEFAULT_SOURCE_TEMPLATE = 'ugc_split_screen';

router.post('/test', express.json(), async (req, res) => {
  try {
    const {
      mediaId,
      productId       = null,
      aspectRatio     = '1:1',
      creativeStyle   = 'brand_led',
      variantKind     = null,
      paletteSource   = 'media',
      sourceTemplate  = DEFAULT_SOURCE_TEMPLATE,
      refresh         = false
    } = req.body || {};
    if (!mediaId) return res.status(400).json({ error: 'mediaId required' });
    if (!CREATIVE_STYLES[creativeStyle]) {
      return res.status(400).json({ error: `Unknown creativeStyle: ${creativeStyle}. Available: ${Object.keys(CREATIVE_STYLES).join(', ')}` });
    }
    await assertMediaInTenant(mediaId, req);

    const media = await Media.findById(mediaId).select('advertiserId brandId').lean();
    if (!media) return res.status(404).json({ error: 'media not found' });

    // Build the canonical input. Reuses layoutInputService's derivation
    // + assembly pipeline so the LLM gets the same input shape the
    // hand-authored templates see.
    const input = await buildLayoutInput({
      mediaId,
      template:    sourceTemplate,
      aspectRatio,
      options: { productId, variantKind, paletteSource },
      refresh:     false
    });

    const result = await getOrGenerate({
      input,
      template:        `ai_${creativeStyle}`,
      aspectRatio,
      creativeStyle,
      mediaId,
      productId,
      variantKind,
      paletteSource,
      advertiserId:    media.advertiserId,
      brandId:         media.brandId,
      refresh
    });

    res.json({
      ...result,
      input   // include for prompt-iteration visibility
    });
  } catch (err) {
    console.error('ai-layouts/spec/test failed:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'spec generation failed' });
  }
});

module.exports = router;
