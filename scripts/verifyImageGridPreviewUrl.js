#!/usr/bin/env node
/**
 * verifyImageGridPreviewUrl.js
 *
 * Pins services/imagePreviewUrl.js and the two route sites that emit its
 * output — the static-image sibling of scripts/verifyVideoGridPreviewUrl.js.
 *
 * WHY THIS EXISTS: the ad grid rendered every static tile from `renderUrl`
 * (or `photorealUrl` when a photoreal polish exists) — the full-resolution
 * Cloudinary master. Measured real deliveries: 1.5-4.3MB per PNG, so an
 * 18-static gallery alone pulled ~40-50MB. `buildGridPreviewImageUrl`
 * derives a ~640px c_scale/q_auto/f_auto delivery variant of the SAME asset
 * for tile use, while detail views keep using the full-resolution URL
 * untouched — exactly the pattern videoPreviewUrl.js already established
 * for video tiles.
 *
 * BEHAVIOURAL, not source-text, for everything that can be: the transform
 * checks call the real exported `buildGridPreviewImageUrl`, and the
 * projection checks drive the real exported `projectAd` from routes/ads.js.
 * A reimplementation that keeps the names but changes the behaviour still
 * fails.
 *
 * The single exception is P8 (routes/catalog.js `ads-detail`), whose handler
 * is not separately exported; that one is a source check, bounded at the
 * next syntactic boundary rather than a magic character count, so it cannot
 * drift silently into an adjacent route.
 *
 * REVERT-PROOF:
 *   - swap `c_scale` for `c_fill`             -> T3 red (gravity-dependent crop)
 *   - drop `q_auto`/`f_auto`                  -> T2 red
 *   - add a fixed `h_`                        -> T4 red (distorts/letterboxes)
 *   - return null instead of the input for a
 *     non-Cloudinary URL                      -> T5 red (broken <img> src)
 *   - emit previewImageUrl for video ads       -> P2 red
 *   - stop emitting it for image ads           -> P1 red
 *   - stop preferring photorealUrl when set    -> P9 red (grid/detail mismatch)
 *   - drop the catalog ads-detail wiring        -> P8 red
 *
 * Run: node scripts/verifyImageGridPreviewUrl.js
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const { buildGridPreviewImageUrl, GRID_PREVIEW_WIDTH_PX } =
  require(path.join(ROOT, 'services', 'imagePreviewUrl.js'));

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { failures.push(`${name} — ${e.message}`); }
}

const CLOUDINARY_IMAGE =
  'https://res.cloudinary.com/demo/image/upload/v1712345678/ads/static_4x5.png';

// ── T1: a real Cloudinary image URL gets a transform segment inserted ──────
check('T1 inserts a transform directly after /image/upload/', () => {
  const out = buildGridPreviewImageUrl(CLOUDINARY_IMAGE);
  assert.notStrictEqual(out, CLOUDINARY_IMAGE, 'expected a transformed URL, got the input back');
  assert.ok(out.includes('/image/upload/'), 'upload marker must survive');
  const seg = out.split('/image/upload/')[1].split('/')[0];
  assert.ok(/^[a-z]{1,2}_/.test(seg), `expected a transform segment, saw "${seg}"`);
  // the rest of the path must be preserved verbatim — same asset, not a new one
  assert.ok(out.endsWith('/v1712345678/ads/static_4x5.png'),
    `asset path must be preserved, got ${out}`);
});

// ── T2: the three levers that make the tile cheap are all present ──────────
check('T2 carries c_scale + q_auto + f_auto', () => {
  const out = buildGridPreviewImageUrl(CLOUDINARY_IMAGE);
  for (const lever of ['c_scale', 'q_auto', 'f_auto']) {
    assert.ok(out.includes(lever), `missing ${lever} in ${out}`);
  }
  assert.ok(out.includes(`w_${GRID_PREVIEW_WIDTH_PX}`),
    `expected w_${GRID_PREVIEW_WIDTH_PX} in ${out}`);
});

// ── T3: never a gravity-dependent crop ─────────────────────────────────────
check('T3 uses no c_fill / no gravity mode', () => {
  const out = buildGridPreviewImageUrl(CLOUDINARY_IMAGE);
  assert.ok(!out.includes('c_fill'), `must not c_fill (needs gravity): ${out}`);
  assert.ok(!/[,/]g_/.test(out), `must not set a gravity mode: ${out}`);
});

// ── T4: aspect ratio is not forced — width only, height stays proportional ─
// Statics ship in 1:1, 4:5, 9:16, 1.91:1 and flat 1200x1200 — a fixed h_
// would distort or letterbox every non-square format.
check('T4 sets width only, never a fixed height', () => {
  const out = buildGridPreviewImageUrl(CLOUDINARY_IMAGE);
  const seg = out.split('/image/upload/')[1].split('/')[0];
  assert.ok(!/(^|,)h_\d/.test(seg),
    `a fixed h_ would distort or letterbox non-square statics: ${seg}`);
});

// ── T5: fall back to the input rather than emitting a broken link ─────────
check('T5 non-Cloudinary URL passes through unchanged', () => {
  const foreign = 'https://cdn.example.com/images/thing.png';
  assert.strictEqual(buildGridPreviewImageUrl(foreign), foreign,
    'a non-transformable URL must pass through, not become null');
});

check('T5a a video-upload Cloudinary URL is not treated as image', () => {
  const vid = 'https://res.cloudinary.com/demo/video/upload/v1/ads/a.mp4';
  assert.strictEqual(buildGridPreviewImageUrl(vid), vid);
});

// ── T6: null/undefined in -> null out (never the string "undefined") ──────
check('T6 nullish input yields null', () => {
  assert.strictEqual(buildGridPreviewImageUrl(null), null);
  assert.strictEqual(buildGridPreviewImageUrl(undefined), null);
  assert.strictEqual(buildGridPreviewImageUrl(''), null);
});

// ── T7: caller-supplied width is honoured ──────────────────────────────────
check('T7 opts.width overrides the default', () => {
  const out = buildGridPreviewImageUrl(CLOUDINARY_IMAGE, { width: 240 });
  assert.ok(out.includes('w_240'), `expected w_240 in ${out}`);
  assert.ok(!out.includes(`w_${GRID_PREVIEW_WIDTH_PX}`), 'default width must not also appear');
});

// ── T8: the variant is a strictly smaller ask than the measured masters ───
// Real deliveries measured 1.5-4.3MB at full size; the declared tile width
// must stay a small fraction of that, well under typical 2000-4000px masters.
check('T8 declared grid width is well below a typical static master', () => {
  assert.ok(GRID_PREVIEW_WIDTH_PX > 0 && GRID_PREVIEW_WIDTH_PX <= 960,
    `grid width ${GRID_PREVIEW_WIDTH_PX} defeats the purpose of a thumbnail tier`);
});

// ── Projection wiring: drive the REAL exported projectAd ──────────────────
const { projectAd } = require(path.join(ROOT, 'routes', 'ads.js'));

function adFixture(over = {}) {
  return {
    _id: '000000000000000000000001',
    kind: 'image',
    renderUrl: CLOUDINARY_IMAGE,
    copy: {},
    ...over
  };
}

check('P1 projectAd emits a downscaled previewImageUrl for an image ad', () => {
  const out = projectAd(adFixture(), false, {});
  assert.ok('previewImageUrl' in out, 'projectAd must emit previewImageUrl');
  assert.ok(out.previewImageUrl, 'previewImageUrl must be populated for an image ad');
  assert.ok(out.previewImageUrl.includes('c_scale'),
    `expected the downscaled variant, got ${out.previewImageUrl}`);
  assert.notStrictEqual(out.previewImageUrl, out.renderUrl,
    'the tile URL must differ from the full master');
});

check('P2 video ads get previewImageUrl: null', () => {
  const out = projectAd(adFixture({ kind: 'video' }), false, {});
  assert.strictEqual(out.previewImageUrl, null,
    'a video ad must not carry a static-image tile URL (previewVideoUrl already covers it)');
});

check('P3 renderUrl is left untouched — detail view keeps the master', () => {
  const out = projectAd(adFixture(), false, {});
  assert.strictEqual(out.renderUrl, CLOUDINARY_IMAGE,
    'renderUrl must remain the full-quality master');
});

check('P4 an image ad with no renderUrl and no photoreal yields null, not a broken string', () => {
  const out = projectAd(adFixture({ renderUrl: null }), false, {});
  assert.strictEqual(out.previewImageUrl, null);
});

check('P5 a non-Cloudinary image renderUrl falls back to itself', () => {
  const foreign = 'https://cdn.example.com/i/x.png';
  const out = projectAd(adFixture({ renderUrl: foreign }), false, {});
  assert.strictEqual(out.previewImageUrl, foreign,
    'fallback must be the original URL so the <img> still has a src');
});

check('P6 the field is present in the full projection too', () => {
  const out = projectAd(adFixture(), true, {});
  assert.ok('previewImageUrl' in out, 'full projection must also carry the field');
});

check('P9 photorealUrl (when present) is previewed, not the pre-polish renderUrl', () => {
  // Mirrors displayUrlFor()/displayUrl() on the frontend: an image ad shows
  // photorealUrl over renderUrl whenever the polish is populated. The grid
  // tile must downscale THAT asset, or the tile and the detail modal would
  // show two different images at two different sizes.
  const photoreal = 'https://res.cloudinary.com/demo/image/upload/v1/ads/polished.png';
  const out = projectAd(adFixture(), false, { photorealUrl: photoreal });
  assert.ok(out.previewImageUrl.includes('polished'),
    `expected the previewed asset to be the photoreal polish, got ${out.previewImageUrl}`);
  assert.ok(!out.previewImageUrl.includes('static_4x5'),
    `must not silently fall back to the pre-polish render when photoreal is set: ${out.previewImageUrl}`);
});

// ── P8: routes/catalog.js ads-detail — source check, bounded structurally ─
// This handler is not separately exported, so it cannot be driven directly.
// The window is bounded at the NEXT router registration, not a character
// count, so it can never silently widen into an adjacent route.
check('P8 catalog ads-detail also emits previewImageUrl', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'catalog.js'), 'utf8');
  const start = src.indexOf("router.get('/:id/ads-detail'");
  assert.ok(start > -1, "could not locate the ads-detail route — did it get renamed?");
  const after = src.slice(start + 1);
  const nextRoute = after.search(/\brouter\.(get|post|put|patch|delete)\s*\(/);
  const window = nextRoute === -1 ? after : after.slice(0, nextRoute);
  assert.ok(/previewImageUrl\s*:/.test(window),
    'ads-detail must emit previewImageUrl so its thumbnails match the flat ads list');
  assert.ok(/buildGridPreviewImageUrl\s*\(/.test(window),
    'ads-detail must derive it from the shared builder, not hand-roll a second transform');
  // The $project allowlist in this handler drops any field not explicitly
  // named (the exact trap previewVideoUrl already hit) — renderUrl must be
  // in that allowlist or previewImageUrl silently computes off `undefined`.
  const projectStart = src.indexOf('$project', start);
  assert.ok(projectStart > -1 && projectStart < (nextRoute === -1 ? Infinity : start + 1 + nextRoute),
    'expected a $project stage inside the ads-detail aggregation');
  const projectWindow = src.slice(projectStart, projectStart + 400);
  assert.ok(/renderUrl\s*:\s*1/.test(projectWindow),
    'renderUrl must be in the ads-detail $project allowlist or previewImageUrl computes off undefined');
});

// ── P10: exactly one implementation of the image grid transform ───────────
check('P10 no second, hand-rolled grid transform anywhere in routes/services', () => {
  const dirs = ['routes', 'services'];
  const offenders = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      // f.startsWith('.') skip — same convention as verifyMetaApiVersion.js's
      // fix (real, reproduced revertprove-race in CI: a sibling harness
      // briefly writes a `.__revertprove_*.js` transient into routes/ or
      // services/, both scanned here).
      if (!f.endsWith('.js') || f === 'imagePreviewUrl.js' || f.startsWith('.')) continue;
      const src = fs.readFileSync(path.join(ROOT, d, f), 'utf8');
      if (new RegExp(`c_scale,w_\\d+,q_auto,f_auto`).test(src) && f !== 'videoPreviewUrl.js') {
        offenders.push(`${d}/${f}`);
      }
    }
  }
  assert.strictEqual(offenders.length, 0,
    `the image transform string must live only in imagePreviewUrl.js (videoPreviewUrl.js owns the ` +
    `video copy); also found in: ${offenders.join(', ')}`);
});

console.log(failures.length
  ? `\n❌ verifyImageGridPreviewUrl: ${pass} passed, ${failures.length} FAILED\n   ` + failures.join('\n   ')
  : `✅ verifyImageGridPreviewUrl: ${pass}/${pass} checks passed`);
process.exit(failures.length ? 1 : 0);
