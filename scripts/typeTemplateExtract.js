#!/usr/bin/env node
//
// typeTemplateExtract.js — ARM B of the type experiment.
//
// Reads a brand's OWN approved gpt-image-2 static ads with a vision model and
// extracts the TYPE TREATMENT it already uses — ink discipline, casing, weight,
// tracking, alignment, size feel, whether a scrim is used — then compiles that
// into a canonical-shaped Remotion preset so the video titling inherits the same
// typography.
//
// WHY: the static path does not prescribe type at all. It hands typography
// wholesale to the image model ("typeface and weight, the scale and colour of
// every text element" — staticAdIntents.js), which is precisely why the owner
// judges those renders as getting type right. Nothing in this repo encodes what
// the model chose. This reads it back off the finished renders instead of
// guessing at rules.
//
// ── SPEND, stated honestly ─────────────────────────────────────────────
// ONE vision LLM call per brand (2-3 images attached). Cents. Ledgered through
// atlasLlmService -> costTracker like every other LLM call.
// --generate-missing is the ONLY billable-image path and is OFF by default: it
// generates one static for a brand that has none. MEASURED charge for
// openai/gpt-image-2/edit is $0.0717 (developer variant $0.0359) — NOT the $0.01
// published base_price. It additionally requires --i-approve-spend, and it never
// retries a submit.
//
//   node scripts/typeTemplateExtract.js --brands="AllBirds,Pelagic Gear" --out=/tmp/tpl.json
//   node scripts/typeTemplateExtract.js --from-pool=/tmp/pool.json --out=/tmp/tpl.json
//   node scripts/typeTemplateExtract.js --templates=/tmp/tpl.json --emit-presets
//   node scripts/typeTemplateExtract.js --brands=AllBirds --dry-run   # no LLM call
//
// Presets are written to remotion/presets/typetpl-<slug>.json. On a Render pod
// that directory is writable but EPHEMERAL — the pod's filesystem resets on
// rotation, so extraction and the re-title sweep must happen in the same pod
// session. Nothing is ever persisted onto a Brand or Ad document: the sweep
// picks the preset up through the existing --preset argument (tier 0
// presetOverride), so normal generation is untouched.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const fs = require('fs');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');
const Brand = require('../models/Brand');
const { chatCompletion } = require('../services/atlasLlmService');
const { validateTitleSpec } = require('../services/titleSpecValidator');

const PRESET_DIR = path.join(__dirname, '..', 'remotion', 'presets');
const CANONICAL = path.join(PRESET_DIR, 'canonical.json');

const args = process.argv.slice(2);
const flag = (n, d = null) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has = (n) => args.includes(`--${n}`);

const DRY_RUN = has('dry-run');
const EMIT_PRESETS = has('emit-presets');
const MAX_CALLS = parseInt(flag('max-calls', '20'), 10);
const IMAGES_PER_BRAND = Math.min(3, Math.max(1, parseInt(flag('images', '3'), 10)));

// ── the contract we ask the model to fill ──────────────────────────────
//
// Deliberately NARROW. It describes type only: no copy, no product claims, no
// layout invention. Every enum matches what titleSpecValidator already accepts
// (CASINGS, ALIGNS, SCRIMS, SHADOWS, weight 100..900), so a template maps onto a
// preset without a translation layer inventing values the validator rejects.
const TEMPLATE_SHAPE = `{
  "ink": {
    "policy": "monochrome" | "brand-colour",
    "onDarkBackground": "#RRGGBB",
    "onLightBackground": "#RRGGBB",
    "usesBrandColourForWords": true | false
  },
  "headline": {
    "casing": "upper" | "title" | "none",
    "weight": 100-900,
    "trackingPx": 0..8,
    "align": "left" | "center" | "right",
    "maxLines": 1-4,
    "relativeSize": "small" | "medium" | "large" | "hero"
  },
  "support":  { "casing": ..., "weight": ..., "trackingPx": ..., "align": ..., "maxLines": ..., "relativeSize": ... },
  "quote":    { "casing": ..., "weight": ..., "trackingPx": ..., "align": ..., "maxLines": ..., "italic": true|false },
  "background": {
    "scrim": "frosted" | "solid" | "card" | "none",
    "shadow": "layered" | "soft" | "none",
    "typeSitsOn": "clear space" | "product" | "busy texture"
  },
  "placement": { "primaryZone": "top" | "upperThird" | "center" | "lowerThird" | "bottom" },
  "typefaceObserved": { "headlineLooksLike": "<family name or descriptive>", "isSerif": true|false, "isCondensed": true|false },
  "confidence": 0.0-1.0,
  "notes": "<= 200 chars, what makes this brand's type recognisable"
}`;

const SYSTEM = `You are a typographer auditing finished advertisements. You report ONLY what you can
see about the TYPE in the images given. You never invent copy, never describe the product, and never
recommend changes. You answer with a single JSON object and nothing else.`;

function userPrompt(brandName, count) {
  return `These ${count} images are finished ${brandName} advertisements. Describe the TYPE TREATMENT they
share, so the same treatment can be applied to video titling for this brand.

Rules:
- Report the SHARED convention across the images, not one image's quirk. If they disagree, report the
  dominant one and lower "confidence".
- "ink.policy" is "monochrome" when the words are black, white, or a near-neutral grey. It is
  "brand-colour" ONLY when the letterforms themselves are a saturated brand colour. A coloured pill,
  button, or star behind neutral words is still "monochrome".
- Read weight as a number: light 300, regular 400, medium 500, semibold 600, bold 700, black 900.
- "trackingPx" is letter-spacing at a 1080px-wide frame and CANNOT be negative. Tight display type
  is 0. Small uppercase labels are usually 1 to 4. Wide-tracked labels up to 8.
- "relativeSize" compares text blocks WITHIN the ad, not across ads.
- If a field genuinely is not observable, use null rather than guessing.

Answer with exactly this JSON shape, no prose, no markdown fence:
${TEMPLATE_SHAPE}`;
}

// ── validation of the model's answer ───────────────────────────────────

const CASINGS = ['upper', 'title', 'none'];
const ALIGNS = ['left', 'center', 'right'];
const SCRIMS = ['frosted', 'solid', 'card', 'none'];
const SHADOWS = ['layered', 'soft', 'none'];
const ANCHORS = ['top', 'upperThird', 'center', 'lowerThird', 'bottom'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

const clampInt = (v, lo, hi, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const oneOf = (v, list, def) => (list.includes(v) ? v : def);

/**
 * Coerce the model's JSON into something the preset writer can trust. Never
 * throws on a bad field — a single unparseable value must not lose the whole
 * template, and a silently-wrong enum would be rejected later by
 * titleSpecValidator anyway, which is a worse place to find out.
 */
function normalizeTemplate(raw) {
  const bad = [];
  const role = (o = {}, defWeight) => ({
    casing: oneOf(o.casing, CASINGS, 'none'),
    weight: clampInt(o.weight, 100, 900, defWeight),
    // 0..8, NOT negative. titleSpecValidator rejects a negative trackingPx and a
    // rejected spec falls back to the canonical floor with only a warning — which
    // would silently make this arm identical to the baseline and read as "the
    // template made no difference". Clamped here, and the compiled preset is
    // validated below before it can be used.
    trackingPx: Math.min(8, Math.max(0, Number.isFinite(Number(o.trackingPx)) ? Number(o.trackingPx) : 0)),
    align: oneOf(o.align, ALIGNS, 'center'),
    maxLines: clampInt(o.maxLines, 1, 4, 2),
    relativeSize: oneOf(o.relativeSize, ['small', 'medium', 'large', 'hero'], 'medium'),
    italic: !!o.italic,
  });
  const ink = raw?.ink || {};
  for (const k of ['onDarkBackground', 'onLightBackground']) {
    if (ink[k] && !HEX.test(ink[k])) bad.push(`ink.${k}=${ink[k]}`);
  }
  const out = {
    ink: {
      policy: oneOf(ink.policy, ['monochrome', 'brand-colour'], 'monochrome'),
      onDarkBackground: HEX.test(ink.onDarkBackground || '') ? ink.onDarkBackground.toUpperCase() : null,
      onLightBackground: HEX.test(ink.onLightBackground || '') ? ink.onLightBackground.toUpperCase() : null,
      usesBrandColourForWords: !!ink.usesBrandColourForWords,
    },
    headline: role(raw?.headline, 700),
    support: role(raw?.support, 500),
    quote: role(raw?.quote, 400),
    background: {
      scrim: oneOf(raw?.background?.scrim, SCRIMS, 'none'),
      shadow: oneOf(raw?.background?.shadow, SHADOWS, 'soft'),
      typeSitsOn: String(raw?.background?.typeSitsOn || '').slice(0, 40) || null,
    },
    placement: { primaryZone: oneOf(raw?.placement?.primaryZone, ANCHORS, null) },
    typefaceObserved: {
      headlineLooksLike: String(raw?.typefaceObserved?.headlineLooksLike || '').slice(0, 60) || null,
      isSerif: !!raw?.typefaceObserved?.isSerif,
      isCondensed: !!raw?.typefaceObserved?.isCondensed,
    },
    confidence: Math.min(1, Math.max(0, Number(raw?.confidence) || 0)),
    notes: String(raw?.notes || '').slice(0, 200),
    _coerced: bad,
  };
  return out;
}

// ── source images ──────────────────────────────────────────────────────

/**
 * The brand's own finished statics, approved ones first. Every `ai_*` static goes
 * through renderDirectImage -> gpt-image-2 (CLAUDE.md §00), so an ai_ template
 * with a renderUrl IS a gpt-image-2 render. Approval is preferred but not
 * required — most rows predate the approve flow.
 */
async function staticsForBrand(brandId, want) {
  const base = {
    brandId, renderRoute: 'html_gen', renderUrl: { $ne: null },
    status: { $nin: ['failed', 'archived'] },
    template: /^ai_/,
  };
  const approved = await Ad.find({ ...base, approved: true })
    .select('renderUrl aspectRatio template approved createdAt').sort({ createdAt: -1 }).limit(want).lean();
  if (approved.length >= want) return { rows: approved, approvedOnly: true };
  const rest = await Ad.find({ ...base, approved: { $ne: true } })
    .select('renderUrl aspectRatio template approved createdAt').sort({ createdAt: -1 })
    .limit(want - approved.length).lean();
  return { rows: [...approved, ...rest], approvedOnly: approved.length === want };
}

// ── preset compilation ─────────────────────────────────────────────────

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const SIZE_SCALE = { small: 0.85, medium: 1, large: 1.15, hero: 1.3 };

/**
 * Clone canonical.json and overwrite ONLY type decisions. Structure, timing,
 * phases, bindings and visibility all stay canonical — this experiment tests
 * typography, so anything else changing would confound the comparison.
 */
function compilePreset(brandName, tpl) {
  const canonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  const preset = JSON.parse(JSON.stringify(canonical));
  preset.name = `typetpl-${slugify(brandName)}`;
  preset.description = `Type template extracted from ${brandName}'s own approved statics ` +
    `(arm B, ${new Date().toISOString().slice(0, 10)}). Structure is canonical; only type differs.`;

  // Which extracted role governs which slot. headline-ish slots take the
  // headline role; the small supporting lines take support; the testimonial
  // takes quote. Slots we do not have an observation for are left canonical.
  const ROLE_FOR_SLOT = {
    headline: 'headline', productName: 'headline',
    badge: 'support', deliveryLine: 'support', reviewer: 'support', rating: 'support', brandPill: 'support',
    quote: 'quote',
  };

  for (const fmt of Object.keys(preset.byFormat || {})) {
    const spec = preset.byFormat[fmt];
    for (const slot of spec.slots || []) {
      const roleName = ROLE_FOR_SLOT[slot.key];
      if (!roleName) continue;
      const r = tpl[roleName];
      slot.treatment = slot.treatment || {};
      slot.treatment.casing = r.casing;
      slot.treatment.weight = r.weight;
      slot.treatment.trackingPx = Math.round(r.trackingPx * 10) / 10;
      slot.treatment.maxLines = r.maxLines;
      // Scrim/shadow are a legibility policy, not per-slot taste: apply the
      // brand's observed convention uniformly so the arm is a clean read.
      slot.treatment.scrim = tpl.background.scrim;
      slot.treatment.shadow = tpl.background.shadow;
      slot.position = slot.position || {};
      slot.position.align = r.align;
      if (r.relativeSize && SIZE_SCALE[r.relativeSize] && slot.treatment.sizeScale == null) {
        slot.treatment.sizeScale = SIZE_SCALE[r.relativeSize];
      }
    }
  }

  // Ink. The owner's rule and the extracted observation agree in the monochrome
  // case; when the model reports the brand genuinely sets its words in colour we
  // do NOT honour it — the owner ruled coloured type out explicitly, and this arm
  // is meant to test typography, not relitigate that. Recorded either way.
  const overrides = { colors: {} };
  if (tpl.ink.onLightBackground && tpl.ink.policy === 'monochrome') {
    overrides.colors.textOnLight = tpl.ink.onLightBackground;
  }
  if (tpl.ink.onDarkBackground && tpl.ink.policy === 'monochrome') {
    overrides.colors.textPrimary = tpl.ink.onDarkBackground;
  }
  if (Object.keys(overrides.colors).length) {
    for (const fmt of Object.keys(preset.byFormat)) {
      preset.byFormat[fmt].tokenOverrides = overrides;
    }
  }
  preset._armB = {
    extractedFrom: tpl._sourceUrls || [], confidence: tpl.confidence, notes: tpl.notes,
    inkPolicyReported: tpl.ink.policy, typefaceObserved: tpl.typefaceObserved,
    coercedFields: tpl._coerced, honouredColouredType: false,
  };

  // VALIDATE BEFORE THE FILE IS TRUSTED. A spec the validator rejects does not
  // fail loudly at render time — resolveSpec falls back to the canonical floor
  // with a warning, so arm B would render identically to the baseline and the
  // comparison would silently be measuring nothing. Fail here instead.
  for (const [fmt, spec] of Object.entries(preset.byFormat)) {
    const res = validateTitleSpec(spec, { format: fmt });
    if (!res.ok) {
      throw new Error(`compiled preset invalid for ${fmt}: ${res.errors.slice(0, 5).join('; ')}`);
    }
  }
  return preset;
}

// ── main ───────────────────────────────────────────────────────────────

(async () => {
  const templatesPath = flag('templates', null);

  // Compile-only mode: no DB, no LLM.
  if (EMIT_PRESETS && templatesPath) {
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    let n = 0;
    for (const [brandName, tpl] of Object.entries(data.templates || {})) {
      const preset = compilePreset(brandName, tpl);
      const file = path.join(PRESET_DIR, `${preset.name}.json`);
      fs.writeFileSync(file, JSON.stringify(preset, null, 2));
      console.log(`📝 ${file}  (confidence ${tpl.confidence}, ink ${tpl.ink.policy})`);
      n++;
    }
    console.log(`✅ wrote ${n} preset(s)`);
    process.exit(0);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  let brandNames = (flag('brands', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fromPool = flag('from-pool', null);
  if (fromPool) {
    const pool = JSON.parse(fs.readFileSync(fromPool, 'utf8'));
    brandNames = [...new Set(pool.ads.map((a) => a.brand))];
  }
  if (!brandNames.length) { console.error('need --brands= or --from-pool='); process.exit(2); }

  const templates = {};
  const skipped = {};
  let calls = 0;

  for (const name of brandNames) {
    const brand = await Brand.findOne({ name }).select('_id name').lean();
    if (!brand) { skipped[name] = 'brand not found'; continue; }
    const { rows, approvedOnly } = await staticsForBrand(brand._id, IMAGES_PER_BRAND);
    if (!rows.length) { skipped[name] = 'no gpt-image-2 statics to read'; continue; }

    console.log(`🔤 ${name}: ${rows.length} static(s)${approvedOnly ? ' (approved)' : ''} — ` +
      rows.map((r) => r.aspectRatio).join(','));
    if (DRY_RUN) { templates[name] = { _dryRun: true, _sourceUrls: rows.map((r) => r.renderUrl) }; continue; }

    if (calls >= MAX_CALLS) { skipped[name] = `--max-calls=${MAX_CALLS} reached`; continue; }
    calls++;

    const content = [
      { type: 'text', text: userPrompt(name, rows.length) },
      ...rows.map((r) => ({ type: 'image_url', image_url: { url: r.renderUrl } })),
    ];
    let parsed = null, rawText = '';
    try {
      const res = await chatCompletion(
        { service: 'typeTemplateExtract', purpose: 'type-template', visionImages: rows.length },
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
          temperature: 0.0,
          max_tokens: 1800,
          // json_object, not json_schema: strict schema 400s on some Atlas
          // routes (see adVisionQcService). Shape is validated here instead.
          response_format: { type: 'json_object' },
        }
      );
      rawText = res?.choices?.[0]?.message?.content || '';
      const cleaned = String(rawText).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      parsed = JSON.parse(cleaned);
    } catch (err) {
      // NO AUTO-RETRY on a billable call. Report and move on.
      skipped[name] = `vision call failed: ${String(err.message || err).slice(0, 120)}`;
      console.warn(`⚠️  ${name}: ${skipped[name]}`);
      continue;
    }

    const tpl = normalizeTemplate(parsed);
    tpl._sourceUrls = rows.map((r) => r.renderUrl);
    tpl._approvedSources = approvedOnly;
    templates[name] = tpl;
    console.log(`   → ink=${tpl.ink.policy} headline=${tpl.headline.casing}/${tpl.headline.weight}` +
      `/track${tpl.headline.trackingPx}/${tpl.headline.align} scrim=${tpl.background.scrim}` +
      ` face≈${tpl.typefaceObserved.headlineLooksLike} conf=${tpl.confidence}` +
      (tpl._coerced.length ? ` ⚠️ coerced: ${tpl._coerced.join(',')}` : ''));
  }

  const out = { generatedAt: new Date().toISOString(), llmCalls: calls, templates, skipped };
  const outPath = flag('out', null);
  if (outPath) { fs.writeFileSync(outPath, JSON.stringify(out, null, 2)); console.log(`📝 wrote ${outPath}`); }
  else console.log(JSON.stringify(out, null, 2));
  console.log(`💰 billable vision calls: ${calls}`);
  if (Object.keys(skipped).length) console.log('⏭️  skipped:', JSON.stringify(skipped, null, 2));

  if (EMIT_PRESETS) {
    for (const [brandName, tpl] of Object.entries(templates)) {
      if (tpl._dryRun) continue;
      const preset = compilePreset(brandName, tpl);
      fs.writeFileSync(path.join(PRESET_DIR, `${preset.name}.json`), JSON.stringify(preset, null, 2));
      console.log(`📝 remotion/presets/${preset.name}.json`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('💥', err); process.exit(1); });
