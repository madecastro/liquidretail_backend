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

// Single source of truth for outcome values, exported so producers and the
// persist layer cannot drift from the schema.
// 'submitted' — the CHARGE-POINT record. Atlas bills video on submit, so
// atlasVideoService writes this row the moment money is spent, deliberately
// before the poll resolves (see the comment at atlasVideoService.js:2612 — a
// bookkeeping failure must never fail a generation post-payment). It means
// "billed, outcome not yet known", NOT a failure.
//
// It was missing from this list, so costTracker's unmapped-status guard coerced
// every one of them to 'error' and logged a loud ❌. Measured on prod
// 2026-07-31: 6 rows/hour, every successful $1.00 video render recorded as an
// error. Nothing was lost (the guard records rather than drops — that was the
// PR #43 fix), but spend-by-status was reading as though video was failing
// constantly while it was in fact succeeding.
const COST_STATUSES = ['ok', 'error', 'timeout', 'rejected', 'rejected-billing', 'failed', 'charged-no-output', 'submitted'];

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

  // Provider-side identifier for this call — the Atlas prediction id for image
  // and video work. Indexed because cost reconciliation looks the row up by it:
  // Atlas populates the authoritative `price` on the prediction, and we may have
  // written the row before that value was available.
  providerRequestId: { type: String, default: null, index: true },

  // Where costUsd came from.
  //   'actual'    — the provider's own figure (Atlas prediction.price)
  //   'estimated' — our catalog base_price guess, pending reconciliation
  //   'none'      — nothing was charged (rejection, or a refunded failure)
  // Worth recording because the two disagreed by ~6x on the image path: the
  // catalog said 0.01 while Atlas actually billed 0.057-0.069 per edit, so a
  // ledger built from estimates understated image spend badly.
  costSource: { type: String, enum: ['actual', 'estimated', 'none'], default: 'estimated', index: true },

  // Cache discipline — 0-cost cache hits still log so we can measure
  // hit rate per (stage, cacheKey).
  cacheHit:  { type: Boolean, default: false, index: true },
  cacheKey:  { type: String,  default: null, index: true },   // serialized form for grouping

  // Cost figures
  inputTokens:  { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cachedInputTokens: { type: Number, default: 0 },   // OpenAI prompt-cache hits
  visionImages: { type: Number, default: 0 },        // count of image_url parts (cost driver)
  // Count of Google-Search-grounded requests in this call. Google bills
  // grounding PER REQUEST on top of tokens ($35/1,000 grounded prompts), so
  // this is the multiplier behind the non-token part of costUsd — recorded so
  // a row whose dollars dwarf its token count is explicable rather than suspect.
  groundedRequests: { type: Number, default: 0 },
  costUsd:      { type: Number, default: 0 },        // best-effort; computed from token counts × model rate
  durationMs:   { type: Number, default: 0 },

  // Outcome
  // 'rejected'         — the provider refused the request outright (4xx envelope)
  // 'rejected-billing' — refused for balance/quota specifically
  //
  // atlasImageService records both, but they were missing from this enum, so
  // mongoose validation failed and the cost row was silently DROPPED. Every
  // provider rejection — including a 402 insufficient-balance, the one you most
  // want to see in the ledger — was invisible.
  // 'failed'            — provider accepted, then reported a failed prediction
  // 'charged-no-output' — billed but produced nothing (rare)
  //
  // Every value a producer can write MUST appear here. A status outside the enum
  // fails validation, and persistCost swallows that error, so the ENTIRE row
  // disappears — not just the status field. 'rejected'/'rejected-billing' were
  // missing once; 'failed'/'charged-no-output' were missing again after that.
  // persistCost now normalises unknown values rather than trusting this list to
  // stay exhaustive.
  status:       { type: String, enum: COST_STATUSES, default: 'ok' },
  errorMessage: { type: String, default: null },

  createdAt:    { type: Date, default: Date.now, index: true }
});

// Useful compound for monthly / per-brand cost rollups.
costLogSchema.index({ brandId: 1, createdAt: -1 });
costLogSchema.index({ stage: 1, createdAt: -1 });

const CostLog = mongoose.model('CostLog', costLogSchema);
CostLog.COST_STATUSES = COST_STATUSES;

module.exports = CostLog;
