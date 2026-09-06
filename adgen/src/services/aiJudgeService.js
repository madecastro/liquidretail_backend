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

const crypto = require('crypto');

const AiJudgeResultArtifact = require('../models/AiJudgeResultArtifact');
const { trackLlmCall } = require('./costTracker');
const {
  conceptField, conceptMediaPicks, renderableCopy
} = require('./conceptProjection');

const { chatCompletion } = require('./atlasLlmService');

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
  const completion = await chatCompletion(
    {
      stage:      'judge',
      provider:   'openai',
      model:      DEFAULT_JUDGE_MODEL,
      purposeTag: `concept:${concept?.concept_id || '-'}`,
      brandId, campaignId, adId,
      visionImages: 0,
      cacheKey: `judge:${aiCanvasArtifactId || '-'}`
    },
    {
      model:           DEFAULT_JUDGE_MODEL,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    }
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
    // Dual-read nested v3 routing + flat v2 so the Judge anchors on the
    // same fields the Director actually emitted.
    userLines.push(JSON.stringify({
      concept_id:        concept.concept_id,
      name:              concept.name,
      archetype:         conceptField(concept, 'archetype'),
      layout_family:     conceptField(concept, 'layout_family'),
      emotional_hook:    conceptField(concept, 'emotional_hook'),
      social_proof_type: conceptField(concept, 'social_proof_type'),
      product_priority:  conceptField(concept, 'product_priority'),
      ugc_priority:      conceptField(concept, 'ugc_priority'),
      comment_priority:  conceptField(concept, 'comment_priority'),
      stat_priority:     conceptField(concept, 'stat_priority'),
      cta_emphasis:      conceptField(concept, 'cta_emphasis'),
      recommended_components: conceptField(concept, 'recommended_components') || {}
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

// ════════════════════════════════════════════════════════════════════
// V2 — Concept-round judging (Phase A — AI_CONCEPT_DRIVEN flag)
// ════════════════════════════════════════════════════════════════════
//
// Coexists with judgeCandidates. No callers at land time; A5 wires
// expandWizardJob into judgeConceptsRound after directConceptsRound
// emits its 3 concepts.
//
// Differences from V1 judgeCandidates:
//   • Input is N Director CONCEPTS (not rendered canvas specs).
//   • No culling — every concept gets scored + ranked. The render
//     pipeline ships them in judgeRank order; nothing gets dropped.
//   • New scoring axes tuned for strategy quality:
//       strategy_fit       — concept matches signal strength
//       brand_match        — copy + creative_style fit brand voice
//       media_utilization  — uses seeded universe smartly (not just
//                            "always hero", not random; output_shape
//                            density matches media_picks count)
//       proof_coherence    — if social_proof_type != 'none', the
//                            inputSummary HAS the data to back it
//       distinctness       — concept differs meaningfully from peers
//       conversion_strength — would this actually make a browser buy
//   • hardViolations[] flags diagnostic issues without culling.
//
// conversion_strength exists because the other five axes all measure
// COHERENCE — does the concept fit the signal, the brand, the media, the
// proof, its peers. A concept can score 10 across all of them and still be
// an ad nobody buys from. The Director prompt is explicitly direct-response
// (see OBJECTIVE_BLOCK in aiCreativeDirectorService); without a matching axis
// here the Judge would rank that work away in favour of the most coherent
// concept rather than the most persuasive one.
//
// Adding an axis is a one-line change on purpose: the response schema, the
// per-axis average and the 0-1 normalisation are all derived from this array.

const CONCEPT_AXES = ['strategy_fit', 'brand_match', 'media_utilization', 'proof_coherence', 'distinctness', 'conversion_strength'];

// Compress one concept into the Judge's reading payload. Strip prompt-
// builder fields (long rationales, recommended_components verbosity) so
// the prompt stays cheap on input tokens.
//
// Dual-reads nested v3 routing + flat v2 via conceptField so a v3
// concept still shows media_picks / archetype / creative_style to the
// Judge (a flat-only read made media_utilization scoring blind).
function compressConceptForJudge(concept, index) {
  if (!concept || typeof concept !== 'object') return { index, error: 'no concept' };
  const mp = conceptMediaPicks(concept);
  const cp = renderableCopy(concept);
  return {
    index,
    concept_id:        concept.concept_id || null,
    name:              concept.name || null,
    archetype:         conceptField(concept, 'archetype') || null,
    layout_family:     conceptField(concept, 'layout_family') || null,
    emotional_hook:    conceptField(concept, 'emotional_hook') || null,
    social_proof_type: conceptField(concept, 'social_proof_type') || null,
    creative_style:    conceptField(concept, 'creative_style') || null,
    priorities: {
      product: conceptField(concept, 'product_priority') || 'unknown',
      ugc:     conceptField(concept, 'ugc_priority')     || 'unknown',
      comment: conceptField(concept, 'comment_priority') || 'unknown',
      stat:    conceptField(concept, 'stat_priority')    || 'unknown'
    },
    cta_emphasis: conceptField(concept, 'cta_emphasis') || 'unknown',
    media_picks: mp.map(p => ({
      media_id: p.media_id || null,
      role:     p.role     || null
    })),
    output_shape: conceptField(concept, 'output_shape') || null,
    copy_picks: {
      headline:    cp.headline    || null,
      subheadline: cp.subheadline || null,
      eyebrow:     cp.eyebrow     || null,
      cta:         cp.cta         || null
    },
    rationale_snippet: typeof concept.rationale === 'string' ? concept.rationale.slice(0, 200) : null
  };
}

// Judge ALL concepts in a Director round. No culling — every concept
// gets a 0..1 judgeScore + 1..N judgeRank. Caller (Phase A5 expand-
// WizardJob) writes the rank onto its Ad rows so the renderer can drain
// in priority order.
//
// Returns:
//   {
//     conceptScores: [{ conceptId, judgeScore, judgeRank, criteriaScores, hardViolations }],
//     batchRationale,
//     topConceptId,
//     judgeResultArtifactId
//   }
async function judgeConceptsRound({
  concepts,                  // [...Director concepts from directConceptsRound]
  conceptArtifactId = null,  // FK to persist on the artifact
  roundIndex        = null,  // diagnostic only
  inputSummary      = null,  // for brand + proof scoring context
  brandSignal       = null,  // for brand_match scoring
  seededUniverse    = [],    // for media_utilization scoring
  brandId           = null,
  productId         = null,
  campaignId        = null
}) {
  if (!Array.isArray(concepts) || concepts.length === 0) {
    throw new Error('judgeConceptsRound: concepts[] required');
  }
  if (concepts.length === 1) {
    // Single concept — no judging needed; rank 1, neutral score.
    return {
      conceptScores: [{
        conceptId:     concepts[0].concept_id || null,
        judgeScore:    1.0,
        judgeRank:     1,
        criteriaScores: Object.fromEntries(CONCEPT_AXES.map(a => [a, null])),
        hardViolations: []
      }],
      batchRationale:        'single concept — auto-ranked',
      topConceptId:          concepts[0].concept_id || null,
      judgeResultArtifactId: null
    };
  }

  const summaries = concepts.map((c, i) => compressConceptForJudge(c, i));
  const universeIds = seededUniverse.map(u => String(u.mediaId));
  // When the Director universe holds ≤1 image, media_utilization's
  // "always-just-hero" penalty is not applicable — every concept is
  // structurally hero-only. Exclude it from the average so it cannot
  // depress scores for obeying a constraint we imposed. Criterion stays
  // live when the Director genuinely had alternates (universe ≥ 2).
  const universeSize = universeIds.length;
  const scoreAxes = universeSize <= 1
    ? CONCEPT_AXES.filter((ax) => ax !== 'media_utilization')
    : CONCEPT_AXES;

  const { system, user } = buildConceptRoundPrompt({
    summaries, inputSummary, brandSignal, universeIds
  });
  const promptHash = sha256(system + '\n' + user);
  const responseSchema = buildConceptRoundResponseSchema(concepts.length);

  const t0 = Date.now();
  const completion = await chatCompletion(
    {
      stage:      'judge_concept_round',
      provider:   'openai',
      model:      DEFAULT_JUDGE_MODEL,
      purposeTag: `round:${roundIndex ?? '-'}:concepts:${concepts.length}`,
      brandId, campaignId,
      visionImages: 0,
      cacheKey:   `judgeConcepts:${conceptArtifactId || '-'}`
    },
    {
      model:           DEFAULT_JUDGE_MODEL,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    }
  );
  const durationMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Judge (concept round) returned no content');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Judge (concept round) response not JSON: ${err.message}`); }

  // The schema enforces concept_scores length = concepts.length and
  // each entry's per-axis 0..10 values. Compute judgeScore (0..1) as
  // the average of applicable axes / 10. judgeRank by judgeScore desc;
  // stable ordering on ties uses input order.
  const parsedScores = Array.isArray(parsed.concept_scores) ? parsed.concept_scores : [];
  const scored = concepts.map((c, i) => {
    const row    = parsedScores[i] || {};
    const axes   = row.criteria_scores || {};
    const sum    = scoreAxes.reduce((s, ax) => s + (typeof axes[ax] === 'number' ? axes[ax] : 0), 0);
    const score  = Math.max(0, Math.min(1, sum / (scoreAxes.length * 10)));
    return {
      index:        i,
      conceptId:    c.concept_id || null,
      judgeScore:   score,
      criteriaScores: Object.fromEntries(CONCEPT_AXES.map((ax) => {
        if (ax === 'media_utilization' && universeSize <= 1) return [ax, null];
        return [ax, typeof axes[ax] === 'number' ? axes[ax] : null];
      })),
      hardViolations: Array.isArray(row.hard_violations) ? row.hard_violations.filter(v => typeof v === 'string') : []
    };
  });

  // Stable rank order — sort by score desc, then by original index.
  const ranked = scored.slice().sort((a, b) => (b.judgeScore - a.judgeScore) || (a.index - b.index));
  ranked.forEach((entry, rankIdx) => { entry.judgeRank = rankIdx + 1; });

  // Re-key by original concept order for the return shape (callers
  // typically zip with the concepts[] they passed in).
  const byIndex = new Map(ranked.map(r => [r.index, r]));
  const conceptScores = concepts.map((c, i) => {
    const r = byIndex.get(i);
    return {
      conceptId:      r.conceptId,
      judgeScore:     r.judgeScore,
      judgeRank:      r.judgeRank,
      criteriaScores: r.criteriaScores,
      hardViolations: r.hardViolations
    };
  });

  const topConceptId  = ranked[0]?.conceptId || null;
  const batchRationale = parsed.batch_rationale || null;

  const usage = completion.usage || {};
  const artifact = await AiJudgeResultArtifact.create({
    brandId, campaignId,
    modelId:    DEFAULT_JUDGE_MODEL,
    promptHash,
    promptSystem: system,
    promptUser:   user,
    conceptJudgments: [{
      conceptArtifactId,
      roundIndex,
      conceptCount:   concepts.length,
      conceptScores,
      batchRationale,
      topConceptId
    }],
    inputTokens:  usage.prompt_tokens     || 0,
    outputTokens: usage.completion_tokens || 0,
    durationMs
  });

  console.log(
    `⚖️  judgeConceptRound: brand=${brandId} product=${productId || '-'} ` +
    `round=${roundIndex ?? '-'} concepts=${concepts.length} ` +
    `top=${topConceptId || '-'} took=${durationMs}ms`
  );

  return {
    conceptScores,
    batchRationale,
    topConceptId,
    judgeResultArtifactId: artifact._id
  };
}

function buildConceptRoundPrompt({ summaries, inputSummary, brandSignal, universeIds }) {
  const proofData = inputSummary?.social_proof_signal || {};
  const hasAnyProof = !!(proofData.primary_quote || (proofData.top_comments?.length) || proofData.rating?.value);
  const universeSize = Array.isArray(universeIds) ? universeIds.length : 0;
  // Universe size reaches the judge here via seededUniverse → universeIds.
  // When size ≤ 1 the Director was told to pick exactly 1; "always-just-hero"
  // is structural, not a quality failure. Keep the axis in the schema for
  // multi-image rounds; mark it N/A in the prompt for hero-only universes.
  const mediaUtilizationAxis = universeSize <= 1
    ? `  media_utilization  — NOT APPLICABLE this round: the seeded universe has ${universeSize} image(s), so every concept is structurally hero-only (static_single / single pick). Score this axis 10 for every concept that picks from the universe; do NOT penalize "always-just-hero" or missing collage/grid. Still penalize media_ids outside the universe and tile_count mismatches.`
    : `  media_utilization  — does media_picks use the seeded universe SMARTLY? Penalize: always-just-hero (single static_single when collage/grid would showcase alts), random picks unrelated to the archetype, output_shape tile_count mismatching media_picks length.`;

  const system = [
    `You are a senior ad creative director scoring ${summaries.length} candidate creative concepts emitted by a Director LLM.`,
    ``,
    `Score every concept on 6 axes (each 0-10). DO NOT cull — every concept gets a score. The pipeline downstream ships them in rank order; your scores set the rank.`,
    ``,
    `SCORING AXES:`,
    `  strategy_fit       — does the concept's archetype + priorities + emotional_hook match the strongest signal in the input? Penalize concepts that ignore obvious strengths or invent strategies the signal can't back.`,
    `  brand_match        — do copy_picks + creative_style align with brand voice / tone? Reject pure clichés and off-tone copy.`,
    mediaUtilizationAxis,
    `  proof_coherence    — when social_proof_type != "none", inputSummary MUST have actual proof data to back it (primary_quote, top_comments, or rating). When proof_coherence fails, ALSO emit a "claimed_proof_no_data" hard_violation.`,
    `  distinctness       — how meaningfully does this concept differ from its peers in this round (different archetype OR different media-pick combo OR different copy angle)?`,
    `  conversion_strength — this is DIRECT-RESPONSE advertising: would this concept move someone who is BROWSING into BUYING? Score high when the concept REMOVES A SPECIFIC PURCHASE OBJECTION (fit, colour accuracy, durability, worth-the-price) and backs it with a specific checkable claim. Score low for: generic praise as the proof ("I love it!"), a mood-only emotional_hook ("trust", "quality") where the data supported something concrete, superlatives in place of specifics, competing CTAs, or any concept leaning on shipping/delivery/packaging/customer-service — those describe the retailer, not the product, and do not move a purchase decision. A concept can be perfectly coherent on the other five axes and still score low here; that is the point of this axis.`,
    ``,
    `HARD VIOLATIONS — flag these as short string codes in the concept's hard_violations array. Do NOT cull; the renderer still ships violating concepts in rank order but operators surface the violation in diagnostics.`,
    `  • claimed_proof_no_data    — social_proof_type != "none" AND inputSummary has no proof signal`,
    `  • all_copy_picks_null      — every copy_picks field is null`,
    `  • media_pick_out_of_universe — any media_picks[i].media_id NOT in the seeded universe ID list`,
    `  • shape_pick_count_mismatch  — output_shape.tile_count != media_picks.length`,
    `  • duplicate_archetype        — concept's archetype matches another concept in the batch AND their media-pick sets are identical`,
    ``,
    `OUTPUT JSON:`,
    `  concept_scores  — array in CONCEPT INPUT ORDER (one per concept). Each: { concept_id, criteria_scores: { ${CONCEPT_AXES.join(', ')} } (each 0-10), hard_violations: [string] }`,
    `  batch_rationale — 1-2 sentences explaining what differentiated the top concept`,
    ``,
    `Be decisive on scoring. If all concepts are similar, surface the differences via the distinctness axis.`,
    ``,
    `SEEDED UNIVERSE media_ids (size=${universeSize}; use to validate media_picks coverage):`,
    universeIds.length ? `  ${universeIds.join(', ')}` : `  (universe empty — no media_pick validation possible)`,
    ``,
    hasAnyProof ? `PROOF DATA PRESENT: rating=${proofData.rating?.value ?? '-'} comments=${(proofData.top_comments || []).length} quote=${proofData.primary_quote ? '"' + String(proofData.primary_quote.text || '').slice(0, 60) + '"' : 'none'}` : `PROOF DATA: NONE present — any concept claiming social_proof_type != "none" gets the claimed_proof_no_data hard_violation.`
  ].join('\n');

  const userLines = [];
  if (brandSignal) {
    userLines.push(`BRAND SIGNAL (for brand_match scoring):`);
    userLines.push('```json');
    userLines.push(JSON.stringify(brandSignal, null, 2));
    userLines.push('```');
    userLines.push('');
  }
  if (inputSummary?.social_proof_signal || inputSummary?.performance_signal) {
    userLines.push(`SUPPORTING SIGNALS (for proof_coherence + strategy_fit scoring):`);
    userLines.push('```json');
    userLines.push(JSON.stringify({
      social_proof_signal: inputSummary.social_proof_signal,
      performance_signal:  inputSummary.performance_signal
    }, null, 2));
    userLines.push('```');
    userLines.push('');
  }
  userLines.push(`CONCEPTS (compressed Director output):`);
  userLines.push('```json');
  userLines.push(JSON.stringify(summaries, null, 2));
  userLines.push('```');
  userLines.push('');
  userLines.push(`Score all ${summaries.length} concepts now.`);

  return { system, user: userLines.join('\n') };
}

function buildConceptRoundResponseSchema(conceptCount) {
  return {
    name: 'judge_concept_round',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['concept_scores', 'batch_rationale'],
      properties: {
        concept_scores: {
          type: 'array',
          minItems: conceptCount,
          maxItems: conceptCount,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['concept_id', 'criteria_scores', 'hard_violations'],
            properties: {
              concept_id: { type: 'string' },
              criteria_scores: {
                type: 'object',
                additionalProperties: false,
                required: [...CONCEPT_AXES],
                properties: Object.fromEntries(
                  CONCEPT_AXES.map(ax => [ax, { type: 'number', minimum: 0, maximum: 10 }])
                )
              },
              hard_violations: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          }
        },
        batch_rationale: { type: 'string' }
      }
    },
    strict: true
  };
}

module.exports = {
  judgeCandidates,
  judgeConceptsRound,
  DEFAULT_JUDGE_MODEL,
  compressSpecForJudge,
  compressConceptForJudge,
  buildConceptRoundPrompt,
  CONCEPT_AXES
};
