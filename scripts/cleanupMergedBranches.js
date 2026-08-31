#!/usr/bin/env node
'use strict';
/**
 * cleanupMergedBranches.js — the companion to auditStrandedWork.js's
 * category-5 "merged into trunk, still lingering" finding. Deletes, ONLY
 * when every safety check below passes:
 *   - the local branch
 *   - its remote counterpart (if one currently exists)
 *   - its worktree (if one currently exists)
 * then runs `git worktree prune`.
 *
 * MAINTENANCE NOTE: this file (plus scripts/lib/gitAudit.js and
 * scripts/auditStrandedWork.js) is hand-synced, byte-identical, between
 * liquidretail_backend and liquidretail_adgen — see gitAudit.js's header for
 * why this is NOT routed through vendor-manifest.json. Diff the three files
 * against the sibling repo before editing any of them.
 *
 * THIS DELETES THINGS. Safety is the entire point of this file:
 *
 *   - DRY-RUN BY DEFAULT. Nothing is deleted unless you pass --apply.
 *   - NEVER touches trunk (whatever refs/remotes/origin/HEAD resolves to,
 *     e.g. main/master) — trunk is excluded from candidacy outright.
 *   - NEVER deletes a branch that is currently checked out ANYWHERE (any
 *     worktree, including the main checkout) — checked via `git worktree
 *     list`, not by name-guessing.
 *   - NEVER deletes a branch with commits that are not reachable from ANY
 *     remote-tracking ref (checked directly per branch — not read from a
 *     stale audit report).
 *   - NEVER deletes/removes a worktree with uncommitted or untracked
 *     changes (`git status --porcelain`).
 *   - NEVER touches a LOCKED worktree — reports it instead of unlocking it
 *     for you (a `git worktree lock` is a deliberate human decision; only a
 *     human should undo it).
 *   - "Merged" is never inferred from branch name or PR title. It is either
 *     a literal `git merge-base --is-ancestor` result, or (the common case
 *     in these two repos, which use GitHub squash merges almost
 *     exclusively — see gitAudit.js's isSquashMergedIntoTrunk) a patch-id
 *     equivalence check against trunk's own history, the same mechanism
 *     the well-known "git-delete-squashed" script uses.
 *   - Anything ambiguous is SKIPPED and reported, never guessed through.
 *   - TWO-PHASE, not classify-then-blindly-trust: classifyBranch() runs
 *     once up front to decide WHAT to show/delete, but performDelete()
 *     independently calls reverifyStillSafeToDelete() — a from-scratch
 *     re-classification with freshly re-listed worktrees — immediately
 *     before touching that specific branch, and aborts if anything changed.
 *     This matters because a run over hundreds of branches can take tens of
 *     seconds, and these two repos explicitly run with multiple concurrent
 *     sessions/agents as the norm, not the exception — plenty of window for
 *     another session to check out a worktree, push new commits, or dirty a
 *     tree on a branch this run already classified minutes earlier.
 *
 * WHY `git branch -D` (force) FOR THE SQUASH CASE, NOT `-d`: git's own `-d`
 * only trusts literal ancestry (exactly the "ancestor" method above) — it
 * will refuse a squash-merged branch as "not fully merged" even though its
 * content is safely in trunk under a different commit SHA, which is exactly
 * why this tool exists instead of a bare `for b in $(git branch --merged)`
 * loop. `-D` is used ONLY after this tool has independently verified
 * squash-equivalence AND confirmed zero unpushed commits AND confirmed the
 * worktree (if any) is clean AND confirmed the branch is not checked out
 * anywhere — at that point deleting the local ref cannot lose anything git
 * itself doesn't already have reachable elsewhere (the remote copy, deleted
 * in the following step, is the one genuinely irreversible action — hence
 * the extra `remoteRefExists` gate immediately before it, and the whole
 * suite of checks that must pass before either delete runs).
 *
 * USAGE
 *   node scripts/cleanupMergedBranches.js                    dry-run, this repo
 *   node scripts/cleanupMergedBranches.js --repo=/path
 *   node scripts/cleanupMergedBranches.js --branch=foo        limit to one branch
 *   node scripts/cleanupMergedBranches.js --apply             actually delete
 *   node scripts/cleanupMergedBranches.js --no-fetch           skip the safety
 *                                                              `git fetch --prune`
 *                                                              this does by default
 *                                                              (offline/test use)
 *   node scripts/cleanupMergedBranches.js --json
 *
 * Exit code: 0 on a clean run (even if nothing was eligible); 1 if --apply
 * was passed and at least one delete FAILED after passing every safety
 * check (a git-level failure, e.g. a race). Never exits non-zero merely
 * because some branches were skipped as unsafe or not-yet-merged — that is
 * the tool working as designed, not an error.
 */

const path = require('path');
const {
  isGitRepo,
  resolveTrunk,
  listWorktrees,
  listLocalBranches,
  countUnpushedCommits,
  isMergedIntoTrunk,
  statusPorcelain,
  branchesCheckedOutSomewhere,
  remoteRefExists,
  runGit,
} = require('./lib/gitAudit');

function parseArgs(argv) {
  const opts = { repo: process.cwd(), apply: false, branch: null, fetch: true, json: false, help: false };
  for (const a of argv) {
    if (a === '--apply') opts.apply = true;
    else if (a === '--no-fetch') opts.fetch = false;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--repo=')) opts.repo = a.slice('--repo='.length);
    else if (a.startsWith('--branch=')) opts.branch = a.slice('--branch='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const REMOTE = 'origin';

function classifyBranch(repoRoot, branch, trunk, trunkRef, worktrees, checkedOutBranches) {
  const result = {
    branch,
    action: null, // 'delete' | 'skip'
    reason: null,
    mergeMethod: null,
    worktreePath: null,
    remoteExists: false,
    unpushedCount: null,
  };

  if (branch === trunk) {
    result.action = 'skip';
    result.reason = 'is trunk — never touched';
    return result;
  }

  if (checkedOutBranches.has(branch)) {
    const wt = worktrees.find((w) => w.branch === branch);
    result.action = 'skip';
    result.reason = `currently checked out${wt ? ` at ${wt.path}` : ''} — never delete a checked-out branch`;
    return result;
  }

  const wt = worktrees.find((w) => w.branch === branch) || null;
  if (wt) {
    result.worktreePath = wt.path;
    if (wt.locked) {
      result.action = 'skip';
      result.reason = `worktree is LOCKED (${wt.lockedReason || 'no reason recorded'}) — inspect and unlock manually if appropriate, never auto-unlocked here`;
      return result;
    }
  }

  const mergeInfo = isMergedIntoTrunk(repoRoot, branch, trunkRef);
  if (!mergeInfo.merged) {
    result.action = 'skip';
    result.reason = 'not merged into trunk (neither a literal ancestor nor squash-equivalent) — leaving alone';
    return result;
  }
  result.mergeMethod = mergeInfo.method;

  const unpushed = countUnpushedCommits(repoRoot, branch);
  result.unpushedCount = unpushed;
  if (unpushed === null) {
    result.action = 'skip';
    result.reason = 'could not determine unpushed-commit count (git error) — refusing to guess';
    return result;
  }
  if (unpushed > 0) {
    result.action = 'skip';
    result.reason = `has ${unpushed} commit(s) not reachable from ANY remote — refusing to delete unpushed work`;
    return result;
  }

  if (wt) {
    const status = statusPorcelain(wt.path);
    if (!status) {
      result.action = 'skip';
      result.reason = `could not read worktree status at ${wt.path} — refusing to guess`;
      return result;
    }
    if (status.dirty) {
      result.action = 'skip';
      result.reason = `worktree at ${wt.path} has uncommitted/untracked changes (modified=${status.modified} untracked=${status.untracked}) — refusing to delete`;
      return result;
    }
  }

  result.remoteExists = remoteRefExists(repoRoot, REMOTE, branch);
  result.action = 'delete';
  result.reason = `merged into trunk via ${mergeInfo.method}, no unpushed commits, worktree clean (or none), not checked out, not locked`;
  return result;
}

// Re-runs classifyBranch() from scratch, with FRESHLY re-listed worktrees,
// immediately before acting on a single branch. Guards the TOCTOU window
// between the up-front classification pass (which can take tens of seconds
// across hundreds of branches — plenty of time for another session to check
// out a worktree, push new commits, or dirty a tree in the interim, and this
// task's own brief warns that concurrent sessions are the norm here, not the
// exception) and the moment this specific branch is actually deleted. Cheap
// insurance: a handful of extra git calls per branch actually being deleted,
// never per branch merely being reported.
function reverifyStillSafeToDelete(repoRoot, item, trunk, trunkRef) {
  const freshWorktrees = listWorktrees(repoRoot);
  const freshCheckedOut = branchesCheckedOutSomewhere(freshWorktrees);
  const fresh = classifyBranch(repoRoot, item.branch, trunk, trunkRef, freshWorktrees, freshCheckedOut);
  if (fresh.action !== 'delete') {
    return { ok: false, reason: `re-check at delete-time now says: ${fresh.reason}` };
  }
  if (fresh.mergeMethod !== item.mergeMethod || fresh.worktreePath !== item.worktreePath) {
    return {
      ok: false,
      reason: `re-check at delete-time disagrees with the earlier classification (method ${item.mergeMethod}->${fresh.mergeMethod}, worktree ${item.worktreePath}->${fresh.worktreePath}) — refusing to guess which is right`,
    };
  }
  return { ok: true, fresh };
}

function performDelete(repoRoot, item, trunk, trunkRef, log) {
  const outcome = { branch: item.branch, steps: [], ok: true };

  const recheck = reverifyStillSafeToDelete(repoRoot, item, trunk, trunkRef);
  if (!recheck.ok) {
    outcome.ok = false;
    outcome.steps.push(`ABORTED — ${recheck.reason}`);
    log(`  ${item.branch}: ${outcome.steps[outcome.steps.length - 1]}`);
    return outcome;
  }

  if (item.worktreePath) {
    const r = runGit(repoRoot, ['worktree', 'remove', item.worktreePath]);
    if (r.status === 0) {
      outcome.steps.push(`removed worktree ${item.worktreePath}`);
    } else {
      outcome.ok = false;
      outcome.steps.push(`FAILED to remove worktree ${item.worktreePath}: ${(r.stderr || '').trim()}`);
      log(`  ${item.branch}: ${outcome.steps[outcome.steps.length - 1]}`);
      return outcome; // don't proceed to branch delete if the worktree removal failed
    }
  }

  const deleteFlag = item.mergeMethod === 'ancestor' ? '-d' : '-D';
  const branchDel = runGit(repoRoot, ['branch', deleteFlag, item.branch]);
  if (branchDel.status === 0) {
    outcome.steps.push(`deleted local branch (git branch ${deleteFlag})`);
  } else {
    outcome.ok = false;
    outcome.steps.push(`FAILED to delete local branch: ${(branchDel.stderr || '').trim()}`);
  }

  if (item.remoteExists) {
    const remoteDel = runGit(repoRoot, ['push', REMOTE, '--delete', item.branch]);
    if (remoteDel.status === 0) {
      outcome.steps.push(`deleted remote branch ${REMOTE}/${item.branch}`);
    } else {
      outcome.ok = false;
      outcome.steps.push(`FAILED to delete remote branch: ${(remoteDel.stderr || '').trim()}`);
    }
  }

  for (const s of outcome.steps) log(`  ${item.branch}: ${s}`);
  return outcome;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 60).join('\n'));
    process.exit(0);
  }

  const repoRoot = path.resolve(opts.repo);
  if (!isGitRepo(repoRoot)) {
    console.error(`cleanupMergedBranches: ${repoRoot} does not look like a git repository`);
    process.exit(2);
  }

  if (opts.fetch) {
    console.log(`Fetching ${REMOTE} (--prune) for an up-to-date view before classifying anything...`);
    const f = runGit(repoRoot, ['fetch', REMOTE, '--prune']);
    if (f.status !== 0) {
      console.error(`cleanupMergedBranches: git fetch failed, continuing with possibly-stale remote-tracking refs:\n${(f.stderr || '').trim()}`);
    }
  }

  const trunk = resolveTrunk(repoRoot);
  if (!trunk) {
    console.error('cleanupMergedBranches: could not resolve a trunk branch (no origin/main or origin/master) — refusing to run.');
    process.exit(2);
  }
  const trunkRef = `${REMOTE}/${trunk}`;

  const worktrees = listWorktrees(repoRoot);
  const checkedOutBranches = branchesCheckedOutSomewhere(worktrees);

  let branchNames;
  if (opts.branch) {
    branchNames = [opts.branch];
  } else {
    branchNames = listLocalBranches(repoRoot).map((b) => b.name);
  }

  const results = branchNames.map((b) => classifyBranch(repoRoot, b, trunk, trunkRef, worktrees, checkedOutBranches));

  const toDelete = results.filter((r) => r.action === 'delete');
  const toSkip = results.filter((r) => r.action === 'skip');

  if (opts.json) {
    console.log(JSON.stringify({ repoRoot, trunk, apply: opts.apply, results }, null, 2));
  } else {
    console.log(`cleanupMergedBranches — ${repoRoot}  trunk=${trunk}  mode=${opts.apply ? 'APPLY (deleting)' : 'dry-run (nothing will be deleted)'}`);
    console.log('');
    console.log(`Eligible for deletion — ${toDelete.length}`);
    for (const r of toDelete) {
      console.log(`  ${r.branch}  (merged via ${r.mergeMethod}${r.worktreePath ? `, worktree ${r.worktreePath}` : ', no worktree'}${r.remoteExists ? `, remote ${REMOTE}/${r.branch} will also be deleted` : ', no remote copy to delete'})`);
    }
    console.log('');
    console.log(`Skipped — ${toSkip.length}`);
    for (const r of toSkip) {
      console.log(`  ${r.branch}: ${r.reason}`);
    }
    console.log('');
  }

  let failures = 0;
  if (opts.apply && toDelete.length) {
    console.log(`Applying ${toDelete.length} deletion(s)...`);
    for (const item of toDelete) {
      const outcome = performDelete(repoRoot, item, trunk, trunkRef, (line) => console.log(line));
      if (!outcome.ok) failures += 1;
    }
    const pruneR = runGit(repoRoot, ['worktree', 'prune', '-v']);
    if (pruneR.stdout) console.log(pruneR.stdout.trim());
  } else if (!opts.apply && toDelete.length) {
    console.log('Dry-run only — re-run with --apply to actually delete the above.');
  }

  process.exit(failures > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { classifyBranch, performDelete, reverifyStillSafeToDelete };
