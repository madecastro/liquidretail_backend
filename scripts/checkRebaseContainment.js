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
 *      Revised 2026-08-19 (FIX 3c): survival is now tracked PER SOURCE FILE
 *      rather than one global "does this text exist anywhere" set. The old
 *      global Set let a line duplicated across files at BEFORE (this repo's
 *      own conventions produce this constantly — e.g. shared boilerplate
 *      appearing near-verbatim in both session.md and CLAUDE.md) mask a
 *      real deletion: delete the line from session.md, and its untouched
 *      twin already sitting in CLAUDE.md at BEFORE satisfied the global Set
 *      regardless, reporting "survived" for a file it never survived in. A
 *      BEFORE line missing from its own file at AFTER is now only accepted
 *      as "explained" if it turns up in some AFTER file that did NOT
 *      already contain that exact line at BEFORE too — i.e. genuinely new
 *      territory, which is what real content migration (the session.md ->
 *      session.d/*.md case) actually looks like. A survival that comes only
 *      from a file that already had the line before proves nothing about
 *      the file that lost it.
 *
 *      Revised 2026-08-19 (FIX 3d): `--files=` now supports real globs (`*`
 *      within a segment, a leading `**\/` for any directory depth) rather
 *      than a plain `endsWith` — the doc'd example `--files='**\/*.md'`
 *      previously matched the literal suffix "**\/*.md" against every path,
 *      which is never true, silently checking zero files and reporting "0
 *      doc files checked, all good". An explicit --files that still matches
 *      zero files at BOTH refs is now a loud error, not a clean pass — a
 *      scope that checked nothing is not evidence of safety.
 *
 *   2. COMMIT CONTAINMENT. Every commit reachable from BEFORE but not from
 *      AFTER (`git rev-list AFTER..BEFORE`) must have an equivalent patch
 *      (compared by `git patch-id`) among the commits reachable from AFTER
 *      but not BEFORE (`git rev-list BEFORE..AFTER` — i.e. the rebased/
 *      replayed versions). A commit with no patch-id match anywhere in that
 *      set is flagged as POSSIBLY DROPPED. Known false positives, stated
 *      rather than hidden: a commit that became genuinely empty after
 *      rebase (its diff fully subsumed by another commit) has no patch-id
 *      match either — so always read the flagged commit's subject/diff
 *      before assuming loss.
 *
 *      Revised 2026-08-19 (FIX 3a): merge commits are no longer given a
 *      blanket skip. A prior version excluded them entirely from this
 *      check's notion of "lost" ("patch-id over a merge diff isn't
 *      meaningful," true for a normal two-parent patch-id, but that meant a
 *      merge commit's OWN resolution content — text typed directly while
 *      resolving a conflict, never present in either parent — could vanish
 *      completely (e.g. a `--no-rebase-merges` flatten-rebase drops the
 *      merge commit outright) with NEITHER check catching it: line
 *      containment only scans doc files by default, and the merge commit
 *      itself was never inspected here either. A merge commit's COMBINED
 *      diff (`git diff-tree --cc`) shows exactly the lines that differ from
 *      EVERY parent — i.e. only what the merge resolution itself
 *      contributed — and each such added line is now checked for survival
 *      anywhere in the after-ref's full tree (not just docs, since we can't
 *      know what file type the resolution touched). Only flagged if that
 *      combined diff is non-empty AND at least one of its added lines is
 *      genuinely missing; a "clean" merge with no resolution content of its
 *      own is still correctly a non-issue.
 *
 *      Revised 2026-08-19 (FIX 3b): when `before` is a plain git ancestor of
 *      `after` (a fast-forward, or literally any pair of refs where nothing
 *      was rebased at all), `rev-list after..before` is empty by
 *      construction — every commit reachable from before is, unchanged,
 *      also reachable from after. A prior version printed this as "OK:
 *      ...after-ref is a strict superset", the EXACT SAME wording a
 *      genuinely-verified, patch-id-matched rebase would produce, even
 *      though in this shape zero comparisons were performed — there was no
 *      rebase replay to compare in the first place. That made a vacuous
 *      check indistinguishable from a real one. This now prints a clearly
 *      different "N/A" status: not proof of loss, but explicitly NOT the
 *      same as "verified nothing was lost" either. It's also a reminder
 *      that this check is structurally blind to a later, ORDINARY commit
 *      deleting content that existed at before (ancestor-reachability says
 *      nothing about whether the final tree still holds that content) —
 *      that failure mode is exactly what LINE CONTAINMENT exists to catch,
 *      which is why it now runs first regardless of this check's shape.
 *
 * USAGE
 *   node scripts/checkRebaseContainment.js <beforeRef> [afterRef]
 *   node scripts/checkRebaseContainment.js ORIG_HEAD HEAD          # right after a rebase
 *   node scripts/checkRebaseContainment.js origin/main HEAD
 *   node scripts/checkRebaseContainment.js <before> <after> --min-line-len=12
 *   node scripts/checkRebaseContainment.js <before> <after> --files='**\/*.md'
 *   node scripts/checkRebaseContainment.js <before> <after> --files=session.md
 *
 * afterRef defaults to HEAD. `--files` accepts a plain suffix (endsWith,
 * case-insensitive, e.g. the default '.md' or 'session.md') OR a glob
 * containing `*`/`?`/`[` (e.g. '**\/*.md'), matched against the full
 * repo-relative path. Exit code 1 if either check finds a genuine problem —
 * wire this into a post-rebase hook, or just run it by hand before trusting
 * a rebase you weren't watching line-by-line. Read-only: uses `git show`/
 * `git ls-tree`/`git rev-list`/`git diff-tree` against the named refs; never
 * checks out, resets, or modifies the working tree or index.
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
  const opts = { minLineLen: 8, suffix: '.md', suffixExplicit: false };
  for (const arg of argv) {
    if (arg.startsWith('--min-line-len=')) opts.minLineLen = parseInt(arg.slice('--min-line-len='.length), 10);
    else if (arg.startsWith('--files=')) { opts.suffix = arg.slice('--files='.length); opts.suffixExplicit = true; }
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
  console.log('Usage: node scripts/checkRebaseContainment.js <beforeRef> [afterRef] [--min-line-len=N] [--files=<pattern>]');
  console.log("  afterRef defaults to HEAD. --files matches tracked paths either by plain suffix (default '.md',");
  console.log("  e.g. --files=session.md for one filename) or, if the pattern contains * ? or [, as a glob against");
  console.log("  the full repo-relative path (e.g. --files='**/*.md'). See the file header for what this checks.");
}

// Binary/media extensions excluded from the full-tree scan used by the
// merge-commit content check (FIX 3a) — that scan reads every tracked file
// at a ref looking for a handful of specific text lines, so there is no
// reason to pull large binary blobs through `git show` just to discard them.
const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|mp4|mov|webm|woff2?|ttf|otf|eot|bin|exe|dll|so|dylib|sqlite3?|db)$/i;

function isGlobPattern(s) { return /[*?[\]]/.test(s); }

/** Converts a small glob subset (`**\/` prefix, `*` within a segment) to a RegExp. */
function globToRegExp(glob) {
  let pattern = glob;
  let anyPrefix = false;
  if (pattern.startsWith('**/')) { anyPrefix = true; pattern = pattern.slice(3); }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp((anyPrefix ? '(^|/)' : '^') + escaped + '$');
}

function matchesFilePattern(relPath, pattern) {
  if (isGlobPattern(pattern)) return globToRegExp(pattern).test(relPath);
  return relPath.toLowerCase().endsWith(pattern.toLowerCase());
}

/** All tracked file paths at `ref` matching `pattern`, excluding node_modules. */
function listDocFiles(ref, pattern) {
  const out = git(['ls-tree', '-r', '--name-only', ref]);
  return out.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(p => !p.startsWith('node_modules/'))
    .filter(p => matchesFilePattern(p, pattern));
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

/**
 * See the FIX 3c/3d doc comments at the top of the file for why this tracks
 * survival per-file (with a genuine-new-location escape hatch) instead of
 * one global Set, and why a 0/0-match explicit --files is a loud error.
 */
function checkLineContainment(before, after, minLineLen, suffix, suffixExplicit) {
  console.log(`--- 1. LINE CONTAINMENT (files matching "${suffix}", min ${minLineLen} non-whitespace chars/line) ---`);

  const beforeFiles = listDocFiles(before, suffix);
  const afterFiles = listDocFiles(after, suffix);

  if (suffixExplicit && beforeFiles.length === 0 && afterFiles.length === 0) {
    console.log(
      `ERROR: --files=${suffix} matched ZERO tracked files at EITHER ref. That is almost certainly ` +
      `a pattern mistake, not evidence there is nothing to check — refusing to report a clean pass ` +
      `for a scope that checked nothing. (Plain suffixes match via endsWith; a pattern containing ` +
      `* ? or [ is matched as a glob against the full path — see --help.)`
    );
    return false;
  }

  const beforeLinesByFile = new Map();
  for (const f of beforeFiles) {
    const text = readFileAt(before, f);
    if (text == null) continue;
    beforeLinesByFile.set(f, significantLines(text, minLineLen));
  }

  const afterLinesByFile = new Map(); // file -> Set(lines)
  for (const f of afterFiles) {
    const text = readFileAt(after, f);
    if (text == null) continue;
    afterLinesByFile.set(f, new Set(significantLines(text, minLineLen)));
  }

  // line -> Set(files) it appeared in, at each ref — used to tell "this is
  // genuinely new territory" (real migration) from "this file already had a
  // duplicate elsewhere before, which proves nothing about this file's copy".
  const beforeLineLocations = new Map();
  for (const [f, lines] of beforeLinesByFile) {
    for (const l of lines) {
      if (!beforeLineLocations.has(l)) beforeLineLocations.set(l, new Set());
      beforeLineLocations.get(l).add(f);
    }
  }
  const afterLineLocations = new Map();
  for (const [f, lineSet] of afterLinesByFile) {
    for (const l of lineSet) {
      if (!afterLineLocations.has(l)) afterLineLocations.set(l, new Set());
      afterLineLocations.get(l).add(f);
    }
  }

  const missing = []; // { file, line }
  let totalLines = 0;
  for (const [f, lines] of beforeLinesByFile) {
    totalLines += lines.length;
    const afterOwnSet = afterLinesByFile.get(f); // undefined if the file is gone at `after`
    for (const line of lines) {
      if (afterOwnSet && afterOwnSet.has(line)) continue; // unchanged, same file — trivially fine
      const beforeLocs = beforeLineLocations.get(line); // always includes `f`
      const afterLocs = afterLineLocations.get(line);
      const genuinelyNewElsewhere = afterLocs && [...afterLocs].some((g) => !beforeLocs.has(g));
      if (genuinelyNewElsewhere) continue; // real migration to territory that didn't already have it
      missing.push({ file: f, line });
    }
  }

  console.log(`checked ${beforeFiles.length} file(s) at ${before} (${totalLines} significant lines) against ${afterFiles.length} file(s) at ${after}.`);

  if (missing.length) {
    console.log(`\n${missing.length} line(s) present at ${before} but not found unchanged in place, or in a genuinely new location, at ${after}:\n`);
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
    console.log('OK: every significant line survived, either unchanged in place or in a genuinely new location.');
  }

  return missing.length === 0;
}

/** sha -> patch-id (or null if the commit has no diff / patch-id failed). Not used for merges. */
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

function parentShas(sha) {
  return git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).slice(1);
}

function isMergeCommit(sha) {
  return parentShas(sha).length > 1;
}

function commitSubject(sha) {
  return git(['log', '-1', '--format=%h %ci %s', sha]).trim();
}

/**
 * FIX 3a: the lines a merge commit's OWN resolution contributed — i.e. the
 * combined-diff hunks that differ from EVERY parent (not just one side of a
 * two-way difference, which the merge naturally produces just by combining
 * differing parents and does not represent hand-typed resolution content).
 * Uses the real parent count to slice each combined-diff line's marker
 * prefix precisely, rather than greedily grabbing leading '+' characters
 * (which could swallow real content that happens to start with '+').
 */
function mergeResolutionAddedLines(sha, minLineLen) {
  const nParents = parentShas(sha).length;
  if (nParents < 2) return [];
  let diff;
  try {
    diff = execFileSync('git', ['diff-tree', '--cc', '--no-color', '-p', sha], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  } catch (e) {
    return [];
  }
  const lines = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('---') ||
        raw.startsWith('+++') || raw.startsWith('@@')) continue; // headers, not content
    if (raw.length < nParents) continue;
    const marker = raw.slice(0, nParents);
    if (!/^\++$/.test(marker)) continue; // must be new relative to EVERY parent
    const content = raw.slice(nParents).trim();
    if (content.replace(/\s/g, '').length >= minLineLen) lines.push(content);
  }
  return lines;
}

// Full-tree line index at a ref, built lazily and only when a flagged merge
// commit actually needs it (bounded, rare cost — not paid on every run).
const _fullTreeLineCache = new Map();
function lineExistsSomewhereAt(ref, line) {
  if (!_fullTreeLineCache.has(ref)) {
    const files = git(['ls-tree', '-r', '--name-only', ref]).split('\n').map(s => s.trim()).filter(Boolean)
      .filter((p) => !p.startsWith('node_modules/'))
      .filter((p) => !BINARY_EXT_RE.test(p));
    const lineSet = new Set();
    for (const f of files) {
      const text = readFileAt(ref, f);
      if (text == null || text.indexOf('\u0000') !== -1) continue; // unreadable or binary
      for (const l of text.split('\n')) lineSet.add(l.trim());
    }
    _fullTreeLineCache.set(ref, lineSet);
  }
  return _fullTreeLineCache.get(ref).has(line);
}

/**
 * Returns { ok, checked }. `checked` is false exactly when before is a
 * plain ancestor of after (FIX 3b) — no rebase-shaped rewrite exists
 * between the two refs to compare, so nothing here confirms safety either
 * way; the caller must report this distinctly from a real "OK".
 */
function checkCommitContainment(before, after, minLineLen) {
  console.log(`\n--- 2. COMMIT CONTAINMENT (${before} vs ${after}) ---`);

  let lostCandidates, newCandidates;
  try {
    lostCandidates = git(['rev-list', `${after}..${before}`]).split('\n').map(s => s.trim()).filter(Boolean);
    newCandidates = git(['rev-list', `${before}..${after}`]).split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.log(`could not compute rev-list between the two refs (${e.message.trim()}); skipping this check.`);
    return { ok: true, checked: false };
  }

  console.log(`${lostCandidates.length} commit(s) reachable from ${before} but not ${after}; ${newCandidates.length} reachable from ${after} but not ${before}.`);

  if (lostCandidates.length === 0) {
    console.log(
      `N/A: ${before} is a plain git ancestor of ${after} (or identical to it) — no rebase-shaped ` +
      `history rewrite happened between these two refs, so there is nothing here to compare. This is ` +
      `NOT the same as "verified nothing was lost": it means zero comparisons were performed. If you ` +
      `meant to validate a rebase, confirm "before" really is the pre-rebase tip (e.g. ORIG_HEAD ` +
      `captured immediately after the rebase) — this shape usually means either nothing was rebased, ` +
      `or the wrong ref was passed. This check is also structurally blind to a later, ordinary commit ` +
      `deleting content that existed at "before" (ancestor-reachability says nothing about whether the ` +
      `final tree still holds that content) — LINE CONTAINMENT above is what catches that.`
    );
    return { ok: true, checked: false };
  }

  const newPatchIds = new Set();
  for (const sha of newCandidates) {
    if (isMergeCommit(sha)) continue;
    const id = patchIdFor(sha);
    if (id) newPatchIds.add(id);
  }

  const flagged = [];
  for (const sha of lostCandidates) {
    if (isMergeCommit(sha)) {
      const uniqueLines = mergeResolutionAddedLines(sha, minLineLen);
      if (!uniqueLines.length) continue; // a "clean" merge — nothing of its own to lose
      const missingLines = uniqueLines.filter((l) => !lineExistsSomewhereAt(after, l));
      if (missingLines.length) flagged.push({ sha, reason: "merge's own resolution content not found in after-tree", lines: missingLines });
      continue;
    }
    const id = patchIdFor(sha);
    if (id === null) continue; // no diff (already empty) — nothing to lose
    if (!newPatchIds.has(id)) flagged.push({ sha, reason: 'no equivalent patch found in after-ref' });
  }

  if (flagged.length) {
    console.log(`\n${flagged.length} commit(s) from ${before} have NO equivalent content anywhere in ${after} — POSSIBLY DROPPED:\n`);
    for (const f of flagged) {
      console.log(`  ${commitSubject(f.sha)}  [${f.reason}]`);
      if (f.lines) for (const l of f.lines.slice(0, 5)) console.log(`    - ${l.length > 140 ? l.slice(0, 140) + '…' : l}`);
    }
    console.log('\nThis is a heuristic: read each one (`git show <sha>`) before concluding content was actually lost.');
  } else {
    console.log("OK: every non-merge commit unique to the before-ref has a patch-id match in the after-ref, and every merge commit's own resolution content (if any) still exists in the after-tree.");
  }

  return { ok: flagged.length === 0, checked: true };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`checkRebaseContainment: before=${opts.before}  after=${opts.after}\n`);

  const lineOk = checkLineContainment(opts.before, opts.after, opts.minLineLen, opts.suffix, opts.suffixExplicit);
  const commitResult = checkCommitContainment(opts.before, opts.after, opts.minLineLen);

  console.log('\n=== SUMMARY ===');
  console.log(`line containment:   ${lineOk ? 'OK' : 'ISSUES FOUND'}`);
  console.log(`commit containment: ${commitResult.checked ? (commitResult.ok ? 'OK' : 'ISSUES FOUND') : 'N/A (no rebase-shaped rewrite between these refs — see above)'}`);

  if (!lineOk || (commitResult.checked && !commitResult.ok)) {
    process.exitCode = 1;
  }
}

main();
