'use strict';

/**
 * Fail-closed colourway gate for customer quotes.
 *
 * MEASURED 2026-08-24 on Soludos "Women's Roma Retro Sneaker | White - Wine"
 * (run_1787576848754_994b722b): two of nine statics printed a testimonial
 * describing a GREEN accent over a wine/burgundy shoe. Vision QC failed,
 * the ads regenerated, and failed again — ~$0.14 burned per occurrence
 * (two gpt-image-2/edit submits) and nothing shipped.
 *
 * Root cause (verified against this tree, not assumed):
 *   - CatalogProduct has NO colour field (models/CatalogProduct.js). The
 *     itemGroupId comment at :34 names "size/color/scent variants of the
 *     same parent" but stores only the grouping key, not which colour a
 *     given row is. `color` / `options` are not schema paths.
 *   - quoteSnippetService.js and productDetailsService.js contain zero
 *     colour filters.
 *   - lookupProductReviews searches by productName; captureForProduct
 *     scrapes productUrl. Shopify colour variants share a parent page, so
 *     a green-colourway review is a legitimate row on the wine SKU's
 *     productReviews. itemGroupId / primaryProductId are NOT used to
 *     copy reviews across siblings — the pooling happens at the source
 *     URL / search, not via a parent-id join.
 *
 * THE GATE: if a quote names a colour, we must be able to VERIFY that
 * colour is this product's colourway. Unverifiable → drop the quote.
 * Dropping costs nothing; printing a wrong one wastes two generations.
 *
 * Same shape as usableAttribution (quoteProvenance.js): a small, total
 * predicate that returns null when it cannot vouch for the input.
 * Composed WITH toPrintableCustomerQuote / applyStrictQuoteScope, never
 * inside them — printability, noun-scope, attribution viability, and
 * colourway are four separate questions.
 *
 * No-op (returns the quote unchanged) when:
 *   - the quote names no colour language, OR
 *   - there is no product context to check against (brand / media ads).
 *
 * Fail-closed (returns null) when the quote names a colour AND:
 *   - the product title is present but has no parseable colourway, OR
 *   - a named colour's family is not in the parsed colourway.
 *
 * Colourway is parsed from the product TITLE only. There is no structured
 * colour field to read, and we do not invent one (ingest backfill is a
 * follow-up, not this gate). Parse prefers the segment after the last
 * `|` (the Soludos shape: "…Sneaker | White - Wine"); falls back to a
 * trailing " - …" segment that looks like colours; then to a full-title
 * scan. Zero colour tokens → unparseable → fail closed for colour-
 * describing quotes. That is a deliberate choice: a title with no colour
 * words cannot vouch for "green accent", so we do not print it.
 */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteTextOf(quote) {
  if (quote == null) return '';
  if (typeof quote === 'string') return quote;
  return String(quote.text || quote.body || quote.content || '');
}

function titleOf(productOrTitle) {
  if (productOrTitle == null) return null;
  if (typeof productOrTitle === 'string') return productOrTitle;
  if (typeof productOrTitle !== 'object') return null;
  const t = productOrTitle.title || productOrTitle.name || productOrTitle.productTitle;
  if (t == null) return null;
  return String(t);
}

/**
 * Canonical family → surface forms. Longest form wins at match time so
 * "navy blue" is one blue, not navy+blue separately (same family either
 * way, but "forest green" must not also light up a stray "forest").
 *
 * Fashion colours that are the measured defect's world (apparel /
 * footwear colourways) are first-class: wine/burgundy/oxblood, sage,
 * oatmeal, etc. Standalone "rose" is included and the verb-sense is
 * handled by the idiom mask ("rose to the occasion"), not by omitting
 * the colour.
 */
const COLOUR_FAMILIES = Object.freeze({
  white:  ['off-white', 'off white', 'white', 'ivory', 'cream', 'ecru', 'eggshell'],
  black:  ['black', 'noir', 'onyx', 'ebony'],
  grey:   ['charcoal', 'heather', 'gunmetal', 'grey', 'gray', 'slate'],
  silver: ['silver'],
  brown:  ['cognac', 'espresso', 'chocolate', 'chestnut', 'walnut', 'khaki', 'camel', 'taupe', 'brown', 'mocha', 'tan'],
  beige:  ['oatmeal', 'champagne', 'beige', 'sand', 'nude'],
  red:    ['cardinal', 'crimson', 'scarlet', 'cherry', 'red'],
  wine:   ['burgundy', 'bordeaux', 'oxblood', 'maroon', 'claret', 'merlot', 'wine'],
  pink:   ['hot-pink', 'hot pink', 'bubblegum', 'fuchsia', 'magenta', 'blush', 'pink'],
  rose:   ['dusty-rose', 'dusty rose', 'rose-gold', 'rose gold', 'rosegold', 'rose'],
  blue:   ['navy-blue', 'navy blue', 'royal-blue', 'royal blue', 'sky-blue', 'sky blue',
           'cerulean', 'turquoise', 'indigo', 'cobalt', 'azure', 'navy', 'teal', 'aqua', 'denim', 'blue'],
  green:  ['forest-green', 'forest green', 'hunter-green', 'hunter green', 'kelly-green', 'kelly green',
           'seafoam', 'emerald', 'hunter', 'kelly', 'olive', 'sage', 'moss', 'jade', 'lime', 'mint', 'green'],
  yellow: ['mustard', 'golden', 'yellow', 'lemon', 'canary', 'gold'],
  orange: ['burnt-orange', 'burnt orange', 'terra cotta', 'terracotta', 'tangerine', 'apricot', 'orange', 'coral', 'peach', 'rust'],
  purple: ['amethyst', 'lavender', 'violet', 'purple', 'lilac', 'mauve', 'plum']
});

// Stems that take a natural-language -ish ("greenish accent").
const ISH_STEMS = new Set([
  'white', 'black', 'grey', 'gray', 'brown', 'red', 'pink', 'blue',
  'green', 'yellow', 'gold', 'orange', 'purple', 'wine'
]);

const ALL_COLOUR_FORMS = new Set(
  Object.values(COLOUR_FAMILIES).flat().map((f) => f.toLowerCase())
);

/**
 * Phrases where a colour WORD is not being used as a colour. Masked
 * before matching so "blue-chip quality" does not trip the blue family.
 *
 * This is an allowlist of known non-colour senses, not a denylist of
 * colours. A quote that names a real product colour ("green accent")
 * will not match any of these and will still be gated.
 */
const COLOUR_IDIOMS = Object.freeze([
  'blue-chip', 'blue chip',
  'out of the blue', 'once in a blue moon', 'blue in the face', 'blue moon',
  'blue-collar', 'blue collar',
  'in the black', 'into the black',
  'black and white', 'black-and-white',
  'black sheep', 'black market', 'black-owned',
  'in the red', 'out of the red', 'into the red',
  'red herring', 'red flag', 'red-flag', 'red-handed', 'red handed',
  'red-letter', 'paint the town red', 'seeing red',
  'rose to the occasion', 'rose above', 'coming up roses', 'come up roses',
  'rose-colored glasses', 'rose-coloured glasses', 'rose colored glasses',
  'green with envy', 'green thumb', 'green-eyed',
  'green light', 'the green light', 'give the green light', 'gave the green light',
  'white lie', 'white flag', 'white noise', 'white-collar', 'white collar',
  'grey area', 'gray area', 'gray-area', 'grey-area',
  'silver lining', 'silver bullet',
  'golden opportunity', 'golden age',
  'yellow-bellied',
  'tickled pink',
  'cream of the crop', 'ice cream',
  'true colors', 'true colours',
  'pink-collar', 'pink collar'
]);

const IDIOM_RE = new RegExp(
  COLOUR_IDIOMS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRe(p))
    .join('|'),
  'gi'
);

function maskIdioms(src) {
  return String(src).replace(IDIOM_RE, (m) => ' '.repeat(m.length));
}

const COLOUR_MATCHERS = (() => {
  const entries = [];
  for (const [family, forms] of Object.entries(COLOUR_FAMILIES)) {
    for (const form of forms) {
      entries.push({ family, form, len: form.length });
    }
  }
  entries.sort((a, b) => b.len - a.len || a.form.localeCompare(b.form));
  return entries.map(({ family, form }) => {
    const parts = form.split(/\s+/).map(escapeRe);
    const body = parts.join('\\s+');
    const ish = parts.length === 1 && ISH_STEMS.has(form) ? '(?:ish)?' : '';
    const colored = parts.length === 1 ? '(?:[-\\s]?colou?red)?' : '';
    return {
      family,
      form,
      re: new RegExp(`\\b${body}${ish}${colored}\\b`, 'gi')
    };
  });
})();

function rangeConsumed(consumed, start, end) {
  for (let i = start; i < end; i++) {
    if (consumed[i]) return true;
  }
  return false;
}

function markConsumed(consumed, start, end) {
  for (let i = start; i < end; i++) consumed[i] = true;
}

/**
 * "blue-chip": the match "blue" is immediately followed by -chip, and
 * chip is not a colour form → not colour language. "blue-green" stays
 * (green IS a colour form).
 */
function isHyphenatedNonColour(src, index, matched) {
  const after = src.slice(index + String(matched || '').length);
  const m = after.match(/^-([a-z]+)/i);
  if (!m) return false;
  return !ALL_COLOUR_FORMS.has(m[1].toLowerCase());
}

/**
 * Canonical colour families named in `text`. Empty → the quote (or
 * title) has no colour language we can see. Idioms are masked first so
 * this is conservative on ordinary-word senses and aggressive on real
 * colour descriptions — the asymmetry the money bug requires.
 */
function colourFamiliesIn(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const src = maskIdioms(raw);
  const consumed = new Array(src.length).fill(false);
  const found = [];
  const seen = new Set();
  for (const { re, family } of COLOUR_MATCHERS) {
    const r = new RegExp(re.source, 'gi');
    for (const m of src.matchAll(r)) {
      const start = m.index;
      const end = start + m[0].length;
      if (rangeConsumed(consumed, start, end)) continue;
      if (isHyphenatedNonColour(src, start, m[0])) continue;
      markConsumed(consumed, start, end);
      if (!seen.has(family)) {
        seen.add(family);
        found.push(family);
      }
    }
  }
  return found;
}

function suffixLooksLikeColourway(suffix) {
  const tokens = String(suffix || '')
    .split(/[/,&+]|(?:\s+and\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return false;
  let colourTokens = 0;
  for (const tok of tokens) {
    if (colourFamiliesIn(tok).length) colourTokens++;
  }
  return colourTokens * 2 >= tokens.length;
}

/**
 * Parse the product's colourway from its title. Returns a Set of
 * canonical families, or null when nothing colour-like can be vouched
 * for (fail-closed input for usableColourwayQuote).
 *
 * Reliability, stated honestly:
 *   - The Soludos shape (`Title | White - Wine`) is reliable: we read
 *     only the last `|` segment, so a colour word in the product NAME
 *     ("Pink Floyd Tee | Black") does not become the colourway.
 *   - A trailing ` - Navy` / ` - White / Wine` segment is used only
 *     when at least half its tokens are colour forms, so
 *     "Foo - Limited Edition" is not a colourway.
 *   - Full-title scan is the last resort (titles with no separator).
 *     "Navy Performance Shirt" works; "Green Tea Cleanser" will
 *     parse as {green} — a residual, not a reason to skip the gate.
 *   - Zero tokens → null. We do not guess.
 */
function productColourwayFromTitle(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const pipe = t.lastIndexOf('|');
  if (pipe >= 0) {
    const suffix = t.slice(pipe + 1).trim();
    const fromSuffix = colourFamiliesIn(suffix);
    if (fromSuffix.length) return new Set(fromSuffix);
  }
  const dash = t.lastIndexOf(' - ');
  if (dash >= 0) {
    const suffix = t.slice(dash + 3).trim();
    if (suffixLooksLikeColourway(suffix)) {
      const fromDash = colourFamiliesIn(suffix);
      if (fromDash.length) return new Set(fromDash);
    }
  }
  const fromAll = colourFamiliesIn(t);
  return fromAll.length ? new Set(fromAll) : null;
}

/**
 * Return `quote` when we can vouch that its colour language matches
 * the product, else null.
 *
 * Never throws. Never edits quote text. A dropped quote degrades the
 * slot to absent — same contract as usableAttribution.
 *
 * @param {*} quote  quote object or string
 * @param {string|object|null|undefined} productOrTitle
 *   CatalogProduct-shaped `{title}`, a title string, or null/undefined
 *   when there is no product to check (brand / media ads).
 * @returns {*|null}
 */
function usableColourwayQuote(quote, productOrTitle) {
  if (quote == null) return null;
  const named = colourFamiliesIn(quoteTextOf(quote));
  // No colour language → nothing to verify. KEEP. This is the no-op
  // the owner required for a quote that never named a colour.
  if (!named.length) return quote;

  // No product context at all → nothing to conflict with. KEEP.
  // Distinct from "product present, title empty" below.
  if (productOrTitle == null) return quote;

  const title = titleOf(productOrTitle);
  if (title == null || !String(title).trim()) return null;

  const way = productColourwayFromTitle(title);
  if (!way || way.size === 0) return null;

  return named.every((f) => way.has(f)) ? quote : null;
}

/**
 * Render-time wrapper: read the colourway source off the same `scope`
 * object applyStrictQuoteScope already receives (`productTitle`,
 * optionally `product`). Missing scope / missing productTitle is a
 * no-op so existing callers that never heard of colour stay identical
 * for colour-free quotes AND for product-less ads.
 *
 * Returns the quote or null. Never throws.
 */
function applyQuoteColourway(quote, scope) {
  if (!quote) return null;
  if (!scope || typeof scope !== 'object') return quote;
  const ctx = scope.productTitle != null
    ? scope.productTitle
    : (scope.product != null ? scope.product : null);
  if (ctx == null) return quote;
  return usableColourwayQuote(quote, ctx);
}

module.exports = {
  usableColourwayQuote,
  applyQuoteColourway,
  colourFamiliesIn,
  productColourwayFromTitle,
  COLOUR_FAMILIES,
  COLOUR_IDIOMS
};
