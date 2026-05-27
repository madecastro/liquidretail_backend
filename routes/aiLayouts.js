const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { runSession, DEFAULT_VARIANTS, DEFAULT_ASPECT_RATIOS } = require('../services/aiLayoutStudioService');
const AiLayoutSession = require('../models/AiLayoutSession');
const Media = require('../models/Media');
const { assertMediaInTenant } = require('../middleware/tenantHelpers');

// POST /api/ai-layouts/generate
// Body: { mediaId, variants?, aspectRatios?, quality? }
// Returns: 202 { sessionId, status, totalCombos }
//
// Kicks off the generation as a background job via setImmediate and
// returns the sessionId immediately, so the request finishes well
// inside any edge-proxy timeout (Netlify caps proxied requests at
// ~26s; 9 parallel gpt-image-1 calls easily exceed that). Client
// then polls GET /api/ai-layouts/session/:id until status is
// 'completed' or 'failed'.
router.post('/generate', express.json(), async (req, res) => {
  try {
    const { mediaId, variants, aspectRatios, quality } = req.body || {};
    if (!mediaId) return res.status(400).json({ error: 'mediaId required' });
    await assertMediaInTenant(mediaId, req);

    // Resolve brandId from the Media so the session is brand-scoped
    // for the polling endpoint's tenant filter.
    const media = await Media.findById(mediaId).select('brandId advertiserId').lean();
    if (!media) return res.status(404).json({ error: 'media not found' });

    const vSet = (Array.isArray(variants) && variants.length ? variants : DEFAULT_VARIANTS)
      .filter(v => DEFAULT_VARIANTS.includes(v));
    const rSet = (Array.isArray(aspectRatios) && aspectRatios.length ? aspectRatios : DEFAULT_ASPECT_RATIOS)
      .filter(r => DEFAULT_ASPECT_RATIOS.includes(r));
    const q = ['low', 'medium', 'high'].includes(quality) ? quality : 'low';

    const session = await AiLayoutSession.create({
      advertiserId: req.advertiserId || media.advertiserId,
      brandId:      media.brandId || null,
      userId:       req.user.userId,
      mediaId,
      variants:     vSet,
      aspectRatios: rSet,
      quality:      q,
      status:       'queued',
      totalCombos:  vSet.length * rSet.length
    });

    // Fire-and-forget. The async worker writes back to the session
    // doc — never throws to here.
    setImmediate(() => { runSession(session._id); });

    res.status(202).json({
      sessionId:   String(session._id),
      status:      session.status,
      totalCombos: session.totalCombos
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'AI layout session create failed' });
  }
});

// GET /api/ai-layouts/session/:id
// Tenant-scoped session poll. Returns the current session state.
// Client polls every ~3s until status is 'completed' or 'failed'.
router.get('/session/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'invalid session id' });
    }
    const filter = { _id: req.params.id };
    if (req.advertiserId) filter.advertiserId = new mongoose.Types.ObjectId(req.advertiserId);
    const session = await AiLayoutSession.findOne(filter).lean();
    if (!session) return res.status(404).json({ error: 'session not found' });

    res.json({
      sessionId:   String(session._id),
      mediaId:     String(session.mediaId),
      status:      session.status,
      brandName:   session.brandName || null,
      productName: session.productName || null,
      quality:     session.quality,
      totalCombos: session.totalCombos,
      references:  session.references || [],
      error:       session.error || null,
      startedAt:   session.startedAt   || null,
      completedAt: session.completedAt || null,
      createdAt:   session.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'session fetch failed' });
  }
});

// GET /api/ai-layouts/meta
// Diagnostic — what the service supports.
router.get('/meta', (req, res) => {
  res.json({
    variants:      DEFAULT_VARIANTS,
    aspect_ratios: DEFAULT_ASPECT_RATIOS,
    qualities:     ['low', 'medium', 'high']
  });
});

module.exports = router;
