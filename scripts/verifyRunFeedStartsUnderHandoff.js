'use strict';
//
// verifyRunFeedStartsUnderHandoff — the Slack run feed must start on BOTH the
// adgen-handoff path and the local-render path.
//
// WHAT BROKE. routes/ads.js's render loop ends with an early `return` when
// ADGEN_RENDERER_ENABLED is true — backend has minted and claimed the ads and
// adgen's renderer takes it from there. `runFeed.startRun(...)` used to sit
// BELOW that return, next to the render pools. So from the moment the flag went
// true, startRun was never called at all: no parent Slack message, so
// CampaignRun.slackFeed.ts stayed null forever, and every stage event adgen
// emitted had no thread to post into.
//
// It failed silently and completely. Nothing errored, nothing logged, because
// nothing was ever attempted. Measured from the database: the feed's last
// working run started 2026-08-22T04:09Z — minutes before the handoff commits —
// and ALL 21 runs on 2026-08-24 have slackFeed.ts = null. Two days.
//
// adgen cannot cover for this: it has no startRun call site of its own. Its only
// feed touchpoints are adStage.onStage and adVisionQcService.noteEvent, both of
// which need a parent that only backend creates. Backend owns the run lifecycle,
// so backend owns starting the feed — handoff or not.
//
// WHY AN ORDERING CHECK. The defect was pure statement order: the right call,
// with the right arguments, in the wrong place. A check that only asserts
// "startRun exists" passes on the broken code. This asserts POSITION.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'routes', 'ads.js');
const src = fs.readFileSync(SRC, 'utf8');

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Strip comments so prose describing the bug cannot satisfy or defeat a check.
// (This file's own explanation names every token below.)
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);

console.log('verifyRunFeedStartsUnderHandoff\n');

const handoffIdx = code.indexOf('isAdgenRendererEnabled()');
ok('handoff gate found', handoffIdx >= 0,
   'could not find isAdgenRendererEnabled() — this harness is stale, fix the harness');

const startIdxs = [...code.matchAll(/runFeed\.startRun\s*\(/g)].map((m) => m.index);
ok('at least one runFeed.startRun call exists', startIdxs.length > 0,
   'the run feed is never started at all');

if (handoffIdx >= 0 && startIdxs.length) {
  const firstStart = Math.min(...startIdxs);

  // THE CHECK THIS FILE EXISTS FOR.
  ok('runFeed.startRun fires BEFORE the adgen handoff gate',
     firstStart < handoffIdx,
     'startRun is positioned after the handoff early-return, so it never runs when ' +
     'ADGEN_RENDERER_ENABLED is true — the feed silently never starts');

  // The counts startRun sends must be in scope where it is called. If the
  // partition were left below the return, this file would not even parse — but
  // a future edit could reintroduce the split by recomputing them, so pin that
  // the partition precedes the call rather than trusting parse success.
  const partIdx = code.indexOf('const veoIds');
  ok('the renderRoute partition is computed before startRun uses it',
     partIdx >= 0 && partIdx < firstStart,
     'veoIds/otherIds are defined after the startRun that sends them as staticCount/veoCount');

  // The handoff branch must still return — if that return were removed, backend
  // would double-render every ad adgen is already rendering. Guard the fix from
  // being "solved" by deleting the early return.
  const afterHandoff = code.slice(handoffIdx, handoffIdx + 1200);
  ok('the handoff branch still early-returns',
     /\breturn\s*;/.test(afterHandoff),
     'the handoff no longer returns — backend would render ads adgen is already rendering');
}

// startRun must carry the fields the parent message is built from. A call that
// fires in the right place with an empty payload is not a working feed.
const firstCall = (() => {
  const i = code.search(/runFeed\.startRun\s*\(/);
  if (i < 0) return '';
  const open = code.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) return code.slice(open, j + 1); }
  }
  return '';
})();
// Accept BOTH `field: value` and ES6 shorthand `field,` / `field }` — `adIds` is
// passed shorthand, and a `field:`-only regex reports a false failure on it.
for (const field of ['runId', 'brandId', 'total', 'adIds']) {
  const present = new RegExp(`\\b${field}\\s*(?::|,|\\s*\\})`).test(firstCall);
  ok(`startRun payload carries ${field}`, present,
     `the feed cannot build or route its parent message without ${field}`);
}

console.log('');
if (failed) {
  console.log(`❌ verifyRunFeedStartsUnderHandoff: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('✅ verifyRunFeedStartsUnderHandoff: all checks passed');
}
