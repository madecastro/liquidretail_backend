'use strict';
//
// yoloConcurrencyWindow — SINGLE SOURCE OF TRUTH for the CURRENT effective
// catalog-YOLO concurrency ceiling. Resolves to a BOOSTED value during
// defined low-live-traffic nightly windows (Pacific time), and to the
// normal CATALOG_YOLO_CONCURRENCY value at every other moment.
//
// ── ADVERSARIAL REVIEW FIXES, 2026-09-06 (read before editing) ────────────
// This PR's first cut had three real, production-relevant defects, closed
// here:
//   #2 KILL SWITCH — `CATALOG_YOLO_NIGHT_BOOST_ENABLED` (default true).
//      Disabled ⇒ currentYoloConcurrency() returns flat baseConcurrency()
//      at every hour and never even calls isNightlyBoostWindow() — the
//      whole feature is byte-identical-inert, not just "boosted == base".
//   #1 NIGHT MUST BE DERIVED FROM BASE (BLOCKING) — nightConcurrency() used
//      to be its own independent parsePositiveInt(env, 9) call. An operator
//      lowering CATALOG_YOLO_CONCURRENCY as a live-incident emergency lever
//      got silently overridden back UP the next boost window, since
//      CATALOG_YOLO_NIGHT_CONCURRENCY has its own unrelated default. Fixed:
//      night is now base * CATALOG_YOLO_NIGHT_MULTIPLIER (default 1.5),
//      computed at the point of use — lowering base always lowers or holds
//      the boosted value, never raises it independent of base.
//   #3 0/NEGATIVE MULTIPLIER FAILS SAFE (BLOCKING) — a bare positive-int
//      parse resolves 0 through to the FALLBACK'S OWN inner floor (measured
//      pre-fix on the old absolute var: 0 -> 1, a 6x THROTTLE). The
//      multiplier parser now treats 0/blank/negative/NaN identically —
//      falls back to the documented default (1.5x), with a loud one-time
//      boot warning, never a silent inversion into a throttle.
// See services/yoloLoadLimiter.js for fix #4 (breaker-threshold-bounded
// dispatch concurrency) and fix #6 (the single shared accessor both
// enforcement points now call).
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

const { concurrency: CONC, SPEC } = require('./concurrency');

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

// ── KILL SWITCH (adversarial review fix #2, 2026-09-06) ────────────────────
// Parser matches the sibling flags in this repo (grepped:
// isCatalogFeedOrderSeedingEnabled / isUnifiedNineSixteenMasterEnabled in
// campaignAdsGenerationService.js) EXACTLY — default ON (unset/blank ⇒
// true), disabled only by an explicit falsy-looking string. When disabled,
// currentYoloConcurrency() below returns flat baseConcurrency() at every
// hour WITHOUT ever calling isNightlyBoostWindow() — i.e. byte-identical to
// the pre-boost code, not merely "boosted value forced equal to base".
function isNightBoostEnabled() {
  const raw = process.env.CATALOG_YOLO_NIGHT_BOOST_ENABLED;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// ── NIGHT (boosted) concurrency — DERIVED from base, never independent ────
// (adversarial review fix #1, 2026-09-06, BLOCKING.) Before this fix,
// nightConcurrency() was its own parsePositiveInt(process.env.X, fallback)
// call with an INDEPENDENT default (9) — so an operator lowering
// CATALOG_YOLO_CONCURRENCY on the dashboard as a zero-deploy emergency
// lever during a live incident got silently overridden back UP the next
// time a boost window opened, since CATALOG_YOLO_NIGHT_CONCURRENCY is
// almost never set explicitly and falls through to its own default of 9
// regardless of how low base was just set.
//
// Fixed by expressing the boost as a MULTIPLIER on top of whatever base
// currently resolves to, applied AT THE POINT OF USE (never cached) —
// exactly the same "never independent, never cached" discipline this
// file's header already documents for the two concurrency-enforcement call
// sites. night = ceil(baseConcurrency() * multiplier), so lowering base
// always lowers or holds equal the boosted value; it can never exceed it
// independent of base. Default multiplier 1.5 preserves the original PR's
// intended ~50% bump at the default base of 6 (6 * 1.5 = 9 — the same
// number this file used to hardcode as an independent default). Clamped to
// [1, 32] — the same [min,max] the old, now-retired CATALOG_YOLO_NIGHT_CONCURRENCY
// SPEC entry in services/concurrency.js carried; see that file for the
// updated (documentation-only; this parse does not consume it — see fix #3
// below for why) SPEC entry.
// Derived from concurrency.js's own SPEC entry — NOT a second hardcoded
// literal — so the default/min/max an operator reads in that table's `why`
// text is mechanically the same number this parser enforces, never a
// second copy that can silently drift from it (lower-severity finding,
// adversarial review round 2, 2026-09-07).
const NIGHT_MULTIPLIER_DEFAULT = SPEC.CATALOG_YOLO_NIGHT_MULTIPLIER.default; // 1.5
const NIGHT_MULTIPLIER_MIN = SPEC.CATALOG_YOLO_NIGHT_MULTIPLIER.min; // 1 (raised from 0.1 — see concurrency.js)
const NIGHT_MULTIPLIER_MAX = SPEC.CATALOG_YOLO_NIGHT_MULTIPLIER.max; // 4
const NIGHT_CONCURRENCY_MIN = 1;
const NIGHT_CONCURRENCY_MAX = 32;

// (adversarial review fix #3, 2026-09-06, BLOCKING.) A bare
// parsePositiveInt(raw, fallback)-style parse resolves 0 (and blank/
// negative/NaN) through to the FALLBACK'S OWN inner floor rather than to
// the fallback value itself when the fallback is itself run through a
// positive-int guard — measured pre-fix: CATALOG_YOLO_NIGHT_CONCURRENCY=0
// resolved to 1 (a 6x THROTTLE, not "no boost"). Fixed by treating
// null/blank the same as "unset" (⇒ default multiplier) and treating any
// OTHER non-positive or non-finite value as a boot-time-logged
// misconfiguration that ALSO falls back to the documented default,
// instead of silently coercing to some other number. Logs once per
// process (not once per call — this can be read on every processQueue
// pump() tick) so a bad env value is loud without spamming.
let _warnedBadMultiplier = false;
// (adversarial review BLOCKER #2, round 2, 2026-09-07, BLOCKING.) A value
// strictly between 0 and 1 is genuinely positive and finite — it passes
// the guard below — but applying it AS-IS silently INVERTS the boost into
// a THROTTLE: night = ceil(base * 0.1) is below base, exactly the failure
// mode this whole feature exists to prevent, just reached through
// CATALOG_YOLO_NIGHT_MULTIPLIER instead of the old, retired
// CATALOG_YOLO_NIGHT_CONCURRENCY. And a value above the documented ceiling
// (an operator typo like "15" meaning "1.5") would otherwise ride through
// to the SEPARATE [1,32] clamp on the final RESOLVED concurrency below,
// rather than being caught at the actual knob that has the typo. Both
// directions are now clamped to [NIGHT_MULTIPLIER_MIN, NIGHT_MULTIPLIER_MAX]
// — derived from concurrency.js's SPEC entry, see above — with a loud,
// once-per-process warning whenever a value outside that range is
// rejected/clamped.
let _warnedOutOfRangeMultiplier = false;
function parseNightMultiplier(raw) {
  if (raw == null || String(raw).trim() === '') return NIGHT_MULTIPLIER_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (!_warnedBadMultiplier) {
      _warnedBadMultiplier = true;
      console.warn(
        `⚠️  CATALOG_YOLO_NIGHT_MULTIPLIER="${raw}" is not a positive number — ` +
        `falling back to the documented default (${NIGHT_MULTIPLIER_DEFAULT}x base). ` +
        `A value of 0 or negative would otherwise silently invert the nightly ` +
        `boost into a throttle.`
      );
    }
    return NIGHT_MULTIPLIER_DEFAULT;
  }
  if (n < NIGHT_MULTIPLIER_MIN || n > NIGHT_MULTIPLIER_MAX) {
    const clamped = Math.min(NIGHT_MULTIPLIER_MAX, Math.max(NIGHT_MULTIPLIER_MIN, n));
    if (!_warnedOutOfRangeMultiplier) {
      _warnedOutOfRangeMultiplier = true;
      console.warn(
        `⚠️  CATALOG_YOLO_NIGHT_MULTIPLIER=${n} is outside the documented safe range ` +
        `[${NIGHT_MULTIPLIER_MIN}, ${NIGHT_MULTIPLIER_MAX}] — clamping to ${clamped}x. ` +
        `Below ${NIGHT_MULTIPLIER_MIN}x would silently invert the nightly boost into a ` +
        `throttle (night concurrency below base); above ${NIGHT_MULTIPLIER_MAX}x exceeds ` +
        `the operator ceiling documented in services/concurrency.js (a common typo shape: ` +
        `"15" meant as "1.5").`
      );
    }
    return clamped;
  }
  return n;
}

function nightMultiplier() {
  return parseNightMultiplier(process.env.CATALOG_YOLO_NIGHT_MULTIPLIER);
}

// ── RETIRED ENV VAR (adversarial review BLOCKER #3, 2026-09-07) ───────────
// CATALOG_YOLO_NIGHT_CONCURRENCY was the OLD absolute-value knob this file
// carried before fix #1 (2026-09-06) replaced it with the DERIVED
// CATALOG_YOLO_NIGHT_MULTIPLIER above. It is now read by NOTHING — an
// operator (or a stale Render dashboard override left over from before the
// rename) who still has it set gets total, silent inertia: no error, no
// effect, and nothing telling them their setting is being ignored. Checked
// — and warned on, once — at REQUIRE time (this file is pulled in by both
// yoloLoadLimiter.js and catalogYoloDetectionService.js, both loaded at
// process boot), rather than waiting for a nightly window to make the
// drift observable.
let _warnedRetiredNightConcurrency = false;
function isRetiredNightConcurrencyEnvSet() {
  const raw = process.env.CATALOG_YOLO_NIGHT_CONCURRENCY;
  return raw != null && String(raw).trim() !== '';
}
function warnIfRetiredNightConcurrencySet() {
  if (!isRetiredNightConcurrencyEnvSet()) return;
  if (_warnedRetiredNightConcurrency) return;
  _warnedRetiredNightConcurrency = true;
  console.warn(
    `⚠️  CATALOG_YOLO_NIGHT_CONCURRENCY="${process.env.CATALOG_YOLO_NIGHT_CONCURRENCY}" is set but ` +
    `RETIRED — it is read by nothing. Use CATALOG_YOLO_NIGHT_MULTIPLIER (a multiplier on ` +
    `CATALOG_YOLO_CONCURRENCY, default ${NIGHT_MULTIPLIER_DEFAULT}) instead, or ` +
    `CATALOG_YOLO_NIGHT_BOOST_ENABLED=false to disable the nightly boost entirely.`
  );
}
warnIfRetiredNightConcurrencySet();

// NIGHT (boosted) concurrency, DERIVED from the CURRENT baseConcurrency() —
// never an independent absolute value, never cached. See the header comment
// above for the incident this closes.
function nightConcurrency() {
  const base = baseConcurrency();
  const raw = Math.ceil(base * nightMultiplier());
  return Math.min(NIGHT_CONCURRENCY_MAX, Math.max(NIGHT_CONCURRENCY_MIN, raw));
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

// THE resolver. yoloLoadLimiter.js's getLimit()/effectiveLimit() (the ONE
// shared accessor both the semaphore ceiling AND
// catalogYoloDetectionService.js's dispatch-loop courtesy cap now call —
// see that file's header for fix #6) reads this at the point of use — never
// cache the result — so a window transition mid-run is reflected
// identically on both sides on their very next check.
// `instant` is exposed for tests only; production callers omit it and get
// live wall-clock time.
//
// Kill-switch check comes FIRST and short-circuits before even calling
// isNightlyBoostWindow() — "no window logic invoked at all" per fix #2,
// not merely "boosted value forced equal to base".
function currentYoloConcurrency(instant) {
  if (!isNightBoostEnabled()) return baseConcurrency();
  return isNightlyBoostWindow(instant) ? nightConcurrency() : baseConcurrency();
}

module.exports = {
  currentYoloConcurrency,
  isNightlyBoostWindow,
  isNightBoostEnabled,
  baseConcurrency,
  nightConcurrency,
  nightMultiplier,
  YOLO_TZ,
  __test: {
    pacificWallClock,
    parseNightMultiplier,
    NIGHT_MULTIPLIER_DEFAULT,
    NIGHT_MULTIPLIER_MIN,
    NIGHT_MULTIPLIER_MAX,
    NIGHT_CONCURRENCY_MIN,
    NIGHT_CONCURRENCY_MAX,
    WEEKNIGHT_START_HOUR,
    WEEKNIGHT_END_HOUR,
    WEEKEND_START_HOUR,
    WEEKEND_END_HOUR,
    isRetiredNightConcurrencyEnvSet,
    warnIfRetiredNightConcurrencySet,
    resetRetiredNightConcurrencyWarning() { _warnedRetiredNightConcurrency = false; }
  }
};
