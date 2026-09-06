#!/usr/bin/env node
'use strict';
/**
 * auditStrandedWork.js — surfaces git/filesystem-level "this work could
 * vanish and nobody would notice" risk: branches whose commits exist on NO
 * remote, worktrees with uncommitted work, and worktrees nested where the
 * documented rule in this repo's CLAUDE.md says they must never be.
 *
 * MAINTENANCE NOTE: this file (plus scripts/lib/gitAudit.js and
 * scripts/cleanupMergedBranches.js) is hand-synced, byte-identical, between
 * liquidretail_backend and liquidretail_adgen. It is deliberately NOT routed
 * through vendor-manifest.json/verifyVendorDrift.js — see the header comment
 * in scripts/lib/gitAudit.js for why. Diff the three files against the
 * sibling repo before editing any of them.
 *
 * WHY THIS EXISTS (all three from one real night, see both repos' CLAUDE.md
 * "Stranded-work tooling" section for the full incident writeups):
 *   1. A branch sat 5 days with 9 commits NEVER pushed to any remote,
 *      inside a nested worktree locked by a dead PID. Nearly lost a live
 *      production bug fix.
 *   2. A running agent accumulated ~52KB across 6 files with ZERO commits,
 *      then ended its turn — recovered only because someone noticed the
 *      dirty tree.
 *   3. A worktree nested INSIDE the repo directory (against this repo's own
 *      documented rule) sat unnoticed — the exact hazard class that has
 *      already turned a MONEY verify harness red with false positives here.
 *
 * WHAT THIS CHECKS (git/filesystem only — no GitHub API, no network needed):
 *   1. Local branches with commits reachable from NO remote-tracking ref.
 *      Classified further: a branch whose content is already safely inside
 *      trunk under a different commit SHA (the normal outcome of a GitHub
 *      squash-merge — see gitAudit.js's isSquashMergedIntoTrunk) is NOT a
 *      risk and is reported as "mergedLingering" (category 5) instead.
 *   2. Any worktree (including the main checkout) with uncommitted or
 *      untracked changes.
 *   3. Any worktree whose path is nested inside this repo's own directory —
 *      the documented, repeatedly-violated rule in this repo's CLAUDE.md.
 *   4. Worktrees git itself reports as prunable (path deleted, gitdir
 *      broken, etc).
 *   5. Local branches already merged into trunk (by real merge OR detected
 *      squash-equivalence) whose branch/worktree still lingers — pure
 *      cleanup fodder, see cleanupMergedBranches.js.
 *
 * A worktree lock is reported separately (not itself a risk category) but
 * flagged prominently, because case 1 above was a genuinely at-risk branch
 * HIDDEN behind a stale lock from a process that no longer existed. When a
 * lock's reason text names a PID, this checks whether that PID is still
 * alive (best-effort — not every lock reason names one).
 *
 * NOT DONE HERE, ON PURPOSE:
 *   - No GitHub/PR-API cross-reference. liquidretail_backend already has
 *     that (scripts/findOrphanedBranches.js, gh-CLI based) — complementary,
 *     not superseded: that tool answers "does a PR exist for this branch
 *     name," this one answers "does this branch/worktree exist safely
 *     ANYWHERE outside this one disk," entirely offline.
 *   - No age-threshold suppression on uncommitted changes (unlike backend's
 *     scripts/findStaleUncommittedWork.js, which only flags diffs older than
 *     a threshold). This tool's job is "what would vanish if this disk
 *     died," which does not get less true the moment a file was edited —
 *     age-based tuning belongs to a nagging/reminder tool, not a stranding
 *     audit. If this is noisy for you, that is what --fast + the SessionEnd
 *     --hook mode's terse one-liner are for, not a suppression threshold.
 *   - No mutation, ever. This script only reads. See cleanupMergedBranches.js
 *     for the (default-dry-run, explicitly-gated) companion that deletes.
 *
 * USAGE
 *   node scripts/auditStrandedWork.js                 this repo, full report
 *   node scripts/auditStrandedWork.js --repo=/path     a different checkout
 *   node scripts/auditStrandedWork.js --json           machine-readable
 *   node scripts/auditStrandedWork.js --fast           skip the full-branch-list
 *                                                       merged-lingering (category
 *                                                       5) scan — much faster on a
 *                                                       repo with hundreds of local
 *                                                       branches, at the cost of
 *                                                       under-reporting cleanup
 *                                                       fodder. Categories 1-3 are
 *                                                       computed in full either way.
 *   node scripts/auditStrandedWork.js --hook           SessionEnd-hook mode: implies
 *                                                       --fast, NEVER throws, ALWAYS
 *                                                       exits 0, and prints exactly
 *                                                       one line of
 *                                                       {"systemMessage": "..."} —
 *                                                       see the committed
 *                                                       .claude/hooks/session-end-audit.sh
 *                                                       wrapper for how this is wired.
 *
 * EXIT CODE (non --hook): 1 if anything in categories 1-3 (genuinely at
 * risk) was found; 0 if only categories 4-5 (tidiness) or nothing was found.
 * This is deliberate so it can gate something later without crying wolf over
 * ordinary end-of-session dirty state that is merely tidiness, not risk —
 * except category 2 (dirty worktrees) IS risk by design (see evidence case
 * 2): uncommitted work is one `rm -rf`/disk failure away from gone.
 * --hook mode always exits 0 (a hook must never fail a session).
 */

const fs = require('fs');
const path = require('path');
const {
  isGitRepo,
  resolveTrunk,
  realpathOrSelf,
  listWorktrees,
  listLocalBranches,
  findUnpushedCommitsBySource,
  isMergedIntoTrunk,
  statusPorcelain,
  branchesCheckedOutSomewhere,
  checkLockReasonPid,
} = require('./lib/gitAudit');

function parseArgs(argv) {
  const opts = { repo: process.cwd(), json: false, hook: false, fast: false, help: false };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--hook') { opts.hook = true; opts.fast = true; }
    else if (a === '--fast') opts.fast = true;
    else if (a.startsWith('--repo=')) opts.repo = a.slice('--repo='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function buildReport(repoRootIn, { fast = false } = {}) {
  const repoRoot = path.resolve(repoRootIn);
  if (!isGitRepo(repoRoot)) {
    throw new Error(`${repoRoot} does not look like a git repository (or git is not on PATH)`);
  }

  const trunk = resolveTrunk(repoRoot);
  const trunkRef = trunk ? `origin/${trunk}` : null;
  const worktrees = listWorktrees(repoRoot);
  // git worktree list always lists the main (original) worktree first.
  const mainEntry = worktrees.find((w) => !w.bare) || worktrees[0] || null;
  const mainRoot = mainEntry ? realpathOrSelf(mainEntry.path) : realpathOrSelf(repoRoot);
  const checkedOutBranches = branchesCheckedOutSomewhere(worktrees);

  const findings = {
    unpushedBranches: [],
    dirtyWorktrees: [],
    nestedWorktrees: [],
    prunableWorktrees: [],
    lockedWorktrees: [],
    mergedLingering: [],
  };
  const warnings = [];

  if (!trunk) {
    warnings.push(
      'Could not resolve a trunk branch (no refs/remotes/origin/main or /master) — ' +
        'branch unpushed/merged classification was skipped entirely.',
    );
  }

  // ---------------- worktrees: locked / prunable / nested / dirty ----------------
  for (const wt of worktrees) {
    if (wt.bare) continue;

    if (wt.locked) {
      findings.lockedWorktrees.push({
        path: wt.path,
        branch: wt.branch || (wt.detached ? 'detached HEAD' : null),
        reason: wt.lockedReason,
        pidCheck: checkLockReasonPid(wt.lockedReason),
      });
    }

    if (wt.prunable) {
      findings.prunableWorktrees.push({ path: wt.path, branch: wt.branch, reason: wt.prunableReason });
      continue; // path is gone or broken; nothing else to check here
    }

    const exists = fs.existsSync(wt.path);
    const realPath = exists ? realpathOrSelf(wt.path) : path.resolve(wt.path);
    const isMain = realPath === mainRoot;
    const nested = !isMain && (realPath === `${mainRoot}${path.sep}` || realPath.startsWith(mainRoot + path.sep));
    if (nested) {
      findings.nestedWorktrees.push({
        path: wt.path,
        branch: wt.branch || (wt.detached ? 'detached HEAD' : null),
        locked: wt.locked,
        lockedReason: wt.lockedReason,
      });
    }

    if (exists) {
      const status = statusPorcelain(wt.path);
      if (status && status.dirty) {
        findings.dirtyWorktrees.push({
          path: wt.path,
          branch: wt.branch || (wt.detached ? `detached@${(wt.head || '').slice(0, 8)}` : null),
          modified: status.modified,
          untracked: status.untracked,
          staged: status.staged,
          isMain,
        });
      }
    }
  }

  // ---------------- branches: unpushed-anywhere / merged-lingering ----------------
  if (trunkRef) {
    const unpushedMap = findUnpushedCommitsBySource(repoRoot);
    for (const [branch, info] of unpushedMap) {
      if (branch === trunk) continue;
      const mergeInfo = isMergedIntoTrunk(repoRoot, branch, trunkRef);
      if (mergeInfo.merged) {
        findings.mergedLingering.push({
          branch,
          method: mergeInfo.method,
          formerlyUnpushedCommits: info.count,
          checkedOut: checkedOutBranches.has(branch),
        });
      } else {
        findings.unpushedBranches.push({
          branch,
          unpushedCount: info.count,
          oldest: info.oldest,
          newest: info.newest,
          checkedOut: checkedOutBranches.has(branch),
        });
      }
    }

    if (!fast) {
      // Second pass: branches with ZERO unpushed commits (fully present on
      // some remote already) that are ALSO already merged into trunk — the
      // ordinary "safe to delete, nobody ran git branch -d" case. Invisible
      // to the pass above, which only sees branches with unpushed commits.
      for (const { name: branch } of listLocalBranches(repoRoot)) {
        if (branch === trunk) continue;
        if (unpushedMap.has(branch)) continue; // already classified above
        const mergeInfo = isMergedIntoTrunk(repoRoot, branch, trunkRef);
        if (mergeInfo.merged) {
          findings.mergedLingering.push({
            branch,
            method: mergeInfo.method,
            formerlyUnpushedCommits: 0,
            checkedOut: checkedOutBranches.has(branch),
          });
        }
      }
    }
  }

  const riskyCount =
    findings.unpushedBranches.length + findings.dirtyWorktrees.length + findings.nestedWorktrees.length;
  const tidyCount = findings.prunableWorktrees.length + findings.mergedLingering.length;

  return {
    repoRoot,
    mainRoot,
    trunk,
    trunkRef,
    generatedAt: new Date().toISOString(),
    fast: !!fast,
    findings,
    warnings,
    riskyCount,
    tidyCount,
  };
}

function fmtWorktreePath(p) {
  return `'${p}'`;
}

function printHuman(report) {
  const lines = [];
  const f = report.findings;
  lines.push(`Stranded-work audit — ${report.repoRoot}`);
  lines.push(`trunk=${report.trunk || '(unresolved)'}  generated=${report.generatedAt}${report.fast ? '  (fast mode: category 5 full scan skipped)' : ''}`);
  lines.push('');

  for (const w of report.warnings) lines.push(`WARNING: ${w}`);
  if (report.warnings.length) lines.push('');

  // Category 1
  lines.push(`[1] Branches with commits on NO remote — ${f.unpushedBranches.length} found`);
  if (f.unpushedBranches.length === 0) {
    lines.push('    none');
  } else {
    for (const b of f.unpushedBranches) {
      lines.push(
        `    ${b.branch}  (${b.unpushedCount} commit${b.unpushedCount === 1 ? '' : 's'}, oldest ${b.oldest}, newest ${b.newest}${b.checkedOut ? ', currently checked out somewhere' : ''})`,
      );
      lines.push(`        AT RISK: these commits exist on this disk only. If this disk is lost, they are gone.`);
      lines.push(`        FIX:     git push -u origin ${b.branch}`);
    }
  }
  lines.push('');

  // Category 2
  lines.push(`[2] Worktrees with uncommitted/untracked changes — ${f.dirtyWorktrees.length} found`);
  if (f.dirtyWorktrees.length === 0) {
    lines.push('    none');
  } else {
    for (const w of f.dirtyWorktrees) {
      lines.push(
        `    ${fmtWorktreePath(w.path)}${w.isMain ? ' (main checkout)' : ''}  branch=${w.branch || '(none)'}  modified=${w.modified} untracked=${w.untracked} staged=${w.staged}`,
      );
      lines.push(`        AT RISK: this work exists nowhere but this working tree.`);
      lines.push(`        FIX:     cd ${fmtWorktreePath(w.path)} && git status   # then commit (git add -A && git commit) or branch it — never auto-committed for you`);
    }
  }
  lines.push('');

  // Category 3
  lines.push(`[3] Worktrees nested INSIDE this repo directory — ${f.nestedWorktrees.length} found`);
  if (f.nestedWorktrees.length === 0) {
    lines.push('    none');
  } else {
    for (const w of f.nestedWorktrees) {
      const lockNote = w.locked ? `  [LOCKED: ${w.lockedReason || 'no reason recorded'}]` : '';
      lines.push(`    ${fmtWorktreePath(w.path)}  branch=${w.branch || '(none)'}${lockNote}`);
      lines.push(`        AT RISK: violates this repo's documented worktree rule — several verify harnesses do their own`);
      lines.push(`                 fs.readdirSync walk and are not proven safe against a nested worktree (see CLAUDE.md).`);
      if (w.locked) {
        lines.push(`        FIX:     this worktree is LOCKED — do not force-move it blind. Inspect first: git worktree list --porcelain | grep -A4 ${fmtWorktreePath(w.path)}`);
      } else {
        lines.push(`        FIX:     git worktree move ${fmtWorktreePath(w.path)} '/Volumes/Sayulita/Projects/RS/.wt-<descriptive-name>'`);
      }
    }
  }
  lines.push('');

  // Category 4
  lines.push(`[4] Prunable worktrees (path gone / broken) — ${f.prunableWorktrees.length} found`);
  if (f.prunableWorktrees.length === 0) {
    lines.push('    none');
  } else {
    for (const w of f.prunableWorktrees) {
      lines.push(`    ${fmtWorktreePath(w.path)}  branch=${w.branch || '(none)'}  (${w.reason || 'prunable'})`);
    }
    lines.push(`        TIDY:    git worktree prune -v`);
  }
  lines.push('');

  // Category 5
  lines.push(`[5] Branches already merged into trunk, still lingering — ${f.mergedLingering.length} found`);
  if (f.mergedLingering.length === 0) {
    lines.push('    none' + (report.fast ? ' (fast mode — this category is under-scanned; run without --fast for the full picture)' : ''));
  } else {
    for (const b of f.mergedLingering) {
      lines.push(`    ${b.branch}  (merged via ${b.method}${b.checkedOut ? ', currently checked out somewhere' : ''})`);
    }
    lines.push(`        TIDY:    node scripts/cleanupMergedBranches.js            # dry-run preview`);
    lines.push(`                 node scripts/cleanupMergedBranches.js --apply    # actually delete, after review`);
  }
  lines.push('');

  // Locked worktrees (cross-cutting, informational)
  if (f.lockedWorktrees.length) {
    lines.push(`Locked worktrees (informational — locking can hide stranded work, see evidence in CLAUDE.md) — ${f.lockedWorktrees.length} found`);
    for (const w of f.lockedWorktrees) {
      let pidNote = '';
      if (w.pidCheck) {
        // "alive" is best-effort and can false-positive on PID reuse (a dead
        // process's PID handed to an unrelated new one) — that only ever
        // makes this UNDER-report staleness (never auto-unlocked either
        // way), so it is hedged rather than stated flatly. "dead" cannot
        // false-positive the same way (a PID that fails ESRCH is not
        // running, full stop), so that direction is stated plainly.
        pidNote = w.pidCheck.alive === true
          ? `  [reason names pid ${w.pidCheck.pid} — a process with that PID exists (could be the original, or an unrelated process that reused the PID)]`
          : w.pidCheck.alive === false
            ? `  [reason names pid ${w.pidCheck.pid} — DEAD, this lock is almost certainly stale]`
            : `  [reason names pid ${w.pidCheck.pid} — liveness unknown]`;
      }
      lines.push(`    ${fmtWorktreePath(w.path)}  branch=${w.branch || '(none)'}  reason=${w.reason || '(none recorded)'}${pidNote}`);
    }
    lines.push('        If the PID is dead: git worktree unlock <path>   then re-run this audit before removing anything.');
    lines.push('');
  }

  lines.push(`Summary: ${report.riskyCount} at-risk finding(s) [categories 1-3], ${report.tidyCount} tidiness finding(s) [categories 4-5].`);
  return lines.join('\n');
}

function buildHookSummary(report) {
  const f = report.findings;
  if (report.riskyCount === 0) {
    return `Stranded-work audit (${path.basename(report.repoRoot)}): clean — no unpushed branches, dirty worktrees, or nested worktrees.`;
  }
  const parts = [];
  if (f.unpushedBranches.length) parts.push(`${f.unpushedBranches.length} branch(es) unpushed anywhere`);
  if (f.dirtyWorktrees.length) parts.push(`${f.dirtyWorktrees.length} dirty worktree(s)`);
  if (f.nestedWorktrees.length) parts.push(`${f.nestedWorktrees.length} nested worktree(s)`);
  return `Stranded-work audit (${path.basename(report.repoRoot)}): ${parts.join(', ')}. Run \`npm run check:stranded-work\` for details.`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 90).join('\n'));
    process.exit(0);
  }

  if (opts.hook) {
    // SessionEnd-hook contract: NEVER throw, ALWAYS exit 0, print exactly one
    // line of {"systemMessage": "..."} JSON so the harness can surface it.
    try {
      const report = buildReport(opts.repo, { fast: true });
      process.stdout.write(`${JSON.stringify({ systemMessage: buildHookSummary(report) })}\n`);
    } catch (err) {
      process.stdout.write(
        `${JSON.stringify({ systemMessage: `Stranded-work audit: hook error (${(err && err.message) || err}) — see scripts/auditStrandedWork.js` })}\n`,
      );
    }
    process.exit(0);
    return;
  }

  try {
    const report = buildReport(opts.repo, { fast: opts.fast });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(printHuman(report));
    }
    process.exit(report.riskyCount > 0 ? 1 : 0);
  } catch (err) {
    console.error(`auditStrandedWork: fatal error: ${(err && err.stack) || err}`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildReport, printHuman, buildHookSummary };
