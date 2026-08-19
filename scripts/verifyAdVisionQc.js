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

  // ── M3–M7. Adversarial-review defects (db47754 follow-up) ──────────
  // Revert each named production fix → the matching check fails.
  check('M3 expectedText UNKNOWN is first-class (never []-means-no-text on recovery)', () => {
    // Prompt distinguishes UNKNOWN from empty-known.
    const unknown = qc.buildVisionUserContent({
      originalProductUrl: 'https://cdn.example/o.jpg',
      renderUrl: 'https://cdn.example/r.png',
      brandName: 'Allbirds',
      safeBox: {},
      deliveryDims: { width: 1080, height: 1350 },
      expectedTextUnknown: true
    });
    const uText = unknown.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    assert.match(uText, /UNKNOWN/i);
    assert.match(uText, /intrinsic/i);
    assert.ok(!/none — pure product image is legitimate/.test(uText),
      'UNKNOWN must not render as pure-product empty list');

    const emptyKnown = qc.buildVisionUserContent({
      originalProductUrl: 'https://cdn.example/o.jpg',
      renderUrl: 'https://cdn.example/r.png',
      brandName: 'Allbirds',
      safeBox: {},
      deliveryDims: { width: 1080, height: 1350 },
      expectedText: []
    });
    const eText = emptyKnown.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    assert.match(eText, /none — pure product image is legitimate/);

    const rec = require('../services/imageRecoveryService');
    // Submission-audit reconstruction when prompt has role -> text lines.
    const parsed = rec.extractExpectedTextFromSubmissionPrompt(
      'SET EXACTLY THESE STRINGS\n  brand line -> Walk in comfort\n  cta button -> Shop Now\n'
    );
    assert.deepStrictEqual(parsed, ['Walk in comfort', 'Shop Now']);
    const unk = rec.resolveExpectedTextForRecovery({ imageGeneration: { prompt: 'no copy block' } });
    assert.strictEqual(unk.expectedTextUnknown, true);
    // judgeRender call site must not hard-code expectedText: [].
    const recSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'imageRecoveryService.js'), 'utf8'
    );
    const ji = recSrc.indexOf('judgeRender({');
    assert.ok(ji > -1);
    const call = recSrc.slice(ji, recSrc.indexOf('});', ji) + 2);
    assert.ok(!/expectedText:\s*\[\s*\]/.test(call),
      'recovery judge must not pass expectedText:[] (false-fails every texted ad)');
    assert.match(call, /expectedTextUnknown/);
  });

  check('M4 bootRecovery owns rendering+receipt → recoverImageAd (not log-and-leave)', () => {
    const bootSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'bootRecoveryService.js'), 'utf8'
    );
    assert.match(bootSrc, /recoverImageAd|imageRecoveryService/,
      'bootRecovery must call recoverImageAd for static receipts');
    assert.match(bootSrc, /status:\s*['"]rendering['"]/);
    assert.match(bootSrc, /HAS_RECEIPT/);
    // Must not only warn and leave paid plates undelivered.
    assert.ok(!/cannot be delivered yet \(needs crop \+ logo \+ upload\)/.test(bootSrc),
      'must not leave paid images uncollected with the old log-only branch');
  });

  check('M5 pre-spend idempotency: re-read before judgeRender in recovery', () => {
    const recSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'imageRecoveryService.js'), 'utf8'
    );
    const fn = recSrc.indexOf('async function maybeQcRecoveredPlate');
    assert.ok(fn > -1, 'maybeQcRecoveredPlate missing');
    const body = recSrc.slice(fn, recSrc.indexOf('function surfaceForAd', fn));
    const reRead = body.indexOf('Ad.findById');
    const judge = body.indexOf('judgeRender');
    assert.ok(reRead > -1 && judge > reRead, 'must re-read before judgeRender');
    assert.match(body.slice(reRead, judge), /visionQc/,
      'must short-circuit when visionQc already present');
  });

  check('M6 QC-failed recovery lands status failed (not plain draft)', () => {
    const recSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'imageRecoveryService.js'), 'utf8'
    );
    assert.ok(
      /qcFailed\s*\?\s*['"]failed['"]\s*:\s*['"]draft['"]/.test(recSrc)
      || /status:\s*qcFailed\s*\?\s*['"]failed['"]/.test(recSrc),
      'QC fail must not land as plain draft'
    );
    // Paid renderUrl still persisted either way.
    assert.match(recSrc, /renderUrl/, 'paid pixels must still be written');
  });

  check('M7 alertQcFailure title reflects regeneration (recovery = no regen)', () => {
    assert.strictEqual(
      qc.qcFailureTitle({ finalAttempt: 1, attempts: [{ attempt: 1 }] }),
      'Static ad failed vision QC (no regeneration)'
    );
    assert.strictEqual(
      qc.qcFailureTitle({ finalAttempt: 2, attempts: [{}, {}] }),
      'Static ad failed vision QC after one regeneration'
    );
    assert.strictEqual(
      qc.qcFailureTitle({ finalAttempt: 2, attempts: [{}, {}] }, { regenerated: false }),
      'Static ad failed vision QC (no regeneration)'
    );
    const captured = fakeNotify(() => qc.alertQcFailure({
      adId: 'ad-rec', brandId: 'b1', productId: 'p1', brandName: 'X',
      visionQc: qc.buildPersistedVerdict({
        passed: false, finalAttempt: 1,
        attempts: [{
          attempt: 1, pass: false, categories: FAIL_VERDICT.categories,
          findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary,
          renderUrl: 'https://cdn.example/r.png'
        }]
      }),
      regenerated: false
    }));
    assert.ok(captured, 'alert must fire');
    assert.match(captured.title, /no regeneration/i);
    assert.ok(!/after one regeneration/i.test(captured.title));
  });

  check('M8 ads list projection includes visionQc.reason', () => {
    const adsSrc = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8'
    );
    // List projection block (not only the full inspector).
    assert.match(adsSrc, /reason:\s*a\.visionQc\.reason/);
  });

  check('M9 rate-limit drops increment suppressed (both buckets)', () => {
    const alertSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'alertService.js'), 'utf8'
    );
    // Inside the !withinRateLimit branch, suppressed must be incremented.
    const i = alertSrc.indexOf('if (!withinRateLimit');
    assert.ok(i > -1);
    const end = alertSrc.indexOf('return false;', i);
    assert.ok(end > i);
    const branch = alertSrc.slice(i, end + 20);
    assert.match(branch, /suppressed\.set/,
      'rate-limit deny must count toward +N more (suppressed)');
    assert.match(branch, /lastSentAt\.delete/,
      'rate-limit deny still releases the dedupe slot');
  });

  await checkAsync('M10 flag-off runPostRenderQc does not claim passed:true', async () => {
    const result = await qc.runPostRenderQc({
      enabled: false,
      originalProductUrl: 'https://cdn.example/o.jpg',
      generate: async () => makeOutput(1)
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.visionQc.disabled, true);
    assert.strictEqual(result.visionQc.passed, false,
      'uninspected must not claim passed — landmine for .passed-only callers');
  });

  check('M11 formatThreadLine renders QC summary/attempt (not dead payload)', () => {
    const runFeed = require('../services/runFeedService');
    const line = runFeed.formatThreadLine({
      t: Date.now(),
      stage: 'vision QC pass',
      adId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      meta: { summary: 'clean product', attempt: 1, template: 'ai_brand_led', aspectRatio: '1:1' }
    });
    assert.match(line, /attempt=1/);
    assert.match(line, /clean product/);
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

  // ── O. VIDEO post-render vision QC ─────────────────────────────────
  // Closes the gap where the video pipeline shipped with ZERO vision
  // inspection while statics were protected — see adVisionQcService.js's
  // file-header CONTRACT block. Revert: dropping the seed-vs-frames
  // comparison fails O1; letting a FAIL verdict flip result.ok to false
  // (the static path's "fail the ad" contract) fails O3 — video must
  // ALWAYS flag, never fail (master already paid for; see
  // runVideoPostRenderQc's docstring for the full money reasoning).
  const SAMPLE_FRAMES = [
    { timestampSec: 2.5, url: 'https://res.cloudinary.com/x/video/upload/so_2.5,f_jpg/v1/a.jpg' },
    { timestampSec: 5.0, url: 'https://res.cloudinary.com/x/video/upload/so_5.0,f_jpg/v1/a.jpg' },
    { timestampSec: 7.5, url: 'https://res.cloudinary.com/x/video/upload/so_7.5,f_jpg/v1/a.jpg' }
  ];

  check('O1 buildVideoVisionUserContent: seed first, N frames in order, correctly labelled', () => {
    const content = qc.buildVideoVisionUserContent({
      originalProductUrl: 'https://cdn.example/seed.jpg',
      frames: SAMPLE_FRAMES,
      brandName: 'Vuori'
    });
    const imageParts = content.filter((c) => c.type === 'image_url');
    assert.strictEqual(imageParts.length, 4, 'expected seed + 3 frames');
    assert.strictEqual(imageParts[0].image_url.url, 'https://cdn.example/seed.jpg');
    assert.strictEqual(imageParts[1].image_url.url, SAMPLE_FRAMES[0].url);
    assert.strictEqual(imageParts[3].image_url.url, SAMPLE_FRAMES[2].url);
    const labels = content.filter((c) => c.type === 'text').map((c) => c.text);
    assert.ok(labels.some((t) => /ORIGINAL PRODUCT PHOTO/.test(t)));
    assert.ok(labels.some((t) => /VIDEO FRAME @ t=2\.5s/.test(t)));
    assert.ok(labels.some((t) => /VIDEO FRAME @ t=7\.5s/.test(t)));
  });

  check('O1b buildVideoVisionUserContent requires originalProductUrl and frames', () => {
    assert.throws(() => qc.buildVideoVisionUserContent({ frames: SAMPLE_FRAMES }), /originalProductUrl/);
    assert.throws(() => qc.buildVideoVisionUserContent({ originalProductUrl: 'x', frames: [] }), /frames/);
  });

  check('O2 buildVideoVisionUserContent scopes text_defects to product-intrinsic text only', () => {
    const content = qc.buildVideoVisionUserContent({
      originalProductUrl: 'https://cdn.example/seed.jpg', frames: SAMPLE_FRAMES, brandName: 'Vuori'
    });
    const prompt = content[0].text;
    assert.match(prompt, /NOT the ad's caption overlay/i);
    assert.match(prompt, /OUT OF SCOPE/);
  });

  await checkAsync('O3 video FAIL verdict is flagged, NEVER signalled as "fail the ad" (ok stays true)', async () => {
    const result = await qc.runVideoPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/seed.jpg',
      frames: SAMPLE_FRAMES,
      brandName: 'Vuori',
      deliveredUrl: 'https://cdn.example/delivered.mp4',
      judgeFn: async () => FAIL_VERDICT
    });
    assert.strictEqual(result.ok, true, 'video QC must never signal "fail the ad" — the master is already paid for');
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.visionQc.passed, false);
    assert.strictEqual(result.visionQc.finalAttempt, 1, 'video QC never regenerates — exactly one attempt');
    assert.strictEqual(result.visionQc.attempts.length, 1);
    assert.strictEqual(result.visionQc.attempts[0].renderUrl, 'https://cdn.example/delivered.mp4');
  });

  await checkAsync('O4 video PASS verdict', async () => {
    const result = await qc.runVideoPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/seed.jpg',
      frames: SAMPLE_FRAMES,
      judgeFn: async () => PASS_VERDICT
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.visionQc.passed, true);
  });

  await checkAsync('O5 video QC never regenerates even after a fail — no generate()/re-render hook exists to call', async () => {
    let judgeCalls = 0;
    const result = await qc.runVideoPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/seed.jpg',
      frames: SAMPLE_FRAMES,
      judgeFn: async () => { judgeCalls += 1; return FAIL_VERDICT; }
    });
    assert.strictEqual(judgeCalls, 1, 'exactly one vision call — video QC has no regeneration budget to spend');
    assert.strictEqual(result.visionQc.maxRegenerations, 1, 'buildPersistedVerdict shape unchanged (shared with static)');
  });

  await checkAsync('O6 video judge throw ships uninspected, does not fabricate a verdict', async () => {
    const result = await qc.runVideoPostRenderQc({
      enabled: true,
      originalProductUrl: 'https://cdn.example/seed.jpg',
      frames: SAMPLE_FRAMES,
      judgeFn: async () => { throw new Error('atlas vision timeout'); }
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.uninspected, true);
    assert.match(String(result.visionQc.reason || ''), /atlas vision timeout/);
  });

  await checkAsync('O7 video QC disabled does not call judge and does not claim passed:true', async () => {
    let judgeCalls = 0;
    const result = await qc.runVideoPostRenderQc({
      enabled: false,
      originalProductUrl: 'https://cdn.example/seed.jpg',
      frames: SAMPLE_FRAMES,
      judgeFn: async () => { judgeCalls += 1; return PASS_VERDICT; }
    });
    assert.strictEqual(judgeCalls, 0);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.visionQc.disabled, true);
    assert.strictEqual(result.visionQc.passed, false);
  });

  await checkAsync('O8 video QC with no originalProductUrl skips rather than inventing a comparison', async () => {
    const result = await qc.runVideoPostRenderQc({
      enabled: true, originalProductUrl: null, frames: SAMPLE_FRAMES,
      judgeFn: async () => PASS_VERDICT
    });
    assert.strictEqual(result.skipped, true);
    assert.match(String(result.visionQc.reason || ''), /original product URL/);
  });

  await checkAsync('O9 video QC with no sampleable frames skips (e.g. non-Cloudinary source)', async () => {
    const result = await qc.runVideoPostRenderQc({
      enabled: true, originalProductUrl: 'https://cdn.example/seed.jpg', frames: [],
      judgeFn: async () => PASS_VERDICT
    });
    assert.strictEqual(result.skipped, true);
    assert.match(String(result.visionQc.reason || ''), /frames/);
  });

  check('O10 video QC prompt uses the SAME 4 CATEGORIES keys as static (Ad.visionQc / summarizeVisionQc / gallery UI need no video-specific branch)', () => {
    const content = qc.buildVideoVisionUserContent({
      originalProductUrl: 'https://cdn.example/seed.jpg', frames: SAMPLE_FRAMES
    });
    for (const key of qc.CATEGORIES) {
      assert.ok(content[0].text.includes(key), `category ${key} missing from video prompt — surfacing would break`);
    }
  });

  check('O11 video alerts/titles are labelled "Video ad", not silently reusing "Static ad" copy', () => {
    const captured = fakeNotify(() => qc.alertQcFailure({
      adId: 'vidAd1',
      visionQc: qc.buildPersistedVerdict({
        passed: false, finalAttempt: 1,
        attempts: [{ attempt: 1, pass: false, categories: FAIL_VERDICT.categories, findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary }]
      }),
      mediaLabel: 'Video ad'
    }));
    assert.match(captured.title, /^Video ad failed vision QC/);
  });

  check('O12 static alert titles stay byte-identical to before mediaLabel existed (default arg, back-compat)', () => {
    const captured = fakeNotify(() => qc.alertQcFailure({
      adId: 'statAd1',
      visionQc: qc.buildPersistedVerdict({
        passed: false, finalAttempt: 1,
        attempts: [{ attempt: 1, pass: false, categories: FAIL_VERDICT.categories, findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary }]
      })
    }));
    assert.strictEqual(captured.title, 'Static ad failed vision QC (no regeneration)');
  });

  check('O13 videoFrameService.buildFrameUrls: quartile sampling for an 8-10s ad; empty for a non-Cloudinary source', () => {
    // Anchors the sampling strategy documented in brandScriptExecutor.js's
    // runVideoVisionQcForAd: reused (not reinvented) quartile sampling,
    // verified 2026-08-19 to catch a real defect at all three quartiles on
    // a delivered ad (run run_1787136860887_654ed621).
    const videoFrameService = require('../services/videoFrameService');
    const frames = videoFrameService.buildFrameUrls('https://res.cloudinary.com/x/video/upload/v1/a.mp4', 10);
    assert.strictEqual(frames.length, 3, 'expected quartile sampling (25/50/75%) for a short clip');
    assert.deepStrictEqual(frames.map((f) => f.timestampSec), [2.5, 5, 7.5]);
    const none = videoFrameService.buildFrameUrls('https://example.com/not-cloudinary.mp4', 10);
    assert.strictEqual(none.length, 0, 'non-Cloudinary source must yield zero frames, not a broken URL');
  });

  // ── P. Verbose PASS output → run-feed thread (owner request 2026-08-19:
  // "I want to see the output even if it is approved so I can see what it
  // is looking for and what it observes.") ───────────────────────────
  // Revert: noteQcPassToRunFeed dropping qcDetail fails P1; formatThreadLine
  // ignoring meta.qcDetail fails P3; routing passes through
  // alertQcAccepted/alertService instead of the thread fails H1/H1b (above,
  // unchanged) AND P5/P6 here.
  const fakeNoteEvent = (fn) => {
    const runFeed = require('../services/runFeedService');
    const original = runFeed.noteEvent;
    let captured = null;
    runFeed.noteEvent = (runId, stage, meta) => { captured = { runId, stage, meta }; };
    try { fn(); } finally { runFeed.noteEvent = original; }
    return captured;
  };

  check('P1 noteQcPassToRunFeed sends the FULL category detail, not just a truncated summary', () => {
    const verdict = qc.buildPersistedVerdict({
      passed: true, finalAttempt: 1,
      attempts: [{
        attempt: 1, pass: true,
        categories: {
          competitor_marks: { score: 9, pass: true, findings: [] },
          product_fidelity: { score: 9, pass: true, findings: ['minor colour shift'] },
          text_defects: { score: 10, pass: true, findings: [] },
          layout_safe_box: { score: 10, pass: true, findings: [] }
        },
        summary: 'clean', renderUrl: 'https://cdn.example/pass.mp4'
      }]
    });
    const captured = fakeNoteEvent(() => qc.noteQcPassToRunFeed({
      campaignRunId: 'run1', adId: 'ad1', visionQc: verdict
    }));
    assert.ok(captured, 'noteEvent was not called');
    assert.ok(captured.meta.qcDetail, 'qcDetail missing — pass path is still summary-only');
    assert.ok(captured.meta.qcDetail.includes('minor colour shift'), 'per-category finding missing from pass detail');
    assert.ok(captured.meta.qcDetail.includes('product_fidelity'), 'category breakdown missing from pass detail');
    assert.match(captured.meta.qcDetail, /VERDICT: PASS/);
  });

  check('P2 noteQcFailToRunFeed also carries the full qcDetail block (thread is a complete audit trail either way)', () => {
    const verdict = qc.buildPersistedVerdict({
      passed: false, finalAttempt: 1,
      attempts: [{ attempt: 1, pass: false, categories: FAIL_VERDICT.categories, findings: FAIL_VERDICT.findings, summary: FAIL_VERDICT.summary, renderUrl: 'https://cdn.example/fail.mp4' }]
    });
    const captured = fakeNoteEvent(() => qc.noteQcFailToRunFeed({
      campaignRunId: 'run1', adId: 'ad2', visionQc: verdict
    }));
    assert.ok(captured.meta.qcDetail.includes('competitor_marks'));
    assert.match(captured.meta.qcDetail, /VERDICT: FAIL/);
  });

  check('P3 formatThreadLine appends meta.qcDetail as a block after the one-line summary', () => {
    const runFeed = require('../services/runFeedService');
    const line = runFeed.formatThreadLine({
      t: Date.now(), stage: 'vision QC pass', adId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      meta: { summary: 'clean', attempt: 1, qcDetail: 'VERDICT: PASS\nproduct_fidelity: 9/10' }
    });
    assert.match(line, /attempt=1/);
    assert.match(line, /VERDICT: PASS/);
    assert.match(line, /product_fidelity: 9\/10/);
  });

  check('P4 formatThreadLine is byte-identical when qcDetail is absent (every non-QC caller of noteEvent/onStage unchanged)', () => {
    const runFeed = require('../services/runFeedService');
    const line = runFeed.formatThreadLine({
      t: Date.now(), stage: 'static image generation', adId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      meta: { template: 'ai_brand_led', aspectRatio: '1:1' }
    });
    assert.ok(!line.includes('\n'), 'a non-QC event must stay single-line');
  });

  check('P5 noteQcPassToRunFeed does NOT route through alertService even with qcDetail added (rate-limit safe)', () => {
    const qcSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'adVisionQcService.js'), 'utf8'
    );
    const m = qcSrc.match(/function noteQcPassToRunFeed\([\s\S]*?\n\}/);
    assert.ok(m, 'noteQcPassToRunFeed not found');
    assert.ok(!/alertService|notifyAsync|alertQcAccepted/.test(m[0]),
      'noteQcPassToRunFeed must not touch alertService even with the verbose detail added');
  });

  check('P6 runFeedService does not require alertService at all — the "thread is unmetered" claim is structural, not assumed', () => {
    const runFeedSrc = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'runFeedService.js'), 'utf8'
    );
    assert.ok(!/require\(['"]\.\/alertService['"]\)/.test(runFeedSrc),
      'runFeedService requiring alertService would put the "unmetered thread" claim at risk');
    // Own, separate rate-limit surface: Slack HTTP 429 handling only
    // (drop-this-flush, never sleep) — no shared counter with alertService.
    assert.ok(!/withinRateLimit|rateLimitState|lastSentAt/.test(runFeedSrc),
      "runFeedService must not reuse alertService's rate-limit primitives");
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
