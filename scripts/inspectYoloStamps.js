// Dump the YOLO-related state for a set of Media docs so we can tell
// whether a "no YOLO subject bbox on media.refinedProducts[]" reframe
// fallback was caused by a permanent-fail stamp, a still-in-queue miss,
// or something else.
//
// Usage: node scripts/inspectYoloStamps.js <mediaId> [<mediaId> ...]

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Media = require('../models/Media');

const ids = process.argv.slice(2).filter(Boolean);
if (!ids.length) {
  console.error('Usage: node scripts/inspectYoloStamps.js <mediaId> [<mediaId> ...]');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const docs = await Media.find({ _id: { $in: ids } })
    .select('_id fileUrl source brandId metadata refinedProducts yoloProducts yoloDetectedAt yoloFailReason createdAt')
    .lean();

  const byId = new Map(docs.map((d) => [String(d._id), d]));

  for (const id of ids) {
    const d = byId.get(id);
    console.log(`\n── ${id} ──`);
    if (!d) { console.log('  NOT FOUND'); continue; }
    console.log(`  source:              ${d.source}`);
    console.log(`  brandId:             ${d.brandId}`);
    console.log(`  catalogProductId:    ${d.metadata?.catalogProductId || null}`);
    console.log(`  createdAt:           ${d.createdAt?.toISOString?.() || d.createdAt}`);
    console.log(`  fileUrl:             ${d.fileUrl}`);
    console.log(`  refinedProducts.len: ${Array.isArray(d.refinedProducts) ? d.refinedProducts.length : 0}`);
    if (Array.isArray(d.refinedProducts) && d.refinedProducts.length) {
      const r = d.refinedProducts[0];
      console.log(`  refined[0]:          source=${r.source} label=${r.label} conf=${r.confidence} bbox=(${r.x1},${r.y1})→(${r.x2},${r.y2})`);
    }
    console.log(`  yoloProducts.len:    ${Array.isArray(d.yoloProducts) ? d.yoloProducts.length : 0}`);
    console.log(`  yoloDetectedAt:      ${d.yoloDetectedAt?.toISOString?.() || d.yoloDetectedAt}`);
    console.log(`  yoloFailReason:      ${d.yoloFailReason ?? null}`);
    // Categorize
    let verdict;
    if (Array.isArray(d.refinedProducts) && d.refinedProducts.length) {
      verdict = 'REFINED (crop-first will work)';
    } else if (d.yoloFailReason) {
      verdict = `PERMANENT-FAIL (${d.yoloFailReason}) — needs un-stamp to re-queue`;
    } else if (d.yoloDetectedAt) {
      verdict = 'YOLO RAN, EMPTY REFINED (paid refine returned nothing; will not re-queue)';
    } else {
      verdict = 'PENDING (in backfill queue, awaiting next tick)';
    }
    console.log(`  → ${verdict}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
