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
  if (!k) throw new Error('ATLAS_API_KEY is not set — cannot call Atlas Cloud');
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
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && shouldRetry(err)) {
        const backoffMs = 3000 * attempt; // 3s, 6s
        console.warn(`⚠️  atlasText: attempt ${attempt}/${MAX_ATTEMPTS} FAILED in ${ms}ms status=${status || 'network'} code=${err.code || '?'} — retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
      console.error(`❌ atlasText: FAILED (final attempt ${attempt}/${MAX_ATTEMPTS}) in ${ms}ms status=${status || 'network'} code=${err.code || '?'} body=${bodyStr}`);
      throw err;
    }
  }
  if (!res) throw lastErr || new Error('atlasText: exhausted retries with no response');
  const ms = Date.now() - totalT0;

  const choice = res.data?.choices?.[0];
  const text   = choice?.message?.content;
  const outputChars = text?.length || 0;
  console.log(`🧠 atlasText: OK in ${ms}ms outputChars=${outputChars} finishReason=${choice?.finish_reason || '?'} model=${res.data?.model || '?'}`);
  if (!text) {
    console.warn(`⚠️  atlasText: empty content — full response head: ${JSON.stringify(res.data).slice(0, 500)}`);
    throw new Error('Atlas returned no message content');
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
