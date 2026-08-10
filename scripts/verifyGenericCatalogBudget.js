#!/usr/bin/env node
'use strict';
//
// verifyGenericCatalogBudget — offline harness for the catalog scraper's
// wall-clock budget + fail-on-zero terminal status.
//
// Covers:
//   A. createBudget arithmetic with an injected fake clock
//   B. totalMs unset / 0 / NaN / negative → unbounded (safety property)
//   C. computeSyncOutcome truth table
//   D. Static source assertions: PDP loop + both sitemap walk passes
//      each contain a budget/expired check; progressService.fail arity ≥ 2
//   E. Flag-off path string present in apifyIngestService (byte-identity restore)
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyGenericCatalogBudget.js
//
// Revert-prove:
//   (i)  drop the budget check in the PDP loop → static assert fails
//   (ii) drop the GENERIC_CATALOG_FAIL_ON_ZERO branch → flag-off assert fails

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const { createBudget } = require('../services/genericCatalogDiscovery/budget');
const { computeSyncOutcome } = require('../services/apifySyncOutcome');

let pass = 0;
const failures = [];

function check(label, cond) {
  if (cond) {
    pass += 1;
    console.log(`✓ ${label}`);
    return;
  }
  failures.push(label);
  console.log(`❌ ${label}`);
}

function checkEq(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) {
    pass += 1;
    console.log(`✓ ${label}`);
    return;
  }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  console.log(`❌ ${label}`);
}

// ── A. createBudget arithmetic (injected fake clock) ──────────────────

{
  let t = 1_000_000;
  const now = () => t;
  const b = createBudget({ totalMs: 10_000, now });

  check('A1 not expired before deadline', b.expired() === false);
  checkEq('A2 remainingMs at start is totalMs', b.remainingMs(), 10_000);
  checkEq('A3 spentMs at start is 0', b.spentMs(), 0);
  checkEq('A4 startedAt is now()', b.startedAt, 1_000_000);
  checkEq('A5 deadlineAt is startedAt + totalMs', b.deadlineAt, 1_010_000);

  t = 1_005_000;
  check('A6 still not expired at mid-point', b.expired() === false);
  checkEq('A7 remainingMs mid-point', b.remainingMs(), 5_000);
  checkEq('A8 spentMs mid-point', b.spentMs(), 5_000);

  t = 1_010_000;
  check('A9 expired at deadline (inclusive)', b.expired() === true);
  checkEq('A10 remainingMs never negative at deadline', b.remainingMs(), 0);

  t = 1_050_000;
  check('A11 expired after deadline', b.expired() === true);
  checkEq('A12 remainingMs never negative after deadline', b.remainingMs(), 0);
  checkEq('A13 spentMs after deadline', b.spentMs(), 50_000);
}

{
  let t = 0;
  const now = () => t;
  const b = createBudget({ totalMs: 1000, now });
  // Enter rung with allotment larger than parent remaining after some spend.
  t = 600;
  const rung = b.enterRung('sitemap', 800); // parent remaining = 400 → clamp to 400
  checkEq('A14 enterRung clamps allotment to parent remaining', rung.remainingMs(), 400);
  check('A15 rung not expired immediately after clamp', rung.expired() === false);
  checkEq('A16 rung name preserved', rung.name, 'sitemap');

  t = 1000; // parent deadline
  check('A17 rung expires when parent expires (cannot outlive parent)', rung.expired() === true);
  checkEq('A18 rung remainingMs 0 when parent spent', rung.remainingMs(), 0);
}

{
  let t = 0;
  const now = () => t;
  const b = createBudget({ totalMs: 5000, now });
  const rung = b.enterRung('pdp', 1000);
  t = 1000;
  check('A19 finite rung expires on its own allotment before parent', rung.expired() === true);
  check('A20 parent still alive when rung allotment spent', b.expired() === false);
  checkEq('A21 rung elapsedMs', rung.elapsedMs(), 1000);
}

{
  let t = 0;
  const now = () => t;
  const b = createBudget({ totalMs: 5000, now });
  // allotment 0 → immediately expired (unlike root totalMs<=0 unbounded)
  const rung = b.enterRung('empty', 0);
  check('A22 rung allotment 0 is immediately expired', rung.expired() === true);
  checkEq('A23 rung allotment 0 remainingMs is 0', rung.remainingMs(), 0);
}

// ── B. Unbounded safety (unset / 0 / NaN / negative) ─────────────────

function assertUnbounded(label, totalMs) {
  let t = 0;
  const now = () => t;
  const b = createBudget({ totalMs, now });
  check(`${label}: not expired at t=0`, b.expired() === false);
  t = 1e15;
  check(`${label}: not expired far in the future`, b.expired() === false);
  check(`${label}: remainingMs is Infinity`, b.remainingMs() === Infinity);
}

assertUnbounded('B1 totalMs undefined', undefined);
assertUnbounded('B2 totalMs null (non-finite via Number)', null); // Number.isFinite(null) is false? Wait - Number.isFinite(null) is false because null coerces... actually Number.isFinite(null) === false because Number.isFinite does not coerce. Number.isFinite(null) is false. Good.
assertUnbounded('B3 totalMs NaN', NaN);
assertUnbounded('B4 totalMs 0', 0);
assertUnbounded('B5 totalMs negative', -1);
assertUnbounded('B6 totalMs omitted', /* omitted via createBudget() */ (() => {
  // exercise createBudget() with no args
  return undefined;
})());

// Explicit createBudget() with no args
{
  let t = 0;
  const b = createBudget({ now: () => t });
  t = 9e15;
  check('B7 createBudget() with no totalMs is unbounded', b.expired() === false);
}

// ── C. computeSyncOutcome truth table ────────────────────────────────

{
  const r = computeSyncOutcome({
    shopifyAttempted: true, shopifyZero: true,
    igAttempted: false, igZero: true,
    aborted: false
  });
  checkEq('C1 catalog-only zero → failed', r.status, 'failed');
  check('C1b reason names catalog', /catalog/i.test(r.reason || ''));
}

{
  const r = computeSyncOutcome({
    shopifyAttempted: true, shopifyZero: true,
    igAttempted: true, igZero: false,
    aborted: false
  });
  checkEq('C2 IG worked + catalog zero → succeeded', r.status, 'succeeded');
}

{
  const r = computeSyncOutcome({
    shopifyAttempted: true, shopifyZero: true,
    igAttempted: true, igZero: true,
    aborted: false
  });
  checkEq('C3 both zero → failed', r.status, 'failed');
  check('C3b reason names both', /catalog/i.test(r.reason || '') && /instagram/i.test(r.reason || ''));
}

{
  const r = computeSyncOutcome({
    shopifyAttempted: true, shopifyZero: false,
    igAttempted: true, igZero: false,
    aborted: true
  });
  checkEq('C4 aborted → cancelled (even if sources had data)', r.status, 'cancelled');
  checkEq('C4b cancelled reason is null', r.reason, null);
}

{
  const r = computeSyncOutcome({
    shopifyAttempted: false, shopifyZero: true,
    igAttempted: false, igZero: true,
    aborted: false
  });
  checkEq('C5 nothing attempted → succeeded', r.status, 'succeeded');
  check('C5b reason names no sources', /no sources/i.test(r.reason || ''));
}

{
  const r = computeSyncOutcome({
    shopifyAttempted: false, shopifyZero: true,
    igAttempted: true, igZero: true,
    aborted: false
  });
  checkEq('C6 IG-only zero → failed', r.status, 'failed');
  check('C6b reason names Instagram', /instagram/i.test(r.reason || ''));
}

{
  const r = computeSyncOutcome({
    shopifyAttempted: true, shopifyZero: false,
    igAttempted: false, igZero: true,
    aborted: false
  });
  checkEq('C7 catalog-only with data → succeeded', r.status, 'succeeded');
}

// Explicit zero predicates matching production (null / 0 / missing)
function shopifyZeroOf(out) {
  return !out.shopify
    || out.shopify.ok === false
    || (out.shopify.added ?? 0) === 0;
}
function igZeroOf(out) {
  return !out.ig
    || out.ig.ok === false
    || (out.ig.ingested ?? 0) === 0;
}

check('C8 added:0 is zero', shopifyZeroOf({ shopify: { added: 0 } }) === true);
check('C9 added:null is zero', shopifyZeroOf({ shopify: { added: null } }) === true);
check('C10 added missing is zero', shopifyZeroOf({ shopify: {} }) === true);
check('C11 ok:false is zero even with added>0', shopifyZeroOf({ shopify: { ok: false, added: 5 } }) === true);
check('C12 added:3 is not zero', shopifyZeroOf({ shopify: { added: 3 } }) === false);
check('C13 missing shopify is zero', shopifyZeroOf({}) === true);
check('C14 ingested:0 is zero', igZeroOf({ ig: { ingested: 0 } }) === true);
check('C15 ingested:null is zero', igZeroOf({ ig: { ingested: null } }) === true);
check('C16 ingested:2 is not zero', igZeroOf({ ig: { ingested: 2 } }) === false);

// End-to-end outcome from the production predicates
{
  const out = { shopify: { added: 0 }, ig: null };
  const r = computeSyncOutcome({
    shopifyAttempted: out.shopify != null,
    shopifyZero: shopifyZeroOf(out),
    igAttempted: out.ig != null,
    igZero: igZeroOf(out),
    aborted: false
  });
  checkEq('C17 catalog-only added:0 via predicates → failed', r.status, 'failed');
}

// ── D. Static source assertions ──────────────────────────────────────

const resolverSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'genericCatalogResolver.js'),
  'utf8'
);
const progressSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'progressService.js'),
  'utf8'
);
const apifySrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'apifyIngestService.js'),
  'utf8'
);
const ingestSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'genericCatalogIngestService.js'),
  'utf8'
);

// Isolate walkSitemaps body (pass 1 while + pass 2 for)
const walkMatch = resolverSrc.match(
  /async function walkSitemaps[\s\S]*?return \{ pageEntries[\s\S]*?\n\}/
);
check('D1 walkSitemaps function present', !!walkMatch);
if (walkMatch) {
  const walkBody = walkMatch[0];
  // Pass 1 is the `while (queue.length)` loop; pass 2 is `for (const item of subQueue)`.
  const pass1 = walkBody.match(/while\s*\(\s*queue\.length\s*\)\s*\{[\s\S]*?\n  \}/);
  const pass2 = walkBody.match(/for\s*\(\s*const item of subQueue\s*\)\s*\{[\s\S]*?\n  \}/);
  check('D2 walk pass 1 (while queue) present', !!pass1);
  check('D3 walk pass 2 (for subQueue) present', !!pass2);
  check(
    'D4 walk pass 1 contains budget/expired check',
    !!(pass1 && /budget\s*&&\s*budget\.expired\s*\(|budgetExpired\s*=\s*true/.test(pass1[0]))
  );
  check(
    'D5 walk pass 2 contains budget/expired check',
    !!(pass2 && /budget\s*&&\s*budget\.expired\s*\(|budgetExpired\s*=\s*true/.test(pass2[0]))
  );
}

// PDP scan loop — look for the for-loop over pageEntries near pdpConcurrency
const pdpLoop = resolverSrc.match(
  /for\s*\(\s*let i\s*=\s*0;\s*i\s*<\s*pageEntries\.length[\s\S]*?\n  \}/
);
check('D6 PDP scan loop present', !!pdpLoop);
check(
  'D7 PDP scan loop contains budget/expired check',
  !!(pdpLoop && /pdpBudget\.expired\s*\(|budget\.expired\s*\(|budgetExpired\s*=\s*true/.test(pdpLoop[0]))
);

// progressService.fail arity ≥ 2 (second param `meta`)
{
  const failMatch = progressSrc.match(/fail\s*\(\s*err\s*,\s*meta\s*\)/);
  check('D8 progressService.fail has arity ≥ 2 (fail(err, meta))', !!failMatch);
  // Also assert meta lands on the update object
  check(
    'D9 progressService.fail persists meta onto OperationRun update',
    /update\.meta\s*=\s*meta/.test(progressSrc)
  );
}

// Upsert loop budget in ingest service
check(
  'D10 upsert loop consults upsertBudget.expired',
  /upsertBudget\.expired\s*\(/.test(ingestSrc)
);

// budgetExpired is its own flag (not overloaded onto aborted)
check(
  'D11 resolver sets budgetExpired = true as its own flag',
  /budgetExpired\s*=\s*true/.test(resolverSrc)
);
check(
  'D12 partialReason budget-exceeded surfaced',
  /partialReason:\s*'budget-exceeded'/.test(resolverSrc)
);

// ── E. Flag-off restore path ─────────────────────────────────────────

check(
  'E1 GENERIC_CATALOG_FAIL_ON_ZERO branch present in apifyIngestService',
  /GENERIC_CATALOG_FAIL_ON_ZERO\s*===\s*'false'/.test(apifySrc)
);
check(
  'E2 computeSyncOutcome required on the fail-on-zero path',
  /computeSyncOutcome/.test(apifySrc)
);
check(
  'E3 run.fail used when outcome is failed',
  /outcome\.status\s*===\s*'failed'/.test(apifySrc) && /run\.fail\s*\(/.test(apifySrc)
);

// defaults.env carries the new knobs
const defaultsEnv = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'defaults.env'),
  'utf8'
);
check('E4 defaults.env has GENERIC_CATALOG_TOTAL_BUDGET_MS', /GENERIC_CATALOG_TOTAL_BUDGET_MS=/.test(defaultsEnv));
check('E5 defaults.env has GENERIC_CATALOG_SITEMAP_BUDGET_MS', /GENERIC_CATALOG_SITEMAP_BUDGET_MS=/.test(defaultsEnv));
check('E6 defaults.env has GENERIC_CATALOG_UPSERT_BUDGET_MS', /GENERIC_CATALOG_UPSERT_BUDGET_MS=/.test(defaultsEnv));
check('E7 defaults.env has GENERIC_CATALOG_FAIL_ON_ZERO', /GENERIC_CATALOG_FAIL_ON_ZERO=/.test(defaultsEnv));

// createBudget never calls Date.now() directly (only via default param)
const budgetSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'genericCatalogDiscovery', 'budget.js'),
  'utf8'
);
// Allow `now = Date.now` default param only — no Date.now() call sites.
const dateNowCalls = budgetSrc.match(/Date\.now\s*\(/g) || [];
check(
  'E8 budget.js never invokes Date.now() (injectable clock only)',
  dateNowCalls.length === 0
);
check(
  'E9 budget.js default param binds Date.now (not Date.now())',
  /now\s*=\s*Date\.now\b/.test(budgetSrc)
);

// Operator-facing reason shape
check(
  'E10 resolver reason uses "stopped after … (budget)" wording',
  /stopped after \$\{.*\}\s*\(budget\)/.test(resolverSrc) ||
    /stopped after \$\{sec\}s \(budget\)/.test(resolverSrc)
);

// ── tally ────────────────────────────────────────────────────────────

const total = pass + failures.length;
console.log('');
if (failures.length) {
  console.error(`❌ verifyGenericCatalogBudget: ${failures.length} FAILED, ${pass} passed (${total} total)\n`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ ${pass}/${total} checks passed`);
process.exit(0);
