#!/usr/bin/env node
'use strict';
//
// runVerifySuite.js — parallel aggregate runner for scripts/verify*.{js,mjs}.
// Ported/adapted from liquidretail_backend/scripts/runVerifySuite.js (same
// file name, same job, same pass/fail definition), trimmed to what this
// repo's foundation actually needs: this repo has 3 harnesses today, not
// 184, so the backend's --affected static dependency-graph resolution
// (~350 lines solving "which of 184 scripts does this diff touch") is not
// ported — it is real complexity earning its keep at that scale, not this
// one. If this repo's verify* count grows enough that a full re-run stops
// being cheap, port that logic then; do not pre-build it against a guess.
//
// WHY THIS EXISTS, STATED ONCE SO IT NEVER GOES STALE: the backend's own
// CLAUDE.md records THREE separate stale hardcoded suite counts in its own
// docs (143→174, "101" still wrong in one header, "138" in another) — every
// one of them a number someone wrote down and then a later PR made false.
// This runner NEVER prints a count it did not just compute by calling
// fs.readdirSync() on scripts/ in this same run. Do not add a comment
// anywhere in this repo asserting "N verify scripts exist" — ask this
// runner (`node scripts/runVerifySuite.js --list | wc -l`) instead, every
// time, because the true answer changes the next time someone adds one.
//
// USAGE
//   node scripts/runVerifySuite.js                  run every scripts/verify*.{js,mjs}
//   node scripts/runVerifySuite.js --concurrency=4  override the worker pool size
//   node scripts/runVerifySuite.js --timeout=60000  override the per-script timeout (ms)
//   node scripts/runVerifySuite.js --list           print the selected scripts, don't run them
//   node scripts/runVerifySuite.js verifyFoo.js      run only the script(s) named
//
// Exit code 0 iff every selected script exited 0.
//
// PARALLEL-SAFETY: both harnesses in this repo today are read-only over
// files already on disk (verifyRequireGraph.js: fs + regex only, no writes
// anywhere; verifyModelParity.js: requires model files and constructs
// mongoose.Schema objects, which never touches a DB or the filesystem
// beyond reading). Neither mutates a shared file or holds a real timer with
// a tight margin, so there is no UNSAFE_FOR_PARALLEL set here — unlike the
// backend's runner, which quarantines two scripts for exactly those two
// reasons. If a future verify*.js here needs to mutate a real file or rely
// on real-timer margins, add that quarantine set back (copy the backend's
// reasoning, don't invent a new one) rather than assuming this comment is
// still true.
//
// macOS has no `timeout(1)` binary, so this is a JS timer + child.kill(),
// never a shelled-out `timeout` wrapper (same reasoning as the backend's
// runner).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const VERIFY_RE = /^verify.*\.(js|mjs)$/;

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, os.cpus().length));

// Grace period between SIGTERM and a forced SIGKILL when a timed-out script
// doesn't exit on its own.
const KILL_GRACE_MS = 5000;

function parseArgs(argv) {
  const opts = { concurrency: null, timeoutMs: null, list: false, only: [] };
  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.slice('--concurrency='.length), 10);
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = parseInt(arg.slice('--timeout='.length), 10);
    else if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else if (arg.startsWith('--')) { console.error(`runVerifySuite: unknown flag ${arg}`); process.exit(1); }
    else opts.only.push(path.basename(arg));
  }
  return opts;
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 34).join('\n');
  console.log(header);
}

function discoverScripts() {
  return fs.readdirSync(SCRIPTS_DIR).filter((f) => VERIFY_RE.test(f)).sort();
}

// Never point NODE_PATH at the parent monorepo's node_modules (mongoose 7
// would shadow adgen's mongoose 8). If this package has its own
// node_modules, pin there; otherwise leave unset so Node's walk-up from
// adgen/src hits adgen/node_modules first after `npm ci` inside adgen/.
function childEnv() {
  const env = Object.assign({}, process.env);
  const parentNm = path.resolve(ROOT, '..', 'node_modules');
  const ownNm = path.join(ROOT, 'node_modules');
  if (env.NODE_PATH) {
    const parts = String(env.NODE_PATH)
      .split(path.delimiter)
      .filter((p) => p && path.resolve(p) !== parentNm);
    if (parts.length) env.NODE_PATH = parts.join(path.delimiter);
    else delete env.NODE_PATH;
  }
  if (!env.NODE_PATH && fs.existsSync(ownNm)) env.NODE_PATH = ownNm;
  return env;
}

function runOne(script, timeoutMs, env) {
  return new Promise((resolve) => {
    const file = path.join(SCRIPTS_DIR, script);
    const start = Date.now();
    const child = spawn(process.execPath, [file], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* already exited */ }
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ script, code: timedOut ? 1 : code, timedOut, ms: Date.now() - start, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ script, code: 1, timedOut: false, ms: Date.now() - start, stdout, stderr: String((err && err.stack) || err) });
    });
  });
}

async function runPool(scripts, concurrency, timeoutMs, env) {
  const results = new Array(scripts.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= scripts.length) return;
      results[my] = await runOne(scripts[my], timeoutMs, env);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, scripts.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;

  const allScripts = discoverScripts();
  const scripts = opts.only.length ? [...new Set(opts.only)] : allScripts;

  const allSet = new Set(allScripts);
  const unknown = scripts.filter((s) => !allSet.has(s));
  if (unknown.length) {
    console.error(`runVerifySuite: unknown script(s), not found in scripts/: ${unknown.join(', ')}`);
    process.exit(1);
  }

  if (opts.list) {
    console.log(scripts.length ? scripts.join('\n') : '(nothing selected)');
    return;
  }

  if (scripts.length === 0) {
    console.log('runVerifySuite: no verify*.{js,mjs} scripts found in scripts/. Nothing to run.');
    return;
  }

  const env = childEnv();
  console.log(
    `runVerifySuite: ${scripts.length} script(s) discovered in scripts/ — running in a pool of ${concurrency}, ${timeoutMs}ms/script timeout.\n`
  );

  const t0 = Date.now();
  const results = await runPool(scripts, concurrency, timeoutMs, env);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  for (const r of results) {
    const mark = r.code === 0 ? '✅' : '❌';
    console.log(`${mark} ${r.script}  (${r.ms}ms)${r.timedOut ? '  [TIMED OUT]' : ''}`);
  }

  const expected = loadExpectedFailures();

  const allFailed = results.filter((r) => r.code !== 0);
  const failed = allFailed.filter((r) => !expected[r.script]);          // real
  const expectedFailed = allFailed.filter((r) => expected[r.script]);   // known, tolerated
  // A listed script that PASSED. This is what stops the allowlist rotting into a
  // rug: you cannot fix a harness and leave it suppressed, and you cannot park a
  // flaky script here and forget it. Removing the entry is part of the fix.
  const stale = results.filter((r) => r.code === 0 && expected[r.script]);
  const passed = results.length - allFailed.length;

  if (failed.length) {
    console.log(`\n--- FAILURE DETAIL (${failed.length} of ${results.length}) ---`);
    for (const r of failed) {
      console.log(`\n===== ${r.script} (exit ${r.code}${r.timedOut ? ', timed out' : ''}) =====`);
      if (r.stdout.trim()) console.log(r.stdout.trim());
      if (r.stderr.trim()) console.error(r.stderr.trim());
    }
  }

  if (expectedFailed.length) {
    console.log(`\n--- EXPECTED FAILURES (${expectedFailed.length}), from scripts/expected-failures.json ---`);
    for (const r of expectedFailed) {
      console.log(`  ~ ${r.script} — ${expected[r.script].reason}`);
      console.log(`      remove when: ${expected[r.script].removeWhen}`);
    }
  }

  console.log(`\nrunVerifySuite: ${passed}/${results.length} passed in ${elapsedSec}s wall clock (concurrency=${concurrency}).`);
  if (expectedFailed.length) {
    console.log(`EXPECTED-FAIL (not failing the run): ${expectedFailed.map((r) => r.script).join(', ')}`);
  }

  if (stale.length) {
    console.log(`\n❌ STALE EXPECTED-FAILURE ENTR${stale.length === 1 ? 'Y' : 'IES'}: ` +
      `${stale.map((r) => r.script).join(', ')}`);
    console.log('   These are listed in scripts/expected-failures.json but PASSED. Whatever they');
    console.log('   were waiting on is fixed — delete the entry. An allowlist that outlives its');
    console.log('   reason silently suppresses a live harness.');
    process.exitCode = 1;
  }

  if (failed.length) {
    console.log(`FAILED: ${failed.map((r) => r.script).join(', ')}`);
    process.exitCode = 1;
  }
}

// Scripts known to fail on master. See scripts/expected-failures.json for the
// contract — in particular that a listed script which PASSES fails the run.
// A malformed or missing file is a hard error, never a silent empty allowlist:
// "everything is expected to fail" and "nothing is" must not be reachable by typo.
function loadExpectedFailures() {
  const p = path.join(SCRIPTS_DIR, 'expected-failures.json');
  if (!fs.existsSync(p)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`runVerifySuite: scripts/expected-failures.json is not valid JSON — ${err.message}`);
    process.exit(1);
  }
  const map = parsed && parsed.expectedFailures;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    console.error('runVerifySuite: scripts/expected-failures.json must contain an "expectedFailures" object');
    process.exit(1);
  }
  for (const [script, meta] of Object.entries(map)) {
    if (!meta || !meta.reason || !meta.removeWhen) {
      console.error(`runVerifySuite: expected-failures entry "${script}" needs both "reason" and "removeWhen"`);
      process.exit(1);
    }
  }
  return map;
}

main().catch((err) => {
  console.error('runVerifySuite: internal error:', err);
  process.exit(1);
});
