// HTML-entity decoding for scraped text.
//
// WHY: `<script type="application/ld+json">` is a *raw text* element —
// the HTML parser does NOT decode character references inside it. Sites
// that HTML-escape their JSON-LD string values therefore ship entities
// straight through JSON.parse() into our fields:
//
//   Living Spaces PDP JSON-LD:
//     "name": "Austen Black 74&quot; Wide Wood TV Stand"
//     "name": "Table &#x2B; Buffet Lamps"
//   →  CatalogProduct.title = 'Austen Black 74&quot; Wide Wood TV Stand'
//
// Inch marks (33" → &quot; / &#34; / &#x22;), ampersands (&amp;), plus
// signs (&#x2B;), and curly quotes (&#x2019;) are the ones that show up
// most in furniture catalogs. Same applies to og:/meta `content`
// attributes, which are always entity-encoded by definition.
//
// decodeHtmlEntities does ONE pass — a decoded result is never rescanned,
// so a legitimately double-escaped "&amp;quot;" decodes to the literal
// "&quot;" (correct) instead of collapsing to '"' (wrong).
//
// Named references are matched case-sensitively (per HTML5) and a
// terminating semicolon is required; unknown references are left verbatim
// rather than dropped, so "Model &foo; 5" survives a round trip.

'use strict';

// Common named references. Deliberately not the full HTML5 table (~2200
// entries) — this is the set that appears in real product copy. Anything
// missing falls through untouched; add entries as new ones surface.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c',
  ndash: '–', mdash: '—', horbar: '―',
  lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„',
  prime: '′', Prime: '″',
  hellip: '…', middot: '·', bull: '•',
  dagger: '†', Dagger: '‡', permil: '‰',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  larr: '←', rarr: '→', harr: '↔',
  times: '×', divide: '÷', minus: '−', plusmn: '±',
  frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³',
  deg: '°', micro: 'µ', sect: '§', para: '¶',
  trade: '™', reg: '®', copy: '©',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  curren: '¤', iexcl: '¡', iquest: '¿',
  aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À',
  acirc: 'â', Acirc: 'Â', auml: 'ä', Auml: 'Ä',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ',
  ccedil: 'ç', Ccedil: 'Ç',
  eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È',
  ecirc: 'ê', Ecirc: 'Ê', euml: 'ë', Euml: 'Ë',
  iacute: 'í', Iacute: 'Í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', Ntilde: 'Ñ',
  oacute: 'ó', Oacute: 'Ó', ograve: 'ò', ocirc: 'ô',
  ouml: 'ö', Ouml: 'Ö', oslash: 'ø', Oslash: 'Ø',
  uacute: 'ú', Uacute: 'Ú', ugrave: 'ù', ucirc: 'û',
  uuml: 'ü', Uuml: 'Ü', szlig: 'ß'
};

// HTML5 remaps numeric references in the 0x80–0x9F range to the
// windows-1252 characters authors actually meant. "&#147;" is a curly
// open-quote in the wild, not an unusable C1 control.
const C1_MAP = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
};

// Bounded lengths keep a pathological "&#000...0;" from being scanned as
// a candidate. Named refs cap at 31 chars (longest HTML5 name is 30).
const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

// Invisible characters that break downstream regex matching and render as
// nothing: zero-width space/joiners, BOM, soft hyphen.
const INVISIBLE_RE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;

function codePointToChar(cp) {
  if (!Number.isFinite(cp) || cp <= 0) return null;                 // NUL / junk
  if (C1_MAP[cp]) return C1_MAP[cp];
  if (cp >= 0xd800 && cp <= 0xdfff) return null;                    // lone surrogate
  if (cp > 0x10ffff) return null;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return null;
  }
}

/**
 * decodeHtmlEntities(s) → string
 * Single-pass decode of named + numeric (decimal/hex) character
 * references. Unknown or out-of-range references are returned verbatim.
 * Non-strings return '' (null/undefined) or their String() form.
 */
function decodeHtmlEntities(s) {
  if (s == null) return '';
  const str = String(s);
  if (str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      const ch = codePointToChar(cp);
      return ch == null ? match : ch;
    }
    const ch = NAMED[body];
    return ch == null ? match : ch;
  });
}

/**
 * cleanScrapedText(s, maxLen?) → string | null
 * Decode entities, drop invisible characters, fold NBSP to a plain space,
 * collapse whitespace, trim, truncate. Returns null when nothing is left
 * — callers store null rather than an empty string.
 *
 * Use for short display/matching fields scraped out of HTML: product
 * title, brand, category, breadcrumb segment, review author. Long HTML
 * bodies go through shopifyPublicIngestService.stripHtml (which calls
 * decodeHtmlEntities itself after stripping tags).
 */
function cleanScrapedText(s, maxLen = null) {
  if (s == null) return null;
  // Never stringify a structure into "[object Object]" — callers hand this
  // whatever a site's JSON-LD had in a name/brand/category slot.
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  return tidyText(decodeHtmlEntities(s), maxLen);
}

/**
 * tidyText(s, maxLen?) \u2192 string | null
 * The whitespace / invisible-character half of cleanScrapedText, WITHOUT
 * decoding. For callers that have already decoded once and must not decode
 * again \u2014 a second pass would collapse a legitimately double-escaped
 * "&amp;quot;" into a bare quote.
 */
function tidyText(s, maxLen = null) {
  if (s == null) return null;
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  let out = String(s)
    .replace(INVISIBLE_RE, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return null;
  if (maxLen != null && out.length > maxLen) out = truncateWords(out, maxLen);
  return out || null;
}

/**
 * truncateWords(s, maxLen) → string
 * Cut at a WORD boundary and mark it. A hard slice produced stored reviews
 * ending "…would buy again but the new one is horrible. Pl" — 10 of 50 Ulta
 * reviews hit the old 400-char cap mid-word — which reads as corrupted text
 * rather than an excerpt when it lands on an ad.
 *
 * The ellipsis is only added when something was actually removed, and the
 * back-off to the last space is abandoned if it would discard more than a
 * quarter of the allowance (a single very long token).
 */
function truncateWords(s, maxLen) {
  const str = String(s);
  if (str.length <= maxLen) return str;
  const hard = str.slice(0, maxLen);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace > maxLen * 0.75 ? hard.slice(0, lastSpace) : hard;
  return cut.replace(/[\s,;:.!?—–-]+$/, '') + '…';
}

/**
 * hasHtmlEntity(s) → boolean
 * True when the string still carries a decodable reference. Used by the
 * backfill script to select damaged rows without decoding every document.
 */
function hasHtmlEntity(s) {
  if (s == null) return false;
  const str = String(s);
  if (str.indexOf('&') === -1) return false;
  return decodeHtmlEntities(str) !== str;
}

module.exports = {
  decodeHtmlEntities,
  cleanScrapedText,
  tidyText,
  truncateWords,
  hasHtmlEntity,
  NAMED
};
