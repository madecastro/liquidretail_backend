#!/usr/bin/env node
'use strict';
//
// verifyCatalogImageSeedSafety.js
//
// Offline (no DB / no network) — revert-proven harness for the 2026-08-18
// fix: a Google Shopping / Lens thumbnail (gstatic's encrypted-tbn CDN) must
// never be promoted to CatalogProduct.imageUrl / imageMediaId as a
// generation seed, and the picker must be told when a product has no
// usable seed at all.
//
// Root cause + full incident writeup: services/catalogImageQuality.js
// header comment. Fix sites:
//   - services/productDetailsService.js   (writeThroughToCatalogProduct)
//   - services/catalogProductDetectService.js (materializeImage)
//   - routes/catalog.js                   (projectListRow → seedUnusable/seedIssue)
//
// EVERY group below EXECUTES the real exported function — never a regex
// over source text — per the standing rule that a source-text harness
// passes against a reimplementation that keeps the name. Groups D/E stub
// Mongoose model methods + cloudinaryService directly on the required
// modules (same technique verifyIngestShotClassify.js §F uses), so this
// stays a pure `node scripts/verifyCatalogImageSeedSafety.js` run with no
// MONGODB_URI needed.

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; fails.push(`${name}${detail ? ` — ${detail}` : ''}`); }
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const {
    isUnusableThumbnailUrl,
    shouldFillImageUrl,
    unusableSeedImageReason,
    catalogSeedFields
  } = require('../services/catalogImageQuality');

  // ── A. isUnusableThumbnailUrl — the core classifier ──────────────────
  const BAD_URLS = [
    'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:ANd9GcR40J6A4T_zYSVhXDW7Qt3pN-',
    'https://encrypted-tbn1.gstatic.com/shopping?q=tbn:ANd9GcShhE3seAkXqBvyDBRNP0TK6P',
    'https://encrypted-tbn2.gstatic.com/shopping?q=tbn:ANd9GcTDINvMC55TzaaK9Owrs29-Q3',
    'https://encrypted-tbn3.gstatic.com/shopping?q=tbn:ANd9GcTywc-uh88JwAmwxXiiOnRZWY',
    'http://encrypted-tbn0.gstatic.com/shopping?q=tbn:xyz',   // http, not just https
    'https://lh3.gstatic.com/shopping?q=tbn:abc'               // any gstatic subdomain
  ];
  for (const url of BAD_URLS) {
    check(`A1 flags gstatic thumbnail: ${url.slice(0, 55)}…`, isUnusableThumbnailUrl(url) === true);
  }

  const GOOD_URLS = [
    'https://cdn.shopify.com/s/files/1/0001/products/shirt.jpg',
    'https://www.vuoriclothing.com/cdn/shop/products/jacket.jpg',
    'https://res.cloudinary.com/reach-social/image/upload/v1/catalog-product/x.jpg',
    'https://images.example.com/gstaticky-but-not-really.jpg' // contains "gstatic"-like text but wrong host
  ];
  for (const url of GOOD_URLS) {
    check(`A2 does NOT flag real image host: ${url.slice(0, 55)}…`, isUnusableThumbnailUrl(url) === false);
  }

  check('A3 non-string input is not flagged (not our concern here)', isUnusableThumbnailUrl(null) === false && isUnusableThumbnailUrl(undefined) === false && isUnusableThumbnailUrl(123) === false);
  check('A4 empty string is not flagged (missing is a separate concept)', isUnusableThumbnailUrl('') === false);
  check('A5 unparseable string does not throw', (() => { try { isUnusableThumbnailUrl('not a url at all'); return true; } catch { return false; } })());

  // ── B. shouldFillImageUrl — the actual write-guard fix ───────────────
  check('B1 THE FIX: refuses to fill an empty imageUrl with a gstatic thumbnail',
    shouldFillImageUrl(null, BAD_URLS[0]) === false);
  check('B1b THE FIX: refuses even when existing is empty string, not just null',
    shouldFillImageUrl('', BAD_URLS[0]) === false);
  check('B2 unchanged behavior: still fills an empty imageUrl with a real image',
    shouldFillImageUrl(null, GOOD_URLS[0]) === true);
  check('B3 unchanged behavior: never overwrites a truthy existing imageUrl, even with a good candidate',
    shouldFillImageUrl(GOOD_URLS[1], GOOD_URLS[0]) === false);
  check('B4 unchanged behavior: never overwrites a truthy existing imageUrl with a bad candidate either',
    shouldFillImageUrl(GOOD_URLS[1], BAD_URLS[0]) === false);
  check('B5 no candidate at all → false (nothing to fill with)',
    shouldFillImageUrl(null, null) === false && shouldFillImageUrl(null, '') === false);

  // ── C. unusableSeedImageReason / catalogSeedFields — picker honesty ──
  check('C1 missing imageUrl (null) → reason "missing"', unusableSeedImageReason(null) === 'missing');
  check('C2 missing imageUrl (empty string) → reason "missing"', unusableSeedImageReason('') === 'missing');
  check('C3 whitespace-only imageUrl → reason "missing"', unusableSeedImageReason('   ') === 'missing');
  check('C4 gstatic imageUrl → reason "thumbnail-only"', unusableSeedImageReason(BAD_URLS[0]) === 'thumbnail-only');
  check('C5 real imageUrl → reason null (usable)', unusableSeedImageReason(GOOD_URLS[0]) === null);
  {
    const f1 = catalogSeedFields(BAD_URLS[0]);
    check('C6 catalogSeedFields shape for a bad url', f1.seedUnusable === true && f1.seedIssue === 'thumbnail-only', JSON.stringify(f1));
    const f2 = catalogSeedFields(GOOD_URLS[0]);
    check('C7 catalogSeedFields shape for a good url', f2.seedUnusable === false && f2.seedIssue === null, JSON.stringify(f2));
    const f3 = catalogSeedFields(null);
    check('C8 catalogSeedFields shape for a missing url', f3.seedUnusable === true && f3.seedIssue === 'missing', JSON.stringify(f3));
  }

  // ── C9-C12 — 2026-08-19 addition: pickerReady / pickerBlockReason.
  // Extends the SAME vocabulary (not a parallel one) to answer "is this
  // card actually ready", which seedUnusable/seedIssue were never meant to
  // answer — a good imageUrl with no imageMediaId yet (the 826/831 Pelagic
  // Gear bug) is NOT seedUnusable, but it is not pickerReady either.
  {
    const noId   = catalogSeedFields(GOOD_URLS[0], null);
    check('C9 good url, no imageMediaId yet → pickerReady false, blocked "materializing"',
      noId.pickerReady === false && noId.pickerBlockReason === 'materializing' &&
      noId.seedUnusable === false && noId.seedIssue === null,
      JSON.stringify(noId));

    const withId = catalogSeedFields(GOOD_URLS[0], '5f1a2b3c4d5e6f7a8b9c0d1e');
    check('C10 good url, imageMediaId set → pickerReady true, blocked null',
      withId.pickerReady === true && withId.pickerBlockReason === null,
      JSON.stringify(withId));

    // A stale/dangling imageMediaId must never make a bad seed "ready" —
    // seedUnusable is computed from the CURRENT imageUrl and wins.
    const badWithId = catalogSeedFields(BAD_URLS[0], '5f1a2b3c4d5e6f7a8b9c0d1e');
    check('C11 bad url still blocks even if imageMediaId is (stale-)set',
      badWithId.pickerReady === false && badWithId.pickerBlockReason === 'thumbnail-only',
      JSON.stringify(badWithId));

    // Missing entirely outranks "materializing" — there is nothing to
    // materialize, so the reason must stay 'missing', not silently
    // become the new 'materializing' state.
    const missingNoId = catalogSeedFields(null, null);
    check('C12 missing url (no imageMediaId either) → blocked "missing", not "materializing"',
      missingNoId.pickerBlockReason === 'missing' && missingNoId.pickerReady === false,
      JSON.stringify(missingNoId));
  }

  // ── D. EXECUTE productDetailsService.writeThroughToCatalogProduct ────
  // Stub CatalogProduct.findById/updateOne directly on the required model
  // so this runs with no MONGODB_URI. Proves the REAL write-through
  // function refuses the gstatic gap-fill, not a reimplementation of it.
  {
    const CatalogProduct = require('../models/CatalogProduct');
    const productDetailsService = require('../services/productDetailsService');
    const origFindById = CatalogProduct.findById;
    const origUpdateOne = CatalogProduct.updateOne;

    function stubFindById(row) {
      CatalogProduct.findById = () => ({
        select() { return this; },
        lean: async () => row
      });
    }
    let capturedSetOps = null;
    CatalogProduct.updateOne = async (_filter, update) => {
      capturedSetOps = update.$set;
      return { acknowledged: true };
    };

    try {
      // D1 — row has NO imageUrl at all; fetched.thumbnail is a gstatic URL.
      // THE FIX: setOps must NOT contain imageUrl.
      stubFindById({ description: null, imageUrl: null, price: null, currency: null, rating: null });
      capturedSetOps = null;
      await productDetailsService.writeThroughToCatalogProduct('fake-id-1', {
        thumbnail: BAD_URLS[0], ratingDistribution: [], reviews: [], specs: {}, sellers: [], reviewSummary: null
      });
      check('D1 THE FIX: write-through does NOT gap-fill imageUrl with a gstatic thumbnail',
        capturedSetOps && !Object.prototype.hasOwnProperty.call(capturedSetOps, 'imageUrl'),
        JSON.stringify(capturedSetOps));

      // D2 — positive control: same empty row, a REAL thumbnail → must fill.
      // Proves D1 isn't passing because writeThroughToCatalogProduct is broken
      // in some unrelated way (e.g. never sets imageUrl at all any more).
      stubFindById({ description: null, imageUrl: null, price: null, currency: null, rating: null });
      capturedSetOps = null;
      await productDetailsService.writeThroughToCatalogProduct('fake-id-2', {
        thumbnail: GOOD_URLS[0], ratingDistribution: [], reviews: [], specs: {}, sellers: [], reviewSummary: null
      });
      check('D2 positive control: write-through STILL gap-fills imageUrl with a real thumbnail',
        capturedSetOps && capturedSetOps.imageUrl === GOOD_URLS[0],
        JSON.stringify(capturedSetOps));

      // D3 — row already has a real imageUrl; gstatic candidate must never
      // overwrite it (pre-existing behavior, must survive the fix untouched).
      stubFindById({ description: null, imageUrl: GOOD_URLS[1], price: null, currency: null, rating: null });
      capturedSetOps = null;
      await productDetailsService.writeThroughToCatalogProduct('fake-id-3', {
        thumbnail: BAD_URLS[0], ratingDistribution: [], reviews: [], specs: {}, sellers: [], reviewSummary: null
      });
      check('D3 unchanged: never overwrites an existing real imageUrl',
        capturedSetOps && !Object.prototype.hasOwnProperty.call(capturedSetOps, 'imageUrl'),
        JSON.stringify(capturedSetOps));
    } finally {
      CatalogProduct.findById = origFindById;
      CatalogProduct.updateOne = origUpdateOne;
    }
  }

  // ── E. EXECUTE catalogProductDetectService.materializeImage ──────────
  // Stub Media.findOne/create directly on the required model so this also
  // runs with no MONGODB_URI / Cloudinary credentials. Proves the REAL
  // materialize path refuses to mirror a gstatic URL into a Media doc /
  // imageMediaId — the choke point that both enqueueProductDetect AND
  // materializeMissingHero share, so no caller can reopen this by skipping
  // their own check.
  //
  // Note: catalogProductDetectService destructures
  // `const { uploadUrlToCloudinary } = require('./cloudinaryService')` at
  // load time, so patching the module's exported property afterward would
  // NOT intercept that already-bound local reference — this harness does
  // not attempt to assert on Cloudinary calls directly. findOneCalls===0 is
  // the real revert-proof signal: it proves the guard returns BEFORE the
  // function does anything at all (Mongo lookup, Cloudinary upload, or
  // Media.create), not just that some individual side effect was skipped.
  {
    const Media = require('../models/Media');
    const detectSvc = require('../services/catalogProductDetectService');

    const origFindOne = Media.findOne;
    const origCreate = Media.create;

    let createCalls = 0;
    let findOneCalls = 0;
    Media.findOne = async () => { findOneCalls++; return null; };            // force create path
    Media.create = async (doc) => { createCalls++; return { _id: '00000000000000000000f001', ...doc }; };

    const fakeProduct = { _id: '00000000000000000000c001', brandId: '00000000000000000000b001', title: 'Test Product', imageShotStyles: [] };

    try {
      // E1 — bad URL: must return null and must NEVER reach Mongo/Cloudinary/Media.create.
      findOneCalls = 0; createCalls = 0;
      const badResult = await detectSvc.materializeImage({ sourceUrl: BAD_URLS[1], product: fakeProduct, imageRole: 'hero', feedIndex: 0 });
      check('E1 THE FIX: materializeImage refuses a gstatic sourceUrl (returns null)', badResult === null, String(badResult));
      check('E2 THE FIX: materializeImage never even reaches Media.findOne for a gstatic sourceUrl (early return)', findOneCalls === 0, `findOneCalls=${findOneCalls}`);
      check('E3 THE FIX: materializeImage never calls Media.create for a gstatic sourceUrl', createCalls === 0, `createCalls=${createCalls}`);

      // E4 — positive control: a real URL still gets past the guard and
      // materializes normally (Cloudinary itself may fail in this offline
      // harness — materializeImage's own try/catch falls back to the source
      // URL and still creates the Media doc, which is pre-existing,
      // unrelated behavior). Proves E1-E3 aren't passing because
      // materializeImage is broken in some unrelated way (e.g. always
      // returns null now, or never reaches Media.findOne for ANY url).
      findOneCalls = 0; createCalls = 0;
      const goodResult = await detectSvc.materializeImage({ sourceUrl: GOOD_URLS[0], product: fakeProduct, imageRole: 'hero', feedIndex: 0 });
      check('E4 positive control: materializeImage STILL reaches Media.findOne + creates a doc for a real sourceUrl',
        !!goodResult && !!goodResult._id && findOneCalls === 1 && createCalls === 1,
        `result=${JSON.stringify(goodResult)} findOneCalls=${findOneCalls} createCalls=${createCalls}`);
    } finally {
      Media.findOne = origFindOne;
      Media.create = origCreate;
    }
  }

  // ── F. routes/catalog.js is actually wired to catalogSeedFields ──────
  // Source-text check ONLY as a wiring confirmation ON TOP OF the
  // behavioral groups above (A-E already call real code) — not a
  // substitute for them. Flags the specific regression of the write-guard
  // staying correct while the route forgets to surface it.
  {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'catalog.js'), 'utf8');
    check('F1 routes/catalog.js imports catalogSeedFields', /require\(['"]\.\.\/services\/catalogImageQuality['"]\)/.test(routeSrc));
    // 2026-08-19 — projectListRow now passes imageMediaId too (adds
    // pickerReady/pickerBlockReason, see catalogImageQuality.js), so match
    // the two-arg call rather than the original one-arg shape. seedUnusable
    // / seedIssue themselves are still URL-only — see C6-C8 above.
    check('F2 projectListRow spreads catalogSeedFields(p.imageUrl, p.imageMediaId)', /\.\.\.catalogSeedFields\(p\.imageUrl,\s*p\.imageMediaId\)/.test(routeSrc));

    // F3 — separate, adjacent fix found while live-testing the above (PR
    // #57-era): aggregate()'s raw $match never auto-casts strings to
    // ObjectId, so the `?ids=` batch-hydration filter
    // (`_id: { $in: [<string ids>] }`) matched ZERO rows in the aggregation
    // pipeline even though countDocuments(filter) (find()-style casting)
    // reported the correct `total` — a silent `products:[]` / `total:1`
    // split.
    //
    // 2026-08-19 — the GET / list handler no longer runs a single
    // aggregate() at all (scale fix for the picker 504ing on 10k+ product
    // brands — see routes/catalog.js's "Scale fix" comment above the
    // handler and session.md). The `?ids=` filter now flows through
    // Mongoose find() (schema-based auto-casting, same mechanism
    // countDocuments already relied on) for both the "matched" and "rest"
    // segments, so the string/ObjectId mismatch this check pins is now
    // structurally impossible rather than patched — there is no longer an
    // `aggFilter` variable or a raw aggregate $match for this path to have
    // the bug in. Re-verified LIVE against the real Vuori catalog (brand
    // 6a6624b95f5af85a46562ded) with an id from offset=200+ (deep past any
    // normal first page): `GET /api/catalog?...&ids=<id>` correctly
    // returns `products:[<row>], total:1`.
    const listHandlerSrc = (routeSrc.match(/router\.get\(['"]\/['"],[\s\S]*?\n}\);/) || [''])[0];
    check('F3 the ids= hydration path wires filter._id = {$in:...} into the list handler',
      /filter\._id\s*=\s*\{\s*\$in:\s*idsParam/.test(listHandlerSrc));
    check('F3b …and the list handler resolves rows via find() (schema auto-casts _id.$in), not a raw aggregate() $match',
      /CatalogProduct\.find\(/.test(listHandlerSrc) && !/aggFilter/.test(listHandlerSrc));
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail) {
    console.log('\nFailures:');
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
