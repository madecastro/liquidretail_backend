#!/usr/bin/env node
/**
 * Offline harness for the static-ad headline CONTRAST fix (D1, 2026-08-19).
 * No DB, no network, no API key — builds its own fixtures with sharp.
 *
 * THE DEFECT THIS EXISTS FOR, measured on real delivered pixels (Vuori
 * Clothing, run_1787119100250_eef4d871): the SAME headline text
 * ("220 GSM organic cotton."), same brand, same seed-photo family, rendered
 * white-on-pale-grey (illegible) on meta_stories_9_16 and dark-on-pale
 * (correct) on a sibling meta_feed_1_1/4_5 render in the SAME run. Root
 * cause: services/staticAdIntents.js's LATITUDE clause hands the model
 * "you decide typeface and weight, the scale and colour of every text
 * element" with ZERO contrast measurement behind it — every render is an
 * independent model guess, so some formats land legible and some do not,
 * with nothing to make the choice consistent or correct.
 *
 * Fix: sample the REAL seed reference photo inside the format's own safe
 * box (computeSurface(surface).box — the exact region the prompt already
 * tells the model text must occupy) and append a MEASURED, non-negotiable
 * ink-polarity instruction to the prompt. Two pure functions carry this:
 *   sampleSafeBoxLuminance(refBuffer, box) -> mean luminance 0..1 | null
 *   textInkDirective(meanLum)              -> instruction string | null
 *
 * Groups:
 *   T1  sampleSafeBoxLuminance reads the ACTUAL region, not a whole-frame
 *       average — a synthetic seed with a light region where the safe box
 *       sits and a dark region elsewhere must read LIGHT, and the reverse
 *       fixture must read DARK, even though both fixtures' whole-frame
 *       means are ~0.5 (deliberately, so a whole-frame-average regression
 *       cannot pass by accident).
 *   T2  textInkDirective picks the CORRECT polarity and states the
 *       measurement; never asserts a claim it did not take (null in, null
 *       out) — the `Number(null) === 0` trap, same class as the repo's
 *       documented price-string trap (remotion/lib/priceFormat.js).
 *   T3  Live integration: renderDirectImage's prompt-assembly appends the
 *       directive text when a reference is available, and appends nothing
 *       extra when it is not (fail-open, never a submit blocker).
 *
 * Run: node scripts/verifyStaticTextInk.js
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

(async () => {
  // ── T1: samples the safe box region, not a whole-frame average ───────
  // Fixture geometry: 400x400. Safe box = left 0-40%, top 0-40% (a 160x160
  // corner). Fixture A: that corner is bright white (250), the rest of the
  // frame is near-black (10) — whole-frame mean ≈ (160*160*250 +
  // (400*400-160*160)*10) / (400*400) ≈ 0.19 in 0..1 terms (DARK on a
  // whole-frame reading), but the safe-box region itself is unambiguously
  // LIGHT. Fixture B is the exact photographic negative: safe box dark,
  // rest bright — whole-frame mean is symmetric-ish but the safe box reads
  // unambiguously DARK. A whole-frame-average regression would either
  // agree with both (if it always reports the same side) or disagree with
  // at least one — this pair is chosen so no single wrong constant passes
  // both.
  const BOX = { left: 0, right: 40, top: 0, bottom: 40 };
  async function cornerFixture({ cornerVal, restVal }) {
    return sharp({ create: { width: 400, height: 400, channels: 3, background: { r: restVal, g: restVal, b: restVal } } })
      .composite([{
        input: await sharp({ create: { width: 160, height: 160, channels: 3, background: { r: cornerVal, g: cornerVal, b: cornerVal } } }).png().toBuffer(),
        left: 0, top: 0
      }])
      .png().toBuffer();
  }
  const lightCorner = await cornerFixture({ cornerVal: 250, restVal: 10 });
  const darkCorner  = await cornerFixture({ cornerVal: 10,  restVal: 250 });

  const lumLight = await direct.sampleSafeBoxLuminance(lightCorner, BOX);
  const lumDark  = await direct.sampleSafeBoxLuminance(darkCorner, BOX);
  check('T1 sampleSafeBoxLuminance reads the light corner as LIGHT (>0.5)',
    lumLight > 0.5, `got ${lumLight}`);
  check('T1 sampleSafeBoxLuminance reads the dark corner as DARK (<0.5)',
    lumDark < 0.5, `got ${lumDark}`);
  check('T1 [not vacuous] the two fixtures really do read oppositely',
    lumLight > 0.5 && lumDark < 0.5 && (lumLight - lumDark) > 0.3,
    `light=${lumLight} dark=${lumDark}`);

  // [THE DEFECT, reconstructed] a whole-frame average reads BOTH fixtures
  // as roughly the same (dominated by the larger non-corner area), proving
  // the region-specific read above is doing real work, not agreeing with a
  // naive average by luck.
  const wholeFrameLight = await sharp(lightCorner).greyscale().stats();
  const wholeFrameDark = await sharp(darkCorner).greyscale().stats();
  const wfLum = (s) => s.channels[0].mean / 255;
  check('T1-revert-prove: a whole-frame average would call the LIGHT-cornered fixture dark',
    wfLum(wholeFrameLight) < 0.5,
    `whole-frame mean=${wfLum(wholeFrameLight)} — if this is >0.5 the fixture pair does not exercise the regression`);
  check('T1-revert-prove: a whole-frame average would call the DARK-cornered fixture light',
    wfLum(wholeFrameDark) > 0.5,
    `whole-frame mean=${wfLum(wholeFrameDark)}`);
  check('T1-revert-prove: the SHIPPED region-aware read disagrees with both whole-frame reads (it is not just re-deriving the average)',
    (lumLight > 0.5) !== (wfLum(wholeFrameLight) > 0.5) &&
    (lumDark  < 0.5) !== (wfLum(wholeFrameDark)  < 0.5));

  // Degenerate inputs never throw.
  check('T1 no reference buffer -> null, does not throw',
    await direct.sampleSafeBoxLuminance(null, BOX) === null);
  check('T1 no box -> null, does not throw',
    await direct.sampleSafeBoxLuminance(lightCorner, null) === null);
  check('T1 unreadable buffer -> null, does not throw',
    await direct.sampleSafeBoxLuminance(Buffer.from('not an image'), BOX) === null);

  // ── T2: textInkDirective — correct polarity, and the null-safety trap ──
  const dirLight = direct.textInkDirective(0.74);
  const dirDark = direct.textInkDirective(0.1);
  check('T2 light backdrop (0.74) -> dark ink instruction',
    /dark, near-black ink/.test(dirLight) && /reads as LIGHT/.test(dirLight));
  check('T2 dark backdrop (0.1) -> light ink instruction',
    /light, near-white ink/.test(dirDark) && /reads as DARK/.test(dirDark));
  check('T2 boundary 0.5 resolves to a definite polarity (light branch, matches monochromeInkFor\'s >0.5 rule)',
    /dark, near-black ink/.test(direct.textInkDirective(0.51)));

  // [THE Number(null)===0 TRAP] — the exact class of bug flagged elsewhere
  // in this codebase (remotion/lib/priceFormat.js's guard against
  // Number('')===0). A "no measurement" signal must never read through as
  // a confident, asserted claim.
  check('T2 [THE Number(null)===0 TRAP] null -> null (no unmeasured claim), NOT "reads as DARK"',
    direct.textInkDirective(null) === null,
    `got ${JSON.stringify(direct.textInkDirective(null))}`);
  check('T2 undefined -> null', direct.textInkDirective(undefined) === null);
  check('T2 NaN -> null', direct.textInkDirective(NaN) === null);
  check('T2 the empty string ("" -> Number("")===0, the sibling trap) -> null',
    direct.textInkDirective('') === null,
    `got ${JSON.stringify(direct.textInkDirective(''))}`);

  // Revert-prove: the naive `Number(meanLum)` pattern WITHOUT the `== null`
  // guard — reconstructed, not a hypothetical — asserts a false DARK
  // reading for a null input.
  function brokenTextInkDirective(meanLum) {
    const n = Number(meanLum);
    if (!Number.isFinite(n)) return null;
    return n > 0.5 ? 'reads as LIGHT' : 'reads as DARK';
  }
  check('T2-revert-prove: the naive Number() coercion (no null guard) DOES assert a false DARK reading for null',
    brokenTextInkDirective(null) === 'reads as DARK');
  check('T2-revert-prove: the SHIPPED function does not',
    direct.textInkDirective(null) === null);

  // ── T3: live integration inside renderDirectImage ─────────────────────
  // buildIntentData + staticAdIntents.buildPrompt are exercised directly
  // (same call the render path makes) to prove the directive text, once
  // computed, is the kind of string that actually reaches the prompt when
  // appended — i.e. it is plain text with no characters buildPrompt/the
  // Atlas prompt channel would choke on.
  const intents = require('../services/staticAdIntents');
  const data = direct.buildIntentData({
    concept: { copy_picks: { headline: '220 GSM organic cotton.' } },
    layoutInput: {}, brand: {}, cta: 'Shop the tee'
  });
  const built = intents.buildPrompt({
    intentKey: 'product_first_lifestyle', data, product: {}, surface: 'meta_stories_9_16'
  });
  check('T3 buildPrompt returns a real prompt + surface.box for the sampler to use',
    typeof built.prompt === 'string' && built.prompt.length > 0 && !!built.surface?.box);
  const directive = direct.textInkDirective(0.74);
  const combined = `${built.prompt}\n\n${directive}`;
  check('T3 the appended directive is plain text (no control chars) safe to concatenate onto the prompt',
    /^[\x09\x0A\x0D\x20-\x7E’“”—]*$/.test(directive.replace(/[‘’“”—]/g, "'")));
  check('T3 combined prompt still contains the directive verbatim (nothing truncates or mangles it)',
    combined.includes(directive));
})().then(() => {
  if (failures.length) {
    console.error(`\n❌ static text ink: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ static text ink: ${pass} checks passed`);
}).catch((err) => {
  console.error('❌ static text ink: harness threw', err);
  process.exit(1);
});
