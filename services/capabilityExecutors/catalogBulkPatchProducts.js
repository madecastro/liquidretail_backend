// Executor for capability catalog.bulkPatchProducts (Tier 1, brand
// scope).
//
// Two shapes, one wins per call:
//
//   1. { brandId, patches: [{ productId, patch }] }
//      Explicit per-row patches. Different rows can have different
//      patches (e.g. bulk price adjustment where prices vary).
//
//   2. { brandId, filter, patch }
//      Filter-based mass update. Every product matching `filter`
//      gets the SAME `patch` applied. Use case: "mark every draft
//      row's currency as USD" or "flip everything in category X to
//      draft=true."
//
// Field allowlist is IDENTICAL to catalog.patchProduct so operators
// don't have to learn two shapes. Cap: MAX_BULK_PRODUCTS (500) —
// filter branch counts BEFORE the write and refuses to apply if it
// would exceed the cap.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { MAX_BULK_PRODUCTS, resolveFilter, countForQuery } = require('../catalogBulkOps');

const ALLOWED_FIELDS = new Set([
  'title', 'brand', 'category', 'price', 'currency',
  'productUrl', 'imageUrl', 'description', 'draft'
]);
const MAX_STR_LEN = 2000;

// Same normalisation as catalog.patchProduct — extracted so the two
// executors can never drift on what "null clears" or "price must be
// finite" means.
function normalizePatch(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'patch object required' };
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, error: 'patch must contain at least one field' };
  const normalized = {};
  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, error: `unknown field "${key}" — allowed: ${[...ALLOWED_FIELDS].join(', ')}` };
    }
    const v = updates[key];
    if (v === null || v === '') { normalized[key] = null; continue; }
    if (key === 'draft') { normalized.draft = !!v; continue; }
    if (key === 'price') {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: `price must be a finite number or null (got ${JSON.stringify(v)})` };
      normalized.price = n;
      continue;
    }
    if (typeof v !== 'string') return { ok: false, error: `${key} must be a string or null` };
    const s = v.trim();
    if (s.length > MAX_STR_LEN) return { ok: false, error: `${key} too long (${s.length} > ${MAX_STR_LEN})` };
    normalized[key] = s;
  }
  return { ok: true, patch: normalized };
}

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

  const hasPatches = Array.isArray(args?.patches);
  const hasFilter  = !!args?.filter || !!args?.patch;
  if (!hasPatches && !hasFilter) {
    return { ok: false, error: 'either patches[] or (filter + patch) required' };
  }
  if (hasPatches && hasFilter) {
    return { ok: false, error: 'pass EITHER patches[] OR (filter + patch), not both' };
  }

  // ── Branch A: explicit per-row patches ─────────────────────────
  if (hasPatches) {
    const patches = args.patches;
    if (patches.length === 0) return { ok: false, error: 'patches[] must be non-empty' };
    if (patches.length > MAX_BULK_PRODUCTS) {
      return { ok: false, error: `patches[] too large (${patches.length} > ${MAX_BULK_PRODUCTS})` };
    }
    let succeeded = 0, failed = 0;
    const errors = [];
    const results = [];
    for (let i = 0; i < patches.length; i++) {
      const entry = patches[i];
      const productId = entry?.productId;
      if (!productId || !mongoose.isValidObjectId(productId)) {
        failed++;
        errors.push({ index: i, error: 'productId missing or not an ObjectId' });
        continue;
      }
      const norm = normalizePatch(entry.patch);
      if (!norm.ok) {
        failed++;
        errors.push({ index: i, productId: String(productId), error: norm.error });
        continue;
      }
      try {
        // Tenant + brand + soft-delete guard on the update so a
        // deleted or foreign row can't be patched by id.
        const r = await CatalogProduct.updateOne(
          {
            _id:          productId,
            advertiserId: req.advertiserId,
            brandId:      brand._id,
            deletedAt:    null
          },
          { $set: norm.patch }
        );
        if (r.matchedCount === 0) {
          failed++;
          errors.push({ index: i, productId: String(productId), error: 'product not found (or soft-deleted / cross-brand)' });
        } else {
          succeeded++;
          results.push({ index: i, productId: String(productId), modified: (r.modifiedCount || 0) > 0 });
        }
      } catch (err) {
        failed++;
        errors.push({ index: i, productId: String(productId), error: err.message });
      }
    }
    return {
      ok: true,
      kind: 'productBulkPatch',
      data: {
        brandId:   String(brand._id),
        brandName: brand.name,
        mode:      'explicit',
        total:     patches.length,
        succeeded,
        failed,
        results:   results.slice(0, 100),
        resultsTruncated: results.length > 100 ? results.length - 100 : 0,
        errors:    errors.slice(0, 25),
        errorsTruncated: errors.length > 25 ? errors.length - 25 : 0
      }
    };
  }

  // ── Branch B: filter + patch ──────────────────────────────────
  const norm = normalizePatch(args.patch);
  if (!norm.ok) return { ok: false, error: norm.error };

  let queryResolved;
  try {
    queryResolved = resolveFilter(args.filter || {}, {
      brandId:      brand._id,
      advertiserId: req.advertiserId
    });
  } catch (err) {
    return { ok: false, error: `filter resolution failed: ${err.message}` };
  }
  const scoped = queryResolved.query;

  // Count-first — refuse to write beyond the cap so a typo in
  // filter can't silently mass-patch the whole brand.
  const wouldMatch = await countForQuery(scoped);
  if (wouldMatch > MAX_BULK_PRODUCTS) {
    return {
      ok: false,
      error: `filter would match ${wouldMatch} products (> ${MAX_BULK_PRODUCTS}). Narrow the filter or use catalog.bulkDeleteProducts / a different capability.`,
      count: wouldMatch
    };
  }

  try {
    const r = await CatalogProduct.updateMany(scoped, { $set: norm.patch });
    return {
      ok: true,
      kind: 'productBulkPatch',
      data: {
        brandId:   String(brand._id),
        brandName: brand.name,
        mode:      'filter',
        matched:   r.matchedCount || 0,
        modified:  r.modifiedCount || 0,
        wouldMatch,
        patch:     norm.patch,
        warnings:  queryResolved.warnings
      }
    };
  } catch (err) {
    return { ok: false, error: `updateMany failed: ${err.message}` };
  }
}

module.exports = { run };
