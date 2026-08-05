// Thin HTTP client for the Atlas Billing Public API.
//
// No business logic, no DB access, no alerting — just fetch, paginate, parse.
// All three endpoints are GETs and can never charge money, so retries are
// always safe here (unlike the generation submit paths, where a blind retry
// is a double charge).
//
// Verified live 2026-08-05 — this is the real contract, do not invent fields.
//
// BASE is DIFFERENT from the generation API (.../api/v1). Billing lives at
// .../public/v1. Auth is the SAME ATLAS_API_KEY the generation services use;
// no new secret.

'use strict';

const axios = require('axios');
const { classify, retryAfterFrom } = require('./atlasErrorPolicy');

// Overridable for local stubbing; production leaves this unset.
const BILLING_BASE = process.env.ATLAS_BILLING_BASE || 'https://api.atlascloud.ai/public/v1';
// Lazy: module loads cleanly when the key is absent (same pattern as
// atlasImageService). Callers that need the key fail at request time.
const KEY = () => process.env.ATLAS_API_KEY;

// Billing GETs are small JSON; 30s is generous for a paginated page. Not env-
// driven yet — nothing has needed to tune it, and env sprawl is real.
const REQUEST_TIMEOUT_MS = 30_000;

// API 400s invalid_time_range on ranges over 180 days (verified 2026-08-05).
// Split wider requests locally; never rely on the remote 400 to discover this.
const MAX_RANGE_DAYS = 180;

// Caps from the live schema / docs; enforced before the request so a caller
// mistake is a clear local Error, not a remote 400.
const MAX_ID_FILTER = 100;
const DEFAULT_LIMIT = 1000;

// WAF 403s default python-urllib / curl User-Agents. Costs real debugging
// time if omitted (same trap as the Atlas media-gen base).
const USER_AGENT = 'Mozilla/5.0 (compatible; liquidretail-billing/1.0)';

// group_by[] combinations accepted by the API (each tested 2026-08-05):
//   model_type ✅, model ✅, api_key ✅, model+api_key ✅
//   model_type+model → 400 invalid_group_by
//   model_type+api_key → 400 invalid_group_by
// Encode as an allowlist so callers never discover a bad combo as a remote 400.
const VALID_GROUP_BY = Object.freeze([
  Object.freeze(['model_type']),
  Object.freeze(['model']),
  Object.freeze(['api_key']),
  Object.freeze(['model', 'api_key'])
]);

// ── money helpers (local; do not pull the mongoose model into a thin client) ─

function moneyToNumber(s) {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── date windowing ──────────────────────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertYmd(label, value) {
  if (typeof value !== 'string' || !YMD_RE.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD UTC, got ${JSON.stringify(value)}`);
  }
}

function parseYmdUtc(ymd) {
  // Construct via Date.UTC so a host in a non-UTC zone cannot shift the day.
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYmdUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Yield sequential [start, end) windows of at most MAX_RANGE_DAYS.
 * start inclusive, end exclusive — matches the API's date semantics.
 */
function dateWindows(startDate, endDate) {
  assertYmd('startDate', startDate);
  assertYmd('endDate', endDate);
  const start = parseYmdUtc(startDate);
  const end = parseYmdUtc(endDate);
  if (!(start < end)) {
    throw new Error(`startDate must be < endDate (end is exclusive); got ${startDate}..${endDate}`);
  }
  const windows = [];
  let cur = start;
  while (cur < end) {
    const next = new Date(cur.getTime());
    next.setUTCDate(next.getUTCDate() + MAX_RANGE_DAYS);
    const windowEnd = next < end ? next : end;
    windows.push({ startDate: formatYmdUtc(cur), endDate: formatYmdUtc(windowEnd) });
    cur = windowEnd;
  }
  return windows;
}

// ── group_by validation ─────────────────────────────────────────────────────

function normalizeGroupBy(groupBy) {
  const arr = Array.isArray(groupBy) ? groupBy.slice() : [groupBy];
  if (!arr.length || arr.some((g) => typeof g !== 'string' || !g)) {
    throw new Error('groupBy must be a non-empty string or string[]');
  }
  // Order-insensitive match against the allowlist (API accepts either order for
  // the model+api_key pair; we keep the caller's order on the wire).
  const sorted = arr.slice().sort();
  const ok = VALID_GROUP_BY.some((allowed) => {
    const a = allowed.slice().sort();
    return a.length === sorted.length && a.every((v, i) => v === sorted[i]);
  });
  if (!ok) {
    throw new Error(
      `invalid group_by combination: [${arr.join(', ')}]. ` +
      `Allowed: model_type | model | api_key | model+api_key ` +
      `(model_type cannot be combined with model or api_key — Atlas returns 400 invalid_group_by)`
    );
  }
  return arr;
}

// ── query string ────────────────────────────────────────────────────────────

/**
 * Build a query string with repeatable `name[]` keys. axios's default array
 * serializer varies by version; billing was verified with the `foo[]=a&foo[]=b`
 * form, so encode that explicitly.
 */
function buildQuery(params) {
  const parts = [];
  const push = (k, v) => {
    if (v == null || v === '') return;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) push(key, item);
    } else {
      push(key, value);
    }
  }
  return parts.join('&');
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Raise an Error whose message carries every Atlas error field plus request_id
 * — Atlas support asks for the request id on tickets.
 */
function throwBillingError(res, path) {
  const body = res?.data || {};
  const err = body.error || {};
  const requestId = body.request_id || err.request_id || null;
  const bits = [
    `atlas billing ${res?.status} ${path}`,
    err.type && `type=${err.type}`,
    err.code && `code=${err.code}`,
    err.message && `message=${err.message}`,
    err.param && `param=${err.param}`,
    requestId && `request_id=${requestId}`
  ].filter(Boolean);
  const e = new Error(bits.join(' | '));
  e.status = res?.status;
  e.atlasError = err;
  e.requestId = requestId;
  e.body = body;
  throw e;
}

/**
 * One GET with 429 backoff. Reuses atlasErrorPolicy.classify + retryAfterFrom
 * so Retry-After and the capped exponential match every other Atlas path.
 * Retries are always safe: these are free GETs.
 */
async function billingGet(path, query = {}) {
  if (!KEY()) {
    throw new Error('ATLAS_API_KEY not configured — billing client cannot authenticate');
  }
  const qs = buildQuery(query);
  const url = qs ? `${BILLING_BASE}${path}?${qs}` : `${BILLING_BASE}${path}`;

  // Attempt cap comes from the classified policy (rateLimited.maxAttempts is 5),
  // not a local literal, so retuning atlasErrorPolicy retunes this too.
  // HARD_CAP only bounds a policy that ever grows an absurd maxAttempts.
  const HARD_CAP = 8;
  let attempt = 0;

  while (true) {
    let res;
    try {
      res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${KEY()}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS,
        // Match atlasImageService: never let axios throw on non-2xx; branch on
        // status ourselves so 429 can honour Retry-After cleanly.
        validateStatus: () => true
      });
    } catch (err) {
      // validateStatus only governs HTTP status — a transport failure (ECONNRESET,
      // DNS, timeout) still throws. This runs unattended on a worker interval, so
      // a single transient reset must not abort a whole sync. Retry with the same
      // backoff shape, then give up with the transport error intact.
      if (attempt + 1 < HARD_CAP) {
        await sleep(Math.min(30_000, 1000 * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      err.message = `atlas billing transport failure ${path} after ${attempt + 1} attempts: ${err.message}`;
      throw err;
    }

    if (res.status >= 200 && res.status < 300) return res.data;

    const policy = classify({
      http: res.status,
      code: res.data?.error?.code ?? res.data?.code ?? null,
      msg: res.data?.error?.message || res.data?.message || res.data?.msg || null,
      retryAfterSec: retryAfterFrom(res)
    });

    // Retry 429 and any transient 5xx. atlasErrorPolicy classes most 5xx as
    // 'probe' — "the submit may have created a billable task, look before you
    // leap" — but that reasoning is specific to generation submits. These are
    // free idempotent GETs with nothing to probe, so a straight retry is both
    // safe and the only sensible action.
    const retryable = res.status === 429 || res.status >= 500;
    const cap = Math.min(policy.maxAttempts || 1, HARD_CAP);
    if (retryable && attempt + 1 < Math.max(cap, 3)) {
      await sleep(policy.backoffFor(attempt));
      attempt++;
      continue;
    }
    throwBillingError(res, path);
  }
}

// ── balance ─────────────────────────────────────────────────────────────────

/**
 * GET /balance. Returns the parsed body plus convenience numeric fields so
 * callers never re-parse money strings.
 */
async function getBalance() {
  const body = await billingGet('/balance');
  return {
    ...body,
    availableUsd: moneyToNumber(body.available?.value),
    cashUsd: moneyToNumber(body.cash?.value),
    bonusUsd: moneyToNumber(body.bonus?.value),
    subscriptionBonusUsd: moneyToNumber(body.subscription_bonus?.value),
    frozenUsd: moneyToNumber(body.frozen?.value),
    creditGrantedUsd: moneyToNumber(body.credit_grant?.granted?.value),
    creditUsedUsd: moneyToNumber(body.credit_grant?.used?.value),
    remainingOverdraftUsd: moneyToNumber(body.credit_grant?.remaining_overdraft?.value),
    overdrawnUsd: moneyToNumber(body.credit_grant?.overdrawn?.value),
    creditGrantStatus: body.credit_grant?.status ?? null
  };
}

// ── model-costs / model-usage ───────────────────────────────────────────────

function assertIdList(label, ids) {
  if (ids == null) return null;
  const arr = Array.isArray(ids) ? ids : [ids];
  if (arr.length > MAX_ID_FILTER) {
    throw new Error(`${label} accepts at most ${MAX_ID_FILTER} ids, got ${arr.length}`);
  }
  return arr;
}

/**
 * Merge paginated bucket pages by date. Pagination can re-emit the same date
 * with a further slice of results; concatenate results rather than replace.
 * Prefer partial:false when either page is final; otherwise keep the latest
 * covered_until we see (live partial days advance covered_until across polls).
 */
function resultIdentity(date, r) {
  // The grouping identity of a result row. Whatever axes were requested, a
  // (date, model, api_key, model_type) tuple can only legitimately appear once
  // per response — it IS the group key.
  return [
    date,
    (r?.model && (r.model.id || r.model.name)) || '_',
    (r?.api_key && r.api_key.id) || '_',
    r?.model_type || '_'
  ].join('|');
}

function mergeBucketPage(byDate, pageBuckets, seenIdentities) {
  for (const bucket of pageBuckets || []) {
    const date = bucket?.date;
    if (!date) continue;

    // Defensive dedupe. Verified live 2026-08-05 that pagination does NOT
    // re-emit rows (21 pages at limit=2 → 42 rows, 0 duplicates), so this should
    // never fire. It exists because the failure it prevents is silent
    // double-counted spend, and a reconciler that inflates the number it is
    // supposed to audit is worse than useless. Loud, not silent, if it ever trips.
    const fresh = [];
    for (const r of (Array.isArray(bucket.results) ? bucket.results : [])) {
      const id = resultIdentity(date, r);
      if (seenIdentities.has(id)) {
        console.warn(`   ⚠️  atlasBillingClient: duplicate billing result across pages, dropped — ${id}`);
        continue;
      }
      seenIdentities.add(id);
      fresh.push(r);
    }

    const prev = byDate.get(date);
    if (!prev) {
      byDate.set(date, { ...bucket, results: fresh });
      continue;
    }
    if (fresh.length) prev.results.push(...fresh);
    if (bucket.partial === false) prev.partial = false;
    if (bucket.covered_until) prev.covered_until = bucket.covered_until;
  }
}

/**
 * Paginate one [start, end) window until has_more is false. Guards a
 * non-advancing cursor (same next_page twice → throw) so a buggy response
 * cannot loop forever.
 *
 * Useful property of group_by[]=model: each result row also carries
 * model_type, so ONE query yields both axes and no stage→category taxonomy
 * is needed. Conversely group_by[]=model_type rows carry NO model field.
 */
async function fetchWindow(path, {
  startDate, endDate, groupBy, scope, apiKeyIds, modelTypes, modelIds, limit
}) {
  const byDate = new Map();
  const seenIdentities = new Set();
  let page = undefined;
  let lastPage = undefined;
  let guard = 0;
  // Hard ceiling well above any sane page count (1000 rows × N pages). A
  // runaway cursor that DID advance would still eventually trip this.
  const MAX_PAGES = 10_000;

  while (true) {
    if (++guard > MAX_PAGES) {
      throw new Error(`atlas billing pagination exceeded ${MAX_PAGES} pages for ${path} ${startDate}..${endDate}`);
    }
    const query = {
      start_date: startDate,
      end_date: endDate,
      'group_by[]': groupBy,
      limit: limit || DEFAULT_LIMIT
    };
    if (scope) query.scope = scope;
    if (apiKeyIds) query['api_key_ids[]'] = apiKeyIds;
    if (modelTypes) query['model_types[]'] = modelTypes;
    if (modelIds) query['model_ids[]'] = modelIds;
    if (page) query.page = page;

    const body = await billingGet(path, query);
    mergeBucketPage(byDate, body.data, seenIdentities);

    if (!body.has_more) break;
    const next = body.next_page;
    if (!next) {
      throw new Error(
        `atlas billing has_more=true but next_page missing on ${path} ` +
        `(request_id=${body.request_id || '?'})`
      );
    }
    if (next === lastPage) {
      throw new Error(
        `atlas billing pagination cursor did not advance on ${path}: ${next} ` +
        `(request_id=${body.request_id || '?'})`
      );
    }
    lastPage = next;
    page = next;
  }

  // Stable chronological order for callers that iterate without sorting.
  return Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function getModelSeries(path, {
  startDate,
  endDate,
  groupBy,
  scope = 'account',
  apiKeyIds = null,
  modelTypes = null,
  modelIds = null,
  limit = DEFAULT_LIMIT
} = {}) {
  const gb = normalizeGroupBy(groupBy);
  const keyIds = assertIdList('apiKeyIds', apiKeyIds);
  const mTypes = modelTypes == null ? null : (Array.isArray(modelTypes) ? modelTypes : [modelTypes]);
  const mIds = assertIdList('modelIds', modelIds);

  if (limit != null) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      throw new Error(`limit must be 1–1000, got ${limit}`);
    }
  }

  // Chunk first, then paginate each chunk. Windows are contiguous and
  // exclusive-ended so dates never overlap; concat is safe.
  const windows = dateWindows(startDate, endDate);
  const all = [];
  for (const w of windows) {
    const buckets = await fetchWindow(path, {
      startDate: w.startDate,
      endDate: w.endDate,
      groupBy: gb,
      scope,
      apiKeyIds: keyIds,
      modelTypes: mTypes,
      modelIds: mIds,
      limit
    });
    all.push(...buckets);
  }
  return all;
}

/** GET /model-costs — daily cost buckets (amount per result row). */
function getModelCosts(opts) {
  return getModelSeries('/model-costs', opts);
}

/** GET /model-usage — daily usage buckets (requests/tokens/images/video). */
function getModelUsage(opts) {
  return getModelSeries('/model-usage', opts);
}

module.exports = {
  getBalance,
  getModelCosts,
  getModelUsage,
  BILLING_BASE,
  VALID_GROUP_BY,
  // Exported for harnesses / writers that want the same windowing without
  // reimplementing the 180-day split. Not part of the public HTTP surface.
  dateWindows
};
