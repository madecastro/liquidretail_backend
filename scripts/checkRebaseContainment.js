#!/usr/bin/env node
/**
 * checkRebaseContainment.js — a safety net for the failure mode that hit
 * this repo TWICE in one night of heavy concurrent-agent use: a rebase
 * silently dropped an entire COMMIT once (a code-file conflict resolved by
 * stripping conflict markers), and silently dropped a whole session.md
 * ENTRY once (during a doc restructure). Both were caught only because a
 * human happened to check by hand afterwards.
 *
 * This runs two independent, read-only checks between a BEFORE ref
 * (pre-rebase state) and an AFTER ref (post-rebase HEAD, or any ref you want
 * to audit) and never touches the working tree or the index:
 *
 *   1. LINE CONTAINMENT on doc/markdown files. Every non-blank, trimmed
 *      line (at least MIN_LINE_LEN non-whitespace chars, default 8 — short
 *      generic lines like "---" or "## 4" recur constantly and would be
 *      pure noise) that existed in ANY *.md file at BEFORE must still
 *      appear, verbatim, SOMEWHERE across all *.md files at AFTER — not
 *      necessarily in the same file, because content legitimately moves
 *      (this repo just moved session.md's body into session.d/*.md).
 *      This is a heuristic textual check, not a semantic diff: a line that
 *      was deliberately REWORDED (not deleted) will also show up as
 *      "missing". That is the correct tradeoff here — a false positive
 *      costs a human a few seconds of "yes, that was an intentional edit";
 *      a false negative is the exact thing that cost this repo real content
 *      twice with nobody noticing until later.
 *
 *   2. COMMIT CONTAINMENT. Every commit reachable from BEFORE but not from
 *      AFTER (`git rev-list AFTER..BEFORE`) must have an equivalent patch
 *      (compared by `git patch-id`) among the commits reachable from AFTER
 *      but not BEFORE (`git rev-list BEFORE..AFTER` — i.e. the rebased/
 *      replayed versions). A commit with no patch-id match anywhere in that
 *      set is flagged as POSSIBLY DROPPED. This is exactly the "conflict
 *      resolved by stripping markers" shape: the commit's content vanishes
 *      instead of being replayed as an equivalent (differently-hashed)
 *      commit. Known false positives, stated rather than hidden: a commit
 *      that became genuinely empty after rebase (its diff fully subsumed by
 *      another commit) has no patch-id match either, and merge commits are
 *      skipped entirely (patch-id over a merge diff is not meaningful) — so
 *      always read the flagged commit's subject/diff before assuming loss.
 *
 * USAGE
 *   node scripts/checkRebaseContainment.js <beforeRef> [afterRef]
 *   node scripts/checkRebaseContainment.js ORIG_HEAD HEAD          # right after a rebase
 *   node scripts/checkRebaseContainment.js origin/main HEAD
 *   node scripts/checkRebaseContainment.js <before> <after> --min-line-len=12
 *   node scripts/checkRebaseContainment.js <before> <after> --files='**\/*.md'
 *
 * afterRef defaults to HEAD. Exit code 1 if either check finds a problem —
 * wire this into a post-rebase hook, or just run it by hand before trusting
 * a rebase you weren't watching line-by-line. Read-only: uses `git show`/
 * `git ls-tree`/`git rev-list` against the named refs; never checks out,
 * resets, or modifies the working tree or index.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

function parseArgs(argv) {
  const positional = [];
  const opts = { minLineLen: 8, suffix: '.md' };
  for (const arg of argv) {
    if (arg.startsWith('--min-line-len=')) opts.minLineLen = parseInt(arg.slice('--min-line-len='.length), 10);
    else if (arg.startsWith('--files=')) opts.suffix = arg.slice('--files='.length);
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else positional.push(arg);
  }
  if (positional.length < 1) {
    printHelp();
    process.exit(1);
  }
  opts.before = positional[0];
  opts.after = positional[1] || 'HEAD';
  return opts;
}

function printHelp() {
  console.log('Usage: node scripts/checkRebaseContainment.js <beforeRef> [afterRef] [--min-line-len=N] [--files=<suffix>]');
  console.log("  afterRef defaults to HEAD. --files matches tracked paths by suffix (default '.md'),");
  console.log('  e.g. --files=session.md to scope to one filename. See the file header for what this checks.');
}

/** All tracked file paths at `ref` matching `suffix` (default '.md'), excluding node_modules. */
function listDocFiles(ref, suffix) {
  const out = git(['ls-tree', '-r', '--name-only', ref]);
  return out.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(p => !p.startsWith('node_modules/'))
    .filter(p => p.toLowerCase().endsWith(suffix.toLowerCase()));
}

function readFileAt(ref, file) {
  try {
    return git(['show', `${ref}:${file}`]);
  } catch (e) {
    return null; // file didn't exist at this ref (e.g. renamed/deleted) — caller handles
  }
}

/** Non-blank, trimmed lines with at least minLen non-whitespace characters. */
function significantLines(text, minLen) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.replace(/\s/g, '').length >= minLen);
}

function checkLineContainment(before, after, minLineLen, suffix) {
  console.log(`--- 1. LINE CONTAINMENT (*${suffix} files, min ${minLineLen} non-whitespace chars/line) ---`);

  const afterFiles = listDocFiles(after, suffix);
  const afterLineSet = new Set();
  for (const f of afterFiles) {
    const text = readFileAt(after, f);
    if (text == null) continue;
    for (const line of significantLines(text, minLineLen)) afterLineSet.add(line);
  }

  const beforeFiles = listDocFiles(before, suffix);
  const missing = []; // { file, line }
  let totalLines = 0;
  for (const f of beforeFiles) {
    const text = readFileAt(before, f);
    if (text == null) continue;
    const lines = significantLines(text, minLineLen);
    totalLines += lines.length;
    for (const line of lines) {
      if (!afterLineSet.has(line)) missing.push({ file: f, line });
    }
  }

  console.log(`checked ${beforeFiles.length} doc file(s) at ${before} (${totalLines} significant lines) against ${afterFiles.length} doc file(s) at ${after}.`);

  if (missing.length) {
    console.log(`\n${missing.length} line(s) present at ${before} but not found anywhere in *.md at ${after}:\n`);
    const byFile = new Map();
    for (const m of missing) {
      if (!byFile.has(m.file)) byFile.set(m.file, []);
      byFile.get(m.file).push(m.line);
    }
    for (const [file, lines] of byFile) {
      console.log(`  ${file} (${lines.length} line(s)):`);
      for (const l of lines.slice(0, 20)) console.log(`    - ${l.length > 140 ? l.slice(0, 140) + '…' : l}`);
      if (lines.length > 20) console.log(`    ... and ${lines.length - 20} more`);
    }
  } else {
    console.log('OK: every significant line survived somewhere in the after-tree.');
  }

  return missing.length === 0;
}

/** sha -> patch-id (or null if the commit is a merge / has no diff / patch-id failed). */
function patchIdFor(sha) {
  try {
    const diff = execFileSync('git', ['diff-tree', '-p', '--no-color', '-r', sha], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
    if (!diff.trim()) return null;
    const out = execFileSync('git', ['patch-id', '--stable'], { cwd: ROOT, input: diff, encoding: 'utf8' });
    const id = out.trim().split(/\s+/)[0];
    return id || null;
  } catch (e) {
    return null;
  }
}

function isMergeCommit(sha) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/);
  return parents.length > 2; // sha + >=2 parents
}

function commitSubject(sha) {
  return git(['log', '-1', '--format=%h %ci %s', sha]).trim();
}

function checkCommitContainment(before, after) {
  console.log(`\n--- 2. COMMIT CONTAINMENT (${before} vs ${after}) ---`);

  let lostCandidates, newCandidates;
  try {
    lostCandidates = git(['rev-list', `${after}..${before}`]).split('\n').map(s => s.trim()).filter(Boolean);
    newCandidates = git(['rev-list', `${before}..${after}`]).split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.log(`could not compute rev-list between the two refs (${e.message.trim()}); skipping this check.`);
    return true;
  }

  console.log(`${lostCandidates.length} commit(s) reachable from ${before} but not ${after}; ${newCandidates.length} reachable from ${after} but not ${before}.`);

  if (lostCandidates.length === 0) {
    console.log('OK: nothing unique to the before-ref — after-ref is a strict superset (fast-forward, or nothing to lose).');
    return true;
  }

  const newPatchIds = new Set();
  for (const sha of newCandidates) {
    if (isMergeCommit(sha)) continue;
    const id = patchIdFor(sha);
    if (id) newPatchIds.add(id);
  }

  const flagged = [];
  for (const sha of lostCandidates) {
    if (isMergeCommit(sha)) continue; // merge commits: not meaningful to patch-id, and rebase legitimately drops/rewrites them
    const id = patchIdFor(sha);
    if (id === null) continue; // no diff (already empty) — nothing to lose
    if (!newPatchIds.has(id)) flagged.push(sha);
  }

  if (flagged.length) {
    console.log(`\n${flagged.length} commit(s) from ${before} have NO equivalent patch anywhere in ${after} — POSSIBLY DROPPED:\n`);
    for (const sha of flagged) console.log(`  ${commitSubject(sha)}`);
    console.log('\nThis is a heuristic (patch-id over the full diff): a commit that was intentionally');
    console.log('reworded/squashed into a different-looking diff can also show up here. Read each');
    console.log('one (`git show <sha>`) before concluding content was actually lost.');
  } else {
    console.log('OK: every non-merge commit unique to the before-ref has a patch-id match in the after-ref.');
  }

  return flagged.length === 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`checkRebaseContainment: before=${opts.before}  after=${opts.after}\n`);

  const lineOk = checkLineContainment(opts.before, opts.after, opts.minLineLen, opts.suffix);
  const commitOk = checkCommitContainment(opts.before, opts.after);

  console.log('\n=== SUMMARY ===');
  console.log(`line containment:   ${lineOk ? 'OK' : 'ISSUES FOUND'}`);
  console.log(`commit containment: ${commitOk ? 'OK' : 'ISSUES FOUND'}`);

  if (!lineOk || !commitOk) {
    process.exitCode = 1;
  }
}

main();
