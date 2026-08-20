'use strict';

/**
 * ONE definition of "may this badge print", for video/layout.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * PR #138 (bf0fd397) removed `{ type:'literal', value:'Bestseller' }` from
 * services/metaCascadeConfig.js badgeText because it printed a commercial
 * superlative exactly when the product had no evidence of being one. The
 * comment that landed with that change (metaCascadeConfig.js:115-130) is
 * the invariant: a badge "must come from real data on input.product.badges,
 * earned per product" — on-brand and true, or absent.
 *
 * The cascade door stayed closed. The LLM door was open. layoutInputService
 * asked Gemini for 2–4 badges with a SOFT preference for real signal and
 * literally handed it "Top rated", "Editor's pick", "Best seller" as
 * examples. Production scan of 1,345 LayoutInputArtifacts with non-empty
 * badges (2026-08-19):
 *   - 949 contain at least one unearned-standing claim
 *   - 676 of those have rating null AND reviewCount null
 *   - top strings: "top rated" x741, "best seller" x438, "customer favorite"
 *     x143, "fan favorite" x68, "community favorite" x40, "editor's pick"
 *     x34, "community fave" x24, "4.7★ rated" x36, "4.8★ rated" x31,
 *     "4.6★ rated" x20, "5-Star Quality"
 * Concrete case: CatalogProduct 6a7b72f4935d0a8e81905544 has
 * productReviews.rating=null, reviewCount=null, ratingCandidates=[]; its
 * artifact 6a862136b31cf7b2214a2945 carries
 * badges ["Top rated","Best seller","Sustainably made"].
 * badgeText binds input.product.badges[0], so element 0 is what prints.
 *
 * scripts/verifyNoUnearnedClaims.js previously scanned CASCADE LITERALS
 * only, so it was blind to this. The static path already hard-bans the
 * class (staticAdIntents.js:574: "never Best Seller, Top Rated, Customer
 * Favorite, #1 or As Seen On"). This module is the video/layout twin.
 *
 * THIS IS NOT A BLANKET BADGE BAN. Attribute / material / feature claims
 * ("Sustainably made", "Water resistant", "100% Recycled", "Machine
 * washable", "Limited edition", "New arrival") classify 'neutral' and
 * survive. Adjudicating those against the product description is a
 * DIFFERENT, out-of-scope problem. What this module forbids is a claim
 * about standing or performance that this data model cannot support.
 *
 * There is NO sales-rank, units-sold, bestseller, or award field on
 * CatalogProduct (its `sellers` field is aggregated Google-Shopping
 * *merchant* listings — which retailers stock the item — not a sales
 * rank). "Best seller", "#1", "Award-winning", "As seen on", "Editor's
 * pick", and "<X> favorite" can therefore NEVER be earned and are always
 * dropped, even when rating and reviewCount are excellent.
 *
 * FAIL-SAFE DIRECTION. When a badge is ambiguous, DROP it. An absent
 * badge costs a little polish; a printed false badge is a false-
 * advertising claim. That bias is deliberate.
 *
 * Matching order in classifyBadgeClaim is load-bearing:
 *   1. numeric rating form  ("4.7★ rated", "5-Star Quality")
 *   2. review-count form    ("1k+ reviews", "reviewed by thousands")
 *   3. never-earnable lexicon (sales / awards / editorial / rank /
 *      popularity) — so "Holiday Best Seller" hits best-seller, not
 *      the favorite alternative
 *   4. bare superlative rating ("Top rated", "Highly rated")
 *   5. neutral
 * "5-Star Quality" must classify 'rating', never 'never_earnable'.
 */

// Standing-claim scanner used by C2 (cascade literals) and F (prompt).
// EXTENSION of the regex that used to live in verifyNoUnearnedClaims.js:
// every original alternative is kept so C2 keeps its meaning, then the
// strings production actually invented are added. Includes forms the
// runtime MAY still print when the matching signal is present (top rated,
// N-star, highly rated) — those are unearned as a HARDCODED FALLBACK,
// which is what C2 guards, not unprintable as a data-backed badge.
//
// `#\s?1\b` and `no\.?\s*1\b` sit OUTSIDE the \b(?:...)\b group on purpose:
// `#` is a non-word character, so `\b#1` can never match the string "#1".
//
// SEPARATOR AND APOSTROPHE CLASSES ARE LOAD-BEARING. A first draft of this
// module used `best\s?seller` and `editor'?s`, and a probe of forms an LLM
// plausibly emits found EIGHT escapes straight through the filter:
// "Best-Seller" and "Best-seller" (hyphen instead of space — the exact
// claim PR #138 removed), "Top-seller", "Editor\u2019s pick" and
// "Editor\u2019s Choice" (U+2019 typographic apostrophe, which models emit
// constantly), "No. 1", and "No.1 seller". Every compound below therefore
// takes [-\s]? rather than \s?, and every possessive takes ['\u2019\u02bc]?
// rather than '?. Sales-VELOCITY wording ("sells out fast", "selling fast",
// "flying off shelves") and popularity wording ("most loved", "trending")
// were also missing and are now covered: both are factual claims about
// commercial performance with no field behind them.
//
// Deliberately still NEUTRAL: non-falsifiable puffery ("Premium quality",
// "Built to last", "Buttery soft"). Those assert no measurable standing,
// so there is no datum that could contradict them. The line this module
// draws is falsifiable-standing-claim in, puffery out.
const UNEARNED_CLAIM = /#\s?1\b|no\.?\s*1\b|\b(?:best[-\s]?seller|best[-\s]?sellers|bestselling|best[-\s]?selling|top[-\s]?seller|fastest[-\s]?selling|sell(?:s|ing)?[-\s]?out|selling[-\s]?fast|flying[-\s]?off|top\s?rated|number one|customer favou?rite|as seen (?:on|in)|award[-\s]winning|world['’ʼ]?s best|editor['’ʼ]?s (?:pick|choice)|\w+['’ʼ]s (?:pick|choice)|(?:customer|fan|community|shopper|staff|reader|local|holiday|festive|seasonal) favou?rite|favou?rite|fave|best[-\s]in[-\s]class|voted best|most popular|most loved|trending|\d+(?:\.\d+)?\s*-?\s*stars?|highly rated)\b/i;

// Runtime never-earnable subset: the standing claims NO field in this
// data model can ever back. Rating/review wording is intentionally
// absent — those are gated on a real number, not banned.
const NEVER_EARNABLE_RE = /#\s?1\b|no\.?\s*1\b|\b(?:best[-\s]?seller|best[-\s]?sellers|bestselling|best[-\s]?selling|top[-\s]?seller|fastest[-\s]?selling|sell(?:s|ing)?[-\s]?out|selling[-\s]?fast|flying[-\s]?off|number one|customer favou?rite|as seen (?:on|in)|award[-\s]winning|world['’ʼ]?s best|editor['’ʼ]?s (?:pick|choice)|\w+['’ʼ]s (?:pick|choice)|(?:customer|fan|community|shopper|staff|reader|local|holiday|festive|seasonal) favou?rite|favou?rite|fave|best[-\s]in[-\s]class|voted best|most popular|most loved|trending)\b/i;

const BARE_RATING_RE = /\b(?:top[- ]?rated|highly rated|well rated|\brated)\b/i;

const WORD_COUNT = { hundreds: 100, thousands: 1000, millions: 1000000 };

function matchNumericRating(s) {
  // Glyph form: "4.7★ rated", "4.8★", "5★ rated". Asserted number.
  let m = s.match(/(\d+(?:\.\d+)?)\s*[★⭐*]\s*(?:rated)?/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return { kind: 'rating', threshold: n };
  }
  // Score-out-of-five: "4.7/5", "5/5". Asserted number.
  m = s.match(/(\d+(?:\.\d+)?)\s*\/\s*5\b/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return { kind: 'rating', threshold: n };
  }
  // Star-word form: "5-Star Quality", "4.7 star", "4.7-star".
  // Integer N-star is honest at N-0.5 (standard rounding: "5-star"
  // is true of a 4.6). An explicit decimal may not overstate.
  m = s.match(/(\d+(?:\.\d+)?)\s*-?\s*stars?\b/i);
  if (m) {
    const raw = m[1];
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return { kind: 'rating', threshold: raw.includes('.') ? n : n - 0.5 };
  }
  return null;
}

function matchReviewCount(s) {
  const by = s.match(/reviewed by (hundreds|thousands|millions)\b/i);
  if (by) {
    return { kind: 'review_count', threshold: WORD_COUNT[by[1].toLowerCase()] };
  }
  const words = s.match(/\b(hundreds|thousands|millions)\b/i);
  if (words && /reviews?\b/i.test(s)) {
    return { kind: 'review_count', threshold: WORD_COUNT[words[1].toLowerCase()] };
  }
  const m = s.match(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?\s*\+?\s*reviews?\b/i);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  let threshold = n;
  if (suf === 'k') threshold = n * 1000;
  else if (suf === 'm') threshold = n * 1000000;
  return { kind: 'review_count', threshold };
}

function classifyBadgeClaim(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { kind: 'never_earnable', threshold: null };
  }
  const s = text.trim();

  const numeric = matchNumericRating(s);
  if (numeric) return numeric;

  const reviews = matchReviewCount(s);
  if (reviews) return reviews;

  if (NEVER_EARNABLE_RE.test(s)) {
    return { kind: 'never_earnable', threshold: null };
  }

  if (BARE_RATING_RE.test(s)) {
    return { kind: 'rating', threshold: 4.5 };
  }

  return { kind: 'neutral', threshold: null };
}

function filterUnearnedBadges(badges, signals) {
  const kept = [];
  const dropped = [];
  const list = Array.isArray(badges) ? badges : [];
  const sig = (signals && typeof signals === 'object') ? signals : {};

  for (const item of list) {
    try {
      if (typeof item !== 'string' || !item.trim()) {
        dropped.push({
          text: item,
          kind: 'never_earnable',
          threshold: null,
          reason: 'malformed (non-string or empty)'
        });
        continue;
      }
      const classified = classifyBadgeClaim(item);
      const kind = classified && classified.kind;
      const threshold = classified ? classified.threshold : null;

      if (kind === 'neutral') {
        kept.push(item);
        continue;
      }
      if (kind === 'never_earnable') {
        dropped.push({
          text: item,
          kind,
          threshold,
          reason: 'never earnable from this data model (sales/award/editorial/rank/popularity)'
        });
        continue;
      }
      if (kind === 'rating') {
        if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
          dropped.push({
            text: item, kind, threshold,
            reason: 'ambiguous rating claim; fail-safe drop'
          });
          continue;
        }
        if (typeof sig.rating === 'number' && sig.rating >= threshold) {
          kept.push(item);
        } else {
          const have = typeof sig.rating === 'number' ? sig.rating : 'none';
          dropped.push({
            text: item, kind, threshold,
            reason: `needs rating >= ${threshold}, have ${have}`
          });
        }
        continue;
      }
      if (kind === 'review_count') {
        if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
          dropped.push({
            text: item, kind, threshold,
            reason: 'ambiguous review-count claim; fail-safe drop'
          });
          continue;
        }
        if (typeof sig.reviewCount === 'number' && sig.reviewCount >= threshold) {
          kept.push(item);
        } else {
          const have = typeof sig.reviewCount === 'number' ? sig.reviewCount : 'none';
          dropped.push({
            text: item, kind, threshold,
            reason: `needs reviewCount >= ${threshold}, have ${have}`
          });
        }
        continue;
      }
      dropped.push({
        text: item,
        kind: kind || 'never_earnable',
        threshold,
        reason: 'ambiguous standing claim; fail-safe drop'
      });
    } catch (err) {
      dropped.push({
        text: item,
        kind: 'never_earnable',
        threshold: null,
        reason: `fail-safe drop (${err && err.message ? err.message : 'throw'})`
      });
    }
  }
  return { kept, dropped };
}

module.exports = {
  UNEARNED_CLAIM,
  classifyBadgeClaim,
  filterUnearnedBadges
};
