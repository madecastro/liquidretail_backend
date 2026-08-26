'use strict';
//
// STAGE TIMING — fire-and-forget per-stage wall-time stamp on Ad.renderStages.
//
// WHY (2026-08-26). Phase 0 of the wall-time reduction plan. Ad.renderStages
// was declared in the schema but never written; DB analytics could not
// attribute wall time to any specific pipeline stage, so a Phase 2 fix that
// halved static wall clock could not be measured against a Phase 3 fix that
// did the same. Adding this now (before shipping either) so every downstream
// change lands with the measurement already in place.
//
// This module intentionally has NO dependencies except the Ad model and
// `models/Ad.js` opting-out of strict mode on renderStages (declared
// mongoose.Schema.Types.Mixed — see the field's comment). That means arbitrary
// nested keys land safely; a new stage sub-field can be added without a schema
// migration.
//
// ── FIRE-AND-FORGET, NEVER LOAD-BEARING ─────────────────────────────────────
// Every call is unawaited. Errors are swallowed. Instrumentation MUST NOT be
// able to fail a paid render — the same discipline `renderStage` (the live
// per-ad stage string) already follows. If Mongo is down, the render still
// completes; the stamp just doesn't land.
//
// ── OWNER-SCOPED WRITE ──────────────────────────────────────────────────────
// The write filters by `{_id, claimedByWorker: WORKER_ID}` — same owner-scope
// rule as the renderer's terminal writes. A stamp fired by an ex-owner (the
// worker died and someone else re-claimed) is a no-op. This is more
// conservative than needed for a telemetry field, but the pattern is
// consistent with the money-safe writes around it and cheaper than reasoning
// through the exceptions.

const Ad = require('../models/Ad');
const { WORKER_ID } = require('../config');

// Whitelist of stage names so a typo doesn't scatter half-cased keys across
// the collection. New stages get added here explicitly.
const KNOWN_STAGES = new Set([
  // Legacy (kept — some queries still key on these)
  'deriveMs',
  'renderMs',
  'uploadMs',
  // Phase 0/1/2/3 expansion
  'layoutInputMs',
  'quoteSnippetMs',
  'sharpMs',
  'atlasSubmitMs',
  'visionQcMs',
  'remotionMs',
  'titlerPickupWaitMs'
]);

/**
 * Stamp one stage's wall time on Ad.renderStages. Fire-and-forget.
 *
 * @param {ObjectId|string} adId   the ad to stamp
 * @param {string} stage           one of KNOWN_STAGES
 * @param {number} ms              wall time in milliseconds
 * @returns {void}                 does not return a promise; unawaited
 */
function stampStageTiming(adId, stage, ms) {
  if (!adId) return;
  if (!KNOWN_STAGES.has(stage)) return;
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  // Aggregation pipeline update so the write is atomic AND coalesces the
  // null-parent case. Ad.renderStages defaults to `null` (models/Ad.js's
  // field declaration), and Mongo REJECTS a nested $set on a null parent
  // with 'Cannot create field X in element {renderStages: null}' — the
  // silent failure caught on run_1787778351659 where 12/12 ads showed
  // renderStages:null after every stamp attempt. `$ifNull` converts null
  // to `{}`, `$mergeObjects` preserves any pre-existing sub-fields, and
  // the single-document write cannot race.
  Ad.updateOne(
    { _id: adId, claimedByWorker: WORKER_ID },
    [
      {
        $set: {
          renderStages: {
            $mergeObjects: [
              { $ifNull: ['$renderStages', {}] },
              { [stage]: Math.round(n) }
            ]
          }
        }
      }
    ]
  ).catch(() => {
    // Deliberately silent — telemetry must not surface as an error on the
    // paid path. Log-noise is worse than a missing datapoint.
  });
}

/**
 * Convenience: start a timer for a stage; call the returned fn with the
 * ad._id when the stage completes.
 *
 *   const t = startStageTimer('sharpMs');
 *   ... do work ...
 *   t(ad._id);   // stamps the elapsed ms
 *
 * @param {string} stage           one of KNOWN_STAGES
 * @returns {(adId) => void}       call at stage completion with the adId
 */
function startStageTimer(stage) {
  const t0 = Date.now();
  return function stopAndStamp(adId) {
    stampStageTiming(adId, stage, Date.now() - t0);
  };
}

module.exports = {
  stampStageTiming,
  startStageTimer,
  KNOWN_STAGES
};
