'use strict';

/**
 * Offline harness: static-ad safe-box + generation-size pins.
 *
 * Why this file exists (and why verifyStaticGeometry.js is not enough):
 * That harness passes 49/49 TODAY with both production defects still live.
 * Its G4 checks pre-clamp the delivered safe box:
 *   Math.max(0, sb.top) / Math.min(dims.height, sb.bottom)
 * which launders away a zero or negative inset — exactly the condition that is
 * broken on 4:5 (vertical) and Stories (horizontal). A harness that cannot
 * fail on the bug it claims to guard is not a harness (CLAUDE.md §5).
 *
 * This file asserts on RAW values only. No DB, no network, no API key, no
 * new deps. Run:
 *   node scripts/verifyStaticSafeBox.js
 *
 * Pins Defect A (additive margin + inward % rounding) and Defect B (exact-aspect
 * generation sizes: 1152x2048 for 9:16 from the schema enum, 1088x1360 for 4:5
 * proven by a live probe). Every live static surface is now zero-crop; S4 is what
 * stops an UNPROVEN size being added to reach that state for some future aspect.
 */

const pf = require('../services/platformFormats');
const intents = require('../services/staticAdIntents');
const render = require('../services/directImageRenderService');

// ── live size enum for the gpt-image-2 edit family ──────────────────────
// Fetched 2026-08-03 from
//   https://static.atlascloud.ai/model/schema/openai-gpt-image-2-edit.json
// The schema `size` enum is the operative contract (CLAUDE.md §2); the model
// README still lists only three legacy sizes and is the stale artefact.
//
// COVERS BOTH VARIANTS. `PLATE_EDIT_MODEL` briefly pointed at
// `openai/gpt-image-2-developer/edit` on 2026-08-03 and was reverted the same day
// on reliability (17.1% hard failures vs 0%); it is `openai/gpt-image-2/edit`
// today. The two schemas were diffed field-for-field and the `size` enum is
// IDENTICAL, as is every other request property, so this file's geometry holds
// either way and no re-diff is owed for a move between those two.
// If the model is ever pointed at a DIFFERENT family, re-diff the enum first —
// a size outside it risks silent coercion to the 1024x1024 default, which would
// square a 4:5 surface and then crop it.
// A non-enum size risks a 400 from the gateway, or — worse — silent coercion
// to the 1024x1024 default, which would hand a square frame to a non-square
// surface and then centre-crop it after the billable call.
const GPT_IMAGE_2_EDIT_SIZE_ENUM = [
  '1024x1024',
  '1024x768',
  '768x1024',
  '1024x1536',
  '1536x1024',
  '2048x2048',
  '2048x1152',
  '1152x2048',
  '2560x1088',
  '1088x2560',
  '2880x2160',
  '2160x2880',
  '3840x2160',
  '2160x3840'
];
const ENUM_SET = new Set(GPT_IMAGE_2_EDIT_SIZE_ENUM);

// Non-enum sizes that have been PROVED live against this gateway, each with the
// evidence attached. The schema documents arbitrary div-16 sizes for gpt-image-2,
// but that text is spliced from OpenAI's docs and carries an unpublished pixel /
// edge-limit caveat — so prose is not sufficient warrant to send one. A billable
// probe is. Adding a row here without a prediction id defeats the entire point of
// S4; if you cannot cite the probe, the size does not belong in GEN_SIZES.
const PROVEN_NON_ENUM_SIZES = {
  // 2026-08-03, one submit: asked 1088x1360, returned exactly 1088x1360,
  // aspect 0.800000. Closes the 4:5 post-generation crop.
  '1088x1360': { predictionId: '65d1931505bc4620bcf0d7efcdd7aff9', probedOn: '2026-08-03' }
};
const SENDABLE = new Set([...GPT_IMAGE_2_EDIT_SIZE_ENUM, ...Object.keys(PROVEN_NON_ENUM_SIZES)]);

// Post-fix GEN_SIZES order is load-bearing: chooseGenSize uses strict `<`
// so equal-loss ties keep the earlier table entry. Do not reorder casually.
// Phase A added 2048x1152 (enum exact 16:9) so landscape/pmax surfaces go
// zero-crop instead of 1536x1024 (3:2, 15.6% T/B). Placed after the 9:16 twin
// and before the probed 4:5 so equal-loss ties cannot flip Meta winners.
const EXPECTED_GEN_SIZE_TABLE = [
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1152x2048',
  '2048x1152',
  '1088x1360'
];

// 4:5 was the deliberate remainder while the table was enum-only: it generated
// 1024x1536 and centre-cropped 128px top and bottom for a 16.7% loss, because no
// enum entry is exactly 0.8. The probe named in staticAdIntents' GEN_SIZES
// comment settled it — 1088x1360 is honoured exactly — so 4:5 is now zero-crop
// like every other live static surface. These constants pin the CLOSED state; if
// anyone reverts to an enum-only table these go red and the failure message says
// why the crop came back.
const FEED_4_5_CROP_TOP_BOTTOM = 0;
const FEED_4_5_LOSS_PCT = 0;
const FEED_4_5_GENERATE = '1088x1360';

// Default edge-margin convention (percent of kept short side). Restated here
// as the expected DEFAULT so a silent change to EDGE_MARGIN_PCT fails S2d;
// S2b's per-surface recompute imports SURFACE_EDGE_MARGIN_PCT and falls back
// to EDGE_MARGIN_PCT so it tracks the same map the code uses without copying
// the emitted box.
const EXPECTED_EDGE_MARGIN_PCT = 6;
// Phase A PMax statics only — every other surface must stay at 6%.
const EXPECTED_PMAX_EDGE_MARGIN_PCT = 10;
const PMAX_STATIC_SURFACE_KEYS = [
  'pmax_landscape_1_91_1',
  'pmax_square_1_1',
  'pmax_portrait_4_5'
];

// Production logo geometry — mirrors directImageRenderService compositing.
// Box is square (hOfW = 1): wide wordmarks still bind on width via fit:inside.
const LOGO_W_FRAC = render.LOGO_BOX_FRAC;
const LOGO_H_OF_W = 1;
// Extra sizes the previous geometry harness swept; keep the same spirit so a
// single production-size pass cannot hide a flush-edge placement that only
// appears at a different mark size.
const LOGO_SWEEP = [
  { wFrac: 0.10, hOfW: 0.35 },
  { wFrac: LOGO_W_FRAC, hOfW: LOGO_H_OF_W }, // production (square)
  { wFrac: 0.20, hOfW: 0.40 },
  { wFrac: 0.12, hOfW: 0.50 }
];

const failures = [];
let passed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    return;
  }
  failures.push({ name, detail: detail || '' });
}

function parseWxH(s) {
  const m = String(s).match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** Live surfaces that carry an image kind (static fan-out candidates). */
function liveImageSurfaces() {
  return pf.PLATFORM_FORMAT_KEYS.filter((k) => {
    const f = pf.PLATFORM_FORMATS[k];
    return f && f.status === 'live' && Array.isArray(f.kinds) && f.kinds.includes('image');
  });
}

function deliveryDimsOf(key) {
  return pf.PLATFORM_FORMATS[key].deliveryDims;
}

/**
 * Resolve the generation-size table for S4.
 * Prefer an exported GEN_SIZES (tightest pin: catches unused table entries).
 * Fall back to unique `generate` strings across describeSurfaces() plus the
 * known post-fix four — still catches every size that can reach the API.
 */
function generationSizeTable() {
  if (Array.isArray(intents.GEN_SIZES) && intents.GEN_SIZES.length) {
    return intents.GEN_SIZES.map((s) => {
      if (typeof s === 'string') return s;
      return `${s.w}x${s.h}`;
    });
  }
  const fromSurfaces = new Set(
    intents.describeSurfaces().map((row) => row.generate)
  );
  for (const s of EXPECTED_GEN_SIZE_TABLE) fromSurfaces.add(s);
  return [...fromSurfaces];
}

// Both wrappers mirror the REAL exported signatures, which are
// `safeBoxInDeliveredPx(surface, dims)` and
// `logoPlacementFor({ surface, dims, logoW, logoH })`. Keep them in sync with
// directImageRenderService: a wrapper that guesses the shape throws
// `Cannot read properties of undefined` rather than failing a named check, and a
// harness that crashes tells you nothing about which invariant broke.
function safeBoxRaw(surface, dims) {
  // Must use the RAW helper — never clamp here. Clamping is the exact
  // laundering that made verifyStaticGeometry G4 pass with the defect live.
  if (typeof render.safeBoxInDeliveredPx !== 'function') {
    throw new Error(
      'directImageRenderService.safeBoxInDeliveredPx is not exported; ' +
      'S1 cannot pin the delivered inset without it'
    );
  }
  return render.safeBoxInDeliveredPx(surface, dims);
}

function logoPlace(surface, dims, logoW, logoH) {
  if (typeof render.logoPlacementFor !== 'function') {
    throw new Error(
      'directImageRenderService.logoPlacementFor is not exported; ' +
      'S3 cannot pin logo frame-edge gaps without it'
    );
  }
  return render.logoPlacementFor({ surface, dims, logoW, logoH });
}

// ── S1: raw delivered safe-box has strictly positive insets ─────────────
// Fails today on 4:5 (vertical: sb.top negative / sb.bottom past frame) and
// Stories (horizontal: sb.right === dims.width → 0 inset). Defect A fix
// (additive margin measured against the KEPT short side) is what turns these
// green.
{
  const keys = liveImageSurfaces();
  check(
    'S1 selector yields at least the three live Meta image surfaces',
    keys.includes('meta_feed_1_1') &&
      keys.includes('meta_feed_4_5') &&
      keys.includes('meta_stories_9_16'),
    `got: ${keys.join(',')}`
  );

  for (const key of keys) {
    const surface = intents.computeSurface(key);
    const dims = deliveryDimsOf(key);
    const sb = safeBoxRaw(surface, dims);

    const insetLeft = sb.left;
    const insetTop = sb.top;
    const insetRight = dims.width - sb.right;
    const insetBottom = dims.height - sb.bottom;

    check(
      `S1 ${key} raw safe-box left inset > 0`,
      insetLeft > 0,
      `sb.left=${sb.left} (raw, unclamped)`
    );
    check(
      `S1 ${key} raw safe-box top inset > 0`,
      insetTop > 0,
      `sb.top=${sb.top} (raw, unclamped)`
    );
    check(
      `S1 ${key} raw safe-box right inset > 0`,
      insetRight > 0,
      `sb.right=${sb.right} dims.w=${dims.width} inset=${insetRight}`
    );
    check(
      `S1 ${key} raw safe-box bottom inset > 0`,
      insetBottom > 0,
      `sb.bottom=${sb.bottom} dims.h=${dims.height} inset=${insetBottom}`
    );
    // Also refuse a degenerate inverted box (left>=right / top>=bottom).
    check(
      `S1 ${key} raw safe-box is non-inverted`,
      sb.left < sb.right && sb.top < sb.bottom,
      `sb=${JSON.stringify(sb)}`
    );
  }
}

// ── S2: emitted % box never enters the destroyed crop band after rounding ─
// Coupled toFixed(1) defect: right=100-left rounds the pair the SAME way, so
// on crop boundaries the edges rounded OUTWARD into the cut (4:5 by 0.512px,
// Stories by 0.128px). Fix is ceil left/top, floor right/bottom — always
// inward. Convert emitted percentages back to generated pixels and compare
// against the crop lines with no tolerance that would re-admit the bug.
{
  for (const key of pf.PLATFORM_FORMAT_KEYS) {
    const s = intents.computeSurface(key);
    const gen = parseWxH(s.generate);
    check(`S2 ${key} generate parses as WxH`, !!gen, `generate=${s.generate}`);
    if (!gen) continue;

    // Reconstruct the pixel positions the model is told, from the rounded %.
    // This is what the prompt string actually communicates — not the pre-round
    // floats — so this is the right surface to assert on.
    const leftPx = (s.box.left / 100) * gen.w;
    const rightPx = (s.box.right / 100) * gen.w;
    const topPx = (s.box.top / 100) * gen.h;
    const bottomPx = (s.box.bottom / 100) * gen.h;

    const cropL = s.cropPx.left;
    const cropR = s.cropPx.right;
    const cropT = s.cropPx.top;
    const cropB = s.cropPx.bottom;

    check(
      `S2 ${key} box.left% maps to px >= crop left (not inside destroyed band)`,
      leftPx >= cropL,
      `leftPx=${leftPx} cropL=${cropL} box.left=${s.box.left}% gen=${s.generate}`
    );
    check(
      `S2 ${key} box.right% maps to px <= genW-cropRight (not inside destroyed band)`,
      rightPx <= gen.w - cropR,
      `rightPx=${rightPx} limit=${gen.w - cropR} box.right=${s.box.right}%`
    );
    check(
      `S2 ${key} box.top% maps to px >= crop top (not inside destroyed band)`,
      topPx >= cropT,
      `topPx=${topPx} cropT=${cropT} box.top=${s.box.top}% gen=${s.generate}`
    );
    check(
      `S2 ${key} box.bottom% maps to px <= genH-cropBottom (not inside destroyed band)`,
      bottomPx <= gen.h - cropB,
      `bottomPx=${bottomPx} limit=${gen.h - cropB} box.bottom=${s.box.bottom}%`
    );
  }
}

// ── S2b: the box matches an INDEPENDENT recomputation, edge for edge ──────
//
// This is the tight pin, and it exists because the first version of this harness
// was NOT revert-proof. Backing Defect A out (restoring
// `x0 = Math.max(cropLeftPx, marginPx)`) left S1 and S3 GREEN. The reason is
// worth recording: the inward rounding *masks* the margin collapse. With the
// margin swallowed, box.top on 4:5 lands on the crop line, `ceil` then nudges it
// 1px inside, and a "inset > 0" assertion is satisfied by that 1px. Likewise
// backing out the inward rounding alone stayed green, because an additive margin
// leaves 61px of slack and a half-up round can no longer reach the cut.
//
// So neither fix can be pinned by a threshold test. Recompute the expected box
// from first principles instead — crop, then platform reserve, then a margin
// measured on the KEPT short side, additively — and require the emitted box to
// match within a tenth of a percent. That is tight enough that Math.max, a
// gen-frame margin basis, and half-up rounding each produce a mismatch.
//
// Deliberate duplication: this arithmetic restates computeSurface rather than
// calling it. An independent recomputation is the whole point — a harness that
// asks the implementation what it thinks the answer is pins nothing.
//
// Per-surface margin: use the SAME map the code uses (SURFACE_EDGE_MARGIN_PCT
// → EDGE_MARGIN_PCT fallback). That keeps the recompute independent of the
// *emitted box* while tracking Phase A's 10% PMax static override. S2d pins
// that the map itself is only those three keys at 10% and everything else is 6.
{
  const TOL_PCT = 0.1; // one emitted decimal place
  const surfaceMarginMap = intents.SURFACE_EDGE_MARGIN_PCT || {};
  const defaultMarginPct = typeof intents.EDGE_MARGIN_PCT === 'number'
    ? intents.EDGE_MARGIN_PCT
    : EXPECTED_EDGE_MARGIN_PCT;

  for (const key of pf.PLATFORM_FORMAT_KEYS) {
    const s = intents.computeSurface(key);
    const gen = parseWxH(s.generate);
    if (!gen) continue;

    const keptW = gen.w - s.cropPx.left - s.cropPx.right;
    const keptH = gen.h - s.cropPx.top - s.cropPx.bottom;
    const canvas = pf.canvasForPlatformFormat(key);
    const safe = pf.safeAreaForPlatformFormat(key) || {};
    const topReserve = ((safe.top || 0) / canvas.height) * keptH;
    const botReserve = ((safe.bottom || 0) / canvas.height) * keptH;

    // The margin basis is KEPT, not generated. On a surface cropped along its
    // short axis these differ (pmax 16:9 historically: kept short side 864 vs
    // generated 1024), which is the only place a gen-frame basis is observable
    // at all — so this loop must run over every declared key, not just the
    // live image ones. Per-surface % comes from the same map the code uses.
    const hasOverride = Object.prototype.hasOwnProperty.call(surfaceMarginMap, key);
    const marginPct = hasOverride ? surfaceMarginMap[key] : defaultMarginPct;

    // Two different rules, deliberately. Short-side (a uniform pixel border) for
    // every surface that inherits the default; PER-AXIS for the surfaces that
    // carry an explicit override, because Google states its safe area per
    // dimension — central 80% of width AND of height. On 1200x628 the short-side
    // rule yielded only 5.2% of the width, which is what put real ad copy in
    // Google's crop band. S2e pins the resulting boxes directly.
    const marginX = hasOverride
      ? (marginPct / 100) * keptW
      : (marginPct / 100) * Math.min(keptW, keptH);
    const marginY = hasOverride
      ? (marginPct / 100) * keptH
      : (marginPct / 100) * Math.min(keptW, keptH);
    const margin = Math.min(marginX, marginY); // for the degenerate-inversion report below

    const exact = {
      left:   s.cropPx.left + marginX,
      right:  s.cropPx.left + keptW - marginX,
      top:    s.cropPx.top + topReserve + marginY,
      bottom: s.cropPx.top + keptH - botReserve - marginY
    };

    // Skip the degenerate-fallback surfaces: when margin would invert the box
    // computeSurface deliberately drops it, so the closed form above no longer
    // describes the answer. Assert non-inversion for those instead.
    if (exact.left >= exact.right || exact.top >= exact.bottom) {
      check(
        `S2b ${key} degenerate box still emits a non-inverted range`,
        s.box.left < s.box.right && s.box.top < s.box.bottom,
        `box=${JSON.stringify(s.box)} (margin ${margin.toFixed(2)} would invert)`
      );
      continue;
    }

    for (const [edge, total, side] of [
      ['left', gen.w, 'lo'], ['right', gen.w, 'hi'],
      ['top', gen.h, 'lo'], ['bottom', gen.h, 'hi']
    ]) {
      const exactPct = (exact[edge] / total) * 100;
      const emitted = s.box[edge];
      check(
        `S2b ${key} box.${edge} matches independent recompute (additive margin on kept short side)`,
        Math.abs(emitted - exactPct) <= TOL_PCT,
        `emitted=${emitted}% expected=${exactPct.toFixed(4)}% ` +
        `(crop=${JSON.stringify(s.cropPx)} kept=${keptW}x${keptH} margin=${margin.toFixed(2)})`
      );
      // And the rounding must go INWARD off that exact value, never outward.
      // 1e-9 absorbs IEEE754 dust on exact tenths (e.g. 10% of 1088 = 108.8)
      // without admitting a real outward step (one emitted tenth ≈ total/1000).
      const emittedPx = (emitted / 100) * total;
      const EPS_PX = 1e-9;
      check(
        `S2b ${key} box.${edge} rounds inward, not outward`,
        side === 'lo' ? emittedPx + EPS_PX >= exact[edge] : emittedPx - EPS_PX <= exact[edge],
        `emittedPx=${emittedPx.toFixed(3)} exactPx=${exact[edge].toFixed(3)} side=${side}`
      );
      // Float-dust pin. When the exact percentage IS a whole tenth, inward
      // rounding must return it UNCHANGED — 69.12/1152 is exactly 6%, but in
      // IEEE754 it evaluates to 60.000000000000014 tenths, so a ceil without an
      // epsilon reports 6.1% and silently tightens the box by a tenth. That
      // drift is inward, so it can never truncate; it is pinned because it is a
      // real unintended change and it sits exactly on the tolerance above,
      // where the general match check cannot see it.
      const tenths = exactPct * 10;
      if (Math.abs(tenths - Math.round(tenths)) < 1e-6) {
        check(
          `S2b ${key} box.${edge} is exact at a whole tenth (float-dust guard intact)`,
          emitted === Math.round(tenths) / 10,
          `emitted=${emitted}% expected exactly ${(Math.round(tenths) / 10)}% — ` +
          `missing 1e-9 epsilon in the inward rounding?`
        );
      }
    }
  }
}

// ── S2d: per-surface margin map is scoped — 10% only on the three PMax statics ─
// A future accidental widening of SURFACE_EDGE_MARGIN_PCT to a Meta surface
// (or dropping a PMax static back to 6%) must fail here, not silently ship.
{
  const map = intents.SURFACE_EDGE_MARGIN_PCT || {};
  check(
    'S2d EDGE_MARGIN_PCT default is still 6',
    intents.EDGE_MARGIN_PCT === EXPECTED_EDGE_MARGIN_PCT,
    `EDGE_MARGIN_PCT=${intents.EDGE_MARGIN_PCT}`
  );
  for (const key of PMAX_STATIC_SURFACE_KEYS) {
    check(
      `S2d ${key} uses ${EXPECTED_PMAX_EDGE_MARGIN_PCT}% edge margin`,
      map[key] === EXPECTED_PMAX_EDGE_MARGIN_PCT,
      `SURFACE_EDGE_MARGIN_PCT[${key}]=${map[key]}`
    );
  }
  const mapKeys = Object.keys(map);
  check(
    'S2d SURFACE_EDGE_MARGIN_PCT keys are exactly the three Phase A PMax statics',
    mapKeys.length === PMAX_STATIC_SURFACE_KEYS.length &&
      PMAX_STATIC_SURFACE_KEYS.every((k) => mapKeys.includes(k)) &&
      mapKeys.every((k) => PMAX_STATIC_SURFACE_KEYS.includes(k)),
    `map keys=${mapKeys.join(',')}`
  );
  // Every OTHER declared platform format resolves to the 6% default (no map entry).
  for (const key of pf.PLATFORM_FORMAT_KEYS) {
    if (PMAX_STATIC_SURFACE_KEYS.includes(key)) continue;
    check(
      `S2d ${key} stays at default ${EXPECTED_EDGE_MARGIN_PCT}% (not in 10% map)`,
      !Object.prototype.hasOwnProperty.call(map, key),
      `SURFACE_EDGE_MARGIN_PCT unexpectedly has ${key}=${map[key]}`
    );
  }
}

// ── S2c: the HORIZONTAL half of Defect A, on a synthetic side-cropped surface ─
//
// Found by adversarial review of the fix, and it is a genuine hole: post-fix
// EVERY declared surface has cropPx.left === 0. 1:1, 4:5 and 9:16 are exact-aspect
// (zero crop) and the frozen 16:9 crops top/bottom only. Under cropLeft === 0 the
// broken and fixed X formulas are indistinguishable —
//   old: Math.max(0, marginPx) === marginPx
//   new: 0 + marginPx        === marginPx
// — so a PARTIAL revert that restores Math.max on the X axis alone stays green on
// every real surface, while reintroducing exactly the mechanism that shipped
// Stories with 0px left/right insets.
//
// So synthesise the case. A 1:3 target is the narrowest aspect the model accepts
// and it forces a side crop out of the real chooseGenSize (1152x2048 wins and
// loses width), which means this exercises the production code path rather than a
// re-implementation of it. The key is registered on PLATFORM_FORMATS only for the
// length of this block and removed in a finally, so no later assertion sees it.
{
  const SYNTH = 'synthetic_1_3_side_crop';
  const added = !pf.PLATFORM_FORMATS[SYNTH];
  if (added) {
    pf.PLATFORM_FORMATS[SYNTH] = {
      platform: 'synthetic',
      status: 'synthetic',
      aspectRatio: '1:3',
      label: 'Synthetic 1:3 (harness only)',
      kinds: [],
      canvas: { width: 1000, height: 3000 },
      deliveryDims: { width: 640, height: 1920 },
      safeArea: { top: 0, bottom: 0 }
    };
  }
  try {
    const s = intents.computeSurface(SYNTH);
    const gen = parseWxH(s.generate);
    const keptW = gen.w - s.cropPx.left - s.cropPx.right;
    const keptH = gen.h - s.cropPx.top - s.cropPx.bottom;
    const margin = (EXPECTED_EDGE_MARGIN_PCT / 100) * Math.min(keptW, keptH);

    // The fixture is only meaningful if it really does crop the sides, and if the
    // crop EXCEEDS the margin — that is the precise condition under which
    // Math.max silently discards the margin.
    check(
      'S2c synthetic 1:3 surface really does crop the sides (fixture is meaningful)',
      s.cropPx.left > 0,
      `cropPx=${JSON.stringify(s.cropPx)} generate=${s.generate}`
    );
    check(
      'S2c synthetic side crop EXCEEDS the margin (the Math.max-discards condition)',
      s.cropPx.left > margin,
      `cropLeft=${s.cropPx.left} margin=${margin.toFixed(2)} — fixture no longer tests the defect`
    );

    // The assertion that a partial X revert fails: the left edge must be the crop
    // line PLUS the margin, not whichever of the two happens to be larger.
    const expectedLeftPct = ((s.cropPx.left + margin) / gen.w) * 100;
    const expectedRightPct = ((s.cropPx.left + keptW - margin) / gen.w) * 100;
    check(
      'S2c synthetic box.left === (sideCrop + margin), additively — not Math.max(crop, margin)',
      Math.abs(s.box.left - expectedLeftPct) <= 0.1,
      `box.left=${s.box.left}% expected=${expectedLeftPct.toFixed(4)}% ` +
      `(Math.max would give ${((s.cropPx.left / gen.w) * 100).toFixed(4)}%)`
    );
    check(
      'S2c synthetic box.right === (sideCrop + keptW - margin), additively',
      Math.abs(s.box.right - expectedRightPct) <= 0.1,
      `box.right=${s.box.right}% expected=${expectedRightPct.toFixed(4)}%`
    );
    // And the margin must be a real inset inside the KEPT band, in pixels.
    const leftPx = (s.box.left / 100) * gen.w;
    check(
      'S2c synthetic left edge clears the side-crop line by the full margin',
      leftPx - s.cropPx.left >= margin - 1,
      `leftPx=${leftPx.toFixed(2)} cropLeft=${s.cropPx.left} gap=${(leftPx - s.cropPx.left).toFixed(2)} margin=${margin.toFixed(2)}`
    );
  } finally {
    if (added) delete pf.PLATFORM_FORMATS[SYNTH];
  }
}

// ── S3: composited logo has strictly positive gap to delivered frame edges ─
// Strongest Defect A evidence: logoPlacementFor is OUR code, no model
// compliance involved. Today Stories ships flush to the right edge and 4:5
// flush to the bottom for any logoW/logoH. Assert production size AND a
// small sweep so a single-size coincidence cannot greenwash a flush place.
{
  const keys = liveImageSurfaces();
  for (const key of keys) {
    const surface = intents.computeSurface(key);
    const dims = deliveryDimsOf(key);
    const minSide = Math.min(dims.width, dims.height);

    for (const spec of LOGO_SWEEP) {
      const logoW = spec.wFrac * minSide;
      const logoH = spec.hOfW * logoW;
      const place = logoPlace(surface, dims, logoW, logoH);
      const isProduction = spec.wFrac === LOGO_W_FRAC && spec.hOfW === LOGO_H_OF_W;
      const tag = `S3 ${key} logo ${logoW.toFixed(1)}x${logoH.toFixed(1)}` +
        (isProduction ? ' [production]' : '');

      // logoPlacementFor returns null when the mark cannot fit the content rect,
      // and the renderer then ships the ad without a logo. That is a legitimate
      // answer for an absurd sweep size, so skip it — but NOT for the production
      // size, where a null means the real renderer would drop the brand mark.
      if (!place) {
        check(
          `${tag} places at all`,
          !isProduction,
          'logoPlacementFor returned null at the production size — the ad would ship with no logo'
        );
        continue;
      }

      check(
        `${tag} left gap > 0`,
        place.left > 0,
        `place.left=${place.left}`
      );
      check(
        `${tag} top gap > 0`,
        place.top > 0,
        `place.top=${place.top}`
      );
      check(
        `${tag} right gap > 0`,
        place.left + place.width < dims.width,
        `rightEdge=${place.left + place.width} dims.w=${dims.width}`
      );
      check(
        `${tag} bottom gap > 0`,
        place.top + place.height < dims.height,
        `bottomEdge=${place.top + place.height} dims.h=${dims.height}`
      );
    }
  }
}

// ── S4: every generation-size table entry is an enum member ─────────────
// Would have caught the original three-size stale table the moment a fourth
// non-enum (or any non-enum) was proposed; pins the fix from regressing to a
// "derive arbitrary WxH" path that the Atlas gateway has not proven.
{
  const table = generationSizeTable();
  check(
    'S4 generation-size table is non-empty',
    table.length > 0,
    `table=${JSON.stringify(table)}`
  );

  for (const size of table) {
    check(
      `S4 gen size ${size} is sendable (schema enum member, or probed live)`,
      SENDABLE.has(size),
      `neither in the ${GPT_IMAGE_2_EDIT_SIZE_ENUM.length}-value enum nor in PROVEN_NON_ENUM_SIZES — ` +
      `an unproven size risks a 400 or a silent coerce to 1024x1024, which would ` +
      `hand a square frame to a non-square surface and then crop it after the billable call`
    );
    // A probed size must carry its evidence, or the allowlist becomes a way to
    // wave anything through — which is exactly the failure S4 exists to prevent.
    if (!ENUM_SET.has(size)) {
      const proof = PROVEN_NON_ENUM_SIZES[size];
      check(
        `S4 non-enum size ${size} cites a live probe (prediction id + date)`,
        !!(proof && proof.predictionId && proof.probedOn),
        `PROVEN_NON_ENUM_SIZES[${size}]=${JSON.stringify(proof)}`
      );
    }
  }

  // Pin the post-fix table membership explicitly (order checked loosely
  // here; S6 pins selection behaviour which depends on order).
  for (const size of EXPECTED_GEN_SIZE_TABLE) {
    check(
      `S4 expected post-fix size ${size} is present in the table`,
      table.includes(size),
      `table=${table.join(',')}`
    );
  }

  // If GEN_SIZES is exported, also pin exact membership (no surprise extras
  // that would silently reprice other aspects).
  if (Array.isArray(intents.GEN_SIZES)) {
    const exported = intents.GEN_SIZES.map((s) =>
      typeof s === 'string' ? s : `${s.w}x${s.h}`
    );
    check(
      'S4 exported GEN_SIZES matches the expected six-entry post-Phase-A table (set equality)',
      exported.length === EXPECTED_GEN_SIZE_TABLE.length &&
        EXPECTED_GEN_SIZE_TABLE.every((s) => exported.includes(s)) &&
        exported.every((s) => EXPECTED_GEN_SIZE_TABLE.includes(s)),
      `exported=${exported.join(',')} expected=${EXPECTED_GEN_SIZE_TABLE.join(',')}`
    );
    // Order pin: first three legacy, then 1152x2048 / 2048x1152, then probed
    // 4:5 — equal-loss ties still prefer the earlier (legacy) entry.
    check(
      'S4 GEN_SIZES table order keeps 1024x1024 before any equal-loss alternative',
      exported.indexOf('1024x1024') === 0,
      `exported order=${exported.join(',')}; chooseGenSize uses strict < so first wins ties`
    );
  }
}

// ── S5: 9:16 surfaces select exact-aspect size → zero crop, lossPct 0 ───
// Defect B: 1152x2048 is enum-safe, exactly 9:16, and proven live on this
// account (session.md §0.295). Least-crop selection must pick it with 0 loss.
{
  const nineSixteen = pf.PLATFORM_FORMAT_KEYS.filter((k) => {
    const a = pf.PLATFORM_FORMATS[k] && pf.PLATFORM_FORMATS[k].aspectRatio;
    return a === '9:16';
  });
  check(
    'S5 at least meta_stories_9_16 and meta_reels_9_16 are 9:16',
    nineSixteen.includes('meta_stories_9_16') && nineSixteen.includes('meta_reels_9_16'),
    `got=${nineSixteen.join(',')}`
  );

  for (const key of nineSixteen) {
    const s = intents.computeSurface(key);
    check(
      `S5 ${key} generates at exact 9:16 enum size 1152x2048`,
      s.generate === '1152x2048',
      `generate=${s.generate}`
    );
    check(
      `S5 ${key} cropPx all zero (no side band destroyed)`,
      s.cropPx.left === 0 &&
        s.cropPx.right === 0 &&
        s.cropPx.top === 0 &&
        s.cropPx.bottom === 0,
      `cropPx=${JSON.stringify(s.cropPx)}`
    );
    check(
      `S5 ${key} lossPct === 0`,
      s.lossPct === 0,
      `lossPct=${s.lossPct}`
    );
  }
}

// ── S6: adding 1152x2048 / 2048x1152 did not displace Meta winners ──────
// 1:1 → 1024x1024, 4:5 → 1088x1360. Least-crop with `<` tie-break makes
// TABLE ORDER load-bearing — pin the winners, not just loss.
//
// Phase A: 2048x1152 (schema-enum exact 16:9) is now in GEN_SIZES so true
// 16:9 surfaces (incl. frozen pmax_16_9, still reachable via
// adRegenerateService) generate zero-crop. Earlier this harness pinned
// 1536x1024 + 80px T/B (3:2 loss 15.6%) and deliberately did NOT add the
// enum 16:9 member because pmax was frozen — that freeze no longer applies
// to generation geometry once live PMax landscape (1.91:1) needs a near-
// landscape plate; the enum member is the right answer for exact 16:9.
{
  const feed11 = intents.computeSurface('meta_feed_1_1');
  check(
    'S6 meta_feed_1_1 still generates 1024x1024 (not displaced by 1152x2048 or 2048x2048)',
    feed11.generate === '1024x1024',
    `generate=${feed11.generate}`
  );
  check(
    'S6 meta_feed_1_1 still zero crop / zero loss',
    feed11.cropPx.left === 0 &&
      feed11.cropPx.top === 0 &&
      feed11.lossPct === 0,
    `cropPx=${JSON.stringify(feed11.cropPx)} lossPct=${feed11.lossPct}`
  );

  // 4:5 selects the probed exact-aspect size, NOT 1152x2048 (which would lose
  // ~29.7% on this aspect) and not the old 1024x1536 (16.7%).
  const feed45 = intents.computeSurface('meta_feed_4_5');
  check(
    `S6 meta_feed_4_5 generates ${FEED_4_5_GENERATE} (exact 4:5; 1152x2048 loses ~29.7% here, 1024x1536 lost 16.7%)`,
    feed45.generate === FEED_4_5_GENERATE,
    `generate=${feed45.generate}`
  );

  // Frozen pmax_16_9 — pin by key (not "first 16:9") so live pmax_video_16_9
  // cannot steal this pin. Phase A: exact-16:9 enum member → zero crop.
  const pmax = intents.computeSurface('pmax_16_9');
  check(
    'S6 pmax_16_9 generates 2048x1152 (Phase A enum exact 16:9; was 1536x1024 / 15.6% T/B crop)',
    pmax.generate === '2048x1152',
    `generate=${pmax.generate}`
  );
  check(
    'S6 pmax_16_9 is now zero-crop / zero-loss at 2048x1152 (exact 16:9 enum member)',
    pmax.cropPx.left === 0 &&
      pmax.cropPx.right === 0 &&
      pmax.cropPx.top === 0 &&
      pmax.cropPx.bottom === 0 &&
      pmax.lossPct === 0,
    `cropPx=${JSON.stringify(pmax.cropPx)} lossPct=${pmax.lossPct}`
  );

  // Phase A live PMax statics — generate size + crop pinned explicitly.
  // 1.91:1 is NOT exact 16:9 (1.777…): 2048x1152 wins least-crop and still
  // centre-crops 40px T/B (6.9% loss). Square and portrait are exact-aspect.
  const pmaxLand = intents.computeSurface('pmax_landscape_1_91_1');
  check(
    'S6 pmax_landscape_1_91_1 generates 2048x1152 (nearest enum landscape; 1.91:1 ≠ 16:9)',
    pmaxLand.generate === '2048x1152',
    `generate=${pmaxLand.generate}`
  );
  check(
    'S6 pmax_landscape_1_91_1 crop is 40px T/B (6.9% — 1.91:1 on 16:9 plate)',
    pmaxLand.cropPx.left === 0 &&
      pmaxLand.cropPx.right === 0 &&
      pmaxLand.cropPx.top === 40 &&
      pmaxLand.cropPx.bottom === 40 &&
      pmaxLand.lossPct === 6.9,
    `cropPx=${JSON.stringify(pmaxLand.cropPx)} lossPct=${pmaxLand.lossPct}`
  );

  const pmaxSq = intents.computeSurface('pmax_square_1_1');
  check(
    'S6 pmax_square_1_1 generates 1024x1024 (exact 1:1, zero crop)',
    pmaxSq.generate === '1024x1024' &&
      pmaxSq.cropPx.left === 0 &&
      pmaxSq.cropPx.top === 0 &&
      pmaxSq.lossPct === 0,
    `generate=${pmaxSq.generate} cropPx=${JSON.stringify(pmaxSq.cropPx)} lossPct=${pmaxSq.lossPct}`
  );

  const pmaxPort = intents.computeSurface('pmax_portrait_4_5');
  check(
    'S6 pmax_portrait_4_5 generates 1088x1360 (exact 4:5, zero crop)',
    pmaxPort.generate === '1088x1360' &&
      pmaxPort.cropPx.left === 0 &&
      pmaxPort.cropPx.top === 0 &&
      pmaxPort.lossPct === 0,
    `generate=${pmaxPort.generate} cropPx=${JSON.stringify(pmaxPort.cropPx)} lossPct=${pmaxPort.lossPct}`
  );
}

// ── S7: 4:5 remaining crop is a known deliberate remainder ──────────────
// No enum entry is exactly 4:5. Closing this crop needs a non-enum size and
// one billable probe — a separate owner decision. Pin the exact current
// numbers so a silent close (or a silent worsen) forces a conscious harness
// update rather than drifting.
{
  const s = intents.computeSurface('meta_feed_4_5');
  check(
    'S7 meta_feed_4_5 generate is the deliberate least-crop enum size 1024x1536',
    s.generate === FEED_4_5_GENERATE,
    `generate=${s.generate}; reason: no exact-4:5 enum member — non-enum 1088x1360/1024x1280 blocked until billable probe`
  );
  check(
    `S7 meta_feed_4_5 crop top+bottom is exactly ${FEED_4_5_CROP_TOP_BOTTOM}px each (known remainder)`,
    Math.round(s.cropPx.top) === FEED_4_5_CROP_TOP_BOTTOM &&
      Math.round(s.cropPx.bottom) === FEED_4_5_CROP_TOP_BOTTOM &&
      Math.round(s.cropPx.left) === 0 &&
      Math.round(s.cropPx.right) === 0,
    `cropPx=${JSON.stringify(s.cropPx)}; reason: 1536-round(1024/0.8)=256 total vertical crop, centre-split`
  );
  check(
    `S7 meta_feed_4_5 lossPct is exactly ${FEED_4_5_LOSS_PCT} (known remainder)`,
    s.lossPct === FEED_4_5_LOSS_PCT,
    `lossPct=${s.lossPct}; reason: deliberate enum-safe remainder, not an oversight — Defect A margin still applies inside the kept region`
  );
}

// ── summary ─────────────────────────────────────────────────────────────
// ── S2e. Google's central-80% rule, in the units Google writes it in ────
//
// The three live PMax statics must keep the safe box inside the central 80%
// of BOTH axes. This is the check that would have caught the 1200x628 box
// emitting x 5..95: a short-side margin looks correct in pixels and is wrong
// in the only units the policy is stated in, so real ad copy landed in the
// band Google crops. Verified against a delivered render — ink began at x=60px
// against a box edge of 62.8px, i.e. the model obeyed a box that was itself wrong.
//
// Asserted on the EMITTED box, so it is independent of how the margin is
// computed: any future refactor that reintroduces a uniform-pixel border on
// these surfaces fails here whatever its internal arithmetic looks like.
{
  const PMAX_STATICS = ['pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5'];
  const LO = EXPECTED_PMAX_EDGE_MARGIN_PCT;
  const HI = 100 - EXPECTED_PMAX_EDGE_MARGIN_PCT;
  const EPS = 0.01;
  for (const key of PMAX_STATICS) {
    const b = intents.computeSurface(key).box;
    check(`S2e ${key} box.left inside central 80%`,   b.left   >= LO - EPS, `left=${b.left}% must be >= ${LO}%`);
    check(`S2e ${key} box.right inside central 80%`,  b.right  <= HI + EPS, `right=${b.right}% must be <= ${HI}%`);
    check(`S2e ${key} box.top inside central 80%`,    b.top    >= LO - EPS, `top=${b.top}% must be >= ${LO}%`);
    check(`S2e ${key} box.bottom inside central 80%`, b.bottom <= HI + EPS, `bottom=${b.bottom}% must be <= ${HI}%`);
  }
}

const liveKeys = liveImageSurfaces();
const scope = [
  `${liveKeys.length} live image surfaces`,
  `${pf.PLATFORM_FORMAT_KEYS.length} PLATFORM_FORMAT_KEYS`,
  'S1–S7'
].join(', ');

if (failures.length) {
  console.error(`❌ static safe box: ${failures.length} failure(s), ${passed} passed across ${scope}`);
  for (const f of failures) {
    console.error(`  - ${f.name}`);
    if (f.detail) console.error(`      ${f.detail}`);
  }
  process.exit(1);
}

console.log(`✅ static safe box: ${passed} checks passed across ${scope}`);
process.exit(0);

/*
 * ═══════════════════════════════════════════════════════════════════════
 * REVERT-PROOF PLAN (CLAUDE.md §5)
 * Back each fix out with the one-line edit below and re-run this harness.
 * A check that stays green after the revert is too loose — tighten it.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * S1 (additive margin → raw positive insets on every live image surface)
 *   Revert: in staticAdIntents.computeSurface, restore
 *     x0 = Math.max(x0, marginPx)  (and the other three Math.max/Math.min
 *     against gen origin) instead of x0 = cropLeft + margin etc.
 *   Must go red: S1 meta_feed_4_5 raw safe-box top/bottom inset > 0;
 *                S1 meta_stories_9_16 raw safe-box left/right inset > 0.
 *   (S3 will also go red — same root cause, logo flush to frame edge.)
 *
 * S2 (inward % rounding → box edges never inside crop band)
 *   Revert: restore pct = (v, total) => +((v / total) * 100).toFixed(1)
 *   for all four edges (no ceil left/top, no floor right/bottom).
 *   Must go red: S2 meta_feed_4_5 box.top% / box.bottom% (0.512px into cut);
 *                S2 meta_stories_9_16 box.left% / box.right% pre-fix path
 *                only if 9:16 still crops — after Defect B (zero crop on
 *                9:16) the Stories S2 crop-band assertion is vacuously true
 *                for left/right, so ALSO verify S2 still fails on 4:5 alone
 *                when only the rounding fix is reverted. Pin relies on 4:5.
 *
 * S3 (logo strictly inside delivered frame with positive gaps)
 *   Revert: same as S1 (margin non-additive). Alternatively, in
 *   logoPlacementFor, force right/bottom alignment to the clamped safe-box
 *   edge (sb.right = dims.width / sb.bottom = dims.height).
 *   Must go red: S3 meta_stories_9_16 … right gap > 0 [production];
 *                S3 meta_feed_4_5 … bottom gap > 0 [production].
 *
 * S4 (GEN_SIZES ⊆ schema size enum)
 *   Revert: add a non-enum size to GEN_SIZES, e.g. { w: 1088, h: 1360 }
 *   (exact 4:5 but NOT in the 14-value enum), OR remove the enum membership
 *   check and ship that size.
 *   Must go red: S4 gen size 1088x1360 ∈ gpt-image-2/edit schema size enum.
 *   Also: drop 1152x2048 from the table →
 *   S4 expected post-fix size 1152x2048 is present in the table goes red.
 *
 * S5 (9:16 exact-aspect / zero crop)
 *   Revert: remove { w: 1152, h: 2048 } from GEN_SIZES (back to three legacy).
 *   Must go red: S5 meta_stories_9_16 generates at exact 9:16 enum size
 *                1152x2048; S5 … cropPx all zero; S5 … lossPct === 0
 *                (and the reels twin of each).
 *
 * S6 (other aspects not displaced by 1152x2048)
 *   Revert: reorder GEN_SIZES so 1152x2048 precedes 1024x1024, OR replace
 *   1024x1024 with 2048x2048 as the only 1:1 entry, OR force 4:5 onto
 *   1152x2048 by deleting 1024x1536.
 *   Must go red: S6 meta_feed_1_1 still generates 1024x1024 …;
 *                S6 meta_feed_4_5 still generates 1024x1536 …;
 *                S6 <16:9 key> still generates 1536x1024 ….
 *   Note: equal-loss ties use strict `<`, so moving 2048x2048 ahead of
 *   1024x1024 (if both present) is enough to flip 1:1 — that is why table
 *   ORDER is pinned, not only set membership.
 *
 * S7 (4:5 deliberate 128px remainder)
 *   Revert: close the 4:5 crop by selecting a non-enum exact-4:5 size
 *   (1088x1360 / 1024x1280), OR worsen it by removing 1024x1536 so a
 *   poorer size wins.
 *   Must go red: S7 meta_feed_4_5 generate is … 1024x1536;
 *                S7 … crop top+bottom is exactly 128px each;
 *                S7 … lossPct is exactly 16.7.
 *   Closing the crop for real is a product decision — update the expected
 *   constants in this file in the SAME change, do not weaken the assert.
 *
 * Trap to avoid (already burned once): a bare source-text regex that matches
 * a comment 80 lines from the real guard and stays green while the guard is
 * gone. Every S* above asserts RUNTIME behaviour of computeSurface /
 * safeBoxInDeliveredPx / logoPlacementFor, not string presence in a file.
 */
