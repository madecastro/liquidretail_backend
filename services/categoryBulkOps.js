// Shared helpers for the Category bulk-ops capabilities. Parallels
// services/catalogBulkOps.js (for CatalogProduct). Same cap, same
// filter+cascade contract, same tenant-scoping. Splitting the two
// helpers keeps each Mongo collection's cascade in ONE file so a
// schema change to either doesn't force reading both.
//
// Filter DSL:
//   { categoryIds?, breadcrumbKeys?, depth?, hasProducts?, hasNoProducts? }
//   • categoryIds trumps the semantic keys (identical rule to
//     catalogBulkOps).
//   • breadcrumbKeys accepts normalized paths ("apparel>shirts") and
//     is joined with $in for union.
//   • depth is exact-match (0 = top-level, 1 = second-level, ...).
//   • hasProducts / hasNoProducts require an aggregation join so are
//     handled separately from the simple mongo filter — see
//     resolveFilter below.
//
// Refuse-if-has-children policy:
//   catalog.deleteCategory / catalog.bulkDeleteCategories refuse to
//   remove a Category with live descendants unless {cascade: true} is
//   passed. Descendant lookup is via Category.parentId. Same policy
//   for both soft and hard delete — hiding a parent while leaves stay
//   visible would leave the picker with orphaned depth-1 rows.
//
// Cascade cleanup:
//   For every deleted Category id:
//     CatalogProduct.categoryRef  → set to null (product survives,
//                                   loses its category filter home)
//     Media.matchedCategories     → pull entries whose categoryId
//                                   matches (subdoc array)
//   Never fatal per-collection: a Media write failure logs + moves on
//   so a CatalogProduct write still happens.

'use strict';

const mongoose = require('mongoose');
const Category = require('../models/Category');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');

const MAX_BULK_CATEGORIES = 500;

// Same fail-fast tenant guard shape catalogBulkOps uses.
function resolveFilter(filter, { brandId, advertiserId, includeDeleted = false } = {}) {
  const warnings = [];
  if (!brandId)      throw new Error('resolveFilter: brandId required');
  if (!advertiserId) throw new Error('resolveFilter: advertiserId required');

  const query = { advertiserId, brandId };
  if (!includeDeleted) query.deletedAt = null;

  const f = filter || {};

  // Explicit ids trump semantic filters (same rule as products).
  if (Array.isArray(f.categoryIds)) {
    const oids = [];
    for (const id of f.categoryIds) {
      if (mongoose.isValidObjectId(id)) oids.push(new mongoose.Types.ObjectId(String(id)));
      else warnings.push(`categoryIds: dropped invalid ObjectId "${String(id).slice(0, 40)}"`);
    }
    query._id = oids.length ? { $in: oids } : { $in: [] };
    return { query, warnings, needsProductJoin: false };
  }

  if (Array.isArray(f.breadcrumbKeys) && f.breadcrumbKeys.length) {
    query.breadcrumbKey = { $in: f.breadcrumbKeys.map(String) };
  }
  if (Number.isInteger(f.depth)) {
    query.depth = f.depth;
  }

  // hasProducts / hasNoProducts require a post-filter product join.
  // Signalled via needsProductJoin — the caller can decide to run a
  // separate CatalogProduct.distinct('categoryRef') aggregate and
  // intersect / subtract.
  const needsProductJoin =
    f.hasProducts === true || f.hasNoProducts === true;

  return { query, warnings, needsProductJoin, filter: f };
}

async function countForQuery(query) {
  return Category.countDocuments(query);
}

// hasProducts / hasNoProducts post-filter. Given a raw category list
// and the flag, returns the ids that pass. Kept OUT of resolveFilter
// so the plain-Mongo query stays index-friendly for the common case
// (delete by explicit id / breadcrumb).
async function applyProductRefFilter({ categoryIds, hasProducts, hasNoProducts, brandId, advertiserId }) {
  if (!hasProducts && !hasNoProducts) return categoryIds;
  const oids = categoryIds.map(id => new mongoose.Types.ObjectId(String(id)));
  const withProducts = await CatalogProduct.aggregate([
    { $match: {
        advertiserId,
        brandId:      brandId instanceof mongoose.Types.ObjectId
                        ? brandId
                        : new mongoose.Types.ObjectId(String(brandId)),
        categoryRef:  { $in: oids },
        deletedAt:    null
    } },
    { $group: { _id: '$categoryRef' } }
  ]);
  const withSet = new Set(withProducts.map(r => String(r._id)));
  if (hasProducts) return categoryIds.filter(id => withSet.has(String(id)));
  return categoryIds.filter(id => !withSet.has(String(id)));
}

// Descendants lookup — refuse-if-has-children policy leans on this.
// Optionally recursive (default true so a two-level branch flips the
// refusal as expected). Skips soft-deleted descendants unless
// includeDeleted:true (delete-when-cascade-true wants to know about
// them so they can be soft-deleted too).
async function findDescendantIds(parentIds, { includeDeleted = false } = {}) {
  const seen = new Set(parentIds.map(String));
  const queue = parentIds.map(id =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
  );
  const result = [];
  while (queue.length) {
    const batch = queue.splice(0, 100);
    const filter = { parentId: { $in: batch } };
    if (!includeDeleted) filter.deletedAt = null;
    const kids = await Category.find(filter).select('_id').lean();
    for (const k of kids) {
      const s = String(k._id);
      if (seen.has(s)) continue;
      seen.add(s);
      result.push(k._id);
      queue.push(k._id);
    }
  }
  return result;
}

// Cascade cleanup for delete. Per-collection best-effort; never
// throws. Returns counts so the operator sees the blast radius.
async function cascadeCleanupOnDelete(categoryIds) {
  const summary = { products: 0, media: 0 };
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return summary;

  const asOids = categoryIds
    .filter(id => mongoose.isValidObjectId(id))
    .map(id => new mongoose.Types.ObjectId(String(id)));

  // CatalogProduct.categoryRef — ObjectId scalar. Set to null so the
  // product survives the delete (with no category filter home) rather
  // than being deleted.
  try {
    const r = await CatalogProduct.updateMany(
      { categoryRef: { $in: asOids } },
      { $set: { categoryRef: null } }
    );
    summary.products = r.modifiedCount || 0;
  } catch (err) {
    console.warn(`   ⚠️  cascadeCleanupOnDelete (Category): CatalogProduct.categoryRef unset failed: ${err.message}`);
  }

  // Media.matchedCategories — subdoc array; pull entries where the
  // subdoc's categoryId is in the set.
  try {
    const r = await Media.updateMany(
      { 'matchedCategories.categoryId': { $in: asOids } },
      { $pull: { matchedCategories: { categoryId: { $in: asOids } } } }
    );
    summary.media = r.modifiedCount || 0;
  } catch (err) {
    console.warn(`   ⚠️  cascadeCleanupOnDelete (Category): Media.matchedCategories pull failed: ${err.message}`);
  }

  return summary;
}

module.exports = {
  MAX_BULK_CATEGORIES,
  resolveFilter,
  countForQuery,
  applyProductRefFilter,
  findDescendantIds,
  cascadeCleanupOnDelete
};
