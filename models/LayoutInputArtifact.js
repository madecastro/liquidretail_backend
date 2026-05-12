// Layout generator input artifact. Cached output of
// services/layoutInputService.buildLayoutInput.
//
// Keyed by (mediaId, template, aspectRatio, productId, variantKind).
// productId and variantKind are part of the key because the same Media
// can be the source of ads for MULTIPLE seed products (different
// CatalogProducts pinning the same UGC photo) — each combo derives a
// different canonical input (different product.name, product.image,
// CTA URL, derived copy, etc.). Without partitioning by productId the
// cache returns the first-rendered combo for every subsequent
// re-render, surfacing the wrong product on the rendered ad.
// variantKind partitioning catches the future case where a single
// mediaId is reused across UGC + product_image variants.
// Re-requests return the cached doc by default; callers pass
// refresh=true to bypass cache.
//
// input: the validated JSON object that matches the RS Social Proof Creative
//   Input schema. Consumed verbatim by the downstream renderer/template.
// derivation: raw LLM output from the single derivation call — kept so we can
//   debug / re-assemble without re-LLMing.

const mongoose = require('mongoose');

const layoutInputArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
  mediaId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true, index: true },
  runId:       { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun' },   // which run's artifacts fed this
  template:    { type: String, required: true },
  aspectRatio: { type: String, required: true },

  // Wizard-supplied seed identity. Both nullable so legacy callers
  // (ads.html preview without a campaign-driven seed) continue to
  // work — those entries cluster under productId:null, variantKind:null
  // and don't conflict with ad-render entries that always have both set.
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },
  variantKind: { type: String, default: null },     // 'ugc' | 'product_image' | null

  // Semver of the input shape. Bump when the canonical path structure
  // changes (e.g. v1 → v2 moved hero_image_url → hero_media.image, split
  // creator out of ugc). buildLayoutInput refuses to serve a cached doc
  // whose schemaVersion doesn't match the current INPUT_SCHEMA_VERSION,
  // forcing a re-derivation.
  schemaVersion: { type: String },

  input:       { type: mongoose.Schema.Types.Mixed, required: true },
  derivation:  { type: mongoose.Schema.Types.Mixed },

  createdAt:   { type: Date, default: Date.now }
});

// One cached input per unique (mediaId, template, aspectRatio,
// productId, variantKind) combination. productId + variantKind
// partition the cache so different seed products on the same media
// don't collide. Re-running deletes the prior matching entry via
// findOneAndReplace in the service.
layoutInputArtifactSchema.index(
  { mediaId: 1, template: 1, aspectRatio: 1, productId: 1, variantKind: 1 },
  { unique: true }
);

module.exports = mongoose.model('LayoutInputArtifact', layoutInputArtifactSchema);
