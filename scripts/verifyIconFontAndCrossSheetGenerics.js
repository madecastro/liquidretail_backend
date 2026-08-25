#!/usr/bin/env node
'use strict';
//
// verifyIconFontAndCrossSheetGenerics — icon/dingbat font families must
// never win a heading/body/button role or be named to gpt-image-2 as the
// brand's own typeface, and a CSS custom property defined on one stylesheet
// must be visible to `font-family: var(--token)` usage on ANOTHER sheet.
//
// PORTED from liquidretail_backend commit 9dd98b85 (PR #323), which adgen
// never received — src/services/fontClassification.js was byte-identical to
// `git show 9dd98b85~1:services/fontClassification.js` before this port.
//
// THE DEFECT (measured on real production data, Soludos GS, 2026-08-24):
// stored `websiteFontUsage` had heading=null (no generic captured) because
// `--FONT-STACK-HEADING: Newsreader, serif` lived in an inline `:root` block
// while `h1 { font-family: var(--FONT-STACK-HEADING) }` lived in theme.css —
// per-sheet scoring could not resolve the var, so classifyTypeface fell
// through to the name heuristic and called Newsreader (a serif) sans. The
// only STORED role evidence was `button: 'oke-widget-icons'`, a dingbat from
// an Okendo widget's `:before` pseudo — which, unfixed, is exactly the kind
// of value that would be named to the image model as "the brand's own
// typeface" if it ever won heading.
//
// TWO LINKED FIXES, both required (see fontClassification.js / directImage
// RenderService.js / brandFontIngestService.js headers for the full story):
//   (a) isIconFontFamily() — a family whose name IS the word icon(s), or
//       named font-awesome/material-icons/icomoon, is never brand copy.
//       Applied at THREE points: firstConcreteFamily (ingest-time role
//       scoring), typefaceDirectiveForBrand (consume-time, for docs already
//       stored with an icon-font role), and pseudo-element selector rules
//       are dropped entirely so ::before/::after dingbats are never even
//       scored as role evidence in the first place.
//   (b) collectCssVariables + aggregateFontUsageAcrossSheets merging custom
//       properties across EVERY sheet before scoring any of them, so a
//       token declared in one <style> block is visible to `var(--token)`
//       usage in another.
//
// ─────────────────────────────────────────────────────────────────────────
// 2026-08-24 REWRITE — the module-crash fix. Read this before touching the
// require/extraction section below.
//
// THE BUG THIS REPLACED: this file used to `require('../src/services/
// brandFontIngestService')` and `require('../src/services/
// directImageRenderService')` directly. brandFontIngestService.js requires
// `axios` and `css-tree` at module load (real HTTP fetch + a real CSS
// parser, used by its network-facing ingest pipeline); directImageRenderService.js
// requires `axios`, `sharp`, and five Mongoose models. adgen worktrees
// deliberately carry NO node_modules (see this repo's CLAUDE.md — giving a
// worktree its own `mongoose`/etc. is what breaks verifyModelParity's
// sibling-mongoose fallback, 33/33 false failures), and this harness has no
// use for any of those dependencies in the first place. Requiring either
// file directly crashed with MODULE_NOT_FOUND before a single check ran —
// in a bare worktree, and in CI (no node_modules for this repo's own
// dependencies either, unless a prior `npm ci` step happened to run first).
//
// THE FIX: this harness never requires either file. It reads their REAL,
// UNMODIFIED source text and slices out exactly the region each function it
// needs lives in, then hands that verbatim text to `new Function` — the
// same "source extraction, not a copy" discipline scripts/
// verifyRendererAtomicClaim.js and scripts/verifyQuoteProvenanceStamp.js
// already use for renderer.js/layoutInputService.js (files with the same
// "real code, heavy requires, offline harness" tension). A change to the
// real function is what this harness sees; a hand-copied reimplementation
// would silently keep testing the OLD shape forever.
//
// Both extracted regions were read end to end to confirm this is safe:
//   - extractFontUsageFromCss / aggregateFontUsageAcrossSheets / their
//     internal helpers (collectCssVariables, isPseudoElementSelector,
//     isOnlyPseudoElementSelectors, firstConcreteFamily, genericFamilyIn,
//     resolveCssVars, familyStackTokens) touch NOTHING but plain
//     string/regex parsing and the fontClassification.js exports. `axios`,
//     `css-tree` and `cloudinaryService` are only ever touched by
//     `collectStylesheets` / `parseFontFacesFromCss` / `ingestBrandFonts` —
//     none of which this harness calls, and none of which are in the
//     sliced region at all.
//   - typefaceDirectiveForBrand / humanizeFontFamily touch nothing but the
//     brand argument and the same fontClassification.js exports.
// `fontClassification.js` itself has ZERO requires (grep confirms it — a
// pure module), so it is still required for real, unchanged from before.
//
// The two brandFontIngestService.js slice boundaries are anchored on that
// file's OWN section-comment dividers ("// ── Website role usage" / "// ──
// HTML → stylesheet discovery") rather than a balanced-brace scan:
// extractFontUsageFromCss's own rule regex is `/([^{}]+)\{([^{}]*)\}/g` —
// it contains six brace characters that are not code structure at all
// (a negated character class and two escaped literal braces), which is
// precisely the "regex literal" case scripts/lib/sourceLiteralScan.js's own
// header says its `findMatchingBrace` is NOT special-cased for and must
// not be reused against without adding that case first. Anchoring on two
// literal marker strings via plain `indexOf` — real V8 parsing of the
// extracted text happens once, inside `new Function`, never a hand-rolled
// scanner over it — sidesteps that hazard entirely rather than working
// around it. The directImageRenderService.js slice is anchored the same
// way, on the two function signatures either side of the code this harness
// needs (`humanizeFontFamily` / the next function after
// `typefaceDirectiveForBrand`), for the same reason.
//
// If an anchor stops matching (a rename, a restructure), the extractor
// throws immediately and loudly — this harness does not have a try/catch
// that turns "I can no longer find the code I'm supposed to test" into a
// quiet pass.
//
// COVERAGE: unchanged from before this rewrite. The pre-rewrite harness
// never exercised collectStylesheets/ingestBrandFonts/parseFontFacesFromCss
// (the axios/css-tree-touching functions) or anything else in either file
// besides the four functions named above — nothing is dropped here.
//
// Offline: no DB, no network, no key, no node_modules.
//   node scripts/verifyIconFontAndCrossSheetGenerics.js
//
// Revert-prove (section R runs each mutation against an in-memory-mutated
// copy of the extracted brandFontIngestService.js slice — never touches
// the file on disk, never requires anything):
//   R1  drop the cross-sheet extraVariables merge     → B measured KEEP breaks
//   R2  drop the pseudo-element selector skip          → A :before-serif KEEP
//   R3  restore whole-selector-only :before matching   → A mixed-list KEEP
//   R4  drop the icon-family skip in firstConcreteFamily → A button-face KEEP
//
// MUTATIONS THAT MUST FAIL THIS FILE
//   1. isIconFontFamily deleted / always false        → A1, A2, D1 fail
//   2. isOnlyPseudoElementSelectors deleted            → A3, A5 fail
//   3. collectCssVariables not called before scoring   → B1, B2 fail
//   4. typefaceDirectiveForBrand stops filtering icon fonts → C4, C4b fail
//   5. aggregateFontUsageAcrossSheets reverts to per-sheet scoring → B3, B4 fail
//   6. SERIF_HINTS grows a "newsreader" keyword (band-aid, not the fix) → E1 fails

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_INGEST = path.join(ROOT, 'src', 'services', 'brandFontIngestService.js');
const SRC_DIRECT = path.join(ROOT, 'src', 'services', 'directImageRenderService.js');

const fc = require('../src/services/fontClassification');

// ── Source extraction ──────────────────────────────────────────────────

function sliceBetween(src, startMarker, endMarker, fileLabel) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      `${fileLabel}: start marker not found: ${JSON.stringify(startMarker)} — `
      + `has the file been restructured? Re-point this harness, do not skip it.`
    );
  }
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) {
    throw new Error(
      `${fileLabel}: end marker not found: ${JSON.stringify(endMarker)} — `
      + `has the file been restructured? Re-point this harness, do not skip it.`
    );
  }
  return src.slice(startIdx, endIdx);
}

const INGEST_SLICE_START = '// ── Website role usage';
const INGEST_SLICE_END = '// ── HTML → stylesheet discovery';

function ingestSliceSource(fullSrc) {
  return sliceBetween(fullSrc, INGEST_SLICE_START, INGEST_SLICE_END, 'brandFontIngestService.js');
}

// The extracted slice contains the file's own `const { ... } =
// require('./fontClassification')` destructure verbatim. Give it a
// `require` that resolves exactly that one path to the real (safe, pure)
// module and throws loudly on anything else — a future edit that pulls a
// new dependency into this region should fail this harness, not silently
// stub it away.
function scopedFontClassificationRequire(request) {
  if (request === './fontClassification') return fc;
  throw new Error(
    `verifyIconFontAndCrossSheetGenerics: extracted brandFontIngestService.js `
    + `slice tried to require('${request}') — only './fontClassification' is `
    + `expected inside this slice. Either the extraction boundary needs to `
    + `move, or the real file now pulls in a dependency this offline harness `
    + `cannot satisfy.`
  );
}

function buildIngest(sliceSrc) {
  const factory = new Function(
    'require',
    `${sliceSrc}\nreturn { extractFontUsageFromCss, aggregateFontUsageAcrossSheets, `
    + 'collectCssVariables, isOnlyPseudoElementSelectors, isPseudoElementSelector };'
  );
  return factory(scopedFontClassificationRequire);
}

const DIRECT_SLICE_START = 'function humanizeFontFamily(slug) {';
const DIRECT_SLICE_END = 'function monochromeInkFor(meanLum) {';

function directSliceSource(fullSrc) {
  return sliceBetween(fullSrc, DIRECT_SLICE_START, DIRECT_SLICE_END, 'directImageRenderService.js');
}

function buildDirect(sliceSrc) {
  const factory = new Function(
    'classifyTypeface', 'storedGenericForFamily', 'isIconFontFamily',
    `${sliceSrc}\nreturn { typefaceDirectiveForBrand, humanizeFontFamily };`
  );
  return factory(fc.classifyTypeface, fc.storedGenericForFamily, fc.isIconFontFamily);
}

const ingestFullSrc = fs.readFileSync(SRC_INGEST, 'utf8');
const directFullSrc = fs.readFileSync(SRC_DIRECT, 'utf8');

const ingest = buildIngest(ingestSliceSource(ingestFullSrc));
const direct = buildDirect(directSliceSource(directFullSrc));

let checks = 0;
let failed = 0;
function check(label, cond, extra) {
  checks += 1;
  if (!cond) {
    failed += 1;
    console.error(`  ✗ ${label}${extra !== undefined ? `\n    got: ${JSON.stringify(extra)}` : ''}`);
  }
}

console.log('verifyIconFontAndCrossSheetGenerics (adgen port of backend #323)\n');

// ── Fixture CSS: the real Soludos GS shapes (trimmed to what participates),
// per backend session.d/2026-08-24_soludos-newsreader-serif-misclassification.md
const SOLUDOS_INLINE_CSS = [
  ':root {',
  '    --FONT-STACK-BODY: "DM Sans", sans-serif;',
  '    --FONT-STACK-HEADING: Newsreader, serif;',
  '    --FONT-STACK-SUBHEADING: "DM Sans", sans-serif;',
  '    --FONT-STACK-NAV: Newsreader, serif;',
  '}',
  '.okeReviews[data-oke-container] .oke-button.oke-is-loading:before,div.okeReviews .oke-button.oke-is-loading:before{font-family:oke-widget-icons!important;content:"\\e901"}',
].join('\n');
const SOLUDOS_THEME_CSS = [
  '.h1, .h2, .h3, .h4, .h5, .h6, h1, h2, h3, h4, h5, h6 {',
  '  font-family: var(--FONT-STACK-HEADING);',
  '}',
  'body {',
  '  font-family: var(--FONT-STACK-BODY);',
  '}',
].join('\n');
const SOLUDOS_SWIPER_CSS =
  '.swiper-button-next:after,.swiper-button-prev:after{font-family:swiper-icons;font-size:var(--swiper-navigation-size)}';

const SOLUDOS_GS_STORED = {
  fontFamily: 'Newsreader',
  customFonts: [
    { family: 'Newsreader' }, { family: 'DM Sans' }, { family: 'Newsreader' },
    { family: 'DM Sans' }, { family: 'DM Sans' }, { family: 'DM Sans' },
    { family: 'DM Sans' }, { family: 'oke-widget-icons' },
  ],
  websiteFontUsage: {
    heading: null, body: null, button: 'oke-widget-icons',
    headingGeneric: null, bodyGeneric: null, buttonGeneric: null,
    evidence: [
      { family: 'oke-widget-icons', role: 'button', generic: null, score: 3 },
      { family: 'swiper-icons', role: 'button', generic: null, score: 3 },
    ],
  },
};

const PLAYFAIR_BEFORE =
  'HEADLINE TYPEFACE — FIXED, NOT A STYLE CHOICE. This brand\'s own typeface is Playfair Display, a serif. Set the headline, subheadline and eyebrow copy in a serif with refined editorial serif proportions, in the spirit of Playfair Display. Do not switch to the opposite family (serif vs sans) for stylistic reasons — every surface of this brand\'s campaign must render the SAME typeface family; only the composition should vary.';
const AKTIV_BEFORE =
  'HEADLINE TYPEFACE — FIXED, NOT A STYLE CHOICE. This brand\'s own typeface is Aktiv Grotesk, a sans-serif. Set the headline, subheadline and eyebrow copy in a sans-serif with clean grotesque/humanist proportions, in the spirit of Aktiv Grotesk. Do not switch to the opposite family (serif vs sans) for stylistic reasons — every surface of this brand\'s campaign must render the SAME typeface family; only the composition should vary.';
const PLAYFAIR_BRAND = { customFonts: [{ family: 'Playfair Display', weight: 700 }] };
const AKTIV_BRAND = {
  websiteFontUsage: { heading: 'aktiv-grotesk', headingGeneric: 'sans-serif' },
  customFonts: [{ family: 'aktiv-grotesk', weight: 400 }],
};

// ── A. isIconFontFamily + pseudo-element role stripping.
check('A1 isIconFontFamily matches the two production dingbats',
  fc.isIconFontFamily('oke-widget-icons') && fc.isIconFontFamily('swiper-icons'));
check('A2 isIconFontFamily does not match brand faces',
  !fc.isIconFontFamily('Newsreader')
  && !fc.isIconFontFamily('DM Sans')
  && !fc.isIconFontFamily('Playfair Display')
  && !fc.isIconFontFamily('aktiv-grotesk')
  && !fc.isIconFontFamily('Iconic'));
check('A3 a :before icon-font rule yields no button evidence',
  ingest.extractFontUsageFromCss(
    '.oke-button.oke-is-loading:before{font-family:oke-widget-icons!important}'
  ).button == null);
check('A4 a mixed list h1, h1:before still yields the heading face',
  ingest.extractFontUsageFromCss('h1, h1:before{font-family:Newsreader, serif}').heading === 'Newsreader');
check('A5 a list that is ONLY :before is still dropped even for a real serif',
  ingest.extractFontUsageFromCss('h1:before, h2:before{font-family:Newsreader, serif}').heading == null);
check('A6 a NON-pseudo icon-font rule is also dropped (name, not just selector)',
  ingest.extractFontUsageFromCss('.btn{font-family:swiper-icons}').button == null);
check('A7 a real button face next to an icon pseudo is kept',
  ingest.extractFontUsageFromCss(
    '.btn{font-family:DM Sans,sans-serif}.oke-button:before{font-family:oke-widget-icons}'
  ).button === 'DM Sans');

// ── B. Cross-sheet custom-property merge.
check('B1 [THE DEFECT] theme.css alone cannot resolve --FONT-STACK-HEADING',
  ingest.extractFontUsageFromCss(SOLUDOS_THEME_CSS).heading == null
  && ingest.extractFontUsageFromCss(SOLUDOS_THEME_CSS).headingGeneric == null);
check('B2 inline :root tokens alone yield no heading role (no heading selector)',
  ingest.extractFontUsageFromCss(SOLUDOS_INLINE_CSS).heading == null);
{
  const u = ingest.aggregateFontUsageAcrossSheets([SOLUDOS_INLINE_CSS, SOLUDOS_THEME_CSS]);
  check('B3 [THE FIX] aggregate across the two sheets captures Newsreader + serif',
    u.heading === 'Newsreader' && u.headingGeneric === 'serif'
    && u.body === 'DM Sans' && u.bodyGeneric === 'sans-serif', u);
}
{
  const u = ingest.aggregateFontUsageAcrossSheets([SOLUDOS_SWIPER_CSS, SOLUDOS_INLINE_CSS, SOLUDOS_THEME_CSS]);
  check('B4 icon sheets in the same aggregate do not steal the heading',
    u.heading === 'Newsreader' && u.headingGeneric === 'serif'
    && !u.evidence.some((e) => /icon/i.test(e.family))
    && u.button !== 'oke-widget-icons' && u.button !== 'swiper-icons', u);
}
check('B5 concatenated sheets still resolve (same-parser path, not the bug)',
  ingest.extractFontUsageFromCss(SOLUDOS_INLINE_CSS + '\n' + SOLUDOS_THEME_CSS).headingGeneric === 'serif');

// ── C. End to end through the real static directive.
{
  const soludosUsage = ingest.aggregateFontUsageAcrossSheets([SOLUDOS_SWIPER_CSS, SOLUDOS_INLINE_CSS, SOLUDOS_THEME_CSS]);
  const soludosBrand = {
    fontFamily: 'Newsreader',
    customFonts: [
      { family: 'Newsreader' }, { family: 'DM Sans' }, { family: 'Newsreader' },
      { family: 'DM Sans' }, { family: 'DM Sans' }, { family: 'DM Sans' },
      { family: 'DM Sans' }, { family: 'oke-widget-icons' },
    ],
    websiteFontUsage: soludosUsage,
  };
  const line = direct.typefaceDirectiveForBrand(soludosBrand);
  check('C1 [THE FIX, end to end] Soludos GS is instructed SERIF',
    /\ba serif\b/.test(line) && !/sans-serif/.test(line), line);
  check('C1 it names Newsreader', /Newsreader/.test(line), line);
  check('C1 serif character clause, not grotesque',
    /refined editorial serif proportions/.test(line) && !/grotesque/.test(line), line);
}
check('C2 stored production shape still names Newsreader',
  /Newsreader/.test(direct.typefaceDirectiveForBrand(SOLUDOS_GS_STORED)));
check('C2 stored production shape is still sans without a captured generic (not a keyword-list fix)',
  /a sans-serif/.test(direct.typefaceDirectiveForBrand(SOLUDOS_GS_STORED)));
check('C3 icon-font button evidence does not change a correct heading (no-op)',
  direct.typefaceDirectiveForBrand({
    websiteFontUsage: { heading: 'Playfair Display', headingGeneric: 'serif', button: 'oke-widget-icons' },
    customFonts: [{ family: 'Playfair Display', weight: 700 }],
  }) === PLAYFAIR_BEFORE);

// ── C4. THE CONSUME-TIME GUARD ITSELF. If an already-stored (pre-fix)
// document has an icon font sitting directly in `heading` (not just
// `button`), the directive must NOT name it to gpt-image-2 as the brand's
// own typeface. This is the literal defect from the task description:
// "if a brand's stored heading font is an icon/dingbat family, adgen
// literally instructs the image model to set the ad in dingbats." Ingest
// fix (a) prevents this for NEW ingests; this is the belt-and-suspenders
// guard for rows already stored with a bad heading before the fix landed.
{
  const iconHeadingBrand = {
    websiteFontUsage: { heading: 'oke-widget-icons', headingGeneric: null },
    customFonts: [{ family: 'oke-widget-icons' }, { family: 'DM Sans' }],
  };
  const line = direct.typefaceDirectiveForBrand(iconHeadingBrand);
  // humanizeFontFamily title-cases and un-hyphenates the family before it is
  // named in the prompt ("oke-widget-icons" -> "Oke Widget Icons"), so match
  // case-insensitively against both the raw and humanized forms.
  check('C4 [THE CONSUME-TIME GUARD] an icon font in `heading` is never named to the image model',
    !/oke.widget.icons/i.test(line), line);
  check('C4 falls back to the next non-icon customFonts entry (DM Sans), not the generic default',
    /DM Sans/.test(line), line);
}
{
  // customFonts[0] itself is an icon font, heading is null (Soludos GS's own
  // actual pre-fix stored shape, minus the ingest fix): must not name it either.
  const iconFirstBrand = {
    websiteFontUsage: { heading: null, headingGeneric: null },
    customFonts: [{ family: 'oke-widget-icons' }],
  };
  const line = direct.typefaceDirectiveForBrand(iconFirstBrand);
  check('C4b customFonts[0] being an icon font falls through to the generic default directive',
    !/oke.widget.icons/i.test(line) && /clean, modern sans-serif/.test(line), line);
}

// ── D. NO-OP for brands that already classified correctly.
check('D1 [NO-OP] keyword-matched serif directive is byte-identical to pre-change',
  direct.typefaceDirectiveForBrand(PLAYFAIR_BRAND) === PLAYFAIR_BEFORE,
  direct.typefaceDirectiveForBrand(PLAYFAIR_BRAND));
check('D1 [NO-OP] genuine sans directive is byte-identical to pre-change',
  direct.typefaceDirectiveForBrand(AKTIV_BRAND) === AKTIV_BEFORE,
  direct.typefaceDirectiveForBrand(AKTIV_BRAND));

// ── E. SERIF_HINTS untouched — this is a generic-capture fix, not a
//    keyword-list patch. "Newsreader" must not match the keyword regex, so
//    classifyTypeface needs the captured GENERIC (not a name match) to call
//    it serif — proving the fix is ingest capturing evidence, not a regex edit.
check('E1 "Newsreader" does not match SERIF_HINTS by name',
  !fc.SERIF_HINTS.test('Newsreader'));
check('E1 classifyTypeface needs the GENERIC, not a name match, for Newsreader',
  fc.classifyTypeface({ family: 'Newsreader', generic: null }) === 'sans-serif'
  && fc.classifyTypeface({ family: 'Newsreader', generic: 'serif' }) === 'serif');

// ── R. Revert-prove via in-memory mutated slices (never touches disk, never
//     requires a temp file — the mutated text is handed straight to
//     `new Function`, same as the shipped build above). ───────────────────

function mutateOrThrow(src, from, to, label) {
  const mutated = src.replace(from, to);
  if (mutated === src) {
    throw new Error(`revert-prove mutation ${label} was a no-op — pattern missed the real source`);
  }
  return mutated;
}

const shippedIngestSlice = ingestSliceSource(ingestFullSrc);

try {
  // R1 — drop the cross-sheet extraVariables merge: Soludos's theme.css usage
  // of var(--FONT-STACK-HEADING) must lose its generic again.
  const mutated = mutateOrThrow(
    shippedIngestSlice,
    '  const variables = {\n'
    + "    ...(extraVariables && typeof extraVariables === 'object' ? extraVariables : {}),\n"
    + '  };',
    '  const variables = {};',
    'R1'
  );
  const mod = buildIngest(mutated);
  const sheets = [SOLUDOS_INLINE_CSS, SOLUDOS_THEME_CSS];
  const brokenAgg = mod.aggregateFontUsageAcrossSheets(sheets);
  check('R1 revert-prove: without extraVariables, Soludos headingGeneric is lost',
    brokenAgg.headingGeneric == null && brokenAgg.heading == null,
    `got heading=${brokenAgg.heading} generic=${brokenAgg.headingGeneric} — B3 cannot fail`);
  check('R1 the shipped aggregator still captures it (so B3 discriminates)',
    ingest.aggregateFontUsageAcrossSheets(sheets).headingGeneric === 'serif'
    && ingest.aggregateFontUsageAcrossSheets(sheets).heading === 'Newsreader');
} catch (err) { check(`R1 mutation harness failed: ${err.message}`, false); }

try {
  // R2 — drop the pseudo-element selector skip: a :before serif wins heading.
  const mutated = mutateOrThrow(
    shippedIngestSlice,
    '    if (isOnlyPseudoElementSelectors(selector)) continue;\n',
    '',
    'R2'
  );
  const mod = buildIngest(mutated);
  const css = '.heading:before{font-family:Newsreader, serif}';
  check('R2 revert-prove: without the pseudo skip, a :before serif wins heading',
    mod.extractFontUsageFromCss(css).heading === 'Newsreader'
    && mod.extractFontUsageFromCss(css).headingGeneric === 'serif',
    `got ${mod.extractFontUsageFromCss(css).heading}/${mod.extractFontUsageFromCss(css).headingGeneric} — A5 cannot fail`);
  check('R2 the shipped parser reports no family (so A5 discriminates)',
    ingest.extractFontUsageFromCss(css).heading == null);
} catch (err) { check(`R2 mutation harness failed: ${err.message}`, false); }

try {
  // R3 — restore whole-selector :before matching: a mixed `h1, h1:before`
  // list must lose the heading face again.
  const mutated = mutateOrThrow(
    shippedIngestSlice,
    'function isOnlyPseudoElementSelectors(selector) {\n'
    + "  const parts = String(selector || '').split(',');\n"
    + '  return parts.length > 0 && parts.every((p) => isPseudoElementSelector(p));\n'
    + '}',
    'function isOnlyPseudoElementSelectors(selector) {\n'
    + '  return isPseudoElementSelector(selector);\n'
    + '}',
    'R3'
  );
  const mod = buildIngest(mutated);
  const css = 'h1, h1:before{font-family:Newsreader, serif}';
  check('R3 revert-prove: whole-selector skip drops a mixed h1, h1:before list',
    mod.extractFontUsageFromCss(css).heading == null,
    `got ${mod.extractFontUsageFromCss(css).heading}`);
  check('R3 the shipped parser keeps the heading (so A4 discriminates)',
    ingest.extractFontUsageFromCss(css).heading === 'Newsreader');
} catch (err) { check(`R3 mutation harness failed: ${err.message}`, false); }

try {
  // R4 — drop the icon-family skip in firstConcreteFamily: a NON-pseudo
  // icon-font rule becomes the brand's button face again.
  const mutated = mutateOrThrow(
    shippedIngestSlice,
    '    if (isIconFontFamily(family)) continue;\n',
    '',
    'R4'
  );
  const mod = buildIngest(mutated);
  const css = '.btn{font-family:swiper-icons}';
  check('R4 revert-prove: without the icon-family skip, swiper-icons wins button',
    mod.extractFontUsageFromCss(css).button === 'swiper-icons',
    `got ${mod.extractFontUsageFromCss(css).button}`);
  check('R4 the shipped parser reports no family (so A6 discriminates)',
    ingest.extractFontUsageFromCss(css).button == null);
} catch (err) { check(`R4 mutation harness failed: ${err.message}`, false); }

console.log(`\n${checks - failed} of ${checks} checks passed`);
if (failed) {
  console.error(`\n❌ ${failed} check(s) FAILED — see ✗ above`);
  process.exitCode = 1;
}
