// Ingests a brand website's ACTUAL font files so the Remotion titling
// engine can render with them (consumed by fontResolverService via
// Brand.customFonts → matchCustomFont).
//
// Pipeline: fetch homepage HTML → collect stylesheets (<link rel=stylesheet>,
// inline <style>, Google css2 links) → parse @font-face rules (css-tree,
// regex fallback for malformed sheets) → classify each face's license by
// host → mirror ingestable files onto Cloudinary (resource_type 'raw').
//
// License policy — the whole point of this service vs. "just hotlink it":
//   · fonts.gstatic.com / fonts.googleapis.com   → 'google'   (ingest)
//   · known commercial foundry/webfont CDNs      → 'commercial'
//     Classification is ALWAYS recorded as license:'commercial' (audit).
//     Download/use is gated by BRAND_FONT_ASSUME_LICENSED (default true —
//     owner posture: advertiser's typeface in advertiser's own ads):
//       true  → attempt mirror like any other face; success → url set,
//               needsLicense:false; failure → flagged url:null (non-fatal,
//               library-match fallback still works).
//       false → never download; flagged with url:null + needsLicense:true.
//   · self-hosted / generic CDN                  → 'open' when the URL
//     hints OFL, else 'unknown' — still ingested (the brand already serves
//     the file publicly on its own storefront) but the license is recorded
//     so downstream UI can surface it.
//
// NO mongoose writes here — pure function of (brand) → entries; the calling
// route persists onto Brand.customFonts. Every network fetch uses a modern
// Chrome UA: Google css2 sniffs UA and only returns woff2 sources to
// browsers it recognizes, and brand CDNs (Shopify etc.) bot-block plain
// clients.

'use strict';

const axios = require('axios');
const csstree = require('css-tree');

// Required as a namespace (not destructured) so tests can monkey-patch
// uploadBufferToCloudinary without hitting the real Cloudinary API.
const cloudinaryService = require('./cloudinaryService');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MAX_STYLESHEETS = 12;   // fetch cap — big themes ship dozens of sheets
// Face mirror budgets — commercial is SEPARATE so a Typekit kit cannot
// starve open/Google/self-hosted faces of their full open budget.
//   open / google / unknown  → MAX_INGESTED_FACES (12)
//   commercial               → MAX_COMMERCIAL_FACES (6)
// Total mirrored can be up to 18 when both classes are present.
const MAX_INGESTED_FACES = 12;   // open / google / self-hosted (unknown) budget
const MAX_COMMERCIAL_FACES = 6;  // commercial-CDN budget (independent)
const MIN_FONT_BYTES = 1024;             // smaller = error page / tracking pixel
const MAX_FONT_BYTES = 5 * 1024 * 1024;  // larger = CJK mega-font, not worth mirroring
const MAX_HTML_BYTES = 6 * 1024 * 1024;

// Font file magic (first 4 bytes). Anything else is an interstitial / HTML
// challenge / error page that foundry CDNs sometimes return as HTTP 200.
const FONT_MAGIC_SIGNATURES = [
  Buffer.from('wOFF'),                   // woff
  Buffer.from('wOF2'),                   // woff2
  Buffer.from('OTTO'),                   // otf (CFF OpenType)
  Buffer.from([0x00, 0x01, 0x00, 0x00]), // ttf / TrueType sfnt
  Buffer.from('ttcf'),                   // TrueType / OpenType collection
];

const GOOGLE_FONT_HOSTS = ['fonts.gstatic.com', 'fonts.googleapis.com'];

// Hostname substrings of commercial foundries / licensed-webfont CDNs.
// Faces served from these are licensed to the BRAND, not to us — we flag
// instead of download. Substring match (not exact) because these foundries
// serve from rotating subdomains (use.typekit.net, p.typekit.net, ...).
const COMMERCIAL_FOUNDRY_HOSTS = [
  'use.typekit.net',
  'p.typekit.net',
  'fonts.adobe.com',
  'cloud.typography.com',
  'fast.fonts.net',
  'hellofont',
  'myfonts',
  'fontspring',
  'hoefler',
  'klim',
  'commercialtype',
  'lineto',
  'dinamo',
  'grillitype',
  'pangrampangram'
];

// Rare but real: self-hosted paths like /fonts/ofl/… or …-OFL.woff2 signal
// an SIL Open Font License copy.
const OPEN_LICENSE_HINT = /(^|[/_.-])(ofl|sil-?ofl|open-?font-?license)([/_.-]|$)/i;

const FORMAT_RANK = { woff2: 4, woff: 3, ttf: 2, otf: 1 };

// ── License classification ─────────────────────────────────────────────

/**
 * Owner-accepted licensing posture (BRAND_FONT_ASSUME_LICENSED, default true):
 * attempt commercial-CDN downloads and treat successful mirrors as usable.
 * Read at call time so tests / ops can flip without reloading the module.
 * Classification is independent — this flag never rewrites license labels.
 */
function brandFontAssumeLicensed() {
  return String(process.env.BRAND_FONT_ASSUME_LICENSED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Classify a font file / CSS URL by host → 'google' | 'commercial' |
 * 'open' | 'unknown'. 'unknown' is still ingestable (self-hosted file the
 * brand serves publicly). 'commercial' is always labeled commercial; whether
 * we attempt a download is governed by brandFontAssumeLicensed().
 */
function classifyFontSource(url) {
  let host, pathname;
  try {
    const u = new URL(String(url || ''));
    host = u.hostname.toLowerCase();
    pathname = u.pathname;
  } catch {
    return 'unknown';
  }
  if (GOOGLE_FONT_HOSTS.includes(host)) return 'google';
  if (COMMERCIAL_FOUNDRY_HOSTS.some((h) => host.includes(h))) return 'commercial';
  if (OPEN_LICENSE_HINT.test(pathname)) return 'open';
  return 'unknown';
}

/**
 * Distinct failure class for ops logs — foundry CDNs commonly 403/obfuscate.
 * Never throws; pure of (err).
 */
function downloadFailureClass(err) {
  const status = err && err.response && err.response.status;
  if (status === 403) return 'http-403';
  if (status === 404) return 'http-404';
  if (status === 401) return 'http-401';
  if (Number.isFinite(status)) return `http-${status}`;
  const msg = String((err && err.message) || err || '');
  if (/timeout|ETIMEDOUT|ECONNABORTED|ESOCKETTIMEDOUT/i.test(msg)) return 'timeout';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(msg)) return 'network';
  if (/not-a-font/i.test(msg)) return 'not-a-font';
  if (/too small|error page/i.test(msg)) return 'payload-invalid';
  if (/too large/i.test(msg)) return 'payload-too-large';
  if (/parse|unexpected/i.test(msg)) return 'parse';
  return 'download-error';
}

/**
 * True when buf starts with a known font magic (woff / woff2 / otf / ttf / ttc).
 * Pure of (buf). Used before treating any download as a usable face.
 */
function isFontMagic(buf) {
  if (!buf || buf.length < 4) return false;
  const head = Buffer.isBuffer(buf) ? buf.subarray(0, 4) : Buffer.from(buf).subarray(0, 4);
  return FONT_MAGIC_SIGNATURES.some((sig) => head.equals(sig));
}

/**
 * Whether another face of this license class may still be mirrored.
 * Commercial and open/google/unknown budgets are independent — a Typekit
 * kit filling commercial slots must not consume the open budget.
 * Pure of (license, counts). Drive this from tests; do not re-implement.
 *
 * @param {string} license  'commercial' | 'google' | 'open' | 'unknown'
 * @param {{ open?: number, commercial?: number }} counts  successes so far
 */
function canMirrorFace(license, counts = {}) {
  if (license === 'commercial') {
    return (counts.commercial || 0) < MAX_COMMERCIAL_FACES;
  }
  return (counts.open || 0) < MAX_INGESTED_FACES;
}

/** Bump the class counter after a successful mirror. Mutates counts. */
function bumpMirrorCount(license, counts) {
  if (license === 'commercial') counts.commercial = (counts.commercial || 0) + 1;
  else counts.open = (counts.open || 0) + 1;
  return counts;
}

// ── @font-face parsing ─────────────────────────────────────────────────

// url(...) with optional quotes + optional format(...) hint. Handles both
// `url('/f.woff2') format('woff2')` and Google's unquoted `url(https://…)`.
const SRC_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/gi;

function normalizeFormat(hint, url) {
  // 'woff2-variations' (legacy variable-font syntax) → 'woff2'
  const h = String(hint || '').toLowerCase().trim().replace(/-variations$/, '');
  if (h === 'woff2') return 'woff2';
  if (h === 'woff') return 'woff';
  if (h === 'truetype' || h === 'ttf') return 'ttf';
  if (h === 'opentype' || h === 'otf') return 'otf';
  if (h) return null; // eot / svg / embedded-opentype — unusable in Remotion
  const m = String(url || '').match(/\.(woff2|woff|ttf|otf)([?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

// font-weight → number. Keywords map to their numeric equivalents;
// variable-font ranges ("100 900") clamp 400 into the range — the file
// serves every weight, so labeling it by the lower bound (100) would make
// the resolver register a hairline face for body text.
function parseWeight(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'normal') return 400;
  if (v === 'bold') return 700;
  const range = v.match(/(\d{2,4})\s+(\d{2,4})/);
  if (range) {
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[2], 10);
    return Math.min(Math.max(400, lo), hi);
  }
  const m = v.match(/\d{2,4}/);
  return m ? parseInt(m[0], 10) : 400;
}

function parseWeightRange(raw) {
  const range = String(raw || '').trim().match(/(\d{2,4})\s+(\d{2,4})/);
  if (!range) return { weightMin: null, weightMax: null };
  return { weightMin: parseInt(range[1], 10), weightMax: parseInt(range[2], 10) };
}

function cleanFamily(raw) {
  if (!raw) return null;
  const fam = String(raw).split(',')[0].trim().replace(/^['"]+|['"]+$/g, '').trim();
  return fam || null;
}

// Does this face's unicode-range cover basic latin (U+0041 'A')? Google
// css2 emits one @font-face PER SUBSET (cyrillic, greek, latin, ...) for
// the same family/weight/style — without this check, first-wins dedupe
// could keep a cyrillic-only file that renders tofu for English copy.
function coversBasicLatin(unicodeRange) {
  if (!unicodeRange) return true; // no range declared = full font
  for (const seg of String(unicodeRange).toLowerCase().split(',')) {
    const m = seg.trim().match(/^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/);
    if (!m) continue;
    let lo, hi;
    if (m[1].includes('?')) {
      lo = parseInt(m[1].replace(/\?/g, '0'), 16);
      hi = parseInt(m[1].replace(/\?/g, 'f'), 16);
    } else {
      lo = parseInt(m[1], 16);
      hi = m[2] ? parseInt(m[2], 16) : lo;
    }
    if (lo <= 0x41 && 0x41 <= hi) return true;
  }
  return false;
}

// Shared by the css-tree and regex extractors: raw declaration strings →
// one face { family, weight, style, format, url, unicodeRange } picking
// the best src by format rank (woff2 > woff > ttf > otf). Returns null
// when the block has no family or no usable src (data: URIs, eot-only).
function buildFace({ family, weight, style, src, unicodeRange }, baseUrl) {
  const fam = cleanFamily(family);
  if (!fam || !src) return null;

  const candidates = [];
  SRC_URL_RE.lastIndex = 0;
  let m;
  while ((m = SRC_URL_RE.exec(src)) !== null) {
    const rawUrl = m[2].trim();
    if (/^data:/i.test(rawUrl)) continue; // inlined base64 — skip, not worth mirroring
    const format = normalizeFormat(m[4], rawUrl);
    if (!format) continue;
    let abs;
    try {
      abs = new URL(rawUrl, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    candidates.push({ url: abs, format });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => FORMAT_RANK[b.format] - FORMAT_RANK[a.format]);

  const range = parseWeightRange(weight);
  return {
    family: fam,
    weight: parseWeight(weight),
    ...range,
    style: /italic|oblique/i.test(String(style || '')) ? 'italic' : 'normal',
    format: candidates[0].format,
    url: candidates[0].url,
    unicodeRange: unicodeRange ? String(unicodeRange).trim() : null
  };
}

// Last-resort extractor for sheets css-tree refuses to parse. @font-face
// blocks never nest, so a flat brace match is safe here.
function regexExtractFontFaces(cssText, baseUrl) {
  const faces = [];
  const blockRe = /@font-face\s*\{([^}]*)\}/gi;
  let m;
  while ((m = blockRe.exec(cssText)) !== null) {
    const body = m[1];
    const get = (prop) => {
      const pm = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'i'));
      return pm ? pm[1].trim() : null;
    };
    const face = buildFace(
      {
        family: get('font-family'),
        weight: get('font-weight'),
        style: get('font-style'),
        src: get('src'),
        unicodeRange: get('unicode-range')
      },
      baseUrl
    );
    if (face) faces.push(face);
  }
  return faces;
}

/**
 * Parse all @font-face rules out of a stylesheet. css-tree first (tolerant,
 * spec-correct), regex extraction as fallback — one malformed sheet must
 * never sink the whole ingest. The fallback engages when css-tree throws
 * OR when its error-tolerant parser swallowed the rules into Raw nodes
 * (v3 rarely throws — mismatched braces make @font-face blocks vanish
 * silently instead).
 *
 * @param {string} cssText
 * @param {string} baseUrl  URL the stylesheet was fetched from (or the page
 *                          URL for inline <style>) — relative src url()s
 *                          resolve against it.
 * @returns {Array<{family, weight, style, format, url, unicodeRange}>}
 */
function parseFontFacesFromCss(cssText, baseUrl) {
  const css = String(cssText || '');
  if (!css.includes('@font-face')) return [];

  let ast;
  try {
    // parseValue:false keeps declaration values as Raw strings — we only
    // need text for the handful of font-face descriptors, and Raw survives
    // vendor junk that the full value grammar can choke on.
    ast = csstree.parse(css, {
      parseValue: false,
      parseAtrulePrelude: false,
      parseCustomProperty: false
    });
  } catch {
    return regexExtractFontFaces(css, baseUrl);
  }

  const faces = [];
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if (String(node.name).toLowerCase() !== 'font-face' || !node.block) return;
      const props = {};
      node.block.children.forEach((child) => {
        if (child.type !== 'Declaration') return;
        props[String(child.property).toLowerCase()] =
          child.value && child.value.type === 'Raw'
            ? child.value.value
            : child.value
              ? csstree.generate(child.value)
              : '';
      });
      const face = buildFace(
        {
          family: props['font-family'],
          weight: props['font-weight'],
          style: props['font-style'],
          src: props['src'],
          unicodeRange: props['unicode-range']
        },
        baseUrl
      );
      if (face) faces.push(face);
    }
  });
  // Zero faces from a sheet that clearly declares them = the tolerant
  // parser ate them (Raw recovery). Worst case the regex also picks up a
  // commented-out block — harmless next to losing a brand's whole kit.
  return faces.length ? faces : regexExtractFontFaces(css, baseUrl);
}

// ── Website role usage ─────────────────────────────────────────────────

// The generic-family vocabulary is shared with services/fontClassification.js
// so the parser that CAPTURES generics and the classifier that CONSUMES them
// cannot drift apart on which tokens count as generic.
const {
  GENERIC_FAMILIES, CSS_WIDE_KEYWORDS, classFromGeneric, normalizeFamilyKey,
} = require('./fontClassification');

// Substitution passes for nested custom properties. Themes chain them two or
// three deep (`--font-heading: var(--font-serif)`); the cap is a cycle guard
// (`--a: var(--b); --b: var(--a)`) far above any real depth.
const MAX_VAR_DEPTH = 8;
// Matches ONE var() whose fallback contains no further parens — i.e. always an
// innermost reference — so repeated passes resolve nesting from the inside out.
const INNERMOST_VAR_RE = /var\(\s*(--[a-z0-9_-]+)\s*(?:,\s*([^()]*?)\s*)?\)/i;

/**
 * Resolve every var() in a declaration value against the collected custom
 * properties, innermost first, falling back to the reference's own default.
 *
 * The previous implementation only handled a var() at the START of the value
 * and REPLACED THE WHOLE VALUE with the variable's contents, which silently
 * dropped everything after the reference. That broke the single most common
 * shape in the wild — Shopify's Dawn theme and its derivatives write
 * `font-family: var(--font-heading-family), serif`, so the trailing generic
 * (the entire signal this module exists to capture) was discarded on exactly
 * the storefronts we care most about. It also could not see through a chained
 * variable, leaving a literal `var(--font-serif)` stored as a family name.
 */
function resolveCssVars(value, variables) {
  let out = String(value);
  for (let depth = 0; depth < MAX_VAR_DEPTH && INNERMOST_VAR_RE.test(out); depth++) {
    out = out.replace(new RegExp(INNERMOST_VAR_RE, 'gi'), (_m, name, fallback) => {
      const resolved = variables[name];
      if (resolved != null && String(resolved).trim() !== '') return String(resolved);
      return fallback == null ? '' : fallback;
    });
  }
  // An unresolvable reference is left as-is above; drop it so it can never be
  // mistaken for a concrete family name (observed live as a stored family of
  // "var(--font-sans)").
  return out.replace(new RegExp(INNERMOST_VAR_RE, 'gi'), '');
}

/**
 * Split a font-family declaration value into trimmed, unquoted tokens, with
 * custom properties resolved and the CSS priority flag removed.
 *
 * `!important` is stripped AFTER substitution, not before: a custom property
 * can carry the flag in its own value (`--font-heading: Brand, serif
 * !important`), and stripping only the raw declaration left the resolved last
 * token as the string "serif !important", which matches no known generic. That
 * silently dropped the classification on exactly the declarations a theme
 * marks as authoritative.
 */
function familyStackTokens(raw, variables = {}) {
  if (!raw) return [];
  const value = resolveCssVars(String(raw), variables)
    .replace(/!\s*important\s*$/i, '')
    .trim();
  return value.split(',')
    .map((part) => part.trim().replace(/^['"]+|['"]+$/g, '').replace(/!\s*important\s*$/i, '').trim())
    .filter(Boolean);
}

// Names that sit in a font-family stack but can never be a BRAND's typeface:
// the system-UI aliases, and the emoji/symbol faces every modern reset appends
// after the real stack (`ui-sans-serif, system-ui, sans-serif, "Apple Color
// Emoji", "Segoe UI Emoji", …`).
//
// This matters because such a stack's only NON-generic entries are those emoji
// fonts. Once custom properties resolve properly, a rule set to the system
// stack yields "Apple Color Emoji" as its first concrete family — which is
// worse than the unresolved `var(--font-sans)` it used to yield, because it is
// PLAUSIBLE junk: it would be stored as the brand's body face and could be
// named to an image model as the brand's own typeface. A system stack means
// "no brand face is declared here", so it must yield nothing.
const NON_BRAND_FAMILIES = new Set([
  '-apple-system', 'blinkmacsystemfont', 'apple color emoji', 'segoe ui emoji',
  'segoe ui symbol', 'noto color emoji', 'android emoji', 'emojisymbols',
  'apple symbols', 'noto emoji', 'twemoji mozilla',
]);

function firstConcreteFamily(raw, variables = {}) {
  for (const family of familyStackTokens(raw, variables)) {
    const lower = family.toLowerCase();
    if (GENERIC_FAMILIES.has(lower) || NON_BRAND_FAMILIES.has(lower)) continue;
    return family;
  }
  return null;
}

/**
 * The CSS generic the site author put in the SAME declaration as the concrete
 * family — i.e. their own classification of their own typeface.
 *
 * This is the signal that fixes the Marine Layer 2 defect: the site ships
 * `font-family: Seriously Nostalgic, serif`, so the brand itself tells us the
 * face is a serif even though the NAME matches no serif keyword and the font
 * file's OS/2 panose is all-zeros. See services/fontClassification.js for the
 * measurements that ruled out both of those alternatives.
 *
 * CSS-wide keywords (`inherit`/`initial`/`unset`) are skipped: they sit in
 * generic position but carry no typographic meaning.
 */
function genericFamilyIn(raw, variables = {}) {
  const tokens = familyStackTokens(raw, variables);
  const firstConcrete = tokens.findIndex((t) => !GENERIC_FAMILIES.has(t.toLowerCase()));
  // Only tokens AFTER the first concrete family are that family's fallbacks.
  // A stack may legally open with a generic (`sans-serif, "Brand", serif`);
  // taking the first generic anywhere would classify that Didone as sans from
  // a token that is not its fallback at all.
  const candidates = (firstConcrete === -1 ? tokens : tokens.slice(firstConcrete + 1))
    .map((t) => t.toLowerCase())
    .filter((t) => GENERIC_FAMILIES.has(t) && !CSS_WIDE_KEYWORDS.has(t));
  if (!candidates.length) return null;
  // A font-family stack is ordered most-preferred first, so the LAST generic is
  // the author's ultimate fallback and the truest statement of the class. Take
  // the last one that actually carries a serif/sans signal: in
  // `Brand Serif, monospace, serif` the terminal `serif` is the classification,
  // while `monospace` is a mid-stack preference on an orthogonal axis and would
  // otherwise return a null signal and lose the answer.
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (classFromGeneric(candidates[i])) return candidates[i];
  }
  // No token carries a serif/sans signal (e.g. `Brand, monospace`). Record the
  // terminal generic faithfully anyway; classifyTypeface reads it as "no
  // signal" and falls through, and a truthful stored value beats a null.
  return candidates[candidates.length - 1];
}

/**
 * Best-effort extraction of the font families the storefront actually
 * assigns to headings, body copy and buttons. This is intentionally
 * evidence, not computed-style truth: the resolver still validates the
 * family against an ingested website face or Google Fonts before use.
 */
function extractFontUsageFromCss(cssText) {
  const css = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const variables = {};
  for (const m of css.matchAll(/(--[a-z0-9_-]+)\s*:\s*([^;}{]+)/gi)) {
    variables[m[1]] = m[2].trim();
  }

  const evidence = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css)) !== null) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    const declaration = match[2];
    const familyMatch = declaration.match(/font-family\s*:\s*([^;}]+)/i);
    if (!familyMatch) continue;
    const family = firstConcreteFamily(familyMatch[1], variables);
    if (!family) continue;
    const generic = genericFamilyIn(familyMatch[1], variables);

    let role = null;
    let score = 1;
    const selectorKey = selector.toLowerCase();
    if (/(^|[^a-z0-9])(h[1-6]|heading|headline|hero-title|display-title)([^a-z0-9]|$)/.test(selectorKey)) {
      role = 'heading'; score = 4;
    } else if (/(^|[^a-z0-9])(button|btn|cta|call-to-action)([^a-z0-9]|$)/.test(selectorKey)) {
      role = 'button'; score = 3;
    } else if (/(^|[^a-z0-9])(body|html|p|paragraph|copy|rich-text|rte)([^a-z0-9]|$)/.test(selectorKey)) {
      role = 'body'; score = 3;
    }
    if (!role) continue;
    evidence.push({ family, role, generic, selector: selector.slice(0, 180), score });
  }

  const pick = (role) => {
    const scores = new Map();
    for (const item of evidence.filter((e) => e.role === role)) {
      scores.set(item.family, (scores.get(item.family) || 0) + item.score);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };

  /**
   * The winning generic FOR THE FAMILY THAT WON THIS ROLE — not for the role
   * as a whole. That distinction is load-bearing, and was measured on Marine
   * Layer's live stylesheet: voting generics per-ROLE tallies serif 72 vs
   * sans-serif 72 (their heading rules name a serif display face 72 points'
   * worth, while a grotesque used on other heading selectors and a stale
   * `--font-heading` variable contribute 64 + 8 the other way) — an arbitrary,
   * rule-order-dependent tie. Scoped to the winning family it is serif 72 vs
   * sans-serif 8, a decisive 9:1.
   *
   * Ties within one family resolve to the FIRST generic reached in descending
   * score order, which `Map` insertion order makes deterministic for a given
   * stylesheet — the same determinism guarantee `pick` above relies on.
   */
  const pickGeneric = (role, family) => {
    if (!family) return null;
    // normalizeFamilyKey, not a bare toLowerCase: this must key the generic
    // under exactly the string fontClassification.storedGenericForFamily will
    // later look it up by, or the vote lands somewhere the consumer never
    // reads (internal whitespace being the case that bites — see that
    // function's header).
    const want = normalizeFamilyKey(family);
    const scores = new Map();
    for (const item of evidence) {
      if (item.role !== role || !item.generic) continue;
      if (normalizeFamilyKey(item.family) !== want) continue;
      scores.set(item.generic, (scores.get(item.generic) || 0) + item.score);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };

  const heading = pick('heading');
  const body = pick('body');
  const button = pick('button');
  return {
    heading,
    body,
    button,
    // The site author's own serif/sans classification of each role's face.
    // Consumed via fontClassification.storedGenericForFamily, which only
    // trusts a role's generic for that role's own family.
    headingGeneric: pickGeneric('heading', heading),
    bodyGeneric: pickGeneric('body', body),
    buttonGeneric: pickGeneric('button', button),
    evidence: evidence.slice(0, 30)
  };
}

/**
 * Fetch every stylesheet a page references: inline <style> blocks first, then
 * up to MAX_STYLESHEETS external sheets, following bounded CSS @imports.
 *
 * Extracted from ingestBrandFontsInner so scripts/backfillBrandFontGenerics.js
 * can collect the SAME sheet set. That is not a tidiness refactor — the
 * backfill re-derives values it then persists, and its own hand-rolled fetch
 * loop did not follow @import. Themes routinely put typography in an imported
 * partial (this function's @import branch exists for exactly that), so the
 * backfill could vote on a strict subset of the evidence, write a generic that
 * disagrees with what ingest would compute, and — because it refuses to
 * overwrite an existing value — freeze that wrong answer permanently.
 *
 * One dead sheet is an errors[] line, never a hard failure.
 *
 * @param {string} html     the page's HTML
 * @param {string} pageUrl  the POST-redirect URL, for resolving relative hrefs
 * @returns {Promise<{sheets: Array<{css,baseUrl,from}>, errors: string[]}>}
 */
async function collectStylesheets(html, pageUrl) {
  const errors = [];
  const sheets = extractInlineStyles(html)
    .map((css) => ({ css, baseUrl: pageUrl, from: 'inline <style>' }));
  const sheetUrls = extractStylesheetUrls(html, pageUrl);
  const seenSheetUrls = new Set(sheetUrls);
  for (const href of sheetUrls) {
    try {
      const res = await axios.get(href, {
        timeout: 20_000,
        maxRedirects: 5,
        maxContentLength: MAX_HTML_BYTES,
        responseType: 'text',
        // keep CSS as the raw string — axios would otherwise try JSON.parse
        transformResponse: [(d) => d],
        headers: { 'User-Agent': UA, Accept: 'text/css,*/*;q=0.1' }
      });
      const css = String(res.data || '');
      sheets.push({ css, baseUrl: href, from: href });
      // Follow bounded CSS @imports. Themes often put @font-face rules in
      // a typography partial rather than the homepage's first-level sheet.
      for (const m of css.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/gi)) {
        if (sheetUrls.length >= MAX_STYLESHEETS) break;
        try {
          const imported = new URL(m[1], href).toString();
          if (/^https?:/i.test(imported) && !seenSheetUrls.has(imported)) {
            seenSheetUrls.add(imported);
            sheetUrls.push(imported);
          }
        } catch { /* malformed import — skip */ }
      }
    } catch (err) {
      errors.push(`stylesheet fetch failed: ${href}: ${err.message}`);
    }
  }
  return { sheets, errors };
}

/**
 * Merge the font-usage evidence of MANY stylesheets into one scored answer.
 *
 * A storefront's typography is spread across an inline <style> block and
 * several external sheets, and each must be scored TOGETHER — a per-sheet
 * winner would let a small utility sheet outvote the theme. So the evidence
 * rows are re-serialised into one synthetic stylesheet and re-parsed, which
 * puts every sheet's rules in front of a single scorer.
 *
 * The generic MUST be re-emitted in that round-trip. Emitting only
 * `font-family:"Family"` silently discarded the first-party serif/sans signal
 * on every multi-sheet storefront — captured correctly per sheet, then thrown
 * away on the way to the vote.
 *
 * Extracted from ingestBrandFontsInner (which does network I/O and Cloudinary
 * uploads around it) so this step is reachable from an offline harness — a
 * revert-proof that has to re-implement the round-trip in order to test it is
 * only testing itself. Also reused by scripts/backfillBrandFontGenerics.js so
 * the backfill cannot drift from what ingest actually computes.
 *
 * @param {string[]} sheetCssTexts  raw CSS, one entry per sheet
 * @returns {{heading, body, button, headingGeneric, bodyGeneric, buttonGeneric, evidence}}
 */
function aggregateFontUsageAcrossSheets(sheetCssTexts) {
  const parts = (sheetCssTexts || []).map((css) => extractFontUsageFromCss(css));
  const evidence = parts.flatMap((u) => u.evidence || []);
  const usage = extractFontUsageFromCss(
    evidence
      .map((e) => `${e.selector}{font-family:"${e.family}"${e.generic ? `,${e.generic}` : ''}}`)
      .join('\n')
  );
  usage.evidence = evidence.slice(0, 30);
  return usage;
}

// ── HTML → stylesheet discovery ────────────────────────────────────────

function extractInlineStyles(html) {
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] && m[1].trim()) out.push(m[1]);
  }
  return out;
}

function extractStylesheetUrls(html, baseUrl) {
  const seen = new Set();
  const out = [];
  const push = (href) => {
    if (!href || out.length >= MAX_STYLESHEETS) return;
    let abs;
    try {
      abs = new URL(href.replace(/&amp;/gi, '&').trim(), baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };

  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const hrefM = tag.match(/href\s*=\s*["']([^"']+)["']/i) || tag.match(/href\s*=\s*([^\s>]+)/i);
    if (hrefM) push(hrefM[1]);
  }

  // Google css2 links also hide behind rel="preload" and JS font loaders —
  // sweep the raw HTML for any css/css2 URL so they aren't missed.
  const googleRe = /https:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s\\<>)]+/gi;
  while ((m = googleRe.exec(html)) !== null) push(m[0]);

  return out;
}

// First-wins dedupe on family+weight+style, with one exception: a face
// whose unicode-range covers basic latin replaces an earlier subset that
// doesn't (see coversBasicLatin — Google css2 subset ordering).
function dedupeFaces(faces) {
  const byKey = new Map();
  for (const face of faces) {
    const key = `${face.family.toLowerCase()}|${face.weight}|${face.style}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, face);
    } else if (!coversBasicLatin(prev.unicodeRange) && coversBasicLatin(face.unicodeRange)) {
      byKey.set(key, face);
    }
  }
  return [...byKey.values()];
}

// ── Download + mirror ──────────────────────────────────────────────────

async function downloadFontFile(url, { referer } = {}) {
  // Foundry CDNs often 403 without a browser-like Referer/Origin from the
  // brand site that embedded the kit. Best-effort only — failure is non-fatal.
  const headers = {
    'User-Agent': UA,
    Accept: 'font/woff2,font/woff,font/ttf,application/font-woff2,application/octet-stream,*/*;q=0.1',
  };
  if (referer) {
    headers.Referer = referer;
    try { headers.Origin = new URL(referer).origin; } catch { /* ignore */ }
  }
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    maxRedirects: 5,
    maxContentLength: MAX_FONT_BYTES,
    headers
  });
  const buf = Buffer.from(res.data);
  if (buf.length < MIN_FONT_BYTES) throw new Error(`font payload too small (${buf.length}B) — likely an error page`);
  if (buf.length > MAX_FONT_BYTES) throw new Error(`font payload too large (${buf.length}B)`);
  // Foundry CDNs sometimes 200 an HTML interstitial / bot challenge. Reject
  // anything that is not a real font container — same failure path as 403
  // (commercial → flagged needsLicense; open → errors[] only).
  if (!isFontMagic(buf)) {
    const magicHex = buf.subarray(0, 4).toString('hex');
    throw new Error(`font payload not-a-font (magic=0x${magicHex}, ${buf.length}B)`);
  }
  return buf;
}

function familySlug(family) {
  return String(family).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'font';
}

// ── Main ingest ────────────────────────────────────────────────────────

/**
 * Ingest a brand website's font files. Pure of (brand) — no mongoose
 * writes; the route persists the returned entries onto Brand.customFonts.
 *
 * @param {object} brand  needs .websiteUrl; ._id/.name used for public IDs + logs
 * @returns {Promise<{ingested: Array, flagged: Array, errors: string[]}>}
 *   Entry shape matches fontResolverService.matchCustomFont expectations:
 *   { family, weight, style, format, url (Cloudinary secure_url, null for
 *     flagged), sourceUrl, source:'website', license, needsLicense, ingestedAt }
 * @throws when brand.websiteUrl is missing or the homepage is unreachable
 */
async function ingestBrandFonts(brand, { trackProgress = true } = {}) {
  const t0 = Date.now();
  const { startRun, CancelledError } = require('./progressService');
  const run = trackProgress
    ? await startRun({ kind: 'font-ingest', advertiserId: brand.advertiserId, brandId: brand._id, label: 'Website font ingest' })
    : {
        stage() {},
        tick() {},
        async checkpoint() {},
        async succeed() {},
        async fail() {},
        async markCancelled() {}
      };
  try {
    const result = await ingestBrandFontsInner(brand, run);
    if (result.cancelled) {
      // Faces mirrored before the stop are in the result — the route
      // still merges them into brand.customFonts, so "partials kept"
      // holds. Don't succeed(): that would overwrite the cancelled row.
      await run.markCancelled(`Cancelled — ${result.ingested.length} mirrored face(s) kept`);
    } else {
      await run.succeed({ ingested: result.ingested?.length ?? 0, flagged: result.flagged?.length ?? 0 });
    }
    return result;
  } catch (err) {
    if (err instanceof CancelledError) {
      // Shouldn't happen (the inner loop breaks instead of throwing),
      // but if it does there are no partials to salvage from here.
      return { ingested: [], flagged: [], errors: ['cancelled by operator'], cancelled: true };
    }
    await run.fail(err);
    throw err;
  }
}

async function ingestBrandFontsInner(brand, run) {
  const t0 = Date.now();
  const websiteUrl = brand?.websiteUrl;
  if (!websiteUrl) throw new Error('brand font ingest: brand has no websiteUrl');
  const brandId = String(brand._id || brand.id || 'brand');
  const errors = [];

  // 1. Homepage HTML. Unreachable homepage = nothing to ingest — throw.
  let html;
  let pageUrl;
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 20_000,
      maxRedirects: 5,
      maxContentLength: MAX_HTML_BYTES,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
    });
    html = typeof res.data === 'string' ? res.data : String(res.data || '');
    // Relative stylesheet hrefs must resolve against the POST-redirect URL
    // (http→https, apex→www) or they 404.
    pageUrl = res.request?.res?.responseUrl || websiteUrl;
  } catch (err) {
    throw new Error(`brand font ingest: could not fetch ${websiteUrl}: ${err.message}`);
  }

  // 2. Collect CSS: inline <style> blocks + up to MAX_STYLESHEETS external
  // sheets. One dead sheet is an errors[] line, never a hard failure.
  const { sheets, errors: sheetErrors } = await collectStylesheets(html, pageUrl);
  errors.push(...sheetErrors);

  // 3. Parse @font-face rules, dedupe family+weight+style.
  let faces = [];
  for (const sheet of sheets) {
    try {
      faces.push(...parseFontFacesFromCss(sheet.css, sheet.baseUrl));
    } catch (err) {
      errors.push(`font-face parse failed (${sheet.from}): ${err.message}`);
    }
  }
  faces = dedupeFaces(faces);
  const usage = aggregateFontUsageAcrossSheets(sheets.map((sheet) => sheet.css));

  // 4–6. Classify, then mirror ingestable faces to Cloudinary.
  const ingested = [];
  const flagged = [];
  // Separate budgets: commercial cannot starve open/google/self-hosted.
  const mirrorCounts = { open: 0, commercial: 0 };
  let cancelled = false;
  run.stage('mirroring font faces');
  let faceIdx = 0;
  const { CancelledError } = require('./progressService');
  for (const face of faces) {
    // Break (don't throw) on cancel so faces already mirrored to
    // Cloudinary make it into the returned arrays — the route persists
    // them onto brand.customFonts, keeping the partial work.
    try { await run.checkpoint(); } catch (err) {
      if (err instanceof CancelledError) { cancelled = true; break; }
      throw err;
    }
    run.tick(++faceIdx, faces.length);
    const license = classifyFontSource(face.url);
    const entryBase = {
      family: face.family,
      weight: face.weight,
      weightMin: face.weightMin,
      weightMax: face.weightMax,
      style: face.style,
      format: face.format,
      sourceUrl: face.url,
      source: 'website',
      license,
      ingestedAt: new Date().toISOString()
    };

    // Flag OFF: commercial faces are never downloaded (legacy gate).
    // Flag ON: attempt download below; license stays 'commercial' for audit.
    if (license === 'commercial' && !brandFontAssumeLicensed()) {
      flagged.push({ ...entryBase, url: null, needsLicense: true });
      continue;
    }
    // Class-specific caps (see canMirrorFace / MAX_* constants above).
    if (!canMirrorFace(license, mirrorCounts)) continue;

    try {
      const buf = await downloadFontFile(face.url, { referer: pageUrl });
      // 'i' suffix keeps italic cuts from colliding with the roman at the
      // same weight; extension lives IN the public_id for raw resources so
      // the delivered URL keeps its .woff2/.ttf suffix.
      const styleSuffix = face.style === 'italic' ? 'i' : '';
      const uploaded = await cloudinaryService.uploadBufferToCloudinary(buf, {
        folder: 'liquidretail/brand_fonts',
        resourceType: 'raw',
        publicId: `${brandId}-${familySlug(face.family)}-${face.weight}${styleSuffix}.${face.format}`,
        // Re-ingest must refresh the mirror — the helper defaults to
        // overwrite:false, which silently returns the OLD asset forever.
        overwrite: true
      });
      // Success: real url, usable by matchCustomFont when flag is on.
      // needsLicense:false = machine cleared; human may still set true later.
      ingested.push({ ...entryBase, url: uploaded.secure_url, needsLicense: false });
      bumpMirrorCount(license, mirrorCounts);
    } catch (err) {
      const failClass = downloadFailureClass(err);
      const msg = `ingest failed for "${face.family}" ${face.weight} ${face.style} [${failClass}]: ${err.message}`;
      errors.push(msg);
      if (license === 'commercial') {
        // Never leave a half-written commercial entry — flag cleanly so
        // library-match fallback still runs. Distinct log for ops.
        console.warn(
          `🔤 brand font ingest: commercial CDN face not mirrored (${failClass}) ` +
          `"${face.family}" ${face.weight} ${face.style} from ${face.url}: ${err.message}`
        );
        flagged.push({ ...entryBase, url: null, needsLicense: true });
      }
    }
  }

  console.log(
    `🔤 brand font ingest for "${brand.name || brandId}": ${ingested.length} ingested, ${flagged.length} flagged commercial, ${errors.length} error(s) from ${sheets.length} sheet(s) (${faces.length} unique face(s)) in ${Date.now() - t0}ms${cancelled ? ' [cancelled]' : ''}` +
    ` [assumeLicensed=${brandFontAssumeLicensed()}]`
  );

  return { ingested, flagged, errors, cancelled, usage };
}

module.exports = {
  ingestBrandFonts,
  classifyFontSource,
  brandFontAssumeLicensed,
  downloadFailureClass,
  isFontMagic,
  canMirrorFace,
  bumpMirrorCount,
  MAX_INGESTED_FACES,
  MAX_COMMERCIAL_FACES,
  parseFontFacesFromCss,
  extractFontUsageFromCss,
  aggregateFontUsageAcrossSheets,
  collectStylesheets,
  familyStackTokens,
  genericFamilyIn,
  NON_BRAND_FAMILIES,
  // Exported for scripts/backfillBrandFontGenerics.js, which re-derives the
  // first-party generics for brands ingested before they were captured. It
  // reuses these PURE extractors (and UA/MAX_STYLESHEETS) rather than making
  // the ingest main loop reusable, deliberately: that loop also downloads and
  // re-uploads font files to Cloudinary, which a classification backfill must
  // never trigger.
  extractInlineStyles,
  extractStylesheetUrls,
  UA,
  MAX_STYLESHEETS
};
