#!/usr/bin/env node
/**
 * Offline harness for the static-ad headline TYPEFACE fix (D1, 2026-08-19).
 * No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS FOR, measured on real delivered pixels (Vuori
 * Clothing, run_1787119100250_eef4d871, product 6a6624fe5f5af85a46562e38):
 * the SAME brand, SAME run, SAME rendered headline text rendered SERIF on
 * four of six surfaces and SANS on two, with three different headline
 * colours on top (the colour half is D2/textInkDirective, already fixed
 * and covered by verifyStaticTextInk.js — this file is the TYPEFACE FAMILY
 * axis, which is separate: a headline can be measurably legible and still
 * be off-brand because it is the wrong FONT ROLE, not the wrong ink).
 *
 * Root cause: services/staticAdIntents.js's LATITUDE clause hands every
 * static render "you decide typeface and weight" with ZERO typography
 * guidance, and each of a run's six surfaces is an INDEPENDENT gpt-image-2
 * submit with no shared state — nothing keeps six independent model guesses
 * agreeing with each other, let alone with the brand's own real typeface
 * (Vuori's ingested "aktiv-grotesk", verified live: 3 weights on Cloudinary,
 * all HTTP 200 / valid wOF2 magic — the font LOADS fine, this was pure
 * role-selection, not a loading failure).
 *
 * Fix: derive ONE deterministic typeface directive per BRAND (not per
 * concept or surface — see typefaceDirectiveForBrand's header for why
 * brand-level is the right scope) from Brand.customFonts /
 * websiteFontUsage.heading, classify serif/sans with the same heuristic
 * services/fontResolverService.js uses for the video titling path, and
 * assert it into every surface's prompt identically.
 *
 * Groups:
 *   U1  an ingested SANS custom font (Vuori's real data shape) names the
 *       family and asserts sans-serif, not serif.
 *   U2  an ingested SERIF custom font asserts serif, not sans.
 *   U3  no font data at all still returns ONE deterministic instruction
 *       (never null — a silently-skipped directive would restore the
 *       exact "six independent guesses" defect this fix closes).
 *   U4  determinism: same brand in -> byte-identical string out, called
 *       twice, and regardless of any surface/concept context (the function
 *       takes no such argument at all — a brand-level fix cannot vary by
 *       either).
 *   U5  the serif/sans classification AGREES with
 *       services/fontResolverService.js's own `fallbackFor` on the same
 *       family names — the two are independently duplicated (CJS video
 *       resolver vs this CommonJS-but-must-not-import-it static path) and
 *       must not silently diverge on which families count as serif.
 *   U6  humanizeFontFamily turns an ingested slug into a readable name.
 *   U7  live integration: renderDirectImage's prompt-assembly branch calls
 *       typefaceDirectiveForBrand and appends its result onto the prompt.
 *   U8  revert-prove: reconstruct the pre-fix prompt path (LATITUDE clause
 *       only, no typeface directive ever appended) and show it carries no
 *       typeface guidance at all, while the shipped path does.
 *
 * Run: node scripts/verifyStaticTypefaceDeterminism.js
 */
const direct = require('../services/directImageRenderService');
const fontResolver = require('../services/fontResolverService');
const intents = require('../services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── U1: real-shape Vuori data — ingested SANS custom font ────────────────
const VUORI_BRAND = {
  websiteFontUsage: { heading: 'aktiv-grotesk', body: 'aktiv-grotesk', button: null },
  customFonts: [
    { family: 'aktiv-grotesk', weight: 400, url: 'https://res.cloudinary.com/.../aktiv-grotesk-400.woff2' },
    { family: 'aktiv-grotesk', weight: 300, url: 'https://res.cloudinary.com/.../aktiv-grotesk-300.woff2' },
    { family: 'aktiv-grotesk', weight: 500, url: 'https://res.cloudinary.com/.../aktiv-grotesk-500.woff2' }
  ]
};
{
  const line = direct.typefaceDirectiveForBrand(VUORI_BRAND);
  check('U1 real Vuori brand data returns a directive', typeof line === 'string' && line.length > 0);
  check('U1 names the brand\'s own family (humanized)', /Aktiv Grotesk/.test(line), line);
  check('U1 asserts sans-serif, not serif', /\bsans-serif\b/i.test(line) && !/\ba serif\b/i.test(line), line);
  check('U1 states it is FIXED, not a style choice (same rhetorical pattern as CTA/ink directives)',
    /FIXED, NOT A STYLE CHOICE/.test(line));
  check('U1 forbids switching families across surfaces',
    /SAME typeface family/.test(line));
}

// ── U2: an ingested SERIF custom font ─────────────────────────────────────
{
  const line = direct.typefaceDirectiveForBrand({
    websiteFontUsage: { heading: 'Playfair Display' },
    customFonts: [{ family: 'Playfair Display', weight: 700 }]
  });
  check('U2 names Playfair Display', /Playfair Display/.test(line), line);
  check('U2 asserts serif', /\ba serif\b/i.test(line), line);
  check('U2 does not also claim sans-serif', !/\bsans-serif\b/i.test(line), line);
}

// ── U3: no font data at all still returns ONE deterministic instruction ──
{
  const bare = direct.typefaceDirectiveForBrand({});
  const nullBrand = direct.typefaceDirectiveForBrand(null);
  const undefinedBrand = direct.typefaceDirectiveForBrand(undefined);
  check('U3 [THE DEFECT-CLASS TRAP] empty brand object still returns a directive (never null/skip)',
    typeof bare === 'string' && bare.length > 0, `got ${JSON.stringify(bare)}`);
  check('U3 null brand still returns a directive', typeof nullBrand === 'string' && nullBrand.length > 0);
  check('U3 undefined brand still returns a directive', typeof undefinedBrand === 'string' && undefinedBrand.length > 0);
  check('U3 the three no-data shapes all return the SAME fallback text (one deterministic answer)',
    bare === nullBrand && nullBrand === undefinedBrand);
  check('U3 the fallback picks sans-serif (the stated default)', /sans-serif/i.test(bare));
}

// ── U4: determinism — same brand in, byte-identical string out ───────────
{
  const a = direct.typefaceDirectiveForBrand(VUORI_BRAND);
  const b = direct.typefaceDirectiveForBrand(VUORI_BRAND);
  check('U4 calling twice with the same brand yields byte-identical output', a === b);
  check('U4 the function signature takes no surface/concept argument at all (brand-level by construction)',
    direct.typefaceDirectiveForBrand.length === 1,
    `arity=${direct.typefaceDirectiveForBrand.length}`);
}

// ── U5: serif/sans classification agrees with fontResolverService's own ──
// (independently duplicated on purpose — see typefaceDirectiveForBrand's
// header — but the two heuristics must not silently disagree on the same
// family name, or one pipeline's "brand voice" contradicts the other's.)
for (const family of [
  'aktiv-grotesk', 'Inter', 'Helvetica Neue', 'Playfair Display', 'Lora',
  'Cormorant Garamond', 'Georgia', 'Futura', 'Arial', 'Montserrat',
  'Merriweather', 'Roboto'
]) {
  const oursIsSerif = direct.FONT_SERIF_HINTS.test(family);
  const resolverFallback = fontResolver.fallbackFor(family); // 'serif' | 'sans-serif'
  check(`U5 "${family}" classification agrees with fontResolverService.fallbackFor`,
    (oursIsSerif ? 'serif' : 'sans-serif') === resolverFallback,
    `ours=${oursIsSerif ? 'serif' : 'sans-serif'} resolver=${resolverFallback}`);
}

// ── U6: humanizeFontFamily ─────────────────────────────────────────────
check('U6 hyphenated slug -> Title Case with spaces',
  direct.humanizeFontFamily('aktiv-grotesk') === 'Aktiv Grotesk',
  `got ${JSON.stringify(direct.humanizeFontFamily('aktiv-grotesk'))}`);
check('U6 already-titled family passes through unchanged',
  direct.humanizeFontFamily('Playfair Display') === 'Playfair Display');
check('U6 underscores also normalise', direct.humanizeFontFamily('eb_garamond') === 'Eb Garamond');
check('U6 empty/null -> empty string, never throws',
  direct.humanizeFontFamily(null) === '' && direct.humanizeFontFamily('') === '');

// ── Fallback-cascade shape: heading names a family absent from customFonts,
// and customFonts present but heading absent — both real, distinct shapes
// seen in Brand documents (websiteFontUsage vs customFonts are written by
// two different ingest steps and can disagree or be partially populated).
{
  const headingOnly = direct.typefaceDirectiveForBrand({
    websiteFontUsage: { heading: 'brand-sans' }, customFonts: []
  });
  check('U falls back to websiteFontUsage.heading\'s name when no customFonts entry matches it',
    /Brand Sans/.test(headingOnly), headingOnly);

  const customFontsOnlyNoHeadingMatch = direct.typefaceDirectiveForBrand({
    websiteFontUsage: { heading: 'some-other-name' },
    customFonts: [{ family: 'shop-sans', weight: 400 }]
  });
  check('U falls back to the first customFonts entry when heading names nothing ingested',
    /Shop Sans/.test(customFontsOnlyNoHeadingMatch), customFontsOnlyNoHeadingMatch);
}

// ── U7: live integration inside renderDirectImage's prompt assembly ──────
const svcSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../services/directImageRenderService.js'), 'utf8'
);
check('U7 renderDirectImage calls typefaceDirectiveForBrand(resolvedBrand) in the built.prompt branch',
  /typefaceDirectiveForBrand\(resolvedBrand\)/.test(svcSrc));
check('U7 the directive is appended onto `prompt`, not discarded',
  /const typefaceLine = typefaceDirectiveForBrand\(resolvedBrand\);\s*\n\s*if \(typefaceLine\) prompt = `\$\{prompt\}/.test(svcSrc));
check('U7 typefaceDirectiveForBrand is exported for this harness to call directly',
  typeof direct.typefaceDirectiveForBrand === 'function');

// ── U8: revert-prove — the pre-fix prompt carried NO typeface guidance ───
// beyond the bare "you decide typeface and weight" LATITUDE clause; the
// shipped prompt additionally carries a FIXED, brand-named instruction.
{
  const data = direct.buildIntentData({
    concept: { copy_picks: { headline: '220 GSM organic cotton.' } },
    layoutInput: {}, brand: {}, cta: 'Shop the tee'
  });
  const built = intents.buildPrompt({
    intentKey: 'product_first_lifestyle', data, product: {}, surface: 'meta_stories_9_16'
  });
  check('U8 the base prompt (pre-fix shape) only hands typeface to "YOU DECIDE EVERYTHING ELSE" with no fixed assertion',
    /YOU DECIDE EVERYTHING ELSE/.test(built.prompt) && /typeface and weight/.test(built.prompt),
    'buildPrompt output changed shape unexpectedly');

  const preFix = built.prompt; // what actually shipped before this fix
  const typefaceLine = direct.typefaceDirectiveForBrand(VUORI_BRAND);
  const postFix = `${preFix}\n\n${typefaceLine}`;

  check('U8-revert-prove: the PRE-FIX prompt has no FIXED typeface assertion',
    !/FIXED, NOT A STYLE CHOICE/.test(preFix));
  check('U8-revert-prove: the SHIPPED (post-fix) prompt does',
    /FIXED, NOT A STYLE CHOICE/.test(postFix) && /Aktiv Grotesk/.test(postFix));
  check('U8-revert-prove: the shipped prompt still carries the original LATITUDE clause underneath (additive, not a replace)',
    /YOU DECIDE EVERYTHING ELSE/.test(postFix) && /typeface and weight/.test(postFix));
}

if (failures.length) {
  console.error(`\n❌ static typeface determinism: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ static typeface determinism: ${pass} checks passed`);
