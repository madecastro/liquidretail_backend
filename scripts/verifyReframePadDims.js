#!/usr/bin/env node
// Offline pins for the reframe-v3 pad-dim change (2026-09-03).
//
// Backend historically padded every 9:16 reference to a fixed 720×1280
// (Atlas 720p-cap era, via `imageDimsForAspect`). Adgen's mirror of the
// same code had drifted to source-native pad dims (e.g., 2000×3556 for a
// 2000×2000 source), and when adgen re-derived a reframe at ad-gen time
// it overwrote the backend-persisted low-res pad with its own high-res
// version — visible in prod on Pelagic run 6a99921e565dd96258ea5eae
// (2026-09-03), where backend wrote w_720,h_1280 during pre-warm and
// adgen overwrote it with w_2000,h_3556 minutes later. Omni saw more
// edge detail on the on-garment graphic in the run that used the
// high-res pad.
//
// This change ports the higher-resolution behaviour into backend so the
// two services agree, and bumps REFRAME_LADDER_VERSION so any cached
// low-res pad on Media docs is treated stale on the next read and
// re-derived uniformly. REFRAME_PAD_TARGET is the kill switch — flipping
// to 'model-720p' restores pre-change behaviour byte-for-byte.
//
// Runs zero DB / zero network.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const svc = require('../services/atlasVideoService');
const {
  cloudinaryPadUrl,
  padDimsForSource,
  padTargetMode,
  imageDimsForAspect,
  REFRAME_LADDER_VERSION
} = svc;

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

// ── Section A — env parser (REFRAME_PAD_TARGET) ──────────────────────

console.log('\n== A. REFRAME_PAD_TARGET env parser ==');

function withEnv(key, value, fn) {
  const prior = process.env[key];
  try {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

check('A1 unset → default source-native', () => {
  withEnv('REFRAME_PAD_TARGET', null, () => {
    assert.strictEqual(padTargetMode(), 'source-native');
  });
});

check('A2 "source-native" → source-native', () => {
  withEnv('REFRAME_PAD_TARGET', 'source-native', () => {
    assert.strictEqual(padTargetMode(), 'source-native');
  });
});

check('A3 "model-720p" → model-720p', () => {
  withEnv('REFRAME_PAD_TARGET', 'model-720p', () => {
    assert.strictEqual(padTargetMode(), 'model-720p');
  });
});

check('A4 "SOURCE-NATIVE" (case-insensitive) → source-native', () => {
  withEnv('REFRAME_PAD_TARGET', 'SOURCE-NATIVE', () => {
    assert.strictEqual(padTargetMode(), 'source-native');
  });
});

check('A5 unrecognized value → source-native (fail-safe)', () => {
  withEnv('REFRAME_PAD_TARGET', 'chunky-monkey', () => {
    assert.strictEqual(padTargetMode(), 'source-native');
  });
});

// ── Section B — padDimsForSource math ────────────────────────────────

console.log('\n== B. padDimsForSource ==');

check('B1 2000×2000 → 9:16 → 2000×3556 (source width preserved)', () => {
  const d = padDimsForSource(2000, 2000, '9:16');
  assert.deepStrictEqual(d, { w: 2000, h: 3556 });
});

check('B2 2000×2000 → 16:9 → 3556×2000 (source height preserved)', () => {
  const d = padDimsForSource(2000, 2000, '16:9');
  assert.deepStrictEqual(d, { w: 3556, h: 2000 });
});

check('B3 1024×1024 → 9:16 → 1024×1820', () => {
  const d = padDimsForSource(1024, 1024, '9:16');
  assert.deepStrictEqual(d, { w: 1024, h: 1820 });
});

check('B4 1920×1080 (already landscape) → 16:9 → 1920×1080 (aspect match, tiny pad)', () => {
  // 1920/1080 = 1.777... === 16/9. Aspects match exactly.
  const d = padDimsForSource(1920, 1080, '16:9');
  // sourceAspect === targetAspect → takes the else branch (keep source height)
  // 1080 * (16/9) = 1920 → 1920×1080
  assert.deepStrictEqual(d, { w: 1920, h: 1080 });
});

check('B5 malformed aspect → null', () => {
  assert.strictEqual(padDimsForSource(2000, 2000, 'garbage'), null);
  assert.strictEqual(padDimsForSource(2000, 2000, ''), null);
  assert.strictEqual(padDimsForSource(2000, 2000, null), null);
});

check('B6 1500×2000 (portrait) → 9:16 (still portrait) → keeps taller dim, extends width to reach 9:16', () => {
  // sourceAspect = 1500/2000 = 0.75. targetAspect = 9/16 = 0.5625.
  // Source is WIDER than target aspect (0.75 > 0.5625) — extend height.
  const d = padDimsForSource(1500, 2000, '9:16');
  // w = 1500 preserved; h = 1500 / 0.5625 = 2666.67 → 2667
  assert.deepStrictEqual(d, { w: 1500, h: 2667 });
});

// ── Section C — cloudinaryPadUrl integration ──────────────────────────

console.log('\n== C. cloudinaryPadUrl ==');

const SRC = 'https://res.cloudinary.com/reach-social-prod/image/upload/v1788382424/catalog-product/x/y.jpg';

check('C1 source-native mode with sourceW+sourceH → uses native dims', () => {
  withEnv('REFRAME_PAD_TARGET', 'source-native', () => {
    const url = cloudinaryPadUrl(SRC, '9:16', 'ffffff', 2000, 2000);
    assert.match(url, /c_pad,w_2000,h_3556/);
    assert.match(url, /b_rgb:ffffff/);
  });
});

check('C2 source-native mode WITHOUT source dims → falls back to 720×1280', () => {
  withEnv('REFRAME_PAD_TARGET', 'source-native', () => {
    const url = cloudinaryPadUrl(SRC, '9:16', 'ffffff');
    assert.match(url, /c_pad,w_720,h_1280/);
  });
});

check('C3 model-720p mode → uses 720×1280 even with source dims provided', () => {
  withEnv('REFRAME_PAD_TARGET', 'model-720p', () => {
    const url = cloudinaryPadUrl(SRC, '9:16', 'ffffff', 2000, 2000);
    assert.match(url, /c_pad,w_720,h_1280/);
  });
});

check('C4 model-720p arm is byte-identical to pre-change output for the canonical case', () => {
  withEnv('REFRAME_PAD_TARGET', 'model-720p', () => {
    // The exact string a pre-2026-09-03 backend produced for the Pelagic
    // Stick Figure Chasin hero pad. If a future refactor breaks this
    // byte-identity, the kill switch stops being a true revert.
    const url = cloudinaryPadUrl(
      'https://res.cloudinary.com/reach-social-prod/image/upload/v1788382432/catalog-product/6a988b49ce057530d979f3dc/product-1788382432367-49-yi36gyep.jpg',
      '9:16',
      'ffffff'
    );
    assert.strictEqual(
      url,
      'https://res.cloudinary.com/reach-social-prod/image/upload/b_rgb:ffffff,c_pad,w_720,h_1280,f_jpg,q_auto:good/v1788382432/catalog-product/6a988b49ce057530d979f3dc/product-1788382432367-49-yi36gyep.jpg'
    );
  });
});

check('C5 source-native shape matches the live adgen output we observed', () => {
  withEnv('REFRAME_PAD_TARGET', 'source-native', () => {
    // Exact URL adgen shipped to Omni on run 6a99921e (Stick Figure Lefty
    // hero). Now backend produces the same shape from the same inputs.
    const url = cloudinaryPadUrl(
      'https://res.cloudinary.com/reach-social-prod/image/upload/v1788382424/catalog-product/6a988b49ce057530d979f3dc/product-1788382424658-41-ohxm1ybd.jpg',
      '9:16',
      'ffffff',
      2000,
      2000
    );
    assert.strictEqual(
      url,
      'https://res.cloudinary.com/reach-social-prod/image/upload/b_rgb:ffffff,c_pad,w_2000,h_3556,f_jpg,q_auto:good/v1788382424/catalog-product/6a988b49ce057530d979f3dc/product-1788382424658-41-ohxm1ybd.jpg'
    );
  });
});

check('C6 non-Cloudinary source → null (unchanged from pre-change)', () => {
  withEnv('REFRAME_PAD_TARGET', 'source-native', () => {
    assert.strictEqual(cloudinaryPadUrl('https://cdn.shopify.com/x.jpg', '9:16', 'ffffff', 2000, 2000), null);
  });
});

check('C7 b_auto:predominant_gradient fallback when hex is null', () => {
  withEnv('REFRAME_PAD_TARGET', 'source-native', () => {
    const url = cloudinaryPadUrl(SRC, '9:16', null, 2000, 2000);
    assert.match(url, /b_auto:predominant_gradient/);
    assert.doesNotMatch(url, /b_rgb:/);
  });
});

// ── Section D — REFRAME_LADDER_VERSION bump ──────────────────────────
//
// Bumping the ladder is what makes the change safe to ship without a
// backfill: every existing Media.metadata.reframes[*] entry ships with
// ladderVersion 'reframe-v2', and REFRAME_REDERIVE_STALE (default true)
// re-derives any entry whose ladderVersion !== the current constant.
// So one flip here is the whole migration.

console.log('\n== D. REFRAME_LADDER_VERSION bump ==');

check('D1 constant is reframe-v3 (bumped 2026-09-03)', () => {
  assert.strictEqual(REFRAME_LADDER_VERSION, 'reframe-v3');
});

// ── Section E — defaults.env commits the shipped value ───────────────

console.log('\n== E. defaults.env commits REFRAME_PAD_TARGET=source-native ==');

const defaults = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'defaults.env'),
  'utf8'
);

check('E1 REFRAME_PAD_TARGET=source-native in defaults.env', () => {
  assert.match(defaults, /^REFRAME_PAD_TARGET=source-native$/m);
});

// ── Section F — structural: cloudinaryPadUrl call site threads media dims ─
//
// The pad path in reframeReferenceForAspect must pass media.width and
// media.height through to cloudinaryPadUrl, or the fail-safe kicks in and
// every source-native call silently falls back to 720×1280. This is the
// same class of trap as the videoRefPrewarmService projection bug: the
// helper does the right thing but the caller doesn't feed it the data.

console.log('\n== F. structural: caller threads media.width/height ==');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'atlasVideoService.js'),
  'utf8'
);

check('F1 cloudinaryPadUrl call in reframeReferenceForAspect passes media.width + media.height', () => {
  // Match: cloudinaryPadUrl(sourceUrl, aspectRatio, hex, media?.width, media?.height)
  // Allow arbitrary whitespace between args.
  assert.match(
    src,
    /cloudinaryPadUrl\(\s*sourceUrl\s*,\s*aspectRatio\s*,\s*hex\s*,\s*media\?\.width\s*,\s*media\?\.height\s*\)/
  );
});

// ── Summary ──────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
