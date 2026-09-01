'use strict';
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const brand = await Brand.findOne({ name: 'Pelagic Gear 4 Demos' });
  const brandId = brand._id;

  // Collect all Media IDs referenced by CatalogProduct (hero + alts).
  const products = await CatalogProduct.find({ brandId, productUrl: { $nin: [null, ''] } })
    .select('imageMediaId additionalImageMediaIds').lean();
  const referencedIds = new Set();
  let heroCount = 0;
  let altCount = 0;
  for (const p of products) {
    if (p.imageMediaId) { referencedIds.add(String(p.imageMediaId)); heroCount++; }
    for (const a of (p.additionalImageMediaIds || [])) {
      if (a) { referencedIds.add(String(a)); altCount++; }
    }
  }
  console.log(`\nCatalogProduct references: ${referencedIds.size} unique Media IDs (${heroCount} heroes + ${altCount} alts)`);

  // Query for those Media docs with three different filter approaches.
  const idArray = [...referencedIds];
  const byIdAny = await Media.countDocuments({ _id: { $in: idArray } });
  console.log(`Media docs matching those IDs (no other filter):     ${byIdAny}`);
  const byIdBrand = await Media.countDocuments({ _id: { $in: idArray }, brandId });
  console.log(`Media docs matching those IDs + brandId match:       ${byIdBrand}`);
  const byIdSource = await Media.countDocuments({ _id: { $in: idArray }, source: 'catalog-product' });
  console.log(`Media docs matching those IDs + source=catalog-prod: ${byIdSource}`);
  const byIdBoth = await Media.countDocuments({ _id: { $in: idArray }, brandId, source: 'catalog-product' });
  console.log(`Media docs matching those IDs + both filters:        ${byIdBoth}`);

  // Now count refined + yoloAt on the intersection.
  const refinedTrue = await Media.countDocuments({
    _id: { $in: idArray },
    brandId,
    source: 'catalog-product',
    'refinedProducts.0': { $exists: true }
  });
  const yoloStamped = await Media.countDocuments({
    _id: { $in: idArray },
    brandId,
    source: 'catalog-product',
    yoloDetectedAt: { $ne: null }
  });
  console.log(`\n  refined (via '.0' probe):                            ${refinedTrue}`);
  console.log(`  yoloDetectedAt stamped:                              ${yoloStamped}`);

  // Compare against the aggregate's finding of 7.
  const yoloStampedNoIdFilter = await Media.countDocuments({
    brandId, source: 'catalog-product',
    yoloDetectedAt: { $ne: null }
  });
  console.log(`  yoloDetectedAt stamped (no id filter, brand-wide):   ${yoloStampedNoIdFilter}`);

  // Sample one of the yoloAt'd Media the trace showed us to double-check.
  const sample = await Media.findById('6a96e70966649519a714569b').lean();
  console.log(`\n── Sample Media 6a96e70966649519a714569b ──`);
  console.log(`  brandId:         ${sample?.brandId}`);
  console.log(`  source:          ${sample?.source}`);
  console.log(`  yoloDetectedAt:  ${sample?.yoloDetectedAt}`);
  console.log(`  refinedProducts.length: ${sample?.refinedProducts?.length}`);
  console.log(`  brandId matches Brand._id? ${String(sample?.brandId) === String(brandId)}`);

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
