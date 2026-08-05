// Executor for capability ad.delete (Tier 3, ad scope).
//
// Hard-delete an Ad doc + best-effort destroy the Cloudinary render
// asset. Mirrors DELETE /api/ads/:id. Tier 3 because the delete is
// irreversible: the Cloudinary asset is gone, and the render can't
// be reconstituted without re-billing generation. Requires the
// explicit phrase "DELETE AD" typed in the confirmation UI.
//
// Refuses synced-to-Meta ads (would leave a dangling Meta creative
// with no local record).

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
const { deleteFromCloudinary } = require('../cloudinaryService');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }

  const ad = await Ad.findById(rawAdId)
    .select('_id brandId renderUrl metaSyncStatus template aspectRatio').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  if (ad.metaSyncStatus === 'synced') {
    return { ok: false, error: 'ad has been synced to Meta — delete would leave a dangling Meta creative with no local record. Pause in Meta Ads Manager instead.' };
  }

  const deleted = await Ad.findOneAndDelete({ _id: ad._id, brandId: ad.brandId }).lean();
  if (!deleted) return { ok: false, error: `ad ${rawAdId} not found (concurrent delete?)` };

  let cloudinary = null;
  if (ad.renderUrl) {
    try {
      cloudinary = await deleteFromCloudinary(ad.renderUrl);
    } catch (err) {
      // Cloudinary errors are warnings — the Ad doc is gone, and an
      // orphaned Cloudinary asset is easier to clean up later than an
      // orphaned Ad doc pointing at a dead URL.
      cloudinary = { ok: false, error: err?.message || 'cloudinary destroy failed' };
    }
  }

  return {
    ok: true,
    kind: 'adDelete',
    data: {
      _id: String(ad._id),
      brand:      { _id: String(brand._id), name: brand.name },
      template:   ad.template,
      aspectRatio: ad.aspectRatio,
      hadRenderUrl: !!ad.renderUrl,
      cloudinary
    }
  };
}

module.exports = { run };
