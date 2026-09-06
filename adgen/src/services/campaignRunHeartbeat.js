'use strict';
//
// CAMPAIGNRUN LIVENESS HEARTBEAT — the reaper's `updatedAt` predicate had no
// heartbeat behind it, and that cost an operator a third of a paid run.
//
// ── THE MEASURED INCIDENT (run_1787105727540_e8c94542, 2026-08-18) ─────────
//   02:15:27Z  run starts — one product, Meta + PMax "Everything", 39 claimed
//   ~02:21     all 18 statics settled; every remaining row is video
//   02:21-02:36  video titling runs. NO CampaignRun write happens in that
//              window, because the ONLY thing that moved `updatedAt` on the
//              run was the per-ad `$inc {succeeded|failed|skipped}` that fires
//              when an ad SETTLES (mongoose refreshes updatedAt on this
//              timestamps:true schema).
//   02:36:29Z  worker.js reapOrphans() matches
//              `{ status:'running', updatedAt: { $lt: now - REAP_STALE_MIN } }`
//              and stamps the run `failed` — with `errors: []`, `failed: 0`.
//              Nothing threw. The run was working the whole time.
//   Same tick  the Ad sweep flips this run's claimed-but-not-yet-dispatched
//              tail from 'rendering' back to 'queued' for the same reason:
//              their `updatedAt` is refreshed only by the per-COMPLETION
//              `Ad.updateMany` in the render loop, which had also gone quiet.
//              9 rows (21 video ads minus VEO_CONCURRENCY=12 dispatched) were
//              stranded 'queued' permanently. The operator paid for the
//              masters and silently received 30 of 39 creatives.
//
// So the reaper's predicate did not mean "this run is alive". It meant "an ad
// settled recently", and those are different statements the moment a run's
// work is long and serialised — which, since video went to 10s on both
// platforms and Meta+PMax began sharing ONE 9:16 master (15 of 21 video rows
// now queue behind a single plate, titling serialised behind
// REMOTION_QUEUE_CONCURRENCY=4), is the NORMAL shape of a mixed run, not an
// edge case.
//
// ── WHY NOT JUST RAISE REAP_STALE_MIN ─────────────────────────────────────
// Because 15 is the CLAIMED-DOC window: raising it delays orphan requeue for
// every Ad and every running run. PR #209 deliberately left it at 15 and moved
// only the preparing lifecycle to 30 (services/staleness.js states this at
// length). The defect is not that the window is too short — it is that the
// signal underneath it was not a liveness signal. Fix the signal.
//
// ── WHY THIS IS NOT "JUST TICK AND NEVER GET REAPED" ──────────────────────
// A heartbeat that beat unconditionally would defeat the reaper outright and
// resurrect the class it exists to kill: a run wedged forever, holding claimed
// ads nothing will ever release. So the beat is CONDITIONAL on real in-flight
// work — `isWorking()` is wired to the render loop's own live pool counters
// (`pools.some(p => p.inflight > 0)`), which is the same number the loop uses
// to decide it is finished. A loop with zero renders in flight emits no beat,
// and 15 minutes of that is exactly the "dead holder" the reaper should catch.
// The timer also dies with the process (a wedged INSTANCE cannot beat at all).
//
// ── WHAT IT WRITES, AND WHAT IT MUST NEVER WRITE ──────────────────────────
// `total` is the claim count and the progress denominator; `succeeded`,
// `failed` and `skipped` are the outcome counters. A heartbeat that touched
// ANY of them would corrupt the progress bar and the run's own audit — the
// operator would be told work happened that did not. So the write is
// `$set: { updatedAt, lastHeartbeatAt }` and nothing else, ever.
//
// `lastHeartbeatAt` is DECLARED on models/CampaignRun.js. Mongoose strict
// silently DROPS a write to an undeclared path — this repo has already lost
// `renderError.predictionId` exactly that way (CLAUDE.md §2/§4) — so the
// declaration is load-bearing, not documentation.
//
// WHAT IT ACTUALLY TELLS YOU, stated precisely because an earlier draft of this
// comment had it BACKWARDS (adversarial review, 2026-08-18). A beat writes both
// fields to the same instant, so on a beating run the two are always ~equal;
// only a SETTLEMENT moves `updatedAt` without moving `lastHeartbeatAt`. So the
// gap between them is not "alive but nothing settled" — it is at most "a
// settlement landed after the last beat", and on a healthy run it is noise.
// The honest reading is:
//
//   lastHeartbeatAt fresh                  → the render loop is alive AND has
//                                            work in flight (the beat is gated
//                                            on inflight > 0).
//   lastHeartbeatAt stale/null, status     → nothing is in flight, or the
//     still 'running'                        process is gone. The reaper is
//                                            about to act, correctly.
//   is work SETTLING?                      → compare succeeded+failed+skipped
//                                            against `total`. NOT a date gap.
//
// That first line is the whole diagnostic value, and it is exactly what
// `updatedAt` alone could not say on 2026-08-18.
//
// `updatedAt` is also set explicitly, and it is worth knowing that TODAY THAT
// VALUE IS DISCARDED: on a `timestamps: true` schema mongoose 7 rewrites
// `$set.updatedAt` with its own `now`
// (node_modules/mongoose/lib/helpers/update/applyTimestampsToUpdate.js — the
// non-dotted path falls through to `updates.$set[updatedAt] = now` with no
// "already set" guard, unlike the `overwrite` branch). The two values differ by
// microseconds within one call, so nothing depends on which wins. It is written
// anyway as belt-and-braces that becomes load-bearing the moment this schema
// follows models/Ad.js to `timestamps: false` — which is precisely why the Ad
// heartbeat in routes/ads.js has to set it by hand.
//
// ── THE AD ARM, AND WHY IT IS NOT SCOPE CREEP ─────────────────────────────
// The run beat alone would have kept run_1787105727540_e8c94542 alive — but it
// would NOT have saved the 9 ads, because those were reaped by the AD sweep on
// the identical silence. Worse, an ad flipped to 'queued' while it is still
// sitting in a LIVE in-memory pool is claimable by a concurrent
// selectAdsForRun: the other run submits it, this run's pool then dispatches
// the same row (renderOneInner does `Ad.findById` with no status guard), and
// one operator intent buys two Omni masters. That is a money hazard, not
// tidiness.
//
// The fix is the write the render loop ALREADY performs on every completion —
// `Ad.updateMany({ _id: { $in: adIds }, status: 'rendering' }, { $set:
// { updatedAt } })` — put on a timer as well as on completions. Same filter,
// same update, different trigger. It cannot mask a wedged DISPATCHED ad
// (renderOne's own 60s per-ad beat already covers those unconditionally); all
// it newly protects is the claimed-but-undispatched tail, which is provably
// not wedged — it is waiting for a slot.
//
// ── PRECEDENT THIS FOLLOWS ────────────────────────────────────────────────
//   routes/ads.js renderOne()      — the ~60s Ad beat, cleared in `finally`
//   services/progressService.js    — the OperationRun beat, unref'd, closed by
//                                    closeTimers() on every exit path
// Both are fire-and-forget, both `.catch()` every write, both `unref()` so a
// live timer can never hold the process open. So is this.

const { reapStaleMin } = require('./staleness');

// The beat interval, capped at 60s — the SAME cadence as the Ad heartbeat in
// routes/ads.js renderOne(), which has run in production against this exact
// reaper window since 2026-08-04. There is no reason for the run to beat on a
// different clock than the ads inside it.
const HEARTBEAT_CAP_MS = 60_000;

// How many beats must fit inside the reaper's silence window before we accept
// the interval. At the documented REAP_STALE_MIN of 15 the cap gives 15 beats
// per window — a run has to miss FIFTEEN consecutive writes to be falsely
// reaped, and each miss requires an independently-failing Mongo write on an
// indexed single-document update. That is the margin, and it is the same
// margin the Ad beat has always carried.
//
// The divisor only becomes the binding constraint if an operator shortens
// REAP_STALE_MIN below 5 minutes, where a fixed 60s beat would no longer leave
// room for a transient Mongo blip. Deriving from the REAL parsed value (the
// ONE parser in services/staleness.js — PR #207 unified two divergent parsers,
// do not add a third) is what makes "well under the reaper cutoff" a
// structural property instead of a convention two files have to remember.
const MIN_BEATS_PER_WINDOW = 5;

// Floor, so a nonsense-but-positive REAP_STALE_MIN (positiveMinutes accepts
// fractions) cannot turn this into a spin loop hammering Mongo.
//
// ⚠️ THE FLOOR AND THE DIVISOR CONFLICT BELOW A ~25s WINDOW, and this is
// stated rather than papered over (an earlier draft of this file claimed the
// floor was what made "≥5 beats always fit" true; it is what BREAKS it).
// MIN_BEATS_PER_WINDOW * HEARTBEAT_FLOOR_MS = 25s, so the invariant holds for
// every REAP_STALE_MIN >= ~0.4167 min and degrades below it; under ~0.083 min
// the interval would even exceed the cutoff. That domain is not defensible to
// close, and it does not need closing: at a sub-25-second reap window the
// pre-existing 60s Ad heartbeat in routes/ads.js is already hopeless and the
// reaper would be requeuing live renders seconds after they claim. The floor
// protects Mongo from an absurd value; it does not pretend to make an absurd
// value safe. Pinned as an explicit boundary by verifyCampaignRunHeartbeat A2b.
const HEARTBEAT_FLOOR_MS = 5_000;

// TOTAL LIFETIME CAP — the thing progressService's MAX_RUN_MS exists for, and
// this ticker needs it for exactly the same reason.
//
// `isWorking` reads `pools.some(p => p.inflight > 0)`, and `inflight` is
// decremented in renderOne's `.finally`. A renderOne that NEVER SETTLES — a
// hung provider poll, a promise nothing resolves — therefore holds `inflight`
// above zero forever, and without this cap the ticker would beat forever: the
// run stays 'running' and is never reaped, the concurrency gate keeps refusing
// the operator's identical re-request, and (via the Ad arm) the whole claimed
// 'rendering' set stays out of the Ad reaper's reach instead of going back to
// 'queued' where "Generate more" could drain it. That is strictly worse than
// the pre-heartbeat behaviour for a genuinely wedged loop, and it is the exact
// "abandoned handle pins a run running forever" hazard progressService.js
// guards with MAX_RUN_MS. Adversarial review (2026-08-18) caught its absence.
//
// 4 HOURS, matching progressService.MAX_RUN_MS deliberately rather than by
// coincidence: `runRenderLoop` opens an OperationRun via
// startRun({ kind: 'ad-batch' }) for this same batch, and that row's heartbeat
// already expires at 4h. Two heartbeats for one logical run should not disagree
// about when it has stopped being credible. Past the cap the beat stops, the
// reaper reclaims within REAP_STALE_MIN, and recovery behaves as it did before
// this file existed. A batch legitimately longer than 4h would be reaped — the
// same trade progressService already makes, and far better than immortality.
const RUN_HEARTBEAT_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * The beat interval in ms, derived from the shared parser's REAL current
 * value. Lazy (not a module-load constant) for the same reason
 * services/staleness.js is lazy: a harness can flip process.env and re-read
 * without re-requiring the module.
 */
function runHeartbeatMs() {
  const windowMs = reapStaleMin() * 60 * 1000;
  return Math.max(
    HEARTBEAT_FLOOR_MS,
    Math.min(HEARTBEAT_CAP_MS, Math.floor(windowMs / MIN_BEATS_PER_WINDOW))
  );
}

/**
 * WHICH run row a beat may touch. `status: 'running'` is not decoration — it
 * is what stops a beat racing the reaper and RESURRECTING a run the reaper
 * already stamped 'failed', or re-touching one the loop already stamped
 * 'done'. Same posture as the Ad beat's `status:'rendering'` scope and as
 * buildTerminalDoneFilter's allow-list.
 *
 * Deliberately does NOT include 'preparing': that lifecycle is governed by
 * mint age (PREPARE_STALE_MIN) precisely because a preparing run has no
 * liveness signal, and manufacturing one here would silently disable the
 * preparing reap.
 */
function buildRunHeartbeatFilter(runDocId) {
  return { _id: runDocId, status: 'running' };
}

/**
 * WHAT a beat writes. Two date fields. No `total`, no `succeeded`, no
 * `failed`, no `skipped`, no `$inc` of anything — see the module header.
 */
function buildRunHeartbeatUpdate(now) {
  const at = now instanceof Date ? now : new Date();
  return { $set: { updatedAt: at, lastHeartbeatAt: at } };
}

/**
 * The AD arm: byte-identical to the per-completion write already in
 * runRenderLoop, so the timer and the completion path cannot drift into
 * touching different populations.
 */
function buildClaimedAdHeartbeatFilter(adIds) {
  return { _id: { $in: adIds }, status: 'rendering' };
}

function buildClaimedAdHeartbeatUpdate(now) {
  // models/Ad.js is timestamps:false — nothing sets this for us.
  return { $set: { updatedAt: now instanceof Date ? now : new Date() } };
}

/**
 * One beat. Exported separately from the ticker so a harness can drive it
 * against recording stubs and assert the EXACT filter/update pair that
 * reaches Mongo, rather than regexing the source for the right words.
 *
 * Never rejects. A missed beat is survivable — the next one lands, and the
 * reaper needs MIN_BEATS_PER_WINDOW consecutive misses before it acts.
 */
async function heartbeatOnce({ CampaignRun, Ad, runDocId, adIds = [], now = new Date() } = {}) {
  const writes = [
    Promise.resolve()
      .then(() => CampaignRun.updateOne(buildRunHeartbeatFilter(runDocId), buildRunHeartbeatUpdate(now)))
      .catch(() => {})
  ];
  if (Ad && Array.isArray(adIds) && adIds.length) {
    writes.push(
      Promise.resolve()
        .then(() => Ad.updateMany(buildClaimedAdHeartbeatFilter(adIds), buildClaimedAdHeartbeatUpdate(now)))
        .catch(() => {})
    );
  }
  await Promise.all(writes);
}

/**
 * Start the ticker. Returns a handle whose `.stop()` is IDEMPOTENT — the call
 * site clears it in BOTH the `catch` and the `finally` (CLAUDE.md §5 for this
 * ticker class), and a double clearInterval must be a no-op rather than a
 * second timer's worth of surprise.
 *
 * Beats once IMMEDIATELY (gated on the same `isWorking()` the interval uses)
 * before the first `setInterval` tick, then every `intervalMs` after that —
 * see the "LEADING BEAT" comment inside for why a batch that settles inside
 * the first interval must not read `lastHeartbeatAt: null` for its whole life.
 *

 * @param {object}   opts.runDocId   CampaignRun._id
 * @param {string[]} opts.adIds      this run's claimed ad ids (the Ad arm)
 * @param {function} opts.isWorking  () => boolean. THE GATE. Must report the
 *   render loop's REAL in-flight count. A truthy constant here would defeat
 *   the reaper; see the module header.
 * @param {object}   opts.models     { CampaignRun, Ad } — injectable so the
 *   harness never touches Mongo. Defaults to the real models.
 * @param {number}   opts.intervalMs override for tests only.
 * @param {number}   opts.maxMs      total beat lifetime. Defaults to
 *   RUN_HEARTBEAT_MAX_MS; overridden only by the harness. This is what stops a
 *   never-settling renderOne (inflight stuck above zero) making the run
 *   immortal — see RUN_HEARTBEAT_MAX_MS.
 */
function startRunHeartbeat({
  runDocId,
  adIds = [],
  isWorking,
  models = null,
  intervalMs = runHeartbeatMs(),
  maxMs = RUN_HEARTBEAT_MAX_MS
} = {}) {
  const CampaignRun = models?.CampaignRun || require('../models/CampaignRun');
  const Ad          = models?.Ad          || require('../models/Ad');

  const openedAt = Date.now();
  let stopped = false;
  let expired = false;
  let beats   = 0;
  let idle    = 0;

  // LEADING BEAT. Without this, `lastHeartbeatAt` stays null for the whole
  // first `intervalMs` (up to 60s) after real work starts — and a run whose
  // claimed work settles inside that window (a short batch, or a process
  // that dies moments after claim) can show `lastHeartbeatAt: null` for its
  // ENTIRE life even though it was genuinely alive the whole time. Gated by
  // the SAME `isWorking()` check the interval uses below, so this cannot
  // beat a run with nothing in flight — it only moves the FIRST honest beat
  // from "one tick from now" to "right now".
  let leadingWorking = false;
  try {
    leadingWorking = typeof isWorking === 'function' ? !!isWorking() : false;
  } catch {
    leadingWorking = false;
  }
  if (leadingWorking) {
    beats += 1;
    heartbeatOnce({ CampaignRun, Ad, runDocId, adIds, now: new Date() }).catch(() => {});
  } else {
    idle += 1;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    // LIFETIME CAP FIRST, before the work gate — a wedged loop reports
    // isWorking() === true forever, so checking work first would never reach
    // this. See RUN_HEARTBEAT_MAX_MS.
    if (Date.now() - openedAt > maxMs) {
      expired = true;
      stopped = true;
      clearInterval(timer);
      return;
    }
    let working = false;
    try {
      // A throwing isWorking() reads as "not working": never beat on a
      // signal we could not evaluate, and never throw into the timer.
      working = typeof isWorking === 'function' ? !!isWorking() : false;
    } catch {
      working = false;
    }
    if (!working) { idle += 1; return; }
    beats += 1;
    heartbeatOnce({ CampaignRun, Ad, runDocId, adIds, now: new Date() }).catch(() => {});
  }, intervalMs);

  // Never hold the process open on a heartbeat. Same as the Ad beat and the
  // progressService beat.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    intervalMs,
    maxMs,
    get beats()   { return beats; },
    get idle()    { return idle; },
    get expired() { return expired; },
    get stopped() { return stopped; },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}

module.exports = {
  HEARTBEAT_CAP_MS,
  HEARTBEAT_FLOOR_MS,
  MIN_BEATS_PER_WINDOW,
  RUN_HEARTBEAT_MAX_MS,
  runHeartbeatMs,
  buildRunHeartbeatFilter,
  buildRunHeartbeatUpdate,
  buildClaimedAdHeartbeatFilter,
  buildClaimedAdHeartbeatUpdate,
  heartbeatOnce,
  startRunHeartbeat
};
