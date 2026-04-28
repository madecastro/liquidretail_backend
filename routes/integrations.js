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
const { tenantFilter } = require('../middleware/tenantHelpers');
const { encrypt } = require('../services/integrationCryptoService');
const ig = require('../services/instagramOAuthService');

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
