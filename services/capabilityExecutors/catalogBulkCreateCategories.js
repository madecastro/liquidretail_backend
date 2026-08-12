// Executor for capability catalog.bulkCreateCategories (Tier 1, brand
// scope).
//
// Takes an array of breadcrumb STRINGS (single terms or rich paths
// with ' > ' separators) and upserts the Category tree for each via
// findOrCreateCategoryTree. Same helper the ingest paths use — idempotent
// on (brandId, breadcrumbKey). A depth-2 breadcrumb "Apparel > Tops >
// Shirts" upserts three rows.
//
// Per-row failures are non-fatal — response reports { succeeded,
// failed, errors[] } so operators can retry the failed rows without
// re-doing the succeeded ones. Cap: MAX_BULK_CATEGORIES (500) —
// applied to the input array, not to the total number of upserted
// nodes (a 500-item array with depth-4 breadcrumbs is 2000 upserts,
// still fine).

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Category = require('../../models/Category');
const { MAX_BULK_CATEGORIES } = require('../categoryBulkOps');

const { findOrCreateCategoryTree } = Category;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const breadcrumbs = Array.isArray(args?.breadcrumbs) ? args.breadcrumbs : null;
  if (!breadcrumbs || breadcrumbs.length === 0) {
    return { ok: false, error: 'breadcrumbs[] required (non-empty)' };
  }
  if (breadcrumbs.length > MAX_BULK_CATEGORIES) {
    return {
      ok: false,
      error: `breadcrumbs[] too large (${breadcrumbs.length} > ${MAX_BULK_CATEGORIES}). Chunk into smaller batches.`
    };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name advertiserId').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  let succeeded = 0;
  let failed    = 0;
  const errors  = [];
  const results = [];

  for (let i = 0; i < breadcrumbs.length; i++) {
    const raw = breadcrumbs[i];
    if (typeof raw !== 'string' || !raw.trim()) {
      failed++;
      errors.push({ index: i, error: 'breadcrumb must be a non-empty string' });
      continue;
    }
    const breadcrumb = raw.trim();
    if (breadcrumb.length > 2000) {
      failed++;
      errors.push({ index: i, error: `breadcrumb too long (${breadcrumb.length} > 2000)` });
      continue;
    }
    try {
      const leafId = await findOrCreateCategoryTree({
        brandId:      brand._id,
        advertiserId: req.advertiserId,
        breadcrumb,
        url:          null,
        firstSeenMediaId: null
      });
      if (!leafId) {
        failed++;
        errors.push({ index: i, breadcrumb, error: 'findOrCreateCategoryTree returned null (empty segments?)' });
        continue;
      }
      succeeded++;
      results.push({ index: i, breadcrumb, categoryId: String(leafId) });
    } catch (err) {
      failed++;
      errors.push({ index: i, breadcrumb, error: err.message });
    }
  }

  return {
    ok: true,
    kind: 'categoryBulkCreate',
    data: {
      brandId:   String(brand._id),
      brandName: brand.name,
      total:     breadcrumbs.length,
      succeeded,
      failed,
      results:   results.slice(0, 100),
      resultsTruncated: results.length > 100 ? results.length - 100 : 0,
      errors:    errors.slice(0, 25),
      errorsTruncated: errors.length > 25 ? errors.length - 25 : 0
    }
  };
}

module.exports = { run };
