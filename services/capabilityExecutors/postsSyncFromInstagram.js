// Executor for capability posts.syncFromInstagram (Tier 4, brand scope).
//
// Two-phase workflow — pull a brand's Instagram posts (feed + reels)
// via the IG Graph API. Wraps postSyncService.syncPosts, same service
// the /api/integrations/instagram/sync-posts route invokes and same
// one onboarding.dispatchSyncs fans out. Standalone so an operator
// can trigger just the posts leg without the whole dispatch bundle.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');
const IntegrationCredential = require('../../models/IntegrationCredential');
const { syncPosts } = require('../postSyncService');

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

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const [creds, existing] = await Promise.all([
    IntegrationCredential.find({
      brandId: brand._id,
      type: 'instagram',
      status: 'active',
      igUserId: { $exists: true, $ne: null }
    }).select('_id igUsername igUserId lastPostsSyncAt').lean(),
    Media.countDocuments({ brandId: brand._id, source: 'instagram' })
  ]);

  if (!creds.length) {
    return { ok: false, error: 'no active Instagram credential with an igUserId for this brand — connect Instagram + select an IG account first' };
  }

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'posts.syncFromInstagram',
      brand: { _id: String(brand._id), name: brand.name },
      credentials: creds.map((c) => ({
        _id: String(c._id),
        igUsername: c.igUsername || null,
        igUserId:   c.igUserId,
        lastPostsSyncAt: c.lastPostsSyncAt || null
      })),
      existingMediaCount: existing,
      summary: `Pull IG posts (feed + reels) for ${brand.name} across ${creds.length} active credential(s). Upserts Media rows and enqueues DetectRuns for new posts.`,
      estimateUsd:    0,
      estimateWallMs: 60_000,
      reversible:     false,
      note: 'HTTP-only (Meta Graph API). Detect enqueue is inline per post; DetectRun processing runs in the worker.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  if (typeof onProgress === 'function') {
    try { onProgress({ step: 1, totalSteps: null, stage: 'ingesting IG posts', outcome: 'running' }); }
    catch (_) { /* ignore */ }
  }

  let result;
  try {
    result = await syncPosts(String(brand._id), {});
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `posts sync failed: ${err.message}`,
      data: { workflowId: 'posts.syncFromInstagram', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: (result?.ok !== false),
    kind: 'workflowResult',
    data: {
      workflowId: 'posts.syncFromInstagram',
      brand: { _id: String(brand._id), name: brand.name },
      fetched:      result?.fetched     || 0,
      ingested:     result?.ingested    || 0,
      skipped:      result?.skipped     || 0,
      capSkipped:   result?.capSkipped  || 0,
      errors:       result?.errors      || 0,
      queuedRunIds: result?.queuedRunIds || [],
      perCredential: result?.perCredential || null,
      reason:       result?.reason || null,
      durationMs:   Date.now() - started,
      note: 'IG post upsert complete. DetectRuns queued per new post; the worker processes them next tick.'
    }
  };
}

module.exports = { preview, execute };
