#!/usr/bin/env node
/**
 * Offline proof-integrity harness. No DB, no network, no API key.
 *
 * Pins the rule the owner has stated repeatedly and that this pipeline was
 * breaking in production: never invent proof. An absent field renders as
 * absent; a fabricated one is a lie in the pixels.
 *
 * Each group below was a LIVE defect on 2026-07-31, measured against the real
 * database, so every assertion here is revert-provable:
 *
 *   P1  A quote prints only on POSITIVE provenance (allowlist, not denylist).
 *       Was: buildIntentData read primary_quote with no origin/verbatim check,
 *       so LLM-authored "notional persona" quotes were typeset as testimonials.
 *   P2  A byline is a real person's name or nothing.
 *       Was: normalizeQuote fell back to the quote's SOURCE — a website — then
 *       to "Verified buyer"/"Anonymous Customer". 80 live artifacts carried
 *       "vertexaisearch.cloud.google.com" as the customer's name.
 *   P3  Ratings are bounded and formatted, never printed raw.
 *       Was: typeof 0 === 'number', so a zero rating rendered as "0".
 *   P4  The gate cannot be forged from the LLM path.
 *       `origin` is not a DERIVATION_SCHEMA property; `source` is, and the
 *       derivation call is strict:false.
 *
 * Run: node scripts/verifyQuoteProvenance.js
 */
const direct = require('../services/directImageRenderService');
const layout = require('../services/layoutInputService');
const provenance = require('../services/quoteProvenance');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const REAL_TEXT = 'The fabric held up through a whole season of training.';

// ── P1: allowlist on provenance ─────────────────────────────────────────
const PRINTABLE = [
  ['scraped + verbatim', { text: REAL_TEXT, origin: 'scraped', verbatim: true }],
  ['scraped, unspecified verbatim', { text: REAL_TEXT, origin: 'scraped' }],
  ['social comment', { text: REAL_TEXT, origin: 'social_comment', verbatim: true }],
  ['store import', { text: REAL_TEXT, origin: 'store-import' }]
];
const WITHHELD = [
  // The two that were shipping as customer testimonials.
  ['LLM persona (unstamped — the tier-5 shape)', { text: REAL_TEXT, source: 'testimonial', author_name: 'Sarah, busy mum' }],
  ['LLM summary sentence', { text: REAL_TEXT, origin: 'synthesized', verbatim: false }],
  ['LLM web search', { text: REAL_TEXT, origin: 'llm-web' }],
  // Provenance we simply do not have is not provenance we can print.
  ['unstamped legacy row', { text: REAL_TEXT }],
  ['explicitly non-verbatim, otherwise fine', { text: REAL_TEXT, origin: 'scraped', verbatim: false }],
  ['empty text', { text: '   ', origin: 'scraped', verbatim: true }],
  ['null quote', null],
  // P4: the forgery attempt. An LLM can emit any `source`, including one that
  // names an allowed tier — but it cannot emit `origin`.
  ['LLM forging source=social_comment', { text: REAL_TEXT, source: 'social_comment' }],
  ['LLM forging source=scraped', { text: REAL_TEXT, source: 'scraped', verbatim: true }]
];

for (const [label, q] of PRINTABLE) {
  check(`P1 prints: ${label}`, provenance.isPrintableCustomerQuote(q) === true);
}
for (const [label, q] of WITHHELD) {
  check(`P1 withholds: ${label}`, provenance.isPrintableCustomerQuote(q) === false);
}

// The gate has to hold through buildIntentData, not just in isolation.
function intentFor(quote, extra = {}) {
  return direct.buildIntentData({
    concept: { copy_picks: { headline: 'Built for the long season' } },
    layoutInput: { social_proof: { primary_quote: quote, ...extra } },
    brand: {}, cta: 'SHOP NOW'
  });
}
for (const [label, q] of WITHHELD) {
  const d = intentFor(q);
  check(`P1 buildIntentData emits no quote for: ${label}`, d.quote === undefined, `got ${JSON.stringify(d.quote)}`);
  check(`P1 buildIntentData emits no attribution for: ${label}`, d.attribution === undefined, `got ${JSON.stringify(d.attribution)}`);
}
{
  const d = intentFor({ text: REAL_TEXT, origin: 'scraped', verbatim: true, author_name: 'Jessica L.' });
  check('P1 a legitimate quote still prints', d.quote === REAL_TEXT, `got ${JSON.stringify(d.quote)}`);
  check('P1 a legitimate byline still prints', d.attribution === 'Jessica L.', `got ${JSON.stringify(d.attribution)}`);
}

// ── P1b: 'unknown' is a real value, and it is not printable ─────────────
// The first cut of the producer-side stamp treated "not gemini-search" as
// "storefront import", which stamped every legacy CATEGORY row — LLM web-search
// output, because categoryReviewsService writes `sources` (plural) and no
// `source` — as printable proof.
for (const [label, q] of [
  ['unknown origin', { text: REAL_TEXT, origin: 'unknown' }],
  ['category row with no container source', { text: REAL_TEXT, origin: 'unknown', source: 'llm-web-domain-list' }]
]) {
  check(`P1b withholds: ${label}`, provenance.isPrintableCustomerQuote(q) === false);
}

// ── P2: a byline is a real name or nothing ──────────────────────────────
const NOT_A_PERSON = [
  ['a search endpoint', { text: REAL_TEXT, source: 'vertexaisearch.cloud.google.com' }],
  ['a subreddit', { text: REAL_TEXT, source: 'Reddit (r/BuyItForLife)' }],
  ['a retailer', { text: REAL_TEXT, source: 'UBeauty.com' }],
  ['a brand', { text: REAL_TEXT, source: 'Peloton Apparel' }],
  ['a platform', { text: REAL_TEXT, source: 'YouTube' }],
  ['nothing at all, verified', { text: REAL_TEXT, verified: true }],
  ['nothing at all, unverified', { text: REAL_TEXT, verified: false }]
];
for (const [label, raw] of NOT_A_PERSON) {
  const n = layout.normalizeQuote(raw);
  check(`P2 no byline invented from ${label}`, n && n.author_name === undefined,
    `author_name=${JSON.stringify(n && n.author_name)}`);
  // The renderer must not resurrect it either.
  const d = intentFor({ ...n, origin: 'scraped', verbatim: true });
  check(`P2 renderer prints no byline for ${label}`, d.attribution === undefined,
    `attribution=${JSON.stringify(d.attribution)}`);
}
for (const [label, raw, expected] of [
  ['author_name', { text: REAL_TEXT, author_name: 'Jessica L.' }, 'Jessica L.'],
  ['author', { text: REAL_TEXT, author: 'u/smrzsdcyyz' }, 'u/smrzsdcyyz']
]) {
  const n = layout.normalizeQuote(raw);
  check(`P2 a real name survives via ${label}`, n && n.author_name === expected,
    `got ${JSON.stringify(n && n.author_name)}`);
}
// The honest signals must survive as their own fields — they just are not names.
{
  const n = layout.normalizeQuote({ text: REAL_TEXT, source: 'Reddit', verified: true });
  check('P2 source survives as source', n.source === 'Reddit');
  check('P2 verified survives as verified', n.verified === true);
}

// ── P3: rating bounds and formatting ────────────────────────────────────
const RATINGS = [
  [0, undefined, 'a zero rating is not a rating'],
  [-1, undefined, 'negative'],
  [6, undefined, 'above the 5-star scale'],
  [87, undefined, 'a 0-100 scale vendor would print "87 stars"'],
  [4, '4', 'a clean integer stays clean'],
  [4.5, '4.5', 'one decimal'],
  [4.666666, '4.7', 'a raw float is rounded, not printed in full'],
  [5, '5', 'top of scale'],
  ['4.5', undefined, 'a string is not a number'],
  [null, undefined, 'null'],
  [NaN, undefined, 'NaN']
];
for (const [value, expected, why] of RATINGS) {
  const d = direct.buildIntentData({
    concept: {}, layoutInput: { social_proof: { rating_value: value } }, brand: {}, cta: 'X'
  });
  check(`P3 rating ${JSON.stringify(value)} -> ${JSON.stringify(expected)} (${why})`,
    d.rating === expected, `got ${JSON.stringify(d.rating)}`);
}
for (const [value, expected] of [[0, undefined], [-5, undefined], [12, 12], [null, undefined]]) {
  const d = direct.buildIntentData({
    concept: {}, layoutInput: { social_proof: { review_count: value } }, brand: {}, cta: 'X'
  });
  check(`P3 reviewCount ${JSON.stringify(value)} -> ${JSON.stringify(expected)}`,
    d.reviewCount === expected, `got ${JSON.stringify(d.reviewCount)}`);
}

if (failures.length) {
  console.error(`\n❌ quote provenance: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ quote provenance: ${pass} checks passed`);
