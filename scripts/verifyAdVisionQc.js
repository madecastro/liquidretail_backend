#!/usr/bin/env node
'use strict';
/**
 * verifyAdVisionQc — offline guard for the post-render vision QC pass.
 *
 * Asserts the money and shape contracts of services/adVisionQcService.js:
 *   - BOTH images land in the vision request, correctly labelled
 *   - failing QC triggers exactly ONE regeneration; a second failure
 *     triggers ZERO further generations (behavioural, via call counts)
 *   - discarded render URL is retained on the persisted verdict
 *   - all four categories appear in the verdict shape
 *   - with the feature flag off, NO vision call and NO regeneration
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyAdVisionQc.js
 *
 * Revert-proof notes live next to each group: if that production code is
 * backed out, the named check fails.
 */

const assert = require('assert');
const path = require('path');

// Ensure flag is not inherited from a developer shell for the "off" cases.
delete process.env.AD_VISION_QC_ENABLED;

const qc = require('../services/adVisionQcService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const FAIL_VERDICT = {
  pass: false,
  categories: {
    competitor_marks: { score: 2, pass: false, findings: ['tree emblem on midfoot not on original'] },
    product_fidelity: { score: 8, pass: true, findings: [] },
    text_defects:     { score: 9, pass: true, findings: [] },
    layout_safe_box:  { score: 9, pass: true, findings: [] }
  },
  summary: 'competitor mark on product',
  findings: ['[competitor_marks] tree emblem on midfoot not on original']
};

const PASS_VERDICT = {
  pass: true,
  categories: {
    competitor_marks: { score: 9, pass: true, findings: [] },
    product_fidelity: { score: 9, pass: true, findings: [] },
    text_defects:     { score: 9, pass: true, findings: [] },
    layout_safe_box:  { score: 9, pass: true, findings: [] }
  },
  summary: 'clean',
  findings: []
};

function makeOutput(attempt) {
  return {
    buffer: Buffer.from(`png-attempt-${attempt}`),
    contentType: 'image/png',
    width: 1080,
    height: 1350,
    bytes: 16,
    imageGeneration: { predictionId: `pred-${attempt}`, model: 'openai/gpt-image-2/edit' },
    intentResolution: { surface: 'meta_feed_4_5', delivered: 'social_proof_led' }
  };
}

console.log('\nverifyAdVisionQc — post-render vision QC contracts\n');

// ── A. Constants / shape ─────────────────────────────────────────────
// Revert: changing MAX_QC_REGENERATIONS to 2 (or an env knob) fails A1/A2.
check('A1 MAX_QC_REGENERATIONS is exactly 1 (money hard bound)', () => {
  assert.strictEqual(qc.MAX_QC_REGENERATIONS, 1);
});
check('A2 CATEGORIES has all four required checks', () => {
  assert.deepStrictEqual([...qc.CATEGORIES], [
    'competitor_marks', 'product_fidelity', 'text_defects', 'layout_safe_box'
  ]);
});
check('A3 parseVerdict requires all four categories in shape', () => {
  const v = qc.parseVerdict({
    categories: {
      competitor_marks: { score: 9, findings: [] },
      product_fidelity: { score: 8, findings: [] },
      text_defects:     { score: 7, findings: [] },
      layout_safe_box:  { score: 10, findings: [] }
    },
    summary: 'ok'
  });
  for (const k of qc.CATEGORIES) {
    assert.ok(v.categories[k], `missing category ${k}`);
    assert.strictEqual(typeof v.categories[k].score, 'number');
    assert.strictEqual(typeof v.categories[k].pass, 'boolean');
    assert.ok(Array.isArray(v.categories[k].findings));
  }
  assert.strictEqual(v.pass, true);
});
check('A4 competitor_marks fail fails overall even when others pass', () => {
  const v = qc.parseVerdict({
    categories: {
      competitor_marks: { score: 2, findings: ['timberland tree'] },
      product_fidelity: { score: 10, findings: [] },
      text_defects:     { score: 10, findings: [] },
      layout_safe_box:  { score: 10, findings: [] }
    }
  });
  assert.strictEqual(v.pass, false);
  assert.strictEqual(v.categories.competitor_marks.pass, false);
});
check('A5 buildCorrectiveNote names the invented mark', () => {
  const note = qc.buildCorrectiveNote(FAIL_VERDICT);
  assert.match(note, /tree emblem/i);
  assert.match(note, /CRITICAL/i);
  assert.match(note, /competitor/i);
});

// ── B. Both images, correctly labelled ───────────────────────────────
// Revert: dropping original image or labels fails B1–B3.
check('B1 buildVisionUserContent includes BOTH image_url parts', () => {
  const content = qc.buildVisionUserContent({
    originalProductUrl: 'https://cdn.example/original.jpg',
    renderUrl: 'https://cdn.example/render.png',
    brandName: 'Allbirds',
    safeBox: { left: 40, top: 40, right: 1040, bottom: 1200 },
    deliveryDims: { width: 1080, height: 1350 },
    expectedText: ['4.8 ★']
  });
  const images = content.filter((p) => p.type === 'image_url');
  assert.strictEqual(images.length, 2, `expected 2 images, got ${images.length}`);
  assert.strictEqual(images[0].image_url.url, 'https://cdn.example/original.jpg');
  assert.strictEqual(images[1].image_url.url, 'https://cdn.example/render.png');
});
check('B2 images are labelled ORIGINAL PRODUCT then GENERATED AD', () => {
  const content = qc.buildVisionUserContent({
    originalProductUrl: 'https://cdn.example/original.jpg',
    renderUrl: 'https://cdn.example/render.png',
    brandName: 'Allbirds',
    safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
    deliveryDims: { width: 100, height: 100 }
  });
  const texts = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  assert.match(texts, /IMAGE 1 — ORIGINAL PRODUCT PHOTO/);
  assert.match(texts, /IMAGE 2 — GENERATED AD/);
  // Brand own logo must not be flagged — prompt contract.
  assert.match(texts, /OWN logo composited/i);
});
check('B3 safe box pixel numbers are in the prompt (not guessed)', () => {
  const content = qc.buildVisionUserContent({
    originalProductUrl: 'https://cdn.example/o.jpg',
    renderUrl: 'https://cdn.example/r.png',
    brandName: 'X',
    safeBox: { left: 12, top: 34, right: 1000, bottom: 1200 },
    deliveryDims: { width: 1080, height: 1350 }
  });
  const texts = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  assert.match(texts, /left=12/);
  assert.match(texts, /top=34/);
  assert.match(texts, /right=1000/);
  assert.match(texts, /bottom=1200/);
});
check('B4 judgeRender payload carries visionImages:2 meta (ledger)', async () => {
  // Revert: dropping visionImages from meta fails cost attribution.
  let capturedMeta = null;
  let capturedParams = null;
  await qc.judgeRender(
    {
      originalProductUrl: 'https://cdn.example/o.jpg',
      renderUrl: 'https://cdn.example/r.png',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 10, bottom: 10 },
      deliveryDims: { width: 10, height: 10 }
    },
    {
      chatCompletion: async (meta, params) => {
        capturedMeta = meta;
        capturedParams = params;
        return {
          choices: [{ message: { content: JSON.stringify({
            categories: {
              competitor_marks: { score: 9, findings: [] },
              product_fidelity: { score: 9, findings: [] },
              text_defects:     { score: 9, findings: [] },
              layout_safe_box:  { score: 9, findings: [] }
            },
            summary: 'ok'
          }) } }]
        };
      }
    }
  );
  assert.strictEqual(capturedMeta.visionImages, 2);
  assert.strictEqual(capturedMeta.stage, 'ad_vision_qc');
  assert.strictEqual(capturedMeta.service, 'adVisionQcService');
  const imgs = capturedParams.messages[0].content.filter((p) => p.type === 'image_url');
  assert.strictEqual(imgs.length, 2);
});

// ── C. Retry bound (MONEY — behavioural) ─────────────────────────────
// Revert: a loop that retries until pass, or maxRegen>1, fails C1/C2.
(async () => {
  await checkAsync('C1 failing verdict → exactly ONE regeneration (2 generate calls)', async () => {
    let genCalls = 0;
    let visionCalls = 0;
    const result = await qc.runPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
      deliveryDims: { width: 100, height: 100 },
      generate: async ({ attempt }) => {
        genCalls += 1;
        return makeOutput(attempt);
      },
      uploadAttempt: async ({ attempt }) => `https://cdn.example/discarded-${attempt}.png`,
      judgeFn: async () => {
        visionCalls += 1;
        // Always fail — forces the retry path then terminal fail.
        return FAIL_VERDICT;
      }
    });
    assert.strictEqual(genCalls, 2, `expected 2 generate calls, got ${genCalls}`);
    assert.strictEqual(result.generationCount, 2);
    assert.strictEqual(result.regenerationCount, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(visionCalls, 2, 'QC once per attempt');
  });

  await checkAsync('C2 second failure triggers ZERO further generations (no 3rd)', async () => {
    let genCalls = 0;
    const result = await qc.runPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
      deliveryDims: { width: 100, height: 100 },
      generate: async ({ attempt }) => {
        genCalls += 1;
        if (genCalls > 2) throw new Error('THIRD generation attempted — money invariant broken');
        return makeOutput(attempt);
      },
      uploadAttempt: async ({ attempt }) => `https://cdn.example/d-${attempt}.png`,
      judgeFn: async () => FAIL_VERDICT
    });
    assert.strictEqual(genCalls, 2);
    assert.strictEqual(result.generationCount, 2);
    assert.strictEqual(result.ok, false);
  });

  await checkAsync('C3 first-fail then pass regenerates exactly once and ships', async () => {
    let genCalls = 0;
    let visionCalls = 0;
    const result = await qc.runPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
      deliveryDims: { width: 100, height: 100 },
      generate: async ({ attempt, correctiveNote }) => {
        genCalls += 1;
        if (attempt === 2) {
          assert.ok(correctiveNote && /VISION QC CORRECTION/i.test(correctiveNote),
            'retry must carry corrective note');
        }
        return makeOutput(attempt);
      },
      uploadAttempt: async ({ attempt }) => `https://cdn.example/a-${attempt}.png`,
      judgeFn: async () => {
        visionCalls += 1;
        return visionCalls === 1 ? FAIL_VERDICT : PASS_VERDICT;
      }
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(genCalls, 2);
    assert.strictEqual(result.regenerationCount, 1);
    assert.strictEqual(result.visionQc.passed, true);
    assert.strictEqual(result.visionQc.finalAttempt, 2);
  });

  await checkAsync('C4 _maxRegenerations cannot exceed hard bound (clamp)', async () => {
    let genCalls = 0;
    await qc.runPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'X',
      safeBox: { left: 0, top: 0, right: 1, bottom: 1 },
      deliveryDims: { width: 1, height: 1 },
      // Attacker/misconfig tries to allow 5 regens — must clamp to 1.
      _maxRegenerations: 5,
      generate: async ({ attempt }) => {
        genCalls += 1;
        return makeOutput(attempt);
      },
      uploadAttempt: async ({ attempt }) => `https://cdn.example/x-${attempt}.png`,
      judgeFn: async () => FAIL_VERDICT
    });
    assert.strictEqual(genCalls, 2, `clamp failed — got ${genCalls} generates`);
  });

  // ── D. Discarded URL retained ──────────────────────────────────────
  // Revert: dropping discardedRenderUrl / renderUrl on failed attempts fails D1.
  await checkAsync('D1 discarded first render URL is retained on persisted verdict', async () => {
    const result = await qc.runPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
      deliveryDims: { width: 100, height: 100 },
      generate: async ({ attempt }) => makeOutput(attempt),
      uploadAttempt: async ({ attempt }) => `https://cdn.example/kept-${attempt}.png`,
      judgeFn: async () => FAIL_VERDICT
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.visionQc.attempts.length, 2);
    const a1 = result.visionQc.attempts[0];
    assert.strictEqual(a1.attempt, 1);
    assert.strictEqual(a1.discarded, true);
    assert.strictEqual(a1.renderUrl, 'https://cdn.example/kept-1.png');
    assert.strictEqual(a1.discardedRenderUrl, 'https://cdn.example/kept-1.png');
    const a2 = result.visionQc.attempts[1];
    assert.strictEqual(a2.attempt, 2);
    assert.strictEqual(a2.renderUrl, 'https://cdn.example/kept-2.png');
  });

  await checkAsync('D2 pass-after-retry marks attempt 1 discarded and keeps URL', async () => {
    let n = 0;
    const result = await qc.runPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
      deliveryDims: { width: 100, height: 100 },
      generate: async ({ attempt }) => makeOutput(attempt),
      uploadAttempt: async ({ attempt }) => `https://cdn.example/ship-${attempt}.png`,
      judgeFn: async () => (++n === 1 ? FAIL_VERDICT : PASS_VERDICT)
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.visionQc.attempts[0].discarded, true);
    assert.strictEqual(result.visionQc.attempts[0].discardedRenderUrl, 'https://cdn.example/ship-1.png');
    assert.strictEqual(result.visionQc.attempts[1].discarded, false);
    assert.strictEqual(result.visionQc.attempts[1].renderUrl, 'https://cdn.example/ship-2.png');
  });

  // ── E. Feature flag off ────────────────────────────────────────────
  // Revert: ignoring isEnabled / enabled:false fails E1.
  await checkAsync('E1 flag off → NO vision call and NO regeneration', async () => {
    let genCalls = 0;
    let visionCalls = 0;
    const result = await qc.runPostRenderQc({
      enabled: false,
      originalProductUrl: 'https://cdn.example/o.jpg',
      brandName: 'Allbirds',
      safeBox: { left: 0, top: 0, right: 100, bottom: 100 },
      deliveryDims: { width: 100, height: 100 },
      generate: async ({ attempt }) => {
        genCalls += 1;
        return makeOutput(attempt);
      },
      uploadAttempt: async () => {
        throw new Error('uploadAttempt must not run when QC disabled');
      },
      judgeFn: async () => {
        visionCalls += 1;
        throw new Error('judgeFn must not run when QC disabled');
      }
    });
    assert.strictEqual(genCalls, 1);
    assert.strictEqual(visionCalls, 0);
    assert.strictEqual(result.visionCallCount, 0);
    assert.strictEqual(result.regenerationCount, 0);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.visionQc.disabled, true);
    assert.strictEqual(result.visionQc.attempts.length, 0);
  });

  await checkAsync('E2 isEnabled() reads AD_VISION_QC_ENABLED', () => {
    delete process.env.AD_VISION_QC_ENABLED;
    assert.strictEqual(qc.isEnabled(), false);
    process.env.AD_VISION_QC_ENABLED = 'true';
    assert.strictEqual(qc.isEnabled(), true);
    process.env.AD_VISION_QC_ENABLED = 'false';
    assert.strictEqual(qc.isEnabled(), false);
    delete process.env.AD_VISION_QC_ENABLED;
  });

  // ── F. Model role is real (not invented) ───────────────────────────
  check('F1 ad-vision-qc role resolves via atlasModelMap', () => {
    const { resolveModel, MAP } = require('../services/atlasModelMap');
    assert.ok(MAP['ad-vision-qc'], 'role missing from MAP — add ad-vision-qc');
    const resolved = resolveModel('ad-vision-qc');
    assert.ok(resolved.atlas && resolved.atlas.includes('/'), `atlas slug odd: ${resolved.atlas}`);
    // Must not be the known non-routable trap.
    assert.notStrictEqual(resolved.atlas, 'openai/gpt-5-nano');
  });

  // ── G. Accept/reject Slack alerts always fire, with the verbose verdict ──
  // Revert: routing alertQcAccepted through level:'info' fails G1 (info is
  // below alertService's default ALERT_MIN_LEVEL=warn and would silently
  // never send — the "make sure a message is sent" requirement this exists
  // for). Dropping the category breakdown from either detail fails G2/G3.
  const fakeNotify = (fn) => {
    const alerts = require('../services/alertService');
    const original = alerts.notifyAsync;
    let captured = null;
    alerts.notifyAsync = (opts) => { captured = opts; };
    try { fn(); } finally { alerts.notifyAsync = original; }
    return captured;
  };

  check('G1 alertQcAccepted fires at a level that survives default ALERT_MIN_LEVEL', () => {
    const alerts = require('../services/alertService');
    const verdict = qc.buildPersistedVerdict({
      passed: true,
      finalAttempt: 1,
      attempts: [{ attempt: 1, pass: true, categories: qc.emptyCategories(), summary: 'clean', renderUrl: 'https://cdn.example/r.png' }]
    });
    const captured = fakeNotify(() => qc.alertQcAccepted({
      adId: 'ad1', brandId: 'b1', productId: 'p1', brandName: 'Allbirds', visionQc: verdict
    }));
    assert.ok(captured, 'alertQcAccepted did not call alerts.notifyAsync');
    assert.notStrictEqual(captured.level, 'info', 'info is below default ALERT_MIN_LEVEL=warn — would never send');
    assert.ok(alerts._LEVELS[captured.level] >= alerts._LEVELS.warn, `level ${captured.level} would be filtered by default min level`);
  });

  check('G2 alertQcAccepted detail carries the full verbose verdict (per-category scores, not just a summary line)', () => {
    const verdict = qc.buildPersistedVerdict({
      passed: true,
      finalAttempt: 1,
      attempts: [{
        attempt: 1,
        pass: true,
        categories: {
          competitor_marks: { score: 9, pass: true, findings: [] },
          product_fidelity: { score: 9, pass: true, findings: ['minor colour shift'] },
          text_defects: { score: 10, pass: true, findings: [] },
          layout_safe_box: { score: 10, pass: true, findings: [] }
        },
        summary: 'clean',
        renderUrl: 'https://cdn.example/r.png'
      }]
    });
    const captured = fakeNotify(() => qc.alertQcAccepted({
      adId: 'ad1', brandId: 'b1', productId: 'p1', brandName: 'Allbirds', visionQc: verdict
    }));
    assert.ok(captured.detail.includes('minor colour shift'), 'verbose finding missing from Slack detail');
    assert.ok(captured.detail.includes('product_fidelity'), 'category breakdown missing from Slack detail');
  });

  check('G2b both alerts key on the AD, not a fixed literal (dedupe must not collapse across ads)', () => {
    // Revert: a shared/fixed key means alertService's 15-min dedupe window
    // silently swallows every ad's verbose verdict but the first one in
    // that window — no detail carried into the "+N more (suppressed)" bump.
    const acceptedVerdict = qc.buildPersistedVerdict({
      passed: true, finalAttempt: 1,
      attempts: [{ attempt: 1, pass: true, categories: qc.emptyCategories(), summary: 'clean', renderUrl: 'https://cdn.example/r.png' }]
    });
    const capturedA1 = fakeNotify(() => qc.alertQcAccepted({ adId: 'adAAA', brandId: 'b1', productId: 'p1', visionQc: acceptedVerdict }));
    const capturedA2 = fakeNotify(() => qc.alertQcAccepted({ adId: 'adBBB', brandId: 'b1', productId: 'p1', visionQc: acceptedVerdict }));
    assert.ok(capturedA1.key.includes('adAAA'), 'accept key must embed the ad id');
    assert.notStrictEqual(capturedA1.key, capturedA2.key, 'two different ads must not share a dedupe key');

    const failedVerdict = qc.buildPersistedVerdict({
      passed: false, finalAttempt: 2,
      attempts: [{ attempt: 2, pass: false, categories: FAIL_VERDICT.categories, findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary, renderUrl: 'https://cdn.example/2.png' }]
    });
    const capturedF1 = fakeNotify(() => qc.alertQcFailure({ adId: 'adCCC', brandId: 'b1', productId: 'p1', visionQc: failedVerdict }));
    const capturedF2 = fakeNotify(() => qc.alertQcFailure({ adId: 'adDDD', brandId: 'b1', productId: 'p1', visionQc: failedVerdict }));
    assert.ok(capturedF1.key.includes('adCCC'), 'reject key must embed the ad id');
    assert.notStrictEqual(capturedF1.key, capturedF2.key, 'two different ads must not share a dedupe key');
  });

  check('G3 alertQcFailure still fires at error level with the full verbose verdict (unchanged contract)', () => {
    const verdict = qc.buildPersistedVerdict({
      passed: false,
      finalAttempt: 2,
      attempts: [
        { attempt: 1, pass: false, categories: FAIL_VERDICT.categories, findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary, renderUrl: 'https://cdn.example/1.png', discarded: true },
        { attempt: 2, pass: false, categories: FAIL_VERDICT.categories, findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary, renderUrl: 'https://cdn.example/2.png' }
      ]
    });
    const captured = fakeNotify(() => qc.alertQcFailure({
      adId: 'ad1', brandId: 'b1', productId: 'p1', brandName: 'Allbirds', visionQc: verdict
    }));
    assert.ok(captured, 'alertQcFailure did not call alerts.notifyAsync');
    assert.strictEqual(captured.level, 'error');
    assert.ok(captured.detail.includes('competitor_marks'), 'category breakdown missing from failure alert');
  });

  // ── H. Wiring: directImageRenderService fires BOTH outcomes ────────
  // Revert: removing the accepted-alert call site fails H1; calling it
  // unconditionally (including the skipped/no-QC-ran path, flag off) fails
  // H2; removing the existing reject call site fails H3.
  const directImageSrc = () => require('fs').readFileSync(
    path.join(__dirname, '..', 'services', 'directImageRenderService.js'), 'utf8'
  );
  check('H1 directImageRenderService calls alertQcAccepted on the pass path', () => {
    assert.match(directImageSrc(), /adVisionQc\.alertQcAccepted\(/, 'accepted-alert call site missing');
  });
  check('H2 the accepted-alert call site is guarded on qcResult.skipped (no alert when QC never ran)', () => {
    const src = directImageSrc();
    const idx = src.indexOf('alertQcAccepted(');
    assert.ok(idx > -1, 'call site not found');
    const before = src.slice(Math.max(0, idx - 400), idx);
    assert.match(before, /qcResult\.skipped/, 'accepted-alert must be gated on qcResult.skipped');
  });
  check('H3 directImageRenderService still calls alertQcFailure on the reject path', () => {
    assert.match(directImageSrc(), /adVisionQc\.alertQcFailure\(/, 'reject-alert call site missing');
  });

  // ── report ─────────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`❌ verifyAdVisionQc: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyAdVisionQc: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error('verifyAdVisionQc crashed:', err);
  process.exit(1);
});
