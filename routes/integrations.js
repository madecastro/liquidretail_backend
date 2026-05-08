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
const metaAds = require('../services/metaAdsOAuthService');
const googleAds = require('../services/googleAdsOAuthService');
const { syncCampaigns, getCampaignStatus } = require('../services/campaignSyncService');

// Same FRONTEND_URL + allowlist as auth.js — env-overridable so OAuth
// bounces (IG / Meta Ads / Google Ads callbacks) land on the right
// domain in dev / staging / cohabitation deployments. Connect routes
// accept ?redirect=<origin> (validated against FRONTEND_URLS) and
// round-trip it through the OAuth state. Callbacks decode the state
// and bounce back to that origin's /brand page. When no redirect is
// supplied (legacy callers), falls back to FRONTEND_URL/brand.html.
const { FRONTEND_URL, validateFrontendOrigin } = require('../services/frontendOriginValidator');

// Pack the validated origin into a JWT field. Used by connect routes
// when they generate state. Decoded on the corresponding callback.
function appendRedirectToState(payload, requestedRedirect) {
  const validated = validateFrontendOrigin(requestedRedirect);
  if (validated) payload.redirect = validated;
  return payload;
}

// Decode the redirect from a verified state payload (or null when
// missing/invalid). Caller should fall back to FRONTEND_URL.
function readRedirectFromState(statePayload) {
  if (!statePayload) return null;
  return validateFrontendOrigin(statePayload.redirect);
}

// Build the post-OAuth bounce URL. The new app uses /brand (Chakra
// route) and reads ig_status/ig_setup query params. The legacy app
// uses /brand.html. We pick by suffix based on whether the origin
// was supplied via the allowlist (= new app) or fell through to
// FRONTEND_URL default (= legacy).
function buildIntegrationBounceUrl(origin, query) {
  const usingDefault = !origin || origin === FRONTEND_URL;
  const path = usingDefault ? '/brand.html' : '/brand';
  const target = origin || FRONTEND_URL;
  const qs = query ? `?${query}` : '';
  return `${target}${path}${qs}`;
}

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

    // ?redirect=<origin> in query OR { redirect } in body — either is
    // valid. New app uses body; legacy callers can omit entirely.
    const requestedRedirect = req.query.redirect || req.body?.redirect || null;

    const state = jwt.sign(
      appendRedirectToState({
        purpose:      'ig-oauth',
        userId:       String(req.user.userId || req.user.id),
        advertiserId: String(req.advertiserId),
        brandId:      String(brandId),
        nonce:        Math.random().toString(36).slice(2)
      }, requestedRedirect),
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
  // Resolve the post-auth redirect target. We need to peek at the
  // state payload to know which frontend the original request came
  // from — but on hard errors (missing/invalid state) the safe
  // fallback is the legacy default. Track via `bounceTarget` so the
  // bounce helper below picks the right origin.
  let bounceTarget = null;
  const bounce = (status, msg) => {
    const params = new URLSearchParams({ ig_status: status });
    if (msg) params.set('ig_msg', msg);
    res.redirect(buildIntegrationBounceUrl(bounceTarget, params.toString()));
  };

  if (oauthError) return bounce('denied', String(error_description || oauthError));
  if (!code || !state) return bounce('error', 'missing code or state');

  let payload;
  try {
    payload = jwt.verify(String(state), process.env.JWT_SECRET);
    if (payload.purpose !== 'ig-oauth') throw new Error('wrong purpose');
    bounceTarget = readRedirectFromState(payload);
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
    // picker modal. Bounces to the originating frontend (new Chakra
    // app on /brand or legacy on /brand.html) per state-encoded
    // redirect, falling back to FRONTEND_URL.
    const params = new URLSearchParams({ ig_status: 'pending', ig_setup: String(cred._id) });
    res.redirect(buildIntegrationBounceUrl(bounceTarget, params.toString()));
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

    // Auto-trigger catalog + post syncs the moment the picker
    // commits — same pattern the Meta Ads picker uses to fire
    // campaign sync on finalize. Operator doesn't need to make
    // it back to /onboarding/connect for the bulk ingest to start.
    // setImmediate so the picker response isn't blocked on the
    // (potentially 60s) sync work.
    if (cred.catalogId) {
      setImmediate(async () => {
        try {
          const { syncCatalog } = require('../services/catalogSyncService');
          const r = await syncCatalog(String(brandId), { credentialId: cred._id });
          console.log(`📦 auto-triggered catalog sync after IG finalize: ok=${r.ok} fetched=${r.fetched || 0}`);
        } catch (err) {
          console.warn(`   ⚠️  auto-trigger catalog sync failed: ${err.message}`);
        }
      });
    }
    if (cred.igUserId) {
      setImmediate(async () => {
        try {
          const { syncPosts } = require('../services/postSyncService');
          const r = await syncPosts(String(brandId), { credentialId: cred._id, limit: 25 });
          console.log(`📸 auto-triggered post sync after IG finalize: ok=${r.ok} ingested=${r.ingested || 0}`);
        } catch (err) {
          console.warn(`   ⚠️  auto-trigger post sync failed: ${err.message}`);
        }
      });
    }

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

    // Show all sources by default — ig-catalog + manual-upload +
    // detect-identified — so manual products appear alongside IG ones.
    // Pass ?source=<value> to filter (or ?source=draft for drafts only).
    const filter = { brandId };
    if (req.query.source === 'draft') {
      filter.draft = true;
    } else if (req.query.source) {
      filter.source = String(req.query.source);
    }
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

    const [rows, total, distinctCategories, totalDrafts] = await Promise.all([
      CatalogProduct.find(filter)
        .select('externalId source draft title description category brand price currency availability imageUrl productUrl productReviews lastSyncedAt gtin mpn')
        .sort({ lastSyncedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      CatalogProduct.countDocuments(filter),
      // Categories list — small enough to compute every call on most
      // catalogs (< 200 distinct values typical).
      CatalogProduct.distinct('category', { brandId, source: 'ig-catalog' }),
      // Brand-wide draft count (independent of current filter) so the
      // browser header can show "12 drafts pending" as a CTA into the
      // drafts queue.
      CatalogProduct.countDocuments({ brandId, draft: true })
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
      _id:          String(r._id),
      externalId:   r.externalId,
      source:       r.source,
      draft:        !!r.draft,
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
      totalDrafts,
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

// PATCH /api/integrations/instagram/catalog/:productId
// Body: { title?, description?, category?, price?, currency?,
//         productUrl?, gtin?, mpn?, availability?, imageUrl? }
//
// Update mutable fields on a CatalogProduct row. Auto-flips draft to
// false the moment both price AND productUrl are populated — that's
// the threshold for a row being "complete enough" to participate in
// the matcher. Used by the drafts queue (Upload-5) for inline
// completion + by future ops UI for general edits.
//
// Tenant guard: row's brandId must belong to active advertiser.
router.patch('/instagram/catalog/:productId', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });

    const product = await CatalogProduct.findOne({
      _id: req.params.productId,
      brandId
    });
    if (!product) return res.status(404).json({ error: 'catalog product not found' });

    // Tenant guard via the credential — confirms brand is owned by
    // active advertiser. We don't have advertiserId on CatalogProduct
    // queries by default but the IntegrationCredential check is the
    // canonical scoping anchor for this brand.
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      brandId, type: 'instagram'
    })).select('_id').lean();
    if (!cred) return res.status(404).json({ error: 'no Instagram integration for this brand' });

    const body = req.body || {};

    // Per-field validation — mirrors Upload-3's product upload route.
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return res.status(400).json({ error: 'title cannot be empty' });
      product.title = t;
    }
    if (body.description !== undefined) {
      product.description = String(body.description).trim() || null;
    }
    if (body.category !== undefined) {
      product.category = String(body.category).trim() || null;
    }
    if (body.price !== undefined) {
      if (body.price === null || body.price === '') {
        product.price = null;
      } else {
        const p = Number(body.price);
        if (!Number.isFinite(p) || p < 0) {
          return res.status(400).json({ error: 'price must be a non-negative number' });
        }
        product.price = p;
      }
    }
    if (body.currency !== undefined) {
      const c = String(body.currency || '').toUpperCase().trim();
      if (c && !/^[A-Z]{3}$/.test(c)) {
        return res.status(400).json({ error: 'currency must be 3-letter ISO code' });
      }
      product.currency = c || null;
    }
    if (body.productUrl !== undefined) {
      const u = String(body.productUrl || '').trim();
      if (u && !/^https?:\/\//.test(u)) {
        return res.status(400).json({ error: 'productUrl must be http or https' });
      }
      product.productUrl = u || null;
    }
    if (body.gtin !== undefined) {
      const cleaned = String(body.gtin || '').replace(/[^\d]/g, '');
      product.gtin = (cleaned && [8, 12, 13, 14].includes(cleaned.length)) ? cleaned : null;
    }
    if (body.mpn !== undefined) {
      product.mpn = String(body.mpn || '').trim() || null;
    }
    if (body.availability !== undefined) {
      product.availability = String(body.availability || '').trim() || null;
    }
    if (body.imageUrl !== undefined) {
      product.imageUrl = String(body.imageUrl || '').trim() || null;
    }

    // Recompute draft state — both price AND productUrl present means
    // the row is matchable / shippable. Anything missing keeps it
    // queued for completion.
    product.draft = !(product.price != null && product.productUrl);
    product.lastSyncedAt = new Date();
    await product.save();

    res.json({
      ok: true,
      product: {
        id:           String(product._id),
        _id:          String(product._id),
        externalId:   product.externalId,
        source:       product.source,
        draft:        product.draft,
        title:        product.title,
        description:  product.description,
        category:     product.category,
        price:        product.price,
        currency:     product.currency,
        availability: product.availability,
        imageUrl:     product.imageUrl,
        productUrl:   product.productUrl,
        gtin:         product.gtin,
        mpn:          product.mpn,
        lastSyncedAt: product.lastSyncedAt
      }
    });
  } catch (err) {
    console.error('catalog product PATCH failed:', err);
    res.status(500).json({ error: err.message || 'catalog product update failed' });
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

// ═════════════════════════════════════════════════════════════════════
//  META ADS — Marketing API (Ad Platforms Phase A)
// ═════════════════════════════════════════════════════════════════════

function summarizeAds(cred) {
  if (!cred) return null;
  const pd = cred.platformData || {};
  return {
    id:               String(cred._id),
    type:             cred.type,
    status:           cred.status,
    pending:          cred.status === 'pending',
    adAccountId:      pd.adAccountId      || null,
    adAccountName:    pd.adAccountName    || null,
    accountIdNumeric: pd.accountIdNumeric || null,
    currency:         pd.currency         || null,
    timezone:         pd.timezone         || null,
    businessId:       pd.businessId       || null,
    businessName:     pd.businessName     || null,
    expiresAt:        cred.expiresAt      || null,
    connectedAt:      cred.connectedAt    || null
  };
}

// GET /meta-ads/status — list active + pending Meta Ads credentials.
router.get('/meta-ads/status', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const creds = await IntegrationCredential.find(tenantFilter(req, {
      brandId, type: 'meta-ads', status: { $in: ['active', 'pending'] }
    })).sort({ connectedAt: 1 }).lean();
    const summarized = creds.map(summarizeAds);
    res.json({
      configured:  metaAds.isConfigured(),
      // Singular `credential` for the single-tile UI on the Brand
      // page (matches /instagram/status); plural `credentials` for
      // any caller that wants the full list.
      credential:  summarized[0] || null,
      credentials: summarized
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'meta-ads status failed' });
  }
});

// POST /meta-ads/connect — returns the Meta authorize URL with a
// signed state token carrying brand context and a 'meta-ads-oauth'
// purpose so the callback knows which flow it's serving.
router.post('/meta-ads/connect', express.json(), async (req, res) => {
  try {
    if (!metaAds.isConfigured()) {
      return res.status(501).json({ error: 'Meta Ads OAuth not configured (set META_APP_ID, META_APP_SECRET, META_ADS_REDIRECT_URI)' });
    }
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });

    const requestedRedirect = req.query.redirect || req.body?.redirect || null;

    const state = jwt.sign(
      appendRedirectToState({
        purpose:      'meta-ads-oauth',
        userId:       String(req.user.userId || req.user.id),
        advertiserId: String(req.advertiserId),
        brandId:      String(brandId),
        nonce:        Math.random().toString(36).slice(2)
      }, requestedRedirect),
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    res.json({ authorizeUrl: metaAds.buildAuthorizeUrl({ state }) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'meta-ads connect init failed' });
  }
});

// GET /meta-ads/callback — Meta redirects here after consent. Auth
// bypass configured in index.js (path === '/meta-ads/callback'); the
// JWT state is the trust anchor.
router.get('/meta-ads/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;
  let bounceTarget = null;
  const bounce = (status, msg, setupId) => {
    const params = new URLSearchParams({ ads_status: status });
    if (msg)     params.set('ads_msg', msg);
    if (setupId) params.set('ads_setup', setupId);
    res.redirect(buildIntegrationBounceUrl(bounceTarget, params.toString()));
  };

  if (oauthError) return bounce('denied', String(error_description || oauthError));
  if (!code || !state) return bounce('error', 'missing code or state');

  let payload;
  try {
    payload = jwt.verify(String(state), process.env.JWT_SECRET);
    if (payload.purpose !== 'meta-ads-oauth') throw new Error('wrong purpose');
    bounceTarget = readRedirectFromState(payload);
  } catch (err) {
    return bounce('error', `invalid state: ${err.message}`);
  }

  try {
    const short = await metaAds.exchangeCodeForToken(String(code));
    if (!short?.access_token) throw new Error('no access_token in code-exchange response');
    const long = await metaAds.exchangeForLongLivedToken(short.access_token);
    if (!long?.access_token) throw new Error('no access_token in long-lived exchange');
    const metaUserId = await metaAds.fetchMetaUserId(long.access_token);

    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
    const cred = await IntegrationCredential.create({
      advertiserId:   payload.advertiserId,
      brandId:        payload.brandId,
      type:           'meta-ads',
      status:         'pending',
      accessTokenEnc: encrypt(long.access_token),
      expiresAt,
      scopes:         metaAds.SCOPES,
      metaUserId,
      connectedBy:    payload.userId,
      connectedAt:    new Date()
    });
    console.log(`🔑 Meta Ads token captured (pending selection): brand=${payload.brandId} cred=${cred._id}`);
    return bounce('pending', 'pick an ad account', String(cred._id));
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  Meta Ads callback failed: ${detail}`);
    return bounce('error', detail);
  }
});

// GET /meta-ads/:credentialId/options — list ad accounts the token
// can access. Drives the picker UI.
router.get('/meta-ads/:credentialId/options', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      _id: req.params.credentialId, brandId, type: 'meta-ads',
      status: { $in: ['pending', 'active'] }
    }));
    if (!cred) return res.status(404).json({ error: 'credential not found or revoked' });

    const { decrypt } = require('../services/integrationCryptoService');
    let token;
    try { token = decrypt(cred.accessTokenEnc); }
    catch (err) { return res.status(500).json({ error: `token decrypt failed: ${err.message}` }); }

    const adAccounts = await metaAds.listAdAccounts(token);
    res.json({
      options: { adAccounts },
      current: { adAccountId: cred.platformData?.adAccountId || null }
    });
  } catch (err) {
    console.error('meta-ads options failed:', err);
    res.status(500).json({ error: err.message || 'options enumerate failed' });
  }
});

// PATCH /meta-ads/:credentialId/selection
// Body: { adAccountId }
//   Validates the picked id is in the token-accessible accounts, then
//   updates the credential and flips status to 'active'.
router.patch('/meta-ads/:credentialId/selection', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      _id: req.params.credentialId, brandId, type: 'meta-ads',
      status: { $in: ['pending', 'active'] }
    }));
    if (!cred) return res.status(404).json({ error: 'credential not found or revoked' });

    const adAccountId = (req.body || {}).adAccountId;
    if (!adAccountId) return res.status(400).json({ error: 'adAccountId required' });

    const { decrypt } = require('../services/integrationCryptoService');
    let token;
    try { token = decrypt(cred.accessTokenEnc); }
    catch (err) { return res.status(500).json({ error: `token decrypt failed: ${err.message}` }); }

    const accounts = await metaAds.listAdAccounts(token);
    const matched  = accounts.find(a => a.id === adAccountId);
    if (!matched) return res.status(400).json({ error: 'adAccountId not in token-accessible ad accounts' });

    // Cross-credential conflict check — same brand can't bind the
    // same ad account twice.
    const conflict = await IntegrationCredential.findOne({
      _id:      { $ne: cred._id },
      brandId, type: 'meta-ads', status: 'active',
      'platformData.adAccountId': adAccountId
    }).select('_id').lean();
    if (conflict) {
      return res.status(409).json({ error: `Another active credential already binds ${matched.name || adAccountId}; disconnect it first.` });
    }

    cred.platformData = {
      adAccountId:      matched.id,
      adAccountName:    matched.name || null,
      accountIdNumeric: matched.accountIdNumeric || null,
      currency:         matched.currency || null,
      timezone:         matched.timezone || null,
      businessId:       matched.business?.id   || null,
      businessName:     matched.business?.name || null
    };
    cred.markModified('platformData');
    cred.status = 'active';
    await cred.save();

    console.log(`✅ Meta Ads selection finalized: brand=${brandId} cred=${cred._id} adAccount=${matched.name || matched.id}`);

    // Fire-and-forget initial campaign sync so the Campaigns page has
    // data the moment the user lands on it. The picker save returns
    // immediately; the Graph API fetch + upsert runs in the background
    // and stamps cred.lastCampaignSyncAt when it finishes.
    syncCampaigns({ brandId, platform: 'meta-ads', credentialId: String(cred._id) })
      .then(r => {
        if (!r.ok) console.warn(`   ⚠️  initial meta-ads sync failed for ${cred._id}: ${r.reason || 'unknown'}`);
      })
      .catch(err => console.warn(`   ⚠️  initial meta-ads sync threw for ${cred._id}: ${err.message}`));

    res.json({ ok: true, credential: summarizeAds(cred) });
  } catch (err) {
    console.error('meta-ads selection failed:', err);
    res.status(500).json({ error: err.message || 'selection update failed' });
  }
});

// DELETE /meta-ads/:credentialId — revoke a single Meta Ads cred.
router.delete('/meta-ads/:credentialId', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.credentialId, brandId, type: 'meta-ads', status: { $in: ['active', 'pending'] } }),
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user.userId || req.user.id } },
      { new: true }
    );
    if (!cred) return res.status(404).json({ error: 'credential not found or already revoked' });
    res.json({ ok: true, credentialId: String(cred._id) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'meta-ads disconnect failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════
//  GOOGLE ADS — Google Ads API (Ad Platforms Phase A.2)
// ═════════════════════════════════════════════════════════════════════

function summarizeGoogleAds(cred) {
  if (!cred) return null;
  const pd = cred.platformData || {};
  return {
    id:               String(cred._id),
    type:             cred.type,
    status:           cred.status,
    pending:          cred.status === 'pending',
    customerId:       pd.customerId       || null,
    customerName:     pd.customerName     || null,
    currencyCode:     pd.currencyCode     || null,
    timeZone:         pd.timeZone         || null,
    managerCustomerId: pd.managerCustomerId || null,
    expiresAt:        cred.expiresAt      || null,
    connectedAt:      cred.connectedAt    || null
  };
}

router.get('/google-ads/status', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const creds = await IntegrationCredential.find(tenantFilter(req, {
      brandId, type: 'google-ads', status: { $in: ['active', 'pending'] }
    })).sort({ connectedAt: 1 }).lean();
    const summarized = creds.map(summarizeGoogleAds);
    res.json({
      configured:         googleAds.isConfigured(),
      devTokenConfigured: googleAds.isDevTokenConfigured(),
      credential:         summarized[0] || null,
      credentials:        summarized
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'google-ads status failed' });
  }
});

router.post('/google-ads/connect', express.json(), async (req, res) => {
  try {
    if (!googleAds.isConfigured()) {
      return res.status(501).json({ error: 'Google Ads OAuth not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ADS_REDIRECT_URI)' });
    }
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });

    const requestedRedirect = req.query.redirect || req.body?.redirect || null;

    const state = jwt.sign(
      appendRedirectToState({
        purpose:      'google-ads-oauth',
        userId:       String(req.user.userId || req.user.id),
        advertiserId: String(req.advertiserId),
        brandId:      String(brandId),
        nonce:        Math.random().toString(36).slice(2)
      }, requestedRedirect),
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    res.json({ authorizeUrl: googleAds.buildAuthorizeUrl({ state }) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'google-ads connect init failed' });
  }
});

router.get('/google-ads/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;
  let bounceTarget = null;
  const bounce = (status, msg, setupId) => {
    const params = new URLSearchParams({ gads_status: status });
    if (msg)     params.set('gads_msg', msg);
    if (setupId) params.set('gads_setup', setupId);
    res.redirect(buildIntegrationBounceUrl(bounceTarget, params.toString()));
  };

  if (oauthError) return bounce('denied', String(error_description || oauthError));
  if (!code || !state) return bounce('error', 'missing code or state');

  let payload;
  try {
    payload = jwt.verify(String(state), process.env.JWT_SECRET);
    if (payload.purpose !== 'google-ads-oauth') throw new Error('wrong purpose');
    bounceTarget = readRedirectFromState(payload);
  } catch (err) {
    return bounce('error', `invalid state: ${err.message}`);
  }

  try {
    const tokens = await googleAds.exchangeCodeForTokens(String(code));
    if (!tokens?.refresh_token) {
      // No refresh_token usually means the user previously consented
      // and Google didn't re-issue. The prompt='consent' on our
      // authorize URL forces it; if we still hit this, something's
      // misconfigured.
      throw new Error('no refresh_token returned — re-authorize and ensure the consent screen actually appeared');
    }
    // Encrypt the refresh_token (the long-term secret); access tokens
    // are minted on demand from it via refreshAccessToken().
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    const cred = await IntegrationCredential.create({
      advertiserId:   payload.advertiserId,
      brandId:        payload.brandId,
      type:           'google-ads',
      status:         'pending',
      accessTokenEnc: encrypt(tokens.refresh_token),
      expiresAt,
      scopes:         googleAds.SCOPES,
      connectedBy:    payload.userId,
      connectedAt:    new Date()
    });
    console.log(`🔑 Google Ads token captured (pending selection): brand=${payload.brandId} cred=${cred._id}`);
    return bounce('pending', 'pick a customer', String(cred._id));
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  Google Ads callback failed: ${detail}`);
    return bounce('error', detail);
  }
});

// GET /google-ads/:credentialId/options — enumerate accessible
// customers via listAccessibleCustomers + per-customer detail fetch.
router.get('/google-ads/:credentialId/options', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      _id: req.params.credentialId, brandId, type: 'google-ads',
      status: { $in: ['pending', 'active'] }
    }));
    if (!cred) return res.status(404).json({ error: 'credential not found or revoked' });

    const { decrypt } = require('../services/integrationCryptoService');
    let refreshToken;
    try { refreshToken = decrypt(cred.accessTokenEnc); }
    catch (err) { return res.status(500).json({ error: `token decrypt failed: ${err.message}` }); }

    // Mint a fresh access token from the stored refresh_token.
    let accessToken;
    try {
      const minted = await googleAds.refreshAccessToken(refreshToken);
      accessToken = minted?.access_token;
      if (!accessToken) throw new Error('refresh returned no access_token');
    } catch (err) {
      const detail = err.response?.data?.error_description || err.message;
      return res.status(502).json({ error: `access-token refresh failed: ${detail}` });
    }

    if (!googleAds.isDevTokenConfigured()) {
      return res.status(501).json({
        error: 'GOOGLE_ADS_DEVELOPER_TOKEN not set on server — apply for one at https://ads.google.com/aw/apicenter and add it as an env var',
        devTokenMissing: true
      });
    }

    const customers = await googleAds.listCustomersWithDetails(accessToken);
    res.json({
      options: { customers: customers || [] },
      current: { customerId: cred.platformData?.customerId || null }
    });
  } catch (err) {
    console.error('google-ads options failed:', err);
    res.status(500).json({ error: err.message || 'options enumerate failed' });
  }
});

// PATCH /google-ads/:credentialId/selection
// Body: { customerId, managerCustomerId? }
router.patch('/google-ads/:credentialId/selection', express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOne(tenantFilter(req, {
      _id: req.params.credentialId, brandId, type: 'google-ads',
      status: { $in: ['pending', 'active'] }
    }));
    if (!cred) return res.status(404).json({ error: 'credential not found or revoked' });

    const customerId        = (req.body || {}).customerId;
    const managerCustomerId = (req.body || {}).managerCustomerId || null;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });

    // Validate against the user's accessible customers — defends
    // against a user PATCHing arbitrary IDs.
    const { decrypt } = require('../services/integrationCryptoService');
    let refreshToken;
    try { refreshToken = decrypt(cred.accessTokenEnc); }
    catch (err) { return res.status(500).json({ error: `token decrypt failed: ${err.message}` }); }
    let accessToken;
    try {
      const minted = await googleAds.refreshAccessToken(refreshToken);
      accessToken = minted?.access_token;
    } catch (err) {
      return res.status(502).json({ error: `access-token refresh failed: ${err.message}` });
    }
    const customers = await googleAds.listAccessibleCustomers(accessToken);
    if (!customers) return res.status(501).json({ error: 'GOOGLE_ADS_DEVELOPER_TOKEN not set' });
    const matched = customers.find(c => c.customerId === customerId);
    if (!matched) return res.status(400).json({ error: 'customerId not in token-accessible customers' });

    // Cross-credential conflict check.
    const conflict = await IntegrationCredential.findOne({
      _id:      { $ne: cred._id },
      brandId, type: 'google-ads', status: 'active',
      'platformData.customerId': customerId
    }).select('_id').lean();
    if (conflict) {
      return res.status(409).json({ error: `Another active credential already binds customer ${customerId}; disconnect it first.` });
    }

    // Pull human-readable details so the UI can show name + currency
    // without re-querying.
    const details = await googleAds.fetchCustomerDetails(customerId, accessToken);

    cred.platformData = {
      customerId,
      customerName:      details?.descriptiveName || null,
      currencyCode:      details?.currencyCode    || null,
      timeZone:          details?.timeZone        || null,
      managerCustomerId
    };
    cred.markModified('platformData');
    cred.status = 'active';
    await cred.save();

    console.log(`✅ Google Ads selection finalized: brand=${brandId} cred=${cred._id} customer=${customerId} (${details?.descriptiveName || '?'})`);

    // Same fire-and-forget pattern as the Meta Ads picker — populate
    // campaigns immediately so the Campaigns page isn't empty after
    // the user finishes setup.
    syncCampaigns({ brandId, platform: 'google-ads', credentialId: String(cred._id) })
      .then(r => {
        if (!r.ok) console.warn(`   ⚠️  initial google-ads sync failed for ${cred._id}: ${r.reason || 'unknown'}`);
      })
      .catch(err => console.warn(`   ⚠️  initial google-ads sync threw for ${cred._id}: ${err.message}`));

    res.json({ ok: true, credential: summarizeGoogleAds(cred) });
  } catch (err) {
    console.error('google-ads selection failed:', err);
    res.status(500).json({ error: err.message || 'selection update failed' });
  }
});

// ── Campaign sync routes (Phase B-4) ──────────────────────────────────
// One pair per platform. /campaign-status is the cheap read used by
// the brand-page card to show count + last-synced. /sync-campaigns
// dispatches into campaignSyncService which orchestrates per-platform
// adapters and returns aggregated counts.

function makeCampaignStatusHandler(platform) {
  return async (req, res) => {
    try {
      const brandId = req.headers['x-brand-id'];
      if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
      // Tenant guard via the credential.
      const cred = await IntegrationCredential.findOne(tenantFilter(req, {
        brandId, type: platform
      })).select('_id').lean();
      if (!cred) return res.json({ connected: false, count: 0, lastSyncedAt: null });
      const status = await getCampaignStatus(brandId, platform);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message || 'campaign status failed' });
    }
  };
}

function makeCampaignSyncHandler(platform) {
  return async (req, res) => {
    try {
      const brandId = req.headers['x-brand-id'];
      if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
      const credentialId = req.query.credentialId || null;
      const credFilter = credentialId
        ? { _id: credentialId, brandId, type: platform, status: 'active' }
        : { brandId, type: platform, status: 'active' };
      const cred = await IntegrationCredential.findOne(tenantFilter(req, credFilter)).select('_id').lean();
      if (!cred) return res.status(404).json({ error: `no active ${platform} credential for this brand` });
      const result = await syncCampaigns({
        brandId,
        platform,
        ...(credentialId ? { credentialId } : {})
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      console.error(`${platform} sync-campaigns failed:`, err);
      res.status(500).json({ error: err.message || 'campaign sync failed' });
    }
  };
}

router.get('/meta-ads/campaign-status',  makeCampaignStatusHandler('meta-ads'));
router.post('/meta-ads/sync-campaigns',  makeCampaignSyncHandler('meta-ads'));
router.get('/google-ads/campaign-status', makeCampaignStatusHandler('google-ads'));
router.post('/google-ads/sync-campaigns', makeCampaignSyncHandler('google-ads'));

router.delete('/google-ads/:credentialId', async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    const cred = await IntegrationCredential.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.credentialId, brandId, type: 'google-ads', status: { $in: ['active', 'pending'] } }),
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user.userId || req.user.id } },
      { new: true }
    );
    if (!cred) return res.status(404).json({ error: 'credential not found or already revoked' });
    res.json({ ok: true, credentialId: String(cred._id) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'google-ads disconnect failed' });
  }
});

module.exports = router;
