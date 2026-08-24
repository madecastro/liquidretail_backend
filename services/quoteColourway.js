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
 * `|` (the Soludos shape: "…Sneaker | White - Wine"); falls back to
 * consecutive trailing " - …" colour segments (so the display-normalized
 * form "…Sneaker - White - Wine" still yields {white, wine} — taking
 * only the LAST dash dropped White and silently rejected "white sole");
 * then to a full-title scan. Zero colour tokens → unparseable → fail
 * closed for colour-describing quotes on product-attached ads. Brand /
 * media-library ads (productAttached === false) are a no-op even when
 * a noun-scope title is present — they have no SKU colourway to check.
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
 * Frozen non-colour collocates. A colour WORD is not a colour claim
 * when it sits next to one of these tails. Each entry generates both
 * the spaced and hyphenated form ("mint condition" / "mint-condition")
 * so adding a new ordinary-word trap is a collocate on the colour form,
 * not a one-off sentence.
 *
 * Colour words carry non-colour senses constantly — "in the black",
 * "blue-chip", "golden opportunity", "mint condition". Over-dropping
 * those silently strips proof from every future ad for the product;
 * under-dropping ships a wrong-colour testimonial. The collocate
 * shape is how we add a trap without widening the matcher.
 */
const COLOUR_IDIOM_TAILS = Object.freeze({
  mint:   ['condition'],
  blue:   ['chip', 'collar', 'moon'],
  black:  ['sheep', 'market', 'owned'],
  red:    ['herring', 'flag', 'handed', 'letter'],
  white:  ['lie', 'flag', 'noise', 'collar'],
  grey:   ['area'],
  gray:   ['area'],
  green:  ['light', 'thumb', 'eyed'],
  silver: ['lining', 'bullet'],
  golden: ['opportunity', 'age'],
  gold:   ['standard'],
  yellow: ['bellied'],
  pink:   ['collar']
});

// Verb-sense / multi-word frozen phrases that a colour+tail pair cannot
// generate ("rose to the occasion", "in the black").
const COLOUR_IDIOM_PHRASES = Object.freeze([
  'out of the blue', 'once in a blue moon', 'blue in the face',
  'in the black', 'into the black',
  'in the red', 'out of the red', 'into the red',
  'paint the town red', 'seeing red',
  'rose to the occasion', 'rose above', 'coming up roses', 'come up roses',
  'rose-colored glasses', 'rose-coloured glasses', 'rose colored glasses',
  'green with envy',
  'give the green light', 'gave the green light',
  'black and white', 'black-and-white',
  'caught red-handed', 'caught red handed',
  'cream of the crop', 'ice cream',
  'true colors', 'true colours',
  'tickled pink'
]);

function expandIdiomTails(map) {
  const out = [];
  for (const [colour, tails] of Object.entries(map)) {
    for (const tail of tails) {
      out.push(`${colour} ${tail}`, `${colour}-${tail}`);
    }
  }
  return out;
}

const COLOUR_IDIOMS = Object.freeze([
  ...expandIdiomTails(COLOUR_IDIOM_TAILS),
  ...COLOUR_IDIOM_PHRASES
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
 * Hyphenated colour adjectives ("green-accented", "wine-colored") are
 * colour language. Hyphenated frozen compounds whose tail is NOT a
 * colour and NOT a colour-describing suffix ("blue-chip") are not.
 *
 * Without the adjective-tail exception, `\bgreen\b` matched inside
 * "green-accented" and the skip fired because "accented" is not a
 * colour form — the measured defect, hyphenated. Word-boundary match
 * is unchanged: this is not a substring search.
 */
const COLOUR_ADJ_TAILS = Object.freeze([
  'colored', 'coloured', 'accent', 'accents', 'accented',
  'tinted', 'hued', 'toned'
]);
const COLOUR_ADJ_TAIL_SET = new Set(COLOUR_ADJ_TAILS);

function isHyphenatedNonColour(src, index, matched) {
  const after = src.slice(index + String(matched || '').length);
  const m = after.match(/^-([a-z]+)/i);
  if (!m) return false;
  const tail = m[1].toLowerCase();
  if (ALL_COLOUR_FORMS.has(tail)) return false;
  if (COLOUR_ADJ_TAIL_SET.has(tail)) return false;
  return true;
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

/**
 * Intensity / finish words that sit next to a colour in a colourway
 * segment ("Heavy Blue", "Off White") and are not themselves a colour
 * family. Used only to decide whether a dash-separated TITLE segment
 * is a colourway piece — never to match quotes.
 */
const COLOURWAY_MODIFIERS = new Set([
  'light', 'dark', 'bright', 'pale', 'deep', 'hot', 'burnt', 'off',
  'heather', 'heathered', 'neon', 'matte', 'gloss', 'glossy',
  'washed', 'vintage', 'classic', 'retro', 'heavy', 'soft',
  'true', 'pure', 'rich', 'dusty', 'muted', 'vivid', 'bold',
  'warm', 'cool'
]);

function leftoverNonColourWords(src) {
  const masked = maskIdioms(String(src || ''));
  const consumed = new Array(masked.length).fill(false);
  for (const { re } of COLOUR_MATCHERS) {
    const r = new RegExp(re.source, 'gi');
    for (const m of masked.matchAll(r)) {
      if (isHyphenatedNonColour(masked, m.index, m[0])) continue;
      markConsumed(consumed, m.index, m.index + m[0].length);
    }
  }
  const leftover = masked
    .split('')
    .map((ch, i) => (consumed[i] ? ' ' : ch))
    .join('')
    .replace(/[/,&+()\-]/g, ' ')
    .replace(/\band\b/gi, ' ');
  return leftover.split(/\s+/).filter((w) => /[a-z]/i.test(w));
}

/**
 * True when `seg` is a colourway piece, not a product-name fragment
 * that happens to contain a colour word. "White", "Wine", "Heavy Blue",
 * "White / Wine" pass; "Pink Floyd Graphic Tee" does not (leftover
 * Floyd/Graphic/Tee are not modifiers). Load-bearing for walking
 * consecutive trailing dashes — a last-dash-only parse of the
 * display-normalized Soludos title kept Wine and dropped White.
 */
function segmentIsColourwaySuffix(seg) {
  const src = String(seg || '').trim();
  if (!src) return false;
  if (!colourFamiliesIn(src).length) return false;
  return leftoverNonColourWords(src).every((w) => COLOURWAY_MODIFIERS.has(w.toLowerCase()));
}

function trailingDashColourway(title) {
  const parts = String(title || '').split(/\s+-\s+/);
  if (parts.length < 2) return null;
  // "White - Wine" with no product-name prefix: every segment is a
  // colourway piece, take all of them.
  if (parts.every(segmentIsColourwaySuffix)) {
    const fams = colourFamiliesIn(parts.join(' '));
    return fams.length ? fams : null;
  }
  const collected = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    if (segmentIsColourwaySuffix(parts[i])) collected.unshift(parts[i].trim());
    else break;
  }
  if (!collected.length) return null;
  const fams = colourFamiliesIn(collected.join(' '));
  return fams.length ? fams : null;
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
 *   - Consecutive trailing ` - White - Wine` / ` - Navy` segments
 *     (display-normalized titles flatten `|` to ` - `) are collected
 *     until a non-colourway segment stops the walk, so both title
 *     forms yield the same set. "Foo - Limited Edition" is not a
 *     colourway. "Pink Floyd Graphic Tee - Black" is {black}, not pink.
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
  const fromDash = trailingDashColourway(t);
  if (fromDash && fromDash.length) return new Set(fromDash);
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
  // Brand / media-library ads have no SKU colourway. productTitle may
  // still be set (noun-scope uses it for garment matching) — riding
  // that would fail-closed and silently strip proof from ads that
  // legitimately have no product colour. Fail-closed is therefore
  // scoped to product-attached ads only.
  if (scope.productAttached === false) return quote;
  const ctx = scope.productTitle != null
    ? scope.productTitle
    : (scope.product != null ? scope.product : null);
  // Product-attached + missing title = unknown colourway. Colour
  // language in the quote cannot be vouched for → drop. Colour-free
  // quotes still pass (usableColourwayQuote no-ops before the title
  // check). Passing '' (not null) is what trips the empty-title arm
  // rather than the "no product context" KEEP.
  if (scope.productAttached === true && ctx == null) {
    return usableColourwayQuote(quote, '');
  }
  if (ctx == null) return quote;
  return usableColourwayQuote(quote, ctx);
}

module.exports = {
  usableColourwayQuote,
  applyQuoteColourway,
  colourFamiliesIn,
  productColourwayFromTitle,
  COLOUR_FAMILIES,
  COLOUR_IDIOMS,
  COLOUR_IDIOM_TAILS
};
