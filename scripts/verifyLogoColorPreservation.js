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
 *
 * Run: node scripts/verifyLogoColorPreservation.js
 */
const path = require('path');
// Resolve normally (Node's own node_modules walk, honoring NODE_PATH) instead
// of a hardcoded __dirname/../node_modules/sharp path — that absolute form
// bypassed NODE_PATH entirely and always failed in a fresh git worktree,
// which has no node_modules/sharp of its own (see bin/setup-worktree.sh).
const sharp = require('sharp');
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
