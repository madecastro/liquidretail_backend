#!/usr/bin/env node
'use strict';
//
// prCollisionWatch — warns early when two open PRs touch the same file.
// `renderer.js` alone was touched by a third of all recent merges; knowing
// at PR-open time that another open PR already touches the same file is
// the difference between a quick rebase and a from-scratch rewrite.
//
// Recomputes the FULL open-PR file-overlap graph on every run (not just
// for whichever PR triggered the event) and rewrites one bot comment per
// PR listing its current collisions — including replacing a stale warning
// with "no collisions" once the overlap is gone (a diagnostic that stops
// being true is worse than no diagnostic at all).
//
// Uses `gh pr diff --name-only`, which compares against the PR's actual
// merge base, not a raw local diff — a PR that is merely BEHIND master
// does not show up as touching every file master has since changed (the
// same "behind is not a revert" trap that applies everywhere else here).
//
const { execFileSync } = require('child_process');
const { upsertComment } = require('./lib/prComments');

const BASE = 'master';
const MARKER = 'pr-collision-watch';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}
function ghJson(args) {
  return JSON.parse(sh('gh', args));
}

function filesTouchedBy(prNumber) {
  try {
    const out = sh('gh', ['pr', 'diff', String(prNumber), '--name-only']);
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    console.error(`could not read diff for PR #${prNumber}: ${err.message}`);
    return new Set();
  }
}

function main() {
  const prs = ghJson(['pr', 'list', '--base', BASE, '--state', 'open', '--json', 'number,title', '--limit', '200']);
  console.log(`prCollisionWatch: ${prs.length} open PR(s) against ${BASE}`);

  const filesByPr = {};
  for (const pr of prs) filesByPr[pr.number] = filesTouchedBy(pr.number);

  for (const pr of prs) {
    const mine = filesByPr[pr.number];
    const overlaps = [];
    for (const other of prs) {
      if (other.number === pr.number) continue;
      const common = [...mine].filter((f) => filesByPr[other.number].has(f)).sort();
      if (common.length) overlaps.push({ number: other.number, title: other.title, files: common });
    }
    overlaps.sort((a, b) => a.number - b.number);

    let body;
    if (!overlaps.length) {
      body = 'No file overlap with other open PRs right now.';
    } else {
      const lines = [`This PR shares changed file(s) with **${overlaps.length}** other open PR(s):`, ''];
      for (const o of overlaps) {
        lines.push(`- #${o.number} — ${o.title}: ${o.files.map((f) => `\`${f}\``).join(', ')}`);
      }
      lines.push('', 'Coordinate or rebase early — the longer these stay open together, the more likely a rebase turns into a rewrite.');
      body = lines.join('\n');
    }
    upsertComment(pr.number, MARKER, body);
    console.log(`PR #${pr.number}: ${overlaps.length} colliding PR(s)`);
  }
}

main();
