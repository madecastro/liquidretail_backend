// IncidentLog — append-only crash / operational-failure ledger.
//
// Why this exists: Slack is notification, not the system of record. With
// no-folding crash alerts, ALERT_RATE_LIMIT_MAX is the only silent drop
// point — an operator who only has the channel cannot reconstruct what
// was lost. Every crashReporter.report() writes here BEFORE the Slack
// send (see THE ORDERING RULE in CONTRACT-crash-alerting.md), so a
// rate-limited or unconfigured deploy still leaves a queryable trail.
//
// Append-only by design. The only post-create mutations are the
// slackDelivered / slackError patch after the notification attempt —
// never rewrite title/kind/diagnostic. Nothing else updates this collection.
//
// Only `at`, `kind`, `title` (plus unique `incidentId`) are required so a
// boot crash, expansion failure, or worker-loop crash with no Ad and no
// Run still persists. Money fields exist so an ad killed after a billable
// Atlas submit but before veoPredictionId was stamped is visible as
// unrecoverable spend.

'use strict';

const mongoose = require('mongoose');

// Exact strings — other lanes (processAlerts, routes/ads swallow points,
// reaper) hard-code these. Do not rename without updating every call site.
const KINDS = [
  'uncaughtException',
  'unhandledRejection',
  'shutdown',
  'dispatch-crash',
  'render-crash',
  'render-stage-failed',
  'direct-image-unavailable',
  'video-generation-failed',
  'video-titling-failed',
  'static-render-failed',
  'ad-not-found',
  'regenerate-failed',
  'expansion-product-failed',
  'worker-loop-crash',
  'reaper-failed',
  'cost-row-dropped',
  'vision-qc-failed',
  'director-contract-warn',
  'proof-judge-unavailable',
  'alert-rate-limit-spill'
];

// 'info' is included deliberately: a CLEAN shutdown is an info-level incident
// (muted in Slack at the default ALERT_MIN_LEVEL=warn) and it still deserves a
// durable row — that row is how you later prove a deploy replaced the instance
// without losing work. Omitting it here would make schema validation reject
// every clean-shutdown row.
const LEVELS = ['info', 'warn', 'error', 'fatal'];

// TTL read at module load so a process boot pins the retention window.
// Clamp to ≥1 day so a typo cannot wipe the collection every few minutes.
const TTL_DAYS = (() => {
  const n = parseInt(process.env.INCIDENT_LOG_TTL_DAYS || '90', 10);
  return Number.isFinite(n) && n >= 1 ? n : 90;
})();
const TTL_SECONDS = TTL_DAYS * 86400;

const incidentLogSchema = new mongoose.Schema({
  // Short hex from crashReporter (crypto.randomBytes(6).toString('hex')).
  // Unique so Slack key `crash:${incidentId}` joins 1:1 to this row.
  // unique creates the index; do not also set index:true (duplicate key warning).
  incidentId: { type: String, required: true, unique: true },

  // index via the TTL declaration below — one index on `at`, not two.
  at:    { type: Date, required: true, default: Date.now },
  kind:  { type: String, required: true, index: true },
  level: { type: String, required: true, enum: LEVELS },

  // ── origin ───────────────────────────────────────────────────────────────
  role:       { type: String },   // 'web' | 'worker'
  instanceId: { type: String },   // RENDER_INSTANCE_ID (last 8) or hostname
  commit:     { type: String },   // RENDER_GIT_COMMIT, first 8
  envLabel:   { type: String },   // ALERT_ENV_LABEL || NODE_ENV
  uptimeSec:  { type: Number },
  signal:     { type: String },   // 'SIGTERM' | 'SIGINT' | null

  // ── payload ──────────────────────────────────────────────────────────────
  title:      { type: String, required: true },
  message:    { type: String },
  stack:      { type: String },
  // renderDiagnostic block, VERBATIM — do not reformat at write time.
  diagnostic: { type: String },

  // ── correlation ──────────────────────────────────────────────────────────
  // Set when an earlier incident for the SAME ad already paged someone inside
  // CRASH_AD_WINDOW_MS. The row is still written in full — one logical failure
  // can surface at several layers, and all of them stay documented; only the
  // duplicate Slack messages are withheld. Query `duplicateOf: null` for the
  // set of failures a human was actually notified about.
  duplicateOf: { type: String, default: null },

  adId:       { type: String, index: true },
  runId:      { type: String, index: true },
  campaignId: { type: String },
  productId:  { type: String },
  brandId:    { type: String },
  mediaId:    { type: String },
  stage:      { type: String },

  // ── money ────────────────────────────────────────────────────────────────
  // An ad killed after a billable submit but before veoPredictionId was
  // persisted is unrecoverable spend. These three make that queryable.
  predictionId: { type: String },
  charged:      { type: Boolean, default: false },
  costUsd:      { type: Number },

  // ── in-flight snapshot (crash / shutdown kinds only) ─────────────────────
  inFlight: {
    runCount:       { type: Number },
    adsRemaining:   { type: Number },
    runIds:         [{ type: String }],
    adIds:          [{ type: String }],
    submittedAdIds: [{ type: String }]
  },

  // ── delivery ─────────────────────────────────────────────────────────────
  // "The alert never arrived" must itself be queryable — rate limit, missing
  // token, or Slack {ok:false} all leave slackDelivered false.
  slackDelivered: { type: Boolean, default: false },
  slackError:     { type: String }
}, {
  // No timestamps: `at` is the single clock; updatedAt would imply rows
  // are routinely rewritten, which they are not.
  timestamps: false
});

// TTL on `at` — Mongo's TTL monitor sweeps ~every 60s, so retention is
// approximate. Null `at` never happens (required + default).
incidentLogSchema.index({ at: 1 }, { expireAfterSeconds: TTL_SECONDS });

// kind / runId / adId / incidentId already carry index:true above; compound
// queries for "recent crashes of kind X" benefit from kind+at.
incidentLogSchema.index({ kind: 1, at: -1 });

const IncidentLog = mongoose.model('IncidentLog', incidentLogSchema);
IncidentLog.KINDS = KINDS;
IncidentLog.LEVELS = LEVELS;
IncidentLog.TTL_DAYS = TTL_DAYS;

module.exports = IncidentLog;
