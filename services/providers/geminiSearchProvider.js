// Gemini grounded search — text-based product discovery via Google Search tool.
// Given brand/category/subject-description, Gemini formulates a query, hits Google,
// and returns retailer URLs grounded in real web results.
//
// Key detail: when the google_search tool is enabled, Gemini produces free-form
// text with inline citations — it does NOT reliably honor a "return JSON" prompt.
// So we pull match URLs/titles directly from response.groundingMetadata
// (the authoritative source list) and use the text body as the reasoning.

const axios = require('axios');

// Narrative summaries were cut with slice(0, 200), which ends mid-word. Prefer
// whole sentences and fall back to a word-boundary cut.
const { truncateWords, endsOnSentenceStop, completeSentencePrefix } = require('../../utils/htmlEntities');
const { trackLlmCall } = require('../costTracker');

/**
 * stampLlmQuotes(rows, scope) → quote[]
 * Marks every quote this provider emits as LLM-derived. The scrape path writes
 * `origin: 'scraped', verbatim: true`; anything from here is
 * `origin: 'llm-web', verbatim: false` so a consumer that needs a genuine
 * customer review can filter, and so a rewritten line can never be stored or
 * rendered as an original review.
 *
 * `scope` matters as much as `origin`: brand-level quotes DO get used on ads,
 * and a quote about the brand is not evidence about the product it is placed
 * next to. Carrying 'brand' vs 'product' lets a consumer prefer the tighter
 * one instead of treating the pool as interchangeable.
 */
// Was a hardcoded slice(0, 6). Raised because the retrieval directive below now
// asks for a WIDER pool on purpose: with only 6 stored and (measured on Vuori)
// 2 of them negative and 3 about a different product category, the ad path had
// effectively one usable quote and printed it on every creative. A bigger pool is
// the input the funnel-stage selection needs to have anything to choose between.
// VALIDATED, and bounded at BOTH ends. `Number(env) > 0` alone accepts values that
// break the slice in silent ways an adversarial pass enumerated: `Infinity` stores
// an unbounded pool, `0.1` makes slice(0, 0.1) return [] forever (an empty quote
// pool with no error anywhere), and `12.7` gives a nonsense slice end. Must be a
// positive integer inside a sane band.
const LLM_QUOTE_CAP = (() => {
  const raw = process.env.LLM_QUOTE_CAP;
  const n = Number(raw);
  if (raw != null && raw !== '' && Number.isInteger(n) && n >= 1 && n <= 40) return n;
  if (raw != null && raw !== '') {
    console.warn(`   ⚠️  LLM_QUOTE_CAP="${raw}" is not an integer in 1..40 — using 12`);
  }
  return 12;
})();

/**
 * Drop any quote the narrative does not literally contain.
 *
 * THIS IS THE ONLY ANTI-FABRICATION GUARANTEE THAT IS CODE AND NOT PROMPT TEXT, and
 * it is what makes the positivity directive safe to ask for. Pass 2 is a separate
 * generation that receives the pass-1 narrative and reshapes it to JSON; nothing
 * stopped it from smoothing a fragment into a quotable sentence, or emitting a
 * plausible line that appeared nowhere. Both adversarial passes independently
 * identified that hole and noted it was already closed on the CATEGORY path
 * (categoryReviewsService) and open on brand + product — so this is that same
 * check, lifted to one shared implementation and applied to all three.
 *
 * Whitespace-insensitive and case-insensitive because pass 2 legitimately
 * re-wraps lines; anything beyond that is a rewrite and gets dropped. The 15-char
 * floor rejects clause-fragments chopped out of a summary.
 *
 * @param {any[]} quotes  pass-2 output
 * @param {string} narrative  the pass-1 grounded text they must come from
 * @param {string} label  for the log line
 * @returns {any[]}
 */
function keepVerbatimQuotes(quotes, narrative, label) {
  if (!Array.isArray(quotes)) return [];
  const narrNorm = String(narrative || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!narrNorm) return [];
  const kept = quotes.filter((q) => {
    const qNorm = String(q?.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return qNorm.length >= 15 && narrNorm.includes(qNorm);
  });
  const dropped = quotes.length - kept.length;
  if (dropped > 0) {
    console.warn(`   ⚠️  ${label}: dropped ${dropped} quote(s) not verbatim in the grounded narrative (possible fabrication)`);
  }
  // THREE STAGES, ALL UNCONDITIONAL: verbatim (above) → complete sentence → ad-usable
  // sentiment. The screen runs LAST, on the text that will actually be typeset, because
  // trimming can change what a quote says.
  const judge = loadSentimentJudge(label);
  return kept
    .map((q) => completeSentencesOnly(q, label))
    .filter(Boolean)
    .filter((q) => screenAdUsableSentiment(q, judge, label));
}

/**
 * loadSentimentJudge(label) → fn|null
 *
 * The render path's own sentiment gate, resolved ONCE per retrieval rather than per
 * quote. Required lazily so a provider module carries no load-order coupling to the
 * render service (layoutInputService pulls in mongoose and a dozen models).
 */
function loadSentimentJudge(label) {
  try {
    // pickStrongestQuote, NOT hasPositiveSignal on its own. It is the render path's
    // own primary-quote selector, and for a single candidate it applies the FULL bar:
    //   · HARD_LIMITER          → -Infinity  ("low-support option best suited for
    //                                          lighter activities" argues against the sale
    //                                          yet contains "best", so hasPositiveSignal
    //                                          alone lets it through)
    //   · NEGATED_POSITIVE      → -Infinity  ("not as soft as I hoped")
    //   · NEGATIVE_SENTIMENT    → -Infinity
    //   · scoreQuote < SCORE_FLOOR → rejected (this is what catches MEDIOCRE: short
    //                                generic filler scores below the floor even when it
    //                                contains a positive lexeme)
    //   · hasPositiveSignal(best.text) as the final word
    // Reusing the selector means intake and selection cannot disagree: nothing is
    // stored that the render path would refuse to print, and nothing is refused at
    // print that intake thought was fine.
    // INTAKE STORES, SELECTION CHOOSES — two different questions, and using the
    // selector for both was wrong.
    //
    // This called pickStrongestQuote, which applies SCORE_FLOOR. That floor exists to
    // stop a weak quote WINNING WHEN A BETTER ONE EXISTS — a ranking question. Used as
    // an intake gate it meant generic praise was never STORED at all, so a brand whose
    // reviews are all "Love it, great product." ended up with an empty pool and no
    // testimonial anywhere. Owner, 2026-08-11: *"in the absence of any other social
    // proof, generic praise is better than nothing, but hopefully we have many many
    // more choices than that."*
    //
    // So intake keeps anything that genuinely reads as PRAISE and is not disqualified,
    // and pickStrongestQuote does the ranking at selection time with its own last-resort
    // tier. Mediocre and negative are still refused here, by the same two mechanisms as
    // before: hasPositiveSignal rejects neutral description and promotional lines, and a
    // non-finite scoreQuote rejects hard limiters, negated positives and negative
    // sentiment. Nothing that could hurt an ad is admitted; unspecific praise is.
    const { hasPositiveSignal, scoreQuote } = require('../layoutInputService');
    if (typeof hasPositiveSignal !== 'function' || typeof scoreQuote !== 'function') return null;
    return (text) => hasPositiveSignal(text) && Number.isFinite(scoreQuote(text));
  } catch (err) {
    console.warn(`   ⚠️  ${label}: sentiment judge unavailable (${err.message}) — every quote will be dropped rather than shipped unjudged`);
    return null;
  }
}

/**
 * screenAdUsableSentiment — MEDIOCRE AND NEGATIVE STOP HERE.
 *
 * OWNER DIRECTIVE 2026-08-11, verbatim: *"at no time should mediocre or negative
 * sentiment pass any gate from initial screening to selection for use in an ad."*
 *
 * Before this, positivity was enforced by PROMPT TEXT at retrieval and by
 * `hasPositiveSignal` at render — which meant an ungated middle: a complete, verbatim,
 * thoroughly mediocre quote was STORED as ad-usable, counted toward the pool, shown in
 * the brand UI, and reached a frame on any path whose render-side gate was weaker.
 * Measured on real retrieved Vuori quotes, all of which passed retrieval:
 * *"All clothes, including the workout shorts, have a slim, tailored fit."* (neutral
 * description), *"The fit around the leg is just loose and casual enough to not feel
 * oversized and baggy but not skin tight like a legging."* (hedged), *"They go on flash
 * sale and/or 20% off."* (promotional). None of them sells anything.
 *
 * THE BAR IS THE RENDER PATH'S OWN SELECTOR — `pickStrongestQuote` — not a private
 * notion of positive. See loadSentimentJudge for what that pulls in (hard limiters,
 * negation, a score floor that is what actually catches mediocrity, and
 * hasPositiveSignal as the final word). Reused, never reimplemented: one definition
 * from intake to typesetting means the two cannot drift.
 *
 * FAILS CLOSED. No judge → drop. An unjudged quote is worth less than no quote: the
 * pool being short costs an ad format, printing a mediocre or negative line costs the
 * client. Measured cost of strictness on the live Vuori pool: 11 retrieved → the clear
 * praise survives, the descriptive filler does not.
 *
 * @returns {boolean} true when the quote may proceed toward an ad
 */
function screenAdUsableSentiment(q, judge, label) {
  const text = String(q?.text || '').trim();
  if (!text) return false;
  if (!judge) return false;                      // fail closed
  if (judge(text)) return true;
  console.warn(`   ⚠️  ${label}: dropped a quote that is not clearly positive — ${JSON.stringify(text.slice(0, 60))}`);
  return false;
}

/**
 * Guarantee the quote ENDS somewhere, in code.
 *
 * OBSERVED LIVE (Pelagic Gear, first post-deploy enrichment): the retrieval
 * returned "Love these new T's. These new T's Pelagic has are so freaking soft.
 * Here in San Diego, we've had screaming high temps the last few weeks and these
 * have been keeping me cool in my" — ending mid-clause on a preposition. It passed
 * keepVerbatimQuotes because it genuinely IS a substring of the narrative, and the
 * directive's "must read as complete on its own" is only prose an LLM may ignore.
 * Typeset on an ad that is the same broken-sentence defect the owner reported for
 * "feel like second skin".
 *
 * SELECTION, NOT REPAIR — this is the line the rest of this module draws and it is
 * respected here: we only ever TRIM BACK to the last sentence-ending punctuation the
 * reviewer themself wrote. No word is added, reordered, or invented, so the result
 * is still a verbatim span of the source. A quote with no terminal punctuation
 * anywhere cannot be trimmed to anything honest, so it is dropped.
 *
 * TWO THINGS A NAIVE "trim to the last period" GETS WRONG, both found by adversarial
 * review before this shipped, both now covered by the harness:
 *   · an abbreviation is not a sentence end — "Absolutely love Dr. Bronners products
 *     and the scent is" must NOT become "Absolutely love Dr." (handled by
 *     endsOnSentenceStop / completeSentencePrefix in utils/htmlEntities);
 *   · a trim can invert the sentiment — "I hated the old ones. These are great and
 *     soft" must NOT become "I hated the old ones.", which is a complete, verbatim,
 *     fabricated NEGATIVE endorsement (handled by the re-judge below).
 *
 * @returns {object|null} the quote with `text` trimmed to whole sentences, or null
 */
function completeSentencesOnly(q, label) {
  const text = String(q?.text || '').trim();
  if (!text) return null;
  // Already finishes a sentence the reviewer finished — untouched, same object.
  if (endsOnSentenceStop(text)) return q;
  // Trim to the last stop THEY wrote. Always a literal prefix of `text`.
  const trimmed = completeSentencePrefix(text);
  if (!trimmed || trimmed.split(/\s+/).filter(Boolean).length < 2 || trimmed.length < 8) {
    console.warn(`   ⚠️  ${label}: dropped a quote that never completes a sentence`);
    return null;
  }
  // A TRIM CAN INVERT THE MEANING — "I hated the old ones. These are great and soft"
  // trims to "I hated the old ones.", a complete, verbatim, fabricated NEGATIVE
  // endorsement. That is caught by screenAdUsableSentiment, which runs AFTER this on
  // the trimmed text for exactly this reason. Completeness is judged here; sentiment
  // is judged in one place, on the final string, for every quote.
  console.warn(`   ⚠️  ${label}: trimmed a mid-sentence quote back to its last complete sentence`);
  return Object.assign({}, q, { text: trimmed });
}

/**
 * How many reviews an aggregate needs before its rating is allowed to WIN on merit.
 * Env-tunable, validated, because a "5.0 stars" badge computed from three reviews is a
 * number, not evidence.
 */
/**
 * An absolute floor on how thin an aggregate may be before it is ignored ENTIRELY —
 * distinct from RATING_MIN_CREDIBLE_REVIEWS, which only decides tier.
 *
 * Defaults to 1, i.e. no extra floor, because the owner's rule for the sub-50 tier is
 * "more stars, always". This knob is the single lever if a 3-review 5.0 ever prints on
 * an ad and that turns out to be a problem: no code change, one env var.
 */
const RATING_MIN_SAMPLE_ANY = (() => {
  const raw = process.env.RATING_MIN_SAMPLE_ANY;
  const n = Number(raw);
  if (raw != null && raw !== '' && Number.isInteger(n) && n >= 1 && n <= 100000) return n;
  if (raw != null && raw !== '') {
    console.warn(`   ⚠️  RATING_MIN_SAMPLE_ANY="${raw}" is not an integer in 1..100000 — using 1`);
  }
  return 1;
})();

const RATING_MIN_CREDIBLE_REVIEWS = (() => {
  const raw = process.env.RATING_MIN_CREDIBLE_REVIEWS;
  const n = Number(raw);
  if (raw != null && raw !== '' && Number.isInteger(n) && n >= 1 && n <= 100000) return n;
  if (raw != null && raw !== '') {
    console.warn(`   ⚠️  RATING_MIN_CREDIBLE_REVIEWS="${raw}" is not an integer in 1..100000 — using 50`);
  }
  return 50;
})();

/**
 * pickBestRating(candidates) → { rating, reviewCount, ratingSource, ratingCandidates }
 *
 * A brand has SEVERAL public aggregates and they disagree violently. Measured on Vuori
 * in one afternoon, three consecutive live refreshes stored three different ratings:
 * 4.58★ / 15,626 (their own site), 3.8★ / 28, and 2.5★ / 126 (Trustpilot). Pass 2 was
 * emitting whichever number the narrative happened to mention first, with no ranking
 * and no record of the source — so whether a brand printed stars at all was luck of the
 * draw per refresh, and a re-enrichment could silently take an ad format away.
 *
 * OWNER DECISION 2026-08-11, verbatim: *"prefer the highest number of stars with the
 * most reviews, in this case 4.58 with 15K reviews should absolutely win"*.
 *
 * TWO TIERS, and the owner set the rule for each one.
 *
 * TIER 1 — anything that clears the display floor AND has a credible sample
 * (RATING_MIN_CREDIBLE_REVIEWS). Ranked by MOST REVIEWS, then highest rating. This is
 * the "4.58 with 15K reviews should absolutely win" case: a big sample above the floor
 * beats a thinner one, so a 4.7 from 60 reviews does not outrank a 4.58 from 15,626.
 *
 * TIER 2 — nothing reached a credible sample. Ranked by HIGHEST RATING, then count.
 * Owner directive 2026-08-12, verbatim: *"dont go with the larger sample go with the
 * more stars, always for under 50!"* So on Pelagic, 4.5★/11 (Tenere) now beats 3.2★/22
 * (WorthEPenny) — where the previous rule took the larger sample and left the brand with
 * an unprintable 3.2.
 *
 * ⚠️ WHAT THIS DELIBERATELY ACCEPTS. Tier 2 ranks on stars with no regard for sample
 * size, so a 5.0 computed from 3 reviews outranks a 3.0 from 20,000 — and 5.0 clears
 * the display floor, so it PRINTS. That was previously blocked here and the owner
 * overrode it knowingly. RATING_MIN_SAMPLE_ANY exists for the day that becomes a
 * problem: set it to 5 or 10 and aggregates thinner than that are ignored outright. It
 * defaults to 1 (no extra floor) so today's behaviour is exactly what was asked for.
 *
 * NOTE, PLAINLY: this can select a brand's SELF-REPORTED site aggregate over a lower
 * third-party one. That is the owner's explicit call. `ratingSource` records which site
 * won and `ratingCandidates` keeps the full set, so the choice is auditable rather than
 * invisible — which is the part that was actually broken.
 */
function pickBestRating(candidates) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .map((c) => ({
      rating: (typeof c?.rating === 'number' && Number.isFinite(c.rating) && c.rating > 0 && c.rating <= 5)
        ? c.rating : null,
      reviewCount: (typeof c?.reviewCount === 'number' && Number.isFinite(c.reviewCount) && c.reviewCount > 0)
        ? Math.floor(c.reviewCount) : null,
      source: (typeof c?.source === 'string' && c.source.trim()) ? c.source.trim() : null
    }))
    .filter((c) => c.rating != null)
    // Absolute floor — see RATING_MIN_SAMPLE_ANY. A candidate with no count at all is
    // kept: "4.5 stars, count not visible" is still the best signal we have, and it
    // cannot be judged against a threshold it has no value for.
    .filter((c) => c.reviewCount == null || c.reviewCount >= RATING_MIN_SAMPLE_ANY);
  if (!rows.length) return { rating: null, reviewCount: null, ratingSource: null, ratingCandidates: [] };

  let starMin = 4.39;
  try {
    const { RATING_STAR_MIN } = require('../ratingDisplay');
    if (typeof RATING_STAR_MIN === 'number') starMin = RATING_STAR_MIN;
  } catch (_) { /* fall back to the documented default */ }

  const credible = (c) => c.rating > starMin && (c.reviewCount || 0) >= RATING_MIN_CREDIBLE_REVIEWS;
  const anyTier1 = rows.some(credible);
  const ranked = rows.slice().sort((a, b) => {
    const pa = credible(a), pb = credible(b);
    if (pa !== pb) return pa ? -1 : 1;
    const ca = a.reviewCount || 0, cb = b.reviewCount || 0;
    if (anyTier1) {
      // TIER 1 present: biggest credible sample wins, rating breaks ties.
      if (ca !== cb) return cb - ca;
      return b.rating - a.rating;
    }
    // TIER 2 only: MORE STARS WINS, count merely breaks ties. Owner directive.
    if (a.rating !== b.rating) return b.rating - a.rating;
    return cb - ca;
  });
  const winner = ranked[0];
  if (rows.length > 1) {
    const others = ranked.slice(1)
      .map((c) => `${c.rating}★/${c.reviewCount ?? '?'}${c.source ? ` ${c.source}` : ''}`).join(', ');
    console.log(`   · rating source: chose ${winner.rating}★ / ${winner.reviewCount ?? '?'} reviews${winner.source ? ` (${winner.source})` : ''} over ${others}`);
  }
  return {
    rating: winner.rating,
    reviewCount: winner.reviewCount,
    ratingSource: winner.source,
    ratingCandidates: ranked
  };
}

/**
 * NARRATIVE_ORDER_NOTE — why every pass-1 prompt asks for the NUMBERS FIRST.
 *
 * MEASURED 2026-08-11, and it cost a live regression. Pass 1 is a grounded call whose
 * free-form narrative is the only thing pass 2 gets to read. Both pass-1 calls were
 * hitting `finishReason: MAX_TOKENS` — the rating/summary request sat at the END of
 * the prompt, so the model spent its entire budget enumerating quotes and never wrote
 * the numbers at all. Pass 2 then correctly reported `rating: null`, the persist site
 * replaced the stored aggregates wholesale, and brands silently lost their stars:
 * Vuori went from 4.6★ / 15,545 to null, which makes `INTENTS.social_proof_led`
 * ineligible outright.
 *
 * Two compounding causes, both fixed here:
 *   1. ORDER. Widening the ask from "4-6 quotes" to `LLM_QUOTE_CAP` (12) with a
 *      per-quote source + author + funnel stage made truncation certain rather than
 *      unlikely. Anything the prompt asks for last is the first thing lost. The
 *      numbers are cheap (two lines) and gate an ad format, so they go first.
 *   2. THINKING TOKENS. gemini-2.5-flash bills hidden reasoning against
 *      `maxOutputTokens`. The pass-2 calls already set `thinkingBudget: 0`; the
 *      pass-1 calls never did, so a chunk of every budget went to thoughts nobody
 *      reads. Pass 1 needs no reasoning — it reads search results and writes prose.
 *
 * Measured on Vuori, same 3000-token budget, quotes-last + thinking on → numbers-first
 * + thinking off: `MAX_TOKENS`, 941 chars, 4 quotes, NO rating → `STOP`, 3026 chars,
 * 12 quotes, rating AND count present. Same cost, ~3x the usable narrative.
 */
const GROUNDED_PASS1_CONFIG = {
  temperature: 0.2,
  // GENEROUSLY PADDED, ON PURPOSE (owner directive 2026-08-11). Output tokens are
  // billed as USED, not as reserved, so a high ceiling costs nothing until it is
  // needed — while a ceiling set close to the measured need is a silent data-loss
  // bug the moment a brand has more reviews to talk about. Measured need with
  // thinking off: ~750 output tokens for 12 quotes + numbers + summary. This is ~20x
  // that. Do not "optimise" it back down; the tight budget IS what caused the
  // regression this constant exists to prevent.
  maxOutputTokens: 16000,
  // Pass 1 summarises search results; it does not reason. Every thought token here is
  // budget taken from the narrative pass 2 depends on.
  thinkingConfig: { thinkingBudget: 0 }
};

/**
 * Pass 2 reshapes the narrative into JSON. Same padding logic, same reason: the JSON
 * for 12 quotes each carrying text + source + author + stage is several times larger
 * than the 6-quote shape this was originally sized for, and a truncated response is
 * unparseable — which returns an EMPTY quote pool and a null rating, i.e. exactly the
 * failure mode as a silent success.
 */
const GROUNDED_PASS2_MAX_TOKENS = 12000;

/** Grounded search with tools regularly lands at 30-40s under load, and a wider pool
 *  writes more. A timeout here throws away a call that was already paid for, so this
 *  is padded well past the 31.8s measured on a 12-quote brand run. */
const GROUNDED_CALL_TIMEOUT_MS = 120000;

/**
 * Truncation must never be silent again.
 *
 * Nothing checked `finishReason`, so a narrative cut off mid-enumeration looked
 * exactly like a complete one: the fetch "succeeded", quotes came back, and the only
 * visible symptom was a missing star rating that read as "the web just didn't say".
 * That is what made the regression above survive three live runs unnoticed.
 *
 * @returns {boolean} true when the response was truncated
 */
function warnIfTruncated(candidate, label) {
  const reason = candidate && candidate.finishReason;
  if (reason && reason !== 'STOP' && reason !== 'FINISH_REASON_STOP') {
    console.warn(`   ⚠️  ${label}: grounded response ended with finishReason=${reason} — the narrative is INCOMPLETE, so the rating/summary may be missing rather than absent from the web`);
    return true;
  }
  return false;
}

function stampLlmQuotes(rows, scope) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, LLM_QUOTE_CAP).filter(q => q && q.text).map(q => Object.assign({}, q, {
    origin: 'llm-web',
    verbatim: false,
    scope: scope || 'product'
  }));
}

/**
 * ONE retrieval directive, shared by every grounded quote lookup (brand, product,
 * category). Owner directive 2026-08-10, verbatim: *"The goal is to find positive
 * statements that help us achieve our goals at different stages of the funnel as
 * well as retention and conquest. Negative statements are not wanted, nor are
 * neutral statements."* And: *"statements should be complimentary and
 * complementary to the brand in every sense of the word."*
 *
 * WHY THIS EXISTS AS A CONSTANT: the three lookups previously each carried their
 * own neutral phrasing ("what real customers say", "how reviewers feel"), which is
 * reputation research, not ad sourcing. Three copies would drift; this is the
 * single source of truth.
 *
 * THE FABRICATION RISK, AND WHY THE LAST PARAGRAPH IS LOAD-BEARING. Asking a model
 * for only-flattering quotes creates direct pressure to embellish, stitch fragments
 * together, or invent a plausible reviewer. Every quote retrieved here is stamped
 * `origin:'llm-web'` and can be printed verbatim into a PAID ad, so an invented
 * quote is a fabricated endorsement. The instruction to return FEWER — or none —
 * is not politeness; it is the counterweight to the positivity ask, and it must
 * survive any future edit to this block. The render-side gates (scoreQuote's
 * NEGATIVE_SENTIMENT/HARD_LIMITER disqualifiers, hasPositiveSignal, and
 * quoteProvenance) stay in place as defence in depth — this directive improves the
 * pool, it does not replace those gates.
 */
const AD_USABLE_QUOTE_DIRECTIVE =
  `WHICH QUOTES TO RETURN — these become ad copy, so the bar is ad-usability, not representativeness.\n` +
  `\n` +
  `RULE 0 — VERBATIM, OR NOTHING. This outranks every other rule below. Copy each quote exactly as ` +
  `published, character for character. Do NOT paraphrase, tidy, punctuate, translate, merge two ` +
  `reviews, extend a sentence, or complete a fragment to make it read better, and NEVER invent a ` +
  `reviewer or a line. A quote you had to repair is a quote you must discard, not fix. If fewer ` +
  `quotes survive these rules, RETURN FEWER — an empty list is the correct, expected answer when the ` +
  `open web has nothing usable. Quantity, stage coverage, and variety are NEVER reasons to relax ` +
  `this rule.\n` +
  `\n` +
  `- ONLY genuinely COMPLIMENTARY statements: clear, unqualified praise. Reject negative, mixed, ` +
  `back-handed, and merely NEUTRAL/factual statements ("it arrived Tuesday", "it is grey") — a quote ` +
  `that does not actively help a sale does not belong here.\n` +
  `- Also COMPLEMENTARY to the brand: consistent with how the brand positions itself, reinforcing ` +
  `its quality and character. Nothing that quietly undercuts it.\n` +
  `- Each quote must already READ AS COMPLETE on its own, exactly as published — it is typeset with ` +
  `no surrounding context. Skip anything that only makes sense after the sentence before it. This is ` +
  `a SELECTION test, not permission to complete or clean up a fragment (see RULE 0).\n` +
  `- EXCLUDE, even when the statement is positive:\n` +
  `    · price, discounts, sales, coupons, promo codes, "worth the money"-style price framing\n` +
  `    · shipping, delivery, returns, exchanges, customer service\n` +
  `    · sizing caveats ("runs small", "size up")\n` +
  `    · named competitors, and any conditional praise ("great, BUT…", "best suited for…")\n` +
  `    · HEALTH / MEDICAL / BODY claims — cured, healed, cleared my skin, fixed my back pain, ` +
  `doctor or dermatologist recommended, hypoallergenic, therapeutic\n` +
  `    · SUPERLATIVES and market-superiority — "the best on the market", "nothing else compares", ` +
  `"unbeatable", "#1"\n` +
  `    · ABSOLUTE or open-ended performance — "lasts forever", "never wears out", "never pills", ` +
  `"indestructible", "waterproof in any conditions"\n` +
  `    · GUARANTEES and warranties — "lifetime guarantee", "they'll replace it free"\n` +
  `    · SAFETY claims — "non-toxic", "safe for babies", "chemical-free"\n` +
  `    · SUSTAINABILITY / ETHICS claims — "carbon neutral", "100% recycled", "ethically made"\n` +
  `    · EARNINGS or outcome claims, and anything about or spoken by a CHILD\n` +
  `  Every one of these becomes an advertising claim the brand has not substantiated the moment it ` +
  `is typeset, even though a customer said it. Praise about how something looks, feels, fits, wears ` +
  `and how much the owner enjoys it is what we want.\n` +
  `- Label each quote with the ONE stage it best serves. Cover as many stages as the REAL quotes ` +
  `happen to cover — this is a labelling task, never a quota. Returning three quotes that are all ` +
  `"consideration" is correct if that is what exists; inventing a "conquest" line to fill a slot is ` +
  `a serious error:\n` +
  `    awareness     — sensory/emotional discovery, "people noticed", desirability\n` +
  `    consideration — removes a specific doubt: fit, feel, how it held up in real use\n` +
  `    conversion    — decision confidence and satisfaction: no regrets, would buy again\n` +
  `    retention     — repeat use and loyalty: bought more, wear it constantly, reach for it daily\n` +
  `    conquest      — switched to this from something else and is happier. Describe only what THIS ` +
  `product does well. Reject any switch quote that disparages what it replaced, even unnamed — ` +
  `"finally something that doesn't fall apart", "everything else pills", "the big brands are junk" ` +
  `are comparative attacks on an unnamed rival and are NOT usable.`;
function summarySnippet(s, maxLen = 200) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= maxLen) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [];
  let out = '';
  for (const sent of sentences) {
    if ((out + sent).trim().length > maxLen) break;
    out += sent;
  }
  return out.trim() || truncateWords(t, maxLen);
}

const MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const PROVIDER_NAME = 'gemini-search';

function isEnabled() { return !!process.env.GEMINI_API_KEY; }

/**
 * trackedGenerate — the ledgered generateContent transport.
 *
 * These are billable calls against the raw generativelanguage REST API, which
 * is not behind atlasLlmService, so nothing ledgered them: brand-reviews and
 * product-reviews spend was invisible in CostLog while the sibling GPT-4.1 tier
 * in brandEnrichmentService showed up on every report.
 *
 * Two things this has to get right that a naive wrap does not:
 *
 *  1. **Return `res.data`, not the axios response.** costTracker.extractUsage
 *     reads `usageMetadata` off the object the fn resolves to, and on raw REST
 *     that lives on the response BODY. Returning the axios envelope logs a row
 *     with 0 tokens and $0 — worse than no row, because it looks measured.
 *
 *  2. **Declare grounding.** Google bills Search grounding per REQUEST on top
 *     of tokens ($35/1,000 prompts). A grounded pass here is ~$0.004 of tokens
 *     and ~$0.035 of grounding, so `grounded` is most of the true cost, not a
 *     rounding detail. See costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD.
 *
 * `ledger` carries the linkage ids (brandId / productId) so these rows join
 * back to a brand the way every other CostLog row does.
 */
async function trackedGenerate({ stage, purposeTag, grounded, ledger }, body, timeout = 30000) {
  return trackLlmCall(
    {
      stage,
      provider:   'gemini',
      model:      MODEL,
      purposeTag,
      groundedRequests: grounded ? 1 : 0,
      ...(ledger || {})
    },
    async () => {
      const r = await axios.post(
        `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
        body,
        // maxRedirects:0 per CLAUDE.md §2 — axios defaults to 21 and re-sends
        // the body on 307/308, which is a silent double charge inside one call.
        { timeout, maxRedirects: 0 }
      );
      return r.data;
    }
  );
}

async function match({ brand, category, caption, primarySubject, textDetected = [], cropImageUrl = null }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');

  const queryParts = [];
  if (brand)          queryParts.push(`Brand: ${brand}`);
  if (category)       queryParts.push(`Category: ${category}`);
  if (primarySubject) queryParts.push(`Product description: ${primarySubject}`);
  if (caption)        queryParts.push(`Caption: "${caption}"`);
  if (textDetected.length) queryParts.push(`Text visible on product: ${textDetected.map(t => `"${t}"`).join(', ')}`);

  // Phase 1.8 — multimodal grounded search. When the caller provides a tight
  // per-product crop URL (Phase 1.6 refinement output), download it + send as
  // inlineData so Gemini's grounded search sees the product visually instead
  // of relying solely on the scene-level primarySubject text. The image
  // grounds the query in actual visual evidence — eliminates the scene-leakage
  // failure mode where Gemini picks a similar-looking product because the
  // text seed described the broader scene.
  let imagePart = null;
  if (cropImageUrl) {
    try {
      const imgRes = await axios.get(cropImageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const buf = Buffer.from(imgRes.data);
      imagePart = { inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } };
    } catch (err) {
      console.warn(`   ⚠️  ${PROVIDER_NAME}: cropImageUrl download failed (${err.message}); falling back to text-only`);
    }
  }

  const prompt = imagePart
    ? `Use Google Search to find where the SPECIFIC product shown in the attached image is sold ` +
      `online — focus on the central product visible in the image, not surrounding context. ` +
      `Prefer the brand's own site and major retailers. Return a concise one-paragraph summary ` +
      `explaining which product you identified and which retailers carry it. Cite every retailer ` +
      `with a link.\n\n` +
      `Product details (use as a sanity check on what's visible):\n${queryParts.join('\n')}`
    : `Use Google Search to find where this product is sold online. Prefer the brand's own site ` +
      `and major retailers. Return a concise one-paragraph summary explaining which product you ` +
      `identified and which retailers carry it. Cite every retailer with a link so I can browse them.\n\n` +
      `Product details:\n${queryParts.join('\n')}`;

  const parts = [{ text: prompt }];
  if (imagePart) parts.push(imagePart);

  const t0 = Date.now();
  const res = await axios.post(
    `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      contents: [{ role: 'user', parts }],
      tools: [{ google_search: {} }],
      // Padded like the review lookups (output tokens bill as used), but thinking is
      // deliberately LEFT ON here: unlike a pass-1 summarisation, this call IDENTIFIES
      // a product from an image + text, which is reasoning work. No measurement
      // justifies turning it off, so it stays.
      generationConfig: { temperature: 0.2, maxOutputTokens: GROUNDED_PASS2_MAX_TOKENS }
    },
    { timeout: GROUNDED_CALL_TIMEOUT_MS }
  );

  const candidate = res.data?.candidates?.[0];
  const reasoningText = (candidate?.content?.parts || [])
    .map(p => p.text || '')
    .join(' ')
    .trim();

  // Pull matches directly from grounding metadata — this is the authoritative
  // URL list that Google returned for this search, not something we parse from prose.
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const matches = [];
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    matches.push({
      title: chunk.web?.title || extractDomain(uri),
      url: uri,
      retailer: extractDomain(uri),
      priceHint: null,           // not available from grounding chunks
      snippet: '',               // ditto; could derive from groundingSupports if desired
      thumbnail: null,
      source: PROVIDER_NAME
    });
    if (matches.length >= 10) break;
  }

  // queryUsed: Gemini doesn't expose the literal query it issued, but the
  // web search queries are sometimes in groundingMetadata.webSearchQueries.
  const searchQueries = candidate?.groundingMetadata?.webSearchQueries || [];

  console.log(`   ✓ ${PROVIDER_NAME}: ${matches.length} match(es) in ${Date.now() - t0}ms (queries: ${searchQueries.join(' | ') || 'n/a'})`);

  return {
    provider: PROVIDER_NAME,
    reasoning: reasoningText || 'Grounded Google Search returned no narrative text.',
    queryUsed: searchQueries[0] || queryParts.join(' | '),
    matches,
    groundingUrls: chunks.map(c => c.web?.uri).filter(Boolean).slice(0, 10)
  };
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Brand-category lookup. Asks Gemini grounded search to find the brand's
// own collection / category page that best matches a generic product
// label + category. Returns { breadcrumb, url, confidence, reasoning }
// for downstream use as a fallback CTA destination when no specific SKU
// match was confident enough.
//
// e.g. for { brandUrl: 'pelagicgear.com', label: 'sun shirt', category: 'apparel' }
// → { breadcrumb: 'Mens > Performance Shirts > Long Sleeve',
//     url: 'https://pelagicgear.com/collections/mens-long-sleeve-performance' }
async function lookupBrandCategoryUrl({ brandUrl, brandName, label, category }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!brandUrl && !brandName) return null;

  const t0 = Date.now();
  const prompt =
    `Use Google Search to find the BEST matching collection / category page on ` +
    `the brand's own website for the product described below. Walk the brand's ` +
    `navigation taxonomy (e.g. "Mens > Tops > Performance Shirts") rather than ` +
    `linking to a specific SKU.\n\n` +
    `Brand: ${brandName || brandUrl}\n` +
    (brandUrl ? `Brand site: ${brandUrl}\n` : '') +
    `Product label: ${label || '(unspecified)'}\n` +
    `Product category: ${category || '(unspecified)'}\n\n` +
    `Respond as:\n` +
    `BREADCRUMB: <Top > Sub > Specific>\n` +
    `URL: <full URL on the brand's domain>\n` +
    `CONFIDENCE: <0-100, how certain you are this is the best matching collection page>\n` +
    `Then one sentence explaining how you decided.`;

  let res;
  try {
    res = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        // Output here is four short lines, so 600 tokens LOOKED generous — but hidden
        // thinking tokens bill against the same ceiling, which makes a 600-token
        // grounded call a truncation waiting to happen. Padded rather than
        // thinking-disabled: choosing the best collection page is judgement work.
        generationConfig: { temperature: 0.1, maxOutputTokens: GROUNDED_PASS2_MAX_TOKENS }
      },
      { timeout: GROUNDED_CALL_TIMEOUT_MS }
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-category lookup failed: ${err.message}`);
    return null;
  }

  const candidate = res.data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join(' ').trim();

  const breadcrumbMatch = text.match(/BREADCRUMB:\s*([^\n]+)/i);
  const urlMatch        = text.match(/URL:\s*(https?:\/\/[^\s]+)/i);
  const confMatch       = text.match(/CONFIDENCE:\s*(\d+)/i);

  if (!urlMatch && !breadcrumbMatch) {
    console.warn(`   · brand-category lookup: no parsable result for ${brandName || brandUrl}`);
    return null;
  }

  const result = {
    breadcrumb: breadcrumbMatch?.[1]?.trim() || null,
    url:        urlMatch?.[1]?.trim() || null,
    confidence: confMatch ? Math.max(0, Math.min(1, Number(confMatch[1]) / 100)) : 0.5,
    reasoning:  text,
    source:     PROVIDER_NAME
  };
  console.log(`   ✓ brand-category: ${result.breadcrumb || '(no breadcrumb)'} → ${result.url || '(no url)'} (${(result.confidence * 100).toFixed(0)}%, ${Date.now() - t0}ms)`);
  return result;
}

// Brand-level reviews lookup. Used in the "branding" outcome where no
// specific product was identifiable — surfaces overall brand sentiment
// quotes that downstream templates can use in place of product reviews.
// Returns { quotes: [{ text, author?, source? }], rating?, reviewCount?, reasoning }.
// Two-pass: grounded-search Gemini returns prose (it ignores JSON
// formatting requests when the google_search tool is enabled), so we
// run a second plain call with responseMimeType: application/json to
// structure the narrative into typed fields.
async function lookupBrandReviews({ brandName, brandUrl, brandId = null }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!brandName) return null;

  const t0 = Date.now();
  // Linkage for the cost ledger. brandId is optional — a caller that hasn't
  // resolved a Brand row still gets a row, just without the join.
  const ledger = { brandId, cacheKey: brandName };

  // ── Pass 1: grounded narrative ──
  // NUMBERS FIRST, QUOTES SECOND — the order is load-bearing, see NARRATIVE_ORDER_NOTE.
  const searchPrompt =
    `Use Google Search to research the BRAND ${brandName}` +
    (brandUrl ? ` (${brandUrl})` : '') + `.\n\n` +
    `FIRST — and this part must stay HONEST, not flattering: list EVERY public review aggregate you ` +
    `can find for this brand, ONE PER LINE, each as "<source>: <average star rating out of 5> from ` +
    `<total review count> reviews" — the brand's own site, Trustpilot, Sitejabber, BBB, Google, ` +
    `wherever. Do NOT pick one for me and do NOT average them; report each separately with its ` +
    `source named, and say so if a source has no visible rating. Then give a one-sentence summary ` +
    `of the brand's real reputation INCLUDING any recurring complaints. The ` +
    `rating and summary are internal signal used to decide whether we can make a claim at all; they ` +
    `are never TYPESET as a customer quote — though the Director does read the summary to calibrate ` +
    `voice, so keep it factual rather than flattering. Write these BEFORE any quotes.\n\n` +
    `THEN surface up to ${LLM_QUOTE_CAP} SPECIFIC, DIRECT customer quotes (verbatim, in quotation ` +
    `marks) from review aggregators (Trustpilot, Sitejabber, BBB), Reddit threads, and brand-site ` +
    `testimonials. Prefer MORE quotes from a strong source over one-per-source variety — several ` +
    `excellent Reddit or Trustpilot quotes beat a token spread.\n\n` +
    `${AD_USABLE_QUOTE_DIRECTIVE}\n\n` +
    `For each quote, give the source platform and the author/handle if visible, and the funnel stage ` +
    `it serves. Write naturally — do not format as JSON.`;

  let searchData;
  try {
    searchData = await trackedGenerate(
      { stage: 'brand_reviews', purposeTag: 'grounded_search', grounded: true, ledger },
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: GROUNDED_PASS1_CONFIG
      },
      GROUNDED_CALL_TIMEOUT_MS
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-reviews search failed: ${err.message}`);
    return null;
  }

  const searchCand = searchData?.candidates?.[0];
  warnIfTruncated(searchCand, 'brand-reviews pass 1');
  const narrative = (searchCand?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  const sourceDomains = (searchCand?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web?.uri && extractDomain(c.web.uri))
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
    .slice(0, 10);

  if (!narrative || narrative.length < 100) {
    console.warn(`   · brand-reviews: search returned no narrative for ${brandName}`);
    return { quotes: [], rating: null, reviewCount: null, summary: null, source: PROVIDER_NAME };
  }

  // ── Pass 2: structure as JSON ──
  // Plain Gemini call (no tools) with JSON mime — reliably honors
  // formatting when there's no google_search tool muddying things.
  const structurePrompt =
    `Convert the following brand-review narrative into structured JSON.\n\n` +
    `Brand: ${brandName}\n` +
    (sourceDomains.length ? `Sources cited: ${sourceDomains.join(', ')}\n` : '') +
    `\nNarrative:\n"""\n${narrative}\n"""\n\n` +
    `Return EXACTLY this shape (no commentary, no markdown):\n` +
    `{\n` +
    `  "quotes":      [ { "text": "...", "author": "name or null", "source": "domain or platform or null", "stage": "awareness|consideration|conversion|retention|conquest or null" }, up to ${LLM_QUOTE_CAP} entries ],\n` +
    `  "ratings":     [{ "source": "<site>", "rating": <0-5>, "reviewCount": <n> }],  // EVERY aggregate found, one entry each; do NOT pick or average\n` +
    `  "rating":      <number 0-5 or null>,   // legacy single value; leave null if you filled "ratings"\n` +
    `  "reviewCount": <integer or null>,\n` +
    `  "summary":     "one sentence on overall brand sentiment"\n` +
    `}\n` +
    `QUOTE RULES (strict): each quote.text MUST be a verbatim substring of the narrative above, copied character-for-character. If the narrative contains no verbatim customer quotes (e.g. it only summarises sentiment), return an EMPTY quotes array — do NOT chop the summary into clause-fragments, do NOT paraphrase, do NOT invent, do NOT complete a fragment into a sentence. Quotes failing this are dropped in code, so inventing one only loses it.`;

  let structData;
  try {
    structData = await trackedGenerate(
      { stage: 'brand_reviews', purposeTag: 'json_structure', grounded: false, ledger },
      {
        contents: [{ role: 'user', parts: [{ text: structurePrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: GROUNDED_PASS2_MAX_TOKENS,
          responseMimeType: 'application/json',
          // gemini-2.5-flash burns hidden thinking tokens against the
          // visible budget; for a pure narrative → JSON shaping pass
          // (no reasoning required, schema is fixed), thinking just
          // truncates the output. Observed as "structuring produced no
          // parsable JSON" in logs.
          thinkingConfig: { thinkingBudget: 0 },
          // Same schema as product-reviews below — Gemini's freeform
          // JSON output is unreliable enough that the parser fallback
          // was firing often. Constrains the response shape.
          responseSchema: {
            type: 'object',
            properties: {
              quotes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text:   { type: 'string' },
                    author: { type: 'string', nullable: true },
                    source: { type: 'string', nullable: true },
                    // Funnel stage the quote serves, per AD_USABLE_QUOTE_DIRECTIVE.
                    // Carried through so selection can match a quote to the ad's
                    // intent instead of always printing the same top-scored line.
                    // Nullable: an unlabelled quote is still usable, it just
                    // cannot win a stage-biased pick.
                    stage: { type: 'string', nullable: true }
                  },
                  required: ['text']
                }
              },
              // REQUIRED, and NOT nullable — this is the whole fix.
              //
              // Declared optional, Gemini structured output simply DID NOT EMIT IT.
              // Measured: the identical prompt against the same model returns all four
              // aggregates when no responseSchema constrains the call, and returns none
              // when this property is optional. So pass 1 wrote
              // "Vuoriclothing.com: 4.58 out of 5 from 15,626 reviews / Trustpilot: 2.3
              // from 126 / WorthEPenny: 3.8 from 28 / Thingtesting: 4 from 137", pass 2
              // read it, and the schema dropped every one on the floor — the brand came
              // back with no rating at all and the picker had nothing to rank.
              //
              // An empty array is how "no aggregates found" is expressed; that is a
              // different statement from "the field is absent", and only the required
              // form makes the model commit to one of them.
              ratings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    source:      { type: 'string', nullable: true },
                    // Non-nullable: an entry with no number is not an aggregate. A
                    // source with a non-numeric grade (BBB's "A+") is correctly omitted
                    // rather than emitted as a null the picker has to filter out.
                    rating:      { type: 'number' },
                    reviewCount: { type: 'number', nullable: true }
                  },
                  required: ['rating']
                }
              },
              rating:      { type: 'number',  nullable: true },
              reviewCount: { type: 'integer', nullable: true },
              summary:     { type: 'string',  nullable: true }
            },
            required: ['quotes', 'ratings']
          }
        }
      },
      GROUNDED_CALL_TIMEOUT_MS
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-reviews structuring failed: ${err.message}`);
    return { quotes: [], rating: null, reviewCount: null, summary: summarySnippet(narrative), source: PROVIDER_NAME };
  }

  const structCand = structData?.candidates?.[0];
  const jsonText = (structCand?.content?.parts || []).map(p => p.text || '').join('').trim();

  let parsed = null;
  try { parsed = JSON.parse(jsonText); } catch (_) {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed) {
    console.warn(`   · brand-reviews: structuring produced no parsable JSON for ${brandName}`);
    return { quotes: [], rating: null, reviewCount: null, summary: summarySnippet(narrative), source: PROVIDER_NAME };
  }

  const result = {
    // PROVENANCE: these quotes are produced by a grounded LLM search over the
    // open web, not scraped verbatim from the merchant's review app. They are
    // stamped so nothing downstream can present them as first-party customer
    // reviews — see stampLlmQuotes().
    quotes:      stampLlmQuotes(keepVerbatimQuotes(parsed.quotes, narrative, 'brand-reviews'), 'brand'),
    // ONE number is chosen from ALL the aggregates found, by an explicit rule, and the
    // choice is recorded — see pickBestRating. The legacy single `rating` is folded in as
    // just another candidate so an older-shaped response still works.
    ...pickBestRating([
      ...(Array.isArray(parsed.ratings) ? parsed.ratings : []),
      { rating: parsed.rating, reviewCount: parsed.reviewCount, source: null }
    ]),
    summary:     parsed.summary || null,
    source:      PROVIDER_NAME
  };
  console.log(`   ✓ brand-reviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''}${result.reviewCount != null ? ` · ${result.reviewCount.toLocaleString()} reviews` : ''}${result.ratingSource ? ` · via ${result.ratingSource}` : ''} (${Date.now() - t0}ms, two-pass)`);
  return result;
}

// Product-level reviews lookup. Same two-pass approach as
// lookupBrandReviews — pass 1 grounded search returns prose, pass 2
// plain Gemini call structures it as JSON. Shape mirrors
// lookupBrandReviews so caller code can use identical render logic.
async function lookupProductReviews({ productName, brandName, productUrl, brandId = null, productId = null }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!productName) return null;

  const t0 = Date.now();
  const productLabel = brandName ? `${brandName}'s "${productName}"` : `"${productName}"`;
  // Linkage for the cost ledger; both ids are optional (see lookupBrandReviews).
  const ledger = { brandId, productId, cacheKey: productName };

  // ── Pass 1: grounded narrative ──
  // NUMBERS FIRST, QUOTES SECOND — see NARRATIVE_ORDER_NOTE.
  const searchPrompt =
    `Use Google Search to research the PRODUCT ${productLabel}` +
    (productUrl ? ` (${productUrl})` : '') + `.\n\n` +
    `FIRST — and this part must stay HONEST, not flattering: list EVERY place this product has a ` +
    `visible review aggregate, ONE PER LINE, each as "<source>: <average star rating out of 5> from ` +
    `<total review count> reviews" — the brand's own product page, retailers, review sites. Do NOT ` +
    `pick one for me and do NOT average them; report each separately with its source named. Then ` +
    `give a one-sentence summary of how reviewers ` +
    `really feel about this product INCLUDING any recurring complaints. The ` +
    `rating and summary are internal signal used to decide whether we can make a claim at all; they ` +
    `are never typeset as a customer quote. Write these BEFORE any quotes.\n\n` +
    `THEN surface up to ${LLM_QUOTE_CAP} SPECIFIC, DIRECT customer quotes (verbatim, in quotation ` +
    `marks) about THIS EXACT product. Pull from retailer review sections, Reddit discussions, ` +
    `YouTube review videos, and dedicated review sites. Prefer MORE quotes from a strong source over ` +
    `one-per-source variety.\n\n` +
    `${AD_USABLE_QUOTE_DIRECTIVE}\n\n` +
    `For each quote, give the source platform and the author/handle if visible, and the funnel stage ` +
    `it serves. A quote must be about this product, not the brand in general and not a different ` +
    `item in the range. Write naturally — do not format as JSON.`;

  let searchData;
  try {
    searchData = await trackedGenerate(
      { stage: 'product_reviews', purposeTag: 'grounded_search', grounded: true, ledger },
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: GROUNDED_PASS1_CONFIG
      },
      GROUNDED_CALL_TIMEOUT_MS
    );
  } catch (err) {
    console.warn(`   ⚠️  product-reviews search failed: ${err.message}`);
    return null;
  }

  const searchCand = searchData?.candidates?.[0];
  warnIfTruncated(searchCand, 'product-reviews pass 1');
  const narrative = (searchCand?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  const sourceDomains = (searchCand?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web?.uri && extractDomain(c.web.uri))
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
    .slice(0, 10);

  if (!narrative || narrative.length < 100) {
    console.warn(`   · product-reviews: search returned no narrative for ${productLabel}`);
    return { quotes: [], rating: null, reviewCount: null, summary: null, source: PROVIDER_NAME };
  }

  // ── Pass 2: structure as JSON ──
  const structurePrompt =
    `Convert the following product-review narrative into structured JSON.\n\n` +
    `Product: ${productName}${brandName ? ` (brand: ${brandName})` : ''}\n` +
    (sourceDomains.length ? `Sources cited: ${sourceDomains.join(', ')}\n` : '') +
    `\nNarrative:\n"""\n${narrative}\n"""\n\n` +
    `Return EXACTLY this shape (no commentary, no markdown):\n` +
    `{\n` +
    `  "quotes":      [ { "text": "...", "author": "name or null", "source": "domain or platform or null", "stage": "awareness|consideration|conversion|retention|conquest or null" }, up to ${LLM_QUOTE_CAP} entries ],\n` +
    `  "ratings":     [{ "source": "<site>", "rating": <0-5>, "reviewCount": <n> }],  // EVERY aggregate found, one entry each; do NOT pick or average\n` +
    `  "rating":      <number 0-5 or null>,   // legacy single value; leave null if you filled "ratings"\n` +
    `  "reviewCount": <integer or null>,\n` +
    `  "summary":     "one sentence on overall product sentiment"\n` +
    `}\n` +
    `QUOTE RULES (strict): each quote.text MUST be a verbatim substring of the narrative above, copied character-for-character. If the narrative contains no verbatim customer quotes (e.g. it only summarises sentiment), return an EMPTY quotes array — do NOT chop the summary into clause-fragments, do NOT paraphrase, do NOT invent, do NOT complete a fragment into a sentence. Quotes failing this are dropped in code, so inventing one only loses it.`;

  let structData;
  try {
    structData = await trackedGenerate(
      { stage: 'product_reviews', purposeTag: 'json_structure', grounded: false, ledger },
      {
        contents: [{ role: 'user', parts: [{ text: structurePrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: GROUNDED_PASS2_MAX_TOKENS,
          responseMimeType: 'application/json',
          // Same as brand-reviews above — disable thinking so the 1200
          // token budget goes to the actual JSON instead of hidden
          // reasoning. Eliminates the "structuring produced no parsable
          // JSON" warnings caused by MAX_TOKENS-mid-JSON truncations.
          thinkingConfig: { thinkingBudget: 0 },
          // Schema-enforced output to eliminate "structuring produced
          // no parsable JSON" warnings — Gemini was returning markdown-
          // wrapped JSON, prose with embedded JSON, or fields with
          // wrong types. responseSchema constrains output to exactly
          // our shape; the parser below becomes a safety net.
          responseSchema: {
            type: 'object',
            properties: {
              quotes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text:   { type: 'string' },
                    author: { type: 'string', nullable: true },
                    source: { type: 'string', nullable: true },
                    // Funnel stage the quote serves, per AD_USABLE_QUOTE_DIRECTIVE.
                    // Carried through so selection can match a quote to the ad's
                    // intent instead of always printing the same top-scored line.
                    // Nullable: an unlabelled quote is still usable, it just
                    // cannot win a stage-biased pick.
                    stage: { type: 'string', nullable: true }
                  },
                  required: ['text']
                }
              },
              // REQUIRED, and NOT nullable — this is the whole fix.
              //
              // Declared optional, Gemini structured output simply DID NOT EMIT IT.
              // Measured: the identical prompt against the same model returns all four
              // aggregates when no responseSchema constrains the call, and returns none
              // when this property is optional. So pass 1 wrote
              // "Vuoriclothing.com: 4.58 out of 5 from 15,626 reviews / Trustpilot: 2.3
              // from 126 / WorthEPenny: 3.8 from 28 / Thingtesting: 4 from 137", pass 2
              // read it, and the schema dropped every one on the floor — the brand came
              // back with no rating at all and the picker had nothing to rank.
              //
              // An empty array is how "no aggregates found" is expressed; that is a
              // different statement from "the field is absent", and only the required
              // form makes the model commit to one of them.
              ratings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    source:      { type: 'string', nullable: true },
                    // Non-nullable: an entry with no number is not an aggregate. A
                    // source with a non-numeric grade (BBB's "A+") is correctly omitted
                    // rather than emitted as a null the picker has to filter out.
                    rating:      { type: 'number' },
                    reviewCount: { type: 'number', nullable: true }
                  },
                  required: ['rating']
                }
              },
              rating:      { type: 'number',  nullable: true },
              reviewCount: { type: 'integer', nullable: true },
              summary:     { type: 'string',  nullable: true }
            },
            required: ['quotes', 'ratings']
          }
        }
      },
      GROUNDED_CALL_TIMEOUT_MS
    );
  } catch (err) {
    console.warn(`   ⚠️  product-reviews structuring failed: ${err.message}`);
    return { quotes: [], rating: null, reviewCount: null, summary: summarySnippet(narrative), source: PROVIDER_NAME };
  }

  const structCand = structData?.candidates?.[0];
  const jsonText = (structCand?.content?.parts || []).map(p => p.text || '').join('').trim();

  let parsed = null;
  try { parsed = JSON.parse(jsonText); } catch (_) {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed) {
    console.warn(`   · product-reviews: structuring produced no parsable JSON for ${productLabel}`);
    return { quotes: [], rating: null, reviewCount: null, summary: summarySnippet(narrative), source: PROVIDER_NAME };
  }

  const result = {
    // PROVENANCE: these quotes are produced by a grounded LLM search over the
    // open web, not scraped verbatim from the merchant's review app. They are
    // stamped so nothing downstream can present them as first-party customer
    // reviews — see stampLlmQuotes().
    quotes:      stampLlmQuotes(keepVerbatimQuotes(parsed.quotes, narrative, 'product-reviews'), 'product'),
    // ONE number is chosen from ALL the aggregates found, by an explicit rule, and the
    // choice is recorded — see pickBestRating. The legacy single `rating` is folded in as
    // just another candidate so an older-shaped response still works.
    ...pickBestRating([
      ...(Array.isArray(parsed.ratings) ? parsed.ratings : []),
      { rating: parsed.rating, reviewCount: parsed.reviewCount, source: null }
    ]),
    summary:     parsed.summary || null,
    source:      PROVIDER_NAME
  };
  console.log(`   ✓ product-reviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''}${result.reviewCount != null ? ` · ${result.reviewCount.toLocaleString()} reviews` : ''}${result.ratingSource ? ` · via ${result.ratingSource}` : ''} (${Date.now() - t0}ms, two-pass)`);
  return result;
}

module.exports = {
  match,
  isEnabled,
  PROVIDER_NAME,
  lookupBrandCategoryUrl,
  lookupBrandReviews,
  lookupProductReviews,
  // Exported so categoryReviewsService uses the SAME directive rather than a
  // fourth copy of the wording, and so the harness can assert on it directly.
  AD_USABLE_QUOTE_DIRECTIVE,
  LLM_QUOTE_CAP,
  // Exported so the harness executes the SHIPPED anti-fabrication and
  // sentence-completeness logic rather than a copy of it.
  keepVerbatimQuotes,
  completeSentencesOnly,
  screenAdUsableSentiment,
  loadSentimentJudge,
  pickBestRating,
  RATING_MIN_CREDIBLE_REVIEWS,
  RATING_MIN_SAMPLE_ANY,
  GROUNDED_PASS1_CONFIG,
  GROUNDED_PASS2_MAX_TOKENS,
  GROUNDED_CALL_TIMEOUT_MS,
  warnIfTruncated
};
