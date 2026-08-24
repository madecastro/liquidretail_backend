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
 * and flags any whose diff has existed longer than a threshold.
 *
 * Revised 2026-08-19 — two fixes, both confirmed by reproduction:
 *
 *   1. RENAME MISPARSE: `git status --porcelain -z` puts a rename record as
 *      `XY <newpath>\0<oldpath>\0` — confirmed empirically (`git mv a b`
 *      produces `R  b\0a\0`, NOT the other order). The previous parser
 *      correctly read the new path from the first field, then
 *      UNCONDITIONALLY OVERWROTE it with the second (old-path) field,
 *      reporting a fresh, intentional `git mv` as a stale deletion of a
 *      file that no longer exists (`fs.statSync` on the old name throws,
 *      read as "unknown age (deleted)" and always flagged stale). Fixed by
 *      keeping the first field as-is and just consuming the trailing
 *      old-path field without using it.
 *
 *   2. MTIME IS NOT A PROXY FOR "HOW LONG HAS THIS DIFF EXISTED": a plain
 *      `touch`, an editor's format-on-save, or — very concretely, in THIS
 *      repo — the `withTempMutation`-shaped verify* harnesses
 *      (verifyVideoCostReconcile.js, verifyVideoTimeoutReconcile.js,
 *      verifyQuoteRotation.js) that `fs.writeFileSync` a mutated copy of a
 *      real repo file in place, then restore the original bytes, all
 *      rewrite mtime to "now" with zero net content change — silently
 *      resetting the staleness clock on a genuinely old, unrelated
 *      uncommitted diff sitting on that same file, or making the tool
 *      think a file just became dirty when nothing changed. Fixed by
 *      tracking age from the DIFF'S CONTENT, not the file's mtime: a
 *      per-checkout state file (under `git rev-parse --git-dir`, so each
 *      worktree gets its own — never a tracked/committed path) remembers a
 *      hash of `git diff HEAD -- <file>` and the timestamp it was first
 *      observed; unchanged diff content reuses the original "first seen"
 *      time regardless of how many times the file was rewritten to disk in
 *      between, and only a genuinely different diff resets the clock.
 *
 * USAGE
 *   node scripts/findStaleUncommittedWork.js                  # this checkout, 2h threshold
 *   node scripts/findStaleUncommittedWork.js --repo=/path/to/checkout
 *   node scripts/findStaleUncommittedWork.js --min-age-hours=0.5
 *   node scripts/findStaleUncommittedWork.js --json
 *
 * This is a REPORTING tool, not a rescue tool — it never commits, stashes,
 * or touches any file (state is recorded only under .git/, never in the
 * working tree). When it finds something, the fix is human judgment: either
 * it becomes a branch + PR (if it's real, scoped work), or it gets
 * discarded (if it was scratch), never a silent third option. Exit code 1
 * if anything is flagged as stale, so this can be wired into a periodic
 * check without anyone having to remember to ask.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const opts = { repo: process.cwd(), minAgeHours: 2, json: false };
  for (const arg of argv) {
    if (arg.startsWith('--repo=')) opts.repo = path.resolve(arg.slice('--repo='.length));
    else if (arg === '--all-worktrees') opts.allWorktrees = true;
    else if (arg.startsWith('--min-age-hours=')) opts.minAgeHours = parseFloat(arg.slice('--min-age-hours='.length));
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log('Usage: node scripts/findStaleUncommittedWork.js [--repo=<path>] [--all-worktrees] [--min-age-hours=N] [--json]');
  console.log('Lists tracked files with uncommitted changes in a checkout, flagging any older than the threshold.');
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
}

/**
 * Tracked-file status entries only — M/A/D/R/C, both staged (index) and
 * unstaged (worktree). Skips '??' untracked.
 *
 * FIX (rename order): confirmed empirically — `git status --porcelain -z`
 * puts a rename record as `XY <newpath>\0<oldpath>\0`. The first \0-field
 * (this loop's `entry`) already holds the CURRENT (new) path; a prior
 * version then unconditionally overwrote it with the second field (the
 * OLD, now-nonexistent path), so every fresh `git mv` was reported as a
 * stale deletion of a file that had simply been renamed. The fix is to
 * leave `file` alone and just consume the trailing old-path field.
 */
function trackedStatusEntries(repo) {
  const out = git(repo, ['status', '--porcelain=v1', '-z']);
  const entries = [];
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const statusCode = entry.slice(0, 2);
    const file = entry.slice(3); // already the current/new path, for renames too
    if (statusCode[0] === 'R' || statusCode[1] === 'R') {
      i++; // consume the old-path field that follows; it is not `file`
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

// ---------------------------------------------------------------------------
// FIX (mtime is not a proxy for diff age): track how long a file's
// UNCOMMITTED DIFF CONTENT has existed, via a small persisted state file
// under this checkout's private git-dir (`git rev-parse --git-dir` — a
// worktree's own `.git/worktrees/<name>`, not the shared common dir, so
// concurrent worktrees never clobber each other's history; never a tracked
// path, so this never shows up as a change to commit). A file's mtime gets
// bumped by a plain `touch`, an editor's format-on-save, or — concretely,
// in this repo — the verify* harnesses that mutate a real file in place and
// then restore it: none of those change what `git diff HEAD -- file`
// actually produces, so hashing THAT is what "first seen" is keyed on.
// Unchanged diff content across runs reuses the original timestamp
// regardless of how many times the file was rewritten to disk in between;
// only a genuinely different diff resets the clock.
// ---------------------------------------------------------------------------

function gitDirFor(repo) {
  const out = git(repo, ['rev-parse', '--git-dir']).trim();
  return path.isAbsolute(out) ? out : path.join(repo, out);
}

function stateFilePath(repo) {
  return path.join(gitDirFor(repo), 'findStaleUncommittedWork.state.json');
}

function loadState(repo) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(repo), 'utf8'));
  } catch (e) {
    return {}; // missing/corrupt — start fresh rather than fail the whole run
  }
}

function saveState(repo, state) {
  try {
    fs.writeFileSync(stateFilePath(repo), JSON.stringify(state, null, 2));
  } catch (e) { /* best-effort — a write failure here should not fail the report */ }
}

/** Content fingerprint of a file's uncommitted diff (covers staged + unstaged, and deletions). */
function diffFingerprint(repo, file) {
  try {
    const out = git(repo, ['diff', 'HEAD', '--', file]);
    return crypto.createHash('sha256').update(out).digest('hex');
  } catch (e) {
    return null; // can't diff (e.g. a brand-new path with a weird mode) — caller falls back to "unknown age"
  }
}

function runOne(opts) {

  let branch;
  try {
    branch = git(opts.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (e) {
    console.error(`findStaleUncommittedWork: "${opts.repo}" doesn't look like a git repo (${e.message.trim()}).`);
    process.exit(1);
  }

  const entries = trackedStatusEntries(opts.repo);
  const now = Date.now();

  // Content-fingerprint-based age (see the FIX doc comment above
  // diffFingerprint): "first seen" persists across runs as long as the
  // diff's actual content is unchanged, regardless of how many times the
  // file was rewritten to disk (touch, format-on-save, a verify* harness's
  // mutate-then-restore cycle) in between.
  const priorState = loadState(opts.repo);
  const nextState = {}; // rebuilt fresh each run — files no longer dirty simply drop out

  const rows = [];
  for (const { statusCode, file } of entries) {
    const fp = diffFingerprint(opts.repo, file);
    let ageHours = null;
    if (fp !== null) {
      const prior = priorState[file];
      // FIRST OBSERVATION USES MTIME AS A FLOOR, NOT `now`.
      //
      // Using `now` here meant the staleness clock started when this TOOL
      // first looked, so on a first run in any checkout every diff reported
      // 0.0h and nothing was ever flagged. Measured 2026-08-21: a sweep of
      // the frontend worktrees reached
      // `.claude/worktrees/catalog-rescrape`, correctly listed all three
      // dirty files, and flagged NONE — while `Sidebar.tsx` carried 309
      // lines of feature work whose mtime was 13 DAYS old. The tool could
      // not have caught the exact case it exists for, in any worktree it
      // had not previously been run in.
      //
      // This does NOT reintroduce the mtime bug in the header. That bug is
      // about mtime RESETTING a known-old clock (a harness rewrite or
      // format-on-save bumps mtime to now, making old work look new). Here
      // mtime is consulted ONLY when there is no prior state for this exact
      // diff content — and from then on the stored firstSeenMs wins, so a
      // later rewrite still cannot reset it. Worst case on a first run is an
      // UNDER-estimate of age (a genuinely old diff whose file was just
      // rewritten), which fails toward silence rather than a false alarm.
      let firstSeenMs;
      if (prior && prior.fingerprint === fp) {
        firstSeenMs = prior.firstSeenMs;
      } else {
        let mtimeMs = now;
        try {
          const st = fs.statSync(path.join(opts.repo, file));
          if (Number.isFinite(st.mtimeMs) && st.mtimeMs > 0 && st.mtimeMs < now) {
            mtimeMs = st.mtimeMs;
          }
        } catch { /* deleted or unreadable — fall back to now */ }
        firstSeenMs = mtimeMs;
      }
      nextState[file] = { fingerprint: fp, firstSeenMs };
      ageHours = (now - firstSeenMs) / (60 * 60 * 1000);
    }
    const diff = numstatFor(opts.repo, file);
    rows.push({ statusCode, file, ageHours, diff });
  }
  saveState(opts.repo, nextState);

  const stale = rows.filter(r => r.ageHours === null || r.ageHours >= opts.minAgeHours);

  if (opts.json) {
    console.log(JSON.stringify({ repo: opts.repo, branch, minAgeHours: opts.minAgeHours, total: rows.length, stale }, null, 2));
  } else {
    console.log(`findStaleUncommittedWork: ${opts.repo}  (branch: ${branch})`);
    console.log(`${rows.length} tracked file(s) with uncommitted changes; flagging anything >= ${opts.minAgeHours}h old.\n`);

    if (rows.length === 0) {
      console.log('Nothing uncommitted. Tree is clean.');
      if (!opts.allWorktreesRun) {
        // "Tree is clean" is true and MISLEADING on its own. Measured
        // 2026-08-21: this exact line printed here while a sibling worktree
        // held 319 lines of feature work that had been uncommitted for 13
        // DAYS — precisely what this tool exists to surface. A reader takes
        // "clean" as "nothing at risk", so say what was NOT checked.
        console.log('NOTE: only this checkout was inspected. Other worktrees of this repo were NOT —');
        console.log('      re-run with --all-worktrees to sweep every one (see `git worktree list`).');
      }
    } else if (stale.length === 0) {
      console.log('All uncommitted changes are recent (below the age threshold) — probably still in progress. Nothing flagged.');
      for (const r of rows) {
        const age = r.ageHours === null ? 'unknown' : `${r.ageHours.toFixed(1)}h`;
        console.log(`  [${r.statusCode}] ${r.file}  (age: ${age})`);
      }
    } else {
      console.log(`${stale.length} file(s) flagged — uncommitted for longer than the threshold, so likely NOT still being actively edited:\n`);
      for (const r of stale) {
        const age = r.ageHours === null ? 'unknown (could not diff)' : `${r.ageHours.toFixed(1)}h`;
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

/**
 * Sweep every worktree of THIS repo (--all-worktrees).
 *
 * Scope is deliberately this repo only. `/Volumes/Sayulita/Projects/RS/` also
 * holds a second, unrelated repo (`liquidretail`) plus worktrees belonging to
 * it; reporting those here would make the output untrustworthy for the repo the
 * caller actually asked about. `git worktree list` is inherently per-repo, so
 * that scoping is structural rather than a filter we have to maintain.
 *
 * Registered-but-missing worktrees are reported, not fatal: this machine
 * accumulates them under /private/tmp, which is periodically wiped, and a
 * hygiene tool that crashes on a pruned entry is a hygiene tool nobody runs.
 */
function listWorktrees(repo) {
  const out = [];
  let raw;
  try {
    raw = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return out;
  }
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), prunable: false };
    } else if (line.startsWith('prunable ') && cur) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.allWorktrees) return runOne(opts);

  const trees = listWorktrees(opts.repo);
  const missing = [];
  const usable = [];
  for (const w of trees) {
    if (w.prunable || !fs.existsSync(w.path)) missing.push(w.path);
    else usable.push(w.path);
  }

  if (!opts.json) {
    console.log(`findStaleUncommittedWork --all-worktrees: ${usable.length} worktree(s) of ${opts.repo}`);
    if (missing.length) {
      console.log(`${missing.length} registered but absent from disk (run \`git worktree prune\`):`);
      for (const m of missing) console.log(`  - ${m}`);
    }
    console.log('');
  }

  let anyStale = false;
  for (const treePath of usable) {
    if (!opts.json) console.log('='.repeat(72));
    // allWorktreesRun suppresses the per-tree "other worktrees were not
    // checked" note — in this mode they demonstrably were.
    runOne({ ...opts, repo: treePath, allWorktreesRun: true });
    if (process.exitCode === 1) anyStale = true;
  }
  process.exitCode = anyStale ? 1 : 0;
}

main();
