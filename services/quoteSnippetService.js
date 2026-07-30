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

const { chatCompletion } = require('./atlasLlmService');

// 'quote-snippet' role → Atlas openai/gpt-5-nano (see atlasModelMap). Sized to
// the job: one short review in, ~8 words out, strict schema, no reasoning.
const MODEL_ID  = process.env.QUOTE_SNIPPET_MODEL_ID || 'quote-snippet';
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
    'RULES:',
    '- Extractive: the phrase MUST appear (near-)verbatim in the source. Minor trimming of leading/trailing filler is fine.',
    '- 4–8 words, ≤50 characters.',
    '- COMPLETE THOUGHT: it must stand on its own and read as a finished statement. Never end mid-clause, and never rely on an ellipsis to imply the rest. If you cannot find a self-contained phrase that fits, return the strongest SHORT complete one rather than the opening fragment of a longer sentence.',
    '- POSITIVE, and about THIS product: pick praise of the item itself — fit, feel, quality, how it performs. Skip complaints, mixed or hedged lines ("a bit tight but…"), and anything about shipping, packaging, or service.',
    '- Punchy: sensory, specific, emotionally loaded. Skip generic praise ("great product", "love it", "amazing").',
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

// Deterministic fallback, used when the LLM is unavailable or returns
// something non-extractive. It has to satisfy the same contract as the LLM
// path, because nothing downstream shortens the result again: whole words,
// and a finished thought wherever one fits.
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
  if (clean.length <= MAX_CHARS) return clean;

  // Atlas is the primary route and OpenAI only the direct fallback, so gating
  // on OPENAI_API_KEY alone silently disabled extraction on an Atlas-only
  // deployment — every quote fell back to mechanical truncation.
  if (!process.env.ATLAS_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn('quoteSnippet: no ATLAS_API_KEY or OPENAI_API_KEY — mechanical truncate');
    return truncateAtWordBoundary(clean);
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
          { role: 'user',   content: `Source: "${clean}"` }
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
      console.warn(`quoteSnippet: LLM emitted ${snippet.length} chars (>${MAX_CHARS}) — truncate fallback`);
      return truncateAtWordBoundary(clean);
    }
    if (!isExtractive(snippet, clean)) {
      console.warn(`quoteSnippet: non-extractive "${snippet}" — truncate fallback`);
      return truncateAtWordBoundary(clean);
    }

    const elapsedMs = Date.now() - t0;
    console.log(`💬 quoteSnippet: "${snippet}" (${snippet.length}c) from ${clean.length}c in ${elapsedMs}ms`);
    return snippet;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`quoteSnippet: failed after ${elapsedMs}ms (${err.message}) — truncate fallback`);
    return truncateAtWordBoundary(clean);
  }
}

// Ceiling for ANY proof line rendered on an ad — review quote or social
// comment. Comments never pass through extractSnippet (they are bound
// directly from social_context.top_comments[]), so they are shortened with
// truncateAtWordBoundary at this width instead of being raw-sliced.
const PROOF_LINE_MAX_CHARS = 60;

// One-line helper so every comment emitter shortens identically. Deliberately
// the same routine the quote fallback uses: a complete sentence or clause when
// one fits, otherwise a space-boundary cut — never mid-word.
function shortenProofLine(text, maxChars = PROOF_LINE_MAX_CHARS) {
  const clean = String(text || '').trim();
  return clean ? truncateAtWordBoundary(clean, maxChars) : '';
}

module.exports = {
  extractSnippet,
  truncateAtWordBoundary,   // exported for testing / direct fallback callers
  shortenProofLine,
  PROOF_LINE_MAX_CHARS,
  MAX_CHARS
};
