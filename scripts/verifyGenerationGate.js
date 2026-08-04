#!/usr/bin/env node
'use strict';
//
// verifyGenerationGate — the concurrency gate on POST /api/ads/generate.
//
// MONEY-CRITICAL. Every /generate expansion mints its own ads (identityDigest is
// scoped to generationRunId), so two runs over the SAME product bill twice for
// one intent and the atomic status:'queued' claim cannot catch it — each run
// claims what it just created. This gate is the only double-click protection,
// and it now lets DISJOINT product sets run in parallel. A bug in either
// direction is expensive: too loose double-bills, too tight blocks the team.
//
// Drives the real exported function (no source scanning, no mocks of the logic
// itself) plus source pins for the two wiring facts a unit test cannot see:
// the route must ASK the gate, and it must STAMP requestedProductIds at mint.
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyGenerationGate.js

const fs = require('fs');
const path = require('path');
const {
  generationGateDecision,
  normalizeProductIdList,
  pickSupersedingRun
} = require('../services/generationGate');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const A = '68e9aaaaaaaaaaaaaaaaaaa1';
const B = '68e9bbbbbbbbbbbbbbbbbbb2';
const C = '68e9ccccccccccccccccccc3';

// ── 1. No active runs → always allowed ──────────────────────────────
check('no active runs → allowed',
  generationGateDecision({ activeRuns: [], requestedProductIds: [A] }).blocked === false);
check('missing activeRuns key → allowed',
  generationGateDecision({ requestedProductIds: [A] }).blocked === false);
check('no args at all → allowed (nothing in flight)',
  generationGateDecision().blocked === false);

// ── 2. THE DOUBLE-CLICK. Identical set must block ───────────────────
{
  const d = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [A, B] }],
    requestedProductIds: [A, B]
  });
  check('identical product set → BLOCKED', d.blocked === true);
  check('identical set reports product-overlap', d.reason === 'product-overlap');
  check('identical set names the conflicting run', d.conflictRunId === 'run_1');
  check('identical set reports both overlapping ids',
    Array.isArray(d.overlap) && d.overlap.length === 2 &&
    d.overlap.includes(A) && d.overlap.includes(B));
}

// ── 3. PARTIAL overlap must block (the overlapping product bills twice) ──
{
  const d = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [A, B] }],
    requestedProductIds: [B, C]
  });
  check('partial overlap → BLOCKED', d.blocked === true, JSON.stringify(d));
  // Assertions stay total (no assumption that overlap exists) so a regression
  // that returns {blocked:false} REPORTS instead of throwing — a harness that
  // crashes still fails, but it fails without telling you which pin broke.
  check('partial overlap reports only the shared id',
    Array.isArray(d.overlap) && d.overlap.length === 1 && d.overlap[0] === B,
    JSON.stringify(d));
}

// ── 4. THE WIN: disjoint sets run in parallel ───────────────────────
check('disjoint sets → ALLOWED',
  generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [A] }],
    requestedProductIds: [B]
  }).blocked === false);
check('disjoint across MULTIPLE active runs → ALLOWED',
  generationGateDecision({
    activeRuns: [
      { runId: 'run_1', requestedProductIds: [A] },
      { runId: 'run_2', requestedProductIds: [B] }
    ],
    requestedProductIds: [C]
  }).blocked === false);
{
  // Overlap with the SECOND run must still be caught — not just the first.
  const d = generationGateDecision({
    activeRuns: [
      { runId: 'run_1', requestedProductIds: [A] },
      { runId: 'run_2', requestedProductIds: [B] }
    ],
    requestedProductIds: [B]
  });
  check('overlap with a LATER active run → BLOCKED', d.blocked === true);
  check('overlap with a later run names THAT run', d.conflictRunId === 'run_2');
}

// ── 5. FAIL-CLOSED on unknown scope (both directions) ───────────────
// A run we cannot scope could be targeting anything; assuming disjoint is
// assuming with the owner's money.
for (const [label, runIds] of [
  ['absent', undefined],
  ['empty array', []],
  ['nulls only', [null, undefined]],
  ['blank strings', ['', '   ']],
  ['not an array', 'nope']
]) {
  const d = generationGateDecision({
    activeRuns: [{ runId: 'run_legacy', requestedProductIds: runIds }],
    requestedProductIds: [A]
  });
  check(`active run with ${label} scope → BLOCKED (fail-closed)`, d.blocked === true);
  check(`active run with ${label} scope reports scope-unknown-active-run`,
    d.reason === 'scope-unknown-active-run', `got ${d.reason}`);
}
for (const [label, reqIds] of [
  ['absent', undefined],
  ['empty array', []],
  ['blank strings', ['', '  ']]
]) {
  const d = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [A] }],
    requestedProductIds: reqIds
  });
  check(`request with ${label} product scope → BLOCKED (fail-closed)`, d.blocked === true);
  check(`request with ${label} scope reports scope-unknown-request`,
    d.reason === 'scope-unknown-request', `got ${d.reason}`);
}

// ── 6. Identity comparison must survive real-world id shapes ────────
// ObjectId instances arrive as objects; the stamp stores strings. If these
// stopped comparing equal, an overlapping run would silently be allowed —
// a double charge that looks like a feature working.
{
  // Assert the REASON, not just `blocked`. Blocking via the fail-closed branch
  // would satisfy `blocked === true` while the ids silently stopped comparing
  // equal — which reads as "the guard works" right up until a run whose scope
  // IS known slips through and double-bills. reason must be 'product-overlap'.
  const objectIdLike = { toString: () => A };
  const d = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [objectIdLike] }],
    requestedProductIds: [A]
  });
  check('ObjectId-shaped active id MATCHES a string request (not fail-closed)',
    d.blocked === true && d.reason === 'product-overlap' && (d.overlap || [])[0] === A,
    JSON.stringify(d));
  const d2 = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [A] }],
    requestedProductIds: [objectIdLike]
  });
  check('ObjectId-shaped request MATCHES a string active id (not fail-closed)',
    d2.blocked === true && d2.reason === 'product-overlap' && (d2.overlap || [])[0] === A,
    JSON.stringify(d2));
  const d3 = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [` ${A} `] }],
    requestedProductIds: [A]
  });
  check('whitespace-padded id MATCHES (not fail-closed)',
    d3.blocked === true && d3.reason === 'product-overlap',
    JSON.stringify(d3));
}

// ── 7. normalizeProductIdList contract (shared by gate + stamp) ─────
check('normalize dedupes', normalizeProductIdList([A, A, B]).length === 2);
check('normalize drops null/blank',
  normalizeProductIdList([null, '', '  ', A]).length === 1);
// MONEY: an unreadable entry must void the WHOLE list, not be dropped. A partial
// scope reads as authoritative and would let an overlapping run through.
check('normalize voids the whole list on a non-ObjectId entry',
  normalizeProductIdList([A, { id: A }]).length === 0);
check('normalize voids on a short/garbage id',
  normalizeProductIdList([A, 'nope']).length === 0);
check('normalize accepts ObjectId INSTANCES (stringify to 24-hex)',
  normalizeProductIdList([{ toString: () => A }])[0] === A);
check('a wrapper-object request cannot look disjoint from a real id', (() => {
  const d = generationGateDecision({
    activeRuns: [{ runId: 'run_1', requestedProductIds: [A] }],
    requestedProductIds: [{ id: A }]
  });
  return d.blocked === true;   // fail-closed, never "disjoint"
})());
check('normalize preserves order', (() => {
  const out = normalizeProductIdList([B, A]);
  return out[0] === B && out[1] === A;
})());
check('normalize on non-array → []', normalizeProductIdList('x').length === 0);


// ── 7b. MINT-THEN-VERIFY: the read-then-write race ──────────────────
// Both racers verify AFTER their own insert, so both see both rows. Exactly one
// must abort, and both must independently agree on WHICH — otherwise either both
// continue (double bill) or both abort (nothing generated, silent dead end).
{
  const early = { runId: 'run_100_aaa', createdAt: new Date(1000), requestedProductIds: [A] };
  const late  = { runId: 'run_200_bbb', createdAt: new Date(2000), requestedProductIds: [A] };

  const lateVerdict = pickSupersedingRun({
    selfRun: late, activeRuns: [early, late], requestedProductIds: [A]
  });
  const earlyVerdict = pickSupersedingRun({
    selfRun: early, activeRuns: [early, late], requestedProductIds: [A]
  });
  check('racing LATER run is superseded (aborts)',
    lateVerdict && lateVerdict.runId === early.runId, JSON.stringify(lateVerdict));
  check('racing EARLIER run survives (proceeds)',
    earlyVerdict === null, JSON.stringify(earlyVerdict));
  check('exactly one of the two racers aborts',
    (lateVerdict ? 1 : 0) + (earlyVerdict ? 1 : 0) === 1);

  // Identical timestamps must STILL break deterministically, or a same-
  // millisecond double-click has both sides continue and bills twice.
  const tieA = { runId: 'run_1_aaa', createdAt: new Date(5000), requestedProductIds: [A] };
  const tieB = { runId: 'run_1_bbb', createdAt: new Date(5000), requestedProductIds: [A] };
  const vA = pickSupersedingRun({ selfRun: tieA, activeRuns: [tieA, tieB], requestedProductIds: [A] });
  const vB = pickSupersedingRun({ selfRun: tieB, activeRuns: [tieA, tieB], requestedProductIds: [A] });
  check('same-millisecond tie still aborts exactly one',
    (vA ? 1 : 0) + (vB ? 1 : 0) === 1, `vA=${JSON.stringify(vA)} vB=${JSON.stringify(vB)}`);
  check('same-millisecond tie breaks on runId (lower wins)',
    vA === null && vB && vB.runId === tieA.runId);

  // Disjoint racers must BOTH proceed — that is the whole point of the change.
  const dj1 = { runId: 'run_1', createdAt: new Date(1000), requestedProductIds: [A] };
  const dj2 = { runId: 'run_2', createdAt: new Date(2000), requestedProductIds: [B] };
  check('disjoint racers: earlier proceeds',
    pickSupersedingRun({ selfRun: dj1, activeRuns: [dj1, dj2], requestedProductIds: [A] }) === null);
  check('disjoint racers: later ALSO proceeds',
    pickSupersedingRun({ selfRun: dj2, activeRuns: [dj1, dj2], requestedProductIds: [B] }) === null);

  // Self must never supersede itself (would abort every single run).
  check('a run never supersedes itself',
    pickSupersedingRun({ selfRun: early, activeRuns: [early], requestedProductIds: [A] }) === null);
  // …including when our OWN re-read row carries a slightly different createdAt
  // than the value we passed in. The identity check on runId is what saves us:
  // without it any negative skew makes every request supersede itself, 409 on
  // its own run, and NOTHING ever generates — a total outage that looks like a
  // working guard. Pinned explicitly because the ordering check alone cannot
  // catch this shape.
  check('own row with skewed earlier createdAt still does not supersede self',
    pickSupersedingRun({
      selfRun: { runId: early.runId, createdAt: new Date(1000) },
      activeRuns: [{ ...early, createdAt: new Date(999) }],
      requestedProductIds: [A]
    }) === null);

  // Fail-closed: an earlier run with unreadable scope wins over us.
  check('earlier UNSCOPED run supersedes us (fail-closed)',
    !!pickSupersedingRun({
      selfRun: late,
      activeRuns: [{ runId: 'run_legacy', createdAt: new Date(1), requestedProductIds: [] }, late],
      requestedProductIds: [A]
    }));
  // …but a LATER unscoped run must not (it aborts itself; if we yielded too,
  // both would abort and the operator would get nothing with no explanation).
  check('later UNSCOPED run does NOT supersede us',
    pickSupersedingRun({
      selfRun: early,
      activeRuns: [early, { runId: 'run_zz', createdAt: new Date(9999), requestedProductIds: [] }],
      requestedProductIds: [A]
    }) === null);
  check('no active runs → nothing supersedes',
    pickSupersedingRun({ selfRun: early, activeRuns: [], requestedProductIds: [A] }) === null);
  check('missing selfRun → null (never abort on a malformed call)',
    pickSupersedingRun({ activeRuns: [early], requestedProductIds: [A] }) === null);
}

// ── 8. Route wiring (source pins — a unit test cannot see these) ────
const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes/ads.js'), 'utf8');
check('route imports the gate',
  /require\('\.\.\/services\/generationGate'\)/.test(adsSrc));
check('route ASKS the gate before minting a run',
  /generationGateDecision\(\{\s*activeRuns,\s*requestedProductIds:\s*productIds\s*\}\)/.test(adsSrc));
check('route 409s on a blocked decision',
  /if\s*\(gate\.blocked\)[\s\S]{0,900}status\(409\)/.test(adsSrc));
check('route STAMPS requestedProductIds at mint time',
  /requestedProductIds:\s*normalizeProductIdList\(productIds\)/.test(adsSrc));
// The stamp must be inside the CampaignRun.create call, not somewhere later:
// a run that reaches 'preparing' unstamped blocks every sibling Generate.
{
  const createIdx = adsSrc.indexOf('await CampaignRun.create({');
  const stampIdx = adsSrc.indexOf('requestedProductIds: normalizeProductIdList(productIds)');
  const createEnd = adsSrc.indexOf('});', createIdx);
  check('stamp is inside CampaignRun.create({...})',
    createIdx > 0 && stampIdx > createIdx && stampIdx < createEnd,
    `create@${createIdx} stamp@${stampIdx} end@${createEnd}`);
}
// Gate query must still be bounded by the stale window, or a dead run locks
// the campaign forever.
check('gate query still bounded by REAP_STALE_MIN',
  /activeRuns\s*=\s*await CampaignRun\.find\(\{[\s\S]{0,300}createdAt:\s*\{\s*\$gte/.test(adsSrc));
check('route runs MINT-THEN-VERIFY after CampaignRun.create',
  /pickSupersedingRun\(\{[\s\S]{0,400}selfRun:\s*\{\s*runId,\s*createdAt:\s*run\.createdAt\s*\}/.test(adsSrc));
check('superseded run aborts BEFORE the expansion (no spend)',
  (() => {
    const supIdx = adsSrc.indexOf('if (superseding) {');
    const expandIdx = adsSrc.indexOf('generationRunId: run.runId');
    return supIdx > 0 && expandIdx > supIdx;
  })());
check('superseded run is marked failed, not left preparing',
  /if \(superseding\)[\s\S]{0,1400}status: 'failed'/.test(adsSrc));
check('superseded response is a 409 with reason raced-concurrent-run',
  /reason:\s*'raced-concurrent-run'/.test(adsSrc));
check('gate query selects requestedProductIds',
  /\.select\('runId status createdAt requestedProductIds'\)/.test(adsSrc));

// ── 8b. POST /runs declares its scope too ───────────────────────────
// A drain of pre-queued ads used to block every concurrent Generate (it minted
// an unscoped run). It now stamps the products it actually claimed — and must
// fall back to EMPTY (unknown → fail closed) if any claimed ad has no productId,
// because a partial scope would let an overlapping Generate through.
check('/runs stamps requestedProductIds from the claimed ads',
  /requestedProductIds:\s*claimedProductIds/.test(adsSrc));
check('/runs falls back to [] when any claimed ad lacks productId',
  /claimedAds\.some\(a => !a\.productId\)\s*\n?\s*\?\s*\[\]/.test(adsSrc));
check('/runs scope read happens before its CampaignRun.create', (() => {
  const scopeIdx = adsSrc.indexOf('let claimedProductIds = []');
  const createIdx = adsSrc.indexOf('requestedProductIds: claimedProductIds');
  return scopeIdx > 0 && createIdx > scopeIdx;
})());

// ── 8c. Post-review hardening pins ──────────────────────────────────
// (2) A run wedged in 'preparing' past REAP_STALE_MIN stops holding its products,
//     so a sibling Generate for the SAME products is allowed. If the wedged run
//     later wakes and expands, both bill. It must re-check its own status before
//     spending — and that check must sit BEFORE expandWizardJob.
check('background expand re-checks its own run status first',
  /select\('status'\)\.lean\(\)[\s\S]{0,400}stillOurs\.status !== 'preparing'/.test(adsSrc));
check('self-status check precedes /generate\'s expandWizardJob', (() => {
  // Anchor on the /generate setImmediate block, not the first expandWizardJob in
  // the file — POST /preview calls it too, earlier, and would satisfy a naive
  // index compare while the real ordering was wrong.
  const checkIdx = adsSrc.indexOf("stillOurs.status !== 'preparing'");
  if (checkIdx <= 0) return false;
  const expandAfter = adsSrc.indexOf('const job = await expandWizardJob(', checkIdx);
  const generationRunIdIdx = adsSrc.indexOf('generationRunId: run.runId', checkIdx);
  return expandAfter > checkIdx && generationRunIdIdx > checkIdx;
})());
// (5) The superseded loser must never linger in 'preparing' — that is a zombie
//     lock on its own products for the whole stale window.
check('superseded loser abort does not swallow its write',
  !/message: `Superseded by concurrent run \$\{superseding\.runId\}; nothing was generated\.` \} \} \}\s*\n?\s*\)\.catch\(\(\) => \{\}\)/.test(adsSrc));
check('superseded loser deletes its row if the status write fails',
  /could not mark superseded run failed[\s\S]{0,300}CampaignRun\.deleteOne/.test(adsSrc));
// (10) The gate query runs twice per generation — needs its own index.
check('CampaignRun indexes the gate query shape', (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'models/CampaignRun.js'), 'utf8');
  return /index\(\{\s*campaignId:\s*1,\s*status:\s*1,\s*createdAt:\s*-1\s*\}\)/.test(src);
})());

// ── 9. Model field present ──────────────────────────────────────────
const runModelSrc = fs.readFileSync(path.join(__dirname, '..', 'models/CampaignRun.js'), 'utf8');
check('CampaignRun declares requestedProductIds as [String]',
  /requestedProductIds:\s*\{\s*type:\s*\[String\]/.test(runModelSrc));

// ── report ──────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\nverifyGenerationGate: ${failures.length} FAIL(s), ${pass} pass\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verifyGenerationGate: ${pass}/${total} checks passed`);
process.exit(0);
