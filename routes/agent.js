// POST /api/agent/chat — the home-page conversational agent.
//
// Stateless per-request: the client holds the full message history and
// resends it every turn. Server holds no chat state. Simpler ownership,
// no new collection, cross-device chat history handled by client
// localStorage until stateful sessions land in a follow-up PR.
//
// TOOL LOOP shape (OpenAI-compatible via atlasLlmService):
//   1. Build system prompt = role + risk-tier rules + capability
//      manifest + UI-context snapshot.
//   2. Ask the model with tools=[all capabilities].
//   3. If the response carries tool_calls[]: dispatch each via
//      agentTools, append the assistant + tool messages to history,
//      loop back to step 2.
//   4. Otherwise: return the final message.
//   5. Iteration cap (AGENT_MAX_ITERATIONS, default 8) prevents runaway
//      loops if the model keeps calling tools.
//
// PR #1 scope: buffered response (no streaming). Streaming (SSE) lands
// as PR #2 alongside a new atlasLlmStreamService.
//
// GATE: AGENT_ENABLED must be truthy. The route file requires early so
// the mount can be conditional in index.js.

'use strict';

const express = require('express');
const router = express.Router();

const registry = require('../services/capabilityRegistry');
const agentTools = require('../services/agentTools');
const { chatCompletion } = require('../services/atlasLlmService');

// ── Tunables ────────────────────────────────────────────────────────

const AGENT_MODEL = process.env.AGENT_MODEL || 'gemini-2.5-flash';
const MAX_ITERATIONS = Math.max(1, Number(process.env.AGENT_MAX_ITERATIONS || 8));
const MAX_MESSAGES = Math.max(2, Number(process.env.AGENT_MAX_MESSAGES || 40));
const MAX_TOKENS_PER_CALL = Math.max(256, Number(process.env.AGENT_MAX_TOKENS || 2048));
const TEMPERATURE = Number.isFinite(Number(process.env.AGENT_TEMPERATURE))
  ? Number(process.env.AGENT_TEMPERATURE)
  : 0.2;   // low — tool-picking is a routing task, not a creativity task

// ── System prompt ───────────────────────────────────────────────────

// Constant chunks — the manifest changes only when the registry does,
// so keeping them concatenated fresh per request is fine. Prompt
// caching (PR #2) will key on this string.
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
    'This PR ships tier-0 capabilities only. If the operator asks for something that would need a higher tier, name that clearly rather than pretending you can\'t help.',
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

// ── Request validation ──────────────────────────────────────────────

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
    // system messages from the client are ignored below (we build our
    // own), but we still validate their shape rather than silently
    // dropping something structurally broken.
    if (typeof m.content !== 'string' && !Array.isArray(m.content) && m.content !== null) {
      return `messages[${i}].content must be string, array, or null (tool_calls carry no content)`;
    }
  }
  if (body.context != null && typeof body.context !== 'object') return 'context must be an object';
  return null;
}

// Whitelist of UI-context keys that flow into system prompt + tool
// dispatch. Extra keys are dropped silently so a rogue client can't
// smuggle arbitrary fields into an executor.
const CONTEXT_KEYS = ['brandId', 'adId', 'campaignId', 'productId'];

function sanitiseContext(raw = {}) {
  const out = {};
  for (const k of CONTEXT_KEYS) {
    const v = raw?.[k];
    if (typeof v === 'string' && v.length > 0 && v.length < 100) out[k] = v;
  }
  return out;
}

// ── The endpoint ────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  if (!isEnabled()) {
    return res.status(503).json({ error: 'agent disabled (AGENT_ENABLED=false)' });
  }
  const problem = validateBody(req.body);
  if (problem) return res.status(400).json({ error: problem });

  const context = sanitiseContext(req.body.context);
  const clientMessages = req.body.messages.filter((m) => m.role !== 'system');
  const system = buildSystemPrompt(context);
  const tools = registry.capabilitiesToTools();

  const meta = {
    service:    'agent-chat',
    purposeTag: 'agent',
    brandId:    context.brandId || null
  };

  // Working message list — LLM sees system + full client history + any
  // new assistant + tool messages we append during the loop.
  const working = [{ role: 'system', content: system }, ...clientMessages];
  const appended = [];   // returned to the client so it can persist
  let stopReason = 'end_turn';

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let completion;
    try {
      completion = await chatCompletion(meta, {
        model:       AGENT_MODEL,
        messages:    working,
        tools,
        tool_choice: 'auto',
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS_PER_CALL
      });
    } catch (err) {
      console.error(`❌ agent chat: chatCompletion failed on iter ${iter}: ${err.message}`);
      return res.status(502).json({ error: `LLM call failed: ${err.message}` });
    }

    const assistantMsg = completion.choices?.[0]?.message;
    if (!assistantMsg) {
      return res.status(502).json({ error: 'LLM returned no message' });
    }

    // Append the assistant turn verbatim. Some providers put tool_calls
    // AND content on the same message; keep both.
    const toRecord = {
      role:    'assistant',
      content: assistantMsg.content ?? null
    };
    if (Array.isArray(assistantMsg.tool_calls) && assistantMsg.tool_calls.length) {
      toRecord.tool_calls = assistantMsg.tool_calls;
    }
    working.push(toRecord);
    appended.push(toRecord);

    // No tool call → we're done.
    if (!Array.isArray(assistantMsg.tool_calls) || !assistantMsg.tool_calls.length) {
      stopReason = 'end_turn';
      break;
    }

    // Dispatch each tool call. Errors are shipped back as ok:false
    // results so the model can respond gracefully next turn.
    for (const call of assistantMsg.tool_calls) {
      let args = {};
      try {
        args = call.function?.arguments
          ? JSON.parse(call.function.arguments)
          : {};
      } catch (err) {
        args = { _parseError: err.message };
      }
      const result = await agentTools.dispatch({
        toolName: call.function?.name,
        args,
        req,
        context
      });
      const toolMsg = {
        role:         'tool',
        tool_call_id: call.id,
        content:      JSON.stringify(result)
      };
      working.push(toolMsg);
      appended.push(toolMsg);
    }
    // Fall through to next iteration — the model reads its own tool
    // results and either answers or calls another tool.
    if (iter === MAX_ITERATIONS - 1) stopReason = 'max_iterations';
  }

  res.json({
    messages: appended,
    stop_reason: stopReason,
    model: AGENT_MODEL,
    iterations: appended.filter((m) => m.role === 'assistant').length
  });
});

function isEnabled() {
  return String(process.env.AGENT_ENABLED || '').toLowerCase() === 'true';
}

router.isEnabled = isEnabled;

module.exports = router;
