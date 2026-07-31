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
const alerts = require('./alertService');
const Comment = require('../models/Comment');
// Conversion-weighted sentence ranking, shared with the review-storage path.
const { scoreSentence } = require('../utils/reviewText');
const { splitSentences } = require('../utils/htmlEntities');

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

    const elapsedMs = Date.now() - t0;
    console.log(`💬 quoteSnippet: "${snippet}" (${snippet.length}c) from ${clean.length}c in ${elapsedMs}ms`);
    return snippet;
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
  strongestSentence,
  bestClause,
  shortenProofLine,
  judgeProofLines,
  ensureCommentsJudged,
  usableProofComments,
  usableProofCommentsOrNone,
  PROOF_LINE_MAX_CHARS,
  MAX_CHARS
};
