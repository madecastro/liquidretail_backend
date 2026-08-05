// Executor for capability campaign.patchBrief (Tier 1, campaign scope).
//
// Manual override of Campaign.creativeBrief. Set to null to clear (a
// subsequent sync will re-derive automatically); set to an object to
// override the AI-derived brief. Stamps briefDerivedAt so the auto-
// refresh doesn't overwrite a manual value.

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.campaignId;
  if (!rawId) return { ok: false, error: 'campaignId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `campaignId "${rawId}" is not a valid ObjectId` };
  }

  const incoming = args?.brief;
  if (incoming !== null && (typeof incoming !== 'object' || Array.isArray(incoming))) {
    return { ok: false, error: 'brief must be an object or null' };
  }

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId })
    .select('_id creativeBrief briefDerivedAt');
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };

  const priorBrief = c.creativeBrief || null;

  c.creativeBrief  = incoming;
  c.briefDerivedAt = incoming === null ? null : new Date();
  c.markModified('creativeBrief');
  await c.save();

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(c._id),
      brief: c.creativeBrief,
      briefDerivedAt: c.briefDerivedAt,
      priorBrief
    }
  };
}

module.exports = { run };
