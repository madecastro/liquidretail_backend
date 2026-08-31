'use strict';
//
// gitAudit — shared git plumbing for scripts/auditStrandedWork.js and
// scripts/cleanupMergedBranches.js.
//
// MAINTENANCE NOTE (read before editing): this file is hand-synced,
// byte-identical, between liquidretail_backend and liquidretail_adgen. It is
// NOT routed through vendor-manifest.json / verifyVendorDrift.js — that
// system hashes backend<->adgen production modules under models/services
// with a debt-tracking grace period, which does not fit a git-ops utility
// with zero Mongo/business-logic coupling. Instead: this file, plus its two
// callers (auditStrandedWork.js, cleanupMergedBranches.js), must be kept
// identical by hand. Diff them before editing either copy. See both repos'
// CLAUDE.md "Stranded-work tooling" section for the full reasoning.
//
// Everything here is read-only EXCEPT commit-tree (below), which creates a
// harmless dangling commit object (never attached to any ref) purely to ask
// `git cherry` a question. Nothing here pushes, deletes, or checks out
// anything — see cleanupMergedBranches.js for the (guarded) mutations.
//
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const UNIT_SEP = '\x1f'; // ASCII unit separator — won't collide with commit text

function runGit(repoRoot, args) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function gitOut(repoRoot, args) {
  const r = runGit(repoRoot, args);
  if (r.status !== 0) return null;
  return (r.stdout || '').replace(/\n+$/, '');
}

function isGitRepo(repoRoot) {
  const r = runGit(repoRoot, ['rev-parse', '--git-dir']);
  return r.status === 0;
}

// Resolve the trunk branch NAME (no "origin/" prefix), e.g. 'main'/'master'.
// Prefers the remote's own symbolic HEAD; falls back to probing main/master.
function resolveTrunk(repoRoot) {
  const symbolic = gitOut(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic) {
    const m = /refs\/remotes\/origin\/(.+)$/.exec(symbolic.trim());
    if (m) return m[1];
  }
  for (const name of ['main', 'master']) {
    const r = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
    if (r.status === 0) return name;
  }
  return null;
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return path.resolve(p);
  }
}

// Parse `git worktree list --porcelain` into an array of
// { path, head, branch, bare, detached, locked, lockedReason, prunable, prunableReason }.
// Blocks are separated by a blank line; each starts with "worktree <path>".
function parseWorktreePorcelain(text) {
  const blocks = text
    .split(/\n(?=worktree )/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n');
    const wt = {
      path: null,
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
    };
    for (const line of lines) {
      if (line.startsWith('worktree ')) wt.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) wt.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) {
        wt.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
      } else if (line === 'bare') wt.bare = true;
      else if (line === 'detached') wt.detached = true;
      else if (line === 'locked') wt.locked = true;
      else if (line.startsWith('locked ')) {
        wt.locked = true;
        wt.lockedReason = line.slice('locked '.length).trim() || null;
      } else if (line === 'prunable') wt.prunable = true;
      else if (line.startsWith('prunable ')) {
        wt.prunable = true;
        wt.prunableReason = line.slice('prunable '.length).trim() || null;
      }
    }
    return wt;
  });
}

function listWorktrees(repoRoot) {
  const out = gitOut(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  return parseWorktreePorcelain(out);
}

function listLocalBranches(repoRoot) {
  const out = gitOut(repoRoot, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split('\t');
      return { name, sha };
    });
}

// Bulk-detect every commit that is on SOME local branch but not reachable
// from ANY remote-tracking ref, attributed to a source branch, in ONE git
// process (not one-per-branch — this repo can have 100-300+ local branches).
//
// Mechanism: `git log --branches --not --remotes --source` walks all local
// branches, excludes anything already reachable from a remote, and tags each
// surviving commit with the ref that led rev-list to it (`--source` / `%S`).
// NOTE: `--source` is a `git log` feature, not accepted by `git rev-list`
// (confirmed empirically against git 2.50.1 — `git rev-list --source` is a
// usage error). Use `git log`, not `git rev-list`, for this query.
//
// ATTRIBUTION CAVEAT (by design, not a bug): a commit that is a shared
// ancestor of two local branches is only attributed to ONE of them — whichever
// `--source` traversal reaches it via first. A branch whose entire unpushed
// range is a strict subset of another local branch's history can therefore be
// under-counted here. This never hides the underlying finding (the commit
// still shows up, attributed to the other branch), it only means a per-branch
// histogram can slightly undercount a branch that is itself behind another
// local branch. Good enough for a reporting tool; NOT relied on for deletion
// safety anywhere (cleanupMergedBranches.js re-derives per-branch unpushed
// status directly, not from this map).
function findUnpushedCommitsBySource(repoRoot) {
  const r = runGit(repoRoot, [
    'log',
    '--branches',
    '--not',
    '--remotes',
    '--source',
    `--pretty=tformat:%H${UNIT_SEP}%S${UNIT_SEP}%aI`,
  ]);
  const map = new Map(); // branch name -> { count, oldest, newest, shas: [] }
  if (r.status !== 0) return map;
  const out = r.stdout || '';
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split(UNIT_SEP);
    if (parts.length < 3) continue;
    const [sha, sourceRef, authorDate] = parts;
    const branch = sourceRef.replace(/^refs\/heads\//, '');
    let entry = map.get(branch);
    if (!entry) {
      entry = { count: 0, oldest: authorDate, newest: authorDate, shas: [] };
      map.set(branch, entry);
    }
    entry.count += 1;
    entry.shas.push(sha);
    if (authorDate < entry.oldest) entry.oldest = authorDate;
    if (authorDate > entry.newest) entry.newest = authorDate;
  }
  return map;
}

// Exact, single-branch version of the same question (used by
// cleanupMergedBranches.js, where correctness for ONE branch at a time
// matters more than bulk speed across hundreds).
function countUnpushedCommits(repoRoot, branch) {
  const r = runGit(repoRoot, ['rev-list', '--count', branch, '--not', '--remotes']);
  if (r.status !== 0) return null;
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function isAncestorOfTrunk(repoRoot, branch, trunkRef) {
  const r = runGit(repoRoot, ['merge-base', '--is-ancestor', branch, trunkRef]);
  return r.status === 0;
}

// Squash/rebase-merge detection. A GitHub squash merge (or a rebase merge)
// never leaves the branch's own commit SHAs on trunk, even though trunk
// carries their combined content — so a plain ancestor check always says
// "not merged" for the overwhelmingly common case in these two repos (both
// use squash merges almost exclusively; see CLAUDE.md's PR-commit-message
// evidence). This is a variant of the well-known "git-delete-squashed"
// trick: synthesize a dangling commit carrying the branch's own final tree,
// then ask `git cherry` whether ITS patch already has a patch-id match
// somewhere in trunk's history.
//
// CRITICAL DETAIL, found by testing against this repo's real history, not
// assumed from the popular script: the synthetic commit's PARENT must be the
// branch/trunk MERGE-BASE, not trunk's current tip. `git cherry <upstream>
// <head>` compares the synthetic commit's own patch-id (diff from ITS
// PARENT to its tree) against every commit unique to <upstream>. Parenting
// at trunk's current tip makes that patch "everything trunk gained since
// this branch forked, in reverse, plus nothing new" once trunk has moved on
// by even one unrelated commit — which will not patch-id-match any single
// trunk commit and always reports "+" (unmerged), a false negative confirmed
// empirically here (fix/plate-scan-gemini-and-face-quorum-retry, whose tree
// is byte-identical to its own squash-merge commit 987ec51, reported
// unmerged against a trunk tip 40+ commits past that merge, and correctly
// reported merged once re-parented at the merge-base).
//
// - "- <sha>": patch-equivalent to a trunk-only commit — squash/rebase-merged.
// - "+ <sha>": a genuinely new, unmatched patch — NOT merged.
// - empty output: nothing to compare (branch tip already IS the merge-base,
//   i.e. no unique content) — treated as merged (nothing left to lose).
//
// The synthetic commit is never attached to any ref; it is a harmless
// dangling object that ordinary `git gc` reclaims on its own schedule.
function isSquashMergedIntoTrunk(repoRoot, branch, trunkRef) {
  const mbR = runGit(repoRoot, ['merge-base', branch, trunkRef]);
  if (mbR.status !== 0) return false;
  const mergeBase = mbR.stdout.trim();
  const treeR = runGit(repoRoot, ['rev-parse', `${branch}^{tree}`]);
  if (treeR.status !== 0) return false;
  const tree = treeR.stdout.trim();
  const commitR = runGit(repoRoot, [
    'commit-tree', tree, '-p', mergeBase, '-m', 'auditStrandedWork squash-merge probe (dangling, harmless)',
  ]);
  if (commitR.status !== 0) return false;
  const tempCommit = commitR.stdout.trim();
  const cherryR = runGit(repoRoot, ['cherry', trunkRef, tempCommit]);
  if (cherryR.status !== 0) return false;
  const out = (cherryR.stdout || '').trim();
  if (out === '') return true;
  return out.startsWith('-');
}

function isMergedIntoTrunk(repoRoot, branch, trunkRef) {
  if (isAncestorOfTrunk(repoRoot, branch, trunkRef)) return { merged: true, method: 'ancestor' };
  if (isSquashMergedIntoTrunk(repoRoot, branch, trunkRef)) return { merged: true, method: 'squash-equivalent' };
  return { merged: false, method: null };
}

// Status of a single worktree path (call with THAT worktree's own path as
// repoRoot — `git -C <linked-worktree-path> status` works correctly because
// every linked worktree has its own HEAD/index against the shared .git).
function statusPorcelain(repoRoot) {
  const r = runGit(repoRoot, ['status', '--porcelain=v1']);
  if (r.status !== 0) return null;
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  let modified = 0;
  let untracked = 0;
  let staged = 0;
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === '??') untracked += 1;
    else {
      modified += 1;
      if (code[0] !== ' ' && code[0] !== '?') staged += 1;
    }
  }
  return { dirty: lines.length > 0, modified, untracked, staged, total: lines.length };
}

function branchesCheckedOutSomewhere(worktrees) {
  const set = new Set();
  for (const wt of worktrees) {
    if (wt.branch) set.add(wt.branch);
  }
  return set;
}

function remoteRefExists(repoRoot, remote, branch) {
  const r = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
  return r.status === 0;
}

// Best-effort: if a worktree lock reason mentions a PID, check whether that
// process is still alive (matches the evidence case: "locked by a dead
// PID"). Not all lock reasons mention a PID — this is a heuristic, not a
// guarantee, and returns null when no PID pattern is found.
function checkLockReasonPid(reasonText) {
  if (!reasonText) return null;
  const m = /\bpid[:\s]*([0-9]+)/i.exec(reasonText);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch (e) {
    return { pid, alive: e.code !== 'ESRCH' ? null : false };
  }
}

module.exports = {
  runGit,
  gitOut,
  isGitRepo,
  resolveTrunk,
  realpathOrSelf,
  listWorktrees,
  listLocalBranches,
  findUnpushedCommitsBySource,
  countUnpushedCommits,
  isAncestorOfTrunk,
  isSquashMergedIntoTrunk,
  isMergedIntoTrunk,
  statusPorcelain,
  branchesCheckedOutSomewhere,
  remoteRefExists,
  checkLockReasonPid,
};
