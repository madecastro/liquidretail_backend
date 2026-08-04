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

// Font container magic (first 4 bytes). Mirrors brandFontIngestService —
// duplicated here to avoid a resolver→ingest dependency for a 5-line check.
// Known good: wOFF, wOF2, OTTO, 00010000 (ttf), ttcf. HTML interstitials
// and other non-font 200 bodies fail this check.
function isFontMagicLocal(buf) {
  if (!buf || buf.length < 4) return false;
  const head = Buffer.isBuffer(buf) ? buf.subarray(0, 4) : Buffer.from(buf).subarray(0, 4);
  return (
    head.equals(Buffer.from('wOFF')) ||
    head.equals(Buffer.from('wOF2')) ||
    head.equals(Buffer.from('OTTO')) ||
    head.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) ||
    head.equals(Buffer.from('ttcf'))
  );
}

/** Read first 4 bytes of a cached file; false if missing / short / not font. */
async function localCacheIsFont(filePath) {
  try {
    const fh = await fsp.open(filePath, 'r');
    try {
      const head = Buffer.alloc(4);
      const { bytesRead } = await fh.read(head, 0, 4, 0);
      if (bytesRead < 4) return false;
      return isFontMagicLocal(head);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
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

/**
 * Values that are CSS PLUMBING, not font families. A scraped stylesheet yields
 * these constantly and every one of them is a dead end for family matching.
 *
 * THIS COST A DAY. AllBirds' font scrape stored
 *   websiteFontUsage = { heading: null, body: "var(--font-sans)", … }
 * because the site declares its stack through a custom property and the scraper
 * captured the reference rather than resolving it. Nothing filtered it, so
 * "var(--font-sans)" travelled all the way into family matching as if it were a
 * typeface name. It matched no custom font, no Google font and no substitution
 * entry, so resolution fell through to the brand-signal rules, where the tone
 * string "friendly" selected Poppins — and the SAME ad re-rendered as Inter, then
 * Playfair Display, then Poppins across three renders as this field churned.
 *
 * The brand's real fonts were sitting in `customFonts` the whole time (Geograph,
 * Self Modern, Akkurat Mono, all ingested by that same scrape). The matcher never
 * failed; it was never given a name to match.
 */
function isNonFamilyToken(family) {
  const f = String(family || '').trim().toLowerCase();
  if (!f) return true;
  // ANY parenthesis disqualifies. A real family name never contains one, and this
  // is what makes comma-splitting safe: "var(--brand-font, serif)" splits into
  // `var(--brand-font` and `serif)`, and the second fragment is NOT caught by the
  // generic-family list because "serif)" !== "serif" — it would have been returned
  // as a typeface called "serif)". Caught by the harness sweeping var() forms,
  // after the narrower startsWith checks had already been written.
  if (f.includes('(') || f.includes(')')) return true;
  if (f.startsWith('--')) return true;                             // bare custom-property name
  // CSS-wide keywords: legal in a font-family declaration, useless as a family.
  return ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto', 'normal'].includes(f);
}

function normalizeFontFamily(value) {
  for (const part of String(value || '').split(',')) {
    const family = part.trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (!family) continue;
    if (GENERIC_FAMILIES.has(family.toLowerCase())) continue;
    if (isNonFamilyToken(family)) continue;
    return family;
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
 * BRAND_FONT_ASSUME_LICENSED (default true): when on, commercial-CDN faces
 * that were successfully mirrored (url set, needsLicense not explicitly true)
 * are eligible for use. Classification is not rewritten — only use is gated.
 * Read at call time so tests can flip the env without reloading the module.
 */
function brandFontAssumeLicensed() {
  return String(process.env.BRAND_FONT_ASSUME_LICENSED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Find an ingested website font on the brand matching `family`
 * (case/space-insensitive), preferring the requested weight. The style
 * must match so a roman request never silently renders with an italic face.
 *
 * Always rejects entries with no url (failed mirror is unusable) and
 * entries with needsLicense:true (explicit human hold). Commercial faces
 * require BRAND_FONT_ASSUME_LICENSED to be on.
 */
function matchCustomFont(brand, family, { weight = 400, style = 'normal' } = {}) {
  const list = Array.isArray(brand?.customFonts) ? brand.customFonts : [];
  const want = familyKey(family);
  if (!want) return null;
  const assumeLicensed = brandFontAssumeLicensed();
  const usable = list.filter((f) => {
    if (!f || !f.url) return false;
    // Explicit human hold always wins over the assume-licensed flag.
    if (f.needsLicense === true) return false;
    if (f.license === 'commercial' && !assumeLicensed) return false;
    return familyKey(f.family) === want && (f.style || 'normal') === style;
  });
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
    // Size alone is not enough: a prior 200 HTML interstitial can sit in
    // cache at ≥1KB. Magic-byte check self-heals bad caches (re-download).
    // Real font files (woff/woff2/otf/ttf/ttc) always pass — no risk to
    // previously good mirrors.
    let cacheOk = stat && stat.size >= 1024 && await localCacheIsFont(localPath);
    if (!cacheOk) {
      if (stat) await fsp.rm(localPath, { force: true }).catch(() => {});
      await downloadTo(custom.url, localPath);
      // Reject a freshly downloaded non-font the same way as a miss.
      if (!(await localCacheIsFont(localPath))) {
        await fsp.rm(localPath, { force: true }).catch(() => {});
        throw new Error(`custom font payload not-a-font for '${custom.family}'`);
      }
    }
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
//
// Order matters:
//   1) foundry names first (stable for brands that already matched),
//   2) commercial DTC webfonts (specific named faces — must beat generic
//      classification tokens like "display"/"grotesk" in "Domaine Display"),
//   3) type-classification vocabulary (proprietary names like "Self Modern").
// Foundry + classification row contents/order relative to each other are
// unchanged; commercial is inserted between so named faces win over class words.
const LIBRARY_SUBSTITUTIONS = [
  // ── Foundry names (do not reorder relative to each other) ──────────────
  { pattern: /helvetica|arial|univers|frutiger|neue haas/i, family: 'Inter', reason: 'neutral grotesk sans' },
  { pattern: /gotham|proxima|futura|century gothic|brandon/i, family: 'Montserrat', reason: 'geometric sans' },
  { pattern: /avenir|circular|museo sans|sofia pro/i, family: 'DM Sans', reason: 'modern humanist sans' },
  { pattern: /din|trade gothic|franklin gothic|league gothic/i, family: 'Oswald', reason: 'condensed industrial sans' },
  { pattern: /impact|haettenschweiler/i, family: 'Anton', reason: 'heavy display sans' },
  { pattern: /bodoni|didot|walbaum/i, family: 'Playfair Display', reason: 'high-contrast editorial serif' },
  { pattern: /garamond|caslon|baskerville|minion|adobe jenson/i, family: 'Cormorant Garamond', reason: 'old-style editorial serif' },
  { pattern: /script|brush|handwriting|calligraphy/i, family: 'Great Vibes', reason: 'formal script' },
  // ── Commercial DTC webfonts (named faces; before classification) ───────
  // Used when the brand face cannot be mirrored (foundry CDN 403 / subset /
  // obfuscation). Every target MUST be one of the 16 curated faces in
  // fontLoader.FONTS — a target outside that list 404s at render. Foundry
  // rows above still win first for overlaps (e.g. Circular → DM Sans).
  { pattern: /s[oö]hne|soehne/i, family: 'Inter', reason: 'Söhne → Inter (Klim neo-grotesk)' },
  { pattern: /gt\s*america/i, family: 'Inter', reason: 'GT America → Inter (Grilli American grotesque)' },
  { pattern: /untitled\s*sans/i, family: 'Inter', reason: 'Untitled Sans → Inter (Klim neo-grotesk)' },
  { pattern: /\bcanela\b/i, family: 'Playfair Display', reason: 'Canela → Playfair (Commercial Type high-contrast serif)' },
  { pattern: /\btiempos\b/i, family: 'Lora', reason: 'Tiempos → Lora (Klim editorial text serif)' },
  { pattern: /\bgraphik\b/i, family: 'Inter', reason: 'Graphik → Inter (Commercial Type neo-grotesk)' },
  { pattern: /\bsuisse\b/i, family: 'Inter', reason: 'Suisse → Inter (Swiss Typefaces grotesque)' },
  { pattern: /maison\s*neue/i, family: 'Montserrat', reason: 'Maison Neue → Montserrat (geometric sans)' },
  { pattern: /\baeonik\b/i, family: 'Montserrat', reason: 'Aeonik → Montserrat (CoType geometric sans)' },
  { pattern: /national\s*2/i, family: 'DM Sans', reason: 'National 2 → DM Sans (Klim soft grotesque)' },
  { pattern: /neue\s*montreal/i, family: 'Inter', reason: 'Neue Montreal → Inter (Pangram neo-grotesk)' },
  { pattern: /sharp\s*grotesk/i, family: 'Inter', reason: 'Sharp Grotesk → Inter (Sharp Type display grotesque)' },
  { pattern: /\brecoleta\b/i, family: 'Cormorant', reason: 'Recoleta → Cormorant (soft rounded display serif)' },
  { pattern: /\bdomaine\b/i, family: 'Playfair Display', reason: 'Domaine → Playfair (Klim fashion display serif)' },
  { pattern: /aperc[uú]|aperçu/i, family: 'Montserrat', reason: 'Aperçu → Montserrat (Colophon geometric grotesk)' },
  { pattern: /founders\s*grotesk/i, family: 'Inter', reason: 'Founders Grotesk → Inter (Klim neo-grotesk)' },
  { pattern: /\bdruk\b/i, family: 'Bebas Neue', reason: 'Druk → Bebas Neue (Commercial Type condensed display)' },
  { pattern: /gt\s*walsheim/i, family: 'Montserrat', reason: 'GT Walsheim → Montserrat (Grilli geometric sans)' },
  { pattern: /gt\s*sectra/i, family: 'Playfair Display', reason: 'GT Sectra → Playfair (Grilli contrast serif)' },
  { pattern: /editorial\s*new/i, family: 'Playfair Display', reason: 'Editorial New → Playfair (Pangram editorial display serif)' },
  { pattern: /pp\s*mori/i, family: 'Montserrat', reason: 'PP Mori → Montserrat (Pangram geometric sans)' },
  { pattern: /\bwhyte\b/i, family: 'Inter', reason: 'Whyte → Inter (Dinamo neo-grotesk)' },
  { pattern: /\bfavorit\b/i, family: 'Montserrat', reason: 'Favorit → Montserrat (Dinamo geometric sans)' },
  { pattern: /\bakkurat\b/i, family: 'Inter', reason: 'Akkurat → Inter (Lineto Swiss grotesk)' },
  { pattern: /\bpublico\b/i, family: 'Lora', reason: 'Publico → Lora (Commercial Type news text serif)' },
  { pattern: /\bstyrene\b/i, family: 'Montserrat', reason: 'Styrene → Montserrat (Commercial Type geometric sans)' },
  { pattern: /\broobert\b/i, family: 'Montserrat', reason: 'Roobert → Montserrat (Displaay geometric sans)' },
  { pattern: /ideal\s*sans/i, family: 'DM Sans', reason: 'Ideal Sans → DM Sans (Hoefler humanist sans)' },
  { pattern: /\bfreight\b/i, family: 'Lora', reason: 'Freight → Lora (GarageFonts editorial serif)' },
  { pattern: /sang\s*bleu|sangbleu/i, family: 'Cormorant', reason: 'SangBleu → Cormorant (Swiss Typefaces fashion serif)' },
  { pattern: /monument\s*grotesk/i, family: 'Inter', reason: 'Monument Grotesk → Inter (Dinamo neo-grotesk)' },
  { pattern: /abc\s*diatype|\bdiatype\b/i, family: 'Montserrat', reason: 'ABC Diatype → Montserrat (Dinamo geometric sans)' },
  { pattern: /noe\s*display/i, family: 'Playfair Display', reason: 'Noe Display → Playfair (Schwartzco display serif)' },
  { pattern: /\bsaans\b/i, family: 'Inter', reason: 'Saans → Inter (Displaay neo-grotesk)' },
  // Circular also appears in foundry row above (same target); listed for audit.
  { pattern: /ll\s*circular|\bcircular\b/i, family: 'DM Sans', reason: 'Circular → DM Sans (Lineto geometric-humanist sans)' },
  { pattern: /\baustin(\s+(text|display))?\b/i, family: 'Playfair Display', reason: 'Austin → Playfair (Commercial Type Didone)' },
  // ── Type-classification vocabulary (proprietary DTC names often carry these) ──
  // More specific compounds before single-token classes (humanist serif before
  // humanist; grotesk before bare "modern" so "Modern Grotesk" stays a sans).
  { pattern: /old.?style|humanist serif/i, family: 'Cormorant Garamond', reason: 'old-style/humanist-serif classification' },
  { pattern: /grotesk|grotesque/i, family: 'Inter', reason: 'grotesk/grotesque classification' },
  { pattern: /geometric/i, family: 'Montserrat', reason: 'geometric classification' },
  { pattern: /humanist/i, family: 'DM Sans', reason: 'humanist sans classification' },
  { pattern: /condensed|compressed|narrow/i, family: 'Oswald', reason: 'condensed classification' },
  { pattern: /extended|wide/i, family: 'Anton', reason: 'extended/wide display classification' },
  { pattern: /display|poster|headline/i, family: 'Bebas Neue', reason: 'display/poster classification' },
  { pattern: /rounded|soft/i, family: 'Quicksand', reason: 'rounded/soft classification' },
  { pattern: /mono|plex|technical/i, family: 'IBM Plex Sans', reason: 'mono/technical classification' },
  { pattern: /elegant|luxe|couture/i, family: 'Cormorant', reason: 'elegant/luxe classification' },
  // No true slab in the 16-face library; Lora is the closest transitional
  // serif with enough weight to stand in for Rockwell/Roboto Slab-class faces.
  { pattern: /slab/i, family: 'Lora', reason: 'slab → Lora (closest available; no true slab in library)' },
  // "Modern" as a classification = Didone (high-contrast serif). Word-boundary
  // so we do not steal longer tokens; "Self Modern" / "Modern" both match.
  { pattern: /didone|\bmodern\b/i, family: 'Playfair Display', reason: 'modern/didone classification' },
];

// Faces that must not land on body copy (legibility). Applied only when
// role === 'body'; foundry/classification non-regression tests use heading
// or null role so script→Great Vibes etc. stay unchanged.
const BODY_UNSAFE_FACES = new Set(['Anton', 'Bebas Neue', 'Great Vibes', 'Antonio']);

// Serif faces in the curated 16 (must stay aligned with SERIF_HINTS /
// fallbackFor). Great Vibes is a script; treated as serif-intent for the
// serif/sans constraint when it is the chosen face.
const LIBRARY_SERIF_FACES = new Set([
  'Playfair Display', 'Lora', 'Cormorant', 'Cormorant Garamond', 'Great Vibes',
]);

/**
 * Flatten brand fields that carry typographic signal into one lowercased
 * string. Deterministic: fixed field order, no dates/ids/mutable stamps.
 */
function brandSignalText(brand) {
  if (!brand || typeof brand !== 'object') return '';
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    if (typeof v === 'object') {
      // Stable key order so the same brand object always yields the same blob.
      for (const key of Object.keys(v).sort()) {
        // Skip ids/timestamps that would break determinism if they ever appear.
        if (/^(updatedAt|createdAt|adjustedAt|_id|id|fetchedAt|ingestedAt)$/i.test(key)) continue;
        push(v[key]);
      }
    }
  };
  push(brand.brandSafety && brand.brandSafety.category);
  push(brand.category);
  push(brand.tone);
  push(brand.tags);
  push(brand.styleTheme);
  push(brand.tailwindTheme);
  push(brand.websiteFontUsage);
  return parts.join(' ').toLowerCase();
}

// Ordered brand-signal rules. First match wins. Each rule names a face per
// (role, serif|sans) so heading can take a display face while body stays
// legible. Covers the faces that classification vocabulary alone cannot
// always reach (Antonio, Poppins, Nunito, …).
const BRAND_SIGNAL_RULES = [
  {
    re: /luxury|premium|luxe|couture|jewelry|jewellery|beauty/,
    reason: 'brand signal: luxury/premium',
    faces: {
      heading: { serif: 'Cormorant', 'sans-serif': 'Montserrat' },
      body: { serif: 'Cormorant Garamond', 'sans-serif': 'DM Sans' },
      quote: { serif: 'Cormorant', 'sans-serif': 'DM Sans' },
    },
  },
  {
    re: /sport|athletic|fitness|outdoor|outdoors|rugged/,
    reason: 'brand signal: sport/athletic',
    faces: {
      heading: { serif: 'Playfair Display', 'sans-serif': 'Antonio' },
      // Body stays on a highly-legible face (not condensed display).
      body: { serif: 'Lora', 'sans-serif': 'IBM Plex Sans' },
      quote: { serif: 'Lora', 'sans-serif': 'Oswald' },
    },
  },
  {
    re: /tech|software|saas|digital|\bai\b|electronics/,
    reason: 'brand signal: tech',
    faces: {
      heading: { serif: 'Lora', 'sans-serif': 'IBM Plex Sans' },
      body: { serif: 'Lora', 'sans-serif': 'IBM Plex Sans' },
      quote: { serif: 'Lora', 'sans-serif': 'IBM Plex Sans' },
    },
  },
  {
    re: /food|cpg|beverage|restaurant|grocery|cafe|coffee/,
    reason: 'brand signal: food/cpg',
    faces: {
      heading: { serif: 'Lora', 'sans-serif': 'Nunito' },
      body: { serif: 'Lora', 'sans-serif': 'Nunito' },
      quote: { serif: 'Lora', 'sans-serif': 'Nunito' },
    },
  },
  {
    re: /playful|fun|friendly|kids|toy|whimsical/,
    reason: 'brand signal: playful/friendly',
    faces: {
      heading: { serif: 'Lora', 'sans-serif': 'Poppins' },
      body: { serif: 'Lora', 'sans-serif': 'Poppins' },
      quote: { serif: 'Lora', 'sans-serif': 'Poppins' },
    },
  },
  {
    re: /warm|casual|soft|rounded|cozy/,
    reason: 'brand signal: warm/casual',
    faces: {
      heading: { serif: 'Lora', 'sans-serif': 'Nunito' },
      body: { serif: 'Lora', 'sans-serif': 'Quicksand' },
      quote: { serif: 'Lora', 'sans-serif': 'Nunito' },
    },
  },
  {
    re: /bold|loud|energetic|impactful/,
    reason: 'brand signal: bold/loud',
    faces: {
      heading: { serif: 'Playfair Display', 'sans-serif': 'Bebas Neue' },
      body: { serif: 'Lora', 'sans-serif': 'Montserrat' },
      quote: { serif: 'Playfair Display', 'sans-serif': 'Anton' },
    },
  },
  {
    re: /apparel|fashion|clothing|footwear|shoe|sneaker/,
    reason: 'brand signal: apparel/fashion',
    faces: {
      heading: { serif: 'Playfair Display', 'sans-serif': 'Montserrat' },
      body: { serif: 'Lora', 'sans-serif': 'Poppins' },
      quote: { serif: 'Playfair Display', 'sans-serif': 'DM Sans' },
    },
  },
  {
    re: /minimal|clean|professional|corporate/,
    reason: 'brand signal: minimal/clean',
    faces: {
      heading: { serif: 'Cormorant Garamond', 'sans-serif': 'DM Sans' },
      body: { serif: 'Lora', 'sans-serif': 'DM Sans' },
      quote: { serif: 'Lora', 'sans-serif': 'DM Sans' },
    },
  },
];

function roleKey(role) {
  if (role === 'heading' || role === 'body' || role === 'quote') return role;
  return 'body';
}

/**
 * When a classification/foundry pick lands on a display/script face for body
 * copy, remap to a legible peer keeping serif/sans intent.
 */
function enforceBodyLegibility(family, intent) {
  if (!BODY_UNSAFE_FACES.has(family)) return { family, remapped: false };
  if (intent === 'serif') {
    return { family: 'Lora', remapped: true };
  }
  // Sans display/script → neutral grotesk (never a second display face).
  return { family: 'Inter', remapped: true };
}

/**
 * Role-aware default when neither a name match nor a brand signal fires.
 * Deterministic; preserves serif/sans intent from the requested family.
 */
function defaultLibraryPick(intent, role) {
  const r = roleKey(role);
  if (intent === 'serif') {
    if (r === 'heading') {
      return { family: 'Playfair Display', reason: 'serif heading default (library)' };
    }
    if (r === 'quote') {
      return { family: 'Lora', reason: 'serif quote default (library)' };
    }
    return { family: 'Lora', reason: 'serif body default (library)' };
  }
  if (r === 'heading') {
    return { family: 'Inter', reason: 'sans heading default (library)' };
  }
  return { family: 'Inter', reason: 'sans body default (library)' };
}

/**
 * Pure library-face chooser (no I/O). Used by resolveLibraryMatch and the
 * offline verify harness. Same brand+role+requestedFamily ALWAYS returns
 * the same face — no randomness, no mutable stamps.
 *
 * @returns {{ family: string, matchReason: string, requestedFamily: string, intent: string } | null}
 */
function pickLibraryFamily(requestedFamily, { brand = null, role = null } = {}) {
  const requested = normalizeFontFamily(requestedFamily);
  if (!requested) return null;

  const intent = fallbackFor(requested); // 'serif' | 'sans-serif'
  const r = roleKey(role);

  // 1) Name-based foundry + classification table. Classification is
  // authoritative (e.g. "Self Modern" → Didone/Playfair even though the
  // bare name does not look serif to fallbackFor). Do not undo these with
  // the intent guard below.
  const substitution = LIBRARY_SUBSTITUTIONS.find((item) => item.pattern.test(requested));
  let family = null;
  let matchReason = null;
  let fromNameTable = false;

  if (substitution) {
    family = substitution.family;
    matchReason = substitution.reason;
    fromNameTable = true;
  } else {
    // 2) Brand-signal-informed chooser (category / tone / theme / tags).
    const signals = brandSignalText(brand);
    if (signals) {
      for (const rule of BRAND_SIGNAL_RULES) {
        if (!rule.re.test(signals)) continue;
        const byRole = rule.faces[r] || rule.faces.body;
        const candidate = byRole[intent] || byRole['sans-serif'];
        if (candidate) {
          family = candidate;
          matchReason = rule.reason;
          break;
        }
      }
    }
    // 3) Role-aware serif/sans default (replaces binary Lora/Inter).
    if (!family) {
      const def = defaultLibraryPick(intent, r);
      family = def.family;
      matchReason = def.reason;
    }
  }

  // Body must stay legible — never burn display/script into paragraph copy.
  // Applies even to name-table hits (script → Great Vibes on body is wrong).
  if (r === 'body') {
    const safe = enforceBodyLegibility(family, intent);
    if (safe.remapped) {
      matchReason = `${matchReason}; body-safe remap → ${safe.family}`;
      family = safe.family;
    }
  }

  // Serif/sans intent guard for brand-signal + default paths only. Name-table
  // hits already encode classification knowledge (modern→Didone, script→…).
  // Constraint: a serif-hinted request never lands on a grotesk, and a
  // non-serif request never lands on a serif when we chose by brand/default.
  if (!fromNameTable) {
    const familyIsSerif = LIBRARY_SERIF_FACES.has(family);
    if (intent === 'serif' && !familyIsSerif) {
      const def = defaultLibraryPick('serif', r);
      matchReason = `${matchReason}; serif-intent guard → ${def.family}`;
      family = def.family;
    } else if (intent === 'sans-serif' && familyIsSerif) {
      const def = defaultLibraryPick('sans-serif', r);
      matchReason = `${matchReason}; sans-intent guard → ${def.family}`;
      family = def.family;
    }
  }

  return {
    family,
    matchReason,
    requestedFamily: requested,
    intent,
  };
}

let libraryReadyPromise = null;
async function resolveLibraryMatch(requestedFamily, weight = 400, { brand = null, role = null } = {}) {
  const pick = pickLibraryFamily(requestedFamily, { brand, role });
  if (!pick) return null;
  const matchedFamily = pick.family;
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
    requestedFamily: pick.requestedFamily,
    resolvedFamily: font.family,
    matchReason: pick.matchReason,
  };
}

/**
 * Resolve one family through the full ladder. Returns
 * { family, weight, style, localPath|null, fallback, source } — localPath
 * null means "let the browser fall back" (family kept for CSS stacks).
 */
async function resolveFamily(family, { brand = null, weight = 400, role = null } = {}) {
  family = normalizeFontFamily(family);
  if (!family) return null;

  const custom = matchCustomFont(brand, family, { weight });
  if (custom) {
    const entry = await resolveCustomFont(brand, custom, weight);
    if (entry) return entry;
  }

  const google = await resolveGoogleFamily(family, weight);
  if (google) return google;

  // Library fallback only — brand + role inform the curated-face pick when
  // the proprietary name misses both custom and Google (common DTC case).
  const library = await resolveLibraryMatch(family, weight, { brand, role });
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
  // styleTheme STORES DIFFERENT KEYS THAN THIS FILE READ. The brand docs carry
  // `sansFontFamily` / `serifFontFamily` / `productFontFamily` (the canvas-era
  // vocabulary), while the chain below asked for `headingFontFamily` /
  // `bodyFontFamily`. So a curated styleTheme silently governed NOTHING for
  // heading and body — the only key that lined up was `quoteFontFamily`, which is
  // exactly why AllBirds' quote font stayed Lora across three renders while its
  // heading and body drifted Inter -> Playfair -> Poppins. Accept both spellings.
  const themeHeading = theme.headingFontFamily || theme.sansFontFamily || null;
  const themeBody    = theme.bodyFontFamily    || theme.sansFontFamily || null;
  const themeQuote   = theme.quoteFontFamily   || theme.serifFontFamily || null;

  // THE BRAND'S OWN FACE WINS — but only when we actually hold a usable file.
  //
  // Enabling the styleTheme aliases above had a consequence adversarial review
  // caught and production data confirmed: of 34 brands, ZERO set
  // headingFontFamily (so that tier was always dead) while FOUR set
  // sansFontFamily, and all four disagree with their scraped family —
  // AllBirds theme.sans "DM Sans" vs scanned "Self Modern", Pelagic "Montserrat"
  // vs "Oswald". Left as theme-first, this change would have replaced AllBirds'
  // real typeface with a generic Google face, which is the opposite of the intent
  // ("pull the brand's real fonts, match closer").
  //
  // So the scraped family outranks the theme ONLY when matchCustomFont finds a
  // usable ingested file for it — that is what makes it the brand's REAL face
  // rather than a brandfetch guess. matchCustomFont is reused deliberately: it
  // already enforces needsLicense holds and the commercial-licence gate, so an
  // unlicensed face cannot win here and correctly falls through to the theme.
  const scannedFamily = normalizeFontFamily(scanned);
  const scannedIsOwnedFace = !!(scannedFamily && matchCustomFont(brand, scannedFamily));
  const ownFace = scannedIsOwnedFace ? scannedFamily : null;

  const sharedFamily = normalizeFontFamily(
    (fontIsCurated ? scanned : null) ||
    ownFace ||
    tailwind?.fonts?.body || websiteUsage.body ||
    themeBody || themeHeading ||
    scanned || null
  );

  const wanted = {
    heading: normalizeFontFamily(overrides.heading?.family || ownFace || themeHeading || (fontIsCurated ? scanned : null) || tailwind?.fonts?.heading || websiteUsage.heading || sharedFamily) || DEFAULT_ROLE_FONTS.heading.family,
    body: normalizeFontFamily(overrides.body?.family || ownFace || themeBody || (fontIsCurated ? scanned : null) || tailwind?.fonts?.body || websiteUsage.body || sharedFamily) || DEFAULT_ROLE_FONTS.body.family,
    // Quote keeps theme priority: serifFontFamily is a deliberate pairing choice
    // (it is why AllBirds' Lora held steady), and a sans brand face must not
    // silently replace a curated serif quote voice.
    quote: normalizeFontFamily(overrides.quote?.family || themeQuote || websiteUsage.quote || sharedFamily) || DEFAULT_ROLE_FONTS.quote.family,
  };
  const weights = {
    heading: overrides.heading?.weight || 700,
    body: overrides.body?.weight || 500,
    quote: overrides.quote?.weight || 400,
  };

  const out = {};
  for (const role of ['heading', 'body', 'quote']) {
    const def = DEFAULT_ROLE_FONTS[role];
    let entry = await resolveFamily(wanted[role], { brand, weight: weights[role], role });
    if (!entry && wanted[role] !== def.family) {
      entry = await resolveFamily(def.family, { brand, weight: def.weight, role });
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
  pickLibraryFamily,
  normalizeFontFamily,
  matchCustomFont,
  brandFontAssumeLicensed,
  fallbackFor,
  brandSignalText,
  LIBRARY_SUBSTITUTIONS,
  BODY_UNSAFE_FACES,
  LIBRARY_SERIF_FACES,
  FONT_CACHE_DIR,
  DEFAULT_ROLE_FONTS,
};
