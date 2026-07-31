// Single source of truth for "what do we do about this Atlas failure?".
//
// WHY THIS EXISTS
// Handling was scattered and, in one place, actively wrong: a 429 rate limit was
// folded into the same terminal 'rejected' branch as a 402 insufficient-balance,
// so a throttle that Atlas expects us to back off and retry killed the render
// outright. We submit 5-6 images concurrently, which is exactly when a 429
// happens, so that path was reachable in normal use.
//
// SOURCES — documented behaviour, not inferred:
//   - Failed image/video tasks refund the reserved amount; failed LLM requests
//     are never billed. "Failed requests and failed tasks are not charged."
//   - Image models are charged AT SUBMISSION (video mostly too; some billed on
//     completion). LLMs are charged per actual token usage.
//   - 402 Payment Required once the balance is depleted.
//   - 429 on RPM / TPM / concurrency, per account tier and model.
//   - On 500/504, check whether the task is still processing before resubmitting,
//     or you risk paying twice for one image.
//   - 503 outages run 30-120 minutes.
//   - Safety filters can return 200 with partial/fewer outputs rather than an
//     error, so a moderation rejection does not necessarily look like a failure.
//
// VERIFIED AGAINST LIVE RESPONSES (2026-07-31):
//   - completed prediction  -> data.price populated (0.057224 square,
//     0.068744 portrait/landscape). This is the authoritative cost.
//   - failed prediction     -> data.price null, and the error blob carries
//     cost_credits with error_code EXPLICITLY null. Atlas does not always give a
//     machine-readable code, so classification cannot depend on one.
//
// THE RETRY RULE, and why it is safe:
// Retrying a prediction that Atlas reported as `failed` costs nothing extra,
// because the reservation is refunded. That is what makes reattempting sound —
// the long-standing "never auto-retry a billable submit" caution exists to stop
// us paying twice, and a refunded failure cannot double-charge. What must NEVER
// be blind-retried is a submit whose outcome we do not know (500/504/network),
// because the task may be running and a second submit is a second charge.

const LEVELS = ['info', 'warn', 'error', 'fatal'];

/**
 * Action vocabulary:
 *   'retry'        — safe to submit again immediately (after backoff)
 *   'probe'        — outcome unknown; find the existing task before resubmitting
 *   'wait'         — provider-side outage; retry later, slowly
 *   'fix-config'   — a human must change credentials/quota; retrying is futile
 *   'give-up'      — deterministic rejection; the same input will fail again
 */
const POLICIES = Object.freeze({
  unauthorized: {
    match: ({ http, code }) => http === 401 || code === 401,
    charged: false, action: 'fix-config', maxAttempts: 1,
    alertLevel: 'fatal', alertKey: 'atlas:unauthorized',
    why: 'missing or malformed bearer token — every call will fail identically'
  },
  insufficientBalance: {
    match: ({ http, code, msg }) =>
      http === 402 || code === 402 || /insufficient balance|payment required/i.test(msg),
    charged: false, action: 'fix-config', maxAttempts: 1,
    alertLevel: 'fatal', alertKey: 'atlas:insufficient-balance',
    why: 'account balance depleted — an outage, not a bad ad; every render fails until topped up'
  },
  forbidden: {
    match: ({ http, code, msg }) =>
      http === 403 || code === 403 || /quota|spending limit|permission denied/i.test(msg),
    charged: false, action: 'fix-config', maxAttempts: 1,
    alertLevel: 'fatal', alertKey: 'atlas:forbidden',
    why: 'quota exhausted or key lacks permission — needs billing or a new key'
  },
  rateLimited: {
    match: ({ http, code, msg }) =>
      http === 429 || code === 429 || /rate limit|too many requests/i.test(msg),
    charged: false, action: 'retry', maxAttempts: 5,
    backoffMs: (n) => Math.min(30_000, 1000 * Math.pow(2, n)) + Math.floor(Math.random() * 500),
    respectRetryAfter: true,
    alertLevel: 'warn', alertKey: 'atlas:rate-limited',
    why: 'throttled on RPM/TPM/concurrency — backoff and retry is the documented remedy'
  },
  serverError: {
    match: ({ http, code }) => http === 500 || code === 500,
    // Unknown outcome. The submit may have created a task that is running and
    // billable, so we must look before we leap.
    charged: null, action: 'probe', maxAttempts: 3,
    backoffMs: (n) => 2000 * (n + 1),
    alertLevel: 'error', alertKey: 'atlas:server-error',
    why: 'internal error; task may still be processing — probe before resubmitting or risk a double charge'
  },
  unavailable: {
    match: ({ http, code }) => http === 503 || code === 503,
    charged: false, action: 'wait', maxAttempts: 3,
    backoffMs: (n) => Math.min(120_000, 15_000 * (n + 1)),
    alertLevel: 'error', alertKey: 'atlas:unavailable',
    why: 'service unavailable; documented outages run 30-120 minutes'
  },
  gatewayTimeout: {
    match: ({ http, code }) => http === 504 || code === 504,
    charged: null, action: 'probe', maxAttempts: 3,
    backoffMs: (n) => 3000 * (n + 1),
    alertLevel: 'error', alertKey: 'atlas:gateway-timeout',
    why: 'gateway timed out but the render may have started — verify before resubmitting'
  },

  // ── prediction-level outcomes (HTTP 200, status in the body) ──────────
  predictionFailed: {
    match: ({ predictionStatus }) =>
      ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(predictionStatus),
    // Refunded per documented policy, and confirmed live: data.price was null on
    // the failed prediction. Ledger it at $0 so the attempt stays visible.
    charged: false, action: 'retry', maxAttempts: 2,
    backoffMs: () => 1000,
    alertLevel: 'warn', alertKey: 'atlas:prediction-failed',
    why: 'Atlas ran and failed; reservation refunded, so a reattempt costs nothing extra'
  },
  moderationBlocked: {
    // has_nsfw_contents has been observed as null; its populated shape is not
    // confirmed, so accept a bare true OR a per-output array with any flag set.
    // "blocked" is deliberately NOT matched on its own — it appears in unrelated
    // infrastructure messages, and misreading one as moderation would mark a
    // retryable failure permanently futile.
    match: ({ nsfw, msg }) =>
      nsfw === true
      || (Array.isArray(nsfw) && nsfw.some(Boolean))
      || /moderation|safety system|content policy|safety filter|flagged as unsafe/i.test(msg),
    // Deterministic: the same prompt and reference will be blocked again.
    charged: false, action: 'give-up', maxAttempts: 1,
    alertLevel: 'warn', alertKey: 'atlas:moderation',
    why: 'safety filter rejected the input — identical retry is futile; the prompt or reference must change'
  },
  completedNoOutput: {
    match: ({ predictionStatus, hasOutputs }) =>
      ['completed', 'succeeded'].includes(predictionStatus) && hasOutputs === false,
    // Completed means the work ran, and image models bill at submission, so this
    // one IS chargeable — the rare genuine "paid for nothing" case.
    charged: true, action: 'probe', maxAttempts: 2,
    backoffMs: () => 2000,
    alertLevel: 'error', alertKey: 'atlas:completed-no-output',
    why: 'reported complete with no outputs — re-read the prediction before paying again'
  },

  // ── transport ────────────────────────────────────────────────────────
  network: {
    match: ({ errCode, msg }) =>
      ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(errCode) ||
      /socket hang up|network|getaddrinfo/i.test(msg),
    charged: null, action: 'probe', maxAttempts: 3,
    backoffMs: (n) => 1500 * (n + 1),
    alertLevel: 'warn', alertKey: 'atlas:network',
    why: 'transport failed with the request possibly delivered — probe rather than resubmit blindly'
  },
  clientTimeout: {
    match: ({ errCode, msg }) => errCode === 'ETIMEDOUT' || /timeout|timed out/i.test(msg),
    // Our deadline, not theirs. Atlas is probably still working and will bill.
    charged: true, action: 'probe', maxAttempts: 2,
    backoffMs: () => 2000,
    alertLevel: 'warn', alertKey: 'atlas:client-timeout',
    why: 'we stopped waiting; the task is likely still running and already billable'
  }
});

/**
 * Match order, explicit because two real cases collide otherwise.
 *
 * 1. A failed prediction arrives as envelope `code: 500` WITH `status: "failed"`
 *    in the body (observed live). Generic 500 handling says "probe, outcome
 *    unknown"; but here the outcome IS known and refunded, so the prediction-level
 *    verdict must win or every refunded failure gets treated as a possible
 *    double-charge and never reattempted.
 * 2. A moderation block can accompany a failed status. Retrying a safety
 *    rejection is futile, so moderation outranks predictionFailed.
 *
 * Credential/billing states are checked first: they make every other
 * classification moot and must never be retried behind a friendlier label.
 */
const PRECEDENCE = Object.freeze([
  'unauthorized', 'insufficientBalance', 'forbidden',
  'moderationBlocked', 'predictionFailed', 'completedNoOutput',
  'rateLimited', 'unavailable', 'gatewayTimeout', 'serverError',
  'clientTimeout', 'network'
]);

const FALLBACK = Object.freeze({
  name: 'unknown',
  charged: null, action: 'probe', maxAttempts: 2,
  backoffMs: (n) => 2000 * (n + 1),
  alertLevel: 'error', alertKey: 'atlas:unclassified',
  why: 'unrecognised failure shape — treated as outcome-unknown so we never double-charge on a guess'
});

/**
 * Classify a failure. Every field is optional; pass whatever is known.
 *
 * @param {number|null} http            transport status code
 * @param {number|null} code            Atlas envelope `code`
 * @param {string|null} msg             any human-readable message
 * @param {string|null} predictionStatus body `data.status`
 * @param {boolean|null} hasOutputs     whether data.outputs held anything
 * @param {boolean|null} nsfw           data.has_nsfw_contents
 * @param {string|null} errCode         node error code (ECONNRESET etc.)
 * @param {number|null} retryAfterSec   Retry-After header, seconds
 */
function classify({
  http = null, code = null, msg = null, predictionStatus = null,
  hasOutputs = null, nsfw = null, errCode = null, retryAfterSec = null
} = {}) {
  const ctx = {
    http: http == null ? null : Number(http),
    code: code == null ? null : Number(code),
    msg: String(msg || ''),
    predictionStatus: predictionStatus ? String(predictionStatus).toLowerCase() : null,
    hasOutputs, nsfw, errCode: errCode || null
  };

  for (const name of PRECEDENCE) {
    const p = POLICIES[name];
    let hit = false;
    try { hit = !!p.match(ctx); } catch { hit = false; }
    if (!hit) continue;
    return finalize(name, p, ctx, retryAfterSec);
  }
  return finalize(FALLBACK.name, FALLBACK, ctx, retryAfterSec);
}

function finalize(name, p, ctx, retryAfterSec) {
  return {
    name,
    charged: p.charged,             // true | false | null (unknown)
    action: p.action,
    retryable: p.action === 'retry' || p.action === 'wait',
    probeFirst: p.action === 'probe',
    terminal: p.action === 'fix-config' || p.action === 'give-up',
    maxAttempts: p.maxAttempts,
    alertLevel: LEVELS.includes(p.alertLevel) ? p.alertLevel : 'warn',
    alertKey: p.alertKey,
    why: p.why,
    /** Delay before attempt n (0-based). Honours Retry-After when Atlas sends it. */
    backoffFor(n) {
      if (p.respectRetryAfter && Number.isFinite(Number(retryAfterSec)) && Number(retryAfterSec) > 0) {
        return Math.min(120_000, Number(retryAfterSec) * 1000);
      }
      return typeof p.backoffMs === 'function' ? p.backoffMs(n) : 0;
    },
    /** The CostLog status this failure should be ledgered under. */
    costStatus() {
      if (name === 'insufficientBalance') return 'rejected-billing';
      if (p.action === 'fix-config' || name === 'moderationBlocked') return 'rejected';
      if (name === 'completedNoOutput') return 'charged-no-output';
      if (name === 'clientTimeout') return 'timeout';
      if (name === 'predictionFailed') return 'failed';
      return 'error';
    }
  };
}

/**
 * May we submit this request again?
 *
 * The distinction that matters is NOT "were we charged" but "does a billable task
 * already exist". Conflating them is a double-charge: a 429 classifies as
 * uncharged, yet a 429 observed AFTER a successful submit sits beside a task that
 * was billed at submission, so resubmitting buys the same image twice.
 *
 * True only when the previous attempt left nothing running:
 *   - no prediction id  -> the submit itself was refused, nothing was created
 *   - predictionFailed  -> the task ran, failed, and the reservation was refunded
 *
 * @param {object|null} policy        result of classify()
 * @param {string|null} predictionId  set once Atlas has accepted a task
 */
function mayResubmit(policy, predictionId) {
  if (!policy || !policy.retryable || policy.charged !== false) return false;
  const refunded = policy.name === 'predictionFailed';
  return refunded || !predictionId;
}

/** Extract Retry-After (seconds) from an axios-style response. */
function retryAfterFrom(res) {
  const h = res?.headers?.['retry-after'] ?? res?.headers?.['Retry-After'];
  if (h == null) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const when = Date.parse(String(h));           // HTTP-date form
  if (!Number.isNaN(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  return null;
}

module.exports = { classify, mayResubmit, retryAfterFrom, POLICIES, FALLBACK };
