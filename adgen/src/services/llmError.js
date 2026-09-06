'use strict';

// Single source of truth for "what kind of LLM failure is this, and what
// should a human actually DO about it?".
//
// WHY THIS EXISTS
// Image/video failures already have services/atlasErrorPolicy.js. Do NOT
// import or "harmonise" with it. The money path is different, and folding
// the two together is how a 429 on Claude gets treated like a billable
// image submit (or the reverse: an image 500 that may have created a
// running task gets retried as if it were a free LLM 500).
//
//   Image/video 500/504/network — outcome UNKNOWN; a task may already
//     exist and a second submit is a second charge. Policy is 'probe'.
//   LLM 4xx/5xx/unrouted/auth/quota — documented: "failed LLM requests
//     are never billed." Tokens are charged per actual usage, so a
//     request that never produced tokens costs $0. Retrying the SAME
//     model after a 429/5xx is free. Our OWN client timeout, and a
//     transport drop before any body, are the ambiguous cases: the
//     upstream may have completed and billed tokens we never received.
//
// SOURCES — documented behaviour, not inferred:
//   - "Failed requests and failed tasks are not charged."
//   - Failed LLM requests are never billed. LLMs are charged per actual
//     token usage (already recorded in atlasErrorPolicy.js's header).
//   - 402 Payment Required once the balance is depleted.
//   - 429 on RPM / TPM / concurrency, per account tier and model.
//   - Atlas signals a listed-but-unrouted model with HTTP 400
//     "router not found" (atlasLlmService.atlasRouterMissing). Catalog
//     listing alone is not routability — openai/gpt-5-nano is listed
//     and 400s.
//
// VERIFIED AGAINST LIVE RESPONSES (2026-08-18), same API key, sequential
// single calls — Atlas is capacity-starved on several DIRECT Anthropic
// routes:
//   anthropic/claude-sonnet-5    HTTP 429 "too many requests" after ~51s
//   anthropic/claude-opus-5      HTTP 429 after ~50s
//   anthropic/claude-sonnet-4.6  HTTP 200 but 52s
//   openai/gpt-5.6-terra         HTTP 200 in 1.0s
//   google/gemini-2.5-pro        HTTP 200 in 1.7s
// A 429 costs ~50s BEFORE it returns. That latency fact is why the
// codes MUST distinguish 429 from timeout: treating a 50s 429 as "the
// client timed out" points the operator at ATLAS_LLM_TIMEOUT_MS (default
// 120s, which never even fired) instead of at the chain. Advancing
// sonnet-5 → opus-5 wastes another ~50s on the same starved class;
// terra / gemini-2.5-pro are the links that actually return.
//
// THIS MODULE IS PURE. It never throws, never logs, never does I/O.
// Callers set `action` AFTER the control flow runs, not before.

// ── codes ────────────────────────────────────────────────────────────
// keys === values. Add a code HERE, in CODE_META, and in classify (or
// the explicit-raise comment) together, or the next reader will invent
// a synonym and the logs will stop being greppable.

const LLM_ERROR_CODES = Object.freeze({
  LLM_RATE_LIMITED:        'LLM_RATE_LIMITED',
  LLM_TIMEOUT:             'LLM_TIMEOUT',
  LLM_BAD_REQUEST:         'LLM_BAD_REQUEST',
  LLM_AUTH_MISSING:        'LLM_AUTH_MISSING',
  LLM_AUTH_REJECTED:       'LLM_AUTH_REJECTED',
  LLM_QUOTA_EXHAUSTED:     'LLM_QUOTA_EXHAUSTED',
  LLM_MODEL_UNROUTED:      'LLM_MODEL_UNROUTED',
  LLM_UPSTREAM_ERROR:      'LLM_UPSTREAM_ERROR',
  LLM_NETWORK_ERROR:       'LLM_NETWORK_ERROR',
  LLM_CONTENT_EMPTY:       'LLM_CONTENT_EMPTY',
  LLM_CONTENT_TRUNCATED:   'LLM_CONTENT_TRUNCATED',
  LLM_CONTENT_UNPARSEABLE: 'LLM_CONTENT_UNPARSEABLE',
  LLM_CONTRACT_UNMET:      'LLM_CONTRACT_UNMET',
  LLM_REFUSED:             'LLM_REFUSED',
  LLM_UNCLASSIFIED:        'LLM_UNCLASSIFIED'
});

// Per-code operator card. `meaning` is a short verb-phrase so
// makeLlmError can compose "<model> via <provider> <meaning>".
// `operatorAction` is the whole point of this module: what a HUMAN
// should do at 2am, not what the code intends to do.
//
// billable is derived, never accepted from a caller:
//   false     — documented: failed LLM requests are never billed
//   true      — HTTP 200; tokens were generated and billed
//   'unknown' — we stopped waiting or never saw the reply; upstream
//               may have completed and billed
//
// retryable answers "is another attempt at THIS link/payload worth
// trying", not "should the chain advance". Advancing is an action,
// not a retry.

const CODE_META = Object.freeze({
  LLM_RATE_LIMITED: Object.freeze({
    retryable: true,
    billable: false, // 429: request refused, no tokens, $0
    meaning: 'is rate-limiting this model',
    operatorAction:
      'Do not wait on this model and do not raise ATLAS_LLM_TIMEOUT_MS — a 429 already burned ~50s before returning (measured 2026-08-18 on anthropic/claude-sonnet-5 and claude-opus-5). Advance the chain to a non-Anthropic link (openai/gpt-5.6-terra 1.0s / google/gemini-2.5-pro 1.7s). Another DIRECT Anthropic hop will 429 in another ~50s.'
  }),
  LLM_TIMEOUT: Object.freeze({
    retryable: true,
    // Our deadline, not theirs. Atlas/the vendor may have finished
    // and billed tokens we never received. Opposite of a 429 (which
    // is a definite refusal and definite $0).
    billable: 'unknown',
    meaning: 'timed out waiting for a reply',
    operatorAction:
      'We stopped waiting (ATLAS_LLM_TIMEOUT_MS, default 120s). Check Atlas usage / the request_id before replaying the same call — this is the ambiguous billing case. If the slug is a DIRECT Anthropic route, prefer advancing to terra / gemini-2.5-pro over raising the timeout; sonnet-4.6 already needs 52s on a SUCCESS.'
  }),
  LLM_BAD_REQUEST: Object.freeze({
    retryable: false,
    billable: false, // 4xx: refused before generation
    meaning: 'rejected this request as invalid',
    operatorAction:
      'Do not retry the same payload and do not diagnose this as a rate limit. Read the provider message: common causes are sampling params on Claude 5, json_schema on Anthropic (HTTP 400), or a field the gateway does not accept. Fix the body or the model map. A truly malformed request will fail the direct-provider fallback too.'
  }),
  LLM_AUTH_MISSING: Object.freeze({
    retryable: false,
    billable: false, // we never sent a request
    meaning: 'has no API key configured',
    operatorAction:
      "set the provider's API key on both Render services, or remove that link from the chain — this link is being skipped silently today"
  }),
  LLM_AUTH_REJECTED: Object.freeze({
    retryable: false,
    billable: false, // 401/403: refused, no tokens
    meaning: 'rejected the API key',
    operatorAction:
      'The key was sent and rejected (401/403). Do NOT rotate a working key if the body mentions quota/balance — that is LLM_QUOTA_EXHAUSTED and the key is fine. For a genuine 401, replace ATLAS_API_KEY (or the direct-provider key) on BOTH Render services (WEB srv-d1vuktqli9vc73ft07ng and WORKER srv-d8128c1o3t8c73e8kb30).'
  }),
  LLM_QUOTA_EXHAUSTED: Object.freeze({
    retryable: false,
    billable: false, // 402 / quota 403: refused, no tokens
    meaning: 'has exhausted its quota or balance',
    operatorAction:
      'Account balance or spending limit is gone (402, or a 403 whose body says quota/balance). Top up the Atlas (or direct-provider) wallet. Do NOT rotate the API key — the key is fine. Must outrank a bare 403 so a credit outage is not mishandled as a permissions problem.'
  }),
  LLM_MODEL_UNROUTED: Object.freeze({
    retryable: false,
    billable: false, // 400 router-not-found: refused, no tokens
    meaning: 'has no router for this model',
    operatorAction:
      "This slug is listed in the catalog but has no router (Atlas 400 'router not found' — openai/gpt-5-nano is the canonical example). Re-point the role in atlasModelMap / ATLAS_MODEL_<ROLE> to a slug that was probed live. Do not treat this as LLM_BAD_REQUEST: a listed-but-unrouted model is an operator config problem, and classifying it as our own bad payload is how nobody re-points the role."
  }),
  LLM_UPSTREAM_ERROR: Object.freeze({
    retryable: true,
    // LLM 5xx ≠ image 5xx. No prediction id, no running task, failed
    // LLM requests are never billed. Retrying the same model is free.
    billable: false,
    meaning: 'returned a server error',
    operatorAction:
      'Provider 5xx. Safe to retry the same model a few times (failed LLM requests are never billed — there is no image-style running task to probe). If it persists, advance to the next chain link rather than sitting on a down route.'
  }),
  LLM_NETWORK_ERROR: Object.freeze({
    retryable: true,
    // Never saw a reply. The POST may have been delivered and billed.
    billable: 'unknown',
    meaning: 'could not be reached',
    operatorAction:
      'Transport failed before we saw a reply (reset/refused/DNS/hang-up). The request MAY have been delivered and billed — check request_id / provider usage before replaying. If it keeps happening, advance to the next link rather than hammering the same host.'
  }),
  LLM_CONTENT_EMPTY: Object.freeze({
    retryable: true,
    // HTTP 200. Hidden reasoning often ate max_tokens (finish_reason
    // 'length', empty message) — tokens were generated and billed.
    billable: true,
    meaning: 'returned an empty message (tokens billed)',
    operatorAction:
      'HTTP 200, tokens billed, choices[0].message.content was empty (often finish_reason=length after hidden reasoning ate max_tokens). Raise ATLAS_REASONING_RESERVE_TOKENS or the caller max_tokens. A same-payload retry usually reproduces this; a corrective re-ask with more budget is the designed next step, not a transport retry.'
  }),
  LLM_CONTENT_TRUNCATED: Object.freeze({
    retryable: false,
    // HTTP 200 with real content that stopped mid-object. Tokens were
    // generated and billed — arguably the most expensive failure class here,
    // because you pay for the whole truncated response and get nothing.
    billable: true,
    meaning: 'ran out of output budget mid-response (tokens billed)',
    operatorAction:
      'HTTP 200, finish_reason=length: the model was still writing when the token budget ran out. A "return JSON only" re-ask CANNOT fix this and must not be attempted — raise the caller budget instead (DIRECTOR_ROUND_TOKENS for the Director, ATLAS_REASONING_RESERVE_TOKENS for hidden-reasoning headroom). Distinct from LLM_CONTENT_EMPTY: there content never arrived, here it arrived and was cut off, and only this one names the token lever.'
  }),
  LLM_CONTENT_UNPARSEABLE: Object.freeze({
    retryable: true,
    billable: true, // HTTP 200, tokens generated
    meaning: 'returned text that did not parse (tokens billed)',
    operatorAction:
      'HTTP 200, tokens billed, body was not the JSON the caller required. Use the existing salvage + one-shot corrective reask (shares the attempt budget — worst case stays two paid Director calls). Do not treat this as a transport failure and do not replay an identical prompt forever.'
  }),
  LLM_CONTRACT_UNMET: Object.freeze({
    retryable: true,
    // HTTP 200, valid JSON, tokens billed — and then discarded because the
    // payload did not satisfy the caller's contract. The "paid for it and
    // threw it away" case.
    billable: true,
    meaning: 'returned well-formed output that failed the caller contract (tokens billed)',
    operatorAction:
      'The model answered and the JSON parsed, but the payload was unusable (e.g. zero concepts, or every concept missing a required field). Tokens were billed and the result discarded. This is a PROMPT or MODEL-CHOICE problem, not a transport one: check the OUTPUT CONTRACT block and the validator reasons in the log. Retrying the identical prompt against the same model usually reproduces it.'
  }),
  LLM_REFUSED: Object.freeze({
    retryable: true,
    billable: true, // HTTP 200, the refusal text was generated
    meaning: 'refused the task instead of answering (tokens billed)',
    operatorAction:
      'HTTP 200, the model answered with a refusal or a clarifying question instead of the contract (Director: "I don\'t have enough information…"). Tokens billed. Re-ask once with the OUTPUT CONTRACT reminder; if it refuses again, give up the product — a thin brief will keep refusing and each attempt is paid.'
  }),
  LLM_UNCLASSIFIED: Object.freeze({
    retryable: false,
    // No HTTP class, no transport code, no timeout wording. Could be a
    // 200 we did not expect or a thrown string. Do not guess $0.
    billable: 'unknown',
    meaning: 'failed in an unrecognised way',
    operatorAction:
      'Failure shape matched nothing. Do not guess a retry and do not invent a new code at the call site. Capture httpStatus, errCode, request_id and the first 200 chars of the body and add a real code here — this is how the next classification gets added.'
  })
});

// ── actions ──────────────────────────────────────────────────────────
//
// TRUTHFULNESS RULE — read this before setting `action` at a call site.
//
// The action MUST be the outcome that ACTUALLY happened, never the
// intent. It is stamped by the control flow AFTER that flow runs
// (after the retry, after the advance, after the skip), not hardcoded
// beside a call where a later edit makes it a lie.
//
//   RETRIED_SAME_MODEL          — we already sent the same slug again
//   ADVANCED_TO_NEXT_LINK       — we already moved to the next chain hop
//   FELL_BACK_TO_DIRECT_PROVIDER— we already left Atlas for openai/google
//   CORRECTIVE_REASK            — we already issued the salvage re-ask
//   SKIPPED_NO_KEY              — we already skipped this link (no key)
//   GAVE_UP_PRODUCT             — this SKU is done; no more attempts
//   GAVE_UP_RUN                 — the whole run is done
//   NONE                        — nothing happened yet / informational
//
// If you are about to write `action: LLM_ACTIONS.ADVANCED_TO_NEXT_LINK`
// on the error you throw BEFORE the `continue` that advances, don't.
// Stamp it on the way out of the branch that actually advanced.

const LLM_ACTIONS = Object.freeze({
  RETRIED_SAME_MODEL:           'RETRIED_SAME_MODEL',
  ADVANCED_TO_NEXT_LINK:        'ADVANCED_TO_NEXT_LINK',
  FELL_BACK_TO_DIRECT_PROVIDER: 'FELL_BACK_TO_DIRECT_PROVIDER',
  CORRECTIVE_REASK:             'CORRECTIVE_REASK',
  SKIPPED_NO_KEY:               'SKIPPED_NO_KEY',
  // Transport-level give-up: every candidate in the chain is spent. It is
  // deliberately NOT the same as GAVE_UP_PRODUCT — the transport does not
  // know what the caller loses, and claiming "no ads for this product" from
  // a layer that cannot see products is exactly the class of untrue status
  // line this taxonomy exists to stop. The caller re-stamps with its own
  // consequence.
  EXHAUSTED_CHAIN:              'EXHAUSTED_CHAIN',
  GAVE_UP_PRODUCT:              'GAVE_UP_PRODUCT',
  GAVE_UP_RUN:                  'GAVE_UP_RUN',
  NONE:                         'NONE'
});

const ACTION_PHRASE = Object.freeze({
  RETRIED_SAME_MODEL:           'retried the same model',
  ADVANCED_TO_NEXT_LINK:        'advanced to the next chain link',
  FELL_BACK_TO_DIRECT_PROVIDER: 'fell back to the direct provider',
  CORRECTIVE_REASK:             'issued a corrective re-ask',
  SKIPPED_NO_KEY:               'skipped — no API key',
  EXHAUSTED_CHAIN:              'gave up — every candidate model failed',
  GAVE_UP_PRODUCT:              'gave up this product',
  GAVE_UP_RUN:                  'gave up the run',
  NONE:                         null
});

/**
 * Which codes make a cross-provider chain ADVANCE to its next link.
 *
 * TRANSPORT FAILURES ONLY — owner-scoped, 2026-08-18. Deliberately NOT the
 * same set as `retryable`: LLM_MODEL_UNROUTED is not worth retrying against
 * the same model but IS worth trying the next candidate, and the two
 * LLM_CONTENT_* codes are retryable-by-re-ask yet must NEVER advance a chain.
 *
 * WHY CONTENT MUST NOT ADVANCE: a 200 whose body is prose instead of JSON is
 * a prompt-compliance problem. Another model will not reliably fix it, the
 * caller already owns a one-shot corrective re-ask for exactly this, and
 * advancing would silently multiply PAID calls per round. This set is the
 * single place that rule is expressed.
 *
 * Auth/quota/bad-request are absent on purpose: they fail identically on the
 * next candidate of the same gateway, so advancing buys the same answer at
 * another model's price.
 */
const ADVANCES_CHAIN = Object.freeze(new Set([
  LLM_ERROR_CODES.LLM_RATE_LIMITED,
  LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
  LLM_ERROR_CODES.LLM_TIMEOUT,
  LLM_ERROR_CODES.LLM_NETWORK_ERROR,
  LLM_ERROR_CODES.LLM_MODEL_UNROUTED,
  // Atlas itself unconfigured: the link cannot be tried, but the NEXT link's
  // direct twin might have a key of its own, so this must not stop the walk.
  LLM_ERROR_CODES.LLM_AUTH_MISSING,
]));

/**
 * HTTP-200 classes: the provider answered, tokens were generated and BILLED,
 * and the response was unusable. Enumerated so "must never advance a chain"
 * and "is a content problem, not a transport one" are one list instead of a
 * condition re-derived per call site.
 *
 * INVARIANT (pinned): CONTENT_CODES ∩ ADVANCES_CHAIN = ∅. Advancing on bad
 * content would silently multiply PAID calls for a prompt-compliance problem
 * that a different model does not reliably fix.
 */
const CONTENT_CODES = Object.freeze(new Set([
  LLM_ERROR_CODES.LLM_CONTENT_EMPTY,
  LLM_ERROR_CODES.LLM_CONTENT_TRUNCATED,
  LLM_ERROR_CODES.LLM_CONTENT_UNPARSEABLE,
  LLM_ERROR_CODES.LLM_CONTRACT_UNMET,
  LLM_ERROR_CODES.LLM_REFUSED,
]));

/**
 * Is another attempt at THIS SAME link worth making?
 *
 * ⚠️ THIS IS NOT `ADVANCES_CHAIN`, AND CONFLATING THEM WAS A REAL REGRESSION.
 * The two answer different questions:
 *   ADVANCES_CHAIN     — "is a DIFFERENT candidate worth trying?"
 *   shouldRetrySameLink — "is the SAME model, same payload, worth re-sending?"
 * A listed-but-unrouted model is the clearest case where they diverge: the
 * next candidate may well work, but re-asking THIS one buys three identical
 * 400s and two backoffs. Using the advance-set for both silently added two
 * extra round trips to every mis-pointed `ATLAS_MODEL_*` and every dead slug —
 * and this repo has hit exactly that (`openai/gpt-5-nano` is listed in the
 * catalog and returns "router not found").
 *
 * THIS FUNCTION REPRODUCES THE PRE-CHAIN PREDICATE EXACTLY. Before the chain,
 * atlasLlmService decided with:
 *     if (err.routerMissing) break;
 *     if (err.status && !retryableStatus(err.status)) break;   // 429/5xx retry
 *     if (!err.status && !retryableError(err) && !/timeout/i.test(msg)) break;
 *   where retryableError = code ∈ {ECONNRESET, ETIMEDOUT, ECONNABORTED, EAI_AGAIN}
 * Every single-link role (eleven services) depends on that shape, so it is
 * reproduced term for term rather than approximated.
 *
 * WHY THE TRANSPORT CODE IS CONSULTED, and why a pure code-set cannot do this:
 * `LLM_NETWORK_ERROR` is deliberately one class for the operator, but the old
 * predicate split it. ECONNRESET and EAI_AGAIN are transient — a reset socket
 * or a temporary DNS failure really can succeed 3s later. ECONNREFUSED,
 * ENOTFOUND and EPIPE will not fix themselves on that timescale: the host is
 * wrong, gone, or closed the pipe. Retrying those burns MAX_ATTEMPTS and two
 * backoffs to learn nothing, so they skip straight to the fallback — which is
 * a DIFFERENT HOST and therefore the only thing that could actually help.
 * Consulting `transportCode` also keeps the no-code case exact: an error whose
 * message merely mentions "socket hang up" with no `err.code` was NOT retried
 * before, and is not retried now.
 */
const RETRY_TRANSIENT_TRANSPORT_CODES = Object.freeze(['ECONNRESET', 'EAI_AGAIN']);

function shouldRetrySameLink(err) {
  if (!err) return false;
  const code = knownCode(err.code || err.llmCode);
  // 429 and 5xx: the old retryableStatus set, unchanged.
  if (code === LLM_ERROR_CODES.LLM_RATE_LIMITED) return true;
  if (code === LLM_ERROR_CODES.LLM_UPSTREAM_ERROR) return true;
  // Our own deadline: old ETIMEDOUT / ECONNABORTED / /timeout/i message.
  if (code === LLM_ERROR_CODES.LLM_TIMEOUT) return true;
  // Transient transport only — see the comment above.
  if (code === LLM_ERROR_CODES.LLM_NETWORK_ERROR) {
    return RETRY_TRANSIENT_TRANSPORT_CODES.indexOf(String(err.transportCode || '')) !== -1;
  }
  // Everything else — unrouted, 4xx, auth, quota, content, unclassified —
  // fails identically on a re-send.
  return false;
}

const REQUEST_ID_MAX = 200;
const LOG_TAIL_MAX = 300;
const CHAIN_SUMMARY_MAX = 600;
const STORED_TEXT_MAX = 1000;

const TIMEOUT_ERR_CODES = Object.freeze(['ETIMEDOUT', 'ECONNABORTED']);
const NETWORK_ERR_CODES = Object.freeze([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'
]);
const REQUEST_ID_HEADERS = Object.freeze([
  'x-request-id', 'x-requestid', 'request-id', 'openai-request-id'
]);

// ── tiny pure helpers (never throw) ──────────────────────────────────

function formatSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '0.0';
  return (n / 1000).toFixed(1);
}

function asText(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

function boundText(v, max) {
  const t = asText(v);
  if (!t) return null;
  const n = Number(max);
  if (!Number.isFinite(n) || n < 1) return t;
  return t.length > n ? t.slice(0, n) : t;
}

function asNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerceHttp(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  // Node err codes (ECONNRESET) Number() to NaN; reject non-positive
  // so a stray 0 does not look like a real status.
  if (!Number.isFinite(n) || n < 100 || n > 599) return null;
  return n;
}

function oneLine(v) {
  if (v == null) return '';
  try {
    return String(v).replace(/[\r\n]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

function clipTail(s, max) {
  const t = oneLine(s);
  const cap = Number.isFinite(Number(max)) ? Number(max) : LOG_TAIL_MAX;
  if (!t) return '';
  if (t.length <= cap) return t;
  if (cap <= 1) return '…';
  return t.slice(0, cap - 1) + '…';
}

// own() rather than `MAP[key]`, and this is not pedantry: these maps are
// plain frozen objects, so they inherit Object.prototype. A caller passing
// the string 'toString' or 'constructor' would make `LLM_ERROR_CODES[s]`
// truthy and hand back a FUNCTION as the error code — which then lands in a
// log line, a Slack field, and a Mongo document. Every lookup keyed on
// caller-supplied text goes through here.
const own = (obj, key) =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

function knownCode(v) {
  const s = asText(v);
  return own(LLM_ERROR_CODES, s) ? LLM_ERROR_CODES[s] : LLM_ERROR_CODES.LLM_UNCLASSIFIED;
}

function knownAction(v) {
  const s = asText(v);
  return own(LLM_ACTIONS, s) ? LLM_ACTIONS[s] : LLM_ACTIONS.NONE;
}

function metaFor(code) {
  return own(CODE_META, code) ? CODE_META[code] : CODE_META.LLM_UNCLASSIFIED;
}

function actionPhrase(action) {
  return own(ACTION_PHRASE, action) ? ACTION_PHRASE[action] : null;
}

// Pull every human-readable scrap out of message + body so a single
// regex pass can see Atlas `{error:"router not found"}`, OpenAI
// `{error:{message}}`, and a raw string body. JSON.stringify is last
// and try/caught — circular bodies (axios) must not throw.
function flattenForMatch(message, body) {
  const chunks = [];
  const push = (v) => {
    if (v == null || v === '') return;
    try { chunks.push(String(v)); } catch (_) { /* ignore */ }
  };
  push(message);
  if (body == null || body === '') return chunks.join(' ');
  if (typeof body === 'string') {
    push(body);
    return chunks.join(' ');
  }
  if (typeof body !== 'object') {
    push(body);
    return chunks.join(' ');
  }
  try {
    if (typeof body.message === 'string') push(body.message);
    const err = body.error;
    if (typeof err === 'string') {
      push(err);
    } else if (err && typeof err === 'object' && !Array.isArray(err)) {
      if (typeof err.message === 'string') push(err.message);
      if (typeof err.code === 'string') push(err.code);
      if (typeof err.type === 'string') push(err.type);
    }
    push(JSON.stringify(body));
  } catch (_) {
    // circular / bigint / thrown toString — the scraps above still count
  }
  return chunks.join(' ');
}

function firstId(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (let i = 0; i < candidates.length; i++) {
    const t = boundText(candidates[i], REQUEST_ID_MAX);
    if (t) return t;
  }
  return null;
}

// ── classify ─────────────────────────────────────────────────────────
//
// LLM_AUTH_MISSING, LLM_CONTENT_EMPTY, LLM_CONTENT_UNPARSEABLE and
// LLM_REFUSED are NOT reachable from classifyLlmFailure. They are
// raised explicitly by call sites that know something this function
// cannot: no key configured; an HTTP 200 whose body did not parse or
// whose text was a refusal. Do not "fix" the omission by matching
// empty-content wording in here — a 200 is success at the transport
// layer and classifying it as a failure from the status alone would
// mark every well-formed reply unrouted/unclassified.
//
// Precedence is explicit because real cases collide. Order:
//   1. unrouted          BEFORE generic 400, or a listed-but-unrouted
//                        model reads as our own bad request and nobody
//                        re-points the role
//   2. rate limit        BEFORE timeout — a 429 already took ~50s
//   3. quota             BEFORE 403 — a credit outage must not look
//                        like a permissions problem that makes someone
//                        rotate a perfectly good key
//   4. 401 / leftover 403 → auth rejected
//   5. 400 / 422          → bad request (unrouted already taken)
//   6. any other 4xx      → bad request
//   7. >= 500             → upstream (BEFORE timeout wording in a 504
//                        body, so a real 5xx stays a 5xx)
//   8. ETIMEDOUT /
//      ECONNABORTED /
//      /timeout|timed out/i
//                         → timeout. axios uses ECONNABORTED for our
//                        TIMEOUT_MS, not ETIMEDOUT.
//   9. reset/refused/DNS /
//      hang-up            → network
//  10. else               → unclassified

function classifyLlmFailure(input) {
  try {
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const httpFromStatus = coerceHttp(src.httpStatus);
    const httpFromCode = coerceHttp(src.errCode);
    const http = httpFromStatus != null ? httpFromStatus : httpFromCode;
    const errCode = src.errCode == null ? '' : String(src.errCode);
    const text = flattenForMatch(src.message, src.body);

    // 1. Unrouted. routerMissing is the flag atlasLlmService already
    //    stamps; honour it strictly (`=== true`, not truthy) so a
    //    leaked string "false" cannot re-point a healthy role.
    //
    //    The WORDING arms are STATUS-SCOPED to 4xx (or an unknown status).
    //    Unscoped they would outrank every later rule: a 429 or a 503 whose
    //    body happens to mention a missing model would be reported as an
    //    operator config problem, and somebody would re-point a healthy role
    //    in the middle of a capacity outage. Scoping costs nothing — Atlas
    //    only ever says "router not found" on a 400.
    const clientish = http == null || (http >= 400 && http < 500);
    if (src.routerMissing === true) return LLM_ERROR_CODES.LLM_MODEL_UNROUTED;
    if (clientish && /router not found|model .* not found|unknown model/i.test(text)) {
      return LLM_ERROR_CODES.LLM_MODEL_UNROUTED;
    }

    // 2. Rate limit. Status OR wording — Atlas has returned a 429
    //    body whose envelope code was missing.
    if (http === 429 || (clientish && /rate limit|too many requests/i.test(text))) {
      return LLM_ERROR_CODES.LLM_RATE_LIMITED;
    }

    // 3. Quota outranks 403. A 403 whose body says "quota" / "spending
    //    limit" / "insufficient balance" is a billing outage, and telling
    //    an operator to rotate a perfectly good key during one wastes the
    //    outage. Same status-scoping as above, and for the same reason: an
    //    unscoped /quota/ would capture any 5xx whose body mentions the word.
    if (http === 402 || ((http === 403 || http == null) &&
        /insufficient balance|payment required|quota|spending limit/i.test(text))) {
      return LLM_ERROR_CODES.LLM_QUOTA_EXHAUSTED;
    }

    // 4. Auth. 401 always; 403 only if the quota regex above missed.
    if (http === 401 || http === 403) return LLM_ERROR_CODES.LLM_AUTH_REJECTED;

    // 5–6. Client errors that are not unrouted / auth / quota.
    if (http === 400 || http === 422) return LLM_ERROR_CODES.LLM_BAD_REQUEST;
    if (http != null && http >= 400 && http < 500) return LLM_ERROR_CODES.LLM_BAD_REQUEST;

    // 7. Provider fault. Failed LLM 5xx is unbilled; retry is free.
    if (http != null && http >= 500) return LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;

    // 8. Our deadline. Distinguished from 429 because the 429 already
    //    returned (after ~50s); a timeout means we never got a status.
    if (TIMEOUT_ERR_CODES.indexOf(errCode) !== -1 || /timeout|timed out/i.test(text)) {
      return LLM_ERROR_CODES.LLM_TIMEOUT;
    }

    // 9. Transport. Request may have been delivered.
    if (NETWORK_ERR_CODES.indexOf(errCode) !== -1 || /socket hang up|network|getaddrinfo/i.test(text)) {
      return LLM_ERROR_CODES.LLM_NETWORK_ERROR;
    }

    return LLM_ERROR_CODES.LLM_UNCLASSIFIED;
  } catch (_) {
    return LLM_ERROR_CODES.LLM_UNCLASSIFIED;
  }
}

// ── request id ───────────────────────────────────────────────────────
// Atlas puts `request_id` on error bodies. OpenAI puts `x-request-id`
// on the HEADER and sometimes `error.request_id` on the body. Look
// in this order, then stop:
//   body.request_id
//   body.requestId
//   body.error?.request_id
//   body.id
//   headers: x-request-id, x-requestid, request-id, openai-request-id
// Header lookup is case-insensitive — axios lowercases, other clients
// do not, and we do not rely on either. Bound to 200 chars. Never
// throw on strings / arrays / null / circular bodies.

function extractRequestId(body, headers) {
  try {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      let fromError;
      if (body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
        fromError = body.error.request_id;
      }
      const fromBody = firstId([body.request_id, body.requestId, fromError, body.id]);
      if (fromBody) return fromBody;
    }
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
    const lower = Object.create(null);
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (typeof k === 'string') lower[k.toLowerCase()] = headers[k];
    }
    const headerCandidates = [];
    for (let i = 0; i < REQUEST_ID_HEADERS.length; i++) {
      headerCandidates.push(lower[REQUEST_ID_HEADERS[i]]);
    }
    return firstId(headerCandidates);
  } catch (_) {
    return null;
  }
}

// ── error object ─────────────────────────────────────────────────────
// Plain Error + own properties. retryable / billable come from
// CODE_META — a caller passing a contradicting value is ignored.
// Unknown code → LLM_UNCLASSIFIED; unknown action → NONE.
// `cause` is non-enumerable so JSON.stringify does not drag an axios
// error graph along. We never attach a response object.

function sanitizeChain(chain) {
  if (!Array.isArray(chain)) return null;
  const out = [];
  for (let i = 0; i < chain.length; i++) {
    const rec = chain[i];
    if (!rec || typeof rec !== 'object') {
      out.push({ provider: null, model: null, code: null, httpStatus: null, ms: null, ok: false });
      continue;
    }
    out.push({
      provider: asText(rec.provider),
      model: asText(rec.model),
      code: asText(rec.code),
      httpStatus: coerceHttp(rec.httpStatus),
      ms: asNum(rec.ms),
      ok: rec.ok === true
    });
  }
  return out;
}

function buildHumanMessage(fields) {
  const code = fields.code;
  const meta = metaFor(code);
  const model = fields.model;
  const provider = fields.provider;
  const consequence = fields.consequence;
  const clause = consequence || meta.meaning || 'LLM call failed';

  let mid;
  if (consequence && model && consequence.indexOf(model) !== -1) {
    // Caller already wrote the full sentence (includes the slug).
    mid = consequence;
  } else {
    const who = [];
    if (model) who.push(model);
    if (provider) who.push('via ' + provider);
    mid = (who.length ? who.join(' ') + ' ' : '') + clause;
  }

  const extras = [];
  if (fields.httpStatus != null) extras.push('HTTP ' + fields.httpStatus);
  if (fields.elapsedMs != null) extras.push('after ' + formatSec(fields.elapsedMs) + 's');
  const alreadyHasTiming = consequence && /HTTP\s+\d+|after\s+\d/i.test(consequence);
  if (extras.length && !alreadyHasTiming) mid += ' (' + extras.join(' ') + ')';

  // THE PROVIDER'S OWN TEXT MUST SURVIVE INTO `.message`, and this is a
  // backwards-compatibility requirement, not a nicety.
  // services/judgeService.js:322-334 retries a Cloudinary CDN race by
  // matching `err.status === 400 && /Timeout while downloading/i.test(
  // err.message)` — the wording comes from the PROVIDER body, which used to
  // be embedded verbatim in `Atlas 400: {...}`. Drop it here and that retry
  // silently stops firing while every test stays green (source-text
  // harnesses cannot see it, and it only manifests as a lost judge run).
  // Grep before shortening this: `codedHttpError` feeds providerMessage in.
  const pm = fields.providerMessage;
  if (pm) mid += ': ' + pm;

  return '[' + code + '] ' + mid;
}

function makeLlmError(fields) {
  try {
    const src = (fields && typeof fields === 'object' && !Array.isArray(fields)) ? fields : {};
    const code = knownCode(src.code);
    const action = knownAction(src.action);
    const meta = metaFor(code);
    const picked = {
      code,
      action,
      actionDetail: boundText(src.actionDetail, STORED_TEXT_MAX),
      provider: asText(src.provider),
      model: asText(src.model),
      role: asText(src.role),
      httpStatus: coerceHttp(src.httpStatus),
      requestId: boundText(src.requestId, REQUEST_ID_MAX),
      elapsedMs: asNum(src.elapsedMs),
      attempt: asNum(src.attempt),
      attemptsMax: asNum(src.attemptsMax),
      link: asNum(src.link),
      linkCount: asNum(src.linkCount),
      chain: sanitizeChain(src.chain),
      // The ORIGINAL node/axios code (ECONNABORTED, ENOTFOUND, …), kept
      // because `err.code` is overwritten with the taxonomy code below.
      // Taken from an explicit field or lifted off the cause.
      transportCode: asText(src.transportCode) || (src.cause && asText(src.cause.code)) || null,
      providerMessage: boundText(src.providerMessage, STORED_TEXT_MAX),
      consequence: boundText(src.consequence, STORED_TEXT_MAX)
    };

    // baseMessage is the diagnosis WITHOUT the action clause. Re-stamping the
    // action is normal (retry → advance → give up all land on one object), so
    // the message is rebuilt from this each time rather than string-surgered:
    // a regex that ate one em dash too many would corrupt the diagnosis on
    // the second pass, and the second pass is the one an operator reads.
    const baseMessage = oneLine(buildHumanMessage(picked)) || ('[' + code + '] LLM call failed');
    const actClause = picked.actionDetail || actionPhrase(action);
    const err = new Error(actClause ? baseMessage + ' — ' + actClause : baseMessage);
    err.baseMessage = baseMessage;
    err.llmError = true;
    err.code = code;
    // Unambiguous alias. `err.code` is the coordinator-requested branch point,
    // but `code` is ALSO where axios/node put transport codes (ECONNABORTED),
    // so anything that must be sure it is reading OUR taxonomy reads llmCode.
    err.llmCode = code;
    // ⚠️ `err.code` is DELIBERATELY the taxonomy code (callers branch on it),
    // which OVERWRITES the node/axios transport code. That is a landmine if
    // the original is simply lost — `shouldRetrySameLink` needs ECONNRESET vs
    // ECONNREFUSED to reproduce the pre-chain retry set, and an operator
    // reading a log needs to know which syscall failed. So it is preserved
    // here rather than discarded, and documented in docs/ALERTING.md.
    err.transportCode = picked.transportCode;
    err.action = action;
    err.retryable = meta.retryable;
    err.billable = meta.billable;
    err.actionDetail = picked.actionDetail;
    err.provider = picked.provider;
    err.model = picked.model;
    err.role = picked.role;
    err.httpStatus = picked.httpStatus;
    // LEGACY ALIAS — load-bearing, do not remove. The pre-taxonomy transport
    // set `e.status = r.status`, and services/judgeService.js:326 branches on
    // `err?.status === 400` to retry a Cloudinary CDN race. Dropping this
    // turns that retry into dead code with nothing failing.
    err.status = picked.httpStatus;
    err.requestId = picked.requestId;
    err.elapsedMs = picked.elapsedMs;
    err.attempt = picked.attempt;
    err.attemptsMax = picked.attemptsMax;
    err.link = picked.link;
    err.linkCount = picked.linkCount;
    err.chain = picked.chain;
    err.providerMessage = picked.providerMessage;
    err.consequence = picked.consequence;

    if (src.cause != null) {
      Object.defineProperty(err, 'cause', {
        value: src.cause,
        enumerable: false,
        writable: true,
        configurable: true
      });
    }
    return err;
  } catch (_) {
    const fallback = new Error('[' + LLM_ERROR_CODES.LLM_UNCLASSIFIED + '] LLM call failed');
    fallback.baseMessage = fallback.message;
    fallback.llmError = true;
    fallback.code = LLM_ERROR_CODES.LLM_UNCLASSIFIED;
    fallback.llmCode = LLM_ERROR_CODES.LLM_UNCLASSIFIED;
    fallback.transportCode = null;
    fallback.status = null;
    fallback.action = LLM_ACTIONS.NONE;
    fallback.retryable = CODE_META.LLM_UNCLASSIFIED.retryable;
    fallback.billable = CODE_META.LLM_UNCLASSIFIED.billable;
    fallback.actionDetail = null;
    fallback.provider = null;
    fallback.model = null;
    fallback.role = null;
    fallback.httpStatus = null;
    fallback.requestId = null;
    fallback.elapsedMs = null;
    fallback.attempt = null;
    fallback.attemptsMax = null;
    fallback.link = null;
    fallback.linkCount = null;
    fallback.chain = null;
    fallback.providerMessage = null;
    fallback.consequence = null;
    return fallback;
  }
}

function isLlmError(err) {
  return !!err && err.llmError === true;
}

/**
 * Copy a coded classification ONTO an error that already exists.
 *
 * WHY THIS EXISTS RATHER THAN "just throw the coded error". Several
 * caller-facing messages are load-bearing and PINNED by existing harnesses
 * (`verifyDirectorJsonSalvage` M1/R1 match the literal
 * `throw new Error(\`Director (round) response not JSON...\`)` source text,
 * and the wording reaches the operator through CampaignRun.errors[].message).
 * Rewriting those to route through makeLlmError would either break the pins or
 * change what an operator reads for no benefit.
 *
 * So the failure is CLASSIFIED where it is detected — which is the only place
 * that knows whether the body was empty, truncated, unparseable or merely
 * unusable — and the classification is ADOPTED onto the thrown error on its
 * way out. Message unchanged; `code`, `action`, `billable` and friends gained.
 *
 * Never overwrites an error that is already coded (a transport failure that
 * bubbled through a content-level catch keeps its own, more specific,
 * diagnosis). Never throws.
 */
function adoptLlmFailure(err, coded) {
  try {
    if (!err || typeof err !== 'object') return err;
    if (err.llmError === true) return err;          // already classified — first wins
    if (!coded || coded.llmError !== true) return err;
    err.llmError       = true;
    err.code           = coded.code;
    err.llmCode        = coded.code;
    err.action         = coded.action;
    err.actionDetail   = coded.actionDetail;
    err.retryable      = coded.retryable;
    err.billable       = coded.billable;
    err.provider       = coded.provider;
    err.model          = coded.model;
    err.role           = coded.role;
    err.httpStatus     = coded.httpStatus;
    err.status         = coded.status;
    err.transportCode  = coded.transportCode;
    err.requestId      = coded.requestId;
    err.elapsedMs      = coded.elapsedMs;
    err.providerMessage = coded.providerMessage;
    // baseMessage stays the ADOPTING error's own message, so a later
    // stampLlmAction rebuilds from the pinned text and not from the
    // classifier's synthetic sentence.
    err.baseMessage    = err.baseMessage || err.message;
    return err;
  } catch (_) {
    return err;
  }
}

/**
 * Stamp the ACTION on a coded error AFTER the control flow that took it ran.
 *
 * THE TRUTHFULNESS RULE, enforced by construction. The action is the outcome
 * that ACTUALLY happened, never the intent — so it is written at the branch
 * that happened, not beside the call site where a later edit could make it a
 * lie. This helper is exported and shared (transport, Director, expansion) for
 * the same reason `resolveDeriveFromMaster` is: a per-caller copy is how one
 * of them drifts into claiming a recovery that did not occur.
 *
 * Re-stamping is NORMAL — retry → advance → give up all land on one object —
 * so the message is rebuilt from `baseMessage` rather than string-surgered.
 * A regex that ate one em dash too many would corrupt the diagnosis on the
 * second pass, and the second pass is the one an operator reads.
 *
 * Returns the same error, so it composes inside a throw.
 */
function stampLlmAction(err, action, actionDetail) {
  try {
    if (!err || err.llmError !== true) return err;
    const act = knownAction(action);
    err.action = act;
    err.actionDetail = boundText(actionDetail, STORED_TEXT_MAX) || actionPhrase(act);
    const base = err.baseMessage || err.message;
    err.message = err.actionDetail ? base + ' — ' + err.actionDetail : base;
    return err;
  } catch (_) {
    return err;
  }
}

// ── chain rendering ──────────────────────────────────────────────────
// A chain attempt record is { provider, model, code, httpStatus, ms, ok }.
// `ok` renders as `ok`; otherwise HTTP status when present, else the
// code stripped of its LLM_ prefix and lowercased (timeout, network_error).
// Seconds to one decimal.

function describeAttempt(rec) {
  try {
    if (!rec || typeof rec !== 'object') return '';
    const name = asText(rec.model) || asText(rec.provider) || 'unknown';
    let outcome;
    if (rec.ok) {
      outcome = 'ok';
    } else if (coerceHttp(rec.httpStatus) != null) {
      outcome = String(coerceHttp(rec.httpStatus));
    } else if (asText(rec.code)) {
      outcome = asText(rec.code).replace(/^LLM_/, '').toLowerCase();
    } else {
      outcome = 'failed';
    }
    const ms = asNum(rec.ms);
    if (ms != null) return name + ' (' + outcome + ', ' + formatSec(ms) + 's)';
    return name + ' (' + outcome + ')';
  } catch (_) {
    return '';
  }
}

function formatChainSummary(chain) {
  try {
    if (!Array.isArray(chain) || chain.length === 0) return '(no attempts recorded)';
    const parts = [];
    for (let i = 0; i < chain.length; i++) {
      const d = describeAttempt(chain[i]);
      if (d) parts.push(d);
    }
    if (!parts.length) return '(no attempts recorded)';
    let out = 'tried ' + parts.join(' → ');
    if (out.length > CHAIN_SUMMARY_MAX) {
      return out.slice(0, CHAIN_SUMMARY_MAX - 1) + '…';
    }
    return out;
  } catch (_) {
    return '(no attempts recorded)';
  }
}

// ── log line ─────────────────────────────────────────────────────────
// One dense greppable line. Field order is load-bearing (operators
// grep `role=` / `request_id=`); do not reorder to look nicer:
//   [CODE] role= provider= model= status= after= attempt=N/M
//          link=N/M request_id= — <consequence>; <action phrase>
// Omit any field that is absent. Never print `undefined`. Collapse
// newlines. Clip the tail (consequence + action) to 300 chars so a
// provider HTML dump cannot blow a log line.

function formatLlmLogLine(err) {
  try {
    if (!err || typeof err !== 'object') {
      return '[' + LLM_ERROR_CODES.LLM_UNCLASSIFIED + ']';
    }
    const code = knownCode(err.code);
    const bits = ['[' + code + ']'];

    const role = asText(err.role);
    if (role) bits.push('role=' + oneLine(role));
    const provider = asText(err.provider);
    if (provider) bits.push('provider=' + oneLine(provider));
    const model = asText(err.model);
    if (model) bits.push('model=' + oneLine(model));
    if (err.httpStatus != null && err.httpStatus !== '') {
      const http = coerceHttp(err.httpStatus);
      bits.push('status=' + (http != null ? String(http) : oneLine(err.httpStatus)));
    }
    const elapsed = asNum(err.elapsedMs);
    if (elapsed != null) bits.push('after=' + formatSec(elapsed) + 's');

    const attempt = asNum(err.attempt);
    if (attempt != null) {
      const max = asNum(err.attemptsMax);
      bits.push(max != null ? 'attempt=' + attempt + '/' + max : 'attempt=' + attempt);
    }
    const link = asNum(err.link);
    if (link != null) {
      const max = asNum(err.linkCount);
      bits.push(max != null ? 'link=' + link + '/' + max : 'link=' + link);
    }
    const requestId = asText(err.requestId);
    if (requestId) bits.push('request_id=' + oneLine(requestId));

    const tailBits = [];
    const consequence = asText(err.consequence) || metaFor(code).meaning;
    if (consequence) tailBits.push(oneLine(consequence));
    const act = asText(err.actionDetail) || actionPhrase(knownAction(err.action));
    if (act) tailBits.push(oneLine(act));
    const tail = clipTail(tailBits.join('; '), LOG_TAIL_MAX);

    let line = bits.join(' ');
    if (tail) line += ' — ' + tail;
    return oneLine(line);
  } catch (_) {
    return '[' + LLM_ERROR_CODES.LLM_UNCLASSIFIED + ']';
  }
}

module.exports = {
  LLM_ERROR_CODES, LLM_ACTIONS, ADVANCES_CHAIN, CONTENT_CODES,
  shouldRetrySameLink, adoptLlmFailure,
  // Exported so docs/ALERTING.md's code table and the harness read the SAME
  // operator guidance the code carries — a hand-copied table drifts, and a
  // stale "what to do about it" column is worse than none.
  CODE_META,
  classifyLlmFailure, makeLlmError, isLlmError, stampLlmAction,
  formatLlmLogLine, formatChainSummary, describeAttempt,
  extractRequestId
};
