// Executor for capability run.status (Tier 0, brand scope).
//
// Returns the current state of one CampaignRun by runId or ObjectId,
// including counts (total / succeeded / failed / skipped) and the last
// N errors[] rows so the agent can answer "how's my last generation
// batch going?" and "why did that batch fail?"
//
// Tenant-scoped via req.advertiserId + CampaignRun.brandId → Brand.
// A cross-tenant runId returns "not found".

'use strict';

const mongoose = require('mongoose');
const CampaignRun = require('../../models/CampaignRun');
const Brand = require('../../models/Brand');
const Ad = require('../../models/Ad');

const MAX_ERRORS_SURFACED = 6;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const raw = args?.runId;
  if (!raw) return { ok: false, error: 'runId required (either the string runId or the CampaignRun ObjectId)' };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) {
    return { ok: false, error: 'runId must be a non-empty string ≤200 chars' };
  }

  // Accept either the string runId (e.g. 'run_1785268035192_...') or
  // the CampaignRun ObjectId — both are common in operator context.
  const filter = mongoose.isValidObjectId(raw) ? { _id: raw } : { runId: raw };
  const cr = await CampaignRun.findOne(filter).lean();
  if (!cr) return { ok: false, error: `run "${raw}" not found` };

  // Tenant guard: brand must belong to this advertiser.
  const brand = await Brand.findOne({ _id: cr.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `run "${raw}" not found` };

  // Live status of the ads belonging to this run — helpful for the
  // "why is my run stuck?" question. The CampaignRun's counters can
  // lag behind reality (async completion, worker crashes) but the
  // Ad statuses are always current.
  const adsCounts = cr.runId
    ? await Ad.aggregate([
        { $match: { campaignRunIds: cr.runId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    : [];
  const adStatusRollup = {};
  for (const row of adsCounts) adStatusRollup[row._id] = row.count;

  return {
    ok: true,
    kind: 'runStatus',
    data: {
      _id:         String(cr._id),
      runId:       cr.runId,
      brand:       { _id: String(brand._id), name: brand.name },
      status:      cr.status,
      total:       cr.total,
      succeeded:   cr.succeeded,
      failed:      cr.failed,
      skipped:     cr.skipped,
      startedAt:   cr.startedAt,
      completedAt: cr.completedAt || null,
      requestedBy: cr.requestedBy ? String(cr.requestedBy) : null,
      // Ad-level rollup — {'queued': 4, 'draft': 2, ...}. Lets the
      // agent notice "10 total but only 2 rendered — the rest are
      // still queued" without another tool call.
      adStatusRollup,
      // Last few errors[] rows only — full history could blow the
      // 12KB tool-result cap for large batches with many failures.
      errors: (cr.errors || []).slice(-MAX_ERRORS_SURFACED),
      errorsCount: (cr.errors || []).length
    }
  };
}

module.exports = { run };
