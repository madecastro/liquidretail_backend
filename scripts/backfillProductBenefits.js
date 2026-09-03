#!/usr/bin/env node
'use strict';
/**
 * backfillProductBenefits — one-time catch-up for CatalogProduct rows
 * that predate ingest-time shortBenefits derivation.
 *
 * DRY-RUN BY DEFAULT. Nothing is billed unless you pass --apply.
 *
 * Idempotent: skips any product whose shortBenefits is already non-empty
 * OR whose shortBenefitsDerivedAt is set ("derived, genuinely nothing").
 * Re-running after a partial apply only touches what's still missing.
 *
 * Usage:
 *   node scripts/backfillProductBenefits.js
 *   node scripts/backfillProductBenefits.js --brand=<id>
 *   node scripts/backfillProductBenefits.js --limit=20
 *   node scripts/backfillProductBenefits.js --apply
 *   node scripts/backfillProductBenefits.js --apply --limit=50 --brand=<id>
 *
 * COST: gemini-2.5-flash via atlasLlmService, CostLog stage
 * `product_benefits`. Projected ~$0.002/product (see
 * productBenefitsService.PROJECTED_USD_PER_CALL). A 2171-product run
 * projects ~$4.34. Actual spend is printed at the end of --apply.
 */

require('dotenv').config();
require('dotenv').config({
  path: require('path').join(__dirname, '..', 'config', 'defaults.env'),
});

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const {
  isDerivationEnabled,
  missingBenefitsFilter,
  deriveForProducts,
  PROJECTED_USD_PER_CALL,
  DEFAULT_CONCURRENCY,
} = require('../services/productBenefitsService');

function parseArgs(argv) {
  const out = { apply: false, force: false, brand: null, limit: null, concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    // --force re-derives rows that are ALREADY stamped. Needed because the
    // stamp is terminal: missingBenefitsFilter excludes every stamped row, so
    // without this a product whose derivation came back malformed (or, before
    // the drop-not-slice fix, truncated) could never be repaired. Requires
    // --brand so a slip cannot re-bill the whole catalogue.
    if (a === '--force') { out.force = true; continue; }
    if (a === '--brand') { out.brand = argv[++i] || null; continue; }
    if (a.startsWith('--brand=')) { out.brand = a.slice('--brand='.length) || null; continue; }
    if (a === '--limit') { out.limit = parseInt(argv[++i], 10) || null; continue; }
    if (a.startsWith('--limit=')) { out.limit = parseInt(a.slice('--limit='.length), 10) || null; continue; }
    if (a === '--concurrency') { out.concurrency = parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY; continue; }
    if (a.startsWith('--concurrency=')) {
      out.concurrency = parseInt(a.slice('--concurrency='.length), 10) || DEFAULT_CONCURRENCY;
      continue;
    }
    console.error(`Unknown argument: ${a}`);
    process.exit(1);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — cannot run.');
    process.exit(1);
  }

  if (!isDerivationEnabled()) {
    console.error('PRODUCT_BENEFITS_DERIVATION is not strictly "true" — refusing to run (no spend).');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const filter = missingBenefitsFilter();
  if (opts.brand) {
    if (!mongoose.isValidObjectId(opts.brand)) {
      console.error(`--brand=${opts.brand} is not a valid ObjectId`);
      process.exit(1);
    }
    filter.brandId = new mongoose.Types.ObjectId(opts.brand);
  }

  // --force: re-derive rows that are already stamped. Implemented as an
  // explicit UNSTAMP of the selected rows rather than a bypass flag threaded
  // into the service, so productBenefitsService's own idempotence guards
  // (hasNonEmptyBenefits / alreadyAttempted) stay intact and there is no
  // "force" path through the money code. Brand-scoped on purpose: a slip
  // must not be able to re-bill the whole catalogue.
  if (opts.force) {
    if (!opts.brand) {
      console.error('--force requires --brand=<id> (refusing to unstamp the whole catalogue)');
      process.exit(1);
    }
    const forceFilter = { deletedAt: null, brandId: filter.brandId };
    const n = await CatalogProduct.countDocuments(forceFilter);
    if (!opts.apply) {
      console.log(`--force DRY-RUN: would unstamp + re-derive ${n} products for brand ${opts.brand}. Nothing was billed.`);
      process.exit(0);
    }
    const res = await CatalogProduct.updateMany(
      forceFilter,
      { $unset: { shortBenefits: '', shortBenefitsDerivedAt: '' } }
    );
    console.log(`--force: unstamped ${res.modifiedCount ?? res.nModified ?? 0} products for brand ${opts.brand}`);
    delete filter.brandId;
    Object.assign(filter, missingBenefitsFilter(), { brandId: forceFilter.brandId });
  }

  let query = CatalogProduct.find(filter)
    .select('_id brandId title description specs shortBenefits shortBenefitsDerivedAt')
    .sort({ _id: 1 })
    .lean();
  if (opts.limit && opts.limit > 0) query = query.limit(opts.limit);

  const products = await query;
  const projected = products.length * PROJECTED_USD_PER_CALL;

  console.log('backfillProductBenefits');
  console.log(`  mode:         ${opts.apply ? 'APPLY (will spend)' : 'DRY-RUN (no spend)'}`);
  console.log(`  brand:        ${opts.brand || '(all)'}`);
  console.log(`  limit:        ${opts.limit || '(none)'}`);
  console.log(`  concurrency:  ${opts.concurrency}`);
  console.log(`  candidates:   ${products.length}`);
  console.log(`  projected:    $${projected.toFixed(4)}  ($${PROJECTED_USD_PER_CALL}/call × ${products.length})`);

  if (!opts.apply) {
    console.log('\nDry-run. Pass --apply to derive. Nothing was billed.');
    await mongoose.disconnect();
    return;
  }

  if (!products.length) {
    console.log('\nNothing to derive. Actual spend: $0.00');
    await mongoose.disconnect();
    return;
  }

  const brands = await Brand.find({
    _id: { $in: [...new Set(products.map((p) => String(p.brandId)))] },
  }).select('_id name tone summary').lean();
  const brandById = new Map(brands.map((b) => [String(b._id), b]));

  const byBrand = new Map();
  for (const p of products) {
    const k = String(p.brandId);
    if (!byBrand.has(k)) byBrand.set(k, []);
    byBrand.get(k).push(p);
  }

  const totals = { attempted: 0, derived: 0, skipped: 0, failed: 0, charged: 0, spendUsd: 0 };
  for (const [brandId, list] of byBrand) {
    const brand = brandById.get(brandId) || null;
    const stats = await deriveForProducts({
      products: list,
      brand,
      concurrency: opts.concurrency,
      onProgress: (running) => {
        process.stdout.write(
          `\r  running: charged=${running.charged} derived=${running.derived} ` +
          `skipped=${running.skipped} failed=${running.failed} ` +
          `spend~$${running.spendUsd.toFixed(4)}   `
        );
      },
    });
    totals.attempted += stats.attempted;
    totals.derived += stats.derived;
    totals.skipped += stats.skipped;
    totals.failed += stats.failed;
    totals.charged += stats.charged;
    totals.spendUsd += stats.spendUsd;
  }
  process.stdout.write('\n');

  console.log('\nDone.');
  console.log(`  attempted: ${totals.attempted}`);
  console.log(`  derived:   ${totals.derived}`);
  console.log(`  skipped:   ${totals.skipped}`);
  console.log(`  failed:    ${totals.failed}`);
  console.log(`  charged:   ${totals.charged}`);
  console.log(`  spend (projected-from-charged): $${totals.spendUsd.toFixed(4)}`);
  console.log('  (authoritative spend is CostLog stage=product_benefits for this window)');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
