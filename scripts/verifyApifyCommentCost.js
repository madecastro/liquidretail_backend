#!/usr/bin/env node
'use strict';
/**
 * verifyApifyCommentCost — pins the money arithmetic behind the Tier-4
 * capability media.refreshCommentsFromApify.
 *
 * WHY THIS EXISTS
 * The preview an operator approves on used to read:
 *
 *     const capped = Math.min(targets, MAX_STEPS_PER_RUN);
 *     const estimateUsd = Math.round(capped * PER_UNIT_ESTIMATE_USD * 100) / 100;
 *
 * with PER_UNIT_ESTIMATE_USD a flat $0.02 per POST, above a comment that
 * claimed the actor "bills per run + per record". Both halves were wrong.
 * apify/instagram-scraper is PAY_PER_EVENT with exactly ONE charge event
 * ('result' = one dataset row) and NO per-run fee — verified live
 * 2026-08-10 against the actor's pricing entry AND against a settled run
 * (chargedEventCounts {result:10} ↔ usageTotalUsd $0.023, i.e. 10 ×
 * $0.0023 with nothing added for the run itself).
 *
 * The consequence was silent and expensive: the estimate never referenced
 * APIFY_IG_COMMENTS_LIMIT, so the number the operator saw was IDENTICAL
 * whether each run was asked for 50 comments or 100. At BRONZE with 100
 * posts × 50 comments the gate showed $2.00 against a real ~$11.50 (5.75×);
 * at 100 comments, still $2.00 against ~$23 (11.5×).
 *
 * These checks pin: the per-tier rate card, that the estimate moves with
 * BOTH drivers, that a comment-limit change moves the number, the float
 * rounding, the legacy override's back-compat, and the kill switch.
 *
 * Pure — node:assert only. No network, no DB, no API key.
 */

const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const costModel = require('../services/apifyCostModel');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// Run a thunk with a temporarily patched process.env, always restoring.
function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = String(v);
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const est = (o) => costModel.estimateCommentPullUsd(o);

// ── A. The rate card, copied from the live actor ───────────────────
console.log('\n[A] Tiered $/result rate card');

// Fetched verbatim 2026-08-10 from
// GET https://api.apify.com/v2/acts/apify~instagram-scraper →
// pricingInfos[last].pricingPerEvent.actorChargeEvents.result.eventTieredPricingUsd
const LIVE_TIERS = {
  FREE:     0.0027,
  BRONZE:   0.0023,
  SILVER:   0.0019,
  GOLD:     0.0015,
  PLATINUM: 0.0009,
  DIAMOND:  0.0005
};

check('A1 every live tier present, exact rate', () => {
  for (const [tier, rate] of Object.entries(LIVE_TIERS)) {
    assert.strictEqual(costModel.PER_RESULT_USD_BY_TIER[tier], rate,
      `tier ${tier} rate drifted`);
  }
});

check('A2 no invented tiers', () => {
  assert.deepStrictEqual(
    Object.keys(costModel.PER_RESULT_USD_BY_TIER).sort(),
    Object.keys(LIVE_TIERS).sort()
  );
});

check('A3 account tier is a real tier and drives the default', () => {
  assert(LIVE_TIERS[costModel.ACCOUNT_TIER] !== undefined,
    `ACCOUNT_TIER ${costModel.ACCOUNT_TIER} is not a published tier`);
  assert.strictEqual(costModel.DEFAULT_PER_RESULT_USD, LIVE_TIERS[costModel.ACCOUNT_TIER]);
});

check('A4 default is BRONZE 0.0023 — the measured tier', () => {
  // GET /v2/users/me 2026-08-10: plan.id 'STARTER', plan.tier 'BRONZE'.
  assert.strictEqual(costModel.ACCOUNT_TIER, 'BRONZE');
  assert.strictEqual(costModel.DEFAULT_PER_RESULT_USD, 0.0023);
});

// ── B. The measurement this model is calibrated against ────────────
console.log('\n[B] Reproduces the settled-run measurement');

check('B1 10 results at BRONZE = $0.023 exactly, with NO per-run fee', () => {
  // The real run: chargedEventCounts {result:10}, usageTotalUsd 0.023.
  // Model it as one post asking for 10 comments.
  const r = est({ posts: 1, commentLimit: 10, perResultUsd: 0.0023 });
  assert.strictEqual(r.estimateUsd, 0.02,   // $0.023 rounded to the cent
    `got ${r.estimateUsd}`);
  assert.strictEqual(costModel.usd4(10 * 0.0023), 0.023);
});

check('B2 a per-run fee would break B1 — none is added', () => {
  // N posts of 10 comments each must cost exactly N× one post's rows. Any
  // fixed per-run component would make the per-post unit grow with N.
  // Compared on perUnitUsd, not the cent-rounded total, so this measures
  // the model and not the rounding.
  const unit = est({ posts: 1, commentLimit: 10, perResultUsd: 0.0023 }).perUnitUsd;
  assert.strictEqual(unit, 0.023);
  for (const posts of [1, 2, 5, 10, 100]) {
    const r = est({ posts, commentLimit: 10, perResultUsd: 0.0023 });
    assert.strictEqual(r.perUnitUsd, unit, `per-post unit moved at ${posts} posts`);
    assert.strictEqual(r.estimateUsd, costModel.usd(posts * unit),
      `total is not posts × unit at ${posts} posts`);
  }
  // 100 posts × 10 comments = 1000 rows = $2.30 flat.
  assert.strictEqual(est({ posts: 100, commentLimit: 10, perResultUsd: 0.0023 }).estimateUsd, 2.3);
});

// ── C. THE BUG: the estimate must move with BOTH drivers ───────────
console.log('\n[C] Scales with post count AND comment limit');

check('C1 scales linearly with post count', () => {
  const base = est({ posts: 10, commentLimit: 50, perResultUsd: 0.0023 }).estimateUsd;
  const ten  = est({ posts: 100, commentLimit: 50, perResultUsd: 0.0023 }).estimateUsd;
  assert.strictEqual(base, 1.15);
  assert.strictEqual(ten, 11.5);
  assert.strictEqual(costModel.usd(base * 10), ten);
});

check('C2 scales linearly with comment limit — the old formula did NOT', () => {
  const at50  = est({ posts: 100, commentLimit: 50,  perResultUsd: 0.0023 }).estimateUsd;
  const at100 = est({ posts: 100, commentLimit: 100, perResultUsd: 0.0023 }).estimateUsd;
  assert.strictEqual(at50, 11.5);
  assert.strictEqual(at100, 23);
  assert.strictEqual(costModel.usd(at50 * 2), at100);
});

check('C3 ANY comment-limit change moves the number', () => {
  // The regression was that it did not. Sweep every limit and assert the
  // estimate is strictly increasing — one equal pair means limit-blind.
  let prev = -1;
  for (const limit of [1, 2, 5, 10, 15, 25, 50, 51, 75, 100, 200, 500]) {
    const v = est({ posts: 40, commentLimit: limit, perResultUsd: 0.0023 }).estimateUsd;
    assert(v > prev, `limit ${limit} did not increase the estimate (${v} <= ${prev})`);
    prev = v;
  }
});

check('C4 the exact regression, both directions', () => {
  // The old gate showed a flat $2.00 for 100 posts at ANY comment limit
  // (100 × $0.02). Pin how far off that was — 5.75× at limit 50, 11.5× at
  // limit 100 — against the live-verified BRONZE rate.
  const OLD_ESTIMATE_USD = 2;
  const at50  = est({ posts: 100, commentLimit: 50,  perResultUsd: 0.0023 }).estimateUsd;
  const at100 = est({ posts: 100, commentLimit: 100, perResultUsd: 0.0023 }).estimateUsd;
  assert.strictEqual(at50, 11.5);
  assert.strictEqual(at100, 23);
  assert.strictEqual(at50  / OLD_ESTIMATE_USD, 5.75);
  assert.strictEqual(at100 / OLD_ESTIMATE_USD, 11.5);
});

check('C5 zero posts is free, and never negative', () => {
  assert.strictEqual(est({ posts: 0, commentLimit: 50, perResultUsd: 0.0023 }).estimateUsd, 0);
  assert.strictEqual(est({ posts: -5, commentLimit: 50, perResultUsd: 0.0023 }).estimateUsd, 0);
});

// ── D. Arithmetic at every tier ────────────────────────────────────
console.log('\n[D] Arithmetic at each published tier');

check('D1 100 posts × 50 comments at every tier', () => {
  const expected = {
    FREE:     13.5,   // 5000 × 0.0027
    BRONZE:   11.5,   // 5000 × 0.0023
    SILVER:    9.5,   // 5000 × 0.0019
    GOLD:      7.5,   // 5000 × 0.0015
    PLATINUM:  4.5,   // 5000 × 0.0009
    DIAMOND:   2.5    // 5000 × 0.0005
  };
  for (const [tier, rate] of Object.entries(LIVE_TIERS)) {
    const v = est({ posts: 100, commentLimit: 50, perResultUsd: rate }).estimateUsd;
    assert.strictEqual(v, expected[tier], `${tier}: got ${v}, want ${expected[tier]}`);
  }
});

check('D2 tier ordering — cheaper plan tier is never a dearer estimate', () => {
  const order = ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
  let prev = Infinity;
  for (const t of order) {
    const v = est({ posts: 100, commentLimit: 50, perResultUsd: LIVE_TIERS[t] }).estimateUsd;
    assert(v < prev, `${t} (${v}) not cheaper than the previous tier (${prev})`);
    prev = v;
  }
});

check('D3 FREE is the dearest — the correct fallback when tier is unknown', () => {
  const rates = Object.values(LIVE_TIERS);
  assert.strictEqual(Math.max(...rates), LIVE_TIERS.FREE);
});

// ── E. Rounding ────────────────────────────────────────────────────
console.log('\n[E] Rounding');

check('E1 the binary-float trap the 1e-9 nudge exists for', () => {
  // An exact half-cent is stored a hair BELOW itself, so the naive round
  // goes DOWN and the gate quotes less than the real charge.
  // 50 posts × 5 comments × $0.0023 = exactly $0.575.
  const raw = 50 * (5 * 0.0023);
  // Exact in decimal — 50 × 5 × 23 = 5750 tenths of a cent — so the true
  // answer is $0.575 and the honest rounding is $0.58. (Asserting
  // `raw < 0.575` would be vacuous: the literal 0.575 is the same double.)
  assert.strictEqual(50 * 5 * 23, 5750);
  assert.strictEqual(Math.round(raw * 100) / 100, 0.57, 'the naive round is the trap');
  assert.strictEqual(costModel.usd(raw), 0.58, 'usd() must round the half-cent UP');
});

check('E1b usd() never rounds DOWN across the plausible input grid', () => {
  // Generalises E1: for a gate, quoting a cent under is the failure mode.
  // Every (tier × limit × posts) combination must round to >= the true
  // value truncated at the cent.
  let guarded = 0;
  for (const rate of Object.values(LIVE_TIERS)) {
    for (const limit of [1, 5, 10, 15, 25, 50, 75, 100, 150, 200, 500]) {
      for (const posts of [1, 2, 3, 7, 10, 33, 50, 100]) {
        const raw = posts * (limit * rate);
        const out = costModel.usd(raw);
        assert(out >= Math.floor(raw * 100) / 100,
          `usd(${raw}) = ${out} fell below the truncated cent`);
        if (out !== Math.round(raw * 100) / 100) guarded++;
      }
    }
  }
  assert(guarded > 0, 'the nudge guards nothing — re-derive it before deleting');
});

check('E2 sub-cent runs still round up to a visible figure, not $0.00', () => {
  // 1 post × 50 comments = $0.115. Must not display as $0.00 or $0.11.
  assert.strictEqual(est({ posts: 1, commentLimit: 50, perResultUsd: 0.0023 }).estimateUsd, 0.12);
  assert.strictEqual(est({ posts: 3, commentLimit: 50, perResultUsd: 0.0023 }).estimateUsd, 0.35);
});

check('E3 per-post figure keeps 4dp — 2dp would misprice the unit', () => {
  assert.strictEqual(est({ posts: 1, commentLimit: 50, perResultUsd: 0.0023 }).perUnitUsd, 0.115);
  assert.strictEqual(est({ posts: 1, commentLimit: 15, perResultUsd: 0.0023 }).perUnitUsd, 0.0345);
});

check('E4 non-finite inputs cannot produce NaN in an approval gate', () => {
  assert.strictEqual(costModel.usd(NaN), 0);
  assert.strictEqual(costModel.usd(Infinity), 0);
  assert.strictEqual(costModel.usd4(NaN), 0);
  const r = est({ posts: 'abc', commentLimit: 'xyz', perResultUsd: 'nope' });
  assert(Number.isFinite(r.estimateUsd), 'estimateUsd went non-finite');
  assert.strictEqual(r.perResultUsd, costModel.DEFAULT_PER_RESULT_USD);
  assert.strictEqual(r.commentLimit, costModel.DEFAULT_COMMENT_LIMIT);
});

// ── F. Env resolution ──────────────────────────────────────────────
console.log('\n[F] Env resolution');

check('F1 APIFY_IG_COMMENTS_LIMIT default is 50 and is honoured', () => {
  withEnv({ APIFY_IG_COMMENTS_LIMIT: undefined }, () => {
    assert.strictEqual(costModel.resolveCommentLimit(), 50);
  });
  withEnv({ APIFY_IG_COMMENTS_LIMIT: '100' }, () => {
    assert.strictEqual(costModel.resolveCommentLimit(), 100);
  });
  // Garbage falls back to the default rather than to 0 (a 0 limit would
  // silently price the whole workflow at $0.00).
  for (const bad of ['', '0', '-7', 'abc']) {
    withEnv({ APIFY_IG_COMMENTS_LIMIT: bad }, () => {
      assert.strictEqual(costModel.resolveCommentLimit(), 50, `bad value "${bad}"`);
    });
  }
});

check('F2 APIFY_PER_RESULT_USD overrides the tier default', () => {
  withEnv({ APIFY_PER_RESULT_USD: undefined }, () => {
    assert.strictEqual(costModel.resolvePerResultUsd(), 0.0023);
  });
  withEnv({ APIFY_PER_RESULT_USD: '0.0027' }, () => {
    assert.strictEqual(costModel.resolvePerResultUsd(), 0.0027);
  });
  for (const bad of ['', '0', '-1', 'free']) {
    withEnv({ APIFY_PER_RESULT_USD: bad }, () => {
      assert.strictEqual(costModel.resolvePerResultUsd(), 0.0023, `bad value "${bad}"`);
    });
  }
});

check('F3 legacy APIFY_COMMENTS_PER_UNIT_USD honoured only when really set', () => {
  withEnv({ APIFY_COMMENTS_PER_UNIT_USD: undefined }, () => {
    assert.strictEqual(costModel.resolvePerPostOverrideUsd(), null);
  });
  withEnv({ APIFY_COMMENTS_PER_UNIT_USD: '' }, () => {
    assert.strictEqual(costModel.resolvePerPostOverrideUsd(), null,
      'empty string must NOT count as an override (.env.example ships it blank)');
  });
  withEnv({ APIFY_COMMENTS_PER_UNIT_USD: '0.02' }, () => {
    assert.strictEqual(costModel.resolvePerPostOverrideUsd(), 0.02);
  });
});

// ── G. Back-compat override ────────────────────────────────────────
console.log('\n[G] Legacy per-post override');

check('G1 override reproduces the old number exactly', () => {
  const r = est({ posts: 100, commentLimit: 50, perResultUsd: 0.0023, perPostOverrideUsd: 0.02 });
  assert.strictEqual(r.estimateUsd, 2);
  assert.strictEqual(r.perUnitUsd, 0.02);
});

check('G2 override is limit-blind, and SAYS SO via estimateBasis', () => {
  const a = est({ posts: 100, commentLimit: 50,  perResultUsd: 0.0023, perPostOverrideUsd: 0.02 });
  const b = est({ posts: 100, commentLimit: 500, perResultUsd: 0.0023, perPostOverrideUsd: 0.02 });
  assert.strictEqual(a.estimateUsd, b.estimateUsd, 'override should pin the number');
  assert.strictEqual(a.estimateBasis, 'per-post-override');
  // Without it, the basis must name the real pricing model.
  assert.strictEqual(est({ posts: 100, commentLimit: 50 }).estimateBasis, 'per-result');
});

// ── H. Executor wiring + kill switch ───────────────────────────────
console.log('\n[H] Executor wiring and APIFY_COST_ESTIMATE_V2');

const executor = require('../services/capabilityExecutors/mediaRefreshCommentsFromApify');

check('H1 executor exposes the cost block and the switch', () => {
  assert.strictEqual(typeof executor.buildCostBlock, 'function');
  assert.strictEqual(typeof executor.costEstimateV2Enabled, 'function');
  assert.strictEqual(executor.MAX_STEPS_PER_RUN, costModel.MAX_POSTS_PER_RUN);
  assert.strictEqual(executor.MAX_STEPS_PER_RUN, 100);
});

check('H2 flag ON: limit-aware, and surfaces both drivers', () => {
  withEnv({
    APIFY_COST_ESTIMATE_V2: undefined,          // default must be ON
    APIFY_IG_COMMENTS_LIMIT: '50',
    APIFY_PER_RESULT_USD: '0.0023',
    APIFY_COMMENTS_PER_UNIT_USD: undefined
  }, () => {
    assert.strictEqual(executor.costEstimateV2Enabled(), true, 'default must be ON');
    const b = executor.buildCostBlock(100);
    assert.strictEqual(b.estimateUsd, 11.5);
    assert.strictEqual(b.perUnitUsd, 0.115);
    assert.strictEqual(b.commentLimit, 50);
    assert.strictEqual(b.perResultUsd, 0.0023);
    assert.strictEqual(b.estimateBasis, 'per-result');
  });
});

check('H3 flag ON: a limit change is VISIBLE in the preview', () => {
  const at = (limit) => withEnv({
    APIFY_COST_ESTIMATE_V2: undefined,
    APIFY_IG_COMMENTS_LIMIT: String(limit),
    APIFY_PER_RESULT_USD: '0.0023',
    APIFY_COMMENTS_PER_UNIT_USD: undefined
  }, () => executor.buildCostBlock(100));
  const a = at(50);
  const b = at(100);
  assert.notStrictEqual(a.estimateUsd, b.estimateUsd,
    'preview is still limit-blind — this is the original bug');
  assert.strictEqual(a.estimateUsd, 11.5);
  assert.strictEqual(b.estimateUsd, 23);
  assert.strictEqual(b.commentLimit, 100);
});

check('H4 flag OFF restores the OLD cost fields exactly — no new keys', () => {
  withEnv({ APIFY_COST_ESTIMATE_V2: 'false', APIFY_IG_COMMENTS_LIMIT: '100' }, () => {
    assert.strictEqual(executor.costEstimateV2Enabled(), false);
    const b = executor.buildCostBlock(100);
    assert.deepStrictEqual(Object.keys(b).sort(), ['estimateUsd', 'perUnitUsd'],
      `flag-off leaked keys: ${Object.keys(b).join(',')}`);
    // Legacy math: capped × flat per-post, limit ignored (as before).
    assert.strictEqual(b.estimateUsd,
      Math.round(100 * executor.PER_UNIT_ESTIMATE_USD * 100) / 100);
  });
});

check('H5 the switch is a true switch, not a truthiness accident', () => {
  for (const [val, want] of [
    [undefined, true], ['true', true], ['TRUE', true], ['1', true], ['', true],
    ['false', false], ['FALSE', false], [' false ', false]
  ]) {
    withEnv({ APIFY_COST_ESTIMATE_V2: val }, () => {
      assert.strictEqual(executor.costEstimateV2Enabled(), want, `value ${JSON.stringify(val)}`);
    });
  }
});

// ── I. Spend guard sees the same number ────────────────────────────
console.log('\n[I] Capability registry upper bound');

check('I1 registry estimator resolves to the real 100-post ceiling', () => {
  const registry = require('../services/capabilityRegistry');
  const cap = registry.capabilityById('media.refreshCommentsFromApify');
  assert(cap, 'capability registered');
  assert.strictEqual(typeof cap.estimateUsd, 'function',
    'a frozen number goes stale the moment the comment limit moves');
  withEnv({
    APIFY_IG_COMMENTS_LIMIT: '50',
    APIFY_PER_RESULT_USD: '0.0023',
    APIFY_COMMENTS_PER_UNIT_USD: undefined
  }, () => {
    assert.strictEqual(cap.estimateUsd({ brandId: 'x' }), 11.5,
      'spend guard is still gating on the stale $2.00');
  });
});

check('I2 registry bound tracks the comment limit', () => {
  const registry = require('../services/capabilityRegistry');
  const cap = registry.capabilityById('media.refreshCommentsFromApify');
  withEnv({
    APIFY_IG_COMMENTS_LIMIT: '100',
    APIFY_PER_RESULT_USD: '0.0023',
    APIFY_COMMENTS_PER_UNIT_USD: undefined
  }, () => {
    assert.strictEqual(cap.estimateUsd({}), 23);
  });
});

check('I3 registry describe no longer claims a per-run charge', () => {
  const registry = require('../services/capabilityRegistry');
  const cap = registry.capabilityById('media.refreshCommentsFromApify');
  assert(!/per-run cost|bills per run/i.test(cap.describe),
    'describe still tells the LLM the actor charges per run');
  assert(/PAY_PER_EVENT/.test(cap.describe), 'describe should name the real pricing model');
});

// ── J. Env documentation ───────────────────────────────────────────
console.log('\n[J] Env documentation');

const DEFAULTS_ENV = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(
  path.join(__dirname, '..', '.env.example'), 'utf8');

check('J1 APIFY_IG_COMMENTS_LIMIT documented in BOTH files', () => {
  // It was absent from both — the single biggest cost lever on this
  // workflow, undiscoverable outside the source.
  assert(/^APIFY_IG_COMMENTS_LIMIT=/m.test(DEFAULTS_ENV), 'missing from config/defaults.env');
  assert(/^APIFY_IG_COMMENTS_LIMIT=/m.test(ENV_EXAMPLE),  'missing from .env.example');
});

check('J2 defaults.env keeps the limit at 50 (changing it is a product call)', () => {
  const m = DEFAULTS_ENV.match(/^APIFY_IG_COMMENTS_LIMIT=(\d+)/m);
  assert(m, 'APIFY_IG_COMMENTS_LIMIT not set in defaults.env');
  assert.strictEqual(m[1], '50');
});

check('J3 APIFY_PER_RESULT_USD present and matches the account tier', () => {
  const m = DEFAULTS_ENV.match(/^APIFY_PER_RESULT_USD=([\d.]+)/m);
  assert(m, 'APIFY_PER_RESULT_USD not set in defaults.env');
  assert.strictEqual(Number(m[1]), costModel.DEFAULT_PER_RESULT_USD,
    'defaults.env and the code disagree on $/result');
  assert(/^APIFY_PER_RESULT_USD=/m.test(ENV_EXAMPLE), 'missing from .env.example');
});

check('J4 the "raising the limit buys recency, not better quotes" warning survives', () => {
  // The actor input schema has no sort/order parameter; comments come back
  // newest-first and free usage caps at 15. Without this note the next
  // person raises the cap expecting higher-engagement quotes and just pays
  // more. Keep it findable from the env file, not only from a commit.
  assert(/no sort|NO sort/i.test(DEFAULTS_ENV), 'sort-parameter warning gone');
  assert(/likeCount/.test(DEFAULTS_ENV), 'local-sort remedy not mentioned');
  assert(/no sort\/order parameter/i.test(ENV_EXAMPLE), '.env.example lost the no-sort warning');
  assert(/RECENT/i.test(ENV_EXAMPLE), '.env.example lost the recency warning');
});

check('J5 both kill switches documented', () => {
  for (const key of ['APIFY_COST_ESTIMATE_V2', 'APIFY_COST_READBACK']) {
    assert(new RegExp(`^${key}=`, 'm').test(DEFAULTS_ENV), `${key} missing from defaults.env`);
  }
});

// ── K. Cost readback plumbing ──────────────────────────────────────
console.log('\n[K] Measured-cost readback');

const PULL_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'apifyPullService.js'), 'utf8');
const INGEST_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'apifyIngestService.js'), 'utf8');
const EXEC_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'capabilityExecutors',
            'mediaRefreshCommentsFromApify.js'), 'utf8');

check('K1 the measured transport reads the RUN back, not just the dataset', () => {
  // run-sync-get-dataset-items returns dataset items only — no run id in
  // the body and none in its documented headers — so a cost readback is
  // impossible without starting the run asynchronously.
  assert(/\/acts\/\$\{encodeURIComponent\(actorId\)\}\/runs/.test(PULL_SRC),
    'no async run-start — cost cannot be measured');
  assert(/actor-runs\//.test(PULL_SRC), 'never fetches the run object');
  assert(/usageTotalUsd/.test(PULL_SRC), 'never reads usageTotalUsd');
  assert(/chargedEventCounts/.test(PULL_SRC), 'never reads chargedEventCounts');
});

check('K2 the billable POST sets maxRedirects: 0 (CLAUDE.md §2)', () => {
  // axios defaults to 21 and re-sends the body on 307/308 — a silent
  // double charge inside one call.
  const startBlock = PULL_SRC.slice(PULL_SRC.indexOf('const startUrl'));
  assert(/maxRedirects:\s*0/.test(startBlock.slice(0, 600)),
    'run-start POST does not pin maxRedirects: 0');
});

check('K3 cost survives a FAILED run', () => {
  // A failed Apify run is still a charged run. recordRunCost must happen
  // before the status check, or the operator loses the number that matters.
  const iRecord = PULL_SRC.indexOf('recordRunCost(costMeta, run)');
  const iThrow  = PULL_SRC.indexOf("run.status !== 'SUCCEEDED'");
  assert(iRecord > 0 && iThrow > 0, 'expected both the record and the status check');
  assert(iRecord < iThrow, 'cost is recorded only on the success path');
});

check('K4 transitional statuses are not treated as terminal', () => {
  // ABORTING / TIMING-OUT settle later; reading the charge there is early.
  const m = PULL_SRC.match(/TERMINAL_RUN_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert(m, 'TERMINAL_RUN_STATUSES not found');
  assert(!/ABORTING|TIMING-OUT/.test(m[1]), `transitional status treated as terminal: ${m[1]}`);
  for (const s of ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']) {
    assert(m[1].includes(s), `missing terminal status ${s}`);
  }
});

check('K5 the ingest fan-out sums MEASURED cost and reports coverage', () => {
  assert(/usageTotalUsd/.test(INGEST_SRC), 'ingest never aggregates run cost');
  assert(/costMeasuredSteps/.test(INGEST_SRC),
    'no coverage count — a partial total would read as a complete one');
  assert(/Number\.isFinite\(r\.usageTotalUsd\)/.test(INGEST_SRC),
    'unmeasured steps must not be summed as 0');
});

check('K6 the executor persists cost to OperationRun.meta, no new collection', () => {
  assert(/progressService/.test(EXEC_SRC), 'no OperationRun row is opened');
  assert(/run\.succeed\(\{/.test(EXEC_SRC),
    'succeed(summary-object) is what writes OperationRun.meta');
  assert(/usageTotalUsd/.test(EXEC_SRC), 'measured cost never reaches the run row');
});

check('K7 an unmeasured run is reported as unavailable, never as $0', () => {
  assert(/costSource:\s*Number\.isFinite\(result\?\.usageTotalUsd\)\s*\?\s*'measured'\s*:\s*'unavailable'/
    .test(EXEC_SRC), "costSource must distinguish measured from unavailable");
  assert(!/usageTotalUsd:\s*result\?\.usageTotalUsd\s*\|\|\s*0/.test(EXEC_SRC),
    '`|| 0` would turn "unknown" into "free"');
});

check('K8 the readback kill switch exists and defaults ON', () => {
  assert(/APIFY_COST_READBACK/.test(PULL_SRC), 'no kill switch on the transport change');
  assert(/runActorLegacySync/.test(PULL_SRC), 'legacy transport not retained for the revert');
});

// BEHAVIOURAL, not source-shape. The first cut of this check only asserted
// that a `numeric` helper existed and that no bare `Number(...)` appeared —
// which a reimplementation returning 0 for null would sail straight past.
// Adversarial review caught that it was vacuous on the very bug it names,
// so it now CALLS the code.
const pull = require('../services/apifyPullService');

check('K9 usageTotalUsd: null must NOT be recorded as a measured $0.00', () => {
  // Number(null) === 0 and Number.isFinite(0) === true, so a plain Number()
  // coercion turns "Apify has not settled this run" into "this run was
  // free" — the worst failure available to a cost readback.
  assert.strictEqual(pull.numeric(null), null, 'null must not coerce to 0');
  assert.strictEqual(pull.numeric(undefined), null);
  assert.strictEqual(pull.numeric(''), null);
  assert.strictEqual(pull.numeric('abc'), null);
  // …while real figures, including a genuine zero, still pass through.
  assert.strictEqual(pull.numeric(0), 0);
  assert.strictEqual(pull.numeric(0.023), 0.023);
  assert.strictEqual(pull.numeric('0.023'), 0.023);
});

check('K9b an unsettled run records as unmeasured, not as free', () => {
  const meta = {};
  pull.recordRunCost(meta, {
    id: 'run_unsettled', status: 'SUCCEEDED',
    defaultDatasetId: 'ds1', usageTotalUsd: null,
    chargedEventCounts: { result: 42 }
  });
  assert.strictEqual(meta.usageTotalUsd, null, 'unsettled cost recorded as a number');
  assert.strictEqual(meta.measured, false, 'unsettled run flagged as measured');
  assert.strictEqual(meta.chargedResults, 42, 'event count lost');
  assert.strictEqual(meta.runId, 'run_unsettled');
});

check('K9c a settled run records the real figure', () => {
  const meta = {};
  // The shape of the real run measured on this account 2026-08-10.
  pull.recordRunCost(meta, {
    id: 'run_settled', status: 'SUCCEEDED',
    defaultDatasetId: 'ds2', usageTotalUsd: 0.023,
    chargedEventCounts: { result: 10 }
  });
  assert.strictEqual(meta.usageTotalUsd, 0.023);
  assert.strictEqual(meta.chargedResults, 10);
  assert.strictEqual(meta.measured, true);
  // 10 rows at BRONZE is exactly what was billed — the model and the
  // measurement must agree.
  assert.strictEqual(costModel.usd4(10 * costModel.DEFAULT_PER_RESULT_USD), 0.023);
});

check('K9d a FAILED run still reports its charge', () => {
  const meta = {};
  pull.recordRunCost(meta, {
    id: 'run_failed', status: 'FAILED',
    defaultDatasetId: 'ds3', usageTotalUsd: 0.0046,
    chargedEventCounts: { result: 2 }
  });
  assert.strictEqual(meta.usageTotalUsd, 0.0046, 'a failed run is still a charged run');
  assert.strictEqual(meta.status, 'FAILED');
});

check('K9e recordRunCost never throws into the data path', () => {
  // Cost telemetry must not be able to break a pull that already succeeded.
  assert.doesNotThrow(() => pull.recordRunCost(null, { id: 'x' }));
  assert.doesNotThrow(() => pull.recordRunCost({}, null));
  assert.doesNotThrow(() => pull.recordRunCost({}, {}));
  const meta = {};
  pull.recordRunCost(meta, {});
  assert.strictEqual(meta.measured, false);
});

check('K9f transitional statuses are not terminal (live set, not source text)', () => {
  for (const s of ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']) {
    assert(pull.TERMINAL_RUN_STATUSES.has(s), `${s} should be terminal`);
  }
  for (const s of ['RUNNING', 'READY', 'ABORTING', 'TIMING-OUT']) {
    assert(!pull.TERMINAL_RUN_STATUSES.has(s),
      `${s} treated as terminal — cost would be read before Apify settles it`);
  }
});

// ── L. The approved plan must be the executed plan ─────────────────
console.log('\n[L] Fan-out cap');

check('L1 the comment fan-out honours a limit', () => {
  // preview quotes totalSteps = min(targets, 100) and capped:true, but the
  // query had no .limit() — so a 500-post brand was approved at 100 posts
  // of spend and billed for 500 (~5x). Caught in adversarial review.
  const m = INGEST_SRC.match(
    /async function syncBrandInstagramCommentsApify\(brandId,\s*\{([^}]*)\}/);
  assert(m, 'syncBrandInstagramCommentsApify signature not found');
  assert(/limit/.test(m[1]), 'no limit option — fan-out is unbounded');
  assert(/q\.limit\(cap\)/.test(INGEST_SRC), 'limit option is never applied to the query');
});

check('L2 the capped query is deterministically ordered', () => {
  // .limit() without .sort() takes an arbitrary slice, so which posts get
  // paid for would differ between two identical runs.
  // Scope to the comment fan-out — `source: 'apify-ig'` appears in other
  // queries in this file too.
  const i = INGEST_SRC.indexOf('async function syncBrandInstagramCommentsApify');
  assert(i > 0, 'syncBrandInstagramCommentsApify not found');
  const block = INGEST_SRC.slice(i, INGEST_SRC.indexOf('const perStep', i));
  assert(/\.sort\(/.test(block), 'capped fan-out query has no sort');
  assert(/q\.limit\(cap\)/.test(block), 'cap applied outside the fan-out query');
});

check('L3 the executor passes the SAME cap it previewed', () => {
  assert(/limit:\s*MAX_STEPS_PER_RUN/.test(EXEC_SRC),
    'execute does not pass the preview cap — plan and execution diverge');
});

check('L4 a charged run never returns a silent empty array', () => {
  // A SUCCEEDED run whose results are unreachable is data loss on a run we
  // already paid for, and `[]` makes it indistinguishable from a post that
  // genuinely has no comments. Both shapes must fail loudly.
  assert(!/if \(!datasetId\) return \[\];/.test(PULL_SRC),
    'missing dataset id is swallowed as an empty (successful) result');
  assert(/no defaultDatasetId/.test(PULL_SRC),
    'no explicit failure for a charged run whose results are unreachable');
  // Behavioural, not source-shape: a non-array body must throw, not [].
  for (const bad of [null, undefined, {}, '', 'oops', 0, { error: 'x' }]) {
    assert.throws(() => pull.coerceDatasetItems(bad, 'ds', 'run'),
      /not an array/, `non-array body ${JSON.stringify(bad)} returned silently`);
  }
  // …while real arrays, including a legitimately empty one, pass through.
  assert.deepStrictEqual(pull.coerceDatasetItems([], 'ds', 'run'), []);
  assert.deepStrictEqual(pull.coerceDatasetItems([{ id: 1 }], 'ds', 'run'), [{ id: 1 }]);
});

check('L4b the fan-out cap cannot be disabled by a falsy limit', () => {
  // `limit: 0` meaning "no cap" is the wrong polarity on a spend path.
  const { resolveCommentFanoutCap } = require('../services/apifyIngestService');
  // Absent => uncapped, which is the documented default for other callers.
  assert.strictEqual(resolveCommentFanoutCap(null), null);
  assert.strictEqual(resolveCommentFanoutCap(undefined), null);
  // Supplied but nonsensical => refuse, never "uncapped".
  for (const bad of [0, -1, NaN, Infinity, '', 'abc', 0.5]) {
    assert.throws(() => resolveCommentFanoutCap(bad),
      /positive number/, `limit ${JSON.stringify(bad)} silently meant uncapped`);
  }
  assert.strictEqual(resolveCommentFanoutCap(100), 100);
  assert.strictEqual(resolveCommentFanoutCap('100'), 100);
});

check('L5 a real cost never displays as $0.00', () => {
  // spendGuard short-circuits on est === 0 ("declared free") without any
  // cap check, so a sub-cent estimate rounding to zero bypasses the gate.
  assert.strictEqual(costModel.usd(0.0001), 0.01);
  assert.strictEqual(costModel.usd(0.004), 0.01);
  assert.strictEqual(costModel.usd(0), 0, 'genuinely-zero must stay zero');
  assert.strictEqual(est({ posts: 1, commentLimit: 1, perResultUsd: 0.0005 }).estimateUsd, 0.01);
});

// ── Report ─────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.error(`❌ verifyApifyCommentCost: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyApifyCommentCost: ${pass} checks passed`);
