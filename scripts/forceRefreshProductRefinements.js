// Force-refresh refinedProducts on a product's Media by clearing them
// and re-running mediaYoloRefine.detectYoloForMediaBatch. Bypasses the
// "already-refined" short-circuit in the normal path.
//
// Use case (2026-09-01): Media that got cropRefineService bboxes from
// the DetectRun worker BEFORE the mediaYoloRefine chain could run
// (race between enqueueBrandProductDetects and enqueueBrandProductYoloDetection).
// The bboxes are usable but the source is undefined and labels are
// generic COCO ("person", "object") instead of product titles from GD.
//
// Usage: node scripts/forceRefreshProductRefinements.js --productId <ObjectId> [--dry-run]

'use strict';
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const { detectYoloForMediaBatch } = require('../services/mediaYoloRefine');

function pick(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const productId = pick('--productId');
const DRY = process.argv.includes('--dry-run');
if (!productId) {
  console.error('Usage: node scripts/forceRefreshProductRefinements.js --productId <ObjectId> [--dry-run]');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const product = await CatalogProduct.findById(productId)
    .select('_id title brand category imageMediaId additionalImageMediaIds').lean();
  if (!product) throw new Error(`Product ${productId} not found`);

  const mediaIds = [product.imageMediaId, ...(product.additionalImageMediaIds || [])].filter(Boolean);
  console.log(`\nProduct: "${product.title}" (${product._id})`);
  console.log(`  Media to refresh: ${mediaIds.length}`);

  const before = await Media.find({ _id: { $in: mediaIds } })
    .select('_id metadata.imageRole metadata.feedIndex refinedProducts yoloDetectedAt').lean();
  const sourceBucket = new Map();
  for (const m of before) {
    const s = m.refinedProducts?.[0]?.source ?? 'empty';
    sourceBucket.set(s, (sourceBucket.get(s) || 0) + 1);
  }
  console.log('  Current refinedProducts source distribution:');
  for (const [s, n] of sourceBucket) console.log(`    ${String(s).padEnd(15)} ${n}`);

  if (DRY) {
    console.log('\n(dry-run — no changes)');
    await mongoose.disconnect();
    return;
  }

  // Step 1: wipe refinedProducts + yoloProducts + yoloDetectedAt on all
  // this product's Media. yoloFailReason is left alone — a "permanent"
  // marker should still keep the Media out of automatic retry queues.
  const wipe = await Media.updateMany(
    { _id: { $in: mediaIds } },
    { $set: { refinedProducts: [], yoloProducts: [], yoloDetectedAt: null } }
  );
  console.log(`\n  Wiped: matched=${wipe.matchedCount} modified=${wipe.modifiedCount}`);

  // Step 2: re-run mediaYoloRefine.detectYoloForMediaBatch. Load fresh
  // Media docs so the batch helper sees the wiped state.
  const wiped = await Media.find({ _id: { $in: mediaIds } }).lean();
  console.log(`  Running detectYoloForMediaBatch on ${wiped.length} Media...`);
  const t0 = Date.now();
  const results = await detectYoloForMediaBatch(wiped, { product, trigger: 'force-refresh' });
  const wall = Date.now() - t0;
  console.log(`  Done in ${(wall / 1000).toFixed(1)}s`);

  const outBucket = new Map();
  let ok = 0, failed = 0, skipped = 0;
  for (const r of results) {
    if (r.status === 'ok') { ok++; outBucket.set(r.path, (outBucket.get(r.path) || 0) + 1); }
    else if (r.status === 'failed') failed++;
    else if (r.status === 'skipped') skipped++;
  }
  console.log(`  Results: ok=${ok} failed=${failed} skipped=${skipped}`);
  for (const [p, n] of outBucket) console.log(`    path=${p}: ${n}`);

  // Post-verify: what does the DB look like now?
  const after = await Media.find({ _id: { $in: mediaIds } })
    .select('refinedProducts yoloDetectedAt').lean();
  const afterBucket = new Map();
  for (const m of after) {
    const s = m.refinedProducts?.[0]?.source ?? 'empty';
    afterBucket.set(s, (afterBucket.get(s) || 0) + 1);
  }
  console.log(`\n  After refinedProducts source distribution:`);
  for (const [s, n] of afterBucket) console.log(`    ${String(s).padEnd(15)} ${n}`);

  await mongoose.disconnect();
})().catch((err) => { console.error(err); console.error(err.stack); process.exit(1); });
