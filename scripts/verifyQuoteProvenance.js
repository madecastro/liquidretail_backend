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
 *       2026-08-02: llm-web (grounded search) is now PRINTABLE as anonymous
 *       text; synthesized / unknown stay withheld.
 *   P2  A byline is a real person's name or nothing.
 *       Was: normalizeQuote fell back to the quote's SOURCE — a website — then
 *       to "Verified buyer"/"Anonymous Customer". 80 live artifacts carried
 *       "vertexaisearch.cloud.google.com" as the customer's name.
 *   P3  Ratings are bounded and formatted, never printed raw.
 *       Was: typeof 0 === 'number', so a zero rating rendered as "0".
 *       Also: owner product rule (2026-08) — only stars *over* 4.5 print.
 *       Gate is on the DISPLAYED (one-decimal) value, not the raw one:
 *       4.51 / 4.55 round to 4.5 and must be withheld (raw-gate bug).
 *       Shared via services/ratingDisplay.js for static + video chrome.
 *   P4  The gate cannot be forged from the LLM path.
 *       `origin` is not a DERIVATION_SCHEMA property; `source` is, and the
 *       derivation call is strict:false.
 *   P6  Grounded llm-web is printable TEXT ONLY — attribution stripped
 *       structurally by toPrintableCustomerQuote, not by caller convention.
 *       Revert-prove: blank the strip and author fields reappear in intent.
 *
 * Run: node scripts/verifyQuoteProvenance.js
 */
const direct = require('../services/directImageRenderService');
const layout = require('../services/layoutInputService');
const provenance = require('../services/quoteProvenance');
const {
  gateLayoutInputQuotes
} = require('../services/brandScriptExecutor');
const {
  resolveMeta, mergeCascades, buildContext, DEFAULT_META_CASCADES
} = require('../services/metaCascadeResolver');

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
  ['store import', { text: REAL_TEXT, origin: 'store-import' }],
  // Grounded search: Gemini + google_search tool. Text is real; byline is not.
  // verbatim:false is the source-class stamp from stampLlmQuotes, not a fidelity
  // confession — must still print.
  ['LLM web search (grounded, verbatim:false)', {
    text: REAL_TEXT, origin: 'llm-web', verbatim: false,
    author_name: 'vertexaisearch.cloud.google.com', source: 'Reddit (r/BuyItForLife)'
  }],
  ['LLM web search (grounded, no verbatim flag)', {
    text: REAL_TEXT, origin: 'llm-web', author: 'Someone on UBeauty.com'
  }]
];
const WITHHELD = [
  // The two that were shipping as customer testimonials.
  ['LLM persona (unstamped — the tier-5 shape)', { text: REAL_TEXT, source: 'testimonial', author_name: 'Sarah, busy mum' }],
  ['LLM summary sentence', { text: REAL_TEXT, origin: 'synthesized', verbatim: false }],
  // Provenance we simply do not have is not provenance we can print.
  ['unstamped legacy row', { text: REAL_TEXT }],
  // First-party origin with an explicit non-verbatim stamp still means the
  // wording is untrustworthy — that is where verbatim keeps its teeth.
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
// Deliberate contract change (not a test bent to pass): owner rule
// Owner 2026-08-04: "anything above a 4.4 is acceptable" — exclusive floor at
// RATING_STAR_MIN (4.39), applied to the ROUNDED display value so a shown 4.4 prints.
// Gate is on the rounded DISPLAY value: raw 4.51 must not print as "4.5".
const { formatDisplayRating, RATING_STAR_MIN } = require('../services/ratingDisplay');
const RATINGS = [
  [0, undefined, 'a zero rating is not a rating'],
  [-1, undefined, 'negative'],
  [6, undefined, 'above the 5-star scale'],
  [87, undefined, 'a 0-100 scale vendor would print "87 stars"'],
  [4, undefined, 'below the floor'],
  [4.3, undefined, 'a displayed 4.3 is under the 4.39 floor'],
  [4.34, undefined, '4.34 rounds to 4.3 — the rounding trap, one step down'],
  [4.4, '4.4', 'a DISPLAYED 4.4 prints: the owner\'s 2026-08-04 change'],
  [4.44, '4.4', '4.44 rounds to 4.4 and prints'],
  [4.5, '4.5', 'above the 4.39 floor'],
  [4.51, '4.5', 'raw 4.51 displays 4.5, which now clears the floor'],
  [4.55, '4.5', 'JS toFixed puts 4.55 at "4.5", and that prints now'],
  [4.6, '4.6', 'just over the floor still prints'],
  [4.66, '4.7', '4.66 rounds to 4.7 and prints'],
  [4.666666, '4.7', 'a raw float is rounded, not printed in full'],
  [5, '5', 'top of scale'],
  ['4.5', undefined, 'a string is not a number — type strictness is unchanged'],
  [null, undefined, 'null'],
  [NaN, undefined, 'NaN']
];
check('P3 RATING_STAR_MIN is 4.39', RATING_STAR_MIN === 4.39);
for (const [value, expected, why] of RATINGS) {
  const d = direct.buildIntentData({
    concept: {}, layoutInput: { social_proof: { rating_value: value } }, brand: {}, cta: 'X'
  });
  check(`P3 rating ${JSON.stringify(value)} -> ${JSON.stringify(expected)} (${why})`,
    d.rating === expected, `got ${JSON.stringify(d.rating)}`);
  // Shared pure helper must agree with the static intent path (one rule).
  check(`P3 formatDisplayRating(${JSON.stringify(value)}) matches intent`,
    formatDisplayRating(value) === expected,
    `helper=${JSON.stringify(formatDisplayRating(value))} intent=${JSON.stringify(d.rating)}`);
}
// Video chrome source pin: buildMetaForAd must gate ratings so a 3.2 catalog
// rating cannot reach Remotion. Atomic pair resolver (resolveAtomicRatingPair)
// applies formatDisplayRating per tier; offline we cannot run the async Mongo
// path — pin the require + call site instead (revert-prove by deleting it).
{
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'brandScriptExecutor.js'), 'utf8'
  );
  // REWRITTEN 2026-08-03: this pinned the function NAME, not the guarantee. video meta
  // now gates through resolveCoherentSocialProof, which calls resolveAtomicRatingPair
  // internally (and therefore still gates via formatDisplayRating) while additionally
  // enforcing that the quote's tier matches the numbers' tier. Pinning the old name
  // would fail on code that is strictly stronger.
  check('P3 video meta gates rating via the coherence chokepoint',
    /resolveCoherentSocialProof\s*\(/.test(src)
    && /require\s*\(\s*['"]\.\/ratingDisplay['"]\s*\)/.test(src),
    'buildMetaForAd must gate numbers through resolveCoherentSocialProof (which gates via '
    + 'resolveAtomicRatingPair -> formatDisplayRating and adds tier coherence)');
}
// `12 -> 12` CHANGED TO `12 -> undefined` (2026-08-04), deliberately, when the
// static path started sharing the video path's coherence chokepoint.
// resolveCoherentSocialProof withholds a count that has no star rating beside it
// when no quote prints ("product-count and brand-count both require a coherent
// quote", plus allowBrandCountWithoutStars:false in its rating-only branch).
//
// NO PROOF IS LOST, and that is why this expectation could move: `d.reviewCount`
// is only ever rendered as a parenthetical NEXT TO the rating
// (staticAdIntents.js:454,460 — `${d.rating} ★ (${d.reviewCount} reviews)`), so a
// count with no rating never reached an ad. Its only other effect was at :403,
// where a truthy count SUPPRESSES the "no review count, and not the words
// review, reviews, ratings or customers" absence line — so the old behaviour
// dropped that instruction from the prompt while supplying no count for the
// model to use, which is the wrong way round. Withholding is strictly safer.
for (const [value, expected] of [[0, undefined], [-5, undefined], [12, undefined], [null, undefined]]) {
  const d = direct.buildIntentData({
    concept: {}, layoutInput: { social_proof: { review_count: value } }, brand: {}, cta: 'X'
  });
  check(`P3 reviewCount ${JSON.stringify(value)} -> ${JSON.stringify(expected)}`,
    d.reviewCount === expected, `got ${JSON.stringify(d.reviewCount)}`);
}

// The counterpart that proves the above is coherence and not a blanket drop: a
// count PAIRED with a qualifying rating from the same tier still comes through.
{
  const d = direct.buildIntentData({
    concept: {},
    layoutInput: { social_proof: { rating_value: 4.6, review_count: 12, rating_source: 'product' } },
    brand: {}, cta: 'X'
  });
  check('P3 a product-stamped rating+count pair still prints both',
    d.rating === '4.6' && d.reviewCount === 12,
    `got rating=${JSON.stringify(d.rating)} count=${JSON.stringify(d.reviewCount)}`);
}

// ── P3b: the two holes an adversarial pass found, pinned so they stay shut ──

// BLOCKER that was caught before merge: a brand aggregate must not reach the
// static number slots on a product-scoped ad. resolveCoherentSocialProof returns
// brand-SCOPED strings for a brand win ("41000 brand reviews"), but the static
// RATING slot is the hardcoded, unscoped `${rating} ★ (${count} reviews)`
// (staticAdIntents.js:460) — so a brand's 41,000 reviews would read as 41,000
// reviews OF THAT SKU. Until scoped copy is wired into the slot, brand numbers
// come ONLY from a layoutInput pair that stamped rating_source:'brand'.
{
  const d = direct.buildIntentData({
    concept: {},
    layoutInput: { social_proof: {} },                       // no stamped pair at all
    brand: { brandReviews: { rating: 4.8, reviewCount: 41000 } },
    cta: 'X'
  });
  check('P3b brand.brandReviews is NOT a static number source (unscoped-template misattribution)',
    d.rating === undefined && d.reviewCount === undefined,
    `got rating=${JSON.stringify(d.rating)} count=${JSON.stringify(d.reviewCount)} — a brand aggregate `
    + 'would print as product reviews through staticAdIntents.js:460');
}
// The sanctioned brand path still works: layoutInput itself stamping 'brand' is
// how a no-SKU / branding-outcome ad has always carried brand numbers.
{
  const d = direct.buildIntentData({
    concept: {},
    layoutInput: { social_proof: { rating_value: 4.8, review_count: 41000, rating_source: 'brand' } },
    brand: { brandReviews: { rating: 4.8, reviewCount: 41000 } },
    cta: 'X'
  });
  check('P3b a layoutInput-stamped BRAND pair still prints (the pre-existing sanctioned path)',
    d.rating === '4.8' && d.reviewCount === 41000,
    `got rating=${JSON.stringify(d.rating)} count=${JSON.stringify(d.reviewCount)}`);
}
// SERIOUS that was caught before merge: productReviews winning on a COUNT alone
// would hand back {rating:null, count:N} and erase a good top-level rating.
{
  const d = direct.buildIntentData({
    concept: {},
    layoutInput: { social_proof: {} },
    brand: {},
    product: { rating: 4.7, productReviews: { rating: null, reviewCount: 500 } },
    cta: 'X'
  });
  check('P3b a count-only productReviews does not erase the top-level rating',
    d.rating === '4.7',
    `got rating=${JSON.stringify(d.rating)} — productReviews must carry a rating to win`);
}

// And the flag restores the pre-change pass-through exactly, so the behaviour
// change above is revertible without a deploy.
{
  const prev = process.env.STATIC_PROOF_COHERENCE;
  process.env.STATIC_PROOF_COHERENCE = 'false';
  const d = direct.buildIntentData({
    concept: {}, layoutInput: { social_proof: { review_count: 12 } }, brand: {}, cta: 'X'
  });
  check('P3 STATIC_PROOF_COHERENCE=false restores the bare-count pass-through',
    d.reviewCount === 12, `got ${JSON.stringify(d.reviewCount)}`);
  if (prev === undefined) delete process.env.STATIC_PROOF_COHERENCE;
  else process.env.STATIC_PROOF_COHERENCE = prev;
}

// ── P5: shortening must not invert the review ───────────────────────────
// The snippet is what the model typesets, so a shortening that flips a
// complaint into praise puts words in a named customer's mouth. The old check
// was plain substring containment, which passes every one of these.
const snippets = require('../services/quoteSnippetService');
const EXTRACTS = [
  // Negation-stripped: legal substrings, inverted meaning.
  ['worth it', 'Not worth it for the price', false],
  ['sure about the fabric', "I wasn't sure about the fabric", false],
  ['holds up', 'It never holds up in the wash', false],
  ['really sure', 'I was not really sure about it', false],
  ['comfortable', "These are hardly comfortable after an hour", false],
  // Clean extracts must still pass, or the fix has broken the feature.
  ['I would buy again', 'I would buy again in a heartbeat', true],
  ['true to size', 'Runs true to size and washes well', true],
  ['still looks new', 'Still looks new after eight months', true],
  // A repeated span: the FIRST occurrence is negated, a later one is not.
  ['worth it', 'Not worth it at first, but honestly worth it now', true],
  // Word boundaries: the old character test matched 'art' inside 'start'.
  ['art', 'I love the start of every season', false],
  // Paraphrase / reordering must still be rejected.
  ['fabric the about sure', 'I was sure about the fabric', false],
  ['incredibly soft', 'The fabric is soft', false]
];
for (const [snippet, source, expected] of EXTRACTS) {
  check(`P5 extract ${JSON.stringify(snippet)} from ${JSON.stringify(source)} -> ${expected}`,
    snippets.isExtractive(snippet, source) === expected);
}

// ── P6: grounded llm-web is printable, attribution stripped structurally ─
// Owner decision 2026-08-02. Behavioural, not a source scan.
const GROUNDED = {
  text: REAL_TEXT,
  origin: 'llm-web',
  verbatim: false,
  author_name: 'vertexaisearch.cloud.google.com',
  author: 'Reddit (r/BuyItForLife)',
  author_title: 'Verified buyer',
  source: 'UBeauty.com',
  verified: true,
  handle: '@fakehandle'
};

{
  // Gate admits the quote.
  check('P6 isPrintable admits grounded llm-web + verbatim:false',
    provenance.isPrintableCustomerQuote(GROUNDED) === true);

  const printable = provenance.toPrintableCustomerQuote(GROUNDED);
  check('P6 toPrintable returns a quote object', !!printable);
  check('P6 toPrintable keeps the text',
    printable && printable.text === REAL_TEXT, `got ${JSON.stringify(printable && printable.text)}`);
  check('P6 toPrintable keeps origin llm-web',
    printable && printable.origin === 'llm-web');

  // Every byline field is gone from the returned object — structural, not a
  // "please don't print this" flag the caller could ignore.
  for (const f of provenance.BYLINE_FIELDS) {
    check(`P6 toPrintable strips ${f}`,
      printable && !(f in printable) && printable[f] == null,
      `got ${JSON.stringify(printable && printable[f])}`);
  }
  check('P6 toPrintable strips source (site-as-author vector)',
    printable && !('source' in printable) && printable.source == null,
    `got ${JSON.stringify(printable && printable.source)}`);
  check('P6 toPrintable strips verified (persona claim without a name)',
    printable && !('verified' in printable),
    `got ${JSON.stringify(printable && printable.verified)}`);

  // The ORIGINAL object is untouched — strip is on the copy.
  check('P6 original author_name still present on input (no mutation)',
    GROUNDED.author_name === 'vertexaisearch.cloud.google.com');

  // Static renderer (buildIntentData): text yes, attribution no.
  const d = intentFor(GROUNDED);
  check('P6 static intent prints the grounded text',
    d.quote === REAL_TEXT, `got ${JSON.stringify(d.quote)}`);
  check('P6 static intent prints NO attribution for grounded',
    d.attribution === undefined, `got ${JSON.stringify(d.attribution)}`);

  // A caller that somehow re-attaches a byline on an llm-web quote and re-runs
  // the gate still cannot get it through — the gate re-strips.
  const reattached = { ...printable, author_name: 'Resurrected Name', author: 'Also Resurrected' };
  const restripped = provenance.toPrintableCustomerQuote(reattached);
  check('P6 re-attached author_name cannot survive a second gate pass',
    restripped && !('author_name' in restripped) && restripped.author_name == null,
    `got ${JSON.stringify(restripped && restripped.author_name)}`);
  const d2 = intentFor(reattached);
  check('P6 static intent still has no attribution after re-attach attempt',
    d2.attribution === undefined, `got ${JSON.stringify(d2.attribution)}`);

  // Video path: gateLayoutInputQuotes reseats primary_quote with the stripped
  // copy; cascade's reviewer arms (author_name / author) resolve to nothing.
  const gated = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: GROUNDED } }
  });
  const gatedPq = gated?.input?.social_proof?.primary_quote;
  check('P6 video gate admits grounded primary_quote',
    !!gatedPq && gatedPq.text === REAL_TEXT,
    `got ${JSON.stringify(gatedPq)}`);
  check('P6 video gate stripped author_name on reseated quote',
    gatedPq && !('author_name' in gatedPq),
    `got ${JSON.stringify(gatedPq && gatedPq.author_name)}`);
  check('P6 video gate stripped author on reseated quote',
    gatedPq && !('author' in gatedPq),
    `got ${JSON.stringify(gatedPq && gatedPq.author)}`);

  const ctx = buildContext({ ad: {}, layoutInput: gated });
  const meta = resolveMeta(mergeCascades(DEFAULT_META_CASCADES, null), ctx);
  check('P6 video cascade burns quote text',
    meta.quote === REAL_TEXT, `got ${JSON.stringify(meta.quote)}`);
  check('P6 video cascade burns NO reviewer (metaCascadeConfig author_name/author)',
    meta.reviewer === undefined, `got ${JSON.stringify(meta.reviewer)}`);

  // synthesized still rejected end-to-end.
  const synth = { text: REAL_TEXT, origin: 'synthesized', verbatim: false, author_name: 'Bot' };
  check('P6 synthesized still withheld by predicate',
    provenance.isPrintableCustomerQuote(synth) === false);
  const dSynth = intentFor(synth);
  check('P6 static emits no quote for synthesized', dSynth.quote === undefined);
  const gatedSynth = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: synth } }
  });
  check('P6 video gate nulls synthesized primary_quote',
    gatedSynth?.input?.social_proof?.primary_quote === null);

  // unknown still rejected.
  check('P6 unknown still withheld',
    provenance.isPrintableCustomerQuote({ text: REAL_TEXT, origin: 'unknown' }) === false);

  // Scraped still keeps attribution through the same path.
  const scraped = {
    text: REAL_TEXT, origin: 'scraped', verbatim: true, author_name: 'Jessica L.'
  };
  const scrapedPrintable = provenance.toPrintableCustomerQuote(scraped);
  check('P6 scraped toPrintable keeps author_name',
    scrapedPrintable && scrapedPrintable.author_name === 'Jessica L.',
    `got ${JSON.stringify(scrapedPrintable && scrapedPrintable.author_name)}`);
  const dScraped = intentFor(scraped);
  check('P6 scraped static still prints byline',
    dScraped.attribution === 'Jessica L.', `got ${JSON.stringify(dScraped.attribution)}`);
  const gatedScraped = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: scraped } }
  });
  const metaScraped = resolveMeta(
    mergeCascades(DEFAULT_META_CASCADES, null),
    buildContext({ ad: {}, layoutInput: gatedScraped })
  );
  check('P6 scraped video cascade still burns reviewer',
    metaScraped.reviewer === 'Jessica L.',
    `got ${JSON.stringify(metaScraped.reviewer)}`);
}

// ── P6-revert-surface: the strip must be structural ─────────────────────
// If someone rewrites toPrintable to `return { ...q }` for llm-web (admits
// the quote but forgets to strip), every check below fails. That is the
// revert-proof for the attribution half of the owner decision.
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../services/quoteProvenance.js'), 'utf8'
  );
  check('P6-revert surface: ANONYMOUS_PRINT_ORIGINS includes llm-web',
    /ANONYMOUS_PRINT_ORIGINS[\s\S]*?llm-web/.test(src));
  check('P6-revert surface: toPrintable deletes byline fields (not just a comment)',
    /delete out\[f\]/.test(src) || /for\s*\(.*BYLINE_FIELDS/.test(src));
  check('P6-revert surface: directImage uses toPrintable return value',
    /toPrintableCustomerQuote\s*\(\s*proof\.primary_quote\s*\)/.test(
      fs.readFileSync(path.join(__dirname, '../services/directImageRenderService.js'), 'utf8')
    ));
  check('P6-revert surface: layout pool maps toPrintable (not boolean filter alone)',
    /\.map\s*\(\s*toPrintableCustomerQuote\s*\)/.test(
      fs.readFileSync(path.join(__dirname, '../services/layoutInputService.js'), 'utf8')
    ));
  check('P6-revert surface: video gate reseats primary_quote with printable',
    /primary_quote:\s*printable/.test(
      fs.readFileSync(path.join(__dirname, '../services/brandScriptExecutor.js'), 'utf8')
    ));
  // Widened BYLINE_FIELDS — structural strip must cover future producers.
  for (const f of ['reviewer', 'user_name', 'platform', 'site']) {
    check(`P6 BYLINE_FIELDS includes ${f}`, provenance.BYLINE_FIELDS.includes(f));
  }
}

// ── P7: SHOW-to-LLM — derivation prompt + Director brand signal ─────────
// We stopped PRINTING bylines but still SHOWed them to the LLMs that author
// copy. Those models echo bylines into input.copy.* / copy.headline, which
// burn without re-gating. Behavioural, not a source scan.
{
  const director = require('../services/aiCreativeDirectorService');
  const LLM_WEB_QUOTE = {
    text: REAL_TEXT,
    origin: 'llm-web',
    verbatim: false,
    author: 'vertexaisearch.cloud.google.com',
    author_name: 'Reddit (r/BuyItForLife)',
    source: 'UBeauty.com',
    verified: true
  };

  // Product-mode derivation prompt: quote TEXT yes; author/source/persona no.
  const productPrompt = layout.buildDerivationPrompt(
    {
      media: {},
      detection: null,
      match: {
        outcome: 'product_match',
        productReviews: { quotes: [LLM_WEB_QUOTE] }
      },
      brand: {}
    },
    'testimonial_spotlight',
    '1:1',
    {}
  );
  check('P7 derivation prompt contains quote TEXT',
    productPrompt.includes(REAL_TEXT),
    `prompt excerpt: ${JSON.stringify(productPrompt.slice(0, 400))}`);
  check('P7 derivation prompt has no site-as-author (vertexaisearch)',
    !productPrompt.includes('vertexaisearch'),
    `leaked in: ${JSON.stringify((productPrompt.match(/.*vertexaisearch.*/i) || [])[0])}`);
  check('P7 derivation prompt has no Reddit byline',
    !productPrompt.includes('Reddit'),
    `leaked in: ${JSON.stringify((productPrompt.match(/.*Reddit.*/i) || [])[0])}`);
  check('P7 derivation prompt has no UBeauty source domain',
    !productPrompt.includes('UBeauty'),
    `leaked in: ${JSON.stringify((productPrompt.match(/.*UBeauty.*/i) || [])[0])}`);
  check('P7 derivation prompt has no invented "Verified buyer"',
    !productPrompt.includes('Verified buyer'),
    `leaked in: ${JSON.stringify((productPrompt.match(/.*Verified buyer.*/i) || [])[0])}`);
  check('P7 derivation prompt has no invented "Anonymous Customer"',
    !productPrompt.includes('Anonymous Customer'),
    `leaked in: ${JSON.stringify((productPrompt.match(/.*Anonymous Customer.*/i) || [])[0])}`);

  // Brand-mode derivation path (sibling site) — same rule.
  const brandPrompt = layout.buildDerivationPrompt(
    {
      media: {},
      detection: null,
      match: {
        outcome: 'brand_match',
        brandReviews: {
          quotes: [{
            text: REAL_TEXT,
            author: 'vertexaisearch.cloud.google.com',
            source: 'Reddit (r/BuyItForLife)',
            origin: 'llm-web',
            verbatim: false
          }]
        }
      },
      brand: {}
    },
    'testimonial_spotlight',
    '1:1',
    {}
  );
  check('P7 brand derivation prompt contains quote TEXT',
    brandPrompt.includes(REAL_TEXT));
  check('P7 brand derivation prompt has no author/source byline',
    !brandPrompt.includes('vertexaisearch') && !brandPrompt.includes('Reddit'),
    `leaked: ${JSON.stringify((brandPrompt.match(/.*(?:vertexaisearch|Reddit).*/i) || [])[0])}`);

  // quoteLineForTonePrompt unit: never invents persona when fields empty.
  const emptyLine = layout.quoteLineForTonePrompt({
    text: REAL_TEXT, origin: 'llm-web', verified: true
  });
  check('P7 tone line for llm-web is text-only',
    emptyLine === `    - "${REAL_TEXT}"`,
    `got ${JSON.stringify(emptyLine)}`);
  const invented = layout.quoteLineForTonePrompt({
    text: REAL_TEXT, verified: true
  });
  check('P7 unstamped verified still invents no persona',
    invented === `    - "${REAL_TEXT}"` &&
      !String(invented).includes('Verified') &&
      !String(invented).includes('Anonymous'),
    `got ${JSON.stringify(invented)}`);
  // First-party with a real name still may carry the name (tonal voice).
  const scrapedLine = layout.quoteLineForTonePrompt({
    text: REAL_TEXT, origin: 'scraped', author: 'Jessica L.', verbatim: true
  });
  check('P7 scraped tone line may keep a real author',
    scrapedLine === `    - "${REAL_TEXT}" — Jessica L.`,
    `got ${JSON.stringify(scrapedLine)}`);

  // Director brand-mode signal: author stripped.
  const dirSignal = director.brandQuoteForDirectorSignal(LLM_WEB_QUOTE);
  check('P7 Director brand signal keeps text',
    dirSignal && dirSignal.text === REAL_TEXT,
    `got ${JSON.stringify(dirSignal)}`);
  check('P7 Director brand signal carries no author',
    dirSignal && (dirSignal.author == null || dirSignal.author === undefined),
    `got author=${JSON.stringify(dirSignal && dirSignal.author)}`);
  // String form (enrichment can store plain strings).
  const dirString = director.brandQuoteForDirectorSignal(REAL_TEXT);
  check('P7 Director brand signal from string has no author',
    dirString && dirString.text === REAL_TEXT && dirString.author == null,
    `got ${JSON.stringify(dirString)}`);
}

// ── P7-revert-surface: derivation prompt must use the tone helper ───────
// If someone restores `q.author || q.source || (verified ? 'Verified buyer'
// : 'Anonymous Customer')` the behavioural checks above fail; this surface
// check names the call site so a partial revert is also caught.
{
  const fs = require('fs');
  const path = require('path');
  const layoutSrc = fs.readFileSync(
    path.join(__dirname, '../services/layoutInputService.js'), 'utf8'
  );
  check('P7-revert surface: layout uses quoteLineForTonePrompt (not inline author invent)',
    /quoteLineForTonePrompt\s*\(/.test(layoutSrc) &&
      !/Verified buyer.*Anonymous Customer|Anonymous Customer.*Verified buyer/.test(layoutSrc));
  check('P7-revert surface: no Verified buyer / Anonymous Customer invent in layoutInputService',
    !/q\.author\s*\|\|\s*q\.source\s*\|\|\s*\(q\.verified\s*\?\s*['"]Verified buyer['"]/.test(layoutSrc));
  const dirSrc = fs.readFileSync(
    path.join(__dirname, '../services/aiCreativeDirectorService.js'), 'utf8'
  );
  check('P7-revert surface: Director brand quotes go through brandQuoteForDirectorSignal',
    /brandQuoteForDirectorSignal/.test(dirSrc) &&
      /\.map\s*\(\s*brandQuoteForDirectorSignal\s*\)/.test(dirSrc));
  check('P7-revert surface: brandQuoteForDirectorSignal calls toPrintableCustomerQuote',
    /function brandQuoteForDirectorSignal[\s\S]*?toPrintableCustomerQuote/.test(dirSrc));
}

if (failures.length) {
  console.error(`\n❌ quote provenance: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ quote provenance: ${pass} checks passed`);
