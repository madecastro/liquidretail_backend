// Meta/Instagram OAuth handshake helpers.
//
// Flow:
//   1. buildAuthorizeUrl({ state }) — returns the URL we redirect the user to.
//   2. User grants permissions on Meta's consent screen.
//   3. Meta redirects to META_REDIRECT_URI?code=...&state=...
//   4. exchangeCodeForToken(code) — returns short-lived user access token.
//   5. exchangeForLongLivedToken(token) — returns ~60-day token.
//   6. fetchAccountSummary(token) — pulls IG/Page/Catalog identifiers
//      so we can store them on the credential row.
//
// Why two token exchanges: Meta's initial code-for-token returns a 1-hour
// token. The long-lived exchange (`grant_type=fb_exchange_token`) bumps
// it to 60 days, which is the practical limit before the user must
// reconnect. We store only the long-lived one.

const axios = require('axios');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_OAUTH_ROOT  = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`;
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Scopes requested at consent time. Catalog + IG basic + page list cover
// what V1 needs (catalog sync + post pull). Add more later when wiring
// V3 features (e.g. instagram_content_publish for comment replies).
const SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
  'catalog_management',
  // V3 #3 — required for posting reply comments on the brand's IG
  // posts. Brands that connected before this scope was added must
  // reconnect to enable the comment-reply feature.
  'instagram_manage_comments',
  // Post analytics — required for the /insights endpoint that returns
  // impressions, reach, engagement, saved (and plays/shares for reels).
  // like_count + comments_count come from the basic media endpoint and
  // don't need this scope, so creds without it still get partial stats.
  'instagram_manage_insights'
];

function getConfig() {
  const appId       = process.env.META_APP_ID;
  const appSecret   = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    throw new Error('Meta OAuth not configured (set META_APP_ID, META_APP_SECRET, META_REDIRECT_URI)');
  }
  return { appId, appSecret, redirectUri };
}

function isConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI);
}

// forceAssetPicker=true → adds auth_type=reauthorize so Meta re-shows
// the business-asset granting dialog. Used in additional-brand mode:
// when the advertiser already has an IG cred under a different brand,
// the user's existing Meta session would otherwise skip the picker and
// re-issue a token scoped to the same business accounts as before —
// invisible to the operator, so they can't grant access to a new
// Business Account for the second brand.
function buildAuthorizeUrl({ state, forceAssetPicker = false }) {
  const { appId, redirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  redirectUri,
    scope:         SCOPES.join(','),
    response_type: 'code',
    state
  });
  if (forceAssetPicker) params.set('auth_type', 'reauthorize');
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
  // Returns { access_token, token_type, expires_in (seconds, ~3600) }
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
  // Returns { access_token, token_type, expires_in (seconds, ~5184000 = 60d) }
  return res.data;
}

// Pulls the user's identity + first Page + IG business account + first
// catalog so we can show "Connected as @handle" on the brand page and
// store the IDs Phase B/D need. If the user has multiple Pages or
// catalogs we currently grab the first one — Phase B will surface a
// picker for the multi-asset case.
async function fetchAccountSummary(longLivedToken) {
  const summary = {
    metaUserId: null,
    pageId:     null,
    pageName:   null,
    igUserId:   null,
    igUsername: null,
    catalogId:  null
  };

  // Identity
  try {
    const me = await axios.get(`${META_GRAPH_ROOT}/me`, {
      params: { fields: 'id,name', access_token: longLivedToken },
      timeout: 15000
    });
    summary.metaUserId = me.data.id;
  } catch (err) {
    console.warn(`   ⚠️  meta /me lookup failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // First Page + its IG business account
  try {
    const accounts = await axios.get(`${META_GRAPH_ROOT}/me/accounts`, {
      params: { fields: 'id,name,instagram_business_account{id,username}', access_token: longLivedToken },
      timeout: 15000
    });
    const firstPage = (accounts.data?.data || [])[0];
    if (firstPage) {
      summary.pageId   = firstPage.id;
      summary.pageName = firstPage.name;
      if (firstPage.instagram_business_account) {
        summary.igUserId   = firstPage.instagram_business_account.id;
        summary.igUsername = firstPage.instagram_business_account.username;
      }
    }
  } catch (err) {
    console.warn(`   ⚠️  meta /me/accounts lookup failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // First owned catalog (via owned businesses)
  try {
    const businesses = await axios.get(`${META_GRAPH_ROOT}/me/businesses`, {
      params: { fields: 'id,name', access_token: longLivedToken },
      timeout: 15000
    });
    for (const biz of (businesses.data?.data || [])) {
      const catalogs = await axios.get(`${META_GRAPH_ROOT}/${biz.id}/owned_product_catalogs`, {
        params: { fields: 'id,name,product_count', access_token: longLivedToken },
        timeout: 15000
      });
      const firstCat = (catalogs.data?.data || [])[0];
      if (firstCat) { summary.catalogId = firstCat.id; break; }
    }
  } catch (err) {
    console.warn(`   ⚠️  meta catalog lookup failed: ${err.response?.data?.error?.message || err.message}`);
  }

  return summary;
}

// V2.5 — full enumeration of what the token can access. Used by the
// account picker to show the user every Page + IG Business account +
// catalog so they can choose which to bind to a Brand.
//
// Catalog discovery walks TWO Business-owned sources. Page-leg and
// user-leg were removed after the page-leg surfaced non-syncable
// page-shop catalogs and the user-leg pointed at a non-existent
// Graph endpoint (see comment near the deletion site below).
//
//   owned   — /{biz}/owned_product_catalogs        (merchant's own BM)
//   client  — /{biz}/client_product_catalogs       (agency shared TO this biz)
//
// Results are deduped by catalog id and tagged with the source(s) they
// were reachable from. The `debug` block exposes per-source counts and
// errors so the /options/debug endpoint can diagnose "I don't see my
// catalog" reports.
async function listAccountOptions(accessToken) {
  const out = { pages: [], catalogs: [], debug: {
    businessesCount: 0,
    ownedCatalogsByBiz:  {},
    clientCatalogsByBiz: {},
    errors: []
  }};
  const debug = out.debug;
  const catById = new Map();   // catalogId → option row (with sources[])

  function recordCatalog(c, source, biz) {
    const id = String(c.id);
    let row = catById.get(id);
    if (!row) {
      row = {
        id,
        name:         c.name || '',
        businessName: biz?.name || '',
        productCount: c.product_count ?? null,
        sources:      []
      };
      catById.set(id, row);
      out.catalogs.push(row);
    } else {
      // Promote name/biz when a later source has richer info.
      if (!row.businessName && biz?.name) row.businessName = biz.name;
      if (row.productCount == null && c.product_count != null) row.productCount = c.product_count;
    }
    if (!row.sources.includes(source)) row.sources.push(source);
  }

  function pushErr(source, err) {
    debug.errors.push({
      source,
      message: err.response?.data?.error?.message || err.message,
      code:    err.response?.data?.error?.code,
      subcode: err.response?.data?.error?.error_subcode
    });
    console.warn(`   ⚠️  meta ${source} failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // 1. Pages + IG business accounts. Also drives the page-catalogs leg below.
  let pages = [];
  try {
    const accounts = await axios.get(`${META_GRAPH_ROOT}/me/accounts`, {
      params: { fields: 'id,name,instagram_business_account{id,username}', access_token: accessToken, limit: 100 },
      timeout: 15000
    });
    pages = accounts.data?.data || [];
    for (const p of pages) {
      out.pages.push({
        id:                p.id,
        name:              p.name || '',
        igBusinessAccount: p.instagram_business_account ? {
          id:       p.instagram_business_account.id,
          username: p.instagram_business_account.username || null
        } : null
      });
    }
  } catch (err) {
    pushErr('/me/accounts', err);
  }

  // 2. Owned + client catalogs per Business.
  let businesses = [];
  try {
    const bizRes = await axios.get(`${META_GRAPH_ROOT}/me/businesses`, {
      params: { fields: 'id,name', access_token: accessToken, limit: 50 },
      timeout: 15000
    });
    businesses = bizRes.data?.data || [];
    debug.businessesCount = businesses.length;
  } catch (err) {
    pushErr('/me/businesses', err);
  }

  for (const biz of businesses) {
    try {
      const owned = await axios.get(`${META_GRAPH_ROOT}/${biz.id}/owned_product_catalogs`, {
        params: { fields: 'id,name,product_count', access_token: accessToken, limit: 50 },
        timeout: 15000
      });
      const rows = owned.data?.data || [];
      debug.ownedCatalogsByBiz[biz.id] = rows.length;
      for (const c of rows) recordCatalog(c, 'owned', biz);
    } catch (err) {
      pushErr(`/${biz.id}/owned_product_catalogs`, err);
    }
    try {
      const client = await axios.get(`${META_GRAPH_ROOT}/${biz.id}/client_product_catalogs`, {
        params: { fields: 'id,name,product_count', access_token: accessToken, limit: 50 },
        timeout: 15000
      });
      const rows = client.data?.data || [];
      debug.clientCatalogsByBiz[biz.id] = rows.length;
      for (const c of rows) recordCatalog(c, 'client', biz);
    } catch (err) {
      pushErr(`/${biz.id}/client_product_catalogs`, err);
    }
  }

  // Page-leg + user-leg removed (was: legs 3 + 4). Background:
  //
  //   page-leg (/{page-id}/product_catalogs) surfaced catalogs the
  //   merchant could SEE in the picker but the catalog sync couldn't
  //   READ (GET /{catalog-id}/products → "Unknown method"). Page-
  //   connected shop catalogs and Commerce Manager catalogs share the
  //   same endpoint and ID format but only the latter respond to the
  //   standard products call. With the page-leg active, operators
  //   could pick a non-syncable catalog from the picker and end up
  //   with `📦 catalog sync done: fetched=0 errors=1` on every sync.
  //
  //   user-leg (/me/product_catalogs) doesn't exist as a Graph
  //   endpoint at all — Meta returns "(#100) Tried accessing
  //   nonexisting field (product_catalogs)" on every call. Pure noise
  //   in the logs.
  //
  // Backlog: re-add the page-leg with a smoke-test filter — fetch
  // /{catalog-id}?fields=vertical,owner_business and only surface
  // catalogs where owner_business is non-null. That filters out
  // page-shop-only catalogs while still catching IG-Shopping
  // catalogs that ARE Business-owned but invisible via /me/businesses
  // (the original motivating case).

  return out;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchAccountSummary,
  listAccountOptions,
  isConfigured,
  SCOPES
};
