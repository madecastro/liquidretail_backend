#!/usr/bin/env node
'use strict';
//
// verifyApifyCatalogOnlyGuard — pins the fix for the "catalog-only sync
// silently triggers a paid Apify Instagram re-scrape" money landmine
// (Marine Layer incident, 2026-08-19).
//
// syncBrandApify(brandId) gated the paid IG branch ONLY on
// `brand.apifyDemo.igHandle` being set — not on whether THIS CALLER wanted
// Instagram touched at all. Every demo brand that has ever run an IG pull
// carries a stamped igHandle forever, so any later catalog-only re-sync
// (a maintenance script, a future "re-sync catalog" button) would silently
// re-trigger a billable Apify actor. It cost $0 only by luck (no
// APIFY_TOKEN configured in the environment where this was caught, so the
// call failed fast) — Apify bills per RESULT, not per call, so this is not
// a bounded cost and must not be re-triggerable by accident.
//
// Fix: services/apifyIngestService.js — `syncBrandApify(brandId, {
// skipInstagram })`, decided by the exported pure function
// `shouldRunInstagramSync({ igHandle, skipInstagram })`. Default behaviour
// (skipInstagram unset) is BYTE-IDENTICAL to before — the three existing
// combined-pull callers (routes/salesDemos.js,
// services/capabilityExecutors/{catalogPullFromApify,salesBrandSync}.js)
// never pass the option and are unaffected. A caller that explicitly wants
// catalog-only now has a real, non-racy opt-out instead of having to mutate
// `brand.apifyDemo.igHandle` on the document and hope the clear committed
// before syncBrandApify's own re-read of the brand.
//
// Also pins `igWasAttempted(igResult)` — a deliberately-skipped IG branch
// must read as "not attempted", the same as igHandle never having been
// configured, so the GENERIC_CATALOG_FAIL_ON_ZERO outcome logic
// (services/apifySyncOutcome.js computeSyncOutcome) never reports a
// catalog-only run as "Instagram ingested nothing" — a false failure
// reason for something nobody asked to run.
//
// Offline: no DB, no network, no key. Every check calls the REAL exported
// function.
//
// Revert-proven: reverting shouldRunInstagramSync to the old unconditional
// `!!cfg.igHandle` fails group A; reverting igWasAttempted to a bare
// `!= null` check fails group B; removing the `skipInstagram` param from
// syncBrandApify's signature or dropping the export fails group C.
//
// Usage: node scripts/verifyApifyCatalogOnlyGuard.js

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  syncBrandApify,
  shouldRunInstagramSync,
  igWasAttempted
} = require('../services/apifyIngestService');
const { computeSyncOutcome } = require('../services/apifySyncOutcome');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// ── Group A: shouldRunInstagramSync ─────────────────────────────────────

check('A1: default behaviour unchanged — igHandle set, skipInstagram unset → runs IG', () => {
  assert.equal(shouldRunInstagramSync({ igHandle: 'marinelayer' }), true);
});

check('A2: skipInstagram:true is honored even with a configured igHandle — the actual fix', () => {
  assert.equal(shouldRunInstagramSync({ igHandle: 'marinelayer', skipInstagram: true }), false);
});

check('A3: no igHandle configured → never runs, regardless of skipInstagram', () => {
  assert.equal(shouldRunInstagramSync({ igHandle: null, skipInstagram: false }), false);
  assert.equal(shouldRunInstagramSync({ igHandle: '', skipInstagram: false }), false);
});

check('A4: skipInstagram:false explicitly passed behaves exactly like unset', () => {
  assert.equal(
    shouldRunInstagramSync({ igHandle: 'x', skipInstagram: false }),
    shouldRunInstagramSync({ igHandle: 'x' })
  );
});

// ── Group B: igWasAttempted / computeSyncOutcome interaction ────────────

check('B1: a real IG result (ok:true) reads as attempted', () => {
  assert.equal(igWasAttempted({ ok: true, ingested: 3 }), true);
});

check('B2: a skipped IG result reads as NOT attempted', () => {
  assert.equal(igWasAttempted({ ok: false, skipped: true, reason: 'catalog-only sync requested (skipInstagram) — Apify IG pull not run' }), false);
});

check('B3: no IG result at all (never configured) reads as NOT attempted', () => {
  assert.equal(igWasAttempted(null), false);
  assert.equal(igWasAttempted(undefined), false);
});

check('B4: a catalog-only run (IG skipped, Shopify succeeded) must NOT be reported as a failure', () => {
  const outcome = computeSyncOutcome({
    shopifyAttempted: true,
    shopifyZero: false,
    igAttempted: igWasAttempted({ ok: false, skipped: true, reason: 'skipped' }),
    igZero: true, // out.ig.ingested is undefined → zero, but igAttempted is false, so this must not matter
    aborted: false
  });
  assert.equal(outcome.status, 'succeeded');
});

check('B5: THE BUG THIS CLOSES — treating a skip as an attempt would have reported false failure on a catalog-only zero-Shopify edge case', () => {
  // Reconstructing the OLD (buggy) predicate directly, to prove it would
  // have disagreed with the fix on this exact shape.
  const oldIgAttempted = ({ ok: false, skipped: true }) != null; // the old `out.ig != null` — always true once out.ig is an object
  const outcomeOld = computeSyncOutcome({
    shopifyAttempted: true,
    shopifyZero: true, // e.g. store rate-limited before any product landed
    igAttempted: oldIgAttempted,
    igZero: true,
    aborted: false
  });
  const outcomeFixed = computeSyncOutcome({
    shopifyAttempted: true,
    shopifyZero: true,
    igAttempted: igWasAttempted({ ok: false, skipped: true }),
    igZero: true,
    aborted: false
  });
  assert.equal(outcomeOld.status, 'failed', 'sanity: the OLD predicate really did produce a failure here');
  assert.equal(outcomeOld.reason, 'catalog and Instagram both ingested nothing');
  assert.equal(outcomeFixed.status, 'failed', 'Shopify alone still legitimately failed here — that part is correct');
  assert.equal(outcomeFixed.reason, 'catalog ingested nothing', 'the FIXED reason must not blame Instagram for a branch nobody asked to run');
});

// ── Group C: wiring — syncBrandApify actually accepts and threads the flag ──

check('C1: syncBrandApify accepts a second options argument carrying skipInstagram', () => {
  assert.equal(typeof syncBrandApify, 'function');
  // A destructured default param does not count toward Function.length —
  // assert against the real signature text instead of arity.
  const src = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');
  assert.ok(
    /async function syncBrandApify\(brandId,\s*\{\s*skipInstagram = false\s*\}\s*=\s*\{\}\)/.test(src),
    'syncBrandApify signature must accept { skipInstagram } as its second argument'
  );
});

check('C2: the call site uses shouldRunInstagramSync — not a re-implemented inline condition', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');
  assert.ok(
    /if \(shouldRunInstagramSync\(\{\s*igHandle:\s*cfg\.igHandle,\s*skipInstagram\s*\}\)\)/.test(src),
    'syncBrandApify must gate the IG branch through the exported pure function'
  );
});

check('C3: the outcome computation uses igWasAttempted — not a re-implemented inline `!= null`', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');
  assert.ok(
    /const igAttempted = igWasAttempted\(out\.ig\);/.test(src),
    'igAttempted must be derived via igWasAttempted, not a bare out.ig != null'
  );
});

check('C4: both helpers are actually exported (a harness importing an unexported name would silently test undefined)', () => {
  const mod = require('../services/apifyIngestService');
  assert.equal(typeof mod.shouldRunInstagramSync, 'function');
  assert.equal(typeof mod.igWasAttempted, 'function');
});

// ── summary ─────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
