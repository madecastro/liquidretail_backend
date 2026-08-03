#!/usr/bin/env node
'use strict';
//
// verifySeededUniverseHeroDefault — pins the owner's DEFAULT IMAGE SEED ("the
// first image that came from the catalog") to the code that actually
// implements it, and pins the operator override to being left alone.
//
// WHY THIS EXISTS (shipped-but-never-implemented, found 2026-08-03):
//   Owner rule, verbatim 2026-08-03: "I actually just want to use the first
//   image that comes from the catalog not the 'hero' image since that may
//   also come from social media or UGC?"
//   config/defaults.env set DIRECTOR_UNIVERSE_TOP_N=1 and CLAUDE.md,
//   docs/PIPELINES.md, docs/ai-creative-pipeline.md and two code comments all
//   called that the "Hero-image default". IT WAS NOT.
//   seededUniverseService.rankMergedPool sorts a MERGED pool of catalog media
//   and product_match UGC by classification.shotType FIRST (lifestyle →
//   on_model → flat_lay → product_only → detail → packaging → unknown) and
//   only reaches metadata.imageRole==='hero' as a within-tier tiebreak, key #2
//   of 4. So `.slice(0, 1)` of that ranking returned the top LIFESTYLE
//   candidate — a catalog ALT, or a UGC post — and no catalog image was
//   guaranteed to reach the Director. TOP_N=1 trims the pool; it never picked
//   an image.
//   Fix: promoteFirstCatalogImage() + the opt-in preferFirstCatalogImage
//   option, applied in the auto-assembly branch only. It is a CASCADE, and
//   every tier can only select role==='catalog' media:
//     TIER 1  role==='catalog' && metadata.imageRole==='hero' — the stamp
//             catalogProductDetectService writes on CatalogProduct.imageUrl
//             (`:60`), i.e. the catalog feed's first image.
//     TIER 2  else the earliest-createdAt role==='catalog' entry. THIS TIER IS
//             THE AMENDMENT: the tier-1 stamp can be ABSENT (materialisation
//             failed, legacy row), and a tier-1-only helper then returned the
//             pool unchanged so the shotType ranking decided index 0 out of a
//             pool that MERGES catalog with product_match UGC — which is
//             exactly how a UGC post became the default seed.
//     TIER 3  else no catalog entry exists → unchanged copy.
//   Ties in tier 2 (equal timestamps, or none usable) resolve to the earlier
//   entry in RANKED order; a missing/unparseable createdAt sorts LAST, never
//   first.
//
// This harness is pure + offline: no DB, no network, no API key. The
// buildSeededUniverse cases drive the REAL exported function with its three
// Mongoose model statics stubbed by assignment (the require cache is shared,
// so the service holds the same objects) — not a reimplemented sort.
//   node scripts/verifySeededUniverseHeroDefault.js
//
// Revert-prove (back the fix out, confirm it fails). The counts below were
// MEASURED against 111 green on 2026-08-03, not estimated:
//   (a) In seededUniverseService.promoteFirstCatalogImage, drop the role test
//       from TIER 1:
//         (e) => e && e.media?.metadata?.imageRole === 'hero'
//       → 7 fail: P7 ×3, T3, T5 ×2, S8 "TIER 1 is role-gated AND stamp-gated".
//         A UGC post carrying imageRole='hero' wins index 0 — the exact media
//         class this rule exists to dethrone.
//   (a2) Let TIER 2 match ANY role — replace `if (!isCatalog(...)) continue;`
//        with `if (!rankedEntries[i]) continue;`
//        → 9 fail: P7 ×2, T2 ×2, T3, T4 ×2, T5, S8 "TIER 2 skips every
//          non-catalog entry". A UGC post wins tier 2, so the cascade can
//          resolve to UGC — which the rule forbids outright.
//   (a3) Delete the whole TIER 2 loop (`if (idx < 0) { … }`), i.e. go back to
//        tier-1-only → 23 fail: P7 ×2, P11 (tier-2 path), T1 ×3, T2 ×2, T3,
//        T4 ×4, R6 ×2, B9 ×4, L4, S8 ×3. An UNSTAMPED catalog set falls
//        through to the shotType ranking and the UGC post is the default
//        again. (T5 does NOT fail — a UGC-only pool has no catalog entry, so
//        tier 3 is the answer with or without tier 2.)
//   (b) Change `if (idx <= 0)` to `if (idx < 0)` → 1 fails: S8 "TIER 3 /
//       already-first is the `idx <= 0` bail". Note the guard is
//       behaviourally INERT — splice(0,1) + unshift at index 0 reproduces the
//       same order — so no unit check can catch it and the source pin is the
//       only guard. P9 pins the observable contract instead (order unchanged
//       AND a copy). Separately, mutate in place instead of copying → P4/T1
//       fail.
//   (c) Delete the `if (preferFirstCatalogImage && !isBrandOnly)` block in the
//       auto-assembly branch → B2, B6, B9, L1, L4 fail (universe[0] is the UGC
//       post again at topN=1, for both the stamped and unstamped fixtures).
//   (d) Move that block below `const trimmed = universe.slice(0, topN)`
//       → S4 fails (a promotion after the trim cannot change a topN=1 pick).
//   (e) Remove `preferFirstCatalogImage:` from the buildSeededUniverse call in
//       campaignAdsGenerationService.runConceptDrivenExpansion → S6 fails
//       (helper correct, live path still broken — the failure mode
//       verifyRegeneration.js:92-97 warns about).
//   (f) Apply the promotion inside rankMergedPool instead → S5/S7 fail (the
//       operator-picked branch calls the same ranker, so that silently
//       re-orders the override).
//   Report the failing output verbatim when proving.
//
// Covered:
//   P*  promoteFirstCatalogImage purity + stability + the tier-1 role gate
//   T*  the TIER 2 cascade: it fires, it never selects UGC, its tie and
//       missing-createdAt outcomes, and tier 3
//   R*  composed with the REAL rankMergedPool — the bug shape, then the fix
//   B*  buildSeededUniverse end to end (stubbed models): auto-assembly at
//       topN=1 (tier 1 and tier 2), the restrictToMediaIds override,
//       brand-only, strict opt-in
//   L*  the operator-facing log lines fire (and do not fire when off)
//   S*  source wiring a unit test cannot see: the live caller passes the
//       option, the override branch does not promote, ordering vs the trim,
//       and that every tier is role-gated
//
// WHAT A GREEN RUN DOES NOT PROVE — read before trusting it:
//   • Nothing about which media the Director then PICKS. This pins what the
//     universe contains and in what order; the model still chooses.
//   • Nothing about Ad.variantKind / matchTier downstream. Promoting a
//     catalog image over a UGC post at topN=1 flips
//     matchTierForUniverseRole/variantKindForUniverseRole from ugc →
//     product_image by design; that mapping is not exercised here.
//   • Nothing about the deterministic VIDEO rail, which runs the same cascade
//     as direct Mongo queries (`campaignAdsGenerationService.js:2085`) and
//     never calls buildSeededUniverse.
//   • Nothing about whether catalog Media.createdAt really is feed order in
//     prod. Tier 2 assumes materialisation order ≈ feed order; that is an
//     assumption about ingest, not something a pure function can assert.

const fs   = require('fs');
const path = require('path');

const seeded = require('../services/seededUniverseService');
const {
  promoteFirstCatalogImage,
  rankMergedPool,
  buildSeededUniverse
} = seeded;

const Media                = require('../models/Media');
const CatalogProduct       = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const isObj = actual !== null && typeof actual === 'object';
  const match = isObj
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (match) { pass++; return; }
  failures.push(
    `${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
  );
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
}

// ── fixtures ─────────────────────────────────────────────────────────
//
// 24-hex ObjectId-shaped ids: toObjectId() runs mongoose.isValidObjectId and
// returns null for anything else, which would silently empty the pool.

const BRAND_ID   = '68e9bbbbbbbbbbbbbbbbbb01';
const PRODUCT_ID = '68e9cccccccccccccccccc01';
// 20-char hex prefix + a 4-digit counter = exactly 24. Getting this wrong is
// silent: toObjectId() returns null for a 25-char string, so the
// restrictToMediaIds branch loads nothing and "the override was preserved"
// passes against an empty universe.
function oid(n) { return `68e9aaaaaaaaaaaaaaaa${String(n).padStart(4, '0')}`; }

// Raw Media doc shape (NOT the projected shape): rankMergedPool reads
// classification.shotType and metadata.imageRole off the doc, while
// projectEntry emits metadata.shotType. Building the projected shape here
// would silently rank everything as `unknown`.
//
// createdAt: pass `null` to OMIT the key entirely — that is what a legacy
// `.lean()` doc with no timestamp looks like, and it is the tier-2 case the
// cascade has to define. `createdAt: undefined` would NOT work: a
// destructuring default fires on undefined, so the fixture would silently get
// the default timestamp and the missing-createdAt checks would test nothing.
function media(id, {
  shotType = 'product_only',
  imageRole = null,
  burnedText = false,
  engagement = null,
  createdAt = '2026-01-01T00:00:00.000Z',
  source = 'catalog-product',
  // Catalog VIDEOS share source:'catalog-product' — shopifyPublicIngestService
  // writes fileType:'video' + metadata.imageRole:'video'. Overridable so the V*
  // group can build one; defaults to 'image' so every existing fixture is
  // unchanged.
  fileType = 'image'
} = {}) {
  const doc = {
    _id: id,
    fileUrl: `https://cdn.example/${id}.jpg`,
    fileType,
    source,
    classification: { shotType },
    metadata: {}
  };
  if (createdAt !== null) doc.createdAt = createdAt;
  if (imageRole) doc.metadata.imageRole = imageRole;
  if (source === 'catalog-product') doc.metadata.catalogProductId = PRODUCT_ID;
  if (burnedText) doc.text = ['50% OFF'];
  if (engagement !== null) doc.platformStats = { likes: engagement, comments: 0, engagement };
  return doc;
}
function entry(doc, role) { return { media: doc, role }; }

const ids = (arr) => (arr || []).map(e => (e && e.media ? String(e.media._id) : String(e)));
const universeIds = (u) => (u || []).map(e => String(e.mediaId));

// ── P: promoteFirstCatalogImage — purity, stability, the tier-1 role gate ──

{
  const alt   = entry(media(oid(1), { shotType: 'lifestyle',    imageRole: 'alt'  }), 'catalog');
  const ugc   = entry(media(oid(2), { shotType: 'lifestyle',    source: 'instagram', engagement: 500 }), 'ugc_product_match');
  const hero  = entry(media(oid(3), { shotType: 'product_only', imageRole: 'hero' }), 'catalog');
  const alt2  = entry(media(oid(4), { shotType: 'detail',       imageRole: 'alt'  }), 'catalog');
  const input = [alt, ugc, hero, alt2];
  const before = ids(input);

  const out = promoteFirstCatalogImage(input);

  check('P1 mid-list stamped catalog image (tier 1) moves to index 0', ids(out)[0], oid(3));
  check('P2 remaining entries keep their relative order',
    ids(out), [oid(3), oid(1), oid(2), oid(4)]);
  check('P3 length is preserved (nothing dropped, nothing duplicated)', out.length, 4);
  check('P4 input array is NOT mutated', ids(input), before);
  checkTrue('P4 output is a NEW array, not the input reference', out !== input);
  checkTrue('P4 entries are the same objects (no cloning of media docs)', out[0] === hero);
}

{
  // TIER 2 TIE: catalog entries, none stamped, IDENTICAL createdAt. Ties
  // resolve to the earlier entry in ranked order, so index 0 is already the
  // winner and the array comes back unchanged.
  const a = entry(media(oid(10), { shotType: 'lifestyle', imageRole: 'alt', createdAt: '2026-01-01T00:00:00.000Z' }), 'catalog');
  const b = entry(media(oid(11), { shotType: 'flat_lay',  imageRole: 'alt', createdAt: '2026-01-01T00:00:00.000Z' }), 'catalog');
  const input = [a, b];
  const out = promoteFirstCatalogImage(input);
  check('P5 tier-2 createdAt tie → earlier entry in ranked order keeps index 0',
    ids(out), [oid(10), oid(11)]);
  checkTrue('P5 tied pool is still a copy', out !== input);
}

{
  check('P6 empty array → empty array', promoteFirstCatalogImage([]).length, 0);
  check('P6 null → empty array', promoteFirstCatalogImage(null).length, 0);
  check('P6 undefined → empty array', promoteFirstCatalogImage(undefined).length, 0);
  check('P6 non-array (string) → empty array', promoteFirstCatalogImage('nope').length, 0);
  check('P6 non-array (object) → empty array', promoteFirstCatalogImage({ 0: 'x' }).length, 0);

  const solo = [entry(media(oid(12), { imageRole: 'hero' }), 'catalog')];
  const outSolo = promoteFirstCatalogImage(solo);
  check('P6 single-entry array (stamped) → length 1, same id', ids(outSolo), [oid(12)]);
  checkTrue('P6 single-entry array is a copy', outSolo !== solo);

  const soloAlt = [entry(media(oid(13), { imageRole: 'alt' }), 'catalog')];
  check('P6 single-entry array (unstamped) → unchanged', ids(promoteFirstCatalogImage(soloAlt)), [oid(13)]);
}

{
  // THE TIER-1 ROLE GATE. We do not author creator-side metadata; a UGC post
  // whose metadata says imageRole='hero' did not come from the catalog, and it
  // is exactly the media class this rule exists to dethrone at topN=1.
  const catalogAlt = entry(media(oid(20), { shotType: 'lifestyle', imageRole: 'alt' }), 'catalog');
  const ugcHero    = entry(media(oid(21), { shotType: 'lifestyle', imageRole: 'hero', source: 'instagram', engagement: 900 }), 'ugc_product_match');

  check('P7 UGC entry with metadata.imageRole=hero does NOT satisfy tier 1 — the unstamped CATALOG entry wins via tier 2',
    ids(promoteFirstCatalogImage([ugcHero, catalogAlt])), [oid(20), oid(21)]);
  check('P7 a UGC hero ranked first is not hoisted, and stays put behind the catalog entry',
    ids(promoteFirstCatalogImage([ugcHero, ugcHero, catalogAlt])), [oid(20), oid(21), oid(21)]);
  check('P7 a UGC hero ahead of a STAMPED catalog image still loses index 0 to the catalog image',
    ids(promoteFirstCatalogImage([
      ugcHero,
      entry(media(oid(22), { shotType: 'packaging', imageRole: 'hero' }), 'catalog')
    ])), [oid(22), oid(21)]);
}

{
  // Two stamped catalog images (a real catalog can carry duplicates) → the
  // earlier one in RANKED order wins tier 1, so the decision stays the
  // ranker's. createdAt is NOT consulted when tier 1 matches.
  const a     = entry(media(oid(30), { shotType: 'lifestyle', imageRole: 'alt'  }), 'catalog');
  const hero1 = entry(media(oid(31), { shotType: 'on_model',  imageRole: 'hero', createdAt: '2026-06-01T00:00:00.000Z' }), 'catalog');
  const b     = entry(media(oid(32), { shotType: 'flat_lay',  imageRole: 'alt'  }), 'catalog');
  const hero2 = entry(media(oid(33), { shotType: 'detail',    imageRole: 'hero', createdAt: '2020-01-01T00:00:00.000Z' }), 'catalog');
  check('P8 two stamped catalog images → the earlier one in ranked order wins tier 1 (createdAt not consulted)',
    ids(promoteFirstCatalogImage([a, hero1, b, hero2])), [oid(31), oid(30), oid(32), oid(33)]);
}

{
  // Already at index 0 → unchanged copy (no needless re-splice).
  const hero = entry(media(oid(40), { shotType: 'lifestyle', imageRole: 'hero' }), 'catalog');
  const alt  = entry(media(oid(41), { shotType: 'lifestyle', imageRole: 'alt'  }), 'catalog');
  const input = [hero, alt];
  const out = promoteFirstCatalogImage(input);
  check('P9 catalog image already first → order unchanged', ids(out), [oid(40), oid(41)]);
  checkTrue('P9 still returns a copy', out !== input);
}

{
  // DELIBERATE: the owner rule outranks the wantsVideo burned-text tiebreak.
  // Asserted so the behaviour is documented, not accidental.
  const clean     = entry(media(oid(50), { shotType: 'lifestyle', imageRole: 'alt' }), 'catalog');
  const heroTexty = entry(media(oid(51), { shotType: 'lifestyle', imageRole: 'hero', burnedText: true }), 'catalog');
  check('P10 a catalog image with burned-in text IS still promoted',
    ids(promoteFirstCatalogImage([clean, heroTexty])), [oid(51), oid(50)]);
}

{
  // Junk entries must not throw — the pool is assembled from DB reads.
  const hero = entry(media(oid(60), { imageRole: 'hero' }), 'catalog');
  const out = promoteFirstCatalogImage([null, undefined, hero]);
  check('P11 null / undefined entries are skipped, not thrown on (tier 1)', ids(out)[0], oid(60));
  check('P11 junk entries are preserved in place', out.length, 3);

  // Same, on the tier-2 path — the tier-2 loop must also survive holes.
  const unstamped = entry(media(oid(61), { imageRole: 'alt' }), 'catalog');
  const out2 = promoteFirstCatalogImage([null, undefined, unstamped]);
  check('P11 null / undefined entries are skipped on the tier-2 path too', ids(out2)[0], oid(61));
  check('P11 tier-2 junk entries are preserved in place', out2.length, 3);
}

// ── T: the TIER 2 / TIER 3 cascade — the 2026-08-03 amendment ─────────
//
// Tier 2 is the whole point: the imageRole stamp can be ABSENT, and a
// tier-1-only helper then let the shotType ranking decide index 0 out of a
// pool that MERGES catalog media with product_match UGC. Falling through is
// how a UGC post became the default seed of a catalog product ad.

{
  // T1 — TIER 2 FIRES. Catalog entries present, NONE stamped hero → the
  // earliest-createdAt catalog entry is promoted to index 0.
  const late   = entry(media(oid(200), { shotType: 'lifestyle', imageRole: 'alt', createdAt: '2026-05-05T00:00:00.000Z' }), 'catalog');
  const early  = entry(media(oid(201), { shotType: 'detail',    imageRole: 'alt', createdAt: '2024-02-02T00:00:00.000Z' }), 'catalog');
  const middle = entry(media(oid(202), { shotType: 'flat_lay',  imageRole: 'alt', createdAt: '2025-03-03T00:00:00.000Z' }), 'catalog');
  const input  = [late, middle, early];
  const before = ids(input);
  const out    = promoteFirstCatalogImage(input);

  check('T1 tier 2 fires with no stamped entry: earliest-createdAt catalog entry is index 0',
    ids(out)[0], oid(201));
  check('T1 the rest keep their ranked order behind it',
    ids(out), [oid(201), oid(200), oid(202)]);
  check('T1 tier 2 does not mutate the input', ids(input), before);
  checkTrue('T1 tier 2 returns a NEW array', out !== input);
  checkTrue('T1 tier 2 promotes the same object, not a clone', out[0] === early);
}

{
  // T2 — TIER 2 NEVER SELECTS UGC. The owner's concern, stated directly: the
  // default must not be a social/UGC image. A UGC post ranked FIRST (as the
  // shotType ranker routinely does — lifestyle outranks everything) loses
  // index 0 to a catalog ALT even though the UGC post is newer, older,
  // higher-engagement, or all three.
  const ugcOldest = entry(media(oid(210), { shotType: 'lifestyle', source: 'instagram', engagement: 5000, createdAt: '2019-01-01T00:00:00.000Z' }), 'ugc_product_match');
  const catAlt    = entry(media(oid(211), { shotType: 'detail',    imageRole: 'alt',    createdAt: '2026-07-07T00:00:00.000Z' }), 'catalog');

  check('T2 UGC ranked first with an EARLIER createdAt still loses tier 2 to the catalog alt',
    ids(promoteFirstCatalogImage([ugcOldest, catAlt])), [oid(211), oid(210)]);

  // And with several UGC tiers in the pool, all of them earlier.
  const ugcCat   = entry(media(oid(212), { shotType: 'lifestyle', source: 'tiktok',    createdAt: '2018-01-01T00:00:00.000Z' }), 'ugc_product_category');
  const ugcBrand = entry(media(oid(213), { shotType: 'on_model',  source: 'instagram', createdAt: '2017-01-01T00:00:00.000Z' }), 'ugc_brand_match');
  check('T2 no UGC role (product_match / product_category / brand_match) can win tier 2',
    ids(promoteFirstCatalogImage([ugcOldest, ugcCat, ugcBrand, catAlt])),
    [oid(211), oid(210), oid(212), oid(213)]);
}

{
  // T3 — a UGC entry stamped metadata.imageRole==='hero' sitting alongside an
  // UNSTAMPED catalog entry: the CATALOG entry wins. This is the exact shape
  // the owner asked about ("that may also come from social media or UGC"), and
  // it is where a tier-1-only helper failed — it matched nothing and handed
  // index 0 back to the ranking.
  const ugcHero = entry(media(oid(220), { shotType: 'lifestyle', imageRole: 'hero', source: 'instagram', engagement: 9000, createdAt: '2015-01-01T00:00:00.000Z' }), 'ugc_product_match');
  const catAlt  = entry(media(oid(221), { shotType: 'packaging', imageRole: 'alt',  createdAt: '2026-01-01T00:00:00.000Z' }), 'catalog');
  check('T3 UGC stamped imageRole=hero + UNSTAMPED catalog entry → the CATALOG entry wins index 0',
    ids(promoteFirstCatalogImage([ugcHero, catAlt])), [oid(221), oid(220)]);
  check('T3 the UGC hero is not dropped, just demoted',
    promoteFirstCatalogImage([ugcHero, catAlt]).length, 2);
}

{
  // T4 — createdAt ties and missing/undefined createdAt. DOCUMENTED RULE:
  // strict `<` in the tier-2 scan, and a missing/unparseable createdAt maps to
  // Infinity, so it sorts LAST rather than winning "earliest" as epoch 0.
  const tieA = entry(media(oid(230), { shotType: 'detail',   imageRole: 'alt', createdAt: '2026-01-01T00:00:00.000Z' }), 'catalog');
  const tieB = entry(media(oid(231), { shotType: 'flat_lay', imageRole: 'alt', createdAt: '2026-01-01T00:00:00.000Z' }), 'catalog');
  const ugc  = entry(media(oid(232), { shotType: 'lifestyle', source: 'instagram', engagement: 10 }), 'ugc_product_match');

  check('T4 exact createdAt tie → the earlier CATALOG entry in ranked order wins, order unchanged',
    ids(promoteFirstCatalogImage([tieA, tieB])), [oid(230), oid(231)]);
  check('T4 exact tie with UGC ranked first → the first tied catalog entry is promoted',
    ids(promoteFirstCatalogImage([ugc, tieA, tieB])), [oid(230), oid(232), oid(231)]);

  // Missing createdAt (key absent — see the media() fixture note).
  const noDate  = entry(media(oid(233), { shotType: 'detail', imageRole: 'alt', createdAt: null }), 'catalog');
  const dated   = entry(media(oid(234), { shotType: 'detail', imageRole: 'alt', createdAt: '2026-04-04T00:00:00.000Z' }), 'catalog');
  checkTrue('T4 the missing-createdAt fixture really has no createdAt key',
    !('createdAt' in noDate.media));
  check('T4 a catalog entry with NO createdAt loses to one that has it, even when ranked first',
    ids(promoteFirstCatalogImage([noDate, dated])), [oid(234), oid(233)]);
  check('T4 …and does not displace a dated entry from behind either',
    ids(promoteFirstCatalogImage([dated, noDate])), [oid(234), oid(233)]);
  const bogus = entry(media(oid(235), { shotType: 'detail', imageRole: 'alt', createdAt: 'not-a-date' }), 'catalog');
  check('T4 an UNPARSEABLE createdAt is treated as missing (sorts last, does not win)',
    ids(promoteFirstCatalogImage([bogus, dated])), [oid(234), oid(235)]);

  // Every catalog entry missing createdAt → all tie at Infinity → the earliest
  // in ranked order wins, which is index 0 here, so the array is unchanged.
  const noDate2 = entry(media(oid(236), { shotType: 'flat_lay', imageRole: 'alt', createdAt: null }), 'catalog');
  check('T4 ALL catalog createdAt missing → earlier in ranked order wins (unchanged)',
    ids(promoteFirstCatalogImage([noDate, noDate2])), [oid(233), oid(236)]);
  check('T4 ALL catalog createdAt missing, UGC ranked first → the first catalog entry still wins',
    ids(promoteFirstCatalogImage([ugc, noDate, noDate2])), [oid(233), oid(232), oid(236)]);
}

{
  // T5 — TIER 3: a pool with no catalog entry at all comes back unchanged.
  // Nothing came from the catalog, so there is nothing to pin — and crucially
  // the cascade must NOT settle for a UGC entry as a consolation prize.
  const u1 = entry(media(oid(240), { shotType: 'lifestyle', source: 'instagram', engagement: 800, createdAt: '2020-01-01T00:00:00.000Z' }), 'ugc_product_match');
  const u2 = entry(media(oid(241), { shotType: 'on_model',  source: 'tiktok',    engagement: 200, createdAt: '2019-01-01T00:00:00.000Z' }), 'ugc_brand_match');
  const u3 = entry(media(oid(242), { shotType: 'lifestyle', imageRole: 'hero',   source: 'instagram', createdAt: '2018-01-01T00:00:00.000Z' }), 'ugc_product_category');
  const input = [u1, u2, u3];
  const before = ids(input);
  const out = promoteFirstCatalogImage(input);
  check('T5 tier 3 (UGC-only pool) → returned in unchanged order, nothing promoted',
    ids(out), before);
  checkTrue('T5 tier 3 still returns a copy', out !== input);
  check('T5 tier 3 does not mutate the input', ids(input), before);

  // A role that is neither 'catalog' nor a known UGC tier must not qualify
  // either — the gate is `role === 'catalog'`, not `role !== 'ugc*'`.
  const weird = entry(media(oid(243), { imageRole: 'hero', source: 'catalog-product' }), 'catalog_hero');
  check('T5 role=catalog_hero (a legacy role string, not "catalog") does NOT qualify',
    ids(promoteFirstCatalogImage([u1, weird])), [oid(240), oid(243)]);
}

// ── V — A CATALOG VIDEO IS NOT "THE FIRST CATALOG IMAGE" ──────────────────
// role==='catalog' means source==='catalog-product', which is NOT the same as
// "is an image". shopifyPublicIngestService.js:513-546 upserts catalog VIDEOS
// under that same source with fileType:'video' + metadata.imageRole:'video',
// and it does resolve catalogProductId, so such a doc lands in the pool for a
// STATIC image run. Tier 1 was safe only incidentally (it demands
// imageRole==='hero'); tier 2 selects on createdAt alone, so before the
// fileType/imageRole guard a product with unstamped images and one catalog
// video could seed a static ad with an .mp4.
//
// Found by adversarial review, not by the implementation. Pinned here so it
// cannot come back.
{
  const vid  = entry(media(oid(250), { fileType: 'video', imageRole: 'video', createdAt: '2020-01-01T00:00:00.000Z' }), 'catalog');
  const alt  = entry(media(oid(251), { imageRole: null,    createdAt: '2026-01-01T00:00:00.000Z' }), 'catalog');
  const ugc  = entry(media(oid(252), { source: 'instagram', shotType: 'lifestyle' }), 'ugc_product_match');

  // The video is OLDER, so a createdAt-only tier 2 would pick it.
  check('V1 tier 2 skips a catalog VIDEO and takes the catalog image instead',
    ids(promoteFirstCatalogImage([ugc, vid, alt])), [oid(251), oid(252), oid(250)]);

  // fileType alone must be enough, even without the imageRole:'video' stamp.
  const vidNoStamp = entry(media(oid(253), { fileType: 'video', createdAt: '2019-01-01T00:00:00.000Z' }), 'catalog');
  check('V2 fileType:video alone disqualifies (no imageRole stamp needed)',
    ids(promoteFirstCatalogImage([ugc, vidNoStamp, alt])), [oid(251), oid(252), oid(253)]);

  // imageRole:'video' alone must be enough, even if fileType were mislabelled.
  const vidStampOnly = entry(media(oid(254), { imageRole: 'video', createdAt: '2019-01-01T00:00:00.000Z' }), 'catalog');
  check('V3 imageRole:video alone disqualifies (defence in depth on fileType)',
    ids(promoteFirstCatalogImage([ugc, vidStampOnly, alt])), [oid(251), oid(252), oid(254)]);

  // A video-only catalog set must fall to tier 3, NOT promote the video. The
  // pool is then whatever the shotType ranker produced — the correct outcome is
  // "no promotion", because there is no catalog IMAGE to pin.
  check('V4 catalog set with ONLY a video → tier 3, nothing promoted',
    ids(promoteFirstCatalogImage([ugc, vid])), [oid(252), oid(250)]);

  // And a hero-stamped image still beats an older catalog video at tier 1.
  const hero = entry(media(oid(255), { imageRole: 'hero', createdAt: '2026-06-01T00:00:00.000Z' }), 'catalog');
  check('V5 tier 1 hero image still wins over an older catalog video',
    ids(promoteFirstCatalogImage([ugc, vid, hero])), [oid(255), oid(252), oid(250)]);
}

// ── R: composed with the REAL rankMergedPool — the bug, then the fix ──

{
  // The production pool shape: a lifestyle catalog ALT, a lifestyle UGC post
  // with engagement, and the product_only stamped catalog first image.
  const alt  = entry(media(oid(70), { shotType: 'lifestyle',    imageRole: 'alt'  }), 'catalog');
  const ugc  = entry(media(oid(71), { shotType: 'lifestyle',    source: 'instagram', engagement: 500 }), 'ugc_product_match');
  const hero = entry(media(oid(72), { shotType: 'product_only', imageRole: 'hero' }), 'catalog');
  const pool = [hero, alt, ugc];   // arrival order: catalog first, then UGC

  const ranked = rankMergedPool(pool, { wantsVideo: false });
  check('R1 rankMergedPool ranks shotType first — the catalog first image is NOT index 0',
    ids(ranked)[0] === oid(72), false);
  check('R2 THE BUG: rank + slice(0,1) hands the Director a UGC post',
    ids(ranked.slice(0, 1)), [oid(71)]);
  check('R3 THE FIX: rank + promoteFirstCatalogImage + slice(0,1) is the catalog first image',
    ids(promoteFirstCatalogImage(ranked).slice(0, 1)), [oid(72)]);
  check('R3 the rest stay in shotType order behind it',
    ids(promoteFirstCatalogImage(ranked)), [oid(72), oid(71), oid(70)]);
}

{
  // R6 — the same production pool shape, but with the imageRole stamp ABSENT
  // from every catalog doc (materialisation failed / legacy row). This is the
  // case a tier-1-only helper got wrong: it returned the ranking untouched and
  // the UGC post stayed at index 0.
  const altLate  = entry(media(oid(73), { shotType: 'lifestyle',    createdAt: '2026-06-06T00:00:00.000Z' }), 'catalog');
  const ugc      = entry(media(oid(74), { shotType: 'lifestyle',    source: 'instagram', engagement: 500, createdAt: '2026-05-05T00:00:00.000Z' }), 'ugc_product_match');
  const catFirst = entry(media(oid(75), { shotType: 'product_only', createdAt: '2024-01-01T00:00:00.000Z' }), 'catalog');
  const ranked   = rankMergedPool([catFirst, altLate, ugc], { wantsVideo: false });
  check('R6 unstamped pool: the ranker still puts the UGC post at index 0',
    ids(ranked)[0], oid(74));
  check('R6 THE AMENDMENT: tier 2 pulls the earliest-createdAt catalog entry to index 0 anyway',
    ids(promoteFirstCatalogImage(ranked).slice(0, 1)), [oid(75)]);
  check('R6 and the rest keep their shotType order behind it',
    ids(promoteFirstCatalogImage(ranked)), [oid(75), oid(74), oid(73)]);
}

{
  // wantsVideo penalizes burned text within a tier; the promotion still wins.
  const clean = entry(media(oid(80), { shotType: 'lifestyle', imageRole: 'alt' }), 'catalog');
  const hero  = entry(media(oid(81), { shotType: 'lifestyle', imageRole: 'hero', burnedText: true }), 'catalog');
  const ranked = rankMergedPool([hero, clean], { wantsVideo: true });
  check('R4 wantsVideo sinks the burned-text catalog image in the ranker', ids(ranked), [oid(80), oid(81)]);
  check('R4 promoteFirstCatalogImage overrides that penalty (owner rule wins)',
    ids(promoteFirstCatalogImage(ranked)), [oid(81), oid(80)]);
}

{
  // The shared ranker is untouched: within one tier, imageRole=hero still
  // beats alt. (That tiebreak is rankMergedPool's, not the cascade's.)
  const alt  = entry(media(oid(90), { shotType: 'lifestyle', imageRole: 'alt'  }), 'catalog');
  const hero = entry(media(oid(91), { shotType: 'lifestyle', imageRole: 'hero' }), 'catalog');
  check('R5 rankMergedPool still applies the within-tier imageRole=hero tiebreak',
    ids(rankMergedPool([alt, hero], {})), [oid(91), oid(90)]);
}

// ── stubs for the buildSeededUniverse cases ──────────────────────────
//
// Assignment-stubbing the model statics (same pattern as
// verifyGeminiSearchCost.js stubAxios / verifySlackAlert.js global fetch).
// The chains the service actually uses:
//   Media.find(q).select(s).lean()            (UGC + product catalog)
//   Media.find(q).select(s).limit(n).lean()   (brand-mode catalog)
//   CatalogProduct.findById(id).select(s).lean()
//   ProductMatchArtifact.find(q).select(s).lean()

function cursorOf(docs) {
  const c = {
    select: () => c,
    limit:  () => c,
    lean:   async () => docs.slice()
  };
  return c;
}

async function withStubs({ catalog = [], ugc = [], matchedMedia = [], brandMatches = [] }, fn) {
  const origFind        = Media.find;
  const origFindById    = CatalogProduct.findById;
  const origPmaFind     = ProductMatchArtifact.find;
  const byId = new Map([...catalog, ...ugc].map(d => [String(d._id), d]));
  Media.find = (q) => {
    if (q && q._id && Array.isArray(q._id.$in)) {
      return cursorOf(q._id.$in.map(String).map(id => byId.get(id)).filter(Boolean));
    }
    if (q && q.source === 'catalog-product') return cursorOf(catalog);
    return cursorOf([]);
  };
  CatalogProduct.findById = () => ({
    select: () => ({ lean: async () => ({ matchedMedia }) })
  });
  ProductMatchArtifact.find = () => cursorOf(brandMatches);
  try {
    return await fn();
  } finally {
    Media.find              = origFind;
    CatalogProduct.findById = origFindById;
    ProductMatchArtifact.find = origPmaFind;
  }
}

// Capture the service's operator-facing log lines so a green run also proves
// they fire — and keeps this harness's own stdout to one summary line.
async function withCapturedLogs(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = orig;
  }
}

// ── B / L: buildSeededUniverse end to end ────────────────────────────

async function main() {
  const heroDoc = media(oid(100), { shotType: 'product_only', imageRole: 'hero' });
  const altDoc  = media(oid(101), { shotType: 'lifestyle',    imageRole: 'alt'  });
  const ugcDoc  = media(oid(102), { shotType: 'lifestyle', source: 'instagram', engagement: 500 });
  const FIXT = {
    catalog: [heroDoc, altDoc],
    ugc: [ugcDoc],
    matchedMedia: [{ mediaId: oid(102), matchTier: 'product_match' }]
  };

  // B1 — baseline: the option off reproduces today's behaviour exactly.
  const base = await withStubs(FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 1 })
  ));
  check('B1 default (option absent) still hands the Director the UGC post at topN=1',
    universeIds(base.value.universe), [oid(102)]);
  check('B1 default universe[0].role is ugc_product_match (the shipped bug)',
    base.value.universe[0].role, 'ugc_product_match');
  check('L3 option absent logs no promotion line', base.lines.filter(l => /🎯/.test(l)).length, 0);

  // B2 — the fix, at the money shape (topN === 1), tier 1.
  const fixed = await withStubs(FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 1, preferFirstCatalogImage: true })
  ));
  check('B2 preferFirstCatalogImage at topN=1 yields exactly the catalog first image',
    universeIds(fixed.value.universe), [oid(100)]);
  check('B2 that entry is role=catalog', fixed.value.universe[0].role, 'catalog');
  check('B2 and carries metadata.imageRole=hero to the Director',
    fixed.value.universe[0].metadata.imageRole, 'hero');
  check('B7 counts are unchanged by the promotion (order-only change)',
    fixed.value.counts, base.value.counts);
  check('B6 seedUniverseHash changes with the promoted order (expect inspectImageSelection to report DRIFTED once)',
    fixed.value.seedUniverseHash === base.value.seedUniverseHash, false);
  checkTrue('L1 promotion logs the promoted mediaId, its previous rank and the tier',
    fixed.lines.some(l => l.includes(oid(100)) && /promoted to index 0/.test(l)
      && /from rank \d+/.test(l) && /tier 1 \(imageRole='hero'\)/.test(l)));

  // B9 — TIER 2 END TO END, same money shape. No catalog doc carries the
  // imageRole stamp, so tier 1 matches nothing; the earliest-createdAt catalog
  // doc must still beat the UGC post the ranker put at index 0.
  const T2_FIXT = {
    catalog: [
      media(oid(130), { shotType: 'lifestyle', createdAt: '2026-06-06T00:00:00.000Z' }),
      media(oid(131), { shotType: 'detail',    createdAt: '2023-03-03T00:00:00.000Z' })
    ],
    ugc: [media(oid(132), { shotType: 'lifestyle', source: 'instagram', engagement: 900, createdAt: '2026-07-07T00:00:00.000Z' })],
    matchedMedia: [{ mediaId: oid(132), matchTier: 'product_match' }]
  };
  const t2Base = await withStubs(T2_FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 1 })
  ));
  check('B9 unstamped pool, option OFF: the Director gets the UGC post (the hole tier 2 closes)',
    universeIds(t2Base.value.universe), [oid(132)]);
  const t2Fixed = await withStubs(T2_FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 1, preferFirstCatalogImage: true })
  ));
  check('B9 unstamped pool, option ON: tier 2 yields the earliest-createdAt CATALOG doc',
    universeIds(t2Fixed.value.universe), [oid(131)]);
  check('B9 that entry is role=catalog (never UGC)', t2Fixed.value.universe[0].role, 'catalog');
  check('B9 and it carries NO imageRole stamp — tier 2, not tier 1',
    t2Fixed.value.universe[0].metadata.imageRole, null);
  checkTrue('L4 the tier-2 promotion names tier 2 in the log',
    t2Fixed.lines.some(l => l.includes(oid(131)) && /promoted to index 0/.test(l)
      && /tier 2 \(earliest catalog createdAt\)/.test(l)));
  const t2Wide = await withStubs(T2_FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 10, preferFirstCatalogImage: true })
  ));
  check('B9 topN=10 → tier-2 winner first, then the untouched shotType ranking',
    universeIds(t2Wide.value.universe), [oid(131), oid(132), oid(130)]);

  // B3 — a wider window keeps the shotType ranking behind the pinned image.
  const wide = await withStubs(FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 10, preferFirstCatalogImage: true })
  ));
  check('B3 topN=10 → catalog first image first, then the untouched shotType ranking',
    universeIds(wide.value.universe), [oid(100), oid(102), oid(101)]);

  // B4 — THE OVERRIDE. Operator picks must not be re-ordered.
  const picked = await withStubs(FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, {
      topN: 2,
      preferFirstCatalogImage: true,
      restrictToMediaIds: [oid(100), oid(101)]
    })
  ));
  check('B4 restrictToMediaIds keeps shotType order — the catalog first image is NOT hoisted',
    universeIds(picked.value.universe), [oid(101), oid(100)]);
  check('B4 the override branch logs no promotion',
    picked.lines.filter(l => /promoted to index 0/.test(l)).length, 0);

  // B5 — brand-only mode: "the catalog's first image" is undefined across SKUs,
  // so the gate must hold.
  const brandHero = media(oid(110), { shotType: 'product_only', imageRole: 'hero' });
  const brandAlt  = media(oid(111), { shotType: 'lifestyle',    imageRole: 'alt'  });
  const brandOnly = await withStubs(
    { catalog: [brandHero, brandAlt], ugc: [], brandMatches: [] },
    () => withCapturedLogs(() => buildSeededUniverse(BRAND_ID, null, { topN: 2, preferFirstCatalogImage: true }))
  );
  check('B5 brand-only run is NOT promoted (every SKU pools its own catalog media)',
    universeIds(brandOnly.value.universe), [oid(111), oid(110)]);
  check('B5 brand-only logs no promotion',
    brandOnly.lines.filter(l => /promoted to index 0/.test(l)).length, 0);

  // B8 — opt-in is strict: only === true enables it.
  const truthy = await withStubs(FIXT, () => withCapturedLogs(() =>
    buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 1, preferFirstCatalogImage: 'yes' })
  ));
  check('B8 truthy-but-not-true preferFirstCatalogImage does NOT enable the promotion',
    universeIds(truthy.value.universe), [oid(102)]);

  // L2 — TIER 3 end to end: requested, but the pool holds no catalog entry at
  // all. The ranked winner (a UGC post) stands, and the service says so.
  const noCatalog = await withStubs(
    {
      catalog: [],
      ugc: [media(oid(120), { shotType: 'lifestyle', source: 'instagram', engagement: 300 })],
      matchedMedia: [{ mediaId: oid(120), matchTier: 'product_match' }]
    },
    () => withCapturedLogs(() => buildSeededUniverse(BRAND_ID, PRODUCT_ID, { topN: 1, preferFirstCatalogImage: true }))
  );
  check('L2 tier-3 pool (no catalog entry) still returns the ranked winner',
    universeIds(noCatalog.value.universe), [oid(120)]);
  check('L2 tier 3 promotes nothing', noCatalog.lines.filter(l => /promoted to index 0/.test(l)).length, 0);
  checkTrue('L2 and says so once, out loud',
    noCatalog.lines.some(l => /no catalog entry in the pool/.test(l)));

  // ── S: source wiring a unit test cannot see ────────────────────────
  //
  // Discipline (session.md): source pins must strip comments and assert
  // PROXIMITY. Two pins here previously would have passed on a comment or on
  // an identical expression elsewhere in the file.

  const ROOT     = path.join(__dirname, '..');
  const seedPath = path.join(ROOT, 'services', 'seededUniverseService.js');
  const genPath  = path.join(ROOT, 'services', 'campaignAdsGenerationService.js');

  // Blank block comments (preserving newlines) and whole-line // comments, so
  // the long WHY comments in both files cannot satisfy a pin.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => (/^\s*\/\//.test(l) ? '' : l))
      .join('\n');
  }
  // Brace-matched extraction, so a pin is scoped to ONE construct.
  // skipParens skips a signature's parameter list first — without it,
  // `function rankMergedPool(entries, { wantsVideo = false } = {})` returns the
  // destructured default `{ wantsVideo = false }` as the "body" and every pin
  // inside it silently passes.
  function braceBlock(src, needle, { skipParens = false } = {}) {
    const at = src.indexOf(needle);
    if (at < 0) return '';
    let start = at;
    if (skipParens) {
      const p = src.indexOf('(', at);
      if (p >= 0) {
        let depth = 0;
        for (let i = p; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') { depth--; if (depth === 0) { start = i + 1; break; } }
        }
      }
    }
    const open = src.indexOf('{', start);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return '';
  }
  const bodyOf = (src, needle) => braceBlock(src, needle, { skipParens: true });

  const seedSrc = stripComments(fs.readFileSync(seedPath, 'utf8'));
  const genSrc  = stripComments(fs.readFileSync(genPath, 'utf8'));

  checkTrue('S1 seededUniverseService exports promoteFirstCatalogImage',
    typeof promoteFirstCatalogImage === 'function' &&
    /promoteFirstCatalogImage,/.test(braceBlock(seedSrc, 'module.exports =')));

  checkTrue('S1 the old hero-only identifiers are GONE from the service',
    !/promoteCatalogHero|preferCatalogHero/.test(fs.readFileSync(seedPath, 'utf8')));

  checkTrue('S2 preferFirstCatalogImage is strict opt-in (=== true), so it defaults FALSE',
    /const preferFirstCatalogImage = opts\.preferFirstCatalogImage === true;/.test(seedSrc));

  checkTrue('S3 the promotion is gated on preferFirstCatalogImage AND !isBrandOnly',
    /if \(preferFirstCatalogImage && !isBrandOnly\) \{/.test(seedSrc));

  {
    // ORDER pins, inside buildSeededUniverse only.
    const body = bodyOf(seedSrc, 'async function buildSeededUniverse');
    checkTrue('S4 buildSeededUniverse body extracted', body.length > 500);
    const callAt   = body.indexOf('promoteFirstCatalogImage(ranked)');
    const firstCut = body.indexOf('universe.slice(0, topN)');
    const lastCut  = body.lastIndexOf('universe.slice(0, topN)');
    const projAt   = body.lastIndexOf('ranked.map(x => projectEntry(');
    checkTrue('S4 promoteFirstCatalogImage(ranked) is called in buildSeededUniverse', callAt > 0);
    checkTrue('S4 two universe.slice(0, topN) sites remain (override branch + auto-assembly)',
      firstCut > 0 && lastCut > firstCut);
    checkTrue('S4 the promotion runs AFTER the override branch returns (call > first slice)',
      callAt > firstCut);
    checkTrue('S4 the promotion runs BEFORE the auto-assembly trim (call < last slice)',
      callAt < lastCut);
    checkTrue('S4 the promotion runs BEFORE projectEntry flattens the wrappers',
      projAt > 0 && callAt < projAt);
  }

  {
    // THE CASCADE, pinned in source. A unit test proves the behaviour; these
    // pin the SHAPE, so a refactor cannot quietly drop a tier or un-gate one.
    const helper = bodyOf(seedSrc, 'function promoteFirstCatalogImage');
    checkTrue('S8 promoteFirstCatalogImage body extracted', helper.length > 200);
    // WIDENED 2026-08-03, and the widening is the point. This pin used to demand
    // the membership test be EXACTLY `role === 'catalog'`. That was too narrow to
    // be correct: role==='catalog' means source==='catalog-product', which
    // INCLUDES catalog VIDEOS (shopifyPublicIngestService writes
    // fileType:'video' + metadata.imageRole:'video' under that same source), so
    // tier 2 could hand a STATIC image generation an .mp4. The membership test
    // must therefore gate on role AND reject an explicit video — pinned as three
    // separate assertions so a refactor cannot drop one silently.
    checkTrue("S8 membership requires role === 'catalog'",
      /const isCatalog = \(e\) =>[\s\S]{0,200}?e\.role === 'catalog'/.test(helper));
    checkTrue('S8 membership rejects fileType video (a catalog VIDEO is not the first catalog IMAGE)',
      /const isCatalog = \(e\) =>[\s\S]{0,300}?e\.media\?\.fileType !== 'video'/.test(helper));
    checkTrue('S8 membership also rejects the imageRole video stamp (defence in depth)',
      /const isCatalog = \(e\) =>[\s\S]{0,300}?e\.media\?\.metadata\?\.imageRole !== 'video'/.test(helper));
    checkTrue('S8 membership does NOT demand fileType === image (legacy untyped rows stay eligible for tier 2)',
      !/fileType === 'image'/.test(helper));
    checkTrue('S8 TIER 1 is role-gated AND stamp-gated',
      /findIndex\(\s*\(e\) => isCatalog\(e\) && e\.media\?\.metadata\?\.imageRole === 'hero'\s*\)/.test(helper));
    checkTrue('S8 TIER 2 only runs when tier 1 found nothing',
      /if \(idx < 0\) \{/.test(helper));
    checkTrue('S8 TIER 2 skips every non-catalog entry (so the cascade can never resolve to UGC)',
      /if \(!isCatalog\(rankedEntries\[i\]\)\) continue;/.test(helper));
    checkTrue('S8 TIER 2 keeps the earliest createdAt with a STRICT < (ties keep ranked order)',
      /if \(idx < 0 \|\| t < best\) \{ idx = i; best = t; \}/.test(helper));
    checkTrue('S8 a missing / unparseable createdAt maps to Infinity, not epoch 0',
      /return Number\.isFinite\(t\) \? t : Infinity;/.test(helper));
    checkTrue('S8 TIER 3 / already-first is the `idx <= 0` bail',
      /if \(idx <= 0\) return rankedEntries\.slice\(\);/.test(helper));
  }

  {
    // The override branch must not promote — it IS the user override.
    const branch = braceBlock(seedSrc, 'if (restrictToMediaIds) {');
    checkTrue('S5 restrictToMediaIds branch extracted', /rankMergedPool\(pool/.test(branch));
    checkTrue('S5 restrictToMediaIds branch does NOT call promoteFirstCatalogImage',
      !/promoteFirstCatalogImage/.test(branch));
    checkTrue('S5 restrictToMediaIds branch still returns its own trimmed universe',
      /return \{ universe: trimmed/.test(branch));
  }

  {
    // The shared ranker must stay shared-safe: both branches call it.
    const ranker = bodyOf(seedSrc, 'function rankMergedPool');
    checkTrue('S7 rankMergedPool body extracted', /shotType/.test(ranker));
    checkTrue('S7 the promotion was NOT folded into rankMergedPool (it would re-order operator picks)',
      !/promoteFirstCatalogImage/.test(ranker));
    checkTrue('S7 promoteFirstCatalogImage does not sort — it only splices the ranked pool',
      !/\.sort\(/.test(bodyOf(seedSrc, 'function promoteFirstCatalogImage')));
  }

  {
    // The live caller. Scoped to the buildSeededUniverse argument object so a
    // matching string 80 lines away cannot satisfy this.
    const callObj = braceBlock(genSrc, 'seededUniverseSvc.buildSeededUniverse(brandId, productId, {');
    checkTrue('S6 buildSeededUniverse call object extracted', /topN: universeTopN/.test(callObj));
    checkTrue('S6 the live caller passes preferFirstCatalogImage',
      /preferFirstCatalogImage:/.test(callObj));
    checkTrue('S6 gated on !operatorPickedMedia && resolvedKinds.includes(\'image\')',
      /preferFirstCatalogImage: !operatorPickedMedia && resolvedKinds\.includes\('image'\)/.test(callObj));
    checkTrue('S6 the call still keeps restrictToMediaIds as the override',
      /restrictToMediaIds: operatorPickedMedia \? mediaIds : null/.test(callObj));
    checkTrue('S6 operator multi-select still widens the window',
      /Math\.max\(\s*mediaIds\.length\s*,\s*DIRECTOR_UNIVERSE_TOP_N\s*\)/.test(genSrc));
  }

  // ── report ─────────────────────────────────────────────────────────

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifySeededUniverseHeroDefault: ${pass}/${total} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`verifySeededUniverseHeroDefault: ${pass}/${total} passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('verifySeededUniverseHeroDefault crashed:', err);
  process.exit(1);
});
