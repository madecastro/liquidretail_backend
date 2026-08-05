// Resolves the actual font FILES the Remotion titling engine renders with.
//
// TWO SEPARATE MECHANISMS — do not conflate them:
//
//   buildFontLadders() decides WHICH FAMILIES to try, in order, per role. See
//   its own comment for the tier order and why it is load-bearing. The headline
//   rule: the brand's REAL face (ingested file, or a family Google actually
//   serves) outranks a curated theme guess, but only when it resolves EXACTLY —
//   a tone-matched library substitution is not the brand's typeface and must
//   never outrank a curated choice.
//
//   resolveFamily() resolves ONE family to a file:
//     1. Brand.customFonts — a file ingested from the brand's own website
//        (brandFontIngestService), mirrored on Cloudinary. Licence holds
//        respected via matchCustomFont.
//     2. Google Fonts, fetched live, if the family exists there.
//     3. LIBRARY_SUBSTITUTIONS → the closest face in fontLoader's curated
//        library. Marked `exact: false` — this is an APPROXIMATION, and callers
//        that require the real face reject it.
//   Anything reaching step 3 is logged, so "brand rendered with an approximated
//   face" is visible in ops instead of silently shipping off-brand — the exact
//   failure mode the bundled-TTF canvas engine had.
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
// Must stay aligned with LIBRARY_SERIF_FACES: a library serif whose name misses
// this regex gets `fallback: 'sans-serif'`, so if the file fails to load the
// browser substitutes a sans for a serif face.
const SERIF_HINTS = /serif|playfair|lora|cormorant|garamond|fraunces|caslon|bodoni|didot|georgia|times|libre|crimson|merriweather|spectral|eb garamond|prata|domine|slab|arvo|marcellus|italiana|cinzel/i;

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
  // Before the broad garamond row: we now ship the actual EB Garamond specimen,
  // so asking for it must not resolve to a different Garamond revival.
  { pattern: /eb\s*garamond/i, family: 'EB Garamond', reason: 'EB Garamond → the library specimen itself' },
  { pattern: /garamond|caslon|baskerville|minion|adobe jenson/i, family: 'Cormorant Garamond', reason: 'old-style editorial serif' },
  { pattern: /script|brush|handwriting|calligraphy/i, family: 'Great Vibes', reason: 'formal script' },
  // ── Commercial DTC webfonts (named faces; before classification) ───────
  // Used when the brand face cannot be mirrored (foundry CDN 403 / subset /
  // obfuscation). Every target MUST be one of the 16 curated faces in
  // fontLoader.FONTS — a target outside that list 404s at render. Foundry
  // rows above still win first for overlaps (e.g. Circular → DM Sans).
  // ── MONO FIRST. A monospace cut must never resolve to a proportional face. ──
  // Named mono specimens, then a catch-all. This cluster sits ABOVE the rest of
  // the commercial rows on purpose: AllBirds ingests "Akkurat Mono", and with
  // the /\bakkurat\b/ row winning it resolved to Inter — a proportional sans
  // standing in for a monospace face, so tabular copy lost its alignment.
  // Monospace-ness dominates a foundry's proportional identity.
  // `\bmono\b` requires the standalone word, so "Monument Grotesk" and
  // "Monotype" are unaffected.
  { pattern: /space\s*mono/i, family: 'Space Mono', reason: 'Space Mono → the library specimen itself' },
  { pattern: /(?:ibm\s*)?plex\s*mono/i, family: 'IBM Plex Mono', reason: 'IBM Plex Mono → the library specimen itself' },
  { pattern: /jetbrains\s*mono/i, family: 'JetBrains Mono', reason: 'JetBrains Mono → the library specimen itself' },
  { pattern: /input\s*mono|sf\s*mono|source\s*code/i, family: 'IBM Plex Mono', reason: 'system/dev mono → IBM Plex Mono' },
  { pattern: /\bmono\b/i, family: 'IBM Plex Mono', reason: 'foundry mono cut → IBM Plex Mono (monospace beats the proportional row)' },
  { pattern: /s[oö]hne|soehne/i, family: 'Inter', reason: 'Söhne → Inter (Klim neo-grotesk)' },
  { pattern: /gt\s*america/i, family: 'Inter', reason: 'GT America → Inter (Grilli American grotesque)' },
  { pattern: /untitled\s*sans/i, family: 'Inter', reason: 'Untitled Sans → Inter (Klim neo-grotesk)' },
  { pattern: /\bcanela\b/i, family: 'Playfair Display', reason: 'Canela → Playfair (Commercial Type high-contrast serif)' },
  { pattern: /\btiempos\b/i, family: 'Source Serif 4', reason: 'Tiempos → Source Serif 4 (Klim editorial text serif)' },
  { pattern: /\bgraphik\b/i, family: 'Inter', reason: 'Graphik → Inter (Commercial Type neo-grotesk)' },
  { pattern: /\bsuisse\b/i, family: 'Inter', reason: 'Suisse → Inter (Swiss Typefaces grotesque)' },
  { pattern: /maison\s*neue/i, family: 'Montserrat', reason: 'Maison Neue → Montserrat (geometric sans)' },
  { pattern: /\baeonik\b/i, family: 'Montserrat', reason: 'Aeonik → Montserrat (CoType geometric sans)' },
  { pattern: /national\s*2/i, family: 'DM Sans', reason: 'National 2 → DM Sans (Klim soft grotesque)' },
  { pattern: /neue\s*montreal/i, family: 'Inter', reason: 'Neue Montreal → Inter (Pangram neo-grotesk)' },
  { pattern: /sharp\s*grotesk/i, family: 'Inter', reason: 'Sharp Grotesk → Inter (Sharp Type display grotesque)' },
  { pattern: /\brecoleta\b/i, family: 'Fraunces', reason: 'Recoleta → Fraunces (soft optical display serif)' },
  { pattern: /\bdomaine\b/i, family: 'Prata', reason: 'Domaine → Prata (Klim fashion didone)' },
  { pattern: /aperc[uú]|aperçu/i, family: 'Montserrat', reason: 'Aperçu → Montserrat (Colophon geometric grotesk)' },
  { pattern: /founders\s*grotesk/i, family: 'Inter', reason: 'Founders Grotesk → Inter (Klim neo-grotesk)' },
  { pattern: /\bdruk\b/i, family: 'Bebas Neue', reason: 'Druk → Bebas Neue (Commercial Type condensed display)' },
  { pattern: /gt\s*walsheim/i, family: 'Montserrat', reason: 'GT Walsheim → Montserrat (Grilli geometric sans)' },
  { pattern: /gt\s*sectra/i, family: 'Spectral', reason: 'GT Sectra → Spectral (Grilli contrast serif)' },
  { pattern: /editorial\s*new/i, family: 'DM Serif Display', reason: 'Editorial New → DM Serif Display (Pangram editorial display serif)' },
  { pattern: /pp\s*mori/i, family: 'Montserrat', reason: 'PP Mori → Montserrat (Pangram geometric sans)' },
  { pattern: /\bwhyte\b/i, family: 'Inter', reason: 'Whyte → Inter (Dinamo neo-grotesk)' },
  { pattern: /\bfavorit\b/i, family: 'Montserrat', reason: 'Favorit → Montserrat (Dinamo geometric sans)' },
  { pattern: /\bakkurat\b/i, family: 'Inter', reason: 'Akkurat → Inter (Lineto Swiss grotesk)' },
  { pattern: /\bpublico\b/i, family: 'Merriweather', reason: 'Publico → Merriweather (Commercial Type news text serif)' },
  { pattern: /\bstyrene\b/i, family: 'Montserrat', reason: 'Styrene → Montserrat (Commercial Type geometric sans)' },
  { pattern: /\broobert\b/i, family: 'Montserrat', reason: 'Roobert → Montserrat (Displaay geometric sans)' },
  { pattern: /ideal\s*sans/i, family: 'DM Sans', reason: 'Ideal Sans → DM Sans (Hoefler humanist sans)' },
  { pattern: /\bfreight\b/i, family: 'Merriweather', reason: 'Freight → Merriweather (GarageFonts editorial serif)' },
  { pattern: /sang\s*bleu|sangbleu/i, family: 'Prata', reason: 'SangBleu → Prata (Swiss Typefaces fashion serif)' },
  { pattern: /monument\s*grotesk/i, family: 'Inter', reason: 'Monument Grotesk → Inter (Dinamo neo-grotesk)' },
  { pattern: /abc\s*diatype|\bdiatype\b/i, family: 'Montserrat', reason: 'ABC Diatype → Montserrat (Dinamo geometric sans)' },
  { pattern: /noe\s*display/i, family: 'DM Serif Display', reason: 'Noe Display → DM Serif Display (Schwartzco display serif)' },
  { pattern: /\bsaans\b/i, family: 'Inter', reason: 'Saans → Inter (Displaay neo-grotesk)' },
  // Circular also appears in foundry row above (same target); listed for audit.
  { pattern: /ll\s*circular|\bcircular\b/i, family: 'DM Sans', reason: 'Circular → DM Sans (Lineto geometric-humanist sans)' },
  { pattern: /\baustin(\s+(text|display))?\b/i, family: 'Prata', reason: 'Austin → Prata (Commercial Type Didone)' },
  // ── Names unlocked by the 16 → 48 library expansion (2026-08-04) ────────
  // These were unrepresentable before: a slab, a mono, a fashion didone and a
  // casual script had no target in the 16-face library, so every one of them
  // resolved to something from the wrong class.
  // NOTE the foundry rows above still run FIRST — in particular
  // /script|brush|handwriting|calligraphy/ → Great Vibes claims any name
  // containing "script", so a row here matching e.g. "Wedding Script" would be
  // dead code. The script rows below deliberately match only names that do not
  // carry those tokens.
  // Slab
  { pattern: /rockwell|archer|sentinel|museo\s*slab|clarendon/i, family: 'Zilla Slab', reason: 'Rockwell/Archer/Sentinel → Zilla Slab (true slab)' },
  { pattern: /egyptian\s*slab|\bcandida\b/i, family: 'Arvo', reason: 'Egyptian slab → Arvo' },
  { pattern: /josefin\s*slab/i, family: 'Josefin Slab', reason: 'Josefin Slab → the library specimen itself' },
  // Editorial / text serif
  { pattern: /\bogg\b/i, family: 'DM Serif Display', reason: 'Ogg → DM Serif Display (Sharp Type display serif)' },
  { pattern: /\breckless\b/i, family: 'Italiana', reason: 'Reckless → Italiana (fashion display serif)' },
  { pattern: /value\s*serif|source\s*serif/i, family: 'Source Serif 4', reason: 'Value Serif/Source Serif → Source Serif 4' },
  // "Feature" only with a qualifier — bare "feature" is common product copy and
  // would hijack unrelated names.
  { pattern: /feature\s*(display|serif|text)|\bsignifier\b/i, family: 'Spectral', reason: 'Feature/Signifier → Spectral (editorial contrast serif)' },
  { pattern: /\btimes\b|\bgeorgia\b|\bcharter\b|\bmiller\b/i, family: 'Merriweather', reason: 'Times/Georgia/Charter/Miller → Merriweather (news text serif)' },
  // Geometric / grotesk sans
  { pattern: /\bgilroy\b|product\s*sans|cerebri/i, family: 'Outfit', reason: 'Gilroy/Product Sans → Outfit (geometric sans)' },
  { pattern: /\bsatoshi\b|general\s*sans/i, family: 'Manrope', reason: 'Satoshi/General Sans → Manrope (geometric sans)' },
  { pattern: /clash\s*grotesk|space\s*grotesk/i, family: 'Space Grotesk', reason: 'Clash/Space Grotesk → Space Grotesk' },
  { pattern: /aktiv\s*grotesk|work\s*sans/i, family: 'Work Sans', reason: 'Aktiv Grotesk → Work Sans (neo-grotesk)' },
  { pattern: /\bverdana\b|\btahoma\b|\btrebuchet\b/i, family: 'Work Sans', reason: 'Verdana/Tahoma/Trebuchet → Work Sans (humanist UI sans)' },
  { pattern: /public\s*sans|source\s*sans/i, family: 'Public Sans', reason: 'Public/Source Sans → Public Sans' },
  { pattern: /\barchivo\b(?!\s*(narrow|black))/i, family: 'Archivo', reason: 'Archivo → the library specimen itself' },
  // Condensed. Plain "Barlow" is NOT a condensed face — only the Condensed cut
  // maps to Barlow Condensed; the regular width goes to a normal-width grotesk.
  { pattern: /barlow\s*condensed/i, family: 'Barlow Condensed', reason: 'Barlow Condensed → the library specimen itself' },
  { pattern: /\bbarlow\b/i, family: 'Work Sans', reason: 'Barlow (regular width) → Work Sans (low-contrast grotesk)' },
  { pattern: /archivo\s*narrow|heroic\s*condensed|knockout/i, family: 'Archivo Narrow', reason: 'Archivo Narrow/Knockout → Archivo Narrow' },
  // Wide / heavy display
  { pattern: /archivo\s*black|ultra\s*black|extra\s*black/i, family: 'Archivo Black', reason: 'Archivo Black / ultra-black → Archivo Black' },
  { pattern: /\bsyne\b/i, family: 'Syne', reason: 'Syne → the library specimen itself' },
  // Rounded
  { pattern: /vag\s*rounded|\bbaloo\b/i, family: 'Baloo 2', reason: 'VAG Rounded/Baloo → Baloo 2' },
  { pattern: /\bcomfortaa\b/i, family: 'Comfortaa', reason: 'Comfortaa → the library specimen itself' },
  // Script / hand — casual and formal scripts are different voices; Great Vibes
  // (formal copperplate) was standing in for both.
  { pattern: /snell\s*roundhand|bickham|edwardian/i, family: 'Dancing Script', reason: 'Snell/Bickham/Edwardian → Dancing Script' },
  { pattern: /\bpacifico\b|\blobster\b|satisfy/i, family: 'Pacifico', reason: 'Pacifico/Lobster/Satisfy → Pacifico (casual script)' },
  { pattern: /marker\s*felt|comic\s*sans|chalkboard|hand.?letter/i, family: 'Caveat', reason: 'Comic/marker/hand-letter → Caveat' },
  // Didone / fashion / luxury
  { pattern: /\bprata\b/i, family: 'Prata', reason: 'Prata → the library specimen itself' },
  { pattern: /\bitaliana\b/i, family: 'Italiana', reason: 'Italiana → the library specimen itself' },
  { pattern: /dm\s*serif(\s*display)?/i, family: 'DM Serif Display', reason: 'DM Serif Display → the library specimen itself' },
  { pattern: /\bmarcellus\b|orpheus/i, family: 'Marcellus', reason: 'Marcellus/Orpheus → Marcellus (fashion serif)' },
  { pattern: /\bfraunces\b|soft\s*serif|wonky\s*serif/i, family: 'Fraunces', reason: 'Fraunces/soft-serif → Fraunces' },
  { pattern: /copperplate|\btrajan\b|inscriptional/i, family: 'Cinzel', reason: 'Copperplate/Trajan → Cinzel (inscriptional display)' },
  { pattern: /\boptima\b|zapf\s*humanist|tenor\s*sans/i, family: 'Tenor Sans', reason: 'Optima → Tenor Sans (flare-humanist sans)' },
  // ── Type-classification vocabulary (proprietary DTC names often carry these) ──
  // More specific compounds before single-token classes (humanist serif before
  // humanist; grotesk before bare "modern" so "Modern Grotesk" stays a sans).
  { pattern: /old.?style|humanist serif/i, family: 'EB Garamond', reason: 'old-style/humanist-serif classification' },
  { pattern: /grotesk|grotesque/i, family: 'Inter', reason: 'grotesk/grotesque classification' },
  { pattern: /geometric/i, family: 'Montserrat', reason: 'geometric classification' },
  { pattern: /humanist/i, family: 'DM Sans', reason: 'humanist sans classification' },
  { pattern: /condensed|compressed|narrow/i, family: 'Oswald', reason: 'condensed classification' },
  { pattern: /extended|wide/i, family: 'Syne', reason: 'extended/wide display classification' },
  { pattern: /display|poster|headline/i, family: 'Bebas Neue', reason: 'display/poster classification' },
  { pattern: /rounded|soft/i, family: 'Quicksand', reason: 'rounded/soft classification' },
  // Split: a name saying "mono" wants a MONOSPACE face. The single old row sent
  // all of these to IBM Plex Sans — a proportional sans — so "Akkurat Mono"
  // rendered proportionally. "monospace" itself never arrives here (it is a
  // CSS generic, filtered by normalizeFontFamily), so it is not listed.
  { pattern: /courier|monaco|consolas|menlo|\bmono\b/i, family: 'IBM Plex Mono', reason: 'mono/monospace classification' },
  { pattern: /plex|technical/i, family: 'IBM Plex Sans', reason: 'plex/technical classification' },
  { pattern: /elegant|luxe|couture/i, family: 'Cormorant', reason: 'elegant/luxe classification' },
  { pattern: /slab/i, family: 'Zilla Slab', reason: 'slab classification' },
  // "Modern" as a classification = Didone (high-contrast serif). Word-boundary
  // so we do not steal longer tokens; "Self Modern" / "Modern" both match.
  { pattern: /didone|\bmodern\b/i, family: 'Playfair Display', reason: 'modern/didone classification' },
];

// Faces that must not land on body copy (legibility). Applied only when
// role === 'body'; foundry/classification non-regression tests use heading
// or null role so script→Great Vibes etc. stay unchanged.
const BODY_UNSAFE_FACES = new Set([
  'Anton', 'Bebas Neue', 'Great Vibes', 'Antonio',
  // Heavy / wide display
  'Archivo Black', 'Syne',
  // Didone + inscriptional display: high stroke contrast and tight apertures
  // that close up at caption sizes.
  'Prata', 'Italiana', 'DM Serif Display', 'Marcellus', 'Cinzel',
  // Scripts
  'Dancing Script', 'Pacifico', 'Caveat',
]);

// Serif faces in the curated library (must stay aligned with SERIF_HINTS /
// fallbackFor). Scripts are treated as serif-intent for the serif/sans
// constraint when one is the chosen face — the Great Vibes convention.
const LIBRARY_SERIF_FACES = new Set([
  'Playfair Display', 'Lora', 'Cormorant', 'Cormorant Garamond', 'Great Vibes',
  'Zilla Slab', 'Arvo', 'Josefin Slab',
  'Source Serif 4', 'Merriweather', 'Spectral', 'EB Garamond', 'Fraunces',
  'Prata', 'Italiana', 'DM Serif Display', 'Marcellus', 'Cinzel',
  'Dancing Script', 'Pacifico', 'Caveat',
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
  // The CHOSEN face is a better signal than the requested name's serif
  // heuristic, and it decides the replacement's class. `intent` comes from
  // fallbackFor(requestedFamily), which reads a *name*: "Domaine Display" has no
  // serif token, so intent is sans — yet the name table deliberately resolved it
  // to Prata, a didone. Keying the remap on intent alone swapped a requested
  // serif voice for a grotesk. Before the library expansion this was invisible
  // (Domaine → Playfair, which is body-safe, so no remap ran at all); adding
  // body-unsafe serifs made it reachable.
  if (intent === 'serif' || LIBRARY_SERIF_FACES.has(family)) {
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
async function resolveFamily(family, { brand = null, weight = 400, role = null, quiet = false } = {}) {
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
    // `quiet` is passed by a caller that may REJECT this substitution (an
    // exact-only ladder tier). Without it the log claimed "using closest library
    // face 'Inter'" for a font that never reached the render — the tier was
    // discarded and a lower tier resolved exactly. A log that names the wrong
    // font is worse than no log; the winning face is reported by the caller.
    if (!quiet) {
      console.warn(
        `🔤 fontResolver: '${family}' unavailable — using closest library face ` +
        `'${library.family}' (${library.matchReason}) for brand ${brand?.name || '?'}`
      );
    }
    return library;
  }

  console.warn(`🔤 fontResolver: '${family}' unavailable and library match failed for brand ${brand?.name || '?'}`);
  return null;
}

/**
 * Build the per-role candidate ladders for a brand. PURE — no network, no fs,
 * no Mongoose. Split out of resolveBrandFonts so the tier ORDER (the part that
 * decides whether a brand renders in its real typeface) is unit-testable
 * offline; resolveBrandFonts itself cannot be, because resolving a family
 * reaches Google Fonts.
 * Returns { ladders, wanted, weights }; each ladder entry is
 * [familyOrNull, requireExact].
 */
function buildFontLadders(brand, { overrides = {}, layoutInputBrand = null } = {}) {
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

  // WHEN THE CURATED THEME ALREADY NAMES THE SCRAPED FACE, THE THEME IS A
  // PAIRING AND MUST BE LEFT ALONE.
  //
  // Adversarial review killed the naive version of the promotion below with
  // Camelback: {fontFamily:'Lora', theme.sans:'DM Sans', theme.serif:'Lora'}.
  // Lora IS a real Google family, so an unconditional promotion resolved
  // heading, body AND quote to Lora and collapsed a deliberate sans/serif
  // pairing into one serif. Pelagic is the case the owner actually reported:
  // {fontFamily:'Oswald', theme.sans:'Montserrat'} — the theme names a face the
  // brand does not use anywhere, i.e. a generic guess that contradicts the scan.
  //
  // The rule that separates them without a special case: promote the scraped
  // face over the theme only when the theme does not already use it in SOME
  // role. Theme mentions it -> the curated pairing already accounts for the real
  // face, respect it. Theme contradicts the scan entirely -> the scan wins.
  const themeFamilies = [themeHeading, themeBody, themeQuote]
    .map(normalizeFontFamily).filter(Boolean).map(familyKey);
  const scannedPromoted = scannedFamily && !themeFamilies.includes(familyKey(scannedFamily))
    ? scannedFamily
    : null;

  // FONTS IDENTIFIED IN THE BRAND'S OWN META ADS (metaAdsFontService).
  //
  // This is a NAME a vision model read off a raster creative, never a file, so
  // it enters at two different strengths:
  //   · HIGH confidence → an exact-only tier just under the scraped face. The
  //     ads are the brand's own published work, so a confidently-named face we
  //     can actually serve is the brand's real typeface — the same reasoning
  //     that promotes the scraped family. Still exact-only: if the name only
  //     reaches a library substitution it is a guess about a guess and loses to
  //     a curated theme.
  //   · ANY confidence → a substitutable tier below website usage, where it is
  //     better than nothing but cannot displace a curated choice.
  // Both are subject to the same theme-pairing guard as scannedPromoted: if the
  // curated theme already names this face, the pairing already accounts for it.
  const metaUsage = brand?.metaAdsFontUsage || {};
  const metaFace = (role) => {
    const face = metaUsage[role] || null;
    const family = normalizeFontFamily(face?.family);
    if (!family || themeFamilies.includes(familyKey(family))) return { exactOnly: null, weak: null };
    // Trust the flag the identification service computed; fall back to reading
    // the confidence directly for documents written before it existed.
    const high = face.usableForExact === true || String(face.confidence).toLowerCase() === 'high';
    return { exactOnly: high ? family : null, weak: family };
  };
  const metaHeading = metaFace('heading');
  const metaBody = metaFace('body');

  // AN ORDERED LADDER OF CANDIDATES, NOT ONE PRE-PICKED WINNER.
  //
  // This used to collapse the whole cascade to a single family and then fall
  // straight to the role default if that family could not be resolved — so a
  // tier could win the cascade and still render nothing of what it named. That
  // is how the owner's font regression happened: Pelagic's scraped face is
  // "Oswald", a REAL Google family we can serve exactly, but the curated
  // styleTheme alias ("Montserrat") sat above it and won outright. Owner, on the
  // 17-ad sample: *"for pelagic, the before looked better in terms of font
  // style."* The before was Oswald.
  //
  // The fix is not simply "scanned first" — that would break the licence-hold
  // case in the other direction (AllBirds' real face is "Self Modern"; with the
  // file held back there is nothing to serve, and the curated "DM Sans" is the
  // right answer). So the bare scraped family carries `requireExact`: it wins
  // only when it resolves to an ACTUAL FILE — a custom ingested font or a real
  // Google family — and otherwise yields to the theme. A tone-based library
  // substitution is not the brand's face and must not outrank a curated choice.
  // Every other tier keeps today's behaviour and accepts a substitution.
  //
  // Order per role: explicit override → the brand's own ingested face (licence
  // respected) → an operator-curated fontFamily → the scraped face IF exactly
  // resolvable → curated theme → tailwind → website usage → shared family.
  //
  // TIER ORDER IS LOAD-BEARING AND TWO REVIEWERS BROKE THE FIRST DRAFT OF IT.
  // The curated-fontFamily tier stays BELOW the theme, exactly where the old
  // cascade had it: an operator-confirmed family that we cannot actually serve
  // must yield to a curated theme family we CAN serve, not lock a lookalike.
  // (Shape that proved it: curatedFields ['fontFamily','styleTheme'] +
  // fontFamily 'Self Modern' never ingested + theme.sans 'DM Sans' — promoting
  // the curated tier renders library Playfair instead of real DM Sans.) The only
  // tier this change ADDS above the theme is scannedPromoted, and it is
  // exact-only.
  // ownFace is exact-only too: we only claim it because matchCustomFont found a
  // usable file, so if that file will not actually load, a curated theme beats a
  // tone-matched guess.
  const ladders = {
    heading: [
      [overrides.heading?.family, false],
      [ownFace, true],
      [scannedPromoted, true],
      [metaHeading.exactOnly, true],
      [themeHeading, false],
      [fontIsCurated ? scanned : null, false],
      [tailwind?.fonts?.heading, false],
      [websiteUsage.heading, false],
      [metaHeading.weak, false],
      [sharedFamily, false],
    ],
    body: [
      [overrides.body?.family, false],
      [ownFace, true],
      [scannedPromoted, true],
      [metaBody.exactOnly, true],
      [themeBody, false],
      [fontIsCurated ? scanned : null, false],
      [tailwind?.fonts?.body, false],
      [websiteUsage.body, false],
      [metaBody.weak, false],
      [sharedFamily, false],
    ],
    // Quote keeps theme priority: serifFontFamily is a deliberate pairing choice
    // (it is why AllBirds' Lora held steady), and a sans brand face must not
    // silently replace a curated serif quote voice.
    quote: [
      [overrides.quote?.family, false],
      [themeQuote, false],
      [websiteUsage.quote, false],
      [sharedFamily, false],
    ],
  };
  // Kept for diagnostics and for the requestedFamily field: the family the old
  // single-winner cascade would have named, i.e. the first live tier.
  const wanted = {};
  for (const role of ['heading', 'body', 'quote']) {
    const first = ladders[role].map(([f]) => normalizeFontFamily(f)).find(Boolean);
    wanted[role] = first || DEFAULT_ROLE_FONTS[role].family;
  }
  const weights = {
    heading: overrides.heading?.weight || 700,
    body: overrides.body?.weight || 500,
    quote: overrides.quote?.weight || 400,
  };

  return { ladders, wanted, weights };
}

/**
 * Walk one ladder and return the winning candidate. `resolveOne(family,
 * requireExact)` resolves a single family (injected so this is testable without
 * network). Bounded by the ladder length — it cannot re-enter.
 *
 * A `requireExact` tier that only produces a library SUBSTITUTION is rejected
 * and remembered: the substitution is not the brand's face, so a lower tier
 * that can be served exactly (or one allowed to substitute) speaks first. If no
 * tier resolves at all, the remembered substitution is the answer — which is
 * what the old single-winner cascade would have rendered.
 *
 * Cost note: the Google and custom lookups inside resolveFamily memoise per
 * family|weight, but the library-substitution step does NOT, which is why the
 * local `tried` map exists — a family named by two tiers costs one resolve.
 */
async function resolveLadder(ladder, resolveOne) {
  let entry = null;
  let firstInexact = null;
  const tried = new Map();
  for (const [rawFamily, requireExact] of ladder) {
    const family = normalizeFontFamily(rawFamily);
    if (!family) continue;
    let candidate;
    if (tried.has(family)) candidate = tried.get(family);
    else {
      candidate = await resolveOne(family, requireExact);
      tried.set(family, candidate);
    }
    if (!candidate) continue;
    if (candidate.exact === false) {
      if (!firstInexact) firstInexact = candidate;
      if (requireExact) continue;
    }
    entry = candidate;
    break;
  }
  return { entry: entry || firstInexact, firstInexact };
}

/**
 * Resolve the three role fonts for a brand.
 * `overrides` comes from spec.tokenOverrides.fonts ({ heading: {family, weight}, ... }).
 * Returns { heading, body, quote } each { family, weight, style, url|null, fallback, source }.
 * `url` is a LOCAL FILE PATH here; remotionRenderService swaps it for an
 * asset-server URL before it reaches the browser.
 */
async function resolveBrandFonts(brand, { overrides = {}, layoutInputBrand = null } = {}) {
  const { ladders, wanted, weights } = buildFontLadders(brand, { overrides, layoutInputBrand });

  const out = {};
  for (const role of ['heading', 'body', 'quote']) {
    const def = DEFAULT_ROLE_FONTS[role];
    const walked = await resolveLadder(ladders[role], (family, requireExact) =>
      resolveFamily(family, { brand, weight: weights[role], role, quiet: requireExact })
    );
    let entry = walked.entry;
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
  buildFontLadders,
  resolveLadder,
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
