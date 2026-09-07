#!/usr/bin/env node
'use strict';
//
// verifyYoloNightlyConcurrency — offline, no DB/network/keys. Pins the
// nightly catalog-YOLO concurrency boost (services/yoloConcurrencyWindow.js)
// and, above all, the property that made this feature dangerous to build:
// yoloLoadLimiter.js's process-wide semaphore and
// catalogYoloDetectionService.js's dispatch-loop "courtesy cap" MUST
// resolve to the IDENTICAL concurrency value at every instant, because
// they used to read CATALOG_YOLO_CONCURRENCY independently and only
// agreed by coincidence (see yoloConcurrencyWindow.js's header).
//
// Windows under test (Pacific time, owner-specified):
//   Weeknights (Mon-Fri mornings):        [01:00, 04:00) PT
//   Weekend nights (Sat & Sun mornings):  [00:00, 05:00) PT
//
// ── ADVERSARIAL REVIEW, 2026-09-06 — sections G/H/K/M/N/O/P below ─────────
// A real production incident (closed by already-merged PR #403 — catalog-
// YOLO overload against a rate-limited external microservice) prompted an
// adversarial review of this PR before it shipped. Fixes landed in
// production code (services/yoloConcurrencyWindow.js,
// services/yoloLoadLimiter.js, services/catalogYoloDetectionService.js) and
// this harness was extended/corrected to match:
//   #1 (BLOCKING) night concurrency is now DERIVED from base via
//      CATALOG_YOLO_NIGHT_MULTIPLIER, never an independent absolute value —
//      see section P.
//   #2 kill switch CATALOG_YOLO_NIGHT_BOOST_ENABLED (default true) — see
//      section O.
//   #3 (BLOCKING) 0/blank/negative multiplier fails SAFE to the documented
//      default, never silently inverts into a throttle — see section P.
//   #4 — CORRECTED 2026-09-07 (owner directive), read this before trusting
//      any older comment or commit message that describes it differently.
//      The FIRST cut of this fix made yoloLoadLimiter.getLimit() never
//      return more than CATALOG_YOLO_BREAKER_THRESHOLD, regardless of
//      window concurrency. That was REJECTED and reverted: with this
//      repo's shipped defaults (THRESHOLD=5 < base=6 < night=9), it
//      collapsed BOTH day and night dispatch to 5 — regressing today's real
//      daytime throughput 6→5 and defeating the entire point of the
//      nightly boost. getLimit() is back to the plain window value (see
//      section G4, corrected to match). The "doomed wave outruns the
//      breaker" concern is instead addressed by catalogYoloDetectionService
//      .js's pump() re-checking isOpen() before EVERY individual dispatch
//      (a check that in fact predates this whole feature) — which bounds,
//      but does NOT zero out, the excess doomed dispatches a higher window
//      concurrency causes during an outage. Section M is rewritten to
//      measure and pin the ACTUAL (bounded, non-zero) delta this leaves,
//      rather than asserting the now-false "zero delta" claim.
//   #6 there is now exactly ONE shared accessor
//      (`yoloLoadLimiter.getLimit()`) that BOTH the semaphore ceiling and
//      catalogYoloDetectionService.js's dispatch-loop cap call — replacing
//      "two independent calls to the same window resolver that happen to
//      agree" with "one function, structurally impossible to re-split
//      without an obviously duplicated implementation". Section K is
//      rewritten for the new call shape; section N adds a BEHAVIOURAL proof
//      (monkeypatch the shared function itself) on top of the structural
//      grep, per the review's own explicit ask ("not just a structural grep
//      for absent constants").
// Also fixed here (item 5 of the review, a harness-only defect): this
// file's own G3 check used to call `limiter.getLimit()` with NO explicit
// instant, silently depending on the ACTUAL wall-clock time the harness
// happened to run at (confirmed: fails if actually run inside a boost
// window). Every check below that asserts a concurrency value now passes
// an explicit fixed instant — never bare `Date.now()`.
//
// ── Why explicit UTC instants, not `new Date()` ────────────────────────────
// The host running this suite is not necessarily in Pacific time (this repo's
// own dev machine happens to be, which is exactly the kind of accident that
// hides a hardcoded-offset bug). Every fixture below is an explicit UTC
// instant (`Date.UTC(...)`), independently cross-checked against real
// Intl-resolved Pacific wall-clock output (see the comment above each block)
// so this file never depends on the process's local timezone.
//
// ── DST cross-check strategy ───────────────────────────────────────────────
// `ptWallClockToUtcMs` below is a SEPARATE, independently-written Pacific
// wall-clock -> UTC converter (2-3 pass Intl offset correction — the same
// technique services/scheduledSyncService.js's `zonedUtcMs` already uses in
// this repo for its own nightly-Pacific-window gate, reimplemented here
// rather than required directly so this offline harness never pulls in that
// file's Mongoose model requires). Building fixtures with the REVERSE
// direction from the module under test (which converts UTC -> Pacific parts
// directly via a single Intl.DateTimeFormat call) means a bug in one
// direction is unlikely to be masked by an identical bug in the other.
//
// ── Revert-proof, without editing files on disk ────────────────────────────
// Section H "breaks" the fix by using yoloLoadLimiter's OWN existing test
// hook (__test.reset({limit})) to pin the semaphore at the pre-feature
// static value while catalogYoloDetectionService's dispatch cap stays live
// and boosted — precisely reproducing "one knob boosted, one knob frozen"
// without hand-editing source. Section I then clears the pin and shows the
// real fix passes. This exercises the ACTUAL production acquire()/release()
// and processQueue() code paths, not a mock.

const path = require('path');

// Deterministic regardless of ambient shell env — set BEFORE requiring any
// production module (services/concurrency.js resolves its frozen `CONC`
// object once, at first require).
const SAVED_ENV = {
  CATALOG_YOLO_CONCURRENCY: process.env.CATALOG_YOLO_CONCURRENCY,
  CATALOG_YOLO_NIGHT_MULTIPLIER: process.env.CATALOG_YOLO_NIGHT_MULTIPLIER,
  CATALOG_YOLO_NIGHT_BOOST_ENABLED: process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED,
  CATALOG_YOLO_BREAKER_THRESHOLD: process.env.CATALOG_YOLO_BREAKER_THRESHOLD,
  CATALOG_YOLO_NIGHT_CONCURRENCY: process.env.CATALOG_YOLO_NIGHT_CONCURRENCY
};
process.env.CATALOG_YOLO_CONCURRENCY = '6';
process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = '1.5';
delete process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED; // exercise the documented default (true)
delete process.env.CATALOG_YOLO_BREAKER_THRESHOLD;   // exercise the documented default (5)
delete process.env.CATALOG_YOLO_NIGHT_CONCURRENCY;   // exercise the documented default (unset -> no retired-var warning at require time)

const ycw = require(path.join(__dirname, '..', 'services', 'yoloConcurrencyWindow'));
const limiter = require(path.join(__dirname, '..', 'services', 'yoloLoadLimiter'));
const detection = require(path.join(__dirname, '..', 'services', 'catalogYoloDetectionService'));
const { concurrency: CONC } = require(path.join(__dirname, '..', 'services', 'concurrency'));

let failures = 0;
let checks = 0;

function check(name, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ── Independent PT wall-clock -> UTC converter (see header) ────────────────
const PT_FULL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function pacificFullParts(ms) {
  const parts = PT_FULL_FORMATTER.formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}
function tzOffsetMs(ms) {
  const p = pacificFullParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - ms;
}
function ptWallClockToUtcMs(year, month, day, hour, minute, second) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = utcGuess;
  for (let i = 0; i < 3; i += 1) instant = utcGuess - tzOffsetMs(instant);
  return instant;
}

function withFakeNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  return Promise.resolve().then(fn).finally(() => { Date.now = realNow; });
}

function fakeProducts(n, prefix = 'fake') {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ _id: `${prefix}-${i}` });
  return out;
}

// Runs processQueue() with a worker that tracks peak concurrent EXECUTIONS
// (i.e. time actually spent holding yoloLoadLimiter's semaphore slot, the
// same window catalogYoloDetectionService's real pump() runs runOne() in) —
// this is what genuinely measures whether both concurrency knobs are in
// effect together, not just what got dispatched.
async function runPeakConcurrencyProbe(productCount, workerMs = 25) {
  let concurrent = 0;
  let peak = 0;
  const worker = async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, workerMs));
    concurrent--;
    return { detected: 1 };
  };
  const result = await detection.processQueue(fakeProducts(productCount), { worker });
  return { peak, result };
}

// Runs processQueue() against a worker simulating a FULLY DOWN microservice
// where every call fails INSTANTLY (no real completion-timing stagger at
// all — every dispatched request resolves within the same microtask
// cascade). This measures the purely-synchronous INITIAL BURST: with zero
// stagger, no replacement dispatch's own worker invocation ever actually
// runs before the breaker trips (see section M for why — it is refused at
// the `isOpen()` check inside the per-product IIFE before `runOne()` is
// ever called), so `dispatched` here equals getLimit() exactly, day or
// night. It does NOT reproduce the real-world "replacement dispatches also
// get through" amplification a genuinely staggered outage causes — that
// needs actual completion-timing spread, see runDoomedWaveProbeStaggered
// below.
async function runDoomedWaveProbe(productCount) {
  let dispatched = 0;
  const worker = async () => {
    dispatched++;
    return { failed: 1, transient: true, yoloKind: 'client-timeout' };
  };
  const result = await detection.processQueue(fakeProducts(productCount, 'down'), { worker });
  return { dispatched, result };
}

// Runs processQueue() against a worker simulating a FULLY DOWN microservice
// where every call fails after the SAME base latency but with a small,
// DETERMINISTIC stagger layered on top (dispatch index * staggerMs) — a
// real down-service call takes real wall-clock time (a ~120s client
// timeout) and concurrent in-flight calls do not all complete at the
// literal same instant, so their failures arrive as a genuine, ordered
// trickle rather than one synchronous batch. This is what actually
// reproduces the "replacement dispatch also gets through" amplification a
// higher window concurrency causes during an outage (measured — see
// section M): once dispatched, catalogYoloDetectionService.js's pump()
// re-checks isOpen() before each REPLACEMENT it issues as an earlier
// in-flight request completes, so a completion that lands before the
// breaker trips lets exactly one more doomed request through. No
// Math.random() — fully deterministic and reproducible across runs
// (confirmed by direct repeat measurement during this fix, not merely
// assumed).
async function runDoomedWaveProbeStaggered(productCount, baseMs, staggerMs) {
  let dispatched = 0;
  let dispatchIndex = 0;
  const worker = async () => {
    const myIndex = dispatchIndex++;
    dispatched++;
    await new Promise((r) => setTimeout(r, baseMs + myIndex * staggerMs));
    return { failed: 1, transient: true, yoloKind: 'client-timeout' };
  };
  const result = await detection.processQueue(fakeProducts(productCount, 'down'), { worker });
  return { dispatched, result };
}

async function main() {
  console.log('\n[A] Weeknight window [01:00, 04:00) PT — exact boundaries on a Tuesday');
  console.log('    (2026-09-08 is a Tuesday, PDT season)');
  {
    const before = ptWallClockToUtcMs(2026, 9, 8, 0, 59, 59);
    const atStart = ptWallClockToUtcMs(2026, 9, 8, 1, 0, 0);
    const insideLate = ptWallClockToUtcMs(2026, 9, 8, 3, 59, 59);
    const atEnd = ptWallClockToUtcMs(2026, 9, 8, 4, 0, 0);
    check('A1: 00:59:59 PT Tue is NOT boosted (one second before window opens)',
      ycw.isNightlyBoostWindow(before) === false);
    check('A2: 01:00:00 PT Tue IS boosted (window opens exactly on the hour)',
      ycw.isNightlyBoostWindow(atStart) === true);
    check('A3: 03:59:59 PT Tue IS boosted (last second inside the window)',
      ycw.isNightlyBoostWindow(insideLate) === true);
    check('A4: 04:00:00 PT Tue is NOT boosted (window is a half-open [.. ,04:00) )',
      ycw.isNightlyBoostWindow(atEnd) === false);
    check('A5: concurrency at 00:59:59 PT Tue is the BASE value (6)',
      ycw.currentYoloConcurrency(before) === 6, `got ${ycw.currentYoloConcurrency(before)}`);
    check('A6: concurrency at 01:00:00 PT Tue is the BOOSTED value (9)',
      ycw.currentYoloConcurrency(atStart) === 9, `got ${ycw.currentYoloConcurrency(atStart)}`);
  }

  console.log('\n[B] Weekend-night window [00:00, 05:00) PT — exact boundaries on a Saturday');
  console.log('    (2026-09-12 is a Saturday, PDT season)');
  {
    const atMidnight = ptWallClockToUtcMs(2026, 9, 12, 0, 0, 0);
    const insideLate = ptWallClockToUtcMs(2026, 9, 12, 4, 59, 59);
    const atEnd = ptWallClockToUtcMs(2026, 9, 12, 5, 0, 0);
    check('B1: 00:00:00 PT Sat IS boosted (window opens exactly at midnight)',
      ycw.isNightlyBoostWindow(atMidnight) === true);
    check('B2: 04:59:59 PT Sat IS boosted (last second inside the window)',
      ycw.isNightlyBoostWindow(insideLate) === true);
    check('B3: 05:00:00 PT Sat is NOT boosted (window is a half-open [.. ,05:00) )',
      ycw.isNightlyBoostWindow(atEnd) === false);
    check('B4: concurrency at 04:59:59 PT Sat is the BOOSTED value (9)',
      ycw.currentYoloConcurrency(insideLate) === 9, `got ${ycw.currentYoloConcurrency(insideLate)}`);
    check('B5: concurrency at 05:00:00 PT Sat is the BASE value (6)',
      ycw.currentYoloConcurrency(atEnd) === 6, `got ${ycw.currentYoloConcurrency(atEnd)}`);
  }

  console.log('\n[C] Sunday morning is ALSO the weekend window (owner: "Fri/Sat night" -> Sat AND Sun mornings)');
  console.log('    (2026-09-13 is a Sunday)');
  {
    const atMidnight = ptWallClockToUtcMs(2026, 9, 13, 0, 0, 0);
    const insideLate = ptWallClockToUtcMs(2026, 9, 13, 4, 59, 59);
    const atEnd = ptWallClockToUtcMs(2026, 9, 13, 5, 0, 0);
    check('C1: 00:00:00 PT Sun IS boosted', ycw.isNightlyBoostWindow(atMidnight) === true);
    check('C2: 04:59:59 PT Sun IS boosted', ycw.isNightlyBoostWindow(insideLate) === true);
    check('C3: 05:00:00 PT Sun is NOT boosted', ycw.isNightlyBoostWindow(atEnd) === false);
    // Sunday NIGHT (into Monday) reverts to the WEEKNIGHT window, not weekend.
    const sunEvening = ptWallClockToUtcMs(2026, 9, 13, 23, 0, 0);
    const monBoosted = ptWallClockToUtcMs(2026, 9, 14, 1, 30, 0);
    check('C4: 23:00:00 PT Sun is NOT boosted (Sunday evening, no window active)',
      ycw.isNightlyBoostWindow(sunEvening) === false);
    check('C5: 01:30:00 PT Mon (following Sun evening) IS boosted — weeknight window resumes',
      ycw.isNightlyBoostWindow(monBoosted) === true);
  }

  console.log('\n[D] THE MIDNIGHT FRIDAY-INTO-SATURDAY TRANSITION');
  console.log('    "Friday/Sat night" colloquially rolls the calendar to Saturday at');
  console.log('    midnight — the boost must activate AT that rollover, keyed on the');
  console.log('    calendar day the instant falls ON (Saturday), never on "is it still');
  console.log('    Friday". (2026-09-11 is a Friday, 2026-09-12 the following Saturday.)');
  {
    const fridayLateEvening = ptWallClockToUtcMs(2026, 9, 11, 23, 59, 59);
    const saturdayMidnight = ptWallClockToUtcMs(2026, 9, 12, 0, 0, 0);
    check('D1: 23:59:59 PT Fri (one second before midnight) is NOT boosted',
      ycw.isNightlyBoostWindow(fridayLateEvening) === false,
      'Friday\'s own weeknight window [01:00,04:00) is long over by 23:59:59');
    check('D2: 00:00:00 PT Sat (one second later, the same physical midnight rollover) IS boosted',
      ycw.isNightlyBoostWindow(saturdayMidnight) === true,
      'the weekend window activates the instant the PT calendar day becomes Saturday — no "still Friday" grace needed');
    check('D3: the two instants above are exactly 1 second apart in real time',
      saturdayMidnight - fridayLateEvening === 1000,
      `delta=${saturdayMidnight - fridayLateEvening}ms`);
  }

  console.log('\n[E] Full-week matrix — every Pacific calendar day resolves to its correct window shape');
  {
    // 2026-09-07..13 is Mon..Sun (one full week), PDT season throughout —
    // isolates the DAY-OF-WEEK selection logic from any DST concern.
    const days = [
      { date: [2026, 9, 7], label: 'Mon', kind: 'weeknight' },
      { date: [2026, 9, 8], label: 'Tue', kind: 'weeknight' },
      { date: [2026, 9, 9], label: 'Wed', kind: 'weeknight' },
      { date: [2026, 9, 10], label: 'Thu', kind: 'weeknight' },
      { date: [2026, 9, 11], label: 'Fri', kind: 'weeknight' },
      { date: [2026, 9, 12], label: 'Sat', kind: 'weekend' },
      { date: [2026, 9, 13], label: 'Sun', kind: 'weekend' }
    ];
    for (const d of days) {
      const [y, m, day] = d.date;
      const at0030 = ycw.isNightlyBoostWindow(ptWallClockToUtcMs(y, m, day, 0, 30, 0));
      const at0130 = ycw.isNightlyBoostWindow(ptWallClockToUtcMs(y, m, day, 1, 30, 0));
      const at0430 = ycw.isNightlyBoostWindow(ptWallClockToUtcMs(y, m, day, 4, 30, 0));
      if (d.kind === 'weeknight') {
        check(`E-${d.label}: 00:30 PT is NOT boosted (weeknight window starts at 01:00)`, at0030 === false);
        check(`E-${d.label}: 01:30 PT IS boosted (inside weeknight window)`, at0130 === true);
        check(`E-${d.label}: 04:30 PT is NOT boosted (weeknight window ends at 04:00)`, at0430 === false);
      } else {
        check(`E-${d.label}: 00:30 PT IS boosted (weekend window starts at midnight)`, at0030 === true);
        check(`E-${d.label}: 01:30 PT IS boosted (inside weekend window)`, at0130 === true);
        check(`E-${d.label}: 04:30 PT IS boosted (weekend window ends at 05:00)`, at0430 === true);
      }
    }
  }

  console.log('\n[F] DST transitions — DST-aware, not a hardcoded UTC offset');
  {
    // (F1/F2) Spring-forward, Sun 2026-03-08: 01:59:00 PST jumps straight to
    // 03:00:00 PDT. Confirmed live against this machine's Intl/ICU data
    // (see the session's own probe); both instants verified independently.
    const springBefore = Date.UTC(2026, 2, 8, 9, 59, 0);  // 01:59:00 PST (UTC-8)
    const springAfter = Date.UTC(2026, 2, 8, 10, 1, 0);   // 03:01:00 PDT (UTC-7)
    check('F1: 01:59:00 PST on spring-forward Sunday IS boosted (weekend window)',
      ycw.isNightlyBoostWindow(springBefore) === true);
    check('F2: 03:01:00 PDT on spring-forward Sunday (one hour later on the clock, two',
      ycw.isNightlyBoostWindow(springAfter) === true,
      'minutes later in UTC — the skipped hour) is STILL boosted (still inside [00:00,05:00))');

    // (F3/F4) Fall-back, Sun 2026-11-01: 01:59:00 PDT falls back to 01:00:00
    // PST — 01:00-01:59 occurs TWICE. Both instances must read identically
    // (both inside the weekend window regardless of which pass).
    const fallFirstPass = Date.UTC(2026, 10, 1, 8, 30, 0);  // 01:30:00 PDT (UTC-7, first occurrence)
    const fallSecondPass = Date.UTC(2026, 10, 1, 9, 30, 0); // 01:30:00 PST (UTC-8, second occurrence)
    check('F3: 01:30 on fall-back Sunday, FIRST pass (still PDT) IS boosted',
      ycw.isNightlyBoostWindow(fallFirstPass) === true);
    check('F4: 01:30 on fall-back Sunday, SECOND pass (now PST, repeated wall-clock hour) IS boosted',
      ycw.isNightlyBoostWindow(fallSecondPass) === true);
    const fallEnd = Date.UTC(2026, 10, 1, 13, 0, 0); // 05:00:00 PST
    check('F5: 05:00:00 PST on fall-back Sunday is NOT boosted (window end unaffected by the fold)',
      ycw.isNightlyBoostWindow(fallEnd) === false);

    // (F6/F7) THE test that a fixed-UTC-offset implementation cannot pass:
    // pick a boundary instant in each season where the WRONG season's fixed
    // offset would shift the computed Pacific hour across the window edge.
    // Weeknight end-boundary, PDT season (July, UTC-7): 04:00:00 PDT is
    // genuinely NOT boosted. A hardcoded PST(-8) reading of the SAME UTC
    // instant would compute 03:00 -> incorrectly INSIDE the window.
    const julBoundary = Date.UTC(2026, 6, 7, 11, 0, 0); // Tue 2026-07-07 04:00:00 PDT
    check('F6: 04:00:00 PDT (July, a weekday) is NOT boosted — a hardcoded PST offset would wrongly say boosted',
      ycw.isNightlyBoostWindow(julBoundary) === false);
    // Weeknight start-boundary, PST season (January, UTC-8): 00:59:59 PST is
    // genuinely NOT boosted. A hardcoded PDT(-7) reading of the SAME UTC
    // instant would compute 01:59:59 -> incorrectly INSIDE the window.
    const janBoundary = Date.UTC(2026, 0, 6, 8, 59, 59); // Tue 2026-01-06 00:59:59 PST
    check('F7: 00:59:59 PST (January, a weekday) is NOT boosted — a hardcoded PDT offset would wrongly say boosted',
      ycw.isNightlyBoostWindow(janBoundary) === false);
  }

  console.log('\n[G] Outside any window, WINDOW-RESOLUTION behaviour is byte-for-byte unchanged from the pre-feature default');
  console.log('    (getLimit() is NOT bounded by the breaker threshold — that first cut of fix #4 was rejected by the owner, see [M] —');
  console.log('    so getLimit() equals the raw window value regardless of THRESHOLD; G4 below pins that independence explicitly)');
  {
    // Re-derive the ORIGINAL (pre-this-feature) static formula independently
    // in THIS file, rather than calling into yoloConcurrencyWindow's own
    // baseConcurrency() — a tautological check that only proves the new
    // module agrees with itself would miss a real regression here.
    function originalStaticFormula() {
      const n = parseInt(process.env.CATALOG_YOLO_CONCURRENCY, 10);
      return Number.isFinite(n) && n > 0 ? n : (CONC.CATALOG_YOLO_CONCURRENCY || 6);
    }
    const outside = ptWallClockToUtcMs(2026, 9, 8, 12, 0, 0); // Tue noon PT
    check('G1: currentYoloConcurrency() outside any window equals the original static formula',
      ycw.currentYoloConcurrency(outside) === originalStaticFormula(),
      `resolver=${ycw.currentYoloConcurrency(outside)} original=${originalStaticFormula()}`);
    check('G2: that value is 6 given this repo\'s committed config/defaults.env default',
      ycw.currentYoloConcurrency(outside) === 6);
    // ITEM 5 FIX: explicit fixed instant, never bare Date.now() / a zero-arg
    // call relying on real "now".
    limiter.__test.clearLimitOverride();
    limiter.__test.reset({ threshold: 50, cooldownMs: 1_800_000 });
    check('G3: yoloLoadLimiter.getLimit(instant) (explicit fixed instant, no test override, threshold raised out of the way) matches the base value',
      limiter.getLimit(outside) === ycw.baseConcurrency(),
      `getLimit=${limiter.getLimit(outside)} baseConcurrency()=${ycw.baseConcurrency()}`);
    // G4 — CORRECTED 2026-09-07: with the SHIPPED DEFAULT threshold (5)
    // restored, getLimit() must STILL equal the raw base value (6), NOT a
    // threshold-bound 5. The first cut of fix #4 asserted the opposite here
    // (min(base,5)=5) — that was the rejected behaviour; getLimit() is
    // independent of THRESHOLD entirely now. See section [M] for the actual
    // (corrected) fix #4 proof.
    check('G4 (fix #4, CORRECTED): with the SHIPPED DEFAULT threshold (5), getLimit() outside any window is still the raw base (6) — NOT min(base,5) — THRESHOLD no longer bounds dispatch concurrency',
      limiter.getLimit(outside) === 6, `getLimit=${limiter.getLimit(outside)}`);
  }

  console.log('\n[H] *** THE TWO-KNOBS-AGREE PROPERTY *** — yoloLoadLimiter and');
  console.log('    catalogYoloDetectionService must resolve to the IDENTICAL concurrency');
  console.log('    value at the same instant. This is the single most important check in');
  console.log('    this file — it is the exact failure mode the shared resolver exists to');
  console.log('    prevent (see services/yoloConcurrencyWindow.js header).');
  {
    // Threshold value is irrelevant to getLimit() post-fix-#4-correction
    // (kept raised here only for consistency with [G3]/[I]/[J]'s
    // pre-existing convention — it no longer changes anything getLimit()
    // returns). Section [M] is a separate concern: how many doomed
    // dispatches fire during an actual outage before the breaker halts them.
    limiter.__test.reset({ threshold: 50, cooldownMs: 1_800_000 });
    limiter.__test.clearLimitOverride();
    const instants = [
      { label: 'weeknight-boosted (Tue 01:30 PT)', ms: ptWallClockToUtcMs(2026, 9, 8, 1, 30, 0), expect: 9 },
      { label: 'weeknight-base (Tue noon PT)', ms: ptWallClockToUtcMs(2026, 9, 8, 12, 0, 0), expect: 6 },
      { label: 'weekend-boosted (Sat 02:00 PT)', ms: ptWallClockToUtcMs(2026, 9, 12, 2, 0, 0), expect: 9 },
      { label: 'weekend-base (Sun 10:00 PT)', ms: ptWallClockToUtcMs(2026, 9, 13, 10, 0, 0), expect: 6 },
      { label: 'DST spring-forward morning (Sun 2026-03-08 01:30 PT)', ms: ptWallClockToUtcMs(2026, 3, 8, 1, 30, 0), expect: 9 }
    ];
    for (const { label, ms, expect } of instants) {
      const resolverValue = ycw.currentYoloConcurrency(ms);
      const limiterValue = limiter.getLimit(ms);
      check(`H(${label}): resolver returns the expected value (${expect})`,
        resolverValue === expect, `got ${resolverValue}`);
      check(`H(${label}): yoloLoadLimiter.getLimit(instant) === yoloConcurrencyWindow.currentYoloConcurrency(instant)`,
        limiterValue === resolverValue, `getLimit=${limiterValue} resolver=${resolverValue}`);
    }
  }

  console.log('\n[I] Two-knobs-agree — REAL INTEGRATION test through the actual acquire()/release()');
  console.log('    semaphore AND the actual processQueue() dispatch loop (not a mock)');
  {
    limiter.__test.reset({ threshold: 50, cooldownMs: 1_800_000 }); // clear breaker state only, no limit key
    limiter.__test.clearLimitOverride();
    const boostedInstant = ptWallClockToUtcMs(2026, 9, 8, 1, 30, 0); // weeknight-boosted
    const baseInstant = ptWallClockToUtcMs(2026, 9, 8, 12, 0, 0);    // weeknight-base

    const boosted = await withFakeNow(boostedInstant, () => runPeakConcurrencyProbe(20));
    check('I1: during a boosted window, peak REAL concurrent executions reaches the boosted value (9)',
      boosted.peak === 9, `peak=${boosted.peak}`);
    check('I2: all 20 fake products completed (none aborted — breaker never opened)',
      boosted.result.processed === 20 && boosted.result.aborted === false,
      `processed=${boosted.result.processed} aborted=${boosted.result.aborted}`);

    const base = await withFakeNow(baseInstant, () => runPeakConcurrencyProbe(20));
    check('I3: outside any window, peak REAL concurrent executions stays at the base value (6) — unchanged from today',
      base.peak === 6, `peak=${base.peak}`);
  }

  console.log('\n[J] REVERT-PROOF: pin the semaphore at the OLD static value (6) while the');
  console.log('    dispatch cap stays live-boosted (9) — reproduces "two knobs disagree"');
  {
    const boostedInstant = ptWallClockToUtcMs(2026, 9, 8, 1, 30, 0);
    // Simulate the pre-fix bug: yoloLoadLimiter's semaphore frozen at the
    // historical static default, exactly as if it still read
    // CATALOG_YOLO_CONCURRENCY once at require-time and never again — while
    // catalogYoloDetectionService's dispatch loop keeps calling the live,
    // boosted resolver. This uses yoloLoadLimiter's OWN pre-existing test
    // hook (the same one every other verify*.js harness in this repo already
    // relies on) rather than editing any file on disk.
    limiter.__test.reset({ limit: 6, threshold: 50, cooldownMs: 1_800_000 });
    const broken = await withFakeNow(boostedInstant, () => runPeakConcurrencyProbe(20));
    const resolverSaysDuringBreak = ycw.currentYoloConcurrency(boostedInstant);
    check('J1: with the semaphore pinned at the stale value, real peak concurrency is stuck at 6 (the OLD value)',
      broken.peak === 6, `peak=${broken.peak}`);
    check('J2: THE TWO KNOBS NOW DISAGREE — dispatch-loop resolver says 9 but real peak concurrency is 6',
      broken.peak !== resolverSaysDuringBreak,
      `peak=${broken.peak} resolver=${resolverSaysDuringBreak} (expected these to be UNEQUAL — that is the bug this file exists to catch)`);

    // Now clear the pin — the real fix — and confirm agreement is restored.
    limiter.__test.clearLimitOverride();
    const fixed = await withFakeNow(boostedInstant, () => runPeakConcurrencyProbe(20));
    check('J3: after clearing the override (the real fix), real peak concurrency reaches the boosted value (9) again',
      fixed.peak === 9, `peak=${fixed.peak}`);
    check('J4: the two knobs agree again — real peak concurrency matches the resolver',
      fixed.peak === ycw.currentYoloConcurrency(boostedInstant));
  }

  console.log('\n[K] Structural — both files route the concurrency DECISION through the ONE');
  console.log('    shared accessor, yoloLoadLimiter.getLimit() (revert-proof against a future re-split)');
  {
    const fs = require('fs');
    const limiterSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'yoloLoadLimiter.js'), 'utf8');
    const detectionSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'catalogYoloDetectionService.js'), 'utf8');
    check('K1: yoloLoadLimiter.js requires ./yoloConcurrencyWindow',
      /require\(\s*['"]\.\/yoloConcurrencyWindow['"]\s*\)/.test(limiterSrc));
    check('K2: yoloLoadLimiter.js calls yoloConcurrencyWindow.currentYoloConcurrency( inside effectiveLimit() — the ONLY place either file may read the window resolver directly',
      /yoloConcurrencyWindow\.currentYoloConcurrency\(/.test(limiterSrc));
    check('K3: catalogYoloDetectionService.js\'s dispatch-loop while-condition calls yoloLoadLimiter.getLimit(), NOT yoloConcurrencyWindow directly',
      /while\s*\([^)]*yoloLoadLimiter\.getLimit\(\)[^)]*\)/.test(detectionSrc));
    check('K3b: catalogYoloDetectionService.js\'s dispatch-loop while-condition does NOT call yoloConcurrencyWindow.currentYoloConcurrency( — a future re-split would fail this',
      !/while\s*\([^)]*yoloConcurrencyWindow\.currentYoloConcurrency\(\)[^)]*\)/.test(detectionSrc));
    check('K4: catalogYoloDetectionService.js\'s currentConcurrencyLabel() (used for logging + the label the pump loop is built around) reads yoloLoadLimiter.getLimit()',
      /function currentConcurrencyLabel\(\)\s*\{\s*return\s+yoloLoadLimiter\.getLimit\(\)/.test(detectionSrc));
    check('K5: neither file still has a bare, module-load-time-only `CONCURRENCY`/`LIMIT` constant reading CATALOG_YOLO_CONCURRENCY directly',
      !/^const CONCURRENCY = CONC\.CATALOG_YOLO_CONCURRENCY/m.test(detectionSrc)
      && !/^let LIMIT = parsePositiveInt\(process\.env\.CATALOG_YOLO_CONCURRENCY/m.test(limiterSrc));
  }

  console.log('\n[L] yoloService.js (live DetectRun / UGC /detect) is untouched — must NOT share this limiter or the window resolver');
  {
    const fs = require('fs');
    const yoloServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'yoloService.js'), 'utf8');
    check('L1: services/yoloService.js does not require yoloConcurrencyWindow',
      !/require\(\s*['"]\.\/yoloConcurrencyWindow['"]\s*\)/.test(yoloServiceSrc));
    check('L2: services/yoloService.js does not require yoloLoadLimiter',
      !/require\(\s*['"]\.\/yoloLoadLimiter['"]\s*\)/.test(yoloServiceSrc));
  }

  console.log('\n[M] *** FIX #4, CORRECTED 2026-09-07 (owner directive) *** — do NOT bind');
  console.log('    dispatch concurrency to CATALOG_YOLO_BREAKER_THRESHOLD (that first cut');
  console.log('    regressed daytime throughput 6->5 and defeated the whole point of the night');
  console.log('    boost — REJECTED). getLimit() is independent of THRESHOLD; the breaker');
  console.log('    instead halts NEW dispatch mid-wave via the pump\'s pre-existing per-dispatch');
  console.log('    isOpen() check. This bounds — but does NOT zero out — the extra doomed');
  console.log('    dispatches a higher window concurrency causes during a real outage.');
  {
    limiter.__test.clearLimitOverride();

    // M1-M3: pure formula checks — getLimit() must NOT depend on THRESHOLD
    // at all any more (the rejected fix made it min(window, THRESHOLD)).
    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const boostedInstant = ptWallClockToUtcMs(2026, 9, 8, 1, 30, 0); // resolves to 9
    const baseInstant = ptWallClockToUtcMs(2026, 9, 8, 12, 0, 0);    // resolves to 6
    check('M1 (CORRECTED): getLimit() during a boosted window is the raw window value (9), NOT capped at THRESHOLD (5)',
      limiter.getLimit(boostedInstant) === 9, `getLimit=${limiter.getLimit(boostedInstant)}`);
    check('M2 (CORRECTED): getLimit() outside any window is the raw window value (6), NOT capped at THRESHOLD (5)',
      limiter.getLimit(baseInstant) === 6, `getLimit=${limiter.getLimit(baseInstant)}`);
    check('M3 (CORRECTED — the rejected fix\'s "whole point" was this equality; it must NOT hold any more): day and night dispatch ceilings are DIFFERENT again (9 vs 6) — the boost is real',
      limiter.getLimit(boostedInstant) !== limiter.getLimit(baseInstant));

    // M4-M5: THRESHOLD is now fully decoupled from getLimit() — changing it
    // (in either direction) must never move the dispatch ceiling.
    limiter.__test.reset({ threshold: 1, cooldownMs: 1_800_000 });
    check('M4 (decoupling proof): lowering THRESHOLD to 1 does not lower getLimit() during a boosted window — still 9',
      limiter.getLimit(boostedInstant) === 9, `getLimit=${limiter.getLimit(boostedInstant)}`);
    limiter.__test.reset({ threshold: 20, cooldownMs: 1_800_000 });
    check('M5 (decoupling proof): raising THRESHOLD to 20 does not raise getLimit() outside any window — still 6, not 20',
      limiter.getLimit(baseInstant) === 6, `getLimit=${limiter.getLimit(baseInstant)}`);

    // M6: LIMIT_OVERRIDE (test-only pin) still works exactly as before —
    // untouched by this correction.
    limiter.__test.reset({ limit: 8, threshold: 5, cooldownMs: 1_800_000 });
    check('M6: LIMIT_OVERRIDE still pins an exact value regardless of window or threshold (pinned 8, returns 8)',
      limiter.getLimit() === 8, `getLimit=${limiter.getLimit()}`);
    limiter.__test.clearLimitOverride();

    // M7 (STRUCTURAL, revert-proof): the rejected THRESHOLD-binding must not
    // quietly come back.
    {
      const fs = require('fs');
      const limiterSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'yoloLoadLimiter.js'), 'utf8');
      check('M7: yoloLoadLimiter.js\'s effectiveLimit() does not bind the window value to THRESHOLD (no Math.min(...THRESHOLD...) in the function body)',
        !/function effectiveLimit[\s\S]{0,400}?Math\.min\([^)]*THRESHOLD/.test(limiterSrc));
    }

    // M8-M12: THE REAL PROOF, part 1 — an INSTANT-resolving worker (no
    // completion-timing spread at all). With zero stagger, no replacement
    // dispatch's own worker call ever actually runs before the breaker
    // trips (every replacement's own isOpen() pre-check inside the IIFE
    // fires true first) — so `dispatched` here is EXACTLY getLimit(), day
    // or night, confirming the initial burst itself scales with the window
    // value (this is the amplification's root cause, not something fix #4
    // could ever eliminate without capping the window value itself).
    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const boostedInstantBurst = await withFakeNow(boostedInstant, () => runDoomedWaveProbe(30));
    check('M8: instant-resolving outage — boosted-window (9) initial burst dispatches exactly 9',
      boostedInstantBurst.dispatched === 9, `dispatched=${boostedInstantBurst.dispatched}`);
    check('M8b: ...and the breaker actually opened (sanity)',
      boostedInstantBurst.result.aborted === true, `aborted=${boostedInstantBurst.result.aborted}`);

    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const baseInstantBurst = await withFakeNow(baseInstant, () => runDoomedWaveProbe(30));
    check('M9: instant-resolving outage — base-window (6) initial burst dispatches exactly 6',
      baseInstantBurst.dispatched === 6, `dispatched=${baseInstantBurst.dispatched}`);

    // M10-M13: THE REAL PROOF, part 2 — a STAGGERED worker (deterministic,
    // no Math.random()) modeling genuine completion-timing spread, the
    // shape a real ~120s-timeout outage actually has. This is what shows
    // the per-dispatch isOpen() check doing real work: exactly
    // (THRESHOLD - 1) REPLACEMENT dispatches get through — one per
    // completion that lands before the THRESHOLD'th consecutive transient
    // failure trips the breaker — on top of the initial burst. Measured and
    // reproduced deterministically during this fix (repeat runs give the
    // identical count): dispatched = getLimit() + (THRESHOLD - 1).
    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const boostedStaggered = await withFakeNow(boostedInstant, () => runDoomedWaveProbeStaggered(60, 150, 7));
    const expectedBoosted = 9 + (limiter.threshold() - 1); // 9 + 4 = 13
    check('M10: staggered outage — boosted window (9) dispatches getLimit()+(THRESHOLD-1) = 13 doomed requests before the breaker halts further dispatch',
      boostedStaggered.dispatched === expectedBoosted, `dispatched=${boostedStaggered.dispatched} expected=${expectedBoosted}`);
    check('M10b: ...and did NOT dispatch the full 60-product catalog — bounded, not unbounded',
      boostedStaggered.dispatched < 60, `dispatched=${boostedStaggered.dispatched}`);

    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const baseStaggered = await withFakeNow(baseInstant, () => runDoomedWaveProbeStaggered(60, 150, 7));
    const expectedBase = 6 + (limiter.threshold() - 1); // 6 + 4 = 10
    check('M11: staggered outage — base window (6) dispatches getLimit()+(THRESHOLD-1) = 10 doomed requests before the breaker halts further dispatch',
      baseStaggered.dispatched === expectedBase, `dispatched=${baseStaggered.dispatched} expected=${expectedBase}`);

    check('M12 (THE HONEST HEADLINE INVARIANT — replaces the old, now-false "zero delta" claim): the boosted-window doomed count IS greater than the base-window count (13 > 10) — an ACCEPTED, BOUNDED trade-off, not eliminated to zero',
      boostedStaggered.dispatched > baseStaggered.dispatched,
      `boosted=${boostedStaggered.dispatched} base=${baseStaggered.dispatched}`);

    // M13 RE-PINNED (lower-severity finding #2, adversarial review round 2,
    // 2026-09-07) — the old check here asserted "delta% ~= 30", which is
    // NOT a stable invariant: it is an artifact of CATALOG_YOLO_BREAKER_
    // THRESHOLD's CURRENT default (5) and would go red the moment an
    // operator tunes that documented knob for an unrelated reason, even
    // though nothing would actually be wrong. The REAL, stable invariant —
    // because the staggered-wave dispatch count is getLimit() +
    // (THRESHOLD-1) on both sides, and THRESHOLD cancels out in the
    // subtraction — is an ABSOLUTE count: exactly (nightLimit - dayLimit)
    // extra doomed dispatches, constant across catalog size AND across
    // every CATALOG_YOLO_BREAKER_THRESHOLD value. At this repo's default
    // settings that is 9 - 6 = 3, not a percentage.
    const nightLimitDefault = ycw.currentYoloConcurrency(boostedInstant); // 9
    const dayLimitDefault = ycw.currentYoloConcurrency(baseInstant);      // 6
    check('M13 (re-pinned — was "delta% ~= 30"): the ABSOLUTE excess is exactly nightLimit - dayLimit = 3 doomed requests, not a percentage artifact of THRESHOLD\'s current default (5)',
      (boostedStaggered.dispatched - baseStaggered.dispatched) === (nightLimitDefault - dayLimitDefault),
      `delta=${boostedStaggered.dispatched - baseStaggered.dispatched} nightLimit-dayLimit=${nightLimitDefault - dayLimitDefault}`);

    // M13b: prove the invariant is INDEPENDENT of THRESHOLD — sweep several
    // values (including ones nobody has shipped as a default) and confirm
    // the ABSOLUTE delta never moves, even though both individual dispatch
    // counts (and the percentage the old check pinned) do.
    for (const t of [2, 3, 5, 8, 10]) {
      limiter.__test.reset({ threshold: t, cooldownMs: 1_800_000 });
      const boostedT = await withFakeNow(boostedInstant, () => runDoomedWaveProbeStaggered(60, 150, 7));
      limiter.__test.reset({ threshold: t, cooldownMs: 1_800_000 });
      const baseT = await withFakeNow(baseInstant, () => runDoomedWaveProbeStaggered(60, 150, 7));
      check(`M13b(threshold=${t}): absolute delta stays 3 regardless of CATALOG_YOLO_BREAKER_THRESHOLD`,
        (boostedT.dispatched - baseT.dispatched) === 3,
        `boosted=${boostedT.dispatched} base=${baseT.dispatched}`);
    }

    // M13c: prove the invariant is INDEPENDENT of catalog size, given a
    // catalog large enough that neither wave is clipped by running out of
    // products (60 above; repeat at 120 to show it is not a coincidence of
    // one particular size).
    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const boostedBigCatalog = await withFakeNow(boostedInstant, () => runDoomedWaveProbeStaggered(120, 150, 7));
    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    const baseBigCatalog = await withFakeNow(baseInstant, () => runDoomedWaveProbeStaggered(120, 150, 7));
    check('M13c: absolute delta stays 3 on a larger catalog (120 products, not 60) — not an artifact of one specific catalog size',
      (boostedBigCatalog.dispatched - baseBigCatalog.dispatched) === 3,
      `boosted=${boostedBigCatalog.dispatched} base=${baseBigCatalog.dispatched}`);

    // M13d: the invariant GENERALIZES beyond today's default "3" — a
    // DIFFERENT (base, multiplier) pair produces a DIFFERENT absolute
    // delta, but that delta is still exactly nightLimit - dayLimit, proving
    // "3" is a consequence of today's defaults (base 6, multiplier 1.5),
    // not a hardcoded special case in the invariant itself.
    {
      const savedBase2 = process.env.CATALOG_YOLO_CONCURRENCY;
      const savedMult2 = process.env.CATALOG_YOLO_NIGHT_MULTIPLIER;
      process.env.CATALOG_YOLO_CONCURRENCY = '4';
      process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = '2';
      const dayLimit2 = ycw.currentYoloConcurrency(baseInstant);    // 4
      const nightLimit2 = ycw.currentYoloConcurrency(boostedInstant); // 8
      limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
      const boosted2 = await withFakeNow(boostedInstant, () => runDoomedWaveProbeStaggered(60, 150, 7));
      limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
      const base2 = await withFakeNow(baseInstant, () => runDoomedWaveProbeStaggered(60, 150, 7));
      check('M13d: a different (base=4, multiplier=2x) pair -> delta = nightLimit-dayLimit = 4, generalizing the invariant beyond today\'s default of 3',
        (boosted2.dispatched - base2.dispatched) === (nightLimit2 - dayLimit2),
        `boosted=${boosted2.dispatched} base=${base2.dispatched} nightLimit=${nightLimit2} dayLimit=${dayLimit2}`);
      if (savedBase2 === undefined) delete process.env.CATALOG_YOLO_CONCURRENCY;
      else process.env.CATALOG_YOLO_CONCURRENCY = savedBase2;
      if (savedMult2 === undefined) delete process.env.CATALOG_YOLO_NIGHT_MULTIPLIER;
      else process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = savedMult2;
    }

    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    limiter.__test.clearLimitOverride();
  }

  console.log('\n[N] *** FIX #6, BEHAVIOURAL PROOF *** — not just a structural grep: monkeypatch');
  console.log('    the ONE shared function itself and confirm the REAL dispatch path (both the');
  console.log('    semaphore ceiling AND the pump loop\'s courtesy cap) actually calls through it,');
  console.log('    so a future re-split (two independent copies that happen to agree) fails this.');
  {
    limiter.__test.reset({ threshold: 50, cooldownMs: 1_800_000 }); // breaker out of the way
    limiter.__test.clearLimitOverride();

    const realGetLimit = limiter.getLimit;
    let spyCalls = 0;
    const SENTINEL = 3; // a distinctive value unlikely to appear by coincidence
    limiter.getLimit = function spy(...args) {
      spyCalls++;
      return SENTINEL;
    };
    let probe;
    try {
      probe = await runPeakConcurrencyProbe(12, 15);
    } finally {
      limiter.getLimit = realGetLimit; // restore unconditionally, even on throw
    }
    check('N1: the spy was actually invoked by the real dispatch path (proves the call is live, not dead code)',
      spyCalls > 0, `spyCalls=${spyCalls}`);
    check('N2: real peak concurrency during the run equals the SPY\'S sentinel value (3), not the window\'s real boosted/base value — proving catalogYoloDetectionService\'s dispatch decision routes through the literal SAME function this test replaced',
      probe.peak === SENTINEL, `peak=${probe.peak} sentinel=${SENTINEL}`);
    check('N3: every one of the 12 fake products still completed through the spy (dispatch correctness unaffected by which function resolves the limit)',
      probe.result.processed === 12, `processed=${probe.result.processed}`);

    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    limiter.__test.clearLimitOverride();
  }

  console.log('\n[O] *** FIX #2, KILL SWITCH *** — CATALOG_YOLO_NIGHT_BOOST_ENABLED');
  {
    const boostedInstant = ptWallClockToUtcMs(2026, 9, 8, 1, 30, 0); // normally resolves to 9
    check('O1 (sanity): this instant genuinely IS inside a boost window',
      ycw.isNightlyBoostWindow(boostedInstant) === true);
    check('O2 (sanity): with the switch at its DEFAULT (unset), the boosted value (9) is reached',
      ycw.currentYoloConcurrency(boostedInstant) === 9,
      `got ${ycw.currentYoloConcurrency(boostedInstant)}`);

    process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED = 'false';
    check('O3 (THE FIX): with the switch OFF, the SAME boosted instant now resolves to flat baseConcurrency() (6) — byte-identical to the pre-boost code',
      ycw.currentYoloConcurrency(boostedInstant) === ycw.baseConcurrency(),
      `got ${ycw.currentYoloConcurrency(boostedInstant)} base=${ycw.baseConcurrency()}`);
    check('O4: isNightBoostEnabled() itself reports false',
      ycw.isNightBoostEnabled() === false);

    // Every falsy-looking spelling this repo's sibling flags accept (grepped
    // from campaignAdsGenerationService.js's isCatalogFeedOrderSeedingEnabled)
    // must also disable — and every other value (including "" / unset)
    // leaves it ON, matching that same convention exactly.
    for (const off of ['false', 'FALSE', '0', 'no', 'off', 'Off']) {
      process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED = off;
      check(`O5(${off}): disables the boost`, ycw.isNightBoostEnabled() === false);
    }
    for (const on of ['true', '1', 'yes', 'anything-else']) {
      process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED = on;
      check(`O6(${on}): leaves the boost enabled (default-on convention)`, ycw.isNightBoostEnabled() === true);
    }
    delete process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED;
    check('O7: unset ⇒ enabled (documented default true)', ycw.isNightBoostEnabled() === true);

    // REAL INTEGRATION: with the switch off, the actual semaphore + pump
    // loop must never exceed base concurrency even during a boosted window.
    process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED = 'false';
    limiter.__test.reset({ threshold: 50, cooldownMs: 1_800_000 });
    limiter.__test.clearLimitOverride();
    const killed = await withFakeNow(boostedInstant, () => runPeakConcurrencyProbe(20));
    check('O8 (REAL INTEGRATION): with the kill switch off, peak REAL concurrency during a boosted-window instant stays at base (6), not 9',
      killed.peak === 6, `peak=${killed.peak}`);
    delete process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED;
    limiter.__test.reset({ threshold: 5, cooldownMs: 1_800_000 });
    limiter.__test.clearLimitOverride();
  }

  console.log('\n[P] *** FIXES #1 AND #3 *** — night concurrency is DERIVED from base (never');
  console.log('    independent), and a 0/blank/negative multiplier fails SAFE to the default');
  {
    // P1-P4: the emergency-lowering scenario the review is specifically
    // about — an operator lowers CATALOG_YOLO_CONCURRENCY mid-incident and
    // the boosted value must track it DOWN, never stay pinned at the old
    // absolute default.
    const savedBase = process.env.CATALOG_YOLO_CONCURRENCY;
    try {
      process.env.CATALOG_YOLO_CONCURRENCY = '6';
      const nightAtBase6 = ycw.nightConcurrency();
      check('P1: night at base=6, default multiplier (1.5x) = ceil(6*1.5) = 9',
        nightAtBase6 === 9, `got ${nightAtBase6}`);

      process.env.CATALOG_YOLO_CONCURRENCY = '2';
      const nightAtBase2 = ycw.nightConcurrency();
      check('P2 (THE INVARIANT): lowering base from 6 to 2 (an operator\'s emergency lever) correspondingly LOWERS the boosted value — it is NOT pinned at the old absolute default (9)',
        nightAtBase2 === 3, `got ${nightAtBase2} (expected ceil(2*1.5)=3)`);
      check('P3: night is strictly less at the lower base — monotonicity, not coincidence',
        nightAtBase2 < nightAtBase6, `nightAtBase2=${nightAtBase2} nightAtBase6=${nightAtBase6}`);

      // Property check across a small spread of base values: for ANY base,
      // night must equal ceil(base * multiplier), and must never DECREASE
      // when base increases (monotonic, per the review's own stated
      // invariant: "lowering B always lowers or holds equal the effective
      // night value, never raises it independent of B").
      let prevNight = -Infinity;
      for (const b of [1, 2, 3, 4, 5, 6, 8, 10, 12, 20]) {
        process.env.CATALOG_YOLO_CONCURRENCY = String(b);
        const n = ycw.nightConcurrency();
        const expected = Math.min(32, Math.max(1, Math.ceil(b * 1.5)));
        check(`P4(base=${b}): night === ceil(base*1.5) clamped [1,32] (${expected})`, n === expected, `got ${n}`);
        check(`P4b(base=${b}): night is monotonically non-decreasing as base rises`, n >= prevNight, `n=${n} prevNight=${prevNight}`);
        prevNight = n;
      }
    } finally {
      if (savedBase === undefined) delete process.env.CATALOG_YOLO_CONCURRENCY;
      else process.env.CATALOG_YOLO_CONCURRENCY = savedBase;
    }
    process.env.CATALOG_YOLO_CONCURRENCY = '6';

    // P5-P9: the 0/negative/blank fail-safe (item 3, BLOCKING). Direct unit
    // checks against the exported parser (no console-warning noise needed
    // beyond what the parser itself already prints once).
    check('P5: parseNightMultiplier(undefined) === documented default (1.5) — unset behaves as "use default"',
      ycw.__test.parseNightMultiplier(undefined) === ycw.__test.NIGHT_MULTIPLIER_DEFAULT);
    check('P6: parseNightMultiplier("") === documented default — blank behaves as "use default"',
      ycw.__test.parseNightMultiplier('') === ycw.__test.NIGHT_MULTIPLIER_DEFAULT);
    check('P7 (THE BLOCKING FIX): parseNightMultiplier("0") === documented default (1.5) — NOT 1 (the old bare-positive-int fallback floor that turned 0 into a 6x THROTTLE)',
      ycw.__test.parseNightMultiplier('0') === ycw.__test.NIGHT_MULTIPLIER_DEFAULT,
      `got ${ycw.__test.parseNightMultiplier('0')}`);
    check('P8: parseNightMultiplier("-3") === documented default — negative also fails safe',
      ycw.__test.parseNightMultiplier('-3') === ycw.__test.NIGHT_MULTIPLIER_DEFAULT);
    check('P9: parseNightMultiplier("not-a-number") === documented default — garbage also fails safe',
      ycw.__test.parseNightMultiplier('not-a-number') === ycw.__test.NIGHT_MULTIPLIER_DEFAULT);
    check('P10: parseNightMultiplier("2") === 2 — a genuinely valid override still wins',
      ycw.__test.parseNightMultiplier('2') === 2);

    // Behavioural end-to-end: CATALOG_YOLO_NIGHT_MULTIPLIER=0 must not
    // silently invert the boost into a throttle (night < base).
    const savedMult = process.env.CATALOG_YOLO_NIGHT_MULTIPLIER;
    process.env.CATALOG_YOLO_CONCURRENCY = '6';
    process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = '0';
    const nightWithZeroMultiplier = ycw.nightConcurrency();
    check('P11 (BLOCKING, end-to-end): CATALOG_YOLO_NIGHT_MULTIPLIER=0 resolves night to the DEFAULT-multiplier value (9 at base 6), never below base — no silent inversion into a throttle',
      nightWithZeroMultiplier === 9 && nightWithZeroMultiplier >= ycw.baseConcurrency(),
      `night=${nightWithZeroMultiplier} base=${ycw.baseConcurrency()}`);

    // P12-P16 (BLOCKER #2, adversarial review round 2, 2026-09-07) — a
    // multiplier strictly between 0 and 1 is finite and POSITIVE, so it
    // passes every check P5-P11 exercise above, but applying it AS-IS
    // silently inverts the boost into a THROTTLE: night = ceil(base * 0.1)
    // is below base. This is the SAME failure class fix #3 (P5-P11) closed
    // for 0/negative/blank/NaN, just reachable through a different, still
    // "in range" value. Sweep every value the review named and assert BOTH
    // halves of the real invariant — not merely that some clamp exists:
    // (a) the resolved multiplier is always in [NIGHT_MULTIPLIER_MIN,
    // NIGHT_MULTIPLIER_MAX] = [1,4], and (b) nightConcurrency() is NEVER
    // below baseConcurrency(), which is the actual property that matters
    // and that neither P4 nor P11's own oracle formula exercises (P4 keeps
    // the multiplier fixed at the safe default 1.5 while sweeping base; P11
    // only sweeps the already-covered non-positive case) — confirmed by
    // reading both before adding this, not assumed.
    process.env.CATALOG_YOLO_CONCURRENCY = '6';
    const sweepValues = [0.1, 0.5, 0.9, 1, 1.5, 4, 4.5, 15];
    for (const v of sweepValues) {
      process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = String(v);
      const resolvedMultiplier = ycw.nightMultiplier();
      const night = ycw.nightConcurrency();
      const base = ycw.baseConcurrency();
      check(`P12(multiplier=${v}): effective multiplier is clamped to [${ycw.__test.NIGHT_MULTIPLIER_MIN}, ${ycw.__test.NIGHT_MULTIPLIER_MAX}]`,
        resolvedMultiplier >= ycw.__test.NIGHT_MULTIPLIER_MIN && resolvedMultiplier <= ycw.__test.NIGHT_MULTIPLIER_MAX,
        `resolved=${resolvedMultiplier}`);
      check(`P13(multiplier=${v}): nightConcurrency() (${night}) is never below baseConcurrency() (${base}) — THE invariant that matters`,
        night >= base, `night=${night} base=${base}`);
    }

    // P14: the exact blocker-2 repro. Pre-fix, CATALOG_YOLO_NIGHT_MULTIPLIER=0.1
    // at base=6 resolved to ceil(6*0.1)=1 — a 6x THROTTLE. Now the
    // multiplier itself is floored at 1 first, so night === base === 6.
    process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = '0.1';
    check('P14 (THE EXACT BLOCKER-2 REPRO): base=6, CATALOG_YOLO_NIGHT_MULTIPLIER=0.1 no longer throttles below base (was 1 pre-fix; now 6)',
      ycw.nightConcurrency() === 6, `night=${ycw.nightConcurrency()}`);

    // P15: the operator-typo repro (a dropped decimal — "15" meant "1.5")
    // is now caught at the multiplier itself (ceilinged to 4), rather than
    // riding through to the separate [1,32] clamp on the final resolved
    // concurrency (which the review's own write-up flags as reaching
    // night=32 under the OLD, unclamped-multiplier code).
    process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = '15';
    check('P15 (typo repro): CATALOG_YOLO_NIGHT_MULTIPLIER=15 (meant 1.5) clamps the multiplier to 4, giving night=ceil(6*4)=24 — caught at the knob with the typo, not the [1,32] concurrency clamp',
      ycw.nightMultiplier() === 4 && ycw.nightConcurrency() === 24,
      `multiplier=${ycw.nightMultiplier()} night=${ycw.nightConcurrency()}`);

    // P16: a genuinely valid, in-range override still passes through
    // untouched — the clamp must not affect legitimate values.
    process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = '2';
    check('P16: a valid in-range multiplier (2) is unaffected by the new clamp',
      ycw.nightMultiplier() === 2, `got ${ycw.nightMultiplier()}`);

    if (savedMult === undefined) delete process.env.CATALOG_YOLO_NIGHT_MULTIPLIER;
    else process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = savedMult;
  }

  console.log('\n[Q] *** BLOCKER #3 *** — the RETIRED CATALOG_YOLO_NIGHT_CONCURRENCY env var');
  console.log('    now warns loudly (once) instead of going silently inert');
  {
    const savedRetired = process.env.CATALOG_YOLO_NIGHT_CONCURRENCY;
    delete process.env.CATALOG_YOLO_NIGHT_CONCURRENCY;
    check('Q1: unset -> isRetiredNightConcurrencyEnvSet() is false',
      ycw.__test.isRetiredNightConcurrencyEnvSet() === false);
    process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = '';
    check('Q2: blank string -> isRetiredNightConcurrencyEnvSet() is false ("set" means non-empty)',
      ycw.__test.isRetiredNightConcurrencyEnvSet() === false);
    process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = '   ';
    check('Q3: whitespace-only -> isRetiredNightConcurrencyEnvSet() is false',
      ycw.__test.isRetiredNightConcurrencyEnvSet() === false);
    process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = '9';
    check('Q4: set to a real value -> isRetiredNightConcurrencyEnvSet() is true',
      ycw.__test.isRetiredNightConcurrencyEnvSet() === true);
    process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = '0';
    check('Q5: set to "0" -> STILL true — "set at all" means non-empty, not truthy-as-a-number (per blocker-3 wording)',
      ycw.__test.isRetiredNightConcurrencyEnvSet() === true);

    // Q6-Q8: behavioural — the warning actually fires, exactly once, and
    // names both the retired var and its replacement.
    process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = '9';
    ycw.__test.resetRetiredNightConcurrencyWarning();
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      ycw.__test.warnIfRetiredNightConcurrencySet();
      ycw.__test.warnIfRetiredNightConcurrencySet(); // second call must NOT warn again
    } finally {
      console.warn = realWarn;
    }
    check('Q6: warnIfRetiredNightConcurrencySet() actually calls console.warn when the var is set',
      warnings.length === 1, `warnings.length=${warnings.length}`);
    check('Q7: the warning names the retired var AND its replacement (CATALOG_YOLO_NIGHT_MULTIPLIER)',
      warnings.length > 0 && warnings[0].includes('CATALOG_YOLO_NIGHT_CONCURRENCY') && warnings[0].includes('CATALOG_YOLO_NIGHT_MULTIPLIER'),
      `warning=${warnings[0] || '(none)'}`);
    check('Q8: called a second time with the same var still set, it does NOT warn again (once-per-process, matching this file\'s other boot warnings)',
      warnings.length === 1, `warnings.length=${warnings.length}`);

    if (savedRetired === undefined) delete process.env.CATALOG_YOLO_NIGHT_CONCURRENCY;
    else process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = savedRetired;
    ycw.__test.resetRetiredNightConcurrencyWarning();
  }

  // Leave the module in a clean state for anything that runs after this
  // script in the same aggregate suite process boundary (each verify*.js
  // is its own child process, but this is cheap and correct regardless).
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });
  limiter.__test.clearLimitOverride();
  if (SAVED_ENV.CATALOG_YOLO_CONCURRENCY === undefined) delete process.env.CATALOG_YOLO_CONCURRENCY;
  else process.env.CATALOG_YOLO_CONCURRENCY = SAVED_ENV.CATALOG_YOLO_CONCURRENCY;
  if (SAVED_ENV.CATALOG_YOLO_NIGHT_MULTIPLIER === undefined) delete process.env.CATALOG_YOLO_NIGHT_MULTIPLIER;
  else process.env.CATALOG_YOLO_NIGHT_MULTIPLIER = SAVED_ENV.CATALOG_YOLO_NIGHT_MULTIPLIER;
  if (SAVED_ENV.CATALOG_YOLO_NIGHT_BOOST_ENABLED === undefined) delete process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED;
  else process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED = SAVED_ENV.CATALOG_YOLO_NIGHT_BOOST_ENABLED;
  if (SAVED_ENV.CATALOG_YOLO_BREAKER_THRESHOLD === undefined) delete process.env.CATALOG_YOLO_BREAKER_THRESHOLD;
  else process.env.CATALOG_YOLO_BREAKER_THRESHOLD = SAVED_ENV.CATALOG_YOLO_BREAKER_THRESHOLD;
  if (SAVED_ENV.CATALOG_YOLO_NIGHT_CONCURRENCY === undefined) delete process.env.CATALOG_YOLO_NIGHT_CONCURRENCY;
  else process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = SAVED_ENV.CATALOG_YOLO_NIGHT_CONCURRENCY;

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
