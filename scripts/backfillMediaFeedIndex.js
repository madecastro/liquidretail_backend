#!/usr/bin/env node
//
// backfillMediaFeedIndex.js — added 2026-08-05, owner directive.
//
// Stamps Media.metadata.feedIndex on every existing catalog-product Media doc
// that doesn't have it yet, derived from the CatalogProduct doc that already
// points at it — no re-mirroring, no Cloudinary calls, no billable cost.
//
//   CatalogProduct.imageMediaId → feedIndex 0  (merchant feed's primary image)
//   each non-empty additionalImageMediaIds entry → 1, 2, 3 … in COMPACT feed
//   order (count of real entries seen — NOT the raw array index; see the
//   pairs-building comment below for why the two differ in production data)
//
// WHY THIS EXISTS: catalogProductDetectService now stamps feedIndex at
// ingest time (see enqueueProductDetect / materializeImage), but that only
// covers NEW materializations going forward. Every product detected before
// 2026-08-05 has Media docs with no feedIndex.
//
// The SEED (position 0) does not depend on this script — both seed cascades
// check CatalogProduct.imageMediaId first, which already exists on every
// detected product. What this script unlocks is the VIDEO REFERENCE ORDER:
// atlasVideoService.sortCatalogMediasForReferenceStack orders refs 1/2 by
// feedIndex ONLY, and unstamped media sorts last, so until this runs those
// two reference slots stay in their legacy createdAt order. It also makes
// tier 2 reachable for non-primary variants, which carry no imageMediaId.
// See CATALOG_FEED_ORDER_SEEDING in config/defaults.env.
//
// Idempotent: skips any Media doc whose metadata.feedIndex is already a
// number, and (deliberately) DOES stamp docs where the key exists but holds
// null — see the filter comment below, those are otherwise permanently stuck.
// Safe to re-run — a second run only touches rows a first run missed (e.g. a
// product ingested between runs, or a transient write error).
//
// Usage:
//   node scripts/backfillMediaFeedIndex.js              # apply
//   node scripts/backfillMediaFeedIndex.js --dry-run    # preview only
//   node scripts/backfillMediaFeedIndex.js --brand "Gymshark"   # narrow scope
//
// Exits 0 on success; non-zero on connection / write errors.

require('dotenv').config();
const mongoose = require('mongoose');

const CatalogProduct = require('../models/CatalogProduct');
const Media          = require('../models/Media');
const Brand          = require('../models/Brand');

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
  });

  const filter = {
    $or: [
      { imageMediaId: { $ne: null } },
      { additionalImageMediaIds: { $exists: true, $not: { $size: 0 } } }
    ]
  };
  if (args.brand) {
    const brand = await Brand.findOne({ name: new RegExp(`^${escapeRegex(args.brand)}$`, 'i') }).lean();
    if (!brand) {
      console.error(`Brand "${args.brand}" not found`);
      process.exit(1);
    }
    filter.brandId = brand._id;
    console.log(`Scoped to brand "${brand.name}" (${brand._id})`);
  }

  const total = await CatalogProduct.countDocuments(filter);
  console.log(`Found ${total} CatalogProduct row(s) to check${args.dryRun ? ' (DRY RUN)' : ''}`);

  if (total === 0) {
    await mongoose.disconnect();
    return;
  }

  const counts = { stamped: 0, alreadySet: 0, missingMedia: 0, errors: 0 };
  let processed = 0;

  const cursor = CatalogProduct.find(filter)
    .select('_id imageMediaId additionalImageMediaIds')
    .cursor();

  for (let product = await cursor.next(); product != null; product = await cursor.next()) {
    processed++;

    // [mediaId, feedIndex] pairs for this product — position 0 is the
    // primary, 1..N are the alts in stored (feed) order.
    //
    // COMPACT numbering (count of real entries seen), NOT the raw array
    // index. additionalImageMediaIds has TWO shapes in production:
    // enqueueProductDetect writes it compact (`enqueued.alts.map(...)`),
    // while materializeMissingAlts writes it INDEX-ALIGNED, leaving holes
    // where an alt url was empty or duplicated the hero. Using `i + 1` on an
    // index-aligned array would stamp feed positions that skip numbers and
    // disagree with what ingest stamps for the very same image.
    const pairs = [];
    if (product.imageMediaId) pairs.push([product.imageMediaId, 0]);
    let altPos = 0;
    for (const mediaId of (product.additionalImageMediaIds || [])) {
      if (!mediaId) continue;                      // hole — does not consume a position
      if (String(mediaId) === String(product.imageMediaId)) continue;  // hero dup
      altPos++;
      pairs.push([mediaId, altPos]);
    }

    for (const [mediaId, feedIndex] of pairs) {
      try {
        if (args.dryRun) {
          const existing = await Media.findById(mediaId).select('metadata.feedIndex').lean();
          if (!existing) { counts.missingMedia++; continue; }
          if (Number.isFinite(existing.metadata?.feedIndex)) counts.alreadySet++;
          else counts.stamped++;
          continue;
        }
        // $not:{$type:'number'} — NOT $exists:false. materializeImage writes
        // `feedIndex: feedIndex` into the metadata literal, and that default
        // is null, so a doc created without the param has the KEY PRESENT
        // with a null value. An $exists:false filter skips exactly those
        // docs — and null also fails the `feedIndex === 0` / `feedIndex: 0`
        // selection downstream, so they would be permanently stuck:
        // unstampable by this script and unselectable by the seed cascades.
        // Matching on "not a number" covers missing, null, and any junk
        // value, while still never overwriting a real stamped index.
        const result = await Media.updateOne(
          { _id: mediaId, 'metadata.feedIndex': { $not: { $type: 'number' } } },
          { $set: { 'metadata.feedIndex': feedIndex } }
        );
        if (result.matchedCount === 0) {
          // Either the Media doc doesn't exist, or it already has feedIndex —
          // distinguish for an accurate count.
          const existing = await Media.findById(mediaId).select('metadata.feedIndex').lean();
          if (!existing) counts.missingMedia++;
          else counts.alreadySet++;
        } else {
          counts.stamped++;
        }
      } catch (err) {
        counts.errors++;
        console.warn(`   ⚠️  failed to stamp feedIndex=${feedIndex} on Media ${mediaId}: ${err.message}`);
      }
    }

    if (processed % 200 === 0) console.log(`   · ${processed}/${total} products processed`);
  }

  console.log(`\nDone. ${processed}/${total} products processed.`);
  console.log(`   stamped:       ${counts.stamped}`);
  console.log(`   already set:   ${counts.alreadySet}`);
  console.log(`   missing media: ${counts.missingMedia}`);
  if (counts.errors) console.log(`   errors:        ${counts.errors}`);

  await mongoose.disconnect();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--dry-run') out.dryRun = true;
    else if (a === '--brand')   out.brand  = argv[++i];
  }
  return out;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

main().catch(err => {
  console.error('Error:', err);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
