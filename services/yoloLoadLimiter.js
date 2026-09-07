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

function effectiveLimit(instant) {
  return LIMIT_OVERRIDE != null ? LIMIT_OVERRIDE : yoloConcurrencyWindow.currentYoloConcurrency(instant);
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
