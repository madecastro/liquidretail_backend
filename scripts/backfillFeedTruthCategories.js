#!/usr/bin/env node
//
// backfillFeedTruthCategories.js — added 2026-08-11, owner directive.
//
// Rewrites CatalogProduct.categoryRef to the feed-truth leaf derived
// from each row's own CatalogProduct.category string, matching the
// live catalogSyncService behaviour introduced with FEED_TRUTH_
// CATEGORIES=true.
//
// WHY THIS EXISTS: catalogSyncService now stamps categoryRef via
// resolveFeedCategoryRef for NEW syncs, but existing rows already
// carry either
//   (a) a 9-bucket coarse leaf ("Apparel"), or
//   (b) a GPT-4.1 brand-nav leaf from productMatchService
//       ("Mens > Tops > Performance Shirts")
// stamped BEFORE the policy change. Both are inferred, not merchant
// truth. Under the new policy the inferred paths only fill in when
// the ref is null, so existing rows STAY on the inferred leaf until a
// re-sync explicitly clears them. This script does the explicit
// rewrite in place.
//
// WHAT IT DOES:
//   • For every CatalogProduct with a non-empty `category` string,
//     computes the feed-truth Category leaf via resolveFeedCategoryRef.
//   • If it differs from the current categoryRef, updates the row and
//     removes it from the OLD Category's relatedProducts cache.
//   • Rows with no feed category are LEFT ALONE — inferred is still the
//     right answer for them.
//
// NOT DESTRUCTIVE OF INFERRED DATA:
//   • inferredBreadcrumb + inferredCategoryAt stay stamped so the
//     brand-nav breadcrumb remains available for CTAs.
//   • CatalogProduct.category (the raw feed string) is not touched.
//   • The old Category rows are NOT deleted — they may still be
//     referenced by Media.matchedCategories or by other products.
//     Cleanup of orphaned Category rows is a separate concern.
//
// Usage:
//   node scripts/backfillFeedTruthCategories.js                    # apply
//   node scripts/backfillFeedTruthCategories.js --dry-run          # preview only
//   node scripts/backfillFeedTruthCategories.js --brand "Gymshark" # narrow scope
//
// Idempotent: a second run only touches rows that drifted since the
// first (e.g. a product re-synced with a new feed category between runs).
//
// Exits 0 on success; non-zero on connection / write errors.

require('dotenv').config();
const mongoose = require('mongoose');

const CatalogProduct = require('../models/CatalogProduct');
const Category       = require('../models/Category');
const Brand          = require('../models/Brand');
const { resolveFeedCategoryRef } = require('../services/categoryClassifier');

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
  });

  // Only rows with a non-empty feed category — no feed string, no
  // feed truth. The inferred path stays authoritative for those.
  //
  // Uses $type:'string' + $ne:'' rather than the naive
  // { $ne: null, $ne: '' } — the latter is a JS object-literal trap
  // (the second $ne key overwrites the first at construction) and
  // silently lets null values through. Symptom in the first dry-run:
  // 35 rows reported "resolver returned empty" because null category
  // passed the filter and then bailed inside resolveFeedCategoryRef.
  const filter = {
    category: { $type: 'string', $ne: '' }
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
  console.log(`Found ${total} CatalogProduct row(s) with a feed category${args.dryRun ? ' (DRY RUN)' : ''}`);

  if (total === 0) {
    await mongoose.disconnect();
    return;
  }

  const counts = {
    backfilled:        0,   // categoryRef changed to feed-truth
    alreadyFeedTruth:  0,   // categoryRef already matched feed-truth
    resolverEmpty:     0,   // feedCategory resolved to no id (shouldn't happen for non-empty strings)
    errors:            0
  };
  // Sample of feed strings that resolver returned null for — helps
  // catch shape edge-cases (whitespace-only, ">>>", non-string). Cap
  // so a large brand doesn't flood the log.
  const resolverEmptySamples = [];
  const RESOLVER_EMPTY_SAMPLE_CAP = 10;
  let processed = 0;

  const cursor = CatalogProduct.find(filter)
    .select('_id brandId advertiserId category categoryRef')
    .cursor();

  for (let product = await cursor.next(); product != null; product = await cursor.next()) {
    processed++;

    try {
      const feedRef = await resolveFeedCategoryRef({
        brandId:      product.brandId,
        advertiserId: product.advertiserId || null,
        feedCategory: product.category
      });

      if (!feedRef?.categoryId) {
        // resolveFeedCategoryRef returns null on empty/invalid input;
        // shouldn't happen with the filter above but count for
        // accuracy AND log a sample so a real shape edge-case (e.g.
        // ">>>", whitespace-only) doesn't stay invisible.
        counts.resolverEmpty++;
        if (resolverEmptySamples.length < RESOLVER_EMPTY_SAMPLE_CAP) {
          resolverEmptySamples.push({ id: String(product._id), category: product.category });
        }
        continue;
      }

      const newRef = feedRef.categoryId;
      const oldRef = product.categoryRef;

      if (oldRef && String(oldRef) === String(newRef)) {
        counts.alreadyFeedTruth++;
        continue;
      }

      if (args.dryRun) {
        counts.backfilled++;
        continue;
      }

      await CatalogProduct.updateOne(
        { _id: product._id },
        { $set: { categoryRef: newRef } }
      );
      // Maintain the denormalized Category.relatedProducts cache — add
      // to the new leaf, remove from the old. Best-effort; a stale
      // cache is a display defect, not a data-integrity break.
      try {
        await Category.updateOne(
          { _id: newRef },
          { $addToSet: { relatedProducts: product._id }, $set: { lastSeenAt: new Date() } }
        );
        if (oldRef) {
          await Category.updateOne(
            { _id: oldRef },
            { $pull: { relatedProducts: product._id } }
          );
        }
      } catch (cacheErr) {
        console.warn(`   ⚠️  relatedProducts cache update failed for product ${product._id}: ${cacheErr.message}`);
      }
      counts.backfilled++;
    } catch (err) {
      counts.errors++;
      console.warn(`   ⚠️  backfill failed for product ${product._id}: ${err.message}`);
    }

    if (processed % 200 === 0) console.log(`   · ${processed}/${total} products processed`);
  }

  console.log(`\nDone. ${processed}/${total} products processed.`);
  console.log(`   backfilled to feed truth: ${counts.backfilled}${args.dryRun ? ' (would be)' : ''}`);
  console.log(`   already feed truth:       ${counts.alreadyFeedTruth}`);
  if (counts.resolverEmpty) {
    console.log(`   resolver returned empty:  ${counts.resolverEmpty}`);
    if (resolverEmptySamples.length) {
      console.log(`   sample offending values (up to ${RESOLVER_EMPTY_SAMPLE_CAP}):`);
      for (const s of resolverEmptySamples) {
        console.log(`     - ${s.id}  category=${JSON.stringify(s.category)}`);
      }
    }
  }
  if (counts.errors)        console.log(`   errors:                   ${counts.errors}`);

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
