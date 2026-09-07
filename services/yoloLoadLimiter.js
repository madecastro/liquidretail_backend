'use strict';
//
// Process-wide catalog YOLO bound + circuit breaker.
//
// Used ONLY by catalog YOLO processQueue and yoloBackfillTick.
// DetectRun / UGC `/detect` must NOT go through this semaphore — that
// would serialize live detect behind a 9k-product catalog drain.
//
// Circuit is in-memory: empty on boot → try YOLO again immediately
// (owner 2026-09-06). Per-brand backoff lives on Brand and survives deploys.

const alerts = require('./alertService');
const yoloConcurrencyWindow = require('./yoloConcurrencyWindow');

function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// LIMIT is no longer a one-time value computed at require-time — the
// nightly boost (services/yoloConcurrencyWindow.js) must reflect the
// CURRENT wall-clock instant on every check, not whatever was true when
// this module first loaded. `LIMIT_OVERRIDE` is a TEST-ONLY pin (set via
// __test.reset({limit})), which every existing verify* harness relies on
// for deterministic, time-of-day-independent assertions; production code
// never sets it, so production always resolves through the live window
// resolver. `effectiveLimit()` — not a raw variable — is what acquire(),
// wakeNext() and getLimit() must all read.
let LIMIT_OVERRIDE = null;

// ── ADVERSARIAL REVIEW FIX #4 — CORRECTED 2026-09-07 (owner directive) ─────
// The breaker must not let a higher window concurrency dispatch a full
// extra wave before it can react to a fully-down microservice — that part
// of the finding is real. But the FIRST cut of this fix (binding
// effectiveLimit() to `Math.min(windowLimit, THRESHOLD)`, see git history)
// was REJECTED by the owner and reverted: with this repo's shipped defaults
// (THRESHOLD=5 < base=6 < night=9), that bound collapsed BOTH day and night
// dispatch to 5 — regressing today's real daytime throughput 6→5 and
// zeroing out the entire point of the nightly boost (9 collapses to 5 too,
// so day and night become identical). Do not reintroduce a THRESHOLD bound
// here; that trade-off was explicitly declined.
//
// Corrected approach (owner directive, 2026-09-07): leave the concurrency
// ceiling alone — effectiveLimit() below is back to the plain window value,
// so steady-state concurrency (day 6, boosted night 9) is exactly what the
// nightly-boost feature intends, unaffected while the YOLO microservice is
// healthy. Rely instead on catalogYoloDetectionService.js's dispatch pump
// re-checking isOpen() before EVERY individual dispatch, not just once when
// a wave starts — that check already existed in processQueue()'s pump()
// before this fix was ever attempted (it predates the nightly-boost work
// entirely), and pump() is re-invoked from its own per-request `.finally()`
// handler after EVERY completion, success or failure. So the instant the
// breaker actually trips (mid-wave — e.g. after the THRESHOLD'th consecutive
// transient failure lands), no further REPLACEMENT dispatch is ever issued:
// the next time pump() re-enters its while-loop, isOpen() reads true and it
// stops immediately, regardless of how many slots the window concurrency
// nominally allows.
//
// What this does NOT close to zero, and that is an accepted, bounded
// trade-off rather than an oversight: pump()'s INITIAL burst for a wave —
// up to getLimit() items — still dispatches synchronously, in one JS turn,
// before any single one of those requests can possibly have completed (a
// doomed request against a down service still costs a real ~120s client
// timeout before it can report failure). isOpen() cannot turn true until a
// completion actually lands, so every iteration of that FIRST burst sees the
// SAME pre-outage isOpen()===false — a higher window concurrency still
// dispatches a proportionally bigger initial burst than a lower one would.
//
// ── WHAT ACTUALLY BOUNDS THIS, CORRECTED (adversarial review round 2,
// 2026-09-07) — this PR did not build the bound below and does not change
// it; it only had to verify the bound still holds at a higher night value.
// The excess is kept small by TWO mechanisms that PREDATE the nightly-boost
// feature entirely and that this PR neither created nor meaningfully
// changed: (1) pump()'s per-dispatch isOpen() check
// (services/catalogYoloDetectionService.js), re-evaluated on every re-entry
// — i.e. before every individual dispatch, not merely once when a wave
// starts, because pump() is re-invoked from each request's own
// `.finally()` handler after every completion; and (2) that same pump
// loop's `.then()` result handler, which already halts further dispatch the
// instant THIS run's own transient outcome trips the breaker (or the
// breaker is found already open at acquire-time). Both shipped in this
// repo's pre-existing breaker (PR #408, before this feature existed) and
// are not "fighting" the rejected THRESHOLD-cap idea above, nor is removing
// that idea what "enabled" this to work — they were already sufficient on
// their own. Measured (scripts/verifyYoloNightlyConcurrency.js section M):
// at this repo's default settings the bound is day 10 / night 13 doomed
// dispatches, and that bound is IDENTICAL with or without the rejected
// THRESHOLD-cap idea ever having existed — NOT the unbounded "outruns the
// whole catalog" failure mode a dispatcher with no per-dispatch check at
// all would have (which would keep replacing failed slots with new doomed
// work until the entire target list drained through the breaker), and NOT
// reduced to an exact zero delta the way the rejected THRESHOLD-wide bound
// would have. The stable invariant across catalog size and across
// CATALOG_YOLO_BREAKER_THRESHOLD values is an ABSOLUTE count, not a
// percentage: exactly (nightLimit - dayLimit) extra doomed dispatches (3 at
// today's defaults, 9-6) — see section M13.
//
// This is also NOT a one-time event, an earlier draft of this comment's
// claim. It recurs every time the breaker re-opens on a fresh run of
// consecutive transient failures — once per COOLDOWN_MS cycle (default 30
// min): the breaker opens, blocks new dispatch for the cooldown, a
// subsequent pump() retries once it lapses, and can immediately re-trip on
// a microservice that is still down. A service genuinely down for a full
// 5-hour weekend boost window can see on the order of ten such cycles, each
// paying the same small excess again — not "once at the start of the
// outage".
// LIMIT_OVERRIDE (test-only) is unaffected by any of this — a harness
// pinning an exact limit for deterministic testing gets exactly that value.
function effectiveLimit(instant) {
  if (LIMIT_OVERRIDE != null) return LIMIT_OVERRIDE;
  return yoloConcurrencyWindow.currentYoloConcurrency(instant);
}

let THRESHOLD = parsePositiveInt(process.env.CATALOG_YOLO_BREAKER_THRESHOLD, 5);
let COOLDOWN_MS = parsePositiveInt(process.env.CATALOG_YOLO_BREAKER_COOLDOWN_MS, 1_800_000);
// Supplementary trip condition (2026-09-06) — an ADDITION alongside
// THRESHOLD, never a replacement or a retune of it (THRESHOLD's default and
// env name are untouched). A run/batch whose own target count is smaller
// than THRESHOLD can never accumulate enough CONSECUTIVE transient failures
// to cross it, however badly it fails — see tripOnFullRunFailure below.
// MIN_RUN_SAMPLE is the smallest sample that alternate path will act on:
// big enough that one unlucky product cannot trip it alone, small enough to
// still catch a brand whose whole gap-fill run is 1..THRESHOLD-1 products,
// all genuinely failing.
let MIN_RUN_SAMPLE = parsePositiveInt(process.env.CATALOG_YOLO_BREAKER_MIN_RUN_SAMPLE, 3);

let occupancy = 0;
const waiters = [];

let consecutiveTransient = 0;
let openUntil = 0; // epoch ms
let lastCircuitAlertAt = 0;

// `instant` is optional and TEST-ONLY (lets a harness ask "what would the
// limit be at this specific moment" without waiting for real wall-clock
// time or mocking Date.now() globally). Every production call site keeps
// calling getLimit() with zero arguments, unchanged.
function getLimit(instant) { return effectiveLimit(instant); }
function occupancyNow() { return occupancy; }
function consecutiveTransientNow() { return consecutiveTransient; }
function cooldownMs() { return COOLDOWN_MS; }
function threshold() { return THRESHOLD; }
function minRunSample() { return MIN_RUN_SAMPLE; }

function isOpen() {
  return Date.now() < openUntil;
}

function wakeNext() {
  if (!waiters.length) return;
  if (occupancy >= effectiveLimit()) return;
  const next = waiters.shift();
  occupancy++;
  next();
}

async function acquire() {
  if (occupancy < effectiveLimit()) {
    occupancy++;
    return;
  }
  await new Promise((resolve) => { waiters.push(resolve); });
}

function release() {
  occupancy = Math.max(0, occupancy - 1);
  wakeNext();
}

// Whole-batch kinds that trip the catalog breaker. Broader than
// yoloService.isTransientYoloError (conn-only): an HTTP 5xx from an
// overloaded/down microservice is a catalog-wide outage, not a
// per-image defect.
function isTransientForBreaker(kind) {
  if (!kind) return false;
  const k = String(kind);
  if (k === 'client-timeout' || k === 'conn-reset' || k === 'conn-timeout') return true;
  // Setup failures (microservice fully down / DNS). yoloKind is
  // String(err.code).toLowerCase() → 'econnrefused' / 'enotfound'.
  if (k === 'econnrefused' || k === 'enotfound') return true;
  if (/^http-5\d\d$/.test(k)) return true;
  // 'unknown' is NOT transient: unclassified is more likely a bug or
  // 4xx than a down service. Opening the breaker on it would pause
  // catalog detection on a single weird error.
  return false;
}

function alertCircuitOpen({ brandId, remaining, consecutive } = {}) {
  const now = Date.now();
  // Cooldown-gated so a 30-minute open window does not re-page every
  // tick (ALERT_DEDUPE_WINDOW_MIN is 15m — shorter than the breaker).
  if (lastCircuitAlertAt && now - lastCircuitAlertAt < COOLDOWN_MS) return;
  lastCircuitAlertAt = now;
  const backoffMin = Math.round(COOLDOWN_MS / 60000);
  alerts.notifyAsync({
    level: 'error',
    title: 'YOLO microservice degraded — catalog detection paused',
    key: 'yolo:circuit-open',
    fields: {
      brand: String(brandId || '-'),
      'consecutive transients': consecutive == null ? consecutiveTransient : consecutive,
      'remaining targets': remaining == null ? '-' : remaining,
      'backoff applied': `${backoffMin}m`,
      'operator action': 'YOLO microservice degraded; catalog detection paused; resumes automatically after cooldown'
    },
    detail: 'YOLO microservice degraded; catalog detection paused; resumes automatically after cooldown'
  });
}

// Shared by both trip paths below — pure side effect (open + alert), no
// decision logic of its own. Factored out so tripOnFullRunFailure's
// alternate path opens the circuit identically (same cooldown, same
// dedupe-gated alert) rather than re-implementing it.
function openCircuit({ brandId, remaining, consecutive } = {}) {
  openUntil = Date.now() + COOLDOWN_MS;
  alertCircuitOpen({ brandId, remaining, consecutive: consecutive == null ? consecutiveTransient : consecutive });
}

function recordOutcome({ transient, brandId, remaining } = {}) {
  if (!transient) {
    consecutiveTransient = 0;
    return { opened: false };
  }
  consecutiveTransient += 1;
  if (consecutiveTransient >= THRESHOLD && !isOpen()) {
    openCircuit({ brandId, remaining, consecutive: consecutiveTransient });
    return { opened: true };
  }
  return { opened: isOpen() };
}

// Supplementary trip condition — an ADDITION alongside recordOutcome's own
// consecutive-count check above, not a replacement. recordOutcome's
// consecutiveTransient is process-wide and shared across every concurrent
// catalog-YOLO chain (worker.js's yoloBackfillTick included) BY DESIGN — the
// breaker protects the whole subsystem, not one brand's run — so it cannot
// by itself answer "did THIS ONE run/batch fail 100%". That question can
// only be answered by the CALLER, which alone can see a single run's own
// tally of attempted-vs-transient-failed outcomes (catalogYoloDetectionService
// .runYoloDetectionOnTargets wraps its worker to build exactly that tally,
// scoped to runs whose own target count is already below THRESHOLD — see
// its header comment for why only those runs need this at all).
//
// Requires ALL of the run's own attempts to be transient failures — a single
// genuine success (or a definitive non-transient failure) makes a run
// permanently ineligible here, the same "only a positive-or-neutral outcome
// changes the verdict" split used for the no-op fix in
// catalogYoloDetectionService.js (a real success is the ONLY thing that
// should ever indicate this run's own work is fine) — and at least
// MIN_RUN_SAMPLE of them, so one unlucky product cannot trip it alone.
// No-op outcomes (nothing attempted) must never be included in the caller's
// tally passed here — same reasoning as recordOutcome's own no-op exclusion.
// Known accepted residuals (adversarial review, 2026-09-06), documented
// rather than "fixed" because each fix would trade one problem for a worse
// one:
// - The alert's "consecutive transients" field reads the SHARED counter at
//   the instant this trip fires, which is captured before the triggering
//   product's own recordOutcome call (in processQueue's .then, later in the
//   same tick) has incremented it — so it can under-report the true trigger
//   count by one, or read 0 at production concurrency if other chains reset
//   it in between. Display-only: nothing keys off this field, no dedup, no
//   money-relevant branch.
// - Raising CATALOG_YOLO_BREAKER_THRESHOLD makes mid-size runs (targets
//   between the old and new THRESHOLD) MORE likely to trip via this path,
//   not less, because more runs now qualify as "below THRESHOLD". Setting
//   MIN_RUN_SAMPLE >= THRESHOLD makes this whole path permanently inert
//   (no run can ever be both below THRESHOLD and at/above MIN_RUN_SAMPLE)
//   with no error — a silent misconfiguration, not a crash.
function tripOnFullRunFailure({ attempted, transientFailures, brandId, remaining } = {}) {
  if (isOpen()) return { opened: true };
  if (!attempted || attempted < MIN_RUN_SAMPLE) return { opened: false };
  if (transientFailures !== attempted) return { opened: false };
  openCircuit({ brandId, remaining, consecutive: consecutiveTransient });
  return { opened: true };
}

function resetForTest(opts = {}) {
  occupancy = 0;
  waiters.splice(0, waiters.length);
  consecutiveTransient = 0;
  openUntil = 0;
  lastCircuitAlertAt = 0;
  if (opts.limit != null) LIMIT_OVERRIDE = Math.max(1, Number(opts.limit) || LIMIT_OVERRIDE || 1);
  if (opts.threshold != null) THRESHOLD = Math.max(1, Number(opts.threshold) || THRESHOLD);
  if (opts.cooldownMs != null) COOLDOWN_MS = Math.max(1, Number(opts.cooldownMs) || COOLDOWN_MS);
  if (opts.minRunSample != null) MIN_RUN_SAMPLE = Math.max(1, Number(opts.minRunSample) || MIN_RUN_SAMPLE);
}

module.exports = {
  acquire,
  release,
  isOpen,
  recordOutcome,
  tripOnFullRunFailure,
  occupancyNow,
  consecutiveTransientNow,
  getLimit,
  cooldownMs,
  threshold,
  minRunSample,
  isTransientForBreaker,
  alertCircuitOpen,
  __test: {
    reset: resetForTest,
    get openUntil() { return openUntil; },
    setOpenUntil(ms) { openUntil = ms; },
    get waiters() { return waiters.length; },
    // Clears the test-only LIMIT pin so getLimit()/acquire() fall back to
    // yoloConcurrencyWindow's live, time-of-day-dependent resolution —
    // needed by harnesses that specifically want to exercise the nightly
    // boost (resetForTest({limit}) would otherwise shadow it forever).
    clearLimitOverride() { LIMIT_OVERRIDE = null; }
  }
};
