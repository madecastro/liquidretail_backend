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
  'store-import'     // reviews imported from the merchant's own storefront
  // 'llm-web'     — an LLM found, extracted and attributed it. Excluded; see below.
  // 'synthesized' — LLM prose ABOUT reviews. Excluded, and its producer is deleted.
  // 'unknown'     — provenance we could not establish. Excluded by omission.
]);

/**
 * 'llm-web' is excluded, and it is the consequential call because it is ~82% of
 * the pool. Those quotes are not invented — they are real sentences from real
 * pages — but an LLM did the finding, the extracting and the attributing, and
 * nothing verified any of the three. geminiSearchProvider stamps them
 * `verbatim: false` itself, which is the capture layer saying it cannot youch
 * for the wording.
 *
 * The observed damage is not theoretical. That path is where bylines like
 * "Reddit (r/BuyItForLife)", "UBeauty.com" and — 80 times over —
 * "vertexaisearch.cloud.google.com" came from, and it collected negative quotes
 * ("the luxury price premium really wasn't worth it") into a pool whose only
 * gate for unrated tiers is sentiment.
 *
 * The owner's standing rule breaks the tie: an ad showing no testimonial is a
 * thinner ad; an ad misquoting a named stranger is a liability. If that trade is
 * ever revisited, revisit it in THIS FILE — it is the only place all three
 * renderers agree on.
 */
function isPrintableCustomerQuote(q) {
  if (!q || !String(q.text || '').trim()) return false;
  // An explicit non-verbatim stamp disqualifies whatever the origin claims.
  if (q.verbatim === false) return false;
  return PRINTABLE_QUOTE_ORIGINS.has(q.origin);
}

module.exports = { PRINTABLE_QUOTE_ORIGINS, isPrintableCustomerQuote };
