// Executor for capability media.sourceSummary (Tier 0, brand scope).
//
// Cheap read-only lookup: for a brand, aggregate the count of Media
// rows grouped by ingestion source. The LLM calls this to answer
// "how were these posts uploaded?" — the source field on the actual
// rows is authoritative (credentials can be revoked AFTER ingest, so
// listCredentials is NOT a reliable signal about how existing media
// got there).
//
// Skips catalog-product wrapper Media (source='catalog-product' —
// internal detect infrastructure, not user-facing) and soft-deleted
// rows.
//
// SHIPPING NOTE: agent.diagnoseGaps (backlogged) would fold this into
// a broader brand-status snapshot at session start. Until that lands,
// media.sourceSummary is the targeted answer for "which refresh
// capability applies to this brand?"

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');

async function run({ req, args }) {
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

  const rows = await Media.aggregate([
    { $match: {
        brandId: new mongoose.Types.ObjectId(brand._id),
        source: { $ne: 'catalog-product' },
        deletedAt: null
      }
    },
    { $group: {
        _id: '$source',
        count:      { $sum: 1 },
        imageCount: { $sum: { $cond: [{ $eq: ['$fileType', 'image'] }, 1, 0] } },
        videoCount: { $sum: { $cond: [{ $eq: ['$fileType', 'video'] }, 1, 0] } },
        newestCreatedAt: { $max: '$createdAt' }
      }
    },
    { $sort: { count: -1 } }
  ]);

  const bySource = rows.map((r) => ({
    source:          r._id,
    count:           r.count,
    imageCount:      r.imageCount || 0,
    videoCount:      r.videoCount || 0,
    newestCreatedAt: r.newestCreatedAt || null
  }));
  const total = bySource.reduce((s, r) => s + r.count, 0);

  // Steer the LLM to the correct refresh capability per source. This
  // field is what unlocks "just tell me how to refresh comments"
  // routing without a speculative T4 invocation.
  const remedyBySource = {
    'instagram':    'media.refreshInsightsForBrand (T4) refreshes insights + comments via Meta Graph OAuth',
    'apify-ig':     'media.refreshCommentsFromApify (T4) refreshes comments via the same Apify actor used at ingest',
    'manual_upload': 'hand-uploaded — no external platform to refresh against',
    'meta':         'no refresh capability for source=meta yet',
    'tiktok':       'no refresh capability for source=tiktok yet',
    'youtube':      'no refresh capability for source=youtube yet',
    'other':        'no refresh capability for source=other'
  };

  return {
    ok: true,
    kind: 'mediaSourceSummary',
    data: {
      brand:  { _id: String(brand._id), name: brand.name },
      total,
      bySource,
      remedyBySource,
      note: total === 0
        ? 'This brand has no non-catalog-wrapper Media. Sync posts first via posts.syncFromInstagram (OAuth), catalog.pullFromApify (Apify), or upload manually via media.upload + media.finalizeUpload.'
        : 'The `source` field on each Media row is the authoritative signal for which refresh capability applies. Do NOT infer ingestion path from integrations.instagram.listCredentials — credentials can be revoked AFTER ingest, so a brand may have IG media with no live credential.'
    }
  };
}

module.exports = { run };
