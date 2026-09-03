'use strict';
// Video-title Director — one LLM call per (content profile × master size),
// not per delivered ad. Static already has aiCreativeDirectorService; this
// is the video-titling twin, scoped so a 21-ad mixed kit costs 6 calls
// (awareness/consideration/conversion × 9:16/16:9), not 21.
//
// SIZE is the Omni master's native aspect, not the delivered surface:
// Meta 1:1 / 4:5 / Reels and PMax 9:16 / 1:1 are crops/retitles of the
// 9:16 plate and INHERIT that plate's decision. 16:9 is the only other
// billed master. CONTENT PROFILE is funnel stage (unstaged = awareness).
//
// MONEY: chatCompletion role `director` (same MAP as static). Fail closed
// on transport/parse failure — expansion still mints, titling skips
// benefits. Empty CatalogProduct.shortBenefits short-circuits with ZERO
// LLM calls. In-process memo coalesces the 21 expandDeterministicVideo
// iterations of one generate.

const { validateTitleSpec, DEFAULT_BIND } = require('./titleSpecValidator');
const { resolveSpec, loadPresetFile } = require('./titleSpecService');
const { resolveSafeZoneKeyCjs } = require('./plateIntelService');
const { normalizeBenefitList } = require('./titleSpecContentSample');
const { aspectRatioForPlatformFormat } = require('./platformFormats');

function isBenefitsPlacementEnabled() {
  return process.env.VIDEO_BENEFITS_PLACEMENT === 'true';
}

function nonempty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.some((x) => nonempty(x));
  return true;
}

function videoTitleProfile(funnelStage) {
  const s = String(funnelStage || '').toLowerCase().trim();
  if (s === 'consideration' || s === 'conversion') return s;
  return 'awareness';
}

/**
 * Master-size bucket. 16:9 is the landscape Omni master; every other
 * live video surface in the kit is a crop or retitle of the 9:16 plate
 * (Meta 1:1/4:5/Reels, PMax 9:16, PMax 1:1).
 */
function videoTitleSize(platformFormat) {
  return aspectRatioForPlatformFormat(platformFormat) === '16:9' ? '16:9' : '9:16';
}

function videoTitleDirectionKey({ platformFormat, funnelStage } = {}) {
  return {
    size: videoTitleSize(platformFormat),
    profile: videoTitleProfile(funnelStage),
  };
}

function uniqueVideoTitleDirectionKeys(plan) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(plan) ? plan : []) {
    const k = videoTitleDirectionKey(item);
    const id = `${k.size}|${k.profile}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(k);
  }
  return out;
}

function directionMemoKey({ productId, size, profile }) {
  return `${productId || 'none'}|${size}|${profile}`;
}

const memo = new Map();
function resetVideoTitleDirectionMemo() {
  memo.clear();
}

function visibleBenefitsSlot(spec) {
  if (!spec || !Array.isArray(spec.slots)) return null;
  return spec.slots.find((s) => s && s.key === 'benefits' && s.visible !== false) || null;
}

function pickTargetPhase(spec, profile) {
  const keys = Array.isArray(spec?.phases) ? spec.phases.map((p) => p.key).filter(Boolean) : [];
  if (profile === 'consideration' && keys.includes('proof')) return 'proof';
  if (profile === 'conversion' && keys.includes('close')) return 'close';
  if (keys.includes('proof')) return 'proof';
  if (keys.includes('close')) return 'close';
  const nonHook = keys.filter((k) => k !== 'hook');
  return nonHook[nonHook.length - 1] || keys[keys.length - 1] || 'p0';
}

function occupancyBrief({ size, profile }) {
  const format = size === '16:9' ? 'landscape' : 'vertical';
  const intentPreset = profile === 'awareness'
    ? null
    : (size === '16:9' ? `canonical-${profile}-pmax10` : `canonical-${profile}`);
  let spec;
  try {
    spec = resolveSpec({
      brand: {},
      format,
      intentPreset,
    }).spec;
  } catch (_) {
    spec = loadPresetFile('canonical')?.byFormat?.[format] || null;
  }
  const phase = pickTargetPhase(spec, profile);
  const slots = (spec?.slots || [])
    .filter((s) => s && s.phase === phase && s.visible !== false)
    .map((s) => s.key);
  const surface = resolveSafeZoneKeyCjs({ format, platformFormat: size === '16:9' ? 'pmax_video_16_9' : 'meta_stories_9_16' });
  return {
    format,
    intentPreset: intentPreset || 'canonical',
    phase,
    slots,
    surface,
    keepOut: surface,
  };
}

function buildDirectorMessages({ size, profile, occupancy, benefits, productSignal, brandSignal }) {
  const system = [
    'You are the video-titling Director. You decide whether a benefits slot belongs on THIS video content profile × size, given the product, the intent, and how much of the title stack is already committed.',
    'OUTPUT CONTRACT: reply with ONE JSON object, no prose, no markdown fences.',
    'Shape: {"include_benefits":boolean,"max_items":1|2|3|4,"phase":"proof"|"close","reason":"short why"}.',
    'Rules:',
    '- Benefits belong in proof or close, NEVER hook.',
    '- include_benefits=false when there is no real benefit content, when the stack is already full, or when conversion CTA would be crowded.',
    '- consideration (why-buy) is the profile most likely to want benefits in proof.',
    '- conversion is CTA-first; only include benefits if close still has room.',
    '- awareness may include benefits in proof/close, never as the opening hook.',
    '- 9:16 is a tight portrait box (Reels/Stories/Shorts family). 16:9 is looser landscape.',
    '- max_items is 3 on 9:16, 4 on 16:9, and never more than the available list.',
    '- Do not invent benefits. If the list is empty, include_benefits must be false.',
    '- Thin data is not a stop: decide with what you have.',
  ].join('\n');

  const user = [
    `SIZE: ${size} (all delivered surfaces cropped/retitled from this Omni master inherit this decision)`,
    `CONTENT PROFILE: ${profile}`,
    `BRAND: ${brandSignal?.name || 'unknown'}`,
    `PRODUCT: ${productSignal?.name || 'unknown'}`,
    `BENEFITS AVAILABLE: ${JSON.stringify(benefits)}`,
    `BASE LAYOUT: ${occupancy.intentPreset} format=${occupancy.format} target_phase=${occupancy.phase}`,
    `SLOTS ALREADY IN TARGET PHASE: ${occupancy.slots.join(', ') || '(none)'}`,
    `SURFACE KEEP-OUT KEY: ${occupancy.surface}`,
    'Decide include_benefits / max_items / phase now.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function parseDirectorDecision(raw, { size, profile, occupancy, benefits }) {
  const { safeParseDirectorJSON } = require('./aiCreativeDirectorService');
  const parsed = safeParseDirectorJSON(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { include: false, reason: 'unparseable', size, profile, source: 'director-failed' };
  }
  const include = parsed.include_benefits === true;
  if (!include) {
    return {
      include: false,
      reason: String(parsed.reason || 'director-declined').slice(0, 200),
      size, profile, source: 'director',
    };
  }
  if (!benefits.length) {
    return { include: false, reason: 'no-content', size, profile, source: 'director' };
  }
  const phaseRaw = String(parsed.phase || occupancy.phase || 'proof').toLowerCase();
  const phase = (phaseRaw === 'close' || phaseRaw === 'proof') ? phaseRaw : occupancy.phase;
  if (phase === 'hook') {
    return { include: false, reason: 'hook-forbidden', size, profile, source: 'director' };
  }
  const cap = size === '9:16' ? 3 : 4;
  let maxItems = Number(parsed.max_items);
  if (!Number.isInteger(maxItems) || maxItems < 1) maxItems = Math.min(benefits.length, cap);
  maxItems = Math.min(maxItems, cap, benefits.length);
  return {
    include: true,
    maxItems,
    phase,
    reason: String(parsed.reason || 'fit').slice(0, 200),
    size, profile, source: 'director',
  };
}

async function runVideoTitleDirector({
  brandId, productId, campaignKind, size, profile,
} = {}, deps = {}) {
  const assembleSignals = deps.assembleSignals
    || require('./aiCreativeDirectorService').assembleSignals;
  const chatCompletion = deps.chatCompletion
    || require('./atlasLlmService').chatCompletion;

  const signals = await assembleSignals({
    brandId, productId, campaignKind: campaignKind || 'product',
  });
  const benefits = normalizeBenefitList(signals?.product_signal?.benefits);
  if (!benefits.length) {
    return { include: false, reason: 'no-content', size, profile, source: 'short-circuit' };
  }

  const occupancy = occupancyBrief({ size, profile });
  const messages = buildDirectorMessages({
    size, profile, occupancy, benefits,
    productSignal: signals.product_signal,
    brandSignal: signals.brand_signal,
  });

  const completion = await chatCompletion(
    {
      stage: 'video_title_director',
      provider: 'atlas',
      model: 'director',
      purposeTag: `video-title:${profile}:${size}`,
      brandId, productId,
      visionImages: 0,
      cacheKey: `videoTitleDirector:${brandId}:${productId}:${size}:${profile}`,
    },
    {
      model: 'director',
      response_format: { type: 'json_object' },
      messages,
      temperature: 0.3,
      max_tokens: 800,
    }
  );
  const raw = completion?.choices?.[0]?.message?.content;
  if (!raw) {
    return { include: false, reason: 'empty-content', size, profile, source: 'director-failed' };
  }
  return parseDirectorDecision(raw, { size, profile, occupancy, benefits });
}

/**
 * Memoized entry. Safe to call once per minted ad — unique (product, size,
 * profile) keys hit the LLM once per generate.
 */
async function getVideoTitleDirection(args = {}, deps = {}) {
  if (!isBenefitsPlacementEnabled()) {
    return { include: false, reason: 'flag-off', source: 'flag' };
  }
  const size = args.size || videoTitleSize(args.platformFormat);
  const profile = args.profile || videoTitleProfile(args.funnelStage);
  const key = directionMemoKey({ productId: args.productId, size, profile });
  if (memo.has(key)) return memo.get(key);
  const pending = Promise.resolve()
    .then(() => runVideoTitleDirector({ ...args, size, profile }, deps))
    .catch((err) => ({
      include: false,
      reason: `director-failed:${err && err.message ? err.message : 'unknown'}`,
      size, profile, source: 'director-failed',
    }));
  memo.set(key, pending);
  return pending;
}

function buildBenefitsSlot({ phase, maxItems, spec }) {
  const phaseDef = (spec?.phases || []).find((p) => p.key === phase) || spec?.phases?.[0];
  const start = Number.isFinite(phaseDef?.startSec) ? phaseDef.startSec : 0;
  const end = Number.isFinite(phaseDef?.endSec) ? phaseDef.endSec : null;
  return {
    key: 'benefits',
    visible: true,
    bind: DEFAULT_BIND.benefits || ['benefits'],
    brandMode: 'hide',
    phase,
    position: {
      anchor: 'lowerThird',
      align: 'left',
      offsetX: 0,
      offsetY: 0,
      maxWidthPct: 0.85,
      row: null,
    },
    timing: {
      enterAtSec: start + 0.25,
      exitAtSec: end,
      enterDurationSec: 0.4,
      exitDurationSec: 0.4,
    },
    transition: { type: 'fade', direction: 'up' },
    treatment: {
      scrim: 'none',
      shadow: 'layered',
      fontRole: 'body',
      weight: 600,
      sizeScale: 0.92,
      maxLines: 2,
      itemLayout: 'stack',
      itemStyle: 'bullet',
      itemDelaySec: 0.12,
      maxItems: maxItems || 3,
    },
  };
}

/**
 * Apply a Director (or fail-closed) decision to a resolved spec.
 * Honour an already-visible benefits slot. Never throws.
 */
function applyBenefitsPlacement({
  spec,
  meta,
  format = 'vertical',
  direction = null,
} = {}) {
  if (!spec) return { spec, decision: { include: false, reason: 'no-spec' }, sourceSuffix: null };

  const existing = visibleBenefitsSlot(spec);
  if (existing) {
    return {
      spec,
      decision: {
        include: true,
        alreadyPresent: true,
        maxItems: existing.treatment?.maxItems || 4,
        phase: existing.phase,
        reason: 'spec-already-places',
      },
      sourceSuffix: null,
    };
  }

  const benefits = normalizeBenefitList(meta && meta.benefits);
  const include = !!(direction && direction.include === true && benefits.length);
  if (!include) {
    return {
      spec,
      decision: {
        include: false,
        reason: (direction && direction.reason) || (benefits.length ? 'no-direction' : 'no-content'),
      },
      sourceSuffix: null,
    };
  }

  const phase = direction.phase && direction.phase !== 'hook' ? direction.phase : 'proof';
  const next = {
    ...spec,
    slots: [...(spec.slots || []), buildBenefitsSlot({
      phase,
      maxItems: direction.maxItems || 3,
      spec,
    })],
  };
  const res = validateTitleSpec(next, { format });
  if (!res.ok) {
    return {
      spec,
      decision: { ...direction, include: false, reason: `invalid-splice:${(res.errors || [])[0] || 'unknown'}` },
      sourceSuffix: null,
    };
  }
  return { spec: res.normalized, decision: { ...direction, include: true, phase }, sourceSuffix: 'benefits' };
}

module.exports = {
  isBenefitsPlacementEnabled,
  videoTitleSize,
  videoTitleProfile,
  videoTitleDirectionKey,
  uniqueVideoTitleDirectionKeys,
  getVideoTitleDirection,
  resetVideoTitleDirectionMemo,
  occupancyBrief,
  parseDirectorDecision,
  applyBenefitsPlacement,
  buildBenefitsSlot,
};
