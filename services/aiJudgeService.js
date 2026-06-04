// Phase 3 — LLM Judge.
//
// Given N candidate canvas specs for an Ad (each materializing the same
// Director concept), picks the winner and writes an
// AiJudgeResultArtifact recording the rationale + per-candidate scores.
//
// Cost design (Lever 2 + L4):
//   - Model defaults to gpt-4.1-mini (~$0.40/$1.60 per M tokens). Use a
//     small model; judgment is constrained reasoning, not creative
//     generation. Env override JUDGE_MODEL flips this.
//   - Inputs are TEXT-ONLY summaries of each candidate spec (no vision,
//     no full JSON), so input tokens stay <2K per judgment call.
//   - This release runs ONE judge call per Ad (single-Ad batch). Phase
//     3.1 ships true multi-Ad batching when the orchestration is in
//     place; the artifact already supports judgments[N].

const OpenAI = require('openai');
const crypto = require('crypto');

const AiJudgeResultArtifact = require('../models/AiJudgeResultArtifact');
const { trackLlmCall } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-4.1-mini';
const TEMPERATURE         = 0.0;  // judgement should be deterministic-ish
const MAX_TOKENS          = 1500;

// ── Public API ───────────────────────────────────────────────────────

// Judge N candidates for a single Ad. Returns the winner spec + rationale.
//
// Each candidate is the canvas spec emitted by one Generator run. The
// concept the Generator was materializing is passed in so the Judge can
// score "did the candidate stay true to the strategy?" — without it the
// Judge has no anchor for what's "right."
async function judgeCandidates({
  candidates,
  concept       = null,
  inputSummary  = null,
  brandSignal   = null,
  brandId       = null,
  campaignId    = null,
  adId          = null,
  aiCanvasArtifactId = null
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('judgeCandidates: candidates[] required');
  }
  if (candidates.length === 1) {
    // Single candidate — no judging needed; auto-winner.
    return {
      winnerIndex: 0,
      rationale:   'single candidate — auto-selected',
      confidence:  1.0,
      judgeResultArtifactId: null,
      criteriaScores: []
    };
  }

  const summaries = candidates.map((spec, i) => compressSpecForJudge(spec, i));
  const { system, user } = buildPrompt({ summaries, concept, inputSummary, brandSignal });
  const promptHash = sha256(system + '\n' + user);
  const responseSchema = buildResponseSchema(candidates.length);

  const t0 = Date.now();
  const completion = await trackLlmCall(
    {
      stage:      'judge',
      provider:   'openai',
      model:      DEFAULT_JUDGE_MODEL,
      purposeTag: `concept:${concept?.concept_id || '-'}`,
      brandId, campaignId, adId,
      visionImages: 0,
      cacheKey: `judge:${aiCanvasArtifactId || '-'}`
    },
    () => openai.chat.completions.create({
      model:           DEFAULT_JUDGE_MODEL,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    })
  );
  const durationMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Judge returned no content');

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Judge response not JSON: ${err.message}`); }

  const winnerIndex = Math.max(0, Math.min(candidates.length - 1,
    Number.isInteger(parsed.winner_index) ? parsed.winner_index : 0));
  const rationale   = parsed.rationale || null;
  const confidence  = typeof parsed.confidence === 'number' ? parsed.confidence : null;
  const criteriaScores = Array.isArray(parsed.criteria_scores)
    ? parsed.criteria_scores.slice(0, candidates.length)
    : [];

  const usage = completion.usage || {};
  const artifact = await AiJudgeResultArtifact.create({
    brandId, campaignId,
    modelId:    DEFAULT_JUDGE_MODEL,
    promptHash,
    promptSystem: system,
    promptUser:   user,
    judgments: [{
      adId,
      aiCanvasArtifactId,
      conceptId:          concept?.concept_id || null,
      candidateCount:     candidates.length,
      candidateSummaries: summaries,
      winnerIndex,
      rationale,
      confidence,
      criteriaScores
    }],
    inputTokens:  usage.prompt_tokens     || 0,
    outputTokens: usage.completion_tokens || 0,
    durationMs
  });

  console.log(
    `⚖️  judge: brand=${brandId} ad=${adId || '-'} ` +
    `candidates=${candidates.length} winner=${winnerIndex} ` +
    `conf=${confidence?.toFixed?.(2) || '-'} took=${durationMs}ms`
  );

  return {
    winnerIndex,
    rationale,
    confidence,
    criteriaScores,
    judgeResultArtifactId: artifact._id
  };
}

// ── Spec compression ─────────────────────────────────────────────────
// The Judge doesn't need the full canvas spec — just enough to compare
// strategy fit, brand match, hierarchy_spec coherence, and visual
// coherence. We compress each candidate into a small JSON object the
// LLM can scan quickly.

function compressSpecForJudge(spec, index) {
  if (!spec || typeof spec !== 'object') return { index, error: 'no spec' };
  const zones = Array.isArray(spec.zones) ? spec.zones : [];
  const hs = spec.hierarchy_spec || {};
  return {
    index,
    archetype:           hs.layout?.layout_family || spec.creative_style || 'unknown',
    emotional_hook:      hs.strategy?.emotional_hook    || null,
    social_proof_type:   hs.strategy?.social_proof_type || null,
    priorities: {
      product: hs.strategy?.product_priority || 'unknown',
      ugc:     hs.strategy?.ugc_priority     || 'unknown',
      comment: hs.strategy?.comment_priority || 'unknown',
      stat:    hs.strategy?.stat_priority    || 'unknown'
    },
    cta_emphasis: hs.strategy?.cta_emphasis || 'unknown',
    visual_direction: hs.layout?.visual_direction || null,
    zone_count: zones.length,
    zones_summary: zones.slice(0, 12).map(z => ({
      role:            z.role || z.kind || null,
      kind:            z.kind || null,
      component_style: z.component_style || z.style_variant || null,
      slot:            Array.isArray(z.slot) ? z.slot.join(',') : (z.slot || null),
      rect_pct: z.rect ? {
        x: Math.round((z.rect.x / 1000) * 100),
        y: Math.round((z.rect.y / 1000) * 100),
        w: Math.round((z.rect.w / 1000) * 100),
        h: Math.round((z.rect.h / 1000) * 100)
      } : null,
      layer: z.layer ?? null
    })),
    style_bindings: spec.style_bindings || {},
    canvas_bg:      spec.canvas?.background?.style || null,
    rationale_snippet: typeof spec.rationale === 'string' ? spec.rationale.slice(0, 200) : null
  };
}

// ── Prompt construction ──────────────────────────────────────────────

function buildPrompt({ summaries, concept, inputSummary, brandSignal }) {
  const system = [
    `You are a senior ad creative director judging ad layout candidates.`,
    ``,
    `For ONE Ad slot you'll see ${summaries.length} candidate canvas specs. They all materialize the SAME creative concept; your job is to pick the ONE that best satisfies the criteria below.`,
    ``,
    `JUDGE CRITERIA (score each candidate 0-10):`,
    `  brand_match           — does the spec use the brand's tone/colors/identity faithfully?`,
    `  strategy_fit          — does the spec materialize the concept's archetype + priorities + emotional_hook? Penalize candidates that drift from the concept.`,
    `  hierarchy_consistency — do the zones actually express the strategy (e.g., concept says social_proof_type=testimonial → spec MUST have a quote/testimonial zone)?`,
    `  visual_coherence      — do the zones compose well (no obvious overlaps, balanced layer/space distribution, reasonable rects)?`,
    ``,
    `Output JSON with:`,
    `  winner_index    — integer 0..${summaries.length - 1}`,
    `  rationale       — 1-2 sentences. Name WHY this candidate beat the others.`,
    `  confidence      — 0..1, your confidence in the pick`,
    `  criteria_scores — array of objects in CANDIDATE ORDER. Each: { brand_match, strategy_fit, hierarchy_consistency, visual_coherence } as numbers 0-10.`,
    ``,
    `Be decisive — if all candidates are similar, pick the one whose zones BEST execute the concept's primary signal (the emotional_hook + social_proof_type combo).`
  ].join('\n');

  const userLines = [];
  if (concept) {
    userLines.push(`CREATIVE CONCEPT THE GENERATOR WAS MATERIALIZING:`);
    userLines.push('```json');
    userLines.push(JSON.stringify({
      concept_id:        concept.concept_id,
      name:              concept.name,
      archetype:         concept.archetype,
      layout_family:     concept.layout_family,
      emotional_hook:    concept.emotional_hook,
      social_proof_type: concept.social_proof_type,
      product_priority:  concept.product_priority,
      ugc_priority:      concept.ugc_priority,
      comment_priority:  concept.comment_priority,
      stat_priority:     concept.stat_priority,
      cta_emphasis:      concept.cta_emphasis,
      recommended_components: concept.recommended_components || {}
    }, null, 2));
    userLines.push('```');
    userLines.push('');
  }
  if (brandSignal) {
    userLines.push(`BRAND SIGNAL (for brand_match scoring):`);
    userLines.push('```json');
    userLines.push(JSON.stringify(brandSignal, null, 2));
    userLines.push('```');
    userLines.push('');
  }
  if (inputSummary?.social_proof_signal || inputSummary?.performance_signal) {
    userLines.push(`SUPPORTING SIGNALS (for hierarchy_consistency scoring):`);
    userLines.push('```json');
    userLines.push(JSON.stringify({
      social_proof_signal: inputSummary.social_proof_signal,
      performance_signal:  inputSummary.performance_signal
    }, null, 2));
    userLines.push('```');
    userLines.push('');
  }
  userLines.push(`CANDIDATES (compressed canvas-spec summaries):`);
  userLines.push('```json');
  userLines.push(JSON.stringify(summaries, null, 2));
  userLines.push('```');
  userLines.push('');
  userLines.push(`Pick the winner now.`);

  return { system, user: userLines.join('\n') };
}

// ── Response schema (strict) ─────────────────────────────────────────

function buildResponseSchema(candidateCount) {
  return {
    name: 'judge_decision',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['winner_index', 'rationale', 'confidence', 'criteria_scores'],
      properties: {
        winner_index: { type: 'integer', minimum: 0, maximum: Math.max(0, candidateCount - 1) },
        rationale:    { type: 'string' },
        confidence:   { type: 'number', minimum: 0, maximum: 1 },
        criteria_scores: {
          type: 'array',
          minItems: candidateCount,
          maxItems: candidateCount,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['brand_match', 'strategy_fit', 'hierarchy_consistency', 'visual_coherence'],
            properties: {
              brand_match:           { type: 'number', minimum: 0, maximum: 10 },
              strategy_fit:          { type: 'number', minimum: 0, maximum: 10 },
              hierarchy_consistency: { type: 'number', minimum: 0, maximum: 10 },
              visual_coherence:      { type: 'number', minimum: 0, maximum: 10 }
            }
          }
        }
      }
    },
    strict: true
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = {
  judgeCandidates,
  DEFAULT_JUDGE_MODEL,
  compressSpecForJudge
};
