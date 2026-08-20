// Executor for capability ad.list (Tier 0, brand scope).
//
// Lists recent Ads for one brand with optional filters (kind, status,
// sinceHoursAgo). Fills the gap ad.inspect leaves: the operator asks
// "show me my most recent ads" without an id in hand.
//
// Tenant-scoped via req.advertiserId + Brand lookup. Never leaks a
// count that includes cross-tenant rows.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
// Same joins the /api/ads endpoint uses to hydrate photorealUrl (the
// gpt-image-1 polish) + the campaign-level useImageRefAsProduction
// flag. Copying those into the agent's ad.list response keeps the
// AdThumbnail render logic identical across every surface.
const { loadPhotorealUrlMap, loadUseImageRefMap } = require('../adDisplayUrlService');
// The same two grid-tile URL builders routes/ads.js projectAd() and
// routes/catalog.js's /:id/ads-detail already use, so all three surfaces
// that hand Ad rows to the frontend agree on the tile variant.
const { buildGridPreviewVideoUrl } = require('../videoPreviewUrl');
const { buildGridPreviewImageUrl } = require('../imagePreviewUrl');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const AD_KINDS = ['image', 'video'];
const AD_STATUSES = ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'];

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

  const kind = typeof args?.kind === 'string' && AD_KINDS.includes(args.kind) ? args.kind : null;
  const status = typeof args?.status === 'string' && AD_STATUSES.includes(args.status) ? args.status : null;
  const limit = Math.min(Math.max(1, Number(args?.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const hoursRaw = Number(args?.sinceHoursAgo);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? Math.min(hoursRaw, MAX_HOURS)
    : DEFAULT_HOURS;
  const since = new Date(Date.now() - hours * 3_600_000);

  const filter = { brandId: brand._id, createdAt: { $gte: since } };
  if (kind)   filter.kind   = kind;
  if (status) filter.status = status;

  const [total, ads] = await Promise.all([
    Ad.countDocuments(filter),
    Ad.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      // Wider projection so the agent's ad list can render with the
      // same AdThumbnail + AdDetailModal the Product Ads / UGC Ads /
      // Campaign Detail pages use. Kind/template/status/renderUrl were
      // the original set; the rest (posterUrl, copy, ctaText, variant-
      // Kind, mediaId, approved*, regeneration*, meta*, sourceFileType)
      // are what the shared frontend components read.
      .select('_id kind template aspectRatio platformFormat status renderUrl posterUrl copy ctaText productId campaignId createdAt updatedAt renderedAt metaSyncStatus metaAdId metaAdsetId variantKind mediaId sourceFileType approved approvedAt regenerating regenerationStage regenerationHistory aiCanvasArtifactId')
      .lean()
  ]);

  // Same photorealUrl / useImageRefAsProduction join /api/ads does so
  // the frontend picks the right display URL for image ads (Phase B
  // polish is preferred when populated).
  const [photorealMap, useImageRefMap] = await Promise.all([
    loadPhotorealUrlMap(ads),
    loadUseImageRefMap(ads)
  ]);

  return {
    ok: true,
    kind: 'adList',
    data: {
      brand:  { _id: String(brand._id), name: brand.name },
      window: { hours, since: since.toISOString() },
      filter: { kind, status },
      total,
      sampleCount: ads.length,
      ads: ads.map((a) => ({
        _id:            String(a._id),
        kind:           a.kind,
        template:       a.template,
        aspectRatio:    a.aspectRatio,
        platformFormat: a.platformFormat,
        status:         a.status,
        renderUrl:      a.renderUrl || null,
        posterUrl:      a.posterUrl || null,
        photorealUrl:   photorealMap.get(String(a._id)) || null,
        useImageRefAsProduction: a.campaignId
          ? !!useImageRefMap.get(String(a.campaignId))
          : false,
        // Downscaled/auto-quality Cloudinary variants for the agent's
        // resource-card grid (frontend agent/ResourceCard.tsx → AdThumbnail),
        // so a chat card holding N tiles stops pulling N full-resolution
        // masters. Identical derivation to projectAd()/ads-detail: video ads
        // get previewVideoUrl, everything else gets previewImageUrl off
        // whichever asset the frontend actually displays (photoreal polish
        // when present, else the raw render). Detail views (AdInspectCard /
        // AdDetailModal) keep reading renderUrl/photorealUrl untouched. Both
        // builders return their input unchanged for a non-Cloudinary or
        // otherwise untransformable URL, so older renders still get a usable
        // src — just not a downscaled one.
        previewVideoUrl: a.kind === 'video' ? buildGridPreviewVideoUrl(a.renderUrl || null) : null,
        previewImageUrl: a.kind === 'video'
          ? null
          : buildGridPreviewImageUrl(photorealMap.get(String(a._id)) || a.renderUrl || null),
        copy:           a.copy || {},
        ctaText:        a.ctaText || null,
        productId:      a.productId ? String(a.productId) : null,
        campaignId:     a.campaignId ? String(a.campaignId) : null,
        variantKind:    a.variantKind || null,
        mediaId:        a.mediaId ? String(a.mediaId) : null,
        sourceFileType: a.sourceFileType || null,
        approved:       !!a.approved,
        approvedAt:     a.approvedAt || null,
        regenerating:   !!a.regenerating,
        regenerationStage: a.regenerationStage || null,
        regenerationHistory: Array.isArray(a.regenerationHistory) ? a.regenerationHistory : [],
        createdAt:      a.createdAt,
        renderedAt:     a.renderedAt || null,
        updatedAt:      a.updatedAt || null,
        metaSyncStatus: a.metaSyncStatus || null,
        metaAdId:       a.metaAdId || null,
        metaAdsetId:    a.metaAdsetId || null,
        metaSynced:     a.metaSyncStatus === 'synced'
      }))
    }
  };
}

module.exports = { run };
