// Inspect the most recent DetectRun and dump every artifact it produced,
// mapped to the Step 6 walkthrough sections (YOLO chain, subjects/text,
// crops, product-match). Read-only — no writes, no cost.
//
// Usage:
//   node scripts/diagnoseLatestDetectRun.js
//   node scripts/diagnoseLatestDetectRun.js --status completed
//   node scripts/diagnoseLatestDetectRun.js --runId <objectId>
//   node scripts/diagnoseLatestDetectRun.js --brand <brandId>
//   node scripts/diagnoseLatestDetectRun.js --last 3    # 3 most recent

require('dotenv').config();
const mongoose = require('mongoose');

const DetectRun             = require('../models/DetectRun');
const DetectionArtifact     = require('../models/DetectionArtifact');
const CropArtifact          = require('../models/CropArtifact');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const Brand                 = require('../models/Brand');

let OverlayZoneArtifact = null;
let ExtendedCropArtifact = null;
try { OverlayZoneArtifact  = require('../models/OverlayZoneArtifact'); } catch (_) {}
try { ExtendedCropArtifact = require('../models/ExtendedCropArtifact'); } catch (_) {}

const args = process.argv.slice(2);
function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const RUN_ID  = pickArg('--runId');
const STATUS  = pickArg('--status');
const BRAND   = pickArg('--brand');
const LAST    = parseInt(pickArg('--last') || '1', 10);

function fmtMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtDate(d) { return d ? new Date(d).toISOString() : 'n/a'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function loadRun() {
  if (RUN_ID) {
    const r = await DetectRun.findById(RUN_ID).lean();
    return r ? [r] : [];
  }
  const q = {};
  if (STATUS) q.status = STATUS;
  if (BRAND)  q.brandId = new mongoose.Types.ObjectId(String(BRAND));
  return DetectRun.find(q).sort({ createdAt: -1 }).limit(LAST).lean();
}

async function dumpOne(run) {
  console.log('\n' + '='.repeat(72));
  console.log(`DetectRun ${run._id}`);
  console.log('='.repeat(72));

  const brand = run.brandId ? await Brand.findById(run.brandId).select('_id name').lean() : null;
  const media = await Media.findById(run.mediaId)
    .select('_id fileUrl fileType source width height brandId advertiserId metadata latestArtifacts')
    .lean();

  console.log(`  status         : ${run.status}`);
  console.log(`  stage          : ${run.stage || 'n/a'}`);
  console.log(`  trigger        : ${run.trigger}`);
  console.log(`  priority       : ${run.priority}`);
  console.log(`  createdAt      : ${fmtDate(run.createdAt)}`);
  console.log(`  startedAt      : ${fmtDate(run.startedAt)}`);
  console.log(`  completedAt    : ${fmtDate(run.completedAt)}`);
  if (run.startedAt && run.completedAt) {
    console.log(`  wall clock     : ${fmtMs(new Date(run.completedAt) - new Date(run.startedAt))}`);
  }
  console.log(`  pipelineVer    : ${run.pipelineVersion || 'n/a'}`);
  if (run.error) {
    console.log(`  error          : ${run.error}`);
    console.log(`  errorStage     : ${run.errorStage || 'n/a'}`);
  }

  console.log(`\n  brand          : ${brand ? `${brand.name} (${brand._id})` : 'n/a'}`);
  if (media) {
    console.log(`  media          : ${media._id}`);
    console.log(`    fileType     : ${media.fileType}`);
    console.log(`    source       : ${media.source}`);
    console.log(`    dims         : ${media.width || '?'}x${media.height || '?'}`);
    console.log(`    fileUrl      : ${media.fileUrl}`);
  } else {
    console.log(`  media          : MISSING (${run.mediaId})`);
  }

  console.log('\n  flags:');
  const flags = run.flags || {};
  const flagKeys = Object.keys(flags);
  if (flagKeys.length === 0) console.log('    (none)');
  else for (const k of flagKeys) console.log(`    ${pad(k, 20)} ${JSON.stringify(flags[k])}`);

  console.log('\n  stageTimings:');
  const st = run.stageTimings || {};
  const stKeys = Object.keys(st);
  if (stKeys.length === 0) console.log('    (none)');
  else {
    let total = 0;
    for (const k of stKeys) {
      const v = st[k];
      if (typeof v === 'number') { total += v; console.log(`    ${pad(k, 28)} ${fmtMs(v)}`); }
      else console.log(`    ${pad(k, 28)} ${JSON.stringify(v)}`);
    }
    console.log(`    ${pad('~sum of numeric', 28)} ${fmtMs(total)}`);
  }

  console.log('\n  modelVersions:');
  const mv = run.modelVersions || {};
  const mvKeys = Object.keys(mv);
  if (mvKeys.length === 0) console.log('    (none)');
  else for (const k of mvKeys) console.log(`    ${pad(k, 20)} ${JSON.stringify(mv[k])}`);

  // ── DetectionArtifact ────────────────────────────────────────────
  const det = await DetectionArtifact.findOne({ runId: run._id }).lean();
  console.log('\n  DetectionArtifact:');
  if (!det) console.log('    (none)');
  else {
    console.log(`    _id                ${det._id}`);
    console.log(`    type               ${det.type}   ${det.width || '?'}x${det.height || '?'}`);
    if (det.videoUrl)  console.log(`    videoDurationSec   ${det.videoDurationSec || 'n/a'}`);
    if (det.heroFrameSec != null) console.log(`    heroFrameSec       ${det.heroFrameSec}  (${det.heroReason || 'n/a'})`);

    const yolo    = Array.isArray(det.yoloProducts)    ? det.yoloProducts    : [];
    const refined = Array.isArray(det.refinedProducts) ? det.refinedProducts : [];
    console.log(`    yoloProducts       ${yolo.length}`);
    yolo.forEach((p, i) => {
      const box = `[${p.x1},${p.y1}→${p.x2},${p.y2}]`;
      const ident = p.identification;
      const idStr = ident ? ` id="${ident.label || ident.brand || ''}" cert=${ident.confidence ?? 'n/a'}` : '';
      console.log(`      #${i} ${p.className || '?'} conf=${p.confidence ?? 'n/a'} ${box}${idStr}`);
    });
    console.log(`    refinedProducts    ${refined.length}`);
    refined.forEach((p, i) => {
      const box = `[${p.x1},${p.y1}→${p.x2},${p.y2}]`;
      console.log(`      #${i} label="${p.label || '?'}" conf=${p.confidence ?? 'n/a'} ${box} src=${p.sourceDetectionId ?? 'n/a'}`);
    });

    const subjects = Array.isArray(det.subjects) ? det.subjects : [];
    const text     = Array.isArray(det.text)     ? det.text     : [];
    console.log(`    subjects           ${subjects.length}`);
    subjects.slice(0, 5).forEach((s, i) => {
      console.log(`      #${i} role="${s.role || '?'}" ${s.description ? `"${String(s.description).slice(0, 60)}"` : ''}`);
    });
    if (subjects.length > 5) console.log(`      ... +${subjects.length - 5} more`);
    console.log(`    text regions       ${text.length}`);
    text.slice(0, 5).forEach((t, i) => {
      console.log(`      #${i} "${String(t.text || t.content || '').slice(0, 60)}"`);
    });
    if (text.length > 5) console.log(`      ... +${text.length - 5} more`);

    if (det.primarySubjectId) {
      console.log(`    primarySubject     id=${det.primarySubjectId} "${String(det.primarySubjectDesc || '').slice(0, 80)}"`);
    } else {
      console.log(`    primarySubject     (none)`);
    }
    if (det.background) {
      const bg = det.background;
      console.log(`    background         setting="${bg.setting || '?'}" style="${bg.style || '?'}" lighting="${bg.lighting || '?'}"`);
    }
    if (det.safeRect) {
      const r = det.safeRect;
      console.log(`    safeRect           [${r.x1 ?? '?'},${r.y1 ?? '?'}→${r.x2 ?? '?'},${r.y2 ?? '?'}]`);
    }
  }

  // ── CropArtifact ─────────────────────────────────────────────────
  const crop = await CropArtifact.findOne({ runId: run._id }).lean();
  console.log('\n  CropArtifact:');
  if (!crop) console.log('    (none)');
  else {
    console.log(`    _id                ${crop._id}`);
    const w = crop.winners || {};
    console.log(`    winners            5:4=${w['5:4'] || 'n/a'}  1:1=${w['1:1'] || 'n/a'}  4:5=${w['4:5'] || 'n/a'}`);
    const sc = crop.smartCrops || {};
    for (const k of Object.keys(sc)) {
      const arr = Array.isArray(sc[k]) ? sc[k] : [];
      console.log(`    smartCrops[${k}]   ${arr.length} candidate(s)`);
    }
    const j = crop.judge || {};
    const jKeys = Object.keys(j);
    if (jKeys.length) console.log(`    judge keys         ${jKeys.join(', ')}`);
  }

  // ── ProductMatchArtifact ─────────────────────────────────────────
  const matches = await ProductMatchArtifact.find({ runId: run._id }).lean();
  console.log(`\n  ProductMatchArtifact  (${matches.length})`);
  for (const [i, m] of matches.entries()) {
    console.log(`    [${i}] outcome=${m.outcome} winner=${m.winner || 'n/a'} matchSource=${m.matchSource || 'n/a'}`);
    console.log(`         catalogProductId=${m.catalogProductId || 'null'}  categoryId=${m.categoryId || 'null'}`);
    console.log(`         catalogCombinedScore=${m.catalogCombinedScore ?? 'n/a'}  catalogVisualScore=${m.catalogVisualScore ?? 'n/a'}`);
    console.log(`         enrichmentTiers=[${(m.enrichmentTiers || []).join(',')}]  recommendedProducts=${(m.recommendedProducts || []).length}`);
    if (m.identification) {
      const id = m.identification;
      console.log(`         identification: "${id.productName || '?'}" brand="${id.brand || '?'}" cert=${id.certainty ?? 'n/a'} (${id.certaintyLabel || 'n/a'})`);
    }
    if (m.outcomeReasoning) console.log(`         reasoning: "${String(m.outcomeReasoning).slice(0, 120)}"`);
    if (m.errors && Object.keys(m.errors).length) {
      console.log(`         errors: ${JSON.stringify(m.errors).slice(0, 200)}`);
    }
    if (m.catalogProductId) {
      const cp = await CatalogProduct.findById(m.catalogProductId).select('title imageUrl').lean();
      if (cp) console.log(`         → linked catalog: "${cp.title}"`);
    }
  }

  // ── Optional artifacts ───────────────────────────────────────────
  if (OverlayZoneArtifact) {
    const oz = await OverlayZoneArtifact.findOne({ runId: run._id }).lean();
    if (oz) console.log(`\n  OverlayZoneArtifact  ${oz._id}  zones=${(oz.zones || []).length || Object.keys(oz.zones || {}).length}`);
  }
  if (ExtendedCropArtifact) {
    const ec = await ExtendedCropArtifact.find({ runId: run._id }).lean();
    if (ec.length) console.log(`\n  ExtendedCropArtifact  (${ec.length})`);
  }

  // ── Media.latestArtifacts denorm check ───────────────────────────
  if (media && media.latestArtifacts) {
    const la = media.latestArtifacts;
    console.log('\n  Media.latestArtifacts denorm:');
    console.log(`    detectionArtifactId  ${la.detectionArtifactId || 'n/a'}`);
    console.log(`    cropArtifactId       ${la.cropArtifactId || 'n/a'}`);
    console.log(`    productMatchIds      ${(la.productMatchArtifactIds || []).length}`);
    const detFresh = det && la.detectionArtifactId && String(la.detectionArtifactId) === String(det._id);
    console.log(`    detection points at THIS run? ${detFresh ? 'yes' : 'no'}`);
  }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const runs = await loadRun();
  if (!runs.length) {
    console.log('no DetectRun matched');
  } else {
    for (const r of runs) await dumpOne(r);
  }
  await mongoose.disconnect();
})().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
