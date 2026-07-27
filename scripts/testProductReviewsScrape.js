#!/usr/bin/env node
//
// Unit checks for services/productReviewsScrapeService — the shared
// on-page review/rating engine. Pure extractors only: no network, no DB
// connection, no test framework (node:assert + the house check() runner).
//
// Usage:
//   node scripts/testProductReviewsScrape.js

'use strict';

const assert = require('node:assert/strict');
const {
  detectReviewPlatform,
  extractOnPageReviews,
  reviewsFromProductNode,
  buildProductReviews,
  isFresh,
  normalizeStars,
  mapReviewNode,
  rankQuotes,
  MIN_POSITIVE_STARS
} = require('../services/productReviewsScrapeService');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const ld = (obj) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

// ── the real-world shape: Bazaarvoice-rendered Living Spaces PDP ────
//
// Verbatim structure from https://www.livingspaces.com/pdp-austen-74-inch-
// media-console-318153 — note the nested nodes use a BARE `type` key while
// the Product uses `@type`. Anything gating on `@type` captures zero
// quotes here, which is exactly the bug this fixture pins.
const LIVING_SPACES = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Austen Black 74" Wide Wood TV Stand',
  sku: '318153',
  aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.9, reviewCount: 156 },
  review: [
    {
      type: 'Review',
      name: 'Great addition!',
      reviewBody: "This is a great piece to add to any home. Sleek and unassuming it's the perfect TV stand with plenty of storage. Incredibly easy to set up.",
      author: { type: 'Person', name: 'RValdez' },
      datePublished: '2026-07-21',
      reviewRating: { type: 'Rating', ratingValue: 5 }
    },
    {
      type: 'Review',
      name: 'Wobbly',
      reviewBody: 'Arrived with a cracked panel and the doors never lined up properly. Two of the shelves were warped out of the box.',
      author: { type: 'Person', name: 'Unhappy' },
      datePublished: '2026-07-22',
      reviewRating: { type: 'Rating', ratingValue: 2 }
    },
    {
      type: 'Review',
      name: 'Entertainment Center',
      reviewBody: 'The entertainment center and two bookshelves were delivered in good shape. We are very happy with the durability and look after 3 months.',
      author: { type: 'Person', name: 'Jack Green' },
      datePublished: '2026-07-19',
      reviewRating: { type: 'Rating', ratingValue: 5 }
    }
  ]
};

check('bare `type` keys (Bazaarvoice/Living Spaces): quotes ARE captured', () => {
  const r = extractOnPageReviews(ld(LIVING_SPACES));
  assert.equal(r.rating, 4.9);
  assert.equal(r.reviewCount, 156);
  assert.equal(r.quotesFound, 3);
  assert.equal(r.quotes.length, 3);
  assert.equal(r.source, 'json-ld');
});

check('per-review stars, headline, author and date are captured', () => {
  const r = extractOnPageReviews(ld(LIVING_SPACES));
  const top = r.quotes[0];
  assert.equal(top.rating, 5);
  assert.ok(top.title, 'expected a review headline');
  assert.ok(top.author, 'expected an author');
  assert.ok(top.datePublished instanceof Date);
});

check('positive-first ordering: the 2-star lands LAST despite newest date', () => {
  const r = extractOnPageReviews(ld(LIVING_SPACES));
  assert.equal(r.quotes[r.quotes.length - 1].rating, 2);
  assert.ok(r.quotes[0].rating >= MIN_POSITIVE_STARS);
  // Document order would have put the 2-star second, recency would have
  // put it first — neither happens.
  assert.notEqual(r.quotes[1].rating, 2);
});

check('cap keeps the BEST quotes, not the first N in document order', () => {
  const many = {
    '@type': 'Product',
    name: 'X',
    review: [
      { type: 'Review', reviewBody: 'Cheap plastic, broke within a week of light use. Very disappointed.', reviewRating: { ratingValue: 1 } },
      { type: 'Review', reviewBody: 'Fell apart after two washes and the seams are already fraying badly.', reviewRating: { ratingValue: 1 } },
      { type: 'Review', reviewBody: 'Held up beautifully through six months of daily use — still looks brand new.', reviewRating: { ratingValue: 5 } }
    ]
  };
  const r = extractOnPageReviews(ld(many), { maxQuotes: 1 });
  assert.equal(r.quotesFound, 3);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].rating, 5);
});

// ── JSON-LD that never appears in a <script> tag (RSC stores) ──────
//
// gap.com forced this: Next.js App Router serialises the whole ld+json tag
// into the React flight payload, so the Product node arrives as a DOUBLY
// ESCAPED string inside a JS array. A script-tag scan finds nothing, and Gap
// reported no reviews at all for a product with 2741 ratings.

check('embedded/escaped JSON-LD in an RSC flight payload is recovered', () => {
  const node = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Modern Khakis',
    sku: '1300460420010',
    aggregateRating: { '@type': 'AggregateRating', ratingCount: 2741, ratingValue: 4.48 }
  };
  // Two levels of escaping, exactly like Gap's payload:
  //   \"children\":\"{\\\"@context\\\":...}\"
  const inner = JSON.stringify(node);                 // level 0
  const once = JSON.stringify(inner);                 // wrapped as a JS string
  const html = '<script>self.__next_f.push([1,"[\\"$\\",\\"$L48\\",null,' +
    '{\\"id\\":\\"seo-page-schema\\",\\"type\\":\\"application/ld+json\\",' +
    '\\"children\\":' + once.replace(/"/g, '\\"') + '}]"])</script>';

  const r = extractOnPageReviews(html);
  assert.equal(r.rating, 4.48, 'rating must survive the escaping');
  assert.equal(r.reviewCount, 2741);
  assert.equal(r.source, 'json-ld');
});

check('embedded scan finds review[] too, not just the aggregate', () => {
  const node = {
    '@context': 'https://schema.org', '@type': 'Product', name: 'X',
    review: [{ '@type': 'Review', reviewBody: 'Held its shape after a year of weekly wear.',
               reviewRating: { ratingValue: 5 }, author: { name: 'Sam' } }]
  };
  const escaped = JSON.stringify(JSON.stringify(node)).replace(/"/g, '\\"');
  const r = extractOnPageReviews(`<script>window.__DATA__={"payload":${escaped}}</script>`);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].rating, 5);
});

check('embedded scan is a no-op on ordinary pages (no false positives)', () => {
  // A page with a real script-tag block must not be double-counted, and a page
  // with neither must stay empty.
  const plain = ld(LIVING_SPACES);
  const r = extractOnPageReviews(plain);
  assert.equal(r.quotesFound, 3, 'script-tag block must not be counted twice');
  const none = extractOnPageReviews('<html><body>no schema, just \\"quotes\\"</body></html>');
  assert.equal(none.rating, null);
  assert.deepEqual(none.quotes, []);
});

check('embedded scan survives malformed escaping without throwing', () => {
  for (const html of [
    '<script>x={\\"@context\\":\\"https://schema.org\\",\\"@type\\":\\"Product\\"',  // truncated
    '<script>x=\\"@context\\":\\"https://schema.org\\"</script>',                            // no object
    '<script>' + '\\"@type\\":\\"Product\\",'.repeat(50) + '</script>'                       // junk repetition
  ]) {
    const r = extractOnPageReviews(html);
    assert.equal(r.rating, null);
  }
});

// ── platform-agnostic coverage ─────────────────────────────────────

check('detectReviewPlatform: the apps clients actually run', () => {
  assert.equal(detectReviewPlatform('<div data-bv-show="rating_summary"></div>'), 'bazaarvoice');
  assert.equal(detectReviewPlatform('<div class="jdgm-widget"></div>'), 'judge.me');
  assert.equal(detectReviewPlatform('<script src="//cdn.yotpo.com/w.js">'), 'yotpo');
  assert.equal(detectReviewPlatform('<div class="oke-stars" data-oke-star-rating>'), 'okendo');
  assert.equal(detectReviewPlatform('<img src="https://cdn.loox.io/x.png">'), 'loox');
  assert.equal(detectReviewPlatform('<script src="https://cdn-stamped.io/w.js">'), 'stamped');
  assert.equal(detectReviewPlatform('<div class="pr-snippet"></div>'), 'powerreviews');
  assert.equal(detectReviewPlatform('<div class="spr-review"></div>'), 'shopify-reviews');
  assert.equal(detectReviewPlatform('<div>plain store page</div>'), null);
});

check('review app is irrelevant to extraction — same JSON-LD, same result', () => {
  const node = {
    '@type': 'Product',
    name: 'Tee',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: '82' },
    review: [{
      '@type': 'Review',
      reviewBody: 'Softest tee I own and it has survived a full year of weekly washes.',
      author: 'Sam',
      reviewRating: { '@type': 'Rating', ratingValue: '5' }
    }]
  };
  const judgeme = extractOnPageReviews(`<div class="jdgm-widget"></div>${ld(node)}`);
  const yotpo   = extractOnPageReviews(`<script src="//cdn.yotpo.com/w.js"></script>${ld(node)}`);
  assert.equal(judgeme.rating, 4.7);
  assert.equal(yotpo.rating, 4.7);
  assert.equal(judgeme.quotes[0].text, yotpo.quotes[0].text);
  assert.equal(judgeme.quotes[0].source, 'judge.me');   // provenance label only
  assert.equal(yotpo.quotes[0].source, 'yotpo');
});

check('@graph-wrapped and mainEntity-wrapped Product nodes are found', () => {
  const graph = extractOnPageReviews(ld({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'PDP' },
      { '@type': 'Product', name: 'G', aggregateRating: { ratingValue: 4.2, reviewCount: 9 } }
    ]
  }));
  assert.equal(graph.rating, 4.2);

  const nested = extractOnPageReviews(ld({
    '@type': 'WebPage',
    mainEntity: { '@type': 'Product', name: 'N', aggregateRating: { ratingValue: 3.8, ratingCount: 4 } }
  }));
  assert.equal(nested.rating, 3.8);
  assert.equal(nested.reviewCount, 4);
});

check('standalone Review nodes (siblings of Product) are picked up', () => {
  const html = ld({ '@type': 'Product', name: 'P', sku: '1' }) + ld({
    '@type': 'Review',
    reviewBody: 'Runs true to size and the stitching has held up for months.',
    author: { '@type': 'Person', name: 'Jo' },
    reviewRating: { ratingValue: 5 }
  });
  const r = extractOnPageReviews(html);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].author, 'Jo');
});

check('itemprop microdata aggregate when there is no JSON-LD', () => {
  const html = `
    <div itemprop="aggregateRating">
      <meta itemprop="ratingValue" content="4.35">
      <meta itemprop="reviewCount" content="212">
    </div>`;
  const r = extractOnPageReviews(html);
  assert.equal(r.rating, 4.35);
  assert.equal(r.reviewCount, 212);
  assert.equal(r.source, 'microdata');
});

check('widget present but nothing structured → empty result, platform named', () => {
  const r = extractOnPageReviews('<div class="jdgm-widget" data-id="9"></div>');
  assert.equal(r.rating, null);
  assert.deepEqual(r.quotes, []);
  assert.equal(r.platform, 'judge.me');
  assert.equal(buildProductReviews(r), null);
});

// ── rating normalization ───────────────────────────────────────────

check('normalizeStars: 10- and 100-point scales rescale to 5', () => {
  assert.equal(normalizeStars(4.5), 4.5);
  assert.equal(normalizeStars(9.4, 10), 4.7);
  assert.equal(normalizeStars(90, 100), 4.5);
  assert.equal(normalizeStars('4,7'), 4.7);          // EU decimal comma
  assert.equal(normalizeStars('4.6 out of 5'), 4.6);
  assert.equal(normalizeStars(8), 4);                // no bestRating → infer /10
  assert.equal(normalizeStars(null), null);
  assert.equal(normalizeStars('n/a'), null);
});

check('normalizeStars clamps into 0–5 and never returns NaN', () => {
  assert.equal(normalizeStars(7, 5), 5);
  assert.equal(normalizeStars(-2), null);
  assert.equal(normalizeStars(0, 5), 0);
});

check('aggregate rating on a 10-scale is stored as 5-scale', () => {
  const r = extractOnPageReviews(ld({
    '@type': 'Product', name: 'S',
    aggregateRating: { ratingValue: 9.2, bestRating: 10, reviewCount: 40 }
  }));
  assert.equal(r.rating, 4.6);
});

// ── mapReviewNode / rankQuotes edges ───────────────────────────────

check('mapReviewNode: body-less review → null; description used as body', () => {
  assert.equal(mapReviewNode({ type: 'Review', name: 'Title only' }), null);
  const q = mapReviewNode({ type: 'Review', description: 'Great buy, three months in.' });
  assert.equal(q.text, 'Great buy, three months in.');
});

check('mapReviewNode: entity-encoded review body is decoded', () => {
  const q = mapReviewNode({ type: 'Review', reviewBody: 'Fits my 55&quot; TV &amp; looks sharp' });
  assert.equal(q.text, 'Fits my 55" TV & looks sharp');
});

check('mapReviewNode: title identical to body is dropped (no dupe)', () => {
  const q = mapReviewNode({ type: 'Review', name: 'Love it', reviewBody: 'Love it' });
  assert.equal(q.title, null);
});

check('rankQuotes: unrated quotes fall back to substance signals', () => {
  const ranked = rankQuotes([
    { text: 'Nice.' },
    { text: 'Wore these hiking for three months straight and they still look new.' }
  ]);
  assert.match(ranked[0].text, /three months/);
});

check('rankQuotes: link spam sinks', () => {
  const ranked = rankQuotes([
    { text: 'Check out my review at https://spam.example.com for the full breakdown here' },
    { text: 'Solid build quality and it arrived two days early, very happy with it.' }
  ]);
  assert.match(ranked[0].text, /Solid build/);
});

// ── snapshot shape + freshness ─────────────────────────────────────

check('buildProductReviews: preserves an existing Gemini summary', () => {
  const r = extractOnPageReviews(ld(LIVING_SPACES));
  const pr = buildProductReviews(r, { summary: 'Reviewers love the storage.', quotes: [] });
  assert.equal(pr.summary, 'Reviewers love the storage.');
  assert.equal(pr.rating, 4.9);
  assert.equal(pr.reviewCount, 156);
  assert.equal(pr.quotesFound, 3);
  assert.ok(pr.fetchedAt instanceof Date);
});

check('buildProductReviews: aggregate-only page still produces a snapshot', () => {
  const r = extractOnPageReviews(ld({
    '@type': 'Product', name: 'A', aggregateRating: { ratingValue: 4.1, reviewCount: 12 }
  }));
  const pr = buildProductReviews(r);
  assert.equal(pr.rating, 4.1);
  assert.deepEqual(pr.quotes, []);
});

check('isFresh: signal-less snapshot is stale so empty pages get retried', () => {
  const now = new Date();
  assert.equal(isFresh({ rating: 4.5, quotes: [], fetchedAt: now }), true);
  assert.equal(isFresh({ rating: null, quotes: [], fetchedAt: now }), false);
  assert.equal(isFresh({ rating: null, quotes: [{ text: 'x' }], fetchedAt: now }), true);
  assert.equal(isFresh({ rating: 4.5, quotes: [], fetchedAt: new Date(Date.now() - 40 * 86400000) }), false);
  assert.equal(isFresh(null), false);
});

check('reviewsFromProductNode: pure node path matches the HTML path', () => {
  const fromNode = reviewsFromProductNode(LIVING_SPACES, { source: 'store' });
  const fromHtml = extractOnPageReviews(ld(LIVING_SPACES));
  assert.equal(fromNode.rating, fromHtml.rating);
  assert.equal(fromNode.reviewCount, fromHtml.reviewCount);
  assert.equal(fromNode.quotes.length, fromHtml.quotes.length);
  assert.equal(fromNode.quotes[0].text, fromHtml.quotes[0].text);
});

check('garbage in → empty result, never a throw', () => {
  for (const input of [null, undefined, '', '<html></html>', '<script type="application/ld+json">{bad</script>']) {
    const r = extractOnPageReviews(input);
    assert.equal(r.rating, null);
    assert.deepEqual(r.quotes, []);
  }
  assert.equal(reviewsFromProductNode(null).rating, null);
});

// ── summary ────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
