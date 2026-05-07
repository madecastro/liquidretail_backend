// Campaign read + quick-create API for the Campaigns page + Generate
// Ads wizard.
//
// Synced campaigns (platform = meta-ads | google-ads) are populated
// by campaignSyncService.syncCampaigns from the platform adapters —
// sync is triggered separately via /api/integrations/{meta-ads,
// google-ads}/sync-campaigns.
//
// Quick-create campaigns (platform = reach-social) originate inside
// the app via the New Campaign modal on the Campaigns page. They
// carry a synthetic externalId derived from the doc's _id and have
// no IntegrationCredential — the app itself is the source of truth.

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
      .select('platform externalId name status objective budget schedule productSetIds matchedProductIds kind insights adSets lastSyncedAt firstSeenAt')
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
        kind:          c.kind || null,
        budget:        c.budget || null,
        schedule:      c.schedule || null,
        productSetIds: c.productSetIds || [],
        matchedProductCount: (c.matchedProductIds || []).length,
        adSetCount:    (c.adSets || []).length,
        adCount:       (c.adSets || []).reduce((s, set) => s + (set.ads || []).length, 0),
        insights:      c.insights || null,
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
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });

    const productIds = c.matchedProductIds || [];

    // Highest-confidence match method per product (used by the wizard
    // to badge each row). product-set > url > mixed > collection > text.
    const methodPriority = { 'product-set': 5, url: 4, mixed: 3, collection: 2, text: 1 };
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

    const products = productIds.length === 0
      ? []
      : await CatalogProduct.find({ _id: { $in: productIds }, brandId: c.brandId })
          .select('title description category categoryRef brand price currency imageUrl productUrl externalId source')
          .lean();

    // Category-pool expansion. Walk every matched product's categoryRef,
    // collect the distinct set of categories the campaign touches, then
    // pull sibling SKUs in those categories (excluding ones already
    // matched directly). Caps at 24 to keep the response bounded.
    // Drives the wizard's "Other products in matched categories"
    // optional add-in: lets operators include category-mode SKUs the
    // creative matcher couldn't resolve directly.
    const matchedSet = new Set(products.map(p => String(p._id)));
    const categoryRefs = Array.from(new Set(
      products.map(p => p.categoryRef).filter(Boolean).map(String)
    ));
    const categoryPoolProducts = categoryRefs.length === 0
      ? []
      : await CatalogProduct.find({
          brandId:     c.brandId,
          categoryRef: { $in: categoryRefs },
          draft:       { $ne: true },
          _id:         { $nin: products.map(p => p._id) }
        })
          .select('title description category categoryRef brand price currency imageUrl productUrl externalId source')
          .limit(24)
          .lean();
    void matchedSet;

    // Campaign metadata for the Step 2 header — surfaced alongside the
    // matched products so the operator can sanity-check what they're
    // generating against (objective, audience, budget, schedule).
    const campaignMeta = {
      id:            String(c._id),
      platform:      c.platform,
      externalId:    c.externalId,
      name:          c.name || '(unnamed)',
      status:        c.status || null,
      objective:     c.objective || null,
      kind:          c.kind || null,
      budget:        c.budget || null,
      schedule:      c.schedule || null,
      targeting:     c.targeting || null,
      productSetIds: c.productSetIds || [],
      adSetCount:    (c.adSets || []).length,
      adCount:       (c.adSets || []).reduce((s, set) => s + (set.ads || []).length, 0),
      insights:      c.insights || null,
      lastSyncedAt:  c.lastSyncedAt || null,
      // A few representative ad creatives so the UI can preview what
      // the operator's campaign actually looks like — caps at 6.
      sampleCreatives: collectSampleCreatives(c, 6)
    };

    const projectProduct = (p, matchMethod) => ({
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
      matchMethod
    });

    res.json({
      campaign: campaignMeta,
      products: products.map(p => projectProduct(p, methodByProduct.get(String(p._id)) || null)),
      categoryPoolProducts: categoryPoolProducts.map(p => projectProduct(p, 'category-sibling'))
    });
  } catch (err) {
    console.error('campaign products fetch failed:', err);
    res.status(500).json({ error: err.message || 'campaign products fetch failed' });
  }
});

// POST /api/campaigns
// Body: { name, kind: 'brand'|'product', productIds?: string[] }
// Quick campaign builder — creates a reach-social platform Campaign
// scoped to the requesting brand. Returns the new campaign's id so
// the caller can redirect into /generate-ads?campaignId=X.
router.post('/', express.json(), async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId)        return res.status(400).json({ error: 'brandId required' });
    if (!req.advertiserId) return res.status(400).json({ error: 'advertiser context missing' });

    const { name, kind, productIds = [] } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (!['brand', 'product'].includes(kind)) {
      return res.status(400).json({ error: "kind must be 'brand' or 'product'" });
    }
    if (!Array.isArray(productIds)) {
      return res.status(400).json({ error: 'productIds must be an array' });
    }

    // Tenant assertion on every passed productId — drop any that
    // don't belong to the requesting brand rather than 400-ing the
    // whole request, so a stale picker doesn't block creation.
    const validProducts = productIds.length === 0
      ? []
      : await CatalogProduct.find({
          _id: { $in: productIds },
          brandId
        }).select('_id').lean();
    const validProductIds = validProducts.map(p => p._id);

    // Pre-allocate _id so we can stamp externalId in the same insert.
    const _id = new (require('mongoose')).Types.ObjectId();
    const externalId = `rs_${_id.toString()}`;

    const campaign = await Campaign.create({
      _id,
      advertiserId: req.advertiserId,
      brandId,
      platform:    'reach-social',
      externalId,
      name:        String(name).trim(),
      kind,
      status:      'ACTIVE',
      // matchedProductIds is what the wizard's Step 2 reads to
      // pre-select. Stamp at create time so re-launching the wizard
      // later restores the operator's selection.
      matchedProductIds: validProductIds,
      adSets:      []
    });

    res.status(201).json({
      campaign: {
        id:                  String(campaign._id),
        platform:            campaign.platform,
        externalId:          campaign.externalId,
        name:                campaign.name,
        kind:                campaign.kind,
        status:              campaign.status,
        matchedProductCount: validProductIds.length,
        productSetIds:       []
      }
    });
  } catch (err) {
    console.error('campaign create failed:', err);
    res.status(500).json({ error: err.message || 'campaign create failed' });
  }
});

function collectSampleCreatives(campaign, limit) {
  const out = [];
  for (const set of (campaign.adSets || [])) {
    for (const ad of (set.ads || [])) {
      if (!ad.creative) continue;
      out.push({
        adId:         ad.externalId,
        title:        ad.creative.title || null,
        body:         ad.creative.body || null,
        imageUrl:     ad.creative.imageUrl || null,
        thumbnailUrl: ad.creative.thumbnailUrl || null,
        linkUrl:      ad.creative.linkUrl || null,
        callToAction: ad.creative.callToAction || null,
        matchMethod:  ad.matchMethod || null
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = router;
