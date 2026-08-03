// Executor for capability ad.archive (Tier 1, ad scope).
//
// Cross-tenant guarded: the ad's brand must belong to req.advertiserId.
// Idempotent — archiving an already-archived ad returns ok:true with
// alreadyArchived:true so a double-click via chat doesn't error.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }

  const ad = await Ad.findById(rawAdId).select('_id status brandId').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };

  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  if (ad.status === 'archived') {
    return {
      ok: true,
      kind: 'adUpdate',
      data: {
        _id: String(ad._id),
        brand: { _id: String(brand._id), name: brand.name },
        status: 'archived',
        alreadyArchived: true
      }
    };
  }

  // rendering/queued ads can be archived — it just hides them from
  // active views. The queue drain skips archived rows, so this is
  // effectively a soft-cancel too. Deliberately no status-set gate.
  const priorStatus = ad.status;
  await Ad.updateOne(
    { _id: ad._id },
    { $set: { status: 'archived', updatedAt: new Date() } }
  );

  return {
    ok: true,
    kind: 'adUpdate',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      status: 'archived',
      priorStatus
    }
  };
}

module.exports = { run };
