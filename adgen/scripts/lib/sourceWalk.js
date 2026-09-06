'use strict';
//
// PORTED from liquidretail_backend/scripts/lib/sourceWalk.js (pre-2026-08-24
// snapshot) into liquidretail_adgen. Originally a verbatim port — no logic
// changed. See the backend file for the original history/incident notes.
// Needed here because verifyArchiveDigestRelease.js (ported alongside this
// file) requires it for its whole-repo source scan.
//
// 2026-08-31: ported forward ONE fix from backend (not a full re-sync).
// walkSource() returned dot-prefixed FILE names too — skipDotNames only
// gates recursing INTO dot-directories. verifyQuoteColourway.js and
// verifyQuoteSnippetProofBarGate.js each briefly write a transient sibling
// `.__revertprove_*.js` into src/services/ while mutation-testing; under
// runVerifySuite.js's parallel pool, verifyArchiveDigestRelease.js's
// whole-repo walkSource(ROOT) scan could collect that name and then ENOENT
// reading it once the writer's own cleanup deleted it first — the same race
// already reproduced and fixed in backend's verifyMetaApiVersion.js. Fixed
// at the file-match check below, unconditionally (no real source file is
// dot-prefixed).
//
// sourceWalk — ONE filesystem walk for every verify* harness that scans source.
//
// SKIP RULES
//   1. Exact directory name in SKIP_DIRS.
//   2. Any directory whose name STARTS WITH `.wt-` (pattern, not a list —
//      new worktrees appear constantly and an allowlist will rot).
//   3. Any directory that CONTAINS a `.git` FILE (not directory) — a linked
//      git worktree's positive signature. The walk ROOT itself is never
//      subjected to (3), so a harness running FROM a worktree still scans it.
//
//   Symlinked directories are not followed (Dirent.isDirectory() is false
//   for a symlink-to-dir). That is the other-repo fence at the fs layer.
//
// OPTS
//   extensions     default ['.js', '.mjs', '.jsx', '.cjs']
//   extraSkipDirs  extra exact directory names for this call only
//   skipDotNames   if true, skip EVERY directory whose name starts with `.`
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
