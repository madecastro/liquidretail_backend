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
const { resolveModel, resolveChain, rejectsSamplingParams, stripSamplingParams } = require('./atlasModelMap');
const {
  LLM_ERROR_CODES, LLM_ACTIONS, ADVANCES_CHAIN,
  classifyLlmFailure, makeLlmError, formatLlmLogLine, formatChainSummary, extractRequestId,
  stampLlmAction,
} = require('./llmError');

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

// ── cross-provider chain tuning (multi-link roles ONLY) ──────────────────
//
// Every number here is justified against MEASURED latency, probed live from
// the production service on 2026-08-18 (same ATLAS_API_KEY, sequential single
// calls): a 429 on a starved Anthropic route costs **~50 SECONDS** before it
// returns; a healthy route answers in 0.7-1.7s; the slowest measured SUCCESS
// was 52s (anthropic/claude-sonnet-4.6).
//
// CHAIN_LINK_TIMEOUT_MS — per-attempt deadline for a NON-FINAL link.
//   75s, not 120s. Two properties had to hold at once:
//   (a) it must be ABOVE the measured 429 latency (~51s), so the starved case
//       resolves as a DEFINITE, uncharged rejection rather than as our own
//       ambiguous timeout. Cutting at 45s would convert a clean 429 into a
//       "maybe it ran and billed" — strictly worse information for the same
//       wall clock. This is the single most important number in this block.
//   (b) it must be above the slowest measured success (52s) with real
//       headroom, so a slow-but-healthy primary is not abandoned. 75s is
//       ~44% over.
//   The final link keeps the full TIMEOUT_MS (120s): it is the last chance,
//   and truncating it would only manufacture ambiguity at the point where we
//   least want it.
//
// CHAIN_BUDGET_MS — wall-clock gate on STARTING a new upstream request.
//   210s. It admits all three Atlas links (75 + 75 = 150s elapsed worst case
//   before the final link starts) and admits the direct-provider fallback only
//   if the chain moved faster than worst case. Deliberately gates STARTS, not
//   in-flight requests: shortening an already-running attempt to fit a budget
//   would again trade a clean verdict for an ambiguous timeout. Worst-case
//   wall clock is therefore CHAIN_BUDGET_MS + one link timeout, not the budget
//   itself, and that is the honest bound.
//
// CHAIN_MAX_ATTEMPTS — hard ceiling on UPSTREAM REQUESTS per chatCompletion
//   call, counting Atlas attempts and direct-provider attempts alike.
//   4. For the Director chain that is exactly: sonnet-5@atlas,
//   opus-5@atlas, terra@atlas, gpt-4.1@openai-direct (the two Anthropic
//   direct twins cost nothing — no ANTHROPIC_API_KEY, so they are skipped
//   without a request). A chain must never turn one Director round into
//   unbounded paid attempts.
//
// NO IN-LINK RETRY ON A CHAIN. A multi-link role gets ONE Atlas attempt per
// link instead of MAX_ATTEMPTS. Retrying a capacity-starved model is ~50s to
// be told the same thing — measured, every payload shape, repeatedly — while
// the chain's own next link is a *different provider*, which is a strictly
// better retry. Single-link roles keep MAX_ATTEMPTS + backoff exactly as
// today; see the equivalence note on the loop below.
const CHAIN_LINK_TIMEOUT_MS = Number(process.env.ATLAS_LLM_CHAIN_LINK_TIMEOUT_MS || 75_000);
const CHAIN_BUDGET_MS       = Number(process.env.ATLAS_LLM_CHAIN_BUDGET_MS || 210_000);
const CHAIN_MAX_ATTEMPTS    = Number(process.env.ATLAS_LLM_CHAIN_MAX_ATTEMPTS || 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConfigured() {
  return !!process.env.ATLAS_API_KEY;
}

// `retryableStatus` / `retryableError` used to live here. They are GONE, not
// moved: the same two questions are now answered by classifyLlmFailure() +
// ADVANCES_CHAIN in services/llmError.js, so there is exactly one definition
// of "is this failure worth another shot" for every LLM transport instead of
// a private copy per file. Re-adding a local predicate here would recreate the
// drift this consolidation exists to prevent.
//
// Property name carrying the chain outcome on a SUCCESSFUL response.
const LLM_CHAIN_PROP = '__llmChain';

// Atlas signals a listed-but-unrouted model with a 400 "router not found".
function atlasRouterMissing(res) {
  return res.status === 400 && /router not found/i.test(JSON.stringify(res.data || {}));
}

async function post(url, key, body, timeoutMs = TIMEOUT_MS) {
  return axios.post(url, body, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
}

function buildAtlasBody(params, atlasId) {
  const body = { ...params, model: atlasId };
  if (/^openai\//.test(atlasId) && body.reasoning_effort === undefined) {
    body.reasoning_effort = 'low';
  }
  // Claude 5 rejects temperature/top_p/top_k with a bare 400 — see
  // atlasModelMap.rejectsSamplingParams for the live probe and the outage
  // it caused. Stripped in the transport so every caller is covered,
  // including any future role repointed at a Claude 5 model.
  if (rejectsSamplingParams(atlasId)) stripSamplingParams(body);
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
 * Turn a non-200 axios response into a CODED error before it leaves the
 * request closure. One helper for both the Atlas and the direct-provider
 * shapes so the two can never drift on classification or on which
 * diagnostic fields survive — the `receiptFree` lesson in CLAUDE.md §4 is
 * about a helper that existed but was not imported at one site; the fix
 * shape is "define once, call everywhere", not "copy carefully".
 */
function codedHttpError({ r, provider, model, role, elapsedMs, attempt, attemptsMax, link, linkCount }) {
  const providerMessage = JSON.stringify(r.data ?? '').slice(0, 200);
  const code = classifyLlmFailure({
    httpStatus: r.status,
    message: providerMessage,
    body: r.data,
    routerMissing: provider === 'atlas' ? atlasRouterMissing(r) : false,
  });
  return makeLlmError({
    code, provider, model, role,
    httpStatus:  r.status,
    requestId:   extractRequestId(r.data, r.headers),
    elapsedMs, attempt, attemptsMax, link, linkCount,
    providerMessage,
    // action is stamped by the control flow AFTER it runs (see the loop) —
    // never here, where a later edit could make it a lie.
    action: LLM_ACTIONS.NONE,
  });
}

/** A thrown non-HTTP failure (socket, abort, our own timeout) → coded error. */
function codedThrownError({ err, provider, model, role, elapsedMs, attempt, attemptsMax, link, linkCount }) {
  if (err && err.llmError) return err;                 // already coded — never re-wrap
  const code = classifyLlmFailure({ errCode: err && err.code, message: err && err.message });
  return makeLlmError({
    code, provider, model, role, httpStatus: null,
    elapsedMs, attempt, attemptsMax, link, linkCount,
    providerMessage: err && err.message,
    cause: err,
    action: LLM_ACTIONS.NONE,
  });
}

/**
 * chatCompletion(meta, params) → OpenAI-shape response body.
 *   meta:   { service, purpose, visionImages? } for the cost ledger.
 *   params: standard chat.completions body with the LEGACY model id
 *           (e.g. 'gpt-4.1', 'gemini-2.5-flash') — mapped internally.
 *   Throws a CODED error (services/llmError.js) when every candidate fails.
 *
 * ── THE CHAIN ────────────────────────────────────────────────────────────
 * `resolveChain(role)` returns an ORDERED list of candidates. Roles without a
 * `chain` in atlasModelMap return exactly one link, and **the one-link path
 * through this loop is the code that shipped before the chain existed**:
 * MAX_ATTEMPTS Atlas attempts at TIMEOUT_MS with BACKOFF_MS*n between them,
 * the same break conditions, then one direct-provider attempt, then throw.
 * The chain-only tuning (1 attempt per link, 75s non-final timeout, the
 * wall-clock budget, the 4-request ceiling) is gated on `multi` precisely so
 * that "every other role is byte-identical" is structural rather than a claim
 * someone has to re-derive per role. verifyDirectorFallbackChain pins it.
 *
 * ── WHAT ADVANCES THE CHAIN, AND THE MONEY REASONING ─────────────────────
 * Only TRANSPORT failures advance: 429, 5xx, timeout, connection error, and
 * the listed-but-unrouted 400. See ADVANCES_CHAIN in llmError.js.
 *
 * A 429 is free to advance from: it is a rejection issued BEFORE any work
 * began, so nothing was billed (Atlas documents "failed LLM requests are
 * never billed"; the same sourcing is recorded in atlasErrorPolicy.js).
 *
 * A TIMEOUT IS AMBIGUOUS and we advance anyway. Stated explicitly because it
 * is a deliberate money decision: our deadline expiring does not prove the
 * upstream stopped, so it may have completed and billed tokens we never
 * received. Advancing can therefore pay twice for one Director round. That is
 * acceptable HERE and ONLY here because this is a TEXT/LLM call, billed per
 * token — a duplicated Director round is cents (~$0.105 at the measured rate),
 * against the certainty of ZERO ads if we do not advance. It is bounded by
 * CHAIN_MAX_ATTEMPTS, so worst case is a small constant, not a loop.
 * ⚠️ THIS REASONING DOES NOT TRANSFER. The image/video submit rule in
 * CLAUDE.md §2 is unchanged and must stay unchanged: a billable
 * image/video POST may be replayed only on positive, STRUCTURED proof the
 * request was rejected before work began (`isDefinite429`, submitRetryDecision).
 * Nothing in this file touches that path.
 *
 * A 200 WHOSE CONTENT IS BAD NEVER REACHES HERE and must never advance the
 * chain: the transport returns the 200, and the Director's own one-shot
 * corrective re-ask (safeParseDirectorJSON + the OUTPUT CONTRACT block) is
 * what handles it. Advancing on bad content would silently multiply paid
 * calls for a prompt-compliance problem that a different model will not fix.
 *
 * WORST-CASE PAID CALLS per chatCompletion: CHAIN_MAX_ATTEMPTS (4) upstream
 * requests. At most ONE of them can return 200-and-bill on the success path
 * (the loop returns immediately). The pathological all-timeouts case is the
 * only way all 4 could bill, and it requires every upstream to have completed
 * work we never saw.
 */
async function chatCompletion(meta, params) {
  if (!params?.model) throw new Error('atlasLlm.chatCompletion: params.model required');
  const role   = params.model;
  const links  = resolveChain(role);
  const multi  = links.length > 1;
  const startedAt = Date.now();

  const chain = [];          // one record per upstream request (or free skip)
  let requestsUsed = 0;      // counts Atlas + direct attempts alike
  let lastErr = null;

  // Gate on STARTING a new upstream request. Single-link roles are never
  // gated — that would be a behaviour change for eleven other services.
  const mayStart = () =>
    !multi || (requestsUsed < CHAIN_MAX_ATTEMPTS && Date.now() - startedAt < CHAIN_BUDGET_MS);

  const record = (rec) => { chain.push(rec); return rec; };

  for (let li = 0; li < links.length; li++) {
    const link      = links[li];
    const isFinal   = li === links.length - 1;
    const atlasId   = link.atlas;
    const direct    = link.direct;
    const linkNo    = li + 1;
    // A chain link gets ONE Atlas attempt — the chain's next link is a
    // different provider and is a strictly better retry than asking a
    // capacity-starved model the same question again for ~50s. A single-link
    // role keeps MAX_ATTEMPTS with BACKOFF_MS*n, exactly as before the chain.
    const linkAttempts  = multi ? 1 : MAX_ATTEMPTS;
    // Only a NON-FINAL link is time-boxed below the normal budget; the last
    // chance keeps the full TIMEOUT_MS.
    const linkTimeoutMs = multi && !isFinal ? CHAIN_LINK_TIMEOUT_MS : TIMEOUT_MS;

    // ── Atlas primary for this link ──
    let atlasErr = null;
    if (!isConfigured()) {
      // Not a transport failure — we never had a key. Keeping this its own
      // code is the whole point of the taxonomy: the Director's Anthropic
      // direct twin has been silently unreachable for exactly this reason.
      atlasErr = makeLlmError({
        code: LLM_ERROR_CODES.LLM_AUTH_MISSING,
        provider: 'atlas', model: atlasId, role,
        link: linkNo, linkCount: links.length, elapsedMs: 0,
        providerMessage: 'ATLAS_API_KEY not configured',
        action: LLM_ACTIONS.SKIPPED_NO_KEY,
        actionDetail: 'skipped without attempting — no ATLAS_API_KEY on this service',
      });
      record({ provider: 'atlas', model: atlasId, code: atlasErr.code, httpStatus: null, ms: 0, ok: false });
      lastErr = atlasErr;
    } else {
      const body = buildAtlasBody(params, atlasId);
      for (let attempt = 1; attempt <= linkAttempts; attempt++) {
        if (!mayStart()) {
          // Budget or attempt ceiling reached. Record it so the chain summary
          // says "we ran out of budget", never leaving a silent gap that reads
          // as if the link was never in the chain.
          record({ provider: 'atlas', model: atlasId, code: 'BUDGET_EXHAUSTED', httpStatus: null, ms: 0, ok: false });
          break;
        }
        requestsUsed++;
        const t0 = Date.now();
        try {
          const res = await trackLlmCall(
            // Caller ledger fields (stage, brandId, purposeTag, cacheKey, …)
            // pass through; provider/model are authoritative here.
            { ...meta, provider: 'atlas', model: atlasId },
            async () => {
              const r = await post(ATLAS_CHAT_URL, process.env.ATLAS_API_KEY, body, linkTimeoutMs);
              if (r.status !== 200) {
                throw codedHttpError({
                  r, provider: 'atlas', model: atlasId, role,
                  elapsedMs: Date.now() - t0, attempt, attemptsMax: linkAttempts, link: linkNo, linkCount: links.length,
                });
              }
              return r.data;
            }
          );
          record({ provider: 'atlas', model: atlasId, code: null, httpStatus: 200, ms: Date.now() - t0, ok: true });
          return succeed(res, { role, links, li, viaDirect: false, servedProvider: 'atlas', servedModel: atlasId, chain, startedAt });
        } catch (err) {
          atlasErr = codedThrownError({
            err, provider: 'atlas', model: atlasId, role,
            elapsedMs: Date.now() - t0, attempt, attemptsMax: linkAttempts, link: linkNo, linkCount: links.length,
          });
          lastErr = atlasErr;
          record({ provider: 'atlas', model: atlasId, code: atlasErr.code, httpStatus: atlasErr.httpStatus, ms: Date.now() - t0, ok: false });
          // A failure that does not advance the chain also does not deserve a
          // retry against the same model: 400/401/402/403 fail identically
          // however many times we ask. Break here and let the DIRECT twin
          // have its shot with the caller's original params — the Atlas body
          // is not the direct body (mapped model, reasoning_effort, padded
          // max_tokens), so a gateway validation error does not prove the
          // caller's request is bad. Unchanged from the pre-chain code.
          if (!ADVANCES_CHAIN.has(atlasErr.code)) break;
          if (attempt < linkAttempts) {
            stampLlmAction(atlasErr, LLM_ACTIONS.RETRIED_SAME_MODEL,
              `retrying ${atlasId} (attempt ${attempt + 1} of ${linkAttempts})`);
            console.warn(formatLlmLogLine(atlasErr));
            await sleep(BACKOFF_MS * attempt);
          }
        }
      }
    }

    // ── Direct-provider fallback for THIS link ──
    const directKey = direct && DIRECT_KEYS[direct.provider]?.();
    if (direct && !directKey) {
      // The silent hole that caused the 2026-08-18 outage: role 'director'
      // declared direct.provider 'anthropic' and no service carries
      // ANTHROPIC_API_KEY, so the configured fallback could never fire and
      // nothing said so. It is now a recorded, coded, named skip.
      record({ provider: direct.provider, model: `direct:${direct.model}`, code: LLM_ERROR_CODES.LLM_AUTH_MISSING, httpStatus: null, ms: 0, ok: false });
      console.warn(formatLlmLogLine(makeLlmError({
        code: LLM_ERROR_CODES.LLM_AUTH_MISSING,
        provider: direct.provider, model: direct.model, role,
        link: linkNo, linkCount: links.length, elapsedMs: 0,
        providerMessage: `no API key configured for direct provider '${direct.provider}'`,
        action: LLM_ACTIONS.SKIPPED_NO_KEY,
        actionDetail: `skipped without attempting — set the ${direct.provider} key, or drop this direct twin`,
      })));
    } else if (direct && directKey && mayStart()) {
      requestsUsed++;
      const t0 = Date.now();
      if (atlasErr) {
        stampLlmAction(atlasErr, LLM_ACTIONS.FELL_BACK_TO_DIRECT_PROVIDER,
          `fell back to direct ${direct.provider}/${direct.model}`);
        console.warn(formatLlmLogLine(atlasErr));
      }
      try {
        const res = await trackLlmCall(
          { ...meta, provider: direct.provider === 'google' ? 'google-openai' : 'openai', model: direct.model, purpose: (meta.purpose || meta.purposeTag || '') + ':direct-fallback' },
          async () => {
            const r = await post(DIRECT_URLS[direct.provider], directKey, buildDirectBody(params, direct), linkTimeoutMs);
            if (r.status !== 200) {
              throw codedHttpError({
                r, provider: direct.provider, model: direct.model, role,
                elapsedMs: Date.now() - t0, attempt: 1, attemptsMax: 1, link: linkNo, linkCount: links.length,
              });
            }
            return r.data;
          }
        );
        record({ provider: direct.provider, model: `direct:${direct.model}`, code: null, httpStatus: 200, ms: Date.now() - t0, ok: true });
        return succeed(res, { role, links, li, viaDirect: true, servedProvider: direct.provider, servedModel: direct.model, chain, startedAt });
      } catch (err) {
        const dErr = codedThrownError({
          err, provider: direct.provider, model: direct.model, role,
          elapsedMs: Date.now() - t0, attempt: 1, attemptsMax: 1, link: linkNo, linkCount: links.length,
        });
        lastErr = dErr;
        record({ provider: direct.provider, model: `direct:${direct.model}`, code: dErr.code, httpStatus: dErr.httpStatus, ms: Date.now() - t0, ok: false });
      }
    }

    // ── Advance, or stop ──
    // Advancement is decided by the ATLAS verdict for this link, because that
    // is the signal about the model/route we were asked for. A direct twin
    // failing tells us about a different provider, not about whether the next
    // candidate is worth trying.
    const advance = !!atlasErr && ADVANCES_CHAIN.has(atlasErr.code);
    if (!isFinal && advance) {
      stampLlmAction(atlasErr, LLM_ACTIONS.ADVANCED_TO_NEXT_LINK,
        `advanced to ${links[li + 1].atlas}`);
      console.warn(formatLlmLogLine(atlasErr));
      continue;
    }
    if (!isFinal && !advance) {
      // Owner-directed scope: transport failures advance, nothing else. A
      // 400/401/402/403 is not a capacity problem, so trying the next model
      // on the same gateway just buys the same answer at another model's
      // price. Stop honestly here.
      break;
    }
  }

  // Every candidate is spent. The action is EXHAUSTED_CHAIN — the truthful
  // transport-level outcome. It is deliberately NOT "gave up on this product":
  // this layer does not know what the caller loses. The caller re-stamps with
  // its own consequence (see campaignAdsGenerationService).
  const summary = formatChainSummary(chain);
  const finalErr = lastErr && lastErr.llmError
    ? lastErr
    : makeLlmError({
        code: LLM_ERROR_CODES.LLM_UNCLASSIFIED, provider: 'atlas', model: links[0]?.atlas, role,
        providerMessage: lastErr && lastErr.message, cause: lastErr,
      });
  stampLlmAction(finalErr, LLM_ACTIONS.EXHAUSTED_CHAIN,
    multi
      ? `gave up — every candidate model failed (${links.length} links tried)`
      : 'gave up — the model and its direct fallback both failed');
  finalErr.chain        = chain;
  finalErr.chainSummary = summary;
  finalErr.role         = role;
  finalErr.elapsedMs    = Date.now() - startedAt;
  console.error(formatLlmLogLine(finalErr));
  if (multi) console.error(`🌐 atlasLlm[${role}]: ${summary}`);
  throw finalErr;
}

/**
 * Attach the chain outcome to a successful response and hand it back.
 *
 * NON-ENUMERABLE on purpose: `completion` objects are handed to callers that
 * JSON.stringify them (artifact persistence, logs), and an extra enumerable
 * key would leak into stored documents. Wrapped in try/catch because a
 * response body is provider-controlled and must never be able to turn a
 * SUCCESSFUL, ALREADY-BILLED call into a throw.
 */
function succeed(res, { role, links, li, viaDirect, servedProvider, servedModel, chain, startedAt }) {
  try {
    Object.defineProperty(res, LLM_CHAIN_PROP, {
      value: Object.freeze({
        role,
        primary:   links[0] && links[0].atlas,
        servedBy:  { provider: servedProvider, model: servedModel },
        link:      li + 1,
        linkCount: links.length,
        viaDirect: !!viaDirect,
        // "degraded" means the caller did NOT get its first-choice route:
        // a later chain link, or a direct-provider fallback of any link.
        degraded:  li > 0 || !!viaDirect,
        attempts:  chain.length,
        chain:     Object.freeze(chain.slice()),
        summary:   formatChainSummary(chain),
        elapsedMs: Date.now() - startedAt,
      }),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch { /* a frozen/exotic body must never fail an already-paid call */ }
  return res;
}

// `stampAction` used to be defined here. It now lives in services/llmError.js
// as the exported `stampLlmAction`, so the transport, the Director and the
// expansion loop all stamp actions through ONE definition — a per-caller copy
// is how one of them ends up claiming a recovery that never happened.

/** Read the chain outcome off a successful completion, or null. */
function chainOutcome(completion) {
  try { return (completion && completion[LLM_CHAIN_PROP]) || null; } catch { return null; }
}

module.exports = {
  chatCompletion,
  isConfigured,
  resolveModel,
  /** Chain outcome of a SUCCESSFUL completion — { degraded, servedBy, summary, … } or null. */
  chainOutcome,
  LLM_CHAIN_PROP,
  // exposed for verify harnesses (token ceiling + reserve)
  buildAtlasBody,
  REASONING_RESERVE_TOKENS,
  ATLAS_MAX_OUTPUT_TOKENS,
  // exposed for verify harnesses (chain tuning — asserted against the
  // measured latencies in the CHAIN_* comment block)
  CHAIN_LINK_TIMEOUT_MS,
  CHAIN_BUDGET_MS,
  CHAIN_MAX_ATTEMPTS
};
