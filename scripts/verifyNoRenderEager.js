#!/usr/bin/env node
'use strict';
/**
 * verifyNoRenderEager — the video render upload must not pre-generate a Cloudinary derivative.
 *
 * WHAT WAS REMOVED AND WHY. generateForAd used to pass
 * `eager: [{ raw_transformation: 'c_fill,<ar>,g_auto' }]` to uploadBufferToCloudinary whenever the
 * model's rendered aspect differed from the platform aspect. Nothing ever fetched it:
 *
 *   - the ONLY emitter of a c_fill/g_auto VIDEO url is videoCompositeService.js:145
 *   - its only in-repo caller is aiOverlayPolishService.js:196
 *   - which is gated off by AI_OVERLAY_POLISH_ENABLED=false (config/defaults.env)
 *   - and additionally hard-nulled at renderService.js:207
 *   - while the LIVE cropper, services/videoCropUrl.js, builds an explicit c_scale/c_crop chain
 *     with no gravity and no ar_ param, so it never resolves that derivative
 *
 * So every remapped render paid for a real transcode of a 1080x1920 clip, in Cloudinary
 * transformation credits, for an asset with no reader. The square flip (1a50b5b) enlarged the
 * blast radius rather than shrinking it: Omni now renders 9:16 for platform 1:1 AND 4:5, so the
 * aspects-differ condition became true on a strictly larger share of production.
 *
 * WHY A SOURCE-SLICE ASSERTION. There is no runtime seam here — the upload options are built
 * inline and handed straight to the Cloudinary SDK, so observing them behaviourally would mean
 * stubbing the SDK and driving a full generateForAd (billable submit, poll, download). This
 * follows the existing W1/W2/W3 precedent at scripts/verifyBasePlateCrop.js:174-186. It is a
 * weaker class of check than a behavioural one and the limits are stated in C3 rather than
 * papered over.
 *
 * No DB, no network, no API key. Safe in CI.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'services/atlasVideoService.js'), 'utf8');

// generateForAd only — an eager elsewhere in this file (e.g. the image reframe path, if any) is a
// different concern and must not make this pass or fail. Sliced to the NEXT top-level
// `async function` after it, whatever that function is named, so the slice survives reordering.
const START_MARK = 'async function generateForAd';
const startAt = src.indexOf(START_MARK);
const nextFnAt = startAt >= 0 ? src.indexOf('\nasync function ', startAt + START_MARK.length) : -1;
const fn = startAt >= 0 && nextFnAt > startAt ? src.slice(startAt, nextFnAt) : '';

// Comments legitimately discuss the removed transform; assertions must not trip on prose.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = stripComments(fn);

let pass = 0;
const failures = [];
function check(label, fn_) {
  try { fn_(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

console.log('\nverifyNoRenderEager\n');

// ── A. the slice is real (else every check below is vacuous) ───────────────
check('A1 generateForAd was located and sliced', () => {
  assert.ok(fn && fn.length > 2000,
    'could not slice generateForAd — it was renamed or restructured, so the checks below prove nothing');
  assert.ok(code.includes('uploadBufferToCloudinary'),
    'the slice does not contain the Cloudinary upload — wrong region captured');
});

// ── B. the invariant ───────────────────────────────────────────────────────
check('B1 generateForAd requests no eager derivative', () => {
  assert.ok(!/\beager\b/.test(code),
    'an eager transform is back in generateForAd — Cloudinary will transcode a derivative on ' +
    'every remapped render. Confirm a live reader exists before re-adding one; as of this commit ' +
    'the only consumer path is gated off by AI_OVERLAY_POLISH_ENABLED=false and hard-nulled at ' +
    'renderService.js:207.');
});

check('B2 generateForAd requests no g_auto gravity', () => {
  assert.ok(!/g_auto/.test(code),
    'g_auto reappeared in generateForAd. On video it is asynchronous — the first request per ' +
    'asset returns 423 "Video tracking-crop is pending" (docs/CLOUDINARY-VIDEO.md), which is ' +
    'exactly the first-view race the explicit c_crop chain exists to avoid.');
});

check('B3 the ar_ helper the eager needed is gone from the module', () => {
  // arParamForAspect existed only to build that raw_transformation. Leaving it behind invites a
  // future caller to reconstruct the dead derivative.
  assert.ok(!/function\s+arParamForAspect/.test(src),
    'arParamForAspect is back — it has no other purpose than the removed eager transform');
});

// ── C. honesty about what this suite does and does not cover ───────────────
check('C1 the upload still happens (deletion did not remove the mirror itself)', () => {
  assert.ok(/uploadBufferToCloudinary\s*\(/.test(code),
    'the Cloudinary upload call is gone — the render would never be mirrored');
  assert.ok(/resourceType:\s*'video'/.test(code) && /format:\s*'mp4'/.test(code),
    'the upload options lost resourceType/format — the mirror would change shape');
});

check('C2 the live cropper still uses an explicit, gravity-free chain', () => {
  const cropSrc = fs.readFileSync(path.join(ROOT, 'services/videoCropUrl.js'), 'utf8');
  assert.ok(/c_crop/.test(cropSrc), 'videoCropUrl no longer emits c_crop');
  assert.ok(!/g_auto|g_face/.test(stripComments(cropSrc)),
    'videoCropUrl now emits a gravity — the whole reason the eager was safe to delete was that ' +
    'the live path resolves no saliency derivative');
});

check('C3 scope statement — what a passing run does NOT prove', () => {
  // Deliberately trivial and always true. It exists so the limitation is recorded in the suite a
  // future reader runs, not only in a commit message they will not read.
  //   - a caller re-adding an eager through a differently-named helper is not detected
  //   - nothing here proves no OTHER module registers an eager on the same asset
  //   - this is structural, not behavioural: it cannot observe what Cloudinary actually receives
  assert.ok(true);
});

if (failures.length) {
  console.error(`❌ verifyNoRenderEager: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyNoRenderEager: ${pass}/${pass} checks passed`);
console.log('   generateForAd mirrors to Cloudinary with no eager derivative and no gravity');
