'use strict';

/**
 * ONE definition of "may this be printed as a customer's own words".
 *
 * It lives in its own module for the same reason staticPipeline.js does: the
 * producer that assembles the quote pool, the renderer that typesets it, and
 * the harness that pins the rule must consult the same implementation. The
 * first version of this gate existed only inside directImageRenderService, so
 * the HTML and video paths kept printing whatever the artifact carried — a
 * "fix" that covered one of three renderers.
 *
 * ALLOWLIST, never a denylist. That is not a style preference, it is the shape
 * of the bug this replaces:
 *
 *   - The previous screen, isFirstPartyQuote(), tested for two known-bad
 *     strings ('llm-web', 'synthesized'). DERIVATION_SCHEMA declares neither
 *     `origin` nor `verbatim`, so the LLM tier — the one whose prompt asks for
 *     "NOTIONAL persona-authored reviews" with the persona's name as the byline
 *     — arrived unstamped and passed.
 *   - The first producer-side stamp said "anything that is not 'gemini-search'
 *     is a storefront import". categoryReviewsService writes `sources` (plural,
 *     a domain list) and no `source`, so every legacy category row — LLM
 *     web-search output — was stamped printable.
 *
 * Both holes are the same mistake: deciding by what a thing is NOT. Provenance
 * we cannot positively establish is stamped 'unknown', and 'unknown' does not
 * print.
 *
 * Measured against production on 2026-07-31, which is why the list is short. Of
 * 1073 catalog products carrying reviews, 883 came from 'gemini-search' (3345
 * quotes) and 190 from an unlabelled storefront import (748 quotes, each
 * carrying per-quote source:'store'). ZERO came from a first-party review
 * scrape — so an allowlist of {scraped} alone would withhold every quote on
 * every ad indefinitely, not merely until caches churn.
 */
const PRINTABLE_QUOTE_ORIGINS = new Set([
  'scraped',         // captured first-hand by the review engine or headless capture
  'social_comment',  // a real commenter; text is the ingest judge's contiguous extract
  'store-import',    // reviews imported from the merchant's own storefront
  'llm-web'          // grounded web search (Gemini google_search tool). TEXT ONLY —
                     // attribution is stripped structurally by toPrintableCustomerQuote.
  // 'synthesized' — LLM prose ABOUT reviews. Excluded, and its producer is deleted.
  // 'unknown'     — provenance we could not establish. Excluded by omission.
]);

/**
 * Origins whose capture layer cannot name a real person as the speaker. For
 * these, the WORDS may print but every byline field is stripped at the gate —
 * not by caller convention. A renderer that forgets to clear author_name still
 * cannot print one, because the object it received never had one.
 *
 * Today that set is exactly {'llm-web'}. Keep the set so a future origin that
 * shares the same "real text, untrustworthy speaker label" shape inherits the
 * strip without another allowlist edit.
 */
const ANONYMOUS_PRINT_ORIGINS = new Set(['llm-web']);

/**
 * Byline fields that must never reach a renderer for ANONYMOUS_PRINT_ORIGINS.
 * Includes every name the cascade, intent builder, and normalizeQuote have
 * ever read as "who said this".
 *
 * Deliberately generous. The point of a structural strip is that it does not
 * depend on knowing every producer: a future capture path will invent a field
 * name (`reviewer`, `user_name`, `platform`, `site`, …) and will not know about
 * this gate. No producer writes those four today — this is hardening, not a
 * live hole — but omitting them would make the strip a denylist of known
 * producers, which is the bug shape this module exists to end.
 */
const BYLINE_FIELDS = Object.freeze([
  'author_name',
  'author',
  'author_title',
  'handle',
  'username',
  'reviewer',
  'user_name',
  'platform',
  'site'
]);

/**
 * 'llm-web' is PRINTABLE as anonymous text. Why, and what was actually wrong:
 *
 * geminiSearchProvider calls Gemini with `tools: [{ google_search: {} }]` —
 * real grounded search — and records `groundingMetadata.groundingChunks` as
 * source domains. The prompts demand SPECIFIC, DIRECT customer quotes in
 * quotation marks and "do NOT paraphrase or invent quotes that aren't
 * present." Gemini is the RETRIEVAL mechanism, not the author. These are real
 * sentences from real review pages.
 *
 * What WAS broken was ATTRIBUTION. The observed bylines —
 * "Reddit (r/BuyItForLife)", "UBeauty.com", and — 80 times —
 * "vertexaisearch.cloud.google.com" (Google's own grounding-redirect
 * hostname, printed as if it were the customer who spoke) — are SOURCES, not
 * people. That liability is separable from the words: print the text, never
 * a byline. toPrintableCustomerQuote enforces the strip; isPrintableCustomerQuote
 * alone would have left author fields intact for any caller that checked the
 * boolean and then used the original object.
 *
 * 'synthesized' stays excluded: that was LLM prose ABOUT reviews (genuinely
 * fabricated), and its producer was deleted. 'unknown' stays excluded by
 * omission.
 *
 * ── verbatim semantics ──────────────────────────────────────────────────
 * `verbatim: false` is NOT a blanket fidelity confession.
 *
 * On first-party origins (scraped / social_comment / store-import) it means
 * "this wording was rewritten or is not the customer's own text" and still
 * hard-rejects.
 *
 * On 'llm-web' it is a SOURCE-CLASS marker. geminiSearchProvider stamps
 * `verbatim: false` blanket on every row so a consumer that needs a genuine
 * first-party scrape can tell the difference (see stampLlmQuotes header).
 * Treating that stamp as "untrustworthy wording" re-excluded ~82% of the pool
 * and left ads with no testimonial at all. The gate therefore ignores
 * `verbatim` for ANONYMOUS_PRINT_ORIGINS.
 */
function toPrintableCustomerQuote(q) {
  if (!q || !String(q.text || '').trim()) return null;
  if (!PRINTABLE_QUOTE_ORIGINS.has(q.origin)) return null;

  // Fidelity confession only for first-party origins. See header.
  if (q.verbatim === false && !ANONYMOUS_PRINT_ORIGINS.has(q.origin)) return null;

  // First-party (and any future attributed printable origin): keep as-is.
  // Return a shallow copy so callers cannot mutate the pool entry through the
  // gate's return value, and so the reseat path in video/static gates is uniform.
  if (!ANONYMOUS_PRINT_ORIGINS.has(q.origin)) {
    return { ...q };
  }

  // Structural anonymity: copy, then force every byline field OFF the object.
  // delete (not undefined assignment) so `in` checks and JSON both see absence,
  // and so a renderer that does `quote.author_name || quote.author || quote.source`
  // cannot resurrect a site-as-author from residual keys. `source` is also
  // stripped from the printable surface for the same reason — it is a domain /
  // platform label, not a person, and was the historical byline fallback.
  const out = { ...q };
  for (const f of BYLINE_FIELDS) {
    delete out[f];
  }
  delete out.source;
  // A "Verified buyer" claim without a name is still a persona. Drop it.
  delete out.verified;
  return out;
}

function isPrintableCustomerQuote(q) {
  return toPrintableCustomerQuote(q) != null;
}

// ── QUOTE_PROVENANCE_STRICT ──────────────────────────────────────────
// Selection-only. Never edits quote text. Flag-off is a no-op identity on
// every helper below, so a caller that never opts in stays byte-identical.
//
// Live defect (2026-08-12): a media-driven Vuori ad with no CatalogProduct
// attached fell through to the brand review pool and printed a bomber-jacket
// quote over a track-pants + sneakers scene. Fixed FLAG-ON at the time, but
// scoped "product-attached → identity" (owner 2026-08-12: "helping vs
// hurting, not provenance") — and DEFAULT OFF, so the whole mechanism was
// dormant unless an operator opted in.
//
// ⚠️ REVERSED 2026-08-19 (art-direction review of run_1787119100250_eef4d871,
// product 6a6624fe5f5af85a46562e38 — a Vuori tee with zero productReviews of
// its own). Both scoping choices above turned out to be the SAME hole the
// 2026-08-12 fix was written for, just reached through the door it left
// open: this ad IS product-attached (CatalogProduct id set, `product._id`
// present at render time), so `productAttached: true` bypassed the noun
// check entirely and the LayoutInputArtifact's cached primary_quote was
// left holding the bomber-jacket line verbatim (measured directly in Mongo).
// It happened not to reach the delivered pixels on that run only because
// `selectRotatedQuote`'s hash(campaignRunId) % pool.length landed on a
// different, generic candidate for every one of the 18 statics — a lucky
// modulus, not a guard. A different run id, product, or pool size rotates
// the SAME contaminated pool onto the bomber line with no defence at all.
// "Helping vs hurting" does not survive contact with a quote that names a
// SPECIFIC OTHER garment: that is not weaker proof, it is proof about the
// wrong item, exactly as damaging on a product ad as on a media-driven one.
//
// Rules, now DEFAULT ON:
//   1. Product attached → noun-checked too, same as media-driven, with the
//      product's own title/labels added to the allowed set (so a quote
//      naming THIS product's own garment type — "tee"/"shirt" on a tee ad —
//      still passes). QUOTE_BRAND_TIER_FALLBACK is unaffected: the brand
//      tier still only wins last-resort, when product/category/comment are
//      empty. This only narrows WHICH brand quotes are eligible in that
//      last-resort slot, never whether the tier itself runs.
//   2. No product (media-driven / brand ads — the original Vuori case)
//      → a brand-pool quote that NAMES a product-type noun is kept only
//      when that noun (singular or plural, case-insensitive) appears in
//      the seed Media's detected product labels (or an explicit product
//      title / extraText passed as label text). Else try the next
//      candidate; if none pass, drop the quote.
//   3. A quote that names no product-type noun is GENERIC and is kept —
//      in both (1) and (2). A generic "I love this brand's quality" line
//      is not attributed to any garment, so it cannot be attributed to the
//      WRONG one; withholding it would be provenance theatre, not safety.
//
// Kill switch unchanged in shape, flipped in default: QUOTE_PROVENANCE_STRICT
// (config/defaults.env) now defaults 'true'. Setting it 'false' restores the
// pre-2026-08-19 identity on every helper below, including the
// product-attached bypass — a full revert, no deploy needed beyond the env
// value.

const PRODUCT_NOUNS = Object.freeze([
  'jacket', 'hoodie', 'dress', 'pants', 'jogger', 'shirt', 'tee',
  'shoe', 'sneaker', 'sandal', 'shorts', 'legging', 'bra',
  'hat', 'scarf', 'bag', 'sock', 'sweater', 'coat', 'vest', 'skirt',
  'swimsuit', 'bikini', 'crewneck', 'pullover', 'sweatshirt',
  'flip-flop', 'top'
]);

// Same garment, different shop-floor words. First member of each group
// that is listed in PRODUCT_NOUNS is the canonical the matcher emits.
const NOUN_SYNONYM_GROUPS = Object.freeze([
  ['shirt', 'tee', 't-shirt', 'tshirt'],
  ['sneaker', 'shoe']
]);

// Media fields collectScopeLabelText reads. Live render callers must
// select at least these or the seed-label rule is a no-op.
const QUOTE_SCOPE_MEDIA_SELECT = 'subjects refinedProducts primarySubjectLabel primarySubjectDesc classification';

function quoteProvenanceStrictEnabled() {
  return String(process.env.QUOTE_PROVENANCE_STRICT ?? 'true').toLowerCase() !== 'false';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Conservative inflection: the listed stem plus a regular English plural.
// pants is already plural (pant is accepted). shorts is listed WITHOUT
// its singular — "short" is an adjective ("short delivery", "in short")
// far more often than a garment, and mapping both to one canonical is
// how a training-time quote was rejected over track pants. Label-side
// "Kore Short" is recovered separately in productNounsIn({ fromLabel }).
// scarf → scarves; dress → dresses.
// The map is form → canonical listed noun so "jackets" and "jacket" agree.
function nounForms(noun) {
  const n = String(noun || '').toLowerCase();
  if (!n) return [];
  const forms = new Set([n]);
  if (n === 'pants') {
    forms.add('pant');
  } else if (n === 'shorts') {
    // do not add 'short' — adjective hole
  } else if (n === 'scarf') {
    forms.add('scarfs');
    forms.add('scarves');
  } else if (n.endsWith('s')) {
    forms.add(`${n}es`);
  } else if (n.endsWith('y') && n.length > 1 && !/[aeiou]y$/.test(n)) {
    forms.add(`${n.slice(0, -1)}ies`);
  } else {
    forms.add(`${n}s`);
    if (n.endsWith('ss') || n.endsWith('x') || n.endsWith('z') || n.endsWith('ch') || n.endsWith('sh')) {
      forms.add(`${n}es`);
    }
  }
  return [...forms];
}

const NOUN_FORM_TO_CANONICAL = (() => {
  const map = new Map();
  const stemToCanon = new Map();
  for (const noun of PRODUCT_NOUNS) stemToCanon.set(noun, noun);
  for (const group of NOUN_SYNONYM_GROUPS) {
    const canon = group.find((g) => stemToCanon.has(g)) || group[0];
    for (const member of group) stemToCanon.set(member, canon);
  }
  const stems = new Set([...PRODUCT_NOUNS, ...NOUN_SYNONYM_GROUPS.flat()]);
  for (const stem of stems) {
    const canon = stemToCanon.get(stem) || stem;
    for (const form of nounForms(stem)) {
      if (!map.has(form)) map.set(form, canon);
    }
  }
  return map;
})();

// "top" as a garment vs "top quality" / "on top of". Used only when the
// matched token canonicalizes to 'top'.
const ADJECTIVE_TOP_AFTER_RE = /^\s+(quality|notch|rated|tier|of|shelf|speed|priority|choice|perform)/i;
const IDIOM_TOP_BEFORE_RE = /\b(on|from|to|at)\s+(the\s+)?$/i;

const PRODUCT_NOUN_RE = new RegExp(
  `\\b(${[...NOUN_FORM_TO_CANONICAL.keys()].map(escapeRe).join('|')})\\b`,
  'gi'
);

function quoteTextOf(quote) {
  if (quote == null) return '';
  if (typeof quote === 'string') return quote;
  return String(quote.text || quote.body || quote.content || '');
}

/**
 * Canonical PRODUCT_NOUNS named in `text` (singular/plural, case-insensitive,
 * word-boundary). Selection input only — the source string is not edited.
 */
function productNounsIn(text, opts = {}) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const found = [];
  const seen = new Set();
  // Fresh regex: a module-level /g lastIndex would skip on the next call.
  const re = new RegExp(PRODUCT_NOUN_RE.source, 'gi');
  for (const m of src.matchAll(re)) {
    const raw = String(m[1] || m[0]).toLowerCase();
    const canonical = NOUN_FORM_TO_CANONICAL.get(raw);
    if (!canonical || seen.has(canonical)) continue;
    if (canonical === 'top' && isAdjectiveOrIdiomTop(src, m.index, m[0])) continue;
    seen.add(canonical);
    found.push(canonical);
  }
  // Label-only: a product titled "Kore Short" must unlock shorts quotes.
  // Quote text never takes this path — "short delivery" stays generic.
  if (opts.fromLabel && /\bshort\b/i.test(src) && !seen.has('shorts')) {
    seen.add('shorts');
    found.push('shorts');
  }
  return found;
}

function isAdjectiveOrIdiomTop(src, index, matched) {
  const before = src.slice(Math.max(0, index - 16), index);
  const after = src.slice(index + String(matched || '').length);
  if (ADJECTIVE_TOP_AFTER_RE.test(after)) return true;
  if (IDIOM_TOP_BEFORE_RE.test(before) && /^\s*(of\b|$)/i.test(after)) return true;
  return false;
}

function pushLabel(parts, value) {
  if (value == null) return;
  const s = String(value).trim();
  if (s) parts.push(s);
}

/**
 * Flatten every detected product label we trust for scope matching.
 *
 * Exact fields (verified against models + writers):
 *   productTitle                         — CatalogProduct.title / ad product name
 *   media.subjects[].label               — sometimes present on Mixed subjects
 *   media.subjects[].description         — subjectTextService (no .label there)
 *   media.primarySubjectLabel            — Phase A-0 chip ("Sneakers")
 *   media.primarySubjectDesc
 *   media.refinedProducts[].label        — YOLO / refine (the reliable "what's in frame")
 *   media.refinedProducts[].description
 *   media.classification.detectSummary.matchedProducts[].name
 *   match.identification.productName     — productMatch title
 *   match.catalogMatch.product.title     — catalog winner snapshot
 */
function collectScopeLabelText({ productTitle, media, match, extraText } = {}) {
  const parts = [];
  pushLabel(parts, productTitle);
  pushLabel(parts, extraText);
  const medias = Array.isArray(media) ? media : (media ? [media] : []);
  for (const m of medias) {
    if (!m || typeof m !== 'object') continue;
    pushLabel(parts, m.primarySubjectLabel);
    pushLabel(parts, m.primarySubjectDesc);
    for (const s of (Array.isArray(m.subjects) ? m.subjects : [])) {
      if (!s || typeof s !== 'object') continue;
      pushLabel(parts, s.label);
      pushLabel(parts, s.description);
    }
    for (const rp of (Array.isArray(m.refinedProducts) ? m.refinedProducts : [])) {
      if (!rp || typeof rp !== 'object') continue;
      pushLabel(parts, rp.label);
      pushLabel(parts, rp.description);
    }
    const detected = m.classification?.detectSummary?.matchedProducts;
    if (Array.isArray(detected)) {
      for (const p of detected) {
        if (!p || typeof p !== 'object') continue;
        pushLabel(parts, p.name);
        pushLabel(parts, p.title);
      }
    }
  }
  if (match && typeof match === 'object') {
    pushLabel(parts, match.identification?.productName);
    pushLabel(parts, match.catalogMatch?.product?.title);
    pushLabel(parts, match.catalogMatch?.productName);
    pushLabel(parts, match.catalogMatch?.title);
  }
  return parts.join(' ');
}

/**
 * True when every product-type noun the quote names also appears (as that
 * noun or its plural) in the allowed label text. A quote that names none
 * of the listed nouns is GENERIC and is allowed.
 */
function quoteAllowedForScope(quote, allowedLabelText) {
  const named = productNounsIn(quoteTextOf(quote));
  if (!named.length) return true;
  const allowed = new Set(productNounsIn(allowedLabelText, { fromLabel: true }));
  return named.every((noun) => allowed.has(noun));
}

function isBrandQuoteAllowedForSeed(quote, scope = {}) {
  return quoteAllowedForScope(quote, collectScopeLabelText(scope));
}

/**
 * Brand-pool selector. Flag-off returns the input list unchanged (same
 * array reference when one was passed).
 *
 * Flag-on noun-filters EVERY caller, product-attached or not — reversed
 * 2026-08-19, see the QUOTE_PROVENANCE_STRICT header above. A quote naming
 * no product-type noun (GENERIC) always passes, on both branches, so
 * QUOTE_BRAND_TIER_FALLBACK's last-resort role on a product ad is
 * unaffected for the common case (a brand-wide compliment with no garment
 * word). What is newly refused is a brand quote that names a DIFFERENT
 * specific garment than the one this ad is for — `opts.productTitle`
 * (already threaded by every caller of this function) is folded into the
 * allowed label text precisely so a quote about THIS product's own
 * garment type ("tee"/"shirt" on a tee ad) still passes; only a mismatch
 * is dropped. Never mutates quote objects.
 */
function selectBrandQuotesForScope(quotes, opts = {}) {
  const list = Array.isArray(quotes) ? quotes : [];
  if (!quoteProvenanceStrictEnabled()) return list;
  return list.filter((q) => isBrandQuoteAllowedForSeed(q, opts));
}

function pickScopedBrandQuote(quotes, opts = {}) {
  const scoped = selectBrandQuotesForScope(quotes, opts);
  return scoped[0] || null;
}

/**
 * Render-time defence for a single already-chosen quote (cached
 * LayoutInputArtifact / Director copy, or a rotated pick). Flag-off
 * returns `quote` as-is.
 *
 * Product-attached and media-driven are noun-checked THE SAME WAY as of
 * 2026-08-19 (see the QUOTE_PROVENANCE_STRICT header) — this is the last
 * gate before a quote reaches the prompt, so it is where the Vuori
 * bomber-jacket line would have been caught had it reached this function
 * (it did not, on the measured run, only because rotation never selected
 * it — see the header). `opts.productTitle` folds the ad's own product
 * into the allowed set, so a quote naming this product's own garment type
 * still passes; only a genuinely different garment is dropped.
 * Non-brand tiers (product/category/comment) pass through unconditionally —
 * they are already scoped to this product or its media by construction.
 */
function applyStrictQuoteScope(quote, opts = {}) {
  if (!quoteProvenanceStrictEnabled()) return quote;
  if (!quote) return quote;
  const tier = quote.tier || null;
  // Unstamped legacy rows are treated as brand-tier (the historically
  // riskiest, least-scoped pool) and noun-checked; product/category/comment
  // tiers are already scoped to this product or its media and pass through.
  if (tier && tier !== 'brand') return quote;
  return isBrandQuoteAllowedForSeed(quote, opts) ? quote : null;
}

async function loadQuoteScopeMedia(mediaId) {
  if (!mediaId) return null;
  const Media = require('../models/Media');
  return Media.findById(mediaId).select(QUOTE_SCOPE_MEDIA_SELECT).lean();
}

async function loadQuoteScopeMediaByIds(ids) {
  const list = [];
  const seen = new Set();
  for (const id of (Array.isArray(ids) ? ids : [])) {
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(id);
  }
  if (!list.length) return [];
  const Media = require('../models/Media');
  return Media.find({ _id: { $in: list } }).select(QUOTE_SCOPE_MEDIA_SELECT).lean();
}

module.exports = {
  PRINTABLE_QUOTE_ORIGINS,
  ANONYMOUS_PRINT_ORIGINS,
  BYLINE_FIELDS,
  toPrintableCustomerQuote,
  isPrintableCustomerQuote,
  PRODUCT_NOUNS,
  NOUN_SYNONYM_GROUPS,
  QUOTE_SCOPE_MEDIA_SELECT,
  quoteProvenanceStrictEnabled,
  productNounsIn,
  collectScopeLabelText,
  quoteAllowedForScope,
  isBrandQuoteAllowedForSeed,
  selectBrandQuotesForScope,
  pickScopedBrandQuote,
  applyStrictQuoteScope,
  loadQuoteScopeMedia,
  loadQuoteScopeMediaByIds
};
