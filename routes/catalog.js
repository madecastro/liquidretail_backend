// Phase 4 follow-up #3 — Catalog Browser routes.
//
// Brand-scoped (not integration-scoped, so manual + detect-identified
// products are accessible without an IG credential). Three endpoints:
//
//   GET /api/catalog               — paginated list scoped to ?brandId
//   GET /api/catalog/:id           — single product with all Phase 2f
//                                    fields (rating + reviews[] + specs +
//                                    sellers[] + reviewSummary) + the
//                                    detect-source Media when source =
//                                    'detect-identified'
//   GET /api/catalog/:id/matches   — list of Media that matched this
//                                    product, with the per-match
//                                    ProductMatchArtifact evidence
//                                    (cropped image, outcome, confidence)
//
// Tenant scoping via brandId membership in the current advertiser —
// CatalogProduct.advertiserId is the source of truth.

const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');

const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Category              = require('../models/Category');
const catalogProductPromoteService = require('../services/catalogProductPromoteService');
const { tenantFilter, assertMediaInTenant } = require('../middleware/tenantHelpers');
void assertMediaInTenant;     // kept for future :id verification helpers

function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Compact list row — enough for the sidebar thumbnail + chips.
function projectListRow(p, matchCount) {
  return {
    id:           String(p._id),
    externalId:   p.externalId,
    source:       p.source,
    draft:        !!p.draft,
    title:        p.title,
    brand:        p.brand        || null,
    category:     p.category     || null,
    price:        p.price        ?? null,
    currency:     p.currency     || null,
    availability: p.availability || null,
    imageUrl:     p.imageUrl     || null,
    // Hero + alts. URLs are the raw source-CDN strings; *MediaId fields
    // point at the wrapped Cloudinary-mirrored catalog-product Media
    // docs. Both surfaced so the Generate Ads wizard's brand-kind
    // unified ribbon can render alt tiles AND wire per-alt exclusion
    // pairings (productId, altMediaId) that drop specific alts from
    // the product_image cartesian.
    additionalImages:        Array.isArray(p.additionalImages) ? p.additionalImages : [],
    imageMediaId:            p.imageMediaId ? String(p.imageMediaId) : null,
    additionalImageMediaIds: Array.isArray(p.additionalImageMediaIds)
                               ? p.additionalImageMediaIds.map(id => String(id))
                               : [],
    productUrl:   p.productUrl   || null,
    rating:       typeof p.rating === 'number' ? p.rating : null,
    reviewCount:  Array.isArray(p.reviews) ? p.reviews.length : null,
    matchCount:   matchCount || 0,
    gtin:         p.gtin || null,
    mpn:          p.mpn  || null,
    // Variant-group surface — variantCount lets the UI show
    // "+N variants" when this row is the primary of a Meta
    // item_group_id. isPrimaryVariant is exposed so the operator
    // can see the role explicitly when ?showVariants=1.
    itemGroupId:      p.itemGroupId || null,
    isPrimaryVariant: p.isPrimaryVariant !== false,
    variantCount:     typeof p.variantCount === 'number' ? p.variantCount : 0,
    detectedFromMediaId: p.detectedFromMediaId ? String(p.detectedFromMediaId) : null,
    firstSeenAt:  p.firstSeenAt,
    lastSyncedAt: p.lastSyncedAt
  };
}

// Full detail — everything CatalogProduct stores, plus a hydrated
// Category breadcrumb when categoryRef is set.
function projectDetail(p, category) {
  return {
    id:           String(p._id),
    externalId:   p.externalId,
    retailerId:   p.retailerId   || null,
    source:       p.source,
    draft:        !!p.draft,
    title:        p.title,
    description:  p.description  || null,
    brand:        p.brand        || null,
    category:     p.category     || null,
    categoryRef:  p.categoryRef  ? String(p.categoryRef) : null,
    categoryBreadcrumb: category?.breadcrumb || null,
    categoryUrl:  category?.url        || null,
    price:        p.price        ?? null,
    currency:     p.currency     || null,
    availability: p.availability || null,
    imageUrl:     p.imageUrl     || null,
    additionalImages:        Array.isArray(p.additionalImages) ? p.additionalImages : [],
    imageMediaId:            p.imageMediaId ? String(p.imageMediaId) : null,
    additionalImageMediaIds: Array.isArray(p.additionalImageMediaIds)
                               ? p.additionalImageMediaIds.map(id => String(id))
                               : [],
    productUrl:   p.productUrl   || null,
    gtin:         p.gtin || null,
    mpn:          p.mpn  || null,

    // Phase 2f Immersive + reviews fields
    rating:              typeof p.rating === 'number' ? p.rating : null,
    ratingDistribution:  Array.isArray(p.ratingDistribution) ? p.ratingDistribution : [],
    reviews:             Array.isArray(p.reviews) ? p.reviews : [],
    specs:               p.specs   || null,
    sellers:             Array.isArray(p.sellers) ? p.sellers : [],
    reviewSummary:       p.reviewSummary || null,
    productReviews:      p.productReviews || null,
    detailsRefreshedAt:  p.detailsRefreshedAt || null,

    detectedFromMediaId: p.detectedFromMediaId ? String(p.detectedFromMediaId) : null,
    firstSeenAt:  p.firstSeenAt,
    lastSyncedAt: p.lastSyncedAt
  };
}

// ── List ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 30, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const filter = tenantFilter(req, { brandId });
    // ?ids=a,b,c — batch hydration for the Generate Ads picker.
    // Bypasses sort/pagination but stays inside tenant + brand scope.
    // Also bypasses the primary-variant filter so direct id lookups
    // resolve every requested row regardless of role.
    const idsParam = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (idsParam.length) filter._id = { $in: idsParam.slice(0, 100) };
    // Variant collapse — disabled by default so every SKU (size /
    // color / pack-size) shows as its own pickable card for ads.
    // Pack-size variants of the same product are commonly sold as
    // separate listings, and operators want each to be ad-targetable.
    // Opt INTO the old collapsed view with ?collapseVariants=1 (still
    // supports legacy ?showVariants=1 callers — that param becomes
    // a no-op since variants now show by default).
    if (!idsParam.length && req.query.collapseVariants === '1') {
      filter.isPrimaryVariant = { $ne: false };
    }
    if (req.query.source === 'draft') {
      filter.draft = true;
    } else if (req.query.source) {
      filter.source = String(req.query.source);
    }
    // Independent draft filter — composes with `source` so callers can
    // ask for "drafts of a specific source" (e.g. detect-identified
    // review queue: ?source=detect-identified&draft=1). Without this,
    // ?source=detect-identified returned both draft + saved rows mixed.
    if (req.query.draft === '1') filter.draft = true;
    if (req.query.draft === '0') filter.draft = { $ne: true };
    if (req.query.category) {
      filter.category = new RegExp(escapeRegex(String(req.query.category)), 'i');
    }
    if (req.query.q) {
      const re = new RegExp(escapeRegex(String(req.query.q)), 'i');
      filter.$or = [{ title: re }, { description: re }];
    }
    if (req.query.inStock === '1') filter.availability = /in stock/i;
    if (req.query.hasReviews === '1') filter['productReviews.quotes.0'] = { $exists: true };

    // Sort by matchCount desc → lastSyncedAt desc so products with
    // UGC matches stack at the top. Done as a single aggregation so
    // pagination is correct across the full ranked set (a per-page
    // join wouldn't move a high-traffic product on page 4 to page 1).
    //
    // Mongoose's find() auto-casts string ids → ObjectId based on the
    // schema; aggregate() does NOT. Re-cast brandId / advertiserId
    // here so the $match stage hits the same docs countDocuments does.
    const aggFilter = { ...filter };
    if (typeof aggFilter.brandId === 'string' && mongoose.Types.ObjectId.isValid(aggFilter.brandId)) {
      aggFilter.brandId = new mongoose.Types.ObjectId(aggFilter.brandId);
    }
    if (typeof aggFilter.advertiserId === 'string' && mongoose.Types.ObjectId.isValid(aggFilter.advertiserId)) {
      aggFilter.advertiserId = new mongoose.Types.ObjectId(aggFilter.advertiserId);
    }

    const [rows, total, distinctCategories, totalDrafts] = await Promise.all([
      CatalogProduct.aggregate([
        { $match: aggFilter },
        // Variant inheritance — non-primary variants resolve matches via
        // their primary (productMatchService only matches against primaries).
        // effectiveProductId = primaryProductId || _id makes the matchCount
        // on a 12-pack card mirror its 3-pack primary instead of zero.
        { $addFields: { effectiveProductId: { $ifNull: ['$primaryProductId', '$_id'] } } },
        { $lookup: {
            from:         'productmatchartifacts',
            localField:   'effectiveProductId',
            foreignField: 'catalogProductId',
            as:           'matches'
        }},
        // Sibling variant count — only meaningful when itemGroupId is
        // set (Meta's variant grouping). Title-based groups would
        // need a normalized-string $lookup which isn't worth the
        // pipeline cost; siblings stay 0 in that case.
        { $lookup: {
            from: 'catalogproducts',
            let:  { gid: '$itemGroupId', bid: '$brandId', myId: '$_id' },
            pipeline: [
              { $match: { $expr: { $and: [
                  { $ne: ['$$gid', null] },
                  { $eq: ['$itemGroupId', '$$gid'] },
                  { $eq: ['$brandId', '$$bid'] },
                  { $ne: ['$_id', '$$myId'] }
              ] } } },
              { $count: 'n' }
            ],
            as: 'siblings'
        }},
        { $addFields: {
            matchCount:   { $size: '$matches' },
            variantCount: { $ifNull: [{ $arrayElemAt: ['$siblings.n', 0] }, 0] }
        }},
        { $sort: { matchCount: -1, lastSyncedAt: -1 } },
        { $skip:  offset },
        { $limit: limit },
        { $project: {
            externalId: 1, source: 1, draft: 1, title: 1, brand: 1, category: 1,
            price: 1, currency: 1, availability: 1, imageUrl: 1, productUrl: 1,
            // Hero + alts surfaced so the brand-kind unified ribbon can
            // render alt tiles and key (productId, altMediaId) exclusions.
            additionalImages: 1, imageMediaId: 1, additionalImageMediaIds: 1,
            rating: 1, reviews: 1, gtin: 1, mpn: 1,
            itemGroupId: 1, isPrimaryVariant: 1, variantCount: 1,
            detectedFromMediaId: 1, firstSeenAt: 1, lastSyncedAt: 1,
            matchCount: 1
        }}
      ]),
      CatalogProduct.countDocuments(filter),
      CatalogProduct.distinct('category', { brandId }),
      CatalogProduct.countDocuments(tenantFilter(req, { brandId, draft: true }))
    ]);

    res.json({
      products: rows.map(r => projectListRow(r, r.matchCount || 0)),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      categories: distinctCategories.filter(Boolean).sort(),
      totalDrafts
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog list failed' });
  }
});

// ── Detail ──────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const filter = tenantFilter(req, { _id: req.params.id });
    const product = await CatalogProduct.findOne(filter).lean();
    if (!product) return res.status(404).json({ error: 'product not found' });

    const [category, sourceMedia] = await Promise.all([
      product.categoryRef ? Category.findById(product.categoryRef).lean() : null,
      product.detectedFromMediaId
        ? Media.findById(product.detectedFromMediaId).select('externalId fileType fileUrl fileName source metadata platformStats createdAt').lean()
        : null
    ]);

    res.json({
      product: projectDetail(product, category),
      sourceMedia: sourceMedia ? {
        id:            String(sourceMedia._id),
        externalId:    sourceMedia.externalId,
        fileType:      sourceMedia.fileType,
        fileUrl:       sourceMedia.fileUrl,
        fileName:      sourceMedia.fileName,
        source:        sourceMedia.source,
        permalink:     sourceMedia.metadata?.permalink || null,
        createdAt:     sourceMedia.createdAt,
        platformStats: sourceMedia.platformStats || null
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog detail failed' });
  }
});

// ── Edit ────────────────────────────────────────────────────────────
//
// PATCH /api/catalog/:id
// Body: subset of editable fields. Operator-curated edits — primarily
// used by the /ads/detect review page to graduate a draft detect-
// identified row into the main catalog.
//
// Editable fields:
//   title, brand, category, price, currency, productUrl, imageUrl,
//   description, draft  (passing `draft: false` saves/promotes a row)
//
// Source / catalog-sync fields (externalId, retailerId, gtin, mpn,
// rawData, lastSyncedAt) are NOT editable — they're authoritative
// from the upstream sync. Validators reject any unknown keys.
const EDITABLE_FIELDS = new Set([
  'title', 'brand', 'category', 'price', 'currency',
  'productUrl', 'imageUrl', 'description', 'draft'
]);
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const product = await CatalogProduct.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!product) return res.status(404).json({ error: 'product not found' });

    const updates = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!EDITABLE_FIELDS.has(k)) continue;
      // Coerce numerics; price comes off the wire as either number or
      // string from <input type="number">.
      if (k === 'price' && v !== null && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) updates.price = n;
        continue;
      }
      if (k === 'draft') { updates.draft = !!v; continue; }
      updates[k] = v ?? null;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    const wasDraft = product.draft === true;
    Object.assign(product, updates);
    // Belt & braces: detect-identified rows should always be primary
    // variants (they're not Shopify variant siblings). Older drafts
    // created before the draft service was fixed to stamp this on
    // insert have isPrimaryVariant undefined → schema default false →
    // catalog list filter excludes them. Auto-set on any PATCH so a
    // "Save & add to catalog" from the Detect Review page rescues
    // legacy drafts into the main catalog without a Mongo backfill.
    if (product.source === 'detect-identified' && product.isPrimaryVariant === false) {
      product.isPrimaryVariant = true;
    }
    await product.save();

    // Draft promotion transition (true → false): retroactively link
    // every existing unlinked ProductMatchArtifact across the brand's
    // media whose identification subset-matches this product, and
    // collapse any other detect-identified twins. Runs inline so the
    // response carries the updated matchedMedia count.
    const wasPromoted = wasDraft && product.draft === false;
    if (wasPromoted) {
      await catalogProductPromoteService.onPromote(product.toObject());
      // Re-read so the response includes the freshly-rebuilt
      // matchedMedia[] count from the retro-link pass.
      const refreshed = await CatalogProduct.findById(product._id).lean();
      return res.json({ product: projectListRow(refreshed, (refreshed.matchedMedia || []).length) });
    }

    res.json({ product: projectListRow(product, (product.matchedMedia || []).length) });
  } catch (err) {
    console.error('catalog PATCH failed:', err);
    res.status(500).json({ error: err.message || 'catalog update failed' });
  }
});

// ── Matched Media ──────────────────────────────────────────────────

router.get('/:id/matches', async (req, res) => {
  try {
    const filter = tenantFilter(req, { _id: req.params.id });
    const product = await CatalogProduct.findOne(filter).select('_id').lean();
    if (!product) return res.status(404).json({ error: 'product not found' });

    // Pull every artifact that references this catalog product, then
    // group by mediaId so the UI shows one row per Media (with the
    // most recent artifact's evidence).
    const artifacts = await ProductMatchArtifact.find({ catalogProductId: product._id })
      .sort({ createdAt: -1 })
      .select('mediaId outcome outcomeReasoning winner identification query catalogCombinedScore catalogVisualScore createdAt productIndex matchSource')
      .limit(200)
      .lean();

    const seen = new Set();
    const ordered = [];
    for (const a of artifacts) {
      const key = String(a.mediaId);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(a);
    }

    // Hydrate the Media docs
    const mediaIds = ordered.map(a => a.mediaId);
    const mediaDocs = mediaIds.length
      ? await Media.find({ _id: { $in: mediaIds } })
          .select('externalId fileType fileUrl fileName source metadata createdAt classification platformStats')
          .lean()
      : [];
    const mediaById = new Map(mediaDocs.map(m => [String(m._id), m]));

    // Content-nature filter is gated on ?adEligible=1. The campaign
    // wizard's Step 2 picker passes the flag so the picker only shows
    // matches the cartesian will actually queue. The catalog browser
    // does NOT pass it — operators looking at a product's match
    // history should see every linked match, ad-eligible or not.
    // Otherwise the matches tab silently disagrees with the sidebar's
    // match count pill.
    const filterAdEligible = req.query.adEligible === '1';
    const { isMediaEligibleByContentNature } = require('../services/campaignAdsGenerationService');

    const matches = ordered.map(a => {
      const m = mediaById.get(String(a.mediaId));
      if (!m) return null;
      if (filterAdEligible && !isMediaEligibleByContentNature(m)) return null;
      const cropProductRef = a.query?.productCrop || {};
      return {
        mediaId:    String(a.mediaId),
        runArtifactId: String(a._id),
        productIndex: a.productIndex || null,
        outcome:    a.outcome || null,
        // matchTier mirrors the seed expansion's matchTier values
        // (product_match | product_category) — same shape the picker
        // groups on. Brand-wide brand_match matches surface via the
        // separate /api/brand/:id/brand-matches endpoint.
        matchTier:        a.outcome || null,
        outcomeReasoning: a.outcomeReasoning || null,
        matchSource:      a.matchSource || null,
        winner:     a.winner  || null,
        confidence: a.catalogCombinedScore ?? a.identification?.certainty ?? null,
        catalogCombinedScore: a.catalogCombinedScore ?? null,
        catalogVisualScore:   a.catalogVisualScore   ?? null,
        croppedImageUrl: cropProductRef.croppedImageUrl || null,
        cropLabel:       cropProductRef.label          || null,
        cropBbox:        (cropProductRef.x1 != null) ? {
          x1: cropProductRef.x1, y1: cropProductRef.y1,
          x2: cropProductRef.x2, y2: cropProductRef.y2
        } : null,
        media: {
          externalId:   m.externalId,
          fileType:     m.fileType,
          fileUrl:      m.fileUrl,
          fileName:     m.fileName,
          source:       m.source,
          permalink:    m.metadata?.permalink || null,
          creatorHandle: m.metadata?.creatorHandle || null,
          postedAt:     m.metadata?.postedAt || null,
          likes:        m.platformStats?.likes    ?? null,
          comments:     m.platformStats?.comments ?? null,
          detectOutcome: m.classification?.detectSummary?.outcome || null,
          createdAt:    m.createdAt
        },
        artifactCreatedAt: a.createdAt
      };
    }).filter(Boolean);

    res.json({
      productId: String(product._id),
      total:    matches.length,
      matches
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog matches lookup failed' });
  }
});

module.exports = router;
