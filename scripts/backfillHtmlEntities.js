#!/usr/bin/env node
//
// Repair HTML character references left in already-scraped catalog text.
//
// Rows synced before utils/htmlEntities landed carry the raw references
// their source markup used, because JSON-LD inside a <script> is never
// entity-decoded by the HTML parser:
//
//   title: 'Austen Black 74&quot; Wide Wood TV Stand'
//   title: 'Paulina Black &amp; Grey 71&quot; TV Stand'
//   inferredBreadcrumb: ['Lighting', 'Table &#x2B; Buffet Lamps']
//
// Fixes CatalogProduct title / description / brand / category /
// inferredBreadcrumb / productReviews.quotes, and recomputes
// normalizedTitle (the matcher key — '74&quot;' tokenizes to a bogus
// "quot" token, so damaged rows also mis-match).
//
// With --categories it also repairs Category name / breadcrumb /
// breadcrumbKey. A repaired key can collide with an existing clean row
// (unique index on brandId+breadcrumbKey); those are reported and skipped
// rather than merged — merging would have to re-point every
// CatalogProduct.categoryRef and is a separate, deliberate operation.
//
// Idempotent — re-running finds nothing once clean.
//
// Usage:
//   node scripts/backfillHtmlEntities.js                     # dry run, all brands
//   node scripts/backfillHtmlEntities.js --brand <brandId>    # one brand
//   node scripts/backfillHtmlEntities.js --apply              # actually write
//   node scripts/backfillHtmlEntities.js --apply --categories # + Category rows
//   node scripts/backfillHtmlEntities.js --limit 20           # sample N rows

require('dotenv').config();
const mongoose = require('mongoose');

const CatalogProduct = require('../models/CatalogProduct');
// models/Category exports the model with breadcrumbToKey hung off it.
const Category = require('../models/Category');
const { breadcrumbToKey } = Category;
const { normalizeTitle } = require('../utils/titleNormalize');
const { cleanScrapedText, hasHtmlEntity } = require('../utils/htmlEntities');
// Same description cleaner the scrapers use — decode once, strip tags on
// both sides of it (escaped markup only becomes strippable after decoding).
const { stripHtml } = require('../services/shopifyPublicIngestService');

const args  = process.argv.slice(2);
const DRY   = !args.includes('--apply');
const CATS  = args.includes('--categories');
const BRAND = pickArg('--brand');
const LIMIT = parseInt(pickArg('--limit'), 10) || 0;

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Mongo-side prefilter: anything holding "&…;" is a candidate. hasHtmlEntity
// then decides per row whether a decode actually changes it, so a literal
// "Salt & Pepper" or an unknown "&foo;" is never touched.
const ENTITY_MONGO_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/;

const PRODUCT_TEXT_FIELDS = ['title', 'description', 'brand', 'category'];

/**
 * repairProductFields(doc) → $set object (empty when the row is clean)
 * Pure — exported for scripts/testHtmlEntities.js. `doc` is a lean
 * CatalogProduct.
 */
function repairProductFields(doc) {
  const set = {};
  if (!doc) return set;

  for (const f of PRODUCT_TEXT_FIELDS) {
    if (!hasHtmlEntity(doc[f])) continue;
    // description goes through the ingest path's stripHtml: sites that
    // escape their JSON-LD store the body as encoded markup, so decoding
    // alone would leave literal "<div>" text behind.
    set[f] = f === 'description'
      ? stripHtml(doc[f], 2000)
      : cleanScrapedText(doc[f]);
  }

  if (Array.isArray(doc.inferredBreadcrumb) && doc.inferredBreadcrumb.some(hasHtmlEntity)) {
    set.inferredBreadcrumb = doc.inferredBreadcrumb
      .map(s => (hasHtmlEntity(s) ? cleanScrapedText(s) : s))
      .filter(Boolean);
  }

  if (doc.productReviews && Array.isArray(doc.productReviews.quotes)) {
    const { quotes, changed } = repairQuotes(doc.productReviews.quotes);
    if (changed) set['productReviews.quotes'] = quotes;
  }

  // The matcher key is derived from title — recompute it in the same write.
  // '74&quot;' tokenizes to a bogus "quot", so damaged rows also mis-match.
  if (set.title) {
    const nt = normalizeTitle(set.title);
    if (nt !== doc.normalizedTitle) set.normalizedTitle = nt;
  }

  return set;
}

function repairQuotes(quotes) {
  if (!Array.isArray(quotes)) return { quotes: null, changed: false };
  let changed = false;
  const out = quotes.map(q => {
    if (!q || typeof q !== 'object') return q;
    const next = { ...(q.toObject ? q.toObject() : q) };
    for (const f of ['text', 'author']) {
      if (hasHtmlEntity(next[f])) {
        next[f] = cleanScrapedText(next[f], f === 'text' ? 400 : 120);
        changed = true;
      }
    }
    return next;
  });
  return { quotes: out, changed };
}

async function backfillProducts() {
  const filter = {
    $or: [
      { title:              ENTITY_MONGO_RE },
      { description:        ENTITY_MONGO_RE },
      { brand:              ENTITY_MONGO_RE },
      { category:           ENTITY_MONGO_RE },
      { inferredBreadcrumb: ENTITY_MONGO_RE },
      { 'productReviews.quotes.text':   ENTITY_MONGO_RE },
      { 'productReviews.quotes.author': ENTITY_MONGO_RE }
    ]
  };
  if (BRAND && mongoose.Types.ObjectId.isValid(BRAND)) {
    filter.brandId = new mongoose.Types.ObjectId(BRAND);
  }

  const total = await CatalogProduct.countDocuments(filter);
  console.log(`\nCatalogProduct rows with encoded text: ${total}`);
  if (!total) return { scanned: 0, updated: 0 };

  let q = CatalogProduct.find(filter)
    .select('_id brandId title description brand category inferredBreadcrumb productReviews normalizedTitle')
    .lean();
  if (LIMIT) q = q.limit(LIMIT);

  const cursor = q.cursor();
  let scanned = 0;
  let updated = 0;
  let shown = 0;

  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    scanned += 1;
    const set = repairProductFields(doc);
    if (!Object.keys(set).length) continue;
    updated += 1;

    if (shown < 15) {
      shown += 1;
      const before = doc.title;
      const after = set.title != null ? set.title : doc.title;
      console.log(`  ${String(doc._id)}  fields=[${Object.keys(set).join(', ')}]`);
      if (set.title) {
        console.log(`      − ${before}`);
        console.log(`      + ${after}`);
      }
    }

    if (!DRY) {
      // updateOne bypasses the findOneAndUpdate hook, so normalizedTitle is
      // set explicitly above rather than relying on the model hook.
      await CatalogProduct.updateOne({ _id: doc._id }, { $set: set });
    }
  }

  if (updated > shown) console.log(`  … ${updated - shown} more not shown`);
  return { scanned, updated };
}

async function backfillCategories() {
  const filter = {
    $or: [
      { name:       ENTITY_MONGO_RE },
      { breadcrumb: ENTITY_MONGO_RE }
    ]
  };
  if (BRAND && mongoose.Types.ObjectId.isValid(BRAND)) {
    filter.brandId = new mongoose.Types.ObjectId(BRAND);
  }

  const rows = await Category.find(filter)
    .select('_id brandId name breadcrumb breadcrumbKey')
    .lean();
  console.log(`\nCategory rows with encoded text: ${rows.length}`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const set = {};
    if (hasHtmlEntity(row.name))       set.name       = cleanScrapedText(row.name);
    if (hasHtmlEntity(row.breadcrumb)) set.breadcrumb = cleanScrapedText(row.breadcrumb);
    if (!Object.keys(set).length) continue;

    if (set.breadcrumb) {
      const key = breadcrumbToKey(set.breadcrumb);
      if (key !== row.breadcrumbKey) {
        // Unique on (brandId, breadcrumbKey) — a clean twin already holding
        // the repaired key means these two rows want to be one. Report, skip.
        const clash = await Category.findOne({
          brandId: row.brandId, breadcrumbKey: key, _id: { $ne: row._id }
        }).select('_id').lean();
        if (clash) {
          skipped += 1;
          console.log(`  ⚠️  ${row._id} "${row.breadcrumb}" → key collides with ${clash._id} — skipped (merge is a separate op)`);
          continue;
        }
        set.breadcrumbKey = key;
      }
    }

    updated += 1;
    console.log(`  ${row._id}  − ${row.breadcrumb}`);
    console.log(`                + ${set.breadcrumb || row.breadcrumb}`);
    if (!DRY) await Category.updateOne({ _id: row._id }, { $set: set });
  }

  return { scanned: rows.length, updated, skipped };
}

async function main() {
  const url = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!url) { console.error('No MONGO URL in env.'); process.exit(1); }
  await mongoose.connect(url);

  console.log('─'.repeat(70));
  console.log('mode:', DRY ? 'DRY RUN (no writes)' : 'APPLY');
  if (BRAND) console.log('brand filter:', BRAND);
  if (LIMIT) console.log('row limit:', LIMIT);
  console.log('categories:', CATS ? 'yes' : 'no (pass --categories)');
  console.log('─'.repeat(70));

  const prod = await backfillProducts();
  let cats = null;
  if (CATS) cats = await backfillCategories();

  console.log('\n' + '─'.repeat(70));
  console.log(`CatalogProduct: scanned ${prod.scanned}, ${DRY ? 'would update' : 'updated'} ${prod.updated}`);
  if (cats) {
    console.log(`Category:       scanned ${cats.scanned}, ${DRY ? 'would update' : 'updated'} ${cats.updated}, skipped ${cats.skipped}`);
  }
  if (DRY) console.log('\nDry run — re-run with --apply to write.');
  console.log('─'.repeat(70));

  await mongoose.disconnect();
}

// Exported for unit coverage (scripts/testHtmlEntities.js); only connect +
// scan when run as a script.
module.exports = { repairProductFields, ENTITY_MONGO_RE };

if (require.main === module) {
  main().catch(async (err) => {
    console.error('backfill failed:', err);
    try { await mongoose.disconnect(); } catch { /* noop */ }
    process.exit(1);
  });
}
