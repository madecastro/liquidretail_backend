// POST /api/agent/chat — SSE-streaming conversational agent.
//
// Replaces the buffered endpoint from PR #1. Same tool loop, same
// registry, same dispatch — but the response is text/event-stream so
// the frontend chat drawer sees tokens + tool calls + results as they
// happen instead of one blob at the end.
//
// EVENT VOCABULARY (client-facing contract — DO NOT change silently):
//   event: assistant-delta         data: { text }
//   event: tool-use-start          data: { toolCallId, toolName }
//   event: tool-use-complete       data: { toolCallId, toolName, args }
//   event: tool-result             data: { toolCallId, result }
//   event: proposed-action         data: { toolCallId, toolName, args, tier }
//   event: spend-guard-block       data: { toolCallId, toolName, reason,
//                                          dailyCap, spent, estimateUsd, projected }
//   event: tier3-phrase-block      data: { toolCallId, toolName, reason, required }
//   event: iteration               data: { n }
//   event: done                    data: { stop_reason, iterations, model }
//   event: error                   data: { error }
//
// CONFIRMATION GATE (Tier ≥ 1):
//
// PR #3 introduces server-side gating so the LLM cannot cause a write
// without an explicit operator confirmation. When the LLM emits a
// tool_call for a Tier ≥ 1 capability that is NOT in the request's
// `confirmations: string[]` array, the server:
//   1. Emits `proposed-action { toolCallId, toolName, args, tier }`
//   2. Inserts a synthetic pending tool_result into the message
//      history: `{ ok:false, needsConfirmation:true, ... }`
//   3. Emits `tool-result` for the client's UI stream
//   4. Sets stop_reason='pending_confirmations' and breaks the loop
//      (still finishes the current iteration's text streaming first).
//
// On the operator's confirmation click, the client re-POSTs the same
// message history + `confirmations: [<tool_call_id>, …]`. The server
// walks the LAST assistant message with tool_calls, dispatches every
// call whose id ∈ confirmations, and REPLACES the synthetic pending
// tool_result in the messages history with the real result before
// entering the LLM loop. The LLM's next iteration sees real results
// and produces a natural "done" answer.
//
// A rogue LLM cannot self-confirm — the `confirmations` array is
// authoritative, and it comes from the client, not from the model.
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
const spendGuard = require('../services/spendGuard');
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
    'This build ships tier-0 (read-only), tier-1 (cheap-write, reversible), tier-2 (billable), and tier-3 (external / hard-to-reverse) capabilities. Tier-4 workflows land in a follow-up release. If the operator asks for something a higher tier would need, say so clearly rather than pretending you can\'t help.',
    '',
    'CONFIRMATION FLOW (tier ≥ 1, server-enforced — do NOT try to bypass):',
    '- When the operator asks for a tier-1+ action, CALL THE TOOL as usual. The server will intercept the call and return a synthetic result `{ ok:false, needsConfirmation:true }` — this is the gate, not a failure.',
    '- Your next message to the operator should DESCRIBE the exact action, its target, cost (for tier 2), and reversibility, then ask for explicit confirmation. Example: "I\'d like to regenerate ad X with your edited prompt — estimated $0.15, non-reversible (previous render will be overwritten). Confirm?"',
    '- On the operator\'s confirmation, the SERVER dispatches the previously-proposed tool call — do NOT re-emit it. Your next message just summarises what happened based on the real tool_result you\'ll see.',
    '- If the operator declines, acknowledge and do nothing.',
    '',
    'SPEND CAP (tier ≥ 2, server-enforced):',
    '- Tier 2 actions are billable. The server enforces a per-advertiser daily USD cap on top of confirmation.',
    '- If a confirmed action would exceed the cap, dispatch is blocked and you receive `{ ok:false, spendGuardBlocked:true, reason, dailyCap, spent, projected }`.',
    '- Communicate the block honestly: state the cap, what\'s spent today, and what the operator can do (raise the cap, wait for the 24h window to roll, run a cheaper capability). Do not retry the same action — the block is authoritative.',
    '',
    'EXPLICIT PHRASE (tier ≥ 3, server-enforced):',
    '- Tier 3 actions are external / hard-to-reverse (e.g. publishing to Meta). On top of confirmation, the operator must TYPE an exact phrase in the client\'s confirmation UI (declared per-capability, e.g. "PUBLISH TO META").',
    '- Your proposed-action message must state the phrase clearly. Example: "I\'d like to publish these 3 ads to Meta adset X. This will make them live to real users after Meta\'s review. To confirm, click Confirm and type PUBLISH TO META in the phrase field."',
    '- If the client sends a confirmation WITHOUT the phrase (or with a wrong phrase), you receive `{ ok:false, tier3PhraseBlocked:true, reason, required }`. Do not retry — ask the operator to re-confirm with the correct phrase.',
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
  if (body.confirmations != null) {
    if (!Array.isArray(body.confirmations)) return 'confirmations must be an array of strings';
    for (const [i, c] of body.confirmations.entries()) {
      if (typeof c !== 'string' || c.length === 0 || c.length > 200) {
        return `confirmations[${i}] must be a non-empty string ≤200 chars`;
      }
    }
  }
  if (body.explicitConfirmations != null) {
    if (typeof body.explicitConfirmations !== 'object' || Array.isArray(body.explicitConfirmations)) {
      return 'explicitConfirmations must be an object keyed by tool_call_id';
    }
    for (const [k, v] of Object.entries(body.explicitConfirmations)) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 200) {
        return `explicitConfirmations key "${k}" invalid`;
      }
      if (typeof v !== 'string' || v.length === 0 || v.length > 200) {
        return `explicitConfirmations["${k}"] must be a non-empty string ≤200 chars`;
      }
    }
  }
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

// ── Tier 3+ phrase check ──────────────────────────────────────────
//
// Returns null when the phrase matches (or the capability requires no
// phrase), otherwise a reason string. Called for every Tier ≥ 3
// dispatch — even confirmed ones — so a phrase-less confirmation
// cannot smuggle a hard-to-reverse action past the gate.
function phraseCheck(capability, callId, explicitConfirmations) {
  if (!capability || capability.tier < 3) return null;
  const required = capability.explicitConfirmation;
  if (typeof required !== 'string' || !required) {
    // Registry validator prevents this in normal operation; a manifest
    // that reached here without a phrase declared is a bug — fail
    // closed rather than dispatching an unbounded external action.
    return `capability "${capability.id}" is tier ${capability.tier} but declares no explicitConfirmation phrase`;
  }
  const supplied = explicitConfirmations?.[callId];
  if (typeof supplied !== 'string' || supplied !== required) {
    return `tier ${capability.tier} action requires the exact phrase "${required}" typed by the operator (received: ${supplied === undefined ? 'nothing' : JSON.stringify(String(supplied).slice(0, 60))})`;
  }
  return null;
}

// ── Gate: split assembled tool_calls into dispatch vs confirm-required ─
//
// Tier 0 → always dispatch. Tier ≥ 1 → dispatch only if the call id is
// in the request's `confirmations` set; otherwise gate. Unknown tools
// fail closed (treated as maximum-tier gate) — cheaper than dispatching
// an executor that doesn't exist and leaking the reason via a stack.
function splitByGate(toolCalls, confirmationsSet) {
  const toDispatch = [];
  const toGate = [];
  for (const call of toolCalls) {
    const cap = registry.capabilityByToolName(call.function.name);
    const tier = cap ? cap.tier : 999;   // fail closed
    if (tier === 0 || confirmationsSet.has(call.id)) {
      toDispatch.push({ call, tier, cap });
    } else {
      toGate.push({ call, tier, cap });
    }
  }
  return { toDispatch, toGate };
}

// ── Confirmation replay ─────────────────────────────────────────────
//
// When the client re-POSTs with `confirmations: [...ids]`, walk the
// LAST assistant message that emitted tool_calls, dispatch each
// confirmed call, and REPLACE the synthetic pending tool_result in
// the messages history with the real result. The LLM's next iteration
// then sees real data and produces a natural summary. Emits
// tool-result SSE events per dispatched call so the client can update
// its UI in real time.
async function replayConfirmations({ working, confirmationsSet, explicitConfirmations, req, context, res }) {
  if (!confirmationsSet.size) return { dispatched: 0 };

  // Find the last assistant message carrying tool_calls.
  let assistantIdx = -1;
  for (let i = working.length - 1; i >= 0; i--) {
    if (working[i].role === 'assistant' && Array.isArray(working[i].tool_calls) && working[i].tool_calls.length) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return { dispatched: 0 };

  let dispatched = 0;
  for (const call of working[assistantIdx].tool_calls) {
    if (!confirmationsSet.has(call.id)) continue;

    // Locate the pending tool message we need to replace.
    let toolIdx = -1;
    for (let j = assistantIdx + 1; j < working.length; j++) {
      if (working[j].role === 'tool' && working[j].tool_call_id === call.id) {
        toolIdx = j;
        break;
      }
    }
    // No pending stub → the tool_call was never processed by this
    // server (e.g. history was hand-crafted). Nothing to replay; skip.
    if (toolIdx < 0) continue;

    let args = {};
    try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; }
    catch { args = {}; }

    const cap = registry.capabilityByToolName(call.function?.name);

    // Tier 3+ phrase check on replay — a confirmation missing the
    // exact phrase still blocks a hard-to-reverse action. Uses the
    // same phraseCheck helper the in-loop path uses so both sites
    // stay in sync.
    if (cap && cap.tier >= 3) {
      const problem = phraseCheck(cap, call.id, explicitConfirmations);
      if (problem) {
        sseWrite(res, 'tier3-phrase-block', {
          toolCallId: call.id,
          toolName:   call.function.name,
          reason:     problem,
          required:   cap.explicitConfirmation
        });
        const blockedResult = {
          ok: false,
          tier3PhraseBlocked: true,
          reason:   problem,
          required: cap.explicitConfirmation
        };
        working[toolIdx] = {
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(blockedResult)
        };
        sseWrite(res, 'tool-result', { toolCallId: call.id, result: blockedResult });
        continue;
      }
    }

    // Tier ≥ 2 replays still hit spendGuard — the operator confirmed
    // the ACTION, but the daily cap may have moved between propose and
    // confirm (a parallel agent session may have spent since). Blocked
    // replays surface both events + a spend-guard tool_result so the
    // LLM sees the same shape as an in-loop block.
    if (cap && cap.tier >= 2) {
      const guard = await spendGuard.check({
        advertiserId: req.advertiserId,
        capability:   cap,
        args
      });
      if (!guard.allowed) {
        sseWrite(res, 'spend-guard-block', {
          toolCallId: call.id,
          toolName:   call.function.name,
          reason:     guard.reason,
          dailyCap:   guard.dailyCap,
          spent:      guard.spent,
          estimateUsd: guard.estimateUsd,
          projected:  guard.projected
        });
        const blockedResult = {
          ok: false,
          spendGuardBlocked: true,
          reason:      guard.reason,
          dailyCap:    guard.dailyCap,
          spent:       guard.spent,
          estimateUsd: guard.estimateUsd,
          projected:   guard.projected
        };
        working[toolIdx] = {
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(blockedResult)
        };
        sseWrite(res, 'tool-result', { toolCallId: call.id, result: blockedResult });
        continue;
      }
    }

    const result = await agentTools.dispatch({
      toolName: call.function?.name,
      args,
      req,
      context
    });

    working[toolIdx] = {
      role:         'tool',
      tool_call_id: call.id,
      content:      JSON.stringify(result)
    };
    sseWrite(res, 'tool-result', { toolCallId: call.id, result });
    dispatched++;
  }
  return { dispatched };
}

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
  const confirmationsSet = new Set(Array.isArray(req.body.confirmations) ? req.body.confirmations : []);
  const explicitConfirmations = (req.body.explicitConfirmations && typeof req.body.explicitConfirmations === 'object')
    ? req.body.explicitConfirmations : {};
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
    // Confirmation replay — dispatch any Tier ≥ 1 calls the client
    // just confirmed and replace their synthetic pending tool_results
    // in the history with real ones BEFORE the LLM sees this turn.
    if (confirmationsSet.size) {
      const { dispatched } = await replayConfirmations({
        working, confirmationsSet, explicitConfirmations, req, context, res
      });
      if (dispatched > 0) {
        console.log(`🤝 agent chat: replayed ${dispatched} confirmed tool call(s)`);
      }
    }
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

      // Split by risk tier. Tier 0 dispatches immediately; Tier ≥ 1
      // requires an explicit id in confirmationsSet (populated on the
      // request AFTER the operator clicks Confirm in the UI).
      const { toDispatch, toGate } = splitByGate(assembledToolCalls, confirmationsSet);

      // Dispatch confirmed / Tier-0 calls. For Tier ≥ 2, spendGuard
      // runs BEFORE dispatch — a confirmed billable action still gets
      // blocked if it would exceed the daily cap.
      for (const { call, tier, cap } of toDispatch) {
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

        // Tier 3+ phrase gate — the operator must have typed the
        // explicit phrase in the confirmation UI. Runs BEFORE
        // spendGuard so a phrase-less confirmation can't reach a
        // billable estimate check (irrelevant here since
        // publishToMeta is estimateUsd:0, but the ordering matters
        // for future Tier 3 capabilities that ARE billable).
        if (tier >= 3 && cap) {
          const problem = phraseCheck(cap, call.id, explicitConfirmations);
          if (problem) {
            sseWrite(res, 'tier3-phrase-block', {
              toolCallId: call.id,
              toolName:   call.function.name,
              reason:     problem,
              required:   cap.explicitConfirmation
            });
            const blockedResult = {
              ok: false,
              tier3PhraseBlocked: true,
              reason:   problem,
              required: cap.explicitConfirmation
            };
            sseWrite(res, 'tool-result', { toolCallId: call.id, result: blockedResult });
            working.push({
              role:         'tool',
              tool_call_id: call.id,
              content:      JSON.stringify(blockedResult)
            });
            continue;
          }
        }

        // Spend cap gate. Tier 0/1 skip (no billable dispatch). Tier ≥ 2
        // rejects both when the capability lacks estimateUsd (fail
        // closed) and when spent + est would exceed AGENT_DAILY_CAP_USD.
        if (tier >= 2 && cap) {
          const guard = await spendGuard.check({
            advertiserId: req.advertiserId,
            capability:   cap,
            args
          });
          if (!guard.allowed) {
            sseWrite(res, 'spend-guard-block', {
              toolCallId: call.id,
              toolName:   call.function.name,
              reason:     guard.reason,
              dailyCap:   guard.dailyCap,
              spent:      guard.spent,
              estimateUsd: guard.estimateUsd,
              projected:  guard.projected
            });
            const blockedResult = {
              ok: false,
              spendGuardBlocked: true,
              reason:      guard.reason,
              dailyCap:    guard.dailyCap,
              spent:       guard.spent,
              estimateUsd: guard.estimateUsd,
              projected:   guard.projected
            };
            sseWrite(res, 'tool-result', { toolCallId: call.id, result: blockedResult });
            working.push({
              role:         'tool',
              tool_call_id: call.id,
              content:      JSON.stringify(blockedResult)
            });
            continue;
          }
        }

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

      // Gate everything else. Emit proposed-action so the client can
      // render a confirmation card, insert a synthetic pending
      // tool_result so the LLM's message history stays well-formed
      // (every tool_call needs a matching tool_result on the next
      // turn), and remember that we're breaking after this iteration.
      let anyGated = false;
      for (const { call, tier } of toGate) {
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
        sseWrite(res, 'proposed-action', {
          toolCallId: call.id,
          toolName:   call.function.name,
          args,
          tier
        });
        const pendingResult = {
          ok: false,
          needsConfirmation: true,
          toolCallId: call.id,
          toolName:   call.function.name,
          tier,
          note: 'Awaiting operator confirmation. Server will not dispatch until the client re-POSTs with this tool_call_id in the confirmations[] array.'
        };
        sseWrite(res, 'tool-result', { toolCallId: call.id, result: pendingResult });
        working.push({
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(pendingResult)
        });
        anyGated = true;
      }

      if (anyGated) {
        // Stop after this iteration. The LLM already produced its
        // text alongside the tool_calls; the client renders that text
        // + the proposed-action cards. On confirm, the client re-POSTs
        // with confirmations[] and replayConfirmations dispatches for
        // real, then the loop continues from a fresh iteration.
        stopReason = 'pending_confirmations';
        break;
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
