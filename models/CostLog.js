// Per-LLM-call cost log. One document per provider call. Indexed for
// per-campaign / per-brand / per-stage aggregation queries so the
// optimization-validation gates in Phase 0+ can measure where dollars
// actually go.
//
// Stages map to the new pipeline:
//   - 'creative_director'      Phase 1
//   - 'layout_generator'       Phase 2 / 3 (multi-candidate)
//   - 'judge'                  Phase 3
//   - 'copy_derivation'        Phase 4
//   - 'layout_resolver'        Phase 5 (rarely if heuristic-driven; logged when LLM-assisted)
//   - 'renderer_qa'            Phase 6 (vision LLM checks if used)
//   - 'legacy_ai_canvas_spec'  Pre-Phase 1 calls — useful for baselining
//
// cacheHit=true entries record a 0-cost "phantom" call so cache-hit
// rates can be measured per (cache_key, stage) without skewing $ totals.

const mongoose = require('mongoose');

const costLogSchema = new mongoose.Schema({
  // Provenance — what was being generated
  stage:        { type: String, required: true, index: true },
  provider:     { type: String, required: true },   // 'openai' | 'anthropic' | 'gemini'
  model:        { type: String, required: true },   // 'gpt-4.1' | 'claude-haiku-4.5' | 'gemini-2.5-flash' | ...
  purposeTag:   { type: String, default: null },    // free-form tag for sub-stage telemetry

  // Linkage — so we can join cost back to the artifacts produced
  brandId:                       { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',     index: true, default: null },
  campaignId:                    { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign',  index: true, default: null },
  campaignRunId:                 { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignRun', index: true, default: null },
  adId:                          { type: mongoose.Schema.Types.ObjectId, ref: 'Ad',        index: true, default: null },
  mediaId:                       { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     index: true, default: null },
  productId:                     { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', index: true, default: null },
  creativeDirectionArtifactId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  layoutGenerationArtifactId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  resolvedLayoutArtifactId:      { type: mongoose.Schema.Types.ObjectId, default: null },
  judgeResultArtifactId:         { type: mongoose.Schema.Types.ObjectId, default: null },

  // Cache discipline — 0-cost cache hits still log so we can measure
  // hit rate per (stage, cacheKey).
  cacheHit:  { type: Boolean, default: false, index: true },
  cacheKey:  { type: String,  default: null, index: true },   // serialized form for grouping

  // Cost figures
  inputTokens:  { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cachedInputTokens: { type: Number, default: 0 },   // OpenAI prompt-cache hits
  visionImages: { type: Number, default: 0 },        // count of image_url parts (cost driver)
  costUsd:      { type: Number, default: 0 },        // best-effort; computed from token counts × model rate
  durationMs:   { type: Number, default: 0 },

  // Outcome
  status:       { type: String, enum: ['ok', 'error', 'timeout'], default: 'ok' },
  errorMessage: { type: String, default: null },

  createdAt:    { type: Date, default: Date.now, index: true }
});

// Useful compound for monthly / per-brand cost rollups.
costLogSchema.index({ brandId: 1, createdAt: -1 });
costLogSchema.index({ stage: 1, createdAt: -1 });

module.exports = mongoose.model('CostLog', costLogSchema);
