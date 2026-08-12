// Shared helpers for the catalog bulk-ops capabilities (bulkCreate,
// bulkPatch, bulkDelete, and the single-row deleteProduct). Two
// jobs:
//
//   1. resolveFilter(filter, brandContext) — turns the operator-
//      facing filter DSL into a Mongo query. Always tenant-scoped
//      (advertiserId + brandId) and always guarded on
//      deletedAt:null unless the caller explicitly opts in via
//      `includeDeleted`.
//
//   2. cascadeCleanupOnDelete(productIds) — pulls the ids out of
//      every collection that references them so a hard delete
//      doesn't leave dangling references:
//        Campaign.matchedProductIds (pull)
//        Campaign.mediaIds          — not touched (media, not products)
//        Media.matchedProducts      (pull by catalogProductId)
//        Ad.productId               (unset — Ad rows keep for history
//                                    but stop pointing at the id)
//      Same class of cleanup as services/cascadeDeleteService.js
//      does for whole-brand deletes, but scoped to a specific set of
//      product ids.
//
// MAX_BULK_PRODUCTS is exported here so every executor caps at the
// same number — 500. Enough for real batch work, small enough that a
// bad filter typo can't nuke a 50k catalog in one call.

'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../models/CatalogProduct');
const Campaign = require('../models/Campaign');
const Media = require('../models/Media');
const Ad = require('../models/Ad');

const MAX_BULK_PRODUCTS = 500;

// Operator-facing filter DSL. Every key is optional; a call with just
// `{brandId, advertiserId, filter: {}}` matches every product on the
// brand (except tombstones). productIds trumps the semantic filters —
// when set, other keys are ignored.
//
// Returns { query, warnings[] }. Warnings surface non-fatal skips
// (invalid ObjectIds, unrecognized keys) so the executor can pass
// them back to the operator without failing the whole call.
function resolveFilter(filter, { brandId, advertiserId, includeDeleted = false } = {}) {
  const warnings = [];
  if (!brandId)      throw new Error('resolveFilter: brandId required');
  if (!advertiserId) throw new Error('resolveFilter: advertiserId required');

  const query = {
    advertiserId,
    brandId
  };
  // Soft-delete guard by default. Opt-in `includeDeleted:true` skips
  // it — used by hardDelete paths that need to see tombstones so a
  // subsequent soft-delete of a still-soft-deleted row bumps the
  // deletedAt to now (idempotency friendliness).
  if (!includeDeleted) query.deletedAt = null;

  const f = filter || {};

  // Explicit-ids branch trumps everything else. Empty array is a
  // valid (0-hit) query — resolve to a never-match sentinel so the
  // caller doesn't accidentally nuke the whole brand.
  if (Array.isArray(f.productIds)) {
    const oids = [];
    for (const id of f.productIds) {
      if (mongoose.isValidObjectId(id)) oids.push(new mongoose.Types.ObjectId(String(id)));
      else warnings.push(`productIds: dropped invalid ObjectId "${String(id).slice(0, 40)}"`);
    }
    query._id = oids.length ? { $in: oids } : { $in: [] };
    return { query, warnings };
  }

  if (typeof f.category === 'string' && f.category.trim()) {
    query.category = f.category.trim();
  }
  if (Array.isArray(f.categoryRefs) && f.categoryRefs.length) {
    const oids = [];
    for (const id of f.categoryRefs) {
      if (mongoose.isValidObjectId(id)) oids.push(new mongoose.Types.ObjectId(String(id)));
      else warnings.push(`categoryRefs: dropped invalid ObjectId "${String(id).slice(0, 40)}"`);
    }
    if (oids.length) query.categoryRef = { $in: oids };
  }
  if (typeof f.source === 'string' && f.source.trim()) {
    query.source = f.source.trim();
  }
  if (typeof f.draft === 'boolean') {
    query.draft = f.draft;
  }
  if (typeof f.lastSyncedBefore === 'string') {
    const d = new Date(f.lastSyncedBefore);
    if (Number.isFinite(d.getTime())) {
      query.lastSyncedAt = { $lt: d };
    } else {
      warnings.push(`lastSyncedBefore: dropped unparseable date "${f.lastSyncedBefore}"`);
    }
  }

  return { query, warnings };
}

// Bounded head-count for a resolved query. Executors call this
// BEFORE mutating so they can refuse a filter that would exceed the
// cap (rather than partial-write the first 500 rows and stop).
async function countForQuery(query) {
  return CatalogProduct.countDocuments(query);
}

// Cascade cleanup — removes the given product ids from every
// collection that stores them as a reference. Non-fatal per-collection:
// a Campaign write failure logs + continues so a Media cleanup still
// runs.
//
// Returns per-collection counts so the operator can see the blast
// radius: { campaigns: N, media: N, ads: N }.
async function cascadeCleanupOnDelete(productIds) {
  const summary = { campaigns: 0, media: 0, ads: 0 };
  if (!Array.isArray(productIds) || productIds.length === 0) return summary;

  // ObjectId + String forms — different schemas use different types
  // for these back-references, so run both.
  const asOids = productIds
    .filter(id => mongoose.isValidObjectId(id))
    .map(id => new mongoose.Types.ObjectId(String(id)));
  const asStrings = productIds.map(String);

  // Campaign.matchedProductIds — String array on the schema.
  try {
    const r = await Campaign.updateMany(
      { matchedProductIds: { $in: asStrings } },
      { $pull: { matchedProductIds: { $in: asStrings } } }
    );
    summary.campaigns = r.modifiedCount || 0;
  } catch (err) {
    console.warn(`   ⚠️  cascadeCleanupOnDelete: Campaign.matchedProductIds pull failed: ${err.message}`);
  }

  // Media.matchedProducts — subdoc array; the ref is catalogProductId
  // (ObjectId).
  try {
    const r = await Media.updateMany(
      { 'matchedProducts.catalogProductId': { $in: asOids } },
      { $pull: { matchedProducts: { catalogProductId: { $in: asOids } } } }
    );
    summary.media = r.modifiedCount || 0;
  } catch (err) {
    console.warn(`   ⚠️  cascadeCleanupOnDelete: Media.matchedProducts pull failed: ${err.message}`);
  }

  // Ad.productId — ObjectId. Do NOT delete the Ad (historical
  // artifact); just unset the productId so the Ads page + regenerate
  // path stop resolving to a deleted row.
  try {
    const r = await Ad.updateMany(
      { productId: { $in: asOids } },
      { $set: { productId: null } }
    );
    summary.ads = r.modifiedCount || 0;
  } catch (err) {
    console.warn(`   ⚠️  cascadeCleanupOnDelete: Ad.productId unset failed: ${err.message}`);
  }

  return summary;
}

module.exports = {
  MAX_BULK_PRODUCTS,
  resolveFilter,
  countForQuery,
  cascadeCleanupOnDelete
};
