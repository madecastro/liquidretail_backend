// Executor for capability aiCanvas.testSpec (Tier 2, brand scope).
//
// Generate + cache an AI canvas spec for one Media at a given aspect
// ratio + creative style. Mirrors POST /api/ai-layouts/spec/test — the
// underlying aiCanvasSpecService.getOrGenerate call fires an LLM
// (Sonnet) so this is NOT a pure read; billable and Tier 2 gated.
// Idempotent on the (mediaId, template, aspectRatio, productId,
// variantKind, paletteSource) partition — a cached artifact returns
// with cached:true; refresh=true forces a re-derive.

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');

// Kept in sync with aiCanvasSpecService.CREATIVE_STYLES. Duplicated
// here rather than dynamically imported to keep the args-enum stable
// at registry-load time. Verifier's schema conversion runs before any
// service imports.
const CREATIVE_STYLES = ['brand_led', 'ugc_led', 'editorial'];
const ASPECT_RATIOS   = ['1:1', '4:5', '9:16'];
const DEFAULT_SOURCE_TEMPLATE = 'ugc_split_screen';

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }
  const creativeStyle = args?.creativeStyle || 'brand_led';
  if (!CREATIVE_STYLES.includes(creativeStyle)) {
    return { ok: false, error: `creativeStyle must be one of: ${CREATIVE_STYLES.join(', ')}` };
  }
  const aspectRatio = args?.aspectRatio || '1:1';
  if (!ASPECT_RATIOS.includes(aspectRatio)) {
    return { ok: false, error: `aspectRatio must be one of: ${ASPECT_RATIOS.join(', ')}` };
  }
  const productId = args?.productId != null ? String(args.productId) : null;
  if (productId && !mongoose.isValidObjectId(productId)) {
    return { ok: false, error: `productId "${productId}" is not a valid ObjectId` };
  }
  const refresh = !!args?.refresh;

  const media = await Media.findOne({ _id: rawMediaId, advertiserId: req.advertiserId })
    .select('_id brandId advertiserId deletedAt')
    .lean();
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };
  if (media.deletedAt) return { ok: false, error: 'media is soft-deleted' };

  const { buildLayoutInput } = require('../layoutInputService');
  const { getOrGenerate } = require('../aiCanvasSpecService');

  const input = await buildLayoutInput({
    mediaId:     media._id,
    template:    DEFAULT_SOURCE_TEMPLATE,
    aspectRatio,
    options: { productId, variantKind: null, paletteSource: 'media' },
    refresh: false
  });

  const result = await getOrGenerate({
    input,
    template:     `ai_${creativeStyle}`,
    aspectRatio,
    creativeStyle,
    mediaId:      media._id,
    productId,
    variantKind:  null,
    paletteSource: 'media',
    advertiserId: media.advertiserId,
    brandId:      media.brandId,
    refresh
  });

  return {
    ok: true,
    kind: 'canvasSpec',
    data: {
      artifactId:    String(result.artifactId),
      mediaId:       String(media._id),
      brandId:       media.brandId ? String(media.brandId) : null,
      template:      `ai_${creativeStyle}`,
      aspectRatio,
      creativeStyle,
      cached:        !!result.cached,
      warnings:      result.warnings || [],
      // Return only the spec's top-level metadata — the full spec + input
      // can be blob-large. Consumers who need the whole thing can hit
      // GET /api/ai-layouts/spec/by-artifact/:id via the artifactId.
      specSummary: {
        canvasSize:  result.spec?.canvas || null,
        elementCount: Array.isArray(result.spec?.elements) ? result.spec.elements.length : null,
        hasStyleBindings: !!result.spec?.style_bindings
      },
      note: refresh ? 'Fresh generate (refresh=true). Cached artifact was invalidated.' : (result.cached ? 'Cache hit — returned existing artifact.' : 'Fresh generate — no cached artifact matched.')
    }
  };
}

module.exports = { run };
