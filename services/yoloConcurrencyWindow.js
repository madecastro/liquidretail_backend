'use strict';
//
// yoloConcurrencyWindow — SINGLE SOURCE OF TRUTH for the CURRENT effective
// catalog-YOLO concurrency ceiling. Resolves to a BOOSTED value during
// defined low-live-traffic nightly windows (Pacific time), and to the
// normal CATALOG_YOLO_CONCURRENCY value at every other moment.
//
// ── WHY THIS FILE EXISTS: the "two knobs must agree" trap ─────────────────
// Catalog-YOLO concurrency is enforced in TWO independent places:
//   1. yoloLoadLimiter.js       — the process-wide semaphore ceiling
//                                 (acquire()/release()), shared by the
//                                 catalog-YOLO processQueue chain AND
//                                 worker.js's separate yoloBackfillTick.
//   2. catalogYoloDetectionService.js — processQueue's own per-call-site
//                                 "courtesy cap" (`inflight < CONCURRENCY`
//                                 in its dispatch while-loop).
// Both used to read CATALOG_YOLO_CONCURRENCY independently, ONCE, at
// module-require time — so they happened to agree today by coincidence,
// not by construction. Introducing a time-of-day-dependent boost in only
// one of the two would either (a) raise the semaphore ceiling while the
// dispatch loop's own local cap still throttles at the old value, so the
// boost never actually increases real throughput, or (b) raise the
// dispatch cap while the shared semaphore still caps occupancy at the old
// value, so a second concurrent caller (yoloBackfillTick) could still be
// starved. Both files now call `currentYoloConcurrency()` from HERE, AT
// THE POINT OF USE (never cached), so the two ceilings cannot drift apart.
//
// ── TIMEZONE MECHANISM — reused from an existing pattern, not reinvented ──
// services/scheduledSyncService.js already has a hand-rolled, DST-aware
// "nightly window" mechanism for its 2am-Pacific catalog-resync gate
// (CATALOG_SCHEDULED_RESYNC_ENABLED), built on Intl.DateTimeFormat with
// `timeZone: 'America/Los_Angeles'` — no extra date/timezone dependency.
// Confirmed by grepping package.json: no luxon, date-fns-tz, moment, or
// dayjs anywhere in this repo. That file needs to convert a Pacific
// WALL-CLOCK time forward into a UTC window-START instant ahead of time
// (its `zonedUtcMs`/`tzOffsetMs`), which is why it does iterative offset
// correction. This file only needs the OPPOSITE direction — given a UTC
// instant (normally "now"), what is it in Pacific wall-clock terms right
// now — which Intl.DateTimeFormat gives directly via a `weekday` part, with
// no offset arithmetic and no iteration. Both directions are DST-correct by
// construction because Intl resolves the real IANA tzdata for the zone;
// neither ever hardcodes a fixed UTC offset, so PST/PDT transitions are
// handled automatically.
//
// ── THE WINDOWS (owner-specified, Pacific Time) ────────────────────────────
//   Weeknights (Mon-Fri mornings, i.e. the early hours following a
//   Sun/Mon/Tue/Wed/Thu evening):        [01:00, 04:00) PT
//   Weekend nights (Sat & Sun mornings, i.e. the early hours following a
//   Fri/Sat evening):                     [00:00, 05:00) PT
// Both windows are selected by the PACIFIC CALENDAR DAY the instant falls
// on (Sat/Sun -> weekend window, Mon-Fri -> weeknight window) — never by
// "which evening does this look like it follows". That distinction matters
// exactly at midnight Friday-into-Saturday: at 00:00:00 PT the calendar day
// has already rolled over to Saturday, so the weekend window is live from
// that very first instant without needing to still be "on Friday".

const { concurrency: CONC } = require('./concurrency');

const YOLO_TZ = 'America/Los_Angeles';

// Weeknight window: Monday-Friday mornings.
const WEEKNIGHT_START_HOUR = 1;
const WEEKNIGHT_END_HOUR = 4;

// Weekend-night window: Saturday & Sunday mornings.
const WEEKEND_START_HOUR = 0;
const WEEKEND_END_HOUR = 5;

// Intl weekday abbreviations ('en-US', `weekday: 'short'`) that select the
// weekend-night window.
const WEEKEND_MORNING_DAYS = new Set(['Sat', 'Sun']);

function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// BASE concurrency — same parse this repo already used independently in
// both yoloLoadLimiter.js and catalogYoloDetectionService.js before this
// file existed: prefer the raw env var (bare positive-int check, no SPEC
// min/max clamp), fall back to the clamped services/concurrency.js value.
// Preserved byte-for-byte so behaviour OUTSIDE both windows is unchanged.
function baseConcurrency() {
  return parsePositiveInt(process.env.CATALOG_YOLO_CONCURRENCY, CONC.CATALOG_YOLO_CONCURRENCY || 6);
}

// NIGHT (boosted) concurrency. File default 9 (config/defaults.env) — a
// conservative ~50% bump off the base default of 6, deliberately NOT the
// assumed-but-UNVERIFIED 12-slot cluster ceiling documented in
// services/concurrency.js's CATALOG_YOLO_CONCURRENCY `why` field (3
// instances x 4 gunicorn workers — never confirmed against the
// microservice itself; GUNICORN_WORKERS=2 in defaults.env even disagrees
// with the "4 workers" half of that assumption). 9 leaves real headroom
// under that unverified ceiling in case it is wrong, while still
// meaningfully accelerating backlog drain overnight when live /detect
// traffic (which does NOT share this limiter — see yoloLoadLimiter.js's
// header) is low. Do not casually raise this again without first
// confirming the microservice holds up cleanly above 6 concurrent
// /detect-batch calls — nobody has measured that yet.
function nightConcurrency() {
  return parsePositiveInt(process.env.CATALOG_YOLO_NIGHT_CONCURRENCY, CONC.CATALOG_YOLO_NIGHT_CONCURRENCY || 9);
}

const PACIFIC_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: YOLO_TZ,
  hourCycle: 'h23',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

// UTC instant -> Pacific wall-clock weekday + time-of-day. DST-correct
// (Intl resolves real IANA tzdata for America/Los_Angeles); needs no
// manual PST/PDT offset and no iteration.
function pacificWallClock(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = PACIFIC_PARTS_FORMATTER.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    weekday: get('weekday'), // 'Sun'|'Mon'|'Tue'|'Wed'|'Thu'|'Fri'|'Sat'
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second'))
  };
}

// True when `instant` (default: now) falls inside the nightly boost window
// that applies to ITS OWN Pacific calendar day.
function isNightlyBoostWindow(instant) {
  const t = instant == null ? Date.now() : instant;
  const { weekday, hour, minute, second } = pacificWallClock(t);
  const isWeekendMorning = WEEKEND_MORNING_DAYS.has(weekday);
  const startHour = isWeekendMorning ? WEEKEND_START_HOUR : WEEKNIGHT_START_HOUR;
  const endHour = isWeekendMorning ? WEEKEND_END_HOUR : WEEKNIGHT_END_HOUR;
  const secondsSinceMidnight = (hour * 3600) + (minute * 60) + second;
  return secondsSinceMidnight >= startHour * 3600 && secondsSinceMidnight < endHour * 3600;
}

// THE resolver. Both yoloLoadLimiter.js (semaphore ceiling) and
// catalogYoloDetectionService.js (dispatch-loop courtesy cap) call this at
// the point of use — never cache the result — so a window transition
// mid-run is reflected identically on both sides on their very next check.
// `instant` is exposed for tests only; production callers omit it and get
// live wall-clock time.
function currentYoloConcurrency(instant) {
  return isNightlyBoostWindow(instant) ? nightConcurrency() : baseConcurrency();
}

module.exports = {
  currentYoloConcurrency,
  isNightlyBoostWindow,
  baseConcurrency,
  nightConcurrency,
  YOLO_TZ,
  __test: {
    pacificWallClock,
    WEEKNIGHT_START_HOUR,
    WEEKNIGHT_END_HOUR,
    WEEKEND_START_HOUR,
    WEEKEND_END_HOUR
  }
};
