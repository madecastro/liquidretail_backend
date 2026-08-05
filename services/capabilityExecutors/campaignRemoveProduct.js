// Executor for capability campaign.removeProduct (Tier 1, campaign scope).
//
// $pull the given productId from Campaign.matchedProductIds. Idempotent —
// removing an already-absent product is a no-op (returns the current
// total).

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.campaignId;
  const productId = args?.productId;
  if (!rawId)     return { ok: false, error: 'campaignId required' };
  if (!productId) return { ok: false, error: 'productId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `campaignId "${rawId}" is not a valid ObjectId` };
  }
  if (!mongoose.isValidObjectId(productId)) {
    return { ok: false, error: `productId "${productId}" is not a valid ObjectId` };
  }

  const updated = await Campaign.findOneAndUpdate(
    { _id: rawId, advertiserId: req.advertiserId },
    { $pull: { matchedProductIds: productId } },
    { new: true }
  ).select('matchedProductIds').lean();
  if (!updated) return { ok: false, error: `campaign ${rawId} not found` };

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(rawId),
      removed: productId,
      total: (updated.matchedProductIds || []).length
    }
  };
}

module.exports = { run };
