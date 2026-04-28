const express = require('express');
const router = express.Router();
const Media = require('../models/Media');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const { tenantFilter, assertMediaInTenant } = require('../middleware/tenantHelpers');

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
        .select('externalId source fileType fileUrl fileName metadata rights latestArtifacts createdAt')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Media.countDocuments(filter)
    ]);

    const media = docs.map(d => ({
      mediaId:        d._id,
      source:         d.source,
      externalId:     d.externalId,
      fileType:       d.fileType,
      fileUrl:        d.fileUrl,
      fileName:       d.fileName,
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
      createdAt:      d.createdAt
    }));

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

module.exports = router;
