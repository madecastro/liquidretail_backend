'use strict';
//
// STRANDED RUN SWEEPER — finish work a restart abandoned, without buying it twice.
//
// WHY (2026-08-05). services/processAlerts.js requeues receipt-free `rendering`
// ads to `queued` on every SIGTERM — i.e. on every deploy — and marks their run
// `failed`. Nothing then drains `queued`. bootRecoveryService deliberately only
// touches `rendering` + receipt. So a deploy mid-run silently stranded the work
// and a human had to notice and click. Owner, twice: "they should all be finished
// automatically after a restart", and later "I am still seeing all the ads in a
// queued state".
//
// ── THE ORDER IS THE WHOLE DESIGN ──────────────────────────────────────────
// RECOVER FIRST, REQUEUE SECOND. A stranded ad holding a spend receipt has
// already been paid for and Atlas keeps it for 30 days, so recovering it costs
// $0 while requeuing it buys the same image again. Measured: nine predictions,
// $0.5663, all recoverable. Getting this order wrong is not a bug that shows up
// in a test — it shows up on the invoice.
//
// ── WHY AUTO-REQUEUE IS SAFE *NOW* AND WAS NOT BEFORE ──────────────────────
// "Receipt-free" only means "not billed" if a receipt is reliably written at the
// charge point. For images that became true on 2026-08-05 (#86); before that an
// image could be billed and receipt-free, so a sweeper like this would have
// re-bought real work. Do not port this pattern to a provider path that has no
// charge-point receipt.
//
// ── SCOPE: STRANDED, NOT MERELY QUEUED ─────────────────────────────────────
// `queued` is ALSO the normal resting state of a freshly generated ad awaiting an
// explicit operator claim. Draining those would spend money nobody asked for. So
// an ad qualifies only when ALL of these hold:
//   · status 'queued'                      — not already in flight
//   · a renderStage breadcrumb             — work had genuinely BEGUN
//   · its run is `failed`                  — the shutdown sweep marked it so
//   · within STRANDED_SWEEP_MAX_AGE_H      — no resurrecting week-old work
//   · renderAttempts < STRANDED_SWEEP_MAX_ATTEMPTS — a poisoned ad cannot loop
// The renderStage + failed-run pair is what separates "a deploy killed this" from
// "an operator has not pressed go yet".

const Ad          = require('../models/Ad');
const CampaignRun = require('../models/CampaignRun');
const { recoverImageAd } = require('./imageRecoveryService');
const alerts = require('./alertService');

const truthy = (v, dflt) => {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
};

const ENABLED       = () => truthy(process.env.STRANDED_SWEEP_ENABLED, true);
const MAX_AGE_H     = Number(process.env.STRANDED_SWEEP_MAX_AGE_H || 24);
const MAX_ADS       = Number(process.env.STRANDED_SWEEP_MAX_ADS || 40);
const MAX_ATTEMPTS  = Number(process.env.STRANDED_SWEEP_MAX_ATTEMPTS || 3);
// Requeue is the half that SPENDS. It is separately switchable so recovery (free)
// can stay on while auto-spending is paused, without a deploy.
const REQUEUE_ON    = () => truthy(process.env.STRANDED_SWEEP_REQUEUE, true);

/**
 * Find ads a restart abandoned. Read-only.
 */
async function findStranded() {
  const cutoff = new Date(Date.now() - MAX_AGE_H * 3600 * 1000);
  // Only runs the shutdown path actually marked failed. A `running` run may still
  // have a live owner on another instance; a `done` run has nothing owed.
  const failedRuns = await CampaignRun
    .find({ status: 'failed', startedAt: { $gte: cutoff } })
    .select('runId campaignId brandId campaignKind')
    .lean();
  if (!failedRuns.length) return { ads: [], runs: [] };

  const ads = await Ad.find({
    status: 'queued',
    campaignRunIds: { $in: failedRuns.map(r => r.runId) },
    // Work had BEGUN. A freshly minted ad awaiting an operator claim has no stage.
    renderStage: { $nin: [null, ''] },
    $or: [{ renderAttempts: { $lt: MAX_ATTEMPTS } }, { renderAttempts: { $exists: false } }]
  }).limit(MAX_ADS).lean();

  return { ads, runs: failedRuns };
}

/**
 * One sweep. Recovery first (free), then requeue whatever is genuinely unbilled.
 *
 * @param {function} requeue  async ({ ads, run }) => number — injected by the
 *   caller so this module never imports the render loop (routes/ads.js requires
 *   half the service graph, and a cycle here would be a boot-time landmine).
 *   Omit it to run recovery-only.
 * @param {function} recover  async ({ ad }) => verdict. Defaults to the real
 *   recoverImageAd; injectable so the harness can exercise the RECOVER-BEFORE-
 *   REQUEUE ordering — the one invariant here that costs money if broken —
 *   without a network call. A destructured import cannot be stubbed after load,
 *   which is exactly how the first version of that test silently exercised the
 *   real function against fake prediction ids.
 */
async function sweepStrandedRuns({ requeue = null, recover = recoverImageAd } = {}) {
  const out = { considered: 0, recovered: 0, requeued: 0, skipped: false, stillProcessing: 0, unrecoverable: 0 };
  if (!ENABLED()) { out.skipped = 'STRANDED_SWEEP_ENABLED=false'; return out; }

  let ads, runs;
  try {
    ({ ads, runs } = await findStranded());
  } catch (err) {
    console.warn(`⚠️  strandedSweep: query failed — ${err.message}`);
    return out;
  }
  out.considered = ads.length;
  if (!ads.length) return out;

  console.log(`♻️  strandedSweep: ${ads.length} ad(s) stranded by a restart — recovering paid work first`);

  // ── PASS 1: RECOVER. Free, and must happen before any requeue decision.
  const stillNeedRender = [];
  for (const ad of ads) {
    let r;
    try {
      r = await recover({ ad });
    } catch (err) {
      console.warn(`   ⚠️  strandedSweep[${ad._id}]: recovery threw — ${err.message}`);
      out.unrecoverable++;
      continue;
    }
    if (r.state === 'recovered') {
      out.recovered++;
      console.log(`   ✅ strandedSweep[${ad._id}]: recovered from receipt ${r.predictionId} — $0`);
      continue;
    }
    if (r.state === 'no-receipt') { stillNeedRender.push(ad); continue; }
    // A receipt EXISTS but is not yet collectable (processing / unknown / a fetch
    // blip). Leaving it queued is the only safe move: requeuing would re-buy work
    // Atlas may be about to hand us. The next pass retries.
    if (r.state === 'processing' || r.state === 'unknown') { out.stillProcessing++; continue; }
    out.unrecoverable++;
    console.warn(`   ⚠️  strandedSweep[${ad._id}]: ${r.state} — ${r.message || 'no detail'}`);
  }

  // ── PASS 2: REQUEUE the genuinely unbilled.
  if (!stillNeedRender.length) { logSweep(out); return out; }
  if (!requeue || !REQUEUE_ON()) {
    console.log(
      `   ⏸  strandedSweep: ${stillNeedRender.length} receipt-free ad(s) need a real render — ` +
      `${requeue ? 'STRANDED_SWEEP_REQUEUE=false' : 'no requeue handler supplied'}; leaving them queued`
    );
    logSweep(out);
    return out;
  }

  // Group by run so each requeue is one campaign's worth of work, matching the
  // shape POST /api/ads/runs already claims and renders.
  const byRun = new Map();
  for (const ad of stillNeedRender) {
    const runId = (ad.campaignRunIds || []).find(r => runs.some(x => x.runId === r));
    if (!runId) continue;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push(ad);
  }
  for (const [runId, group] of byRun) {
    const run = runs.find(r => r.runId === runId);
    try {
      const n = await requeue({ ads: group, run });
      out.requeued += Number(n) || 0;
    } catch (err) {
      console.warn(`   ⚠️  strandedSweep: requeue for ${runId} failed — ${err.message}`);
    }
  }

  logSweep(out);
  return out;
}

function logSweep(out) {
  const touched = out.recovered + out.requeued;
  if (!touched && !out.unrecoverable) return;
  console.log(
    `♻️  strandedSweep: ${out.recovered} recovered ($0) · ${out.requeued} requeued · ` +
    `${out.stillProcessing} still processing · ${out.unrecoverable} unrecoverable`
  );
  alerts.notifyAsync({
    level: out.unrecoverable > 0 ? 'warn' : 'info',
    title: out.recovered
      ? `Recovered ${out.recovered} paid ad(s) stranded by a restart`
      : `Requeued ${out.requeued} ad(s) stranded by a restart`,
    key: 'stranded-sweep',
    fields: {
      recovered: out.recovered || undefined,
      requeued: out.requeued || undefined,
      'still processing': out.stillProcessing || undefined,
      unrecoverable: out.unrecoverable || undefined
    }
  });
}

module.exports = {
  sweepStrandedRuns,
  findStranded,
  ENABLED,
  REQUEUE_ON,
  MAX_AGE_H,
  MAX_ADS,
  MAX_ATTEMPTS
};
