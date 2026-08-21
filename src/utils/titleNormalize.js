// Normalize a product title for matching purposes.
//
// Catalog titles in the wild are polluted with promo language ("Subscribe
// and Save", "30% Off applied"), inconsistent separators (" - ", em-dash,
// en-dash, colon, pipe), trademark symbols, and case variation. When the
// matcher compares the Gemini-returned product name against
// CatalogProduct.title via exact regex, every suffix variant produces a
// phantom row.
//
// normalizeTitle(s) returns a lowercase, whitespace-collapsed form with
// known promo cruft stripped and separators flattened. It's stable
// (deterministic, no random salt) so it can be persisted as a
// `normalizedTitle` field and indexed for fast lookup, and used as the
// comparison key in both the matcher and the dedupe scripts.
//
// Intentionally NOT a synonym/abbreviation engine — "HCO" and "Hot
// Crispy Oil" still normalize differently. Brand-expansion is a separate
// concern.

// Phrases to remove entirely before tokenization. Add to this list as
// new promo patterns surface in catalog syncs.
const PROMO_PHRASES = [
  /\bsubscribe\s+and\s+save\b/gi,
  /\bsubscribe\s*&\s*save\b/gi,
  /\b\d+\s*%\s*off(\s+applied)?\b/gi,
  /\bbuy\s+\d+\s+get\s+\d+(\s+free)?\b/gi,
  /\bbogo\b/gi,
  /\bfree\s+shipping\b/gi,
  /\blimited\s+time\b/gi,
  /\bwhile\s+supplies\s+last\b/gi,
  /\bbest\s+seller\b/gi,
  /\bnew\s*!\s*$/gi,
  /\b\(?(promo|sale|discount|deal)\)?\b/gi,
];

// Separators that should be flattened to a single space before
// tokenization. Includes em-dash, en-dash, vertical bar, colon, and the
// common "spaced hyphen" pattern.
const SEPARATOR_RE = /[\u2013\u2014:|]+|\s-\s/g;

// Trademark / copyright marks, stripped silently.
const MARK_RE = /[®™©]/g;

function normalizeTitle(s) {
  if (s == null) return '';
  let out = String(s);

  out = out.replace(MARK_RE, ' ');
  out = out.replace(SEPARATOR_RE, ' ');

  for (const re of PROMO_PHRASES) {
    out = out.replace(re, ' ');
  }

  out = out.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip remaining punctuation
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

// Token-overlap score 0..1 with a minimum-shared-tokens floor. Used by
// the fuzzy fallback in ensureCatalogProductForMatch and by the
// phantom-twin reparent script. Returns { score, shared } so callers
// can require both score AND shared >= N.
const STOP = new Set([
  'the','a','an','and','or','of','for','with','to','in','on','by','at','from',
  'is','are','be','this','that','it','as','if','so','do','not','no'
]);

function tokens(normalized) {
  return String(normalized || '').split(' ').filter(t => t && t.length > 1 && !STOP.has(t));
}

function titleSimilarity(a, b) {
  const ta = new Set(tokens(normalizeTitle(a)));
  const tb = new Set(tokens(normalizeTitle(b)));
  if (!ta.size || !tb.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const score = shared / Math.min(ta.size, tb.size);
  return { score, shared };
}

// Display-friendly variant of normalizeTitle. Strips the same promo
// cruft (Subscribe and Save, 30% Off applied, BOGO, etc.) but keeps
// case, separators, and punctuation intact so the result is suitable
// for rendering as a product name.
//
//   "Hot Crispy Oil - Original Subscribe and Save 30% Off applied
//    at checkout"   →   "Hot Crispy Oil - Original"
//
// Used at render time inside layoutInputService when building the
// ad's product.name field. The catalog row's stored title is not
// modified — brands often want the promo phrasing on their actual
// shop, just not on the ad.
function displayNormalizeTitle(s) {
  if (s == null) return '';
  let out = String(s);

  // Drop trademark marks but keep everything else.
  out = out.replace(MARK_RE, '');

  // Strip promo phrases. Same regex set as normalizeTitle.
  for (const re of PROMO_PHRASES) {
    out = out.replace(re, ' ');
  }

  // "applied at checkout" / "at checkout" leftovers from the promo
  // phrase strip — they often sit alone after "30% Off" is removed.
  out = out.replace(/\b(applied\s+)?at\s+checkout\b/gi, ' ');

  // Collapse extra whitespace, strip stranded separators / empty
  // bracket pairs / orphan trailing punctuation that promo removal
  // left behind ("Hot Crispy Oil -  - Original", "( )", "!" alone).
  out = out
    .replace(/\s+/g, ' ')
    .replace(/[(\[{]\s*[)\]}]/g, ' ')                // empty pairs
    .replace(/(\s*[-–—|:]\s*)+/g, m => m.trim() ? ' - ' : ' ')
    .replace(/\s+([!?.,;])/g, '$1')                  // tighten orphan punctuation
    .replace(/[!?.,;]\s*$/g, '')                     // drop trailing orphan punctuation
    .replace(/\s*-\s*$/g, '')
    .replace(/^\s*-\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

module.exports = { normalizeTitle, displayNormalizeTitle, titleSimilarity };
