#!/usr/bin/env node
/**
 * verifyNoUnearnedClaims.js — no ad may print a factual superlative the data
 * does not support. Offline: no DB, no network, no API key.
 *
 * WHAT THIS PROTECTS — TWO DOORS INTO THE SAME SLOT
 * -------------------------------------------------
 * DOOR 1 — the cascade literal (PR #138, bf0fd397).
 * services/metaCascadeConfig.js drove badgeText through a literal fallback:
 *
 *   badgeText: [
 *     { type: 'doc', doc: 'layoutInput', path: 'input.product.badges[0]' },
 *     { type: 'literal', value: 'Bestseller' },          // <- removed
 *   ]
 *
 * A cascade literal is the LAST entry, so it fires exactly when every real
 * source is empty — i.e. "Bestseller" printed precisely on the products with
 * NO evidence of being one. That is not a stylistic problem like a templated
 * headline; it is a factual claim about commercial performance, and unearned
 * it is a false advertising claim. Owner, 2026-08-11: "The bestseller badge
 * should be removed."
 *
 * The distinction this file encodes: a literal is fine when it is STRUCTURAL
 * (a CTA label like "SHOP NOW", an empty-array default) and never fine when it
 * asserts an unverifiable FACT about the product's standing. Note the static
 * prompt path already bans this class outright (services/staticAdIntents.js:
 * "never Best Seller, Top Rated, Customer Favorite, #1 or As Seen On") — the
 * video cascade was the one place it survived.
 *
 * DOOR 2 — the LLM-written badges array (found 2026-08-19).
 * Closing door 1 left door 2 wide open, and this file could not see it: it
 * scanned CASCADE LITERALS only. services/layoutInputService.js asked Gemini
 * for 2-4 badges with a SOFT preference ("Prefer real signal over filler")
 * and handed it "Top rated", "Editor's pick", "Best seller" as examples — so
 * the model did not invent the claim, it copied it off the page, exactly as
 * scripts/verifyCopyCasing.js documents for "MEET THE".
 *
 * Production scan of 1,345 LayoutInputArtifacts with non-empty badges:
 *   - 949 carried at least one unearned standing claim
 *   - 676 of those had rating null AND reviewCount null
 *   - "top rated" x741, "best seller" x438, "customer favorite" x143,
 *     "fan favorite" x68, "community favorite" x40, "editor's pick" x34,
 *     "community fave" x24, and fabricated NUMBERS: "4.7* rated" x36,
 *     "4.8* rated" x31, "4.6* rated" x20, "5-Star Quality"
 * Concrete case: CatalogProduct 6a7b72f4935d0a8e81905544
 * (productReviews.rating=null, reviewCount=null, ratingCandidates=[]) has
 * artifact 6a862136b31cf7b2214a2945 carrying
 * ["Top rated","Best seller","Sustainably made"]. badgeText binds
 * input.product.badges[0], so element 0 is what Remotion prints.
 *
 * The lexicon now lives in ONE place, services/badgeClaims.js, and both the
 * runtime filter and this harness import it — a second copy here is how door
 * 2 stayed open while C2 stayed green. Attribute / material badges
 * ("Sustainably made", "100% Recycled") are NOT this class and must survive;
 * D asserts that too, so nobody "fixes" this by banning all badges.
 *
 * REVERT-PROOF RECIPE (each must fail this harness — run after mutating):
 *   a) Re-add { type: 'literal', value: 'Bestseller' } to badgeText -> C1/C2 fail
 *   b) Add any other superlative literal to any cascade             -> C2 fails
 *   c) Soften filterUnearnedBadges so 'Best seller' survives when a rating or
 *      review count is present                                      -> D fails
 *      (that is the single most important assertion in this file)
 *   d) Loosen the lexicon's separator classes back to `best\s?seller` /
 *      `editor'?s`                                                  -> D fails on
 *      "Best-Seller" / "Editor\u2019s pick" — the eight forms a first draft leaked
 *   e) Make defaultBadgesFromSignal emit an unearned badge           -> E fails
 *   f) Restore any superlative example to the badges prompt, or the
 *      "Family-owned since 2003" founding year to brand mode         -> F fails
 *   g) Classify '5-Star Quality' as never_earnable                   -> D fails
 *   h) Stub gateLayoutInputBadges to `return layoutInput`, or delete its
 *      call site in buildMetaForAd                                  -> H fails
 */

const path = require('path');
const { DEFAULT_META_CASCADES } = require(path.join(__dirname, '..', 'services', 'metaCascadeConfig'));
const {
  UNEARNED_CLAIM,
  classifyBadgeClaim,
  filterUnearnedBadges
} = require(path.join(__dirname, '..', 'services', 'badgeClaims'));
const {
  buildDerivationPrompt,
  defaultBadgesFromSignal
} = require(path.join(__dirname, '..', 'services', 'layoutInputService'));
const registry = require(path.join(__dirname, '..', 'services', 'templateRegistry'));

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

// Claims about standing/performance that only real data can justify.
// UNEARNED_CLAIM is imported from services/badgeClaims.js above — the runtime
// filter and this harness MUST share one lexicon. The local copy that used to
// live here is exactly why door 2 went unnoticed.

// ── C1. badgeText specifically ──────────────────────────────────────────
const badge = DEFAULT_META_CASCADES.badgeText || [];
check('C1 badgeText still reads real product badges', badge.length >= 1);
check('C1 badgeText has NO literal fallback',
  !badge.some((e) => e && e.type === 'literal'),
  `chain=${JSON.stringify(badge)} — a literal here fires only when there is no evidence`);

// ── C2. no cascade anywhere may assert an unearned claim ────────────────
for (const [field, chain] of Object.entries(DEFAULT_META_CASCADES)) {
  for (const entry of chain || []) {
    if (!entry || entry.type !== 'literal') continue;
    const v = entry.value;
    const text = typeof v === 'string' ? v : '';
    check(`C2 ${field} literal is not an unearned claim`,
      !UNEARNED_CLAIM.test(text),
      `literal ${JSON.stringify(v)} asserts a fact the data does not back`);
  }
}

// ── C3. structural literals are still ALLOWED (this is not a ban on all) ─
// Guards against "fixing" this by deleting every literal: a CTA label is a
// button, not a claim, and removing it would leave ads with no call to action.
const cta = DEFAULT_META_CASCADES.ctaText || [];
check('C3 ctaText keeps its structural literal fallback',
  cta.some((e) => e && e.type === 'literal' && typeof e.value === 'string' && e.value.trim()),
  'a CTA label is structural, not a claim — it should not have been removed');

// ── D. the LLM door: filterUnearnedBadges behaviour ────────────────────
// Drives the SHIPPED function. A copy of this logic here would let the
// filter and the harness drift, which is how door 2 stayed open while C2
// stayed green.
const keptOf = (badges, signals) => filterUnearnedBadges(badges, signals).kept;
const NO_SIGNAL   = { rating: null, reviewCount: null };
const FULL_SIGNAL = { rating: 4.9, reviewCount: 5000 };

check('D1 "Best seller" with no signal is dropped',
  keptOf(['Best seller'], NO_SIGNAL).length === 0);

// THE load-bearing assertion in this file. A sales claim is not a rating
// claim: no quantity of stars or reviews can establish that a product
// outsold anything, and this data model has no sales field at all
// (CatalogProduct.sellers is Google-Shopping MERCHANT listings — which
// retailers stock the item — not a rank). If this check ever goes green
// with a softened filter, door 2 is open again.
check('D2 "Best seller" WITH rating 4.9 AND reviewCount 5000 is STILL dropped',
  keptOf(['Best seller'], FULL_SIGNAL).length === 0,
  'a sales claim is not a rating claim — no rating or review count can back it');

check('D3 "Top rated" + rating null is dropped',
  keptOf(['Top rated'], NO_SIGNAL).length === 0);
check('D4 "Top rated" + rating 4.8 is kept',
  keptOf(['Top rated'], { rating: 4.8 }).join('|') === 'Top rated');
check('D5 "Top rated" + rating 4.5 is kept (boundary matches defaultBadgesFromSignal)',
  keptOf(['Top rated'], { rating: 4.5 }).join('|') === 'Top rated');
check('D6 "Top rated" + rating 4.1 is dropped (below the 4.5 floor)',
  keptOf(['Top rated'], { rating: 4.1 }).length === 0);
check('D7 "Top rated comfort" is still a rating claim, not neutral',
  classifyBadgeClaim('Top rated comfort').kind === 'rating'
  && keptOf(['Top rated comfort'], NO_SIGNAL).length === 0);

// A fabricated NUMBER is worse than a fabricated superlative: it is
// specific and checkable. Understating the real rating is honest and
// allowed; overstating it by any margin is not.
check('D8 "4.9\u2605 rated" + rating 4.6 is dropped (overstates by 0.3)',
  keptOf(['4.9\u2605 rated'], { rating: 4.6 }).length === 0);
check('D9 "4.5\u2605 rated" + rating 4.6 is kept (understating is honest)',
  keptOf(['4.5\u2605 rated'], { rating: 4.6 }).join('|') === '4.5\u2605 rated');
check('D10 "4.7\u2605 rated" + rating null is dropped',
  keptOf(['4.7\u2605 rated'], NO_SIGNAL).length === 0);

// "5-Star Quality" appears in production. It is a RATING claim, gated on a
// real rating — not a never-earnable superlative. An integer N-star form is
// honest at N-0.5 (a 4.7 rounds to 5); a decimal form may not overstate.
check('D11 "5-Star Quality" classifies as a rating claim at 4.5, not never_earnable',
  classifyBadgeClaim('5-Star Quality').kind === 'rating'
  && classifyBadgeClaim('5-Star Quality').threshold === 4.5,
  JSON.stringify(classifyBadgeClaim('5-Star Quality')));
check('D12 "5-Star Quality" + rating 4.7 is kept',
  keptOf(['5-Star Quality'], { rating: 4.7 }).join('|') === '5-Star Quality');
check('D13 "5-Star Quality" + rating 4.3 is dropped',
  keptOf(['5-Star Quality'], { rating: 4.3 }).length === 0);
check('D14 "5-Star Quality" + rating null is dropped',
  keptOf(['5-Star Quality'], NO_SIGNAL).length === 0);

check('D15 "1k+ reviews" + reviewCount 120 is dropped (overstates 8x)',
  keptOf(['1k+ reviews'], { reviewCount: 120 }).length === 0);
check('D16 "1k+ reviews" + reviewCount 1500 is kept',
  keptOf(['1k+ reviews'], { reviewCount: 1500 }).join('|') === '1k+ reviews');
check('D17 "10k+ reviews" + reviewCount 1200 is dropped',
  keptOf(['10k+ reviews'], { reviewCount: 1200 }).length === 0);
check('D18 "2,000+ reviews" parses the comma and gates on it',
  keptOf(['2,000+ reviews'], { reviewCount: 2500 }).length === 1
  && keptOf(['2,000+ reviews'], { reviewCount: 200 }).length === 0);

// Popularity/editorial claims: no field backs "favourite" or "pick" either.
for (const t of ['Customer favorite', 'Fan favorite', 'Community favorite',
                 'Community fave', "Editor's pick", 'Most popular', 'Most Loved',
                 'Award-winning', 'As seen on', '#1', 'Number one', 'Trending now']) {
  check(`D19 ${JSON.stringify(t)} is dropped even with a perfect signal`,
    keptOf([t], FULL_SIGNAL).length === 0,
    `classified ${classifyBadgeClaim(t).kind}`);
}

// The eight forms a first draft of the lexicon leaked. Each is a real
// wording a model emits: a hyphen instead of a space, U+2019 instead of an
// ASCII apostrophe, "No. 1" instead of "#1", or a sales-VELOCITY phrasing.
// These are separator/apostrophe bugs, not new claim types, and they are
// pinned individually because that is what a regex regression looks like.
for (const t of ['Best-Seller', 'Best-seller', 'Top-seller', 'Editor\u2019s pick',
                 'Editor\u2019s Choice', 'No. 1', 'No.1 seller', 'Sells out fast',
                 'Selling fast', 'Flying off shelves']) {
  check(`D20 lexicon variant ${JSON.stringify(t)} does not leak through as neutral`,
    classifyBadgeClaim(t).kind !== 'neutral' && keptOf([t], FULL_SIGNAL).length === 0,
    'separator / apostrophe / velocity form escaped the lexicon');
}

// NOT a blanket badge ban. If this block ever goes red, the filter has been
// "fixed" by dropping everything, which would strip real product facts.
for (const attr of ['Sustainably made', 'Water resistant', '100% Recycled',
                    'Machine washable', 'Limited edition', 'New arrival',
                    'UPF 50+ protection', '4-way stretch', 'Locally sourced',
                    'Quick-drying', 'Buttery soft', 'Premium quality']) {
  check(`D21 attribute badge ${JSON.stringify(attr)} survives (this is not a badge ban)`,
    keptOf([attr], NO_SIGNAL).join('|') === attr,
    'an attribute/material claim is not a standing claim and must not be dropped');
}

// The exact production regression, end to end.
const live = filterUnearnedBadges(['Top rated', 'Best seller', 'Sustainably made'], NO_SIGNAL);
check('D22 live regression: artifact 6a862136b31cf7b2214a2945 / product 6a7b72f4935d0a8e81905544 keeps only the attribute badge',
  live.kept.length === 1 && live.kept[0] === 'Sustainably made',
  `kept=${JSON.stringify(live.kept)}`);
check('D23 every dropped entry carries a reason (it is logged for operators)',
  live.dropped.length === 2 && live.dropped.every(d => typeof d.reason === 'string' && d.reason),
  JSON.stringify(live.dropped));

// Order matters: badgeText binds badges[0], so the filter must not reshuffle.
check('D24 surviving badges keep their original order',
  keptOf(['Best seller', 'Water resistant', 'Top rated', '100% Recycled'], NO_SIGNAL)
    .join('|') === 'Water resistant|100% Recycled');

check('D25 filterUnearnedBadges never throws on malformed input', (() => {
  try {
    filterUnearnedBadges(null, null);
    filterUnearnedBadges(undefined, {});
    filterUnearnedBadges([null, 42, '', '   ', {}], { rating: '4.8' });
    return true;
  } catch (e) { return false; }
})());
check('D26 a string rating does not satisfy a numeric gate',
  keptOf(['Top rated'], { rating: '4.9' }).length === 0);
check('D27 NaN does not satisfy a numeric gate',
  keptOf(['Top rated'], { rating: NaN }).length === 0);

// ── E. the repo's own earned badges survive its own filter ─────────────
// Invariant: defaultBadgesFromSignal is the ONE place allowed to mint a
// superlative, because it is real-signal-gated. Calls the SHIPPED function
// (exported for this) rather than a copy, so the two cannot drift.
const SIGNAL_SPREAD = [
  { rating: null, reviewCount: null },
  { rating: 4.4,  reviewCount: 50 },
  { rating: 4.5,  reviewCount: 99 },
  { rating: 4.8,  reviewCount: 100 },
  { rating: 4.9,  reviewCount: 1000 },
  { rating: 5,    reviewCount: 10000 },
  { rating: 4.6,  reviewCount: null },
  { rating: null, reviewCount: 5000 },
];
let mintedAny = 0;
for (const sig of SIGNAL_SPREAD) {
  const produced = defaultBadgesFromSignal(sig);
  mintedAny += produced.length;
  const { kept, dropped } = filterUnearnedBadges(produced, sig);
  check(`E defaultBadgesFromSignal(${JSON.stringify(sig)}) is filter-clean`,
    dropped.length === 0 && kept.length === produced.length
      && produced.every((b, i) => kept[i] === b),
    `produced=${JSON.stringify(produced)} dropped=${JSON.stringify(dropped)}`);
}
// Guard the guard: if defaultBadgesFromSignal ever returns nothing for every
// signal, the loop above passes vacuously and proves nothing.
check('E0 the spread actually exercised badge minting', mintedAny >= 6,
  `only ${mintedAny} badges minted across ${SIGNAL_SPREAD.length} signal sets`);

// ── F. the prompt no longer teaches the fillers ────────────────────────
// Same doctrine as scripts/verifyCopyCasing.js: the model was copying a
// literal off the page, so the fix is to remove the literal AND state the
// rule. That file also records why the template list matters — its first
// cut hardcoded ai_brand_led@1:1, never reached the branch it guarded, and
// the revert-proof stayed green. Enumerate the real registry instead.
function ctxFor(outcome) {
  return {
    media: { metadata: { brand: 'Vuori' } },
    detection: {},
    match: {
      outcome,
      identification: {
        brand: 'Vuori',
        productName: 'Short Sleeve Strato Breathe Tee | Black',
        details: {}
      }
    },
    brand: { name: 'Vuori', tone: ['Premium'] }
  };
}
const canvasTemplates = registry.CANVAS?.templates || {};
const F_PAIRS = [];
for (const [tpl, def] of Object.entries(canvasTemplates)) {
  for (const ar of Object.keys(def.variants || {})) F_PAIRS.push([tpl, ar]);
}
F_PAIRS.push(['ai_brand_led', '1:1']);   // an AI template with no canvas variant
check('F0 the registry yielded template/ratio pairs to test', F_PAIRS.length > 5,
  `only ${F_PAIRS.length} pairs — the badges branch may be untested`);

// The literals this prompt used to hand the model, verbatim.
const TAUGHT_BADGES = ['Top rated', "Editor's pick", 'Best seller',
                       'Family-owned since 2003', 'Trusted by anglers'];
let badgesLineSeen = 0;
for (const [label, outcome] of [['product', 'product_match'], ['brand', 'brand_match']]) {
  for (const [tpl, ar] of F_PAIRS) {
    let prompt = '';
    try {
      prompt = buildDerivationPrompt(ctxFor(outcome), tpl, ar, { variantKind: 'product_image' });
    } catch (e) {
      check(`F ${label} ${tpl}@${ar}: prompt builds`, false, e.message.slice(0, 120));
      continue;
    }
    const guidance = String(prompt).split('\n').filter(l => /badge/i.test(l)).join('\n');
    if (guidance) badgesLineSeen++;
    check(`F1 ${label} ${tpl}@${ar}: emits badges guidance at all`, !!guidance);
    for (const phrase of TAUGHT_BADGES) {
      check(`F2 ${label} ${tpl}@${ar}: does not hand the model "${phrase}"`,
        !prompt.includes(phrase),
        'a literal example is back — this is what produced "Top rated"/"Best seller" on products with no data');
    }
    check(`F3 ${label} ${tpl}@${ar}: badges guidance contains no unearned claim at all`,
      !UNEARNED_CLAIM.test(guidance),
      `matched ${JSON.stringify((guidance.match(UNEARNED_CLAIM) || [])[0])}`);
    check(`F4 ${label} ${tpl}@${ar}: states the prohibition, not a preference`,
      /FORBIDDEN/.test(guidance) && /dropped downstream/.test(guidance),
      'the rule that replaced the examples is missing');
    check(`F5 ${label} ${tpl}@${ar}: no longer says "Prefer real signal over filler"`,
      !/Prefer real signal over filler/.test(prompt),
      'the soft preference is back');
  }
}
check('F6 the badges guidance was actually reached in every pair', badgesLineSeen === F_PAIRS.length * 2,
  `guidance found in ${badgesLineSeen} of ${F_PAIRS.length * 2} prompts — a check that cannot reach the code it guards is not a check`);
check('F7 brand mode states no date/founding-year/count/award may be invented',
  /founding year/i.test(buildDerivationPrompt(ctxFor('brand_match'), 'ai_brand_led', '1:1', { variantKind: 'product_image' })),
  'the brand-mode line must forbid inventing a figure, not just drop the 2003 example');
check('F8 the product budget survives the rewrite (2\u20134 items, 1\u20133 words)',
  /2\u20134 items/.test(buildDerivationPrompt(ctxFor('product_match'), 'ai_brand_led', '1:1', { variantKind: 'product_image' }))
  && /1\u20133 words/.test(buildDerivationPrompt(ctxFor('product_match'), 'ai_brand_led', '1:1', { variantKind: 'product_image' })),
  'the slot budget was lost when the examples were removed');

// ── G. the wiring inside assembleInput ─────────────────────────────────
// assembleInput awaits Mongo (category reviews, brand comments, snippet
// extraction), so it cannot be driven end-to-end offline — the same
// constraint scripts/verifyDirectorRoundPersist.js hit with
// directConceptsRound, which it answered with source-region pins. D and E
// pin the filter behaviourally; these pin that the filter is actually WIRED
// IN, and wired in at the right point.
//
// The slice is bounded STRUCTURALLY — from the `async function
// assembleInput(` signature to the next column-0 `}` — not by a character
// count, so it cannot silently drift onto neighbouring code as the file
// grows.
const fs = require('fs');
const LIS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'layoutInputService.js'), 'utf8');

const asmStart = LIS_SRC.indexOf('async function assembleInput(');
check('G0 assembleInput was located in the source', asmStart !== -1);
const asmRel = LIS_SRC.slice(asmStart).search(/\n\}/);
check('G0b the assembleInput slice closes at a column-0 brace', asmRel > 0);
const ASM_RAW = asmStart === -1 || asmRel <= 0 ? '' : LIS_SRC.slice(asmStart, asmStart + asmRel);
// Scan CODE, not prose. The first cut of G6 matched the word show_badges
// inside the explanatory comment that landed with this change and read the
// value as "false." — a source pin that reads its own documentation proves
// nothing, so line comments are stripped before any of G1-G8 look at the
// slice. (Kept line-based on purpose: a regex that also ate /* */ blocks
// would corrupt any URL inside a template literal here.)
const ASM = ASM_RAW.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
check('G0c the comment-stripped slice still has code in it',
  ASM.length > 2000 && /show_badges:/.test(ASM),
  `slice is ${ASM.length} chars`);

const iFilter = ASM.indexOf('filterUnearnedBadges(');
const iDerived = ASM.indexOf('const derivedBadges = [...llmBadges]');
check('G1 assembleInput calls filterUnearnedBadges', iFilter !== -1,
  'the badge filter is not wired into the assembler — D/E would pass while production still ships unearned badges');
check('G2 the filter runs BEFORE the badges are merged',
  iFilter !== -1 && iDerived !== -1 && iFilter < iDerived,
  'filtering after the merge would let an invented superlative occupy element 0, the only one badgeText reads');
check('G3 the LLM array is filtered, not passed through raw',
  /filterUnearnedBadges\(\s*\n?\s*Array\.isArray\(derivation\.badges\)/.test(ASM),
  'derivation.badges must reach the filter');
check('G4 defaultBadgesFromSignal output is filtered too (belt-and-braces)',
  /filterUnearnedBadges\(\s*\n?\s*defaultBadgesFromSignal\(details\)/.test(ASM));
check('G5 dropped badges are logged for operators',
  /dropped unearned badge\(s\)/.test(ASM),
  '676 stale artifacts prove this needs to be diagnosable from Render logs');

// show_badges must follow the array actually written, or the renderer is
// told to paint a zone whose content was filtered away.
const showBadges = (ASM.match(/show_badges:\s*([^,\n]+)/) || [])[1] || '';
check('G6 show_badges keys off derivedBadges, not the raw LLM array',
  /derivedBadges/.test(showBadges) && !/derivation\.badges/.test(showBadges),
  `show_badges resolves to ${JSON.stringify(showBadges.trim())}`);
check('G7 product.badges is written from the filtered/merged array',
  /badges:\s*limitArray\(derivedBadges,\s*4\)/.test(ASM));
check('G8 social_proof.proof_badges is written from the same array',
  /proof_badges:\s*limitArray\(derivedBadges,\s*4\)/.test(ASM));

// ── H. the read-time gate: stale artifacts cannot print unearned badges ─
// The producer-side filter (D/G) does not rewrite documents already in
// Mongo, and buildMetaForAd deliberately serves a stale artifact of ANY
// schemaVersion ("Schema freshness is a PREFERENCE, not a filter"), so a
// version bump is not a remedy either. 676 production artifacts carry an
// unearned claim with no backing numbers; the only code-only fix is a
// read-time sibling of gateLayoutInputQuotes. Drives the REAL exported
// function on hand-built artifacts — no Mongo.
//
// The require sits HERE, not at file top, on purpose: brandScriptExecutor
// pulls ffmpeg-static at module scope, and a load failure in an incomplete
// node_modules would take C-G down with it.
const { gateLayoutInputBadges } =
  require(path.join(__dirname, '..', 'services', 'brandScriptExecutor'));

function makeLayoutInput(opts = {}) {
  const product = { name: 'Strato Tee' };
  if ('badges' in opts) product.badges = opts.badges;
  const social_proof = {};
  if ('proof_badges' in opts)  social_proof.proof_badges = opts.proof_badges;
  if ('rating_value' in opts)  social_proof.rating_value = opts.rating_value;
  if ('review_count' in opts)  social_proof.review_count = opts.review_count;
  const input = { product, social_proof };
  if ('show_badges' in opts) input.layout_options = { show_badges: opts.show_badges };
  return { schemaVersion: '3.9.0', input };
}
const gatedBadges = (li) => {
  const g = gateLayoutInputBadges(li);
  return (g && g.input && g.input.product && g.input.product.badges) || [];
};
const hasKey = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// H1 — the exact production regression, read-side.
{
  const raw = makeLayoutInput({
    badges:       ['Top rated', 'Best seller', 'Sustainably made'],
    proof_badges: ['Top rated', 'Best seller', 'Sustainably made'],
    show_badges:  true
  });
  const before = JSON.stringify(raw);
  const gated = gateLayoutInputBadges(raw);
  check('H1 stale artifact 6a862136b31cf7b2214a2945 keeps only the attribute badge',
    JSON.stringify(gated.input.product.badges) === JSON.stringify(['Sustainably made']),
    `badges=${JSON.stringify(gated.input.product.badges)}`);
  check('H1 proof_badges is rewritten to the same kept list',
    JSON.stringify(gated.input.social_proof.proof_badges) === JSON.stringify(['Sustainably made']));
  check('H1 the stored artifact object is NOT mutated (local clone only)',
    JSON.stringify(raw) === before);
  check('H1 a filtered artifact is a new object, not the input', gated !== raw);
  check('H1 unrelated product fields survive the clone',
    gated.input.product.name === 'Strato Tee');
}

// H2 — a real rating earns "Top rated"; nothing earns "Best seller".
{
  const raw = makeLayoutInput({
    badges:       ['Top rated', 'Best seller', 'Sustainably made'],
    proof_badges: ['Top rated', 'Best seller', 'Sustainably made'],
    rating_value: 4.8,
    show_badges:  true
  });
  const before = JSON.stringify(raw);
  const gated = gateLayoutInputBadges(raw);
  check('H2 rating_value 4.8 keeps "Top rated" and still drops "Best seller"',
    JSON.stringify(gated.input.product.badges) === JSON.stringify(['Top rated', 'Sustainably made']),
    `badges=${JSON.stringify(gated.input.product.badges)}`);
  check('H2 show_badges stays true when something survived',
    gated.input.layout_options.show_badges === true);
  check('H2 no mutation on the partial-keep path', JSON.stringify(raw) === before);
}

// H3 — review-count threshold matches defaultBadgesFromSignal's cutoff.
check('H3 review_count 1500 keeps "1k+ reviews"',
  gatedBadges(makeLayoutInput({ badges: ['1k+ reviews'], review_count: 1500 })).join('|') === '1k+ reviews');
{
  const g = gateLayoutInputBadges(makeLayoutInput({
    badges: ['1k+ reviews'], proof_badges: ['1k+ reviews'], review_count: 12, show_badges: true
  }));
  check('H3 review_count 12 drops "1k+ reviews"', !hasKey(g.input.product, 'badges'),
    `badges=${JSON.stringify(g.input.product.badges)}`);
}

// H4 — everything filtered away: absent keys, zone switched off.
{
  const g = gateLayoutInputBadges(makeLayoutInput({
    badges: ['Top rated', 'Best seller'], proof_badges: ['Top rated', 'Best seller'], show_badges: true
  }));
  check('H4 product.badges key is OMITTED, not set to []',
    !hasKey(g.input.product, 'badges'), JSON.stringify(g.input.product));
  check('H4 proof_badges key is omitted when it was present',
    !hasKey(g.input.social_proof, 'proof_badges'));
  check('H4 show_badges is forced false once everything is filtered away',
    g.input.layout_options.show_badges === false);
}
check('H4b proof_badges is not invented when the artifact never had it',
  !hasKey(gateLayoutInputBadges(makeLayoutInput({ badges: ['Top rated', 'Sustainably made'] }))
    .input.social_proof, 'proof_badges'));

// H5 — a dirty proof_badges cannot ride through on a clean product.badges.
{
  const g = gateLayoutInputBadges(makeLayoutInput({
    badges: ['Sustainably made'], proof_badges: ['Best seller', 'Sustainably made']
  }));
  check('H5 dirty proof_badges is filtered even when product.badges is clean',
    JSON.stringify(g.input.social_proof.proof_badges) === JSON.stringify(['Sustainably made']),
    `proof_badges=${JSON.stringify(g.input.social_proof.proof_badges)}`);
}

// H6 — malformed input must never throw: Atlas video is already billed.
for (const raw of [null, undefined, {}, { input: null }, { input: {} },
                   { input: { product: null } }, { input: { product: {} } }]) {
  let threw = null;
  try { gateLayoutInputBadges(raw); } catch (e) { threw = e; }
  check(`H6 no throw on ${JSON.stringify(raw) || String(raw)}`, threw === null,
    threw && threw.message);
}

// H7 — a non-array badges value is WITHHELD, not passed through. The
// cascade reads the path `badges[0]`, so an array-like would resolve to
// the claim; fail closed instead.
for (const bad of ['Top rated', { 0: 'Best seller' }, 42]) {
  const g = gateLayoutInputBadges(makeLayoutInput({ badges: bad }));
  check(`H7 non-array badges ${JSON.stringify(bad)} is withheld`,
    !hasKey(g.input.product, 'badges'), JSON.stringify(g.input.product.badges));
}

// H8 — nothing to decide returns the SAME object, like the quote gate's
// `if (!pq) return layoutInput`.
{
  const absent = makeLayoutInput();
  check('H8 artifact with no badges is returned by identity',
    gateLayoutInputBadges(absent) === absent);
  const empty = makeLayoutInput({ badges: [] });
  check('H8 empty badges array is returned by identity',
    gateLayoutInputBadges(empty) === empty);
  const clean = makeLayoutInput({ badges: ['Water resistant'], proof_badges: ['Water resistant'] });
  check('H8 an already-clean artifact is returned by identity',
    gateLayoutInputBadges(clean) === clean);
}

// H9 — the wire. H1-H8 exercise the pure function; without these a
// `return layoutInput` stub at the call site would leave them all green
// while production stayed open.
{
  const BSE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'brandScriptExecutor.js'), 'utf8');
  const iQuotes = BSE_SRC.indexOf('layoutInput = gateLayoutInputQuotes');
  const iBadges = BSE_SRC.indexOf('layoutInput = gateLayoutInputBadges');
  check('H9 buildMetaForAd calls gateLayoutInputBadges', iBadges !== -1,
    'the gate exists but nothing calls it');
  check('H9 the badge gate runs AFTER the quote gate so both compose',
    iQuotes !== -1 && iBadges > iQuotes, `quotes@${iQuotes} badges@${iBadges}`);
  const exports_ = BSE_SRC.slice(BSE_SRC.lastIndexOf('module.exports = {'));
  check('H9 gateLayoutInputBadges is exported', /gateLayoutInputBadges\s*[,}]/.test(exports_));

  // Structural slice, comment-stripped — same discipline as G.
  const gStart = BSE_SRC.indexOf('function gateLayoutInputBadges(');
  const gRel = gStart === -1 ? -1 : BSE_SRC.slice(gStart).search(/\nfunction /);
  const GATE = gStart === -1 || gRel <= 0 ? '' :
    BSE_SRC.slice(gStart, gStart + gRel).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  check('H9 the gate body was located', GATE.length > 500, `${GATE.length} chars`);
  check('H9 it delegates to filterUnearnedBadges (ONE lexicon, no second allowlist)',
    /filterUnearnedBadges\s*\(/.test(GATE),
    're-implementing the lexicon here is exactly how door 2 stayed open while C2 stayed green');
  check('H9 it does NOT read CatalogProduct (gates on the artifact\'s own numbers)',
    !/CatalogProduct/.test(GATE));
  check('H9 it gates on social_proof rating_value / review_count',
    /rating_value/.test(GATE) && /review_count/.test(GATE));
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyNoUnearnedClaims: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyNoUnearnedClaims: ${passed} checks passed`);
