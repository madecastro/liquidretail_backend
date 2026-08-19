#!/usr/bin/env node
'use strict';
//
// backfillUnusableSeedImages.js
//
// One-time cleanup for CatalogProduct rows already corrupted by the bug
// fixed in services/productDetailsService.js / catalogProductDetectService.js
// (2026-08-18): a Google Shopping / Lens thumbnail (gstatic's encrypted-tbn
// CDN) got gap-filled into `imageUrl` and then mirrored into `imageMediaId`,
// making the row look generation-ready when it never had a usable photo.
//
// This script does NOT try to find a replacement image — it just clears the
// two fields back to their honest "no seed" state (null), which is exactly
// how a `shopify-direct` row with no synced image already looks. The picker
// then correctly renders it as unusable (services/catalogImageQuality.js →
// routes/catalog.js seedUnusable/seedIssue) instead of silently selectable.
//
// Live-DB scan 2026-08-18 (all brands, no filter beyond deletedAt:null):
// 91 rows affected, 90 `detect-identified` + 1 `ig-catalog`. Zero had any
// additionalImages/additionalImageMediaIds, so nothing else needs touching.
//
// DRY RUN BY DEFAULT. Prints the full list of rows and the exact change
// that WOULD be made to each; nothing is written unless --apply is passed.
//
// Usage (run from the backend repo root; MONGODB_URI must already be in env
// — this script does not fetch secrets itself, matching mintTestToken.js
// convention):
//   node scripts/backfillUnusableSeedImages.js                    # dry run, all brands
//   node scripts/backfillUnusableSeedImages.js --brand-id <id>    # scope to one brand
//   node scripts/backfillUnusableSeedImages.js --apply             # actually write
//   node scripts/backfillUnusableSeedImages.js --brand-id <id> --apply

const mongoose = require('mongoose');
const CatalogProduct = require('../models/CatalogProduct');
const { isUnusableThumbnailUrl } = require('../services/catalogImageQuality');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const brandIdx = args.indexOf('--brand-id');
  const brandId = brandIdx >= 0 ? args[brandIdx + 1] : null;

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in the environment. Source it first (see scripts/mintTestToken.js for the pattern this repo uses).');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const filter = { deletedAt: null };
    if (brandId) {
      if (!mongoose.isValidObjectId(brandId)) {
        console.error(`--brand-id "${brandId}" is not a valid ObjectId.`);
        process.exit(1);
      }
      filter.brandId = brandId;
    }

    const rows = await CatalogProduct
      .find(filter)
      .select('_id brandId title source imageUrl imageMediaId additionalImages additionalImageMediaIds')
      .lean();

    const affected = rows.filter(r => isUnusableThumbnailUrl(r.imageUrl));

    console.log(`Scanned ${rows.length} row(s)${brandId ? ` for brand ${brandId}` : ' across all brands'}.`);
    console.log(`${affected.length} row(s) have an unusable (Google Shopping/Lens thumbnail) imageUrl.\n`);

    if (!affected.length) {
      console.log('Nothing to do.');
      return;
    }

    // Defensive check, not expected to fire given the 2026-08-18 live scan
    // (none had alts) — if a future row DOES carry alts, flag it instead of
    // silently clearing something this script never inspected.
    const withAlts = affected.filter(r => (r.additionalImages || []).length > 0 || (r.additionalImageMediaIds || []).length > 0);
    if (withAlts.length) {
      console.log(`⚠️  ${withAlts.length} affected row(s) also carry additionalImages/additionalImageMediaIds — this script only touches the HERO fields (imageUrl/imageMediaId). Review these manually:`);
      for (const r of withAlts) console.log(`    ${r._id} "${r.title}"`);
      console.log('');
    }

    const bySource = {};
    for (const r of affected) bySource[r.source || '(none)'] = (bySource[r.source || '(none)'] || 0) + 1;
    console.log('By source:', bySource, '\n');

    console.log(`${apply ? 'APPLYING' : 'DRY RUN — would apply'} this change to each row below:`);
    console.log('  imageUrl: <gstatic thumbnail URL>  ->  null');
    console.log('  imageMediaId: <mirrored Media id, if any>  ->  null\n');

    let i = 0;
    for (const r of affected) {
      i++;
      console.log(`[${i}/${affected.length}] ${r._id} (brand ${r.brandId}, source=${r.source}) "${r.title}"`);
      console.log(`    imageUrl:     ${r.imageUrl}`);
      console.log(`    imageMediaId: ${r.imageMediaId || '(none)'}`);
      if (apply) {
        await CatalogProduct.updateOne(
          { _id: r._id },
          { $set: { imageUrl: null, imageMediaId: null } }
        );
      }
    }

    console.log(`\n${apply ? 'Applied' : 'Would apply'} to ${affected.length} row(s).`);
    if (!apply) console.log('Re-run with --apply to persist these changes.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
