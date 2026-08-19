#!/usr/bin/env node
'use strict';
//
// verifyGenerateProductTenancy — pins the cross-brand tenancy fix on
// POST /api/ads/generate + services/seededUniverseService.js.
//
// THE BUG (measured against prod 2026-08-19 via a Render one-off job; see
// session.md): POST /generate never asserted that the passed productIds
// belong to the campaign's brand. A stale cross-brand product picker could
// mint an Ad stamped with THIS campaign's brandId but ANOTHER brand's
// CatalogProduct. When no operator-picked mediaIds narrowed the seeded
// universe, buildSeededUniverse's product-mode catalog query filtered on
// `metadata.catalogProductId` alone (no brandId clause), so it happily
// resolved the OTHER brand's own correctly-tagged media too — a fully
// cross-branded, billable ad. Measured population: 26 ads across 7 distinct
// brand pairs, 2026-07-23..2026-08-11, 23 of the 26 carry a real billable
// CostLog receipt (atlas_video_render / direct_image), ~$17.54 total. Named
// example: Ad 6a7bae8abea2eb1ad6bd0f13 (brand "Pelagic Gear Test 2"), 100%
// "Marine Layer 2" content, rendered and billed ($0.90 Omni + 3 crop calls).
//
// THE FIX, two parts:
//   1. routes/ads.js — resolveOwnedProductIds(productIds, brandId), called
//      from POST /generate right after the campaign lookup. Drops any
//      productId not owned by the campaign's brand (warn, don't 400 the
//      whole request — same pattern as POST /campaigns/:id/products in
//      routes/campaigns.js) UNLESS EVERY requested id was unowned, in which
//      case it 400s (code 'products-not-owned') rather than silently
//      falling through with productIds:[] — which campaignAdsGenerationService
//      would read as "no product scope requested", the legitimate
//      media-library/brand-wide signal, and expand into a FULL BRAND-WIDE
//      run instead of an honest failure. That second failure mode (a scope
//      blowup layered on top of the tenant leak) is not hypothetical — it
//      is exactly what `useBrandOnly = productIds.length === 0 &&
//      mediaIds.length === 0` (campaignAdsGenerationService.js) does with
//      an empty productIds array, and it is why section C below insists on
//      driving the REAL route handler rather than only the extracted helper.
//   2. services/seededUniverseService.js — buildSeededUniverse's product-mode
//      catalogQuery gained a `brandId` clause. Defence in depth: a no-op for
//      a legitimate productId (its media already belongs to that brand), and
//      the thing that actually stops the leak when productId itself is
//      compromised.
//
// TECHNIQUE. Both functions live inside large files with heavy service
// dependencies (routes/ads.js pulls in ~40 services at require time). Rather
// than reimplementing their logic or scanning source text for what should be
// there, this harness:
//   A. Calls the REAL exported resolveOwnedProductIds
//      (routes/ads.js — module.exports.resolveOwnedProductIds) against a
//      FAITHFUL stub of CatalogProduct.find (monkey-patched on the real
//      model object — same technique as scripts/testAdRunSelection.js /
//      scripts/verifyCatalogFeedOrderSeeding.js) that actually filters by
//      the _id/brandId clauses in the query object it receives. A stub that
//      ignores brandId would make section A's cross-brand fixture pass
//      "owned" even on reverted code, which is precisely the class of bug
//      this harness exists to catch.
//   B. Calls the REAL exported buildSeededUniverse against a faithful
//      Media.find stub with a fixture pair: one Media doc that legitimately
//      belongs to the requested brand, and one Media doc stamped with the
//      SAME metadata.catalogProductId but a DIFFERENT brandId (modelling a
//      compromised/cross-brand productId reaching this function, which is
//      exactly the scenario /generate's own tenant check is supposed to have
//      already caught — this is the "defence in depth" arm).
//   C. Extracts the REAL POST /generate handler off the required Router's
//      internal `.stack` (Express registers routes as
//      `{route:{path,methods,stack:[{handle}]}}`) and CALLS it directly with
//      a synthetic req/res — no HTTP server needed. Campaign.findOne and
//      CatalogProduct.find are stubbed on the real model objects (as in A);
//      services/adReadinessService is pre-empted in require.cache (the
//      route lazily `require()`s it INSIDE the handler body, so seeding the
//      cache entry for its resolved absolute path before the handler runs
//      is enough — no need to reimplement or stub CampaignRun, the
//      generation gate, or anything downstream of the readiness check) to
//      return `{ready:false}`, so the handler always stops at a
//      deterministic 409 right after the tenant-check block. This proves
//      the WIRING — that the real route actually calls the real ownership
//      filter, in the real order, before any billable readiness/expansion
//      path is reached — not just that the extracted helper behaves
//      correctly in isolation.
//
// REVERT-PROVE (section E): three independent mutations on temp copies of
// the real files (written as siblings inside routes/ and services/ so their
// relative requires still resolve, then deleted), each of which must flip a
// SPECIFIC named check red:
//   M1 — drop `brandId` from resolveOwnedProductIds' CatalogProduct.find
//        query → the cross-brand fixture in section A is now wrongly
//        reported "owned".
//   M2 — drop the `if (!ownedIds.length) return res.status(400)...` guard →
//        an all-unowned request in section C no longer 400s; it falls
//        through to the readiness stub (409) with productIds:[], i.e. it
//        would have silently become a brand-wide run in production.
//   M3 — drop `brandId` from buildSeededUniverse's product-mode
//        catalogQuery → the cross-brand Media fixture in section B leaks
//        into the returned universe.
//
// Needs a real MongoDB? NO. Offline, no network, no API key — every model
// static method the code under test touches is monkey-patched on the real
// mongoose model object for the duration of this script and restored after.
//
//   node scripts/verifyGenerateProductTenancy.js
//
// This worktree's committed node_modules subset is missing https-proxy-agent
// (CLAUDE.md §4 — `npm install --no-save https-proxy-agent@5.0.1` fixes a
// worktree; this harness also falls back to a Module._load stub so it does
// not hard-fail in a worktree nobody has fixed yet).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through to a stub */ }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return { HttpsProxyAgent: function HttpsProxyAgent() { return {}; } };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}
const PROXY_MODE = ensureHttpsProxyAgent();

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 260)}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 260)}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────
const oid = (ch, n) => `68e9${String(ch).repeat(19)}${n}`; // 24-hex, ObjectId-shaped
const BRAND_A = oid('a', '1');   // the requesting campaign's own brand
const BRAND_B = oid('b', '2');   // a different tenant's brand
const CAMPAIGN_ID = oid('c', '3');
const P_OWNED   = oid('d', '4'); // CatalogProduct owned by BRAND_A
const P_UNOWNED = oid('e', '5'); // CatalogProduct owned by BRAND_B
const P_GHOST   = oid('f', '6'); // id that does not resolve to any CatalogProduct at all

const CATALOG_FIXTURE = [
  { _id: P_OWNED,   brandId: BRAND_A },
  { _id: P_UNOWNED, brandId: BRAND_B }
  // P_GHOST intentionally absent — models a deleted/never-existed product.
];

// A faithful CatalogProduct.find stub: actually applies the _id/$in AND
// brandId clauses from the filter object it receives, against a fixture
// table. This is the load-bearing property for M1's revert-proof — a stub
// that ignored brandId would report P_UNOWNED "owned" regardless of what
// the code under test asked for.
function installCatalogProductFindStub(CatalogProductModel, rows) {
  const original = CatalogProductModel.find;
  const calls = [];
  CatalogProductModel.find = (filter) => {
    calls.push(filter);
    const wantedIds = new Set((filter?._id?.$in || []).map(String));
    const wantedBrand = filter?.brandId != null ? String(filter.brandId) : undefined;
    const matched = rows.filter((r) =>
      wantedIds.has(String(r._id)) &&
      (wantedBrand === undefined || String(r.brandId) === wantedBrand)
    );
    return {
      select() { return this; },
      lean: async () => matched.map((r) => ({ _id: r._id, brandId: r.brandId }))
    };
  };
  return { calls, restore: () => { CatalogProductModel.find = original; } };
}

const CatalogProduct = require('../models/CatalogProduct');
const Campaign = require('../models/Campaign');
const Media = require('../models/Media');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');

// ═══════════════ A. resolveOwnedProductIds (routes/ads.js) ═══════════════
console.log('A. resolveOwnedProductIds — real function, faithful CatalogProduct.find stub');

const adsRouter = require('../routes/ads.js');

check('A0 module surface — resolveOwnedProductIds is exported as a function', () => {
  assert.strictEqual(typeof adsRouter.resolveOwnedProductIds, 'function');
});

async function withCatalogStub(rows, fn) {
  const stub = installCatalogProductFindStub(CatalogProduct, rows);
  try { return await fn(stub); }
  finally { stub.restore(); }
}

(async () => {
  await checkAsync('A1 mixed owned+unowned — owned kept, unowned dropped, order preserved', async () => {
    await withCatalogStub(CATALOG_FIXTURE, async () => {
      const { ownedIds, droppedIds } = await adsRouter.resolveOwnedProductIds(
        [P_UNOWNED, P_OWNED, P_GHOST], BRAND_A
      );
      assert.deepStrictEqual(ownedIds, [P_OWNED]);
      assert.deepStrictEqual(droppedIds, [P_UNOWNED, P_GHOST]);
    });
  });

  await checkAsync('A2 all-owned — nothing dropped', async () => {
    await withCatalogStub(CATALOG_FIXTURE, async () => {
      const { ownedIds, droppedIds } = await adsRouter.resolveOwnedProductIds([P_OWNED], BRAND_A);
      assert.deepStrictEqual(ownedIds, [P_OWNED]);
      assert.deepStrictEqual(droppedIds, []);
    });
  });

  await checkAsync('A3 all-unowned (cross-brand id) — everything dropped, nothing owned', async () => {
    await withCatalogStub(CATALOG_FIXTURE, async () => {
      const { ownedIds, droppedIds } = await adsRouter.resolveOwnedProductIds([P_UNOWNED], BRAND_A);
      assert.deepStrictEqual(ownedIds, []);
      assert.deepStrictEqual(droppedIds, [P_UNOWNED]);
    });
  });

  await checkAsync('A4 all-unowned (ghost id, no CatalogProduct at all) — dropped too, not an error', async () => {
    await withCatalogStub(CATALOG_FIXTURE, async () => {
      const { ownedIds, droppedIds } = await adsRouter.resolveOwnedProductIds([P_GHOST], BRAND_A);
      assert.deepStrictEqual(ownedIds, []);
      assert.deepStrictEqual(droppedIds, [P_GHOST]);
    });
  });

  await checkAsync('A5 empty productIds — no-op, CatalogProduct.find never called', async () => {
    await withCatalogStub(CATALOG_FIXTURE, async (stub) => {
      const result = await adsRouter.resolveOwnedProductIds([], BRAND_A);
      assert.deepStrictEqual(result, { ownedIds: [], droppedIds: [] });
      assert.strictEqual(stub.calls.length, 0, 'an empty productIds array must not reach the DB at all');
    });
  });

  await checkAsync('A6 the query sent to CatalogProduct.find actually carries brandId and the requested ids', async () => {
    await withCatalogStub(CATALOG_FIXTURE, async (stub) => {
      await adsRouter.resolveOwnedProductIds([P_OWNED, P_UNOWNED], BRAND_A);
      assert.strictEqual(stub.calls.length, 1);
      const filter = stub.calls[0];
      assert.strictEqual(String(filter.brandId), BRAND_A);
      assert.deepStrictEqual(
        (filter._id.$in || []).map(String).sort(),
        [P_OWNED, P_UNOWNED].sort()
      );
    });
  });

  // ═══════════════ B. buildSeededUniverse (seededUniverseService.js) ══════
  console.log('B. buildSeededUniverse product-mode catalogQuery — real function, faithful Media.find stub');

  const seededUniverse = require('../services/seededUniverseService.js');

  check('B0 module surface — buildSeededUniverse is exported as a function', () => {
    assert.strictEqual(typeof seededUniverse.buildSeededUniverse, 'function');
  });

  const PRODUCT_ID = oid('7', '7');
  const MEDIA_SAME_BRAND  = { _id: oid('8', '8'), source: 'catalog-product', fileUrl: 'https://x/1.jpg', fileType: 'image', brandId: BRAND_A, metadata: { catalogProductId: PRODUCT_ID }, classification: {} };
  const MEDIA_OTHER_BRAND = { _id: oid('9', '9'), source: 'catalog-product', fileUrl: 'https://x/2.jpg', fileType: 'image', brandId: BRAND_B, metadata: { catalogProductId: PRODUCT_ID }, classification: {} };

  // Faithful stub: applies source / brandId / metadata.catalogProductId from
  // whatever filter object buildSeededUniverse actually constructs. This is
  // what makes M3's revert-proof real — a stub that only matched on
  // catalogProductId (ignoring brandId) would let MEDIA_OTHER_BRAND through
  // regardless of whether the code under test passes brandId, which is
  // exactly the leak this fix closes.
  function installMediaFindStub(MediaModel, rows) {
    const original = MediaModel.find;
    const calls = [];
    MediaModel.find = (filter) => {
      calls.push(filter);
      const matched = rows.filter((r) => {
        if (filter.source !== undefined && r.source !== filter.source) return false;
        if (filter.brandId !== undefined && String(r.brandId) !== String(filter.brandId)) return false;
        const wantCpid = filter['metadata.catalogProductId'];
        if (wantCpid !== undefined && String(r.metadata?.catalogProductId || '') !== String(wantCpid)) return false;
        if (filter._id && filter._id.$in && !filter._id.$in.some((id) => String(id) === String(r._id))) return false;
        return true;
      });
      return {
        select() { return this; },
        limit() { return this; },
        lean: async () => matched.map((r) => ({ ...r }))
      };
    };
    return { calls, restore: () => { MediaModel.find = original; } };
  }

  async function withSeedFixture(rows, fn) {
    const mediaStub = installMediaFindStub(Media, rows);
    const originalFindById = CatalogProduct.findById;
    CatalogProduct.findById = () => ({
      select() { return this; },
      lean: async () => null // no matchedMedia / imageMediaId — keeps tier1/2 empty
    });
    // Brand-only mode (productId null) and includeBrandMatched both query
    // ProductMatchArtifact for tier-3 UGC. Not what this fix touches — stub
    // it to an empty result so those code paths don't hang on a real DB call
    // that doesn't exist in this offline harness.
    const originalPmaFind = ProductMatchArtifact.find;
    ProductMatchArtifact.find = () => ({
      select() { return this; },
      lean: async () => []
    });
    try { return await fn(mediaStub); }
    finally {
      mediaStub.restore();
      CatalogProduct.findById = originalFindById;
      ProductMatchArtifact.find = originalPmaFind;
    }
  }

  await checkAsync('B1 product-mode universe includes same-brand media', async () => {
    await withSeedFixture([MEDIA_SAME_BRAND, MEDIA_OTHER_BRAND], async () => {
      const { universe } = await seededUniverse.buildSeededUniverse(BRAND_A, PRODUCT_ID, {});
      const ids = universe.map((e) => e.mediaId);
      assert.ok(ids.includes(String(MEDIA_SAME_BRAND._id)), 'legitimate same-brand media must be in the pool');
    });
  });

  await checkAsync('B2 product-mode universe EXCLUDES a same-catalogProductId media stamped with another brand', async () => {
    await withSeedFixture([MEDIA_SAME_BRAND, MEDIA_OTHER_BRAND], async () => {
      const { universe } = await seededUniverse.buildSeededUniverse(BRAND_A, PRODUCT_ID, {});
      const ids = universe.map((e) => e.mediaId);
      assert.ok(!ids.includes(String(MEDIA_OTHER_BRAND._id)),
        'cross-brand media sharing the productId must NOT leak into the universe — this is the money bug');
    });
  });

  await checkAsync('B3 the query sent to Media.find in product mode actually carries brandId', async () => {
    await withSeedFixture([MEDIA_SAME_BRAND], async (mediaStub) => {
      await seededUniverse.buildSeededUniverse(BRAND_A, PRODUCT_ID, {});
      const catalogCall = mediaStub.calls.find((c) => c.source === 'catalog-product');
      assert.ok(catalogCall, 'expected a Media.find({source:"catalog-product", ...}) call');
      assert.strictEqual(String(catalogCall.brandId), BRAND_A);
      assert.strictEqual(String(catalogCall['metadata.catalogProductId']), PRODUCT_ID);
    });
  });

  await checkAsync('B4 brand-only mode (no productId) is unaffected — still scoped by brandId alone, no catalogProductId clause', async () => {
    await withSeedFixture([MEDIA_SAME_BRAND], async (mediaStub) => {
      await seededUniverse.buildSeededUniverse(BRAND_A, null, {});
      const catalogCall = mediaStub.calls.find((c) => c.source === 'catalog-product');
      assert.ok(catalogCall);
      assert.strictEqual(String(catalogCall.brandId), BRAND_A);
      assert.strictEqual(catalogCall['metadata.catalogProductId'], undefined,
        'brand-only mode must not gain a catalogProductId clause — this fix is product-mode only');
    });
  });

  // ═══════════════ C. POST /generate — real route handler, end to end ════
  console.log('C. POST /generate — real handler extracted off the Router, driven directly');

  function findGenerateHandler(router) {
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/generate' && l.route.methods && l.route.methods.post
    );
    if (!layer) throw new Error('POST /generate route not found on the ads router');
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  function fakeRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };
  }

  // Pre-empt services/adReadinessService in the require cache — the route
  // does `require('../services/adReadinessService')` INSIDE the handler
  // body on every call, so seeding the cache entry for its resolved
  // absolute path (same real path regardless of which relative specifier
  // resolves to it) intercepts that require without needing to touch the
  // module's own source or stub CampaignRun / the generation gate /
  // expandWizardJob. Every call short-circuits at a deterministic 409
  // immediately after the tenant-check block — proving the block ran, and
  // ran BEFORE anything billable, without needing the rest of the pipeline.
  const adReadinessPath = require.resolve('../services/adReadinessService');
  let readinessCalls = 0;
  const originalReadinessCache = require.cache[adReadinessPath];
  function installReadinessStub() {
    readinessCalls = 0;
    require.cache[adReadinessPath] = {
      id: adReadinessPath, filename: adReadinessPath, loaded: true,
      exports: {
        getAdReadiness: async () => {
          readinessCalls += 1;
          return { ready: false, reason: 'TEST_SHORT_CIRCUIT', blockers: [] };
        }
      }
    };
  }
  function restoreReadinessCache() {
    if (originalReadinessCache) require.cache[adReadinessPath] = originalReadinessCache;
    else delete require.cache[adReadinessPath];
  }

  async function driveGenerate(router, body) {
    const handle = findGenerateHandler(router);
    const req = { body, advertiserId: 'test-advertiser', user: { userId: 'test-user' } };
    const res = fakeRes();
    let nextErr;
    await handle(req, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
    return res;
  }

  async function withGenerateFixture(router, { campaignId, brandId, catalogRows }, fn) {
    installReadinessStub();
    const originalCampaignFindOne = Campaign.findOne;
    Campaign.findOne = () => ({
      select() { return this; },
      lean: async () => ({ _id: campaignId, brandId })
    });
    const catalogStub = installCatalogProductFindStub(CatalogProduct, catalogRows);
    try { return await fn(catalogStub); }
    finally {
      Campaign.findOne = originalCampaignFindOne;
      catalogStub.restore();
      restoreReadinessCache();
    }
  }

  await checkAsync('C1 all requested productIds unowned → 400 products-not-owned, readiness never reached (no billable path touched)', async () => {
    await withGenerateFixture(adsRouter, { campaignId: CAMPAIGN_ID, brandId: BRAND_A, catalogRows: CATALOG_FIXTURE }, async () => {
      const res = await driveGenerate(adsRouter, {
        campaignId: CAMPAIGN_ID, productIds: [P_UNOWNED], templateIds: ['ai_brand_led']
      });
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body?.code, 'products-not-owned');
      assert.deepStrictEqual(res.body?.droppedIds, [P_UNOWNED]);
      assert.strictEqual(readinessCalls, 0,
        'an all-unowned request must be refused BEFORE the readiness gate — nothing downstream should run');
    });
  });

  await checkAsync('C2 mixed owned+unowned → NOT blocked, proceeds to readiness with the owned id only', async () => {
    await withGenerateFixture(adsRouter, { campaignId: CAMPAIGN_ID, brandId: BRAND_A, catalogRows: CATALOG_FIXTURE }, async (catalogStub) => {
      const res = await driveGenerate(adsRouter, {
        campaignId: CAMPAIGN_ID, productIds: [P_OWNED, P_UNOWNED], templateIds: ['ai_brand_led']
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body?.error, 'TEST_SHORT_CIRCUIT');
      assert.strictEqual(readinessCalls, 1, 'a partially-owned request must reach the readiness gate, not be blocked');
      assert.strictEqual(catalogStub.calls.length, 1);
      assert.strictEqual(String(catalogStub.calls[0].brandId), BRAND_A);
    });
  });

  await checkAsync('C3 all-owned request → unaffected, proceeds to readiness, no drop warning path taken', async () => {
    await withGenerateFixture(adsRouter, { campaignId: CAMPAIGN_ID, brandId: BRAND_A, catalogRows: CATALOG_FIXTURE }, async () => {
      const res = await driveGenerate(adsRouter, {
        campaignId: CAMPAIGN_ID, productIds: [P_OWNED], templateIds: ['ai_brand_led']
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(readinessCalls, 1);
    });
  });

  await checkAsync('C4 empty productIds (legitimate media-library / brand-wide request) is untouched — CatalogProduct.find never called, still reaches readiness', async () => {
    await withGenerateFixture(adsRouter, { campaignId: CAMPAIGN_ID, brandId: BRAND_A, catalogRows: CATALOG_FIXTURE }, async (catalogStub) => {
      const res = await driveGenerate(adsRouter, {
        campaignId: CAMPAIGN_ID, productIds: [], templateIds: ['ai_brand_led']
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(readinessCalls, 1);
      assert.strictEqual(catalogStub.calls.length, 0,
        'the legitimate empty-productIds path must not touch CatalogProduct at all');
    });
  });

  await checkAsync('C5 unknown campaign → still 404s before the tenant check runs (pre-existing behaviour untouched)', async () => {
    installReadinessStub();
    const originalCampaignFindOne = Campaign.findOne;
    Campaign.findOne = () => ({ select() { return this; }, lean: async () => null });
    const catalogStub = installCatalogProductFindStub(CatalogProduct, CATALOG_FIXTURE);
    try {
      const res = await driveGenerate(adsRouter, {
        campaignId: CAMPAIGN_ID, productIds: [P_OWNED], templateIds: ['ai_brand_led']
      });
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(catalogStub.calls.length, 0, 'an unresolved campaign must never reach the ownership query');
    } finally {
      Campaign.findOne = originalCampaignFindOne;
      catalogStub.restore();
      restoreReadinessCache();
    }
  });

  // ═══════════════ D. wiring facts a call cannot see ══════════════════════
  // (source-scan, narrowly — the technique verifyGenerationGate.js reserves
  // for facts a pure/behavioural call cannot observe, e.g. registration
  // order and the actual reassignment statement.)
  console.log('D. source-wiring spot checks');

  const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');

  check('D1 resolveOwnedProductIds is defined once, above its only call site', () => {
    const defIdx = adsSrc.indexOf('async function resolveOwnedProductIds');
    const callIdx = adsSrc.indexOf('await resolveOwnedProductIds(');
    assert.ok(defIdx > 0 && callIdx > defIdx, `def@${defIdx} call@${callIdx}`);
    assert.strictEqual((adsSrc.match(/function resolveOwnedProductIds/g) || []).length, 1,
      'must be defined exactly once, not duplicated per caller');
  });

  check('D2 productIds is declared with `let`, not `const`, in POST /generate (the filtered set is reassigned)', () => {
    assert.ok(/let \{ productIds = \[\] \} = req\.body \|\| \{\};/.test(adsSrc));
  });

  check('D3 the 400 guard fires before productIds is reassigned to the owned set', () => {
    const block = adsSrc.slice(adsSrc.indexOf('if (productIds.length) {'), adsSrc.indexOf("getAdReadiness = require"));
    const guardIdx = block.indexOf("code: 'products-not-owned'");
    const reassignIdx = block.indexOf('productIds = ownedIds;');
    assert.ok(guardIdx > 0 && reassignIdx > guardIdx, `guard@${guardIdx} reassign@${reassignIdx}`);
  });

  const seedSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'seededUniverseService.js'), 'utf8');
  check('D4 product-mode catalogQuery literal carries brandId (source anchor, belt-and-braces on top of B3)', () => {
    assert.ok(
      /: \{ source: 'catalog-product', brandId, 'metadata\.catalogProductId': productOid \}/.test(seedSrc),
      'expected the exact product-mode catalogQuery branch to include a bare `brandId` clause'
    );
  });

  // ═══════════════ E. REVERT-PROVE ═════════════════════════════════════════
  console.log('E. revert-prove — mutate temp copies of the real files, confirm the right check goes red');

  const REVERT_ROWS = [];

  // Writes `mutatedSrc` as a SIBLING of `realAbsPath` (same directory, so its
  // relative `require('../models/...')` etc. resolve identically), requires
  // it fresh, runs `fn(mutatedModuleExports)`, then deletes the temp file —
  // always, even on throw.
  async function withMutatedSibling(realAbsPath, mutatedSrc, fn) {
    const dir = path.dirname(realAbsPath);
    const base = path.basename(realAbsPath, '.js');
    const tmpAbsPath = path.join(dir, `.__revertprove_${base}_${process.pid}_${Date.now()}.js`);
    fs.writeFileSync(tmpAbsPath, mutatedSrc);
    try {
      delete require.cache[tmpAbsPath];
      const mod = require(tmpAbsPath);
      return await fn(mod, tmpAbsPath);
    } finally {
      try { fs.unlinkSync(tmpAbsPath); } catch { /* best effort */ }
      delete require.cache[tmpAbsPath];
    }
  }

  function mutateOrThrow(src, from, to, label) {
    const mutated = src.replace(from, to);
    if (mutated === src) throw new Error(`revert-prove mutation ${label} was a no-op — pattern missed the real source`);
    return mutated;
  }

  const adsAbsPath = path.join(__dirname, '..', 'routes', 'ads.js');
  const seedAbsPath = path.join(__dirname, '..', 'services', 'seededUniverseService.js');

  // M1 — drop the brandId clause from resolveOwnedProductIds' query.
  await checkAsync('E-M1 dropping brandId from resolveOwnedProductIds\' query makes a cross-brand id look "owned" (must fail)', async () => {
    const mutated = mutateOrThrow(
      adsSrc,
      "const ownedProducts = await CatalogProduct.find({\n    _id: { $in: productIds },\n    brandId\n  }).select('_id').lean();",
      "const ownedProducts = await CatalogProduct.find({\n    _id: { $in: productIds }\n  }).select('_id').lean();",
      'M1'
    );
    await withMutatedSibling(adsAbsPath, mutated, async (mutatedRouter) => {
      await withCatalogStub(CATALOG_FIXTURE, async () => {
        const { ownedIds } = await mutatedRouter.resolveOwnedProductIds([P_UNOWNED], BRAND_A);
        // With the fix reverted, the faithful stub (which honours whatever
        // filter it is GIVEN) sees no brandId clause and returns P_UNOWNED
        // as a match on _id alone — i.e. the mutation must make this ASSERT
        // FAIL. We invert that here: a passing assert.notStrictEqual proves
        // the mutation reproduced the bug; if the mutation somehow did NOT
        // reproduce it, this next line throws and the revert-prove claim
        // for M1 is correctly reported as broken.
        assert.deepStrictEqual(ownedIds, [P_UNOWNED],
          'expected the REVERTED code to wrongly treat the cross-brand id as owned');
        REVERT_ROWS.push('M1 — dropping brandId from resolveOwnedProductIds reproduced the tenant leak');
      });
    });
  });

  // M2 — drop the all-unowned 400 guard.
  await checkAsync('E-M2 dropping the all-unowned 400 guard silently falls through with productIds:[] (must fail)', async () => {
    const mutated = mutateOrThrow(
      adsSrc,
      `      if (!ownedIds.length) {
        return res.status(400).json({
          error: 'none of the requested productIds belong to this campaign\\'s brand',
          code: 'products-not-owned',
          droppedIds
        });
      }
      productIds = ownedIds;`,
      `      productIds = ownedIds;`,
      'M2'
    );
    await withMutatedSibling(adsAbsPath, mutated, async (mutatedRouter) => {
      installReadinessStub();
      const originalCampaignFindOne = Campaign.findOne;
      Campaign.findOne = () => ({
        select() { return this; },
        lean: async () => ({ _id: CAMPAIGN_ID, brandId: BRAND_A })
      });
      const catalogStub = installCatalogProductFindStub(CatalogProduct, CATALOG_FIXTURE);
      try {
        const res = await driveGenerate(mutatedRouter, {
          campaignId: CAMPAIGN_ID, productIds: [P_UNOWNED], templateIds: ['ai_brand_led']
        });
        // With the guard reverted, an all-unowned request must NOT 400 —
        // it silently proceeds (here observed as reaching the readiness
        // stub, 409, instead of the 400 the fixed code returns).
        assert.strictEqual(res.statusCode, 409,
          'expected the REVERTED code to silently fall through instead of 400-ing an all-unowned request');
        assert.strictEqual(readinessCalls, 1);
        REVERT_ROWS.push('M2 — dropping the all-unowned 400 guard reproduced the silent scope-blowup fallthrough');
      } finally {
        Campaign.findOne = originalCampaignFindOne;
        catalogStub.restore();
        restoreReadinessCache();
      }
    });
  });

  // M3 — drop brandId from buildSeededUniverse's product-mode catalogQuery.
  await checkAsync('E-M3 dropping brandId from buildSeededUniverse\'s catalogQuery leaks cross-brand media (must fail)', async () => {
    const mutated = mutateOrThrow(
      seedSrc,
      ": { source: 'catalog-product', brandId, 'metadata.catalogProductId': productOid };",
      ": { source: 'catalog-product', 'metadata.catalogProductId': productOid };",
      'M3'
    );
    await withMutatedSibling(seedAbsPath, mutated, async (mutatedSeeded) => {
      await withSeedFixture([MEDIA_SAME_BRAND, MEDIA_OTHER_BRAND], async () => {
        const { universe } = await mutatedSeeded.buildSeededUniverse(BRAND_A, PRODUCT_ID, {});
        const ids = universe.map((e) => e.mediaId);
        assert.ok(ids.includes(String(MEDIA_OTHER_BRAND._id)),
          'expected the REVERTED code to leak the cross-brand media into the universe');
        REVERT_ROWS.push('M3 — dropping brandId from buildSeededUniverse\'s catalogQuery reproduced the media leak');
      });
    });
  });

  check('E table recorded 3 revert-prove mutations, all reproducing their bug', () => {
    assert.strictEqual(REVERT_ROWS.length, 3);
  });

  // ── report ──────────────────────────────────────────────────────────────
  console.log('\nrevert-prove table');
  for (const row of REVERT_ROWS) console.log(`  ✓ ${row}`);
  console.log(`\nharness loaded https-proxy-agent via: ${PROXY_MODE}`);
  const total = pass + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyGenerateProductTenancy: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyGenerateProductTenancy: ${total}/${total} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error('verifyGenerateProductTenancy: harness crashed', err && err.stack || err);
  process.exit(1);
});
