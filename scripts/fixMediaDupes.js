// Cleanup duplicate Media docs that share the same
// (brandId, source, externalId) tuple.
//
// Symptom: syncIndexes fails on Media with E11000 on the
// brandId_1_source_1_externalId_1 unique index because dupes exist.
// Once the dupes are gone, the index builds, and the existing
// E11000 handler in catalogProductDetectService.materializeImage
// catches future races.
//
// Strategy per dupe group:
//   - Pick a KEEPER: row with the most downstream references across
//     all artifact / catalog / ad / campaign collections. Tiebreak
//     by oldest createdAt (oldest had longest to accumulate refs).
//   - Reparent every reference from LOSERS → keeper. Where uniqueness
//     constraints would collide on reparent (DetectRun in-flight,
//     LayoutInputArtifact cache key, Comment external id), drop the
//     loser's row — the keeper's equivalent already exists.
//   - Delete the loser Media docs.
//
// Usage:
//   node scripts/fixMediaDupes.js                    # dry-run, all sources
//   node scripts/fixMediaDupes.js --apply            # destructive
//   node scripts/fixMediaDupes.js --source catalog-product
//   node scripts/fixMediaDupes.js --brand <brandId>
//   node scripts/fixMediaDupes.js --apply --source catalog-product

require('dotenv').config();
const mongoose = require('mongoose');

const Media                = require('../models/Media');
const Ad                   = require('../models/Ad');
const Campaign             = require('../models/Campaign');
const CatalogProduct       = require('../models/CatalogProduct');
const Comment              = require('../models/Comment');
const CropArtifact         = require('../models/CropArtifact');
const DetectionArtifact    = require('../models/DetectionArtifact');
const DetectRun            = require('../models/DetectRun');
const ExtendedCropArtifact = require('../models/ExtendedCropArtifact');
const LayoutInputArtifact  = require('../models/LayoutInputArtifact');
const OverlayZoneArtifact  = require('../models/OverlayZoneArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');

const args   = process.argv.slice(2);
const DRY    = !args.includes('--apply');
const SOURCE = pickArg('--source');
const BRAND  = pickArg('--brand');

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Count every reference to a given mediaId across the data model.
async function countRefs(id) {
  const counts = await Promise.all([
    Ad.countDocuments({ mediaId: id }),
    Ad.countDocuments({ rafflePrizeMediaId: id }),
    Campaign.countDocuments({ mediaIds: id }),
    CatalogProduct.countDocuments({ detectedFromMediaId: id }),
    CatalogProduct.countDocuments({ imageMediaId: id }),
    CatalogProduct.countDocuments({ additionalImageMediaIds: id }),
    CatalogProduct.countDocuments({ 'matchedMedia.mediaId': id }),
    Comment.countDocuments({ mediaId: id }),
    CropArtifact.countDocuments({ mediaId: id }),
    DetectionArtifact.countDocuments({ mediaId: id }),
    DetectRun.countDocuments({ mediaId: id }),
    ExtendedCropArtifact.countDocuments({ mediaId: id }),
    LayoutInputArtifact.countDocuments({ mediaId: id }),
    OverlayZoneArtifact.countDocuments({ mediaId: id }),
    ProductMatchArtifact.countDocuments({ mediaId: id })
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

// Reparent every reference to loserId so it points at keeperId.
// Collections with unique constraints involving mediaId need per-doc
// handling so we can drop loser-side rows that would collide.
async function reparent(loserId, keeperId) {
  // Simple field updates — no unique constraints on mediaId alone.
  await Ad.updateMany({ mediaId: loserId },           { $set: { mediaId: keeperId } });
  await Ad.updateMany({ rafflePrizeMediaId: loserId },{ $set: { rafflePrizeMediaId: keeperId } });
  await CatalogProduct.updateMany({ detectedFromMediaId: loserId }, { $set: { detectedFromMediaId: keeperId } });
  await CatalogProduct.updateMany({ imageMediaId: loserId },        { $set: { imageMediaId: keeperId } });
  await CropArtifact.updateMany({ mediaId: loserId },         { $set: { mediaId: keeperId } });
  await DetectionArtifact.updateMany({ mediaId: loserId },    { $set: { mediaId: keeperId } });
  await ExtendedCropArtifact.updateMany({ mediaId: loserId }, { $set: { mediaId: keeperId } });
  await OverlayZoneArtifact.updateMany({ mediaId: loserId },  { $set: { mediaId: keeperId } });
  await ProductMatchArtifact.updateMany({ mediaId: loserId }, { $set: { mediaId: keeperId } });

  // Array fields: capture which docs reference loser BEFORE pulling
  // so we can re-add the keeper to any doc that referenced the loser
  // but not the keeper. Two-pass because $pull + $addToSet on the
  // same path in one update isn't permitted.
  const campaignsWithLoser = await Campaign.find({ mediaIds: loserId }).select('_id mediaIds').lean();
  await Campaign.updateMany({ mediaIds: loserId }, { $pull: { mediaIds: loserId } });
  for (const c of campaignsWithLoser) {
    const hasKeeper = c.mediaIds.some(id => String(id) === String(keeperId));
    if (!hasKeeper) {
      await Campaign.updateOne({ _id: c._id }, { $addToSet: { mediaIds: keeperId } });
    }
  }

  const catalogsWithLoserAlt = await CatalogProduct.find({ additionalImageMediaIds: loserId }).select('_id additionalImageMediaIds').lean();
  await CatalogProduct.updateMany(
    { additionalImageMediaIds: loserId },
    { $pull: { additionalImageMediaIds: loserId } }
  );
  for (const c of catalogsWithLoserAlt) {
    const hasKeeper = c.additionalImageMediaIds.some(id => String(id) === String(keeperId));
    if (!hasKeeper) {
      await CatalogProduct.updateOne({ _id: c._id }, { $addToSet: { additionalImageMediaIds: keeperId } });
    }
  }
  // Reparent matchedMedia[].mediaId subdoc field. Same caveat as
  // Campaign: if the keeper is already present, $set on positional
  // operator would create a logical duplicate subdoc. Acceptable
  // for now — matchedMedia consumers dedupe by mediaId at read time.
  await CatalogProduct.updateMany(
    { 'matchedMedia.mediaId': loserId },
    { $set: { 'matchedMedia.$.mediaId': keeperId } }
  );

  // Constrained collections — per-doc with E11000 fallback.
  // DetectRun: partial unique on (mediaId) for in-flight statuses.
  // LayoutInputArtifact: unique on (mediaId,template,ratio,productId,
  //   variantKind,campaignContextHash,paletteSource).
  // Comment: unique on (mediaId, externalId).
  for (const Model of [DetectRun, LayoutInputArtifact, Comment]) {
    const docs = await Model.find({ mediaId: loserId });
    for (const d of docs) {
      try {
        d.mediaId = keeperId;
        await d.save();
      } catch (err) {
        if (err.code === 11000) {
          // Keeper already has an equivalent — drop the loser-side row.
          await Model.deleteOne({ _id: d._id });
        } else {
          throw err;
        }
      }
    }
  }
}

async function main() {
  const url = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!url) {
    console.error('No MONGO_URL / MONGO_URI / MONGODB_URI in env. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(url);
  console.log('─'.repeat(70));
  console.log('mode:', DRY ? 'DRY RUN (no writes)' : 'APPLY (destructive)');
  if (SOURCE) console.log('source filter:', SOURCE);
  if (BRAND)  console.log('brand filter:',  BRAND);
  console.log('─'.repeat(70));

  const match = {};
  if (SOURCE) match.source = SOURCE;
  if (BRAND && mongoose.Types.ObjectId.isValid(BRAND)) {
    match.brandId = new mongoose.Types.ObjectId(BRAND);
  }

  const groups = await Media.aggregate([
    { $match: match },
    { $group: {
        _id: { brandId: '$brandId', source: '$source', externalId: '$externalId' },
        count: { $sum: 1 },
        ids:        { $push: '$_id' },
        createdAts: { $push: '$createdAt' }
    }},
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ]);

  console.log(`\nFound ${groups.length} dupe group(s).`);
  if (!groups.length) {
    await mongoose.disconnect();
    return;
  }

  let totalLosersDeleted = 0;
  let totalRefsReparented = 0;
  let groupIdx = 0;

  for (const g of groups) {
    groupIdx++;
    const ids = g.ids;
    const refCounts = await Promise.all(ids.map(countRefs));

    // Pick keeper: most refs; tiebreak by oldest createdAt.
    let keeperIdx = 0;
    for (let i = 1; i < ids.length; i++) {
      const better =
        refCounts[i] > refCounts[keeperIdx] ||
        (refCounts[i] === refCounts[keeperIdx] && g.createdAts[i] < g.createdAts[keeperIdx]);
      if (better) keeperIdx = i;
    }
    const keeper = ids[keeperIdx];
    const losers = ids.filter((_, i) => i !== keeperIdx);
    const loserRefSum = ids.reduce((sum, _id, i) => i === keeperIdx ? sum : sum + refCounts[i], 0);

    console.log(
      `\n[${groupIdx}/${groups.length}] brand=${g._id.brandId} ` +
      `source=${g._id.source} extId=${g._id.externalId}`
    );
    ids.forEach((id, i) => {
      const tag = i === keeperIdx ? 'KEEP' : 'drop';
      console.log(`   ${tag}  ${id}  refs=${refCounts[i]}  createdAt=${g.createdAts[i]?.toISOString?.() || g.createdAts[i]}`);
    });

    if (!DRY) {
      for (const loser of losers) {
        await reparent(loser, keeper);
        await Media.deleteOne({ _id: loser });
        totalLosersDeleted++;
      }
      totalRefsReparented += loserRefSum;
    } else {
      totalLosersDeleted += losers.length;
      totalRefsReparented += loserRefSum;
    }
  }

  console.log('─'.repeat(70));
  console.log(
    `${DRY ? '[dry-run] would delete' : 'deleted'} ${totalLosersDeleted} loser Media doc(s) ` +
    `across ${groups.length} group(s); ` +
    `${DRY ? 'would reparent' : 'reparented'} ${totalRefsReparented} ref(s).`
  );

  if (!DRY) {
    console.log('\nAttempting Media.syncIndexes() to confirm the unique index can build…');
    try {
      await Media.syncIndexes();
      console.log('✅ Media.syncIndexes() succeeded — unique index brandId_1_source_1_externalId_1 is now in place.');
    } catch (err) {
      console.error('❌ syncIndexes still failing:', err.message);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
