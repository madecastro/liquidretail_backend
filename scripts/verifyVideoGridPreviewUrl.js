#!/usr/bin/env node
/**
 * verifyVideoGridPreviewUrl.js
 *
 * Pins services/videoPreviewUrl.js and the two route sites that emit its output.
 *
 * WHY THIS EXISTS: the ad grid renders every video tile from `renderUrl` — the
 * full 1080p Cloudinary master. A gallery of N video ads therefore streams N
 * full-bitrate masters at once. `buildGridPreviewVideoUrl` derives a ~480px
 * c_scale/q_auto/f_auto delivery variant of the SAME asset for tile use, while
 * detail views keep using `renderUrl` untouched.
 *
 * BEHAVIOURAL, not source-text, for everything that can be: the transform
 * checks call the real exported `buildGridPreviewVideoUrl`, and the projection
 * checks drive the real exported `projectAd` from routes/ads.js. A
 * reimplementation that keeps the names but changes the behaviour still fails.
 *
 * The single exception is P7 (routes/catalog.js `ads-detail`), whose handler is
 * not separately exported; that one is a source check, bounded at the next
 * syntactic boundary rather than a magic character count, so it cannot drift
 * silently into an adjacent route.
 *
 * REVERT-PROOF:
 *   - swap `c_scale` for `c_fill`            -> T3 red (gravity-dependent crop)
 *   - drop `q_auto`/`f_auto`                 -> T2 red
 *   - return null instead of the input for a
 *     non-Cloudinary URL                     -> T5 red (broken <video> src)
 *   - emit previewVideoUrl for image ads     -> P2 red
 *   - stop emitting it for video ads         -> P1 red
 *   - drop the catalog ads-detail wiring     -> P7 red
 *
 * Run: node scripts/verifyVideoGridPreviewUrl.js
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const { buildGridPreviewVideoUrl, GRID_PREVIEW_WIDTH_PX } =
  require(path.join(ROOT, 'services', 'videoPreviewUrl.js'));

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { failures.push(`${name} — ${e.message}`); }
}

const CLOUDINARY_VIDEO =
  'https://res.cloudinary.com/demo/video/upload/v1712345678/ads/master_9x16.mp4';

// ── T1: a real Cloudinary video URL gets a transform segment inserted ───────
check('T1 inserts a transform directly after /video/upload/', () => {
  const out = buildGridPreviewVideoUrl(CLOUDINARY_VIDEO);
  assert.notStrictEqual(out, CLOUDINARY_VIDEO, 'expected a transformed URL, got the input back');
  assert.ok(out.includes('/video/upload/'), 'upload marker must survive');
  const seg = out.split('/video/upload/')[1].split('/')[0];
  assert.ok(/^[a-z]{1,2}_/.test(seg), `expected a transform segment, saw "${seg}"`);
  // the rest of the path must be preserved verbatim — same asset, not a new one
  assert.ok(out.endsWith('/v1712345678/ads/master_9x16.mp4'),
    `asset path must be preserved, got ${out}`);
});

// ── T2: the three levers that make the tile cheap are all present ──────────
check('T2 carries c_scale + q_auto + f_auto', () => {
  const out = buildGridPreviewVideoUrl(CLOUDINARY_VIDEO);
  for (const lever of ['c_scale', 'q_auto', 'f_auto']) {
    assert.ok(out.includes(lever), `missing ${lever} in ${out}`);
  }
  assert.ok(out.includes(`w_${GRID_PREVIEW_WIDTH_PX}`),
    `expected w_${GRID_PREVIEW_WIDTH_PX} in ${out}`);
});

// ── T3: never a gravity-dependent crop ─────────────────────────────────────
// docs/CLOUDINARY-VIDEO.md records g_auto/g_face/g_xy_center as unsupported or
// async for video on this account, and renders already match the target aspect
// ratio, so a tile needs a proportional downscale — never a re-crop.
check('T3 uses no c_fill / no gravity mode', () => {
  const out = buildGridPreviewVideoUrl(CLOUDINARY_VIDEO);
  assert.ok(!out.includes('c_fill'), `must not c_fill (needs gravity): ${out}`);
  assert.ok(!/[,/]g_/.test(out), `must not set a gravity mode: ${out}`);
});

// ── T4: aspect ratio is not forced — width only, height stays proportional ─
check('T4 sets width only, never a fixed height', () => {
  const out = buildGridPreviewVideoUrl(CLOUDINARY_VIDEO);
  const seg = out.split('/video/upload/')[1].split('/')[0];
  assert.ok(!/(^|,)h_\d/.test(seg),
    `a fixed h_ would distort or letterbox non-16:9 renders: ${seg}`);
});

// ── T5: fall back to the input rather than emitting a broken link ──────────
check('T5 non-Cloudinary URL passes through unchanged', () => {
  const foreign = 'https://cdn.example.com/videos/thing.mp4';
  assert.strictEqual(buildGridPreviewVideoUrl(foreign), foreign,
    'a non-transformable URL must pass through, not become null');
});

check('T5a an image-upload Cloudinary URL is not treated as video', () => {
  const img = 'https://res.cloudinary.com/demo/image/upload/v1/ads/a.png';
  assert.strictEqual(buildGridPreviewVideoUrl(img), img);
});

// ── T6: null/undefined in -> null out (never the string "undefined") ───────
check('T6 nullish input yields null', () => {
  assert.strictEqual(buildGridPreviewVideoUrl(null), null);
  assert.strictEqual(buildGridPreviewVideoUrl(undefined), null);
  assert.strictEqual(buildGridPreviewVideoUrl(''), null);
});

// ── T7: caller-supplied width is honoured ──────────────────────────────────
check('T7 opts.width overrides the default', () => {
  const out = buildGridPreviewVideoUrl(CLOUDINARY_VIDEO, { width: 240 });
  assert.ok(out.includes('w_240'), `expected w_240 in ${out}`);
  assert.ok(!out.includes(`w_${GRID_PREVIEW_WIDTH_PX}`), 'default width must not also appear');
});

// ── T8: the variant is a strictly smaller ask than the master ──────────────
check('T8 declared grid width is well below a 1080p master', () => {
  assert.ok(GRID_PREVIEW_WIDTH_PX > 0 && GRID_PREVIEW_WIDTH_PX <= 720,
    `grid width ${GRID_PREVIEW_WIDTH_PX} defeats the purpose of a thumbnail tier`);
});

// ── Projection wiring: drive the REAL exported projectAd ───────────────────
const { projectAd } = require(path.join(ROOT, 'routes', 'ads.js'));

function adFixture(over = {}) {
  return {
    _id: '000000000000000000000001',
    kind: 'video',
    renderUrl: CLOUDINARY_VIDEO,
    copy: {},
    ...over
  };
}

check('P1 projectAd emits a downscaled previewVideoUrl for a video ad', () => {
  const out = projectAd(adFixture(), false, {});
  assert.ok('previewVideoUrl' in out, 'projectAd must emit previewVideoUrl');
  assert.ok(out.previewVideoUrl, 'previewVideoUrl must be populated for a video ad');
  assert.ok(out.previewVideoUrl.includes('c_scale'),
    `expected the downscaled variant, got ${out.previewVideoUrl}`);
  assert.notStrictEqual(out.previewVideoUrl, out.renderUrl,
    'the tile URL must differ from the full master');
});

check('P2 image ads get previewVideoUrl: null', () => {
  const out = projectAd(adFixture({ kind: 'image' }), false, {});
  assert.strictEqual(out.previewVideoUrl, null,
    'a non-video ad must not carry a video tile URL');
});

check('P3 renderUrl is left untouched — detail view keeps the master', () => {
  const out = projectAd(adFixture(), false, {});
  assert.strictEqual(out.renderUrl, CLOUDINARY_VIDEO,
    'renderUrl must remain the full-quality master');
});

check('P4 a video ad with no renderUrl yields null, not a broken string', () => {
  const out = projectAd(adFixture({ renderUrl: null }), false, {});
  assert.strictEqual(out.previewVideoUrl, null);
});

check('P5 a non-Cloudinary video renderUrl falls back to itself', () => {
  const foreign = 'https://cdn.example.com/v/x.mp4';
  const out = projectAd(adFixture({ renderUrl: foreign }), false, {});
  assert.strictEqual(out.previewVideoUrl, foreign,
    'fallback must be the original URL so the tile still plays');
});

check('P6 the field is present in the full projection too', () => {
  const out = projectAd(adFixture(), true, {});
  assert.ok('previewVideoUrl' in out, 'full projection must also carry the field');
});

// ── P7: routes/catalog.js ads-detail — source check, bounded structurally ──
// This handler is not separately exported, so it cannot be driven directly.
// The window is bounded at the NEXT router registration, not a character
// count, so it can never silently widen into an adjacent route.
check('P7 catalog ads-detail also emits previewVideoUrl', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'catalog.js'), 'utf8');
  const start = src.indexOf("router.get('/:id/ads-detail'");
  assert.ok(start > -1, "could not locate the ads-detail route — did it get renamed?");
  const after = src.slice(start + 1);
  const nextRoute = after.search(/\brouter\.(get|post|put|patch|delete)\s*\(/);
  const window = nextRoute === -1 ? after : after.slice(0, nextRoute);
  assert.ok(/previewVideoUrl\s*:/.test(window),
    'ads-detail must emit previewVideoUrl so its thumbnails match the flat ads list');
  assert.ok(/buildGridPreviewVideoUrl\s*\(/.test(window),
    'ads-detail must derive it from the shared builder, not hand-roll a second transform');
});

// ── P8: exactly one implementation of the transform ────────────────────────
check('P8 no second, hand-rolled grid transform anywhere in routes/services', () => {
  const dirs = ['routes', 'services'];
  const offenders = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (!f.endsWith('.js') || f === 'videoPreviewUrl.js') continue;
      const src = fs.readFileSync(path.join(ROOT, d, f), 'utf8');
      if (/c_scale,w_\d+,q_auto,f_auto/.test(src)) offenders.push(`${d}/${f}`);
    }
  }
  assert.strictEqual(offenders.length, 0,
    `the transform string must live only in videoPreviewUrl.js; also found in: ${offenders.join(', ')}`);
});

console.log(failures.length
  ? `\n❌ verifyVideoGridPreviewUrl: ${pass} passed, ${failures.length} FAILED\n   ` + failures.join('\n   ')
  : `✅ verifyVideoGridPreviewUrl: ${pass}/${pass} checks passed`);
process.exit(failures.length ? 1 : 0);
