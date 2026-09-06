#!/usr/bin/env node
'use strict';
//
// rebaseOpenPrs — run after every push to master. Every open PR goes stale
// within roughly one merge cycle (median gap between merges measured at
// 12.5 minutes on this repo), so a PR that takes longer than that to build
// and verify reliably has trunk move underneath it. This keeps
// ready-for-review, same-repo PRs rebased onto the latest master
// automatically instead of leaving that to whoever notices.
//
// SAFETY / WHAT THIS DELIBERATELY DOES NOT TOUCH
//   - Draft PRs are skipped (not force-pushed) — a draft usually means the
//     author has local WIP they don't want silently rewritten.
//   - Fork PRs are skipped — GITHUB_TOKEN cannot push to a contributor's
//     fork branch without "Allow edits from maintainers", and guessing
//     wrong here would just fail loudly per PR (acceptable) but there is
//     nothing to gain by trying every run.
//   - A PR labeled `no-auto-rebase` is skipped — an explicit opt-out for
//     "I have local work in progress, don't touch this branch right now".
//     The label is created (idempotently) by this script if missing, so
//     it is always available to apply.
//   - `--force-with-lease`, never `--force`: if someone pushed to the PR
//     branch after this script fetched it, the push is rejected instead of
//     silently clobbering their commit. Left for the next run.
//   - A rebase that does not apply cleanly is aborted, not forced through;
//     the PR gets a comment naming the conflicting files instead.
//
// Never fails the whole job over one PR's problem — every PR is processed
// in its own try/catch so one bad ref doesn't stop the rest from being
// checked.
//
const { execFileSync } = require('child_process');
const { upsertComment } = require('./lib/prComments');

const BASE = 'master';
const SKIP_LABEL = 'no-auto-rebase';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}
function shQuiet(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function ghJson(args) {
  return JSON.parse(sh('gh', args));
}
function tryRun(fn) {
  try { fn(); } catch (e) { /* best-effort cleanup, never fatal */ }
}

function ensureSkipLabelExists() {
  try {
    shQuiet('gh', ['label', 'create', SKIP_LABEL, '--force', '--color', 'B60205',
      '--description', 'Do not auto-rebase this PR (local work in progress)']);
  } catch (e) {
    console.error(`warning: could not ensure label "${SKIP_LABEL}" exists: ${e.message}`);
  }
}

function detachFromWorkBranch(workBranch) {
  tryRun(() => shQuiet('git', ['checkout', `origin/${BASE}`, '--quiet', '--detach']));
  tryRun(() => shQuiet('git', ['branch', '-D', workBranch]));
}

function processOne(pr) {
  const { number, headRefName, isDraft, isCrossRepository } = pr;
  const labels = (pr.labels || []).map((l) => l.name);
  console.log(`\n--- PR #${number} (${headRefName}) ---`);

  if (isDraft) { console.log('draft — skip (not touching a WIP branch)'); return; }
  if (isCrossRepository) { console.log('fork PR — cannot push without maintainer-edit rights; skip'); return; }
  if (labels.includes(SKIP_LABEL)) { console.log(`labeled "${SKIP_LABEL}" — skip`); return; }

  const workBranch = `rebase-work/${number}`;
  try {
    shQuiet('git', ['fetch', 'origin', BASE, headRefName]);
    tryRun(() => shQuiet('git', ['branch', '-D', workBranch]));
    shQuiet('git', ['checkout', '-B', workBranch, `origin/${headRefName}`]);

    let rebaseOk = true;
    try {
      shQuiet('git', ['rebase', `origin/${BASE}`]);
    } catch (e) {
      rebaseOk = false;
    }

    if (rebaseOk) {
      const newSha = sh('git', ['rev-parse', 'HEAD']).trim();
      const oldSha = sh('git', ['rev-parse', `origin/${headRefName}`]).trim();
      if (newSha === oldSha) {
        console.log(`already up to date with ${BASE}`);
      } else {
        try {
          shQuiet('git', ['push', '--force-with-lease', 'origin', `${workBranch}:${headRefName}`]);
          console.log(`rebased and pushed ${headRefName} onto latest ${BASE}`);
          upsertComment(number, 'auto-rebase', `Rebased onto latest \`${BASE}\` (was behind, no conflicts).`);
        } catch (e) {
          console.log(`push rejected for ${headRefName} (concurrent push? protected branch?) — leaving for next run.`);
        }
      }
    } else {
      let conflicts = '';
      try { conflicts = shQuiet('git', ['diff', '--name-only', '--diff-filter=U']).trim(); } catch (e) { /* ignore */ }
      tryRun(() => shQuiet('git', ['rebase', '--abort']));
      const list = conflicts
        ? conflicts.split('\n').filter(Boolean).map((f) => `- \`${f}\``).join('\n')
        : '(git did not report which files — rebase failed before conflict markers were written)';
      console.log(`rebase conflicts:\n${conflicts}`);
      upsertComment(
        number,
        'auto-rebase',
        `Auto-rebase onto \`${BASE}\` hit conflicts in:\n\n${list}\n\n` +
          `Rebase manually: \`git fetch origin && git rebase origin/${BASE}\`, resolve, then \`git push --force-with-lease\`.`
      );
    }
  } catch (err) {
    console.error(`error processing PR #${number}: ${err.message}`);
  } finally {
    detachFromWorkBranch(workBranch);
  }
}

function main() {
  shQuiet('git', ['config', 'user.name', 'adgen-rebase-bot']);
  shQuiet('git', ['config', 'user.email', 'adgen-rebase-bot@users.noreply.github.com']);
  ensureSkipLabelExists();

  const prs = ghJson([
    'pr', 'list', '--base', BASE, '--state', 'open',
    '--json', 'number,headRefName,isDraft,labels,isCrossRepository', '--limit', '200',
  ]);
  console.log(`rebaseOpenPrs: ${prs.length} open PR(s) against ${BASE}`);
  for (const pr of prs) processOne(pr);
}

main();
