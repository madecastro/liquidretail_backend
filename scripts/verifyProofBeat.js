#!/usr/bin/env node
'use strict';
/**
 * verifyProofBeat — offline guard for the canonical PROOF phase.
 *
 * WHY THIS EXISTS
 * 2026-08-04: the owner reported three separate defects — "not seeing the
 * canonical title on videos", "not seeing customer comments", "what happened to
 * the star reviews and review counts". All three were ONE root cause: the
 * canonical proof beat (quote + reviewer + rating lockup) was rendering empty,
 * so `visibleWhenEmpty:"quote"` handed the beat to a repeated headline and the
 * video no longer read as the new template.
 *
 * Two things had to change, and each is easy to silently undo:
 *
 *   1. A brand's review COUNT may print with NO STARS. Measured in production,
 *      only 4 of 34 brands clear the owner's ">4.5 stars only" rule — GymShark
 *      sits at 3.3 with 41,000 reviews. Suppressing the stars is correct;
 *      suppressing the volume too left the beat empty.
 *   2. That count is only honest next to a BRAND-tier quote. Pairing a brand
 *      count with a product-tier quote is the exact cross-tier mix that once
 *      printed a product's 41,000 reviews beside the brand's 3.3 stars.
 *
 * The second rule is enforced at a distance: buildMetaForAd reads
 * `primary_quote.tier === 'brand'`, and that `tier` has to survive
 * toPrintableCustomerQuote's byline strip. Nothing else pins that, and the strip
 * is deliberately generous about what it deletes — so a future field added to
 * BYLINE_FIELDS could disable the whole count path with no test failing.
 *
 * Offline: no DB, no network, no API key, no browser. Remotion JSX/ESM cannot be
 * required from CJS, so the renderer is covered by source pins — the same
 * approach scripts/verifyRatingMotion.js already uses.
 *
 *   node scripts/verifyProofBeat.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  resolveAtomicRatingPair,
  formatDisplayRating,
} = require('../services/ratingDisplay');
const {
  toPrintableCustomerQuote,
  BYLINE_FIELDS,
} = require('../services/quoteProvenance');
const { gateLayoutInputQuotes } = require('../services/brandScriptExecutor');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const BRAND_LABEL = 'gymshark.com';

// ── R: the atomic rating/count pair ────────────────────────────────────

check('R1 product rating that clears the gate still wins, with its own count', () => {
  const r = resolveAtomicRatingPair({
    productRating: 4.8, productReviewCount: 120,
    brandRating: 3.3, brandReviewCount: 41000, brandAttribution: BRAND_LABEL,
  });
  assert.strictEqual(r.source, 'product');
  assert.strictEqual(r.rating, '4.8');
  assert.strictEqual(r.reviewCount, 120);
});

check('R2 brand rating that clears the gate wins when product fails', () => {
  const r = resolveAtomicRatingPair({
    productRating: 3.9, productReviewCount: 120,
    brandRating: 4.7, brandReviewCount: 8343, brandAttribution: BRAND_LABEL,
  });
  assert.strictEqual(r.source, 'brand');
  assert.strictEqual(r.rating, '4.7');
  assert.strictEqual(r.reviewCount, 8343);
  assert.ok(r.reviewsText.includes(BRAND_LABEL), 'brand count must be attributed');
});

check('R3 DEFAULT OFF — both ratings failing yields no proof at all', () => {
  const r = resolveAtomicRatingPair({
    productRating: 3.9, productReviewCount: 120,
    brandRating: 3.3, brandReviewCount: 41000, brandAttribution: BRAND_LABEL,
  });
  assert.strictEqual(r.source, null, 'omitting the flag must not change behaviour');
  assert.strictEqual(r.rating, null);
  assert.strictEqual(r.reviewCount, null);
  assert.strictEqual(r.reviewsText, null);
});

check('R4 count prints WITHOUT stars when opted in (the GymShark case)', () => {
  const r = resolveAtomicRatingPair({
    productRating: null, productReviewCount: null,
    brandRating: 3.3, brandReviewCount: 41000, brandAttribution: BRAND_LABEL,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(r.source, 'brand-count');
  assert.strictEqual(r.rating, null, 'a 3.3 rating must NEVER print as stars');
  assert.strictEqual(r.reviewCount, 41000);
  assert.strictEqual(r.reviewsText, `41000 reviews · ${BRAND_LABEL}`);
});

check('R5 opting in cannot invent a count that does not exist (AllBirds)', () => {
  const r = resolveAtomicRatingPair({
    productRating: 4.4, productReviewCount: null,
    brandRating: null, brandReviewCount: null, brandAttribution: 'allbirds.com',
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(r.source, null);
  assert.strictEqual(r.reviewsText, null);
});

check('R6 ATOMICITY — a brand count never rides a product rating', () => {
  const r = resolveAtomicRatingPair({
    productRating: 4.8, productReviewCount: null,
    brandRating: 3.3, brandReviewCount: 41000, brandAttribution: BRAND_LABEL,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(r.source, 'product', 'product stars win');
  assert.strictEqual(r.reviewCount, null, 'must NOT borrow the brand 41,000');
  assert.strictEqual(r.reviewsText, null);
});

check('R7 ATOMICITY — the count-only path never borrows the PRODUCT count', () => {
  // The historical bug in reverse: a product count surfacing under a brand
  // decision. brandReviewCount is absent, so there must be no count at all.
  const r = resolveAtomicRatingPair({
    productRating: 3.2, productReviewCount: 41000,
    brandRating: 3.3, brandReviewCount: null, brandAttribution: BRAND_LABEL,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(r.reviewCount, null, 'product 41,000 must not leak into a brand decision');
  assert.strictEqual(r.source, null);
});

check('R8 the rounding trap still withholds stars (4.51/4.55 display as 4.5)', () => {
  for (const raw of [4.51, 4.54, 4.55, 4.5]) {
    assert.strictEqual(formatDisplayRating(raw), undefined, `${raw} must be withheld`);
  }
  assert.strictEqual(formatDisplayRating(4.6), '4.6');
  assert.strictEqual(formatDisplayRating(4.66), '4.7');
  assert.strictEqual(formatDisplayRating(5), '5');
});

check('R9 a suppressed rating with a rounding-trap value still shows its count', () => {
  const r = resolveAtomicRatingPair({
    brandRating: 4.54, brandReviewCount: 8343, brandAttribution: BRAND_LABEL,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(r.source, 'brand-count');
  assert.strictEqual(r.rating, null, '4.54 rounds to 4.5 — stars stay withheld');
  assert.strictEqual(r.reviewCount, 8343);
});

check('R10 count text pluralises and drops attribution when unknown', () => {
  const one = resolveAtomicRatingPair({
    brandRating: 3.3, brandReviewCount: 1, brandAttribution: BRAND_LABEL,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(one.reviewsText, `1 review · ${BRAND_LABEL}`);
  const anon = resolveAtomicRatingPair({
    brandRating: 3.3, brandReviewCount: 12, brandAttribution: null,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(anon.reviewsText, '12 reviews');
});

check('R11 a 0-100 vendor scale never becomes stars, but its count survives', () => {
  const r = resolveAtomicRatingPair({
    brandRating: 87, brandReviewCount: 500, brandAttribution: BRAND_LABEL,
    allowBrandCountWithoutStars: true,
  });
  assert.strictEqual(r.rating, null, '87 must never print as a star value');
  assert.strictEqual(r.source, 'brand-count');
});

// ── T: `tier` must survive the byline strip ────────────────────────────
// buildMetaForAd keys the count-only decision off primary_quote.tier, so the
// strip deleting `tier` would silently disable the whole path.

check('T1 llm-web keeps tier while every byline field is deleted', () => {
  const printable = toPrintableCustomerQuote({
    text: 'These are the comfiest shorts I own.',
    origin: 'llm-web',
    verbatim: false,
    tier: 'brand',
    author_name: 'vertexaisearch.cloud.google.com',
    source: 'Reddit (r/BuyItForLife)',
    verified: true,
  });
  assert.ok(printable, 'grounded llm-web text must remain printable');
  assert.strictEqual(printable.tier, 'brand', 'tier must survive — the count path depends on it');
  for (const f of BYLINE_FIELDS) {
    assert.ok(!(f in printable), `byline field ${f} must be absent, not falsy`);
  }
  assert.ok(!('source' in printable), 'source is a domain, not a person');
  assert.ok(!('verified' in printable), 'an unnamed "verified buyer" is still a persona');
});

check('T2 the video gate reseats the printable quote and preserves tier', () => {
  const gated = gateLayoutInputQuotes({
    input: {
      social_proof: {
        primary_quote: {
          text: 'Held up through two seasons of training.',
          origin: 'llm-web',
          verbatim: false,
          tier: 'brand',
          author_name: 'UBeauty.com',
        },
      },
    },
  });
  const pq = gated.input.social_proof.primary_quote;
  assert.ok(pq, 'quote must be admitted');
  assert.strictEqual(pq.tier, 'brand');
  assert.ok(!('author_name' in pq), 'the gate must hand the cascade a stripped copy');
});

check('T3 an unstamped quote is withheld, so the count path stays shut', () => {
  const gated = gateLayoutInputQuotes({
    input: { social_proof: { primary_quote: { text: 'Great!', tier: 'brand' } } },
  });
  const pq = gated.input.social_proof.primary_quote;
  assert.strictEqual(pq, null, 'unstamped provenance must not print');
  // This is what buildMetaForAd evaluates; it must be false, never throw.
  assert.strictEqual(pq?.tier === 'brand', false);
});

check('T4 a product-tier quote must not enable the brand count', () => {
  const gated = gateLayoutInputQuotes({
    input: {
      social_proof: {
        primary_quote: { text: 'The shoes are very comfortable', origin: 'llm-web', tier: 'product' },
      },
    },
  });
  const pq = gated.input.social_proof.primary_quote;
  assert.strictEqual(pq.tier, 'product');
  assert.strictEqual(pq?.tier === 'brand', false, 'only a brand-tier quote may carry a brand count');
});

// ── C: the count-up parser must not truncate an uncommaed count ────────
// Found by adversarial review, reproduced before fixing. reviewsText is built
// UNCOMMAED by ratingDisplay ("41000 reviews · gymshark.com"), and the old
// pattern `\d{1,3}(?:,\d{3})*|\d+` matched only "410" of "41000" because
// alternation is ordered — so the count rolled 0→410 with a stray "00" beside
// it and mid-animation frames read fabricated totals like "18800 reviews".
// Only the settled frame looked correct, which is why post-settle contact
// sheets never caught it. Mirrors the regex in remotion/lib/ratingMotion.js
// (ESM, not requireable from CJS); C2 pins the source so the two cannot drift.
const COUNT_RE = /^(\d+(?:,\d{3})*)/;
function parseLeading(s) {
  const m = String(s ?? '').match(COUNT_RE);
  if (!m) return null;
  return { target: Number(m[1].replace(/,/g, '')), suffix: String(s).slice(m[0].length) };
}

check('C1 uncommaed and commaed counts both parse whole', () => {
  const cases = [
    ['41000 reviews · gymshark.com', 41000, ' reviews · gymshark.com'],
    ['8343 reviews · x.com',          8343, ' reviews · x.com'],
    ['15,545 reviews',              15545, ' reviews'],
    ['128 reviews',                   128, ' reviews'],
    ['1 review',                        1, ' review'],
    ['1,234,567 reviews',         1234567, ' reviews'],
  ];
  for (const [input, target, suffix] of cases) {
    const got = parseLeading(input);
    assert.ok(got, `${input} must parse`);
    assert.strictEqual(got.target, target, `${input} target`);
    assert.strictEqual(got.suffix, suffix, `${input} suffix must not swallow digits`);
  }
  assert.strictEqual(parseLeading('Trusted by thousands'), null, 'no leading integer → fade, not count');
});

check('C2 the renderer uses the same non-truncating pattern', () => {
  const motionSrc = fs.readFileSync(
    path.join(__dirname, '..', 'remotion', 'lib', 'ratingMotion.js'), 'utf8');
  // Strip comments before matching: the fix is DOCUMENTED by quoting the old
  // broken pattern, so a naive source test fails on its own explanation.
  const code = motionSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(
    /\/\^\(\\d\+\(\?:,\\d\{3\}\)\*\)\//.test(code),
    'ratingMotion must match \\d+ first, then optional comma groups'
  );
  assert.ok(
    !/\\d\{1,3\}\(\?:,\\d\{3\}\)\*\|\\d\+/.test(code),
    'the ordered-alternation pattern truncates uncommaed counts — must not come back'
  );
});

// ── Q: the brand count may only ride the quote that ACTUALLY renders ───

check('Q1 a brand count requires the rendered quote to BE the brand quote', () => {
  // Mirrors the gate in buildMetaForAd. The rendered quote is cascaded.quote,
  // and that cascade puts ad.copy.quote FIRST — so tier alone is not proof
  // that the brand quote is what viewers see.
  const gate = (pq, renderedQuote) => {
    const brandQuoteText = pq?.tier === 'brand' ? String(pq.text || '').trim() : '';
    return !!brandQuoteText && String(renderedQuote || '').trim() === brandQuoteText;
  };
  const brandPq = { tier: 'brand', text: 'Love this brand' };
  assert.strictEqual(gate(brandPq, 'Love this brand'), true, 'brand quote renders → count allowed');
  assert.strictEqual(
    gate(brandPq, 'These leggings are perfect'), false,
    'ad.copy.quote won the cascade → a brand count must NOT ride it'
  );
  assert.strictEqual(gate({ tier: 'product', text: 'x' }, 'x'), false, 'product tier never allows a brand count');
  assert.strictEqual(gate(null, 'anything'), false, 'a withheld quote never allows a brand count');
  assert.strictEqual(gate({ tier: 'brand', text: '' }, ''), false, 'an empty brand quote is not a quote');
});

check('Q2 buildMetaForAd compares against the rendered cascade value', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'brandScriptExecutor.js'), 'utf8');
  assert.ok(
    /renderedQuote\s*===\s*brandQuoteText/.test(src),
    'the gate must compare the brand quote against cascaded.quote, not just read tier'
  );
});

// ── S: renderer source pins (JSX/ESM is not requireable from CJS) ──────

const slotContentSrc = fs.readFileSync(
  path.join(__dirname, '..', 'remotion', 'lib', 'slotContent.js'), 'utf8');
const slotRenderersSrc = fs.readFileSync(
  path.join(__dirname, '..', 'remotion', 'components', 'slotRenderers.jsx'), 'utf8');

check('S1 the rating slot is not emptied when only a count is present', () => {
  // Was: `if (!Number.isFinite(rating) || rating <= 0) return null;` — which
  // made a count-without-stars slot invisible no matter what upstream sent.
  assert.ok(
    /return null;/.test(slotContentSrc) && /!hasRating\s*&&\s*!reviewsText/.test(slotContentSrc),
    'slotContent must only bail when there is NEITHER a rating nor a count'
  );
  assert.ok(
    !/if\s*\(!Number\.isFinite\(rating\)\s*\|\|\s*rating\s*<=\s*0\)\s*return null/.test(slotContentSrc),
    'the old rating-only bail must be gone'
  );
});

check('S2 no rating resolves to null — distinguishable from zero stars', () => {
  assert.ok(
    /rating:\s*hasRating\s*\?/.test(slotContentSrc),
    'rating must be conditional on hasRating so the renderer can tell null from 0'
  );
});

check('S3 the star row is skipped entirely when there is no rating', () => {
  // StarRow computes Math.max(0, Number(rating) || 0), so a null rating would
  // draw FIVE EMPTY STARS — worse than showing nothing for a brand whose
  // rating the owner rule deliberately suppressed.
  const starRowIdx = slotRenderersSrc.indexOf('<StarRow');
  assert.ok(starRowIdx > -1, '<StarRow> must still exist for the rating-present path');
  // Proximity matters. A bare "does the file contain `rating != null ?`" pin
  // stays GREEN when the guard is deleted, because countStartSec uses the same
  // expression ~80 lines earlier — proven by revert-proofing this very check.
  // So require the guard in the window immediately preceding <StarRow>.
  const window = slotRenderersSrc.slice(Math.max(0, starRowIdx - 400), starRowIdx);
  assert.ok(
    /rating\s*!=\s*null\s*\?/.test(window),
    'the star row must be wrapped in a `rating != null ?` guard, not merely mentioned elsewhere'
  );
});

check('S4 the count animation does not wait for stars that never render', () => {
  assert.ok(
    /countStartSec\s*=\s*rating\s*!=\s*null\s*\?\s*lastStarLandSec\(\)\s*:\s*0/.test(slotRenderersSrc),
    'with no stars there is nothing to wait for — start the count at slot enter'
  );
});

check('S5 the proof beat stays Remotion-deterministic', () => {
  // Match CALL syntax, not prose: these files legitimately discuss the ban in
  // comments ("never Date/random/setTimeout"), and a substring test on the bare
  // name fails on the documentation instead of on real non-determinism.
  const CALLS = [/\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bsetTimeout\s*\(/, /\bnew\s+Date\s*\(/];
  for (const [name, src] of [['slotContent.js', slotContentSrc], ['slotRenderers.jsx', slotRenderersSrc]]) {
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const re of CALLS) {
      assert.ok(!re.test(stripped), `${name} must not call ${re.source} — it breaks frame-derived rendering`);
    }
  }
});

// ── A: artifact selection prefers fresh but never discards usable data ──

const executorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'brandScriptExecutor.js'), 'utf8');

check('A1 buildMetaForAd scopes the artifact lookup by productId', () => {
  // Without this, media carrying several products can hand an ad ANOTHER
  // product's copy and quote via the createdAt sort.
  assert.ok(
    /productId:\s*productIdKey/.test(executorSrc) || /productId:\s*ad\.productId\s*\|\|\s*null/.test(executorSrc),
    'the lookup must be scoped to the ad\'s product'
  );
});

check('A2 a stale artifact is DEMOTED, never discarded', () => {
  // Ten meta fields take layoutInput as their FIRST cascade source —
  // including rating and reviewCount themselves, plus deliveryLine, badges,
  // benefits. Filtering stale artifacts out of the query would thin the close
  // phase and delete the very stars this work restores. The unstamped quote is
  // already handled by gateLayoutInputQuotes.
  const scoped = /findOne\(scope\)/.test(executorSrc);
  assert.ok(scoped, 'there must be a fallback lookup without the schemaVersion filter');
  assert.ok(/STALE/.test(executorSrc), 'serving a stale artifact must be logged');
});

// ── B: brand resolution must survive a scraped name that cannot match ──

check('B1 loadContext falls back to the brandId FK when the name lookup fails', () => {
  // Found by live testing, not by any harness: the brand-tier quote fallback
  // could never fire for GymShark because ctx.brand was null. Its catalog media
  // carries metadata.brand = "Gymshark | Be a visionary." (name + site tagline),
  // which normalizeBrandName turns into "gymshark be a visionary" — it can never
  // match the real doc's "gymshark". So brandReviews, styleTheme, logo and
  // tagline all silently vanished. media.brandId was correct all along.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'layoutInputService.js'), 'utf8');
  assert.ok(
    /media\.brandId\s*\|\|\s*match\?\.brandId/.test(src),
    'loadContext must consult the brandId FK'
  );
  // Order matters: the FK is a FALLBACK so every name resolution that works
  // today stays byte-identical. Assert the FK block is guarded by !brand.
  const fkIdx = src.indexOf('media.brandId || match?.brandId');
  const guard = src.lastIndexOf('if (!brand)', fkIdx);
  assert.ok(guard > -1 && fkIdx - guard < 400, 'the FK lookup must be gated on the name lookup having failed');
});

check('B2 the normalizer genuinely cannot bridge a tagline-polluted name', () => {
  // Pins the premise of the fix — if normalizeBrandName ever starts stripping
  // taglines, B1's fallback stops being load-bearing and this check says so.
  const { normalizeBrandName } = require('../models/Brand');
  assert.strictEqual(normalizeBrandName('Gymshark | Be a visionary.'), 'gymshark be a visionary');
  assert.strictEqual(normalizeBrandName('GymShark'), 'gymshark');
  assert.notStrictEqual(
    normalizeBrandName('Gymshark | Be a visionary.'),
    normalizeBrandName('GymShark'),
    'if these ever match, the FK fallback is no longer what rescues this brand'
  );
});

// ── P: every brand projection feeding titling must carry brandReviews ──

check('P1 brand projections that feed titling include brandReviews', () => {
  // The defect this pins SHIPPED and reached the owner: routes/ads.js (the
  // wizard/generation path) and adRegenerateService.loadBrand both .select()
  // an explicit field list, and neither listed brandReviews. buildMetaForAd
  // then saw brand.brandReviews === undefined, so brandPair was null and
  // resolveAtomicRatingPair returned source=none — every generated ad rendered
  // with NO stars and NO review count, including Vuori (4.58 / 15,545) which
  // clears the >4.5 gate outright.
  //
  // A projection omission is invisible: it looks exactly like a brand that has
  // no review data, and it cannot be caught by testing resolveAtomicRatingPair
  // (which was correct all along) or by re-titling through routes/brand.js
  // (which loads the full doc). So assert on the projection strings themselves.
  const targets = [
    ['routes/ads.js', /\.select\('name styleScript[^']*'\)/g],
    ['services/adRegenerateService.js', /\.select\('name styleScript[^']*'\)/g],
  ];
  for (const [rel, re] of targets) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const matches = src.match(re);
    assert.ok(matches && matches.length, `${rel}: expected a brand titling projection`);
    for (const m of matches) {
      assert.ok(
        /\bbrandReviews\b/.test(m),
        `${rel}: a brand projection feeding titling omits brandReviews — ` +
        `the proof beat silently loses stars AND review count: ${m.slice(0, 90)}…`
      );
    }
  }
});

// ── L: logomark ink + badge treatment (owner direction 2026-08-03) ──────

check('L1 logomark ink follows the background luminance', () => {
  const { monochromeInkFor } = require('../services/directImageRenderService');
  // Owner: "the logo should just be rendered in black or white depending on the
  // color of the background. It should be clean and minimal." Light plate →
  // black mark, dark plate → white mark.
  assert.deepStrictEqual(monochromeInkFor(0.9), { r: 0, g: 0, b: 0 }, 'light bg → black mark');
  assert.deepStrictEqual(monochromeInkFor(0.51), { r: 0, g: 0, b: 0 }, 'just-light bg → black mark');
  assert.deepStrictEqual(monochromeInkFor(0.5), { r: 255, g: 255, b: 255 }, 'mid/dark bg → white mark');
  assert.deepStrictEqual(monochromeInkFor(0.05), { r: 255, g: 255, b: 255 }, 'dark bg → white mark');
  // Unknown luminance must NOT guess — the caller keeps the original asset.
  assert.strictEqual(monochromeInkFor(NaN), null);
  assert.strictEqual(monochromeInkFor(undefined), null);
});

check('L2 the badge renders as plain text, not a filled pill', () => {
  // Owner saw the brand-token pill ship as a charcoal box on a light plate
  // ("there is a dark pill") and chose "Plain text, no pill". The Pill component
  // stays in use for CTA/promo, which are meant to read as buttons — so assert
  // specifically that BadgeSlot no longer renders one.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'remotion', 'components', 'slotRenderers.jsx'), 'utf8');
  const start = src.indexOf('export const BadgeSlot');
  assert.ok(start > -1, 'BadgeSlot must exist');
  const body = src.slice(start, src.indexOf('export const', start + 10));
  assert.ok(!/<Pill\b/.test(body), 'BadgeSlot must not render a <Pill> — owner asked for plain text');
  assert.ok(!/badgeBg/.test(body), 'BadgeSlot must not paint the brand badgeBg background');
  assert.ok(/textPrimary/.test(body), 'badge should inherit primary ink so the contrast flip drives it');
});

// ── S2: shadow polarity must follow the ink ─────────────────────────────

check('S2-1 textShadowFor inverts for dark ink', () => {
  // Every shadow in TEXT_SHADOWS is BLACK, which assumed white type on dark
  // footage. The plate-intel flip makes the ink DARK on light plates, and a
  // black shadow behind dark type separates nothing — measured on a delivered
  // Vuori ad where the title vanished into a face. tokens.js is ESM and this
  // harness is CJS, so evaluate the exported helpers from source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'remotion', 'lib', 'tokens.js'), 'utf8');
  const pick = (re) => {
    const m = src.match(re);
    assert.ok(m, `tokens.js must export ${re}`);
    return m[0].replace('export ', '');
  };
  const sandbox = {};
  const code = [
    pick(/export const TEXT_SHADOWS = \{[\s\S]*?\};/),
    pick(/export const TEXT_SHADOWS_ON_LIGHT = \{[\s\S]*?\};/),
    pick(/export function hexLuminance[\s\S]*?\n\}/),
    pick(/export function textShadowFor[\s\S]*?\n\}/),
    'sandbox.textShadowFor = textShadowFor; sandbox.hexLuminance = hexLuminance;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  new Function('sandbox', code)(sandbox);
  const { textShadowFor, hexLuminance } = sandbox;

  assert.ok(textShadowFor('soft', '#16181D').includes('255,255,255'), 'dark ink must get a LIGHT halo');
  assert.ok(textShadowFor('layered', '#000000').includes('255,255,255'), 'black ink must get a LIGHT halo');
  assert.ok(textShadowFor('soft', '#FFFFFF').includes('0,0,0'), 'white ink keeps the dark shadow');
  assert.strictEqual(textShadowFor('none', '#16181D'), 'none', 'none stays none');
  assert.ok(textShadowFor('soft', 'not-a-hex').includes('0,0,0'), 'unparseable ink falls back to previous behaviour');
  assert.strictEqual(hexLuminance('#FFFFFF'), 1);
  assert.strictEqual(hexLuminance('#000000'), 0);
});

check('S2-2 no renderer hardcodes the dark-only shadow table', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'remotion', 'components', 'slotRenderers.jsx'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(
    !/textShadow:\s*TEXT_SHADOWS[.[]/.test(code),
    'every textShadow must route through textShadowFor so the polarity follows the ink'
  );
});

// ── V: video seed is the first catalog image in FEED order ──────────────

check('V1 the video seed no longer prefers the imageRole hero stamp', () => {
  // Owner: "the default video behaviour should be the first three images, not
  // the 'hero' image, especially since we don't know how that is determined."
  // The stamp depended on a materialisation step having run, so the same product
  // could seed differently depending on ingest state.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'), 'utf8');
  const start = src.indexOf('async function expandDeterministicVideo');
  assert.ok(start > -1, 'expandDeterministicVideo must exist');
  const body = src.slice(start);
  assert.ok(
    !/'metadata\.imageRole':\s*'hero'/.test(body),
    'the video expansion must not query the hero stamp — feed order only'
  );
  // The helper must exist, must be reversible, and — the part that matters —
  // its DEFAULT path must not consult the stamp.
  //
  // An earlier version of this check only scanned from expandDeterministicVideo
  // onward and therefore could not see the helper, which is declared above it.
  // It passed with the hero query restored as the helper's own return value.
  // Caught by revert-proofing; assert on the helper's structure instead.
  const hStart = src.indexOf('async function firstCatalogMediaForProduct');
  assert.ok(hStart > -1, 'feed-order helper must exist');
  const hEnd = src.indexOf('\n}', hStart);
  const helper = src.slice(hStart, hEnd);
  assert.ok(/VIDEO_SEED_FEED_ORDER|isVideoSeedFeedOrderEnabled/.test(src), 'the change must have an env kill switch');

  const heroIdx  = helper.indexOf("'metadata.imageRole'");
  const guardIdx = helper.indexOf('if (!isVideoSeedFeedOrderEnabled())');
  if (heroIdx > -1) {
    // A hero query may exist ONLY inside the flag-off restore path.
    assert.ok(guardIdx > -1 && guardIdx < heroIdx,
      'any hero-stamp query must sit behind the !isVideoSeedFeedOrderEnabled() guard');
  }
  // The DEFAULT resolution must read the catalog set in FEED ORDER, and must not
  // consult the hero stamp anywhere outside the flag-off restore path.
  // (This originally asserted on the helper's final `return`. That broke when the
  // subject-dominance guard landed and the last return became `acceptable ||
  // candidates[0]` — the behaviour was still feed-ordered, but the check was
  // anchored to a line rather than to the rule. Assert the rule.)
  const afterGuard = guardIdx > -1 ? helper.slice(helper.indexOf('}', guardIdx)) : helper;
  assert.ok(/sort\(\{\s*createdAt:\s*1\s*\}\)/.test(afterGuard),
    'the default seed resolution must read catalog Media in createdAt (feed) order');
  assert.ok(!/imageRole/.test(afterGuard),
    'the default seed resolution must not reference the hero stamp');
});

// ── K: band choice — faces disqualify, texture breaks ties ──────────────

// Mirror of resolveGroupAnchor's decision (Canonical.jsx is ESM/JSX and cannot be
// required from CJS). K2 pins the source so the two cannot drift apart.
const KEEP_OUT = {
  top:        ['top', 'upperThird', 'center', 'lowerThird'],
  upperThird: ['upperThird', 'center', 'lowerThird'],
  center:     ['center', 'upperThird', 'lowerThird'],
  lowerThird: ['lowerThird', 'center', 'upperThird'],
  bottom:     ['bottom', 'lowerThird', 'center', 'upperThird'],
};
const SWITCH_MARGIN = 0.03;
function chooseBand(authored, bands) {
  const scored = (KEEP_OUT[authored] || [authored]).map((c) => ({ cand: c, ...(bands[c] || { avoid: false, busy: 0 }) }));
  const clear = scored.filter((s) => !s.avoid);
  if (!clear.length) return authored;
  let best = null;
  for (const s of clear) {
    const score = s.busy - (s.cand === authored ? SWITCH_MARGIN : 0);
    if (!best || score < best.score) best = { ...s, score };
  }
  return best.cand;
}

check('K1 a face band can never be chosen while a clear band exists', () => {
  // THE COUNTEREXAMPLE THAT BROKE THE FIRST VERSION, from adversarial review.
  // With a numeric FACE_PENALTY of 1 and busy capped at 1.0, a SMOOTH face on the
  // authored band scored 1 + 0.0 - 0.03 = 0.97 and beat a clear-but-detailed band
  // at 0.99 — so it picked the face. That is exactly the footage the change exists
  // to fix (smooth face, product filling the busy region). Faces are now excluded
  // outright, so no busy value can buy one.
  const got = chooseBand('upperThird', {
    upperThird: { avoid: true,  busy: 0.0 },
    center:     { avoid: false, busy: 0.99 },
    lowerThird: { avoid: false, busy: 0.99 },
  });
  assert.notStrictEqual(got, 'upperThird', 'must leave the face band');
  assert.ok(['center', 'lowerThird'].includes(got));

  // Exhaustive: for every busy value, a face must never win over a clear band.
  for (let b = 0; b <= 1.0001; b += 0.05) {
    const pick = chooseBand('upperThird', {
      upperThird: { avoid: true,  busy: 0 },
      center:     { avoid: false, busy: Math.min(1, b) },
      lowerThird: { avoid: false, busy: Math.min(1, b) },
    });
    assert.notStrictEqual(pick, 'upperThird', `face won against clear busy=${b.toFixed(2)}`);
  }
});

check('K2 the real measured ads land on the band the frames prove is cleanest', () => {
  // Numbers measured off the delivered frames the owner rejected.
  assert.strictEqual(chooseBand('upperThird', {   // Pelagic 9:16 — title was on the face
    upperThird: { avoid: true,  busy: 0.238 },
    center:     { avoid: false, busy: 0.176 },
    lowerThird: { avoid: false, busy: 0.175 },
  }), 'lowerThird');
  assert.strictEqual(chooseBand('lowerThird', {   // GymShark 4:5 — title was on the wordmark
    lowerThird: { avoid: false, busy: 0.199 },
    center:     { avoid: false, busy: 0.199 },
    upperThird: { avoid: false, busy: 0.144 },
  }), 'upperThird');
  assert.strictEqual(chooseBand('lowerThird', {   // Vuori 1:1
    lowerThird: { avoid: false, busy: 0.223 },
    center:     { avoid: false, busy: 0.203 },
    upperThird: { avoid: false, busy: 0.188 },
  }), 'upperThird');
  // Hysteresis: a sub-margin win must NOT move the group.
  assert.strictEqual(chooseBand('lowerThird', {
    lowerThird: { avoid: false, busy: 0.20 },
    center:     { avoid: false, busy: 0.19 },
    upperThird: { avoid: false, busy: 0.18 },
  }), 'lowerThird');
  // Degenerate: every band a face → keep authored (unchanged from the old code).
  assert.strictEqual(chooseBand('lowerThird', {
    lowerThird: { avoid: true, busy: 0.5 },
    center:     { avoid: true, busy: 0.4 },
    upperThird: { avoid: true, busy: 0.3 },
  }), 'lowerThird');
  // No plate data at all → authored, never a crash.
  assert.strictEqual(chooseBand('lowerThird', {}), 'lowerThird');
});

check('K3 the renderer disqualifies faces rather than pricing them', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'remotion', 'compositions', 'Canonical.jsx'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/FACE_DISQUALIFIES/.test(code), 'faces must be excluded, not scored');
  assert.ok(!/FACE_PENALTY/.test(code), 'a numeric face penalty is refutable — busy reaches 1.0');
  assert.ok(/busy/.test(code), 'texture must be consulted for the tiebreak');
});

// ── F: a CSS variable is not a font family ──────────────────────────────

check('F1 normalizeFontFamily rejects CSS plumbing', () => {
  // THE BUG THIS PINS SHIPPED AND CONFUSED THE OWNER FOR A DAY. AllBirds' font
  // scrape stored websiteFontUsage.body = "var(--font-sans)". Nothing filtered it,
  // so the string reached family matching as if it were a typeface, matched
  // nothing, and resolution fell through to the tone rules — the same ad rendered
  // Inter, then Playfair Display, then Poppins. The brand's real fonts (Geograph,
  // Self Modern) were in customFonts the whole time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'fontResolverService.js'), 'utf8');
  const sandbox = {};
  const pick = (re) => { const m = src.match(re); assert.ok(m, `missing ${re}`); return m[0]; };
  // eslint-disable-next-line no-new-func
  new Function('sandbox', [
    'const GENERIC_FAMILIES = new Set(["serif","sans-serif","monospace","cursive","fantasy","system-ui","ui-sans-serif","ui-serif","ui-monospace"]);',
    pick(/function isNonFamilyToken[\s\S]*?\n}/),
    pick(/function normalizeFontFamily[\s\S]*?\n}/),
    'sandbox.n = normalizeFontFamily;',
  ].join('\n'))(sandbox);
  const n = sandbox.n;

  for (const bad of ['var(--font-sans)', 'var(--brand-font, serif)', '--font-sans', 'inherit',
                     'initial', 'unset', 'none', 'normal', 'calc(1px)', 'env(x)', '', '   ']) {
    assert.strictEqual(n(bad), null, `${JSON.stringify(bad)} must not be treated as a family`);
  }
  // Real families still resolve, including past a leading var() in a stack.
  assert.strictEqual(n('Self Modern'), 'Self Modern');
  assert.strictEqual(n('var(--font-sans), Geograph'), 'Geograph');
  assert.strictEqual(n('"Playfair Display", serif'), 'Playfair Display');
  assert.strictEqual(n('sans-serif'), null, 'generic families were already excluded');
});

check('F2 the scraped brand family and both styleTheme spellings are consulted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'fontResolverService.js'), 'utf8');
  // styleTheme stores sansFontFamily/serifFontFamily; the resolver used to read
  // only headingFontFamily/bodyFontFamily, so curated themes governed nothing
  // except quote (which is why AllBirds' Lora never drifted while heading did).
  assert.ok(/sansFontFamily/.test(src), 'must accept the sansFontFamily spelling');
  assert.ok(/serifFontFamily/.test(src), 'must accept the serifFontFamily spelling');
  // brand.fontFamily must participate as a last resort even when not curated,
  // otherwise a real scraped family loses to an unusable higher tier.
  const chain = src.slice(src.indexOf('const sharedFamily'), src.indexOf('const wanted'));
  const curatedOnly = /\(fontIsCurated \? scanned : null\)/.test(chain);
  const bareScanned = /\|\|\s*\n?\s*scanned\b/.test(chain) || /\bscanned \|\|/.test(chain);
  assert.ok(curatedOnly && bareScanned,
    'the curated tier must stay AND an uncurated scanned family must appear as a fallback');

  // ORDER IS THE WHOLE POINT, and asserting mere presence missed a regression.
  // Enabling the sansFontFamily alias made the curated theme outrank the scraped
  // family — and production data says all four brands that set sansFontFamily
  // DISAGREE with their scraped face (AllBirds theme "DM Sans" vs real "Self
  // Modern"). Theme-first would therefore have replaced real brand typefaces with
  // generic Google ones, the opposite of the intent. The brand's own ingested face
  // must come FIRST in the heading/body chains.
  const headingChain = src.slice(src.indexOf('heading: normalizeFontFamily('), src.indexOf('body: normalizeFontFamily('));
  const ownIdx = headingChain.indexOf('ownFace');
  const themeIdx = headingChain.indexOf('themeHeading');
  assert.ok(ownIdx > -1 && themeIdx > -1, 'heading chain must consult both the owned face and the theme');
  assert.ok(ownIdx < themeIdx, 'the brand\'s own ingested face must outrank a generic curated theme family');

  // ...and it may only outrank the theme when a USABLE file exists, which is what
  // makes it the real face rather than a brandfetch guess. matchCustomFont is
  // reused so licence holds still apply.
  assert.ok(/scannedIsOwnedFace\s*=\s*!!\(\s*scannedFamily\s*&&\s*matchCustomFont\(/.test(src),
    'the owned-face tier must be gated on matchCustomFont, so licence holds are respected');
  // Quote must NOT take the owned face — serifFontFamily is a deliberate pairing.
  const quoteChain = src.slice(src.indexOf('quote: normalizeFontFamily('));
  assert.ok(!/ownFace/.test(quoteChain.slice(0, quoteChain.indexOf('\n'))),
    'a sans brand face must not silently replace a curated serif quote voice');
});

// ── A: a product-tier rating names its product ──────────────────────────

check('A1 product-tier review counts carry the product name', () => {
  const { resolveAtomicRatingPair } = require('../services/ratingDisplay');
  // Owner: a product-specific star rating must sit beside a product-specific
  // quote OR name the product — because the neighbouring quote can legitimately
  // be brand-tier via the last-resort fallback.
  const withName = resolveAtomicRatingPair({
    productRating: 4.8, productReviewCount: 200, productAttribution: "Women's Breezer Point",
  });
  assert.strictEqual(withName.source, 'product');
  assert.strictEqual(withName.reviewsText, "200 reviews · Women's Breezer Point");
  // No name available → unchanged from before, never a dangling separator.
  const noName = resolveAtomicRatingPair({ productRating: 4.8, productReviewCount: 200 });
  assert.strictEqual(noName.reviewsText, '200 reviews');
  assert.ok(!/·\s*$/.test(noName.reviewsText));
  // Singular still agrees.
  assert.strictEqual(
    resolveAtomicRatingPair({ productRating: 5, productReviewCount: 1, productAttribution: 'Tee' }).reviewsText,
    '1 review · Tee');
  // The brand tier keeps its own domain attribution.
  assert.strictEqual(
    resolveAtomicRatingPair({ productRating: 3.0, brandRating: 4.58, brandReviewCount: 15545, brandAttribution: 'vuoriclothing.com' }).reviewsText,
    '15545 reviews · vuoriclothing.com');
});

// ── C: pill ink is derived from the pill fill ───────────────────────────

check('C-ink CTA/promo/badge ink is chosen from the fill, not assumed', () => {
  // Owner, on a delivered Gymshark 4:5 whose accent is cream: "it should be
  // visible, not white on white." ctaText defaulted to #FFFFFF and promoText to
  // #16161A regardless of the fill behind them.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'titleSpecService.js'), 'utf8');
  assert.ok(/readableOn\(/.test(src), 'pill ink must go through a contrast-derived helper');
  assert.ok(!/ctaText:\s*themeColor\(theme, 'ctaTextColor'\) \|\| themeColor\(theme, 'ctaText'\) \|\| '#FFFFFF'/.test(src),
    'ctaText must not fall back to a fixed white');
  for (const call of src.match(/readableOn\([^)]*\)/g) || []) {
    assert.ok(/Resolved/.test(call), `readableOn must receive the resolved fill: ${call}`);
  }
  // Behaviour: light fill -> dark ink, dark fill -> white ink, explicit wins.
  const readableOn = (bgHex, explicit) => {
    if (explicit) return explicit;
    const s = String(bgHex || '').replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return '#FFFFFF';
    const lum = (0.2126 * parseInt(s.slice(0, 2), 16) + 0.7152 * parseInt(s.slice(2, 4), 16) + 0.0722 * parseInt(s.slice(4, 6), 16)) / 255;
    return lum > 0.55 ? '#16181D' : '#FFFFFF';
  };
  assert.strictEqual(readableOn('#F1EFE9'), '#16181D', 'cream pill needs dark ink');
  assert.strictEqual(readableOn('#16181D'), '#FFFFFF', 'dark pill needs white ink');
  assert.strictEqual(readableOn('#F1EFE9', '#123456'), '#123456', 'an explicit brand colour wins');
  assert.strictEqual(readableOn('garbage'), '#FFFFFF', 'unparseable falls back safely');
});

// ── S3: the video seed skips a subject-dominant first image ─────────────

check('S3 seed guard preserves feed order but skips subject-dominant images', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'), 'utf8');
  assert.ok(/primarySubjectAreaFraction/.test(src), 'guard must use the already-stored suitability metric');
  assert.ok(/VIDEO_SEED_MAX_SUBJECT_FRACTION/.test(src), 'threshold must be env-tunable');
  assert.ok(/sort\(\{\s*createdAt:\s*1\s*\}\)/.test(src), 'candidates must stay in feed order');

  // Mirror of the selection rule.
  const T = 0.6;
  const pick = (arr) => {
    const f = (m) => (Number.isFinite(m.frac) ? m.frac : null);
    return (arr.find((m) => f(m) == null || f(m) <= T) || arr[0]).id;
  };
  // The real failing case: feed-first is 0.65 -> skip to the next acceptable.
  assert.strictEqual(pick([{ id: 'a', frac: 0.65 }, { id: 'b', frac: 0.42 }]), 'b');
  // Feed-first is fine -> it wins, order preserved.
  assert.strictEqual(pick([{ id: 'a', frac: 0.30 }, { id: 'b', frac: 0.10 }]), 'a');
  // Unmeasured is ACCEPTABLE — missing data must never reorder the feed.
  assert.strictEqual(pick([{ id: 'a', frac: null }, { id: 'b', frac: 0.1 }]), 'a');
  // Every candidate dominant -> keep the first, never block the ad.
  assert.strictEqual(pick([{ id: 'a', frac: 0.9 }, { id: 'b', frac: 0.8 }]), 'a');
  // Exactly at the threshold is acceptable (<=).
  assert.strictEqual(pick([{ id: 'a', frac: 0.6 }, { id: 'b', frac: 0.1 }]), 'a');
});

// ── M: no burned-in CTA on Meta surfaces ────────────────────────────────

check('M1 the canonical family ships no CTA on Meta formats, but keeps it on landscape', () => {
  // Owner: "turn off the CTA for meta surfaces." Meta draws its own CTA button in
  // the surrounding chrome for Reels / Stories / Feed — the app's own preview
  // renders it — so a burned-in pill duplicates it. It was also the element most
  // prone to collision: a cream-accent brand shipped white-on-cream (C-ink).
  //
  // landscape is pmax / YouTube, NOT Meta, and keeps its CTA deliberately.
  //
  // Asserted through validateTitleSpec rather than the raw JSON, because the
  // validator is what the renderer actually consumes and it fills defaults — a
  // raw-file check would pass on a spec whose normalized form re-enables the slot.
  const { loadPresetFile, clearPresetCache } = require('../services/titleSpecService');
  const { validateTitleSpec } = require('../services/titleSpecValidator');
  clearPresetCache();
  const META = new Set(['vertical', 'feed', 'square']);
  const family = ['canonical', 'canonical-awareness', 'canonical-consideration',
                  'canonical-conversion', 'proto-kinetic-center', 'proto-bottom-editorial'];
  let checkedMeta = 0, checkedLandscape = 0;
  for (const name of family) {
    const preset = loadPresetFile(name);
    assert.ok(preset?.byFormat, `${name} must load`);
    for (const [fmt, raw] of Object.entries(preset.byFormat)) {
      const res = validateTitleSpec(raw, { format: fmt });
      assert.ok(res.ok, `${name}/${fmt} must validate: ${res.errors?.[0]}`);
      const cta = res.normalized.slots.find((s) => s.key === 'cta');
      if (!cta) continue;
      if (META.has(fmt)) {
        assert.strictEqual(cta.visible, false,
          `${name}/${fmt}: Meta draws its own CTA — a burned-in one must stay off`);
        checkedMeta += 1;
      } else {
        assert.strictEqual(cta.visible, true,
          `${name}/${fmt}: non-Meta surfaces (pmax/YouTube) still need their own CTA`);
        checkedLandscape += 1;
      }
    }
  }
  assert.ok(checkedMeta >= 18, `expected every Meta format covered, saw ${checkedMeta}`);
  assert.ok(checkedLandscape >= 6, `expected landscape covered, saw ${checkedLandscape}`);
});

// ── report ─────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n❌ verifyProofBeat: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ verifyProofBeat: ${pass}/${pass} checks passed`);
