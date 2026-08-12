#!/usr/bin/env node
'use strict';
//
// verifyCatalogImageResolution — offline harness for Lane Q:
//   generic catalog path must NOT store 84×100 Shopify `_small` thumbnails
//   as ad seeds, and must populate additionalImages from the full gallery.
//
// Pins (behavioural — no network, no DB, no API key):
//   A. Shopify JSON-LD `_small` URL resolves to the full-resolution URL
//   B. Every Shopify size-suffix form is handled; query string survives
//   C. Non-Shopify URLs and unsuffixed URLs are returned UNCHANGED
//   D. additionalImages populated from multi-image product, feed order,
//      capped at MAX_ADDITIONAL_IMAGES from catalogImageLimits (reads the
//      constant — changing the constant changes the cap)
//   E. Failure of the full-res path falls back to the original URL
//   F. products/{handle}.js gallery enrichment fills alts on thin JSON-LD
//      and never drops a working seed when the fetch fails
//
//   node scripts/verifyCatalogImageResolution.js
//
// Revert-prove (each mutation must fail the named check — see table at end
// of this file's console output when REVERT_PROVE=1):
//   M1 strip size-suffix logic → A/B fail
//   M2 drop query preservation → B query check fails
//   M3 apply strip to non-Shopify hosts → C fails
//   M4 hardcode additionalImages cap → D constant-cap fails
//   M5 drop fallback on HEAD 404 → E fails
//   M6 drop products.js enrichment → F multi-image fails

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const { MAX_ADDITIONAL_IMAGES } = require('../services/catalogImageLimits');
const {
  upgradeImageUrl,
  resolveUpgradedImageUrl,
  createImageUpgradeRun
} = require('../services/imageUrlUpgrade');
const {
  imagesFromNode,
  mapJsonLdProduct,
  extractShopifyProductHandle,
  imagesFromShopifyProductPayload,
  preferShopifyGallery,
  shouldEnrichShopifyGallery,
  tryShopifyProductGallery
} = require('../services/genericCatalogResolver');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`✓ ${label}`);
    return;
  }
  fail += 1;
  const msg = detail != null ? `${label}: ${detail}` : label;
  failures.push(msg);
  console.log(`❌ ${msg}`);
}

// ── fixtures (measured shape, marinelayer.com 2026-08-11) ───────────

const ML_HANDLE = 'womens-riley-denim-barn-jacket-rinse';
const ML_PAGE = `https://www.marinelayer.com/products/${ML_HANDLE}`;
const ML_SMALL =
  'https://www.marinelayer.com/cdn/shop/files/F1_W_Riley_Denim_Barn_Jacket_Rinse_11822-Final-Web_small.jpg?v=1784225280';
const ML_ORIGINAL =
  'https://www.marinelayer.com/cdn/shop/files/F1_W_Riley_Denim_Barn_Jacket_Rinse_11822-Final-Web.jpg?v=1784225280';

const CDN = 'https://cdn.shopify.com/s/files/1/0831/9103/files/photo';

// ════════════════════════════════════════════════════════════════════
// A. Shopify _small → full-res
// ════════════════════════════════════════════════════════════════════

{
  const r = upgradeImageUrl(ML_SMALL);
  check(
    'A1 marinelayer _small upgrades',
    r.upgraded === true && r.url === ML_ORIGINAL,
    `upgraded=${r.upgraded} url=${r.url}`
  );
  check(
    'A1b query ?v= preserved byte-for-byte',
    r.url.endsWith('?v=1784225280') && !r.url.includes('_small'),
    r.url
  );
}

{
  const r = upgradeImageUrl(`${CDN}_small.jpg?v=9`);
  check(
    'A2 cdn.shopify.com host form upgrades',
    r.upgraded === true && r.url === `${CDN}.jpg?v=9`,
    r.url
  );
}

// ════════════════════════════════════════════════════════════════════
// B. Every size-suffix form + query survival
// ════════════════════════════════════════════════════════════════════

const SUFFIX_CASES = [
  ['_small', `${CDN}_small.jpg?v=123`, `${CDN}.jpg?v=123`],
  ['_medium', `${CDN}_medium.jpg?v=123`, `${CDN}.jpg?v=123`],
  ['_large', `${CDN}_large.jpg?v=123`, `${CDN}.jpg?v=123`],
  ['_grande', `${CDN}_grande.png?v=123`, `${CDN}.png?v=123`],
  ['_1024x1024', `${CDN}_1024x1024.jpg?v=123`, `${CDN}.jpg?v=123`],
  ['_800x', `${CDN}_800x.webp?v=123`, `${CDN}.webp?v=123`],
  ['_x600', `${CDN}_x600.jpg?v=123`, `${CDN}.jpg?v=123`]
];

for (const [name, input, expected] of SUFFIX_CASES) {
  const r = upgradeImageUrl(input);
  check(
    `B size suffix ${name} stripped, ?v= survives`,
    r.upgraded === true && r.url === expected,
    `got ${r.url}`
  );
}

{
  // Explicit query-string survival with multiple params (width is a resize
  // key and is dropped; v must survive).
  const r = upgradeImageUrl(`${CDN}_small.jpg?width=200&v=123&format=webp`);
  check(
    'B query: width dropped, v + format kept after suffix strip',
    r.upgraded === true &&
      r.url === `${CDN}.jpg?v=123&format=webp`,
    r.url
  );
}

// ════════════════════════════════════════════════════════════════════
// C. Non-Shopify + no-suffix → UNCHANGED
// ════════════════════════════════════════════════════════════════════

const UNCHANGED = [
  'https://images.example.com/products/hero.jpg',
  'https://cdn.cloudinary.com/demo/image/upload/v1/sample.jpg',
  'https://img.example.org/a/b/c_notasize.jpg?x=1',
  'https://static.mystore.com/media/product-photo.jpg',
  'https://images.unsplash.com/photo-123?w=800',
  // Non-Shopify host with a filename that LOOKS like a Shopify size token —
  // must NOT be stripped (host gate). Revert-prove M3 keys on this.
  'https://images.example.com/products/photo_small.jpg?v=1',
  'https://cdn.cloudinary.com/demo/image/upload/shirt_1024x1024.png',
  'https://static.mystore.com/media/hero_large.jpg',
  // Shopify CDN but NO size suffix
  `${CDN}.jpg?v=1`,
  'https://www.marinelayer.com/cdn/shop/files/Already-Original.jpg?v=9'
];

for (const u of UNCHANGED) {
  const r = upgradeImageUrl(u);
  check(
    `C unchanged: ${u.slice(0, 60)}${u.length > 60 ? '…' : ''}`,
    r.upgraded === false && r.url === u,
    `upgraded=${r.upgraded} url=${r.url}`
  );
}

// Garbage / relative — also unchanged, no throw
for (const u of [null, '', 'not a url', '/cdn/shop/files/photo_small.jpg', 42]) {
  let threw = false;
  let r;
  try {
    r = upgradeImageUrl(u);
  } catch (e) {
    threw = true;
  }
  check(
    `C garbage/relative unchanged no-throw (${JSON.stringify(u)})`,
    !threw && r && r.upgraded === false && r.url === u,
    threw ? 'threw' : JSON.stringify(r)
  );
}

// ════════════════════════════════════════════════════════════════════
// D. additionalImages: multi-image, feed order, capped at shared const
// ════════════════════════════════════════════════════════════════════

async function runAsync() {
  // D1 — pure products.js payload → map via shared cap
  const nImages = MAX_ADDITIONAL_IMAGES + 5; // exceed cap
  const ajaxImages = Array.from({ length: nImages }, (_, i) => ({
    src: `https://cdn.shopify.com/s/files/1/x/y/img-${i}.jpg?v=1`
  }));
  const fromAjax = imagesFromShopifyProductPayload({
    handle: ML_HANDLE,
    id: 12345,
    images: ajaxImages
  });
  check(
    'D1 products.js payload: hero is feed[0]',
    fromAjax.imageUrl === ajaxImages[0].src,
    fromAjax.imageUrl
  );
  check(
    'D1b additionalImages length === MAX_ADDITIONAL_IMAGES (reads const)',
    fromAjax.additionalImages.length === MAX_ADDITIONAL_IMAGES,
    `got ${fromAjax.additionalImages.length}, const=${MAX_ADDITIONAL_IMAGES}`
  );
  check(
    'D1c feed order preserved: additionalImages[0] is feed[1]',
    fromAjax.additionalImages[0] === ajaxImages[1].src,
    fromAjax.additionalImages[0]
  );
  check(
    'D1d feed order preserved: last alt is feed[MAX_ADDITIONAL_IMAGES]',
    fromAjax.additionalImages[MAX_ADDITIONAL_IMAGES - 1] ===
      ajaxImages[MAX_ADDITIONAL_IMAGES].src,
    fromAjax.additionalImages[MAX_ADDITIONAL_IMAGES - 1]
  );
  check(
    'D1e hero never duplicated into additionalImages',
    !fromAjax.additionalImages.includes(fromAjax.imageUrl),
    'hero present in alts'
  );

  // D2 — imagesFromNode with multi-image JSON-LD also respects the const
  const ldImages = Array.from(
    { length: nImages },
    (_, i) => `https://cdn.example.com/p/img-${i}.jpg`
  );
  const fromLd = await imagesFromNode(
    { image: ldImages },
    'https://example.com/products/foo'
  );
  check(
    'D2 imagesFromNode multi-image: alts capped at MAX_ADDITIONAL_IMAGES',
    fromLd.additionalImages.length === MAX_ADDITIONAL_IMAGES,
    `got ${fromLd.additionalImages.length}`
  );
  check(
    'D2b imagesFromNode feed order: alt[0] = feed[1]',
    fromLd.additionalImages[0] === ldImages[1],
    fromLd.additionalImages[0]
  );

  // D3 — prove the cap is the SHARED constant: the slice end is
  // `1 + MAX_ADDITIONAL_IMAGES`. If someone hardcodes 12/20, this still
  // passes when the const happens to equal that number — so we also assert
  // the module export is a finite integer ≥ 1 and that both paths agree.
  check(
    'D3 MAX_ADDITIONAL_IMAGES is a finite integer ≥ 1',
    Number.isFinite(MAX_ADDITIONAL_IMAGES) && MAX_ADDITIONAL_IMAGES >= 1,
    String(MAX_ADDITIONAL_IMAGES)
  );
  check(
    'D3b products.js path and imagesFromNode path agree on cap',
    fromAjax.additionalImages.length === fromLd.additionalImages.length,
    `ajax=${fromAjax.additionalImages.length} ld=${fromLd.additionalImages.length}`
  );

  // ══════════════════════════════════════════════════════════════════
  // E. Failure of full-res path → keep original (never worse)
  // ══════════════════════════════════════════════════════════════════

  {
    const original = `${CDN}_large.jpg?v=1`;
    const upgraded = `${CDN}.jpg?v=1`;
    // Pure path WOULD strip — so resolve is the guard.
    check(
      'E0 pure upgrade would strip _large (guard is resolve, not strip)',
      upgradeImageUrl(original).url === upgraded,
      upgradeImageUrl(original).url
    );
    const out404 = await resolveUpgradedImageUrl(original, {
      fetchHead: async () => 404
    });
    check(
      'E1 HEAD 404 → keep ORIGINAL thumbnail',
      out404 === original,
      out404
    );
    const outErr = await resolveUpgradedImageUrl(original, {
      fetchHead: async () => {
        throw new Error('ECONNRESET');
      }
    });
    check(
      'E2 network error → keep ORIGINAL',
      outErr === original,
      outErr
    );
    const outNoHead = await resolveUpgradedImageUrl(original, {});
    check(
      'E3 no fetchHead → keep ORIGINAL (fail safe)',
      outNoHead === original,
      outNoHead
    );
    const outOk = await resolveUpgradedImageUrl(ML_SMALL, {
      fetchHead: async (url) => {
        check('E4a HEAD target is upgraded URL', url === ML_ORIGINAL, url);
        return 200;
      }
    });
    check(
      'E4 HEAD 200 → keep UPGRADED url',
      outOk === ML_ORIGINAL,
      outOk
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // F. products.js gallery enrichment (the multi-image half of Lane Q)
  // ══════════════════════════════════════════════════════════════════

  check(
    'F0 extractShopifyProductHandle from PDP URL',
    extractShopifyProductHandle(ML_PAGE) === ML_HANDLE,
    extractShopifyProductHandle(ML_PAGE)
  );
  check(
    'F0b extract handle under /collections/x/products/h',
    extractShopifyProductHandle(
      'https://store.example.com/collections/denim/products/foo-bar'
    ) === 'foo-bar',
    extractShopifyProductHandle(
      'https://store.example.com/collections/denim/products/foo-bar'
    )
  );
  check(
    'F0c non-product URL → null handle',
    extractShopifyProductHandle('https://store.example.com/pages/about') === null,
    'expected null'
  );
  check(
    'F0d /products.json is not a handle',
    extractShopifyProductHandle('https://store.example.com/products.json') === null,
    extractShopifyProductHandle('https://store.example.com/products.json')
  );

  // Measured bug shape: 1-element JSON-LD `_small` array.
  const thinNode = {
    '@type': 'Product',
    name: 'Riley Denim Barn Jacket',
    sku: '11822',
    image: [ML_SMALL],
    offers: { price: '198.00', priceCurrency: 'USD' }
  };

  // Without fetchShopifyProduct → still upgrades via upgradeRun, but
  // additionalImages stays empty (the JSON-LD-only shape).
  const upgradeRun = createImageUpgradeRun({ fetchHead: async () => 200 });
  const thinOnly = await imagesFromNode(thinNode, ML_PAGE, { upgradeRun });
  check(
    'F1 thin JSON-LD alone: hero upgraded to full-res',
    thinOnly.imageUrl === ML_ORIGINAL,
    thinOnly.imageUrl
  );
  check(
    'F1b thin JSON-LD alone: additionalImages still empty (1-element source)',
    Array.isArray(thinOnly.additionalImages) && thinOnly.additionalImages.length === 0,
    JSON.stringify(thinOnly.additionalImages)
  );

  // With products.js payload (6 full-res images, measured shape) → alts fill.
  const SIX = Array.from({ length: 6 }, (_, i) => ({
    src: `https://www.marinelayer.com/cdn/shop/files/Riley-${i}.jpg?v=1`
  }));
  const ajaxPayload = {
    id: 11822,
    handle: ML_HANDLE,
    title: 'Riley Denim Barn Jacket',
    images: SIX
  };

  check(
    'F2 shouldEnrichShopifyGallery true for thin _small hero',
    shouldEnrichShopifyGallery(ML_PAGE, {
      imageUrl: ML_SMALL,
      additionalImages: []
    }) === true,
    'expected true'
  );
  check(
    'F2b shouldEnrich false for non-product URL',
    shouldEnrichShopifyGallery('https://example.com/p/1', {
      imageUrl: ML_SMALL,
      additionalImages: []
    }) === false,
    'expected false'
  );

  let fetchCalls = 0;
  const enriched = await tryShopifyProductGallery(
    ML_PAGE,
    { imageUrl: ML_SMALL, additionalImages: [] },
    {
      fetchShopifyProduct: async (handle, pageUrl) => {
        fetchCalls += 1;
        check('F3a fetch receives handle', handle === ML_HANDLE, handle);
        check('F3b fetch receives pageUrl', pageUrl === ML_PAGE, pageUrl);
        return ajaxPayload;
      },
      upgradeRun: createImageUpgradeRun({ fetchHead: async () => 200 })
    }
  );
  check('F3c fetchShopifyProduct was called', fetchCalls === 1, `calls=${fetchCalls}`);
  check(
    'F3d enriched hero is products.js feed[0] (full-res)',
    enriched.imageUrl === SIX[0].src,
    enriched.imageUrl
  );
  check(
    'F3e enriched additionalImages has 5 alts in feed order',
    enriched.additionalImages.length === 5 &&
      enriched.additionalImages[0] === SIX[1].src &&
      enriched.additionalImages[4] === SIX[5].src,
    JSON.stringify(enriched.additionalImages)
  );

  // mapJsonLdProduct end-to-end with injected fetch.
  const mapped = await mapJsonLdProduct(thinNode, ML_PAGE, null, {
    upgradeRun: createImageUpgradeRun({ fetchHead: async () => 200 }),
    fetchShopifyProduct: async () => ajaxPayload
  });
  check(
    'F4 mapJsonLdProduct: imageUrl from products.js gallery',
    mapped && mapped.imageUrl === SIX[0].src,
    mapped && mapped.imageUrl
  );
  check(
    'F4b mapJsonLdProduct: additionalImages non-empty (5 alts)',
    mapped && mapped.additionalImages.length === 5,
    mapped && mapped.additionalImages.length
  );
  check(
    'F4c mapJsonLdProduct: feed order alt[0]=img-1',
    mapped && mapped.additionalImages[0] === SIX[1].src,
    mapped && mapped.additionalImages[0]
  );

  // Failure of products.js → keep original (upgraded) seed, never drop.
  const fallback = await tryShopifyProductGallery(
    ML_PAGE,
    { imageUrl: ML_ORIGINAL, additionalImages: [] },
    {
      fetchShopifyProduct: async () => {
        throw new Error('HTTP 403');
      }
    }
  );
  check(
    'F5 products.js throw → keep original imageUrl',
    fallback.imageUrl === ML_ORIGINAL,
    fallback.imageUrl
  );
  check(
    'F5b products.js throw → additionalImages still [] (not null)',
    Array.isArray(fallback.additionalImages) && fallback.additionalImages.length === 0,
    JSON.stringify(fallback.additionalImages)
  );

  const fallbackNull = await tryShopifyProductGallery(
    ML_PAGE,
    { imageUrl: ML_SMALL, additionalImages: [] },
    { fetchShopifyProduct: async () => null }
  );
  check(
    'F6 products.js returns null → keep original _small (never worse)',
    fallbackNull.imageUrl === ML_SMALL,
    fallbackNull.imageUrl
  );

  // preferShopifyGallery pure preference
  check(
    'F7 preferShopifyGallery picks shopify when present',
    preferShopifyGallery(
      { imageUrl: ML_SMALL, additionalImages: [] },
      { imageUrl: SIX[0].src, additionalImages: [SIX[1].src] }
    ).imageUrl === SIX[0].src,
    'expected shopify hero'
  );
  check(
    'F7b preferShopifyGallery keeps json-ld when shopify empty',
    preferShopifyGallery(
      { imageUrl: ML_SMALL, additionalImages: [] },
      { imageUrl: null, additionalImages: [] }
    ).imageUrl === ML_SMALL,
    'expected json-ld hero'
  );

  // ── R1..R4: never-worse. F7 above asserts ONLY the hero, so it stays
  // green while every JSON-LD alt is wiped — it was green THROUGH the
  // regression these pin. Assert the whole shape, not just imageUrl.
  const RICH_JSONLD = {
    imageUrl: 'https://cdn.shopify.com/s/files/1/a1.jpg',
    additionalImages: [
      'https://cdn.shopify.com/s/files/1/a2.jpg',
      'https://cdn.shopify.com/s/files/1/a3.jpg'
    ]
  };
  const THIN_GALLERY = {
    imageUrl: 'https://cdn.shopify.com/s/files/1/only.jpg',
    additionalImages: []
  };
  const thinWin = preferShopifyGallery(RICH_JSONLD, THIN_GALLERY);
  check(
    'R1 a THINNER shopify gallery must NOT replace a richer json-ld list',
    thinWin.imageUrl === RICH_JSONLD.imageUrl &&
      thinWin.additionalImages.length === 2,
    `alts wiped: got ${JSON.stringify(thinWin)}`
  );
  const RICHER = {
    imageUrl: 'https://cdn.shopify.com/s/files/1/b1.jpg',
    additionalImages: ['b2', 'b3', 'b4'].map(s => `https://cdn.shopify.com/s/files/1/${s}.jpg`)
  };
  const richWin = preferShopifyGallery(RICH_JSONLD, RICHER);
  check(
    'R2 a RICHER shopify gallery still wins (full-res multi-image)',
    richWin.imageUrl === RICHER.imageUrl && richWin.additionalImages.length === 3,
    `expected shopify gallery, got ${JSON.stringify(richWin)}`
  );

  // ── R3: non-Shopify hosts must not be probed. F8 uses a URL with no
  // /products/ segment at all, so it proves "no handle", not "not Shopify".
  check(
    'R3 non-Shopify host WITH /products/{handle} and a thin gallery → no fetch',
    shouldEnrichShopifyGallery(
      'https://furniture.example/products/oak-chair-2',
      { imageUrl: 'https://furniture.example/img/chair.jpg', additionalImages: [] }
    ) === false,
    'non-Shopify PDP would have paid .js + .json 404s'
  );
  check(
    'R3b same non-Shopify PDP DOES enrich when the platform fingerprint says shopify',
    shouldEnrichShopifyGallery(
      'https://furniture.example/products/oak-chair-2',
      { imageUrl: 'https://furniture.example/img/chair.jpg', additionalImages: [] },
      { platformIsShopify: true }
    ) === true,
    'platform evidence must still allow enrichment'
  );
  check(
    'R3c shopify-CDN thumbnail hero → enrich (the marinelayer shape)',
    shouldEnrichShopifyGallery('https://s.example/products/tee', {
      imageUrl: ML_SMALL,
      additionalImages: []
    }) === true,
    'expected enrichment on a Shopify CDN sized hero'
  );

  // ── R4: only http(s) may become a seed URL. A data:/javascript: src or an
  // unresolvable relative path must never be stored as a catalog image.
  const scheme = (src) =>
    imagesFromShopifyProductPayload({ images: [{ src }] }, 'https://shop.example/products/tee');
  check(
    'R4 javascript: src is dropped, not stored',
    scheme('javascript:alert(1)').imageUrl === null,
    'javascript: URL survived into the image list'
  );
  check(
    'R4b data: src is dropped, not stored',
    scheme('data:image/png;base64,AAAA').imageUrl === null,
    'data: URL survived into the image list'
  );
  check(
    'R4c relative src resolves against the PDP url',
    scheme('/cdn/shop/files/p.jpg').imageUrl === 'https://shop.example/cdn/shop/files/p.jpg',
    'relative path not absolutized'
  );
  check(
    'R4d protocol-relative src gets https',
    scheme('//cdn.shopify.com/p.jpg').imageUrl === 'https://cdn.shopify.com/p.jpg',
    'protocol-relative not absolutized'
  );

  // Non-Shopify multi-image JSON-LD must NOT be disturbed (no handle).
  const nonShopify = await mapJsonLdProduct(
    {
      '@type': 'Product',
      name: 'Chair',
      sku: 'CH-1',
      image: [
        'https://cdn.furniture.example/a.jpg',
        'https://cdn.furniture.example/b.jpg',
        'https://cdn.furniture.example/c.jpg'
      ],
      offers: { price: '499.00', priceCurrency: 'USD' }
    },
    'https://furniture.example/p/chair-1',
    null,
    {
      fetchShopifyProduct: async () => {
        throw new Error('must not be called for non-product URL');
      }
    }
  );
  check(
    'F8 non-Shopify multi-image: alts preserved, fetch not required',
    nonShopify &&
      nonShopify.imageUrl === 'https://cdn.furniture.example/a.jpg' &&
      nonShopify.additionalImages.length === 2 &&
      nonShopify.additionalImages[0] === 'https://cdn.furniture.example/b.jpg',
    nonShopify && JSON.stringify(nonShopify.additionalImages)
  );

  // Cap still applies when products.js returns a huge gallery.
  const huge = Array.from({ length: MAX_ADDITIONAL_IMAGES + 10 }, (_, i) => ({
    src: `https://cdn.shopify.com/s/files/1/x/y/huge-${i}.jpg`
  }));
  const hugeMapped = imagesFromShopifyProductPayload({ id: 1, images: huge });
  check(
    'F9 huge products.js gallery capped at MAX_ADDITIONAL_IMAGES',
    hugeMapped.additionalImages.length === MAX_ADDITIONAL_IMAGES,
    `got ${hugeMapped.additionalImages.length}, cap=${MAX_ADDITIONAL_IMAGES}`
  );

  // ── summary ──────────────────────────────────────────────────────
  const total = pass + fail;
  console.log(`\n${pass}/${total} checks passed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }

  // Revert-prove guide (printed always so the report has it):
  console.log(`
Revert-prove table (mutate → which check fails):
  M1 remove SHOPIFY_SIZE_RE replace in upgradeImageUrl     → A1, A2, B-*
  M2 drop query rebuild (return path-only URL)             → A1b, B query
  M3 strip size tokens on ANY host (drop isShopifyCdnUrl)  → C unchanged
  M4 hardcode slice(1, 13) instead of MAX_ADDITIONAL_IMAGES → D1b/D2/F9
       (only fails when const ≠ 12; also D3b path-agreement)
  M5 resolveUpgradedImageUrl accepts upgrade without HEAD  → E1, E2, E3
  M6 remove tryShopifyProductGallery from mapJsonLdProduct → F4, F4b
  M7 preferShopifyGallery always returns jsonLd            → F3d, F4, F7
`);

  process.exit(fail ? 1 : 0);
}

runAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
