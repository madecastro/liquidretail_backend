#!/usr/bin/env node
//
// diagnoseCategoriesForBrand.js — one-shot inspector for the
// "new categories aren't showing" question. Reports:
//
//   1. Every Category row for the brand (breadcrumb, depth,
//      advertiserId presence, productCount from
//      CatalogProduct.categoryRef reverse-lookup, deletedAt).
//   2. Distinct CatalogProduct.category strings (raw feed values).
//   3. A count of CatalogProduct rows whose categoryRef points at a
//      row that would fail the /api/catalog/categories tenantFilter
//      (advertiserId mismatch, most likely null).
//
// Usage:
//   node scripts/diagnoseCategoriesForBrand.js --brand "Gymshark"
//   node scripts/diagnoseCategoriesForBrand.js --brand "Gymshark" --limit 30

require('dotenv').config();
const mongoose = require('mongoose');

const Category       = require('../models/Category');
const CatalogProduct = require('../models/CatalogProduct');
const Brand          = require('../models/Brand');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.brand) {
    console.error('Usage: node scripts/diagnoseCategoriesForBrand.js --brand "Name"');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
  });

  const brand = await Brand.findOne({ name: new RegExp(`^${escapeRegex(args.brand)}$`, 'i') }).lean();
  if (!brand) { console.error(`Brand "${args.brand}" not found`); process.exit(1); }
  console.log(`Brand: ${brand.name} (${brand._id}) advertiserId=${brand.advertiserId}`);

  // 1. Every Category row for the brand.
  const cats = await Category.find({ brandId: brand._id }).lean();
  console.log(`\nCategory rows for brand: ${cats.length}`);

  const noAdvertiser = cats.filter(c => !c.advertiserId);
  const mismatchedAdvertiser = cats.filter(c =>
    c.advertiserId && brand.advertiserId && String(c.advertiserId) !== String(brand.advertiserId)
  );
  console.log(`   with advertiserId=null:    ${noAdvertiser.length}`);
  console.log(`   advertiserId mismatch:     ${mismatchedAdvertiser.length}`);

  // Product counts per category via reverse lookup.
  const productRefs = await CatalogProduct.aggregate([
    { $match: { brandId: brand._id, categoryRef: { $ne: null } } },
    { $group: { _id: '$categoryRef', count: { $sum: 1 } } }
  ]);
  const countByCat = new Map(productRefs.map(r => [String(r._id), r.count]));

  const limit = args.limit || 30;
  const sorted = cats.slice().sort((a, b) => (a.breadcrumb || '').localeCompare(b.breadcrumb || ''));
  console.log(`\nFirst ${Math.min(limit, sorted.length)} categories (sorted by breadcrumb):`);
  for (const c of sorted.slice(0, limit)) {
    const advTag = c.advertiserId
      ? (String(c.advertiserId) === String(brand.advertiserId) ? 'adv-ok' : 'adv-MISMATCH')
      : 'adv-NULL';
    const products = countByCat.get(String(c._id)) || 0;
    console.log(`   d${c.depth} ${products.toString().padStart(4)} products · ${advTag} · ${c.breadcrumb}`);
  }
  if (sorted.length > limit) console.log(`   ... ${sorted.length - limit} more`);

  // 2. Distinct CatalogProduct.category strings.
  const rawCats = await CatalogProduct.distinct('category', { brandId: brand._id });
  const rawNonEmpty = rawCats.filter(Boolean);
  console.log(`\nDistinct CatalogProduct.category strings: ${rawNonEmpty.length}`);
  for (const s of rawNonEmpty.slice(0, 15)) console.log(`   "${s}"`);
  if (rawNonEmpty.length > 15) console.log(`   ... ${rawNonEmpty.length - 15} more`);

  // 3. Would-the-endpoint-return-it check: simulate the exact filter
  //    /api/catalog/categories runs, using the brand's advertiserId.
  const endpointVisible = await Category.find({
    advertiserId: brand.advertiserId,
    brandId:      brand._id
  }).select('_id').lean();
  console.log(`\n/api/catalog/categories would return: ${endpointVisible.length} of ${cats.length}`);
  if (endpointVisible.length < cats.length) {
    console.log(`   ⚠️  ${cats.length - endpointVisible.length} category rows exist but the endpoint filter drops them.`);
    console.log(`       Most common cause: advertiserId is null on the Category row.`);
  }

  await mongoose.disconnect();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--brand') out.brand = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

main().catch(err => {
  console.error('Error:', err);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
