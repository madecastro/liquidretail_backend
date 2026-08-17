// Stress-test data pull for the reasoner. For every recent brand_match
// (76% of matches), inspect the identification block, the evidence
// URLs, and the query — so we can see WHY the reasoner declined to
// pin a SKU. Read-only.
//
// Usage:
//   node scripts/diagnoseReasonerOutcomes.js --last 500

require('dotenv').config();
const mongoose = require('mongoose');

const DetectRun            = require('../models/DetectRun');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const CatalogProduct       = require('../models/CatalogProduct');

const args = process.argv.slice(2);
function pick(n){ const i=args.indexOf(n); return i>=0?args[i+1]:null; }
const LAST = parseInt(pick('--last')||'500', 10);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const runs = await DetectRun.find({ status:'completed' })
    .sort({ createdAt: -1 }).limit(LAST).select('_id trigger').lean();
  const runIds = runs.map(r => r._id);
  const matches = await ProductMatchArtifact.find({ runId: { $in: runIds } }).lean();
  console.log(`sampled ${runs.length} runs, ${matches.length} match artifacts`);

  // Certainty distribution across all outcomes
  const bands = { '≥0.75':0, '0.50-0.74':0, '0.25-0.49':0, '<0.25':0, 'null':0 };
  for (const m of matches) {
    const c = m.identification?.certainty;
    if (typeof c !== 'number') bands['null']++;
    else if (c >= 0.75) bands['≥0.75']++;
    else if (c >= 0.50) bands['0.50-0.74']++;
    else if (c >= 0.25) bands['0.25-0.49']++;
    else bands['<0.25']++;
  }
  console.log('\n── reasoner certainty distribution (all outcomes) ──');
  for (const [k,v] of Object.entries(bands)) console.log(`  ${k.padEnd(12)} ${v}`);

  const brandMatches = matches.filter(m => m.outcome === 'brand_match');
  const productMatches = matches.filter(m => m.outcome === 'product_match');
  const productCategories = matches.filter(m => m.outcome === 'product_category');
  console.log(`\n── outcome buckets ──`);
  console.log(`  brand_match:      ${brandMatches.length}`);
  console.log(`  product_match:    ${productMatches.length}`);
  console.log(`  product_category: ${productCategories.length}`);

  // For brand_match, what certainty did the reasoner return?
  console.log('\n── brand_match — reasoner certainty ──');
  const bmBands = { '≥0.75':0, '0.50-0.74':0, '0.25-0.49':0, '<0.25':0, 'null':0 };
  for (const m of brandMatches) {
    const c = m.identification?.certainty;
    if (typeof c !== 'number') bmBands['null']++;
    else if (c >= 0.75) bmBands['≥0.75']++;
    else if (c >= 0.50) bmBands['0.50-0.74']++;
    else if (c >= 0.25) bmBands['0.25-0.49']++;
    else bmBands['<0.25']++;
  }
  for (const [k,v] of Object.entries(bmBands)) console.log(`  ${k.padEnd(12)} ${v}`);

  // >=0.5 brand_match rows are the near-misses. What did they say?
  const nearMisses = brandMatches.filter(m => (m.identification?.certainty||0) >= 0.50);
  console.log(`\n── brand_match at certainty ≥ 0.5 (${nearMisses.length}) — 5 samples ──`);
  for (const m of nearMisses.slice(0, 5)) {
    console.log(`\n  match ${m._id}  cert=${m.identification.certainty}`);
    console.log(`    productName=${JSON.stringify(m.identification.productName)}`);
    console.log(`    brand=${m.identification.brand}`);
    console.log(`    reasoning: "${(m.identification.reasoning||'').slice(0, 200)}"`);
    console.log(`    outcomeReasoning: "${(m.outcomeReasoning||'').slice(0, 200)}"`);
    console.log(`    matchSource=${m.matchSource}  winner=${m.winner}`);
  }

  // For product_match with linked, print unlinked reason
  const unlinked = productMatches.filter(m => !m.catalogProductId);
  console.log(`\n── product_match but not linked (${unlinked.length}) — 5 samples ──`);
  for (const m of unlinked.slice(0, 5)) {
    console.log(`\n  match ${m._id}  cert=${m.identification?.certainty ?? 'n/a'}`);
    console.log(`    productName=${JSON.stringify(m.identification?.productName)}`);
    console.log(`    brand=${m.identification?.brand}`);
    console.log(`    winner=${m.winner}  matchSource=${m.matchSource}`);
    console.log(`    outcomeReasoning: "${(m.outcomeReasoning||'').slice(0, 200)}"`);
  }

  // Which certaintyLabel appears with brand_match? (Off-by-one detector)
  const bmLabels = {};
  for (const m of brandMatches) {
    const lbl = m.identification?.certaintyLabel || 'null';
    bmLabels[lbl] = (bmLabels[lbl]||0) + 1;
  }
  console.log('\n── brand_match certaintyLabel distribution (off-by-one detector) ──');
  console.log(`  If any 'high' rows exist here → the reasoner said "high" (0.70-0.89) but productMatchService demoted it because HIGH_CONFIDENCE=0.75.`);
  for (const [k,v] of Object.entries(bmLabels)) console.log(`  ${k.padEnd(12)} ${v}`);

  // Query captions — how many brand_match had ANY caption to work with?
  const noCaption = brandMatches.filter(m => !(m.query?.caption)).length;
  const hasCaption = brandMatches.length - noCaption;
  console.log(`\n── brand_match query.caption presence ──`);
  console.log(`  has caption: ${hasCaption}  (${(hasCaption/brandMatches.length*100).toFixed(0)}%)`);
  console.log(`  no caption:  ${noCaption}`);

  // For the ones with captions, what did they look like?
  console.log(`\n── 5 sample captions from brand_match rows ──`);
  for (const m of brandMatches.filter(m => m.query?.caption).slice(0, 5)) {
    console.log(`  ${(m.query.caption||'').slice(0, 200)}`);
  }

  // For unlinked product_match, look at ident.productName vs. catalog title tokens
  console.log(`\n── unlinked product_match — token overlap with catalog ──`);
  const brandProducts = new Map();
  for (const m of unlinked.slice(0, 20)) {
    const brandId = m.brandId;
    if (!brandId) continue;
    if (!brandProducts.has(String(brandId))) {
      const rows = await CatalogProduct.find({
        brandId, draft: { $ne: true }
      }).select('title normalizedTitle').limit(500).lean();
      brandProducts.set(String(brandId), rows);
    }
    const rows = brandProducts.get(String(brandId));
    const name = m.identification?.productName;
    if (!name) continue;
    // Find best token overlap
    const nameTokens = new Set((name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length >= 3)));
    let best = { shared: 0, title: null };
    for (const r of rows) {
      const t = (r.title||'').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length >= 3);
      let shared = 0;
      for (const tok of nameTokens) if (t.includes(tok)) shared++;
      if (shared > best.shared) best = { shared, title: r.title };
    }
    console.log(`  ident: "${name}"  →  best catalog match ${best.shared} shared: "${best.title||'n/a'}"`);
  }

  await mongoose.disconnect();
})().catch(err => { console.error('fatal:', err.message); process.exit(1); });
