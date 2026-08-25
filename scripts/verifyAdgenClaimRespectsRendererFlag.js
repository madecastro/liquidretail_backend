#!/usr/bin/env node
'use strict';
//
// verifyAdgenClaimRespectsRendererFlag — pins the fix for the live
// production race where BOTH liquidretail_backend and liquidretail_adgen
// claimed the same { status:'rendering', claimedByWorker:null } Ad rows.
// ADGEN_RENDERER_ENABLED is supposed to be the single cutover switch, but
// only backend's side of it was ever gated (services/adgenBridge.js +
// routes/ads.js:1715-1723) — adgen's own claim functions had no internal
// check at all and relied entirely on their poll loop's caller-side check
// running first. This harness pins that BOTH renderer.js's and titler.js's
// claimOne() now consult the flag THEMSELVES, at call time, so any future or
// alternate call site inherits the same safety instead of depending on one
// caller remembering to check first.
//
// WHAT THIS PINS:
//   A. Structural — in both src/services/renderer.js and
//      src/services/titler.js, claimOne()'s body calls
//      isAdgenRendererEnabled() BEFORE its Ad.findOneAndUpdate call (never
//      after — a check that runs after the claim already happened gates
//      nothing).
//   B. Behavioral — the REAL extracted claimOne() bodies, run against an
//      offline atomic-collection stub (same technique as
//      verifyRendererAtomicClaim.js): with the flag OFF, claimOne() returns
//      null and the store is provably untouched (no findOneAndUpdate call
//      reached the collection); with the flag ON, the existing claim
//      behavior is unchanged.
//   C. Call-time, not module-load-time — the SAME constructed claimOne()
//      function is invoked twice with the flag toggled between calls (no
//      re-require, no re-construction), proving the check re-reads live
//      state rather than a value captured once at require() time.
//   D. Fail-safe direction — isAdgenRendererEnabled() itself (src/config.js)
//      treats anything other than the exact string 'true' as disabled, so a
//      missing/malformed env var reads as "stand down", never "claim". This
//      is pinned directly against config.js's source, not re-implemented.
//   E. In-flight work is unaffected — the new gates sit ONLY inside
//      claimOne() (the acquire step). releaseClaim()/shutdown() in both
//      files must NOT reference isAdgenRendererEnabled at all: a flag flip
//      must never interrupt or gate the release of an already-owned claim.
//
// SOURCE EXTRACTION, not a copy — same discipline as
// verifyRendererAtomicClaim.js: every function body this harness executes
// is sliced out of the real source text via balanced-brace parsing, so a
// future edit to the real gate changes what this harness tests. A
// hand-copied reimplementation would keep testing a shape the code no
// longer has.
//
// REVERT-PROOF (performed manually against this file while writing it,
// restored before commit): commenting out the
// `if (!isAdgenRendererEnabled()) return null;` line in either
// renderer.js's or titler.js's claimOne() makes that file's A1/B2 fail
// (structural: gate missing; behavioral: claims with the flag OFF) while
// every other check in the OTHER file's section stays green — restoring
// the line restores green everywhere.
//
// Pure + offline: no DB, no network, no API keys, no node_modules required
// (only Node builtins: fs, path, assert). Run:
//   node scripts/verifyAdgenClaimRespectsRendererFlag.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'services', 'renderer.js');
const TITLER_PATH   = path.join(__dirname, '..', 'src', 'services', 'titler.js');
const CONFIG_PATH   = path.join(__dirname, '..', 'src', 'config.js');
const RENDERER_SRC  = fs.readFileSync(RENDERER_PATH, 'utf8');
const TITLER_SRC    = fs.readFileSync(TITLER_PATH, 'utf8');
const CONFIG_SRC    = fs.readFileSync(CONFIG_PATH, 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}

// ── tiny balanced-bracket slicer (same discipline as verifyRendererAtomicClaim.js) ─
function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}
function functionBody(src, signatureRe) {
  const m = signatureRe.exec(src);
  assert.ok(m, `signature not found: ${signatureRe}`);
  const brace = src.indexOf('{', m.index + m[0].length - 1);
  const body = balanced(src, brace, '{', '}');
  assert.ok(body, `unterminated function body for ${signatureRe}`);
  return body;
}

const CLAIM_ONE_SIG = /async function claimOne\s*\(\s*\)\s*\{/;

// ═════════════════════════════════════════════════════════════════════════
// A — structural: the gate exists and runs BEFORE the claim in both files.
// ═════════════════════════════════════════════════════════════════════════
const rendererClaimBody = functionBody(RENDERER_SRC, CLAIM_ONE_SIG);
const titlerClaimBody   = functionBody(TITLER_SRC, CLAIM_ONE_SIG);

function assertGateBeforeClaim(label, body) {
  const gateIdx  = body.search(/if\s*\(\s*!\s*isAdgenRendererEnabled\s*\(\s*\)\s*\)\s*return\s+null\s*;/);
  const claimIdx = body.indexOf('Ad.findOneAndUpdate(');
  assert.ok(gateIdx >= 0, `${label}: no "if (!isAdgenRendererEnabled()) return null;" gate found in claimOne()`);
  assert.ok(claimIdx >= 0, `${label}: no Ad.findOneAndUpdate call found in claimOne()`);
  assert.ok(gateIdx < claimIdx, `${label}: the flag gate must run BEFORE the claim — found gate at ${gateIdx}, claim at ${claimIdx}`);
}

check('A1 renderer.js claimOne() gates on isAdgenRendererEnabled() before claiming', () => {
  assertGateBeforeClaim('renderer.js', rendererClaimBody);
});
check('A2 titler.js claimOne() gates on isAdgenRendererEnabled() before claiming', () => {
  assertGateBeforeClaim('titler.js', titlerClaimBody);
});
check('A3 renderer.js imports isAdgenRendererEnabled from ../config', () => {
  assert.match(RENDERER_SRC, /require\(['"]\.\.\/config['"]\)/);
  const importLine = RENDERER_SRC.split('\n').find((l) => l.includes("require('../config')"));
  assert.ok(importLine && /isAdgenRendererEnabled/.test(importLine), 'renderer.js must destructure isAdgenRendererEnabled off ../config');
});
check('A4 titler.js imports isAdgenRendererEnabled from ../config', () => {
  const importLine = TITLER_SRC.split('\n').find((l) => l.includes("require('../config')"));
  assert.ok(importLine, 'titler.js must require ../config');
  assert.ok(/isAdgenRendererEnabled/.test(importLine), 'titler.js must destructure isAdgenRendererEnabled off ../config — it previously only imported isTitlerEnabled');
});

// ═════════════════════════════════════════════════════════════════════════
// B / C — BEHAVIORAL: run the REAL extracted claimOne() bodies against an
// offline atomic collection, flag OFF then ON, same constructed function
// both times (proves call-time re-evaluation, not module-load caching).
// ═════════════════════════════════════════════════════════════════════════
function makeAtomicCollection(seedDocs) {
  const store = seedDocs.map((d) => ({ ...d }));
  let calls = 0;
  return {
    findOneAndUpdate(filter, update, opts = {}) {
      calls++;
      const candidates = store.filter((d) =>
        d.status === filter.status &&
        (filter.claimedByWorker === null ? d.claimedByWorker === null : true)
      );
      const match = candidates[0];
      if (!match) return null;
      const idx = store.indexOf(match);
      const out = { ...match };
      if (update.$set) Object.assign(out, update.$set);
      store[idx] = out;
      return opts.new ? out : match;
    },
    all() { return store.map((d) => ({ ...d })); },
    callCount() { return calls; }
  };
}

function buildClaimOne(body) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // body includes the outer braces (functionBody returns the balanced {...})
  const inner = body.slice(1, -1);
  // WORKER_ID is a module-level const in both real files (used in the
  // $set: { claimedByWorker: WORKER_ID, ... }); claimOne() itself never
  // declares it, so it must come in as a closure arg here too.
  // isTitlerEnabled is referenced by renderer.js claimOne's filter spread;
  // bind it at call time (same as the real module scope).
  // eslint-disable-next-line no-new-func
  return new AsyncFunction('Ad', 'isAdgenRendererEnabled', 'isTitlerEnabled', 'WORKER_ID', inner);
}

async function run() {
  const flagState = { on: false };
  const isAdgenRendererEnabled = () => flagState.on;

  // ── renderer.js ──────────────────────────────────────────────────────
  {
    const claimOne = buildClaimOne(rendererClaimBody);
    const Ad = makeAtomicCollection([
      { _id: 'ad1', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: new Date() }
    ]);

    flagState.on = false;
    const offResult = await claimOne(Ad, isAdgenRendererEnabled, () => false, 'test-worker-1');
    check('B1 renderer.js: flag OFF -> claimOne() returns null', () => {
      assert.strictEqual(offResult, null);
    });
    check('B2 renderer.js: flag OFF -> the collection was never touched (no findOneAndUpdate reached it)', () => {
      assert.strictEqual(Ad.callCount(), 0,
        'a gate that runs AFTER the claim would still return null on some other path but would have already mutated the store — this proves the claim itself never fired');
    });

    // Same constructed function, same closure-captured Ad/isAdgenRendererEnabled
    // reference — only the flag's underlying state changes. This is the
    // call-time proof: if the check were cached at construction/require time,
    // flipping flagState.on here would have no effect on the SAME function.
    flagState.on = true;
    const onResult = await claimOne(Ad, isAdgenRendererEnabled, () => false, 'test-worker-1');
    check('C1 renderer.js: SAME constructed function, flag flipped ON -> now claims', () => {
      assert.ok(onResult, 'expected a claim once the flag reads true — proves the gate re-reads live state, not a cached value');
    });
    check('C2 renderer.js: the claimed doc is actually stamped claimedByWorker in the store', () => {
      const stored = Ad.all()[0];
      assert.notStrictEqual(stored.claimedByWorker, null, 'expected the ON-flag claim to have set claimedByWorker');
    });
  }

  // ── titler.js ────────────────────────────────────────────────────────
  {
    flagState.on = false;
    const claimOne = buildClaimOne(titlerClaimBody);
    const Ad = makeAtomicCollection([
      { _id: 'ad1', status: 'rendering', claimedByWorker: null, veoVideoUrl: 'https://example/v.mp4', titlingNeeded: true, createdAt: new Date() }
    ]);

    const offResult = await claimOne(Ad, isAdgenRendererEnabled, () => false, 'test-worker-1');
    check('B3 titler.js: flag OFF -> claimOne() returns null', () => {
      assert.strictEqual(offResult, null);
    });
    check('B4 titler.js: flag OFF -> the collection was never touched', () => {
      assert.strictEqual(Ad.callCount(), 0);
    });

    flagState.on = true;
    const onResult = await claimOne(Ad, isAdgenRendererEnabled, () => false, 'test-worker-1');
    check('C3 titler.js: SAME constructed function, flag flipped ON -> now claims', () => {
      assert.ok(onResult, 'expected a claim once the flag reads true');
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// D — fail-safe direction, pinned against the REAL config.js source: any
// value other than the exact string 'true' (case-insensitive) reads as
// disabled. Not re-implemented — evaluated out of the real function body.
// ═════════════════════════════════════════════════════════════════════════
check('D1 isAdgenRendererEnabled() fails safe: only exact "true" (case-insensitive) enables', () => {
  const fnBody = functionBody(CONFIG_SRC, /function isAdgenRendererEnabled\s*\(\s*\)\s*\{/);
  const inner = fnBody.slice(1, -1);
  // eslint-disable-next-line no-new-func
  const buildForEnv = (val) => new Function('process', `${inner}`)({ env: { ADGEN_RENDERER_ENABLED: val } });
  const cases = [
    ['true', true], ['TRUE', true], ['True', true],
    [undefined, false], [null, false], ['', false],
    ['false', false], ['1', false], ['yes', false], ['TRUE1', false], ['  true', false]
  ];
  for (const [val, expected] of cases) {
    assert.strictEqual(buildForEnv(val), expected, `ADGEN_RENDERER_ENABLED=${JSON.stringify(val)} should read as ${expected}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// E — in-flight work is unaffected: the new gate lives ONLY in the acquire
// step. releaseClaim()/shutdown() must not reference the flag at all — a
// flag flip must never gate the release of a claim already held.
// ═════════════════════════════════════════════════════════════════════════
check('E1 renderer.js releaseClaim() does not consult isAdgenRendererEnabled', () => {
  const body = functionBody(RENDERER_SRC, /async function releaseClaim\s*\(adId,\s*reason\s*=\s*null\s*\)\s*\{/);
  assert.ok(!/isAdgenRendererEnabled/.test(body), 'releasing an already-owned claim must never be gated by the cutover flag');
});
check('E2 renderer.js shutdown() does not consult isAdgenRendererEnabled', () => {
  const body = functionBody(RENDERER_SRC, /async function shutdown\s*\(\s*\)\s*\{/);
  assert.ok(!/isAdgenRendererEnabled/.test(body), 'shutdown drain/release must complete regardless of the flag\'s current value');
});
check('E3 titler.js releaseClaim() does not consult isAdgenRendererEnabled', () => {
  const body = functionBody(TITLER_SRC, /async function releaseClaim\s*\(adId,\s*reason\s*=\s*null\s*\)\s*\{/);
  assert.ok(!/isAdgenRendererEnabled/.test(body));
});
check('E4 titler.js shutdown() does not consult isAdgenRendererEnabled', () => {
  const body = functionBody(TITLER_SRC, /async function shutdown\s*\(\s*\)\s*\{/);
  assert.ok(!/isAdgenRendererEnabled/.test(body));
});

// ── run the async behavioral section, then report ──────────────────────
run().then(() => {
  const total = checks + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyAdgenClaimRespectsRendererFlag: ${failures.length} of ${total} checks FAILED\n`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyAdgenClaimRespectsRendererFlag: ${total}/${total} checks passed`);
}).catch((err) => {
  console.log(`\n❌ verifyAdgenClaimRespectsRendererFlag: harness threw — ${err.stack || err.message}\n`);
  process.exit(1);
});

/*
 * REVERT-PROOF LEDGER — mutations that must make this harness fail:
 *   1. Remove/comment the gate line from renderer.js's claimOne()
 *        -> A1 fails (structural, gate not found); B1/B2 fail (claims
 *           even with the flag off, and the collection IS touched).
 *   2. Remove/comment the gate line from titler.js's claimOne()
 *        -> A2 fails; B3/B4 fail.
 *   3. Move the gate to AFTER Ad.findOneAndUpdate in either file
 *        -> A1/A2 fail (gateIdx > claimIdx), even though the line is
 *           textually present — this is why the check compares indices
 *           rather than merely testing for the substring's existence.
 *   4. Drop the isAdgenRendererEnabled import from titler.js
 *        -> A4 fails immediately, and B3 would throw a ReferenceError at
 *           call time (caught by the harness's own .catch, reported as a
 *           thrown failure rather than a silent false-pass).
 *   5. Change isAdgenRendererEnabled()'s parsing to accept a non-'true'
 *      value (e.g. truthy string test) -> D1 fails on the malformed cases.
 *   6. Add a flag check inside releaseClaim() or shutdown() in either file
 *        -> E1-E4 fail, catching an accidental stranding of in-flight work.
 */
