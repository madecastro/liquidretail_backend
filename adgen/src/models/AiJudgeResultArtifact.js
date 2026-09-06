// Phase 3 — outcome of an LLM Judge call. One artifact per Judge call.
//
// Today the Generator runs N=3 concurrent generations per Ad and judges
// just that Ad's 3 candidates (single-Ad batches). Future Phase 3.1
// upgrades to N-Ad batches (5 ads × 3 candidates per Judge call) — the
// schema already supports that shape: `judgments[]` is an array keyed
// by adId, so a single artifact can record judgments for many Ads.
//
// Each judgment records: which candidate won, why, how confident the
// Judge was, and the criteria scores per candidate (for diagnostics +
// later operator-vs-Judge agreement gates).

const mongoose = require('mongoose');

const aiJudgeResultArtifactSchema = new mongoose.Schema({
  // Provenance
  brandId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', index: true, default: null },
  campaignId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true, default: null },
  campaignRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignRun', index: true, default: null },

  // Model + prompt provenance
  modelId:     { type: String, required: true },
  promptHash:  { type: String, default: null },
  promptSystem:{ type: String, default: null },
  promptUser:  { type: String, default: null },

  // The actual judgments. One entry per Ad in the batch.
  // candidate_summaries are the text-compressed inputs the Judge saw
  // (not full canvas specs — keeps storage bounded).
  judgments: [{
    adId:                { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', default: null },
    aiCanvasArtifactId:  { type: mongoose.Schema.Types.ObjectId, ref: 'AiCanvasArtifact', default: null },
    conceptId:           { type: String, default: null },
    candidateCount:      { type: Number, default: 0 },
    candidateSummaries:  { type: [mongoose.Schema.Types.Mixed], default: [] },
    winnerIndex:         { type: Number, default: 0 },
    rationale:           { type: String, default: null },
    confidence:          { type: Number, default: null },           // 0..1
    criteriaScores:      { type: [mongoose.Schema.Types.Mixed], default: [] }   // per-candidate { brand_match, strategy_fit, hierarchy_consistency, visual_coherence }
  }],

  // ── Concept-round judging (Phase A — AI_CONCEPT_DRIVEN flag) ─────
  // One entry per Director round judged. Unlike judgments[] (which
  // picks a winner among N rendered candidates for one Ad), concept-
  // round judging scores ALL concepts in a round and emits a rank
  // ordering — no culling. Default empty so legacy artifacts read it
  // as absent.
  //
  //   conceptArtifactId — FK to the CreativeDirectionArtifact the
  //                       round wrote
  //   roundIndex        — mirror of CreativeDirectionArtifact.roundIndex
  //                       for join-free diagnostics
  //   conceptCount      — N concepts judged in this batch (typically 3)
  //   conceptScores[]   — per-concept score detail (see below)
  //   batchRationale    — 1-2 sentence batch-level summary explaining
  //                       why the top concept won and what differentiated it
  //   topConceptId      — concept_id of the rank-1 concept (judgeRank=1)
  //
  // conceptScores[N]:
  //   conceptId        — Director-emitted concept_id (stable per round)
  //   judgeScore       — 0..1 composite (average of criteria_scores / 10)
  //   judgeRank        — 1..N (1=best); ties broken by input order
  //   criteriaScores   — { strategy_fit, brand_match, media_utilization,
  //                       proof_coherence, distinctness } each 0..10
  //   hardViolations   — array of short strings flagging diagnostic
  //                       hits (claimed proof with no data, copy_picks
  //                       all null, etc.). Empty array on clean concepts;
  //                       presence does NOT cull (renderer still ships
  //                       them in rank order).
  conceptJudgments: [{
    conceptArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreativeDirectionArtifact', default: null },
    roundIndex:        { type: Number, default: null },
    conceptCount:      { type: Number, default: 0 },
    conceptScores:     { type: [mongoose.Schema.Types.Mixed], default: [] },
    batchRationale:    { type: String, default: null },
    topConceptId:      { type: String, default: null }
  }],

  // Telemetry rollup. CostLog has the per-call $; this is convenience.
  inputTokens:   { type: Number, default: 0 },
  outputTokens:  { type: Number, default: 0 },
  costUsd:       { type: Number, default: 0 },
  durationMs:    { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now }
});

aiJudgeResultArtifactSchema.index({ campaignId: 1, createdAt: -1 });

module.exports = mongoose.model('AiJudgeResultArtifact', aiJudgeResultArtifactSchema);
