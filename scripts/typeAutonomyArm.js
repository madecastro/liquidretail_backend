#!/usr/bin/env node
//
// typeAutonomyArm.js — ARM C: give the model autonomy PER AD, not per brand.
//
// Owner, 2026-08-04: "The titling engine is free to vary from the template, so if
// the copy should be left aligned or centered, it can do that. If we want to set
// another test that gives the LLM more autonomy, do that also."
//
// Arm B extracts ONE type convention per brand and applies it to every ad. This
// arm shows the model THE ACTUAL FRAME it is typesetting over, plus the real copy
// and the brand's real type inputs, and lets it decide for that ad alone:
// placement zone, alignment, casing, weight, tracking, size and ink polarity.
// Where arm B tests "does a brand convention travel", this tests "does per-image
// judgement beat a fixed rule".
//
// It is deliberately NOT unconstrained. The model may not choose a scrim, may not
// set coloured type, and may not put type over a face — those are settled owner
// decisions, and re-litigating them is not what this arm is measuring.
//
//   node scripts/typeAutonomyArm.js --pool=/tmp/typeexp/pool.json --out=/tmp/typeexp/autonomy.json
//   node scripts/typeAutonomyArm.js --pool=... --emit-presets
//   node scripts/typeAutonomyArm.js --pool=... --dry-run     # frames only, no LLM
//
// SPEND: one vision call per AD (30 for a 30-ad pool), cents each, ledgered.
// No image generation. No auto-retry on a failed call.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const fs = require('fs');
const axios = require('axios');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');
const { chatCompletion } = require('../services/atlasLlmService');
const { validateTitleSpec } = require('../services/titleSpecValidator');

const PRESET_DIR = path.join(__dirname, '..', 'remotion', 'presets');
const CANONICAL = path.join(PRESET_DIR, 'canonical.json');

const args = process.argv.slice(2);
const flag = (n, d = null) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has = (n) => args.includes(`--${n}`);

const POOL = flag('pool', null);
// Preset FILES cannot survive an SSH session change (the pod filesystem is
// per-session), but the per-ad plans are billable and must not be re-paid. With
// --plans= the plans are read from disk and only the presets are recompiled.
const PLANS_IN = flag('plans', null);
const OUT = flag('out', null);
const DRY_RUN = has('dry-run');
const EMIT = has('emit-presets');
const MAX_CALLS = parseInt(flag('max-calls', '40'), 10);
const FRAME_AT = flag('frame-at', '4.6'); // after the proof beat settles

// Which preset format block a delivered aspect ratio maps to.
const FORMAT_FOR_ASPECT = {
  '9:16': 'vertical', '4:5': 'feed', '1:1': 'square', '16:9': 'landscape',
};

/**
 * A still from the already-rendered master, via a Cloudinary derivation. Free
 * (bandwidth only) and needs no ffmpeg. Returns null for a non-Cloudinary URL
 * rather than guessing at a transform syntax that would 404 and waste a call.
 */
function frameUrlFor(videoUrl, { at = FRAME_AT, width = 640 } = {}) {
  if (!videoUrl || !/res\.cloudinary\.com/.test(videoUrl)) return null;
  const marker = '/video/upload/';
  const i = videoUrl.indexOf(marker);
  if (i === -1) return null;
  const head = videoUrl.slice(0, i + marker.length);
  const tail = videoUrl.slice(i + marker.length).replace(/\.(mp4|mov|webm)(\?.*)?$/i, '');
  return `${head}so_${at},w_${width},c_scale/${tail}.jpg`;
}

const SHAPE = `{
  "placement": { "zone": "top" | "upperThird" | "center" | "lowerThird" | "bottom",
                 "why": "<= 90 chars, what in THIS frame makes that zone right" },
  "headline": { "casing": "upper"|"title"|"none", "weight": 100-900, "trackingPx": 0..8,
                "align": "left"|"center"|"right", "maxLines": 1-4, "sizeScale": 0.6..1.6 },
  "support":  { "casing": ..., "weight": ..., "trackingPx": ..., "align": ..., "maxLines": ..., "sizeScale": ... },
  "quote":    { "casing": ..., "weight": ..., "trackingPx": ..., "align": ..., "maxLines": ..., "sizeScale": ... },
  "inkOnThisFrame": "light" | "dark",
  "confidence": 0.0-1.0,
  "notes": "<= 160 chars"
}`;

const SYSTEM = `You are an art director typesetting one advertisement. You are shown the actual frame the
type will sit on. You decide the type treatment for THIS frame only. You answer with a single JSON
object and nothing else.`;

function promptFor(ad, brandType) {
  const f = brandType?.fonts || {};
  return `Typeset this ad. The image is a real frame from the finished video, at the moment the type appears.

COPY THAT WILL BE SET (do not rewrite it, only decide how it is set):
  headline: ${JSON.stringify(ad.headline || '(none)')}
  format:   ${ad.aspectRatio} (${FORMAT_FOR_ASPECT[ad.aspectRatio] || '?'})
  brand:    ${ad.brand}

TYPE AVAILABLE (already resolved, you cannot change the family):
  heading: ${f.heading?.family || '?'}   body: ${f.body?.family || '?'}   quote: ${f.quote?.family || '?'}

DECIDE, for this frame:
- "placement.zone": where the type block sits. Look at the actual image. Put type on the CALMEST
  region with room for it.
- alignment, casing, weight, tracking, maxLines and sizeScale per role. Left-aligned is often
  stronger over a busy or asymmetric image; centred suits symmetrical compositions. Use your
  judgement per image rather than one habit.
- "inkOnThisFrame": "light" if white type reads better on this frame, "dark" if near-black does.

HARD CONSTRAINTS — these are settled decisions, not preferences:
- NEVER place type over a person's face. If a face occupies your first choice of zone, choose
  another zone.
- Type is BLACK OR WHITE only. You choose which, via inkOnThisFrame. You never choose a colour.
- No scrim, no panel, no pill behind the type. Legibility comes from placement, weight and shadow.
- Do not set a testimonial quote in all caps, and keep quote weight at or below 700.

Answer with exactly this JSON shape, no prose, no markdown fence:
${SHAPE}`;
}

const CASINGS = ['upper', 'title', 'none'];
const ALIGNS = ['left', 'center', 'right'];
const ANCHORS = ['top', 'upperThird', 'center', 'lowerThird', 'bottom'];
const oneOf = (v, l, d) => (l.includes(v) ? v : d);
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function normalizePlan(raw) {
  const role = (o = {}, dw) => ({
    casing: oneOf(o.casing, CASINGS, 'none'),
    weight: Math.round(clamp(o.weight, 100, 900, dw)),
    trackingPx: Math.round(clamp(o.trackingPx, 0, 8, 0) * 10) / 10,
    align: oneOf(o.align, ALIGNS, 'center'),
    maxLines: Math.round(clamp(o.maxLines, 1, 4, 2)),
    sizeScale: Math.round(clamp(o.sizeScale, 0.6, 1.6, 1) * 100) / 100,
  });
  const out = {
    placement: {
      zone: oneOf(raw?.placement?.zone, ANCHORS, null),
      why: String(raw?.placement?.why || '').slice(0, 90),
    },
    headline: role(raw?.headline, 700),
    support: role(raw?.support, 500),
    quote: role(raw?.quote, 400),
    inkOnThisFrame: oneOf(raw?.inkOnThisFrame, ['light', 'dark'], null),
    confidence: clamp(raw?.confidence, 0, 1, 0),
    notes: String(raw?.notes || '').slice(0, 160),
  };
  // Same red lines as arm B. The prompt states them; a model that ignores them
  // does not get to ship, because clamping would silently accept the violation.
  const reject = [];
  if (out.quote.casing === 'upper') reject.push('quote in all caps');
  if (out.quote.weight > 700) reject.push(`quote weight ${out.quote.weight}`);
  if (!out.placement.zone) reject.push('no placement zone');
  if (!out.inkOnThisFrame) reject.push('no ink polarity');
  if (out.confidence < 0.35) reject.push(`confidence ${out.confidence}`);
  out._reject = reject;
  return out;
}

/**
 * A single-format preset carrying this ad's plan. Only the format the ad actually
 * delivers is touched, so a mistake cannot leak into another surface.
 */
function compileAdPreset(ad, plan) {
  const canonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  const fmt = FORMAT_FOR_ASPECT[ad.aspectRatio];
  if (!fmt) throw new Error(`no preset format for aspect ${ad.aspectRatio}`);
  const preset = JSON.parse(JSON.stringify(canonical));
  preset.name = `typeauto-${ad.adId}`;
  preset.description = `Arm C: per-ad type plan for ${ad.brand} ${ad.aspectRatio} — ${plan.notes || 'no notes'}`;

  const ROLE_FOR_SLOT = {
    headline: 'headline', productName: 'headline',
    badge: 'support', deliveryLine: 'support', reviewer: 'support', rating: 'support', brandPill: 'support',
    quote: 'quote',
  };
  const spec = preset.byFormat[fmt];
  for (const slot of spec.slots || []) {
    const roleName = ROLE_FOR_SLOT[slot.key];
    if (!roleName) continue;
    const r = plan[roleName];
    slot.treatment = slot.treatment || {};
    slot.treatment.casing = r.casing;
    slot.treatment.weight = r.weight;
    slot.treatment.trackingPx = r.trackingPx;
    slot.treatment.maxLines = r.maxLines;
    // Multiply, never replace: canonical's relative sizing between slots is
    // deliberate and a flat overwrite would flatten the hierarchy.
    const authored = Number.isFinite(Number(slot.treatment.sizeScale)) ? Number(slot.treatment.sizeScale) : 1;
    slot.treatment.sizeScale = Math.round(Math.min(2, Math.max(0.5, authored * r.sizeScale)) * 100) / 100;
    slot.treatment.scrim = 'none';
    slot.position = slot.position || {};
    slot.position.align = r.align;
    // THE AUTONOMY: the model's zone becomes the authored anchor. The engine's
    // face keep-out still runs on top and can move it — that is deliberate. A
    // model choice that would land on a face gets corrected rather than shipped,
    // so this arm cannot regress the defect the owner already reported twice.
    if (plan.placement.zone && roleName !== 'support') {
      slot.position.anchor = plan.placement.zone;
    }
  }

  const res = validateTitleSpec(spec, { format: fmt });
  if (!res.ok) throw new Error(`arm C preset invalid for ${fmt}: ${res.errors.slice(0, 4).join('; ')}`);
  preset._armC = { plan, format: fmt, adId: ad.adId, brand: ad.brand };
  return preset;
}

(async () => {
  if (!POOL) { console.error('need --pool=<pool.json>'); process.exit(2); }
  const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));

  // Recompile-only mode: no DB, no LLM, no spend.
  if (PLANS_IN) {
    const stored = JSON.parse(fs.readFileSync(PLANS_IN, 'utf8'));
    let n = 0;
    for (const ad of pool.ads) {
      const plan = stored.plans?.[ad.adId];
      if (!plan || plan._dryRun || plan._reject?.length) continue;
      try {
        const preset = compileAdPreset(ad, plan);
        fs.writeFileSync(path.join(PRESET_DIR, `${preset.name}.json`), JSON.stringify(preset, null, 2));
        n++;
      } catch (err) { console.warn(`⚠️  ${ad.adId}: ${err.message}`); }
    }
    console.log(`📝 recompiled ${n} per-ad preset(s) from ${PLANS_IN} — $0`);
    process.exit(0);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const plans = {};
  const skipped = {};
  let calls = 0;

  for (const ad of pool.ads) {
    const row = await Ad.findById(ad.adId).select('veoVideoUrl').lean();
    const frame = frameUrlFor(row?.veoVideoUrl);
    if (!frame) { skipped[ad.adId] = 'no derivable frame from the master URL'; continue; }

    if (DRY_RUN) { plans[ad.adId] = { _dryRun: true, _frame: frame }; console.log(`🖼  ${ad.brand} ${ad.aspectRatio} → ${frame.slice(-50)}`); continue; }
    if (calls >= MAX_CALLS) { skipped[ad.adId] = `--max-calls=${MAX_CALLS} reached`; continue; }

    // Verify the derived frame actually serves an image before paying for it —
    // a bad transform 404s and the model would be sent nothing.
    try {
      const head = await axios.head(frame, { timeout: 15000, validateStatus: () => true });
      if (head.status >= 400 || !/^image\//.test(String(head.headers['content-type'] || ''))) {
        skipped[ad.adId] = `frame not servable (status ${head.status})`; continue;
      }
    } catch (err) { skipped[ad.adId] = `frame HEAD failed: ${String(err.message).slice(0, 50)}`; continue; }

    calls++;
    let parsed = null;
    try {
      const res = await chatCompletion(
        { service: 'typeAutonomyArm', purpose: 'per-ad-type-plan', visionImages: 1 },
        {
          model: 'gemini-2.5-pro',
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: [
              { type: 'text', text: promptFor(ad, pool.brands?.[ad.brand]) },
              { type: 'image_url', image_url: { url: frame } },
            ] },
          ],
          temperature: 0.2,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
        }
      );
      const raw = res?.choices?.[0]?.message?.content || '';
      parsed = JSON.parse(String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    } catch (err) {
      skipped[ad.adId] = `vision call failed: ${String(err.message || err).slice(0, 90)}`;
      console.warn(`⚠️  ${ad.brand}: ${skipped[ad.adId]}`);
      continue;
    }

    const plan = normalizePlan(parsed);
    plan._frame = frame;
    if (plan._reject.length) {
      skipped[ad.adId] = `plan rejected: ${plan._reject.join('; ')}`;
      console.warn(`   ✖ ${ad.brand} ${ad.aspectRatio}: ${skipped[ad.adId]}`);
      continue;
    }
    plans[ad.adId] = plan;
    console.log(`✅ ${ad.brand} ${ad.aspectRatio}: ${plan.placement.zone} / ${plan.headline.align} / ` +
      `${plan.headline.casing} ${plan.headline.weight} x${plan.headline.sizeScale} / ink ${plan.inkOnThisFrame}` +
      `  — ${plan.placement.why}`);
  }

  const out = { generatedAt: new Date().toISOString(), llmCalls: calls, plans, skipped };
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`📝 wrote ${OUT}`); }
  console.log(`💰 billable vision calls: ${calls}`);

  if (EMIT) {
    let n = 0;
    for (const ad of pool.ads) {
      const plan = plans[ad.adId];
      if (!plan || plan._dryRun) continue;
      try {
        const preset = compileAdPreset(ad, plan);
        fs.writeFileSync(path.join(PRESET_DIR, `${preset.name}.json`), JSON.stringify(preset, null, 2));
        n++;
      } catch (err) { console.warn(`⚠️  ${ad.adId}: ${err.message}`); }
    }
    console.log(`📝 wrote ${n} per-ad preset(s)`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('💥', err); process.exit(1); });
