// Executor for capability ad.list (Tier 0, brand scope).
//
// Lists recent Ads for one brand with optional filters (kind, status,
// sinceHoursAgo). Fills the gap ad.inspect leaves: the operator asks
// "show me my most recent ads" without an id in hand.
//
// Tenant-scoped via req.advertiserId + Brand lookup. Never leaks a
// count that includes cross-tenant rows.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const AD_KINDS = ['image', 'video'];
const AD_STATUSES = ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'];

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

  const kind = typeof args?.kind === 'string' && AD_KINDS.includes(args.kind) ? args.kind : null;
  const status = typeof args?.status === 'string' && AD_STATUSES.includes(args.status) ? args.status : null;
  const limit = Math.min(Math.max(1, Number(args?.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const hoursRaw = Number(args?.sinceHoursAgo);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? Math.min(hoursRaw, MAX_HOURS)
    : DEFAULT_HOURS;
  const since = new Date(Date.now() - hours * 3_600_000);

  const filter = { brandId: brand._id, createdAt: { $gte: since } };
  if (kind)   filter.kind   = kind;
  if (status) filter.status = status;

  const [total, ads] = await Promise.all([
    Ad.countDocuments(filter),
    Ad.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('_id kind template aspectRatio platformFormat status renderUrl productId campaignId createdAt updatedAt renderedAt metaSyncStatus')
      .lean()
  ]);

  return {
    ok: true,
    kind: 'adList',
    data: {
      brand:  { _id: String(brand._id), name: brand.name },
      window: { hours, since: since.toISOString() },
      filter: { kind, status },
      total,
      sampleCount: ads.length,
      ads: ads.map((a) => ({
        _id:            String(a._id),
        kind:           a.kind,
        template:       a.template,
        aspectRatio:    a.aspectRatio,
        platformFormat: a.platformFormat,
        status:         a.status,
        renderUrl:      a.renderUrl || null,
        productId:      a.productId ? String(a.productId) : null,
        campaignId:     a.campaignId ? String(a.campaignId) : null,
        createdAt:      a.createdAt,
        renderedAt:     a.renderedAt || null,
        updatedAt:      a.updatedAt || null,
        metaSynced:     a.metaSyncStatus === 'synced'
      }))
    }
  };
}

module.exports = { run };
