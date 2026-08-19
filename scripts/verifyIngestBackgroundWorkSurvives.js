#!/usr/bin/env node
'use strict';
//
// verifyIngestBackgroundWorkSurvives — pins two robustness/visibility fixes
// found while investigating a (later debunked) Marine Layer ingest "hang"
// report, 2026-08-19. The ingest itself was never stuck — it finished in
// 42.9 minutes after being rate-limited by marinelayer.com — but two real
// bugs surfaced along the way:
//
//   1. shopifyPublicIngestService.js's end-of-run trio (on-site review
//      scrape + catalog enrichment, category inference) used to fire via
//      setImmediate(). setImmediate() defers ONE tick — it does not keep
//      the caller's process (or its Mongoose connection) alive for that
//      tick. A short-lived caller that connects → syncs → disconnects can
//      tear the connection down first, and both triggers then throw
//      "Client must be connected before running operations" with nothing
//      but a console.warn to show it — measured live on a real re-ingest.
//      Same bug, same fix, in apifyIngestService.js's IG-side brand
//      enrichment trigger. Fix: call directly (no setImmediate — an async
//      function already yields at its first await) and expose the
//      resulting promises on the return value (`backgroundWork`) so a
//      caller that owns its own connection lifecycle can await them
//      first. Every existing HTTP/executor caller ignores the new field
//      and is unaffected — they stay connected for the process lifetime
//      anyway, which is why this was invisible before.
//
//   2. A mid-stage rate-limit break only pushed one line into `errors[]`,
//      which apifyIngestService.js's summary collapses to a bare COUNT.
//      An operator watching a completed run with videos=0/reviews=0 had
//      no way to tell "the store rate-limited us" from "there was nothing
//      to find". Fix: `run.note(...)` at the moment of the break (the
//      EXISTING progressService status channel, not a new one) plus
//      `mediaRateLimited` / `reviewsRateLimited` flags threaded through to
//      the caller's result object.
//
// Offline: source-text assertions only (no DB / network / key) — same
// style as verifyBrandWebsiteBackfill.js's E-group, for the same reason:
// a full behavioral test would need to mock Mongoose's live-connection
// state, which is exactly the thing under test. Each check targets a
// SPECIFIC line shape, not a loose substring, so a cosmetic reformat is
// unlikely to false-negative and a real regression is unlikely to
// false-positive.
//
// Revert-proven: restoring either setImmediate() call, or dropping
// `backgroundWork` from either return value, or dropping either
// `run.note()` rate-limit call fails the corresponding check below.
//
// Usage: node scripts/verifyIngestBackgroundWorkSurvives.js

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

const shopifySrc = fs.readFileSync(path.join(__dirname, '../services/shopifyPublicIngestService.js'), 'utf8');
const apifySrc = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');

// ── Group A: end-of-run trio no longer uses setImmediate ────────────────

check('A1: shopifyPublicIngestService.js end-of-run trio contains no setImmediate', () => {
  // Scope the assertion to the CODE region (starting after the explanatory
  // comment, which legitimately narrates the old setImmediate() bug in
  // prose) so an unrelated future setImmediate elsewhere in the file
  // cannot make this check meaningless, and so the comment's own history
  // does not trip it.
  const codeStart = shopifySrc.indexOf('const cancelled = await abortCheck(brand._id, run);\n  const backgroundWork = [];');
  assert.ok(codeStart > -1, 'end-of-run trio code start not found — file changed shape?');
  const trioRegion = shopifySrc.slice(codeStart, codeStart + 2500);
  assert.ok(!trioRegion.includes('setImmediate(() =>'), 'the end-of-run trio CODE must not defer via setImmediate — see ROBUSTNESS comment');
  assert.ok(trioRegion.includes('backgroundWork.push('), 'the trio must collect its background promises for the caller to await');
});

check('A2: syncBrandShopifyDirect returns backgroundWork on its result object', () => {
  assert.ok(/const out = \{[^}]*backgroundWork/s.test(shopifySrc), 'returned `out` must carry backgroundWork');
});

check('A3: apifyIngestService.js forwards shopifyPublicIngestService\'s backgroundWork onto out.shopify', () => {
  const shopBlockStart = apifySrc.indexOf("} else if (method === 'shopify-direct') {");
  assert.ok(shopBlockStart > -1, 'shopify-direct branch not found — file changed shape?');
  const shopBlock = apifySrc.slice(shopBlockStart, shopBlockStart + 1400);
  assert.ok(shopBlock.includes('r.backgroundWork'), 'out.shopify must forward r.backgroundWork from the shopify-direct result');
  assert.ok(shopBlock.includes('backgroundWork: r.backgroundWork'), 'must be keyed as backgroundWork on out.shopify');
});

check('A4: apifyIngestService.js\'s IG-side brand-enrichment trigger no longer uses setImmediate', () => {
  const igStart = apifySrc.indexOf('async function syncBrandInstagram');
  assert.ok(igStart > -1, 'syncBrandInstagram not found — file changed shape?');
  const igEnd = apifySrc.indexOf('async function ingestIgPost');
  assert.ok(igEnd > igStart, 'ingestIgPost not found after syncBrandInstagram — file changed shape?');
  const igRegion = apifySrc.slice(igStart, igEnd);
  assert.ok(!igRegion.includes('setImmediate(() =>'), 'the IG-side enrichment trigger CODE must not defer via setImmediate (comment prose narrating the old bug is fine)');
  assert.ok(
    igRegion.includes("summary.backgroundWork = [") && igRegion.includes("require('./brandEnrichmentService')"),
    'summary must expose the enrichment promise as backgroundWork'
  );
});

// ── Group B: rate-limit visibility ───────────────────────────────────────

check('B1: media-stage rate-limit break notes the run AND sets a flag', () => {
  const idx = shopifySrc.indexOf('media stage rate-limited at handle');
  assert.ok(idx > -1);
  const region = shopifySrc.slice(idx - 200, idx + 400);
  assert.ok(region.includes('mediaRateLimited = true'), 'the flag must be set at the break site');
  assert.ok(region.includes("run?.note?.("), 'the break must push a note through the existing progressService status channel');
});

check('B2: reviews-stage rate-limit break notes the run AND sets a flag', () => {
  const idx = shopifySrc.indexOf('reviews stage rate-limited at handle');
  assert.ok(idx > -1);
  const region = shopifySrc.slice(idx - 200, idx + 400);
  assert.ok(region.includes('reviewsRateLimited = true'), 'the flag must be set at the break site');
  assert.ok(region.includes("run?.note?.("), 'the break must push a note through the existing progressService status channel');
});

check('B3: both flags survive onto the returned result, not just the internal errors[] count', () => {
  assert.ok(/if \(mediaRateLimited\) out\.mediaRateLimited = true;/.test(shopifySrc));
  assert.ok(/if \(reviewsRateLimited\) out\.reviewsRateLimited = true;/.test(shopifySrc));
});

check('B4: apifyIngestService.js forwards both rate-limit flags onto out.shopify', () => {
  const shopBlockStart = apifySrc.indexOf("} else if (method === 'shopify-direct') {");
  assert.ok(shopBlockStart > -1, 'shopify-direct branch not found — file changed shape?');
  const shopBlock = apifySrc.slice(shopBlockStart, shopBlockStart + 1400);
  assert.ok(shopBlock.includes('mediaRateLimited: true'), 'must forward mediaRateLimited');
  assert.ok(shopBlock.includes('reviewsRateLimited: true'), 'must forward reviewsRateLimited');
});

// ── summary ─────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
