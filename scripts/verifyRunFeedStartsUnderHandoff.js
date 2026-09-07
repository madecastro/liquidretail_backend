'use strict';
//
// verifyRunFeedStartsUnderHandoff — the Slack run feed must start before the
// adgen handoff.
//
// WHAT BROKE. routes/ads.js's render loop used to end with an early `return`
// when ADGEN_RENDERER_ENABLED was true — backend had minted and claimed the
// ads and adgen's renderer took it from there. `runFeed.startRun(...)` used
// to sit BELOW that return, next to the render pools. So from the moment the
// flag went true, startRun was never called at all: no parent Slack message,
// so CampaignRun.slackFeed.ts stayed null forever, and every stage event
// adgen emitted had no thread to post into.
//
// It failed silently and completely. Nothing errored, nothing logged, because
// nothing was ever attempted. Measured from the database: the feed's last
// working run started 2026-08-22T04:09Z — minutes before the handoff commits —
// and ALL 21 runs on 2026-08-24 have slackFeed.ts = null. Two days.
//
// UPDATED (removal of the dormant in-process render/titling fallback — see
// session.d/): the handoff is now UNCONDITIONAL and permanent — there is no
// more flag, no more early `return` inside an `if`, and no more render-pool
// code after it at all. runRenderLoop now does the label/brand resolution,
// starts the run feed, logs the handoff, flips CampaignRun to 'running', and
// ends — full stop. The ordering invariant this file exists to pin still
// applies in a simpler form: startRun must fire before the handoff's
// CampaignRun status flip, and nothing resembling the deleted render pools
// may reappear after it.
//
// adgen cannot cover for this: it has no startRun call site of its own. Its only
// feed touchpoints are adStage.onStage and adVisionQcService.noteEvent, both of
// which need a parent that only backend creates. Backend owns the run lifecycle,
// so backend owns starting the feed.
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

// Anchor on the still-present handoff log line (the flag/gate function name
// itself is deleted) and the CampaignRun status flip that follows it.
const handoffIdx = code.indexOf('ADGEN handoff');
ok('handoff log line found', handoffIdx >= 0,
   'could not find the "ADGEN handoff" log line — this harness is stale, fix the harness');

const handoffFlipIdx = code.indexOf("status: 'running'", handoffIdx);
ok('the handoff still flips CampaignRun to running', handoffIdx >= 0 && handoffFlipIdx > handoffIdx,
   'could not find the preparing→running status flip after the handoff log line');

const startIdxs = [...code.matchAll(/runFeed\.startRun\s*\(/g)].map((m) => m.index);
ok('at least one runFeed.startRun call exists', startIdxs.length > 0,
   'the run feed is never started at all');

if (handoffIdx >= 0 && startIdxs.length) {
  const firstStart = Math.min(...startIdxs);

  // THE CHECK THIS FILE EXISTS FOR.
  ok('runFeed.startRun fires BEFORE the adgen handoff',
     firstStart < handoffIdx,
     'startRun is positioned after the handoff, so a failure resolving brandName/requesterLabel ' +
     'before the handoff could still leave the feed unstarted');

  // The counts startRun sends must be in scope where it is called.
  const partIdx = code.indexOf('const veoIds');
  ok('the renderRoute partition is computed before startRun uses it',
     partIdx >= 0 && partIdx < firstStart,
     'veoIds/otherIds are defined after the startRun that sends them as staticCount/veoCount');

  // NOTHING resembling the deleted render pools may follow the handoff —
  // the whole point of this removal is that runRenderLoop now ends right
  // after the handoff, not that it falls through to an in-process render
  // loop. `runOne(` /`renderOneInner(` /`VEO_CONCURRENCY` are dead names
  // that must never reappear after this point.
  const afterHandoff = code.slice(handoffFlipIdx, handoffFlipIdx + 2000);
  ok('no in-process render-pool code follows the handoff',
     !/renderOneInner\s*\(|VEO_CONCURRENCY|RENDER_CONCURRENCY/.test(afterHandoff),
     'render-pool code reappeared after the handoff — the in-process fallback must stay deleted, not merely unreachable');
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
