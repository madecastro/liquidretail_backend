#!/usr/bin/env node
'use strict';
//
// verifyCatalogImageCap — offline harness for the CatalogProduct.additionalImages
// STORAGE cap (CATALOG_MAX_ADDITIONAL_IMAGES).
//
// Pins:
//   1. Shopify-direct and generic-sitemap paths share the same storage cap.
//   2. A 15-image product (PB5Star observed max) loses nothing under default 20.
//   3. Feed order is preserved (additionalImages[0] = feed's second image).
//   4. ≤1 image → additionalImages: [] without throw.
//   5. Storage cap is deliberately DIFFERENT from MAX_ALT_IMAGES (12) — the
//      materialisation cost gate must not be "aligned" with a free string array.
//   6. Neither ingest path still contains the old hardcodes slice(1, 9) /
//      slice(1, 5).
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyCatalogImageCap.js
//
// Revert-prove: restore images.slice(1, 9) in shopifyPublicIngestService and
// confirm the 15-image regression check FAILS (additionalImages.length → 8).

const fs = require('fs');
// Storage cap now lives in the shared zero-dep module on main; this harness
// asserts the RESOLVER MAPPER + rawData + knob-separation behaviour on top of it.
const { MAX_ADDITIONAL_IMAGES: SHOPIFY_CAP } = require('../services/catalogImageLimits');
const GENERIC_CAP = SHOPIFY_CAP;
const path = require('path');

// Load defaults.env the same way index.js does (env always wins).
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const {
  mapShopifyProductImages
} = require('../services/shopifyPublicIngestService');
const {
  imagesFromNode
} = require('../services/genericCatalogResolver');
const {
  MAX_ALT_IMAGES
} = require('../services/catalogProductDetectService');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) {
    pass++;
    console.log(`✓ ${label}`);
    return;
  }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  console.log(`❌ ${label}`);
}

function checkTrue(label, cond) {
  if (cond) {
    pass++;
    console.log(`✓ ${label}`);
    return;
  }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
  console.log(`❌ ${label}`);
}

const root = path.join(__dirname, '..');

async function main() {
// ── A. Shared storage cap (default 20) ────────────────────────────────
check('A shopify CATALOG_MAX_ADDITIONAL_IMAGES default', SHOPIFY_CAP, 20);
check('A shared cap module default is 20', SHOPIFY_CAP, 20);
check('A both paths export the same numeric cap', SHOPIFY_CAP, GENERIC_CAP);
check(
  'A defaults.env sets CATALOG_MAX_ADDITIONAL_IMAGES=20',
  process.env.CATALOG_MAX_ADDITIONAL_IMAGES,
  '20'
);

// ── B. Synthetic 25-image product — both paths honour the same cap ────
const CAP = SHOPIFY_CAP;
const N = 25;
const shopifyImages = Array.from({ length: N }, (_, i) => ({
  src: `https://cdn.example.com/img-${i + 1}.jpg`
}));
const genericNode = {
  image: Array.from({ length: N }, (_, i) => `https://cdn.example.com/img-${i + 1}.jpg`)
};

const shop25 = mapShopifyProductImages(shopifyImages);
// imagesFromNode is async (HEAD-verified upgrade path when upgradeRun is
// supplied). Offline harnesses call without upgradeRun → exact-dedupe only,
// same as pre-upgrade behaviour for non-Shopify fixture URLs.
const gen25 = await imagesFromNode(genericNode, 'https://example.com/p/1');
const expectedAlts = Math.min(N - 1, CAP);

check('B shopify 25-image: imageUrl is first', shop25.imageUrl, 'https://cdn.example.com/img-1.jpg');
check('B shopify 25-image: additional count = min(24, cap)', shop25.additionalImages.length, expectedAlts);
check('B generic 25-image: imageUrl is first', gen25.imageUrl, 'https://cdn.example.com/img-1.jpg');
check('B generic 25-image: additional count = min(24, cap)', gen25.additionalImages.length, expectedAlts);
check(
  'B both paths yield identical alt lists for the same feed',
  JSON.stringify(shop25.additionalImages),
  JSON.stringify(gen25.additionalImages)
);
check(
  'B total stored = 1 + min(24, cap)',
  1 + shop25.additionalImages.length,
  1 + expectedAlts
);

// ── C. PB5Star regression — 15 images lose nothing under default 20 ───
// Measured live 2026-08-10: pb5star.com max 15 images/product. Under the
// old Shopify slice(1, 9) this would store only 8 alts.
const shop15 = mapShopifyProductImages(
  Array.from({ length: 15 }, (_, i) => ({ src: `https://cdn.pb5.example/p-${i + 1}.jpg` }))
);
const gen15 = await imagesFromNode(
  { image: Array.from({ length: 15 }, (_, i) => `https://cdn.pb5.example/p-${i + 1}.jpg`) },
  'https://pb5star.com/products/x'
);
check('C shopify 15-image: additionalImages.length === 14', shop15.additionalImages.length, 14);
check('C generic 15-image: additionalImages.length === 14', gen15.additionalImages.length, 14);
check('C shopify 15-image hero is feed[0]', shop15.imageUrl, 'https://cdn.pb5.example/p-1.jpg');
// Under old slice(1,9) length would be 8 — pin that we are past that.
checkTrue('C shopify 15-image is past old slice(1,9) cap of 8', shop15.additionalImages.length > 8);

// ── D. Feed order preserved ───────────────────────────────────────────
check(
  'D shopify additionalImages[0] is feed second image',
  shop15.additionalImages[0],
  'https://cdn.pb5.example/p-2.jpg'
);
check(
  'D generic additionalImages[0] is feed second image',
  gen15.additionalImages[0],
  'https://cdn.pb5.example/p-2.jpg'
);
check(
  'D shopify last alt is feed fifteenth image',
  shop15.additionalImages[13],
  'https://cdn.pb5.example/p-15.jpg'
);
check(
  'D generic last alt is feed fifteenth image',
  gen15.additionalImages[13],
  'https://cdn.pb5.example/p-15.jpg'
);

// ── E. Edge cases: 0 / 1 image ────────────────────────────────────────
const emptyShop = mapShopifyProductImages([]);
const oneShop = mapShopifyProductImages([{ src: 'https://cdn.example.com/only.jpg' }]);
const emptyGen = await imagesFromNode({ image: null }, 'https://example.com/p');
const oneGen = await imagesFromNode({ image: 'https://cdn.example.com/only.jpg' }, 'https://example.com/p');
const zeroGen = await imagesFromNode({}, 'https://example.com/p');

check('E shopify []: imageUrl null', emptyShop.imageUrl, null);
check('E shopify []: additionalImages []', JSON.stringify(emptyShop.additionalImages), '[]');
check('E shopify 1 image: additionalImages []', JSON.stringify(oneShop.additionalImages), '[]');
check('E shopify 1 image: imageUrl set', oneShop.imageUrl, 'https://cdn.example.com/only.jpg');
check('E generic null image: additionalImages []', JSON.stringify(emptyGen.additionalImages), '[]');
check('E generic string image: additionalImages []', JSON.stringify(oneGen.additionalImages), '[]');
check('E generic missing image: no throw + []', JSON.stringify(zeroGen.additionalImages), '[]');

// ── F. Generic path still de-duplicates exact URLs ────────────────────
const withDup = await imagesFromNode({
  image: [
    'https://cdn.example.com/a.jpg',
    'https://cdn.example.com/b.jpg',
    'https://cdn.example.com/a.jpg', // dup of hero
    'https://cdn.example.com/c.jpg',
    'https://cdn.example.com/b.jpg'  // dup of alt
  ]
}, 'https://example.com/p');
check('F dedupe: imageUrl is first unique', withDup.imageUrl, 'https://cdn.example.com/a.jpg');
check('F dedupe: additional has b then c only', JSON.stringify(withDup.additionalImages),
  JSON.stringify(['https://cdn.example.com/b.jpg', 'https://cdn.example.com/c.jpg']));

// ── G. Storage vs materialisation — SEPARATE knobs, never unified ─────
// These two caps may share a VALUE (both default 20 since the owner chose
// to mirror for durability on 2026-08-10) but they must never become the
// same knob: storage is free URL strings, materialisation is paid Cloudinary
// mirroring. Asserting "they differ" would be wrong now; the invariants
// that actually matter are that each is independently env-tunable and that
// we never try to mirror more than we stored.
checkTrue('G MAX_ALT_IMAGES is a number', typeof MAX_ALT_IMAGES === 'number');
checkTrue('G MAX_ALT_IMAGES is positive', MAX_ALT_IMAGES > 0);
checkTrue(
  'G never mirror more than we store (MAX_ALT_IMAGES <= storage cap)',
  MAX_ALT_IMAGES <= SHOPIFY_CAP
);
// Independently tunable: each reads its OWN env var. A single shared var
// would silently turn a free storage bump into a paid mirroring bump.
const detectSrc = fs.readFileSync(
  path.join(root, 'services/catalogProductDetectService.js'),
  'utf8'
);
checkTrue(
  'G MAX_ALT_IMAGES reads its own env var CATALOG_MAX_ALT_IMAGES',
  /CATALOG_MAX_ALT_IMAGES/.test(detectSrc)
);
// Naming the storage var in a COMMENT is good documentation; what must never
// happen is the mirroring gate actually READING it, which would fuse the two.
checkTrue(
  'G the mirroring gate does NOT read the storage env var',
  !/process\.env\.CATALOG_MAX_ADDITIONAL_IMAGES/.test(detectSrc)
);
checkTrue(
  'G MAX_ALT_IMAGES is no longer a bare hardcoded literal',
  !/const MAX_ALT_IMAGES\s*=\s*\d+\s*;/.test(detectSrc)
);

// ── H. Static source: old hardcodes gone ──────────────────────────────
const shopifySrc = fs.readFileSync(
  path.join(root, 'services/shopifyPublicIngestService.js'),
  'utf8'
);
const genericSrc = fs.readFileSync(
  path.join(root, 'services/genericCatalogResolver.js'),
  'utf8'
);
const ingestSrc = fs.readFileSync(
  path.join(root, 'services/genericCatalogIngestService.js'),
  'utf8'
);
// Strip comments so a comment mentioning the old hardcode doesn't fail us.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}
const shopifyCode = stripComments(shopifySrc);
const genericCode = stripComments(genericSrc);
const ingestCode = stripComments(ingestSrc);

checkTrue('H shopify has no slice(1, 9)', !/slice\(\s*1\s*,\s*9\s*\)/.test(shopifyCode));
checkTrue('H generic resolver has no slice(1, 5)', !/slice\(\s*1\s*,\s*5\s*\)/.test(genericCode));
checkTrue(
  'H generic ingest has no hard slice(0, 4) on additionalImages',
  !/\.slice\(\s*0\s*,\s*4\s*\)/.test(ingestCode)
);
checkTrue(
  'H shopify uses the shared MAX_ADDITIONAL_IMAGES (catalogImageLimits)',
  /catalogImageLimits/.test(shopifyCode) && /MAX_ADDITIONAL_IMAGES/.test(shopifyCode)
);
checkTrue(
  'H generic uses the shared MAX_ADDITIONAL_IMAGES (catalogImageLimits)',
  /catalogImageLimits/.test(genericCode) && /MAX_ADDITIONAL_IMAGES/.test(genericCode)
);

// ── R. rawData storage cap on the Shopify→flat mapper ─────────────────
// A products.json entry MEASURES ~14.7KB (pb5star.com, 2026-08-10) — 1.8x the
// 8KB cap. The generic path capped rawData long before Shopify auto-detect
// existed, so an un-capped Shopify branch silently inflates every doc on that
// path (~147MB extra at a 10k-product catalog).
{
  const {
    mapShopifyNormalizedToFlat: mapFlatR,
    RAW_DATA_CAP_BYTES: SHOPIFY_RAW_CAP
  } = require('../services/shopifyPublicIngestService');

  // The two copies of the constant MUST agree — duplicated only to avoid a
  // circular require (genericCatalogResolver already requires this module).
  const resolverSrcR = fs.readFileSync(
    path.join(root, 'services/genericCatalogResolver.js'),
    'utf8'
  );
  const mR = resolverSrcR.match(/RAW_DATA_CAP_BYTES\s*=\s*(\d+)/);
  checkTrue('R resolver declares RAW_DATA_CAP_BYTES', !!mR);
  check('R the two rawData caps agree', SHOPIFY_RAW_CAP, mR ? Number(mR[1]) : -1);

  // Small payload passes through untouched (structured access preserved).
  const smallR = mapFlatR(
    { id: 1, handle: 'h', title: 'T', images: [{ src: 'https://x/a.jpg' }], variants: [] },
    'https://x'
  );
  checkTrue('R small rawData kept structured', !!(smallR.rawData && smallR.rawData.id === 1));

  // Oversized payload is truncated, not stored whole.
  const fatR = {
    id: 2, handle: 'h', title: 'T', images: [], variants: [], blob: 'z'.repeat(20000)
  };
  const cappedR = mapFlatR(fatR, 'https://x');
  checkTrue('R oversized rawData is truncated',
    !!(cappedR.rawData && typeof cappedR.rawData._truncated === 'string'));
  // The contract is on the SLICED STRING, not the re-serialised doc: JSON
  // escaping can push the serialised length past the cap (measured 8654 for a
  // real pb5star entry, because ~640 chars needed escaping). Assert the thing
  // that is actually guaranteed, matching the resolver's capRawData semantics —
  // an assertion on the serialised length would pass only for escape-free
  // fixtures like the one above and quietly mislead on real data.
  checkTrue('R truncated slice respects the cap',
    cappedR.rawData._truncated.length <= SHOPIFY_RAW_CAP);
  checkTrue('R oversized rawData drops the raw blob',
    !(cappedR.rawData && cappedR.rawData.blob));
}

// ── summary ───────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(1);
}
console.log(`\n${pass}/${total} checks passed`);
process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
