// Backfill brandId on existing artifact rows that pre-date the
// schema-hardening change. Reads each artifact's mediaId, looks up
// the parent Media's brandId, and copies it onto the artifact.
//
// Usage from the Render shell (or local with MONGODB_URI set):
//   node scripts/backfillArtifactBrandId.js
//   node scripts/backfillArtifactBrandId.js --dry-run
//
// Idempotent — only updates rows that have a null/missing brandId.
// Safe to re-run if the previous run was interrupted.

require('dotenv').config();
const mongoose = require('mongoose');

const Media = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const DetectionArtifact = require('../models/DetectionArtifact');
const CropArtifact = require('../models/CropArtifact');
const ExtendedCropArtifact = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact = require('../models/OverlayZoneArtifact');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');

const COLLECTIONS = [
  { name: 'DetectRun',            model: DetectRun },
  { name: 'DetectionArtifact',    model: DetectionArtifact },
  { name: 'CropArtifact',         model: CropArtifact },
  { name: 'ExtendedCropArtifact', model: ExtendedCropArtifact },
  { name: 'ProductMatchArtifact', model: ProductMatchArtifact },
  { name: 'OverlayZoneArtifact',  model: OverlayZoneArtifact },
  { name: 'LayoutInputArtifact',  model: LayoutInputArtifact }
];

const DRY_RUN = process.argv.includes('--dry-run');

(async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  console.log(`🔌 Connected to MongoDB${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Build a map of mediaId → brandId once. Cheap memory-wise even
  // for large media counts.
  const allMedia = await Media.find({}, { _id: 1, brandId: 1 }).lean();
  const brandByMedia = new Map();
  for (const m of allMedia) brandByMedia.set(String(m._id), m.brandId || null);
  console.log(`📦 Loaded ${allMedia.length} media → brand mappings`);

  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalOrphan  = 0;

  for (const { name, model } of COLLECTIONS) {
    const candidates = await model.find({
      $or: [{ brandId: null }, { brandId: { $exists: false } }]
    }, { _id: 1, mediaId: 1 }).lean();
    let updated = 0, skipped = 0, orphan = 0;
    for (const row of candidates) {
      const brandId = brandByMedia.get(String(row.mediaId));
      if (!brandId) { orphan++; continue; }
      if (!DRY_RUN) {
        await model.updateOne({ _id: row._id }, { $set: { brandId } });
      }
      updated++;
    }
    skipped = candidates.length - updated - orphan;
    console.log(`   · ${name.padEnd(24)} updated=${updated} orphan=${orphan} skipped=${skipped}`);
    totalUpdated += updated;
    totalOrphan  += orphan;
    totalSkipped += skipped;
  }

  console.log(`\n✓ Backfill ${DRY_RUN ? 'DRY RUN ' : ''}done — updated=${totalUpdated} orphan=${totalOrphan} skipped=${totalSkipped}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
