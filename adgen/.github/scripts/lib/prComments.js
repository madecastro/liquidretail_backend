'use strict';
//
// prComments — shared "find or create" bot comment helper for the PR bots
// in this directory (rebaseOpenPrs.js, prCollisionWatch.js). A bot that
// posts a brand new comment every run spams the PR every time master moves
// (which, per the measured merge cadence, can be every few minutes); this
// keeps ONE comment per (PR, marker) pair and edits it in place instead.
//
const { execFileSync } = require('child_process');

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function listComments(prNumber) {
  const out = sh('gh', ['api', '--paginate', `repos/{owner}/{repo}/issues/${prNumber}/comments`]);
  const parsed = out.trim() ? JSON.parse(out) : [];
  return Array.isArray(parsed) ? parsed : [];
}

// Finds the most recent comment whose body starts with the hidden marker
// tag and PATCHes it; otherwise POSTs a new comment carrying the tag.
function upsertComment(prNumber, marker, body) {
  const tag = `<!-- bot:${marker} -->`;
  const fullBody = `${tag}\n${body}`;
  const comments = listComments(prNumber);
  const existing = comments.filter((c) => typeof c.body === 'string' && c.body.startsWith(tag)).pop();
  if (existing) {
    sh('gh', ['api', `repos/{owner}/{repo}/issues/comments/${existing.id}`, '-X', 'PATCH', '-f', `body=${fullBody}`]);
  } else {
    sh('gh', ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '-X', 'POST', '-f', `body=${fullBody}`]);
  }
}

module.exports = { upsertComment, listComments };
