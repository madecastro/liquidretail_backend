// Executor for capability ad.restore (Tier 1, ad scope).
//
// Only reverses ad.archive — restores archived → draft. Refuses if the
// ad wasn't archived, so the operator sees a clear message instead of
// silently reflipping a live ad. Cross-tenant guarded.

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

  const ad = await Ad.findById(rawAdId).select('_id status brandId renderUrl').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };

  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  if (ad.status !== 'archived') {
    return { ok: false, error: `ad ${rawAdId} is not archived (current status: ${ad.status})` };
  }

  // Restore to 'draft' if there's a renderUrl (i.e. the ad was fully
  // rendered before archiving), otherwise back to 'queued' so the
  // render pipeline picks it up on the next drain. A restored 'draft'
  // that has no renderUrl would sit in operator views looking broken.
  const restoredStatus = ad.renderUrl ? 'draft' : 'queued';
  await Ad.updateOne(
    { _id: ad._id },
    { $set: { status: restoredStatus, updatedAt: new Date() } }
  );

  return {
    ok: true,
    kind: 'adUpdate',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      status: restoredStatus,
      priorStatus: 'archived'
    }
  };
}

module.exports = { run };
