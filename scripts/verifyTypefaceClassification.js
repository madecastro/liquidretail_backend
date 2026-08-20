#!/usr/bin/env node
/**
 * Offline harness for FIRST-PARTY typeface classification (2026-08-20).
 * No DB, no network, no API key. Companion to
 * verifyStaticTypefaceDeterminism.js, which pins that the static prompt makes
 * ONE typeface choice per brand; this file pins that the choice is the RIGHT
 * one.
 *
 * THE DEFECT THIS EXISTS FOR (Marine Layer 2, PR #261 §5 follow-up)
 * ----------------------------------------------------------------
 * Marine Layer's real ingested website font is "Seriously Nostalgic", a
 * Didone-style display SERIF. Classifying it by pattern-matching the FAMILY
 * NAME (the only mechanism the static path had) matches no serif keyword —
 * "serio…" and "serif…" diverge at the 5th character — so
 * typefaceDirectiveForBrand instructed gpt-image-2 to set a "clean, modern
 * sans-serif" for a face that is unambiguously a serif. The VIDEO titling
 * path loads the real font FILE and so never guesses, and rendered the same
 * brand as a serif. Result: a brand's static and video ads disagreed about
 * its own typeface, from a keyword-list gap rather than any design decision.
 *
 * WHY THE FIX IS "READ THE BRAND'S CSS", not "add more keywords"
 * -------------------------------------------------------------
 * Measured, on real files, before choosing (see services/fontClassification.js
 * for the full write-up):
 *   · OS/2 `panose` / `sFamilyClass` — the obvious "inspect the font file"
 *     answer — are unset in practice. Across the 28 real woff2 files in
 *     services/brandScripts/assets/webfonts, sFamilyClass is 0 on ALL of
 *     them and panose's serif-style byte is unset on EVERY known serif
 *     (Playfair Display, EB Garamond, Lora all [0,0,…]). "Seriously
 *     Nostalgic" itself has panose all-zeros, so file inspection returns
 *     nothing for the very font in the bug report.
 *   · The font's internal `name` table only restates names.
 *   · The brand's own stylesheet states the answer outright:
 *     `font-family: Seriously Nostalgic, serif`. brandFontIngestService
 *     already parsed those declarations and threw the generic away.
 *
 * Groups:
 *   C1  the pure classifier's precedence, which is NOT "freshest evidence
 *       wins": a positive SERIF_HINTS match outranks the first-party generic
 *       (so a sloppy `Playfair Display, sans-serif` cannot flip a brand the
 *       keyword list already gets right), the generic decides everything the
 *       keyword list has no opinion about, and a generic carrying no
 *       serif/sans signal (mono/fantasy/CSS-wide keywords) decides nothing.
 *       C5b pins the resulting blast-radius property.
 *   C2  the shared module really is shared — the static path and the video
 *       path read one constant, so the two cannot silently diverge (this
 *       replaces a hand-copied regex whose own comment admitted it was a
 *       hand copy).
 *   C3  ingest captures the generic from REAL Marine Layer CSS, and votes it
 *       per (role, family) rather than per role.
 *   C4  storedGenericForFamily only trusts a role's generic for that role's
 *       OWN family.
 *   C5  end-to-end: the static directive for Marine Layer 2 now says serif,
 *       and brands with no captured generic are byte-identical to before.
 *   C6  the multi-sheet re-serialisation round-trip preserves the generic.
 *   C8  parser hardening for shapes that ship on real storefronts: Shopify
 *       Dawn's `var(--f), serif`, chained custom properties, `!important`
 *       inside a variable value, a stack whose generic is not first, and
 *       family keys with internal whitespace.
 *   C7  REVERT-PROOF: ten mutations of the real shipped source, each
 *       compiled IN MEMORY and re-run, each asserted to break a specific
 *       check above. A check that cannot fail is not a test. Nothing is
 *       written to disk — see loadMutated's header and #259.
 *
 * Run: node scripts/verifyTypefaceClassification.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const os = require('os');

const fc = require('../services/fontClassification');
const ingest = require('../services/brandFontIngestService');
const direct = require('../services/directImageRenderService');
const fontResolver = require('../services/fontResolverService');

const SERVICES = path.join(__dirname, '..', 'services');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────
// A REAL first-party fixture.
//
// Reproduces the declaration shapes AND the weighted tally measured on
// marinelayer.com's live theme stylesheet
// (/cdn/shop/t/356/assets/theme.BVeOmP3j.min.css, 522KB, read 2026-08-20).
// The declaration text is verbatim.
//
// The tally reproduced here is the one ingest ACTUALLY VOTES ON, which is not
// the whole sheet: extractFontUsageFromCss returns `evidence.slice(0, 30)`,
// and ingestBrandFontsInner re-parses exactly those capped rows. Measured
// within that cap on the live sheet:
//
//   heading | Seriously Nostalgic | serif        56   (14 rules x score 4)
//   heading | Seriously Nostalgic | sans-serif    4   ( 1 rule, via
//                                                      var(--font-heading))
//   heading | Outfit              | sans-serif    4   ( 1 rule)
//
// (On the UNCAPPED sheet the same distribution runs 72 / 8 / 64. Either way
// the brand's own answer is serif — this fixture pins the capped numbers
// because those are the ones production computes.)
//
// NOTE the 30-row cap is pre-existing behaviour and applies to the FAMILY
// vote too, not just to these generics — a large stylesheet is scored from
// its first 30 role-bearing rules only. Not changed here; called out so the
// numbers above are not mistaken for a whole-sheet tally.
// ─────────────────────────────────────────────────────────────────────────
const ML_HEADING_DECL = 'font-family:Seriously Nostalgic,serif;font-size:50px;font-style:normal;font-weight:400;line-height:95%';
const ML_VARIABLE = '--font-heading:"Seriously Nostalgic",sans-serif';

function marineLayerCss() {
  const rules = [`:root,:host{${ML_VARIABLE};--font-sans:ui-sans-serif,system-ui,sans-serif}`];
  for (let i = 0; i < 14; i++) rules.push(`.heading-${i}{${ML_HEADING_DECL}}`);
  rules.push('.promo-heading{font-family:var(--font-heading)}');
  rules.push('.card-heading{font-family:Outfit,sans-serif;font-size:18px}');
  rules.push('body{font-family:Outfit,sans-serif;font-size:16px}');
  rules.push('p{font-family:Outfit,sans-serif}');
  rules.push('.btn{font-family:Outfit,sans-serif;text-transform:uppercase}');
  return rules.join('\n');
}
const ML_CSS = marineLayerCss();

// ─────────────────────────────────────────────────────────────────────────
// A second fixture, for the per-(role, family) scoping decision.
//
// On Marine Layer the brand's serif answer wins under EITHER voting scheme,
// so that fixture cannot prove the scoping is what produces it. This one
// isolates the case the scoping exists for, and it is an ordinary storefront
// shape: the display face is sometimes set WITHOUT a generic fallback (very
// common), so its generic carries less weight than its family does.
//
//   heading | Brand Display | serif        20   (5 rules x 4)
//   heading | Brand Display | (none)       12   (3 rules x 4, no fallback)
//   heading | Helper Sans   | sans-serif   24   (6 rules x 4)
//
// Family vote: Brand Display 32 > Helper Sans 24, so the heading face is
// Brand Display — a serif. Voting generics per ROLE would return sans-serif
// (24 > 20), confidently mis-classifying it from a DIFFERENT family's
// fallback. Scoped to the winning family it returns serif (20, uncontested).
// ─────────────────────────────────────────────────────────────────────────
function mixedRoleCss() {
  const rules = [];
  for (let i = 0; i < 5; i++) rules.push(`.heading-a${i}{font-family:Brand Display,serif}`);
  for (let i = 0; i < 3; i++) rules.push(`.heading-b${i}{font-family:Brand Display}`);
  for (let i = 0; i < 6; i++) rules.push(`.heading-c${i}{font-family:Helper Sans,sans-serif}`);
  return rules.join('\n');
}
const MIXED_CSS = mixedRoleCss();

// ── C1: classifier precedence ────────────────────────────────────────────
{
  check('C1 first-party serif generic beats a name that looks sans',
    fc.classifyTypeface({ family: 'Seriously Nostalgic', generic: 'serif' }) === 'serif');
  check('C1 [THE DEFECT] name alone still classifies Seriously Nostalgic as sans (unchanged legacy tier)',
    fc.classifyTypeface({ family: 'Seriously Nostalgic' }) === 'sans-serif');
  // A RECOGNISED serif type name is never overridden — see the PRECEDENCE
  // section of fontClassification.js. `Playfair Display, sans-serif` is a real
  // shape (sloppy fallback on an unambiguous serif); letting the generic win
  // there would flip a brand the keyword list already gets right.
  check('C1 [BLAST-RADIUS GUARD] a sloppy sans fallback does NOT flip a recognised serif',
    fc.classifyTypeface({ family: 'Playfair Display', generic: 'sans-serif' }) === 'serif');
  check('C1 the same holds for every generic, on every keyword-matched family',
    ['Playfair Display', 'Lora', 'EB Garamond', 'Bodoni Moda', 'Times New Roman', 'Zilla Slab']
      .every((family) => ['serif', 'sans-serif', 'monospace', 'cursive', 'system-ui',
        'fantasy', 'inherit', null, undefined, '']
        .every((generic) => fc.classifyTypeface({ family, generic }) === 'serif')));
  check('C1 never returns null — both consumers must commit to one answer',
    fc.classifyTypeface({}) === 'sans-serif' && fc.classifyTypeface() === 'sans-serif');

  // A generic with no serif/sans meaning must NOT manufacture an answer, or
  // it would OVERRIDE a correct name-based guess with a coin flip.
  for (const noSignal of ['monospace', 'ui-monospace', 'fantasy', 'inherit', 'initial', 'unset', '', null]) {
    check(`C1 "${noSignal}" carries no serif/sans signal (classFromGeneric -> null)`,
      fc.classFromGeneric(noSignal) === null, `got ${fc.classFromGeneric(noSignal)}`);
    check(`C1 "${noSignal}" does not override the name heuristic for a serif name`,
      fc.classifyTypeface({ family: 'Playfair Display', generic: noSignal }) === 'serif');
  }
  check('C1 cursive maps to serif (the video path\'s Great Vibes convention)',
    fc.classFromGeneric('cursive') === 'serif');
  check('C1 ui-serif maps to serif', fc.classFromGeneric('ui-serif') === 'serif');
  check('C1 system-ui maps to sans-serif', fc.classFromGeneric('system-ui') === 'sans-serif');
  check('C1 generic matching is case/space insensitive',
    fc.classFromGeneric('  SERIF ') === 'serif');
}

// ── C2: the module really is shared, not re-copied ───────────────────────
{
  check('C2 the static path exports the SAME regex object as fontClassification',
    direct.FONT_SERIF_HINTS === fc.SERIF_HINTS,
    'static FONT_SERIF_HINTS is a copy again, not the shared constant');

  // The video path must keep its deliberately-naive name-only semantics:
  // verifyFontFallback.js pins fallbackFor('Self Modern') === 'sans-serif'.
  check('C2 fontResolverService.fallbackFor stays name-only and unchanged',
    fontResolver.fallbackFor('Self Modern') === 'sans-serif'
    && fontResolver.fallbackFor('Playfair Display') === 'serif'
    && fontResolver.fallbackFor('Seriously Nostalgic') === 'sans-serif');
  check('C2 fallbackFor agrees with the shared name-only classifier on every family',
    ['aktiv-grotesk', 'Inter', 'Playfair Display', 'Lora', 'Georgia', 'Futura',
      'Self Modern', 'Seriously Nostalgic', 'Merriweather']
      .every((f) => fontResolver.fallbackFor(f) === fc.classFromFamilyName(f)));

  // The old hand-copy hazard, stated as a test: a source-level grep for a
  // second literal copy of the regex body.
  const staticSrc = fs.readFileSync(path.join(SERVICES, 'directImageRenderService.js'), 'utf8');
  const resolverSrc = fs.readFileSync(path.join(SERVICES, 'fontResolverService.js'), 'utf8');
  const literal = /playfair\|lora\|cormorant/;
  check('C2 no literal copy of the regex remains in the static path', !literal.test(staticSrc));
  check('C2 no literal copy of the regex remains in the video path', !literal.test(resolverSrc));
}

// ── C3: ingest captures + votes the generic on REAL Marine Layer CSS ─────
{
  const usage = ingest.extractFontUsageFromCss(ML_CSS);
  check('C3 heading family is the brand\'s display face', usage.heading === 'Seriously Nostalgic',
    `got ${usage.heading}`);
  check('C3 [THE FIX] headingGeneric is the brand\'s own "serif", not the 8-point sans minority',
    usage.headingGeneric === 'serif', `got ${usage.headingGeneric}`);
  check('C3 body family + generic are the grotesque, independently',
    usage.body === 'Outfit' && usage.bodyGeneric === 'sans-serif',
    `got ${usage.body}/${usage.bodyGeneric}`);
  check('C3 button generic likewise', usage.buttonGeneric === 'sans-serif');
  check('C3 evidence rows carry the generic',
    usage.evidence.some((e) => e.family === 'Seriously Nostalgic' && e.generic === 'serif'));
  check('C3 a var() reference resolves to its family AND its generic',
    usage.evidence.some((e) => e.family === 'Seriously Nostalgic' && e.generic === 'sans-serif'),
    'the var(--font-heading) rules should contribute the minority sans votes');
  check('C3 the :root variable rule itself yields no role evidence',
    !usage.evidence.some((e) => /:root/.test(e.selector)));

  // The verbatim real declaration, parsed on its own.
  // The per-(role, family) scoping, on the fixture that isolates it.
  const mixed = ingest.extractFontUsageFromCss(MIXED_CSS);
  check('C3 mixed-family role: the heavier FAMILY wins the role',
    mixed.heading === 'Brand Display', `got ${mixed.heading}`);
  check('C3 [SCOPING] its generic comes from its OWN rules, not the role\'s other family',
    mixed.headingGeneric === 'serif',
    `got ${mixed.headingGeneric} — a role-wide vote would return sans-serif here`);

  check('C3 the verbatim live declaration yields family + generic',
    ingest.genericFamilyIn('Seriously Nostalgic,serif') === 'serif');
  check('C3 a CSS-wide keyword in generic position is skipped',
    ingest.genericFamilyIn('Brand Face,inherit') === null);
  check('C3 quoted families and spacing are handled',
    ingest.genericFamilyIn('"Brand Face" , serif') === 'serif');
  // `!important` is pervasive in Shopify themes and silently killed the
  // generic before this was handled: the last token became "serif!important",
  // which is not a known generic, so the most authoritative declarations on a
  // sheet were the ones whose classification got dropped.
  check('C3 [!important] a priority flag does not swallow the generic',
    ingest.genericFamilyIn('Brand,serif!important') === 'serif');
  check('C3 [!important] with spaces too',
    ingest.genericFamilyIn('Brand, serif !important') === 'serif');
  check('C3 [!important] a generic-only stack is not reported as a family named "serif!important"',
    ingest.extractFontUsageFromCss('.h1{font-family:serif!important}').heading === null);
  check('C3 [!important] the ordinary case is untouched',
    ingest.genericFamilyIn('Brand,serif') === 'serif'
    && ingest.extractFontUsageFromCss('.h1{font-family:Brand,serif}').heading === 'Brand');
  check('C3 an @media-nested rule still yields its inner selector\'s evidence',
    ingest.extractFontUsageFromCss('@media (min-width:700px){.heading-x{font-family:Brand,serif}}')
      .headingGeneric === 'serif');
  check('C3 an uppercase property name is matched',
    ingest.extractFontUsageFromCss('.h1{FONT-FAMILY:Brand,serif}').headingGeneric === 'serif');

  check('C3 familyStackTokens strips quotes and empties',
    JSON.stringify(ingest.familyStackTokens('"A", B ,, serif')) === JSON.stringify(['A', 'B', 'serif']));
}

// ── C4: a role's generic is trusted only for that role's own family ──────
{
  const brand = {
    websiteFontUsage: {
      heading: 'Seriously Nostalgic', headingGeneric: 'serif',
      body: 'Outfit', bodyGeneric: 'sans-serif',
      button: 'Outfit', buttonGeneric: 'sans-serif',
    },
  };
  check('C4 heading family gets the heading generic',
    fc.storedGenericForFamily(brand, 'Seriously Nostalgic') === 'serif');
  check('C4 body family gets the body generic, NOT the heading\'s',
    fc.storedGenericForFamily(brand, 'Outfit') === 'sans-serif');
  check('C4 [MIS-ATTRIBUTION TRAP] an unrelated family gets NO generic',
    fc.storedGenericForFamily(brand, 'Helvetica Neue') === null,
    'a family absent from every role must not inherit another role\'s classification');
  check('C4 matching is case/space insensitive',
    fc.storedGenericForFamily(brand, '  seriously nostalgic ') === 'serif');
  check('C4 missing/!object brand or family is null, never a throw',
    fc.storedGenericForFamily(null, 'X') === null
    && fc.storedGenericForFamily({}, 'X') === null
    && fc.storedGenericForFamily({ websiteFontUsage: 'nope' }, 'X') === null
    && fc.storedGenericForFamily(brand, null) === null);
  check('C4 a role present but with no captured generic is null',
    fc.storedGenericForFamily({ websiteFontUsage: { heading: 'X' } }, 'X') === null);
}

// ── C5: end-to-end through the real static prompt directive ─────────────
const ML_BRAND = {
  websiteFontUsage: {
    heading: 'Seriously Nostalgic', headingGeneric: 'serif',
    body: 'Outfit', bodyGeneric: 'sans-serif',
  },
  customFonts: [{ family: 'Seriously Nostalgic', weight: 400, source: 'website' }],
};
// Same brand as it exists in the DB TODAY — ingested before generics were
// captured, so no *Generic fields. Pins that such brands are untouched.
const ML_BRAND_PRE_BACKFILL = {
  websiteFontUsage: { heading: 'Seriously Nostalgic', body: 'Outfit' },
  customFonts: [{ family: 'Seriously Nostalgic', weight: 400, source: 'website' }],
};
{
  const withGeneric = direct.typefaceDirectiveForBrand(ML_BRAND);
  const without = direct.typefaceDirectiveForBrand(ML_BRAND_PRE_BACKFILL);

  check('C5 [THE FIX, end to end] Marine Layer 2 is instructed SERIF',
    /\ba serif\b/.test(withGeneric) && !/sans-serif/.test(withGeneric), withGeneric);
  check('C5 it still names the brand\'s own family',
    /Seriously Nostalgic/.test(withGeneric));
  check('C5 it keeps the determinism rhetoric verifyStaticTypefaceDeterminism pins',
    /FIXED, NOT A STYLE CHOICE/.test(withGeneric) && /SAME typeface family/.test(withGeneric));
  check('C5 serif brands get the editorial character clause',
    /refined editorial serif proportions/.test(withGeneric));

  check('C5 [NO SILENT BLAST RADIUS] a brand with no captured generic is unchanged (still sans)',
    /a sans-serif/.test(without) && !/\ba serif\b/.test(without), without);
  check('C5 an ingested SANS brand is unaffected by the new tier',
    /a sans-serif/.test(direct.typefaceDirectiveForBrand({
      websiteFontUsage: { heading: 'aktiv-grotesk', headingGeneric: 'sans-serif' },
      customFonts: [{ family: 'aktiv-grotesk', weight: 400 }],
    })));
  check('C5 a keyword-recognised serif brand still classifies serif with no generic at all',
    /\ba serif\b/.test(direct.typefaceDirectiveForBrand({
      customFonts: [{ family: 'Playfair Display', weight: 700 }],
    })));
  check('C5 still deterministic: same brand in -> byte-identical out',
    direct.typefaceDirectiveForBrand(ML_BRAND) === direct.typefaceDirectiveForBrand(ML_BRAND));
  check('C5 still brand-level by construction (arity 1, no surface/concept arg)',
    direct.typefaceDirectiveForBrand.length === 1);
  check('C5 no-font-data brands are untouched by all of this',
    /sans-serif/.test(direct.typefaceDirectiveForBrand({})));
}

// ── C5b: THE blast-radius invariant, stated as a property ───────────────
// No brand that classifies today via a positive keyword match may change
// answer for ANY generic; only brands that were falling through to the bare
// sans default can move. This is the whole safety argument for shipping a
// classification change into the fragile static prompt path.
{
  const FAMILIES = [
    'Playfair Display', 'Lora', 'EB Garamond', 'Cormorant Garamond', 'Merriweather',
    'Zilla Slab', 'Arvo', 'Prata', 'Italiana', 'Cinzel', 'Georgia', 'Times New Roman',
    'aktiv-grotesk', 'Inter', 'Outfit', 'Montserrat', 'Founders Grotesk', 'Helvetica Neue',
    'Seriously Nostalgic', 'Self Modern', 'Domaine Display', 'Unknown Brand Face',
  ];
  const GENERICS = ['serif', 'sans-serif', 'monospace', 'ui-serif', 'ui-sans-serif',
    'cursive', 'fantasy', 'system-ui', 'inherit', null];

  const moved = [];
  for (const family of FAMILIES) {
    const before = fc.classFromFamilyName(family); // the pre-change answer
    const keywordMatched = fc.SERIF_HINTS.test(family);
    for (const generic of GENERICS) {
      const after = fc.classifyTypeface({ family, generic });
      if (after !== before) moved.push({ family, generic, before, after, keywordMatched });
    }
  }
  check('C5b no keyword-matched family EVER changes answer',
    !moved.some((m) => m.keywordMatched),
    JSON.stringify(moved.filter((m) => m.keywordMatched).slice(0, 4)));
  check('C5b every family that DOES move was previously the bare sans default',
    moved.every((m) => m.before === 'sans-serif' && m.after === 'serif'),
    JSON.stringify(moved.filter((m) => !(m.before === 'sans-serif' && m.after === 'serif')).slice(0, 4)));
  check('C5b the movement set is non-empty (the fix actually does something)',
    moved.some((m) => m.family === 'Seriously Nostalgic' && m.generic === 'serif'));
}

// ── C5c: the new *Generic keys must not perturb the VIDEO path ──────────
// fontResolverService.brandSignalText flattens the WHOLE websiteFontUsage
// object — including these new keys and the generics now on each evidence row
// — into the lowercased blob BRAND_SIGNAL_RULES match against. If any rule
// ever matched a generic token, adding a classification field would silently
// change which library face a brand's VIDEO titling picks.
{
  const cats = ['apparel', 'luxury', 'sport', 'tech', 'food', 'playful', 'warm',
    'bold', 'minimal', 'jewelry', 'outdoors', null];
  const tones = ['casual', 'premium', 'bold', 'soft', null];
  const families = ['Seriously Nostalgic', 'Outfit', 'Playfair Display', 'aktiv-grotesk',
    'Self Modern', 'Unknown Face', 'Roboto Mono'];
  // Includes evidence-ROW generics, not just the three top-level keys —
  // brandSignalText flattens the evidence array too, and an earlier version of
  // this sweep only varied the keys while claiming to cover both.
  const evidenceRows = (generic) => ({
    evidence: [
      { family: 'Seriously Nostalgic', role: 'heading', generic, selector: '.heading-1', score: 4 },
      { family: 'Outfit', role: 'body', generic: 'sans-serif', selector: 'body', score: 3 },
    ],
  });
  const generics = [
    { headingGeneric: 'serif', bodyGeneric: 'sans-serif', buttonGeneric: 'sans-serif' },
    { headingGeneric: 'monospace' }, { headingGeneric: 'cursive' },
    { headingGeneric: 'system-ui' }, { headingGeneric: 'fantasy' },
    evidenceRows('serif'), evidenceRows('monospace'), evidenceRows('cursive'),
    { headingGeneric: 'serif', ...evidenceRows('serif') },
  ];
  let compared = 0;
  const perturbed = [];
  for (const category of cats) {
    for (const tone of tones) {
      for (const family of families) {
        for (const role of ['heading', 'body', 'quote']) {
          const mk = (extra) => ({
            category, tone,
            websiteFontUsage: { heading: family, body: 'Outfit', button: 'Outfit', ...extra },
          });
          const base = fontResolver.pickLibraryFamily(family, { brand: mk({}), role });
          for (const extra of generics) {
            const alt = fontResolver.pickLibraryFamily(family, { brand: mk(extra), role });
            compared++;
            if ((base && base.family) !== (alt && alt.family)) {
              perturbed.push({ category, tone, family, role, extra,
                base: base && base.family, alt: alt && alt.family });
            }
          }
        }
      }
    }
  }
  check('C5c the sweep actually ran', compared > 8000, `compared=${compared}`);
  check('C5c adding *Generic keys OR evidence-row generics never changes the video library pick',
    perturbed.length === 0, `${perturbed.length} perturbed, e.g. ${JSON.stringify(perturbed[0])}`);
}

// ── C6: the multi-sheet round-trip preserves the generic ─────────────────
// aggregateFontUsageAcrossSheets re-serialises each sheet's evidence into one
// synthetic stylesheet and re-parses it so a single scorer sees every sheet.
// That round-trip dropped the generic. Tested by CALLING the real function —
// a check that re-implements the round-trip in order to test it would only be
// testing itself (which is exactly what an earlier draft of C7-C did).
{
  const sheets = [
    '.heading-1{font-family:Seriously Nostalgic,serif}',
    '.heading-2{font-family:Seriously Nostalgic,serif}',
    'body{font-family:Outfit,sans-serif}',
    '.btn{font-family:Outfit,sans-serif}',
  ];
  const merged = ingest.aggregateFontUsageAcrossSheets(sheets);
  check('C6 a merged multi-sheet usage object carries headingGeneric',
    merged.headingGeneric === 'serif', `got ${merged.headingGeneric}`);
  check('C6 and keeps each role\'s own family + generic',
    merged.heading === 'Seriously Nostalgic' && merged.body === 'Outfit'
    && merged.bodyGeneric === 'sans-serif' && merged.buttonGeneric === 'sans-serif',
    JSON.stringify(merged));
  check('C6 evidence survives the merge and still carries generics',
    merged.evidence.length === 4 && merged.evidence.every((e) => e.generic));
  check('C6 empty/null input is an empty answer, never a throw',
    ingest.aggregateFontUsageAcrossSheets([]).heading === null
    && ingest.aggregateFontUsageAcrossSheets(null).headingGeneric === null);
  check('C6 ingestBrandFontsInner delegates to it rather than inlining the round-trip',
    /const usage = aggregateFontUsageAcrossSheets\(sheets\.map\(/.test(
      fs.readFileSync(path.join(SERVICES, 'brandFontIngestService.js'), 'utf8')));
}

// ── C8: parser hardening found by adversarial review ───────────────────
// Every case below was a real miss that silently produced NO classification
// (or the wrong one) on shapes that ship on live storefronts.
{
  const headingGeneric = (css) => ingest.extractFontUsageFromCss(css).headingGeneric;
  const headingFamily = (css) => ingest.extractFontUsageFromCss(css).heading;

  // ---- var() must not swallow the rest of the stack. THE big one: this is
  // Shopify Dawn's shape, and Marine Layer is a Shopify store, so the fix was
  // inert on a large share of real brands until this was handled.
  check('C8 [DAWN SHAPE] `var(--f), serif` keeps the trailing generic',
    headingGeneric(':root{--f:"Seriously Nostalgic"}.heading{font-family:var(--f), serif}') === 'serif');
  check('C8 `var(--f), serif` still resolves the family',
    headingFamily(':root{--f:"Seriously Nostalgic"}.heading{font-family:var(--f), serif}')
      === 'Seriously Nostalgic');
  check('C8 a var() in the FALLBACK slot resolves too',
    headingGeneric('.heading{font-family:Seriously Nostalgic, var(--fb, serif)}') === 'serif');
  check('C8 a CHAINED custom property resolves through to the real stack',
    headingGeneric(':root{--a:Seriously Nostalgic, serif;--b:var(--a)}.heading{font-family:var(--b)}')
      === 'serif');
  check('C8 a chained property no longer stores a literal `var(...)` as the family',
    headingFamily(':root{--a:Seriously Nostalgic, serif;--b:var(--a)}.heading{font-family:var(--b)}')
      === 'Seriously Nostalgic');
  check('C8 an UNRESOLVABLE var is dropped, never kept as a concrete family',
    headingFamily('.heading{font-family:var(--missing)}') === null);
  check('C8 a var() CYCLE terminates instead of hanging',
    headingFamily(':root{--a:var(--b);--b:var(--a)}.heading{font-family:var(--a), serif}') === null);
  check('C8 an unresolvable var alongside a real family keeps the family + generic',
    headingFamily('.heading{font-family:var(--missing), Brand Face, serif}') === 'Brand Face'
    && headingGeneric('.heading{font-family:var(--missing), Brand Face, serif}') === 'serif');

  // ---- !important must be stripped AFTER substitution, not only before.
  check('C8 `!important` INSIDE a custom property value still yields the generic',
    headingGeneric(':root{--f:Brand, serif !important}.heading{font-family:var(--f)}') === 'serif');

  // ---- the generic is the stack's TERMINAL fallback, not the first one seen.
  check('C8 a stack opening with a generic does not classify from it',
    headingGeneric('.heading{font-family:sans-serif, "Seriously Nostalgic", serif}') === 'serif',
    'the leading sans-serif is not the Didone\'s fallback');
  check('C8 a mid-stack monospace does not beat the terminal serif',
    ingest.genericFamilyIn('Brand Serif, monospace, serif') === 'serif');
  check('C8 the terminal generic wins among several signalling ones',
    ingest.genericFamilyIn('Brand, ui-sans-serif, sans-serif') === 'sans-serif');
  check('C8 a stack whose only generic carries no signal is still recorded faithfully',
    ingest.genericFamilyIn('Brand, monospace') === 'monospace');
  check('C8 ...and such a brand therefore falls through to the name heuristic',
    fc.classifyTypeface({ family: 'Brand', generic: 'monospace' }) === 'sans-serif');
  check('C8 a CSS-wide keyword is never returned as the generic',
    ingest.genericFamilyIn('Brand, inherit') === null);

  // ---- family keys must be normalised identically on both sides.
  check('C8 normalizeFamilyKey collapses internal whitespace',
    fc.normalizeFamilyKey('  Seriously   Nostalgic ') === 'seriously nostalgic');
  const doubleSpaced = ingest.extractFontUsageFromCss('.heading{font-family:Seriously   Nostalgic, serif}');
  check('C8 [KEY MISMATCH] a double-spaced declaration is still looked up by the @font-face name',
    fc.storedGenericForFamily({ websiteFontUsage: doubleSpaced }, 'Seriously Nostalgic') === 'serif',
    'ingest captured the generic under a key the consumer could not find');
  check('C8 ...and the static directive therefore says serif',
    /\ba serif\b/.test(direct.typefaceDirectiveForBrand({
      websiteFontUsage: doubleSpaced,
      customFonts: [{ family: 'Seriously Nostalgic', weight: 400 }],
    })));

  // ---- a family used in several roles: take the role that HAS a generic.
  check('C8 a later role\'s generic is used when the earlier role recorded none',
    fc.storedGenericForFamily({
      websiteFontUsage: { heading: 'Seriously Nostalgic', body: 'Seriously Nostalgic', bodyGeneric: 'serif' },
    }, 'Seriously Nostalgic') === 'serif');
  check('C8 ...without weakening the mis-attribution guard',
    fc.storedGenericForFamily({
      websiteFontUsage: { heading: 'A', headingGeneric: 'serif', body: 'B', bodyGeneric: 'sans-serif' },
    }, 'B') === 'sans-serif');

  // ---- a system font stack declares NO brand face. Its only non-generic
  // entries are the emoji fallbacks every modern CSS reset appends, and once
  // custom properties resolve properly those become the "first concrete
  // family" — plausible junk that would be stored as the brand's typeface.
  const SYSTEM_STACK = 'ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji"';
  check('C8 [PLAUSIBLE JUNK] a system stack yields no brand family, not the emoji font',
    headingFamily(`.heading{font-family:${SYSTEM_STACK}}`) === null,
    'an emoji fallback must never be recorded as a brand typeface');
  check('C8 the -apple-system / BlinkMacSystemFont aliases likewise',
    headingFamily('.heading{font-family:-apple-system,BlinkMacSystemFont,sans-serif}') === null);
  check('C8 ...but a REAL face followed by emoji fallbacks still resolves',
    headingFamily('.heading{font-family:Outfit,sans-serif,"Apple Color Emoji"}') === 'Outfit'
    && headingGeneric('.heading{font-family:Outfit,sans-serif,"Apple Color Emoji"}') === 'sans-serif');

  // ---- the backfill must share ingest's sheet collection, not re-roll it.
  const backfillSrc = fs.readFileSync(path.join(__dirname, 'backfillBrandFontGenerics.js'), 'utf8');
  check('C8 the backfill uses ingest\'s collectStylesheets (which follows @import)',
    /collectStylesheets\(html, pageUrl\)/.test(backfillSrc)
    && /aggregateFontUsageAcrossSheets\(/.test(backfillSrc),
    'a backfill that collects a different sheet set writes values ingest would not');
  check('C8 the backfill writes each field CONDITIONALLY on it still being unset',
    /\[`websiteFontUsage\.\$\{field\}`\]: \{ \$in: \[null, ''\] \}/.test(backfillSrc),
    'an unconditional $set can clobber a concurrent re-ingest');
  check('C8 collectStylesheets is exported and follows @import',
    typeof ingest.collectStylesheets === 'function'
    && /@import/.test(fs.readFileSync(path.join(SERVICES, 'brandFontIngestService.js'), 'utf8')));
}

// ─────────────────────────────────────────────────────────────────────────
// C7: REVERT-PROOF. Mutate the REAL shipped source, re-require it, and
// assert a specific check above actually breaks. A check that cannot fail
// proves nothing.
//
// Mutations run against a temp copy inside services/ so relative requires
// still resolve, and are removed in a finally block.
// ─────────────────────────────────────────────────────────────────────────
/**
 * Load a MUTATED copy of a real service ENTIRELY IN MEMORY — nothing is ever
 * written to disk, inside the repo or out of it.
 *
 * This is deliberately stronger than the convention #259 established
 * (2026-08-19: three verify scripts were rewriting a mutated copy of a real
 * shared repo file IN PLACE to revert-prove a static check, and a SIGTERM
 * landing between the mutating write and the restore leaves the real file
 * mutated on disk, because Node runs no `finally` for an unhandled SIGTERM —
 * see session.d/2026-08-19_verify-script-real-file-mutation-fixed-not-just-
 * quarantined.md). #259's fix was to write the copy under os.tmpdir()
 * instead. Compiling in memory needs no temp path at all, so there is no
 * window in which a signal can leave residue anywhere.
 *
 * `Module#_compile(source, filename)` resolves the module's own relative
 * `require('./x')` calls against `path.dirname(filename)`. Pointing filename
 * at the REAL services/ path therefore lets a mutated brandFontIngestService
 * pull in its real siblings (axios, ./cloudinaryService, ./fontClassification)
 * unchanged, while the code under test is the mutant. The Module is
 * constructed directly rather than via require(), so it never enters
 * require.cache and cannot leak into the un-mutated modules loaded above.
 */
function loadMutated(fileName, mutate) {
  const realPath = path.join(SERVICES, fileName);
  const src = fs.readFileSync(realPath, 'utf8');
  const mutated = mutate(src);
  if (mutated === src) {
    throw new Error(`mutation was a no-op for ${fileName} — the anchor text moved, so this ` +
      'revert-proof is silently testing the UNMUTATED module');
  }
  const m = new Module(`mutated:${fileName}`, null);
  m.filename = realPath;
  m.paths = Module._nodeModulePaths(SERVICES);
  m._compile(mutated, realPath);
  return m.exports;
}

const withMutatedModule = (fileName, mutate, fn) => fn(loadMutated(fileName, mutate));
const withMutatedClassifier = (mutate, fn) => fn(loadMutated('fontClassification.js', mutate));

// C7-A — neuter the first-party tier: the ORIGINAL DEFECT must come back.
try {
  withMutatedClassifier(
    (src) => src.replace(
      "return classFromGeneric(generic) || 'sans-serif';",
      "return 'sans-serif';"
    ),
    (mut) => {
      check('C7-A revert-proof: dropping the generic tier makes Seriously Nostalgic sans again',
        mut.classifyTypeface({ family: 'Seriously Nostalgic', generic: 'serif' }) === 'sans-serif',
        'C1/C5 cannot fail — the generic tier is not what produces the serif answer');
      check('C7-A the shipped module disagrees with the mutant (so C1 discriminates)',
        fc.classifyTypeface({ family: 'Seriously Nostalgic', generic: 'serif' }) === 'serif');
    }
  );
} catch (err) { failures.push(`C7-A mutation harness failed: ${err.message}`); }

// C7-B — remove the role/family guard: mis-attribution must appear.
try {
  withMutatedClassifier(
    (src) => src.replace(
      'if (normalizeFamilyKey(usage[role]) !== want) continue;',
      'if (!usage[role]) continue;'
    ),
    (mut) => {
      const brand = {
        websiteFontUsage: {
          heading: 'Seriously Nostalgic', headingGeneric: 'serif',
          body: 'Outfit', bodyGeneric: 'sans-serif',
        },
      };
      check('C7-B revert-proof: without the guard, the body grotesque inherits the heading serif',
        mut.storedGenericForFamily(brand, 'Outfit') === 'serif',
        `got ${mut.storedGenericForFamily(brand, 'Outfit')} — C4 cannot fail, the family guard ` +
        'is not what prevents mis-attribution');
      check('C7-B the shipped module keeps them separate (so C4 discriminates)',
        fc.storedGenericForFamily(brand, 'Outfit') === 'sans-serif');
    }
  );
} catch (err) { failures.push(`C7-B mutation harness failed: ${err.message}`); }

// C7-C — drop the generic from the REAL aggregation round-trip, then call the
// REAL aggregator. (An earlier draft mutated this line but then re-implemented
// the round-trip inside the check, so the assertion passed because the TEST
// omitted the generic, not because the mutation did — a tautology. Caught in
// adversarial review; the fix was to make the round-trip a callable function.)
try {
  withMutatedModule('brandFontIngestService.js',
    (src) => src.replace(
      ".map((e) => `${e.selector}{font-family:\"${e.family}\"${e.generic ? `,${e.generic}` : ''}}`)",
      '.map((e) => `${e.selector}{font-family:"${e.family}"}`)'
    ),
    (mut) => {
      const sheets = [
        '.heading-1{font-family:Seriously Nostalgic,serif}',
        '.heading-2{font-family:Seriously Nostalgic,serif}',
      ];
      const mutated = mut.aggregateFontUsageAcrossSheets(sheets);
      check('C7-C revert-proof: the un-fixed round-trip loses headingGeneric entirely',
        mutated.headingGeneric == null,
        `got ${mutated.headingGeneric} — C6 cannot fail`);
      check('C7-C the mutant still finds the FAMILY (only the generic is lost)',
        mutated.heading === 'Seriously Nostalgic',
        'if the family is lost too, the mutation is too broad to isolate the generic');
      check('C7-C the shipped aggregator keeps it (so C6 discriminates)',
        ingest.aggregateFontUsageAcrossSheets(sheets).headingGeneric === 'serif');
    }
  );
} catch (err) { failures.push(`C7-C mutation harness failed: ${err.message}`); }

// C7-E — drop the !important strip: the generic must go missing again.
try {
  withMutatedModule('brandFontIngestService.js',
    (src) => src.split(".replace(/!\\s*important\\s*$/i, '')").join(''),
    (mut) => {
      check('C7-E revert-proof: without the strip, "serif!important" is not seen as a generic',
        mut.genericFamilyIn('Brand,serif!important') === null,
        `got ${mut.genericFamilyIn('Brand,serif!important')} — the C3 !important checks cannot fail`);
      check('C7-E the shipped parser does see it (so C3 discriminates)',
        ingest.genericFamilyIn('Brand,serif!important') === 'serif');
    }
  );
} catch (err) { failures.push(`C7-E mutation harness failed: ${err.message}`); }

// C7-D — vote generics per ROLE instead of per (role, family). On the real
// Marine Layer distribution this is the arbitrary 72-vs-72 tie.
try {
  withMutatedModule('brandFontIngestService.js',
    (src) => src.replace(
      '      if (normalizeFamilyKey(item.family) !== want) continue;\n',
      ''
    ),
    (mut) => {
      // Marine Layer reaches 'serif' under EITHER scheme, so it cannot
      // discriminate. MIXED_CSS is the fixture that can.
      const mlEither = mut.extractFontUsageFromCss(ML_CSS);
      check('C7-D role-only voting still gets Marine Layer right (so ML cannot prove the scoping)',
        mlEither.headingGeneric === 'serif',
        `got ${mlEither.headingGeneric}; if this ever changes, ML alone would suffice`);

      const usage = mut.extractFontUsageFromCss(MIXED_CSS);
      check('C7-D revert-proof: role-only voting mis-classifies the serif display face as sans',
        usage.headingGeneric === 'sans-serif',
        `role-only voting returned "${usage.headingGeneric}" — expected the other family's ` +
        'sans-serif to win; if it does not, the C3 scoping check cannot fail');
      check('C7-D the shipped per-family scoping keeps it serif (so C3 discriminates)',
        ingest.extractFontUsageFromCss(MIXED_CSS).headingGeneric === 'serif');
    }
  );
} catch (err) { failures.push(`C7-D mutation harness failed: ${err.message}`); }

// C7-F — restore the old "var() at the start replaces the whole value"
// behaviour: the Dawn shape must lose its trailing generic again.
try {
  withMutatedModule('brandFontIngestService.js',
    // The old code ASSIGNED the variable's value over the whole declaration
    // value (`value = variables[ref]`), rather than substituting in place —
    // which is precisely why everything after the reference was lost.
    (src) => src.replace(
      '  const value = resolveCssVars(String(raw), variables)',
      "  const __m = String(raw).match(/^var\\(\\s*(--[a-z0-9_-]+)(?:\\s*,\\s*([^)]+))?\\)/i);\n"
      + "  const value = (__m ? (variables[__m[1]] || __m[2] || '') : String(raw))"
    ),
    (mut) => {
      const dawn = ':root{--f:"Seriously Nostalgic"}.heading{font-family:var(--f), serif}';
      check('C7-F revert-proof: whole-value var substitution drops the trailing generic',
        mut.extractFontUsageFromCss(dawn).headingGeneric == null,
        `got ${mut.extractFontUsageFromCss(dawn).headingGeneric} — the C8 Dawn checks cannot fail`);
      check('C7-F the mutant still finds the family (so the mutation isolates the generic)',
        mut.extractFontUsageFromCss(dawn).heading === 'Seriously Nostalgic');
      check('C7-F the shipped resolver keeps it (so C8 discriminates)',
        ingest.extractFontUsageFromCss(dawn).headingGeneric === 'serif');
    }
  );
} catch (err) { failures.push(`C7-F mutation harness failed: ${err.message}`); }

// C7-G — restore "first generic anywhere": a stack opening with a generic must
// mis-classify again.
try {
  withMutatedModule('brandFontIngestService.js',
    (src) => src.replace(
      '  const firstConcrete = tokens.findIndex((t) => !GENERIC_FAMILIES.has(t.toLowerCase()));',
      '  const firstConcrete = -1;'
    ),
    (mut) => {
      // Isolates the POSITION filter specifically: a stack that opens with a
      // generic and has none after the family. With the filter that is "no
      // fallback stated"; without it the leading token is mistaken for one.
      const opening = 'sans-serif, "Seriously Nostalgic"';
      check('C7-G revert-proof: without the position filter a LEADING generic is taken as the fallback',
        mut.genericFamilyIn(opening) === 'sans-serif',
        `got ${mut.genericFamilyIn(opening)}`);
      check('C7-G the shipped parser reports no fallback there (so C8 discriminates)',
        ingest.genericFamilyIn(opening) === null);
    }
  );
} catch (err) { failures.push(`C7-G mutation harness failed: ${err.message}`); }

// C7-I — take the FIRST signalling generic instead of the terminal one: a
// stack with two conflicting signalling generics resolves the wrong way.
try {
  withMutatedModule('brandFontIngestService.js',
    (src) => src.replace(
      '  for (let i = candidates.length - 1; i >= 0; i--) {',
      '  for (let i = 0; i < candidates.length; i++) {'
    ),
    (mut) => {
      const conflicting = 'Brand Face, serif, sans-serif';
      check('C7-I revert-proof: first-signalling order returns the non-terminal generic',
        mut.genericFamilyIn(conflicting) === 'serif',
        `got ${mut.genericFamilyIn(conflicting)}`);
      check('C7-I the shipped parser takes the author\'s ultimate fallback',
        ingest.genericFamilyIn(conflicting) === 'sans-serif');
    }
  );
} catch (err) { failures.push(`C7-I mutation harness failed: ${err.message}`); }

// C7-J — stop excluding the emoji/system fallbacks: a system stack starts
// reporting an emoji font as the brand's typeface again.
try {
  withMutatedModule('brandFontIngestService.js',
    (src) => src.replace(
      '    if (GENERIC_FAMILIES.has(lower) || NON_BRAND_FAMILIES.has(lower)) continue;',
      '    if (GENERIC_FAMILIES.has(lower)) continue;'
    ),
    (mut) => {
      const css = `.heading{font-family:${'ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji"'}}`;
      check('C7-J revert-proof: without the exclusion the emoji font becomes the brand face',
        mut.extractFontUsageFromCss(css).heading === 'Apple Color Emoji',
        `got ${mut.extractFontUsageFromCss(css).heading}`);
      check('C7-J the shipped parser reports no family (so C8 discriminates)',
        ingest.extractFontUsageFromCss(css).heading === null);
    }
  );
} catch (err) { failures.push(`C7-J mutation harness failed: ${err.message}`); }

// C7-H — remove the whitespace collapse: the stored key stops matching the
// @font-face name the consumer looks up.
try {
  withMutatedClassifier(
    (src) => src.replace(
      "return String(family || '').trim().replace(/\\s+/g, ' ').toLowerCase();",
      "return String(family || '').trim().toLowerCase();"
    ),
    (mut) => {
      const usage = ingest.extractFontUsageFromCss('.heading{font-family:Seriously   Nostalgic, serif}');
      check('C7-H revert-proof: without the collapse the double-spaced key is unfindable',
        mut.storedGenericForFamily({ websiteFontUsage: usage }, 'Seriously Nostalgic') === null,
        'the C8 key-mismatch check cannot fail');
      check('C7-H the shipped key finds it (so C8 discriminates)',
        fc.storedGenericForFamily({ websiteFontUsage: usage }, 'Seriously Nostalgic') === 'serif');
    }
  );
} catch (err) { failures.push(`C7-H mutation harness failed: ${err.message}`); }

// The mutation harness must leave NO residue — in the repo or the temp dir.
// (#259's convention is "not in the repo"; this harness writes nothing at all,
// so assert the stronger property: the services dir is byte-for-byte the
// checked-out tree, and no temp copy of these modules exists either.)
{
  const strays = fs.readdirSync(SERVICES)
    .filter((f) => /^\.?__?mutation|\.(tmp|bak|orig)$/i.test(f));
  check('C7 no mutation residue in services/', strays.length === 0, strays.join(', '));

  const tmpStrays = fs.readdirSync(os.tmpdir())
    .filter((f) => /verifyTypefaceClassification/i.test(f));
  check('C7 no mutation residue in os.tmpdir()', tmpStrays.length === 0, tmpStrays.join(', '));

  // The real modules must be untouched: re-read and re-run one assertion that
  // a mutated module would have broken.
  check('C7 the real classifier still behaves post-mutation (no in-place edit)',
    fc.classifyTypeface({ family: 'Seriously Nostalgic', generic: 'serif' }) === 'serif');
  check('C7 the real ingest module still behaves post-mutation',
    ingest.extractFontUsageFromCss(ML_CSS).headingGeneric === 'serif');
}

if (failures.length) {
  console.error(`\n❌ typeface classification: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ typeface classification: ${pass} checks passed`);
