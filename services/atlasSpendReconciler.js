// Atlas ↔ CostLog spend reconciliation.
//
// WHY THIS EXISTS (measured live 2026-08-05, production account)
// The internal CostLog ledger and Atlas's authoritative billing disagree
// badly per category, but the aggregate nearly cancels — which is why
// nobody noticed for weeks:
//
//   category | Atlas        | CostLog      | ratio
//   video    | $242.93      | $277.00      | 1.14x over
//   image    | $72.44       | $33.48       | 0.46x under
//   text     | $69.62       | $70.68       | 1.02x
//   total    | $384.99      | $381.15      | 0.99x
//
// Per-day ratios ranged 0.40x → 2.38x. A reconciler that only watched the
// total would stay silent forever; category-level + rolling windows are
// the whole point.
//
// SCOPE IS LOAD-BEARING (see models/AtlasSpendDay.js). liquidretail is the
// ONLY valid drift basis. The billing account (Reach-Social.io, team) has
// two other keys for unrelated projects — they drain the same prepaid
// balance but MUST be excluded from ledger comparison. account-scope rows
// exist only for balance/burn context.
//
// The account auto-refills $30 at a time and burns ~$35/day, so `available`
// dips below any low threshold roughly daily. A naive low-balance alert is
// pure noise — see checkBalance() streak + overdrawn signals.
//
// Never throws to the caller. The worker interval must not die because
// billing is unreachable (same discipline as backlogWatchdog.js).

'use strict';

const AtlasSpendDay = require('../models/AtlasSpendDay');
const CostLog = require('../models/CostLog');
const {
  getBalance,
  getModelCosts,
  getModelUsage
} = require('./atlasBillingClient');
const alerts = require('./alertService');

// ── lazy env accessors ──────────────────────────────────────────────────────
// Read on every call so a Render env change takes effect without a code branch
// caring about load order. Clamps match the repo's "sane floor, not silent 0".

const N = (name, dflt) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const F_POS = (name, dflt) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

// Master switch. Default ON so configuring ATLAS_API_KEY + key allowlist is
// the only step needed; set ATLAS_BILLING_ENABLED=false to mute without
// unsetting secrets.
const BILLING_ENABLED = () =>
  String(process.env.ATLAS_BILLING_ENABLED ?? 'true').toLowerCase() !== 'false';

// Comma-separated Atlas public key ids (ak_…). Empty → liquidretail pass is
// SKIPPED, not silently broadened — see syncSpendDays.
const KEY_IDS = () =>
  String(process.env.ATLAS_BILLING_KEY_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Re-pull window. Re-fetching recent days is how late settlement is caught;
// upserts make it idempotent. Cap at 30 so a typo cannot request a 180-day
// billable-looking window of free GETs that still hammers the API.
const LOOKBACK_DAYS = () => Math.max(1, Math.min(30, N('ATLAS_SPEND_LOOKBACK_DAYS', 4)));

// Daily drift gates — BOTH must trip (AND). Sanity against the measured data:
//   text $1.06 @ 1.5%  → silent (abs < $5)
//   $40  @ 1.4x        → fires  (abs ≥ $5 AND rel ≥ 20%)
//   $0.50 @ 3x         → silent (abs < $5)
const DRIFT_ABS_USD = () => F_POS('ATLAS_DRIFT_ABS_USD', 5);
const DRIFT_PCT = () => {
  const v = parseFloat(process.env.ATLAS_DRIFT_PCT);
  // Accept either fraction (0.20) or percent-looking (20) — clamp to (0, 1].
  if (!Number.isFinite(v) || v <= 0) return 0.20;
  return v > 1 ? Math.min(v / 100, 1) : v;
};

// Rolling window: same relative gate, same default abs floor. Image ran 0.46x
// under for 35 consecutive days (~$1.11/day) — below any sane daily dollar
// floor every single day, so detectDrift alone would have stayed silent the
// whole time. This is the check that would have caught the real bug.
const DRIFT_ROLLING_ABS_USD = () => F_POS('ATLAS_DRIFT_ROLLING_ABS_USD', 5);
const ROLLING_WINDOW_DAYS = () => Math.max(2, Math.min(30, N('ATLAS_DRIFT_ROLLING_DAYS', 7)));
const ROLLING_MIN_DAYS = () => Math.max(1, Math.min(30, N('ATLAS_ROLLING_MIN_DAYS', 5)));

// Balance. Auto-refill is $30; burn ~$35/day. A single sub-threshold read is
// NORMAL, not a fault — only a streak is interesting.
const BALANCE_ALERT_USD = () => F_POS('ATLAS_BALANCE_ALERT_USD', 10);
const BALANCE_LOW_STREAK = () => Math.max(1, N('ATLAS_BALANCE_LOW_STREAK', 3));

const BULK_BATCH = 500;

// Trailing window for the burn-rate context figure in the balance alert.
const BURN_WINDOW_DAYS = 7;

// ── module-scope state ──────────────────────────────────────────────────────
// Deliberately in-process, not Mongo. A worker restart re-arms the low-balance
// counter, which fails safe toward SILENCE (one more ~15 min window before
// the next alert). That is a deliberate trade: re-alerting every deploy on a
// routinely-low auto-refill balance is worse than missing one window.
let lowBalanceStreak = 0;
let disabledLogged = false;

// ── date helpers (UTC only — Atlas buckets are UTC days) ────────────────────

function utcYmd(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addUtcDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcYmd(dt);
}

/** Inclusive start / exclusive end Date bounds for a YYYY-MM-DD UTC day. */
function dayBoundsUtc(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  return { start, end };
}

// ── money / usage parsing ───────────────────────────────────────────────────

/**
 * Atlas money on /model-costs is a fixed-6-decimal string, sometimes nested
 * under `.value` (same shape as /balance). Always go through usdStringToMicros
 * — never store float dollars, never sum string-parsed floats into a comparison.
 */
function amountToMicros(amount) {
  if (amount == null || amount === '') return 0;
  if (typeof amount === 'object') {
    return AtlasSpendDay.usdStringToMicros(
      amount.value != null ? amount.value : amount.amount
    );
  }
  return AtlasSpendDay.usdStringToMicros(amount);
}

/**
 * Flatten the nested, mutually-exclusive usage object. Verified live
 * 2026-08-05 (see AtlasSpendDay): text→tokens, image→images, video→video;
 * the other two sub-objects are null. Guard every access. NEVER read
 * usage.tokens.total — it is reported as 0 even when input/output are set.
 */
function flattenUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const tokens = u.tokens && typeof u.tokens === 'object' ? u.tokens : null;
  const images = u.images && typeof u.images === 'object' ? u.images : null;
  const video = u.video && typeof u.video === 'object' ? u.video : null;
  return {
    tokensInput: tokens ? (Number(tokens.input) || 0) : 0,
    tokensOutput: tokens ? (Number(tokens.output) || 0) : 0,
    tokensCacheRead: tokens ? (Number(tokens.cache_read) || 0) : 0,
    tokensCacheCreation: tokens ? (Number(tokens.cache_creation) || 0) : 0,
    imageCount: images ? (Number(images.count) || 0) : 0,
    videoSeconds: video ? (Number(video.seconds) || 0) : 0
  };
}

function modelSlugFromResult(r) {
  if (!r || !r.model) return null;
  // name is the Atlas slug (e.g. google/gemini-2.5-flash) — the CostLog join
  // key. id is the ms-… internal id and is NOT on CostLog.model.
  return r.model.name || null;
}

function resultMergeKey(r) {
  // groupBy:['model'] identity. Prefer the slug (join key); fall back to id
  // only so a nameless row still upserts rather than colliding on '_'.
  return modelSlugFromResult(r) || (r?.model && r.model.id) || r?.model_type || '_';
}

// ── bulkWrite helpers ───────────────────────────────────────────────────────

/**
 * Build one upsert op. AtlasSpendDay's pre('validate') hook does NOT run on
 * bulkWrite/updateOne — key MUST be computed here and used as the filter.
 * Forgetting that inserts key:undefined and the next row collides on the
 * unique index (loud); a mismatched key would silently fork the series (worse).
 */
function buildUpsertOp({
  date, scope, modelType, modelName, modelId, apiKeyId, apiKeyName,
  amountMicroUsd, usageFlat, requests, partial, coveredUntil, currency, atlasRequestId
}) {
  const groupBy = 'model';
  const key = AtlasSpendDay.buildKey({
    date, scope, groupBy, modelType, modelName, apiKeyId
  });
  const now = new Date();
  return {
    updateOne: {
      filter: { key },
      update: {
        $set: {
          modelType: modelType || null,
          modelName: modelName || null,
          modelId: modelId || null,
          apiKeyId: apiKeyId || null,
          apiKeyName: apiKeyName || null,
          amountMicroUsd: amountMicroUsd || 0,
          requests: requests || 0,
          tokensInput: usageFlat.tokensInput || 0,
          tokensOutput: usageFlat.tokensOutput || 0,
          tokensCacheRead: usageFlat.tokensCacheRead || 0,
          tokensCacheCreation: usageFlat.tokensCacheCreation || 0,
          imageCount: usageFlat.imageCount || 0,
          videoSeconds: usageFlat.videoSeconds || 0,
          partial: !!partial,
          coveredUntil: coveredUntil || null,
          currency: currency || 'usd',
          fetchedAt: now,
          atlasRequestId: atlasRequestId || null
        },
        $setOnInsert: {
          key,
          date,
          scope,
          groupBy
        }
      },
      upsert: true
    }
  };
}

async function flushOps(ops) {
  if (!ops.length) return 0;
  let written = 0;
  for (let i = 0; i < ops.length; i += BULK_BATCH) {
    const chunk = ops.slice(i, i + BULK_BATCH);
    // ordered:false — one bad row must not abort the rest of a day's upserts.
    const res = await AtlasSpendDay.bulkWrite(chunk, { ordered: false });
    // upserted + modified only. matchedCount overlaps modifiedCount (a matched
    // doc that changed counts in both), so adding all three inflates the tally.
    written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
  }
  return written;
}

/**
 * Merge cost + usage buckets (same groupBy/params → same identity) into upsert
 * ops for one scope. Returns { days, rows, finalizedDates }.
 */
function bucketsToOps(costBuckets, usageBuckets, scope) {
  // date → Map(mergeKey → { cost, usage })
  const byDate = new Map();

  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        // Resolve after ingest: true if any bucket is partial/unknown,
        // false only when every observed bucket is explicitly final.
        sawPartial: false,
        sawFinal: false,
        coveredUntil: null,
        currency: 'usd',
        atlasRequestId: null,
        results: new Map()
      });
    }
    return byDate.get(date);
  };

  const ingest = (buckets, which) => {
    for (const bucket of buckets || []) {
      const date = bucket?.date;
      if (!date) continue;
      const slot = ensure(date);
      // ONLY partial:false is final. Prefer partial when costs/usage disagree
      // or either omits the flag — a half-parsed response must never mark a
      // day safe to reconcile (partial always reads as "ledger over").
      if (bucket.partial === true) slot.sawPartial = true;
      else if (bucket.partial === false) slot.sawFinal = true;
      else slot.sawPartial = true; // missing/undefined → not final
      if (bucket.covered_until) {
        const cu = new Date(bucket.covered_until);
        if (!Number.isNaN(cu.getTime())) slot.coveredUntil = cu;
      }
      if (bucket.currency) slot.currency = bucket.currency;
      // request_id is not currently threaded through atlasBillingClient's
      // merged buckets; keep the field for when it is.
      if (bucket.request_id) slot.atlasRequestId = bucket.request_id;

      for (const r of (Array.isArray(bucket.results) ? bucket.results : [])) {
        const mk = resultMergeKey(r);
        const prev = slot.results.get(mk) || { cost: null, usage: null };
        prev[which] = r;
        slot.results.set(mk, prev);
      }
    }
  };

  ingest(costBuckets, 'cost');
  ingest(usageBuckets, 'usage');

  const ops = [];
  const finalizedDates = [];
  for (const [date, slot] of byDate) {
    // Final only when we saw at least one explicit partial:false and never
    // saw partial/unknown. (Both cost+usage final → final; mixed → partial.)
    const partial = !(slot.sawFinal && !slot.sawPartial);
    slot.partial = partial;
    if (!partial) finalizedDates.push(date);
    for (const { cost, usage } of slot.results.values()) {
      const src = cost || usage || {};
      const modelName = modelSlugFromResult(cost) || modelSlugFromResult(usage);
      const modelId = (cost && cost.model && cost.model.id)
        || (usage && usage.model && usage.model.id)
        || null;
      const modelType = (cost && cost.model_type) || (usage && usage.model_type) || null;
      const apiKeyId = (cost && cost.api_key && cost.api_key.id)
        || (usage && usage.api_key && usage.api_key.id)
        || null;
      const apiKeyName = (cost && cost.api_key && cost.api_key.name)
        || (usage && usage.api_key && usage.api_key.name)
        || null;
      const usageSrc = (usage && usage.usage) || (cost && cost.usage) || null;
      const usageFlat = flattenUsage(usageSrc);
      // requests lives on the usage result in live responses; fall back to
      // usage.requests / cost.requests so a shape change does not zero it.
      const requests = Number(
        (usage && usage.requests)
        ?? (usageSrc && usageSrc.requests)
        ?? (cost && cost.requests)
        ?? 0
      ) || 0;

      ops.push(buildUpsertOp({
        date,
        scope,
        modelType,
        modelName,
        modelId,
        apiKeyId,
        apiKeyName,
        amountMicroUsd: amountToMicros(cost && cost.amount),
        usageFlat,
        requests,
        partial: slot.partial,
        coveredUntil: slot.coveredUntil,
        currency: (cost && cost.currency) || (usage && usage.currency) || slot.currency,
        atlasRequestId: slot.atlasRequestId
      }));
    }
  }

  finalizedDates.sort();
  return {
    ops,
    days: byDate.size,
    rows: ops.length,
    finalizedDates
  };
}

async function pullAndUpsert(scope, apiKeyIds, lookbackDays) {
  const lookback = lookbackDays != null
    ? Math.max(1, Math.min(30, Number(lookbackDays) || LOOKBACK_DAYS()))
    : LOOKBACK_DAYS();
  const today = utcYmd();
  // end_date is EXCLUSIVE on the Atlas API. Use tomorrow so today's partial
  // bucket is included (and re-pulled every tick until it finalises).
  const startDate = addUtcDays(today, -lookback);
  const endDate = addUtcDays(today, 1);

  const params = {
    startDate,
    endDate,
    groupBy: ['model'],
    scope: 'account'
  };
  if (apiKeyIds && apiKeyIds.length) params.apiKeyIds = apiKeyIds;

  const [costBuckets, usageBuckets] = await Promise.all([
    getModelCosts(params),
    getModelUsage(params)
  ]);

  const { ops, days, rows, finalizedDates } = bucketsToOps(costBuckets, usageBuckets, scope);
  await flushOps(ops);
  return { days, rows, finalizedDates };
}

// ── 1. syncSpendDays ────────────────────────────────────────────────────────

/**
 * Pull Atlas daily buckets and upsert into AtlasSpendDay.
 * Two passes: liquidretail (key allowlist — reconciliation basis) and account
 * (full account — balance/burn context only).
 */
async function syncSpendDays({ lookbackDays } = {}) {
  const summary = {
    liquidretail: { days: 0, rows: 0 },
    account: { days: 0, rows: 0 },
    finalizedDates: []
  };

  // ── liquidretail pass ──
  // Explicit allowlist beats scope:'self': self means "whichever key
  // authenticated this request". The day liquidretail adds a second key,
  // self silently under-reports and the drift reads as a ledger bug.
  // Verified 2026-08-05 that
  //   scope=account&api_key_ids[]=ak_uLsOnKBB7nBIJ8OnKxoBEh
  // returns byte-identical totals to scope=self ($81.8170 for Aug 1–5), so
  // the allowlist is a safe substitute for self AND survives a second key.
  const keyIds = KEY_IDS();
  if (!keyIds.length) {
    // Loud on purpose. Silently falling back to unfiltered account data would
    // reconcile liquidretail's CostLog against three projects' spend — the
    // exact mix that makes the aggregate look fine while every category lies.
    console.warn(
      '   ⚠️  atlasSpendReconciler: ATLAS_BILLING_KEY_IDS is empty — ' +
      'skipping liquidretail sync. Drift detection has no basis until the ' +
      'allowlist is set. Will NOT fall back to unfiltered account spend.'
    );
  } else {
    const lr = await pullAndUpsert('liquidretail', keyIds, lookbackDays);
    summary.liquidretail = { days: lr.days, rows: lr.rows };
    summary.finalizedDates = lr.finalizedDates;
  }

  // ── account pass ──
  // No key filter. Balance/burn context ONLY — never fed to detectDrift.
  const acct = await pullAndUpsert('account', null, lookbackDays);
  summary.account = { days: acct.days, rows: acct.rows };

  return summary;
}

// ── ledger side ─────────────────────────────────────────────────────────────

/**
 * CostLog rollup for one UTC day, keyed by model slug.
 *
 * costSource four-way breakdown matters: measured 2026-08-05, 79% of CostLog
 * rows (8406 of 10676) have NO costSource field at all (predate the column).
 * A naive `costSource:'estimated'` filter counts them as neither and hides
 * the "we genuinely don't know" population. $ifNull buckets them as missing.
 */
async function ledgerByModelForDay(date) {
  const { start, end } = dayBoundsUtc(date);
  const rows = await CostLog.aggregate([
    {
      $match: {
        provider: 'atlas',
        createdAt: { $gte: start, $lt: end }
      }
    },
    {
      $group: {
        _id: '$model',
        costUsd: { $sum: '$costUsd' },
        n: { $sum: 1 },
        actual: {
          $sum: { $cond: [{ $eq: ['$costSource', 'actual'] }, 1, 0] }
        },
        estimated: {
          $sum: { $cond: [{ $eq: ['$costSource', 'estimated'] }, 1, 0] }
        },
        none: {
          $sum: { $cond: [{ $eq: ['$costSource', 'none'] }, 1, 0] }
        },
        missing: {
          $sum: {
            $cond: [
              { $eq: [{ $ifNull: ['$costSource', '__missing__'] }, '__missing__'] },
              1,
              0
            ]
          }
        }
      }
    }
  ]);

  const byModel = new Map();
  for (const r of rows) {
    const model = r._id || 'unknown';
    // Integer micros for comparison — never accumulate float dollars from
    // string money. CostLog is already float dollars; round to micros once.
    const micro = Math.round((Number(r.costUsd) || 0) * 1e6);
    byModel.set(model, {
      model,
      amountMicroUsd: micro,
      n: r.n || 0,
      costSource: {
        actual: r.actual || 0,
        estimated: r.estimated || 0,
        none: r.none || 0,
        missing: r.missing || 0
      }
    });
  }
  return byModel;
}

async function ledgerByModelForDates(dates) {
  // One aggregate over the min..max span, then filter to the finalized set.
  // Cheaper than N day queries and correct as long as we only keep rows whose
  // UTC day is in the finalized set (partial days must not dilute the window).
  if (!dates.length) return new Map();
  const sorted = dates.slice().sort();
  const { start } = dayBoundsUtc(sorted[0]);
  const { end } = dayBoundsUtc(sorted[sorted.length - 1]);

  const rows = await CostLog.aggregate([
    {
      $match: {
        provider: 'atlas',
        createdAt: { $gte: start, $lt: end }
      }
    },
    {
      $project: {
        model: 1,
        costUsd: 1,
        costSource: 1,
        day: {
          $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' }
        }
      }
    },
    { $match: { day: { $in: dates } } },
    {
      $group: {
        _id: '$model',
        costUsd: { $sum: '$costUsd' },
        n: { $sum: 1 },
        actual: {
          $sum: { $cond: [{ $eq: ['$costSource', 'actual'] }, 1, 0] }
        },
        estimated: {
          $sum: { $cond: [{ $eq: ['$costSource', 'estimated'] }, 1, 0] }
        },
        none: {
          $sum: { $cond: [{ $eq: ['$costSource', 'none'] }, 1, 0] }
        },
        missing: {
          $sum: {
            $cond: [
              { $eq: [{ $ifNull: ['$costSource', '__missing__'] }, '__missing__'] },
              1,
              0
            ]
          }
        }
      }
    }
  ]);

  const byModel = new Map();
  for (const r of rows) {
    const model = r._id || 'unknown';
    byModel.set(model, {
      model,
      amountMicroUsd: Math.round((Number(r.costUsd) || 0) * 1e6),
      n: r.n || 0,
      costSource: {
        actual: r.actual || 0,
        estimated: r.estimated || 0,
        none: r.none || 0,
        missing: r.missing || 0
      }
    });
  }
  return byModel;
}

// ── join + rollup ───────────────────────────────────────────────────────────

/**
 * Full outer join of Atlas liquidretail rows and CostLog, on model slug.
 *
 * THE RECONCILIATION HINGE: CostLog.model holds the Atlas slug
 * (e.g. google/gemini-2.5-flash) and AtlasSpendDay.modelName holds the
 * identical string. This deliberately avoids any stage→category map:
 * reframe-outpaint lives in atlasVideoService.js but calls
 * google/nano-banana-2/edit-developer — an IMAGE model — so a file- or
 * stage-based taxonomy would mis-bucket it. Atlas tells us model_type itself.
 *
 * Both sides of the join are drift:
 *   Atlas only  → unledgered spend (real money we never recorded)
 *   ledger only → phantom ledger spend (we recorded money Atlas never charged)
 * Dropping either direction would hide half the failure mode.
 */
function joinAtlasAndLedger(atlasRows, ledgerByModel) {
  const byModel = new Map();

  for (const row of atlasRows) {
    const name = row.modelName || 'unknown';
    const prev = byModel.get(name) || {
      model: name,
      modelType: row.modelType || null,
      atlasMicro: 0,
      ledgerMicro: 0,
      ledgerN: 0,
      costSource: { actual: 0, estimated: 0, none: 0, missing: 0 }
    };
    prev.atlasMicro += Number(row.amountMicroUsd) || 0;
    // Prefer a non-null modelType if any row carries one.
    if (!prev.modelType && row.modelType) prev.modelType = row.modelType;
    byModel.set(name, prev);
  }

  for (const [name, led] of ledgerByModel) {
    const prev = byModel.get(name) || {
      model: name,
      modelType: null,
      atlasMicro: 0,
      ledgerMicro: 0,
      ledgerN: 0,
      costSource: { actual: 0, estimated: 0, none: 0, missing: 0 }
    };
    prev.ledgerMicro += led.amountMicroUsd || 0;
    prev.ledgerN += led.n || 0;
    prev.costSource.actual += led.costSource.actual || 0;
    prev.costSource.estimated += led.costSource.estimated || 0;
    prev.costSource.none += led.costSource.none || 0;
    prev.costSource.missing += led.costSource.missing || 0;
    byModel.set(name, prev);
  }

  return byModel;
}

function rollupByModelType(byModel) {
  const cats = new Map();
  for (const m of byModel.values()) {
    // Phantom ledger-only rows have no Atlas model_type. Bucket as 'unknown'
    // rather than inventing a taxonomy — the alert still fires if dollars trip
    // the gate, and the per-model detail names the slug.
    const t = m.modelType || 'unknown';
    const c = cats.get(t) || {
      modelType: t,
      atlasMicro: 0,
      ledgerMicro: 0,
      ledgerN: 0,
      costSource: { actual: 0, estimated: 0, none: 0, missing: 0 },
      models: []
    };
    c.atlasMicro += m.atlasMicro;
    c.ledgerMicro += m.ledgerMicro;
    c.ledgerN += m.ledgerN;
    c.costSource.actual += m.costSource.actual;
    c.costSource.estimated += m.costSource.estimated;
    c.costSource.none += m.costSource.none;
    c.costSource.missing += m.costSource.missing;
    c.models.push(m);
    cats.set(t, c);
  }
  return cats;
}

function usdFromMicro(m) {
  return AtlasSpendDay.microsToUsd(m);
}

function driftMetrics(atlasMicro, ledgerMicro) {
  const atlasUsd = usdFromMicro(atlasMicro);
  const ledgerUsd = usdFromMicro(ledgerMicro);
  const absUsd = Math.abs(ledgerUsd - atlasUsd);
  // Floor the denominator at $0.01 so a $0 Atlas day with phantom ledger
  // spend still produces a finite, large relative — not NaN/Infinity.
  const rel = absUsd / Math.max(atlasUsd, 0.01);
  const ratio = atlasUsd > 0 ? ledgerUsd / atlasUsd : (ledgerUsd > 0 ? Infinity : 1);
  return { atlasUsd, ledgerUsd, absUsd, rel, ratio };
}

function tripsGate(metrics, absFloor, relFloor) {
  return metrics.absUsd >= absFloor && metrics.rel >= relFloor;
}

function topModelDeltas(models, n = 3) {
  return models
    .map((m) => {
      const deltaMicro = m.ledgerMicro - m.atlasMicro;
      return {
        model: m.model,
        atlasUsd: usdFromMicro(m.atlasMicro),
        ledgerUsd: usdFromMicro(m.ledgerMicro),
        deltaUsd: usdFromMicro(deltaMicro)
      };
    })
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))
    .slice(0, n);
}

function formatCostSource(cs) {
  return `actual=${cs.actual || 0} estimated=${cs.estimated || 0} none=${cs.none || 0} missing=${cs.missing || 0}`;
}

async function fireDriftAlert({ key, title, metrics, modelType, top, costSource, extraFields }) {
  const ratioStr = Number.isFinite(metrics.ratio)
    ? `${metrics.ratio.toFixed(2)}x`
    : '∞';
  await alerts.notify({
    // 'warn', not 'error'. This is a bookkeeping discrepancy, not a production
    // outage, and known drift (image 0.46x, video 1.14x) means it WILL fire on
    // first deploy until the Track A capture fixes land. Escalating a
    // guaranteed-at-first-run condition to 'error' is how an alert channel gets
    // muted. Balance-broken stays 'error' — that one really does stop the line.
    level: 'warn',
    title,
    key,
    fields: {
      category: modelType,
      ledger: `$${metrics.ledgerUsd.toFixed(2)}`,
      atlas: `$${metrics.atlasUsd.toFixed(2)}`,
      ratio: ratioStr,
      'abs delta': `$${metrics.absUsd.toFixed(2)}`,
      'rel delta': `${(metrics.rel * 100).toFixed(1)}%`,
      costSource: formatCostSource(costSource),
      ...(extraFields || {})
    },
    detail: [
      'top model deltas (ledger − atlas):',
      ...top.map((t) =>
        `  ${t.model}: ledger=$${t.ledgerUsd.toFixed(4)} atlas=$${t.atlasUsd.toFixed(4)} ` +
        `Δ=$${t.deltaUsd.toFixed(4)}`
      ),
      '',
      // Actionable split: unledgered = Atlas>0 & ledger=0; phantom = reverse.
      'Join is full-outer on model slug (CostLog.model ↔ AtlasSpendDay.modelName).',
      'Unledgered spend = Atlas charged, CostLog silent. Phantom = CostLog charged, Atlas silent.'
    ].join('\n')
  });
}

// ── 2. detectDrift ──────────────────────────────────────────────────────────

/**
 * Compare ONE finalized day. Returns a structured result and fires an alert
 * when the AND-gate trips on a modelType rollup.
 */
async function detectDrift({ date } = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { skipped: true, reason: 'date required (YYYY-MM-DD UTC)' };
  }

  // 1. Refuse to reconcile a non-final day. A partial day ALWAYS reads as
  // "ledger over" (Atlas's covered_until trails real-time charges, CostLog
  // does not) — the single most important guard in this file.
  const atlasRows = await AtlasSpendDay.find({
    scope: 'liquidretail',
    date,
    groupBy: 'model'
  }).lean();

  if (!atlasRows.length) {
    return { skipped: true, reason: `no liquidretail rows for ${date}`, date };
  }
  if (atlasRows.some((r) => r.partial === true)) {
    return {
      skipped: true,
      reason: `day ${date} is partial — not safe to reconcile`,
      date
    };
  }

  // 2–3. Atlas by model + ledger aggregate for the UTC day.
  const ledgerByModel = await ledgerByModelForDay(date);

  // 4–5. Full outer join on model slug.
  const joined = joinAtlasAndLedger(atlasRows, ledgerByModel);

  // 6. Roll up to modelType; evaluate gates on category totals.
  const cats = rollupByModelType(joined);
  const absFloor = DRIFT_ABS_USD();
  const relFloor = DRIFT_PCT();

  const categories = {};
  const alerted = [];

  for (const [modelType, cat] of cats) {
    const metrics = driftMetrics(cat.atlasMicro, cat.ledgerMicro);
    const top = topModelDeltas(cat.models, 3);
    const shouldAlert = tripsGate(metrics, absFloor, relFloor);

    categories[modelType] = {
      atlasUsd: metrics.atlasUsd,
      ledgerUsd: metrics.ledgerUsd,
      ratio: metrics.ratio,
      absUsd: metrics.absUsd,
      rel: metrics.rel,
      alerted: shouldAlert,
      costSource: cat.costSource,
      topModels: top
    };

    if (shouldAlert) {
      // Dedup once per (date, modelType) window — alertService folds repeats.
      await fireDriftAlert({
        key: `atlas-drift:${date}:${modelType}`,
        title: `Atlas drift ${date} · ${modelType}: ledger $${metrics.ledgerUsd.toFixed(2)} vs Atlas $${metrics.atlasUsd.toFixed(2)}`,
        metrics,
        modelType,
        top,
        costSource: cat.costSource,
        extraFields: { date }
      });
      alerted.push(modelType);
    }
  }

  return {
    skipped: false,
    date,
    categories,
    alerted,
    modelCount: joined.size
  };
}

// ── 3. detectRollingDrift ───────────────────────────────────────────────────

/**
 * Trailing-N finalized-day category drift. First-class, not an afterthought:
 * image ran 0.46x under for 35 consecutive days at ~$1.11/day — below any
 * sane daily abs floor — so detectDrift alone would have stayed silent.
 */
async function detectRollingDrift() {
  const windowN = ROLLING_WINDOW_DAYS();
  const minDays = ROLLING_MIN_DAYS();

  // Look far enough back to assemble `windowN` finalized days even if some
  // recent days are still partial. 3× window is ample at a 5-min cadence.
  const today = utcYmd();
  const lookFrom = addUtcDays(today, -(windowN * 3 + 2));

  const rows = await AtlasSpendDay.find({
    scope: 'liquidretail',
    groupBy: 'model',
    date: { $gte: lookFrom, $lt: today } // exclude today — always partial mid-day
  }).select('date partial modelName modelType amountMicroUsd').lean();

  // date → { partial:bool, rows:[] }
  const byDate = new Map();
  for (const r of rows) {
    const slot = byDate.get(r.date) || { partial: false, rows: [] };
    if (r.partial === true) slot.partial = true;
    slot.rows.push(r);
    byDate.set(r.date, slot);
  }

  const finalizedDates = [...byDate.entries()]
    .filter(([, v]) => v.rows.length && !v.partial)
    .map(([d]) => d)
    .sort()
    .slice(-windowN);

  if (finalizedDates.length < minDays) {
    return {
      skipped: true,
      reason: `only ${finalizedDates.length} finalized days (need ${minDays})`,
      finalizedDates
    };
  }

  const atlasRows = finalizedDates.flatMap((d) => byDate.get(d).rows);
  const ledgerByModel = await ledgerByModelForDates(finalizedDates);
  const joined = joinAtlasAndLedger(atlasRows, ledgerByModel);
  const cats = rollupByModelType(joined);

  const absFloor = DRIFT_ROLLING_ABS_USD();
  const relFloor = DRIFT_PCT();
  const latestDate = finalizedDates[finalizedDates.length - 1];
  const categories = {};
  const alerted = [];

  for (const [modelType, cat] of cats) {
    const metrics = driftMetrics(cat.atlasMicro, cat.ledgerMicro);
    const top = topModelDeltas(cat.models, 3);
    const shouldAlert = tripsGate(metrics, absFloor, relFloor);

    categories[modelType] = {
      atlasUsd: metrics.atlasUsd,
      ledgerUsd: metrics.ledgerUsd,
      ratio: metrics.ratio,
      absUsd: metrics.absUsd,
      rel: metrics.rel,
      alerted: shouldAlert,
      costSource: cat.costSource,
      topModels: top
    };

    if (shouldAlert) {
      // Keyed on latestDate so a persistent problem re-alerts once per window
      // advance rather than every tick (alertService also dedupes in-window).
      await fireDriftAlert({
        key: `atlas-drift-rolling:${latestDate}:${modelType}`,
        title: `Atlas rolling drift (${finalizedDates.length}d) · ${modelType}: ledger $${metrics.ledgerUsd.toFixed(2)} vs Atlas $${metrics.atlasUsd.toFixed(2)}`,
        metrics,
        modelType,
        top,
        costSource: cat.costSource,
        extraFields: {
          window: `${finalizedDates[0]}…${latestDate}`,
          days: finalizedDates.length
        }
      });
      alerted.push(modelType);
    }
  }

  return {
    skipped: false,
    finalizedDates,
    categories,
    alerted,
    modelCount: joined.size
  };
}

// ── 4. checkBalance ─────────────────────────────────────────────────────────

/**
 * Balance health. Auto-refill is $30/chunk against ~$35/day burn, so a single
 * sub-threshold read is NORMAL. Two distinct signals:
 *   - refill stalled: available below floor for N consecutive calls
 *   - refill broken:  overdrawn > 0 OR creditGrantStatus !== 'normal'
 *
 * Do NOT compute or publish "days of runway". With auto-refill it is
 * meaningless, and publishing it invites exactly the misreading that
 * "$30 balance = 0.9 days left" already caused once. Leave it out.
 */
async function checkBalance() {
  const bal = await getBalance();
  const availableUsd = Number(bal.availableUsd);
  const overdrawnUsd = Number(bal.overdrawnUsd) || 0;
  const creditGrantStatus = bal.creditGrantStatus ?? null;
  const floor = BALANCE_ALERT_USD();
  const needStreak = BALANCE_LOW_STREAK();

  // Trailing-7-day mean daily burn from account scope. The prepaid pool is
  // shared across three projects, so liquidretail-only burn understates the
  // drain ~2x (measured liquidretail ≈ 53% of account on 2026-08-05).
  const today = utcYmd();
  const burnFrom = addUtcDays(today, -BURN_WINDOW_DAYS);
  const [acctRows, lrRows] = await Promise.all([
    AtlasSpendDay.find({
      scope: 'account',
      groupBy: 'model',
      date: { $gte: burnFrom, $lt: today }
    }).select('date amountMicroUsd').lean(),
    AtlasSpendDay.find({
      scope: 'liquidretail',
      groupBy: 'model',
      date: { $gte: burnFrom, $lt: today }
    }).select('date amountMicroUsd').lean()
  ]);

  // Divide by the CALENDAR window, not by the number of days that happen to
  // have rows. Atlas omits a zero-spend day from the response entirely (verified:
  // 2026-07-04/05 are simply absent), so days-with-rows would silently mean
  // "mean spend on active days" and overstate the burn — on a window with 3
  // active days out of 7 that is a 2.3x exaggeration in an alert whose whole job
  // is to be trusted. An absent day is a genuine $0.
  const meanDailyBurn = (rows) => {
    const byDate = new Map();
    for (const r of rows) {
      byDate.set(r.date, (byDate.get(r.date) || 0) + (Number(r.amountMicroUsd) || 0));
    }
    let sum = 0;
    for (const m of byDate.values()) sum += m;
    return usdFromMicro(sum / BURN_WINDOW_DAYS);
  };

  const accountBurnPerDay = meanDailyBurn(acctRows);
  const liquidretailBurnPerDay = meanDailyBurn(lrRows);
  const lrShare = accountBurnPerDay > 0
    ? liquidretailBurnPerDay / accountBurnPerDay
    : null;

  // ── refill broken: unambiguous, alert on FIRST occurrence ──
  const statusNormal = creditGrantStatus == null
    || String(creditGrantStatus).toLowerCase() === 'normal';
  const broken = overdrawnUsd > 0 || !statusNormal;

  // ── refill stalled: streak of consecutive low reads ──
  const isLow = Number.isFinite(availableUsd) && availableUsd < floor;
  if (isLow) lowBalanceStreak += 1;
  else lowBalanceStreak = 0;

  const stalled = !broken && lowBalanceStreak >= needStreak;

  const result = {
    availableUsd: Number.isFinite(availableUsd) ? availableUsd : null,
    overdrawnUsd,
    creditGrantStatus,
    lowBalanceStreak,
    balanceFloorUsd: floor,
    accountBurnPerDay,
    liquidretailBurnPerDay,
    liquidretailShare: lrShare,
    broken,
    stalled,
    alerted: false
  };

  if (!broken && !stalled) return result;

  result.alerted = true;
  const title = broken
    ? `Atlas balance broken — overdrawn=$${overdrawnUsd.toFixed(2)} status=${creditGrantStatus}`
    : `Atlas balance low for ${lowBalanceStreak} consecutive checks ($${availableUsd.toFixed(2)} < $${floor})`;

  await alerts.notify({
    level: broken ? 'error' : 'warn',
    title,
    key: 'watchdog:atlas-balance',
    fields: {
      available: Number.isFinite(availableUsd) ? `$${availableUsd.toFixed(2)}` : 'n/a',
      overdrawn: `$${overdrawnUsd.toFixed(2)}`,
      creditGrantStatus: creditGrantStatus ?? 'n/a',
      'account burn/day (7d)': `$${accountBurnPerDay.toFixed(2)}`,
      'liquidretail burn/day (7d)': `$${liquidretailBurnPerDay.toFixed(2)}`,
      'liquidretail share': lrShare == null ? 'n/a' : `${(lrShare * 100).toFixed(0)}%`,
      streak: broken ? undefined : `${lowBalanceStreak}/${needStreak}`,
      signal: broken ? 'refill-broken' : 'refill-stalled'
      // Explicitly NO "days of runway" — see file header / function comment.
    }
  });

  return result;
}

// ── 5. runReconcilerTick ────────────────────────────────────────────────────

/**
 * Single entry point the worker calls. checkBalance is NOT here — the
 * watchdog owns it on a tighter cadence. Never throws.
 */
async function runReconcilerTick() {
  if (!BILLING_ENABLED() || !process.env.ATLAS_API_KEY) {
    if (!disabledLogged) {
      const why = !BILLING_ENABLED()
        ? 'ATLAS_BILLING_ENABLED=false'
        : 'ATLAS_API_KEY missing';
      console.log(`   💲 atlasSpendReconciler: disabled (${why}) — tick no-op`);
      disabledLogged = true;
    }
    return { skipped: true, reason: 'disabled' };
  }
  disabledLogged = false;

  const out = {
    sync: null,
    drift: [],
    rolling: null,
    errors: []
  };

  // Per-section try/catch: one failure must not prevent the others
  // (match backlogWatchdog.js). Billing being unreachable is an alert-worthy
  // condition, not a worker-killing one.
  let syncResult = null;
  try {
    syncResult = await syncSpendDays();
    out.sync = syncResult;
  } catch (err) {
    console.warn(`   ⚠️  atlasSpendReconciler[sync] failed: ${err.message}`);
    out.errors.push({ section: 'sync', message: err.message });
  }

  if (syncResult && Array.isArray(syncResult.finalizedDates)) {
    for (const date of syncResult.finalizedDates) {
      try {
        const r = await detectDrift({ date });
        out.drift.push(r);
      } catch (err) {
        console.warn(`   ⚠️  atlasSpendReconciler[drift:${date}] failed: ${err.message}`);
        out.errors.push({ section: 'drift', date, message: err.message });
      }
    }
  }

  try {
    out.rolling = await detectRollingDrift();
  } catch (err) {
    console.warn(`   ⚠️  atlasSpendReconciler[rolling] failed: ${err.message}`);
    out.errors.push({ section: 'rolling', message: err.message });
  }

  return out;
}

module.exports = {
  syncSpendDays,
  detectDrift,
  detectRollingDrift,
  checkBalance,
  runReconcilerTick
};
