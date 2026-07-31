#!/usr/bin/env node
'use strict';

/**
 * verifyQuoteGate — the star gate and the product-review resolver, pinned.
 *
 * WHY THIS EXISTS. Both invariants below have already been broken once by a
 * merge, silently, with no test to catch it:
 *
 *   1. The 4.5-star floor. A branch landed a SECOND, lower floor (4) inside
 *      pickStrongestQuote. It happened to be a no-op only because every rated
 *      tier passed through gateQuotesByRating first — one new tier, or one
 *      caller reaching pickStrongestQuote directly, and 4-star reviews would
 *      have gone onto paid ads. Two constants that must agree is a bug
 *      waiting for its moment; this asserts there is one number.
 *
 *   2. The product tier reading the wrong field. hydrateMatch writes
 *      productReviews to the TOP LEVEL of the match; the read site looked only
 *      at identification.details. The tier was structurally empty on every
 *      hydrated match, so the whole scraped-review engine never reached an ad
 *      — and nothing failed, the ad just quietly quoted a category review.
 *
 * No network, no database. Pure functions only.
 */

const path = require('path');
const svc  = require(path.join(__dirname, '..', 'services', 'layoutInputService.js'));

const { gateQuotesByRating, pickStrongestQuote, productReviewsOf, toFiveScale, QUOTE_MIN_RATING } = svc;

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else    { fail += 1; console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}

function truthy(label, actual) { check(label, !!actual, true); }

// Quiet the gate's per-tier console reporting so the harness output reads.
const realLog = console.log;
function quiet(fn) {
  console.log = () => {};
  try { return fn(); } finally { console.log = realLog; }
}

console.log('\nverifyQuoteGate\n');

// ── A. one threshold, and it is 4.5 ──────────────────────────────────
console.log('A. a single star threshold');
check('QUOTE_MIN_RATING is 4.5', QUOTE_MIN_RATING, 4.5);
truthy('no second threshold constant is exported', svc.MIN_STARS_FOR_AD === undefined);

// ── B. scale normalization ───────────────────────────────────────────
console.log('\nB. ratings normalize to a 5-point scale before comparison');
check('5-point passes through',        toFiveScale(4.7),  4.7);
check('a perfect 5 stays 5',           toFiveScale(5),    5);
check('10-point halves',               toFiveScale(9),    4.5);
check('a perfect 10 becomes 5',        toFiveScale(10),   5);
check('100-point divides by 20',       toFiveScale(90),   4.5);
check('a perfect 100 becomes 5',       toFiveScale(100),  5);
check('numeric string is accepted',    toFiveScale('4.8'), 4.8);
// Number(null) === 0. Treating that as a zero-star rating would invert the
// gate: unrated quotes are ALLOWED through, zero-star ones must not be.
check('null is unrated, not zero',      toFiveScale(null),      null);
check('undefined is unrated',           toFiveScale(undefined), null);
check('empty string is unrated',        toFiveScale(''),        null);
check('false is unrated',               toFiveScale(false),     null);
check('non-numeric is unrated',         toFiveScale('great'),   null);
check('a real 0 is a real rating',      toFiveScale(0),         0);

// ── C. the tier gate ─────────────────────────────────────────────────
console.log('\nC. gateQuotesByRating drops reviews the reviewer scored low');
const gated = quiet(() => gateQuotesByRating([
  { text: 'five star',        rating: 5   },
  { text: 'exactly the bar',  rating: 4.5 },
  { text: 'just under',       rating: 4.4 },
  { text: 'four star',        rating: 4   },
  { text: 'one star',         rating: 1   },
  { text: 'ninety percent',   rating: 90  },
  { text: 'sixty percent',    rating: 60  },
  { text: 'no rating at all' }
], 'test'));
check('keeps only >= 4.5 (normalized), plus unrated',
  gated.map(q => q.text),
  ['five star', 'exactly the bar', 'ninety percent', 'no rating at all']);
check('a 4-star review does not survive the gate',
  gated.some(q => q.text === 'four star'), false);
check('60/100 is 3 stars and is dropped, not read as 60',
  gated.some(q => q.text === 'sixty percent'), false);

// ── D. the picker re-applies the same floor ──────────────────────────
console.log('\nD. pickStrongestQuote enforces the SAME floor when reached ungated');
// Two quotes that both clear the sentiment gate, one scoring the prose
// clearly higher than the other, so these cases isolate the STAR logic.
const STRONG = 'Absolutely love the fit on this one, and it still looks brand new after six months';
const WEAKER = 'Absolutely love the fit on this one';
truthy('fixture: the strong quote scores above the weak one',
  quiet(() => pickStrongestQuote([{ text: STRONG }, { text: WEAKER }]))?.text === STRONG);

// The old second floor was 4. If it came back, the better-written 4-star wins.
const pickedUngated = quiet(() => pickStrongestQuote([
  { text: STRONG, rating: 4 },
  { text: WEAKER, rating: 5 }
]));
check('a 4-star candidate cannot win an ungated pool, even writing better',
  pickedUngated && pickedUngated.rating, 5);

const pickedAllLow = quiet(() => pickStrongestQuote([
  { text: STRONG, rating: 4 },
  { text: WEAKER, rating: 3 }
]));
check('an all-sub-threshold rated pool yields nothing', pickedAllLow, null);

const pickedUnrated = quiet(() => pickStrongestQuote([
  { text: WEAKER },
  { text: 'Bought it last week' }
]));
truthy('an entirely unrated pool still picks (comments, LLM tiers)', pickedUnrated);

// A 100-point rating must not buy its way to the top with a huge star bonus:
// unnormalized, its bonus was rating - 4.5, i.e. +95.5 onto a single-digit
// prose score.
const pickedScale = quiet(() => pickStrongestQuote([
  { text: WEAKER, rating: 100 },
  { text: STRONG, rating: 5   }
]));
check('a 100-scale rating cannot outrank better prose',
  pickedScale && pickedScale.text, STRONG);

check('an empty pool returns null', quiet(() => pickStrongestQuote([])), null);

// ── E. the product-review resolver ───────────────────────────────────
console.log('\nE. productReviewsOf finds reviews wherever hydration put them');
const hydratedOnly = { productReviews: { quotes: [{ text: 'from the top level' }] } };
check('reads the hydrated top-level field',
  productReviewsOf(hydratedOnly)?.quotes[0].text, 'from the top level');

const seededOnly = { identification: { details: { productReviews: { quotes: [{ text: 'from the seed pick' }] } } } };
check('reads the seeded details field',
  productReviewsOf(seededOnly)?.quotes[0].text, 'from the seed pick');

const both = {
  productReviews: { quotes: [{ text: 'hydrated' }] },
  identification: { details: { productReviews: { quotes: [{ text: 'seeded' }] } } }
};
check('the operator seed pick wins over hydration',
  productReviewsOf(both)?.quotes[0].text, 'seeded');

const emptySeed = {
  productReviews: { quotes: [{ text: 'hydrated' }] },
  identification: { details: { productReviews: { quotes: [] } } }
};
check('a quoteless seed does not mask a populated hydration',
  productReviewsOf(emptySeed)?.quotes[0].text, 'hydrated');

check('no reviews anywhere is null', productReviewsOf({}), null);
check('a null match is null',        productReviewsOf(null), null);

// ── F. comments are judged by inference, not by a lexicon ────────────
// The comment gate is NOT hasPositiveSignal any more — see docs/PROOF_JUDGE.md.
// Comments are judged once at ingest and every surface reads the stored
// verdict, so what this section pins is that the judged API exists and that
// nothing has quietly reverted the comment paths to the keyword screen.
console.log('\nF. the comment path uses the ingest judgment, not a lexicon');
const qs = require(path.join(__dirname, '..', 'services', 'quoteSnippetService.js'));
truthy('judgeProofLines is exported',      typeof qs.judgeProofLines === 'function');
truthy('ensureCommentsJudged is exported', typeof qs.ensureCommentsJudged === 'function');
truthy('usableProofComments is exported',  typeof qs.usableProofComments === 'function');

const Comment = require(path.join(__dirname, '..', 'models', 'Comment.js'));
const judgmentPath = Comment.schema.path('proofJudgment.usable');
truthy('Comment.proofJudgment.usable exists on the schema', !!judgmentPath);
// Absent must mean "not yet judged", never "rejected" — a default of false
// would make every pre-existing comment permanently unusable with no backfill.
check('proofJudgment.usable has NO default', judgmentPath?.defaultValue, undefined);
truthy('Comment.proofJudgment.line exists', !!Comment.schema.path('proofJudgment.line'));

// The comment consumers must not be screening on the lexicon any more. Grep
// rather than call, because these paths need a database.
const fs = require('fs');
const srcOf = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CONSUMERS = [
  'services/layoutInputService.js',
  'services/aiCanvasInputBuilder.js',
  'services/aiCreativeDirectorService.js',
  'services/aiImageReferenceService.js'
];
for (const f of CONSUMERS) {
  truthy(`${f} routes comments through usableProofComments`,
    srcOf(f).includes('usableProofComments'));
}
// hasPositiveSignal survives ONLY as a review-quote screen inside
// layoutInputService. If it reappears in a comment consumer, the lexicon is
// back in the decision path.
for (const f of CONSUMERS.filter(x => !x.endsWith('layoutInputService.js'))) {
  truthy(`${f} no longer screens on hasPositiveSignal`,
    !srcOf(f).includes('hasPositiveSignal'));
}

// The lexical screen itself, still used for review quotes. Both directions.
console.log('\nG. the residual lexical screen (review quotes only)');
const { hasPositiveSignal } = svc;
truthy('praise passes',                   hasPositiveSignal('Absolutely love the fit on this one'));
truthy('a complaint is rejected',        !hasPositiveSignal('Fell apart after one wash, total waste of money'));
truthy('a negated positive is rejected', !hasPositiveSignal('Not great, would not buy again'));
truthy('a neutral statement is rejected',!hasPositiveSignal('Ordered this on the third of the month'));

console.log(`\n${fail === 0 ? '✅' : '❌'} verifyQuoteGate: ${pass}/${pass + fail} checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
