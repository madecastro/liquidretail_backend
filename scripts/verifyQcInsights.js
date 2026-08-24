#!/usr/bin/env node
'use strict';
/**
 * verifyQcInsights — offline guard for the QC-insights feedback loop
 * and the static segment-override hook.
 *
 * No DB, no network. LLM transport is stubbed via require.cache.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    if (typeof fn === 'function') fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
}

const PRODUCT = {
  desc: "Men's seamless long-sleeve training top in HEATHER GREY-BLUE (a muted, desaturated grey-blue marl — NOT royal blue, NOT navy, NOT bright blue), tonal diamond-jacquard texture panels, small Gymshark logo on the chest, close athletic fit",
  look: 'high-contrast athletic editorial, charcoal and cool concrete grey, one acid volt-green accent, raw gym environment',
  logoCorner: 'bottom-right'
};
const DATA = {
  rating: '4.8', reviewCount: '1,200+', quote: 'Fits true to size and never rides up.',
  attribution: 'Verified Buyer', badge: 'TOP RATED', headline: 'BE A VISIONARY', cta: 'SHOP NOW'
};

const BASELINE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'qcInsightsPromptBaseline.txt'),
  'utf8'
);

console.log('\nverifyQcInsights\n');

const intents = require('../services/staticAdIntents');
intents._setSegmentOverridesForTests([]);

check('B1 empty override table → prompt BYTE-IDENTICAL to pre-change fixture', () => {
  const r = intents.buildPrompt({
    intentKey: 'brand_led', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
  });
  assert.strictEqual(r.prompt, BASELINE);
  assert.deepStrictEqual(r.appliedOverrides, []);
});

check('B1b flag off → prompt BYTE-IDENTICAL to the SAME fixture (not merely to empty-table output)', () => {
  const intentsKey = require.resolve('../services/staticAdIntents');
  const pfKey = require.resolve('../services/platformFormats');
  const savedIntents = require.cache[intentsKey];
  const savedPf = require.cache[pfKey];
  const prev = process.env.STATIC_SEGMENT_PROMPT_OVERRIDES;
  delete require.cache[intentsKey];
  delete require.cache[pfKey];
  process.env.STATIC_SEGMENT_PROMPT_OVERRIDES = 'false';
  try {
    const offMod = require('../services/staticAdIntents');
    offMod._setSegmentOverridesForTests([
      { id: 'should-not-apply', enabled: true, match: {}, appendText: 'NEVER APPEAR' }
    ]);
    const r = offMod.buildPrompt({
      intentKey: 'brand_led', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
    });
    assert.strictEqual(offMod.SEGMENT_OVERRIDES_ENABLED, false);
    assert.strictEqual(r.prompt, BASELINE);
    assert.deepStrictEqual(r.appliedOverrides, []);
  } finally {
    if (prev === undefined) delete process.env.STATIC_SEGMENT_PROMPT_OVERRIDES;
    else process.env.STATIC_SEGMENT_PROMPT_OVERRIDES = prev;
    if (savedIntents) require.cache[intentsKey] = savedIntents;
    else delete require.cache[intentsKey];
    if (savedPf) require.cache[pfKey] = savedPf;
    else delete require.cache[pfKey];
  }
});

const {
  matchSegmentOverride, applySegmentOverrides, promptFlagsSnapshot, _setSegmentOverridesForTests
} = require('../services/staticAdIntents');

check('B2 match: surface/intent/seedStyle/variantKind/categoryPrefix AND; disabled/missing id skip', () => {
  const ctx = {
    seedStyle: 'lifestyle',
    variantKind: 'product_image',
    surface: 'meta_feed_1_1',
    intent: 'brand_led',
    categoryPath: 'Apparel > Outerwear'
  };
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: { surface: 'meta_feed_1_1' }, appendText: 'x'
  }, ctx), true);
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: { intent: 'social_proof_led' }, appendText: 'x'
  }, ctx), false);
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: { seedStyle: 'lifestyle', variantKind: 'product_image' }, appendText: 'x'
  }, ctx), true);
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: { categoryPrefix: 'apparel' }, appendText: 'x'
  }, ctx), true);
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: { categoryPrefix: 'Shoes' }, appendText: 'x'
  }, ctx), false);
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: false, match: {}, appendText: 'x'
  }, ctx), false);
  assert.strictEqual(matchSegmentOverride({
    enabled: true, match: {}, appendText: 'x'
  }, ctx), false, 'missing id cannot apply');
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: {}, appendText: ''
  }, ctx), false, 'empty appendText cannot apply');
  assert.strictEqual(matchSegmentOverride({
    id: 'ok', enabled: true, match: { categoryPrefix: 'Apparel' }, appendText: 'x'
  }, { ...ctx, categoryPath: '' }), false, 'empty categoryPath fails prefix');
});

check('B3 append-only: output starts with the unmodified baseline', () => {
  _setSegmentOverridesForTests([
    { id: 'add-1', enabled: true, match: { surface: 'meta_feed_1_1' }, appendText: 'Keep the knit texture.' }
  ]);
  const r = intents.buildPrompt({
    intentKey: 'brand_led', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
  });
  assert.ok(r.prompt.startsWith(BASELINE), 'appended prompt must start with the unmodified baseline');
  assert.ok(r.prompt.includes('ADDITIONAL DIRECTIVES'));
  assert.ok(r.prompt.includes('Keep the knit texture.'));
  assert.deepStrictEqual(r.appliedOverrides, ['add-1']);
  _setSegmentOverridesForTests([]);
  const r2 = intents.buildPrompt({
    intentKey: 'brand_led', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
  });
  assert.strictEqual(r2.prompt, BASELINE, 'empty table is a no-op again');
});

check('B4 promptFlagsSnapshot includes the five flags', () => {
  const snap = promptFlagsSnapshot();
  assert.strictEqual(typeof snap.fidelityHardening, 'boolean');
  assert.strictEqual(typeof snap.lifestylePreserve, 'boolean');
  assert.strictEqual(typeof snap.brandLedCopy, 'boolean');
  assert.strictEqual(typeof snap.segmentOverridesEnabled, 'boolean');
  assert.strictEqual(typeof snap.ratingFurniture, 'boolean');
});

const insights = require('../services/qcInsightsService');

check('C1 judgedStatus: skipped/disabled/missing → unjudged; else judged', () => {
  assert.strictEqual(insights.judgedStatus(null), 'unjudged');
  assert.strictEqual(insights.judgedStatus({ skipped: true }), 'unjudged');
  assert.strictEqual(insights.judgedStatus({ disabled: true, skipped: true }), 'unjudged');
  assert.strictEqual(insights.judgedStatus({ passed: true, attempts: [{}] }), 'judged');
});

check('C2 extractVerdictFacts: regenRescued when attempt 1 fails and later passes', () => {
  const rescued = insights.extractVerdictFacts({
    passed: true,
    attempts: [
      { attempt: 1, pass: false, categories: { competitor_marks: { pass: false, findings: ['tree emblem'] } } },
      { attempt: 2, pass: true, categories: { competitor_marks: { pass: true, findings: [] } } }
    ]
  });
  assert.strictEqual(rescued.judged, true);
  assert.strictEqual(rescued.passed, true);
  assert.strictEqual(rescued.attempt1Fail, true);
  assert.strictEqual(rescued.regenRescued, true);
  const clean = insights.extractVerdictFacts({
    passed: true,
    attempts: [{ attempt: 1, pass: true, categories: { competitor_marks: { pass: true, findings: [] } } }]
  });
  assert.strictEqual(clean.attempt1Fail, false);
  assert.strictEqual(clean.regenRescued, false);
});

check('C3 segmentKeysForAd unstamped fallbacks', () => {
  const keys = insights.segmentKeysForAd({}, null, null);
  assert.strictEqual(keys.categoryTop, 'unknown');
  assert.strictEqual(keys.shotType, 'unknown');
  assert.strictEqual(keys.seedStyle, 'unstamped');
  assert.strictEqual(keys.surface, 'unknown');
  assert.strictEqual(keys.intent, 'unknown');
  const keys2 = insights.segmentKeysForAd(
    { platformFormat: 'meta_feed_1_1', intentResolution: { seedStyle: 'lifestyle', delivered: 'brand_led' } },
    { inferredBreadcrumb: ['Apparel', 'Outerwear'] },
    { classification: { shotType: 'on_model' } }
  );
  assert.strictEqual(keys2.categoryTop, 'Apparel > Outerwear');
  assert.strictEqual(keys2.shotType, 'on_model');
  assert.strictEqual(keys2.seedStyle, 'lifestyle');
  assert.strictEqual(keys2.surface, 'meta_feed_1_1');
  assert.strictEqual(keys2.intent, 'brand_led');
});

function judgedRow(opts) {
  const facts = insights.extractVerdictFacts({
    passed: opts.passed,
    attempts: [{
      attempt: 1,
      pass: opts.attempt1Pass,
      categories: {
        competitor_marks: { pass: !opts.cmFail, findings: opts.cmFail ? ['tree'] : [] },
        product_fidelity: { pass: !opts.pfFail, findings: opts.pfFail ? ['wrong colour'] : [] },
        text_defects: { pass: true, findings: [] },
        layout_safe_box: { pass: true, findings: [] }
      }
    }]
  });
  return {
    ad: { intentResolution: opts.ir || {} },
    facts,
    segments: opts.segments
  };
}

check('C4 computeStats totals + per-category math', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(judgedRow({
      passed: i >= 5,
      attempt1Pass: i >= 5,
      cmFail: i < 5,
      pfFail: false,
      segments: { surface: 'meta_feed_1_1', seedStyle: 'unstamped' }
    }));
  }
  const stats = insights.computeStats(rows);
  assert.strictEqual(stats.totals.judged, 20);
  assert.strictEqual(stats.totals.passed, 15);
  assert.strictEqual(stats.totals.attempt1Fails, 5);
  assert.ok(Math.abs(stats.totals.passRate - 0.75) < 1e-9);
  assert.ok(Math.abs(stats.totals.attempt1FailRate - 0.25) < 1e-9);
  assert.strictEqual(stats.categories.competitor_marks.fails, 5);
  assert.strictEqual(stats.categories.product_fidelity.fails, 0);
});

check('C5 classifySegmentVerdicts: concentrated vs insufficient vs clean', () => {
  const concentrated = [];
  for (let i = 0; i < 20; i++) {
    concentrated.push(judgedRow({
      passed: false, attempt1Pass: false, cmFail: true, pfFail: false,
      segments: { surface: 'meta_stories_9_16', seedStyle: 'unstamped' }
    }));
  }
  for (let i = 0; i < 20; i++) {
    concentrated.push(judgedRow({
      passed: true, attempt1Pass: true, cmFail: false, pfFail: false,
      segments: { surface: 'meta_feed_1_1', seedStyle: 'unstamped' }
    }));
  }
  const statsC = insights.computeStats(concentrated);
  const vC = insights.classifySegmentVerdicts(statsC, 20);
  assert.strictEqual(vC.competitor_marks.verdict, 'segment-specific');
  assert.ok(vC.competitor_marks.concentrations.some((c) => c.dimension === 'surface' && c.value === 'meta_stories_9_16'));
  assert.strictEqual(vC.product_fidelity.verdict, 'clean');

  const thin = [];
  for (let i = 0; i < 5; i++) {
    thin.push(judgedRow({
      passed: true, attempt1Pass: true, cmFail: false, pfFail: false,
      segments: { surface: 'meta_feed_1_1' }
    }));
  }
  const vThin = insights.classifySegmentVerdicts(insights.computeStats(thin), 20);
  assert.strictEqual(vThin.competitor_marks.verdict, 'insufficient-data');
});

check('C6 clusterFindings groups by category+text', () => {
  const rows = [
    judgedRow({ passed: false, attempt1Pass: false, cmFail: true, pfFail: false, segments: { surface: 'a' } }),
    judgedRow({ passed: false, attempt1Pass: false, cmFail: true, pfFail: false, segments: { surface: 'b' } })
  ];
  const clusters = insights.clusterFindings(rows);
  assert.ok(clusters.length >= 1);
  assert.strictEqual(clusters[0].n, 2);
  assert.strictEqual(clusters[0].category, 'competitor_marks');
});

check('C7 compareArms groups by prompt flags/sha', () => {
  const rows = [
    judgedRow({
      passed: true, attempt1Pass: true, cmFail: false, pfFail: false,
      segments: { surface: 'a' },
      ir: { promptSha256: 'aaa', promptFlags: { fidelityHardening: true } }
    }),
    judgedRow({
      passed: false, attempt1Pass: false, cmFail: true, pfFail: false,
      segments: { surface: 'a' },
      ir: { promptSha256: 'bbb', promptFlags: { fidelityHardening: false } }
    })
  ];
  const arms = insights.compareArms(rows);
  assert.ok(arms.length >= 2);
});

check('C8 evaluateOverrides keep/revert/inconclusive', () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push(judgedRow({
      passed: true, attempt1Pass: true, cmFail: false, pfFail: false,
      segments: { surface: 'a' },
      ir: { promptFlags: { segmentOverrides: [] } }
    }));
  }
  for (let i = 0; i < 25; i++) {
    rows.push(judgedRow({
      passed: false, attempt1Pass: false, cmFail: true, pfFail: false,
      segments: { surface: 'a' },
      ir: { promptFlags: { segmentOverrides: ['bad-override'] } }
    }));
  }
  const ev = insights.evaluateOverrides(rows, 20);
  const bad = ev.find((e) => e.id === 'bad-override');
  assert.ok(bad);
  assert.strictEqual(bad.recommendation, 'revert');
});

const { buildQcInsightsHtml, esc } = require('../services/qcInsightsPageService');

check('D1 HTML renders and escapes a <script> tag in proposal text', () => {
  const html = buildQcInsightsHtml({
    report: {
      generatedAt: new Date('2026-08-21T00:00:00Z'),
      adsScanned: 1,
      adsWithVerdicts: 1,
      qcConfig: { staticQcEnabled: true, videoQcEnabled: false },
      totals: { judged: 1, passRate: 1, attempt1FailRate: 0, regenRescueRate: 0 },
      categories: {},
      segmentVerdicts: {},
      segments: [],
      findingsClusters: [{ category: 'competitor_marks', text: '<script>alert(1)</script>', n: 1 }],
      armComparison: [],
      overridePerformance: [],
      proposals: [{
        issueKey: 'xss',
        qcCategory: 'competitor_marks',
        scope: { type: 'general' },
        appendText: '<script>alert(1)</script>',
        rationale: '<script>pwn</script>',
        expectedEffect: 'none',
        risk: 'low',
        recommendation: 'hold'
      }]
    },
    history: []
  });
  assert.ok(html.includes('Static QC: ON'));
  assert.ok(html.includes('Video QC: OFF'));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script must not appear');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.strictEqual(esc('<script>'), '&lt;script&gt;');
});

check('E1 qcInsightsService contains no atlasImage/atlasVideo/renderService require', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'qcInsightsService.js'), 'utf8');
  assert.ok(!src.includes("require('./atlasImageService')"));
  assert.ok(!src.includes("require('./atlasVideoService')"));
  assert.ok(!src.includes("require('./renderService')"));
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    setHeader() { return this; }
  };
}

(async () => {
  // ── E2/E3 SUPERSEDED — the vulnerability, and why this stays a check ──
  //
  // An earlier draft of routes/qcInsights.js duplicated GET/PATCH /config
  // (the static/video vision-QC gate — a PLATFORM-WIDE billable switch) on
  // THIS router, which mounts behind plain tenant requireAuth in index.js.
  // That meant any authenticated member of any workspace — including a
  // viewer — could flip a global spend switch. Caught in review before it
  // shipped. The correctly-gated implementation lives ONLY at
  // GET/PATCH /api/admin/qc-config (routes/admin.js, requireUserOnly +
  // requireSuperAdmin — see scripts/verifyAdminSettingsAuthz.js C1-C8 for
  // the same body-validation coverage on the route that actually should
  // carry it).
  //
  // E2/E3 now pin the ABSENCE, not the behaviour: routes/qcInsights.js must
  // never define a /config route again. A source-text pin, not a route
  // lookup — a route lookup would just throw "not found" and could be
  // mistaken for a passing test if this file's structure changes.
  const qcInsightsRouteSrc = fs.readFileSync(path.join(ROOT, 'routes', 'qcInsights.js'), 'utf8');

  check("E2 routes/qcInsights.js defines no '/config' route (the platform-wide gate lives ONLY on routes/admin.js)", () => {
    assert.ok(
      !/router\.(get|patch|post|put|delete)\(\s*['"]\/config['"]/.test(qcInsightsRouteSrc),
      'routes/qcInsights.js must not re-define /config — that is exactly the tenant-requireAuth-reachable ' +
      'platform-wide-gate hole this check exists to catch. Use /api/admin/qc-config instead.'
    );
  });

  check('E3 routes/qcInsights.js does not import systemConfigService (no reason to, once /config is gone)', () => {
    assert.ok(
      !/require\(\s*['"]\.\.\/services\/systemConfigService['"]\s*\)/.test(qcInsightsRouteSrc),
      'an unused-but-present systemConfigService import is a sign the removed route is being rebuilt here — ' +
      'it belongs on routes/admin.js only'
    );
  });

  // ── E4-E7: the WHOLE router is admin-gated, not just /config ─────────
  //
  // collectWindowData() has no tenant filter (found in review) — a report
  // can name a specific product category that identifies a brand, so
  // GET /latest, /history, /report leak cross-tenant data under plain
  // tenant auth, and POST /run is a paid-LLM trigger (once
  // QC_INSIGHTS_PROPOSALS_ENABLED is on) reachable by any authenticated
  // member of any workspace. Fixed by gating the whole router the same way
  // routes/admin.js gates itself: router.use(requireUserOnly) then
  // router.use(requireSuperAdmin), identity-checked here exactly like
  // verifyAdminSettingsAuthz.js's C0, plus a revert-prove.

  const requireUserOnly   = require('../middleware/requireUserOnly');
  const requireSuperAdmin = require('../middleware/requireSuperAdmin');
  const qcInsightsRouter  = require('../routes/qcInsights');

  function routerLevelHandles(router) {
    return router.stack.filter((l) => !l.route).map((l) => l.handle);
  }

  check('E4 routes/qcInsights.js router-level stack is [requireUserOnly, requireSuperAdmin] by identity', () => {
    const handles = routerLevelHandles(qcInsightsRouter);
    assert.ok(handles.length >= 2, `expected >=2 router-level layers, got ${handles.length}`);
    assert.strictEqual(handles[0], requireUserOnly, 'first router.use must be the REAL requireUserOnly');
    assert.strictEqual(handles[1], requireSuperAdmin, 'second router.use must be the REAL requireSuperAdmin');
  });

  check('E5 index.js mounts /api/qc-insights WITHOUT requireAuth (auth lives on the router, not the mount)', () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    assert.ok(
      /app\.use\(\s*['"]\/api\/qc-insights['"]\s*,\s*require\(\s*['"]\.\/routes\/qcInsights['"]\s*\)\s*\)/.test(indexSrc),
      "expected a bare app.use('/api/qc-insights', require('./routes/qcInsights'))"
    );
    assert.ok(
      !/app\.use\(\s*['"]\/api\/qc-insights['"]\s*,\s*requireAuth/.test(indexSrc),
      '/api/qc-insights must not sit behind tenant-scoped requireAuth — that is the exact hole this section closes'
    );
  });

  await checkAsync('E6 revert-prove: dropping router.use(requireSuperAdmin) from a sibling copy removes it from the stack', async () => {
    const routerAbsPath = path.join(ROOT, 'routes', 'qcInsights.js');
    const src = fs.readFileSync(routerAbsPath, 'utf8');
    const mutated = src.replace('router.use(requireSuperAdmin);', '');
    assert.notStrictEqual(mutated, src, 'mutation pattern missed the real source — E6 would be vacuous');
    const tmpPath = path.join(
      path.dirname(routerAbsPath),
      `.__revertprove_qcInsights_${process.pid}_${Date.now()}.js`
    );
    fs.writeFileSync(tmpPath, mutated);
    try {
      delete require.cache[tmpPath];
      const mutatedRouter = require(tmpPath);
      const handles = routerLevelHandles(mutatedRouter);
      assert.ok(!handles.includes(requireSuperAdmin), 'expected the reverted router to lack requireSuperAdmin');
      assert.ok(handles.includes(requireUserOnly), 'requireUserOnly must still be present — isolates the mutation');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      delete require.cache[tmpPath];
    }
  });

  check('E7 the REAL router still has requireSuperAdmin after the sibling revert-prove', () => {
    const handles = routerLevelHandles(qcInsightsRouter);
    assert.ok(handles.includes(requireSuperAdmin), 'live router lost requireSuperAdmin');
  });

  check('E8 GET /report error path returns JSON, not raw HTML-interpolated err.message (XSS-adjacent, found in review)', () => {
    assert.ok(
      !/res\.status\(500\)\.send\(\s*`[^`]*\$\{err\.message\}/.test(qcInsightsRouteSrc),
      'a template literal interpolating err.message into res.send() is a live XSS sink the moment any error ' +
      'path here echoes request- or DB-derived text — use res.json({error: err.message}) like every other handler'
    );
  });

  // ── LLM call bound via require.cache injection ────────────────────
  const llmPath = require.resolve('../services/atlasLlmService');
  const origLlm = require.cache[llmPath];
  let llmCalls = 0;
  let script = [];
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      chatCompletion: async () => {
        llmCalls += 1;
        const next = script.shift();
        if (!next) throw new Error(`unscripted llm call #${llmCalls}`);
        return { choices: [{ message: { content: next } }], model: 'google/gemini-2.5-pro' };
      }
    }
  };
  const proposalPath = require.resolve('../services/qcInsightsProposalService');
  delete require.cache[proposalPath];
  const proposals = require('../services/qcInsightsProposalService');

  const fakeReport = () => ({
    totals: { judged: 40, passRate: 0.5, attempt1FailRate: 0.4 },
    categories: {},
    segmentVerdicts: {},
    segments: [],
    findingsClusters: [],
    overridePerformance: [],
    async save() { return this; }
  });

  await checkAsync('F1 happy path = 1 LLM call', async () => {
    llmCalls = 0;
    script = ['{"proposals":[]}'];
    const r = fakeReport();
    await proposals.generateAndAttachProposals(r);
    assert.strictEqual(llmCalls, 1);
  });

  await checkAsync('F2 corrective-reask path = 2 LLM calls', async () => {
    llmCalls = 0;
    script = ['not json at all', '{"proposals":[]}'];
    const r = fakeReport();
    await proposals.generateAndAttachProposals(r);
    assert.strictEqual(llmCalls, 2);
    assert.strictEqual(r.proposalsProvenance.correctiveReask, true);
  });

  await checkAsync('F3 give-up path = exactly 2 LLM calls NEVER 3', async () => {
    llmCalls = 0;
    script = ['nope', 'still nope', '{"proposals":[{"issueKey":"too-many"}]}'];
    const r = fakeReport();
    await proposals.generateAndAttachProposals(r);
    assert.strictEqual(llmCalls, 2, `expected 2 calls, got ${llmCalls}`);
    assert.strictEqual(r.proposalsProvenance.error, 'unparseable');
    assert.deepStrictEqual(r.proposals, []);
  });

  if (origLlm) require.cache[llmPath] = origLlm;
  else delete require.cache[llmPath];
  delete require.cache[proposalPath];

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  -', f);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
