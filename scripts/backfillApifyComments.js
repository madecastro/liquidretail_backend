// Backfill apify-ig Media rows with comment ingest via the same
// pullInstagramComments path the ingest hook now uses. Meant to fix
// the historical gap where apify-ig Media had 0% comment coverage
// (measured 2026-08-19: 0/159 across all brands).
//
// Runs one Apify comment pull per Media — costs actual credit
// (~$0.02 per post × up to 50 comments). ALWAYS previews first.
// The apifyIngestService already exports the batch primitive
// (syncBrandInstagramCommentsApify); this script just wraps a
// safety preview around it.
//
// Usage:
//   node scripts/backfillApifyComments.js --brand allbirds            # preview only
//   node scripts/backfillApifyComments.js --brand allbirds --run      # execute
//   node scripts/backfillApifyComments.js --all                       # preview across every brand
//   node scripts/backfillApifyComments.js --all --run                 # execute across every brand

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const Brand = require('../models/Brand');
const Media = require('../models/Media');
const Comment = require('../models/Comment');

const args = process.argv.slice(2);
function pick(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
function has(name)  { return args.indexOf(name) >= 0; }

const BRAND = pick('--brand');
const ALL   = has('--all');
const RUN   = has('--run');
const PER_UNIT_USD = Number(process.env.APIFY_COMMENTS_PER_UNIT_USD || 0.02);

if (!BRAND && !ALL) {
  console.error('Usage: node scripts/backfillApifyComments.js (--brand <name> | --all) [--run]');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  // Resolve brands
  let brands;
  if (BRAND) {
    const b = await Brand.findOne({ name: { $regex: new RegExp(BRAND, 'i') } })
      .select('_id name advertiserId').lean();
    if (!b) { console.error(`no brand matching "${BRAND}"`); await mongoose.disconnect(); process.exit(2); }
    brands = [b];
  } else {
    brands = await Brand.find({}).select('_id name advertiserId').lean();
  }

  console.log(`\nBackfilling apify-ig comments for ${brands.length} brand(s). RUN=${RUN}\n`);

  let grandTotalTargets = 0;
  let grandTotalUpserted = 0;

  for (const brand of brands) {
    // Media that need comments — apify-ig source, not deleted, has a
    // permalink, and no existing Comment rows yet.
    const targets = await Media.find({
      brandId: brand._id,
      source: 'apify-ig',
      deletedAt: null,
      'metadata.permalink': { $exists: true, $ne: null }
    }).select('_id metadata.permalink').lean();

    if (!targets.length) {
      console.log(`  ${brand.name.padEnd(30)} no apify-ig media`);
      continue;
    }

    // Skip Media that already have comments (idempotency guard — a
    // partial backfill can be resumed without double-billing).
    const withComments = await Comment.distinct('mediaId', {
      mediaId: { $in: targets.map(t => t._id) }
    });
    const withCommentsSet = new Set(withComments.map(String));
    const pending = targets.filter(t => !withCommentsSet.has(String(t._id)));

    const estCost = pending.length * PER_UNIT_USD;
    console.log(`  ${brand.name.padEnd(30)} media=${targets.length} pending=${pending.length} est=$${estCost.toFixed(2)}`);
    grandTotalTargets += pending.length;

    if (!RUN) continue;
    if (!pending.length) continue;

    const { syncBrandInstagramCommentsApify } = require('../services/apifyIngestService');
    // syncBrandInstagramCommentsApify processes ALL apify-ig media for the
    // brand (including ones that already have comments — those will
    // just no-op-upsert). For the initial backfill we accept that
    // small waste; a per-Media targeted API doesn't exist yet.
    const t0 = Date.now();
    const result = await syncBrandInstagramCommentsApify(brand._id, { concurrency: 2 });
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const totalUpserted = (result?.perMedia || []).reduce((a, m) => a + (m.upserted || 0), 0);
    grandTotalUpserted += totalUpserted;
    console.log(`    → done in ${wall}s: upserted=${totalUpserted} across ${result?.total || 0} media`);
  }

  console.log(`\ntotal pending across all brands: ${grandTotalTargets} media  (est ~$${(grandTotalTargets * PER_UNIT_USD).toFixed(2)})`);
  if (RUN) console.log(`total comments upserted: ${grandTotalUpserted}`);
  else     console.log(`preview only — pass --run to execute`);

  await mongoose.disconnect();
})().catch(err => { console.error('fatal:', err.message); process.exit(1); });
