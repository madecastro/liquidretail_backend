#!/usr/bin/env node
//
// backfillMediaClassification.js — Phase 0a backfill.
//
// Stamps Media.classification.socialPostType on every existing row that
// doesn't have one yet. Maps from the existing Media.source enum to the
// provenance enum:
//
//   media.source                       →  classification.socialPostType
//   ──────────────────────────────────────────────────────────────────
//   'instagram' / 'meta' / 'tiktok' /  →  'brand_produced'
//   'youtube'                              (current sync paths only pull from
//                                          the brand's own platform accounts;
//                                          no Media currently exists from
//                                          tagged/mentioned UGC sources)
//   'manual_upload'                    →  'manual_upload'
//   'other' / anything else            →  'other'
//
// detectSummary.outcome stays 'pending' (the default). A separate Phase 0b
// pass — once the matcher writes detectSummary at end of pipeline —
// rebuilds detectSummary on existing rows from their latest
// ProductMatchArtifact.
//
// Idempotent: skips Media docs that already have classification.socialPostType
// set to anything other than the schema default. Safe to re-run.
//
// Usage:
//   node scripts/backfillMediaClassification.js              # apply
//   node scripts/backfillMediaClassification.js --dry-run    # preview only
//   node scripts/backfillMediaClassification.js --brand "Pelagic Gear"   # narrow scope
//
// Exits 0 on success; non-zero on connection / write errors.

require('dotenv').config();
const mongoose = require('mongoose');

const Media = require('../models/Media');
const Brand = require('../models/Brand');

const SOURCE_TO_TYPE = {
  instagram:     'brand_produced',
  meta:          'brand_produced',
  tiktok:        'brand_produced',
  youtube:       'brand_produced',
  manual_upload: 'manual_upload'
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
  });

  const filter = {};
  if (args.brand) {
    const brand = await Brand.findOne({ name: new RegExp(`^${escapeRegex(args.brand)}$`, 'i') }).lean();
    if (!brand) {
      console.error(`Brand "${args.brand}" not found`);
      process.exit(1);
    }
    filter.brandId = brand._id;
    console.log(`Scoped to brand "${brand.name}" (${brand._id})`);
  }

  // Two backfill cases:
  //   1. classification field absent entirely (pre-Phase-0a docs)
  //   2. classification.socialPostType is the schema default ('other') and
  //      media.source implies a more specific type
  filter.$or = [
    { 'classification.socialPostType': { $exists: false } },
    { 'classification.socialPostType': 'other', source: { $in: Object.keys(SOURCE_TO_TYPE) } }
  ];

  const total = await Media.countDocuments(filter);
  console.log(`Found ${total} Media row(s) needing classification backfill${args.dryRun ? ' (DRY RUN)' : ''}`);

  if (total === 0) {
    await mongoose.disconnect();
    return;
  }

  const counts = { brand_produced: 0, manual_upload: 0, other: 0, skipped: 0, errors: 0 };

  // Iterate via cursor so we don't OOM on large collections.
  const cursor = Media.find(filter).cursor();
  let processed = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const target = SOURCE_TO_TYPE[doc.source] || 'other';

    if (args.dryRun) {
      counts[target] = (counts[target] || 0) + 1;
      processed++;
      continue;
    }

    try {
      await Media.updateOne(
        { _id: doc._id },
        { $set: { 'classification.socialPostType': target } }
      );
      counts[target] = (counts[target] || 0) + 1;
    } catch (err) {
      counts.errors++;
      console.warn(`   ⚠️  failed to update ${doc._id}: ${err.message}`);
    }
    processed++;
    if (processed % 100 === 0) console.log(`   · ${processed}/${total} processed`);
  }

  console.log(`\nDone. ${processed}/${total} processed.`);
  console.log(`   brand_produced: ${counts.brand_produced}`);
  console.log(`   manual_upload:  ${counts.manual_upload}`);
  console.log(`   other:          ${counts.other}`);
  if (counts.errors) console.log(`   errors:         ${counts.errors}`);

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
