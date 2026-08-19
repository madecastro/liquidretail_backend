#!/usr/bin/env node
'use strict';
/**
 * verifyAdVisionQcSurfacing — offline guard for exposing the ALREADY-PERSISTED
 * Ad.visionQc verdict through more API surfaces (gallery list, ad detail, and
 * the run poller). Distinct from scripts/verifyAdVisionQc.js, which pins the
 * money-critical generation/regeneration/alerting logic itself — this harness
 * touches none of that; it only pins the read-side projection built on top of
 * an already-written verdict.
 *
 * BACKGROUND (docs/ALERTING.md, "In-app run status vs Slack" gap table,
 * 2026-08-19): the ONLY place an operator could see the full Ad.visionQc
 * object was GET /api/ads/:id/generation-inspector. GET /api/ads (list) and
 * GET /api/ads/:id both stripped it entirely via projectAd(); GET
 * /api/ads/runs/:runId had nothing from it at all — a static ad that shipped
 * WITHOUT vision QC (adVisionQcService.buildSkippedVerdict) read as a normal
 * successful draft everywhere except Slack and the inspector.
 *
 * THREE THINGS THIS PINS:
 *
 *   1. services/adVisionQcService.js `summarizeVisionQc` (pure) — the shared
 *      compact-subset formatter every surface below reuses, so "was this ad
 *      inspected" has exactly one derivation, not three that could drift.
 *
 *   2. routes/ads.js `projectAd()` — actually calls the exported function
 *      (behaviourally, not a source scan: routes/ads.js requires cleanly
 *      with no DB connection, and exports `projectAd` for exactly this)
 *      and returns a `visionQc` field on EVERY ad — compact (no categories)
 *      on the list/base path, upgraded with per-category score/pass/findings
 *      only on the `full` (detail) path.
 *
 *   3. routes/ads.js `GET /runs/:runId` — a source-scan check (same posture
 *      as verifyRunStatusTruthfulness.js's D-section: this endpoint needs a
 *      live app + DB to exercise end-to-end) confirming the handler actually
 *      queries and returns a run-level `visionQcRollup` — not just imports
 *      summarizeVisionQc unused.
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyAdVisionQcSurfacing.js
 *
 * Revert-prove (each mutation below must fail this harness):
 *   1. Have summarizeVisionQc return `passed:true` for a skipped verdict
 *      → A3 fails (an uninspected ship must never read as "fine").
 *   2. Remove the `{ categories: true }` upgrade in projectAd's `full` block
 *      → B3 fails (detail view would silently lose the one gap-closing field
 *      the owner explicitly asked to be exposed).
 *   3. Delete `visionQcRollup` (or one of its two counts) from the
 *      GET /runs/:runId response object → C1 fails.
 *   4. Stub out the two new `Ad.countDocuments({'visionQc...` calls without
 *      removing the response field → C2 fails (import/response present,
 *      never actually queried — the exact "structural, not just present"
 *      trap verifyRunStatusTruthfulness.js's own D1 comment warns about).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const qc = require('../services/adVisionQcService');
const { CATEGORIES } = qc;

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

(async () => {

// ── A. summarizeVisionQc (pure) ─────────────────────────────────────────

check('A1 null visionQc → null (ad predates the QC gate, not "uninspected")', () => {
  assert.strictEqual(qc.summarizeVisionQc(null), null);
  assert.strictEqual(qc.summarizeVisionQc(undefined), null);
});

check('A2 disabled verdict → inspected:false, disabled:true, passed:false', () => {
  const v = qc.buildPersistedVerdict({
    passed: false, disabled: true, skipped: true, finalAttempt: 1, attempts: [],
    reason: 'AD_VISION_QC_ENABLED=false'
  });
  const s = qc.summarizeVisionQc(v);
  assert.strictEqual(s.inspected, false);
  assert.strictEqual(s.disabled, true);
  assert.strictEqual(s.passed, false, 'a disabled/uninspected ad must never summarize as passed');
});

check('A3 skipped verdict (flag on, QC failed to run) → inspected:false, skipped:true, passed:false, reason carried', () => {
  const v = qc.buildSkippedVerdict('no original product URL');
  const s = qc.summarizeVisionQc(v);
  assert.strictEqual(s.inspected, false, 'skipped must read as "not inspected", not "fine"');
  assert.strictEqual(s.skipped, true);
  assert.strictEqual(s.disabled, false);
  assert.strictEqual(s.passed, false, 'the exact defect this pins: an uninspected ship must never summarize as passed');
  assert.strictEqual(s.reason, 'no original product URL');
});

check('A4 clean pass on attempt 1 → inspected:true, passed:true, regenerated:false', () => {
  const v = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: true, categories: qc.emptyCategories(), summary: 'clean' }]
  });
  const s = qc.summarizeVisionQc(v);
  assert.strictEqual(s.inspected, true);
  assert.strictEqual(s.passed, true);
  assert.strictEqual(s.regenerated, false);
  assert.strictEqual(s.summary, 'clean');
});

check('A5 passed after the one allowed regeneration → regenerated:true (QC\'d on retry)', () => {
  const v = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 2,
    attempts: [
      { attempt: 1, pass: false, categories: qc.emptyCategories(), summary: 'first fail' },
      { attempt: 2, pass: true, categories: qc.emptyCategories(), summary: 'regenerated clean' }
    ]
  });
  const s = qc.summarizeVisionQc(v);
  assert.strictEqual(s.regenerated, true);
  assert.strictEqual(s.summary, 'regenerated clean', 'summary must be the LAST attempt, not the first');
});

check('A6 terminal failure after retry → passed:false, regenerated:true', () => {
  const v = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 2,
    attempts: [
      { attempt: 1, pass: false, categories: qc.emptyCategories(), summary: 'fail 1' },
      { attempt: 2, pass: false, categories: qc.emptyCategories(), summary: 'fail 2' }
    ]
  });
  const s = qc.summarizeVisionQc(v);
  assert.strictEqual(s.passed, false);
  assert.strictEqual(s.regenerated, true);
});

check('A7 categories omitted by default — compact form carries no categories key at all', () => {
  const v = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 1,
    attempts: [{
      attempt: 1, pass: true,
      categories: { competitor_marks: { score: 9, pass: true, findings: [] } },
      summary: 'clean'
    }]
  });
  const s = qc.summarizeVisionQc(v);
  assert.strictEqual('categories' in s, false, 'list-weight callers must not pay for category detail they did not ask for');
});

check('A8 categories:true surfaces the FINAL attempt only, findings capped at 3', () => {
  const v = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 2,
    attempts: [
      {
        attempt: 1, pass: false,
        categories: { product_fidelity: { score: 3, pass: false, findings: ['a', 'b'] } },
        summary: 'first fail'
      },
      {
        attempt: 2, pass: true,
        categories: {
          competitor_marks:  { score: 9, pass: true, findings: [] },
          product_fidelity:  { score: 8, pass: true, findings: ['minor color shift', 'soft edge', 'grain', 'a fifth finding'] }
        },
        summary: 'regenerated clean'
      }
    ]
  });
  const s = qc.summarizeVisionQc(v, { categories: true });
  assert.ok(s.categories, 'categories key must be present when requested');
  assert.strictEqual(s.categories.competitor_marks.score, 9, 'must reflect the FINAL attempt, not attempt 1');
  assert.strictEqual('text_defects' in s.categories, false, 'a category absent from the final attempt must not appear (no fabricated zero-score entry)');
  assert.strictEqual(s.categories.product_fidelity.findings.length, 3, 'findings must be capped at 3 per category');
  assert.deepStrictEqual(s.categories.product_fidelity.findings, ['minor color shift', 'soft edge', 'grain']);
});

check('A9 a Mixed-field finding stored as a bare string (not an array) does not throw', () => {
  const v = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 1,
    attempts: [{
      attempt: 1, pass: false,
      categories: { text_defects: { score: 2, pass: false, findings: 'garbled headline text' } },
      summary: 'fail'
    }]
  });
  const s = qc.summarizeVisionQc(v, { categories: true });
  assert.deepStrictEqual(s.categories.text_defects.findings, ['garbled headline text']);
});

check('A10 every CATEGORIES key is a legal output key (no typo drift against the shared taxonomy)', () => {
  const cats = {};
  for (const k of CATEGORIES) cats[k] = { score: 7, pass: true, findings: [] };
  const v = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: true, categories: cats, summary: 'ok' }]
  });
  const s = qc.summarizeVisionQc(v, { categories: true });
  assert.deepStrictEqual(Object.keys(s.categories).sort(), [...CATEGORIES].sort());
});

// ── B. routes/ads.js projectAd() — behavioural, not a source scan ────────
// routes/ads.js requires cleanly with no DB connection (verified: it only
// touches Mongo inside request handlers), so this drives the REAL exported
// projectAd with a fake Ad-shaped plain object, the same posture as this
// repo's model-level pure-function harnesses.

let projectAd = null;
check('B0 routes/ads.js requires cleanly and exports projectAd', () => {
  // eslint-disable-next-line global-require
  const adsRoute = require(path.join(__dirname, '..', 'routes', 'ads.js'));
  assert.strictEqual(typeof adsRoute.projectAd, 'function');
  projectAd = adsRoute.projectAd;
});

function fakeAdWithVisionQc(visionQc) {
  return {
    _id: '507f1f77bcf86cd799439011',
    brandId: '507f1f77bcf86cd799439012',
    campaignRunIds: [],
    copy: {},
    regenerationHistory: [],
    visionQc
  };
}

check('B1 list/base projection (full=false) carries a compact visionQc with no categories key', () => {
  assert.ok(projectAd, 'B0 must run first');
  const v = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: true, categories: { competitor_marks: { score: 9, pass: true, findings: [] } }, summary: 'clean' }]
  });
  const row = projectAd(fakeAdWithVisionQc(v), false);
  assert.ok(row.visionQc, 'base projection must expose visionQc — previously absent entirely');
  assert.strictEqual(row.visionQc.inspected, true);
  assert.strictEqual(row.visionQc.passed, true);
  assert.strictEqual('categories' in row.visionQc, false, 'list weight must stay compact');
});

check('B2 an ad that predates the QC gate (visionQc:null) projects visionQc:null, not a fabricated verdict', () => {
  const row = projectAd(fakeAdWithVisionQc(null), false);
  assert.strictEqual(row.visionQc, null);
});

check('B3 detail projection (full=true) upgrades visionQc with per-category scores/findings', () => {
  const v = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 1,
    attempts: [{
      attempt: 1, pass: false,
      categories: { competitor_marks: { score: 3, pass: false, findings: ['unauthorized logo'] } },
      summary: 'fail'
    }]
  });
  const row = projectAd(fakeAdWithVisionQc(v), true);
  assert.ok(row.visionQc.categories, 'THE gap this closes: detail view must carry categories the list view omits');
  assert.strictEqual(row.visionQc.categories.competitor_marks.score, 3);
  assert.deepStrictEqual(row.visionQc.categories.competitor_marks.findings, ['unauthorized logo']);
});

check('B4 a shipped-without-QC ad (skipped) never projects passed:true on either path', () => {
  const skipped = qc.buildSkippedVerdict('no original product URL');
  const baseRow = projectAd(fakeAdWithVisionQc(skipped), false);
  const fullRow = projectAd(fakeAdWithVisionQc(skipped), true);
  assert.strictEqual(baseRow.visionQc.passed, false);
  assert.strictEqual(baseRow.visionQc.skipped, true);
  assert.strictEqual(fullRow.visionQc.passed, false);
  assert.strictEqual(fullRow.visionQc.skipped, true);
});

// ── C. routes/ads.js GET /runs/:runId — source-scan structural check ────
// Same posture as verifyRunStatusTruthfulness.js's D-section: exercising
// this handler end-to-end needs a live app + Mongo, so this scopes a window
// around the handler and asserts the actual response object + actual query
// calls, not merely "the string appears somewhere in the file".

const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');

// Bounds a route-handler marker at the NEXT top-level route declaration (or
// EOF) instead of a hand-tuned char count, same fix and same reasoning as
// verifyRunStatusTruthfulness.js's sliceHandler: a fixed span drifts stale the
// moment the handler grows past it — MEASURED again 2026-08-19, when
// services/moderationSeedFallback.js's `moderationBlocked` rollup pushed this
// exact handler's `res.json({...})` past this file's old hardcoded 6000-char
// sliceFrom, which is precisely the class of fragility that made
// verifyRunStatusTruthfulness.js switch to this pattern one PR earlier. A span
// that over-reaches past the real handler boundary would be worse than a scan
// that can't find its target: a positive assertion ("the handler contains X")
// could then pass on code belonging to a different route entirely — a
// silent, unfalsifiable pass, not a scoping bug that fails loud.
// Self-maintaining: never needs re-tuning as router.get('/runs/:runId') grows.
function sliceFrom(marker) {
  const start = adsSrc.indexOf(marker);
  if (start === -1) return null;
  const routeDeclRe = /router\.(get|post|patch|put|delete)\(/g;
  routeDeclRe.lastIndex = start + marker.length;
  const next = routeDeclRe.exec(adsSrc);
  return adsSrc.slice(start, next ? next.index : adsSrc.length);
}

check('C1 GET /runs/:runId actually returns visionQcRollup.{shippedWithoutQc,qcdOnRetry} in its res.json object', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler, 'could not locate the GET /runs/:runId handler to scope this check');
  const rjStart = handler.indexOf('res.json({');
  assert.ok(rjStart !== -1, 'no res.json({ call found in the handler');
  const rjEnd = handler.indexOf('});', rjStart);
  assert.ok(rjEnd !== -1, 'res.json({ call never closed within the scoped window');
  const responseObj = handler.slice(rjStart, rjEnd);
  assert.match(responseObj, /visionQcRollup\s*:/, 'GET /runs/:runId response object is missing "visionQcRollup"');
  assert.match(responseObj, /shippedWithoutQc/, 'visionQcRollup must carry shippedWithoutQc');
  assert.match(responseObj, /qcdOnRetry/, 'visionQcRollup must carry qcdOnRetry');
});

check('C2 the rollup is actually QUERIED (Ad.countDocuments against visionQc.* filters), not just named in the response', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  assert.match(handler, /Ad\.countDocuments\(\{[^}]*'visionQc\.skipped':\s*true/,
    'must query the shipped-without-QC count against visionQc.skipped, not fabricate the number');
  assert.match(handler, /Ad\.countDocuments\(\{[^}]*'visionQc\.finalAttempt':\s*\{\s*\$gt:\s*1/,
    'must query the QC\'d-on-retry count against visionQc.finalAttempt > 1, not fabricate the number');
});

check('C3 the rollup queries are scoped to THIS run (campaignRunIds), not the whole brand/campaign', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const rollupBlock = handler.slice(
    handler.search(/Ad\.countDocuments\(\{[^}]*'visionQc\.skipped'/),
    handler.search(/Ad\.countDocuments\(\{[^}]*'visionQc\.finalAttempt'/) + 200
  );
  assert.match(rollupBlock, /campaignRunIds:\s*run\.runId/,
    'an unscoped count would leak every other run\'s QC outcomes into this run\'s rollup');
});

check('C4 routes/ads.js requires summarizeVisionQc from adVisionQcService (single shared formatter, not a re-derivation)', () => {
  assert.match(adsSrc, /require\(['"]\.\.\/services\/adVisionQcService['"]\)/,
    'projectAd/rollup must reuse adVisionQcService.summarizeVisionQc, not hand-roll a second "is this ad inspected" check');
});

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verifyAdVisionQcSurfacing: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyAdVisionQcSurfacing: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error('verifyAdVisionQcSurfacing crashed:', err);
  process.exit(1);
});
