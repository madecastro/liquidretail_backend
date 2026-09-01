#!/usr/bin/env node
'use strict';
/**
 * verifyCleanupMergedBranchesSafety.js — pins the safety properties of
 * scripts/cleanupMergedBranches.js against a REAL, disposable fixture repo
 * (a bare "origin" + a working clone under os.tmpdir(), built and torn down
 * by this script itself — never touches this repo or its history).
 *
 * WHY THIS EXISTS: an adversarial review (Grok, grok-4.6, --effort high,
 * 2026-08-31) found and this repo fixed several real data-loss/false-
 * positive bugs in the cleanup tool during development (see git history /
 * CLAUDE.md's "Stranded-work tooling" section for the incident list). That
 * review's own top-line note: "nothing in `npm test` pins the P0/P1 cases
 * [found]. A later edit can reopen them silently." This harness closes that
 * gap — every check below reproduces one specific finding from that review
 * (or an earlier one from this file's own development) and asserts the fix
 * holds, not just that the code runs.
 *
 * MAINTENANCE NOTE: unlike scripts/lib/gitAudit.js and its two callers, this
 * harness is NOT required to be byte-identical between liquidretail_backend
 * and liquidretail_adgen (both DO carry a copy, since both carry the code it
 * pins) — feel free to add a repo-specific check to one copy without the
 * other, though keeping them in sync is still the default expectation.
 *
 * Entirely offline and self-contained: no network, no GitHub, no `gh`. Every
 * fixture repo/worktree/temp directory this script creates is removed again
 * before exit, success or failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { classifyBranch, performDelete } = require('./cleanupMergedBranches');
const gitAudit = require('./lib/gitAudit');

const GIT_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });

function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------------------------------------------------------------------
// Fixture: one bare "origin" + one working clone, main branch seeded.
// Individual checks build additional branches/commits on top as needed.
// ---------------------------------------------------------------------
let root;
let originDir;
let workDir;

function freshFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyCleanupSafety-'));
  originDir = path.join(root, 'origin.git');
  workDir = path.join(root, 'work');
  sh(root, ['init', '--bare', '-q', originDir]);
  sh(root, ['clone', '-q', originDir, workDir]);
  writeFile(workDir, 'README.md', 'hello\n');
  sh(workDir, ['-C', workDir, 'add', 'README.md']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'init']);
  sh(workDir, ['-C', workDir, 'branch', '-M', 'main']);
  sh(workDir, ['-C', workDir, 'push', '-q', '-u', 'origin', 'main']);
}

function teardownFixture() {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    // best-effort; a leftover temp dir is not a test failure
  }
}

// Squash-merges `branchName`'s single commit onto main via --squash, so the
// branch's own commit SHA never lands on trunk (mirrors GitHub's squash
// merge) but its tree content does.
function squashMergeOntoMain(branchName, commitMsg) {
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);
  sh(workDir, ['-C', workDir, 'merge', '-q', '--squash', branchName]);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', commitMsg]);
  sh(workDir, ['-C', workDir, 'push', '-q', 'origin', 'main']);
}

// ---------------------------------------------------------------------
// A. Unpushed branch is refused.
// ---------------------------------------------------------------------
check('A: unpushed-anywhere branch is refused (plain case: not merged at all)', () => {
  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/unpushed', 'main']);
  writeFile(workDir, 'a.txt', 'A\n');
  sh(workDir, ['-C', workDir, 'add', 'a.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'feat A (never pushed)']);
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);

  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const result = classifyBranch(workDir, 'feature/unpushed', 'main', 'origin/main', worktrees, checkedOut);
  // This branch was never merged anywhere either, so classifyBranch's
  // merge-check (which runs before its unpushed-count check) is what fires
  // first — also a correct refusal, just a different reason than A2 below.
  if (result.action !== 'skip' || !/not merged into trunk/.test(result.reason)) {
    throw new Error(`expected skip/not-merged, got ${JSON.stringify(result)}`);
  }
});

check('A2: unpushed-anywhere branch is refused even when its CONTENT is separately merged', () => {
  // A branch whose commits were never pushed to its own remote counterpart,
  // but whose net content is ALSO squash-merged into trunk (e.g. because
  // the work was copied into a different PR branch that got merged instead)
  // must still be refused — the merge check alone is not sufficient
  // "safe to delete" evidence per this tool's explicit design (see
  // cleanupMergedBranches.js's header: unpushed=0 is required unconditionally,
  // not only as a fallback for the ancestor case).
  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/unpushed-but-merged', 'main']);
  writeFile(workDir, 'a2.txt', 'A2\n');
  sh(workDir, ['-C', workDir, 'add', 'a2.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'feat A2 (never pushed anywhere)']);
  // Deliberately NOT pushed. Its exact content lands on main a different
  // way (cherry-pick), simulating "this work got merged via a different
  // branch" while feature/unpushed-but-merged itself stays local-only.
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);
  // -x appends "(cherry picked from commit ...)" to the message, guaranteeing
  // a genuinely different commit SHA from the original even if author/
  // committer identity and timestamp happen to coincide (they can, when a
  // fast-running local test performs both commits within the same second)
  // — the point of this check is a squash-equivalent (same content, real
  // commit-tree TREE match, different SHA), not an accidental byte-for-byte
  // duplicate landing on the exact same object.
  sh(workDir, ['-C', workDir, 'cherry-pick', '-x', 'feature/unpushed-but-merged']);
  sh(workDir, ['-C', workDir, 'push', '-q', 'origin', 'main']);

  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const result = classifyBranch(workDir, 'feature/unpushed-but-merged', 'main', 'origin/main', worktrees, checkedOut);
  if (result.action !== 'skip' || !/not reachable from ANY remote/.test(result.reason)) {
    throw new Error(`expected skip/unpushed (despite merged content), got ${JSON.stringify(result)}`);
  }
});

// ---------------------------------------------------------------------
// B/C. Dirty-worktree branch is refused — both via the CLI-level
// "checked out anywhere" gate, and (unit-tested in isolation, since the
// checked-out gate normally pre-empts it) the standalone dirty check.
// ---------------------------------------------------------------------
check('B: dirty-worktree branch refused via the checked-out-anywhere gate', () => {
  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/dirty', 'main']);
  writeFile(workDir, 'c.txt', 'C\n');
  sh(workDir, ['-C', workDir, 'add', 'c.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'feat C']);
  sh(workDir, ['-C', workDir, 'push', '-q', '-u', 'origin', 'feature/dirty']);
  squashMergeOntoMain('feature/dirty', 'feat C (#2)');

  const wtPath = path.join(root, 'wt-dirty');
  sh(workDir, ['-C', workDir, 'worktree', 'add', '-q', wtPath, 'feature/dirty']);
  writeFile(wtPath, 'scratch.txt', 'uncommitted\n');

  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const result = classifyBranch(workDir, 'feature/dirty', 'main', 'origin/main', worktrees, checkedOut);
  if (result.action !== 'skip' || !/currently checked out/.test(result.reason)) {
    throw new Error(`expected skip/checked-out, got ${JSON.stringify(result)}`);
  }
});

check('C: dirty-worktree check independently refuses when reached (isolated from the checked-out gate)', () => {
  const worktrees = gitAudit.listWorktrees(workDir);
  const result = classifyBranch(workDir, 'feature/dirty', 'main', 'origin/main', worktrees, new Set());
  if (result.action !== 'skip' || !/uncommitted\/untracked changes/.test(result.reason)) {
    throw new Error(`expected skip/dirty, got ${JSON.stringify(result)}`);
  }
  // clean up the worktree now that both B and C have used it
  sh(workDir, ['-C', workDir, 'worktree', 'remove', '--force', path.join(root, 'wt-dirty')]);
});

// ---------------------------------------------------------------------
// D. Trunk is never a candidate.
// ---------------------------------------------------------------------
check('D: trunk is never classified for deletion', () => {
  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const result = classifyBranch(workDir, 'main', 'main', 'origin/main', worktrees, checkedOut);
  if (result.action !== 'skip' || !/is trunk/.test(result.reason)) {
    throw new Error(`expected skip/trunk, got ${JSON.stringify(result)}`);
  }
});

// ---------------------------------------------------------------------
// E. Happy path: a genuinely squash-merged, clean, not-checked-out branch
// gets deleted end to end (local + remote) via --apply.
// ---------------------------------------------------------------------
check('E: a genuinely safe branch is deleted end-to-end (local + remote)', () => {
  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/safe', 'main']);
  writeFile(workDir, 'e.txt', 'E\n');
  sh(workDir, ['-C', workDir, 'add', 'e.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'feat E']);
  sh(workDir, ['-C', workDir, 'push', '-q', '-u', 'origin', 'feature/safe']);
  squashMergeOntoMain('feature/safe', 'feat E (#3)');
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);

  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const item = classifyBranch(workDir, 'feature/safe', 'main', 'origin/main', worktrees, checkedOut);
  if (item.action !== 'delete') throw new Error(`expected delete, got ${JSON.stringify(item)}`);

  const outcome = performDelete(workDir, item, 'main', 'origin/main', () => {});
  if (!outcome.ok) throw new Error(`performDelete failed: ${JSON.stringify(outcome)}`);

  const localExists = spawnSync('git', ['-C', workDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/safe']).status === 0;
  const remoteExists = spawnSync('git', ['-C', workDir, 'ls-remote', '--exit-code', 'origin', 'refs/heads/feature/safe']).status === 0;
  if (localExists) throw new Error('local branch still exists after apply');
  if (remoteExists) throw new Error('remote branch still exists after apply');
});

// ---------------------------------------------------------------------
// F. TOCTOU: classify, then mutate (new commit lands on the branch out of
// band), then performDelete with the STALE item — must abort, branch intact.
// ---------------------------------------------------------------------
check('F: performDelete aborts if the branch changed since classification (TOCTOU)', () => {
  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/race', 'main']);
  writeFile(workDir, 'f.txt', 'F\n');
  sh(workDir, ['-C', workDir, 'add', 'f.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'feat F']);
  sh(workDir, ['-C', workDir, 'push', '-q', '-u', 'origin', 'feature/race']);
  squashMergeOntoMain('feature/race', 'feat F (#4)');
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);

  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const item = classifyBranch(workDir, 'feature/race', 'main', 'origin/main', worktrees, checkedOut);
  if (item.action !== 'delete') throw new Error(`expected delete before the race, got ${JSON.stringify(item)}`);

  // Simulate a concurrent session committing new, unpushed work onto the
  // same branch AFTER classification but BEFORE this stale `item` is acted on.
  const raceWt = path.join(root, 'wt-race');
  sh(workDir, ['-C', workDir, 'worktree', 'add', '-q', raceWt, 'feature/race']);
  writeFile(raceWt, 'race.txt', 'race\n');
  sh(raceWt, ['-C', raceWt, 'add', 'race.txt']);
  sh(raceWt, ['-C', raceWt, 'commit', '-q', '-m', 'race: new unpushed commit']);
  sh(workDir, ['-C', workDir, 'worktree', 'remove', '--force', raceWt]);

  const outcome = performDelete(workDir, item, 'main', 'origin/main', () => {});
  if (outcome.ok !== false || !/ABORTED/.test(outcome.steps[0])) {
    throw new Error(`expected an aborted delete, got ${JSON.stringify(outcome)}`);
  }
  const stillExists = spawnSync('git', ['-C', workDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/race']).status === 0;
  if (!stillExists) throw new Error('branch was deleted despite the race — TOCTOU guard did not hold');
});

// ---------------------------------------------------------------------
// G. Remote moved: a second clone pushes a NEW commit to the same-named
// remote branch after our fetch/classify. The lease-protected delete must
// refuse, and that new commit must survive.
// ---------------------------------------------------------------------
check('G: lease-protected remote delete refuses when the remote branch has moved', () => {
  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/remote-race', 'main']);
  writeFile(workDir, 'g.txt', 'G\n');
  sh(workDir, ['-C', workDir, 'add', 'g.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'feat G']);
  sh(workDir, ['-C', workDir, 'push', '-q', '-u', 'origin', 'feature/remote-race']);
  squashMergeOntoMain('feature/remote-race', 'feat G (#5)');
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);

  const worktrees = gitAudit.listWorktrees(workDir);
  const checkedOut = gitAudit.branchesCheckedOutSomewhere(worktrees);
  const item = classifyBranch(workDir, 'feature/remote-race', 'main', 'origin/main', worktrees, checkedOut);
  if (item.action !== 'delete') throw new Error(`expected delete before the race, got ${JSON.stringify(item)}`);

  // A second clone pushes a genuinely new, unique commit to the SAME remote
  // branch name — simulating a teammate/another machine — after our own
  // classify pass observed it, but before performDelete acts.
  const secondClone = path.join(root, 'work2');
  sh(root, ['clone', '-q', originDir, secondClone]);
  sh(secondClone, ['-C', secondClone, 'checkout', '-q', 'feature/remote-race']);
  writeFile(secondClone, 'unique-from-teammate.txt', 'do not lose me\n');
  sh(secondClone, ['-C', secondClone, 'add', 'unique-from-teammate.txt']);
  sh(secondClone, ['-C', secondClone, 'commit', '-q', '-m', 'teammate: unique new commit on the remote branch']);
  sh(secondClone, ['-C', secondClone, 'push', '-q', 'origin', 'feature/remote-race']);
  const teammateSha = sh(secondClone, ['-C', secondClone, 'rev-parse', 'HEAD']);

  // Our local `workDir` has NOT re-fetched, so its own classify-time view of
  // origin/feature/remote-race is stale on purpose — this is the exact
  // window performDelete's lease must protect.
  const outcome = performDelete(workDir, item, 'main', 'origin/main', () => {});
  // `cwd` is load-bearing, not cosmetic: without it this spawnSync inherits
  // the test RUNNER's own cwd, and `git ls-remote <path>` still needs to
  // resolve an enclosing repository to run at all. Caught during development
  // by running this harness from a copied linked-worktree checkout (a stale
  // `.git` worktree pointer at that inherited cwd made every git invocation
  // fail with "fatal: not a git repository", producing a false failure here
  // that had nothing to do with cleanupMergedBranches.js itself).
  const remoteStillHasTeammateCommit = spawnSync(
    'git', ['ls-remote', originDir, 'refs/heads/feature/remote-race'], { encoding: 'utf8', cwd: originDir },
  ).stdout.includes(teammateSha);

  if (!remoteStillHasTeammateCommit) {
    throw new Error('the teammate\'s unique commit was destroyed by the remote delete — lease protection failed');
  }
  // The local branch WILL have been deleted (that part is genuinely safe —
  // it existed on the remote at classify time and the remote copy is only
  // now refused specifically because it moved) but the remote ref, and the
  // unique commit on it, must survive.
  const anyRemoteDeleteStepFailed = outcome.steps.some((s) => /FAILED to delete remote branch/.test(s));
  if (!anyRemoteDeleteStepFailed) {
    throw new Error(`expected the remote delete step to report a lease failure; steps were: ${JSON.stringify(outcome.steps)}`);
  }
});

// ---------------------------------------------------------------------
// H. Revert/supersede false positive (the adversarial review's core P1
// finding on the squash detector itself): branch changes a value, gets
// squash-merged, then trunk INDEPENDENTLY changes the same value again
// afterward. isMergedIntoTrunk must say NOT merged (gate 1's patch-id match
// alone would incorrectly say merged — that is exactly gate 2's job).
// ---------------------------------------------------------------------
check('H: squash-merge detector rejects a since-superseded change (not a real duplicate of trunk history)', () => {
  writeFile(workDir, 'config.txt', 'line1\ntimeout=30\nline3\n');
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);
  sh(workDir, ['-C', workDir, 'add', 'config.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'add config']);
  sh(workDir, ['-C', workDir, 'push', '-q', 'origin', 'main']);

  sh(workDir, ['-C', workDir, 'checkout', '-q', '-b', 'feature/bump-timeout', 'main']);
  writeFile(workDir, 'config.txt', 'line1\ntimeout=60\nline3\n');
  sh(workDir, ['-C', workDir, 'add', 'config.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'bump timeout to 60']);
  sh(workDir, ['-C', workDir, 'push', '-q', '-u', 'origin', 'feature/bump-timeout']);
  squashMergeOntoMain('feature/bump-timeout', 'bump timeout to 60 (#6)');

  // Trunk independently changes the SAME setting again, unrelated to the branch.
  writeFile(workDir, 'config.txt', 'line1\ntimeout=120\nline3\n');
  sh(workDir, ['-C', workDir, 'add', 'config.txt']);
  sh(workDir, ['-C', workDir, 'commit', '-q', '-m', 'unrelated: bump timeout further to 120']);
  sh(workDir, ['-C', workDir, 'push', '-q', 'origin', 'main']);
  sh(workDir, ['-C', workDir, 'checkout', '-q', 'main']);

  const result = gitAudit.isMergedIntoTrunk(workDir, 'feature/bump-timeout', 'origin/main');
  if (result.merged) {
    throw new Error(`expected NOT merged (superseded), got ${JSON.stringify(result)}`);
  }
});

// ---------------------------------------------------------------------
// I. Structural pin: local-delete failure must gate remote delete. A live
// repro of the exact race (branch -D fails for a transient reason AFTER
// reverifyStillSafeToDelete's fresh re-check already passed) is not
// deterministically constructible without mocking git itself, so this is a
// structural check on the source, in the same spirit as this repo's other
// structural invariants (e.g. verifyRendererVideoMoneyInvariants.js) —
// it asserts the code SHAPE that makes the property true, not just that one
// example run happened to behave.
// ---------------------------------------------------------------------
check('I (structural): performDelete returns immediately on local-delete failure, before any remote-delete code', () => {
  const src = fs.readFileSync(path.join(__dirname, 'cleanupMergedBranches.js'), 'utf8');
  const branchDelIdx = src.indexOf("runGit(repoRoot, ['branch', deleteFlag");
  const remoteDelIdx = src.indexOf('force-with-lease=refs/heads/');
  if (branchDelIdx === -1 || remoteDelIdx === -1) {
    throw new Error('could not locate the local-branch-delete or remote-delete call sites to check their ordering');
  }
  if (!(branchDelIdx < remoteDelIdx)) {
    throw new Error('local branch delete no longer precedes the remote delete call in source order');
  }
  const between = src.slice(branchDelIdx, remoteDelIdx);
  if (!/return outcome/.test(between)) {
    throw new Error('did not find an early `return outcome` guarding branchDel failure before the remote-delete code');
  }
  if (!/branchDel\.status === 0/.test(between)) {
    throw new Error('expected branchDel success to be checked before the remote-delete code');
  }
});

// ---------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------
function main() {
  freshFixture();
  let passed = 0;
  const failures = [];
  try {
    for (const { name, fn } of checks) {
      try {
        fn();
        console.log(`  ✓ ${name}`);
        passed += 1;
      } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`      ${(err && err.message) || err}`);
        failures.push(name);
      }
    }
  } finally {
    teardownFixture();
  }

  console.log('');
  console.log(`verifyCleanupMergedBranchesSafety: ${passed}/${checks.length} passed`);
  if (failures.length) {
    console.log(`FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { checks };
