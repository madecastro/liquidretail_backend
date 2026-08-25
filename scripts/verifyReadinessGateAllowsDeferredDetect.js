#!/usr/bin/env node
'use strict';
//
// verifyReadinessGateAllowsDeferredDetect — a brand whose catalog detect has
// not run yet must still be allowed to create campaigns and generate ads.
//
// ── THE DEADLOCK THIS PINS ──────────────────────────────────────────────
// Catalog detect is DEFERRED at sync time. enqueueBrandProductDetects runs at
// the end of every catalog ingest and returns { deferred:true, heroEnqueued:0 }
// unless CATALOG_DETECT_PRECOMPUTE === 'true'; the committed default is false,
// deliberately, because most catalog products never become ads. The only other
// creator of a catalog DetectRun is ensureDetectForProducts, invoked from
// campaignAdsGenerationService — inside the request this gate was refusing.
//
// So adReadinessService's old `catalogRuns.completed === 0` blocker demanded
// work that only the blocked path could start. Any brand onboarded after
// deferral shipped was permanently unable to advertise.
//
// MEASURED 2026-08-25: PB5star (102 catalog Media / 0 DetectRuns), Marine Layer
// (200 / 0) and Gymshark (5 / 0) all 409'd on POST /api/campaigns and
// POST /api/ads/generate. Pelagic and both Soludos brands passed only because
// they were onboarded while catalog detect was still eager.
//
// This is the SECOND time this one gate has locked out this same set of demo
// brands for a different reason — see the 2026-08-19 note in probeConnections,
// which names Marine Layer, GymShark, Peloton and PB5Star. Hence a harness
// rather than another silent one-line fix.
//
// ── WHAT MUST STILL BLOCK ───────────────────────────────────────────────
// 'catalog-empty' is a real precondition: no catalog-product Media means no
// seed image, so there is nothing to advertise. Peloton Apparel sits in exactly
// that state (1,492 CatalogProducts, 0 Media — materialize never ran) and must
// keep failing until materialize is run for it.
//
// BEHAVIOURAL, not source-text: this drives the real exported getAdReadiness
// against real document shapes, with the five models stubbed through
// require.cache. A reimplementation that kept the old semantics under a new
// name would fail these checks; a source scan for a removed string would not.
//
// Offline: no DB, no network.
//
// Revert-prove:
//   node scripts/verifyReadinessGateAllowsDeferredDetect.js   → pass
//   restore the `catalogRuns.completed === 0` blocker         → checks 1,2 FAIL
//   also drop the catalog-empty blocker                       → check 3 FAILS
//   drop the in-flight blocker                                → check 4 FAILS
//
const assert = require('assert');
const path = require('path');

const failures = [];
const infos = [];
let checks = 0;
async function check(label, fn) {
  checks += 1;
  try { await fn(); } catch (err) { failures.push(`${label}: ${err.message}`); }
}
const info = (s) => infos.push(s);

const MODELS = path.join(__dirname, '..', 'models');
const P = {
  DetectRun: path.join(MODELS, 'DetectRun.js'),
  Media: path.join(MODELS, 'Media.js'),
  IntegrationCredential: path.join(MODELS, 'IntegrationCredential.js'),
  Brand: path.join(MODELS, 'Brand.js'),
  CatalogProduct: path.join(MODELS, 'CatalogProduct.js')
};
const SVC = path.join(__dirname, '..', 'services', 'adReadinessService.js');

// Build a world: N catalog media, M catalog DetectRuns in a given status,
// with an active IG credential carrying a catalogId (so connections.catalog).
function installWorld({ catalogMedia = 0, runs = {}, socialMedia = 0 }) {
  for (const p of Object.values(P)) delete require.cache[require.resolve(p)];
  delete require.cache[require.resolve(SVC)];

  const catalogIds = Array.from({ length: catalogMedia }, (_, i) => `cm${i}`);
  const socialIds  = Array.from({ length: socialMedia  }, (_, i) => `sm${i}`);

  const mediaFind = (q) => {
    const isCatalog = q && q.source === 'catalog-product';
    const ids = isCatalog ? catalogIds : socialIds;
    return { select: () => ({ lean: async () => ids.map(id => ({ _id: id })) }) };
  };

  require.cache[require.resolve(P.Media)] = { id: P.Media, filename: P.Media, loaded: true, exports: {
    find: mediaFind,
    countDocuments: async () => socialIds.length
  }};
  require.cache[require.resolve(P.DetectRun)] = { id: P.DetectRun, filename: P.DetectRun, loaded: true, exports: {
    aggregate: async () => Object.entries(runs).map(([status, n]) => ({ _id: status, n }))
  }};
  require.cache[require.resolve(P.IntegrationCredential)] = { id: P.IntegrationCredential, filename: P.IntegrationCredential, loaded: true, exports: {
    findOne: () => ({ select: () => ({ lean: async () => ({ catalogId: 'cat-1' }) }) })
  }};
  require.cache[require.resolve(P.Brand)] = { id: P.Brand, filename: P.Brand, loaded: true, exports: {
    findById: () => ({ select: () => ({ lean: async () => ({ isDemo: true, apifyDemo: { shopifyUrl: 'https://x.com' } }) }) })
  }};
  require.cache[require.resolve(P.CatalogProduct)] = { id: P.CatalogProduct, filename: P.CatalogProduct, loaded: true, exports: {
    countDocuments: async () => (catalogMedia > 0 ? catalogMedia : 0)
  }};

  return require(SVC);
}
const codes = (r) => (r.blockers || []).map(b => b.code);

async function main() {
  // 1 — the exact production shape that was locked out
  await check('a brand with catalog Media and ZERO completed detect runs is READY', async () => {
    const { getAdReadiness } = installWorld({ catalogMedia: 200, runs: {} });
    const r = await getAdReadiness('b1');
    assert.ok(!codes(r).includes('catalog-detect-not-started'),
      `still emits catalog-detect-not-started — this is the deadlock: nothing outside the blocked request creates a catalog DetectRun. blockers=${JSON.stringify(codes(r))}`);
    assert.strictEqual(r.ready, true, `expected ready, got blockers=${JSON.stringify(codes(r))}`);
    info('Marine Layer shape (200 catalog Media, 0 runs) → ready');
  });

  // 2 — the smaller shape too (Gymshark had only 5 media)
  await check('a brand with few catalog Media and zero runs is READY', async () => {
    const { getAdReadiness } = installWorld({ catalogMedia: 5, runs: {} });
    const r = await getAdReadiness('b1');
    assert.strictEqual(r.ready, true, `blockers=${JSON.stringify(codes(r))}`);
    info('Gymshark shape (5 catalog Media, 0 runs) → ready');
  });

  // 3 — catalog-empty MUST still block: no Media means no seed
  await check('a brand with NO catalog Media is still BLOCKED as catalog-empty', async () => {
    const { getAdReadiness } = installWorld({ catalogMedia: 0, runs: {} });
    const r = await getAdReadiness('b1');
    assert.ok(codes(r).includes('catalog-empty'),
      `expected catalog-empty; a brand with no catalog-product Media has no seed image and must not be allowed to generate. blockers=${JSON.stringify(codes(r))}`);
    assert.strictEqual(r.ready, false);
    info('Peloton shape (0 catalog Media) → still blocked catalog-empty');
  });

  // 4 — in-flight still blocks (deliberately unchanged by this fix)
  await check('in-flight catalog detect still blocks', async () => {
    const { getAdReadiness } = installWorld({ catalogMedia: 100, runs: { completed: 5, processing: 2 } });
    const r = await getAdReadiness('b1');
    assert.ok(codes(r).includes('catalog-detect-in-flight'),
      `expected catalog-detect-in-flight; blockers=${JSON.stringify(codes(r))}`);
    info('in-flight blocker preserved (its brand-wide scoping is a separate known issue)');
  });

  // 5 — a healthy brand is unaffected
  await check('a fully detected brand is READY, as before', async () => {
    const { getAdReadiness } = installWorld({ catalogMedia: 1064, runs: { completed: 179 } });
    const r = await getAdReadiness('b1');
    assert.strictEqual(r.ready, true, `blockers=${JSON.stringify(codes(r))}`);
    info('Pelagic shape (1064 media, 179 completed) → ready, unchanged');
  });

  // 6 — the SOCIAL side is untouched: its detect gate still applies
  await check('social source still requires a completed detect run', async () => {
    const { getAdReadiness } = installWorld({ catalogMedia: 100, runs: {}, socialMedia: 10 });
    const r = await getAdReadiness('b1');
    assert.ok(codes(r).includes('social-detect-not-started'),
      `the social gate must NOT have been loosened by this change — only catalog detect is deferred. blockers=${JSON.stringify(codes(r))}`);
    // Without this second assertion the check would also pass against the OLD
    // catalog blocker (both codes would be present), i.e. it would go green on
    // exactly the code this harness exists to keep out.
    assert.ok(!codes(r).includes('catalog-detect-not-started'),
      `catalog-detect-not-started is back, on a brand that also has social. blockers=${JSON.stringify(codes(r))}`);
    info('social-detect-not-started preserved, and catalog blocker still absent — the loosening is catalog-only');
  });

  for (const p of Object.values(P)) delete require.cache[require.resolve(p)];
  delete require.cache[require.resolve(SVC)];

  console.log(`verifyReadinessGateAllowsDeferredDetect: ${checks} check(s) against the real getAdReadiness.`);
  for (const i of infos) console.log(`  info: ${i}`);
  if (failures.length) {
    console.log(`\n❌ verifyReadinessGateAllowsDeferredDetect: ${failures.length} of ${checks} check(s) FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ verifyReadinessGateAllowsDeferredDetect: ${checks}/${checks} checks passed`);
}
main().catch((err) => { console.error(`verifyReadinessGateAllowsDeferredDetect crashed: ${err.stack}`); process.exit(1); });
