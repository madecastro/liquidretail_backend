#!/usr/bin/env node
/**
 * verifyLogoSafeBox.js — the composited static logomark must sit STRICTLY
 * inside the same safe box vision QC is handed, on every live image surface.
 *
 * Offline: no DB, no network, no API key. Drives the real geometry functions
 * (computeSurface, safeBoxInDeliveredPx, logoPlacementFor, logoResizeBox).
 *
 * THE DEFECT
 * ----------
 * Measured 2026-08-24 across 63 real static ads / 7 runs / 2 brands: 14 of
 * 21 vision-QC failures were layout_safe_box, and the verbatim verdicts
 * named the brand logo ("outside the required safe area", "at the bottom
 * breaches the safe area", "bottom-right corner is outside"). 19 of those
 * 21 were regenerated first — paid twice, shipped nothing.
 *
 * The logo IS Sharp-composited by us (directImageRenderService.finishPlate
 * → logoPlacementFor), not placed by the image model. Placement aligned
 * the mark's right/bottom TO the clamped box (`left = right - logoW`), so
 * the QC-declared box (the same safeBoxInDeliveredPx numbers the inspector
 * prompt prints) had 0px remaining on those edges on EVERY live surface.
 * Vision treats on-the-line as a breach. The existing frame-gap pin
 * (verifyStaticSafeBox S3) stayed green because the box is already inset
 * from the frame.
 *
 * The square logoResizeBox (#321) did NOT create a negative margin the
 * previous 0.35-tall box lacked — both were flush. It DID make stacked
 * lockups ~2.8× taller, so more ink sat on the line. Amplifier, not root
 * cause. This harness pins the flush placement, not the square box.
 *
 * MUTATIONS THAT MUST FAIL THIS FILE
 * ----------------------------------
 *   1. Drop the inset in logoPlacementFor (restore `left = right - logoW`
 *      against the un-inset edge)                         → L2, L3, L6
 *   2. Set LOGO_INSET_FRAC = 0 AND LOGO_INSET_PX_FLOOR = 0 → L1, L2
 *   3. Restore Math.max(crop, margin) in computeSurface    → C1, C2
 *   4. Place the logo in the centre of the box (margins
 *      stay positive, but it is no longer the reserved
 *      corner)                                             → L5
 *   5. Stop handing safeBoxInDeliveredPx to vision QC      → Q1
 *   6. finishPlate stops calling logoPlacementFor, OR
 *      keeps the call but pastes at the frame edge         → Q2
 *
 * Run: node scripts/verifyLogoSafeBox.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const pf = require('../services/platformFormats');
const intents = require('../services/staticAdIntents');
const direct = require('../services/directImageRenderService');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function liveImageSurfaces() {
  return pf.PLATFORM_FORMAT_KEYS.filter((k) => {
    const f = pf.PLATFORM_FORMATS[k];
    return f && f.status === 'live' && Array.isArray(f.kinds) && f.kinds.includes('image');
  });
}

/** Pre-2026-08-24 placement: floor-bound, flush to the box edge. */
function preInsetLogoPlacementFor({ surface, dims, logoW, logoH }) {
  const box = direct.safeBoxInDeliveredPx(surface, dims);
  let left = Math.max(0, box.left);
  let right = Math.min(dims.width, box.right);
  let top = Math.max(0, box.top);
  let bottom = Math.min(dims.height, box.bottom);
  const floor = direct.LOGO_SAFE_MARGIN_PCT[surface?.key];
  if (floor && dims?.width > 0 && dims?.height > 0) {
    left = Math.max(left, Math.round(floor.left * dims.width));
    right = Math.min(right, dims.width - Math.round(floor.right * dims.width));
    top = Math.max(top, Math.round(floor.top * dims.height));
    bottom = Math.min(bottom, dims.height - Math.round(floor.bottom * dims.height));
  }
  if (!(logoW > 0 && logoH > 0)) return null;
  if (right - left < logoW || bottom - top < logoH) return null;
  return { top: bottom - logoH, left: right - logoW, width: logoW, height: logoH };
}

/**
 * Independent recompute of the shipped placement. Restates logoPlacementFor
 * from first principles so a harness that only asked the implementation
 * "are your margins positive?" cannot bless a centre-placed mark.
 */
function expectedPlacement({ surface, dims, logoW, logoH }) {
  const box = direct.safeBoxInDeliveredPx(surface, dims);
  let left = Math.max(0, box.left);
  let right = Math.min(dims.width, box.right);
  let top = Math.max(0, box.top);
  let bottom = Math.min(dims.height, box.bottom);
  const floor = direct.LOGO_SAFE_MARGIN_PCT[surface?.key];
  if (floor && dims?.width > 0 && dims?.height > 0) {
    left = Math.max(left, Math.round(floor.left * dims.width));
    right = Math.min(right, dims.width - Math.round(floor.right * dims.width));
    top = Math.max(top, Math.round(floor.top * dims.height));
    bottom = Math.min(bottom, dims.height - Math.round(floor.bottom * dims.height));
  }
  const inset = Math.max(
    direct.LOGO_INSET_PX_FLOOR,
    Math.round(direct.LOGO_INSET_FRAC * Math.min(dims.width, dims.height))
  );
  left += inset;
  right -= inset;
  top += inset;
  bottom -= inset;
  if (!(logoW > 0 && logoH > 0)) return null;
  if (right - left < logoW || bottom - top < logoH) return null;
  return { top: bottom - logoH, left: right - logoW, width: logoW, height: logoH, inset };
}

function marginsVs(rect, box) {
  return {
    left: rect.left - box.left,
    top: rect.top - box.top,
    right: box.right - (rect.left + rect.width),
    bottom: box.bottom - (rect.top + rect.height)
  };
}

const SURFACES = liveImageSurfaces();
check('L0 at least the six live static surfaces exist', SURFACES.length >= 6,
  `got ${SURFACES.join(',')}`);

check('L1 LOGO_INSET_FRAC is a real positive fraction (not zero, not a no-op)',
  typeof direct.LOGO_INSET_FRAC === 'number' && direct.LOGO_INSET_FRAC >= 0.01,
  `LOGO_INSET_FRAC=${direct.LOGO_INSET_FRAC}`);
check('L1b LOGO_INSET_PX_FLOOR is a real positive pixel gap',
  typeof direct.LOGO_INSET_PX_FLOOR === 'number' && direct.LOGO_INSET_PX_FLOOR >= 1,
  `LOGO_INSET_PX_FLOOR=${direct.LOGO_INSET_PX_FLOOR}`);
check('L1c logoInsetPx is exported and matches the constants',
  typeof direct.logoInsetPx === 'function'
    && direct.logoInsetPx({ width: 1080, height: 1080 })
      === Math.max(direct.LOGO_INSET_PX_FLOOR, Math.round(direct.LOGO_INSET_FRAC * 1080)));

console.log('verifyLogoSafeBox\n');
console.log(
  'surface'.padEnd(24)
  + 'qcBox'.padEnd(28)
  + 'logoRect'.padEnd(28)
  + 'margin L/T/R/B vs QC'
);
console.log('-'.repeat(110));

for (const key of SURFACES) {
  const s = intents.computeSurface(key);
  const dims = direct.deliveryGeometryFor(s);
  const qc = direct.safeBoxInDeliveredPx(s, dims);
  const box = direct.logoResizeBox(dims);
  const place = direct.logoPlacementFor({
    surface: s, dims, logoW: box.width, logoH: box.height
  });
  const oldH = Math.round(box.width * 0.35);
  const pre = preInsetLogoPlacementFor({
    surface: s, dims, logoW: box.width, logoH: box.height
  });
  const want = expectedPlacement({
    surface: s, dims, logoW: box.width, logoH: box.height
  });

  check(`L2 ${key} production-size (square) logo places at all`, !!place,
    'logoPlacementFor returned null — the ad would ship with no logo');
  if (!place) continue;

  const m = marginsVs(place, qc);
  const inset = direct.logoInsetPx(dims);
  console.log(
    key.padEnd(24)
    + `x${qc.left}-${qc.right} y${qc.top}-${qc.bottom}`.padEnd(28)
    + `x${place.left}-${place.left + place.width} y${place.top}-${place.top + place.height}`.padEnd(28)
    + `${m.left}/${m.top}/${m.right}/${m.bottom}`
  );

  check(`L2 ${key} logo is strictly inside the QC/prompt box (all margins > 0)`,
    m.left > 0 && m.top > 0 && m.right > 0 && m.bottom > 0,
    `margins ${JSON.stringify(m)} vs qc ${JSON.stringify(qc)} logo ${JSON.stringify(place)}`);

  check(`L2 ${key} right AND bottom margins vs QC are at least the inset (${inset}px)`,
    m.right >= inset && m.bottom >= inset,
    `right=${m.right} bottom=${m.bottom} inset=${inset} — flush-to-box is the defect`);

  check(`L3 ${key} [revert-prove] the pre-inset placement WAS flush (min(right,bottom) margin === 0)`,
    !!pre && Math.min(
      qc.right - (pre.left + pre.width),
      qc.bottom - (pre.top + pre.height)
    ) === 0,
    pre
      ? `pre-inset margins vs QC r=${qc.right - (pre.left + pre.width)} b=${qc.bottom - (pre.top + pre.height)} — fixture no longer exercises the flush bug`
      : 'pre-inset placement returned null');

  check(`L4 ${key} square production-size still fits after the inset (lockup legibility kept)`,
    box.width === box.height && box.width === Math.round(direct.LOGO_BOX_FRAC * Math.min(dims.width, dims.height)),
    `box=${JSON.stringify(box)}`);

  check(`L5 ${key} shipped placement matches the independent bottom-right-of-inset-box recompute`,
    !!want
      && place.left === want.left && place.top === want.top
      && place.width === want.width && place.height === want.height,
    `shipped ${JSON.stringify(place)} expected ${JSON.stringify(want)}`);

  // The 0.35-tall mark must also sit strictly inside — the flush bug was
  // not square-box-specific. If only the square size is inset, this fails.
  const placeWide = direct.logoPlacementFor({
    surface: s, dims, logoW: box.width, logoH: oldH
  });
  check(`L2 ${key} 0.35-tall mark also has strictly positive QC margins`,
    !!placeWide && (() => {
      const mw = marginsVs(placeWide, qc);
      return mw.left > 0 && mw.top > 0 && mw.right > 0 && mw.bottom > 0;
    })(),
    placeWide
      ? `0.35-tall margins ${JSON.stringify(marginsVs(placeWide, qc))}`
      : '0.35-tall placement returned null');
}

// ── L6: reconstructing flush placement on a single named surface must
// disagree with the shipped function. Belt-and-braces for L3 (which could
// theoretically pass if BOTH were flush the same way).
{
  const key = 'meta_feed_1_1';
  const s = intents.computeSurface(key);
  const dims = direct.deliveryGeometryFor(s);
  const box = direct.logoResizeBox(dims);
  const shipped = direct.logoPlacementFor({
    surface: s, dims, logoW: box.width, logoH: box.height
  });
  const flush = preInsetLogoPlacementFor({
    surface: s, dims, logoW: box.width, logoH: box.height
  });
  check('L6 shipped placement is NOT the flush pre-inset placement',
    !!shipped && !!flush && (shipped.left !== flush.left || shipped.top !== flush.top),
    `shipped ${JSON.stringify(shipped)} flush ${JSON.stringify(flush)}`);
}

// ── C. Crop-band vs edge-margin collapse (the 2026-08-03 Defect A).
// Live surfaces are now zero-crop (or crop-smaller-than-margin on
// pmax_landscape), so the Math.max(crop, margin) bug is invisible on the
// production table. Synthesise the case that made the logomark ship flush
// to the FRAME — crop exceeding the margin on a side-cropped surface.
{
  const SYNTH = 'synthetic_1_3_side_crop_logo';
  const added = !pf.PLATFORM_FORMATS[SYNTH];
  if (added) {
    pf.PLATFORM_FORMATS[SYNTH] = {
      platform: 'synthetic',
      status: 'synthetic',
      aspectRatio: '1:3',
      label: 'Synthetic 1:3 (logo harness only)',
      kinds: [],
      canvas: { width: 1000, height: 3000 },
      deliveryDims: { width: 640, height: 1920 },
      safeArea: { top: 0, bottom: 0 }
    };
  }
  try {
    const s = intents.computeSurface(SYNTH);
    const gen = String(s.generate).split('x').map(Number);
    const keptW = gen[0] - s.cropPx.left - s.cropPx.right;
    const margin = (intents.EDGE_MARGIN_PCT / 100) * Math.min(keptW, gen[1] - s.cropPx.top - s.cropPx.bottom);

    check('C1 synthetic 1:3 really does crop the sides (fixture is meaningful)',
      s.cropPx.left > 0,
      `cropPx=${JSON.stringify(s.cropPx)} generate=${s.generate}`);
    check('C1b synthetic side crop EXCEEDS the margin (the Math.max-discards condition)',
      s.cropPx.left > margin,
      `cropLeft=${s.cropPx.left} margin=${margin.toFixed(2)}`);

    const expectedLeftPct = ((s.cropPx.left + margin) / gen[0]) * 100;
    check('C2 box.left === (sideCrop + margin) additively — not Math.max(crop, margin)',
      Math.abs(s.box.left - expectedLeftPct) <= 0.1,
      `box.left=${s.box.left}% expected=${expectedLeftPct.toFixed(4)}% `
      + `(Math.max would give ${((s.cropPx.left / gen[0]) * 100).toFixed(4)}%)`);

    // Frame-gap on this cropped surface. After the inset, restoring
    // Math.max(crop, margin) still leaves this green (the logo is inset
    // from whatever box computeSurface emitted). C2 is the Math.max pin;
    // this one is the "logo not flush to the frame" pin.
    const dims = { width: 640, height: 1920 };
    const logoW = Math.round(direct.LOGO_BOX_FRAC * Math.min(dims.width, dims.height));
    const place = direct.logoPlacementFor({
      surface: s, dims, logoW, logoH: logoW
    });
    check('C3 synthetic cropped surface still places a production-size logo', !!place);
    if (place) {
      check('C3b synthetic logo is not flush to the delivered frame (Defect A cannot silently return)',
        place.left > 0
          && place.top > 0
          && place.left + place.width < dims.width
          && place.top + place.height < dims.height,
        `logo x${place.left}-${place.left + place.width} y${place.top}-${place.top + place.height} `
        + `in ${dims.width}x${dims.height}`);
    }
  } finally {
    if (added) delete pf.PLATFORM_FORMATS[SYNTH];
  }
}

// ── Q. The inspector and the compositor share one box, one placement.
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'directImageRenderService.js'),
    'utf8'
  );
  // Pin the CALL, not a comment that mentions the function (indexOf('runPostRenderQc')
  // hits "already awaits runPostRenderQc below" ~75 lines earlier).
  const qcCallIdx = src.indexOf('await adVisionQc.runPostRenderQc');
  const qcAssignIdx = qcCallIdx >= 0
    ? src.lastIndexOf('const safeBox = safeBoxInDeliveredPx', qcCallIdx)
    : -1;
  const qcCallSlice = qcCallIdx >= 0 ? src.slice(qcCallIdx, qcCallIdx + 600) : '';
  check('Q1 vision QC is handed safeBoxInDeliveredPx (the box this harness checks against)',
    qcAssignIdx >= 0
      && qcCallIdx - qcAssignIdx < 400
      && /safeBoxInDeliveredPx\(built\.surface,\s*dims\)/.test(src.slice(qcAssignIdx, qcCallIdx))
      && /^\s*safeBox,/m.test(qcCallSlice),
    'QC must inspect the same delivered-px box the compositor places into');

  const fpIdx = src.indexOf('async function finishPlate');
  // Whole function, not a char window: a 4500-char slice saw logoPlacementFor
  // (~+2970) and missed the paste (~+6220). Keeping the call while pasting
  // at the frame edge would then stay green — the same truncated-slice
  // hole this repo has already shipped on.
  const fpEnd = src.indexOf('\nasync function ', fpIdx + 1);
  const fpSlice = fpIdx >= 0
    ? src.slice(fpIdx, fpEnd > fpIdx ? fpEnd : fpIdx + 20000)
    : '';
  check('Q2 finishPlate places via logoPlacementFor (the function this harness drives)',
    /logoPlacementFor\s*\(\s*\{/.test(fpSlice)
    && /logoResizeBox\s*\(\s*dims\s*\)/.test(fpSlice),
    'a second placement path would make this harness vacuous');
  check('Q2b finishPlate pastes at place.top/place.left (not a frame-edge fallback)',
    /layers\.push\(\s*\{\s*input:\s*toPlace,\s*top:\s*place\.top,\s*left:\s*place\.left\s*\}\)/.test(fpSlice),
    'keeping logoPlacementFor but pasting at dims.height-lm.height would overflow the QC box while L2/L5 stayed green');
}

if (failures.length) {
  console.error(`\n❌ logo safe box: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`\n✅ logo safe box: ${pass} checks passed across ${SURFACES.length} image surfaces (${SURFACES.join(', ')})`);
