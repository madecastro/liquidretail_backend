#!/usr/bin/env node
/**
 * verifyQcTrustsLogoGeometry.js — the vision-QC judge must be TOLD the
 * composited logo's code-computed rectangle for layout_safe_box, not asked
 * to estimate the logo's position by eye.
 *
 * THE DEFECT (2026-08-24, follow-up to verifyLogoSafeBox.js)
 * ------------------------------------------------------------------------
 * verifyLogoSafeBox.js proved logoPlacementFor always composites the brand
 * mark strictly inside the QC-declared safe box (>= LOGO_INSET_PX_FLOOR
 * margin on every live surface) since the 2026-08-24 inset fix (#327/#23).
 * That fix did NOT stop the false positives: pixel-measured production ads
 * rendered AFTER it deployed (e.g. meta_feed_4_5 +15px right/+38px bottom,
 * pmax_square_1_1 +25px — both comfortably inside) were STILL rejected by
 * vision QC with findings like "extends beyond the safe box boundaries
 * (right > 1080px, bottom > 1080px)" — numbers that are just the safe box's
 * own boundary restated, not an independent pixel read. The margin (13-38px,
 * ~1-3.5% of frame) is real but too narrow for a vision model doing
 * approximate spatial reasoning to perceive as "clearly inside".
 *
 * THE FIX: since the exact logo rectangle is already computed by
 * logoPlacementFor at composite time, stop asking vision to re-derive it.
 * `computeLogoGeometry` (adVisionQcService) compares the code-computed rect
 * against the code-computed safe box — pure arithmetic, no vision — and
 * `buildVisionUserContent` tells the judge the measured fact instead of
 * making it guess. layout_safe_box's TEXT/CTA half (drawn by the image
 * model, whose pixel location code cannot know) is untouched and still
 * vision-judged.
 *
 * Offline: no DB, no network, no API key. Drives the real exported functions
 * end to end — the pure geometry, the prompt builder, and the wiring through
 * runPostRenderQc / judgeRender (stubbed transport only).
 *
 * MUTATIONS THAT MUST FAIL THIS FILE
 * ------------------------------------------------------------------------
 *   1. computeLogoGeometry stops being exported, or starts always
 *      returning null                                          → G1-G6
 *   2. buildVisionUserContent stops accepting/using logoGeometry → P1-P4
 *   3. runPostRenderQc stops computing logoGeometry from
 *      output.logoRect, or stops passing it to judge()          → W1-W3
 *   4. judgeRender stops forwarding logoGeometry into
 *      buildVisionUserContent                                   → W4
 *   5. buildPersistedVerdict drops logoGeometry from the
 *      persisted attempt shape                                  → W3b
 *   6. finishPlate stops returning logoRect                     → F1-F2
 *
 * REMOVED (dormant render fallback deletion, 2026-09-07): F3 pinned the
 * mint-time renderDirectImage `firstOutput` threading of plate.logoRect.
 * That caller is gone. finishPlate STILL returns logoRect (F1-F2 stay);
 * recovery is the remaining live backend caller and is already pinned
 * by R1. This is not a finishPlate regression — finishPlate never
 * called QC; QC was the caller's job.
 *
 * Run: node scripts/verifyQcTrustsLogoGeometry.js
 */
'use strict';

const pf = require('../services/platformFormats');
const intents = require('../services/staticAdIntents');
const direct = require('../services/directImageRenderService');
const qc = require('../services/adVisionQcService');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function liveImageSurfaces() {
  return pf.PLATFORM_FORMAT_KEYS.filter((k) => {
    const f = pf.PLATFORM_FORMATS[k];
    return f && f.status === 'live' && Array.isArray(f.kinds) && f.kinds.includes('image');
  });
}

function marginsVs(rect, box) {
  return {
    left: rect.left - box.left,
    top: rect.top - box.top,
    right: box.right - (rect.left + rect.width),
    bottom: box.bottom - (rect.top + rect.height)
  };
}

// ── A. computeLogoGeometry — pure geometry, cross-checked against a hand
//     computation, across every live static surface. ────────────────────
check('G0 computeLogoGeometry is exported', typeof qc.computeLogoGeometry === 'function');

const SURFACES = liveImageSurfaces();
check('G0b at least six live static surfaces exist', SURFACES.length >= 6);

for (const key of SURFACES) {
  const s = intents.computeSurface(key);
  const dims = direct.deliveryGeometryFor(s);
  const box = direct.logoResizeBox(dims);
  const place = direct.logoPlacementFor({ surface: s, dims, logoW: box.width, logoH: box.height });
  const safeBox = direct.safeBoxInDeliveredPx(s, dims);
  if (!place) { failures.push(`G1 ${key} logoPlacementFor returned null — cannot exercise fixture`); continue; }

  const geom = qc.computeLogoGeometry(place, safeBox);
  const wantMargin = marginsVs(place, safeBox);

  check(`G1 ${key} computeLogoGeometry returns a result for a real placement`, !!geom,
    `place=${JSON.stringify(place)} safeBox=${JSON.stringify(safeBox)}`);
  if (!geom) continue;

  check(`G2 ${key} computeLogoGeometry.margin matches the independent hand computation`,
    geom.margin.left === wantMargin.left && geom.margin.top === wantMargin.top
    && geom.margin.right === wantMargin.right && geom.margin.bottom === wantMargin.bottom,
    `got ${JSON.stringify(geom.margin)} want ${JSON.stringify(wantMargin)}`);

  check(`G3 ${key} computeLogoGeometry says withinSafeBox:true (matches verifyLogoSafeBox's own guarantee)`,
    geom.withinSafeBox === true, `margin=${JSON.stringify(geom.margin)}`);

  check(`G4 ${key} computeLogoGeometry.rect reconstructs right/bottom correctly`,
    geom.rect.right === place.left + place.width && geom.rect.bottom === place.top + place.height);
}

// G5: a rect that genuinely overflows the box must report withinSafeBox:false
// with a negative margin on the overflowing side — not silently clamped or
// dropped. This is the defensive branch the prompt text treats as a
// CONFIRMED breach (never softened into vision's problem).
{
  const box = { left: 100, top: 100, right: 900, bottom: 900 };
  const overflowRight = { left: 850, top: 800, width: 100, height: 50 }; // right edge at 950 > 900
  const geom = qc.computeLogoGeometry(overflowRight, box);
  check('G5 an out-of-box rect reports withinSafeBox:false', geom && geom.withinSafeBox === false,
    JSON.stringify(geom));
  check('G5b the overflowing side has a negative margin', geom && geom.margin.right < 0,
    JSON.stringify(geom && geom.margin));
  check('G5c the non-overflowing sides keep non-negative margins', geom
    && geom.margin.left >= 0 && geom.margin.top >= 0 && geom.margin.bottom >= 0,
    JSON.stringify(geom && geom.margin));
}

// G6: null in, null out — no rect, no box, or a non-finite rect must never
// fabricate a verdict either way.
check('G6a null logoRect returns null', qc.computeLogoGeometry(null, { left: 0, top: 0, right: 100, bottom: 100 }) === null);
check('G6b null safeBox returns null', qc.computeLogoGeometry({ left: 0, top: 0, width: 10, height: 10 }, null) === null);
check('G6c non-finite rect returns null', qc.computeLogoGeometry({ left: NaN, top: 0, width: 10, height: 10 }, { left: 0, top: 0, right: 100, bottom: 100 }) === null);

// ── B. buildVisionUserContent — the PROMPT must actually change based on
//     logoGeometry, and vision must be told to trust it, not re-derive it. ──

function promptText(userContent) {
  const first = Array.isArray(userContent) ? userContent[0] : null;
  return first && first.text ? first.text : '';
}

{
  const withinGeom = qc.computeLogoGeometry(
    { left: 800, top: 800, width: 200, height: 100 },
    { left: 0, top: 0, right: 1080, bottom: 1080 }
  );
  const content = qc.buildVisionUserContent({
    originalProductUrl: 'https://example.com/a.jpg',
    renderUrl: 'https://example.com/b.jpg',
    brandName: 'Acme',
    safeBox: { left: 0, top: 0, right: 1080, bottom: 1080 },
    deliveryDims: { width: 1080, height: 1080 },
    expectedText: [],
    logoGeometry: withinGeom
  });
  const text = promptText(content);

  check('P1 prompt states the logo rect was placed by RENDERING CODE',
    /RENDERING CODE/.test(text) && text.includes('left=800') && text.includes('top=800'));
  check('P2 prompt instructs the model to TRUST the measured fact over its own estimate',
    /TRUST THIS[\s\S]*MEASURED FACT/.test(text));
  check('P3 prompt explicitly forbids flagging the logo position under layout_safe_box',
    /do NOT flag[\s\S]*logo's POSITION under layout_safe_box/i.test(text));
  check('P4 category 4 text is scoped to TEXT/CTA, no longer "text, CTA, or logo"',
    /Any TEXT or CTA that breaches/.test(text) && !/Any text, CTA, or logo that breaches/.test(text));
}

{
  // No logo composited at all.
  const content = qc.buildVisionUserContent({
    originalProductUrl: 'https://example.com/a.jpg',
    renderUrl: 'https://example.com/b.jpg',
    brandName: 'Acme',
    safeBox: { left: 0, top: 0, right: 1080, bottom: 1080 },
    deliveryDims: { width: 1080, height: 1080 },
    expectedText: [],
    logoGeometry: null
  });
  const text = promptText(content);
  check('P5 no-logo case tells the judge no rectangle was measured',
    /No brand logo rectangle was measured/.test(text));
}

{
  // Defensive branch: code itself found a breach.
  const breachGeom = qc.computeLogoGeometry(
    { left: 950, top: 950, width: 200, height: 100 }, // overflows both edges
    { left: 0, top: 0, right: 1080, bottom: 1080 }
  );
  const content = qc.buildVisionUserContent({
    originalProductUrl: 'https://example.com/a.jpg',
    renderUrl: 'https://example.com/b.jpg',
    brandName: 'Acme',
    safeBox: { left: 0, top: 0, right: 1080, bottom: 1080 },
    deliveryDims: { width: 1080, height: 1080 },
    expectedText: [],
    logoGeometry: breachGeom
  });
  const text = promptText(content);
  check('P6 a code-detected breach is stated as CONFIRMED, not softened',
    /CONFIRMED layout_safe_box breach/.test(text));
}

// ── C. Wiring through judgeRender — logoGeometry must actually reach the
//     prompt builder from the public judge entry point. ───────────────────
(async () => {
  let capturedMessages = null;
  const stubChat = async (_meta, params) => {
    capturedMessages = params.messages;
    return { choices: [{ message: { content: '{"categories":{"competitor_marks":{"score":10,"pass":true,"findings":[]},"product_fidelity":{"score":10,"pass":true,"findings":[]},"text_defects":{"score":10,"pass":true,"findings":[]},"layout_safe_box":{"score":10,"pass":true,"findings":[]}},"summary":"ok"}' } }] };
  };
  const geom = qc.computeLogoGeometry(
    { left: 700, top: 700, width: 300, height: 150 },
    { left: 0, top: 0, right: 1080, bottom: 1080 }
  );
  await qc.judgeRender({
    originalProductUrl: 'https://example.com/a.jpg',
    renderUrl: 'https://example.com/b.jpg',
    brandName: 'Acme',
    safeBox: { left: 0, top: 0, right: 1080, bottom: 1080 },
    deliveryDims: { width: 1080, height: 1080 },
    expectedText: [],
    logoGeometry: geom
  }, { chatCompletion: stubChat });

  const sentText = capturedMessages
    && capturedMessages[0] && Array.isArray(capturedMessages[0].content)
    ? promptText(capturedMessages[0].content)
    : '';
  check('W4 judgeRender forwards logoGeometry into the actual vision prompt sent to the model',
    sentText.includes('left=700') && /TRUST THIS[\s\S]*MEASURED FACT/.test(sentText),
    `sent length=${sentText.length}`);

  // ── D. Wiring through runPostRenderQc — logoGeometry must be DERIVED from
  //     output.logoRect (the plate the generate() step just composited),
  //     passed into judge(), and preserved on the persisted verdict. ───────
  let judgeArgsSeen = null;
  const fakeGenerate = async ({ attempt }) => ({
    renderUrl: `https://example.com/r${attempt}.png`,
    buffer: null,
    contentType: 'image/png',
    // The composited logo rect for THIS attempt's plate.
    logoRect: { left: 820, top: 820, width: 180, height: 90 }
  });
  const fakeJudge = async (args) => {
    judgeArgsSeen = args;
    return { pass: true, categories: {
      competitor_marks: { score: 10, pass: true, findings: [] },
      product_fidelity: { score: 10, pass: true, findings: [] },
      text_defects: { score: 10, pass: true, findings: [] },
      layout_safe_box: { score: 10, pass: true, findings: [] }
    }, findings: [], summary: 'ok' };
  };

  const result = await qc.runPostRenderQc({
    enabled: true,
    originalProductUrl: 'https://example.com/a.jpg',
    brandName: 'Acme',
    safeBox: { left: 0, top: 0, right: 1080, bottom: 1080 },
    deliveryDims: { width: 1080, height: 1080 },
    expectedText: [],
    generate: fakeGenerate,
    judgeFn: fakeJudge
  });

  const wantGeom = qc.computeLogoGeometry(
    { left: 820, top: 820, width: 180, height: 90 },
    { left: 0, top: 0, right: 1080, bottom: 1080 }
  );

  check('W1 runPostRenderQc computes logoGeometry from output.logoRect and hands it to judge()',
    judgeArgsSeen && judgeArgsSeen.logoGeometry
      && judgeArgsSeen.logoGeometry.rect.left === wantGeom.rect.left
      && judgeArgsSeen.logoGeometry.withinSafeBox === wantGeom.withinSafeBox,
    `got ${JSON.stringify(judgeArgsSeen && judgeArgsSeen.logoGeometry)}`);

  check('W2 runPostRenderQc still reports ok:true / passed:true on a clean pass (no behaviour change)',
    result && result.ok === true && result.visionQc && result.visionQc.passed === true,
    JSON.stringify(result && result.visionQc));

  const attempt0 = result && result.visionQc && result.visionQc.attempts && result.visionQc.attempts[0];
  check('W3 the persisted verdict keeps logoGeometry on the attempt record (audit trail)',
    attempt0 && attempt0.logoGeometry && attempt0.logoGeometry.withinSafeBox === wantGeom.withinSafeBox,
    JSON.stringify(attempt0 && attempt0.logoGeometry));

  // W3b: buildPersistedVerdict on its own (not just via runPostRenderQc) must
  // not silently drop a caller-supplied logoGeometry — this is what
  // imageRecoveryService's one-shot verdict construction depends on.
  const built = qc.buildPersistedVerdict({
    passed: true,
    finalAttempt: 1,
    attempts: [{
      attempt: 1, pass: true,
      categories: { competitor_marks: { score: 10, pass: true, findings: [] } },
      findings: [], summary: 'ok', renderUrl: 'https://example.com/x.png',
      logoGeometry: wantGeom
    }]
  });
  check('W3b buildPersistedVerdict preserves a caller-supplied logoGeometry',
    built.attempts[0].logoGeometry && built.attempts[0].logoGeometry.withinSafeBox === wantGeom.withinSafeBox,
    JSON.stringify(built.attempts[0].logoGeometry));

  // No-logo attempt: logoRect absent → judge must be told, and no crash.
  let noLogoJudgeArgs = null;
  const noLogoGenerate = async () => ({ renderUrl: 'https://example.com/nologo.png', logoRect: null });
  const noLogoJudge = async (args) => { noLogoJudgeArgs = args; return { pass: true, categories: {
    competitor_marks: { score: 10, pass: true, findings: [] },
    product_fidelity: { score: 10, pass: true, findings: [] },
    text_defects: { score: 10, pass: true, findings: [] },
    layout_safe_box: { score: 10, pass: true, findings: [] }
  }, findings: [], summary: 'ok' }; };
  await qc.runPostRenderQc({
    enabled: true,
    originalProductUrl: 'https://example.com/a.jpg',
    brandName: 'Acme',
    safeBox: { left: 0, top: 0, right: 1080, bottom: 1080 },
    deliveryDims: { width: 1080, height: 1080 },
    expectedText: [],
    generate: noLogoGenerate,
    judgeFn: noLogoJudge
  });
  check('W5 a no-logo attempt (logoRect:null) passes logoGeometry:null through, no throw',
    noLogoJudgeArgs && noLogoJudgeArgs.logoGeometry === null,
    JSON.stringify(noLogoJudgeArgs && noLogoJudgeArgs.logoGeometry));

  // ── E. finishPlate returns the rect it actually composited (source-level
  //     wiring — the DB/network-free structural half of the fix). ─────────
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'directImageRenderService.js'), 'utf8');
  check('F1 finishPlate declares composedLogoRect and returns it as logoRect',
    /let composedLogoRect = null/.test(src) && /logoRect: composedLogoRect/.test(src));
  check('F2 finishPlate sets composedLogoRect at the same site it pushes the composite layer',
    /layers\.push\(\{ input: toPlace, top: place\.top, left: place\.left \}\);\s*\n\s*composedLogoRect = /.test(src));
  // F3 REMOVED 2026-09-07: the mint-time renderDirectImage firstOutput
  // `logoRect: plate.logoRect || null` caller is gone. finishPlate still
  // RETURNS logoRect (F1-F2); recovery is the remaining live backend
  // caller and is already pinned by R1. Not a finishPlate regression.

  const recSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'imageRecoveryService.js'), 'utf8');
  check('R1 the recovery path passes the recovered plate\'s logoRect into maybeQcRecoveredPlate',
    /maybeQcRecoveredPlate\(\{\s*\n?\s*ad, brand, surface, dims, renderUrl, logoRect: plate\.logoRect \|\| null/.test(recSrc));
  check('R2 maybeQcRecoveredPlate computes logoGeometry via the shared helper',
    /computeLogoGeometry\(logoRect, safeBox\)/.test(recSrc));
  check('R3 maybeQcRecoveredPlate forwards logoGeometry into judgeRender',
    /judgeRender\(\{[\s\S]{0,400}logoGeometry,/.test(recSrc));

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\nverifyQcTrustsLogoGeometry: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
