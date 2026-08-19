#!/usr/bin/env node
/**
 * findStaleUncommittedWork.js — surfaces finished work that is silently at
 * risk of being lost in a SHARED checkout (not a worktree).
 *
 * THE FAILURE MODE THIS EXISTS FOR: a session working in the shared checkout
 * found and fixed a real tenant-isolation bug as a side-finding while doing
 * something else, verified it against prod, and moved on without branching
 * or opening a PR. The fix (41 lines) sat as an uncommitted tracked-file
 * diff in the shared checkout for hours — `git log --all -S` found it in
 * ZERO commits, because it was never committed anywhere. It was discovered
 * only because the owner happened to ask why the tree wasn't clean.
 *
 * This is a DIFFERENT failure mode from the file-collision problem the rest
 * of this repo's parallel-work tooling addresses: it's not two sessions
 * fighting over the same lines, it's *one* session's finished work having
 * nowhere durable to live because "edit in the shared checkout, then decide
 * later" has no forcing function to make "later" happen.
 *
 * WHAT THIS DOES: lists tracked files with uncommitted changes (staged or
 * unstaged — NOT untracked scratch files, which this repo's shared checkout
 * accumulates by the dozen and are a separate, lower-stakes kind of clutter)
 * and flags any whose most recent write is older than a threshold. Age is a
 * proxy via mtime, not a perfect signal — but "this tracked file has had an
 * uncommitted diff sitting on disk for N+ hours" is exactly the condition
 * that went undetected for 9 hours in the real incident, and this makes it
 * a one-command check instead of a lucky question from the owner.
 *
 * USAGE
 *   node scripts/findStaleUncommittedWork.js                  # this checkout, 2h threshold
 *   node scripts/findStaleUncommittedWork.js --repo=/path/to/checkout
 *   node scripts/findStaleUncommittedWork.js --min-age-hours=0.5
 *   node scripts/findStaleUncommittedWork.js --json
 *
 * This is a REPORTING tool, not a rescue tool — it never commits, stashes,
 * or touches any file. When it finds something, the fix is human judgment:
 * either it becomes a branch + PR (if it's real, scoped work), or it gets
 * discarded (if it was scratch), never a silent third option. Exit code 1
 * if anything is flagged as stale, so this can be wired into a periodic
 * check without anyone having to remember to ask.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const opts = { repo: process.cwd(), minAgeHours: 2, json: false };
  for (const arg of argv) {
    if (arg.startsWith('--repo=')) opts.repo = path.resolve(arg.slice('--repo='.length));
    else if (arg.startsWith('--min-age-hours=')) opts.minAgeHours = parseFloat(arg.slice('--min-age-hours='.length));
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log('Usage: node scripts/findStaleUncommittedWork.js [--repo=<path>] [--min-age-hours=N] [--json]');
  console.log('Lists tracked files with uncommitted changes in a checkout, flagging any older than the threshold.');
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
}

/** Tracked-file status entries only — M/A/D/R/C, both staged (index) and unstaged (worktree). Skips '??' untracked. */
function trackedStatusEntries(repo) {
  const out = git(repo, ['status', '--porcelain=v1', '-z']);
  const entries = [];
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const statusCode = entry.slice(0, 2);
    let file = entry.slice(3);
    // Renames ("R100") carry "old\0new" — the next \0-part is the new name.
    if (statusCode[0] === 'R' || statusCode[1] === 'R') {
      i++;
      file = parts[i];
    }
    if (statusCode === '??' || statusCode === '!!') continue; // untracked / ignored
    entries.push({ statusCode: statusCode.trim(), file });
  }
  return entries;
}

function numstatFor(repo, file) {
  try {
    const out = git(repo, ['diff', '--numstat', 'HEAD', '--', file]).trim();
    if (!out) return null;
    const [added, removed] = out.split('\t');
    return { added, removed };
  } catch (e) {
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let branch;
  try {
    branch = git(opts.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (e) {
    console.error(`findStaleUncommittedWork: "${opts.repo}" doesn't look like a git repo (${e.message.trim()}).`);
    process.exit(1);
  }

  const entries = trackedStatusEntries(opts.repo);
  const now = Date.now();
  const thresholdMs = opts.minAgeHours * 60 * 60 * 1000;

  const rows = [];
  for (const { statusCode, file } of entries) {
    const abs = path.join(opts.repo, file);
    let ageHours = null;
    try {
      const st = fs.statSync(abs);
      ageHours = (now - st.mtimeMs) / (60 * 60 * 1000);
    } catch (e) {
      // Deleted file — no mtime to read; still worth surfacing.
    }
    const diff = numstatFor(opts.repo, file);
    rows.push({ statusCode, file, ageHours, diff });
  }

  const stale = rows.filter(r => r.ageHours === null || r.ageHours >= opts.minAgeHours);

  if (opts.json) {
    console.log(JSON.stringify({ repo: opts.repo, branch, minAgeHours: opts.minAgeHours, total: rows.length, stale }, null, 2));
  } else {
    console.log(`findStaleUncommittedWork: ${opts.repo}  (branch: ${branch})`);
    console.log(`${rows.length} tracked file(s) with uncommitted changes; flagging anything >= ${opts.minAgeHours}h old.\n`);

    if (rows.length === 0) {
      console.log('Nothing uncommitted. Tree is clean.');
    } else if (stale.length === 0) {
      console.log('All uncommitted changes are recent (below the age threshold) — probably still in progress. Nothing flagged.');
      for (const r of rows) {
        const age = r.ageHours === null ? 'unknown' : `${r.ageHours.toFixed(1)}h`;
        console.log(`  [${r.statusCode}] ${r.file}  (age: ${age})`);
      }
    } else {
      console.log(`${stale.length} file(s) flagged — uncommitted for longer than the threshold, so likely NOT still being actively edited:\n`);
      for (const r of stale) {
        const age = r.ageHours === null ? 'unknown (deleted)' : `${r.ageHours.toFixed(1)}h`;
        const size = r.diff ? ` (+${r.diff.added}/-${r.diff.removed})` : '';
        console.log(`  [${r.statusCode}] ${r.file}${size}  — uncommitted for ${age}`);
      }
      console.log('\nEach of these is either finished work with nowhere to live yet (branch it, open a PR),');
      console.log('or discardable scratch (confirm, then `git checkout -- <file>`). Do not leave it here —');
      console.log('a shared checkout has no owner, so "later" only happens if someone is told to look.');
    }
  }

  process.exitCode = stale.length > 0 ? 1 : 0;
}

main();
