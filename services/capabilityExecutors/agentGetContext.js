// Executor for capability agent.getContext (Tier 0, advertiser scope).
//
// Return a compact snapshot of the caller's advertiser: brands (id,
// name, status, connected integrations, last activity), a small
// per-brand campaign summary, and rolling 24h spend. Meant to be the
// LLM's cheap first call so it can answer "which of my brands has
// the most drafts today" without pre-selection.
//
// PERFORMANCE: this is expected to be called at the start of many
// turns, so every query is advertiserId-scoped and uses covering
// projections (no full docs, no lookups). Kept under ~5 lightweight
// aggregations total.
//
// TENANCY: everything scoped strictly to req.advertiserId — per
// coverage plan §D2, cross-advertiser discovery is a permanent
// non-goal.

'use strict';

const mongoose = require('mongoose');
const Advertiser = require('../../models/Advertiser');
const Brand = require('../../models/Brand');
const Campaign = require('../../models/Campaign');
const IntegrationCredential = require('../../models/IntegrationCredential');
const { spentInLast24h, dailyCap } = require('../spendGuard');

const BRAND_CAP = 50;

async function run({ req }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const advertiserId = req.advertiserId;

  const advertiser = await Advertiser.findById(advertiserId)
    .select('_id name slug status plan createdAt').lean();
  if (!advertiser) return { ok: false, error: 'advertiser not found for this session' };

  // Parallel fan-out. Each query is advertiserId-scoped for tenant
  // safety and uses a projection so we don't ship blob fields into
  // the LLM's context.
  const [brands, integrations, campaignsAgg, spentUsd24h] = await Promise.all([
    Brand.find({ advertiserId })
      .sort({ updatedAt: -1 })
      .limit(BRAND_CAP)
      .select('_id name nameNormalized websiteUrl status source createdAt updatedAt')
      .lean(),
    IntegrationCredential.find({
      advertiserId,
      status: { $in: ['active', 'pending'] }
    })
      .select('_id brandId type status connectedAt')
      .lean(),
    Campaign.aggregate([
      { $match: { advertiserId: new mongoose.Types.ObjectId(advertiserId) } },
      { $group: {
          _id: { brandId: '$brandId', status: '$status' },
          count: { $sum: 1 }
        }
      }
    ]),
    // Rolling 24h spend — reuse spendGuard.spentInLast24h so this
    // capability reports the exact same figure the daily-cap gate
    // consults. CostLog is brandId-keyed (not advertiserId-keyed), so
    // the helper resolves via Brand.find upstream.
    spentInLast24h(advertiserId)
  ]);

  // Fold integrations + campaign counts into per-brand bags.
  const intsByBrand = new Map();
  for (const c of integrations) {
    const key = String(c.brandId || '');
    const bag = intsByBrand.get(key) || [];
    bag.push({ type: c.type, status: c.status, credentialId: String(c._id), connectedAt: c.connectedAt || null });
    intsByBrand.set(key, bag);
  }
  const campaignCountsByBrand = new Map();
  for (const row of campaignsAgg) {
    const brandKey = String(row._id.brandId || '');
    const statusKey = String(row._id.status || 'unknown');
    const bag = campaignCountsByBrand.get(brandKey) || {};
    bag[statusKey] = (bag[statusKey] || 0) + row.count;
    campaignCountsByBrand.set(brandKey, bag);
  }

  const brandRows = brands.map((b) => ({
    _id:               String(b._id),
    name:              b.name,
    slug:              b.nameNormalized,
    websiteUrl:        b.websiteUrl || null,
    source:            b.source || null,
    status:            b.status || null,
    integrations:      intsByBrand.get(String(b._id)) || [],
    campaigns:         campaignCountsByBrand.get(String(b._id)) || {},
    updatedAt:         b.updatedAt || null,
    createdAt:         b.createdAt || null
  }));

  return {
    ok: true,
    kind: 'context',
    data: {
      advertiser: {
        _id:       String(advertiser._id),
        name:      advertiser.name,
        slug:      advertiser.slug,
        status:    advertiser.status,
        plan:      advertiser.plan,
        createdAt: advertiser.createdAt || null
      },
      brandCount:  brandRows.length,
      brandsTruncated: brands.length >= BRAND_CAP,
      brands:      brandRows,
      spend: {
        rollingUsd24h: Math.round((spentUsd24h || 0) * 100) / 100,
        dailyCapUsd:   dailyCap()
      },
      note: 'Read-only snapshot. Every brand + campaign + integration + spend row is scoped to your advertiser; cross-advertiser discovery is never exposed.'
    }
  };
}

module.exports = { run };
