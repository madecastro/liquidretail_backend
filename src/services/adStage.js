'use strict';
//
// adStage — per-ad render progress telemetry.
//
// FIRE-AND-FORGET BY CONTRACT. Callers must NEVER await these helpers, and a
// failed write is swallowed. This is telemetry on a path where Atlas has
// already been billed (or is about to be); a Mongo blip must never be able to
// fail a paid render. A stage can be missed under load — acceptable, because
// the next transition overwrites it and the terminal status is written by the
// real persist path, not by this.
//
// Throttle floor (AD_STAGE_MIN_MS, default 3000): poll loops piggyback stage
// writes on their existing tick. If someone lowers ATLAS_IMAGE_POLL_MS /
// ATLAS_POLL_INTERVAL_MS below the floor, we still write at most once per floor
// for the same phase. Distinct phase transitions always write immediately so a
// fast derive→fetch→submit sequence is not collapsed into silence.
//
// Do NOT add this knob to config/defaults.env — another change owns that file.

const Ad = require('../models/Ad');

/** Last write per ad: { base, at }. Lazy-read env so tests can flip the knob. */
const _lastByAd = new Map();

function stageMinMs() {
  const n = Number(process.env.AD_STAGE_MIN_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

/**
 * Strip the poll-progress suffix so "master video generation (9:16) — polling 4m10s (17)"
 * and "... — polling 4m25s (18)" share a base and throttle against each other, while
 * "titling 9:16" is a different phase and always lands.
 */
function stageBase(stage) {
  return String(stage || '')
    .replace(/\s*—\s*polling\s+\S+\s*\(\d+\)\s*$/i, '')
    .trim();
}

/** Format elapsed ms as "4m10s" / "12s" for poll stage strings. */
function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${String(r).padStart(2, '0')}s`;
}

/**
 * Record which stage a specific ad is in, so an operator can read one assetId's
 * state instead of grepping logs for it.
 *
 * NOT AWAITED. Never throws.
 *
 * @param {string|object} adId
 * @param {string} stage
 * @param {object} [extra]  optional run-feed meta (e.g. `{ source }`).
 */
function adStage(adId, stage, extra) {
  if (adId == null || stage == null || stage === '') return;
  const id = String(adId);
  const text = String(stage);
  const now = Date.now();
  const base = stageBase(text);
  const prev = _lastByAd.get(id);
  // Same phase within the floor → drop (poll ticks). Different phase → always write.
  if (prev && prev.base === base && (now - prev.at) < stageMinMs()) return;
  _lastByAd.set(id, { base, at: now });

  // Per-run Slack feed — fire-and-forget, never awaited. runFeedService
  // itself never throws; the try is belt-and-braces so a require/load
  // failure cannot fail a paid render. Poll-tick filtering lives inside
  // the feed (structural match on "— polling Ns (k)"), not here: the
  // Mongo write above still wants the latest poll progress for the UI.
  try {
    // Lazy require: keeps adStage load free of the feed's optional deps
    // and avoids a cycle if the feed ever pulls adStage helpers.
    // eslint-disable-next-line global-require
    require('./runFeedService').onStage(id, text, extra);
  } catch { /* never escape to a render path */ }

  Ad.updateOne(
    { _id: adId },
    { $set: { renderStage: text, renderStageAt: new Date(), updatedAt: new Date() } }
  ).catch(() => {});
}

/**
 * Persist a renderError-shaped diagnostic without flipping status.
 *
 * Used for non-fatal degradations (logo skip, face-crop skip, layout derive
 * miss) so GET /api/ads/render-activity can surface a reason the operator can
 * act on in a regen. Terminal failures that also flip status should use a
 * normal awaited Ad.updateOne on the caller's bookkeeping path instead.
 *
 * FIRE-AND-FORGET. Never throws. Never awaited.
 */
function noteRenderIssue(adId, { message, stage, predictionId, charged, atlasCode, err } = {}) {
  if (adId == null || !message) return;
  const { childTailsFrom } = require('./renderErrorFields');
  const renderError = {
    message: String(message).slice(0, 1000),
    stage:   stage ? String(stage) : 'unknown',
    at:      new Date(),
    ...childTailsFrom(err)
  };
  if (predictionId != null) renderError.predictionId = String(predictionId);
  if (charged === true)     renderError.charged = true;
  if (atlasCode != null)    renderError.atlasCode = Number(atlasCode);

  Ad.updateOne(
    { _id: adId },
    { $set: { renderError, updatedAt: new Date() } }
  ).catch(() => {});
}

/** Test-only: clear throttle state between harness cases. */
function _resetThrottleForTests() {
  _lastByAd.clear();
}

/**
 * Group a set of { renderStage } rows into stage buckets, base-name first
 * (so a poll trailer like " — polling 20s (7)" collapses into the phase it
 * belongs to) and sorted most-common-first.
 *
 * PURE — takes plain rows, not a query. Exists as its own function so
 * summarizeInFlightStages (the Mongo-touching half) and any harness can
 * share one grouping rule instead of two copies drifting apart. This is the
 * same "now: X, Y" aggregation runFeedService already computes for Slack's
 * live parent message (buildParentText) — kept here, next to stageBase, so
 * both the Slack feed and the HTTP run poller can be pointed at one
 * definition of "what stage is this run's in-flight work in".
 *
 * @param {Array<{renderStage?: string|null}>} rows
 * @param {{limit?: number}} [opts]
 * @returns {Array<{stage: string, count: number}>} sorted desc by count
 */
function groupStageCounts(rows, { limit = 8 } = {}) {
  const counts = new Map();
  for (const row of rows || []) {
    const raw = row && row.renderStage;
    if (!raw) continue;
    const base = stageBase(raw) || raw;
    if (!base) continue;
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage))
    .slice(0, Math.max(1, limit));
}

/**
 * What stage is this run's in-flight work actually in, right now?
 *
 * Reads the same field (`Ad.renderStage`) and the same base-name rule
 * (`stageBase`) runFeedService already uses to build Slack's "now: …" line
 * — this is the read half of the single-source-of-truth the run poller was
 * missing (GET /api/ads/runs/:id used to return only aggregate
 * succeeded/failed/skipped counts, with zero notion of *what stage* the
 * remaining work was in; an operator had to open Slack or Mongo to learn
 * that, e.g., 8 ads were stuck in "titling" and 2 in "quality check").
 *
 * A plain awaited read — NOT fire-and-forget like the rest of this file.
 * Safe to call from an HTTP handler; it never writes anything.
 *
 * @param {string} runId
 * @param {{limit?: number, _Ad?: object}} [opts] `_Ad` is a test-only
 *   injection seam (a fake with a chainable `.find().select().lean()`) so a
 *   harness can drive this without touching real Mongo — mirrors the
 *   `_setDeps`-style seams elsewhere in this file/runFeedService, just
 *   scoped to one call instead of module state.
 * @returns {Promise<Array<{stage: string, count: number}>>}
 */
async function summarizeInFlightStages(runId, opts = {}) {
  if (!runId) return [];
  const AdModel = opts._Ad || Ad;
  const rows = await AdModel.find({ campaignRunIds: runId, status: 'rendering' })
    .select('renderStage')
    .lean();
  return groupStageCounts(rows, opts);
}

module.exports = {
  adStage,
  noteRenderIssue,
  formatElapsed,
  stageBase,
  stageMinMs,
  groupStageCounts,
  summarizeInFlightStages,
  _resetThrottleForTests
};
