// CampaignRun — tracks one click of the Generate Ads button.
//
// POST /api/ads/generate creates a CampaignRun, returns its runId
// immediately (202), then renders creatives in the background. The
// frontend polls GET /api/ads/runs/:id to watch progress and knows
// the batch is finished when status flips from 'running' to 'done'.
//
// runId is the same string we stamp onto Ad.campaignRunId so the ads
// page can join { Ads with that runId } ↔ { the run's status counts }.
//
// Failure mode: if the server restarts mid-run, ads that finished
// remain persisted but the run will hang in 'running'. The frontend
// times out the poller after a generous ceiling (currently 5 min,
// adjustable in Ads page).

const mongoose = require('mongoose');

const campaignRunSchema = new mongoose.Schema({
  runId:        { type: String, required: true, unique: true, index: true },

  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',    required: true, index: true },
  campaignId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  campaignKind: { type: String, default: null },

  // The productIds this run was ASKED for, stamped at mint time (before the
  // background expansion runs, which is the whole point — the concurrency gate
  // in POST /generate has to make its decision while this run is still
  // 'preparing' and `perProduct` is necessarily empty).
  //
  // Still stamped, but since 2026-08-10 it is NO LONGER what the concurrency
  // gate decides on — see requestFingerprint below. It remains the product scope
  // of record for reporting, for the rollout-compat comparison in
  // services/generationGate.js, and for the non-blocking "another run shares
  // these products" notice. An empty array is now a legitimate value (a
  // media-library run seeds from media, not a SKU) and no longer blocks anything.
  requestedProductIds: { type: [String], default: [] },

  // WHAT THE CONCURRENCY GATE ACTUALLY COMPARES. A stable hash over the fields
  // of POST /api/ads/generate that determine what gets generated
  // (services/generationGate.js computeRequestFingerprint). Stamped at mint time
  // because the gate has to decide while this run is still 'preparing'.
  //
  // Load-bearing for money: an identical fingerprint on an in-flight run is the
  // double-click, and it is the only thing now refused by default. Note the
  // failure direction is fail-OPEN — a run with no fingerprint cannot be proven
  // identical to anything, so it will not block a sibling. That is deliberate
  // (blocking on an unknown is what stopped the media library from generating at
  // all), which is exactly why this write must never be dropped: losing it
  // silently disables double-click protection instead of over-blocking.
  requestFingerprint: { type: String, default: null, index: true },

  total:        { type: Number, default: 0 },
  succeeded:    { type: Number, default: 0 },
  skipped:      { type: Number, default: 0 },
  failed:       { type: Number, default: 0 },

  // 'preparing' = expandWizardJob is running in the background (Director +
  // Judge LLM calls). Was previously sync on the request path, but Render's
  // edge can cut a ~28s request even when the backend is healthy — moved
  // off-request so /api/ads/generate responds 202 immediately.
  status:       { type: String, enum: ['preparing', 'running', 'done', 'failed'], default: 'preparing', index: true },

  errors: [{
    _id:        false,
    index:      Number,
    stage:      String,
    template:   String,
    aspectRatio: String,
    mediaId:    String,
    productId:  String,
    message:    String
  }],

  // Per-product expansion outcomes. Written when expandWizardJob finishes
  // (success, empty, or partial). The poller (GET /runs/:runId) returns
  // this so the UI can tell "no imagery" from "Director returned nothing"
  // instead of the generic expand error that used to discard the real
  // reason. Shape owned by services/perProductReasons.js — keep fields
  // in sync with normalizePerProductEntry.
  perProduct: [{
    _id:               false,
    productId:         String,
    productName:       String,
    reason:            String,   // machine code, null when the product queued
    message:           String,   // human sentence for this row
    skipped:           Boolean,
    payloads:          Number,
    // Non-skip advisory (e.g. video operator stack has no catalog image).
    // MUST stay separate from `reason` — reason implies skipped:true.
    // Shape owned by services/perProductReasons.js WARNING enum.
    warning:           String,
    mediaId:           String,
    mediaIds:          [String],
    conceptCount:      Number,
    conceptSkips: [{
      _id:       false,
      conceptId: String,
      reason:    String,
      mediaId:   String
    }],
    capped: [{
      _id:     false,
      kind:    String,
      format:  String,
      before:  Number,
      after:   Number,
      dropped: Number
    }],
    payloadsBeforeCap: Number,
    error:             String,
    errorName:         String
  }],

  requestedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Per-run Slack live feed (services/runFeedService.js). Parent message
  // ts is claimed atomically across web instances (min 1 / max 3) so two
  // processes working the same run do not each create a parent. Only the
  // winner of the conditional updateOne writes this; losers re-read and
  // thread under the winner's ts. See claimParentTs.
  slackFeed: {
    ts:      { type: String, default: null },
    channel: { type: String, default: null }
  },

  startedAt:    { type: Date, default: Date.now },
  completedAt:  { type: Date, default: null }
}, { timestamps: true });

campaignRunSchema.index({ brandId: 1, createdAt: -1 });
// The /generate concurrency gate runs this exact shape twice per request
// (pre-check, then mint-then-verify): campaignId + in-flight status + the stale
// window. Separate campaignId/status indexes make it a scan over the campaign's
// whole run history, and this query sits in front of every generation.
campaignRunSchema.index({ campaignId: 1, status: 1, createdAt: -1 });
// The "you already ran this exact request" lookup: newest FINISHED run on this
// campaign with a given fingerprint, inside DUPLICATE_LOOKBACK_MIN. Without this
// the duplicate check scans the campaign's whole run history on every generate.
campaignRunSchema.index({ campaignId: 1, requestFingerprint: 1, createdAt: -1 });

module.exports = mongoose.model('CampaignRun', campaignRunSchema);
