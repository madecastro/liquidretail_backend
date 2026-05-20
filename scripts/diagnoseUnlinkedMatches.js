// Diagnose ProductMatchArtifact rows that have outcome='product_match'
// (often with high certainty) but catalogProductId=null — i.e. the
// match never linked to a CatalogProduct row. These show up in the
// Media Library (which falls back to identification.productName)
// but are invisible to:
//   - /api/catalog/:id/matches  (queries by catalogProductId)
//   - seedsFromProduct          (reads CatalogProduct.matchedMedia[],
//                                populated only when catalogProductId
//                                is set)
//
// The script reproduces the matching strategies inside
// productMatchService.ensureCatalogProductForMatch (exact title regex,
// brand-mismatch guard) and a wider fuzzy variant, then buckets every
// unlinked artifact by which strategy *would* have succeeded — so we
// can see whether to widen Path 3 (Title fuzz), check Brand mismatch
// cases, or look for stale-data effects.
//
// Usage:
//   node scripts/diagnoseUnlinkedMatches.js --brand <brandId>
//   node scripts/diagnoseUnlinkedMatches.js --brand <brandId> --min-certainty 0.5
//   node scripts/diagnoseUnlinkedMatches.js                  # all brands

require('dotenv').config();
const mongoose = require('mongoose');

const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const CatalogProduct       = require('../models/CatalogProduct');
const Brand                = require('../models/Brand');

const args = process.argv.slice(2);
const BRAND = pickArg('--brand');
const MIN_CERT = parseFloat(pickArg('--min-certainty') || '0.5');
const SAMPLE_LIMIT = parseInt(pickArg('--samples') || '5', 10);

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBrand(s) {
  return String(s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\b(inc|co|llc|ltd|corp|corporation)\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mirrors productMatchService.brandsMatchLoose exactly.
function brandsMatchLoose(a, b) {
  if (!a || !b) return false;
  const na = normalizeBrand(a);
  const nb = normalizeBrand(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.startsWith(shorter + ' ')) return true;
  if (shorter.length >= 2 && shorter.length <= 5 && !shorter.includes(' ')) {
    const abbrev = longer.split(/\s+/).filter(Boolean).map(w => w[0]).join('');
    if (abbrev === shorter) return true;
  }
  return false;
}

function normalizeTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-overlap score 0..1 — same family as findCatalogMatch but
// over the identification.productName vs catalog title only.
const STOP = new Set(['the','a','an','and','or','of','for','with','to','in','on','by','at','from','is','are','be','this','that']);
function tokens(s) {
  return normalizeTitle(s).split(' ').filter(t => t && t.length > 1 && !STOP.has(t));
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
  await mongoose.connect(url);
  console.log('─'.repeat(78));
  console.log('Diagnose unlinked ProductMatchArtifact rows');
  console.log(`  min certainty: ${MIN_CERT}`);
  console.log(`  brand filter:  ${BRAND || '(all)'}`);
  console.log('─'.repeat(78));

  const filter = {
    outcome: 'product_match',
    catalogProductId: null,
    'identification.productName': { $exists: true, $ne: null },
    'identification.certainty': { $gte: MIN_CERT }
  };
  if (BRAND && mongoose.Types.ObjectId.isValid(BRAND)) {
    filter.brandId = new mongoose.Types.ObjectId(BRAND);
  }

  const total = await ProductMatchArtifact.countDocuments(filter);
  console.log(`\nUnlinked product_match artifacts at certainty ≥ ${MIN_CERT}: ${total}`);
  if (!total) { await mongoose.disconnect(); return; }

  // Pull all unlinked rows (or a cap if it's huge). For diagnosis we
  // can afford to scan a few thousand.
  const artifacts = await ProductMatchArtifact.find(filter)
    .sort({ createdAt: -1 })
    .limit(2000)
    .select('brandId identification matchSource winner createdAt catalogVisualScore catalogCombinedScore')
    .lean();

  // Group by brand so we can compare the brand's name against the
  // identification.brand returned by the matchers.
  const brandIds = [...new Set(artifacts.map(a => String(a.brandId)).filter(Boolean))];
  const brands = await Brand.find({ _id: { $in: brandIds } })
    .select('name aliases primaryUrl')
    .lean();
  const brandById = new Map(brands.map(b => [String(b._id), b]));

  // For each brand seen in the unlinked set, pre-pull the catalog so
  // we can attempt fuzzy matches without N+1 queries.
  const catalogByBrand = new Map();
  for (const bid of brandIds) {
    const rows = await CatalogProduct
      .find({ brandId: bid, draft: { $ne: true } })
      .select('_id title brand source externalId')
      .lean();
    catalogByBrand.set(bid, rows);
  }

  const buckets = {
    would_link_by_exact_title:   [],   // ensureCatalogProductForMatch's exact regex would have found a row — script bug if non-empty
    would_link_by_fuzzy_title:   [],   // token overlap ≥ 0.5 against an existing catalog row
    brand_mismatch_blocks_create:[],   // would have created (no existing row) but brand mismatch returned null
    would_create_new_row:        [],   // no existing row, brand match OK — should have created
    no_candidates:               []    // nothing close — productName is too generic / catalog too sparse
  };

  const certBuckets = { '0.5-0.7': 0, '0.7-0.85': 0, '0.85+': 0 };

  for (const a of artifacts) {
    const ident = a.identification || {};
    const productName = ident.productName;
    const identBrand  = ident.brand;
    const cert = ident.certainty || 0;
    if (cert >= 0.85) certBuckets['0.85+']++;
    else if (cert >= 0.7) certBuckets['0.7-0.85']++;
    else certBuckets['0.5-0.7']++;

    const brand = brandById.get(String(a.brandId));
    const activeBrand = brand?.name || null;
    const catalog = catalogByBrand.get(String(a.brandId)) || [];

    // 1. Exact title regex — what ensureCatalogProductForMatch tries.
    const titleEsc = escapeRegex(String(productName).trim());
    const exactRe = new RegExp('^' + titleEsc + '$', 'i');
    const exactHit = catalog.find(r => exactRe.test(r.title || ''));

    if (exactHit) {
      buckets.would_link_by_exact_title.push({ a, exactHit });
      continue;
    }

    // 2. Fuzzy: token overlap on title.
    let bestFuzzy = null;
    for (const r of catalog) {
      const ov = tokenOverlap(productName, r.title);
      if (ov >= 0.5 && (!bestFuzzy || ov > bestFuzzy.score)) {
        bestFuzzy = { row: r, score: ov };
      }
    }
    if (bestFuzzy) {
      buckets.would_link_by_fuzzy_title.push({ a, bestFuzzy });
      continue;
    }

    // 3. No catalog candidate — would have entered create path.
    // Mirror the brand-mismatch guard: blocks creation when BOTH ident
    // brand and active brand exist and don't loose-match.
    if (identBrand && activeBrand && !brandsMatchLoose(identBrand, activeBrand)) {
      buckets.brand_mismatch_blocks_create.push({ a, identBrand, activeBrand });
      continue;
    }

    // 4. No candidates AND no mismatch — would have created a new row.
    // The fact it didn't means ensureCatalogProductForMatch never ran
    // OR it threw silently.
    if (catalog.length > 0) {
      buckets.would_create_new_row.push({ a });
    } else {
      buckets.no_candidates.push({ a });
    }
  }

  console.log('\nBy certainty:');
  for (const [k, v] of Object.entries(certBuckets)) console.log(`  ${k.padEnd(10)} ${v}`);

  console.log('\nBy failure-mode bucket:');
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(35)} ${v.length}`);
  }

  for (const [k, items] of Object.entries(buckets)) {
    if (!items.length) continue;
    console.log(`\n── ${k} — ${items.length} ${items.length === 1 ? 'example' : 'examples'} (showing up to ${SAMPLE_LIMIT}) ──`);
    for (const item of items.slice(0, SAMPLE_LIMIT)) {
      const a = item.a;
      const ident = a.identification || {};
      const brand = brandById.get(String(a.brandId));
      console.log(`  artifact ${a._id}  brand=${brand?.name || a.brandId}  createdAt=${a.createdAt?.toISOString?.()}`);
      console.log(`     identification.productName = ${JSON.stringify(ident.productName)}`);
      console.log(`     identification.brand       = ${JSON.stringify(ident.brand)}`);
      console.log(`     identification.certainty   = ${ident.certainty}`);
      console.log(`     matchSource=${a.matchSource}  winner=${a.winner}  catalogVisualScore=${a.catalogVisualScore}  catalogCombinedScore=${a.catalogCombinedScore}`);
      if (item.exactHit) {
        console.log(`     → EXACT TITLE HIT: catalog ${item.exactHit._id} "${item.exactHit.title}" (source=${item.exactHit.source})`);
      }
      if (item.bestFuzzy) {
        console.log(`     → FUZZY HIT score=${item.bestFuzzy.score.toFixed(2)}: catalog ${item.bestFuzzy.row._id} "${item.bestFuzzy.row.title}" (source=${item.bestFuzzy.row.source})`);
      }
      if (item.identBrand && item.activeBrand) {
        console.log(`     → BRAND MISMATCH: ident.brand="${item.identBrand}" vs active.brand="${item.activeBrand}"`);
      }
    }
  }

  console.log('\n─'.repeat(78));
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
