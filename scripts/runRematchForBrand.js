// Fire postRematchAfterCatalogService.rematchAfterCatalogDetect for one brand.
// Uses the NEW default (MIN_SHARED_TOKENS=2 + auto brand stopwords + universal
// stopwords) shipped alongside this script.
//
// Usage: node scripts/runRematchForBrand.js "<Brand Name>"
//    or: node scripts/runRematchForBrand.js --brandId <ObjectId>

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const CatalogProduct = require('../models/CatalogProduct');
const DetectRun = require('../models/DetectRun');

function pick(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const brandName = process.argv.slice(2).find((a) => !a.startsWith('--'));
const brandIdArg = pick('--brandId');
if (!brandName && !brandIdArg) {
  console.error('Usage: node scripts/runRematchForBrand.js "<Brand Name>"  OR  --brandId <ObjectId>');
  process.exit(1);
}

async function snapshot(brandId) {
  const [phantoms, unlinked, syncedProducts, pendingDetects] = await Promise.all([
    CatalogProduct.countDocuments({ brandId, source: 'detect-identified' }),
    ProductMatchArtifact.countDocuments({
      brandId, catalogProductId: null,
      outcome: { $in: ['product_match', 'product_category'] }
    }),
    CatalogProduct.countDocuments({ brandId, source: { $ne: 'detect-identified' }, draft: { $ne: true } }),
    DetectRun.countDocuments({
      status: { $in: ['queued', 'processing'] },
      trigger: 'manual-rematch'
    })
  ]);
  return { phantoms, unlinked, syncedProducts, pendingDetects };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const brand = brandIdArg
    ? await Brand.findById(brandIdArg).lean()
    : await Brand.findOne({ name: brandName }).lean();
  if (!brand) throw new Error(`Brand not found: ${brandName || brandIdArg}`);

  console.log(`\nBrand: ${brand.name} (${brand._id})`);
  const before = await snapshot(brand._id);
  console.log(`\n── BEFORE ──`);
  console.log(`  synced products:    ${before.syncedProducts}`);
  console.log(`  phantom products:   ${before.phantoms}`);
  console.log(`  unlinked PMAs:      ${before.unlinked}`);
  console.log(`  pending rematch DetectRuns: ${before.pendingDetects}`);

  console.log(`\n── Firing rematchAfterCatalogDetect (retro-link + paid vision on unmatched) ──`);
  const { rematchAfterCatalogDetect } = require('../services/postRematchAfterCatalogService');
  const t0 = Date.now();
  const result = await rematchAfterCatalogDetect({ brandId: String(brand._id) });
  console.log(`\n  ok:             ${result.ok}`);
  console.log(`  drained:        ${result.drained}`);
  console.log(`  retro.linked:   ${result.retro?.linked || 0}`);
  console.log(`  retro.twinCollapses: ${result.retro?.twinCollapses || 0}`);
  console.log(`  retro.twinArtifactsMoved: ${result.retro?.twinArtifactsMoved || 0}`);
  console.log(`  retro.rebuilt:  ${result.retro?.rebuilt || 0}`);
  console.log(`  candidates for paid re-detect: ${result.candidates || 0}`);
  console.log(`  enqueued for paid re-detect:   ${result.enqueued || 0}`);
  console.log(`  wall:           ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const after = await snapshot(brand._id);
  console.log(`\n── AFTER (immediately post-rematch call; paid DetectRuns still in flight) ──`);
  console.log(`  phantom products:   ${before.phantoms} → ${after.phantoms} (${after.phantoms - before.phantoms})`);
  console.log(`  unlinked PMAs:      ${before.unlinked} → ${after.unlinked} (${after.unlinked - before.unlinked})`);
  console.log(`  pending rematch DetectRuns: ${before.pendingDetects} → ${after.pendingDetects} (${after.pendingDetects - before.pendingDetects})`);

  await mongoose.disconnect();
})().catch((err) => { console.error(err); console.error(err.stack); process.exit(1); });
