// Shared helper for Phase 8a integrations capabilities. The three
// providers (Instagram, Meta Ads, Google Ads) share the same
// state-signing shape + credential-list shape + disconnect shape;
// per-provider executors call these to stay compact and consistent.
//
// Not itself a capability — filename underscore-prefixed to signal
// "internal to the capabilityExecutors folder, not a registry entry."

'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const IntegrationCredential = require('../../models/IntegrationCredential');

// Per-provider dispatch. IG shares an OAuth app with Meta Ads but
// exposes different scopes + authorize URL. Google Ads is fully
// separate.
const PROVIDERS = {
  instagram: {
    label:            'Instagram',
    type:             'instagram',
    statePurpose:     'ig-oauth',
    configCheckerRef: 'instagramOAuthService',
    missingConfigMsg: 'Meta OAuth not configured on this server (set META_APP_ID, META_APP_SECRET)',
    authorizeArgKey:  'forceAssetPicker'
  },
  metaAds: {
    label:            'Meta Ads',
    type:             'meta-ads',
    statePurpose:     'meta-ads-oauth',
    configCheckerRef: 'metaAdsOAuthService',
    missingConfigMsg: 'Meta Ads OAuth not configured (set META_APP_ID, META_APP_SECRET, META_ADS_REDIRECT_URI)',
    authorizeArgKey:  'forceAssetPicker'
  },
  googleAds: {
    label:            'Google Ads',
    type:             'google-ads',
    statePurpose:     'google-ads-oauth',
    configCheckerRef: 'googleAdsOAuthService',
    missingConfigMsg: 'Google Ads OAuth not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ADS_REDIRECT_URI)',
    authorizeArgKey:  'forceAccountSwitch'
  }
};

async function resolveBrandScope({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

// Build the connect-URL result. Signs the JWT state exactly like the
// route handler does, then invokes the provider's buildAuthorizeUrl.
// Never sends real HTTP — the URL is returned to the operator to
// click in their browser.
async function connectUrl({ req, args, providerKey }) {
  const cfg = PROVIDERS[providerKey];
  if (!cfg) return { ok: false, error: `unknown provider: ${providerKey}` };
  const scope = await resolveBrandScope({ req, args });
  if (!scope.ok) return scope;

  const svc = require(`../${cfg.configCheckerRef}`);
  if (typeof svc.isConfigured === 'function' && !svc.isConfigured()) {
    return { ok: false, error: cfg.missingConfigMsg };
  }
  if (!process.env.JWT_SECRET) {
    return { ok: false, error: 'JWT_SECRET not configured — cannot sign OAuth state' };
  }

  const state = jwt.sign(
    {
      purpose:      cfg.statePurpose,
      userId:       String(req.user?.userId || req.user?.id || ''),
      advertiserId: String(req.advertiserId),
      brandId:      String(scope.brand._id),
      nonce:        Math.random().toString(36).slice(2)
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  // Some providers accept an extra flag to force the asset-picker
  // interstitial (used when the operator is connecting an additional
  // brand under the same Meta user). Default false — the agent path
  // is a fresh brand hookup.
  const authorizeUrl = svc.buildAuthorizeUrl({ state, [cfg.authorizeArgKey]: false });

  return {
    ok: true,
    kind: 'integrationConnectUrl',
    data: {
      provider:  cfg.type,
      brand:     { _id: String(scope.brand._id), name: scope.brand.name },
      authorizeUrl,
      expiresIn: 900,
      note: `Open this URL in a browser to complete the ${cfg.label} OAuth handshake. The state token expires in 15 min. After the operator finishes the picker in the UI, the credential moves from pending → active.`
    }
  };
}

async function listCredentials({ req, args, providerKey }) {
  const cfg = PROVIDERS[providerKey];
  if (!cfg) return { ok: false, error: `unknown provider: ${providerKey}` };
  const scope = await resolveBrandScope({ req, args });
  if (!scope.ok) return scope;

  const rows = await IntegrationCredential.find({
    advertiserId: req.advertiserId,
    brandId:      scope.brand._id,
    type:         cfg.type,
    status:       { $in: ['active', 'pending'] }
  })
    .sort({ connectedAt: 1 })
    .select('_id status expiresAt connectedAt pageId pageName igUserId igUsername catalogId platformData')
    .lean();

  return {
    ok: true,
    kind: 'integrationCredentialList',
    data: {
      provider: cfg.type,
      brand:    { _id: String(scope.brand._id), name: scope.brand.name },
      count:    rows.length,
      credentials: rows.map((r) => ({
        _id:          String(r._id),
        status:       r.status,
        expiresAt:    r.expiresAt || null,
        connectedAt:  r.connectedAt || null,
        pageName:     r.pageName || null,
        igUsername:   r.igUsername || null,
        catalogId:    r.catalogId || null,
        adAccountName:  r.platformData?.adAccountName || null,
        businessName:   r.platformData?.businessName  || null,
        customerId:     r.platformData?.customerId    || null,
        loginCustomerId: r.platformData?.loginCustomerId || null
      }))
    }
  };
}

async function disconnect({ req, args, providerKey }) {
  const cfg = PROVIDERS[providerKey];
  if (!cfg) return { ok: false, error: `unknown provider: ${providerKey}` };
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawCredentialId = args?.credentialId;
  if (!rawCredentialId) return { ok: false, error: 'credentialId required' };
  if (!mongoose.isValidObjectId(rawCredentialId)) {
    return { ok: false, error: `credentialId "${rawCredentialId}" is not a valid ObjectId` };
  }

  const cred = await IntegrationCredential.findOneAndUpdate(
    {
      _id: rawCredentialId,
      advertiserId: req.advertiserId,
      type: cfg.type,
      status: 'active'
    },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user?.userId || null } },
    { new: true }
  );
  if (!cred) return { ok: false, error: 'credential not found or already revoked' };

  return {
    ok: true,
    kind: 'integrationCredentialUpdate',
    data: {
      credentialId: String(cred._id),
      provider:     cfg.type,
      brandId:      cred.brandId ? String(cred.brandId) : null,
      status:       'revoked',
      revokedAt:    cred.revokedAt,
      note: `${cfg.label} credential revoked. Downstream sync services (which filter on status:'active') will skip this row on their next tick.`
    }
  };
}

module.exports = { connectUrl, listCredentials, disconnect, PROVIDERS };
