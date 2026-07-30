// Extracts public Tailwind theme tokens without evaluating third-party JS.
// A storefront normally does not expose tailwind.config.js, so this accepts
// only concrete semantic tokens from an inline CDN config or generated CSS.

'use strict';

const axios = require('axios');

const MAX_STYLESHEETS = 2;
const MAX_CSS_BYTES = 512 * 1024;
const UA = 'Mozilla/5.0 (compatible; LiquidRetailBot/1.0)';

function normalizeColor(value) {
  const v = String(value || '').trim();
  const hex = v.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i)?.[0];
  if (hex) {
    if (hex.length === 4) return `#${hex.slice(1).split('').map(c => c + c).join('').toUpperCase()}`;
    return hex.toUpperCase();
  }
  const rgb = v.match(/rgba?\(\s*(\d{1,3})\s*[ ,]\s*(\d{1,3})\s*[ ,]\s*(\d{1,3})/i);
  if (!rgb) return null;
  const channels = rgb.slice(1).map(Number);
  if (channels.some(n => n > 255)) return null;
  return `#${channels.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function semanticRole(name) {
  const key = String(name || '').toLowerCase().replace(/_/g, '-');
  if (/(^|-)primary$|brand-primary|color-brand$/.test(key)) return 'primary';
  if (/(^|-)secondary$|brand-secondary/.test(key)) return 'secondary';
  if (/(^|-)accent$|cta|highlight|brand-accent/.test(key)) return 'accent';
  if (/(^|-)foreground$|text|text-primary|ink/.test(key)) return 'font';
  if (/(^|-)background$|surface|canvas|page-bg/.test(key)) return 'background';
  return null;
}

function extractTokens(css) {
  const colors = {};
  const fonts = {};
  const raw = {};
  const variables = String(css || '').matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}]+)[;}]/g);
  for (const [, name, value] of variables) {
    const normalizedName = name.replace(/_/g, '-');
    const role = semanticRole(normalizedName.replace(/^color-/, ''));
    const color = normalizeColor(value);
    if (role && color && !colors[role]) colors[role] = color;
    if (/^(?:font|font-family)-/i.test(normalizedName)) {
      const fontRole = /heading|display|serif/i.test(normalizedName) ? 'heading' : 'body';
      const family = String(value).trim().split(',')[0].replace(/["']/g, '').trim();
      if (/^[A-Za-z][A-Za-z0-9 -]{0,80}$/.test(family) && !fonts[fontRole]) fonts[fontRole] = family;
    }
    if ((role && color) || (/^(?:font|font-family)-/i.test(normalizedName) && fonts.body)) raw[`--${name}`] = String(value).trim().slice(0, 160);
  }
  return { colors, fonts, raw };
}

function extractInlineConfig(html) {
  const hasCdn = /(?:cdn\.tailwindcss\.com|tailwindcss\.com)/i.test(html);
  const configMatch = String(html || '').match(/(?:window\.)?tailwind\.config\s*=\s*([\s\S]{0,20000})/i);
  if (!hasCdn || !configMatch) return null;
  // No eval: only harvest explicit scalar properties from the published
  // config literal. This intentionally ignores expressions/functions.
  const literal = configMatch[1];
  const colors = {};
  for (const match of literal.matchAll(/(?:["']?)(primary|secondary|accent|brand|foreground|text|background|surface)(?:["']?)\s*:\s*["']([^"']+)["']/gi)) {
    const role = semanticRole(match[1]);
    const color = normalizeColor(match[2]);
    if (role && color && !colors[role]) colors[role] = color;
  }
  const fonts = {};
  for (const match of literal.matchAll(/fontFamily\s*:\s*\{([\s\S]{0,3000})\}/gi)) {
    const block = match[1];
    for (const fm of block.matchAll(/(?:sans|body|heading|display|serif)\s*:\s*\[?\s*["']([^"']+)["']/gi)) {
      const role = /heading|display|serif/i.test(fm[0]) ? 'heading' : 'body';
      if (!fonts[role]) fonts[role] = fm[1];
    }
  }
  return Object.keys(colors).length || Object.keys(fonts).length
    ? { source: 'inline-config', confidence: 'high', colors, fonts, raw: {} }
    : null;
}

function utilityEvidence(html) {
  const classes = [...String(html || '').matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)]
    .flatMap(m => m[1].split(/\s+/));
  const utilities = classes.filter(c => /^(?:bg|text|font|rounded|px|py|p[trblxy]?|m[trblxy]?|flex|grid|gap|w|h|items|justify)-/i.test(c));
  return new Set(utilities).size >= 6;
}

function stylesheetUrls(html, pageUrl) {
  const urls = [];
  for (const m of String(html || '').matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(m[1], pageUrl);
      const page = new URL(pageUrl);
      const sameOrigin = url.origin === page.origin;
      const shopifyCdn = /(^|\.)cdn\.shopify\.com$/i.test(url.hostname);
      if ((sameOrigin || shopifyCdn) && !urls.includes(url.toString())) urls.push(url.toString());
    } catch (_) { /* malformed link */ }
    if (urls.length >= MAX_STYLESHEETS) break;
  }
  return urls;
}

async function fetchCss(url) {
  const res = await axios.get(url, {
    timeout: 8000,
    maxContentLength: MAX_CSS_BYTES,
    maxRedirects: 2,
    responseType: 'text',
    headers: { 'User-Agent': UA, Accept: 'text/css' },
    validateStatus: s => s >= 200 && s < 300
  });
  return String(res.data || '');
}

async function inspectTailwindTheme({ html, pageUrl, fetchStylesheet = fetchCss }) {
  const inline = extractInlineConfig(html);
  if (inline) return { detected: true, detectedAt: new Date(), sourceUrls: [], ...inline };

  const inlineCss = [...String(html || '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
  const likelyTailwind = /--tw-|@theme\b|@layer\s+utilities/i.test(inlineCss.join('\n')) || utilityEvidence(html) || /tailwind/i.test(html);
  if (!likelyTailwind) return null;

  const urls = stylesheetUrls(html, pageUrl);
  const fetched = await Promise.all(urls.map(async (url) => {
    try { return { url, css: await fetchStylesheet(url) }; }
    catch (err) { console.warn(`   ⚠️  tailwind ingest stylesheet failed (${url}): ${err.message}`); return null; }
  }));
  const css = [...inlineCss, ...fetched.filter(Boolean).map(x => x.css)].join('\n');
  const hasGeneratedMarker = /--tw-|@theme\b|@layer\s+utilities|--color-/i.test(css);
  const tokens = extractTokens(css);
  if (!hasGeneratedMarker || (!Object.keys(tokens.colors).length && !Object.keys(tokens.fonts).length)) return null;
  return {
    detected: true,
    detectedAt: new Date(),
    source: 'compiled-css',
    confidence: 'high',
    sourceUrls: fetched.filter(Boolean).map(x => x.url),
    ...tokens
  };
}

module.exports = { inspectTailwindTheme, extractTokens, extractInlineConfig, utilityEvidence, stylesheetUrls, normalizeColor };
