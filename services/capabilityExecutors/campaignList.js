// Executor for capability campaign.list (Tier 0, brand scope).
//
// Enumerates Campaigns for one brand with compact per-campaign summary.
// The agent uses this to answer "what campaigns do I have running?" or
// "which campaign is spending the most today?" style questions.
//
// Tenant-scoped via req.advertiserId (Campaign carries advertiserId too,
// so we intersect both — Brand.advertiserId isn't authoritative if a
// campaign was orphaned by a brand delete).

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');
const Brand = require('../../models/Brand');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const limit = Math.min(Number(args?.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  const platform = typeof args?.platform === 'string' ? args.platform : null;

  const filter = { advertiserId: req.advertiserId, brandId: brand._id };
  if (platform) filter.platform = platform;

  const [total, campaigns] = await Promise.all([
    Campaign.countDocuments(filter),
    Campaign.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .select('_id name platform kind status platformFormat createdAt updatedAt adSets')
      .lean()
  ]);

  return {
    ok: true,
    kind: 'campaignList',
    data: {
      brand: { _id: String(brand._id), name: brand.name },
      filter: platform ? { platform } : null,
      total,
      sampleCount: campaigns.length,
      campaigns: campaigns.map((c) => ({
        _id:            String(c._id),
        name:           c.name,
        platform:       c.platform,
        kind:           c.kind || null,
        status:         c.status || null,
        platformFormat: c.platformFormat || null,
        adsetCount:     Array.isArray(c.adSets) ? c.adSets.length : 0,
        updatedAt:      c.updatedAt || c.createdAt || null
      }))
    }
  };
}

module.exports = { run };
