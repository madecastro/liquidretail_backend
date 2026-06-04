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

  // Telemetry rollup. CostLog has the per-call $; this is convenience.
  inputTokens:   { type: Number, default: 0 },
  outputTokens:  { type: Number, default: 0 },
  costUsd:       { type: Number, default: 0 },
  durationMs:    { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now }
});

aiJudgeResultArtifactSchema.index({ campaignId: 1, createdAt: -1 });

module.exports = mongoose.model('AiJudgeResultArtifact', aiJudgeResultArtifactSchema);
