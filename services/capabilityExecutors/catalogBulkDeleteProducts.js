// Executor for capability catalog.bulkDeleteProducts (Tier 4, brand
// scope). Tier 4 = requires operator confirmation via the phrase gate;
// bulk delete with a filter can nuke thousands of rows on a typo.
//
// Two shapes, one wins per call:
//
//   1. { brandId, productIds: [...] }
//      Explicit list — surgical removal of a known set.
//
//   2. { brandId, filter }
//      Filter-based — every product matching `filter`. Same DSL as
//      catalog.bulkPatchProducts.
//
// hardDelete:true runs cascade cleanup + Mongo deleteMany. Default is
// soft — sets deletedAt = now on every match. Cascade cleanup runs in
// BOTH modes so downstream refs (Campaign.matchedProductIds,
// Media.matchedProducts, Ad.productId) stop pointing at hidden rows.
//
// Cap: MAX_BULK_PRODUCTS (500). The filter branch counts BEFORE
// mutating and refuses if the resolved set exceeds the cap — no
// partial writes.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const {
  MAX_BULK_PRODUCTS, resolveFilter, countForQuery, cascadeCleanupOnDelete
} = require('../catalogBulkOps');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name advertiserId').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const hardDelete   = args?.hardDelete === true;
  const hasProductIds = Array.isArray(args?.productIds);
  const hasFilter     = !!args?.filter;
  if (!hasProductIds && !hasFilter) {
    return { ok: false, error: 'either productIds[] or filter required' };
  }
  if (hasProductIds && hasFilter) {
    return { ok: false, error: 'pass EITHER productIds[] OR filter, not both' };
  }

  // Resolve to a Mongo query via the shared DSL — same normalisation
  // in both branches so the delete flow is one code path from here.
  // hardDelete needs to see tombstones so a repeat hard-delete request
  // can pick them up; soft-delete keeps the default guard.
  let queryResolved;
  try {
    queryResolved = resolveFilter(
      hasProductIds ? { productIds: args.productIds } : args.filter || {},
      { brandId: brand._id, advertiserId: req.advertiserId, includeDeleted: hardDelete }
    );
  } catch (err) {
    return { ok: false, error: `filter resolution failed: ${err.message}` };
  }
  const scoped = queryResolved.query;

  // Count-first — refuse over-cap operations, and provide the count
  // in the response so operator confirmation sees the blast radius.
  const wouldMatch = await countForQuery(scoped);
  if (wouldMatch === 0) {
    return {
      ok: true,
      kind: 'productBulkDelete',
      data: {
        brandId:   String(brand._id),
        brandName: brand.name,
        mode:      hasProductIds ? 'explicit' : 'filter',
        hardDelete,
        wouldMatch: 0,
        deleted:   0,
        cascade:   { campaigns: 0, media: 0, ads: 0 },
        note:      'no products matched — nothing to delete',
        warnings:  queryResolved.warnings
      }
    };
  }
  if (wouldMatch > MAX_BULK_PRODUCTS) {
    return {
      ok: false,
      error: `would delete ${wouldMatch} products (> ${MAX_BULK_PRODUCTS}). Narrow the filter and re-run in chunks.`,
      count: wouldMatch
    };
  }

  // Materialise the ids ONCE — cascade + delete both use them, and
  // resolving from the query twice risks racing an ingest that lands
  // between the two reads.
  const docs = await CatalogProduct.find(scoped).select('_id').lean();
  const productIds = docs.map(d => String(d._id));

  const cascade = await cascadeCleanupOnDelete(productIds);

  let deleted;
  if (hardDelete) {
    const r = await CatalogProduct.deleteMany({ _id: { $in: productIds }, advertiserId: req.advertiserId });
    deleted = r.deletedCount || 0;
  } else {
    // Idempotent on soft — updateMany with deletedAt:null in the
    // filter means already-soft-deleted rows aren't touched twice.
    // Callers see `modified` for the "actually flipped" count and
    // `wouldMatch` for the "found" count.
    const now = new Date();
    const r = await CatalogProduct.updateMany(
      { _id: { $in: productIds }, advertiserId: req.advertiserId, deletedAt: null },
      { $set: { deletedAt: now } }
    );
    deleted = r.modifiedCount || 0;
  }

  return {
    ok: true,
    kind: 'productBulkDelete',
    data: {
      brandId:    String(brand._id),
      brandName:  brand.name,
      mode:       hasProductIds ? 'explicit' : 'filter',
      hardDelete,
      wouldMatch,
      deleted,
      cascade,
      warnings:   queryResolved.warnings
    }
  };
}

module.exports = { run };
