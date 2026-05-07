// Campaign → Render expansion. Single entry point: the Generate Ads
// wizard. Takes operator selections + the chosen campaign and emits a
// fully-resolved RenderCampaignJob the render service can iterate
// without making content/media decisions.
//
// Decision rules (mirrors the design ratified with the operator):
//
//   1. Branding campaign (campaign.kind === 'branding'):
//      → all creatives use brand_match media for brandId.
//      → productId on each creative is null.
//      → operator-picked products/media on the wizard payload are
//        IGNORED for selection purposes (they may still be tracked on
//        the campaign for analytics/CTA, but creative content is brand-only).
//
//   2. Promotional, no products + no media:
//      → fall through to brand-only path (same as branding).
//
//   3. Promotional, mediaIds present (library-entry deep-link):
//      → for each media, dispatch by ProductMatchArtifact.outcome:
//          product_match    → feature match.catalogProductId
//          product_category → feature first match.recommendedProducts[]
//                             entry (already-attached siblings)
//          brand_match      → productId: null
//      → mediaSource on the creative records WHICH rung supplied the
//        media so the render service can tag the resulting Ad doc.
//
//   4. Promotional, productIds present (catalog-entry / wizard Step 2):
//      → for each productId, simpler cascade:
//          product_match media for THIS productId → top-suitability winner
//          else                                   → brand_match media
//      → category_match is NOT auto-fallback in this path; that's
//        reserved for path (3) where the operator chose the media.
//
//   5. Both mediaIds and productIds: union — each contributes
//      creatives independently.
//
// campaignKind is always threaded through the resulting job so
// downstream derivation can flip to brand-mode copy regardless of
// whether a productId is set on a given creative.

const Campaign              = require('../models/Campaign');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const registry              = require('./templateRegistry');

// Templates currently shipping. Render service only handles these in V1
// (per the deferred render-service plan saved 2026-05-06).
const SUPPORTED_TEMPLATES = new Set([
  'testimonial_spotlight',
  'ugc_split_screen',
  'testimonial_overlay',
  'product_overlay'
]);

const DEFAULT_TOP_MEDIA_PER_PRODUCT = 1;
const BRAND_ONLY_MEDIA_LIMIT        = 5; // when no products are selected

// ── Public API ───────────────────────────────────────────────────────

async function expandWizardJob({
  campaignId,
  productIds   = [],
  mediaIds     = [],
  templateIds  = [],
  cta          = {},
  urlParams    = '',
  requestedBy  = null
}) {
  if (!campaignId) throw new Error('campaignId required');

  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

  const brandId      = String(campaign.brandId);
  const campaignKind = campaign.kind || 'promotional';
  const isBranding   = campaignKind === 'branding';
  const allowedTemplates = templateIds.filter(t => SUPPORTED_TEMPLATES.has(t));

  if (!allowedTemplates.length) {
    throw new Error(`No supported templates in selection. V1 supports: ${Array.from(SUPPORTED_TEMPLATES).join(', ')}`);
  }

  // ── 1. Build creative seeds ({productId, mediaId, mediaSource}) ──
  let seeds = [];

  const useBrandOnly = isBranding || (productIds.length === 0 && mediaIds.length === 0);

  if (useBrandOnly) {
    seeds = await seedFromBrandOnly(brandId, BRAND_ONLY_MEDIA_LIMIT);
  } else {
    // Library-entry: each operator-picked media → seed via match outcome.
    for (const mediaId of mediaIds) {
      const seed = await seedFromMedia(brandId, mediaId);
      if (seed) seeds.push(seed);
    }
    // Catalog/wizard-entry: each operator-picked product → cascade.
    for (const productId of productIds) {
      const productSeeds = await seedsFromProduct(brandId, productId, DEFAULT_TOP_MEDIA_PER_PRODUCT);
      seeds.push(...productSeeds);
    }
  }

  // De-dupe by (productId|null, mediaId) so picking the same media via
  // both library + catalog paths doesn't double-render.
  seeds = dedupeSeeds(seeds);

  // ── 2. Cartesian with templates × supportedAspectRatios ──────────
  const creatives = [];
  for (const seed of seeds) {
    const media = await Media.findById(seed.mediaId).select('fileType').lean();
    const expectedKind = media?.fileType === 'video' ? 'video' : 'image';
    for (const templateId of allowedTemplates) {
      const tpl = registry.getNormalized(templateId);
      if (!tpl) continue;
      const ratios = tpl.aspect_ratios?.supported || [];
      for (const aspectRatio of ratios) {
        creatives.push({
          productId:        seed.productId,
          mediaId:          seed.mediaId,
          mediaSource:      seed.mediaSource,
          suitabilityScore: seed.suitabilityScore,
          template:         templateId,
          aspectRatio,
          expectedKind
        });
      }
    }
  }

  return {
    campaignId:   String(campaign._id),
    brandId,
    campaignKind,
    requestedAt:  new Date().toISOString(),
    requestedBy,
    cta: {
      text:    String(cta.text || ''),
      url:     String(cta.url  || ''),
      params:  String(urlParams || '').replace(/^[?&]/, '')
    },
    creatives,
    options: {
      skipValidationFailures: true,
      refresh:                false,
      topMediaPerProduct:     DEFAULT_TOP_MEDIA_PER_PRODUCT
    }
  };
}

// ── Seed builders ────────────────────────────────────────────────────

// Path 1+2: brand-only mode. Pull all brand_match media for this brand,
// rank by suitability, take top N. productId is null.
async function seedFromBrandOnly(brandId, topN) {
  const matches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'brand_match'
  }).select('mediaId').lean();
  if (!matches.length) return [];
  const mediaIds = Array.from(new Set(matches.map(m => String(m.mediaId))));
  const ranked = await rankBySuitability(mediaIds, topN);
  return ranked.map(m => ({
    productId:        null,
    mediaId:          String(m._id),
    mediaSource:      'brand_match',
    suitabilityScore: m.adSuitability?.score ?? null
  }));
}

// Path 3: media-driven (library entry). Operator picked a specific media.
// Look up its match outcome to decide what product to feature.
async function seedFromMedia(brandId, mediaId) {
  const match = await ProductMatchArtifact.findOne({ mediaId })
    .sort({ createdAt: -1 })
    .lean();
  if (!match) return null;
  const media = await Media.findById(mediaId).select('adSuitability').lean();
  const score = media?.adSuitability?.score ?? null;

  switch (match.outcome) {
    case 'product_match':
      if (!match.catalogProductId) return null;
      return {
        productId:        String(match.catalogProductId),
        mediaId:          String(mediaId),
        mediaSource:      'product_match',
        suitabilityScore: score
      };
    case 'product_category': {
      // Feature the first attached recommendedProduct (a sibling SKU
      // already populated at match time). If recommendedProducts is
      // empty, fall through to a category lookup.
      const sibling = (Array.isArray(match.recommendedProducts) && match.recommendedProducts[0])
                    || await firstCategorySibling(brandId, match.categoryId);
      if (!sibling) return null;
      const siblingId = sibling._id || sibling.id || sibling.catalogProductId;
      if (!siblingId) return null;
      return {
        productId:        String(siblingId),
        mediaId:          String(mediaId),
        mediaSource:      'product_category',
        suitabilityScore: score
      };
    }
    case 'brand_match':
      return {
        productId:        null,
        mediaId:          String(mediaId),
        mediaSource:      'brand_match',
        suitabilityScore: score
      };
    default:
      return null; // do_not_use, unknown
  }
}

// Path 4: product-driven (catalog entry / wizard Step 2). Operator
// picked a productId. Try product_match media first; fall back to
// brand_match.
async function seedsFromProduct(brandId, productId, topN) {
  // product_match: matches whose catalogProductId === this productId.
  const productMatches = await ProductMatchArtifact.find({
    brandId,
    catalogProductId: productId,
    outcome: 'product_match'
  }).select('mediaId').lean();

  if (productMatches.length) {
    const mediaIds = Array.from(new Set(productMatches.map(m => String(m.mediaId))));
    const ranked = await rankBySuitability(mediaIds, topN);
    return ranked.map(m => ({
      productId:        String(productId),
      mediaId:          String(m._id),
      mediaSource:      'product_match',
      suitabilityScore: m.adSuitability?.score ?? null
    }));
  }

  // Fall through to brand_match — operator's productId stays attached
  // (we still want the ad to be tagged to that product for tracking +
  // CTA URL composition), but the visual content comes from brand
  // assets.
  const brandMatches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'brand_match'
  }).select('mediaId').lean();

  if (!brandMatches.length) return [];
  const mediaIds = Array.from(new Set(brandMatches.map(m => String(m.mediaId))));
  const ranked = await rankBySuitability(mediaIds, topN);
  return ranked.map(m => ({
    productId:        String(productId),
    mediaId:          String(m._id),
    mediaSource:      'brand_match',
    suitabilityScore: m.adSuitability?.score ?? null
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────

// Rank a list of mediaIds by adSuitability.score (desc, nulls last).
// Returns Media docs (not just IDs) so callers can attach the score to
// the seed. Limit applied AFTER sorting so the top-N actually get the
// best-scored docs.
async function rankBySuitability(mediaIds, topN) {
  if (!mediaIds.length) return [];
  const docs = await Media.find({ _id: { $in: mediaIds } })
    .select('_id adSuitability fileType')
    .lean();
  return docs
    .sort((a, b) => (b.adSuitability?.score ?? -1) - (a.adSuitability?.score ?? -1))
    .slice(0, topN);
}

// Fallback when ProductMatchArtifact.recommendedProducts is empty
// (older artifacts pre-Phase 1.7b). Pulls the first non-draft sibling
// CatalogProduct in the same category. Best-effort — returns null when
// no category is set.
async function firstCategorySibling(brandId, categoryId) {
  if (!categoryId) return null;
  return CatalogProduct.findOne({
    brandId,
    categoryRef: categoryId,
    draft: { $ne: true }
  }).select('_id title imageUrl').lean();
}

function dedupeSeeds(seeds) {
  const seen = new Set();
  const out = [];
  for (const s of seeds) {
    const key = `${s.productId || 'NULL'}|${s.mediaId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

module.exports = { expandWizardJob, SUPPORTED_TEMPLATES };
