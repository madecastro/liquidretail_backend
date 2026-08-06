// Executor for capability agent.searchAcrossBrands (Tier 0, advertiser scope).
//
// Text-substring search across the caller's advertiser's brands +
// their catalog products + ads + campaigns. Every leg is
// advertiserId-scoped or resolves through advertiser-scoped parents so
// nothing cross-tenant leaks. Result rows capped at 20 per resource
// type to keep the tool_result payload under the ~12KB LLM cap.
//
// TENANCY: cross-advertiser discovery is a permanent non-goal
// (coverage plan §D2). The Ad model tenant-resolves via brand.
// Campaign carries advertiserId directly. CatalogProduct carries
// advertiserId directly.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const Campaign = require('../../models/Campaign');
const Ad = require('../../models/Ad');

const VALID_RESOURCE_TYPES = new Set(['brand', 'product', 'campaign', 'ad']);
const DEFAULT_RESOURCE_TYPES = ['brand', 'product', 'campaign', 'ad'];
const PER_TYPE_CAP = 20;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const advertiserId = req.advertiserId;

  const rawQuery = String(args?.query || '').trim();
  if (!rawQuery) return { ok: false, error: 'query required' };
  if (rawQuery.length < MIN_QUERY_LEN) {
    return { ok: false, error: `query too short (min ${MIN_QUERY_LEN} chars)` };
  }
  if (rawQuery.length > MAX_QUERY_LEN) {
    return { ok: false, error: `query too long (max ${MAX_QUERY_LEN} chars)` };
  }

  let resourceTypes = args?.resourceTypes;
  if (resourceTypes == null) {
    resourceTypes = DEFAULT_RESOURCE_TYPES;
  } else if (!Array.isArray(resourceTypes)) {
    return { ok: false, error: 'resourceTypes must be an array of strings' };
  }
  for (const t of resourceTypes) {
    if (!VALID_RESOURCE_TYPES.has(t)) {
      return { ok: false, error: `resourceType "${t}" invalid — allowed: ${[...VALID_RESOURCE_TYPES].join(', ')}` };
    }
  }
  if (!resourceTypes.length) {
    return { ok: false, error: 'resourceTypes must include at least one type' };
  }

  // Optional brandId narrowing — when set, every leg that has a
  // brandId column filters on it. brand-scope search is a common case
  // and the LLM was reaching for db.query (which lacks $regex) when
  // it should reach here.
  const rawBrandId = args?.brandId;
  let brandIdFilter = null;
  if (rawBrandId != null) {
    if (!mongoose.isValidObjectId(rawBrandId)) {
      return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
    }
    // Tenant guard on the brand itself — must belong to the caller's
    // advertiser. Prevents a foreign brandId from narrowing an
    // otherwise cross-brand search.
    const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: advOid })
      .select('_id').lean();
    if (!brand) return { ok: false, error: `brand ${rawBrandId} not found under this advertiser` };
    brandIdFilter = brand._id;
  }

  const rx = new RegExp(escapeRegex(rawQuery), 'i');

  // Parallel per-resource fetches. Everything is advertiser-scoped;
  // Ad resolves via a brand lookup upstream so we never cross tenants.
  const legs = {
    brand: null, product: null, campaign: null, ad: null
  };

  const wants = new Set(resourceTypes);
  const brandIdListPromise = wants.has('ad')
    ? (brandIdFilter
        ? Promise.resolve([{ _id: brandIdFilter }])
        : Brand.find({ advertiserId: advOid }).select('_id').lean())
    : Promise.resolve([]);

  const [brands, products, campaigns, brandIdList] = await Promise.all([
    // Brand-name search is only meaningful when NOT narrowed to one
    // brand (a per-brand search doesn't need to search brand names).
    (wants.has('brand') && !brandIdFilter)
      ? Brand.find({ advertiserId: advOid, name: rx })
          .limit(PER_TYPE_CAP)
          .select('_id name nameNormalized websiteUrl status')
          .lean()
      : null,
    wants.has('product')
      ? CatalogProduct.find({
          advertiserId: advOid,
          ...(brandIdFilter ? { brandId: brandIdFilter } : {}),
          $or: [
            { title: rx },
            { externalId: rx }
          ]
        })
          .limit(PER_TYPE_CAP)
          .select('_id brandId title externalId imageUrl price currency rating productReviews.reviewCount')
          .lean()
      : null,
    wants.has('campaign')
      ? Campaign.find({
          advertiserId: advOid,
          ...(brandIdFilter ? { brandId: brandIdFilter } : {}),
          name: rx
        })
          .limit(PER_TYPE_CAP)
          .select('_id brandId name status kind updatedAt')
          .lean()
      : null,
    brandIdListPromise
  ]);

  // Ad-search — resolve via brandId set (Ad has brandId but not
  // advertiserId in all vintages of the schema, so we cross-check).
  let ads = null;
  if (wants.has('ad') && brandIdList.length) {
    const brandOids = brandIdList.map((b) => b._id);
    ads = await Ad.find({
      brandId: { $in: brandOids },
      $or: [
        { title: rx },
        { 'copy.headline': rx },
        { 'copy.cta_text': rx }
      ]
    })
      .limit(PER_TYPE_CAP)
      .select('_id brandId title copy status kind renderUrl updatedAt')
      .lean();
  }

  if (brands) legs.brand = brands.map((b) => ({
    _id:        String(b._id),
    name:       b.name,
    slug:       b.nameNormalized,
    websiteUrl: b.websiteUrl || null,
    status:     b.status || null
  }));
  if (products) legs.product = products.map((p) => ({
    _id:        String(p._id),
    brandId:    String(p.brandId),
    title:      p.title,
    externalId: p.externalId || null,
    imageUrl:   p.imageUrl || null,
    price:      p.price ?? null,
    currency:   p.currency || null
  }));
  if (campaigns) legs.campaign = campaigns.map((c) => ({
    _id:      String(c._id),
    brandId:  String(c.brandId),
    name:     c.name,
    status:   c.status || null,
    kind:     c.kind || null,
    updatedAt: c.updatedAt || null
  }));
  if (ads) legs.ad = ads.map((a) => ({
    _id:       String(a._id),
    brandId:   String(a.brandId),
    title:     a.title || null,
    headline:  a.copy?.headline || null,
    ctaText:   a.copy?.cta_text || null,
    status:    a.status || null,
    kind:      a.kind || null,
    renderUrl: a.renderUrl || null,
    updatedAt: a.updatedAt || null
  }));

  const counts = {
    brand:    legs.brand    ? legs.brand.length    : null,
    product:  legs.product  ? legs.product.length  : null,
    campaign: legs.campaign ? legs.campaign.length : null,
    ad:       legs.ad       ? legs.ad.length       : null
  };
  const truncated = Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, v === PER_TYPE_CAP])
  );

  return {
    ok: true,
    kind: 'searchResults',
    data: {
      query: rawQuery,
      resourceTypes,
      counts,
      truncated,
      results: legs,
      note: 'Every result row is scoped to your advertiser. Cross-advertiser discovery is never exposed. Rows capped at 20 per resource type — narrow the query if truncated.'
    }
  };
}

module.exports = { run };
