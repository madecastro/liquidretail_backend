'use strict';
//
// STALENESS THRESHOLDS — ONE parser, shared by the web and worker processes.
//
// WHY THIS MODULE EXISTS. `REAP_STALE_MIN` was parsed two different ways in
// two processes that are required to agree about what "stale" means:
//
//   worker.js     Math.max(1, parseInt(process.env.REAP_STALE_MIN, 10) || 15)
//   routes/ads.js Number.isFinite(raw) && raw > 0 ? raw : 15
//
// They agree on every input EXCEPT two, and the disagreement runs the wrong
// way on the one that matters:
//
//   value    old worker   old web    now
//   -5       1            15         15
//   '7.9'    7            7.9        7.9
//
// A negative value resolving to **1** is not a harmless difference — it hands
// the reaper a ONE-MINUTE staleness threshold, so it would sweep ads and runs
// that are a minute old, i.e. actively reap live work mid-render. Falling back
// to the documented default is the only defensible reading of a nonsense
// value. Fractional minutes are harmless either way; not truncating is simply
// more honest about what the operator typed.
//
// The gate/flip money guard in routes/ads.js (see services/campaignRunGuards.js
// buildRunningFlipFilter) and the reaper in worker.js both key off this bound,
// and routes/ads.js's own comment states the invariant plainly: it is "the same
// one worker.js uses to reclaim stuck ads, so the two cannot drift into
// disagreeing about what stale means". Two parsers is exactly that drift, so
// there is now one.
//
// PARSE SEMANTICS, and why `Number(x || fallback)` is the wrong shape. That
// idiom tests the RAW STRING's truthiness before parsing, so any non-empty
// string skips the fallback — '0', '  ' and '-5' are all truthy and sail
// through to produce 0, 0 and -5. This is the same env-parsing trap CLAUDE.md
// records for PMAX_PROOF_* ("blank env is 0, not NaN"), and it is why the
// guard here parses FIRST and validates the NUMBER. Mirrors the existing
// positiveTimeout() in services/atlasImageService.js.
//
// These are lazy getters, not module-load constants, matching
// services/backlogWatchdog.js's N() — a harness can flip process.env and
// re-read without re-requiring the module. Callers that want a value fixed for
// the process lifetime (worker.js does) simply call once at boot.

const REAP_STALE_MIN_DEFAULT = 15;
const PREPARE_STALE_MIN_DEFAULT = 15;

/**
 * Parse a "minutes" env var. Anything that is not a finite POSITIVE number —
 * unset, empty, whitespace, '0', negative, non-numeric — falls back.
 *
 * Zero is deliberately rejected rather than honoured: a 0-minute staleness
 * bound means "everything is always stale", which reaps live work on the
 * worker and (since the CAS age guard) discards every generation on the web.
 * "Set it to 0 to disable" is the intuitive and catastrophic move, so 0 reads
 * as a mistake, not as an instruction.
 */
function positiveMinutes(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long a claimed doc (Ad 'rendering', CampaignRun 'running') may sit
 * untouched before the reaper presumes its holder died — AND the window inside
 * which the concurrency gate still honours a run's exclusivity over its
 * products. Those must be the same number; see the module header.
 */
function reapStaleMin() {
  return positiveMinutes(process.env.REAP_STALE_MIN, REAP_STALE_MIN_DEFAULT);
}

/**
 * How long a CampaignRun may sit in 'preparing' before the reaper stamps it
 * failed. Hygiene only — NOT a money guard (see worker.js's comment and
 * services/campaignRunGuards.js buildRunningFlipFilter for what actually
 * prevents the double-spend). Deliberately a separate knob from
 * reapStaleMin(): expansion's legitimate worst case is far longer than a
 * render heartbeat gap, so the two want independent tuning.
 */
function prepareStaleMin() {
  return positiveMinutes(process.env.PREPARE_STALE_MIN, PREPARE_STALE_MIN_DEFAULT);
}

module.exports = {
  positiveMinutes,
  reapStaleMin,
  prepareStaleMin,
  REAP_STALE_MIN_DEFAULT,
  PREPARE_STALE_MIN_DEFAULT
};
