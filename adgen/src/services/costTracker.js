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
  // cachedInput CORRECTED 2026-08-19: re-verified live against
  // https://api.atlascloud.ai/api/v1/models (price.actual.cache_price) while
  // building the daily Atlas-vs-CostLog cross-check
  // (scripts/reconcileAtlasDailyCosts.js) — that tool's first live run
  // surfaced 'google/gemini-2.5-flash' as the single largest driver of a
  // 40% single-day over-claim (2026-08-17: $1.65 claimed vs $0.34 billed for
  // this model alone), which is what prompted re-checking these two ATLAS-
  // GATEWAY entries specifically (distinct from the bare, DIRECT-provider
  // 'gemini-2.5-pro' key below, which stays deliberately untouched per the
  // 2026-08-03 note on that entry — a different call path, not protected by
  // that note). Was 0.075/0.31; live catalog says 0.03/0.125. CORRECTED
  // 2026-08-19: an earlier version of this note blamed the bulk of that day's
  // gap on the grounding surcharge estimate (GEMINI_GROUNDING_COST_USD,
  // below). That is IMPOSSIBLE: `groundedRequests` is set in exactly one
  // place — geminiSearchProvider.trackedGenerate, which always writes
  // provider:'gemini' — while reconcileAtlasDailyCosts aggregates
  // provider:'atlas' rows only, so no Atlas row can carry the surcharge. The
  // likelier driver of the residual is the flat
  // VISION_IMAGE_COST_PER_IMAGE_USD estimate. Still flagged, not chased; see
  // the audit report — just don't chase the surcharge, it cannot be the cause.
  'google/gemini-2.5-flash':     { input: 0.30,  output: 2.50,  cachedInput: 0.03 },
  'google/gemini-2.5-pro':       { input: 1.25,  output: 10.00, cachedInput: 0.125 },
  // Director role as of 2026-07-31. Rates read from the live Atlas catalog
  // (price.actual input_price/output_price), not the vendor list price. Without an
  // entry here every director call ledgers $0 — the role would be invisible in
  // spend reports precisely when we have just started paying for it.
  'anthropic/claude-sonnet-5-ccmax': { input: 2.00,  output: 10.00, cachedInput: 0.20 },
  'anthropic/claude-opus-5-ccmax':   { input: 5.00,  output: 25.00, cachedInput: 0.50 },
  // PLAIN (non-`-ccmax`) slugs — CONFIRMED THE REAL HOLE (2026-08-19). The
  // Director's live cross-provider fallback chain (atlasModelMap.js —
  // `anthropic/claude-sonnet-5` -> `anthropic/claude-opus-5` -> `openai/gpt-5.6-terra`,
  // see CLAUDE.md's fallback-chain measurement table) calls these PLAIN slugs,
  // not the `-ccmax` ones above. Every successful Director round on the
  // primary or first-fallback link was ledgering near-zero (surcharges only —
  // $0.0050 with one vision reference image, $0 with none) because
  // computeCost() found no rate and silently dropped the entire token cost.
  // Verified LIVE against https://api.atlascloud.ai/api/v1/models 2026-08-19
  // (price.actual on each entry) — IDENTICAL to the -ccmax twin, which is
  // expected: same underlying model, `-ccmax` is a routing/tier suffix, not a
  // different price:
  //   anthropic/claude-sonnet-5  input=2  output=10  cache=0.2
  //   anthropic/claude-opus-5    input=5  output=25  cache=0.5
  'anthropic/claude-sonnet-5':       { input: 2.00,  output: 10.00, cachedInput: 0.20 },
  'anthropic/claude-opus-5':         { input: 5.00,  output: 25.00, cachedInput: 0.50 },
  // Named explicitly in the Director fallback chain's own live measurement
  // table (CLAUDE.md §"Known open" — `anthropic/claude-sonnet-4.5-20250929`,
  // 200-OK-but-52s). Same catalog probe 2026-08-19: input=3 output=15
  // cache=0.3 for the base (<=200k token) tier — Atlas also publishes a
  // `prompt_thresholds` tier above 200k prompt tokens (input=6 output=22.5
  // cache=0.6) that this flat-rate table does not model; every call here is
  // priced at the base tier, which UNDER-states a rare >200k-token round. Not
  // a regression — no entry at all was ALWAYS wrong, and API round prompts
  // measured well under 200k tokens as of this writing.
  'anthropic/claude-sonnet-4.5-20250929': { input: 3.00, output: 15.00, cachedInput: 0.30 },
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

// Vision image surcharge — $0 BY DEFAULT SINCE 2026-08-19, AND THAT IS THE
// CORRECT VALUE, not a disabled feature. It was 0.005/image.
//
// WHY IT WAS WRONG: it double-charged. Every provider in extractUsage()
// reports image tokens INSIDE its prompt-token count — OpenAI and the
// OpenAI-compatible Atlas gateway fold them into `usage.prompt_tokens`,
// Gemini into `promptTokenCount`. The original comment gave the surcharge in
// TOKENS ("low ≈ 85, high ≈ 765 per 512×512 tile"), which is the tell: it was
// modelling a quantity the per-token math had already billed. So a vision row
// paid for its images twice — once at the model's real input rate, then again
// at a flat $0.005.
//
// MEASURED, not reasoned (scripts/reconcileAtlasDailyCosts.js against Atlas's
// own settled billing, 2026-08-19). On 2026-08-17 the ledger claimed $4.7890
// against Atlas's actual $3.4185 — a 40% over-claim. 99.2% of that $1.3705 gap
// was this surcharge: 260 declared images x $0.005 = $1.3000. The same day's
// google/gemini-2.5-flash rows carried ZERO grounded requests and ZERO cached
// tokens, so neither the grounding surcharge nor the cachedInput rate fix could
// account for any of it. Token-only math for those rows came to $0.3520 against
// Atlas's $0.3418 — a 3.0% drift, in line with every other day. Dropping the
// surcharge moves 2026-08-17 from +40.1% to +0.3%, and the 6-day complete-day
// total from +1.6% to -2.3%.
//
// A cross-check that settles the direction: if images were NOT already in
// prompt_tokens, Atlas would have billed MORE than our token-only figure. It
// billed LESS. Whatever Atlas does with image tokens, it does not add a
// separate per-image charge on top.
//
// Left as an env-tunable constant rather than deleted so a future provider that
// genuinely reports usage WITHOUT its image tokens can be priced without a code
// change. Set VISION_IMAGE_COST_USD to that provider's per-image rate if one
// ever appears; do not set it back to 0.005 for the providers above.
const VISION_IMAGE_COST_PER_IMAGE_USD = (() => {
  const raw = process.env.VISION_IMAGE_COST_USD;
  if (raw === undefined || String(raw).trim() === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

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
// TWO KNOWN APPROXIMATIONS. The first still errs toward never understating;
// the second DID, and was measured to be the dominant error on this path:
//  · It is DECLARED, not confirmed. A caller sets it because it enabled the
//    google_search tool, not because the response proved a search ran. A prompt
//    the model answers without searching still ledgers the surcharge.
//  · The free allowance was ignored, so every call inside it was ledgered at
//    the post-allowance price. See FREE-ALLOWANCE below — this is now $0 by
//    default, because that is what these calls actually cost us.
// Rows stamp costSource:'estimated' either way.
//
// ── FREE-ALLOWANCE DEFAULT (changed 2026-08-19: 0.035 -> 0) ─────────────────
// Google's 1,500-grounded-prompts/day allowance applies to the PAID tier, not
// just the free one — re-read live 2026-08-19: "1,500 RPD (free, limit shared
// with Flash-Lite RPD), then $35 / 1,000 grounded prompts", published
// identically under both tiers. So a grounded request is genuinely free until
// the 1,501st one that day.
//
// MEASURED VOLUME (CostLog, 2026-08-13..08-19): grounded requests ran at 19/day
// and 13/day — 1.27% and 0.87% of the allowance. Every grounded call in that
// window had a true marginal cost of $0.00, and the ledger claimed $1.1200 for
// them: 89.9% of ALL direct-Gemini spend recorded in the window was this
// surcharge on calls Google did not bill.
//
// WHY THIS ONE COULD NOT SELF-CORRECT, which is why it is worth a comment this
// long. Grounded calls are pinned to provider:'gemini' (the single call site,
// services/providers/geminiSearchProvider.js trackedGenerate) because Atlas
// cannot proxy Google Search grounding at all (probed in PR #229: native
// google_search -> 400, OpenAI web_search -> 400, top-level flag silently
// ignored). scripts/reconcileAtlasDailyCosts.js matches provider:'atlas' only,
// by construction — Atlas's bill cannot contain a call that never touched its
// meter. So no reconciliation this repo has ever had could see this row, and
// none ever will until a Google-billing cross-check exists. An unverifiable
// constant has to be right by argument, because nothing downstream will catch
// it being wrong.
//
// THE UNDERSTATEMENT RISK, AND WHY IT IS NOT SILENT. $0 is correct only while
// daily volume stays inside the allowance; past it, real money is spent and a
// $0 ledger hides it — the mirror of the bug being fixed. That is what
// GEMINI_GROUNDING_FREE_RPD and the crossing alert below are for: when a day's
// grounded volume approaches the allowance, the ledger says so out loud instead
// of quietly going wrong. Set GEMINI_GROUNDING_COST_USD=0.035 when that fires.
//
// NOT MADE PER-CALLER, deliberately, though that was on the table. The price is
// a property of Google's billing, not of the calling stage: two stages issuing
// the same grounded request are charged the same. A per-caller knob would let
// identical requests ledger different amounts depending on who asked, which is
// exactly the kind of unauditable drift the rest of this table is written to
// avoid.
const GROUNDED_SEARCH_COST_PER_REQUEST_USD = (() => {
  const raw = process.env.GEMINI_GROUNDING_COST_USD;
  if (raw === undefined || String(raw).trim() === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

// Google's published free allowance, per project per UTC day. Env-tunable so a
// plan change does not need a deploy.
const GEMINI_GROUNDING_FREE_RPD = (() => {
  const raw = process.env.GEMINI_GROUNDING_FREE_RPD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1500;
})();

// Fraction of the allowance at which we start shouting. Deliberately well below
// 1.0: this counter is PER PROCESS (web and worker each keep their own), so the
// project-wide total can be several times the largest local count. A fractional
// threshold buys the margin that per-process counting costs us.
//
// WHAT HAPPENS AT 100% — A STATED DECISION, NOT AN OVERSIGHT. Nothing. The
// ledger keeps recording $0 per grounded request and keeps the alert standing.
// It does NOT start charging $0.035 by itself, and that restraint is the point:
//
//  · The trigger would be a PER-PROCESS count. Web and worker each hold their
//    own, so whichever crosses first would flip only its own rows while its
//    siblings kept billing $0 — the same request priced two different ways
//    depending on which box served it. An unauditable ledger is worse than a
//    knowably-conservative one.
//  · Crossing the allowance is a real, reviewable event (it means grounded
//    volume grew ~75x from the 13-19/day measured 2026-08-19). It deserves a
//    human looking at Google's actual bill and setting
//    GEMINI_GROUNDING_COST_USD deliberately — not a threshold silently
//    re-pricing every row behind us.
//  · Auto-repricing off an under-count is EXACTLY the class of bug this block
//    was written to fix: a number that moved on its own, that nothing
//    downstream could verify (these rows are provider:'gemini' and no
//    reconcile sees them), and that therefore stayed wrong for weeks.
//
// So past 100% the ledger is deliberately, loudly, KNOWN-conservative rather
// than quietly precise. If you are here to "finish" this by making the
// threshold apply the surcharge automatically: that is the regression, not the
// improvement. Be loudly wrong, never quietly wrong.
const GROUNDING_ALERT_FRACTION = (() => {
  const raw = Number(process.env.GEMINI_GROUNDING_ALERT_FRACTION);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
})();

// UTC-day grounded-request counter. Reset lazily on the first call of a new day
// rather than on a timer, so an idle process holds no interval handle.
const groundingUsage = { day: null, count: 0, alerted: false };

/**
 * Count a grounded request against today's free allowance and, once the local
 * count crosses GROUNDING_ALERT_FRACTION of it, alert ONCE for that day.
 *
 * Called for its side effect only — it deliberately does not change the price
 * of the row being written, at ANY count, including past the allowance itself.
 * See GROUNDING_ALERT_FRACTION above for why crossing is surfaced to a human
 * instead of silently re-pricing; that is a decision, not a missing feature.
 */
function noteGroundedRequests(n) {
  const count = Number(n) || 0;
  if (count <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  if (groundingUsage.day !== today) {
    groundingUsage.day = today;
    groundingUsage.count = 0;
    groundingUsage.alerted = false;
  }
  groundingUsage.count += count;

  const threshold = GEMINI_GROUNDING_FREE_RPD * GROUNDING_ALERT_FRACTION;
  if (groundingUsage.alerted || groundingUsage.count < threshold) return;
  groundingUsage.alerted = true;

  const priced = GROUNDED_SEARCH_COST_PER_REQUEST_USD > 0;
  console.warn(
    `💰 costTracker: ${groundingUsage.count} grounded requests today in THIS process ` +
    `(${Math.round(GROUNDING_ALERT_FRACTION * 100)}% of the ${GEMINI_GROUNDING_FREE_RPD}/day free allowance)` +
    (priced ? ' — surcharge already priced.' : ' — grounded calls are ledgering $0; set GEMINI_GROUNDING_COST_USD=0.035 if the allowance is exhausted.')
  );
  if (priced) return;
  // notifyAsync is fire-and-forget internally and returns undefined — do NOT
  // chain .catch() onto it (same contract as the unmapped-model alert below).
  alerts.notifyAsync({
    level: 'warn',
    title: 'Grounded search volume is approaching Google\'s free daily allowance',
    key: `costtracker-grounding-allowance:${today}`,
    fields: {
      groundedRequestsThisProcessToday: groundingUsage.count,
      freeAllowancePerDay: GEMINI_GROUNDING_FREE_RPD,
      note: 'This count is per-process; the project-wide total is higher. Past the ' +
            'allowance Google bills $35/1,000 grounded prompts and the ledger is ' +
            'recording $0 for them. Set GEMINI_GROUNDING_COST_USD=0.035 to price them.'
    }
  });
}

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
  const { costUsd, inputTokens, outputTokens, cachedInputTokens, rateFound } =
    computeCost(meta.model, usage, meta.visionImages || 0, meta.groundedRequests || 0);

  // Track free-allowance consumption for the alert. Counted on the SUCCESS path
  // only: the error path above returns before here, and a grounded call that
  // never produced a response is the one case where we cannot say whether
  // Google counted it against the allowance. Under-counting here delays the
  // warning slightly; over-counting would cry wolf on every timeout.
  noteGroundedRequests(meta.groundedRequests || 0);

  await persistCost({
    ...meta,
    inputTokens, outputTokens, cachedInputTokens,
    visionImages: meta.visionImages || 0,
    groundedRequests: meta.groundedRequests || 0,
    costUsd,
    // rateFound===false means MODEL_RATES has no entry for this model — the
    // token-cost component (almost always the dominant part of an LLM call)
    // was NOT computed, not computed-as-zero. That is a materially different
    // claim from 'estimated' (a real, if imprecise, guess) and from 'none'
    // (confirmed nothing was charged) — a genuinely billed call must never be
    // silently folded into either. See computeCost() / models/CostLog.js.
    costSource: rateFound === false ? 'unknown' : meta.costSource,
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
 * Deliberately narrow: only ever upgrades 'estimated' -> `costSource` (default
 * 'actual'). It will not touch a row already marked actual/none/unknown, so a
 * late duplicate call cannot corrupt a good figure, and it never creates a row
 * (a missing row means the write failed and inventing one here would hide that).
 *
 * `costSource` is an explicit override, not a free-form string — pass 'none'
 * to settle a CONFIRMED-unbilled prediction to $0 (the same "estimated ->
 * confirmed-zero" transition atlasVideoService.resolveFailureCostReconcile /
 * bootRecoveryService already perform inline for the live failure path; this
 * lets scripts/backfillCostReconcile.js reuse the identical guarded update
 * for HISTORICAL rows instead of re-implementing the atomic filter). Callers
 * that omit it get the original 'actual' behaviour, byte-for-byte.
 */
async function reconcileCost({ providerRequestId, costUsd, costSource = 'actual' }) {
  if (!providerRequestId || !Number.isFinite(Number(costUsd))) return false;
  if (!CostLog.COST_SOURCES.includes(costSource)) return false;
  try {
    const res = await CostLog.updateOne(
      { providerRequestId, costSource: 'estimated' },
      { $set: { costUsd: Number(costUsd), costSource } }
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    if (n) console.log(`   💲 cost reconciled ${providerRequestId} -> $${Number(costUsd).toFixed(6)} (${costSource})`);
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
  // durationMs is set ONLY when the caller supplies one. It used to be written
  // unconditionally as `meta.durationMs ?? null`, which meant any caller that
  // finalizes a row for a different reason — the video cost reconcile, which
  // knows the settled price but nothing about how long the submit took —
  // silently ERASED the duration the charge-point write had already recorded.
  // Absent must mean "leave what is there", not "null it".
  const set = {
    status,
    costUsd:      Number(meta.costUsd) || 0,
    costSource:   meta.costSource || 'estimated',
    errorMessage: meta.errorMessage || null
  };
  if (meta.durationMs !== undefined) set.durationMs = meta.durationMs;
  try {
    await CostLog.updateOne(
      { providerRequestId: id },
      { $set: set },
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
      console.warn(`💰 costTracker: no rate for model '${model}' — token cost UNKNOWN, not $0 (add it to MODEL_RATES)`);
      // Loud, not just a console line that scrolls away: this is a live blind
      // spot in the ledger (a real, billed call with no dollar figure), not a
      // one-off warning. Deduped by the SAME warnedUnknownModels gate as the
      // console.warn above, so a hot path can't page-storm on every call.
      // notifyAsync is already fire-and-forget internally (Promise.resolve()
      // .then(...).catch(()=>{})) and returns undefined, not a promise — do
      // NOT chain .catch() onto it here.
      alerts.notifyAsync({
        level: 'warn',
        title: 'CostLog: unmapped model — token cost is UNKNOWN, not zero',
        key: `costtracker-unknown-model:${model}`,
        fields: { model, note: 'add a MODEL_RATES entry in services/costTracker.js' }
      });
    }
    // rateFound:false is the caller's signal to stamp costSource:'unknown'
    // rather than 'estimated' — a near-zero number here (surcharges only,
    // e.g. exactly $0.0050 for one vision reference image) previously looked
    // like a real, if small, estimate. It is not: the entire per-token
    // component — almost always the dominant part of an LLM call's cost —
    // is silently missing. Surcharges (vision/grounding) are still counted;
    // they are flat, known amounts independent of the per-token rate table.
    return {
      costUsd: Number(surcharges.toFixed(6)),
      inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cached,
      rateFound: false
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
    cachedInputTokens: usage.cached || 0,
    rateFound: true
  };
}

/**
 * TRUE cost for one CampaignRun, aggregated directly from CostLog instead of
 * reconstructed from a time window (the only option before campaignRunId was
 * populated at the write sites — see CLAUDE.md §2 / session.md 2026-08-19).
 *
 * Returns totals split by costSource so a caller can see how much of the
 * figure is settled (`actual`) vs a pre-settlement estimate (`estimated`) vs
 * a real billed call we cannot even estimate (`unknown` — no MODEL_RATES
 * entry; see models/CostLog.js) — collapsing any of these into one number
 * would hide exactly the gap this function exists to surface. `none` rows
 * (rejections, refunded failures) are counted separately and contribute $0 to
 * `totalUsd` (their costUsd is always 0 by construction, unlike `unknown`
 * rows, whose costUsd can be a nonzero surcharge-only figure).
 *
 * Coverage caveat, stated rather than hidden: only rows written AFTER the
 * campaignRunId threading (2026-08-19) carry it. A run from before that date
 * returns real but INCOMPLETE totals (whatever subset of its rows happen to
 * have campaignRunId — normally none), not a false zero; there is no
 * historical backfill here, since the run id was simply never recorded.
 *
 * @param {string} campaignRunId  CampaignRun.runId (the string id, e.g.
 *   "run_1787119100250_eef4d871") — NOT a Mongo _id. Matches what every
 *   producer already holds; see the CostLog.campaignRunId schema comment.
 * @returns {Promise<{
 *   campaignRunId: string, rows: number,
 *   totalUsd: number, actualUsd: number, estimatedUsd: number, unknownUsd: number,
 *   byStage: Array<{stage:string, model:string, n:number, usd:number, costSource:string}>
 * }>}
 */
async function costForRun(campaignRunId) {
  const out = {
    campaignRunId, rows: 0,
    totalUsd: 0, actualUsd: 0, estimatedUsd: 0, unknownUsd: 0,
    byStage: []
  };
  if (!campaignRunId) return out;
  const rows = await CostLog.find({ campaignRunId })
    .select('stage model costUsd costSource status')
    .lean();
  out.rows = rows.length;
  const byKey = new Map();
  for (const r of rows) {
    const usd = Number(r.costUsd) || 0;
    out.totalUsd += usd;
    if (r.costSource === 'actual') out.actualUsd += usd;
    else if (r.costSource === 'estimated') out.estimatedUsd += usd;
    // 'unknown' rows carry real spend (a billed call happened) but no usable
    // per-token estimate — surfaced on its OWN line, never folded into
    // estimatedUsd, so a caller cannot mistake a MODEL_RATES gap for a
    // normal pre-settlement estimate. See costSource comment on
    // models/CostLog.js.
    else if (r.costSource === 'unknown') out.unknownUsd += usd;
    const key = `${r.stage || 'unknown'}::${r.model || 'unknown'}::${r.costSource || 'unknown'}`;
    const entry = byKey.get(key) || { stage: r.stage || 'unknown', model: r.model || 'unknown', costSource: r.costSource || 'unknown', n: 0, usd: 0 };
    entry.n++;
    entry.usd += usd;
    byKey.set(key, entry);
  }
  out.totalUsd     = Number(out.totalUsd.toFixed(6));
  out.actualUsd    = Number(out.actualUsd.toFixed(6));
  out.estimatedUsd = Number(out.estimatedUsd.toFixed(6));
  out.unknownUsd   = Number(out.unknownUsd.toFixed(6));
  out.byStage = [...byKey.values()]
    .map((e) => ({ ...e, usd: Number(e.usd.toFixed(6)) }))
    .sort((a, b) => b.usd - a.usd);
  return out;
}

module.exports = {
  trackLlmCall,
  recordCacheHit,
  recordFlatCost,
  finalizeFlatCost,
  reconcileCost,
  costForRun,
  MODEL_RATES,
  VISION_IMAGE_COST_PER_IMAGE_USD,
  GROUNDED_SEARCH_COST_PER_REQUEST_USD,
  GEMINI_GROUNDING_FREE_RPD
};
