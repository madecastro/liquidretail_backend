// Executor for capability campaign.delete (Tier 1, campaign scope).
//
// Hard-deletes a reach-social campaign and its directly-owned children
// (Ads, CampaignRun rows, rendered Cloudinary PNGs) via the existing
// cascadeDeleteCampaign service — the source of truth for cascade
// semantics. Refuses synced campaigns.
//
// Tier 1 because although the delete is irreversible in the DB, the
// blast radius is narrow (single campaign; shared artifacts survive)
// and the agent already surfaces campaign metadata before confirmation.
// Bumping to T3 would require a phrase gate, which is overkill for
// same-day drafts. Revisit if we see accidental deletions in the wild.

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

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId })
    .select('_id name brandId platform').lean();
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };
  if (c.platform !== 'reach-social') {
    return { ok: false, error: 'only reach-social campaigns can be deleted via the agent' };
  }

  const { cascadeDeleteCampaign } = require('../cascadeDeleteService');
  const result = await cascadeDeleteCampaign(c._id);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || 'cascade delete failed' };
  }

  return {
    ok: true,
    kind: 'campaignDelete',
    data: {
      _id:       String(c._id),
      name:      c.name,
      brandId:   String(c.brandId),
      cascaded:  {
        adsDeleted:            result.adsDeleted           ?? null,
        runsDeleted:           result.runsDeleted          ?? null,
        renderedAssetsRemoved: result.renderedAssetsRemoved ?? null
      },
      note: 'Shared artifacts (LayoutInput, AiCanvas, CreativeDirection, etc.) preserved — they belong to media/brand, not campaign.'
    }
  };
}

module.exports = { run };
