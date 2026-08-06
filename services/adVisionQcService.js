// Post-render VISION QC for static product ads.
//
// WHY: prompts already demand product fidelity (staticAdIntents.js:261-264,423)
// and gpt-image-2/edit has no input_fidelity param. Live 2026-08-03 renders still
// stamped competitor-shaped brand marks onto products (~1 in 3). The remaining
// lever is measure-and-reject against the ORIGINAL product photo.
//
// CONTRACT:
//   - Always compare ORIGINAL PRODUCT vs FINISHED RENDER in ONE vision call.
//   - Four categories, each scored + findings.
//   - Fail → regenerate exactly ONCE with a corrective prompt → re-QC.
//   - Second failure → fail the ad (never a third generation). MONEY INVARIANT.
//   - Discarded (already-paid) renders keep their URL on the persisted verdict.
//
// Feature flag: AD_VISION_QC_ENABLED (default false — see defaults.env).
// Model role: 'ad-vision-qc' in atlasModelMap (routing MUST be probed live).

'use strict';

const { chatCompletion } = require('./atlasLlmService');

// ── MONEY INVARIANT ───────────────────────────────────────────────────
// Exactly one regeneration is allowed after a failed QC pass. This is a
// hard constant, NOT an env knob — raising it multiplies billable image
// submits. The harness asserts behavioural count, not just this number.
const MAX_QC_REGENERATIONS = 1;

const CATEGORIES = Object.freeze([
  'competitor_marks',
  'product_fidelity',
  'text_defects',
  'layout_safe_box'
]);

// Per-category minimum to pass (0–10 integer scores from the model).
const PASS_FLOOR = 7;

// Role name in atlasModelMap. Env ATLAS_MODEL_AD_VISION_QC can re-point.
// CHOSEN: gemini-2.5-flash — already used for vision identify/match work in
// this repo (geminiIdentifyService, visualCatalogMatchService), listed in
// MAP with atlas slug google/gemini-2.5-flash, cheap enough for every static
// ad. NOT inventing a catalog id. ROUTING MUST BE CONFIRMED LIVE before
// merge (catalog listing ≠ routable — see gpt-5-nano trap in atlasModelMap).
const QC_MODEL_ROLE = 'ad-vision-qc';

function isEnabled() {
  return String(process.env.AD_VISION_QC_ENABLED || '').toLowerCase() === 'true';
}

function resolveQcModel() {
  const override = process.env.ATLAS_MODEL_AD_VISION_QC || process.env.AD_VISION_QC_MODEL;
  if (override) return override;
  return QC_MODEL_ROLE;
}

/**
 * Build the multimodal user content: labelled text + TWO images.
 * Image order is fixed: [0]=ORIGINAL PRODUCT, [1]=GENERATED AD.
 * Follows aiCreativeDirectorService.js:1208-1212 convention
 * ({type:'image_url', image_url:{url}}).
 */
function buildVisionUserContent({
  originalProductUrl,
  renderUrl,
  brandName,
  safeBox,
  deliveryDims,
  expectedText
}) {
  if (!originalProductUrl) throw new Error('adVisionQc: originalProductUrl required');
  if (!renderUrl) throw new Error('adVisionQc: renderUrl required');

  const brand = brandName || 'the advertiser';
  const box = safeBox || {};
  const dims = deliveryDims || {};
  const textList = Array.isArray(expectedText) && expectedText.length
    ? expectedText.map((t) => `  - ${t}`).join('\n')
    : '  (none — pure product image is legitimate)';

  const prompt = `You are a post-render quality inspector for direct-response product ads.

You are given TWO images in this exact order:
  IMAGE 1 — ORIGINAL PRODUCT PHOTO (the source/hero reference the ad was generated from)
  IMAGE 2 — GENERATED AD (the finished render about to ship)

Brand name: ${brand}
Delivery canvas: ${dims.width || '?'}×${dims.height || '?'} px
Declared SAFE BOX (content must stay inside; coordinates in delivered pixels):
  left=${box.left ?? '?'}, top=${box.top ?? '?'}, right=${box.right ?? '?'}, bottom=${box.bottom ?? '?'}
Expected on-ad text strings (if any) — these are the ONLY words that should appear as ad copy:
${textList}

Score EACH category 0–10 (integer) and list concrete findings. Return ONLY JSON.

CATEGORIES

1. competitor_marks (PRIMARY)
   Logos, wordmarks, emblems, badges, tree/animal/crest marks, or other brand
   devices present ON THE PRODUCT in IMAGE 2 that are ABSENT from the product
   in IMAGE 1, OR that belong to a DIFFERENT brand than ${brand}.
   IMPORTANT: ${brand}'s OWN logo composited into a corner of the ad is EXPECTED
   and must NOT be flagged. Only invent marks on the product surface / midfoot /
   chest / hardware that were not on the original product.

2. product_fidelity
   Silhouette, colourway, materials, panel/pocket count, orientation, and
   construction drift from IMAGE 1. Scene/background change is fine; product
   identity drift is not.

3. text_defects
   Misspellings, mangled or duplicated words, gibberish letterforms, and
   literal label leakage (e.g. "RATING: 4.8 ★" printed with the role label
   "RATING" visible). Compare against the expected text list above.

4. layout_safe_box
   Any text, CTA, or logo that breaches the declared safe box numbers above,
   or a CTA that is clipped at the canvas edge. Use the pixel numbers — do
   not invent a different safe region.

JSON SHAPE (no prose outside it):
{
  "categories": {
    "competitor_marks": { "score": 0, "pass": true, "findings": ["..."] },
    "product_fidelity": { "score": 0, "pass": true, "findings": ["..."] },
    "text_defects":     { "score": 0, "pass": true, "findings": ["..."] },
    "layout_safe_box":  { "score": 0, "pass": true, "findings": ["..."] }
  },
  "summary": "one-line overall"
}`;

  return [
    { type: 'text', text: prompt },
    // Explicit labels in adjacent text parts so the model cannot swap them.
    { type: 'text', text: 'IMAGE 1 — ORIGINAL PRODUCT PHOTO:' },
    { type: 'image_url', image_url: { url: originalProductUrl } },
    { type: 'text', text: 'IMAGE 2 — GENERATED AD:' },
    { type: 'image_url', image_url: { url: renderUrl } }
  ];
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(10, Math.round(x)));
}

function emptyCategories(reason) {
  const o = {};
  for (const k of CATEGORIES) {
    o[k] = { score: 0, pass: false, findings: reason ? [reason] : [] };
  }
  return o;
}

/**
 * Normalize model JSON into a stable verdict shape. Pure — no I/O.
 */
function parseVerdict(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { parsed = JSON.parse(cleaned); }
    catch (err) {
      return {
        pass: false,
        parseError: err.message,
        categories: emptyCategories('vision response was not JSON'),
        summary: 'parse failure — treating as QC fail (safe default)',
        findings: ['vision response was not JSON']
      };
    }
  }
  const catsIn = parsed?.categories || {};
  const categories = {};
  const findings = [];
  for (const key of CATEGORIES) {
    const c = catsIn[key] || {};
    const score = clampScore(c.score);
    const f = Array.isArray(c.findings)
      ? c.findings.map((x) => String(x)).filter(Boolean)
      : (c.findings ? [String(c.findings)] : []);
    const pass = score >= PASS_FLOOR;
    categories[key] = { score, pass, findings: f };
    if (!pass) findings.push(...f.map((t) => `[${key}] ${t}`));
  }
  // Any category below floor fails overall. competitor_marks is primary in
  // the prompt; the floor gate treats all four uniformly so a text defect
  // cannot ship either.
  const pass = CATEGORIES.every((k) => categories[k].pass);
  return {
    pass,
    categories,
    summary: String(parsed?.summary || (pass ? 'pass' : 'fail')).slice(0, 500),
    findings,
    parseError: null
  };
}

/**
 * Corrective operator note appended on the single allowed regeneration.
 * Names the invented marks / defects so the image model has an explicit
 * negative instruction (directImageRenderService operatorPrompt path).
 */
function buildCorrectiveNote(verdict) {
  const lines = ['VISION QC CORRECTION — previous render failed inspection. Fix ALL of the following:'];
  const cats = verdict?.categories || {};
  for (const key of CATEGORIES) {
    const c = cats[key];
    if (!c || c.pass) continue;
    const detail = (c.findings && c.findings.length) ? c.findings.join('; ') : 'failed score';
    lines.push(`- ${key}: ${detail}`);
  }
  if (verdict?.categories?.competitor_marks && !verdict.categories.competitor_marks.pass) {
    lines.push(
      '- CRITICAL: remove any competitor logo, emblem, tree mark, badge or wordmark ' +
      'that was not present on the original product photo. Do not invent brand marks on the product.'
    );
  }
  if (verdict?.categories?.text_defects && !verdict.categories.text_defects.pass) {
    lines.push(
      '- Do not print role labels (e.g. "RATING:") — only the value text. Fix every misspelling.'
    );
  }
  lines.push('Reproduce the original product faithfully. Ship only after these defects are gone.');
  return lines.join('\n');
}

function bufferToDataUrl(buffer, contentType = 'image/png') {
  if (!buffer) return null;
  if (typeof buffer === 'string' && /^https?:\/\//i.test(buffer)) return buffer;
  if (typeof buffer === 'string' && buffer.startsWith('data:')) return buffer;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return `data:${contentType};base64,${buf.toString('base64')}`;
}

/**
 * One vision call. Billable LLM — must go through chatCompletion so
 * trackLlmCall ledgers it (overlayZoneService.js:145 pattern).
 *
 * deps.chatCompletion injectable for the offline harness.
 */
async function judgeRender({
  originalProductUrl,
  renderUrl,
  brandName,
  safeBox,
  deliveryDims,
  expectedText,
  brandId = null,
  productId = null,
  adId = null,
  campaignId = null
}, deps = {}) {
  const chat = deps.chatCompletion || chatCompletion;
  const model = deps.model || resolveQcModel();
  const userContent = buildVisionUserContent({
    originalProductUrl,
    renderUrl,
    brandName,
    safeBox,
    deliveryDims,
    expectedText
  });

  // ── MONEY: billable vision LLM call ──────────────────────────────
  const res = await chat(
    {
      stage: 'ad_vision_qc',
      service: 'adVisionQcService',
      purposeTag: 'post_render_qc',
      visionImages: 2,
      brandId,
      productId,
      adId,
      campaignId
    },
    {
      model,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.0,
      max_tokens: 1500,
      // json_object: safe across OpenAI + Gemini Atlas routes. Strict
      // json_schema 400s on Anthropic; validate in parseVerdict.
      response_format: { type: 'json_object' }
    }
  );

  const text = res?.choices?.[0]?.message?.content;
  if (!text) {
    return parseVerdict('{"categories":{},"summary":"empty vision response"}');
  }
  return parseVerdict(text);
}

/**
 * Shape persisted on Ad.visionQc (Mixed). Per-attempt: pass/fail, scores,
 * findings, discarded render URL, attempt number.
 */
function buildPersistedVerdict({ passed, attempts, finalAttempt, skipped = false, disabled = false }) {
  return {
    schemaVersion: 1,
    skipped: !!skipped,
    disabled: !!disabled,
    passed: !!passed,
    finalAttempt: finalAttempt || null,
    maxRegenerations: MAX_QC_REGENERATIONS,
    attempts: (attempts || []).map((a) => ({
      attempt: a.attempt,
      pass: !!a.pass,
      categories: a.categories || emptyCategories(),
      findings: a.findings || [],
      summary: a.summary || null,
      // Paid render URL for this attempt — kept even when discarded.
      renderUrl: a.renderUrl || null,
      discarded: !!a.discarded,
      discardedRenderUrl: a.discarded ? (a.renderUrl || null) : null,
      imageGeneration: a.imageGeneration || null
    }))
  };
}

/**
 * MONEY-CRITICAL control flow.
 *
 * generate({ attempt, correctiveNote }) → {
 *   buffer, contentType?, width?, height?, imageGeneration?, intentResolution?, ...
 * }
 *   Called for attempt 1 (always) and attempt 2 (only if attempt 1 QC fails).
 *   Each call that reaches the image model is billable — the harness counts these.
 *
 * uploadAttempt({ buffer, attempt, contentType }) → url (optional)
 *   Persist paid pixels so a discarded attempt is not thrown away.
 *
 * judgeFn — injectable; production uses judgeRender.
 *
 * HARD BOUND: regenerations never exceed MAX_QC_REGENERATIONS (1).
 * A second QC failure does NOT call generate a third time.
 */
async function runPostRenderQc({
  enabled = isEnabled(),
  originalProductUrl,
  brandName,
  safeBox,
  deliveryDims,
  expectedText,
  brandId = null,
  productId = null,
  adId = null,
  campaignId = null,
  generate,
  uploadAttempt = null,
  judgeFn = null,
  // Test-only: callers cannot raise the production bound above MAX.
  _maxRegenerations = MAX_QC_REGENERATIONS
} = {}) {
  if (typeof generate !== 'function') {
    throw new Error('adVisionQc.runPostRenderQc: generate() required');
  }

  // ── MONEY: clamp any attempt to raise the retry bound ────────────
  const maxRegen = Math.min(
    MAX_QC_REGENERATIONS,
    Math.max(0, Number.isFinite(_maxRegenerations) ? Number(_maxRegenerations) : MAX_QC_REGENERATIONS)
  );

  // ── Flag off: one generation, zero vision, zero regeneration ──
  if (!enabled) {
    const output = await generate({ attempt: 1, correctiveNote: null });
    return {
      ok: true,
      skipped: true,
      output,
      visionQc: buildPersistedVerdict({
        passed: true,
        skipped: true,
        disabled: true,
        finalAttempt: 1,
        attempts: []
      }),
      generationCount: 1,
      regenerationCount: 0,
      visionCallCount: 0
    };
  }

  if (!originalProductUrl) {
    throw new Error('adVisionQc: originalProductUrl required when QC is enabled');
  }

  const judge = judgeFn || ((args) => judgeRender(args));
  const attempts = [];
  let output = null;
  let correctiveNote = null;
  let generationCount = 0;
  let regenerationCount = 0;
  let visionCallCount = 0;

  // attempt 1 = first render; attempt 2 = the single allowed regen (if any)
  const maxAttempts = 1 + maxRegen;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ── MONEY: billable image path ─────────────────────────────────
    // generate() is the image submit (or a return of an already-paid first
    // render). This loop body runs at most (1 + MAX_QC_REGENERATIONS) times.
    output = await generate({ attempt, correctiveNote });
    generationCount += 1;
    if (attempt > 1) regenerationCount += 1;

    // Prefer an already-hosted URL; else data-URL the buffer for vision.
    let renderUrl = output.renderUrl || null;
    if (!renderUrl && output.buffer) {
      renderUrl = bufferToDataUrl(output.buffer, output.contentType || 'image/png');
    }
    if (!renderUrl) {
      throw new Error(`adVisionQc: generate() attempt ${attempt} returned no renderUrl/buffer`);
    }

    // Persist paid pixels for this attempt when an uploader is provided.
    // Failed/discarded attempts MUST keep a durable URL (owner requirement).
    let persistedUrl = output.renderUrl || null;
    if (typeof uploadAttempt === 'function' && output.buffer) {
      try {
        const up = await uploadAttempt({
          buffer: output.buffer,
          attempt,
          contentType: output.contentType || 'image/png',
          width: output.width,
          height: output.height
        });
        if (up) persistedUrl = up;
      } catch (err) {
        console.warn(`   ⚠️  adVisionQc: uploadAttempt(${attempt}) failed: ${err.message}`);
      }
    }

    const visionRenderUrl = persistedUrl || renderUrl;
    // ── MONEY: billable vision LLM call ────────────────────────────
    const verdict = await judge({
      originalProductUrl,
      renderUrl: visionRenderUrl,
      brandName,
      safeBox,
      deliveryDims,
      expectedText,
      brandId,
      productId,
      adId,
      campaignId
    });
    visionCallCount += 1;

    attempts.push({
      attempt,
      pass: !!verdict.pass,
      categories: verdict.categories,
      findings: verdict.findings || [],
      summary: verdict.summary,
      renderUrl: persistedUrl || null,
      discarded: false,
      imageGeneration: output.imageGeneration || null
    });

    if (verdict.pass) {
      // Mark prior attempts discarded (they were paid for and kept).
      for (let i = 0; i < attempts.length - 1; i++) {
        attempts[i].discarded = true;
      }
      return {
        ok: true,
        skipped: false,
        output: { ...output, renderUrl: persistedUrl || output.renderUrl || null },
        visionQc: buildPersistedVerdict({
          passed: true,
          finalAttempt: attempt,
          attempts
        }),
        generationCount,
        regenerationCount,
        visionCallCount
      };
    }

    // Failed this attempt.
    if (attempt >= maxAttempts) {
      // Second failure (or first if maxRegen=0): STOP. No further generate().
      break;
    }

    // Prepare the single allowed regeneration.
    correctiveNote = buildCorrectiveNote(verdict);
    attempts[attempts.length - 1].discarded = true;
    console.warn(
      `   ⚠️  adVisionQc: attempt ${attempt} FAILED — ` +
      `regenerating once (${regenerationCount + 1}/${maxRegen}). ` +
      `summary=${verdict.summary}`
    );
  }

  // Double (or single-with-no-regen) failure — never call generate again.
  return {
    ok: false,
    skipped: false,
    output,
    visionQc: buildPersistedVerdict({
      passed: false,
      finalAttempt: attempts.length ? attempts[attempts.length - 1].attempt : null,
      attempts
    }),
    generationCount,
    regenerationCount,
    visionCallCount
  };
}

/**
 * Full per-attempt breakdown (all four category scores + findings + the
 * discarded/kept render URL for every attempt) — this IS "the verbose LLM
 * response": every category the model scored, not just the failing ones.
 * Shared by both the accept and reject alerts so an operator sees the same
 * shape either way. Slack's own size limit (buildMessage) does the final
 * clip; this only bounds a single call from producing a pathological detail
 * block (e.g. thousands of findings).
 */
function buildQcSlackDetail(visionQc) {
  return JSON.stringify({
    passed: !!visionQc?.passed,
    finalAttempt: visionQc?.finalAttempt ?? null,
    attempts: (visionQc?.attempts || []).map((a) => ({
      attempt: a.attempt,
      pass: a.pass,
      summary: a.summary,
      renderUrl: a.renderUrl,
      discarded: a.discarded,
      categories: a.categories
    }))
  }, null, 2).slice(0, 2500);
}

/**
 * Slack + log helper for terminal QC failure ("rejection"). Fire-and-forget.
 */
function alertQcFailure({ adId, brandId, productId, visionQc, brandName }) {
  try {
    const alerts = require('./alertService');
    const last = (visionQc?.attempts || [])[(visionQc?.attempts || []).length - 1];
    const findings = (last?.findings || []).slice(0, 6).join(' | ')
      || (visionQc?.attempts || []).map((a) => a.summary).filter(Boolean).join(' → ')
      || 'no findings';
    alerts.notifyAsync({
      level: 'error',
      title: 'Static ad failed vision QC after one regeneration',
      // Keyed per-ad, not a fixed literal: alertService's notify() dedupes
      // by this key within a 15-minute window (ALERT_DEDUPE_WINDOW_MIN) and
      // folds anything suppressed into a generic "+N more (suppressed)"
      // bump on the NEXT delivery — with no verbose detail carried over.
      // A shared key across every ad would mean only the first rejection
      // in any 15-minute window actually reaches Slack with its findings;
      // every other ad's failure that window is silently swallowed. Per-ad
      // still collapses a genuine double-fire of the SAME ad's alert.
      key: `vision-qc:failed-after-retry:${adId || 'unknown'}`,
      fields: {
        ad: String(adId || '-'),
        brand: brandName || String(brandId || '-'),
        product: String(productId || '-'),
        attempts: String(visionQc?.attempts?.length || 0),
        findings: findings.slice(0, 300)
      },
      detail: buildQcSlackDetail(visionQc)
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: alert failed: ${err.message}`);
  }
}

/**
 * Slack + log helper for a QC "acceptance" (the render shipped — either
 * clean on attempt 1, or clean after the single allowed regeneration).
 * Fire-and-forget, same contract as alertQcFailure.
 *
 * level:'warn', not 'info' — deliberately. alertService's default
 * ALERT_MIN_LEVEL is 'warn', so an 'info' alert here would silently never
 * be delivered under default config, which fails the "make sure a message
 * is sent" requirement this exists for. Do not soften this to 'info'.
 *
 * Caller MUST gate this on the QC having actually run (qcResult.skipped
 * false) — see directImageRenderService.js. Calling it when the flag is
 * off would alert on a verdict that was never produced.
 */
function alertQcAccepted({ adId, brandId, productId, visionQc, brandName }) {
  try {
    const alerts = require('./alertService');
    const last = (visionQc?.attempts || [])[(visionQc?.attempts || []).length - 1];
    alerts.notifyAsync({
      level: 'warn',
      title: visionQc?.finalAttempt > 1
        ? 'Static ad passed vision QC after one regeneration'
        : 'Static ad passed vision QC',
      // Per-ad key — see the comment on alertQcFailure's key above; the
      // same dedupe-collapse risk applies here and matters more, since
      // acceptance is the common case and will hit far higher volume.
      key: `vision-qc:accepted:${adId || 'unknown'}`,
      fields: {
        ad: String(adId || '-'),
        brand: brandName || String(brandId || '-'),
        product: String(productId || '-'),
        attempts: String(visionQc?.attempts?.length || 0),
        summary: String(last?.summary || 'pass').slice(0, 300)
      },
      detail: buildQcSlackDetail(visionQc)
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: accept alert failed: ${err.message}`);
  }
}

module.exports = {
  // Constants (harness pins these)
  MAX_QC_REGENERATIONS,
  CATEGORIES,
  PASS_FLOOR,
  QC_MODEL_ROLE,
  // Flag / model
  isEnabled,
  resolveQcModel,
  // Pure helpers
  buildVisionUserContent,
  parseVerdict,
  buildCorrectiveNote,
  buildPersistedVerdict,
  bufferToDataUrl,
  emptyCategories,
  // I/O
  judgeRender,
  runPostRenderQc,
  alertQcFailure,
  alertQcAccepted,
  buildQcSlackDetail
};
