#!/usr/bin/env node
'use strict';
//
// verifyCategoryOptions — offline harness for sitemap-derived category
// options (selective import of large catalogs; no PDP fetches).
//
// Pins:
//   A. Real fanatics URL shapes → team/category keys, not locale/empty/slug/id
//   B. Noise suppression: ≤2 chars, pure number, `+` id fragments rejected;
//      a bucket holding >30% of the corpus is flagged suspicious
//   C. Shopify `/collections/skincare/products/…` → `skincare` (not scaffolding)
//   D. matchesAnyCategory is segment-exact (no naive substring false positives)
//   E. Deterministic ordering (count desc, key asc) including ties
//   F. Garbage in → no throw, []
//   G. Flag-off source gate (GENERIC_CATALOG_CATEGORY_OPTIONS=false)
//   H. Resolver wiring: discoverOnly / categories / stats key present in source
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyCategoryOptions.js
//
// REVERT-PROVE: temporarily gut isNoiseSeg to `return false` and confirm the
// junk-bucket checks FAIL; restore and confirm green. Report both numbers.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  deriveCategoryOptions,
  matchesAnyCategory,
  isNoiseSeg,
  humanizeKey,
  SUSPICIOUS_SHARE
} = require('../services/genericCatalogDiscovery/categoryOptions');

let pass = 0;
let total = 0;
const failures = [];

function check(label, cond, detail) {
  total += 1;
  if (cond) {
    pass += 1;
    console.log(`✓ ${label}`);
    return;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
  console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

function checkEq(label, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (typeof actual === 'object' && JSON.stringify(actual) === JSON.stringify(expected));
  check(label, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────

const FANATICS_MTL =
  'https://portal.fanatics.com/en//montreal-canadiens/montreal-canadiens-antigua-womens-team-logo-victory-crewneck-pullover-sweatshirt-navy/o-3562+t-36263077+p-05119726518+z-9-1342644456';
const FANATICS_CAR =
  'https://portal.fanatics.com/en/car/ty-gibbs/-ty-gibbs-antigua-womens-compass-polo-white/o-2446+t-65985274+p-8044331031832+z-9-3637989496';

function fanaticsTeamUrl(team, n) {
  return `https://portal.fanatics.com/en//${team}/${team}-product-slug-item-${n}/o-100+t-200+p-${1000000 + n}+z-9-${n}`;
}

function fanaticsCarUrl(driver, n) {
  return `https://portal.fanatics.com/en/car/${driver}/-${driver}-polo-${n}/o-200+t-300+p-${2000000 + n}+z-9-${n}`;
}

// Build a synthetic corpus large enough that minCount=25 keeps real buckets.
function buildFanaticsCorpus() {
  const urls = [];
  // 40 each of three teams
  for (let i = 0; i < 40; i++) urls.push(fanaticsTeamUrl('buffalo-bills', i));
  for (let i = 0; i < 40; i++) urls.push(fanaticsTeamUrl('new-york-yankees', i));
  for (let i = 0; i < 35; i++) urls.push(fanaticsTeamUrl('montreal-canadiens', i));
  // car / driver shape
  for (let i = 0; i < 30; i++) urls.push(fanaticsCarUrl('ty-gibbs', i));
  // Plus the two full quoted URLs
  urls.push(FANATICS_MTL, FANATICS_CAR);
  return urls;
}

// ── A. Fanatics shapes ────────────────────────────────────────────────

{
  const corpus = buildFanaticsCorpus();
  const opts = deriveCategoryOptions(corpus, { minCount: 25, maxOptions: 40, maxDepth: 2 });
  const keys = opts.map(o => o.key);

  check('A1 derives buffalo-bills', keys.includes('buffalo-bills'));
  check('A2 derives new-york-yankees', keys.includes('new-york-yankees'));
  check('A3 derives montreal-canadiens', keys.includes('montreal-canadiens'));
  check('A4 derives car (depth-1 of car/ty-gibbs path)', keys.includes('car'));

  // Must NOT yield locale, empty, product slug, or +p- id segment as keys
  check('A5 no locale key "en"', !keys.includes('en'));
  check('A6 no empty-string key', !keys.includes(''));
  check('A7 no raw product-slug keys', !keys.some(k => /antigua|crewneck|sweatshirt|pullover/i.test(k)));
  check('A8 no +p- id segment keys', !keys.some(k => k.includes('+') || /\bp-\d/i.test(k)));

  // Single full URL alone is below minCount — use a small minCount to see the key
  const single = deriveCategoryOptions([FANATICS_MTL], { minCount: 1, maxOptions: 10 });
  checkEq('A9 single MTL URL → montreal-canadiens', single[0] && single[0].key, 'montreal-canadiens');
  check('A10 single MTL label is humanised', single[0] && single[0].label === 'Montreal Canadiens');
  check('A11 single MTL sample is the URL (or a prefix)', single[0] && typeof single[0].sample === 'string' && single[0].sample.startsWith('https://portal.fanatics.com'));

  const singleCar = deriveCategoryOptions([FANATICS_CAR], { minCount: 1, maxOptions: 10 });
  const carKeys = singleCar.map(o => o.key);
  check('A12 single car URL → car', carKeys.includes('car'));
  check('A13 single car URL may also yield car/ty-gibbs at depth 2', carKeys.includes('car/ty-gibbs') || carKeys.includes('ty-gibbs') || carKeys.includes('car'));

  // Report the fixture-derived option list for the report-back section
  console.log('   · fanatics fixture options:', opts.map(o => `${o.key} ${o.count}${o.suspicious ? ' [suspicious]' : ''}`).join(' | '));
}

// ── B. Noise suppression ──────────────────────────────────────────────

{
  check('B1 isNoiseSeg rejects ≤2 chars ("b")', isNoiseSeg('b') === true);
  check('B2 isNoiseSeg rejects "ab"', isNoiseSeg('ab') === true);
  check('B3 isNoiseSeg allows "car" (3 chars)', isNoiseSeg('car') === false);
  check('B4 isNoiseSeg rejects pure number', isNoiseSeg('12345') === true);
  check('B5 isNoiseSeg rejects hex-ish blob', isNoiseSeg('a1b2c3d4') === true);
  check('B6 isNoiseSeg rejects + id fragment', isNoiseSeg('o-3562+t-36263077+p-05119726518') === true);
  check('B7 isNoiseSeg rejects a99-style id', isNoiseSeg('a99') === true);
  check('B8 isNoiseSeg allows buffalo-bills', isNoiseSeg('buffalo-bills') === false);

  // Build a corpus where a junk short token would dominate IF accepted
  const junk = [];
  for (let i = 0; i < 40; i++) {
    junk.push(`https://example.com/b/product-slug-${i}/end-${i}`);
  }
  for (let i = 0; i < 40; i++) {
    junk.push(`https://example.com/12345/product-slug-${i}/end-${i}`);
  }
  for (let i = 0; i < 40; i++) {
    junk.push(`https://example.com/x9/product-slug-${i}/end-${i}`);
  }
  for (let i = 0; i < 40; i++) {
    junk.push(`https://example.com/o-1+p-999/product-slug-${i}/end-${i}`);
  }
  // One real category so the list is non-empty for comparison
  for (let i = 0; i < 30; i++) {
    junk.push(`https://example.com/real-category/product-slug-${i}/end-${i}`);
  }
  const junkOpts = deriveCategoryOptions(junk, { minCount: 10, maxOptions: 40 });
  const junkKeys = junkOpts.map(o => o.key);
  check('B9 ≤2-char "b" not in options', !junkKeys.includes('b'));
  check('B10 pure number "12345" not in options', !junkKeys.includes('12345'));
  check('B11 id-frag "x9" not in options', !junkKeys.includes('x9'));
  check('B12 + fragment not in options', !junkKeys.some(k => k.includes('+')));
  check('B13 real-category survives', junkKeys.includes('real-category'));

  // Suspicious: one bucket holds >30% of corpus
  const dominant = [];
  for (let i = 0; i < 100; i++) {
    dominant.push(`https://example.com/lege/product-slug-${i}/end-${i}`);
  }
  for (let i = 0; i < 50; i++) {
    dominant.push(`https://example.com/other-team/product-slug-${i}/end-${i}`);
  }
  // 100/150 = 66% → suspicious. minCount low enough to keep both.
  const domOpts = deriveCategoryOptions(dominant, { minCount: 10, maxOptions: 40 });
  const lege = domOpts.find(o => o.key === 'lege');
  check('B14 dominant "lege" is present', !!lege);
  check('B15 dominant "lege" flagged suspicious', !!(lege && lege.suspicious === true));
  check(`B16 SUSPICIOUS_SHARE is 0.30 (got ${SUSPICIOUS_SHARE})`, SUSPICIOUS_SHARE === 0.30);

  // A balanced bucket is NOT suspicious. Four equal teams → 25% each,
  // under the 30% share flag (three equal teams would each be ~33% and
  // trip the flag — that is intentional for dominant-blob detection).
  const balanced = [];
  for (const team of ['alpha-team', 'beta-team', 'gamma-team', 'delta-team']) {
    for (let i = 0; i < 40; i++) balanced.push(`https://example.com/${team}/item-${i}/end-${i}`);
  }
  const balOpts = deriveCategoryOptions(balanced, { minCount: 10 });
  check('B17 balanced buckets not suspicious', balOpts.length === 4 && balOpts.every(o => !o.suspicious));
}

// ── C. Shopify shapes ─────────────────────────────────────────────────

{
  const shopify = [];
  for (let i = 0; i < 30; i++) {
    shopify.push(`https://shop.example.com/collections/skincare/products/retinol-${i}`);
  }
  for (let i = 0; i < 30; i++) {
    shopify.push(`https://shop.example.com/collections/haircare/products/shampoo-${i}`);
  }
  const opts = deriveCategoryOptions(shopify, { minCount: 10, maxOptions: 40 });
  const keys = opts.map(o => o.key);
  check('C1 skincare derived', keys.includes('skincare'));
  check('C2 haircare derived', keys.includes('haircare'));
  check('C3 collections NOT derived', !keys.includes('collections'));
  check('C4 products NOT derived', !keys.includes('products'));
  check('C5 product NOT derived', !keys.includes('product'));
  check('C6 collection NOT derived', !keys.includes('collection'));

  // Single URL with minCount=1
  const one = deriveCategoryOptions(
    ['https://shop.example.com/collections/skincare/products/retinol-24'],
    { minCount: 1 }
  );
  checkEq('C7 single shopify URL key is skincare', one[0] && one[0].key, 'skincare');
  checkEq('C8 label is "Skincare"', one[0] && one[0].label, 'Skincare');
}

// ── D. matchesAnyCategory — segment-exact ─────────────────────────────

{
  const yankeesUrl = fanaticsTeamUrl('new-york-yankees', 1);
  const kidsUrl = 'https://portal.fanatics.com/en//new-york-yankees-kids/some-slug/o-1+t-2+p-3+z-9-4';
  const billsUrl = fanaticsTeamUrl('buffalo-bills', 1);

  check('D1 yankees URL matches new-york-yankees', matchesAnyCategory(yankeesUrl, ['new-york-yankees']) === true);
  check('D2 bills URL does NOT match new-york-yankees', matchesAnyCategory(billsUrl, ['new-york-yankees']) === false);
  check('D3 yankees-kids does NOT match new-york-yankees (segment-exact)', matchesAnyCategory(kidsUrl, ['new-york-yankees']) === false);
  check('D4 yankees-kids DOES match its own key', matchesAnyCategory(kidsUrl, ['new-york-yankees-kids']) === true);

  // Naive substring trap: key is a substring of a longer segment
  const trap = 'https://shop.example.com/collections/care/products/x';
  check('D5 "car" does not match segment "care" (no substring)', matchesAnyCategory(trap, ['car']) === false);
  check('D6 "care" matches segment "care"', matchesAnyCategory(trap, ['care']) === true);

  // Depth-2 consecutive segment match
  const carDriver = FANATICS_CAR;
  check('D7 depth-2 key car/ty-gibbs matches', matchesAnyCategory(carDriver, ['car/ty-gibbs']) === true);
  check('D8 depth-2 key car/other does not', matchesAnyCategory(carDriver, ['car/other-driver']) === false);

  // Empty / missing keys
  check('D9 empty keys → false', matchesAnyCategory(yankeesUrl, []) === false);
  check('D10 null keys → false', matchesAnyCategory(yankeesUrl, null) === false);
  check('D11 garbage url → false', matchesAnyCategory('not a url', ['x']) === false);
}

// ── E. Determinism ────────────────────────────────────────────────────

{
  const corpus = buildFanaticsCorpus();
  // Force a tie: two teams with identical counts already (40 each)
  const a = deriveCategoryOptions(corpus, { minCount: 25, maxOptions: 40 });
  const b = deriveCategoryOptions(corpus, { minCount: 25, maxOptions: 40 });
  checkEq('E1 same input → identical JSON', a, b);

  // Tie-break: same count → key asc
  const tied = [];
  for (let i = 0; i < 30; i++) tied.push(`https://ex.com/zeta-team/p-${i}/e`);
  for (let i = 0; i < 30; i++) tied.push(`https://ex.com/alpha-team/p-${i}/e`);
  for (let i = 0; i < 30; i++) tied.push(`https://ex.com/middle-team/p-${i}/e`);
  const t = deriveCategoryOptions(tied, { minCount: 10 });
  const ordered = t.map(o => o.key);
  // All count=30, so alphabetical: alpha, middle, zeta
  checkEq('E2 ties broken by key asc', ordered, ['alpha-team', 'middle-team', 'zeta-team']);

  // Higher count sorts first
  const ranked = [];
  for (let i = 0; i < 50; i++) ranked.push(`https://ex.com/big-team/p-${i}/e`);
  for (let i = 0; i < 30; i++) ranked.push(`https://ex.com/small-team/p-${i}/e`);
  const r = deriveCategoryOptions(ranked, { minCount: 10 });
  checkEq('E3 count-desc ordering', r.map(o => o.key), ['big-team', 'small-team']);
}

// ── F. Garbage in ─────────────────────────────────────────────────────

{
  const cases = [
    ['null', null],
    ['empty string in array', ['']],
    ['not a url', ['not a url']],
    ['number', [42]],
    ['array with nulls', [null, undefined, '', 'not a url', 7]],
    ['non-array urls', 'https://x.com/a/b'],
    ['undefined', undefined]
  ];
  for (const [label, input] of cases) {
    let threw = false;
    let result;
    try {
      result = deriveCategoryOptions(input);
    } catch (err) {
      threw = true;
      result = err;
    }
    check(`F no-throw on ${label}`, threw === false && Array.isArray(result) && result.length === 0);
  }
  // matchesAnyCategory garbage
  let mThrew = false;
  try {
    assert.strictEqual(matchesAnyCategory(null, ['a']), false);
    assert.strictEqual(matchesAnyCategory(123, ['a']), false);
    assert.strictEqual(matchesAnyCategory('', null), false);
  } catch {
    mThrew = true;
  }
  check('F matchesAnyCategory garbage → false, no throw', mThrew === false);
}

// ── G. Flag-off source gate ───────────────────────────────────────────

{
  const resolverSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'genericCatalogResolver.js'),
    'utf8'
  );
  check(
    'G1 resolver gates on GENERIC_CATALOG_CATEGORY_OPTIONS',
    /GENERIC_CATALOG_CATEGORY_OPTIONS/.test(resolverSrc) &&
      /CATEGORY_OPTIONS_ENABLED/.test(resolverSrc)
  );
  check(
    'G2 attachCategoryFields no-ops when flag off',
    /if\s*\(\s*!CATEGORY_OPTIONS_ENABLED\s*\)\s*return out/.test(resolverSrc) ||
      /CATEGORY_OPTIONS_ENABLED\s*&&/.test(resolverSrc)
  );
  check(
    'G3 discoverOnly gated on CATEGORY_OPTIONS_ENABLED',
    /CATEGORY_OPTIONS_ENABLED\s*&&\s*discoverOnly/.test(resolverSrc) ||
      /discoverOnly[\s\S]{0,200}CATEGORY_OPTIONS_ENABLED/.test(resolverSrc)
  );

  const defaultsRaw = fs.readFileSync(
    path.join(__dirname, '..', 'config', 'defaults.env'),
    'utf8'
  );
  // Strip `#` comments (full-line leftover AND trailing on the assignment)
  // then line-anchor. An unanchored `=true` is satisfied by a leftover
  // comment, and `=500` is a prefix of `=5000`. Same shape as
  // verifyRegeneration.js R6a / verifyNoStrandedQueued.js F13, plus the
  // comment-strip these four keys need because they carry inline `# …`.
  const defaults = defaultsRaw
    .replace(/^[ \t]*#.*$/gm, '')
    .replace(/[ \t]+#.*$/gm, '')
    .replace(/[ \t]+$/gm, '');
  check('G4 defaults.env sets CATEGORY_OPTIONS=true',
    /^GENERIC_CATALOG_CATEGORY_OPTIONS=true$/m.test(defaults)
      && !/^GENERIC_CATALOG_CATEGORY_OPTIONS=false$/m.test(defaults));
  const promptMin = defaults.match(/^GENERIC_CATALOG_CATEGORY_PROMPT_MIN=(\d+)$/m);
  check('G5 defaults.env sets PROMPT_MIN=500',
    !!promptMin && Number(promptMin[1]) === 500);
  const minCount = defaults.match(/^GENERIC_CATALOG_CATEGORY_MIN_COUNT=(\d+)$/m);
  check('G6 defaults.env sets MIN_COUNT=25',
    !!minCount && Number(minCount[1]) === 25);
  const maxOpts = defaults.match(/^GENERIC_CATALOG_CATEGORY_MAX_OPTIONS=(\d+)$/m);
  check('G7 defaults.env sets MAX_OPTIONS=40',
    !!maxOpts && Number(maxOpts[1]) === 40);

  // Env-example documents the four knobs
  const envEx = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  check('G8 .env.example documents CATEGORY_OPTIONS', /GENERIC_CATALOG_CATEGORY_OPTIONS=/.test(envEx));
  check('G9 .env.example documents PROMPT_MIN', /GENERIC_CATALOG_CATEGORY_PROMPT_MIN=/.test(envEx));
}

// ── H. Resolver / surface wiring (source-level) ───────────────────────

{
  const resolverSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'genericCatalogResolver.js'),
    'utf8'
  );
  check('H1 deriveCategoryOptions required', /deriveCategoryOptions/.test(resolverSrc));
  check('H2 matchesAnyCategory required', /matchesAnyCategory/.test(resolverSrc));
  check('H3 candidatesFilteredByCategory recorded', /candidatesFilteredByCategory/.test(resolverSrc));
  check('H4 discoverOnly return shape', /discoverOnly:\s*true/.test(resolverSrc));
  check('H5 categoryPromptSuggested attached', /categoryPromptSuggested/.test(resolverSrc));
  check('H6 products:[] on discoverOnly', /discoverOnly[\s\S]*?products:\s*\[\]/.test(resolverSrc));

  const ingestSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'genericCatalogIngestService.js'),
    'utf8'
  );
  check('H7 ingest passes categories through', /categories/.test(ingestSrc) && /categoryOptions/.test(ingestSrc));

  const capSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'capabilityExecutors', 'catalogSyncFromGenericSitemap.js'),
    'utf8'
  );
  check('H8 capability preview uses discoverOnly', /discoverOnly:\s*true/.test(capSrc));
  check('H9 capability execute accepts categories', /args\?\.categories/.test(capSrc));
  check('H10 capability keeps resolveStoreOrigin', /resolveStoreOrigin/.test(capSrc));

  const apifySrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'apifyIngestService.js'),
    'utf8'
  );
  check('H11 apifyIngestService propagates categoryOptions', /categoryOptions/.test(apifySrc));
}

// ── I. humanizeKey ────────────────────────────────────────────────────

{
  checkEq('I1 buffalo-bills → Buffalo Bills', humanizeKey('buffalo-bills'), 'Buffalo Bills');
  checkEq('I2 car/ty-gibbs → Car / Ty Gibbs', humanizeKey('car/ty-gibbs'), 'Car / Ty Gibbs');
  checkEq('I3 skincare → Skincare', humanizeKey('skincare'), 'Skincare');
}

// ── J. maxOptions cap ─────────────────────────────────────────────────

{
  const many = [];
  for (let t = 0; t < 60; t++) {
    const team = `team-${String(t).padStart(2, '0')}`;
    for (let i = 0; i < 30; i++) {
      many.push(`https://ex.com/${team}/slug-${i}/end`);
    }
  }
  const capped = deriveCategoryOptions(many, { minCount: 10, maxOptions: 15 });
  checkEq('J1 maxOptions=15 caps list length', capped.length, 15);
}

// ── L. Label humanisation — acronyms, and `key` stays exact ───────────
// Presentation only, but a mangled "Nfl" is what an internal operator reads
// when picking categories. `key` must NEVER be reshaped — it is the matcher.
{
  const segs = ['nfl', 'mlb', 'nhl', 'nba', 'wwe', 'mls', 'wnba', 'milb',
    'nascar', 'college', 'pop-culture', 'soccer-national-teams'];
  const urls = [];
  for (const s of segs) {
    for (let i = 0; i < 30; i += 1) {
      urls.push(`https://www.fanatics.com/${s}/team-${i}/thing-${i}/o-1+p-${i}00000`);
    }
  }
  const byKey = new Map(
    deriveCategoryOptions(urls, { minCount: 5, maxOptions: 40 })
      .filter(o => o.depth === 1)
      .map(o => [o.key, o.label])
  );
  const want = {
    nfl: 'NFL', mlb: 'MLB', nhl: 'NHL', nba: 'NBA', wwe: 'WWE', mls: 'MLS',
    wnba: 'WNBA', milb: 'MiLB', nascar: 'NASCAR',
    college: 'College',
    'pop-culture': 'Pop Culture',
    'soccer-national-teams': 'Soccer National Teams'
  };
  for (const [k, label] of Object.entries(want)) {
    checkEq(`L label for "${k}"`, byKey.get(k), label);
  }
  // The matchable key must remain byte-exact lowercase — never humanised.
  check('L keys stay exact (never humanised)',
    [...byKey.keys()].every(k => k === k.toLowerCase() && !k.includes(' ')));
}

// ── Summary ───────────────────────────────────────────────────────────

console.log('');
console.log(`${pass}/${total} checks passed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
process.exit(0);
