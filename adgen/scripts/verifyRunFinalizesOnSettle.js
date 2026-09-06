#!/usr/bin/env node
'use strict';
//
// verifyRunFinalizesOnSettle — MEASURED IN PRODUCTION, NOW CLOSED:
// run_1787557633213_a0ccdd01 had succeeded=2, failed=1, total=3 — every one
// of its 3 claimed Ads had already reached a settled (draft/failed) state —
// yet the CampaignRun row stayed status:'running', completedAt:null,
// forever. The operator's poller (GET /api/ads/runs/:id) never learns the
// batch is done. While updatedAt is stale past REAP_STALE_MIN the backend
// duplicate-generation gate also loses its running arm.
//
// HISTORY. This file was born as verifyRunFinalizesOnSettle_KNOWN_OPEN.js
// because renderer.js's completion path only ever $inc'd CampaignRun
// counters via bumpRunCounter — classifyRunAdOutcome +
// buildRunReconciliationUpdate were vendored, correct, and uncalled, and
// backend's runRenderLoop early-returns once ADGEN_RENDERER_ENABLED is on
// so its own terminal write is unreachable for adgen-claimed runs.
//
// THE DEFECT IS CLOSED. bumpRunCounter now awaits maybeFinalizeRun after
// the $inc (renderer.js). maybeFinalizeRun re-reads the claimed Ads,
// classifies them with the vendored helpers, and CAS-writes status:'done'
// + completedAt once every claimed ad has settled. The assertions below
// pin the CLOSED state — they must go red if the wiring is removed. Do
// not "fix" a red by relaxing them.
//
// WHAT THIS HARNESS DOES: builds an offline stub CampaignRun + Ad
// collection, seeds a run shaped exactly like run_1787557633213_a0ccdd01
// (3 claimed ads, 2 succeed, 1 fails), and replays the REAL,
// SOURCE-EXTRACTED `bumpRunCounter` (including the `maybeFinalizeRun` call
// it now makes — not a hand-copied reimplementation; see "SOURCE
// EXTRACTION" below). Then asserts the run reaches a terminal state.
//
// Group D still feeds the SAME 3 ad documents through the REAL imported
// classifyRunAdOutcome + buildRunReconciliationUpdate, proving the
// builders themselves still produce {status:'done', succeeded:2, failed:1}.
//
// Pure + offline: campaignRunGuards.js's only requires are ./staleness and
// ./adTitlingTruth, both dependency-free, so it is required directly here —
// no stub, no NODE_PATH needed.
//   node scripts/verifyRunFinalizesOnSettle.js
//
// REVERT-PROVE:
//   drop `await maybeFinalizeRun(runId)` from bumpRunCounter  → A2/A3 red
//   drop classifyRunAdOutcome from maybeFinalizeRun           → C2 red
//   restore both → all green

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
// ASYNC-AWARE: bumpRunCounter / maybeFinalizeRun are async; a sync try/catch
// would mark a later-rejecting check as a pass.
async function check(label, fn) {
  try { await fn(); checks += 1; console.log(`  ✓ ${label}`); }
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

function extractNamedFunction(src, signatureRe) {
  const m = signatureRe.exec(src);
  assert.ok(m, `${signatureRe} not found — renderer.js shape changed, re-derive this harness`);
  const openIdx = src.indexOf('{', m.index + m[0].length - 1);
  assert.ok(openIdx >= 0, `opening brace for ${m[0]} not found`);
  const body = balanced(src, openIdx, '{', '}');
  assert.ok(body, `could not extract body for ${m[0]}`);
  return { match: m, body, src: src.slice(m.index, openIdx) + body };
}

// ═════════════════════════════════════════════════════════════════════════
// SOURCE EXTRACTION — the real bumpRunCounter() (including its
// maybeFinalizeRun call) and maybeFinalizeRun() itself, sliced out of
// renderer.js (not hand-copied).
// ═════════════════════════════════════════════════════════════════════════
const bumpExtracted = extractNamedFunction(
  RENDERER_SRC,
  /async function bumpRunCounter\(campaignRunIds, field\)\s*\{/
);
const bumpBody = bumpExtracted.body;
const bumpFnSrc = bumpExtracted.src;

const updateCallIdx = bumpBody.indexOf('CampaignRun.updateOne(');
assert.ok(updateCallIdx >= 0, 'bumpRunCounter no longer writes CampaignRun.updateOne — re-derive this harness');
const updateCallWhole = balanced(bumpBody, updateCallIdx + 'CampaignRun.updateOne('.length - 1, '(', ')');
const updateArgText = updateCallWhole.slice(1, -1).split(/,\s*\{\s*\$inc/)[1]
  ? updateCallWhole.slice(1, -1).slice(updateCallWhole.slice(1, -1).indexOf('{ $inc'))
  : null;
assert.ok(updateArgText, 'could not isolate the $inc/$set update literal inside bumpRunCounter — re-derive this harness');

assert.ok(
  /await\s+maybeFinalizeRun\s*\(\s*runId\s*\)/.test(bumpBody),
  'bumpRunCounter no longer awaits maybeFinalizeRun(runId) — the completion-path wiring this harness pins is gone, re-derive'
);

const maybeExtracted = extractNamedFunction(
  RENDERER_SRC,
  /async function maybeFinalizeRun\(runId\)\s*\{/
);
const maybeBody = maybeExtracted.body;
const maybeFnSrc = maybeExtracted.src;

assert.ok(
  /classifyRunAdOutcome\s*\(/.test(maybeBody),
  'maybeFinalizeRun no longer calls classifyRunAdOutcome — re-derive this harness'
);
assert.ok(
  /buildRunReconciliationUpdate\s*\(/.test(maybeBody),
  'maybeFinalizeRun no longer calls buildRunReconciliationUpdate — re-derive this harness'
);
assert.ok(
  /CampaignRun\.updateOne\(\s*\{\s*runId,\s*status:\s*'running'\s*\}\s*,\s*update\s*\)/.test(maybeBody),
  'maybeFinalizeRun no longer CAS-writes CampaignRun with the builder update on status:\'running\' — re-derive this harness'
);

console.log('bumpRunCounter update literal (extracted from renderer.js):');
console.log('  ' + updateArgText.replace(/\n\s*/g, ' '));
console.log('bumpRunCounter calls maybeFinalizeRun: yes');
console.log('');

/**
 * Apply ONLY the REAL bumpRunCounter $inc/$set update shape to a stub
 * CampaignRun doc. Used to pin that the counter bump itself never writes
 * status — terminal status is maybeFinalizeRun's job.
 */
function applyBumpRunCounter(run, field, now) {
  // eslint-disable-next-line no-new-func
  const update = new Function('field', 'now', `return (${updateArgText});`)(field, now);
  const out = { ...run };
  for (const [k, v] of Object.entries(update.$inc || {})) out[k] = (out[k] || 0) + v;
  Object.assign(out, update.$set || {});
  return out;
}

function makeStubCampaignRun(doc) {
  return {
    async updateOne(filter, update) {
      const runIdOk = filter.runId === undefined || filter.runId === doc.runId;
      const statusOk = filter.status === undefined || filter.status === doc.status;
      if (!runIdOk || !statusOk) return { matchedCount: 0, modifiedCount: 0, nModified: 0 };
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
      }
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1, nModified: 1 };
    },
    snapshot() { return { ...doc }; }
  };
}

function makeStubAd(ads) {
  return {
    find(filter) {
      const runId = filter && filter.campaignRunIds;
      const query = {
        select() { return query; },
        lean() {
          const matched = ads.filter((a) => {
            const ids = a.campaignRunIds;
            if (runId == null) return true;
            return Array.isArray(ids) ? ids.includes(runId) : ids === runId;
          });
          return Promise.resolve(matched.map((a) => ({ ...a })));
        }
      };
      return query;
    }
  };
}

function compileExtractedFns() {
  // eslint-disable-next-line no-new-func
  return new Function(
    'Ad',
    'CampaignRun',
    'classifyRunAdOutcome',
    'buildRunReconciliationUpdate',
    'notifyRunFinalized',
    'WORKER_ID',
    'require',
    `${maybeFnSrc}\n${bumpFnSrc}\nreturn { bumpRunCounter, maybeFinalizeRun };`
  );
}

function bindExtracted(Ad, CampaignRun) {
  return compileExtractedFns()(
    Ad,
    CampaignRun,
    classifyRunAdOutcome,
    buildRunReconciliationUpdate,
    function notifyRunFinalized() {},
    'harness',
    function harnessRequire(id) {
      if (id === './runFeedService') return { finishRun() {} };
      throw new Error(`extracted maybeFinalizeRun required unexpected module ${id}`);
    }
  );
}

async function main() {
await check('sanity: the extracted update increments the named field and refreshes both clocks', () => {
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
  assert.strictEqual(after.status, 'running', 'the $inc/$set literal itself must never touch status — that is maybeFinalizeRun\'s job');
  assert.ok(!/\bstatus\b/.test(updateArgText), 'extracted $inc/$set literal must not mention status');
});

await check('sanity: extracted bumpRunCounter source awaits maybeFinalizeRun after the $inc', () => {
  const incIdx = bumpBody.indexOf('CampaignRun.updateOne(');
  const finalizeIdx = bumpBody.search(/await\s+maybeFinalizeRun\s*\(\s*runId\s*\)/);
  assert.ok(finalizeIdx > incIdx, 'maybeFinalizeRun must run AFTER the counter $inc, not before');
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP A — reproduce the measured incident shape through the REAL
// completion mechanism (extracted bumpRunCounter → maybeFinalizeRun).
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Group A: replaying the measured incident shape ──');

const RUN_ID = 'run_1787557633213_a0ccdd01';
const runDoc = {
  runId: RUN_ID,
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
const ads = [
  { campaignRunIds: [RUN_ID], status: 'rendering', kind: 'image' },
  { campaignRunIds: [RUN_ID], status: 'rendering', kind: 'image' },
  { campaignRunIds: [RUN_ID], status: 'rendering', kind: 'image' }
];
const CampaignRun = makeStubCampaignRun(runDoc);
const Ad = makeStubAd(ads);
const { bumpRunCounter } = bindExtracted(Ad, CampaignRun);

ads[0].status = 'draft';
await bumpRunCounter([RUN_ID], 'succeeded');
ads[1].status = 'draft';
await bumpRunCounter([RUN_ID], 'succeeded');

await check('A0 a run does not finalize while a claimed ad is still rendering', () => {
  const mid = CampaignRun.snapshot();
  assert.strictEqual(mid.status, 'running',
    `run flipped to '${mid.status}' after only 2/3 ads settled — maybeFinalizeRun must re-read live Ads, not trust counters`);
  assert.strictEqual(mid.completedAt, null);
  assert.strictEqual(mid.succeeded, 2);
});

ads[2].status = 'failed';
await bumpRunCounter([RUN_ID], 'failed');
const run = CampaignRun.snapshot();

await check('A1 counters match the measured incident (succeeded=2, failed=1, total=3)', () => {
  assert.strictEqual(run.succeeded, 2);
  assert.strictEqual(run.failed, 1);
  assert.strictEqual(run.total, 3);
  assert.strictEqual(run.succeeded + run.failed + run.skipped, run.total, 'every claimed ad has settled');
});

await check('A2 a run whose every claimed ad has settled reaches a terminal state', () => {
  assert.ok(['done', 'failed'].includes(run.status),
    `run stayed '${run.status}' with completedAt:${run.completedAt} after all 3 ads settled — ` +
    'bumpRunCounter must call maybeFinalizeRun so classifyRunAdOutcome + buildRunReconciliationUpdate ' +
    'can CAS status to done/failed.');
});

await check('A3 completedAt is stamped once the run is settled', () => {
  assert.ok(run.completedAt instanceof Date,
    'completedAt stayed null — an operator polling GET /api/ads/runs/:id has no signal the batch finished');
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP B — terminal status strings still live in the vendored builders,
// not as literals on a CampaignRun write in renderer.js. maybeFinalizeRun
// passes the builder's `update` object through.
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Group B: terminal status literals stay in the vendored builders ──');

await check('B1 no source file in src/ has a CampaignRun.<write>() call site that sets status to "done"/"failed" outside campaignRunGuards.js\'s own builders', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  const CALL_RE = /CampaignRun\.(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate)\(/g;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (full === path.join(srcDir, 'services', 'campaignRunGuards.js')) continue;
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
// export correctly, and ARE called from renderer.js (the closed defect).
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Group C: the vendored fix is wired from renderer.js ──');

await check('C1 classifyRunAdOutcome and buildRunReconciliationUpdate ARE exported from campaignRunGuards.js', () => {
  assert.strictEqual(typeof classifyRunAdOutcome, 'function');
  assert.strictEqual(typeof buildRunReconciliationUpdate, 'function');
});

await check('C2 classifyRunAdOutcome has at least one real call site outside its own module', () => {
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
  assert.ok(callers.includes('services/renderer.js'),
    `classifyRunAdOutcome must be called from renderer.js (the completion path); found: ${callers.join(', ') || '(none)'}`);
});

await check('C3 renderer.js requires campaignRunGuards and binds both helpers (a call without the import is a ReferenceError)', () => {
  assert.ok(
    /require\(\s*['"]\.\/campaignRunGuards['"]\s*\)/.test(RENDERER_SRC),
    'renderer.js no longer requires ./campaignRunGuards'
  );
  assert.ok(/classifyRunAdOutcome/.test(RENDERER_SRC) && /buildRunReconciliationUpdate/.test(RENDERER_SRC),
    'renderer.js no longer binds classifyRunAdOutcome / buildRunReconciliationUpdate from the require');
});

// Supporting demonstration that the vendored builders still produce the
// correct update for this exact incident shape.
await check('D1 classifyRunAdOutcome + buildRunReconciliationUpdate correctly finalize this exact run', () => {
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
  console.log(`❌ verifyRunFinalizesOnSettle: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyRunFinalizesOnSettle: ${total}/${total} checks passed`);
}

main().catch((err) => {
  console.error('verifyRunFinalizesOnSettle: internal error:', err);
  process.exit(1);
});
