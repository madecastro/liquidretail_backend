// Integrations REST surface — currently Instagram only, structured to
// host TikTok/YouTube/etc. without a rewrite. The OAuth handshake bounces
// the user through Meta's consent screen and lands them back on the
// brand page with a status pill update.
//
// Routes:
//   GET    /api/integrations/instagram/status   — current credential summary
//   POST   /api/integrations/instagram/connect  — returns authorize URL (frontend opens it)
//   GET    /api/integrations/instagram/callback — Meta redirects here after consent
//   DELETE /api/integrations/instagram          — revoke (mark status='revoked')

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const IntegrationCredential = require('../models/IntegrationCredential');
const CatalogProduct = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { encrypt } = require('../services/integrationCryptoService');
const ig = require('../services/instagramOAuthService');
const { syncCatalog, getCatalogStatus } = require('../services/catalogSyncService');
const { syncPosts, getPostsStatus } = require('../services/postSyncService');
const geminiSearch = require('../services/providers/geminiSearchProvider');

const FRONTEND_URL = 'https://liquidretail.netlify.app';

function summarize(cred) {
  if (!cred) return null;
  return {
    id:           String(cred._id),
    type:         cred.type,
    status:       cred.status,
    igUserId:     cred.igUserId   || null,
    igUsername:   cred.igUsername || null,
    pageId:       cred.pageId     || null,
    pageName:     cred.pageName   || null,
    catalogId:    cred.catalogId  || null,
    scopes:       cred.scopes     || [],
    expiresAt:    cred.expiresAt  || null,
    connectedAt:  cred.connectedAt || null,
    lastUsedAt:   cred.lastUsedAt  || null
  };
}

// ── Status ────────────────────────────────────────────────────────────
// Returns the active IG credential for the current Brand (or null).
router.get('/instagram/status', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId,
      type:   'instagram',
      status: 'active'
    })).lean();
    res.json({
      configured: ig.isConfigured(),
      credential: summarize(cred)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'status lookup failed' });
  }
});

// ── Start connect ────────────────────────────────────────────────────
// Returns the Meta authorize URL with a signed state token so the
// callback can verify the request and know which Brand to attach
// the credential to.
router.post('/instagram/connect', express.json(), async (req, res) => {
  try {
    if (!ig.isConfigured()) {
      return res.status(501).json({ error: 'Meta OAuth not configured on this server' });
    }
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });

    const state = jwt.sign(
      {
        purpose:      'ig-oauth',
        userId:       String(req.user.userId || req.user.id),
        advertiserId: String(req.advertiserId),
        brandId:      String(brandId),
        nonce:        Math.random().toString(36).slice(2)
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    const authorizeUrl = ig.buildAuthorizeUrl({ state });
    res.json({ authorizeUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || 'connect init failed' });
  }
});

// ── Callback ─────────────────────────────────────────────────────────
// Meta redirects the user's browser here with ?code=...&state=...
// We exchange the code, store an encrypted long-lived token, and
// bounce the user back to brand.html with a status flag in the URL
// hash.
router.get('/instagram/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;
  const bounce = (status, msg) => {
    const params = new URLSearchParams({ ig_status: status });
    if (msg) params.set('ig_msg', msg);
    res.redirect(`${FRONTEND_URL}/brand.html?${params.toString()}`);
  };

  if (oauthError) return bounce('denied', String(error_description || oauthError));
  if (!code || !state) return bounce('error', 'missing code or state');

  let payload;
  try {
    payload = jwt.verify(String(state), process.env.JWT_SECRET);
    if (payload.purpose !== 'ig-oauth') throw new Error('wrong purpose');
  } catch (err) {
    return bounce('error', `invalid state: ${err.message}`);
  }

  try {
    const short = await ig.exchangeCodeForToken(String(code));
    if (!short?.access_token) throw new Error('no access_token in code-exchange response');
    const long = await ig.exchangeForLongLivedToken(short.access_token);
    if (!long?.access_token) throw new Error('no access_token in long-lived exchange');

    const summary = await ig.fetchAccountSummary(long.access_token);

    // Revoke any previous active credential for this brand+type — there's
    // only ever one active per (brandId, type) per the partial unique index.
    await IntegrationCredential.updateMany(
      { brandId: payload.brandId, type: 'instagram', status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date() } }
    );

    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
    const cred = await IntegrationCredential.create({
      advertiserId:   payload.advertiserId,
      brandId:        payload.brandId,
      type:           'instagram',
      status:         'active',
      accessTokenEnc: encrypt(long.access_token),
      expiresAt,
      scopes:         ig.SCOPES,
      igUserId:       summary.igUserId,
      igUsername:     summary.igUsername,
      pageId:         summary.pageId,
      pageName:       summary.pageName,
      catalogId:      summary.catalogId,
      metaUserId:     summary.metaUserId,
      connectedBy:    payload.userId,
      connectedAt:    new Date()
    });

    console.log(`✅ IG connected: brand=${payload.brandId} ig=@${summary.igUsername || '?'} page=${summary.pageName || '?'} catalog=${summary.catalogId || '∅'}`);
    bounce('connected', summary.igUsername || summary.pageName || 'connected');
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  IG callback failed: ${detail}`);
    bounce('error', detail);
  }
});

// ── Catalog status ───────────────────────────────────────────────────
// Lightweight endpoint for the brand page to render item count +
// last-synced timestamp without pulling every CatalogProduct row.
router.get('/instagram/catalog-status', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    // tenant guard: only return status for credentials in this advertiser
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId, type: 'instagram', status: 'active'
    })).select('_id').lean();
    if (!cred) return res.json({ connected: false, itemCount: 0, lastSyncedAt: null });
    const status = await getCatalogStatus(brandId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog status failed' });
  }
});

// ── Catalog sync ─────────────────────────────────────────────────────
// Foreground sync — paginates the Meta catalog and upserts
// CatalogProduct rows. Capped at MAX_ITEMS per call (catalogSyncService).
// Brands beyond the cap need V2 background sync.
router.post('/instagram/sync-catalog', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    // tenant guard via credential — confirms the brand belongs to this advertiser
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId, type: 'instagram', status: 'active'
    })).select('_id').lean();
    if (!cred) return res.status(404).json({ error: 'no active Instagram credential for this brand' });
    const result = await syncCatalog(brandId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('catalog sync failed:', err);
    res.status(500).json({ error: err.message || 'catalog sync failed' });
  }
});

// ── Catalog browser (V2 #1) ──────────────────────────────────────────
// GET /api/integrations/instagram/catalog
//   ?limit=24 &offset=0
//   &category=<substring> &hasReviews=1 &inStock=1
//   &q=<title-substring>
// Returns paginated CatalogProduct rows for the active brand, with
// per-row match-traffic counts and a list of distinct categories for
// the filter dropdown.
router.get('/instagram/catalog', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });

    // Tenant guard via the credential lookup — confirms the brand
    // belongs to the active advertiser before returning catalog rows.
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId, type: 'instagram'
    })).select('_id').lean();
    if (!cred) return res.status(404).json({ error: 'no Instagram integration for this brand' });

    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 24, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const filter = { brandId, source: 'ig-catalog' };
    if (req.query.category) {
      filter.category = new RegExp(escapeRegex(String(req.query.category)), 'i');
    }
    if (req.query.q) {
      const re = new RegExp(escapeRegex(String(req.query.q)), 'i');
      filter.$or = [{ title: re }, { description: re }];
    }
    if (req.query.inStock === '1') {
      filter.availability = /in stock/i;
    }
    if (req.query.hasReviews === '1') {
      filter['productReviews.quotes.0'] = { $exists: true };
    }

    const [rows, total, distinctCategories] = await Promise.all([
      CatalogProduct.find(filter)
        .select('externalId title description category brand price currency availability imageUrl productUrl productReviews lastSyncedAt')
        .sort({ lastSyncedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      CatalogProduct.countDocuments(filter),
      // Categories list — small enough to compute every call on most
      // catalogs (< 200 distinct values typical).
      CatalogProduct.distinct('category', { brandId, source: 'ig-catalog' })
    ]);

    // Match-traffic count: how many ProductMatchArtifacts reference each
    // catalog row in the current page. One aggregation pulls all counts.
    const ids = rows.map(r => r._id);
    const matchCounts = ids.length ? await ProductMatchArtifact.aggregate([
      { $match: { catalogProductId: { $in: ids } } },
      { $group: { _id: '$catalogProductId', count: { $sum: 1 } } }
    ]) : [];
    const matchCountMap = new Map(matchCounts.map(c => [String(c._id), c.count]));

    const products = rows.map(r => ({
      id:           String(r._id),
      externalId:   r.externalId,
      title:        r.title,
      description:  r.description || null,
      category:     r.category || null,
      brand:        r.brand || null,
      price:        r.price ?? null,
      currency:     r.currency || null,
      availability: r.availability || null,
      imageUrl:     r.imageUrl || null,
      productUrl:   r.productUrl || null,
      hasReviews:   !!(r.productReviews?.quotes?.length),
      reviewsRating: r.productReviews?.rating ?? null,
      reviewsCount:  r.productReviews?.reviewCount ?? null,
      reviewsFetchedAt: r.productReviews?.fetchedAt || null,
      matchCount:   matchCountMap.get(String(r._id)) || 0,
      lastSyncedAt: r.lastSyncedAt || null
    }));

    res.json({
      products,
      total,
      offset,
      limit,
      hasMore:    offset + products.length < total,
      categories: distinctCategories.filter(Boolean).sort()
    });
  } catch (err) {
    console.error('catalog browse failed:', err);
    res.status(500).json({ error: err.message || 'catalog browse failed' });
  }
});

// POST /api/integrations/instagram/catalog/:productId/refresh-reviews
// Forces a fresh productReviews lookup synchronously and writes the
// result back to the CatalogProduct row. Foreground (~10-15s) so the
// UI can show the new quotes immediately on response.
router.post('/instagram/catalog/:productId/refresh-reviews', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });

    // Tenant guard — confirm the catalog row belongs to a brand
    // owned by this advertiser.
    const product = await CatalogProduct.findOne({
      _id: req.params.productId, brandId, source: 'ig-catalog'
    });
    if (!product) return res.status(404).json({ error: 'catalog product not found' });

    // Need the parent Brand for the brand-name parameter that goes
    // into the search query.
    const Brand = require('../models/Brand');
    const brand = await Brand.findOne(tenantFilter(req, { _id: brandId })).select('name').lean();

    const fresh = await geminiSearch.lookupProductReviews({
      productName: product.title,
      brandName:   brand?.name,
      productUrl:  product.productUrl
    });
    if (!fresh) {
      return res.status(502).json({ error: 'review lookup returned no result' });
    }

    const reviews = Object.assign({}, fresh, { fetchedAt: new Date() });
    product.productReviews = reviews;
    await product.save();

    res.json({
      ok: true,
      productReviews: reviews
    });
  } catch (err) {
    console.error('product reviews refresh failed:', err);
    res.status(500).json({ error: err.message || 'product reviews refresh failed' });
  }
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Posts status ─────────────────────────────────────────────────────
router.get('/instagram/posts-status', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId, type: 'instagram', status: 'active'
    })).select('_id').lean();
    if (!cred) return res.json({ connected: false, postCount: 0, lastIngestedAt: null });
    const status = await getPostsStatus(brandId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message || 'posts status failed' });
  }
});

// ── Posts sync ───────────────────────────────────────────────────────
// Pulls recent IG posts/reels, mirrors media to Cloudinary, creates
// Media + DetectRun for each NEW post. Idempotent — already-ingested
// posts skip. Foreground; capped at 50 posts per call.
router.post('/instagram/sync-posts', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId, type: 'instagram', status: 'active'
    })).select('_id').lean();
    if (!cred) return res.status(404).json({ error: 'no active Instagram credential for this brand' });
    const limit = Math.min(Number(req.body?.limit) || 25, 50);
    const result = await syncPosts(brandId, { limit });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('IG post sync failed:', err);
    res.status(500).json({ error: err.message || 'IG post sync failed' });
  }
});

// ── Sync settings (V2 #4) ────────────────────────────────────────────
// GET  /api/integrations/instagram/sync-settings — current Brand.syncSettings
// PATCH /api/integrations/instagram/sync-settings — body: { autoSyncEnabled, dailyDetectRunCap }
const Brand = require('../models/Brand');
router.get('/instagram/sync-settings', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const brand = await Brand.findOne(tenantFilter(req, { _id: brandId })).select('syncSettings').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    res.json({
      syncSettings: brand.syncSettings || {
        autoSyncEnabled: false,
        dailyDetectRunCap: 50,
        catalogCadenceHours: 24,
        postsCadenceHours: 1
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'sync-settings fetch failed' });
  }
});

router.patch('/instagram/sync-settings', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const brand = await Brand.findOne(tenantFilter(req, { _id: brandId }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const body = req.body || {};
    const settings = brand.syncSettings || {};
    if (typeof body.autoSyncEnabled === 'boolean') settings.autoSyncEnabled = body.autoSyncEnabled;
    if (Number.isFinite(body.dailyDetectRunCap))   settings.dailyDetectRunCap   = Math.max(0, Math.min(1000, Number(body.dailyDetectRunCap)));
    if (Number.isFinite(body.catalogCadenceHours)) settings.catalogCadenceHours = Math.max(1, Math.min(168, Number(body.catalogCadenceHours)));
    if (Number.isFinite(body.postsCadenceHours))   settings.postsCadenceHours   = Math.max(1, Math.min(168, Number(body.postsCadenceHours)));
    brand.syncSettings = settings;
    await brand.save();

    res.json({ syncSettings: brand.syncSettings });
  } catch (err) {
    console.error('sync-settings update failed:', err);
    res.status(500).json({ error: err.message || 'sync-settings update failed' });
  }
});

// ── Disconnect ───────────────────────────────────────────────────────
router.delete('/instagram', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const result = await IntegrationCredential.updateMany(
      tenantFilter(req, { brandId, type: 'instagram', status: 'active' }),
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user.userId || req.user.id } }
    );
    res.json({ ok: true, revoked: result.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'disconnect failed' });
  }
});

module.exports = router;
