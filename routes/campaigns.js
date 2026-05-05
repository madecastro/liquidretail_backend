// Campaign read API for the Campaigns page + Generate Ads wizard.
//
// Source of truth is the Campaign collection (synced via
// campaignSyncService.syncCampaigns from the platform adapters).
// These routes are read-only — sync is triggered separately via
// /api/integrations/{meta-ads,google-ads}/sync-campaigns.

const express = require('express');
const router = express.Router();
const Campaign = require('../models/Campaign');
const CatalogProduct = require('../models/CatalogProduct');
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
      .select('platform externalId name status objective budget schedule productSetIds matchedProductIds adSets lastSyncedAt firstSeenAt')
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
        matchedProductCount: (c.matchedProductIds || []).length,
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

// GET /api/campaigns/:id/products — hydrated CatalogProduct rows for
// every matched product on this campaign. Drives the Generate Ads
// wizard's Step 2 auto-select. Each row carries the per-ad match
// method ('url' / 'text' / 'mixed') so the UI can show confidence.
router.get('/:id/products', async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id }))
      .select('brandId matchedProductIds adSets')
      .lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });

    const productIds = c.matchedProductIds || [];
    if (productIds.length === 0) return res.json({ products: [] });

    // Walk the embedded ads to compute the highest-confidence match
    // method per product. URL > mixed > text.
    const methodPriority = { url: 3, mixed: 2, text: 1 };
    const methodByProduct = new Map();
    for (const set of (c.adSets || [])) {
      for (const ad of (set.ads || [])) {
        const method = ad.matchMethod;
        if (!method) continue;
        for (const pid of (ad.matchedProductIds || [])) {
          const key = String(pid);
          const prev = methodByProduct.get(key);
          if (!prev || (methodPriority[method] || 0) > (methodPriority[prev] || 0)) {
            methodByProduct.set(key, method);
          }
        }
      }
    }

    const products = await CatalogProduct.find({
      _id:     { $in: productIds },
      brandId: c.brandId
    })
      .select('title description category brand price currency imageUrl productUrl externalId source')
      .lean();

    res.json({
      products: products.map(p => ({
        id:          String(p._id),
        title:       p.title,
        description: p.description || null,
        category:    p.category || null,
        brand:       p.brand || null,
        price:       p.price || null,
        currency:    p.currency || null,
        imageUrl:    p.imageUrl || null,
        productUrl:  p.productUrl || null,
        externalId:  p.externalId || null,
        source:      p.source || null,
        matchMethod: methodByProduct.get(String(p._id)) || null
      }))
    });
  } catch (err) {
    console.error('campaign products fetch failed:', err);
    res.status(500).json({ error: err.message || 'campaign products fetch failed' });
  }
});

module.exports = router;
