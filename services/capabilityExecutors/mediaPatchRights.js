// Executor for capability media.patchRights (Tier 1, brand scope).
//
// Toggles Media.rights.approved — the flag the layout generator reads
// before letting a UGC frame carry ugc.rights_approved=true on the
// creative input. Same shape as PATCH /api/media/:mediaId/rights;
// approvedBy defaults to the caller when the LLM omits it (matches the
// route's fallback), and approvedAt is stamped server-side on approve
// / cleared on unapprove so history doesn't linger misleadingly.

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');

const MAX_NOTES_LEN = 2000;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }
  const approved = args?.approved;
  if (typeof approved !== 'boolean') {
    return { ok: false, error: 'approved (boolean) required' };
  }
  const approvedBy = args?.approvedBy;
  if (approvedBy != null && typeof approvedBy !== 'string') {
    return { ok: false, error: 'approvedBy must be a string or null' };
  }
  const notes = args?.notes;
  if (notes != null) {
    if (typeof notes !== 'string') return { ok: false, error: 'notes must be a string or null' };
    if (notes.length > MAX_NOTES_LEN) {
      return { ok: false, error: `notes too long (${notes.length} > ${MAX_NOTES_LEN} chars)` };
    }
  }

  const media = await Media.findOne({ _id: rawMediaId, advertiserId: req.advertiserId })
    .select('_id brandId rights fileType source');
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };

  const priorRights = {
    approved:   !!media.rights?.approved,
    approvedBy: media.rights?.approvedBy || null,
    approvedAt: media.rights?.approvedAt || null,
    notes:      media.rights?.notes || null
  };

  const set = approved
    ? {
        'rights.approved':   true,
        'rights.approvedBy': approvedBy || req.user?.email || 'agent',
        'rights.approvedAt': new Date()
      }
    : {
        'rights.approved':   false,
        'rights.approvedBy': null,
        'rights.approvedAt': null
      };
  if (typeof notes === 'string') set['rights.notes'] = notes;

  await Media.updateOne({ _id: media._id }, { $set: set });
  const updated = await Media.findById(media._id).select('rights').lean();

  return {
    ok: true,
    kind: 'mediaUpdate',
    data: {
      _id: String(media._id),
      brandId: media.brandId ? String(media.brandId) : null,
      rights: updated?.rights || { approved: false },
      priorRights,
      cacheNote: 'Ads that already assembled a LayoutInputArtifact against this media may still carry the OLD rights_approved state until they re-derive.'
    }
  };
}

module.exports = { run };
