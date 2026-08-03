// POST /api/agent/chat — SSE-streaming conversational agent.
//
// Replaces the buffered endpoint from PR #1. Same tool loop, same
// registry, same dispatch — but the response is text/event-stream so
// the frontend chat drawer sees tokens + tool calls + results as they
// happen instead of one blob at the end.
//
// EVENT VOCABULARY (client-facing contract — DO NOT change silently):
//   event: assistant-delta      data: { text }
//   event: tool-use-start       data: { toolCallId, toolName }
//   event: tool-use-complete    data: { toolCallId, toolName, args }
//   event: tool-result          data: { toolCallId, result }
//   event: iteration            data: { n }
//   event: done                 data: { stop_reason, iterations, model }
//   event: error                data: { error }
//
// Each frame is `event: <name>\ndata: <json>\n\n`. Client hooks with
// EventSource.addEventListener('assistant-delta', …) etc.
//
// STATELESS per-request: the client holds the full message history
// and resends it every turn. Server holds no chat state.
//
// CLIENT DISCONNECT: an AbortController is wired to req.on('close') so
// an abandoned tab aborts the in-flight LLM call and stops the tool
// loop — no wasted tokens, no dangling dispatches.

'use strict';

const express = require('express');
const router = express.Router();

const registry = require('../services/capabilityRegistry');
const agentTools = require('../services/agentTools');
const { streamChatCompletion } = require('../services/atlasLlmStreamService');

// ── Tunables ────────────────────────────────────────────────────────

const AGENT_MODEL = process.env.AGENT_MODEL || 'gemini-2.5-flash';
const MAX_ITERATIONS = Math.max(1, Number(process.env.AGENT_MAX_ITERATIONS || 8));
const MAX_MESSAGES = Math.max(2, Number(process.env.AGENT_MAX_MESSAGES || 40));
const MAX_TOKENS_PER_CALL = Math.max(256, Number(process.env.AGENT_MAX_TOKENS || 2048));
const TEMPERATURE = Number.isFinite(Number(process.env.AGENT_TEMPERATURE))
  ? Number(process.env.AGENT_TEMPERATURE)
  : 0.2;

// ── System prompt ───────────────────────────────────────────────────

function buildSystemPrompt(context = {}) {
  const contextLines = Object.entries(context)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `  ${k} = ${v}`)
    .join('\n');
  return [
    'You are the Reach Social operator assistant. You help operators inspect their catalog, ads, and spend, and (in later versions) initiate generation and publishing workflows.',
    '',
    'HOW TO OPERATE:',
    '- Route the operator\'s request to the RIGHT capability, then answer using the capability\'s result.',
    '- Never invent data. If no capability fits, say so plainly.',
    '- Prefer ONE capability call per turn. Chain only when strictly needed (e.g. list → inspect).',
    '- Every capability enforces its own tenant scope. Don\'t pass a brandId / adId the operator hasn\'t already selected unless they explicitly named it.',
    '',
    'RISK TIERS (visible in the tool description as `[tier=N, scope=…]`):',
    '- tier 0: read-only, safe to run without asking.',
    '- tier 1: cheap write; ASK the operator to confirm before running.',
    '- tier 2: billable write; ASK + estimate the cost before running.',
    '- tier 3: external / hard-to-reverse; ASK with explicit "type YES to confirm".',
    '- tier 4: multi-step workflow; propose a plan first.',
    'This build ships tier-0 capabilities only. If the operator asks for something that would need a higher tier, name that clearly rather than pretending you can\'t help.',
    '',
    `AVAILABLE CAPABILITIES (${registry.CAPABILITIES.length}):`,
    registry.describeManifest(),
    '',
    contextLines
      ? `CURRENT UI CONTEXT (the operator has these selected — capabilities that need one of these IDs will use it as a default):\n${contextLines}`
      : 'CURRENT UI CONTEXT: nothing selected.',
    '',
    'When you finish, produce a concise plain-text answer for the operator. Do not restate the raw JSON — summarise the finding. If a capability failed (ok:false), tell the operator what went wrong and what they can try.'
  ].join('\n');
}

// ── Request validation (unchanged from PR #1) ──────────────────────

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (!Array.isArray(body.messages)) return 'messages[] required';
  if (body.messages.length === 0) return 'messages[] cannot be empty';
  if (body.messages.length > MAX_MESSAGES) return `messages[] exceeds cap ${MAX_MESSAGES}`;
  for (const [i, m] of body.messages.entries()) {
    if (!m || typeof m !== 'object') return `messages[${i}] not an object`;
    if (!['user', 'assistant', 'tool', 'system'].includes(m.role)) {
      return `messages[${i}].role must be user|assistant|tool|system`;
    }
    if (typeof m.content !== 'string' && !Array.isArray(m.content) && m.content !== null) {
      return `messages[${i}].content must be string, array, or null`;
    }
  }
  if (body.context != null && typeof body.context !== 'object') return 'context must be an object';
  return null;
}

const CONTEXT_KEYS = ['brandId', 'adId', 'campaignId', 'productId'];
function sanitiseContext(raw = {}) {
  const out = {};
  for (const k of CONTEXT_KEYS) {
    const v = raw?.[k];
    if (typeof v === 'string' && v.length > 0 && v.length < 100) out[k] = v;
  }
  return out;
}

// ── SSE writer ──────────────────────────────────────────────────────

// Named-event SSE framing. Not enough boilerplate to justify a lib —
// two lines per event, no framing state on the server side.
function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Node's res.write returns true unless the internal buffer overflows;
  // caller doesn't need it here since events are small and infrequent.
  return true;
}

// ── Tool-call accumulator ───────────────────────────────────────────
//
// Streaming providers ship tool calls incrementally:
//   chunk 1: [{ index:0, id:'call_1', function:{ name:'foo', arguments:'' } }]
//   chunk 2: [{ index:0, function:{ arguments:'{"a"' } }]
//   chunk 3: [{ index:0, function:{ arguments:':1}' } }]
// Concatenate `arguments` string by index; id + name come only on the
// first fragment for that index. finish_reason:'tool_calls' signals
// the args are complete and safe to JSON.parse.

function accumulateToolCallDelta(pending, deltaCalls) {
  const started = [];   // indices that just got id+name (client should see tool-use-start)
  for (const d of deltaCalls || []) {
    if (d.index == null) continue;
    let slot = pending.get(d.index);
    if (!slot) {
      slot = { id: null, name: null, argsBuffer: '' };
      pending.set(d.index, slot);
    }
    const wasStarted = slot.id && slot.name;
    if (d.id)                        slot.id   = d.id;
    if (d.function?.name)            slot.name = d.function.name;
    if (typeof d.function?.arguments === 'string') slot.argsBuffer += d.function.arguments;
    if (!wasStarted && slot.id && slot.name) started.push(d.index);
  }
  return started;
}

// ── The endpoint ────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  if (!isEnabled()) {
    return res.status(503).json({ error: 'agent disabled (AGENT_ENABLED=false)' });
  }
  const problem = validateBody(req.body);
  if (problem) return res.status(400).json({ error: problem });

  // SSE headers must precede any write. Flush headers immediately so
  // the client's EventSource sees the connection open — some proxies
  // otherwise buffer the response until the first body byte.
  res.status(200).set({
    'Content-Type':       'text/event-stream; charset=utf-8',
    'Cache-Control':      'no-cache, no-transform',
    Connection:           'keep-alive',
    'X-Accel-Buffering':  'no'   // hint to nginx-style proxies
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Client-disconnect abort. AbortController -> passed into
  // streamChatCompletion so the upstream axios request is cancelled.
  // `aborted` also short-circuits the tool loop.
  const abort = new AbortController();
  let aborted = false;
  req.on('close', () => {
    if (!aborted) {
      aborted = true;
      abort.abort();
    }
  });

  const context = sanitiseContext(req.body.context);
  const clientMessages = req.body.messages.filter((m) => m.role !== 'system');
  const system = buildSystemPrompt(context);
  const tools = registry.capabilitiesToTools();

  const meta = {
    stage:      'agent-chat',
    service:    'agent-chat',
    purposeTag: 'agent',
    brandId:    context.brandId || null
  };

  const working = [{ role: 'system', content: system }, ...clientMessages];
  let stopReason = 'end_turn';
  let iterations = 0;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (aborted) { stopReason = 'aborted'; break; }
      iterations++;
      sseWrite(res, 'iteration', { n: iter });

      // Per-iteration accumulators. Tool-call args stream across many
      // chunks; we assemble here and dispatch after finish_reason.
      const pendingCalls = new Map();   // index → { id, name, argsBuffer }
      let assistantContent = '';
      let finishReason = null;

      try {
        for await (const chunk of streamChatCompletion(meta, {
          model:       AGENT_MODEL,
          messages:    working,
          tools,
          tool_choice: 'auto',
          temperature: TEMPERATURE,
          max_tokens:  MAX_TOKENS_PER_CALL
        }, { signal: abort.signal })) {
          if (aborted) break;
          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (typeof choice.delta?.content === 'string' && choice.delta.content.length) {
            assistantContent += choice.delta.content;
            sseWrite(res, 'assistant-delta', { text: choice.delta.content });
          }
          if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length) {
            const started = accumulateToolCallDelta(pendingCalls, choice.delta.tool_calls);
            for (const idx of started) {
              const slot = pendingCalls.get(idx);
              sseWrite(res, 'tool-use-start', {
                toolCallId: slot.id,
                toolName:   slot.name
              });
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      } catch (streamErr) {
        if (aborted) { stopReason = 'aborted'; break; }
        throw streamErr;
      }

      // Record the assistant turn in history — content + assembled
      // tool_calls, matching the shape the LLM expects on the next turn.
      const assembledToolCalls = [...pendingCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, s]) => ({
          id:       s.id,
          type:     'function',
          function: { name: s.name, arguments: s.argsBuffer || '' }
        }));
      const assistantMsg = { role: 'assistant', content: assistantContent || null };
      if (assembledToolCalls.length) assistantMsg.tool_calls = assembledToolCalls;
      working.push(assistantMsg);

      // No tool calls → the assistant's message IS the answer, we're done.
      if (!assembledToolCalls.length) {
        stopReason = finishReason === 'length' ? 'length' : 'end_turn';
        break;
      }

      // Dispatch each tool call. Errors surface as ok:false results so
      // the model can respond gracefully next turn.
      for (const call of assembledToolCalls) {
        if (aborted) break;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          args = { _parseError: err.message, _raw: call.function.arguments };
        }
        sseWrite(res, 'tool-use-complete', {
          toolCallId: call.id,
          toolName:   call.function.name,
          args
        });
        const result = await agentTools.dispatch({
          toolName: call.function.name,
          args,
          req,
          context
        });
        sseWrite(res, 'tool-result', {
          toolCallId: call.id,
          result
        });
        working.push({
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(result)
        });
      }

      if (iter === MAX_ITERATIONS - 1) {
        stopReason = 'max_iterations';
      }
    }

    sseWrite(res, 'done', { stop_reason: stopReason, iterations, model: AGENT_MODEL });
  } catch (err) {
    console.error(`❌ agent chat: ${err.message}`);
    sseWrite(res, 'error', { error: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

function isEnabled() {
  return String(process.env.AGENT_ENABLED || '').toLowerCase() === 'true';
}
router.isEnabled = isEnabled;

module.exports = router;
