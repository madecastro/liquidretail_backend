'use strict';
/**
 * QC-insights aggregation report. Analytics-only: safe to delete rows,
 * never joined into a render / generate / recover / requeue path.
 *
 * One document per scheduler tick (or POST /api/qc-insights/run). The
 * HTML page at GET /api/qc-insights/report reads the newest row.
 */

const mongoose = require('mongoose');

const qcInsightsReportSchema = new mongoose.Schema({
  schemaVersion: { type: Number, default: 1 },
  windowStart: { type: Date, required: true },
  windowEnd: { type: Date, required: true },
  generatedAt: { type: Date, required: true },
  durationMs: { type: Number, default: 0 },
  adsScanned: { type: Number, default: 0 },
  adsWithVerdicts: { type: Number, default: 0 },
  // Two-gate snapshot: { staticQcEnabled, videoQcEnabled, mode, samplePct, proposalsEnabled }
  qcConfig: { type: mongoose.Schema.Types.Mixed, default: null },
  totals: { type: mongoose.Schema.Types.Mixed, default: null },
  categories: { type: mongoose.Schema.Types.Mixed, default: null },
  // Per-category { verdict, concentrations }
  segmentVerdicts: { type: mongoose.Schema.Types.Mixed, default: null },
  segments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  findingsClusters: { type: [mongoose.Schema.Types.Mixed], default: [] },
  armComparison: { type: [mongoose.Schema.Types.Mixed], default: [] },
  overridePerformance: { type: [mongoose.Schema.Types.Mixed], default: [] },
  proposals: { type: [mongoose.Schema.Types.Mixed], default: [] },
  proposalsProvenance: { type: mongoose.Schema.Types.Mixed, default: null },
  notes: { type: [String], default: [] }
});

qcInsightsReportSchema.index({ generatedAt: -1 });

module.exports = mongoose.model('QcInsightsReport', qcInsightsReportSchema);
