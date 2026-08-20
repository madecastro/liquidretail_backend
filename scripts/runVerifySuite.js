#!/usr/bin/env node
/**
 * runVerifySuite.js — parallel aggregate runner for scripts/verify*.{js,mjs}.
 *
 * WHY THIS EXISTS: with 6-10 concurrent Claude Code sessions on this repo,
 * every session re-ran every verify* harness ONE AT A TIME —
 *   for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done
 * (the loop CLAUDE.md's header still documents) — taking 3-5 minutes,
 * repeated dozens of times a night, and that documented loop doesn't even
 * cover the *.mjs harnesses. This runs everything concurrently across a
 * small worker pool and reports the SAME pass/fail verdict per script: a
 * script's own process exit code (0 = pass, nonzero = fail). That is exactly
 * what the old loop already checked (`node "$f" ||`), so this is a strict
 * speedup, not a new definition of "pass".
 *
 * USAGE
 *   node scripts/runVerifySuite.js                    run every scripts/verify*.{js,mjs}
 *   node scripts/runVerifySuite.js --affected          run only scripts a diff plausibly touches
 *   node scripts/runVerifySuite.js --affected=<ref>    diff against <ref> instead of origin/main
 *   node scripts/runVerifySuite.js --concurrency=4      override the worker pool size
 *   node scripts/runVerifySuite.js --timeout=60000      override the per-script timeout (ms)
 *   node scripts/runVerifySuite.js --list               print the selected scripts, don't run them
 *   node scripts/runVerifySuite.js verifyFoo.js verifyBar.mjs   run only the scripts named
 *
 * Exit code 0 iff every selected script exited 0. Composes with a pre-push
 * hook or CI the same way the old loop did.
 *
 * PARALLEL-SAFETY, audited 2026-08-19, corrected 2026-08-19 (see below): no
 * scripts/verify* script talks to a live DB or network (the handful touching
 * mongoose/axios do so only for in-memory schema use, or say explicitly in
 * their own comments that they run with no MONGODB_URI). "Every script that
 * writes a temp file does it through fs.mkdtempSync, unique per process" was
 * asserted here before and was FALSE for three scripts — they mutated a real
 * shared repo file in place instead (see the file-mutation-race note below,
 * now fixed). It is true again as stated more precisely: every script that
 * writes a temp file now writes to a private path under os.tmpdir(), unique
 * per process (either via fs.mkdtempSync or a `${name}-${pid}-${Date.now()}`
 * suffixed filename) — never to a path any other verify script or the repo's
 * own tracked source resolves to. UNSAFE_FOR_PARALLEL below is the escape
 * hatch for a future script that breaks that assumption, or for a check with
 * its own real-timer margin too tight for an oversubscribed scheduler —
 * anything listed there runs alone, serially, after the parallel pool
 * drains.
 *
 * --affected IS A DEV-SPEED HEURISTIC, NOT THE GATE. It selects a verify
 * script if (a) the script itself changed, or (b) the script's source text
 * contains a changed file's `dir/basename` path fragment (e.g. "models/Ad"
 * for models/Ad.js) — a plain substring check against require()/
 * require.resolve()/readFileSync() targets, cheap and deliberately
 * over-inclusive rather than under. A supplementary bare-basename substring
 * check (length-gated to >=4 chars, to avoid drowning the selection in noise
 * from generic short tokens) adds recall on top of that, but is never the
 * only mechanism — the dir/basename check has no length gate, because a
 * scoped fragment like "models/Ad" or "routes/ads" is specific enough that it
 * isn't noisy the way a bare "Ad" substring would be, so short filenames
 * (Ad.js, Job.js, me.js, ads.js) still get matched precisely instead of being
 * silently dropped. It cannot know about indirect effects (e.g. changing a
 * shared helper's *behavior* without changing any name it's checked against),
 * and it cannot know a changed file has zero real dependents vs. a heuristic
 * gap — for changed files under CORE_DIRS (the directories everything else
 * routinely requires) that end up matching NOTHING, computeAffected refuses
 * to report a clean "nothing selected": it fails loud and signals the caller
 * to fall back to the full suite instead. Run the full suite (no flags)
 * before pushing non-trivial changes — CLAUDE.md's own convention section
 * already says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const VERIFY_RE = /^verify.*\.(js|mjs)$/;

// Directories whose modules are routinely require()'d from all over the
// codebase (verified 2026-08-19: services/ and models/ alone account for
// 468 relative-require hits across scripts/verify*). If a changed file lives
// under one of these and the substring checks below still select nothing,
// that is treated as "the heuristic couldn't confidently resolve this" —
// never as proof the file has no dependents — and computeAffected falls back
// to the full suite rather than silently reporting a clean pass. Deliberately
// excludes scripts/ (already handled as "the script itself changed"), and
// non-code dirs (docs/, public/, bin/, session.d/) whose edits genuinely
// have no verify-script dependents.
const CORE_DIRS = new Set(['models', 'routes', 'services', 'middleware', 'config', 'utils', 'pipelines', 'remotion', 'schemas']);

// Populated 2026-08-19 by stress-testing at --concurrency=16 (25-run baseline
// batch, this machine under heavy ambient load from other concurrent
// sessions — load average ~40-70 on 10 cores). Two DISTINCT failure classes
// were found, neither previously audited:
//
// (1) REAL FILE MUTATION RACE — FIXED 2026-08-19, no longer quarantined for
//     this reason. verifyVideoCostReconcile.js, verifyVideoTimeoutReconcile.js,
//     and verifyQuoteRotation.js each used a `withTempMutation`-shaped helper
//     that `fs.writeFileSync`d a mutated copy of a REAL repo file IN PLACE
//     (services/atlasVideoService.js for the first two;
//     services/productReviewsScrapeService.js, models/CatalogProduct.js,
//     services/quoteRotationService.js, and services/layoutInputService.js
//     for the third — the latter two were not caught by the original audit),
//     ran a check, then restored the original — all synchronously, but on
//     the SHARED checked-out file, not a private tmp copy. Two different
//     scripts mutated the SAME file (services/atlasVideoService.js), and
//     models/CatalogProduct.js is required by a large fraction of the suite:
//     any OTHER concurrently running process that read or fresh-required
//     that file during the brief write-check-restore window could observe
//     the MUTATED content and fail an unrelated, unmutated assertion —
//     reproduced live: standalone `node scripts/verifyVideoTimeoutReconcile.js`
//     was 5/5 green, but it failed intermittently inside the --concurrency=16
//     pool with "source text not found" errors on lines that are never
//     actually missing.
//     Quarantining these three here was NOT a sufficient fix on its own: this
//     runner's own timeout path (below) sends SIGTERM then, after a grace
//     period, SIGKILL; no verify* script installs a SIGTERM handler, and
//     reproduced directly on Node 22/26 — with no handler, SIGTERM/SIGKILL
//     terminate the process WITHOUT running a pending `finally` block. So a
//     timeout, a CI abort, or a Ctrl-C mid-mutation (even serialized, even
//     run standalone outside this runner entirely) could still leave the
//     real file sitting mutated on disk; `UNSAFE_FOR_PARALLEL` only ever
//     serialized these three within one runVerifySuite.js invocation, never
//     protected a direct `node scripts/verifyFoo.js` or a CI job. The actual
//     fix: all three now mutate a private path under os.tmpdir()
//     (`${name}-${basename}-${pid}-${Date.now()}`, matching the pattern
//     verifyRatingPairAtomic.js/verifySeedClass.js already used) and never
//     write to the real file at all — proven by running each mutator and
//     SIGTERM'ing it mid-mutation: before the fix the real file was left
//     dirty (`git status` showed a modified services/atlasVideoService.js);
//     after, the real file stayed clean under the identical kill, with only
//     an orphaned file under the OS tmp dir (harmless, outside the repo).
// (2) REAL-TIMER RACE (the same shape as the verifyDirectorFallbackChain.js
//     C4 flake, fixed below in this same change) — verifyCampaignRunHeartbeat.js
//     (a real `setInterval(10ms)` ticker asserted to fire `>=5` times across a
//     real `sleep(120)`) and verifyConcurrencyConfig.js (two real ~80ms
//     `setTimeout` sleeps asserted to overlap within a 140ms wall-clock
//     window) both have single-digit-millisecond margins that a real OS
//     scheduler cannot guarantee under CPU oversubscription. Making these
//     deterministic the way C4 was would mean auditing and stubbing timing
//     internals of `campaignRunHeartbeatService`/`atlasVideoService` this
//     change did not otherwise need to touch — out of scope here, so they
//     stay quarantined instead of individually fixed. This is an unrelated
//     root cause from (1) above (a real-timer margin, not a shared-file
//     write) and fixing (1) does nothing for it — do not unquarantine these
//     two without separately making their timers deterministic.
//
// Both remaining entries are genuine, reproducible parallel-UNsafety, not
// module-load contention guesswork — see docs/PARALLEL_WORK.md for the full
// stress-test evidence. Listing them here is the honest fix: they run alone,
// serially, after the parallel pool drains, so their own tight real-timer
// margins never have to compete with 15 other processes for the CPU.
const UNSAFE_FOR_PARALLEL = new Set([
  'verifyCampaignRunHeartbeat.js',
  'verifyConcurrencyConfig.js',
]);

// macOS has no `timeout(1)` binary, so this is a JS timer + child.kill(),
// never a shelled-out `timeout` wrapper.
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, os.cpus().length));

function parseArgs(argv) {
  const opts = { affected: false, affectedBase: null, concurrency: null, timeoutMs: null, list: false, only: [] };
  for (const arg of argv) {
    if (arg === '--affected') opts.affected = true;
    else if (arg.startsWith('--affected=')) { opts.affected = true; opts.affectedBase = arg.slice('--affected='.length); }
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.slice('--concurrency='.length), 10);
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = parseInt(arg.slice('--timeout='.length), 10);
    else if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else if (arg.startsWith('--')) { console.error(`runVerifySuite: unknown flag ${arg}`); process.exit(1); }
    else opts.only.push(path.basename(arg));
  }
  return opts;
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 40).join('\n');
  console.log(header);
}

function discoverScripts() {
  return fs.readdirSync(SCRIPTS_DIR).filter(f => VERIFY_RE.test(f)).sort();
}

function git(args, opts) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/**
 * Returns the sorted list of affected verify scripts, or null to mean
 * "could not confidently resolve this — caller should fall back to running
 * everything" (either because the diff itself couldn't be computed, or
 * because a changed file under a CORE_DIRS directory matched no script and
 * that's treated as a heuristic gap rather than a real "unaffected" verdict).
 */
function computeAffected(base) {
  const ref = base || 'origin/main';
  let changed = [];
  try {
    changed = git(['diff', '--name-only', `${ref}...HEAD`]).split('\n');
  } catch (e) {
    try {
      changed = git(['diff', '--name-only', ref]).split('\n');
    } catch (e2) {
      console.error(`runVerifySuite: could not diff against "${ref}" (${e2.message.trim()}).`);
      return null;
    }
  }
  // Fold in uncommitted changes too (staged + unstaged) so a dirty working
  // tree is covered, not just committed history.
  try {
    changed = changed.concat(git(['diff', '--name-only', 'HEAD']).split('\n'));
    changed = changed.concat(git(['diff', '--name-only', '--cached']).split('\n'));
  } catch (e) { /* best-effort; not fatal */ }

  changed = [...new Set(changed.map(s => s.trim()).filter(Boolean))];
  if (changed.length === 0) return [];

  const allScripts = discoverScripts();
  const selected = new Set();

  // 1. A changed verify script is trivially affected.
  const remaining = [];
  for (const rel of changed) {
    const base2 = path.basename(rel);
    if (VERIFY_RE.test(base2) && allScripts.includes(base2)) selected.add(base2);
    else remaining.push(rel);
  }

  // 2. Any other changed file: a verify script is affected if its source
  //    text mentions the changed file, checked two ways:
  //
  //    a) PRECISE — the "dir/basename" path fragment (e.g. "models/Ad" for
  //       models/Ad.js, "routes/ads" for routes/ads.js). This is what a
  //       relative require()/require.resolve()/path.join() target actually
  //       looks like in source (require('../models/Ad'), require(path.join
  //       (ROOT, 'models/Ad')), require.resolve('../models/Ad')), and it's
  //       specific enough as a substring that it needs no length gate — so
  //       short filenames (Ad.js, Job.js, me.js, ads.js) are matched exactly
  //       instead of being silently excluded as "noise".
  //    b) FUZZY — the bare basename on its own, gated to >=4 chars. This is
  //       supplementary recall for mentions the precise check can't catch
  //       (comments, fixture strings, non-require references); gating it
  //       avoids drowning the selection in false positives from generic
  //       short tokens, which is safe to do here because it is never the
  //       only mechanism a real dependency relies on — (a) has already
  //       covered the exact-path case with no gate.
  if (remaining.length) {
    const sourceCache = new Map();
    const sourceOf = (script) => {
      if (!sourceCache.has(script)) {
        sourceCache.set(script, fs.readFileSync(path.join(SCRIPTS_DIR, script), 'utf8'));
      }
      return sourceCache.get(script);
    };

    const matchedAny = new Set(); // changed-file rel paths that hit >=1 script
    for (const rel of remaining) {
      const ext = path.extname(rel);
      const relNoExt = rel.slice(0, rel.length - ext.length);
      const segments = relNoExt.split('/');
      const dirBase = segments.slice(-2).join('/'); // e.g. "models/Ad"
      const baseNoExt = segments[segments.length - 1]; // e.g. "Ad"

      for (const script of allScripts) {
        if (sourceOf(script).includes(dirBase)) {
          selected.add(script);
          matchedAny.add(rel);
        }
      }

      if (baseNoExt.length >= 4) {
        for (const script of allScripts) {
          if (selected.has(script)) continue;
          if (sourceOf(script).includes(baseNoExt)) {
            selected.add(script);
            matchedAny.add(rel);
          }
        }
      }
    }

    // 3. Fail loud, not silent: a changed file under a directory everything
    //    else routinely depends on (CORE_DIRS) that still matched nothing is
    //    a signal the heuristic couldn't confidently resolve it — not proof
    //    it has zero dependents (e.g. models/Job.js today: a real, actively
    //    required model with no verify* script exercising it directly). Fall
    //    back to the full suite rather than report a clean "nothing to run".
    const unresolvedCore = remaining.filter(
      (rel) => CORE_DIRS.has(rel.split('/')[0]) && !matchedAny.has(rel)
    );
    if (unresolvedCore.length) {
      console.error(
        `runVerifySuite: --affected could not confidently resolve dependents for ` +
        `${unresolvedCore.join(', ')} (changed core-dir file(s) matched no verify ` +
        `script). Falling back to the FULL suite rather than risk a false "nothing to run".`
      );
      return null;
    }
  }

  return [...selected].sort();
}

// Grace period between SIGTERM and a forced SIGKILL when a timed-out script
// doesn't exit on its own. No verify* script installs a SIGTERM handler
// today, but scripts/retitleDriver.js in this same repo already does
// (`process.on('SIGTERM', ...)` that finishes current work before exiting) —
// a future verify* script sharing that pattern, or simply looping instead of
// finishing, would otherwise survive SIGTERM and hang the whole runner
// indefinitely: no output, no exit code, ever.
const KILL_GRACE_MS = 5000;

function runOne(script, timeoutMs) {
  return new Promise((resolve) => {
    const file = path.join(SCRIPTS_DIR, script);
    const start = Date.now();
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: process.env });
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

async function runPool(scripts, concurrency, timeoutMs) {
  const results = new Array(scripts.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= scripts.length) return;
      results[my] = await runOne(scripts[my], timeoutMs);
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
  let scripts;
  if (opts.only.length) {
    scripts = [...new Set(opts.only)];
  } else if (opts.affected) {
    const affected = computeAffected(opts.affectedBase);
    if (affected === null) {
      console.log('runVerifySuite: --affected could not confidently resolve the affected set; falling back to the FULL suite.\n');
      scripts = allScripts;
    } else {
      scripts = affected;
    }
  } else {
    scripts = allScripts;
  }

  const allSet = new Set(allScripts);
  const unknown = scripts.filter(s => !allSet.has(s));
  if (unknown.length) {
    console.error(`runVerifySuite: unknown script(s), not found in scripts/: ${unknown.join(', ')}`);
    process.exit(1);
  }

  if (opts.list) {
    console.log(scripts.length ? scripts.join('\n') : '(nothing selected)');
    return;
  }

  if (scripts.length === 0) {
    console.log('runVerifySuite: no verify scripts affected by the current changes. Nothing to run.');
    return;
  }

  const parallelScripts = scripts.filter(s => !UNSAFE_FOR_PARALLEL.has(s));
  const serialScripts = scripts.filter(s => UNSAFE_FOR_PARALLEL.has(s));

  console.log(
    `runVerifySuite: ${scripts.length} script(s) selected` +
    (opts.affected ? ' (--affected)' : '') +
    ` — ${parallelScripts.length} in a pool of ${concurrency}` +
    (serialScripts.length ? `, ${serialScripts.length} serially (UNSAFE_FOR_PARALLEL)` : '') +
    `, ${timeoutMs}ms/script timeout.\n`
  );

  const t0 = Date.now();
  const parallelResults = await runPool(parallelScripts, concurrency, timeoutMs);
  const serialResults = [];
  for (const s of serialScripts) serialResults.push(await runOne(s, timeoutMs));
  const results = [...parallelResults, ...serialResults];
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  for (const r of results) {
    const mark = r.code === 0 ? '✅' : '❌';
    console.log(`${mark} ${r.script}  (${r.ms}ms)${r.timedOut ? '  [TIMED OUT]' : ''}`);
  }

  const failed = results.filter(r => r.code !== 0);
  const passed = results.length - failed.length;

  if (failed.length) {
    console.log(`\n--- FAILURE DETAIL (${failed.length} of ${results.length}) ---`);
    for (const r of failed) {
      console.log(`\n===== ${r.script} (exit ${r.code}${r.timedOut ? ', timed out' : ''}) =====`);
      if (r.stdout.trim()) console.log(r.stdout.trim());
      if (r.stderr.trim()) console.error(r.stderr.trim());
    }
  }

  console.log(`\nrunVerifySuite: ${passed}/${results.length} passed in ${elapsedSec}s wall clock (concurrency=${concurrency}).`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map(r => r.script).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('runVerifySuite: internal error:', err);
  process.exit(1);
});
