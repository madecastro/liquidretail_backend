#!/usr/bin/env node
/**
 * Offline geometry harness for the direct-image static pipeline.
 *
 * No DB, no network, no API key. Proves the invariants that a silent geometry
 * drift breaks — every one of which WAS broken when this was written, so it is
 * revert-provable by construction:
 *
 *   G1  delivery dims come from the surface the prompt was built from, so the
 *       size Sharp writes is the size the geometry block promised the model.
 *       (Was: a hand-written switch over aspectRatio holding `canvas` values,
 *       an HTML reference width, while the prompt promised `deliveryDims`.)
 *   G2  an aspect nobody enumerated must NOT fall through to square.
 *       (Was: `default: { width: 1000, height: 1000 }` — pmax 16:9 squashed.)
 *   G3  the crop performed is the CENTRED crop the prompt promised, and the
 *       extracted region already has the delivery aspect so the resize cannot
 *       crop or stretch. (Was: fit:'cover', position:'attention' — saliency.)
 *   G4  the composited logo lands inside the content rect, clear of the band
 *       the host platform covers with its own UI.
 *       (Was: a flat top = height - 100, 150px inside Stories' 250px reserve.)
 *
 * Run: node scripts/verifyStaticGeometry.js
 */
const pf = require('../services/platformFormats');
const intents = require('../services/staticAdIntents');
const direct = require('../services/directImageRenderService');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// Only LIVE surfaces that actually take a static image. meta_reels_9_16 is
// kinds:['video']; coming_soon Google Demand Gen sizes are UI-only until live.
const SURFACES = pf.PLATFORM_FORMAT_KEYS.filter(
  (k) => pf.PLATFORM_FORMATS[k] &&
    pf.PLATFORM_FORMATS[k].status === 'live' &&
    (pf.kindsForPlatformFormat(k) || []).includes('image')
);

if (!SURFACES.length) {
  console.error('❌ static geometry: no image-bearing surfaces found — the harness is checking nothing');
  process.exit(1);
}

for (const key of SURFACES) {
  const f = pf.PLATFORM_FORMATS[key];
  const s = intents.computeSurface(key);
  const [genW, genH] = String(s.generate).split(/[x*]/).map(Number);

  // ── G1 ────────────────────────────────────────────────────────────────
  const dims = direct.deliveryGeometryFor(s);
  check(`G1 ${key} delivers at the size the prompt promised`,
    dims.width === f.deliveryDims.width && dims.height === f.deliveryDims.height,
    `expected ${f.deliveryDims.width}x${f.deliveryDims.height}, got ${dims.width}x${dims.height}`);
  check(`G1 ${key} the promised size is what geometryBlock states`,
    String(s.deliver) === `${f.deliveryDims.width}x${f.deliveryDims.height}`,
    `surface.deliver=${s.deliver} vs deliveryDims ${f.deliveryDims.width}x${f.deliveryDims.height}`);

  // ── G3 ────────────────────────────────────────────────────────────────
  // The model returns the size we asked for: the extract must be the centred
  // box, matching the per-edge crop geometryBlock spoke to the model.
  const box = direct.extractFor(s, genW, genH);
  const c = s.cropPx || {};
  check(`G3 ${key} extract is the centred box the prompt described`,
    box.left === (c.left || 0) && box.top === (c.top || 0),
    `extract left/top ${box.left}/${box.top} vs promised ${c.left || 0}/${c.top || 0}`);
  check(`G3 ${key} extract consumes exactly the promised crop`,
    box.width === genW - (c.left || 0) - (c.right || 0) &&
    box.height === genH - (c.top || 0) - (c.bottom || 0),
    `extract ${box.width}x${box.height} of ${genW}x${genH} vs crop ${JSON.stringify(c)}`);

  const [aw, ah] = String(s.aspect).split(':').map(Number);
  check(`G3 ${key} extracted frame already has the delivery aspect`,
    Math.abs(box.width / box.height - aw / ah) < 0.005,
    `extract ${(box.width / box.height).toFixed(4)} vs target ${(aw / ah).toFixed(4)}`);
  // Which is what makes the subsequent fit:'fill' a pure scale.
  check(`G3 ${key} resize to delivery is a uniform scale, not a stretch`,
    Math.abs(dims.width / box.width - dims.height / box.height) < 0.005,
    `sx ${(dims.width / box.width).toFixed(4)} vs sy ${(dims.height / box.height).toFixed(4)}`);

  // An off-size frame must still be cropped to the right aspect, never stretched.
  const odd = direct.extractFor(s, Math.round(genW * 0.93), Math.round(genH * 1.04));
  check(`G3 ${key} an off-size model response still crops to the delivery aspect`,
    Math.abs(odd.width / odd.height - aw / ah) < 0.01,
    `off-size extract ${odd.width}x${odd.height} = ${(odd.width / odd.height).toFixed(4)}`);

  // ── G4 ────────────────────────────────────────────────────────────────
  // Two independent assertions, and both matter. The logo must sit inside the
  // SAFE BOX the prompt described (or the model reserved the wrong space), and
  // it must clear the platform's declared UI band (or nobody ever sees it).
  const safe = pf.safeAreaForPlatformFormat(key) || {};
  const sb = direct.safeBoxInDeliveredPx(s, dims);
  const production = Math.round(0.16 * Math.min(dims.width, dims.height));
  // Sweep sizes, not just the production one. The first version of this fix
  // clamped the RESULT into the frame, which could shove the mark back across
  // the safe-box edge it was meant to honour — invisible to a single-size test.
  const sizes = [
    [production, Math.round(production * 0.35)],  // what the renderer asks for
    [40, 14],                                     // a tiny mark, unenlarged
    [Math.round(dims.width * 0.9), 60],           // absurdly wide
    [120, Math.round(dims.height * 0.95)],        // absurdly tall
    [dims.width + 200, 60]                        // wider than the frame
  ];
  for (const [lw, lh] of sizes) {
    const place = direct.logoPlacementFor({ surface: s, dims, logoW: lw, logoH: lh });
    if (!place) continue;   // refusing to place is always a legitimate answer
    check(`G4 ${key} logo ${lw}x${lh} stays inside the safe box the prompt reserved`,
      place.top >= Math.max(0, sb.top) && place.top + place.height <= Math.min(dims.height, sb.bottom) &&
      place.left >= Math.max(0, sb.left) && place.left + place.width <= Math.min(dims.width, sb.right),
      `logo x${place.left}-${place.left + place.width} y${place.top}-${place.top + place.height} ` +
      `vs safe box x${sb.left}-${sb.right} y${sb.top}-${sb.bottom}`);
    check(`G4 ${key} logo ${lw}x${lh} is inside the delivered frame`,
      place.left >= 0 && place.top >= 0 &&
      place.left + place.width <= dims.width && place.top + place.height <= dims.height,
      `logo x${place.left}-${place.left + place.width} y${place.top}-${place.top + place.height} in ${dims.width}x${dims.height}`);
  }
  // The production-size mark must actually place, and must clear the platform band.
  const place = direct.logoPlacementFor({ surface: s, dims, logoW: production, logoH: Math.round(production * 0.35) });
  check(`G4 ${key} the production-size logo fits inside the safe box`, !!place);
  if (place) {
    const contentBottom = dims.height - (safe.bottom || 0);
    check(`G4 ${key} logo clears the declared platform band`,
      place.top + place.height <= contentBottom,
      `logo ends at y=${place.top + place.height}, platform covers y>=${contentBottom}`);
  }
}

// ── G4b: the placement CONTRACT, not just the live table ────────────────
// None of the four live surfaces has a safe box that extends past the delivered
// frame, so the loop above cannot exercise the case where the two constraints
// disagree — and that is exactly where the first version of this fix was wrong:
// it placed inside the box, then clamped into the frame, which could shove the
// mark back across the box edge. Synthesise the disagreement.
{
  const synth = {
    key: 'synthetic_box_overhangs_frame',
    aspect: '1:1', generate: '1024x1024', deliver: '1080x1080',
    cropPx: { left: 0, right: 0, top: 0, bottom: 0 },
    // right/bottom deliberately past 100%: a box wider than the frame it lives in.
    box: { left: 5, right: 105, top: 5, bottom: 105 }
  };
  const dims = { width: 1080, height: 1080 };
  const sb = direct.safeBoxInDeliveredPx(synth, dims);
  check('G4b synthetic box really does overhang the frame (guard is meaningful)',
    sb.right > dims.width && sb.bottom > dims.height,
    `box x${sb.left}-${sb.right} y${sb.top}-${sb.bottom} in ${dims.width}x${dims.height}`);
  for (const [lw, lh] of [[1053, 60], [60, 1053], [900, 900], [173, 61]]) {
    const p = direct.logoPlacementFor({ surface: synth, dims, logoW: lw, logoH: lh });
    if (!p) continue;
    check(`G4b synthetic ${lw}x${lh} honours BOTH the frame and the safe box`,
      p.left >= Math.max(0, sb.left) && p.top >= Math.max(0, sb.top) &&
      p.left + p.width <= Math.min(dims.width, sb.right) &&
      p.top + p.height <= Math.min(dims.height, sb.bottom),
      `placed x${p.left}-${p.left + p.width} y${p.top}-${p.top + p.height}, ` +
      `frame ${dims.width}x${dims.height}, box x${sb.left}-${sb.right} y${sb.top}-${sb.bottom}`);
  }
}

// ── G2: no silent square fallback ───────────────────────────────────────
// A surface whose geometry cannot be parsed must be refused, not delivered as
// a square. This is the whole pmax regression, in one assertion.
for (const bad of [
  { key: 'nonsense', aspect: undefined, deliver: undefined, generate: undefined },
  { key: 'half-built', aspect: '16:9', deliver: '', generate: '1536x1024' }
]) {
  let threw = false;
  try { direct.deliveryGeometryFor(bad); } catch { threw = true; }
  check(`G2 unusable surface "${bad.key}" is refused, not squared`, threw);
}

// A deliveryDims that drifted from its own aspect must be caught rather than
// silently stretching every ad on that surface.
let stretchRefused = false;
try {
  direct.deliveryGeometryFor({
    key: 'drifted', aspect: '9:16', generate: '1024x1536',
    cropPx: { left: 80, right: 80, top: 0, bottom: 0 }, deliver: '1080x1600'
  });
} catch { stretchRefused = true; }
check('G2 a deliveryDims that does not match its aspect is refused', stretchRefused);

if (failures.length) {
  console.error(`\n❌ static geometry: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ static geometry: ${pass} checks passed across ${SURFACES.length} image surfaces (${SURFACES.join(', ')})`);
