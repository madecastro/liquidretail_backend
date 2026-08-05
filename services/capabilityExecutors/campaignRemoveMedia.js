// Executor for capability campaign.removeMedia (Tier 1, campaign scope).
//
// $pull mediaId from Campaign.mediaIds. Idempotent.

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.campaignId;
  const mediaId = args?.mediaId;
  if (!rawId)   return { ok: false, error: 'campaignId required' };
  if (!mediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `campaignId "${rawId}" is not a valid ObjectId` };
  }
  if (!mongoose.isValidObjectId(mediaId)) {
    return { ok: false, error: `mediaId "${mediaId}" is not a valid ObjectId` };
  }

  const updated = await Campaign.findOneAndUpdate(
    { _id: rawId, advertiserId: req.advertiserId },
    { $pull: { mediaIds: mediaId } },
    { new: true }
  ).select('mediaIds').lean();
  if (!updated) return { ok: false, error: `campaign ${rawId} not found` };

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(rawId),
      removed: mediaId,
      total: (updated.mediaIds || []).length
    }
  };
}

module.exports = { run };
