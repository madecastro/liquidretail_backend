// utils/reviewText.js
//
// Shortening a customer review WITHOUT rewriting it.
//
// Two rules govern everything here:
//   1. Every character stored is verbatim from the reviewer. No paraphrase, no
//      summarisation, no stitched fragments, no trailing ellipsis pretending
//      the reviewer trailed off.
//   2. When a review is longer than the storage bound, we drop WHOLE SENTENCES
//      — and we drop the least useful ones, not simply the last ones.
//
// Rule 2 is why this file exists rather than a positional truncate. A long
// review's opening sentence is frequently the least useful part of it
// ("Ordered this on the 3rd and it arrived Tuesday."), while the sentence that
// earns a place on an ad is buried in the middle ("Still looks new after eight
// months of daily use."). Keeping the first N sentences would systematically
// store the weakest half of the review.
//
// Selection is by score, but the RETAINED SENTENCES ARE RE-EMITTED IN THEIR
// ORIGINAL ORDER, so the result still reads as the reviewer's own paragraph.

'use strict';

const { splitSentences } = require('./htmlEntities');

// Positive sentiment — the reason a review is worth quoting at all.
const POSITIVE = /\b(love|loved|amazing|awesome|excellent|perfect|perfectly|fantastic|beautiful|gorgeous|sturdy|solid|comfortable|comfy|soft|durable|flawless|impressed|obsessed|worth it|exceeded|holds? up|held up|recommend|favou?rite|best|great|stunning)\b/i;

// FIT is the most common unresolved objection in apparel and footwear, so a
// sentence that settles it converts even when it is very short. "Awesome shirt
// with awesome fit" is a better overlay than a long generic rave, so it gets a
// bonus that offsets the short-length penalty in the band below.
const FIT = /\b(fits?|sizing|true to size|runs? (?:small|large|big|true)|snug|roomy|tailored)\b/i;

// Specificity — lived experience beats adjectives. These are what make a quote
// credible rather than generic.
const DURATION = /\b(\d+\s*(?:day|week|month|year)s?|all day|daily|every ?day|so far)\b/i;
const EXPERIENCE = /\b(used|using|wore|worn|washed|assembled|installed|fits?|fitted|carried|slept|cooked|travel(?:l)?ed|survived|held|cleaned)\b/i;
const MEASURED = /\d/;

// Not about the product. Real feedback, but a shipping note or a service
// complaint is the wrong sentence to keep when space is short.
const OFF_PRODUCT = /\b(shipping|shipped|delivery|delivered|arrive[ds]?|courier|ups|fedex|customer service|support team|refund|返品|return(?:ed|ing)? (?:it|process)|website|checkout|coupon|discount code|order number)\b/i;

// Never a good candidate.
const NOISE = /\b(edit|update):|https?:\/\/|www\./i;

// ── conversion signals ─────────────────────────────────────────────
//
// These quotes go on ads, so the question is not "is this a nice review" but
// "does this move a browser to buy". Three things do, and they are not the same
// as enthusiasm:
//
// RISK REVERSAL is the strongest. Most non-purchases are a specific unresolved
// worry — will it fit, is the colour real, is it worth the price — and a
// reviewer naming that worry and resolving it removes the actual blocker.
// "I was worried it would run small; it fits true to size" outsells "I love
// it!!" because it answers a question the browser is already asking.
const RISK_REVERSAL = /\b(was (?:worried|nervous|skeptical|sceptical|hesitant|unsure)|true to size|fits? true|runs? true|as (?:pictured|described|advertised|shown|expected)|exactly (?:as|what|the)|no regrets|worth (?:every penny|it|the (?:money|price|splurge|wait))|better than (?:i )?(?:expected|hoped)|exceeded|glad i (?:bought|got|took)|took the (?:chance|plunge))\b/i;

// REPEAT PURCHASE is social proof that survives scrutiny — anyone can praise a
// thing once; buying it again is a revealed preference.
const REPEAT_PURCHASE = /\b(bought (?:another|a second|two|three|\d+)|(?:second|third|fourth) (?:one|time)|re-?ordered|re-?purchas\w+|buy(?:ing)? (?:it |these |another )?again|would buy again|coming back for|stocked up)\b/i;

// OUTCOME — a stated before/after. Concrete benefit, not an adjective.
const OUTCOME = /\b(no more|pain is gone|gone after|saves? me|saved me|cut my|replaced my|finally|solved|stopped \w+ing|don'?t have to)\b/i;

// GENERIC PRAISE is the trap. It scores high on sentiment and carries no
// information, so without an explicit penalty it wins ties against a specific,
// credible sentence — and "Great product!" on an ad is wasted impression.
const GENERIC_PRAISE = /^(?:i\s+)?(?:absolutely\s+|really\s+|just\s+|so\s+)?(?:love|loved|like|adore)\s+(?:it|this|them|these)\b[.!\s]*$|^(?:great|good|nice|amazing|awesome|perfect|excellent|fantastic|beautiful)(?:\s+(?:product|item|purchase|quality|buy|thing))?[.!\s]*$/i;

/**
 * scoreSentence(s) → number
 * Higher is more worth keeping. Deterministic and cheap; this is a ranking
 * heuristic for choosing between the reviewer's own sentences, never a
 * judgement about whether the review is "good".
 */
function scoreSentence(s) {
  const t = String(s || '').trim();
  if (!t) return -Infinity;

  const len = t.length;
  const words = t.split(/\s+/).filter(Boolean).length;
  let score = 0;

  // Substance band. A 4-word fragment carries nothing; a 300-char run is
  // usually two thoughts and a digression.
  if (len >= 40 && len <= 200) score += 4;
  else if (len >= 25 && len < 40) score += 1;
  else if (len < 25) score -= 4;
  else if (len > 280) score -= 2;

  if (POSITIVE.test(t)) score += 5;
  if (DURATION.test(t)) score += 3;
  if (EXPERIENCE.test(t)) score += 2;
  if (MEASURED.test(t)) score += 1;

  // Conversion weighting — ordered by how directly each removes a reason not
  // to buy. Risk reversal outranks enthusiasm deliberately.
  if (RISK_REVERSAL.test(t)) score += 6;
  if (FIT.test(t)) score += 3;
  if (REPEAT_PURCHASE.test(t)) score += 5;
  if (OUTCOME.test(t)) score += 4;
  // Sentiment with no substance. Penalised enough to lose to any specific
  // sentence, not enough to drop it below a shipping complaint.
  if (GENERIC_PRAISE.test(t)) score -= 5;

  if (OFF_PRODUCT.test(t)) score -= 6;
  if (NOISE.test(t)) score -= 8;
  if (/\?\s*$/.test(t)) score -= 4;                 // a question, not a testimonial
  if (words <= 3) score -= 4;
  if (/^[A-Z\s!?.]{8,}$/.test(t)) score -= 2;       // SHOUTING

  return score;
}

// A second, third… sentence has to EARN its place, and leftover budget is
// never a reason to keep one. There is no minimum stored length: a one-sentence
// review stays one sentence, and if only one of a long review's sentences
// clears the bar, that is the whole stored quote. Under-filling the bound is
// the correct outcome, not a gap to plug.
//
// 4 is the score a full-substance sentence in the useful length band earns on
// its own (see the length band in scoreSentence), so the floor means "another
// real sentence" rather than "whatever still fits". A real run had
// "Still looks brand new after eight months of daily use and two cats."
// padded with "Nice." purely because 6 characters were spare.
const ADDITIONAL_SENTENCE_FLOOR = 4;

/**
 * shortenReview(text, maxLen) → string
 *
 * Returns the input unchanged when it fits. Otherwise keeps the highest-scoring
 * whole sentences that fit within maxLen, in original order. Falls back to the
 * entire first sentence when even one sentence exceeds the bound — storing a
 * few characters over is strictly better than fabricating a cut.
 */
function shortenReview(text, maxLen) {
  const str = String(text == null ? '' : text).trim();
  if (!str || !Number.isFinite(maxLen) || str.length <= maxLen) return str;

  const parts = splitSentences(str);
  if (parts.length <= 1) return str;               // one sentence → keep it whole

  const ranked = parts
    .map((raw, index) => ({ index, raw, trimmed: raw.trim(), score: scoreSentence(raw) }))
    .filter(p => p.trimmed)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const chosen = [];
  let used = 0;
  for (const cand of ranked) {
    // The single best sentence is kept unconditionally — we have to store
    // something. Everything after it must clear the floor on its own merit;
    // remaining budget is not merit.
    if (chosen.length && cand.score < ADDITIONAL_SENTENCE_FLOOR) continue;
    // +1 for the space that will join it to its neighbour.
    const cost = cand.trimmed.length + (chosen.length ? 1 : 0);
    if (used + cost > maxLen) continue;            // try the next-best, don't stop
    chosen.push(cand);
    used += cost;
  }
  if (!chosen.length) return parts[0].trim();      // first sentence, entire

  return chosen
    .sort((a, b) => a.index - b.index)             // reader order, not score order
    .map(p => p.trimmed)
    .join(' ');
}

// OFF_PRODUCT and NOISE are exported so callers can DISQUALIFY a line on
// content rather than inferring it from a low score. The two are different
// questions: scoreSentence RANKS (generic praise is penalised so a specific
// line outranks it), while these two DISQUALIFY (a shipping complaint must
// never print at all). Conflating them rejected generic praise outright,
// which is stricter than intended — "generic praise is absolutely fine if
// something is more specific" (owner, 2026-08-11): it should lose to a better
// line, not be banned.
module.exports = { shortenReview, scoreSentence, splitSentences, OFF_PRODUCT, NOISE };
