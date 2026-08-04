// Executor for capability catalog.listProducts (Tier 0, brand scope).
//
// Tenant-scoped via req.advertiserId. Returns a count + sample rows so
// the agent can answer "how many products need X?" without shipping the
// full list into the LLM context.

'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../../models/CatalogProduct');
const Brand = require('../../models/Brand');

const SAMPLE_CAP = 100;
const DEFAULT_LIMIT = 20;

// Filters keyed by the `missing` enum in the registry's args schema.
// Each returns a Mongo filter fragment ANDed onto the base tenant filter.
const MISSING_FILTERS = {
  // No populated lifestyle-image field. `productReviews`-style URL fields
  // vary by ingest path; a nullish OR empty-string test catches both.
  lifestyle_image: () => ({
    $or: [
      { lifestyle_image: { $exists: false } },
      { lifestyle_image: null },
      { lifestyle_image: '' }
    ]
  }),
  // Products whose review data came from the gemini-search fallback
  // rather than the 3-tier on-site scraper — the case we hit on the
  // Cruiser (see backlog row 168).
  onsite_reviews: () => ({
    $or: [
      { 'productReviews.source': { $exists: false } },
      { 'productReviews.source': null },
      { 'productReviews.source': { $ne: 'productReviewsScrape' } }
    ]
  }),
  // No video output yet. Placeholder shape; adjust when the video-media
  // field lands per backlog row 167 (Ship videos to Shopify workflow).
  video_media: () => ({
    $or: [
      { productVideoUrl: { $exists: false } },
      { productVideoUrl: null },
      { productVideoUrl: '' }
    ]
  })
};

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const advertiserId = req.advertiserId;

  // Resolve brand scope. Explicit brandId wins; otherwise we require the
  // caller to have already selected one via UI context (agent forwards
  // context.brandId into args before dispatch).
  const rawBrandId = args?.brandId;
  if (!rawBrandId) {
    return { ok: false, error: 'brandId required (either via args or the current UI selection)' };
  }
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  // Cross-tenant guard — a brand outside this advertiser's scope returns
  // "not found" rather than leaking existence.
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId }).select('name').lean();
  if (!brand) {
    return { ok: false, error: `brand ${rawBrandId} not found under this advertiser` };
  }

  const limit = Math.min(args?.limit || DEFAULT_LIMIT, SAMPLE_CAP);
  const missing = args?.missing;

  const filter = { advertiserId, brandId: brand._id };
  if (missing) {
    const fragment = MISSING_FILTERS[missing]?.();
    if (!fragment) return { ok: false, error: `unknown missing filter "${missing}"` };
    Object.assign(filter, fragment);
  }

  // Count + sample in parallel — the count is the authoritative signal
  // for the agent's plan card; the sample fills the ResourceCard grid.
  const [total, sample] = await Promise.all([
    CatalogProduct.countDocuments(filter),
    CatalogProduct.find(filter)
      .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
      .limit(limit)
      .select('_id title externalId imageUrl price currency rating productReviews.source lifestyle_image')
      .lean()
  ]);

  return {
    ok: true,
    kind: 'productList',
    data: {
      brand:  { _id: String(brand._id), name: brand.name },
      filter: missing || null,
      total,
      sampleCount: sample.length,
      products: sample.map((p) => ({
        _id:              String(p._id),
        title:            p.title,
        externalId:       p.externalId,
        imageUrl:         p.imageUrl || null,
        price:            p.price ?? null,
        currency:         p.currency || null,
        rating:           p.rating ?? null,
        reviewsSource:    p.productReviews?.source || null,
        hasLifestyle:     !!p.lifestyle_image
      }))
    }
  };
}

module.exports = { run };
