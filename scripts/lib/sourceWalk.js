'use strict';
//
// sourceWalk — ONE filesystem walk for every verify* harness that scans source.
//
// WHY THIS EXISTS (measured 2026-08-23)
//   22 harnesses under scripts/ did their own fs.readdirSync walk. Zero of
//   those skip lists named `.worktrees`, `.wt-*`, or `.drafts`. Nine didn't
//   even name `node_modules`. This machine nests git worktrees INSIDE the
//   main checkout (`.worktrees/*`, `.claude/worktrees/*`, `.wt-detect-tenancy`)
//   plus a gitignored `.drafts/`. `.gitignore` does not help: these are raw
//   fs walks, not git ls-files.
//
//   Measured: `npm test` on origin/main, verifyArchiveDigestRelease FAIL with
//   7 false positives, all files like
//     .worktrees/veo-run-drain/services/adArchiveDigest.js
//   Its local SKIP_DIRS listed `worktrees` — the real directory is `.worktrees`
//   (leading dot). A one-character miss.
//
//   Worse than the red: harnesses that stay green while walking nested
//   worktrees silently assert against other sessions' uncommitted code, so
//   the result is non-deterministic. That set includes money/security
//   scanners (verifyArchiveDigestRelease, verifyReceiptAwareRequeue,
//   verifyMembersAuthz, verifyAdminSettingsAuthz).
//
//   One definition, imported — never a per-caller copy. CLAUDE.md §4 records
//   a money hole that opened from a per-caller copy of a guard
//   (`resolveDeriveFromMaster`). This is the same shape.
//
// RETURNS
//   Absolute paths (path.resolve). Callers that want repo-relative keys
//   already do path.relative(ROOT, p); keep doing that. Sorted by neither
//   mtime nor locale — readdir order, matching the walks this replaced.
//
// ROOT SCOPE
//   The first argument is the walk root. Pass services/ if that is what the
//   harness already walked; do NOT pass the repo root "to be safe". The
//   helper must not silently widen a caller's scope.
//
// SKIP RULES
//   1. Exact directory name in SKIP_DIRS.
//   2. Any directory whose name STARTS WITH `.wt-` (pattern, not a list —
//      new worktrees appear constantly and an allowlist will rot).
//   3. Any directory that CONTAINS a `.git` FILE (not directory).
//      Load-bearing, and why (3) exists on top of (1)+(2): name denylists
//      rot. This repo already shipped SKIP_DIRS containing `worktrees`
//      while the real directory is `.worktrees`. A linked git worktree's
//      positive signature is a `.git` *file* at its root (contents
//      `gitdir: …/worktrees/<name>`). Skipping any directory that contains
//      that file excludes a worktree created under a name nobody predicted
//      (`tmp/scratchpad/wt-agent-authz2`, tomorrow's `.foo-session`, …).
//      The walk ROOT itself is never subjected to (3), so a harness running
//      FROM a worktree still scans that worktree.
//
//   Symlinked directories are not followed (Dirent.isDirectory() is false
//   for a symlink-to-dir). That is the other-repo fence at the fs layer.
//
//   4. Any FILE whose name starts with `.`, UNCONDITIONALLY — independent of
//      skipDotNames, which only gates recursing INTO dot-directories. Found
//      2026-08-31: several "revertprove" harnesses (grep scripts/ for
//      "revertprove") briefly write a transient SIBLING file named
//      `.__revertprove_<base>_<pid>_<ts>_<rand>.js` directly into a real
//      routes/ or services/ file's own directory while mutation-testing.
//      Before this rule, a walkSource() caller scanning that directory could
//      collect that dotted name (it has a matching extension) and then hit
//      ENOENT reading it once the writer's cleanup deleted it first — the
//      exact race already reproduced in CI for verifyMetaApiVersion.js's own
//      hand-rolled walk. No real source file is dot-prefixed, so this is
//      unconditional, not an opt-in.
//
// OPTS
//   extensions     default ['.js', '.mjs', '.jsx', '.cjs']
//                  matched with String#endsWith, same as the walks this
//                  replaced (`e.name.endsWith('.js')`).
//   extraSkipDirs  extra exact directory names for this call only
//                  (e.g. 'assets', 'frontend'). Does not mutate SKIP_DIRS.
//   skipDotNames   if true, skip EVERY directory whose name starts with `.`
//                  (preserves verifyLlmErrorCodes / verifyConceptContract;
//                  default false so a ROOT walk still sees e.g. `.codegraph`
//                  iff a caller used to).
//
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.worktrees',
  'worktrees',
  '.drafts',
  'coverage',
  'dist',
  'build',
  '.next',
  '.vite',
]);

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.jsx', '.cjs'];

function isLinkedWorktree(dirAbs) {
  // Positive signature of `git worktree add`: a `.git` FILE, not a dir.
  // lstat: do not follow a symlink that happens to be named `.git`.
  try {
    const st = fs.lstatSync(path.join(dirAbs, '.git'));
    return st.isFile();
  } catch (e) {
    return false;
  }
}

function hasExtension(name, extensions) {
  for (let i = 0; i < extensions.length; i++) {
    const ext = extensions[i];
    if (ext && name.endsWith(ext) && name.length > ext.length) return true;
  }
  return false;
}

function shouldSkipDir(dirAbs, name, skip, skipDotNames) {
  if (name === '.' || name === '..') return true;
  if (skip.has(name)) return true;
  if (name.startsWith('.wt-')) return true;
  if (skipDotNames && name.startsWith('.')) return true;
  return isLinkedWorktree(dirAbs);
}

function walkSource(rootDir, opts) {
  const options = opts || {};
  const extensions = options.extensions || DEFAULT_EXTENSIONS;
  const skip = new Set(SKIP_DIRS);
  const extra = options.extraSkipDirs || [];
  for (let i = 0; i < extra.length; i++) skip.add(extra[i]);
  const skipDotNames = options.skipDotNames === true;
  const out = [];

  const rootAbs = path.resolve(rootDir);
  let rootStat;
  try {
    rootStat = fs.lstatSync(rootAbs);
  } catch (e) {
    return out; // missing root — same as verifyAdminSettingsAuthz's existsSync guard
  }
  if (!rootStat.isDirectory()) return out;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(full, entry.name, skip, skipDotNames)) continue;
        walk(full);
      } else if (entry.isFile() && !entry.name.startsWith('.') && hasExtension(entry.name, extensions)) {
        out.push(full);
      }
    }
  }

  walk(rootAbs);
  return out;
}

module.exports = {
  SKIP_DIRS,
  DEFAULT_EXTENSIONS,
  walkSource,
};
