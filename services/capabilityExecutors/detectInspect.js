// Executor for capability detect.inspect (Tier 0, brand scope).
//
// Read-only dump of a DetectRun and all its artifacts, shaped for
// answering "why did this run fail / what did it produce?" from the
// agent surface. Same information the diagnoseLatestDetectRun.js CLI
// script prints, projected for LLM context (compact, no full base64
// or long arrays).
//
// Input shapes:
//   { runId }                     inspect exactly this run
//   { mediaId }                   inspect the most recent run for this media
//   { mediaId, latest: false }    list all runs for this media (up to 5)

'use strict';

const mongoose = require('mongoose');

const DetectRun            = require('../../models/DetectRun');
const DetectionArtifact    = require('../../models/DetectionArtifact');
const CropArtifact         = require('../../models/CropArtifact');
const ProductMatchArtifact = require('../../models/ProductMatchArtifact');
const Media                = require('../../models/Media');
const Brand                = require('../../models/Brand');
const CatalogProduct       = require('../../models/CatalogProduct');

let OverlayZoneArtifact  = null;
let ExtendedCropArtifact = null;
try { OverlayZoneArtifact  = require('../../models/OverlayZoneArtifact'); } catch (_) {}
try { ExtendedCropArtifact = require('../../models/ExtendedCropArtifact'); } catch (_) {}

const MAX_RUNS_LIST = 5;

async function loadRuns({ runId, mediaId, latest, req }) {
  if (runId) {
    if (!mongoose.isValidObjectId(runId)) {
      return { error: `runId "${runId}" is not a valid ObjectId` };
    }
    const run = await DetectRun.findOne({
      _id: runId,
      advertiserId: req.advertiserId
    }).lean();
    return { runs: run ? [run] : [] };
  }
  if (!mongoose.isValidObjectId(mediaId)) {
    return { error: `mediaId "${mediaId}" is not a valid ObjectId` };
  }
  // Tenant guard via Media.
  const media = await Media.findOne({ _id: mediaId, advertiserId: req.advertiserId })
    .select('_id').lean();
  if (!media) return { runs: [] };
  const cursor = DetectRun.find({ mediaId, advertiserId: req.advertiserId })
    .sort({ createdAt: -1 })
    .limit(latest === false ? MAX_RUNS_LIST : 1);
  return { runs: await cursor.lean() };
}

function summarizeYolo(list) {
  return (list || []).slice(0, 20).map((p, i) => ({
    id: p.id || `#${i}`,
    className: p.className || null,
    confidence: p.confidence ?? null,
    bbox: [p.x1, p.y1, p.x2, p.y2],
    identLabel: p.identification?.label || null,
    identBrand: p.identification?.brand || null
  }));
}
function summarizeRefined(list) {
  return (list || []).slice(0, 20).map(p => ({
    id: p.id || null,
    label: p.label || null,
    confidence: p.confidence ?? null,
    bbox: [p.x1, p.y1, p.x2, p.y2],
    sourceDetectionId: p.sourceDetectionId ?? null,
    hasCroppedUrl: !!p.croppedImageUrl
  }));
}

async function dumpRun(run) {
  const [media, det, crop, matches] = await Promise.all([
    Media.findById(run.mediaId).select('_id fileUrl fileType source width height metadata').lean(),
    DetectionArtifact.findOne({ runId: run._id }).lean(),
    CropArtifact.findOne({ runId: run._id }).lean(),
    ProductMatchArtifact.find({ runId: run._id }).lean()
  ]);
  const overlay  = OverlayZoneArtifact  ? await OverlayZoneArtifact.findOne({ runId: run._id }).select('_id').lean() : null;
  const extended = ExtendedCropArtifact ? await ExtendedCropArtifact.find({ runId: run._id }).select('_id').lean() : [];

  const brand = run.brandId ? await Brand.findById(run.brandId).select('_id name').lean() : null;

  // Enrich linked catalog names for match rows without a follow-up call.
  const linkedIds = matches.map(m => m.catalogProductId).filter(Boolean);
  const linked = linkedIds.length
    ? await CatalogProduct.find({ _id: { $in: linkedIds } }).select('_id title').lean()
    : [];
  const linkedById = new Map(linked.map(p => [String(p._id), p.title]));

  return {
    runId:     String(run._id),
    status:    run.status,
    stage:     run.stage || null,
    trigger:   run.trigger,
    priority:  run.priority,
    createdAt:   run.createdAt,
    startedAt:   run.startedAt || null,
    completedAt: run.completedAt || null,
    wallClockMs: run.startedAt && run.completedAt
      ? new Date(run.completedAt) - new Date(run.startedAt) : null,
    pipelineVersion: run.pipelineVersion || null,
    error:      run.error || null,
    errorStage: run.errorStage || null,
    flags:      run.flags || {},
    stageTimings: run.stageTimings || {},
    modelVersions: run.modelVersions || {},

    brand: brand ? { id: String(brand._id), name: brand.name } : null,
    media: media ? {
      id:       String(media._id),
      fileType: media.fileType,
      source:   media.source,
      width:    media.width || null,
      height:   media.height || null,
      fileUrl:  media.fileUrl,
      catalogProductId: media.metadata?.catalogProductId ? String(media.metadata.catalogProductId) : null
    } : null,

    detection: det ? {
      id:             String(det._id),
      type:           det.type,
      width:          det.width,
      height:         det.height,
      yoloProducts:   summarizeYolo(det.yoloProducts),
      yoloCount:      (det.yoloProducts || []).length,
      refinedProducts: summarizeRefined(det.refinedProducts),
      refinedCount:   (det.refinedProducts || []).length,
      subjects: (det.subjects || []).map(s => ({ id: s.id, role: s.role, description: (s.description || '').slice(0, 200) })),
      textCount: (det.text || []).length,
      background: det.background ? {
        setting:  det.background.setting || null,
        style:    det.background.style || null,
        lighting: det.background.lighting || null
      } : null,
      primarySubjectId:   det.primarySubjectId || null,
      primarySubjectDesc: (det.primarySubjectDesc || '').slice(0, 200) || null,
      safeRect:           det.safeRect || null
    } : null,

    crop: crop ? {
      id: String(crop._id),
      winners: crop.winners || {},
      candidateCounts: Object.fromEntries(Object.entries(crop.smartCrops || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
      judgeKeys: crop.judge ? Object.keys(crop.judge) : []
    } : null,

    productMatches: matches.map(m => ({
      id: String(m._id),
      productIndex: m.productIndex ?? null,
      outcome: m.outcome || null,
      winner:  m.winner  || null,
      matchSource: m.matchSource || null,
      catalogProductId: m.catalogProductId ? String(m.catalogProductId) : null,
      catalogTitle:     m.catalogProductId ? (linkedById.get(String(m.catalogProductId)) || null) : null,
      categoryId: m.categoryId ? String(m.categoryId) : null,
      catalogVisualScore:   m.catalogVisualScore ?? null,
      catalogCombinedScore: m.catalogCombinedScore ?? null,
      enrichmentTiers: m.enrichmentTiers || [],
      recommendedCount: (m.recommendedProducts || []).length,
      identification: m.identification ? {
        productName: m.identification.productName || null,
        brand:       m.identification.brand || null,
        certainty:   m.identification.certainty ?? null,
        certaintyLabel: m.identification.certaintyLabel || null
      } : null,
      outcomeReasoning: (m.outcomeReasoning || '').slice(0, 300) || null,
      errors: m.errors && Object.keys(m.errors).length ? m.errors : null
    })),
    productMatchCount: matches.length,

    overlayZonesArtifactId:  overlay ? String(overlay._id) : null,
    extendedCropArtifactIds: extended.map(e => String(e._id))
  };
}

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const runId   = args?.runId || null;
  const mediaId = args?.mediaId || null;
  const latest  = args?.latest !== false;

  if (!runId && !mediaId) {
    return { ok: false, error: 'runId or mediaId required' };
  }

  const { runs, error } = await loadRuns({ runId, mediaId, latest, req });
  if (error) return { ok: false, error };
  if (!runs.length) {
    return { ok: false, error: 'no DetectRun found in tenant scope' };
  }

  const dumps = await Promise.all(runs.map(dumpRun));
  return {
    ok:   true,
    kind: 'detectInspect',
    data: {
      count: dumps.length,
      runs:  dumps
    }
  };
}

module.exports = { run };
