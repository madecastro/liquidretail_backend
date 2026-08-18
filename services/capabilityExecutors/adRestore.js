// Executor for capability ad.restore (Tier 1, ad scope).
//
// Only reverses ad.archive — restores archived → draft. Refuses if the
// ad wasn't archived, so the operator sees a clear message instead of
// silently reflipping a live ad. Cross-tenant guarded.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
// THE un-archive write — one definition, shared with PATCH /api/ads/:id. It
// hands back the identityDigest that was released when the ad was archived.
// See services/adArchiveDigest.js.
const {
  restoreOneRestoringDigest,
  isDigestCollisionError,
  restoreTookEffect,
  DIGEST_COLLISION_MESSAGE,
  UNRESTORABLE_TOMBSTONE_MESSAGE
} = require('../adArchiveDigest');

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

  // ⚠️ MONEY — this is the path that makes restoring to 'queued' safe.
  // Archiving a never-billed row RELEASES its identityDigest to an
  // `archived:<_id>` tombstone so a later Generate can re-mint that identity
  // (see services/adArchiveDigest.js). Restoring without handing the real
  // digest back would put a live, claimable row into the queue carrying a fake
  // identity — and `selectAdsForRun` matches status:'queued', so it WOULD be
  // claimed and billed. The restore is therefore a digest move, not a status
  // flip.
  //
  // The move can legitimately fail: a repeat Generate may already have
  // re-minted that identity while this row sat archived, which is precisely
  // what freeing the slot is for. The (campaignId, identityDigest) unique index
  // rejects it with 11000 and the ad STAYS archived. Never swallow that and
  // leave the tombstone in place as a live digest.
  let restored;
  try {
    restored = await restoreOneRestoringDigest(
      Ad,
      { _id: ad._id },
      { status: restoredStatus, queryOptions: { new: true, lean: true } }
    );
  } catch (err) {
    if (isDigestCollisionError(err)) {
      return { ok: false, error: `ad ${rawAdId} ${DIGEST_COLLISION_MESSAGE}`, code: 'identity-digest-taken' };
    }
    throw err;
  }
  // The restore stage refuses to flip a tombstoned row that has no saved digest
  // to hand back — restoring it would put a placeholder identity on a live
  // (and, at 'queued', a CLAIMABLE and billable) ad. Report the refusal; never
  // return ok:true for a status that did not change.
  if (!restoreTookEffect(restored, restoredStatus)) {
    return { ok: false, error: `ad ${rawAdId} ${UNRESTORABLE_TOMBSTONE_MESSAGE}`, code: 'identity-digest-unrecoverable' };
  }

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
