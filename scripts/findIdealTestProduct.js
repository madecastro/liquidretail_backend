// Find a Vaportek product where EVERY Media has:
//   - fileUrl on res.cloudinary.com (mirror succeeded)
//   - width + height set (dims available for reframeStrategyChooser)
//   - refinedProducts[0].source === 'synthesized' (Grounding DINO fork)
//   - yoloDetectedAt set

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
  const brand = await Brand.findOne({ name: 'Pelagic Gear 4 Demos' }).lean();
  const products = await CatalogProduct.find({
    brandId: brand._id,
    title: { $regex: /vaportek/i },
    productUrl: { $nin: [null, ''] }
  }).select('_id title category imageMediaId additionalImageMediaIds').lean();

  console.log(`Scanning ${products.length} Vaportek products...\n`);
  const ideal = [];
  for (const p of products) {
    const ids = [p.imageMediaId, ...(p.additionalImageMediaIds || [])].filter(Boolean);
    const medias = await Media.find({ _id: { $in: ids } })
      .select('fileUrl width height refinedProducts yoloDetectedAt').lean();
    let cloudinary = 0, hasDims = 0, synthesized = 0, yoloStamped = 0;
    for (const m of medias) {
      if (m.fileUrl?.includes('res.cloudinary.com')) cloudinary++;
      if (m.width > 0 && m.height > 0) hasDims++;
      const r = m.refinedProducts?.[0];
      if (r?.source === 'synthesized') synthesized++;
      if (m.yoloDetectedAt) yoloStamped++;
    }
    const total = medias.length;
    const score = (cloudinary + hasDims + synthesized + yoloStamped) / (4 * total);
    ideal.push({
      p, total, cloudinary, hasDims, synthesized, yoloStamped, score
    });
  }
  ideal.sort((a, b) => b.score - a.score || b.total - a.total);

  console.log('title'.padEnd(38) + ' total  cloudinary  hasDims  synthesized  yoloAt  score  category');
  for (const r of ideal.slice(0, 15)) {
    console.log(
      `${r.p.title.padEnd(38)} ${String(r.total).padStart(5)}  ${String(r.cloudinary).padStart(10)}  ${String(r.hasDims).padStart(7)}  ${String(r.synthesized).padStart(11)}  ${String(r.yoloStamped).padStart(6)}  ${(r.score * 100).toFixed(0).padStart(3)}%  ${r.p.category || ''}`
    );
  }
  const best = ideal[0];
  console.log(`\nBest match: "${best.p.title}" (${best.p._id})  score=${(best.score * 100).toFixed(0)}%`);

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
