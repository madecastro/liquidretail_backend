#!/usr/bin/env node
'use strict';
//
// verifyTitlingRecoverability — a paid video master whose titling fails
// must be RECOVERABLE, not stranded, and the recovery machinery must not be
// able to loop forever OR let two autoscaled workers double-title the same
// ad. This is the harness for the fix that:
//
//   (A) extends brandScriptExecutor's failure stamp from OOM-only to OOM +
//       timeout + a generic child failure/exception, bounded by a shared
//       TITLING_ATTEMPTS_MAX ceiling (past which the ad goes TERMINAL, not
//       resumable — an unbounded retry on a paid path is worse than the
//       stranding it replaces);
//   (B) wires titlingResumeService.resumeUntitledMasters() from the
//       orchestrator role (the one adgen role Render keeps singleton),
//       gated on ADGEN_RENDERER_ENABLED so it cannot race backend's own
//       render/resume path over the SAME collection;
//   (C) relies on titlingResumeService's OWN pre-existing atomic per-
//       document claim to make a resumable ad actually claimable, without
//       touching renderer.js's claimOne() or its status:'rendering' filter
//       at all.
//
// Pure + offline: no real MongoDB, no network, no Chrome/ffmpeg. Ad/Media/
// Brand are the in-memory scripts/lib/miniMongoStub.js collection (chosen
// over mongodb-memory-server, which is not installed in a bare worktree —
// see this repo's CLAUDE.md on npm ci/NODE_PATH). brandScriptExecutor is
// used FOR REAL in section A (the actual money-critical decision function)
// and STUBBED in section C (titlingResumeService's own claim logic is what
// C tests — brandScriptExecutor's real reachability is
// scripts/verifyTitlingResumeNeverResubmits.js's job, not this file's).
//
// Revert-prove (run once by hand, not by this script — see the PR):
//   remove the `attempts > max` check (always resumable)      → A4 red
//   remove `err.titlingResumable` gate in renderer.js          → (see
//     verifyRemotionChildIsolation.js D6, which pins that structurally)
//   remove `isAdgenRendererEnabled()` from orchestrator's tick → B2 red
//   remove the claimFilter's state guard (always the same filter) → C1 red

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { MiniCollection } = require('./lib/miniMongoStub');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      return ret.then(() => { pass += 1; console.log(`  ✓ ${label}`); })
        .catch((err) => { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); });
    }
    pass += 1;
    console.log(`  ✓ ${label}`);
    return undefined;
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
    return undefined;
  }
}

const adModelPath = require.resolve(path.join(ROOT, 'src/models/Ad.js'));
const bsePath = require.resolve(path.join(ROOT, 'src/services/brandScriptExecutor.js'));
const originalAdModel = require.cache[adModelPath];
const originalBse = require.cache[bsePath];

function stubAdModel(col) {
  require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
}
function freshBse() {
  delete require.cache[bsePath];
  return require(bsePath);
}
function restore() {
  if (originalAdModel) require.cache[adModelPath] = originalAdModel; else delete require.cache[adModelPath];
  delete require.cache[bsePath];
}

function oomErr() { const e = new Error('remotion child OOM-killed'); e.oomKilled = true; e.code = 'REMOTION_CHILD_OOM'; return e; }
function timeoutErr() { const e = new Error('remotion child exceeded timeout'); e.timedOut = true; e.code = 'REMOTION_CHILD_TIMEOUT'; return e; }
function genericErr(msg) { return new Error(msg || 'remotion child exited code=1 signal=none'); }

async function sectionA() {
  console.log('\n── A: bounded attempt cap (execution, real stampTitlingFailureAndThrow) ──');

  const col = new MiniCollection([{ _id: 'ad1', titlingAttempts: 0 }]);
  stubAdModel(col);
  const bse = freshBse();

  await check('A1 first failure (OOM) — attempt 1/3, RESUMABLE', async () => {
    const err = oomErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad1' }, err));
    assert.strictEqual(err.titlingResumable, true);
    assert.strictEqual(err.titlingFailureKind, 'oom');
    assert.strictEqual(err.titlingAttempts, 1);
    const set = col.calls[col.calls.length - 1].update.$set;
    assert.strictEqual(set.status, 'draft');
    assert.strictEqual(set.titlingResumeState, 'pending');
    assert.strictEqual(set.claimedByWorker, null);
    assert.strictEqual(set.renderError.code, 'REMOTION_CHILD_OOM');
  });

  await check('A2 second failure (timeout, a DIFFERENT kind) — attempt 2/3, still RESUMABLE (shared ceiling across kinds)', async () => {
    const err = timeoutErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad1' }, err));
    assert.strictEqual(err.titlingResumable, true);
    assert.strictEqual(err.titlingFailureKind, 'timeout');
    assert.strictEqual(err.titlingAttempts, 2);
  });

  await check('A3 [THE CAP] third failure (generic child exit) reaches TITLING_ATTEMPTS_MAX=3 — goes TERMINAL, master kept', async () => {
    // NOT a fourth attempt: TITLING_ATTEMPTS_MAX=3 means at most 3 total
    // attempts ever run, so the 3rd failure — not a 4th — is the one that
    // must stop the retries. `attempts >= max`, not `attempts > max` (an
    // earlier draft of this fix had the off-by-one; A6 below pins the
    // boundary explicitly with a lowered cap so this can't silently drift
    // back).
    const err = genericErr('deterministic bug — throws identically every attempt');
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad1' }, err));
    assert.strictEqual(err.titlingResumable, false);
    assert.strictEqual(err.titlingFailureKind, 'generic');
    assert.strictEqual(err.titlingAttempts, 3);
    const set = col.calls[col.calls.length - 1].update.$set;
    assert.strictEqual(set.status, 'failed');
    assert.strictEqual(set.titlingResumeState, null);
    assert.strictEqual(set.claimedByWorker, null);
  });

  check('A4 the paid master is NEVER touched by the stamp — renderUrl/veoVideoUrl absent from every $set, resumable or terminal', () => {
    const setCalls = col.calls.filter((c) => c.update.$set);
    assert.ok(setCalls.length >= 3, `expected at least 3 $set writes, saw ${setCalls.length}`);
    for (const c of setCalls) {
      assert.strictEqual(c.update.$set.renderUrl, undefined, 'stamp must never write renderUrl');
      assert.strictEqual(c.update.$set.veoVideoUrl, undefined, 'stamp must never write veoVideoUrl');
    }
  });

  // A5 — env override, own isolated ad so A1-A4's counts are untouched.
  const col2 = new MiniCollection([{ _id: 'ad2', titlingAttempts: 0 }]);
  stubAdModel(col2);
  const prevEnv = process.env.TITLING_ATTEMPTS_MAX;
  process.env.TITLING_ATTEMPTS_MAX = '1';
  try {
    const bse2 = freshBse();
    await check('A5 TITLING_ATTEMPTS_MAX=1 env override — the FIRST failure already exceeds a lowered cap', async () => {
      const err = genericErr();
      await assert.rejects(() => bse2.stampTitlingFailureAndThrow({ _id: 'ad2' }, err));
      assert.strictEqual(err.titlingResumable, false, 'cap of 1 means attempt 1 IS the cap, not under it');
    });
  } finally {
    if (prevEnv === undefined) delete process.env.TITLING_ATTEMPTS_MAX; else process.env.TITLING_ATTEMPTS_MAX = prevEnv;
  }

  check('A6 titlingAttemptsMax() is exported and reads the (restored) default of 3', () => {
    delete require.cache[bsePath];
    const bse3 = require(bsePath);
    assert.strictEqual(bse3.titlingAttemptsMax(), 3);
  });
}

function sectionB() {
  console.log('\n── B: resume sweep wiring (structural) ──');
  // WAS orchestrator.js — moved to renderer.js after adversarial review
  // found orchestrator's Render plan is `starter` (~512 MB) while a single
  // Remotion titling slot has been MEASURED at ~1.97 GiB
  // (src/services/renderer.js's REMOTION_QUEUE_CONCURRENCY comment) —
  // resumeUntitledMasters() calls renderBrandScriptAndSave for REAL, so the
  // first ad it actually retitled would have OOM-killed the singleton
  // orchestrator process. renderer.js is `pro_plus` (8 GB) and already
  // budgets exactly this cost; being autoscaled (unlike orchestrator) is
  // safe because of the atomic per-document claim proven in section C, not
  // because only one instance runs the sweep.
  const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');
  const ORCH_SRC = fs.readFileSync(path.join(ROOT, 'src/services/orchestrator.js'), 'utf8');
  const TITLER_SRC = fs.readFileSync(path.join(ROOT, 'src/services/titler.js'), 'utf8');
  const ENTRY_SRC = fs.readFileSync(path.join(ROOT, 'src/entrypoint.js'), 'utf8');

  check('B1 renderer.js requires titlingResumeService and calls resumeUntitledMasters', () => {
    assert.match(RENDERER_SRC, /require\(['"]\.\/titlingResumeService['"]\)/);
    assert.match(RENDERER_SRC, /resumeUntitledMasters\s*\(/);
  });

  check('B2 the sweep tick is gated on isAdgenRendererEnabled — same flag PR #52 wired into claimOne()', () => {
    const fnStart = RENDERER_SRC.indexOf('const tick = ()');
    assert.ok(fnStart > 0, 'tick() not found');
    const tickSrc = RENDERER_SRC.slice(fnStart, fnStart + 500);
    assert.match(tickSrc, /isAdgenRendererEnabled\s*\(\s*\)/);
  });

  check('B3 orchestrator.js does NOT run the sweep — its Render plan (starter, ~512 MB) cannot budget a Remotion slot (~1.97 GiB)', () => {
    assert.ok(!/resumeUntitledMasters/.test(ORCH_SRC), 'orchestrator.js must stay Phase-0 only; running Remotion there would OOM the process');
  });

  check('B4 the sweep re-entrancy-guards itself (a slow pass must not stack concurrent Remotion renders)', () => {
    const fnStart = RENDERER_SRC.indexOf('function startTitlingResumeSweep');
    assert.ok(fnStart > 0);
    assert.match(RENDERER_SRC.slice(fnStart), /inFlightPass/);
  });

  check('B5 shutdown() stops the sweep timers (no dangling interval past a graceful stop)', () => {
    const fnStart = RENDERER_SRC.indexOf('async function shutdown');
    assert.ok(fnStart > 0, 'shutdown() not found');
    assert.match(RENDERER_SRC.slice(fnStart, fnStart + 300), /titlingResumeSweep\.stop\(\)/);
  });

  check('B6 entrypoint.js boots the renderer role — the sweep has somewhere to run', () => {
    assert.match(ENTRY_SRC, /ROLE === 'renderer'/);
  });

  check('B7 titler.js\'s own titling call site also defers to scriptErr.titlingResumable, not just OOM — the two files duplicate this call site by design (its own header: "edit both copies")', () => {
    assert.ok(!/require\(['"]\.\/remotionChildSupervisor['"]\)/.test(TITLER_SRC), 'titler.js no longer needs remotionChildSupervisor at all for its titling catch — only renderer.js still imports isRemotionChildOomError-adjacent helpers where it classifies for other reasons');
    assert.match(TITLER_SRC, /scriptErr\s*&&\s*scriptErr\.titlingResumable/);
  });
}

async function sectionC() {
  console.log('\n── C: resumable ads are claimable, and only ONE worker wins (execution) ──');

  const mediaPath = require.resolve(path.join(ROOT, 'src/models/Media.js'));
  const brandPath = require.resolve(path.join(ROOT, 'src/models/Brand.js'));
  const resumeSvcPath = require.resolve(path.join(ROOT, 'src/services/titlingResumeService.js'));
  const originalMedia = require.cache[mediaPath];
  const originalBrand = require.cache[brandPath];
  const originalResumeSvc = require.cache[resumeSvcPath];
  const originalBseForC = require.cache[bsePath];

  const titleCalls = [];
  require.cache[mediaPath] = {
    id: mediaPath, filename: mediaPath, loaded: true,
    exports: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'media1', brandId: 'brand1', fileType: 'video' }) }) }) }
  };
  require.cache[brandPath] = {
    id: brandPath, filename: brandPath, loaded: true,
    exports: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'brand1', name: 'Test Brand' }) }) }) }
  };
  const col = new MiniCollection([{
    _id: 'race1', status: 'draft', titlingResumeState: 'pending',
    veoVideoUrl: 'https://cdn/master.mp4', mediaId: 'media1',
    renderUrl: null, updatedAt: new Date(Date.now() - 60_000)
  }]);
  require.cache[bsePath] = {
    id: bsePath, filename: bsePath, loaded: true,
    exports: {
      // Records exactly how many times a REAL titling attempt would have
      // run, AND actually persists renderUrl (mirroring what the real
      // renderBrandScriptAndSave's uploadRenderAndStamp does) so C2 below
      // can tell a titled ad from an untouched one. Never touches
      // atlasVideoService — that reachability question is
      // scripts/verifyTitlingResumeNeverResubmits.js's job, tested against
      // the REAL brandScriptExecutor, not this stub.
      renderBrandScriptAndSave: async ({ ad }) => {
        titleCalls.push(ad._id);
        await col.updateOne({ _id: ad._id }, { $set: { renderUrl: 'https://cdn/titled.mp4' } });
        return { renderUrl: 'https://cdn/titled.mp4' };
      },
      qcAndStampVideoAd: async () => ({ ok: true })
    }
  };

  try {
    require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
    delete require.cache[resumeSvcPath];
    const titlingResume = require(resumeSvcPath);

    await check('C1 [ATOMIC CLAIM — the two-autoscaled-workers question] TWO concurrent resumeUntitledMasters() passes race the SAME ad; only ONE titles it', async () => {
      const [outA, outB] = await Promise.all([
        titlingResume.resumeUntitledMasters({ limit: 5 }),
        titlingResume.resumeUntitledMasters({ limit: 5 })
      ]);
      assert.strictEqual(titleCalls.length, 1, `renderBrandScriptAndSave must run exactly once across both racing passes, ran ${titleCalls.length}`);
      const totalTitled = outA.titled + outB.titled;
      const totalSkipped = outA.skipped + outB.skipped;
      assert.strictEqual(totalTitled, 1, 'exactly one pass must report the ad as titled');
      assert.strictEqual(totalSkipped, 1, 'the other pass must report it as skipped (claim already taken), not failed or re-titled');
      // The claim write itself: exactly one updateOne on this ad matched the
      // pending-state filter (modifiedCount 1); the loser's identical filter
      // must have matched zero (state had already flipped to 'claimed').
      const claimWrites = col.calls.filter((c) => c.op === 'updateOne' && c.filter._id === 'race1' && c.filter.titlingResumeState === 'pending');
      assert.strictEqual(claimWrites.length, 2, 'both racing passes attempt the identical claim write');
    });

    check('C2 the winning claim + terminal write never leaves titlingResumeState as \'claimed\' (would leak the ad back to arm 2 forever)', () => {
      const finalDoc = col.docs.find((d) => d._id === 'race1');
      assert.strictEqual(finalDoc.status, 'draft');
      assert.strictEqual(finalDoc.titlingResumeState, null);
      assert.strictEqual(finalDoc.renderUrl, 'https://cdn/titled.mp4');
    });
  } finally {
    if (originalMedia) require.cache[mediaPath] = originalMedia; else delete require.cache[mediaPath];
    if (originalBrand) require.cache[brandPath] = originalBrand; else delete require.cache[brandPath];
    if (originalResumeSvc) require.cache[resumeSvcPath] = originalResumeSvc; else delete require.cache[resumeSvcPath];
    if (originalBseForC) require.cache[bsePath] = originalBseForC; else delete require.cache[bsePath];
  }

  // C3 — a FRESH claim (updatedAt just now) in state 'claimed' must NOT be
  // re-swept: arm 2 of buildResumeFilter requires updatedAt < staleCutoff.
  // This is the "cannot double-claim a LIVE render" half of the guarantee
  // C1 does not cover (C1 covers two callers racing a 'pending' ad; this
  // covers one caller mid-render while a second pass runs).
  check('C3 [LIVE-CLAIM GUARD] a fresh (non-stale) \'claimed\' ad is excluded from the resume query entirely', () => {
    const { buildResumeFilter, CLAIM_STALE_MIN } = require(resumeSvcPath);
    const staleCutoff = new Date(Date.now() - CLAIM_STALE_MIN * 60 * 1000);
    const { matches } = require('./lib/miniMongoStub');
    // renderUrl is NON-null here deliberately — a real claim backfills
    // renderUrl to the master's veoVideoUrl the moment it is taken (see
    // titlingResumeService's claimSet backfill), so a genuinely in-progress
    // claim never has renderUrl:null. A null renderUrl would (correctly)
    // also match arm 3 (the migration arm) regardless of staleness, which
    // would make this fixture test the wrong arm.
    const freshClaim = { status: 'draft', titlingResumeState: 'claimed', updatedAt: new Date(), veoVideoUrl: 'https://cdn/master.mp4', renderUrl: 'https://cdn/master.mp4' };
    assert.ok(!matches(freshClaim, buildResumeFilter(staleCutoff)), 'a fresh claim must not match — it would be a live in-progress render');
    const staleClaim = { ...freshClaim, updatedAt: new Date(Date.now() - (CLAIM_STALE_MIN + 1) * 60 * 1000) };
    assert.ok(matches(staleClaim, buildResumeFilter(staleCutoff)), 'a STALE claim (process died) must match — that is the whole point of arm 2');
  });
}

function sectionD() {
  console.log('\n── D: a cap-exceeded (terminal) titling failure keeps its detailed renderError (structural) ──');
  // Adversarial review (2026-08-25) found: a titlingResumable===false error
  // (cap exceeded) does NOT return early at the renderer.js call site — it
  // rethrows into processAd's outer catch, same as any other genuine render
  // failure. That catch unconditionally called noteRenderIssue(), which
  // adStage.js documents as an UNSCOPED write that overwrites Ad.renderError
  // wholesale — clobbering the stamp's detailed
  // {stage:'titling', code:'REMOTION_CHILD_*', the cap-count message} with a
  // generic {stage:'render', no code}. This never happened before this PR
  // (OOM never reached this catch at all), so it is a real regression this
  // fix introduced, not a pre-existing gap. Fixed by skipping that one call
  // when the error already carries titlingFailureKind (set by
  // stampTitlingFailureAndThrow for every titling failure, resumable or
  // not) — every OTHER failure kind is unaffected, it never carries that
  // field.
  const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');
  check('D1 processAd\'s noteRenderIssue call is skipped for an already-stamped titling failure', () => {
    const idx = RENDERER_SRC.indexOf('noteRenderIssue(ad._id,');
    assert.ok(idx > 0, 'noteRenderIssue call site not found');
    const before = RENDERER_SRC.slice(Math.max(0, idx - 200), idx);
    assert.match(before, /if\s*\(\s*!err\.titlingFailureKind\s*\)\s*\{/,
      'the noteRenderIssue call must be guarded by !err.titlingFailureKind, or it will overwrite the stamp\'s detailed renderError with a generic one');
  });
}

async function main() {
  await sectionA();
  restore();
  sectionB();
  await sectionC();
  restore();
  sectionD();

  console.log('');
  if (failures.length) {
    console.log(`❌ verifyTitlingRecoverability: ${pass}/${pass + failures.length} checks passed\n`);
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
  console.log(`✅ verifyTitlingRecoverability: ${pass}/${pass} checks passed\n`);
}

main().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
