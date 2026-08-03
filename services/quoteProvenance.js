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

module.exports = {
  PRINTABLE_QUOTE_ORIGINS,
  ANONYMOUS_PRINT_ORIGINS,
  BYLINE_FIELDS,
  toPrintableCustomerQuote,
  isPrintableCustomerQuote
};
