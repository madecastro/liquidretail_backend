const express = require('express');
const router = express.Router();
const Media = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const Comment = require('../models/Comment');
const { tenantFilter, assertMediaInTenant } = require('../middleware/tenantHelpers');
const { maybeCreateDraftFromMatch } = require('../services/catalogProductDraftService');
const { refreshInsightsForMedia, fetchCommentsForMedia } = require('../services/mediaInsightsService');
const { assembleResult } = require('./detect');

// GET /api/media
// Paginated list of media — most recent first. Supports `?ready=true` to
// filter to media with at least the detection artifact attached (the
// minimum needed for the layout-input service to assemble a creative
// preview). Optional `?limit=N` (default 24, capped at 100) and
// `?offset=N` for pagination.
//
// Each row carries enough for a thumbnail picker: id, fileUrl,
// fileType, fileName, source, brand (from metadata.brand), createdAt,
// rightsApproved, and a `ready` flag indicating whether layout-input
// will succeed for this media.
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 24, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const onlyReady = req.query.ready === 'true';

    // Optional brand filter — comes from ?brandId= query param OR
    // the X-Brand-Id header (the picker injects it on every fetch).
    const brandId = req.query.brandId || req.headers['x-brand-id'] || null;
    const filterExtras = onlyReady
      ? { 'latestArtifacts.detection': { $ne: null } }
      : {};
    if (brandId) filterExtras.brandId = brandId;
    const filter = tenantFilter(req, filterExtras);

    const [docs, total] = await Promise.all([
      Media.find(filter)
        .select('externalId source fileType fileUrl fileName metadata rights latestArtifacts createdAt matchedProducts primarySubjectLabel adSuitability classification width height')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Media.countDocuments(filter)
    ]);

    const media = docs.map(d => {
      // Phase A-1 — derive match-level pill from the primary matched
      // product's outcome. UI buckets: 'high' (product_match), 'medium'
      // (product_category), 'low' (brand_match), 'none' (no_products /
      // no matchedProducts entries yet).
      const primaryMatch = (d.matchedProducts || [])[0] || null;
      const matchLevel = primaryMatch
        ? (primaryMatch.outcome === 'product_match'    ? 'high'
        :  primaryMatch.outcome === 'product_category' ? 'medium'
        :  primaryMatch.outcome === 'brand_match'      ? 'low'
        :  'none')
        : 'none';
      return {
        mediaId:        d._id,
        source:         d.source,
        externalId:     d.externalId,
        fileType:       d.fileType,
        fileUrl:        d.fileUrl,
        fileName:       d.fileName,
        width:          d.width  || null,
        height:         d.height || null,
        brand:          d.metadata?.brand || null,
        caption:        d.metadata?.caption || null,
        // IG-sourced extras — null for manual uploads. Surfaced so the
        // inventory picker can show a "Instagram post / reel" pill and
        // link out to the original permalink.
        permalink:      d.metadata?.permalink || null,
        postedAt:       d.metadata?.postedAt || null,
        creatorHandle:  d.metadata?.creatorHandle || null,
        postType:       d.metadata?.postType || null,
        rightsApproved: !!d.rights?.approved,
        ready:          !!d.latestArtifacts?.detection,
        createdAt:      d.createdAt,
        // Phase A-1 fields used by the Media Library sidebar pill + chips
        primarySubjectLabel: d.primarySubjectLabel || null,
        matchLevel,
        detectOutcome:  d.classification?.detectSummary?.outcome || null,
        adReadiness:    typeof d.adSuitability?.score === 'number' ? d.adSuitability.score : null
      };
    });

    res.json({
      media,
      total,
      limit,
      offset,
      hasMore: offset + media.length < total
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Media list failed' });
  }
});

// GET /api/media/:mediaId/detect
// Phase A-1 — assembled detect result keyed by mediaId (rather than runId
// like /api/detect/status/:runId). Returns the same shape as the existing
// status endpoint by finding the latest completed/failed DetectRun for
// the media and delegating to assembleResult. The Media Library page uses
// this so it doesn't have to discover the runId first.
router.get('/:mediaId/detect', async (req, res) => {
  try {
    const media = await assertMediaInTenant(req.params.mediaId, req);
    // Latest run for this media — completed first, falling back to any.
    const run = await DetectRun.findOne({ mediaId: media._id, status: { $in: ['completed', 'failed'] } })
      .sort({ createdAt: -1 });
    if (!run) {
      return res.status(404).json({ error: 'no completed detect run for this media yet' });
    }
    const result = await assembleResult(run);
    res.json({
      runId:   run._id,
      mediaId: run.mediaId,
      status:  run.status,
      stage:   run.stage,
      result,
      error:      run.status === 'failed' ? run.error      : null,
      errorStage: run.status === 'failed' ? run.errorStage : null
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'detect detail failed' });
  }
});

// GET /api/media/:mediaId/match
// Returns the latest ProductMatchArtifact for the given media — used by
// the Matching tab on the ad-generation preview to surface decision-tree
// outcome, per-provider evidence, brand-category fallback, and brand
// reviews. 404 if the detect run hasn't reached product-match yet.
router.get('/:mediaId/match', async (req, res) => {
  try {
    const media = await assertMediaInTenant(req.params.mediaId, req);
    const matchId = media.latestArtifacts?.match;
    if (!matchId) return res.status(404).json({ error: 'No match artifact for this media yet' });
    const match = await ProductMatchArtifact.findById(matchId).lean();
    if (!match) return res.status(404).json({ error: 'Match artifact missing from collection' });
    res.json({ match });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Match lookup failed' });
  }
});

// PATCH /api/media/:mediaId/rights
// Body: { approved: boolean, approvedBy?: string, notes?: string }
// Toggles the creator-rights flag used by the layout generator to decide
// whether UGC fields ship on the creative input. When approved flips true,
// approvedAt is stamped server-side; when it flips false, approvedAt +
// approvedBy are cleared so history doesn't linger misleadingly.
router.patch('/:mediaId/rights', express.json(), async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { approved, approvedBy, notes } = req.body || {};
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'body.approved (boolean) is required' });
    }
    const update = approved
      ? {
          'rights.approved':   true,
          'rights.approvedBy': approvedBy || req.user?.email || 'unknown',
          'rights.approvedAt': new Date(),
          ...(typeof notes === 'string' ? { 'rights.notes': notes } : {})
        }
      : {
          'rights.approved':   false,
          'rights.approvedBy': null,
          'rights.approvedAt': null,
          ...(typeof notes === 'string' ? { 'rights.notes': notes } : {})
        };

    // Tenant-scoped update — Media._id alone isn't enough; cross-tenant
    // updates must 404 to avoid information leak.
    const media = await Media.findOneAndUpdate(
      tenantFilter(req, { _id: mediaId }),
      { $set: update },
      { new: true }
    );
    if (!media) return res.status(404).json({ error: 'Media not found' });

    res.json({
      mediaId: media._id,
      rights:  media.rights || { approved: false }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Rights update failed' });
  }
});

// POST /api/media/:mediaId/draft-product
// Upload-7 — manual "Save as draft product" escape hatch. Reads the
// latest ProductMatchArtifact for the media and forces a draft
// CatalogProduct write via the same pipeline path Upload-4 uses,
// bypassing the certainty + brand opt-in guards. Useful when:
//   - autoCreateFromDetect is OFF but the user wants this one match
//     in the catalog
//   - the match was below the 0.85 confidence floor but the user
//     manually verified it's correct
router.post('/:mediaId/draft-product', async (req, res) => {
  try {
    const media = await assertMediaInTenant(req.params.mediaId, req);

    // Latest match for this media — the response that's currently on
    // the screen when the user clicked Save.
    const match = await ProductMatchArtifact.findOne({ mediaId: media._id })
      .sort({ createdAt: -1 })
      .lean();
    if (!match) return res.status(404).json({ error: 'no product match artifact for this media yet' });

    const result = await maybeCreateDraftFromMatch({
      media,
      productMatch: {
        outcome:        match.outcome,
        winner:         match.winner,
        identification: match.identification,
        query:          match.query,
        catalogMatch:   match.catalogMatch
      },
      sceneImageUrl: media.fileUrl,
      yoloProducts:  [],   // category gets filled in by the user via the drafts editor
      force:         true
    });

    if (!result.created) {
      return res.status(400).json({ ok: false, ...result });
    }
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'draft-product create failed' });
  }
});

// DELETE /api/media/:mediaId
// Cascade: every artifact bound to this Media (DetectRun + 6 artifact
// types), the Media row itself, and the Cloudinary asset (file +
// thumbnail when present). Returns counts so the UI can confirm.
router.delete('/:mediaId', async (req, res) => {
  try {
    // Tenant guard — assertMediaInTenant 404s on cross-tenant lookups.
    await assertMediaInTenant(req.params.mediaId, req);
    const { cascadeDeleteMedia } = require('../services/cascadeDeleteService');
    const result = await cascadeDeleteMedia(req.params.mediaId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'media delete failed' });
  }
});

// GET /api/media/:mediaId/comments?limit=50&offset=0
// Paginated, newest-first. Comments are populated by the
// mediaInsightsService refresh — empty until the operator hits
// the Refresh button (or a future scheduled cron) for this Media.
router.get('/:mediaId/comments', async (req, res) => {
  try {
    await assertMediaInTenant(req.params.mediaId, req);
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [rows, total] = await Promise.all([
      Comment.find({ mediaId: req.params.mediaId })
        .sort({ postedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Comment.countDocuments({ mediaId: req.params.mediaId })
    ]);

    res.json({
      comments: rows.map(c => ({
        id:             String(c._id),
        externalId:     c.externalId,
        text:           c.text,
        authorUsername: c.authorUsername,
        likeCount:      c.likeCount || 0,
        postedAt:       c.postedAt,
        fetchedAt:      c.fetchedAt
      })),
      total, limit, offset
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'comments fetch failed' });
  }
});

// POST /api/media/:mediaId/refresh-insights
// Operator-triggered refresh from the Media detail panel. Pulls
// fresh post analytics + inbound comments for this Media in one
// call. Returns the updated platformStats and comment counts so
// the UI can mirror locally without a follow-up GET.
router.post('/:mediaId/refresh-insights', async (req, res) => {
  try {
    await assertMediaInTenant(req.params.mediaId, req);
    const [statsResult, commentsResult] = await Promise.all([
      refreshInsightsForMedia(req.params.mediaId),
      fetchCommentsForMedia(req.params.mediaId)
    ]);
    res.json({
      ok:        statsResult.ok || commentsResult.ok,
      stats:     statsResult.ok    ? statsResult.stats    : null,
      statsError: statsResult.ok    ? null : statsResult.reason,
      comments:  commentsResult.ok ? {
                   fetched:     commentsResult.fetched,
                   upserted:    commentsResult.upserted,
                   totalStored: commentsResult.totalStored
                 } : null,
      commentsError: commentsResult.ok ? null : commentsResult.reason
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'refresh failed' });
  }
});

module.exports = router;
