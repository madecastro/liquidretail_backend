// Campaign → Queue expansion. Single entry point: the Generate Ads
// wizard. Takes operator selections + the chosen campaign, expands
// to ALL viable (product × media × template × ratio × variant)
// combinations, and persists each as a queued Ad doc.
//
// The render run then picks the top N from the queued inventory by
// readinessScore — leftover queued ads stay for subsequent
// "render more from this campaign" passes.
//
// Seed rules (per operator pick):
//
//   1. No picks (brand-only):
//      → every brand_match media (capped by BRAND_ONLY_MEDIA_LIMIT)
//        emits a `ugc` variant seed with productId:null and
//        matchTier='brand_only'.
//
//   2. mediaIds (media-driven, library entry):
//      → for each media, dispatch by ProductMatchArtifact.outcome:
//          product_match    → one ugc seed featuring match.catalogProductId,
//                             matchTier='product_match'
//          product_category → one ugc seed per recommendedProduct,
//                             matchTier='product_category'
//          brand_match      → one ugc seed with productId:null,
//                             matchTier='brand_match'
//          (no PMA)         → fall back to brand_match
//
//   3. productIds (product-driven, catalog entry):
//      → for each productId, gather EVERY matched media:
//          all product_match media   → ugc seeds, matchTier='product_match'
//          all product_category media (where this product is in
//             recommendedProducts) → ugc seeds, matchTier='product_category'
//          all brand_match media (productId attached for tracking)
//                                  → ugc seeds, matchTier='brand_match'
//        Plus ONE product_image seed per product — uses the catalog
//        product's hero Media doc as the media slot, productId set,
//        matchTier inherits 'product_match' (the product IS the SKU).
//
// Cartesian expansion across seeds × allowedTemplates × ratios is
// then bulk-inserted; per-campaign unique index on identityDigest
// rejects duplicates so this is idempotent (re-running with the
// same picks doesn't double-queue).

const crypto = require('crypto');

const Campaign              = require('../models/Campaign');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Ad                    = require('../models/Ad');
const registry              = require('./templateRegistry');

const SUPPORTED_TEMPLATES = new Set([
  'testimonial_spotlight',
  'ugc_split_screen',
  'testimonial_overlay',
  'product_overlay'
]);

// Aspect ratios we're shipping ad output for in V1.
const SHIPPING_RATIOS = new Set(['1:1', '9:16', '16:9']);

// Brand-only inventory cap. Without picks, this limits how many of
// the brand's brand_match media get pulled into the queue.
const BRAND_ONLY_MEDIA_LIMIT = 25;

// Readiness scoring weights — match tier carries the lion's share of
// signal. adSuitability is per-media quality; tier weight is per-
// (media,product) match quality. Combined multiplicatively.
const TIER_WEIGHTS = {
  product_match:    1.0,
  product_category: 0.8,
  brand_match:      0.6,
  brand_only:       0.5
};

// Catalog product images don't carry a meaningful Media.adSuitability
// (the score is tuned for UGC composition signals — face/subject
// quality, scene density, etc.). Use a fixed quality assumption.
const PRODUCT_IMAGE_QUALITY = 0.7;

// Video media is consistently subpar for static ad output. Skip the
// adSuitability lookup entirely and leave readinessScore null so the
// selection query (sorted desc) ranks videos LAST.
function readinessScoreFor(matchTier, fileType, adSuitabilityScore) {
  if (fileType === 'video') return null;
  const tier = TIER_WEIGHTS[matchTier] ?? 0.5;
  const quality = adSuitabilityScore ?? 0.5;
  return Number((tier * quality).toFixed(4));
}

function readinessScoreForProductImage(matchTier) {
  const tier = TIER_WEIGHTS[matchTier] ?? 0.5;
  return Number((tier * PRODUCT_IMAGE_QUALITY).toFixed(4));
}

// sha256 over the identity inputs that uniquely define an Ad in the
// queue. Same digest on the same campaign = same Ad = unique index
// rejects the duplicate insert.
function computeIdentityDigest({ campaignId, productId, mediaId, template, aspectRatio, variantKind, ctaText, ctaUrl, ctaUrlParams }) {
  const payload = JSON.stringify({
    campaignId:   String(campaignId),
    productId:    productId ? String(productId) : null,
    mediaId:      String(mediaId),
    template,
    aspectRatio,
    variantKind,
    ctaText:      String(ctaText || ''),
    ctaUrl:       String(ctaUrl  || ''),
    ctaUrlParams: String(ctaUrlParams || '')
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ── Public API ───────────────────────────────────────────────────────

// Expand the wizard payload into queued Ad docs.
// Returns:
//   {
//     campaignId, brandId, campaignKind,
//     queuedCount,        — total Ad docs in this campaign with status='queued' after this call
//     newlyQueued,        — number of new docs inserted by THIS call
//     alreadyQueued,      — number of combinations that were already queued
//     newAdIds            — ObjectIds of the docs newly inserted (for immediate selection)
//   }
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
  const allowedTemplates = templateIds.filter(t => SUPPORTED_TEMPLATES.has(t));
  if (!allowedTemplates.length) {
    throw new Error(`No supported templates in selection. V1 supports: ${Array.from(SUPPORTED_TEMPLATES).join(', ')}`);
  }

  const ctaText      = String(cta.text || '');
  const ctaUrl       = String(cta.url  || '');
  const ctaUrlParams = String(urlParams || '').replace(/^[?&]/, '');

  // ── 1. Build seeds — flat list of {productId, mediaId, matchTier, variantKind, suitabilityScore, fileType} ──
  const useBrandOnly = productIds.length === 0 && mediaIds.length === 0;
  let seeds = [];

  if (useBrandOnly) {
    seeds = await seedFromBrandOnly(brandId, BRAND_ONLY_MEDIA_LIMIT);
  } else {
    for (const mediaId of mediaIds) {
      const mediaSeeds = await seedsFromMedia(brandId, mediaId);
      seeds.push(...mediaSeeds);
    }
    for (const productId of productIds) {
      const productSeeds = await seedsFromProduct(brandId, productId);
      seeds.push(...productSeeds);
    }
  }

  // Dedup by (productId|null, mediaId, variantKind) — picking the
  // same product via both library + catalog paths shouldn't queue
  // it twice in this pass. (Cross-pass dedup is handled by the
  // unique index at insert time.)
  seeds = dedupeSeeds(seeds);

  // ── 2. Cartesian: seeds × allowedTemplates × (template ratios ∩ SHIPPING_RATIOS) ──
  const grid = [];
  for (const templateId of allowedTemplates) {
    const tpl = registry.getNormalized(templateId);
    if (!tpl) continue;
    const ratios = (tpl.aspect_ratios?.supported || [])
      .filter(r => SHIPPING_RATIOS.has(r));
    for (const aspectRatio of ratios) {
      grid.push({ templateId, aspectRatio });
    }
  }

  const payloads = [];
  for (const seed of seeds) {
    for (const cell of grid) {
      const identityDigest = computeIdentityDigest({
        campaignId,
        productId:    seed.productId,
        mediaId:      seed.mediaId,
        template:     cell.templateId,
        aspectRatio:  cell.aspectRatio,
        variantKind:  seed.variantKind,
        ctaText, ctaUrl, ctaUrlParams
      });
      const readinessScore = seed.variantKind === 'product_image'
        ? readinessScoreForProductImage(seed.matchTier)
        : readinessScoreFor(seed.matchTier, seed.fileType, seed.suitabilityScore);
      payloads.push({
        brandId,
        campaignId,
        campaignRunId:  null,
        mediaId:        seed.mediaId,
        productId:      seed.productId,
        template:       cell.templateId,
        aspectRatio:    cell.aspectRatio,
        campaignKind,
        matchTier:      seed.matchTier,
        variantKind:    seed.variantKind,
        readinessScore,
        status:         'queued',
        identityDigest,
        ctaText, ctaUrl, ctaUrlParams,
        queuedAt:       new Date(),
        generatedAt:    new Date()
      });
    }
  }

  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: []
    };
  }

  // ── 3. Bulk insert — { ordered: false } so dup-key errors per
  // (campaignId, identityDigest) don't abort the rest of the batch.
  let inserted = [];
  try {
    inserted = await Ad.insertMany(payloads, { ordered: false });
  } catch (err) {
    // BulkWriteError carries successful inserts in result.insertedIds
    // alongside writeErrors[]. Extract the successes and continue.
    if (err.writeErrors && err.result?.insertedIds) {
      const insertedIds = err.result.insertedIds || {};
      inserted = Object.values(insertedIds);
      // Re-fetch to get full docs (insertedIds is just IDs, not docs)
      if (inserted.length) {
        inserted = await Ad.find({ _id: { $in: inserted } }).lean();
      }
    } else if (err.code === 11000) {
      // Single-doc dup — nothing inserted
      inserted = [];
    } else {
      throw err;
    }
  }

  const newAdIds = inserted.map(d => String(d._id || d));
  const alreadyQueued = payloads.length - newAdIds.length;
  const queuedCount = await Ad.countDocuments({ campaignId, status: 'queued' });

  console.log(
    `📦 expandWizardJob: campaign=${campaignId} seeds=${seeds.length} cartesian=${payloads.length} ` +
    `newlyQueued=${newAdIds.length} alreadyQueued=${alreadyQueued} totalQueued=${queuedCount}`
  );

  return {
    campaignId: String(campaignId),
    brandId,
    campaignKind,
    queuedCount,
    newlyQueued: newAdIds.length,
    alreadyQueued,
    newAdIds,
    cta: { text: ctaText, url: ctaUrl, params: ctaUrlParams },
    requestedBy
  };
}

// Selection — "next N queued ads for this campaign, ranked by
// readinessScore desc (videos with null score sort last, FIFO by
// queuedAt as tiebreaker)." Returns Ad IDs (strings).
async function selectAdsForRun({ campaignId, limit }) {
  const rows = await Ad.find({ campaignId, status: 'queued' })
    .sort({ readinessScore: -1, queuedAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();
  return rows.map(r => String(r._id));
}

// ── Seed builders ────────────────────────────────────────────────────

// Brand-only mode — pull all brand_match media for this brand, rank
// by suitability, take top N. productId stays null.
async function seedFromBrandOnly(brandId, topN) {
  const matches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'brand_match'
  }).select('mediaId').lean();
  if (!matches.length) return [];
  const mediaIds = Array.from(new Set(matches.map(m => String(m.mediaId))));
  const medias = await loadMediasForScoring(mediaIds);
  const ranked = medias
    .sort((a, b) => (b.adSuitability?.score ?? -1) - (a.adSuitability?.score ?? -1))
    .slice(0, topN);
  return ranked.map(m => ({
    productId:        null,
    mediaId:          String(m._id),
    matchTier:        'brand_only',
    variantKind:      'ugc',
    fileType:         m.fileType,
    suitabilityScore: m.adSuitability?.score ?? null
  }));
}

// Media-driven (library entry). Operator picked a specific media —
// dispatch by its PMA outcome. Emits 0..N seeds (a product_category
// outcome with multiple recommendedProducts emits one seed per
// product, all sharing the same mediaId).
async function seedsFromMedia(brandId, mediaId) {
  const match = await ProductMatchArtifact.findOne({ mediaId })
    .sort({ createdAt: -1 })
    .lean();
  const media = await Media.findById(mediaId).select('adSuitability fileType').lean();
  if (!media) return [];
  const fileType = media.fileType;
  const score    = media.adSuitability?.score ?? null;

  const brandFallback = {
    productId:        null,
    mediaId:          String(mediaId),
    matchTier:        'brand_match',
    variantKind:      'ugc',
    fileType,
    suitabilityScore: score
  };

  if (!match) return [brandFallback];

  switch (match.outcome) {
    case 'product_match':
      if (!match.catalogProductId) return [brandFallback];
      return [{
        productId:        String(match.catalogProductId),
        mediaId:          String(mediaId),
        matchTier:        'product_match',
        variantKind:      'ugc',
        fileType,
        suitabilityScore: score
      }];
    case 'product_category': {
      const recs = Array.isArray(match.recommendedProducts) ? match.recommendedProducts : [];
      if (!recs.length) {
        const sibling = await firstCategorySibling(brandId, match.categoryId);
        if (!sibling) return [brandFallback];
        return [{
          productId:        String(sibling._id),
          mediaId:          String(mediaId),
          matchTier:        'product_category',
          variantKind:      'ugc',
          fileType,
          suitabilityScore: score
        }];
      }
      return recs
        .map(r => r._id || r.id || r.catalogProductId)
        .filter(Boolean)
        .map(pid => ({
          productId:        String(pid),
          mediaId:          String(mediaId),
          matchTier:        'product_category',
          variantKind:      'ugc',
          fileType,
          suitabilityScore: score
        }));
    }
    case 'brand_match':
      return [brandFallback];
    default:
      // 'no_products', 'do_not_use', or unknown — honor the pick as brand content.
      return [brandFallback];
  }
}

// Product-driven (catalog entry / wizard Step 2). Operator picked a
// productId. Gather EVERY matched media across all match tiers PLUS
// emit one product_image seed for the catalog product's own hero.
async function seedsFromProduct(brandId, productId) {
  const seeds = [];

  // Tier 1 — product_match: media whose PMA points directly at this product.
  const productMatches = await ProductMatchArtifact.find({
    brandId,
    catalogProductId: productId,
    outcome: 'product_match'
  }).select('mediaId').lean();
  const productMatchMediaIds = Array.from(new Set(productMatches.map(m => String(m.mediaId))));
  if (productMatchMediaIds.length) {
    const medias = await loadMediasForScoring(productMatchMediaIds);
    for (const m of medias) {
      seeds.push({
        productId:        String(productId),
        mediaId:          String(m._id),
        matchTier:        'product_match',
        variantKind:      'ugc',
        fileType:         m.fileType,
        suitabilityScore: m.adSuitability?.score ?? null
      });
    }
  }

  // Tier 2 — product_category: media whose PMA has this product in
  // recommendedProducts[]. Mongo array-element match by _id.
  const categoryMatches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'product_category',
    'recommendedProducts._id': productId
  }).select('mediaId').lean();
  const categoryMediaIds = Array.from(new Set(categoryMatches.map(m => String(m.mediaId))));
  if (categoryMediaIds.length) {
    const medias = await loadMediasForScoring(categoryMediaIds);
    for (const m of medias) {
      seeds.push({
        productId:        String(productId),
        mediaId:          String(m._id),
        matchTier:        'product_category',
        variantKind:      'ugc',
        fileType:         m.fileType,
        suitabilityScore: m.adSuitability?.score ?? null
      });
    }
  }

  // Tier 3 — brand_match fallback: tag the productId onto brand media
  // so the ad is still attributed to the product for CTA/tracking.
  const brandMatches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'brand_match'
  }).select('mediaId').lean();
  const brandMatchMediaIds = Array.from(new Set(brandMatches.map(m => String(m.mediaId))));
  if (brandMatchMediaIds.length) {
    const medias = await loadMediasForScoring(brandMatchMediaIds);
    for (const m of medias) {
      seeds.push({
        productId:        String(productId),
        mediaId:          String(m._id),
        matchTier:        'brand_match',
        variantKind:      'ugc',
        fileType:         m.fileType,
        suitabilityScore: m.adSuitability?.score ?? null
      });
    }
  }

  // Tier 0 — product_image: use the catalog product's hero Media as
  // the visual slot. Find the catalog-product Media doc tied to this
  // CatalogProduct (imageRole='hero', source='catalog-product').
  const heroMedia = await Media.findOne({
    source: 'catalog-product',
    'metadata.catalogProductId': productId,
    'metadata.imageRole': 'hero'
  }).select('_id fileType adSuitability').lean();
  if (heroMedia) {
    seeds.push({
      productId:        String(productId),
      mediaId:          String(heroMedia._id),
      matchTier:        'product_match',     // the product IS the SKU here
      variantKind:      'product_image',
      fileType:         heroMedia.fileType,
      suitabilityScore: heroMedia.adSuitability?.score ?? null
    });
  }

  return seeds;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function loadMediasForScoring(mediaIds) {
  if (!mediaIds.length) return [];
  return Media.find({ _id: { $in: mediaIds } })
    .select('_id adSuitability fileType')
    .lean();
}

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
    const key = `${s.productId || 'NULL'}|${s.mediaId}|${s.variantKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

module.exports = {
  expandWizardJob,
  selectAdsForRun,
  computeIdentityDigest,
  SUPPORTED_TEMPLATES
};
