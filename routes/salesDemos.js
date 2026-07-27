// Sales-only routes for creating + syncing demo Brands under the
// "Sales Demos" Advertiser. Every endpoint gates on the caller being
// scoped to that advertiser (via req.advertiserId, set by requireAuth
// + the advertiser picker). Non-sales users get 403.

const express = require('express');
const router  = express.Router();

const Brand                = require('../models/Brand');
const DetectRun            = require('../models/DetectRun');
const CatalogProduct       = require('../models/CatalogProduct');
const Media                = require('../models/Media');
const OperationRun         = require('../models/OperationRun');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const { enrichBrandDetails } = require('../services/catalogProductEnrichmentService');
const { syncBrandProductReviews } = require('../services/productReviewsScrapeService');
const {
  ensureSalesDemosAdvertiser,
  createDemoBrand,
  normalizeIgHandle,
  normalizeShopifyUrl,
  normalizeMethod,
  isAllowedBootstrapper
} = require('../services/salesDemosService');
const { syncBrandApify } = require('../services/apifyIngestService');

// POST /api/sales-demos/bootstrap — first-run setup. Any authenticated
// user whose email is on the SALES_DEMOS_ADMINS env allowlist can call
// this to seed the Sales Demos advertiser and grant themselves an
// active owner membership. Idempotent — re-calling upgrades an
// existing pending/editor membership to active owner. Mounted BEFORE
// requireSalesDemosScope so the first admin can call it without
// already being a member.
router.post('/bootstrap', async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: 'not authenticated' });
    if (!isAllowedBootstrapper(email)) {
      return res.status(403).json({
        error: 'Your email is not on the SALES_DEMOS_ADMINS allowlist.',
        code:  'NOT_ALLOWLISTED'
      });
    }

    const adv = await ensureSalesDemosAdvertiser();

    const userId = req.user.userId;
    const filter = { advertiserId: adv._id, userId };
    const existing = await AdvertiserMembership.findOne(filter);
    let membership;
    if (existing) {
      let changed = false;
      if (existing.role !== 'owner')    { existing.role   = 'owner';   changed = true; }
      if (existing.status !== 'active') { existing.status = 'active';  existing.acceptedAt = existing.acceptedAt || new Date(); changed = true; }
      if (changed) await existing.save();
      membership = existing;
    } else {
      membership = await AdvertiserMembership.create({
        advertiserId: adv._id,
        userId,
        email,
        role:         'owner',
        status:       'active',
        acceptedAt:   new Date()
      });
    }

    res.json({
      advertiserId:   String(adv._id),
      advertiserSlug: adv.slug,
      advertiserName: adv.name,
      membershipId:   String(membership._id)
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'bootstrap failed' });
  }
});

// GET /api/sales-demos/bootstrap-status — lightweight endpoint for the
// UI to decide whether to render the "Set up workspace" panel. No
// side effects. Returns the caller's relationship to the Sales Demos
// advertiser without requiring them to already be in that scope.
router.get('/bootstrap-status', async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: 'not authenticated' });

    const canBootstrap = isAllowedBootstrapper(email);
    // Look up the advertiser without creating it — we don't want a
    // status probe to seed the row for random authenticated users.
    const Advertiser = require('../models/Advertiser');
    const adv = await Advertiser.findOne({ slug: 'sales-demos' }).lean();
    let alreadyMember = false;
    if (adv) {
      const m = await AdvertiserMembership.findOne({
        advertiserId: adv._id,
        userId:       req.user.userId,
        status:       'active'
      }).select('_id').lean();
      alreadyMember = !!m;
    }
    res.json({
      canBootstrap,
      alreadyMember,
      advertiserId: adv ? String(adv._id) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'status check failed' });
  }
});

// Gate every route BELOW this line on the caller being in the Sales
// Demos advertiser context. The advertiser is created lazily on first
// bootstrap so no deploy-time seed is required.
async function requireSalesDemosScope(req, res, next) {
  try {
    if (!req.advertiserId) return res.status(401).json({ error: 'not authenticated' });
    const adv = await ensureSalesDemosAdvertiser();
    if (String(req.advertiserId) !== String(adv._id)) {
      return res.status(403).json({ error: 'not scoped to Sales Demos advertiser', code: 'NOT_IN_SCOPE' });
    }
    req.salesDemosAdvertiserId = adv._id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message || 'sales-demos scope check failed' });
  }
}

router.use(requireSalesDemosScope);

// GET /api/sales-demos/brands — list demo brands for this rep.
// Each brand is augmented with `inFlightDetectRuns`, the count of
// queued+processing DetectRuns for that brand. This lets the UI
// render an Abort button whenever real work is in flight — even
// after a page navigation dropped the local "syncing" React state.
router.get('/brands', async (req, res) => {
  try {
    const brands = await Brand.find({ advertiserId: req.salesDemosAdvertiserId, isDemo: true })
      .select('name nameNormalized logoUrl websiteUrl apifyDemo createdAt')
      .sort({ createdAt: -1 })
      .lean();

    if (brands.length === 0) return res.json({ brands });

    // Batched aggregations for all brands — cheaper than N queries each.
    const brandIds = brands.map(b => b._id);
    const [runs, productAgg, postAgg, reviewedAgg] = await Promise.all([
      DetectRun.aggregate([
        { $match: { brandId: { $in: brandIds }, status: { $in: ['queued', 'processing'] } } },
        { $group: { _id: '$brandId', count: { $sum: 1 } } }
      ]),
      // Ingested catalog size per brand.
      CatalogProduct.aggregate([
        { $match: { brandId: { $in: brandIds } } },
        { $group: { _id: '$brandId', count: { $sum: 1 } } }
      ]),
      // IG posts only — Media source 'apify-ig'/'instagram'. EXCLUDES the
      // 'catalog-product' wrapper Media that product-detect creates, so the
      // post count reflects real posts, not product images.
      Media.aggregate([
        { $match: { brandId: { $in: brandIds }, source: { $in: ['apify-ig', 'instagram'] } } },
        { $group: { _id: '$brandId', count: { $sum: 1 } } }
      ]),
      // Products that carried structured review data (rating/quotes) — the
      // numerator for the "review coverage %" shown on the brand card.
      // Mirrors the ingester's reviewsCaptured counter (productReviews set).
      CatalogProduct.aggregate([
        { $match: { brandId: { $in: brandIds }, productReviews: { $ne: null } } },
        { $group: { _id: '$brandId', count: { $sum: 1 } } }
      ])
    ]);
    const inFlightByBrand = new Map(runs.map(r => [String(r._id), r.count]));
    const productsByBrand = new Map(productAgg.map(r => [String(r._id), r.count]));
    const postsByBrand    = new Map(postAgg.map(r => [String(r._id), r.count]));
    const reviewedByBrand = new Map(reviewedAgg.map(r => [String(r._id), r.count]));

    const enriched = brands.map(b => ({
      ...b,
      inFlightDetectRuns:  inFlightByBrand.get(String(b._id)) || 0,
      productCount:        productsByBrand.get(String(b._id)) || 0,
      postCount:           postsByBrand.get(String(b._id)) || 0,
      reviewedProductCount: reviewedByBrand.get(String(b._id)) || 0
    }));

    res.json({ brands: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message || 'list demo brands failed' });
  }
});

// GET /api/sales-demos/activity — cross-brand activity log for the Sales
// Demos workspace. Returns the OperationRun feed (every instrumented
// process: demo-sync, catalog-sync, enrichment, detect, ad-batch, veo,
// etc.) — active runs first, then recently-ended — so an operator can see
// at a glance everything the system is currently working on. Read-only.
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    // Active (running/cancelling) first, then most-recent by start time.
    // A compound sort on a computed "isActive" isn't index-friendly, so
    // pull two cheap slices and merge — active set is tiny.
    const [active, recent] = await Promise.all([
      OperationRun.find({
        advertiserId: req.salesDemosAdvertiserId,
        status: { $in: ['running', 'cancelling'] }
      }).sort({ startedAt: -1 }).limit(limit).lean(),
      OperationRun.find({
        advertiserId: req.salesDemosAdvertiserId,
        status: { $in: ['succeeded', 'failed', 'cancelled'] }
      }).sort({ endedAt: -1 }).limit(limit).lean()
    ]);

    const shape = r => ({
      _id:         String(r._id),
      kind:        r.kind,
      label:       r.label || null,
      status:      r.status,
      stage:       r.stage || null,
      note:        r.note || null,
      pct:         r.pct ?? null,
      itemsDone:   r.itemsDone ?? 0,
      itemsTotal:  r.itemsTotal ?? null,
      brandId:     r.brandId ? String(r.brandId) : null,
      cancellable: !!r.cancellable,
      error:       r.error || null,
      startedAt:   r.startedAt,
      endedAt:     r.endedAt || null,
      heartbeatAt: r.heartbeatAt || null
    });

    res.json({
      active: active.map(shape),
      recent: recent.slice(0, limit).map(shape)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'activity fetch failed' });
  }
});

// POST /api/sales-demos/brands — create a demo brand.
// Body: { name, igHandle?, shopifyUrl?, method? }
// method: 'shopify-direct' (default when shopifyUrl set) | 'apify'
router.post('/brands', async (req, res) => {
  try {
    const { name, igHandle, shopifyUrl, method } = req.body || {};
    const brand = await createDemoBrand({ name, igHandle, shopifyUrl, method });
    res.status(201).json({ brand });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'create demo brand failed' });
  }
});

// PATCH /api/sales-demos/brands/:id — update Apify config on an
// existing demo brand.
// Body: { igHandle?, shopifyUrl?, method? }
// method: 'shopify-direct' | 'apify' (invalid values ignored)
router.patch('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, advertiserId: req.salesDemosAdvertiserId, isDemo: true });
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    const { igHandle, shopifyUrl, method } = req.body || {};
    if (igHandle !== undefined)   brand.apifyDemo.igHandle   = normalizeIgHandle(igHandle);
    if (shopifyUrl !== undefined) brand.apifyDemo.shopifyUrl = normalizeShopifyUrl(shopifyUrl);
    const normalizedMethod = normalizeMethod(method);
    if (normalizedMethod) brand.apifyDemo.method = normalizedMethod;
    await brand.save();
    res.json({ brand });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'update demo brand failed' });
  }
});

// POST /api/sales-demos/brands/:id/sync — kicks off a demo-brand pull
// in the background and returns 202 immediately. Apify actor runs
// routinely exceed Netlify's ~30s proxy timeout, so we can't block
// the HTTP request on them. The sync writes Media / CatalogProduct
// rows as it goes and stamps Brand.apifyDemo.lastSyncedAt on
// completion — the UI polls the brands list to see progress.
// Optional body.method ('shopify-direct' | 'apify') is persisted on
// the brand BEFORE the orchestrator starts so the catalog stage
// picks it up for this run.
router.post('/brands/:id/sync', async (req, res) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, advertiserId: req.salesDemosAdvertiserId, isDemo: true }).select('_id apifyDemo');
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    // Persist method override (if valid) before kicking off sync so
    // syncBrandApify resolves the right catalog path.
    const normalizedMethod = normalizeMethod(req.body?.method);
    if (normalizedMethod) {
      brand.apifyDemo.method = normalizedMethod;
      await brand.save();
    }

    // Fire-and-forget. Errors are logged but not surfaced to the
    // caller since the response has already been sent.
    syncBrandApify(brand._id).catch(err => {
      console.error(`⚠️  Apify sync failed for brand=${brand._id}: ${err.message}`);
    });

    res.status(202).json({ ok: true, brandId: String(brand._id), status: 'started' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'apify sync failed' });
  }
});

// POST /api/sales-demos/brands/:id/enrich — user-actuated FULL catalog
// enrichment (cross-seller price table + web-wide review synthesis +
// immersive specs). This is the paid SerpAPI/Gemini path, deliberately
// off the automatic sync path. Fire-and-forget (202); progress is
// surfaced as a cancellable OperationRun (kind 'enrichment') that the UI
// polls via /api/progress/active. 409 if one is already running.
router.post('/brands/:id/enrich', async (req, res) => {
  try {
    // Atomic claim: only the request that flips enrichInFlight false→true
    // proceeds; a concurrent double-click / second tab fails the filter and
    // gets 409. Prevents two paid SerpAPI/Gemini runs on the same brand.
    const brand = await Brand.findOneAndUpdate(
      {
        _id: req.params.id,
        advertiserId: req.salesDemosAdvertiserId,
        isDemo: true,
        'apifyDemo.enrichInFlight': { $ne: true }
      },
      { $set: { 'apifyDemo.enrichInFlight': true } },
      { new: true }
    ).select('_id');

    if (!brand) {
      // Distinguish "not found" from "already locked" for a useful message.
      const exists = await Brand.findOne({
        _id: req.params.id, advertiserId: req.salesDemosAdvertiserId, isDemo: true
      }).select('_id').lean();
      if (!exists) return res.status(404).json({ error: 'demo brand not found' });
      return res.status(409).json({ error: 'enrichment already running for this brand', code: 'ENRICH_IN_FLIGHT' });
    }

    // Fire-and-forget — errors are logged; the run's own terminal state
    // reports success/failure to the UI. ALWAYS clear the lock on completion.
    enrichBrandDetails(String(brand._id))
      .catch(err => console.error(`⚠️  catalog enrichment failed for brand=${brand._id}: ${err.message}`))
      .finally(() => {
        Brand.updateOne({ _id: brand._id }, { $set: { 'apifyDemo.enrichInFlight': false } })
          .catch(err => console.warn(`⚠️  clear enrichInFlight failed for brand=${brand._id}: ${err.message}`));
      });

    res.status(202).json({ ok: true, brandId: String(brand._id), status: 'started' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'enrich failed' });
  }
});

// POST /api/sales-demos/brands/:id/sync-reviews — re-scrape product
// reviews + ratings from the brand's own product pages. FREE (no LLM, no
// SerpAPI): reads the schema.org review data the store's review app
// publishes for rich snippets, whichever app that is. Use it to add
// reviews to a brand that was already synced, or to refresh a stale
// snapshot. TTL-gated (30d) unless ?force=1. Fire-and-forget (202);
// progress is a cancellable OperationRun (kind 'enrichment').
router.post('/brands/:id/sync-reviews', async (req, res) => {
  try {
    const brand = await Brand.findOne({
      _id: req.params.id,
      advertiserId: req.salesDemosAdvertiserId,
      isDemo: true
    }).select('_id advertiserId').lean();
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    const force = req.query.force === '1' || req.query.force === 'true';

    // Not gated on enrichInFlight — this path spends nothing, so it can
    // run alongside a paid enrichment without a cost-control lock.
    syncBrandProductReviews(String(brand._id), {
      force,
      advertiserId: brand.advertiserId || req.salesDemosAdvertiserId
    }).catch(err => console.error(`⚠️  product-reviews sync failed for brand=${brand._id}: ${err.message}`));

    res.status(202).json({ ok: true, brandId: String(brand._id), status: 'started', force });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'reviews sync failed' });
  }
});

// POST /api/sales-demos/brands/:id/abort — cooperative cancellation.
// Sets Brand.apifyDemo.aborted=true (the in-flight ingest loop reads
// this between records and bails) and marks all in-flight DetectRuns
// for the brand as failed with error='aborted by operator'. Detected
// Media / CatalogProduct rows already ingested are preserved so the
// next Sync click runs off the index instead of re-pulling from Apify.
router.post('/brands/:id/abort', async (req, res) => {
  try {
    const brand = await Brand.findOne({
      _id: req.params.id,
      advertiserId: req.salesDemosAdvertiserId,
      isDemo: true
    });
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    brand.apifyDemo.aborted = true;
    await brand.save();

    const now = new Date();
    const result = await DetectRun.updateMany(
      { brandId: brand._id, status: { $in: ['queued', 'processing'] } },
      { $set: {
          status:      'failed',
          error:       'aborted by operator',
          errorStage:  'abort',
          completedAt: now
        }
      }
    );

    res.json({
      ok: true,
      brandId: String(brand._id),
      cancelledDetectRuns: result?.modifiedCount ?? 0
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'abort failed' });
  }
});

module.exports = router;
