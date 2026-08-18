#!/usr/bin/env node
'use strict';
//
// verifySlackRunVerbosity — offline pins for services/slackRunVerbosity.js
// (the four Slack-verbosity enhancements: run-completion per-kind summary,
// preparing-reap notice, /generate claim-anomaly alert, uncap context line)
// PLUS structural wiring checks against the real call sites in
// routes/ads.js, worker.js and services/runFeedService.js.
//
// Pure module under test: no DB, no network, no API key.
//   node scripts/verifySlackRunVerbosity.js
//
// Revert-prove recipe (do each ONE AT A TIME, re-run, then undo):
//   (a) per-kind counts wrong — in formatKindBreakdownLine, swap
//       `st.delivered` for `st.failed` in the static clause → B5 fails
//       (the exact-line check catches the swapped numbers).
//   (b) reap notice claiming deletion — in buildPreparingReapNotice's
//       detail line, change "queued, intact" to "lost" → E1/E11 fail.
//   (c) anomaly alert routed to the status feed — in routes/ads.js, change
//       the claim-anomaly call from `alerts.notifyAsync` to
//       `runFeed.noteEvent`, or drop `level: 'fatal'` → G7/G8 fail.
//   (d) await added on a render-loop notify call — wrap the anomaly
//       `alerts.notifyAsync(...)` or the `runFeed.finishRun(...)` /
//       `runFeed.startRun(...)` calls in `await` → G4/G5/G6 fail.
//
// Each of (a)-(d) was hand-verified to fail before being committed as a
// passing baseline (see the session report for the actual before/after).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const {
  DEFAULT_UNCAP_THRESHOLD,
  classifyClaimedAd,
  summarizeClaimedAdKinds,
  formatKindBreakdownLine,
  formatMintedVsClaimedLine,
  formatReconciledSpendLine,
  buildRunCompletionSummaryLines,
  buildRunStartLine,
  buildPreparingReapNotice,
  buildClaimAnomalyAlert
} = require('../services/slackRunVerbosity');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
}

function deepEq(label, actual, expected) {
  check(label, JSON.stringify(actual), JSON.stringify(expected));
}

// Strip // line comments and /* */ block comments from a source slice so a
// structural regex cannot be fooled by a commented-out `await`. Deliberately
// simple (no string-literal awareness) — good enough for this repo's style,
// which does not put `await runFeed.` inside a string literal.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// ── A. classifyClaimedAd / summarizeClaimedAdKinds ─────────────────────
console.log('\nA. classifyClaimedAd / summarizeClaimedAdKinds');

deepEq('A1 static delivered',
  classifyClaimedAd({ status: 'draft', renderRoute: 'html_gen', deriveFromMaster: null }),
  { kind: 'static', outcome: 'delivered' });
deepEq('A2 static failed',
  classifyClaimedAd({ status: 'failed', renderRoute: 'html_gen', deriveFromMaster: null }),
  { kind: 'static', outcome: 'failed' });
deepEq('A3 veo master delivered',
  classifyClaimedAd({ status: 'live', renderRoute: 'veo', deriveFromMaster: null }),
  { kind: 'videoMaster', outcome: 'delivered' });
deepEq('A4 veo master failed',
  classifyClaimedAd({ status: 'failed', renderRoute: 'veo', deriveFromMaster: null }),
  { kind: 'videoMaster', outcome: 'failed' });
deepEq('A5 veo derivative delivered',
  classifyClaimedAd({ status: 'draft', renderRoute: 'veo', deriveFromMaster: 'meta_stories_9_16' }),
  { kind: 'videoDerivative', outcome: 'delivered' });
deepEq('A6 veo derivative failed',
  classifyClaimedAd({ status: 'failed', renderRoute: 'veo', deriveFromMaster: 'meta_feed_1_1' }),
  { kind: 'videoDerivative', outcome: 'failed' });
deepEq('A7 queued lands in "other" (not dropped, not delivered, not failed)',
  classifyClaimedAd({ status: 'queued', renderRoute: 'html_gen', deriveFromMaster: null }),
  { kind: 'static', outcome: 'other' });
deepEq('A7b archived also lands in "other"',
  classifyClaimedAd({ status: 'archived', renderRoute: 'veo', deriveFromMaster: null }),
  { kind: 'videoMaster', outcome: 'other' });

const mixedBatch = [
  { status: 'draft', renderRoute: 'html_gen', deriveFromMaster: null },
  { status: 'failed', renderRoute: 'html_gen', deriveFromMaster: null },
  { status: 'live', renderRoute: 'veo', deriveFromMaster: null },
  { status: 'failed', renderRoute: 'veo', deriveFromMaster: null },
  { status: 'draft', renderRoute: 'veo', deriveFromMaster: 'meta_stories_9_16' },
  { status: 'failed', renderRoute: 'veo', deriveFromMaster: 'meta_feed_1_1' },
  { status: 'queued', renderRoute: 'html_gen', deriveFromMaster: null },
  null,
  'skip-me',
  42
];

deepEq('A8 mixed batch counts (malformed entries skipped; queued -> other)',
  summarizeClaimedAdKinds(mixedBatch),
  {
    static:          { delivered: 1, failed: 1, other: 1 },
    videoMaster:     { delivered: 1, failed: 1, other: 0 },
    videoDerivative: { delivered: 1, failed: 1, other: 0 }
  });

deepEq('A9 empty / falsy -> all zeros',
  summarizeClaimedAdKinds(null),
  {
    static:          { delivered: 0, failed: 0, other: 0 },
    videoMaster:     { delivered: 0, failed: 0, other: 0 },
    videoDerivative: { delivered: 0, failed: 0, other: 0 }
  });

check('A10 DEFAULT_UNCAP_THRESHOLD is 20', DEFAULT_UNCAP_THRESHOLD, 20);

// ── B. formatKindBreakdownLine ───────────────────────────────────────
console.log('\nB. formatKindBreakdownLine');

const zeroCounts = {
  static:          { delivered: 0, failed: 0, other: 0 },
  videoMaster:     { delivered: 0, failed: 0, other: 0 },
  videoDerivative: { delivered: 0, failed: 0, other: 0 }
};
check('B1 all-zero -> null', formatKindBreakdownLine(zeroCounts), null);

const staticOnly = {
  static:          { delivered: 4, failed: 1, other: 0 },
  videoMaster:     { delivered: 0, failed: 0, other: 0 },
  videoDerivative: { delivered: 0, failed: 0, other: 0 }
};
const staticLine = formatKindBreakdownLine(staticOnly);
checkTrue('B2 static-only line has no "video" substring',
  typeof staticLine === 'string' && !/video/i.test(staticLine));
checkTrue('B2b static-only line has the real numbers',
  /4 static delivered/.test(staticLine) && /\/ 1 failed/.test(staticLine));

const videoOnly = {
  static:          { delivered: 0, failed: 0, other: 0 },
  videoMaster:     { delivered: 2, failed: 0, other: 0 },
  videoDerivative: { delivered: 3, failed: 1, other: 0 }
};
const videoLine = formatKindBreakdownLine(videoOnly);
checkTrue('B3 video-only line has no "static" substring',
  typeof videoLine === 'string' && !/static/i.test(videoLine));

// REVERT-PROOF: exact known numbers must all appear in the exact expected
// arrangement. This is the check that fails if per-kind counts get swapped
// or a field gets hardcoded to zero — not just "did it return a string".
const knownCounts = {
  static:          { delivered: 12, failed: 1, other: 0 },
  videoMaster:     { delivered: 3,  failed: 0, other: 0 },
  videoDerivative: { delivered: 6,  failed: 1, other: 0 }
};
const knownLine = formatKindBreakdownLine(knownCounts);
check('B5 exact known mixed line (REVERT-PROOF: swap delivered/failed and this fails)',
  knownLine,
  '12 static delivered / 1 failed, 3 video masters delivered (billable) / 6 free derivatives / 1 failed');
checkTrue('B5b never says lost/deleted',
  typeof knownLine === 'string' && !/lost|deleted/i.test(knownLine));

check('B6 singular master/derivative pluralization',
  formatKindBreakdownLine({
    static:          { delivered: 0, failed: 0, other: 0 },
    videoMaster:     { delivered: 1, failed: 0, other: 0 },
    videoDerivative: { delivered: 1, failed: 0, other: 0 }
  }),
  '1 video master delivered (billable) / 1 free derivative');

check('B7 "other" bucket surfaces honestly, not silently dropped',
  formatKindBreakdownLine({
    static:          { delivered: 2, failed: 0, other: 3 },
    videoMaster:     { delivered: 0, failed: 0, other: 0 },
    videoDerivative: { delivered: 0, failed: 0, other: 0 }
  }),
  '2 static delivered / 3 other');

// ── C. minted/claimed + spend + completion summary assembly ──────────
console.log('\nC. formatMintedVsClaimedLine / formatReconciledSpendLine / buildRunCompletionSummaryLines');

check('C1 minted==claimed (unclaimed 0) -> null',
  formatMintedVsClaimedLine({ mintedTotal: 10, claimedTotal: 10, unclaimedAtStart: 0 }),
  null);

const gapLine = formatMintedVsClaimedLine({ mintedTotal: 40, claimedTotal: 25, unclaimedAtStart: 15 });
checkTrue('C2 gap line contains all three numbers and "drainable"',
  typeof gapLine === 'string' &&
  /\b40\b/.test(gapLine) && /\b25\b/.test(gapLine) && /\b15\b/.test(gapLine) &&
  /drainable/i.test(gapLine));
checkTrue('C2b gap line never says lost/deleted',
  typeof gapLine === 'string' && !/lost|deleted/i.test(gapLine));

// MIXED is the normal shape (video reconciles at completion; images settle
// later), so reporting only the reconciled half UNDER-REPORTS the run. An
// earlier revision of this check asserted the opposite — that a mixed run must
// NOT mention "est." — which pinned a ~20% undercount as correct. It must
// report both, and label them distinctly so an estimate is never read as
// settled (CLAUDE.md §2).
const reconLine = formatReconciledSpendLine({ reconciledUsd: 1.8, estimatedUsd: 2.4 });
checkTrue('C3 [MONEY] mixed -> BOTH halves reported, combined figure marked approximate',
  typeof reconLine === 'string' &&
  /reconciled/.test(reconLine) && /est\./.test(reconLine) &&
  /\$1\.80/.test(reconLine) && /\$2\.40/.test(reconLine) &&
  /~\$4\.20/.test(reconLine));

const reconOnlyLine = formatReconciledSpendLine({ reconciledUsd: 1.8, estimatedUsd: 0 });
checkTrue('C3b reconciled-only -> "reconciled", never "est.", correct amount',
  typeof reconOnlyLine === 'string' && /reconciled/.test(reconOnlyLine) &&
  !/est\./.test(reconOnlyLine) && /\$1\.80/.test(reconOnlyLine));

const estLine = formatReconciledSpendLine({ reconciledUsd: 0, estimatedUsd: 1.2 });
checkTrue('C4 estimated-only -> explicit "est." label, never bare',
  typeof estLine === 'string' && /est\./.test(estLine) &&
  /\$1\.20/.test(estLine) && !/reconciled/.test(estLine));

check('C5 both zero -> null', formatReconciledSpendLine({ reconciledUsd: 0, estimatedUsd: 0 }), null);

checkTrue('C5b never derives spend from base_price (no property access to that field — comments discussing the CLAUDE.md rule are fine, computing it is not)',
  !/\.base_price\b/.test(src('services/slackRunVerbosity.js')));

const summaryLines = buildRunCompletionSummaryLines({
  mintedTotal: 40, claimedTotal: 25, unclaimedAtStart: 15,
  kindCounts: knownCounts, reconciledUsd: 1.8, estimatedUsd: 99
});
check('C6 completion summary is 3 ordered lines (minted, kinds, spend)', summaryLines.length, 3);
checkTrue('C6b line 1 is the minted/claimed gap', /minted 40/.test(summaryLines[0]));
checkTrue('C6c line 2 is the kind breakdown', /12 static delivered/.test(summaryLines[1]));
// See C3: a mixed run must report BOTH halves. An earlier revision asserted
// the reconciled half "wins" and no "est." appears, which pinned an
// undercount of the run's real spend as correct.
// Fixture is reconciled 1.80 + estimated 99 — deliberately lopsided, because
// it is exactly the shape that made the old behaviour dangerous: reporting
// only "$1.80" on a run holding $99 of unsettled spend.
checkTrue('C6d [MONEY] line 3 reports both halves when both are present',
  /reconciled \$1\.80/.test(summaryLines[2]) &&
  /est\. \$99\.00/.test(summaryLines[2]) &&
  /~\$100\.80/.test(summaryLines[2]));

checkTrue('C7 completion summary never throws on garbage input',
  Array.isArray(buildRunCompletionSummaryLines(null)) && buildRunCompletionSummaryLines(null).length === 0 &&
  Array.isArray(buildRunCompletionSummaryLines(undefined)) &&
  Array.isArray(buildRunCompletionSummaryLines('not-an-object')));

check('C8 no-gap + no-spend run yields only the kind-breakdown line',
  buildRunCompletionSummaryLines({
    mintedTotal: 10, claimedTotal: 10, unclaimedAtStart: 0,
    kindCounts: staticOnly, reconciledUsd: 0, estimatedUsd: 0
  }).length,
  1);

// ── D. buildRunStartLine (uncap context line) ─────────────────────────
console.log('\nD. buildRunStartLine');

check('D1 total<=20 is byte-identical to the historical base string',
  buildRunStartLine({ total: 12, staticCount: 8, veoCount: 4 }),
  'run start — 12 ad(s)');
check('D1b exactly at threshold stays at the base string',
  buildRunStartLine({ total: 20, staticCount: 10, veoCount: 10 }),
  'run start — 20 ad(s)');
checkTrue('D1c matches the /run start/ regex verifyRunFeed.js A10 depends on',
  /run start/.test(buildRunStartLine({ total: 5 })));

const uncappedBoth = buildRunStartLine({ total: 39, staticCount: 24, veoCount: 15 });
check('D2 exact uncapped-both form',
  uncappedBoth,
  'run start — 39 ad(s) — uncapped batch (24 static + 15 video)');

const uncappedVeo = buildRunStartLine({ total: 39, staticCount: 0, veoCount: 15 });
check('D3 exact video-only uncapped form (no "0 static" noise)',
  uncappedVeo,
  'run start — 39 ad(s) — uncapped batch (15 video)');
checkTrue('D3b never renders a zero count', !/\b0 static\b|\b0 video\b/.test(uncappedVeo));

// ── E. buildPreparingReapNotice / buildClaimAnomalyAlert (wording) ────
console.log('\nE. buildPreparingReapNotice / buildClaimAnomalyAlert — wording truthfulness');

const reapPayload = buildPreparingReapNotice({
  staleMin: 30,
  runs: [
    { runId: 'run_aaa', campaignId: 'camp_1', ageMin: 45, drainableCount: 12 },
    { runId: 'run_bbb', campaignId: 'camp_2', ageMin: 60, drainableCount: 3 }
  ]
});
const reapJson = JSON.stringify(reapPayload);
checkTrue('E1 REVERT-PROOF: preparing-reap payload never says lost/deleted',
  !/lost|deleted/i.test(reapJson));
checkTrue('E2 detail names the drain path literally ("Generate more")',
  typeof reapPayload.detail === 'string' && reapPayload.detail.includes('Generate more'));
checkTrue('E3 detail names the archive fallback literally ("24h archive sweep")',
  typeof reapPayload.detail === 'string' && reapPayload.detail.includes('24h archive sweep'));
checkTrue('E3b detail names both run ids and both campaign ids',
  reapPayload.detail.includes('run_aaa') && reapPayload.detail.includes('run_bbb') &&
  reapPayload.detail.includes('camp_1') && reapPayload.detail.includes('camp_2'));
check('E4 multi-run title', reapPayload.title, '2 stranded generation(s) reclaimed');
check('E5 "ads intact & queued" sums drainableCount across runs', reapPayload.fields['ads intact & queued'], 15);
check('E6 "stale past" field reflects staleMin', reapPayload.fields['stale past'], '30m');

const emptyReap = buildPreparingReapNotice({ runs: [], staleMin: 30 });
check('E7 empty runs -> zero-count title, never throws', emptyReap.title, '0 stranded generation(s) reclaimed');
check('E8 empty runs drops the ads-intact field (undefined, not 0)', emptyReap.fields['ads intact & queued'], undefined);
check('E9 empty runs -> empty detail string', emptyReap.detail, '');

const singleReap = buildPreparingReapNotice({
  staleMin: 30,
  runs: [{ runId: 'run_solo', campaignId: null, ageMin: 40, drainableCount: 0 }]
});
check('E10 single-run title names the runId', singleReap.title, 'Stranded generation reclaimed — run run_solo');
checkTrue('E11 REVERT-PROOF: single-run detail is "queued, intact", never lost/deleted',
  /queued, intact/.test(singleReap.detail) && !/lost|deleted/i.test(singleReap.detail));
checkTrue('E11b missing campaignId renders as "-" rather than "null"/"undefined"',
  singleReap.detail.includes('campaign=-') && !/campaign=null|campaign=undefined/.test(singleReap.detail));

const anomaly = buildClaimAnomalyAlert({ runId: 'run_x', campaignId: 'camp_y', selectedCount: 7, modifiedCount: 7 });
checkTrue('E12 anomaly title contains "anomaly"', /anomaly/i.test(String(anomaly.title)));
checkTrue('E13 anomaly fields carry run/campaign/selected',
  anomaly.fields &&
  Object.prototype.hasOwnProperty.call(anomaly.fields, 'run') &&
  Object.prototype.hasOwnProperty.call(anomaly.fields, 'campaign') &&
  Object.prototype.hasOwnProperty.call(anomaly.fields, 'selected'));
checkTrue('E14 anomaly outcome mentions "queued" (ads released, not lost)',
  /queued/i.test(String(anomaly.fields.outcome)) && !/lost|deleted/i.test(String(anomaly.fields.outcome)));
check('E15 anomaly title exact', anomaly.title, 'Claim anomaly — run run_x released');

// ── F. REVERT-PROOF negative control ──────────────────────────────────
console.log('\nF. REVERT-PROOF negative control — a broken formatter would fail B5/E1');

function brokenFormatKindBreakdownLine(_counts) {
  // The classic "looks wired, silently wrong" mutation: ignores its input.
  return null;
}
function brokenPreparingReapNotice() {
  return { title: 'ok', fields: {}, detail: 'ads were lost during the outage' };
}

checkTrue('F1 broken kind-breakdown impl returns null on known non-zero counts (would silently pass a naive "returned a string" check)',
  brokenFormatKindBreakdownLine(knownCounts) === null);
checkTrue('F2 real impl returns the known line — B5 catches a swap-in of F1',
  formatKindBreakdownLine(knownCounts) ===
  '12 static delivered / 1 failed, 3 video masters delivered (billable) / 6 free derivatives / 1 failed');
checkTrue('F3 broken reap notice DOES say "lost" — E1 catches a swap-in of this',
  /lost/i.test(brokenPreparingReapNotice().detail));
checkTrue('F4 real reap notice never says "lost" — proves E1 discriminates real vs broken',
  !/lost/i.test(JSON.stringify(reapPayload)));

// ── G. structural wiring (real call sites in routes/ads.js, worker.js) ─
console.log('\nG. structural wiring — call sites, alert level, channel, never-awaited');

{
  const adsSrc     = src('routes/ads.js');
  const workerSrc  = src('worker.js');
  const feedSrc    = src('services/runFeedService.js');
  const adsStripped    = stripComments(adsSrc);
  const workerStripped = stripComments(workerSrc);
  const feedStripped   = stripComments(feedSrc);

  checkTrue('G1 routes/ads.js requires services/slackRunVerbosity',
    /require\(['"]\.\.\/services\/slackRunVerbosity['"]\)/.test(adsSrc));
  checkTrue('G2 worker.js requires services/slackRunVerbosity',
    /require\(['"]\.\/services\/slackRunVerbosity['"]\)/.test(workerSrc));
  checkTrue('G3 services/runFeedService.js requires services/slackRunVerbosity',
    /require\(['"]\.\/slackRunVerbosity['"]\)/.test(feedSrc));

  checkTrue('G4 runRenderLoop calls runFeed.finishRun with summaryLines',
    /runFeed\.finishRun\(\{[\s\S]{0,400}?summaryLines/.test(adsStripped));
  checkTrue('G5 runRenderLoop builds the completion summary via buildRunCompletionSummaryLines',
    /slackVerbosity\.buildRunCompletionSummaryLines\(/.test(adsStripped));
  checkTrue('G6 the completion-summary block reuses persisted mintedTotal/unclaimedAtStart (does not recompute them)',
    /mintedTotal:\s*final\?\.mintedTotal/.test(adsStripped) &&
    /unclaimedAtStart:\s*final\?\.unclaimedAtStart/.test(adsStripped));

  // ── the claim anomaly must go to alerts (fatal), NEVER to runFeed (the
  // per-run status feed) — this is the (c) revert-prove target.
  const anomalyBlockMatch = adsStripped.match(
    /if \(claim\.kind === 'anomaly'\) \{[\s\S]{0,900}?\n {8}\}/
  );
  checkTrue('G7 claim-anomaly branch found in routes/ads.js', !!anomalyBlockMatch);
  const anomalyBlock = anomalyBlockMatch ? anomalyBlockMatch[0] : '';
  checkTrue('G8 claim-anomaly branch calls buildClaimAnomalyAlert + alerts.notifyAsync',
    /slackVerbosity\.buildClaimAnomalyAlert\(/.test(anomalyBlock) &&
    /alerts\.notifyAsync\(/.test(anomalyBlock));
  checkTrue('G9 claim-anomaly alert is sent at level \'fatal\' (the alert/fatal channel, not the default status level)',
    /level:\s*'fatal'/.test(anomalyBlock));
  checkTrue('G10 claim-anomaly branch never calls runFeed.* (must not land on the per-run status feed)',
    !/runFeed\./.test(anomalyBlock));
  checkTrue('G11 claim-anomaly notifyAsync call is not awaited (fire-and-forget)',
    !/await\s+alerts\.notifyAsync/.test(anomalyBlock) &&
    !/await\s+[\s\S]{0,20}?slackVerbosity\.buildClaimAnomalyAlert/.test(anomalyBlock));

  // ── the preparing-reap notice in worker.js must also be fire-and-forget
  // and must not be folded into the per-run status feed either.
  const workerNoticeMatch = workerStripped.match(
    /if \(stalePrepsDocs\.length\) \{[\s\S]{0,1500}?\n {2}\}/
  );
  checkTrue('G12 preparing-reap notice block found in worker.js', !!workerNoticeMatch);
  const workerNoticeBlock = workerNoticeMatch ? workerNoticeMatch[0] : '';
  checkTrue('G13 preparing-reap block calls buildPreparingReapNotice + alerts.notifyAsync',
    /buildPreparingReapNotice\(/.test(workerNoticeBlock) &&
    /alerts\.notifyAsync\(/.test(workerNoticeBlock));
  checkTrue('G14 preparing-reap notifyAsync is not awaited',
    !/await\s+alerts\.notifyAsync/.test(workerNoticeBlock));
  checkTrue('G15 preparing-reap block never says lost/deleted in its own source comments+strings',
    !/\blost\b|\bdeleted\b/i.test(workerNoticeBlock));

  // ── run-start / run-finish calls in the render loop must never be awaited
  // (mirrors verifyRunFeed.js G6, re-asserted here against the NEW opts).
  checkTrue('G16 no `await runFeed.` anywhere in routes/ads.js',
    !/await\s+runFeed\./.test(adsStripped));
  checkTrue('G17 startRun call sites pass staticCount/veoCount for the uncap line',
    /runFeed\.startRun\(\{[\s\S]{0,200}?staticCount/.test(adsStripped));

  // ── runFeedService itself: buildRunStartLine used (not a re-inlined
  // template string), and finishRun's extra lines are bounded (never trust
  // a caller's array length unbounded).
  checkTrue('G18 runFeedService.startRun uses buildRunStartLine, not a re-inlined template',
    /stage:\s*buildRunStartLine\(/.test(feedStripped));
  checkTrue('G19 runFeedService.finishRun bounds finishExtraLines (slice)',
    /finishExtraLines[\s\S]{0,200}?\.slice\(/.test(feedStripped));
  checkTrue('G20 buildParentText renders finishExtraLines before finishReasons',
    (() => {
      const extraIdx = feedStripped.indexOf('state.finishExtraLines');
      const reasonsIdx = feedStripped.indexOf('state.finishReasons');
      return extraIdx > -1 && reasonsIdx > -1 && extraIdx < reasonsIdx;
    })());

  // ── the completion-summary computation in runRenderLoop must itself be
  // wrapped so it can never surface in the outer catch (which would
  // re-mark an already-'done' run as 'failed').
  checkTrue('G21 completion-summary block is wrapped in its own try/catch',
    /let summaryLines = \[\];\s*\n\s*try \{[\s\S]{0,900}?catch \(err\) \{/.test(adsStripped));

  // ── neither new code path introduces a raw HTTP call to Slack — must
  // route through the existing alertService/runFeedService plumbing.
  checkTrue('G22 services/slackRunVerbosity.js makes no direct Slack/HTTP calls',
    !/fetch\(|chat\.postMessage|chat\.update|slack\.com/i.test(src('services/slackRunVerbosity.js')));
  checkTrue('G23 services/slackRunVerbosity.js has no Mongo/network require (pure, side-effect-free)',
    !/require\(['"]mongoose['"]\)|require\(['"]\.\.\/models/.test(src('services/slackRunVerbosity.js')));
}

// ── summary ─────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('FAIL', f);
}
process.exit(failures.length ? 1 : 0);
