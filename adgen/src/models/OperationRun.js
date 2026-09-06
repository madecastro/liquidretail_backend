// OperationRun — uniform progress row for long-running backend jobs.
//
// Existing in-memory job maps (spec/script jobs) and models with their
// own status (DetectRun, Ad.status, CampaignRun) keep working;
// progressService mirrors into OperationRun so the UI has one pollable
// surface without rewriting those paths.
//
// TTL on endedAt (7d) keeps the collection bounded. Running rows leave
// endedAt null so Mongo's TTL monitor ignores them.

const mongoose = require('mongoose');

const STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'cancelling'];

const operationRunSchema = new mongoose.Schema({
  // Tenant key — always scoped the same way as tenantFilter(req, …).
  advertiserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Advertiser',
    required: true,
    index: true
  },
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    default: null,
    index: true
  },

  // Free-form String (not enum) so new instrumentation sites can
  // introduce kinds without a migration. Cancellable kinds live in
  // progressService.CANCELLABLE_KINDS.
  kind:  { type: String, required: true, index: true },
  // Optional human label for the UI (e.g. "Sync Acme catalog").
  label: { type: String, default: null },

  status: {
    type: String,
    enum: STATUSES,
    default: 'running',
    index: true
  },

  stage: { type: String, default: null },
  note:  { type: String, default: null },

  // Closed-stage history. progressService.stage() pushes one entry here
  // the moment it transitions AWAY from a named stage (and the terminal
  // succeed()/fail()/markCancelled() close whatever stage was still open),
  // capturing that stage's own elapsed time + its last itemsDone/itemsTotal/
  // note — the values `stage`/`note`/`itemsDone`/`itemsTotal` above are about
  // to be overwritten by the next stage's own progress. Additive: nothing
  // else reads or requires this array, so it is safe to add without a
  // migration. slackFeed (backend ingest Slack projector) is intentionally
  // omitted — adgen never creates ingest-kind OperationRuns.
  stages: {
    type: [{
      name:        { type: String },
      startedAt:   { type: Date },
      endedAt:     { type: Date },
      durationMs:  { type: Number },
      itemsDone:   { type: Number },
      itemsTotal:  { type: Number },
      note:        { type: String },
      _id: false
    }],
    default: []
  },

  // 0..1 when known; null when indeterminate (no total yet).
  pct:        { type: Number, default: null },
  itemsDone:  { type: Number, default: 0 },
  itemsTotal: { type: Number, default: null },

  startedAt:   { type: Date, default: Date.now },
  // Managed by progressService (throttle + heartbeat), not mongoose timestamps.
  updatedAt:   { type: Date, default: Date.now },
  endedAt:     { type: Date, default: null },
  heartbeatAt: { type: Date, default: Date.now },

  error:           { type: String, default: null },
  cancelRequested: { type: Boolean, default: false },
  // Snapshot of whether this run opted into cooperative cancel at start
  // (also re-checked against CANCELLABLE_KINDS in the cancel route).
  cancellable:     { type: Boolean, default: false },

  meta: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: false });

operationRunSchema.index({ advertiserId: 1, status: 1, startedAt: -1 });
operationRunSchema.index({ advertiserId: 1, brandId: 1, startedAt: -1 });
// Drop finished runs ~7 days after they end. Null endedAt (still
// running / never terminal) is ignored by the TTL monitor.
operationRunSchema.index(
  { endedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 }
);

module.exports = mongoose.model('OperationRun', operationRunSchema);
