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
// SAFETY REVIEW (2026-08-31, Grok grok-4.6, --effort high, adversarial):
// found and fixed real false-positive/data-loss vectors — see the specific
// function comments below for what changed and why. Two repo-wide hardening
// choices from that review live in runGit() itself:
//   - `-c color.ui=never`: an ANSI-colored `git cherry` line would defeat the
//     plain `out.startsWith('-')` check in isSquashMergedIntoTrunk (an
//     escape-code-prefixed "-" no longer starts with "-"), which fails safe
//     (missed cleanup opportunity, not data loss) but is still wrong to
//     leave dependent on the caller's terminal config.
//   - every ref-like argument (branch names, which come from real user-created
//     git refs and could in principle start with "-") is passed after a `--`
//     argument separator at the call site, not here — see
//     cleanupMergedBranches.js's git invocations.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const UNIT_SEP = '\x1f'; // ASCII unit separator — won't collide with commit text

function runGit(repoRoot, args) {
  return spawnSync('git', ['-c', 'color.ui=never', '-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function gitOut(repoRoot, args) {
  const r = runGit(repoRoot, args);
  if (r.status !== 0) return null;
  return (r.stdout || '').replace(/\n+$/, '');
}

// Fully-qualifies a local branch's short name to `refs/heads/<name>`.
// Adversarial-review hardening (Grok, 2026-08-31): every branch name this
// module handles comes from a REAL git ref (`git for-each-ref
// refs/heads/`), and git ref names ARE permitted to start with `-`
// (confirmed empirically: `git check-ref-format` accepts `refs/heads/-foo`),
// which a bare `<branch>` argument in the middle of a revision-argument list
// could then be misparsed as a flag by whatever git subcommand receives it.
// A fully-qualified `refs/heads/<name>` can never be mistaken for an option
// regardless of what `<name>` is, and git accepts it everywhere a bare
// branch name is accepted (including with a `^{tree}` suffix or a `:<path>`
// blob-at-ref suffix). Used for every revision-expression argument built
// from a branch name in this file; NOT needed for the `refs/remotes/...`
// helpers below, which are already fully-qualified by construction.
function qualifyBranchRef(branch) {
  return `refs/heads/${branch}`;
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
  const r = runGit(repoRoot, ['rev-list', '--count', qualifyBranchRef(branch), '--not', '--remotes']);
  if (r.status !== 0) return null;
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function isAncestorOfTrunk(repoRoot, branch, trunkRef) {
  const r = runGit(repoRoot, ['merge-base', '--is-ancestor', qualifyBranchRef(branch), trunkRef]);
  return r.status === 0;
}

// Squash-merge detection, TWO gates, both required. A GitHub squash merge
// never leaves the branch's own commit SHAs on trunk, even though trunk
// carries their combined content — so a plain ancestor check always says
// "not merged" for the overwhelmingly common case in these two repos (both
// use squash merges almost exclusively; see CLAUDE.md's PR-commit-message
// evidence).
//
// GATE 1 — patch-id equivalence ("was this diff ever applied to trunk").
// A variant of the well-known "git-delete-squashed" trick: synthesize a
// dangling commit carrying the branch's own final tree, then ask `git
// cherry` whether ITS patch already has a patch-id match somewhere in
// trunk's history.
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
// GATE 2 — content still reflected at trunk's CURRENT tip, not just applied
// at SOME point in trunk's history. Added after adversarial review (Grok,
// 2026-08-31) found a real false positive in gate 1 alone: `git cherry`
// patch-id-matches against ANY commit reachable from trunk, including one
// trunk has SINCE REVERTED or a value trunk independently changed AGAIN
// afterward. Reproduced: branch changes `timeout=30→60` and gets
// squash-merged; trunk later, unrelated, changes the same setting
// `60→120`. Gate 1 alone still reports "merged" (the `30→60` patch-id is
// still a real commit in trunk's history) even though trunk's CURRENT state
// no longer reflects that branch's change at all. Gate 2 closes this: every
// path the branch's diff touched (`git diff --name-only mergeBase branch`)
// must have the IDENTICAL blob (compared by content-addressed SHA via
// `rev-parse <ref>:<path>`, not text, so this is binary-safe) at the
// branch's tip and at trunk's CURRENT tip. A file that differs, or that
// exists on only one side, fails gate 2 — conservatively: this only ever
// produces a false NEGATIVE (a genuinely-merged branch not recognized as
// such, e.g. because trunk made an unrelated later edit to the same file)
// never a false positive, which is the safe direction for a function whose
// caller may go on to force-delete the branch.
//
// - Gate 1 "- <sha>": patch-equivalent to a trunk-only commit. Proceed to gate 2.
// - Gate 1 "+ <sha>": a genuinely new, unmatched patch — NOT merged, stop.
// - Gate 1 empty output: provably unreachable in practice (`git cherry`
//   prints nothing only when the synthetic commit is ALREADY an ancestor of
//   trunk, but the synthetic commit is a brand-new dangling object created
//   moments ago that could not already be embedded in trunk's history) —
//   treated as NOT merged rather than assumed-merged, since trusting an
//   unreachable-in-practice branch to mean "safe" is the wrong default if
//   the assumption is ever wrong.
//
// The synthetic commit is never attached to any ref; it is a harmless
// dangling object that ordinary `git gc` reclaims on its own schedule.
function isSquashMergedIntoTrunk(repoRoot, branch, trunkRef) {
  const mbR = runGit(repoRoot, ['merge-base', qualifyBranchRef(branch), trunkRef]);
  if (mbR.status !== 0) return false;
  const mergeBase = mbR.stdout.trim();
  const treeR = runGit(repoRoot, ['rev-parse', `${qualifyBranchRef(branch)}^{tree}`]);
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
  if (out === '' || !out.startsWith('-')) return false; // gate 1 failed (or the provably-unreachable empty case)
  return contentStillReflectedInTrunk(repoRoot, branch, trunkRef, mergeBase);
}

// Gate 2 of isSquashMergedIntoTrunk (see that function's header comment for
// WHY this exists). TWO cruder versions were tried first and rejected by
// testing against this repo's REAL history, not just reasoned about:
//
//   1. Whole-file byte identity (branch tip vs trunk tip). Rejected: any
//      file touched by a merged branch that ALSO received ANY later,
//      unrelated edit (extremely common for frequently-touched files —
//      config, a shared service, and especially this repo's own
//      auto-regenerated scripts/vendor-manifest.json, which legitimately
//      rewrites its `generatedAt` timestamp and per-file `status` fields on
//      every unrelated reconciliation) fails even though the branch's own
//      change is completely intact. Measured: this made EVERY real merged
//      branch tested report "not merged."
//   2. Per-line, both directions ("every added line present AND every
//      removed line absent"), require-100%. The "removed line reappeared"
//      half is unreliable for structured/repetitive files: a manifest's
//      short, repeated lines (`"status": "synced",`) trivially "reappear"
//      elsewhere in the same file for structural reasons that have nothing
//      to do with a revert. Measured on the same real branch: 15 removed
//      lines, 9 "reappeared" (all in vendor-manifest.json, none a genuine
//      revert) — an unusable false-mismatch rate.
//
// What actually works, measured against this repo's real history: check
// only ADDED lines (a revert of a pure deletion is a rarer, lower-stakes
// case — see below), and require a HIGH RATIO, not literally 100%, of the
// branch's significant added lines to still be present somewhere in trunk's
// CURRENT version of the same file. This tolerates the small number of
// genuinely volatile fields (a timestamp, a content hash) inside an
// otherwise-intact large change, while still reliably catching the
// adversarial scenario this gate exists for (`timeout=30→60` merged, trunk
// later independently changes `30→60→120`): a small, focused branch has few
// added lines, so losing even one of them drags the ratio well under
// threshold. Measured on a real 8-file, ~1660-added-line merged branch:
// 1658/1660 (99.9%) still present (the 2 missing were exactly a
// `generatedAt` timestamp and a content hash in the auto-regenerated
// manifest) — comfortably above THRESHOLD. Blank and very short/trivial
// lines (closing braces, lone punctuation) are excluded — they carry almost
// no information and are common enough to be noise either way.
//
// Direction of any remaining error is deliberately the safe one: this can
// under-recognize a genuine merge (false negative — branch just doesn't get
// cleaned up, no data loss) but a real revert/supersession of a small,
// focused branch's actual content still fails the ratio, so it does not
// launder a genuine false positive through.
const CONTENT_STILL_REFLECTED_THRESHOLD = 0.9;

function contentStillReflectedInTrunk(repoRoot, branch, trunkRef, mergeBase) {
  const namesR = runGit(repoRoot, ['diff', '--name-only', mergeBase, qualifyBranchRef(branch), '--']);
  if (namesR.status !== 0) return false;
  const files = namesR.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0) return true; // branch introduced no path changes at all — nothing to contradict

  const isSignificantLine = (line) => line.trim().length >= 3;

  let totalAdded = 0;
  let totalPresent = 0;

  for (const f of files) {
    const diffR = runGit(repoRoot, ['diff', mergeBase, qualifyBranchRef(branch), '--', f]);
    if (diffR.status !== 0) return false;
    const added = [];
    for (const line of diffR.stdout.split('\n')) {
      if (line.startsWith('+++')) continue;
      if (line.startsWith('+')) added.push(line.slice(1));
    }
    const significantAdded = added.filter(isSignificantLine);
    if (significantAdded.length === 0) continue; // pure deletion / whitespace-only change in this file — nothing to check here

    const trunkShowR = runGit(repoRoot, ['show', `${trunkRef}:${f}`]);
    const trunkLineSet = new Set(trunkShowR.status === 0 ? trunkShowR.stdout.split('\n') : []);

    totalAdded += significantAdded.length;
    for (const line of significantAdded) {
      if (trunkLineSet.has(line)) totalPresent += 1;
    }
  }

  if (totalAdded === 0) return true; // nothing significant was ever added by this branch (pure deletions) — gate 1 already required a real patch-id match
  return totalPresent / totalAdded >= CONTENT_STILL_REFLECTED_THRESHOLD;
}

// Current SHA of a remote-tracking branch, for lease-protected deletes
// (`git push --force-with-lease=refs/heads/<branch>:<sha> ...`). Returns
// null if the ref does not currently exist.
function remoteRefSha(repoRoot, remote, branch) {
  const r = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
  return r.status === 0 ? r.stdout.trim() : null;
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
  remoteRefSha,
  checkLockReasonPid,
};
