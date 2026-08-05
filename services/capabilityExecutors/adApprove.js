// Executor for capability ad.approve (Tier 1, ad scope).
//
// Flip Ad.approved=true. Orthogonal to status (which tracks the render
// lifecycle); approval drives the Draft / Approved / Exported grouping
// on the Product Ads page. Reversible via ad.unapprove.
// Tenant-guarded via the brand lookup. Idempotent — approving an
// already-approved ad returns alreadyApproved:true.

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

  const ad = await Ad.findById(rawAdId).select('_id brandId approved approvedAt').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  if (ad.approved === true) {
    return {
      ok: true,
      kind: 'adUpdate',
      data: {
        _id: String(ad._id),
        brand: { _id: String(brand._id), name: brand.name },
        approved: true,
        approvedAt: ad.approvedAt || null,
        alreadyApproved: true
      }
    };
  }

  const approvedAt = new Date();
  const approvedBy = req.user?.userId || req.user?.email || null;
  await Ad.updateOne(
    { _id: ad._id },
    { $set: { approved: true, approvedAt, approvedBy, updatedAt: new Date() } }
  );

  return {
    ok: true,
    kind: 'adUpdate',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      approved: true,
      approvedAt,
      approvedBy
    }
  };
}

module.exports = { run };
