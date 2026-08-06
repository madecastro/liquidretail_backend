// Shared Atlas Cloud LLM client — the single chat-completions transport
// for every service that used to hold its own `new OpenAI(...)` or raw
// Gemini call. OpenAI-compatible request/response shape end to end, so
// call sites keep reading `choices[0].message.content`.
//
//   PRIMARY:  https://api.atlascloud.ai/v1/chat/completions (ATLAS_API_KEY)
//   FALLBACK: the original direct provider with the ORIGINAL model
//             (operator directive: keep fallbacks with direct providers).
//             openai → api.openai.com (OPENAI_API_KEY)
//             google → generativelanguage.googleapis.com's OpenAI-compat
//                      endpoint (GEMINI_API_KEY)
//             Fallback fires on network errors / 5xx / 429-exhausted /
//             Atlas "router not found" — never on request-validation 4xx
//             (those would just fail twice).
//
// Reasoning-token headroom: the routable gpt-5.6 line and gemini-2.5
// spend hidden reasoning tokens out of max_tokens (verified live —
// finish_reason 'length' with an empty message at small budgets). The
// wrapper adds reasoning_effort:'low' for openai/* slugs (accepted by
// the gateway) and pads max_tokens with RESERVE headroom so JSON outputs
// aren't truncated mid-object. Fallback requests strip gateway-only
// params and restore the caller's original max_tokens.
//
// Every call is logged through costTracker.trackLlmCall with the
// provider that actually served it.

'use strict';

const axios = require('axios');
const { trackLlmCall } = require('./costTracker');
const { resolveModel } = require('./atlasModelMap');

const ATLAS_CHAT_URL = (process.env.ATLAS_TEXT_BASE_URL || 'https://api.atlascloud.ai/v1') + '/chat/completions';
const DIRECT_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};
const DIRECT_KEYS = {
  openai: () => process.env.OPENAI_API_KEY,
  google: () => process.env.GEMINI_API_KEY,
};

const MAX_ATTEMPTS = Number(process.env.ATLAS_LLM_MAX_ATTEMPTS || 3);
const BACKOFF_MS = Number(process.env.ATLAS_LLM_BACKOFF_MS || 3000);
const TIMEOUT_MS = Number(process.env.ATLAS_LLM_TIMEOUT_MS || 120_000);
// Hidden-reasoning headroom added to caller max_tokens on Atlas requests.
const REASONING_RESERVE_TOKENS = Number(process.env.ATLAS_REASONING_RESERVE_TOKENS || 768);

// Shared output-token ceiling applied to every Atlas chat body.
//
// Raised 16384 → 30000 (2026-08-06). SHARED raise (not per-model) because:
//   1. Math.min(ceiling, requested) leaves every lower caller budget
//      byte-identical — only a request > ceiling is affected.
//   2. Highest intentional caller today is DIRECTOR_ROUND_TOKENS=30000
//      (aiCreativeDirectorService). No other role requests > 16384
//      (canvas HTML gen tops out at 12000; everything else is lower).
//   3. Live probe 2026-08-06: anthropic/claude-sonnet-5 accepted
//      max_tokens up to 100000 via Atlas (HTTP 200); catalog schema URL
//      404s so the catalog is not the source of truth here.
// A future caller that requests >> 30000 against a model with a lower
// real ceiling would still need its own gate — this clamp is a safety
// rail, not a per-model capability map.
const ATLAS_MAX_OUTPUT_TOKENS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConfigured() {
  return !!process.env.ATLAS_API_KEY;
}

function retryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || status >= 500;
}

function retryableError(err) {
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(err.code);
}

// Atlas signals a listed-but-unrouted model with a 400 "router not found".
function atlasRouterMissing(res) {
  return res.status === 400 && /router not found/i.test(JSON.stringify(res.data || {}));
}

async function post(url, key, body) {
  return axios.post(url, body, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
}

function buildAtlasBody(params, atlasId) {
  const body = { ...params, model: atlasId };
  if (/^openai\//.test(atlasId) && body.reasoning_effort === undefined) {
    body.reasoning_effort = 'low';
  }
  if (body.max_tokens != null) {
    // Clamp the caller's budget, then ALWAYS add the full reserve on top —
    // a combined clamp could silently swallow the reserve at high caller
    // budgets and reintroduce the mid-JSON truncation it exists to prevent.
    body.max_tokens = Math.min(ATLAS_MAX_OUTPUT_TOKENS, body.max_tokens) + REASONING_RESERVE_TOKENS;
  }
  return body;
}

function buildDirectBody(params, direct) {
  // Original model, original budget; gateway-only params stripped.
  const { reasoning_effort, ...rest } = params;
  return { ...rest, model: direct.model };
}

/**
 * chatCompletion(meta, params) → OpenAI-shape response body.
 *   meta:   { service, purpose, visionImages? } for the cost ledger.
 *   params: standard chat.completions body with the LEGACY model id
 *           (e.g. 'gpt-4.1', 'gemini-2.5-flash') — mapped internally.
 * Throws the last error when Atlas AND the fallback both fail.
 */
async function chatCompletion(meta, params) {
  if (!params?.model) throw new Error('atlasLlm.chatCompletion: params.model required');
  const { atlas, direct } = resolveModel(params.model);

  // ── Atlas primary ──
  let lastErr = null;
  if (isConfigured()) {
    const body = buildAtlasBody(params, atlas);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await trackLlmCall(
          // Caller ledger fields (stage, brandId, purposeTag, cacheKey, …)
          // pass through; provider/model are authoritative here.
          { ...meta, provider: 'atlas', model: atlas },
          async () => {
            const r = await post(ATLAS_CHAT_URL, process.env.ATLAS_API_KEY, body);
            if (r.status !== 200) {
              const e = new Error(`Atlas ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
              e.status = r.status;
              e.routerMissing = atlasRouterMissing(r);
              throw e;
            }
            return r.data;
          }
        );
        return res;
      } catch (err) {
        lastErr = err;
        // Listed-but-unrouted model — retrying won't help; fallback might.
        if (err.routerMissing) break;
        // 400/422 included: the Atlas body is NOT the direct body (mapped
        // model, reasoning_effort, padded max_tokens), so a gateway-side
        // validation error doesn't prove the original request is bad —
        // stop retrying Atlas but still give the direct fallback its shot
        // with the caller's original params. A truly malformed request
        // costs one extra round trip and then fails honestly.
        if (err.status && !retryableStatus(err.status)) break;
        if (!err.status && !retryableError(err) && !/timeout/i.test(err.message)) break;
        if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
      }
    }
  } else {
    lastErr = new Error('ATLAS_API_KEY not configured');
  }

  // ── Direct-provider fallback ──
  const directKey = direct && DIRECT_KEYS[direct.provider]?.();
  if (!direct || !directKey) throw lastErr;
  console.warn(`🌐 atlasLlm: falling back to direct ${direct.provider}/${direct.model} for ${meta.service || '?'} (${lastErr.message.slice(0, 120)})`);
  return trackLlmCall(
    { ...meta, provider: direct.provider === 'google' ? 'google-openai' : 'openai', model: direct.model, purpose: (meta.purpose || meta.purposeTag || '') + ':direct-fallback' },
    async () => {
      const r = await post(DIRECT_URLS[direct.provider], directKey, buildDirectBody(params, direct));
      if (r.status !== 200) throw new Error(`direct ${direct.provider} ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
      return r.data;
    }
  );
}

module.exports = {
  chatCompletion,
  isConfigured,
  resolveModel,
  // exposed for verify harnesses (token ceiling + reserve)
  buildAtlasBody,
  REASONING_RESERVE_TOKENS,
  ATLAS_MAX_OUTPUT_TOKENS
};
