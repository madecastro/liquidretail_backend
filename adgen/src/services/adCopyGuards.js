'use strict';

/**
 * Copy-level advertising-claim guards shared by the Director validator and
 * the static-prompt furniture path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three delivered static ads (Soludos meta_feed_4_5 + meta_stories_9_16,
 * Pelagic pmax_landscape_1_91_1) rendered an `ai_social_proof_led` rating as
 * a HEADLINE with no star row, numeral, or review count on frame. The
 * Soludos line — "Rated 5 Stars By Everyone Who's Tried Them" — is an
 * unqualified universal endorsement: almost certainly false, unsubstantiated,
 * and printed with nothing on frame to support it.
 *
 * Two layers, one flag (`STATIC_RATING_FURNITURE`, default ON):
 *   1. The static prompt demands a rating WIDGET and names those headlines
 *      as failures (services/staticAdIntents.js).
 *   2. validateDirectorPayload rejects the same language in concept.copy so
 *      a brand_led (or any other) concept cannot print it as a BRAND LINE.
 *
 * The detector lives here so the validator and the harness call ONE function
 * rather than each re-implementing a regex. Classify by phrase family, not
 * exact string — the image model paraphrases. Do NOT ban the word "rated":
 * "Rated 4.8 by 2,341 verified buyers" is a substantiated proof headline.
 *
 * Flag-off (`STATIC_RATING_FURNITURE=false`) restores the previous Director
 * validator behaviour (this scan does not run) and the previous static
 * prompt (the furniture note / absence are not emitted). Byte-identical
 * prompt restore is owned by the callers; this module only reads the flag.
 */

function ratingFurnitureEnabled() {
  return process.env.STATIC_RATING_FURNITURE !== 'false';
}

/**
 * Unqualified universal-endorsement family. Tight on purpose: `\beveryone\b`
 * alone would reject legitimate brand voice ("not for everyone"). Each
 * branch is independently anchored so a leading non-word character cannot
 * silently drop a match (same lesson as claimSubstantiationService).
 */
const UNIVERSAL_ENDORSEMENT_PATTERNS = Object.freeze([
  /\bby everyone\b/i,
  /\beveryone who['’]?s tried\b/i,
  /\beveryone who has tried\b/i,
  /\beveryone that['’]?s tried\b/i,
  /\beveryone that has tried\b/i,
  /\buniversally\b/i,
  /\ball customers\b/i,
  /\bevery customer\b/i,
  /\ball who['’]?ve tried\b/i,
  /\ball who have tried\b/i,
  /\ball who tried\b/i
]);

function hasUniversalEndorsement(text) {
  const s = String(text || '');
  if (!s) return false;
  return UNIVERSAL_ENDORSEMENT_PATTERNS.some((re) => re.test(s));
}

/**
 * "brand-wide" is the Director's scope disclosure for a brand-tier rating
 * with no count (`buildDirectorProofOptions` → `reviews_text: "brand-wide
 * rating"`). As a qualifier beside brand-level stars it is the honest
 * demarcation the owner asked for. As a headline adjective it is jargon
 * and is how Pelagic's "5-star brand-wide rating" shipped with no widget.
 *
 * BRAND_SCOPE_LABEL itself (`brand reviews`) is NOT banned — it belongs
 * next to the number in the widget.
 */
const SCOPE_AS_HEADLINE_RE = /\bbrand-wide\b/i;

function hasScopeAsHeadline(text) {
  return SCOPE_AS_HEADLINE_RE.test(String(text || ''));
}

/**
 * @param {string} text  Joined copy (headline + subhead + other copy fields).
 * @returns {{code:string, message:string}|null}
 */
function copyFailsCompliance(text) {
  const s = String(text || '');
  if (!s) return null;
  if (hasUniversalEndorsement(s)) {
    return {
      code: 'universal-endorsement',
      message: 'contains unqualified universal-endorsement language ("by everyone", "everyone who\'s tried them", "universally", "all customers"), which is never emittable'
    };
  }
  if (hasScopeAsHeadline(s)) {
    return {
      code: 'scope-as-headline',
      message: 'uses "brand-wide" as copy — that scope label belongs next to the rating widget, not in a headline'
    };
  }
  return null;
}

module.exports = {
  ratingFurnitureEnabled,
  UNIVERSAL_ENDORSEMENT_PATTERNS,
  hasUniversalEndorsement,
  hasScopeAsHeadline,
  copyFailsCompliance
};
