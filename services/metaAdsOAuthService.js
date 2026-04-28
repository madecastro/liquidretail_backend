// Meta Marketing API OAuth + ad-account enumeration. Same Meta OAuth
// surface as Instagram, but a different scope list (ads_management /
// ads_read / business_management) and a different account enumeration
// — we list ad accounts the user has access to instead of Pages and
// catalogs.
//
// Same two-step token exchange as Instagram (short → long-lived).
// Encrypted tokens land in the same IntegrationCredential collection
// with type='meta-ads'.

const axios = require('axios');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_OAUTH_ROOT  = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`;
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// ads_management is the write scope — required for Phase D ship-to-
// ad-set later. We request it now so users only authorize once;
// read-only Phase B/C work with this same scope. business_management
// gives us access to ad accounts owned by Business Manager.
const SCOPES = [
  'ads_read',
  'ads_management',
  'business_management'
];

function getConfig() {
  const appId       = process.env.META_APP_ID;
  const appSecret   = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_ADS_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    throw new Error('Meta Ads OAuth not configured (set META_APP_ID, META_APP_SECRET, META_ADS_REDIRECT_URI)');
  }
  return { appId, appSecret, redirectUri };
}

function isConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_ADS_REDIRECT_URI);
}

function buildAuthorizeUrl({ state }) {
  const { appId, redirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  redirectUri,
    scope:         SCOPES.join(','),
    response_type: 'code',
    state
  });
  return `${META_OAUTH_ROOT}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const { appId, appSecret, redirectUri } = getConfig();
  const res = await axios.get(`${META_GRAPH_ROOT}/oauth/access_token`, {
    params: {
      client_id:     appId,
      client_secret: appSecret,
      redirect_uri:  redirectUri,
      code
    },
    timeout: 15000
  });
  return res.data;
}

async function exchangeForLongLivedToken(shortToken) {
  const { appId, appSecret } = getConfig();
  const res = await axios.get(`${META_GRAPH_ROOT}/oauth/access_token`, {
    params: {
      grant_type:        'fb_exchange_token',
      client_id:         appId,
      client_secret:     appSecret,
      fb_exchange_token: shortToken
    },
    timeout: 15000
  });
  return res.data;
}

// Fetch the metaUserId so a re-OAuth from the same human can be
// detected. Non-fatal; returns null on failure.
async function fetchMetaUserId(accessToken) {
  try {
    const res = await axios.get(`${META_GRAPH_ROOT}/me`, {
      params: { fields: 'id,name', access_token: accessToken },
      timeout: 15000
    });
    return res.data?.id || null;
  } catch (_) { return null; }
}

// Enumerate every ad account the token has access to. Used by the
// picker to let the user choose which to bind to a Brand.
//
// Returns: [{ id, accountIdNumeric, name, currency, timezone,
//             business: { id, name } | null }]
async function listAdAccounts(accessToken) {
  try {
    const res = await axios.get(`${META_GRAPH_ROOT}/me/adaccounts`, {
      params: {
        fields: 'id,account_id,name,currency,timezone_name,account_status,business{id,name}',
        access_token: accessToken,
        limit: 100
      },
      timeout: 20000
    });
    return (res.data?.data || []).map(a => ({
      id:               a.id,                     // act_<numeric> — what the API expects
      accountIdNumeric: a.account_id || null,    // bare numeric — useful for display
      name:             a.name || '',
      currency:         a.currency || null,
      timezone:         a.timezone_name || null,
      accountStatus:    a.account_status ?? null,
      business:         a.business ? { id: a.business.id, name: a.business.name || null } : null
    }));
  } catch (err) {
    console.warn(`   ⚠️  meta /me/adaccounts failed: ${err.response?.data?.error?.message || err.message}`);
    return [];
  }
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchMetaUserId,
  listAdAccounts,
  isConfigured,
  SCOPES
};
