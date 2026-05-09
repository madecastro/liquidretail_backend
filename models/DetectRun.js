// One execution of the detect pipeline against a Media item. Holds lifecycle
// + observability data only — pipeline outputs go in per-stage Artifact
// collections keyed by (mediaId, runId).
//
// Multiple DetectRuns can target the same Media (re-runs after a model
// upgrade, manual reprocessing). Each one writes a fresh set of artifacts;
// Media.latestArtifacts moves to the latest successful run on completion.
//
// `pipelineVersion` and `modelVersions` let us correlate result regressions
// with specific model/code rollouts after the fact.

const mongoose = require('mongoose');

const detectRunSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', index: true, default: null },
  mediaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true, index: true },

  status:     { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued' },
  stage:      String,                                  // current stage for progress UI
  stageTimings: { type: mongoose.Schema.Types.Mixed, default: {} },

  trigger:    { type: String, enum: ['upload', 'webhook', 'manual_rerun', 'manual-rematch', 'instagram-sync', 'catalog-sync'], default: 'upload' },

  // Lower runs first. Catalog-product runs (priority=1, default) drain
  // before IG-post runs (priority=2) so the visual catalog index is
  // populated before media-path matches start querying it. Manual
  // re-runs / uploads stay at priority=1 so operator-initiated work
  // doesn't queue behind a backlog of bulk posts.
  priority:   { type: Number, default: 1, index: true },

  pipelineVersion: String,
  modelVersions:   { type: mongoose.Schema.Types.Mixed, default: {} },

  error:      String,
  errorStage: String,

  createdAt:   { type: Date, default: Date.now, index: true },
  startedAt:   Date,
  completedAt: Date
});

// Worker polls by status; sort by (priority, createdAt) so high-priority
// catalog-product runs drain before bulk IG-post runs while preserving
// FIFO within a priority band.
detectRunSchema.index({ status: 1, priority: 1, createdAt: 1 });

module.exports = mongoose.model('DetectRun', detectRunSchema);
