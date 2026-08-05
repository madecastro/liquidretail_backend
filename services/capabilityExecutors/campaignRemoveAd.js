// Executor for capability campaign.removeAd (Tier 1, campaign scope).
//
// UNLINK an ad from a campaign — sets Ad.campaignId = null. The Ad doc
// and its rendered asset stay; only the campaign association is dropped.
// Mirrors the route handler behavior.

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');
const Ad = require('../../models/Ad');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.campaignId;
  const adId = args?.adId;
  if (!rawId) return { ok: false, error: 'campaignId required' };
  if (!adId)  return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `campaignId "${rawId}" is not a valid ObjectId` };
  }
  if (!mongoose.isValidObjectId(adId)) {
    return { ok: false, error: `adId "${adId}" is not a valid ObjectId` };
  }

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId })
    .select('_id brandId').lean();
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };

  const ad = await Ad.findOneAndUpdate(
    { _id: adId, campaignId: c._id, brandId: c.brandId },
    { campaignId: null, updatedAt: new Date() },
    { new: true }
  ).select('_id').lean();
  if (!ad) return { ok: false, error: `ad ${adId} not found in this campaign` };

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(rawId),
      unlinkedAdId: adId,
      note: 'Ad remains in the brand; only the campaign association was cleared.'
    }
  };
}

module.exports = { run };
