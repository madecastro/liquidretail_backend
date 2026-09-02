#!/usr/bin/env node
'use strict';
/**
 * verifyOverrideQcGuard — behavioural harness for
 * POST /api/ads/:id/override-qc (routes/ads.js), the operator-initiated
 * "revive a QC-rejected ad" endpoint (status:'failed' -> 'draft').
 *
 * WHY THIS EXISTS. This is a brand-safety-relevant bypass of an automated
 * vision-QC rejection, added 2026-09-02. Getting any of these wrong is either
 * a safety hole (a non-QC failure, or an in-flight regenerate/retitle, gets
 * silently revived) or an accountability hole (the audit trail doesn't
 * actually say what happened). A source-text regex can see the words
 * "isQc" or "regenerating" exist somewhere in routes/ads.js; it cannot tell
 * a working guard from a comment describing one, or a guard that fires from
 * one that fires on the WRONG branch. This harness instead:
 *
 *   A. Drives the REAL exported `overrideQcInFlightRefusal` predicate
 *      (routes/ads.js) against synthetic Ad docs.
 *   B. Drives the REAL exported `buildOverrideQcCasFilter` — the write-side
 *      twin — through a tiny Mongo-operator evaluator, and cross-checks it
 *      against A on every shape (the "read/write agree" pattern
 *      scripts/verifyRegeneratePreflightInflight.js already established for
 *      the sibling regenerate guard).
 *   C. Drives the REAL, already-shared services/adPhase.js classifier
 *      (deriveAdPhase + describeAdFailure) against realistic Ad-doc shapes,
 *      to prove the QC-relatedness call this endpoint's entire safety
 *      argument rests on is not re-derived independently and does not drift.
 *   D. WIRING, not just correctness (same rationale as verifyRegenerate-
 *      PreflightInflight's D7/D8 group, and the exact "asserts the helper,
 *      not the call site" gap CLAUDE.md's §4 receiptFree incident is about):
 *      pulls the REAL Express handler off the compiled router's stack and
 *      invokes it end-to-end against monkey-patched Ad/Brand MODEL objects
 *      (not stubbed modules — routes/ads.js holds a direct, non-destructured
 *      reference to each, so mutating the model's own static methods after
 *      require is visible to the route, no require.cache surgery needed).
 *      Proves the guards actually gate the HTTP response, and that the
 *      success write really is the minimal $set the design promises
 *      (status + the four qcOverride* fields + updatedAt — NOTHING else,
 *      in particular never renderUrl/veoVideoUrl/renderError/visionQc/copy).
 *   E. MERGE-ORDER — the new schema fields stay declared (mongoose silently
 *      drops writes to undeclared paths — CLAUDE.md §4's own warning, which
 *      models/Ad.js's preArchiveIdentityDigest comment already flags for
 *      exactly this class of field) and the status literals this file
 *      hardcodes ('failed', 'draft') still exist in the real enum.
 *
 * Run: node scripts/verifyOverrideQcGuard.js
 *      (no live DB, no network, no API key — Ad/Brand are real compiled
 *      mongoose models with their static methods monkey-patched per call)
 */
const assert = require('assert');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { fail++; console.log(`  ✗ ${label} — ${String(e.message).split('\n')[0].slice(0, 240)}`); }
}

console.log('\nQC override endpoint (POST /:id/override-qc) — guard + wiring behavioural harness');

const {
  overrideQcInFlightRefusal,
  buildOverrideQcCasFilter
} = require('../routes/ads.js');
const { deriveAdPhase, describeAdFailure } = require('../services/adPhase');

const AD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BRAND_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function baseAd(over = {}) {
  return {
    _id: AD_ID,
    brandId: BRAND_ID,
    status: 'failed',
    kind: 'image',
    regenerating: false,
    claimedByWorker: null,
    retitleClaimedByWorker: null,
    retitleRequest: null,
    renderUrl: null,
    veoVideoUrl: null,
    renderError: { stage: 'vision-qc', message: 'competitor_marks flagged' },
    visionQc: { passed: false, skipped: false },
    ...over
  };
}

// ── Group A — overrideQcInFlightRefusal, the pure read-side predicate ─────
check('A0 overrideQcInFlightRefusal and buildOverrideQcCasFilter are exported and callable', () => {
  assert.strictEqual(typeof overrideQcInFlightRefusal, 'function');
  assert.strictEqual(typeof buildOverrideQcCasFilter, 'function');
});
check('A1 a clean QC-failed ad is NOT refused', () => {
  assert.strictEqual(overrideQcInFlightRefusal(baseAd()), null);
});
check('A2 [SAFETY] regenerating:true is refused, names regeneration', () => {
  const r = overrideQcInFlightRefusal(baseAd({ regenerating: true }));
  assert.ok(r, 'expected a refusal — an active regenerate must block the override');
  assert.ok(/regeneration/i.test(r), `wrong message: ${r}`);
});
check('A3 [SAFETY] claimedByWorker set is refused, names the renderer worker', () => {
  const r = overrideQcInFlightRefusal(baseAd({ claimedByWorker: 'renderer-abc123' }));
  assert.ok(r, 'expected a refusal');
  assert.ok(/renderer worker/i.test(r), `wrong message: ${r}`);
});
check('A4 [SAFETY] retitleClaimedByWorker set is refused, names retitle', () => {
  const r = overrideQcInFlightRefusal(baseAd({ retitleClaimedByWorker: 'retitle-abc123' }));
  assert.ok(r, 'expected a refusal');
  assert.ok(/retitle/i.test(r), `wrong message: ${r}`);
});
check('A5 [SAFETY] a stamped-but-not-yet-claimed retitleRequest object is ALSO refused', () => {
  const r = overrideQcInFlightRefusal(baseAd({ retitleRequest: { kind: 'manual-retitle', requestedBy: 'x' } }));
  assert.ok(r, 'expected a refusal — an unclaimed but stamped retitle is still in flight');
  assert.ok(/retitle/i.test(r), `wrong message: ${r}`);
});
check('A6 retitleRequest: null (the overwhelmingly common shape) is NOT refused', () => {
  assert.strictEqual(overrideQcInFlightRefusal(baseAd({ retitleRequest: null })), null);
});
check('A7 each refusal has its OWN distinctive phrase (no cross-branch collision)', () => {
  const regen = overrideQcInFlightRefusal(baseAd({ regenerating: true }));
  const claim = overrideQcInFlightRefusal(baseAd({ claimedByWorker: 'w' }));
  const retitle = overrideQcInFlightRefusal(baseAd({ retitleClaimedByWorker: 'w' }));
  assert.notStrictEqual(regen, claim);
  assert.notStrictEqual(claim, retitle);
  assert.notStrictEqual(regen, retitle);
});

// ── Group B — buildOverrideQcCasFilter, the write-side twin ──────────────
// A deliberately tiny Mongo evaluator covering exactly the one operator this
// filter uses ($ne) plus plain equality (including null).
function matchClause(doc, clause) {
  return Object.entries(clause).every(([k, v]) => {
    const actual = doc[k] === undefined ? null : doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.entries(v).every(([op, operand]) => {
        if (op === '$ne') return actual !== operand;
        throw new Error(`evaluator missing operator ${op}`);
      });
    }
    return actual === v;
  });
}
const casMatches = (over) => matchClause(
  baseAd(over),
  buildOverrideQcCasFilter({ id: AD_ID, brandId: BRAND_ID })
);

check('B1 the CAS filter is built from exactly the fields the read-side guard checks', () => {
  const f = buildOverrideQcCasFilter({ id: 'x', brandId: 'y' });
  assert.strictEqual(f._id, 'x');
  assert.strictEqual(f.brandId, 'y');
  assert.strictEqual(f.status, 'failed');
  assert.deepStrictEqual(f.regenerating, { $ne: true });
  assert.strictEqual(f.claimedByWorker, null);
  assert.strictEqual(f.retitleClaimedByWorker, null);
  assert.strictEqual(f.retitleRequest, null);
});
check('B2 [MONEY/SAFETY] the CAS filter still matches a clean failed row', () => {
  assert.strictEqual(casMatches({}), true);
});
check('B3 [SAFETY] the CAS filter does NOT match once regenerating flips true', () => {
  assert.strictEqual(casMatches({ regenerating: true }), false);
});
check('B4 [SAFETY] the CAS filter does NOT match once claimedByWorker is set', () => {
  assert.strictEqual(casMatches({ claimedByWorker: 'w' }), false);
});
check('B5 [SAFETY] the CAS filter does NOT match once retitleClaimedByWorker is set', () => {
  assert.strictEqual(casMatches({ retitleClaimedByWorker: 'w' }), false);
});
check('B6 [SAFETY] the CAS filter does NOT match once retitleRequest is (re)stamped', () => {
  assert.strictEqual(casMatches({ retitleRequest: { kind: 'x' } }), false);
});
check('B7 [SAFETY] the CAS filter does NOT match a row whose status moved off failed', () => {
  assert.strictEqual(casMatches({ status: 'draft' }), false);
  assert.strictEqual(casMatches({ status: 'rendering' }), false);
});
check('B8 read side and write side AGREE on every shape (no drift between the twins)', () => {
  for (const over of [
    {}, { regenerating: true }, { claimedByWorker: 'w' },
    { retitleClaimedByWorker: 'w' }, { retitleRequest: { kind: 'x' } },
    { retitleRequest: null }, { status: 'draft' }
  ]) {
    const readRefuses = overrideQcInFlightRefusal(baseAd(over)) !== null;
    const writeRefuses = !casMatches(over);
    // status:'draft' is a special case: the read-side predicate never looks
    // at status at all (that guard lives one step earlier in the route, as
    // a plain equality check before this predicate even runs) — the CAS
    // filter is what actually re-asserts status:'failed' as part of the
    // atomic write. So they are expected to disagree on THIS one shape,
    // and only this one.
    if (JSON.stringify(over) === JSON.stringify({ status: 'draft' })) {
      assert.strictEqual(readRefuses, false, 'sanity: read-side predicate ignores status');
      assert.strictEqual(writeRefuses, true, 'sanity: CAS filter still re-asserts status:failed');
      return;
    }
    assert.strictEqual(readRefuses, writeRefuses, `disagree on ${JSON.stringify(over)}: read=${readRefuses} write=${writeRefuses}`);
  }
});

// ── Group C — real QC-relatedness classification (services/adPhase.js) ───
// This is the actual safety argument: "isQc" is never re-derived by the
// route, only read off the SAME function every other surface (Slack,
// projectAd's `failure` field) calls.
function classify(ad) {
  const phase = deriveAdPhase(ad);
  return { phase, failure: describeAdFailure(ad, phase) };
}
check('C1 a video QC failure with the asset KEPT classifies as qc-failed-kept, isQc true', () => {
  const { phase, failure } = classify(baseAd({
    kind: 'video', renderUrl: 'https://cdn/x.mp4',
    visionQc: { passed: false, skipped: false },
    renderError: { stage: 'vision-qc' }
  }));
  assert.strictEqual(phase, 'qc-failed-kept');
  assert.ok(failure && failure.isQc === true, 'expected isQc:true');
});
check('C2 a QC failure WITHOUT a kept asset still classifies isQc true (via renderError.stage)', () => {
  const { phase, failure } = classify(baseAd({
    renderUrl: null, renderError: { stage: 'vision-qc' }, visionQc: null
  }));
  assert.strictEqual(phase, 'failed-terminal');
  assert.ok(failure && failure.isQc === true, 'expected isQc:true');
});
check('C3 the vision-qc-recovery stage also classifies isQc true', () => {
  const { failure } = classify(baseAd({ renderError: { stage: 'vision-qc-recovery' }, visionQc: null }));
  assert.ok(failure && failure.isQc === true, 'expected isQc:true');
});
check('C4 [SAFETY] a hard render failure is NOT classified as QC', () => {
  const { failure } = classify(baseAd({ renderError: { stage: 'render' }, visionQc: null }));
  assert.ok(failure, 'expected a failure description');
  assert.strictEqual(failure.isQc, false);
  assert.notStrictEqual(failure.label, 'QC Fail');
});
check('C5 [SAFETY] a reclaimed stale claim (reaper) is NOT classified as QC', () => {
  const { failure } = classify(baseAd({ renderError: { stage: 'reaper' }, visionQc: null }));
  assert.ok(failure);
  assert.strictEqual(failure.isQc, false);
});
check('C6 [SAFETY] a failure with no renderError.stage at all is NOT classified as QC', () => {
  const { failure } = classify(baseAd({ renderError: null, visionQc: null }));
  assert.ok(failure, 'describeAdFailure must still describe SOMETHING for a failed-terminal ad');
  assert.strictEqual(failure.isQc, false);
  assert.strictEqual(failure.label, 'Failed');
});
check('C7 a non-failed ad never produces a truthy failure description', () => {
  const { failure } = classify(baseAd({ status: 'draft', renderError: null }));
  assert.strictEqual(failure, null);
});

// ── Group D — WIRING: drive the REAL Express handler end-to-end ──────────
const AdModel = require('../models/Ad');
const BrandModel = require('../models/Brand');
const adsRouterModule = require('../routes/ads.js');

function findRouteHandler(method, routePath) {
  const layer = adsRouterModule.stack.find((l) =>
    l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) return null;
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle; // last middleware = the async handler
}
const overrideQcHandler = findRouteHandler('post', '/:id/override-qc');

check('D0 the route is registered and resolves to a callable handler', () => {
  assert.strictEqual(typeof overrideQcHandler, 'function');
});

/**
 * Drives the REAL handler with Ad/Brand model methods monkey-patched for the
 * duration of one call (restored in `finally`, so calls cannot leak into
 * each other — each test builds its own row/result fixtures).
 */
async function callRoute({ row, body, reqOverrides = {}, findOneAndUpdateResult = undefined } = {}) {
  const origBrandFindOne = BrandModel.findOne;
  const origAdFindOne = AdModel.findOne;
  const origAdFOAU = AdModel.findOneAndUpdate;
  const fouauCalls = [];
  BrandModel.findOne = () => ({ lean: async () => ({ _id: BRAND_ID }) });
  AdModel.findOne = () => ({ lean: async () => row });
  AdModel.findOneAndUpdate = (filter, update, opts) => {
    fouauCalls.push({ filter, update, opts });
    const result = findOneAndUpdateResult === undefined
      ? { ...row, ...(update.$set || {}) }
      : findOneAndUpdateResult;
    return { lean: async () => result };
  };
  const req = {
    params: { id: AD_ID },
    query: { brandId: BRAND_ID },
    headers: {},
    body: body === undefined ? { reason: 'human review confirmed this is brand-safe' } : body,
    user: { userId: 'operator-1' },
    advertiserId: 'advertiser-1',
    ...reqOverrides
  };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; }
  };
  try {
    await overrideQcHandler(req, res);
  } finally {
    BrandModel.findOne = origBrandFindOne;
    AdModel.findOne = origAdFindOne;
    AdModel.findOneAndUpdate = origAdFOAU;
  }
  return { statusCode, jsonBody, fouauCalls };
}

const CLEAN_QC_FAILED_VIDEO = () => baseAd({
  kind: 'video',
  renderUrl: 'https://cdn/x.mp4',
  veoVideoUrl: 'https://cdn/master.mp4',
  visionQc: { passed: false, skipped: false, attempts: [{ categories: {} }] },
  renderError: { stage: 'vision-qc', message: 'competitor_marks flagged' }
});

(async () => {
  const happy = await callRoute({ row: CLEAN_QC_FAILED_VIDEO() });
  check('D1 [HAPPY PATH] a clean QC-failed ad is revived: 200, status draft', () => {
    assert.strictEqual(happy.statusCode, 200, `body: ${JSON.stringify(happy.jsonBody)}`);
    assert.ok(happy.jsonBody && happy.jsonBody.ad, 'expected {ad} in the response');
    assert.strictEqual(happy.jsonBody.ad.status, 'draft');
  });
  check('D2 [AUDIT TRAIL] the success write stamps all four qcOverride* fields + who/reason', () => {
    assert.strictEqual(happy.jsonBody.ad.qcOverridden, true);
    assert.ok(happy.jsonBody.ad.qcOverriddenAt, 'qcOverriddenAt missing');
    assert.strictEqual(happy.jsonBody.ad.qcOverriddenBy, 'operator-1');
    assert.strictEqual(happy.jsonBody.ad.qcOverrideReason, 'human review confirmed this is brand-safe');
  });
  check('D3 [MONEY/SAFETY] the success write is a MINIMAL $set — never renderUrl/veoVideoUrl/renderError/visionQc/copy', () => {
    assert.strictEqual(happy.fouauCalls.length, 1, 'expected exactly one findOneAndUpdate call');
    const set = happy.fouauCalls[0].update.$set;
    const keys = Object.keys(set).sort();
    assert.deepStrictEqual(
      keys,
      ['qcOverriddenAt', 'qcOverriddenBy', 'qcOverrideReason', 'qcOverridden', 'status', 'updatedAt'].sort(),
      `the $set carries unexpected keys — a regenerate-shaped write snuck in: ${JSON.stringify(keys)}`
    );
    assert.strictEqual(set.status, 'draft');
  });
  check('D4 [MONEY/SAFETY] the write actually used the REAL CAS filter (wiring, not just B2-B7 in isolation)', () => {
    const filter = happy.fouauCalls[0].filter;
    assert.deepStrictEqual(filter, buildOverrideQcCasFilter({ id: AD_ID, brandId: BRAND_ID }),
      'the route built a different filter than the exported, independently-tested one — B-group coverage would not catch this');
  });

  const notFailed = await callRoute({ row: baseAd({ status: 'draft' }) });
  check('D5 [SAFETY] a non-failed ad is refused 409 (not a general status editor)', () => {
    assert.strictEqual(notFailed.statusCode, 409);
    assert.ok(/only applies to a failed ad/i.test(notFailed.jsonBody.error), `wrong message: ${notFailed.jsonBody.error}`);
  });

  const nonQc = await callRoute({ row: baseAd({ renderError: { stage: 'render' }, visionQc: null }) });
  check('D6 [SAFETY] a non-QC failure is HARD REFUSED 409, never revived', () => {
    assert.strictEqual(nonQc.statusCode, 409);
    assert.ok(/not a QC rejection/i.test(nonQc.jsonBody.error), `wrong message: ${nonQc.jsonBody.error}`);
  });

  const inFlight = await callRoute({ row: baseAd({ regenerating: true }) });
  check('D7 [SAFETY] an in-flight regenerate is refused 409 (the same phrase as the pure predicate)', () => {
    assert.strictEqual(inFlight.statusCode, 409);
    assert.ok(/regeneration/i.test(inFlight.jsonBody.error), `wrong message: ${inFlight.jsonBody.error}`);
  });

  const noReason = await callRoute({ row: CLEAN_QC_FAILED_VIDEO(), body: {} });
  check('D8 a missing reason is refused 400 (mandatory audit trail, not optional)', () => {
    assert.strictEqual(noReason.statusCode, 400);
  });

  const shortReason = await callRoute({ row: CLEAN_QC_FAILED_VIDEO(), body: { reason: 'ok' } });
  check('D9 a too-short reason is refused 400', () => {
    assert.strictEqual(shortReason.statusCode, 400);
  });

  const longReason = await callRoute({ row: CLEAN_QC_FAILED_VIDEO(), body: { reason: 'x'.repeat(1001) } });
  check('D10 an over-long reason is refused 400', () => {
    assert.strictEqual(longReason.statusCode, 400);
  });

  const lostRace = await callRoute({ row: CLEAN_QC_FAILED_VIDEO(), findOneAndUpdateResult: null });
  check('D11 [MONEY/SAFETY] losing the atomic race (findOneAndUpdate -> null) is a clean 409, never a silent no-op', () => {
    assert.strictEqual(lostRace.statusCode, 409);
    assert.ok(/state changed/i.test(lostRace.jsonBody.error), `wrong message: ${lostRace.jsonBody.error}`);
  });

  const missingAd = await callRoute({ row: null });
  check('D12 a missing ad is refused 404', () => {
    assert.strictEqual(missingAd.statusCode, 404);
  });

  const noBrandId = await callRoute({ row: CLEAN_QC_FAILED_VIDEO(), reqOverrides: { query: {} } });
  check('D13 a missing brandId is refused 400 before any DB read', () => {
    assert.strictEqual(noBrandId.statusCode, 400);
  });

  // ── Group E — MERGE-ORDER guards ────────────────────────────────────
  check('E1 [MERGE-ORDER] qcOverridden/qcOverriddenAt/qcOverriddenBy/qcOverrideReason stay declared on the schema', () => {
    for (const f of ['qcOverridden', 'qcOverriddenAt', 'qcOverriddenBy', 'qcOverrideReason']) {
      assert.ok(AdModel.schema.path(f), `Ad.${f} is no longer declared — mongoose strict mode will silently drop this write (CLAUDE.md §4)`);
    }
  });
  check('E2 [MERGE-ORDER] Ad.status enum still contains both literals this route hardcodes', () => {
    const enumValues = AdModel.schema.path('status').enumValues;
    assert.ok(enumValues.includes('failed'), "'failed' missing from Ad.status enum");
    assert.ok(enumValues.includes('draft'), "'draft' missing from Ad.status enum");
  });
  check('E3 [MERGE-ORDER] the fields the in-flight guard reads are still on the schema', () => {
    for (const f of ['regenerating', 'claimedByWorker', 'retitleClaimedByWorker', 'retitleRequest']) {
      assert.ok(AdModel.schema.path(f), `Ad.${f} no longer exists — the guard reads a field that is gone`);
    }
  });

  console.log(`\n${fail ? '❌' : '✅'} verifyOverrideQcGuard: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
