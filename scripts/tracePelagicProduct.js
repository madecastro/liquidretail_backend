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
  // Pick "Freespool" — the log showed several successful detected=5/5 for this title.
  const products = await CatalogProduct.find({ brandId: brand._id, title: 'Freespool' })
    .select('_id title imageMediaId additionalImageMediaIds').limit(3).lean();

  for (const p of products) {
    console.log(`\n── Product ${p._id}: "${p.title}" ──`);
    console.log(`  imageMediaId:            ${p.imageMediaId}`);
    console.log(`  additionalImageMediaIds: ${p.additionalImageMediaIds?.length || 0}`);
    const mediaIds = [p.imageMediaId, ...(p.additionalImageMediaIds || [])].filter(Boolean);
    const medias = await Media.find({ _id: { $in: mediaIds } })
      .select('_id refinedProducts yoloDetectedAt yoloFailReason createdAt metadata.imageRole fileUrl').lean();
    const byId = new Map(medias.map(m => [String(m._id), m]));
    for (const id of mediaIds) {
      const m = byId.get(String(id));
      if (!m) { console.log(`  ⚠️  Media ${id}: DOES NOT EXIST`); continue; }
      const refined = Array.isArray(m.refinedProducts) ? m.refinedProducts.length : 0;
      const firstSrc = refined > 0 ? (m.refinedProducts[0].source ?? 'MISSING') : '-';
      console.log(`  ${m.metadata?.imageRole || '?'} ${String(m._id)}: refined=${refined} src=${firstSrc} yoloAt=${m.yoloDetectedAt || null} failReason=${m.yoloFailReason || null} created=${m.createdAt?.toISOString?.().slice(0, 19)}`);
    }
  }
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
