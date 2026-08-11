// Executor for capability catalog.detectProductsFromMedia (Tier 4, brand scope).
//
// Two-phase workflow that enqueues DetectRuns for a brand's Media that
// have never had a strong match — mirrors the "auto-filter" mode of
// POST /api/detect/rematch. New DetectRuns land with
// trigger='manual-rematch' + priority:1 so the worker picks them up
// ahead of routine catalog/ig-sync runs.
//
// Fire-and-forget from the workflow's point of view: execute() returns
// as soon as the runs are created; the actual detect pipeline (YOLO,
// Gemini identify, matching, crops) runs asynchronously in the worker.
// Operators can watch progress via run.status per-DetectRun ids.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');
const DetectRun = require('../../models/DetectRun');
const ProductMatchArtifact = require('../../models/ProductMatchArtifact');

const MAX_STEPS_PER_RUN = 50;
const PER_UNIT_ESTIMATE_USD = 0.05;   // YOLO + Gemini identify per image

async function resolveScope({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

// Media under the brand that have NOT produced a strong-match PMA.
// Excludes catalog-product wrappers and soft-deleted rows.
async function selectTargets({ brandId, fileType }) {
  const strongMatchMediaIds = await ProductMatchArtifact.distinct('mediaId', {
    brandId,
    outcome: { $in: ['product_match', 'product_category'] }
  });
  const strongSet = new Set(strongMatchMediaIds.map((id) => String(id)));

  const filter = {
    brandId,
    source: { $ne: 'catalog-product' },
    deletedAt: null
  };
  if (fileType) filter.fileType = fileType;

  const all = await Media.find(filter)
    .select('_id fileType advertiserId brandId source')
    .limit(500)
    .lean();
  return all
    .filter((m) => !strongSet.has(String(m._id)))
    .slice(0, MAX_STEPS_PER_RUN);
}

async function preview({ req, args }) {
  const fileType = args?.fileType || null;
  if (fileType && !['image', 'video'].includes(fileType)) {
    return { ok: false, error: 'fileType must be "image" or "video" (or omit for both)' };
  }
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const targets = await selectTargets({ brandId: brand._id, fileType });
  const estimateUsd = Math.round(targets.length * PER_UNIT_ESTIMATE_USD * 100) / 100;

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.detectProductsFromMedia',
      brand: { _id: String(brand._id), name: brand.name },
      summary: `Enqueue detect for ${targets.length} media under ${brand.name} that lack a strong product match. Runs land as trigger='manual-rematch' priority:1 — the worker picks them up.`,
      totalSteps:    targets.length,
      estimateUsd,
      estimateWallMs: targets.length * 8000,   // rough worker throughput
      reversible:    false,
      fileType:      fileType || 'any',
      sampleSteps:   targets.slice(0, 10).map((m) => ({
        mediaId:   String(m._id),
        fileType:  m.fileType
      })),
      note: 'The workflow enqueues DetectRuns and returns immediately. Actual pipeline execution happens in the worker (~8s per image on average). Use run.status to watch a specific runId if needed.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const fileType = args?.fileType || null;
  if (fileType && !['image', 'video'].includes(fileType)) {
    return { ok: false, error: 'fileType must be "image" or "video" (or omit for both)' };
  }
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  const targets = await selectTargets({ brandId: brand._id, fileType });
  const enqueued = [];
  const failed = [];

  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    try {
      const run = await DetectRun.create({
        advertiserId: m.advertiserId,
        brandId:      m.brandId,
        mediaId:      m._id,
        trigger:      'manual-rematch',
        priority:     1
      });
      enqueued.push({ mediaId: String(m._id), runId: String(run._id) });
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            step:       i + 1,
            totalSteps: targets.length,
            mediaId:    String(m._id),
            runId:      String(run._id),
            outcome:    'enqueued'
          });
        } catch (_) { /* progress errors never fail the workflow */ }
      }
    } catch (err) {
      failed.push({ mediaId: String(m._id), reason: err.message });
    }
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.detectProductsFromMedia',
      brand: { _id: String(brand._id), name: brand.name },
      totalSteps:    targets.length,
      succeeded:     enqueued.length,
      failed:        failed.length,
      runIds:        enqueued.map((e) => e.runId),
      failureReasons: failed,
      durationMs:    Date.now() - started,
      note: `${enqueued.length} DetectRun(s) enqueued. The worker processes them asynchronously; expect real detection to complete within a few minutes.`
    }
  };
}

module.exports = { preview, execute, MAX_STEPS_PER_RUN, PER_UNIT_ESTIMATE_USD };
