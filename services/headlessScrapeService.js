// services/headlessScrapeService.js
//
// Last-resort FLAG-GATED headless-browser rung for bot-protected / fully-JS-
// rendered / non-standard storefronts (Cloudflare-challenged, Shopify Hydrogen,
// custom Next.js/Remix/Nuxt) when all HTTP-only rungs fail.
//
// Gate: SHOPIFY_HEADLESS_RENDER=true (default OFF — memory/latency-heavy).
// Reuses puppeteer's bundled Chrome (headless:'new'); NO executablePath.
// Resource-blocking: aborts image/media/font to keep dyno memory down
// (image URLs still come from DOM/hydration JSON, not loaded bytes).
//
// Hydration formats understood:
//   window.__NEXT_DATA__, window.__remixContext, window.__NUXT__,
//   window.__APOLLO_STATE__, Next.js flight self.__next_f.push chunks,
//   JSON-LD Product nodes, same-origin /products.json after real render.
//
// NODE 18+, puppeteer ^24 already installed. No new deps.

const puppeteer = require('puppeteer');
// JSON-LD read via script.textContent keeps its character references
// encoded (a <script> is a raw-text element) — decode human-readable
// fields so `74&quot;` lands as `74"`.
const { cleanScrapedText } = require('../utils/htmlEntities');
const { classifyBlock } = require('./blockClassifier');

// ── constants ──────────────────────────────────────────────────────
const DEFAULT_CAP     = 200;
const DEFAULT_TIMEOUT = 120000;
const NAV_TIMEOUT     = 45000;
const LOG             = '🕷';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Headless-only interstitial phrase historically matched by CF_RE but
// not in the shared CF_BODY_RE — keep it so detectCfChallenge stays
// at least as sensitive as before.
const CF_HEADLESS_EXTRA_RE = /checking your browser/i;

// ── flag gate ──────────────────────────────────────────────────────

function enabled() {
  return String(process.env.SHOPIFY_HEADLESS_RENDER || '').toLowerCase() === 'true';
}

function resolveTimeoutMs() {
  const n = parseInt(process.env.SHOPIFY_HEADLESS_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT;
}

// ── browser lifecycle (lazy singleton) ─────────────────────────────

let _browser = null;
let _browserLaunching = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_browserLaunching) return _browserLaunching;

  _browserLaunching = (async () => {
    console.log(`   · ${LOG}  launching headless Chrome (bundled)`);
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    _browser = browser;
    _browserLaunching = null;
    browser.on('disconnected', () => {
      if (_browser === browser) _browser = null;
    });
    return browser;
  })();

  try {
    return await _browserLaunching;
  } catch (err) {
    _browserLaunching = null;
    throw err;
  }
}

async function closeBrowser() {
  const b = _browser;
  _browser = null;
  _browserLaunching = null;
  if (!b) return;
  try {
    await b.close();
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  closeBrowser: ${err.message}`);
  }
}

// ── simple promise-chain mutex (serialize page work on small dynos) ─

let _mutexTail = Promise.resolve();

function withMutex(fn) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const prev = _mutexTail;
  _mutexTail = prev.then(() => gate, () => gate);
  return prev.then(fn, fn).finally(() => { release(); });
}

// ── origin helper ──────────────────────────────────────────────────

function resolveOrigin(brand) {
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

// ── pure mappers (exported for unit tests — no puppeteer) ──────────

/**
 * mapLdProduct(node) → normalizedProduct | null
 * JSON-LD @type Product → products.json-ish shape.
 */
function mapLdProduct(node) {
  if (!node || typeof node !== 'object') return null;

  const types = Array.isArray(node['@type'])
    ? node['@type'].map(String)
    : node['@type'] != null
      ? [String(node['@type'])]
      : [];
  const isProduct = types.some(t => /product/i.test(t)) ||
    (node.handle && (node.title || node.name));
  if (!isProduct && !node.name && !node.title) return null;

  const title = cleanScrapedText(node.name || node.title);
  const handle = node.handle ||
    (typeof node.url === 'string'
      ? (node.url.match(/\/products\/([^/?#]+)/i) || [])[1] || null
      : null) ||
    (typeof node['@id'] === 'string'
      ? (node['@id'].match(/\/products\/([^/?#]+)/i) || [])[1] || null
      : null);

  // offers may be object, array, or AggregateOffer
  let offers = node.offers;
  if (Array.isArray(offers)) {
    // keep as-is
  } else if (offers && typeof offers === 'object') {
    if (Array.isArray(offers.offers)) offers = offers.offers;
    else offers = [offers];
  } else {
    offers = [];
  }

  const variants = offers.map(o => {
    if (!o || typeof o !== 'object') return null;
    let price = o.price != null ? o.price
      : o.lowPrice != null ? o.lowPrice
      : o.highPrice != null ? o.highPrice
      : null;
    if (price != null) price = String(price);
    else price = '0.00';
    const avail = o.availability != null
      ? !/OutOfStock|Discontinued|SoldOut/i.test(String(o.availability))
      : true;
    return {
      price,
      compare_at_price: o.compare_at_price != null ? String(o.compare_at_price) : null,
      sku: o.sku || node.sku || null,
      barcode: o.gtin || o.gtin13 || o.gtin12 || o.gtin8 || o.mpn || null,
      available: avail
    };
  }).filter(Boolean);

  if (!variants.length && (node.price != null || title)) {
    variants.push({
      price: node.price != null ? String(node.price) : '0.00',
      compare_at_price: null,
      sku: node.sku || null,
      barcode: null,
      available: true
    });
  }

  // image: string | string[] | ImageObject | ImageObject[]
  const images = [];
  const pushImg = (img) => {
    if (!img) return;
    if (typeof img === 'string') {
      images.push({ src: img });
      return;
    }
    if (typeof img === 'object') {
      const src = img.url || img.contentUrl || img.src || null;
      if (src) images.push({ src: String(src) });
    }
  };
  if (Array.isArray(node.image)) node.image.forEach(pushImg);
  else pushImg(node.image);
  if (Array.isArray(node.images)) node.images.forEach(pushImg);

  let vendor = null;
  if (typeof node.brand === 'string') vendor = node.brand;
  else if (node.brand && typeof node.brand === 'object') {
    vendor = node.brand.name || node.brand['@id'] || null;
  }
  if (!vendor && node.vendor) vendor = String(node.vendor);
  vendor = cleanScrapedText(vendor);

  if (!title && !handle) return null;

  return {
    id: node.productID || node.sku || node['@id'] || null,
    handle: handle || null,
    title,
    body_html: node.description || null,
    vendor,
    product_type: node.category
      ? cleanScrapedText(typeof node.category === 'string' ? node.category : node.category.name)
      : null,
    tags: [],
    variants: variants.length ? variants : [{
      price: '0.00',
      compare_at_price: null,
      sku: null,
      barcode: null,
      available: true
    }],
    images: images.filter(i => i.src)
  };
}

/**
 * Looks like a product-shaped node we can normalize.
 * has handle AND (title||name) AND (variants||price||offers)
 */
function isProductLike(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const handle = obj.handle || obj.productHandle || obj.product_handle;
  if (!handle || typeof handle !== 'string') return false;
  const title = obj.title || obj.name;
  if (!title) return false;
  if (obj.variants != null || obj.price != null || obj.offers != null ||
      obj.compare_at_price != null || obj.priceRange != null ||
      obj.price_min != null || obj.amount != null) {
    return true;
  }
  // Shopify-ish: has images + id is often enough when handle+title present
  if (obj.id != null && (obj.images != null || obj.featured_image != null || obj.media != null)) {
    return true;
  }
  return false;
}

/**
 * mapHydrationProduct(node) → normalizedProduct | null
 */
function mapHydrationProduct(node) {
  if (!node || typeof node !== 'object') return null;

  const handle = node.handle || node.productHandle || node.product_handle || null;
  const title = cleanScrapedText(node.title || node.name);
  if (!handle && !title) return null;

  let tags = node.tags;
  if (typeof tags === 'string') {
    tags = tags.split(',').map(t => t.trim()).filter(Boolean);
  } else if (!Array.isArray(tags)) {
    tags = [];
  } else {
    tags = tags.map(t => String(t));
  }

  // variants
  let rawVariants = [];
  if (Array.isArray(node.variants)) {
    rawVariants = node.variants;
  } else if (node.variants && typeof node.variants === 'object') {
    if (Array.isArray(node.variants.nodes)) rawVariants = node.variants.nodes;
    else if (Array.isArray(node.variants.edges)) {
      rawVariants = node.variants.edges.map(e => e?.node).filter(Boolean);
    }
  }

  const moneyStr = (v) => {
    if (v == null) return null;
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      if (v.amount != null) return String(v.amount);
      if (v.price != null) return moneyStr(v.price);
    }
    return null;
  };

  let variants = rawVariants.map(v => {
    if (!v || typeof v !== 'object') return null;
    const price = moneyStr(v.price) ??
      moneyStr(v.priceV2) ??
      moneyStr(v.presentment_prices?.[0]?.price) ??
      '0.00';
    const compare = moneyStr(v.compare_at_price) ??
      moneyStr(v.compareAtPrice) ??
      moneyStr(v.compareAtPriceV2) ??
      null;
    return {
      price,
      compare_at_price: compare,
      sku: v.sku || null,
      barcode: v.barcode || v.barcode || null,
      available: v.available != null ? !!v.available
        : v.availableForSale != null ? !!v.availableForSale
        : v.available_for_sale != null ? !!v.available_for_sale
        : true
    };
  }).filter(Boolean);

  // price at product level / priceRange
  if (!variants.length) {
    let price = moneyStr(node.price);
    if (price == null && node.priceRange) {
      price = moneyStr(node.priceRange.minVariantPrice) ??
        moneyStr(node.priceRange.min_variant_price) ??
        moneyStr(node.priceRange.min) ??
        moneyStr(node.priceRange);
    }
    if (price == null) price = moneyStr(node.price_min) ?? moneyStr(node.amount);
    if (price != null || title) {
      variants.push({
        price: price != null ? price : '0.00',
        compare_at_price: moneyStr(node.compare_at_price) ?? moneyStr(node.compareAtPrice),
        sku: node.sku || null,
        barcode: null,
        available: node.available != null ? !!node.available : true
      });
    }
  }

  // images
  const images = [];
  const pushSrc = (src) => {
    if (!src) return;
    if (typeof src === 'string') images.push({ src });
    else if (typeof src === 'object') {
      const u = src.src || src.url || src.originalSrc || src.original_src || null;
      if (u) images.push({ src: String(u) });
    }
  };
  if (Array.isArray(node.images)) {
    for (const img of node.images) {
      if (img && typeof img === 'object' && Array.isArray(img.edges)) {
        for (const e of img.edges) pushSrc(e?.node);
      } else if (img && typeof img === 'object' && Array.isArray(img.nodes)) {
        for (const n of img.nodes) pushSrc(n);
      } else {
        pushSrc(img);
      }
    }
  } else if (node.images && typeof node.images === 'object') {
    if (Array.isArray(node.images.nodes)) node.images.nodes.forEach(pushSrc);
    else if (Array.isArray(node.images.edges)) {
      node.images.edges.forEach(e => pushSrc(e?.node));
    }
  }
  pushSrc(node.featured_image || node.featuredImage || node.image);

  if (Array.isArray(node.media)) {
    for (const m of node.media) {
      if (!m) continue;
      if (m.preview_image) pushSrc(m.preview_image);
      else if (m.preview?.image) pushSrc(m.preview.image);
      else if (m.media_type === 'image' || m.__typename === 'MediaImage') pushSrc(m);
    }
  }

  return {
    id: node.id != null ? (typeof node.id === 'string' && node.id.includes('/')
      ? (node.id.match(/\/(\d+)\s*$/) || [])[1] || node.id
      : node.id) : null,
    handle: handle || null,
    title,
    body_html: node.body_html || node.descriptionHtml || node.description || null,
    vendor: cleanScrapedText(node.vendor || node.brand)
      || (node.brand && typeof node.brand === 'object' ? cleanScrapedText(node.brand.name) : null),
    product_type: cleanScrapedText(node.product_type || node.productType || node.type),
    tags,
    variants: variants.length ? variants : [{
      price: '0.00',
      compare_at_price: null,
      sku: null,
      barcode: null,
      available: true
    }],
    images: images.filter(i => i && i.src)
  };
}

/**
 * extractHydrationProducts(payloadObj) → normalizedProduct[]
 * Deep-walks nextData / remix / nuxt / apollo and best-effort parses
 * Next.js flight chunks for product-like nodes. Pure — no puppeteer.
 */
function extractHydrationProducts(payloadObj) {
  if (!payloadObj || typeof payloadObj !== 'object') return [];

  const byHandle = new Map();

  const consider = (node) => {
    if (!isProductLike(node)) return;
    const mapped = mapHydrationProduct(node);
    if (!mapped || !mapped.handle) return;
    if (!byHandle.has(mapped.handle)) byHandle.set(mapped.handle, mapped);
  };

  const seen = new Set();
  const walk = (val, depth) => {
    if (val == null || depth > 12) return;
    if (typeof val !== 'object') return;
    if (seen.has(val)) return;
    seen.add(val);

    if (Array.isArray(val)) {
      for (const item of val) walk(item, depth + 1);
      return;
    }

    consider(val);

    for (const k of Object.keys(val)) {
      // skip huge noisy keys
      if (k === 'parent' || k === 'children' || k === 'provider') continue;
      try {
        walk(val[k], depth + 1);
      } catch {
        // ignore
      }
    }
  };

  walk(payloadObj.nextData, 0);
  walk(payloadObj.remix, 0);
  walk(payloadObj.nuxt, 0);
  walk(payloadObj.apollo, 0);

  // Next.js app-router flight chunks: self.__next_f.push([…,"…json…"])
  // Best-effort: pull quoted JSON-looking segments and parse.
  const chunks = payloadObj.nextChunks;
  if (typeof chunks === 'string' && chunks.length) {
    // Try full JSON objects embedded as string literals
    const stringLitRe = /"((?:\\.|[^"\\]){20,})"/g;
    let m;
    const candidates = [];
    while ((m = stringLitRe.exec(chunks)) !== null) {
      let raw = m[1];
      // Unescape common JSON string escapes
      try {
        raw = JSON.parse('"' + raw + '"');
      } catch {
        raw = raw
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      if (typeof raw !== 'string') continue;
      if (!/handle["']?\s*:/.test(raw) && !/"handle"/.test(raw)) continue;
      candidates.push(raw);
    }

    for (const c of candidates) {
      // Direct JSON
      try {
        const parsed = JSON.parse(c);
        walk(parsed, 0);
        continue;
      } catch {
        // fall through
      }
      // Extract {...} slices that look like product objects
      const objRe = /\{[^{}]*"handle"\s*:\s*"[^"]+"[^{}]*\}/g;
      let om;
      while ((om = objRe.exec(c)) !== null) {
        try {
          const parsed = JSON.parse(om[0]);
          consider(parsed);
        } catch {
          // ignore
        }
      }
    }

    // Also walk any JSON.parse of the whole flight push payloads
    const pushRe = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g;
    let pm;
    while ((pm = pushRe.exec(chunks)) !== null) {
      try {
        const arr = JSON.parse(pm[1]);
        walk(arr, 0);
      } catch {
        // flight format is not always pure JSON — ignore
      }
    }
  }

  return Array.from(byHandle.values());
}

// ── page helpers ───────────────────────────────────────────────────

async function setupPage(page) {
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

async function detectCfChallenge(page) {
  try {
    const info = await page.evaluate(() => {
      const title = document.title || '';
      const body = document.body ? (document.body.innerText || '').slice(0, 2000) : '';
      return { title, body };
    });
    const blob = `${info.title}\n${info.body}`;
    // Boolean contract preserved: true when shared CF markers fire (via
    // classifier at status 403) OR the headless-only interstitial phrase.
    const block = classifyBlock({ status: 403, bodyText: blob });
    if (block && block.vendor === 'cloudflare') return true;
    return CF_HEADLESS_EXTRA_RE.test(blob);
  } catch {
    return false;
  }
}

async function gotoWithCf(page, url, errors) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  } catch (err) {
    // tolerate navigation timeout — page may still be usable
    if (!/timeout/i.test(err.message)) {
      errors.push(`goto ${url}: ${err.message}`);
    }
  }

  if (await detectCfChallenge(page)) {
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 });
    } catch {
      // one wait only
    }
    if (await detectCfChallenge(page)) {
      errors.push(`CF challenge still present after wait: ${url}`);
      return false;
    }
  }
  return true;
}

async function extractHydrationPayload(page) {
  return page.evaluate(() => {
    /* eslint-disable no-undef */
    return {
      nextData: (typeof window !== 'undefined' && window.__NEXT_DATA__) || null,
      remix: (typeof window !== 'undefined' && window.__remixContext) || null,
      nuxt: (typeof window !== 'undefined' && window.__NUXT__) || null,
      apollo: (typeof window !== 'undefined' && window.__APOLLO_STATE__) || null,
      nextChunks: Array.from(document.scripts)
        .map(s => s.textContent || '')
        .filter(t => t && t.includes('self.__next_f.push'))
        .join('\n')
    };
    /* eslint-enable no-undef */
  });
}

async function extractJsonLd(page) {
  const texts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(s => s.textContent || '')
      .filter(Boolean);
  });

  const products = [];
  for (const t of texts) {
    let parsed;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    const nodes = [];
    const flatten = (n) => {
      if (!n) return;
      if (Array.isArray(n)) {
        n.forEach(flatten);
        return;
      }
      if (typeof n !== 'object') return;
      nodes.push(n);
      if (Array.isArray(n['@graph'])) flatten(n['@graph']);
    };
    flatten(parsed);

    for (const node of nodes) {
      const types = Array.isArray(node['@type'])
        ? node['@type']
        : node['@type'] != null ? [node['@type']] : [];
      if (!types.some(ty => /product/i.test(String(ty)))) continue;
      const mapped = mapLdProduct(node);
      if (mapped) products.push(mapped);
    }
  }
  return products;
}

async function collectProductHandles(page, origin) {
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/products/"]'))
      .map(a => a.getAttribute('href') || '')
      .filter(Boolean);
  });

  const handles = [];
  const seen = new Set();
  for (const href of hrefs) {
    try {
      const u = new URL(href, origin);
      if (u.origin !== origin) continue;
      const m = u.pathname.match(/\/products\/([^/?#]+)/i);
      if (!m) continue;
      const h = decodeURIComponent(m[1]);
      if (seen.has(h)) continue;
      seen.add(h);
      handles.push(h);
    } catch {
      // ignore bad href
    }
  }
  return handles;
}

function mergeProducts(intoMap, list, cap) {
  let added = 0;
  for (const p of list) {
    if (intoMap.size >= cap) break;
    if (!p || !p.handle) continue;
    if (intoMap.has(p.handle)) continue;
    intoMap.set(p.handle, p);
    added += 1;
  }
  return added;
}

// ── core scrape (one brand, assumes gate already checked) ──────────

async function scrapeBrand(brand, { run, abortCheck, cap, origin }) {
  const collected = new Map();
  const errors = [];
  let mode = null;

  const note = (msg) => {
    console.log(`   · ${LOG}  ${msg}`);
    try { run?.note?.(msg); } catch { /* optional */ }
  };

  try { run?.stage?.('headless render'); } catch { /* optional */ }

  const browser = await getBrowser();
  let page = null;

  try {
    page = await browser.newPage();
    await setupPage(page);

    // ── a. /collections/all + same-origin products.json ───────────
    if (await abortCheck(brand._id, run)) {
      return { ok: false, mode: null, origin, products: [], errors, reason: 'aborted' };
    }

    note(`goto ${origin}/collections/all`);
    await gotoWithCf(page, `${origin}/collections/all`, errors);

    try {
      const json = await page.evaluate(async () => {
        try {
          const r = await fetch('/products.json?limit=250');
          if (!r.ok) return null;
          return await r.json();
        } catch {
          return null;
        }
      });
      if (json && Array.isArray(json.products) && json.products.length) {
        mergeProducts(collected, json.products, cap);
        mode = 'render';
        note(`same-origin products.json → ${json.products.length} (kept=${collected.size})`);
        try { run?.tick?.(collected.size, cap, 'products.json via render'); } catch { /* */ }
      }
    } catch (err) {
      errors.push(`same-origin products.json: ${err.message}`);
    }

    // ── b. hydration on collections page ──────────────────────────
    if (collected.size < cap) {
      try {
        const payload = await extractHydrationPayload(page);
        const fromHydra = extractHydrationProducts(payload);
        if (fromHydra.length) {
          mergeProducts(collected, fromHydra, cap);
          mode = mode || 'render';
          note(`hydration extraction → +${fromHydra.length} (kept=${collected.size})`);
          try { run?.tick?.(collected.size, cap, 'hydration'); } catch { /* */ }
        }
      } catch (err) {
        errors.push(`hydration collections: ${err.message}`);
      }
    }

    // ── c. JSON-LD on collections page ────────────────────────────
    if (collected.size < cap) {
      try {
        const ld = await extractJsonLd(page);
        if (ld.length) {
          mergeProducts(collected, ld, cap);
          mode = mode || 'render';
          note(`json-ld → +${ld.length} (kept=${collected.size})`);
          try { run?.tick?.(collected.size, cap, 'json-ld'); } catch { /* */ }
        }
      } catch (err) {
        errors.push(`json-ld collections: ${err.message}`);
      }
    }

    // ── d. product-link discovery → per-product pages ─────────────
    if (collected.size < cap) {
      if (await abortCheck(brand._id, run)) {
        const products = Array.from(collected.values()).slice(0, cap);
        return {
          ok: products.length > 0,
          mode: products.length ? (mode || 'render') : null,
          origin,
          products,
          errors,
          reason: products.length ? undefined : 'aborted'
        };
      }

      let handles = [];
      try {
        handles = await collectProductHandles(page, origin);
        note(`discovered ${handles.length} product handles from links`);
      } catch (err) {
        errors.push(`product-link discovery: ${err.message}`);
      }

      // skip handles we already have
      handles = handles.filter(h => !collected.has(h));
      const budget = Math.max(0, cap - collected.size);
      const targets = handles.slice(0, budget);

      for (const handle of targets) {
        if (collected.size >= cap) break;
        if (await abortCheck(brand._id, run)) break;

        const pUrl = `${origin}/products/${encodeURIComponent(handle)}`;
        try {
          await gotoWithCf(page, pUrl, errors);

          // hydration
          try {
            const payload = await extractHydrationPayload(page);
            const fromHydra = extractHydrationProducts(payload);
            mergeProducts(collected, fromHydra, cap);
          } catch (err) {
            errors.push(`hydration ${handle}: ${err.message}`);
          }

          // json-ld
          if (!collected.has(handle) && collected.size < cap) {
            try {
              const ld = await extractJsonLd(page);
              mergeProducts(collected, ld, cap);
            } catch (err) {
              errors.push(`json-ld ${handle}: ${err.message}`);
            }
          }

          // if still missing this handle, synthesize a stub from the URL only
          // when the page at least exposed a title via hydration/ld under another key —
          // otherwise leave it; never invent prices.

          mode = mode || (collected.size ? 'render' : mode);
          try { run?.tick?.(collected.size, cap, handle); } catch { /* */ }
        } catch (err) {
          errors.push(`product page ${handle}: ${err.message}`);
          // one bad product never aborts the whole scrape
        }
      }
    }
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  const products = Array.from(collected.values()).slice(0, cap);
  if (!products.length) {
    return {
      ok: false,
      mode: null,
      origin,
      products: [],
      errors,
      reason: errors.length
        ? `headless render yielded 0 products (${errors[0]})`
        : 'headless render yielded 0 products'
    };
  }

  console.log(`${LOG}  syncViaHeadless: mode=render origin=${origin} n=${products.length}`);
  return {
    ok: true,
    mode: mode || 'render',
    origin,
    products,
    errors
  };
}

// ── main export ────────────────────────────────────────────────────

/**
 * syncViaHeadless(brand, { run, abortCheck, cap })
 *
 * Flag-gated headless fallback. Returns the same shape as the access
 * resolver so the ingester loop is reused unchanged.
 *
 * @returns {{
 *   ok: boolean,
 *   mode: 'render'|null,
 *   origin: string,
 *   products: object[],
 *   errors: string[],
 *   reason?: string
 * }}
 */
async function syncViaHeadless(brand, { run = null, abortCheck = async () => false, cap = DEFAULT_CAP } = {}) {
  if (!enabled()) {
    return {
      ok: false,
      mode: null,
      products: [],
      errors: [],
      reason: 'headless render disabled (set SHOPIFY_HEADLESS_RENDER=true)'
    };
  }

  const origin = resolveOrigin(brand);
  if (!origin) {
    return {
      ok: false,
      mode: null,
      origin: '',
      products: [],
      errors: [],
      reason: 'no store url'
    };
  }

  const CAP = Math.max(1, parseInt(cap, 10) || DEFAULT_CAP);
  const timeoutMs = resolveTimeoutMs();

  const wrappedAbort = async () => {
    try {
      return !!(await abortCheck(brand?._id, run));
    } catch {
      return false;
    }
  };

  return withMutex(async () => {
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          mode: null,
          origin,
          products: [],
          errors: [`headless timeout after ${timeoutMs}ms`],
          reason: `headless timeout after ${timeoutMs}ms`
        });
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        scrapeBrand(brand, { run, abortCheck: wrappedAbort, cap: CAP, origin }),
        timeoutPromise
      ]);
      return result;
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  syncViaHeadless error: ${err.message}`);
      return {
        ok: false,
        mode: null,
        origin,
        products: [],
        errors: [err.message],
        reason: err.message
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

module.exports = {
  syncViaHeadless,
  getBrowser,
  closeBrowser,
  // pure helpers for unit tests
  extractHydrationProducts,
  mapLdProduct
};
