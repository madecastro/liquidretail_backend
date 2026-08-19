#!/usr/bin/env node
'use strict';
/**
 * backfillBrandWebsiteUrl — one-time historical back-fill for the
 * "brand has a synced catalog but Brand.websiteUrl is empty" hole.
 *
 * ROOT CAUSE (fixed alongside this script, 2026-08-18): shopify-direct /
 * generic-sitemap / legacy apify-shopify catalog ingest all resolve a
 * storefront origin (Brand.apifyDemo.shopifyUrl) to scrape from, but never
 * copied it onto Brand.websiteUrl — the field every downstream enrichment
 * tier (GPT tagline/summary/tone, website logo discovery, website font
 * ingest) actually reads. New ingests are fixed going forward by
 * services/brandWebsiteBackfill.js, called from
 * shopifyPublicIngestService.syncBrandShopifyDirect,
 * genericCatalogIngestService.syncBrandGenericCatalog, and
 * apifyIngestService.syncBrandShopify. THIS script is the one-time catch-up
 * for brands that already have a fully-synced catalog from before the fix.
 *
 * CANDIDATE SELECTION per brand missing websiteUrl (aggregated over
 * CatalogProduct):
 *   1. Prefer Brand.apifyDemo.shopifyUrl — this IS the domain the ingest
 *      was configured against and already resolved real products from.
 *   2. Else, majority-vote the origin of CatalogProduct.productUrl across
 *      that brand's rows (most common surviving origin wins a tie by
 *      insertion order, i.e. whichever origin was seen first).
 * Both paths go through services/brandWebsiteBackfill.js's
 * `safeWebsiteOrigin()`, which REJECTS known non-storefront hosts
 * (`*.myshopify.com`, `cdn.shopify.com`, `*.gstatic.com`,
 * `*.cloudinary.com`) — confirmed necessary: GymShark's own
 * apifyDemo.shopifyUrl is the correct `www.gymshark.com`, but its
 * CatalogProduct.productUrl rows are minted against the headless
 * `gymsharkusa.myshopify.com` BACKEND (see that file's header for why
 * deriving from imageUrl/productUrl blindly would have poisoned
 * websiteUrl with the wrong host).
 *
 * Never touches a brand with `source === 'curated'` or `'websiteUrl'` in
 * curatedFields — same guard as brandCatalogService.js:57.
 *
 * REPORT MODE IS THE DEFAULT AND WRITES NOTHING. --apply writes
 * Brand.websiteUrl via the real backfillBrandWebsiteUrl() (same function
 * the live ingest hooks call — never a re-implemented cascade), then
 * SEQUENTIALLY AWAITS enrichBrandFromUrl for each brand it just updated
 * (unless --skip-enrich), so this process observes and reports real
 * outcomes before it exits — a fire-and-forget enrichment call from a
 * short-lived script can be killed by process.exit() before it resolves,
 * so this script deliberately does NOT rely on backfillBrandWebsiteUrl's
 * default fire-and-forget trigger (`triggerEnrichment: false` is passed).
 *
 * Idempotent: a brand that already has websiteUrl is excluded by the
 * query itself, so re-running after a partial apply only touches what's
 * still missing.
 *
 * Usage (run from repo root):
 *   node scripts/backfillBrandWebsiteUrl.js                    # report only
 *   node scripts/backfillBrandWebsiteUrl.js --brand "GymShark"  # one brand
 *   node scripts/backfillBrandWebsiteUrl.js --apply             # write + enrich all
 *   node scripts/backfillBrandWebsiteUrl.js --apply --brand "GymShark"
 *   node scripts/backfillBrandWebsiteUrl.js --apply --skip-enrich
 *
 * COST: the websiteUrl write itself is free. Unless --skip-enrich, --apply
 * runs full brand enrichment per backfilled brand (GPT tagline/summary +
 * website logo/font scraping — HTTP + one or more LLM calls per brand;
 * same cost as clicking "refresh enrichment" in the UI). Report mode is
 * fully offline-DB-only, no network calls beyond Mongo.
 */

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const { safeWebsiteOrigin, backfillBrandWebsiteUrl } = require('../services/brandWebsiteBackfill');
const { enrichBrandFromUrl } = require('../services/brandEnrichmentService');

function parseArgs(argv) {
  const out = { apply: false, brand: null, limit: null, skipEnrich: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--skip-enrich') { out.skipEnrich = true; continue; }
    if (a === '--brand') { out.brand = argv[++i] || null; continue; }
    if (a === '--limit') { out.limit = parseInt(argv[++i], 10) || null; continue; }
    console.error(`Unknown argument: ${a}`);
    process.exit(1);
  }
  return out;
}

/**
 * Every brand with at least one CatalogProduct row but an empty
 * Brand.websiteUrl. Exported so scripts/verifyBrandWebsiteBackfill.js can
 * call the real aggregation instead of a re-implemented copy.
 */
async function findCandidateBrands() {
  return CatalogProduct.aggregate([
    { $group: {
        _id: '$brandId',
        productCount: { $sum: 1 },
        sources: { $addToSet: '$source' },
        // Preserve first-seen order among productUrl values for a stable
        // majority-vote tiebreak below (insertion order, not $addToSet's
        // unspecified order).
        productUrls: { $push: '$productUrl' }
      } },
    { $lookup: { from: 'brands', localField: '_id', foreignField: '_id', as: 'brand' } },
    { $unwind: '$brand' },
    { $match: { $or: [
      { 'brand.websiteUrl': null },
      { 'brand.websiteUrl': '' },
      { 'brand.websiteUrl': { $exists: false } }
    ] } },
    { $project: {
        brandId: '$_id', name: '$brand.name', isDemo: '$brand.isDemo',
        source: '$brand.source', curatedFields: '$brand.curatedFields',
        apifyDemoShopifyUrl: '$brand.apifyDemo.shopifyUrl',
        productCount: 1, sources: 1, productUrls: 1
      } },
    { $sort: { productCount: -1 } }
  ]);
}

/**
 * Majority-vote a safe origin out of a brand's CatalogProduct.productUrl
 * values. Ties break by first-seen order (stable, not vote-count-random).
 */
function majorityOriginFromProductUrls(productUrls) {
  const counts = new Map(); // origin -> count
  const order = [];         // first-seen order
  for (const raw of productUrls || []) {
    const origin = safeWebsiteOrigin(raw);
    if (!origin) continue;
    if (!counts.has(origin)) { counts.set(origin, 0); order.push(origin); }
    counts.set(origin, counts.get(origin) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const origin of order) {
    const c = counts.get(origin);
    if (c > bestCount) { best = origin; bestCount = c; }
  }
  return best;
}

function chooseCandidateOrigin(row) {
  const fromConfig = safeWebsiteOrigin(row.apifyDemoShopifyUrl);
  if (fromConfig) return { origin: fromConfig, via: 'apifyDemo.shopifyUrl' };
  const fromProducts = majorityOriginFromProductUrls(row.productUrls);
  if (fromProducts) return { origin: fromProducts, via: 'productUrl-majority' };
  return { origin: null, via: null };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — cannot run.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`🔌 connected to ${mongoose.connection.host}`);
  console.log(opts.apply ? '⚠️  APPLY MODE — will write Brand.websiteUrl' : '📋 report mode — nothing will be written (pass --apply to write)');
  if (opts.apply && !opts.skipEnrich) {
    console.log('   (and run enrichment for every brand it backfills — pass --skip-enrich to skip that)');
  }

  let rows = await findCandidateBrands();
  if (opts.brand) {
    const needle = opts.brand.toLowerCase();
    rows = rows.filter(r => String(r.name || '').toLowerCase() === needle || String(r.brandId) === opts.brand);
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);

  console.log(`\nFound ${rows.length} brand(s) with CatalogProduct rows but no websiteUrl:\n`);

  const table = [];
  const toEnrich = [];
  for (const row of rows) {
    const curated = row.source === 'curated' || (Array.isArray(row.curatedFields) && row.curatedFields.includes('websiteUrl'));
    const { origin, via } = chooseCandidateOrigin(row);

    let action;
    if (curated) {
      action = 'SKIP (curated)';
    } else if (!origin) {
      action = 'SKIP (no safe candidate)';
    } else if (!opts.apply) {
      action = `WOULD SET → ${origin} (via ${via})`;
    } else {
      const result = await backfillBrandWebsiteUrl({ _id: row.brandId }, origin, {
        ingestSource: `backfill-script:${via}`,
        triggerEnrichment: false
      });
      if (result.updated) {
        action = `SET → ${result.websiteUrl} (via ${via})`;
        toEnrich.push({ id: row.brandId, name: row.name });
      } else {
        // A concurrent write (e.g. a curated-guard race, or another
        // process already set it) — report honestly rather than claiming
        // success.
        action = 'NO-OP (guard rejected the write — see console warnings above)';
      }
    }

    table.push({
      id: String(row.brandId), name: row.name, isDemo: !!row.isDemo,
      productCount: row.productCount, sources: row.sources, action
    });
  }

  for (const r of table) {
    console.log(`- ${r.name} (${r.id}) — ${r.productCount} products [${r.sources.join(',')}]${r.isDemo ? ' [demo]' : ''}\n    ${r.action}`);
  }

  if (opts.apply && !opts.skipEnrich && toEnrich.length) {
    console.log(`\n🧠 Running brand enrichment for ${toEnrich.length} newly-backfilled brand(s) (sequential, awaited)...\n`);
    for (const b of toEnrich) {
      console.log(`--- enrichBrandFromUrl(${b.name} / ${b.id}) ---`);
      try {
        const result = await enrichBrandFromUrl(b.id);
        console.log(`   result: ${JSON.stringify(result)}`);
      } catch (err) {
        console.warn(`   ⚠️  enrichment threw for ${b.name}: ${err.message}`);
      }
    }
  }

  console.log(`\nDone. ${table.filter(r => r.action.startsWith('SET') || r.action.startsWith('WOULD SET')).length} brand(s) ${opts.apply ? 'backfilled' : 'would be backfilled'}.`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

module.exports = { findCandidateBrands, majorityOriginFromProductUrls, chooseCandidateOrigin };
