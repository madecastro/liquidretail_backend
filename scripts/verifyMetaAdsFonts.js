#!/usr/bin/env node
'use strict';
/**
 * verifyMetaAdsFonts — offline guard for Meta-ads font identification.
 *
 * WHY THIS EXISTS
 * This service spends money in two places (a vision LLM call and an Apify
 * scrape) to produce something weaker than the website ingest: a typeface NAME
 * read off a raster creative, not a font file. Three things therefore have to
 * hold, and none of them is visible by reading the happy path:
 *   · a malformed model verdict degrades to "identified nothing", never throws
 *     and never fabricates a face
 *   · only HIGH confidence may be promoted as the brand's real face
 *   · neither billable path can fire on nothing, and the Apify run is ledgered
 *
 * REVERT MAP (which checks fail if each part is undone):
 *   (1) parse hardened against off-contract model output → P*
 *   (2) confidence gate on exact promotion → G*
 *   (3) tier order (free before billable) → O1
 *   (4) Apify run ledgered → L1/L2
 *   (5) visionImages passed to the ledger → V1
 *   (6) no vision call with zero images → Z1/Z2
 *   (7) ladder wiring: high→exact-only, low→substitutable, theme guard → W*
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyMetaAdsFonts.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
// Async checks are QUEUED and run STRICTLY IN ORDER, never concurrently.
// Several of them mutate process.env (kill switch, APIFY_ADLIB_ACTOR) and
// restore it in a finally. Run them in parallel and a later check's restore
// lands while an earlier one is still awaiting — which produced two false
// failures that looked exactly like product bugs.
const queue = [];
function check(label, fn) {
  queue.push(async () => {
    try { await fn(); pass++; }
    catch (err) { failures.push(`${label}: ${err.message}`); }
  });
}

const svc = require('../services/metaAdsFontService');
const {
  parseFontIdentification, usableForExact, coerceConfidence,
  extractCreativeImageUrl, extractUrlsFromAdLibraryItem, identifyBrandAdFonts,
} = svc;
const { buildFontLadders } = require('../services/fontResolverService');
const { applyMetaFontsResult } = require('../services/brandFontPersistenceService');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'metaAdsFontService.js'), 'utf8');

console.log('\nverifyMetaAdsFonts — vision parse, confidence gate, spend guards\n');

// ── P. Parse tolerance. Fails if (1) is reverted. ──────────────────────────
check('P1 well-formed JSON parses both roles', () => {
  const r = parseFontIdentification(JSON.stringify({
    heading: { family: 'Futura', confidence: 'high', closestGoogle: 'Montserrat' },
    body: { family: 'Akzidenz', confidence: 'medium', closestGoogle: 'Inter' },
  }));
  assert.strictEqual(r.parseError, null);
  assert.strictEqual(r.heading.family, 'Futura');
  assert.strictEqual(r.heading.confidence, 'high');
  assert.strictEqual(r.heading.closestGoogle, 'Montserrat');
  assert.strictEqual(r.body.confidence, 'medium');
});
check('P2 markdown-fenced JSON is accepted', () => {
  const r = parseFontIdentification('```json\n{"heading":{"family":"Prata","confidence":"high"}}\n```');
  assert.strictEqual(r.parseError, null);
  assert.strictEqual(r.heading.family, 'Prata');
});
check('P3 JSON embedded in prose is recovered', () => {
  const r = parseFontIdentification('Sure! {"heading":{"family":"Oswald","confidence":"low"}} hope that helps');
  assert.strictEqual(r.heading.family, 'Oswald');
});
// The exact shape gemini-2.5-flash produced on the sibling ad-vision-qc task.
check('P4 a bare boolean yields nulls, not a throw', () => {
  const r = parseFontIdentification('true');
  assert.strictEqual(r.heading, null);
  assert.strictEqual(r.body, null);
  assert.ok(r.parseError, 'must record a parse error');
});
check('P5 an array yields nulls', () => {
  const r = parseFontIdentification('[{"family":"Futura"}]');
  assert.strictEqual(r.heading, null);
  assert.ok(r.parseError);
});
check('P6 unparseable text yields nulls', () => {
  const r = parseFontIdentification('I cannot determine the fonts.');
  assert.strictEqual(r.heading, null);
  assert.ok(r.parseError);
});
check('P7 hoisted {family,confidence} is read as the heading', () => {
  const r = parseFontIdentification('{"family":"Canela","confidence":"high"}');
  assert.strictEqual(r.heading.family, 'Canela');
  assert.strictEqual(r.parseError, null);
});
check('P8 a non-string family is rejected, never coerced into a face', () => {
  for (const bad of [42, true, null, {}, [], '', '   ']) {
    const r = parseFontIdentification(JSON.stringify({ heading: { family: bad, confidence: 'high' } }));
    assert.strictEqual(r.heading, null, `family=${JSON.stringify(bad)} must not produce a face`);
  }
});
check('P9 snake_case closest_google is accepted', () => {
  const r = parseFontIdentification('{"heading":{"family":"Ogg","confidence":"high","closest_google":"Prata"}}');
  assert.strictEqual(r.heading.closestGoogle, 'Prata');
});
check('P10 unknown/missing confidence coerces DOWN to low, never up', () => {
  for (const v of [undefined, null, '', 'certain', 'very high', 'HIGH!', 99]) {
    assert.strictEqual(coerceConfidence(v), 'low', `confidence ${JSON.stringify(v)} must coerce to low`);
  }
  assert.strictEqual(coerceConfidence('HIGH'), 'high', 'case-insensitive high must survive');
  assert.strictEqual(coerceConfidence(' medium '), 'medium');
});
check('P11 parse never throws on any hostile input', () => {
  for (const bad of [undefined, null, 0, '', '{', '{"heading":', [], {}, { heading: 'Futura' }, NaN]) {
    const r = parseFontIdentification(bad);
    assert.ok(r && typeof r === 'object', `input ${JSON.stringify(bad)} must still return a result`);
  }
});

// ── G. Confidence gate. Fails if (2) is reverted. ─────────────────────────
check('G1 only high confidence is usable as an exact face', () => {
  assert.strictEqual(usableForExact({ family: 'Futura', confidence: 'high' }), true);
  assert.strictEqual(usableForExact({ family: 'Futura', confidence: 'medium' }), false);
  assert.strictEqual(usableForExact({ family: 'Futura', confidence: 'low' }), false);
});
check('G2 a missing/blank family is never usable, whatever the confidence', () => {
  assert.strictEqual(usableForExact({ family: '', confidence: 'high' }), false);
  assert.strictEqual(usableForExact({ confidence: 'high' }), false);
  assert.strictEqual(usableForExact(null), false);
  assert.strictEqual(usableForExact(undefined), false);
});

// ── W. Ladder wiring. Fails if (7) is reverted. ───────────────────────────
const ladderOf = (brand, role = 'heading') =>
  buildFontLadders(brand).ladders[role].filter(([f]) => f);

check('W1 a high-confidence face enters as an EXACT-ONLY tier', () => {
  const t = ladderOf({ metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'high', usableForExact: true } } });
  const exactOnly = t.filter(([f, req]) => /futura/i.test(f) && req === true);
  assert.strictEqual(exactOnly.length, 1, `expected one exact-only Futura tier, got ${JSON.stringify(t)}`);
});
check('W2 a low-confidence face is substitutable ONLY — never exact-only', () => {
  const t = ladderOf({ metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'low', usableForExact: false } } });
  assert.strictEqual(t.filter(([, req]) => req === true).length, 0,
    `a low-confidence guess must not get an exact-only tier: ${JSON.stringify(t)}`);
  assert.ok(t.some(([f]) => /futura/i.test(f)), 'it should still be offered as a weak tier');
});
check('W3 the exact-only meta tier sits BELOW the scraped face', () => {
  const t = ladderOf({
    fontFamily: 'Oswald',
    metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'high', usableForExact: true } },
  });
  const scraped = t.findIndex(([f]) => /oswald/i.test(f));
  const meta = t.findIndex(([f]) => /futura/i.test(f));
  assert.ok(scraped >= 0 && meta >= 0, JSON.stringify(t));
  assert.ok(scraped < meta, 'the website-scanned face outranks an ad identification');
});
check('W4 the exact-only meta tier sits ABOVE the curated theme', () => {
  const t = ladderOf({
    curatedFields: ['styleTheme'], styleTheme: { sansFontFamily: 'DM Sans' },
    metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'high', usableForExact: true } },
  });
  const meta = t.findIndex(([f]) => /futura/i.test(f));
  const theme = t.findIndex(([f]) => /dm sans/i.test(f));
  assert.ok(meta >= 0 && theme >= 0, JSON.stringify(t));
  assert.ok(meta < theme, 'a confidently-identified servable face outranks a theme guess');
});
check('W5 theme-pairing guard: no promotion when the theme already names the face', () => {
  const t = ladderOf({
    curatedFields: ['styleTheme'], styleTheme: { sansFontFamily: 'Futura' },
    metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'high', usableForExact: true } },
  });
  assert.strictEqual(t.filter(([, req]) => req === true).length, 0,
    `the curated pairing already accounts for this face: ${JSON.stringify(t)}`);
});
check('W6 no metaAdsFontUsage changes nothing', () => {
  const before = JSON.stringify(buildFontLadders({ fontFamily: 'Oswald' }).ladders);
  const after = JSON.stringify(buildFontLadders({ fontFamily: 'Oswald', metaAdsFontUsage: null }).ladders);
  assert.strictEqual(before, after);
});
check('W7 the QUOTE ladder is never given an ad-identified face', () => {
  const t = ladderOf({ metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'high', usableForExact: true } } }, 'quote');
  assert.ok(!t.some(([f]) => /futura/i.test(f)),
    `quote is a deliberate pairing choice: ${JSON.stringify(t)}`);
});
check('W8 a confidence-only document (no usableForExact flag) still gates correctly', () => {
  const hi = ladderOf({ metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'high' } } });
  const lo = ladderOf({ metaAdsFontUsage: { heading: { family: 'Futura', confidence: 'low' } } });
  assert.strictEqual(hi.filter(([, r]) => r === true).length, 1, 'high must promote via confidence alone');
  assert.strictEqual(lo.filter(([, r]) => r === true).length, 0, 'low must not promote');
});

// ── Z. No billable call on nothing. Fails if (6) is reverted. ────────────
check('Z1 zero creatives → NO vision call', async () => {
  let called = 0;
  const res = await identifyBrandAdFonts(
    { _id: 'b1', name: 'NoAds', websiteUrl: 'https://example.com' },
    {},
    {
      Campaign: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
      resolveMetaAdsCred: async () => { const e = new Error('none'); e.code = 'no-meta-ads-cred'; throw e; },
      chatCompletion: async () => { called++; return {}; },
      runActorSync: async () => { throw new Error('should not run'); },
    }
  );
  assert.strictEqual(called, 0, 'the billable vision call must not fire without images');
  assert.strictEqual(res.via, 'none');
  assert.strictEqual(res.imagesUsed, 0);
  assert.strictEqual(res.usage.heading, null);
  assert.ok(res.errors.length, 'the reason must be recorded');
});
check('Z2 with creatives → exactly ONE vision call, visionImages matches', async () => {
  let meta = null;
  let calls = 0;
  const ads = [{ creative: { imageUrl: 'https://cdn/a.jpg' }, creativeRef: { creativeId: 'c1' } },
               { creative: { imageUrl: 'https://cdn/b.jpg' }, creativeRef: { creativeId: 'c2' } }];
  const res = await identifyBrandAdFonts(
    { _id: 'b2', name: 'HasAds' },
    { maxImages: 4 },
    {
      Campaign: { find: () => ({ select: () => ({ lean: async () => [{ adSets: [{ ads }] }] }) }) },
      chatCompletion: async (m) => {
        calls++; meta = m;
        return { choices: [{ message: { content: '{"heading":{"family":"Futura","confidence":"high","closestGoogle":"Montserrat"}}' } }] };
      },
    }
  );
  assert.strictEqual(calls, 1, 'exactly one vision call');
  assert.strictEqual(meta.visionImages, 2, `visionImages must equal the real image count, got ${meta.visionImages}`);
  assert.strictEqual(res.imagesUsed, 2);
  assert.strictEqual(res.via, 'campaign-docs');
  assert.strictEqual(res.usage.heading.family, 'Futura');
  assert.strictEqual(res.usage.evidence[0].usableForExact, true);
});
check('Z3 a thrown vision call degrades to no face, not an exception', async () => {
  const ads = [{ creative: { imageUrl: 'https://cdn/a.jpg' } }];
  const res = await identifyBrandAdFonts(
    { _id: 'b3' }, {},
    {
      Campaign: { find: () => ({ select: () => ({ lean: async () => [{ adSets: [{ ads }] }] }) }) },
      chatCompletion: async () => { throw new Error('502 upstream'); },
    }
  );
  assert.strictEqual(res.usage.heading, null);
  assert.ok(res.errors.some((e) => /vision/.test(e)), JSON.stringify(res.errors));
});
check('Z4 free tiers satisfied → the BILLABLE scrape never runs', async () => {
  const prev = process.env.APIFY_ADLIB_ACTOR;
  process.env.APIFY_ADLIB_ACTOR = 'someone/ad-library';
  try {
    let scraped = 0;
    const ads = [{ creative: { imageUrl: 'https://cdn/a.jpg' } }, { creative: { imageUrl: 'https://cdn/b.jpg' } }];
    await identifyBrandAdFonts(
      { _id: 'b4', name: 'X' }, {},
      {
        Campaign: { find: () => ({ select: () => ({ lean: async () => [{ adSets: [{ ads }] }] }) }) },
        runActorSync: async () => { scraped++; return []; },
        chatCompletion: async () => ({ choices: [{ message: { content: '{}' } }] }),
      }
    );
    assert.strictEqual(scraped, 0, 'Apify must not run when free tiers already produced images');
  } finally {
    if (prev === undefined) delete process.env.APIFY_ADLIB_ACTOR;
    else process.env.APIFY_ADLIB_ACTOR = prev;
  }
});

// ── L. Apify ledger. Fails if (4) is reverted. ───────────────────────────
check('L1 an Apify run is LEDGERED, even when it yields no usable images', async () => {
  const prev = process.env.APIFY_ADLIB_ACTOR;
  process.env.APIFY_ADLIB_ACTOR = 'someone/ad-library';
  try {
    const rows = [];
    await identifyBrandAdFonts(
      { _id: 'b5', name: 'ScrapeMe', websiteUrl: 'https://scrape.example' }, {},
      {
        Campaign: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
        resolveMetaAdsCred: async () => { const e = new Error('no cred'); e.code = 'no-meta-ads-cred'; throw e; },
        // Item shape carries nothing usable — the run still billed.
        runActorSync: async () => [{ irrelevant: 'no urls here' }],
        recordFlatCost: async (r) => { rows.push(r); },
        chatCompletion: async () => { throw new Error('should not be reached'); },
      }
    );
    assert.strictEqual(rows.length, 1, 'exactly one cost row for one actor run');
    assert.strictEqual(rows[0].provider, 'apify');
    assert.strictEqual(rows[0].model, 'someone/ad-library');
    assert.strictEqual(rows[0].stage, 'meta_ads_fonts');
    assert.strictEqual(rows[0].brandId, 'b5');
    assert.ok(rows[0].costUsd > 0, 'a billable run must not ledger $0');
    assert.strictEqual(rows[0].costSource, 'estimated');
  } finally {
    if (prev === undefined) delete process.env.APIFY_ADLIB_ACTOR;
    else process.env.APIFY_ADLIB_ACTOR = prev;
  }
});
check('L2 a ledger failure does not abort identification', async () => {
  const prev = process.env.APIFY_ADLIB_ACTOR;
  process.env.APIFY_ADLIB_ACTOR = 'someone/ad-library';
  try {
    const res = await identifyBrandAdFonts(
      { _id: 'b6', name: 'LedgerDown', websiteUrl: 'https://x.example' }, {},
      {
        Campaign: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
        resolveMetaAdsCred: async () => { const e = new Error('no cred'); e.code = 'no-meta-ads-cred'; throw e; },
        runActorSync: async () => [{ imageUrl: 'https://cdn/lib.jpg' }],
        recordFlatCost: async () => { throw new Error('mongo down'); },
        chatCompletion: async () => ({ choices: [{ message: { content: '{"heading":{"family":"Prata","confidence":"high"}}' } }] }),
      }
    );
    assert.strictEqual(res.usage.heading.family, 'Prata', 'identification must still complete');
    assert.strictEqual(res.via, 'adlibrary');
    assert.ok(res.errors.some((e) => /ledger/i.test(e)), 'the ledger failure must be surfaced');
  } finally {
    if (prev === undefined) delete process.env.APIFY_ADLIB_ACTOR;
    else process.env.APIFY_ADLIB_ACTOR = prev;
  }
});
check('L3 the scrape tier is INERT when no actor is configured', async () => {
  const prev = process.env.APIFY_ADLIB_ACTOR;
  delete process.env.APIFY_ADLIB_ACTOR;
  try {
    let ran = 0;
    const res = await identifyBrandAdFonts(
      { _id: 'b7', name: 'NoActor', websiteUrl: 'https://x.example' }, {},
      {
        Campaign: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
        resolveMetaAdsCred: async () => { const e = new Error('no cred'); e.code = 'no-meta-ads-cred'; throw e; },
        runActorSync: async () => { ran++; return []; },
      }
    );
    assert.strictEqual(ran, 0, 'a blank APIFY_ADLIB_ACTOR must not spend');
    assert.ok(res.errors.some((e) => /APIFY_ADLIB_ACTOR not set/.test(e)));
  } finally {
    if (prev !== undefined) process.env.APIFY_ADLIB_ACTOR = prev;
  }
});

// ── O. Tier order: free before billable. Fails if (3) is reverted. ───────
check('O1 gathering runs campaign-docs → connected → adlibrary', () => {
  const docs = SRC.indexOf('Tier 1 — persisted docs.');
  const conn = SRC.indexOf('Tier 2 — live Graph.');
  const lib = SRC.indexOf('Tier 3 — billable public scrape');
  assert.ok(docs > 0 && conn > 0 && lib > 0, 'all three tiers must be present and labelled');
  assert.ok(docs < conn, 'the zero-cost persisted-docs tier must come first');
  assert.ok(conn < lib, 'the free Graph tier must precede the billable scrape');
});
check('O2 the billable scrape is guarded on having found NOTHING', () => {
  const guard = /if \(images\.length === 0\) \{\s*try \{\s*const fromLib = await gatherFromAdLibrary/;
  assert.ok(guard.test(SRC), 'the adlibrary tier must be gated on images.length === 0');
});

// ── V. Ledger linkage on the vision call. Fails if (5) is reverted. ──────
check('V1 the vision call passes visionImages and brandId to the ledger', () => {
  assert.ok(/visionImages:\s*images\.length/.test(SRC),
    'visionImages must be the real image count — it drives the per-image surcharge');
  assert.ok(/brandId:\s*brand\._id \|\| brand\.id \|\| null/.test(SRC), 'brandId must be ledgered');
  assert.ok(/stage:\s*'meta_ads_fonts'/.test(SRC), 'stage must be set for cost attribution');
});
check('V2 response_format is json_object, never json_schema (400s on Anthropic)', () => {
  assert.ok(/response_format:\s*\{\s*type:\s*'json_object'\s*\}/.test(SRC));
  // Match an actual json_schema VALUE, not the word in a comment explaining why
  // it is avoided — the first version of this check failed on its own rationale.
  assert.ok(!/type:\s*'json_schema'/.test(SRC), 'strict json_schema must not be used here');
  assert.ok(!/response_format:\s*\{[^}]*json_schema/.test(SRC), 'no json_schema in response_format');
});

// ── E. Extraction helpers ───────────────────────────────────────────────
check('E1 creative image extraction follows the Graph field priority', () => {
  assert.strictEqual(extractCreativeImageUrl({ image_url: 'https://a' }), 'https://a');
  assert.strictEqual(extractCreativeImageUrl({ object_story_spec: { link_data: { picture: 'https://b' } } }), 'https://b');
  assert.strictEqual(extractCreativeImageUrl({ asset_feed_spec: { images: [{ url: 'https://c' }] } }), 'https://c');
  assert.strictEqual(extractCreativeImageUrl({ thumbnail_url: 'https://d' }), 'https://d');
  assert.strictEqual(extractCreativeImageUrl({}), null);
  assert.strictEqual(extractCreativeImageUrl(null), null);
});
check('E2 ad-library harvest accepts varied shapes and rejects non-URLs', () => {
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem({ imageUrl: 'https://a' }), ['https://a']);
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem({ snapshot: { image_url: 'https://b' } }), ['https://b']);
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem({ images: [{ url: 'https://c' }] }), ['https://c']);
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem({ cards: [{ imageUrl: 'https://d' }] }), ['https://d']);
  // Non-http values must never reach the vision call as an image.
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem({ imageUrl: 'data:image/png;base64,xxx' }), []);
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem({ imageUrl: 42 }), []);
  assert.deepStrictEqual(extractUrlsFromAdLibraryItem(null), []);
});

// ── S. Persistence is narrower than the website path ────────────────────
check('S1 applyMetaFontsResult does NOT write fontFamily/fontSource', () => {
  const brand = { fontFamily: 'Oswald', fontSource: 'website', markModified() {} };
  applyMetaFontsResult(brand, {
    usage: { heading: { family: 'Futura', confidence: 'high' }, body: null, evidence: [] },
    errors: [],
  });
  assert.strictEqual(brand.fontFamily, 'Oswald', 'a NAME read off a JPEG must not become the scanned face');
  assert.strictEqual(brand.fontSource, 'website');
  assert.strictEqual(brand.metaAdsFontUsage.heading.family, 'Futura');
  assert.ok(brand.metaFontsIngestedAt instanceof Date);
});
check('S2 the attempt is stamped even when nothing was identified', () => {
  const brand = { markModified() {} };
  applyMetaFontsResult(brand, { usage: { heading: null, body: null, evidence: [] }, errors: ['no ad creatives found'] });
  assert.ok(brand.metaFontsIngestedAt instanceof Date, 'a miss must still stamp, or a backfill re-pays forever');
  assert.ok(/no ad creatives/.test(brand.metaFontsIngestError));
});

// ── K. Kill switch ──────────────────────────────────────────────────────
check('K1 META_ADS_FONTS_ENABLED=false short-circuits before any spend', async () => {
  const prev = process.env.META_ADS_FONTS_ENABLED;
  process.env.META_ADS_FONTS_ENABLED = 'false';
  try {
    let touched = 0;
    const res = await identifyBrandAdFonts({ _id: 'b8' }, {}, {
      Campaign: { find: () => { touched++; return { select: () => ({ lean: async () => [] }) }; } },
      chatCompletion: async () => { touched++; return {}; },
    });
    assert.strictEqual(touched, 0, 'the kill switch must fire before any work');
    assert.strictEqual(res.via, 'none');
    assert.ok(res.errors.some((e) => /disabled/.test(e)));
  } finally {
    if (prev === undefined) delete process.env.META_ADS_FONTS_ENABLED;
    else process.env.META_ADS_FONTS_ENABLED = prev;
  }
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log('  ✅ verifyMetaAdsFonts green\n');
})();
