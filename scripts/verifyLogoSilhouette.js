#!/usr/bin/env node
/**
 * verifyLogoSilhouette.js — the composited logomark must be the MARK, never a
 * solid ink block. Offline: builds its own fixtures with sharp, no DB/network.
 *
 * THE DEFECT THIS EXISTS FOR (found on a delivered ad, 2026-08-11)
 * ----------------------------------------------------------------
 * `monochromeLogoBuffer` read the ALPHA channel as the mark's coverage whenever
 * `sharp.metadata().hasAlpha` was true. But "has an alpha channel" is not the
 * same question as "the alpha channel encodes the mark".
 *
 * MEASURED on the live Vuori brand logo (1108x179 RGBA): **100% of its alpha
 * pixels fall in the 204-254 band** — the asset's "transparent" background is
 * 80-100% opaque. Coverage came back opaque everywhere and the compositor
 * painted a SOLID INK RECTANGLE across the whole logo box: a black bar on light
 * plates, a white bar on dark ones. It shipped on Meta ads as well as PMax —
 * pre-existing, and visible on delivered creative.
 *
 * The luminance branch (used when there is no alpha at all) renders the very
 * same asset's wordmark correctly, so the fix is to require the alpha channel
 * to actually DISCRIMINATE before trusting it.
 *
 * REVERT-PROOF RECIPE (each must fail this harness):
 *   1. Make alphaChannelDiscriminates always return true  → A2/B2
 *   2. Drop the threshold to 0 (any transparent pixel counts) → A2
 *   3. Raise the threshold above 0.5 → A3 (real cut-outs stop using alpha)
 *   4. Restore `if (meta.hasAlpha)` as the branch condition → B2
 */
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
const svc = require(path.join(__dirname, '..', 'services', 'directImageRenderService'));

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; return; }
  failures.push(detail ? `${label} — ${detail}` : label);
};

// ── Fixtures ────────────────────────────────────────────────────────────
// (a) The broken shape: an alpha channel that exists but never approaches 0.
async function opaqueAlphaLogo() {
  const w = 300, h = 80;
  const base = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 245, g: 245, b: 245 } } })
    .composite([{
      input: await sharp({ create: { width: 160, height: 30, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer(),
      left: 70, top: 25
    }])
    .png().toBuffer();
  // Attach a uniformly near-opaque alpha channel (the real asset's signature).
  const alpha = Buffer.alloc(w * h, 235);
  return sharp(base).ensureAlpha().joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

// (b) A genuine cut-out: a solid mark surrounded by true transparency.
async function cutOutLogo() {
  return sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{
      input: await sharp({ create: { width: 90, height: 90, channels: 4, background: { r: 15, g: 15, b: 15, alpha: 1 } } }).png().toBuffer(),
      left: 55, top: 55
    }])
    .png().toBuffer();
}

(async () => {
  const opaque = await opaqueAlphaLogo();
  const cutout = await cutOutLogo();

  // ── A. the discriminator itself ───────────────────────────────────────
  check('A1 alphaChannelDiscriminates is exported',
    typeof svc.alphaChannelDiscriminates === 'function');

  check('A2 [THE DEFECT] a uniformly-opaque alpha channel is NOT trusted',
    (await svc.alphaChannelDiscriminates(opaque)) === false,
    'trusting it paints a solid ink block over the artwork');

  check('A3 [REGRESSION GUARD] a genuine cut-out IS still trusted',
    (await svc.alphaChannelDiscriminates(cutout)) === true,
    'sending a correctly cut-out logo down the luminance path would be a new bug');

  // ── B. end-to-end: the silhouette must not be a solid block ───────────
  const inkBlack = { r: 0, g: 0, b: 0 };

  // Read the ALPHA channel as channels[3] of the whole image. An earlier draft
  // used extractChannel(3).stats().channels[0] and reported "alpha max=0" for a
  // silhouette that was demonstrably correct — it was measuring the RED channel,
  // which is all zeros precisely because the ink is black. Measure the thing you
  // mean to measure.
  const alphaStats = async (buf) => (await sharp(buf).stats()).channels[3];

  const fromOpaque = await svc.monochromeLogoBuffer(opaque, inkBlack);
  check('B1 monochromeLogoBuffer returns a buffer for the opaque-alpha asset', !!fromOpaque);
  if (fromOpaque) {
    const st = await alphaStats(fromOpaque);
    // Threshold is "effectively transparent", not "exactly 0": the luminance
    // path maps a 245-white background to alpha 10 (96% transparent), which is
    // correct. What this check must exclude is the DEFECT — a block, where
    // every pixel is fully opaque.
    check('B2 [THE DEFECT] the result has REAL transparency (it is a mark, not a block)',
      st.min <= 32 && st.mean < 240,
      `alpha min=${st.min} mean=${st.mean.toFixed(1)} — a solid ink block is min=max=255`);
    check('B3 the mark itself is still drawn (not erased into nothing)',
      st.max >= 128, `alpha max=${st.max}`);
  }

  const fromCutout = await svc.monochromeLogoBuffer(cutout, inkBlack);
  if (fromCutout) {
    const st = await alphaStats(fromCutout);
    check('B4 a genuine cut-out still yields a real silhouette',
      st.min <= 8 && st.max >= 128,
      `alpha min=${st.min} max=${st.max}`);
  }

  // ── C. ink selection is unchanged (guards the shared path) ────────────
  check('C1 light plate -> black ink', JSON.stringify(svc.monochromeInkFor(0.9)) === JSON.stringify({ r: 0, g: 0, b: 0 }));
  check('C2 dark plate -> white ink', JSON.stringify(svc.monochromeInkFor(0.1)) === JSON.stringify({ r: 255, g: 255, b: 255 }));
  check('C3 unknown luminance -> null (caller keeps the original asset)', svc.monochromeInkFor('x') === null);

  const total = passed + failures.length;
  if (failures.length) {
    console.error(`\n❌ verifyLogoSilhouette: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
    for (const f of failures) console.error(`   • ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(`\n✅ verifyLogoSilhouette: ${passed} checks passed`);
  console.log('   a non-discriminating alpha channel can no longer paint a solid ink block\n');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
