// One-off recovery for Pelagic Gear 4 Demos, 2026-09-01.
//
// State BEFORE this script:
//   - Brand.apifyDemo.method = 'generic-sitemap' (wrong — pelagicgear.com
//     is Shopify, /products.json returns 250 per page cleanly)
//   - 48 catalog products synced (vs 750+ actually available)
//   - 9/48 heroes materialized
//   - 0/53 catalog Media had yoloDetectedAt stamped (yolo microservice
//     was in a WORKER TIMEOUT loop when the sync fired)
//
// This script:
//   1. Flips Brand.apifyDemo.method → 'shopify-direct'
//   2. Triggers a fresh Shopify catalog re-sync (fetches all products
//      via /products.json pagination); the post-sync orchestrator now
//      runs materialize + YOLO detect via runPostSyncChain automatically
//   3. Prints the before/after state so we can see the recovery landed
//
// Idempotent: re-running is safe. Method flip is a no-op if already
// 'shopify-direct'; syncBrandApify itself is idempotent per its own
// contract (upserts by shopify id + skips already-materialized Media).
//
// Usage:
//   node scripts/recoverPelagicGear.js [--dry-run]
//   node scripts/recoverPelagicGear.js --brand "Pelagic Gear 4 Demos"

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');

const DRY = process.argv.includes('--dry-run');
const brandName = (() => {
  const i = process.argv.indexOf('--brand');
  return i >= 0 ? process.argv[i + 1] : 'Pelagic Gear 4 Demos';
})();

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a'; }

async function snapshot(brandId) {
  const [total, withMedia, catalogMedia, materializedMedia, yoloStamped] = await Promise.all([
    CatalogProduct.countDocuments({ brandId, productUrl: { $nin: [null, ''] } }),
    CatalogProduct.countDocuments({ brandId, imageMediaId: { $ne: null } }),
    Media.countDocuments({ brandId, source: 'catalog-product' }),
    Media.countDocuments({ brandId, source: 'catalog-product', refinedProducts: { $exists: true, $ne: [] } }),
    Media.countDocuments({ brandId, source: 'catalog-product', yoloDetectedAt: { $ne: null } })
  ]);
  return { total, withMedia, catalogMedia, materializedMedia, yoloStamped };
}

function printSnap(label, s) {
  console.log(`\n── ${label} ──`);
  console.log(`  merchant-catalog products:  ${s.total}`);
  console.log(`  hero materialized:          ${s.withMedia} (${pct(s.withMedia, s.total)})`);
  console.log(`  Media (source=catalog):     ${s.catalogMedia}`);
  console.log(`  Media with refinedProducts: ${s.materializedMedia} (${pct(s.materializedMedia, s.catalogMedia)})`);
  console.log(`  yoloDetectedAt stamped:     ${s.yoloStamped} (${pct(s.yoloStamped, s.catalogMedia)})`);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const brand = await Brand.findOne({ name: brandName });
  if (!brand) throw new Error(`Brand "${brandName}" not found`);

  console.log(`\nBrand: ${brand.name} (${brand._id})`);
  console.log(`  advertiserId:         ${brand.advertiserId}`);
  console.log(`  websiteUrl:           ${brand.websiteUrl}`);
  console.log(`  apifyDemo.shopifyUrl: ${brand.apifyDemo?.shopifyUrl || null}`);
  console.log(`  apifyDemo.method:     ${brand.apifyDemo?.method || null}`);

  const before = await snapshot(brand._id);
  printSnap('BEFORE', before);

  if (DRY) {
    console.log('\n(dry-run — no changes made)');
    await mongoose.disconnect();
    return;
  }

  // ── Step 1: flip apifyDemo.method to shopify-direct ──
  if (brand.apifyDemo?.method !== 'shopify-direct') {
    console.log(`\n── Step 1: flipping apifyDemo.method '${brand.apifyDemo?.method}' → 'shopify-direct' ──`);
    // Direct set + save so this survives the strict-schema path any nested
    // set validator might apply. apifyDemo.shopifyUrl already present, so
    // resolveCatalogMethod() will resolve to shopify-direct on next sync.
    if (!brand.apifyDemo) brand.apifyDemo = {};
    brand.apifyDemo.method = 'shopify-direct';
    brand.markModified('apifyDemo');
    await brand.save();
    console.log('  ✓ method updated');
  } else {
    console.log('\n── Step 1: method already \'shopify-direct\' — skipping ──');
  }

  // ── Step 2: fresh catalog sync ──
  // syncBrandApify orchestrates the demo-brand sync; with method now set to
  // shopify-direct + shopifyUrl present, it routes through
  // shopifyPublicIngestService, which auto-fires the new post-sync
  // orchestrator (materialize + YOLO detect) as backgroundWork.
  //
  // skipInstagram: true → don't re-scrape IG posts (they're separately
  // tracked, and re-scraping is billable via the Apify actor). We only
  // want the catalog fix here.
  console.log('\n── Step 2: fresh Shopify catalog sync (skipInstagram=true) ──');
  const { syncBrandApify } = require('../services/apifyIngestService');
  const syncResult = await syncBrandApify(String(brand._id), { skipInstagram: true });
  console.log(`  method actually run:  ${syncResult.method}`);
  console.log(`  shopify summary:      ${JSON.stringify(syncResult.shopify || {}, null, 2).slice(0, 500)}`);

  // Await the backgroundWork queue explicitly here so the post-sync
  // orchestrator's materialize + YOLO detect finish before we snapshot
  // AFTER state. The route path fire-and-forgets these; this script
  // intentionally blocks so the operator sees the full result.
  const bg = syncResult.shopify?.backgroundWork || [];
  if (bg.length) {
    console.log(`\n── Step 3: awaiting ${bg.length} backgroundWork task(s) (materialize + YOLO detect etc.) ──`);
    const t0 = Date.now();
    await Promise.allSettled(bg);
    console.log(`  ✓ background work settled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.log('\n── Step 3: no backgroundWork queued (nothing to await) ──');
  }

  // ── Report AFTER state ──
  const after = await snapshot(brand._id);
  printSnap('AFTER', after);

  console.log('\n── Delta ──');
  console.log(`  products:                   ${before.total} → ${after.total} (${after.total - before.total > 0 ? '+' : ''}${after.total - before.total})`);
  console.log(`  hero materialized:          ${before.withMedia} → ${after.withMedia} (${after.withMedia - before.withMedia > 0 ? '+' : ''}${after.withMedia - before.withMedia})`);
  console.log(`  Media total:                ${before.catalogMedia} → ${after.catalogMedia} (${after.catalogMedia - before.catalogMedia > 0 ? '+' : ''}${after.catalogMedia - before.catalogMedia})`);
  console.log(`  refinedProducts populated:  ${before.materializedMedia} → ${after.materializedMedia} (${after.materializedMedia - before.materializedMedia > 0 ? '+' : ''}${after.materializedMedia - before.materializedMedia})`);
  console.log(`  yoloDetectedAt stamped:     ${before.yoloStamped} → ${after.yoloStamped} (${after.yoloStamped - before.yoloStamped > 0 ? '+' : ''}${after.yoloStamped - before.yoloStamped})`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error('\n❌ Recovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
