// Pre-flight spend cap for Tier ≥ 2 agent capabilities. The confirmation
// gate (routes/agent.js) ensures the operator agreed to the action; this
// service ensures the advertiser has budget for it.
//
// CONTRACT:
//   check({ advertiserId, capability, args }) →
//     { allowed: true,  dailyCap, spent, estimateUsd, projected } |
//     { allowed: false, reason, ...same fields }
//
// The estimate comes from the capability entry — either `estimateUsd` as
// a static number, or a function invoked with args. Fail-closed: a Tier
// ≥ 2 capability that supplies neither returns allowed:false with a
// clear "no estimator" reason. We refuse to bill an unbounded action.
//
// SPENT is the rolling 24h sum of CostLog.costUsd across every brand
// belonging to the advertiser. Fresh query per check — cheap because the
// index on brandId + createdAt matches this filter tightly, and the
// gate only fires when the operator has just confirmed (i.e. seconds
// of decision latency, not milliseconds of hot-path).
//
// DAILY_CAP is per-advertiser, env-driven (AGENT_DAILY_CAP_USD, default
// 10). No per-brand or per-user gradations in MVP — one number the
// operator or ops can raise per env.

'use strict';

const CostLog = require('../models/CostLog');
const Brand   = require('../models/Brand');

function dailyCap() {
  const raw = Number(process.env.AGENT_DAILY_CAP_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

async function estimateFor(capability, args) {
  const e = capability?.estimateUsd;
  if (typeof e === 'number' && Number.isFinite(e) && e >= 0) return e;
  if (typeof e === 'function') {
    try {
      const val = await e(args);
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) return val;
    } catch { /* fall through — treated as no estimator */ }
  }
  return null;
}

async function spentInLast24h(advertiserId) {
  const brandIds = await Brand.find({ advertiserId }).select('_id').lean()
    .then((rs) => rs.map((r) => r._id));
  if (!brandIds.length) return 0;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await CostLog.aggregate([
    { $match: { brandId: { $in: brandIds }, createdAt: { $gte: since } } },
    { $group: { _id: null, total: { $sum: '$costUsd' } } }
  ]);
  return rows[0]?.total || 0;
}

/**
 * Check whether a Tier ≥ 2 capability may run for this advertiser.
 * Callers should short-circuit on !allowed and surface `reason` back
 * to the LLM (as the synthetic tool_result) and the operator (as a
 * spend-guard-block SSE event).
 */
async function check({ advertiserId, capability, args }) {
  if (!advertiserId) {
    return { allowed: false, reason: 'no advertiser scope', dailyCap: dailyCap(), spent: 0, estimateUsd: 0, projected: 0 };
  }
  const est = await estimateFor(capability, args);
  if (est == null) {
    return {
      allowed: false,
      reason: `capability "${capability?.id}" is tier ${capability?.tier} but supplies no estimateUsd — refusing to dispatch an unbounded billable action`,
      dailyCap: dailyCap(), spent: 0, estimateUsd: 0, projected: 0
    };
  }
  // Zero-cost declared → allow trivially (still gets logged).
  if (est === 0) {
    return { allowed: true, dailyCap: dailyCap(), spent: 0, estimateUsd: 0, projected: 0 };
  }
  const spent = await spentInLast24h(advertiserId);
  const cap = dailyCap();
  const projected = spent + est;
  if (projected > cap) {
    return {
      allowed: false,
      reason: `would exceed daily spend cap: $${spent.toFixed(2)} spent + $${est.toFixed(2)} estimated = $${projected.toFixed(2)} projected vs $${cap.toFixed(2)} cap. Ask ops to raise AGENT_DAILY_CAP_USD or wait for the 24h window to roll.`,
      dailyCap: cap, spent, estimateUsd: est, projected
    };
  }
  return { allowed: true, dailyCap: cap, spent, estimateUsd: est, projected };
}

module.exports = { check, dailyCap, spentInLast24h, estimateFor };
