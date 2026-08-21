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
 * truncateSentences(s, maxLen) → string
 *
 * Shorten a REVIEW BODY by dropping whole sentences from the end — never by
 * cutting inside one. A review must always read as something the customer
 * actually wrote, so:
 *   · keep as many complete sentences as fit
 *   · never append an ellipsis (an excerpt of whole sentences needs no mark,
 *     and a "…" reads as the reviewer trailing off, which they did not)
 *   · if even the FIRST sentence exceeds maxLen, keep the whole review rather
 *     than mangle it — storing 40 extra characters is strictly better than
 *     inventing a cut-off, and maxLen is a storage bound, not a display one
 *
 * Abbreviations are handled by requiring a terminator to be followed by
 * whitespace AND a capital/quote/digit — so "5.5 in. wide" is one sentence, not
 * three, while "perfectly. Second" splits.
 *
 * splitSentences is a SCAN, not a match: an earlier regex-match version
 * silently dropped any prefix it could not match ("Measures 5.5 in. wide and
 * fits perfectly." came back as "5 in. wide and fits perfectly."), which is
 * exactly the kind of invisible data loss this function exists to prevent. The
 * parts always concatenate back to the input.
 */
function splitSentences(str) {
  const parts = [];
  const re = /[.!?…]+(?=\s+["'“(\[]?[A-Z0-9]|\s*$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    const end = m.index + m[0].length;
    parts.push(str.slice(start, end));
    start = end;
  }
  if (start < str.length) parts.push(str.slice(start));
  return parts;
}

function truncateSentences(s, maxLen) {
  const str = String(s == null ? '' : s).trim();
  if (!str || str.length <= maxLen) return str;

  const parts = splitSentences(str);
  if (parts.length <= 1) return str;               // one sentence → keep it whole

  let out = '';
  for (const part of parts) {
    const next = out + part;
    if (next.trim().length > maxLen) break;
    out = next;
  }
  out = out.trim();
  // Nothing fit → the first sentence is longer than the cap; keep it entire.
  return out || str;
}

/**
 * A terminator that does NOT end a sentence: a title, an initial, or a common
 * abbreviation. `splitSentences` disambiguates by requiring a capital/digit after
 * the stop, which is right for "5.5 in. wide" but WRONG whenever the next word is
 * a proper noun: "Absolutely love Dr. Bronners products" splits at "Dr.", and a
 * caller that keeps whole sentences would then print "Absolutely love Dr." on an ad.
 *
 * Deliberately NOT case-insensitive. With /i this also matches ordinary words that
 * legitimately end sentences — "The answer is no.", "I use the pro." — and every
 * false positive here costs a usable quote. Titles are capitalized in real prose.
 * The single-initial alternative excludes apostrophes from its left boundary on
 * purpose: with `'` allowed, "these new T's." reads as the initial "s".
 */
const NOT_A_SENTENCE_END = new RegExp(
  '(?:^|[\\s("“])' +
  '(?:' +
    '[A-Za-z]' +                                                   // "J. Crew", "size L."
    '|Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Ave|Inc|Ltd|Co|Corp|Dept|Fig|Vol|Rev|vs|etc|approx|est|al' +
    '|[ap]\\.m|e\\.g|i\\.e|a\\.k\\.a' +                            // "6 a.m.", "e.g."
    '|[A-Z](?:\\.[A-Z])+' +                                        // "U.S.", "U.K."
  ')\\.$'
);

/**
 * endsOnSentenceStop(s) → boolean
 * Whether the string finishes a sentence the writer actually finished. Trailing
 * quotes/brackets are allowed to sit after the stop ("These are amazing.").
 */
function endsOnSentenceStop(s) {
  const bare = String(s == null ? '' : s).trim().replace(/["'”’)\]]+$/, '');
  if (!/[.!?…]$/.test(bare)) return false;
  // Only the tail can carry an abbreviation, and slicing keeps this O(1) per
  // candidate instead of O(n) — completeSentencePrefix calls it per sentence.
  return !NOT_A_SENTENCE_END.test(bare.slice(-24));
}

/**
 * finishesThought(s) → boolean
 *
 * Does this string STOP somewhere a reader would stop, rather than break off?
 *
 * Owner report 2026-08-11: ads were printing quotes "cut off right after a word and a
 * comma" — *"I love this shirt, so great with…"*. The obvious rule, "require terminal
 * punctuation", is WRONG here and the harness caught it: a curated extract like
 * *"absolutely love these, so comfortable"* is a finished thought that simply has no
 * period, and demanding one would delete the entire curated-snippet path.
 *
 * So this tests for the actual defect — a string that ends MID-CLAUSE:
 *   · a trailing ellipsis, which by construction means "there was more";
 *   · a trailing comma, semicolon or dash, i.e. the sentence was still going;
 *   · a dangling function word (and, with, in, my, the …) — the Pelagic shape,
 *     "…keeping me cool in my", where the next word is the one that mattered.
 * Anything else is treated as finished, including a bare clause that ends on a real
 * word. This is deliberately permissive: it is a stop-loss on mangled text, not a
 * grammar checker.
 */
const DANGLING_TAIL = /\b(?:and|or|but|so|with|without|for|from|in|into|on|at|to|of|by|as|than|that|which|because|since|my|our|your|their|his|her|its|the|a|an|is|are|was|were|it|they)$/i;

function finishesThought(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  // ELLIPSIS FIRST. `…` is itself in the sentence-stop character class, so asking
  // endsOnSentenceStop first would wave "so great with…" straight through — the exact
  // string this function exists to reject.
  if (/(?:…|\.\.\.)["'”’)\]]*\s*$/.test(t)) return false;   // "there was more"
  if (endsOnSentenceStop(t)) return true;
  if (/[,;:\-–—]\s*$/.test(t)) return false;               // the sentence was still going
  const bare = t.replace(/["'”’)\]]+$/, '').trim();
  if (DANGLING_TAIL.test(bare)) return false;              // "…cool in my"
  return true;
}

/**
 * completeSentencePrefix(s, maxLen) → string
 *
 * The longest leading run of WHOLE sentences, optionally within maxLen. Returns
 * '' when the string does not complete a single sentence inside the budget.
 *
 * SELECTION, NOT REPAIR. Built on `splitSentences`, whose parts concatenate back
 * to the input exactly, so the result is always a literal prefix of `s` — no
 * character is added, reordered, or invented. That property is what makes this
 * safe to use on a verbatim customer quote destined for a paid ad: the trimmed
 * text is still something the reviewer wrote. Precisely:
 * `String(s).trim().startsWith(completeSentencePrefix(s, n))` always holds.
 *
 * Known conservative gap: `splitSentences` requires whitespace after a
 * terminator, so a missing space ("amazing.Really soft") is seen as one
 * unfinished sentence and yields ''. Callers drop rather than guess. Widening the
 * split regex would change stored-review truncation everywhere it is used, which
 * is not worth a typo case.
 */
function completeSentencePrefix(s, maxLen = Infinity) {
  // Trimmed up front so the contract is exact: the result is always a literal
  // PREFIX of the trimmed input. Without this, leading whitespace makes the
  // returned span a substring-but-not-prefix, which a fuzz check caught.
  const str = String(s == null ? '' : s).trim();
  if (!str) return '';
  let acc = '';
  let best = '';
  for (const part of splitSentences(str)) {
    acc += part;
    const candidate = acc.trim();
    if (candidate.length > maxLen) break;
    if (endsOnSentenceStop(candidate)) best = candidate;
  }
  return best;
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
  endsOnSentenceStop,
  finishesThought,
  completeSentencePrefix,
  decodeHtmlEntities,
  cleanScrapedText,
  tidyText,
  truncateWords,
  truncateSentences,
  splitSentences,
  hasHtmlEntity,
  NAMED
};
