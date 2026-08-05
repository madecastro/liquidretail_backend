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
const alerts  = require('./alertService');

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
  // Google direct (https://ai.google.dev/gemini-api/docs/pricing)
  // NOTE (2026-08-03): re-read live while ledgering the grounded-search path.
  // 'gemini-2.5-pro' output is ALSO stale here — the live page says $10.00
  // (<=200k prompts), not 5.00, and caching is 0.125, not 0.31. Left untouched
  // deliberately: it is outside this change and moving it silently re-prices
  // every layoutInputService row. Tracked separately; do not treat 5.00 as
  // confirmed.
  'gemini-2.5-pro':    { input: 1.25,  output: 5.00,  cachedInput: 0.31 },
  // Was 0.10/0.40/0.025 — those are Flash-LITE numbers, so every direct
  // gemini-2.5-flash row understated input 3x and output 6x. The sibling
  // Atlas slug below already carried the correct 0.30/2.50. Output price
  // INCLUDES thinking tokens, which is why extractUsage adds thoughtsTokenCount.
  'gemini-2.5-flash':  { input: 0.30,  output: 2.50,  cachedInput: 0.03 },
  // Atlas Cloud gateway IDs (https://api.atlascloud.ai/api/v1/models —
  // pricing fields verified live 2026-07-21). Same underlying vendors,
  // provider-prefixed slugs.
  'openai/gpt-5.6-terra':        { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  'openai/gpt-5.6-luna':         { input: 1.00,  output: 6.00,  cachedInput: 0.10 },
  'openai/gpt-5.6-sol':          { input: 5.00,  output: 30.00, cachedInput: 0.50 },
  'openai/gpt-5.4':              { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  'google/gemini-2.5-flash':     { input: 0.30,  output: 2.50,  cachedInput: 0.075 },
  'google/gemini-2.5-pro':       { input: 1.25,  output: 10.00, cachedInput: 0.31 },
  // Director role as of 2026-07-31. Rates read from the live Atlas catalog
  // (price.actual input_price/output_price), not the vendor list price. Without an
  // entry here every director call ledgers $0 — the role would be invisible in
  // spend reports precisely when we have just started paying for it.
  'anthropic/claude-sonnet-5-ccmax': { input: 2.00,  output: 10.00, cachedInput: 0.20 },
  'anthropic/claude-opus-5-ccmax':   { input: 5.00,  output: 25.00, cachedInput: 0.50 },
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

// Google Search grounding surcharge — billed PER REQUEST on top of tokens,
// not per token. Live figure 2026-08-03
// (https://ai.google.dev/gemini-api/docs/pricing), identical for 2.5 Flash and
// 2.5 Pro: "1,500 RPD (free) … then $35 / 1,000 grounded prompts".
//
// $0.035 a call against roughly $0.004 of tokens for a 1.5k-token grounded
// pass — so omitting it understates a grounded path by ~10x. That is the whole
// reason this constant exists; token math alone is not a ledger for these calls.
//
// UNIT — per PROMPT, and that is model-generation-specific. Google, verbatim
// (ai.google.dev/gemini-api/docs/google-search): with Gemini 3 "your project is
// billed for each search query that the model decides to execute", but "when you
// use search grounding with Gemini 2.5 or older models, your project is billed
// per prompt." We are on 2.5, so one grounded request == one billable unit.
// MOVING TO A GEMINI 3 MODEL BREAKS THAT ASSUMPTION — a single prompt can then
// bill several queries, and callers would need to count
// groundingMetadata.webSearchQueries instead of passing 1.
//
// TWO KNOWN APPROXIMATIONS, both erring toward never understating:
//  · It is DECLARED, not confirmed. A caller sets it because it enabled the
//    google_search tool, not because the response proved a search ran. A prompt
//    the model answers without searching still ledgers the surcharge.
//  · Inside the free 1,500/day allowance the true marginal cost is $0, so this
//    overstates until that is exhausted. Set GEMINI_GROUNDING_COST_USD=0 to
//    ledger the free tier honestly.
// Rows stamp costSource:'estimated' either way.
const GROUNDED_SEARCH_COST_PER_REQUEST_USD = (() => {
  const raw = process.env.GEMINI_GROUNDING_COST_USD;
  if (raw === undefined || String(raw).trim() === '') return 0.035;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.035;
})();

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
  const { costUsd, inputTokens, outputTokens, cachedInputTokens } =
    computeCost(meta.model, usage, meta.visionImages || 0, meta.groundedRequests || 0);

  await persistCost({
    ...meta,
    inputTokens, outputTokens, cachedInputTokens,
    visionImages: meta.visionImages || 0,
    groundedRequests: meta.groundedRequests || 0,
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

/**
 * Replace an estimated cost with the provider's authoritative figure.
 *
 * Atlas publishes `price` on the prediction, but the render path returns as soon
 * as status flips to completed, so the row can be written before that value is
 * readable. This updates in place, keyed on the prediction id.
 *
 * Deliberately narrow: only ever upgrades 'estimated' -> 'actual'. It will not
 * touch a row already marked actual, so a late duplicate call cannot corrupt a
 * good figure, and it never creates a row (a missing row means the write failed
 * and inventing one here would hide that).
 */
async function reconcileCost({ providerRequestId, costUsd }) {
  if (!providerRequestId || !Number.isFinite(Number(costUsd))) return false;
  try {
    const res = await CostLog.updateOne(
      { providerRequestId, costSource: 'estimated' },
      { $set: { costUsd: Number(costUsd), costSource: 'actual' } }
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    if (n) console.log(`   💲 cost reconciled ${providerRequestId} -> $${Number(costUsd).toFixed(6)} (actual)`);
    return !!n;
  } catch (err) {
    console.warn(`   ⚠️  cost reconcile failed for ${providerRequestId}: ${err.message}`);
    return false;
  }
}

/**
 * Refine the ledger row for a submit that has already been recorded, IN PLACE.
 *
 * WHY THIS EXISTS (2026-08-05). Media paths now write a row at the CHARGE POINT —
 * the moment the provider accepts a billable job — because everything after that
 * (poll, download, upload) can be lost to a deploy SIGTERM or an OOM, and the money
 * is already gone. Measured: nine gpt-image-2/edit predictions killed mid-poll,
 * $0.5663 confirmed billed by Atlas, ZERO CostLog rows.
 *
 * But `recordFlatCost` INSERTS (persistCost -> CostLog.create). Calling it again
 * when the outcome lands would leave TWO rows for one submit and DOUBLE-COUNT the
 * charge — turning a reporting gap into a reporting lie, which is worse. So the
 * outcome updates the existing row instead of adding one.
 *
 * Keyed on providerRequestId, which is unique per billable submit. A non-empty id
 * is REQUIRED: upserting on a null key would collapse every id-less call (all the
 * per-token LLM rows) into a single shared row. When there is no id, the caller
 * genuinely wants an insert, so this falls back to recordFlatCost.
 *
 * Upserts rather than pure-updates so a caller whose charge-point write failed
 * (it is fire-and-forget) still ends up with a row rather than silently none.
 *
 * ⚠️ THE FALLBACK INSERT NEEDS A COMPLETE RECORD. CostLog requires `stage`, and
 * persistCost DROPS a row that fails validation. So a caller passing only
 * { providerRequestId, costUsd } gets a silent no-op whenever the update misses —
 * i.e. precisely on the rows that predate the charge-point ledger and most need
 * recording. Observed on the first live recovery dry run. The guard below refuses
 * to attempt an insert that is certain to be dropped, and says so.
 */
async function finalizeFlatCost(meta = {}) {
  const id = meta.providerRequestId;
  if (!id) return recordFlatCost(meta);
  const raw = meta.status || 'ok';
  const status = CostLog.COST_STATUSES.includes(raw) ? raw : 'error';
  try {
    await CostLog.updateOne(
      { providerRequestId: id },
      { $set: {
          status,
          costUsd:      Number(meta.costUsd) || 0,
          costSource:   meta.costSource || 'estimated',
          durationMs:   meta.durationMs ?? null,
          errorMessage: meta.errorMessage || null
      } },
      { upsert: false }
    ).then(async (res) => {
      const n = res.matchedCount ?? res.n ?? 0;
      // No charge-point row (its fire-and-forget write lost a race with the
      // process, or this is a legacy caller): fall back to an insert so the
      // spend is recorded rather than dropped.
      if (!n) {
        if (!meta.stage) {
          console.error(
            `   ❌ costTracker: cannot insert a fallback row for ${id} — no \`stage\`, ` +
            `and CostLog validation would drop it silently. Pass a complete record ` +
            `(stage/provider/model) to finalizeFlatCost. $${Number(meta.costUsd) || 0} NOT ledgered.`
          );
          return;
        }
        await recordFlatCost(meta);
      }
    });
  } catch (err) {
    console.warn(`   ⚠️  costTracker: finalize failed for ${id} (${err.message}) — falling back to insert`);
    await recordFlatCost(meta).catch(() => {});
  }
}

async function persistCost(record) {
  // Normalise the outcome BEFORE validation. An unrecognised status used to fail
  // mongoose validation, and the catch below swallowed it, so the entire cost row
  // vanished — the dollars, the model, the duration, everything. Coerce instead,
  // preserving the original value in errorMessage so nothing is lost.
  const raw = record.status || 'ok';
  const known = CostLog.COST_STATUSES.includes(raw);
  const status = known ? raw : 'error';
  const errorMessage = known
    ? (record.errorMessage || null)
    : [`unmapped status "${raw}"`, record.errorMessage].filter(Boolean).join(' — ');
  if (!known) {
    console.error(`   ❌ costTracker: unmapped status "${raw}" coerced to 'error' — add it to CostLog.COST_STATUSES`);
  }

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
      groundedRequests: record.groundedRequests || 0,
      costUsd:     record.costUsd || 0,
      durationMs:  record.durationMs || 0,
      status:      status,
      errorMessage:errorMessage,
      providerRequestId: record.providerRequestId || null,
      costSource:  record.costSource || (record.costUsd ? 'estimated' : 'none')
    });
  } catch (err) {
    // Never let telemetry break the pipeline. Log + continue.
    // A ValidationError here means a producer and the schema have drifted, which
    // costs us the whole row — loud, because it is a code bug, not a blip.
    if (err?.name === 'ValidationError') {
      console.error(`   ❌ costTracker.persist DROPPED a cost row (schema drift): ${err.message}`);
      alerts.error({
        title: 'Cost row dropped — CostLog schema drift',
        detail: err.message,
        key: 'costlog-validation'
      }).catch(() => {});
    } else {
      console.warn(`   ⚠️  costTracker.persist failed: ${err.message}`);
    }
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
    // Raw generativelanguage REST puts this on the response BODY, so a caller
    // wrapping axios must return `res.data` (not the axios response) or every
    // token count silently reads 0. The `.response` path covers the Google SDK.
    const u = result.usageMetadata || result.response?.usageMetadata || {};
    return {
      // toolUsePromptTokenCount is reported separately from promptTokenCount.
      // HONEST CAVEAT: Google's docs do NOT explicitly state that search-injected
      // tool context is billed as input, and totalTokenCount is documented as
      // prompt + thoughts + candidates without naming it. Counted here as the
      // never-understate choice; it is ~1% of a grounded row ($0.0003 per 1k
      // tokens against a $0.035 grounding surcharge), so it cannot distort a
      // report either way. Drop it if Google ever documents it as free.
      input:  (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0),
      // thoughtsTokenCount is reported SEPARATELY from candidatesTokenCount but
      // is billed at the output rate ("Output price includes thinking tokens").
      // Counting candidates alone understates every thinking-enabled call —
      // which on 2.5 models is the default unless thinkingBudget is 0.
      output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      // promptTokenCount already includes the cached portion, so the
      // full-vs-cached split in computeCost stays correct.
      cached: u.cachedContentTokenCount || 0
    };
  }
  return { input: 0, output: 0, cached: 0 };
}

function computeCost(model, usage, visionImages, groundedRequests) {
  // Per-request surcharges are independent of the token table — keep them out
  // here so an unknown/renamed model id cannot zero them too.
  const surcharges =
    ((visionImages || 0) * VISION_IMAGE_COST_PER_IMAGE_USD) +
    ((groundedRequests || 0) * GROUNDED_SEARCH_COST_PER_REQUEST_USD);

  const rate = MODEL_RATES[model];
  if (!rate) {
    if (model && !warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(`💰 costTracker: no rate for model '${model}' — tokens log $0 (add it to MODEL_RATES)`);
    }
    // Previously returned a hard 0, which also discarded any per-request
    // surcharge — a $0.035 grounded call behind a renamed slug ledgered as free.
    return {
      costUsd: Number(surcharges.toFixed(6)),
      inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cached
    };
  }
  const fullInput = Math.max(0, usage.input - (usage.cached || 0));
  const usd = (
    (fullInput        / 1_000_000) * rate.input +
    (usage.output     / 1_000_000) * rate.output +
    ((usage.cached || 0) / 1_000_000) * rate.cachedInput
  ) + surcharges;
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
  finalizeFlatCost,
  reconcileCost,
  MODEL_RATES,
  VISION_IMAGE_COST_PER_IMAGE_USD,
  GROUNDED_SEARCH_COST_PER_REQUEST_USD
};
