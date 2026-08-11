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

  const [creds, existing, sourceBreakdown] = await Promise.all([
    IntegrationCredential.find({
      brandId: brand._id,
      type: 'instagram',
      status: 'active',
      igUserId: { $exists: true, $ne: null }
    }).select('_id igUsername igUserId lastPostsSyncAt').lean(),
    Media.countDocuments({ brandId: brand._id, source: 'instagram' }),
    // Ingestion-source distribution across the brand's non-catalog-
    // wrapper media. When the OAuth path has no cred but the brand
    // DOES have Media from apify-ig / manual_upload / etc., the LLM
    // needs to know so it can steer the operator to the right
    // capability (catalog.pullFromApify for demo brands, media.upload
    // for hand-loaded, etc.).
    Media.aggregate([
      { $match: {
          brandId: new mongoose.Types.ObjectId(brand._id),
          source: { $ne: 'catalog-product' },
          deletedAt: null
        }
      },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])
  ]);

  const sourceCounts = Object.fromEntries((sourceBreakdown || []).map((r) => [r._id, r.count]));

  if (!creds.length) {
    // Steer the LLM: report which OTHER ingestion paths this brand
    // already has content from, and name the capability to reach for
    // each. The dispatcher's error field is what the LLM sees back;
    // making it capability-explicit is what unlocks the chain.
    const alt = [];
    if (sourceCounts['apify-ig']) {
      alt.push(`${sourceCounts['apify-ig']} rows from source=apify-ig (Apify IG scraper — for demo brands, invoke catalog.pullFromApify or sales.brand.sync)`);
    }
    if (sourceCounts['manual_upload']) {
      alt.push(`${sourceCounts['manual_upload']} rows from source=manual_upload (hand-uploaded — invoke media.upload + media.finalizeUpload for more)`);
    }
    if (sourceCounts['instagram']) {
      alt.push(`${sourceCounts['instagram']} rows from source=instagram (OAuth path — the credential this workflow needs was disconnected or was never fully picker-completed; invoke integrations.instagram.connectUrl to reconnect)`);
    }
    const suffix = alt.length
      ? ` This brand DOES have media from other ingestion paths: ${alt.join('; ')}.`
      : ' This brand has no existing media from any IG ingestion path.';
    return {
      ok: false,
      error: `no active Instagram credential with an igUserId for this brand — the posts.syncFromInstagram workflow uses the Meta Graph OAuth path.${suffix} If the operator wants to re-pull via the SAME path that already has media, use the capability named above rather than this one. To connect a new OAuth credential, invoke integrations.instagram.connectUrl.`,
      sourceCounts
    };
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
