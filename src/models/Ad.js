'use strict';
// Phase 0 lightweight Ad shim.
//
// strict:false so we can read a real Ad doc from the shared collection
// without needing to redeclare every field. We ONLY declare the fields
// this service reads/writes in Phase 0, plus the two new fields the
// extraction adds (claimedByWorker, claimedAt).
//
// Phase 1 replaces this with the full model from the shared
// @reachsocial/adgen-schemas package (backend + adgen import the same
// definition — the same rule as CLAUDE.md's "one resolveDeriveFromMaster,
// imported everywhere").

const mongoose = require('mongoose');

const adShimSchema = new mongoose.Schema({
  status:           { type: String, index: true },
  renderRoute:      { type: String, index: true },
  deriveFromMaster: { type: String, default: null, index: true },

  // Extraction additions — worker-level claim on individual ads.
  // A renderer wins these atomically via findOneAndUpdate with the
  // {status:'rendering', claimedByWorker:null} filter.
  claimedByWorker:  { type: String, default: null, index: true },
  claimedAt:        { type: Date,   default: null, index: true },

  campaignRunIds:   [String],
  campaignId:       mongoose.Schema.Types.ObjectId,
  brandId:          mongoose.Schema.Types.ObjectId,
  productId:        mongoose.Schema.Types.ObjectId,

  veoVideoUrl:      String
}, {
  strict: false,
  collection: 'ads',
  timestamps: true
});

// Composite index that supports the renderer's claim query.
// Matches the query shape in claimNextAd() — status + claimedByWorker
// as the equality prefix, createdAt sort.
adShimSchema.index({ status: 1, claimedByWorker: 1, createdAt: 1 });

module.exports = mongoose.model('Ad', adShimSchema);
