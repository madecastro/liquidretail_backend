#!/usr/bin/env node
'use strict';

/**
 * verifyPostPilotBatch — offline pins for the three post-pilot deploy changes:
 *
 *   CHANGE 1 — atomic rating+count pair (product first, brand fallback with
 *              honest attribution; NEVER product count + brand rating).
 *   CHANGE 2 — camera prompt: subject continuity + return-to-primary in both
 *              directive sets; crossfade/dissolve policy consistent.
 *   CHANGE 3 — primary reference repeat: append when room, not at cap; flag
 *              off → no repeat; total cap 4 (3 distinct + primary).
 *
 * No network, no database, no API key.
 *   node scripts/verifyPostPilotBatch.js
 */

const path = require('path');

const {
  formatDisplayRating,
  resolveAtomicRatingPair,
  brandAttributionLabel,
  RATING_STAR_MIN,
} = require(path.join(__dirname, '..', 'services', 'ratingDisplay.js'));

const {
  buildVeoPrompt,
  OMNI_DIRECTIVES,
  GROK_DIRECTIVES,
} = require(path.join(__dirname, '..', 'services', 'veoPromptBuilder.js'));

const {
  appendPrimaryReferenceRepeat,
  referenceStackBudget,
  isRepeatPrimaryReferenceEnabled,
  REPEAT_PRIMARY_TOTAL_CAP,
  DEFAULT_REFERENCE_IMAGE_COUNT,
} = require(path.join(__dirname, '..', 'services', 'atlasVideoService.js'));

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function truthy(label, v) {
  check(label, !!v, true);
}

function falsy(label, v) {
  check(label, !!v, false);
}

console.log('\nverifyPostPilotBatch\n');

// ═══════════════════════════════════════════════════════════════════════
// CHANGE 1 — atomic rating pair
// ═══════════════════════════════════════════════════════════════════════
console.log('A. atomic rating pair (product first, brand fallback, never mix)');

check('A0 star floor is 4.5', RATING_STAR_MIN, 4.5);

// Product pair present and above gate → used (brand ignored)
{
  const r = resolveAtomicRatingPair({
    productRating: 4.8,
    productReviewCount: 120,
    brandRating: 4.9,
    brandReviewCount: 41000,
    brandAttribution: 'allbirds.com',
  });
  check('A1 product pair used when displayable', r.source, 'product');
  check('A1 rating is product display', r.rating, '4.8');
  check('A1 count is product count', r.reviewCount, 120);
  check('A1 reviewsText product style (no brand attribution)', r.reviewsText, '120 reviews');
}

// Product below gate + brand pair >4.5 → brand pair with attribution
{
  const r = resolveAtomicRatingPair({
    productRating: 4.2,
    productReviewCount: 41000, // would be the historical mix bug if used with brand rating
    brandRating: 4.7,
    brandReviewCount: 8900,
    brandAttribution: 'allbirds.com',
  });
  check('A2 brand pair when product fails gate', r.source, 'brand');
  check('A2 brand rating display', r.rating, '4.7');
  check('A2 brand count (NOT product 41000)', r.reviewCount, 8900);
  check('A2 honest attribution marker', r.reviewsText, '8900 reviews · allbirds.com');
}

// Product exactly 4.5 fails gate (strictly greater)
{
  const r = resolveAtomicRatingPair({
    productRating: 4.5,
    productReviewCount: 50,
    brandRating: 4.9,
    brandReviewCount: 100,
    brandAttribution: 'allbirds.com',
  });
  check('A3 product 4.5 fails gate → brand', r.source, 'brand');
  check('A3 brand rating', r.rating, '4.9');
}

// Brand rating without count → rating, no count (never product's count)
{
  const r = resolveAtomicRatingPair({
    productRating: null,
    productReviewCount: 41000,
    brandRating: 4.8,
    brandReviewCount: null,
    brandAttribution: 'allbirds.com',
  });
  check('A4 brand rating alone is allowed', r.source, 'brand');
  check('A4 rating shown', r.rating, '4.8');
  check('A4 NO count (product count must not leak)', r.reviewCount, null);
  check('A4 reviewsText null when no brand count', r.reviewsText, null);
}

// HISTORICAL BUG PIN: never product count with brand rating
{
  const r = resolveAtomicRatingPair({
    productRating: 3.3, // fails gate
    productReviewCount: 41000,
    brandRating: 4.6,
    brandReviewCount: null,
    brandAttribution: 'allbirds.com',
  });
  check('A5 source is brand', r.source, 'brand');
  check('A5 NEVER product 41000 with brand rating', r.reviewCount, null);
  falsy('A5 reviewsText does not contain product count',
    r.reviewsText && String(r.reviewsText).includes('41000'));
}

// Neither pair displayable
{
  const r = resolveAtomicRatingPair({
    productRating: 4.0,
    productReviewCount: 10,
    brandRating: 4.1,
    brandReviewCount: 20,
    brandAttribution: 'x.com',
  });
  check('A6 both below gate → null source', r.source, null);
  check('A6 no rating', r.rating, null);
  check('A6 no reviewsText', r.reviewsText, null);
}

// brandAttributionLabel prefers domain
check('A7 attribution prefers domain', brandAttributionLabel({
  websiteUrl: 'https://www.allbirds.com/products/foo',
  name: 'Allbirds',
}), 'allbirds.com');
check('A8 attribution falls back to name', brandAttributionLabel({
  name: 'Allbirds',
}), 'Allbirds');
check('A9 formatDisplayRating still gates 4.51 as withhold',
  formatDisplayRating(4.51), undefined);
// 4.55 → toFixed(1) is "4.5" under IEEE (withheld); 4.6 is the first clean pass.
check('A10 formatDisplayRating passes 4.6',
  formatDisplayRating(4.6), '4.6');

// ═══════════════════════════════════════════════════════════════════════
// CHANGE 2 — camera prompt
// ═══════════════════════════════════════════════════════════════════════
console.log('\nB. camera prompt directives (both profiles)');

for (const [name, d] of [['OMNI', OMNI_DIRECTIVES], ['GROK', GROK_DIRECTIVES]]) {
  truthy(`B1 ${name} has subjectContinuity`, d.subjectContinuity && /SUBJECT CONTINUITY/i.test(d.subjectContinuity));
  truthy(`B2 ${name} subject: pose/orientation continuity`,
    /pose|orientation/i.test(d.subjectContinuity));
  truthy(`B3 ${name} subject: no full turn-away closing beat`,
    /turn.*(away|fully)|fully away/i.test(d.subjectContinuity));

  // Transition policy: allow brief crossfades; ban long dissolves / morphing.
  // A bare ban on "dissolves" contradicts "crossfades" (crossfade IS a dissolve).
  truthy(`B4 ${name} transitions allow ~0.25s crossfade`,
    /crossfade/i.test(d.transitions) && /0\.25/.test(d.transitions));
  truthy(`B5 ${name} doNot permits brief crossfades explicitly`,
    /0\.25s crossfade|crossfades between scenes are allowed/i.test(d.doNot));
  truthy(`B6 ${name} doNot bans morphing blends / long dissolves`,
    /morphing blend|long dissolve/i.test(d.doNot));
  // Contradiction pin: doNot must NOT ban bare "dissolves" without the "long" qualifier
  // while transitions still require crossfades. Policy: ban "long dissolves" only.
  falsy(`B7 ${name} doNot does not bare-ban "or dissolves" (contradiction)`,
    /morphing, or dissolves\.?$/i.test(d.doNot) || /,\s*or dissolves/i.test(d.doNot));
}

const promptOmni = buildVeoPrompt({
  product: { title: 'Wool Runner' },
  hasProductReference: true,
  caps: { promptByteCap: 20000, family: 'gemini-omni' },
  durationSec: 8,
});
// promptProfileFor uses caps — ensure omni path; family may not be the selector
const promptDefault = buildVeoPrompt({
  product: { title: 'Wool Runner' },
  hasProductReference: true,
  durationSec: 8,
});

truthy('B8 built prompt has SUBJECT CONTINUITY',
  /SUBJECT CONTINUITY/i.test(promptDefault));
truthy('B9 Scene 3 returns to PRIMARY / FIRST reference',
  /RETURN TO THE PRIMARY VIEW|FIRST reference image/i.test(promptDefault));
truthy('B10 PRODUCT FIDELITY mentions FINAL reference repeats primary',
  /FINAL reference.*primary|final reference image repeats/i.test(promptDefault));
truthy('B11 closing shot must match primary',
  /closing shot must match|end on that same primary/i.test(promptDefault));
truthy('B12 no bare "or dissolves" contradiction in built prompt',
  !/morphing, or dissolves/i.test(promptDefault));
truthy('B13 brief crossfades allowed in built prompt',
  /0\.25s crossfade/i.test(promptDefault));

// Force GROK profile if selectable via caps
const promptGrok = buildVeoPrompt({
  product: { title: 'Wool Runner' },
  hasProductReference: true,
  caps: { promptByteCap: 4096, promptProfile: 'grok' },
  durationSec: 8,
});
// promptProfileFor may key off model id — pin directives objects directly above;
// still assert subject continuity lands in any built prompt under default path.
void promptOmni;
void promptGrok;

// ═══════════════════════════════════════════════════════════════════════
// CHANGE 3 — primary reference repeat
// ═══════════════════════════════════════════════════════════════════════
console.log('\nC. primary reference repeat (stack budget + append)');

check('C0 REPEAT_PRIMARY_TOTAL_CAP is 4', REPEAT_PRIMARY_TOTAL_CAP, 4);
check('C1 DEFAULT_REFERENCE_IMAGE_COUNT is 3', DEFAULT_REFERENCE_IMAGE_COUNT, 3);

// Budget: flag on, default 3 request → distinct 3, total 4
{
  const b = referenceStackBudget({ effectiveMax: 3, modelMax: 7, repeatEnabled: true });
  check('C2 default budget distinctCap=3', b.distinctCap, 3);
  check('C2 default budget totalCap=4', b.totalCap, 4);
}

// Budget: flag off → no bump
{
  const b = referenceStackBudget({ effectiveMax: 3, modelMax: 7, repeatEnabled: false });
  check('C3 flag off distinctCap=3', b.distinctCap, 3);
  check('C3 flag off totalCap=3', b.totalCap, 3);
}

// Budget: model max 1 → no room for repeat
{
  const b = referenceStackBudget({ effectiveMax: 3, modelMax: 1, repeatEnabled: true });
  check('C4 modelMax=1 totalCap=1', b.totalCap, 1);
  check('C4 modelMax=1 distinctCap=1', b.distinctCap, 1);
}

// Budget: operator 5 picks with flag on → cap at 4 total, distinct 3
{
  const b = referenceStackBudget({ effectiveMax: 5, modelMax: 7, repeatEnabled: true });
  check('C5 5 picks → totalCap 4', b.totalCap, 4);
  check('C5 5 picks → distinctCap 3 (leave room for primary)', b.distinctCap, 3);
}

// Append when room
{
  const urls = ['u0', 'u1', 'u2'];
  const out = appendPrimaryReferenceRepeat(urls, { enabled: true, totalCap: 4 });
  check('C6 append primary when room', out, ['u0', 'u1', 'u2', 'u0']);
}

// Not when at cap
{
  const urls = ['u0', 'u1', 'u2', 'u3'];
  const out = appendPrimaryReferenceRepeat(urls, { enabled: true, totalCap: 4 });
  check('C7 no append at cap (never evict)', out, ['u0', 'u1', 'u2', 'u3']);
}

// Flag off
{
  const urls = ['u0', 'u1', 'u2'];
  const out = appendPrimaryReferenceRepeat(urls, { enabled: false, totalCap: 4 });
  check('C8 flag off → no repeat', out, ['u0', 'u1', 'u2']);
}

// Empty / single
{
  check('C9 empty stays empty',
    appendPrimaryReferenceRepeat([], { enabled: true, totalCap: 4 }), []);
  check('C10 single + room → [u0,u0]',
    appendPrimaryReferenceRepeat(['u0'], { enabled: true, totalCap: 4 }), ['u0', 'u0']);
}

// Env default (may be unset in test process — default true)
// Don't assert process env; assert pure helpers with explicit opts (above).
// Smoke that the reader function exists and returns boolean.
truthy('C11 isRepeatPrimaryReferenceEnabled returns boolean',
  typeof isRepeatPrimaryReferenceEnabled() === 'boolean');

// ── Report ────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPostPilotBatch: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  process.exit(1);
}
console.log(`\n✅ verifyPostPilotBatch: ${total}/${total} checks passed`);
console.log('   C1 atomic pair · C2 subject/return-to-primary/crossfade policy · C3 ref repeat+cap4');
