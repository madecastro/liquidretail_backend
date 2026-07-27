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

const { trackLlmCall } = require('./costTracker');

const { chatCompletion, isConfigured: atlasConfigured } = require('./atlasLlmService');
// Conversion-weighted sentence ranking, shared with the review-storage path.
const { scoreSentence } = require('../utils/reviewText');
const { splitSentences } = require('../utils/htmlEntities');

// The 'review-text' role, not a bare model id: every review-text task in the
// app resolves through one entry in atlasModelMap so the cost/quality choice is
// made in one place. Currently google/gemini-2.5-flash-lite — chosen by
// measurement over 6 candidates (16x cheaper and slightly faster than the
// gpt-4o-mini/luna it replaces, identical correctness); see that role's comment
// for the benchmark and why the nominally-cheaper reasoning models lose.
// QUOTE_SNIPPET_MODEL_ID still overrides this one call site.
const MODEL_ID  = process.env.QUOTE_SNIPPET_MODEL_ID || 'review-text';
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
    'You are pulling the sharpest phrase out of a customer review or social-media comment for a 3-second overlay in a video ad. Output ONLY the phrase — no framing, no surrounding quotes.',
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
    '- NEVER pick a phrase about shipping, delivery, packaging, returns or customer service, even if it is the most vivid line in the source. Those describe the retailer, not the product, and a negative one on an ad actively costs sales.',
    '- Skip generic praise ("great product", "love it", "amazing") — it carries no information. But a SHORT specific line is good ("awesome fit", "true to size").',
    '- Preserve the reviewer\'s voice — colloquial phrasing and imperfect grammar are fine.',
    '- No paraphrasing. No new words that weren\'t in the source.'
  ].join('\n');
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The snippet is considered extractive if its normalized form is a
// contiguous substring of the normalized source. Punctuation and case
// are ignored; word order matters. This catches paraphrases without
// being fooled by trivial punctuation differences.
function isExtractive(snippet, source) {
  return normalize(source).includes(normalize(snippet));
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
 * A whole comma/semicolon/dash-delimited clause that fits, highest-scoring
 * first. Used before falling back to an ellipsis cut so the overlay reads as
 * something the reviewer actually said rather than a sentence chopped in half.
 */
function bestClause(text, maxChars = MAX_CHARS) {
  const clauses = String(text || '')
    .split(/\s*[,;—–]\s*|\s+[-]\s+/)
    .map(s => s.trim().replace(/[.!?]+$/, ''))
    .filter(c => c && c.length <= maxChars && c.split(/\s+/).length >= 3);
  if (!clauses.length) return null;
  return clauses.reduce((best, c) => (scoreSentence(c) > scoreSentence(best) ? c : best));
}

// Word-boundary truncation with a trailing ellipsis. LAST-RESORT fallback only
// — strongestSentence/bestClause are tried first, so an ellipsis now means we
// genuinely could not find a whole clause that fits. On a 50-char overlay
// derived from a longer review, a marked excerpt is honest; a mid-sentence cut
// presented as the full quote would not be.
function truncateAtWordBoundary(text, maxChars = MAX_CHARS) {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars - 1);   // leave room for the ellipsis
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[,.;:!?—\-\s]+$/, '') + '…';
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
  if (clean.length <= MAX_CHARS) return clean;

  // Narrow to the single strongest sentence BEFORE the model sees it. See
  // strongestSentence() — without this, every model tested picked a customer
  // service complaint out of a 3-sentence review.
  const source = strongestSentence(clean);
  // If that one sentence already fits, we are done — no model call at all.
  if (source.length <= MAX_CHARS) return source;

  // Fallback ladder, best-first, used whenever the model is unavailable or
  // returns something unusable: whole clause → marked excerpt.
  const mechanical = () => bestClause(source) || truncateAtWordBoundary(source);

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

    const elapsedMs = Date.now() - t0;
    console.log(`💬 quoteSnippet: "${snippet}" (${snippet.length}c) from ${clean.length}c in ${elapsedMs}ms`);
    return snippet;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`quoteSnippet: failed after ${elapsedMs}ms (${err.message}) — mechanical fallback`);
    return mechanical();
  }
}

module.exports = {
  extractSnippet,
  truncateAtWordBoundary,   // exported for testing / direct fallback callers
  strongestSentence,
  bestClause,
  MAX_CHARS
};
