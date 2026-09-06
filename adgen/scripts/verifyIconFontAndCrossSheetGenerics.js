#!/usr/bin/env node
'use strict';
//
// verifyIconFontAndCrossSheetGenerics — consume-time half of backend #323.
//
// Ingest-time CSS scoring (extractFontUsageFromCss / aggregateFontUsageAcross
// Sheets / collectCssVariables) lived in brandFontIngestService.js. Brand
// font ingestion is catalog/brand ingest, which is backend-owned; those
// modules were deleted from adgen. This harness keeps the RENDER-TIME
// guard that still lives here:
//
//   typefaceDirectiveForBrand (directImageRenderService.js) must never
//   name an icon/dingbat family to gpt-image-2 as the brand's own
//   typeface, even when an already-stored Brand.websiteFontUsage /
//   customFonts row still carries one (docs ingested before the ingest
//   fix, or ingested by backend and then read here).
//
// fontClassification.js (isIconFontFamily / classifyTypeface / SERIF_HINTS)
// is required by that consume-time path and stays.
//
// Offline: no DB, no network, no key. Source-extracts typefaceDirectiveForBrand
// from directImageRenderService.js so a worktree without node_modules can
// still run (directImageRenderService requires axios/sharp/mongoose at load).
//
//   node scripts/verifyIconFontAndCrossSheetGenerics.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIRECT = path.join(ROOT, 'src', 'services', 'directImageRenderService.js');

const fc = require('../src/services/fontClassification');

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

const directFullSrc = fs.readFileSync(SRC_DIRECT, 'utf8');
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

console.log('verifyIconFontAndCrossSheetGenerics (adgen consume-time half of backend #323)\n');

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

// ── A. isIconFontFamily (live: fontClassification.js, required by the
//    consume-time directive).
check('A1 isIconFontFamily matches the two production dingbats',
  fc.isIconFontFamily('oke-widget-icons') && fc.isIconFontFamily('swiper-icons'));
check('A2 isIconFontFamily does not match brand faces',
  !fc.isIconFontFamily('Newsreader')
  && !fc.isIconFontFamily('DM Sans')
  && !fc.isIconFontFamily('Playfair Display')
  && !fc.isIconFontFamily('aktiv-grotesk')
  && !fc.isIconFontFamily('Iconic'));

// ── C. End to end through the real static directive.
{
  // Post-ingest shape backend would persist after #323 (Newsreader + serif
  // generic captured). Hardcoded: the CSS aggregator that produced this
  // shape is backend-owned and no longer in this tree.
  const soludosBrand = {
    fontFamily: 'Newsreader',
    customFonts: [
      { family: 'Newsreader' }, { family: 'DM Sans' }, { family: 'oke-widget-icons' },
    ],
    websiteFontUsage: {
      heading: 'Newsreader', headingGeneric: 'serif',
      body: 'DM Sans', bodyGeneric: 'sans-serif',
      button: null, buttonGeneric: null,
    },
  };
  const line = direct.typefaceDirectiveForBrand(soludosBrand);
  check('C1 captured Newsreader+serif generic is instructed SERIF',
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
// own typeface.
{
  const iconHeadingBrand = {
    websiteFontUsage: { heading: 'oke-widget-icons', headingGeneric: null },
    customFonts: [{ family: 'oke-widget-icons' }, { family: 'DM Sans' }],
  };
  const line = direct.typefaceDirectiveForBrand(iconHeadingBrand);
  check('C4 [THE CONSUME-TIME GUARD] an icon font in `heading` is never named to the image model',
    !/oke.widget.icons/i.test(line), line);
  check('C4 falls back to the next non-icon customFonts entry (DM Sans), not the generic default',
    /DM Sans/.test(line), line);
}
{
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
//    it serif.
check('E1 "Newsreader" does not match SERIF_HINTS by name',
  !fc.SERIF_HINTS.test('Newsreader'));
check('E1 classifyTypeface needs the GENERIC, not a name match, for Newsreader',
  fc.classifyTypeface({ family: 'Newsreader', generic: null }) === 'sans-serif'
  && fc.classifyTypeface({ family: 'Newsreader', generic: 'serif' }) === 'serif');

console.log(`\n${checks - failed} of ${checks} checks passed`);
if (failed) {
  console.error(`\n❌ ${failed} check(s) FAILED — see ✗ above`);
  process.exitCode = 1;
}
