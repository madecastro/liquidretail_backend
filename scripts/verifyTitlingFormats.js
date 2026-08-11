#!/usr/bin/env node
'use strict';
/**
 * verifyTitlingFormats — offline registry-completeness guard for titling formats.
 *
 * WHY THIS EXISTS
 * A 1:1 video ad was silently titled at 1080x1350 for an unknown period. Root cause:
 * classifyFormat was a three-way branch ending in `return 'feed'`, so 1:1 matched
 * nothing and fell through. Nothing failed — BasePlate's objectFit:'cover' happily
 * centre-cropped a square ad into a 4:5 frame, and the Ad row still said '1:1'.
 *
 * Every check below is one that would have caught that, or catches the equivalent for
 * the NEXT format someone adds. Adding a format touches at least eight registries
 * across five files; the whole point is that forgetting one fails loudly here rather
 * than shipping subtly-wrong creative.
 *
 * No DB, no network, no API key. Safe in CI.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const { FORMATS } = require('../services/titleSpecValidator');
const { COMPOSITION_BY_FORMAT } = require('../services/remotionRenderService');
const { classifyFormat, isSquareFormat, BRAND_SCRIPT_FIELD } = require('../services/brandScriptExecutor');
const { PLATFORM_FORMATS } = require('../services/platformFormats');
const canonical = JSON.parse(fs.readFileSync(path.join(ROOT, 'remotion/presets/canonical.json'), 'utf8'));

// Root.jsx is JSX so it cannot be required from CJS. Extract the <Composition>
// id/width/height triples structurally rather than trusting a hand-kept list.
const rootSrc = fs.readFileSync(path.join(ROOT, 'remotion/Root.jsx'), 'utf8');
const compositions = {};
for (const block of rootSrc.split('<Composition').slice(1)) {
  const id = /id="([A-Za-z0-9_]+)"/.exec(block)?.[1];
  const w = /width=\{(\d+)\}/.exec(block)?.[1];
  const h = /height=\{(\d+)\}/.exec(block)?.[1];
  const fmt = /format:\s*'([a-z]+)'/.exec(block)?.[1];
  if (id) compositions[id] = { width: Number(w), height: Number(h), format: fmt };
}

// SAFE_ZONES lives in an ESM file; read it as text and pull the top-level keys.
const safeSrc = fs.readFileSync(path.join(ROOT, 'remotion/lib/safeZones.js'), 'utf8');
const safeZoneBlock = /export const SAFE_ZONES = \{([\s\S]*?)\n\};/.exec(safeSrc)?.[1] || '';
const safeZoneKeys = [...safeZoneBlock.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(m => m[1]);

// BASE_SIZE + the alias, same treatment.
const slotSrc = fs.readFileSync(path.join(ROOT, 'remotion/components/slotRenderers.jsx'), 'utf8');
const baseSizeBlock = /const BASE_SIZE = \{([\s\S]*?)\n\};/.exec(slotSrc)?.[1] || '';
const sizeAliasBlock = /const SIZE_FORMAT_ALIAS = \{([^}]*)\}/.exec(slotSrc)?.[1] || '';

console.log(`\nverifyTitlingFormats — FORMATS = [${FORMATS.join(', ')}]\n`);

// ── A. Registry completeness: every format resolves everywhere ───────────────
for (const f of FORMATS) {
  check(`A1 canonical.json has byFormat.${f}`, () => {
    assert.ok(canonical.byFormat?.[f], `missing — titleSpecService.resolveSpec THROWS at its guaranteed-floor step for '${f}'`);
  });
  check(`A2 canonical.byFormat.${f} has slots`, () => {
    const slots = canonical.byFormat[f]?.slots;
    assert.ok(Array.isArray(slots) && slots.length > 0, 'no slots — would title a blank overlay');
  });
  check(`A3 COMPOSITION_BY_FORMAT.${f}`, () => {
    assert.ok(COMPOSITION_BY_FORMAT[f], "missing — renderTitles throws 'unknown format'");
  });
  check(`A4 composition ${COMPOSITION_BY_FORMAT[f] || '?'} is declared in Root.jsx`, () => {
    assert.ok(compositions[COMPOSITION_BY_FORMAT[f]], 'mapped to a composition id that Root.jsx does not register');
  });
  check(`A5 SAFE_ZONES.${f}`, () => {
    assert.ok(safeZoneKeys.includes(f), 'missing — stackContainerStyle silently falls back to feed zones');
  });
  check(`A6 BASE_SIZE resolves for ${f}`, () => {
    const hasOwn = new RegExp(`\\b${f}:\\s*\\d`).test(baseSizeBlock);
    const aliased = new RegExp(`\\b${f}:`).test(sizeAliasBlock);
    assert.ok(hasOwn || aliased,
      'neither a BASE_SIZE column nor a SIZE_FORMAT_ALIAS entry — baseSize() would return its ?? 24 default for EVERY slot, which renders wrong rather than failing');
  });
  check(`A7 BRAND_SCRIPT_FIELD.${f}`, () => {
    assert.ok(BRAND_SCRIPT_FIELD[f], 'missing — the canvas path would read brand[undefined]');
  });
}

// ── B. classifyFormat round-trips ───────────────────────────────────────────
// The bug was a format that classified to something else. Assert both directions.
const ASPECT_BY_FORMAT = { vertical: '9:16', feed: '4:5', square: '1:1', landscape: '16:9' };
for (const f of FORMATS) {
  check(`B1 aspectRatio ${ASPECT_BY_FORMAT[f]} classifies to '${f}'`, () => {
    assert.ok(ASPECT_BY_FORMAT[f], `no aspect mapping for format '${f}' — add one here and in routes/brand.js`);
    assert.strictEqual(classifyFormat({ aspectRatio: ASPECT_BY_FORMAT[f] }), f);
  });
}

// Every live platform format must classify to a declared titling format.
// DeliveryDims↔composition is only meaningful for formats that can be TITLED
// (kinds includes 'video'): brandScriptExecutor/Remotion never run for
// static-only surfaces. Static-only live keys (e.g. pmax_landscape_1_91_1 at
// 1.91:1) legitimately have deliveryDims that do not match a Remotion canvas
// — they never enter the titling path. Do NOT "restore" an unscoped B3 that
// requires every live format to match a composition; that re-fails Phase A.
// Only live (generatable) surfaces are checked; coming_soon entries are
// UI-only until they go live.
for (const [pfId, pf] of Object.entries(PLATFORM_FORMATS)) {
  if (pf.status === 'coming_soon') continue;
  check(`B2 platformFormat ${pfId} (${pf.aspectRatio}) classifies to a known format`, () => {
    const f = classifyFormat({ platformFormat: pfId, aspectRatio: pf.aspectRatio });
    assert.ok(FORMATS.includes(f), `classified to '${f}', which is not in FORMATS`);
  });
  const isVideoCapable = Array.isArray(pf.kinds) && pf.kinds.includes('video');
  if (!isVideoCapable) continue;
  check(`B3 ${pfId} deliveryDims match its composition (video-capable only)`, () => {
    const f = classifyFormat({ platformFormat: pfId, aspectRatio: pf.aspectRatio });
    const comp = compositions[COMPOSITION_BY_FORMAT[f]];
    assert.ok(comp, `no composition for '${f}'`);
    const want = pf.deliveryDims;
    const wantRatio = want.width / want.height;
    const gotRatio = comp.width / comp.height;
    assert.ok(Math.abs(wantRatio - gotRatio) < 0.01,
      `${pfId} delivers ${want.width}x${want.height} (${wantRatio.toFixed(3)}) but renders in ` +
      `${COMPOSITION_BY_FORMAT[f]} ${comp.width}x${comp.height} (${gotRatio.toFixed(3)}) — ` +
      `the ad would be delivered at the wrong aspect`);
  });
}
// Explicit pin: the three live PMax video masters/derive surfaces each map to
// the composition whose aspect matches their deliveryDims.
check('B3b pmax_video_9_16 → CanonicalVertical 1080x1920', () => {
  const f = classifyFormat({ platformFormat: 'pmax_video_9_16', aspectRatio: '9:16' });
  assert.strictEqual(f, 'vertical');
  assert.strictEqual(COMPOSITION_BY_FORMAT[f], 'CanonicalVertical');
  const comp = compositions.CanonicalVertical;
  assert.deepStrictEqual({ w: comp.width, h: comp.height }, { w: 1080, h: 1920 });
});
check('B3b pmax_video_1_1 → CanonicalSquare 1080x1080', () => {
  const f = classifyFormat({ platformFormat: 'pmax_video_1_1', aspectRatio: '1:1' });
  assert.strictEqual(f, 'square');
  assert.strictEqual(COMPOSITION_BY_FORMAT[f], 'CanonicalSquare');
  const comp = compositions.CanonicalSquare;
  assert.deepStrictEqual({ w: comp.width, h: comp.height }, { w: 1080, h: 1080 });
});
check('B3b pmax_video_16_9 → CanonicalLandscape 1920x1080', () => {
  const f = classifyFormat({ platformFormat: 'pmax_video_16_9', aspectRatio: '16:9' });
  assert.strictEqual(f, 'landscape');
  assert.strictEqual(COMPOSITION_BY_FORMAT[f], 'CanonicalLandscape');
  const comp = compositions.CanonicalLandscape;
  assert.deepStrictEqual({ w: comp.width, h: comp.height }, { w: 1920, h: 1080 });
});

// ── C. The specific regression, pinned ──────────────────────────────────────
check('C1 1:1 does NOT classify as feed (the original bug)', () => {
  assert.strictEqual(classifyFormat({ aspectRatio: '1:1' }), 'square');
  assert.strictEqual(classifyFormat({ platformFormat: 'meta_feed_1_1' }), 'square');
});
check('C2 square composition is exactly 1080x1080', () => {
  const comp = compositions[COMPOSITION_BY_FORMAT.square];
  assert.strictEqual(comp.width, 1080);
  assert.strictEqual(comp.height, 1080);
});
check('C3 isSquareFormat is anchored to the _1_1 suffix, not a loose match', () => {
  assert.strictEqual(isSquareFormat({ platformFormat: 'meta_feed_1_1' }), true);
  // These must NOT be square. pmax_16_9 is the one a loose /1_1/ would still miss,
  // but a future id like meta_1_1_legacy would trip an unanchored pattern.
  assert.strictEqual(isSquareFormat({ platformFormat: 'meta_feed_4_5' }), false);
  assert.strictEqual(isSquareFormat({ platformFormat: 'pmax_16_9' }), false);
  assert.strictEqual(isSquareFormat({ platformFormat: 'meta_reels_9_16' }), false);
  assert.strictEqual(isSquareFormat({}), false);
});
check('C4 every composition declared in Root.jsx is reachable from COMPOSITION_BY_FORMAT', () => {
  const mapped = new Set(Object.values(COMPOSITION_BY_FORMAT));
  const orphans = Object.keys(compositions).filter(id => !mapped.has(id));
  assert.strictEqual(orphans.length, 0, `orphaned composition(s): ${orphans.join(', ')} — registered but unreachable`);
});
check("C5 each composition's defaultProps.format matches its mapping", () => {
  for (const [f, id] of Object.entries(COMPOSITION_BY_FORMAT)) {
    const comp = compositions[id];
    if (comp?.format) {
      assert.strictEqual(comp.format, f,
        `${id} carries defaultProps.format='${comp.format}' but is mapped from '${f}' — safe zones and text sizes would disagree with the canvas`);
    }
  }
});

// ── D. Square's canonical is fit for a shorter canvas ───────────────────────
check('D1 square canonical single-lines every slot (shorter canvas than feed)', () => {
  const over = canonical.byFormat.square.slots
    .filter(s => (s.treatment?.maxLines || 1) > 1)
    .map(s => s.key);
  assert.strictEqual(over.length, 0,
    `slots still allow multi-line on the 1080x1080 canvas: ${over.join(', ')} — ` +
    'square has ~432px of lowerThird stack room vs feed\'s ~540px');
});
check('D2 square keeps feed\'s slot coverage (no content silently dropped)', () => {
  const feedKeys = new Set(canonical.byFormat.feed.slots.map(s => s.key));
  const sqKeys = new Set(canonical.byFormat.square.slots.map(s => s.key));
  const missing = [...feedKeys].filter(k => !sqKeys.has(k));
  assert.strictEqual(missing.length, 0, `square is missing feed slots: ${missing.join(', ')}`);
});

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verifyTitlingFormats: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyTitlingFormats: ${pass}/${pass} checks passed`);
