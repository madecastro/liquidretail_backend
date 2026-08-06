#!/usr/bin/env node
'use strict';
/**
 * Verify the stranded-run sweeper. No DB, no network, no API key.
 *
 * WHY IT EXISTS. processAlerts requeues receipt-free `rendering` ads to `queued`
 * on every SIGTERM — every deploy — and marks the run failed. Nothing drained
 * `queued`; bootRecoveryService only handles `rendering` + receipt. So a deploy
 * mid-run stranded the work until a human noticed. Owner, twice.
 *
 * THE INVARIANT THAT COSTS MONEY IF BROKEN: recovery runs BEFORE requeue, and
 * only receipt-free ads are ever requeued. A stranded ad holding a receipt is
 * already paid for and Atlas keeps it 30 days — recovering costs $0, requeuing
 * buys it again. Measured 2026-08-05: nine such predictions, $0.5663.
 *
 * THE OTHER ONE: `queued` is ALSO the resting state of a freshly generated ad
 * awaiting an operator claim. Sweeping those would spend money nobody asked for,
 * so the scope predicate must stay narrow.
 *
 * Run: node scripts/verifyStrandedSweep.js
 */

const fs = require('fs');
const path = require('path');
const sweeper = require('../services/strandedRunSweeper');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const sweepSrc = fs.readFileSync(path.join(ROOT, 'services/strandedRunSweeper.js'), 'utf8');
const adsSrc   = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const idxSrc   = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

console.log('\nSTRANDED RUN SWEEP\n');

// ── A. SCOPE: stranded, not merely queued ────────────────────────────────
check('A1 [SPEND] requires a renderStage breadcrumb — a freshly generated ad '
    + 'awaiting an operator claim has none, and sweeping it would spend money '
    + 'nobody asked for',
  /renderStage:\s*\{\s*\$nin:\s*\[null, ''\]\s*\}/.test(sweepSrc));
check('A2 [SPEND] only ads from runs the shutdown path marked `failed` — a '
    + '`running` run may still have a live owner on another instance',
  /status:\s*'failed'/.test(sweepSrc));
check('A3 bounded by age, so week-old work is never resurrected',
  /MAX_AGE_H/.test(sweepSrc) && /startedAt:\s*\{\s*\$gte:\s*cutoff\s*\}/.test(sweepSrc));
check('A4 bounded per pass', /\.limit\(MAX_ADS\)/.test(sweepSrc));
check('A5 [LOOP] a retry cap, so a permanently-failing ad cannot be re-bought forever',
  /renderAttempts:\s*\{\s*\$lt:\s*MAX_ATTEMPTS\s*\}/.test(sweepSrc));
check('A6 two independent kill switches — recovery is free, requeue SPENDS, so '
    + 'auto-spend can be paused without disabling recovery',
  typeof sweeper.ENABLED === 'function' && typeof sweeper.REQUEUE_ON === 'function'
  && /STRANDED_SWEEP_ENABLED/.test(sweepSrc) && /STRANDED_SWEEP_REQUEUE/.test(sweepSrc));

// ── B. [MONEY] RECOVER FIRST, REQUEUE ONLY THE UNBILLED ──────────────────
const recoverIdx = sweepSrc.indexOf('await recover({ ad })');
const requeueIdx = sweepSrc.indexOf('await requeue({');
check('B1 [ORDER] recovery is attempted BEFORE any requeue',
  recoverIdx > -1 && requeueIdx > -1 && recoverIdx < requeueIdx);
check('B2 [MONEY] ONLY no-receipt ads are collected for requeue',
  /if \(r\.state === 'no-receipt'\) \{ stillNeedRender\.push\(ad\); continue; \}/.test(sweepSrc));
check('B3 [MONEY] a recovered ad is NOT also requeued (it continues, never falls through)',
  (() => {
    const i = sweepSrc.indexOf("if (r.state === 'recovered')");
    if (i === -1) return false;
    const branch = sweepSrc.slice(i, sweepSrc.indexOf('}', sweepSrc.indexOf('continue;', i)));
    return /continue;/.test(branch) && !/stillNeedRender\.push/.test(branch);
  })());
check('B4 [MONEY] a receipt that is merely NOT YET collectable (processing/unknown) '
    + 'is left alone, never requeued — Atlas may be about to hand us the asset',
  (() => {
    const i = sweepSrc.indexOf("r.state === 'processing' || r.state === 'unknown'");
    if (i === -1) return false;
    const branch = sweepSrc.slice(i, i + 200);
    return /stillProcessing\+\+/.test(branch) && !/stillNeedRender\.push/.test(branch);
  })());
check('B5 with no requeue handler supplied it degrades to recovery-only rather '
    + 'than throwing — recovery must never be blocked by the spending half',
  /if \(!requeue \|\| !REQUEUE_ON\(\)\)/.test(sweepSrc));

// ── C. The requeue half reuses the ATOMIC claim ──────────────────────────
check('C1 [DOUBLE-CHARGE] requeue goes through claimAdsForRun — the same atomic '
    + "`status:'queued'` claim POST /runs uses, which is what makes concurrent "
    + 'sweeps across Render instances safe without a lease',
  /await claimAdsForRun\(ads, \{ selectedIds, runId \}\)/.test(adsSrc));
check('C2 [DOUBLE-CHARGE] it renders claim.renderIds, never the pre-claim '
    + 'selection — aliasing those is a known double-charge regression',
  (() => {
    const i = adsSrc.indexOf('async function requeueStrandedAds');
    if (i === -1) return false;
    const fn = adsSrc.slice(i, i + 2600);
    return /runRenderLoop\(newRun, job, claim\.renderIds, renderToken\)/.test(fn)
      && !/runRenderLoop\([^)]*selectedIds/.test(fn);
  })());
check('C3 it bails when the claim wins nothing (another instance got there first)',
  /if \(!claim\?\.renderIds\?\.length\) return 0;/.test(adsSrc));
check('C4 requestedProductIds is stamped from the CLAIMED ads — generationGate '
    + 'fails closed on an unreadable scope, so a partial list is worse than none',
  /requestedProductIds: \[\.\.\.new Set\(/.test(adsSrc));

// ── D. Wiring, and no import cycle ───────────────────────────────────────
check('D1 the sweeper does NOT require routes/ads — that cycle would drag half '
    + 'the service graph into boot; the handler is injected instead',
  !/require\('\.\.\/routes\/ads'\)/.test(sweepSrc) && /requeue = null/.test(sweepSrc));
check('D2 index.js injects the real handler', /requeueStrandedAds/.test(idxSrc));
check('D3 single-flight, like the titling sweeper — a pass can outlast its '
    + 'interval and stacking renders on the web process is a memory hazard',
  (() => {
    const i = idxSrc.indexOf('sweepStrandedRuns');
    const region = idxSrc.slice(Math.max(0, i - 1200), i + 600);
    return /inFlightPass/.test(region);
  })());
check('D4 the first tick is delayed — on a deploy THIS process just replaced the '
    + 'one whose SIGTERM stranded the ads, so an immediate sweep would race the '
    + "shutdown handler's own requeue write",
  /setTimeout\(tick, 120 \* 1000\)/.test(idxSrc));

// ── E. Behavioral: order + filtering, with recovery stubbed ──────────────
(async () => {
  const CampaignRun = require('../models/CampaignRun');
  const Ad = require('../models/Ad');
  const origRunFind = CampaignRun.find, origAdFind = Ad.find;
  try {
    const runs = [{ runId: 'r1', campaignId: 'c1', brandId: 'b1', campaignKind: 'promotional' }];
    const ads = [
      { _id: 'paid1',  campaignRunIds: ['r1'], imageGeneration: { predictionId: 'p1' } },
      { _id: 'free1',  campaignRunIds: ['r1'] },
      { _id: 'busy1',  campaignRunIds: ['r1'], imageGeneration: { predictionId: 'p2' } }
    ];
    CampaignRun.find = () => ({ select: () => ({ lean: async () => runs }) });
    Ad.find = () => ({ limit: () => ({ lean: async () => ads }) });
    const recover = async ({ ad }) => {
      if (ad._id === 'paid1') return { state: 'recovered', predictionId: 'p1' };
      if (ad._id === 'busy1') return { state: 'processing', predictionId: 'p2' };
      return { state: 'no-receipt' };
    };

    let requeuedIds = null;
    const out = await sweeper.sweepStrandedRuns({
      recover,
      requeue: async ({ ads }) => { requeuedIds = ads.map(a => a._id); return ads.length; }
    });

    check('E1 the already-PAID ad was recovered, not requeued', out.recovered === 1);
    check('E2 [MONEY] ONLY the receipt-free ad was requeued — the paid one and the '
        + 'still-processing one were both withheld',
      requeuedIds && requeuedIds.length === 1 && requeuedIds[0] === 'free1',
      JSON.stringify(requeuedIds));
    check('E3 a receipt still processing is counted, not re-bought', out.stillProcessing === 1);

    // Recovery-only mode must never requeue.
    requeuedIds = null;
    const out2 = await sweeper.sweepStrandedRuns({ recover });
    check('E4 with no requeue handler: recovery still happens, nothing is requeued',
      out2.recovered === 1 && out2.requeued === 0 && requeuedIds === null);
  } finally {
    CampaignRun.find = origRunFind;
    Ad.find = origAdFind;
  }

  // ── Revert-proof (manual, per CLAUDE.md §5) ────────────────────────────
  // 1. Push every ad to stillNeedRender regardless of receipt -> B2/E2 fail (the
  //    re-buy-what-we-own regression).
  // 2. Move the requeue pass above the recovery pass -> B1 fails.
  // 3. Treat 'processing' as requeueable -> B4/E3 fail.
  // 4. Drop the renderStage predicate -> A1 fails (sweeping ads an operator never
  //    asked to render).
  // 5. Render selectedIds instead of claim.renderIds -> C2 fails.
  // Each verified by hand before shipping this harness.

  if (failures.length) {
    console.error(`❌ verifyStrandedSweep: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyStrandedSweep: ${pass} checks passed`);
})();
