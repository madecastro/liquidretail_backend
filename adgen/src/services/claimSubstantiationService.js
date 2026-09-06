'use strict';

/**
 * claimSubstantiationService — ONE gate for "may a proof/superiority badge
 * string reach delivered ad creative".
 *
 * WHY THIS EXISTS
 * ----------------
 * PR #138 (fix/drop-bestseller-claim) removed a single hardcoded literal —
 * metaCascadeConfig.badgeText's `{ type: 'literal', value: 'Bestseller' }`
 * fallback — because it printed "Bestseller" on precisely the products with
 * no evidence of being one. Its harness (scripts/verifyNoUnearnedClaims.js)
 * pins that no CASCADE LITERAL may assert an unearned claim.
 *
 * It did not close the other door. `input.product.badges` is populated at
 * services/layoutInputService.js `assembleInput()` by merging (a) whatever
 * `derivation.badges` a Gemini structured-output call invented and (b)
 * `defaultBadgesFromSignal()`'s own deterministic append. The derivation
 * PROMPT (buildDerivationPrompt, ~line 1247 as of this writing) literally
 * lists "Top rated", "Editor's pick", "Best seller" as badge examples with
 * no evidence attached, and the schema places no allowlist on the strings
 * it returns — the model is free to invent anything in the same register.
 * Confirmed live: run_1787174963435_ff67021e (Marine Layer 2, "Custom Cut &
 * Sew Bode Puffer Jacket") shipped 21 video ads with
 * badges=["Top rated","Best seller","Sustainably made"] while
 * rating=null/reviewCount=null — zero supporting evidence for any of the
 * three, including a specifically regulated environmental claim ("Sustainably
 * made" — FTC Green Guides territory) the LLM invented beyond even the
 * prompt's own (ungated) examples.
 *
 * DOCTRINE
 * --------
 * Classify by CLAIM CATEGORY, not by exact string — the LLM paraphrases, so
 * a blocklist of today's three strings would not survive tomorrow's
 * wording. Two disjoint failure modes:
 *
 *   (1) BARRED OUTRIGHT. No catalog field exists, ever, to substantiate
 *       this category, at any rating/review-count:
 *         - sales-rank / commercial-standing claims ("Best seller", "Top
 *           seller", "#1", "Most popular", "Editor's pick", "Trending"...).
 *           models/CatalogProduct.js declares rating / reviewSummary /
 *           reviews / specs / sellers — there is no salesRank, isBestSeller,
 *           units-sold, or editorial-endorsement field anywhere in the
 *           schema. This generalizes PR #138's specific judgment ("Bestseller
 *           unearned it is a false advertising claim") to the whole claim
 *           family it represents, per the instruction to design against the
 *           CLASS, not the string.
 *         - environmental / ethical / certification claims ("Sustainably
 *           made", "Eco-friendly", "Organic", "Cruelty-free"...).
 *           CatalogProduct has no materials/certifications/sustainability
 *           field at all, and these are a SPECIFICALLY REGULATED marketing
 *           category (FTC Green Guides and equivalents) independent of
 *           ordinary puffery norms — there is no threshold at which "we hold
 *           no field for this" becomes substantiated, so it is barred
 *           outright rather than evidence-gated.
 *
 *   (2) EVIDENCE-GATED. May render only when the ad's own REAL,
 *       already-coherent rating/reviewCount pair (the exact numbers
 *       services/brandScriptExecutor.js's resolveCoherentSocialProof
 *       chokepoint already resolved for the printed star line — NOT the
 *       LLM's own stated number) clears both a rating floor and a minimum
 *       sample floor:
 *         - "Top rated" / "highly rated" / an explicit star count
 *         - a review-volume claim ("1k+ reviews", "Trusted by 5k+
 *           customers") — additionally, the SPECIFIC asserted tier must not
 *           exceed the real count.
 *
 * THRESHOLDS — reused from existing, owner-reviewed constants already live
 * in this codebase, not invented fresh for this gate:
 *
 *   RATING_CLAIM_MIN = 4.5   Matches services/aiCreativeDirectorService.js
 *                            PMAX_PROOF_STRONG_RATING (default 4.5) — the
 *                            existing "strong rating" floor for proof-
 *                            strength decisions elsewhere in this pipeline.
 *                            Also matches the ORIGINAL owner rule quoted in
 *                            services/ratingDisplay.js ("we only use stars
 *                            over 4.5"), which that file's RATING_STAR_MIN
 *                            (4.39) supersedes for bare NUMBER DISPLAY —
 *                            deliberately not reused here, because a
 *                            superiority CLAIM ("Top rated") is a stronger
 *                            assertion than printing the number itself, and
 *                            4.5 is the bar the owner set for exactly that
 *                            stronger assertion (PMax "RATING-FIRST /
 *                            popularity-framing").
 *
 *   SAMPLE_FLOOR = 100       Matches services/aiCreativeDirectorService.js
 *                            PMAX_PROOF_MIN_REVIEW_COUNT (default 100) — the
 *                            existing "substantial count" floor already
 *                            established in this codebase for proof-
 *                            strength decisions ("below this, omit the
 *                            count"). The compliance audit that produced
 *                            this task flagged "4.5★ From 11 Reviews" as
 *                            thin proof already reaching an ad; 11 fails
 *                            this floor by 89, and would also fail a much
 *                            more lenient one — 100 is not a close call here,
 *                            it is a pre-existing, owner-reviewed number.
 *
 * SCOPE — what "unclassified" means, and why it PASSES THROUGH
 * ---------------------------------------------------------------
 * A blast-radius query against production (684 ads carrying any
 * badge/badgeText/deliveryLine content, 2026-08-19) surfaced 229 distinct
 * strings already shipped. The great majority of VOLUME is exactly the two
 * barred categories this gate targets — "Top Rated" (415), "Best Seller"
 * (368), "Customer Favorite" (70), "Editor's Pick" (57), "Sustainably Made"
 * (51), "Community Favorite" (41), "Fan Favorite" (17), "Bestseller" (16),
 * "Eco-Friendly" (5) among them — but the same data also contains a long
 * tail of plain descriptive/attribute badges that are NOT comparative-
 * superiority or environmental/ethical claims: "All-Day Comfort",
 * "Machine Washable", "100% Cotton", "So Versatile", "New Arrival",
 * "UPF 50+ Protection", "Official NFL Licensed", "Peloton Collab". These
 * are ordinary product-attribute puffery or factual product/partnership
 * statements — not the "comparative/superiority claims" or "regulated
 * environmental claim" this gate exists to close, and FTC guidance
 * distinguishes exactly this way (subjective puffery vs. an objectively
 * checkable superiority or environmental assertion). An earlier version of
 * this gate defaulted 'unclassified' to the FULL evidence bar and would
 * have stripped essentially the entire 650-ad candidate set as a side
 * effect — correct for the ~400 sales/rating-standing and environmental
 * instances, false-positive scope creep for the rest. So: 'unclassified'
 * PASSES THROUGH. The two BARRED-OUTRIGHT patterns below are written
 * broad (word families, not literal strings) and validated against this
 * real production vocabulary specifically so the fail-closed guarantee
 * lands on the categories that actually carry legal exposure, not on
 * every string the gate doesn't recognize. Extend the patterns — not a
 * bare literal-value ban, and not the unclassified default — when a new
 * risky rewording is observed; see PROOF: run the blast-radius query
 * again after any pattern change and confirm nothing in the barred
 * families regressed to 'unclassified'.
 */

// ── Claim category patterns ────────────────────────────────────────────
// Deliberately broad (word families, not literal strings) so a rewording
// the LLM has not produced yet is still caught by the CATEGORY it belongs
// to. Extend these lists as new invented phrasing is observed — do NOT
// add a new bare literal-value ban anywhere else; route every new example
// through classify() so it inherits the evidence rule instead of a fragile
// exact-match ban.

// Each category is a LIST of small, independently-anchored regexes rather
// than one giant `\b(?:a|b|c)\b` alternation — a single outer `\b` wrapping
// the whole alternation silently fails for any branch that starts with a
// non-word character (e.g. "#1": \b cannot hold between two non-word
// positions), and a shared alternation makes it easy for one branch to
// unintentionally shadow another category's pattern (both bugs were caught
// by this file's own harness during development — see
// scripts/verifyClaimSubstantiation.js). `matchesAny` below runs `.test()`
// per pattern so every entry gets its own correct anchoring.
function matchesAny(patterns, s) {
  return patterns.some((re) => re.test(s));
}

// Sales-rank / commercial-standing / endorsement claims — barred outright
// (see doctrine above). Includes PR #138's original "Bestseller".
// Deliberately EXCLUDES anything about a numeric star RATING (that is
// RATING_QUALITY_CLAIM's job, evidence-gated rather than barred) — "top
// rated" and "highest rated" are rating claims, not standing claims, even
// though the word "top" appears in both.
const SALES_STANDING_PATTERNS = [
  /\bbest[- ]?sell(?:er|ing)s?\b/i,
  /\btop[- ]?sell(?:er|ing)s?\b/i,
  /#\s?1\b/,
  /\bno\.?\s?1\b/i,
  /\bnumber\s+one\b/i,
  /\bmost\s+popular\b/i,
  // Deliberately generic, not "fan|customer|staff|editor's" only —
  // production already carries "Community Favorite", "Summer Favorite",
  // "Seasonal Favorite", "Cult Favorite", "Viral Fave", "SF favorite",
  // "Fitness Fave": ANY qualifier in front of "favorite/fave" asserts the
  // same unsubstantiated popularity claim, and the qualifier vocabulary is
  // exactly the kind of rewording this gate has to survive with no code
  // change.
  /\b(?:\w+[- ])?(?:favou?rite|fave)s?\b/i,
  /\b(?:staff|editor'?s?|customer)[- ]?(?:pick|choice)s?\b/i,
  /\btop\s+(?:choice|pick)\b/i,
  /\btrending(?:\s+now)?\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\bmost[- ]loved\b/i,
  /\baward[- ]winning\b/i,
  /\bas\s+seen\s+on\b/i,
];

// Environmental / ethical / regulated-attribute claims — barred outright,
// independent of any evidence (see doctrine above). Includes generic
// "certified"/"certification" and "B Corp" — a real, checkable third-party
// status, but this pipeline holds no field recording it (same reasoning as
// sustainability: "we hold no field for this" never becomes substantiated
// by adding a threshold).
const UNVERIFIABLE_ATTRIBUTE_PATTERNS = [
  /\bsustainabl[ey](?:\s+made)?\b/i,
  /\beco[- ]?friendly\b/i,
  /\benvironmentally[- ]friendly\b/i,
  /\borganic\b/i,
  /\bcruelty[- ]?free\b/i,
  /\bvegan\b/i,
  /\bnon[- ]?toxic\b/i,
  /\bchemical[- ]?free\b/i,
  /\bbiodegradable\b/i,
  /\bcompostable\b/i,
  /\bcarbon[- ]?(?:neutral|positive)\b/i,
  /\bclimate[- ]?positive\b/i,
  /\bnet[- ]?zero\b/i,
  /\bzero[- ]?waste\b/i,
  /\bfair[- ]?trade\b/i,
  /\bethically[- ](?:made|sourced|produced)\b/i,
  /\bresponsibly[- ](?:made|sourced)\b/i,
  /\bconflict[- ]?free\b/i,
  /\bhypoallergenic\b/i,
  /\bclinically[- ]proven\b/i,
  /\b(?:doctor|dermatologist)[- ]recommended\b/i,
  /\ball[- ]?natural\b/i,
  /\bclean\s+ingredients?\b/i,
  /\bplastic[- ]?free\b/i,
  /\brecycled\s+materials?\b/i,
  /\bb[- ]?corp\b/i,
  /\bcertifi(?:ed|cation)s?\b/i,
];

// Real rating-quality claim. Only ever substantiated by the ad's own
// coherent rating pair (never by the LLM's own stated star value). The
// star-count pattern allows a hyphen between the digit and "star"
// (production carries "5-Star Rated", "5-Star Comfort") as well as a
// space/decimal ("4.8★ Rated") — ANY explicit numeric star count is
// treated as a rating assertion regardless of the noun that follows, since
// it still reads as "reviewers rated this N stars".
const RATING_QUALITY_PATTERNS = [
  /\btop[- ]?\s?rated\b/i,
  /\bhighly[- ]rated\b/i,
  /\bhighest[- ]rated\b/i,
  // \b placed only after the WORD form ("stars?") — "★" is a symbol, not a
  // \w character, so a trailing \b right after it fails whenever the next
  // character is also non-word (e.g. a space before "Rated": "4.8★ Rated"),
  // since \b needs exactly one side to be \w. Caught by this file's own
  // harness (C5) during development.
  /\d(?:\.\d)?[\s-]*(?:★|stars?\b)/i,
];

// Review-volume claim, e.g. "1k+ reviews", "100+ reviews",
// "Trusted by 5k+ customers". Captures the asserted number so the SPECIFIC
// tier can be checked against the real count, not just "some count exists".
const REVIEW_VOLUME_CLAIM = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*\+?\s*(?:reviews?|ratings?|customers?)\b/i;

const RATING_CLAIM_MIN = 4.5;
const SAMPLE_FLOOR = 100;

/**
 * Classify a single candidate badge string.
 * @returns {'unverifiable_attribute'|'sales_standing'|'rating_quality'|'review_volume'|'unclassified'|null}
 */
function classify(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return null;
  // Order matters: an environmental/sales phrase that happens to also
  // contain a number ("#1 eco-friendly pick") must still be barred
  // outright, so those two categories are checked before the evidence-
  // gated ones.
  if (matchesAny(UNVERIFIABLE_ATTRIBUTE_PATTERNS, s)) return 'unverifiable_attribute';
  if (matchesAny(SALES_STANDING_PATTERNS, s)) return 'sales_standing';
  if (matchesAny(RATING_QUALITY_PATTERNS, s)) return 'rating_quality';
  if (REVIEW_VOLUME_CLAIM.test(s)) return 'review_volume';
  return 'unclassified';
}

/** Parse the asserted count out of a review-volume string, e.g. "1k+ reviews" -> 1000. */
function parseAssertedCount(text) {
  const m = REVIEW_VOLUME_CLAIM.exec(String(text || ''));
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  return m[2] ? base * 1000 : base;
}

/**
 * Does this real evidence pair clear the FULL bar (rating claim + sample
 * floor)? Used for rating-quality claims only — see the module doc's
 * "SCOPE — what unclassified means" section for why this is NOT also the
 * default for unrecognized strings.
 */
function hasStrongSignal(rating, reviewCount) {
  return rating !== null && rating >= RATING_CLAIM_MIN
    && reviewCount !== null && reviewCount >= SAMPLE_FLOOR;
}

/**
 * Filter a list of candidate badge strings down to the substantiated
 * subset, given the SAME real rating/reviewCount pair that will print
 * beside them (the ad's own coherent numbers, not an LLM-stated figure).
 *
 * @param {Array<*>} candidates - raw badge strings (LLM-derived and/or any
 *   deterministic default), unfiltered, in priority order.
 * @param {{rating?: number|null, reviewCount?: number|null}} [evidence]
 * @returns {string[]} substantiated subset, original order preserved.
 */
function substantiateBadges(candidates, evidence = {}) {
  const rating = typeof evidence.rating === 'number' && Number.isFinite(evidence.rating)
    ? evidence.rating : null;
  const reviewCount = typeof evidence.reviewCount === 'number' && Number.isFinite(evidence.reviewCount)
    ? evidence.reviewCount : null;
  const strong = hasStrongSignal(rating, reviewCount);

  const out = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) continue;
    const category = classify(text);
    if (category === 'unverifiable_attribute' || category === 'sales_standing') {
      continue; // barred outright — no data field exists, ever
    }
    if (category === 'review_volume') {
      const asserted = parseAssertedCount(text);
      if (asserted !== null && reviewCount !== null && reviewCount >= asserted) out.push(text);
      continue;
    }
    if (category === 'rating_quality') {
      if (strong) out.push(text);
      continue;
    }
    // 'unclassified' — not a recognized comparative-superiority or
    // environmental/ethical claim pattern. Passes through unchanged; see
    // the module doc's "SCOPE" section. Extend the two barred-outright
    // patterns above (not this branch) when a new risky rewording shows up.
    out.push(text);
  }
  return out;
}

/**
 * Convenience: gate a single scalar badge value (e.g. cascaded.badgeText /
 * cascaded.deliveryLine) the same way as an array entry.
 * @returns {string|null}
 */
function substantiateBadge(value, evidence) {
  if (!value || typeof value !== 'string') return null;
  const kept = substantiateBadges([value], evidence);
  return kept.length ? kept[0] : null;
}

module.exports = {
  classify,
  parseAssertedCount,
  hasStrongSignal,
  substantiateBadges,
  substantiateBadge,
  RATING_CLAIM_MIN,
  SAMPLE_FLOOR,
  SALES_STANDING_PATTERNS,
  UNVERIFIABLE_ATTRIBUTE_PATTERNS,
  RATING_QUALITY_PATTERNS,
  REVIEW_VOLUME_CLAIM,
};
