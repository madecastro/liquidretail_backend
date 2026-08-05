#!/usr/bin/env node
'use strict';
/**
 * verifyAtlasBilling — offline guards for the Atlas billing reconciler.
 *
 * WHY THIS EXISTS (measured live 2026-08-05, production Reach-Social.io)
 * CostLog and Atlas disagreed badly per category while the aggregate nearly
 * cancelled (video 1.14x over, image 0.46x under, text 1.02x, total 0.99x) —
 * which is why nothing was noticed for weeks. The guards below pin:
 *
 *   - integer micro-USD (no float drift on money)
 *   - scope identity (liquidretail ≠ account for the same date+model)
 *   - partial-day finality (the single most important guard)
 *   - 180-day window split + group_by allowlist (live-verified 400s)
 *   - the AND-gate drift floors AND the rolling window that would have
 *     caught 35 days of image under-reporting at ~$1.11/day
 *   - balance streak vs overdrawn-first-read (auto-refill is $30 vs ~$35/day)
 *
 * Pure offline by default: no DB, no network, no API key.
 *   node scripts/verifyAtlasBilling.js
 *
 * Optional on-demand inspection (real env + network + DB) — deliberately
 * NOT an HTTP route (account-wide COGS behind per-Advertiser auth would be
 * a cross-tenant leak):
 *   node scripts/verifyAtlasBilling.js --live
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIVE = process.argv.includes('--live');

let pass = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err && err.message ? err.message : err}`);
  }
}

function checkEq(label, actual, expected) {
  check(label, () => assert.strictEqual(actual, expected));
}

/** Chainable lean()/select() stub for AtlasSpendDay.find. */
function findStub(rows) {
  return {
    lean: async () => rows,
    select() { return this; },
    then(resolve, reject) {
      return Promise.resolve(rows).then(resolve, reject);
    }
  };
}

async function runOffline() {
  // Env defaults the reconciler reads lazily. Set BEFORE requiring it.
  process.env.ATLAS_BILLING_ENABLED = 'true';
  process.env.ATLAS_DRIFT_ABS_USD = '5';
  process.env.ATLAS_DRIFT_PCT = '0.20';
  process.env.ATLAS_DRIFT_ROLLING_ABS_USD = '5';
  process.env.ATLAS_DRIFT_ROLLING_DAYS = '7';
  process.env.ATLAS_ROLLING_MIN_DAYS = '5';
  process.env.ATLAS_BALANCE_ALERT_USD = '10';
  process.env.ATLAS_BALANCE_LOW_STREAK = '3';
  // Present so the disabled path is not taken; never used offline (stubs).
  process.env.ATLAS_API_KEY = process.env.ATLAS_API_KEY || 'test-key-offline-verify';
  process.env.ATLAS_BILLING_KEY_IDS = process.env.ATLAS_BILLING_KEY_IDS
    || 'ak_uLsOnKBB7nBIJ8OnKxoBEh';

  const AtlasSpendDay = require('../models/AtlasSpendDay');
  const CostLog = require('../models/CostLog');
  const alerts = require('../services/alertService');
  const {
    dateWindows,
    VALID_GROUP_BY,
    getModelCosts,
    BILLING_BASE
  } = require('../services/atlasBillingClient');

  const reconSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'atlasSpendReconciler.js'),
    'utf8'
  );

  const origFind = AtlasSpendDay.find;
  const origAggregate = CostLog.aggregate;
  const origNotify = alerts.notify;

  let capturedAlerts = [];
  alerts.notify = async (opts) => {
    capturedAlerts.push(opts);
    return true;
  };

  delete require.cache[require.resolve('../services/atlasSpendReconciler')];
  let reconciler = require('../services/atlasSpendReconciler');

  console.log('\nverifyAtlasBilling (offline)\n');

  // ── A. Money: micro-USD ─────────────────────────────────────────────────
  checkEq("A1 usdStringToMicros('30.016346') === 30016346",
    AtlasSpendDay.usdStringToMicros('30.016346'), 30016346);
  checkEq("A2 usdStringToMicros('0.000001') === 1",
    AtlasSpendDay.usdStringToMicros('0.000001'), 1);
  checkEq("A3 usdStringToMicros('0') === 0",
    AtlasSpendDay.usdStringToMicros('0'), 0);
  checkEq("A4 usdStringToMicros('') === 0",
    AtlasSpendDay.usdStringToMicros(''), 0);
  checkEq('A5 usdStringToMicros(null) === 0',
    AtlasSpendDay.usdStringToMicros(null), 0);
  checkEq("A6 usdStringToMicros('not-a-number') === 0",
    AtlasSpendDay.usdStringToMicros('not-a-number'), 0);
  checkEq('A7 usdStringToMicros(undefined) === 0',
    AtlasSpendDay.usdStringToMicros(undefined), 0);

  for (const x of ['3.903481', '0.592806', '125.500000']) {
    checkEq(`A8 round-trip microsToUsdString(usdStringToMicros('${x}'))`,
      AtlasSpendDay.microsToUsdString(AtlasSpendDay.usdStringToMicros(x)), x);
  }

  check('A9 10,000 micro sums have no float drift (WHY micro-USD exists)', () => {
    const N = 10_000;
    let microSum = 0;
    let floatSum = 0;
    for (let i = 0; i < N; i++) {
      microSum += AtlasSpendDay.usdStringToMicros('0.1');
      floatSum += 0.1;
    }
    assert.strictEqual(microSum, 1_000_000_000);
    assert.strictEqual(AtlasSpendDay.microsToUsdString(microSum), '1000.000000');
    // Classic 0.1 accumulation drift — the reason we refuse float money.
    assert.notStrictEqual(floatSum, 1000,
      `float sum unexpectedly exact (${floatSum}); fixture no longer demonstrates drift`);
  });

  // ── B. Identity / idempotency ───────────────────────────────────────────
  check('B1 buildKey stable for identical inputs', () => {
    const a = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'liquidretail', groupBy: 'model',
      modelType: 'image', modelName: 'openai/gpt-image-2/edit', apiKeyId: 'ak_x'
    });
    const b = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'liquidretail', groupBy: 'model',
      modelType: 'image', modelName: 'openai/gpt-image-2/edit', apiKeyId: 'ak_x'
    });
    assert.strictEqual(a, b);
  });
  check('B2 buildKey order-independent of caller object key order', () => {
    const a = AtlasSpendDay.buildKey({
      apiKeyId: 'ak_x', modelName: 'm', modelType: 'video',
      groupBy: 'model', scope: 'liquidretail', date: '2026-08-01'
    });
    const b = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'liquidretail', groupBy: 'model',
      modelType: 'video', modelName: 'm', apiKeyId: 'ak_x'
    });
    assert.strictEqual(a, b);
  });
  check('B3 liquidretail vs account do NOT collide (same date+model)', () => {
    const lr = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'liquidretail', groupBy: 'model',
      modelType: 'video', modelName: 'google/omni', apiKeyId: null
    });
    const ac = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'account', groupBy: 'model',
      modelType: 'video', modelName: 'google/omni', apiKeyId: null
    });
    assert.notStrictEqual(lr, ac);
    assert.ok(lr.includes('liquidretail'));
    assert.ok(ac.includes('account'));
  });
  check('B4 missing dimensions become "_" placeholders (model_type vs model)', () => {
    const byType = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'liquidretail', groupBy: 'model_type',
      modelType: 'image', modelName: null, apiKeyId: null
    });
    const byModel = AtlasSpendDay.buildKey({
      date: '2026-08-01', scope: 'liquidretail', groupBy: 'model',
      modelType: 'image', modelName: 'openai/gpt-image-2/edit', apiKeyId: null
    });
    assert.notStrictEqual(byType, byModel);
    assert.strictEqual(byType, '2026-08-01|liquidretail|model_type|image|_|_');
  });

  // ── C. Finality (the most important guard) ──────────────────────────────
  AtlasSpendDay.find = () => findStub([
    {
      date: '2026-08-04',
      scope: 'liquidretail',
      groupBy: 'model',
      modelType: 'image',
      modelName: 'openai/gpt-image-2/edit',
      amountMicroUsd: 1_000_000,
      partial: true
    }
  ]);
  CostLog.aggregate = async () => {
    throw new Error('ledger must not be queried for a partial day');
  };
  capturedAlerts = [];
  {
    const r = await reconciler.detectDrift({ date: '2026-08-04' });
    check('C1 detectDrift refuses a partial day (skipped === true)', () => {
      assert.strictEqual(r.skipped, true);
      assert.ok(/partial/i.test(r.reason || ''), `reason=${r.reason}`);
    });
    check('C2 partial day does not alert and does not touch the ledger', () => {
      assert.strictEqual(capturedAlerts.length, 0);
      // CostLog.aggregate throws if called — reaching here means it was not.
    });
  }
  check('C3 source: partial:true short-circuits detectDrift before ledger join', () => {
    assert.ok(/r\.partial === true/.test(reconSrc));
    assert.ok(/not safe to reconcile/.test(reconSrc));
  });
  check('C4 source: a day is partial unless sawFinal && !sawPartial', () => {
    assert.ok(/!\(slot\.sawFinal && !slot\.sawPartial\)/.test(reconSrc));
  });

  // ── D. Windowing ────────────────────────────────────────────────────────
  check('D1 BILLING_BASE is /public/v1 (NOT the generation /api/v1)', () => {
    assert.ok(String(BILLING_BASE).includes('/public/v1'), String(BILLING_BASE));
  });
  check('D2 exactly-180-day span is ONE window (live: 180 → HTTP 200)', () => {
    // start inclusive, end exclusive → 180 calendar days.
    const w = dateWindows('2026-01-01', '2026-06-30');
    assert.strictEqual(w.length, 1, JSON.stringify(w));
    assert.strictEqual(w[0].startDate, '2026-01-01');
    assert.strictEqual(w[0].endDate, '2026-06-30');
  });
  check('D3 181-day span splits into TWO windows (live: 181 → 400 invalid_time_range)', () => {
    const w = dateWindows('2026-01-01', '2026-07-01');
    assert.strictEqual(w.length, 2, JSON.stringify(w));
  });
  check('D4 windows are contiguous and non-overlapping (end == next.start)', () => {
    const w = dateWindows('2026-01-01', '2026-12-31');
    assert.ok(w.length >= 2);
    for (let i = 0; i < w.length - 1; i++) {
      assert.strictEqual(w[i].endDate, w[i + 1].startDate,
        `gap/overlap between window ${i} and ${i + 1}`);
    }
    assert.strictEqual(w[0].startDate, '2026-01-01');
    assert.strictEqual(w[w.length - 1].endDate, '2026-12-31');
  });
  check('D5 start >= end throws', () => {
    assert.throws(() => dateWindows('2026-08-01', '2026-08-01'));
    assert.throws(() => dateWindows('2026-08-02', '2026-08-01'));
  });

  // ── E. group_by allowlist ───────────────────────────────────────────────
  check('E1 VALID_GROUP_BY allows model_type | model | api_key | model+api_key', () => {
    const norm = (arr) => arr.slice().sort().join('+');
    const allowed = new Set(VALID_GROUP_BY.map(norm));
    assert.ok(allowed.has('model_type'));
    assert.ok(allowed.has('model'));
    assert.ok(allowed.has('api_key'));
    assert.ok(allowed.has('api_key+model'));
  });

  async function assertGroupByThrows(groupBy) {
    let threw = null;
    try {
      // normalizeGroupBy runs before any network / key check.
      await getModelCosts({
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        groupBy
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'expected local throw');
    assert.ok(/invalid group_by/i.test(threw.message), threw.message);
  }

  try {
    await assertGroupByThrows(['model_type', 'model']);
    pass++;
  } catch (err) {
    failures.push(`E2 model_type+model throws LOCALLY (live 400 invalid_group_by): ${err.message}`);
  }
  try {
    await assertGroupByThrows(['model_type', 'api_key']);
    pass++;
  } catch (err) {
    failures.push(`E3 model_type+api_key throws LOCALLY (live 400 invalid_group_by): ${err.message}`);
  }

  // Accepted combos: local allowlist membership is the acceptance gate
  // (calling getModelCosts with a valid groupBy would proceed to HTTP).
  check('E4 accepted group_by combos are exactly the four live-verified ones', () => {
    assert.strictEqual(VALID_GROUP_BY.length, 4);
  });

  // ── F. Drift gates (AND: abs AND rel) ───────────────────────────────────
  /**
   * Drive detectDrift with one modelType category.
   * atlasUsd / ledgerUsd are dollars.
   */
  async function driftDay({ date, modelType, modelName, atlasUsd, ledgerUsd }) {
    capturedAlerts = [];
    AtlasSpendDay.find = () => findStub([
      {
        date,
        scope: 'liquidretail',
        groupBy: 'model',
        modelType,
        modelName,
        amountMicroUsd: Math.round(atlasUsd * 1e6),
        partial: false
      }
    ]);
    CostLog.aggregate = async () => ([
      {
        _id: modelName,
        costUsd: ledgerUsd,
        n: 1,
        actual: 0,
        estimated: 1,
        none: 0,
        missing: 0
      }
    ]);
    return reconciler.detectDrift({ date });
  }

  // $0.50 at 3x → silent (abs below $5 floor)
  // atlas $0.25, ledger $0.75 → abs $0.50, rel 2.0, ratio 3x
  {
    const r = await driftDay({
      date: '2026-07-10',
      modelType: 'image',
      modelName: 'tiny/model',
      atlasUsd: 0.25,
      ledgerUsd: 0.75
    });
    check('F1 $0.50 @ 3x is silent (abs below floor)', () => {
      assert.strictEqual(r.skipped, false);
      assert.deepStrictEqual(r.alerted, []);
      assert.strictEqual(capturedAlerts.length, 0);
      const cat = r.categories.image;
      assert.ok(cat.absUsd < 5, `abs=${cat.absUsd}`);
      assert.ok(cat.rel >= 0.20, `rel=${cat.rel}`);
    });
  }

  // $40 at 1.4x → fires
  // atlas $100, ledger $140 → abs $40, rel 0.40, ratio 1.4
  {
    const r = await driftDay({
      date: '2026-07-11',
      modelType: 'video',
      modelName: 'google/omni',
      atlasUsd: 100,
      ledgerUsd: 140
    });
    check('F2 $40 @ 1.4x fires (abs AND rel both trip)', () => {
      assert.strictEqual(r.skipped, false);
      assert.ok(r.alerted.includes('video'), `alerted=${JSON.stringify(r.alerted)}`);
      assert.ok(capturedAlerts.length >= 1);
      const cat = r.categories.video;
      assert.ok(Math.abs(cat.absUsd - 40) < 0.01, `abs=${cat.absUsd}`);
      assert.ok(Math.abs(cat.ratio - 1.4) < 0.001, `ratio=${cat.ratio}`);
    });
  }

  // text's real $1.06 at ~1.5% → silent (measured 2026-08-05)
  // atlas $69.62, ledger $70.68
  {
    const r = await driftDay({
      date: '2026-07-12',
      modelType: 'text',
      modelName: 'google/gemini-2.5-flash',
      atlasUsd: 69.62,
      ledgerUsd: 70.68
    });
    check('F3 text real $1.06 @ ~1.5% is silent (abs below floor)', () => {
      assert.strictEqual(r.skipped, false);
      assert.deepStrictEqual(r.alerted, []);
      const cat = r.categories.text;
      assert.ok(cat.absUsd < 5, `abs=${cat.absUsd}`);
      assert.ok(cat.rel < 0.20, `rel=${cat.rel}`);
      assert.ok(Math.abs(cat.absUsd - 1.06) < 0.02, `abs=${cat.absUsd}`);
    });
  }

  // ── G. Rolling window — THE highest-value assertion ─────────────────────
  // Image ran 0.46x under for 35 consecutive days at ~$1.11/day of
  // under-reporting. Daily abs ($1.11) is below the $5 floor every single
  // day; 7-day rolling abs ($7.77) crosses it. This is the hole that let
  // image drift for 35 days unnoticed.
  //
  // Per day: abs delta $1.11, ratio ledger/atlas = 0.46
  //   abs = atlas * (1 - 0.46) = 0.54 * atlas = 1.11
  //   atlas = 1.11 / 0.54     ledger = 0.46 * atlas
  const DAY_ATLAS = 1.11 / 0.54;
  const DAY_LEDGER = DAY_ATLAS * 0.46;
  const DAY_ABS = DAY_ATLAS - DAY_LEDGER; // ≈ 1.11

  const rollingDates = [
    '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04',
    '2026-07-05', '2026-07-06', '2026-07-07'
  ];
  const MODEL = 'openai/gpt-image-2/edit';

  let dailyAlerts = 0;
  for (const date of rollingDates) {
    const r = await driftDay({
      date,
      modelType: 'image',
      modelName: MODEL,
      atlasUsd: DAY_ATLAS,
      ledgerUsd: DAY_LEDGER
    });
    if ((r.alerted || []).includes('image')) dailyAlerts++;
    check(`G1 daily ${date} does NOT trip (abs≈$${DAY_ABS.toFixed(2)} < $5)`, () => {
      assert.strictEqual(r.skipped, false);
      assert.ok(!(r.alerted || []).includes('image'),
        `alerted=${JSON.stringify(r.alerted)}`);
      const cat = r.categories.image;
      assert.ok(cat.absUsd < 5, `abs=${cat.absUsd}`);
      assert.ok(Math.abs(cat.ratio - 0.46) < 0.01, `ratio=${cat.ratio}`);
    });
  }
  check('G2 zero of seven daily checks alerted', () => {
    assert.strictEqual(dailyAlerts, 0);
  });

  capturedAlerts = [];
  {
    const rows = rollingDates.map((date) => ({
      date,
      partial: false,
      modelName: MODEL,
      modelType: 'image',
      amountMicroUsd: Math.round(DAY_ATLAS * 1e6)
    }));
    AtlasSpendDay.find = () => findStub(rows);
    CostLog.aggregate = async () => ([
      {
        _id: MODEL,
        costUsd: DAY_LEDGER * rollingDates.length,
        n: rollingDates.length,
        actual: 0,
        estimated: rollingDates.length,
        none: 0,
        missing: 0
      }
    ]);

    const r = await reconciler.detectRollingDrift();
    check('G3 rolling 7d @ ~$1.11/day under-report (0.46x) DOES fire', () => {
      assert.strictEqual(r.skipped, false, `skipped reason=${r.reason}`);
      assert.ok(r.alerted.includes('image'), `alerted=${JSON.stringify(r.alerted)}`);
      assert.ok(capturedAlerts.length >= 1, 'expected a rolling drift alert');
      const cat = r.categories.image;
      // 7 * $1.11 ≈ $7.77 ≥ $5 abs floor; rel stays ~0.54 ≥ 0.20
      assert.ok(cat.absUsd >= 5, `rolling abs=${cat.absUsd} (need ≥ 5)`);
      assert.ok(cat.rel >= 0.20, `rolling rel=${cat.rel}`);
      assert.ok(Math.abs(cat.ratio - 0.46) < 0.02, `ratio=${cat.ratio}`);
    });
    check('G4 rolling alert payload has no "runway"', () => {
      const blob = JSON.stringify(capturedAlerts);
      assert.ok(!/runway/i.test(blob), blob);
    });
  }

  // ── H. Balance streak / overdrawn ───────────────────────────────────────
  // getBalance is destructured at reconciler load time — re-require with a
  // stub on the billing client module first.
  function reloadReconcilerWithBalance(getBalanceImpl) {
    delete require.cache[require.resolve('../services/atlasSpendReconciler')];
    delete require.cache[require.resolve('../services/atlasBillingClient')];
    const billing = require('../services/atlasBillingClient');
    billing.getBalance = getBalanceImpl;
    alerts.notify = async (opts) => {
      capturedAlerts.push(opts);
      return true;
    };
    return require('../services/atlasSpendReconciler');
  }

  const lowBalance = {
    availableUsd: 5,
    overdrawnUsd: 0,
    creditGrantStatus: 'normal'
  };
  const healthyBalance = {
    availableUsd: 50,
    overdrawnUsd: 0,
    creditGrantStatus: 'normal'
  };
  const overdrawnBalance = {
    availableUsd: 0,
    overdrawnUsd: 1.25,
    creditGrantStatus: 'normal'
  };

  const sequence = [
    lowBalance,       // streak 1 — no alert
    lowBalance,       // streak 2 — no alert
    lowBalance,       // streak 3 — stalled alert
    healthyBalance,   // reset
    overdrawnBalance  // broken alert immediately
  ];
  let balCall = 0;
  capturedAlerts = [];
  reconciler = reloadReconcilerWithBalance(async () =>
    sequence[Math.min(balCall++, sequence.length - 1)]
  );
  AtlasSpendDay.find = () => findStub([]);

  {
    const r1 = await reconciler.checkBalance();
    check('H1 sub-threshold read 1/3 does NOT alert', () => {
      assert.strictEqual(r1.alerted, false);
      assert.strictEqual(r1.lowBalanceStreak, 1);
      assert.strictEqual(r1.stalled, false);
      assert.strictEqual(r1.broken, false);
    });

    const r2 = await reconciler.checkBalance();
    check('H2 sub-threshold read 2/3 does NOT alert', () => {
      assert.strictEqual(r2.alerted, false);
      assert.strictEqual(r2.lowBalanceStreak, 2);
    });

    const r3 = await reconciler.checkBalance();
    check('H3 sub-threshold read 3/3 DOES alert (streak)', () => {
      assert.strictEqual(r3.alerted, true);
      assert.strictEqual(r3.stalled, true);
      assert.strictEqual(r3.lowBalanceStreak, 3);
      assert.ok(capturedAlerts.length >= 1);
    });

    const streakAlerts = capturedAlerts.length;
    const r4 = await reconciler.checkBalance();
    check('H4 healthy read resets streak and does not alert', () => {
      assert.strictEqual(r4.alerted, false);
      assert.strictEqual(r4.lowBalanceStreak, 0);
      assert.strictEqual(r4.stalled, false);
      assert.strictEqual(capturedAlerts.length, streakAlerts);
    });

    const beforeBroken = capturedAlerts.length;
    const r5 = await reconciler.checkBalance();
    check('H5 credit_grant.overdrawn > 0 alerts on FIRST read (bypasses streak)', () => {
      assert.strictEqual(r5.alerted, true);
      assert.strictEqual(r5.broken, true);
      assert.ok(capturedAlerts.length > beforeBroken);
    });

    check('H6 balance alert payload must NOT contain "runway"', () => {
      const blob = JSON.stringify(capturedAlerts);
      assert.ok(!/runway/i.test(blob), `payload contained runway: ${blob}`);
    });

    check('H7 checkBalance fields object has no runway key', () => {
      const fnBody = reconSrc.slice(
        reconSrc.indexOf('async function checkBalance'),
        reconSrc.indexOf('// ── 5. runReconcilerTick')
      );
      assert.ok(!/runway\s*:/i.test(fnBody), 'fields must not include a runway key');
    });
  }

  // Restore
  AtlasSpendDay.find = origFind;
  CostLog.aggregate = origAggregate;
  alerts.notify = origNotify;

  if (failures.length) {
    console.error(`\n❌ verifyAtlasBilling: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyAtlasBilling: ${pass} checks passed`);
}

// ── --live inspection (opt-in, never CI) ────────────────────────────────────

async function runLive() {
  require('dotenv').config();
  require('dotenv').config({
    path: path.join(__dirname, '..', 'config', 'defaults.env')
  });

  const mongoose = require('mongoose');
  const AtlasSpendDay = require('../models/AtlasSpendDay');
  const CostLog = require('../models/CostLog');

  if (!process.env.MONGODB_URI) {
    console.error('--live requires MONGODB_URI');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('\nverifyAtlasBilling --live  (AtlasSpendDay liquidretail vs CostLog)\n');
  console.log(
    'date        Atlas $      ledger $     ratio    flag\n' +
    '----------  -----------  -----------  -------  --------'
  );

  const today = new Date();
  const y = today.getUTCFullYear();
  const mo = String(today.getUTCMonth() + 1).padStart(2, '0');
  const d = String(today.getUTCDate()).padStart(2, '0');
  const todayYmd = `${y}-${mo}-${d}`;
  const start = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate() - 35));
  const startYmd = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;

  const rows = await AtlasSpendDay.find({
    scope: 'liquidretail',
    groupBy: 'model',
    date: { $gte: startYmd, $lte: todayYmd }
  }).select('date amountMicroUsd partial').lean();

  const byDate = new Map();
  for (const r of rows) {
    const slot = byDate.get(r.date) || { atlasMicro: 0, partial: false };
    slot.atlasMicro += Number(r.amountMicroUsd) || 0;
    if (r.partial === true) slot.partial = true;
    byDate.set(r.date, slot);
  }

  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const slot = byDate.get(date);
    const [yy, mm, dd] = date.split('-').map(Number);
    const dayStart = new Date(Date.UTC(yy, mm - 1, dd));
    const dayEnd = new Date(Date.UTC(yy, mm - 1, dd + 1));
    const led = await CostLog.aggregate([
      {
        $match: {
          provider: 'atlas',
          createdAt: { $gte: dayStart, $lt: dayEnd }
        }
      },
      { $group: { _id: null, costUsd: { $sum: '$costUsd' } } }
    ]);
    const ledgerUsd = Number(led[0]?.costUsd) || 0;
    const atlasUsd = AtlasSpendDay.microsToUsd(slot.atlasMicro);
    const ratio = atlasUsd > 0 ? ledgerUsd / atlasUsd : (ledgerUsd > 0 ? Infinity : 1);
    const ratioStr = Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : '∞';
    const flag = slot.partial ? 'PARTIAL' : '';
    console.log(
      `${date}  $${atlasUsd.toFixed(2).padStart(10)}  $${ledgerUsd.toFixed(2).padStart(10)}  ${ratioStr.padStart(7)}  ${flag}`
    );
  }

  if (!dates.length) {
    console.log('(no liquidretail AtlasSpendDay rows in the last 35 days — run backfillAtlasSpend.js --spend first)');
  }

  await mongoose.disconnect();
  console.log('\n(done — --live is inspection only; offline suite is the CI surface)\n');
}

// ── entry ───────────────────────────────────────────────────────────────────

if (LIVE) {
  runLive().catch((err) => {
    console.error('❌ verifyAtlasBilling --live failed:', err);
    process.exit(1);
  });
} else {
  runOffline().catch((err) => {
    console.error('❌ verifyAtlasBilling failed:', err);
    process.exit(1);
  });
}
