// Campaign read API for the Campaigns page + Generate Ads wizard.
//
// Source of truth is the Campaign collection (synced via
// campaignSyncService.syncCampaigns from the platform adapters).
// These routes are read-only — sync is triggered separately via
// /api/integrations/{meta-ads,google-ads}/sync-campaigns.

const express = require('express');
const router = express.Router();
const Campaign = require('../models/Campaign');
const { tenantFilter } = require('../middleware/tenantHelpers');

// GET /api/campaigns?brandId=X[&platform=meta-ads|google-ads][&status=ACTIVE]
// Lightweight list for the Campaigns page. Returns a projection that
// has everything the table renders without dragging the full embedded
// adSets/rawData blobs over the wire.
router.get('/', async (req, res) => {
  try {
    const brandId  = req.query.brandId  || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const filter = { brandId };
    if (req.query.platform) filter.platform = req.query.platform;
    if (req.query.status)   filter.status   = req.query.status;

    const rows = await Campaign.find(tenantFilter(req, filter))
      .select('platform externalId name status objective budget schedule productSetIds adSets lastSyncedAt firstSeenAt')
      .sort({ lastSyncedAt: -1 })
      .lean();

    res.json({
      campaigns: rows.map(c => ({
        id:            String(c._id),
        platform:      c.platform,
        externalId:    c.externalId,
        name:          c.name || '(unnamed)',
        status:        c.status || null,
        objective:     c.objective || null,
        budget:        c.budget || null,
        schedule:      c.schedule || null,
        productSetIds: c.productSetIds || [],
        adSetCount:    (c.adSets || []).length,
        adCount:       (c.adSets || []).reduce((s, set) => s + (set.ads || []).length, 0),
        lastSyncedAt:  c.lastSyncedAt || null,
        firstSeenAt:   c.firstSeenAt || null
      }))
    });
  } catch (err) {
    console.error('campaigns list failed:', err);
    res.status(500).json({ error: err.message || 'campaigns list failed' });
  }
});

// GET /api/campaigns/:id — full doc including adSets[] for the
// Generate Ads wizard step that needs to know which products are in
// the campaign's product set.
router.get('/:id', async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    res.json({ campaign: c });
  } catch (err) {
    res.status(500).json({ error: err.message || 'campaign fetch failed' });
  }
});

module.exports = router;
