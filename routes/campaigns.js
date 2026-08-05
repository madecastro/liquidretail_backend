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
const mongoose = require('mongoose');
const router = express.Router();
const Campaign = require('../models/Campaign');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const Ad = require('../models/Ad');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { AD_RECENCY_EXPR } = require('../services/adRecencyService');

// GET /api/campaigns?brandId=X[&platform=meta-ads|google-ads][&status=ACTIVE]
// Lightweight list for the Campaigns page. Returns a projection that
// has everything the table renders without dragging the full embedded
// adSets/rawData blobs over the wire.
// Derived "is this campaign past its end date?" Used to badge expired
// campaigns in the list + detail + wizard Step 1 picker. Two sources
// of truth depending on platform:
//   reach-social: promotionalDetails.endsAt (operator-supplied)
//   synced       : schedule.end (pulled from Meta/Google)
// We DON'T mutate Campaign.status here — Meta/Google manage their own
// status enum, and the derived flag avoids race conditions between
// the scheduler and operator edits. Returns false for non-promotional
// reach-social campaigns (no end date by definition).
function computeIsExpired(c) {
  const candidate = c?.promotionalDetails?.endsAt || c?.schedule?.end || null;
  if (!candidate) return false;
  const t = new Date(candidate).getTime();
  return Number.isFinite(t) && t < Date.now();
}

router.get('/', async (req, res) => {
  try {
    const brandId  = req.query.brandId  || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const filter = { brandId };
    if (req.query.platform) filter.platform = req.query.platform;
    if (req.query.status)   filter.status   = req.query.status;

    const rows = await Campaign.find(tenantFilter(req, filter))
      .select('platform externalId name status objective budget schedule productSetIds matchedProductIds mediaIds kind insights adSets lastSyncedAt firstSeenAt promotionalDetails')
      .sort({ lastSyncedAt: -1 })
      .lean();

    // Generated-ad count per campaign (ads tied to the campaign via
    // Ad.campaignId, includes drafts/live/archived but excludes
    // orphan ads where Ad.campaignId is null after an unlink).
    // Single aggregate keeps it cheap regardless of campaign count.
    const renderedAdCounts = rows.length === 0
      ? new Map()
      : await aggregateAdCounts(rows.map(c => c._id), brandId);

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
        mediaCount:    (c.mediaIds || []).length,
        adSetCount:    (c.adSets || []).length,
        // Sum of platform-side ad-set ads (synced campaigns) — left
        // intact for compatibility; renderedAdCount is the new field
        // for in-app rendered creatives.
        adCount:           (c.adSets || []).reduce((s, set) => s + (set.ads || []).length, 0),
        renderedAdCount:   renderedAdCounts.get(String(c._id)) || 0,
        insights:      c.insights || null,
        lastSyncedAt:  c.lastSyncedAt || null,
        firstSeenAt:   c.firstSeenAt || null,
        // Derived — see computeIsExpired note at top of file.
        isExpired:     computeIsExpired(c)
      }))
    });
  } catch (err) {
    console.error('campaigns list failed:', err);
    res.status(500).json({ error: err.message || 'campaigns list failed' });
  }
});

// ── Product-ads-style campaign summary ────────────────────────────────
//
// GET /api/campaigns/ads-summary?brandId=X
// → { summary, campaigns: [...] }
//
// Drives the redesigned /campaigns page (mirrors /api/catalog/ads-summary
// for the /product-ads page). Per-campaign aggregation of:
//   - coveragePct  (placeholder formula: productsWithAds / totalProducts;
//                    Phase 2 swaps in the opportunity-score engine)
//   - productCount, ugcCount, adCount, readyToExport
//   - channels[]   derived from the platformFormat distribution on
//                  this campaign's ads (meta_* → 'Meta', pmax_* → 'Google')
//   - lastActivityAt + lastActivityLabel
//   - opportunityScore = null (Phase 2 placeholder)
//
// Registered BEFORE the /:id route below so '/ads-summary' isn't matched
// as id='ads-summary' (same precedence trick as the catalog endpoint).
router.get('/ads-summary', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    if (!mongoose.isValidObjectId(brandId)) {
      return res.status(400).json({ error: 'brandId is not a valid ObjectId' });
    }
    const brandObjectId = new mongoose.Types.ObjectId(String(brandId));

    // Brand-scoped, archived excluded. status/platform left in for the
    // frontend filter dropdowns to slice locally.
    const filter = tenantFilter(req, { brandId });
    filter.status = { $ne: 'ARCHIVED' };
    const campaigns = await Campaign.find(filter)
      .select('_id name status platform kind matchedProductIds productSetIds mediaIds lastSyncedAt firstSeenAt promotionalDetails schedule')
      .sort({ lastSyncedAt: -1 })
      .lean();

    if (!campaigns.length) {
      return res.json({
        summary: {
          totalCampaigns:        0,
          campaignsWithAds:      0,
          campaignCoveragePct:   0,
          adsCreated:            0,
          adsReadyToExport:      0,
          goodOpportunities:     null
        },
        campaigns: []
      });
    }

    // Single aggregation over Ad: per-campaign counts + distinct
    // products with ads + distinct platformFormats + last activity
    // (renderedAt, falling back to generatedAt — see adRecencyService).
    const campaignIds = campaigns.map(c => c._id);
    const agg = await Ad.aggregate([
      { $match: {
          brandId:    brandObjectId,
          campaignId: { $in: campaignIds },
          status:     { $ne: 'archived' }
      } },
      { $group: {
          _id: '$campaignId',
          adCount:       { $sum: 1 },
          ugcCount:      { $sum: { $cond: [{ $eq: ['$variantKind', 'ugc'] }, 1, 0] } },
          readyToExport: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$status', 'draft'] },
                  { $ne: ['$metaSyncStatus', 'synced'] }
                ] }, 1, 0
              ]
            }
          },
          productsWithAds: { $addToSet: '$productId' },
          platformFormats: { $addToSet: '$platformFormat' },
          lastGeneratedAt: { $max: AD_RECENCY_EXPR }
      } }
    ]);
    const adStatsByCampaign = new Map();
    for (const r of agg) if (r._id) adStatsByCampaign.set(String(r._id), r);

    // Hydrate first-product thumbnail per campaign (one bulk query).
    const allProductIds = new Set();
    for (const c of campaigns) {
      const first = (c.matchedProductIds || [])[0];
      if (first) allProductIds.add(String(first));
    }
    const productThumbs = new Map();
    if (allProductIds.size) {
      const rows = await CatalogProduct.find({ _id: { $in: [...allProductIds] } })
        .select('_id imageUrl').lean();
      for (const p of rows) productThumbs.set(String(p._id), p.imageUrl || null);
    }

    // Project channels from the platformFormat distribution on this
    // campaign's ads. Prefers platformFormats.platform field; falls back
    // to key-prefix sniffing for unknown/legacy keys. Empty when no ads
    // yet — frontend renders the campaign's platform field as fallback.
    const { channelLabelForFormat } = require('../services/platformFormats');
    function channelsFromFormats(formats) {
      const set = new Set();
      for (const f of formats || []) {
        if (!f) continue;
        const label = channelLabelForFormat(f);
        if (label) set.add(label);
        else if (f.startsWith('meta_')) set.add('Meta');
        else if (f.startsWith('pmax_') || f.startsWith('google_')) set.add('Google');
        else if (f.startsWith('tiktok_')) set.add('TikTok');
      }
      return [...set];
    }

    function lastActivityLabel(c, stats) {
      if (stats?.lastGeneratedAt) return 'Ads generated';
      if (c.lastSyncedAt) return 'Synced';
      return 'No activity';
    }

    const out = campaigns.map(c => {
      const stats        = adStatsByCampaign.get(String(c._id));
      const totalProducts = (c.matchedProductIds || []).length;
      const productsWithAds = stats
        ? (stats.productsWithAds || []).filter(Boolean).length
        : 0;
      const coveragePct = totalProducts > 0
        ? Math.round((productsWithAds / totalProducts) * 100)
        : 0;
      const firstProduct = (c.matchedProductIds || [])[0];
      const thumbUrl     = firstProduct ? productThumbs.get(String(firstProduct)) : null;

      // last activity: latest of ad-generation, sync. Fall back to firstSeen.
      const adAt  = stats?.lastGeneratedAt ? new Date(stats.lastGeneratedAt).getTime() : 0;
      const syncAt= c.lastSyncedAt        ? new Date(c.lastSyncedAt).getTime()         : 0;
      const seenAt= c.firstSeenAt         ? new Date(c.firstSeenAt).getTime()          : 0;
      const lastTs = Math.max(adAt, syncAt, seenAt);

      return {
        campaignId:        String(c._id),
        name:              c.name || '(unnamed campaign)',
        status:            c.status || null,
        kind:              c.kind   || null,
        platform:          c.platform || null,
        thumbUrl:          thumbUrl || null,
        productCount:      totalProducts,
        productsWithAds,
        ugcCount:          stats?.ugcCount       || 0,
        adCount:           stats?.adCount        || 0,
        readyToExport:     stats?.readyToExport  || 0,
        coveragePct,
        channels:          channelsFromFormats(stats?.platformFormats),
        opportunityScore:  null,   // Phase 2 — see backlog
        lastActivityAt:    lastTs ? new Date(lastTs).toISOString() : null,
        lastActivityLabel: lastActivityLabel(c, stats),
        isExpired:         computeIsExpired(c)
      };
    });

    // Default sort: lastActivity desc, then lowest coverage first
    // (operator attention surfaces above stale-but-fine campaigns).
    out.sort((a, b) => {
      const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return a.coveragePct - b.coveragePct;
    });

    const totalCampaigns      = out.length;
    const campaignsWithAds    = out.filter(c => c.adCount > 0).length;
    const adsCreated          = out.reduce((s, c) => s + c.adCount, 0);
    const adsReadyToExport    = out.reduce((s, c) => s + c.readyToExport, 0);

    res.json({
      summary: {
        totalCampaigns,
        campaignsWithAds,
        campaignCoveragePct: totalCampaigns > 0
          ? Math.round((campaignsWithAds / totalCampaigns) * 100)
          : 0,
        adsCreated,
        adsReadyToExport,
        goodOpportunities: null   // Phase 2
      },
      campaigns: out
    });
  } catch (err) {
    console.error(`❌ GET /api/campaigns/ads-summary: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'ads summary failed' });
  }
});

// GET /api/campaigns/:id/ads-detail?brandId=X
// → { products: [{ productId, title, imageUrl, adCount }], ads: [...] }
//
// Drives the inline expansion on the redesigned /campaigns page —
// mirrors /api/catalog/:id/ads-detail (catalog.js) but scoped to a
// campaign instead of a single product. The ads grid in the expansion
// can be filtered by product (analogous to filtering by campaign on
// the product-ads page).
router.get('/:id/ads-detail', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    if (!mongoose.isValidObjectId(brandId)) {
      return res.status(400).json({ error: 'brandId is not a valid ObjectId' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'campaignId is not a valid ObjectId' });
    }
    const brandObjectId    = new mongoose.Types.ObjectId(String(brandId));
    const campaignObjectId = new mongoose.Types.ObjectId(String(req.params.id));

    // Tenant gate via Campaign (campaign is advertiser-scoped); then
    // query Ad by (brandId, campaignId) — same pattern catalog.js uses
    // (Ad is brand-scoped, not advertiser-scoped, so tenantFilter
    // doesn't fit directly on the Ad query).
    const campaign = await Campaign.findOne(
      tenantFilter(req, { _id: campaignObjectId, brandId: brandObjectId })
    ).select('_id matchedProductIds').lean();
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const { loadPhotorealUrlMap, loadUseImageRefMap } = require('../services/adDisplayUrlService');
    // Aggregation, not .find(), for the same reason as catalog.js's sibling
    // /:id/ads-detail: ranking must use "true" recency (renderedAt, falling
    // back to generatedAt — see adRecencyService), which a plain
    // .sort({generatedAt:-1}) can't express since generatedAt alone never
    // updates on a re-render or dedupe-reuse.
    const ads = await Ad.aggregate([
      { $match: { brandId: brandObjectId, campaignId: campaignObjectId, status: { $ne: 'archived' } } },
      { $addFields: { _recencyAt: AD_RECENCY_EXPR } },
      { $sort: { _recencyAt: -1 } },
      { $limit: 120 },
      { $project: {
          _id: 1, campaignId: 1, template: 1, aspectRatio: 1, kind: 1, status: 1,
          approved: 1, approvedAt: 1, renderUrl: 1, posterUrl: 1, ctaText: 1, copy: 1,
          generatedAt: 1, renderedAt: 1, metaSyncStatus: 1, metaAdId: 1, metaAdsetId: 1,
          platformFormat: 1, aiCanvasArtifactId: 1, mediaId: 1, productId: 1, variantKind: 1,
          paletteSource: 1, sourceFileType: 1, regenerating: 1, regenerationStage: 1,
          regenerationHistory: 1
      } }
    ], { allowDiskUse: true });

    // Per-product ad-count for the products sidebar (analogous to the
    // campaigns sidebar in /api/catalog/:id/ads-detail).
    const productAdCounts = new Map();
    for (const ad of ads) {
      if (!ad.productId) continue;
      const k = String(ad.productId);
      productAdCounts.set(k, (productAdCounts.get(k) || 0) + 1);
    }
    const productIds = new Set([
      ...productAdCounts.keys(),
      ...((campaign.matchedProductIds || []).map(p => String(p)))
    ]);
    const productDocs = productIds.size
      ? await CatalogProduct.find({ _id: { $in: [...productIds] } })
          .select('_id title imageUrl price currency')
          .lean()
      : [];
    const products = productDocs.map(p => ({
      productId: String(p._id),
      title:     p.title || '(untitled)',
      imageUrl:  p.imageUrl || null,
      price:     p.price ?? null,
      currency:  p.currency || null,
      adCount:   productAdCounts.get(String(p._id)) || 0
    })).sort((a, b) => b.adCount - a.adCount);

    // Photoreal + useImageRef joins — same shape /api/ads returns so the
    // frontend thumbnail / detail-modal code can be shared.
    const [photorealMap, useImageRefMap] = await Promise.all([
      loadPhotorealUrlMap(ads),
      loadUseImageRefMap(ads)
    ]);

    const adRows = ads.map(a => ({
      adId:           String(a._id),
      campaignId:     a.campaignId ? String(a.campaignId) : null,
      template:       a.template,
      aspectRatio:    a.aspectRatio,
      platformFormat: a.platformFormat || null,
      kind:           a.kind || 'image',
      sourceFileType: a.sourceFileType || null,
      status:         a.status,
      approved:       !!a.approved,
      approvedAt:     a.approvedAt ? new Date(a.approvedAt).toISOString() : null,
      renderUrl:      a.renderUrl || null,
      photorealUrl:   photorealMap.get(String(a._id)) || null,
      useImageRefAsProduction: a.campaignId
        ? !!useImageRefMap.get(String(a.campaignId))
        : false,
      posterUrl:      a.posterUrl || null,
      headline:       a.copy?.headline || null,
      ctaText:        (a.copy && a.copy.cta_text) || a.ctaText || null,
      generatedAt:    (a.renderedAt || a.generatedAt)
                        ? new Date(a.renderedAt || a.generatedAt).toISOString()
                        : null,
      metaSyncStatus: a.metaSyncStatus || null,
      metaAdId:       a.metaAdId || null,
      metaAdsetId:    a.metaAdsetId || null,
      productId:      a.productId ? String(a.productId) : null,
      regenerating:   !!a.regenerating,
      regenerationStage: a.regenerationStage || null,
      regenerationHistory: Array.isArray(a.regenerationHistory)
        ? a.regenerationHistory.map(h => ({
            prompt:      h.prompt,
            mode:        h.mode,
            requestedBy: h.requestedBy || null,
            at:          h.at ? new Date(h.at).toISOString() : null,
            status:      h.status,
            error:       h.error || null,
            durationMs:  h.durationMs || null
          }))
        : []
    }));

    res.json({ products, ads: adRows });
  } catch (err) {
    console.error(`❌ GET /api/campaigns/:id/ads-detail: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'ads detail failed' });
  }
});

// GET /api/campaigns/:id — full doc including adSets[] for the
// Generate Ads wizard step that needs to know which products are in
// the campaign's product set.
router.get('/:id', async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });

    // Pinned items — operator-curated products + media on the campaign
    // that aren't yet used by any Ad. Surfaced so the campaign detail
    // page can show what's queued for ad generation, and so the
    // Generate Ads flow from a campaign row can pre-fill them. An
    // item "moves out" of pinned the moment any Ad references it via
    // Ad.productId / Ad.mediaId.
    const productIdsOnCampaign = (c.matchedProductIds || []).map(id => String(id));
    const mediaIdsOnCampaign   = (c.mediaIds || []).map(id => String(id));

    const [productsUsedOnAds, mediaUsedOnAds] = await Promise.all([
      productIdsOnCampaign.length === 0
        ? Promise.resolve([])
        : Ad.distinct('productId', { campaignId: c._id, productId: { $in: productIdsOnCampaign } }),
      mediaIdsOnCampaign.length === 0
        ? Promise.resolve([])
        : Ad.distinct('mediaId', { campaignId: c._id, mediaId: { $in: mediaIdsOnCampaign } })
    ]);
    const usedProductSet = new Set(productsUsedOnAds.map(id => String(id)));
    const usedMediaSet   = new Set(mediaUsedOnAds.map(id => String(id)));

    const pinnedProductIds = productIdsOnCampaign.filter(id => !usedProductSet.has(id));
    const pinnedMediaIds   = mediaIdsOnCampaign.filter(id => !usedMediaSet.has(id));

    const [pinnedProducts, pinnedMedia] = await Promise.all([
      pinnedProductIds.length === 0
        ? Promise.resolve([])
        : CatalogProduct.find({ _id: { $in: pinnedProductIds }, brandId: c.brandId })
            .select('title brand category price currency imageUrl productUrl externalId source')
            .lean(),
      pinnedMediaIds.length === 0
        ? Promise.resolve([])
        : Media.find({ _id: { $in: pinnedMediaIds } })
            .select('externalId source fileType fileUrl metadata primarySubjectLabel')
            .lean()
    ]);

    res.json({
      // Stamp the derived isExpired flag onto the campaign so the
      // frontend doesn't need to re-implement the end-date logic.
      campaign: { ...c, isExpired: computeIsExpired(c) },
      pinnedProducts: pinnedProducts.map(p => ({
        id:         String(p._id),
        title:      p.title,
        brand:      p.brand || null,
        category:   p.category || null,
        price:      p.price ?? null,
        currency:   p.currency || null,
        imageUrl:   p.imageUrl || null,
        productUrl: p.productUrl || null,
        externalId: p.externalId || null,
        source:     p.source || null
      })),
      pinnedMedia: pinnedMedia.map(m => ({
        id:                  String(m._id),
        externalId:          m.externalId || null,
        source:              m.source,
        fileType:            m.fileType,
        fileUrl:             m.fileUrl,
        creatorHandle:       m.metadata?.creatorHandle || null,
        permalink:           m.metadata?.permalink || null,
        primarySubjectLabel: m.primarySubjectLabel || null
      }))
    });
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
          brandId:          c.brandId,
          categoryRef:      { $in: categoryRefs },
          draft:            { $ne: true },
          isPrimaryVariant: { $ne: false },
          _id:              { $nin: products.map(p => p._id) }
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

    // Account-setup gate — block campaign creation until every connected
    // source has ≥1 completed DetectRun and zero in-flight runs. Partial
    // ingest state pairs seeds with stale/mismatched UGC; the strictest
    // bar avoids that until detect terminates everywhere.
    const { getAdReadiness } = require('../services/adReadinessService');
    const readiness = await getAdReadiness(brandId);
    if (!readiness.ready) {
      return res.status(409).json({
        error: readiness.reason,
        code: 'account-setup-incomplete',
        blockers: readiness.blockers
      });
    }

    const { name, kind, productIds = [], mediaIds = [], promotionalDetails = null } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (!['brand', 'product', 'promotional'].includes(kind)) {
      return res.status(400).json({ error: "kind must be 'brand', 'product', or 'promotional'" });
    }
    if (!Array.isArray(productIds) || !Array.isArray(mediaIds)) {
      return res.status(400).json({ error: 'productIds and mediaIds must be arrays' });
    }
    // Coerce promotionalDetails dates from ISO strings to Dates so the
    // derivation prompt's days-until-end math works. Other fields are
    // free-form Mixed; pass through as-is.
    let normalizedPromo = null;
    if (kind === 'promotional' && promotionalDetails && typeof promotionalDetails === 'object') {
      normalizedPromo = { ...promotionalDetails };
      if (normalizedPromo.startsAt) normalizedPromo.startsAt = new Date(normalizedPromo.startsAt);
      if (normalizedPromo.endsAt)   normalizedPromo.endsAt   = new Date(normalizedPromo.endsAt);
    }

    // Tenant assertion on every passed product/media id — drop any
    // that don't belong to the requesting brand rather than 400-ing
    // the whole request, so a stale picker doesn't block creation.
    const validProducts = productIds.length === 0
      ? []
      : await CatalogProduct.find({
          _id: { $in: productIds },
          brandId
        }).select('_id').lean();
    const validProductIds = validProducts.map(p => p._id);
    const validMediaList = mediaIds.length === 0
      ? []
      : await Media.find({
          _id: { $in: mediaIds },
          brandId
        }).select('_id').lean();
    const validMediaIds = validMediaList.map(m => m._id);

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
      // later restores the operator's selection. mediaIds carries
      // the same intent for media pre-selection.
      matchedProductIds: validProductIds,
      mediaIds:          validMediaIds,
      promotionalDetails: normalizedPromo,
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
        mediaCount:          validMediaIds.length,
        renderedAdCount:     0,
        productSetIds:       []
      }
    });
  } catch (err) {
    console.error('campaign create failed:', err);
    res.status(500).json({ error: err.message || 'campaign create failed' });
  }
});

// PATCH /api/campaigns/:id — edit campaign-level fields.
// Body: { name?, kind? } — additional fields can be added as the
// detail page grows. Only reach-social campaigns are mutable
// today; synced campaigns reflect platform state and edits would
// drift away from the source of truth.
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    if (c.platform !== 'reach-social') {
      return res.status(409).json({ error: 'only reach-social campaigns are editable' });
    }
    const { name, kind, promotionalDetails, useImageRefAsProduction } = req.body || {};
    // Phase B — operator-toggleable: when true, the rsvite Ads page
    // displays the gpt-image-1 polished render instead of the
    // deterministic Puppeteer screenshot. Falls back gracefully when
    // the polish hasn't landed for an ad yet.
    if (useImageRefAsProduction !== undefined) {
      c.useImageRefAsProduction = !!useImageRefAsProduction;
    }
    if (name != null) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
      c.name = trimmed;
    }
    if (kind != null) {
      // 'promotional' was previously missing here — operators couldn't
      // switch an existing campaign to promotional, only create one new.
      if (!['brand', 'product', 'promotional', 'collection', null].includes(kind)) {
        return res.status(400).json({ error: 'invalid kind' });
      }
      c.kind = kind;
    }
    // promotionalDetails accepts a partial — merges over existing fields
    // so editing entriesPerDollar alone doesn't blow away the prize
    // description. Date coercion mirrors the POST path; null clears.
    if (promotionalDetails !== undefined) {
      if (promotionalDetails === null) {
        c.promotionalDetails = null;
      } else if (typeof promotionalDetails === 'object') {
        const merged = { ...(c.promotionalDetails || {}), ...promotionalDetails };
        if (merged.startsAt) merged.startsAt = new Date(merged.startsAt);
        if (merged.endsAt)   merged.endsAt   = new Date(merged.endsAt);
        if (merged.raffleDrawDate) merged.raffleDrawDate = new Date(merged.raffleDrawDate);
        c.promotionalDetails = merged;
        c.markModified('promotionalDetails');   // Mixed type — Mongoose needs the hint
      } else {
        return res.status(400).json({ error: 'promotionalDetails must be object or null' });
      }
    }
    await c.save();
    res.json({
      campaign: {
        id: String(c._id),
        name: c.name,
        kind: c.kind,
        promotionalDetails:      c.promotionalDetails || null,
        useImageRefAsProduction: !!c.useImageRefAsProduction
      }
    });
  } catch (err) {
    console.error('campaign patch failed:', err);
    res.status(500).json({ error: err.message || 'campaign update failed' });
  }
});

// POST /api/campaigns/:id/products  body: { productIds: string[] }
// Add products to the campaign's matchedProductIds. $addToSet is
// used so duplicates are silently ignored. Validates each product
// belongs to the same brand.
router.post('/:id/products', express.json(), async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    const { productIds = [] } = req.body || {};
    if (!Array.isArray(productIds)) return res.status(400).json({ error: 'productIds must be an array' });
    const valid = productIds.length === 0
      ? []
      : await CatalogProduct.find({ _id: { $in: productIds }, brandId: c.brandId }).select('_id').lean();
    const ids = valid.map(p => p._id);
    if (ids.length === 0) return res.json({ added: 0, total: (c.matchedProductIds || []).length });
    const updated = await Campaign.findByIdAndUpdate(
      c._id,
      { $addToSet: { matchedProductIds: { $each: ids } } },
      { new: true }
    ).select('matchedProductIds').lean();
    res.json({ added: ids.length, total: (updated?.matchedProductIds || []).length });
  } catch (err) {
    console.error('campaign add products failed:', err);
    res.status(500).json({ error: err.message || 'add products failed' });
  }
});

// DELETE /api/campaigns/:id/products/:productId
router.delete('/:id/products/:productId', async (req, res) => {
  try {
    const c = await Campaign.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.id }),
      { $pull: { matchedProductIds: req.params.productId } },
      { new: true }
    ).select('matchedProductIds').lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    res.json({ removed: req.params.productId, total: (c.matchedProductIds || []).length });
  } catch (err) {
    console.error('campaign remove product failed:', err);
    res.status(500).json({ error: err.message || 'remove product failed' });
  }
});

// POST /api/campaigns/:id/media  body: { mediaIds: string[] }
router.post('/:id/media', express.json(), async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    const { mediaIds = [] } = req.body || {};
    if (!Array.isArray(mediaIds)) return res.status(400).json({ error: 'mediaIds must be an array' });
    const valid = mediaIds.length === 0
      ? []
      : await Media.find({ _id: { $in: mediaIds }, brandId: c.brandId }).select('_id').lean();
    const ids = valid.map(m => m._id);
    if (ids.length === 0) return res.json({ added: 0, total: (c.mediaIds || []).length });
    const updated = await Campaign.findByIdAndUpdate(
      c._id,
      { $addToSet: { mediaIds: { $each: ids } } },
      { new: true }
    ).select('mediaIds').lean();
    res.json({ added: ids.length, total: (updated?.mediaIds || []).length });
  } catch (err) {
    console.error('campaign add media failed:', err);
    res.status(500).json({ error: err.message || 'add media failed' });
  }
});

// DELETE /api/campaigns/:id/media/:mediaId
router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const c = await Campaign.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.id }),
      { $pull: { mediaIds: req.params.mediaId } },
      { new: true }
    ).select('mediaIds').lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    res.json({ removed: req.params.mediaId, total: (c.mediaIds || []).length });
  } catch (err) {
    console.error('campaign remove media failed:', err);
    res.status(500).json({ error: err.message || 'remove media failed' });
  }
});

// GET /api/campaigns/:id/media — hydrated Media docs for the campaign.
router.get('/:id/media', async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).select('mediaIds brandId').lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    const ids = (c.mediaIds || []).map(String);
    const rows = ids.length === 0 ? [] : await Media.find({ _id: { $in: ids } }).lean();
    res.json({
      media: rows.map(m => ({
        mediaId:   String(m._id),
        fileType:  m.fileType,
        fileUrl:   m.fileUrl,
        caption:   m.caption || null,
        source:    m.source || null
      }))
    });
  } catch (err) {
    console.error('campaign media fetch failed:', err);
    res.status(500).json({ error: err.message || 'media fetch failed' });
  }
});

// DELETE /api/campaigns/:id/ads/:adId — UNLINK (Ad.campaignId = null).
// Ad doc + Cloudinary asset stay; only the campaign association is
// dropped. The ad still surfaces in /ads (orphan) but no longer
// appears in this campaign's view.
router.delete('/:id/ads/:adId', async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id })).select('_id brandId').lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    const ad = await Ad.findOneAndUpdate(
      { _id: req.params.adId, campaignId: c._id, brandId: c.brandId },
      { campaignId: null, updatedAt: new Date() },
      { new: true }
    ).select('_id').lean();
    if (!ad) return res.status(404).json({ error: 'ad not found in this campaign' });
    res.json({ unlinked: req.params.adId });
  } catch (err) {
    console.error('campaign unlink ad failed:', err);
    res.status(500).json({ error: err.message || 'unlink failed' });
  }
});

// Helper: build campaignId → renderedAdCount map for a list of
// campaign ids in a single aggregate call.
async function aggregateAdCounts(campaignIds, brandId) {
  const results = await Ad.aggregate([
    { $match: {
      brandId:    new mongoose.Types.ObjectId(String(brandId)),
      campaignId: { $in: campaignIds.map(id => new mongoose.Types.ObjectId(String(id))) }
    } },
    { $group: { _id: '$campaignId', count: { $sum: 1 } } }
  ]);
  const map = new Map();
  for (const r of results) map.set(String(r._id), r.count);
  return map;
}

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

// DELETE /api/campaigns/:id
// Hard-delete a campaign and its directly-owned children (Ads,
// CampaignRun rows, rendered Cloudinary PNGs). Shared artifacts —
// LayoutInputArtifact, AiCanvasArtifact, ResolvedLayoutArtifact,
// AiFullRenderArtifact, AiHtmlValidationArtifact, CreativeDirection-
// Artifact, CopyCandidatesArtifact — are deliberately preserved
// because they're keyed on media/brand, not campaign, and other
// campaigns may legitimately reuse them. Source media and catalog
// products belong to the brand and survive.
router.delete('/:id', async (req, res) => {
  try {
    const c = await Campaign.findOne(tenantFilter(req, { _id: req.params.id }))
      .select('_id name brandId platform')
      .lean();
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    if (c.platform !== 'reach-social') {
      return res.status(409).json({ error: 'only reach-social campaigns can be deleted via this endpoint' });
    }
    const { cascadeDeleteCampaign } = require('../services/cascadeDeleteService');
    const result = await cascadeDeleteCampaign(c._id);
    if (!result.ok) return res.status(500).json({ error: result.reason || 'cascade delete failed' });
    res.json(result);
  } catch (err) {
    console.error(`❌ DELETE /api/campaigns/${req.params.id} failed: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'campaign delete failed' });
  }
});

// PATCH /api/campaigns/:id/brief
// Body: { brief: { ...overrides } | null }
// → { ok, brief }
//
// Operator override of the derived creative brief. Set to null to clear
// (re-derive on next sync); set to an object to override the AI-derived
// values. Stamps briefDerivedAt to now so the auto-refresh on sync
// treats the override as fresh.
router.patch('/:id/brief', express.json(), async (req, res) => {
  try {
    const campaign = await Campaign.findOne(tenantFilter(req, { _id: req.params.id }))
      .select('_id creativeBrief briefDerivedAt');
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const incoming = req.body?.brief;
    if (incoming !== null && (typeof incoming !== 'object' || Array.isArray(incoming))) {
      return res.status(400).json({ error: 'brief must be an object or null' });
    }
    campaign.creativeBrief  = incoming;
    campaign.briefDerivedAt = incoming === null ? null : new Date();
    await campaign.save();
    res.json({ ok: true, brief: campaign.creativeBrief, briefDerivedAt: campaign.briefDerivedAt });
  } catch (err) {
    console.error(`❌ PATCH /api/campaigns/:id/brief: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/derive-brief?force=true
// → { ok, brief, elapsedMs } | { skipped, reason }
//
// Runs campaignBriefDerivationService against the campaign's targeting,
// objective, matched products, and ad creatives. Returns the structured
// brief and stamps Campaign.creativeBrief + Campaign.briefDerivedAt.
// Respects 7-day TTL by default; pass force=true to re-derive.
router.post('/:id/derive-brief', async (req, res) => {
  try {
    const campaign = await Campaign.findOne(tenantFilter(req, { _id: req.params.id }))
      .select('_id').lean();
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const force = String(req.query.force || '').toLowerCase() === 'true';
    const { deriveCampaignBrief } = require('../services/campaignBriefDerivationService');
    const result = await deriveCampaignBrief(campaign._id, { force, derivedFrom: 'manual' });
    res.json(result);
  } catch (err) {
    console.error(`❌ POST /api/campaigns/:id/derive-brief: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
