// Dispatcher: resolves a tool_use call (from the LLM) to a capability,
// runs the capability's executor with the caller's `req`, and returns a
// typed result the endpoint can feed back into the tool loop.
//
// LOAD-BEARING INVARIANT: executors always receive `req`. They MUST
// enforce tenant scope via req.advertiserId (or by delegating to a
// tenant-scoped model helper). Do NOT let the LLM control brandId /
// adId without the executor cross-checking against the advertiser's
// scope — a well-formed cross-tenant call is a leak.
//
// SHAPE OF EXECUTOR RESULT (contract):
//   { ok: true,  kind: '<resource-tag>', data: { … } }
//   { ok: false, error: '<one-line reason>' }
// The endpoint serialises this verbatim as the tool result message
// (with a bounded size guard); nothing else here reshapes it.

'use strict';

const registry = require('./capabilityRegistry');

// Bound the tool-result payload the LLM sees. Big data blobs blow the
// context window and cost latency; if a capability has more than this
// to say, it should paginate or summarise itself.
const MAX_RESULT_BYTES = Number(process.env.AGENT_MAX_TOOL_RESULT_BYTES || 12_000);

/**
 * Dispatch one tool call.
 * @param {object} opts
 * @param {string} opts.toolName  — the mangled name emitted by the LLM
 *                                  (e.g. 'catalog__listProducts').
 * @param {object} opts.args      — parsed tool_use arguments.
 * @param {object} opts.req       — Express req; carries advertiserId, user, session.
 * @param {object} opts.context   — UI context (brandId, adId, …) merged into args
 *                                  when the capability's args schema references
 *                                  those keys and the LLM omitted them.
 * @returns {Promise<{ ok, kind?, data?, error?, meta }>}
 */
async function dispatch({ toolName, args = {}, req, context = {} }) {
  const capability = registry.capabilityByToolName(toolName);
  if (!capability) {
    return { ok: false, error: `unknown tool "${toolName}"`, meta: { toolName } };
  }

  // Merge UI context into args for keys the LLM didn't supply. Explicit
  // LLM args ALWAYS win (a user's "brandId=X please" through the chat
  // should override the sidebar's selected brand) — we only fill blanks.
  const mergedArgs = { ...args };
  for (const key of ['brandId', 'adId', 'campaignId', 'productId', 'advertiserId']) {
    if (mergedArgs[key] == null && context[key] != null) mergedArgs[key] = context[key];
  }

  let executor;
  try {
    executor = require(capability.execute.service);
  } catch (err) {
    return {
      ok: false,
      error: `capability "${capability.id}" executor could not be loaded: ${err.message}`,
      meta: { capabilityId: capability.id, executorPath: capability.execute.service }
    };
  }
  const method = capability.execute.method;
  if (typeof executor[method] !== 'function') {
    return {
      ok: false,
      error: `capability "${capability.id}" executor missing method "${method}"`,
      meta: { capabilityId: capability.id }
    };
  }

  const t0 = Date.now();
  let result;
  try {
    result = await executor[method]({ req, args: mergedArgs });
  } catch (err) {
    // A thrown executor is a bug — the contract is "return { ok:false }
    // on user-facing failure". Log it as an error, hand the LLM a
    // clean-shaped result so the tool loop can continue or the model
    // can decide to give up gracefully.
    console.error(`❌ agentTools[${capability.id}]: executor threw — ${err.message}`);
    return {
      ok: false,
      error: `internal error running "${capability.id}": ${err.message}`,
      meta: { capabilityId: capability.id, tookMs: Date.now() - t0 }
    };
  }

  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      error: `executor "${capability.id}" returned non-object result`,
      meta: { capabilityId: capability.id, tookMs: Date.now() - t0 }
    };
  }

  // Bound the payload. Truncation is loud on purpose — an LLM reading
  // `_truncated: true` can decide to narrow its query on the next turn,
  // whereas a silent trim looks like real absence.
  const enriched = { ...result, meta: { capabilityId: capability.id, tookMs: Date.now() - t0 } };
  const serialised = JSON.stringify(enriched);
  if (serialised.length > MAX_RESULT_BYTES) {
    console.warn(`⚠️  agentTools[${capability.id}]: result ${serialised.length}B > cap ${MAX_RESULT_BYTES}B — truncating`);
    return {
      ok: enriched.ok,
      kind: enriched.kind,
      data: { _truncated: true, _originalBytes: serialised.length, note: 'result exceeded AGENT_MAX_TOOL_RESULT_BYTES; ask the capability to paginate or filter' },
      meta: enriched.meta
    };
  }
  return enriched;
}

module.exports = { dispatch };
