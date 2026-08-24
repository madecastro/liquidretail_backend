#!/usr/bin/env node
'use strict';
//
// ██████  KNOWN-OPEN DEFECT — THIS HARNESS IS EXPECTED TO FAIL.  ██████
// Do not "fix" it by relaxing the assertions. Fix it by wiring
// classifyRunAdOutcome/buildRunReconciliationUpdate into renderer.js's
// completion path, then delete this header and let the harness go green.
//
// verifyRunFinalizesOnSettle — MEASURED IN PRODUCTION:
// run_1787557633213_a0ccdd01 had succeeded=2, failed=1, total=3 — every one
// of its 3 claimed Ads had already reached a settled (draft/failed) state —
// yet the CampaignRun row stayed status:'running', completedAt:null,
// forever. The operator's poller (GET /api/ads/runs/:id) never learns the
// batch is done.
//
// ROOT CAUSE, read end to end:
//   1. backend's routes/ads.js `runRenderLoop` is the ONLY code that ever
//      writes CampaignRun.status to 'done' or 'failed' on the happy path —
//      and it early-returns on the adgen handoff (routes/ads.js:1723, per
//      this task's brief) once ADGEN_RENDERER_ENABLED is on. So backend's
//      own terminal write (routes/ads.js:2048) is UNREACHABLE for any run
//      adgen's renderer claims ads from.
//   2. adgen's src/services/renderer.js is what actually claims and renders
//      those ads (see verifyRendererAtomicClaim.js) — and the ONLY thing it
//      ever writes to the CampaignRun collection is `bumpRunCounter()`
//      (renderer.js ~line 143), which does exactly:
//          CampaignRun.updateOne({runId}, {$inc:{[field]:1},
//            $set:{updatedAt, lastHeartbeatAt}})
//      — an outcome-counter bump plus a liveness refresh. It NEVER writes
//      `status` or `completedAt`.
//   3. adgen ALREADY VENDORS the read side of the fix —
//      `classifyRunAdOutcome` + `buildRunReconciliationUpdate` in
//      services/campaignRunGuards.js — copied over from the backend
//      verbatim (see that file's own header, "found investigating a
//      2026-08-20 incident"). Both are fully correct and exported. NOTHING
//      calls them. `grep -rn "classifyRunAdOutcome\(" src/` outside their
//      own definition/comments returns zero real call sites — verified by
//      this harness's own group C, not merely asserted in this comment.
//
// So the fix exists, sits unused in the same repo, and the bug it fixes is
// reproduced below byte-for-byte against the shape of the real incident.
//
// WHAT THIS HARNESS DOES: builds an offline stub CampaignRun + Ad
// collection, seeds a run shaped exactly like run_1787557633213_a0ccdd01
// (3 claimed ads, 2 succeed, 1 fails), replays the REAL, SOURCE-EXTRACTED
// `bumpRunCounter` update shape from renderer.js for each ad's completion
// (not a hand-copied reimplementation — see "SOURCE EXTRACTION" below), and
// then asserts the run reaches a terminal state. It does not, because
// nothing in the completion path ever writes one.
//
// A SEPARATE, PASSING check (group D) proves the fix is not hypothetical:
// feeding the SAME 3 ad documents through the REAL, imported
// classifyRunAdOutcome + buildRunReconciliationUpdate produces the correct
// {status:'done', succeeded:2, failed:1} — proving the only missing piece
// is a CALL SITE, not new logic.
//
// Pure + offline: no DB, no network, no API keys. campaignRunGuards.js's
// only requires are ./staleness and ./adTitlingTruth, both dependency-free,
// so it is required directly here — no stub, no NODE_PATH needed.
//   node scripts/verifyRunFinalizesOnSettle_KNOWN_OPEN.js   (exits 1 — expected)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  classifyRunAdOutcome,
  buildRunReconciliationUpdate
} = require('../src/services/campaignRunGuards.js');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'services', 'renderer.js');
const RENDERER_SRC = fs.readFileSync(RENDERER_PATH, 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}

function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════
// SOURCE EXTRACTION — the real bumpRunCounter() update shape, sliced out of
// renderer.js (not hand-copied), and applied with the given `field`.
// ═════════════════════════════════════════════════════════════════════════
const bumpFnMatch = /async function bumpRunCounter\(campaignRunIds, field\)\s*\{/.exec(RENDERER_SRC);
assert.ok(bumpFnMatch, 'bumpRunCounter signature not found — renderer.js shape changed, re-derive this harness');
const bumpBody = balanced(RENDERER_SRC, RENDERER_SRC.indexOf('{', bumpFnMatch.index + bumpFnMatch[0].length - 1), '{', '}');
const updateCallIdx = bumpBody.indexOf('CampaignRun.updateOne(');
assert.ok(updateCallIdx >= 0, 'bumpRunCounter no longer writes CampaignRun.updateOne — re-derive this harness');
const updateCallWhole = balanced(bumpBody, updateCallIdx + 'CampaignRun.updateOne('.length - 1, '(', ')');
const updateArgText = updateCallWhole.slice(1, -1).split(/,\s*\{\s*\$inc/)[1]
  ? updateCallWhole.slice(1, -1).slice(updateCallWhole.slice(1, -1).indexOf('{ $inc'))
  : null;
assert.ok(updateArgText, 'could not isolate the $inc/$set update literal inside bumpRunCounter — re-derive this harness');

console.log('bumpRunCounter update literal (extracted from renderer.js):');
console.log('  ' + updateArgText.replace(/\n\s*/g, ' '));
console.log('');

/**
 * Apply the REAL bumpRunCounter update shape to a stub CampaignRun doc.
 * `field` parameterises the one free identifier in the extracted text.
 */
function applyBumpRunCounter(run, field, now) {
  // eslint-disable-next-line no-new-func
  const update = new Function('field', 'now', `return (${updateArgText});`)(field, now);
  const out = { ...run };
  for (const [k, v] of Object.entries(update.$inc || {})) out[k] = (out[k] || 0) + v;
  Object.assign(out, update.$set || {});
  return out;
}

check('sanity: the extracted update increments the named field and refreshes both clocks', () => {
  // bumpRunCounter's real source calls `new Date()` inline (not injectable) —
  // both fields are stamped freshly at apply-time, so assert freshness/type
  // rather than an exact injected instant.
  const before = { runId: 'r', succeeded: 0, status: 'running', updatedAt: new Date(0), lastHeartbeatAt: null };
  const t0 = Date.now();
  const after = applyBumpRunCounter(before, 'succeeded', new Date('2026-08-20T00:00:00Z'));
  const t1 = Date.now();
  assert.strictEqual(after.succeeded, 1);
  assert.ok(after.updatedAt instanceof Date && after.updatedAt.getTime() >= t0 && after.updatedAt.getTime() <= t1);
  assert.ok(after.lastHeartbeatAt instanceof Date && after.lastHeartbeatAt.getTime() >= t0 && after.lastHeartbeatAt.getTime() <= t1);
  assert.strictEqual(after.status, 'running', 'bumpRunCounter must never touch status — that is exactly the gap this harness pins');
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP A — reproduce the measured incident shape and show the run never
// reaches a terminal state through the real completion mechanism.
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Group A: replaying the measured incident shape ──');

let run = {
  runId: 'run_1787557633213_a0ccdd01',
  status: 'running',
  total: 3,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  completedAt: null,
  updatedAt: new Date('2026-08-20T10:00:00Z'),
  lastHeartbeatAt: null
};

// Three ads claimed by this run. Two succeed (renderStatic/renderVideo's
// terminal write => status:'draft'), one fails (processAd's catch => 'failed').
// This is the EXACT succeeded/failed/total shape measured in production.
const settleTimes = [
  new Date('2026-08-20T10:05:00Z'),
  new Date('2026-08-20T10:06:00Z'),
  new Date('2026-08-20T10:07:00Z')
];
run = applyBumpRunCounter(run, 'succeeded', settleTimes[0]);
run = applyBumpRunCounter(run, 'succeeded', settleTimes[1]);
run = applyBumpRunCounter(run, 'failed', settleTimes[2]);

check('A1 counters match the measured incident (succeeded=2, failed=1, total=3)', () => {
  assert.strictEqual(run.succeeded, 2);
  assert.strictEqual(run.failed, 1);
  assert.strictEqual(run.total, 3);
  assert.strictEqual(run.succeeded + run.failed + run.skipped, run.total, 'every claimed ad has settled');
});

check('A2 [THE DEFECT — EXPECTED TO FAIL] a run whose every claimed ad has settled reaches a terminal state', () => {
  assert.ok(['done', 'failed'].includes(run.status),
    `run stayed '${run.status}' with completedAt:${run.completedAt} after all 3 ads settled — ` +
    'this is the exact shape of run_1787557633213_a0ccdd01. Nothing in renderer.js\'s completion ' +
    'path (bumpRunCounter is the only CampaignRun write) ever flips status to done/failed.');
});

check('A3 [consequence, EXPECTED TO FAIL] completedAt is stamped once the run is settled', () => {
  assert.ok(run.completedAt instanceof Date,
    'completedAt stayed null — an operator polling GET /api/ads/runs/:id has no signal the batch finished');
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP B — the SAME defect via a request-side simulation of renderer.js's
// actual per-ad completion writes, so this isn't just "bumpRunCounter in
// isolation" — it is what happens when three real completions of the shape
// processAd() produces run back to back with no other CampaignRun writer
// in the process.
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Group B: no OTHER CampaignRun writer exists in adgen either ──');

check('B1 no source file in src/ has a CampaignRun.<write>() call site that sets status to "done"/"failed" outside campaignRunGuards.js\'s own (unused) builders', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  const CALL_RE = /CampaignRun\.(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate)\(/g;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (full === path.join(srcDir, 'services', 'campaignRunGuards.js')) continue; // the vendored, unused fix itself
      const text = fs.readFileSync(full, 'utf8');
      CALL_RE.lastIndex = 0;
      let m;
      while ((m = CALL_RE.exec(text))) {
        const openParen = m.index + m[0].length - 1;
        const whole = balanced(text, openParen, '(', ')');
        if (whole && /status\s*:\s*['"](done|failed)['"]/.test(whole)) {
          offenders.push(`${path.relative(srcDir, full)} (CampaignRun.${m[1]} call)`);
        }
      }
    }
  })(srcDir);
  assert.strictEqual(offenders.length, 0,
    `expected the vendored builders to be the ONLY place with a CampaignRun write to a terminal status; ` +
    `found a real call site too, re-scope this check: ${offenders.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP C — classifyRunAdOutcome / buildRunReconciliationUpdate exist,
// export correctly, and are never actually called anywhere live.
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Group C: the vendored fix is real but structurally unreachable ──');

check('C1 classifyRunAdOutcome and buildRunReconciliationUpdate ARE exported from campaignRunGuards.js', () => {
  assert.strictEqual(typeof classifyRunAdOutcome, 'function');
  assert.strictEqual(typeof buildRunReconciliationUpdate, 'function');
});

check('C2 [EXPECTED TO FAIL] classifyRunAdOutcome has at least one real call site outside its own module', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const callers = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || full === path.join(srcDir, 'services', 'campaignRunGuards.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/classifyRunAdOutcome\s*\(/.test(text)) callers.push(path.relative(srcDir, full));
    }
  })(srcDir);
  assert.ok(callers.length > 0,
    'classifyRunAdOutcome is defined and exported but has ZERO call sites anywhere in src/ — ' +
    'the fix for the exact defect in Group A is vendored, correct, and dead code.');
});

// A supporting, PASSING demonstration that the vendored fix, if it WERE
// wired up, correctly reconciles the exact incident shape. This is the
// "the fix exists, it's just unused" half of the story.
check('D1 [supporting, PASSES] IF wired up, classifyRunAdOutcome + buildRunReconciliationUpdate correctly finalize this exact run', () => {
  const adDocs = [
    { status: 'draft', kind: 'image' },
    { status: 'draft', kind: 'image' },
    { status: 'failed', kind: 'image' }
  ];
  const outcome = classifyRunAdOutcome(adDocs);
  assert.strictEqual(outcome.succeeded, 2);
  assert.strictEqual(outcome.failed, 1);
  assert.strictEqual(outcome.isSettled, true);
  assert.strictEqual(outcome.needsRetry, false);
  const update = buildRunReconciliationUpdate(outcome, { now: new Date('2026-08-20T10:07:01Z') });
  assert.strictEqual(update.$set.status, 'done');
  assert.strictEqual(update.$set.succeeded, 2);
  assert.strictEqual(update.$set.failed, 1);
  assert.ok(update.$set.completedAt instanceof Date);
});

// ── report ───────────────────────────────────────────────────────────────
const total = checks + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyRunFinalizesOnSettle_KNOWN_OPEN: ${failures.length} of ${total} checks FAILED (EXPECTED — see file header)`);
  for (const f of failures) console.log(`  • ${f}`);
  console.log('\nThis is a KNOWN-OPEN DEFECT harness. A red result here is correct and expected.');
  console.log('Fix: call classifyRunAdOutcome + buildRunReconciliationUpdate from renderer.js\'s');
  console.log('completion path once a run\'s claimed ads are all settled, then re-run this file.');
  process.exit(1);
}
console.log(`✅ verifyRunFinalizesOnSettle_KNOWN_OPEN: ${total}/${total} checks passed`);
console.log('⚠️  If you are seeing this, the known-open defect has been FIXED — update/retire this file\'s header.');
