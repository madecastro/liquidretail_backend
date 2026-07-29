#!/usr/bin/env node
'use strict';
/**
 * verifyVideoCropUrl — offline suite for services/videoCropUrl.js.
 *
 * The module emits a URL that Cloudinary either honours exactly or fails at DELIVERY time, i.e.
 * as a broken ad rather than a thrown error. So every guard that stops a bad URL from being built
 * is asserted here.
 *
 * Live end-to-end validation (2026-07-29, real asset 1080x1920 on reach-social-prod) confirmed the
 * emitted chain returns HTTP 200 synchronously with exact dimensions:
 *   4:5 -> 1080x1350, 192 frames    1:1 -> 1080x1080, 192 frames
 * That cannot run in CI (network + a real asset), so it is recorded here rather than asserted.
 *
 * No DB, no network. Safe in CI.
 */

const assert = require('assert');
const { buildVideoCropUrl, isTransformableVideoUrl, hasExistingCropTransform } = require('../services/videoCropUrl');
const { computeGravityCropRect } = require('../services/faceSafeCrop');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const SRC = 'https://res.cloudinary.com/reach-social-prod/video/upload/v1784827554/liquidretail/atlas_renders/clip.mp4';
const SW = 1080, SH = 1920;
const RECT_45 = { cx: 0, cy: 107, cw: 1080, ch: 1350 };
const RECT_11 = { cx: 0, cy: 116, cw: 1080, ch: 1080 };
const base = (o) => ({ sourceUrl: SRC, sourceW: SW, sourceH: SH, ...o });

console.log('\nverifyVideoCropUrl\n');

// ── A. the happy path emits the exact chain, in the right order ────────────
check('A1 emits c_scale then c_crop, in that order', () => {
  const u = buildVideoCropUrl(base({ rect: RECT_45 }));
  const t = u.split('/video/upload/')[1].split('/v1')[0];
  assert.strictEqual(t, 'c_scale,w_1080/c_crop,w_1080,h_1350,x_0,y_107');
});
check('A2 the c_scale prefix pins the coordinate space (present AND first)', () => {
  const u = buildVideoCropUrl(base({ rect: RECT_11 }));
  const t = u.split('/video/upload/')[1];
  // Presence must be asserted separately from ordering: with c_scale absent, indexOf returns -1,
  // which is still "less than" c_crop's index, so an ordering-only assertion silently passes on
  // the exact regression it exists to catch. Found by revert-proving this suite.
  assert.ok(t.includes(`c_scale,w_${SW}`), 'c_scale prefix missing — rect applies in an unpinned space');
  assert.ok(t.includes('c_crop'), 'c_crop missing');
  assert.ok(t.indexOf('c_scale') < t.indexOf('c_crop'),
    'c_crop before c_scale means the rect applies in an unpinned space — the v1 black-bar bug');
});
check('A3 the rest of the URL is preserved verbatim', () => {
  const u = buildVideoCropUrl(base({ rect: RECT_45 }));
  assert.ok(u.startsWith('https://res.cloudinary.com/reach-social-prod/video/upload/'));
  assert.ok(u.endsWith('/v1784827554/liquidretail/atlas_renders/clip.mp4'));
});
check('A4 never emits g_auto / g_face / fl_relative (all wrong for video)', () => {
  const u = buildVideoCropUrl(base({ rect: RECT_11 }));
  for (const bad of ['g_auto', 'g_face', 'g_xy_center', 'fl_relative']) {
    assert.ok(!u.includes(bad), `emitted ${bad}: g_auto is async (423), the others 400 on video`);
  }
});

// ── B. a full-frame rect is a no-op, not a pointless transcode ─────────────
check('B1 a rect covering the whole frame returns the source unchanged', () => {
  const u = buildVideoCropUrl(base({ rect: { cx: 0, cy: 0, cw: SW, ch: SH } }));
  assert.strictEqual(u, SRC);
});
check('B2 9:16 of a 9:16 master is therefore a no-op', () => {
  const r = computeGravityCropRect(SW, SH, 9, 16,
    { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 },
    { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 });
  assert.strictEqual(buildVideoCropUrl(base({ rect: r })), SRC);
});

// ── C. rects that would make Cloudinary clip-and-pad are refused ──────────
// This is the v1 failure: an out-of-space rect silently clipped, then c_lpad black-padded the
// difference. Refusing to build the URL turns that into a visible fallback instead.
const OUT_OF_SPACE = [
  { cx: 0, cy: 0, cw: SW + 2, ch: 100 },
  { cx: 0, cy: 0, cw: 100, ch: SH + 2 },
  { cx: SW - 10, cy: 0, cw: 100, ch: 100 },
  { cx: 0, cy: SH - 10, cw: 100, ch: 100 },
  { cx: -1, cy: 0, cw: 100, ch: 100 },
  { cx: 0, cy: -1, cw: 100, ch: 100 },
];
for (const rect of OUT_OF_SPACE) {
  check(`C1 refuses out-of-space rect ${JSON.stringify(rect)}`, () => {
    assert.strictEqual(buildVideoCropUrl(base({ rect })), null);
  });
}
check('C2 refuses a zero/negative sized rect', () => {
  assert.strictEqual(buildVideoCropUrl(base({ rect: { cx: 0, cy: 0, cw: 0, ch: 100 } })), null);
  assert.strictEqual(buildVideoCropUrl(base({ rect: { cx: 0, cy: 0, cw: 100, ch: -5 } })), null);
});
check('C3 refuses non-integer rect values (Cloudinary rejects fractional crop args)', () => {
  assert.strictEqual(buildVideoCropUrl(base({ rect: { cx: 0.5, cy: 0, cw: 100, ch: 100 } })), null);
  assert.strictEqual(buildVideoCropUrl(base({ rect: { cx: 0, cy: 0, cw: 100.2, ch: 100 } })), null);
});
check('C4 refuses NaN / Infinity rather than emitting a URL that 400s at delivery', () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.strictEqual(buildVideoCropUrl(base({ rect: { cx: v, cy: 0, cw: 100, ch: 100 } })), null);
    assert.strictEqual(buildVideoCropUrl(base({ rect: { cx: 0, cy: 0, cw: 100, ch: 100 }, sourceW: v })), null);
  }
});
check('C5 refuses a missing / null rect', () => {
  assert.strictEqual(buildVideoCropUrl(base({ rect: null })), null);
  assert.strictEqual(buildVideoCropUrl(base({ rect: undefined })), null);
});

// ── D. only Cloudinary video URLs are transformed ──────────────────────────
check('D1 rejects non-video and non-Cloudinary URLs', () => {
  for (const u of [
    'https://res.cloudinary.com/x/image/upload/v1/a.jpg',   // image, not video
    'https://example.com/video.mp4',                        // not Cloudinary
    'https://res.cloudinary.com/x/raw/upload/v1/a.bin',
    '', null, undefined, 42, {},
  ]) {
    assert.strictEqual(buildVideoCropUrl(base({ sourceUrl: u, rect: RECT_45 })), null, `accepted ${String(u)}`);
    assert.strictEqual(isTransformableVideoUrl(u), false, `isTransformableVideoUrl accepted ${String(u)}`);
  }
});
check('D2 accepts a well-formed Cloudinary video URL', () => {
  assert.strictEqual(isTransformableVideoUrl(SRC), true);
});

// ── E. the double-crop guard ───────────────────────────────────────────────
// The most likely real-world failure: the source already went through
// buildVideoSegmentUrl (c_fill,ar_) or an eager transform, and cropping a crop compounds the loss.
check('E1 detects an existing c_fill transform', () => {
  assert.strictEqual(hasExistingCropTransform(SRC.replace('/video/upload/', '/video/upload/c_fill,ar_1:1/')), true);
});
check('E2 detects each crop-ish transform verb', () => {
  for (const verb of ['c_fill', 'c_crop', 'c_scale', 'c_pad', 'c_lpad', 'c_limit', 'c_thumb', 'c_fit']) {
    assert.strictEqual(
      hasExistingCropTransform(SRC.replace('/video/upload/', `/video/upload/${verb},w_100/`)), true, verb);
  }
});
check('E3 refuses to crop an already-cropped URL by default', () => {
  const pre = SRC.replace('/video/upload/', '/video/upload/c_fill,ar_4:5/');
  assert.strictEqual(buildVideoCropUrl(base({ sourceUrl: pre, rect: RECT_11 })), null);
});
check('E4 allowDoubleCrop is an explicit opt-in escape hatch', () => {
  const pre = SRC.replace('/video/upload/', '/video/upload/c_fill,ar_4:5/');
  assert.ok(buildVideoCropUrl(base({ sourceUrl: pre, rect: RECT_11, allowDoubleCrop: true })));
});
check('E5 a public_id containing "c_" is NOT a false positive', () => {
  assert.strictEqual(
    hasExistingCropTransform('https://res.cloudinary.com/x/video/upload/v1/folder/c_thing.mp4'), false,
    'scanning past the version would make every c_-prefixed public_id un-croppable');
});
check('E6 a non-crop transform (so_/du_/q_auto) does NOT trip the guard', () => {
  assert.strictEqual(
    hasExistingCropTransform(SRC.replace('/video/upload/', '/video/upload/so_0,du_8.0,q_auto:good/')), false);
});
check('E7 a crop later in a multi-group chain is still detected', () => {
  assert.strictEqual(
    hasExistingCropTransform(SRC.replace('/video/upload/', '/video/upload/so_0/c_fill,w_540/')), true);
});

// ── F. integration with the geometry module ────────────────────────────────
check('F1 every face-safe rect for a 1080x1920 master yields a usable URL', () => {
  const subj = { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 };
  for (let top = 0; top <= 0.7; top += 0.1) {
    const head = { left: 0.4, top, right: 0.6, bottom: top + 0.18 };
    for (const [wr, hr] of [[9, 16], [4, 5], [1, 1]]) {
      const r = computeGravityCropRect(SW, SH, wr, hr, subj, head);
      if (!r) continue;
      const u = buildVideoCropUrl(base({ rect: r }));
      assert.ok(u, `null URL for ${wr}:${hr} head.top=${top.toFixed(1)} rect=${JSON.stringify(r)}`);
    }
  }
});
check('F2 the emitted crop dimensions equal the geometry window exactly', () => {
  const subj = { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 };
  const head = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };
  for (const [name, wr, hr, want] of [['4:5', 4, 5, '1080,h_1350'], ['1:1', 1, 1, '1080,h_1080']]) {
    const r = computeGravityCropRect(SW, SH, wr, hr, subj, head);
    const u = buildVideoCropUrl(base({ rect: r }));
    assert.ok(u.includes(`c_crop,w_${want}`), `${name}: expected w_${want} in ${u}`);
  }
});

if (failures.length) {
  console.error(`❌ verifyVideoCropUrl: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyVideoCropUrl: ${pass}/${pass} checks passed`);
