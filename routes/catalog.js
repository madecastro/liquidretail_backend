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

const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Category              = require('../models/Category');
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
    productUrl:   p.productUrl   || null,
    rating:       typeof p.rating === 'number' ? p.rating : null,
    reviewCount:  Array.isArray(p.reviews) ? p.reviews.length : null,
    matchCount:   matchCount || 0,
    gtin:         p.gtin || null,
    mpn:          p.mpn  || null,
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
    additionalImages: Array.isArray(p.additionalImages) ? p.additionalImages : [],
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
    if (req.query.source === 'draft') {
      filter.draft = true;
    } else if (req.query.source) {
      filter.source = String(req.query.source);
    }
    if (req.query.category) {
      filter.category = new RegExp(escapeRegex(String(req.query.category)), 'i');
    }
    if (req.query.q) {
      const re = new RegExp(escapeRegex(String(req.query.q)), 'i');
      filter.$or = [{ title: re }, { description: re }];
    }
    if (req.query.inStock === '1') filter.availability = /in stock/i;
    if (req.query.hasReviews === '1') filter['productReviews.quotes.0'] = { $exists: true };

    const [rows, total, distinctCategories, totalDrafts] = await Promise.all([
      CatalogProduct.find(filter)
        .select('externalId source draft title brand category price currency availability imageUrl productUrl rating reviews gtin mpn detectedFromMediaId firstSeenAt lastSyncedAt')
        .sort({ lastSyncedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      CatalogProduct.countDocuments(filter),
      CatalogProduct.distinct('category', { brandId }),
      CatalogProduct.countDocuments(tenantFilter(req, { brandId, draft: true }))
    ]);

    // Match-traffic count: how many ProductMatchArtifacts reference each
    // catalog row in the current page. One aggregation pulls all counts.
    const ids = rows.map(r => r._id);
    const matchCounts = ids.length
      ? await ProductMatchArtifact.aggregate([
          { $match: { catalogProductId: { $in: ids } } },
          { $group: { _id: '$catalogProductId', count: { $sum: 1 } } }
        ])
      : [];
    const matchMap = new Map(matchCounts.map(c => [String(c._id), c.count]));

    res.json({
      products: rows.map(r => projectListRow(r, matchMap.get(String(r._id)) || 0)),
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
      .select('mediaId outcome winner identification query catalogCombinedScore catalogVisualScore createdAt productIndex')
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

    const matches = ordered.map(a => {
      const m = mediaById.get(String(a.mediaId));
      if (!m) return null;
      const cropProductRef = a.query?.productCrop || {};
      return {
        mediaId:    String(a.mediaId),
        runArtifactId: String(a._id),
        productIndex: a.productIndex || null,
        outcome:    a.outcome || null,
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
