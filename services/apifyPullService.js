// Apify pull — public scrape adapters for Instagram + Shopify. Used
// by demo Brands (created under the Sales Demos advertiser) to pull
// records BEFORE the prospect has done a real OAuth handshake.
//
// One shared token (APIFY_TOKEN) authenticates every call. Actor IDs
// and per-source result limits are env-configurable so the Sales team
// can tune limits without a deploy. Uses Apify's synchronous
// `run-sync-get-dataset-items` endpoint — blocks until the actor
// finishes and returns dataset items in one call, no polling.
//
// Contract: each puller returns a plain array of normalized records.
// Shape normalization stays intentionally shallow — downstream ingest
// services (apify → Media + DetectRun for IG, apify → CatalogProduct
// for Shopify) are responsible for mapping into the domain shape.

const axios = require('axios');
const { cleanScrapedText } = require('../utils/htmlEntities');

const APIFY_API_ROOT = 'https://api.apify.com/v2';

// Actor slugs — override in .env when Apify releases newer scrapers
// or if we want to swap to a different community actor. The default
// Shopify actor (webdatalabs/shopify-product-scraper) takes a "mode"
// switch: 'url' uses our startUrls; 'storeUrls' uses the actor's
// bundled multi-store list. We always send mode='url' explicitly —
// omitting it lets the actor fall back to its default input, which
// scrapes allbirds.com instead of the target store.
const IG_ACTOR      = process.env.APIFY_IG_ACTOR      || 'apify/instagram-scraper';
const SHOPIFY_ACTOR = process.env.APIFY_SHOPIFY_ACTOR || 'webdatalabs/shopify-product-scraper';

// Per-source result-count ceilings. Env-overridable; defaults land in
// the sweet spot for demo-brand ad generation:
//   IG=50    — enough post variety for concept selection without
//              hitting apify/instagram-scraper's flakiness ramp at
//              ~100+ posts. Cost ~$0.20 per pull.
//   Shopify=200 — deep enough for most brand catalogs to seed real
//              product-driven ad concepts. Sits well under the
//              maxPages=10 × ~30-50 products/page hard ceiling
//              (~300-500 from the actor side). Cost ~$0.15 per pull;
//              downstream enrichment (~$0.05-0.12/product) is where
//              real spend lands (~$10-24 first-run).
const IG_LIMIT      = Math.max(1, parseInt(process.env.APIFY_IG_LIMIT, 10)      || 50);
const SHOPIFY_LIMIT = Math.max(1, parseInt(process.env.APIFY_SHOPIFY_LIMIT, 10) || 200);

// Proxy group used by both actors. Options (per Apify):
//   ''             — Apify's default (datacenter). Cheapest, blocked
//                     by anti-scrape firewalls on some Shopify stores
//                     and IG sometimes.
//   RESIDENTIAL    — real-user IPs; bypasses most firewalls / IG
//                     blocks. 5-10x more expensive per GB.
//   AUTO           — actor picks based on target hostname.
//   Any actor-specific group the user's Apify account has enabled.
// Leave APIFY_PROXY_GROUP unset for the default; set to 'RESIDENTIAL'
// on brands whose stores 403 the datacenter proxy.
const APIFY_PROXY_GROUP = process.env.APIFY_PROXY_GROUP || '';

function proxyConfig() {
  const cfg = { useApifyProxy: true };
  if (APIFY_PROXY_GROUP) cfg.apifyProxyGroups = [APIFY_PROXY_GROUP];
  return cfg;
}

// Apify's sync-run endpoint blocks for up to 5 min. Our HTTP client
// caps at 5 min + 15s slack so we always see the actor error, not an
// axios timeout, when Apify itself is slow.
const APIFY_HTTP_TIMEOUT_MS = 5 * 60 * 1000 + 15_000;

function getToken() {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error('APIFY_TOKEN is not set — cannot invoke Apify actors');
  return t;
}

async function runActorSync(actorId, input) {
  const token = getToken();
  const url = `${APIFY_API_ROOT}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const res = await axios.post(url, input, {
    params:  { token },
    timeout: APIFY_HTTP_TIMEOUT_MS,
    headers: { 'content-type': 'application/json' }
  });
  return Array.isArray(res.data) ? res.data : [];
}

// Pull recent public posts for an IG handle. Returns normalized
// items — shape below stays close to Media doc fields so the ingest
// service is a thin mapping layer.
async function pullInstagramPosts(handle, { limit } = {}) {
  if (!handle) throw new Error('IG handle is required');
  const cleanHandle = String(handle).trim().replace(/^@+/, '');
  const resultsLimit = Math.max(1, Math.min(parseInt(limit, 10) || IG_LIMIT, IG_LIMIT));

  const input = {
    directUrls:         [`https://www.instagram.com/${cleanHandle}/`],
    resultsType:        'posts',
    resultsLimit,
    addParentData:      false,
    proxyConfiguration: proxyConfig()
  };
  const items = await runActorSync(IG_ACTOR, input);
  return items.map(normalizeIgPost).filter(Boolean);
}

function normalizeIgPost(raw) {
  if (!raw || !raw.id) return null;
  const isVideo = raw.type === 'Video' || raw.type === 'Reel' || !!raw.videoUrl;
  return {
    externalId:    String(raw.id),
    shortCode:     raw.shortCode || null,
    permalink:     raw.url || (raw.shortCode ? `https://www.instagram.com/p/${raw.shortCode}/` : null),
    mediaType:     isVideo ? 'VIDEO' : 'IMAGE',
    mediaUrl:      isVideo ? (raw.videoUrl || raw.displayUrl) : raw.displayUrl,
    thumbnailUrl:  raw.displayUrl || null,
    caption:       raw.caption || null,
    timestamp:     raw.timestamp || null,
    ownerUsername: raw.ownerUsername || null,
    likeCount:     Number.isFinite(raw.likesCount)    ? raw.likesCount    : null,
    commentsCount: Number.isFinite(raw.commentsCount) ? raw.commentsCount : null
  };
}

// Pull recent products from a public Shopify storefront. Returns
// normalized items shaped for CatalogProduct upsert.
async function pullShopifyProducts(shopUrl, { limit } = {}) {
  if (!shopUrl) throw new Error('Shopify URL is required');
  const maxItems = Math.max(1, Math.min(parseInt(limit, 10) || SHOPIFY_LIMIT, SHOPIFY_LIMIT));

  // Despite mode='url' + a startUrls field being present, the
  // webdatalabs actor actually consumes `storeUrls` as the primary
  // target list — it even validates "At least one store URL is
  // required in URL mode" when storeUrls is empty. Sending our
  // target URL under `startUrls` alone let the actor's default
  // storeUrls (allbirds) win, which was the original bug.
  //
  // Fix: put the target URL in BOTH fields, and cap max* / maxStores
  // so the actor can't wander to other stores its defaults might list.
  const target = String(shopUrl);
  const input = {
    mode:               'url',
    storeUrls:          [{ url: target }],   // the field the actor actually reads
    startUrls:          [{ url: target }],   // belt-and-suspenders — some builds check this too
    maxItems,
    maxProducts:        maxItems,
    maxStores:          1,
    maxPages:           10,
    category:           '',
    proxyConfiguration: proxyConfig()
  };
  const items = await runActorSync(SHOPIFY_ACTOR, input);
  return items.map(normalizeShopifyProduct).filter(Boolean);
}

function normalizeShopifyProduct(raw) {
  if (!raw) return null;
  const externalId = raw.id || raw.productId || raw.handle;
  if (!externalId) return null;

  const images = Array.isArray(raw.images)
    ? raw.images.map(i => (typeof i === 'string' ? i : i?.src || i?.url)).filter(Boolean)
    : [];
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const firstVariant = variants[0] || {};
  const priceStr = raw.price ?? firstVariant.price ?? raw.priceRange?.min ?? null;
  const price    = priceStr != null ? Number(String(priceStr).replace(/[^\d.]/g, '')) : null;

  return {
    externalId:    String(externalId),
    // Actors that scrape HTML hand back entity-encoded text ("33&quot;"),
    // so decode before this becomes CatalogProduct.title.
    title:         cleanScrapedText(raw.title || raw.name),
    description:   raw.description || raw.bodyHtml || null,
    productUrl:    raw.url || raw.productUrl || null,
    imageUrl:      images[0] || raw.image || raw.featuredImage || null,
    additionalImageUrls: images.slice(1),
    price:         Number.isFinite(price) ? price : null,
    currency:      raw.currency || raw.priceRange?.currency || null,
    availability:  raw.available === false ? 'out of stock' : 'in stock',
    brand:         cleanScrapedText(raw.vendor || raw.brand),
    handle:        raw.handle || null
  };
}

module.exports = {
  pullInstagramPosts,
  pullShopifyProducts,
  IG_LIMIT,
  SHOPIFY_LIMIT
};
