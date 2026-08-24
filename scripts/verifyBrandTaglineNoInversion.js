#!/usr/bin/env node
/**
 * Offline harness for the brand-tagline / productName-slot fitter defect
 * (2026-08-24). No DB, no network, no API key — drives the real exported
 * functions from titleSpecValidator.js, metaCascadeResolver.js, and
 * remotion/lib/slotContent.js, never a source-text scan.
 *
 * THE DEFECT. `Brand.tagline` is drafted at "≤ 12 words" of marketing prose
 * (brandEnrichmentService.js gpt-derivation prompt — no video-box reference
 * at all). On any brand-mode endcard (`ad.productId` falsy — a normal,
 * live ad shape, see brandScriptExecutor.js `endcardMode = ad.productId ?
 * 'product' : 'brand'`), titleSpecValidator's DEFAULT_BRAND_MODE_BIND
 * substitutes that tagline into the slot KEYED `productName`
 * (`productName: ['brandTagline', 'headline']` — present since the very
 * first Remotion titling commit, i.e. NOT a recent regression). This is
 * the DEFAULT for every spec that doesn't override brandModeBind, and the
 * real preset (remotion/presets/canonical.json byFormat.{vertical,feed,
 * square}) does not override it — Group A proves this with the REAL
 * validator, not a hand-built fixture.
 *
 * Separately (backend PR #254, added ~a month later, for an unrelated
 * mid-word-SKU-title bug) `fitProductNameToCap` was added and dispatched
 * purely on `slot.key === 'productName'`. Its own docstring says it exists
 * because a CATALOG TITLE reads as "[modifiers][noun]" — dropping leading
 * words trades adjectives for legibility while the noun that identifies
 * the product survives. A brand tagline is prose, not that shape. Because
 * dispatch keyed on slot.key instead of content provenance, a substituted
 * tagline got the noun-preserving front-word-dropping fitter meant for
 * catalog titles — and dropping a tagline's OPENING words can flip its
 * meaning when that opening carries a negation or qualifier ("Not for
 * everyone…" -> "for everyone…"), not just shorten it.
 *
 * THE FIX (src/remotion/lib/slotContent.js resolveSlotContentCore): the
 * fitter dispatch now also requires `entry === 'productName'` — i.e. the
 * WINNING BIND-CHAIN ENTRY that actually supplied the text must be the
 * `productName` meta field (real catalog title), not merely the slot key
 * it renders into. A brandModeBind-substituted tagline (entry ===
 * 'brandTagline' or 'headline') now falls through to the same plain
 * tail-safe `truncateWordSafe` every other prose slot (quote, headline,
 * tagline) already used. Real catalog titles are untouched — Group D
 * (regression guard) proves the noun-preserving behavior BOTH slot key
 * AND entry are 'productName'.
 *
 * Groups:
 *   A  Reachability — a preset-shaped productName slot (no authored
 *      bind/brandModeBind, mirroring canonical.json) normalizes via the
 *      REAL validateTitleSpec to brandMode:'keep' +
 *      brandModeBind:['brandTagline','headline'] — the substitution is
 *      the DEFAULT, not something an operator must opt into.
 *   B  End-to-end meta plumbing — the REAL metaCascadeResolver.resolveMeta
 *      (fed via the REAL buildContext) delivers Brand.tagline verbatim,
 *      unshortened, into meta.brandTagline. Nothing upstream of the slot
 *      resolver ever caps it.
 *   C  Worst-case harm at the CONTENT level — fitProductNameToCap (still
 *      exported, still used for real catalog titles) genuinely inverts a
 *      negation-led tagline at the historical cap (48) and mangles it
 *      further at the floor (24); truncateWordSafe on the identical input
 *      does not.
 *   D  The fix, driven end-to-end through resolveSlotContentCore with the
 *      REAL normalized spec + REAL resolved meta: a brand-mode tagline
 *      substitution now renders via truncateWordSafe (negation preserved,
 *      ellipsis tail) at both cap and floor; a genuine catalog productName
 *      in product mode is UNCHANGED — still gets the noun-preserving fit.
 *   E  Sweep — five more realistic 12-word-class taglines; none of them
 *      ever match fitProductNameToCap's output when substituted, all of
 *      them match truncateWordSafe's, at both cap and floor.
 *   F  Provenance edge case — a literal fallback bind entry for the
 *      productName slot (operator-authored constant, not a catalog title)
 *      also does not get the noun-preserving fitter.
 *
 * Run: node scripts/verifyBrandTaglineNoInversion.js
 */
'use strict';

const { validateTitleSpec } = require('../src/services/titleSpecValidator');
const { resolveMeta, buildContext, DEFAULT_META_CASCADES } = require('../src/services/metaCascadeResolver');
const {
  resolveSlotContentCore, fitProductNameToCap, truncateWordSafe,
  TEXT_CHAR_CAP, TEXT_CHAR_FLOOR,
} = require('../src/remotion/lib/slotContent.js');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const CAP = TEXT_CHAR_CAP.productName;
const FLOOR = TEXT_CHAR_FLOOR.productName;
check('sanity: productName cap/floor are the documented 48/24', CAP === 48 && FLOOR === 24,
  `got cap=${CAP} floor=${FLOOR}`);

// A preset-shaped productName slot mirroring remotion/presets/canonical.json
// byFormat.vertical — NO authored bind/brandModeBind, same as the real file.
function presetProductNameSlot() {
  return {
    key: 'productName',
    phase: 'close',
    position: { anchor: 'lowerThird', align: 'left', maxWidthPct: 0.9 },
    timing: { enterAtSec: 5.1, exitAtSec: null, enterDurationSec: 0.7 },
    transition: { type: 'fade' },
    treatment: {
      scrim: 'none', shadow: 'layered', casing: 'none', fontRole: 'heading',
      weight: 600, maxLines: 2, sizeScale: 1.2,
    },
  };
}
function specWith(slot) {
  return {
    version: 1,
    phases: [{ key: 'close', startSec: 5, endSec: 8 }],
    slots: [slot],
  };
}

// ── Group A: reachability from the REAL validator ───────────────────────
{
  const { ok, errors, normalized } = validateTitleSpec(specWith(presetProductNameSlot()), { format: 'vertical' });
  check('A1 preset-shaped spec validates clean', ok === true, JSON.stringify(errors));
  const slot = normalized && normalized.slots[0];
  check('A2 normalized bind defaults to the catalog productName field',
    !!slot && Array.isArray(slot.bind) && slot.bind.length === 1 && slot.bind[0] === 'productName',
    JSON.stringify(slot && slot.bind));
  check('A3 normalized brandMode is "keep" (productName is NOT hidden on a brand-mode endcard)',
    !!slot && slot.brandMode === 'keep', `got ${slot && slot.brandMode}`);
  check('A4 [THE WIRING] normalized brandModeBind DEFAULTS to substituting brandTagline (then headline) into this slot — an author does not opt into this, it is silent',
    !!slot && Array.isArray(slot.brandModeBind)
    && slot.brandModeBind[0] === 'brandTagline' && slot.brandModeBind[1] === 'headline',
    JSON.stringify(slot && slot.brandModeBind));
}

// ── Group B: real meta-cascade plumbing delivers the tagline verbatim ───
const WORST_CASE_TAGLINE = 'Not for everyone, built for those who refuse to quit';
{
  const ctx = buildContext({ brand: { tagline: WORST_CASE_TAGLINE, name: 'Acme Outfitters' } });
  const meta = resolveMeta(DEFAULT_META_CASCADES, ctx);
  check('B1 meta.brandTagline resolves from Brand.tagline via the real cascade',
    meta.brandTagline === WORST_CASE_TAGLINE, JSON.stringify(meta.brandTagline));
  check('B2 meta.brandTagline is BYTE-IDENTICAL to the source — nothing upstream shortens or rewrites it',
    meta.brandTagline.length === WORST_CASE_TAGLINE.length);
  // headline cascade (metaCascadeConfig.js) also falls back to brand.tagline
  // when no ad/layoutInput headline exists — confirms the SECOND
  // brandModeBind tier ('headline') is not a safe alternate either; it can
  // resolve to the identical unbounded tagline text.
  check('B3 [THE SECOND TIER IS NOT A SAFETY NET] with no ad/layoutInput headline, meta.headline ALSO resolves to the same raw tagline',
    meta.headline === WORST_CASE_TAGLINE, JSON.stringify(meta.headline));
}

// ── Group C: worst-case harm at the content level (fitProductNameToCap) ─
{
  const atCap = fitProductNameToCap(WORST_CASE_TAGLINE, CAP);
  const atFloor = fitProductNameToCap(WORST_CASE_TAGLINE, FLOOR);
  check('C1 [THE DEFECT, isolated] fitProductNameToCap at the historical cap (48) drops the leading "Not" and INVERTS the claim',
    atCap === 'for everyone, built for those who refuse to quit', JSON.stringify(atCap));
  check('C2 the inverted string asserts the literal OPPOSITE of the source ("for everyone" vs "Not for everyone")',
    WORST_CASE_TAGLINE.startsWith('Not ') && atCap.startsWith('for everyone'));
  check('C3 fitProductNameToCap at the floor (24) drops even more of the qualifying clause',
    atFloor === 'those who refuse to quit', JSON.stringify(atFloor));
  const safeAtCap = truncateWordSafe(WORST_CASE_TAGLINE, CAP);
  const safeAtFloor = truncateWordSafe(WORST_CASE_TAGLINE, FLOOR);
  check('C4 truncateWordSafe on the IDENTICAL input preserves the negation at cap (tail-ellipsis, not front-drop)',
    safeAtCap.startsWith('Not for everyone') && safeAtCap === 'Not for everyone, built for those who refuse to…',
    JSON.stringify(safeAtCap));
  check('C5 truncateWordSafe preserves the negation even at the floor',
    safeAtFloor.startsWith('Not for everyone') && safeAtFloor === 'Not for everyone, built…', JSON.stringify(safeAtFloor));
  check('C6-revert-prove: the two fitters genuinely disagree on this input at both cap and floor (not a vacuous comparison)',
    atCap !== safeAtCap && atFloor !== safeAtFloor);
}

// ── Group D: the fix, driven end-to-end via resolveSlotContentCore ──────
{
  const { normalized } = validateTitleSpec(specWith(presetProductNameSlot()), { format: 'vertical' });
  const slot = normalized.slots[0];

  // D1/D2: brand-mode endcard — tagline substituted into the productName
  // slot. Resolver must choose truncateWordSafe (content-aware), not
  // fitProductNameToCap (slot-key-only), at both cap and floor.
  const brandMeta = { endcardMode: 'brand', brandTagline: WORST_CASE_TAGLINE, headline: WORST_CASE_TAGLINE };
  const renderedAtCap = resolveSlotContentCore(slot, brandMeta);
  check('D1 [THE FIX] brand-mode render at the historical cap (48) preserves the negation — no ctx passed, so deriveCharCap returns the raw TEXT_CHAR_CAP.productName (48) unmodified',
    renderedAtCap === 'Not for everyone, built for those who refuse to…', JSON.stringify(renderedAtCap));
  check('D2 [THE FIX, negative form] brand-mode render is NOT the inverted fitProductNameToCap output',
    renderedAtCap !== fitProductNameToCap(WORST_CASE_TAGLINE, CAP));

  const renderedAtFloor = resolveSlotContentCore(slot, brandMeta, {
    format: 'vertical', usableWidthPx: 1, maxLines: 1, fontPx: 10000,
  });
  // Pin an absurdly tight box so deriveCharCap bottoms out at the floor
  // (24) rather than the cap — proves the fix holds at the worst-case
  // (smallest) real cap too, not just the historical default.
  check('D3 an absurdly narrow box derives down to the documented floor (24), confirming this run actually exercised the floor',
    (() => {
      const cap = require('../src/remotion/lib/slotContent.js').deriveCharCap('productName', {
        format: 'vertical', usableWidthPx: 1, maxLines: 1, fontPx: 10000,
      });
      return cap === FLOOR;
    })());
  check('D4 [THE FIX @ floor] brand-mode render at the floor still preserves the negation',
    renderedAtFloor === 'Not for everyone, built…', JSON.stringify(renderedAtFloor));
  check('D5 [THE FIX, negative form @ floor] not the inverted/mangled fitProductNameToCap floor output',
    renderedAtFloor !== fitProductNameToCap(WORST_CASE_TAGLINE, FLOOR));

  // D6/D7: REGRESSION GUARD — a genuine catalog product name, in PRODUCT
  // mode (brandModeBind never consulted), must still get the
  // noun-preserving fitter. The fix must not have disabled the original
  // 2026-08-19 feature for the case it was actually built for.
  const CATALOG_TITLE = 'Vintage Oversized Denim Jacket With Extra Long Sleeves';
  const productMeta = { endcardMode: 'product', productName: CATALOG_TITLE };
  const productRendered = resolveSlotContentCore(slot, productMeta);
  check('D6 [REGRESSION GUARD] a real catalog productName in product mode still gets the noun-preserving fit (leading modifier dropped, no ellipsis, trailing noun intact)',
    productRendered === 'Oversized Denim Jacket With Extra Long Sleeves', JSON.stringify(productRendered));
  check('D7 [REGRESSION GUARD] matches fitProductNameToCap called directly on the same input/cap',
    productRendered === fitProductNameToCap(CATALOG_TITLE, CAP));
}

// ── Group E: sweep — more realistic taglines, same guarantee ────────────
{
  const { normalized } = validateTitleSpec(specWith(presetProductNameSlot()), { format: 'vertical' });
  const slot = normalized.slots[0];
  const TAGLINES = [
    'No shortcuts, no compromises, just gear that actually works',
    'Never the cheapest, always the one still standing',
    'Not fast fashion, just fashion that actually lasts forever',
    "We don't do ordinary, we do extraordinary every single day",
    'Rarely first, always the best when it finally arrives',
  ];
  for (const tagline of TAGLINES) {
    const meta = { endcardMode: 'brand', brandTagline: tagline };
    const atCap = resolveSlotContentCore(slot, meta);
    const atFloor = resolveSlotContentCore(slot, meta, {
      format: 'vertical', usableWidthPx: 1, maxLines: 1, fontPx: 10000,
    });
    check(`E cap: "${tagline.slice(0, 24)}…" resolves via truncateWordSafe, not fitProductNameToCap`,
      atCap === truncateWordSafe(tagline, CAP) && atCap !== fitProductNameToCap(tagline, CAP),
      `got ${JSON.stringify(atCap)}`);
    check(`E floor: "${tagline.slice(0, 24)}…" resolves via truncateWordSafe, not fitProductNameToCap`,
      atFloor === truncateWordSafe(tagline, FLOOR) && atFloor !== fitProductNameToCap(tagline, FLOOR),
      `got ${JSON.stringify(atFloor)}`);
  }
}

// ── Group F: literal fallback entries are not catalog titles either ─────
{
  const literalSlot = {
    ...presetProductNameSlot(),
    bind: [{ literal: 'Shop the whole collection today' }],
  };
  const { ok, normalized } = validateTitleSpec(specWith(literalSlot), { format: 'vertical' });
  check('F1 a literal bind entry validates', ok === true);
  const slot = normalized.slots[0];
  const rendered = resolveSlotContentCore(slot, { endcardMode: 'product' });
  check('F2 [PROVENANCE, not slot key] an operator-authored literal in the productName slot is NOT run through the noun-preserving fitter',
    rendered === truncateWordSafe('Shop the whole collection today', CAP), JSON.stringify(rendered));
}

if (failures.length) {
  console.error(`\n❌ brand-tagline-slot no-inversion: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ brand-tagline-slot no-inversion: ${pass} checks passed`);
