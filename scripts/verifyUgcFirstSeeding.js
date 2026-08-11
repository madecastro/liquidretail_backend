#!/usr/bin/env node
'use strict';
//
// verifyUgcFirstSeeding — pins the UGC-ads Phase 3 preferUgcMediaId
// cascade. Two functions and one kill switch:
//
//   1. seededUniverseService.promoteUgcFirst              (pure helper)
//   2. seededUniverseService.buildSeededUniverse          (main entry)
//      threads opts.preferUgcMediaId → promoteUgcFirst
//   3. Kill switch UGC_FIRST_SEEDING (default ON). When OFF, the option
//      is IGNORED and behaviour is byte-identical to omitting it.
//
// The Phase 2 wizard passes preferUgcMediaId unconditionally, so the
// kill switch is the single revert lever between "wizard has UGCs at
// seed 0" and "wizard has UGCs at whatever the shotType ranking
// decided" (which was the pre-Phase-3 behaviour with the wizard's
// mediaIds shape). This harness proves that lever works both ways.
//
// Interaction with promoteFirstCatalogImage is the load-bearing part:
// buildSeededUniverse applies catalog-first FIRST and UGC-first LAST,
// so [UGC, catalog-first, rest] is the intended output. The reverse
// order would let the catalog cascade displace the UGC — a class of
// regression that has bitten adjacent cascades before, so the harness
// asserts the ORDERING, not just that both fired.
//
// Offline: no DB, no network, no key. Uses the exported promoteUgcFirst
// helper directly for unit-level checks and constructs entry wrappers
// by hand for buildSeededUniverse-shaped input.

const mongoose = require('mongoose');
const {
  promoteUgcFirst,
  promoteFirstCatalogImage,
  isUgcFirstSeedingEnabled
} = require('../services/seededUniverseService');

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

function oid(n) { return new mongoose.Types.ObjectId(`68fb${String(n).padStart(20, '0')}`); }

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

// Compact entry wrapper. buildSeededUniverse's ranked pool is [{ media, role }];
// promoteUgcFirst and promoteFirstCatalogImage both operate on that shape.
function e(id, { role = 'ugc_brand_match', feedIndex = null, imageRole = null, fileType = 'image' } = {}) {
  return {
    role,
    media: {
      _id: id,
      fileType,
      metadata: { feedIndex, imageRole }
    }
  };
}

// ── 1. Kill switch reader ──────────────────────────────────────────────
(function testKillSwitch() {
  withEnv({ UGC_FIRST_SEEDING: null }, () => {
    check('K1 unset env → default ON', isUgcFirstSeedingEnabled(), true);
  });
  withEnv({ UGC_FIRST_SEEDING: '' }, () => {
    check('K2 empty env → default ON', isUgcFirstSeedingEnabled(), true);
  });
  withEnv({ UGC_FIRST_SEEDING: 'true' }, () => {
    check('K3 "true" → ON', isUgcFirstSeedingEnabled(), true);
  });
  withEnv({ UGC_FIRST_SEEDING: 'false' }, () => {
    check('K4 "false" → OFF', isUgcFirstSeedingEnabled(), false);
  });
  withEnv({ UGC_FIRST_SEEDING: '0' }, () => {
    check('K5 "0" → OFF', isUgcFirstSeedingEnabled(), false);
  });
  withEnv({ UGC_FIRST_SEEDING: 'no' }, () => {
    check('K6 "no" → OFF', isUgcFirstSeedingEnabled(), false);
  });
  withEnv({ UGC_FIRST_SEEDING: 'off' }, () => {
    check('K7 "off" → OFF', isUgcFirstSeedingEnabled(), false);
  });
  withEnv({ UGC_FIRST_SEEDING: 'anything-else' }, () => {
    check('K8 unknown non-off value → ON (fail-open)', isUgcFirstSeedingEnabled(), true);
  });
})();

// ── 2. promoteUgcFirst — pure helper contract ──────────────────────────
(function testPromoteUgcFirst() {
  const ugcId = oid(1);
  const catalogId = oid(2);
  const otherUgcId = oid(3);

  // P1 — the target is at position 3, hoisted to 0. Every other entry
  // preserves relative order.
  {
    const pool = [
      e(catalogId,   { role: 'catalog' }),
      e(otherUgcId,  { role: 'ugc_brand_match' }),
      e(oid(10),     { role: 'ugc_product_match' }),
      e(ugcId,       { role: 'ugc_product_match' }),
      e(oid(11),     { role: 'catalog' })
    ];
    const out = promoteUgcFirst(pool, String(ugcId));
    check('P1 target at pos 3 → hoisted to 0', out.map(x => String(x.media._id)), [
      String(ugcId), String(catalogId), String(otherUgcId), String(oid(10)), String(oid(11))
    ]);
    // P1b — input array not mutated.
    check('P1b input array not mutated (pure)', pool.map(x => String(x.media._id)), [
      String(catalogId), String(otherUgcId), String(oid(10)), String(ugcId), String(oid(11))
    ]);
  }

  // P2 — target already at 0 → identical slice, no move.
  {
    const pool = [
      e(ugcId,      { role: 'ugc_product_match' }),
      e(catalogId,  { role: 'catalog' })
    ];
    const out = promoteUgcFirst(pool, String(ugcId));
    check('P2 target already at 0 → no move', out.map(x => String(x.media._id)), [
      String(ugcId), String(catalogId)
    ]);
    // P2b — the slice IS still a new array (function contract), not the same ref.
    checkTrue('P2b returns a new array, not the input ref', out !== pool);
  }

  // P3 — target not in pool → identical slice, logs but does not throw.
  {
    const pool = [
      e(catalogId,  { role: 'catalog' }),
      e(otherUgcId, { role: 'ugc_brand_match' })
    ];
    const out = promoteUgcFirst(pool, String(ugcId));
    check('P3 target not in pool → no-op', out.map(x => String(x.media._id)), [
      String(catalogId), String(otherUgcId)
    ]);
  }

  // P4 — empty/null/short inputs.
  check('P4a empty array → empty array',   promoteUgcFirst([], String(ugcId)), []);
  check('P4b single entry → single entry', promoteUgcFirst([e(ugcId)], String(ugcId)).length, 1);
  check('P4c null pool → empty array',     promoteUgcFirst(null, String(ugcId)), []);
  check('P4d undefined pool → empty',      promoteUgcFirst(undefined, String(ugcId)), []);

  // P5 — no target id / bad target.
  {
    const pool = [
      e(catalogId,  { role: 'catalog' }),
      e(ugcId,      { role: 'ugc_product_match' })
    ];
    check('P5a null mediaId → identical slice', promoteUgcFirst(pool, null).map(x => String(x.media._id)), [
      String(catalogId), String(ugcId)
    ]);
    check('P5b empty string mediaId → identical slice', promoteUgcFirst(pool, '').map(x => String(x.media._id)), [
      String(catalogId), String(ugcId)
    ]);
    check('P5c undefined mediaId → identical slice', promoteUgcFirst(pool, undefined).map(x => String(x.media._id)), [
      String(catalogId), String(ugcId)
    ]);
  }

  // P6 — mediaId is passed as a plain string; entry ids are ObjectIds.
  // The helper coerces both sides via String(...) — this is load-bearing:
  // ad.mediaId in Mongo is an ObjectId, req.body.preferUgcMediaId is a
  // hex string, and a strict === compare would never match.
  {
    const pool = [
      e(oid(50), { role: 'catalog' }),
      e(oid(51), { role: 'ugc_product_match' })
    ];
    const out = promoteUgcFirst(pool, oid(51).toString());
    check('P6 string mediaId matches ObjectId entry id', out.map(x => String(x.media._id)), [
      String(oid(51)), String(oid(50))
    ]);
  }
})();

// ── 3. Ordering vs promoteFirstCatalogImage ────────────────────────────
// The load-bearing part. buildSeededUniverse applies:
//   ranked → promoteFirstCatalogImage → promoteUgcFirst → projectEntry
// The reverse order would let catalog-first replace the UGC at index 0.
// This test simulates the exact sequence.
(function testOrdering() {
  const catalogHero = oid(100); // this is what catalog-first will pull to 0
  const catalogAlt  = oid(101);
  const ugcPick     = oid(102);
  const otherUgc    = oid(103);

  const initialRanked = [
    e(catalogAlt,   { role: 'catalog', feedIndex: 1 }),
    e(otherUgc,     { role: 'ugc_brand_match' }),
    e(catalogHero,  { role: 'catalog', feedIndex: 0 }),   // the merchant feed primary
    e(ugcPick,      { role: 'ugc_product_match' })        // the wizard's pick
  ];

  // Step 1 — catalog-first cascade. Hero (feedIndex:0) hoists to 0.
  const afterCatalog = promoteFirstCatalogImage(initialRanked);
  check('O1 catalog-first hoisted feedIndex:0 hero to 0',
    afterCatalog.map(x => String(x.media._id)), [
      String(catalogHero), String(catalogAlt), String(otherUgc), String(ugcPick)
    ]);

  // Step 2 — UGC-first cascade on the same pool. Wizard pick hoists to 0;
  // hero drops to 1; alts + other UGC preserve relative order behind them.
  const afterUgc = promoteUgcFirst(afterCatalog, String(ugcPick));
  check('O2 UGC-first hoisted wizard pick to 0, catalog hero drops to 1',
    afterUgc.map(x => String(x.media._id)), [
      String(ugcPick), String(catalogHero), String(catalogAlt), String(otherUgc)
    ]);

  // O3 — the REGRESSION test. Reverse the order and the catalog cascade
  // displaces the UGC. This is what the code carefully avoids doing.
  const wrongOrder1 = promoteUgcFirst(initialRanked, String(ugcPick));
  const wrongOrder2 = promoteFirstCatalogImage(wrongOrder1);
  checkTrue('O3 REVERSED ORDER would displace the UGC (this is why the code order matters)',
    String(wrongOrder2[0].media._id) !== String(ugcPick));
  check('O3b REVERSED ORDER lands catalog-first at 0 (proves the risk is real)',
    String(wrongOrder2[0].media._id), String(catalogHero));
})();

// ── 4. buildSeededUniverse contract — opts + kill switch ───────────────
// Static source-scan: the buildSeededUniverse function body must
// (a) coerce opts.preferUgcMediaId to a string exactly once,
// (b) gate on isUgcFirstSeedingEnabled(),
// (c) call promoteUgcFirst on the ranked pool BEFORE projectEntry,
// (d) apply it AFTER promoteFirstCatalogImage in the main branch.
//
// This is a source-text check because the branches are hard to trigger
// without a live DB — but the contract is the whole point of Phase 3,
// so a purely runtime test would let a refactor silently break it.
(function testBuildSeededUniverseContract() {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'services', 'seededUniverseService.js'), 'utf8');

  // C1 — the option is coerced through String(...) exactly once at the top
  // of buildSeededUniverse. String() lets an ObjectId be passed transparently.
  checkTrue('C1 opts.preferUgcMediaId is String()-coerced when the flag is on',
    /preferUgcMediaId\s*=\s*opts\.preferUgcMediaId\s*&&\s*isUgcFirstSeedingEnabled\(\)\s*\?\s*String\(opts\.preferUgcMediaId\)\s*:\s*null/m.test(src));

  // C2 — promoteUgcFirst is applied in both branches (operator-picked and
  // main). Two call sites, both gated on `if (preferUgcMediaId)`.
  const ugcCallSites = (src.match(/promoteUgcFirst\(ranked,\s*preferUgcMediaId\)/g) || []).length;
  check('C2 promoteUgcFirst is called in both branches (op-picked + main)', ugcCallSites, 2);

  // C3 — the main branch applies promoteUgcFirst AFTER promoteFirstCatalogImage.
  // A regex scan on the file text: promoteFirstCatalogImage must appear
  // BEFORE the last promoteUgcFirst call in the file.
  const lastCatalog = src.lastIndexOf('promoteFirstCatalogImage(');
  const lastUgc     = src.lastIndexOf('promoteUgcFirst(ranked,');
  checkTrue('C3 UGC-first is applied AFTER catalog-first in the main branch',
    lastCatalog > 0 && lastUgc > lastCatalog);

  // C4 — promoteUgcFirst runs BEFORE projectEntry — otherwise it operates
  // on already-projected entries whose media._id was flattened to
  // entry.mediaId, and the id-compare inside the helper would miss.
  // Assert by scanning for the sequence:  promoteUgcFirst → .map(x => projectEntry
  const seq = /promoteUgcFirst\([^)]*\)[\s\S]*?ranked\.map\(x\s*=>\s*projectEntry/m;
  checkTrue('C4 promoteUgcFirst is applied BEFORE the projectEntry map', seq.test(src));

  // C5 — kill switch reader exists and has the exact fail-open shape
  // (matches the CATALOG_FEED_ORDER_SEEDING reader in the same file, which
  // was already pinned by another harness).
  checkTrue('C5 isUgcFirstSeedingEnabled reads UGC_FIRST_SEEDING env with the fail-open shape',
    /function\s+isUgcFirstSeedingEnabled\s*\(\s*\)\s*\{[\s\S]*?process\.env\.UGC_FIRST_SEEDING[\s\S]*?\/\^\(0\|false\|no\|off\)\$\/i/m.test(src));
})();

// ── 5. Video rail (atlasVideoService.sortCatalogMediasForReferenceStack) ─
// Contract check — the sort accepts opts.preferUgcMediaId and threads it
// through promoteUgcFirst. Not a behavioural test (real data pathway is
// the catalog-only stack), just a "the plumbing exists".
(function testVideoRailContract() {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8');

  // V1 — sortCatalogMediasForReferenceStack takes an opts arg.
  checkTrue('V1 sortCatalogMediasForReferenceStack signature includes opts',
    /function\s+sortCatalogMediasForReferenceStack\s*\(\s*docs\s*,\s*opts\s*=\s*\{\s*\}\s*\)/m.test(src));

  // V2 — it lazily requires promoteUgcFirst + isUgcFirstSeedingEnabled
  // from seededUniverseService (avoids a boot-time cycle-risk require).
  checkTrue('V2 lazy-requires promoteUgcFirst + isUgcFirstSeedingEnabled from seededUniverseService',
    /require\(['"]\.\/seededUniverseService['"]\)/m.test(src)
    && /promoteUgcFirst/.test(src)
    && /isUgcFirstSeedingEnabled/.test(src));

  // V3 — the option only fires when the kill switch is on AND opts is set.
  checkTrue('V3 preferUgcMediaId gated on both opts.preferUgcMediaId AND isUgcFirstSeedingEnabled()',
    /if\s*\(\s*!opts\.preferUgcMediaId\s*\|\|\s*!isUgcFirstSeedingEnabled\(\)\s*\)\s*return\s+sorted/m.test(src));
})();

// ── 6. Regen path (adRegenerateService.runImage) ───────────────────────
// Contract check — regenerate reads CampaignRun.seedUgcIds and applies
// the UGC as the sole reference, ONLY when:
//   - the UGC-first kill switch is on
//   - ad has no operator refs (a manual pick always wins)
//   - ad.variantKind === 'product_image' (matches the catalog-reseed gate)
// AND — critically — the catalog-reseed step is SKIPPED when UGC-first
// already reseeded. That skip is what stops the catalog cascade from
// overwriting the UGC ref, mirroring the seededUniverseService ordering
// this harness proves above.
(function testRegenContract() {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'services', 'adRegenerateService.js'), 'utf8');

  // R1 — CampaignRun is required (used to load seedUgcIds).
  checkTrue('R1 CampaignRun model required', /require\(['"]\.\.\/models\/CampaignRun['"]\)/m.test(src));

  // R2 — isUgcFirstSeedingEnabled is imported from seededUniverseService.
  checkTrue('R2 kill-switch reader imported from seededUniverseService',
    /isUgcFirstSeedingEnabled\s*\}\s*=\s*require\(['"]\.\/seededUniverseService['"]\)/m.test(src));

  // R3 — the UGC reseed gate: kill switch ON + no operator refs +
  // variantKind product_image + campaignRunIds populated.
  checkTrue('R3 UGC reseed gate assembles all four required conditions',
    /!hasOperatorRefs[\s\S]{0,100}isUgcFirstSeedingEnabled\(\)[\s\S]{0,120}variantKind[\s\S]{0,80}product_image[\s\S]{0,120}campaignRunIds/m.test(src));

  // R4 — catalog reseed is SKIPPED when ugcReseeded — this is what keeps
  // the UGC ref intact instead of being clobbered by catalog-first.
  checkTrue('R4 catalog reseed short-circuits when ugcReseeded is true',
    /ugcReseeded\s*\?\s*\{\s*reseed:\s*false/m.test(src));

  // R5 — the UGC latest-run wins (Ad might belong to multiple runs; the
  // most recent one's seed context is the right context to replay).
  checkTrue('R5 UGC seed is read from the LATEST run on the ad',
    /ad\.campaignRunIds\[\s*ad\.campaignRunIds\.length\s*-\s*1\s*\]/m.test(src));

  // R6 — brand-scope safety check on the seed before use — a hard-deleted
  // or cross-tenant UGC id must not crash the render.
  checkTrue('R6 UGC seed is verified to still exist under the ad\'s brandId before use',
    /Media\.exists\(\s*\{\s*_id:\s*ugcId[\s\S]{0,60}brandId:\s*ad\.brandId/m.test(src));
})();

// ── 7. CampaignRun schema — seedUgcIds field exists ────────────────────
(function testCampaignRunSchema() {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'models', 'CampaignRun.js'), 'utf8');
  checkTrue('S1 seedUgcIds field declared on CampaignRun',
    /seedUgcIds\s*:\s*\{\s*type:\s*\[String\]\s*,\s*default:\s*\[\]\s*\}/m.test(src));
})();

// ── 8. routes/ads.js — /generate stamps seedUgcIds + threads option ────
(function testGenerateRoute() {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'ads.js'), 'utf8');

  // G1 — the route destructures preferUgcMediaId from the body with a
  // default of null (so unaware callers are unaffected).
  checkTrue('G1 preferUgcMediaId defaulted to null in the /generate body destructure',
    /preferUgcMediaId\s*=\s*null/m.test(src));

  // G2 — CampaignRun.create stamps seedUgcIds from preferUgcMediaId.
  checkTrue('G2 CampaignRun.create stamps seedUgcIds from preferUgcMediaId',
    /seedUgcIds:\s*preferUgcMediaId\s*\?\s*\[String\(preferUgcMediaId\)\]\s*:\s*\[\]/m.test(src));

  // G3 — the option is passed to expandWizardJob.
  checkTrue('G3 preferUgcMediaId is threaded into expandWizardJob',
    /expandWizardJob\(\{[\s\S]*?preferUgcMediaId[\s\S]*?\}\)/m.test(src));
})();

// ── Report ─────────────────────────────────────────────────────────────
console.log(failures.length
  ? `\nverifyUgcFirstSeeding: ${failures.length} FAILED`
  : 'verifyUgcFirstSeeding: all checks passed');
process.exit(failures.length ? 1 : 0);
