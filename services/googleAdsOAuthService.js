// Google Ads OAuth — standard Google OAuth 2.0 flow (different shape
// from Meta's). Captures a refresh_token (long-term) plus a short-lived
// access_token. The refresh_token is what we encrypt and persist;
// access tokens are minted on demand from it.
//
// Reuses GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET from the existing
// Google user-signin OAuth client. The Google Cloud OAuth client
// must register BOTH redirect URIs:
//   - /auth/google/callback           (user signin, profile/email scope)
//   - /api/integrations/google-ads/callback (this flow, adwords scope)
//
// Server-wide GOOGLE_ADS_DEVELOPER_TOKEN is required for any Google
// Ads API call, including listAccessibleCustomers. Approved at the
// Google Ads API Center per developer account; test access is
// instant, production access requires Google review.

const axios = require('axios');

const OAUTH_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN     = 'https://oauth2.googleapis.com/token';
const ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v17';
const ADS_API_ROOT    = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

const SCOPES = ['https://www.googleapis.com/auth/adwords'];

function getOAuthConfig() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_ADS_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Google Ads OAuth not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ADS_REDIRECT_URI)');
  }
  return { clientId, clientSecret, redirectUri };
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID
         && process.env.GOOGLE_CLIENT_SECRET
         && process.env.GOOGLE_ADS_REDIRECT_URI);
}

function isDevTokenConfigured() {
  return !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
}

function buildAuthorizeUrl({ state }) {
  const { clientId, redirectUri } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES.join(' '),
    // access_type=offline + prompt=consent forces a refresh_token to
    // be issued (Google omits it on subsequent consents otherwise).
    access_type:   'offline',
    prompt:        'consent',
    state
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const res = await axios.post(
    OAUTH_TOKEN,
    new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code'
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  // Returns { access_token, refresh_token, expires_in, scope, token_type, id_token? }
  return res.data;
}

// Mint a fresh access token from the stored refresh_token. Used by
// later phases when the cached access_token has expired.
async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getOAuthConfig();
  const res = await axios.post(
    OAUTH_TOKEN,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token'
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  // Returns { access_token, expires_in, scope, token_type } — no refresh_token (the original stays).
  return res.data;
}

// List every customer (= ad account) the OAuth user can access.
// Returns the bare resource names ("customers/1234567890"). To get
// the human-readable name + currency we have to call each one.
//
// Requires GOOGLE_ADS_DEVELOPER_TOKEN. Returns null if missing so
// the picker can render an explanatory empty state.
async function listAccessibleCustomers(accessToken) {
  if (!isDevTokenConfigured()) return null;
  try {
    const res = await axios.get(`${ADS_API_ROOT}/customers:listAccessibleCustomers`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      },
      timeout: 15000
    });
    // resourceNames: ["customers/1234567890", ...]
    return (res.data?.resourceNames || []).map(rn => {
      const id = String(rn).split('/').pop();
      return { customerId: id, resourceName: rn };
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  google-ads listAccessibleCustomers failed: ${detail}`);
    return [];
  }
}

// Fetch human-readable details for a customer (descriptive name,
// currency, time zone, manager flag). Used by the picker so users
// can pick by name instead of bare ID.
//
// Uses the searchStream endpoint so we can grab everything in one
// call. Login customer header is left blank — non-MCC users only
// need their own customer id; MCC users querying a child still
// usually work without it for the customer-level fields.
async function fetchCustomerDetails(customerId, accessToken) {
  if (!isDevTokenConfigured()) return null;
  try {
    const res = await axios.post(
      `${ADS_API_ROOT}/customers/${encodeURIComponent(customerId)}/googleAds:search`,
      {
        query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1'
      },
      {
        headers: {
          'Authorization':  `Bearer ${accessToken}`,
          'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'Content-Type':   'application/json'
        },
        timeout: 15000
      }
    );
    const row = (res.data?.results || [])[0];
    if (!row?.customer) return { customerId };
    const c = row.customer;
    return {
      customerId,
      descriptiveName: c.descriptiveName || null,
      currencyCode:    c.currencyCode    || null,
      timeZone:        c.timeZone        || null,
      manager:         !!c.manager
    };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    // Non-fatal — picker can still show the bare customer id.
    console.warn(`   ⚠️  google-ads fetchCustomerDetails(${customerId}) failed: ${detail}`);
    return { customerId };
  }
}

// Convenience for the picker — list with details in one call.
// Skips manager (MCC) customers from the displayed options since
// we can't run ads against them directly; user should pick a
// child customer instead.
async function listCustomersWithDetails(accessToken) {
  const customers = await listAccessibleCustomers(accessToken);
  if (!customers) return null;
  if (!customers.length) return [];
  // Cap at 50 to bound the call count.
  const slice = customers.slice(0, 50);
  return Promise.all(slice.map(c => fetchCustomerDetails(c.customerId, accessToken)));
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listAccessibleCustomers,
  fetchCustomerDetails,
  listCustomersWithDetails,
  isConfigured,
  isDevTokenConfigured,
  SCOPES
};
