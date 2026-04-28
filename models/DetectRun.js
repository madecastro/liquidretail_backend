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
  mediaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true, index: true },

  status:     { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued' },
  stage:      String,                                  // current stage for progress UI
  stageTimings: { type: mongoose.Schema.Types.Mixed, default: {} },

  trigger:    { type: String, enum: ['upload', 'webhook', 'manual_rerun'], default: 'upload' },
  pipelineVersion: String,
  modelVersions:   { type: mongoose.Schema.Types.Mixed, default: {} },

  error:      String,
  errorStage: String,

  createdAt:   { type: Date, default: Date.now, index: true },
  startedAt:   Date,
  completedAt: Date
});

// Worker polls by status; primary index is (status, createdAt) so oldest-first
// FIFO is cheap.
detectRunSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('DetectRun', detectRunSchema);
