#!/usr/bin/env node
'use strict';
/**
 * verifyVideoReferencePath — pins the 2026-09-03 video-reference changes:
 *   1. packshot-protected ranking (VIDEO_PACKSHOT_PROTECTED_RANKING)
 *   2. raw catalog references (VIDEO_RAW_CATALOG_REFERENCES)
 *   3. seed-text overlay guard STRIPPED 2026-09-03 (contradicted noText)
 *
 * Flag-OFF restores today's behaviour. This harness asserts both arms.
 * Offline: no DB, no network, no API keys.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVC  = path.join(ROOT, 'services');

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

for (const k of [
  'VIDEO_PACKSHOT_PROTECTED_RANKING',
  'VIDEO_RAW_CATALOG_REFERENCES',
  'VIDEO_DEFAULT_REFERENCE_SHOT_TYPES',
  'VIDEO_DEFAULT_REFERENCE_COUNT'
]) {
  delete process.env[k];
}

const refDefaults = require(path.join(SVC, 'referenceDefaultsService.js'));
const { buildVeoPrompt } = require(path.join(SVC, 'veoPromptBuilder.js'));
const { seedHasTextFromMedia } = require(path.join(SVC, 'seedTextTruth.js'));

const defaultsSrc = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');
const atlasSrc    = fs.readFileSync(path.join(SVC, 'atlasVideoService.js'), 'utf8');
const veoSrc      = fs.readFileSync(path.join(SVC, 'veoPromptBuilder.js'), 'utf8');
const cropSrc     = fs.readFileSync(path.join(SVC, 'basePlateCropService.js'), 'utf8');

const M = (id, shotType = null, extra = {}) => ({
  _id: id,
  fileUrl: `https://example.test/${id}.jpg`,
  classification: {
    ...(shotType ? { shotType } : {}),
    ...extra
  }
});
const ids = (arr) => arr.map((m) => m._id).join(',');

console.log('\n1. Flag posture — packshot ranking ON, raw references still dark');
// The CODE default (env name absent from process.env) must stay false for
// BOTH flags — that is the rollback property, and it is independent of what
// the committed file ships. Do not "simplify" these two into the file checks
// below: a Render dashboard override sets process.env, and the file default is
// only effective when no dashboard var of that name exists (§4a precedence).
check('VIDEO_PACKSHOT_PROTECTED_RANKING code default (env unset) is off',
  refDefaults.isPackshotProtectedRankingEnabled() === false);
// RETARGETED 2026-09-03 (was pinned =false on the same day it was added).
// Flipped to true deliberately, owner-approved. Evidence: the Chubasco
// sleeve-text failure was an experimental face-FIRST ranking dropping feed 0 —
// the product_only packshot that is production's real seed and OCRs PELAGIC x3
// at 0.96/0.80/0.83 — for on-model shots whose reflective-white marks are
// low-contrast. Harm was text-specific (Knockdown, no wordmark, was fine).
// This is a RETARGET, not a relaxation: it still fails loudly if the value
// moves again, which is the whole point of pinning the committed default.
// Verified the same day that NO Render service (adgen-renderer, adgen-titler,
// backend worker, backend web) sets this name, so the committed default IS
// what production runs.
check('defaults.env ships VIDEO_PACKSHOT_PROTECTED_RANKING=true',
  /^VIDEO_PACKSHOT_PROTECTED_RANKING=true$/m.test(defaultsSrc));
// STILL FALSE, and deliberately so. Its own defaults.env comment requires one
// production-route ATLAS generation with raw square refs at 9:16 and one at
// 16:9 to be eyeballed first — every raw-reference result behind this flag was
// measured on the Gemini Developer API, and production runs Atlas. Do not flip
// this to true in the same change as the ranking flag.
check('defaults.env ships VIDEO_RAW_CATALOG_REFERENCES=false (Atlas framing unproven)',
  /^VIDEO_RAW_CATALOG_REFERENCES=false$/m.test(defaultsSrc));
check('defaults.env does NOT ship VIDEO_SEED_TEXT_TYPE_FILTER (stripped 2026-09-03)',
  !/VIDEO_SEED_TEXT_TYPE_FILTER/.test(defaultsSrc));
check('VIDEO_DEFAULT_REFERENCE_COUNT still 3',
  /^VIDEO_DEFAULT_REFERENCE_COUNT=3$/m.test(defaultsSrc));
check('MAX_DISTINCT_REFERENCES still 5 in atlasVideoService',
  /const MAX_DISTINCT_REFERENCES\s*=\s*5/.test(atlasSrc));

console.log('\n2. Packshot ranking — slot 0 protected, preference for 1–2');
{
  const feed = [
    M(1, 'on_model', { faceVisible: true }),
    M(2, 'lifestyle'),
    M(3, 'product_only'),
    M(4, 'on_model', { faceVisible: false }),
    M(5, 'detail')
  ];
  const out = refDefaults.orderByPackshotProtectedRanking(feed);
  check('product_only is slot 0 even when it is not first in the feed',
    out[0]._id === 3, ids(out));
  check('slot 1 is lifestyle', out[1]._id === 2, ids(out));
  check('slot 2 is on_model WITH face, not the no-face on_model',
    out[2]._id === 1, ids(out));
  check('on_model without face follows the with-face tier',
    out[3]._id === 4, ids(out));
  check('detail follows on-figure', out[4]._id === 5, ids(out));
  check('same members out as in (sort, not filter)',
    out.length === feed.length && feed.every((m) => out.includes(m)));
}

// The check above uses DISTINCT objects, so it passes even when the packshot
// is removed by reference identity — which is exactly the bug it missed.
// `list.filter((m) => m !== firstPackshot)` drops EVERY copy of that object,
// so the same doc twice returned 2 members for 3 in. Found by executing the
// membership property over adversarial shapes, not by reading the code.
// buildReferenceImages' consider() dedups by _id so today's live caller
// cannot reach it, but this function is exported and its contract is
// "same members out as in" unconditionally.
console.log('\n2b. Packshot ranking — membership holds for adversarial shapes');
{
  const dup = M(1, 'product_only');
  const noId = { fileUrl: 'https://example.test/noid.jpg', classification: { shotType: 'product_only' } };
  const shapes = [
    ['empty',                []],
    ['single',               [M(1, 'product_only')]],
    ['no product_only',      [M(1, 'detail'), M(2, 'lifestyle'), M(3, 'on_model')]],
    ['all unclassified',     [M(1), M(2), M(3)]],
    ['two product_only',     [M(1, 'product_only'), M(2, 'product_only'), M(3, 'detail')]],
    ['SAME OBJECT TWICE',    [dup, dup, M(2, 'detail')]],
    ['packshot with no _id', [noId, M(2, 'detail')]],
    ['every item packshot',  [M(1, 'product_only'), M(2, 'product_only')]]
  ];
  for (const [name, input] of shapes) {
    const o = refDefaults.orderByPackshotProtectedRanking(input);
    check(`membership preserved: ${name}`,
      o.length === input.length && input.every((m) => o.includes(m)),
      `in=${input.length} out=${o.length}`);
  }
}

console.log('\n3. Packshot ranking — no product_only falls through to preference');
{
  const feed = [
    M(1, 'detail'),
    M(2, 'lifestyle'),
    M(3, 'on_model')
  ];
  const out = refDefaults.orderByPackshotProtectedRanking(feed);
  check('no product_only → lifestyle takes slot 0 (not silent seed-first)',
    ids(out) === '2,3,1', ids(out));
}
{
  const raw = [M(1), M(2), M(3)];
  const out = refDefaults.orderByPackshotProtectedRanking(raw);
  check('all-unclassified → feed order, nothing dropped',
    ids(out) === '1,2,3', ids(out));
}

console.log('\n4. faceVisible null is NOT a face');
{
  const feed = [
    M(1, 'product_only'),
    M(2, 'on_model', { faceVisible: null }),
    M(3, 'on_model', { faceVisible: true }),
    M(4, 'on_model')
  ];
  const out = refDefaults.orderByPackshotProtectedRanking(feed);
  check('confirmed face ranks ahead of null and missing faceVisible',
    ids(out) === '1,3,2,4', ids(out));
}

console.log('\n5. Extra product_only sits after preference, before unknown');
{
  const feed = [
    M(1, 'product_only'),
    M(2, 'packaging'),
    M(3, 'lifestyle'),
    M(4, 'product_only'),
    M(5)
  ];
  const out = refDefaults.orderByPackshotProtectedRanking(feed);
  check('first packshot, then lifestyle, extra packshot, packaging, unknown',
    ids(out) === '1,3,4,2,5', ids(out));
}

console.log('\n6. Operator path is not reordered');
check('orderedReferenceMedia is NOT passed through packshot ranking',
  !/orderByPackshotProtectedRanking\(\s*orderedReferenceMedia/.test(atlasSrc));
check('OFF path still calls orderByShotTypePreference on catalogMedias',
  /orderByShotTypePreference\(\s*\n?\s*catalogMedias \|\| \[\]/.test(atlasSrc));
check('packshot ranking is gated on isPackshotProtectedRankingEnabled',
  /isPackshotProtectedRankingEnabled\(\)/.test(atlasSrc));
check('lifestyle 1-ref path skips packshot ranking (maxImages >= 2 gate)',
  /maxImages\s*>=\s*2/.test(atlasSrc) && /packshotRanking/.test(atlasSrc));

console.log('\n7. Raw catalog references — machinery stays, video path skips');
check('isVideoRawCatalogReferencesEnabled is defined',
  /function isVideoRawCatalogReferencesEnabled\(/.test(atlasSrc));
check('raw branch returns sourceUrl without calling reframe',
  /isVideoRawCatalogReferencesEnabled\(\)/.test(atlasSrc)
  && /id\.sourceUrl/.test(atlasSrc));
check('reframeReferenceForAspect is still present (not deleted)',
  /async function reframeReferenceForAspect\(/.test(atlasSrc));
check('reframe claim/lease helpers still present',
  /function releaseAllActiveReframeClaims\(/.test(atlasSrc)
  && /REFRAME_CLAIM_TTL_FLOOR_MS/.test(atlasSrc));
check('output-side basePlateCropService is untouched (still exports face-safe crop path)',
  /function faceSafeCrop|faceSafeCrop/.test(cropSrc)
  && /videoCropUrl|cropUrl/.test(cropSrc));

console.log('\n8. Seed-text overlay guard STRIPPED 2026-09-03');
{
  // WHY THIS MOVED. The overlay guard contradicted OMNI_DIRECTIVES.noText
  // (already in every production prompt) and keyed on Media.text[].type.
  // Stripped, not flag-gated: the contradiction was live at flag-off.
  const RETIRED_OVERLAY =
    'The reference image contains text overlays / captions / stickers / watermarks burned into the source frame.';
  const RETIRED_LOCK =
    'Printed brand marks and product labels visible in the reference photographs are part of the locked product';
  const REAL_479D = {
    text: [
      { type: 'brand', content: 'PELAGIC' },
      { type: 'general', content: 'BUILT FOR FISHING' },
      { type: 'brand', content: 'PELAGIC' }
    ]
  };
  const base = {
    brand: { name: 'Test' },
    product: { title: 'Widget' },
    media: REAL_479D,
    aspectRatio: '9:16',
    hasProductReference: true,
    durationSec: 8,
    seedStyle: 'packshot',
    variantKind: 'product_image'
  };
  const p = buildVeoPrompt(base);
  const pLeftover = buildVeoPrompt({ ...base, seedHasText: true, seedHasOnProductMarks: true });
  check('seedTextPolicy.js is gone',
    !fs.existsSync(path.join(SVC, 'seedTextPolicy.js')));
  check('builder does not declare or push SEED_BURNED_IN_TEXT_GUARD_LINE',
    !/const SEED_BURNED_IN_TEXT_GUARD_LINE/.test(veoSrc)
    && !/lines\.push\(SEED_BURNED_IN_TEXT_GUARD_LINE\)/.test(veoSrc));
  check('builder source does not emit SEED_ON_PRODUCT_MARKS_LOCK_LINE',
    !/SEED_ON_PRODUCT_MARKS_LOCK_LINE/.test(veoSrc));
  check('inspector still reports OCR presence on the 479d shape (raw count, no type filter)',
    seedHasTextFromMedia(REAL_479D) === true);
  check('canonical prompt does NOT contain the retired overlay guard',
    !p.includes(RETIRED_OVERLAY));
  check('canonical prompt does NOT contain the retired on-product lock line',
    !p.includes(RETIRED_LOCK));
  check('leftover seedHasText/seedHasOnProductMarks args are a no-op (same bytes)',
    p === pLeftover);
  check('479d OCR shape does not change the prompt vs empty media (no overlay/lock)',
    p === buildVeoPrompt({ ...base, media: {} }));
}

console.log('\n10. Lifestyle "fitted upstream" wording is flag-gated, constants untouched');
check('LIFESTYLE_DIRECTIVES still claims fitted-upstream (flag-off bytes)',
  /it may already have been fitted to this aspect upstream/.test(veoSrc));
check('raw-catalog lifestyle role is a separate constant',
  /RAW_CATALOG_LIFESTYLE_ROLE/.test(veoSrc)
  && /catalog photograph at native resolution/.test(veoSrc));

if (failures.length) {
  console.error(`\n❌ videoReferencePath: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`\n✅ videoReferencePath: ${pass} checks passed`);
