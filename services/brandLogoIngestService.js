'use strict';

// Finds the storefront's actual brand mark, validates it as an image, and
// mirrors the winner to Cloudinary during brand ingest. Rendering consumes
// the stable mirror rather than hotlinking a theme/CDN asset that may change.

const axios = require('axios');
const sharp = require('sharp');
const cloudinaryService = require('./cloudinaryService');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 24;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/gi, '/')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/');
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag).match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i')
  );
  return decodeHtml(match?.[1] || match?.[2] || '');
}

function absoluteUrl(value, baseUrl) {
  if (!value || /^data:/i.test(value)) return null;
  try {
    const url = new URL(decodeHtml(value), baseUrl);
    return /^https?:$/i.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function bestImageUrl(tag) {
  for (const key of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
    const value = attribute(tag, key);
    if (value && !/^data:/i.test(value)) return value;
  }
  for (const key of ['srcset', 'data-srcset']) {
    const value = attribute(tag, key);
    if (!value) continue;
    const picks = value.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
    if (picks.length) return picks[picks.length - 1];
  }
  return null;
}

function jsonLdLogoUrls(html) {
  const out = [];
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (types.some((type) => /^(organization|brand|corporation|localbusiness)$/i.test(String(type || '')))) {
        const logo = node.logo;
        if (typeof logo === 'string') out.push(logo);
        else if (logo && typeof logo === 'object') {
          if (logo.url) out.push(logo.url);
          if (logo.contentUrl) out.push(logo.contentUrl);
        }
      }
      if (Array.isArray(node['@graph'])) walk(node['@graph']);
    };
    walk(parsed);
  }
  return out;
}

function collectStaticCandidates(html, baseUrl, brandName) {
  const candidates = [];
  const seen = new Set();
  const add = (value, source, score) => {
    const url = absoluteUrl(value, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, source, score });
  };

  for (const url of jsonLdLogoUrls(html)) add(url, 'json-ld-logo', 100);

  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const key = `${attribute(tag, 'property')} ${attribute(tag, 'name')} ${attribute(tag, 'itemprop')}`;
    if (/\b(?:og:logo|logo)\b/i.test(key)) add(attribute(tag, 'content'), 'logo-meta', 96);
  }

  let manifestUrl = null;
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const rel = attribute(tag, 'rel').toLowerCase();
    const href = attribute(tag, 'href');
    if (rel.includes('manifest')) manifestUrl = absoluteUrl(href, baseUrl);
    if (rel.includes('apple-touch-icon')) add(href, 'apple-touch-icon', 58);
    else if (rel.includes('mask-icon')) add(href, 'mask-icon', 54);
    else if (/(^|\s)icon(\s|$)/.test(rel)) add(href, 'site-icon', 42);
  }

  const brandKey = String(brandName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const tag of String(html || '').match(/<(?:img|source)\b[^>]*>/gi) || []) {
    const url = bestImageUrl(tag);
    if (!url) continue;
    const altKey = attribute(tag, 'alt').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const clues = [
      attribute(tag, 'alt'), attribute(tag, 'aria-label'), attribute(tag, 'class'),
      attribute(tag, 'id'), attribute(tag, 'itemprop'), url
    ].join(' ').toLowerCase();
    const hasLogoCue = /\b(?:logo|wordmark|brandmark|site-mark|site-logo)\b/i.test(clues) ||
      /(?:logo|wordmark|brandmark)/i.test(url);
    // An alt that is exactly the brand name is a common wordmark pattern.
    // Merely containing the brand name is not enough: product/nav photos
    // routinely have alt="Brand Product Name" and are not logos.
    const hasBrandCue = brandKey.length >= 3 && altKey === brandKey;
    if (hasLogoCue || hasBrandCue) add(url, hasLogoCue ? 'logo-image' : 'brand-image', hasLogoCue ? 92 : 76);
  }

  // Next/Hydrogen hydration payloads commonly contain the real theme asset
  // even when no usable <img> exists in the server-rendered shell.
  const escapedAssetRe = /(?:https?:)?(?:\\?\/\\?\/|\/)[^"'<>\\\s]{0,260}(?:logo|wordmark|brandmark)[^"'<>\\\s]{0,180}\.(?:svg|png|webp|jpe?g)(?:\?[^"'<>\\\s]*)?/gi;
  for (const match of String(html || '').match(escapedAssetRe) || []) {
    add(match, 'hydration-logo-asset', 80);
  }

  return { candidates, manifestUrl };
}

async function collectManifestCandidates(manifestUrl, baseUrl) {
  if (!manifestUrl) return [];
  try {
    const response = await axios.get(manifestUrl, {
      timeout: 10_000,
      maxContentLength: 512 * 1024,
      headers: { 'User-Agent': UA, Accept: 'application/manifest+json,application/json' }
    });
    const manifest = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return (manifest?.icons || []).map((icon) => ({
      url: absoluteUrl(icon.src, manifestUrl || baseUrl),
      source: 'web-manifest-icon',
      score: 50 + Math.min(8, parseInt(String(icon.sizes || '').match(/\d+/)?.[0] || '0', 10) / 64)
    })).filter((item) => item.url);
  } catch {
    return [];
  }
}

async function collectRenderedCandidates(websiteUrl) {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(websiteUrl, { waitUntil: 'networkidle2', timeout: 25_000 }).catch(() => {});
    const selectors = [
      '[itemprop="logo"]', 'header img', 'nav img', '[class*="logo" i] img',
      'img[class*="logo" i]', 'img[id*="logo" i]', 'a[aria-label*="home" i] img',
      'header svg[class*="logo" i]', 'header [class*="logo" i] svg',
      'header a[aria-label*="home" i] svg', '[role="banner"] a[href="/"] svg'
    ];
    const handles = await page.$$(selectors.join(','));
    const out = [];
    for (const handle of handles.slice(0, 12)) {
      const info = await handle.evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        url: el.currentSrc || el.src || el.getAttribute('content') || el.getAttribute('href') || null,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height
      })).catch(() => null);
      if (!info || info.width < 12 || info.height < 12) continue;
      if (info.url) {
        const url = absoluteUrl(info.url, page.url());
        if (url) out.push({ url, source: 'rendered-header-logo', score: 98 });
      } else if (info.tag === 'svg') {
        const screenshot = await handle.screenshot({ omitBackground: true, type: 'png' }).catch(() => null);
        if (screenshot?.length > 256) {
          out.push({ buffer: Buffer.from(screenshot), source: 'rendered-inline-svg-logo', score: 97 });
        }
      }
    }
    return out;
  } catch (err) {
    console.warn(`   ⚠️  rendered logo discovery failed: ${err.message}`);
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function fetchAndValidate(candidate) {
  try {
    let buffer = candidate.buffer;
    if (!buffer) {
      const response = await axios.get(candidate.url, {
        responseType: 'arraybuffer',
        timeout: 15_000,
        maxRedirects: 5,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.5' }
      });
      buffer = Buffer.from(response.data);
    }
    // Highly optimized SVG marks can legitimately be only ~100 bytes;
    // Sharp metadata validation below is the stronger authenticity check.
    if (!buffer || buffer.length < 64 || buffer.length > MAX_IMAGE_BYTES) return null;
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if ((width && width < 24) || (height && height < 24)) return null;
    if (!metadata.format) return null;
    const ratio = width && height ? width / height : 1;
    const dimensionBonus = width >= 160 || height >= 160 ? 5 : 0;
    const wordmarkBonus = ratio >= 1.35 && ratio <= 10 ? 10 : 0;
    return {
      ...candidate,
      buffer,
      width,
      height,
      format: metadata.format,
      finalScore: candidate.score + dimensionBonus + wordmarkBonus
    };
  } catch {
    return null;
  }
}

function logoSlug(brand) {
  const id = String(brand?._id || brand?.id || brand?.name || 'brand');
  return `${id.replace(/[^a-z0-9_-]+/gi, '-')}-website-logo`;
}

async function discoverAndIngestBrandLogo(brand, { html = null, pageUrl = null } = {}) {
  if (!brand?.websiteUrl) throw new Error('brand logo ingest: brand has no websiteUrl');
  let sourceHtml = html;
  let resolvedPageUrl = pageUrl || brand.websiteUrl;
  if (!sourceHtml) {
    try {
      const response = await axios.get(brand.websiteUrl, {
        timeout: 20_000,
        maxRedirects: 5,
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
      });
      sourceHtml = typeof response.data === 'string' ? response.data : String(response.data || '');
      resolvedPageUrl = response.request?.res?.responseUrl || brand.websiteUrl;
    } catch {
      // A browser-rendered storefront may still work when the origin rejects
      // the lightweight HTTP client. Continue into rendered discovery.
      sourceHtml = '';
    }
  }

  const staticallyFound = collectStaticCandidates(sourceHtml, resolvedPageUrl, brand.name);
  const manifest = await collectManifestCandidates(staticallyFound.manifestUrl, resolvedPageUrl);
  let candidates = [...staticallyFound.candidates, ...manifest];
  const highConfidenceStatic = candidates.filter((candidate) => candidate.score >= 90).slice(0, 6);
  const validatedStatic = (await Promise.all(highConfidenceStatic.map(fetchAndValidate))).filter(Boolean);
  const hasStaticWordmark = validatedStatic.some((candidate) =>
    candidate.width && candidate.height && candidate.width / candidate.height >= 1.35
  );
  if (!validatedStatic.length || !hasStaticWordmark) {
    candidates.push(...await collectRenderedCandidates(brand.websiteUrl));
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const key = candidate.url || `${candidate.source}:${candidate.buffer?.length || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= MAX_CANDIDATES) break;
  }
  const validated = (await Promise.all(unique.map(fetchAndValidate))).filter(Boolean);
  validated.sort((a, b) => b.finalScore - a.finalScore);
  const winner = validated[0];
  if (!winner) {
    return { logoUrl: null, source: null, originalUrl: null, candidatesChecked: unique.length };
  }

  const uploaded = await cloudinaryService.uploadBufferToCloudinary(winner.buffer, {
    folder: 'liquidretail/brand_logos',
    publicId: logoSlug(brand),
    overwrite: true,
    resourceType: 'image'
  });
  return {
    logoUrl: uploaded.secure_url,
    source: winner.source,
    originalUrl: winner.url || null,
    width: winner.width || uploaded.width || null,
    height: winner.height || uploaded.height || null,
    format: winner.format || uploaded.format || null,
    candidatesChecked: unique.length
  };
}

module.exports = {
  discoverAndIngestBrandLogo,
  collectStaticCandidates,
  collectRenderedCandidates,
  jsonLdLogoUrls,
  fetchAndValidate
};
