#!/usr/bin/env node
'use strict';
/**
 * calibrateShotHeuristic — READ-ONLY measurement of the zero-cost shot-style
 * heuristic against the existing LLM classification.shotType labels.
 *
 * THIS IS A MEASUREMENT, NOT A THRESHOLD CHANGE.
 * It never writes to Mongo. It never mutates SHOT_STYLE_THRESHOLDS.
 * Use the printed agreement matrix + disagreement metric distributions to
 * hand-tune thresholds in services/imageShotHeuristicService.js.
 *
 * Requires BOTH signals on a Media row:
 *   - classification.shotType ∈ lifestyle|on_model|product_only|flat_lay|
 *     detail|packaging  (LLM, from subjectTextService)
 *   - technicalInsights.shotStyle ∈ packshot|lifestyle|ambiguous
 *     (heuristic, from imageShotHeuristicService via detect)
 *
 * Also reports lifestyle rate by gallery position (metadata.imageRole and
 * metadata.feedIndex) — that measurement decides whether the per-product
 * image cap should be raised further.
 *
 * Usage:
 *   node scripts/calibrateShotHeuristic.js --limit 500
 *   MONGODB_URI=... node scripts/calibrateShotHeuristic.js --limit 200
 *
 * Env: MONGODB_URI (required). No writes; no API keys beyond DB auth.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Media = require('../models/Media');
const { SHOT_STYLE_THRESHOLDS } = require('../services/imageShotHeuristicService');

const LLM_LIFESTYLE = new Set(['lifestyle', 'on_model']);
const LLM_PACKSHOT  = new Set(['product_only', 'flat_lay', 'detail', 'packaging']);

function parseArgs(argv) {
  const out = { limit: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      out.limit = Math.max(1, parseInt(argv[++i], 10) || 500);
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function llmToCoarse(shotType) {
  if (LLM_LIFESTYLE.has(shotType)) return 'lifestyle';
  if (LLM_PACKSHOT.has(shotType)) return 'packshot';
  return null;
}

function pct(n, d) {
  if (!d) return 'n/a';
  return `${((100 * n) / d).toFixed(1)}%`;
}

function quantiles(sorted, qs) {
  if (!sorted.length) return Object.fromEntries(qs.map((q) => [q, null]));
  const out = {};
  for (const q of qs) {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    out[q] = sorted[idx];
  }
  return out;
}

function summarize(nums) {
  if (!nums.length) return { n: 0 };
  const s = nums.slice().sort((a, b) => a - b);
  const q = quantiles(s, [0, 0.25, 0.5, 0.75, 1]);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    min: q[0],
    p25: q[0.25],
    p50: q[0.5],
    p75: q[0.75],
    max: q[1],
    mean: Math.round(mean * 10000) / 10000
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/calibrateShotHeuristic.js --limit 500');
    process.exit(0);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  calibrateShotHeuristic — MEASUREMENT ONLY                       ║');
  console.log('║  Read-only. Does NOT write to Mongo. Does NOT change thresholds. ║');
  console.log('║  Hand-tune SHOT_STYLE_THRESHOLDS from the distributions below.   ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Current (untuned starting) thresholds:');
  console.log(JSON.stringify(SHOT_STYLE_THRESHOLDS, null, 2));
  console.log('');

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required (read-only connection).');
    process.exit(2);
  }

  // Prefer secondary if the driver supports it; still read-only by construction
  // (this script never calls update/insert/delete).
  await mongoose.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  console.log(`connected (limit=${args.limit})`);

  const filter = {
    'classification.shotType': {
      $in: ['lifestyle', 'on_model', 'product_only', 'flat_lay', 'detail', 'packaging']
    },
    'technicalInsights.shotStyle': {
      $in: ['packshot', 'lifestyle', 'ambiguous']
    }
  };

  const rows = await Media.find(filter)
    .select({
      classification: 1,
      technicalInsights: 1,
      metadata: 1,
      source: 1,
      fileType: 1,
      createdAt: 1
    })
    .sort({ createdAt: -1 })
    .limit(args.limit)
    .lean();

  console.log(`sampled ${rows.length} Media rows with BOTH LLM shotType and heuristic shotStyle\n`);

  if (!rows.length) {
    console.log('No dual-labelled rows yet. Run detect on catalog images with');
    console.log('CATALOG_SHOT_HEURISTIC_ENABLED=true so technicalInsights.shotStyle');
    console.log('is stamped, then re-run this script.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Agreement matrix: heuristic style × LLM coarse ───────────────────────
  // Rows = heuristic, cols = LLM coarse (packshot|lifestyle)
  const matrix = {
    packshot:  { packshot: 0, lifestyle: 0 },
    lifestyle: { packshot: 0, lifestyle: 0 },
    ambiguous: { packshot: 0, lifestyle: 0 }
  };
  const byLlmFine = {}; // shotType → heuristic tallies
  const disagreements = [];

  for (const m of rows) {
    const llmFine = m.classification?.shotType;
    const llm = llmToCoarse(llmFine);
    const hs = m.technicalInsights?.shotStyle;
    if (!llm || !hs) continue;
    matrix[hs][llm] += 1;
    if (!byLlmFine[llmFine]) {
      byLlmFine[llmFine] = { packshot: 0, lifestyle: 0, ambiguous: 0, total: 0 };
    }
    byLlmFine[llmFine][hs] += 1;
    byLlmFine[llmFine].total += 1;

    const agree =
      (hs === 'packshot' && llm === 'packshot') ||
      (hs === 'lifestyle' && llm === 'lifestyle');
    if (!agree) {
      disagreements.push({
        llmFine,
        llm,
        heuristic: hs,
        confidence: m.technicalInsights?.shotStyleConfidence,
        metrics: m.technicalInsights?.shotStyleMetrics || {},
        imageRole: m.metadata?.imageRole,
        feedIndex: m.metadata?.feedIndex,
        source: m.source
      });
    }
  }

  const total = rows.length;
  const tpPack = matrix.packshot.packshot;
  const fpPack = matrix.packshot.lifestyle; // heuristic packshot, LLM lifestyle
  const fnPack = matrix.lifestyle.packshot + matrix.ambiguous.packshot;
  const tpLife = matrix.lifestyle.lifestyle;
  const fpLife = matrix.lifestyle.packshot;
  const fnLife = matrix.packshot.lifestyle + matrix.ambiguous.lifestyle;

  const precPack = tpPack / Math.max(tpPack + fpPack, 1);
  const recPack  = tpPack / Math.max(tpPack + fnPack, 1);
  const precLife = tpLife / Math.max(tpLife + fpLife, 1);
  const recLife  = tpLife / Math.max(tpLife + fnLife, 1);

  // Treat ambiguous as neither TP nor (for precision) a positive call — it is
  // a deliberate abstain. Report its rate separately.
  const ambN = matrix.ambiguous.packshot + matrix.ambiguous.lifestyle;
  const decisiveAgree = tpPack + tpLife;
  const decisiveN = total - ambN;

  console.log('── Agreement matrix (rows=heuristic, cols=LLM coarse) ──');
  console.log('                 LLM packshot   LLM lifestyle');
  console.log(`  h.packshot     ${String(matrix.packshot.packshot).padStart(12)} ${String(matrix.packshot.lifestyle).padStart(14)}`);
  console.log(`  h.lifestyle    ${String(matrix.lifestyle.packshot).padStart(12)} ${String(matrix.lifestyle.lifestyle).padStart(14)}`);
  console.log(`  h.ambiguous    ${String(matrix.ambiguous.packshot).padStart(12)} ${String(matrix.ambiguous.lifestyle).padStart(14)}`);
  console.log('');
  console.log(`n=${total}  ambiguous rate=${pct(ambN, total)}  decisive agreement=${pct(decisiveAgree, decisiveN)} (of non-ambiguous)`);
  console.log(`packshot  precision=${pct(tpPack, tpPack + fpPack)}  recall=${pct(tpPack, tpPack + fnPack)}  (ambiguous counts as miss for recall)`);
  console.log(`lifestyle precision=${pct(tpLife, tpLife + fpLife)}  recall=${pct(tpLife, tpLife + fnLife)}`);
  console.log('');

  console.log('── Per LLM shotType → heuristic distribution ──');
  for (const [fine, tallies] of Object.entries(byLlmFine).sort()) {
    console.log(
      `  ${fine.padEnd(14)} n=${String(tallies.total).padStart(4)}  ` +
      `pack=${pct(tallies.packshot, tallies.total)}  ` +
      `life=${pct(tallies.lifestyle, tallies.total)}  ` +
      `amb=${pct(tallies.ambiguous, tallies.total)}`
    );
  }
  console.log('');

  // ── Disagreement metric distributions ────────────────────────────────────
  console.log(`── Disagreements (n=${disagreements.length}) — metric distributions for threshold tuning ──`);
  const metricKeys = [
    'borderStdev', 'borderMean', 'centreStdev', 'centreBorderRatio',
    'entropy', 'packshotScore', 'borderUniform'
  ];
  // Group disagreements by kind for cleaner tuning signal
  const groups = {
    'heuristic=packshot LLM=lifestyle': disagreements.filter((d) => d.heuristic === 'packshot' && d.llm === 'lifestyle'),
    'heuristic=lifestyle LLM=packshot': disagreements.filter((d) => d.heuristic === 'lifestyle' && d.llm === 'packshot'),
    'heuristic=ambiguous (any LLM)': disagreements.filter((d) => d.heuristic === 'ambiguous')
  };
  for (const [label, list] of Object.entries(groups)) {
    console.log(`\n  [${label}] n=${list.length}`);
    if (!list.length) continue;
    for (const key of metricKeys) {
      const nums = list
        .map((d) => d.metrics?.[key])
        .filter((v) => typeof v === 'number' && Number.isFinite(v));
      const s = summarize(nums);
      if (!s.n) continue;
      console.log(
        `    ${key.padEnd(20)} n=${s.n}  min=${s.min}  p25=${s.p25}  p50=${s.p50}  p75=${s.p75}  max=${s.max}  mean=${s.mean}`
      );
    }
  }
  console.log('');

  // ── Lifestyle rate by gallery position ───────────────────────────────────
  // This is a product decision input: if later gallery slots are mostly
  // lifestyle, raising the per-product image cap is more valuable.
  console.log('── Lifestyle rate by gallery position ──');
  console.log('(LLM coarse label; heuristic lifestyle rate shown alongside)\n');

  function bucketLifestyle(list, keyFn) {
    const buckets = new Map();
    for (const m of list) {
      const key = keyFn(m);
      if (key == null) continue;
      if (!buckets.has(key)) buckets.set(key, { n: 0, llmLife: 0, hLife: 0, hPack: 0, hAmb: 0 });
      const b = buckets.get(key);
      b.n += 1;
      const llm = llmToCoarse(m.classification?.shotType);
      if (llm === 'lifestyle') b.llmLife += 1;
      const hs = m.technicalInsights?.shotStyle;
      if (hs === 'lifestyle') b.hLife += 1;
      else if (hs === 'packshot') b.hPack += 1;
      else if (hs === 'ambiguous') b.hAmb += 1;
    }
    return buckets;
  }

  const byRole = bucketLifestyle(rows, (m) => m.metadata?.imageRole ?? '(missing)');
  console.log('  by metadata.imageRole:');
  for (const [k, b] of [...byRole.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    console.log(
      `    ${String(k).padEnd(12)} n=${String(b.n).padStart(4)}  ` +
      `LLM lifestyle=${pct(b.llmLife, b.n)}  ` +
      `h.life=${pct(b.hLife, b.n)} h.pack=${pct(b.hPack, b.n)} h.amb=${pct(b.hAmb, b.n)}`
    );
  }

  const byFeed = bucketLifestyle(rows, (m) => {
    const fi = m.metadata?.feedIndex;
    if (fi == null || fi === '') return '(missing)';
    const n = Number(fi);
    if (!Number.isFinite(n)) return String(fi);
    if (n <= 0) return '0 (primary)';
    if (n === 1) return '1';
    if (n === 2) return '2';
    if (n <= 5) return '3-5';
    return '6+';
  });
  console.log('\n  by metadata.feedIndex (catalog order):');
  const feedOrder = ['0 (primary)', '1', '2', '3-5', '6+', '(missing)'];
  for (const k of feedOrder) {
    const b = byFeed.get(k);
    if (!b) continue;
    console.log(
      `    ${k.padEnd(12)} n=${String(b.n).padStart(4)}  ` +
      `LLM lifestyle=${pct(b.llmLife, b.n)}  ` +
      `h.life=${pct(b.hLife, b.n)} h.pack=${pct(b.hPack, b.n)} h.amb=${pct(b.hAmb, b.n)}`
    );
  }

  console.log('\n── source mix of sample ──');
  const bySource = new Map();
  for (const m of rows) {
    const s = m.source || '(null)';
    bySource.set(s, (bySource.get(s) || 0) + 1);
  }
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }

  console.log('\n(done — measurement only; thresholds unchanged)\n');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('calibrateShotHeuristic failed:', err);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
