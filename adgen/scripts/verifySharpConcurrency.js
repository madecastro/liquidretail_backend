'use strict';
// Pins the Sharp / libuv threadpool tuning added 2026-08-26.
// Phase 3 of the wall-time reduction plan: attacks the mixed-workload
// event-loop contention that turned static p50 from 2m26s (static-only)
// into 4m10s (mixed with 21 video masters) on run_1787756136010.
//
// TWO KNOBS, ONE THIS HARNESS OWNS:
//   1. UV_THREADPOOL_SIZE — env var, must be set BEFORE process boot.
//      Set in config/defaults.env=16. Node.js reads this at startup;
//      configureSharpConcurrency cannot change it after boot.
//   2. SHARP_CONCURRENCY — sharp's OWN semaphore, applied via
//      sharp.concurrency() at renderer.run() init through
//      services/sharpConcurrency.configureSharpConcurrency.
//
// This harness pins the SECOND knob's behaviour + the wiring into
// renderer.run(). The env-var knob is enforced by the presence of
// config/defaults.env (checked below).

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

// stageTiming-adjacent env-var pattern — placeholders so requires that hit
// ../config don't process.exit(1) inside a bare CI checkout.
process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'renderer';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adgen_verify_placeholder';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'verify-placeholder';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'verify-placeholder';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'verify-placeholder';
process.env.ATLAS_API_KEY = process.env.ATLAS_API_KEY || 'verify-placeholder';

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A. sharpConcurrency module ─────────────────────────────────────────
const sc = require(path.join(REPO, 'src', 'services', 'sharpConcurrency.js'));
check('A1: exports configureSharpConcurrency', typeof sc.configureSharpConcurrency === 'function');

// A2: unset env → no-op with reason
delete process.env.SHARP_CONCURRENCY;
const r1 = sc.configureSharpConcurrency();
check('A2: unset SHARP_CONCURRENCY → applied:false (Sharp autodetect preserved)',
  r1.applied === false && /unset/.test(r1.reason));

// A3: empty env → same as unset
process.env.SHARP_CONCURRENCY = '';
const r2 = sc.configureSharpConcurrency();
check('A3: empty SHARP_CONCURRENCY → applied:false', r2.applied === false);

// A4: valid number → applied
process.env.SHARP_CONCURRENCY = '8';
const r3 = sc.configureSharpConcurrency();
check('A4: SHARP_CONCURRENCY=8 → applied:true value:8',
  r3.applied === true && r3.value === 8);

// A5: garbage → refused, no-op
process.env.SHARP_CONCURRENCY = 'abc';
const r4 = sc.configureSharpConcurrency();
check('A5: garbage → applied:false with reason',
  r4.applied === false && /invalid/i.test(r4.reason));

// A6: too-high value → clamped
process.env.SHARP_CONCURRENCY = '999';
const r5 = sc.configureSharpConcurrency();
check('A6: SHARP_CONCURRENCY=999 → clamped to 64 (sanity ceiling)',
  r5.applied === true && r5.value === 64);

// A7: negative / zero → refused
process.env.SHARP_CONCURRENCY = '0';
const r6 = sc.configureSharpConcurrency();
check('A7: SHARP_CONCURRENCY=0 → refused',
  r6.applied === false);

process.env.SHARP_CONCURRENCY = '-5';
const r7 = sc.configureSharpConcurrency();
check('A8: negative value refused',
  r7.applied === false);

// Cleanup for other tests
delete process.env.SHARP_CONCURRENCY;

// ── B. Env file has UV_THREADPOOL_SIZE ─────────────────────────────────
const envSrc = fs.readFileSync(path.join(REPO, 'config', 'defaults.env'), 'utf8');
check('B1: config/defaults.env defines UV_THREADPOOL_SIZE',
  /^UV_THREADPOOL_SIZE=\d+/m.test(envSrc));
check('B2: UV_THREADPOOL_SIZE >= 8 (widening past the default 4)',
  (() => {
    const m = envSrc.match(/^UV_THREADPOOL_SIZE=(\d+)/m);
    return m && Number(m[1]) >= 8;
  })());
check('B3: config/defaults.env declares SHARP_CONCURRENCY (empty default preserves Sharp autodetect)',
  /^SHARP_CONCURRENCY=/m.test(envSrc));

// ── C. Wiring: renderer.run() calls configureSharpConcurrency ─────────
const rendererSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'renderer.js'), 'utf8');
const runMatch = rendererSrc.match(/async function run\(\)\s*\{[\s\S]*?\n\}/);
check('C1: renderer.run() body found', !!runMatch);
if (runMatch) {
  const body = runMatch[0];
  check('C2: renderer.run() calls configureSharpConcurrency at boot',
    /configureSharpConcurrency\(\)/.test(body));
  check('C3: renderer.run() lazy-requires ./sharpConcurrency (kept out of top-level graph)',
    /require\(['"]\.\/sharpConcurrency['"]\)/.test(body));
  check('C4: renderer.run() catches setup errors (setup must never fail render)',
    /catch\s*\(err\)[\s\S]*?sharp concurrency/.test(body));
}

// ── D. Module discipline ──────────────────────────────────────────────
const scSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'sharpConcurrency.js'), 'utf8');
check('D1: sharpConcurrency does NOT call sharp.concurrency at REQUIRE TIME (only inside the exported function)',
  !/^sharp\.concurrency\(/m.test(scSrc));
check('D2: sharp.concurrency call happens INSIDE configureSharpConcurrency',
  /function configureSharpConcurrency[\s\S]*?sharp\.concurrency\(/.test(scSrc));

// ── E. Revert-proofs ──────────────────────────────────────────────────
// If someone removes the wiring, C2 must fail.
const stripped = rendererSrc.replace(/configureSharpConcurrency\(\)/, '/* stripped */');
check('E1: [REVERT-PROOF] removing configureSharpConcurrency() call defeats C2',
  !/configureSharpConcurrency\(\)/.test(stripped));

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifySharpConcurrency: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifySharpConcurrency: ${passes.length}/${passes.length} checks passed`);
