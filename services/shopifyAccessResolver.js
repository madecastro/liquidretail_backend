// services/shopifyAccessResolver.js
//
// Resolves how to read a client's Shopify catalog when the primary domain
// may be HEADLESS (Hydrogen/Oxygen, custom Next.js/Remix that don't serve
// /products.json). Tries a ladder of documented public methods and returns
// a uniform normalized product array so the existing ingester loop is reused
// unchanged.
//
// Ladder (stop at first that yields products):
//   1. classic     GET {custom}/products.json?limit=250&page=N
//   2. myshopify   discover backend via homepage HTML, retry products.json
//   3. storefront  tokenless Storefront GraphQL (api/2026-07, page size 50,
//                  complexity ≤1000 — no token header)
//   4. sitemap     /sitemap.xml → sitemap_products_* → {loc}.json / {loc}.js
//
// Gotchas:
//   - products.json variants.price = STRING decimal ("19.99");
//     Storefront GraphQL returns {amount, currencyCode} — normalize to string.
//   - origin returned is the EFFECTIVE backend (myshopify if discovered,
//     else the custom domain) so downstream media/review fetches hit a host
//     that actually serves /products/{handle}.js + HTML.
//   - tokenless GraphQL: no X-Shopify-Storefront-Access-Token; keep query
//     complexity ≤1000 (page size 50, variants 100, images/media 20).
//
// NODE 18+, no new deps. Uses services/httpScrapeClient.js.

const http = require('./httpScrapeClient');

// ── constants ──────────────────────────────────────────────────────
const DEFAULT_CAP        = 200;
const PRODUCTS_JSON_PAGE = 250;
const GQL_PAGE_SIZE      = 50;
const GQL_API_VERSION    = '2026-07';
const LOG                = '🛍';

// ── shared normalizers ─────────────────────────────────────────────

// Absolutize a Shopify asset URL. products.json returns absolute https
// CDN urls; the AJAX /products/<handle>.js endpoint returns bare or
// protocol-relative ("//cdn.shopify.com/…") strings that break new URL()
// and Cloudinary fetch downstream.
function _absUrl(u) {
  if (!u || typeof u !== 'string') return null;
  const s = u.trim();
  if (!s) return null;
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

// Shopify prices differ by surface: /products.json (and /products/<h>.json)
// return a STRING decimal ("19.99"); the AJAX /products/<h>.js endpoint
// returns an integer number of CENTS (1999). The JS type is the reliable
// discriminator — divide numbers by 100 so the .js fallback doesn't inflate
// every price ~100×.
function _shopifyMoney(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return (val / 100).toFixed(2);
  }
  return String(val);
}

// ── origin / discovery helpers ─────────────────────────────────────

/**
 * resolveStoreOrigin(brand) → origin string | null
 * brand.apifyDemo?.shopifyUrl || brand?.shopifyUrl || brand?.websiteUrl
 */
function resolveStoreOrigin(brand) {
  const raw = brand?.apifyDemo?.shopifyUrl || brand?.shopifyUrl || brand?.websiteUrl;
  if (!raw) return null;
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/**
 * discoverMyshopifyDomain(html) → "foo.myshopify.com" | null
 * Priority:
 *   1. Shopify.shop = "x.myshopify.com" JS global
 *   2. permanent-domain meta / link
 *   3. explicit x.myshopify.com string in HTML
 * A bare cdn.shopify.com/s/files/1/<digits>/<digits>/ hash alone cannot be
 * mapped to a myshopify host — only accept an explicit x.myshopify.com.
 */
function discoverMyshopifyDomain(html) {
  if (!html || typeof html !== 'string') return null;

  // 1. Shopify.shop = "x.myshopify.com" (or Shopify.shop="…")
  let m = html.match(/Shopify\.shop\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i);
  if (m) return m[1].toLowerCase();

  // 2. permanent-domain meta or link
  m = html.match(/<meta[^>]+(?:name|property)\s*=\s*["'](?:shopify-?permanent-domain|permanent-domain)["'][^>]+content\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["'][^>]+(?:name|property)\s*=\s*["'](?:shopify-?permanent-domain|permanent-domain)["']/i);
  if (m) return m[1].toLowerCase();

  m = html.match(/<link[^>]+rel\s*=\s*["'](?:canonical|alternate)["'][^>]+href\s*=\s*["']https?:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)/i);
  if (m) return m[1].toLowerCase();

  // 3. any explicit x.myshopify.com string (first hit)
  m = html.match(/\b([a-z0-9][a-z0-9-]*\.myshopify\.com)\b/i);
  if (m) return m[1].toLowerCase();

  return null;
}

// ── GraphQL → normalizedProduct ────────────────────────────────────

function gidToLegacyId(gid) {
  if (gid == null) return null;
  const s = String(gid);
  // gid://shopify/Product/1234567890 → 1234567890 as a NUMBER, matching the
  // numeric ids the products.json / sitemap rungs emit. Keeping one stable
  // type across access modes means the same catalog id upserts/dedupes to
  // the same key no matter which rung resolved it. Shopify ids are well
  // within Number.MAX_SAFE_INTEGER; if one ever isn't, keep the digit
  // string rather than silently lose precision.
  const m = s.match(/\/(\d+)\s*$/);
  const digits = m ? m[1] : (/^\d+$/.test(s) ? s : null);
  if (digits != null) {
    const n = Number(digits);
    return Number.isSafeInteger(n) ? n : digits;
  }
  return s;
}

function moneyToDecimalString(money) {
  // GraphQL MoneyV2: { amount: "19.99", currencyCode: "USD" } or null
  if (money == null) return null;
  if (typeof money === 'string' || typeof money === 'number') {
    const n = Number(money);
    return Number.isFinite(n) ? String(money) : null;
  }
  if (typeof money === 'object' && money.amount != null) {
    return String(money.amount);
  }
  return null;
}

/**
 * mapStorefrontProduct(node) → normalizedProduct
 * Matches products.json item shape. Sets _storefrontVideos when Video media present.
 */
function mapStorefrontProduct(node) {
  if (!node) return null;

  const id = gidToLegacyId(node.id);
  const variants = Array.isArray(node.variants?.nodes)
    ? node.variants.nodes
    : Array.isArray(node.variants?.edges)
      ? node.variants.edges.map(e => e?.node).filter(Boolean)
      : [];

  const images = Array.isArray(node.images?.nodes)
    ? node.images.nodes
    : Array.isArray(node.images?.edges)
      ? node.images.edges.map(e => e?.node).filter(Boolean)
      : [];

  const mediaNodes = Array.isArray(node.media?.nodes)
    ? node.media.nodes
    : Array.isArray(node.media?.edges)
      ? node.media.edges.map(e => e?.node).filter(Boolean)
      : [];

  const tags = Array.isArray(node.tags)
    ? node.tags.map(t => String(t))
    : typeof node.tags === 'string'
      ? node.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];

  const normalized = {
    id,
    handle: node.handle || null,
    title: node.title || null,
    body_html: node.descriptionHtml || node.description || null,
    vendor: node.vendor || null,
    product_type: node.productType || null,
    tags,
    published_at: node.publishedAt || null,
    variants: variants.map(v => ({
      id: gidToLegacyId(v.id),
      price: moneyToDecimalString(v.price) ?? '0.00',
      compare_at_price: moneyToDecimalString(v.compareAtPrice),
      sku: v.sku || null,
      barcode: v.barcode || null,
      available: v.availableForSale != null ? !!v.availableForSale : true
    })),
    images: images.map(img => ({
      id: gidToLegacyId(img.id),
      src: img.url || img.src || null
    })).filter(img => img.src)
  };

  // Video media → _storefrontVideos (only set on the graphql rung)
  const videos = [];
  for (const m of mediaNodes) {
    // Inline fragment ... on Video — typename may be present
    const isVideo = m && (
      m.__typename === 'Video' ||
      (Array.isArray(m.sources) && m.sources.length && (m.sources[0].format || m.sources[0].url))
    );
    if (!isVideo) continue;
    // Skip if it looks like an image-only media node
    if (m.__typename && m.__typename !== 'Video') continue;
    const sources = Array.isArray(m.sources) ? m.sources : [];
    if (!sources.length) continue;
    videos.push({
      id: gidToLegacyId(m.id),
      sources: sources.map(s => ({
        url: s.url || null,
        format: s.format || null,
        width: s.width ?? null,
        height: s.height ?? null
      })).filter(s => s.url),
      duration: m.duration ?? null,
      aspect_ratio: m.aspectRatio ?? m.aspect_ratio ?? null
    });
  }
  if (videos.length) normalized._storefrontVideos = videos;

  return normalized;
}

// ── sitemap product → normalizedProduct ────────────────────────────

/**
 * mapSitemapProduct(json) → normalizedProduct | null
 * Accepts either { product: {...} } (from .json) or the bare product
 * object / AJAX .js shape.
 */
function mapSitemapProduct(json) {
  if (!json || typeof json !== 'object') return null;
  const p = json.product && typeof json.product === 'object' ? json.product : json;
  if (!p || (p.id == null && !p.handle)) return null;

  // tags: products.json = array; some endpoints = comma string
  let tags = p.tags;
  if (typeof tags === 'string') {
    tags = tags.split(',').map(t => t.trim()).filter(Boolean);
  } else if (!Array.isArray(tags)) {
    tags = [];
  } else {
    tags = tags.map(t => String(t));
  }

  const variants = Array.isArray(p.variants) ? p.variants : [];
  const images = Array.isArray(p.images)
    ? p.images
    : Array.isArray(p.media)
      ? p.media.filter(m => m && (m.media_type === 'image' || !m.media_type))
      : [];

  return {
    id: p.id != null ? p.id : null,
    handle: p.handle || null,
    title: p.title || null,
    body_html: p.body_html || p.description || null,
    vendor: p.vendor || null,
    product_type: p.product_type || p.type || null,
    tags,
    published_at: p.published_at || p.publishedAt || null,
    variants: variants.map(v => ({
      id: v.id != null ? v.id : null,
      // _shopifyMoney handles the .json (string decimal) vs .js (integer
      // cents) split — see its comment. Without this the .js fallback stored
      // every price ~100× too high.
      price: _shopifyMoney(v.price, '0.00'),
      compare_at_price: _shopifyMoney(v.compare_at_price, null),
      sku: v.sku || null,
      barcode: v.barcode || null,
      available: v.available != null ? !!v.available
        : v.availableForSale != null ? !!v.availableForSale
        : true
    })),
    // .json images are objects ({id, src}); the .js endpoint returns bare
    // URL strings (often protocol-relative). Handle both so the .js path
    // doesn't silently drop every image.
    images: images.map(img => {
      if (typeof img === 'string') return { id: null, src: _absUrl(img) };
      return { id: img.id != null ? img.id : null, src: _absUrl(img.src || img.url || null) };
    }).filter(img => img.src)
  };
}

// ── rung implementations ───────────────────────────────────────────

// A classified `block` is not automatically a bot wall. classifyBlock also
// emits vendor:'rate-limited' for a 429 — that has a dedicated reason and a
// backoff-retry remedy, so recording it as a "block" would both override the
// rate-limit reason and tell an operator to buy an unblocker for what is
// really "slow down".
function isLadderBlock(b) {
  return !!(b && b.vendor && b.vendor !== 'rate-limited');
}

async function fetchProductsJson(origin, { cap, abortCheck, run }) {
  const products = [];
  let page = 1;
  let rateLimited = false;
  let blocked = null;

  while (products.length < cap) {
    if (await abortCheck()) break;

    const url = `${origin}/products.json?limit=${PRODUCTS_JSON_PAGE}&page=${page}`;
    let res;
    try {
      res = await http.fetchJson(url);
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  products.json page ${page} error: ${err.message}`);
      break;
    }

    // Read the classified block BEFORE the rate-limit break: a CF challenge
    // sets cfChallenged AND carries a block, and breaking first threw the
    // vendor away. Sitemap/homepage already ordered it this way.
    if (!blocked && isLadderBlock(res.block)) {
      blocked = res.block;
      console.warn(
        `   ⚠️  ${LOG}  products.json BLOCKED at page ${page} ` +
        `vendor=${res.block.vendor} confidence=${res.block.confidence} remedy=${res.block.remedy}`
      );
    }
    if (res.rateLimited || res.cfChallenged) {
      rateLimited = true;
      console.warn(`   ⚠️  ${LOG}  products.json rate-limited/CF at page ${page}`);
      break;
    }
    if (!res.ok) break;

    const batch = Array.isArray(res.json?.products) ? res.json.products : [];
    if (!batch.length) break;

    for (const p of batch) {
      if (products.length >= cap) break;
      products.push(p);
    }

    if (batch.length < PRODUCTS_JSON_PAGE) break;
    page += 1;
  }

  return { products, rateLimited, blocked };
}

const STOREFRONT_PRODUCTS_QUERY = `
query Products($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
      title
      descriptionHtml
      vendor
      productType
      tags
      publishedAt
      variants(first: 100) {
        nodes {
          id
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          sku
          barcode
          availableForSale
        }
      }
      images(first: 20) {
        nodes { id url }
      }
      media(first: 20) {
        nodes {
          ... on Video {
            id
            sources { url format width height }
            duration
            aspectRatio
          }
        }
      }
    }
  }
}`.trim();

async function fetchStorefrontGraphql(origin, { cap, abortCheck, run }) {
  const products = [];
  let after = null;
  let rateLimited = false;
  let blocked = null;
  const endpoint = `${origin}/api/${GQL_API_VERSION}/graphql.json`;

  while (products.length < cap) {
    if (await abortCheck()) break;

    let res;
    try {
      // httpScrapeClient.fetchJson — POST via opts
      res = await http.fetchJson(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: STOREFRONT_PRODUCTS_QUERY,
          variables: { first: GQL_PAGE_SIZE, after }
        })
      });
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  storefront graphql error: ${err.message}`);
      break;
    }

    if (!blocked && isLadderBlock(res.block)) {
      blocked = res.block;
      console.warn(
        `   ⚠️  ${LOG}  storefront graphql BLOCKED vendor=${res.block.vendor} ` +
        `confidence=${res.block.confidence} remedy=${res.block.remedy}`
      );
    }
    if (res.rateLimited || res.cfChallenged) {
      rateLimited = true;
      console.warn(`   ⚠️  ${LOG}  storefront graphql rate-limited/CF`);
      break;
    }
    // GraphQL errors array or non-200 → skip rung
    if (!res.ok || !res.json) break;
    if (Array.isArray(res.json.errors) && res.json.errors.length) {
      console.warn(`   ⚠️  ${LOG}  storefront graphql errors: ${res.json.errors[0]?.message || 'unknown'}`);
      break;
    }

    const conn = res.json?.data?.products;
    if (!conn) break;

    const nodes = Array.isArray(conn.nodes)
      ? conn.nodes
      : Array.isArray(conn.edges)
        ? conn.edges.map(e => e?.node).filter(Boolean)
        : [];

    if (!nodes.length) break;

    for (const node of nodes) {
      if (products.length >= cap) break;
      const mapped = mapStorefrontProduct(node);
      if (mapped) products.push(mapped);
    }

    const pageInfo = conn.pageInfo || {};
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }

  return { products, rateLimited, blocked };
}

async function fetchViaSitemap(origin, { cap, abortCheck, run }) {
  const products = [];
  let rateLimited = false;
  let blocked = null;
  // First block wins — the vendor is the same across a store, and the first
  // one is the earliest point the ladder was actually stopped.
  const noteBlock = (res, where) => {
    if (blocked || !isLadderBlock(res && res.block)) return;
    blocked = res.block;
    console.warn(
      `   ⚠️  ${LOG}  sitemap ${where} BLOCKED vendor=${res.block.vendor} ` +
      `confidence=${res.block.confidence} remedy=${res.block.remedy}`
    );
  };

  if (await abortCheck()) return { products, rateLimited, blocked };

  const sitemapUrl = `${origin}/sitemap.xml`;
  let rootRes;
  try {
    rootRes = await http.fetchText(sitemapUrl);
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  sitemap.xml fetch error: ${err.message}`);
    return { products, rateLimited, blocked };
  }

  noteBlock(rootRes, 'sitemap.xml');
      if (rootRes.rateLimited || rootRes.cfChallenged) {
    return { products, rateLimited: true, blocked };
  }
  if (!rootRes.ok || !rootRes.text) return { products, rateLimited, blocked };

  const rootXml = rootRes.text;

  // Collect child sitemaps matching /sitemap_products/i, else treat root as product sitemap
  const sitemapLocs = [];
  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  const allLocs = [];
  while ((m = locRe.exec(rootXml)) !== null) {
    const loc = (m[1] || '').trim();
    if (loc) allLocs.push(loc);
  }

  for (const loc of allLocs) {
    if (/sitemap_products/i.test(loc)) sitemapLocs.push(loc);
  }

  // Product page URLs to fetch
  const productUrls = [];

  const collectFromXml = (xml) => {
    const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    let mm;
    while ((mm = re.exec(xml)) !== null) {
      const loc = (mm[1] || '').trim();
      if (!loc) continue;
      // product URLs look like …/products/handle
      if (/\/products\/[^/]+\/?$/i.test(loc) || /\/products\/[^/?#]+/i.test(loc)) {
        if (productUrls.length < cap) productUrls.push(loc.replace(/\/+$/, ''));
      }
    }
  };

  if (sitemapLocs.length) {
    for (const smUrl of sitemapLocs) {
      if (productUrls.length >= cap) break;
      if (await abortCheck()) break;

      let smRes;
      try {
        smRes = await http.fetchText(smUrl);
      } catch (err) {
        console.warn(`   ⚠️  ${LOG}  product sitemap fetch error ${smUrl}: ${err.message}`);
        continue;
      }
      noteBlock(smRes, 'child-sitemap');
      if (smRes.rateLimited || smRes.cfChallenged) {
        rateLimited = true;
        break;
      }
      if (!smRes.ok || !smRes.text) continue;
      collectFromXml(smRes.text);
    }
  } else {
    // Root itself may be the product sitemap
    collectFromXml(rootXml);
  }

  console.log(`   · ${LOG}  sitemap collected ${productUrls.length} product URLs (cap=${cap})`);

  for (const loc of productUrls) {
    if (products.length >= cap) break;
    if (await abortCheck()) break;

    // Respect robots before fetching product pages
    let allowed = true;
    try {
      allowed = await http.isAllowedByRobots(loc);
    } catch {
      allowed = true; // fail-open if robots check throws
    }
    if (!allowed) {
      console.log(`   · ${LOG}  robots disallows ${loc} — skip`);
      continue;
    }

    // Prefer {loc}.json → {product:{…}}; fall back to {loc}.js
    let mapped = null;

    const jsonUrl = loc.endsWith('.json') ? loc : `${loc}.json`;
    try {
      const jRes = await http.fetchJson(jsonUrl);
      noteBlock(jRes, 'product .json');
      if (jRes.rateLimited || jRes.cfChallenged) {
        rateLimited = true;
        break;
      }
      if (jRes.ok && jRes.json) {
        mapped = mapSitemapProduct(jRes.json);
      }
    } catch (err) {
      // fall through to .js
    }

    if (!mapped) {
      if (await abortCheck()) break;
      const jsUrl = loc.endsWith('.js') ? loc : `${loc}.js`;
      try {
        const tRes = await http.fetchText(jsUrl);
        noteBlock(tRes, 'product .js');
      if (tRes.rateLimited || tRes.cfChallenged) {
          rateLimited = true;
          break;
        }
        if (tRes.ok && tRes.text) {
          try {
            const parsed = JSON.parse(tRes.text);
            mapped = mapSitemapProduct(parsed);
          } catch {
            // not json
          }
        }
      } catch (err) {
        console.warn(`   ⚠️  ${LOG}  product fetch failed ${loc}: ${err.message}`);
      }
    }

    if (mapped) products.push(mapped);
  }

  return { products, rateLimited, blocked };
}

// ── main export ────────────────────────────────────────────────────

/**
 * resolveShopifyAccess(brand, { run, abortCheck, cap })
 *
 * Walks the access ladder and returns a uniform result the ingester can
 * consume without caring which rung succeeded.
 *
 * @returns {{
 *   ok: boolean,
 *   mode: 'products-json'|'storefront-graphql'|'sitemap'|null,
 *   origin: string,
 *   products: object[],
 *   discoveredMyshopify: string|null,
 *   rateLimited?: boolean,
 *   reason?: string
 * }}
 */
async function resolveShopifyAccess(brand, { run = null, abortCheck = async () => false, cap = DEFAULT_CAP } = {}) {
  const CAP = Math.max(1, parseInt(cap, 10) || DEFAULT_CAP);
  const customOrigin = resolveStoreOrigin(brand);

  if (!customOrigin) {
    return {
      ok: false,
      mode: null,
      origin: '',
      products: [],
      discoveredMyshopify: null,
      reason: 'no shopifyUrl configured on brand'
    };
  }

  let discoveredMyshopify = null;
  let effectiveOrigin = customOrigin;
  let anyRateLimited = false;
  // First bot-block seen across the whole ladder. Without this a blocked
  // store and an empty store both produced "all access rungs empty", and the
  // caller degraded to the JSON-LD walk as if the store simply had no
  // products — silently trading the full products.json gallery for a single
  // featured thumbnail per product.
  let anyBlocked = null;

  const note = (msg) => {
    console.log(`   · ${LOG}  ${msg}`);
    try { run?.note?.(msg); } catch { /* run.note optional */ }
  };
  const stage = (s) => {
    try { run?.stage?.(s); } catch { /* optional */ }
  };

  // ── 1. classic products.json against custom domain ───────────────
  stage('access: products-json');
  note(`rung 1: products.json @ ${customOrigin}`);
  if (await abortCheck()) {
    return { ok: false, mode: null, origin: customOrigin, products: [], discoveredMyshopify: null, reason: 'aborted' };
  }

  {
    const { products, rateLimited, blocked } = await fetchProductsJson(customOrigin, { cap: CAP, abortCheck, run });
    if (rateLimited) anyRateLimited = true;
    if (isLadderBlock(blocked) && !anyBlocked) anyBlocked = blocked;
    if (products.length) {
      console.log(`${LOG}  resolveShopifyAccess: mode=products-json origin=${customOrigin} n=${products.length}`);
      return {
        ok: true,
        mode: 'products-json',
        origin: customOrigin,
        products: products.slice(0, CAP),
        discoveredMyshopify: null
      };
    }
  }

  // ── 2. myshopify discovery → retry products.json ─────────────────
  stage('access: myshopify-discovery');
  note(`rung 2: discover myshopify via homepage @ ${customOrigin}`);
  if (await abortCheck()) {
    return { ok: false, mode: null, origin: customOrigin, products: [], discoveredMyshopify: null, reason: 'aborted' };
  }

  try {
    const homeRes = await http.fetchText(customOrigin + '/');
    if (isLadderBlock(homeRes.block) && !anyBlocked) anyBlocked = homeRes.block;
    if (homeRes.rateLimited || homeRes.cfChallenged) {
      anyRateLimited = true;
      note('homepage rate-limited/CF during myshopify discovery');
    } else if (homeRes.ok && homeRes.text) {
      const found = discoverMyshopifyDomain(homeRes.text);
      if (found) {
        let customHost = '';
        try { customHost = new URL(customOrigin).hostname.toLowerCase(); } catch { /* */ }
        if (found !== customHost) {
          discoveredMyshopify = found;
          effectiveOrigin = `https://${found}`;
          note(`discovered myshopify backend: ${found}`);

          if (await abortCheck()) {
            return {
              ok: false, mode: null, origin: effectiveOrigin, products: [],
              discoveredMyshopify, reason: 'aborted'
            };
          }

          stage('access: products-json (myshopify)');
          note(`rung 2b: products.json @ ${effectiveOrigin}`);
          const { products, rateLimited, blocked } = await fetchProductsJson(effectiveOrigin, { cap: CAP, abortCheck, run });
          if (rateLimited) anyRateLimited = true;
          if (isLadderBlock(blocked) && !anyBlocked) anyBlocked = blocked;
          if (products.length) {
            console.log(`${LOG}  resolveShopifyAccess: mode=products-json origin=${effectiveOrigin} n=${products.length} (via myshopify discovery)`);
            return {
              ok: true,
              mode: 'products-json',
              origin: effectiveOrigin,
              products: products.slice(0, CAP),
              discoveredMyshopify
            };
          }
        } else {
          note(`myshopify host equals custom host (${found}) — skip retry`);
          discoveredMyshopify = found;
          effectiveOrigin = `https://${found}`;
        }
      } else {
        note('no myshopify domain found in homepage HTML');
      }
    }
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  myshopify discovery failed: ${err.message}`);
  }

  // Origin for remaining rungs: myshopify backend if discovered, else custom
  const gqlOrigin = discoveredMyshopify ? `https://${discoveredMyshopify}` : customOrigin;
  effectiveOrigin = gqlOrigin;

  // ── 3. tokenless Storefront GraphQL ──────────────────────────────
  stage('access: storefront-graphql');
  note(`rung 3: tokenless storefront graphql @ ${gqlOrigin}`);
  if (await abortCheck()) {
    return {
      ok: false, mode: null, origin: effectiveOrigin, products: [],
      discoveredMyshopify, reason: 'aborted'
    };
  }

  {
    const { products, rateLimited, blocked } = await fetchStorefrontGraphql(gqlOrigin, { cap: CAP, abortCheck, run });
    if (rateLimited) anyRateLimited = true;
    if (isLadderBlock(blocked) && !anyBlocked) anyBlocked = blocked;
    if (products.length) {
      console.log(`${LOG}  resolveShopifyAccess: mode=storefront-graphql origin=${gqlOrigin} n=${products.length}`);
      return {
        ok: true,
        mode: 'storefront-graphql',
        origin: gqlOrigin,
        products: products.slice(0, CAP),
        discoveredMyshopify
      };
    }
  }

  // ── 4. sitemap ───────────────────────────────────────────────────
  stage('access: sitemap');
  note(`rung 4: sitemap @ ${gqlOrigin}`);
  if (await abortCheck()) {
    return {
      ok: false, mode: null, origin: effectiveOrigin, products: [],
      discoveredMyshopify, reason: 'aborted'
    };
  }

  {
    const { products, rateLimited, blocked } = await fetchViaSitemap(gqlOrigin, { cap: CAP, abortCheck, run });
    if (rateLimited) anyRateLimited = true;
    if (isLadderBlock(blocked) && !anyBlocked) anyBlocked = blocked;
    if (products.length) {
      console.log(`${LOG}  resolveShopifyAccess: mode=sitemap origin=${gqlOrigin} n=${products.length}`);
      return {
        ok: true,
        mode: 'sitemap',
        origin: gqlOrigin,
        products: products.slice(0, CAP),
        discoveredMyshopify
      };
    }
  }

  // ── total failure ────────────────────────────────────────────────
  // Rate limiting keeps its own dedicated reason — classifyBlock also emits a
  // vendor:'rate-limited' block for a 429, and letting that win here would
  // relabel a backoff-retry situation as a bot wall.
  //
  // A NAMED vendor at high/medium confidence is worth asserting on. A bare
  // 401/403 is not: classifyBlock reports it as generic-403/low, and that is
  // exactly what a PASSWORD-PROTECTED Shopify store returns. Telling an
  // operator "the catalog was never readable, get an unblocker" when the real
  // answer is "the store is password-protected" sends them down the wrong
  // path, so that case gets its own honestly-hedged wording.
  const namedBlock = anyBlocked && anyBlocked.vendor !== 'generic-403' && anyBlocked.confidence !== 'low';
  const reason = anyRateLimited
    ? 'store rate-limited this server — all access rungs empty'
    : namedBlock
      ? `blocked by ${anyBlocked.vendor} (${anyBlocked.confidence} confidence, remedy=${anyBlocked.remedy}) — ` +
        'NOT an empty store; the catalog was never readable'
      : anyBlocked
        ? `access denied (${(anyBlocked.signals || []).join(', ') || anyBlocked.vendor}) — ` +
          'could be a password-protected store or an unidentified bot wall; NOT confirmed empty'
        : 'all access rungs empty (products.json, storefront-graphql, sitemap)';

  console.warn(`${LOG}  resolveShopifyAccess FAILED origin=${customOrigin} reason=${reason}`);

  const out = {
    ok: false,
    mode: null,
    origin: effectiveOrigin || customOrigin,
    products: [],
    discoveredMyshopify,
    reason
  };
  if (anyRateLimited) out.rateLimited = true;
  // Surfaced so the caller can tell "blocked" from "this store is empty" and
  // avoid recording a bot-block as a legitimate zero-product Shopify store.
  if (anyBlocked) out.blocked = anyBlocked;
  return out;
}

module.exports = {
  resolveShopifyAccess,
  // exported for unit tests
  resolveStoreOrigin,
  discoverMyshopifyDomain,
  mapStorefrontProduct,
  mapSitemapProduct
};
