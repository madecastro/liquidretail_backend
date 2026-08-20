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
// re-bought real work. Video has HAD a charge-point receipt all along
// (Ad.veoPredictionId, services/spendReceipt.js); the bug was that this file
// never read it — recoverImageAd is image-only, so every renderRoute:'veo' ad
// was reported 'no-receipt' and fell through to a fresh Omni submit.
// recoverStrandedAd now dispatches those to recoverVideoAd. Do not port this
// pattern to a provider path that has no charge-point receipt.
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
//   · deriveWaitAttempts < STRANDED_SWEEP_MAX_ATTEMPTS — see below (2026-08-18)
// The renderStage + failed-run pair is what separates "a deploy killed this" from
// "an operator has not pressed go yet".
//
// ── WHY deriveWaitAttempts IS A SECOND BOUND HERE, NOT JUST ON THE ARCHIVE
// SWEEPER (2026-08-18) ────────────────────────────────────────────────────
// A FREE derive-only video ad (deriveFromMaster set) that is mid-wait for its
// sibling master when a SIGTERM hits gets requeued to 'queued' by
// processAlerts.js with renderStage still set and its minting run marked
// 'failed' — exactly the shape this sweeper exists to re-drive. Before
// 2026-08-18 the wait/requeue loop (renderDeriveOnlyVideoAd, routes/ads.js)
// $inc'd renderAttempts on every polite requeue, so after ~STRANDED_SWEEP_
// MAX_ATTEMPTS cycles it aged out of THIS filter too (accidentally — that
// inflation was never meant to serve this sweeper, it just happened to).
// Moving that bookkeeping onto deriveWaitAttempts (so the archive sweeper's
// renderAttempts:0 guard stays honest — see models/Ad.js) removed that
// accidental cap: renderAttempts now stays 0 through every wait cycle, so
// without a bound of its own here `findStranded` would keep re-selecting the
// SAME ad indefinitely. Each `requeueStrandedAds` re-pick mints a NEW
// CampaignRun and $addToSet's its id onto campaignRunIds WITHOUT removing the
// original failed run — so the `campaignRunIds: { $in: failedRuns }` match
// keeps firing on every sweep pass regardless of how many fresh runs have
// since gone 'done', all the way up to MAX_DERIVE_WAIT_ATTEMPTS (30) wait
// cycles instead of the intended ~STRANDED_SWEEP_MAX_ATTEMPTS (3). Each cycle
// is submit-free (renderDeriveOnlyVideoAd never reaches Omni) but it holds a
// video-lane slot (VEO_CONCURRENCY) for up to DERIVE_MASTER_WAIT_MS (12 min)
// — so an unbounded loop is a real resource hazard even though it is not a
// money hazard. Bounding on deriveWaitAttempts too restores the original
// intent: the sweeper auto-retries a bounded few times, and beyond that it is
// left for an explicit "Generate more" (POST /runs) or the 24h archive sweep.

const Ad          = require('../models/Ad');
const CampaignRun = require('../models/CampaignRun');
const { recoverImageAd, settleChargeState } = require('./imageRecoveryService');
const { recoverVideoAd } = require('./videoRecoveryService');
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
 * The AD-SIDE half of findStranded's query, extracted to a pure function of
 * the failed-run ids so a harness can evaluate the REAL filter object against
 * REAL document shapes — the same pattern queuedArchiveSweeper.
 * buildQueuedArchiveFilter uses, and for the same reason: stubbing out
 * Ad.find (as the behavioural section below already did before this) tests
 * the sweep's PROCESSING logic given a fixed candidate list, never whether
 * the filter itself would have produced that list.
 *
 * BOTH attempt bounds apply independently ($and, since two $or clauses
 * cannot share one object key): renderAttempts < MAX_ATTEMPTS AND
 * deriveWaitAttempts < MAX_ATTEMPTS. See the module comment above for why a
 * wait-only derive ad needs its OWN cap now that deriveWaitAttempts, not
 * renderAttempts, is what its requeue loop increments — without it, this
 * filter would keep re-selecting the same ad every sweep pass indefinitely
 * (each re-pick mints a fresh CampaignRun without ever clearing the original
 * failed run out of campaignRunIds), holding a video-lane slot for up to
 * DERIVE_MASTER_WAIT_MS on every re-pick even though nothing is ever billed.
 */
function buildStrandedAdFilter({ failedRunIds } = {}) {
  const ids = (Array.isArray(failedRunIds) ? failedRunIds : []).filter(Boolean);
  return {
    status: 'queued',
    campaignRunIds: { $in: ids },
    // Work had BEGUN. A freshly minted ad awaiting an operator claim has no stage.
    renderStage: { $nin: [null, ''] },
    $and: [
      { $or: [{ renderAttempts: { $lt: MAX_ATTEMPTS } }, { renderAttempts: { $exists: false } }] },
      { $or: [{ deriveWaitAttempts: { $lt: MAX_ATTEMPTS } }, { deriveWaitAttempts: { $exists: false } }] }
    ]
  };
}

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

  const ads = await Ad.find(buildStrandedAdFilter({ failedRunIds: failedRuns.map(r => r.runId) }))
    .limit(MAX_ADS).lean();

  return { ads, runs: failedRuns };
}

/**
 * Dispatch recovery by ad.renderRoute so a video receipt is never mis-read
 * as "no receipt".
 *
 * WHY (2026-08-19). recoverImageAd is structurally image-only: it reads only
 * ad.imageGeneration.predictionId and returns 'no-receipt' for anything where
 * that is empty. A video ad's receipt lives on a different field,
 * Ad.veoPredictionId (services/spendReceipt.js). Before this dispatcher
 * existed, every renderRoute:'veo' stranded ad was reported 'no-receipt'
 * regardless of whether it actually held a receipt, and fell through to a
 * fresh Omni submit (~$0.90/master). recoverVideoAd is the counterpart
 * with the same verdict contract; this function is the single place that
 * chooses between them. sweepStrandedRuns's pass-1/pass-2 loop stays
 * generic — it already handles the verdict states and must not grow a
 * second, route-aware copy of that logic.
 *
 * Fail-closed on the IMAGE recoverer for anything that is not explicitly
 * 'veo' — including null/undefined renderRoute — so legacy ads that
 * predate the field keep today's behaviour. The two recoverers are
 * overridable options (real functions as defaults) because a destructured
 * import cannot be stubbed after load; anything a harness needs to swap
 * must be an injectable parameter, not a bare call to the imported
 * binding. Same reason sweepStrandedRuns takes `recover` as an option.
 */
async function recoverStrandedAd({
  ad,
  recoverImage = recoverImageAd,
  recoverVideo = recoverVideoAd
} = {}) {
  if (ad && ad.renderRoute === 'veo') return recoverVideo({ ad });
  return recoverImage({ ad });
}

/**
 * One sweep. Recovery first (free), then requeue whatever is genuinely unbilled.
 *
 * @param {function} requeue  async ({ ads, run }) => number — injected by the
 *   caller so this module never imports the render loop (routes/ads.js requires
 *   half the service graph, and a cycle here would be a boot-time landmine).
 *   Omit it to run recovery-only.
 * @param {function} recover  async ({ ad }) => verdict. Defaults to
 *   recoverStrandedAd (renderRoute:'veo' → recoverVideoAd, everything else
 *   → recoverImageAd); injectable so the harness can exercise the
 *   RECOVER-BEFORE-REQUEUE ordering — the one invariant here that costs
 *   money if broken — without a network call. A destructured import cannot
 *   be stubbed after load, which is exactly how the first version of that
 *   test silently exercised the real function against fake prediction ids.
 */
async function sweepStrandedRuns({ requeue = null, recover = recoverStrandedAd, settle = settleChargeState } = {}) {
  const out = { considered: 0, recovered: 0, requeued: 0, skipped: false, stillProcessing: 0, unrecoverable: 0, chargesSettled: 0 };
  if (!ENABLED()) { out.skipped = 'STRANDED_SWEEP_ENABLED=false'; return out; }

  let ads, runs;
  try {
    ({ ads, runs } = await findStranded());
  } catch (err) {
    console.warn(`⚠️  strandedSweep: query failed — ${err.message}`);
    return out;
  }
  out.considered = ads.length;
  // No stranded WORK does not mean no unsettled MONEY — the charge pass is a
  // separate question and must still run.
  if (!ads.length) { out.chargesSettled = await settleUnknownCharges({ settle }); logSweep(out); return out; }

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
  if (!stillNeedRender.length) { out.chargesSettled = await settleUnknownCharges({ settle }); logSweep(out); return out; }
  if (!requeue || !REQUEUE_ON()) {
    console.log(
      `   ⏸  strandedSweep: ${stillNeedRender.length} receipt-free ad(s) need a real render — ` +
      `${requeue ? 'STRANDED_SWEEP_REQUEUE=false' : 'no requeue handler supplied'}; leaving them queued`
    );
    out.chargesSettled = await settleUnknownCharges({ settle });
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

  out.chargesSettled = await settleUnknownCharges({ settle });
  logSweep(out);
  return out;
}

/**
 * Resolve ads whose charge state is UNKNOWN, from the provider's own record.
 *
 * Separate from the stranded passes above because it is a different question:
 * those ask "is there work to finish", this asks "did we actually pay". It rides
 * the same interval rather than adding a timer, and it is FREE — one GET per ad,
 * no submit, and it can only ever replace "we do not know" with a confirmed
 * figure. Understating the ledger is the direction that can never be corrected,
 * so leaving these unresolved is not neutral.
 */
async function settleUnknownCharges({ settle = settleChargeState } = {}) {
  let settled = 0;
  let ads;
  try {
    ads = await Ad.find({
      'renderError.chargeState': 'unknown',
      'renderError.predictionId': { $nin: [null, ''] },
      updatedAt: { $gte: new Date(Date.now() - MAX_AGE_H * 3600 * 1000) }
    }).limit(MAX_ADS).lean();
  } catch (err) {
    console.warn(`⚠️  strandedSweep: unknown-charge query failed — ${err.message}`);
    return 0;
  }
  if (!ads.length) return 0;

  for (const ad of ads) {
    try {
      const r = await settle({ ad });
      if (r.state === 'charged' || r.state === 'not-charged') {
        settled++;
        console.log(
          `   💲 strandedSweep[${ad._id}]: charge settled -> ${r.state}` +
          `${r.price ? ` ($${Number(r.price).toFixed(5)})` : ''}`
        );
      }
    } catch (err) {
      console.warn(`   ⚠️  strandedSweep[${ad._id}]: charge settle threw — ${err.message}`);
    }
  }
  return settled;
}

function logSweep(out) {
  const touched = out.recovered + out.requeued + out.chargesSettled;
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
  recoverStrandedAd,
  findStranded,
  buildStrandedAdFilter,
  settleUnknownCharges,
  ENABLED,
  REQUEUE_ON,
  MAX_AGE_H,
  MAX_ADS,
  MAX_ATTEMPTS
};
