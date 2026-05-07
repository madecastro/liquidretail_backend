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

  total:        { type: Number, default: 0 },
  succeeded:    { type: Number, default: 0 },
  skipped:      { type: Number, default: 0 },
  failed:       { type: Number, default: 0 },

  status:       { type: String, enum: ['running', 'done', 'failed'], default: 'running', index: true },

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

  requestedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  startedAt:    { type: Date, default: Date.now },
  completedAt:  { type: Date, default: null }
}, { timestamps: true });

campaignRunSchema.index({ brandId: 1, createdAt: -1 });

module.exports = mongoose.model('CampaignRun', campaignRunSchema);
