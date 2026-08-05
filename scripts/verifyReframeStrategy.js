#!/usr/bin/env node
// Offline pins for services/reframeStrategyChooser.js. Runs zero DB / zero
// network — fixtures drive every path. Failures are structural (missing
// helper, wrong shape) or behavioural (a fixture that used to crop now
// outpaints).
//
// Includes both the b05-style success case (single subject, ~53% subject
// fraction, target 9:16 — deterministic crop wins) and the b13-style
// deferral case (4 subjects spanning 1370px horizontally, target 9:16 —
// union doesn't fit crop window, defers to outpaint) so the harness pins
// the fix against a real prod failure.

'use strict';

const assert = require('assert');
const path = require('path');

// Load defaults.env so REFRAME_STRATEGY resolves the same way in prod.
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const chooser = require('../services/reframeStrategyChooser');
const { chooseStrategy, isCropFirstEnabled, __test } = chooser;
const { parseAspect, subjectUnionBbox, computeCropRect, buildCloudinaryCropUrl } = __test;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// ── Section 1: pure helpers ───────────────────────────────────────────

console.log('\n== parseAspect ==');
check('parses 9:16', () => assert.strictEqual(parseAspect('9:16'), 9 / 16));
check('parses 1:1',  () => assert.strictEqual(parseAspect('1:1'),  1));
check('parses 1.91:1', () => assert.strictEqual(parseAspect('1.91:1'), 1.91));
check('rejects empty', () => assert.strictEqual(parseAspect(''), null));
check('rejects malformed', () => assert.strictEqual(parseAspect('foo'), null));
check('rejects 0:0', () => assert.strictEqual(parseAspect('0:0'), null));

console.log('\n== subjectUnionBbox ==');
check('null when refinedProducts empty', () => {
  assert.strictEqual(subjectUnionBbox({ refinedProducts: [] }), null);
});
check('null when refinedProducts undefined', () => {
  assert.strictEqual(subjectUnionBbox({}), null);
});
check('single bbox = single bbox', () => {
  const u = subjectUnionBbox({ refinedProducts: [{ x1: 100, y1: 200, x2: 400, y2: 800 }] });
  assert.deepStrictEqual(u, { x1: 100, y1: 200, x2: 400, y2: 800, count: 1 });
});
check('unions 4 bboxes (b13 fixture)', () => {
  const u = subjectUnionBbox({
    refinedProducts: [
      { x1: 1344, y1: 674, x2: 1672, y2: 1381 },
      { x1: 1344, y1: 315, x2: 1667, y2: 958 },
      { x1: 302,  y1: 0,   x2: 588,  y2: 883 },
      { x1: 675,  y1: 1345, x2: 1269, y2: 2007 }
    ]
  });
  assert.deepStrictEqual(u, { x1: 302, y1: 0, x2: 1672, y2: 2007, count: 4 });
});
check('drops malformed rows', () => {
  const u = subjectUnionBbox({
    refinedProducts: [
      { x1: 10, y1: 20, x2: 30, y2: 40 },
      { x1: NaN, y1: 0, x2: 100, y2: 100 },          // bad
      { x1: 50, y1: 60, x2: 30, y2: 40 },            // x2<x1
      { x1: 200, y1: 300, x2: 400, y2: 500 }
    ]
  });
  assert.deepStrictEqual(u, { x1: 10, y1: 20, x2: 400, y2: 500, count: 2 });
});

console.log('\n== computeCropRect ==');
check('null when aspects already match', () => {
  const r = computeCropRect({ sourceW: 720, sourceH: 1280, targetAspect: 9 / 16, subject: { x1: 100, y1: 100, x2: 200, y2: 200 } });
  assert.strictEqual(r, null);
});
check('wider source → crop horizontally (b05 fixture)', () => {
  // b05: 1692×2018, subject centered-ish, target 9:16
  const r = computeCropRect({
    sourceW: 1692, sourceH: 2018,
    targetAspect: 9 / 16,
    // Single subject at ~53% area, near center
    subject: { x1: 350, y1: 200, x2: 1050, y2: 1600 }
  });
  assert.ok(r, 'expected crop rect');
  assert.strictEqual(r.h, 2018, 'height should equal source height');
  assert.strictEqual(r.w, Math.round(2018 * 9 / 16), 'width should be target-aspect ratio of height');
  assert.ok(r.w < 1692, 'crop width less than source width');
  assert.ok(r.x >= 0 && r.x + r.w <= 1692, 'rect within source bounds');
  assert.ok(r.y >= 0 && r.y + r.h <= 2018, 'rect within source bounds');
});
check('wider source with subject at edge → clamps to source', () => {
  const r = computeCropRect({
    sourceW: 1692, sourceH: 2018,
    targetAspect: 9 / 16,
    subject: { x1: 0, y1: 0, x2: 400, y2: 400 }   // subject at left edge
  });
  assert.ok(r);
  assert.strictEqual(r.x, 0, 'clamped x=0');
});
check('taller source → crop vertically', () => {
  // Landscape target from tall source
  const r = computeCropRect({
    sourceW: 720, sourceH: 2000,
    targetAspect: 1 / 1,
    subject: { x1: 100, y1: 800, x2: 600, y2: 1400 }
  });
  assert.ok(r);
  assert.strictEqual(r.w, 720, 'width equals source');
  assert.strictEqual(r.h, 720, 'height matches 1:1 of width');
});
check('subject too wide to fit → null (b13 fixture)', () => {
  // 4 person unions from prod b13: 302→1672 (1370px wide) into 1135-wide 9:16 window
  const r = computeCropRect({
    sourceW: 1692, sourceH: 2018,
    targetAspect: 9 / 16,
    subject: { x1: 302, y1: 0, x2: 1672, y2: 2007 }
  });
  assert.strictEqual(r, null, 'expected null — union 1370px > 1135px window');
});
check('subject exactly at crop-width boundary defers (safety margin)', () => {
  // Subject that would fit without margin but not with the 8px CROP_SAFETY_MARGIN_PX
  const cropW = Math.round(2018 * 9 / 16);
  const subjW = cropW;
  const r = computeCropRect({
    sourceW: 1692, sourceH: 2018,
    targetAspect: 9 / 16,
    subject: { x1: 100, y1: 100, x2: 100 + subjW, y2: 500 }
  });
  assert.strictEqual(r, null, 'safety margin should push over');
});

console.log('\n== buildCloudinaryCropUrl ==');
check('inserts c_crop into Cloudinary URL', () => {
  const url = buildCloudinaryCropUrl(
    'https://res.cloudinary.com/foo/image/upload/v123/bar/baz.jpg',
    { x: 100, y: 200, w: 500, h: 800 }
  );
  assert.match(url, /image\/upload\/c_crop,w_500,h_800,x_100,y_200,f_jpg,q_auto:good\/v123/);
});
check('null for non-Cloudinary URL', () => {
  assert.strictEqual(buildCloudinaryCropUrl('https://example.com/foo.jpg', { x: 0, y: 0, w: 100, h: 100 }), null);
});
check('null for undefined URL', () => {
  assert.strictEqual(buildCloudinaryCropUrl(null, { x: 0, y: 0, w: 100, h: 100 }), null);
});
check('rounds fractional coords', () => {
  const url = buildCloudinaryCropUrl(
    'https://res.cloudinary.com/foo/image/upload/v1/bar.jpg',
    { x: 100.7, y: 200.3, w: 500.5, h: 800.4 }
  );
  assert.match(url, /c_crop,w_501,h_800,x_101,y_200/);
});

// ── Section 2: chooseStrategy end-to-end with kill switch ─────────────

console.log('\n== chooseStrategy — kill switch ==');
{
  const prior = process.env.REFRAME_STRATEGY;
  try {
    process.env.REFRAME_STRATEGY = 'outpaint-only';
    check('outpaint-only → defer', () => {
      const s = chooseStrategy({ media: { width: 1692, height: 2018, refinedProducts: [{ x1: 100, y1: 100, x2: 500, y2: 500 }] }, aspectRatio: '9:16', sourceUrl: 'https://res.cloudinary.com/foo/image/upload/v1/x.jpg' });
      assert.strictEqual(s.action, 'defer');
      assert.match(s.reason, /REFRAME_STRATEGY!=crop-first/);
    });
    process.env.REFRAME_STRATEGY = '';
    check('unset → defer (default outpaint-only)', () => {
      const s = chooseStrategy({ media: { width: 1692, height: 2018 }, aspectRatio: '9:16', sourceUrl: 'x' });
      assert.strictEqual(s.action, 'defer');
    });
  } finally {
    process.env.REFRAME_STRATEGY = prior;
  }
}

console.log('\n== chooseStrategy — crop-first enabled ==');
const prior = process.env.REFRAME_STRATEGY;
process.env.REFRAME_STRATEGY = 'crop-first';
try {
  check('unknown source dims → defer', () => {
    const s = chooseStrategy({ media: { refinedProducts: [{ x1: 0, y1: 0, x2: 100, y2: 100 }] }, aspectRatio: '9:16', sourceUrl: 'https://res.cloudinary.com/f/image/upload/v1/x.jpg' });
    assert.strictEqual(s.action, 'defer');
    assert.match(s.reason, /source dims unknown/);
  });

  check('invalid target aspect → defer', () => {
    const s = chooseStrategy({ media: { width: 1000, height: 1000 }, aspectRatio: 'garbage', sourceUrl: 'x' });
    assert.strictEqual(s.action, 'defer');
    assert.match(s.reason, /invalid target aspect/);
  });

  check('aspect already matches → skip', () => {
    const s = chooseStrategy({ media: { width: 720, height: 1280, refinedProducts: [{ x1: 0, y1: 0, x2: 100, y2: 100 }] }, aspectRatio: '9:16', sourceUrl: 'https://res.cloudinary.com/f/image/upload/v1/x.jpg' });
    assert.strictEqual(s.action, 'skip');
    assert.match(s.reason, /aspect match/);
  });

  check('no YOLO output → defer', () => {
    const s = chooseStrategy({ media: { width: 1692, height: 2018, refinedProducts: [] }, aspectRatio: '9:16', sourceUrl: 'https://res.cloudinary.com/f/image/upload/v1/x.jpg' });
    assert.strictEqual(s.action, 'defer');
    assert.match(s.reason, /no YOLO subject bbox/);
  });

  check('b05 fixture (single subject fits) → crop', () => {
    const s = chooseStrategy({
      media: {
        width: 1692, height: 2018,
        refinedProducts: [{ x1: 400, y1: 200, x2: 1050, y2: 1700 }]
      },
      aspectRatio: '9:16',
      sourceUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1785944632/catalog-product/x/y.jpg'
    });
    assert.strictEqual(s.action, 'crop');
    assert.strictEqual(s.method, 'yolo-crop');
    assert.match(s.url, /c_crop,w_\d+,h_\d+,x_\d+,y_\d+/);
    assert.ok(s.rect.w > 0 && s.rect.h > 0);
  });

  check('b13 fixture (4 people, union 1370px wide) → defer', () => {
    const s = chooseStrategy({
      media: {
        width: 1692, height: 2018,
        refinedProducts: [
          { x1: 1344, y1: 674, x2: 1672, y2: 1381 },
          { x1: 1344, y1: 315, x2: 1667, y2: 958 },
          { x1: 302,  y1: 0,   x2: 588,  y2: 883 },
          { x1: 675,  y1: 1345, x2: 1269, y2: 2007 }
        ]
      },
      aspectRatio: '9:16',
      sourceUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1785944632/catalog-product/x/y.jpg'
    });
    assert.strictEqual(s.action, 'defer', `expected defer, got ${s.action} (${s.reason})`);
    assert.match(s.reason, /doesn't fit target-aspect crop window/);
    assert.ok(s.subjectUnion, 'subjectUnion should be surfaced on defer');
  });

  check('non-Cloudinary source → defer', () => {
    const s = chooseStrategy({
      media: { width: 1692, height: 2018, refinedProducts: [{ x1: 400, y1: 200, x2: 1050, y2: 1700 }] },
      aspectRatio: '9:16',
      sourceUrl: 'https://example.com/some-image.jpg'
    });
    assert.strictEqual(s.action, 'defer');
    assert.match(s.reason, /Cloudinary/);
  });

  check('crop URL preserves Cloudinary version + path', () => {
    const src = 'https://res.cloudinary.com/reach-social-prod/image/upload/v1785944632/catalog-product/6a6a4d58/product-x.jpg';
    const s = chooseStrategy({
      media: { width: 1692, height: 2018, refinedProducts: [{ x1: 400, y1: 200, x2: 1050, y2: 1700 }] },
      aspectRatio: '9:16', sourceUrl: src
    });
    assert.match(s.url, /v1785944632\/catalog-product\/6a6a4d58\/product-x\.jpg$/);
  });

} finally {
  process.env.REFRAME_STRATEGY = prior;
}

// ── Summary ───────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter((r) => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
