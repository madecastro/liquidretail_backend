// Executor for capability campaign.deriveBrief (Tier 2, campaign scope).
//
// Kicks off the campaignBriefDerivationService — an LLM call that
// extracts a structured creative brief (goal, pitch, focus, audience,
// tone, cta_emphasis, evidence) from the campaign's targeting,
// objective, matched products, and ad creatives. Threads into the
// Director as CAMPAIGN BRIEF context when generation is campaign-scoped.
//
// Billable (~$0.02 per call, Sonnet). Respects a 7-day TTL by default;
// pass force=true to re-derive.

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
  const force = !!args?.force;

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };

  const { deriveCampaignBrief } = require('../campaignBriefDerivationService');
  let result;
  try {
    result = await deriveCampaignBrief(c._id, { force, derivedFrom: 'manual' });
  } catch (err) {
    return { ok: false, error: err?.message || 'brief derivation failed' };
  }

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(c._id),
      name: c.name,
      derived:    result?.ok !== false,
      skipped:    !!result?.skipped,
      skipReason: result?.reason || null,
      brief:      result?.brief || null,
      elapsedMs:  result?.elapsedMs ?? null
    }
  };
}

module.exports = { run };
