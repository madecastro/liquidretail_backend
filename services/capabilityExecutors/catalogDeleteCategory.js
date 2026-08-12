// Executor for capability catalog.deleteCategory (Tier 1, brand scope).
//
// Modes:
//   • Default (soft): set Category.deletedAt = now. Historical
//     Media.matchedCategories entries still resolve by _id; wizard +
//     browser surfaces filter out.
//   • hardDelete: true — Mongo deleteOne after cascade cleanup.
//   • cascade: true (either mode) — includes every descendant in the
//     subtree. Without cascade, a Category with live children is
//     refused (safety net for typos like "delete the Apparel root").
//
// Cascade cleanup runs in BOTH soft and hard modes so downstream refs
// (CatalogProduct.categoryRef, Media.matchedCategories) stop pointing
// at hidden rows immediately.

'use strict';

const mongoose = require('mongoose');
const Category = require('../../models/Category');
const Brand = require('../../models/Brand');
const {
  findDescendantIds, cascadeCleanupOnDelete
} = require('../categoryBulkOps');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const categoryId = args?.categoryId;
  if (!categoryId) return { ok: false, error: 'categoryId required' };
  if (!mongoose.isValidObjectId(categoryId)) {
    return { ok: false, error: `categoryId "${categoryId}" is not a valid ObjectId` };
  }
  const hardDelete = args?.hardDelete === true;
  const cascade    = args?.cascade === true;

  const category = await Category.findOne({
    _id:          categoryId,
    advertiserId: req.advertiserId
  }).select('_id brandId breadcrumb deletedAt').lean();
  if (!category) return { ok: false, error: `category ${categoryId} not found` };

  const brand = await Brand.findById(category.brandId).select('_id name').lean();

  // Refuse-if-has-children unless cascade:true. Children are looked up
  // BEFORE we do any writes so a rejection state is clean.
  const descendants = await findDescendantIds([category._id], { includeDeleted: hardDelete });
  if (descendants.length > 0 && !cascade) {
    return {
      ok:    false,
      error: `refuse: category has ${descendants.length} descendant(s). Pass cascade:true to delete the whole subtree, or delete leaves first.`,
      descendantCount: descendants.length
    };
  }

  const ids = [String(category._id), ...descendants.map(String)];
  const cascadeSummary = await cascadeCleanupOnDelete(ids);

  let outcome;
  if (hardDelete) {
    await Category.deleteMany({
      _id:          { $in: ids },
      advertiserId: req.advertiserId
    });
    outcome = 'hard-deleted';
  } else {
    const now = new Date();
    await Category.updateMany(
      { _id: { $in: ids }, advertiserId: req.advertiserId, deletedAt: null },
      { $set: { deletedAt: now } }
    );
    outcome = category.deletedAt ? 'already-soft-deleted' : 'soft-deleted';
  }

  return {
    ok: true,
    kind: 'categoryDelete',
    data: {
      categoryId: String(category._id),
      breadcrumb: category.breadcrumb || null,
      brandId:    String(category.brandId),
      brandName:  brand?.name || null,
      outcome,
      hardDelete,
      cascade,
      descendantCount: descendants.length,
      cascadeSummary
    }
  };
}

module.exports = { run };
