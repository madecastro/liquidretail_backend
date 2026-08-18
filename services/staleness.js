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
// The gate/flip money guards in routes/ads.js (see services/campaignRunGuards.js
// buildRunningFlipFilter and buildActiveRunsFilter) and the reaper in worker.js
// all key off these bounds, and routes/ads.js's own comment states the invariant
// plainly: it is "the same one worker.js uses to reclaim stuck ads, so the two
// cannot drift into disagreeing about what stale means". Two parsers is exactly
// that drift, so there is one. Note that "one parser" is a separate guarantee
// from "one value": there are deliberately TWO values (below), and the money
// invariant is that every PREPARING-scoped consumer reads the same one of them.
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

// TWO WINDOWS, TWO LIFECYCLES — and they are deliberately different numbers.
//
//   REAP_STALE_MIN (15)    — the CLAIMED-DOC window. An Ad in 'rendering' or a
//                            CampaignRun in 'running' heartbeats (per-ad $inc),
//                            so 15m of silence really does mean the holder died.
//                            Raising it would only delay orphan requeue.
//
//   PREPARE_STALE_MIN (30) — the PREPARING-LIFECYCLE window. A 'preparing'
//                            CampaignRun makes ZERO writes between mint and the
//                            'running' flip, so this is not "silence", it is
//                            "time since mint" against a job with a genuinely
//                            long healthy runtime. worker.js's own arithmetic
//                            puts a healthy expansion at ~18-20 min (Director's
//                            2 paid attempts x (120s timeout + backoff) ≈ 12
//                            min, plus the Judge call). At 15 the system was
//                            reaping — and refusing the flip of — expansions
//                            that were merely finishing normally: the operator
//                            saw a crashed run and the ads went back to queued.
//                            30 clears the documented ceiling with headroom.
const REAP_STALE_MIN_DEFAULT = 15;
const PREPARE_STALE_MIN_DEFAULT = 30;

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
 * How long a CLAIMED doc (Ad 'rendering', CampaignRun 'running') may sit
 * untouched before the reaper presumes its holder died — AND the window inside
 * which the concurrency gate still honours a RUNNING run's exclusivity. Those
 * must be the same number; see the module header.
 *
 * SCOPE, corrected 2026-08-18: this no longer governs 'preparing' runs. The
 * flip guard and the gate's preparing arm moved to prepareStaleMin() because
 * this window (15) is shorter than a healthy expansion (~18-20 min), so it was
 * failing runs that were merely finishing. Do NOT raise this to "fix" that —
 * it would delay orphan requeue for every Ad and every running run, which is a
 * different and unwanted trade. See prepareStaleMin() below.
 */
function reapStaleMin() {
  return positiveMinutes(process.env.REAP_STALE_MIN, REAP_STALE_MIN_DEFAULT);
}

/**
 * THE PREPARING-LIFECYCLE WINDOW. One value, three consumers, and they MUST
 * agree — this is a money invariant, not a tuning preference.
 *
 *   (a) worker.js reapOrphans()      — stamps a stale 'preparing' run failed
 *                                      (buildStalePreparingFilter)
 *   (b) the 'preparing'→'running' CAS — buildRunningFlipFilter's age guard
 *                                      (routes/ads.js), i.e. how long a run
 *                                      may still claim its own expansion
 *   (c) the concurrency gate          — the PREPARING arm of
 *                                      buildActiveRunsFilter (routes/ads.js),
 *                                      i.e. how long a preparing run still
 *                                      blocks an identical duplicate request
 *
 * WHY (b) AND (c) MUST BE THE SAME NUMBER. Let Wg be how long the gate still
 * counts a preparing run as in-flight, and Wf how long that run may still win
 * its flip. If Wf > Wg there is a live double-bill window: between Wg and Wf
 * the gate no longer sees the original run, so a duplicate request sails
 * through as "not a duplicate" and bills a fresh generation — and then the
 * original's slow expansion finishes and ITS flip still succeeds, billing a
 * second time for one operator intent. So safety requires Wf <= Wg, and there
 * is no reason to want Wf < Wg (that only throws away legitimate flips the
 * gate was still protecting). Hence Wf == Wg, both read from HERE.
 *
 * (The one intentional sliver of Wf < Wg is structural, not a tuning choice:
 * the flip keys on `startedAt` and the gate on `createdAt`, which mongoose
 * stamps a few ms later — see buildRunningFlipFilter's JSDoc. That leans the
 * safe way by milliseconds.)
 *
 * Keeping it a SEPARATE KNOB from reapStaleMin() is what makes 30 affordable:
 * RUNNING-run reaping and the Ad-level reaper stay at 15, so orphan requeue is
 * not delayed. Only the preparing lifecycle moves.
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
