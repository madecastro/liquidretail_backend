// Executor for capability campaign.addProducts (Tier 1, campaign scope).
//
// $addToSet the given productIds onto Campaign.matchedProductIds. Silently
// drops product ids that don't belong to the same brand (mirrors the
// route handler). Idempotent — re-adding an existing product is a no-op.

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');
const CatalogProduct = require('../../models/CatalogProduct');

const MAX_IDS_PER_CALL = 200;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.campaignId;
  if (!rawId) return { ok: false, error: 'campaignId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `campaignId "${rawId}" is not a valid ObjectId` };
  }

  const productIds = Array.isArray(args?.productIds) ? args.productIds : null;
  if (!productIds) return { ok: false, error: 'productIds must be an array' };
  if (productIds.length === 0) return { ok: false, error: 'productIds cannot be empty' };
  if (productIds.length > MAX_IDS_PER_CALL) {
    return { ok: false, error: `too many productIds (${productIds.length} > ${MAX_IDS_PER_CALL})` };
  }

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId })
    .select('_id brandId matchedProductIds').lean();
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };

  const valid = await CatalogProduct.find({ _id: { $in: productIds }, brandId: c.brandId })
    .select('_id').lean();
  const validIds = valid.map((p) => p._id);
  const validStr = validIds.map(String);
  const droppedIds = productIds.filter((id) => !validStr.includes(String(id)));

  if (validIds.length === 0) {
    return {
      ok: true,
      kind: 'campaignUpdate',
      data: {
        _id: String(c._id),
        added: 0,
        total: (c.matchedProductIds || []).length,
        droppedProductIds: droppedIds,
        note: 'no valid products for this brand'
      }
    };
  }

  const updated = await Campaign.findByIdAndUpdate(
    c._id,
    { $addToSet: { matchedProductIds: { $each: validIds } } },
    { new: true }
  ).select('matchedProductIds').lean();

  const priorCount = (c.matchedProductIds || []).length;
  const nextCount  = (updated?.matchedProductIds || []).length;

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(c._id),
      added: nextCount - priorCount,
      requested: productIds.length,
      total: nextCount,
      droppedProductIds: droppedIds
    }
  };
}

module.exports = { run };
