#!/usr/bin/env node
/**
 * verifyAdReadinessIngestSources.js
 *
 * Pins the fix for: a brand with a full catalog could not create a campaign
 * unless its products happened to be ingested by the LEGACY paid-Apify path.
 *
 * services/adReadinessService.js#probeConnections used to count
 *   CatalogProduct.countDocuments({ brandId, source: 'apify-shopify' })
 * which was the only demo ingest path when the gate was written. Two more have
 * shipped since — 'shopify-direct' (the FREE public-storefront ladder, now the
 * preferred path) and 'generic-sitemap'. Neither was added, so every brand
 * ingested the modern way read as "no catalog" and was refused with
 * "Run an Apify sync from the Sales Demos page before creating ads."
 *
 * Measured blast radius when found (2026-08-19): 11 of 17 demo brands with a
 * configured shopifyUrl were blocked despite full catalogs — Vuori 2 (9,185
 * products), Marine Layer (2,444), Marine Layer 2 (2,295), GymShark, Peloton,
 * PB5Star, Vuori Clothing, Living Spaces, Fellow Products, Fanatics, Ubeauty.
 * Pelagic Gear passed only by accident, off 50 SOFT-DELETED legacy rows.
 *
 * BEHAVIOURAL, not source-text: every check drives the real exported
 * getAdReadiness() with the real Mongoose models stubbed at the query layer, so
 * a reimplementation that keeps the function name but restores the narrow
 * filter still fails.
 *
 * REVERT-PROOF — restore the old filter in probeConnections, i.e.
 *   CatalogProduct.countDocuments({ brandId, source: 'apify-shopify' })
 * and S2/S3/S5 go red (a shopify-direct / generic-sitemap / mixed-source brand
 * would once again be reported unready). Drop the `deletedAt: null` clause and
 * S4 goes red (an all-tombstoned catalog would falsely read as ready).
 *
 * Run: node scripts/verifyAdReadinessIngestSources.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

let pass = 0;
const failures = [];

// ── Stub the models BEFORE requiring the service under test. We intercept at
// require() so the service gets our doubles without any production code change.
const ROOT = path.join(__dirname, '..');
const realResolve = Module._resolveFilename;
const realLoad = Module._load;

let CATALOG_ROWS = [];        // [{ source, deletedAt }]
let BRAND_DOC = null;
let CRED_DOC = null;
let MEDIA_COUNT = 0;
let lastCatalogFilter = null;

function matches(row, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === 'brandId') continue;                 // single-brand fixture
    if (k === 'deletedAt') {
      const isNull = row.deletedAt === null || row.deletedAt === undefined;
      if (v === null && !isNull) return false;
      continue;
    }
    if (v && typeof v === 'object' && Array.isArray(v.$in)) {
      if (!v.$in.includes(row[k])) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

// A Mongoose-query-shaped double where every chained builder method returns
// itself and awaiting it yields []. Keeps the fixture focused on the catalog
// gate without having to model each unrelated query getAdReadiness runs.
function chainableEmpty(result = []) {
  const p = Promise.resolve(result);
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return p.then.bind(p);
      if (prop === 'catch') return p.catch.bind(p);
      if (prop === 'finally') return p.finally.bind(p);
      return () => proxy;
    },
    apply() { return proxy; }
  });
  return proxy;
}

const stubs = {
  'CatalogProduct': {
    countDocuments: async (filter) => {
      lastCatalogFilter = filter;
      return CATALOG_ROWS.filter(r => matches(r, filter)).length;
    }
  },
  // Chainable empty-result double: any .find()/.select()/.lean()/.sort()/etc
  // chain resolves to []. getAdReadiness walks several such queries after the
  // gate we care about; they must not throw, but their contents are irrelevant
  // to these checks.
  'Media': {
    countDocuments: async () => MEDIA_COUNT,
    find: () => chainableEmpty(),
    distinct: async () => [],
    aggregate: async () => []
  },
  'Brand': {
    findById: () => ({ select: () => ({ lean: async () => BRAND_DOC }) })
  },
  'IntegrationCredential': {
    findOne: () => ({ select: () => ({ lean: async () => CRED_DOC }) })
  },
  'DetectRun': { aggregate: async () => [] },
  'Ad': { countDocuments: async () => 0, find: () => ({ select: () => ({ lean: async () => [] }) }), distinct: async () => [] },
  'CampaignRun': { countDocuments: async () => 0, find: () => ({ select: () => ({ lean: async () => [] }) }) },
  'Campaign': { countDocuments: async () => 0, find: () => ({ select: () => ({ lean: async () => [] }) }) }
};

Module._load = function (request, parent, isMain) {
  const base = path.basename(String(request));
  if (stubs[base] && String(request).includes('models')) return stubs[base];
  return realLoad.apply(this, arguments);
};

const svc = require(path.join(ROOT, 'services', 'adReadinessService.js'));

Module._load = realLoad;
Module._resolveFilename = realResolve;


// The bug under test is specifically the CATALOG-PRESENCE gate, which surfaces
// as blocker code 'demo-not-synced' / the "Run an Apify sync…" reason.
// getAdReadiness has further, legitimate downstream gates (detect completion),
// so asserting overall ready:true would couple these checks to unrelated
// pipeline state. Assert on the catalog blocker itself.
function assertCatalogGatePassed(r, msg) {
  const blocked = (r.blockers || []).some(b => b.code === 'demo-not-synced')
    || /Run an Apify sync/i.test(r.reason || '');
  assert.strictEqual(blocked, false, `${msg} — got reason: ${r.reason}`);
}
function assertCatalogGateBlocked(r, msg) {
  const blocked = (r.blockers || []).some(b => b.code === 'demo-not-synced')
    || /Run an Apify sync/i.test(r.reason || '');
  assert.strictEqual(blocked, true, `${msg} — got reason: ${r.reason}`);
}

async function check(name, fn) {
  try { await fn(); pass++; }
  catch (e) { failures.push(`${name} — ${e.message}`); }
}

function resetFixture() {
  BRAND_DOC = { _id: 'b1', isDemo: true, apifyDemo: { shopifyUrl: 'https://x.myshopify.com' } };
  CRED_DOC = null;
  MEDIA_COUNT = 0;
  CATALOG_ROWS = [];
  lastCatalogFilter = null;
}

(async () => {
  // ── S1: legacy apify-shopify brand still reads ready (no regression) ──────
  await check('S1 legacy apify-shopify catalog -> ready', async () => {
    resetFixture();
    CATALOG_ROWS = [{ source: 'apify-shopify', deletedAt: null }];
    const r = await svc.getAdReadiness('b1');
    assertCatalogGatePassed(r, 'legacy apify-shopify catalog must satisfy the catalog gate');
  });

  // ── S2: THE BUG — shopify-direct (free path) must read ready ─────────────
  await check('S2 shopify-direct catalog -> ready (was BLOCKED)', async () => {
    resetFixture();
    CATALOG_ROWS = Array.from({ length: 9185 }, () => ({ source: 'shopify-direct', deletedAt: null }));
    const r = await svc.getAdReadiness('b1');
    assertCatalogGatePassed(r, 'a 9185-product shopify-direct brand must not be blocked');
  });

  // ── S3: generic-sitemap is the third real path ───────────────────────────
  await check('S3 generic-sitemap catalog -> ready', async () => {
    resetFixture();
    CATALOG_ROWS = [{ source: 'generic-sitemap', deletedAt: null }];
    const r = await svc.getAdReadiness('b1');
    assertCatalogGatePassed(r, 'a generic-sitemap catalog must satisfy the catalog gate');
  });

  // ── S4: a fully tombstoned catalog must NOT read ready ───────────────────
  await check('S4 all products soft-deleted -> NOT ready', async () => {
    resetFixture();
    CATALOG_ROWS = [
      { source: 'shopify-direct', deletedAt: new Date() },
      { source: 'apify-shopify', deletedAt: new Date() }
    ];
    const r = await svc.getAdReadiness('b1');
    assertCatalogGateBlocked(r, 'a fully tombstoned catalog must not satisfy the catalog gate');
  });

  // ── S5: Pelagic's real shape — live direct rows + tombstoned legacy rows ──
  await check('S5 mixed live shopify-direct + tombstoned apify-shopify -> ready', async () => {
    resetFixture();
    CATALOG_ROWS = [
      ...Array.from({ length: 824 }, () => ({ source: 'shopify-direct', deletedAt: null })),
      ...Array.from({ length: 50 }, () => ({ source: 'apify-shopify', deletedAt: new Date() }))
    ];
    const r = await svc.getAdReadiness('b1');
    assertCatalogGatePassed(r, 'Pelagic-shaped brand must satisfy the catalog gate on its LIVE rows');
  });

  // ── S6: genuinely empty catalog still gated (original intent preserved) ──
  await check('S6 zero products -> NOT ready, demo-not-synced blocker', async () => {
    resetFixture();
    CATALOG_ROWS = [];
    const r = await svc.getAdReadiness('b1');
    assertCatalogGateBlocked(r, 'an empty catalog must remain gated');
  });

  // ── S7: the query must not filter on `source` at all ─────────────────────
  await check('S7 catalog count is not narrowed to a single ingest source', async () => {
    resetFixture();
    CATALOG_ROWS = [{ source: 'shopify-direct', deletedAt: null }];
    await svc.getAdReadiness('b1');
    assert.ok(lastCatalogFilter, 'expected CatalogProduct.countDocuments to be called');
    assert.strictEqual(lastCatalogFilter.source, undefined,
      `catalog gate must not filter by source; saw ${JSON.stringify(lastCatalogFilter)}`);
    assert.strictEqual(lastCatalogFilter.deletedAt, null,
      `catalog gate must exclude tombstoned rows; saw ${JSON.stringify(lastCatalogFilter)}`);
  });

  // ── S8: a real IG credential still short-circuits regardless of catalog ──
  await check('S8 IG credential with catalogId -> ready even with no demo rows', async () => {
    resetFixture();
    BRAND_DOC = { _id: 'b1', isDemo: false, apifyDemo: {} };
    CRED_DOC = { catalogId: 'cat_123' };
    CATALOG_ROWS = [];
    const r = await svc.getAdReadiness('b1');
    assertCatalogGatePassed(r, 'a real IG catalog credential must satisfy the catalog gate');
  });

  console.log(failures.length
    ? `\n❌ verifyAdReadinessIngestSources: ${pass} passed, ${failures.length} FAILED\n   ` + failures.join('\n   ')
    : `✅ verifyAdReadinessIngestSources: ${pass}/${pass} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
