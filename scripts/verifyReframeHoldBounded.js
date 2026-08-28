#!/usr/bin/env node
/**
 * verifyReframeHoldBounded.js
 *
 * Pins the reframe billing-claim hold: how long one process can hold the
 * cross-process reframe claim, versus how long its peers wait before declaring
 * that holder dead and stealing the claim. If the hold can exceed the lease,
 * two processes bill the same outpaint.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 *
 * 1. THE REFRAME POLL INHERITED THE VIDEO CEILING BY OMISSION.
 *    reframeReferenceForAspect called `pollPrediction(id)` with no options, so
 *    the reframe outpaint (nano-banana-2/edit) got MAX_POLL_MS — the ceiling
 *    sized for the VIDEO master (gemini-omni-flash). Nobody chose that
 *    coupling; it was the default parameter value. Measured reframe latency
 *    (n=60, exact CostLog.providerRequestId join, 2026-08-24 → 2026-08-27):
 *    p50 48.5s, p95 136.6s, p99 220.2s, max 232s. The inherited ceiling was
 *    3.9x (this repo) / 2.6x (backend) the observed max.
 *
 * 2. THE LEASE FLOOR WAS DERIVED FROM THAT SAME VIDEO CEILING.
 *    `Math.max(configured, MAX_POLL_MS + 10 * 60 * 1000)`. Two defects in one
 *    expression:
 *      (a) CROSS-REPO. The claim is a field on the SHARED Media document that
 *          liquidretail_adgen also steals from with its own copy of the
 *          formula. #82 raised THIS repo's ATLAS_TIMEOUT_MS to 900000 and left
 *          backend at 600000, so the two sides silently disagreed about when a
 *          holder is dead — 25 min here, 20 min there.
 *      (b) THE "+10 MIN" WAS ALREADY SPENT. Bounded non-poll work inside the
 *          hold totals 602.5s, so the real margin was 600 - 602.5 = MINUS
 *          2.5s in both repos, before any unbounded term.
 *
 * 3. pollPrediction DID NOT RESPECT ITS OWN DEADLINE. The loop condition is
 *    tested only at the top of the `while`; the body then slept a full poll
 *    interval and served a full rate-limit backoff before re-testing. Group C
 *    proves the clamp BEHAVIOURALLY by running the loop.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 *
 *     REFRAME_POLL_MS() + BOUNDED_NON_POLL_MS  <  REFRAME_CLAIM_TTL_MS()
 *
 * Group B sweeps the env parameter space rather than sampling one point, so a
 * future knob change cannot land a configuration that satisfies the default
 * case and violates a reachable one.
 *
 * ── HONEST SCOPE ───────────────────────────────────────────────────────────
 * BOUNDED_NON_POLL_MS counts only work with an actual timeout. Terms with NO
 * timeout are deliberately EXCLUDED and are the reason the floor keeps real
 * margin rather than being sized exactly to the sum:
 *   - every sharp() call in the hold (no wall-clock deadline anywhere)
 *   - every Mongo op in the hold (src/db.js's CONNECT_OPTIONS sets
 *     serverSelectionTimeoutMS but NO socketTimeoutMS, and no reframe query
 *     passes maxTimeMS)
 * The Cloudinary 60s terms are socket-INACTIVITY timeouts (the SDK's
 * `post_request.setTimeout` default, node_modules/cloudinary/lib/uploader.js),
 * not total-duration deadlines, so a slow trickling transfer can exceed them.
 *
 * OFFLINE. No DB, no network, no Atlas key. axios is stubbed via require.cache.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT       = path.resolve(__dirname, '..');
const ATLAS_SRC  = path.join(ROOT, 'src/services/atlasVideoService.js');
const ALERTS_SRC = path.join(ROOT, 'src/services/renderer.js');

const atlasSrc  = fs.readFileSync(ATLAS_SRC, 'utf8');
const alertsSrc = fs.readFileSync(ALERTS_SRC, 'utf8');   // renderer.js: adgen's shutdown host

let failures = 0;
let passes   = 0;

// AWAITS the callback. An earlier draft of this file did not, which made every
// async assertion pass vacuously (a pending Promise is truthy) — the exact
// "the test oracle shares the bug" failure this suite exists to prevent.
async function check(name, fn) {
  try {
    const r = typeof fn === 'function' ? await fn() : fn;
    if (r === false) throw new Error('returned false');
    console.log(`  ✅ ${name}`);
    passes++;
  } catch (err) {
    console.error(`  ❌ ${name}\n       ${err.message}`);
    failures++;
  }
}

// ── BOUNDED NON-POLL WORK INSIDE THE HOLD ──────────────────────────────────
//
// Every term is a real timeout constant in the code path between a winning
// tryClaimReframe and persistReframe. Each is cited so the next person can
// re-derive it instead of trusting this comment.
//
//   20.0s  source GET                normalizeReframeSource, `timeout: 20000`
//   60.0s  mirror upload             uploadBufferToCloudinary, SDK 60000 default
//   60.0s  submit POST               submitImageGeneration, `timeout: 60000`
//   50.0s  pollPrediction overshoot  ONE in-flight axios GET (30s) + the single
//                                    post-loop peek (20s). This term WAS 188s
//                                    (18s trailing interval+jitter + 30s GET +
//                                    120s max rate-limit backoff + 20s peek);
//                                    the deadline clamp proved in group C is
//                                    what reduces it to 50s. Do NOT re-add the
//                                    18s and 120s: they are no longer reachable.
//   94.5s  fetchOutpaintOutput       3 attempts x 30000 + sleeps (1500 + 3000)
//   60.0s  outpaint upload           uploadBufferToCloudinary, SDK 60000
//   60.0s  mirror delete             deleteFromCloudinary, SDK 60000
//   60.0s  pad-fallback upload       uploadBufferToCloudinary, SDK 60000
//
// EXCLUDED, with reason:
//   - the split-density brand_panel upload and its vision chain: unreachable.
//     reframeReferenceForAspect has exactly one call site (inside
//     buildReferenceImages) and it does NOT pass subjectSide, so splitSide is
//     always null. Verified in this repo, not inherited.
//   - fitBufferForCloudinary's sharp ladder: CLOUDINARY_MAX_UPLOAD_BYTES
//     defaults to 40 MiB and real 4k reframe outputs measure 6.5-8.5 MB, so it
//     returns the buffer early and does no sharp work. Latent, not exercised.
const BOUNDED_NON_POLL_MS =
  20000 +   // source GET
  60000 +   // mirror upload
  60000 +   // submit POST
  50000 +   // pollPrediction overshoot, post-clamp (in-flight GET + peek)
  94500 +   // fetchOutpaintOutput
  60000 +   // outpaint upload
  60000 +   // mirror delete
  60000;    // pad-fallback upload

// ── Dependency bootstrap ───────────────────────────────────────────────────
//
// An adgen worktree has NO node_modules (this repo's CLAUDE.md is emphatic that
// you must never `npm ci` one or set NODE_PATH for a suite run — doing so makes
// verifyModelParity's mongoose fallback never install and turns 33/33 green
// into 33/33 red with a message that reads exactly like a real schema defect).
//
// That ban is about the SUITE's environment. runVerifySuite spawns every
// harness as its own child process, so a resolution path set HERE cannot reach
// verifyModelParity — it dies with this process. Groups B and C need the real
// module (a source-text check cannot prove a deadline is respected), so this
// resolves deps from the main checkout for THIS PROCESS ONLY, and skips those
// groups loudly rather than silently if it cannot.
let DEPS_OK = true;
let DEPS_NOTE = '';
function bootstrapDeps() {
  try { require.resolve('axios'); return; } catch { /* fall through */ }
  const Module = require('module');
  const candidates = [
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, '..', 'liquidretail_adgen', 'node_modules'),
    path.join(ROOT, '..', 'liquidretail_backend', 'node_modules')
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(path.join(dir, 'axios'))) continue;
    process.env.NODE_PATH = process.env.NODE_PATH ? `${dir}:${process.env.NODE_PATH}` : dir;
    Module._initPaths();
    try { require.resolve('axios'); DEPS_NOTE = dir; return; } catch { /* keep looking */ }
  }
  DEPS_OK = false;
}
bootstrapDeps();

// ── axios stub, installed BEFORE the service is required ───────────────────
const axiosPath = DEPS_OK ? require.resolve('axios') : null;
const rateLimitError = () => {
  const e = new Error('rate limited');
  e.response = { status: 429, data: { error: 'rate limited' } };
  e.isAxiosError = true;
  return e;
};
let axiosGetCalls = 0;
if (DEPS_OK) require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true, exports: {
    get:  async () => { axiosGetCalls++; throw rateLimitError(); },
    post: async () => { throw rateLimitError(); },
    create() { return this; },
    defaults: { headers: { common: {} } }
  }
};

process.env.ATLAS_POLL_INTERVAL_MS = '15000';  // production value
delete process.env.REFRAME_POLL_MS;
delete process.env.REFRAME_CLAIM_TTL_MS;
delete process.env.ATLAS_TIMEOUT_MS;

const svc = DEPS_OK ? require(ATLAS_SRC) : null;
if (!DEPS_OK) {
  console.log('  ℹ️  no resolvable node_modules — groups B and C are SKIPPED (structural groups still run)');
} else if (DEPS_NOTE) {
  console.log(`  ℹ️  module resolution bootstrapped from ${DEPS_NOTE} (this process only)`);
}

async function main() {
  // ── GROUP A ──────────────────────────────────────────────────────────────
  console.log('\nA. the poll budget and the lease floor are independent');

  await check('A1 the reframe poll call site passes an EXPLICIT maxPollMs', () =>
    /const pollOut = await pollPrediction\(id,\s*\{\s*maxPollMs:\s*REFRAME_POLL_MS\(\)\s*\}\)/.test(atlasSrc));

  await check('A2 no bare `pollPrediction(id)` remains on the reframe path', () =>
    !/await pollPrediction\(id\)\s*;/.test(atlasSrc));

  await check('A3 REFRAME_CLAIM_TTL_MS floor is NOT derived from MAX_POLL_MS', () => {
    const body = atlasSrc.match(/const REFRAME_CLAIM_TTL_MS = \(\) => \{[\s\S]*?\n\};/);
    assert(body, 'could not locate REFRAME_CLAIM_TTL_MS');
    assert(!/MAX_POLL_MS/.test(body[0]),
      'the lease floor still references MAX_POLL_MS — that arithmetic link IS the defect');
    return true;
  });

  await check('A4 the floor is an independent named constant', () =>
    /const REFRAME_CLAIM_TTL_FLOOR_MS = 20 \* 60 \* 1000;/.test(atlasSrc));

  await check('A5 the floor is NOT derived from REFRAME_POLL_MS either', () => {
    // Re-deriving from the new budget would reproduce the same bug smaller:
    // 300s + 10 min = 15 min, WORSE than the 20 min this repo already had.
    const decl = atlasSrc.match(/const REFRAME_CLAIM_TTL_FLOOR_MS = .*;/);
    assert(decl, 'floor constant missing');
    assert(!/REFRAME_POLL_MS/.test(decl[0]), 'floor is derived from the poll budget');
    return true;
  });

  // ── GROUP B ──────────────────────────────────────────────────────────────
  console.log('\nB. hold < lease, swept across reachable configurations');
  if (!DEPS_OK) { console.log('  ⏭  SKIPPED — no resolvable node_modules'); }

  if (DEPS_OK) await check('B0 the module exports the constants this harness reasons about', () =>
    typeof svc.REFRAME_POLL_MS === 'function' &&
    typeof svc.REFRAME_CLAIM_TTL_MS === 'function' &&
    typeof svc.pollPrediction === 'function' &&
    typeof svc.releaseAllActiveReframeClaims === 'function');

  if (DEPS_OK) await check(`B1 default config: poll + ${BOUNDED_NON_POLL_MS / 1000}s bounded work < lease`, () => {
    const hold = svc.REFRAME_POLL_MS() + BOUNDED_NON_POLL_MS;
    const lease = svc.REFRAME_CLAIM_TTL_MS();
    assert(hold < lease,
      `hold ${hold}ms >= lease ${lease}ms — a peer can steal a live claim and both bill`);
    console.log(`       hold=${(hold / 1000).toFixed(1)}s lease=${(lease / 1000).toFixed(1)}s ` +
                `margin=${((lease - hold) / 1000).toFixed(1)}s`);
    return true;
  });

  if (DEPS_OK) await check('B2 the margin is real, not marginal (>= 60s)', () => {
    const margin = svc.REFRAME_CLAIM_TTL_MS() - (svc.REFRAME_POLL_MS() + BOUNDED_NON_POLL_MS);
    assert(margin >= 60000,
      `margin is only ${(margin / 1000).toFixed(1)}s — the unbounded sharp/Mongo terms ` +
      `have no room. This is the failure mode the old "+10 min" had (-2.5s).`);
    return true;
  });

  if (DEPS_OK) await check('B3 SWEEP: the inequality survives every reachable REFRAME_POLL_MS', () => {
    // Sweep rather than sample: the clamp is what must hold the line, so probe
    // absurd values on both sides of it, not just near the default.
    const probes = ['1', '1000', '60000', '300000', '600000', '900000', '99999999', 'abc', '', '-5'];
    const violations = [];
    for (const v of probes) {
      process.env.REFRAME_POLL_MS = v;
      const hold  = svc.REFRAME_POLL_MS() + BOUNDED_NON_POLL_MS;
      const lease = svc.REFRAME_CLAIM_TTL_MS();
      if (hold >= lease) violations.push(`REFRAME_POLL_MS=${v} → hold ${hold} >= lease ${lease}`);
    }
    delete process.env.REFRAME_POLL_MS;
    assert(violations.length === 0, `\n       ${violations.join('\n       ')}`);
    return true;
  });

  if (DEPS_OK) await check('B4 the poll budget is clamped, and the UPPER clamp comes from the lease', () => {
    process.env.REFRAME_POLL_MS = '1';
    assert.strictEqual(svc.REFRAME_POLL_MS(), 60000,
      'no lower clamp — a typo could make every reframe a paid crop');
    process.env.REFRAME_POLL_MS = '99999999';
    const capped = svc.REFRAME_POLL_MS();
    // The upper clamp must be the LEASE-derived ceiling, not MAX_POLL_MS.
    // Clamping to MAX_POLL_MS alone lets an operator configure a hold that
    // exceeds the lease (found by B3's sweep, not by reading the code).
    assert(capped + BOUNDED_NON_POLL_MS < svc.REFRAME_CLAIM_TTL_MS(),
      `the maximum configurable poll budget (${capped}ms) still allows a hold that ` +
      `reaches the lease — the upper clamp is not derived from the lease`);
    delete process.env.REFRAME_POLL_MS;
    return true;
  });

  if (DEPS_OK) await check('B5 the lease floor cannot be configured BELOW 20 min', () => {
    process.env.REFRAME_CLAIM_TTL_MS = '1000';
    assert.strictEqual(svc.REFRAME_CLAIM_TTL_MS(), 20 * 60 * 1000,
      'a small REFRAME_CLAIM_TTL_MS defeated the floor');
    delete process.env.REFRAME_CLAIM_TTL_MS;
    return true;
  });

  if (DEPS_OK) await check('B6 raising ATLAS_TIMEOUT_MS no longer moves the lease floor (CHILD PROCESSES)', () => {
    // THE CROSS-REPO DRIFT DEFECT, EXPRESSED AS A TEST: the whole point of
    // decoupling is that the video knob cannot move the money guard.
    //
    // This MUST fork. MAX_POLL_MS is resolved ONCE at module load
    // (`const MAX_POLL_MS = parseInt(process.env.ATLAS_TIMEOUT_MS, 10) || 600000`),
    // so mutating process.env in-process and re-calling REFRAME_CLAIM_TTL_MS()
    // cannot observe the coupling at all — an earlier draft of this check did
    // exactly that and PASSED with the defect deliberately reinstated. It
    // proved nothing. Two child processes with different ATLAS_TIMEOUT_MS is
    // the only sound shape.
    const { execFileSync } = require('child_process');
    // A SENTINEL, not a bare number: requiring this service prints a
    // templateRegistry banner to stdout, so Number(<whole stdout>) is NaN. An
    // earlier draft did exactly that and failed with "child did not report a
    // TTL (NaN)" — which at least failed loudly rather than passing vacuously,
    // but it still measured nothing.
    const read = (timeoutMs) => {
      const out = execFileSync(
        process.execPath,
        ['-e', `process.stdout.write('TTL<'+require(${JSON.stringify(ATLAS_SRC)}).REFRAME_CLAIM_TTL_MS()+'>')`],
        {
          encoding: 'utf8',
          env: { ...process.env, ATLAS_TIMEOUT_MS: String(timeoutMs) },
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 60000
        }
      );
      const m = out.match(/TTL<(\d+)>/);
      assert(m, `child produced no TTL sentinel (stdout tail: ${out.slice(-160)})`);
      return Number(m[1]);
    };
    const at10min = read(600000);
    const at30min = read(1800000);
    assert(Number.isFinite(at10min) && at10min > 0, `child did not report a TTL (${at10min})`);
    assert.strictEqual(at30min, at10min,
      `the video timeout still moves the reframe lease: ATLAS_TIMEOUT_MS=600000 → ` +
      `${at10min}ms but 1800000 → ${at30min}ms. That divergence between two repos ` +
      `holding one shared claim is the double-charge window.`);
    assert.strictEqual(at10min, 20 * 60 * 1000,
      `expected the independent 20 min floor, got ${at10min}ms`);
    return true;
  });

  // ── GROUP C: BEHAVIOURAL ─────────────────────────────────────────────────
  console.log('\nC. pollPrediction respects its deadline — proven by running it');
  if (!DEPS_OK) { console.log('  ⏭  SKIPPED — no resolvable node_modules'); }

  if (DEPS_OK) await check('C1 a rate-limited poll returns within its budget, not budget + backoff', async () => {
    // Pre-fix behaviour on this input: sleep POLL_INTERVAL+jitter (15-18s, past
    // the 2s budget already), issue the GET, then serve the FULL 30s first-tier
    // rate-limit backoff before re-testing the loop condition — ~45-48s for a
    // 2s budget. Post-fix: both sleeps are clamped to the remaining budget, so
    // this returns in ~2s.
    const budget = 2000;
    const before = axiosGetCalls;
    const started = Date.now();
    let threw = false;
    try {
      await svc.pollPrediction('verify-hold-bounded-fake-id', { maxPollMs: budget });
    } catch {
      threw = true;   // expected: unsettled at the deadline
    }
    const elapsed = Date.now() - started;
    console.log(`       elapsed=${elapsed}ms budget=${budget}ms threw=${threw} ` +
                `axiosGets=${axiosGetCalls - before}`);
    // PROVE THE BRANCH WAS REACHED. Without this, a pollPrediction that
    // returned instantly for an unrelated reason would satisfy the timing
    // assertion while exercising none of the clamped code.
    assert(axiosGetCalls > before,
      'the stubbed axios was never called — the loop body did not execute, so this ' +
      'test proved nothing about the clamp');
    assert(elapsed < budget + 8000,
      `pollPrediction took ${elapsed}ms on a ${budget}ms budget — the deadline is not ` +
      `being respected (pre-fix this was ~45000ms)`);
    return true;
  });

  // ── GROUP D ──────────────────────────────────────────────────────────────
  console.log('\nD. graceful-shutdown claim eviction (already present here; pinned so it stays)');

  // NOTE: adgen is the repo this mechanism came FROM — liquidretail_backend had
  // neither the registry nor the sweep until the sibling PR ported them. These
  // checks are a regression fence, not new work, and deliberately overlap
  // scripts/verifyReframeClaimShutdown.js (which covers the shutdown ordering
  // and the release semantics in much more depth). The overlap is cheap and the
  // duplication is the point: the cross-repo invariant should be assertable
  // from one file in either repo.

  await check('D1 an in-process active-claims registry exists', () =>
    /const _activeReframeClaims = new Set\(\);/.test(atlasSrc));

  await check('D2 a winning tryClaimReframe registers the claim', () =>
    /_activeReframeClaims\.add\(JSON\.stringify\(\{ m: String\(mediaId\), a: aspectKey, b: claimBy \}\)\)/.test(atlasSrc));

  await check('D3 releaseReframeClaim deregisters', () =>
    /_activeReframeClaims\.delete\(JSON\.stringify\(\{ m: String\(mediaId\), a: aspectKey, b: claimBy \}\)\)/.test(atlasSrc));

  await check('D4 releaseAllActiveReframeClaims iterates the registry and releases', () =>
    /async function releaseAllActiveReframeClaims\(\)\s*\{[\s\S]{0,800}?_activeReframeClaims[\s\S]{0,400}?releaseReframeClaim\(/.test(atlasSrc));

  await check('D5 the sweep drains the registry in a finally (one bad claim cannot wedge it)', () =>
    /async function releaseAllActiveReframeClaims[\s\S]{0,1400}?try\s*\{[\s\S]{0,400}?releaseReframeClaim\([\s\S]{0,80}?\)[\s\S]{0,400}?\}\s*catch[\s\S]{0,200}?\}\s*finally\s*\{[\s\S]{0,300}?_activeReframeClaims\.delete/.test(atlasSrc));

  await check('D6 renderer.shutdown() awaits the sweep', () =>
    /async function shutdown\(\)[\s\S]{0,12000}?await\s+atlasVideo\.releaseAllActiveReframeClaims\(\)/.test(alertsSrc));

  await check('D7 the shutdown call cannot throw out of shutdown()', () =>
    /try\s*\{[\s\S]{0,400}?releaseAllActiveReframeClaims\(\)[\s\S]{0,400}?\}\s*catch[\s\S]{0,300}?reframe-claim release-on-shutdown failed/.test(alertsSrc));

  if (DEPS_OK) await check('D9 the registry no-ops cleanly when empty (BEHAVIOURAL)', async () => {
    const cleared = await svc.releaseAllActiveReframeClaims();
    assert.strictEqual(cleared, 0, `expected 0 cleared on an empty registry, got ${cleared}`);
    return true;
  });

  // ── GROUP E ──────────────────────────────────────────────────────────────
  console.log('\nE. the hold is measurable without a log join');

  await check('E1 persistReframe accepts claimedAt', () =>
    /async function persistReframe\(media, aspectKey, aspectRatio, finalUrl, method, \{ claimedAt = null \} = \{\}\)/.test(atlasSrc));

  await check('E2 the persisted entry records claimedAt + heldMs when a claim was held', () =>
    /\.\.\.\(claimedAt \? \{ claimedAt, heldMs \} : \{\}\)/.test(atlasSrc));

  await check('E3 heldMs is NOT written under `claim`, so supersede semantics are unchanged', () => {
    // The full $set dropping `.claim` is what releases the lease. If the hold
    // record were written at entry.claim.*, tryClaimReframe would read it as a
    // LIVE claim and the aspect would never be claimable again.
    const body = atlasSrc.match(/const entry = \{[\s\S]*?\n  \};/);
    assert(body, 'could not locate the persisted entry literal');
    assert(!/claim\s*:/.test(body[0]),
      'the persisted entry carries a `claim` key — that would soft-lock the aspect forever');
    return true;
  });

  await check('E4 both BILLED persist sites thread claimedAt', () => {
    const billed = atlasSrc.match(/if \(billed\) await persistReframe\([^)]*\)/);
    assert(billed && /claimedAt/.test(billed[0]), 'the outpaint persist site does not pass claimedAt');
    const settle = atlasSrc.match(/staleUrl \? 'stale-kept-after-bill' : 'crop-after-bill',\s*\{ claimedAt \}/);
    assert(settle, 'the crop-after-bill persist site does not pass claimedAt');
    return true;
  });

  await check('E5 the winning claim emits an acquire log line', () =>
    /claim acquired \(media=/.test(atlasSrc));

  await check('E6 persist emits the closing hold line', () =>
    /claim superseded by persist after/.test(atlasSrc));

  console.log(`\nverifyReframeHoldBounded: ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verifyReframeHoldBounded: harness crashed — ${err.stack || err.message}`);
  process.exit(1);
});
