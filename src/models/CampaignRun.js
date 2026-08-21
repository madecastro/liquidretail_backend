'use strict';
// Phase 0 lightweight CampaignRun shim. Same reasoning as Ad.js —
// strict:false, declare only what this service reads/writes in Phase 0.
//
// Orchestrator polls for status:'preparing' — that's the handoff marker
// backend will set when ADGEN_ORCHESTRATOR_ENABLED flips on (Phase 2).
// Phase 0 does nothing but log; no state transitions.

const mongoose = require('mongoose');

const campaignRunShimSchema = new mongoose.Schema({
  runId:     { type: String, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, index: true },
  status:    { type: String, index: true },  // preparing | running | done | failed
  startedAt: Date,
  completedAt: Date,
  succeeded: { type: Number, default: 0 },
  failed:    { type: Number, default: 0 },
  skipped:   { type: Number, default: 0 },
  total:     { type: Number, default: 0 }
}, {
  strict: false,
  collection: 'campaignruns',
  timestamps: true
});

module.exports = mongoose.model('CampaignRun', campaignRunShimSchema);
