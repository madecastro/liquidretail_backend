#!/usr/bin/env node
'use strict';
//
// verifyMediaAssignmentBrandTenancy — pins the brand-tenancy fix on
// services/mediaAssignmentService.js's attach/detach/list surface.
//
// THE BUG. assertProductOwned / assertCategoryOwned queried MongoDB scoped
// ONLY by `{ _id, advertiserId }` — never `brandId`. One advertiser can own
// many brands (models/Brand.js's unique index is {advertiserId,
// nameNormalized}, not {advertiserId} alone; CatalogProduct.brandId and
// Category.brandId are both `required: true`). So `attachProduct` /
// `attachCategory` / `attachPromotional` let an operator (or the
// media.attachTo agent capability — it never reads a brandId arg either)
// attach a same-advertiser, DIFFERENT-brand CatalogProduct/Category onto a
// Media row: a same-brand Media ending up with a cross-brand
// `matchedProducts[].catalogProductId`, the exact shape PR #245
// (buildSeededUniverse) and PR #257 (ensureDetectForProducts) already exist
// to prevent on sibling paths. Confirmed LIVE-EXPLOITABLE (not merely
// theoretical) via `POST /api/media/:mediaId/assign` and the `media.attachTo`
// agent tool — both authenticate via `req.advertiserId` only; there is no
// `req.brandId` anywhere in this codebase, and capabilityRegistry.js's
// `scope: 'brand'` on these capability entries is pure documentation, never
// enforced at dispatch. The file's own header used to claim "cross-tenant
// attach is impossible" — true for ADVERTISER tenancy, false for BRAND
// tenancy.
//
// THE FIX (services/mediaAssignmentService.js, 2026-08-20):
//   1. assertProductOwned(productId, advertiserId, brandId) and
//      assertCategoryOwned(categoryId, advertiserId, brandId) now take the
//      Media row's own brandId and FAIL CLOSED — `if (!brandId) return
//      null` before running ANY query — same idiom as
//      catalogProductDetectService.ensureDetectForProducts (PR #257:
//      `if (!brandId) return { ensured: 0, ... }`). When brandId is
//      supplied the query is `{ _id, advertiserId, brandId }`.
//   2. attachProduct / attachCategory / attachPromotional now refuse with a
//      distinct code `MEDIA_BRAND_UNDETERMINABLE` (a 400 — routes/media.js
//      and the capability executors only map `MEDIA_NOT_FOUND` to 404) when
//      the Media row itself has no brandId (legacy media predates brand
//      tagging — models/Media.js documents brandId as nullable for exactly
//      that reason), rather than falling through to an advertiser-only
//      product/category check.
//   3. attachProduct's CatalogProduct mirror writes (`$pull`/`$push` on
//      `matchedMedia`) now repeat `{ advertiserId, brandId: media.brandId }`
//      — defense in depth against a TOCTOU between the assert and the write.
//   4. detachProduct's inverse CatalogProduct write previously carried NO
//      tenant filter AT ALL (`{ _id: oid }` — any well-formed ObjectId was
//      written against, unlike every other write in the file). It now
//      always applies `advertiserId`, and `brandId` too when the Media row
//      has one.
//   5. listAssignments' product/category hydration now scopes by `brandId`
//      when the Media row has one, mirroring the brandId clause the
//      sibling `GET /:mediaId/related-products` route already applies in
//      routes/media.js — a historical cross-brand attachment (this fix is
//      forward-only; it does not remediate pre-existing rows) no longer
//      gets its title/price/name hydrated for display.
//
// TECHNIQUE. Same convention as scripts/verifyGenerateProductTenancy.js and
// scripts/verifyDetectPrepMediaTenancy.js: call the REAL exported functions
// against FAITHFUL stubs of Media / CatalogProduct / Category statics,
// monkey-patched on the real required mongoose model objects. Faithful means
// the stub actually APPLIES every filter key it receives (including $in)
// against a fixture table — a stub that ignored brandId would pass this
// harness even on the unfixed code, which would defeat the entire point.
// Write-side calls (`updateOne`) are also logged so a rejected attach/detach
// can be proven to have reached zero writes, not just returned `ok:false`
// after already writing.
//
// FIXTURES. One advertiser (ADV) owning two brands (BRAND_A, BRAND_B) plus
// one other advertiser (OTHER_ADV) for the (unchanged, already-correct)
// cross-advertiser sanity checks:
//   MEDIA_A          — ADV, BRAND_A
//   MEDIA_NULL_BRAND — ADV, brandId: null   (legacy, untagged media)
//   MEDIA_OTHER_ADV  — OTHER_ADV, BRAND_A
//   PRODUCT_A        — ADV, BRAND_A         (legit target for MEDIA_A)
//   PRODUCT_B        — ADV, BRAND_B         (the exploit target — same
//                                             advertiser as MEDIA_A, wrong
//                                             brand)
//   PRODUCT_OTHER_ADV— OTHER_ADV, BRAND_A
//   CATEGORY_A       — ADV, BRAND_A
//   CATEGORY_B       — ADV, BRAND_B         (the category exploit target)
//
// REVERT-PROVE (section D). Three mutations on a TEMP SIBLING copy of
// services/mediaAssignmentService.js (same directory, so its relative
// `require('../models/...')` calls keep resolving — the same reason
// verifyDetectPrepMediaTenancy.js's temp copies live inside services/, not
// under os.tmpdir()). UNLIKE that precedent's fixed `__tmp_revert_*.js`
// filenames — which scripts/runVerifySuite.js's own header flags as a
// general parallel-safety hazard (two concurrent invocations of the same
// script could collide on one file) — this harness's temp file name carries
// a pid+timestamp suffix, and is deleted in a `finally` block even if the
// check throws:
//   M1 — drop `if (!brandId) return null;` from assertProductOwned →
//        the cross-brand fixture (MEDIA_A + PRODUCT_B) now WRONGLY succeeds.
//   M2 (NOT a revert-prove — a documented structural finding, same
//        convention as verifyDetectPrepMediaTenancy.js's own M2). Dropping
//        the `if (!media.brandId) return {...MEDIA_BRAND_UNDETERMINABLE}`
//        guard from attachProduct does NOT reopen the leak: assertProductOwned
//        has its OWN independent fail-closed check (`if (!brandId) return
//        null`, the same guard M1 targets), so a brandless Media still gets
//        refused — just with code PRODUCT_NOT_FOUND instead of the clearer
//        MEDIA_BRAND_UNDETERMINABLE. The outer guard is real but is a
//        diagnostic-clarity layer on top of an already-fail-closed inner
//        one, not an independently-exploitable gate — asserting that it
//        "flips red" would be a false claim about the code (the exact
//        mistake a revert-prove exists to catch, not commit).
//   M3 — drop `advertiserId` from detachProduct's CatalogProduct filter
//        (back to the original `{ _id: oid }`) → a detach call using
//        PRODUCT_OTHER_ADV's id (a DIFFERENT advertiser's product) now
//        WRONGLY reports `productModified: true` against the stub.
//
// Every check against the CURRENT (unmutated) source expects the SECURE
// outcome. Only section D, and only against the deliberately mutated temp
// copy, is allowed to expect the insecure one — this repo has a documented
// incident (PR #257) where a harness's own check required the fail-OPEN
// path and would have failed a later correct fix; this file does not repeat
// that shape anywhere outside the revert-prove section.
//
// Needs a real MongoDB? NO. Offline, no network. Every model static method
// touched is monkey-patched on the real mongoose model object for the
// duration of this script and restored after.
//
//   node scripts/verifyMediaAssignmentBrandTenancy.js
//
// This worktree's committed node_modules subset can be missing
// https-proxy-agent (CLAUDE.md §4) — same fallback stub as the sibling
// tenancy harnesses so this doesn't hard-fail in an unfixed worktree.

const fs = require('fs');
const os = require('os');
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
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 300)}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 300)}`);
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
const ADV        = oid('0', '0');
const OTHER_ADV   = oid('9', '9');
const BRAND_A     = oid('a', '1');
const BRAND_B     = oid('b', '2');

const MEDIA_A          = oid('1', '1'); // ADV, BRAND_A
const MEDIA_NULL_BRAND = oid('1', '2'); // ADV, brandId: null (legacy)
const MEDIA_OTHER_ADV  = oid('1', '3'); // OTHER_ADV, BRAND_A

const PRODUCT_A         = oid('2', '1'); // ADV, BRAND_A — legit target
const PRODUCT_B         = oid('2', '2'); // ADV, BRAND_B — the exploit target
const PRODUCT_OTHER_ADV = oid('2', '3'); // OTHER_ADV, BRAND_A

const CATEGORY_A = oid('3', '1'); // ADV, BRAND_A
const CATEGORY_B = oid('3', '2'); // ADV, BRAND_B — the exploit target

function freshTables() {
  return {
    media: {
      [MEDIA_A]:          { _id: MEDIA_A,          advertiserId: ADV,       brandId: BRAND_A },
      [MEDIA_NULL_BRAND]: { _id: MEDIA_NULL_BRAND, advertiserId: ADV,       brandId: null },
      [MEDIA_OTHER_ADV]:  { _id: MEDIA_OTHER_ADV,  advertiserId: OTHER_ADV, brandId: BRAND_A }
    },
    product: {
      [PRODUCT_A]:         { _id: PRODUCT_A,         advertiserId: ADV,       brandId: BRAND_A, title: 'Product A' },
      [PRODUCT_B]:         { _id: PRODUCT_B,         advertiserId: ADV,       brandId: BRAND_B, title: 'Product B' },
      [PRODUCT_OTHER_ADV]: { _id: PRODUCT_OTHER_ADV, advertiserId: OTHER_ADV, brandId: BRAND_A, title: 'Foreign Product' }
    },
    category: {
      [CATEGORY_A]: { _id: CATEGORY_A, advertiserId: ADV, brandId: BRAND_A, name: 'Cat A', breadcrumbKey: 'cat-a' },
      [CATEGORY_B]: { _id: CATEGORY_B, advertiserId: ADV, brandId: BRAND_B, name: 'Cat B', breadcrumbKey: 'cat-b' }
    }
  };
}

// A filter matcher that APPLIES every key present in the filter object
// (including a `$in` array value) against a fixture row. This is the
// load-bearing property shared with installCatalogProductFindStub in
// scripts/verifyDetectPrepMediaTenancy.js: if the code under test stops
// including a `brandId` key, this matcher stops checking it too — exactly
// mirroring what a real Mongo query would do, so a regression is visible
// through BEHAVIOUR, not asserted by fiat.
function rowMatchesFilter(row, filter) {
  for (const key of Object.keys(filter || {})) {
    const want = filter[key];
    if (want && typeof want === 'object' && Array.isArray(want.$in)) {
      const set = new Set(want.$in.map(String));
      if (!set.has(String(row[key]))) return false;
    } else if (String(row[key]) !== String(want)) {
      return false;
    }
  }
  return true;
}
function matchAll(table, filter) {
  return Object.values(table).filter((row) => rowMatchesFilter(row, filter));
}
function matchOne(table, filter) {
  return matchAll(table, filter)[0] || null;
}

function installFindOneStub(Model, table) {
  const original = Model.findOne;
  Model.findOne = (filter) => {
    const row = matchOne(table, filter);
    return {
      select() { return this; },
      lean() { return Promise.resolve(row ? { ...row } : null); }
    };
  };
  return () => { Model.findOne = original; };
}
function installFindStub(Model, table) {
  const original = Model.find;
  Model.find = (filter) => {
    const rows = matchAll(table, filter);
    return {
      select() { return this; },
      lean() { return Promise.resolve(rows.map((r) => ({ ...r }))); }
    };
  };
  return () => { Model.find = original; };
}
function installUpdateOneStub(Model, table, callLog, label) {
  const original = Model.updateOne;
  Model.updateOne = (filter, update) => {
    callLog.push({ label, filter, update });
    const matches = matchAll(table, filter);
    return Promise.resolve({ modifiedCount: matches.length, matchedCount: matches.length });
  };
  return () => { Model.updateOne = original; };
}

function installAllStubs(tables, callLog) {
  const Media = require(path.join(ROOT, 'models', 'Media'));
  const CatalogProduct = require(path.join(ROOT, 'models', 'CatalogProduct'));
  const Category = require(path.join(ROOT, 'models', 'Category'));
  const restores = [
    installFindOneStub(Media, tables.media),
    installFindStub(CatalogProduct, tables.product),
    installFindOneStub(CatalogProduct, tables.product),
    installUpdateOneStub(CatalogProduct, tables.product, callLog, 'CatalogProduct.updateOne'),
    installFindStub(Category, tables.category),
    installFindOneStub(Category, tables.category),
    installUpdateOneStub(Media, tables.media, callLog, 'Media.updateOne')
  ];
  return () => { for (const r of restores) r(); };
}

async function run() {
  console.log(`verifyMediaAssignmentBrandTenancy — https-proxy-agent: ${PROXY_MODE}\n`);

  const svc = require(path.join(ROOT, 'services', 'mediaAssignmentService'));
  check('0. module surface: attachProduct/attachCategory/attachPromotional/detachProduct/listAssignments exported', () => {
    for (const name of ['attachProduct', 'attachCategory', 'attachPromotional', 'detachProduct', 'listAssignments']) {
      if (typeof svc[name] !== 'function') throw new Error(`${name} not exported / not a function`);
    }
  });

  // ── Section A — attachProduct ──────────────────────────────────────────
  console.log('A. attachProduct brand-scopes the CatalogProduct ownership check');
  {
    const tables = freshTables();
    const callLog = [];
    const restore = installAllStubs(tables, callLog);
    try {
      await checkAsync('A1. same-brand attach (MEDIA_A + PRODUCT_A) succeeds', async () => {
        const r = await svc.attachProduct({ mediaId: MEDIA_A, productId: PRODUCT_A, advertiserId: ADV });
        assertTrue(r.ok === true, `expected ok:true, got ${JSON.stringify(r)}`);
      });
      const writesAfterA1 = callLog.length;
      assertTrue(writesAfterA1 > 0, 'A1 sanity: a successful attach should have written something');

      await checkAsync('A2. [THE FIX] cross-brand attach (MEDIA_A + PRODUCT_B, same advertiser) is REFUSED', async () => {
        const before = callLog.length;
        const r = await svc.attachProduct({ mediaId: MEDIA_A, productId: PRODUCT_B, advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false for a same-advertiser different-brand product');
        assertEqual(r.code, 'PRODUCT_NOT_FOUND', 'expected PRODUCT_NOT_FOUND, not a partial success');
        assertEqual(callLog.length, before, 'a refused attach must not have reached ANY write — the whole point of failing closed BEFORE the write, not after');
      });

      await checkAsync('A3. [FAIL-CLOSED] Media with no brandId (legacy) refuses even an otherwise-owned product', async () => {
        const before = callLog.length;
        const r = await svc.attachProduct({ mediaId: MEDIA_NULL_BRAND, productId: PRODUCT_A, advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false when the Media row has no brandId to verify against');
        assertEqual(r.code, 'MEDIA_BRAND_UNDETERMINABLE', 'expected the distinct fail-closed code (not PRODUCT_NOT_FOUND, not a silent advertiser-only pass)');
        assertEqual(callLog.length, before, 'no write should occur on the fail-closed path');
      });

      await checkAsync('A4. cross-advertiser attach is still refused (unchanged, sanity only)', async () => {
        const r = await svc.attachProduct({ mediaId: MEDIA_OTHER_ADV, productId: PRODUCT_A, advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false — MEDIA_OTHER_ADV does not belong to ADV');
        assertEqual(r.code, 'MEDIA_NOT_FOUND', 'expected MEDIA_NOT_FOUND for a different advertiser\'s media');
      });
    } finally {
      restore();
    }
  }

  // ── Section B — attachCategory ─────────────────────────────────────────
  console.log('\nB. attachCategory brand-scopes the Category ownership check');
  {
    const tables = freshTables();
    const callLog = [];
    const restore = installAllStubs(tables, callLog);
    try {
      await checkAsync('B1. same-brand category attach succeeds', async () => {
        const r = await svc.attachCategory({ mediaId: MEDIA_A, categoryId: CATEGORY_A, advertiserId: ADV });
        assertEqual(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);
      });
      await checkAsync('B2. [THE FIX] cross-brand category attach (MEDIA_A + CATEGORY_B) is refused', async () => {
        const r = await svc.attachCategory({ mediaId: MEDIA_A, categoryId: CATEGORY_B, advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false for a same-advertiser different-brand category');
        assertEqual(r.code, 'CATEGORY_NOT_FOUND', 'expected CATEGORY_NOT_FOUND');
      });
      await checkAsync('B3. [FAIL-CLOSED] Media with no brandId refuses category attach outright', async () => {
        const r = await svc.attachCategory({ mediaId: MEDIA_NULL_BRAND, categoryId: CATEGORY_A, advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false');
        assertEqual(r.code, 'MEDIA_BRAND_UNDETERMINABLE', 'expected the distinct fail-closed code');
      });
    } finally {
      restore();
    }
  }

  // ── Section C — attachPromotional ──────────────────────────────────────
  console.log('\nC. attachPromotional rejects the WHOLE call if any callout is a foreign brand');
  {
    const tables = freshTables();
    const callLog = [];
    const restore = installAllStubs(tables, callLog);
    try {
      await checkAsync('C1. all-owned-same-brand productIds succeed', async () => {
        const r = await svc.attachPromotional({ mediaId: MEDIA_A, productIds: [PRODUCT_A], advertiserId: ADV });
        assertEqual(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);
      });
      await checkAsync('C2. [THE FIX] a mixed same-brand + cross-brand productIds array is refused, not silently trimmed', async () => {
        const r = await svc.attachPromotional({ mediaId: MEDIA_A, productIds: [PRODUCT_A, PRODUCT_B], advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false — the array contains a foreign-brand product');
        assertEqual(r.code, 'PRODUCT_NOT_FOUND', 'expected PRODUCT_NOT_FOUND');
      });
      await checkAsync('C3. [FAIL-CLOSED] Media with no brandId refuses promotional attach even with an empty productIds array', async () => {
        const r = await svc.attachPromotional({ mediaId: MEDIA_NULL_BRAND, productIds: [], advertiserId: ADV });
        assertEqual(r.ok, false, 'expected ok:false — brand cannot be verified regardless of an empty array');
        assertEqual(r.code, 'MEDIA_BRAND_UNDETERMINABLE', 'expected the distinct fail-closed code');
      });
    } finally {
      restore();
    }
  }

  // ── Section D — detachProduct's inverse write is now tenant-scoped ────
  console.log('\nD. detachProduct\'s CatalogProduct inverse write is scoped by advertiserId (+ brandId when known)');
  {
    const tables = freshTables();
    const callLog = [];
    const restore = installAllStubs(tables, callLog);
    try {
      await checkAsync('D1. [THE FIX] detaching a DIFFERENT ADVERTISER\'S product id reports productModified:false, not a blind write', async () => {
        const r = await svc.detachProduct({ mediaId: MEDIA_A, productId: PRODUCT_OTHER_ADV, advertiserId: ADV });
        assertEqual(r.ok, true, 'detachProduct only fails closed on a missing/invalid mediaId or productId shape');
        assertEqual(r.productModified, false, 'the CatalogProduct write must not match a different advertiser\'s product — previously this write had NO filter at all beyond _id');
      });
      await checkAsync('D2. detaching an owned, same-brand product still works normally', async () => {
        // First attach it (through the real function, not a fixture shortcut)
        // so matchedMedia genuinely contains this Media's operator entry.
        tables.product[PRODUCT_A].matchedMedia = [{ mediaId: MEDIA_A, source: 'operator' }];
        const r = await svc.detachProduct({ mediaId: MEDIA_A, productId: PRODUCT_A, advertiserId: ADV });
        assertEqual(r.ok, true, 'expected ok:true for a normal same-advertiser same-brand detach');
      });
    } finally {
      restore();
    }
  }

  // ── Section E — listAssignments hydration is brand-scoped when known ──
  console.log('\nE. listAssignments does not hydrate a foreign-brand product\'s title/price for display');
  {
    const tables = freshTables();
    tables.media[MEDIA_A].matchedProducts = [
      { catalogProductId: PRODUCT_B, source: 'operator', outcome: 'product_match', confidence: 1, assignedAt: new Date(), assignedBy: null }
    ];
    const callLog = [];
    const restore = installAllStubs(tables, callLog);
    try {
      await checkAsync('E1. a (hypothetical / legacy) cross-brand matchedProducts entry hydrates with title:null, not the foreign product\'s real title', async () => {
        const r = await svc.listAssignments({ mediaId: MEDIA_A, advertiserId: ADV });
        assertEqual(r.ok, true, 'listAssignments itself should still succeed (read-only enumeration)');
        const entry = (r.products || []).find((p) => p.catalogProductId === String(PRODUCT_B));
        assertTrue(!!entry, 'expected the matchedProducts entry to still be listed (forward-only — this fix does not delete historical rows)');
        assertEqual(entry.title, null, 'expected title:null because the brandId-scoped hydration query does not match the foreign-brand product — a title leak here would still surface another brand\'s product name');
      });
    } finally {
      restore();
    }
  }

  // ── Section F — revert-prove ────────────────────────────────────────────
  console.log('\nF. Revert-prove: each mutation flips its target check red');
  const realPath = path.join(ROOT, 'services', 'mediaAssignmentService.js');
  const realSrc = fs.readFileSync(realPath, 'utf8');

  function requireMutatedCopy(label, mutatedSrc) {
    const tmpPath = path.join(ROOT, 'services', `__tmp_revert_mediaAssignment_${label}_${process.pid}_${Date.now()}.js`);
    fs.writeFileSync(tmpPath, mutatedSrc);
    delete require.cache[tmpPath];
    try {
      return { mod: require(tmpPath), cleanup: () => { try { fs.unlinkSync(tmpPath); } catch (_) { /* leave for OS */ } } };
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  // M1 — drop the fail-closed guard from assertProductOwned.
  {
    const target = '  if (!brandId) return null;\n  const product = await CatalogProduct.findOne({ _id: productId, advertiserId, brandId })';
    if (!realSrc.includes(target)) {
      failures.push('M1 setup: anchor not found in assertProductOwned — has the fail-closed guard\'s text drifted? update this harness\'s M1 regex');
    } else {
      const mutated = realSrc.replace(target, '  const product = await CatalogProduct.findOne({ _id: productId, advertiserId })');
      const tables = freshTables();
      const callLog = [];
      const restore = installAllStubs(tables, callLog);
      let cleanup = () => {};
      try {
        const loaded = requireMutatedCopy('M1', mutated);
        cleanup = loaded.cleanup;
        await checkAsync('M1 (revert-prove): removing the fail-closed guard from assertProductOwned flips A2 red (cross-brand attach now WRONGLY succeeds)', async () => {
          const r = await loaded.mod.attachProduct({ mediaId: MEDIA_A, productId: PRODUCT_B, advertiserId: ADV });
          if (r.ok !== true) throw new Error(`expected the mutation to leak the cross-brand attach through (ok:true), got ${JSON.stringify(r)} — mutation had no effect, update the anchor`);
        });
      } catch (err) {
        failures.push(`M1: ${err.message}`);
      } finally {
        restore();
        cleanup();
      }
    }
  }

  // M2 — drop the fail-closed brandId-undeterminable guard from attachProduct.
  {
    const target = `  if (!media.brandId) {
    return {
      ok: false,
      error: \`media \${mediaId} has no brandId; cannot attach without a brand scope\`,
      code: 'MEDIA_BRAND_UNDETERMINABLE'
    };
  }
  const product = await assertProductOwned(productId, advertiserId, media.brandId);`;
    if (!realSrc.includes(target)) {
      failures.push('M2 setup: anchor not found in attachProduct — has the MEDIA_BRAND_UNDETERMINABLE guard\'s text drifted? update this harness\'s M2 anchor');
    } else {
      const mutated = realSrc.replace(target, '  const product = await assertProductOwned(productId, advertiserId, media.brandId);');
      const tables = freshTables();
      const callLog = [];
      const restore = installAllStubs(tables, callLog);
      let cleanup = () => {};
      try {
        const loaded = requireMutatedCopy('M2', mutated);
        cleanup = loaded.cleanup;
        await checkAsync('M2 (structural finding, not revert-prove): removing the outer MEDIA_BRAND_UNDETERMINABLE guard has NO security effect — assertProductOwned\'s own fail-closed check is the real gate', async () => {
          const r = await loaded.mod.attachProduct({ mediaId: MEDIA_NULL_BRAND, productId: PRODUCT_A, advertiserId: ADV });
          if (r.ok !== false) throw new Error(`expected security to hold (ok:false) even with the outer guard removed — got ${JSON.stringify(r)}; if this ever flips to ok:true, assertProductOwned\'s own fail-closed check has regressed and THIS is the tripwire`);
          if (r.code !== 'PRODUCT_NOT_FOUND') throw new Error(`expected the inner assertProductOwned fail-closed path to surface as PRODUCT_NOT_FOUND once the outer MEDIA_BRAND_UNDETERMINABLE guard is gone, got code ${r.code}`);
        });
      } catch (err) {
        failures.push(`M2: ${err.message}`);
      } finally {
        restore();
        cleanup();
      }
    }
  }

  // M3 — drop advertiserId from detachProduct's CatalogProduct filter.
  {
    const target = `  const productFilter = { _id: oid, advertiserId };
  if (media.brandId) productFilter.brandId = media.brandId;
  const productRes = await CatalogProduct.updateOne(
    productFilter,`;
    if (!realSrc.includes(target)) {
      failures.push('M3 setup: anchor not found in detachProduct — has the productFilter text drifted? update this harness\'s M3 anchor');
    } else {
      const mutated = realSrc.replace(target, `  const productRes = await CatalogProduct.updateOne(
    { _id: oid },`);
      const tables = freshTables();
      const callLog = [];
      const restore = installAllStubs(tables, callLog);
      let cleanup = () => {};
      try {
        const loaded = requireMutatedCopy('M3', mutated);
        cleanup = loaded.cleanup;
        await checkAsync('M3 (revert-prove): dropping advertiserId from detachProduct\'s filter flips D1 red (a different advertiser\'s product now WRONGLY reports productModified:true)', async () => {
          const r = await loaded.mod.detachProduct({ mediaId: MEDIA_A, productId: PRODUCT_OTHER_ADV, advertiserId: ADV });
          if (r.productModified !== true) throw new Error(`expected the mutation to let the unscoped write match the foreign-advertiser product (productModified:true), got ${JSON.stringify(r)} — mutation had no effect, update the anchor`);
        });
      } catch (err) {
        failures.push(`M3: ${err.message}`);
      } finally {
        restore();
        cleanup();
      }
    }
  }

  // ── summary ─────────────────────────────────────────────────────────────
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
