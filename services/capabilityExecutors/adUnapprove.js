// Executor for capability ad.unapprove (Tier 1, ad scope).
//
// Reverse of ad.approve. Clears Ad.approved + approvedAt + approvedBy.
// Idempotent.

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

  const ad = await Ad.findById(rawAdId).select('_id brandId approved').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  if (ad.approved !== true) {
    return {
      ok: true,
      kind: 'adUpdate',
      data: {
        _id: String(ad._id),
        brand: { _id: String(brand._id), name: brand.name },
        approved: false,
        alreadyUnapproved: true
      }
    };
  }

  await Ad.updateOne(
    { _id: ad._id },
    { $set: { approved: false, approvedAt: null, approvedBy: null, updatedAt: new Date() } }
  );

  return {
    ok: true,
    kind: 'adUpdate',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      approved: false
    }
  };
}

module.exports = { run };
