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
 *   P8  QUOTE_PROVENANCE_STRICT (default off). A brand-pool quote that
 *       names a product type the seed does not show must not print.
 *       Canonical failing input: Vuori bomber-jacket review over a
 *       track-pants + sneakers scene. Flag-off is byte-identical.
 *
 * REMOVED (dormant render fallback deletion): every check that drove
 * `services/directImageRenderService.js`'s `buildIntentData` (the mint-time
 * static-ad render entry point's prompt-building, reached only from the now-
 * deleted `renderDirectImage`) has been removed — that function and
 * everything reachable only from it no longer exist; adgen owns static
 * rendering unconditionally now. This cost: P1's buildIntentData-through-
 * the-renderer checks (the isolated-gate checks against
 * `isPrintableCustomerQuote` stay), P2's "the renderer must not resurrect it
 * either" static check (the `normalizeQuote`-level check stays), P3's
 * rating-via-buildIntentData half (`formatDisplayRating`'s own pure-function
 * assertion stays and is now the sole rating pin), the P3 reviewCount-
 * suppression checks (incl. the STATIC_PROOF_COHERENCE flag-off restore),
 * all of P3b (brand-vs-product rating/reviewsText scoping), P6's four
 * static-intent (`intentFor`) assertions (its `isPrintableCustomerQuote` /
 * `toPrintableCustomerQuote` / video-gate assertions all stay), the
 * flag-off byte-identity re-run at the end of P8, the buildIntentData half
 * of the P8 "render-time defence" block (its gateLayoutInputQuotes /
 * video-path half is untouched), the P8-revert source pins against
 * directImageRenderService.js's now-nonexistent Media.select /
 * toPrintableCustomerQuote / applyStrictQuoteScope call sites, and the whole
 * "Live static projection" block. Everything testing
 * `services/quoteProvenance.js` directly (isPrintableCustomerQuote,
 * toPrintableCustomerQuote, the P8 noun-scope selectors) and everything
 * testing the VIDEO path (gateLayoutInputQuotes / buildMetaForAd / the
 * metaCascadeResolver chain, still live in `services/brandScriptExecutor.js`)
 * is unaffected and stays.
 *
 * Run: node scripts/verifyQuoteProvenance.js
 */
const intents = require('../services/staticAdIntents');
const layout = require('../services/layoutInputService');
const provenance = require('../services/quoteProvenance');
const {
  gateLayoutInputQuotes,
  buildMetaForAd
} = require('../services/brandScriptExecutor');
const {
  resolveMeta, mergeCascades, buildContext, DEFAULT_META_CASCADES
} = require('../services/metaCascadeResolver');

// QUOTE_PROVENANCE_STRICT now defaults 'true' (2026-08-19, see
// quoteProvenance.js header). Groups P1-P7 below test the PRINTABLE-ORIGIN /
// BYLINE / RATING gates, not the noun-scope feature, and were written and
// pinned against a flag-OFF ambient default — pin it explicitly here so
// they stay byte-identical to their original intent regardless of which way
// the default flips in future. P8 (below) opts into strict mode explicitly
// via withStrictFlag wherever it needs to.
process.env.QUOTE_PROVENANCE_STRICT = 'false';

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
  [5, '5.0', 'top of scale — one decimal, never the integer 5 that reads as a broken widget'],
  ['4.5', undefined, 'a string is not a number — type strictness is unchanged'],
  [null, undefined, 'null'],
  [NaN, undefined, 'NaN']
];
check('P3 RATING_STAR_MIN is 4.39', RATING_STAR_MIN === 4.39);
for (const [value, expected, why] of RATINGS) {
  check(`P3 formatDisplayRating(${JSON.stringify(value)}) -> ${JSON.stringify(expected)} (${why})`,
    formatDisplayRating(value) === expected, `got ${JSON.stringify(formatDisplayRating(value))}`);
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

  // A caller that somehow re-attaches a byline on an llm-web quote and re-runs
  // the gate still cannot get it through — the gate re-strips.
  const reattached = { ...printable, author_name: 'Resurrected Name', author: 'Also Resurrected' };
  const restripped = provenance.toPrintableCustomerQuote(reattached);
  check('P6 re-attached author_name cannot survive a second gate pass',
    restripped && !('author_name' in restripped) && restripped.author_name == null,
    `got ${JSON.stringify(restripped && restripped.author_name)}`);

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
  // The former "directImage uses toPrintable return value" pin was removed
  // with `renderDirectImage`/`buildIntentData` (dormant render fallback
  // deletion, 2026-09-07) — directImageRenderService.js no longer calls
  // toPrintableCustomerQuote at all. The same GUARANTEE (a caller uses the
  // gate's sanitized RETURN VALUE, never the original object) still holds on
  // the two live callers pinned below and in quoteRotationService.js.
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

// ── P8: QUOTE_PROVENANCE_STRICT — no wrong-product review quotes ─────
// Live defect 2026-08-12: a Vuori media-driven ad (no CatalogProduct)
// composited a bomber-jacket review over track-pants + sneakers, and
// video titling quoted a fragment of the SAME review. Fixed flag-on, but
// scoped "product-attached → identity", and flag defaulted OFF.
//
// REOPENED + CLOSED 2026-08-19: an art-direction review of a real Vuori
// PRODUCT-ATTACHED tee ad (run_1787119100250_eef4d871,
// 6a6624fe5f5af85a46562e38) found the exact same bomber-jacket line cached
// as that ad's primary_quote — reachable specifically BECAUSE it was
// product-attached, the one case the 2026-08-12 fix exempted. Flag now
// defaults 'true', and product-attached is noun-checked like everything
// else (see quoteProvenance.js header for the full mechanism). Selection
// only — quote TEXT is never edited.
const {
  PRODUCT_NOUNS,
  quoteProvenanceStrictEnabled,
  productNounsIn,
  collectScopeLabelText,
  quoteAllowedForScope,
  isBrandQuoteAllowedForSeed,
  selectBrandQuotesForScope,
  pickScopedBrandQuote,
  applyStrictQuoteScope
} = provenance;

const BOMBER_JACKET_QUOTE =
  "The fabric is so soft. I love that it's a bomber-style jacket and cinched at the waist but not tight...";
const GENERIC_QUOTE = 'The fabric is so soft and I wear it every day.';
const PANTS_SNEAKER_MEDIA = {
  subjects: [
    { label: 'track pants' },
    { description: 'sneakers' }
  ],
  refinedProducts: [{ label: 'pants' }],
  primarySubjectLabel: 'Track pants',
  classification: {
    detectSummary: {
      matchedProducts: [{ name: 'Performance jogger' }]
    }
  }
};
const JACKET_MEDIA = {
  subjects: [{ label: 'bomber jacket' }],
  refinedProducts: [{ label: 'jacket' }],
  primarySubjectLabel: 'Jacket'
};
const BOMBER_Q = {
  text: BOMBER_JACKET_QUOTE, origin: 'llm-web', verbatim: false, tier: 'brand'
};
const GENERIC_Q = {
  text: GENERIC_QUOTE, origin: 'scraped', verbatim: true, tier: 'brand'
};

function withStrictFlag(on, fn) {
  const prev = process.env.QUOTE_PROVENANCE_STRICT;
  // EXPLICIT 'false', never delete — the flag now defaults true (2026-08-19),
  // so deleting the var to mean "off" would flip to the new default and mean
  // "on" instead. This helper must set what it means, not rely on absence.
  process.env.QUOTE_PROVENANCE_STRICT = on ? 'true' : 'false';
  const restore = () => {
    if (prev === undefined) delete process.env.QUOTE_PROVENANCE_STRICT;
    else process.env.QUOTE_PROVENANCE_STRICT = prev;
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return Promise.resolve(out).finally(restore);
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

// Listed nouns — the conservative set the owner named, plus the
// garments the first matcher omitted (crewneck / pullover / sweatshirt
// / flip-flop / top). 'short' is deliberately NOT listed (adjective).
for (const noun of [
  'jacket', 'hoodie', 'dress', 'pants', 'jogger', 'shirt', 'tee',
  'shoe', 'sneaker', 'sandal', 'shorts', 'legging', 'bra',
  'hat', 'scarf', 'bag', 'sock', 'sweater', 'coat', 'vest', 'skirt',
  'swimsuit', 'bikini', 'crewneck', 'pullover', 'sweatshirt',
  'flip-flop', 'top'
]) {
  check(`P8 PRODUCT_NOUNS includes ${noun}`, PRODUCT_NOUNS.includes(noun));
}
check('P8 PRODUCT_NOUNS does not list adjective short', !PRODUCT_NOUNS.includes('short'));
check('P8 PRODUCT_NOUNS is frozen', Object.isFrozen(PRODUCT_NOUNS));

// Flag default is ON (2026-08-19). This file pinned the env var 'false' at
// the very top (to keep P1-P7 byte-identical); delete that override here to
// observe the REAL default, then restore it immediately.
{
  const prev = process.env.QUOTE_PROVENANCE_STRICT;
  delete process.env.QUOTE_PROVENANCE_STRICT;
  check('P8 flag defaults ON', quoteProvenanceStrictEnabled() === true);
  process.env.QUOTE_PROVENANCE_STRICT = prev;
}
check('P8 flag-off: the string "false" is off',
  withStrictFlag(false, () => {
    process.env.QUOTE_PROVENANCE_STRICT = 'false';
    return quoteProvenanceStrictEnabled() === false;
  }));
check('P8 flag-on: the string "true" is on',
  withStrictFlag(true, () => quoteProvenanceStrictEnabled() === true));

// Canonical bomber-jacket case.
check('P8 bomber quote names jacket',
  productNounsIn(BOMBER_JACKET_QUOTE).includes('jacket'));
check('P8 pants/sneaker labels do not name jacket',
  !productNounsIn(collectScopeLabelText({ media: PANTS_SNEAKER_MEDIA })).includes('jacket'));
check('P8 pants/sneaker labels name pants and sneaker',
  productNounsIn(collectScopeLabelText({ media: PANTS_SNEAKER_MEDIA })).includes('pants')
  && productNounsIn(collectScopeLabelText({ media: PANTS_SNEAKER_MEDIA })).includes('sneaker'));

check('P8 bomber + pants/sneaker labels → rejected',
  quoteAllowedForScope(BOMBER_JACKET_QUOTE, collectScopeLabelText({ media: PANTS_SNEAKER_MEDIA })) === false);
check('P8 bomber + jacket product title → accepted',
  quoteAllowedForScope(BOMBER_JACKET_QUOTE, collectScopeLabelText({
    productTitle: 'Vuori Ripstop Bomber Jacket'
  })) === true);
check('P8 bomber + jacket subject label → accepted',
  isBrandQuoteAllowedForSeed(BOMBER_Q, { media: JACKET_MEDIA }) === true);
check('P8 bomber + productMatch title "Bomber Jacket" → accepted',
  isBrandQuoteAllowedForSeed(BOMBER_Q, {
    match: { identification: { productName: 'Ripstop Bomber Jacket' } }
  }) === true);
check('P8 jackets plural in a jacket title still matches',
  quoteAllowedForScope('I love these jackets', 'Sunday Performance Jackets') === true);
check('P8 generic quote names no product noun',
  productNounsIn(GENERIC_QUOTE).length === 0);
check('P8 generic quote passes with no product / no labels',
  isBrandQuoteAllowedForSeed(GENERIC_Q, {}) === true);
check('P8 generic quote passes against pants/sneaker labels',
  isBrandQuoteAllowedForSeed(GENERIC_Q, { media: PANTS_SNEAKER_MEDIA }) === true);

// Matcher holes the first pass shipped: adjective "short", tee/shirt,
// shoe/sneaker, and omitted garment types (crewneck / sweatshirt / top).
check('P8 adjective "short delivery" is not a product noun',
  productNounsIn('short delivery time').length === 0);
check('P8 "in short, I love it" is not a product noun',
  productNounsIn('in short, I love it').length === 0);
check('P8 "came up short" is not a product noun',
  productNounsIn('came up short').length === 0);
check('P8 "these shorts dry fast" names shorts',
  productNounsIn('these shorts dry fast').includes('shorts'));
check('P8 Kore Short title unlocks a shorts quote (label-side short)',
  quoteAllowedForScope('these shorts dry fast', collectScopeLabelText({
    productTitle: 'Kore Short'
  })) === true);
check('P8 tee and t-shirt canonicalize to the same type',
  productNounsIn('love this tee')[0] === productNounsIn('this t-shirt is great')[0]
  && productNounsIn('love this tee')[0] === productNounsIn('tshirt is great')[0]);
check('P8 Everyday Tee title accepts a t-shirt quote',
  quoteAllowedForScope('this t-shirt is great', collectScopeLabelText({
    productTitle: 'Everyday Tee'
  })) === true);
check('P8 Classic T-Shirt title accepts a tee quote',
  quoteAllowedForScope('love this tee', collectScopeLabelText({
    productTitle: 'Classic T-Shirt'
  })) === true);
check('P8 shoes quote is allowed over sneakers labels',
  quoteAllowedForScope('love these shoes', collectScopeLabelText({
    media: PANTS_SNEAKER_MEDIA
  })) === true);
check('P8 crewneck quote is rejected over pants/sneaker seed',
  quoteAllowedForScope('crewneck is perfect', collectScopeLabelText({
    media: PANTS_SNEAKER_MEDIA
  })) === false);
check('P8 sweatshirt quote is rejected over pants/sneaker seed',
  quoteAllowedForScope('pullover fleece sweatshirt', collectScopeLabelText({
    media: PANTS_SNEAKER_MEDIA
  })) === false);
check('P8 "love this top" is rejected over pants/sneaker seed',
  quoteAllowedForScope('love this top', collectScopeLabelText({
    media: PANTS_SNEAKER_MEDIA
  })) === false);
check('P8 "top quality" is GENERIC (adjective top is not a product type)',
  productNounsIn('top quality fabric').length === 0);
check('P8 flip-flops quote is rejected over pants/sneaker seed',
  quoteAllowedForScope('flip-flops last forever', collectScopeLabelText({
    media: PANTS_SNEAKER_MEDIA
  })) === false);

// Selection: flag-off is an identity (same array reference).
{
  const pool = [BOMBER_Q, GENERIC_Q];
  const out = withStrictFlag(false, () => selectBrandQuotesForScope(pool, {
    productAttached: false, media: PANTS_SNEAKER_MEDIA
  }));
  check('P8 flag-off selectBrandQuotesForScope returns the same array', out === pool);
  check('P8 flag-off keeps the bomber quote (identity)', out[0] === BOMBER_Q);
}

// Flag-on selection rules.
withStrictFlag(true, () => {
  const pantsPool = [BOMBER_Q, GENERIC_Q];
  const kept = selectBrandQuotesForScope(pantsPool, {
    productAttached: false, media: PANTS_SNEAKER_MEDIA
  });
  check('P8 flag-on bomber+pants: bomber dropped, generic kept',
    kept.length === 1 && kept[0] === GENERIC_Q && kept[0].text === GENERIC_QUOTE);
  check('P8 never edits quote TEXT (same object, same string)',
    kept[0] === GENERIC_Q && kept[0].text === GENERIC_QUOTE);

  const jacketKept = selectBrandQuotesForScope(pantsPool, {
    productAttached: false, media: JACKET_MEDIA
  });
  check('P8 flag-on bomber+jacket media: bomber kept',
    jacketKept.length === 2 && jacketKept[0] === BOMBER_Q);

  const titleKept = selectBrandQuotesForScope([BOMBER_Q], {
    productAttached: false, productTitle: 'Vuori Ripstop Bomber Jacket'
  });
  check('P8 flag-on bomber+jacket title: bomber kept',
    titleKept.length === 1 && titleKept[0] === BOMBER_Q);

  const none = selectBrandQuotesForScope([BOMBER_Q], {
    productAttached: false, media: PANTS_SNEAKER_MEDIA
  });
  check('P8 flag-on bomber-only + pants labels: pool empty (DROP)',
    none.length === 0);

  const picked = pickScopedBrandQuote([BOMBER_Q, GENERIC_Q], {
    productAttached: false, media: PANTS_SNEAKER_MEDIA
  });
  check('P8 pick next candidate: generic wins after bomber is rejected',
    picked === GENERIC_Q);

  const dropped = pickScopedBrandQuote([BOMBER_Q], {
    productAttached: false, media: PANTS_SNEAKER_MEDIA
  });
  check('P8 pick next candidate: none pass → null', dropped === null);

  // REVERSED 2026-08-19 (was: product-attached => identity, no noun-scope —
  // that bypass is exactly what let a bomber-jacket brand quote survive
  // onto a real Vuori TEE ad, which IS product-attached). Product-attached
  // now noun-checks the SAME as media-driven, with productTitle folded into
  // the allowed labels so a quote matching THIS product's own garment type
  // still passes.
  const attachedPool = [BOMBER_Q, GENERIC_Q];

  // The product genuinely IS a jacket → the bomber line matches and stays.
  const attachedMatch = selectBrandQuotesForScope(attachedPool, {
    productAttached: true, productTitle: 'Vuori Ripstop Bomber Jacket'
  });
  check('P8 product-attached + matching garment title: bomber kept',
    attachedMatch.length === 2 && attachedMatch[0] === BOMBER_Q);

  // The product is a TEE (the real defect's shape) → the bomber line names
  // a DIFFERENT garment than the product and must be dropped; the generic
  // line survives (QUOTE_BRAND_TIER_FALLBACK's last-resort role intact).
  const attachedMismatch = selectBrandQuotesForScope(attachedPool, {
    productAttached: true, productTitle: 'Vuori Heavyweight Tee'
  });
  check('P8 [THE DEFECT] product-attached + mismatched garment title: bomber dropped',
    attachedMismatch.length === 1 && attachedMismatch[0] === GENERIC_Q,
    `got ${attachedMismatch.length} quote(s)`);

  // No product title / labels at all on a product-attached call → a
  // GENERIC quote (no garment noun) still passes; nothing to compare a
  // garment-naming quote against, so it is conservatively dropped rather
  // than guessed at.
  check('P8 product-attached, no labels at all: generic still kept',
    selectBrandQuotesForScope([GENERIC_Q], { productAttached: true }).length === 1);
  check('P8 product-attached, no labels at all: bomber dropped (nothing to match against)',
    selectBrandQuotesForScope([BOMBER_Q], { productAttached: true }).length === 0);

  check('P8 product-attached pick is the first brand-pool quote',
    pickScopedBrandQuote([GENERIC_Q], { productAttached: true }) === GENERIC_Q);
  check('P8 product-attached pick rescues generic when the bomber mismatches',
    pickScopedBrandQuote([BOMBER_Q, GENERIC_Q], {
      productAttached: true, productTitle: 'Vuori Heavyweight Tee'
    }) === GENERIC_Q);
});

// Render-time defence: gateLayoutInputQuotes (the video path — the static
// buildIntentData half of this block was removed with `renderDirectImage`;
// see the header note).
withStrictFlag(true, () => {
  const gated = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: BOMBER_Q } }
  }, { productAttached: false, media: PANTS_SNEAKER_MEDIA });
  check('P8 video gate nulls bomber primary_quote over pants/sneaker seed (media only)',
    gated?.input?.social_proof?.primary_quote === null);

  const gatedOk = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: BOMBER_Q } }
  }, { productAttached: false, media: JACKET_MEDIA });
  check('P8 video gate keeps bomber quote over a jacket seed (media only)',
    !!gatedOk?.input?.social_proof?.primary_quote
    && gatedOk.input.social_proof.primary_quote.text === BOMBER_JACKET_QUOTE);

  const gatedGeneric = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: GENERIC_Q } }
  }, { productAttached: false });
  check('P8 video gate keeps a generic quote with no product',
    gatedGeneric?.input?.social_proof?.primary_quote?.text === GENERIC_QUOTE);

  const gatedAttached = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: { ...GENERIC_Q, tier: 'brand' } } }
  }, { productAttached: true, productTitle: 'Kore Short' });
  check('P8 video gate KEEPS a brand-tier quote when a product is attached (last-resort)',
    gatedAttached?.input?.social_proof?.primary_quote?.text === GENERIC_QUOTE);

  const gatedAttachedMismatch = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: BOMBER_Q } }
  }, { productAttached: true, productTitle: 'Vuori Heavyweight Tee' });
  check('P8 [THE 2026-08-19 DEFECT] video gate NULLS a bomber quote on a product-attached TEE ad',
    gatedAttachedMismatch?.input?.social_proof?.primary_quote === null);

  const gatedRescue = gateLayoutInputQuotes({
    input: {
      social_proof: { primary_quote: BOMBER_Q, secondary_quotes: [GENERIC_Q] }
    }
  }, { productAttached: false, media: PANTS_SNEAKER_MEDIA });
  check('P8 video gate rescues the next allowed brand-pool quote',
    gatedRescue?.input?.social_proof?.primary_quote?.text === GENERIC_QUOTE);
});

// ── P8-revert-prove ─────────────────────────────────────────────────
// Each rule is pinned two ways: a behavioural check above that fails if
// the shipped function is loosened, and a source pin so a caller can
// not silently stop asking.
{
  const fs = require('fs');
  const path = require('path');
  const provSrc = fs.readFileSync(
    path.join(__dirname, '../services/quoteProvenance.js'), 'utf8'
  );
  const layoutSrc = fs.readFileSync(
    path.join(__dirname, '../services/layoutInputService.js'), 'utf8'
  );
  const dirSrc = fs.readFileSync(
    path.join(__dirname, '../services/aiCreativeDirectorService.js'), 'utf8'
  );
  const bseSrc = fs.readFileSync(
    path.join(__dirname, '../services/brandScriptExecutor.js'), 'utf8'
  );

  check('P8-revert [THE 2026-08-19 DEFECT]: selectBrandQuotesForScope has NO productAttached bypass',
    !/if\s*\(\s*opts\.productAttached\s*\)\s*return\s*list/.test(provSrc));
  check('P8-revert: selectBrandQuotesForScope is gated on quoteProvenanceStrictEnabled',
    /function selectBrandQuotesForScope[\s\S]*?quoteProvenanceStrictEnabled/.test(provSrc));
  check('P8-revert [THE 2026-08-19 DEFECT]: applyStrictQuoteScope has NO productAttached bypass',
    !/if\s*\(\s*opts\.productAttached\s*\)\s*return\s*quote/.test(provSrc));
  check('P8-revert: quoteProvenanceStrictEnabled defaults true (not merely "true" opt-in)',
    /quoteProvenanceStrictEnabled[\s\S]{0,40}return[\s\S]{0,80}\?\?\s*'true'/.test(provSrc));
  check('P8-revert: adjective short is not generated from shorts',
    /do not add 'short'/.test(provSrc) && !/n === 'pants' \|\| n === 'shorts'/.test(provSrc));
  check('P8-revert: layoutInputService calls selectBrandQuotesForScope',
    /selectBrandQuotesForScope\s*\(/.test(layoutSrc));
  check('P8-revert: layout productAttached is options.productId (not PMA catalogProductId)',
    /productAttached:\s*!!(?:options\.productId|\(options\s*&&\s*options\.productId\))/.test(layoutSrc));
  check('P8-revert: layout STRICT no longer empties the brand pool on product ads',
    !/QUOTE_BRAND_TIER_FALLBACK \|\| quoteProvenanceStrictEnabled/.test(layoutSrc));
  check('P8-revert: assembleSignals calls selectBrandQuotesForScope',
    /selectBrandQuotesForScope\s*\(/.test(dirSrc));
  check('P8-revert: assembleSignals feeds scopedBrandQuotes to proof_options brand tier',
    /quotes:\s*scopedBrandQuotes/.test(dirSrc));
  check('P8-revert: assembleSignals scopes category quotes the same way',
    /quotes:\s*scopedCategoryQuotes/.test(dirSrc));
  check('P8-revert: assembleSignals scopes product quotes the same way',
    /quotes:\s*scopedProductQuotes/.test(dirSrc));
  check('P8-revert: assembleSignals does not filter brand_reviews_summary',
    /brand_reviews_summary:\s*snippetText\(brand\?\.brandReviews\?\.summary/.test(dirSrc));
  check('P8-revert: assembleSignals quote scope uses seed media, not the PMA union',
    /quoteScopeMedia/.test(dirSrc) && /loadQuoteScopeMediaByIds/.test(dirSrc)
    && /seededUniverse/.test(dirSrc));
  check('P8-revert: assembleSignals live caller threads seededUniverse',
    /assembleSignals\(\s*\{\s*brandId,\s*productId,\s*campaignKind,\s*seededUniverse\s*\}/.test(dirSrc));
  // The former "buildIntentData calls applyStrictQuoteScope" / "live static
  // Media.select includes seed label fields" pins were removed with
  // `renderDirectImage`/`buildIntentData` (dormant render fallback deletion,
  // 2026-09-07) — directImageRenderService.js no longer builds a prompt or
  // loads seed Media at all. The VIDEO path's equivalent guarantee (below)
  // is what stays live.
  check('P8-revert: gateLayoutInputQuotes calls applyStrictQuoteScope',
    /applyStrictQuoteScope\s*\(/.test(bseSrc));
  check('P8-revert: buildMetaForAd loads seed media and passes it as scope.media',
    /loadQuoteScopeMedia/.test(bseSrc)
    && /gateLayoutInputQuotes\s*\(\s*layoutInput[\s\S]{0,400}?\bmedia\s*:/.test(bseSrc));
  check('P8-revert: quote TEXT is never rewritten (no .text assignment in the new helpers)',
    !/function selectBrandQuotesForScope[\s\S]*?\.text\s*=/.test(provSrc)
    && !/function applyStrictQuoteScope[\s\S]*?\.text\s*=/.test(provSrc));

  // Simulated reverts — the broken selectors that would re-open the defect.
  const brokenNoNounFilter = (quotes, opts) => {
    if (!quoteProvenanceStrictEnabled()) return quotes;
    if (opts.productAttached) return quotes;
    return quotes; // THE LIVE DEFECT: keep bomber over pants
  };
  const brokenEmptiesOnProduct = (quotes, opts) => {
    if (!quoteProvenanceStrictEnabled()) return quotes;
    if (opts.productAttached) return []; // the rule the owner reversed 2026-08-12
    return quotes.filter((q) => isBrandQuoteAllowedForSeed(q, opts));
  };
  // THE 2026-08-19 DEFECT ITSELF, reconstructed: the productAttached bypass
  // that was just removed from selectBrandQuotesForScope/applyStrictQuoteScope.
  // This is not a hypothetical — it is byte-for-byte what shipped between
  // 2026-08-12 and 2026-08-19 and is exactly what let the bomber-jacket
  // quote reach a real, product-attached Vuori tee ad.
  const brokenProductAttachedBypass = (quotes, opts) => {
    if (!quoteProvenanceStrictEnabled()) return quotes;
    if (opts.productAttached) return quotes; // <- the removed bypass
    return quotes.filter((q) => isBrandQuoteAllowedForSeed(q, opts));
  };
  withStrictFlag(true, () => {
    const leaked = brokenNoNounFilter([BOMBER_Q], { productAttached: false });
    check('P8-revert-prove noun rule: skipping the noun filter KEEPS the bomber+pants pair',
      leaked.length === 1 && leaked[0] === BOMBER_Q);
    check('P8-revert-prove noun rule: shipped selector REJECTS that pair',
      selectBrandQuotesForScope([BOMBER_Q], {
        productAttached: false, media: PANTS_SNEAKER_MEDIA
      }).length === 0);

    const emptied = brokenEmptiesOnProduct([GENERIC_Q], { productAttached: true });
    check('P8-revert-prove product-attached: emptying the pool is the OLD (2026-08-12, since reversed) rule',
      emptied.length === 0);
    check('P8-revert-prove product-attached: shipped selector KEEPS the last-resort pool',
      selectBrandQuotesForScope([GENERIC_Q], { productAttached: true }).length === 1);

    // THE DEFECT THIS SESSION FIXED: a mismatched-garment quote on a
    // product-attached ad. The bypass keeps it (broken); the shipped
    // selector, noun-checked against the product's own title, drops it.
    const bypassed = brokenProductAttachedBypass([BOMBER_Q], {
      productAttached: true, productTitle: 'Vuori Heavyweight Tee'
    });
    check('P8-revert-prove [THE 2026-08-19 DEFECT]: the removed bypass KEEPS the bomber on a tee ad',
      bypassed.length === 1 && bypassed[0] === BOMBER_Q);
    check('P8-revert-prove [THE 2026-08-19 DEFECT]: the shipped selector REJECTS it',
      selectBrandQuotesForScope([BOMBER_Q], {
        productAttached: true, productTitle: 'Vuori Heavyweight Tee'
      }).length === 0);

    check('P8-revert-prove adjective short: a matcher that listed short would fire',
      productNounsIn('short delivery time').length === 0);
    check('P8-revert-prove tee/shirt: unaliased tee would reject a t-shirt title',
      quoteAllowedForScope('love this tee', 'Classic T-Shirt') === true);
  });
}

// ── P8 live callers (module stubs, same shape as verifyShopifyLadderBlocks)
function stubQuery(result) {
  const q = {
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean() { return Promise.resolve(result); },
    then(res, rej) { return Promise.resolve(result).then(res, rej); }
  };
  return q;
}

(async () => {
  const Media = require('../models/Media');
  const LayoutInputArtifact = require('../models/LayoutInputArtifact');
  const Brand = require('../models/Brand');
  const CatalogProduct = require('../models/CatalogProduct');
  const ProductMatchArtifact = require('../models/ProductMatchArtifact');
  const director = require('../services/aiCreativeDirectorService');

  const orig = {
    mediaFindById: Media.findById,
    mediaFind: Media.find,
    liaFindOne: LayoutInputArtifact.findOne,
    brandFindById: Brand.findById,
    cpFindById: CatalogProduct.findById,
    pmaFind: ProductMatchArtifact.find
  };

  function restore() {
    Media.findById = orig.mediaFindById;
    Media.find = orig.mediaFind;
    LayoutInputArtifact.findOne = orig.liaFindOne;
    Brand.findById = orig.brandFindById;
    CatalogProduct.findById = orig.cpFindById;
    ProductMatchArtifact.find = orig.pmaFind;
  }

  // Live video caller: buildMetaForAd loads seed Media and hands it to
  // the gate. Bomber over pants seed, no product attached, no product.name.
  try {
    const artifact = {
      input: { social_proof: { primary_quote: BOMBER_Q } },
      schemaVersion: '4.1'
    };
    LayoutInputArtifact.findOne = () => stubQuery(artifact);
    Media.findById = () => stubQuery(PANTS_SNEAKER_MEDIA);
    await withStrictFlag(true, async () => {
      const meta = await buildMetaForAd(
        { _id: 'ad-live', mediaId: 'seed-pants', productId: null },
        { name: 'Vuori' }
      );
      check('P8 live buildMetaForAd DROPS bomber over stubbed pants seed (no product)',
        !meta.quote || !String(meta.quote).toLowerCase().includes('jacket'),
        `got ${JSON.stringify(meta && meta.quote)}`);
    });
  } catch (err) {
    check('P8 live buildMetaForAd DROPS bomber over stubbed pants seed (no product)',
      false, err.message);
  } finally {
    restore();
  }

  // Live Director caller: assembleSignals with a media-driven seed.
  // Jacket review must not reach primary_quote OR proof_options quotes.
  try {
    const brandDoc = {
      name: 'Vuori',
      summary: 'Performance apparel',
      logoUrl: 'http://x',
      brandReviews: {
        summary: 'Customers love the line.',
        rating: 4.8,
        reviewCount: 120,
        quotes: [BOMBER_Q, GENERIC_Q]
      }
    };
    Brand.findById = () => stubQuery(brandDoc);
    CatalogProduct.findById = () => stubQuery(null);
    ProductMatchArtifact.find = () => stubQuery([]);
    Media.find = () => stubQuery([{ _id: 'seed-pants', ...PANTS_SNEAKER_MEDIA }]);
    const prevMenu = process.env.DIRECTOR_PROOF_MENU_ENABLED;
    process.env.DIRECTOR_PROOF_MENU_ENABLED = 'true';
    await withStrictFlag(true, async () => {
      const signals = await director.assembleSignals({
        brandId: 'b1',
        productId: null,
        campaignKind: 'brand',
        seededUniverse: [{ mediaId: 'seed-pants' }]
      });
      const pq = signals?.social_proof_signal?.primary_quote;
      check('P8 live assembleSignals primary_quote is not the bomber',
        !pq || !String(pq.text || '').toLowerCase().includes('jacket'),
        `got ${JSON.stringify(pq)}`);
      check('P8 live assembleSignals primary_quote keeps the generic',
        pq && pq.text === GENERIC_QUOTE, `got ${JSON.stringify(pq)}`);
      const opts = signals?.social_proof_signal?.proof_options || [];
      const brandOpt = opts.find((o) => o.tier === 'brand');
      const brandTexts = (brandOpt?.quotes || []).map((q) => q && q.text);
      check('P8 live assembleSignals proof_options brand quotes drop the bomber',
        brandTexts.every((t) => !String(t || '').toLowerCase().includes('jacket')),
        `got ${JSON.stringify(brandTexts)}`);
      check('P8 live assembleSignals proof_options brand quotes keep the generic',
        brandTexts.includes(GENERIC_QUOTE), `got ${JSON.stringify(brandTexts)}`);
      check('P8 live assembleSignals does not rewrite brand_reviews_summary',
        signals?.brand_signal?.brand_reviews_summary
        && String(signals.brand_signal.brand_reviews_summary).includes('Customers love the line'));
    });
    if (prevMenu === undefined) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
    else process.env.DIRECTOR_PROOF_MENU_ENABLED = prevMenu;
  } catch (err) {
    check('P8 live assembleSignals', false, err.message);
  } finally {
    restore();
  }

  // Flag-off live Director: bomber stays (identity).
  try {
    const brandDoc = {
      name: 'Vuori',
      brandReviews: { quotes: [BOMBER_Q, GENERIC_Q], summary: 'Customers love the line.' }
    };
    Brand.findById = () => stubQuery(brandDoc);
    CatalogProduct.findById = () => stubQuery(null);
    ProductMatchArtifact.find = () => stubQuery([]);
    Media.find = () => stubQuery([{ _id: 'seed-pants', ...PANTS_SNEAKER_MEDIA }]);
    await withStrictFlag(false, async () => {
      const signals = await director.assembleSignals({
        brandId: 'b1', productId: null, campaignKind: 'brand',
        seededUniverse: [{ mediaId: 'seed-pants' }]
      });
      const pq = signals?.social_proof_signal?.primary_quote;
      check('P8 flag-off live assembleSignals keeps the bomber (identity)',
        pq && String(pq.text || '').includes('bomber-style jacket'),
        `got ${JSON.stringify(pq)}`);
    });
  } catch (err) {
    check('P8 flag-off live assembleSignals keeps the bomber (identity)',
      false, err.message);
  } finally {
    restore();
  }

  if (failures.length) {
    console.error(`\n❌ quote provenance: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ quote provenance: ${pass} checks passed`);
})().catch((err) => {
  console.error(`\n❌ quote provenance: live-caller harness crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
