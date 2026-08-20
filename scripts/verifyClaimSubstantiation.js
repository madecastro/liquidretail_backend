#!/usr/bin/env node
'use strict';

/**
 * verifyClaimSubstantiation — offline, revert-proof pins for the badge
 * substantiation gate (services/claimSubstantiationService.js) and for the
 * fix to layoutInputService's defaultBadgesFromSignal.
 *
 * WHY THIS EXISTS
 * ---------------
 * PR #138's harness (scripts/verifyNoUnearnedClaims.js) pins that no
 * CASCADE LITERAL may assert an unearned claim. It does not — and by
 * design cannot — see a badge that arrives through the LLM derivation
 * path: services/layoutInputService.js's Gemini structured-output call
 * populates `input.product.badges`, which is not a literal at all. That is
 * exactly the hole this fix closes, confirmed live on
 * run_1787174963435_ff67021e (Marine Layer 2): 21/21 video ads shipped
 * badges=["Top rated","Best seller","Sustainably made"] with
 * rating=null/reviewCount=null. A blast-radius query against production
 * (2026-08-19) found 592 delivered ads across 17 brands already carrying
 * an unsubstantiated claim of this kind.
 *
 * This harness drives the REAL exported functions — not a source-text
 * scan (that pattern has already failed once in this repo: see
 * layoutInputService.js's comment on deriveSocialProofNumbers/gateQuotesByRating
 * — "a name scan cannot tell a refactor from a regression"). Reverting
 * either fix must turn this red:
 *   a) delete/hollow out services/claimSubstantiationService.js, or
 *      loosen any of its three rules (barred-outright categories,
 *      RATING_CLAIM_MIN, SAMPLE_FLOOR) -> classify()/substantiateBadges()
 *      checks fail.
 *   b) re-add the missing reviewCount floor to
 *      layoutInputService.defaultBadgesFromSignal (i.e. go back to
 *      `rating >= 4.5` alone) -> the defaultBadgesFromSignal check fails.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyClaimSubstantiation.js
 */

const path = require('path');
const {
  classify,
  parseAssertedCount,
  hasStrongSignal,
  substantiateBadges,
  substantiateBadge,
  RATING_CLAIM_MIN,
  SAMPLE_FLOOR,
} = require(path.join(__dirname, '..', 'services', 'claimSubstantiationService'));
const { defaultBadgesFromSignal } = require(path.join(__dirname, '..', 'services', 'layoutInputService'));

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertArrayEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'arrayEq'}: expected ${e}, got ${a}`);
}

// ── Thresholds are the reused house constants, not fresh numbers ────────
check('constants: RATING_CLAIM_MIN matches PMAX_PROOF_STRONG_RATING default (4.5)',
  () => assert(RATING_CLAIM_MIN === 4.5, `got ${RATING_CLAIM_MIN}`));
check('constants: SAMPLE_FLOOR matches PMAX_PROOF_MIN_REVIEW_COUNT default (100)',
  () => assert(SAMPLE_FLOOR === 100, `got ${SAMPLE_FLOOR}`));

// ── A. THE CONFIRMED LIVE INCIDENT ───────────────────────────────────────
// run_1787174963435_ff67021e: rating=null, reviewCount=null. All three
// invented badges must be stripped, including "Sustainably made" — the
// one the prompt's own examples never even named.
check('A1 confirmed incident: all three unearned badges stripped with no evidence', () => {
  const kept = substantiateBadges(['Top rated', 'Best seller', 'Sustainably made'], { rating: null, reviewCount: null });
  assertArrayEq(kept, []);
});
check('A2 confirmed incident: each candidate individually classified into a real category', () => {
  // "Top rated" is a RATING claim (evidence-gated on rating+sample floor,
  // see section C) — it is withheld in A1 because the confirmed incident's
  // evidence is null, not because the category is barred outright.
  // "Best seller" and "Sustainably made" ARE barred outright (sections B1/B2).
  assert(classify('Top rated') === 'rating_quality', classify('Top rated'));
  assert(classify('Best seller') === 'sales_standing', classify('Best seller'));
  assert(classify('Sustainably made') === 'unverifiable_attribute', classify('Sustainably made'));
});

// ── B. BARRED OUTRIGHT — no amount of evidence unlocks these ────────────
const STRONGEST_EVIDENCE = { rating: 5.0, reviewCount: 1_000_000 };
check('B1 sales-standing claims stay barred even with maximal evidence', () => {
  const candidates = ['Best seller', 'Bestseller', 'Top seller', '#1', 'Most popular',
    'Customer favorite', 'Community Favorite', "Editor's pick", 'Staff pick', 'Trending now',
    'Best-in-class', 'Most loved', 'Award-winning', 'As seen on TV'];
  const kept = substantiateBadges(candidates, STRONGEST_EVIDENCE);
  assertArrayEq(kept, []);
});
check('B2 environmental/ethical/certification claims stay barred even with maximal evidence', () => {
  const candidates = ['Sustainably made', 'Eco-friendly', 'Organic', 'Cruelty-free', 'Vegan',
    'Carbon neutral', 'Fair trade', 'B Corp Certified', 'Clinically proven', 'All-natural'];
  const kept = substantiateBadges(candidates, STRONGEST_EVIDENCE);
  assertArrayEq(kept, []);
});
check('B3 generalized favorite/fave pattern catches qualifiers PR #138 never listed', () => {
  // Production already carries these exact strings (blast-radius query,
  // 2026-08-19) — the point of a CATEGORY gate is that a NEW qualifier in
  // front of "favorite/fave" is caught without a code change.
  for (const s of ['Summer Favorite', 'Cult Favorite', 'Viral Fave', 'SF favorite', 'Fitness Fave', 'Angler Favorite']) {
    assert(classify(s) === 'sales_standing', `expected sales_standing for "${s}", got ${classify(s)}`);
  }
});

// ── C. RATING-QUALITY CLAIMS — evidence-gated, sample floor matters ─────
// This is the audit's specific "4.5★ From 11 Reviews" thin-proof concern.
check('C1 "Top rated" WITHHELD when rating is strong but sample is thin (11 reviews)', () => {
  const kept = substantiateBadges(['Top rated'], { rating: 4.6, reviewCount: 11 });
  assertArrayEq(kept, []);
});
check('C2 "Top rated" WITHHELD one review short of the sample floor (99)', () => {
  const kept = substantiateBadges(['Top rated'], { rating: 4.6, reviewCount: 99 });
  assertArrayEq(kept, []);
});
check('C3 "Top rated" KEPT exactly at the sample floor (100) with a strong rating', () => {
  const kept = substantiateBadges(['Top rated'], { rating: 4.6, reviewCount: 100 });
  assertArrayEq(kept, ['Top rated']);
});
check('C4 "Top rated" WITHHELD when rating is high volume but rating itself is weak (4.2/500)', () => {
  const kept = substantiateBadges(['Top rated'], { rating: 4.2, reviewCount: 500 });
  assertArrayEq(kept, []);
});
check('C5 hyphenated/decimal star forms recognized as rating_quality', () => {
  assert(classify('5-Star Rated') === 'rating_quality');
  assert(classify('4.8★ Rated') === 'rating_quality');
  assert(classify('Highly rated') === 'rating_quality');
});
check('C6 hasStrongSignal boundary semantics match substantiateBadges', () => {
  assert(hasStrongSignal(4.5, 100) === true);
  assert(hasStrongSignal(4.49, 100) === false);
  assert(hasStrongSignal(4.5, 99) === false);
  assert(hasStrongSignal(null, 100) === false);
  assert(hasStrongSignal(4.5, null) === false);
});

// ── D. REVIEW-VOLUME CLAIMS — the SPECIFIC asserted tier must be true ───
check('D1 "10k+ reviews" WITHHELD when real reviewCount is only 150', () => {
  const kept = substantiateBadges(['10k+ reviews'], { rating: null, reviewCount: 150 });
  assertArrayEq(kept, []);
});
check('D2 "100+ reviews" KEPT when real reviewCount clears that specific tier', () => {
  const kept = substantiateBadges(['100+ reviews'], { rating: null, reviewCount: 150 });
  assertArrayEq(kept, ['100+ reviews']);
});
check('D3 "1k+ reviews" parses to 1000, not 1', () => {
  assert(parseAssertedCount('1k+ reviews') === 1000);
  assert(parseAssertedCount('523 reviews') === 523);
  assert(parseAssertedCount('Trusted by 5k+ customers') === 5000);
});
check('D4 review-volume claim needs NO rating floor (a pure count claim)', () => {
  const kept = substantiateBadges(['150+ reviews'], { rating: null, reviewCount: 150 });
  assertArrayEq(kept, ['150+ reviews']);
});

// ── E. SCOPE — unclassified descriptive badges are NOT swept up ─────────
// Validated against the real production vocabulary (blast-radius query):
// these must survive with no evidence at all, or the gate has silently
// widened into a ban on ordinary product-attribute copy.
check('E1 plain descriptive/attribute badges pass through with zero evidence', () => {
  const candidates = ['All-Day Comfort', 'Machine Washable', '100% Cotton', 'So Versatile',
    'New Arrival', 'UPF 50+ Protection', 'Official NFL Licensed', 'Peloton Collab', 'Limited Edition'];
  const kept = substantiateBadges(candidates, { rating: null, reviewCount: null });
  assertArrayEq(kept, candidates);
});
check('E2 classify() reports these as unclassified, not one of the two barred categories', () => {
  for (const s of ['All-Day Comfort', 'Machine Washable', '100% Cotton']) {
    assert(classify(s) === 'unclassified', `expected unclassified for "${s}", got ${classify(s)}`);
  }
});

// ── F. substantiateBadge (scalar) — used for badgeText / deliveryLine ───
check('F1 substantiateBadge drops a barred scalar', () => {
  assert(substantiateBadge('Best seller', { rating: 5, reviewCount: 999999 }) === null);
});
check('F2 substantiateBadge keeps a substantiated scalar', () => {
  assert(substantiateBadge('Top rated', { rating: 4.9, reviewCount: 5000 }) === 'Top rated');
});
check('F3 substantiateBadge handles null/empty input without throwing', () => {
  assert(substantiateBadge(null, {}) === null);
  assert(substantiateBadge('', {}) === null);
  assert(substantiateBadge(undefined, {}) === null);
});

// ── G. defaultBadgesFromSignal (layoutInputService.js) — belt-and-braces
// deterministic-default fix, driven as the SHIPPED function, not a copy ──
check('G1 defaultBadgesFromSignal WITHHOLDS "Top rated" below the sample floor (rating alone was the old bug)', () => {
  const out = defaultBadgesFromSignal({ rating: 4.8, reviewCount: 1 });
  assert(!out.includes('Top rated'), `got ${JSON.stringify(out)} — reviewCount=1 must not unlock 'Top rated'`);
});
check('G2 defaultBadgesFromSignal WITHHOLDS "Top rated" with no reviewCount at all (the confirmed-incident shape)', () => {
  const out = defaultBadgesFromSignal({ rating: 4.8, reviewCount: null });
  assert(!out.includes('Top rated'), `got ${JSON.stringify(out)}`);
});
check('G3 defaultBadgesFromSignal STILL emits "Top rated" once both floors clear', () => {
  const out = defaultBadgesFromSignal({ rating: 4.8, reviewCount: 100 });
  assert(out.includes('Top rated'), `got ${JSON.stringify(out)}`);
});
check('G4 defaultBadgesFromSignal review-count tier badges are unaffected by this fix', () => {
  const out = defaultBadgesFromSignal({ rating: null, reviewCount: 10000 });
  assertArrayEq(out, ['10k+ reviews']);
});

// ── H. Non-string / malformed input never throws (render path safety) ───
check('H1 substantiateBadges tolerates non-array / non-string / empty candidates', () => {
  assertArrayEq(substantiateBadges(null, {}), []);
  assertArrayEq(substantiateBadges(undefined, {}), []);
  assertArrayEq(substantiateBadges([null, '', '   ', 42, {}], {}), []);
});
check('H2 substantiateBadges tolerates malformed evidence (NaN/strings/missing)', () => {
  assertArrayEq(substantiateBadges(['Best seller'], { rating: 'high', reviewCount: '100' }), []);
  assertArrayEq(substantiateBadges(['Best seller'], undefined), []);
});

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyClaimSubstantiation: ${failures.length} FAILED, ${pass} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyClaimSubstantiation: ${pass} checks passed`);
