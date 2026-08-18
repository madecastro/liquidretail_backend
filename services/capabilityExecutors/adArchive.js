// Executor for capability ad.archive (Tier 1, ad scope).
//
// Cross-tenant guarded: the ad's brand must belong to req.advertiserId.
// Idempotent — archiving an already-archived ad returns ok:true with
// alreadyArchived:true so a double-click via chat doesn't error.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
// THE archive write — one definition, imported by every archive site. Never a
// bare $set: the helper also releases the row's identityDigest so an archived
// NEVER-BILLED identity stops squatting its slot on the (campaignId,
// identityDigest) unique index. See services/adArchiveDigest.js.
const { archiveAdsReleasingDigest } = require('../adArchiveDigest');

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
  //
  // ⚠️ MONEY — and why there is deliberately no receipt filter here either.
  // This capability MUST be able to archive a delivered or paid ad; that is
  // the operator's whole intent. So unlike the Stop handler and the 24h
  // sweeper, the filter carries no receipt-free / renderUrl guard. The digest
  // release is guarded instead PER DOCUMENT inside archiveAdsReleasingDigest:
  // a row holding a spend receipt or a renderUrl is archived normally and
  // KEEPS its identityDigest, so the unique index goes on protecting that paid
  // identity from being re-minted and re-billed. Only a never-billed,
  // never-delivered row has its slot freed. Reversible via ad.restore.
  const priorStatus = ad.status;
  await archiveAdsReleasingDigest(Ad, { _id: ad._id });

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
