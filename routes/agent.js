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
//   event: plan-proposed           data: { toolCallId, toolName, plan }
//   event: workflow-progress       data: { toolCallId, toolName, step, totalSteps, item, outcome, ... }
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
// AGENT_MAX_MESSAGES=0 (or unset with default 0) disables the cap.
// Any positive value enables it. When disabled, an unbounded history
// is legal — cost defense falls entirely on AGENT_DAILY_CAP_USD /
// spendGuard and AGENT_MAX_TOKENS per LLM call. Re-enable with a
// numeric env override (e.g. 40) once client-side history compaction
// exists in the chat drawer.
const MAX_MESSAGES = Number(process.env.AGENT_MAX_MESSAGES || 0);
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
    'This build ships all tiers: tier-0 (read-only), tier-1 (cheap-write, reversible), tier-2 (billable), tier-3 (external / hard-to-reverse), and tier-4 (multi-step workflows with plan-preview). If the operator asks for something no capability covers, say so clearly rather than pretending you can\'t help.',
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
    'WORKFLOWS (tier 4, plan-first):',
    '- Tier 4 capabilities are multi-step workflows. On the first call, you receive a PLAN result — `{ ok:true, kind:\'plan\', data:{ workflowId, summary, totalSteps, estimateUsd, estimateWallMs, sampleSteps, ... } }`. This is NOT a failure — the server has run the preview phase (side-effect-free) and is waiting for the operator to confirm execution.',
    '- Your message to the operator should surface the plan\'s summary, totalSteps, estimateWallMs (in minutes for anything > 60 seconds), and any skipped-item notes. Ask whether to proceed.',
    '- On confirmation, the server invokes the workflow\'s execute() phase. You receive a final `workflowResult` — summarise the outcome (succeeded / failed / skipped counts, notable per-step notes) for the operator.',
    '- Do NOT call a tier-4 capability more than once in a single planning-to-execution cycle — the server\'s confirmation gate handles the phase transition. If the operator wants a fresh plan, they\'ll ask again.',
    '',
    `AVAILABLE CAPABILITIES (${registry.CAPABILITIES.length}):`,
    registry.describeManifest(),
    '',
    contextLines
      ? `CURRENT UI CONTEXT (the operator has these selected — capabilities that need one of these IDs will use it as a default):\n${contextLines}`
      : 'CURRENT UI CONTEXT: nothing selected.',
    '',
    'ERROR RECOVERY:',
    '- When a capability fails with an error message that NAMES ANOTHER CAPABILITY as the remedy (e.g. "invoke integrations.instagram.connectUrl", "use catalog.pullFromApify for more"), offer to chain into that capability as your next step — do not just stop at the error. Ask the operator whether to proceed.',
    '- If the error result carries a sourceCounts field (from posts.syncFromInstagram / catalog.syncFromInstagram), it tells you which OTHER ingestion path this brand ALREADY has content from. Steer the operator to the capability matching the dominant source instead of insisting on the OAuth path.',
    '',
    'DECIDING BETWEEN INGESTION PATHS (media / catalog refresh):',
    '- The AUTHORITATIVE signal for how existing media / catalog rows were ingested is the `source` field ON THE ROWS THEMSELVES, not the current IntegrationCredential state. Credentials can be revoked AFTER ingest, so a brand may have IG media with source=instagram or source=apify-ig even when integrations.instagram.listCredentials is empty.',
    '- When the operator asks to refresh media / posts / comments and does not specify OAuth vs Apify, call media.sourceSummary FIRST (Tier 0, cheap). Its response includes `remedyBySource` telling you which refresh capability applies per source.',
    '- Only fall back to asking the operator when media.sourceSummary is genuinely ambiguous (e.g. equal counts across sources with different remedies).',
    '',
    'KEYWORD SEARCH — use agent.searchAcrossBrands, NOT db.query:',
    '- When the operator asks about anything by NAME, TITLE, SUBSTRING, PARTIAL WORD, or KEYWORD (e.g. "show my sectional couches", "which ads mention Q4", "products with hydration in the name"), USE agent.searchAcrossBrands. Pass brandId when the operator is scoped to a single brand.',
    '- Do NOT use db.query for keyword searches — db.query intentionally excludes $regex (DoS risk on unindexed fields), and CatalogProduct.title / Ad.title / Campaign.name are not in its filterable allowlist. agent.searchAcrossBrands uses a bounded regex behind advertiser + brand tenant filters.',
    '',
    'When you finish, produce a concise plain-text answer for the operator. Do not restate the raw JSON — summarise the finding. If a capability failed (ok:false), tell the operator what went wrong and what they can try.'
  ].join('\n');
}

// ── Request validation (unchanged from PR #1) ──────────────────────

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (!Array.isArray(body.messages)) return 'messages[] required';
  if (body.messages.length === 0) return 'messages[] cannot be empty';
  if (MAX_MESSAGES > 0 && body.messages.length > MAX_MESSAGES) {
    return `messages[] exceeds cap ${MAX_MESSAGES}`;
  }
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
  if (!capability) return null;
  const required = capability.explicitConfirmation;
  // Tier 3 REQUIRES a phrase (validator enforces at load); a Tier 3
  // that reached here without one is a manifest bug → fail closed.
  if (capability.tier === 3 && (typeof required !== 'string' || !required)) {
    return `capability "${capability.id}" is tier 3 but declares no explicitConfirmation phrase`;
  }
  // If the capability declares a phrase (any tier), enforce it. Tier 4
  // workflows can opt-in for extra ceremony; Tier 2 can too if the
  // author considers the action high-blast even inside its own tier.
  if (typeof required === 'string' && required) {
    const supplied = explicitConfirmations?.[callId];
    if (typeof supplied !== 'string' || supplied !== required) {
      return `tier ${capability.tier} action requires the exact phrase "${required}" typed by the operator (received: ${supplied === undefined ? 'nothing' : JSON.stringify(String(supplied).slice(0, 60))})`;
    }
  }
  return null;
}

// ── Gate: split assembled tool_calls into four dispatch classes ───
//
// Standard tools: Tier 0 → toDispatch; Tier ≥ 1 confirmed → toDispatch;
// Tier ≥ 1 unconfirmed → toGate.
//
// Workflow tools (Tier 4, execute.workflow=true): NEVER go through
// agentTools.dispatch — they need endpoint-level preview/execute
// handling AND a progress callback for SSE. Unconfirmed workflow
// tool_calls run their side-effect-free preview() to produce a plan
// (toWorkflowPreview); confirmed ones run execute() with progress
// callbacks threaded in (toWorkflowExecute).
//
// Unknown tools fail closed (tier 999 → toGate) — cheaper than
// dispatching an executor that doesn't exist and leaking the reason
// via a stack trace.
function splitByGate(toolCalls, confirmationsSet) {
  const toDispatch = [];
  const toGate = [];
  const toWorkflowPreview = [];
  const toWorkflowExecute = [];
  for (const call of toolCalls) {
    const cap = registry.capabilityByToolName(call.function.name);
    const tier = cap ? cap.tier : 999;
    const isWorkflow = cap?.execute?.workflow === true;
    const confirmed = confirmationsSet.has(call.id);

    if (isWorkflow) {
      if (confirmed) toWorkflowExecute.push({ call, tier, cap });
      else           toWorkflowPreview.push({ call, tier, cap });
      continue;
    }
    if (tier === 0 || confirmed) toDispatch.push({ call, tier, cap });
    else                         toGate.push({ call, tier, cap });
  }
  return { toDispatch, toGate, toWorkflowPreview, toWorkflowExecute };
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

    // Phrase check on replay — same rule as the in-loop path.
    if (cap && (cap.tier === 3 || typeof cap.explicitConfirmation === 'string')) {
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

    // Tier 4 workflow replay: don't go through agentTools.dispatch
    // (workflow capabilities have no `method`). Call executor.execute()
    // directly with a progress callback so SSE events still stream.
    let result;
    if (cap?.execute?.workflow === true) {
      try {
        // Go through registry.resolveExecutorPath — passing the raw
        // service string to node's require() resolves the
        // './capabilityExecutors/...' path relative to THIS file
        // (routes/) and blows up with MODULE_NOT_FOUND (Aug 6 outage).
        const executor = require(registry.resolveExecutorPath(cap));
        if (typeof executor.execute !== 'function') {
          result = { ok: false, error: `workflow "${cap.id}" executor exports no execute()` };
        } else {
          const onProgress = (payload) => {
            sseWrite(res, 'workflow-progress', {
              toolCallId: call.id, toolName: call.function.name, ...payload
            });
          };
          result = await executor.execute({ req, args, onProgress });
        }
      } catch (err) {
        result = { ok: false, error: `workflow execute crashed: ${err.message}` };
      }
    } else {
      result = await agentTools.dispatch({
        toolName: call.function?.name,
        args,
        req,
        context
      });
    }

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

  // Keep-alive pings — comment lines (`: <text>\n\n`) that SSE parsers
  // ignore but that Render / Netlify / any HTTP-level proxy sees as
  // traffic. Without these, an LLM call that stalls for 30-60s (cold
  // model, provider throttle) can trigger an idle-connection reap that
  // truncates the response BEFORE our `done` event lands — leaving the
  // client stuck at "Thinking…" with no terminal signal. 15s is well
  // under every default idle-reap window we care about.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(': keep-alive\n\n'); } catch { /* ignore — cleanup fires next tick */ }
    }
  }, 15_000);

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
      // request AFTER the operator clicks Confirm in the UI). Tier 4
      // workflow tools split into preview (unconfirmed) or execute
      // (confirmed) — see the executor's two-phase contract.
      const { toDispatch, toGate, toWorkflowPreview, toWorkflowExecute } =
        splitByGate(assembledToolCalls, confirmationsSet);

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

        // Tier 3 phrase gate — the operator must have typed the
        // explicit phrase in the confirmation UI. phraseCheck also
        // enforces per-capability opt-in phrases at any tier when
        // declared. Runs BEFORE spendGuard so a phrase-less
        // confirmation can't reach a billable estimate check.
        if (cap && (cap.tier === 3 || typeof cap.explicitConfirmation === 'string')) {
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

      // Tier 4 preview: run the side-effect-free preview() to produce
      // a plan, then insert as a pending tool_result (like a proposed-
      // action but with kind:'plan'). Loop breaks after this iteration
      // so the LLM's iter-1 text is what the operator sees alongside
      // the plan card.
      for (const { call, cap } of toWorkflowPreview) {
        if (aborted) break;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          args = { _parseError: err.message, _raw: call.function.arguments };
        }
        sseWrite(res, 'tool-use-complete', { toolCallId: call.id, toolName: call.function.name, args });

        let plan;
        try {
          // See the T4-execute branch above — must funnel through
          // registry.resolveExecutorPath, not raw require(service).
          const executor = require(registry.resolveExecutorPath(cap));
          if (typeof executor.preview !== 'function') {
            plan = { ok: false, error: `workflow "${cap.id}" executor exports no preview()` };
          } else {
            plan = await executor.preview({ req, args });
          }
        } catch (err) {
          plan = { ok: false, error: `workflow preview crashed: ${err.message}` };
        }

        sseWrite(res, 'plan-proposed', {
          toolCallId: call.id,
          toolName:   call.function.name,
          plan
        });
        sseWrite(res, 'tool-result', { toolCallId: call.id, result: plan });
        working.push({
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(plan)
        });
        anyGated = true;
      }

      // Tier 4 execute: gates already ran? No — the workflow's own
      // gate is the confirmation itself (operator saw the plan and
      // confirmed the whole thing). Phrase gate and spend gate DO
      // still apply if the capability declares them.
      for (const { call, cap } of toWorkflowExecute) {
        if (aborted) break;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          args = { _parseError: err.message, _raw: call.function.arguments };
        }

        // Phrase gate — Tier 4 workflows opt-in via explicitConfirmation.
        if (cap.tier === 3 || typeof cap.explicitConfirmation === 'string') {
          const problem = phraseCheck(cap, call.id, explicitConfirmations);
          if (problem) {
            sseWrite(res, 'tier3-phrase-block', {
              toolCallId: call.id, toolName: call.function.name,
              reason: problem, required: cap.explicitConfirmation
            });
            const blockedResult = {
              ok: false, tier3PhraseBlocked: true,
              reason: problem, required: cap.explicitConfirmation
            };
            sseWrite(res, 'tool-result', { toolCallId: call.id, result: blockedResult });
            working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(blockedResult) });
            continue;
          }
        }

        // Spend gate — even non-workflow spend caps apply to Tier 4
        // workflows that estimateUsd > 0 (e.g. lifestyle images).
        if (cap.tier >= 2) {
          const guard = await spendGuard.check({
            advertiserId: req.advertiserId,
            capability: cap,
            args
          });
          if (!guard.allowed) {
            sseWrite(res, 'spend-guard-block', {
              toolCallId: call.id, toolName: call.function.name,
              reason: guard.reason, dailyCap: guard.dailyCap,
              spent: guard.spent, estimateUsd: guard.estimateUsd,
              projected: guard.projected
            });
            const blockedResult = {
              ok: false, spendGuardBlocked: true,
              reason: guard.reason, dailyCap: guard.dailyCap,
              spent: guard.spent, estimateUsd: guard.estimateUsd,
              projected: guard.projected
            };
            sseWrite(res, 'tool-result', { toolCallId: call.id, result: blockedResult });
            working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(blockedResult) });
            continue;
          }
        }

        // Execute the workflow with a progress callback that emits
        // SSE events. Callback wraps each per-step outcome; the
        // workflow never throws — errors are structured.
        let result;
        try {
          // Same rule as the other T4 branches — must go through
          // registry.resolveExecutorPath, not raw require(service).
          const executor = require(registry.resolveExecutorPath(cap));
          if (typeof executor.execute !== 'function') {
            result = { ok: false, error: `workflow "${cap.id}" executor exports no execute()` };
          } else {
            const onProgress = (payload) => {
              sseWrite(res, 'workflow-progress', {
                toolCallId: call.id,
                toolName: call.function.name,
                ...payload
              });
            };
            result = await executor.execute({ req, args, onProgress });
          }
        } catch (err) {
          result = { ok: false, error: `workflow execute crashed: ${err.message}` };
        }
        sseWrite(res, 'tool-result', { toolCallId: call.id, result });
        working.push({
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(result)
        });
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
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
});

function isEnabled() {
  return String(process.env.AGENT_ENABLED || '').toLowerCase() === 'true';
}
router.isEnabled = isEnabled;

module.exports = router;
