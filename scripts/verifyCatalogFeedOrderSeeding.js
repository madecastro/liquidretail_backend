#!/usr/bin/env node
'use strict';
//
// verifyCatalogFeedOrderSeeding — pins the NEW default catalog-image seed
// rule (owner directive, 2026-08-05, verbatim): "the primary image as
// defined by the merchant feed is the main image that should be used for
// static, and the first image for video, the second and third image for
// video should be the first and second other images in the feed, as they
// appear in the feed ... The Hero stamp is not relevant when selecting
// images for video or static catalog generations."
//
// Three functions changed, all gated by ONE kill switch,
// CATALOG_FEED_ORDER_SEEDING (config/defaults.env, default ON):
//   1. seededUniverseService.promoteFirstCatalogImage        (static default)
//   2. campaignAdsGenerationService.firstCatalogMediaForProduct (video seed,
//      position 0)
//   3. atlasVideoService.sortCatalogMediasForReferenceStack  (video refs 1+,
//      i.e. positions 1/2 after the seed)
//
// This harness covers the NEW (flag-on) behavior plus flag-off spot checks.
// The pre-existing scripts/verifySeededUniverseHeroDefault.js (122 checks)
// already exhaustively pins promoteFirstCatalogImage's flag-OFF path byte-
// for-byte — it now force-sets CATALOG_FEED_ORDER_SEEDING='false' at its own
// top so it keeps testing exactly that path regardless of this file's
// default. Run both; they are complementary, not overlapping.
//
// Offline: no DB, no network, no key. firstCatalogMediaForProduct is not a
// pure function (it calls Media.findOne/Media.find), so this file stubs
// those two static methods on the real Media model object for the duration
// of the video checks, then restores them — same technique as
// scripts/testAdRunSelection.js.

const mongoose       = require('mongoose');
const Media          = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');

const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures.push(label);
    console.log(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
function checkTrue(label, cond) {
  if (!cond) { failures.push(label); console.log(`FAIL ${label}`); }
}

function oid(n) { return new mongoose.Types.ObjectId(`68fa${String(n).padStart(20, '0')}`); }

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.entries(vars).forEach(([k, v]) => {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  });
  try { return fn(); } finally {
    Object.entries(prev).forEach(([k, v]) => {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    });
  }
}

// Async variant — the sync withEnv would restore the env when fn() RETURNS
// its promise, i.e. before the awaited work inside it has read process.env.
async function withEnvAsync(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.entries(vars).forEach(([k, v]) => {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  });
  try { return await fn(); } finally {
    Object.entries(prev).forEach(([k, v]) => {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    });
  }
}

// ── 1. promoteFirstCatalogImage (static) — ON path + spot-check OFF ────────
(function testStaticSeed() {
  // Fresh require inside withEnv is unnecessary: the function reads
  // process.env at CALL time, not at require time, so toggling the env
  // around the call is sufficient.
  const seeded = require('../services/seededUniverseService');
  const { promoteFirstCatalogImage } = seeded;

  const entry = (id, { role = 'catalog', feedIndex = null, imageRole = null, fileType = 'image' } = {}) => ({
    role,
    media: { _id: id, fileType, metadata: { feedIndex, imageRole } }
  });

  withEnv({ CATALOG_FEED_ORDER_SEEDING: null }, () => {
    // S1 — feedIndex:0 wins outright even when it's ranked last in the
    // incoming (shotType-ranked) order, and even though another entry
    // carries the legacy imageRole:'hero' stamp.
    const pool = [
      entry(oid(1), { imageRole: 'hero', feedIndex: 3 }), // legacy hero stamp, NOT the feed primary
      entry(oid(2), { feedIndex: 1 }),
      entry(oid(3), { feedIndex: 0 })                     // the merchant feed's actual primary
    ];
    const out = promoteFirstCatalogImage(pool);
    check('S1 feedIndex:0 wins outright over a stale imageRole:hero stamp', String(out[0].media._id), String(oid(3)));

    // S2 — no entry has feedIndex:0 (not yet backfilled) → transitional
    // fallback to the best-ranked catalog entry (first isCatalog in incoming
    // order), matching the pre-2026-08-05 tier 2.
    const poolNoFeedIndex = [
      entry(oid(4), { role: 'ugc_product_match', feedIndex: null }),
      entry(oid(5), { feedIndex: null }),
      entry(oid(6), { feedIndex: null })
    ];
    const out2 = promoteFirstCatalogImage(poolNoFeedIndex);
    check('S2 no feedIndex stamped anywhere → first catalog entry in ranked order wins (transitional fallback)',
      String(out2[0].media._id), String(oid(5)));

    // S3 — a UGC entry stamped feedIndex:0 (should never happen — feedIndex
    // is only ever written by catalogProductDetectService on role='catalog'
    // media — but prove the isCatalog gate still holds even if it did).
    const poolUgcFeedIndexZero = [
      entry(oid(7), { role: 'ugc_product_match', feedIndex: 0 }),
      entry(oid(8), { feedIndex: 2 })
    ];
    const out3 = promoteFirstCatalogImage(poolUgcFeedIndexZero);
    check('S3 a UGC entry with feedIndex:0 cannot win tier 1 — isCatalog gate holds', String(out3[0].media._id), String(oid(8)));

    // S4 — no catalog entry at all → pool unchanged.
    const poolNoCatalog = [entry(oid(9), { role: 'ugc_product_match', feedIndex: null })];
    const out4 = promoteFirstCatalogImage(poolNoCatalog);
    check('S4 no catalog entry at all → pool unchanged', String(out4[0].media._id), String(oid(9)));

    // S6 — TIER 2. No feedIndex stamped anywhere, but the caller supplied
    // CatalogProduct.imageMediaId. That field IS the merchant feed's primary
    // image (same semantic as feedIndex:0, different storage), so it must win
    // over the merely best-RANKED catalog entry that tier 3 would pick. This
    // is what makes the owner's rule hold on pre-backfill media instead of
    // silently degrading to shot-type ranking.
    const poolTier2 = [
      entry(oid(14), { feedIndex: null }),   // best-ranked catalog entry — tier 3 would pick this
      entry(oid(15), { feedIndex: null })    // the real feed primary, ranked lower
    ];
    const out6 = promoteFirstCatalogImage(poolTier2, { primaryMediaId: String(oid(15)) });
    check('S6 tier 2: CatalogProduct.imageMediaId wins over the best-ranked catalog entry',
      String(out6[0].media._id), String(oid(15)));

    // S7 — STALE-STAMP REGRESSION (static mirror of V2d). When the live
    // imageMediaId and a feedIndex:0 stamp disagree, the POINTER wins: the
    // stamp can be an orphan left on an image the merchant replaced, and
    // nothing ever clears it.
    const poolBoth = [
      entry(oid(17), { feedIndex: 0 }),      // retired image, stale stamp
      entry(oid(16), { feedIndex: null })    // current primary per imageMediaId
    ];
    const out7 = promoteFirstCatalogImage(poolBoth, { primaryMediaId: String(oid(16)) });
    check('S7 live imageMediaId beats a stale feedIndex:0 stamp when they disagree',
      String(out7[0].media._id), String(oid(16)));

    // S7b — with no imageMediaId supplied, the feedIndex stamp is still the
    // right answer (tier 2 must remain reachable).
    const out7b = promoteFirstCatalogImage(poolBoth, {});
    check('S7b with no primaryMediaId, the feedIndex:0 stamp still wins (tier 2 reachable)',
      String(out7b[0].media._id), String(oid(17)));

    // S8 — a primaryMediaId pointing at a UGC entry cannot win: the isCatalog
    // gate applies to every tier, so tier 2 falls through to tier 3.
    const poolUgcPrimary = [
      entry(oid(18), { role: 'ugc_product_match', feedIndex: null }),
      entry(oid(19), { feedIndex: null })
    ];
    const out8 = promoteFirstCatalogImage(poolUgcPrimary, { primaryMediaId: String(oid(18)) });
    check('S8 tier 2 cannot select a UGC entry even if primaryMediaId names it',
      String(out8[0].media._id), String(oid(19)));
  });

  // S5 — flag OFF: feedIndex:0 is IGNORED, legacy imageRole:'hero' wins
  // instead. Spot check only — verifySeededUniverseHeroDefault.js is the
  // exhaustive suite for this path.
  withEnv({ CATALOG_FEED_ORDER_SEEDING: 'false' }, () => {
    const pool = [
      entry(oid(10), { feedIndex: 0 }),                  // new signal — must be ignored
      entry(oid(11), { imageRole: 'hero', feedIndex: 5 }) // legacy signal — must win
    ];
    const out = promoteFirstCatalogImage(pool);
    check('S5 flag OFF: feedIndex:0 is ignored, legacy imageRole:hero wins', String(out[0].media._id), String(oid(11)));
  });
})();

// ── 2. firstCatalogMediaForProduct (video seed, position 0) ────────────────
async function testVideoSeed() {
  const campaignSvc = require('../services/campaignAdsGenerationService');
  const { firstCatalogMediaForProduct } = campaignSvc;

  const realFindOne     = Media.findOne;
  const realFind        = Media.find;
  const realCpFindById  = CatalogProduct.findById;

  // The stub honours EVERY field the real queries filter on — source,
  // metadata.catalogProductId, metadata.feedIndex, _id and fileType — plus
  // sort(). A stub that ignores a filter silently passes a query that would
  // return the wrong document in production, which is precisely the class of
  // bug this harness exists to catch.
  const PRODUCT_OID = oid(99);
  function installStub(rawRows, productDoc = null) {
    // Defaults so each fixture only states what it is TESTING. Both fields
    // are filtered on by the real queries, so they must be present for the
    // stub's filter to be meaningful; a fixture can still override either to
    // test a cross-product / wrong-source case.
    const rows = rawRows.map((r) => ({
      source: 'catalog-product',
      ...r,
      metadata: { catalogProductId: PRODUCT_OID, ...(r.metadata || {}) }
    }));
    const matchesFilter = (r, filter) => {
      if (filter.fileType?.['$ne'] === 'video' && r.fileType === 'video') return false;
      if (filter.source !== undefined && r.source !== filter.source) return false;
      if (filter['metadata.catalogProductId'] !== undefined
        && String(r.metadata?.catalogProductId || '') !== String(filter['metadata.catalogProductId'])) return false;
      if (filter['metadata.feedIndex'] !== undefined
        && r.metadata?.feedIndex !== filter['metadata.feedIndex']) return false;
      if (filter._id !== undefined && String(filter._id) !== String(r._id)) return false;
      return true;
    };
    Media.findOne = (filter) => {
      let candidates = rows.filter((r) => matchesFilter(r, filter));
      const chain = {
        sort(spec) {
          const [[key, dir]] = Object.entries(spec);
          candidates = candidates.slice().sort((a, b) => {
            const av = key === 'createdAt' ? new Date(a.createdAt || 0).getTime() : (a[key] ?? 0);
            const bv = key === 'createdAt' ? new Date(b.createdAt || 0).getTime() : (b[key] ?? 0);
            return av < bv ? -dir : (av > bv ? dir : 0);
          });
          return chain;
        },
        select() { return chain; },
        lean() { return Promise.resolve(candidates[0] || null); }
      };
      return chain;
    };
    CatalogProduct.findById = (id) => {
      // Honour the id — a stub that ignores it cannot catch a wrong-product load.
      const doc = String(id) === String(PRODUCT_OID) ? productDoc : null;
      const chain = {
        select() { return chain; },
        lean() { return Promise.resolve(doc); }
      };
      return chain;
    };
    Media.find = (filter) => {
      let out = rows.filter((r) => matchesFilter(r, filter));
      const chain = {
        sort(spec) {
          const [[key, dir]] = Object.entries(spec);
          out = out.slice().sort((a, b) => ((a[key] ?? 0) < (b[key] ?? 0) ? -dir : dir));
          return chain;
        },
        select() { return chain; },
        lean() { return Promise.resolve(out); }
      };
      return chain;
    };
  }
  function restoreStub() {
    Media.findOne = realFindOne;
    Media.find    = realFind;
    CatalogProduct.findById = realCpFindById;
  }

  installStub([
    { _id: oid(20), fileType: 'image', metadata: { feedIndex: 1 }, createdAt: new Date('2026-08-05T15:42:08Z'),
      adSuitability: { metrics: { primarySubjectAreaFraction: 0.1 } } }, // earliest-created, subject-safe — the OLD winner
    { _id: oid(21), fileType: 'image', metadata: { feedIndex: 0 }, createdAt: new Date('2026-08-05T17:23:57Z'),
      adSuitability: { metrics: { primarySubjectAreaFraction: 0.95 } } } // the feed primary — subject-DOMINANT, created LAST
  ]);

  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: null }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V1 flag ON: feed primary (feedIndex:0) wins even though it is subject-dominant and created last — no guard, no exceptions',
      String(result?._id), String(oid(21)));
  });

  // V2 — THE BLOCKER REGRESSION TEST. No media stamped feedIndex:0
  // (unbackfilled product) but CatalogProduct.imageMediaId IS set, which is
  // the state of EVERY already-detected product in production.
  //
  // WHY THIS TEST EXISTS: the first draft of this change returned null here
  // and assumed the caller's lazy-materialize path would recover. It cannot —
  // enqueueProductDetect early-returns {skipped:true} whenever imageMediaId
  // is set (catalogProductDetectService.js:44-46), so expandDeterministicVideo
  // skips the product with NO_HERO_MEDIA. That is ZERO video ads for the
  // entire existing catalog until the backfill runs. Caught in adversarial
  // review before deploy. If this test goes back to expecting null, the
  // outage is back.
  installStub(
    [{ _id: oid(22), fileType: 'image', metadata: { feedIndex: null }, createdAt: new Date('2026-08-05T15:42:08Z'),
       adSuitability: { metrics: { primarySubjectAreaFraction: 0.1 } } }],
    { imageMediaId: oid(22) }
  );
  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: null }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V2 flag ON, no feedIndex:0 but imageMediaId set → falls back to the feed primary via imageMediaId (NOT null — that was a prod outage)',
      String(result?._id), String(oid(22)));
  });

  // V2b — neither signal at all → null is correct here (nothing to seed
  // from); the caller's lazy-materialize path genuinely can recover this
  // case, because imageMediaId being unset is exactly when
  // enqueueProductDetect does NOT early-return.
  installStub(
    [{ _id: oid(25), fileType: 'image', metadata: { feedIndex: null }, createdAt: new Date('2026-08-05T15:42:08Z') }],
    { imageMediaId: null }
  );
  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: null }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V2b flag ON, no feedIndex:0 AND no imageMediaId → null (caller lazy-materialize CAN recover this one)', result, null);
  });

  // V2d — THE STALE-STAMP REGRESSION TEST. A merchant replaced their primary
  // image: the retired Media still carries feedIndex:0 (nothing clears it —
  // re-detect materialises a NEW doc under a new externalId), while
  // imageMediaId now points at the CURRENT primary, which may not be stamped
  // yet. A stamp-first cascade seeds a billable Omni render from the RETIRED
  // photo. Caught in adversarial review; the tier order exists for this.
  installStub(
    [
      { _id: oid(27), fileType: 'image', metadata: { feedIndex: 0 }, createdAt: new Date('2026-08-01T00:00:00Z') },   // RETIRED, stale stamp
      { _id: oid(28), fileType: 'image', metadata: { feedIndex: null }, createdAt: new Date('2026-08-05T00:00:00Z') } // CURRENT primary
    ],
    { imageMediaId: oid(28) }
  );
  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: null }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V2d live imageMediaId BEATS a stale feedIndex:0 on a retired image (money: seeds the current photo, not the replaced one)',
      String(result?._id), String(oid(28)));
  });

  // V2e — cross-product safety: imageMediaId naming a Media that belongs to
  // a DIFFERENT product must not be returned.
  installStub(
    [{ _id: oid(29), fileType: 'image', source: 'catalog-product',
       metadata: { feedIndex: 0, catalogProductId: oid(98) }, createdAt: new Date('2026-08-05T00:00:00Z') }],
    { imageMediaId: oid(29) }
  );
  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: null }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V2e imageMediaId pointing at ANOTHER product\'s media is rejected (scoped query)', result, null);
  });

  // V2c — imageMediaId points at a VIDEO doc (corrupt/hand-edited row): the
  // fallback must not hand a video to an image-to-video seed slot.
  installStub(
    [{ _id: oid(26), fileType: 'video', metadata: { feedIndex: null, imageRole: 'video' }, createdAt: new Date('2026-08-05T15:42:08Z') }],
    { imageMediaId: oid(26) }
  );
  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: null }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V2c imageMediaId pointing at a VIDEO is rejected by the fallback', result, null);
  });

  // V3 — flag OFF: legacy behavior fully restored (VIDEO_SEED_FEED_ORDER
  // default ON → createdAt + subject-guard; feedIndex:0 entry is ignored).
  installStub([
    { _id: oid(23), fileType: 'image', metadata: { feedIndex: 1 }, createdAt: new Date('2026-08-05T15:42:08Z'),
      adSuitability: { metrics: { primarySubjectAreaFraction: 0.1 } } },
    { _id: oid(24), fileType: 'image', metadata: { feedIndex: 0 }, createdAt: new Date('2026-08-05T17:23:57Z'),
      adSuitability: { metrics: { primarySubjectAreaFraction: 0.95 } } }
  ]);
  await withEnvAsync({ CATALOG_FEED_ORDER_SEEDING: 'false' }, async () => {
    const result = await firstCatalogMediaForProduct(oid(99));
    check('V3 flag OFF: legacy createdAt+subject-guard wins (earliest, subject-safe) — feedIndex:0 ignored',
      String(result?._id), String(oid(23)));
  });

  restoreStub();
}

// ── 3. sortCatalogMediasForReferenceStack (video refs 1+) — pure function ──
function testReferenceStackOrder() {
  const atlasVideo = require('../services/atlasVideoService');
  const sortFn = atlasVideo.sortCatalogMediasForReferenceStack;
  checkTrue('R0 sortCatalogMediasForReferenceStack is exported', typeof sortFn === 'function');
  if (typeof sortFn !== 'function') return;

  const docs = [
    { _id: oid(30), metadata: { feedIndex: 2 }, createdAt: new Date('2026-08-05T15:42:08Z') },
    { _id: oid(31), metadata: { feedIndex: null }, createdAt: new Date('2026-08-05T15:40:00Z') }, // unstamped, earliest createdAt
    { _id: oid(32), metadata: { feedIndex: 1 }, createdAt: new Date('2026-08-05T15:44:00Z') }
  ];

  withEnv({ CATALOG_FEED_ORDER_SEEDING: null }, () => {
    const out = sortFn(docs);
    check('R1 flag ON: feedIndex ascending, unstamped entries sort LAST regardless of createdAt',
      out.map((d) => String(d._id)), [String(oid(32)), String(oid(30)), String(oid(31))]);
  });

  withEnv({ CATALOG_FEED_ORDER_SEEDING: 'false' }, () => {
    const out = sortFn(docs);
    check('R2 flag OFF: createdAt ascending only, feedIndex ignored entirely',
      out.map((d) => String(d._id)), [String(oid(31)), String(oid(30)), String(oid(32))]);
  });

  // R3 — does not mutate the input array.
  const before = docs.map((d) => String(d._id));
  sortFn(docs);
  check('R3 does not mutate the input array order', docs.map((d) => String(d._id)), before);
}

// ── 4. INGEST — feedIndex must actually be stamped at materialisation ─────
// Source-level, not behavioural: enqueueProductDetect / materializeMissingAlts
// are DB-write paths (Cloudinary upload + Media.create), so they cannot run
// offline. But the entire feed-order rule is worthless if ingest stops
// stamping feedIndex — every downstream tier would silently fall through to
// its transitional fallback and nobody would see a failure. These checks are
// the tripwire for that. Same technique as scripts/verifyBrandFieldNames.js.
function testIngestStamping() {
  const fs   = require('fs');
  const path = require('path');
  const src  = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'catalogProductDetectService.js'), 'utf8');

  checkTrue('I1 materializeImage accepts a feedIndex param',
    /async function materializeImage\(\{[^}]*feedIndex/.test(src));
  checkTrue('I2 the hero (merchant feed primary) is stamped feedIndex: 0',
    /imageRole:\s*'hero',\s*\n\s*feedIndex:\s*0/.test(src));
  checkTrue('I3 alts are stamped feedIndex: altPos + 1 (feed order, 1-based)',
    /imageRole:\s*'alt',\s*\n\s*feedIndex:\s*altPos \+ 1/.test(src));
  // I4 — materializeMissingAlts must use the COMPACT alt position, not the
  // raw array index. `i + 1` there disagrees with enqueueProductDetect (which
  // filters hero-duplicates BEFORE enumerating) about the same image's feed
  // position whenever additionalImages contains a hole or a duplicate of
  // imageUrl. Two writers disagreeing is silent ordering corruption.
  checkTrue('I4 the lazy alt backfill stamps the COMPACT alt position, not the raw index',
    /materializeImage\(\{[^}]*imageRole: 'alt', feedIndex: compactAltPos\.get\(i\)/.test(src));
  checkTrue('I4b compactAltPos skips holes and hero-duplicates when numbering',
    /compactAltPos\.set\(i, seenRealAlts\)/.test(src)
    && /if \(cappedUrls\[i\] === product\.imageUrl\) continue;\s*\n\s*seenRealAlts\+\+/.test(src));
  // The created-doc write is `feedIndex:        feedIndex` inside the
  // metadata literal — i.e. the param is actually persisted, not just
  // accepted and dropped. Anchored on the self-assignment specifically so
  // that deleting the line fails here even though the param still exists.
  checkTrue('I5 feedIndex is written into the created Media doc metadata',
    /^\s*feedIndex:\s+feedIndex,?\s*$/m.test(src));
  // Backfill uses a patch object (`patch['metadata.feedIndex'] = feedIndex`)
  // then Media.updateOne({ $set: patch }) — not an inline $set literal.
  checkTrue('I6 an already-materialised doc gets feedIndex backfilled in place',
    /patch\[['\"]metadata\.feedIndex['\"]\]\s*=\s*feedIndex/.test(src) &&
    /Media\.updateOne\(\s*\{\s*_id:\s*existing\._id\s*\}\s*,\s*\{\s*\$set:\s*patch\s*\}/.test(src));
}

(async function main() {
  await testVideoSeed();
  testReferenceStackOrder();
  testIngestStamping();

  console.log(failures.length
    ? `\nverifyCatalogFeedOrderSeeding: ${failures.length} FAILED`
    : 'verifyCatalogFeedOrderSeeding: all checks passed');
  process.exit(failures.length ? 1 : 0);
})();
