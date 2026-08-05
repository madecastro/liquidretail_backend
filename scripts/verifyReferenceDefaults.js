#!/usr/bin/env node
'use strict';
/**
 * verifyReferenceDefaults — fence for the ENV-configurable default reference
 * stacks (owner request 2026-08-05).
 *
 * Requirement: video defaults are "the first, second and third catalog images as
 * downloaded from the website or their Shopify feed", with the COUNT and the
 * TYPE both settable from config/defaults.env, independently for video and for
 * static image requests.
 *
 * The invariants that matter, and why:
 *
 *   1. SHIPPED DEFAULTS CHANGE NOTHING. video=3 / static=1 and NO shot-type
 *      preference. The whole feature is opt-in; a deploy of this code with an
 *      untouched defaults.env must behave exactly as before.
 *   1b. NO DEAD KNOBS. An earlier draft carried a SOURCE dial that was wired
 *      nowhere; it was cut rather than shipped, because a config var that
 *      silently does nothing gets trusted later. Asserted, not just removed.
 *   2. SHOT TYPE IS A PREFERENCE, NEVER A FILTER. classification.shotType is
 *      written by the per-product detect pass, and detect is DEFERRED, so a
 *      freshly ingested product has NO shot types. A filter would return an
 *      empty stack for exactly the newest products. So: same members out as in,
 *      always.
 *   3. EMPTY PREFERENCE IS A STRICT NO-OP — pure feed order.
 *   4. UNCLASSIFIED MEDIA NEVER SORTS AHEAD of a match, and never drops.
 *   5. THE TWO RAILS ARE INDEPENDENT — separate env vars. Deriving the static
 *      count from the video count is a known past bug (a 3-image static
 *      universe when the hero-only default was intended).
 *   6. INVALID CONFIG DEGRADES, never throws.
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyReferenceDefaults.js
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

// Load with a pristine env so "shipped defaults" means the code's own defaults,
// not whatever this shell happens to export.
for (const k of Object.keys(process.env)) {
  if (/^(VIDEO|IMAGE)_DEFAULT_REFERENCE_/.test(k)) delete process.env[k];
}

const svc = require(path.join(ROOT, 'services', 'referenceDefaultsService.js'));
const defaultsSrc = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');
const atlasSrc    = fs.readFileSync(path.join(ROOT, 'services', 'atlasVideoService.js'), 'utf8');
const catalogSrc  = fs.readFileSync(path.join(ROOT, 'routes', 'catalog.js'), 'utf8');

const M = (id, shotType = null, source = 'catalog-product') => ({
  _id: id, source, classification: shotType ? { shotType } : {}
});
const ids = arr => arr.map(m => m._id).join(',');

// ── 1. Shipped defaults are a no-op ─────────────────────────────────
console.log('\n1. Shipped defaults preserve existing behaviour exactly');

const v = svc.videoReferenceDefaults();
const i = svc.imageReferenceDefaults();
check('video count defaults to 3 (front/side/back)', v.count === 3, `got ${v.count}`);
check('static count defaults to 1 (first catalog image alone)', i.count === 1, `got ${i.count}`);
// THE answer to "is there a default shot type?" — no, and there must not be.
check('video shot-type preference is EMPTY by default (opt-in only)',
  Array.isArray(v.shotTypes) && v.shotTypes.length === 0, JSON.stringify(v.shotTypes));
check('static shot-type preference is EMPTY by default (opt-in only)',
  Array.isArray(i.shotTypes) && i.shotTypes.length === 0, JSON.stringify(i.shotTypes));

check('defaults.env ships VIDEO_DEFAULT_REFERENCE_COUNT=3',
  /^VIDEO_DEFAULT_REFERENCE_COUNT=3$/m.test(defaultsSrc));
check('defaults.env ships IMAGE_DEFAULT_REFERENCE_COUNT=1',
  /^IMAGE_DEFAULT_REFERENCE_COUNT=1$/m.test(defaultsSrc));
check('defaults.env ships both shot-type vars EMPTY',
  /^VIDEO_DEFAULT_REFERENCE_SHOT_TYPES=$/m.test(defaultsSrc) &&
  /^IMAGE_DEFAULT_REFERENCE_SHOT_TYPES=$/m.test(defaultsSrc));
// A knob that does nothing is worse than no knob — it gets trusted later. The
// SOURCE dial was cut before shipping because it was dead in every wired path.
check('NO dead SOURCE knob ships in defaults.env',
  !/REFERENCE_SOURCE/.test(defaultsSrc));
check('resolver exposes no source dial',
  typeof svc.applyPolicy === 'undefined' && typeof svc.applySourcePolicy === 'undefined');
check('resolved policies carry no source field',
  !('source' in v) && !('source' in i));

// Previously code-only knobs, reachable solely via the Render dashboard. Their
// values here must match the code defaults or surfacing them changes behaviour.
check('defaults.env surfaces VIDEO_SEED_FEED_ORDER=true (matches code default)',
  /^VIDEO_SEED_FEED_ORDER=true$/m.test(defaultsSrc));
check('defaults.env surfaces VIDEO_SEED_MAX_SUBJECT_FRACTION=0.6 (matches code default 0.6)',
  /^VIDEO_SEED_MAX_SUBJECT_FRACTION=0\.6$/m.test(defaultsSrc));

// ── 2. Preference, never a filter ───────────────────────────────────
console.log('\n2. Shot type is a PREFERENCE — same members out as in');

{
  const feed = [M(1, 'product_only'), M(2, null), M(3, 'lifestyle')];
  const out = svc.orderByShotTypePreference(feed, ['lifestyle']);
  check('reorders to put the preferred shot type first', ids(out) === '3,1,2', ids(out));
  check('returns the SAME number of members', out.length === feed.length, `${out.length} vs ${feed.length}`);
  check('every input member survives',
    feed.every(m => out.includes(m)));
}
{
  // The deferred-detect case: nothing classified at all.
  const raw = [M(1), M(2), M(3)];
  const out = svc.orderByShotTypePreference(raw, ['lifestyle', 'on_model']);
  check('all-unclassified + preference → feed order, nothing dropped',
    ids(out) === '1,2,3' && out.length === 3, ids(out));
}
{
  // Multi-tier ordering follows the list order, not the shotTypeRank quality order.
  const feed = [M(1, 'on_model'), M(2, 'lifestyle'), M(3, null), M(4, 'packaging')];
  const out = svc.orderByShotTypePreference(feed, ['packaging', 'on_model']);
  check('honours LIST order (packaging before on_model), not quality rank',
    ids(out) === '4,1,2,3', ids(out));
}
{
  // Stability: equal buckets keep feed order.
  const feed = [M(1, 'lifestyle'), M(2, 'lifestyle'), M(3, 'lifestyle')];
  const out = svc.orderByShotTypePreference(feed, ['lifestyle']);
  check('stable within a bucket (feed order is the tiebreak)', ids(out) === '1,2,3', ids(out));
}

// ── 3. Empty preference is a strict no-op ───────────────────────────
console.log('\n3. Empty preference = pure feed order');

{
  const feed = [M(1, 'product_only'), M(2, 'lifestyle'), M(3, null)];
  check('empty list returns input order', ids(svc.orderByShotTypePreference(feed, [])) === '1,2,3');
  check('undefined list returns input order',
    ids(svc.orderByShotTypePreference(feed, undefined)) === '1,2,3');
  check('single-element input is returned as-is',
    ids(svc.orderByShotTypePreference([M(9, 'lifestyle')], ['on_model'])) === '9');
  check('empty input yields empty output',
    svc.orderByShotTypePreference([], ['lifestyle']).length === 0);
}

// ── 4. Counts are bounded by what generation can actually honour ────
console.log('\n4. Count bounds match the real ceilings');

// Serving a count the video cascade would reject means advertising a number
// generation never uses. MAX_VIDEO_COUNT must equal atlasVideoService's
// MAX_REFERENCE_IMAGE_COUNT.
{
  const m = atlasSrc.match(/const MAX_REFERENCE_IMAGE_COUNT\s*=\s*(\d+)/);
  const atlasMax = m ? parseInt(m[1], 10) : null;
  check('MAX_VIDEO_COUNT equals atlas MAX_REFERENCE_IMAGE_COUNT',
    atlasMax !== null && svc.MAX_VIDEO_COUNT === atlasMax,
    `resolver=${svc.MAX_VIDEO_COUNT} atlas=${atlasMax}`);
}
process.env.VIDEO_DEFAULT_REFERENCE_COUNT = String(svc.MAX_VIDEO_COUNT + 1);
check('a video count above the model ceiling is rejected, not served',
  svc.videoReferenceDefaults().count === 3);
delete process.env.VIDEO_DEFAULT_REFERENCE_COUNT;

// ── 5. Rails are independent ────────────────────────────────────────
console.log('\n5. Video and static read SEPARATE env vars');

process.env.VIDEO_DEFAULT_REFERENCE_COUNT = '5';
check('changing the video count does NOT move the static count',
  svc.videoReferenceDefaults().count === 5 && svc.imageReferenceDefaults().count === 1);
delete process.env.VIDEO_DEFAULT_REFERENCE_COUNT;
process.env.IMAGE_DEFAULT_REFERENCE_COUNT = '4';
check('changing the static count does NOT move the video count',
  svc.imageReferenceDefaults().count === 4 && svc.videoReferenceDefaults().count === 3);
delete process.env.IMAGE_DEFAULT_REFERENCE_COUNT;

process.env.VIDEO_DEFAULT_REFERENCE_SHOT_TYPES = 'lifestyle';
check('video preference does NOT leak into the static policy',
  svc.videoReferenceDefaults().shotTypes.length === 1 &&
  svc.imageReferenceDefaults().shotTypes.length === 0);
delete process.env.VIDEO_DEFAULT_REFERENCE_SHOT_TYPES;

// ── 6. Invalid config degrades, never throws ────────────────────────
console.log('\n6. Invalid config degrades to the default');

process.env.VIDEO_DEFAULT_REFERENCE_COUNT = '999';
check('out-of-range count falls back to 3', svc.videoReferenceDefaults().count === 3);
process.env.VIDEO_DEFAULT_REFERENCE_COUNT = 'abc';
check('non-numeric count falls back to 3', svc.videoReferenceDefaults().count === 3);
process.env.VIDEO_DEFAULT_REFERENCE_COUNT = '0';
check('zero count falls back to 3 (never pre-pick nothing)', svc.videoReferenceDefaults().count === 3);
delete process.env.VIDEO_DEFAULT_REFERENCE_COUNT;

process.env.VIDEO_DEFAULT_REFERENCE_SHOT_TYPES = 'lifestyle,bogus,on_model';
check('unknown shot-type tokens are dropped, valid ones kept in order',
  JSON.stringify(svc.videoReferenceDefaults().shotTypes) === '["lifestyle","on_model"]');
process.env.VIDEO_DEFAULT_REFERENCE_SHOT_TYPES = 'bogus,,   ';
check('an all-invalid list degrades to EMPTY (feed order), not to a filter',
  svc.videoReferenceDefaults().shotTypes.length === 0);
delete process.env.VIDEO_DEFAULT_REFERENCE_SHOT_TYPES;

check('every valid shot type matches the Media enum / shotTypeRank vocabulary',
  ['lifestyle', 'on_model', 'product_only', 'flat_lay', 'detail', 'packaging', 'unknown']
    .every(s => svc.VALID_SHOT_TYPES.includes(s)));

// ── 7. Wiring ───────────────────────────────────────────────────────
console.log('\n7. Wiring — served to the picker, applied in auto-assembly');

check('scaffold serves referenceDefaults for BOTH rails',
  /referenceDefaults:\s*\{/.test(atlasSrc) &&
  /image:\s*referenceDefaultsService\.imageReferenceDefaults\(\)/.test(atlasSrc));
// One authoritative video count only: defaultReferenceCount (the full cascade).
check('scaffold serves NO second video count',
  /video:\s*\{\s*shotTypes:\s*referenceDefaultsService\.videoReferenceDefaults\(\)\.shotTypes\s*\}/.test(atlasSrc));
check('scaffold still serves the authoritative defaultReferenceCount',
  /defaultReferenceCount:\s*resolveReferenceImageCount/.test(atlasSrc));
check('buildReferenceImages orders catalogMedias by the video preference',
  /orderByShotTypePreference\(\s*\n?\s*catalogMedias \|\| \[\]/.test(atlasSrc));
check('auto-assembly iterates the ORDERED array, not the raw one',
  /for \(const cm of orderedCatalogMedias\)/.test(atlasSrc));
// The operator-pick path must never be reordered — picks are an explicit ordering.
check('orderedReferenceMedia (operator picks) is NOT reordered',
  !/orderByShotTypePreference\(\s*orderedReferenceMedia/.test(atlasSrc));
check('VIDEO_DEFAULT_REFERENCE_COUNT sits BELOW ATLAS_REFERENCE_IMAGE_COUNT in the cascade',
  atlasSrc.indexOf('ATLAS_REFERENCE_IMAGE_COUNT env') < atlasSrc.indexOf('VIDEO_DEFAULT_REFERENCE_COUNT env'));
check('catalog detail serves per-image shot types (else the knob is inert)',
  /imageShotType:/.test(catalogSrc) && /additionalImageShotTypes:/.test(catalogSrc));
check('shot-type lookup is batched (one query)',
  (catalogSrc.match(/select\('classification\.shotType'\)/g) || []).length === 1);
// Decorative metadata must never 500 product detail — the outer catch would.
check('shot-type lookup is best-effort (own try/catch)',
  /shot-type lookup failed/.test(catalogSrc));

// ── Summary ─────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n❌ referenceDefaults: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`\n✅ referenceDefaults: ${pass} checks passed`);
