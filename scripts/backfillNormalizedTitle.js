// Backfill CatalogProduct.normalizedTitle on existing rows.
//
// The field is computed in the schema's pre-save hook + pre-findOneAndUpdate
// hook, but existing rows written before the hook was added need a one-shot
// population pass before the new matching logic in
// productMatchService.ensureCatalogProductForMatch can find them.
//
// Idempotent — safe to re-run. Skips rows where normalizedTitle is
// already set unless --force is passed.
//
// Usage:
//   node scripts/backfillNormalizedTitle.js                # all brands
//   node scripts/backfillNormalizedTitle.js --brand <id>   # one brand
//   node scripts/backfillNormalizedTitle.js --apply        # actually write
//   node scripts/backfillNormalizedTitle.js --force        # overwrite existing

require('dotenv').config();
const mongoose = require('mongoose');

const CatalogProduct = require('../models/CatalogProduct');
const { normalizeTitle } = require('../utils/titleNormalize');

const args = process.argv.slice(2);
const DRY   = !args.includes('--apply');
const FORCE = args.includes('--force');
const BRAND = pickArg('--brand');

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  const url = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!url) { console.error('No MONGO URL in env.'); process.exit(1); }
  await mongoose.connect(url);
  console.log('─'.repeat(70));
  console.log('mode:', DRY ? 'DRY RUN (no writes)' : 'APPLY');
  console.log('force overwrite:', FORCE);
  if (BRAND) console.log('brand filter:', BRAND);
  console.log('─'.repeat(70));

  const filter = {};
  if (BRAND && mongoose.Types.ObjectId.isValid(BRAND)) {
    filter.brandId = new mongoose.Types.ObjectId(BRAND);
  }
  if (!FORCE) {
    filter.$or = [
      { normalizedTitle: null },
      { normalizedTitle: { $exists: false } },
      { normalizedTitle: '' }
    ];
  }

  const total = await CatalogProduct.countDocuments(filter);
  console.log(`\nRows needing backfill: ${total}`);
  if (!total) { await mongoose.disconnect(); return; }

  const cursor = CatalogProduct.find(filter).select('_id title normalizedTitle').lean().cursor();
  let processed = 0;
  let updated = 0;
  let unchanged = 0;
  const bulk = [];

  for await (const doc of cursor) {
    const next = normalizeTitle(doc.title);
    processed++;
    if (next === (doc.normalizedTitle || null) || next === doc.normalizedTitle) {
      unchanged++;
      continue;
    }
    bulk.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { normalizedTitle: next } }
      }
    });
    updated++;
    if (!DRY && bulk.length >= 500) {
      await CatalogProduct.bulkWrite(bulk, { ordered: false });
      bulk.length = 0;
    }
    if (processed <= 5 || processed % 100 === 0) {
      console.log(`  [${processed}] ${doc._id}  "${(doc.title || '').slice(0, 60)}"  →  "${next}"`);
    }
  }

  if (!DRY && bulk.length) {
    await CatalogProduct.bulkWrite(bulk, { ordered: false });
  }

  console.log('─'.repeat(70));
  console.log(`processed=${processed}  ${DRY ? 'would-update' : 'updated'}=${updated}  unchanged=${unchanged}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
