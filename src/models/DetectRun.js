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

  trigger:    { type: String, enum: ['upload', 'webhook', 'manual_rerun', 'manual-rematch', 'instagram-sync', 'catalog-sync', 'apify-sync'], default: 'upload' },

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

  // Non-fatal observability flags. Pipeline stages that can fail
  // silently (e.g. YOLO returning 0 detections after a timeout / OOM /
  // 5xx — the run completes with default centered crops, looking
  // healthy from the outside) stamp markers here so we can find them
  // later for re-run targeting.
  //
  //   yoloFailed:  true when runYoloChain caught a YOLO error or the
  //                outer Promise.allSettled rejected — i.e. the run
  //                continued without product bboxes. Distinct from
  //                "0 products legitimately visible".
  //   yoloError:   short description of what failed
  flags: { type: mongoose.Schema.Types.Mixed, default: {} },

  createdAt:   { type: Date, default: Date.now, index: true },
  startedAt:   Date,
  completedAt: Date
});

// Worker polls by status; sort by (priority, createdAt) so high-priority
// catalog-product runs drain before bulk IG-post runs while preserving
// FIFO within a priority band.
detectRunSchema.index({ status: 1, priority: 1, createdAt: 1 });

// Idempotency guard: at most ONE DetectRun per Media in an in-flight
// state (queued OR processing). Concurrent enqueue paths — scheduler
// boot-tick + interval-tick + manual sync, or two scheduler ticks
// overlapping while a slow ingest is mid-loop — would otherwise
// .create() duplicate runs for the same Media. The unique partial
// index makes the second insert hit E11000; the caller catches it
// and treats it as "already enqueued, no-op." Completed/failed runs
// are NOT covered by the filter so re-detection can still create a
// new run after a previous one terminates.
//
// Explicit name is REQUIRED — the field-level `index: true` on
// mediaId above auto-names its index 'mediaId_1', and Mongoose would
// auto-name this partial unique to the same string and fail
// syncIndexes with "An existing index has the same name". The two
// indexes serve different queries (single-field for general
// mediaId lookups; partial unique for the in-flight uniqueness
// guard) so both must coexist with distinct names.
detectRunSchema.index(
  { mediaId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['queued', 'processing'] } },
    name: 'mediaId_in_flight_unique'
  }
);

module.exports = mongoose.model('DetectRun', detectRunSchema);
