'use strict';
/**
 * verifyNoVisibleSeedPad — a video SEED must never carry a visible band.
 *
 * WHY THIS EXISTS. The seed is reference input to an image-to-video model, so
 * the model reproduces whatever it is shown. A letterboxed seed bakes the bands
 * INTO the delivered video, where no downstream c_crop can reach them — the
 * "shaded bars around the video" the owner reported on PMax 2026-08-11, which
 * reproduced even on seeds that started at 4:5.
 *
 * It hid for days because the pad only runs when the generative outpaint fails,
 * and the outpaint had been dormant since 2026-08-07. When it was switched back
 * on it failed 14/14 against Atlas ("failed to upload output 0 to OSS"), so
 * EVERY video seed fell into the pad path at once.
 *
 * The rule: pad only when the pad is INVISIBLE (a solid fill sampled from a
 * genuinely flat border). Everything else crops.
 *
 * Section A tests the real exported rule behaviourally — it calls the shipped
 * function, so a reimplementation that keeps the name still has to obey it.
 * Section B is a WIRING check: the pure rule is worthless if a call site stops
 * consulting it, and that wiring is buried behind Mongo + network I/O that this
 * offline harness cannot drive. Source-shape is the honest tool there, and it is
 * labelled as such rather than dressed up as behavioural coverage.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { seedPadDecision } = require('../services/atlasVideoService');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyNoVisibleSeedPad\n');

// ── A. behavioural — the shipped rule ──────────────────────────────────────────

ok('flat border with a sampled colour pads solid', () => {
  const d = seedPadDecision({ uniform: true, hex: 'ffffff' });
  assert.strictEqual(d.action, 'pad-solid');
  assert.strictEqual(d.hex, 'ffffff');
});

ok('NON-flat border must crop, never pad', () => {
  const d = seedPadDecision({ uniform: false, hex: null });
  assert.strictEqual(d.action, 'crop', 'a non-flat border must not be padded');
  assert.strictEqual(d.reason, 'border-not-flat');
});

ok('a non-flat border does not become paddable just because a hex was sampled', () => {
  // detectBorderFill can return a colour alongside uniform:false. That colour
  // describes a border that is NOT flat, so filling with it still bands.
  const d = seedPadDecision({ uniform: false, hex: '808080' });
  assert.strictEqual(d.action, 'crop');
});

ok('uniform but no sampled colour crops rather than guessing one', () => {
  const d = seedPadDecision({ uniform: true, hex: null });
  assert.strictEqual(d.action, 'crop');
  assert.strictEqual(d.reason, 'no-sampled-hex');
});

ok('missing / malformed input crops (total function, no throw)', () => {
  for (const bad of [null, undefined, {}, { uniform: 'yes' }, 0, 'x']) {
    const d = seedPadDecision(bad);
    assert.strictEqual(d.action, 'crop', `expected crop for ${JSON.stringify(bad)}`);
  }
});

ok('the rule can only ever pad-solid or crop — no blur tier exists', () => {
  const seen = new Set();
  for (const uniform of [true, false]) {
    for (const hex of ['ffffff', null, '', '000000']) {
      seen.add(seedPadDecision({ uniform, hex }).action);
    }
  }
  assert.deepStrictEqual([...seen].sort(), ['crop', 'pad-solid']);
});

// ── B. wiring — both pad sites must consult the rule ───────────────────────────

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8'
);

ok('both pad sites call seedPadDecision', () => {
  const calls = (SRC.match(/seedPadDecision\(/g) || []).length;
  // 1 definition + 2 call sites (product-only pad, post-outpaint pad fallback).
  assert.ok(calls >= 3, `expected the rule to be consulted at both pad sites, saw ${calls}`);
});

ok('the blurred-cover pad is unreachable from the reframe fallback', () => {
  // padToRatioBuffer blurs a scaled copy of the frame into the bands — the
  // visible smear this harness exists to prevent. It may still be DEFINED
  // (other callers/tests), but reframeReferenceForAspect must not select it.
  const start = SRC.indexOf('async function reframeReferenceForAspect');
  assert.ok(start > 0, 'reframeReferenceForAspect not found — harness is stale');
  const body = SRC.slice(start, SRC.indexOf('\nasync function ', start + 40));
  assert.ok(
    !/padToRatioBuffer\s*\(/.test(body),
    'reframeReferenceForAspect still reaches the blurred-cover pad'
  );
});

ok('Cloudinary gradient pad is never requested with a null colour', () => {
  // cloudinaryPadUrl(url, aspect, null) falls back to b_auto:predominant_gradient,
  // which is a visible band. The colour handed to it must come from the rule.
  assert.ok(
    /const hex = padDec\.hex;/.test(SRC),
    'the product-only pad no longer sources its colour from seedPadDecision'
  );
});

ok('a non-https seed URL is mirrored before it is sent to Atlas', () => {
  // Atlas rejects non-https reference URLs, and the rejection arrives AFTER the
  // POST is charged — so an http source is billed and then discarded.
  assert.ok(
    /!hasAlpha && !needsOrient && \/\^https:\\\/\\\/\/i\.test\(sourceUrl\)/.test(SRC),
    'normalizeReframeSource can still forward a non-https URL untouched'
  );
});

console.log(`\n✅ verifyNoVisibleSeedPad: ${checks}/${checks} checks passed`);
