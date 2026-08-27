#!/usr/bin/env node
'use strict';
//
// verifyUnsettledTimeoutBounded — pins the bound on processAd's
// unsettledAtTimeout branch, and the money invariant that a receipt-holding row
// is never handed back to claimOne.
//
// ── THE INCIDENT THIS CLOSES (measured, 2026-08-26) ────────────────────────
// A production CampaignRun sat `running` for 2h21m. ONE video master
// (6a8fb12ad0621a3e8f4a7d49) produced TEN DISTINCT Atlas prediction ids in that
// window — a fresh billable submit roughly every 12-14 minutes, none completing
// — with 17 derivative ads pinned behind it waiting for the sibling master.
//
// The branch responsible (renderer.js processAd catch) did exactly this:
//
//     if (err && err.unsettledAtTimeout) {
//       await releaseClaim(ad._id, '… left rendering for resume');
//       await bumpRunCounter(ad.campaignRunIds, 'skipped');
//       return;
//     }
//
// It released the claim and left `status:'rendering'`, which is precisely
// claimOne's filter ({status:'rendering', claimedByWorker:null, renderRoute in
// [html_gen, veo]}) — so the row was unconditionally re-eligible, forever, with
// no lifetime cap and no deadline.
//
// ── WHAT THE OLD SAFETY COMMENT GOT WRONG ─────────────────────────────────
// It asserted the re-entry "resumes the SAME prediction — re-polling, never
// resubmitting, so this can only ever cost more poll time, never a second
// charge." Ten distinct prediction ids disprove the conclusion. The gate itself
// is fine — atlasVideoService.shouldResumeAttempt really does require
// allowResume && attempt===1 && a non-empty receipt; renderer passes
// allowResume:true explicitly; veoPredictionId IS declared (models/Ad.js) so the
// charge-point write is not dropped by strict mode; and mayRetryAfterFailure
// (`policyRetryable === true && chargeConfirmed === false && …`) structurally
// cannot retry this error shape in-call. What was false was treating that gate
// as a BOUND. It bounds one door; it bounds nothing about how many times the row
// may be re-queued through it, and the branch counted nothing while doing so.
//
// ── AND WHY THE "FREE RECOVERY" IT DELEGATED TO NEVER FIRED ───────────────
// bootRecoveryService selects {status:'rendering', updatedAt < now -
// RESUME_STALE_MIN, HAS_RECEIPT} and never submits. But renderer's ad heartbeat
// refreshes updatedAt every 60-90s SPECIFICALLY so a live render never looks
// stale — so a row re-claimed within seconds of every release never once sat
// still for the 5 minutes that sweep needs. The mechanism meant to collect the
// asset for $0 was structurally unreachable for exactly the ads that needed it.
//
// ── NOT A BLINDED CEILING — NO CEILING WAS IN SCOPE ───────────────────────
// First triage assumed a frozen renderAttempts had blinded an existing cap.
// It had not. strandedRunSweeper's `renderAttempts < STRANDED_SWEEP_MAX_ATTEMPTS`
// lives inside buildStrandedAdFilter, which ALSO requires `status:'queued'` and
// membership in a FAILED run — a 'rendering' ad on a 'running' run is outside
// that filter at any counter value. queuedArchiveSweeper's renderAttempts:0
// guard is likewise 'queued'-scoped. Group D below pins that, so nobody
// re-derives the wrong conclusion from the counter fix alone.
//
// Offline only: no DB, no network, no Atlas key, no mongoose. Group A executes
// the real decision function; Groups B/C drive stubs from the REAL source text.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'renderer.js'), 'utf8');
const strandedSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'strandedRunSweeper.js'), 'utf8');
const bootSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'bootRecoveryService.js'), 'utf8');

const { resolveUnsettledTimeoutAction, HAS_RECEIPT } = require(
  path.join(REPO, 'src', 'services', 'spendReceipt.js')
);

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

// Extract the body of a named top-level async function from renderer.js by
// brace-matching from its declaration. STRUCTURAL WINDOWS MUST BE SYNTACTIC —
// a magic character count drifts stale the moment the function grows.
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `could not find declaration: ${decl}`);
  // FIND THE BODY BRACE, NOT A PARAMETER BRACE. `function f({ a } = {}) {` has
  // two `{` before the body, so taking the first one silently returns the
  // DESTRUCTURING PATTERN instead — which is how D1 first failed here, with a
  // regex that was actually correct. Skip any brace seen while inside the
  // parameter parens.
  let open = -1;
  let paren = 0;
  for (let i = start + decl.length; i < src.length; i++) {
    const c = src[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '{' && paren === 0) { open = i; break; }
  }
  assert.ok(open !== -1, `no body brace after ${decl}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces from ${decl}`);
}

const settleBody = functionBody(rendererSrc, 'async function settleUnsettledVideoTimeout');

console.log('\nA. The decision itself — EXECUTED, full parameter sweep');

// A SWEEP, NOT A SAMPLE. A single point near a threshold cannot tell a correct
// boundary from an off-by-one, so walk the whole small space.
check('A1: with a live receipt, every attempt strictly below the cap HOLDS (never released, never failed)', () => {
  for (let cap = 2; cap <= 6; cap++) {
    for (let att = 1; att < cap; att++) {
      const d = resolveUnsettledTimeoutAction({ receipt: 'pred_abc', attempts: att, cap });
      assert.strictEqual(d.action, 'hold', `cap=${cap} attempts=${att} → ${d.action}`);
      assert.strictEqual(d.receipt, 'pred_abc', 'hold must carry the receipt through');
    }
  }
});

check('A2: with a live receipt, reaching OR passing the cap is TERMINAL', () => {
  for (let cap = 2; cap <= 6; cap++) {
    for (let att = cap; att <= cap + 3; att++) {
      const d = resolveUnsettledTimeoutAction({ receipt: 'pred_abc', attempts: att, cap });
      assert.strictEqual(d.action, 'terminal', `cap=${cap} attempts=${att} → ${d.action}`);
      assert.strictEqual(d.receipt, 'pred_abc',
        'terminal MUST still carry the receipt — it is the only handle to work we paid for');
    }
  }
});

check('A3: the cap boundary is exactly at attempts === cap (no off-by-one either side)', () => {
  const cap = 3;
  assert.strictEqual(resolveUnsettledTimeoutAction({ receipt: 'p', attempts: 2, cap }).action, 'hold');
  assert.strictEqual(resolveUnsettledTimeoutAction({ receipt: 'p', attempts: 3, cap }).action, 'terminal');
});

check('A4: NO receipt under the cap RELEASES — a receipt-free row was never billed, so requeue is safe', () => {
  for (const receipt of [null, undefined, '', 0, false]) {
    const d = resolveUnsettledTimeoutAction({ receipt, attempts: 1, cap: 3 });
    assert.strictEqual(d.action, 'release', `receipt=${JSON.stringify(receipt)} → ${d.action}`);
    assert.strictEqual(d.receipt, null, 'release must normalise a falsy receipt to null');
  }
});

check('A5: NO receipt at the cap is still TERMINAL — the release arm is bounded too', () => {
  const d = resolveUnsettledTimeoutAction({ receipt: null, attempts: 3, cap: 3 });
  assert.strictEqual(d.action, 'terminal');
});

check('A6: a FIRST timeout on a paid row can NEVER be terminal, at any cap value', () => {
  // The money cliff: terminal-failing attempt 1 forecloses free recovery,
  // because bootRecoveryService only sweeps status:'rendering'. Includes the
  // mis-set cap=1 and cap=0 cases and unreadable values.
  for (const cap of [1, 0, -5, null, undefined, NaN, 'x', 2, 3, 10]) {
    const d = resolveUnsettledTimeoutAction({ receipt: 'pred_abc', attempts: 1, cap });
    assert.strictEqual(d.action, 'hold', `cap=${JSON.stringify(cap)} terminal-failed attempt 1`);
  }
});

check('A7: an unreadable attempt count fails CLOSED to attempt 1, not to the cap', () => {
  for (const attempts of [NaN, null, undefined, 0, -3, 'x']) {
    const d = resolveUnsettledTimeoutAction({ receipt: 'p', attempts, cap: 3 });
    assert.strictEqual(d.action, 'hold', `attempts=${JSON.stringify(attempts)} → ${d.action}`);
    assert.strictEqual(d.attempts, 1);
  }
});

check('A8: no argument shape throws — this runs inside a catch block', () => {
  assert.doesNotThrow(() => resolveUnsettledTimeoutAction());
  assert.doesNotThrow(() => resolveUnsettledTimeoutAction({}));
});

check('A9: with the free poller OFF, a paid row goes TERMINAL rather than parking forever', () => {
  // Parking depends entirely on something coming back for the receipt. With
  // RESUME_IN_FLIGHT_ON_BOOT=false nothing does: the reaper skips claimed rows,
  // the shutdown drain only releases receipt-FREE rows, and bootRecovery's
  // still-processing count never pages. Failing honestly beats a silent strand.
  for (let att = 1; att <= 5; att++) {
    const d = resolveUnsettledTimeoutAction({
      receipt: 'pred_abc', attempts: att, cap: 3, freePollerEnabled: false
    });
    assert.strictEqual(d.action, 'terminal', `attempts=${att} parked with no poller`);
    assert.strictEqual(d.receipt, 'pred_abc', 'the receipt must survive this terminal too');
  }
});

check('A10: freePollerEnabled defaults to true, matching bootRecoveryService\'s own default', () => {
  const d = resolveUnsettledTimeoutAction({ receipt: 'p', attempts: 1, cap: 3 });
  assert.strictEqual(d.action, 'hold',
    'the default must not silently fail-terminal on the normal path');
});

check('A11: every outcome carries a distinguishable reason', () => {
  const cases = [
    [{ receipt: 'p', attempts: 1, cap: 3 }, 'hold', 'awaiting-free-recovery'],
    [{ receipt: 'p', attempts: 3, cap: 3 }, 'terminal', 'cap-reached'],
    [{ receipt: 'p', attempts: 1, cap: 3, freePollerEnabled: false }, 'terminal', 'no-free-poller'],
    [{ receipt: null, attempts: 1, cap: 3 }, 'release', 'no-receipt']
  ];
  for (const [input, action, reason] of cases) {
    const d = resolveUnsettledTimeoutAction(input);
    assert.strictEqual(d.action, action, JSON.stringify(input));
    assert.strictEqual(d.reason, reason, `${JSON.stringify(input)} reason=${d.reason}`);
  }
  // The two terminals must be TELLABLE APART — they are different operator
  // stories and a generic message sends someone hunting the wrong one.
  const capped = resolveUnsettledTimeoutAction({ receipt: 'p', attempts: 3, cap: 3 });
  const noPoll = resolveUnsettledTimeoutAction({ receipt: 'p', attempts: 1, cap: 3, freePollerEnabled: false });
  assert.notStrictEqual(capped.reason, noPoll.reason);
});

console.log('\nB. The renderer wiring — the branch is REACHED and each arm honours the decision');

check('B1: the unsettledAtTimeout branch delegates to settleUnsettledVideoTimeout', () => {
  assert.ok(
    /if \(err && err\.unsettledAtTimeout\) \{\s*await settleUnsettledVideoTimeout\(ad, err\);\s*return;\s*\}/.test(rendererSrc),
    'processAd no longer routes unsettledAtTimeout to settleUnsettledVideoTimeout'
  );
});

check('B2: the OLD unbounded shape is gone — no bare releaseClaim+return in that branch', () => {
  assert.ok(
    !/if \(err && err\.unsettledAtTimeout\) \{\s*await releaseClaim\(/.test(rendererSrc),
    'the unbounded release-the-claim requeue is back'
  );
});

check('B3: every pass through the branch COUNTS — renderAttempts is $inc\'d', () => {
  assert.ok(/\$inc:\s*\{\s*renderAttempts:\s*1\s*\}/.test(settleBody),
    'settleUnsettledVideoTimeout does not $inc renderAttempts');
  // And it reads the post-image back, so the cap sees a real number rather than
  // a stale in-memory one.
  assert.ok(/findOneAndUpdate/.test(settleBody) && /new:\s*true/.test(settleBody),
    'the counter is not read back atomically ({new:true})');
});

check('B4: renderAttempts, NOT deriveWaitAttempts — this path submits and bills', () => {
  assert.ok(!/deriveWaitAttempts/.test(settleBody),
    'deriveWaitAttempts is for the wait-only derive path that never bills');
});

check('B5: the decision comes from the pure function, not re-derived inline', () => {
  assert.ok(/resolveUnsettledTimeoutAction\(/.test(settleBody),
    'settleUnsettledVideoTimeout does not call resolveUnsettledTimeoutAction');
  for (const action of ['terminal', 'hold']) {
    assert.ok(new RegExp(`decision\\.action === '${action}'`).test(settleBody),
      `the '${action}' arm is not keyed off the decision`);
  }
});

check('B6: THE MONEY ARM — the hold arm contains no releaseClaim', () => {
  // Brace-match the `if (decision.action === 'hold') { … }` block and prove the
  // claim is not dropped inside it. A released claim on a 'rendering' row is
  // exactly claimOne's filter, i.e. a fresh billable submit.
  const holdBody = functionBody(settleBody, "if (decision.action === 'hold')");
  assert.ok(!/releaseClaim/.test(holdBody),
    'the hold arm releases the claim — this reopens the resubmit loop');
  assert.ok(!/claimedByWorker:\s*null/.test(holdBody),
    'the hold arm clears claimedByWorker — same effect as releaseClaim');
  assert.ok(!/status:\s*'queued'/.test(holdBody), 'the hold arm requeues the row');
});

check('B7: the terminal arm reaches a real terminal state and clears the claim', () => {
  const termBody = functionBody(settleBody, "if (decision.action === 'terminal')");
  assert.ok(/status:\s*'failed'/.test(termBody), 'terminal arm does not write status:failed');
  assert.ok(/claimedByWorker:\s*null/.test(termBody), 'terminal arm leaves the row claimed');
  assert.ok(/renderStage:\s*'done'/.test(termBody), 'terminal arm leaves a live-timer stage');
});

check('B8: the terminal arm preserves the receipt and refuses to assert a non-charge', () => {
  const termBody = functionBody(settleBody, "if (decision.action === 'terminal')");
  assert.ok(/predictionId:\s*receipt/.test(termBody),
    'the receipt is dropped on terminal failure — the only handle to a paid asset');
  assert.ok(/chargeState:\s*'unknown'/.test(termBody),
    "chargeState must be 'unknown'; 'not-charged' would understate the ledger unrecoverably");
  assert.ok(!/chargeState:\s*'not-charged'/.test(termBody), "terminal arm asserts a non-charge it cannot know");
});

check('B11: the hold arm PERSISTS the receipt when the charge point did not', () => {
  // atlasVideoService's veoPredictionId $set is deliberately non-fatal, so a
  // billed prediction can exist only on the thrown Error. HAS_RECEIPT matches
  // the MONGO field, so parking without backfilling would hand the free sweep a
  // row it cannot see: claim held, money spent, nothing coming back.
  const holdBody = functionBody(settleBody, "if (decision.action === 'hold')");
  assert.ok(/\$set:\s*\{\s*veoPredictionId:\s*receipt\s*\}/.test(holdBody),
    'the hold arm does not backfill veoPredictionId — a receipt that exists only on the ' +
    'Error would make this paid row invisible to bootRecoveryService');
  assert.ok(/claimedByWorker:\s*WORKER_ID/.test(holdBody),
    'the backfill write is not owner-scoped');
  assert.ok(/veoPredictionId:\s*\{\s*\$in:\s*\[null,\s*''\]\s*\}/.test(holdBody),
    'the backfill is not guarded to empty-only — it could overwrite a newer receipt');
});

check('B12: the hold arm ALERTS, because nothing else pages on a parked row', () => {
  const holdBody = functionBody(settleBody, "if (decision.action === 'hold')");
  assert.ok(/alerts\.notifyAsync\(/.test(holdBody),
    'a parked paid master is silent: bootRecovery gates its Slack report on ' +
    'recovered+failed+recoverableNotCollected so stillRunning never pages, there is no ' +
    'periodic stale-rendering scanner here, and the cap escalation cannot fire on this arm');
  assert.ok(/video-unsettled-parked:\$\{ad\._id\}/.test(holdBody),
    'the park alert is not ad-scoped — parks for different ads would fold into one message');
});

check('B13: the free-poller state is READ, not assumed', () => {
  assert.ok(/require\('\.\/bootRecoveryService'\)\.enabled\(\)/.test(settleBody),
    'freePollerEnabled is not read from bootRecoveryService.enabled()');
  assert.ok(/freePollerEnabled/.test(settleBody), 'the decision is not told whether the poller runs');
  // And it must fail towards NOT parking, never towards betting a paid asset on
  // a sweep that may not exist.
  const readBlock = settleBody.slice(settleBody.indexOf('let freePollerEnabled'),
    settleBody.indexOf('const decision'));
  assert.ok(/freePollerEnabled = false/.test(readBlock),
    'an unreadable poller state does not fail towards terminal');
});

check('B14: the two terminals are distinguishable in the persisted message', () => {
  const termBody = functionBody(settleBody, "if (decision.action === 'terminal')");
  assert.ok(/decision\.reason === 'no-free-poller'/.test(termBody),
    'the terminal message does not distinguish a disabled sweep from a reached cap');
});

check('B9: a repeat escalates rather than folding into the deduped warn', () => {
  assert.ok(/video-unsettled-repeat:/.test(settleBody), 'no ad-scoped escalation key');
  assert.ok(/level:\s*'error'/.test(settleBody), 'the repeat alert is not an error');
  assert.ok(/attempts > 1/.test(settleBody), 'the escalation is not gated on a repeat');
});

check('B10: the cap is env-tunable, and its REPORTED floor matches the DECIDED floor', () => {
  const m = rendererSrc.match(
    /UNSETTLED_TIMEOUT_MAX_ATTEMPTS\s*=\s*Math\.max\(\s*(\d+),\s*parseInt\(process\.env\.VIDEO_UNSETTLED_MAX_ATTEMPTS,\s*10\)\s*\|\|\s*(\d+)/
  );
  assert.ok(m, 'cap is not read from VIDEO_UNSETTLED_MAX_ATTEMPTS with a numeric default');
  assert.ok(Number(m[2]) >= 2, `default cap ${m[2]} would terminal-fail a first timeout`);
  // The constant feeds the Slack `cap` field and the persisted message; the pure
  // function is what actually decides. If the two floors disagree, behaviour is
  // right and the diagnostics lie — which is its own defect.
  const spendSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'spendReceipt.js'), 'utf8');
  const pureFloor = spendSrc.match(/const ceiling = Math\.max\((\d+),/);
  assert.ok(pureFloor, 'could not read the decision function\'s ceiling floor');
  assert.strictEqual(Number(m[1]), Number(pureFloor[1]),
    `renderer floors the cap at ${m[1]} while the decision floors it at ${pureFloor[1]} — ` +
    'alerts and logs would report a cap nothing enforces');
});

check('B15: the terminal write is CLAIM-SCOPED, like the ordinary terminal write', () => {
  // bootRecoveryService's persist uses the looser `{_id, status:'rendering'}`, so
  // an unowned write here could stamp 'failed' while a concurrent sweep is
  // mid-peek on a prediction that then settles 'done' — the sweep's own
  // status-guarded $set then silently no-ops and a paid, delivered output is
  // recorded as failed.
  const termBody = functionBody(settleBody, "if (decision.action === 'terminal')");
  assert.ok(/claimedByWorker:\s*WORKER_ID/.test(termBody),
    'the terminal write is not owner-scoped — it can race bootRecoveryService');
  assert.ok(/status:\s*'rendering'/.test(termBody),
    'the terminal write no longer guards on the pre-state');
});

check('B16: DOCUMENTED LIMITATION — the cap reads renderAttempts, which counts more than timeouts', () => {
  // renderAttempts is also $inc'd by the COMPLETION writes, so `attempts` is
  // "render starts", not "timeout-branch entries". A first-time master is
  // unaffected (0 -> 1, holds), and every OTHER reader of the field is
  // status:'queued'-scoped so the increment is strictly safer for them. The
  // narrow bad case is an ad re-entering renderer with a nonzero stored count,
  // which could terminal or escalate on its first timeout. A dedicated counter
  // is the real fix but needs a DECLARED schema field, and verifyModelParity
  // asserts adgen's paths are a SUBSET of the backend's — so it is a coordinated
  // cross-repo change, not a unilateral one. This check exists so the tradeoff
  // stays visible rather than being rediscovered as a surprise.
  assert.ok(/KNOWN CONFLATION/.test(settleBody),
    'the renderAttempts conflation is no longer documented at the increment site');
  assert.ok(/RENDER STARTS, not timeout-branch entries/.test(settleBody),
    'the documentation no longer says what the counter actually counts');
});

console.log('\nC. Claimability — driven by claimOne\'s REAL filter text');

// Extract claimOne's real filter and evaluate it against candidate docs, so this
// tests the shipped predicate rather than a restatement of it.
const claimBody = functionBody(rendererSrc, 'async function claimOne');
const claimFilterRequiresUnclaimed = /claimedByWorker:\s*null/.test(claimBody);
const claimFilterRequiresRendering = /status:\s*'rendering'/.test(claimBody);

function claimable(doc) {
  // Mirrors the extracted predicate above, asserted to exist by C1.
  if (claimFilterRequiresRendering && doc.status !== 'rendering') return false;
  if (claimFilterRequiresUnclaimed && doc.claimedByWorker !== null) return false;
  return true;
}

check('C1: claimOne really does gate on status:rendering AND claimedByWorker:null', () => {
  assert.ok(claimFilterRequiresRendering, "claimOne no longer filters status:'rendering'");
  assert.ok(claimFilterRequiresUnclaimed, 'claimOne no longer filters claimedByWorker:null');
});

check('C2: the OLD behaviour was claimable — proves the harness can see the bug', () => {
  // Positive control. Without this, C3/C4 could pass vacuously.
  const afterOldRelease = { status: 'rendering', claimedByWorker: null };
  assert.strictEqual(claimable(afterOldRelease), true,
    'the old release-the-claim outcome should be claimable — control is broken');
});

check('C3: a HELD row is NOT claimable — the resubmit loop is closed', () => {
  const held = { status: 'rendering', claimedByWorker: 'renderer-abc' };
  assert.strictEqual(claimable(held), false, 'a held row is still claimable');
});

check('C4: a TERMINAL row is NOT claimable', () => {
  const terminal = { status: 'failed', claimedByWorker: null };
  assert.strictEqual(claimable(terminal), false, 'a failed row is still claimable');
});

check('C5: a HELD row is still visible to bootRecoveryService (free GET, no submit)', () => {
  // HAS_RECEIPT is the real exported selector fragment. Assert on the TOP-LEVEL
  // key only: scripts/lib/miniMongoStub.js resolves dotted paths as flat keys
  // (`doc[key]`), so a nested 'imageGeneration.predictionId' assertion would be
  // meaningless there. See PR #80.
  const clauses = HAS_RECEIPT.$or.map((c) => Object.keys(c)[0]);
  assert.ok(clauses.includes('veoPredictionId'),
    'HAS_RECEIPT no longer matches the video receipt');
  assert.ok(/status:\s*'rendering'/.test(bootSrc), "bootRecoveryService no longer selects status:'rendering'");

  // THE INVARIANT, NOT TODAY'S SPELLING OF IT. The hold arm requires that a
  // CLAIMED, STALE, receipt-holding 'rendering' row still be swept. Two shapes
  // satisfy that, and this must stay green across both:
  //
  //   (a) BEFORE PR #75 (the shape this branch was written against): the
  //       selector has no claim predicate at all, so a claimed row is swept on
  //       the single updatedAt clock. bootRecovery's header called the missing
  //       lease deliberate.
  //   (b) AFTER PR #75 — **this is now the merged reality**, c02c7ff, which
  //       landed underneath this branch and was picked up in the 2026-08-27
  //       rebase: the selector grew a claimed arm,
  //       `{claimedByWorker:{$ne:null}, updatedAt:{$lt:claimCutoff},
  //       claimedAt:{$lt:claimCutoff}}`, plus a third arm for a claim with no
  //       claimedAt — a claimed row is STILL swept, just on the longer
  //       RESUME_CLAIM_STALE_MIN window, and needing BOTH clocks stale rather
  //       than updatedAt alone. Compatible with the hold arm: a held row's
  //       claimedAt is already ~15min old, because the Atlas poll ran under
  //       that same claim, and nothing refreshes updatedAt once we stop
  //       re-claiming.
  //
  // (a) is kept here deliberately rather than deleted: this check must not
  // start REQUIRING the claim-aware shape either, or it would pin (b) and go
  // red on a revert of #75. It is the invariant that matters, not which of the
  // two selectors is currently checked in.
  //
  // Asserting "no claimedByWorker anywhere" would pin (a) and turn red the day
  // #75 lands, on an improvement. What must NEVER appear is a claim predicate
  // that admits ONLY unclaimed rows.
  // SCAN THE WHOLE MODULE, not a character window after `Ad.find(`. The earlier
  // version of this check looked at the 400 chars following the first `Ad.find(`
  // — which PR #75 defeats by construction, because it moves the predicate into
  // `buildRecoverySweepFilter(...)` and the claim clauses then live OUTSIDE that
  // window. The check would have stayed green on a selector that had started
  // skipping claimed rows, i.e. exactly the regression it exists to catch.
  // Caught by adversarial review 2026-08-27.
  const mentionsClaim = /claimedByWorker/.test(bootSrc);
  if (mentionsClaim) {
    assert.ok(/claimedByWorker:\s*\{\s*\$ne:\s*null\s*\}/.test(bootSrc),
      'bootRecoveryService now reads claimedByWorker but has no arm admitting a CLAIMED row — ' +
      'the hold arm would strand every held ad permanently');
    assert.ok(/claimedAt:\s*\{\s*\$lt:/.test(bootSrc),
      'the claimed arm does not fall stale on claimedAt — a held claim could never age in');
  }
});

check('C6: holding does not restart bootRecovery\'s staleness clock', () => {
  // Ad.js sets `timestamps: false`, so the $inc does not silently bump
  // updatedAt. If that ever flips to true, the hold arm would keep refreshing
  // updatedAt and re-starve the sweep exactly as the heartbeat did.
  const adSrc = fs.readFileSync(path.join(REPO, 'src', 'models', 'Ad.js'), 'utf8');
  assert.ok(/timestamps:\s*false/.test(adSrc),
    'Ad schema no longer sets timestamps:false — the $inc may now bump updatedAt and re-starve bootRecovery');
  const incWrite = settleBody.slice(settleBody.indexOf('$inc'), settleBody.indexOf('$inc') + 200);
  assert.ok(!/updatedAt/.test(incWrite), 'the counter write bumps updatedAt, restarting the staleness clock');
});

console.log('\nD. The ceiling that was never in scope (pins the corrected diagnosis)');

check('D1: strandedRunSweeper\'s attempt ceiling is gated on status:queued, so it never covered this', () => {
  const filterBody = functionBody(strandedSrc, 'function buildStrandedAdFilter');
  assert.ok(/renderAttempts:\s*\{\s*\$lt:\s*MAX_ATTEMPTS\s*\}/.test(filterBody),
    'the renderAttempts ceiling left buildStrandedAdFilter');
  assert.ok(/status:\s*'queued'/.test(filterBody),
    "buildStrandedAdFilter no longer requires status:'queued' — re-check whether it now covers 'rendering'");
  assert.ok(!/status:\s*'rendering'/.test(filterBody),
    'buildStrandedAdFilter now mentions rendering — the scope claim in this harness needs revisiting');
});

console.log('\nE. The poll ceiling — sized from the measured distribution');

// MEASURED 2026-08-27, n=68 delivered videos at FIXED parameters (production is
// 100% 1080p and 100% exactly 10.000s, so neither is a variable):
//   mean 229.7s   sd 124.5s   range 120-760.3s   CV 54%
// Variance is provider-side: three pairs submitted ~1s apart with byte-identical
// reference stacks came back up to 3.7x apart, and submit-burst/latency
// correlation is 0.02-0.06.
const OBSERVED_MAX_S = 760.3;
const MEAN_S = 229.7;
const SD_S = 124.5;
const atlasSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'atlasVideoService.js'), 'utf8');
const defaultsEnv = fs.readFileSync(path.join(REPO, 'config', 'defaults.env'), 'utf8');

function pollCeilingMs() {
  const m = atlasSrc.match(
    /const MAX_POLL_MS\s*=\s*parseInt\(process\.env\.ATLAS_TIMEOUT_MS,\s*10\)\s*\|\|\s*(\d+)/
  );
  assert.ok(m, 'could not read MAX_POLL_MS default from atlasVideoService.js');
  return Number(m[1]);
}

check('E1: the ceiling EXCEEDS the observed provider maximum', () => {
  const ms = pollCeilingMs();
  assert.ok(ms / 1000 > OBSERVED_MAX_S,
    `ceiling ${ms / 1000}s does not clear the measured maximum ${OBSERVED_MAX_S}s — ` +
    'renders that were going to succeed will still be abandoned mid-flight');
});

check('E2: the ceiling sits at least 4 sd above the mean', () => {
  const s = pollCeilingMs() / 1000;
  const sigmas = (s - MEAN_S) / SD_S;
  assert.ok(sigmas >= 4,
    `ceiling is only mean+${sigmas.toFixed(2)}sd; the old 600s value was mean+2.97sd and timed out real work`);
});

check('E3: the ceiling is env-tunable and declared in config/defaults.env', () => {
  assert.ok(/process\.env\.ATLAS_TIMEOUT_MS/.test(atlasSrc), 'ATLAS_TIMEOUT_MS is no longer read from env');
  const m = defaultsEnv.match(/^ATLAS_TIMEOUT_MS=(\d+)/m);
  assert.ok(m, 'ATLAS_TIMEOUT_MS is not declared in config/defaults.env');
  assert.strictEqual(Number(m[1]), pollCeilingMs(),
    'config/defaults.env and the code default disagree — the committed value must match');
});

check('E4: the cross-process reframe lease still outlives the poll', () => {
  // If the lease could expire mid-poll a second process would steal the claim
  // and BOTH would bill. The floor is what makes raising the ceiling safe.
  assert.ok(/Math\.max\(configured,\s*MAX_POLL_MS \+ 10 \* 60 \* 1000\)/.test(atlasSrc),
    'REFRAME_CLAIM_TTL_MS is no longer floored at MAX_POLL_MS + 10min — raising the poll ceiling ' +
    'can now expire the lease mid-flight and reintroduce a double charge');
});

check('E5: raising the ceiling did NOT remove the receipt handling it complements', () => {
  // A ceiling at any finite value still fires sometimes (900s is p99.84, not
  // p100). The receipt path is what makes that safe, so the two must not drift
  // apart — someone "fixing" timeouts by raising the ceiling alone would
  // reintroduce the loop for the residual tail.
  assert.ok(/decision\.action === 'hold'/.test(settleBody),
    'the hold arm is gone — the tail beyond the ceiling would resubmit again');
});

console.log(
  `\n${failed === 0 ? '✅' : '❌'} verifyUnsettledTimeoutBounded: ${passed} passed, ${failed} failed\n`
);
process.exit(failed === 0 ? 0 : 1);
