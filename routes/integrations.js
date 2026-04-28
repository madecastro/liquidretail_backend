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
const axios = require('axios');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

const IntegrationCredential = require('../models/IntegrationCredential');
const CatalogProduct = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { encrypt } = require('../services/integrationCryptoService');
const ig = require('../services/instagramOAuthService');
const { syncCatalog, getCatalogStatus } = require('../services/catalogSyncService');
const { syncPosts, getPostsStatus } = require('../services/postSyncService');
const geminiSearch = require('../services/providers/geminiSearchProvider');
const { verifySignature, processWebhookPayload } = require('../services/instagramWebhookService');

const FRONTEND_URL = 'https://liquidretail.netlify.app';

function summarize(cred) {
  if (!cred) return null;
  return {
    id:           String(cred._id),
    type:         cred.type,
    status:       cred.status,
    pending:      cred.status === 'pending',
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
// V2 #5 — returns ALL active IG credentials for the brand. The first
// element is also returned as `credential` for backwards compatibility
// with single-page consumers.
router.get('/instagram/status', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    // Include pending alongside active so the UI can render a
    // "Finish setup" CTA on credentials that captured the token but
    // never had Page/IG/catalog selected.
    const creds = await IntegrationCredential.find(tenantFilter(req, {
      brandId,
      type:   'instagram',
      status: { $in: ['active', 'pending'] }
    })).sort({ connectedAt: 1 }).lean();
    const summarized = creds.map(summarize);
    res.json({
      configured:  ig.isConfigured(),
      credential:  summarized[0] || null,
      credentials: summarized
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

    // V2.5 picker flow: insert as 'pending' with the token but no
    // Page/IG/catalog selection yet. Bounce to brand.html with
    // ?ig_setup=<credentialId> so the picker modal can finalize.
    // Also pull metaUserId so a re-OAuth from the same human merges
    // with their existing pending row instead of creating duplicates.
    let metaUserId = null;
    try {
      const me = await axios.get(`${META_GRAPH_ROOT}/me`, {
        params: { fields: 'id,name', access_token: long.access_token },
        timeout: 15000
      });
      metaUserId = me.data?.id || null;
    } catch (_) { /* non-fatal — metaUserId stays null */ }

    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
    const cred = await IntegrationCredential.create({
      advertiserId:   payload.advertiserId,
      brandId:        payload.brandId,
      type:           'instagram',
      status:         'pending',
      accessTokenEnc: encrypt(long.access_token),
      expiresAt,
      scopes:         ig.SCOPES,
      metaUserId,
      connectedBy:    payload.userId,
      connectedAt:    new Date()
    });

    console.log(`🔑 IG token captured (pending selection): brand=${payload.brandId} cred=${cred._id}`);
    // Hand the credential id to the frontend so it can drive the
    // picker modal. The bounce stays on brand.html for context.
    const params = new URLSearchParams({ ig_status: 'pending', ig_setup: String(cred._id) });
    res.redirect(`${FRONTEND_URL}/brand.html?${params.toString()}`);
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
    const credentialId = req.query.credentialId || null;
    // Tenant guard — confirm the brand has at least one active credential
    // (or the specific credentialId belongs to this advertiser).
    const credFilter = credentialId
      ? { _id: credentialId, brandId, type: 'instagram', status: 'active' }
      : { brandId, type: 'instagram', status: 'active' };
    const cred = await IntegrationCredential.findOne(tenantFilter(req, credFilter)).select('_id').lean();
    if (!cred) return res.status(404).json({ error: 'no active Instagram credential for this brand' });
    const result = await syncCatalog(brandId, credentialId ? { credentialId } : {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('catalog sync failed:', err);
    res.status(500).json({ error: err.message || 'catalog sync failed' });
  }
});

// ── Webhook (V3 #1) ──────────────────────────────────────────────────
// Meta hits this endpoint directly; auth bypass is configured in
// index.js (path === '/instagram/webhook' skips requireAuth). Security
// comes from:
//   - GET: matching hub.verify_token against META_WEBHOOK_VERIFY_TOKEN
//   - POST: HMAC-SHA256 signature verification using META_APP_SECRET
//
// The POST handler captures the raw body via the express.json verify
// callback so we can compute the HMAC over the byte-for-byte payload
// Meta sent.

// GET — verification handshake. Meta sends:
//   ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
// We echo the challenge if the token matches.
router.get('/instagram/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected  = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return res.status(503).send('Webhook not configured');
  if (mode === 'subscribe' && token === expected && challenge) {
    console.log('✅ IG webhook verification handshake OK');
    return res.status(200).send(String(challenge));
  }
  console.warn(`   ⚠️  IG webhook verification failed (mode=${mode}, token-match=${token === expected})`);
  return res.status(403).send('Forbidden');
});

// POST — receive events. Captures the raw body so we can verify the
// HMAC signature before trusting the JSON.
router.post('/instagram/webhook',
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; }
  }),
  async (req, res) => {
    const sig = req.get('x-hub-signature-256');
    if (!verifySignature(req.rawBody, sig)) {
      console.warn(`   ⚠️  IG webhook signature mismatch (sig=${sig?.slice(0, 16) || 'none'}…)`);
      return res.status(401).send('Invalid signature');
    }
    // Respond 200 ASAP — Meta retries on non-2xx and we don't want to
    // hold the request open while we ingest. Run processing async.
    res.status(200).send('OK');
    try {
      const result = await processWebhookPayload(req.body);
      const summary = (result.processed || [])
        .map(p => `${p.field || '?'}=${p.ok ? (p.skipped ? 'skip' : 'ok') : 'fail'}`)
        .join(' ');
      console.log(`📬 IG webhook processed: ${summary || '(empty)'}`);
    } catch (err) {
      console.error('IG webhook processing failed:', err);
    }
  }
);

// ── Account picker (V2.5) ────────────────────────────────────────────
// GET /instagram/:credentialId/options
//   Decrypts the token and enumerates every Page + IG Business account
//   + catalog the user granted us. Returns the union — frontend picker
//   shows them all and lets the user choose which to bind to this brand.
router.get('/instagram/:credentialId/options', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      _id: req.params.credentialId, brandId, type: 'instagram',
      status: { $in: ['pending', 'active'] }
    }));
    if (!cred) return res.status(404).json({ error: 'credential not found or revoked' });

    const { decrypt } = require('../services/integrationCryptoService');
    let token;
    try { token = decrypt(cred.accessTokenEnc); }
    catch (err) { return res.status(500).json({ error: `token decrypt failed: ${err.message}` }); }

    const opts = await ig.listAccountOptions(token);
    res.json({
      options: opts,
      current: {
        pageId:    cred.pageId    || null,
        igUserId:  cred.igUserId  || null,
        catalogId: cred.catalogId || null
      }
    });
  } catch (err) {
    console.error('options enumerate failed:', err);
    res.status(500).json({ error: err.message || 'options enumerate failed' });
  }
});

// PATCH /instagram/:credentialId/selection
// Body: { pageId, igUserId?, catalogId? }
//   Validates each picked id is in what the token can access, then
//   updates the credential and flips status to 'active'. Re-callable
//   later for "Switch account" — same endpoint.
router.patch('/instagram/:credentialId/selection', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      _id: req.params.credentialId, brandId, type: 'instagram',
      status: { $in: ['pending', 'active'] }
    }));
    if (!cred) return res.status(404).json({ error: 'credential not found or revoked' });

    const body = req.body || {};
    const pageId    = body.pageId    || null;
    const igUserId  = body.igUserId  || null;
    const catalogId = body.catalogId || null;
    if (!pageId) return res.status(400).json({ error: 'pageId required' });

    // Validate against the token's actual access — defends against a
    // user PATCHing arbitrary IDs.
    const { decrypt } = require('../services/integrationCryptoService');
    let token;
    try { token = decrypt(cred.accessTokenEnc); }
    catch (err) { return res.status(500).json({ error: `token decrypt failed: ${err.message}` }); }

    const opts = await ig.listAccountOptions(token);
    const matchedPage = opts.pages.find(p => p.id === pageId);
    if (!matchedPage) return res.status(400).json({ error: 'pageId not in token-accessible Pages' });
    if (igUserId && matchedPage.igBusinessAccount?.id !== igUserId) {
      return res.status(400).json({ error: "igUserId doesn't belong to the chosen Page" });
    }
    if (catalogId && !opts.catalogs.find(c => c.id === catalogId)) {
      return res.status(400).json({ error: 'catalogId not in token-accessible catalogs' });
    }

    // Multi-page uniqueness: if another active credential under this
    // brand already binds the chosen igUserId, refuse — picker UX
    // should surface the conflict and let the user disconnect the
    // existing one first.
    if (igUserId) {
      const conflict = await IntegrationCredential.findOne({
        _id:      { $ne: cred._id },
        brandId, type: 'instagram', status: 'active', igUserId
      }).select('_id').lean();
      if (conflict) {
        return res.status(409).json({ error: `Another active credential already binds @${matchedPage.igBusinessAccount?.username || igUserId}; disconnect it first.` });
      }
    }

    cred.pageId     = pageId;
    cred.pageName   = matchedPage.name || null;
    cred.igUserId   = igUserId  || null;
    cred.igUsername = igUserId ? (matchedPage.igBusinessAccount?.username || null) : null;
    cred.catalogId  = catalogId || null;
    cred.status     = 'active';
    await cred.save();

    console.log(`✅ IG selection finalized: brand=${brandId} cred=${cred._id} page=${matchedPage.name} ig=@${cred.igUsername || '∅'} catalog=${catalogId || '∅'}`);
    res.json({
      ok: true,
      credential: {
        id:        String(cred._id),
        pageId:    cred.pageId,
        pageName:  cred.pageName,
        igUserId:  cred.igUserId,
        igUsername: cred.igUsername,
        catalogId: cred.catalogId,
        status:    cred.status
      }
    });
  } catch (err) {
    console.error('selection update failed:', err);
    res.status(500).json({ error: err.message || 'selection update failed' });
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
        .select('externalId title description category brand price currency availability imageUrl productUrl productReviews lastSyncedAt gtin mpn')
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
      gtin:         r.gtin || null,
      mpn:          r.mpn  || null,
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
    const credentialId = req.query.credentialId || null;
    const credFilter = credentialId
      ? { _id: credentialId, brandId, type: 'instagram', status: 'active' }
      : { brandId, type: 'instagram', status: 'active' };
    const cred = await IntegrationCredential.findOne(tenantFilter(req, credFilter)).select('_id').lean();
    if (!cred) return res.status(404).json({ error: 'no active Instagram credential for this brand' });
    const limit = Math.min(Number(req.body?.limit) || 25, 50);
    const result = await syncPosts(brandId, {
      limit,
      ...(credentialId ? { credentialId } : {})
    });
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

// ── Comment-reply settings (V3 #3) ───────────────────────────────────
router.get('/instagram/comment-reply', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const brand = await Brand.findOne(tenantFilter(req, { _id: brandId })).select('commentReply').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    res.json({
      commentReply: brand.commentReply || {
        enabled: false, template: 'Shop this look: {productUrl}', dailyCap: 25
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'comment-reply fetch failed' });
  }
});

router.patch('/instagram/comment-reply', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const brand = await Brand.findOne(tenantFilter(req, { _id: brandId }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const body = req.body || {};
    const cr = brand.commentReply || {};
    if (typeof body.enabled === 'boolean') cr.enabled = body.enabled;
    if (typeof body.template === 'string') {
      const t = body.template.trim();
      if (t.length > 280) return res.status(400).json({ error: 'template must be ≤ 280 chars' });
      cr.template = t;
    }
    if (Number.isFinite(body.dailyCap)) cr.dailyCap = Math.max(0, Math.min(500, Number(body.dailyCap)));
    brand.commentReply = cr;
    await brand.save();
    res.json({ commentReply: brand.commentReply });
  } catch (err) {
    res.status(500).json({ error: err.message || 'comment-reply update failed' });
  }
});

// ── Disconnect ───────────────────────────────────────────────────────
// DELETE /instagram — revokes ALL active IG credentials for the brand.
// DELETE /instagram/:credentialId — revokes one specific credential
//   (V2 #5; required when a brand has multiple connected accounts).
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

router.delete('/instagram/:credentialId', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.credentialId, brandId, type: 'instagram', status: 'active' }),
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user.userId || req.user.id } },
      { new: true }
    );
    if (!cred) return res.status(404).json({ error: 'credential not found or already revoked' });
    res.json({ ok: true, credentialId: String(cred._id) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'disconnect failed' });
  }
});

module.exports = router;
