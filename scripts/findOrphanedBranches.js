#!/usr/bin/env node
/**
 * findOrphanedBranches.js — the "commit but no PR" variant of the same
 * failure mode as findStaleUncommittedWork.js: work that IS committed
 * (so `git log --all -S` would actually find it, unlike the uncommitted
 * case) but was never pushed to a PR, so nothing durable tracks it either.
 * Confirmed twice in one night: one orphan had no commit at all
 * (findStaleUncommittedWork.js's case), a second had a real commit that
 * simply never got a PR opened for it.
 *
 * WHAT THIS DOES: enumerates every local branch (this repo's git worktrees
 * all share one .git, so `git for-each-ref refs/heads` already sees every
 * branch any worktree created — no filesystem walk needed) PLUS any
 * detached-HEAD worktree (invisible to refs/heads by definition, since it
 * has no branch name — see FIX below), finds the ones with commits ahead
 * of origin/main, and cross-references GitHub in ONE batched `gh pr list`
 * call (not one API call per branch — this repo has 200+ local branches at
 * any given time) AND origin's own refs (to tell "genuinely nowhere but
 * here" apart from "already safe on the remote") to classify each into:
 *
 *   - ORPHANED     — commits ahead of origin/main, no PR record at all,
 *                     AND never pushed to origin under this name either.
 *                     This is the dangerous case: nothing anywhere else
 *                     points at this work, so a deleted worktree loses it
 *                     for good.
 *   - PUSHED_NO_PR — commits ahead of origin/main, no PR record, but a
 *                     same-named branch already exists on origin. The
 *                     commits are safe on the remote; this just needs a PR
 *                     opened, not an "is my work about to vanish" panic.
 *   - STALE        — commits ahead, but every matching PR is already
 *                     closed/merged. Usually just a local branch nobody
 *                     deleted after merging — informational, not urgent.
 *   - (skipped)    — an OPEN PR exists, or the branch has 0 commits ahead
 *                     of origin/main, or its tip is younger than
 *                     --min-age-hours (probably still being actively
 *                     worked).
 *
 * Revised 2026-08-19 — four fixes, confirmed against the failure modes
 * they were named for:
 *
 *   1. DANGEROUS FALSE POSITIVE: a branch that WAS pushed to origin (just
 *      never had a PR opened against it) used to be lumped into ORPHANED
 *      with copy implying "delete the worktree and this is gone" — but the
 *      commits are already safe on the remote. Split into ORPHANED (never
 *      pushed anywhere — genuinely at risk) vs PUSHED_NO_PR (safe on
 *      origin, just missing a PR), checked via `git for-each-ref
 *      refs/remotes/origin/`.
 *   2. Detached-HEAD worktrees were entirely invisible (this only scanned
 *      refs/heads/, which by definition excludes a detached HEAD — it has
 *      no branch ref at all). Now also walks `git worktree list
 *      --porcelain` and includes any detached HEAD as an unnamed entry,
 *      checked against `--base` the same way (can't be matched to a PR by
 *      branch name, so it's always reported unverified-against-GitHub).
 *   3. Local `main`/`master` ahead of origin with no PR were unconditionally
 *      skipped regardless of `--base`, hiding commits made directly to a
 *      local trunk branch that were never pushed at all. Now only the
 *      literal base ref itself is skipped (comparing a ref against itself
 *      is meaningless); a local main/master that has outrun origin/main is
 *      evaluated like any other branch.
 *   4. Tip age came from committer date, which a routine `git rebase`
 *      resets to "now" on every replayed commit even though nothing new
 *      happened — silently un-flagging genuinely old, forgotten work the
 *      moment someone rebases it onto main to keep it mergeable. Switched
 *      to author date, which `git rebase` preserves from the original
 *      commit (confirmed empirically: rebase updates %(committerdate) but
 *      leaves %(authordate) untouched).
 *
 * KNOWN LIMITATION: matches PRs to branches by exact head-branch name via
 * `gh pr list`. If a branch's content was landed under a DIFFERENT branch
 * name (e.g. someone cherry-picked it into a fresh PR branch), this will
 * still report the original branch as ORPHANED even though the work is
 * safely merged. Treat an ORPHANED result as "needs a human look," not
 * as proof the work is actually lost — check `git log --all --grep`/
 * `git branch --contains` before assuming.
 *
 * Requires `gh` (GitHub CLI), authenticated. Falls back to reporting
 * commits-ahead-only, clearly labeled as unverified against GitHub, if
 * `gh` is missing or the API call fails — never silently drops the
 * commits-ahead signal just because the PR check couldn't run.
 *
 * USAGE
 *   node scripts/findOrphanedBranches.js
 *   node scripts/findOrphanedBranches.js --repo=/path/to/checkout
 *   node scripts/findOrphanedBranches.js --min-age-hours=1 --base=origin/main
 *   node scripts/findOrphanedBranches.js --json
 *
 * Read-only: never deletes, pushes, or opens anything. Exit code 1 if any
 * branch is flagged ORPHANED (PUSHED_NO_PR and STALE alone do not fail —
 * neither represents commits that are actually at risk of being lost).
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const opts = { repo: process.cwd(), minAgeHours: 3, base: 'origin/main', json: false, showStale: false };
  for (const arg of argv) {
    if (arg.startsWith('--repo=')) opts.repo = path.resolve(arg.slice('--repo='.length));
    else if (arg.startsWith('--min-age-hours=')) opts.minAgeHours = parseFloat(arg.slice('--min-age-hours='.length));
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg === '--json') opts.json = true;
    else if (arg === '--show-stale') opts.showStale = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log('Usage: node scripts/findOrphanedBranches.js [--repo=<path>] [--min-age-hours=N] [--base=<ref>] [--json] [--show-stale]');
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
}

// FIX 4/4: author date instead of committer date. `git rebase` rewrites
// EVERY replayed commit's committer date to "now" while preserving the
// original author date (confirmed empirically) — so tip age based on
// committer date silently resets to ~0 the moment someone rebases old,
// forgotten work onto main just to keep it mergeable, un-flagging exactly
// the case this tool exists to catch.
function listBranches(repo) {
  const out = git(repo, ['for-each-ref', 'refs/heads/', '--format=%(refname:short)|%(authordate:unix)|%(objectname)']);
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [name, ts, sha] = l.split('|');
    return { name, tipUnix: parseInt(ts, 10), sha, detached: false };
  });
}

// FIX 4/2: this repo's worktrees are frequently left in detached-HEAD state
// (e.g. after checking out a specific commit to inspect it), which has no
// entry under refs/heads/ at all — invisible to listBranches by
// definition. `git worktree list --porcelain` sees every worktree sharing
// this .git regardless of branch/detached state, so cross-reference that to
// catch commits sitting only in a detached-HEAD worktree, with no name to
// ever attach a PR to.
function listDetachedWorktreeHeads(repo) {
  let out;
  try {
    out = git(repo, ['worktree', 'list', '--porcelain']);
  } catch (e) {
    return [];
  }
  const entries = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), sha: null, detached: false };
    } else if (current && line.startsWith('HEAD ')) {
      current.sha = line.slice('HEAD '.length).trim();
    } else if (current && line.trim() === 'detached') {
      current.detached = true;
    }
  }
  if (current) entries.push(current);

  return entries
    .filter(e => e.detached && e.sha)
    .map(e => {
      let tipUnix = null;
      try {
        tipUnix = parseInt(git(repo, ['log', '-1', '--format=%at', e.sha]).trim(), 10);
      } catch (err) { /* unreachable commit somehow — leave age unknown */ }
      return {
        name: `(detached HEAD @ ${e.sha.slice(0, 8)} in ${e.path})`,
        matchable: false, // no branch name — can never be matched to a PR or an origin branch
        tipUnix,
        sha: e.sha,
        detached: true,
      };
    });
}

function commitsAhead(repo, base, branchOrSha) {
  try {
    return parseInt(git(repo, ['rev-list', '--count', `${base}..${branchOrSha}`]).trim(), 10);
  } catch (e) {
    return null; // base ref not found, or branch/base share no history — skip rather than guess
  }
}

// FIX 4/1: which local branch names already exist on origin, and at what
// sha. A branch pushed here has its commits safe on the remote even with
// zero PRs — a fundamentally different (much less urgent) situation than a
// branch that has NEVER left this checkout — but existence alone isn't
// enough to call a SPECIFIC tip "safe": local main with a fresh commit on
// top of an origin/main pushed hours ago must not read as pushed just
// because *some* branch named "main" exists on origin. See isTipOnOrigin.
function listRemoteBranchTips(repo) {
  try {
    const out = git(repo, ['for-each-ref', 'refs/remotes/origin/', '--format=%(refname:short)|%(objectname)']);
    const map = new Map();
    for (const line of out.split('\n').map(l => l.trim()).filter(Boolean)) {
      const [ref, sha] = line.split('|');
      map.set(ref.replace(/^origin\//, ''), sha);
    }
    return map;
  } catch (e) {
    return new Map(); // can't tell — callers must treat "not found" as unknown, not "not pushed"
  }
}

/** Is `sha` itself already present on origin under `name` — equal to, or an ancestor of, its remote tip? */
function isTipOnOrigin(repo, remoteTipsByName, name, sha) {
  const remoteTip = remoteTipsByName.get(name);
  if (!remoteTip) return false;
  if (remoteTip === sha) return true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, remoteTip], { cwd: repo });
    return true; // sha is an ancestor of (already contained in) the remote tip
  } catch (e) {
    return false; // sha is not reachable from the remote tip — local has diverged/moved ahead
  }
}

/** headRefName -> [{number, state, url, title}], via ONE gh call, not one per branch. */
function fetchAllPrs(repo) {
  try {
    const out = execFileSync(
      'gh', ['pr', 'list', '--state', 'all', '--limit', '2000', '--json', 'headRefName,number,state,url,title'],
      { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 }
    );
    const list = JSON.parse(out);
    const map = new Map();
    for (const pr of list) {
      if (!map.has(pr.headRefName)) map.set(pr.headRefName, []);
      map.get(pr.headRefName).push(pr);
    }
    return { map, ok: true };
  } catch (e) {
    return { map: new Map(), ok: false, error: e.message };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = Date.now() / 1000;

  let branches;
  try {
    branches = listBranches(opts.repo);
  } catch (e) {
    console.error(`findOrphanedBranches: "${opts.repo}" doesn't look like a git repo (${e.message.trim()}).`);
    process.exit(1);
  }
  const detachedHeads = listDetachedWorktreeHeads(opts.repo);
  // Detached worktrees are keyed by sha (no branch name), so `matchable`
  // stays undefined/true for normal branches and false for these.
  const candidates = branches.map(b => ({ ...b, matchable: true })).concat(detachedHeads);

  const { map: prMap, ok: ghOk, error: ghError } = fetchAllPrs(opts.repo);
  if (!ghOk) {
    console.log(`WARNING: could not query GitHub via 'gh' (${ghError ? ghError.trim() : 'unknown error'}).`);
    console.log('Reporting commits-ahead only — PR status for every branch below is UNVERIFIED.\n');
  }
  // Independent of `gh`: does a same-named branch already exist on origin?
  // Pure git, so this signal is available even when the GitHub check fails.
  const remoteTipsByName = listRemoteBranchTips(opts.repo);

  const orphaned = [];
  const pushedNoPr = [];
  const stale = [];
  const skipped = { noCommits: 0, tooYoung: 0, openPr: 0 };

  for (const b of candidates) {
    // Comparing a ref to itself is meaningless — but a same-NAMED local
    // branch (e.g. local `main` vs `--base=origin/main`) is a real, useful
    // check and must NOT be skipped: local main/master silently outrunning
    // origin with commits nobody pushed is exactly the dangerous case this
    // tool exists to catch.
    if (b.matchable && b.name === opts.base) continue;
    if (b.tipUnix == null) { skipped.noCommits++; continue; } // couldn't resolve a tip date at all

    const ahead = commitsAhead(opts.repo, opts.base, b.matchable ? b.name : b.sha);
    if (ahead === null || ahead === 0) { skipped.noCommits++; continue; }

    const ageHours = (now - b.tipUnix) / 3600;
    if (ageHours < opts.minAgeHours) { skipped.tooYoung++; continue; }

    const prs = b.matchable ? (prMap.get(b.name) || []) : [];
    const openPr = ghOk && prs.find(p => p.state === 'OPEN');
    if (openPr) { skipped.openPr++; continue; }

    const pushed = b.matchable && isTipOnOrigin(opts.repo, remoteTipsByName, b.name, b.sha);
    const entry = { branch: b.name, ahead, ageHours, prs, pushed, detached: !!b.detached };

    if (ghOk && prs.length > 0) {
      stale.push(entry); // a real PR record exists, just closed/merged — pushed or not is moot
    } else if (pushed) {
      entry.unverified = !ghOk; // push status is certain either way; only PR status might not be
      pushedNoPr.push(entry); // safe on origin, just never had a PR opened
    } else {
      entry.unverified = !ghOk || !b.matchable; // detached heads can never be PR-matched
      orphaned.push(entry); // never pushed anywhere, no PR — the genuinely dangerous case
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ repo: opts.repo, base: opts.base, ghOk, orphaned, pushedNoPr, stale, skipped }, null, 2));
  } else {
    console.log(`findOrphanedBranches: ${opts.repo}  (base: ${opts.base}, gh: ${ghOk ? 'ok' : 'UNAVAILABLE'})`);
    console.log(`${branches.length} local branch(es) + ${detachedHeads.length} detached worktree HEAD(s) checked; ${skipped.noCommits} with nothing ahead of ${opts.base}, ${skipped.tooYoung} younger than ${opts.minAgeHours}h, ${skipped.openPr} already have an open PR.\n`);

    if (orphaned.length === 0 && pushedNoPr.length === 0 && stale.length === 0) {
      console.log('Nothing flagged. Every branch with unlanded commits either has an open PR or is younger than the threshold.');
    }

    if (orphaned.length) {
      console.log(`${orphaned.length} ORPHANED (commits ahead of ${opts.base}, NEVER pushed to origin, NO PR record${ghOk ? '' : ' — PR status unverified, gh was unavailable'}):\n`);
      for (const e of orphaned) {
        console.log(`  ${e.branch} — ${e.ahead} commit(s) ahead, tip ${e.ageHours.toFixed(1)}h old${e.unverified ? '  [UNVERIFIED]' : ''}`);
      }
      console.log('\nThese exist ONLY in this checkout — deleting the branch/worktree loses them for good.');
      console.log('Each needs a human decision: push it and open a PR, or confirm it is safe to discard.');
    }

    if (pushedNoPr.length) {
      console.log(`\n${pushedNoPr.length} PUSHED, NO PR (commits ahead of ${opts.base}, already on origin, just no PR opened — NOT at risk of being lost):\n`);
      for (const e of pushedNoPr) {
        console.log(`  ${e.branch} — ${e.ahead} commit(s) ahead, tip ${e.ageHours.toFixed(1)}h old${e.unverified ? '  [PR status unverified]' : ''}`);
      }
      console.log('\nSafe on the remote either way — open a PR when convenient.');
    }

    if (stale.length) {
      const shown = opts.showStale ? stale : stale.slice(0, 5);
      console.log(`\n${stale.length} STALE (commits ahead, but every matching PR is already closed/merged — low urgency, likely just needs \`git branch -d\`)` + (opts.showStale ? ':' : `, showing ${shown.length} (pass --show-stale for the rest):`));
      console.log('');
      for (const e of shown) {
        const prSummary = e.prs.map(p => `#${p.number} ${p.state}`).join(', ');
        console.log(`  ${e.branch} — ${e.ahead} commit(s) ahead, tip ${e.ageHours.toFixed(1)}h old (${prSummary})`);
      }
    }
  }

  // PUSHED_NO_PR and STALE do not fail the check — neither represents
  // commits that are actually at risk of being lost (FIX 4/1).
  process.exitCode = orphaned.length > 0 ? 1 : 0;
}

main();
