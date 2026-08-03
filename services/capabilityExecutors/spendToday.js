// Executor for capability spend.today (Tier 0, advertiser scope).
//
// Aggregates CostLog rows across all brands belonging to the caller's
// advertiser for a rolling window (default 24h, max 168h = 7d). Returns
// a breakdown by (provider, stage) plus a grand total in USD.
//
// CostLog carries brandId but not advertiserId (see models/CostLog.js) —
// so we resolve the advertiser's brand IDs first, then aggregate on
// brandId ∈ [...]. A brand that has never generated logs contributes 0.

'use strict';

const CostLog = require('../../models/CostLog');
const Brand = require('../../models/Brand');

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }

  const hoursRaw = Number(args?.sinceHoursAgo);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? Math.min(hoursRaw, MAX_HOURS)
    : DEFAULT_HOURS;
  const since = new Date(Date.now() - hours * 3_600_000);

  // Resolve the advertiser's brands. Empty list → return a zero
  // breakdown rather than a mongo $in:[] (which would match nothing
  // AND is a slower query than a short-circuit).
  const brandIds = await Brand.find({ advertiserId: req.advertiserId })
    .select('_id').lean()
    .then((rows) => rows.map((r) => r._id));

  if (!brandIds.length) {
    return {
      ok: true,
      kind: 'spendReport',
      data: {
        windowHours: hours,
        since: since.toISOString(),
        totalUsd: 0,
        entries: [],
        note: 'advertiser has no brands'
      }
    };
  }

  // Aggregate: sum costUsd grouped by (provider, stage). Keeping the
  // dimensions coarse — provider says "who charged" (openai/anthropic/
  // google/atlas video etc.), stage says "why we called them" (director,
  // html-gen, video-i2v, etc.). Two dimensions the agent can reason
  // over cleanly without exposing every model slug.
  const pipeline = [
    { $match: { brandId: { $in: brandIds }, createdAt: { $gte: since } } },
    { $group: {
        _id:      { provider: '$provider', stage: '$stage' },
        costUsd:  { $sum: '$costUsd' },
        callCount: { $sum: 1 }
    }},
    { $sort: { costUsd: -1 } }
  ];
  const rows = await CostLog.aggregate(pipeline);

  const totalUsd = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
  const entries = rows.map((r) => ({
    provider: r._id.provider,
    stage:    r._id.stage,
    costUsd:  Number((r.costUsd || 0).toFixed(4)),
    callCount: r.callCount
  }));

  return {
    ok: true,
    kind: 'spendReport',
    data: {
      windowHours: hours,
      since: since.toISOString(),
      totalUsd: Number(totalUsd.toFixed(4)),
      totalCalls: rows.reduce((s, r) => s + (r.callCount || 0), 0),
      entries
    }
  };
}

module.exports = { run };
