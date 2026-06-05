// Cache of full-AI-rendered ad images (gpt-image-1 text-to-image).
//
// Diagnostic counterpart to AiCanvasArtifact: where AiCanvasArtifact
// stores a JSON canvas spec the deterministic renderer paints, this
// stores the URL of an image gpt-image-1 generated directly from the
// same rich context payload. Used to measure the gap between what the
// LLM CAN compose (full creative freedom over pixels) and what our
// renderer CAN render (zones + slots + styles).
//
// Same partition key as AiCanvasArtifact so a side-by-side preview
// (or future judge) can join one-to-one across the two collections.

const mongoose = require('mongoose');

const aiFullRenderArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
  mediaId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true, index: true },

  template:     { type: String, required: true },
  creativeStyle:{ type: String, required: true },
  aspectRatio:  { type: String, required: true },

  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },
  variantKind: { type: String, default: null },

  campaignContextHash: { type: String, default: null },
  paletteSource:       { type: String, default: 'media' },

  imageUrl:        { type: String, required: true },
  cloudinaryPublicId: { type: String, default: null },

  modelId:         { type: String },     // 'gpt-image-1'
  promptHash:      { type: String },     // sha256 of the image-gen prompt for drift detection
  promptText:      { type: String },     // full prompt — kept verbatim for diagnostic value
  width:           { type: Number, default: 1024 },
  height:          { type: Number, default: 1024 },
  costEstimateUsd: { type: Number, default: null },   // best-effort, based on size + quality tier
  elapsedMs:       { type: Number, default: null },

  createdAt:    { type: Date, default: Date.now }
});

aiFullRenderArtifactSchema.index(
  { mediaId: 1, template: 1, aspectRatio: 1, productId: 1, variantKind: 1, campaignContextHash: 1, paletteSource: 1, creativeStyle: 1 },
  { unique: true }
);

module.exports = mongoose.model('AiFullRenderArtifact', aiFullRenderArtifactSchema);
