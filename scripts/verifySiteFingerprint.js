#!/usr/bin/env node
//
// verifySiteFingerprint — offline harness for:
//   services/siteFingerprintService.js          (platform detection)
//   shopifyPublicIngestService.mapShopifyNormalizedToFlat  (shared adapter)
//   CatalogProduct.source enum membership for the Shopify auto-detect stamp
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifySiteFingerprint.js
//
// Revert-prove: temporarily remove the powered-by Shopify signal in
// siteFingerprintService and confirm the Shopify-detection checks FAIL,
// then restore. Report both pass counts.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  fingerprintSite,
  normalizeHeaders,
  PLATFORMS
} = require('../services/siteFingerprintService');
const {
  mapShopifyNormalizedToFlat,
  mapShopifyProductImages,
  CATALOG_MAX_ADDITIONAL_IMAGES
} = require('../services/shopifyPublicIngestService');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log(`❌ ${label}: ${msg}`);
  }
}

// ── A. Exports / shape ────────────────────────────────────────────────

check('A1 fingerprintSite is a function', () => {
  assert.equal(typeof fingerprintSite, 'function');
});
check('A2 normalizeHeaders is a function', () => {
  assert.equal(typeof normalizeHeaders, 'function');
});
check('A3 PLATFORMS includes shopify + unknown', () => {
  assert.ok(PLATFORMS.includes('shopify'));
  assert.ok(PLATFORMS.includes('unknown'));
  assert.ok(PLATFORMS.includes('woocommerce'));
});
check('A4 mapShopifyNormalizedToFlat is a function', () => {
  assert.equal(typeof mapShopifyNormalizedToFlat, 'function');
});

// ── B. Shopify signals ────────────────────────────────────────────────

check('B1 powered-by: Shopify header alone → shopify, confidence high', () => {
  const r = fingerprintSite({
    homepageHtml: '<html><body>Hello furniture store</body></html>',
    homepageHeaders: { 'powered-by': 'Shopify' },
    robotsText: null
  });
  assert.equal(r.platform, 'shopify');
  assert.equal(r.confidence, 'high');
  assert.ok(r.signals.includes('header:powered-by'));
});

check('B2 Shopify.shop body alone → shopify', () => {
  const r = fingerprintSite({
    homepageHtml: '<script>Shopify.shop = "foo.myshopify.com";</script>',
    homepageHeaders: {},
    robotsText: null
  });
  assert.equal(r.platform, 'shopify');
  assert.ok(r.confidence === 'high' || r.confidence === 'medium');
  assert.ok(r.signals.includes('body:Shopify.shop'));
});

check('B3 x-shopid + cdn.shopify.com → shopify high', () => {
  const r = fingerprintSite({
    homepageHtml: '<img src="https://cdn.shopify.com/s/files/1/x/y.jpg">',
    homepageHeaders: { 'X-ShopId': '123456' },
    robotsText: null
  });
  assert.equal(r.platform, 'shopify');
  assert.equal(r.confidence, 'high');
});

check('B4 Shopify robots signature alone → shopify', () => {
  const robots = [
    'User-agent: *',
    'Disallow: /checkout',
    'Disallow: /collections/*sort_by*',
    'Disallow: /cart',
    'Sitemap: https://example.com/sitemap.xml'
  ].join('\n');
  const r = fingerprintSite({
    homepageHtml: '<html></html>',
    homepageHeaders: {},
    robotsText: robots
  });
  assert.equal(r.platform, 'shopify');
  assert.ok(r.signals.includes('robots:shopify-signature'));
});

check('B5 httpScrapeClient-shaped headers.raw works', () => {
  const r = fingerprintSite({
    homepageHtml: '',
    homepageHeaders: {
      etag: null,
      lastModified: null,
      retryAfter: null,
      contentType: 'text/html',
      raw: { 'powered-by': 'Shopify', 'x-shopid': '99' }
    },
    robotsText: null
  });
  assert.equal(r.platform, 'shopify');
  assert.equal(r.confidence, 'high');
});

// ── C. Living Spaces / non-Shopify no-regression ──────────────────────

const LIVING_SPACES_LIKE = `
<!DOCTYPE html>
<html>
<head><title>Living Spaces — Furniture</title>
<meta property="og:site_name" content="Living Spaces">
</head>
<body>
  <h1>Modern Furniture</h1>
  <script type="application/ld+json">
  {"@type":"Organization","name":"Living Spaces"}
  </script>
  <div class="product-grid">sofa chairs tables</div>
</body>
</html>
`;

check('C1 Living-Spaces-like input → NOT shopify (no-regression guard)', () => {
  const r = fingerprintSite({
    homepageHtml: LIVING_SPACES_LIKE,
    homepageHeaders: {
      server: 'cloudflare',
      'content-type': 'text/html'
    },
    robotsText: 'User-agent: *\nDisallow: /admin\nSitemap: https://www.livingspaces.com/sitemap.xml'
  });
  assert.notEqual(r.platform, 'shopify');
  assert.ok(!r.signals.some((s) => /shopify/i.test(s)));
});

// ── D. Other platforms ────────────────────────────────────────────────

check('D1 WooCommerce fixture → woocommerce', () => {
  const r = fingerprintSite({
    homepageHtml: '<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/x.css"><div class="woocommerce">shop</div>',
    homepageHeaders: {},
    robotsText: null
  });
  assert.equal(r.platform, 'woocommerce');
});

check('D2 BigCommerce fixture → bigcommerce', () => {
  const r = fingerprintSite({
    homepageHtml: '<script src="https://cdn11.bigcommerce.com/s-abc/stencil/js/theme.js"></script>',
    homepageHeaders: {},
    robotsText: null
  });
  assert.equal(r.platform, 'bigcommerce');
});

check('D3 Magento fixture → magento', () => {
  const r = fingerprintSite({
    homepageHtml: '<script>Mage.Cookies = {};</script><link href="/static/version1234567890/frontend/Magento/luma/en_US/css/styles.css">',
    homepageHeaders: { 'x-magento-tags': 'store' },
    robotsText: null
  });
  assert.equal(r.platform, 'magento');
});

check('D4 SFCC / Demandware fixture → salesforce-commerce', () => {
  const r = fingerprintSite({
    homepageHtml: '<a href="/on/demandware.store/Sites-Shop-Site/default/Home-Show">home</a>',
    homepageHeaders: { 'set-cookie': 'dwsid=abc123; Path=/' },
    robotsText: null
  });
  assert.equal(r.platform, 'salesforce-commerce');
});

check('D5 SPA shell (__NEXT_DATA__, no Product) → spa', () => {
  const r = fingerprintSite({
    homepageHtml: '<div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
    homepageHeaders: {},
    robotsText: null
  });
  assert.equal(r.platform, 'spa');
});

// ── E. Garbage / never-throw ──────────────────────────────────────────

check('E1 empty object → unknown, no throw', () => {
  const r = fingerprintSite({});
  assert.equal(r.platform, 'unknown');
  assert.equal(r.confidence, 'unknown');
  assert.ok(Array.isArray(r.signals));
});

check('E2 nulls → unknown, no throw', () => {
  const r = fingerprintSite({
    homepageHtml: null,
    homepageHeaders: null,
    robotsText: null
  });
  assert.equal(r.platform, 'unknown');
});

check('E3 no-arg call → unknown', () => {
  const r = fingerprintSite();
  assert.equal(r.platform, 'unknown');
});

check('E4 Headers-like instance (get/forEach) → powered-by works', () => {
  const store = new Map([['powered-by', 'Shopify'], ['content-type', 'text/html']]);
  const fakeHeaders = {
    get(k) { return store.get(String(k).toLowerCase()); },
    forEach(cb) { store.forEach((v, k) => cb(v, k)); }
  };
  const r = fingerprintSite({ homepageHeaders: fakeHeaders });
  assert.equal(r.platform, 'shopify');
  assert.equal(r.confidence, 'high');
});

check('E5 weird header casing POWERED-BY → shopify', () => {
  const r = fingerprintSite({
    homepageHeaders: { 'POWERED-BY': 'Shopify' }
  });
  assert.equal(r.platform, 'shopify');
});

check('E6 normalizeHeaders never throws on garbage', () => {
  assert.deepEqual(normalizeHeaders(null), Object.create(null));
  assert.equal(typeof normalizeHeaders(undefined), 'object');
  assert.equal(typeof normalizeHeaders(42), 'object');
  assert.equal(typeof normalizeHeaders('powered-by: Shopify'), 'object');
});

// ── F. Adapter: products.json → flat + shared image cap ───────────────

function makeProductsJsonFixture(imageCount) {
  const images = [];
  for (let i = 0; i < imageCount; i++) {
    images.push({
      id: 1000 + i,
      src: `https://cdn.shopify.com/s/files/1/0000/0001/products/img-${i}.jpg`
    });
  }
  return {
    id: 7788990011,
    handle: 'ws-pb5-court2-mint-multi',
    title: 'PB5 Court 2 Mint Multi',
    body_html: '<p>A <strong>great</strong> shoe with 15 gallery shots.</p>',
    vendor: 'PB5Star',
    product_type: 'Shoes',
    tags: ['court', 'mint'],
    variants: [
      { id: 1, price: '129.00', compare_at_price: '149.00', sku: 'PB5-C2-M', barcode: '012345678901', available: true },
      { id: 2, price: '129.00', sku: 'PB5-C2-M-10', available: false }
    ],
    images
  };
}

check('F1 15-image products.json fixture → imageUrl + 14 additionalImages', () => {
  const p = makeProductsJsonFixture(15);
  const flat = mapShopifyNormalizedToFlat(p, 'https://www.pb5star.com', { name: 'PB5Star' });
  assert.ok(flat, 'mapper returned null');
  assert.equal(flat.externalId, '7788990011');
  assert.equal(flat.title, 'PB5 Court 2 Mint Multi');
  assert.equal(flat.price, 129);
  assert.equal(flat.availability, 'in stock');
  assert.equal(flat.productUrl, 'https://www.pb5star.com/products/ws-pb5-court2-mint-multi');
  assert.equal(flat.imageUrl, p.images[0].src);
  assert.equal(flat.additionalImages.length, 14);
  assert.equal(flat.additionalImages[0], p.images[1].src);
  assert.equal(flat.additionalImages[13], p.images[14].src);
  // description stripped of tags
  assert.ok(flat.description && !/<strong>/.test(flat.description));
  assert.equal(flat.gtin, '012345678901');
  assert.equal(flat.mpn, 'PB5-C2-M');
  assert.equal(flat.brand, 'PB5Star');
});

check('F2 adapter shares mapShopifyProductImages (storage cap)', () => {
  // Cap is CATALOG_MAX_ADDITIONAL_IMAGES (default 20). 25 images → 1 hero + 20 alts.
  const p = makeProductsJsonFixture(25);
  const viaMapper = mapShopifyNormalizedToFlat(p, 'https://example.com');
  const viaDirect = mapShopifyProductImages(p.images);
  assert.equal(viaMapper.imageUrl, viaDirect.imageUrl);
  assert.deepEqual(viaMapper.additionalImages, viaDirect.additionalImages);
  assert.equal(viaMapper.additionalImages.length, Math.min(24, CATALOG_MAX_ADDITIONAL_IMAGES));
});

check('F3 adapter null/garbage → null, no throw', () => {
  assert.equal(mapShopifyNormalizedToFlat(null, 'https://x.com'), null);
  assert.equal(mapShopifyNormalizedToFlat({}, 'https://x.com'), null);
  assert.equal(mapShopifyNormalizedToFlat({ title: 'no id' }, 'https://x.com'), null);
});

check('F4 adapter out-of-stock when no variant available', () => {
  const p = makeProductsJsonFixture(2);
  p.variants = [{ id: 1, price: '10.00', available: false }];
  const flat = mapShopifyNormalizedToFlat(p, 'https://example.com');
  assert.equal(flat.availability, 'out of stock');
});

// ── G. Source stamp is a real CatalogProduct enum member ──────────────

check('G1 Shopify-resolved mode maps to shopify-direct', () => {
  // Mirrors genericCatalogIngestService catalogSource resolution.
  function catalogSourceFromAccess(access) {
    if (access.source === 'shopify-direct' || access.source === 'sitemap-jsonld') {
      return access.source;
    }
    const shopifyModes = new Set(['products-json', 'storefront-graphql', 'sitemap']);
    if (shopifyModes.has(access.mode)) return 'shopify-direct';
    return 'sitemap-jsonld';
  }
  assert.equal(catalogSourceFromAccess({ source: 'shopify-direct', mode: 'products-json' }), 'shopify-direct');
  assert.equal(catalogSourceFromAccess({ mode: 'products-json' }), 'shopify-direct');
  assert.equal(catalogSourceFromAccess({ mode: 'storefront-graphql' }), 'shopify-direct');
  assert.equal(catalogSourceFromAccess({ mode: 'sitemap' }), 'shopify-direct');
  assert.equal(catalogSourceFromAccess({ mode: 'sitemap-jsonld' }), 'sitemap-jsonld');
  assert.equal(catalogSourceFromAccess({ source: 'sitemap-jsonld' }), 'sitemap-jsonld');
});

check('G2 shopify-direct is a member of the real CatalogProduct.source enum', () => {
  const modelPath = path.join(__dirname, '..', 'models', 'CatalogProduct.js');
  const src = fs.readFileSync(modelPath, 'utf8');
  // Parse the enum array literal out of the schema (do not hardcode).
  const m = src.match(/source:\s*\{[\s\S]*?enum:\s*\[([^\]]+)\]/);
  assert.ok(m, 'could not find source enum in CatalogProduct.js');
  const enumVals = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.ok(enumVals.includes('shopify-direct'), `enum missing shopify-direct: ${enumVals.join(',')}`);
  assert.ok(enumVals.includes('sitemap-jsonld'), `enum missing sitemap-jsonld: ${enumVals.join(',')}`);
  // The auto-detect path must not invent values outside this list.
  assert.ok(enumVals.includes('shopify-direct'));
});

// ── H. Confidence rules ───────────────────────────────────────────────

check('H1 two independent shopify signals → high', () => {
  const r = fingerprintSite({
    homepageHtml: 'cdn.shopify.com and Shopify.shop = "x.myshopify.com"',
    homepageHeaders: {}
  });
  assert.equal(r.platform, 'shopify');
  assert.equal(r.confidence, 'high');
  assert.ok(r.signals.length >= 2);
});

check('H2 single body:cdn.shopify.com → medium', () => {
  const r = fingerprintSite({
    homepageHtml: '<img src="https://cdn.shopify.com/s/files/1/x.jpg">',
    homepageHeaders: {}
  });
  assert.equal(r.platform, 'shopify');
  assert.equal(r.confidence, 'medium');
});

// ── summary ───────────────────────────────────────────────────────────

const total = pass + fail;
console.log('');
console.log(`${pass}/${total} checks passed`);
if (fail > 0) {
  console.error(`❌ ${fail} check(s) failed`);
  process.exit(1);
}
console.log('✓ verifySiteFingerprint: all checks passed');
process.exit(0);
