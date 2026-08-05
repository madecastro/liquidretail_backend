#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogHeroMaterialize — fence for the greyed-out "PRIMARY" tile fix.
 *
 * The bug: the Step 2 picker greys any tile whose imageMediaId is falsy and
 * captions it "image still processing". Since CATALOG_DETECT_PRECOMPUTE went
 * to false (detect deferral, PR #7), no ingest path materializes the hero at
 * sync time — enqueueBrandProductDetects returns `deferred` before it reaches
 * enqueueProductDetect — and the pull side (ensureDetectForProducts) runs at
 * ad-generation time, strictly AFTER the picker renders. So the PRIMARY tile
 * stayed greyed forever on a catalog ingested weeks earlier, describing a
 * queue that was never populated. Alts escaped only because the catalog
 * detail endpoint already lazily backfilled them.
 *
 * Asserts:
 *   1. materializeMissingHero exists, is exported, and is materialize-ONLY —
 *      no createDetectRunIfAbsent — so the fix does not re-introduce the
 *      per-product Gemini vision spend the deferral was written to remove.
 *   2. Its persist is guarded on an empty imageMediaId (a concurrent
 *      enqueueProductDetect must win, never be clobbered) and it reports the
 *      persisted id rather than the one it minted.
 *   3. enqueueProductDetect persists imageMediaId from MEDIA EXISTENCE
 *      (heroMediaId) and not from enqueued.hero (which additionally requires
 *      DetectRun creation), and returns heroMediaId / altMediaIds.
 *   4. routes/catalog.js calls materializeMissingHero, guarded on a missing
 *      imageMediaId, best-effort (wrapped in try/catch).
 *   5. Every consumer that asks "is there a usable hero Media" reads
 *      heroMediaId first. Reading enqueued.hero alone dropped whole video ads
 *      as NO_HERO_MEDIA.
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyCatalogHeroMaterialize.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const read = (...p) => {
  const f = path.join(ROOT, ...p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

const detectSrc  = read('services', 'catalogProductDetectService.js');
const catalogSrc = read('routes', 'catalog.js');
const genSrc     = read('services', 'campaignAdsGenerationService.js');
const matchSrc   = read('services', 'productMatchService.js');

// Slice a top-level `async function <name>(` body by brace balance so the
// per-function assertions below can't be satisfied by code elsewhere in the
// module.
function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  // Walk the PARAMETER LIST to its closing paren first. Several of these
  // functions take destructured options ({ skipIfPointerSet = true } = {}), so
  // "first { after the name" lands in the signature, not the body, and brace
  // balance then closes on the wrong token.
  const parenOpen = src.indexOf('(', start);
  if (parenOpen < 0) return '';
  let pdepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') {
      pdepth--;
      if (pdepth === 0) { parenClose = i; break; }
    }
  }
  if (parenClose < 0) return '';
  const open = src.indexOf('{', parenClose);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

// ── 1. materializeMissingHero exists, exported, materialize-ONLY ─────
console.log('\n1. materializeMissingHero — exists, exported, no detect spend');

const heroFn = functionBody(detectSrc, 'materializeMissingHero');
check('materializeMissingHero is defined', heroFn.length > 0);
check('materializeMissingHero is exported',
  /module\.exports\s*=\s*\{[^}]*\bmaterializeMissingHero\b/.test(detectSrc));
check('materializeMissingHero calls materializeImage(',
  heroFn.includes('materializeImage('));

// The cost fence. This is the assertion that makes the fix revert-proof:
// adding a detect run here would silently restore the whole-catalog Gemini
// vision burn that CATALOG_DETECT_PRECOMPUTE=false exists to avoid.
check('materializeMissingHero does NOT create a DetectRun (cost fence)',
  !heroFn.includes('createDetectRunIfAbsent('));
check('materializeMissingHero does NOT call enqueueProductDetect (cost fence)',
  !heroFn.includes('enqueueProductDetect('));
// Mirrors materializeMissingAlts, which is the proven-cheap shape.
const altFn = functionBody(detectSrc, 'materializeMissingAlts');
check('materializeMissingAlts is still detect-free (unchanged cost profile)',
  altFn.length > 0 && !altFn.includes('createDetectRunIfAbsent('));

// ── 2. Idempotent + concurrency-safe persist ─────────────────────────
console.log('\n2. materializeMissingHero — idempotent, no-clobber persist');

check('no-ops when imageMediaId is already set',
  /if\s*\(\s*product\.imageMediaId\s*\)\s*return/.test(heroFn));
check('no-ops when imageUrl is missing',
  /if\s*\(\s*!product\.imageUrl\s*\)\s*return\s+null/.test(heroFn));
check('persists via CatalogProduct.updateOne',
  heroFn.includes('CatalogProduct.updateOne('));
check('persist is GUARDED on an empty imageMediaId (concurrent detect wins)',
  heroFn.includes('imageMediaId: null') && heroFn.includes('$exists: false'));
check('persist only $set imageMediaId (never touches alts)',
  heroFn.includes('$set: { imageMediaId: heroMediaId }'));
check('on a lost race, reports the PERSISTED id, not the minted one',
  /modifiedCount/.test(heroFn) && /findById\(product\._id\)/.test(heroFn));
// A minted-but-unpersisted id would make the tile selectable and then be wrong
// downstream — null keeps it greyed and lets the next fetch retry.
check('returns null (not the minted id) when nothing was persisted',
  /return\s+fresh\?\.imageMediaId\s*\?\s*String\(fresh\.imageMediaId\)\s*:\s*null/.test(heroFn));

// ── 3. enqueueProductDetect: pointer = media existence, not run ──────
console.log('\n3. enqueueProductDetect — pointer written from media existence');

const enqFn = functionBody(detectSrc, 'enqueueProductDetect');
check('enqueueProductDetect is defined', enqFn.length > 0);
check('tracks heroMediaId separately from enqueued.hero',
  /let\s+heroMediaId\s*=\s*null/.test(enqFn));
check('tracks altMediaIds separately from enqueued.alts',
  /const\s+altMediaIds\s*=\s*\[\]/.test(enqFn));
check('sets heroMediaId on materialize success (before run creation)',
  /heroMediaId\s*=\s*String\(heroMedia\._id\)/.test(enqFn));
check('persists imageMediaId from heroMediaId',
  /update\.imageMediaId\s*=\s*heroMediaId/.test(enqFn));
check('persists additionalImageMediaIds from altMediaIds',
  /update\.additionalImageMediaIds\s*=\s*altMediaIds/.test(enqFn));

// Non-destructive persist. materializeMissingHero is a second writer and this
// function's `product` is a snapshot that can predate it, so a failed
// materialize must not write null/[] over the other writer's success.
check('only writes imageMediaId when one was resolved (no null clobber)',
  /if\s*\(heroMediaId\)\s*update\.imageMediaId/.test(enqFn));
check('only writes alts when non-empty (no [] wipe of the aligned array)',
  /if\s*\(altMediaIds\.length\)\s*update\.additionalImageMediaIds/.test(enqFn));
check('skips the write entirely when nothing resolved',
  /if\s*\(Object\.keys\(update\)\.length\)/.test(enqFn));
check('persist uses $set (never a whole-document replace)',
  /updateOne\(\{ _id: product\._id \}, \{ \$set: update \}\)/.test(enqFn));

// The skip path must still answer "is there a usable hero Media".
check('skip-because-pointer-set return carries heroMediaId',
  /reason:\s*'already detected \(imageMediaId set\)',\s*\n?\s*heroMediaId:\s*String\(product\.imageMediaId\)/.test(enqFn));
// enqueueProductDetect OWNS pointer derivation and must stay unreusable as a
// "just add the missing run" path — that is what compacted the aligned alt
// array. Its pointer skip gate must be unconditional.
check('pointer skip gate is unconditional (no override parameter)',
  /async function enqueueProductDetect\(product\)/.test(detectSrc) &&
  /if\s*\(product\.imageMediaId\)\s*\{/.test(enqFn));

// The regression this replaces. Either spelling of the old write reintroduces
// the bug: a materialized Media whose run creation returned null is persisted
// as a null pointer, and the skip gate then makes it permanent.
check('does NOT persist imageMediaId from enqueued.hero (the regression)',
  !/imageMediaId:\s*enqueued\.hero/.test(enqFn));
check('does NOT persist alts from enqueued.alts.map (the regression)',
  !/additionalImageMediaIds:\s*enqueued\.alts\.map/.test(enqFn));
check('returns heroMediaId + altMediaIds alongside enqueued',
  /return\s*\{\s*enqueued,\s*heroMediaId,\s*altMediaIds\s*\}/.test(enqFn));

// enqueued.hero must still mean "a run was queued" — it is the counter's
// basis in enqueueBrandProductDetects and that meaning is correct there.
check('enqueued.hero still gated on run creation (unchanged meaning)',
  /if\s*\(run\)\s*enqueued\.hero\s*=/.test(enqFn));
check('heroEnqueued counter still counts RUNS via enqueued.hero',
  /if\s*\(r\.enqueued\?\.hero\)\s*heroEnqueued\+\+/.test(detectSrc));

// ── 3b. Ad-time pull gates on the RUN, not the pointer ───────────────
console.log('\n3b. ensureDetectForProducts — run-aware gate (adversarial-review catch)');

// This is the invariant the hero backfill breaks if left unaddressed. Before
// the backfill, imageMediaId != null implied "detect was enqueued at least
// once", so gating the ad-time pull on the pointer was sound. The backfill
// stamps the pointer with NO run (its cost fence), so a pointer-only gate here
// skips exactly those products — and this function is the only thing
// guaranteeing crops / overlay zones / ad-readiness exist by ad time. Result
// would be paid ads silently rendered without spatial analysis.
const ensureFn = functionBody(detectSrc, 'ensureDetectForProducts');
check('ensureDetectForProducts is defined', ensureFn.length > 0);
check('does NOT gate on the bare pointer (the regression)',
  !/if\s*\(p\.imageMediaId\)\s*continue;/.test(ensureFn));
check('queries DetectRun for the products that already have a pointer',
  /DetectRun\.find\(\{\s*mediaId:\s*\{\s*\$in:\s*pointerIds\s*\}/.test(ensureFn));
check('gate requires BOTH a pointer and a run',
  /if\s*\(p\.imageMediaId && detectedMediaIds\.has\(String\(p\.imageMediaId\)\)\)\s*continue;/.test(ensureFn));
// Batched = the run lookup happens ONCE, before the per-product loop, not
// inside it. (The function also holds the pre-existing wait-loop DetectRun
// query on pendingHeroIds, so counting DetectRun.find calls proves nothing.)
{
  const gateQueryIdx = ensureFn.indexOf('$in: pointerIds');
  const loopIdx      = ensureFn.indexOf('for (const p of products)');
  check('run lookup is batched once BEFORE the per-product loop',
    gateQueryIdx > 0 && loopIdx > 0 && gateQueryIdx < loopIdx,
    `query=${gateQueryIdx} loop=${loopIdx}`);
  check('exactly one pointerIds run lookup',
    (ensureFn.match(/\$in: pointerIds/g) || []).length === 1);
  // The loop itself must not issue a per-product run query.
  const loopBody = ensureFn.slice(loopIdx, ensureFn.indexOf('console.log(`🎯', loopIdx));
  check('per-product loop issues no DetectRun query',
    loopIdx > 0 && !/DetectRun\.(find|exists|findOne)\(/.test(loopBody));
}
check('DetectRun is imported in the detect service',
  /const DetectRun = require\('\.\.\/models\/DetectRun'\)/.test(detectSrc));

// Branch on pointer presence: pointer set → runs-only; pointer null → full
// derive. Routing a pointer-set product through enqueueProductDetect is what
// compacted the index-aligned alt array.
check('pointer-set products go through the runs-ONLY path',
  /if\s*\(p\.imageMediaId\)\s*\{[\s\S]{0,400}?ensureDetectRunsForExistingMedia\(p\)/.test(ensureFn));
check('pointer-null products still go through the full enqueueProductDetect',
  /\}\s*else\s*\{[\s\S]{0,200}?enqueueProductDetect\(p\)/.test(ensureFn));

// ── 3c. Runs-only re-entry derives and persists NOTHING ──────────────
console.log('\n3c. ensureDetectRunsForExistingMedia — runs only, no pointer rewrite');

const runsFn = functionBody(detectSrc, 'ensureDetectRunsForExistingMedia');
check('ensureDetectRunsForExistingMedia is defined', runsFn.length > 0);
check('ensureDetectRunsForExistingMedia is exported',
  /module\.exports\s*=\s*\{[^}]*\bensureDetectRunsForExistingMedia\b/.test(detectSrc));
check('creates detect runs', runsFn.includes('createDetectRunIfAbsent('));

// THE ALIGNMENT FENCE. Writing additionalImageMediaIds from here (or calling
// the deriving path) would compact the index-aligned array and mis-pair every
// alt URL with the wrong media id.
check('does NOT write additionalImageMediaIds (alignment fence)',
  !runsFn.includes('additionalImageMediaIds:') && !/\$set/.test(runsFn));
check('does NOT persist anything at all (no updateOne/updateMany/save)',
  !/CatalogProduct\.(updateOne|updateMany|findOneAndUpdate)\(/.test(runsFn) && !/\.save\(/.test(runsFn));
check('does NOT materialize (no Cloudinary traffic, no hero-URL dependency)',
  !runsFn.includes('materializeImage('));
check('does NOT call enqueueProductDetect (would re-derive pointers)',
  !runsFn.includes('enqueueProductDetect('));

// Idempotence: createDetectRunIfAbsent only de-dupes IN-FLIGHT runs, so without
// an any-status filter this path would mint a fresh run per ad generation.
// Must assert the set is actually APPLIED as a filter — merely building
// `alreadyRun` and then ignoring it still mints a run per generate (a mutation
// that replaced the filter with `docs` passed an earlier version of this check).
check('skips media that already have a run in ANY status (idempotent)',
  /DetectRun\.find\(\{\s*mediaId:\s*\{\s*\$in:/.test(runsFn) &&
  /docs\.filter\(d => !alreadyRun\.has\(String\(d\._id\)\)\)/.test(runsFn));
check('only the filtered set is iterated for run creation',
  /for\s*\(const media of needed\)/.test(runsFn));
check('run-existence lookup is batched (one query)',
  (runsFn.match(/DetectRun\.find\(/g) || []).length === 1);
check('Media lookup is brand- AND source-scoped (no cross-brand detect)',
  /brandId:\s*product\.brandId/.test(runsFn) && /source:\s*'catalog-product'/.test(runsFn));

// ── 4. Catalog detail endpoint backfills the hero ────────────────────
console.log('\n4. GET /api/catalog/:id — lazy hero backfill wired');

// Require- and call-shaped, not bare-name. The explanatory comment in the
// route names materializeMissingHero, so a substring scan stays green even if
// the require and the call are both deleted (caught in mutation testing).
check('routes/catalog.js requires materializeMissingHero from the detect service',
  /const\s*\{\s*materializeMissingHero\s*\}\s*=\s*require\(/.test(catalogSrc));
check('routes/catalog.js INVOKES materializeMissingHero(',
  /await\s+materializeMissingHero\(/.test(catalogSrc));
check('hero backfill is guarded on a missing imageMediaId',
  /if\s*\(!product\.imageMediaId\)\s*\{/.test(catalogSrc));
check('hero backfill assigns onto the response product',
  /product\.imageMediaId\s*=\s*heroMediaId/.test(catalogSrc));
check('hero backfill is best-effort (try/catch, does not block the response)',
  /lazy hero backfill failed/.test(catalogSrc));
check('alt backfill still present (not displaced by the hero one)',
  catalogSrc.includes('materializeMissingAlts('));
// Ordering matters: the hero must be filled before loadHeroCrops reads it.
const heroFillIdx  = catalogSrc.indexOf('await materializeMissingHero(');
const heroCropsIdx = catalogSrc.indexOf('loadHeroCrops(product.imageMediaId)');
check('hero backfill runs BEFORE loadHeroCrops(product.imageMediaId)',
  heroFillIdx > 0 && heroCropsIdx > 0 && heroFillIdx < heroCropsIdx,
  `fill=${heroFillIdx} crops=${heroCropsIdx}`);

// ── 5. Consumers read media existence, not run creation ──────────────
console.log('\n5. Consumers prefer heroMediaId over enqueued.hero');

// Every site that resolves "do we have a usable hero Media" from an
// enqueueProductDetect result. Reading enqueued.hero alone is what turned a
// materialized-but-unqueued hero into a dropped ad.
const CONSUMERS = [
  ['campaignAdsGenerationService (seedsFromProduct + expandDeterministicVideo)', genSrc, 2],
  ['productMatchService (ensureCatalogProduct log)', matchSrc, 1]
];
for (const [label, src, expected] of CONSUMERS) {
  const preferred = (src.match(/out\?\.heroMediaId\s*\|\|\s*out\?\.enqueued\?\.hero\?\.mediaId/g) || []).length;
  check(`${label}: ${expected} site(s) read heroMediaId first`,
    preferred === expected, `found ${preferred}, expected ${expected}`);
}
// No consumer may read enqueued.hero WITHOUT the heroMediaId fallback ahead
// of it. Counts bare reads and requires every one to be part of a preferred
// expression.
for (const [label, src] of CONSUMERS) {
  const bare = (src.match(/out\?\.enqueued\?\.hero\?\.mediaId/g) || []).length;
  const preferred = (src.match(/out\?\.heroMediaId\s*\|\|\s*out\?\.enqueued\?\.hero\?\.mediaId/g) || []).length;
  check(`${label}: no bare enqueued.hero read remains`,
    bare === preferred, `bare=${bare} preferred=${preferred}`);
}

// ── 6. Deferral itself is untouched ──────────────────────────────────
console.log('\n6. Detect deferral still in force (this fix is not a revert)');

check('CATALOG_DETECT_PRECOMPUTE gate still present',
  detectSrc.includes("process.env.CATALOG_DETECT_PRECOMPUTE"));
check('deferred early-return still present',
  /deferred:\s*true/.test(detectSrc));
const defaultsSrc = read('config', 'defaults.env');
check('CATALOG_DETECT_PRECOMPUTE still defaults to false',
  /^CATALOG_DETECT_PRECOMPUTE=false$/m.test(defaultsSrc));

// ── Summary ─────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n❌ catalogHeroMaterialize: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`\n✅ catalogHeroMaterialize: ${pass} checks passed`);
