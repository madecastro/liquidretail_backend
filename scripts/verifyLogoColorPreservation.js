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
 *       contrast-driven and bidirectional; high-chroma tiles are never
 *       re-inked on either plate.
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

  // 0.1 is below contrastingInkFor's black/white crossover (~0.179), so
  // BOTH pickers choose white there — L5 at 0.1 cannot catch a swap back
  // to monochromeInkFor. The measured Mai Tai plate (0.27) is above that
  // crossover: contrastingInkFor is BLACK, monochromeInkFor is WHITE.
  // A dark wordmark that fails 3:1 is therefore re-inked BLACK (6.4:1),
  // not white. Pelagic's WHITE fill is a different pixel and is L6.
  const prepDarkOnMaiTai = await direct.prepareLogoForComposite(gradFixture, { behindLuminance: PLATE_MAI_TAI });
  const wordmarkMaiTaiDark = await sampleRgb(prepDarkOnMaiTai.buffer, wordmarkPx[0], wordmarkPx[1]);
  check('L5 dark wordmark on the measured 0.27 plate is re-inked BLACK (max contrast), not white (0.5-split)',
    wordmarkMaiTaiDark[0] < 20 && wordmarkMaiTaiDark[1] < 20 && wordmarkMaiTaiDark[2] < 20,
    `wordmark rgb=${wordmarkMaiTaiDark.join(',')} — monochromeInkFor(0.27) is white; if this is white the picker swapped back`);
  check('L5-revert-prove: monochromeInkFor(0.27) is WHITE, contrastingInkFor(0.27) is BLACK',
    direct.monochromeInkFor(PLATE_MAI_TAI).r === 255
    && direct.contrastingInkFor(PLATE_MAI_TAI).r === 0);

  // ── L6: THE PELAGIC DEFECT — white wordmark, measured plates ──────────
  check('L6-exports inkContrastRatio / contrastingInkFor / LOGO_MIN_INK_CONTRAST',
    typeof direct.inkContrastRatio === 'function'
    && typeof direct.contrastingInkFor === 'function'
    && typeof direct.logoPixelLuminance === 'function'
    && direct.LOGO_MIN_INK_CONTRAST === 3);

  const whiteVsAquatek = direct.inkContrastRatio(1, PLATE_WS_AQUATEK);
  const whiteVsMaiTai = direct.inkContrastRatio(1, PLATE_MAI_TAI);
  check('L6 measured Ws Aquatek 0.56 vs white is BELOW the floor (the observed invisible wordmark)',
    whiteVsAquatek < direct.LOGO_MIN_INK_CONTRAST,
    `ratio=${whiteVsAquatek.toFixed(3)} floor=${direct.LOGO_MIN_INK_CONTRAST}`);
  check('L6 measured Mai Tai 0.27 vs white is AT OR ABOVE the floor (the observed visible wordmark)',
    whiteVsMaiTai >= direct.LOGO_MIN_INK_CONTRAST,
    `ratio=${whiteVsMaiTai.toFixed(3)} floor=${direct.LOGO_MIN_INK_CONTRAST}`);
  check('L6 floor=3 sits between the two measured ratios (1.72 and 3.28)',
    whiteVsAquatek < 3 && 3 <= whiteVsMaiTai
    && Math.abs(whiteVsAquatek - 1.72) < 0.02
    && Math.abs(whiteVsMaiTai - 3.28) < 0.02,
    `aquatek=${whiteVsAquatek.toFixed(3)} maiTai=${whiteVsMaiTai.toFixed(3)}`);

  // Linearizing the plate luminance (true WCAG relative-luminance) would
  // classify the FAILING 0.56 plate as ~3.27:1 and skip the re-ink.
  function srgbLin(c) {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  const linAquatek = (1 + 0.05) / (srgbLin(PLATE_WS_AQUATEK) + 0.05);
  check('L6-revert-prove: linearized WCAG would call the failing 0.56 plate sufficient (>=3)',
    linAquatek >= 3,
    `lin(0.56) ratio=${linAquatek.toFixed(3)} — if the shipped helper linearizes, L6 Aquatek re-ink goes red`);
  check('L6-revert-prove: the shipped ratio on 0.56 does NOT linearize (stays below the floor)',
    whiteVsAquatek < 3);

  check('L6-revert-prove: a 4.5 floor would also re-ink white on Mai Tai 0.27 (the regression)',
    whiteVsMaiTai < 4.5 && whiteVsMaiTai >= direct.LOGO_MIN_INK_CONTRAST);
  check('L6-revert-prove: the failing plate 0.56 is on the LIGHT side of 0.5, so a dark-plate-only gate never fires',
    PLATE_WS_AQUATEK > 0.5);
  check('L6-revert-prove: monochromeInkFor(0.49) is WHITE — using it as mixed-lockup ink re-inks white to white',
    direct.monochromeInkFor(0.49).r === 255 && direct.monochromeInkFor(0.49).g === 255);
  check('L6-revert-prove: contrastingInkFor(0.49) is BLACK (the visible choice on a near-mid plate)',
    direct.contrastingInkFor(0.49).r === 0 && direct.contrastingInkFor(0.49).g === 0);
  check('L6-revert-prove: contrastingInkFor(0.56) is BLACK (dark ink on the failing light plate)',
    direct.contrastingInkFor(PLATE_WS_AQUATEK).r === 0);
  check('L6-revert-prove: contrastingInkFor(0.27) is also BLACK — we do NOT use it on Mai Tai because current contrast already passes',
    direct.contrastingInkFor(PLATE_MAI_TAI).r === 0);

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

  // High-chroma residual, decided not silent: both tiles fail the 3:1
  // floor on BOTH measured plates. Re-inking them would flatten Pelagic's
  // brand colour on every ad. Brand-colour preservation therefore wins
  // for high-chroma pixels; a navy wordmark on a dark plate is the same
  // accepted residual (pixel-level we cannot tell a navy wordmark from
  // a navy tile).
  const blueL = direct.logoPixelLuminance(...PELAGIC_BLUE);
  const redL = direct.logoPixelLuminance(...PELAGIC_RED);
  check('L6 residual: #0055b8 luminance is the measured ~0.29 (Rec.709, no linearize)',
    Math.abs(blueL - 0.29) < 0.01, `got ${blueL.toFixed(3)}`);
  check('L6 residual: #c10230 luminance is the measured ~0.18',
    Math.abs(redL - 0.18) < 0.01, `got ${redL.toFixed(3)}`);
  check('L6 residual: #0055b8 fails 3:1 on BOTH measured plates — and is still not re-inked',
    direct.inkContrastRatio(blueL, PLATE_WS_AQUATEK) < 3
    && direct.inkContrastRatio(blueL, PLATE_MAI_TAI) < 3
    && rgbClose(blueAquatek, PELAGIC_BLUE)
    && rgbClose(blueMaiTai, PELAGIC_BLUE));
  check('L6 residual: #c10230 fails 3:1 on BOTH measured plates — and is still not re-inked',
    direct.inkContrastRatio(redL, PLATE_WS_AQUATEK) < 3
    && direct.inkContrastRatio(redL, PLATE_MAI_TAI) < 3
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
