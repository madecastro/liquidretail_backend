// Quote snippet extractor. Given a review or social-comment string,
// returns a punchy ≤50-char extractive snippet suitable for a
// 3-second video overlay.
//
// Extractive by design — the snippet must appear (near-)verbatim in
// the source so it preserves the reviewer's voice. Non-extractive LLM
// outputs are rejected and the fallback mechanical truncation is used.
//
// Called from layoutInputService.assembleInput after the primary_quote
// winner is picked, so the snippet is cached on the LayoutInputArtifact
// alongside the full quote text.

const crypto = require('crypto');
const { trackLlmCall } = require('./costTracker');

const { chatCompletion, isConfigured: atlasConfigured } = require('./atlasLlmService');
const alerts = require('./alertService');
const Comment = require('../models/Comment');
// Cross-process cache — closes the "same review, N processes, N × 15s LLM"
// duplication measured on run_1787696303378. See the block comment above the
// L2 helpers below and models/QuoteSnippetCache.js's header.
const QuoteSnippetCache = require('../models/QuoteSnippetCache');
// Conversion-weighted sentence ranking, shared with the review-storage path.
const { scoreSentence, OFF_PRODUCT, NOISE } = require('../utils/reviewText');
const { splitSentences } = require('../utils/htmlEntities');

// ── Per-process extractSnippet cache ─────────────────────────────────
//
// Same source text → same snippet output → same 15s LLM call. Measured
// on adgen at 8-way per-instance concurrency: 9 static ads in one run
// all invoked extractSnippet on the identical Pelagic Gear review text
// and each fired its own ~15s LLM request. Wasted ~15 concurrent LLM
// seconds per ad + N × $0.001 in duplicate spend per run — small per
// run, ~$18/hr at the 2000 static/hr target.
//
// Cache is per-process (per-instance in the adgen fleet) so autoscale
// doesn't share it across renderers — first ad per instance still pays
// the 15s LLM. LRU-capped at CACHE_CAP entries so a rich long-tail of
// unique quotes cannot OOM the process. Cache stores the return value
// verbatim (string OR null — extractSnippet returns null for empty or
// unprintable inputs) so a cache hit shortcuts to the exact same value
// the LLM path would have produced.
//
// Also cached: the pre-LLM short-circuits (empty text, already-fit,
// strongest-sentence-fits) still return without a cache write — those
// are ~0-cost paths and caching them would just add overhead.
const SNIPPET_CACHE_CAP = Number(process.env.QUOTE_SNIPPET_CACHE_CAP || 1000);
const snippetCache = new Map();
function snippetCacheKey(clean, opts = {}) {
  // brandId + productId in the key so a rare same-text-different-product
  // scenario doesn't cross-pollute — cheap defence, LLM output doesn't
  // actually depend on them today but might tomorrow if the prompt starts
  // reading brand/product context.
  const h = crypto.createHash('sha1');
  h.update(clean);
  h.update('|');
  h.update(String(opts.brandId || ''));
  h.update('|');
  h.update(String(opts.productId || ''));
  return h.digest('hex');
}
function snippetCacheGet(key) {
  if (!snippetCache.has(key)) return undefined;
  // Refresh LRU order — get + delete + set puts the entry at the tail.
  const v = snippetCache.get(key);
  snippetCache.delete(key);
  snippetCache.set(key, v);
  return v;
}
function snippetCacheSet(key, value) {
  if (snippetCache.has(key)) snippetCache.delete(key);
  snippetCache.set(key, value);
  // Evict oldest (Map iteration order is insertion order — first key is oldest).
  while (snippetCache.size > SNIPPET_CACHE_CAP) {
    const oldest = snippetCache.keys().next().value;
    snippetCache.delete(oldest);
  }
}

// ── L2: cross-process Mongo cache ─────────────────────────────────────
//
// Read: `mongoSnippetCacheGet(key)` returns the cached snippet string (or
// undefined on miss). $inc's hits for observability, non-blocking.
//
// Write: `mongoSnippetCacheSet(key, snippet, ctx)` upserts LLM-VERIFIED
// snippets only. Fire-and-forget; the return value is not awaited by the
// caller. Mechanical fallbacks are NOT written here — a subsequent process
// should retry the LLM in case the failure was transient (same rationale
// as mechanical()'s existing behaviour of returning without cache-write
// discipline for retries; see the mechanical() comment in extractSnippet).
async function mongoSnippetCacheGet(key) {
  try {
    const doc = await QuoteSnippetCache.findById(key).lean();
    if (!doc || typeof doc.snippet !== 'string') return undefined;
    // Fire-and-forget hit tracker.
    QuoteSnippetCache.updateOne(
      { _id: key },
      { $inc: { hits: 1 }, $set: { updatedAt: new Date() } }
    ).catch(() => {});
    return doc.snippet;
  } catch (err) {
    // Fail-open: a Mongo blip on the cache read must never fail the render.
    // The LLM path still runs.
    return undefined;
  }
}

function mongoSnippetCacheSet(key, snippet, { brandId = null, productId = null } = {}) {
  if (!snippet || typeof snippet !== 'string') return;
  // Fire-and-forget upsert. `$setOnInsert` preserves createdAt on refresh so
  // a hot entry ages out for LLM re-verification at TTL expiry (see model
  // header). Errors swallowed — the render already has the snippet from the
  // LLM path; the mongo cache write is pure telemetry infrastructure.
  QuoteSnippetCache.updateOne(
    { _id: key },
    {
      $set: { snippet, brandId, productId, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  ).catch(() => {});
}

// The 'review-text' role, not a bare model id: every review-text task in the
// app resolves through one entry in atlasModelMap so the cost/quality choice is
// made in one place. Currently google/gemini-2.5-flash-lite — chosen by
// measurement over 6 candidates through this exact prompt/schema (16x cheaper
// and slightly faster than the gpt-4o-mini/luna it replaces, identical
// correctness). There was briefly a 'quote-snippet' role pointing at
// openai/gpt-5-nano; that candidate 400'd with "router not found" in the same
// benchmark, so it would have silently failed every call and fallen through to
// the mechanical truncation below. The role has since been deleted from
// atlasModelMap — do not resurrect it.
// QUOTE_SNIPPET_MODEL_ID still overrides this one call site.
const MODEL_ID  = process.env.QUOTE_SNIPPET_MODEL_ID || 'review-text';
// KEPT AT 50 (2026-08-11 review, not widened). The defect that prompted that
// review — "often recommending it for casual wear and…" — was a SELECTION
// problem (the fallback ladder chose a mid-sentence fragment), not a width
// problem: the fix is bestFallbackSnippet's ordering below, not a bigger
// budget. Widening this would (a) stop matching the 2-line landscape overlay
// it was measured against — a longer string can re-introduce the CSS clamp
// on that box — and (b) break scripts/verifyQuoteSurfaceLength.js's V1 check,
// which pins this exact line to assert the video cap is untouched by the
// separate static-surface change. Reconsider only alongside a measurement of
// the actual overlay box, not as a side effect of this fix.
const MAX_CHARS = 50;

const RESPONSE_SCHEMA = {
  name:   'quote_snippet',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['snippet'],
    properties: {
      snippet: {
        type:        'string',
        description: 'A 4–8 word ≤50-character extractive snippet from the source review or comment. Verbatim (or near-verbatim with minor trimming). Punchy, sensory, specific — skip generic praise.'
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are pulling the sharpest phrase out of a customer review or social-media comment to use as the testimonial in a direct-response ad. Output ONLY the phrase — no framing, no surrounding quotes.',
    '',
    'This is the ONLY point at which the quote is shortened. Nothing downstream will trim it further, so what you return has to be ad-ready exactly as written.',
    '',
    'The goal is CONVERSION: the phrase has to move someone who is browsing to actually buy.',
    '',
    'PREFER, in this order:',
    '1. Risk reversal — the reviewer naming a worry and resolving it ("fits true to size", "exactly as pictured", "worth every penny"). This answers the question stopping the purchase.',
    '2. A specific outcome or before/after ("back pain gone after two weeks", "holds a charge six days").',
    '3. Durability over time ("still looks new after eight months").',
    '4. Repeat purchase ("third one I have bought").',
    '',
    'RULES:',
    '- Extractive: the phrase MUST appear (near-)verbatim in the source. Minor trimming of leading/trailing filler is fine.',
    '- 4–8 words, ≤50 characters.',
    '- COMPLETE THOUGHT: it must stand on its own and read as a finished statement. Never end mid-clause, and never rely on an ellipsis to imply the rest. If you cannot find a self-contained phrase that fits, return the strongest SHORT complete one rather than the opening fragment of a longer sentence.',
    '- POSITIVE, and about THIS product: pick praise of the item itself — fit, feel, quality, how it performs. Skip complaints, mixed or hedged lines ("a bit tight but…").',
    '- NEVER pick a phrase about shipping, delivery, packaging, returns or customer service, even if it is the most vivid line in the source. Those describe the retailer, not the product, and a negative one on an ad actively costs sales.',
    '- Skip generic praise ("great product", "love it", "amazing") — it carries no information. But a SHORT specific line is good ("awesome fit", "true to size").',
    '- Preserve the reviewer\'s voice — colloquial phrasing and imperfect grammar are fine.',
    '- No paraphrasing. No new words that weren\'t in the source.'
  ].join('\n');
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tokens, not characters. Apostrophes are removed rather than turned into
// spaces so "wasn't" survives as one token `wasnt` and can be recognised as the
// negator it is — `normalize()` above splits it into `wasn` + `t`, which is fine
// for containment and useless for meaning.
function tokens(s) {
  return String(s).toLowerCase().replace(/['’]/g, '').replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
}

// Words that inverting-scope a phrase that follows them. Dropping one of these
// from the front of an extracted span leaves a perfectly legal contiguous
// substring that says the opposite of what the customer said.
const NEGATORS = new Set([
  'not', 'no', 'never', 'none', 'nothing', 'nor', 'cannot', 'cant', 'wasnt', 'isnt',
  'arent', 'werent', 'wont', 'dont', 'doesnt', 'didnt', 'hasnt', 'havent', 'hadnt',
  'couldnt', 'wouldnt', 'shouldnt', 'aint', 'barely', 'hardly', 'scarcely', 'rarely',
  'seldom', 'without', 'unless', 'stopped', 'fails', 'failed', 'refused', 'wish'
]);
// How far back to look. "not worth it" is adjacent; "not really worth it" and
// "I was not at all sure" put one or two words in between.
const NEGATION_LOOKBACK = 3;

/**
 * Is `snippet` a faithful extract of `source`?
 *
 * Contiguous-substring containment was the whole test, and it conflates "these
 * characters appear in order" with "this means what the reviewer meant". Those
 * come apart at exactly one place — a negator immediately before the span — and
 * that is not a hypothetical: verified against the real function,
 *
 *   isExtractive('worth it',              'Not worth it for the price')      -> true
 *   isExtractive('sure about the fabric', "I wasn't sure about the fabric")  -> true
 *   isExtractive('holds up',              'It never holds up in the wash')   -> true
 *
 * Every one of those is a legal substring introducing no new words, and every
 * one inverts a complaint into praise under a named customer's byline. The LLM
 * is told to pick positive phrases, which is precisely the instruction that
 * makes it reach into a negative sentence for the positive-sounding half.
 *
 * Also now word-boundary aware. The old character test matched 'art' inside
 * 'the start of every season'.
 *
 * A span may occur more than once, so ALL occurrences are checked and the
 * snippet is accepted if ANY of them is clean — testing only the first is wrong
 * in both directions ("Not worth it at first, but honestly worth it now"
 * legitimately contains a clean second occurrence).
 */
/**
 * The exact SOURCE text for an approved span — the verbatim guarantee.
 *
 * isExtractive answers "are these the customer's WORDS" by comparing tokens:
 * it lowercases and strips punctuation, so it deliberately tolerates the model
 * re-rendering what it found. That is right for judging meaning and wrong for
 * deciding what to PRINT. Adversarial review found the hole: the LLM path
 * returned the MODEL's string once isExtractive approved it, so a review
 * reading `fits true to size` could ship as `Fits true to size?` or
 * `FITS TRUE TO SIZE!!!` — every word the customer's, no character theirs. A
 * fabricated `?` turns a confident claim into a doubtful one and invented `!!!`
 * manufactures enthusiasm, both under a real person's testimonial.
 *
 * So the model chooses a SPAN and we print the SOURCE, never the model's echo.
 * Returns the original substring (original case, original punctuation) or null
 * when the span cannot be located verbatim — in which case the caller falls
 * back mechanically rather than printing anything the source does not contain.
 */
function verbatimSpan(snippet, source) {
  const src = String(source || '');
  const sn = tokens(snippet);
  if (!sn.length) return null;

  // Re-tokenise the source WITH character offsets so an approved token window
  // maps back to real character positions in the untouched original.
  const marks = [];
  const re = /[\w'’]+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    marks.push({ tok: tokens(m[0])[0], start: m.index, end: m.index + m[0].length });
  }
  const srcToks = marks.map((x) => x.tok);

  for (let i = 0; i + sn.length <= srcToks.length; i++) {
    let match = true;
    for (let j = 0; j < sn.length; j++) {
      if (srcToks[i + j] !== sn[j]) { match = false; break; }
    }
    if (!match) continue;
    let negated = false;
    for (let k = Math.max(0, i - NEGATION_LOOKBACK); k < i; k++) {
      if (NEGATORS.has(srcToks[k])) { negated = true; break; }
    }
    if (negated) continue;
    return src.slice(marks[i].start, marks[i + sn.length - 1].end).trim() || null;
  }
  return null;
}

function isExtractive(snippet, source) {
  const sn = tokens(snippet);
  const src = tokens(source);
  if (!sn.length || sn.length > src.length) return false;

  for (let i = 0; i + sn.length <= src.length; i++) {
    let match = true;
    for (let j = 0; j < sn.length; j++) {
      if (src[i + j] !== sn[j]) { match = false; break; }
    }
    if (!match) continue;
    // A clean occurrence is one with no negator in the window before it.
    let negated = false;
    for (let k = Math.max(0, i - NEGATION_LOOKBACK); k < i; k++) {
      if (NEGATORS.has(src[k])) { negated = true; break; }
    }
    if (!negated) return true;
  }
  return false;
}

/**
 * strongestSentence(text) → string
 *
 * The single highest-scoring sentence of a multi-sentence review, ranked by
 * utils/reviewText.scoreSentence (positive, specific, risk-reversing; shipping
 * and service penalised).
 *
 * WHY THIS RUNS BEFORE THE MODEL. Measured 2026-07-27: given the whole review
 * "Ordered this on the 3rd and it arrived Tuesday. Still looks brand new after
 * eight months of daily use and two cats. Customer service never answered my
 * email.", EVERY model tested — including the one in production — returned
 * "Customer service never answered my email." as the sharpest phrase. It is
 * vivid, it is verbatim, so the extractive check passes it straight through
 * onto the ad. Narrowing the input to one sentence removed that failure on
 * every review in the sample.
 *
 * Two other things fell out of it: cost and latency roughly halve on a shorter
 * prompt, and reasoning-model token spend drops by an order of magnitude
 * (a whole-review call was observed spending 2,422 reasoning tokens against an
 * 828-token budget, which silently returns an empty message).
 */
function strongestSentence(text) {
  const clean = String(text || '').trim();
  if (!clean) return clean;
  const parts = splitSentences(clean).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return clean;
  return parts.reduce((best, s) => (scoreSentence(s) > scoreSentence(best) ? s : best));
}

/**
 * bestClause(text, maxChars) → string | null
 * A whole comma/semicolon/dash-delimited clause that fits. Used before
 * falling back to an ellipsis cut so the overlay reads as something the
 * reviewer actually said rather than a sentence chopped in half.
 *
 * RANKED BY POSITION FIRST, SCORE SECOND (2026-08-11 fix). The clause that
 * opens the sentence (`startsAtOpen`) is preferred over any clause that opens
 * mid-sentence, even when the continuation scores higher on content —
 * "The cushions are firm, often recommend it daily for casual comfort" used
 * to return "often recommend it daily for casual comfort" purely because
 * DURATION/POSITIVE keywords outscored the plain opening clause. That reads
 * as a fragment ripped out of the middle: lowercase, no antecedent for "it".
 * Position beats score; score only breaks ties WITHIN the same tier.
 */
function bestClause(text, maxChars = MAX_CHARS) {
  const pieces = String(text || '').split(/\s*[,;—–]\s*|\s+[-]\s+/);
  const clauses = pieces
    .map((s, i) => ({ text: s.trim().replace(/[.!?]+$/, ''), startsAtOpen: i === 0 }))
    .filter(c => c.text && c.text.length <= maxChars && c.text.split(/\s+/).length >= 3);
  if (!clauses.length) return null;
  // Position is a BONUS, never an override.
  //
  // The first cut of this fix returned the opening clause whenever one existed,
  // ranking position ahead of content unconditionally. Adversarial review broke
  // it with the single most common real review shape — hedge, then redeem:
  //
  //   "Shipping was slow and disappointing, but the shirt is fantastic"
  //
  // The opening clause is the COMPLAINT, so a position-first rule prints
  // "Shipping was slow and disappointing" as the testimonial on the ad. That is
  // strictly worse than the mid-sentence fragment this function exists to avoid:
  // a fragment reads awkwardly, a complaint actively sells against the product.
  //
  // OPEN_BONUS is sized to beat a modest keyword edge (a plain opening clause
  // over a slightly punchier continuation) while still losing to a clause that
  // is genuinely better copy — POSITIVE alone is +5, RISK_REVERSAL +6. It can
  // never rescue a clause scoreSentence actively penalises (OFF_PRODUCT -6,
  // NOISE -8), which is what keeps shipping/delivery complaints off the ad.
  const OPEN_BONUS = 3;
  const rank = (c) => scoreSentence(c.text) + (c.startsAtOpen ? OPEN_BONUS : 0);
  return clauses.reduce((best, c) => (rank(c) > rank(best) ? c : best)).text;
}

/**
 * bestWholeSentence(fullText, exclude, maxChars) → string | null
 *
 * A DIFFERENT complete sentence elsewhere in the same review that already
 * fits whole and ends on its own terminator (. ! ?) — tried before any cut
 * of the chosen `source` sentence. A short, complete, lower-scoring line
 * reads as something the reviewer actually said; a truncated high-scoring
 * one reads as a fragment. This is the fix for the 2026-08-11 defect: a
 * delivered ad rendered
 *   "often recommending it for casual wear and…"
 * — lowercase, mid-sentence, ellipsis-terminated. That sentence had no comma
 * and no early period to cut on, so the old ladder (bestClause then
 * truncateAtWordBoundary) fell straight to a lowercase hard-slice. Preferring
 * a shorter, complete, self-contained sentence from the SAME review — when
 * one exists — avoids manufacturing a fragment at all.
 *
 * Gated at score > 0, the same positivity bar strongestSentence applies, so
 * this can never resurrect a short negative line (e.g. a shipping complaint)
 * purely because it happens to be brief enough to fit.
 */
function bestWholeSentence(fullText, exclude, maxChars = MAX_CHARS) {
  const parts = splitSentences(String(fullText || '')).map(s => s.trim()).filter(Boolean);
  const candidates = parts.filter(s =>
    s !== exclude &&
    s.length > 0 && s.length <= maxChars &&
    /[.!?]$/.test(s) &&
    s.split(/\s+/).length >= 3 &&
    scoreSentence(s) > 0
  );
  if (!candidates.length) return null;
  return candidates.reduce((best, s) => (scoreSentence(s) > scoreSentence(best) ? s : best));
}

/**
 * bestFallbackSnippet(fullText, source, maxChars) → string
 *
 * The mechanical ladder used whenever the LLM is unavailable, fails, returns
 * something oversized, or returns something non-extractive. Ordered so a
 * self-contained excerpt always beats a mid-sentence fragment:
 *
 *   1. A different WHOLE sentence elsewhere in the review that fits and ends
 *      on a real terminator (bestWholeSentence). "A complete short sentence
 *      beats a truncated long one."
 *   2. The strongest sub-clause of `source` itself, preferring the clause
 *      that opens the sentence over one that opens mid-sentence (bestClause).
 *      "If nothing self-contained fits, prefer a clause that at least BEGINS
 *      at a sentence start."
 *   3. LAST RESORT: an ellipsis-marked cut of `source` (truncateAtWordBoundary).
 *
 * Every tier operates on VERBATIM substrings only — this reorders which
 * verbatim candidate wins, it never generates or edits text.
 */
/**
 * PROOF_BAR — the standard a printed quote has to clear, applied to the
 * MECHANICAL path so it matches what the LLM path is already told to do.
 *
 * OWNER FRAMING (2026-08-11): "the question isn't provenance, it's whether it
 * is helping or hurting our advertisement."
 *
 * buildSystemPrompt already encodes that standard for the model — conversion
 * first, COMPLETE THOUGHT, "never rely on an ellipsis", positive and about THIS
 * product, no shipping/delivery/service lines, no generic praise. The mechanical
 * fallback enforced NONE of it: it cut whatever fit and shipped it. That is how
 * "often recommending it for casual wear and…" reached a live ad — a
 * third-person fragment, opening lowercase, ending in an ellipsis. Nobody chose
 * it; the fallback simply had no bar.
 *
 * So the fallback now applies the same bar, and returns null when nothing
 * clears it. A missing quote is fine — the rating carries the proof, which is
 * the Rating-First case in the social-proof guidelines. A bad quote is not: it
 * spends impressions arguing against the product.
 */
const LEADING_CONNECTIVE = /^(?:but|and|so|yet|or|though|although|however|plus|also|then|because|since|while|which|that)\b[\s,]*/i;

// Third-person AGGREGATE register — "customers report…", "reviewers often
// recommend…", "shoppers say…". This is review-SUMMARY prose, not a person
// speaking, and printing it inside quotation marks presents a synthesis as a
// testimonial. It is also what the reported defect actually was: the line
// "…often recommending it for casual wear and moderate activity" reads as a
// summary of many reviews, which is why no attribution could ever be honest
// for it. A testimonial is one customer's voice; this never is.
const AGGREGATE_VOICE = /\b(?:customers?|reviewers?|shoppers?|buyers?|users?|people|many|most|everyone)\s+(?:\w+\s+){0,2}(?:report|reports|reported|say|says|said|recommend|recommends|recommending|note|notes|noted|mention|mentions|agree|agrees|find|finds|love|loves|praise|praises)\b/i;

// DISQUALIFY, don't rank. These are the two different jobs:
//   - meetsProofBar answers "could this ever be printed?" (content veto)
//   - scoreSentence answers "which of these is best?" (ranking)
// The first cut of this bar conflated them by requiring scoreSentence > 0,
// which banned generic praise outright. That is stricter than intended —
// "Generic praise is absolutely fine if something is more specific" (owner,
// 2026-08-11): a specific line should WIN, but "Love it, great fit" is a
// perfectly shippable overlay when it is the best the review offers. Ranking
// already prefers specificity (GENERIC_PRAISE is -5 inside scoreSentence), so
// the bar only has to stop the things that actively hurt the ad.
function meetsProofBar(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Review-summary prose, not a person speaking — see AGGREGATE_VOICE.
  if (AGGREGATE_VOICE.test(t)) return false;
  // An ellipsis means we never found a finished thought — the system prompt's
  // "never rely on an ellipsis to imply the rest", enforced rather than asked.
  if (/[…]|\.\.\./.test(t)) return false;
  // A trailing question is a doubt, not a testimonial.
  if (/\?\s*$/.test(t)) return false;
  if (t.split(/\s+/).filter(Boolean).length < 3) return false;
  // Retailer complaints (shipping, delivery, returns, customer service) and
  // pure noise never print, at any score. A negative line on a paid ad argues
  // against the product with our own money.
  if (OFF_PRODUCT.test(t)) return false;
  if (NOISE.test(t)) return false;
  return true;
}

/** Drop a dangling connective left behind by splitting on a comma. */
function trimConnective(text) {
  const t = String(text || '').trim();
  // "Shipping was slow, but the shirt is fantastic" -> clause "but the shirt is
  // fantastic". The "but" is an artifact of the split and a tell that something
  // preceded it; the quote is "the shirt is fantastic". Removing leading words
  // keeps the result a contiguous substring of the source, so it stays verbatim.
  const cut = t.replace(LEADING_CONNECTIVE, '').trim();
  return cut.length >= 3 ? cut : t;
}

/**
 * Highest-scoring sentence that FITS, with no score floor.
 *
 * bestWholeSentence requires scoreSentence > 0, which is the right filter when
 * we are looking for a standout line but wrong as the last word: it means a
 * review whose only content is generic praise yields nothing at all. Owner:
 * "Generic praise is absolutely fine if something is more specific" — so a
 * generic line is allowed to win once the specific tiers have had their turn.
 * Still ranked by score, so anything more specific beats it.
 */
function anyFittingSentence(fullText, maxChars = MAX_CHARS) {
  const parts = splitSentences(String(fullText || '')).map(s => s.trim()).filter(Boolean);
  const fits = parts.filter(s => s.length <= maxChars && meetsProofBar(trimConnective(s)));
  if (!fits.length) return null;
  return trimConnective(fits.reduce((best, s) => (scoreSentence(s) > scoreSentence(best) ? s : best)));
}

function bestFallbackSnippet(fullText, source, maxChars = MAX_CHARS) {
  const candidates = [
    bestWholeSentence(fullText, source, maxChars),
    bestClause(source, maxChars),
    // Last: a fitting sentence with no score floor, so generic praise can carry
    // the overlay when the review simply has nothing more specific to offer.
    anyFittingSentence(fullText, maxChars),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const cleaned = trimConnective(raw);
    if (cleaned.length <= maxChars && meetsProofBar(cleaned)) return cleaned;
  }
  // truncateAtWordBoundary is reached only when nothing self-contained exists.
  // Its output ends in an ellipsis BY CONSTRUCTION, so it can never clear the
  // bar — which is the point. Returning null here is what stops an unfinished
  // fragment from being printed as a customer testimonial.
  return null;
}

// Word-boundary truncation with a trailing ellipsis. LAST-RESORT fallback only
// — strongestSentence/bestClause are tried first, so an ellipsis now means we
// genuinely could not find a whole clause that fits. On a 50-char overlay
// derived from a longer review, a marked excerpt is honest; a mid-sentence cut
// presented as the full quote would not be.
function truncateAtWordBoundary(text, maxChars = MAX_CHARS) {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;

  // Trailing joiners only — sentence-ending . ! ? are kept, they are what
  // makes a candidate read as finished.
  const stripTrailing = (s) => s.replace(/[,;:—\-\s]+$/, '').trim();

  // A complete sentence that fits beats the opening fragment of a longer one,
  // and needs no ellipsis. Sentences first, then clauses.
  for (const boundary of [/[.!?]+["')\]]*(?=\s|$)/g, /[,;—](?=\s)/g]) {
    let best = '';
    for (const m of clean.matchAll(boundary)) {
      const candidate = stripTrailing(clean.slice(0, m.index + m[0].length));
      if (candidate.length <= maxChars && candidate.length > best.length) best = candidate;
    }
    if (best) return best;
  }

  // Nothing self-contained fits, so this one is genuinely elided. Cut on a
  // space, never inside a word: the old rule (`lastSpace > 20`) silently fell
  // through to a raw slice whenever the last space landed early, which is
  // exactly how a quote ends up severed mid-word. A single unbroken token
  // longer than the budget is returned whole — oversized beats unreadable.
  const slice = clean.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : (clean.split(/\s+/)[0] || slice);
  return stripTrailing(cut) + '…';
}

// Main export. Returns a snippet ≤MAX_CHARS. Always returns a string
// when given non-empty text (never null / undefined) — callers can
// treat this as a pure text transform.
async function extractSnippet(text, { brandId = null, productId = null } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  // A quote already inside the overlay budget is used AS-IS, with no model call
  // and no minimum length. A short specific line ("Awesome shirt with awesome
  // fit") is a perfectly good overlay — often better than a trimmed long one —
  // so brevity is never a reason to reject a quote or to pad it.
  // …but "already fits" is not the same as "worth printing". This short-circuit
  // used to return ANY short review verbatim, which let exactly the lines the
  // system prompt tells the model to skip walk straight onto an ad:
  // "Love it. Great product. Amazing." is 32 characters and says nothing.
  // Fitting the box was never the standard — helping the ad is.
  if (clean.length <= MAX_CHARS) return meetsProofBar(clean) ? clean : null;

  // Cache lookup BEFORE the strongest-sentence narrowing so cache lookup is a
  // single hash on the original text (deterministic across the caller). Cache
  // key includes brandId + productId per snippetCacheKey — see the module-
  // header comment for why.
  const cacheKey = snippetCacheKey(clean, { brandId, productId });
  const cached = snippetCacheGet(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  // L2: cross-process Mongo cache. Same key as L1. Hit here means a sibling
  // process already paid the LLM cost for this exact review text on this
  // (brand, product) — copy it into L1 so subsequent same-process reads
  // stay fast. Miss returns undefined and falls through to the LLM path.
  // Measured 2026-08-25: two adgen renderer processes each cold-hit L1 on
  // the same "fit and look great" quote and each paid ~15.7-15.9s of LLM
  // time. This lookup avoids that on any second process onward.
  const l2Hit = await mongoSnippetCacheGet(cacheKey);
  if (typeof l2Hit === 'string') {
    // Promote L2 hit into L1 so the next same-process call is instant.
    snippetCacheSet(cacheKey, l2Hit);
    return l2Hit;
  }

  // Narrow to the single strongest sentence BEFORE the model sees it. See
  // strongestSentence() — without this, every model tested picked a customer
  // service complaint out of a 3-sentence review.
  const source = strongestSentence(clean);
  // If that one sentence already fits, we are done — no model call at all.
  //
  // GATED (was not, until ad 6a8c830612c17a42936d529e rendered "Great for
  // offshore fishing and the length is....", the customer's OWN informal
  // trail-off punctuation, not an appended ellipsis). splitSentences' boundary
  // regex is `/[.!?…]+(?=\s+["'“(\[]?[A-Z0-9]|\s*$)/g` — `[.!?…]+` matches a
  // RUN of terminators as a single boundary, so a review that writes
  // "...and the length is.... 8'6\" and handles rough water great" splits
  // cleanly after the four dots (followed by whitespace + a digit, which
  // satisfies the lookahead), and strongestSentence can pick that fragment as
  // its highest scorer. This path returned it verbatim — the ONLY one of
  // extractSnippet's three return paths that did: the already-fits short
  // circuit above gates on meetsProofBar(clean), and the LLM path below
  // verifies isExtractive + verbatimSpan before ever printing. This path had
  // no gate at all, so a 48-char fragment ending in a run of dots sailed
  // through the `.length <= MAX_CHARS` check untouched.
  //
  // meetsProofBar rejects `/[…]|\.\.\./` (see ~:435), so gating here catches
  // exactly this. A source that fits the budget but fails the bar is not
  // dropped outright — it is re-run through the same clause/sentence ladder
  // used for an over-budget quote (bestFallbackSnippet), so a salvageable
  // whole clause still ships instead of nothing.
  if (source.length <= MAX_CHARS && meetsProofBar(source)) {
    snippetCacheSet(cacheKey, source);
    // Pre-LLM verified path — deterministic given the source, safe to persist
    // cross-process so N sibling processes don't each re-derive.
    mongoSnippetCacheSet(cacheKey, source, { brandId, productId });
    return source;
  }
  if (source.length <= MAX_CHARS) {
    // Fits the budget but fails the bar — run the same clause/sentence ladder
    // used for an over-budget quote instead of shipping the fragment.
    const salvaged = bestFallbackSnippet(clean, source, MAX_CHARS);
    snippetCacheSet(cacheKey, salvaged);
    // Deterministic pre-LLM output; safe to cross-process cache.
    mongoSnippetCacheSet(cacheKey, salvaged, { brandId, productId });
    return salvaged;
  }

  // Fallback ladder, best-first, used whenever the model is unavailable or
  // returns something unusable: a different whole sentence → whole clause →
  // marked excerpt. See bestFallbackSnippet's docstring.
  //
  // Cache-aware wrapper: every mechanical() return goes through the cache too,
  // so a run whose LLM call failed once (e.g. rate-limited) doesn't retry the
  // LLM on the next ad — it takes the same mechanical output.
  const mechanical = () => {
    const m = bestFallbackSnippet(clean, source, MAX_CHARS);
    snippetCacheSet(cacheKey, m);
    return m;
  };

  // atlasConfigured(), not a bare OPENAI_API_KEY check: Atlas is the primary
  // route and OpenAI only the direct fallback, so gating on OPENAI_API_KEY
  // alone silently disabled extraction on an Atlas-only deployment — every
  // quote fell back to mechanical truncation.
  if (!atlasConfigured() && !process.env.OPENAI_API_KEY) {
    console.warn('quoteSnippet: no ATLAS_API_KEY or OPENAI_API_KEY — mechanical fallback');
    return mechanical();
  }

  const t0 = Date.now();
  try {
    const completion = await chatCompletion(
      {
        stage:      'quote_snippet',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'extract',
        brandId, productId,
        visionImages: 0,
        cacheKey:   null
      },
      {
        model:           MODEL_ID,
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user',   content: `Source: "${source}"` }
        ],
        temperature: 0.3,
        max_tokens:  60
      }
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('empty response');
    const parsed  = JSON.parse(raw);
    const snippet = String(parsed.snippet || '').trim();

    if (!snippet) throw new Error('empty snippet');
    if (snippet.length > MAX_CHARS) {
      console.warn(`quoteSnippet: LLM emitted ${snippet.length} chars (>${MAX_CHARS}) — mechanical fallback`);
      return mechanical();
    }
    // Checked against the FULL review, not the preselected sentence: the model
    // may legitimately trim across a clause boundary, and anything verbatim in
    // the reviewer's own text is still their words.
    if (!isExtractive(snippet, clean)) {
      console.warn(`quoteSnippet: non-extractive "${snippet}" — mechanical fallback`);
      return mechanical();
    }

    // PRINT THE SOURCE, NOT THE MODEL'S ECHO. isExtractive compares tokens
    // (lowercased, punctuation stripped), so it approves the customer's WORDS
    // while tolerating the model re-rendering their punctuation and case. What
    // ships must be the reviewer's actual characters, so re-cut the approved
    // span out of the original text. A span that cannot be located verbatim
    // falls back mechanically rather than printing the model's version.
    const verbatim = verbatimSpan(snippet, clean);
    if (!verbatim) {
      console.warn(`quoteSnippet: approved span not locatable verbatim "${snippet}" — mechanical fallback`);
      return mechanical();
    }
    if (verbatim !== snippet) {
      console.log(`💬 quoteSnippet: re-cut from source — model="${snippet}" source="${verbatim}"`);
    }
    if (verbatim.length > MAX_CHARS) {
      console.warn(`quoteSnippet: verbatim span ${verbatim.length} chars (>${MAX_CHARS}) — mechanical fallback`);
      return mechanical();
    }

    const elapsedMs = Date.now() - t0;
    console.log(`💬 quoteSnippet: "${verbatim}" (${verbatim.length}c) from ${clean.length}c in ${elapsedMs}ms`);
    snippetCacheSet(cacheKey, verbatim);
    // L2 write — LLM-verified only. Mechanical fallbacks are NOT written
    // (see the mongoSnippetCacheSet header): a subsequent process should
    // retry the LLM in case the original failure was transient.
    mongoSnippetCacheSet(cacheKey, verbatim, { brandId, productId });
    return verbatim;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`quoteSnippet: failed after ${elapsedMs}ms (${err.message}) — mechanical fallback`);
    return mechanical();
  }
}

// Ceiling for ANY proof line rendered on an ad — review quote or social
// comment. Comments never pass through extractSnippet (they are bound
// directly from social_context.top_comments[]), so they are shortened with
// truncateAtWordBoundary at this width instead of being raw-sliced.
const PROOF_LINE_MAX_CHARS = 60;

const JUDGE_SCHEMA = {
  name:   'proof_line_selection',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['lines'],
    properties: {
      lines: {
        type:  'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'usable', 'reason', 'line'],
          properties: {
            index:  { type: 'integer', description: 'The candidate number you are judging.' },
            usable: { type: 'boolean', description: 'True only if this is genuine praise that is safe to print on a paid ad.' },
            reason: { type: 'string',  description: 'At most 8 words on why. Required for both verdicts.' },
            line:   { type: 'string',  description: `The ad-ready extractive line, <=${PROOF_LINE_MAX_CHARS} characters, a complete thought. Empty string when usable is false.` }
          }
        }
      }
    }
  }
};

function buildJudgeSystemPrompt() {
  return [
    `You are choosing which customer comments may be printed as the testimonial on a paid direct-response ad, and shortening each chosen one to <=${PROOF_LINE_MAX_CHARS} characters.`,
    '',
    'JUDGE THE MEANING OF THE WHOLE SENTENCE. Do not decide on the presence or absence of any single word. A keyword test gets both of these backwards, so read them and understand why:',
    '  "Not great, would not buy again."           → NOT usable. It contains the word "great" and is still a complaint.',
    '  "Hasn\'t faded at all after a year, love it" → USABLE. It contains "faded" and is outstanding praise.',
    '',
    'USABLE means ALL of the following:',
    '- It is positive ON BALANCE about the product. Wholehearted, not hedged. "Nice but runs small" is not usable.',
    '- It is about the PRODUCT, not shipping, delivery, packaging, returns, or customer service.',
    '- It reads as a finished thought, not a fragment.',
    '- It is specific enough to mean something. Pure noise ("🔥🔥", "want", "need this") is not usable.',
    '- It says nothing that would embarrass the brand or make a claim the brand cannot stand behind (medical results, income, competitor comparisons).',
    '',
    'A NEGATED COMPLAINT IS PRAISE, and the strongest kind. "no cracks after a year", "doesn\'t smell", "never slips", "hasn\'t stretched out" are the reviewer naming the exact worry that stops a purchase and resolving it. Mark these usable and prefer them.',
    '',
    'FOR EACH USABLE CANDIDATE, return `line`: the sharpest self-contained phrase from it, verbatim.',
    `- <=${PROOF_LINE_MAX_CHARS} characters. This is the ONLY point at which it is shortened; nothing downstream trims it again, so it must be ad-ready exactly as written.`,
    '- Extractive, and CONTIGUOUS. Copy an unbroken run of words out of the candidate. You may cut from the START or the END, but you must NEVER remove words from the MIDDLE and close the gap. "no pilling after 6 months which is unheard of" → "no pilling after 6 months" is correct. Stitching "after a year" onto "love it" and dropping what sat between them is not, even though every word is the writer\'s. Removing interior words can reverse a meaning — "not great, would not buy" becomes "great ... buy" — so a non-contiguous line is rejected and your work on it is thrown away.',
    '- No paraphrasing, no new words, no reordering.',
    '- Never cut mid-word or mid-clause, and never use an ellipsis. If nothing self-contained fits, return the strongest SHORT complete phrase instead of the opening fragment of a long one.',
    '- Keep the writer\'s voice; colloquial phrasing and imperfect grammar are fine. Strip @handles and hashtags.',
    '',
    'When usable is false, set line to an empty string.',
    'Return exactly one entry per candidate, with its index. Judge each one independently.'
  ].join('\n');
}

/**
 * judgeProofLines(texts, ctx) → [{ index, usable, reason, line }]
 *
 * The positive/negative decision for UNRATED proof — social comments — made by
 * inference over the whole sentence, in ONE batched call for all candidates.
 *
 * WHY THIS IS NOT A LEXICON. The regex gate this replaces asked "does a
 * positive word appear in the string", which accepted "Not great, would not
 * buy again" because the word `great` is in it. Adding a complaint blocklist
 * on top then rejected "Hasn't faded at all after a year, love it" — risk
 * reversal, the single most persuasive thing a reviewer can write, and the
 * exact form the snippet prompt above is told to PREFER. An allowlist and a
 * blocklist cannot both be right about a negation; sentiment is a property of
 * the sentence, not of its words.
 *
 * One call per candidate set, ~$0.00002 through the review-text role. The
 * model also returns the shortened line, so a comment is still judged and
 * shortened exactly ONCE.
 *
 * Callers must handle `usable: false` by DROPPING the candidate.
 *
 * NO LEXICAL FALLBACK — IT FAILS LOUD. See docs/PROOF_JUDGE.md. chatCompletion
 * already tries Atlas and then the direct provider for the same model; if BOTH
 * are unreachable there is no third path that can judge sentiment, and the
 * only alternatives would be to print unjudged comments or to silently degrade
 * to the keyword screen this function exists to replace. Both put a complaint
 * on a paid ad. So it alerts and throws, and the ad fails visibly.
 */
async function judgeProofLines(texts, { brandId = null, productId = null } = {}) {
  const candidates = (Array.isArray(texts) ? texts : [])
    .map((t, i) => ({ index: i, text: String(t || '').trim() }))
    .filter(c => c.text);
  if (!candidates.length) return [];

  const fail = (message, level) => {
    const err = new Error(`proofJudge: ${message}`);
    err.stage = 'proof_line_judge';
    err.alertKey = 'proof-judge:unavailable';
    err.alertLevel = level;
    alerts.notifyAsync({
      level,
      title: 'Social-proof judge unavailable',
      body: `${message}. Comments cannot be screened for sentiment, so no ad may render social proof until this clears.`,
      key:  err.alertKey
    });
    return err;
  };

  // No credential for Atlas AND none for the direct provider: this is a
  // configuration fault, not a transient one. Five-alarm.
  if (!atlasConfigured() && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    throw fail('no ATLAS_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY configured', 'fatal');
  }

  const t0 = Date.now();
  try {
    const completion = await chatCompletion(
      {
        stage:      'proof_line_judge',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'judge',
        brandId, productId,
        visionImages: 0,
        cacheKey:   null
      },
      {
        model:           MODEL_ID,
        response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA },
        messages: [
          { role: 'system', content: buildJudgeSystemPrompt() },
          { role: 'user',   content: candidates.map(c => `${c.index}. ${c.text}`).join('\n') }
        ],
        temperature: 0,
        max_tokens:  60 * candidates.length + 200
      }
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('empty response');
    const parsed = JSON.parse(raw);
    const byIndex = new Map();
    for (const row of (Array.isArray(parsed.lines) ? parsed.lines : [])) {
      if (Number.isInteger(row?.index)) byIndex.set(row.index, row);
    }

    const out = [];
    for (const c of candidates) {
      const row = byIndex.get(c.index);
      // A candidate the model did not return a verdict for is DROPPED, not
      // assumed good. Silence is not approval for text going onto an ad.
      // A candidate the model did not return a verdict for is DROPPED from
      // THIS ad — silence is not approval — but `transient` marks it as never
      // actually judged, so the verdict is not persisted. Storing it as a
      // usable:false would permanently blacklist a perfectly good comment on
      // the strength of one truncated or malformed response, and nothing would
      // ever revisit it.
      if (!row) { out.push({ index: c.index, usable: false, reason: 'no verdict returned', line: '', transient: true }); continue; }
      let line = String(row.line || '').trim();
      const usable = row.usable === true && !!line;
      // The model is told to stay extractive and inside the budget; verify
      // rather than trust, and fall back to a mechanical cut of the ORIGINAL
      // rather than printing a paraphrase.
      if (usable && !isExtractive(line, c.text)) {
        console.warn(`proofJudge: non-extractive "${line}" — mechanical shorten`);
        line = shortenProofLine(c.text);
      }
      if (usable && line.length > PROOF_LINE_MAX_CHARS) {
        line = shortenProofLine(line);
      }
      out.push({ index: c.index, usable, reason: String(row.reason || '').slice(0, 60), line: usable ? line : '' });
    }

    const kept = out.filter(r => r.usable).length;
    console.log(`⚖️  proofJudge: ${kept}/${candidates.length} usable in ${Date.now() - t0}ms`);
    return out;
  } catch (err) {
    // chatCompletion has already tried Atlas and then the direct provider for
    // this model. Reaching here means neither answered, so there is nothing
    // left that can judge sentiment. Stop; do not guess.
    throw fail(`judge call failed after ${Date.now() - t0}ms (${err.message})`, 'error');
  }
}

// One-line helper so every comment emitter shortens identically. Deliberately
// the same routine the quote fallback uses: a complete sentence or clause when
// one fits, otherwise a space-boundary cut — never mid-word.
function shortenProofLine(text, maxChars = PROOF_LINE_MAX_CHARS) {
  const clean = String(text || '').trim();
  return clean ? truncateAtWordBoundary(clean, maxChars) : '';
}

/**
 * ensureCommentsJudged(comments, ctx) → the same rows, each with proofJudgment
 *
 * The read-side half of the ingest judgment. Rows already carrying a verdict
 * cost nothing; rows without one are judged in a single batched call and the
 * verdict is PERSISTED, so the next ad that touches the same comment reads it
 * from the row.
 *
 * That lazy fill is what lets the judgment be an ingest concern without a
 * backfill: a comment ingested before the judge existed, or ingested while the
 * judge was down, gets its verdict the first time something wants to render
 * it. Forward-only, self-healing.
 *
 * Throws if the judge is unavailable — see judgeProofLines. Callers must NOT
 * catch that and render the comments anyway.
 */
async function ensureCommentsJudged(comments, { brandId = null, productId = null } = {}) {
  const rows = (Array.isArray(comments) ? comments : []).filter(c => c && String(c.text || '').trim());
  if (!rows.length) return [];

  const unjudged = rows.filter(c => typeof c.proofJudgment?.usable !== 'boolean');
  if (!unjudged.length) return rows;

  const verdicts = await judgeProofLines(unjudged.map(c => c.text), { brandId, productId });
  const judgedAt = new Date();
  const ops = [];
  for (const v of verdicts) {
    const doc = unjudged[v.index];
    if (!doc) continue;
    const judgment = { usable: v.usable, reason: v.reason || null, line: v.line || null, model: MODEL_ID, judgedAt };
    doc.proofJudgment = judgment;
    // `transient` means the model returned no verdict for this candidate, so
    // it was never really judged. Drop it from this ad, but do NOT write the
    // rejection — it would be indistinguishable from a considered one and
    // would outlive the glitch that caused it.
    if (doc._id && !v.transient) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { proofJudgment: judgment } } } });
    }
  }
  if (ops.length) {
    // A cache-write failure is not a correctness failure: the verdicts above
    // are already applied in memory, so this ad renders correctly and the next
    // one simply re-judges.
    try { await Comment.bulkWrite(ops, { ordered: false }); }
    catch (err) { console.warn(`proofJudge: verdict persist failed (${err.message}) — judged for this run only`); }
  }
  console.log(`⚖️  proofJudge: ${unjudged.length} newly judged, ${rows.length - unjudged.length} cached`);
  return rows;
}

/**
 * usableProofComments(comments, ctx) → rows the judge approved, each with
 * `.proofLine` set to the ad-ready ≤PROOF_LINE_MAX_CHARS text.
 *
 * The single entry point every surface that renders a comment should use, so
 * they cannot disagree about what counts as praise.
 */
// Hard ceiling on how many candidates go into one judge call. The response
// carries a line per candidate, so an unbounded batch can overrun the token
// budget, come back truncated, and fail JSON.parse — turning a chatty brand's
// comment section into a failed ad. Candidates arrive like-sorted, so the cap
// keeps the best ones.
const JUDGE_BATCH_MAX = Number(process.env.PROOF_JUDGE_BATCH_MAX || 60);

async function usableProofComments(comments, ctx = {}) {
  const capped = (Array.isArray(comments) ? comments : []).slice(0, JUDGE_BATCH_MAX);
  if (Array.isArray(comments) && comments.length > JUDGE_BATCH_MAX) {
    console.log(`⚖️  proofJudge: ${comments.length} candidates capped to ${JUDGE_BATCH_MAX} for judging`);
  }
  const judged = await ensureCommentsJudged(capped, ctx);
  const kept = judged
    .filter(c => c.proofJudgment?.usable === true && c.proofJudgment?.line)
    .map(c => Object.assign(c, { proofLine: c.proofJudgment.line }));
  if (judged.length !== kept.length) {
    console.log(`💬 proof comments — kept=${kept.length}/${judged.length} (judged usable)`);
  }
  return kept;
}

/**
 * usableProofCommentsOrNone(comments, ctx, where) → approved rows, or []
 *
 * ONE failure policy for every comment surface, in one place.
 *
 * judgeProofLines alerts and throws when the judge is unreachable, which is
 * right — nothing unjudged may be printed. But the consumers disagreed about
 * what to do with that throw: two swallowed it into an empty list, two let it
 * abort the whole ad. The same outage therefore killed some ads and quietly
 * degraded others, which is the worst of both.
 *
 * The policy: comments are ENRICHMENT. The judge being down means this ad gets
 * NO comments — never a raw one — and the alert has already fired. It does not
 * mean an ad holding 4.5-star review quotes should fail; that is the wrong
 * severity for the wrong reason. An ad whose only proof was comments now
 * legitimately has no proof, which the Director's HONESTY RULE already handles
 * by setting social_proof_type="none" rather than inventing something.
 */
async function usableProofCommentsOrNone(comments, ctx = {}, where = 'unknown') {
  try {
    return await usableProofComments(comments, ctx);
  } catch (err) {
    // judgeProofLines already alerted; this line is for the render log, so the
    // absence of comments on this ad is explained rather than mysterious.
    console.warn(`⚠️  proofJudge unavailable at ${where} — rendering with NO comments (${err.message})`);
    return [];
  }
}

module.exports = {
  extractSnippet,
  truncateAtWordBoundary,   // exported for testing / direct fallback callers
  // Exported for scripts/verifyQuoteProvenance.js. A negation-stripping
  // extract passes plain substring containment and inverts the review.
  isExtractive,
  strongestSentence,
  bestClause,
  bestWholeSentence,
  bestFallbackSnippet,
  shortenProofLine,
  judgeProofLines,
  ensureCommentsJudged,
  usableProofComments,
  usableProofCommentsOrNone,
  PROOF_LINE_MAX_CHARS,
  MAX_CHARS
};
