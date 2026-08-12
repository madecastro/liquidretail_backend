#!/usr/bin/env node
'use strict';
//
// verifyRunAlertsAndDoneGuard — two small correctness pins on CampaignRun
// state. Pure + offline: no DB, no network, no API key.
//
// FIX 1. routes/ads.js stamped terminal `done` with no status guard, so a
//        run the reaper had already marked `failed` could flip back to
//        `done`. The write now goes through buildTerminalDoneFilter, whose
//        allow-list is the in-flight CampaignRun statuses
//        (preparing, running). CampaignRun has no 'cancelled' — operator
//        stop is OperationRun.status='cancelled' via progressService.
//
// FIX 2. services/backlogWatchdog.js arm 2 keyed "not progressing" on
//        startedAt (AGE). That is a false-positive generator: a healthy
//        20-ad video batch is older than 45m and still incrementing.
//        The rejected alternative (swap startedAt for updatedAt at 45m)
//        is a structurally empty set — worker.js reapOrphans already
//        mutates { status:'running', updatedAt < REAP_STALE_MIN } to
//        failed every 5 minutes. The live predicate is AGE ∧ SILENCE,
//        with silence strictly below REAP_STALE_MIN.
//
// These checks evaluate the REAL filter objects against REAL document
// shapes — not a regex over the source. A source-text assertion cannot
// tell a working query from one that merely still contains the right
// words. (Same posture as verifyTitlingOrphanResume /
// verifyNoStrandedQueued.)
//
// Revert-prove (each mutation must fail this harness):
//   1. Drop `status` from buildTerminalDoneFilter
//        → D3 fails (a reaped `failed` run becomes `done`)
//   2. Stop calling buildTerminalDoneFilter at the render-loop write
//        → E1 fails (these checks would be testing a copy)
//   3. Drop the import of buildTerminalDoneFilter from ads.js
//        → E2 fails (the unbound-identifier production incident)
//   4. Revert arm 2 to `{ status:'running', startedAt: { $lt: age } }`
//        → B1 fails (a progressing old run alerts — the false positive)
//   5. Drop `updatedAt` from buildStalledRunFilter / stop calling it
//        → B1 or E3 fails
//   6. Raise ALERT_RUN_SILENCE_MIN's default to >= REAP_STALE_MIN
//        → C1 fails (the empty-set boundary)
//
//   node scripts/verifyRunAlertsAndDoneGuard.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTerminalDoneFilter,
  DONE_ELIGIBLE_STATUSES
} = require('../services/campaignRunGuards');
const {
  buildStalledRunFilter,
  RUN_STALE_MIN,
  RUN_SILENCE_MIN
} = require('../services/backlogWatchdog');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyRunAlertsAndDoneGuard\n');

// ── A tiny Mongo matcher, covering exactly the operators these filters use.
// Deliberately NOT a general implementation: it throws on anything it does
// not understand, so a future operator added to the query cannot be silently
// mis-evaluated into a false pass.
function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$ne') { if (value === operand) return false; }
      else if (op === '$lt') { if (!(value != null && value < operand)) return false; }
      else if (op === '$in') { if (!operand.includes(value)) return false; }
      else throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
    }
    return true;
  }
  if (cond === null) return value === null || value === undefined;
  return value === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some((sub) => matches(doc, sub))) return false;
    } else if (key === '$and') {
      if (!cond.every((sub) => matches(doc, sub))) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`matcher does not implement top-level ${key}`);
    } else if (!matchOp(doc[key], cond)) return false;
  }
  return true;
}

const ROOT = path.join(__dirname, '..');
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

const NOW = new Date('2026-08-12T18:00:00Z');
const RUN_ID = '64b0000000000000000000aa';

// Thresholds the live helpers will use. Passed explicitly so a helper
// that ignores its args cannot hide behind Date.now() drift.
const AGE_MIN = 45;
const SILENCE_MIN = 12;
const STALLED = buildStalledRunFilter({ now: NOW, ageMin: AGE_MIN, silenceMin: SILENCE_MIN });

const minAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);

// ── Group A — the matcher itself is trustworthy.
ok('A1 matcher: exact equality', () => {
  assert.strictEqual(matches({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(matches({ a: 2 }, { a: 1 }), false);
});
ok('A2 matcher: $ne, $lt, $in', () => {
  assert.strictEqual(matches({ a: 'x' }, { a: { $ne: null } }), true);
  assert.strictEqual(matches({ a: null }, { a: { $ne: null } }), false);
  assert.strictEqual(matches({ t: minAgo(20) }, { t: { $lt: minAgo(15) } }), true);
  assert.strictEqual(matches({ t: minAgo(5) }, { t: { $lt: minAgo(15) } }), false);
  assert.strictEqual(matches({ s: 'running' }, { s: { $in: ['preparing', 'running'] } }), true);
  assert.strictEqual(matches({ s: 'failed' }, { s: { $in: ['preparing', 'running'] } }), false);
});
ok('A3 matcher refuses an operator it does not implement', () => {
  assert.throws(() => matches({ a: 1 }, { a: { $gte: 1 } }), /does not implement/);
});

// ── Group B — the stalled-run predicate. Evaluate the REAL filter.
//
// A progressing run is OLD (startedAt past the age filter) but its
// counters just moved, so updatedAt is fresh. Today's bug alerts on it.
// A genuine stall is old AND silent, but not yet so silent the reaper
// has rewritten it to failed (silence 12 < REAP 15).

const progressing = {
  status: 'running',
  startedAt: minAgo(50),   // past the 45m noise filter
  updatedAt: minAgo(2)     // counters just moved
};

const silentSurvivesReaper = {
  status: 'running',
  startedAt: minAgo(50),
  updatedAt: minAgo(13)    // past silence 12, under reaper 15
};

const youngSilent = {
  status: 'running',
  startedAt: minAgo(10),   // under the age noise filter
  updatedAt: minAgo(10)
};

ok('B1 [THE BUG] a progressing old run must NOT alert', () => {
  assert.strictEqual(matches(progressing, STALLED), false,
    'a healthy long batch would page on age alone — the false-positive generator');
});

ok('B2 a silent-but-young-enough-to-survive-the-reaper run MUST alert', () => {
  assert.strictEqual(matches(silentSurvivesReaper, STALLED), true,
    'the only true-positive window (silence 12..15) is invisible');
});

ok('B3 a young silent run is noise — age filter keeps it out', () => {
  assert.strictEqual(matches(youngSilent, STALLED), false,
    'startedAt is the noise filter; dropping it pages a run that just started');
});

ok('B4 a reaped (failed) run is not selected — status is still required', () => {
  assert.strictEqual(matches({ ...silentSurvivesReaper, status: 'failed' }, STALLED), false);
});

ok('B5 a finished (done) run is not selected', () => {
  assert.strictEqual(matches({ ...silentSurvivesReaper, status: 'done' }, STALLED), false);
});

// ── The 'preparing' arm. This is the state with NO reaper, and until it was
// added here it also had no alert — so a run that died during expansion was
// invisible in both directions.
ok("B5b [MEASURED] a stale 'preparing' run MUST alert — nothing else watches it", () => {
  // Production, 2026-08-13: eight of these, oldest 8.3 days, every one
  // total=0/succeeded=0/failed=0 with updatedAt never moved off startedAt.
  // worker.js's reaper filters status:'running', so none of them will ever be
  // reaped, and this filter was 'running'-only, so none of them ever paged.
  const abandonedExpansion = {
    status: 'preparing',
    startedAt: minAgo(11919),
    updatedAt: minAgo(11919),
    total: 0, succeeded: 0, failed: 0
  };
  assert.strictEqual(matches(abandonedExpansion, STALLED), true,
    'a run that died during expansion is unreaped AND unalerted — silently generated nothing');
});

ok("B5c a fresh 'preparing' run is not selected — expansion is allowed to take time", () => {
  assert.strictEqual(matches({
    status: 'preparing', startedAt: minAgo(3), updatedAt: minAgo(3)
  }, STALLED), false,
    'the Director round legitimately runs for tens of seconds; the age filter must still apply');
});

ok("B5d 'preparing' is selected by the SAME silence rule, not a looser one", () => {
  // A preparing run that is old but still moving (mint progress bumping
  // updatedAt) must not page, exactly as for 'running'.
  assert.strictEqual(matches({
    status: 'preparing', startedAt: minAgo(600), updatedAt: minAgo(1)
  }, STALLED), false,
    'an actively-expanding long run would page — the same false positive B1 exists to prevent');
});

ok('B6 [REVERT-PROVE] the old startedAt-only predicate WOULD fire on B1', () => {
  // If someone "reverts" to age-only, this is the false positive we just
  // closed. Pinning the old shape so a future reader can see WHY B1 exists.
  const ageOnly = { status: 'running', startedAt: { $lt: minAgo(AGE_MIN) } };
  assert.strictEqual(matches(progressing, ageOnly), true,
    'the old predicate no longer reproduces the bug — B1 is unanchored');
  assert.strictEqual(matches(progressing, STALLED), false);
});

ok('B7 [REVERT-PROVE] the rejected updatedAt-at-age-threshold filter is empty vs the reaper', () => {
  // Swap startedAt for updatedAt at 45m: any running row that old has
  // already been flipped to failed by REAP_STALE_MIN (15). The silent-
  // survives-reaper true positive (idle 13m) would NOT match.
  const rejected = { status: 'running', updatedAt: { $lt: minAgo(AGE_MIN) } };
  assert.strictEqual(matches(silentSurvivesReaper, rejected), false,
    'the rejected design would miss the only true positive the reaper leaves');
  assert.strictEqual(matches(progressing, rejected), false);
});

ok('B8 the live filter carries BOTH startedAt and updatedAt (AGE ∧ SILENCE)', () => {
  assert.ok(STALLED.startedAt && STALLED.startedAt.$lt instanceof Date);
  assert.ok(STALLED.updatedAt && STALLED.updatedAt.$lt instanceof Date);
  // EXACT allow-list, not a literal. This pins both halves at once: that
  // 'preparing' is watched (it is the state the reaper cannot see — B5b), and
  // that 'done'/'failed' are still excluded (B4/B5). A `$nin`-shaped filter or
  // a widened list would fail here rather than quietly start paging on
  // finished runs.
  assert.deepStrictEqual(
    [...(STALLED.status.$in || [])].sort(),
    ['preparing', 'running'],
    'the stalled-run arm must watch exactly the two in-flight states');
  // Silence cutoff is more recent than the age cutoff — that is the
  // whole "silence sits under age / reap" relationship, observable
  // without hardcoding 12 or 15.
  assert.ok(STALLED.updatedAt.$lt > STALLED.startedAt.$lt,
    'silence cutoff must be more recent than the age cutoff');
});

ok('B9 explicit mins land in the filter (helper must not ignore its args)', () => {
  const f = buildStalledRunFilter({ now: NOW, ageMin: 40, silenceMin: 8 });
  assert.strictEqual(f.startedAt.$lt.getTime(), minAgo(40).getTime());
  assert.strictEqual(f.updatedAt.$lt.getTime(), minAgo(8).getTime());
});

// ── Group C — silence default is strictly below REAP_STALE_MIN.
// Read both from source / config. Hardcoding 12 < 15 here would let a
// future edit cross the boundary and recreate the empty set.

function parseReapDefault(workerSrc) {
  const m = workerSrc.match(
    /REAP_STALE_MIN\s*=\s*Math\.max\(\s*1\s*,\s*parseInt\(\s*process\.env\.REAP_STALE_MIN\s*,\s*10\s*\)\s*\|\|\s*(\d+)\s*\)/
  );
  assert.ok(m, 'could not parse REAP_STALE_MIN default from worker.js');
  return Number(m[1]);
}

function parseSilenceDefault(wdSrc) {
  const m = wdSrc.match(/N\(\s*['"]ALERT_RUN_SILENCE_MIN['"]\s*,\s*(\d+)\s*\)/);
  assert.ok(m, 'could not parse ALERT_RUN_SILENCE_MIN default from backlogWatchdog.js');
  return Number(m[1]);
}

const workerRaw = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const wdRaw = fs.readFileSync(path.join(ROOT, 'services', 'backlogWatchdog.js'), 'utf8');
const defaultsRaw = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');
const reapDefault = parseReapDefault(workerRaw);
const silenceDefault = parseSilenceDefault(wdRaw);

ok('C1 [EMPTY-SET BOUNDARY] silence default is strictly less than REAP_STALE_MIN', () => {
  assert.ok(Number.isFinite(reapDefault) && reapDefault > 0);
  assert.ok(Number.isFinite(silenceDefault) && silenceDefault >= 0);
  assert.ok(silenceDefault < reapDefault,
    `ALERT_RUN_SILENCE_MIN default ${silenceDefault} is not < REAP_STALE_MIN ${reapDefault} — ` +
    'crossing that boundary recreates the empty set');
});

ok('C2 runtime getters agree with the parsed source defaults (no process.env override in this harness)', () => {
  assert.strictEqual(RUN_SILENCE_MIN(), silenceDefault);
  assert.strictEqual(RUN_STALE_MIN(), 45);
});

ok('C3 defaults.env ALERT_RUN_SILENCE_MIN matches the code default and is < REAP', () => {
  const m = defaultsRaw.match(/^ALERT_RUN_SILENCE_MIN=(\d+)\s*$/m);
  assert.ok(m, 'config/defaults.env must declare ALERT_RUN_SILENCE_MIN');
  const fileVal = Number(m[1]);
  assert.strictEqual(fileVal, silenceDefault,
    'defaults.env and the N() default disagree — one of them is a silent lie');
  assert.ok(fileVal < reapDefault);
});

ok('C4 defaults.env / watchdog comment names the REAP_STALE_MIN relationship', () => {
  // A future editor who raises the number without reading the comment
  // still has C1, but the comment is what stops them raising it on
  // purpose. Strip nothing — we WANT to see the comment.
  assert.ok(/REAP_STALE_MIN/.test(wdRaw) && /structurally empty set/.test(wdRaw),
    'backlogWatchdog must state why silence sits under REAP_STALE_MIN');
  assert.ok(/ALERT_RUN_SILENCE_MIN/.test(defaultsRaw) && /REAP_STALE_MIN/.test(defaultsRaw));
});

// ── Group D — the terminal `done` guard. Evaluate the REAL filter.

const DONE_FILTER = buildTerminalDoneFilter(RUN_ID);

ok('D1 a normal running run may become done', () => {
  assert.strictEqual(matches({ _id: RUN_ID, status: 'running' }, DONE_FILTER), true);
});

ok('D2 a preparing run may become done (legal in-flight transition)', () => {
  assert.strictEqual(matches({ _id: RUN_ID, status: 'preparing' }, DONE_FILTER), true);
});

ok('D3 [THE BUG] a failed run must NOT become done', () => {
  assert.strictEqual(matches({ _id: RUN_ID, status: 'failed' }, DONE_FILTER), false,
    'the reaper\'s failed verdict would be overwritten');
});

ok('D4 an already-done run is a no-op (not rewritten)', () => {
  assert.strictEqual(matches({ _id: RUN_ID, status: 'done' }, DONE_FILTER), false);
});

ok('D5 [REVERT-PROVE] the unguarded `{ _id }` filter WOULD match a failed run', () => {
  const unguarded = { _id: RUN_ID };
  assert.strictEqual(matches({ _id: RUN_ID, status: 'failed' }, unguarded), true,
    'the old predicate no longer reproduces the bug — D3 is unanchored');
  assert.strictEqual(matches({ _id: RUN_ID, status: 'failed' }, DONE_FILTER), false);
});

ok('D6 a different run id never matches', () => {
  assert.strictEqual(matches({ _id: '64b0000000000000000000bb', status: 'running' }, DONE_FILTER), false);
});

ok('D7 allow-list is exactly the in-flight CampaignRun pair — not a guessed cancelled', () => {
  assert.deepStrictEqual([...DONE_ELIGIBLE_STATUSES].sort(), ['preparing', 'running']);
  assert.ok(!DONE_ELIGIBLE_STATUSES.includes('cancelled'));
  assert.ok(!DONE_ELIGIBLE_STATUSES.includes('failed'));
  assert.ok(!DONE_ELIGIBLE_STATUSES.includes('done'));
});

ok('D8 a hypothetical CampaignRun.status=\'cancelled\' would stay cancelled', () => {
  // The enum does not have this name TODAY (F2 pins that). The allow-list
  // is what keeps a future addition from being flipped back to done —
  // the thing the task asked us to think about before choosing the
  // predicate. A $nin:['failed'] would not.
  assert.strictEqual(matches({ _id: RUN_ID, status: 'cancelled' }, DONE_FILTER), false);
});

// ── Group E — live wiring. Comments STRIPPED so a check cannot pass on
// its own explanatory prose (same lesson as verifyTitlingOrphanResume E*).
const adsSrc = stripComments(fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8'));
const adsRaw = fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8');
const wdSrc = stripComments(wdRaw);
const guardsSrc = stripComments(
  fs.readFileSync(path.join(ROOT, 'services', 'campaignRunGuards.js'), 'utf8')
);
const modelSrc = fs.readFileSync(path.join(ROOT, 'models', 'CampaignRun.js'), 'utf8');
const opSrc = fs.readFileSync(path.join(ROOT, 'models', 'OperationRun.js'), 'utf8');

ok('E1 the render-loop done write uses buildTerminalDoneFilter', () => {
  // Scope to the end-of-loop write, not any other done stamp. The
  // surrounding progressRun.succeed / 'done in' log is unique to this site.
  const i = adsSrc.indexOf('progressRun.succeed');
  assert.ok(i > 0, 'could not locate the render-loop close-out');
  const block = adsSrc.slice(Math.max(0, i - 800), i);
  assert.ok(/CampaignRun\.updateOne\(/.test(block), 'no CampaignRun.updateOne before progressRun.succeed');
  assert.ok(/buildTerminalDoneFilter\(\s*run\._id\s*\)/.test(block),
    'the live write must use buildTerminalDoneFilter, or these checks test a copy');
});

ok('E2 ads.js IMPORTS buildTerminalDoneFilter (a call without an import is a ReferenceError)', () => {
  assert.ok(
    /require\(\s*['"]\.\.\/services\/campaignRunGuards['"]\s*\)/.test(adsRaw),
    'routes/ads.js must require services/campaignRunGuards'
  );
  assert.ok(/buildTerminalDoneFilter/.test(adsRaw.match(/require\(\s*['"]\.\.\/services\/campaignRunGuards['"]\s*\)/)
    ? adsRaw.slice(0, adsRaw.indexOf("require('../services/campaignRunGuards')") + 80)
    : adsRaw));
  // Destructure pin — the unbound-identifier incident: a call without
  // the binding shipped to prod with a green source-text harness.
  assert.ok(/\{\s*buildTerminalDoneFilter\s*\}/.test(adsRaw),
    'buildTerminalDoneFilter must be destructured from that require');
});

ok('E3 the live watchdog query uses buildStalledRunFilter', () => {
  assert.ok(/CampaignRun\.find\(\s*buildStalledRunFilter\(/.test(wdSrc),
    'the live query must use buildStalledRunFilter, or these checks test a copy');
});

ok('E4 buildStalledRunFilter is defined in backlogWatchdog and lists both timestamps', () => {
  assert.ok(/function buildStalledRunFilter/.test(wdSrc));
  const i = wdSrc.indexOf('function buildStalledRunFilter');
  const body = wdSrc.slice(i, i + 700);
  assert.ok(/startedAt:/.test(body) && /updatedAt:/.test(body),
    'the helper itself must carry AGE ∧ SILENCE — not just the comment');
});

ok('E5 the render-loop done write is no longer an unguarded `{ _id: run._id }` + status:done', () => {
  // The defect: updateOne({ _id: run._id }, { status: 'done', ... }).
  // After the fix the filter is the helper. Pin that THIS site no longer
  // has the unguarded shape; other early-exit done writes are out of scope.
  const i = adsSrc.indexOf('progressRun.succeed');
  const block = adsSrc.slice(Math.max(0, i - 800), i);
  assert.ok(!/updateOne\(\s*\{\s*_id:\s*run\._id\s*\}/.test(block),
    'the render-loop done write is still unguarded');
});

ok('E6 campaignRunGuards exports the same allow-list the filter uses', () => {
  assert.ok(/DONE_ELIGIBLE_STATUSES/.test(guardsSrc));
  assert.ok(/status:\s*\{\s*\$in:/.test(guardsSrc));
});

// ── Group F — enum pins. Do NOT guess a status name.
ok('F1 CampaignRun.status enum is exactly preparing|running|done|failed', () => {
  const m = modelSrc.match(/status:\s*\{\s*type:\s*String,\s*enum:\s*\[([^\]]+)\]/);
  assert.ok(m, 'could not parse CampaignRun.status enum');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(names, ['preparing', 'running', 'done', 'failed']);
});

ok('F2 CampaignRun has no cancelled — that name lives on OperationRun', () => {
  const m = modelSrc.match(/status:\s*\{\s*type:\s*String,\s*enum:\s*\[([^\]]+)\]/);
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(!names.includes('cancelled') && !names.includes('cancelling'));
  assert.ok(/'cancelled'/.test(opSrc) && /'cancelling'/.test(opSrc),
    'progressService cancellation names should still be on OperationRun');
});

ok('F3 DONE_ELIGIBLE_STATUSES is a subset of the parsed CampaignRun enum', () => {
  const m = modelSrc.match(/status:\s*\{\s*type:\s*String,\s*enum:\s*\[([^\]]+)\]/);
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  for (const s of DONE_ELIGIBLE_STATUSES) {
    assert.ok(names.includes(s), `allow-list status '${s}' is not on the CampaignRun enum`);
  }
});

if (process.exitCode) {
  console.log(`\n❌ verifyRunAlertsAndDoneGuard: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyRunAlertsAndDoneGuard: ${checks}/${checks} checks passed`);
}
