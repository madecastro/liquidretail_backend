#!/usr/bin/env node
'use strict';
//
// verifyCampaignRunHeartbeat — pins the CampaignRun liveness heartbeat.
// Pure + offline: no DB, no network, no API key. Mongoose is required only to
// read the COMPILED schema (group C); nothing connects.
//
// ── THE MEASURED DEFECT ───────────────────────────────────────────────────
// run_1787105727540_e8c94542, 2026-08-18, one product, Meta + PMax
// "Everything", 39 claimed ads:
//
//   02:15:27Z  startedAt
//   ~02:21     18 statics settled. Every remaining row is video.
//   02:21-02:36  video titling. ZERO writes to the CampaignRun row — the only
//              thing that ever moved its `updatedAt` was the per-ad
//              `$inc {succeeded|failed|skipped}` that fires when an ad SETTLES
//              (mongoose refreshes updatedAt on this timestamps:true schema).
//   02:36:29Z  worker.js reapOrphans() matched
//              `{ status:'running', updatedAt: { $lt: now - REAP_STALE_MIN } }`
//              and stamped the run `failed`. Final doc: succeeded 18, failed 0,
//              skipped 0, total 39, **errors: []**. Nothing threw. It was
//              working the entire time.
//   Same tick  the Ad sweep flipped this run's claimed-but-UNDISPATCHED tail
//              (21 video rows minus VEO_CONCURRENCY=12 dispatched = 9) from
//              'rendering' to 'queued' on the identical silence. Those 9 —
//              the 4:5 derive and the staged Meta funnel variants — were
//              stranded permanently. The operator paid for the masters and
//              silently received 30 of 39 creatives.
//
// So the reaper's predicate did not mean "this run is alive". It meant "an ad
// settled recently". Those diverge whenever a run's work is long and
// serialised — which, since video went to 10s on both platforms and Meta+PMax
// began sharing ONE 9:16 master (15 of 21 video rows behind a single plate,
// titling serialised behind REMOTION_QUEUE_CONCURRENCY=4), is the normal shape
// of a mixed run rather than an edge case.
//
// ── THE FIX, in the four parts this harness pins ──────────────────────────
//   1. services/campaignRunHeartbeat.js — a ~60s ticker that writes
//      `{ $set: { updatedAt, lastHeartbeatAt } }` to `{ _id, status:'running' }`
//      and NOTHING else, plus the Ad arm that beats the run's still-'rendering'
//      rows with the same filter/update the render loop already used on every
//      completion.
//   2. It is GATED on real in-flight work (`pools.some(p => p.inflight > 0)`).
//      An unconditional beat would defeat the reaper and resurrect the wedged-
//      run-lives-forever class the reaper exists to kill. Group E.
//   3. It stops on EVERY exit path — the `catch` AND the `finally` around the
//      pool drain, and `unref()` so it can never hold the process open.
//      Group D, structurally (comment lines stripped first, so a commented-out
//      `runHeartbeat.stop()` cannot satisfy the check).
//   4. `lastHeartbeatAt` is DECLARED on models/CampaignRun.js. This schema is
//      strict; an undeclared path is silently DROPPED (the trap that lost
//      `renderError.predictionId`). Group C asserts through the REAL compiled
//      mongoose path and demonstrates the drop, not the source text.
//
// The interval is derived from the ONE shared parser (services/staleness.js —
// PR #207 unified two divergent parsers; there must not be a third), and group
// A asserts the RELATIONSHIP to the reaper cutoff at many REAP_STALE_MIN
// values rather than a hardcoded number.
//
// Group F is the headline: it drives the REAL exported reaper predicate
// (campaignRunGuards.buildStaleRunningFilter — reused, not reimplemented here)
// against a simulated timeline, and shows a beating run is NOT reaped while a
// genuinely silent one IS. F3 replays the incident above in both arms, so the
// counterfactual proves the fix does something.
//
// ── REVERT-PROVE (each mutation must fail the NAMED check) ────────────────
//    1. Delete the `runHeartbeat.stop()` in the CATCH arm (routes/ads.js)
//         → D4 fails
//    2. Delete the `runHeartbeat.stop()` in the FINALLY arm
//         → D5 fails
//    3. Comment out BOTH stop() calls (leaving the words in a comment)
//         → D4 + D5 fail (comment lines are stripped before the scan)
//    4. Change `isWorking` to `() => true` at the call site
//         → D3 fails
//    5. Make the ticker beat regardless of isWorking (drop the gate in
//       startRunHeartbeat)
//         → E1 + E3 fail — the wedged-run resurrection
//
//   (All fourteen were run against this harness on 2026-08-18; the check names
//   above are the OBSERVED failures, not predicted ones.)
//    6a. Add `total: 0` to buildRunHeartbeatUpdate
//         → B1 + B3 + E2 fail
//    6b. Add `$inc: { succeeded: 1 }` to it
//         → B1 + E2 + F1 + F3 + F4 fail
//    7. Drop `status: 'running'` from buildRunHeartbeatFilter
//         → B5 + E2 + F5 fail (a beat could resurrect a reaped run)
//    8. Remove `lastHeartbeatAt` from models/CampaignRun.js
//         → C1 + C2 + C4 fail (C4 shows the write would be silently dropped)
//    9a. Raise HEARTBEAT_CAP_MS above the Ad beat's 60s
//         → A3 fails. (NOT A2 — the MIN_BEATS_PER_WINDOW divisor still binds,
//           which is the derivation doing its job. The cap is pinned separately
//           because it is a cadence claim, not a safety one.)
//    9b. Drop the MIN_BEATS_PER_WINDOW divisor from runHeartbeatMs()
//         → A2 fails (asserted as a relationship, at 13 REAP_STALE_MIN values)
//   10. Re-parse REAP_STALE_MIN inline in campaignRunHeartbeat.js instead of
//       importing reapStaleMin
//         → A4 fails (the third-parser ban)
//   11. Drop the import of startRunHeartbeat from routes/ads.js while keeping
//       the call (the unbound-identifier production class, CLAUDE.md §5)
//         → D1 fails
//   12. Re-inline `{ _id: {$in: adIds}, status:'rendering' }` at the
//       per-completion write instead of the shared builder
//         → D7 fails (the timer beat and the completion beat would drift)
//   13. Hand-roll the running-reap filter back inline in worker.js
//         → G2 fails (and verifyPreparingReap G5d)
//   14. Restore docs/ALERTING.md's "CampaignRun has no periodic heartbeat of
//       its own"
//         → G3 fails (that sentence is now false)
//
//   ── Added after adversarial review, 2026-08-18. Every one of these pins a
//      hole or a false claim the FIRST design shipped with; they are the reason
//      this list is worth reading. ──
//   15. Remove the RUN_HEARTBEAT_MAX_MS lifetime cap from startRunHeartbeat
//         → E7 fails — a renderOne that never settles holds inflight > 0
//           forever, so the run (and, via the Ad arm, its whole claimed
//           'rendering' set) would be immortal. Strictly worse than
//           pre-heartbeat behaviour for a wedged loop.
//   16. Set the cap to anything other than progressService.MAX_RUN_MS
//         → E7b fails — two heartbeats for one ad-batch run must expire together
//   17. Restore the "both land the same value" claim about updatedAt
//         → B2 fails — mongoose 7 discards the explicit value
//   18. Restore "the floor makes >=5 beats always fit"
//         → A2b fails — the floor is what BREAKS the margin below a ~25s window
//   19. / 20. Reinstate either retired liveness claim in campaignRunGuards.js
//       ("the per-ad $inc proves liveness" / "no periodic heartbeat of its own")
//         → G5 fails. This check found a FOURTH surviving copy that three
//           passes of hand-reading had missed.
//
//   ── Added 2026-08-20, tracing run_1787263897396_ef1fcb32 (9/9 Ads delivered,
//      CampaignRun stuck 'running' until the operator cancelled it). ──
//   21. Remove the leading beat (the isWorking()-gated write before
//       setInterval starts) from startRunHeartbeat
//         → E8 fails — a batch whose claimed work settles inside the first
//           intervalMs window would go back to lastHeartbeatAt:null for its
//           entire life even though it was genuinely alive throughout.
//   22. Make the leading beat unconditional (drop its own isWorking() check)
//         → E9 fails — an idle run would get exactly one beat it should
//           never have gotten, weakening the reaper by one write's worth.
//
//   node scripts/verifyCampaignRunHeartbeat.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
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
} = require('../services/campaignRunHeartbeat');

// THE REAL REAPER PREDICATE — reused, never reimplemented. A harness that
// rewrites `{ status:'running', updatedAt: { $lt: cutoff } }` locally proves
// only that the harness agrees with itself.
const { buildStaleRunningFilter } = require('../services/campaignRunGuards');
const { reapStaleMin, REAP_STALE_MIN_DEFAULT } = require('../services/staleness');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};
const okA = async (label, fn) => {
  try { await fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyCampaignRunHeartbeat\n');

const ROOT = path.join(__dirname, '..');
const adsSrc       = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const workerSrc    = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const heartbeatSrc = fs.readFileSync(path.join(ROOT, 'services/campaignRunHeartbeat.js'), 'utf8');

// ── Minimal Mongo helpers. Deliberately not general: they throw on any
// operator they do not implement, so a filter that grows a new operator cannot
// be silently mis-evaluated into a false pass.
function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$lt') { if (!(value != null && value < operand)) return false; }
      else if (op === '$gte') { if (!(value != null && value >= operand)) return false; }
      else if (op === '$in') { if (!operand.some((o) => String(o) === String(value))) return false; }
      else throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
    }
    return true;
  }
  return String(value) === String(cond);
}
function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key.startsWith('$')) throw new Error(`matcher does not implement top-level ${key}`);
    if (!matchOp(doc[key], cond)) return false;
  }
  return true;
}
// Apply a heartbeat update the way Mongo would, but ONLY if the filter matches
// — which is the whole point of scoping the beat to status:'running'.
function applyIfMatches(doc, filter, update) {
  if (!matches(doc, filter)) return false;
  assert.deepStrictEqual(Object.keys(update), ['$set'],
    'the heartbeat update must be a bare $set — no $inc, no $push, no $unset');
  Object.assign(doc, update.$set);
  return true;
}

// Comment-stripped view of a source file: every line whose TRIMMED form starts
// a comment is dropped. This is what makes group D "a scan, not a regex a
// comment satisfies" — a commented-out `runHeartbeat.stop()` disappears before
// the scan ever sees it.
function stripCommentLines(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}
const adsCode       = stripCommentLines(adsSrc);
const heartbeatCode = stripCommentLines(heartbeatSrc);

// The env var is read lazily by the shared parser, so save/restore around the
// sweeps below rather than leaking a value into later groups.
const ENV_SAVE = process.env.REAP_STALE_MIN;
const withReapMin = (v, fn) => {
  if (v === undefined) delete process.env.REAP_STALE_MIN;
  else process.env.REAP_STALE_MIN = String(v);
  try { return fn(); }
  finally {
    if (ENV_SAVE === undefined) delete process.env.REAP_STALE_MIN;
    else process.env.REAP_STALE_MIN = ENV_SAVE;
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Group A — the INTERVAL, and its relationship to the reaper cutoff.
// Asserted as a relationship derived from the SHARED parser, never against a
// hardcoded 900000.
// ══════════════════════════════════════════════════════════════════════════
ok('A1 the beat interval is strictly less than the reaper cutoff at the documented default', () => {
  withReapMin(undefined, () => {
    const cutoffMs = reapStaleMin() * 60 * 1000;
    assert.strictEqual(reapStaleMin(), REAP_STALE_MIN_DEFAULT,
      'sanity: an unset REAP_STALE_MIN must resolve to the documented default');
    assert.ok(runHeartbeatMs() < cutoffMs,
      `interval ${runHeartbeatMs()}ms must be < the reaper cutoff ${cutoffMs}ms`);
  });
});

// Below this window the FLOOR wins over the divisor and the >=5-beat margin
// cannot hold. Derived, not hardcoded, so it tracks either constant.
const FLOOR_BINDS_BELOW_MS = MIN_BEATS_PER_WINDOW * HEARTBEAT_FLOOR_MS;

ok('A2 at least MIN_BEATS_PER_WINDOW beats fit inside the reaper window at EVERY sane REAP_STALE_MIN', () => {
  // The margin, stated as an inequality rather than a number: a run must have
  // to miss this many CONSECUTIVE independent Mongo writes before the reaper
  // can touch it. Sweeps real values an operator might set, the fractions
  // services/staleness.positiveMinutes deliberately accepts, and the nonsense
  // values it falls back on. Sub-boundary fractions are A2b's job — asserting
  // them here would be asserting something false.
  const cases = [undefined, '', '   ', '0', '-5', 'abc', '0.5', '1', '2', '5', '7.9', '15', '30', '120'];
  for (const raw of cases) {
    withReapMin(raw, () => {
      const cutoffMs = reapStaleMin() * 60 * 1000;
      const beat = runHeartbeatMs();
      assert.ok(Number.isFinite(beat) && beat > 0,
        `REAP_STALE_MIN=${JSON.stringify(raw)} produced a non-positive interval ${beat}`);
      assert.ok(cutoffMs >= FLOOR_BINDS_BELOW_MS,
        `case ${JSON.stringify(raw)} belongs in A2b, not here — its window ${cutoffMs}ms is below the ` +
        `${FLOOR_BINDS_BELOW_MS}ms boundary where the floor starts binding`);
      assert.ok(beat * MIN_BEATS_PER_WINDOW <= cutoffMs,
        `REAP_STALE_MIN=${JSON.stringify(raw)}: ${MIN_BEATS_PER_WINDOW} beats of ${beat}ms ` +
        `(${beat * MIN_BEATS_PER_WINDOW}ms) must fit inside the ${cutoffMs}ms reaper window — ` +
        'the margin is the whole reason a transient Mongo blip is survivable');
      assert.ok(beat >= HEARTBEAT_FLOOR_MS,
        `REAP_STALE_MIN=${JSON.stringify(raw)}: interval ${beat}ms fell below the ${HEARTBEAT_FLOOR_MS}ms ` +
        'floor — a fractional window must not turn the beat into a Mongo spin loop');
    });
  }
});

ok('A2b the floor/divisor conflict below a ~25s window is EXACTLY where the code says it is', () => {
  // Adversarial review (2026-08-18) caught A2 claiming "EVERY sane value" while
  // testing no fraction small enough to expose the boundary, and the docs
  // claiming the FLOOR is what makes >=5 beats fit when it is what breaks it.
  // Pinned as an explicit, named boundary so neither the claim nor the constant
  // can drift back into a comfortable falsehood.
  //
  // The degradation is accepted, not fixed: at a sub-25-second reap window the
  // pre-existing hard-60s Ad heartbeat in routes/ads.js is already hopeless and
  // the reaper would be requeuing live renders seconds after they claim, so
  // this is not the binding failure at that setting.
  const boundaryMin = FLOOR_BINDS_BELOW_MS / 60000;
  // Just ABOVE the boundary the invariant still holds exactly.
  withReapMin(String(boundaryMin), () => {
    assert.strictEqual(runHeartbeatMs() * MIN_BEATS_PER_WINDOW, reapStaleMin() * 60 * 1000,
      'at the boundary the divisor and the floor must meet exactly');
  });
  // Below it the floor binds and the margin degrades — assert the SHAPE of the
  // degradation, so a silent change to either constant is visible here.
  for (const raw of ['0.4', '0.2', '0.1']) {
    withReapMin(raw, () => {
      assert.strictEqual(runHeartbeatMs(), HEARTBEAT_FLOOR_MS,
        `below the boundary the floor must be what binds, not the divisor (REAP_STALE_MIN=${raw})`);
      assert.ok(runHeartbeatMs() * MIN_BEATS_PER_WINDOW > reapStaleMin() * 60 * 1000,
        `REAP_STALE_MIN=${raw} is documented as degraded — if this ever starts holding, the ` +
        'code got better and the comment in campaignRunHeartbeat.js must be updated to say so');
    });
  }
  const heartbeatFlat = heartbeatSrc.replace(/\n\s*\/\/\s?/g, ' ');
  assert.ok(/does not pretend to make an absurd value safe/.test(heartbeatFlat),
    'the source must state the degradation rather than claim the floor guarantees the margin');
  assert.ok(!/floor(ed)?[^.]{0,40}so (that )?(>=|≥)?\s*\d*\s*beats always fit/i.test(heartbeatFlat),
    'the floor does not make the margin hold — it is what breaks it below the boundary');
});

ok('A3 the cap matches the Ad heartbeat cadence already in production (60s), and is the binding value at the default', () => {
  assert.strictEqual(HEARTBEAT_CAP_MS, 60_000,
    'the run beat must share the Ad beat\'s cadence — there is no reason for a run to beat on a different clock than the ads inside it');
  assert.ok(/\}, 60_000\);/.test(adsCode),
    'routes/ads.js renderOne() must still carry its own 60s Ad heartbeat — this cap is justified by that precedent');
  withReapMin(undefined, () => {
    assert.strictEqual(runHeartbeatMs(), HEARTBEAT_CAP_MS,
      'at the documented REAP_STALE_MIN the cap (not the divisor) must be what binds — 15 beats per window');
  });
});

ok('A4 the interval is derived through the ONE shared parser — campaignRunHeartbeat.js adds no third parser', () => {
  assert.ok(/require\(\s*['"]\.\/staleness['"]\s*\)/.test(heartbeatCode),
    'campaignRunHeartbeat.js must import services/staleness');
  assert.ok(/reapStaleMin/.test(heartbeatCode),
    'the interval must be derived from reapStaleMin(), not from a literal window');
  assert.ok(!/process\.env\.REAP_STALE_MIN/.test(heartbeatCode),
    'campaignRunHeartbeat.js must NOT read REAP_STALE_MIN itself — PR #207 unified two divergent ' +
    'parsers into services/staleness.js and a third is exactly the drift that fix removed');
  assert.ok(!/parseInt|parseFloat/.test(heartbeatCode),
    'no inline minute parsing in campaignRunHeartbeat.js');
});

// ══════════════════════════════════════════════════════════════════════════
// Group B — the WRITE. It must corrupt no progress semantics.
// ══════════════════════════════════════════════════════════════════════════
const FORBIDDEN_PATHS = Object.freeze([
  'total', 'succeeded', 'failed', 'skipped',
  'mintedTotal', 'unclaimedAtStart',
  'status', 'completedAt', 'errors', 'perProduct', 'notice', 'startedAt'
]);

ok('B1 buildRunHeartbeatUpdate writes EXACTLY updatedAt + lastHeartbeatAt, via a bare $set', () => {
  const now = new Date('2026-08-18T02:30:00Z');
  const u = buildRunHeartbeatUpdate(now);
  assert.deepStrictEqual(Object.keys(u), ['$set'],
    'the heartbeat must be a bare $set — an $inc here would corrupt the run counters');
  assert.deepStrictEqual(Object.keys(u.$set).sort(), ['lastHeartbeatAt', 'updatedAt']);
  assert.strictEqual(u.$set.updatedAt.getTime(), now.getTime());
  assert.strictEqual(u.$set.lastHeartbeatAt.getTime(), now.getTime());
});

ok('B2 updatedAt is set EXPLICITLY, and the source is honest that mongoose overwrites it today', () => {
  // Adversarial review (2026-08-18): an earlier comment claimed the explicit
  // value and mongoose's "both land the same value". They are two different
  // Date objects — on a timestamps:true schema mongoose 7 rewrites
  // $set.updatedAt with its own `now` (applyTimestampsToUpdate.js, non-dotted
  // path, no already-set guard). Nothing depends on which wins (microseconds
  // apart in one call), but the comment must not assert something false.
  const u = buildRunHeartbeatUpdate(new Date());
  assert.ok(u.$set.updatedAt instanceof Date,
    'buildRunHeartbeatUpdate must set updatedAt itself');
  assert.ok(/updatedAt/.test(heartbeatCode),
    'the source must name updatedAt in the update, not rely on mongoose injecting it');
  assert.ok(/applyTimestampsToUpdate/.test(heartbeatSrc),
    'the source must record that mongoose discards the explicit value today, and why it is written anyway');
  assert.ok(!/[Bb]oth land the same value/.test(heartbeatSrc),
    'that claim is false — mongoose supplies its own now');
});

ok('B3 no forbidden path appears in the heartbeat update — total and the outcome counters are untouchable', () => {
  const u = buildRunHeartbeatUpdate(new Date());
  for (const bad of FORBIDDEN_PATHS) {
    assert.ok(!(bad in u.$set),
      `the heartbeat wrote ${bad} — total is the claim count and the progress denominator, ` +
      'and succeeded/failed/skipped are the run\'s audit; a heartbeat that moves either tells ' +
      'the operator work happened that did not');
  }
});

ok('B4 the Ad arm is byte-identical in shape to the per-completion write the render loop already does', () => {
  const now = new Date('2026-08-18T02:30:00Z');
  const ids = ['64b0000000000000000000a1', '64b0000000000000000000a2'];
  assert.deepStrictEqual(buildClaimedAdHeartbeatFilter(ids), { _id: { $in: ids }, status: 'rendering' });
  assert.deepStrictEqual(buildClaimedAdHeartbeatUpdate(now), { $set: { updatedAt: now } });
  // status:'rendering' scoping is what stops it resurrecting an ad the cancel
  // path already archived or re-queued.
  const f = buildClaimedAdHeartbeatFilter(ids);
  assert.strictEqual(matches({ _id: ids[0], status: 'rendering' }, f), true);
  assert.strictEqual(matches({ _id: ids[0], status: 'queued' },    f), false);
  assert.strictEqual(matches({ _id: ids[0], status: 'archived' },  f), false);
  assert.strictEqual(matches({ _id: ids[0], status: 'draft' },     f), false);
  assert.strictEqual(matches({ _id: 'not-in-this-run', status: 'rendering' }, f), false,
    'the Ad arm must never reach outside this run\'s claimed ids');
});

ok('B5 the run filter pins _id AND status:running — it cannot touch a preparing, done or reaped run', () => {
  const id = '64b0000000000000000000aa';
  const f = buildRunHeartbeatFilter(id);
  assert.deepStrictEqual(f, { _id: id, status: 'running' });
  assert.strictEqual(matches({ _id: id, status: 'running' },   f), true);
  assert.strictEqual(matches({ _id: id, status: 'failed' },    f), false,
    'a beat racing the reaper must NOT resurrect a run already stamped failed');
  assert.strictEqual(matches({ _id: id, status: 'done' },      f), false);
  assert.strictEqual(matches({ _id: id, status: 'preparing' }, f), false,
    'the preparing lifecycle is governed by MINT AGE precisely because it has no liveness ' +
    'signal — manufacturing one here would silently disable the preparing reap');
  assert.strictEqual(matches({ _id: 'someone-elses-run', status: 'running' }, f), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Group C — the SCHEMA declaration, through the REAL compiled mongoose path.
// ══════════════════════════════════════════════════════════════════════════
const CampaignRun = require('../models/CampaignRun');

ok('C1 lastHeartbeatAt is DECLARED on the compiled CampaignRun schema as a Date', () => {
  const p = CampaignRun.schema.path('lastHeartbeatAt');
  assert.ok(p, 'models/CampaignRun.js must declare lastHeartbeatAt — this schema is strict, so an ' +
    'undeclared path is silently DROPPED on write (the trap that lost renderError.predictionId)');
  assert.strictEqual(p.instance, 'Date');
});

ok('C2 EVERY path the heartbeat writes is declared — derived from the real update, not a hardcoded list', () => {
  // Deliberately generated from buildRunHeartbeatUpdate so that ADDING a field
  // to the heartbeat without declaring it fails here, which is the whole
  // failure mode this group exists for.
  for (const key of Object.keys(buildRunHeartbeatUpdate(new Date()).$set)) {
    assert.ok(CampaignRun.schema.path(key),
      `the heartbeat writes '${key}' but models/CampaignRun.js does not declare it — ` +
      'mongoose strict will drop that write in silence and the beat will store nothing');
  }
});

ok('C3 the schema is STRICT, which is what makes C1/C2 load-bearing rather than tidiness', () => {
  assert.notStrictEqual(CampaignRun.schema.options.strict, false,
    'if strict were off, an undeclared path would persist and C1/C2 would be cosmetic');
});

ok('C4 demonstrated: a declared heartbeat field survives casting, an undeclared one is dropped', () => {
  const at = new Date('2026-08-18T02:30:00Z');
  const doc = new CampaignRun({
    runId: 'harness-run', brandId: '64b0000000000000000000aa', campaignId: '64b0000000000000000000ab',
    lastHeartbeatAt: at,
    // The counterfactual — what an UNDECLARED heartbeat field would do.
    lastHeartbeatAtUndeclared: at
  });
  assert.strictEqual(doc.lastHeartbeatAt && doc.lastHeartbeatAt.getTime(), at.getTime(),
    'the declared field must survive');
  assert.strictEqual(doc.lastHeartbeatAtUndeclared, undefined,
    'sanity: strict really does drop an undeclared path — this is why C1/C2 matter');
});

// ══════════════════════════════════════════════════════════════════════════
// Group D — WIRING into the render loop, and STOP on every exit path.
// Structural, over comment-stripped source.
// ══════════════════════════════════════════════════════════════════════════
ok('D1 routes/ads.js IMPORTS startRunHeartbeat (a call without an import is a ReferenceError)', () => {
  // CLAUDE.md §5: this repo has shipped that exact ReferenceError to prod three
  // times, and neither a source-text harness nor `node --check` can see it.
  assert.ok(
    /const\s*\{[^}]*startRunHeartbeat[^}]*\}\s*=\s*require\(\s*['"]\.\.\/services\/campaignRunHeartbeat['"]\s*\)/s
      .test(adsCode),
    'routes/ads.js must destructure startRunHeartbeat from ../services/campaignRunHeartbeat');
  for (const name of ['buildClaimedAdHeartbeatFilter', 'buildClaimedAdHeartbeatUpdate']) {
    assert.ok(new RegExp(`const\\s*\\{[^}]*${name}[^}]*\\}\\s*=\\s*require\\(\\s*['"]\\.\\./services/campaignRunHeartbeat['"]\\s*\\)`, 's').test(adsCode),
      `routes/ads.js uses ${name} at the per-completion write and must import it`);
  }
});

// One structural read of runRenderLoop, shared by D2-D6.
const LOOP_START = adsCode.indexOf('async function runRenderLoop(');
const LOOP_SRC = LOOP_START === -1 ? '' : adsCode.slice(LOOP_START, adsCode.indexOf('\nasync function ', LOOP_START + 10));
const I_START   = LOOP_SRC.indexOf('const runHeartbeat = startRunHeartbeat({');
const I_TRY     = LOOP_SRC.indexOf('\n  try {', I_START);
const I_POOLS   = LOOP_SRC.indexOf('await Promise.all(pools.map(', I_TRY);
const I_CATCH   = LOOP_SRC.indexOf('\n  } catch (', I_POOLS);
const I_FINALLY = LOOP_SRC.indexOf('\n  } finally {', I_CATCH);
const I_ENDBLK  = LOOP_SRC.indexOf('\n  }\n', I_FINALLY);

ok('D2 the heartbeat is STARTED inside runRenderLoop, before the pool drain', () => {
  assert.notStrictEqual(LOOP_START, -1, 'runRenderLoop must exist in routes/ads.js');
  assert.notStrictEqual(I_START, -1, 'runRenderLoop must start a CampaignRun heartbeat');
  assert.notStrictEqual(I_POOLS, -1, 'the pool drain must still be `await Promise.all(pools.map(`');
  assert.ok(I_START < I_POOLS, 'the heartbeat must start BEFORE the drain it is protecting');
  assert.ok(/runDocId:\s*run\._id/.test(LOOP_SRC.slice(I_START, I_START + 400)),
    'the heartbeat must be pointed at THIS run\'s _id');
  assert.ok(/\n\s*adIds,/.test(LOOP_SRC.slice(I_START, I_START + 400)),
    'the heartbeat must be handed this run\'s claimed adIds — without them the ' +
    'claimed-but-undispatched tail is still reaped out from under a live run (the 9 stranded rows)');
});

ok('D3 the beat is GATED on the render loop\'s REAL in-flight count — not a constant', () => {
  const call = LOOP_SRC.slice(I_START, I_START + 400);
  const m = call.match(/isWorking:\s*\(\)\s*=>\s*([^\n]+)/);
  assert.ok(m, 'the heartbeat call must pass an isWorking predicate');
  const expr = m[1].trim();
  assert.ok(/pools\b/.test(expr) && /inflight/.test(expr),
    `isWorking must read the pools' own inflight counters, got: ${expr}`);
  assert.ok(!/^\s*(true|1|!!1)\b/.test(expr),
    'a truthy constant would beat unconditionally and defeat the reaper entirely — ' +
    'resurrecting the wedged-run-lives-forever class the reaper exists to kill');
  // The gate must read the SAME counters the loop uses to decide it is done.
  assert.ok(/pool\.inflight\s*===\s*0/.test(LOOP_SRC),
    'sanity: the loop still resolves on pool.inflight === 0, so gating on inflight > 0 really does ' +
    'mean "a render is in flight"');
});

ok('D4 the heartbeat is cleared in the CATCH arm, and the error is re-thrown', () => {
  assert.notStrictEqual(I_CATCH, -1, 'the pool drain must be wrapped in try/catch');
  assert.ok(I_TRY !== -1 && I_TRY < I_POOLS && I_POOLS < I_CATCH,
    'the drain must sit INSIDE the try, or the catch cannot cover it');
  const catchArm = LOOP_SRC.slice(I_CATCH, I_FINALLY === -1 ? I_CATCH + 800 : I_FINALLY);
  assert.ok(/runHeartbeat\.stop\(\)/.test(catchArm),
    'the catch arm must stop the heartbeat — a crashed run whose timer keeps beating would be ' +
    'kept out of the reaper\'s reach forever');
  assert.ok(/throw\s+/.test(catchArm),
    'the catch must re-throw — swallowing here would turn a crashed run into a silent success');
});

ok('D5 the heartbeat is cleared in the FINALLY arm too — completion and operator cancel', () => {
  assert.notStrictEqual(I_FINALLY, -1, 'the pool drain must have a finally arm');
  assert.notStrictEqual(I_ENDBLK, -1, 'could not find the end of the finally block');
  const finallyArm = LOOP_SRC.slice(I_FINALLY, I_ENDBLK);
  assert.ok(/runHeartbeat\.stop\(\)/.test(finallyArm),
    'the finally arm must stop the heartbeat');
});

ok('D6 exactly two runHeartbeat.stop() calls exist in CODE (a comment cannot satisfy D4/D5)', () => {
  const codeStops = (LOOP_SRC.match(/runHeartbeat\.stop\(\)/g) || []).length;
  assert.strictEqual(codeStops, 2,
    `expected exactly 2 runHeartbeat.stop() calls in comment-stripped runRenderLoop, found ${codeStops}`);
  // Prove the stripper is actually doing something — otherwise D4/D5 are the
  // regex-a-comment-satisfies check they claim not to be.
  const rawStops = ((adsSrc.slice(adsSrc.indexOf('async function runRenderLoop(')).match(/runHeartbeat\.stop\(\)/g)) || []).length;
  assert.ok(rawStops >= codeStops,
    'sanity: the comment-stripped view cannot contain more occurrences than the raw source');
});

ok('D7 the per-completion Ad beat uses the SHARED builders — the timer and the completion path cannot drift', () => {
  assert.ok(/Ad\.updateMany\(\s*\n\s*buildClaimedAdHeartbeatFilter\(adIds\),\s*\n\s*buildClaimedAdHeartbeatUpdate\(/.test(adsCode),
    'the render loop\'s per-completion Ad heartbeat must call the shared builders, not an inlined copy — ' +
    'two populations is how the undispatched tail got reaped out from under a live run');
  // Scoped to the HEARTBEAT call shape specifically. The same literal appears
  // legitimately inside receiptFree(...) at the crash-release sites (routes/ads.js
  // ~1220/1241), which are a different concern and must not be caught here.
  assert.ok(!/Ad\.updateMany\(\s*\n\s*\{\s*_id:\s*\{\s*\$in:\s*adIds\s*\},\s*status:\s*'rendering'\s*\}/.test(adsCode),
    'the old inlined heartbeat literal `Ad.updateMany({ _id: { $in: adIds }, status: \'rendering\' }, …)` must not come back');
});

// ══════════════════════════════════════════════════════════════════════════
// Group E — the ticker BEHAVES: beats when working, silent when not, stops.
// Real timers on a tiny interval; still fully offline.
// ══════════════════════════════════════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function recordingModels() {
  const runWrites = [];
  const adWrites = [];
  return {
    runWrites,
    adWrites,
    models: {
      CampaignRun: { updateOne: async (filter, update) => { runWrites.push({ filter, update }); return { modifiedCount: 1 }; } },
      Ad:          { updateMany: async (filter, update) => { adWrites.push({ filter, update }); return { modifiedCount: 1 }; } }
    }
  };
}
const RUN_ID_OBJ = '64b0000000000000000000aa';
const AD_IDS = ['64b0000000000000000000a1', '64b0000000000000000000a2'];

(async () => {
  await okA('E1 a ticker whose isWorking() is false NEVER writes — this is what keeps a wedged run reapable', async () => {
    const { runWrites, adWrites, models } = recordingModels();
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => false, models, intervalMs: 10 });
    await sleep(120);
    hb.stop();
    assert.strictEqual(runWrites.length, 0,
      'an idle loop must emit no beat — an unconditional heartbeat defeats the reaper outright');
    assert.strictEqual(adWrites.length, 0);
    assert.ok(hb.idle >= 5, `the ticker must have evaluated the gate and declined, idle=${hb.idle}`);
  });

  await okA('E2 a ticker whose isWorking() is true writes BOTH arms, with the exact shared filter/update', async () => {
    const { runWrites, adWrites, models } = recordingModels();
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => true, models, intervalMs: 10 });
    await sleep(120);
    hb.stop();
    assert.ok(runWrites.length >= 5, `expected repeated run beats, got ${runWrites.length}`);
    assert.ok(adWrites.length >= 5, `expected repeated ad beats, got ${adWrites.length}`);
    for (const w of runWrites) {
      assert.deepStrictEqual(w.filter, { _id: RUN_ID_OBJ, status: 'running' });
      assert.deepStrictEqual(Object.keys(w.update), ['$set']);
      assert.deepStrictEqual(Object.keys(w.update.$set).sort(), ['lastHeartbeatAt', 'updatedAt']);
      for (const bad of FORBIDDEN_PATHS) {
        assert.ok(!(bad in w.update.$set), `a live beat wrote the forbidden path ${bad}`);
      }
    }
    for (const w of adWrites) {
      assert.deepStrictEqual(w.filter, { _id: { $in: AD_IDS }, status: 'rendering' });
      assert.deepStrictEqual(Object.keys(w.update.$set), ['updatedAt']);
    }
  });

  await okA('E3 a THROWING isWorking() reads as "not working" and never throws out of the timer', async () => {
    const { runWrites, models } = recordingModels();
    const hb = startRunHeartbeat({
      runDocId: RUN_ID_OBJ, adIds: AD_IDS, models, intervalMs: 10,
      isWorking: () => { throw new Error('pools went away'); }
    });
    await sleep(80);
    hb.stop();
    assert.strictEqual(runWrites.length, 0,
      'never beat on a signal we could not evaluate — fail towards being reapable, not towards immortality');
  });

  await okA('E4 stop() is idempotent and ends the beat even while isWorking() stays true', async () => {
    const { runWrites, models } = recordingModels();
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => true, models, intervalMs: 10 });
    await sleep(60);
    const afterFirst = runWrites.length;
    assert.ok(afterFirst > 0, 'sanity: it was beating before stop()');
    hb.stop();
    hb.stop();   // the catch AND the finally both call this
    assert.strictEqual(hb.stopped, true);
    await sleep(80);
    assert.strictEqual(runWrites.length, afterFirst,
      'no beat may land after stop() — the double call from catch+finally must be a no-op, not a second timer');
  });

  await okA('E5 a failing Mongo write never rejects into the render loop — a missed beat is survivable', async () => {
    let calls = 0;
    const models = {
      CampaignRun: { updateOne: async () => { calls += 1; throw new Error('Mongo unavailable'); } },
      Ad:          { updateMany: async () => { throw new Error('Mongo unavailable'); } }
    };
    await heartbeatOnce({ ...models, runDocId: RUN_ID_OBJ, adIds: AD_IDS, now: new Date() });
    assert.strictEqual(calls, 1, 'heartbeatOnce must still have attempted the write');
    // And through the ticker, where an unhandled rejection would be fatal.
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => true, models, intervalMs: 10 });
    await sleep(60);
    hb.stop();
  });

  await okA('E7 a WEDGED loop (isWorking true forever) still ages out — the lifetime cap fires and the beat stops', async () => {
    // THE HOLE ADVERSARIAL REVIEW FOUND (2026-08-18). `inflight` is decremented
    // in renderOne's `.finally`, so a renderOne that never settles — a hung
    // provider poll, a promise nothing resolves — reports isWorking() === true
    // forever. Without a cap the ticker would beat forever: the run never gets
    // reaped, the concurrency gate keeps refusing the operator's identical
    // re-request, and the Ad arm holds the whole claimed 'rendering' set out of
    // the Ad reaper's reach instead of letting it fall back to 'queued' where
    // "Generate more" could drain it. Strictly WORSE than pre-heartbeat
    // behaviour, and exactly the hazard progressService guards with MAX_RUN_MS.
    const { runWrites, adWrites, models } = recordingModels();
    const hb = startRunHeartbeat({
      runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => true, models,
      intervalMs: 10, maxMs: 45
    });
    await sleep(200);
    assert.strictEqual(hb.expired, true,
      'the ticker must expire itself past maxMs even while isWorking() keeps saying true');
    assert.strictEqual(hb.stopped, true, 'expiry must also stop the timer');
    const frozenRun = runWrites.length;
    const frozenAd  = adWrites.length;
    assert.ok(frozenRun > 0, 'sanity: it beat before the cap');
    await sleep(80);
    assert.strictEqual(runWrites.length, frozenRun, 'no beat may land after the lifetime cap');
    assert.strictEqual(adWrites.length,  frozenAd,  'the Ad arm must stop with it');
    hb.stop();
  });

  await okA('E7b the default cap matches progressService.MAX_RUN_MS for the SAME ad-batch run', async () => {
    // runRenderLoop opens an OperationRun via startRun({ kind: 'ad-batch' }),
    // whose heartbeat already expires at MAX_RUN_MS. Two heartbeats for one
    // logical run must not disagree about when it stops being credible.
    const progressSrc = fs.readFileSync(path.join(ROOT, 'services/progressService.js'), 'utf8');
    const m = progressSrc.match(/const MAX_RUN_MS\s*=\s*([^;]+);/);
    assert.ok(m, 'could not read progressService MAX_RUN_MS');
    // eslint-disable-next-line no-eval
    const progressMax = eval(m[1]);
    assert.strictEqual(RUN_HEARTBEAT_MAX_MS, progressMax,
      `the run heartbeat cap (${RUN_HEARTBEAT_MAX_MS}ms) must equal progressService.MAX_RUN_MS ` +
      `(${progressMax}ms) — they cap the same logical run`);
    assert.ok(RUN_HEARTBEAT_MAX_MS > withReapMin(undefined, () => runHeartbeatMs()) * 100,
      'the cap must be orders of magnitude above one beat, or it would fire on a healthy batch');
  });

  await okA('E6 the timer is unref\'d so a live beat can never hold the process open', async () => {
    const { models } = recordingModels();
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => true, models, intervalMs: 60_000 });
    assert.ok(/if \(typeof timer\.unref === 'function'\) timer\.unref\(\);/.test(heartbeatCode),
      'startRunHeartbeat must unref its interval — same as the Ad beat and the progressService beat');
    hb.stop();
  });

  await okA('E8 LEADING BEAT: a working ticker writes BEFORE the first interval tick — a batch that settles inside intervalMs must not read lastHeartbeatAt:null for its whole life', async () => {
    // THE GAP found tracing run_1787263897396_ef1fcb32: lastHeartbeatAt only
    // moves on a setInterval tick, so a run whose claimed work starts AND
    // ends inside the first intervalMs (up to 60s) window writes zero beats,
    // ever — indistinguishable on the poller from a run that never had a
    // liveness signal at all. intervalMs is set absurdly long here (an hour)
    // specifically so NO interval tick can possibly fire during this test —
    // any write that lands must be the leading beat, not a lucky race.
    const { runWrites, adWrites, models } = recordingModels();
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => true, models, intervalMs: 60 * 60 * 1000 });
    await sleep(30);
    hb.stop();
    assert.strictEqual(runWrites.length, 1, 'a working ticker must beat once immediately, before any interval tick');
    assert.strictEqual(adWrites.length, 1);
    assert.strictEqual(hb.beats, 1, 'the leading beat must count towards .beats, same accounting as an interval beat');
  });

  await okA('E9 LEADING BEAT is gated on isWorking() exactly like the interval — an idle ticker still writes nothing at t=0', async () => {
    const { runWrites, adWrites, models } = recordingModels();
    const hb = startRunHeartbeat({ runDocId: RUN_ID_OBJ, adIds: AD_IDS, isWorking: () => false, models, intervalMs: 60 * 60 * 1000 });
    await sleep(30);
    hb.stop();
    assert.strictEqual(runWrites.length, 0, 'an unconditional leading beat would defeat the reaper exactly like an unconditional interval beat would');
    assert.strictEqual(adWrites.length, 0);
    assert.strictEqual(hb.idle, 1, 'the declined leading beat must still count as idle');
  });

  // ════════════════════════════════════════════════════════════════════════
  // Group F — THE HEADLINE. Against the REAL exported reaper predicate.
  // ════════════════════════════════════════════════════════════════════════
  const T0 = new Date('2026-08-18T02:15:27Z').getTime();
  const MIN = 60 * 1000;
  const STALE_MIN = REAP_STALE_MIN_DEFAULT;
  const reaperFilterAt = (tMs) => buildStaleRunningFilter({ now: tMs, staleMin: STALE_MIN });
  const beatMs = withReapMin(undefined, () => runHeartbeatMs());

  ok('F1 a run whose heartbeat is ticking NEVER matches the running-reap filter, across a 40-minute batch', () => {
    const doc = { _id: RUN_ID_OBJ, status: 'running', startedAt: new Date(T0), updatedAt: new Date(T0), lastHeartbeatAt: null };
    let reapedAt = null;
    for (let t = T0; t <= T0 + 40 * MIN; t += beatMs) {
      // The loop is working, so the ticker beats. Applied through the REAL
      // filter+update pair, so a filter that stopped matching a live run, or an
      // update that stopped moving updatedAt, fails here.
      const wrote = applyIfMatches(doc, buildRunHeartbeatFilter(RUN_ID_OBJ), buildRunHeartbeatUpdate(new Date(t)));
      assert.strictEqual(wrote, true, `the beat must land on a live running run at t=${(t - T0) / MIN}m`);
      if (matches(doc, reaperFilterAt(t))) { reapedAt = t; break; }
    }
    assert.strictEqual(reapedAt, null,
      `a beating run was reaped at t=${reapedAt === null ? '-' : (reapedAt - T0) / MIN}m — the heartbeat is not protecting it`);
    assert.ok(doc.lastHeartbeatAt instanceof Date, 'the beat must have stamped lastHeartbeatAt');
  });

  ok('F2 a run that goes GENUINELY silent still matches the reap filter, on schedule', () => {
    // No beats at all — a dead holder, which is exactly what the reaper is for.
    const doc = { _id: RUN_ID_OBJ, status: 'running', startedAt: new Date(T0), updatedAt: new Date(T0) };
    assert.strictEqual(matches(doc, reaperFilterAt(T0 + (STALE_MIN - 1) * MIN)), false,
      'must not be reaped before the window elapses');
    assert.strictEqual(matches(doc, reaperFilterAt(T0 + (STALE_MIN + 1) * MIN)), true,
      'a run with no liveness signal for longer than the window MUST still be reaped — ' +
      'the fix must not disable the reaper');
  });

  ok('F3 THE INCIDENT, both arms: without the heartbeat run_1787105727540_e8c94542 is reaped at 02:36; with it, it is not', () => {
    // Measured values, not round numbers: startedAt 02:15:27Z, the 18th static
    // settled ~02:21, and the reaper stamped completedAt 02:36:29Z.
    const LAST_SETTLE = T0 + 6 * MIN;                                   // ~02:21:27Z
    const REAPED_AT   = new Date('2026-08-18T02:36:29Z').getTime();     // measured completedAt
    // ARM 1 — the OLD behaviour: updatedAt moves only when an ad settles.
    const oldDoc = { _id: RUN_ID_OBJ, status: 'running', startedAt: new Date(T0), updatedAt: new Date(LAST_SETTLE) };
    assert.strictEqual(matches(oldDoc, reaperFilterAt(REAPED_AT)), true,
      'the counterfactual must reproduce the incident — if this is false the harness is not testing the real defect');
    // ARM 2 — with the heartbeat running through the silent titling stretch.
    const newDoc = { _id: RUN_ID_OBJ, status: 'running', startedAt: new Date(T0), updatedAt: new Date(LAST_SETTLE) };
    for (let t = LAST_SETTLE; t <= REAPED_AT; t += beatMs) {
      applyIfMatches(newDoc, buildRunHeartbeatFilter(RUN_ID_OBJ), buildRunHeartbeatUpdate(new Date(t)));
    }
    assert.strictEqual(matches(newDoc, reaperFilterAt(REAPED_AT)), false,
      'with the heartbeat the run must survive 02:36 — this is the whole fix');
  });

  ok('F4 when the beat STOPS (process death / wedge), the run becomes reapable exactly one window later', () => {
    const STOPPED_AT = T0 + 10 * MIN;
    const doc = { _id: RUN_ID_OBJ, status: 'running', startedAt: new Date(T0), updatedAt: new Date(T0) };
    for (let t = T0; t <= STOPPED_AT; t += beatMs) {
      applyIfMatches(doc, buildRunHeartbeatFilter(RUN_ID_OBJ), buildRunHeartbeatUpdate(new Date(t)));
    }
    const lastBeat = doc.updatedAt.getTime();
    assert.strictEqual(matches(doc, reaperFilterAt(lastBeat + (STALE_MIN - 1) * MIN)), false);
    assert.strictEqual(matches(doc, reaperFilterAt(lastBeat + (STALE_MIN + 1) * MIN)), true,
      'the heartbeat must only DELAY the reaper while work is real — once the beat stops the ' +
      'window runs normally from the last beat');
  });

  ok('F5 a beat racing the reaper cannot resurrect a run the reaper already failed', () => {
    const doc = { _id: RUN_ID_OBJ, status: 'failed', startedAt: new Date(T0), updatedAt: new Date(T0 + 21 * MIN), completedAt: new Date(T0 + 21 * MIN) };
    const before = doc.updatedAt.getTime();
    const wrote = applyIfMatches(doc, buildRunHeartbeatFilter(RUN_ID_OBJ), buildRunHeartbeatUpdate(new Date(T0 + 22 * MIN)));
    assert.strictEqual(wrote, false, 'the beat must not match a reaped run');
    assert.strictEqual(doc.status, 'failed', 'the beat must not touch status');
    assert.strictEqual(doc.updatedAt.getTime(), before, 'the beat must not move a terminal run\'s clock');
  });

  ok('F6 the heartbeat window and the reaper window read the SAME value from the SAME parser', () => {
    // Not "two numbers tuned to agree" — one parser, so they cannot drift.
    for (const raw of [undefined, '5', '15', '30']) {
      withReapMin(raw, () => {
        const cutoffMs = reapStaleMin() * 60 * 1000;
        const f = buildStaleRunningFilter({ now: T0, staleMin: reapStaleMin() });
        assert.strictEqual(T0 - f.updatedAt.$lt.getTime(), cutoffMs,
          `REAP_STALE_MIN=${JSON.stringify(raw)}: the reaper cutoff must be exactly the parsed window`);
        assert.ok(runHeartbeatMs() * MIN_BEATS_PER_WINDOW <= cutoffMs,
          `REAP_STALE_MIN=${JSON.stringify(raw)}: the beat must stay inside the same window`);
      });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // Group G — the reaper call site, and the docs that describe it.
  // ════════════════════════════════════════════════════════════════════════
  ok('G1 worker.js IMPORTS buildStaleRunningFilter (call without import = ReferenceError)', () => {
    assert.ok(
      /const\s*\{[^}]*buildStaleRunningFilter[^}]*\}\s*=\s*require\(\s*['"]\.\/services\/campaignRunGuards['"]\s*\)/s
        .test(stripCommentLines(workerSrc)),
      'worker.js must destructure buildStaleRunningFilter from ./services/campaignRunGuards');
  });

  ok('G2 worker.js\'s running sweep CALLS the shared builder — no hand-rolled copy of the predicate', () => {
    const code = stripCommentLines(workerSrc);
    // CampaignRun.find(...), not .updateMany(...), since the 2026-08-20
    // Ad-truth reconciliation fix (services/campaignRunGuards.js
    // classifyRunAdOutcome / buildRunReconciliationUpdate): each stale
    // candidate needs its OWN claimed-Ad read before it can be judged
    // done/failed/still-genuinely-rendering, so the blind bulk updateMany
    // became a find() + per-row updateOne(). The predicate itself — what
    // makes a CampaignRun a "stale running" CANDIDATE in the first place —
    // is still the one shared, exported builder, which is what this check
    // actually guards against drifting into a hand-rolled copy.
    assert.ok(/CampaignRun\.find\(\s*\n\s*buildStaleRunningFilter\(/.test(code),
      'the running reap must select its candidates via the shared, exported predicate so a harness can evaluate the real one');
    assert.ok(!/\{\s*status:\s*'running',\s*updatedAt:\s*\{\s*\$lt:\s*cutoff\s*\}\s*\}/.test(code),
      'the old inline running-reap literal must not come back');
    // And the two sweeps must stay on their own clocks.
    const running   = buildStaleRunningFilter({ now: T0, staleMin: STALE_MIN });
    assert.strictEqual(running.status, 'running');
    assert.ok(running.updatedAt && running.updatedAt.$lt instanceof Date,
      'the running sweep keys on LIVENESS');
    assert.strictEqual(running.startedAt, undefined,
      'the running sweep must NOT key on mint age — a serialized video batch legitimately runs 25-35 min');
  });

  ok('G3 docs/ALERTING.md no longer claims CampaignRun has no periodic heartbeat, and records the incident', () => {
    const alerting = fs.readFileSync(path.join(ROOT, 'docs/ALERTING.md'), 'utf8');
    // PRESENT tense only. The doc legitimately still says CampaignRun *had* no
    // heartbeat, because that is the history the incident section explains;
    // what must never come back is the claim that it *has* none.
    assert.ok(!/has \*\*no periodic heartbeat/.test(alerting),
      'that sentence is now FALSE — docs/ALERTING.md must be corrected in the same commit ' +
      '(CLAUDE.md §4: docs have described commented-out code before)');
    assert.ok(/campaignRunHeartbeat/.test(alerting),
      'docs/ALERTING.md must name the service that owns the beat');
    assert.ok(/verifyCampaignRunHeartbeat/.test(alerting),
      'docs/ALERTING.md must name the harness that pins it');
    assert.ok(/run_1787105727540_e8c94542/.test(alerting),
      'docs/ALERTING.md must record the measured incident so the next reader knows why the heartbeat exists');
    assert.ok(/lastHeartbeatAt/.test(alerting),
      'docs/ALERTING.md must name the field an operator will see on the row');
  });

  ok('G5 no file still asserts the retired liveness story — the residual-comment class', () => {
    // Adversarial review (2026-08-18) found THREE surviving copies of the false
    // claim in files this very change had already edited: campaignRunGuards.js
    // still carried "CampaignRun has no periodic heartbeat of its own" as a
    // KNOWN RESIDUAL, and worker.js twice asserted that the per-ad `$inc`
    // "proves liveness". That is CLAUDE.md §4's "docs have described
    // commented-out code" trap in comment form, and it is worse than a stale
    // doc: it is the exact reasoning that let the defect survive three PRs.
    const guardsSrc = fs.readFileSync(path.join(ROOT, 'services/campaignRunGuards.js'), 'utf8');
    assert.ok(!/has no\s+\*?\*?periodic heartbeat of its own/.test(guardsSrc.replace(/\n\s*\*\s?/g, ' ')),
      'services/campaignRunGuards.js must not still call the missing heartbeat a known residual — it is closed');
    for (const [file, src] of [['worker.js', workerSrc], ['services/campaignRunGuards.js', guardsSrc]]) {
      const flat = src.replace(/\n\s*(\/\/|\*)\s?/g, ' ');
      assert.ok(!/\$inc[^.]{0,80}proves liveness/.test(flat),
        `${file} must not still claim the per-ad $inc proves liveness — it is a COMPLETION ` +
        'notification, and believing otherwise is what reaped run_1787105727540_e8c94542 alive');
    }
    // And the replacement story must actually be present where the reaper lives.
    assert.ok(/campaignRunHeartbeat/.test(workerSrc),
      'worker.js must point a reader at the heartbeat that makes its own predicate true');
  });

  ok('G4 CLAUDE.md records the incident and the heartbeat', () => {
    const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    assert.ok(/run_1787105727540_e8c94542/.test(claude),
      'CLAUDE.md must carry the run id — a bare "we added a heartbeat" note does not tell the next ' +
      'reader what it is defending against');
    assert.ok(/campaignRunHeartbeat/.test(claude),
      'CLAUDE.md must name the service that owns the beat');
    assert.ok(/verifyCampaignRunHeartbeat/.test(claude),
      'CLAUDE.md must name the harness that pins it');
  });

  if (process.exitCode) {
    console.log(`\n❌ verifyCampaignRunHeartbeat: failures above (${checks} passed)`);
  } else {
    console.log(`\n✅ verifyCampaignRunHeartbeat: ${checks}/${checks} checks passed`);
  }
})();
