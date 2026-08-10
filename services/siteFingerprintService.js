// services/siteFingerprintService.js
//
// PURE platform fingerprint for catalog ingest auto-routing.
// Takes pre-fetched homepage HTML / response headers / robots.txt so
// fingerprinting costs ZERO extra requests — the caller already has
// (or is about to fetch) those inputs for discovery.
//
// platform: 'shopify' | 'woocommerce' | 'bigcommerce' | 'magento' |
//           'salesforce-commerce' | 'spa' | 'unknown'
// confidence: 'high' | 'medium' | 'low' | 'unknown'
//
// Fail-closed: 'unknown' must never remove a rung. Never throws on
// malformed input.
//
// Why this exists (2026-08-10): brands on method=generic-sitemap that
// are actually Shopify stores get ZERO alt images — Shopify's JSON-LD
// Product.image is a single featured image, so imagesFromNode →
// slice(1) → []. products.json carries the full gallery (pb5star:
// mean 7.91 images). The generic path must sense Shopify and climb
// the shopifyAccessResolver ladder instead of scanning PDPs.

'use strict';

const PLATFORMS = Object.freeze([
  'shopify',
  'woocommerce',
  'bigcommerce',
  'magento',
  'salesforce-commerce',
  'spa',
  'unknown'
]);

/**
 * Normalise headers from a Headers instance, Map, or plain object into
 * a lowercase-key plain object. Never throws.
 */
function normalizeHeaders(headers) {
  const out = Object.create(null);
  if (headers == null) return out;

  try {
    // WHATWG Headers / undici
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      headers.forEach((value, key) => {
        if (key == null) return;
        out[String(key).toLowerCase()] = value == null ? '' : String(value);
      });
      return out;
    }
  } catch {
    /* fall through */
  }

  try {
    // Map
    if (typeof headers.entries === 'function' && typeof headers.get === 'function' &&
        typeof headers.keys === 'function' && !Array.isArray(headers)) {
      // Distinguish Map from plain object: Map has size number + get/set
      if (typeof headers.size === 'number' && typeof headers.set === 'function') {
        for (const [key, value] of headers.entries()) {
          if (key == null) continue;
          out[String(key).toLowerCase()] = value == null ? '' : String(value);
        }
        return out;
      }
    }
  } catch {
    /* fall through */
  }

  try {
    if (typeof headers === 'object') {
      // httpScrapeClient _resultHeaders shape: { etag, poweredBy, raw, … }
      // Prefer .raw (full lowercase map) when present.
      if (headers.raw && typeof headers.raw === 'object' && !Array.isArray(headers.raw)) {
        for (const [key, value] of Object.entries(headers.raw)) {
          if (key == null) continue;
          out[String(key).toLowerCase()] = value == null ? '' : String(value);
        }
        // Also fold camelCase extras the client may have projected.
        if (headers.poweredBy != null && out['powered-by'] == null) {
          out['powered-by'] = String(headers.poweredBy);
        }
        if (headers.xShopId != null && out['x-shopid'] == null) {
          out['x-shopid'] = String(headers.xShopId);
        }
        if (headers.xShopifyStage != null && out['x-shopify-stage'] == null) {
          out['x-shopify-stage'] = String(headers.xShopifyStage);
        }
        return out;
      }

      for (const [key, value] of Object.entries(headers)) {
        if (key == null || key === 'raw') continue;
        // camelCase projections from httpScrapeClient
        const lower = String(key).toLowerCase();
        const mapped =
          lower === 'poweredby' ? 'powered-by'
            : lower === 'xshopid' ? 'x-shopid'
              : lower === 'xshopifystage' ? 'x-shopify-stage'
                : lower;
        if (value == null) continue;
        // Skip nested objects (retryAfter number is fine as String)
        if (typeof value === 'object') continue;
        out[mapped] = String(value);
      }
    }
  } catch {
    /* empty */
  }
  return out;
}

function headerHas(headers, name, pred) {
  const v = headers[name];
  if (v == null || v === '') return false;
  return pred ? pred(v) : true;
}

/**
 * Collect platform signals from pre-fetched inputs.
 * Each signal is a short string for the journal/stats.
 */
function collectSignals({ homepageHtml, homepageHeaders, robotsText }) {
  const html = typeof homepageHtml === 'string' ? homepageHtml : '';
  const robots = typeof robotsText === 'string' ? robotsText : '';
  const headers = normalizeHeaders(homepageHeaders);

  /** @type {Record<string, string[]>} */
  const byPlatform = {
    shopify: [],
    woocommerce: [],
    bigcommerce: [],
    magento: [],
    'salesforce-commerce': [],
    spa: []
  };

  // ── Shopify ──────────────────────────────────────────────────────
  // Strongest single signal: Powered-By: Shopify (verified live on
  // pb5star.com and ubeauty.com).
  if (headerHas(headers, 'powered-by', (v) => /shopify/i.test(v))) {
    byPlatform.shopify.push('header:powered-by');
  }
  if (headerHas(headers, 'x-shopid')) {
    byPlatform.shopify.push('header:x-shopid');
  }
  if (headerHas(headers, 'x-shopify-stage')) {
    byPlatform.shopify.push('header:x-shopify-stage');
  }
  if (html) {
    if (/Shopify\.shop\s*=\s*["'][^"']+["']/i.test(html)) {
      byPlatform.shopify.push('body:Shopify.shop');
    }
    if (/cdn\.shopify\.com/i.test(html)) {
      byPlatform.shopify.push('body:cdn.shopify.com');
    }
    if (/\/cdn\/shop\//i.test(html) || /cdn\/shop\//i.test(html)) {
      byPlatform.shopify.push('body:cdn/shop');
    }
    if (/\/cdn\/shopifycloud\//i.test(html)) {
      byPlatform.shopify.push('body:cdn/shopifycloud');
    }
    if (/\b[a-z0-9][a-z0-9-]*\.myshopify\.com\b/i.test(html)) {
      byPlatform.shopify.push('body:myshopify.com');
    }
  }
  // Shopify's canonical robots signature
  if (robots) {
    const hasCheckout = /Disallow:\s*\/checkout/i.test(robots);
    const hasSortBy = /Disallow:\s*\/collections\/\*sort_by\*/i.test(robots) ||
      /Disallow:\s*\/collections\/\*\/\*sort_by/i.test(robots) ||
      /\/collections\/\*sort_by\*/i.test(robots);
    if (hasCheckout && hasSortBy) {
      byPlatform.shopify.push('robots:shopify-signature');
    }
  }

  // ── WooCommerce ──────────────────────────────────────────────────
  if (html) {
    if (/wp-content/i.test(html)) byPlatform.woocommerce.push('body:wp-content');
    if (/wp-json/i.test(html) || /\/wp-json\//i.test(html)) {
      byPlatform.woocommerce.push('body:wp-json');
    }
    if (/woocommerce/i.test(html)) byPlatform.woocommerce.push('body:woocommerce');
  }
  if (headerHas(headers, 'x-wc-store-api-nonce') ||
      headerHas(headers, 'x-wc-session')) {
    byPlatform.woocommerce.push('header:x-wc-*');
  }

  // ── BigCommerce ──────────────────────────────────────────────────
  if (html) {
    if (/cdn\d*\.bigcommerce\.com/i.test(html) || /cdn11\.bigcommerce\.com/i.test(html)) {
      byPlatform.bigcommerce.push('body:cdn.bigcommerce.com');
    }
    if (/bigcommerce/i.test(html)) byPlatform.bigcommerce.push('body:bigcommerce');
  }
  if (headerHas(headers, 'x-bc-context') || headerHas(headers, 'x-bc-apiquery')) {
    byPlatform.bigcommerce.push('header:x-bc-*');
  }

  // ── Magento ──────────────────────────────────────────────────────
  if (html) {
    if (/Mage\.Cookies/i.test(html)) byPlatform.magento.push('body:Mage.Cookies');
    if (/\/static\/version\d+\//i.test(html)) byPlatform.magento.push('body:static/version');
    if (/\bMagento\b/i.test(html)) byPlatform.magento.push('body:Magento');
  }
  for (const k of Object.keys(headers)) {
    if (/^x-magento-/i.test(k)) {
      byPlatform.magento.push('header:x-magento-*');
      break;
    }
  }

  // ── Salesforce Commerce Cloud (Demandware) ───────────────────────
  if (html) {
    if (/\/on\/demandware\.store\//i.test(html)) {
      byPlatform['salesforce-commerce'].push('body:on/demandware.store');
    }
    if (/demandware\.static/i.test(html)) {
      byPlatform['salesforce-commerce'].push('body:demandware.static');
    }
  }
  if (headerHas(headers, 'set-cookie', (v) => /dwsid/i.test(v)) ||
      (typeof homepageHeaders === 'object' && homepageHeaders &&
        JSON.stringify(homepageHeaders).includes('dwsid'))) {
    // dwsid often only on Set-Cookie; also scan raw map values
    byPlatform['salesforce-commerce'].push('cookie:dwsid');
  } else {
    for (const v of Object.values(headers)) {
      if (typeof v === 'string' && /dwsid/i.test(v)) {
        byPlatform['salesforce-commerce'].push('cookie:dwsid');
        break;
      }
    }
  }

  // ── SPA shell (no product markup) ────────────────────────────────
  // Only when a framework marker is present AND we see no product schema.
  if (html) {
    const spaMarkers = [];
    if (/__NEXT_DATA__/i.test(html)) spaMarkers.push('body:__NEXT_DATA__');
    if (/__NUXT__/i.test(html)) spaMarkers.push('body:__NUXT__');
    if (/__remixContext/i.test(html)) spaMarkers.push('body:__remixContext');
    if (spaMarkers.length) {
      const hasProductMarkup =
        /application\/ld\+json/i.test(html) && /"@type"\s*:\s*"Product"/i.test(html);
      if (!hasProductMarkup) {
        byPlatform.spa.push(...spaMarkers);
      }
    }
  }

  return byPlatform;
}

/**
 * Score confidence from signal count + strong-header rule.
 * high: ≥2 independent signals OR powered-by matched
 * medium: one strong signal
 * low: weak/ambiguous
 * unknown: none
 */
function confidenceFor(platform, signals) {
  if (!platform || platform === 'unknown' || !signals || !signals.length) {
    return 'unknown';
  }
  const hasPoweredBy = signals.includes('header:powered-by');
  if (hasPoweredBy || signals.length >= 2) return 'high';
  // Single strong body/header signal → medium
  const strong = signals.some((s) =>
    s.startsWith('header:') ||
    s === 'body:Shopify.shop' ||
    s === 'body:cdn.shopify.com' ||
    s === 'body:myshopify.com' ||
    s === 'robots:shopify-signature' ||
    s === 'body:woocommerce' ||
    s === 'body:cdn.bigcommerce.com' ||
    s === 'body:Mage.Cookies' ||
    s === 'body:on/demandware.store' ||
    s.startsWith('body:__')
  );
  if (strong || signals.length === 1) return 'medium';
  return 'low';
}

/**
 * fingerprintSite({ homepageHtml, homepageHeaders, robotsText })
 * → { platform, confidence, signals: string[] }
 *
 * Pure. Never throws. Fail-closed to platform:'unknown'.
 */
function fingerprintSite({ homepageHtml = null, homepageHeaders = null, robotsText = null } = {}) {
  try {
    const byPlatform = collectSignals({ homepageHtml, homepageHeaders, robotsText });

    // Pick the platform with the most signals; ties break by priority order
    // (shopify first — it's the only platform that changes behaviour today).
    const priority = [
      'shopify',
      'woocommerce',
      'bigcommerce',
      'magento',
      'salesforce-commerce',
      'spa'
    ];
    let best = 'unknown';
    let bestSignals = [];
    for (const p of priority) {
      const sigs = byPlatform[p] || [];
      if (sigs.length > bestSignals.length) {
        best = p;
        bestSignals = sigs;
      }
    }

    // powered-by Shopify alone is enough even if somehow missed above
    if (best === 'unknown') {
      const headers = normalizeHeaders(homepageHeaders);
      if (headerHas(headers, 'powered-by', (v) => /shopify/i.test(v))) {
        best = 'shopify';
        bestSignals = ['header:powered-by'];
      }
    }

    const confidence = confidenceFor(best, bestSignals);
    return {
      platform: best,
      confidence,
      signals: bestSignals.slice()
    };
  } catch {
    return { platform: 'unknown', confidence: 'unknown', signals: [] };
  }
}

module.exports = {
  fingerprintSite,
  normalizeHeaders,
  PLATFORMS
};
