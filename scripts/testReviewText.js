#!/usr/bin/env node
//
// Unit checks for utils/reviewText (sentence-level shortening) and for the
// PROVENANCE stamps that keep a rewritten line from being stored as an
// original customer review.
//
// No network, no DB, no test framework — node:assert + the house check()
// runner (scripts/test*.js).
//
// Usage:
//   node scripts/testReviewText.js

'use strict';

const assert = require('node:assert/strict');

const { shortenReview, scoreSentence } = require('../utils/reviewText');
const { splitSentences, truncateWords } = require('../utils/htmlEntities');
const { reviewText, reviewHtmlText, REVIEW_TEXT_MAX } = require('../services/reviewAdapters/helpers');
const { mapReviewNode } = require('../services/productReviewsScrapeService');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    // An async fn handed to check() would resolve after the summary prints and
    // pass vacuously — assert nothing, report green. Same guard as
    // scripts/testReviewAdapters.js.
    if (r && typeof r.then === 'function') throw new Error('use checkAsync for async tests');
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  });
}

// ── splitSentences must be LOSSLESS ────────────────────────────────
//
// The first implementation used a capturing split that silently dropped text:
// "Measures 5.5 in. wide and 3 in. deep." came back as "5 in. wide…". Every
// review body goes through this, so a lossy splitter corrupts data with no
// error anywhere. The invariant is exact: the parts must concatenate back.

check('splitSentences: parts always concatenate back to the input', () => {
  const inputs = [
    'One sentence only',
    'Two sentences. Here is the second.',
    'Measures 5.5 in. wide and 3 in. deep. Fits perfectly.',
    'Wait... really? Yes! Absolutely.',
    'No terminal punctuation at the end',
    'Dr. Smith said it works. I agree.',
    'Mixed?! Punctuation… runs together. Fine.',
    '   leading and trailing space   ',
    ''
  ];
  for (const s of inputs) {
    assert.equal(splitSentences(s).join(''), s, `lossy for: ${JSON.stringify(s)}`);
  }
});

check('splitSentences: decimals and abbreviations do not split mid-number', () => {
  const parts = splitSentences('Measures 5.5 in. wide and 3 in. deep. Fits perfectly.');
  assert.ok(parts.some(p => p.includes('5.5')), '5.5 was broken up');
  assert.ok(parts.join('').includes('5.5 in. wide and 3 in. deep'), 'text lost');
});

// ── shortenReview ──────────────────────────────────────────────────

check('shortenReview: a body that fits is returned untouched', () => {
  const s = 'Sturdy, comfortable, and it still looks new. Would buy again.';
  assert.equal(shortenReview(s, 500), s);
  assert.equal(shortenReview(s, s.length), s);
});

check('shortenReview: never emits an ellipsis and never cuts mid-word', () => {
  const long = 'Arrived on the 3rd and the box was dented. ' +
               'Still looks brand new after eight months of daily use and two cats. ' +
               'Customer service never answered my email about the missing screw.';
  for (const cap of [40, 60, 80, 90, 120, 160, 200]) {
    const out = shortenReview(long, cap);
    assert.ok(!/[…]|\.\.\.$/.test(out), `ellipsis at cap ${cap}: ${out}`);
    // Every retained fragment must appear verbatim in the source.
    assert.ok(long.includes(out.replace(/\s+/g, ' ')) ||
              out.split(' ').every(w => long.includes(w)),
              `not verbatim at cap ${cap}: ${out}`);
  }
});

check('shortenReview: keeps the MOST USEFUL sentence, not the first', () => {
  const long = 'Ordered this on the 3rd and it arrived the following Tuesday. ' +
               'Still looks brand new after eight months of daily use and two cats.';
  const out = shortenReview(long, 90);
  assert.equal(out, 'Still looks brand new after eight months of daily use and two cats.');
  // The shipping sentence is real feedback but the wrong thing to keep.
  assert.ok(!/arrived/.test(out));
});

check('shortenReview: retained sentences come back in the reviewer\'s order', () => {
  const long = 'The fabric is soft and it washes beautifully every single time. ' +
               'Shipping took nine days which was annoying. ' +
               'I have worn it daily for three months and it still holds its shape.';
  const out = shortenReview(long, 150);
  const a = out.indexOf('fabric');
  const b = out.indexOf('worn it daily');
  assert.ok(a >= 0 && b >= 0, `both strong sentences should survive: ${out}`);
  assert.ok(a < b, `order was not preserved: ${out}`);
  assert.ok(!/Shipping/.test(out), `off-product sentence kept: ${out}`);
});

// The user's requirement, verbatim: "we don't need to pad any leftover space at
// any time, the review is as long as the review is."
check('shortenReview: leftover space is NOT padded with a weak sentence', () => {
  const long = 'Ordered this on the 3rd and it arrived the following Tuesday. ' +
               'Still looks brand new after eight months of daily use and two cats. Nice.';
  const out = shortenReview(long, 90);
  assert.equal(out, 'Still looks brand new after eight months of daily use and two cats.');
  assert.ok(!/Nice\./.test(out), `filler kept purely because it fit: ${out}`);
  // Under-filling the bound is the correct outcome, not a gap to plug.
  assert.ok(out.length < 90);
});

check('shortenReview: one sentence longer than the cap is kept WHOLE, not cut', () => {
  const one = 'This is a single unbroken sentence that runs well past the bound ' +
              'given to it and contains no interior terminal punctuation at all';
  const out = shortenReview(one, 40);
  assert.equal(out, one);
  assert.ok(!/…/.test(out));
});

check('shortenReview: non-strings and empties degrade quietly', () => {
  assert.equal(shortenReview(null, 100), '');
  assert.equal(shortenReview(undefined, 100), '');
  assert.equal(shortenReview('', 100), '');
  // A missing/invalid cap must not silently truncate.
  const s = 'Some review text here.';
  assert.equal(shortenReview(s, NaN), s);
  assert.equal(shortenReview(s, undefined), s);
});

// ── scoreSentence ranking ──────────────────────────────────────────

check('scoreSentence: product praise outranks a shipping complaint', () => {
  const good = 'Still looks brand new after eight months of daily use.';
  const ship = 'Delivery took nine days and the courier left it in the rain.';
  assert.ok(scoreSentence(good) > scoreSentence(ship),
    `${scoreSentence(good)} should beat ${scoreSentence(ship)}`);
});

check('scoreSentence: filler, questions and link spam all sink', () => {
  const real = 'The fabric is soft and it has held up through a dozen washes.';
  for (const weak of ['Nice.', 'Does anyone know if this fits a queen bed?',
                      'See my full review at https://example.com/blog']) {
    assert.ok(scoreSentence(real) > scoreSentence(weak),
      `"${weak}" (${scoreSentence(weak)}) should not beat a real sentence`);
  }
});

check('scoreSentence: empty input is never a candidate', () => {
  assert.equal(scoreSentence(''), -Infinity);
  assert.equal(scoreSentence(null), -Infinity);
});

// ── conversion weighting ───────────────────────────────────────────
//
// These quotes go on ads, so the ranking question is "does this move a browser
// to buy", not "is this a nice review". Enthusiasm is the weakest of the
// signals and generic praise is worse than nothing.

check('conversion: risk reversal and fit outrank enthusiasm', () => {
  const fit = 'It fits true to size and I am normally between a medium and large.';
  const rave = 'I absolutely love it!';
  const durable = 'Still looks brand new after eight months of daily use.';
  assert.ok(scoreSentence(fit) > scoreSentence(durable),
    'risk reversal should beat durability');
  assert.ok(scoreSentence(durable) > scoreSentence(rave),
    'specific durability should beat a generic rave');
});

check('conversion: generic praise scores NEGATIVE, not merely low', () => {
  // "Great product!" on an ad is a wasted impression — it must lose to
  // anything specific, and it must not win a tie on leftover space.
  for (const junk of ['Great product', 'I absolutely love it!', 'Amazing!', 'Nice.']) {
    assert.ok(scoreSentence(junk) < 0, `"${junk}" scored ${scoreSentence(junk)}`);
  }
});

// The user's example, verbatim: "Awesome shirt with awesome fit" would be a
// great review. Short must not mean rejected.
check('conversion: a SHORT specific line still ranks high', () => {
  const short = 'Awesome shirt with awesome fit';
  assert.ok(short.length < 50, 'fixture should be short');
  assert.ok(scoreSentence(short) > 0, `scored ${scoreSentence(short)}`);
  assert.ok(scoreSentence(short) > scoreSentence('I absolutely love this product!'),
    'a short specific line should beat a longer generic one');
});

check('conversion: repeat purchase is credited', () => {
  assert.ok(scoreSentence('This is the third one I have bought for my kitchen.') >
            scoreSentence('This is a nice one for my kitchen.'));
});

// ── snippet preselection (the ad overlay path) ──────────────────────

check('snippet: strongestSentence skips the service complaint', () => {
  const { strongestSentence } = require('../services/quoteSnippetService');
  const review = 'Ordered this on the 3rd and it arrived Tuesday. ' +
                 'Still looks brand new after eight months of daily use and two cats. ' +
                 'Customer service never answered my email.';
  const out = strongestSentence(review);
  // Measured: every model tested picked the customer-service line out of the
  // whole review. Narrowing the input is what prevents it.
  assert.ok(/brand new/.test(out), `picked: ${out}`);
  assert.ok(!/Customer service/.test(out), `picked the complaint: ${out}`);
});

check('snippet: a single-sentence source is returned unchanged', () => {
  const { strongestSentence } = require('../services/quoteSnippetService');
  const one = 'Awesome shirt with awesome fit';
  assert.equal(strongestSentence(one), one);
  assert.equal(strongestSentence(''), '');
});

check('snippet: bestClause prefers a whole clause over an ellipsis cut', () => {
  const { bestClause, truncateAtWordBoundary, MAX_CHARS } = require('../services/quoteSnippetService');
  const sentence = 'The cushions are firm and supportive, my back pain is gone after two weeks';
  const clause = bestClause(sentence, MAX_CHARS);
  assert.ok(clause, 'no clause found');
  assert.ok(clause.length <= MAX_CHARS);
  assert.ok(!/…/.test(clause), 'clause carries an ellipsis');
  assert.ok(sentence.includes(clause), 'clause is not verbatim');
  // The ellipsis path still exists, but only as the last resort.
  assert.ok(/…$/.test(truncateAtWordBoundary('a'.repeat(80), MAX_CHARS)));
});

checkAsync('snippet: a quote already within the overlay budget is passed through', async () => {
  // No model call, no minimum length, no padding.
  const { extractSnippet, MAX_CHARS } = require('../services/quoteSnippetService');
  const short = 'Awesome shirt with awesome fit';
  assert.ok(short.length <= MAX_CHARS);
  const out = await extractSnippet(short);
  assert.equal(out, short);
});

// ── helpers: the path adapters actually call ────────────────────────

check('reviewText: decodes entities and normalises whitespace', () => {
  assert.equal(reviewText('  Fits my 55&quot;  TV\n perfectly. '), 'Fits my 55" TV perfectly.');
  assert.equal(reviewText(''), null);
  assert.equal(reviewText(null), null);
});

check('reviewText: an over-long body loses whole sentences, gains no ellipsis', () => {
  const unit = 'The cushions are firm and comfortable and still look new. ';
  const long = unit.repeat(60);                       // ~3400 chars
  const out = reviewText(long);
  assert.ok(out.length <= REVIEW_TEXT_MAX, `exceeded cap: ${out.length}`);
  assert.ok(!/…/.test(out), 'ellipsis added');
  assert.ok(/\.$/.test(out.trim()), `does not end on a sentence: ${out.slice(-40)}`);
});

check('reviewHtmlText: tags stripped before the length decision, blocks spaced', () => {
  assert.equal(reviewHtmlText('<p>Great mug.</p><p>Keeps coffee hot.</p>'),
    'Great mug. Keeps coffee hot.');
  assert.equal(reviewHtmlText('Line one<br/>line two'), 'Line one line two');
  assert.equal(reviewHtmlText('<div>Fits my 55&quot; TV</div>'), 'Fits my 55" TV');
  assert.equal(reviewHtmlText(''), null);
});

check('truncateWords still marks a cut — it is for TITLES, not bodies', () => {
  // Kept deliberately: an ellipsis on a clipped headline is honest, on a
  // review body it fabricates a trailing-off the reviewer never wrote.
  assert.ok(/…$/.test(truncateWords('a b c d e f g h', 6)));
});

// ── provenance ─────────────────────────────────────────────────────

check('provenance: scraped reviews are stamped scraped/verbatim/product', () => {
  const q = mapReviewNode({
    '@type': 'Review',
    reviewBody: 'Sturdy and comfortable, still perfect after a year.',
    reviewRating: { ratingValue: 5, bestRating: 5 }
  });
  assert.equal(q.origin, 'scraped');
  assert.equal(q.verbatim, true);
  assert.equal(q.scope, 'product');
});

check('provenance: LLM quotes are llm-web / not verbatim, and carry scope', () => {
  // Required so brand-level quotes (which DO get used on ads) are never
  // mistaken for evidence about the product they sit next to.
  //
  // Asserted against source rather than by requiring the module: the provider
  // pulls in axios, and axios needs https-proxy-agent, which is absent from
  // some environments' node_modules. A provenance check must not be the thing
  // that goes red for an unrelated dependency gap.
  const src = require('node:fs').readFileSync(
    require.resolve('../services/providers/geminiSearchProvider'), 'utf8');
  const fn = src.slice(src.indexOf('function stampLlmQuotes'));
  assert.ok(/origin: 'llm-web'/.test(fn), 'origin not stamped llm-web');
  assert.ok(/verbatim: false/.test(fn), 'verbatim not stamped false');
  assert.ok(/stampLlmQuotes\(parsed\.quotes, 'brand'\)/.test(src), 'brand scope not stamped');
  assert.ok(/stampLlmQuotes\(parsed\.quotes, 'product'\)/.test(src), 'product scope not stamped');
});

check('provenance: category quotes are stamped category scope, not verbatim', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../services/categoryReviewsService'), 'utf8');
  assert.ok(/scope: 'category'/.test(src), 'category scope not stamped');
  assert.ok(/origin: 'llm-web'/.test(src), 'category origin not stamped');
});

check('provenance: the review-summary fallback is stamped synthesized', () => {
  // synthesizeQuoteFromReviewSummary turns LLM prose ABOUT reviews into a
  // quote-shaped object; it must never claim to be a review.
  const src = require('node:fs').readFileSync(
    require.resolve('../services/layoutInputService'), 'utf8');
  assert.ok(/origin:\s*'synthesized'/.test(src), 'synthesized origin not stamped');
  // And the render funnel must not re-badge it as a verified buyer.
  assert.ok(/function isFirstPartyQuote/.test(src), 'first-party gate missing');
});

check('no adapter cuts a review body positionally any more', () => {
  const fs = require('node:fs');
  const dir = require('node:path').join(__dirname, '..', 'services', 'reviewAdapters');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'index.js' || f === 'helpers.js') continue;
    const src = fs.readFileSync(require('node:path').join(dir, f), 'utf8');
    // A body assignment must go through reviewText/reviewHtmlText.
    const m = src.match(/const body = ([A-Za-z]+)\(/);
    if (!m) { offenders.push(`${f}: no body assignment found`); continue; }
    if (!['reviewText', 'reviewHtmlText'].includes(m[1])) offenders.push(`${f}: uses ${m[1]}()`);
  }
  assert.deepEqual(offenders, []);
});

// ── summary ────────────────────────────────────────────────────────

(async () => {
  for (const run of asyncChecks) await run();
  const total = passed + failed;
  console.log(`${passed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
