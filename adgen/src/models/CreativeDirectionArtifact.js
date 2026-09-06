// Phase 1 — AI Creative Director output.
//
// Caches N creative concepts per (brandId, productId, campaignKind,
// creativeIntent). Concepts are STRATEGY decisions (archetype, hierarchy
// priorities, recommended components) — NOT coordinates. The Generator
// stage (Phase 2) consumes a concept_id and materializes a canvas spec
// from it.
//
// Cache key rationale: strategy is a function of WHAT we're selling
// (brand+product), WHY (campaignKind = product / brand / promotional),
// and any operator hint (creativeIntent). It does NOT depend on which
// specific media post is the seed — that's the Generator's problem.
// One Director call serves every Ad in the cartesian for that
// (brand, product, kind, intent) combination.
//
// Shadow mode: through Phase 1, the artifact is persisted but not yet
// consumed by the rendering pipeline. Phase 2 wires the Generator to
// read it.

const mongoose = require('mongoose');

const creativeDirectionArtifactSchema = new mongoose.Schema({
  // ── Cache key dimensions (unique compound index below) ──────────
  brandId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',          required: true, index: true },
  productId:      { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },
  campaignKind:   { type: String, default: null },     // 'product' | 'brand' | 'promotional' | null
  creativeIntent: { type: String, default: null },     // null = "AI decides"; future: "lean editorial" etc.
  // Platform-format-aware ad generation (Phase 5). 5th cache-key
  // dimension so the same (brand × product × kind × intent) can hold
  // separate concept sets for Feed vs Reels — the Director's archetype
  // weighting differs per format (Phase 3) and Reels concepts that
  // avoid stat_led / magazine_editorial shouldn't get reused for Feed
  // runs that benefit from them. Default 'meta_feed_1_1' preserves
  // legacy artifacts as Feed.
  platformFormat: { type: String, default: 'meta_feed_1_1', index: true },

  // ── Contract metadata ──────────────────────────────────────────
  contractVersion:    { type: String, default: '1.0' },
  contractSchemaId:   { type: String, default: 'creative_direction.v1' },

  // Bumped when assembleSignals' shape changes — the cache check in
  // directConcepts only serves rows whose signalsVersion matches the
  // current code so older summaries don't stay frozen. Mirrors the
  // SPEC_SCHEMA_VERSION pattern in aiCanvasArtifact.
  signalsVersion:     { type: String, default: '1.0.0' },

  // ── Concept-driven generation (Phase A — AI_CONCEPT_DRIVEN flag) ─
  // Phase A1 (this commit) — additive fields only. Defaults to null on
  // legacy rows so existing code paths read them as absent and ignore.
  // The legacy unique index on (brand, product, kind, intent, format)
  // stays in place; the V1 Director still upserts replace-by-key under
  // it. When AI_CONCEPT_DRIVEN flips on (Phase A5), the deploy will
  // include an operator-run index migration that adds `roundIndex` as
  // a 6th dimension so append-only round rows can coexist with the
  // legacy row (V1 row keeps roundIndex=null; V2 rows have 0..N).
  //
  //   roundIndex       — 0..N. Round 0 is the first Generate press for
  //                      this cache key; round 1 the next; etc. Drives
  //                      the "ROUND N" prompt marker and bounds the
  //                      AVOID list to the last 6 rounds.
  //   seedUniverseHash — sha256 of the top-5 seeded mediaIds at call
  //                      time. Surfaces "new media available since last
  //                      round" diagnostics; not part of the cache key
  //                      (artifacts are read append-only by roundIndex,
  //                      not looked up by hash).
  roundIndex:         { type: Number, default: null, index: true },
  seedUniverseHash:   { type: String, default: null },

  // ── Input snapshot (the signals the Director saw) ──────────────
  // Persisted verbatim so we can audit what strategy was made against
  // what signal — useful when concept variety drifts.
  inputSummary: { type: mongoose.Schema.Types.Mixed, required: true },

  // ── Direction output ───────────────────────────────────────────
  availableArchetypes:      { type: [String], default: [] },
  availableComponentRoles:  { type: [String], default: [] },
  creativeRules:            { type: mongoose.Schema.Types.Mixed, default: {} },
  concepts:                 { type: [mongoose.Schema.Types.Mixed], required: true },

  // ── Provenance ─────────────────────────────────────────────────
  provider:       { type: String, default: 'openai' },
  modelId:        { type: String, required: true },
  promptHash:     { type: String, required: true },
  promptSystem:   { type: String, default: null },
  promptUser:     { type: String, default: null },
  rawResponse:    { type: mongoose.Schema.Types.Mixed, default: null },

  // ── Validation outcomes ────────────────────────────────────────
  validationWarnings: { type: [String], default: [] },

  createdAt:    { type: Date, default: Date.now }
});

// Cache key — one artifact per unique (brand, product, campaignKind,
// creativeIntent, platformFormat, roundIndex).
//
// Phase A5a added `roundIndex` as the 6th dimension to allow the
// concept-driven path to write append-only round rows (roundIndex = 0,
// 1, 2, ...) alongside the legacy V1 row (roundIndex = null). Both
// coexist under one unique constraint: Mongo treats `null` as a value
// for uniqueness, so the V1 row claims (..., null) and V2 rows claim
// (..., 0/1/2/...) without collision.
//
// OPERATOR MIGRATION (required before flipping AI_CONCEPT_DRIVEN=true,
// and also worth running on any deploy with V1 multi-platformFormat usage):
//
// Production has accumulated TWO stale unique indexes that pre-date
// this 6-field one. Phase 5 added a 5-field unique (with platformFormat)
// but never dropped the original 4-field one. Both must go — mongoose
// does not auto-drop indexes when schema definitions change.
//
// mongo shell:
//   use <your-db>
//   db.creativedirectionartifacts.getIndexes()   // inspect
//   db.creativedirectionartifacts.dropIndex({brandId:1,productId:1,campaignKind:1,creativeIntent:1})
//   db.creativedirectionartifacts.dropIndex({brandId:1,productId:1,campaignKind:1,creativeIntent:1,platformFormat:1})
//   db.creativedirectionartifacts.getIndexes()   // verify only the 6-field unique remains
//
// Why drop both:
//   - 4-field index (b,p,k,i) blocks V1 upserts the moment a single
//     (brand,product,kind,intent) tuple is hit with multiple
//     platformFormat values — would fire even WITHOUT V2 in play.
//   - 5-field index (b,p,k,i,f) blocks V2 .create() because the 5-tuple
//     matches the existing V1 row's 5-tuple. roundIndex is the V2
//     discriminator.
//
// After dropping, app boot recreates the new 6-field index via the
// declaration below. Per-field non-unique helper indexes (brandId_1,
// productId_1, platformFormat_1, roundIndex_1) are fine to keep.
creativeDirectionArtifactSchema.index(
  { brandId: 1, productId: 1, campaignKind: 1, creativeIntent: 1, platformFormat: 1, roundIndex: 1 },
  { unique: true }
);

module.exports = mongoose.model('CreativeDirectionArtifact', creativeDirectionArtifactSchema);
