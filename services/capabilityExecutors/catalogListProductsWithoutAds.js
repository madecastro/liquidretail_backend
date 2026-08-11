// Executor for capability catalog.listProductsWithoutAds (Tier 0, brand scope).
//
// Answers the "which products in this brand have no ad generated
// (yet, in this shape)?" question with a single call. The LLM could
// synthesise this via two db.query invocations + set-diff, but at
// brand sizes >20 ads that busts AGENT_MAX_ITERATIONS (default 8)
// because pagination compounds. Server-side aggregation makes it a
// one-turn answer.
//
// The "which shape" is optional: kind ('image' | 'video'),
// aspectRatio, and a status allowlist (defaults to the "counts as
// real" set — no failed / archived / regenerating rows). Omit all
// three to answer the plain "products without ANY ad."
//
// Bounds:
//   - Products enumerated up to 500 for the set-diff. Larger catalogs
//     get a `catalogEnumerated: 500, truncated: true` flag; the LLM
//     should narrow further (e.g. by category or price range via
//     db.query if it needs to explore beyond the first 500).
//   - Missing-products response capped at 100 rows.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const Ad = require('../../models/Ad');

const CATALOG_ENUM_CAP  = 500;
const MISSING_RESP_CAP  = 100;
const DEFAULT_MISSING_LIMIT = 20;

// Ad statuses that count as "real" ads for coverage purposes. Failed
// / archived / regenerating rows would give a misleading "yes has an
// ad" signal — the operator asking "which products need ads" wants
// the products with no LIVE-EQUIVALENT ad.
const DEFAULT_COUNTED_STATUSES = ['ok', 'draft', 'queued', 'rendering'];

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const kind = args?.kind;
  if (kind != null && !['image', 'video'].includes(kind)) {
    return { ok: false, error: `kind must be "image" or "video" (or omit for any)` };
  }
  const aspectRatio = args?.aspectRatio;
  if (aspectRatio != null && typeof aspectRatio !== 'string') {
    return { ok: false, error: 'aspectRatio must be a string (e.g. "9:16") or omitted' };
  }
  // Distinguish "not provided" from "provided but empty" — an
  // operator sending statuses: [] is asking for the empty set (matches
  // nothing), which is almost certainly a mistake. Fall back on the
  // default only when the arg is truly absent.
  let statuses;
  if (args?.statuses === undefined) {
    statuses = DEFAULT_COUNTED_STATUSES;
  } else {
    if (!Array.isArray(args.statuses) || args.statuses.length === 0) {
      return { ok: false, error: 'statuses must be a non-empty array (or omit for the default counted set)' };
    }
    statuses = args.statuses.filter((s) => typeof s === 'string');
    if (!statuses.length) {
      return { ok: false, error: 'statuses must be a non-empty array of strings' };
    }
  }
  const limit = Math.min(Math.max(parseInt(args?.limit, 10) || DEFAULT_MISSING_LIMIT, 1), MISSING_RESP_CAP);

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  // Enumerate the brand's non-draft products. Cap at CATALOG_ENUM_CAP —
  // beyond that the operator needs to narrow. Sorted by lastSyncedAt
  // desc so the most-recently-touched products come first (useful
  // when the brand just synced).
  const products = await CatalogProduct.find({
    advertiserId: req.advertiserId,
    brandId: brand._id,
    draft: { $ne: true }
  })
    .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
    .limit(CATALOG_ENUM_CAP + 1)
    .select('_id title imageUrl price currency rating productReviews.reviewCount')
    .lean();

  const catalogTruncated = products.length > CATALOG_ENUM_CAP;
  if (catalogTruncated) products.length = CATALOG_ENUM_CAP;

  // Ad-side filter. Ad has brandId + productId; we filter by the
  // caller's brand (tenant-scoped via the Brand lookup above) plus
  // the optional shape constraints.
  const adFilter = {
    brandId: brand._id,
    productId: { $exists: true, $ne: null },
    status: { $in: statuses }
  };
  if (kind) adFilter.kind = kind;
  if (aspectRatio) adFilter.aspectRatio = aspectRatio;

  // distinct is index-friendly and returns just the productIds; no
  // Ad rows come back to memory.
  const productIdsWithAd = await Ad.distinct('productId', adFilter);
  const withAdSet = new Set(productIdsWithAd.map((id) => String(id)));

  const missing = products.filter((p) => !withAdSet.has(String(p._id)));
  const missingTruncated = missing.length > limit;
  const missingRows = missingTruncated ? missing.slice(0, limit) : missing;

  return {
    ok: true,
    kind: 'productList',
    data: {
      brand: { _id: String(brand._id), name: brand.name },
      filter: {
        kind:        kind || null,
        aspectRatio: aspectRatio || null,
        statuses,
        note: (!kind && !aspectRatio) ? 'no shape filter — matches products without ANY counted ad' : 'shape-scoped — matches products without a counted ad of this shape'
      },
      catalogEnumerated:   products.length,
      catalogTruncated,
      productsWithMatchingAd: withAdSet.size,
      productsWithoutMatchingAd: missing.length,
      missingProductsShown: missingRows.length,
      missingTruncated,
      products: missingRows.map((p) => ({
        _id:        String(p._id),
        title:      p.title,
        imageUrl:   p.imageUrl || null,
        price:      p.price ?? null,
        currency:   p.currency || null,
        rating:     p.rating ?? null,
        reviewCount: p.productReviews?.reviewCount ?? null
      })),
      note: catalogTruncated
        ? `Catalog is larger than ${CATALOG_ENUM_CAP} products; only the most-recently-synced ${CATALOG_ENUM_CAP} were checked. Narrow further via a category filter through db.query if you need broader coverage.`
        : `Full catalog checked. ${missing.length} product(s) lack a counted ad matching the filter${missingTruncated ? `; showing top ${limit}` : ''}.`
    }
  };
}

module.exports = { run };
