// Aggregate summary of recent DetectRuns: yolo failure rate, latency
// distribution, orphan/timeout patterns, ProductMatch outcomes. Read-only.
//
// Usage:
//   node scripts/summarizeRecentDetectRuns.js --last 100
//   node scripts/summarizeRecentDetectRuns.js --hours 24
//   node scripts/summarizeRecentDetectRuns.js --brand <brandId> --last 200

require('dotenv').config();
const mongoose = require('mongoose');

const DetectRun            = require('../models/DetectRun');
const DetectionArtifact    = require('../models/DetectionArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');

const args = process.argv.slice(2);
function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const LAST  = parseInt(pickArg('--last')  || '100', 10);
const HOURS = pickArg('--hours') ? parseFloat(pickArg('--hours')) : null;
const BRAND = pickArg('--brand');

function pct(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[idx];
}
function fmtMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const q = {};
  if (BRAND) q.brandId = new mongoose.Types.ObjectId(String(BRAND));
  if (HOURS) q.createdAt = { $gte: new Date(Date.now() - HOURS * 3600 * 1000) };

  const runs = await DetectRun.find(q).sort({ createdAt: -1 }).limit(LAST).lean();
  if (!runs.length) { console.log('no runs'); await mongoose.disconnect(); return; }

  const byStatus = {};
  const yoloFailed = [];
  const wallClocks = [];
  const yoloTimes  = [];
  const subjectsTimes = [];
  const cropRefineTimes = [];
  const triggers = {};
  const brands   = {};
  const errorBuckets = {};
  const runIds = runs.map(r => r._id);

  for (const r of runs) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    triggers[r.trigger] = (triggers[r.trigger] || 0) + 1;
    if (r.brandId) {
      const k = String(r.brandId);
      brands[k] = (brands[k] || 0) + 1;
    }
    if (r.flags?.yoloFailed) yoloFailed.push(r);
    if (r.startedAt && r.completedAt) wallClocks.push(new Date(r.completedAt) - new Date(r.startedAt));
    const st = r.stageTimings || {};
    if (typeof st.yolo === 'number') yoloTimes.push(st.yolo);
    if (typeof st['subjects-text'] === 'number') subjectsTimes.push(st['subjects-text']);
    if (typeof st['crop-refine'] === 'number') cropRefineTimes.push(st['crop-refine']);
    if (r.error) {
      const k = r.error.slice(0, 60);
      errorBuckets[k] = (errorBuckets[k] || 0) + 1;
    }
  }

  console.log(`\n=== ${runs.length} runs (newest → oldest) ===`);
  console.log(`window: ${new Date(runs[runs.length - 1].createdAt).toISOString()}  →  ${new Date(runs[0].createdAt).toISOString()}`);
  console.log('\n── status ──');
  for (const k of Object.keys(byStatus)) console.log(`  ${k.padEnd(12)} ${byStatus[k]}`);

  console.log('\n── trigger ──');
  for (const k of Object.keys(triggers)) console.log(`  ${k.padEnd(20)} ${triggers[k]}`);

  console.log('\n── YOLO failure rate ──');
  const yfRate = yoloFailed.length / runs.length;
  console.log(`  flags.yoloFailed=true : ${yoloFailed.length} / ${runs.length}  (${(yfRate * 100).toFixed(1)}%)`);
  if (yoloFailed.length) {
    const errors = {};
    for (const r of yoloFailed) {
      const e = r.flags?.yoloError || '(no yoloError)';
      errors[e] = (errors[e] || 0) + 1;
    }
    for (const k of Object.keys(errors)) console.log(`    "${k}" × ${errors[k]}`);
  }

  console.log('\n── run wall clock ──');
  if (wallClocks.length) {
    console.log(`  p50 ${fmtMs(pct(wallClocks, 0.5))}  p90 ${fmtMs(pct(wallClocks, 0.9))}  p99 ${fmtMs(pct(wallClocks, 0.99))}  max ${fmtMs(Math.max(...wallClocks))}`);
  }

  console.log('\n── yolo stage timing ──');
  if (yoloTimes.length) {
    console.log(`  n=${yoloTimes.length}  p50 ${fmtMs(pct(yoloTimes, 0.5))}  p90 ${fmtMs(pct(yoloTimes, 0.9))}  p99 ${fmtMs(pct(yoloTimes, 0.99))}  max ${fmtMs(Math.max(...yoloTimes))}`);
    const over120 = yoloTimes.filter(t => t > 120000).length;
    const over60  = yoloTimes.filter(t => t > 60000).length;
    console.log(`  > 60s : ${over60} (${(over60 / yoloTimes.length * 100).toFixed(1)}%)`);
    console.log(`  >120s : ${over120} (${(over120 / yoloTimes.length * 100).toFixed(1)}%)  ← past axios client timeout`);
  }

  console.log('\n── subjects-text stage timing ──');
  if (subjectsTimes.length) {
    console.log(`  n=${subjectsTimes.length}  p50 ${fmtMs(pct(subjectsTimes, 0.5))}  p90 ${fmtMs(pct(subjectsTimes, 0.9))}`);
  }

  console.log('\n── crop-refine stage timing ──');
  if (cropRefineTimes.length) {
    console.log(`  n=${cropRefineTimes.length}  p50 ${fmtMs(pct(cropRefineTimes, 0.5))}  p90 ${fmtMs(pct(cropRefineTimes, 0.9))}`);
  }

  if (Object.keys(errorBuckets).length) {
    console.log('\n── run.error buckets ──');
    for (const k of Object.keys(errorBuckets)) console.log(`  "${k}" × ${errorBuckets[k]}`);
  }

  // Downstream: on the succeeded runs, did product matching produce anything?
  const okRuns    = runs.filter(r => r.status === 'completed');
  const failedYolo = okRuns.filter(r => r.flags?.yoloFailed);
  const cleanYolo  = okRuns.filter(r => !r.flags?.yoloFailed);

  const okIds       = okRuns.map(r => r._id);
  const failedIds   = failedYolo.map(r => r._id);
  const cleanIds    = cleanYolo.map(r => r._id);

  const [detsAll, matchesAll] = await Promise.all([
    DetectionArtifact.find({ runId: { $in: okIds } }).select('runId yoloProducts refinedProducts').lean(),
    ProductMatchArtifact.find({ runId: { $in: okIds } }).select('runId outcome catalogProductId').lean()
  ]);
  const detByRun = new Map();
  for (const d of detsAll) detByRun.set(String(d.runId), d);

  function detectionShape(ids) {
    let ry = 0, rr = 0, zeroY = 0, zeroR = 0;
    for (const id of ids) {
      const d = detByRun.get(String(id));
      const y = d ? (d.yoloProducts?.length || 0) : 0;
      const rf = d ? (d.refinedProducts?.length || 0) : 0;
      ry += y; rr += rf;
      if (y === 0) zeroY++;
      if (rf === 0) zeroR++;
    }
    return { avgY: ry / (ids.length || 1), avgR: rr / (ids.length || 1), zeroY, zeroR, total: ids.length };
  }
  const clean  = detectionShape(cleanIds);
  const failed = detectionShape(failedIds);
  console.log('\n── detection output per COMPLETED run ──');
  console.log(`  yoloFailed=false : n=${clean.total}   avg yolo=${clean.avgY.toFixed(1)}  avg refined=${clean.avgR.toFixed(1)}   zero-yolo=${clean.zeroY}  zero-refined=${clean.zeroR}`);
  console.log(`  yoloFailed=true  : n=${failed.total}  avg yolo=${failed.avgY.toFixed(1)}  avg refined=${failed.avgR.toFixed(1)}  zero-yolo=${failed.zeroY}  zero-refined=${failed.zeroR}`);

  // ProductMatch outcomes
  console.log('\n── ProductMatchArtifact per completed run ──');
  const matchesByRun = new Map();
  for (const m of matchesAll) {
    const k = String(m.runId);
    if (!matchesByRun.has(k)) matchesByRun.set(k, []);
    matchesByRun.get(k).push(m);
  }
  function matchShape(ids) {
    let noMatches = 0, withMatches = 0, linkedCount = 0, totalMatches = 0;
    const outcomes = {};
    for (const id of ids) {
      const ms = matchesByRun.get(String(id)) || [];
      if (!ms.length) noMatches++; else withMatches++;
      totalMatches += ms.length;
      for (const m of ms) {
        outcomes[m.outcome || 'null'] = (outcomes[m.outcome || 'null'] || 0) + 1;
        if (m.catalogProductId) linkedCount++;
      }
    }
    return { noMatches, withMatches, linkedCount, totalMatches, outcomes };
  }
  const cleanM  = matchShape(cleanIds);
  const failedM = matchShape(failedIds);
  console.log(`  yoloFailed=false : ${cleanM.noMatches}/${cleanIds.length} runs produced ZERO matches   totalMatches=${cleanM.totalMatches}  linkedToCatalog=${cleanM.linkedCount}`);
  console.log(`    outcomes: ${JSON.stringify(cleanM.outcomes)}`);
  console.log(`  yoloFailed=true  : ${failedM.noMatches}/${failedIds.length} runs produced ZERO matches   totalMatches=${failedM.totalMatches}  linkedToCatalog=${failedM.linkedCount}`);
  console.log(`    outcomes: ${JSON.stringify(failedM.outcomes)}`);

  console.log('\n── brand distribution (top 5) ──');
  const bList = Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [k, v] of bList) console.log(`  ${k}  ${v}`);

  await mongoose.disconnect();
})().catch(err => { console.error('fatal:', err.message); process.exit(1); });
