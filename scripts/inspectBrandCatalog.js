// Inspect why a brand ended up with N products in the catalog after sync.
// Reads the Brand doc + counts CatalogProducts + optionally live-probes the
// Shopify products.json origin to see how many are actually published.
//
// Usage: node scripts/inspectBrandCatalog.js "Pelagic Gear 4 Demos"
//   or:  node scripts/inspectBrandCatalog.js --brandId <ObjectId>

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const axios = require('axios');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');

function pick(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const brandName = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || null;
const brandIdArg = pick('--brandId');
if (!brandName && !brandIdArg) {
  console.error('Usage: node scripts/inspectBrandCatalog.js "<Brand Name>"  OR  --brandId <ObjectId>');
  process.exit(1);
}

async function probeProductsJson(origin, pages = 3, pageSize = 250) {
  const results = [];
  for (let p = 1; p <= pages; p++) {
    const url = `${origin.replace(/\/+$/, '')}/products.json?limit=${pageSize}&page=${p}`;
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'liquidretail-catalog-inspect/1.0' },
        validateStatus: (s) => s >= 200 && s < 500
      });
      const products = Array.isArray(res.data?.products) ? res.data.products : null;
      results.push({
        page: p,
        status: res.status,
        contentType: res.headers['content-type'],
        productCount: products ? products.length : null,
        bytes: JSON.stringify(res.data || '').length,
        hint: products
          ? (products.length === 0 ? 'EMPTY (last page reached)' : `${products.length} products`)
          : (typeof res.data === 'string'
              ? `NON-JSON response (${res.data.slice(0, 60)}...)`
              : `unexpected shape (${Object.keys(res.data || {}).slice(0, 3).join(',')})`)
      });
      if (products && products.length === 0) break;
    } catch (err) {
      results.push({ page: p, error: err.message });
      break;
    }
  }
  return results;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const brand = brandIdArg
    ? await Brand.findById(brandIdArg).lean()
    : await Brand.findOne({ name: brandName }).lean();
  if (!brand) {
    console.error(`Brand not found: ${brandName || brandIdArg}`);
    process.exit(1);
  }

  console.log(`\n── Brand: ${brand.name} (${brand._id}) ──`);
  console.log(`  advertiserId:        ${brand.advertiserId}`);
  console.log(`  websiteUrl:          ${brand.websiteUrl || null}`);
  console.log(`  apifyDemo.shopifyUrl:${brand.apifyDemo?.shopifyUrl || null}`);
  console.log(`  apifyDemo.method:    ${brand.apifyDemo?.method || null}`);
  console.log(`  enrichmentSkipReason:${brand.enrichmentSkipReason || null}`);

  // ── DB counts ──
  const total = await CatalogProduct.countDocuments({ brandId: brand._id });
  const withImageMediaId = await CatalogProduct.countDocuments({ brandId: brand._id, imageMediaId: { $ne: null } });
  const withoutImageMediaId = await CatalogProduct.countDocuments({ brandId: brand._id, imageMediaId: null });
  const drafts = await CatalogProduct.countDocuments({ brandId: brand._id, draft: true });
  const deleted = await CatalogProduct.countDocuments({ brandId: brand._id, deletedAt: { $ne: null } });

  // Product provenance — separate merchant-catalog vs detect-discovered.
  const withProductUrl = await CatalogProduct.countDocuments({ brandId: brand._id, productUrl: { $nin: [null, ''] } });
  const withoutProductUrl = await CatalogProduct.countDocuments({ brandId: brand._id, productUrl: { $in: [null, ''] } });
  const withImageUrl = await CatalogProduct.countDocuments({ brandId: brand._id, imageUrl: { $nin: [null, ''] } });
  const withoutImageUrl = await CatalogProduct.countDocuments({ brandId: brand._id, imageUrl: { $in: [null, ''] } });

  console.log(`\n── CatalogProduct counts ──`);
  console.log(`  total:                     ${total}`);
  console.log(`  draft:                     ${drafts}`);
  console.log(`  soft-deleted:              ${deleted}`);
  console.log(`  hero materialized:         ${withImageMediaId}`);
  console.log(`  hero NOT materialized:     ${withoutImageMediaId}`);
  console.log(`  has productUrl:            ${withProductUrl}      ← merchant-catalog (from sync)`);
  console.log(`  no productUrl:             ${withoutProductUrl}      ← detect-discovered (from IG posts)`);
  console.log(`  has imageUrl:              ${withImageUrl}`);
  console.log(`  no imageUrl:               ${withoutImageUrl}`);

  // ── Media counts ──
  const mediaTotal = await Media.countDocuments({ brandId: brand._id, source: 'catalog-product' });
  const mediaRefined = await Media.countDocuments({
    brandId: brand._id,
    source: 'catalog-product',
    refinedProducts: { $exists: true, $ne: [] }
  });
  const mediaYoloDetected = await Media.countDocuments({
    brandId: brand._id,
    source: 'catalog-product',
    yoloDetectedAt: { $ne: null }
  });
  console.log(`\n── Media(source=catalog-product) counts ──`);
  console.log(`  total:                     ${mediaTotal}`);
  console.log(`  with refinedProducts:      ${mediaRefined}`);
  console.log(`  yoloDetectedAt stamped:    ${mediaYoloDetected}`);
  console.log(`  refined avg per product:   ${(mediaTotal / Math.max(1, withProductUrl)).toFixed(1)}`);

  // ── Live probe: what does the merchant's own products.json say ──
  const origin = brand.apifyDemo?.shopifyUrl || brand.websiteUrl;
  if (origin) {
    console.log(`\n── Live probe: ${origin}/products.json ──`);
    const pages = await probeProductsJson(origin);
    let liveTotal = 0;
    for (const p of pages) {
      console.log(`  page ${p.page}: ${p.error ? `ERROR ${p.error}` : `HTTP ${p.status} · ${p.hint}`}`);
      if (typeof p.productCount === 'number') liveTotal += p.productCount;
    }
    console.log(`  LIVE published product total (across probed pages): ${liveTotal}`);
    if (liveTotal !== withProductUrl && withProductUrl > 0) {
      const delta = liveTotal - withProductUrl;
      console.log(`  ⚠️  DELTA vs DB: ${delta > 0 ? '+' : ''}${delta} — ${delta > 0 ? 'merchant has more than we synced' : 'we have more than merchant currently publishes'}`);
    }
  } else {
    console.log(`\n── Live probe skipped: no shopifyUrl or websiteUrl on brand ──`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
