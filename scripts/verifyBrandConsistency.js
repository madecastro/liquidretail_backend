#!/usr/bin/env node
/**
 * verifyBrandConsistency.js — three brand-consistency defects measured on
 * one Pelagic Gear static batch (run_1787561664355_17096cc2, 27 delivered
 * ads, same brand / run / campaign). Offline: no DB, no network, no key.
 *
 * DEFECT 1 — "5 ★" reads as a broken rating widget.
 *   DIAGNOSIS: compose bug, not model non-compliance and not an
 *   intentional compact-badge choice at 5.0. formatDisplayRating did
 *   `String(Number(raw.toFixed(1)))`, which drops the trailing zero on a
 *   perfect 5 → "5". staticAdIntents then asks the image model for
 *   `${rating} ★` = "5 ★". The compact "X ★" form (and the explicit
 *   forbid of a five-star glyph row) is intentional — two of five test
 *   renders drew a 4.5-star graphic next to a 4.8 score. Do NOT add
 *   ★★★★★ to the requested string. The fix is the decimal.
 *
 * DEFECT 2 — CTA casing drifts inside one batch ("Shop now" / "Shop Now").
 *   DIAGNOSIS: nothing at render time normalised casing. ctaCasingDirective
 *   pins whatever arrived, so two source casings stay two requested
 *   strings. "Shop the Mai Tai" vs "Shop now" is content variety and is
 *   left alone. Covered in detail by verifyStaticCtaDeterminism.js C5;
 *   this file pins the rating compose + the logo box + the intent-scoped
 *   star-row policy so the three defects have one named home.
 *
 * DEFECT 3 — logo lockup differs between ads (wordmark+tiles vs tiles only).
 *   DIAGNOSIS: the mark IS composited by Sharp from Brand.logoUrl, not
 *   generated. Two contained causes from one asset:
 *     (a) resize box was width × 0.35·width — a stacked lockup was crushed
 *         to ~60px tall on 1080, wordmark illegible;
 *     (b) CORRECTED 2026-08-24: Pelagic's wordmark is WHITE (#ffffff), not
 *         dark. It vanishes on a LIGHT plate (Ws Aquatek behind-logo
 *         luminance 0.56) and is clearly present on a DARK plate (Mai Tai
 *         0.27). Colour-preserve kept the white pixels, which is right on
 *         0.27 and invisible on 0.56. Re-ink is contrast-driven and
 *         bidirectional; high-chroma tiles (#0055b8 / #c10230) are never
 *         re-inked. Pinned by verifyLogoColorPreservation.js L6.
 *   Model-drawn logos (prompt non-compliance) remain possible and are
 *   NOT a config fix — see the session write-up. (a)+(b) are.
 *
 * REVERT-PROOF RECIPE (each must fail this harness):
 *   1. restore `return String(displayed)` in formatDisplayRating     → R1
 *   2. drop toFixed(1) / emit "5" for a perfect 5                     → R1 / R2
 *   3. restore height: Math.round(boxW * 0.35) in the logo resize     → L1
 *   4. restore the old "no star row" BAN on social_proof_led          → S1 / S1c
 *      (quiet TRUST MARK path must keep the fence — S1d)
 *
 * Run: node scripts/verifyBrandConsistency.js
 */
'use strict';

const rd = require('../src/services/ratingDisplay');
const direct = require('../src/services/directImageRenderService');
const intents = require('../src/services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('verifyBrandConsistency\n');

// ── R. rating display is always one decimal ────────────────────────────
check('R0 formatDisplayRating is exported', typeof rd.formatDisplayRating === 'function');
check('R1 [THE DEFECT] a perfect 5 displays as "5.0", never the integer "5"',
  rd.formatDisplayRating(5) === '5.0',
  `got ${JSON.stringify(rd.formatDisplayRating(5))}`);
check('R1b 5.0 raw also displays as "5.0"',
  rd.formatDisplayRating(5.0) === '5.0');
check('R1c 4.96 rounds to "5.0" (still one decimal, still not "5")',
  rd.formatDisplayRating(4.96) === '5.0');
check('R2 4.8 is unchanged ("4.8", already had a decimal)',
  rd.formatDisplayRating(4.8) === '4.8');
check('R3 the floor/withhold contract is unchanged (4.3 still withheld)',
  rd.formatDisplayRating(4.3) === undefined);
check('R3b a displayed 4.4 still prints',
  rd.formatDisplayRating(4.4) === '4.4');

// Revert-prove: the pre-fix expression is the JS Number-stringify trap.
check('R1-revert-prove: String(Number((5).toFixed(1))) === "5" (the pre-fix bug)',
  String(Number((5).toFixed(1))) === '5');
check('R1-revert-prove: the shipped helper does not equal that expression',
  rd.formatDisplayRating(5) !== String(Number((5).toFixed(1))));

// The compact "X ★" form is what the model is ASKED to typeset. With the
// decimal fixed, a 5.0 rating becomes "5.0 ★" not "5 ★".
{
  const data = { rating: rd.formatDisplayRating(5), cta: 'Shop now' };
  const built = intents.buildPrompt({
    intentKey: 'social_proof_led', data, product: {}, surface: 'meta_feed_1_1'
  });
  const hit = (built.text || []).find(([role]) => role === 'RATING');
  check('R4 social_proof_led asks for "5.0 ★", not "5 ★"',
    !!hit && hit[1] === '5.0 ★',
    `got ${JSON.stringify(hit)}`);
  check('R4 the requested string is NOT the broken "5 ★" widget',
    !!hit && hit[1] !== '5 ★');

  const lifestyle = intents.buildPrompt({
    intentKey: 'product_first_lifestyle',
    data: { rating: rd.formatDisplayRating(5), headline: 'Go offshore.', cta: 'Shop now' },
    product: {}, surface: 'meta_feed_1_1'
  });
  const trust = (lifestyle.text || []).find(([role]) => role === 'TRUST MARK');
  check('R5 product_first_lifestyle TRUST MARK is "5.0 ★"',
    !!trust && trust[1] === '5.0 ★',
    `got ${JSON.stringify(trust)}`);

  const brandLed = intents.buildPrompt({
    intentKey: 'brand_led',
    data: { rating: rd.formatDisplayRating(5), headline: 'Go offshore.', cta: 'Shop now' },
    product: {}, surface: 'meta_feed_1_1'
  });
  const trust2 = (brandLed.text || []).find(([role]) => role === 'TRUST MARK');
  check('R6 brand_led TRUST MARK is "5.0 ★"',
    !!trust2 && trust2[1] === '5.0 ★',
    `got ${JSON.stringify(trust2)}`);
}

// ── S. star-row policy is INTENT-SCOPED (revised 2026-08-24)
// The original S1 forbade a five-star graphic on social_proof_led because
// 2/5 test renders drew 4.5 stars next to a 4.8. That fence is what let
// gpt-image-2 paraphrase the RATING string into a headline (Soludos /
// Pelagic, no widget on frame). social_proof_led's core IS the rating, so
// it now demands a matching star-glyph widget and names the 4.8→half-star
// snap as a failure. Quiet TRUST MARK intents (brand_led,
// product_first_lifestyle) keep the original fence.
{
  const proof = intents.buildPrompt({
    intentKey: 'social_proof_led',
    data: { rating: '5.0', reviewCount: 12, reviewsText: '12 reviews', cta: 'Shop now' },
    product: {}, surface: 'meta_feed_1_1'
  });
  check('S1 social_proof_led demands a matching star-glyph widget, not a sentence',
    /review widget/i.test(proof.prompt || '') && /star glyphs/i.test(proof.prompt || ''),
    'core IS the rating — a prose headline cannot satisfy the demand');
  check('S1b social_proof_led still names the 4.8→half-star snap',
    /do not snap 4\.8 to a half-star/i.test(proof.prompt || ''));
  check('S1c social_proof_led no longer carries the old star-row BAN',
    !/no star row, five-star graphic/i.test(proof.prompt || ''));

  const quiet = intents.buildPrompt({
    intentKey: 'product_first_lifestyle',
    data: { rating: '4.8', headline: 'Walk lighter.', cta: 'Shop now' },
    product: {}, surface: 'meta_feed_1_1'
  });
  check('S1d quiet TRUST MARK path still forbids a five-star graphic',
    /no star row, five-star graphic/i.test(quiet.prompt || ''),
    'measured: the model drew 4.5 stars next to a 4.8 on this path');
}

// ── L. logo resize box is square; the 0.35-height crush is gone ────────
{
  check('L0 logoResizeBox / LOGO_BOX_FRAC are exported',
    typeof direct.logoResizeBox === 'function' && typeof direct.LOGO_BOX_FRAC === 'number');
  const box = direct.logoResizeBox({ width: 1080, height: 1080 });
  check('L1 [THE DEFECT] the production box on a 1080 square is itself square, not 0.35-tall',
    box.width === box.height && box.width === Math.round(direct.LOGO_BOX_FRAC * 1080),
    `got ${box.width}x${box.height}`);
  const oldH = Math.round(box.width * 0.35);
  check('L1-revert-prove: the pre-fix height (0.35 × width) is a DIFFERENT, shorter box',
    oldH !== box.height && oldH < box.height,
    `oldH=${oldH} newH=${box.height} — if these match the square box is a no-op`);
  check('L2 a WIDE wordmark still binds on width (fit:inside into a square): the box does not force a tall mark',
    box.width === box.height);
  const portrait = direct.logoResizeBox({ width: 1080, height: 1920 });
  check('L3 portrait 9:16 uses the SHORT edge, same physical size as square',
    portrait.width === box.width && portrait.height === box.height);
  const landscape = direct.logoResizeBox({ width: 1200, height: 628 });
  check('L4 landscape uses the short edge (height), not 0.16 of width',
    landscape.width === Math.round(direct.LOGO_BOX_FRAC * 628)
    && landscape.width === landscape.height);

  // Source pin: finishPlate must call logoResizeBox (or the 0.16/square
  // constants) — a re-introduction of `boxW * 0.35` in the resize is the
  // stacked-lockup crush coming back.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'directImageRenderService.js'), 'utf8');
  check('L5-src finishPlate resizes via logoResizeBox, not a 0.35-tall box',
    /logoResizeBox\s*\(\s*dims\s*\)/.test(src)
    && ! /\.resize\(\s*\{\s*width:\s*boxW\s*,\s*height:\s*Math\.round\(\s*boxW\s*\*\s*0\.35\)/.test(src),
    'the 0.35-height resize is back in finishPlate');
}

if (failures.length) {
  console.error(`\n❌ brand consistency: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ brand consistency: ${pass} checks passed`);
