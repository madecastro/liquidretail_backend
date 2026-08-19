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
 * PARALLEL-SAFETY, audited 2026-08-19: no scripts/verify* script talks to a
 * live DB or network (the handful touching mongoose/axios do so only for
 * in-memory schema use, or say explicitly in their own comments that they
 * run with no MONGODB_URI), and every script that writes a temp file does
 * it through fs.mkdtempSync (unique per process). So running them
 * concurrently on one machine is safe today. UNSAFE_FOR_PARALLEL below is
 * the escape hatch if a future script breaks that assumption — anything
 * listed there runs alone, serially, after the parallel pool drains.
 *
 * --affected IS A DEV-SPEED HEURISTIC, NOT THE GATE. It selects a verify
 * script if (a) the script itself changed, or (b) the script's source text
 * contains the basename of a changed file (a plain substring check against
 * require()/readFileSync() targets — cheap, and deliberately over-inclusive
 * rather than under). It cannot know about indirect effects (e.g. changing
 * a shared helper's *behavior* without changing any name it's checked
 * against). Run the full suite (no flags) before pushing non-trivial
 * changes — CLAUDE.md's own convention section already says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const VERIFY_RE = /^verify.*\.(js|mjs)$/;

// Empty today (2026-08-19) — every verify* script was audited and found
// parallel-safe. Add a filename here if a future script needs exclusive
// access to something (a fixed port, a fixed file path, a real DB/API key).
const UNSAFE_FOR_PARALLEL = new Set([]);

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
 * "could not compute a diff — caller should fall back to running everything".
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
  //    text mentions the changed file's basename (require/readFileSync
  //    target, typically). Skip very short basenames (index.js, etc.) to
  //    avoid drowning the selection in noise.
  if (remaining.length) {
    const needles = remaining
      .map(rel => path.basename(rel, path.extname(rel)))
      .filter(n => n.length >= 4);
    if (needles.length) {
      for (const script of allScripts) {
        if (selected.has(script)) continue;
        const src = fs.readFileSync(path.join(SCRIPTS_DIR, script), 'utf8');
        if (needles.some(n => src.includes(n))) selected.add(script);
      }
    }
  }

  return [...selected].sort();
}

function runOne(script, timeoutMs) {
  return new Promise((resolve) => {
    const file = path.join(SCRIPTS_DIR, script);
    const start = Date.now();
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ script, code: timedOut ? 1 : code, timedOut, ms: Date.now() - start, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
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
      console.log('runVerifySuite: --affected could not compute a diff; falling back to the FULL suite.\n');
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
