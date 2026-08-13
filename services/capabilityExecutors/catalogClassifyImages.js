// Executor for capability catalog.classifyImages (Tier 1, brand scope).
//
// Wraps ingestShotClassifyService — the same free (sharp-only) shot-
// style classifier every ingest loop runs post-upsert — so an operator
// can force a re-classify from the agent without a full re-sync.
//
// Two shapes, one wins per call:
//   { brandId, productIds: [...] }   explicit
//   { brandId, filter }              filter DSL — same shape as
//                                    catalog.bulkPatchProducts uses
//                                    (categoryRefs, source, draft,
//                                    productIds, lastSyncedBefore).
//
// force:true bypasses the "URL already in imageShotStyles" skip inside
// classifyUrls — every URL gets re-fetched + re-classified. Default is
// idempotent (existing entries skipped, only new URLs classified);
// force is the "reclassify everything" opt-in.
//
// Cap: MAX_BULK_PRODUCTS (500). Filter branch counts BEFORE mutating
// and refuses if the resolved set exceeds the cap — same pattern the
// other bulk executors use.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const ingestShotClassify = require('../ingestShotClassifyService');
const {
  MAX_BULK_PRODUCTS, resolveFilter, countForQuery
} = require('../catalogBulkOps');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  if (!ingestShotClassify.isEnabled()) {
    return { ok: false, error: 'CATALOG_INGEST_SHOT_CLASSIFY_ENABLED=false — classifier disabled at the env level' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name advertiserId').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const force = args?.force === true;
  const hasProductIds = Array.isArray(args?.productIds);
  const hasFilter     = !!args?.filter;
  if (!hasProductIds && !hasFilter) {
    return { ok: false, error: 'either productIds[] or filter required' };
  }
  if (hasProductIds && hasFilter) {
    return { ok: false, error: 'pass EITHER productIds[] OR filter, not both' };
  }

  // Resolve to a Mongo query via the shared DSL — tenant-scoped +
  // deletedAt-guarded.
  let queryResolved;
  try {
    queryResolved = resolveFilter(
      hasProductIds ? { productIds: args.productIds } : args.filter || {},
      { brandId: brand._id, advertiserId: req.advertiserId }
    );
  } catch (err) {
    return { ok: false, error: `filter resolution failed: ${err.message}` };
  }
  const scoped = queryResolved.query;

  const wouldMatch = await countForQuery(scoped);
  if (wouldMatch === 0) {
    return {
      ok: true,
      kind: 'catalogClassifyImages',
      data: {
        brandId:   String(brand._id),
        brandName: brand.name,
        matched:   0,
        note:      'no products matched — nothing to classify',
        warnings:  queryResolved.warnings
      }
    };
  }
  if (wouldMatch > MAX_BULK_PRODUCTS) {
    return {
      ok: false,
      error: `filter would classify ${wouldMatch} products (> ${MAX_BULK_PRODUCTS}). Narrow the filter and re-run in chunks.`,
      count: wouldMatch
    };
  }

  const products = await CatalogProduct.find(scoped)
    .select('_id imageUrl additionalImages imageShotStyles')
    .lean();

  // Session shares the concurrency cap + wall-clock budget across every
  // product. Same createSession call the ingest paths use.
  const session = ingestShotClassify.createSession();
  session.beginClassifyPhase();

  const rollup = {
    considered:      0,
    classified:      0,
    skippedExisting: 0,
    failed:          0,
    fetchFailed:     0,
    ssrfRejected:    0,
    timedOut:        0,
    tooLarge:        0
  };
  const perProduct = [];

  for (const p of products) {
    const urls = ingestShotClassify.collectProductImageUrls(p.imageUrl, p.additionalImages);
    if (urls.length === 0) {
      perProduct.push({ productId: String(p._id), skipped: 'no urls' });
      continue;
    }
    // When force:true is set, we deliberately do NOT hand the existing
    // imageShotStyles array to classifyUrls — every URL is treated as
    // fresh, no "skippedExisting" bump, and the full session budget is
    // spent on re-classifying.
    const existingEntries = force ? [] : (Array.isArray(p.imageShotStyles) ? p.imageShotStyles : []);
    let result;
    try {
      result = await session.classifyUrls(urls, existingEntries);
    } catch (err) {
      perProduct.push({ productId: String(p._id), error: err.message });
      continue;
    }
    // Aggregate stats across products.
    for (const k of Object.keys(rollup)) {
      if (typeof result.stats?.[k] === 'number') rollup[k] += result.stats[k];
    }
    if (!result.changed && !force) {
      perProduct.push({ productId: String(p._id), skipped: 'no url change' });
      continue;
    }
    // Merge fresh entries onto the product's existing map, then prune
    // URLs that no longer belong to the live image set.
    const merged = ingestShotClassify.mergeStyleEntries(
      Array.isArray(p.imageShotStyles) ? p.imageShotStyles : [],
      result.fresh,
      urls
    );
    try {
      await CatalogProduct.updateOne(
        { _id: p._id, advertiserId: req.advertiserId },
        { $set: { imageShotStyles: merged } }
      );
      perProduct.push({
        productId: String(p._id),
        urlsConsidered: urls.length,
        freshClassified: result.fresh.length
      });
    } catch (err) {
      perProduct.push({ productId: String(p._id), error: `write failed: ${err.message}` });
    }
  }

  return {
    ok: true,
    kind: 'catalogClassifyImages',
    data: {
      brandId:   String(brand._id),
      brandName: brand.name,
      matched:   products.length,
      force,
      rollup,
      perProduct: perProduct.slice(0, 100),
      perProductTruncated: perProduct.length > 100 ? perProduct.length - 100 : 0,
      warnings:  queryResolved.warnings
    }
  };
}

module.exports = { run };
