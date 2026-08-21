// Atlas Cloud text generation. Atlas exposes an OpenAI-compatible
// /chat/completions endpoint, so this is a thin axios wrapper around
// it. Used to reach Claude for tasks like brand-canvas-script
// generation without needing an Anthropic account or a second SDK.
//
// Auth: ATLAS_API_KEY (same key as the video path).
// Model: ATLAS_TEXT_MODEL_ID (defaults to anthropic/claude-sonnet-4-5).
// Base:  ATLAS_BASE_URL (defaults to https://api.atlascloud.ai/api/v1).

const axios = require('axios');
const { rejectsSamplingParams, stripSamplingParams } = require('./atlasModelMap');
// ONE shared LLM error taxonomy — services/llmError.js. Imported, not copied.
const {
  LLM_ERROR_CODES, LLM_ACTIONS, classifyLlmFailure, makeLlmError,
  extractRequestId, formatLlmLogLine, stampLlmAction,
} = require('./llmError');

// Text uses /v1 (no /api prefix). Video endpoints live under /api/v1,
// so ATLAS_BASE_URL (which the video service uses) is wrong for chat
// completions. ATLAS_TEXT_BASE_URL overrides this per-service.
const BASE_URL = process.env.ATLAS_TEXT_BASE_URL || 'https://api.atlascloud.ai/v1';
// Default to the latest Claude Sonnet on Atlas. Override via
// ATLAS_TEXT_MODEL_ID (e.g. anthropic/claude-opus-4.7) when a task
// needs bigger context or more reasoning.
const DEFAULT_MODEL = process.env.ATLAS_TEXT_MODEL_ID || 'anthropic/claude-sonnet-4.6';

const HTTP_TIMEOUT_MS = 5 * 60 * 1000; // Claude script gen can run 30-90s.

// This service posts to Atlas directly rather than through
// atlasLlmService.buildAtlasBody, so it needs its own copy of the Claude 5
// sampling-param guard — see atlasModelMap.rejectsSamplingParams for the live
// probe and the static-ad outage a missing strip caused. DEFAULT_MODEL is a
// 4.x slug today (temperature accepted), but this service exists to be
// repointed via ATLAS_TEXT_MODEL_ID, and a Claude 5 value there would 400
// every call. Exported for the verify harness.
function buildTextBody({ model, messages, temperature, maxTokens }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (rejectsSamplingParams(model)) stripSamplingParams(body);
  return body;
}

function apiKey() {
  const k = process.env.ATLAS_API_KEY;
  if (!k) {
    // AUTH_MISSING is its own code: nothing was sent, nothing was billed, and
    // the fix is configuration — not a retry and not a key rotation.
    throw makeLlmError({
      code: LLM_ERROR_CODES.LLM_AUTH_MISSING,
      provider: 'atlas',
      providerMessage: 'ATLAS_API_KEY is not set — cannot call Atlas Cloud',
      action: LLM_ACTIONS.SKIPPED_NO_KEY,
      actionDetail: 'skipped without attempting — set ATLAS_API_KEY on this service',
    });
  }
  return k;
}

// Retry policy for transient Atlas failures. Atlas's gateway 504s
// on long-running requests (~120s cap observed empirically); a fresh
// attempt usually succeeds because Claude finishes faster once the
// prompt is cached upstream. Also covers 503 (upstream unavailable)
// and pure network errors (ECONNRESET, ETIMEDOUT). 400/401/403/404
// are surfaced without retry — those are real problems the caller
// needs to see.
const RETRY_STATUS = new Set([502, 503, 504]);
const RETRY_CODES  = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN']);
const MAX_ATTEMPTS = 3;

function shouldRetry(err) {
  const status = err.response?.status;
  if (status && RETRY_STATUS.has(status)) return true;
  if (!err.response && RETRY_CODES.has(err.code)) return true;
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Single-shot chat completion. Returns the assistant message text.
// Non-streaming for simplicity; add a streaming variant later if the
// caller UX warrants it. Auto-retries on 5xx / network errors up to
// MAX_ATTEMPTS with exponential backoff.
async function generate({
  system,
  user,
  model = DEFAULT_MODEL,
  temperature = 0.4,
  maxTokens = 4096
}) {
  const messages = [];
  if (system) messages.push({ role: 'system',    content: system });
  if (user)   messages.push({ role: 'user',      content: user   });

  const url = `${BASE_URL}/chat/completions`;
  const promptChars = (system?.length || 0) + (user?.length || 0);
  console.log(`🧠 atlasText: POST ${url} model=${model} promptChars=${promptChars} maxTokens=${maxTokens}`);

  let res;
  let lastErr;
  const totalT0 = Date.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      res = await axios.post(
        url,
        buildTextBody({ model, messages, temperature, maxTokens }),
        {
          headers: {
            Authorization: `Bearer ${apiKey()}`,
            'content-type': 'application/json'
          },
          timeout: HTTP_TIMEOUT_MS
        }
      );
      lastErr = null;
      break;
    } catch (err) {
      const ms = Date.now() - t0;
      const status = err.response?.status;
      const body   = err.response?.data;
      const bodyStr = typeof body === 'string'
        ? body.slice(0, 500)
        : body != null ? JSON.stringify(body).slice(0, 500) : '(no body)';
      // Already coded (apiKey() above) — never re-wrap, or the AUTH_MISSING
      // diagnosis degrades into an unclassified transport failure.
      const coded = err && err.llmError ? err : makeLlmError({
        code: classifyLlmFailure({
          httpStatus: status, errCode: err.code, message: err.message, body,
        }),
        provider: 'atlas', model, role: model,
        httpStatus: status == null ? null : status,
        requestId: extractRequestId(body, err.response?.headers),
        elapsedMs: ms, attempt, attemptsMax: MAX_ATTEMPTS,
        providerMessage: bodyStr,
        cause: err,
      });
      lastErr = coded;
      if (attempt < MAX_ATTEMPTS && shouldRetry(err)) {
        const backoffMs = 3000 * attempt; // 3s, 6s
        stampLlmAction(coded, LLM_ACTIONS.RETRIED_SAME_MODEL,
          `retrying the same model in ${backoffMs}ms (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
        console.warn(formatLlmLogLine(coded));
        await sleep(backoffMs);
        continue;
      }
      stampLlmAction(coded, LLM_ACTIONS.EXHAUSTED_CHAIN,
        `gave up after ${attempt} of ${MAX_ATTEMPTS} attempts — this transport has no fallback link`);
      console.error(formatLlmLogLine(coded));
      throw coded;
    }
  }
  if (!res) throw lastErr || new Error('atlasText: exhausted retries with no response');
  const ms = Date.now() - totalT0;

  const choice = res.data?.choices?.[0];
  const text   = choice?.message?.content;
  const outputChars = text?.length || 0;
  console.log(`🧠 atlasText: OK in ${ms}ms outputChars=${outputChars} finishReason=${choice?.finish_reason || '?'} model=${res.data?.model || '?'}`);
  if (!text) {
    // HTTP 200 with nothing usable: tokens were generated and BILLED, which
    // is why this is a CONTENT code and not a transport one. Commonly hidden
    // reasoning eating max_tokens (finish_reason 'length').
    throw makeLlmError({
      code: LLM_ERROR_CODES.LLM_CONTENT_EMPTY,
      provider: 'atlas', model: res.data?.model || model, role: model,
      httpStatus: 200, elapsedMs: ms,
      providerMessage: `finish_reason=${choice?.finish_reason || '?'} head=${JSON.stringify(res.data).slice(0, 300)}`,
      action: LLM_ACTIONS.EXHAUSTED_CHAIN,
      actionDetail: 'gave up — a 200 with no content is not retried here; raise the token budget',
    });
  }
  return {
    text,
    model:        res.data?.model || model,
    usage:        res.data?.usage || null,
    finishReason: choice?.finish_reason || null
  };
}

// buildTextBody exposed for the verify harness (Claude 5 sampling strip).
module.exports = { generate, DEFAULT_MODEL, buildTextBody };
