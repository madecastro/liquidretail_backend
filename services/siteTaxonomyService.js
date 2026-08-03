// Extract a site's own taxonomy and social proof from a product page.
//
// WHY: CatalogProduct carries `brand` and `category` as free-text strings from
// Meta's feed, whose taxonomy "varies" (its own comment says so). Nothing records
// the SLUGS — the stable, machine-readable identifiers the site uses for brand,
// category and product. Those are what let us group ads by category, target a
// brand's own collection pages, and dedupe products across a re-sync. They are
// missing today, and nobody notices a missing slug until a campaign needs to
// target one.
//
// SOURCE PRIORITY — most trustworthy first, and the order matters:
//   1. JSON-LD BreadcrumbList   the site's OWN assertion of where a product sits
//                               in its hierarchy, ordered, and it survives the
//                               redesigns that break CSS selectors
//   2. JSON-LD Product          brand, name, sku, and aggregateRating
//   3. canonical / og:url       the definitive product URL when the fetched URL
//                               was a redirect, an AMP page or carried tracking
//   4. URL path patterns        last resort, and platform-shaped
//
// Deliberately PURE: html in, object out, no network and no DB. That makes it
// testable against saved fixtures, which is how it gets tested against 16 real
// sites for free instead of hammering them on every edit.

'use strict';

/** JSON-LD blocks, flattened through @graph, malformed blocks skipped. */
function parseJsonLd(html) {
  const out = [];
  if (!html) return out;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim().replace(/^﻿/, '');
    // Some themes emit HTML-escaped JSON inside the script tag.
    if (raw.includes('&quot;') && !raw.includes('"')) {
      raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }
    try {
      const parsed = JSON.parse(raw);
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!node || typeof node !== 'object') continue;
        out.push(node);
        if (Array.isArray(node['@graph'])) out.push(...node['@graph'].filter(n => n && typeof n === 'object'));
      }
    } catch { /* malformed ld+json is extremely common; a bad block is not a failure */ }
  }
  return out;
}

const typesOf = (node) => {
  const t = node && (node['@type'] || node.type);
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(String);
};
const isType = (node, name) => typesOf(node).some(t => t.toLowerCase() === name.toLowerCase());

/** Walk every nested object once, cycle-safe. */
function walk(nodes, visit) {
  const stack = [...nodes];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (visit(n) === false) return;
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

/**
 * Turn a label or URL tail into a slug. Never invents words — it only lowercases,
 * strips diacritics and joins on hyphens, so "Women's All Weather Flats" becomes
 * "womens-all-weather-flats" and stays traceable back to the source label.
 */
function slugify(input) {
  if (!input) return null;
  const s = String(input)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/['’`]/g, '')                                // possessives, not separators
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || null;
}

/** Last meaningful path segment of a URL, query and fragment discarded. */
function slugFromUrl(url, patterns) {
  if (!url) return null;
  let path;
  try { path = new URL(url, 'https://x.invalid').pathname; }
  catch { path = String(url).split(/[?#]/)[0]; }
  for (const re of patterns) {
    const m = path.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}

const PRODUCT_URL_RES = [
  /\/products?\/([a-z0-9][a-z0-9._-]{1,})/i,   // shopify, woo, most DTC
  /\/p\/([a-z0-9][a-z0-9._-]{1,})/i,            // target, many retailers
  /\/ip\/[^/]*?\/?(\d{6,})/i,                   // walmart: /ip/<name>/<id>
  /\/dp\/([A-Z0-9]{10})/,                       // amazon ASIN
  /\/itm\/(\d{6,})/i                            // ebay
];
const COLLECTION_URL_RES = [
  /\/collections?\/([a-z0-9][a-z0-9._-]{1,})/i,
  /\/(?:category|categories)\/([a-z0-9][a-z0-9._-]{1,})/i,
  /\/c\/([a-z0-9][a-z0-9._-]{1,})/i,
  /\/shop\/([a-z0-9][a-z0-9._-]{1,})/i
];
const BRAND_URL_RES = [
  /\/brands?\/([a-z0-9][a-z0-9._-]{1,})/i,
  /\/b\/([a-z0-9][a-z0-9._-]{1,})/i
];

/**
 * Is this URL plausibly a product page on the expected site?
 *
 * Both false positives found in testing came from URL DISCOVERY, not parsing, and
 * each produced a confident-looking slug from a page that was not a product:
 *   target.attn.tv/p/7Yb/landing-page          -> "7yb"   (off-domain SMS landing page)
 *   homedepot.com/sitemap/P/PIPs/PIP/PIP-0.xml -> "pips"   (a sitemap file; /P/ read as /p/)
 *
 * A wrong slug is worse than no slug: it looks like data and silently mis-groups a
 * product forever. So the guard runs before extraction and refuses both shapes.
 *
 * @param {string} url
 * @param {string|null} origin expected site origin, e.g. 'https://www.target.com'
 */
function isPlausibleProductUrl(url, origin = null) {
  if (!url) return { ok: false, reason: 'no url' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: 'unparseable url' }; }

  if (/\.(xml|gz|json|txt|rss|atom)$/i.test(u.pathname)) {
    return { ok: false, reason: `not a page: ${u.pathname.match(/\.\w+$/)[0]}` };
  }
  if (/\/sitemap/i.test(u.pathname)) return { ok: false, reason: 'sitemap path' };

  if (origin) {
    let o;
    try { o = new URL(origin); } catch { o = null; }
    if (o) {
      // registrable-domain comparison, so www vs bare host is fine but
      // target.attn.tv against target.com is not
      const base = (h) => h.replace(/^www\./i, '').split('.').slice(-2).join('.');
      const sameSite = base(u.hostname.toLowerCase()) === base(o.hostname.toLowerCase());
      const sameHost = u.hostname.toLowerCase().replace(/^www\./, '') === o.hostname.toLowerCase().replace(/^www\./, '');
      if (!sameHost && !sameSite) return { ok: false, reason: `off-site host ${u.hostname}` };
      // same registrable domain but a different subdomain is a marketing/CDN host
      // more often than a catalog, so it is reported rather than trusted silently
      if (!sameHost && sameSite) return { ok: true, reason: `subdomain ${u.hostname}`, weak: true };
    }
  }
  return { ok: true, reason: null };
}

/**
 * A slug that is too short or structureless is almost certainly a mis-parse.
 * Numeric ids are legitimate (walmart /ip/<id>, ebay /itm/<id>), so those are
 * allowed at any length; word slugs need real substance.
 */
function isPlausibleSlug(slug) {
  if (!slug) return false;
  if (/^\d{5,}$/.test(slug)) return true;              // numeric product id
  if (/^[a-z0-9]{10}$/.test(slug)) return true;         // amazon ASIN shape
  if (slug.includes('-') && slug.length >= 6) return true;
  return slug.length >= 12;                             // long single word, no hyphen
}

function metaContent(html, keys) {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["']`, 'i');
    const m = html.match(re);
    if (m) return m[1];
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
    const m2 = html.match(re2);
    if (m2) return m2[1];
  }
  return null;
}

function canonicalUrl(html) {
  const link = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
            || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  return (link && link[1]) || metaContent(html, ['og:url']) || null;
}

/**
 * BreadcrumbList -> ordered trail. This is the best category source available:
 * the site states its own hierarchy, in order, with both label and URL, so we can
 * record a slug AND the human label without guessing which nav link mattered.
 *
 * The last crumb is usually the product itself and is reported separately rather
 * than being mistaken for a category.
 */
function breadcrumbTrail(nodes) {
  let best = null;
  walk(nodes, (n) => {
    if (!isType(n, 'BreadcrumbList') || !Array.isArray(n.itemListElement)) return;
    const items = n.itemListElement
      .map((el) => {
        const pos = Number(el?.position ?? el?.['@position'] ?? NaN);
        const item = el?.item;
        const name = el?.name || (typeof item === 'string' ? null : item?.name) || null;
        const url = typeof item === 'string' ? item : (item?.['@id'] || item?.url || el?.['@id'] || null);
        return { position: Number.isFinite(pos) ? pos : null, name: name ? String(name).trim() : null, url: url || null };
      })
      .filter(x => x.name || x.url);
    if (!items.length) return;
    items.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    if (!best || items.length > best.length) best = items;
  });
  return best || [];
}

function productNode(nodes) {
  let found = null;
  walk(nodes, (n) => {
    if (!isType(n, 'Product')) return;
    // prefer a node that actually carries identity, not a stub reference
    if (!found || (n.name && !found.name) || (n.aggregateRating && !found.aggregateRating)) found = n;
  });
  return found;
}

function aggregateFrom(nodes) {
  let agg = null;
  walk(nodes, (n) => {
    const ar = n.aggregateRating;
    if (!ar || typeof ar !== 'object') return;
    const rating = ar.ratingValue ?? ar.ratingvalue ?? null;
    const count = ar.reviewCount ?? ar.ratingCount ?? ar.reviewcount ?? null;
    if (rating == null && count == null) return;
    const num = (v) => {
      if (v == null) return null;
      const f = parseFloat(String(v).replace(/,/g, ''));
      return Number.isFinite(f) ? f : null;
    };
    const next = {
      rating: num(rating),
      reviewCount: num(count),
      bestRating: num(ar.bestRating) ?? 5,
      onType: typesOf(n)[0] || null
    };
    // a rating attached to the Product beats one attached to the Organization
    if (!agg || next.onType === 'Product') agg = next;
  });
  return agg;
}

/**
 * @param {string} html   product page HTML
 * @param {string} pageUrl the URL fetched (may be a redirect or tracking-laden)
 * @returns {object} taxonomy + social proof, with per-field provenance
 */
function extractTaxonomy(html, pageUrl = null, { origin = null } = {}) {
  const nodes = parseJsonLd(html || '');
  // Refuse to derive slugs from a URL that is not a product page on this site.
  const urlCheck = isPlausibleProductUrl(pageUrl || '', origin);
  const canonical = html ? canonicalUrl(html) : null;
  const urlForSlugs = canonical || pageUrl || null;

  const trail = breadcrumbTrail(nodes);
  const product = productNode(nodes);
  const agg = aggregateFrom(nodes);

  // Last crumb is the product; everything before it is category hierarchy.
  const crumbs = trail.slice();
  const tail = crumbs.length > 1 ? crumbs[crumbs.length - 1] : null;
  const categoryCrumbs = crumbs.length > 1 ? crumbs.slice(0, -1) : crumbs;

  // Drop a leading "Home" crumb — it is navigation, not taxonomy.
  const cats = categoryCrumbs.filter(c => !/^(home|homepage)$/i.test(String(c.name || '')));

  const categoryPath = cats.map(c => ({
    label: c.name || null,
    slug: slugFromUrl(c.url, COLLECTION_URL_RES) || slugify(c.name),
    url: c.url || null
  })).filter(c => c.slug || c.label);

  const brandName = product && product.brand
    ? (typeof product.brand === 'string' ? product.brand : (product.brand.name || null))
    : null;

  const rawProductSlug = slugFromUrl(urlForSlugs, PRODUCT_URL_RES)
    || (tail?.url ? slugFromUrl(tail.url, PRODUCT_URL_RES) : null);
  // Canonical is trusted even when the FETCHED url was suspect — a site that
  // declares its own canonical has told us where the product lives.
  const trustUrl = canonical ? { ok: true, reason: 'canonical' } : urlCheck;
  const slugRejected = !trustUrl.ok ? trustUrl.reason
    : (rawProductSlug && !isPlausibleSlug(rawProductSlug) ? `implausible slug "${rawProductSlug}"` : null);
  const productSlug = slugRejected ? null : rawProductSlug;

  // Brand fallbacks, most authoritative first. json-ld Product.brand is best, then
  // an Organization node, then og:site_name — which is the store's own name and is
  // present on nearly every commerce page even when structured data is thin.
  let orgName = null;
  walk(nodes, (n) => { if (!orgName && isType(n, 'Organization') && n.name) orgName = String(n.name).trim(); });
  // og:site_name is often a marketing string rather than a brand name:
  // "Gymshark | We Do Gym" and "Walmart.com" both appeared in testing. Take the
  // part before the first separator and drop a trailing TLD, so the slug is the
  // brand and not the tagline.
  const cleanSiteName = (v) => {
    if (!v) return null;
    let out = String(v).split(/\s*[|–—·:•]\s*/)[0].trim();
    out = out.replace(/\.(com|co|net|shop|store|io|us|co\.uk)$/i, '').trim();
    return out || null;
  };
  const siteName = cleanSiteName(html ? metaContent(html, ['og:site_name', 'application-name']) : null);
  // Organization.name carries taglines too, so it gets the same treatment.
  const brandLabel = brandName || cleanSiteName(orgName) || siteName || null;
  const brandSlug = slugFromUrl(urlForSlugs, BRAND_URL_RES)
    || (brandLabel ? slugify(brandLabel) : null);

  return {
    productSlug,
    productName: (product && product.name) || tail?.name || metaContent(html || '', ['og:title']) || null,
    sku: (product && (product.sku || product.mpn)) || null,
    brandName: brandLabel,
    brandSlug,
    // deepest category first is how a human describes it; keep source order too
    categoryPath,
    categorySlug: categoryPath.length ? categoryPath[categoryPath.length - 1].slug : null,
    collectionSlug: slugFromUrl(urlForSlugs, COLLECTION_URL_RES),
    socialProof: agg,
    canonicalUrl: canonical,
    rejected: slugRejected,
    provenance: {
      breadcrumbs: trail.length ? 'json-ld:BreadcrumbList' : null,
      product: product ? 'json-ld:Product' : null,
      aggregate: agg ? `json-ld:${agg.onType || 'aggregateRating'}` : null,
      productSlug: productSlug ? (canonical ? 'canonical' : 'pageUrl') : null,
      brandSlug: brandSlug
        ? (slugFromUrl(urlForSlugs, BRAND_URL_RES) ? 'url'
          : brandName ? 'json-ld:Product.brand'
          : orgName ? 'json-ld:Organization'
          : siteName ? 'og:site_name' : null)
        : null
    }
  };
}

/**
 * Slugs from a sitemap XML body. Cheap bulk taxonomy: one fetch can enumerate a
 * whole catalog's product handles and collection paths without touching a single
 * product page.
 */
function extractSitemapSlugs(xml) {
  const locs = [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
  const products = new Set(), collections = new Set(), brands = new Set(), childMaps = [];
  for (const u of locs) {
    if (/\.xml(\.gz)?$/i.test(u)) { childMaps.push(u); continue; }
    const p = slugFromUrl(u, PRODUCT_URL_RES);
    if (p) { products.add(p); continue; }
    const c = slugFromUrl(u, COLLECTION_URL_RES);
    if (c) { collections.add(c); continue; }
    const b = slugFromUrl(u, BRAND_URL_RES);
    if (b) brands.add(b);
  }
  return {
    productSlugs: [...products],
    collectionSlugs: [...collections],
    brandSlugs: [...brands],
    childSitemaps: childMaps,
    totalLocs: locs.length
  };
}

module.exports = {
  extractTaxonomy,
  isPlausibleProductUrl,
  isPlausibleSlug,
  extractSitemapSlugs,
  // exported for the verification harness
  parseJsonLd, breadcrumbTrail, slugify, slugFromUrl, canonicalUrl, aggregateFrom,
  PRODUCT_URL_RES, COLLECTION_URL_RES, BRAND_URL_RES
};
