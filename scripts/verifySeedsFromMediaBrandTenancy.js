#!/usr/bin/env node
'use strict';
//
// verifySeedsFromMediaBrandTenancy — pins the brandId-scoping fix on
// services/campaignAdsGenerationService.js's seedsFromMedia (and the new
// ownedCatalogProductIdSet helper it now filters catalog FKs through).
//
// THE BUG. POST /generate's `productIds` are ownership-checked via
// resolveOwnedProductIds (routes/ads.js — drop unowned, 400 when none
// remain). `mediaIds` has NO equivalent check anywhere on the path to
// here: the route never asserts a single mediaId belongs to the
// campaign's brand, and expandWizardJob's sibling detect-prep query
// (PR #257) only *reads* brand-scoped — it does not narrow the array
// this loop iterates. seedsFromMedia then did `Media.findById(mediaId)`
// with no brandId clause, loaded a FOREIGN brand's Media row wholesale,
// and minted seeds carrying that brand's imagery plus whatever
// `matchedProducts[].catalogProductId` the row happened to hold.
//
// Scoping the Media read is necessary but NOT sufficient. An own-brand
// Media row can still hold a foreign catalogProductId:
//   · a pre-PR-#271 operator attach (that fix is forward-only — "does
//     not remediate any pre-existing cross-brand row"), which hardcodes
//     outcome:'product_match', the exact value Case 1 selects on;
//   · the keeper-repoint paths, whose Media.updateMany selects purely
//     on `matchedProducts.catalogProductId` with no brand clause
//     (catalogRetroLinkService.reparentAllRefs,
//     catalogProductPromoteService).
// Unlike buildSeededUniverse — which only uses matchedProducts as a
// FILTER against an already-ownership-checked productId — this function
// uses matchedProducts as the SOURCE of the productId, so there is
// nothing downstream to catch a foreign FK.
//
// REACHABILITY — do not overstate this. seedsFromMedia sits on the
// LEGACY CARTESIAN path. expandWizardJob reaches it only when
// `AI_CONCEPT_DRIVEN` is false/unset (`config/defaults.env` ships
// `true`, loaded by dotenv without override, so the effective prod
// default is ON) AND the run is image-only / single-format (the
// conceptImage branch also fires on mixed image+video and on
// multi-format static, both of which return before this function
// runs). This is a latent / defense-in-depth hole, not a live money
// leak on the shipped default. The hole is still real: flipping the
// flag off, or any future caller of the now-exported function, would
// mint cross-brand seeds. Same shape as PR #245 / #257, same fail-
// closed idiom.
//
// THE FIX, four parts:
//   1. `if (!brandId) return [];` — fail closed, no query. PR #257
//      ensureDetectForProducts / mediaAssignmentService.assertProductOwned
//      idiom. Deliberately not `...(brandId ? { brandId } : {})`.
//   2. `Media.findById(mediaId)` → `Media.findOne({ _id: mediaId, brandId })`.
//   3. NEW helper `ownedCatalogProductIdSet(ids, brandId)` (also fails
//      closed on falsy brandId, runs CatalogProduct.find({_id:{$in:oids},
//      brandId}).select('_id').lean()). BOTH the
//      `opts.campaignKind === 'brand'` short-circuit and the Case-1
//      `trueProductMatches` path now read `ownedMatchedProducts` instead
//      of `media.matchedProducts`.
//   4. The Tier-0 alt-expansion `Media.find({source:'catalog-product',
//      brandId, 'metadata.catalogProductId': productOid})` gained the
//      brandId clause (the guarantee PR #245 added to the same query
//      shape in seededUniverseService). Redundant for an owned
//      productId — and that is the point: it only bites if a foreign
//      id, or a same-productId catalog-media row stamped with another
//      brand, ever reaches this loop again.
//
// TECHNIQUE. Closest sibling is scripts/verifyDetectPrepMediaTenancy.js;
// the faithful-stub convention is scripts/verifyGenerateProductTenancy.js's
// installCatalogProductFindStub (also scripts/verifyMediaAssignmentBrandTenancy.js).
// Call the REAL exported seedsFromMedia / ownedCatalogProductIdSet against
// monkey-patched Media / CatalogProduct model statics (patch on the real
// mongoose model object, restore in a `finally`). The stubs actually APPLY
// the clauses they receive (`_id`, `brandId`, `source`,
// `metadata.catalogProductId`, `$in`, `$ne`) against a fixture table — a
// stub that ignored brandId would report a foreign row reachable no
// matter what the code asked for, defeating the whole test. Structural
// source checks only SUPPLEMENT this (the revert-prove anchors); they
// do not replace it. A source-text assertion would pass against any
// reimplementation that merely kept the name.
//
// REVERT-PROVE (section C). Four mutations on a TEMP SIBLING copy of
// the service file (`services/__tmp_revert_seedsfrommedia.js`, same
// directory so its relative `require('../models/...')` calls keep
// resolving — verifyDetectPrepMediaTenancy.js section C). Each mutation
// anchors on exact current text and THROWS "text has drifted, update
// the anchor" if the anchor is not found — never silently no-op.
//   M1 — drop `if (!brandId) return [];` → the fail-closed "zero
//        queries" check goes red (Media.findOne now runs). This does
//        NOT by itself leak a branded foreign row: findOne still
//        carries `{ _id, brandId }` and a falsy brandId matches
//        nothing against a real brandId. The observable is the query,
//        not a data leak — asserting a leak here would be untrue.
//   M2 — `findOne({_id, brandId})` → `findById` → a foreign-brand
//        mediaId now loads. Product FKs are still filtered by M3, so
//        the leak is the FOREIGN MEDIA on the seed (imagery), which
//        then degrades to the brand/category tier of the REQUESTING
//        brand. Independently observable without M3.
//   M3 — both consumers read `media.matchedProducts` again → an
//        own-brand Media carrying a foreign catalogProductId with
//        outcome:'product_match' now emits a cross-brand product seed.
//   M4 — drop `brandId` from the Tier-0 Media.find → a same-
//        catalogProductId catalog-media row stamped with another
//        brandId leaks in as a product_image seed. Independently
//        observable on an OWNED product (the PR #245 shape). It is
//        NOT independently observable as a guard against a foreign
//        productId reaching the loop — that path is already blocked
//        by ownedMatchedProducts (M3). We pin the former.
//
// Needs a real MongoDB? NO. Offline, no network. Every model static
// method touched is monkey-patched on the real mongoose model object
// for the duration of this script and restored after.
//
//   node scripts/verifySeedsFromMediaBrandTenancy.js
//
// This worktree's committed node_modules subset can be missing
// https-proxy-agent (CLAUDE.md §4) — same fallback stub as the sibling
// tenancy harnesses so this doesn't hard-fail in an unfixed worktree.

const fs = require('fs');
const path = require('path');
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy value');
}

const ROOT = path.join(__dirname, '..');

// ── fixtures (24-hex, ObjectId-shaped, same idiom as the sibling harnesses) ─
const oid = (ch, n) => `68f0${String(ch).repeat(19)}${n}`;
const BRAND_A = oid('a', '1');
const BRAND_B = oid('b', '2');
const CAT_A   = oid('7', '7');

const P_OWNED       = oid('c', '3'); // CatalogProduct brand A (also in CAT_A)
const P_OWNED_OTHER = oid('c', '4'); // CatalogProduct brand A, different category
const P_FOREIGN     = oid('d', '5'); // CatalogProduct brand B

const MEDIA_A           = oid('1', '1'); // brand A, owned product_match — the happy path
const MEDIA_B           = oid('2', '2'); // brand B — foreign mediaId
const MEDIA_A_KEEPER    = oid('1', '3'); // brand A, FOREIGN catalogProductId, product_match
                                        // (legacy-attach / keeper-repoint shape)
const MEDIA_A_MIXED     = oid('1', '4'); // brand A, owned + foreign product_match
const MEDIA_CAT_A       = oid('3', '1'); // brand A, catalog-product of P_OWNED
const MEDIA_CAT_B       = oid('3', '2'); // brand B, catalog-product ALSO tagged P_OWNED
                                        // (the PR #245 same-productId / other-brand shape)
const MEDIA_CAT_FOREIGN = oid('3', '3'); // brand B, catalog-product of P_FOREIGN

const CATALOG_ROWS = [
  { _id: P_OWNED,       brandId: BRAND_A, categoryRef: CAT_A, matchedMedia: [{}, {}, {}] },
  { _id: P_OWNED_OTHER, brandId: BRAND_A, matchedMedia: [{}] },
  { _id: P_FOREIGN,     brandId: BRAND_B, categoryRef: CAT_A, matchedMedia: [{}, {}] }
];

const MEDIA_ROWS = [
  {
    _id: MEDIA_A, brandId: BRAND_A, source: 'instagram', fileType: 'image',
    matchedProducts: [{ catalogProductId: P_OWNED, outcome: 'product_match' }],
    matchedCategories: [],
    adSuitability: { score: 0.8 }, classification: { shotType: 'lifestyle' }
  },
  {
    _id: MEDIA_B, brandId: BRAND_B, source: 'instagram', fileType: 'image',
    matchedProducts: [{ catalogProductId: P_FOREIGN, outcome: 'product_match' }],
    matchedCategories: [],
    adSuitability: { score: 0.9 }, classification: { shotType: 'lifestyle' }
  },
  {
    _id: MEDIA_A_KEEPER, brandId: BRAND_A, source: 'instagram', fileType: 'image',
    matchedProducts: [{ catalogProductId: P_FOREIGN, outcome: 'product_match' }],
    matchedCategories: [{ categoryId: CAT_A }],
    adSuitability: { score: 0.7 }, classification: { shotType: 'on_model' }
  },
  {
    _id: MEDIA_A_MIXED, brandId: BRAND_A, source: 'instagram', fileType: 'image',
    matchedProducts: [
      { catalogProductId: P_OWNED,   outcome: 'product_match' },
      { catalogProductId: P_FOREIGN, outcome: 'product_match' }
    ],
    matchedCategories: [],
    adSuitability: { score: 0.75 }, classification: { shotType: 'lifestyle' }
  },
  {
    _id: MEDIA_CAT_A, brandId: BRAND_A, source: 'catalog-product', fileType: 'image',
    metadata: { catalogProductId: P_OWNED, imageRole: 'hero' },
    adSuitability: { score: 0.5 }, classification: { shotType: 'product_only' }
  },
  {
    _id: MEDIA_CAT_B, brandId: BRAND_B, source: 'catalog-product', fileType: 'image',
    metadata: { catalogProductId: P_OWNED, imageRole: 'alt' },
    adSuitability: { score: 0.5 }, classification: { shotType: 'product_only' }
  },
  {
    _id: MEDIA_CAT_FOREIGN, brandId: BRAND_B, source: 'catalog-product', fileType: 'image',
    metadata: { catalogProductId: P_FOREIGN, imageRole: 'hero' },
    adSuitability: { score: 0.5 }, classification: { shotType: 'product_only' }
  }
];

// A filter matcher that APPLIES every key present in the filter object
// (including `$in`, `$ne`, and dotted paths like `metadata.catalogProductId`)
// against a fixture row. This is the load-bearing property shared with
// installCatalogProductFindStub in scripts/verifyGenerateProductTenancy.js
// and scripts/verifyDetectPrepMediaTenancy.js: if the code under test stops
// including a `brandId` key, this matcher stops checking it too — exactly
// mirroring what a real Mongo query would do, so a regression is visible
// through BEHAVIOUR, not asserted by fiat.
function getPath(row, key) {
  if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  if (key.includes('.')) {
    return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), row);
  }
  return row ? row[key] : undefined;
}
function valueEquals(actual, want) {
  if (actual === want) return true;
  if (actual == null || want == null) return actual === want;
  return String(actual) === String(want);
}
function rowMatchesFilter(row, filter) {
  for (const key of Object.keys(filter || {})) {
    const want = filter[key];
    const actual = getPath(row, key);
    if (want && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
      if (Array.isArray(want.$in)) {
        const set = new Set(want.$in.map(String));
        if (!set.has(String(actual))) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(want, '$ne')) {
        if (valueEquals(actual, want.$ne)) return false;
        continue;
      }
    }
    if (!valueEquals(actual, want)) return false;
  }
  return true;
}
function matchAll(rows, filter) {
  return rows.filter((row) => rowMatchesFilter(row, filter));
}
function matchOne(rows, filter) {
  return matchAll(rows, filter)[0] || null;
}

function chainOne(row) {
  const copy = row ? { ...row, metadata: row.metadata ? { ...row.metadata } : undefined,
    matchedProducts: row.matchedProducts ? row.matchedProducts.map((mp) => ({ ...mp })) : row.matchedProducts,
    matchedCategories: row.matchedCategories ? row.matchedCategories.map((mc) => ({ ...mc })) : row.matchedCategories
  } : null;
  const chain = {
    select() { return chain; },
    lean() { return Promise.resolve(copy); }
  };
  return chain;
}
function chainMany(rows) {
  const copies = rows.map((row) => ({
    ...row,
    metadata: row.metadata ? { ...row.metadata } : undefined,
    matchedProducts: row.matchedProducts ? row.matchedProducts.map((mp) => ({ ...mp })) : row.matchedProducts,
    matchedCategories: row.matchedCategories ? row.matchedCategories.map((mc) => ({ ...mc })) : row.matchedCategories
  }));
  const chain = {
    select() { return chain; },
    lean() { return Promise.resolve(copies); }
  };
  return chain;
}

function installStubs(MediaModel, CatalogProductModel) {
  const original = {
    findOne:   MediaModel.findOne,
    find:      MediaModel.find,
    findById:  MediaModel.findById,
    cpFind:    CatalogProductModel.find,
    cpFindOne: CatalogProductModel.findOne
  };
  const calls = { findOne: [], find: [], findById: [], catalogFind: [] };

  MediaModel.findOne = (filter) => {
    calls.findOne.push(filter);
    return chainOne(matchOne(MEDIA_ROWS, filter));
  };
  MediaModel.find = (filter) => {
    calls.find.push(filter);
    return chainMany(matchAll(MEDIA_ROWS, filter));
  };
  // findById is _id-only by contract (mongoose Model.findById →
  // this.findOne({ _id: id })). Installed explicitly so M2's mutation
  // to findById is a faithful unscoped lookup even if a future mongoose
  // no longer routes through the patched findOne.
  MediaModel.findById = (id) => {
    calls.findById.push(id);
    const row = MEDIA_ROWS.find((r) => String(r._id) === String(id)) || null;
    return chainOne(row);
  };
  CatalogProductModel.find = (filter) => {
    calls.catalogFind.push(filter);
    return chainMany(matchAll(CATALOG_ROWS, filter));
  };

  function reset() {
    calls.findOne.length = 0;
    calls.find.length = 0;
    calls.findById.length = 0;
    calls.catalogFind.length = 0;
  }
  function queryCount() {
    return calls.findOne.length + calls.find.length + calls.findById.length + calls.catalogFind.length;
  }
  function restore() {
    MediaModel.findOne = original.findOne;
    MediaModel.find = original.find;
    MediaModel.findById = original.findById;
    CatalogProductModel.find = original.cpFind;
    CatalogProductModel.findOne = original.cpFindOne;
  }
  return { calls, reset, queryCount, restore };
}

function seedProductIds(seeds) {
  return (seeds || []).map((s) => s.productId == null ? null : String(s.productId));
}
function productImageMediaIds(seeds) {
  return (seeds || [])
    .filter((s) => s.variantKind === 'product_image')
    .map((s) => String(s.mediaId));
}
function ugcSeeds(seeds) {
  return (seeds || []).filter((s) => s.variantKind === 'ugc' || s.variantKind == null);
}

async function run() {
  console.log(`verifySeedsFromMediaBrandTenancy — https-proxy-agent: ${PROXY_MODE}\n`);

  const Media = require('../models/Media');
  const CatalogProduct = require('../models/CatalogProduct');
  const svc = require('../services/campaignAdsGenerationService');

  check('0. module surface: seedsFromMedia and ownedCatalogProductIdSet are exported functions', () => {
    if (typeof svc.seedsFromMedia !== 'function') throw new Error('seedsFromMedia not exported / not a function');
    if (typeof svc.ownedCatalogProductIdSet !== 'function') throw new Error('ownedCatalogProductIdSet not exported / not a function');
  });

  const stub = installStubs(Media, CatalogProduct);
  try {
    // ── Section A — seedsFromMedia, behavioural ─────────────────────────
    console.log('A. seedsFromMedia scopes the Media read AND the catalog FKs by brandId');

    await checkAsync('A1. [THE FIX] foreign-brand mediaId → [] (Media row belongs to brand B)', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_B);
      assertEqual(seeds.length, 0, 'foreign media must not produce any seed');
      assertTrue(stub.calls.findOne.length >= 1, 'expected a Media.findOne for the scoped lookup');
      const filter = stub.calls.findOne[0];
      assertTrue(filter && Object.prototype.hasOwnProperty.call(filter, 'brandId'),
        'Media.findOne must carry a brandId key — this is the findById → findOne half of the fix');
      assertEqual(String(filter.brandId), BRAND_A, 'Media.findOne brandId');
      assertEqual(String(filter._id), MEDIA_B, 'Media.findOne _id');
    });

    await checkAsync('A2. own-brand media, all matchedProducts owned → seeds emitted as before (regression guard)', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_A);
      assertTrue(seeds.length >= 1, `expected at least the ugc seed, got ${seeds.length}`);
      const ugc = ugcSeeds(seeds);
      assertEqual(ugc.length, 1, 'exactly one ugc seed for a single product_match');
      assertEqual(String(ugc[0].mediaId), MEDIA_A, 'ugc mediaId');
      assertEqual(String(ugc[0].productId), P_OWNED, 'ugc productId');
      assertEqual(ugc[0].matchTier, 'product_match', 'ugc matchTier');
      assertEqual(ugc[0].variantKind, 'ugc', 'ugc variantKind');
      const imgIds = productImageMediaIds(seeds);
      assertTrue(imgIds.includes(MEDIA_CAT_A),
        'owned catalog-product media of P_OWNED must still expand as product_image — the fix is a no-op in the correct case');
      assertTrue(!imgIds.includes(MEDIA_CAT_B),
        'same-catalogProductId catalog media stamped with brand B must NOT appear (Tier-0 brandId clause)');
      assertTrue(!seedProductIds(seeds).includes(P_FOREIGN), 'no seed may carry the foreign productId');
    });

    await checkAsync('A3. own-brand media carrying a FOREIGN catalogProductId (outcome:product_match) → no seed carries that productId; degrades to category/brand tier', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_A_KEEPER);
      assertTrue(!seedProductIds(seeds).includes(P_FOREIGN),
        'the keeper-repoint / pre-#271 foreign FK must not become a seed productId');
      assertTrue(seeds.length >= 1, 'degrading must still emit a brand-safe seed, not empty-out the pick');
      const ugc = ugcSeeds(seeds);
      assertTrue(ugc.length >= 1, 'expected a ugc seed on the degraded path');
      assertEqual(String(ugc[0].mediaId), MEDIA_A_KEEPER, 'degraded seed still uses the operator-picked (own-brand) media');
      assertEqual(String(ugc[0].productId), P_OWNED,
        'category-tier fallback must resolve an OWNED product in the matched category, not the foreign FK');
      assertEqual(ugc[0].matchTier, 'product_category',
        'matchedCategories is populated, so Case 2 (product_category) is the honest degradation — not Case 1 product_match and not a silent empty');
      assertTrue(!seedProductIds(seeds).includes(P_OWNED_OTHER),
        'Case 2 must not widen to every owned product (P_OWNED_OTHER is brand A but not in CAT_A)');
    });

    await checkAsync('A4. same foreign-FK media, opts.campaignKind==="brand" → brand_only (productId:null), not a cross-brand product seed', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_A_KEEPER, { campaignKind: 'brand' });
      assertEqual(seeds.length, 1, 'brand-campaign short-circuit emits exactly one seed');
      assertEqual(seeds[0].productId, null, 'every match is foreign → degrade to brand_only, not stamp the foreign FK');
      assertEqual(seeds[0].matchTier, 'brand_only', 'matchTier');
      assertEqual(String(seeds[0].mediaId), MEDIA_A_KEEPER, 'mediaId stays the operator pick');
      assertEqual(seeds[0].variantKind, 'ugc', 'variantKind');
    });

    for (const [label, brand] of [['null', null], ["''", ''], ['undefined', undefined]]) {
      await checkAsync(`A5. [FAIL-CLOSED] brandId=${label} → [] AND zero queries (no lookup at all, PR #257)`, async () => {
        stub.reset();
        const seeds = await svc.seedsFromMedia(brand, MEDIA_A);
        assertEqual(Array.isArray(seeds) ? seeds.length : -1, 0, 'falsy brandId must return []');
        assertEqual(stub.queryCount(), 0,
          `fail-closed means no lookup at all; ran findOne=${stub.calls.findOne.length} find=${stub.calls.find.length} findById=${stub.calls.findById.length} catalogFind=${stub.calls.catalogFind.length}`);
      });
    }

    await checkAsync('A6. Tier-0 alt expansion: product_image seeds only ever come from catalog media whose brandId matches', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_A);
      const imgIds = productImageMediaIds(seeds);
      assertTrue(imgIds.length >= 1, 'happy-path Case 1 must still expand catalog alts');
      assertTrue(imgIds.every((id) => id === MEDIA_CAT_A),
        `product_image mediaIds must be brand-A catalog media only, got ${JSON.stringify(imgIds)}`);
      assertTrue(!imgIds.includes(MEDIA_CAT_B), 'MEDIA_CAT_B is brand B with the same catalogProductId — the leak M4 re-opens');
      assertTrue(!imgIds.includes(MEDIA_CAT_FOREIGN), 'catalog media of a foreign product must not appear either');
      const catalogCalls = stub.calls.find.filter((f) => f && f.source === 'catalog-product');
      assertTrue(catalogCalls.length >= 1, 'expected a Media.find({source:"catalog-product", ...}) for Tier-0');
      assertTrue(catalogCalls.every((f) => Object.prototype.hasOwnProperty.call(f, 'brandId') && String(f.brandId) === BRAND_A),
        'every Tier-0 Media.find must carry brandId=BRAND_A');
    });

    await checkAsync('A7. mixed owned+foreign matchedProducts keeps the owned seed and drops the foreign one', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_A_MIXED);
      const products = seedProductIds(seeds);
      assertTrue(products.includes(P_OWNED), 'owned product_match must still emit');
      assertTrue(!products.includes(P_FOREIGN), 'foreign sibling on the same Media row must be dropped');
      const ugc = ugcSeeds(seeds);
      assertEqual(ugc.length, 1, 'one owned product_match → one ugc seed (the foreign entry is not a second seed)');
      assertEqual(String(ugc[0].productId), P_OWNED, 'ugc productId is the owned one');
    });

    await checkAsync('A8. campaignKind==="brand" with an owned product_match still attaches that product (regression guard on the short-circuit)', async () => {
      stub.reset();
      const seeds = await svc.seedsFromMedia(BRAND_A, MEDIA_A, { campaignKind: 'brand' });
      assertEqual(seeds.length, 1, 'brand short-circuit is one seed');
      assertEqual(String(seeds[0].productId), P_OWNED, 'owned product_match still wins the short-circuit');
      assertEqual(seeds[0].matchTier, 'product_match', 'matchTier');
    });

    // ── Section B — ownedCatalogProductIdSet, directly ───────────────────
    console.log('\nB. ownedCatalogProductIdSet returns the owned subset and fails closed');

    await checkAsync('B1. mixed owned+foreign ids, brandId=BRAND_A → Set of the owned id only', async () => {
      stub.reset();
      const owned = await svc.ownedCatalogProductIdSet([P_OWNED, P_FOREIGN, P_OWNED_OTHER], BRAND_A);
      assertTrue(owned instanceof Set, 'must return a Set');
      assertEqual(owned.size, 2, 'two owned ids (P_OWNED + P_OWNED_OTHER), foreign dropped');
      assertTrue(owned.has(String(P_OWNED)), 'P_OWNED');
      assertTrue(owned.has(String(P_OWNED_OTHER)), 'P_OWNED_OTHER');
      assertTrue(!owned.has(String(P_FOREIGN)), 'P_FOREIGN must not be in the owned set');
      assertEqual(stub.calls.catalogFind.length, 1, 'one CatalogProduct.find');
      const filter = stub.calls.catalogFind[0];
      assertTrue(filter && Object.prototype.hasOwnProperty.call(filter, 'brandId'),
        'CatalogProduct.find must carry brandId — the fail-open `...(brandId ? { brandId } : {})` shape is the one #257 removed');
      assertEqual(String(filter.brandId), BRAND_A, 'brandId');
      assertTrue(filter._id && Array.isArray(filter._id.$in), 'expected { _id: { $in: oids } }');
    });

    for (const [label, brand] of [['null', null], ["''", ''], ['undefined', undefined]]) {
      await checkAsync(`B2. [FAIL-CLOSED] ownedCatalogProductIdSet(..., brandId=${label}) → empty Set, zero queries`, async () => {
        stub.reset();
        const owned = await svc.ownedCatalogProductIdSet([P_OWNED, P_FOREIGN], brand);
        assertTrue(owned instanceof Set, 'must return a Set even on the fail-closed path');
        assertEqual(owned.size, 0, 'falsy brandId → empty Set');
        assertEqual(stub.calls.catalogFind.length, 0,
          'fail-closed means no CatalogProduct.find at all (not a query with a missing brandId clause)');
      });
    }

    await checkAsync('B3. empty / all-falsy ids with a real brandId → empty Set, zero queries (nothing to look up)', async () => {
      stub.reset();
      const owned = await svc.ownedCatalogProductIdSet([], BRAND_A);
      assertEqual(owned.size, 0, 'empty input');
      assertEqual(stub.calls.catalogFind.length, 0, 'no query for an empty id list');
      stub.reset();
      const owned2 = await svc.ownedCatalogProductIdSet([null, undefined, ''], BRAND_A);
      assertEqual(owned2.size, 0, 'all-falsy ids filter to nothing before the query');
      assertEqual(stub.calls.catalogFind.length, 0, 'no query when every id is dropped pre-cast');
    });
  } finally {
    stub.restore();
  }

  // ── Section C — revert-prove ──────────────────────────────────────────
  console.log('\nC. Revert-prove: each mutation flips its target check red');
  const genPath = path.join(ROOT, 'services', 'campaignAdsGenerationService.js');
  const tmpPath = path.join(ROOT, 'services', '__tmp_revert_seedsfrommedia.js');
  const originalSrc = fs.readFileSync(genPath, 'utf8');

  function mutateOrThrow(src, from, to, label) {
    if (!src.includes(from)) {
      throw new Error(`${label} text has drifted, update the anchor — expected to find:\n${from}`);
    }
    const mutated = src.split(from).join(to);
    if (mutated === src) {
      throw new Error(`${label} mutation was a no-op — text has drifted, update the anchor`);
    }
    return mutated;
  }

  async function withMutated(mutatedSrc, fn) {
    fs.writeFileSync(tmpPath, mutatedSrc);
    delete require.cache[tmpPath];
    const mutatedSvc = require(tmpPath);
    const inner = installStubs(Media, CatalogProduct);
    try {
      return await fn(mutatedSvc, inner);
    } finally {
      inner.restore();
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      delete require.cache[tmpPath];
    }
  }

  try {
    // M1 — drop the fail-closed guard. Observable: queries now run.
    // NOT a data leak on a branded row — findOne still carries brandId
    // (see header). The fail-closed contract is "zero queries", and that
    // is what this mutation independently breaks.
    {
      const from = '  if (!brandId) return [];\n  const media = await Media.findOne({ _id: mediaId, brandId })';
      const to   = '  const media = await Media.findOne({ _id: mediaId, brandId })';
      const mutated = mutateOrThrow(originalSrc, from, to, 'M1');
      await checkAsync('M1 (revert-prove): dropping `if (!brandId) return [];` makes a falsy brandId actually query (zero-queries contract goes red)', async () => {
        await withMutated(mutated, async (mutatedSvc, inner) => {
          inner.reset();
          const seeds = await mutatedSvc.seedsFromMedia(null, MEDIA_A);
          // Honest: the Media.findOne still has `{ _id, brandId:null }`, so
          // a branded row does not leak. The mutation's observable is that
          // a lookup now happens at all.
          if (inner.queryCount() === 0) {
            throw new Error('expected the mutation to reach Media.findOne (fail-closed was the thing stopping the lookup), still got zero queries — mutation had no effect, update the anchor');
          }
          if (!Array.isArray(seeds) || seeds.length !== 0) {
            throw new Error(`M1 alone should not leak a branded row (findOne still scopes by brandId); got ${JSON.stringify(seeds && seeds.map(s => s.mediaId))} — if this fires, the M1 rationale in the header no longer holds`);
          }
        });
      });
    }

    // M2 — findOne({_id, brandId}) → findById. Foreign media now loads.
    // Product FKs are still filtered by ownedMatchedProducts, so the seed
    // degrades to the requesting brand's category/brand tier (or brand_only)
    // WHILE CARRYING THE FOREIGN MEDIA as mediaId. That imagery leak is
    // independently observable.
    {
      const from = '  const media = await Media.findOne({ _id: mediaId, brandId })';
      const to   = '  const media = await Media.findById(mediaId)';
      const mutated = mutateOrThrow(originalSrc, from, to, 'M2');
      await checkAsync('M2 (revert-prove): findOne({_id, brandId}) → findById leaks foreign-brand media into the seed list', async () => {
        await withMutated(mutated, async (mutatedSvc) => {
          const seeds = await mutatedSvc.seedsFromMedia(BRAND_A, MEDIA_B, { campaignKind: 'brand' });
          const leaked = (seeds || []).some((s) => String(s.mediaId) === MEDIA_B);
          if (!leaked) {
            throw new Error(`expected the mutation to load brand-B media (mediaId=${MEDIA_B}) on a brand-A call, got ${JSON.stringify((seeds || []).map((s) => s.mediaId))} — mutation had no effect, update the anchor`);
          }
        });
      });
    }

    // M3 — both consumers read media.matchedProducts again.
    {
      const from = 'const productMatches = ownedMatchedProducts;';
      const occurrences = originalSrc.split(from).length - 1;
      if (occurrences !== 2) {
        throw new Error(`M3 expected exactly 2 consumers of ownedMatchedProducts (brand short-circuit + Case 1), found ${occurrences} — text has drifted, update the anchor`);
      }
      const to = 'const productMatches = (media.matchedProducts || []).filter(mp => mp.catalogProductId);';
      const mutated = mutateOrThrow(originalSrc, from, to, 'M3');
      await checkAsync('M3 (revert-prove): both consumers reading media.matchedProducts again stamps a foreign catalogProductId onto the seed', async () => {
        await withMutated(mutated, async (mutatedSvc) => {
          const seeds = await mutatedSvc.seedsFromMedia(BRAND_A, MEDIA_A_KEEPER);
          const leaked = seedProductIds(seeds).includes(P_FOREIGN);
          if (!leaked) {
            throw new Error(`expected the mutation to emit productId=${P_FOREIGN} from the keeper-repoint row, got ${JSON.stringify(seedProductIds(seeds))} — mutation had no effect, update the anchor`);
          }
        });
      });
      await checkAsync('M3b (revert-prove): campaignKind=brand also stamps the foreign FK once the short-circuit reads matchedProducts again', async () => {
        await withMutated(mutated, async (mutatedSvc) => {
          const seeds = await mutatedSvc.seedsFromMedia(BRAND_A, MEDIA_A_KEEPER, { campaignKind: 'brand' });
          const leaked = (seeds || []).some((s) => String(s.productId) === P_FOREIGN);
          if (!leaked) {
            throw new Error(`expected the brand short-circuit mutation to attach productId=${P_FOREIGN} rather than brand_only, got ${JSON.stringify((seeds || []).map((s) => ({ productId: s.productId, matchTier: s.matchTier })))} — mutation had no effect`);
          }
        });
      });
    }

    // M4 — drop brandId from the Tier-0 Media.find.
    // Independently observable on an OWNED product: MEDIA_CAT_B shares
    // P_OWNED's catalogProductId but belongs to brand B (the PR #245
    // shape). It is NOT independently observable as a guard against a
    // foreign productId reaching this loop — ownedMatchedProducts (M3)
    // already blocks that path, and asserting otherwise would be untrue.
    {
      const from = `      const catalogMedias = await Media.find({
        source: 'catalog-product',
        brandId,  // the guarantee PR #245 added to the same catalog-media query
                  // shape in seededUniverseService.js (product-mode filter).
                  // Redundant for an owned productId — its catalog media is
                  // this brand's by construction — and that is the point: it
                  // only bites if a foreign id ever reaches this loop again.
        'metadata.catalogProductId': productOid
      }).select('_id fileType adSuitability classification metadata.imageRole').lean();`;
      const to = `      const catalogMedias = await Media.find({
        source: 'catalog-product',
        'metadata.catalogProductId': productOid
      }).select('_id fileType adSuitability classification metadata.imageRole').lean();`;
      const mutated = mutateOrThrow(originalSrc, from, to, 'M4');
      await checkAsync('M4 (revert-prove): dropping brandId from the Tier-0 Media.find leaks other-brand catalog media as product_image', async () => {
        await withMutated(mutated, async (mutatedSvc) => {
          const seeds = await mutatedSvc.seedsFromMedia(BRAND_A, MEDIA_A);
          const imgIds = productImageMediaIds(seeds);
          if (!imgIds.includes(MEDIA_CAT_B)) {
            throw new Error(`expected the mutation to leak MEDIA_CAT_B (brand-B catalog media tagged with P_OWNED) into product_image seeds, got ${JSON.stringify(imgIds)} — mutation had no effect, update the anchor`);
          }
        });
      });
    }
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    delete require.cache[tmpPath];
  }

  // ── summary ────────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
