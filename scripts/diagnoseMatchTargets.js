// Where do the linked ProductMatchArtifacts actually POINT?
//
// Symptom: catalogProductId is set on artifacts but matches don't
// appear under the catalog browser's product rows. Hypothesis: the
// matches are linking to phantom `source: detect-identified` rows
// created by ensureCatalogProductForMatch when the Gemini title
// doesn't exactly match a synced (shopify / meta / manual) row.
//
// This script:
//   1. Counts CatalogProducts for the brand by source.
//   2. Counts artifact catalogProductId targets by source.
//   3. For each detect-identified row with matches, attempts a
//      fuzzy-title lookup against the brand's synced catalog
//      (shopify / meta / manual-upload) to surface likely twins.
//
// Usage:
//   node scripts/diagnoseMatchTargets.js --brand <brandId>

require('dotenv').config();
const mongoose = require('mongoose');

const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const CatalogProduct       = require('../models/CatalogProduct');

const args = process.argv.slice(2);
const BRAND = pickArg('--brand');

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const STOP = new Set(['the','a','an','and','or','of','for','with','to','in','on','by','at','from','is','are','be','this','that','oz','fl']);
function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t && t.length > 1 && !STOP.has(t));
}
function tokenOverlap(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

async function main() {
  const url = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!url) { console.error('No MONGO URL in env.'); process.exit(1); }
  if (!BRAND) { console.error('Pass --brand <brandId>'); process.exit(1); }
  await mongoose.connect(url);

  const brandOid = new mongoose.Types.ObjectId(BRAND);
  console.log('─'.repeat(78));
  console.log(`Brand: ${BRAND}`);
  console.log('─'.repeat(78));

  // 1. CatalogProducts by source.
  const cpBySource = await CatalogProduct.aggregate([
    { $match: { brandId: brandOid } },
    { $group: { _id: { source: '$source', draft: '$draft' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  console.log('\nCatalogProducts by (source, draft):');
  for (const r of cpBySource) {
    console.log(`  source=${(r._id.source || '(null)').padEnd(20)} draft=${r._id.draft === true ? 'true ' : 'false'}  count=${r.count}`);
  }

  // 2. Artifact catalogProductId targets grouped by the target CP's source.
  const artifactsWithTarget = await ProductMatchArtifact.aggregate([
    { $match: { brandId: brandOid, catalogProductId: { $ne: null } } },
    { $lookup: {
        from: 'catalogproducts',
        localField: 'catalogProductId',
        foreignField: '_id',
        as: 'cp'
    }},
    { $unwind: { path: '$cp', preserveNullAndEmptyArrays: true } },
    { $group: {
        _id: { source: '$cp.source', draft: '$cp.draft' },
        count: { $sum: 1 },
        distinctCp: { $addToSet: '$catalogProductId' }
    }},
    { $sort: { count: -1 } }
  ]);
  console.log('\nLinked ProductMatchArtifact targets by CatalogProduct (source, draft):');
  for (const r of artifactsWithTarget) {
    const distinctCount = (r.distinctCp || []).length;
    console.log(`  source=${(r._id.source || '(null/orphan)').padEnd(20)} draft=${r._id.draft === true ? 'true ' : 'false'}  artifacts=${r.count}  distinctCPs=${distinctCount}`);
  }

  // 3. Surface likely twins: each detect-identified row with matches,
  //    compared against synced rows for fuzzy title overlap.
  const detectIdentifiedWithMatches = await CatalogProduct.aggregate([
    { $match: { brandId: brandOid, source: 'detect-identified' } },
    { $lookup: {
        from: 'productmatchartifacts',
        localField: '_id',
        foreignField: 'catalogProductId',
        as: 'matches'
    }},
    { $match: { 'matches.0': { $exists: true } } },
    { $project: { _id: 1, title: 1, brand: 1, draft: 1, matchCount: { $size: '$matches' }, createdAt: 1 } },
    { $sort: { matchCount: -1, createdAt: -1 } }
  ]);

  if (!detectIdentifiedWithMatches.length) {
    console.log('\nNo detect-identified rows with matches. Hypothesis not supported.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${detectIdentifiedWithMatches.length} detect-identified CatalogProduct row(s) hold matches that should likely belong to synced rows.`);
  console.log(`Comparing each against synced rows (shopify / meta / manual-upload / etc.) for fuzzy title overlap…\n`);

  const syncedRows = await CatalogProduct
    .find({ brandId: brandOid, source: { $ne: 'detect-identified' } })
    .select('_id title brand source draft')
    .lean();

  let pairs = 0;
  for (const di of detectIdentifiedWithMatches) {
    let bestTwin = null;
    for (const sy of syncedRows) {
      const ov = tokenOverlap(di.title, sy.title);
      if (ov >= 0.4 && (!bestTwin || ov > bestTwin.score)) {
        bestTwin = { row: sy, score: ov };
      }
    }
    const tag = bestTwin ? `→ TWIN(${bestTwin.score.toFixed(2)})` : '→ no twin';
    console.log(`  ${di._id}  matches=${di.matchCount}  draft=${di.draft === true}  "${(di.title || '').slice(0, 60)}"`);
    if (bestTwin) {
      pairs++;
      console.log(`     ${tag}  ${bestTwin.row._id}  source=${bestTwin.row.source}  "${(bestTwin.row.title || '').slice(0, 60)}"`);
    } else {
      console.log(`     ${tag}`);
    }
  }

  console.log(`\nSummary: ${pairs}/${detectIdentifiedWithMatches.length} detect-identified rows have a likely synced twin (token overlap ≥ 0.4).`);
  console.log('If most have twins, the bug is confirmed: ensureCatalogProductForMatch is creating phantom rows instead of finding existing synced ones.');

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
