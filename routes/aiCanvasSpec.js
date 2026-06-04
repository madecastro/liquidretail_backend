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
const mongoose = require('mongoose');

const { buildLayoutInput } = require('../services/layoutInputService');
const { getOrGenerate, CREATIVE_STYLES } = require('../services/aiCanvasSpecService');
const { assertMediaInTenant } = require('../middleware/tenantHelpers');
const Media             = require('../models/Media');
const AiCanvasArtifact  = require('../models/AiCanvasArtifact');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');

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

// GET /api/ai-layouts/spec/by-artifact/:id
// Returns the stored canvas spec + the canonical layout input ready
// for the renderer. The preview page hits this on load to get
// everything drawTpCanvas needs. Tenant-scoped via advertiserId on
// the artifact.
router.get('/by-artifact/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'invalid artifact id' });
    }
    const filter = { _id: req.params.id };
    if (req.advertiserId) filter.advertiserId = new mongoose.Types.ObjectId(req.advertiserId);
    const art = await AiCanvasArtifact.findOne(filter).lean();
    if (!art) return res.status(404).json({ error: 'artifact not found' });

    // Re-fetch the canonical input artifact (or rebuild) using the
    // same partition key. We borrow ugc_split_screen as the source
    // template — same approach the test endpoint uses; the input
    // shape is template-independent.
    const inputArt = await LayoutInputArtifact.findOne({
      mediaId:             art.mediaId,
      template:            'ugc_split_screen',
      aspectRatio:         art.aspectRatio,
      productId:           art.productId,
      variantKind:         art.variantKind,
      campaignContextHash: art.campaignContextHash,
      paletteSource:       art.paletteSource
    }).lean();

    let input = inputArt?.input || null;
    if (!input) {
      input = await buildLayoutInput({
        mediaId:     art.mediaId,
        template:    'ugc_split_screen',
        aspectRatio: art.aspectRatio,
        options: {
          productId:     art.productId,
          variantKind:   art.variantKind,
          paletteSource: art.paletteSource
        },
        refresh: false
      });
    }

    // Resolve the spec's style_bindings against the input. The AI
    // spec uses the simpler flat shape "name": "path.to.value" — walk
    // each entry; hex literals (starting with '#') pass through,
    // dotted paths read from input. Anything unresolved is dropped
    // so the renderer falls back to its CSS defaults.
    const resolvedBindings = resolveAiSpecBindings(art.canvasSpec?.style_bindings || {}, input);

    res.json({
      artifactId:        String(art._id),
      mediaId:           String(art.mediaId),
      template:          art.template,
      creativeStyle:     art.creativeStyle,
      aspectRatio:       art.aspectRatio,
      productId:         art.productId ? String(art.productId) : null,
      variantKind:       art.variantKind,
      paletteSource:     art.paletteSource,
      spec:              art.canvasSpec,
      input,
      resolvedBindings,
      rationale:         art.rationale,
      elementsUsed:      art.elementsUsed,
      elementsSkipped:   art.elementsSkipped,
      hierarchySpec:     art.hierarchySpec || art.canvasSpec?.hierarchy_spec || null,
      // Phase 1 shadow — Creative Director artifact for (brandId, productId).
      // Looked up by recent-most match; not coupled to this specific
      // AiCanvasArtifact yet. Phase 2 will reference by concept_id.
      creativeDirection: await loadShadowCreativeDirection(art),
      validationWarnings: art.validationWarnings || [],
      // Full prompt — system block, user block (FULL CONTEXT JSON +
      // intent + vision-input list), and the image attachment URLs that
      // were passed alongside as image_url parts. Older artifacts
      // (pre-prompt-persistence) return null/[] here.
      promptSystem:      art.promptSystem || null,
      promptUser:        art.promptUser || null,
      promptImages:      art.promptImages || [],
      createdAt:         art.createdAt
    });
  } catch (err) {
    console.error('ai-layouts/spec/by-artifact failed:', err);
    res.status(500).json({ error: err.message || 'fetch failed' });
  }
});

function resolveAiSpecBindings(bindings, input) {
  const out = {};
  for (const [name, raw] of Object.entries(bindings || {})) {
    if (typeof raw !== 'string') continue;
    if (raw.startsWith('#')) { out[name] = raw; continue; }
    const v = getInputPath(input, raw);
    if (v != null && v !== '') out[name] = v;
  }
  return out;
}

function getInputPath(obj, path) {
  if (!obj || typeof path !== 'string') return null;
  return path.split('.').reduce((acc, k) => (acc == null ? null : acc[k]), obj);
}

// Load the CreativeDirectionArtifact that informed this AiCanvasArtifact.
//
//   Phase 2: if art.directionArtifactId is set, fetch that one exactly +
//   highlight which concept was used (matching art.directionConceptId).
//   Phase 1 fallback: art has no Director reference → look up the most
//   recent matching (brandId, productId) artifact as "what the Director
//   would have picked." Useful for V1 ads before Phase 2 cutover.
async function loadShadowCreativeDirection(art) {
  try {
    if (!art?.brandId) return null;
    const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
    let direction = null;
    let pickedConceptId = art.directionConceptId || null;
    if (art.directionArtifactId) {
      direction = await CreativeDirectionArtifact.findById(art.directionArtifactId).lean();
    }
    if (!direction) {
      const filter = { brandId: art.brandId };
      if (art.productId) filter.productId = art.productId;
      direction = await CreativeDirectionArtifact
        .findOne(filter)
        .sort({ createdAt: -1 })
        .lean();
    }
    if (!direction) return null;
    return {
      artifactId:    String(direction._id),
      cacheKey: {
        brandId:        direction.brandId    ? String(direction.brandId)    : null,
        productId:      direction.productId  ? String(direction.productId)  : null,
        campaignKind:   direction.campaignKind   || null,
        creativeIntent: direction.creativeIntent || null
      },
      pickedConceptId,                // null on V1 ads
      consumedByThisArtifact: !!art.directionArtifactId,
      inputSummary:        direction.inputSummary,
      availableArchetypes: direction.availableArchetypes,
      concepts:            direction.concepts,
      modelId:             direction.modelId,
      validationWarnings:  direction.validationWarnings || [],
      createdAt:           direction.createdAt
    };
  } catch (err) {
    console.warn(`   ⚠️  loadShadowCreativeDirection: ${err.message}`);
    return null;
  }
}

module.exports = router;
