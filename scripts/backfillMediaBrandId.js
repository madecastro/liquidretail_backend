// Backfill Media.brandId on catalog-product Media where the field is null,
// deriving from the referenced CatalogProduct.brandId.
//
// Root cause (2026-09-01): catalogMediaMaterializeService.ensureBrandCatalogMediaMaterialized's
// .select() projection dropped brandId, so materializeImage created Media
// docs with brandId=undefined → persisted as null. Every brand-scoped
// Media read (yoloBackfillTick, adReadinessService, reference stack) was
// invisible to those docs. Fix committed same day; this backfill recovers
// the historical rows.
//
// Idempotent: only touches Media where brandId is currently null. Safe to
// re-run.
//
// Usage:
//   node scripts/backfillMediaBrandId.js [--dry-run] [--brand "<Brand Name>"]
//   node scripts/backfillMediaBrandId.js --brandId <ObjectId>

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');

const DRY = process.argv.includes('--dry-run');
function pick(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const brandName = pick('--brand');
const brandIdArg = pick('--brandId');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  // Scope: single brand (targeted recovery) or global sweep.
  let scope = null;
  let brand = null;
  if (brandIdArg) {
    brand = await Brand.findById(brandIdArg).lean();
    scope = brand?._id || null;
  } else if (brandName) {
    brand = await Brand.findOne({ name: brandName }).lean();
    scope = brand?._id || null;
  }
  if ((brandName || brandIdArg) && !brand) {
    console.error(`Brand not found: ${brandName || brandIdArg}`);
    process.exit(1);
  }
  console.log(brand ? `Scope: Brand "${brand.name}" (${brand._id})` : 'Scope: ALL brands');

  // Find catalog-product Media with null/missing brandId that reference a
  // CatalogProduct via metadata.catalogProductId. The dot-notation lookup
  // is what lets us join to CatalogProduct.brandId.
  const filter = {
    source: 'catalog-product',
    $or: [{ brandId: null }, { brandId: { $exists: false } }],
    'metadata.catalogProductId': { $ne: null }
  };
  const totalOrphans = await Media.countDocuments(filter);
  console.log(`Orphan Media (brandId=null, catalog-product, has catalogProductId): ${totalOrphans}`);
  if (!totalOrphans) { await mongoose.disconnect(); return; }

  // Pull orphans in batches so a giant catalog doesn't OOM the process.
  const BATCH = 500;
  let fixed = 0;
  let skipped = 0;
  let noProduct = 0;
  let outOfScope = 0;
  let cursor = null;

  for (let processed = 0; processed < totalOrphans; processed += BATCH) {
    const query = { ...filter };
    if (cursor) query._id = { $gt: cursor };
    const batch = await Media.find(query).sort({ _id: 1 }).limit(BATCH)
      .select('_id metadata.catalogProductId').lean();
    if (!batch.length) break;
    cursor = batch[batch.length - 1]._id;

    // Group by catalogProductId to minimize CatalogProduct queries.
    const byProductId = new Map();
    for (const m of batch) {
      const pid = String(m.metadata.catalogProductId);
      if (!byProductId.has(pid)) byProductId.set(pid, []);
      byProductId.get(pid).push(m._id);
    }
    const products = await CatalogProduct.find({ _id: { $in: [...byProductId.keys()] } })
      .select('_id brandId').lean();
    const pidToBrand = new Map(products.map(p => [String(p._id), p.brandId]));

    for (const [pid, mediaIds] of byProductId.entries()) {
      const target = pidToBrand.get(pid);
      if (!target) { noProduct += mediaIds.length; continue; }
      if (scope && String(target) !== String(scope)) { outOfScope += mediaIds.length; continue; }
      if (DRY) { fixed += mediaIds.length; continue; }
      // Per-orphan update loop so a collision doesn't abort the whole
      // batch. On E11000 (there's a pre-existing Media with the same
      // (brandId, source, externalId)), the pre-existing doc has STALE
      // refinements (from Aug 31 cropRefine path) while the orphan has
      // TODAY's fresh Grounding DINO synthesized labels — the orphan is
      // the correct survivor. Delete the pre-existing collider, retry.
      // CatalogProduct.imageMediaId/additionalImageMediaIds already
      // point at the orphan (materialize updated those TODAY), so no
      // ref-swap is needed post-delete.
      for (const _id of mediaIds) {
        const orphan = await Media.findById(_id).select('_id source externalId').lean();
        if (!orphan) { skipped++; continue; }
        try {
          const res = await Media.updateOne({ _id }, { $set: { brandId: target } });
          fixed += res.modifiedCount || 0;
        } catch (err) {
          if (err.code !== 11000) throw err;
          const collider = await Media.findOne({
            brandId: target,
            source: orphan.source,
            externalId: orphan.externalId,
            _id: { $ne: _id }
          }).select('_id').lean();
          if (!collider) { skipped++; continue; }
          await Media.deleteOne({ _id: collider._id });
          const res = await Media.updateOne({ _id }, { $set: { brandId: target } });
          fixed += res.modifiedCount || 0;
        }
      }
    }
    console.log(`  ...processed ${Math.min(processed + BATCH, totalOrphans)}/${totalOrphans}: fixed=${fixed} noProduct=${noProduct} outOfScope=${outOfScope} skipped=${skipped}`);
  }

  console.log(`\n${DRY ? '(dry-run) ' : ''}Result: fixed=${fixed} noProduct=${noProduct} outOfScope=${outOfScope} skipped=${skipped}`);
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
