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
  CATALOG_YOLO_NIGHT_CONCURRENCY: process.env.CATALOG_YOLO_NIGHT_CONCURRENCY
};
process.env.CATALOG_YOLO_CONCURRENCY = '6';
process.env.CATALOG_YOLO_NIGHT_CONCURRENCY = '9';

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

function fakeProducts(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ _id: `fake-${i}` });
  return out;
}

// Runs processQueue() with a worker that tracks peak concurrent EXECUTIONS
// (i.e. time actually spent holding yoloLoadLimiter's semaphore slot, the
// same window catalogYoloDetectionService's real pump() runs runOne() in) —
// this is what genuinely measures whether both concurrency knobs are in
// effect together, not just what got dispatched.
async function runPeakConcurrencyProbe(productCount) {
  let concurrent = 0;
  let peak = 0;
  const worker = async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 25));
    concurrent--;
    return { detected: 1 };
  };
  const result = await detection.processQueue(fakeProducts(productCount), { worker });
  return { peak, result };
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

  console.log('\n[G] Outside any window, behaviour is byte-for-byte unchanged from the pre-feature default');
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
    // yoloLoadLimiter.getLimit() with NO override set (fresh module state —
    // this test file never called __test.reset({limit}) before this point)
    // and NO instant argument (real "now", which this run's wall-clock is
    // not inside any boost window for) must resolve identically.
    check('G3: yoloLoadLimiter.getLimit() (zero-arg, real "now", no test override) matches the base value',
      limiter.getLimit() === ycw.baseConcurrency(),
      `getLimit()=${limiter.getLimit()} baseConcurrency()=${ycw.baseConcurrency()}`);
  }

  console.log('\n[H] *** THE TWO-KNOBS-AGREE PROPERTY *** — yoloLoadLimiter and');
  console.log('    catalogYoloDetectionService must resolve to the IDENTICAL concurrency');
  console.log('    value at the same instant. This is the single most important check in');
  console.log('    this file — it is the exact failure mode the shared resolver exists to');
  console.log('    prevent (see services/yoloConcurrencyWindow.js header).');
  {
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

  console.log('\n[K] Structural — both files import and call the ONE shared resolver (revert-proof against a future re-split)');
  {
    const fs = require('fs');
    const limiterSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'yoloLoadLimiter.js'), 'utf8');
    const detectionSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'catalogYoloDetectionService.js'), 'utf8');
    check('K1: yoloLoadLimiter.js requires ./yoloConcurrencyWindow',
      /require\(\s*['"]\.\/yoloConcurrencyWindow['"]\s*\)/.test(limiterSrc));
    check('K2: yoloLoadLimiter.js calls yoloConcurrencyWindow.currentYoloConcurrency(',
      /yoloConcurrencyWindow\.currentYoloConcurrency\(/.test(limiterSrc));
    check('K3: catalogYoloDetectionService.js requires ./yoloConcurrencyWindow',
      /require\(\s*['"]\.\/yoloConcurrencyWindow['"]\s*\)/.test(detectionSrc));
    check('K4: catalogYoloDetectionService.js calls yoloConcurrencyWindow.currentYoloConcurrency( in its dispatch loop',
      /while\s*\([^)]*yoloConcurrencyWindow\.currentYoloConcurrency\(\)[^)]*\)/.test(detectionSrc));
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

  // Leave the module in a clean state for anything that runs after this
  // script in the same aggregate suite process boundary (each verify*.js
  // is its own child process, but this is cheap and correct regardless).
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });
  limiter.__test.clearLimitOverride();
  if (SAVED_ENV.CATALOG_YOLO_CONCURRENCY === undefined) delete process.env.CATALOG_YOLO_CONCURRENCY;
  else process.env.CATALOG_YOLO_CONCURRENCY = SAVED_ENV.CATALOG_YOLO_CONCURRENCY;
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
