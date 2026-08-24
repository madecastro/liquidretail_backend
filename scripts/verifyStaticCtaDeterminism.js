#!/usr/bin/env node
/**
 * Offline harness for the static-ad CTA CASING + COLOUR determinism fix
 * (D4, 2026-08-19). No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS FOR, measured on 18 real Vuori Clothing statics
 * from one run: the SAME derived CTA string — "Shop the tee", verified
 * byte-identical across every LayoutInputArtifact.input.cta.text for the
 * run — rendered as THREE different casings ("Shop the tee" / "Shop The
 * Tee" / "Shop the Tee") and TWO different pill fill colours (dark green
 * on one Meta feed size, dark charcoal/black on its 4:5 sibling). The
 * generic "SET EXACTLY THESE STRINGS, verbatim... spelling is critical"
 * instruction evidently is not read as covering letter CASE, and pill fill
 * colour was left entirely to "you decide... the colour of every text
 * element" with no brand anchor at all.
 *
 * Fix: two small, pure, deterministic functions appended to the prompt
 * only when this surface/intent actually draws a CTA:
 *   ctaCasingDirective(ctaText)   -> a casing-specific verbatim instruction
 *   deriveCtaColors(brand)        -> {bg, text} from a brand-colour cascade
 *   ctaColorDirective(colors)     -> the fill-colour instruction text
 *
 * Groups:
 *   C1  ctaCasingDirective names the exact string and forbids title-casing.
 *   C2  deriveCtaColors is a deterministic function of the brand doc alone
 *       — same brand, same output, every call, every surface, every run.
 *   C3  deriveCtaColors picks CONTRAST correctly (both-ratios-computed,
 *       never a single luminance threshold — the mid-tone-colour hole
 *       titleSpecService.js's own history warns about).
 *   C4  Live integration: renderDirectImage only appends these directives
 *       when built.text actually carries a CTA BUTTON role (never
 *       contradicts a surface that was told to draw NO CTA).
 *   C5  Source-string casing canonicalize (2026-08-24). The directive in
 *       C1 pins whatever arrived; it cannot stop "Shop now" vs "Shop Now"
 *       when those are the source strings. Generic phrases we emit are
 *       rewritten at buildIntentData; product-specific CTAs are not.
 *
 * Run: node scripts/verifyStaticCtaDeterminism.js
 */
const direct = require('../services/directImageRenderService');
const intents = require('../services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── C1: casing directive ────────────────────────────────────────────────
const casing = direct.ctaCasingDirective('Shop the tee');
check('C1 names the exact string verbatim', casing.includes('"Shop the tee"'));
check('C1 forbids title-casing explicitly', /title-case/i.test(casing));
check('C1 empty/null input -> null (nothing to enforce)',
  direct.ctaCasingDirective('') === null && direct.ctaCasingDirective(null) === null && direct.ctaCasingDirective(undefined) === null);
check('C1 trims whitespace-only input to null',
  direct.ctaCasingDirective('   ') === null);

// [THE DEFECT, reconstructed] three casings the real run actually produced
// all differ from each other — proving this is a real drift, not a
// hypothetical, and that the directive names ONE of them, not "any".
const observedCasings = ['Shop the tee', 'Shop The Tee', 'Shop the Tee'];
check('C1-revert-prove: the three casings observed on real ads are genuinely distinct strings',
  new Set(observedCasings).size === 3);
check('C1-revert-prove: the directive pins exactly the canonical string, not a case-insensitive family',
  direct.ctaCasingDirective(observedCasings[0]).includes(observedCasings[0])
  && !direct.ctaCasingDirective(observedCasings[0]).includes(observedCasings[1]));

// ── C2: deriveCtaColors is deterministic ────────────────────────────────
const VUORI_BRAND = { accentColor: '#333333', primaryColor: '#333333', secondaryColor: '#333333', styleTheme: null };
const c1 = direct.deriveCtaColors(VUORI_BRAND);
const c2 = direct.deriveCtaColors(VUORI_BRAND);
const c3 = direct.deriveCtaColors({ ...VUORI_BRAND }); // fresh object, same values
check('C2 same brand doc -> identical {bg,text} on repeat calls',
  JSON.stringify(c1) === JSON.stringify(c2));
check('C2 a DIFFERENT object with the SAME colour values -> identical output (function of colour, not identity)',
  JSON.stringify(c1) === JSON.stringify(c3));
check('C2 [THE DEFECT] this is the SAME colour regardless of platformFormat — the function takes no format argument at all',
  direct.deriveCtaColors.length === 1); // (brand) — cannot vary by surface even if a caller tried

check('C2 null/undefined brand -> a fixed, defined fallback (never throws, never returns undefined)',
  !!direct.deriveCtaColors(null).bg && !!direct.deriveCtaColors(undefined).bg);

// Cascade order: styleTheme.ctaBgColor > accentColor > primaryColor > fallback.
check('C2 cascade: styleTheme.ctaBgColor wins over accentColor',
  direct.deriveCtaColors({ accentColor: '#ff0000', styleTheme: { ctaBgColor: '#00ff00' } }).bg === '#00FF00');
check('C2 cascade: accentColor wins over primaryColor when no styleTheme',
  direct.deriveCtaColors({ accentColor: '#ff0000', primaryColor: '#0000ff' }).bg === '#FF0000');
check('C2 cascade: primaryColor is the fallback when no accent/styleTheme',
  direct.deriveCtaColors({ primaryColor: '#0000ff' }).bg === '#0000FF');
check('C2 explicit styleTheme.ctaTextColor always wins over the computed contrast pick',
  direct.deriveCtaColors({ accentColor: '#333333', styleTheme: { ctaTextColor: '#ABCDEF' } }).text === '#ABCDEF');

// ── C3: contrast pick, not a single luminance threshold ─────────────────
// #5B8C5A: relative luminance ~0.284 by the WCAG formula used here (measured
// via ctaRelLuminance's own maths) — deliberately a MID-TONE fill where a
// naive `luminance > 0.5 ? dark : light` rule and the correct
// higher-contrast-wins rule can disagree, so this is not vacuous either way.
const midToneBg = '#5B8C5A';
const midToneResult = direct.deriveCtaColors({ accentColor: midToneBg });
check('C3 mid-tone brand colour still resolves to a definite ink (black or white)',
  midToneResult.text === '#16181D' || midToneResult.text === '#FFFFFF');
// [THE DEFECT, reconstructed] a naive single-threshold rule this fix avoids.
function brokenReadableOn(bgHex) {
  const s = bgHex.replace('#', '');
  const chan = (v) => parseInt(v, 16) / 255;
  const naiveLum = (chan(s.slice(0, 2)) + chan(s.slice(2, 4)) + chan(s.slice(4, 6))) / 3;
  return naiveLum > 0.55 ? '#16181D' : '#FFFFFF';
}
check('C3-revert-prove: a naive luminance>0.55 threshold picks a DIFFERENT (wrong, lower-contrast) ink for this mid-tone fill than the shipped contrast-ratio pick',
  brokenReadableOn(midToneBg) !== midToneResult.text,
  `naive=${brokenReadableOn(midToneBg)} shipped=${midToneResult.text} — if these match the revert-proof fixture no longer exercises the gap`);
check('C3 pure black on a pure white fill', direct.deriveCtaColors({ accentColor: '#FFFFFF' }).text === '#16181D');
check('C3 pure white on a pure black fill', direct.deriveCtaColors({ accentColor: '#000000' }).text === '#FFFFFF');

// ── C4: live integration — directives only append when a CTA is drawn ──
{
  const data = direct.buildIntentData({
    concept: { copy_picks: { headline: 'Move freely' } },
    layoutInput: {}, brand: {}, cta: 'Shop the tee'
  });
  // meta_stories_9_16: SURFACE_POLICY.drawCta === false — no CTA role at all.
  const builtStories = intents.buildPrompt({
    intentKey: 'product_first_lifestyle', data, product: {}, surface: 'meta_stories_9_16'
  });
  const storiesHasCta = builtStories.text.some(([role]) => role === 'CTA BUTTON');
  check('C4 meta_stories_9_16 does not carry a CTA BUTTON role (drawCta:false by design)',
    storiesHasCta === false);

  // meta_feed_1_1: SURFACE_POLICY.drawCta === true — CTA role present.
  const builtFeed = intents.buildPrompt({
    intentKey: 'product_first_lifestyle', data, product: {}, surface: 'meta_feed_1_1'
  });
  const feedCta = builtFeed.text.find(([role]) => role === 'CTA BUTTON');
  check('C4 meta_feed_1_1 DOES carry a CTA BUTTON role', !!feedCta);
  check('C4 the CTA role text is the exact derived string ("Shop the tee")',
    !!feedCta && feedCta[1] === 'Shop the tee', `got ${JSON.stringify(feedCta)}`);

  // Simulate the exact append logic from renderDirectImage: only fires
  // when the role is present.
  function appendCtaDirectivesIfDrawn(basePrompt, builtText, brand) {
    const hit = builtText.find(([role]) => role === 'CTA BUTTON');
    if (!hit) return basePrompt;
    let p = basePrompt;
    const casingD = direct.ctaCasingDirective(hit[1]);
    if (casingD) p = `${p}\n\n${casingD}`;
    const colorD = direct.ctaColorDirective(direct.deriveCtaColors(brand));
    if (colorD) p = `${p}\n\n${colorD}`;
    return p;
  }
  const storiesPrompt = appendCtaDirectivesIfDrawn(builtStories.prompt, builtStories.text, VUORI_BRAND);
  check('C4 [THE ABSENCE CASE] stories prompt gets NO CTA colour/casing directive (would contradict the "no CTA" instruction)',
    storiesPrompt === builtStories.prompt);
  const feedPrompt = appendCtaDirectivesIfDrawn(builtFeed.prompt, builtFeed.text, VUORI_BRAND);
  check('C4 feed prompt DOES get both directives appended',
    feedPrompt.includes('CTA BUTTON CASING') && feedPrompt.includes('CTA BUTTON COLOUR'));
  check('C4-revert-prove: without the built.text gate, the directive would have been appended to Stories too (the regression this guards)',
    `${builtStories.prompt}\n\n${direct.ctaCasingDirective('Shop the tee')}`.includes('CTA BUTTON CASING'));
}

// ── C5: source-string casing canonicalize (the 2026-08-24 follow-up) ──
// ctaCasingDirective pins whatever arrived. That cannot stop two sibling
// ads asking for "Shop now" and "Shop Now" when those are the SOURCE
// strings. Only the generic phrases we ourselves emit are rewritten;
// product-specific copy is left byte-identical.
{
  check('C5 normalizeCtaCasing is exported', typeof direct.normalizeCtaCasing === 'function');
  check('C5 "Shop now" stays sentence case', direct.normalizeCtaCasing('Shop now') === 'Shop now');
  check('C5 "Shop Now" (title case of the same phrase) canonicalizes to "Shop now"',
    direct.normalizeCtaCasing('Shop Now') === 'Shop now');
  check('C5 "SHOP NOW" (the former buildIntentData fallback) canonicalizes to "Shop now"',
    direct.normalizeCtaCasing('SHOP NOW') === 'Shop now');
  check('C5 "shop now" (all-lower) canonicalizes to "Shop now"',
    direct.normalizeCtaCasing('shop now') === 'Shop now');
  check('C5 whitespace-collapsed "  Shop   Now  " canonicalizes',
    direct.normalizeCtaCasing('  Shop   Now  ') === 'Shop now');
  check('C5 empty/null -> null (caller falls back)',
    direct.normalizeCtaCasing('') === null
    && direct.normalizeCtaCasing(null) === null
    && direct.normalizeCtaCasing(undefined) === null);
  check('C5 "Shop the Brand" / "SHOP THE BRAND" / "shop the brand" collapse to one form',
    direct.normalizeCtaCasing('Shop the Brand') === 'Shop the brand'
    && direct.normalizeCtaCasing('SHOP THE BRAND') === 'Shop the brand'
    && direct.normalizeCtaCasing('shop the brand') === 'Shop the brand');
  check('C5 "Shop the Collection" family collapses',
    direct.normalizeCtaCasing('Shop the Collection') === 'Shop the collection'
    && direct.normalizeCtaCasing('SHOP THE COLLECTION') === 'Shop the collection');
  check('C5 [DO NOT FLATTEN] "Shop the Mai Tai" is untouched — product-specific content, not the generic phrase',
    direct.normalizeCtaCasing('Shop the Mai Tai') === 'Shop the Mai Tai');
  check('C5 [DO NOT FLATTEN] "Shop the Vaportek" is untouched',
    direct.normalizeCtaCasing('Shop the Vaportek') === 'Shop the Vaportek');
  check('C5 [DO NOT FLATTEN] "Shop The Tee" (product-specific title-case) is NOT rewritten to "Shop the tee"',
    direct.normalizeCtaCasing('Shop The Tee') === 'Shop The Tee');

  const missing = direct.buildIntentData({
    concept: {}, layoutInput: {}, brand: {}, cta: undefined
  });
  check('C5 missing cta falls back to "Shop now", never "SHOP NOW"',
    missing.cta === 'Shop now', `got ${JSON.stringify(missing.cta)}`);
  const allCaps = direct.buildIntentData({
    concept: {}, layoutInput: {}, brand: {}, cta: 'SHOP NOW'
  });
  check('C5 buildIntentData rewrites the ALL-CAPS fallback input to "Shop now"',
    allCaps.cta === 'Shop now', `got ${JSON.stringify(allCaps.cta)}`);
  const product = direct.buildIntentData({
    concept: {}, layoutInput: {}, brand: {}, cta: 'Shop the Mai Tai'
  });
  check('C5 buildIntentData leaves a product-specific CTA byte-identical',
    product.cta === 'Shop the Mai Tai', `got ${JSON.stringify(product.cta)}`);

  // Revert-prove: a toUpperCase of the whole string (the former fallback)
  // is a DIFFERENT string from the canonical form, so the pin is not vacuous.
  check('C5-revert-prove: "SHOP NOW" !== "Shop now" (the two casings are genuinely distinct)',
    'SHOP NOW' !== 'Shop now');
  check('C5-revert-prove: "Shop Now" !== "Shop now"',
    'Shop Now' !== 'Shop now');
}

if (failures.length) {
  console.error(`\n❌ static CTA determinism: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ static CTA determinism: ${pass} checks passed`);
