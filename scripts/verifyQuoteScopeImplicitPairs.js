#!/usr/bin/env node
'use strict';

/**
 * verifyQuoteScopeImplicitPairs — a brand-tier quote that never names a
 * garment can still be about ONE specific product, not the brand as a
 * whole ("I've got two pairs of these" never says "pants" or "shoes").
 *
 * DEFECT (measured live 2026-08-31, ad 6a9600196c6bffaf965a99e9): brand
 * "Pelagic Gear 4 Demos", product "Rusted Icon" (a T-Shirt) had zero
 * product/category/comment-tier reviews, so QUOTE_BRAND_TIER_FALLBACK let
 * the brand's llm-web review pool win last-resort. That pool's quote
 * "I've got two pairs of these and they fit great, are tough and
 * comfortable. Highly recommended." printed on the t-shirt ad, even though
 * the identical text is a genuine review of "Flyline Stretch Pant" (pants)
 * elsewhere in the same catalog. quoteAllowedForScope's noun-scope gate
 * (services/quoteProvenance.js) found ZERO tracked garment nouns in the
 * quote text ("pairs"/"these" name nothing) and treated that as the
 * GENERIC "safe anywhere" case — the same bucket as "I love this brand's
 * quality" — even though this quote is really about ONE specific
 * pair-sold item, just not which one.
 *
 * THE GATE is quoteAllowedForScope's new case 4: a quote matching
 * impliesPairSoldItem (a fixed "N pairs of these/them/those/it" pattern)
 * is DROPPED from the brand tier UNCONDITIONALLY — not "kept when the
 * scope happens to look like a pair-sold category". This is checked
 * BEFORE the named-noun path, not after — this file went through TWO
 * broken drafts before landing here, both closed and pinned below:
 *
 *   Draft 1 (rejected, B2/B3): matched the implicit reference back against
 *   allowedLabelText — a UNION of every label the ad's media/match carries
 *   (title + detected subjects + refinedProducts + match fields) — so a
 *   stray secondary detection (pants visible on a model whose SHIRT is
 *   what's actually being sold) or a "Short Sleeve" title (via the
 *   fromLabel 'short'->'shorts' recovery, a few lines below in the real
 *   file) could satisfy the check for the WRONG product.
 *
 *   Draft 2 (rejected, named-noun bypass): checked case 4 only when the
 *   quote named NO literal noun at all. "I've got two pairs of these and
 *   they go with any shirt" names 'shirt' (an incidental styling mention),
 *   which let the named-noun early-return skip case 4 entirely and KEEP
 *   the quote via the (correct, unrelated) noun match — the pair-reference
 *   never got examined. Case 4 now runs FIRST and unconditionally, so a
 *   quote cannot dodge it by also happening to mention some noun.
 *
 * The current design has no scope-matching surface for case 4 at all, so
 * it cannot be fooled by either exploit. The tradeoff: a product that is
 * GENUINELY the one an implicit-pair quote means never gets it as a
 * BRAND-tier last resort either. That is intentional — see section D.
 *
 * SEPARATELY, this session's adversarial pass also found the PRE-EXISTING
 * fromLabel 'short'->'shorts' recovery (unrelated to case 4 — it backs the
 * EXPLICIT-noun path only) was exploitable by ANY "Short Sleeve" title, and
 * that a whole-string-tested exclusion for it introduced two NEW bugs (a
 * run of 2+ spaces or a non-ASCII dash defeated the exclusion; testing the
 * whole concatenated label blob rather than the specific "short" match
 * could wrongly suppress a genuine "Kore Short" shorts product's own
 * recovery). Section C below pins the match-local fix.
 *
 * KNOWN BOUNDARY, not a regression this harness pins: PAIR_REFERENCE_RE
 * only covers "pair(s) of these/them/those/it/this" phrasing with a closed
 * numeral-word list (one..six, several, multiple, few, a couple). It does
 * NOT catch every implicit-SKU phrasing ("I bought two of these", "ten
 * pairs of these", "this one runs small") — a separate, broader problem,
 * intentionally out of scope here. See the companion Gemini-prompt fix in
 * services/providers/geminiSearchProvider.js (lookupBrandReviews) for the
 * producer-side half, not exercised by this harness (no network calls
 * here; it changes what Gemini is asked to return, not runtime behavior).
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyQuoteScopeImplicitPairs.js
 *
 * Revert-prove (section R). A stub-function reimplementation that is never
 * substituted into the real call path does not prove anything about the
 * SHIPPED code — this file's own first draft made exactly that mistake
 * (an earlier R2/R3b asserted properties of throwaway local functions that
 * quoteAllowedForScope never calls). Section R instead does a STRUCTURAL
 * scan of the real, on-disk quoteAllowedForScope source: it must contain
 * the unconditional `if (impliesPairSoldItem(text)) return false` shape,
 * and must NOT contain a `.some(` call comparing PAIR_SOLD_NOUNS-style
 * candidates against `allowed` (the rejected draft-1 shape). This catches
 * "someone reintroduces the match-back design" even if they change
 * variable names, because it greps intent (the return-false-unconditionally
 * shape vs. a comparison-against-allowed shape), not vocabulary.
 */

const fs = require('fs');
const path = require('path');

process.env.QUOTE_PROVENANCE_STRICT = 'true';

const SRC_PATH = path.join(__dirname, '..', 'src', 'services', 'quoteProvenance.js');
const {
  quoteAllowedForScope,
  isBrandQuoteAllowedForSeed,
  applyStrictQuoteScope,
  impliesPairSoldItem,
  productNounsIn,
} = require(SRC_PATH);

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

// The exact text measured live on ad 6a9600196c6bffaf965a99e9.
const PAIRS_QUOTE = "I've got two pairs of these and they fit great, are tough and comfortable. Highly recommended.";
const GENERIC_QUOTE = "I love this brand's quality.";
const LEGGING_QUOTE = 'These leggings are amazing.';
const HAT_QUOTE = 'Love the hat, one of my favourite I own! The colour is great!';
const GLOVE_IDIOM_QUOTE = 'The quality fits like a glove. Highly recommended.';
const BYPASS_QUOTE = "I've got two pairs of these and they go with any shirt";

console.log('A. quoteAllowedForScope — implicit pair-reference is dropped from brand tier, unconditionally');

check(
  'A1 measured DROP: "two pairs of these" rejected for the t-shirt ad it wrongly printed on (the live defect)',
  quoteAllowedForScope(PAIRS_QUOTE, 'Rusted Icon') === false
);

check(
  'A2 measured DROP: still rejected even for the pants product it is ACTUALLY about — brand tier never guesses (see D for why this is fine)',
  quoteAllowedForScope(PAIRS_QUOTE, 'Flyline Stretch Pant') === false
);

check(
  'A3 DROP regardless of what the scope label says at all (unconditional, not scope-dependent)',
  quoteAllowedForScope(PAIRS_QUOTE, "Men's Trail Running Shoe") === false &&
  quoteAllowedForScope(PAIRS_QUOTE, '') === false
);

check(
  'A4 named-noun bypass CLOSED: an implicit pair-reference that ALSO mentions an unrelated noun cannot dodge case 4 via the noun match (draft-2 exploit)',
  quoteAllowedForScope(BYPASS_QUOTE, 'Rusted Icon T-Shirt') === false,
  `got ${quoteAllowedForScope(BYPASS_QUOTE, 'Rusted Icon T-Shirt')}`
);

console.log('\nB. Regressions earlier drafts of this fix introduced — now closed');

check(
  'B1 (baseline unaffected) generic praise (no noun, no pair-reference) still allowed anywhere',
  quoteAllowedForScope(GENERIC_QUOTE, 'Rusted Icon T-Shirt') === true &&
  quoteAllowedForScope(GENERIC_QUOTE, 'Flyline Stretch Pant') === true
);

check(
  'B2 media-union false-accept is CLOSED (draft 1): a t-shirt scope with "pants" also present in the label union (secondary subject) still DROPS the pairs-quote',
  quoteAllowedForScope(PAIRS_QUOTE, 'Rusted Icon T-Shirt Pants') === false
);

check(
  'B3 fromLabel "Short Sleeve" false-accept is CLOSED: a plain short-sleeve tee title no longer implies "shorts" scope at all',
  productNounsIn('Short Sleeve Rusted Icon Tee', { fromLabel: true }).includes('shorts') === false &&
  quoteAllowedForScope(PAIRS_QUOTE, 'Short Sleeve Rusted Icon Tee') === false
);

check(
  'B4 the "Kore Short" fromLabel recovery this bug-fix rides on still works for its original purpose (no sleeve word present)',
  productNounsIn('Kore Short', { fromLabel: true }).includes('shorts') === true
);

check(
  'B5 glove idiom is NOT a false-reject: \'glove\' was reverted out of PRODUCT_NOUNS (an earlier draft added it and broke this)',
  quoteAllowedForScope(GLOVE_IDIOM_QUOTE, 'Rusted Icon T-Shirt') === true
);

console.log('\nC. fromLabel short-sleeve exclusion — match-local, not whole-string (found by adversarial re-review)');

const shortCases = [
  ['Short Sleeve Rusted Icon Tee', false, 'plain short sleeve'],
  ['Short  Sleeve Tee', false, 'TWO spaces — whole-string version with [-\\s]? (max one char) missed this'],
  ['Short–Sleeve', false, 'en dash — ASCII-only version missed this'],
  ['Short—Sleeve', false, 'em dash'],
  ['Short‑Sleeve', false, 'non-breaking hyphen'],
  ['shortsleeve tee', false, 'no separator at all'],
  ['S/S Tee', false, 'no bare "short" token present'],
  ['Kore Short', true, 'the original recovery this exclusion must not break'],
  ['Board Short', true, 'another bare-"Short" product name'],
  ['Kore Short Short Sleeve Shirt', true, 'title + unrelated media label concatenated — whole-string version wrongly suppressed this'],
];
for (const [text, expected, note] of shortCases) {
  check(
    `C ${JSON.stringify(text)} -> shorts=${expected} (${note})`,
    productNounsIn(text, { fromLabel: true }).includes('shorts') === expected
  );
}

console.log('\nD. Regression — explicit-noun path (the original Vuori-class fix)');

check(
  'D1 explicit-noun quote still KEPT when it matches scope',
  quoteAllowedForScope(LEGGING_QUOTE, 'Ws Legging') === true
);

check(
  'D2 explicit-noun quote still DROPPED when it mismatches scope',
  quoteAllowedForScope(LEGGING_QUOTE, 'Rusted Icon T-Shirt') === false
);

check(
  'D3 real Pelagic-pool hat quote still DROPPED on the t-shirt ad',
  quoteAllowedForScope(HAT_QUOTE, 'Rusted Icon T-Shirt') === false
);

check(
  'D4 isBrandQuoteAllowedForSeed (the real call site) agrees with A1/D1/D2 via the scope object form',
  isBrandQuoteAllowedForSeed(PAIRS_QUOTE, { productTitle: 'Rusted Icon' }) === false &&
  isBrandQuoteAllowedForSeed(PAIRS_QUOTE, { productTitle: 'Flyline Stretch Pant' }) === false &&
  isBrandQuoteAllowedForSeed(LEGGING_QUOTE, { productTitle: 'Ws Legging' }) === true
);

console.log('\nE. Non-brand tiers are untouched — the genuinely-matching case still prints, just via product tier');

check(
  'E1 applyStrictQuoteScope skip-passes a product-tier quote unconditionally, so the pants product still gets this exact review from ITS OWN pool',
  applyStrictQuoteScope({ text: PAIRS_QUOTE, tier: 'product' }, { productTitle: 'Rusted Icon' }) !== null
);

check(
  'E2 the same call for a brand-tier-stamped quote IS gated (and drops, matching A1)',
  applyStrictQuoteScope({ text: PAIRS_QUOTE, tier: 'brand' }, { productTitle: 'Rusted Icon' }) === null
);

console.log('\nF. impliesPairSoldItem — pattern precision');

check('F1 matches "two pairs of these"', impliesPairSoldItem('two pairs of these') === true);
check('F2 matches "a pair of these"', impliesPairSoldItem('I love a pair of these') === true);
check('F3 matches "several pairs of them"', impliesPairSoldItem('several pairs of them') === true);
check('F4 matches "a couple pairs of those"', impliesPairSoldItem('a couple pairs of those') === true);
check('F5 matches regional "two pair of these" (no plural s)', impliesPairSoldItem('I own two pair of these') === true);
check('F6 matches digit form "2 pairs of these"', impliesPairSoldItem('bought 2 pairs of these') === true);
check('F7 matches singular "this" ("a pair of this")', impliesPairSoldItem('I love a pair of this') === true);
check(
  'F8 does NOT match a verb use of "pairs" ("pairs well with")',
  impliesPairSoldItem('This scarf pairs well with any outfit') === false
);
check(
  'F9 does NOT match "a pair of" with no these/them/those/it/this follow-on',
  impliesPairSoldItem('a pair of shoes') === false
);
check('F10 does NOT match plain generic praise', impliesPairSoldItem(GENERIC_QUOTE) === false);
check(
  'F11 KNOWN MISS, not a regression: "I bought two of these" (no "pair(s)") is not caught — documented boundary',
  impliesPairSoldItem('I bought two of these') === false
);
check(
  'F12 KNOWN MISS, not a regression: "ten pairs of these" (numeral word past the closed list) is not caught — documented boundary',
  impliesPairSoldItem('ten pairs of these') === false
);

console.log('\nR. Revert-prove — structural scan of the SHIPPED quoteAllowedForScope source (not a stub reimplementation)');

const liveSrc = fs.readFileSync(SRC_PATH, 'utf8');
const fnMatch = liveSrc.match(/function quoteAllowedForScope\(quote, allowedLabelText\) \{[\s\S]*?\n\}/);
check('R0 quoteAllowedForScope is present and extractable from the live file (sanity — every check below depends on this)', !!fnMatch);
const fnSrc = fnMatch ? fnMatch[0] : '';

check(
  'R1 the shipped function contains the unconditional case-4 return (proves case 4 was not deleted)',
  /if\s*\(\s*impliesPairSoldItem\(text\)\s*\)\s*return\s*false\s*;/.test(fnSrc)
);

check(
  'R2 case 4 runs BEFORE the named-noun check, not after (proves the draft-2 bypass fix was not reverted) — impliesPairSoldItem appears textually before productNounsIn(text) in the function body',
  (() => {
    const pairIdx = fnSrc.indexOf('impliesPairSoldItem(text)');
    const nounIdx = fnSrc.indexOf('productNounsIn(text)');
    return pairIdx !== -1 && nounIdx !== -1 && pairIdx < nounIdx;
  })()
);

check(
  'R3 the shipped function does NOT contain a .some( comparison against `allowed` (proves the rejected draft-1 match-back design was not reintroduced)',
  !/\.some\(\s*\(?\w*\)?\s*=>\s*allowed\.has/.test(fnSrc)
);

check(
  'R4 the shipped fromLabel exclusion is match-local (a negative lookahead on \\bshort\\b), not a whole-string .test() gate (proves the C-section fix was not reverted to the whole-string form)',
  /\\bshort\\b\(\?!/.test(liveSrc)
);

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
