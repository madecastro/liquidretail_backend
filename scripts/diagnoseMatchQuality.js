// Sample recent ProductMatchArtifacts on catalog-product runs and dump
// the query, providers, identification, and catalog scoring — so we can
// see WHY 134/154 clean-yolo runs produced zero matches and only 4 linked
// to a CatalogProduct.
//
// Read-only.

require('dotenv').config();
const mongoose = require('mongoose');

const DetectRun            = require('../models/DetectRun');
const DetectionArtifact    = require('../models/DetectionArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const Media                = require('../models/Media');
const CatalogProduct       = require('../models/CatalogProduct');

const args = process.argv.slice(2);
function pickArg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const LAST = parseInt(pickArg('--last') || '50', 10);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const runs = await DetectRun.find({ status: 'completed' })
    .sort({ createdAt: -1 }).limit(LAST).lean();
  const cleanRuns = runs.filter(r => !r.flags?.yoloFailed);
  const cleanIds  = cleanRuns.map(r => r._id);
  console.log(`sampling ${cleanRuns.length} clean-yolo runs from the last ${runs.length}`);

  const matches = await ProductMatchArtifact.find({ runId: { $in: cleanIds } }).lean();
  console.log(`total match artifacts: ${matches.length}`);

  // Outcome + linkage split
  const buckets = {};
  const linkedByOutcome = {};
  for (const m of matches) {
    const k = m.outcome || 'null';
    buckets[k] = (buckets[k] || 0) + 1;
    if (m.catalogProductId) linkedByOutcome[k] = (linkedByOutcome[k] || 0) + 1;
  }
  console.log('\n── outcomes  (linked / total) ──');
  for (const k of Object.keys(buckets)) {
    console.log(`  ${k.padEnd(20)} linked=${linkedByOutcome[k] || 0}/${buckets[k]}`);
  }

  // Provider fires
  const provKeys = {};
  const provErrs = {};
  for (const m of matches) {
    const p = m.providers || {};
    for (const k of Object.keys(p)) {
      const called = p[k]?.called ?? (p[k] != null);
      if (called) provKeys[k] = (provKeys[k] || 0) + 1;
    }
    const errs = m.errors || {};
    for (const k of Object.keys(errs)) provErrs[k] = (provErrs[k] || 0) + 1;
  }
  console.log('\n── provider fires ──');
  for (const k of Object.keys(provKeys)) console.log(`  ${k.padEnd(24)} ${provKeys[k]}`);
  if (Object.keys(provErrs).length) {
    console.log('\n── provider errors ──');
    for (const k of Object.keys(provErrs)) console.log(`  ${k.padEnd(24)} ${provErrs[k]}`);
  }

  // Scores
  const combined = matches.map(m => m.catalogCombinedScore).filter(v => typeof v === 'number');
  const visual   = matches.map(m => m.catalogVisualScore).filter(v => typeof v === 'number');
  function stats(arr) {
    if (!arr.length) return 'n=0';
    const s = arr.slice().sort((a,b)=>a-b);
    return `n=${s.length}  min=${s[0].toFixed(3)}  p50=${s[Math.floor(s.length*0.5)].toFixed(3)}  p90=${s[Math.floor(s.length*0.9)].toFixed(3)}  max=${s[s.length-1].toFixed(3)}`;
  }
  console.log('\n── catalog scores ──');
  console.log(`  combined  ${stats(combined)}`);
  console.log(`  visual    ${stats(visual)}`);

  // Sample the misses: brand_match rows on catalog-product runs
  console.log('\n── sample: catalog-product runs with match artifacts ──');
  const runById = new Map(cleanRuns.map(r => [String(r._id), r]));
  const catalogProductRunMatches = matches.filter(m => {
    const r = runById.get(String(m.runId));
    return r && r.trigger === 'catalog-sync';
  });
  console.log(`  catalog-sync source: ${catalogProductRunMatches.length} match artifacts`);

  const brandOnly = catalogProductRunMatches.filter(m => m.outcome === 'brand_match');
  console.log(`  brand_match on catalog-sync: ${brandOnly.length}`);
  const sample = brandOnly.slice(0, 5);
  for (const m of sample) {
    const media = await Media.findById(m.mediaId).select('fileUrl source').lean();
    console.log(`\n  match ${m._id}`);
    console.log(`    outcome=${m.outcome}  winner=${m.winner || 'n/a'}  matchSource=${m.matchSource || 'n/a'}`);
    console.log(`    catalogProductId=${m.catalogProductId || 'null'}  categoryId=${m.categoryId || 'null'}`);
    console.log(`    catalogCombinedScore=${m.catalogCombinedScore ?? 'n/a'}  catalogVisualScore=${m.catalogVisualScore ?? 'n/a'}`);
    console.log(`    totalMatches=${m.totalMatches ?? 'n/a'}`);
    if (m.identification) {
      const id = m.identification;
      console.log(`    identification: "${id.productName || '?'}" brand="${id.brand || '?'}" cert=${id.certainty ?? 'n/a'}`);
    }
    if (m.query) {
      const q = m.query;
      console.log(`    query: brand="${q.brand || '?'}" primarySubject="${String(q.primarySubject || '').slice(0, 80)}"`);
    }
    if (m.catalogMatch) {
      console.log(`    catalogMatch: ${JSON.stringify(m.catalogMatch).slice(0, 200)}`);
    }
    console.log(`    outcomeReasoning: "${String(m.outcomeReasoning || '').slice(0, 200)}"`);
    if (media) console.log(`    mediaSource=${media.source}  fileUrl=${media.fileUrl?.slice(0, 100)}`);
  }

  // For catalog-product runs, does the source Media hold a catalogProductRef?
  console.log('\n── catalog-product run media integrity ──');
  const catalogSyncRuns = cleanRuns.filter(r => r.trigger === 'catalog-sync');
  const mediaIds = catalogSyncRuns.map(r => r.mediaId);
  const medias = await Media.find({ _id: { $in: mediaIds } })
    .select('_id source metadata matchedProducts')
    .lean();
  const missingCatalog = medias.filter(m => !m.metadata?.catalogProductId && !(m.matchedProducts || []).length);
  console.log(`  catalog-sync runs: ${catalogSyncRuns.length}`);
  console.log(`  media rows loaded: ${medias.length}`);
  console.log(`  media with no metadata.catalogProductId AND no matchedProducts: ${missingCatalog.length}`);
  if (medias.length) {
    const withMeta = medias.filter(m => m.metadata?.catalogProductId).length;
    const withMatched = medias.filter(m => (m.matchedProducts || []).length).length;
    console.log(`  media with metadata.catalogProductId: ${withMeta}`);
    console.log(`  media with matchedProducts populated: ${withMatched}`);
  }

  await mongoose.disconnect();
})().catch(err => { console.error('fatal:', err.message); process.exit(1); });
