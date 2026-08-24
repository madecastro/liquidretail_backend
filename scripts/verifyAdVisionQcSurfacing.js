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
 * EXTENDED 2026-08-19 (production incident: run run_1787174963435_ff67021e,
 * 39/39 ads delivered, visionQc:null on all 39 — static AND video). Root
 * cause: SystemConfig vision QC was unset and no override existed
 * (a real, working gate), but every live caller of adVisionQc.isEnabled()
 * (directImageRenderService.renderDirectImage, brandScriptExecutor
 * .runVideoVisionQcForAd, imageRecoveryService.maybeQcRecoveredPlate) used
 * to `return null`/`return firstOutput` on the gate being off — so
 * Ad.visionQc stayed at its schema default `null`, reading identically to
 * "inspected and passed" everywhere, AND the run-level shippedWithoutQc
 * rollup (which only ever queried `visionQc.skipped:true`) counted these
 * ads as zero. Two bugs, one root cause; sections D and the rewritten C
 * pin the fix for both:
 *
 *   D. The three gate-off early returns now stamp the SAME disabled-verdict
 *      shape runPostRenderQc's/runVideoPostRenderQc's own "Flag off" branch
 *      builds (buildPersistedVerdict with skipped:true, disabled:true,
 *      reason:'vision QC disabled (SystemConfig.…)') instead of a bare null, and warn
 *      once via the new shared adVisionQc.warnQcDisabledOnce.
 *   C (rewritten). GET /runs/:runId's shippedWithoutQc count now also
 *      counts a bare absent/null visionQc field, not just an explicit
 *      skipped:true verdict — the ONLY way historical ads (shipped before
 *      section D's fix landed, which cannot be retroactively backfilled)
 *      are ever counted as "not inspected" at all. A third rollup count,
 *      qcFailed, was added for the "inspected and flagged" state the owner
 *      asked to be able to see in aggregate, not just per-card.
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyAdVisionQcSurfacing.js
 *
 * EXTENDED 2026-08-20 (owner decision: a QC-failed ad must be delivered as
 * FAILED with a reason, and that reason must be the EXACT text Slack's
 * vision-QC alert already carries). Three more things this pins:
 *
 *   E. alertQcFailure (adVisionQcService.js) now RETURNS the exact `detail`
 *      string it sent to Slack (buildQcSlackDetail's output), instead of
 *      void. Every call site that persists a QC-failed visionQc (static
 *      live path, video live path, static recovery path) captures that
 *      return value and stamps it onto `visionQc.failureDetail` BEFORE
 *      persisting — so the app and Slack are provably reading one string,
 *      never two independent derivations. summarizeVisionQc passes that
 *      field through verbatim, gated behind {categories:true} (detail view
 *      only — list weight stays compact).
 *   F. A REAL video vision-QC failure (passed:false, not skipped, not
 *      disabled) now delivers the ad as status:'failed' with a renderError,
 *      instead of the normal draft it used to fall through to — reversing
 *      the prior "ships anyway" behaviour this same file's D2 section
 *      pinned the gate-off shape for. The asset is still NEVER discarded
 *      (money: the ~$0.90 master is already paid for). One pure function,
 *      buildVideoQcFailureFields (brandScriptExecutor.js, exported), is the
 *      sole decision point shared by both places a video ad's terminal
 *      status gets written, so they cannot drift on what "failed" means.
 *   G. routes/catalog.js's `GET /:id/ads-detail` (the Product Ads page's
 *      backing endpoint — the one detail surface that is NOT routes/ads.js)
 *      had never carried visionQc or renderError at all: a field missing
 *      from that endpoint's own $project allowlist arrives `undefined`
 *      regardless of what's on the Ad document. Source-scan posture (same
 *      as C1/C4/D4): this route needs a live DB + tenant-scoped product to
 *      exercise end-to-end.
 *
 * Revert-prove (each mutation below must fail this harness):
 *   1. Have summarizeVisionQc return `passed:true` for a skipped verdict
 *      → A3 fails (an uninspected ship must never read as "fine").
 *   2. Remove the `{ categories: true }` upgrade in projectAd's `full` block
 *      → B3 fails (detail view would silently lose the one gap-closing field
 *      the owner explicitly asked to be exposed).
 *   3. Delete `visionQcRollup` (or any of its three counts) from the
 *      GET /runs/:runId response object → C1 fails.
 *   4. Stub out the three `Ad.countDocuments({'visionQc...` calls without
 *      removing the response field → C2 fails (import/response present,
 *      never actually queried — the exact "structural, not just present"
 *      trap verifyRunStatusTruthfulness.js's own D1 comment warns about).
 *   5. Revert shippedWithoutQc's query back to bare `'visionQc.skipped':
 *      true` (drop the `$or` / null branch) → C5 fails — the exact
 *      production regression this whole extension exists to catch.
 *   6. Revert any of the three `if (!adVisionQc.isEnabled())` early returns
 *      in brandScriptExecutor.js / imageRecoveryService.js back to a bare
 *      `return null` → D2/D3 fails (drives the REAL exported function with
 *      adVisionQcService stubbed at the require layer, same convention as
 *      verifyGenerateProductTenancy.js).
 *   7. Remove the disabled-verdict stamp from directImageRenderService.js's
 *      early return → D4 fails (structural — that function's "attempt 1"
 *      generation makes it too expensive/billable to drive end-to-end here,
 *      same posture as this file's own C-section for GET /runs/:runId).
 *   8. Have alertQcFailure stop returning `detail` (back to void) → E1/E2
 *      fail (confirmed live, 2026-08-20: reverting adVisionQcService.js
 *      alone dropped E1 through E4 to failing while every other check,
 *      including E5, E6, and all of section F and G, stayed green).
 *   9. Remove buildVideoQcFailureFields's export, or its status:'failed'
 *      branch → F1/F5/F7 fail (confirmed live: reverting
 *      brandScriptExecutor.js alone failed exactly F1-F7, nothing else).
 *  10. Drop `visionQc: 1, renderError: 1` from catalog.js's ads-detail
 *      $project, or the `visionQc: summarizeVisionQc(...)` /
 *      `renderErrorMessage` lines from its adRows shaping → G2/G3 fail
 *      (confirmed live: reverting routes/catalog.js alone failed exactly
 *      G1-G3, nothing else).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const qc = require('../services/adVisionQcService');
const { CATEGORIES } = qc;
// Real (unstubbed) module — used by section F for the pure
// buildVideoQcFailureFields helper. Requiring it does no I/O; it only
// wires up function closures, same posture as routes/ads.js in B0 below.
const bse = require('../services/brandScriptExecutor.js');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// Brace-balanced extraction of the object literal argument to the NEAREST
// `Ad.countDocuments({` call that precedes `anchorText` in `src`. Added
// 2026-08-19 alongside the shippedWithoutQc status-scoping fix: the older
// C-section checks below used a `[^}]*` regex between `Ad.countDocuments({`
// and their target key, which silently assumed the call's object literal
// contained no nested `{...}` of its own. The moment `status: { $in:
// AD_STATUSES }` was added to that same call, the nested `}` broke every
// `[^}]*` scan — the exact "regex over source text" trap CLAUDE.md §5
// warns about, just inside a test file instead of a money guard. This walks
// real brace depth instead, so it survives further nested clauses.
// Strip `//`-to-end-of-line comments first — a naive indexOf/anchor search
// over raw source can find its own explanatory comment (this file's header
// literally quotes `'visionQc.skipped': true` while explaining the fix,
// which sits BEFORE the real query in the handler and would otherwise win
// every `indexOf`). Good enough for this narrow, controlled slice; not a
// general JS parser, and there are no `/regex/` literals in this handler to
// desync a bare `//`-comment strip.
function stripLineComments(src) {
  return src.replace(/\/\/[^\n]*/g, '');
}

function countDocumentsCallAt(rawSrc, anchorText) {
  const src = stripLineComments(rawSrc);
  const anchorIdx = src.indexOf(anchorText);
  if (anchorIdx === -1) return null;
  const callStart = src.lastIndexOf('Ad.countDocuments(', anchorIdx);
  if (callStart === -1) return null;
  const open = src.indexOf('{', callStart);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(callStart, i + 1);
    }
  }
  return null;
}

// Every `Ad.countDocuments({...})` call in `src`, each sliced by real brace
// balance (not a single-shot search from one anchor) — used where a check
// needs to find "the one call matching several conditions together" rather
// than being handed a single known anchor string.
function allCountDocumentsCalls(rawSrc) {
  const src = stripLineComments(rawSrc);
  const calls = [];
  const callRe = /Ad\.countDocuments\(/g;
  let m;
  while ((m = callRe.exec(src))) {
    const open = src.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { calls.push(src.slice(m.index, i + 1)); break; }
      }
    }
  }
  return calls;
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
    reason: 'vision QC disabled (SystemConfig.staticVisionQcEnabled)'
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

check('C1 GET /runs/:runId actually returns visionQcRollup.{shippedWithoutQc,qcDisabled,qcUnavailable,qcFailed,qcdOnRetry} in its res.json object', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler, 'could not locate the GET /runs/:runId handler to scope this check');
  // Brace-balanced slice of the visionQcRollup OBJECT LITERAL itself, on
  // COMMENT-STRIPPED text — the naive prior version slices from `res.json({`
  // to the next literal `});`, a window that also contains this endpoint's
  // several paragraphs of explanatory comments (which, deliberately, name
  // every one of these keys) — so removing an actual key from the object
  // while its describing comment survives nearby would still "pass". A key
  // must appear as `\bKEY\s*:` inside the ACTUAL object literal, post
  // comment-strip, to count.
  const stripped = stripLineComments(handler);
  const anchorIdx = stripped.indexOf('visionQcRollup:');
  assert.ok(anchorIdx !== -1, 'GET /runs/:runId response object is missing "visionQcRollup"');
  const open = stripped.indexOf('{', anchorIdx);
  assert.ok(open !== -1, 'visionQcRollup: has no object literal following it');
  let depth = 0, closeIdx = -1;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert.ok(closeIdx !== -1, 'visionQcRollup: { ... } object literal never closed');
  const rollupObj = stripped.slice(open, closeIdx + 1);
  for (const key of ['shippedWithoutQc', 'qcFailed', 'qcdOnRetry', 'qcDisabled', 'qcUnavailable']) {
    assert.match(rollupObj, new RegExp(`\\b${key}\\s*:`),
      `visionQcRollup object literal is missing the "${key}" key (found only in a comment, or not at all)`);
  }
});

check('C2 the rollup is actually QUERIED (Ad.countDocuments against visionQc.* filters), not just named in the response', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  assert.match(handler, /Ad\.countDocuments\(\{[\s\S]*?'visionQc\.skipped':\s*true/,
    'must query the shipped-without-QC count against visionQc.skipped, not fabricate the number');
  assert.match(handler, /Ad\.countDocuments\(\{[\s\S]*?'visionQc\.disabled':\s*false[\s\S]*?'visionQc\.passed':\s*false/,
    'must query the qcFailed count against an actually-inspected, failed verdict, not fabricate the number');
  assert.match(handler, /Ad\.countDocuments\(\{[\s\S]*?'visionQc\.finalAttempt':\s*\{\s*\$gt:\s*1[\s\S]*?'visionQc\.passed':\s*true/,
    'must query the QC\'d-on-retry count against visionQc.finalAttempt > 1 AND passed:true, not fabricate the number');
});

check('C3 the rollup queries are scoped to THIS run (campaignRunIds), not the whole brand/campaign', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  for (const anchor of [
    `'visionQc.skipped': true`,
    `'visionQc.disabled': false`,
    `'visionQc.finalAttempt'`,
    `'visionQc.disabled': true`
  ]) {
    const call = countDocumentsCallAt(handler, anchor);
    assert.ok(call, `could not locate the brace-balanced Ad.countDocuments call containing ${anchor}`);
    assert.match(call, /campaignRunIds:\s*run\.runId/,
      `an unscoped count (anchor: ${anchor}) would leak every other run's QC outcomes into this run's rollup`);
  }
});

check('C4 routes/ads.js requires summarizeVisionQc from adVisionQcService (single shared formatter, not a re-derivation)', () => {
  assert.match(adsSrc, /require\(['"]\.\.\/services\/adVisionQcService['"]\)/,
    'projectAd/rollup must reuse adVisionQcService.summarizeVisionQc, not hand-roll a second "is this ad inspected" check');
});

check('C5 shippedWithoutQc ALSO counts a bare absent/null visionQc field, not just skipped:true — the production regression', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const callSrc = countDocumentsCallAt(handler, `'visionQc.skipped': true`);
  assert.ok(callSrc, 'could not locate the shippedWithoutQc query (brace-balanced)');
  assert.match(callSrc, /\$or\s*:/, 'shippedWithoutQc must be an $or of two conditions, not a single skipped:true filter');
  assert.match(callSrc, /visionQc\s*:\s*null/,
    'shippedWithoutQc must also match {visionQc: null} — Mongo equality on null matches a MISSING field too, ' +
    'which is what every gate-off-shipped ad (and every ad from before this fix) actually has');
});

check('C5b [2026-08-19] shippedWithoutQc is scoped to SHIPPED statuses only (draft/live/archived), not queued/rendering', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const callSrc = countDocumentsCallAt(handler, `'visionQc.skipped': true`);
  assert.ok(callSrc, 'could not locate the shippedWithoutQc query (brace-balanced)');
  assert.match(callSrc, /status:\s*\{\s*\$in:\s*AD_STATUSES\s*\}/,
    'shippedWithoutQc must exclude in-flight (queued/rendering) ads via a status filter, or it re-introduces ' +
    'the "false alarm on every healthy in-flight run" regression: Ad.visionQc is null on every not-yet-rendered ' +
    'ad too, and an unfiltered {visionQc:null} arm matches those just as readily as a truly shipped-uninspected ad');
});

check('C5c [2026-08-19] qcFailed and qcdOnRetry are NOT status-scoped (a real verdict cannot exist pre-ship, so the guard would be redundant, not wrong to omit)', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const qcFailedCall = countDocumentsCallAt(handler, `'visionQc.disabled': false`);
  const qcdOnRetryCall = countDocumentsCallAt(handler, `'visionQc.finalAttempt'`);
  assert.ok(qcFailedCall && qcdOnRetryCall, 'could not locate both queries');
  // Documents the deliberate asymmetry rather than asserting either shape —
  // if a future edit adds AD_STATUSES scoping here too that is harmless
  // (structurally impossible to match pre-ship), so this is a NON-regression
  // note, not a revert-provable requirement. No assertion beyond "found".
});

check('C6 qcFailed only counts a TRULY inspected, failed verdict (not skipped, not disabled)', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const callSrc = countDocumentsCallAt(handler, `'visionQc.disabled': false`);
  assert.ok(callSrc, 'could not locate the qcFailed query (brace-balanced)');
  assert.match(callSrc, /'visionQc\.skipped':\s*false/, 'qcFailed must exclude skipped verdicts');
  assert.match(callSrc, /'visionQc\.disabled':\s*false/, 'qcFailed must exclude gate-off (disabled) verdicts');
  assert.match(callSrc, /'visionQc\.passed':\s*false/, 'qcFailed must require an actual failed verdict, not a pass');
  assert.match(callSrc, /campaignRunIds:\s*run\.runId/, 'qcFailed must be scoped to this run');
});

check('C7 [2026-08-19] qcdOnRetry requires passed:true — a twice-failed ad must not double-count against qcFailed', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const callSrc = countDocumentsCallAt(handler, `'visionQc.finalAttempt'`);
  assert.ok(callSrc, 'could not locate the qcdOnRetry query (brace-balanced)');
  assert.match(callSrc, /'visionQc\.finalAttempt':\s*\{\s*\$gt:\s*1\s*\}/, 'qcdOnRetry must require finalAttempt > 1');
  assert.match(callSrc, /'visionQc\.passed':\s*true/,
    'qcdOnRetry must require passed:true — without it, an ad that fails BOTH its first attempt and its one ' +
    'allowed regeneration lands in qcFailed AND here, and the banner reads "1 flagged · 1 QC\'d on retry" for ' +
    'what is a single failed ad');
  assert.match(callSrc, /campaignRunIds:\s*run\.runId/, 'qcdOnRetry must be scoped to this run');
});

check('C8 [2026-08-19] qcDisabled counts the deliberate gate-off stamp only, scoped to shipped statuses', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const callSrc = countDocumentsCallAt(handler, `'visionQc.disabled': true`);
  assert.ok(callSrc, 'could not locate the qcDisabled query (brace-balanced)');
  assert.match(callSrc, /status:\s*\{\s*\$in:\s*AD_STATUSES\s*\}/, 'qcDisabled must be scoped to shipped statuses, same as shippedWithoutQc');
  assert.match(callSrc, /campaignRunIds:\s*run\.runId/, 'qcDisabled must be scoped to this run');
});

check('C9 [2026-08-19] qcUnavailable counts skipped-but-not-disabled verdicts only — the live-outage signal, distinct from qcDisabled', () => {
  const handler = sliceFrom("router.get('/runs/:runId'");
  assert.ok(handler);
  const calls = allCountDocumentsCalls(handler);
  const target = calls.find(c =>
    /'visionQc\.skipped':\s*true/.test(c)
    && /'visionQc\.disabled':\s*false/.test(c)
    && /status:\s*\{\s*\$in:\s*AD_STATUSES\s*\}/.test(c)
    && !/\$or\s*:/.test(c)   // must NOT be the same call as shippedWithoutQc (which is $or-shaped)
  );
  assert.ok(target, 'could not find a status-scoped, non-$or query requiring visionQc.skipped:true AND visionQc.disabled:false (qcUnavailable)');
  assert.match(target, /campaignRunIds:\s*run\.runId/, 'qcUnavailable must be scoped to this run');
});

// ── D. Gate-off early returns stamp a disabled verdict, never a bare null ─
// The actual production bug: three call sites short-circuit on
// adVisionQc.isEnabled() === false BEFORE ever reaching runPostRenderQc's /
// runVideoPostRenderQc's own "Flag off" branch (which builds the nice
// {skipped:true, disabled:true, reason:...} shape and is consequently DEAD
// CODE in production while these early returns exist). D2/D3 drive the REAL
// exported functions with adVisionQcService stubbed at the require layer —
// same convention as verifyGenerateProductTenancy.js's adReadinessService
// stub — so `isEnabled` is deterministically false regardless of ambient
// env, and assert the actual returned object, not a source-text guess.
// D4 is a structural pin: directImageRenderService.renderDirectImage's
// "attempt 1" generation makes it too expensive (and billable) to drive
// end-to-end here, same posture as this file's own C-section for GET
// /runs/:runId.

function withStubbedAdVisionQc(modulePath, extra = {}) {
  const qcPath = require.resolve(path.join(__dirname, '..', 'services', 'adVisionQcService.js'));
  const original = require.cache[qcPath];
  const warnCalls = [];
  require.cache[qcPath] = {
    id: qcPath, filename: qcPath, loaded: true,
    exports: {
      isEnabled: () => false,
      // FIXED 2026-08-20 — the three real callers now `await resolveEnabled()`
      // instead of the racy sync `isEnabled()` (see systemConfigService.js /
      // adVisionQcService.js for the TTL-cache-race fix this stub must stay
      // in sync with). This stub must implement BOTH gate functions: a
      // caller missing this would throw `TypeError: ... is not a function`
      // rather than exercising the gate-off branch under test.
      resolveEnabled: async () => false,
      // SPLIT 2026-08-21 — directImageRenderService/imageRecoveryService now
      // call resolveStaticEnabled(), brandScriptExecutor.runVideoVisionQcForAd
      // now calls resolveVideoEnabled(), NEITHER calls the legacy
      // resolveEnabled() above anymore. This helper is shared by callers of
      // both pipelines (D2 = video, D3 = static), so both new resolvers must
      // be present here with the SAME gate-off default, or whichever caller
      // hits the missing one throws `TypeError: ... is not a function`
      // instead of exercising the gate-off branch under test — exactly the
      // stale-stub class this file's own D6 check exists to catch on the
      // production side. A per-check `extra` override can still flip either
      // one to `true` for a gate-on scenario.
      resolveStaticEnabled: async () => false,
      resolveVideoEnabled: async () => false,
      warnQcDisabledOnce: (label) => { warnCalls.push(label); },
      buildPersistedVerdict: (args) => qc.buildPersistedVerdict(args),
      // Delegate to the REAL implementation (pure, no I/O) rather than
      // re-stubbing it — needed by runVideoVisionQcForAd's infra-error catch
      // (services/brandScriptExecutor.js), which now builds a real skipped
      // stub instead of returning null on an internal throw.
      buildSkippedVerdict: (reason) => qc.buildSkippedVerdict(reason),
      ...extra
    }
  };
  // The target module may already be require-cached from earlier in this
  // process (e.g. routes/ads.js pulling it in transitively) with the REAL
  // adVisionQcService baked into its closure — evict it too so it re-requires
  // against the stub just installed above.
  const targetPath = require.resolve(modulePath);
  const originalTarget = require.cache[targetPath];
  delete require.cache[targetPath];
  const mod = require(modulePath);
  return {
    mod,
    warnCalls,
    restore() {
      if (original) require.cache[qcPath] = original; else delete require.cache[qcPath];
      if (originalTarget) require.cache[targetPath] = originalTarget; else delete require.cache[targetPath];
      delete require.cache[targetPath]; // force a clean re-require next time, real deps included
    }
  };
}

await (async () => {
  const { mod: bse, warnCalls, restore } = withStubbedAdVisionQc(path.join('..', 'services', 'brandScriptExecutor.js'));
  try {
    const result = await bse.runVideoVisionQcForAd({
      ad: { _id: '507f1f77bcf86cd799439011', veoReferenceImages: [], campaignRunIds: [] },
      deliveredUrl: 'https://example.com/delivered.mp4'
    });
    check('D2 runVideoVisionQcForAd stamps a disabled verdict (not null) when the gate is off', () => {
      assert.ok(result, 'gate-off must return a stamped verdict object, not null — an absent Ad.visionQc ' +
        'field reads identically to "inspected and passed" everywhere downstream');
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.disabled, true);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.reason, 'vision QC disabled (SystemConfig.videoVisionQcEnabled)');
    });
    check('D2b runVideoVisionQcForAd warns once via the shared gate-off warning', () => {
      assert.deepStrictEqual(warnCalls, ['video ad']);
    });
  } finally {
    restore();
  }
})();

await (async () => {
  const { mod: irs, warnCalls, restore } = withStubbedAdVisionQc(path.join('..', 'services', 'imageRecoveryService.js'));
  try {
    const result = await irs.maybeQcRecoveredPlate({
      ad: { _id: '507f1f77bcf86cd799439011', campaignRunIds: [] },
      brand: {}, surface: {}, dims: { width: 1080, height: 1080 },
      renderUrl: 'https://example.com/recovered.png'
    });
    check('D3 maybeQcRecoveredPlate stamps a disabled verdict (not null) when the gate is off', () => {
      assert.ok(result, 'gate-off must return a stamped verdict object, not null');
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.disabled, true);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.reason, 'vision QC disabled (SystemConfig.staticVisionQcEnabled)');
    });
    check('D3b maybeQcRecoveredPlate warns once via the shared gate-off warning', () => {
      assert.deepStrictEqual(warnCalls, ['recovered ad']);
    });
  } finally {
    restore();
  }
})();

check('D4 directImageRenderService\'s gate-off early return stamps a disabled verdict, not a bare `return firstOutput`', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'directImageRenderService.js'), 'utf8');
  // FIXED 2026-08-20 — the gate is now `await adVisionQc.resolveEnabled()`
  // (assigned to qcEnabledNow), not the racy sync `isEnabled()` peek. Locate
  // via the resolved-boolean guard, which is what actually gates the branch
  // now; a literal `adVisionQc.isEnabled()` search would silently stop
  // finding anything the day that sync path is fully retired.
  // SPLIT 2026-08-21 — this is the STATIC pipeline, so the call is now
  // `resolveStaticEnabled()`, not the legacy shared `resolveEnabled()`.
  const idx = src.indexOf('if (!qcEnabledNow) {');
  assert.ok(idx !== -1, 'could not locate the gate-off early return in directImageRenderService.js');
  // The gate must be resolved via the async, non-racy, STATIC-specific path.
  const gateSetup = src.slice(Math.max(0, idx - 400), idx);
  assert.match(gateSetup, /await\s+adVisionQc\.resolveStaticEnabled\(\)/,
    'the gate must be resolved via awaited resolveStaticEnabled(), not the synchronous isEnabled() TTL-cache peek nor the legacy undifferentiated resolveEnabled()');
  const closeIdx = src.indexOf('\n  }\n', idx); // this branch's own closing brace, one indent level in
  const branch = src.slice(idx, closeIdx !== -1 ? closeIdx : idx + 800);
  assert.doesNotMatch(branch, /return firstOutput;\s*\}/,
    'must not return firstOutput bare — Ad.visionQc would stay null, indistinguishable from "passed"');
  assert.match(branch, /buildPersistedVerdict\(/, 'must stamp the same disabled-verdict shape runPostRenderQc\'s own "Flag off" branch builds');
  assert.match(branch, /disabled:\s*true/, 'the stamped verdict must mark disabled:true (gate off, not an infra skip)');
  assert.match(branch, /warnQcDisabledOnce\(/, 'must warn — a flag left off for weeks must be loud in logs, not silent');
});

check('D6 [2026-08-20, resolver names updated 2026-08-21] the three real callers await their OWN pipeline-specific resolver, not the racy sync isEnabled() peek nor the legacy shared resolveEnabled()', () => {
  // Structural regression guard for the TTL-cache-race fix AND the
  // static/video gate split. A future edit that quietly reintroduces a bare
  // `adVisionQc.isEnabled()` call, OR that calls the WRONG pipeline's
  // resolver (e.g. brandScriptExecutor calling resolveStaticEnabled), OR
  // that reverts to the legacy undifferentiated resolveEnabled(), would
  // reopen either the original cache-race incident or silently merge the
  // two gates back into one. Each site now names its OWN expected resolver
  // — this is deliberately three separate expectations, not one shared
  // regex, because "all three callers use resolveEnabled()" stopped being
  // true the moment the gate split.
  const sites = [
    { file: 'directImageRenderService.js', label: 'directImageRenderService.finishPlate', resolver: 'resolveStaticEnabled' },
    { file: 'brandScriptExecutor.js', label: 'brandScriptExecutor.runVideoVisionQcForAd', resolver: 'resolveVideoEnabled' },
    { file: 'imageRecoveryService.js', label: 'imageRecoveryService.maybeQcRecoveredPlate', resolver: 'resolveStaticEnabled' }
  ];
  for (const { file, label, resolver } of sites) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
    const re = new RegExp(`await\\s+adVisionQc\\.${resolver}\\(\\)`);
    assert.match(src, re, `${label} must await adVisionQc.${resolver}()`);
    // Narrower than "the string never appears": each site must not call
    // the OTHER pipeline's resolver either — that would silently gate one
    // pipeline's spend decision on the other pipeline's flag.
    const otherResolver = resolver === 'resolveStaticEnabled' ? 'resolveVideoEnabled' : 'resolveStaticEnabled';
    const otherRe = new RegExp(`adVisionQc\\.${otherResolver}\\(`);
    assert.doesNotMatch(src, otherRe,
      `${label} must not call adVisionQc.${otherResolver}() — that is the OTHER pipeline's gate`);
    // And must not have quietly reverted to the legacy shared gate either.
    assert.doesNotMatch(src, /await\s+adVisionQc\.resolveEnabled\(\)/,
      `${label} must not revert to the legacy shared adVisionQc.resolveEnabled()`);
  }
  // isEnabled() itself may still exist as a documented legacy sync fallback
  // (adVisionQcService.js exports it, and this harness's own I1/I2 checks
  // above still exercise it directly) — the assertion is narrower than "the
  // string never appears": it is that none of these three FILES calls
  // `adVisionQc.isEnabled(` on the hot path.
  for (const { file, label } of sites) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
    assert.doesNotMatch(src, /adVisionQc\.isEnabled\(/,
      `${label} must not call the synchronous isEnabled() gate anymore`);
  }
});

check('D5 the shared warnQcDisabledOnce gate is genuinely one-shot-per-interval, not per-call', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    qc._resetQcDisabledWarnForTests();
    qc.warnQcDisabledOnce('static ad');
    qc.warnQcDisabledOnce('video ad');
    qc.warnQcDisabledOnce('recovered ad');
    assert.strictEqual(warnings.length, 1, 'three calls within the rewarn interval must produce exactly one log line');
    assert.match(warnings[0], /vision QC is OFF/);
  } finally {
    console.warn = origWarn;
    qc._resetQcDisabledWarnForTests();
  }
});

// ── E. failureDetail: the app and Slack must read the SAME text ─────────
// Owner decision 2026-08-20: a QC-failed ad's detail screen must show what
// was wrong with it, and it must be the EXACT text Slack's vision-QC alert
// already carries — not a second, independently-worded description of the
// same verdict. The mechanism: alertQcFailure (which already builds
// buildQcSlackDetail's text to send as Slack's `detail` field) now RETURNS
// that same string; every call site that persists a QC-failed visionQc onto
// an Ad stamps the return value onto `visionQc.failureDetail` BEFORE
// persisting, and summarizeVisionQc (the shared projection formatter)
// passes that field straight through, verbatim, only when {categories:true}
// (the detail-view flag). Nothing here re-derives prose from a verdict a
// second time — that is the whole guarantee.
function withStubbedAlertService() {
  const alertPath = require.resolve(path.join(__dirname, '..', 'services', 'alertService.js'));
  const original = require.cache[alertPath];
  const calls = [];
  require.cache[alertPath] = {
    id: alertPath, filename: alertPath, loaded: true,
    exports: { notifyAsync: (payload) => { calls.push(payload); } }
  };
  return {
    calls,
    restore() {
      if (original) require.cache[alertPath] = original; else delete require.cache[alertPath];
    }
  };
}

(() => {
  const { calls, restore } = withStubbedAlertService();
  try {
    const visionQc = qc.buildPersistedVerdict({
      passed: false, finalAttempt: 1,
      attempts: [{
        attempt: 1, pass: false, categories: {}, findings: ['bad logo'],
        summary: 'logo mismatch', renderUrl: 'https://x/y.png', discarded: false
      }]
    });
    const returned = qc.alertQcFailure({
      adId: 'a1', brandId: 'b1', productId: 'p1', brandName: 'Acme',
      visionQc, appUrl: 'https://app.example/x'
    });
    check('E1 alertQcFailure returns the EXACT text it sent to Slack as `detail` — byte-identical, not a re-derivation', () => {
      assert.strictEqual(calls.length, 1, 'must have sent exactly one Slack notify');
      assert.strictEqual(typeof returned, 'string');
      assert.strictEqual(returned, calls[0].detail,
        'the returned string must be byte-identical to what Slack actually got — THE guarantee this whole feature rests on');
    });
    check('E2 the returned text equals a fresh buildQcSlackDetail call with the same inputs — one formatter, not two', () => {
      assert.strictEqual(returned, qc.buildQcSlackDetail(visionQc, { appUrl: 'https://app.example/x' }));
    });
  } finally {
    restore();
  }
})();

(() => {
  // alertService itself throwing must never propagate — this alert helper is
  // fire-and-forget by contract (every existing caller ignores the return
  // value; the new callers merely opt IN to reading it). Confirms the return
  // contract stays "string on success, null on failure", not an uncaught throw.
  const alertPath = require.resolve(path.join(__dirname, '..', 'services', 'alertService.js'));
  const original = require.cache[alertPath];
  require.cache[alertPath] = {
    id: alertPath, filename: alertPath, loaded: true,
    exports: { notifyAsync: () => { throw new Error('slack transport down'); } }
  };
  try {
    const visionQc = qc.buildPersistedVerdict({
      passed: false, finalAttempt: 1,
      attempts: [{ attempt: 1, pass: false, categories: {}, findings: [], summary: 'x', renderUrl: null, discarded: false }]
    });
    check('E3 alertQcFailure swallows an alert-transport throw and returns null, never breaks the render path', () => {
      const returned = qc.alertQcFailure({ adId: 'a1', visionQc });
      assert.strictEqual(returned, null);
    });
  } finally {
    if (original) require.cache[alertPath] = original; else delete require.cache[alertPath];
  }
})();

check('E4 summarizeVisionQc(..., {categories:true}) passes visionQc.failureDetail through verbatim (capped 2500 chars)', () => {
  const visionQc = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: false, categories: {}, findings: [], summary: 'x', renderUrl: null, discarded: false }]
  });
  visionQc.failureDetail = 'VERDICT: FAIL\nsomething went wrong';
  const s = qc.summarizeVisionQc(visionQc, { categories: true });
  assert.strictEqual(s.failureDetail, visionQc.failureDetail);
});

check('E5 summarizeVisionQc omits failureDetail from the compact (categories:false) form even when present on the raw doc', () => {
  const visionQc = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: false, categories: {}, findings: [], summary: 'x', renderUrl: null, discarded: false }]
  });
  visionQc.failureDetail = 'some detail text nobody asked for on the list view';
  const s = qc.summarizeVisionQc(visionQc); // categories defaults false
  assert.strictEqual('failureDetail' in s, false, 'list-weight callers must not pay for the rich text they did not ask for');
});

check('E6 summarizeVisionQc never fabricates failureDetail on a passed verdict (the field is only ever written on a real failure)', () => {
  const passedQc = qc.buildPersistedVerdict({
    passed: true, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: true, categories: {}, findings: [], summary: 'clean', renderUrl: null, discarded: false }]
  });
  const s = qc.summarizeVisionQc(passedQc, { categories: true });
  assert.strictEqual('failureDetail' in s, false);
});

// ── F. A real video QC failure now delivers status:'failed', never a
// normal draft ────────────────────────────────────────────────────────────
// Owner decision 2026-08-20 reverses the video pipeline's prior behaviour
// (adVisionQcService.js's own file-header CONTRACT block, and
// runVideoVisionQcForAd's old comment, both said "ships as a normal draft
// anyway; the caller decides not to send that specific ad to a platform").
// The asset itself is still NEVER discarded (money: the ~$0.90 master is
// already paid for) — only the terminal status + reason now tell the truth.
// buildVideoQcFailureFields (brandScriptExecutor.js, pure) is the ONE place
// that decides "does this verdict mean status:'failed'" — shared by BOTH
// call sites (uploadRenderAndStamp's titled path and
// renderBrandScriptAndSave's no-chrome path) so they cannot drift.
check('F1 buildVideoQcFailureFields: a real failure (passed:false, not skipped, not disabled) → status:\'failed\' + a renderError', () => {
  const visionQc = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: false, categories: {}, findings: ['garbled logo'], summary: 'hallucinated colourway', renderUrl: 'https://x/v.mp4', discarded: false }]
  });
  const fields = bse.buildVideoQcFailureFields(visionQc);
  assert.strictEqual(fields.status, 'failed');
  assert.ok(fields.renderError, 'must include a renderError so the operator sees why');
  assert.strictEqual(fields.renderError.stage, 'vision-qc');
  assert.match(fields.renderError.message, /hallucinated colourway/);
  assert.strictEqual(fields.renderError.charged, true, 'the master was already billed — this is not an unbilled infra failure');
});

for (const [label, verdict] of [
  ['F2 skipped (uninspected) verdict', qc.buildSkippedVerdict('no frames could be sampled')],
  ['F3 disabled (gate off) verdict', qc.buildPersistedVerdict({ passed: false, skipped: true, disabled: true, reason: 'vision QC disabled (SystemConfig.staticVisionQcEnabled)', finalAttempt: null, attempts: [] })],
  ['F4 a genuine pass', qc.buildPersistedVerdict({ passed: true, finalAttempt: 1, attempts: [{ attempt: 1, pass: true, categories: {}, findings: [], summary: 'clean', renderUrl: null, discarded: false }] })],
]) {
  check(`${label} must NOT flip status — buildVideoQcFailureFields returns {}`, () => {
    assert.deepStrictEqual(bse.buildVideoQcFailureFields(verdict), {});
  });
}

check('F5 buildVideoQcFailureFields(null) → {} (never throws on a missing verdict)', () => {
  assert.deepStrictEqual(bse.buildVideoQcFailureFields(null), {});
  assert.deepStrictEqual(bse.buildVideoQcFailureFields(undefined), {});
});

await (async () => {
  // Drives the REAL exported runVideoVisionQcForAd (gate forced ON via the
  // stub) with a stubbed runVideoPostRenderQc returning a real-failure
  // verdict, and a stubbed alertQcFailure standing in for the Slack call —
  // proves the function actually captures alertQcFailure's return value and
  // stamps it onto the SAME visionQc object it returns (which is what ends
  // up on Ad.visionQc.failureDetail downstream). Same require-cache-stub
  // convention as D2/D3 above.
  const qcPath = require.resolve(path.join(__dirname, '..', 'services', 'adVisionQcService.js'));
  const original = require.cache[qcPath];
  const fakeVerdict = qc.buildPersistedVerdict({
    passed: false, finalAttempt: 1,
    attempts: [{ attempt: 1, pass: false, categories: {}, findings: ['bad colour'], summary: 'wrong colourway', renderUrl: 'https://x/v.mp4', discarded: false }]
  });
  require.cache[qcPath] = {
    id: qcPath, filename: qcPath, loaded: true,
    exports: {
      isEnabled: () => true,
      // PR #276 switched runVideoVisionQcForAd's live gate check from the
      // synchronous isEnabled() to `await resolveEnabled()` (cache-race
      // fix) — this stub must cover both so this section survives either.
      resolveEnabled: async () => true,
      // SPLIT 2026-08-21 — runVideoVisionQcForAd (exercised below via a
      // fresh brandScriptExecutor require) now calls resolveVideoEnabled(),
      // not the legacy resolveEnabled() above. Missing this throws
      // `TypeError: adVisionQc.resolveVideoEnabled is not a function`
      // instead of exercising the gate-on QC-failure scenario under test.
      resolveVideoEnabled: async () => true,
      buildAppPreviewUrl: () => 'https://app.example/preview',
      runVideoPostRenderQc: async () => ({ ok: true, skipped: false, passed: false, visionQc: fakeVerdict }),
      alertQcFailure: () => 'FAKE_SLACK_DETAIL_TEXT_FOR_TEST',
      noteQcFailToRunFeed: () => {},
      noteQcPassToRunFeed: () => {},
      alertQcSkipped: () => {},
      warnQcDisabledOnce: () => {},
      buildPersistedVerdict: (args) => qc.buildPersistedVerdict(args)
    }
  };
  // adStage does a real (unawaited) Ad.updateOne — harmless in production
  // (fire-and-forget, .catch(()=>{})) but this file promises "No DB, no
  // network" in its own header, so stub it too rather than let a buffered
  // mongoose op float in the background of a CI process with no connection.
  const adStagePath = require.resolve(path.join(__dirname, '..', 'services', 'adStage.js'));
  const originalAdStage = require.cache[adStagePath];
  require.cache[adStagePath] = {
    id: adStagePath, filename: adStagePath, loaded: true,
    exports: { adStage: () => {}, noteRenderIssue: () => {} }
  };
  const bsePath = require.resolve(path.join(__dirname, '..', 'services', 'brandScriptExecutor.js'));
  const originalBse = require.cache[bsePath];
  delete require.cache[bsePath];
  try {
    const freshBse = require(path.join('..', 'services', 'brandScriptExecutor.js'));
    const result = await freshBse.runVideoVisionQcForAd({
      ad: { _id: '507f1f77bcf86cd799439011', veoReferenceImages: ['https://x/orig.png'], campaignRunIds: [] },
      deliveredUrl: 'https://x/v.mp4'
    });
    check('F6 runVideoVisionQcForAd stamps alertQcFailure\'s return value onto the SAME visionQc.failureDetail it returns', () => {
      assert.strictEqual(result.failureDetail, 'FAKE_SLACK_DETAIL_TEXT_FOR_TEST');
    });
    check('F7 buildVideoQcFailureFields on that exact returned verdict flips status to failed', () => {
      assert.strictEqual(bse.buildVideoQcFailureFields(result).status, 'failed');
    });
  } finally {
    if (original) require.cache[qcPath] = original; else delete require.cache[qcPath];
    if (originalAdStage) require.cache[adStagePath] = originalAdStage; else delete require.cache[adStagePath];
    if (originalBse) require.cache[bsePath] = originalBse; else delete require.cache[bsePath];
    delete require.cache[bsePath];
  }
})();

// ── G. routes/catalog.js ads-detail allowlist — the exact trap named in
// the PR description: "a field missing from that allowlist arrives
// `undefined` regardless of the document". This endpoint (Product Ads'
// backing API — the ONLY detail surface that isn't routes/ads.js) omitted
// visionQc/renderError entirely, so a QC-failed ad's reason never reached
// AdDetailModal even though routes/ads.js's projectAd had carried it for a
// long time. Source-scan posture (same as C1/C4/D4 above): this route needs
// a live DB + tenant-scoped product to exercise end-to-end.
check('G1 catalog.js requires summarizeVisionQc from adVisionQcService (single shared formatter, not a re-derivation)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'catalog.js'), 'utf8');
  assert.match(src, /require\(['"]\.\.\/services\/adVisionQcService['"]\)/,
    'catalog.js must reuse adVisionQcService.summarizeVisionQc, not format a QC verdict itself');
});

check('G2 the ads-detail $project allowlist includes visionQc AND renderError', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'catalog.js'), 'utf8');
  const routeIdx = src.indexOf("router.get('/:id/ads-detail'");
  assert.ok(routeIdx !== -1, 'could not locate the ads-detail route');
  const projectIdx = src.indexOf('$project:', routeIdx);
  assert.ok(projectIdx !== -1, 'ads-detail must build its rows off an aggregation $project (the allowlist itself)');
  const projectClose = src.indexOf('} }', projectIdx);
  const projection = src.slice(projectIdx, projectClose !== -1 ? projectClose : projectIdx + 2000);
  assert.match(projection, /visionQc:\s*1/, 'visionQc missing from the $project allowlist — arrives undefined regardless of the document');
  assert.match(projection, /renderError:\s*1/, 'renderError missing from the $project allowlist — same trap');
});

check('G3 the shaped ad row actually surfaces visionQc (via summarizeVisionQc) and a conditional renderErrorMessage', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'catalog.js'), 'utf8');
  const routeIdx = src.indexOf("router.get('/:id/ads-detail'");
  // Anchor on the actual declaration, not a bare 'adRows' substring — a
  // 2026-08-20 comment earlier in this same route now mentions `adRows` in
  // backticks while explaining an unrelated renderStage fix, which an
  // indexOf('adRows', ...) would find FIRST and then slice 4000 chars of
  // comment prose instead of the real map body.
  const mapIdx = src.indexOf('const adRows = ads.map(', routeIdx);
  assert.ok(mapIdx !== -1, 'could not locate the adRows shaping block');
  const tail = src.slice(mapIdx, mapIdx + 4000);
  assert.match(tail, /visionQc:\s*summarizeVisionQc\(/, 'the shaped row must carry visionQc through the shared formatter, not the raw Mixed doc');
  assert.match(tail, /renderErrorMessage/, 'a failed ad\'s operator-facing reason never reaches this endpoint\'s response otherwise');
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
