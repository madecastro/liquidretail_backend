#!/usr/bin/env node
'use strict';
//
// verifyIgRescanGuards — the money guards on the forced Instagram RE-SCAN.
//
// MONEY-CRITICAL. `POST /api/integrations/instagram/sync-posts` with
// `force:true` re-enters posts that are ALREADY ingested, and its whole purpose
// is to re-queue detect on media that already had a DetectRun. Every re-queued
// run is a billable vision/LLM run, so on a 50-post re-scan the difference
// between "capped" and "uncapped" is 50 paid runs the operator did not ask for.
//
// Three invariants, each of which is a real bill if it breaks:
//
//   1. force does NOT bypass the daily detect cap. In ingestPost the
//      `if (!enqueueRun) return` early-return must stay ABOVE the forceDetect
//      bypass, because enqueueRun is what carries runsRemaining. Reorder those
//      two and a re-scan spends straight past the day's budget.
//
//   2. forceDetect is only handed to posts that ALREADY EXIST. A new post has no
//      DetectRun to skip, so passing force there would widen the bypass for no
//      reason; scoping it to `existing` is what keeps it provably limited to the
//      re-scan case.
//
//   3. The route requires a STRICT `=== true`. `force` arrives from a JSON body,
//      and a truthy check would let any non-empty string ("false", "0", "no")
//      turn a cheap incremental sync into a paid re-analysis of 50 posts.
//
// Pure + offline: reads source text only. No DB, no network, no API key.
//   node scripts/verifyIgRescanGuards.js
//
// This harness is deliberately source-text based. The logic it protects lives
// inside a function that does Mongo writes, Cloudinary uploads and Meta Graph
// calls on every branch, so there is no seam to drive it through offline without
// mocking the very ordering under test — and a mock of the ordering would pass
// against the reordered code. Ordering assertions on the real source are the
// honest test here; each one is revert-proven below.

const fs = require('fs');
const path = require('path');

const SVC_PATH   = path.join(__dirname, '..', 'services', 'postSyncService.js');
const ROUTE_PATH = path.join(__dirname, '..', 'routes', 'integrations.js');
const svc   = fs.readFileSync(SVC_PATH, 'utf8');
const route = fs.readFileSync(ROUTE_PATH, 'utf8');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. THE CAP ORDERING — force must not outrank the daily budget ────
//
// Located by anchor strings rather than line numbers so ordinary edits above
// don't produce a false failure.
const capReturnIdx    = svc.indexOf('if (!enqueueRun) {');
const forceBypassIdx  = svc.indexOf('existingRunCount > 0 && !forceDetect');
const forceRequeueIdx = svc.indexOf('existingRunCount > 0 && forceDetect');

check('1a ingestPost still has the daily-cap early return', capReturnIdx !== -1);
check('1b ingestPost still has the forceDetect bypass', forceBypassIdx !== -1);
check('1c the cap return comes BEFORE the forceDetect bypass',
  capReturnIdx !== -1 && forceBypassIdx !== -1 && capReturnIdx < forceBypassIdx,
  `capReturn@${capReturnIdx} must precede forceBypass@${forceBypassIdx}; ` +
  'reordering these lets a forced re-scan spend past the daily detect cap');
check('1d the forced re-queue is logged as billable',
  forceRequeueIdx !== -1 && /forced re-scan, billable/.test(svc),
  'a silent paid re-queue is unauditable in the Render logs');

// The skip must be conditional on forceDetect, never removed outright: without
// the guard EVERY sync re-queues detect on every known post.
check('1e the existing-run skip is still guarded, not deleted',
  /if \(existingRunCount > 0 && !forceDetect\)/.test(svc),
  'the unconditional `if (existingRunCount > 0)` skip must remain for non-forced syncs');

// ── 2. forceDetect is scoped to ALREADY-EXISTING media ───────────────
check('2a forceDetect is passed as force && existing',
  /forceDetect:\s*force\s*&&\s*!!existing/.test(svc),
  'must be `force && !!existing` — a bare `force` widens the bypass to new posts');
check('2b ingestPost defaults forceDetect to false',
  /forceDetect\s*=\s*false/.test(svc),
  'an undefined forceDetect must never read as "bypass"');

// ── 3. The dedupe skip is suppressed only under force ────────────────
check('3a the ingested-post skip honours force',
  /if \(existing && !force\)\s*\{\s*summary\.skipped\+\+;\s*continue;\s*\}/.test(svc),
  'must be `existing && !force`; dropping the `existing` test re-ingests unconditionally');
check('3b force is read from options, not inferred',
  /const force = !!options\.force;/.test(svc));

// ── 4. Honest reporting — a re-scan is not a discovery ───────────────
check('4a reIngested is tracked separately from ingested',
  /reIngested/.test(svc) && /if \(existing\) summary\.reIngested\+\+; else summary\.ingested\+\+;/.test(svc),
  'counting re-processed posts as `ingested` would report a re-scan as having found new content');
check('4b reIngested is aggregated across multiple credentials',
  /aggregated\.reIngested\s*\+=\s*r\.reIngested/.test(svc),
  'a brand with two IG accounts would silently drop the count');
check('4c reIngested is initialised in the aggregate',
  /ok: true, fetched: 0, ingested: 0, reIngested: 0/.test(svc));

// ── 5. ROUTE: strict boolean, and the cap still bounds the call ──────
check('5a route parses force with a STRICT === true',
  /const force = req\.body\?\.force === true;/.test(route),
  'a truthy check lets the string "false" trigger a paid re-analysis');
check('5b route forwards force into syncPosts', /\n\s*force,/.test(route));
check('5c route still clamps limit to 50',
  /Math\.min\(Number\(req\.body\?\.limit\) \|\| 25, 50\)/.test(route),
  'limit is the other bound on how many billable re-runs one call can trigger');
check('5d route documents that force is billable',
  /BILLABLE/.test(route) && /RE-SCAN/.test(route),
  'the next reader must not discover the cost by getting the bill');

// ── 6. The 409 on account rebind stays ACTIONABLE ────────────────────
//
// Not a spend guard, but the reason the change-account flow works at all: the
// picker cannot resolve the conflict without the conflicting credential's id.
check('6a rebind conflict returns a machine code',
  /code: 'ig-account-bound-elsewhere'/.test(route));
check('6b rebind conflict names the conflicting credential',
  /conflictCredentialId: String\(conflict\._id\)/.test(route),
  'without this the operator is told "disconnect it first" with no way to find which');
check('6c the conflict query still selects _id',
  /status: 'active', igUserId\s*\n?\s*\}\)\.select\('_id'\)\.lean\(\)/.test(route)
  || /igUserId\s*\}\)\.select\('_id'\)\.lean\(\)/.test(route),
  'conflictCredentialId would be undefined if the projection dropped _id');
check('6d the rebind conflict is still limited to ACTIVE credentials',
  /_id:\s*\{ \$ne: cred\._id \},[\s\S]{0,120}status: 'active'/.test(route),
  'a revoked credential must not block a rebind');

// ── report ──────────────────────────────────────────────────────────
console.log(`\n${failures.length ? '❌' : '✅'}  verifyIgRescanGuards: ${pass} passed, ${failures.length} failed`);
failures.forEach(f => console.log(`   ✗ ${f}`));
process.exit(failures.length ? 1 : 0);
