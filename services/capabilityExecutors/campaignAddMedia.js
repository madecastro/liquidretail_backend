// Executor for capability campaign.addMedia (Tier 1, campaign scope).
//
// $addToSet the given mediaIds onto Campaign.mediaIds. Drops media
// that don't belong to the same brand. Idempotent.

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');
const Media = require('../../models/Media');

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

  const mediaIds = Array.isArray(args?.mediaIds) ? args.mediaIds : null;
  if (!mediaIds) return { ok: false, error: 'mediaIds must be an array' };
  if (mediaIds.length === 0) return { ok: false, error: 'mediaIds cannot be empty' };
  if (mediaIds.length > MAX_IDS_PER_CALL) {
    return { ok: false, error: `too many mediaIds (${mediaIds.length} > ${MAX_IDS_PER_CALL})` };
  }

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId })
    .select('_id brandId mediaIds').lean();
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };

  const valid = await Media.find({ _id: { $in: mediaIds }, brandId: c.brandId })
    .select('_id').lean();
  const validIds = valid.map((m) => m._id);
  const validStr = validIds.map(String);
  const droppedIds = mediaIds.filter((id) => !validStr.includes(String(id)));

  if (validIds.length === 0) {
    return {
      ok: true,
      kind: 'campaignUpdate',
      data: {
        _id: String(c._id),
        added: 0,
        total: (c.mediaIds || []).length,
        droppedMediaIds: droppedIds,
        note: 'no valid media for this brand'
      }
    };
  }

  const updated = await Campaign.findByIdAndUpdate(
    c._id,
    { $addToSet: { mediaIds: { $each: validIds } } },
    { new: true }
  ).select('mediaIds').lean();

  const priorCount = (c.mediaIds || []).length;
  const nextCount  = (updated?.mediaIds || []).length;

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(c._id),
      added: nextCount - priorCount,
      requested: mediaIds.length,
      total: nextCount,
      droppedMediaIds: droppedIds
    }
  };
}

module.exports = { run };
