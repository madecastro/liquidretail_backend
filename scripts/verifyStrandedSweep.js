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
const videoRecSrc = fs.readFileSync(path.join(ROOT, 'services/videoRecoveryService.js'), 'utf8');

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
// C1 STRENGTHENED after the first live sweep. It used to match the call
// TEXTUALLY — `claimAdsForRun(ads, {...})` — and passed while the call was wrong:
// claimAdsForRun takes a MODEL ADAPTER, not an array, so the real sweep threw
// `ads.updateMany is not a function`. A check that confirms a function is called
// but not that it is called CORRECTLY is barely a check.
check('C1 [DOUBLE-CHARGE] requeue goes through claimAdsForRun with the MODEL '
    + "ADAPTER (not the ad array) — the same atomic `status:'queued'` claim POST "
    + '/runs uses, which is what makes concurrent sweeps across Render instances '
    + 'safe without a lease',
  (() => {
    const i = adsSrc.indexOf('async function requeueStrandedAds');
    if (i === -1) return false;
    const fn = adsSrc.slice(i, i + 2600);
    const call = fn.indexOf('await claimAdsForRun(');
    if (call === -1) return false;
    const args = fn.slice(call, call + 420);
    return /updateMany:/.test(args) && /find:/.test(args)
      && !/claimAdsForRun\(\s*ads\s*,/.test(args);
  })());
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
check('D5 [WIRING] sweepStrandedRuns defaults recover to recoverStrandedAd, not '
    + 'recoverImageAd — leaving the dispatcher unused while the default still '
    + 'points at the image-only recoverer re-opens the video re-buy',
  /recover = recoverStrandedAd/.test(sweepSrc)
  && !/recover = recoverImageAd/.test(sweepSrc));

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
      { _id: 'busy1',  campaignRunIds: ['r1'], imageGeneration: { predictionId: 'p2' } },
      // THE bug this task closes: a veo ad with a veoPredictionId used to be
      // reported 'no-receipt' (recoverImageAd never reads that field) and
      // requeued into a fresh Omni submit. Recovered, never requeued.
      { _id: 'paidVideo1', campaignRunIds: ['r1'], renderRoute: 'veo', veoPredictionId: 'vp1' }
    ];
    CampaignRun.find = () => ({ select: () => ({ lean: async () => runs }) });
    Ad.find = () => ({ limit: () => ({ lean: async () => ads }) });
    const recover = async ({ ad }) => {
      if (ad._id === 'paid1') return { state: 'recovered', predictionId: 'p1' };
      if (ad._id === 'paidVideo1') return { state: 'recovered', predictionId: 'vp1' };
      if (ad._id === 'busy1') return { state: 'processing', predictionId: 'p2' };
      return { state: 'no-receipt' };
    };

    let requeuedIds = null;
    // `settle` MUST be injected too. It defaults to the real settleChargeState,
    // which would issue live Atlas GETs against the fake prediction ids in this
    // fixture — the same silently-hits-the-network trap that made the first
    // version of this test exercise the real recoverImageAd.
    const settle = async () => ({ state: 'unknown' });
    const out = await sweeper.sweepStrandedRuns({
      recover, settle,
      requeue: async ({ ads }) => { requeuedIds = ads.map(a => a._id); return ads.length; }
    });

    check('E1 the already-PAID ad was recovered, not requeued', out.recovered === 2);
    check('E2 [MONEY] ONLY the receipt-free ad was requeued — the paid one and the '
        + 'still-processing one were both withheld',
      requeuedIds && requeuedIds.length === 1 && requeuedIds[0] === 'free1',
      JSON.stringify(requeuedIds));
    check('E3 a receipt still processing is counted, not re-bought', out.stillProcessing === 1);
    check('E5 [MONEY] a stranded video ad WITH a veoPredictionId is recovered, '
        + 'not requeued — the exact invariant this dispatch exists for',
      out.recovered === 2 && requeuedIds && !requeuedIds.includes('paidVideo1'),
      JSON.stringify(requeuedIds));

    // Recovery-only mode must never requeue.
    requeuedIds = null;
    const out2 = await sweeper.sweepStrandedRuns({ recover, settle });
    check('E4 with no requeue handler: recovery still happens, nothing is requeued',
      out2.recovered === 2 && out2.requeued === 0 && requeuedIds === null);
  } finally {
    CampaignRun.find = origRunFind;
    Ad.find = origAdFind;
  }

    // ── F. [MONEY] CHARGE STATE IS RESOLVED, NOT GUESSED ─────────────────
    let settleCalls = 0;
    const settledAds = [
      { _id: 'unk1', renderError: { chargeState: 'unknown', predictionId: 'q1' } }
    ];
    Ad.find = () => ({ limit: () => ({ lean: async () => settledAds }) });
    CampaignRun.find = () => ({ select: () => ({ lean: async () => [] }) });
    const n = await sweeper.settleUnknownCharges({
      settle: async () => { settleCalls++; return { state: 'charged', price: 0.07173 }; }
    });
    check('F1 unknown-charge ads are settled from the provider record', n === 1 && settleCalls === 1,
      `settled=${n} calls=${settleCalls}`);

    const n2 = await sweeper.settleUnknownCharges({
      settle: async () => ({ state: 'unknown' })
    });
    check('F2 [MONEY] a charge that CANNOT be confirmed stays unknown — never '
        + 'guessed to not-charged, which would understate the ledger permanently',
      n2 === 0, `settled=${n2}`);

    // Even with no stranded WORK, the money question must still be asked.
    CampaignRun.find = () => ({ select: () => ({ lean: async () => [] }) });
    let asked = 0;
    const out3 = await sweeper.sweepStrandedRuns({
      recover: async () => ({ state: 'no-receipt' }),
      settle:  async () => { asked++; return { state: 'charged', price: 0.07 }; }
    });
    check('F3 the charge pass runs even when there is no stranded work — "no ads to '
        + 'finish" does not mean "no money unaccounted"',
      asked > 0 && out3.chargesSettled > 0, `asked=${asked} settled=${out3.chargesSettled}`);

    // ── G. [RESOURCE] buildStrandedAdFilter — the REAL filter, not a stub ──
    // 2026-08-18: a wait-only derive video ad's requeue loop moved its
    // bookkeeping off renderAttempts onto deriveWaitAttempts (so the archive
    // sweeper's renderAttempts:0 guard stays honest). That accidentally
    // removed this sweeper's only cap on such an ad — every re-pick mints a
    // fresh CampaignRun without ever clearing the ORIGINAL failed run out of
    // campaignRunIds, so the $in match keeps firing every pass regardless of
    // how many since-completed runs pile up. Section E above stubs Ad.find
    // entirely, so it tests the PROCESSING logic given a fixed candidate list
    // — never whether the filter itself would have produced that list. These
    // checks evaluate the actual exported filter object against real document
    // shapes, the same way scripts/verifyNoStrandedQueued.js pins
    // buildQueuedArchiveFilter.
    {
      // Same tiny Mongo matcher as verifyNoStrandedQueued.js — deliberately
      // narrow (throws on an operator it does not implement) so a future
      // operator added to the query cannot be silently mis-evaluated.
      function matchOp(value, cond) {
        if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
          for (const [op, operand] of Object.entries(cond)) {
            if (op === '$lt') { if (!(value != null && value < operand)) return false; }
            else if (op === '$in') {
              if (Array.isArray(value)) { if (!value.some((v) => operand.includes(v))) return false; }
              else if (!operand.includes(value)) return false;
            } else if (op === '$nin') {
              if (Array.isArray(value)) { if (value.some((v) => operand.includes(v))) return false; }
              else if (operand.includes(value)) return false;
            } else if (op === '$exists') {
              const exists = value !== undefined;
              if (operand ? !exists : exists) return false;
            } else {
              throw new Error(`matcher does not implement operator ${op}`);
            }
          }
          return true;
        }
        return value === cond;
      }
      function matches(doc, filter) {
        for (const [key, cond] of Object.entries(filter)) {
          if (key === '$or') { if (!cond.some((sub) => matches(doc, sub))) return false; }
          else if (key === '$and') { if (!cond.every((sub) => matches(doc, sub))) return false; }
          else if (!matchOp(doc[key], cond)) return false;
        }
        return true;
      }

      const FAILED_RUN_IDS = ['run_failed_1'];
      const F = sweeper.buildStrandedAdFilter({ failedRunIds: FAILED_RUN_IDS });
      const stranded = (over = {}) => ({
        status: 'queued',
        campaignRunIds: ['run_failed_1'],
        renderStage: 'derive-only: waiting for master pmax_video_9_16 (attempt 2/30)',
        renderAttempts: 0,
        deriveWaitAttempts: 0,
        ...over
      });

      check('G1 [THE BUG] renderAttempts:0 alone used to mean "eligible forever" — '
          + 'a wait-only derive ad with deriveWaitAttempts already at the bound is '
          + 'NOT selected (deriveWaitAttempts: MAX_ATTEMPTS must exclude it)',
        matches(stranded({ deriveWaitAttempts: sweeper.MAX_ATTEMPTS }), F) === false,
        'without this bound the sweeper would keep re-picking a wait-only ad up to '
        + 'MAX_DERIVE_WAIT_ATTEMPTS (30) cycles instead of stopping at MAX_ATTEMPTS');
      check('G1b a derive ad one BELOW the bound is still selected (the cap is not off by one)',
        matches(stranded({ deriveWaitAttempts: sweeper.MAX_ATTEMPTS - 1 }), F) === true);
      check('G2 the EXISTING renderAttempts bound still independently excludes a poisoned ad',
        matches(stranded({ renderAttempts: sweeper.MAX_ATTEMPTS }), F) === false);
      check('G3 a missing deriveWaitAttempts field counts as 0 (legacy / non-derive ads are unaffected)',
        (() => {
          const doc = stranded();
          delete doc.deriveWaitAttempts;
          return matches(doc, F) === true;
        })());
      check('G4 an ordinary render-path ad (renderAttempts under bound, no deriveWaitAttempts at all) is still selected',
        (() => {
          const doc = stranded({ renderAttempts: 1 });
          delete doc.deriveWaitAttempts;
          return matches(doc, F) === true;
        })());
      check('G5 an ad from a run NOT in the failed set is not selected (scope unchanged by this fix)',
        matches(stranded({ campaignRunIds: ['run_other'] }), F) === false);
      check('G6 [WIRING] findStranded uses buildStrandedAdFilter for its Ad.find call — '
          + 'source-level, because G1-G5 would otherwise be testing a copy',
        /Ad\.find\(buildStrandedAdFilter\(/.test(sweepSrc));
    }

    // ── H. recoverStrandedAd dispatches by renderRoute ──────────────────
    // THE bug this task closes: recoverImageAd is image-only, so every video
    // ad used to be reported 'no-receipt' and requeued into a fresh Omni
    // submit. These call the dispatcher DIRECTLY with injected stubs so a
    // future "just call recoverImageAd for everything" revert fails loudly.
    {
      let imageCalls = 0;
      let videoCalls = 0;
      const recoverImage = async () => { imageCalls += 1; return { state: 'no-receipt' }; };
      const recoverVideo = async () => { videoCalls += 1; return { state: 'recovered', predictionId: 'vp' }; };

      imageCalls = 0; videoCalls = 0;
      await sweeper.recoverStrandedAd({
        ad: { _id: 'v1', renderRoute: 'veo', veoPredictionId: 'vp1' },
        recoverImage, recoverVideo
      });
      check('H1 [MONEY] renderRoute:\'veo\' calls ONLY recoverVideo, never recoverImage — '
          + 'this is the bug: previously EVERY ad, video or not, went through recoverImageAd',
        videoCalls === 1 && imageCalls === 0,
        `video=${videoCalls} image=${imageCalls}`);

      imageCalls = 0; videoCalls = 0;
      await sweeper.recoverStrandedAd({
        ad: { _id: 'i1' },
        recoverImage, recoverVideo
      });
      check('H2 no renderRoute calls ONLY recoverImage, never recoverVideo '
          + '(legacy ads predating the field keep today\'s image path)',
        imageCalls === 1 && videoCalls === 0,
        `image=${imageCalls} video=${videoCalls}`);

      imageCalls = 0; videoCalls = 0;
      await sweeper.recoverStrandedAd({
        ad: { _id: 'i2', renderRoute: 'html_gen' },
        recoverImage, recoverVideo
      });
      check('H2b renderRoute:\'html_gen\' also stays on the image recoverer',
        imageCalls === 1 && videoCalls === 0,
        `image=${imageCalls} video=${videoCalls}`);
    }

    // ── I. [MONEY] video recovery never submits ─────────────────────────
    // Mirrors scripts/verifyImageRecovery.js A1/A2: recovery's only provider
    // call is a free GET (resumeForAd → peekPrediction). submitGeneration is
    // the billable Omni POST in atlasVideoService.js. Comments are stripped
    // first — the module header NAMING the banned function is not a call.
    const videoRecCode = videoRecSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    check('I1 [MONEY] video recovery never calls submitGeneration — that is the '
        + 'billable Omni POST',
      !/\bsubmitGeneration\s*\(/.test(videoRecCode));
    check('I2 [MONEY] video recovery issues no HTTP POST of its own',
      !/axios\.post\(/.test(videoRecCode));

  // ── Revert-proof (manual, per CLAUDE.md §5) ────────────────────────────
  // 1. Push every ad to stillNeedRender regardless of receipt -> B2/E2 fail (the
  //    re-buy-what-we-own regression).
  // 2. Move the requeue pass above the recovery pass -> B1 fails.
  // 3. Treat 'processing' as requeueable -> B4/E3 fail.
  // 4. Drop the renderStage predicate -> A1 fails (sweeping ads an operator never
  //    asked to render).
  // 5. Render selectedIds instead of claim.renderIds -> C2 fails.
  // 6. Drop the deriveWaitAttempts bound from buildStrandedAdFilter -> G1/G1b fail.
  // 7. Make recoverStrandedAd call recoverImageAd regardless of renderRoute ->
  //    H1 fails (a veo ad would hit the image stub). Reverting the sweep
  //    default recover to recoverImageAd (dispatcher unused) -> D5 fails.
  // Each verified by hand before shipping this harness.

  if (failures.length) {
    console.error(`❌ verifyStrandedSweep: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyStrandedSweep: ${pass} checks passed`);
})();
