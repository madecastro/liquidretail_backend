// Executor for capability catalog.bulkDeleteCategories (Tier 4, brand
// scope). Same T4 rationale as catalog.bulkDeleteProducts: a bad
// filter can nuke the whole picker.
//
// Two shapes:
//   { brandId, categoryIds: [...] }         explicit
//   { brandId, filter }                     filter DSL
//
// hardDelete:true — Mongo deleteMany after cascade cleanup.
// cascade:true — includes every descendant per delete-target. Without
// cascade, targets with live children are REPORTED in `refused[]` and
// skipped; the operation still applies to the ones that CAN safely
// be removed.
//
// Count-first cap check: the filter branch resolves the target set
// (including any descendants under cascade:true) and refuses if it
// exceeds MAX_BULK_CATEGORIES. No partial writes on typos.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Category = require('../../models/Category');
const {
  MAX_BULK_CATEGORIES, resolveFilter, countForQuery,
  applyProductRefFilter, findDescendantIds, cascadeCleanupOnDelete
} = require('../categoryBulkOps');

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

  const hardDelete    = args?.hardDelete === true;
  const cascade       = args?.cascade === true;
  const hasCategoryIds = Array.isArray(args?.categoryIds);
  const hasFilter      = !!args?.filter;
  if (!hasCategoryIds && !hasFilter) {
    return { ok: false, error: 'either categoryIds[] or filter required' };
  }
  if (hasCategoryIds && hasFilter) {
    return { ok: false, error: 'pass EITHER categoryIds[] OR filter, not both' };
  }

  let queryResolved;
  try {
    queryResolved = resolveFilter(
      hasCategoryIds ? { categoryIds: args.categoryIds } : args.filter || {},
      { brandId: brand._id, advertiserId: req.advertiserId, includeDeleted: hardDelete }
    );
  } catch (err) {
    return { ok: false, error: `filter resolution failed: ${err.message}` };
  }
  const scoped = queryResolved.query;

  // First-pass: resolve to concrete ids so descendant + hasProducts
  // filters can run.
  const firstPass = await Category.find(scoped).select('_id').lean();
  let targetIds = firstPass.map(d => String(d._id));

  // hasProducts / hasNoProducts post-filter.
  if (queryResolved.needsProductJoin) {
    const asOids = targetIds.map(id => new mongoose.Types.ObjectId(id));
    targetIds = (await applyProductRefFilter({
      categoryIds:  asOids,
      hasProducts:  queryResolved.filter.hasProducts === true,
      hasNoProducts: queryResolved.filter.hasNoProducts === true,
      brandId:      brand._id,
      advertiserId: req.advertiserId
    })).map(String);
  }

  if (targetIds.length === 0) {
    return {
      ok: true,
      kind: 'categoryBulkDelete',
      data: {
        brandId:    String(brand._id),
        brandName:  brand.name,
        mode:       hasCategoryIds ? 'explicit' : 'filter',
        hardDelete,
        cascade,
        wouldDelete: 0,
        deleted:     0,
        refused:     [],
        cascadeSummary: { products: 0, media: 0 },
        note:        'no categories matched — nothing to delete',
        warnings:    queryResolved.warnings
      }
    };
  }

  // Descendant expansion. Under cascade:true every child gets swept.
  // Without cascade, targets with children are REFUSED (reported +
  // skipped, not fatal — the safe ones still delete).
  const refused = [];
  let expandedIds = new Set(targetIds);
  for (const id of targetIds) {
    const kids = await findDescendantIds([id], { includeDeleted: hardDelete });
    if (kids.length > 0) {
      if (cascade) {
        for (const k of kids) expandedIds.add(String(k));
      } else {
        refused.push({ categoryId: id, reason: 'has-children', descendantCount: kids.length });
      }
    }
  }
  if (!cascade && refused.length > 0) {
    // Remove refused targets from the write set.
    for (const r of refused) expandedIds.delete(r.categoryId);
  }
  const writeSet = [...expandedIds];

  if (writeSet.length > MAX_BULK_CATEGORIES) {
    return {
      ok: false,
      error: `would delete ${writeSet.length} categories (> ${MAX_BULK_CATEGORIES}). Narrow the filter and re-run in chunks.`,
      count: writeSet.length,
      refused
    };
  }

  if (writeSet.length === 0) {
    return {
      ok: true,
      kind: 'categoryBulkDelete',
      data: {
        brandId:    String(brand._id),
        brandName:  brand.name,
        mode:       hasCategoryIds ? 'explicit' : 'filter',
        hardDelete,
        cascade,
        wouldDelete: 0,
        deleted:     0,
        refused,
        cascadeSummary: { products: 0, media: 0 },
        note:        'every matched category has children and cascade was not set',
        warnings:    queryResolved.warnings
      }
    };
  }

  const cascadeSummary = await cascadeCleanupOnDelete(writeSet);

  let deleted;
  if (hardDelete) {
    const r = await Category.deleteMany({ _id: { $in: writeSet }, advertiserId: req.advertiserId });
    deleted = r.deletedCount || 0;
  } else {
    const now = new Date();
    const r = await Category.updateMany(
      { _id: { $in: writeSet }, advertiserId: req.advertiserId, deletedAt: null },
      { $set: { deletedAt: now } }
    );
    deleted = r.modifiedCount || 0;
  }

  return {
    ok: true,
    kind: 'categoryBulkDelete',
    data: {
      brandId:    String(brand._id),
      brandName:  brand.name,
      mode:       hasCategoryIds ? 'explicit' : 'filter',
      hardDelete,
      cascade,
      wouldDelete: writeSet.length,
      deleted,
      refused,
      cascadeSummary,
      warnings:   queryResolved.warnings
    }
  };
}

module.exports = { run };
