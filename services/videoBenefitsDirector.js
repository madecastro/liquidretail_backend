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
const signalsMemo = new Map();
function resetVideoTitleDirectionMemo() {
  memo.clear();
  signalsMemo.clear();
}

function signalsMemoKey({ brandId, productId, campaignKind } = {}) {
  return `${brandId || ''}|${productId || 'none'}|${campaignKind || ''}`;
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function compactQuote(q) {
  if (!q || typeof q !== 'object') return null;
  if (typeof q.text !== 'string' || !q.text.trim()) return null;
  // text + author only — never source / site-as-author extras.
  // assembleSignals already ran quotes through toPrintableCustomerQuote.
  return { text: q.text, author: q.author || null };
}

/**
 * Compact performance_signal for the video-title prompt.
 * Forwards raw likes/comments/saves/shares + strength + top_post.
 * Omits the assembled mean-engagement figure: that field is an absolute
 * IG interaction count documented as a 0–1 rate (audit R6). Copying it
 * would spread the unit bug into titling.
 */
function compactPerformanceForVideo(perf) {
  if (!perf || typeof perf !== 'object') return null;
  const out = {};
  for (const k of ['likes', 'comments', 'saves', 'shares']) {
    if (finiteNumber(perf[k]) && perf[k] > 0) out[k] = perf[k];
  }
  if (typeof perf.strength === 'string' && perf.strength.trim()
      && perf.strength !== 'absent') {
    out.strength = perf.strength;
  }
  if (perf.top_post && typeof perf.top_post === 'object') {
    const tp = {};
    for (const k of ['likes', 'comments', 'saves']) {
      if (finiteNumber(perf.top_post[k]) && perf.top_post[k] > 0) {
        tp[k] = perf.top_post[k];
      }
    }
    if (typeof perf.top_post.caption === 'string' && perf.top_post.caption.trim()) {
      tp.caption = perf.top_post.caption;
    }
    if (Object.keys(tp).length) out.top_post = tp;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Compact ugc_signal — shot mix / counts / rights / top_creator.
 * followers is copied only when it is a real number; ingest never writes
 * creatorFollowerCount, so the assembled value is almost always null.
 */
function compactUgcForVideo(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const out = {};
  if (typeof signal.platform === 'string' && signal.platform.trim()) {
    out.platform = signal.platform;
  }
  if (finiteNumber(signal.media_count)) out.media_count = signal.media_count;
  if (typeof signal.media_strength === 'string' && signal.media_strength.trim()) {
    out.media_strength = signal.media_strength;
  }
  if (signal.rights_approved != null) out.rights_approved = !!signal.rights_approved;
  for (const k of [
    'shot_type_distribution',
    'content_nature_distribution',
    'file_type_distribution',
  ]) {
    if (signal[k] && typeof signal[k] === 'object' && !Array.isArray(signal[k])
        && Object.keys(signal[k]).length) {
      out[k] = signal[k];
    }
  }
  if (finiteNumber(signal.avg_ad_readiness)) {
    out.avg_ad_readiness = signal.avg_ad_readiness;
  }
  if (Array.isArray(signal.primary_subjects) && signal.primary_subjects.length) {
    const subjects = signal.primary_subjects
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, 5);
    if (subjects.length) out.primary_subjects = subjects;
  }
  if (signal.top_creator && typeof signal.top_creator === 'object'
      && typeof signal.top_creator.handle === 'string'
      && signal.top_creator.handle.trim()) {
    const tc = { handle: signal.top_creator.handle };
    if (typeof signal.top_creator.platform === 'string'
        && signal.top_creator.platform.trim()) {
      tc.platform = signal.top_creator.platform;
    }
    if (finiteNumber(signal.top_creator.followers)) {
      tc.followers = signal.top_creator.followers;
    }
    out.top_creator = tc;
  }
  return Object.keys(out).length ? out : null;
}

function compactProofOption(opt) {
  if (!opt || typeof opt !== 'object') return null;
  const row = {};
  if (typeof opt.tier === 'string' && opt.tier.trim()) row.tier = opt.tier;
  if (finiteNumber(opt.rating)) row.rating = opt.rating;
  if (opt.review_count != null && finiteNumber(Number(opt.review_count))) {
    row.review_count = opt.review_count;
  }
  if (typeof opt.reviews_text === 'string' && opt.reviews_text.trim()) {
    row.reviews_text = opt.reviews_text;
  }
  if (Array.isArray(opt.quotes) && opt.quotes.length) {
    const quotes = opt.quotes.map(compactQuote).filter(Boolean);
    if (quotes.length) row.quotes = quotes;
  }
  return (row.tier || row.rating != null || row.review_count != null
    || row.reviews_text || row.quotes) ? row : null;
}

/**
 * Compact printable social_proof_signal for the video-title prompt.
 * assembleSignals already ran quotes through toPrintableCustomerQuote —
 * never re-read raw bylines here. Optional second arg is performance_signal
 * from the same assembleSignals return (sibling key, not a child).
 */
function printableSocialProofForVideo(signal, performanceSignal) {
  if ((!signal || typeof signal !== 'object')
      && (!performanceSignal || typeof performanceSignal !== 'object')) {
    return null;
  }
  const src = (signal && typeof signal === 'object') ? signal : {};
  const out = {};
  if (src.rating && typeof src.rating.value === 'number') {
    out.rating = src.rating;
  }
  const primary = compactQuote(src.primary_quote);
  if (primary) out.primary_quote = primary;
  if (Array.isArray(src.top_comments) && src.top_comments.length) {
    out.top_comments = src.top_comments.slice(0, 2).map((c) => {
      const row = compactQuote(c);
      if (!row) return null;
      if (finiteNumber(c.likes)) row.likes = c.likes;
      return row;
    }).filter(Boolean);
    if (!out.top_comments.length) delete out.top_comments;
  }
  if (src.strongest_signal) out.strongest_signal = src.strongest_signal;
  if (Array.isArray(src.proof_options) && src.proof_options.length) {
    const opts = src.proof_options.map(compactProofOption).filter(Boolean);
    if (opts.length) out.proof_options = opts;
  }
  // Flag-gated in assembleSignals (QUOTE_STAGE_AWARE + quote-pool align).
  // Absent on a default boot; copy through when present so a flag flip
  // reaches video without a second assembly path.
  if (src.quotes_by_stage && typeof src.quotes_by_stage === 'object'
      && !Array.isArray(src.quotes_by_stage)) {
    const by = {};
    for (const [stage, q] of Object.entries(src.quotes_by_stage)) {
      const compact = compactQuote(q);
      if (compact) by[stage] = compact;
    }
    if (Object.keys(by).length) out.quotes_by_stage = by;
  }
  const perf = compactPerformanceForVideo(performanceSignal);
  if (perf) out.performance = perf;
  return Object.keys(out).length ? out : null;
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

function buildDirectorMessages({
  size, profile, occupancy, benefits, productSignal, brandSignal,
  socialProofSignal, ugcSignal, performanceSignal,
} = {}) {
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
    '- Product description, specs, review summary, price, brand description / tagline / tone / brand_reviews_summary, personas, UGC, performance counts, and printable social proof (when present) ground the include/phase call. They are not extra slots.',
    '- If a signal is absent / null / empty, do not treat it as present.',
    '- HONESTY RULE: if primary_quote is null AND top_comments is empty AND rating is null AND proof_options is absent/empty, there is no proof to lean on — decide from benefits/specs/description only. Do not promise proof the data can\'t back. When proof_options IS present, proof can inform include/phase — but only in that option\'s own scope (see PROOF MENU), never as this product\'s own number.',
    '- A high rating with a large count (≥4.5 from ≥50) is credible on its own. A high rating from a small count is not — lean on the quote instead of the number.',
    '- PROOF MENU: proof_options (when present) lists product / category / brand tiers, each with a pre-scoped reviews_text. If you reason from a category or brand option, keep that option\'s own scope (e.g. "loved across our whole line" / "brand-wide") — NEVER phrase a category or brand number as if it belonged to this specific product. This menu does not change what the title renderer prints; it only grounds include/phase.',
    '- PERSONAS: brand personas (when present) inform voice and objection framing ONLY. Never use a persona as a quote author, never invent a testimonial. A persona is who the title is FOR, not who is speaking.',
    '- PERFORMANCE: likes/comments/saves/shares and top_post are engagement COUNTS. If a single post dramatically outperforms the others, a proof-phase include is justified. Do not invent a rate; do not treat a small absolute count as high engagement.',
    '- UGC: shot mix / media_count / rights_approved / top_creator (when present) describe the matched social set. Lifestyle/on_model mix supports a proof/benefits include; product_only is not a stop. A top_creator handle is an authenticity cue, not a testimonial author. Do not invent follower counts.',
    '- PRICE is positioning (aspirational vs accessible), never a slot or a discount claim. No currency amount, "% off", "discount", "sale", or "savings" belongs in a printed title.',
    '- Thin data is not a stop: decide with what you have.',
  ].join('\n');

  const userLines = [
    `SIZE: ${size} (all delivered surfaces cropped/retitled from this Omni master inherit this decision)`,
    `CONTENT PROFILE: ${profile}`,
    `BRAND: ${brandSignal?.name || 'unknown'}`,
    `PRODUCT: ${productSignal?.name || 'unknown'}`,
  ];
  if (brandSignal?.tagline) userLines.push(`BRAND TAGLINE: ${brandSignal.tagline}`);
  if (brandSignal?.description) {
    userLines.push(`BRAND DESCRIPTION: ${brandSignal.description}`);
  }
  if (Array.isArray(brandSignal?.tone) && brandSignal.tone.length) {
    userLines.push(`BRAND TONE: ${JSON.stringify(brandSignal.tone)}`);
  }
  if (brandSignal?.brand_reviews_summary) {
    userLines.push(`BRAND REVIEWS SUMMARY: ${brandSignal.brand_reviews_summary}`);
  }
  if (Array.isArray(brandSignal?.personas) && brandSignal.personas.length) {
    userLines.push(`BRAND PERSONAS: ${JSON.stringify(brandSignal.personas)}`);
  }
  if (productSignal?.description) {
    userLines.push(`PRODUCT DESCRIPTION: ${productSignal.description}`);
  }
  if (Array.isArray(productSignal?.specs) && productSignal.specs.length) {
    userLines.push(`PRODUCT SPECS: ${JSON.stringify(productSignal.specs)}`);
  }
  if (productSignal?.review_summary) {
    userLines.push(`PRODUCT REVIEW SUMMARY: ${productSignal.review_summary}`);
  }
  if (productSignal?.price != null && productSignal.price !== ''
      && typeof productSignal.price !== 'object') {
    const priceBits = [String(productSignal.price)];
    if (typeof productSignal.currency === 'string' && productSignal.currency.trim()) {
      priceBits.push(productSignal.currency.trim());
    }
    userLines.push(`PRODUCT PRICE: ${priceBits.join(' ')}`);
  }
  userLines.push(`BENEFITS AVAILABLE: ${JSON.stringify(benefits)}`);
  const proof = printableSocialProofForVideo(socialProofSignal, performanceSignal);
  if (proof) userLines.push(`SOCIAL PROOF: ${JSON.stringify(proof)}`);
  const ugc = compactUgcForVideo(ugcSignal);
  if (ugc) userLines.push(`UGC: ${JSON.stringify(ugc)}`);
  userLines.push(
    `BASE LAYOUT: ${occupancy.intentPreset} format=${occupancy.format} target_phase=${occupancy.phase}`,
    `SLOTS ALREADY IN TARGET PHASE: ${occupancy.slots.join(', ') || '(none)'}`,
    `SURFACE KEEP-OUT KEY: ${occupancy.surface}`,
    'Decide include_benefits / max_items / phase now.',
  );

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
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

  // One assembleSignals per product — the 6 unique (size × profile) keys
  // of a mixed kit share the same brief. Callers can pass a generate-scoped
  // memo via deps.assembleSignals so the static Director round reuses it.
  const sKey = signalsMemoKey({
    brandId, productId, campaignKind: campaignKind || 'product',
  });
  let signalsP = signalsMemo.get(sKey);
  if (!signalsP) {
    signalsP = Promise.resolve().then(() => assembleSignals({
      brandId, productId, campaignKind: campaignKind || 'product',
    }));
    signalsMemo.set(sKey, signalsP);
  }
  const signals = await signalsP;
  const benefits = normalizeBenefitList(signals?.product_signal?.benefits);
  if (!benefits.length) {
    return { include: false, reason: 'no-content', size, profile, source: 'short-circuit' };
  }

  const occupancy = occupancyBrief({ size, profile });
  const messages = buildDirectorMessages({
    size, profile, occupancy, benefits,
    productSignal: signals.product_signal,
    brandSignal: signals.brand_signal,
    socialProofSignal: signals.social_proof_signal,
    ugcSignal: signals.ugc_signal,
    performanceSignal: signals.performance_signal,
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
  buildDirectorMessages,
  printableSocialProofForVideo,
  compactPerformanceForVideo,
  compactUgcForVideo,
};
