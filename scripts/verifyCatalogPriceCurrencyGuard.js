#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogPriceCurrencyGuard — offline guard for the Pelagic Gear price
 * incident: CatalogProduct.price for source:'apify-shopify' was a correct
 * ZAR list price from a misconfigured storefront (Brand.apifyDemo.shopifyUrl
 * pointed at za.pelagicgear.com, a real, separate South-African Shopify
 * store — confirmed live: its /meta.json reports {"currency":"ZAR",
 * "country":"ZA"}, and its /products/torrent-jacket.json price (2999.00)
 * matches the stored CatalogProduct.price exactly) mislabeled currency:'USD'.
 * Read as dollars it was ~19.97-19.99x too high (that ratio is the live
 * USD/ZAR rate, not a cents/dollars unit bug).
 *
 * WHAT THIS PINS
 *   A. remotion/lib/priceFormat.js#formatBarePriceUsd — behavioural: a bare
 *      numeric price is formatted as USD money; a value that cannot be
 *      trusted (non-finite, negative) returns null rather than a number.
 *   B. remotion/components/slotRenderers.jsx PriceSlot — source-pin (this
 *      file is JSX; Node cannot require it directly — same limitation
 *      documented in verifyRatingMotion.js) confirming it (1) still imports
 *      formatBarePriceUsd, (2) does not reintroduce the naive
 *      `` `$${raw}` `` string-concat that caused the original defect, and
 *      (3) renders nothing when the formatter returns null.
 *   C. services/shopifyAccessResolver.js#verifyStoreCurrencyUsd — behavioural
 *      against a mocked global.fetch: confirmed USD, confirmed non-USD
 *      (mismatch:true), and inconclusive (network error / no currency field
 *      / no origin) all return the documented shape.
 *   D. services/apifyIngestService.js#syncBrandShopify — behavioural, via a
 *      poisoned require.cache substitute for apifyPullService: a confirmed
 *      non-USD store REFUSES before ever calling the PAID
 *      pullShopifyProducts (the Apify actor run); a confirmed-USD or
 *      inconclusive store DOES reach it (proves the guard does not
 *      over-block). This is the actual money-saving property, proven by
 *      calling the real function, not by reading its source.
 *   E. services/shopifyPublicIngestService.js#syncBrandShopifyDirect — same
 *      refusal behaviour on the free path (correctness, not cost — this path
 *      has no Apify spend) plus a source-order pin that the guard sits
 *      before the resolver ladder.
 *
 * No DB, no real network (fetch is mocked), no API key. Safe in CI.
 *
 *   node scripts/verifyCatalogPriceCurrencyGuard.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.stack || err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.stack || err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const SLOT_SRC = fs.readFileSync(path.join(ROOT, 'remotion/components/slotRenderers.jsx'), 'utf8');
const CATALOG_PRODUCT_SRC = fs.readFileSync(path.join(ROOT, 'models/CatalogProduct.js'), 'utf8');

console.log('\nverifyCatalogPriceCurrencyGuard — Pelagic price/currency incident\n');

// ── A. formatBarePriceUsd (remotion/lib/priceFormat.js) ────────────────────
const { formatBarePriceUsd } = require('../remotion/lib/priceFormat.js');

check('A1 formats a plain integer major-unit price', () => {
  assert.strictEqual(formatBarePriceUsd(150), '$150.00');
});
check('A2 formats a decimal price', () => {
  assert.strictEqual(formatBarePriceUsd('150.5'), '$150.50');
});
check('A3 formats the actual incident value as a number, not a wrong-currency passthrough', () => {
  // The point is NOT "2999 is correct" (it wasn't, for this product) — the
  // point is the FORMATTER cannot know that; it only guarantees the string
  // it produces is a well-formed USD amount, never a bare "$2999" concat.
  assert.strictEqual(formatBarePriceUsd(2999), '$2,999.00');
});
check('A4 strips thousands-separator commas before parsing', () => {
  assert.strictEqual(formatBarePriceUsd('2,999'), '$2,999.00');
});
check('A5 rejects non-numeric garbage (renders nothing, not "$NaN")', () => {
  assert.strictEqual(formatBarePriceUsd('abc'), null);
});
check('A6 rejects a negative number', () => {
  assert.strictEqual(formatBarePriceUsd(-5), null);
});
check('A7 rejects empty string', () => {
  assert.strictEqual(formatBarePriceUsd(''), null);
});
check('A8 zero is a valid price (free item), not rejected', () => {
  assert.strictEqual(formatBarePriceUsd(0), '$0.00');
});

// ── B. PriceSlot source pins (JSX — cannot require(), same as RatingSlot) ──
const priceBlock = SLOT_SRC.slice(
  SLOT_SRC.indexOf('export const PriceSlot'),
  SLOT_SRC.indexOf('export const', SLOT_SRC.indexOf('export const PriceSlot') + 1) === -1
    ? undefined
    : SLOT_SRC.indexOf('export const', SLOT_SRC.indexOf('export const PriceSlot') + 1)
);

check('B1 PriceSlot block exists', () => {
  assert.ok(priceBlock && priceBlock.length > 20, 'could not isolate PriceSlot block');
});
check('B2 imports formatBarePriceUsd from the shared plain module', () => {
  assert.match(SLOT_SRC, /import\s*\{\s*formatBarePriceUsd\s*\}\s*from\s*['"]\.\.\/lib\/priceFormat\.js['"]/);
});
check('B3 PriceSlot calls formatBarePriceUsd for the bare-number branch', () => {
  assert.match(priceBlock, /formatBarePriceUsd\s*\(/);
});
check('B4 FAIL-IF-REVERTED: no naive `$${raw}`-style concat reintroduced', () => {
  // The exact defect: a template literal that prefixes "$" directly onto the
  // raw content string with no numeric parsing/formatting in between.
  assert.doesNotMatch(priceBlock, /\$\{['"`]?\$\{?\s*raw\s*\}?['"`]?\}/);
  assert.doesNotMatch(priceBlock, /`\$\$\{raw\}`/);
  assert.doesNotMatch(priceBlock, /'\$'\s*\+\s*raw\b/);
});
check('B5 renders nothing (returns null) when the formatter cannot vouch for a value', () => {
  assert.match(priceBlock, /if\s*\(\s*text\s*==\s*null\s*\)\s*return\s+null/);
});
check('B6 currency-marker passthrough branch is still present (formatted strings from upstream pass through verbatim)', () => {
  assert.match(priceBlock, /hasCurrencyMarker/);
});

// ── C. verifyStoreCurrencyUsd (services/shopifyAccessResolver.js) ──────────
const { verifyStoreCurrencyUsd } = require('../services/shopifyAccessResolver.js');

function withMockedFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = real; });
}

async function runCurrencyResolverChecks() {
  await checkAsync('C1 confirmed USD store → verified:true, mismatch:false', async () => {
    await withMockedFetch(
      async () => ({ ok: true, json: async () => ({ currency: 'USD' }) }),
      async () => {
        const r = await verifyStoreCurrencyUsd('https://pelagicgear.com');
        assert.strictEqual(r.verified, true);
        assert.strictEqual(r.mismatch, false);
        assert.strictEqual(r.currency, 'USD');
      }
    );
  });

  await checkAsync('C2 confirmed NON-USD store (the actual incident shape) → mismatch:true, verified:false', async () => {
    await withMockedFetch(
      async () => ({ ok: true, json: async () => ({ currency: 'ZAR', country: 'ZA' }) }),
      async () => {
        const r = await verifyStoreCurrencyUsd('https://za.pelagicgear.com');
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.mismatch, true);
        assert.strictEqual(r.currency, 'ZAR');
      }
    );
  });

  await checkAsync('C3 network error → inconclusive (verified:false, mismatch:false) — must NOT be treated as a confirmed mismatch', async () => {
    await withMockedFetch(
      async () => { throw new Error('ECONNRESET'); },
      async () => {
        const r = await verifyStoreCurrencyUsd('https://example.com');
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.mismatch, false);
        assert.strictEqual(r.currency, null);
      }
    );
  });

  await checkAsync('C4 non-200 response → inconclusive, not a mismatch', async () => {
    await withMockedFetch(
      async () => ({ ok: false, status: 503 }),
      async () => {
        const r = await verifyStoreCurrencyUsd('https://example.com');
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.mismatch, false);
      }
    );
  });

  await checkAsync('C5 meta.json with no currency field → inconclusive, not a mismatch', async () => {
    await withMockedFetch(
      async () => ({ ok: true, json: async () => ({ name: 'Some Shop' }) }),
      async () => {
        const r = await verifyStoreCurrencyUsd('https://example.com');
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.mismatch, false);
      }
    );
  });

  await checkAsync('C6 no origin → inconclusive, never throws', async () => {
    const r = await verifyStoreCurrencyUsd(null);
    assert.strictEqual(r.verified, false);
    assert.strictEqual(r.mismatch, false);
  });

  await checkAsync('C7 case-insensitive currency comparison ("usd" lowercase still verifies)', async () => {
    await withMockedFetch(
      async () => ({ ok: true, json: async () => ({ currency: 'usd' }) }),
      async () => {
        const r = await verifyStoreCurrencyUsd('https://example.com');
        assert.strictEqual(r.verified, true);
        assert.strictEqual(r.currency, 'USD');
      }
    );
  });
}

// ── D. syncBrandShopify refuses BEFORE the paid Apify call ─────────────────
// Poison apifyPullService via require.cache substitution so a real call to
// pullShopifyProducts (the billable Apify actor run) throws loudly — this
// proves, behaviourally, whether the guard actually short-circuits before
// that call, not merely that the source text contains a check.
function withPoisonedApifyPullService(fn) {
  const apifyPullServicePath = require.resolve('../services/apifyPullService.js');
  const apifyIngestServicePath = require.resolve('../services/apifyIngestService.js');
  const realPullCacheEntry = require.cache[apifyPullServicePath];
  const realIngestCacheEntry = require.cache[apifyIngestServicePath];

  const SENTINEL = 'MONEY-GUARD-TEST: pullShopifyProducts was called — a paid Apify run would have been submitted';
  delete require.cache[apifyPullServicePath];
  delete require.cache[apifyIngestServicePath];
  require.cache[apifyPullServicePath] = {
    id: apifyPullServicePath,
    filename: apifyPullServicePath,
    loaded: true,
    exports: {
      pullInstagramPosts: async () => { throw new Error('pullInstagramPosts should not be called by this test'); },
      pullShopifyProducts: async () => { throw new Error(SENTINEL); }
    }
  };
  try {
    // Re-require with the poisoned dependency now in the cache.
    const apifyIngestService = require('../services/apifyIngestService.js');
    return fn(apifyIngestService, SENTINEL);
  } finally {
    delete require.cache[apifyPullServicePath];
    delete require.cache[apifyIngestServicePath];
    if (realPullCacheEntry) require.cache[apifyPullServicePath] = realPullCacheEntry;
    if (realIngestCacheEntry) require.cache[apifyIngestServicePath] = realIngestCacheEntry;
  }
}

const FAKE_BRAND = {
  _id: 'fake-brand-id',
  advertiserId: 'fake-advertiser-id',
  name: 'Fake Test Brand',
  apifyDemo: { shopifyUrl: 'https://za.pelagicgear.com' }
};

async function runApifyGuardChecks() {
  await checkAsync('D1 confirmed non-USD store: syncBrandShopify refuses WITHOUT reaching pullShopifyProducts', () => {
    return withPoisonedApifyPullService(async (apifyIngestService, SENTINEL) => {
      await withMockedFetch(
        async () => ({ ok: true, json: async () => ({ currency: 'ZAR' }) }),
        async () => {
          const result = await apifyIngestService.syncBrandShopify(FAKE_BRAND, null);
          assert.strictEqual(result.ok, false);
          assert.strictEqual(result.currencyMismatch, true);
          assert.strictEqual(result.detectedCurrency, 'ZAR');
        }
      );
    });
  });

  await checkAsync('D2 confirmed USD store: syncBrandShopify PROCEEDS to the paid call (guard does not over-block)', () => {
    return withPoisonedApifyPullService(async (apifyIngestService, SENTINEL) => {
      await withMockedFetch(
        async () => ({ ok: true, json: async () => ({ currency: 'USD' }) }),
        async () => {
          await assert.rejects(
            () => apifyIngestService.syncBrandShopify(FAKE_BRAND, null),
            (err) => err.message === SENTINEL
          );
        }
      );
    });
  });

  await checkAsync('D3 inconclusive check (network error): syncBrandShopify still PROCEEDS (fail-open on unknown, not on confirmed-wrong)', () => {
    return withPoisonedApifyPullService(async (apifyIngestService, SENTINEL) => {
      await withMockedFetch(
        async () => { throw new Error('DNS fail'); },
        async () => {
          await assert.rejects(
            () => apifyIngestService.syncBrandShopify(FAKE_BRAND, null),
            (err) => err.message === SENTINEL
          );
        }
      );
    });
  });
}

// ── E. syncBrandShopifyDirect refuses on confirmed mismatch (free path) ────
async function runPublicIngestGuardChecks() {
  const shopifyPublicIngestService = require('../services/shopifyPublicIngestService.js');
  const SRC = fs.readFileSync(path.join(ROOT, 'services/shopifyPublicIngestService.js'), 'utf8');

  await checkAsync('E1 confirmed non-USD store: syncBrandShopifyDirect refuses cleanly (no throw)', async () => {
    await withMockedFetch(
      async () => ({ ok: true, json: async () => ({ currency: 'ZAR' }) }),
      async () => {
        const result = await shopifyPublicIngestService.syncBrandShopifyDirect(FAKE_BRAND, null, {});
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.currencyMismatch, true);
        assert.strictEqual(result.detectedCurrency, 'ZAR');
        assert.strictEqual(result.productsUpserted, 0);
      }
    );
  });

  check('E2 the currency guard is positioned BEFORE resolveShopifyAccess is invoked', () => {
    const fnBody = SRC.slice(SRC.indexOf('async function syncBrandShopifyDirect'));
    const guardIdx = fnBody.indexOf('verifyStoreCurrencyUsd(origin)');
    const ladderIdx = fnBody.indexOf('resolveShopifyAccess(brand');
    assert.ok(guardIdx > -1, 'guard call not found');
    assert.ok(ladderIdx > -1, 'resolver ladder call not found');
    assert.ok(guardIdx < ladderIdx, 'currency guard must run before the catalog access ladder');
  });
}

// ── F. Unit contract is documented where readers will look for it ─────────
check('F1 models/CatalogProduct.js documents the USD-major-units contract on the price field', () => {
  assert.match(CATALOG_PRODUCT_SRC, /UNIT CONTRACT/);
  assert.match(CATALOG_PRODUCT_SRC, /USD MAJOR/i);
  assert.match(CATALOG_PRODUCT_SRC, /\bUNITS\b/i);
});

(async () => {
  await runCurrencyResolverChecks();
  await runApifyGuardChecks();
  await runPublicIngestGuardChecks();

  const total = pass + failures.length;
  if (failures.length) {
    console.log(`❌ verifyCatalogPriceCurrencyGuard: ${pass}/${total} checks passed\n`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyCatalogPriceCurrencyGuard: ${pass}/${total} checks passed\n`);
  }
})();
