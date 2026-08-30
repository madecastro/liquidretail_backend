// One-off backfill runner for the existing catalog Media gap.
//
// Usage:
//   node scripts/backfillCatalogYolo.js --brandId=6a889a16b31cf7b2214a75b9
//   node scripts/backfillCatalogYolo.js --all
//   node scripts/backfillCatalogYolo.js --brandId=<id> --limit=200
//
// Runs the same detectYoloForMedia primitive worker.js's backfill tick uses,
// but on the full set of catalog-product Media with empty refinedProducts[]
// for a given brand (or all brands). Safe to re-run; idempotent per-Media.
//
// The scheduled worker.js sweep drains at ~20 Media / 15 min (default).
// This script drains everything in one go, subject to yolo_microservice
// concurrency — useful when we know we want the gap closed now, e.g. right
// after this PR ships to close the 220-alt Soludos gap.

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Media = require('../models/Media');
const { detectYoloForMedia } = require('../services/mediaYoloRefine');

function parseArgs() {
  const args = { brandId: null, all: false, limit: null };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'brandId') args.brandId = v;
    else if (k === 'all') args.all = true;
    else if (k === 'limit') args.limit = Math.max(1, parseInt(v, 10) || 0) || null;
  }
  if (!args.brandId && !args.all) {
    console.error('Usage: node scripts/backfillCatalogYolo.js --brandId=<id> [--limit=N]');
    console.error('  or:  node scripts/backfillCatalogYolo.js --all [--limit=N]');
    process.exit(1);
  }
  return args;
}

(async () => {
  const args = parseArgs();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const query = {
    source: 'catalog-product',
    $or: [
      { refinedProducts: { $exists: false } },
      { refinedProducts: { $size: 0 } }
    ]
  };
  if (args.brandId) query.brandId = args.brandId;

  const cursor = Media.find(query)
    .sort({ createdAt: 1 })
    .limit(args.limit || 0)
    .cursor();

  console.log(`🎯 backfillCatalogYolo: scope=${args.brandId ? `brand=${args.brandId}` : 'ALL brands'} limit=${args.limit || 'none'}`);

  let ok = 0, failed = 0, skipped = 0, synthesized = 0, gptRefined = 0;
  const t0 = Date.now();
  let n = 0;
  for await (const media of cursor) {
    n++;
    try {
      const r = await detectYoloForMedia(media.toObject(), { trigger: 'backfill' });
      if (r.status === 'ok') {
        ok++;
        if (r.path === 'synthesized') synthesized++;
        else if (r.path === 'gpt-refine') gptRefined++;
      } else {
        skipped++;
      }
      if (n % 20 === 0) {
        const el = Math.round((Date.now() - t0) / 1000);
        console.log(`  ${n} media processed — ok=${ok} skipped=${skipped} failed=${failed} (${el}s)`);
      }
    } catch (err) {
      failed++;
      console.warn(`  ⚠️  ${media._id}: ${err.message}`);
    }
  }

  const el = Math.round((Date.now() - t0) / 1000);
  console.log(
    `\n🎯 backfillCatalogYolo done in ${el}s — ` +
    `n=${n} ok=${ok} (synthesized=${synthesized} gpt-refined=${gptRefined}) ` +
    `skipped=${skipped} failed=${failed}`
  );
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
