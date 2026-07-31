// Resolves the actual font FILES the Remotion titling engine renders with.
//
// Resolution order per role (heading/body/quote):
//   1. explicit Brand.styleTheme.<role>FontFamily override
//   2. Brand.customFonts — font files ingested from the brand's own website
//      (brandFontIngestService), mirrored on Cloudinary
//   3. Brand.fontFamily (the enrichment scan's family) — fetched live from
//      Google Fonts if it exists there
//   4. curated defaults (Playfair Display / Inter / Lora)
// Every fallthrough below step 1 is logged so "brand rendered with default
// fonts" is visible in ops instead of silently shipping off-brand — the
// exact failure mode the 16-bundled-TTF canvas engine had.
//
// Fonts are downloaded once into FONT_CACHE_DIR and referenced by LOCAL
// path; remotionRenderService serves them to the render browser over its
// localhost asset server, so renders work without external egress.

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const axios = require('axios');

const FONT_CACHE_DIR = path.join(__dirname, 'brandScripts', 'assets', 'webfonts');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const DEFAULT_ROLE_FONTS = {
  heading: { family: 'Playfair Display', weight: 700, fallback: 'serif' },
  body: { family: 'Inter', weight: 500, fallback: 'sans-serif' },
  quote: { family: 'Lora', weight: 400, fallback: 'serif' },
};

// Families we treat as serif for CSS fallback purposes (heuristic; anything
// else falls back to sans-serif).
const SERIF_HINTS = /serif|playfair|lora|cormorant|garamond|fraunces|caslon|bodoni|didot|georgia|times|libre|crimson|merriweather|spectral|eb garamond|prata|domine/i;

const memoryCache = new Map(); // family|weight -> resolved entry or null
const inFlight = new Map();    // key -> Promise; prevents same-font download races
const CACHE_VER = 'v2'; // v2: latin-subset selection (v1 files may be cyrillic-only)

function slugify(family, weight, ext) {
  return `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${weight}.${ext}`;
}

function fallbackFor(family) {
  return SERIF_HINTS.test(family) ? 'serif' : 'sans-serif';
}

async function ensureCacheDir() {
  await fsp.mkdir(FONT_CACHE_DIR, { recursive: true });
}

async function downloadTo(url, filePath, { headers = {} } = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { 'User-Agent': UA, ...headers },
    maxRedirects: 5,
  });
  const buf = Buffer.from(res.data);
  if (buf.length < 1024) throw new Error(`suspiciously small font payload (${buf.length}B) from ${url}`);
  // temp + rename: a partially-written file must never satisfy the
  // size-based cache check on the next run.
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, filePath);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
  return filePath;
}

function dedupeRequest(key, work) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve().then(work).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'inherit', 'initial', 'unset'
]);

function normalizeFontFamily(value) {
  for (const part of String(value || '').split(',')) {
    const family = part.trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (family && !GENERIC_FAMILIES.has(family.toLowerCase())) return family;
  }
  return null;
}

function familyKey(value) {
  return String(normalizeFontFamily(value) || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Pick the LATIN @font-face block out of a css2 response. Google emits one
 * block per unicode subset with latin LAST — taking the first woff2 match
 * yields a cyrillic-subset file with zero Latin glyphs (all titles would
 * silently render in the browser's generic fallback).
 * Returns { url, weight|null } or throws.
 */
function pickLatinFace(cssText) {
  const faces = String(cssText).match(/@font-face\s*\{[^}]*\}/g) || [];
  let fallback = null;
  for (const face of faces) {
    const url = face.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)?.[1];
    if (!url) continue;
    const weight = Number(face.match(/font-weight:\s*(\d{3})/)?.[1]) || null;
    const entry = { url, weight };
    fallback = entry; // latin is last — keep overwriting
    // Basic-latin range: U+0000-00FF (the /* latin */ subset always carries it).
    if (/unicode-range:[^;]*U\+0000-00FF/i.test(face)) return entry;
  }
  if (fallback) return fallback;
  throw new Error('no woff2 src found in css2 response');
}

/**
 * Try to fetch `family` from Google Fonts. Returns
 * { family, weight, localPath, fallback, source: 'google' } or null when the
 * family isn't served by Google Fonts.
 */
async function resolveGoogleFamily(family, weight = 400) {
  family = normalizeFontFamily(family);
  if (!family) return null;
  const cacheKey = `google|${family}|${weight}`;
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
  return dedupeRequest(cacheKey, async () => {
  // Inside the failure boundary below via first use — an unwritable cache
  // dir must degrade to the default-font path, never throw upward.

  const fetchCss2 = async (withWeight) => {
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    const cssUrl = `https://fonts.googleapis.com/css2?family=${fam}${withWeight ? `:wght@${weight}` : ''}&display=swap`;
    const css = await axios.get(cssUrl, { timeout: 15_000, headers: { 'User-Agent': UA } });
    return pickLatinFace(css.data);
  };

  try {
    await ensureCacheDir();
    let face;
    let effectiveWeight = weight;
    try {
      face = await fetchCss2(true);
    } catch (e) {
      const missingWeight = e.response?.status === 400 || e.response?.status === 404;
      if (!missingWeight) throw e;
      // Family may not carry the requested weight (display faces often ship
      // 400 only) — take the default cut and let the browser synthesize.
      face = await fetchCss2(false);
      effectiveWeight = face.weight || 400;
    }
    // CACHE_VER busts pre-latin-fix cache files (they hold non-Latin subsets).
    const woff2Path = path.join(FONT_CACHE_DIR, slugify(family, effectiveWeight, `${CACHE_VER}.woff2`));
    const stat = await fsp.stat(woff2Path).catch(() => null);
    if (!stat || stat.size < 1024) await downloadTo(face.url, woff2Path);
    // remoteUrl: browser-loadable origin (gstatic serves CORS *) — the
    // frontend @remotion/player preview loads fonts from here directly.
    const entry = {
      family, weight: effectiveWeight, localPath: woff2Path, remoteUrl: face.url,
      fallback: fallbackFor(family), source: 'google', exact: true,
      requestedFamily: family, resolvedFamily: family
    };
    memoryCache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    const notFound = e.response?.status === 400 || e.response?.status === 404;
    if (notFound) {
      // Definitive: not a Google family. Transient failures are NOT cached
      // so the next render can retry instead of silently defaulting forever.
      memoryCache.set(cacheKey, null);
    } else {
      console.warn(`🔤 fontResolver: google fetch failed for '${family}' (${e.message})`);
    }
    return null;
  }
  });
}

/**
 * Find an ingested website font on the brand matching `family`
 * (case/space-insensitive), preferring the requested weight. The style
 * must match so a roman request never silently renders with an italic face.
 */
function matchCustomFont(brand, family, { weight = 400, style = 'normal' } = {}) {
  const list = Array.isArray(brand?.customFonts) ? brand.customFonts : [];
  const want = familyKey(family);
  if (!want) return null;
  const usable = list.filter((f) =>
    f && f.url && f.license !== 'commercial' && !f.needsLicense &&
    familyKey(f.family) === want &&
    (f.style || 'normal') === style
  );
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const distance = (font) => {
      if (Number.isFinite(font.weightMin) && Number.isFinite(font.weightMax) &&
          weight >= font.weightMin && weight <= font.weightMax) return 0;
      return Math.abs((font.weight || 400) - weight);
    };
    return distance(a) - distance(b);
  });
  return usable[0];
}

async function resolveCustomFont(brand, custom, requestedWeight = custom.weight || 400) {
  const variableWeight = Number.isFinite(custom.weightMin) && Number.isFinite(custom.weightMax) &&
    requestedWeight >= custom.weightMin && requestedWeight <= custom.weightMax;
  const effectiveWeight = variableWeight ? requestedWeight : (custom.weight || 400);
  const cacheKey = `custom|${custom.url}|${effectiveWeight}|${custom.style || 'normal'}`;
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
  return dedupeRequest(cacheKey, async () => {
  const ext = custom.format === 'ttf' || custom.format === 'otf' ? custom.format : 'woff2';
  const localPath = path.join(FONT_CACHE_DIR, slugify(`${brand._id || 'brand'}-${custom.family}`, effectiveWeight, ext));
  try {
    await ensureCacheDir();
    const stat = await fsp.stat(localPath).catch(() => null);
    if (!stat || stat.size < 1024) await downloadTo(custom.url, localPath);
    const entry = {
      family: custom.family,
      weight: effectiveWeight,
      style: custom.style || 'normal',
      localPath,
      remoteUrl: custom.url, // Cloudinary raw mirror — browser-loadable
      fallback: fallbackFor(custom.family),
      source: 'custom',
      exact: true,
      requestedFamily: custom.family,
      resolvedFamily: custom.family,
    };
    memoryCache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    console.warn(`🔤 fontResolver: custom font download failed for '${custom.family}' (${e.message})`);
    // Cache the miss only when the mirror URL is definitively gone —
    // transient failures must stay retryable.
    const gone = e.response?.status === 404 || e.response?.status === 400;
    if (gone) memoryCache.set(cacheKey, null);
    return null;
  }
  });
}

// Common proprietary families mapped to the nearest face in the bundled,
// redistributable Google-font library. This tier is reached only after an
// exact customer-website face and an exact Google Fonts lookup both fail.
const LIBRARY_SUBSTITUTIONS = [
  { pattern: /helvetica|arial|univers|frutiger|neue haas/i, family: 'Inter', reason: 'neutral grotesk sans' },
  { pattern: /gotham|proxima|futura|century gothic|brandon/i, family: 'Montserrat', reason: 'geometric sans' },
  { pattern: /avenir|circular|museo sans|sofia pro/i, family: 'DM Sans', reason: 'modern humanist sans' },
  { pattern: /din|trade gothic|franklin gothic|league gothic/i, family: 'Oswald', reason: 'condensed industrial sans' },
  { pattern: /impact|haettenschweiler/i, family: 'Anton', reason: 'heavy display sans' },
  { pattern: /bodoni|didot|walbaum/i, family: 'Playfair Display', reason: 'high-contrast editorial serif' },
  { pattern: /garamond|caslon|baskerville|minion|adobe jenson/i, family: 'Cormorant Garamond', reason: 'old-style editorial serif' },
  { pattern: /script|brush|handwriting|calligraphy/i, family: 'Great Vibes', reason: 'formal script' }
];

let libraryReadyPromise = null;
async function resolveLibraryMatch(requestedFamily, weight = 400) {
  const requested = normalizeFontFamily(requestedFamily);
  if (!requested) return null;
  const substitution = LIBRARY_SUBSTITUTIONS.find((item) => item.pattern.test(requested));
  const matchedFamily = substitution?.family || (fallbackFor(requested) === 'serif' ? 'Lora' : 'Inter');
  const { ensureFontsLoaded, FONTS, FONTS_DIR } = require('./fontLoader');
  if (!libraryReadyPromise) libraryReadyPromise = ensureFontsLoaded();
  await libraryReadyPromise;
  const key = familyKey(matchedFamily);
  const font = FONTS.find((item) =>
    familyKey(item.family) === key ||
    (item.aliases || []).some((alias) => familyKey(alias) === key)
  );
  if (!font) return null;
  const localPath = path.join(FONTS_DIR, font.file);
  const stat = await fsp.stat(localPath).catch(() => null);
  if (!stat || stat.size < 1024) return null;
  return {
    family: font.family,
    weight,
    style: 'normal',
    localPath,
    remoteUrl: null,
    fallback: fallbackFor(font.family),
    source: 'library-match',
    exact: false,
    requestedFamily: requested,
    resolvedFamily: font.family,
    matchReason: substitution?.reason || `${fallbackFor(requested)} fallback`
  };
}

/**
 * Resolve one family through the full ladder. Returns
 * { family, weight, style, localPath|null, fallback, source } — localPath
 * null means "let the browser fall back" (family kept for CSS stacks).
 */
async function resolveFamily(family, { brand = null, weight = 400 } = {}) {
  family = normalizeFontFamily(family);
  if (!family) return null;

  const custom = matchCustomFont(brand, family, { weight });
  if (custom) {
    const entry = await resolveCustomFont(brand, custom, weight);
    if (entry) return entry;
  }

  const google = await resolveGoogleFamily(family, weight);
  if (google) return google;

  const library = await resolveLibraryMatch(family, weight);
  if (library) {
    console.warn(
      `🔤 fontResolver: '${family}' unavailable — using closest library face ` +
      `'${library.family}' (${library.matchReason}) for brand ${brand?.name || '?'}`
    );
    return library;
  }

  console.warn(`🔤 fontResolver: '${family}' unavailable and library match failed for brand ${brand?.name || '?'}`);
  return null;
}

/**
 * Resolve the three role fonts for a brand.
 * `overrides` comes from spec.tokenOverrides.fonts ({ heading: {family, weight}, ... }).
 * Returns { heading, body, quote } each { family, weight, style, url|null, fallback, source }.
 * `url` is a LOCAL FILE PATH here; remotionRenderService swaps it for an
 * asset-server URL before it reaches the browser.
 */
async function resolveBrandFonts(brand, { overrides = {}, layoutInputBrand = null } = {}) {
  const styleThemeIsCurated = Array.isArray(brand?.curatedFields) && brand.curatedFields.includes('styleTheme');
  const theme = styleThemeIsCurated ? (brand?.styleTheme || {}) : {};
  const tailwind = brand?.tailwindTheme || {};
  const websiteUsage = brand?.websiteFontUsage || {};
  const scanned = brand?.fontFamily || layoutInputBrand?.font_family || null;
  const fontIsCurated = Array.isArray(brand?.curatedFields) && brand.curatedFields.includes('fontFamily');

  // One shared brand family used by EVERY role that has no explicit per-role
  // font. Without this, `quote` skipped `scanned` and fell straight to serif
  // Lora while heading/body used the brand's sans family — an unrequested
  // serif+sans mix on every render. Now: explicit per-role font → shared
  // brand family → the curated role default (Playfair/Inter/Lora, an
  // intentional pairing used only when the brand has NO family at all, so
  // the three still work together rather than mixing arbitrarily).
  const sharedFamily = normalizeFontFamily(
    (fontIsCurated ? scanned : null) ||
    tailwind?.fonts?.body || websiteUsage.body || scanned ||
    theme.bodyFontFamily || theme.headingFontFamily || null
  );

  const wanted = {
    heading: normalizeFontFamily(overrides.heading?.family || theme.headingFontFamily || (fontIsCurated ? scanned : null) || tailwind?.fonts?.heading || websiteUsage.heading || sharedFamily) || DEFAULT_ROLE_FONTS.heading.family,
    body: normalizeFontFamily(overrides.body?.family || theme.bodyFontFamily || (fontIsCurated ? scanned : null) || tailwind?.fonts?.body || websiteUsage.body || sharedFamily) || DEFAULT_ROLE_FONTS.body.family,
    quote: normalizeFontFamily(overrides.quote?.family || theme.quoteFontFamily || websiteUsage.quote || sharedFamily) || DEFAULT_ROLE_FONTS.quote.family,
  };
  const weights = {
    heading: overrides.heading?.weight || 700,
    body: overrides.body?.weight || 500,
    quote: overrides.quote?.weight || 400,
  };

  const out = {};
  for (const role of ['heading', 'body', 'quote']) {
    const def = DEFAULT_ROLE_FONTS[role];
    let entry = await resolveFamily(wanted[role], { brand, weight: weights[role] });
    if (!entry && wanted[role] !== def.family) {
      entry = await resolveFamily(def.family, { brand, weight: def.weight });
    }
    // entry.weight is the weight of the actual font FILE (may differ from the
    // requested weight when a family only ships one cut) — FontFace must be
    // registered with the file's weight so the browser matches + synthesizes.
    out[role] = entry
      ? {
          family: entry.family, weight: entry.weight, style: entry.style || 'normal',
          url: entry.localPath, remoteUrl: entry.remoteUrl || null,
          fallback: entry.fallback, source: entry.source,
          exact: entry.exact !== false,
          requestedFamily: entry.requestedFamily || wanted[role],
          resolvedFamily: entry.resolvedFamily || entry.family,
          matchReason: entry.matchReason || null
        }
      : {
          family: def.family, weight: def.weight, style: 'normal', url: null,
          remoteUrl: null, fallback: def.fallback, source: 'default',
          exact: false, requestedFamily: wanted[role], resolvedFamily: def.family,
          matchReason: 'role default'
        };
  }
  return out;
}

module.exports = {
  resolveBrandFonts,
  resolveFamily,
  resolveGoogleFamily,
  resolveLibraryMatch,
  normalizeFontFamily,
  matchCustomFont,
  FONT_CACHE_DIR,
  DEFAULT_ROLE_FONTS,
};
