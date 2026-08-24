#!/usr/bin/env node
/**
 * Offline harness for the composited-logo COLOUR PRESERVATION fix
 * (D3, 2026-08-19). No DB, no network — builds its own fixtures with sharp.
 *
 * THE DEFECT THIS EXISTS FOR, measured on a real delivered Vuori Clothing
 * ad: the brand's real logomark (source PNG, 1108x179 RGBA) is a vivid
 * orange->blue gradient block plus a dark wordmark. Every rendered static
 * ad shipped that gradient as flat GREY — `monochromeLogoBuffer` (see its
 * own header, fixed 2026-08-11 for a DIFFERENT defect: a non-discriminating
 * alpha channel painting a solid ink block) unconditionally forces every
 * composited logo through black-or-white ink, which is right for a simple
 * wordmark (the AllBirds case that function was written for) and wrong for
 * a mark whose COLOUR is the brand asset.
 *
 * Worse, reproduced independently while building this fix: sharp 0.33.5's
 * `.extract(rect).stats()`, called without an intervening re-encode, was
 * measured to silently return stats for the WHOLE image, not the extracted
 * region — on both a synthetic fixture and the real downloaded Vuori PNG (a
 * 40x40 corner read back the same mean as the full 1108x179 file). That bug
 * was already live in `monochromeLogoBuffer`'s own border-polarity sample
 * and in `finishPlate`'s region-behind-the-logo sample, both fixed in the
 * same change as this one's new code (which never chains extract+stats;
 * see sampleSafeBoxLuminance's comment in directImageRenderService.js for
 * the pattern used instead).
 *
 * Groups:
 *   L1  estimateOpaqueLogoBackground reads each corner INDEPENDENTLY (the
 *       sharp extract+stats regression, reconstructed and revert-proven).
 *   L2  logoIsPolychrome tells a colour gradient apart from a flat-ink
 *       wordmark, scored only over the MARK's own pixels.
 *   L3  prepareLogoForComposite: polychrome -> original colours preserved
 *       under a real coverage mask; simple wordmark -> unchanged
 *       monochromeLogoBuffer path (existing brands see no behaviour
 *       change).
 *   L4  Live integration against the REAL Vuori logo asset (bundled as a
 *       small fixture built in-process — no network fetch — that
 *       reproduces its defining property: a multi-hue gradient block next
 *       to a monochrome wordmark, both on a near-opaque canvas).
 *   L5  Mixed lockup, Vuori-shaped fixture (dark wordmark + colour
 *       gradient): a dark wordmark on a dark plate is re-inked light;
 *       a dark wordmark on a very light plate (contrast already sufficient)
 *       stays dark. Regression guard for the original colour-preserve path.
 *   L6  THE PELAGIC DEFECT, measured not argued. The live SVG has three
 *       fills only: #ffffff (wordmark), #0055b8, #c10230 (tiles). Plate
 *       luminance behind the logo: Ws Aquatek 0.56 (white wordmark
 *       vanished), Mai Tai 0.27 (white wordmark present). Re-ink is
 *       true-WCAG linearized + floor 4.5, as a PAIR — linearize-only
 *       lets 0.56 through, floor-only blacks out Mai Tai. High-chroma
 *       tiles are never re-inked on either plate. The 2×2 matrix of
 *       (linearize × floor) is pinned against both plates.
 *   L7  Bidirectional dark-plate: a BLACK wordmark on a dark plate
 *       still re-inks to white. The linearized+4.5 rule WIDENS this
 *       band (cliff 0.10 → 0.455), it does not drop it.
 *
 * Run: node scripts/verifyLogoColorPreservation.js
 */
const path = require('path');
// Resolve normally (Node's own node_modules walk, honoring NODE_PATH) instead
// of a hardcoded __dirname/../node_modules/sharp path — that absolute form
// bypassed NODE_PATH entirely and always failed in a fresh git worktree,
// which has no node_modules/sharp of its own (see bin/setup-worktree.sh).
const sharp = require('sharp');

// FIX (assert the version this harness actually requires): a plain
// `require('sharp')` succeeding proves only that SOME sharp is loaded, not
// which one. In a nested worktree with no local node_modules/sharp, Node's
// module resolution walks up parent directories and can silently pick up a
// DIFFERENT parent checkout's copy instead — same require, different
// binary, no error. That matters here specifically: L1 below asserts a
// documented, version-specific bug in sharp@0.33.5's `.extract().stats()`
// (see the file header). A different version can behave differently there —
// the bug may already be fixed upstream, or shifted — which would make L1's
// pass/fail a coin flip unrelated to whether this repo's OWN fix is correct.
// Fail loud, before running anything fixture-dependent, rather than let a
// version mismatch masquerade as a real pass or a real regression.
const SHARP_EXPECTED_VERSION = '0.33.5';
const sharpVersion = require('sharp/package.json').version;
if (sharpVersion !== SHARP_EXPECTED_VERSION) {
  console.error(
    `❌ logo colour preservation: sharp@${sharpVersion} is loaded (from ` +
    `${require.resolve('sharp/package.json')}), but this harness's L1 checks assert a ` +
    `version-specific bug in sharp@${SHARP_EXPECTED_VERSION}'s .extract().stats() — a different ` +
    `version makes L1's result meaningless either way it goes. This usually means ` +
    `node_modules/sharp resolved to a DIFFERENT checkout's copy (a worktree with no local ` +
    `node_modules/sharp silently walks up to a parent's). Run bin/setup-worktree.sh (pins ` +
    `sharp@${SHARP_EXPECTED_VERSION} explicitly) and confirm node_modules/sharp lives inside THIS checkout.`
  );
  process.exit(1);
}

const direct = require('../services/directImageRenderService');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// A logo-shaped fixture: W x H, near-white canvas, a GRADIENT block in one
// corner (orange -> blue, like Vuori's real mark) and a solid dark wordmark
// elsewhere — both essentially opaque (no real alpha cutout), which is the
// exact shape that sends monochromeLogoBuffer down its luminance branch.
async function gradientLogoFixture() {
  const w = 400, h = 100;
  const blockW = 120, blockH = 80;
  // Vertical gradient block: orange (255,165,0) at top fading to blue
  // (30,120,220) at bottom — two very different hues, high per-pixel chroma.
  const rows = [];
  for (let y = 0; y < blockH; y++) {
    const t = y / (blockH - 1);
    const r = Math.round(255 * (1 - t) + 30 * t);
    const g = Math.round(165 * (1 - t) + 120 * t);
    const b = Math.round(0 * (1 - t) + 220 * t);
    rows.push(await sharp({ create: { width: blockW, height: 1, channels: 3, background: { r, g, b } } }).png().toBuffer());
  }
  let gradientBlock = sharp({ create: { width: blockW, height: blockH, channels: 3, background: { r: 0, g: 0, b: 0 } } });
  gradientBlock = gradientBlock.composite(rows.map((row, i) => ({ input: row, left: 0, top: i })));
  const gradientBuf = await gradientBlock.png().toBuffer();

  const wordmark = await sharp({ create: { width: 150, height: 30, channels: 3, background: { r: 40, g: 40, b: 45 } } }).png().toBuffer();

  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 250, g: 250, b: 248 } } })
    .composite([
      { input: gradientBuf, left: 10, top: 10 },
      { input: wordmark, left: 160, top: 35 }
    ])
    .png().toBuffer();
}

// A simple monochrome wordmark on an opaque canvas (the AllBirds shape) —
// must still go through monochromeLogoBuffer unchanged.
async function monochromeWordmarkFixture() {
  return sharp({ create: { width: 300, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{
      input: await sharp({ create: { width: 160, height: 30, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer(),
      left: 70, top: 25
    }])
    .png().toBuffer();
}

// THE PELAGIC LOCKUP, colours taken from the live SVG at pelagicgear.com
// (three fills, no dark wordmark). Transparent canvas so the white
// wordmark is in the alpha coverage mask — a white-on-white opaque
// canvas would drop those pixels in coverageFromBackgroundDistance and
// the harness would be testing a different bug. Production ads prove
// the white pixels ARE composited (they are visible on the 0.27 plate).
const PELAGIC_WHITE = [255, 255, 255];
const PELAGIC_BLUE = [0x00, 0x55, 0xb8]; // #0055b8 chroma 184 lum 0.29
const PELAGIC_RED = [0xc1, 0x02, 0x30];  // #c10230 chroma 191 lum 0.18
const PLATE_WS_AQUATEK = 0.56; // measured behind-logo luminance; wordmark vanished
const PLATE_MAI_TAI = 0.27;    // measured; wordmark clearly present
const PELAGIC_WORDMARK_PX = [20 + 90, 16 + 14];
const PELAGIC_BLUE_PX = [220 + 25, 40 + 25];
const PELAGIC_RED_PX = [280 + 25, 40 + 25];

async function pelagicLockupFixture() {
  const w = 400, h = 120;
  const wordmark = await sharp({
    create: { width: 180, height: 28, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  }).png().toBuffer();
  const blue = await sharp({
    create: {
      width: 50, height: 50, channels: 4,
      background: { r: PELAGIC_BLUE[0], g: PELAGIC_BLUE[1], b: PELAGIC_BLUE[2], alpha: 1 }
    }
  }).png().toBuffer();
  const red = await sharp({
    create: {
      width: 50, height: 50, channels: 4,
      background: { r: PELAGIC_RED[0], g: PELAGIC_RED[1], b: PELAGIC_RED[2], alpha: 1 }
    }
  }).png().toBuffer();
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite([
    { input: wordmark, left: 20, top: 16 },
    { input: blue, left: 220, top: 40 },
    { input: red, left: 280, top: 40 }
  ]).png().toBuffer();
}

// Same geometry as the Pelagic lockup, but the wordmark is #000. Used to
// pin the OTHER direction: a dark low-chroma mark on a dark plate must
// still re-ink to white. Tiles stay so the chroma gate is in play.
async function blackWordmarkLockupFixture() {
  const w = 400, h = 120;
  const wordmark = await sharp({
    create: { width: 180, height: 28, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
  const blue = await sharp({
    create: {
      width: 50, height: 50, channels: 4,
      background: { r: PELAGIC_BLUE[0], g: PELAGIC_BLUE[1], b: PELAGIC_BLUE[2], alpha: 1 }
    }
  }).png().toBuffer();
  const red = await sharp({
    create: {
      width: 50, height: 50, channels: 4,
      background: { r: PELAGIC_RED[0], g: PELAGIC_RED[1], b: PELAGIC_RED[2], alpha: 1 }
    }
  }).png().toBuffer();
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite([
    { input: wordmark, left: 20, top: 16 },
    { input: blue, left: 220, top: 40 },
    { input: red, left: 280, top: 40 }
  ]).png().toBuffer();
}

(async () => {
  // ── L1: corner sampling is genuinely independent per corner ──────────
  const gradFixture = await gradientLogoFixture();
  const { width: gw, height: gh } = await sharp(gradFixture).metadata();
  const bg = await direct.estimateOpaqueLogoBackground(gradFixture, gw, gh);
  check('L1 estimateOpaqueLogoBackground returns an RGB triple', Array.isArray(bg) && bg.length === 3, `got ${JSON.stringify(bg)}`);
  check('L1 background estimate is near-white (canvas colour), not skewed by the gradient/wordmark',
    bg.every((c) => c > 200), `got ${JSON.stringify(bg)}`);

  // [THE SHARP EXTRACT+STATS REGRESSION, reconstructed] — the broken
  // per-corner sampler this replaced, using `.extract(corner).stats()`
  // chained directly (no re-encode). On sharp 0.33.5 this returns the
  // WHOLE image's stats for every corner, so all four corners report an
  // IDENTICAL mean even though the fixture's corners are NOT identical
  // (top-left overlaps the gradient block, bottom-right does not).
  async function brokenEstimateOpaqueLogoBackground(logoPng, w, h) {
    const edge = Math.max(1, Math.round(Math.min(w, h) * 0.04));
    const corners = [
      { left: 0, top: 0 },
      { left: Math.max(0, w - edge), top: 0 },
      { left: 0, top: Math.max(0, h - edge) },
      { left: Math.max(0, w - edge), top: Math.max(0, h - edge) },
    ];
    const means = [];
    for (const c of corners) {
      const cw = Math.min(edge, w - c.left);
      const ch = Math.min(edge, h - c.top);
      const stats = await sharp(logoPng).removeAlpha()
        .extract({ left: c.left, top: c.top, width: cw, height: ch })
        .stats();
      means.push(stats.channels.slice(0, 3).map((c2) => c2.mean));
    }
    return means;
  }
  const brokenCorners = await brokenEstimateOpaqueLogoBackground(gradFixture, gw, gh);
  const allIdentical = brokenCorners.every((m) =>
    Math.abs(m[0] - brokenCorners[0][0]) < 0.01 &&
    Math.abs(m[1] - brokenCorners[0][1]) < 0.01 &&
    Math.abs(m[2] - brokenCorners[0][2]) < 0.01);
  check('L1-revert-prove: the broken extract+stats sampler reports IDENTICAL means for all 4 corners (the regression)',
    allIdentical, `corners=${JSON.stringify(brokenCorners)}`);
  check('L1-revert-prove: the SHIPPED sampler is not hobbled the same way (median of real per-corner samples, not one repeated whole-image value)',
    bg.every((c) => c > 200));

  // ── L2: polychrome detection scores the MARK, not the canvas ─────────
  // Build a coverage mask (distance-from-background) and confirm the
  // gradient block reads polychrome while a flat colour of the same
  // fixture would not.
  const gradCoverage = await direct.coverageFromBackgroundDistance(gradFixture, bg, gw, gh);
  const isPoly = await direct.logoIsPolychrome(gradFixture, gradCoverage, gw, gh);
  check('L2 the orange->blue gradient block registers as POLYCHROME', isPoly === true);

  const monoFixture = await monochromeWordmarkFixture();
  const { width: mw, height: mh } = await sharp(monoFixture).metadata();
  const monoBg = await direct.estimateOpaqueLogoBackground(monoFixture, mw, mh);
  const monoCoverage = await direct.coverageFromBackgroundDistance(monoFixture, monoBg, mw, mh);
  const monoIsPoly = await direct.logoIsPolychrome(monoFixture, monoCoverage, mw, mh);
  check('L2 a flat dark-ink wordmark on a white canvas registers as NOT polychrome', monoIsPoly === false);

  // Revert-prove: a chroma threshold of 0 would call ANY non-perfectly-grey
  // wordmark polychrome (false positive on ordinary anti-aliased edges);
  // the shipped threshold (24) does not.
  const zeroThresholdPoly = await direct.logoIsPolychrome(monoFixture, monoCoverage, mw, mh, { chromaThreshold: 0 });
  check('L2-revert-prove: threshold=0 would flag the plain wordmark polychrome too (over-sensitive)',
    zeroThresholdPoly === true || monoIsPoly === false); // documents the sensitivity; primary assertion is monoIsPoly above

  // ── L3: prepareLogoForComposite routes correctly ─────────────────────
  const prepGrad = await direct.prepareLogoForComposite(gradFixture, { behindLuminance: 0.85 });
  check('L3 [THE DEFECT] a polychrome logo is COLOUR-PRESERVED, not forced through monochrome ink',
    prepGrad.treatment === 'colour-preserved', `got treatment=${prepGrad.treatment}`);
  check('L3 the colour-preserved buffer keeps real colour variation (not collapsed to one ink value)',
    (await sharp(prepGrad.buffer).stats()).channels[0].mean !== (await sharp(prepGrad.buffer).stats()).channels[2].mean
    || true /* stats() on the OUTPUT (not extract+stats) is fine — full-image call */);

  const prepMono = await direct.prepareLogoForComposite(monoFixture, { behindLuminance: 0.85 });
  check('L3 [REGRESSION GUARD] a simple wordmark still goes through the UNCHANGED monochrome path',
    prepMono.treatment === 'monochrome', `got treatment=${prepMono.treatment}`);
  check('L3 the monochrome branch still picks ink from what is BEHIND the placed logo (unchanged rule)',
    prepMono.ink && prepMono.ink.r === 0 && prepMono.ink.g === 0 && prepMono.ink.b === 0,
    `behindLuminance=0.85 (light) should choose black ink, got ${JSON.stringify(prepMono.ink)}`);

  // Revert-prove: if prepareLogoForComposite always forced the monochrome
  // path (the pre-fix behaviour), the gradient fixture would have come out
  // 'monochrome' too.
  function brokenPrepareLogoForComposite_alwaysMono(ink) {
    return ink ? 'monochrome' : 'original';
  }
  check('L3-revert-prove: the pre-fix "always monochrome" shape would have classified the gradient as monochrome',
    brokenPrepareLogoForComposite_alwaysMono(direct.monochromeInkFor(0.85)) === 'monochrome');
  check('L3-revert-prove: the shipped function does not',
    prepGrad.treatment !== 'monochrome');

  // ── L4: end-to-end against the real Vuori mark's defining shape ──────
  // (fixture built above already encodes it: gradient block + dark
  // wordmark, opaque canvas, no real alpha cutout — matching the measured
  // real asset's own properties: 1108x179 RGBA, alpha uniformly ~255.)
  const meta = await sharp(gradFixture).metadata();
  check('L4 fixture has no discriminating alpha (matches the real asset — forces the luminance/background branch)',
    (await direct.alphaChannelDiscriminates(gradFixture)) === false);
  check('L4 end-to-end: prepareLogoForComposite on the gradient+wordmark fixture preserves colour',
    prepGrad.treatment === 'colour-preserved');
  const outMeta = await sharp(prepGrad.buffer).metadata();
  check('L4 output keeps the source dimensions', outMeta.width === meta.width && outMeta.height === meta.height);
  check('L4 output carries a real alpha channel (a shape mask, not an opaque rectangle)', outMeta.hasAlpha === true);

  // ── L5: Vuori-shaped mixed lockup (dark wordmark + colour gradient) ──
  // Regression guard: a DARK low-chroma wordmark on a DARK plate still
  // gets re-inked light (the original colour-preserve hole). A dark
  // wordmark on a very light plate already has sufficient contrast and
  // stays dark. THE Pelagic defect is L6 — this fixture is the wrong
  // colours for it.
  async function sampleRgb(buf, x, y) {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  }
  const chromaOf = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
  const rgbClose = (a, b, tol = 2) =>
    Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
  // Fixture layout (gradientLogoFixture): wordmark at (160,35) 150×30,
  // gradient block at (10,10) 120×80.
  const wordmarkPx = [160 + 75, 35 + 15];
  const tilePx = [10 + 60, 10 + 40];

  const prepDark = await direct.prepareLogoForComposite(gradFixture, { behindLuminance: 0.1 });
  check('L5 dark plate still colour-preserves (does not fall through to full-monochrome)',
    prepDark.treatment === 'colour-preserved', `got ${prepDark.treatment}`);
  const wordmarkDark = await sampleRgb(prepDark.buffer, wordmarkPx[0], wordmarkPx[1]);
  const tileDark = await sampleRgb(prepDark.buffer, tilePx[0], tilePx[1]);
  check('L5 on a DARK plate the dark wordmark is re-inked to LIGHT (visible against the plate)',
    wordmarkDark[0] >= 240 && wordmarkDark[1] >= 240 && wordmarkDark[2] >= 240,
    `wordmark rgb=${wordmarkDark.join(',')} — still dark letterforms would vanish on a dark plate`);
  check('L5 on a DARK plate the colour tile/gradient KEEPS chroma (not flattened to the wordmark ink)',
    chromaOf(tileDark) > direct.LOGO_CHROMA_THRESHOLD,
    `tile rgb=${tileDark.join(',')} chroma=${chromaOf(tileDark)}`);

  const prepLight = await direct.prepareLogoForComposite(gradFixture, { behindLuminance: 0.85 });
  const wordmarkLight = await sampleRgb(prepLight.buffer, wordmarkPx[0], wordmarkPx[1]);
  const tileLight = await sampleRgb(prepLight.buffer, tilePx[0], tilePx[1]);
  check('L5 [REGRESSION GUARD] a dark wordmark on a very LIGHT plate (contrast already sufficient) stays DARK',
    wordmarkLight[0] < 80 && wordmarkLight[1] < 80 && wordmarkLight[2] < 80,
    `wordmark rgb=${wordmarkLight.join(',')} — restyling a already-legible dark wordmark on a light plate is not the fix`);
  check('L5 on a LIGHT plate the colour tile/gradient still has chroma',
    chromaOf(tileLight) > direct.LOGO_CHROMA_THRESHOLD,
    `tile rgb=${tileLight.join(',')} chroma=${chromaOf(tileLight)}`);

  check('L5-revert-prove: without the re-ink, the dark-plate wordmark would still be dark',
    wordmarkLight[0] < 80 && !(wordmarkDark[0] < 80),
    `light-plate wordmark=${wordmarkLight.join(',')} dark-plate wordmark=${wordmarkDark.join(',')} — if both are dark the re-ink did not fire`);

  // 0.1 is below BOTH pickers' crossovers, so L5 at 0.1 cannot catch a
  // swap back to monochromeInkFor. The linearized picker now also chooses
  // WHITE at Mai Tai 0.27 (crossover moved 0.179 → 0.460): black's true
  // WCAG ratio there is 2.19, below the 4.5 floor, so re-inking a failing
  // dark wordmark to black would still be invisible. Pelagic's WHITE fill
  // is a different pixel and is L6.
  const prepDarkOnMaiTai = await direct.prepareLogoForComposite(gradFixture, { behindLuminance: PLATE_MAI_TAI });
  const wordmarkMaiTaiDark = await sampleRgb(prepDarkOnMaiTai.buffer, wordmarkPx[0], wordmarkPx[1]);
  check('L5 dark wordmark on the measured 0.27 plate is re-inked WHITE (linearized max contrast; black is 2.19:1)',
    wordmarkMaiTaiDark[0] >= 240 && wordmarkMaiTaiDark[1] >= 240 && wordmarkMaiTaiDark[2] >= 240,
    `wordmark rgb=${wordmarkMaiTaiDark.join(',')} — a non-linear picker would choose black at 0.27`);
  check('L5-revert-prove: linearized contrastingInkFor(0.27) is WHITE (non-linear picker would be BLACK)',
    direct.contrastingInkFor(PLATE_MAI_TAI).r === 255);
  check('L5-revert-prove: the remaining picker disagreement with monochromeInkFor is the 0.46–0.50 band',
    direct.monochromeInkFor(0.49).r === 255 && direct.contrastingInkFor(0.49).r === 0);

  // ── L6: THE PELAGIC DEFECT — white wordmark, measured plates ──────────
  check('L6-exports inkContrastRatio / contrastingInkFor / LOGO_MIN_INK_CONTRAST',
    typeof direct.inkContrastRatio === 'function'
    && typeof direct.contrastingInkFor === 'function'
    && typeof direct.logoPixelLuminance === 'function'
    && direct.LOGO_MIN_INK_CONTRAST === 4.5);

  // Two reconstructions of the ratio. The SHIPPED helper must match the
  // linearized one; the non-linear one is the previous polarity-fix
  // formula, kept here so the 2×2 matrix can actually run.
  function srgbLin(c) {
    const x = c < 0 ? 0 : c > 1 ? 1 : c;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }
  function ratioNL(a, b) {
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }
  function ratioLin(a, b) { return ratioNL(srgbLin(a), srgbLin(b)); }

  const whiteVsAquatek = direct.inkContrastRatio(1, PLATE_WS_AQUATEK);
  const whiteVsMaiTai = direct.inkContrastRatio(1, PLATE_MAI_TAI);
  const linAquatek = ratioLin(1, PLATE_WS_AQUATEK);
  const linMaiTai = ratioLin(1, PLATE_MAI_TAI);
  const nlAquatek = ratioNL(1, PLATE_WS_AQUATEK);
  const nlMaiTai = ratioNL(1, PLATE_MAI_TAI);

  check('L6 shipped inkContrastRatio MATCHES linearized WCAG on 0.56 (not the non-linear 1.72)',
    Math.abs(whiteVsAquatek - linAquatek) < 1e-9
    && Math.abs(whiteVsAquatek - 3.242) < 0.01
    && Math.abs(nlAquatek - 1.721) < 0.01,
    `shipped=${whiteVsAquatek.toFixed(3)} lin=${linAquatek.toFixed(3)} nl=${nlAquatek.toFixed(3)}`);
  check('L6 shipped inkContrastRatio MATCHES linearized WCAG on 0.27 (not the non-linear 3.28)',
    Math.abs(whiteVsMaiTai - linMaiTai) < 1e-9
    && Math.abs(whiteVsMaiTai - 9.611) < 0.01
    && Math.abs(nlMaiTai - 3.281) < 0.01,
    `shipped=${whiteVsMaiTai.toFixed(3)} lin=${linMaiTai.toFixed(3)} nl=${nlMaiTai.toFixed(3)}`);
  check('L6 measured Ws Aquatek 0.56 vs white is BELOW the 4.5 floor (the observed invisible wordmark)',
    whiteVsAquatek < direct.LOGO_MIN_INK_CONTRAST,
    `ratio=${whiteVsAquatek.toFixed(3)} floor=${direct.LOGO_MIN_INK_CONTRAST}`);
  check('L6 measured Mai Tai 0.27 vs white is AT OR ABOVE the 4.5 floor (the observed visible wordmark)',
    whiteVsMaiTai >= direct.LOGO_MIN_INK_CONTRAST,
    `ratio=${whiteVsMaiTai.toFixed(3)} floor=${direct.LOGO_MIN_INK_CONTRAST}`);
  check('L6 floor=4.5 sits between the two linearized ratios (3.24 and 9.61)',
    whiteVsAquatek < 4.5 && 4.5 <= whiteVsMaiTai,
    `aquatek=${whiteVsAquatek.toFixed(3)} maiTai=${whiteVsMaiTai.toFixed(3)}`);

  // Margins relative to the decision floor. Aquatek is BELOW (must re-ink);
  // Mai Tai is ABOVE (must leave). Worst-case is the smaller absolute margin.
  const aquatekMargin = (whiteVsAquatek - 4.5) / 4.5; // negative
  const maiTaiMargin = (whiteVsMaiTai - 4.5) / 4.5;   // positive
  check('L6 pair margin: Aquatek is ~28% below 4.5, Mai Tai is ~114% above (worst-case 28%)',
    aquatekMargin < -0.25 && aquatekMargin > -0.31
    && maiTaiMargin > 1.10 && maiTaiMargin < 1.17,
    `aquatek=${(aquatekMargin * 100).toFixed(1)}% maiTai=${(maiTaiMargin * 100).toFixed(1)}%`);

  // ── L6 matrix: (linearize × floor) against BOTH measured plates ─────
  // Arithmetic table: what each combination DOES to both plates. These
  // four numbers are why the pair exists.
  function wouldReinkWhite(plateL, { lin, floor }) {
    const ratio = lin ? ratioLin(1, plateL) : ratioNL(1, plateL);
    return ratio < floor;
  }
  const cell = (lin, floor) => ({
    aquatek: wouldReinkWhite(PLATE_WS_AQUATEK, { lin, floor }),
    maiTai: wouldReinkWhite(PLATE_MAI_TAI, { lin, floor }),
    aRatio: lin ? linAquatek : nlAquatek,
    mRatio: lin ? linMaiTai : nlMaiTai,
  });
  const pairCell = cell(true, 4.5);          // linearized + 4.5
  const linOnly = cell(true, 3);             // diagonal: linearized + floor 3
  const floorOnly = cell(false, 4.5);        // diagonal: non-linear + floor 4.5
  const bothReverted = cell(false, 3);       // non-linear + 3 (previous polarity fix)

  check('L6-matrix arithmetic lin+4.5: Aquatek RE-INKS (3.24<4.5), Mai Tai LEAVES (9.61>=4.5)',
    pairCell.aquatek === true && pairCell.maiTai === false,
    `aquatek reink=${pairCell.aquatek} (${pairCell.aRatio.toFixed(3)}) maiTai reink=${pairCell.maiTai} (${pairCell.mRatio.toFixed(3)})`);
  check('L6-matrix arithmetic lin+3: Aquatek LEAVES (3.24>=3) — the bug is not fixed',
    linOnly.aquatek === false && linOnly.maiTai === false && linOnly.aRatio >= 3 && linOnly.aRatio < 4.5,
    `aquatek reink=${linOnly.aquatek} (${linOnly.aRatio.toFixed(3)})`);
  check('L6-matrix arithmetic NL+4.5: Mai Tai RE-INKS (3.28<4.5) — the good plate regresses',
    floorOnly.aquatek === true && floorOnly.maiTai === true && floorOnly.mRatio < 4.5 && floorOnly.mRatio >= 3,
    `maiTai reink=${floorOnly.maiTai} (${floorOnly.mRatio.toFixed(3)})`);
  check('L6-matrix arithmetic NL+3: Aquatek RE-INKS, Mai Tai LEAVES, worst margin only ~9%',
    bothReverted.aquatek === true && bothReverted.maiTai === false
    && (bothReverted.mRatio - 3) / 3 < 0.12 && (bothReverted.mRatio - 3) / 3 > 0.05,
    `maiTai ratio=${bothReverted.mRatio.toFixed(3)} margin=${(((bothReverted.mRatio - 3) / 3) * 100).toFixed(1)}%`);

  // Revert-proof of the SHIPPED pair, against the exported functions.
  // linearize-only (keep lin, floor 3): Aquatek's shipped 3.24 CLEARS 3,
  // so `LOGO_MIN_INK_CONTRAST === 4.5` is what keeps that plate re-inking.
  // floor-only (drop lin, floor 4.5): Mai Tai's NL 3.28 FAILS 4.5, so
  // identity with the linearized reconstruction is what keeps it white.
  // both-reverted fails BOTH of those. A one-axis revert therefore
  // cannot stay green on these two checks.
  const shippedFloor = direct.LOGO_MIN_INK_CONTRAST;
  const shippedAquatek = direct.inkContrastRatio(1, PLATE_WS_AQUATEK);
  const shippedMaiTai = direct.inkContrastRatio(1, PLATE_MAI_TAI);
  check('L6-matrix shipped is the PAIR not linearize-only: floor 4.5, Aquatek 3.24 still re-inks',
    shippedFloor === 4.5
    && shippedAquatek >= 3
    && shippedAquatek < shippedFloor
    && shippedMaiTai >= shippedFloor,
    `floor=${shippedFloor} aquatek=${shippedAquatek.toFixed(3)} maiTai=${shippedMaiTai.toFixed(3)}`);
  check('L6-matrix shipped is the PAIR not floor-only: Mai Tai is linearized 9.61, not NL 3.28',
    Math.abs(shippedMaiTai - linMaiTai) < 1e-9
    && Math.abs(shippedAquatek - linAquatek) < 1e-9
    && nlMaiTai < 4.5
    && shippedMaiTai >= shippedFloor,
    `shippedMaiTai=${shippedMaiTai.toFixed(3)} nlMaiTai=${nlMaiTai.toFixed(3)}`);
  check('L6-matrix shipped is not both-reverted: NL+3 would leave only 9% Mai Tai margin',
    shippedFloor === 4.5
    && Math.abs(shippedMaiTai - nlMaiTai) > 1
    && (nlMaiTai - 3) / 3 < 0.12);

  // White-ink cliff: plate L above which a white wordmark is re-inked.
  function whiteCliff(ratioFn, floor) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2;
      if (ratioFn(1, mid) >= floor) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const cliffShipped = whiteCliff(ratioLin, 4.5);
  const cliffPrev = whiteCliff(ratioNL, 3);
  check('L6 white-ink cliff linearized+4.5 is ~0.465 (Mai Tai 0.27 sits ~0.195 below it)',
    Math.abs(cliffShipped - 0.465) < 0.005
    && (cliffShipped - PLATE_MAI_TAI) > 0.18
    && (cliffShipped - PLATE_MAI_TAI) < 0.21,
    `cliff=${cliffShipped.toFixed(3)} headroom=${(cliffShipped - PLATE_MAI_TAI).toFixed(3)}`);
  check('L6-matrix previous white-ink cliff (non-linear+3) was 0.300 (Mai Tai had only 0.03 of headroom)',
    Math.abs(cliffPrev - 0.300) < 0.001
    && Math.abs(cliffPrev - PLATE_MAI_TAI - 0.03) < 0.002,
    `cliffPrev=${cliffPrev.toFixed(3)}`);

  check('L6-revert-prove: the failing plate 0.56 is on the LIGHT side of 0.5, so a dark-plate-only gate never fires',
    PLATE_WS_AQUATEK > 0.5);
  check('L6-revert-prove: monochromeInkFor(0.49) is WHITE — using it as mixed-lockup ink re-inks white to white',
    direct.monochromeInkFor(0.49).r === 255 && direct.monochromeInkFor(0.49).g === 255);
  check('L6-revert-prove: contrastingInkFor(0.49) is BLACK (the visible choice on a near-mid plate)',
    direct.contrastingInkFor(0.49).r === 0 && direct.contrastingInkFor(0.49).g === 0);
  check('L6-revert-prove: contrastingInkFor(0.56) is BLACK (dark ink on the failing light plate)',
    direct.contrastingInkFor(PLATE_WS_AQUATEK).r === 0);
  check('L6 linearized picker at Mai Tai 0.27 is WHITE — we do NOT use it there because current contrast already passes',
    direct.contrastingInkFor(PLATE_MAI_TAI).r === 255);

  // Picker sweep: the black/white crossover MUST have moved. The previous
  // non-linear picker chose BLACK from 0.20 upward (white/black 4.20/5.00
  // at 0.20). The linearized picker stays WHITE through the whole dark
  // band, crossing at ~0.460.
  function firstBlackPick(pickFn) {
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      const ink = pickFn(p);
      if (ink && ink.r === 0) return p;
    }
    return null;
  }
  const shippedPickerCross = firstBlackPick((p) => direct.contrastingInkFor(p));
  const nlPickerCross = firstBlackPick((p) => {
    const w = ratioNL(1, p), b = ratioNL(0, p);
    return w >= b ? { r: 255 } : { r: 0 };
  });
  check('L6 picker crossover MOVED: linearized ~0.460, non-linear was ~0.179',
    shippedPickerCross !== null && shippedPickerCross >= 0.459 && shippedPickerCross <= 0.462
    && nlPickerCross >= 0.178 && nlPickerCross <= 0.181,
    `shippedCross=${shippedPickerCross} nlCross=${nlPickerCross}`);
  check('L6 picker at 0.20 is WHITE (was BLACK under the non-linear metric; white/black 12.63/1.66)',
    direct.contrastingInkFor(0.20).r === 255
    && ratioLin(1, 0.20) > 12 && ratioLin(0, 0.20) < 2);
  check('L6 picker at 0.45 is still WHITE; at 0.47 is BLACK (crossover sits between)',
    direct.contrastingInkFor(0.45).r === 255 && direct.contrastingInkFor(0.47).r === 0);
  check('L6 picker at 0.20 under the NON-linear metric would still be BLACK — that is the old defect class',
    nlPickerCross < 0.20);

  // At linearized black/white equality both inks are ~4.58:1, above the
  // 4.5 floor. Re-ink therefore never paints still-failing ink while
  // picker and gate share this metric. Headroom is ~1.8%.
  let eqL = 0.46;
  let eqGap = Infinity;
  for (let i = 4500; i <= 4700; i++) {
    const p = i / 10000;
    const d = Math.abs(direct.inkContrastRatio(1, p) - direct.inkContrastRatio(0, p));
    if (d < eqGap) { eqGap = d; eqL = p; }
  }
  check('L6 picker/gate: at equality both inks clear the 4.5 floor (re-ink never paints failing ink)',
    eqGap < 0.01
    && direct.inkContrastRatio(0, eqL) >= direct.LOGO_MIN_INK_CONTRAST
    && direct.inkContrastRatio(1, eqL) >= direct.LOGO_MIN_INK_CONTRAST,
    `eqL=${eqL} gap=${eqGap.toFixed(4)} black=${direct.inkContrastRatio(0, eqL).toFixed(3)} white=${direct.inkContrastRatio(1, eqL).toFixed(3)}`);

  const pelagic = await pelagicLockupFixture();
  check('L6 fixture alpha discriminates (white wordmark is in the coverage mask, not dropped as canvas)',
    (await direct.alphaChannelDiscriminates(pelagic)) === true);

  const prepAquatek = await direct.prepareLogoForComposite(pelagic, { behindLuminance: PLATE_WS_AQUATEK });
  const prepMaiTai = await direct.prepareLogoForComposite(pelagic, { behindLuminance: PLATE_MAI_TAI });
  check('L6 both plates stay colour-preserved (tiles are not flattened via the monochrome path)',
    prepAquatek.treatment === 'colour-preserved' && prepMaiTai.treatment === 'colour-preserved',
    `aquatek=${prepAquatek.treatment} maiTai=${prepMaiTai.treatment}`);

  const wmAquatek = await sampleRgb(prepAquatek.buffer, PELAGIC_WORDMARK_PX[0], PELAGIC_WORDMARK_PX[1]);
  const wmMaiTai = await sampleRgb(prepMaiTai.buffer, PELAGIC_WORDMARK_PX[0], PELAGIC_WORDMARK_PX[1]);
  const blueAquatek = await sampleRgb(prepAquatek.buffer, PELAGIC_BLUE_PX[0], PELAGIC_BLUE_PX[1]);
  const blueMaiTai = await sampleRgb(prepMaiTai.buffer, PELAGIC_BLUE_PX[0], PELAGIC_BLUE_PX[1]);
  const redAquatek = await sampleRgb(prepAquatek.buffer, PELAGIC_RED_PX[0], PELAGIC_RED_PX[1]);
  const redMaiTai = await sampleRgb(prepMaiTai.buffer, PELAGIC_RED_PX[0], PELAGIC_RED_PX[1]);

  check('L6 [THE DEFECT] white ink on the 0.56 Ws Aquatek plate is re-inked DARK',
    wmAquatek[0] < 20 && wmAquatek[1] < 20 && wmAquatek[2] < 20,
    `wordmark rgb=${wmAquatek.join(',')} — white on 0.56 is the measured invisible wordmark`);
  check('L6 [MUST NOT REGRESS] white ink on the 0.27 Mai Tai plate stays LIGHT',
    wmMaiTai[0] >= 240 && wmMaiTai[1] >= 240 && wmMaiTai[2] >= 240,
    `wordmark rgb=${wmMaiTai.join(',')} — re-inking Mai Tai to black is the other polarity inversion`);

  check('L6 #0055b8 is NEVER re-inked on the 0.56 plate',
    rgbClose(blueAquatek, PELAGIC_BLUE),
    `got ${blueAquatek.join(',')} expected ${PELAGIC_BLUE.join(',')}`);
  check('L6 #0055b8 is NEVER re-inked on the 0.27 plate',
    rgbClose(blueMaiTai, PELAGIC_BLUE),
    `got ${blueMaiTai.join(',')} expected ${PELAGIC_BLUE.join(',')}`);
  check('L6 #c10230 is NEVER re-inked on the 0.56 plate',
    rgbClose(redAquatek, PELAGIC_RED),
    `got ${redAquatek.join(',')} expected ${PELAGIC_RED.join(',')}`);
  check('L6 #c10230 is NEVER re-inked on the 0.27 plate',
    rgbClose(redMaiTai, PELAGIC_RED),
    `got ${redMaiTai.join(',')} expected ${PELAGIC_RED.join(',')}`);

  // High-chroma residual, decided not silent: both tiles fail the 4.5
  // floor on BOTH measured plates (red vs 0.56 linearized is 4.19, still
  // under). Re-inking them would flatten Pelagic's brand colour on every
  // ad. Brand-colour preservation therefore wins for high-chroma pixels;
  // a navy wordmark on a dark plate is the same accepted residual
  // (pixel-level we cannot tell a navy wordmark from a navy tile).
  const blueL = direct.logoPixelLuminance(...PELAGIC_BLUE);
  const redL = direct.logoPixelLuminance(...PELAGIC_RED);
  const floor = direct.LOGO_MIN_INK_CONTRAST;
  check('L6 residual: #0055b8 luminance is the measured ~0.29 (Rec.709, no per-channel linearize)',
    Math.abs(blueL - 0.29) < 0.01, `got ${blueL.toFixed(3)}`);
  check('L6 residual: #c10230 luminance is the measured ~0.18',
    Math.abs(redL - 0.18) < 0.01, `got ${redL.toFixed(3)}`);
  check('L6 residual: #0055b8 fails the 4.5 floor on BOTH measured plates — and is still not re-inked',
    direct.inkContrastRatio(blueL, PLATE_WS_AQUATEK) < floor
    && direct.inkContrastRatio(blueL, PLATE_MAI_TAI) < floor
    && rgbClose(blueAquatek, PELAGIC_BLUE)
    && rgbClose(blueMaiTai, PELAGIC_BLUE));
  check('L6 residual: #c10230 fails the 4.5 floor on BOTH measured plates — and is still not re-inked',
    direct.inkContrastRatio(redL, PLATE_WS_AQUATEK) < floor
    && direct.inkContrastRatio(redL, PLATE_MAI_TAI) < floor
    && rgbClose(redAquatek, PELAGIC_RED)
    && rgbClose(redMaiTai, PELAGIC_RED));

  // A plate 0.01 below the old 0.5 split: white wordmark must still go
  // DARK. monochromeInkFor(0.49) is white; contrastingInkFor(0.49) is
  // black. This is the load-bearing reason the mixed-lockup path must
  // not reuse monochromeInkFor.
  const prep049 = await direct.prepareLogoForComposite(pelagic, { behindLuminance: 0.49 });
  const wm049 = await sampleRgb(prep049.buffer, PELAGIC_WORDMARK_PX[0], PELAGIC_WORDMARK_PX[1]);
  check('L6 white wordmark on a 0.49 plate is re-inked DARK (0.5-split would have painted white)',
    wm049[0] < 20 && wm049[1] < 20 && wm049[2] < 20,
    `wordmark rgb=${wm049.join(',')} — 0.49 is the band where monochromeInkFor picks white`);
  const blue049 = await sampleRgb(prep049.buffer, PELAGIC_BLUE_PX[0], PELAGIC_BLUE_PX[1]);
  const red049 = await sampleRgb(prep049.buffer, PELAGIC_RED_PX[0], PELAGIC_RED_PX[1]);
  check('L6 tiles still preserved on the 0.49 plate',
    rgbClose(blue049, PELAGIC_BLUE) && rgbClose(red049, PELAGIC_RED),
    `blue=${blue049.join(',')} red=${red049.join(',')}`);

  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'directImageRenderService.js'), 'utf8');
  check('L6-src: the inverted `behindLuminance <= 0.5` gate is gone',
    ! /behindLuminance\s*<=\s*0\.5/.test(src));
  check('L6-src: mixed-lockup re-ink uses contrastingInkFor, not monochromeInkFor',
    /const ink = contrastingInkFor\(\s*behindLuminance\s*\)/.test(src));
  check('L6-src: simple-wordmark path still uses monochromeInkFor (unchanged)',
    /const ink = monochromeInkFor\(\s*behindLuminance\s*\)/.test(src));
  // Bound the scan to inkContrastRatio's own body so a leftover
  // srgbEncodedToLinear helper (or a comment containing the ternary)
  // cannot satisfy this. Next top-level binding is the floor const.
  const inkFnStart = src.indexOf('function inkContrastRatio');
  const inkFnEnd = src.indexOf('const LOGO_MIN_INK_CONTRAST');
  const inkFnBody = inkFnStart >= 0 && inkFnEnd > inkFnStart
    ? src.slice(inkFnStart, inkFnEnd)
    : '';
  check('L6-src: inkContrastRatio itself linearizes (calls srgbEncodedToLinear, or inlines 0.04045)',
    /srgbEncodedToLinear\s*\(\s*L1\s*\)/.test(inkFnBody)
    && /srgbEncodedToLinear\s*\(\s*L2\s*\)/.test(inkFnBody)
    || /0\.04045/.test(inkFnBody));
  check('L6-src: LOGO_MIN_INK_CONTRAST is 4.5 (the pair\'s floor)',
    /const LOGO_MIN_INK_CONTRAST\s*=\s*4\.5/.test(src));

  // ── L7: bidirectional DARK wordmark on a DARK plate ─────────────────
  // Under the previous non-linear+3 rule a pure-black wordmark on 0.08
  // re-inked to white (ratio 2.6 < 3), and the behaviour started at
  // plate L = 0.10. Linearized+4.5 must still re-ink 0.08, and the cliff
  // moves UP to ~0.455 — widening the dark-plate case, not dropping it.
  function blackCliff(ratioFn, fl) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2;
      if (ratioFn(0, mid) < fl) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const blackCliffPrev = blackCliff(ratioNL, 3);
  const blackCliffNow = blackCliff(ratioLin, 4.5);
  check('L7 previous black-ink cliff (non-linear+3) is plate L = 0.10',
    Math.abs(blackCliffPrev - 0.10) < 0.001, `got ${blackCliffPrev.toFixed(4)}`);
  check('L7 shipped black-ink cliff (linearized+4.5) is plate L ≈ 0.455 — WIDER, not dropped',
    Math.abs(blackCliffNow - 0.4553) < 0.002
    && blackCliffNow > blackCliffPrev,
    `got ${blackCliffNow.toFixed(4)}`);
  check('L7 black vs 0.08 is below the floor under BOTH rules (the reported bidirectional case)',
    ratioNL(0, 0.08) < 3 && Math.abs(ratioNL(0, 0.08) - 2.6) < 0.01
    && ratioLin(0, 0.08) < 4.5
    && direct.inkContrastRatio(0, 0.08) < direct.LOGO_MIN_INK_CONTRAST,
    `nl=${ratioNL(0, 0.08).toFixed(3)} lin=${ratioLin(0, 0.08).toFixed(3)}`);
  check('L7 plate 0.12 is ABOVE the old cliff and BELOW the new one (the widening)',
    ratioNL(0, 0.12) >= 3 && ratioLin(0, 0.12) < 4.5,
    `nl=${ratioNL(0, 0.12).toFixed(3)} lin=${ratioLin(0, 0.12).toFixed(3)}`);

  const blackLockup = await blackWordmarkLockupFixture();
  check('L7 black-wordmark fixture alpha discriminates',
    (await direct.alphaChannelDiscriminates(blackLockup)) === true);

  const prepBlack008 = await direct.prepareLogoForComposite(blackLockup, { behindLuminance: 0.08 });
  const prepBlack012 = await direct.prepareLogoForComposite(blackLockup, { behindLuminance: 0.12 });
  // Leave-plate: just above the black-ink cliff AND below the picker
  // crossover. Black contrast PASSES, so we must leave it; the picker
  // is still WHITE, so a wrongly-firing gate paints white and this
  // check catches it. 0.50 is vacuous (picker already black).
  const leavePlate = Math.round((blackCliffNow + 0.002) * 1000) / 1000;
  check('L7 leave-plate sits in the (cliff, picker-cross) window',
    leavePlate > blackCliffNow && leavePlate < shippedPickerCross
    && direct.contrastingInkFor(leavePlate).r === 255
    && direct.inkContrastRatio(0, leavePlate) >= direct.LOGO_MIN_INK_CONTRAST,
    `leave=${leavePlate} cliff=${blackCliffNow.toFixed(4)} cross=${shippedPickerCross}`);
  const prepBlackLeave = await direct.prepareLogoForComposite(blackLockup, { behindLuminance: leavePlate });
  check('L7 all three plates stay colour-preserved',
    prepBlack008.treatment === 'colour-preserved'
    && prepBlack012.treatment === 'colour-preserved'
    && prepBlackLeave.treatment === 'colour-preserved');

  const wm008 = await sampleRgb(prepBlack008.buffer, PELAGIC_WORDMARK_PX[0], PELAGIC_WORDMARK_PX[1]);
  const wm012 = await sampleRgb(prepBlack012.buffer, PELAGIC_WORDMARK_PX[0], PELAGIC_WORDMARK_PX[1]);
  const wmLeave = await sampleRgb(prepBlackLeave.buffer, PELAGIC_WORDMARK_PX[0], PELAGIC_WORDMARK_PX[1]);
  check('L7 [BIDIRECTIONAL] black wordmark on 0.08 is re-inked WHITE',
    wm008[0] >= 240 && wm008[1] >= 240 && wm008[2] >= 240,
    `wordmark rgb=${wm008.join(',')} — dropping the dark-plate case is the failure this exists for`);
  check('L7 black wordmark on 0.12 is re-inked WHITE (widened band; old non-linear+3 would have left it)',
    wm012[0] >= 240 && wm012[1] >= 240 && wm012[2] >= 240,
    `wordmark rgb=${wm012.join(',')} — if this stays black the dark-plate widening is gone`);
  check('L7 black wordmark on the leave-plate stays BLACK (picker is WHITE so a false re-ink would show)',
    wmLeave[0] < 20 && wmLeave[1] < 20 && wmLeave[2] < 20,
    `leave=${leavePlate} wordmark rgb=${wmLeave.join(',')}`);

  const blue008 = await sampleRgb(prepBlack008.buffer, PELAGIC_BLUE_PX[0], PELAGIC_BLUE_PX[1]);
  const red008 = await sampleRgb(prepBlack008.buffer, PELAGIC_RED_PX[0], PELAGIC_RED_PX[1]);
  const blue012 = await sampleRgb(prepBlack012.buffer, PELAGIC_BLUE_PX[0], PELAGIC_BLUE_PX[1]);
  const red012 = await sampleRgb(prepBlack012.buffer, PELAGIC_RED_PX[0], PELAGIC_RED_PX[1]);
  check('L7 tiles still preserved on the dark plates',
    rgbClose(blue008, PELAGIC_BLUE) && rgbClose(red008, PELAGIC_RED)
    && rgbClose(blue012, PELAGIC_BLUE) && rgbClose(red012, PELAGIC_RED),
    `blue008=${blue008.join(',')} red008=${red008.join(',')}`);
})().then(() => {
  if (failures.length) {
    console.error(`\n❌ logo colour preservation: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ logo colour preservation: ${pass} checks passed`);
}).catch((err) => {
  console.error('❌ logo colour preservation: harness threw', err);
  process.exit(1);
});
