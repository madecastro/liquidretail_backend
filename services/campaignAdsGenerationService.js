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
const mongoose = require('mongoose');

const Campaign              = require('../models/Campaign');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Ad                    = require('../models/Ad');
const registry              = require('./templateRegistry');

// Cast a string/ObjectId to ObjectId. Required when querying
// metadata.catalogProductId (Mixed type) — Mongoose doesn't auto-cast
// inside Mixed, so string from req.body won't match the stored ObjectId.
function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
}

const SUPPORTED_TEMPLATES = new Set([
  'testimonial_spotlight',
  'ugc_split_screen',
  'testimonial_overlay',
  'product_overlay'
]);

// Per-template variant whitelist. Some templates are inherently UGC
// (the design IS a creator quote over a real-world photo) and don't
// make sense for a catalog hero shot; others work for either source.
// Cartesian is filtered by this map so we don't queue combos that
// will look obviously wrong.
const TEMPLATE_SUPPORTS_VARIANT = {
  testimonial_spotlight: new Set(['ugc', 'product_image']),
  ugc_split_screen:      new Set(['ugc', 'product_image']),
  testimonial_overlay:   new Set(['ugc']),                       // creator quote over UGC photo — needs UGC source
  product_overlay:       new Set(['ugc', 'product_image'])
};

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
      // Drop combos where the seed's variantKind isn't supported by the
      // template. e.g. testimonial_overlay is UGC-only — product_image
      // seeds for it would queue and then fail/look wrong at render.
      const supports = TEMPLATE_SUPPORTS_VARIANT[cell.templateId];
      if (supports && !supports.has(seed.variantKind)) continue;
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
    .filter(isMediaEligibleByContentNature)
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
// iterate Media.matchedProducts to emit ONE seed per matched product
// (across ALL match tiers — not just the latest PMA's product). When
// the media has no product matches at all (or none with a catalog
// FK), fall back to a single brand_match seed so the operator's
// explicit pick still produces an ad.
async function seedsFromMedia(brandId, mediaId) {
  const media = await Media.findById(mediaId)
    .select('matchedProducts adSuitability fileType classification')
    .lean();
  if (!media) return [];
  // Operator-driven path: when the wizard hands us a specific mediaId
  // they ALREADY picked, trust the pick and bypass the content-nature
  // gate. The gate is for inventory pulls (brand-only, brand-match
  // fallback) where the operator hasn't seen the post.
  const fileType = media.fileType;
  const score    = media.adSuitability?.score ?? null;

  const productMatches = (media.matchedProducts || []).filter(mp => mp.catalogProductId);
  if (!productMatches.length) {
    return [{
      productId:        null,
      mediaId:          String(mediaId),
      matchTier:        'brand_match',
      variantKind:      'ugc',
      fileType,
      suitabilityScore: score
    }];
  }

  return productMatches.map(mp => ({
    productId:        String(mp.catalogProductId),
    mediaId:          String(mediaId),
    matchTier:        mp.outcome === 'product_match' ? 'product_match' : 'product_category',
    variantKind:      'ugc',
    fileType,
    suitabilityScore: score
  }));
}

// Product-driven (catalog entry / wizard Step 2). Operator picked a
// productId. Pulls every matched media across product_match +
// product_category tiers from CatalogProduct.matchedMedia[] (the
// denormalized mirror written by detect), unions in brand_match
// media for the brand (intentionally NOT denormalized — it isn't
// per-product), and emits one product_image seed for the catalog
// product's own hero.
async function seedsFromProduct(brandId, productId) {
  const seeds = [];

  const product = await CatalogProduct.findById(productId)
    .select('matchedMedia')
    .lean();

  // Tiers 1 + 2 — product_match + product_category from the
  // denormalized mirror. Bulk-load the referenced Media docs so we
  // can score by adSuitability + grab fileType. Content-nature filter
  // excludes promotional / announcement UGC (sale-of-the-week,
  // "coming soon" teasers) — they read as stale ad inserts once the
  // offer/date passes.
  if (product?.matchedMedia?.length) {
    const mediaIds = Array.from(new Set(product.matchedMedia.map(mm => String(mm.mediaId))));
    const medias = await loadMediasForScoring(mediaIds);
    const mediaById = new Map(medias.map(m => [String(m._id), m]));
    for (const mm of product.matchedMedia) {
      const media = mediaById.get(String(mm.mediaId));
      if (!media) continue;
      if (!isMediaEligibleByContentNature(media)) continue;
      seeds.push({
        productId:        String(productId),
        mediaId:          String(mm.mediaId),
        matchTier:        mm.matchTier,
        variantKind:      'ugc',
        fileType:         media.fileType,
        suitabilityScore: media.adSuitability?.score ?? null
      });
    }
  }

  // Tier 3 — brand_match fallback: tag the productId onto brand media
  // so the ad is still attributed for CTA/tracking. Not denormalized
  // on CatalogProduct (would require writing every brand_match media
  // to every product in the brand), so this stays a PMA query.
  const brandMatches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'brand_match'
  }).select('mediaId').lean();
  const brandMatchMediaIds = Array.from(new Set(brandMatches.map(m => String(m.mediaId))));
  if (brandMatchMediaIds.length) {
    const medias = await loadMediasForScoring(brandMatchMediaIds);
    for (const m of medias) {
      if (!isMediaEligibleByContentNature(m)) continue;
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

  // Tier 0 — product_image: pick the BEST catalog Media as the visual
  // hero. Meta's image_url (imageRole='hero') is whatever the merchant
  // listed first, often a clean studio shot. For ad creative we'd
  // rather lead with a lifestyle / on-model shot when one exists, with
  // the clean product shot serving the product.image inset slot
  // (handled by layoutInputService.loadContext). Ranking falls back to
  // imageRole when shotType is missing (legacy rows).
  const productOid = toObjectId(productId);
  const catalogMedias = productOid ? await Media.find({
    source: 'catalog-product',
    'metadata.catalogProductId': productOid
  }).select('_id fileType adSuitability classification metadata.imageRole').lean() : [];
  const chosen = pickProductImageHero(catalogMedias);
  if (chosen) {
    seeds.push({
      productId:        String(productId),
      mediaId:          String(chosen._id),
      matchTier:        'product_match',     // the product IS the SKU here
      variantKind:      'product_image',
      fileType:         chosen.fileType,
      suitabilityScore: chosen.adSuitability?.score ?? null
    });
  }

  return seeds;
}

// Pick the catalog Media most suited to be the visual hero of a
// product_image ad. Preference order:
//   1. lifestyle      product in real-world context (story-friendly)
//   2. on_model       human element draws engagement
//   3. flat_lay       contextual but flatter than lifestyle
//   4. unknown / no classification — assume hero candidate
//   5. product_only   clean studio shot — works but reads as catalog
//   6. detail         close-up / partial product
//   7. packaging      worst for hero
// Within a rank, prefer imageRole='hero' (the merchant's primary
// listing). Returns the chosen Media doc or null when the list is empty.
function pickProductImageHero(medias) {
  if (!Array.isArray(medias) || !medias.length) return null;
  const RANK = {
    lifestyle:    1,
    on_model:     2,
    flat_lay:     3,
    unknown:      4,
    product_only: 5,
    detail:       6,
    packaging:    7
  };
  const ranked = medias.slice().sort((a, b) => {
    const ra = RANK[a.classification?.shotType] ?? RANK.unknown;
    const rb = RANK[b.classification?.shotType] ?? RANK.unknown;
    if (ra !== rb) return ra - rb;
    // Tiebreak: merchant's primary listing wins
    const ahero = (a.metadata?.imageRole === 'hero') ? 0 : 1;
    const bhero = (b.metadata?.imageRole === 'hero') ? 0 : 1;
    return ahero - bhero;
  });
  return ranked[0];
}

// ── Helpers ──────────────────────────────────────────────────────────

async function loadMediasForScoring(mediaIds) {
  if (!mediaIds.length) return [];
  return Media.find({ _id: { $in: mediaIds } })
    .select('_id adSuitability fileType classification')
    .lean();
}

// Time-bound posts (sale-of-the-week, "coming soon" teasers, holiday
// promos) make terrible evergreen ad inserts — they reference dates
// or offers that have passed by the time the ad runs. subjectTextService
// classifies each Media into evergreen / promotional / announcement /
// unknown; this gate excludes promotional + announcement when the
// classifier is confident enough. unknown + low-confidence calls fall
// through to inclusion so a flaky classifier doesn't starve the queue.
const CONTENT_NATURE_BLOCK_THRESHOLD = 0.7;
function isMediaEligibleByContentNature(media) {
  const nature = media?.classification?.contentNature;
  if (!nature || nature === 'evergreen' || nature === 'unknown') return true;
  const conf = media?.classification?.contentNatureConfidence;
  if (typeof conf === 'number' && conf >= CONTENT_NATURE_BLOCK_THRESHOLD) {
    return false;
  }
  return true;
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
