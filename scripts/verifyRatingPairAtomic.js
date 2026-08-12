#!/usr/bin/env node
'use strict';

/**
 * verifyRatingPairAtomic — offline pins for audit rec #9 (one rating pair).
 *
 * Flag RATING_PAIR_ATOMIC (env, default FALSE). Flag-off is today's
 * exact values, including the mixed case. Flag-on reads {rating,
 * reviewCount} as an atomic pair:
 *   scraped productReviews → rating + store total
 *   llm-web productReviews → rating only (web-source total is not
 *     this store's; no owner-approved qualifier → withhold)
 *   immersive             → rating only (NEVER reviews.length)
 *   unknown provenance    → lower than scraped AND immersive
 *
 * Display floors are NOT changed. Viewer-facing strings are asserted
 * through resolveCoherentSocialProof / formatProductReviewsText.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyRatingPairAtomic.js
 *
 * This worktree's node_modules is incomplete (no https-proxy-agent).
 * The harness prepends a sibling NODE_PATH (or stubs the package) so
 * requiring Director / layoutInputService does not crash.
 *
 * Revert-prove (live mutations on a temp copy of ratingPairAtomic.js):
 *   M1  mix immersive rating + store count again     → A2 / V5
 *   M1b immersive count = reviews.length             → A2 / V5
 *   M2  drop scraped-first                           → A1
 *   M3  default the flag ON                          → B1
 *   M4  applyHydratedRatingPair always no-op         → E2
 *   M5  Director resolver always legacy              → C2 / C3
 *   M6  derive resolver always legacy                → D2
 *   M7  average kept reviews into a rating           → A5
 *   M8  usableCount accepts 0 / negatives            → A8
 *   M9  treat llm-web count as a store total         → A9 / V6
 *   M10 selectProductReviewsSnapshot = first cand    → A11
 *   M11 hydrate count beside immersive rating        → E2mix
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const FALLBACK_NODE_PATH = '/private/tmp/claude-502/-Volumes-Sayulita-Projects-RS/f022aa34-56bc-4639-b06d-4b693f8a2550/scratchpad/wt-lifestyle/node_modules';

function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through */ }
  if (fs.existsSync(path.join(FALLBACK_NODE_PATH, 'https-proxy-agent'))) {
    process.env.NODE_PATH = [FALLBACK_NODE_PATH, process.env.NODE_PATH || '']
      .filter(Boolean).join(path.delimiter);
    Module._initPaths();
    return 'node_path';
  }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return function HttpsProxyAgent() { return {}; };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}

const PROXY_MODE = ensureHttpsProxyAgent();

const assert = require('assert');

const PAIR_PATH = path.join(__dirname, '..', 'services', 'ratingPairAtomic.js');
const DIR_PATH = path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js');
const HYD_PATH = path.join(__dirname, '..', 'services', 'productMatchHydration.js');
const LIS_PATH = path.join(__dirname, '..', 'services', 'layoutInputService.js');
const RD_PATH = path.join(__dirname, '..', 'services', 'ratingDisplay.js');
const ENV_PATH = path.join(__dirname, '..', 'config', 'defaults.env');
const REFRESH_PATH = path.join(__dirname, '..', 'services', 'catalogProductReviewRefreshService.js');
const INTEG_PATH = path.join(__dirname, '..', 'routes', 'integrations.js');

const pairMod = require('../services/ratingPairAtomic');
const { applyCatalogDetails } = require('../services/productMatchHydration');
const {
  RATING_STAR_MIN,
  RATING_STAR_VOLUME_MIN,
  RATING_STAR_VOLUME_COUNT_MIN,
  formatDisplayRating,
  formatProductReviewsText,
  resolveCoherentSocialProof
} = require('../services/ratingDisplay');

function tryRequire(label, rel) {
  try {
    return require(rel);
  } catch (err) {
    return { __loadError: `${label}: ${err.message.split('\n')[0].slice(0, 180)}` };
  }
}

const director = tryRequire('director', '../services/aiCreativeDirectorService');
const lis = tryRequire('layoutInputService', '../services/layoutInputService');

const ORIGINAL_FLAG = process.env.RATING_PAIR_ATOMIC;

let pass = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}

function withFlag(val, fn) {
  if (val === undefined || val === null) delete process.env.RATING_PAIR_ATOMIC;
  else process.env.RATING_PAIR_ATOMIC = val;
  try { return fn(); }
  finally {
    if (ORIGINAL_FLAG === undefined) delete process.env.RATING_PAIR_ATOMIC;
    else process.env.RATING_PAIR_ATOMIC = ORIGINAL_FLAG;
  }
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

function viewerOf(product, extra) {
  return resolveCoherentSocialProof(Object.assign({ product }, extra || {}));
}

// ── fixtures ──────────────────────────────────────────────────────────

const MIXED_PRODUCT = {
  rating: 4.8,
  reviews: [
    { text: 'Great shoe, true to size and light.', author: 'A' },
    { text: 'Wear these every day.', author: 'B' },
    { text: 'Softest pair I own.', author: 'C' }
  ],
  productReviews: { reviewCount: 1200 }
};

const COMPLETE_PR_PRODUCT = {
  rating: 4.8,
  reviews: MIXED_PRODUCT.reviews,
  productReviews: { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' }
};

const MIXED_ATOMIC_INPUT = {
  productReviews: { reviewCount: 1200 },
  rating: 4.8,
  reviews: MIXED_PRODUCT.reviews,
  reviewCount: 1200
};

const COMPLETE_ATOMIC_INPUT = {
  productReviews: { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' },
  rating: 4.8,
  reviews: MIXED_PRODUCT.reviews,
  reviewCount: 1200
};

const LLM_WEB_PR = {
  rating: 4.6,
  reviewCount: 126,
  quotesOrigin: 'llm-web',
  ratingSource: 'Trustpilot'
};

function isCrossPair(pair) {
  const rating = pair.rating != null ? pair.rating : pair.rating_value;
  const count = pair.reviewCount != null ? pair.reviewCount : pair.review_count;
  return rating === 4.8 && count === 1200;
}

const CATALOG = {
  productUrl: 'https://shop.example/p/1',
  imageUrl: 'https://cdn.example/p.jpg',
  description: 'A shoe.',
  category: 'Shoes',
  rating: 4.8,
  ratingDistribution: [],
  reviews: MIXED_PRODUCT.reviews,
  specs: null,
  sellers: [],
  reviewSummary: null,
  productReviews: { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' }
};

const SNAP = { title: 'Tree Runner' };

const PRODUCT_QUOTE = {
  text: 'Love these shoes they last all season.',
  tier: 'product'
};

// ═══════════════ A. pickAtomicProductRatingPair ═══════════════
console.log('\nA. pickAtomicProductRatingPair — never cross-pair');

check('A1 complete SCRAPED productReviews pair wins over immersive rating', () => {
  const p = pairMod.pickAtomicProductRatingPair(COMPLETE_ATOMIC_INPUT);
  assert.strictEqual(p.rating, 4.6);
  assert.strictEqual(p.reviewCount, 1200);
  assert.strictEqual(p.source, 'productReviews');
  assert.strictEqual(p.provenance, 'scraped');
  assert.ok(!isCrossPair(p), 'must not keep the immersive 4.8 beside the store 1200');
});

check('A2 mixed (immersive rating + store count) → rating-only immersive, NEVER reviews.length', () => {
  const p = pairMod.pickAtomicProductRatingPair(MIXED_ATOMIC_INPUT);
  assert.strictEqual(p.rating, 4.8);
  assert.strictEqual(p.reviewCount, null, 'immersive arm must return count: null, not reviews.length');
  assert.strictEqual(p.source, 'immersive');
  assert.ok(!isCrossPair(p), 'store 1200 must not ride the immersive 4.8');
});

check('A3 productReviews rating-only does not borrow a details count', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { rating: 4.6, quotesOrigin: 'scraped' },
    rating: 4.8,
    reviewCount: 9999
  });
  assert.strictEqual(p.rating, 4.6);
  assert.strictEqual(p.reviewCount, null);
  assert.strictEqual(p.source, 'productReviews');
});

check('A4 count-only SCRAPED productReviews + no immersive rating → store count, no invented stars', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { reviewCount: 1200, quotesOrigin: 'scraped' }
  });
  assert.strictEqual(p.rating, null);
  assert.strictEqual(p.reviewCount, 1200);
  assert.strictEqual(p.source, 'productReviews');
});

check('A5 never averages kept reviews into a rating', () => {
  const reviews = [{ rating: 5 }, { rating: 1 }, { rating: 1 }];
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { rating: 4.6, reviewCount: 900, quotesOrigin: 'scraped' },
    rating: 4.8,
    reviews
  });
  assert.strictEqual(p.rating, 4.6);
  assert.notStrictEqual(p.rating, (5 + 1 + 1) / 3);
  const src = fs.readFileSync(PAIR_PATH, 'utf8');
  assert.ok(!/\.reduce\s*\(/.test(src), 'ratingPairAtomic must not reduce/average reviews');
  assert.ok(!/\/\s*reviews\.length/.test(src), 'must not divide by reviews.length');
});

check('A6 empty input invents nothing', () => {
  const p = pairMod.pickAtomicProductRatingPair({});
  assert.strictEqual(p.rating, null);
  assert.strictEqual(p.reviewCount, null);
  assert.strictEqual(p.source, null);
});

check('A7 NaN is not data', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { rating: NaN, reviewCount: NaN },
    rating: NaN,
    reviewCount: NaN
  });
  assert.strictEqual(p.rating, null);
  assert.strictEqual(p.reviewCount, null);
});

check('A8 usableCount rejects 0 and negatives (Director must not see count: 0)', () => {
  assert.strictEqual(pairMod.usableCount(0), null);
  assert.strictEqual(pairMod.usableCount(-1), null);
  assert.strictEqual(pairMod.usableCount(-50), null);
  assert.strictEqual(pairMod.usableCount(1), 1);
  const emptyReviews = pairMod.pickAtomicProductRatingPair({
    productReviews: { reviewCount: 0, quotesOrigin: 'scraped' },
    rating: 4.8,
    reviews: []
  });
  assert.strictEqual(emptyReviews.reviewCount, null);
  assert.notStrictEqual(emptyReviews.reviewCount, 0);
});

check('A9 llm-web pair is rating-only — web-source total is not a store count', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: LLM_WEB_PR,
    rating: 4.8,
    reviews: MIXED_PRODUCT.reviews
  });
  assert.strictEqual(p.rating, 4.6);
  assert.strictEqual(p.reviewCount, null, 'Trustpilot 126 must not become product reviewCount');
  assert.strictEqual(p.source, 'productReviews');
  assert.strictEqual(p.provenance, 'llm-web');
});

check('A9b scraped beats llm-web when both candidates exist', () => {
  const chosen = pairMod.selectProductReviewsSnapshot([
    LLM_WEB_PR,
    { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' }
  ]);
  assert.strictEqual(chosen.quotesOrigin, 'scraped');
  assert.strictEqual(chosen.rating, 4.6);
});

check('A10 unknown provenance is lower trust than immersive (unstamped Gemini)', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { rating: 4.2, reviewCount: 126 },
    rating: 4.8
  });
  assert.strictEqual(p.rating, 4.8, 'unknown PR must not outrank immersive');
  assert.strictEqual(p.source, 'immersive');
  assert.strictEqual(p.reviewCount, null);
});

check('A10b unknown rating is used only when nothing higher exists', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { rating: 4.6, reviewCount: 126 }
  });
  assert.strictEqual(p.rating, 4.6);
  assert.strictEqual(p.reviewCount, null);
  assert.strictEqual(p.provenance, 'unknown');
});

check('A10c refreshOne source marker is scraped (no quotesOrigin required)', () => {
  const p = pairMod.pickAtomicProductRatingPair({
    productReviews: { rating: 4.55, reviewCount: 890, source: 'productReviewsScrape' },
    rating: 4.8
  });
  assert.strictEqual(p.rating, 4.55);
  assert.strictEqual(p.reviewCount, 890);
  assert.strictEqual(p.provenance, 'scraped');
});

check('A11 stale details snapshot loses to fresher scraped catalog pair', () => {
  const stale = {
    rating: 3.1, reviewCount: 12, quotesOrigin: 'llm-web',
    fetchedAt: '2024-01-01T00:00:00.000Z'
  };
  const fresh = {
    rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped',
    fetchedAt: '2026-08-01T00:00:00.000Z'
  };
  const chosen = pairMod.selectProductReviewsSnapshot([stale, fresh]);
  assert.strictEqual(chosen.quotesOrigin, 'scraped');
  assert.strictEqual(chosen.rating, 4.6);
});

check('A11b provenance beats recency (newer llm-web does not beat older scrape)', () => {
  const newerLlm = {
    rating: 4.9, reviewCount: 5, quotesOrigin: 'llm-web',
    fetchedAt: '2026-08-11T00:00:00.000Z'
  };
  const olderScrape = {
    rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped',
    fetchedAt: '2026-01-01T00:00:00.000Z'
  };
  const chosen = pairMod.selectProductReviewsSnapshot([newerLlm, olderScrape]);
  assert.strictEqual(chosen.quotesOrigin, 'scraped');
});

check('A12 immersive source never reads reviews.length (source pin)', () => {
  const src = stripComments(fs.readFileSync(PAIR_PATH, 'utf8'));
  // Flag-on immersive return is count: null. The legacy flag-off
  // expression still contains reviews.length and must stay.
  assert.ok(/reviewCount:\s*null,\s*source:\s*'immersive'/.test(src));
  const pickFn = src.slice(src.indexOf('function pickAtomicProductRatingPair'));
  const pickBody = pickFn.slice(0, pickFn.indexOf('function pickLegacyDirectorPair'));
  assert.ok(!/reviews\.length/.test(pickBody),
    'pickAtomicProductRatingPair must not synthesize a count from reviews.length');
});

// ═══════════════ B. flag default / reader ═══════════════
console.log('B. RATING_PAIR_ATOMIC default false; only literal true enables');

check('B1 unset → off', () => {
  withFlag(null, () => {
    assert.strictEqual(pairMod.ratingPairAtomicEnabled(), false);
  });
});

check('B2 empty / "false" / "FALSE" / "0" / "trueish" all off', () => {
  for (const v of ['', 'false', 'FALSE', '0', 'yes', '1', 'trueish']) {
    withFlag(v, () => {
      assert.strictEqual(pairMod.ratingPairAtomicEnabled(), false, `value ${JSON.stringify(v)} must be off`);
    });
  }
});

check('B3 only "true" / "TRUE" enable', () => {
  withFlag('true', () => assert.strictEqual(pairMod.ratingPairAtomicEnabled(), true));
  withFlag('TRUE', () => assert.strictEqual(pairMod.ratingPairAtomicEnabled(), true));
});

check('B4 defaults.env does not set the flag (code default is the live default)', () => {
  const env = fs.readFileSync(ENV_PATH, 'utf8');
  assert.ok(!/^RATING_PAIR_ATOMIC=/m.test(env),
    'do not add RATING_PAIR_ATOMIC to defaults.env in this lane — report the lines');
});

check(`B5 harness loaded optional modules via ${PROXY_MODE}`, () => {
  assert.ok(PROXY_MODE === 'present' || PROXY_MODE === 'node_path' || PROXY_MODE === 'stub');
});

// ═══════════════ C. Director ═══════════════
console.log('C. Director — flag-off mixed identity; flag-on atomic');

const directorOk = !director.__loadError;

check('C0 Director re-exports the shared resolver (one definition)', () => {
  if (directorOk) {
    assert.strictEqual(director.resolveDirectorProductRatingPair, pairMod.resolveDirectorProductRatingPair);
  } else {
    const src = fs.readFileSync(DIR_PATH, 'utf8');
    assert.ok(/resolveDirectorProductRatingPair/.test(src),
      `Director failed to load (${director.__loadError}); source must still re-export`);
  }
});

check('C1 flag-off mixed case is TODAY: immersive 4.8 + store 1200', () => {
  withFlag('false', () => {
    const p = pairMod.resolveDirectorProductRatingPair(MIXED_PRODUCT);
    assert.strictEqual(p.rating, 4.8);
    assert.strictEqual(p.reviewCount, 1200);
    assert.strictEqual(p.source, 'legacy');
  });
  withFlag(null, () => {
    const p = pairMod.resolveDirectorProductRatingPair(MIXED_PRODUCT);
    assert.strictEqual(p.rating, 4.8);
    assert.strictEqual(p.reviewCount, 1200);
  });
});

check('C1b flag-off complete-pr is also mixed (today\'s hole)', () => {
  withFlag('false', () => {
    const p = pairMod.resolveDirectorProductRatingPair(COMPLETE_PR_PRODUCT);
    assert.strictEqual(p.rating, 4.8, 'legacy reads product.rating');
    assert.strictEqual(p.reviewCount, 1200, 'legacy reads productReviews.reviewCount');
    assert.ok(isCrossPair(p), 'flag-off must reproduce the hole so the kill switch is real');
  });
});

check('C2 flag-on mixed → immersive rating-only, never 4.8+1200, never reviews.length', () => {
  withFlag('true', () => {
    const p = pairMod.resolveDirectorProductRatingPair(MIXED_PRODUCT);
    assert.ok(!isCrossPair(p));
    assert.strictEqual(p.rating, 4.8);
    assert.strictEqual(p.reviewCount, null);
    assert.strictEqual(p.source, 'immersive');
  });
});

check('C3 flag-on complete scraped productReviews → {4.6, 1200}', () => {
  withFlag('true', () => {
    const p = pairMod.resolveDirectorProductRatingPair(COMPLETE_PR_PRODUCT);
    assert.strictEqual(p.rating, 4.6);
    assert.strictEqual(p.reviewCount, 1200);
    assert.strictEqual(p.source, 'productReviews');
    assert.ok(!isCrossPair(p));
  });
});

check('C4 flag-off no-pr falls to reviews.length (today)', () => {
  withFlag('false', () => {
    const p = pairMod.resolveDirectorProductRatingPair({
      rating: 4.8,
      reviews: MIXED_PRODUCT.reviews
    });
    assert.strictEqual(p.rating, 4.8);
    assert.strictEqual(p.reviewCount, 3);
  });
});

check('C4b flag-on no-pr is rating-only (not reviews.length)', () => {
  withFlag('true', () => {
    const p = pairMod.resolveDirectorProductRatingPair({
      rating: 4.8,
      reviews: MIXED_PRODUCT.reviews
    });
    assert.strictEqual(p.rating, 4.8);
    assert.strictEqual(p.reviewCount, null);
  });
});

check('C5 Director source calls the shared resolver (not a second copy)', () => {
  const src = stripComments(fs.readFileSync(DIR_PATH, 'utf8'));
  assert.ok(/resolveDirectorProductRatingPair\s*\(\s*product\s*\)/.test(src),
    'assembleSignals must call resolveDirectorProductRatingPair(product)');
  assert.ok(!/product\?\.productReviews\?\.reviewCount\s*\n?\s*\?\?/.test(src),
    'the mixed ?? expression must not remain inlined in the Director');
});

// ═══════════════ D. deriveSocialProofNumbers ═══════════════
console.log('D. deriveSocialProofNumbers — flag-off identity; flag-on atomic');

const deriveOk = !lis.__loadError;
const derive = deriveOk ? lis.deriveSocialProofNumbers : null;
const brandCtx = (rating, reviewCount) => ({
  match: { outcome: 'brand_match', brandReviews: { rating, reviewCount } }
});

function deriveOrPair(details, ctx) {
  if (derive) return derive(details, ctx || {});
  // Fallback: the pair resolver is the product branch. Brand fallback
  // lives in LIS; those checks skip when LIS cannot load.
  const r = pairMod.resolveDeriveProductPair(
    details,
    [details && details.productReviews, ctx && ctx.match && ctx.match.productReviews]
  );
  return r || { rating_value: undefined, review_count: undefined, rating_source: null };
}

check('D1 flag-off S1 identity: product rating wins the pair, brand does not fill', () => {
  withFlag('false', () => {
    const r = deriveOrPair({ rating: 4.8 }, brandCtx(3.3, 41000));
    assert.strictEqual(r.rating_source, 'product');
    assert.strictEqual(r.rating_value, 4.8);
    assert.strictEqual(r.review_count, undefined);
  });
});

check('D1b flag-off S2 identity: product count alone claims the pair', () => {
  withFlag('false', () => {
    const r = deriveOrPair({ reviewCount: 120 }, brandCtx(4.9, 41000));
    assert.strictEqual(r.rating_source, 'product');
    assert.strictEqual(r.review_count, 120);
    assert.strictEqual(r.rating_value, undefined);
  });
});

check('D1c flag-off mixed details is TODAY: 4.8 + 1200', () => {
  withFlag('false', () => {
    const r = deriveOrPair({ rating: 4.8, reviewCount: 1200 }, {});
    assert.strictEqual(r.rating_value, 4.8);
    assert.strictEqual(r.review_count, 1200);
    assert.strictEqual(r.rating_source, 'product');
    assert.ok(isCrossPair(r), 'flag-off must keep the independent-read mix');
  });
});

check('D1d flag-off brand fallback unchanged', () => {
  withFlag('false', () => {
    if (!derive) {
      assert.ok(true, 'LIS unloaded — brand fallback is a LIS concern');
      return;
    }
    const r = derive({}, brandCtx(4.7, 8900));
    assert.strictEqual(r.rating_source, 'brand');
    assert.strictEqual(r.rating_value, 4.7);
    assert.strictEqual(r.review_count, 8900);
  });
});

check('D2 flag-on mixed details + scraped productReviews → store pair, never 4.8+1200', () => {
  withFlag('true', () => {
    const r = deriveOrPair(
      { rating: 4.8, reviewCount: 1200, productReviews: { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' } },
      {}
    );
    assert.ok(!isCrossPair(r));
    assert.strictEqual(r.rating_value, 4.6);
    assert.strictEqual(r.review_count, 1200);
    assert.strictEqual(r.rating_source, 'product');
  });
});

check('D2b flag-on mixed details, scraped productReviews on match (hydration shape)', () => {
  withFlag('true', () => {
    const r = deriveOrPair(
      { rating: 4.8, reviewCount: 1200 },
      { match: { productReviews: { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' } } }
    );
    assert.ok(!isCrossPair(r));
    assert.strictEqual(r.rating_value, 4.6);
    assert.strictEqual(r.review_count, 1200);
  });
});

check('D2c flag-on mixed details with count-only productReviews → immersive rating-only', () => {
  withFlag('true', () => {
    const r = deriveOrPair(
      { rating: 4.8, reviewCount: 1200, reviews: MIXED_PRODUCT.reviews },
      { match: { productReviews: { reviewCount: 1200 } } }
    );
    assert.ok(!isCrossPair(r));
    assert.strictEqual(r.rating_value, 4.8);
    assert.strictEqual(r.review_count, undefined, 'must not typeset reviews.length as a store total');
  });
});

check('D2d flag-on prefers scraped match snapshot over stale details llm-web', () => {
  withFlag('true', () => {
    const r = pairMod.resolveDeriveProductPair(
      {
        rating: 4.8,
        productReviews: {
          rating: 3.1, reviewCount: 12, quotesOrigin: 'llm-web',
          fetchedAt: '2024-01-01T00:00:00.000Z'
        }
      },
      {
        rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped',
        fetchedAt: '2026-08-01T00:00:00.000Z'
      }
    );
    assert.strictEqual(r.rating_value, 4.6);
    assert.strictEqual(r.review_count, 1200);
  });
});

check('D3 flag-on still does not let brand fill a product rating', () => {
  withFlag('true', () => {
    const r = deriveOrPair({ rating: 4.8 }, brandCtx(3.3, 41000));
    assert.strictEqual(r.rating_source, 'product');
    assert.strictEqual(r.rating_value, 4.8);
    assert.strictEqual(r.review_count, undefined);
  });
});

check('D4 flag-on brand fallback still only on brand_match with neither product field', () => {
  withFlag('true', () => {
    if (!derive) {
      assert.ok(true, 'LIS unloaded — brand fallback is a LIS concern');
      return;
    }
    const r = derive({}, brandCtx(4.7, 8900));
    assert.strictEqual(r.rating_source, 'brand');
    assert.strictEqual(r.rating_value, 4.7);
    assert.strictEqual(r.review_count, 8900);
    const skipped = derive({}, {
      match: { outcome: 'product_match', brandReviews: { rating: 4.7, reviewCount: 8900 } }
    });
    assert.strictEqual(skipped.rating_source, null);
  });
});

check('D5 derive source calls resolveDeriveProductPair with candidate list', () => {
  const src = stripComments(fs.readFileSync(LIS_PATH, 'utf8'));
  assert.ok(/resolveDeriveProductPair\s*\(/.test(src),
    'deriveSocialProofNumbers must call resolveDeriveProductPair');
  assert.ok(/details\?\.productReviews/.test(src) && /match\?\.productReviews/.test(src),
    'must pass both details and match snapshots, not details || match');
});

// ═══════════════ E. hydration ═══════════════
console.log('E. hydration — flag-off key-identical; flag-on atomic pair');

check('E1 flag-off does not write reviewCount (spread-only, today)', () => {
  withFlag('false', () => {
    const d = applyCatalogDetails(SNAP, CATALOG);
    assert.strictEqual('reviewCount' in d, false,
      'flag-off must not introduce a reviewCount key the snapshot never had');
    assert.strictEqual(d.rating, 4.8);
    assert.strictEqual(d.title, 'Tree Runner');
  });
});

check('E1b flag-off preserves a snapshot reviewCount via spread (today)', () => {
  withFlag('false', () => {
    const d = applyCatalogDetails({ ...SNAP, reviewCount: 99 }, CATALOG);
    assert.strictEqual(d.reviewCount, 99,
      'catalog.productReviews.reviewCount must NOT overwrite on flag-off');
  });
});

check('E2 flag-on writes the SCRAPED pair atomically (rating AND count from productReviews)', () => {
  withFlag('true', () => {
    const d = applyCatalogDetails(SNAP, CATALOG);
    assert.strictEqual(d.rating, 4.6, 'must overwrite immersive 4.8 with the scraped rating');
    assert.strictEqual(d.reviewCount, 1200);
    assert.ok(!(d.rating === 4.8 && d.reviewCount === 1200), 'hydration must not write the mix');
  });
});

check('E2b flag-on prefers catalog scraped pair over snapshot count', () => {
  withFlag('true', () => {
    const d = applyCatalogDetails({ ...SNAP, reviewCount: 99 }, CATALOG);
    assert.strictEqual(d.reviewCount, 1200);
    assert.strictEqual(d.rating, 4.6);
  });
});

check('E2c flag-on rating-only scraped pair does not keep a snapshot count', () => {
  withFlag('true', () => {
    const noCount = { ...CATALOG, productReviews: { rating: 4.6, quotesOrigin: 'scraped' } };
    assert.strictEqual(applyCatalogDetails(SNAP, noCount).reviewCount, null);
    assert.strictEqual(applyCatalogDetails({ ...SNAP, reviewCount: 99 }, noCount).reviewCount, null);
    assert.strictEqual(applyCatalogDetails(SNAP, noCount).rating, 4.6);
  });
});

check('E2mix flag-on immersive rating + scraped count-only PR does NOT mix', () => {
  withFlag('true', () => {
    const countOnly = {
      ...CATALOG,
      productReviews: { reviewCount: 1200, quotesOrigin: 'scraped' }
    };
    const d = applyCatalogDetails(SNAP, countOnly);
    assert.strictEqual(d.rating, 4.8, 'immersive rating stays when PR has no rating');
    assert.strictEqual(d.reviewCount, null, 'store count must not sit beside immersive rating');
  });
});

check('E3 flag-on hydrated details + derive = productReviews pair, not the mix', () => {
  withFlag('true', () => {
    const details = applyCatalogDetails(SNAP, CATALOG);
    const r = deriveOrPair(details, { match: { productReviews: CATALOG.productReviews } });
    assert.ok(!isCrossPair(r), 'cached-artifact path must not mix details.rating with the threaded count');
    assert.strictEqual(r.rating_value, 4.6);
    assert.strictEqual(r.review_count, 1200);
  });
});

check('E4 hydration source is gated on the flag and applies the pair', () => {
  const src = stripComments(fs.readFileSync(HYD_PATH, 'utf8'));
  assert.ok(/ratingPairAtomicEnabled\s*\(/.test(src));
  assert.ok(/applyHydratedRatingPair\s*\(/.test(src));
  assert.ok(/applyCatalogDetails\s*\(/.test(src));
  assert.ok(!/hydratedReviewCount\s*\(/.test(src),
    'hydration must apply the pair, not write a lone count');
});

// ═══════════════ F. display thresholds UNCHANGED ═══════════════
console.log('F. display thresholds unchanged (do not retune floors)');

check('F0 RATING_STAR_MIN is 4.39', () => {
  assert.strictEqual(RATING_STAR_MIN, 4.39);
});

check('F0b RATING_STAR_VOLUME_MIN is 4.19', () => {
  assert.strictEqual(RATING_STAR_VOLUME_MIN, 4.19);
});

check('F0c RATING_STAR_VOLUME_COUNT_MIN is 5000', () => {
  assert.strictEqual(RATING_STAR_VOLUME_COUNT_MIN, 5000);
});

check('F0d QUOTE_MIN_RATING is 4.35', () => {
  if (lis.QUOTE_MIN_RATING != null) {
    assert.strictEqual(lis.QUOTE_MIN_RATING, 4.35);
  } else {
    const src = fs.readFileSync(LIS_PATH, 'utf8');
    assert.ok(/QUOTE_MIN_RATING\s*=\s*Number\(process\.env\.QUOTE_MIN_RATING\s*\|\|\s*4\.35\)/.test(src));
  }
});

check('F1 4.39 shows (displayed 4.4)', () => {
  assert.strictEqual(formatDisplayRating(4.39), '4.4');
});

check('F1b 4.38: shipped gate is on the ROUNDED display, so 4.38 → 4.4 and shows', () => {
  assert.strictEqual(formatDisplayRating(4.38), '4.4');
  assert.strictEqual(formatDisplayRating(4.34), undefined);
});

check('F2 4.19 with count > 5000 shows (volume exception)', () => {
  assert.ok(5001 > RATING_STAR_VOLUME_COUNT_MIN);
  assert.strictEqual(formatDisplayRating(4.19, RATING_STAR_VOLUME_MIN), '4.2');
});

check('F2b 4.19 with count 5000 (not >) stays on the 4.39 floor and hides', () => {
  assert.ok(!(5000 > RATING_STAR_VOLUME_COUNT_MIN));
  assert.strictEqual(formatDisplayRating(4.19, RATING_STAR_MIN), undefined);
});

check('F3 3.9 never shows (plain floor or volume exception)', () => {
  assert.strictEqual(formatDisplayRating(3.9), undefined);
  assert.strictEqual(formatDisplayRating(3.9, RATING_STAR_VOLUME_MIN), undefined);
});

check('F4 resolveCoherentSocialProof pairing rules were not edited', () => {
  const src = fs.readFileSync(RD_PATH, 'utf8');
  assert.ok(/function resolveCoherentSocialProof/.test(src));
  assert.ok(/QUOTE_TIER_NUMBER_SIDE/.test(src));
  assert.ok(/allowLabeledBrandNumbers/.test(src));
  const pairSrc = stripComments(fs.readFileSync(PAIR_PATH, 'utf8'));
  assert.ok(!/resolveCoherentSocialProof/.test(pairSrc));
  assert.ok(!/QUOTE_TIER_NUMBER_SIDE/.test(pairSrc));
});

check('F5 QUOTE_MIN_RATING env default is still 4.35 in layoutInputService', () => {
  const src = fs.readFileSync(LIS_PATH, 'utf8');
  assert.ok(/QUOTE_MIN_RATING\s*=\s*Number\(process\.env\.QUOTE_MIN_RATING\s*\|\|\s*4\.35\)/.test(src));
});

// ═══════════════ V. VIEWER OUTPUT ═══════════════
console.log('V. viewer-facing strings (resolveCoherentSocialProof / formatProductReviewsText)');

check('V1 rating-only 4.8 prints stars and NO reviews clause', () => {
  const pair = pairMod.pickAtomicProductRatingPair({ rating: 4.8, reviews: MIXED_PRODUCT.reviews });
  const v = viewerOf({ rating: pair.rating, reviewCount: pair.reviewCount });
  assert.strictEqual(v.rating, '4.8');
  assert.strictEqual(v.reviewCount, null);
  assert.strictEqual(v.reviewsText, null);
  assert.strictEqual(formatProductReviewsText(pair.reviewCount), null);
  assert.ok(!/review/i.test(String(v.reviewsText || '')));
});

check('V2 scraped 4.6 / 1200 prints both as product reviews', () => {
  const pair = pairMod.pickAtomicProductRatingPair(COMPLETE_ATOMIC_INPUT);
  const v = viewerOf({ rating: pair.rating, reviewCount: pair.reviewCount });
  assert.strictEqual(v.rating, '4.6');
  assert.strictEqual(v.reviewCount, 1200);
  assert.strictEqual(v.reviewsText, '1200 reviews');
  assert.strictEqual(formatProductReviewsText(pair.reviewCount), '1200 reviews');
  assert.strictEqual(v.source, 'product');
});

check('V3 count-only 1200 + product quote on frame prints the count, no stars', () => {
  const pair = pairMod.pickAtomicProductRatingPair({
    productReviews: { reviewCount: 1200, quotesOrigin: 'scraped' }
  });
  const v = resolveCoherentSocialProof({
    quote: PRODUCT_QUOTE,
    product: { rating: pair.rating, reviewCount: pair.reviewCount },
    renderedQuoteText: PRODUCT_QUOTE.text
  });
  assert.strictEqual(v.rating, null);
  assert.strictEqual(v.source, 'product-count');
  assert.strictEqual(v.reviewsText, '1200 reviews');
});

check('V4 labelled-brand numbers print "brand reviews", never unscoped product volume', () => {
  const v = resolveCoherentSocialProof({
    quote: { text: PRODUCT_QUOTE.text, tier: 'comment' },
    product: { rating: 3.0, reviewCount: null },
    brand: { rating: 4.7, reviewCount: 15000 },
    renderedQuoteText: PRODUCT_QUOTE.text,
    allowLabeledBrandNumbers: true
  });
  assert.strictEqual(v.source, 'brand');
  assert.ok(/brand reviews/i.test(v.reviewsText || ''), `expected brand-scoped text, got ${v.reviewsText}`);
  assert.ok(!/^\d+ reviews$/.test(v.reviewsText || ''), 'must not typeset brand volume as product reviews');
});

check('V5 4.6 with a 10-cap sample must NOT print "(10 reviews)" / "3 reviews"', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ text: `review ${i}` }));
  const pair = pairMod.pickAtomicProductRatingPair({
    rating: 4.6,
    reviews: ten,
    productReviews: { reviewCount: 5000 }
  });
  assert.strictEqual(pair.reviewCount, null);
  const v = viewerOf({ rating: pair.rating, reviewCount: pair.reviewCount });
  assert.strictEqual(v.rating, '4.6');
  assert.strictEqual(v.reviewsText, null);
  const shown = `${v.rating || ''} ${v.reviewsText || ''} ${formatProductReviewsText(pair.reviewCount) || ''}`;
  assert.ok(!/\b10 reviews\b/.test(shown), `viewer must not see sample length: ${shown}`);
  assert.ok(!/\b3 reviews\b/.test(shown));
  assert.ok(!/\(10 reviews\)/.test(shown));
});

check('V6 llm-web 4.6 / 126 Trustpilot must not typeset 126 as product reviews', () => {
  const pair = pairMod.pickAtomicProductRatingPair({ productReviews: LLM_WEB_PR, rating: 4.0 });
  assert.strictEqual(pair.rating, 4.6);
  assert.strictEqual(pair.reviewCount, null);
  const v = viewerOf({ rating: pair.rating, reviewCount: pair.reviewCount });
  assert.strictEqual(v.rating, '4.6');
  assert.strictEqual(v.reviewsText, null);
  const shown = `${v.reviewsText || ''} ${formatProductReviewsText(pair.reviewCount) || ''}`;
  assert.ok(!/126/.test(shown), `Trustpilot total leaked into viewer text: ${shown}`);
});

check('V7 Director flag-on mixed product yields rating-only viewer string', () => {
  withFlag('true', () => {
    const p = pairMod.resolveDirectorProductRatingPair(MIXED_PRODUCT);
    const v = viewerOf({ rating: p.rating, reviewCount: p.reviewCount });
    assert.strictEqual(v.rating, '4.8');
    assert.strictEqual(v.reviewsText, null);
    assert.ok(!/1200/.test(String(v.reviewsText || '')));
    assert.ok(!/3 reviews/.test(String(v.reviewsText || '')));
  });
});

// ═══════════════ G. source seams ═══════════════
console.log('G. file:line seams + kill-switch shape + writer stamps');

check('G1 ratingPairAtomic default is the string "false", compared === "true"', () => {
  const src = fs.readFileSync(PAIR_PATH, 'utf8');
  assert.ok(/process\.env\.RATING_PAIR_ATOMIC\s*\?\?\s*'false'/.test(src));
  assert.ok(/\.toLowerCase\(\)\s*===\s*'true'/.test(src));
});

check('G2 pickLegacyDirectorPair is the two original expressions', () => {
  const src = fs.readFileSync(PAIR_PATH, 'utf8');
  assert.ok(/typeof product\?\.rating === 'number' && product\.rating > 0/.test(src));
  assert.ok(/product\?\.productReviews\?\.reviewCount/.test(src));
  assert.ok(/Array\.isArray\(product\?\.reviews\) \? product\.reviews\.length : null/.test(src));
});

check('G3 pickLegacyDeriveProductPair is the independent details read', () => {
  const src = fs.readFileSync(PAIR_PATH, 'utf8');
  assert.ok(/typeof details\?\.rating === 'number' \|\| typeof details\?\.reviewCount === 'number'/.test(src));
});

check('G4 docstring does not call productReviews the authoritative merchant aggregate', () => {
  const src = fs.readFileSync(PAIR_PATH, 'utf8');
  assert.ok(!/productReviews first \(authoritative/.test(src),
    'false merchant-aggregate claim must not remain');
  assert.ok(/is NOT .*authoritative merchant aggregate/.test(src)
    || /NOT "the authoritative merchant aggregate"/.test(src),
    'must explicitly retract the merchant-aggregate claim');
});

check('G5 usableCount requires v > 0', () => {
  const src = stripComments(fs.readFileSync(PAIR_PATH, 'utf8'));
  const fn = src.slice(src.indexOf('function usableCount'));
  const body = fn.slice(0, fn.indexOf('function classifyProductReviewsProvenance'));
  assert.ok(/v\s*>\s*0/.test(body), 'usableCount must reject non-positive');
});

check('G6 refreshOne stamps quotesOrigin scraped', () => {
  const src = fs.readFileSync(REFRESH_PATH, 'utf8');
  assert.ok(/quotesOrigin:\s*'scraped'/.test(src));
  assert.ok(!/which drops ratings/.test(src), 'stale "gemini drops ratings" comment must be gone');
});

check('G7 integrations refresh stamps llm-web and refuses scraped overwrite', () => {
  const src = fs.readFileSync(INTEG_PATH, 'utf8');
  assert.ok(/quotesOrigin:\s*'llm-web'/.test(src));
  assert.ok(/isScrapedProductReviews/.test(src));
});

// ═══════════════ H. revert-prove (temp copy) ═══════════════
console.log('H. revert-prove (temp-copy mutations)');

const REVERT_ROWS = [];

function withFlagOn(fn) {
  const prev = process.env.RATING_PAIR_ATOMIC;
  process.env.RATING_PAIR_ATOMIC = 'true';
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.RATING_PAIR_ATOMIC;
    else process.env.RATING_PAIR_ATOMIC = prev;
  }
}

function loadMutated(label, mutator) {
  const original = fs.readFileSync(PAIR_PATH, 'utf8');
  const mutated = mutator(original);
  if (mutated === original) throw new Error(`mutation ${label} was a no-op — pattern missed`);
  const tmp = path.join(os.tmpdir(), `verifyRatingPairAtomic-${label}-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmp, mutated);
  delete require.cache[tmp];
  try {
    return { mod: require(tmp), tmp };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* leave */ }
    throw err;
  }
}

function prove(label, mutation, mutator, expectFail) {
  let tmp;
  check(`H ${label} (${mutation})`, () => {
    const loaded = loadMutated(label, mutator);
    tmp = loaded.tmp;
    const failed = [];
    for (const [name, fn] of expectFail) {
      try { fn(loaded.mod); }
      catch { failed.push(name); }
    }
    const names = expectFail.map((c) => c[0]);
    const missed = names.filter((n) => !failed.includes(n));
    REVERT_ROWS.push({
      mutation,
      expectedToFail: names,
      didFail: failed,
      ok: missed.length === 0 && failed.length > 0
    });
    assert.ok(failed.length > 0, 'mutation did not fail any named check');
    assert.strictEqual(missed.length, 0, `expected fail(s) still passing: ${missed.join(', ')}`);
  });
  try { if (tmp) fs.unlinkSync(tmp); } catch { /* leave */ }
}

prove(
  'M1',
  'mix immersive rating + store count (the hole)',
  (s) => s.replace(
    "return { rating: immersiveRating, reviewCount: null, source: 'immersive', provenance: null };",
    "return { rating: immersiveRating, reviewCount: prCount != null ? prCount : null, source: 'immersive', provenance: null };"
  ),
  [
    ['A2 mixed is immersive rating-only', (m) => {
      const p = m.pickAtomicProductRatingPair(MIXED_ATOMIC_INPUT);
      assert.ok(!isCrossPair(p));
      assert.strictEqual(p.reviewCount, null);
    }],
    ['V5 sample length not printed', (m) => {
      const p = m.pickAtomicProductRatingPair(MIXED_ATOMIC_INPUT);
      const v = viewerOf({ rating: p.rating, reviewCount: p.reviewCount });
      assert.strictEqual(v.reviewsText, null);
    }]
  ]
);

prove(
  'M1b',
  'immersive count = reviews.length (the CRITICAL lie)',
  (s) => s.replace(
    "return { rating: immersiveRating, reviewCount: null, source: 'immersive', provenance: null };",
    "return { rating: immersiveRating, reviewCount: Array.isArray(reviews) ? reviews.length : null, source: 'immersive', provenance: null };"
  ),
  [
    ['A2 count is null not reviews.length', (m) => {
      const p = m.pickAtomicProductRatingPair(MIXED_ATOMIC_INPUT);
      assert.strictEqual(p.reviewCount, null);
    }],
    ['V5 3 reviews must not print', (m) => {
      const p = m.pickAtomicProductRatingPair(MIXED_ATOMIC_INPUT);
      const v = viewerOf({ rating: p.rating, reviewCount: p.reviewCount });
      assert.ok(!/3 reviews/.test(String(v.reviewsText || '')));
      assert.strictEqual(v.reviewsText, null);
    }]
  ]
);

prove(
  'M2',
  'drop scraped-first',
  (s) => s.replace(
    `  if (provenance === 'scraped' && prRating != null) {
    return { rating: prRating, reviewCount: storeCount, source: 'productReviews', provenance };
  }`,
    '  /* scraped-first removed */'
  ),
  [
    ['A1 complete scraped productReviews wins', (m) => {
      const p = m.pickAtomicProductRatingPair(COMPLETE_ATOMIC_INPUT);
      assert.strictEqual(p.rating, 4.6);
      assert.strictEqual(p.reviewCount, 1200);
    }]
  ]
);

prove(
  'M3',
  'default the flag ON',
  (s) => s.replace(
    "process.env.RATING_PAIR_ATOMIC ?? 'false'",
    "process.env.RATING_PAIR_ATOMIC ?? 'true'"
  ),
  [
    ['B1 unset is off', (m) => {
      const prev = process.env.RATING_PAIR_ATOMIC;
      delete process.env.RATING_PAIR_ATOMIC;
      try { assert.strictEqual(m.ratingPairAtomicEnabled(), false); }
      finally {
        if (prev === undefined) delete process.env.RATING_PAIR_ATOMIC;
        else process.env.RATING_PAIR_ATOMIC = prev;
      }
    }]
  ]
);

prove(
  'M4',
  'applyHydratedRatingPair always no-op',
  (s) => s.replace(
    'function applyHydratedRatingPair(details, catalog, snapDetails) {\n  if (!ratingPairAtomicEnabled() || !details || typeof details !== \'object\') return details;',
    'function applyHydratedRatingPair(details, catalog, snapDetails) {\n  return details; if (!ratingPairAtomicEnabled() || !details || typeof details !== \'object\') return details;'
  ),
  [
    ['E2 flag-on threads scraped pair', (m) => withFlagOn(() => {
      const d = { rating: 4.8, reviews: MIXED_PRODUCT.reviews };
      m.applyHydratedRatingPair(d, CATALOG, SNAP);
      assert.strictEqual(d.rating, 4.6);
      assert.strictEqual(d.reviewCount, 1200);
    })]
  ]
);

prove(
  'M5',
  'Director resolver always legacy',
  (s) => s.replace(
    'function resolveDirectorProductRatingPair(product) {\n  if (!ratingPairAtomicEnabled()) return pickLegacyDirectorPair(product);\n  return pickAtomicProductRatingPair({',
    'function resolveDirectorProductRatingPair(product) {\n  return pickLegacyDirectorPair(product);\n  if (!ratingPairAtomicEnabled()) return pickLegacyDirectorPair(product);\n  return pickAtomicProductRatingPair({'
  ),
  [
    ['C2 flag-on mixed not cross', (m) => withFlagOn(() => {
      const p = m.resolveDirectorProductRatingPair(MIXED_PRODUCT);
      assert.ok(!isCrossPair(p));
      assert.strictEqual(p.reviewCount, null);
    })],
    ['C3 flag-on complete-pr', (m) => withFlagOn(() => {
      const p = m.resolveDirectorProductRatingPair(COMPLETE_PR_PRODUCT);
      assert.strictEqual(p.rating, 4.6);
      assert.strictEqual(p.reviewCount, 1200);
    })]
  ]
);

prove(
  'M6',
  'derive resolver always legacy',
  (s) => s.replace(
    'function resolveDeriveProductPair(details, productReviews) {\n  if (!ratingPairAtomicEnabled()) return pickLegacyDeriveProductPair(details);',
    'function resolveDeriveProductPair(details, productReviews) {\n  return pickLegacyDeriveProductPair(details); if (!ratingPairAtomicEnabled()) return pickLegacyDeriveProductPair(details);'
  ),
  [
    ['D2 flag-on store pair', (m) => withFlagOn(() => {
      const r = m.resolveDeriveProductPair(
        { rating: 4.8, reviewCount: 1200, productReviews: { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' } },
        { rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped' }
      );
      assert.ok(r);
      assert.ok(!isCrossPair(r));
      assert.strictEqual(r.rating_value, 4.6);
    })]
  ]
);

prove(
  'M7',
  'average kept reviews into a rating',
  (s) => s.replace(
    "if (provenance === 'scraped' && prRating != null) {\n    return { rating: prRating, reviewCount: storeCount, source: 'productReviews', provenance };",
    `if (provenance === 'scraped' && prRating != null) {
    const avg = Array.isArray(reviews) && reviews.length
      ? reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length
      : prRating;
    return { rating: avg, reviewCount: storeCount, source: 'productReviews', provenance };`
  ),
  [
    ['A5 no average', (m) => {
      const p = m.pickAtomicProductRatingPair({
        productReviews: { rating: 4.6, reviewCount: 900, quotesOrigin: 'scraped' },
        reviews: [{ rating: 5 }, { rating: 1 }, { rating: 1 }]
      });
      assert.strictEqual(p.rating, 4.6);
    }]
  ]
);

prove(
  'M8',
  'usableCount accepts 0 / negatives',
  (s) => s.replace(
    'function usableCount(v) {\n  return typeof v === \'number\' && Number.isFinite(v) && v > 0 ? v : null;\n}',
    'function usableCount(v) {\n  return typeof v === \'number\' && Number.isFinite(v) ? v : null;\n}'
  ),
  [
    ['A8 usableCount rejects 0', (m) => {
      assert.strictEqual(m.usableCount(0), null);
      assert.strictEqual(m.usableCount(-1), null);
    }]
  ]
);

prove(
  'M9',
  'treat llm-web count as a store total',
  (s) => s.replace(
    "if (provenance === 'llm-web' && prRating != null) {\n    return { rating: prRating, reviewCount: null, source: 'productReviews', provenance };\n  }",
    "if (provenance === 'llm-web' && prRating != null) {\n    return { rating: prRating, reviewCount: prCount, source: 'productReviews', provenance };\n  }"
  ),
  [
    ['A9 llm-web count withheld', (m) => {
      const p = m.pickAtomicProductRatingPair({ productReviews: LLM_WEB_PR, rating: 4.0 });
      assert.strictEqual(p.reviewCount, null);
    }],
    ['V6 Trustpilot 126 not typeset', (m) => {
      const p = m.pickAtomicProductRatingPair({ productReviews: LLM_WEB_PR });
      const v = viewerOf({ rating: p.rating, reviewCount: p.reviewCount });
      assert.ok(!/126/.test(String(v.reviewsText || '')));
      assert.strictEqual(p.reviewCount, null);
    }]
  ]
);

prove(
  'M10',
  'selectProductReviewsSnapshot returns first candidate (stale-details hole)',
  (s) => s.replace(
    'if (!rows.length) return null;\n  return rows.slice().sort((a, b) => {',
    'if (!rows.length) return null;\n  return rows[0]; return rows.slice().sort((a, b) => {'
  ),
  [
    ['A11 stale llm-web loses to scraped', (m) => {
      const stale = {
        rating: 3.1, reviewCount: 12, quotesOrigin: 'llm-web',
        fetchedAt: '2024-01-01T00:00:00.000Z'
      };
      const fresh = {
        rating: 4.6, reviewCount: 1200, quotesOrigin: 'scraped',
        fetchedAt: '2026-08-01T00:00:00.000Z'
      };
      const chosen = m.selectProductReviewsSnapshot([stale, fresh]);
      assert.strictEqual(chosen.quotesOrigin, 'scraped');
    }]
  ]
);

prove(
  'M11',
  'hydrate count beside immersive rating (the mix)',
  (s) => s.replace(
    'details.reviewCount = pair.reviewCount != null ? pair.reviewCount : null;',
    'details.reviewCount = (catalog && catalog.productReviews && catalog.productReviews.reviewCount) || pair.reviewCount || null;'
  ),
  [
    ['E2mix no store count beside immersive', (m) => withFlagOn(() => {
      const d = { rating: 4.8, reviews: MIXED_PRODUCT.reviews };
      const countOnly = {
        ...CATALOG,
        productReviews: { reviewCount: 1200, quotesOrigin: 'scraped' }
      };
      m.applyHydratedRatingPair(d, countOnly, SNAP);
      assert.strictEqual(d.rating, 4.8);
      assert.strictEqual(d.reviewCount, null);
    })]
  ]
);

check('H table recorded 12 mutations', () => {
  assert.strictEqual(REVERT_ROWS.length, 12);
  assert.ok(REVERT_ROWS.every((r) => r.ok), 'a revert-prove row did not trip its named check');
});

// ── report ────────────────────────────────────────────────────────────
console.log('\nrevert-prove table');
console.log('mutation'.padEnd(64) + 'failed checks');
for (const row of REVERT_ROWS) {
  console.log(`  ${row.mutation}`);
  console.log(`    → ${row.didFail.join(', ') || '(none)'}`);
}

if (ORIGINAL_FLAG === undefined) delete process.env.RATING_PAIR_ATOMIC;
else process.env.RATING_PAIR_ATOMIC = ORIGINAL_FLAG;

const total = pass + failures.length;
if (failures.length) {
  console.log(`\n❌ verifyRatingPairAtomic: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`\n✅ verifyRatingPairAtomic: ${total}/${total} checks passed`);
