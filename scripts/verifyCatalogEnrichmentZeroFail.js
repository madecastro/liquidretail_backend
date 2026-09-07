#!/usr/bin/env node
'use strict';
//
// verifyCatalogEnrichmentZeroFail — pins the catalogProductEnrichmentService
// zero-enrichment run.fail fix (services/catalogProductEnrichmentService.js).
//
// THE GAP THIS CLOSES: runEnrichment() always called run.succeed(...) once
// its processQueue finished — even when EVERY product in the batch came
// back with zero new review/detail signal (e.g. the on-page review scrape
// is down site-wide AND the web-wide Gemini fallback is a fire-and-forget
// miss on every product). An operator watching the ActivityBar / ingest
// Slack feed saw a normal-looking green "enriched" run for work that
// accomplished nothing. Fixed by having enrichOne report whether it
// actually gained signal ({enriched: boolean}), aggregating that into a
// real enrichedCount (distinct from processed — the raw iteration count),
// and calling run.fail(...) instead of run.succeed(...) when
// enrichedCount === 0 && targets.length > 0. The pre-existing
// targets.length === 0 early-return (empty gap-fill — audit finding
// "Empty gap-fill returns without startRun") is untouched.
//
// Offline: no Mongo, no network, no keys. Monkeypatches the CatalogProduct
// model's statics (module-singleton — same pattern verifyIngestStatusFeed.js
// uses for OperationRun) and progressService.startRun (no injectable seam
// of its own), and drives the REAL enrichOne / runEnrichment (via the
// exported enqueueBrandProductEnrichment / enrichBrandDetails entry
// points) end to end.
//
// REVERT-PROOF (manually confirmed, not scripted as a mutation here — same
// as this repo's other orchestrator-level fixes): temporarily deleting the
// `if (enrichedCount === 0 && targets.length > 0)` branch in
// services/catalogProductEnrichmentService.js (so it always calls
// run.succeed) makes D1/D2/D3 below FAIL; restoring it makes them pass.
//
//   node scripts/verifyCatalogEnrichmentZeroFail.js

const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(id, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id}`); }
  else {
    const msg = detail ? `${id} — ${detail}` : id;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// ── stub CatalogProduct statics (module-singleton monkeypatch) ───────────
const CatalogProduct = require(path.join(ROOT, 'models', 'CatalogProduct.js'));
const originalStatics = {
  find: CatalogProduct.find,
  findById: CatalogProduct.findById
};

/** rows: array of plain product docs. byIdRows: Map<id, row|null> for the
 * separate .findById lookups maybeFetchProductReviewsCached makes. */
function installCatalogProductStub({ rows = [], byIdRows = new Map() } = {}) {
  CatalogProduct.find = () => ({
    select() { return this; },
    lean: async () => rows.map((r) => ({ ...r }))
  });
  CatalogProduct.findById = (id) => ({
    select() { return this; },
    lean: async () => {
      const row = byIdRows.has(String(id)) ? byIdRows.get(String(id)) : null;
      return row ? { ...row } : null;
    }
  });
}
function restoreCatalogProductStub() {
  CatalogProduct.find = originalStatics.find;
  CatalogProduct.findById = originalStatics.findById;
}

// ── stub progressService.startRun (no _setDeps seam of its own) ──────────
const progressService = require(path.join(ROOT, 'services', 'progressService.js'));
const originalStartRun = progressService.startRun;
function installRunSpy() {
  const calls = { succeed: [], fail: [], startArgs: [] };
  progressService.startRun = async (args) => {
    calls.startArgs.push(args);
    return {
      tick() {},
      async checkpoint() { return true; },
      markCancelled() {},
      async succeed(summary) { calls.succeed.push(summary); },
      async fail(err, meta) { calls.fail.push({ message: err && err.message, meta }); },
      id: `run-${calls.startArgs.length}`
    };
  };
  return calls;
}
function restoreRunSpy() {
  progressService.startRun = originalStartRun;
}

// ── stub reviewsEngine.captureForProduct + syncBrandProductReviews
// (whole-module reference in catalogProductEnrichmentService.js, so
// property overrides on the SAME cached module object are visible there) ─
const reviewsEngine = require(path.join(ROOT, 'services', 'productReviewsScrapeService.js'));
const originalReviewsEngine = {
  captureForProduct: reviewsEngine.captureForProduct,
  syncBrandProductReviews: reviewsEngine.syncBrandProductReviews
};
function installReviewsEngineStub({ captureForProduct = null } = {}) {
  reviewsEngine.syncBrandProductReviews = async () => ({ captured: 0, candidates: 0, withQuotes: 0 });
  reviewsEngine.captureForProduct = captureForProduct || (async () => ({ captured: false }));
}
function restoreReviewsEngineStub() {
  reviewsEngine.captureForProduct = originalReviewsEngine.captureForProduct;
  reviewsEngine.syncBrandProductReviews = originalReviewsEngine.syncBrandProductReviews;
}

// ── stub productDetailsService (whole-module reference) ──────────────────
const productDetailsService = require(path.join(ROOT, 'services', 'productDetailsService.js'));
const originalProductDetails = {
  isEnabled: productDetailsService.isEnabled,
  fetchProductDetails: productDetailsService.fetchProductDetails
};
function installProductDetailsStub({ enabled = false, fetchProductDetails = null } = {}) {
  productDetailsService.isEnabled = () => enabled;
  productDetailsService.fetchProductDetails = fetchProductDetails || (async () => null);
}
function restoreProductDetailsStub() {
  productDetailsService.isEnabled = originalProductDetails.isEnabled;
  productDetailsService.fetchProductDetails = originalProductDetails.fetchProductDetails;
}

const enrichment = require(path.join(ROOT, 'services', 'catalogProductEnrichmentService.js'));

(async () => {
  // ── A. enrichOne's own {enriched} contract, directly ────────────────────
  console.log('\nA. enrichOne reports real signal, not mere completion');

  // A1 — on-page scrape captures something → enriched:true.
  installCatalogProductStub({});
  installReviewsEngineStub({ captureForProduct: async () => ({ captured: true, productReviews: { quotes: [{ text: 'x' }], rating: 4.5, reviewCount: 10 } }) });
  installProductDetailsStub({ enabled: false });
  const a1 = await enrichment.enrichOne({ _id: 'p1', title: 'Widget', productUrl: 'https://x.test/p1' }, { includeDetails: false });
  check('A1 on-page capture → enriched:true', a1 && a1.enriched === true, JSON.stringify(a1));

  // A2 — on-page scrape misses (no productUrl) AND the web-wide gap-fill
  // helper's own genuine cache-miss path (real function, not stubbed —
  // forced via CatalogProduct.findById returning null) → enriched:false.
  installCatalogProductStub({ byIdRows: new Map([['p2', null]]) });
  installReviewsEngineStub({});
  installProductDetailsStub({ enabled: false });
  const a2 = await enrichment.enrichOne({ _id: 'p2', title: 'Gizmo' }, { includeDetails: false });
  check('A2 no productUrl + genuine review cache-miss → enriched:false', a2 && a2.enriched === false, JSON.stringify(a2));

  // A3 — same as A2 but CatalogProduct.findById returns a FRESH cached
  // review row → maybeFetchProductReviewsCached (real function) hits its
  // synchronous cache-hit branch and returns truthy → enriched:true.
  installCatalogProductStub({
    byIdRows: new Map([['p3', {
      _id: 'p3',
      title: 'Gadget',
      productReviews: { quotes: [{ text: 'great' }], fetchedAt: new Date(), rating: 4.8 }
    }]])
  });
  installReviewsEngineStub({});
  installProductDetailsStub({ enabled: false });
  const a3 = await enrichment.enrichOne({ _id: 'p3', title: 'Gadget' }, { includeDetails: false });
  check('A3 fresh cached web-wide reviews → enriched:true', a3 && a3.enriched === true, JSON.stringify(a3));

  // A4 — includeDetails path: reviews find nothing, but details fetch
  // returns a truthy result → still enriched:true (either source counts).
  installCatalogProductStub({ byIdRows: new Map([['p4', null]]) });
  installReviewsEngineStub({});
  installProductDetailsStub({ enabled: true, fetchProductDetails: async () => ({ price: '$10' }) });
  const a4 = await enrichment.enrichOne({ _id: 'p4', title: 'Doohickey', brandId: 'b1' }, { includeDetails: true });
  check('A4 details fetch returns data → enriched:true even with zero review signal', a4 && a4.enriched === true, JSON.stringify(a4));

  // A5 — includeDetails path: BOTH reviews and details come back empty →
  // enriched:false (the genuine all-sources-empty case).
  installCatalogProductStub({ byIdRows: new Map([['p5', null]]) });
  installReviewsEngineStub({});
  installProductDetailsStub({ enabled: true, fetchProductDetails: async () => null });
  const a5 = await enrichment.enrichOne({ _id: 'p5', title: 'Thingamajig', brandId: 'b1' }, { includeDetails: true });
  check('A5 reviews AND details both empty → enriched:false', a5 && a5.enriched === false, JSON.stringify(a5));

  // ── B. runEnrichment gates succeed/fail on the AGGREGATE, via the real
  // exported entry points (enqueueBrandProductEnrichment / enrichBrandDetails) ──
  console.log('\nB. run.fail on zero success (behavioral, end-to-end via the real entry points)');

  // B1 — AUTO path (enqueueBrandProductEnrichment), 3 gap-eligible products,
  // EVERY ONE produces zero signal → run.fail must be called, not succeed.
  {
    const rows = [
      { _id: 'e1', advertiserId: 'adv1', title: 'A', brand: 'Acme', productUrl: null, productReviews: undefined, rating: null },
      { _id: 'e2', advertiserId: 'adv1', title: 'B', brand: 'Acme', productUrl: null, productReviews: undefined, rating: null },
      { _id: 'e3', advertiserId: 'adv1', title: 'C', brand: 'Acme', productUrl: null, productReviews: undefined, rating: null }
    ];
    installCatalogProductStub({ rows, byIdRows: new Map([['e1', null], ['e2', null], ['e3', null]]) });
    installReviewsEngineStub({});
    installProductDetailsStub({ enabled: false });
    const calls = installRunSpy();

    const result = await enrichment.enqueueBrandProductEnrichment('brand-zero');

    check('B1 result reports ok:false', result && result.ok === false, JSON.stringify(result));
    check('B2 result reports enriched:0', result && result.enriched === 0, JSON.stringify(result));
    check('D1 run.fail called exactly once (THE FIX — revert-prove: delete the enrichedCount===0 branch, this fails)',
      calls.fail.length === 1 && calls.succeed.length === 0,
      `fail=${calls.fail.length} succeed=${calls.succeed.length}`);
    check('D2 run.fail carries a real error message naming zero enrichments',
      calls.fail[0] && /0 of 3/.test(calls.fail[0].message || ''),
      JSON.stringify(calls.fail[0]));
    check('D3 run.fail meta carries targets/processed/enriched for diagnosis',
      calls.fail[0] && calls.fail[0].meta
        && calls.fail[0].meta.targets === 3
        && calls.fail[0].meta.processed === 3
        && calls.fail[0].meta.enriched === 0,
      JSON.stringify(calls.fail[0] && calls.fail[0].meta));

    restoreRunSpy();
  }

  // B2 — same shape, but ONE of the three products has a fresh cached
  // review row (genuine partial success) → run.succeed must be called,
  // not fail, and the succeed payload must report the REAL enriched count
  // (1), not the raw processed count (3).
  {
    const rows = [
      { _id: 'g1', advertiserId: 'adv1', title: 'A', brand: 'Acme', productUrl: null, productReviews: undefined, rating: null },
      { _id: 'g2', advertiserId: 'adv1', title: 'B', brand: 'Acme', productUrl: null, productReviews: undefined, rating: null },
      { _id: 'g3', advertiserId: 'adv1', title: 'C', brand: 'Acme', productUrl: null, productReviews: undefined, rating: null }
    ];
    installCatalogProductStub({
      rows,
      byIdRows: new Map([
        ['g1', null],
        ['g2', { _id: 'g2', title: 'B', productReviews: { quotes: [{ text: 'nice' }], fetchedAt: new Date(), rating: 4.2 } }],
        ['g3', null]
      ])
    });
    installReviewsEngineStub({});
    installProductDetailsStub({ enabled: false });
    const calls = installRunSpy();

    const result = await enrichment.enqueueBrandProductEnrichment('brand-partial');

    check('B3 result reports ok:true (at least one real enrichment)', result && result.ok === true, JSON.stringify(result));
    check('B4 result reports enriched:1 (the REAL count, not processed=3)', result && result.enriched === 1, JSON.stringify(result));
    check('D4 run.succeed called, run.fail NOT called', calls.succeed.length === 1 && calls.fail.length === 0,
      `succeed=${calls.succeed.length} fail=${calls.fail.length}`);
    check('D5 succeed payload carries the real enriched count (1), not the processed count (3)',
      calls.succeed[0] && calls.succeed[0].enriched === 1,
      JSON.stringify(calls.succeed[0]));

    restoreRunSpy();
  }

  // B3 — the empty-early-return path (targets.length === 0) must be
  // UNTOUCHED: no startRun call at all (audit finding "Empty gap-fill
  // returns without startRun" — do not regress this into starting a run
  // just to immediately fail/succeed it).
  {
    installCatalogProductStub({ rows: [] });
    installReviewsEngineStub({});
    installProductDetailsStub({ enabled: false });
    const calls = installRunSpy();

    const result = await enrichment.enqueueBrandProductEnrichment('brand-empty');

    check('B5 empty brand: ok:true, enriched:0, no crash', result && result.ok === true && result.enriched === 0, JSON.stringify(result));
    check('D6 empty-target path never calls startRun (still a no-op/skip, not our new fail path)',
      calls.startArgs.length === 0, `startRun called ${calls.startArgs.length} time(s)`);

    restoreRunSpy();
  }

  restoreCatalogProductStub();
  restoreReviewsEngineStub();
  restoreProductDetailsStub();

  console.log('');
  if (failures.length) {
    console.log(`${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`${pass} passed, 0 failed`);
  process.exit(0);
})().catch((err) => {
  restoreCatalogProductStub();
  restoreReviewsEngineStub();
  restoreProductDetailsStub();
  restoreRunSpy();
  console.error('harness crashed:', err && err.stack || err);
  process.exit(1);
});
