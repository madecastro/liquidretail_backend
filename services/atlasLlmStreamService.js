// Streaming variant of atlasLlmService. Same Atlas Cloud endpoint,
// same auth, same OpenAI-compat body — but with `stream: true` and an
// SSE response parsed into an async generator of delta chunks.
//
// USED BY: routes/agent.js only (as of this PR). Any other caller that
// needs streaming should route through here rather than opening a
// second axios pipe against the same URL — keeps auth/retry/cost
// bookkeeping in one place.
//
// NOT COVERED (deliberately):
//   - Direct-provider fallback. atlasLlmService has it because it is
//     the base transport; this file is the additive streaming path,
//     and duplicating the fallback across two files is where fallbacks
//     silently drift out of sync. If Atlas is down, streaming fails
//     with a clean error and the endpoint surfaces it — the same
//     failure surface every other billable Atlas call has today.
//   - Cost tracking. OpenAI's streaming responses do not include
//     usage in every chunk (only in the last one, and Atlas may
//     omit it entirely). We log a single trackLlmCall row at stream
//     end with whatever usage arrived, or none if none did.
//   - Retries. A retry mid-stream would require replaying the tokens
//     to the client, which we cannot do without buffering them all
//     server-side (defeating the point). Fail cleanly instead.

'use strict';

const axios = require('axios');
const { recordFlatCost, MODEL_RATES } = require('./costTracker');
const { resolveModel } = require('./atlasModelMap');

const ATLAS_CHAT_URL = (process.env.ATLAS_TEXT_BASE_URL || 'https://api.atlascloud.ai/v1') + '/chat/completions';
const TIMEOUT_MS = Number(process.env.ATLAS_LLM_STREAM_TIMEOUT_MS || 120_000);
const REASONING_RESERVE_TOKENS = Number(process.env.ATLAS_REASONING_RESERVE_TOKENS || 768);
// Keep in lockstep with atlasLlmService.ATLAS_MAX_OUTPUT_TOKENS (shared raise
// 16384 → 30000 so DIRECTOR_ROUND_TOKENS=30000 is not silently cut). Stream
// path currently tops out far below this (agent ~2048); the constant exists
// so the two transports cannot drift on the ceiling alone.
const ATLAS_MAX_OUTPUT_TOKENS = 30_000;

function isConfigured() {
  return !!process.env.ATLAS_API_KEY;
}

// Mirrors atlasLlmService.buildAtlasBody but sets stream:true. Kept
// separate so the two transports can drift on stream-only concerns
// (e.g. include_usage: true when the gateway supports it) without a
// shared function guessing which caller wants which shape.
function buildStreamBody(params, atlasId) {
  const body = { ...params, model: atlasId, stream: true };
  if (/^openai\//.test(atlasId) && body.reasoning_effort === undefined) {
    body.reasoning_effort = 'low';
  }
  if (body.max_tokens != null) {
    // Clamp then ALWAYS add full reserve — see atlasLlmService.buildAtlasBody.
    body.max_tokens = Math.min(ATLAS_MAX_OUTPUT_TOKENS, body.max_tokens) + REASONING_RESERVE_TOKENS;
  }
  return body;
}

/**
 * Parse an OpenAI-compat SSE stream into a generator of delta chunks.
 *
 * The wire format is `data: <json>\n\n` per event, terminated by a
 * `data: [DONE]\n\n` sentinel. Everything else (comment lines, event:
 * lines, blank lines) is ignored. Partial chunks across TCP boundaries
 * are handled by holding a rolling buffer between iterations.
 */
async function* parseSSE(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Split on the two-newline event boundary. Keep the trailing
    // fragment in the buffer — it may complete on the next chunk.
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      // Each event may have multiple `data:` lines that concatenate.
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch (err) {
        // A malformed frame is a provider bug, not a caller one —
        // log once and skip so the stream still closes cleanly.
        console.warn(`atlasLlmStream: unparseable SSE frame (${err.message}): ${payload.slice(0, 120)}`);
      }
    }
  }
}

/**
 * Stream a chat completion. Returns an async generator yielding
 * OpenAI-compat delta chunks:
 *   { choices: [{ index, delta: { content?, tool_calls?[], role? }, finish_reason? }] }
 *
 * @param {object} meta       — { service, purposeTag, brandId } for the cost ledger.
 * @param {object} params     — OpenAI-compat chat.completions body (model, messages, tools, …).
 *                              Do NOT set stream:true here — the wrapper sets it.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] — pass through to fetch/axios so a
 *                                       client disconnect aborts the upstream.
 * @yields  delta chunks
 * @throws  when Atlas returns non-200, upstream aborts, or SSE parse fails.
 */
async function* streamChatCompletion(meta, params, opts = {}) {
  if (!isConfigured()) {
    throw new Error('atlasLlmStream: ATLAS_API_KEY not configured');
  }
  if (!params?.model) throw new Error('atlasLlmStream: params.model required');
  if (params.stream === false) throw new Error('atlasLlmStream: params.stream must be true or unset');

  const { atlas } = resolveModel(params.model);
  const body = buildStreamBody(params, atlas);
  const t0 = Date.now();

  // POST with responseType:'stream' returns res.data as a Node Readable.
  // axios throws for network errors; for HTTP errors we inspect status
  // ourselves so we can read the body BEFORE the stream ends.
  let res;
  try {
    res = await axios.post(ATLAS_CHAT_URL, body, {
      headers: {
        Authorization:   `Bearer ${process.env.ATLAS_API_KEY}`,
        'Content-Type':  'application/json',
        Accept:          'text/event-stream'
      },
      responseType:   'stream',
      timeout:        TIMEOUT_MS,
      validateStatus: () => true,
      signal:         opts.signal
    });
  } catch (err) {
    // AbortController.abort() surfaces as ERR_CANCELED (axios) or
    // AbortError (fetch). Distinguish so the caller can silence a
    // deliberate abort without dropping a real network failure.
    if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' || err.name === 'AbortError') {
      const abortErr = new Error('atlasLlmStream: request aborted');
      abortErr.code = 'ABORTED';
      throw abortErr;
    }
    throw err;
  }

  if (res.status !== 200) {
    // The stream never began — read the response body so we return a
    // useful error message rather than "status 400". Bounded read
    // because a 4xx JSON payload is small; we don't want to hang here.
    const chunks = [];
    for await (const c of res.data) {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 4096) break;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    throw new Error(`atlasLlmStream: Atlas ${res.status}: ${text.slice(0, 400)}`);
  }

  // Yield chunks and remember the last-seen usage (some providers ship
  // it on the final chunk; many omit it entirely on streaming). Cost is
  // logged at stream end via recordFlatCost so the row is present even
  // when token counts aren't — a null usage becomes a $0 row tagged
  // 'stream:no-usage', which flags the observability gap without
  // failing the request. Once Atlas exposes usage on streams reliably,
  // this can move to per-token computeCost via a costTracker extension.
  let usage = null;
  let chunkCount = 0;
  try {
    for await (const chunk of parseSSE(res.data)) {
      chunkCount++;
      if (chunk?.usage) usage = chunk.usage;
      yield chunk;
    }
  } catch (err) {
    if (err.code === 'ABORTED' || err.name === 'AbortError') return;
    throw err;
  } finally {
    if (res.data && typeof res.data.destroy === 'function') {
      try { res.data.destroy(); } catch { /* already closed */ }
    }
    const durationMs = Date.now() - t0;
    const costUsd = usage ? estimateCost(atlas, usage) : 0;
    recordFlatCost({
      ...meta,
      provider:     'atlas',
      model:        atlas,
      purposeTag:   (meta.purposeTag ? meta.purposeTag + ':' : '') + (usage ? 'stream' : 'stream:no-usage'),
      inputTokens:  usage?.prompt_tokens || usage?.input_tokens || 0,
      outputTokens: usage?.completion_tokens || usage?.output_tokens || 0,
      costUsd,
      durationMs
    }).catch(() => { /* never fail the request on ledger errors */ });
    if (process.env.AGENT_STREAM_DEBUG) {
      console.log(`atlasLlmStream[${atlas}]: ${chunkCount} chunks in ${durationMs}ms, usage=${JSON.stringify(usage)}, cost=$${costUsd.toFixed(6)}`);
    }
  }
}

// Rough token-based cost estimate. Mirrors costTracker.computeCost's
// shape but stays private here since streaming usage fields vary. When
// the provider omits usage, callers land at $0 which is honest — we
// truly don't know from the stream.
function estimateCost(atlasSlug, usage) {
  const rates = MODEL_RATES[atlasSlug];
  if (!rates) return 0;
  const inTokens  = usage.prompt_tokens || usage.input_tokens || 0;
  const outTokens = usage.completion_tokens || usage.output_tokens || 0;
  return (inTokens * rates.input + outTokens * rates.output) / 1_000_000;
}

module.exports = { streamChatCompletion, isConfigured };
