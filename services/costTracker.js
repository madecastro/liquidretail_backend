// Per-call cost telemetry wrapper. Use trackLlmCall() around any
// provider SDK call so the resulting tokens / duration / cost land in
// the CostLog collection consistently.
//
// Usage:
//   const result = await trackLlmCall(
//     { stage: 'layout_generator', provider: 'openai', model: 'gpt-4.1',
//       brandId, campaignId, adId, mediaId, cacheKey, visionImages: 4 },
//     () => openai.chat.completions.create({ ... })
//   );
//
// recordCacheHit() is the no-op-call companion: log a 0-cost hit when
// the artifact came from cache instead of an LLM call.

const CostLog = require('../models/CostLog');

// Best-effort per-model rates (USD per 1M tokens). Sourced from provider
// pricing pages 2026 mid-year; refresh as pricing changes. Used only for
// CostLog.costUsd estimation; not authoritative for billing.
const MODEL_RATES = Object.freeze({
  // OpenAI (https://openai.com/api/pricing)
  'gpt-4.1':           { input: 2.50,  output: 10.00, cachedInput: 1.25 },
  'gpt-4.1-mini':      { input: 0.50,  output: 2.00,  cachedInput: 0.25 },
  'gpt-image-1':       { input: 5.00,  output: 40.00, cachedInput: 5.00 },
  // Anthropic (https://www.anthropic.com/pricing)
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cachedInput: 1.50 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cachedInput: 0.30 },
  'claude-haiku-4.5':  { input: 1.00,  output: 5.00,  cachedInput: 0.10 },
  // Google (https://ai.google.dev/pricing)
  'gemini-2.5-pro':    { input: 1.25,  output: 5.00,  cachedInput: 0.31 },
  'gemini-2.5-flash':  { input: 0.10,  output: 0.40,  cachedInput: 0.025 },
  // Atlas Cloud gateway IDs (https://api.atlascloud.ai/api/v1/models —
  // pricing fields verified live 2026-07-21). Same underlying vendors,
  // provider-prefixed slugs.
  'openai/gpt-5.6-terra':        { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  'openai/gpt-5.6-luna':         { input: 1.00,  output: 6.00,  cachedInput: 0.10 },
  'openai/gpt-5.6-sol':          { input: 5.00,  output: 30.00, cachedInput: 0.50 },
  'openai/gpt-5.4':              { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  'google/gemini-2.5-flash':     { input: 0.30,  output: 2.50,  cachedInput: 0.075 },
  'google/gemini-2.5-pro':       { input: 1.25,  output: 10.00, cachedInput: 0.31 },
  'anthropic/claude-sonnet-4.6': { input: 3.00,  output: 15.00, cachedInput: 0.30 },
  // Flash-tier models used/benchmarked for the 'review-text' role
  // (atlasModelMap). Rates from the live Atlas catalog 2026-07-27. The
  // also-rans are listed too so switching via ATLAS_MODEL_REVIEW_TEXT shows up
  // in the ledger instead of silently logging $0.
  'google/gemini-2.5-flash-lite':           { input: 0.10,  output: 0.40, cachedInput: 0.01 },
  'google/gemini-2.0-flash-lite':           { input: 0.075, output: 0.30, cachedInput: 0.075 },
  'bytedance/doubao-seed-1.6-flash-250828': { input: 0.075, output: 0.30, cachedInput: 0.075 },
  'bytedance/doubao-seed-2.0-mini-260428':  { input: 0.10,  output: 0.40, cachedInput: 0.10 },
  'deepseek-ai/deepseek-v4-flash':          { input: 0.14,  output: 0.28, cachedInput: 0.14 },
  'qwen/qwen3.5-flash':                     { input: 0.10,  output: 0.40, cachedInput: 0.10 },
  'anthropic/claude-haiku-4.5-20251001':    { input: 1.00,  output: 5.00, cachedInput: 0.10 }
});

// Unknown models silently log $0 — warn once per model id so a new/renamed
// Atlas slug can't quietly zero the ledger.
const warnedUnknownModels = new Set();

// Vision image surcharge — gpt-4.1 charges per image (low ≈ 85 tokens,
// high ≈ 765 tokens per 512×512 tile). We log image count and add a
// rough cost based on default-quality assumption.
const VISION_IMAGE_COST_PER_IMAGE_USD = 0.005;   // ~mid-range estimate

async function trackLlmCall(meta, fn) {
  const t0 = Date.now();
  let result, status = 'ok', errorMessage = null;
  try {
    result = await fn();
  } catch (err) {
    status = err?.code === 'ETIMEDOUT' || /timeout/i.test(err?.message || '') ? 'timeout' : 'error';
    errorMessage = err?.message || String(err);
    // Log the failure with whatever timing we have, then rethrow.
    await persistCost({ ...meta, durationMs: Date.now() - t0, status, errorMessage });
    throw err;
  }

  // Token counts vary by provider. OpenAI returns usage.{prompt_tokens,
  // completion_tokens, cached_tokens?}; Anthropic returns
  // usage.{input_tokens, output_tokens, cache_read_input_tokens?}; Gemini
  // returns usageMetadata.{promptTokenCount, candidatesTokenCount}.
  const usage = extractUsage(result, meta.provider);
  const { costUsd, inputTokens, outputTokens, cachedInputTokens } = computeCost(meta.model, usage, meta.visionImages || 0);

  await persistCost({
    ...meta,
    inputTokens, outputTokens, cachedInputTokens,
    visionImages: meta.visionImages || 0,
    costUsd,
    durationMs: Date.now() - t0,
    status
  });

  return result;
}

// Cache-hit logging — call when an artifact was loaded from cache
// instead of generated. Records a 0-cost entry so the (stage, cacheKey)
// hit-rate query is accurate.
async function recordCacheHit(meta) {
  await persistCost({ ...meta, cacheHit: true, costUsd: 0, durationMs: 0, status: 'ok' });
}

// Flat-fee (non-token) call logging — video renders and other calls
// priced per generation rather than per token. The caller supplies
// costUsd (e.g. atlasVideoService.estimateRenderCostUsd); token fields
// stay 0 so the per-brand/per-stage rollups aggregate cleanly alongside
// LLM entries. Never throws (persistCost warns internally).
async function recordFlatCost(meta) {
  await persistCost({ status: 'ok', ...meta, costUsd: meta.costUsd || 0 });
}

async function persistCost(record) {
  try {
    await CostLog.create({
      stage:       record.stage,
      provider:    record.provider || 'unknown',
      model:       record.model    || 'unknown',
      purposeTag:  record.purposeTag || null,
      brandId:     record.brandId     || null,
      campaignId:  record.campaignId  || null,
      campaignRunId: record.campaignRunId || null,
      adId:        record.adId        || null,
      mediaId:     record.mediaId     || null,
      productId:   record.productId   || null,
      creativeDirectionArtifactId: record.creativeDirectionArtifactId || null,
      layoutGenerationArtifactId:  record.layoutGenerationArtifactId  || null,
      resolvedLayoutArtifactId:    record.resolvedLayoutArtifactId    || null,
      judgeResultArtifactId:       record.judgeResultArtifactId       || null,
      cacheHit:    !!record.cacheHit,
      cacheKey:    record.cacheKey || null,
      inputTokens: record.inputTokens || 0,
      outputTokens:record.outputTokens || 0,
      cachedInputTokens: record.cachedInputTokens || 0,
      visionImages:record.visionImages || 0,
      costUsd:     record.costUsd || 0,
      durationMs:  record.durationMs || 0,
      status:      record.status || 'ok',
      errorMessage:record.errorMessage || null
    });
  } catch (err) {
    // Never let telemetry break the pipeline. Log + continue.
    console.warn(`   ⚠️  costTracker.persist failed: ${err.message}`);
  }
}

function extractUsage(result, provider) {
  if (!result) return { input: 0, output: 0, cached: 0 };
  // Atlas Cloud gateway (and Google's OpenAI-compat endpoint, used as the
  // direct fallback for gemini rows) — OpenAI-compatible usage shape
  // regardless of the underlying vendor.
  if (provider === 'atlas' || provider === 'google-openai') {
    const u = result.usage || {};
    return {
      input:  u.prompt_tokens     || 0,
      output: u.completion_tokens || 0,
      cached: u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0
    };
  }
  // OpenAI chat / image gen
  if (provider === 'openai') {
    const u = result.usage || {};
    return {
      input:  u.prompt_tokens     || u.input_tokens  || 0,
      output: u.completion_tokens || u.output_tokens || 0,
      cached: u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0
    };
  }
  if (provider === 'anthropic') {
    const u = result.usage || {};
    return {
      input:  u.input_tokens  || 0,
      output: u.output_tokens || 0,
      cached: u.cache_read_input_tokens || 0
    };
  }
  if (provider === 'gemini') {
    const u = result.usageMetadata || result.response?.usageMetadata || {};
    return {
      input:  u.promptTokenCount     || 0,
      output: u.candidatesTokenCount || 0,
      cached: u.cachedContentTokenCount || 0
    };
  }
  return { input: 0, output: 0, cached: 0 };
}

function computeCost(model, usage, visionImages) {
  const rate = MODEL_RATES[model];
  if (!rate) {
    if (model && !warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(`💰 costTracker: no rate for model '${model}' — logging $0 (add it to MODEL_RATES)`);
    }
    return { costUsd: 0, inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cached };
  }
  const fullInput = Math.max(0, usage.input - (usage.cached || 0));
  const usd = (
    (fullInput        / 1_000_000) * rate.input +
    (usage.output     / 1_000_000) * rate.output +
    ((usage.cached || 0) / 1_000_000) * rate.cachedInput
  ) + (visionImages * VISION_IMAGE_COST_PER_IMAGE_USD);
  return {
    costUsd: Number(usd.toFixed(6)),
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedInputTokens: usage.cached || 0
  };
}

module.exports = {
  trackLlmCall,
  recordCacheHit,
  recordFlatCost,
  MODEL_RATES,
  VISION_IMAGE_COST_PER_IMAGE_USD
};
