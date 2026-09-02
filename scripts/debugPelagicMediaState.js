// Deep debug for Pelagic Gear Media state after recovery run.
// Answers: why does the log say detected=195 but yoloDetectedAt stamped=7?

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const OperationRun = require('../models/OperationRun');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const brand = await Brand.findOne({ name: 'Pelagic Gear 4 Demos' });
  if (!brand) throw new Error('Brand not found');
  const brandId = brand._id;

  // Product-level state.
  const prods = await CatalogProduct.aggregate([
    { $match: { brandId, productUrl: { $nin: [null, ''] } } },
    { $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        withHero: { $sum: { $cond: [{ $ne: ['$imageMediaId', null] }, 1, 0] } },
        withAlts: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$additionalImageMediaIds', []] } }, 0] }, 1, 0] } },
        avgAltCount: { $avg: { $size: { $ifNull: ['$additionalImageMediaIds', []] } } },
        sumAltCount: { $sum: { $size: { $ifNull: ['$additionalImageMediaIds', []] } } }
    }}
  ]);
  console.log('\n── Product-level ──');
  console.log(prods[0] || 'no data');

  // Media-level state — break down refinedProducts by SOURCE.
  const media = await Media.aggregate([
    { $match: { brandId, source: 'catalog-product' } },
    { $project: {
        hasRefined: { $gt: [{ $size: { $ifNull: ['$refinedProducts', []] } }, 0] },
        firstRefinedSource: { $ifNull: [{ $arrayElemAt: ['$refinedProducts.source', 0] }, 'MISSING'] },
        hasYoloDetectedAt: { $ne: ['$yoloDetectedAt', null] },
        hasYoloFailReason: { $ne: [{ $ifNull: ['$yoloFailReason', null] }, null] },
        createdAt: 1
    }},
    { $group: {
        _id: {
          hasRefined: '$hasRefined',
          refinedSource: '$firstRefinedSource',
          hasYoloDetectedAt: '$hasYoloDetectedAt',
          hasYoloFailReason: '$hasYoloFailReason'
        },
        count: { $sum: 1 },
        recentCreated: { $max: '$createdAt' }
    }},
    { $sort: { count: -1 } }
  ]);
  console.log('\n── Media state buckets ──');
  for (const row of media) {
    console.log(`  refined=${row._id.hasRefined} source=${row._id.refinedSource} yoloAt=${row._id.hasYoloDetectedAt} failReason=${row._id.hasYoloFailReason} → ${row.count} media (most recent createdAt: ${row.recentCreated?.toISOString?.() || 'n/a'})`);
  }

  // Recent OperationRuns to see what the orchestrator actually did.
  const runs = await OperationRun.find({ brandId, kind: { $in: ['catalog-post-sync', 'yolo-detect', 'materialize'] } })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  console.log('\n── Recent OperationRuns ──');
  for (const r of runs) {
    console.log(`  ${r.kind.padEnd(20)} status=${r.status} ${r.progress || ''} ${r.startedAt?.toISOString?.() || ''} → ${r.updatedAt?.toISOString?.() || ''} meta=${JSON.stringify(r.meta || {}).slice(0, 200)}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
