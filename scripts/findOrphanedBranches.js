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
 * branch any worktree created — no filesystem walk needed), finds the ones
 * with commits ahead of origin/main, and cross-references GitHub in ONE
 * batched `gh pr list` call (not one API call per branch — this repo has
 * 200+ local branches at any given time) to classify each into:
 *
 *   - ORPHANED   — commits ahead of origin/main, no PR record at all, ever.
 *                  This is the dangerous case: nothing on GitHub points at
 *                  this work, so a deleted worktree loses it for good.
 *   - STALE      — commits ahead, but every matching PR is already
 *                  closed/merged. Usually just a local branch nobody
 *                  deleted after merging — informational, not urgent.
 *   - (skipped)  — an OPEN PR exists, or the branch has 0 commits ahead of
 *                  origin/main, or its tip is younger than --min-age-hours
 *                  (probably still being actively worked).
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
 * branch is flagged ORPHANED (the STALE bucket alone does not fail).
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

function listBranches(repo) {
  const out = git(repo, ['for-each-ref', 'refs/heads/', '--format=%(refname:short)|%(committerdate:unix)|%(objectname)']);
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [name, ts, sha] = l.split('|');
    return { name, tipUnix: parseInt(ts, 10), sha };
  });
}

function commitsAhead(repo, base, branch) {
  try {
    return parseInt(git(repo, ['rev-list', '--count', `${base}..${branch}`]).trim(), 10);
  } catch (e) {
    return null; // base ref not found, or branch/base share no history — skip rather than guess
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

  const { map: prMap, ok: ghOk, error: ghError } = fetchAllPrs(opts.repo);
  if (!ghOk) {
    console.log(`WARNING: could not query GitHub via 'gh' (${ghError ? ghError.trim() : 'unknown error'}).`);
    console.log('Reporting commits-ahead only — PR status for every branch below is UNVERIFIED.\n');
  }

  const orphaned = [];
  const stale = [];
  const skipped = { noCommits: 0, tooYoung: 0, openPr: 0 };

  for (const b of branches) {
    if (b.name === opts.base.replace(/^origin\//, '') || b.name === 'main' || b.name === 'master') continue;
    const ahead = commitsAhead(opts.repo, opts.base, b.name);
    if (ahead === null || ahead === 0) { skipped.noCommits++; continue; }

    const ageHours = (now - b.tipUnix) / 3600;
    if (ageHours < opts.minAgeHours) { skipped.tooYoung++; continue; }

    const prs = prMap.get(b.name) || [];
    const openPr = prs.find(p => p.state === 'OPEN');
    if (openPr) { skipped.openPr++; continue; }

    const entry = { branch: b.name, ahead, ageHours, prs };
    if (!ghOk) {
      entry.unverified = true;
      orphaned.push(entry); // can't distinguish orphaned vs. stale without gh — surface it, labeled unverified
    } else if (prs.length === 0) {
      orphaned.push(entry);
    } else {
      stale.push(entry); // every known PR for this branch is closed/merged
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ repo: opts.repo, base: opts.base, ghOk, orphaned, stale, skipped }, null, 2));
  } else {
    console.log(`findOrphanedBranches: ${opts.repo}  (base: ${opts.base}, gh: ${ghOk ? 'ok' : 'UNAVAILABLE'})`);
    console.log(`${branches.length} local branch(es) checked; ${skipped.noCommits} with nothing ahead of ${opts.base}, ${skipped.tooYoung} younger than ${opts.minAgeHours}h, ${skipped.openPr} already have an open PR.\n`);

    if (orphaned.length === 0 && stale.length === 0) {
      console.log('Nothing flagged. Every branch with unlanded commits either has an open PR or is younger than the threshold.');
    }

    if (orphaned.length) {
      console.log(`${orphaned.length} ORPHANED (commits ahead of ${opts.base}, NO PR record${ghOk ? '' : ' — unverified, gh was unavailable'}):\n`);
      for (const e of orphaned) {
        console.log(`  ${e.branch} — ${e.ahead} commit(s) ahead, tip ${e.ageHours.toFixed(1)}h old${e.unverified ? '  [UNVERIFIED]' : ''}`);
      }
      console.log('\nEach of these needs a human decision: open a PR for it, or confirm it is safe to delete.');
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

  process.exitCode = orphaned.length > 0 ? 1 : 0;
}

main();
