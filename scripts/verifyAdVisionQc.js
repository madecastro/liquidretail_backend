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

  // ── H. Wiring: pass → run feed; fail → alertService (+ run feed) ───
  // Revert: pass path calling alertQcAccepted / alertService fails H1/H1b;
  // removing fail alert fails H3; removing run-feed pass note fails H1.
  const directImageSrc = () => require('fs').readFileSync(
    path.join(__dirname, '..', 'services', 'directImageRenderService.js'), 'utf8'
  );
  const fs = require('fs');
  check('H1 directImageRenderService pass path uses noteQcPassToRunFeed (not alert channel)', () => {
    const src = directImageSrc();
    assert.match(src, /adVisionQc\.noteQcPassToRunFeed\(/, 'run-feed pass note call site missing');
    // Must NOT call alertQcAccepted on the live pass path (exported helper
    // may still appear in comments; the call form is what matters).
    assert.ok(
      !/adVisionQc\.alertQcAccepted\s*\(/.test(src),
      'pass path must not call alertQcAccepted — that exhausts alert rate limit at scale'
    );
  });
  check('H1b pass path does not require alertService for accepts', () => {
    // Structural: noteQcPassToRunFeed body must not call alertService.
    const qcSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'adVisionQcService.js'), 'utf8'
    );
    const m = qcSrc.match(/function noteQcPassToRunFeed\([\s\S]*?\n\}/);
    assert.ok(m, 'noteQcPassToRunFeed not found');
    assert.ok(!/alertService|notifyAsync|alertQcAccepted/.test(m[0]),
      'noteQcPassToRunFeed must not touch alertService');
  });
  check('H2 skipped path calls alertQcSkipped (uninspected is an error, not silence)', () => {
    assert.match(directImageSrc(), /adVisionQc\.alertQcSkipped\(/, 'alertQcSkipped call site missing');
  });
  check('H3 directImageRenderService still calls alertQcFailure on the reject path', () => {
    assert.match(directImageSrc(), /adVisionQc\.alertQcFailure\(/, 'reject-alert call site missing');
  });
  check('H4 fail path ALSO posts a run-feed event', () => {
    assert.match(directImageSrc(), /adVisionQc\.noteQcFailToRunFeed\(/, 'run-feed fail note missing');
  });

  // ── I. Judge throw does NOT consume regeneration budget ────────────
  // Revert: treating a throw like a fail verdict (regen) fails I1/I2;
  // rethrowing out of runPostRenderQc fails I3.
  await checkAsync('I1 judge throw → exactly ONE generate, ZERO regenerations', async () => {
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
        if (genCalls > 1) throw new Error('regeneration after judge throw — money bug');
        return makeOutput(attempt);
      },
      uploadAttempt: async ({ attempt }) => `https://cdn.example/throw-${attempt}.png`,
      judgeFn: async () => {
        visionCalls += 1;
        throw new Error('atlas vision timeout');
      }
    });
    assert.strictEqual(genCalls, 1, `expected 1 generate, got ${genCalls}`);
    assert.strictEqual(result.generationCount, 1);
    assert.strictEqual(result.regenerationCount, 0);
    assert.strictEqual(result.ok, true, 'paid plate must still ship');
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.uninspected, true);
    assert.ok(result.output, 'output must be kept');
    assert.strictEqual(result.visionQc.skipped, true);
    assert.match(String(result.visionQc.reason || ''), /atlas vision timeout/);
    // visionCallCount is only incremented on a completed judge — throw = 0.
    assert.strictEqual(result.visionCallCount, 0);
  });

  await checkAsync('I2 judge throw after a real fail does not produce a 3rd image submit', async () => {
    // Attempt 1: real fail verdict → regen. Attempt 2: judge throws.
    // Must stop at 2 generates (never a 3rd).
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
        if (genCalls > 2) throw new Error('THIRD generation after judge throw — money invariant broken');
        return makeOutput(attempt);
      },
      uploadAttempt: async ({ attempt }) => `https://cdn.example/mix-${attempt}.png`,
      judgeFn: async () => {
        visionCalls += 1;
        if (visionCalls === 1) return FAIL_VERDICT;
        throw new Error('vision down on attempt 2');
      }
    });
    assert.strictEqual(genCalls, 2);
    assert.strictEqual(result.generationCount, 2);
    assert.strictEqual(result.regenerationCount, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.visionQc.skipped, true);
  });

  // ── J. Skipped verdict is distinguishable from a pass ──────────────
  // Revert: dropped `reason` field or skipped:false on buildSkippedVerdict fails J1.
  check('J1 buildSkippedVerdict has skipped:true, passed:false, reason set', () => {
    const v = qc.buildSkippedVerdict('no original product URL');
    assert.strictEqual(v.skipped, true);
    assert.strictEqual(v.passed, false);
    assert.strictEqual(v.disabled, false);
    assert.strictEqual(v.reason, 'no original product URL');
    assert.ok(Array.isArray(v.attempts));
    assert.strictEqual(v.attempts.length, 0);
  });
  check('J2 buildPersistedVerdict pass does not look skipped', () => {
    const v = qc.buildPersistedVerdict({
      passed: true, finalAttempt: 1,
      attempts: [{ attempt: 1, pass: true, categories: qc.emptyCategories(), summary: 'clean' }]
    });
    assert.strictEqual(v.skipped, false);
    assert.strictEqual(v.passed, true);
    assert.strictEqual(v.reason, null);
  });
  check('J3 alertQcSkipped is exported and keys per-ad at error level', () => {
    assert.strictEqual(typeof qc.alertQcSkipped, 'function');
    const captured = fakeNotify(() => qc.alertQcSkipped({
      adId: 'adSKIP1', brandId: 'b1', productId: 'p1', brandName: 'X', reason: 'test skip'
    }));
    assert.ok(captured, 'alertQcSkipped did not call notifyAsync');
    assert.strictEqual(captured.level, 'error');
    assert.ok(captured.key.includes('adSKIP1'), 'skipped key must embed ad id');
    assert.match(captured.key, /vision-qc:skipped:/);
  });
  check('J3b two skipped ads do not share a dedupe key', () => {
    const a = fakeNotify(() => qc.alertQcSkipped({ adId: 'adS1', reason: 'r' }));
    const b = fakeNotify(() => qc.alertQcSkipped({ adId: 'adS2', reason: 'r' }));
    assert.notStrictEqual(a.key, b.key);
  });

  // ── K. formatThreadLine previewUrl ─────────────────────────────────
  // Revert: dropping meta.previewUrl render fails K1; always appending a
  // placeholder when absent fails K2 (would change every existing caller).
  check('K1 formatThreadLine renders meta.previewUrl when present', () => {
    const runFeed = require('../services/runFeedService');
    const line = runFeed.formatThreadLine({
      t: Date.now(),
      stage: 'vision QC pass',
      adId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      meta: {
        template: 'ai_brand_led',
        aspectRatio: '1:1',
        previewUrl: 'https://res.cloudinary.com/x/image/upload/v1/ads/r.png'
      }
    });
    assert.match(line, /https:\/\/res\.cloudinary\.com\/x\/image\/upload\/v1\/ads\/r\.png/);
  });
  check('K2 formatThreadLine unchanged when previewUrl absent (no placeholder)', () => {
    const runFeed = require('../services/runFeedService');
    const line = runFeed.formatThreadLine({
      t: Date.now(),
      stage: 'static image generation',
      adId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      meta: { template: 'ai_brand_led', aspectRatio: '1:1', mediaId: 'cccccccccccccccccccccccc' }
    });
    assert.ok(!/preview/i.test(line), 'must not invent a preview token when absent');
    assert.ok(!/https?:\/\//.test(line), 'must not invent a URL when previewUrl absent');
  });

  // ── L. Severity-aware alert rate limiter ───────────────────────────
  // Revert: a single shared counter that blocks error/fatal after low-
  // severity exhaustion fails L1. Unbounded error exemption fails L2.
  await checkAsync('L1 error/fatal still deliver after low-severity cap is exhausted', async () => {
    const alerts = require('../services/alertService');
    const prev = {
      ALERT_RATE_LIMIT_MAX: process.env.ALERT_RATE_LIMIT_MAX,
      ALERT_RATE_LIMIT_ERROR_MAX: process.env.ALERT_RATE_LIMIT_ERROR_MAX,
      ALERT_DEDUPE_WINDOW_MIN: process.env.ALERT_DEDUPE_WINDOW_MIN,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_ALERT_CHANNEL: process.env.SLACK_ALERT_CHANNEL,
      ALERTS_ENABLED: process.env.ALERTS_ENABLED,
      ALERT_MIN_LEVEL: process.env.ALERT_MIN_LEVEL
    };
    process.env.ALERT_RATE_LIMIT_MAX = '2';
    process.env.ALERT_RATE_LIMIT_ERROR_MAX = '5';
    process.env.ALERT_DEDUPE_WINDOW_MIN = '0';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token-for-verify';
    process.env.SLACK_ALERT_CHANNEL = 'C00000000';
    process.env.ALERTS_ENABLED = 'true';
    process.env.ALERT_MIN_LEVEL = 'info';
    alerts._resetState();
    const origFetch = global.fetch;
    let fetches = 0;
    global.fetch = async () => {
      fetches += 1;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}'
      };
    };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      // Exhaust low-severity bucket (2).
      const w1 = await alerts.notify({ level: 'warn', title: 'w1', key: 'low-1' });
      const w2 = await alerts.notify({ level: 'warn', title: 'w2', key: 'low-2' });
      const w3 = await alerts.notify({ level: 'warn', title: 'w3', key: 'low-3' });
      assert.strictEqual(w1, true);
      assert.strictEqual(w2, true);
      assert.strictEqual(w3, false, '3rd warn must be rate-limited');
      // High severity must still go through.
      const e1 = await alerts.notify({ level: 'error', title: 'e1', key: 'hi-1' });
      const f1 = await alerts.notify({ level: 'fatal', title: 'f1', key: 'hi-2' });
      assert.strictEqual(e1, true, 'error must deliver after low-severity cap exhausted');
      assert.strictEqual(f1, true, 'fatal must deliver after low-severity cap exhausted');
      assert.ok(fetches >= 4, `expected >=4 slack posts, got ${fetches}`);
    } finally {
      console.warn = origWarn;
      global.fetch = origFetch;
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      alerts._resetState();
    }
  });

  await checkAsync('L2 error/fatal still have a hard bound (not unbounded exemption)', async () => {
    const alerts = require('../services/alertService');
    const prev = {
      ALERT_RATE_LIMIT_MAX: process.env.ALERT_RATE_LIMIT_MAX,
      ALERT_RATE_LIMIT_ERROR_MAX: process.env.ALERT_RATE_LIMIT_ERROR_MAX,
      ALERT_DEDUPE_WINDOW_MIN: process.env.ALERT_DEDUPE_WINDOW_MIN,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_ALERT_CHANNEL: process.env.SLACK_ALERT_CHANNEL,
      ALERTS_ENABLED: process.env.ALERTS_ENABLED,
      ALERT_MIN_LEVEL: process.env.ALERT_MIN_LEVEL
    };
    process.env.ALERT_RATE_LIMIT_MAX = '20';
    process.env.ALERT_RATE_LIMIT_ERROR_MAX = '3';
    process.env.ALERT_DEDUPE_WINDOW_MIN = '0';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token-for-verify';
    process.env.SLACK_ALERT_CHANNEL = 'C00000000';
    process.env.ALERTS_ENABLED = 'true';
    process.env.ALERT_MIN_LEVEL = 'info';
    alerts._resetState();
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}'
    });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await alerts.notify({ level: 'error', title: `err-${i}`, key: `err-key-${i}` }));
      }
      const delivered = results.filter(Boolean).length;
      assert.strictEqual(delivered, 3, `expected 3 of 5 errors delivered, got ${delivered}`);
    } finally {
      console.warn = origWarn;
      global.fetch = origFetch;
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      alerts._resetState();
    }
  });

  // ── M. Recovery path: vision only, no image submit ─────────────────
  // Revert: calling editImage/generateImage from recovery fails M1;
  // shipping recovered plate with no visionQc stamp when flag on fails M2.
  check('M1 imageRecoveryService never calls editImage/generateImage (vision QC only)', () => {
    const recSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'imageRecoveryService.js'), 'utf8'
    );
    assert.ok(!/\b(generateImage|editImage)\s*\(/.test(recSrc),
      'recovery must not submit a new image — money');
    assert.match(recSrc, /judgeRender|maybeQcRecoveredPlate|buildSkippedVerdict/,
      'recovery must QC or stamp skipped when flag on');
  });
  check('M2 recovery path stamps visionQc when QC enabled (judge or skipped)', () => {
    const recSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'imageRecoveryService.js'), 'utf8'
    );
    assert.match(recSrc, /visionQc/, 'recovered ad must persist visionQc');
    assert.match(recSrc, /alertQcSkipped|alertQcFailure/,
      'uninspected or failed recovery QC must alert');
  });

  // ── N. Preview / app deep link helpers ─────────────────────────────
  check('N1 buildAppPreviewUrl uses FRONTEND_URL (no hardcoded domain)', () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://staging.example.test';
    try {
      const url = qc.buildAppPreviewUrl({
        campaignRunId: 'run-abc',
        campaignId: 'camp-1',
        brandId: 'brand-9'
      });
      assert.ok(url);
      assert.match(url, /^https:\/\/staging\.example\.test\/ads\?/);
      assert.match(url, /campaignRunId=run-abc/);
      assert.match(url, /campaignId=camp-1/);
      assert.match(url, /runBrandId=brand-9/);
      assert.ok(!/reach-social|netlify\.app|liquidretail/.test(url) || /staging\.example\.test/.test(url));
    } finally {
      if (prev === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = prev;
    }
  });
  check('N2 buildQcSlackDetail surfaces preview render URL', () => {
    const detail = qc.buildQcSlackDetail(qc.buildPersistedVerdict({
      passed: true, finalAttempt: 1,
      attempts: [{
        attempt: 1, pass: true, categories: qc.emptyCategories(),
        summary: 'clean', renderUrl: 'https://cdn.example/ship.png'
      }]
    }), { appUrl: 'https://app.example/ads?campaignRunId=r1' });
    assert.match(detail, /https:\/\/cdn\.example\/ship\.png/);
    assert.match(detail, /https:\/\/app\.example\/ads\?campaignRunId=r1/);
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
