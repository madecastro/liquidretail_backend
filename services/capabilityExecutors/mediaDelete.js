// Executor for capability media.delete (Tier 1, brand scope).
//
// SOFT-DELETE. Sets Media.deletedAt to now. The Media Library LIST
// endpoint filters deletedAt:null, so a deleted row disappears from
// the picker; direct-id lookups still resolve, so any Ad or Campaign
// row that already references this Media keeps rendering with the
// original asset.
//
// Reversible via media.restore (future capability) or a direct DB
// $unset. The Cloudinary asset is NOT destroyed here — the destructive
// cascade path stays on the REST DELETE /api/media/:id route behind
// the operator's own hands. Agent-driven deletes are intentionally
// non-destructive.

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }

  const media = await Media.findOne({ _id: rawMediaId, advertiserId: req.advertiserId })
    .select('_id brandId fileType source deletedAt externalId fileName');
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };

  if (media.deletedAt) {
    return {
      ok: true,
      kind: 'mediaUpdate',
      data: {
        _id: String(media._id),
        brandId: media.brandId ? String(media.brandId) : null,
        deletedAt: media.deletedAt,
        alreadyDeleted: true,
        note: 'Media was already soft-deleted; no change.'
      }
    };
  }

  const now = new Date();
  await Media.updateOne({ _id: media._id }, { $set: { deletedAt: now } });

  return {
    ok: true,
    kind: 'mediaUpdate',
    data: {
      _id: String(media._id),
      brandId: media.brandId ? String(media.brandId) : null,
      fileName: media.fileName || null,
      externalId: media.externalId || null,
      deletedAt: now,
      note: 'Soft-deleted. Removed from the Media Library list; existing ads that reference it keep rendering. Cloudinary asset kept intact.'
    }
  };
}

module.exports = { run };
