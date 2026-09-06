'use strict';
//
// DURABLE COST-RECONCILE SWEEP — backstop for CostLog rows stuck on
// costSource:'estimated' after the owning process died.
//
// WHY. atlasImageService.scheduleCostReconcile and
// atlasVideoService.scheduleVideoCostReconcile upgrade a charge-point
// CostLog row from estimate → Atlas's settled `price` via an in-process
// setTimeout(...).unref() chain (delays [3s, 10s, 30s, 60s, 120s, 300s],
// 523s / ~8.7 min total). Those schedulers fire at a TERMINAL outcome,
// then sleep 523s — they do not start at submit. They are also not the
// only upgraders: bootRecoveryService, imageRecoveryService.finalizeFlatCost,
// atlasVideoService.reconcileVideoCostFromTerminal, and
// liquidretail_backend's scripts/backfillCostReconcile.js also upgrade
// estimated rows. This sweep is the durable backstop for rows whose
// in-process chain died with the process (deploy SIGTERM, OOM, crash)
// and that those other paths did not already settle.
//
// That is money-facing: 'estimated' is frequently significantly WRONG
// (video MODEL_CAPS ~33% HIGH; image base_price floor ~7x LOW). A row
// stuck on 'estimated' forever means the cost ledger is wrong forever
// for that generation. The in-memory timer structurally cannot survive
// a restart.
//
// ── NO NEW SCHEMA ──────────────────────────────────────────────────────
// CostLog already carries everything needed: providerRequestId (the
// Atlas prediction id, indexed but NOT unique), costSource (indexed enum),
// provider, createdAt (submit time).
//
// Video charge-point: `await recordFlatCost` at submit, before polling.
// Image charge-point: `recordFlatCost(...).catch?.(() => {})` at submit —
// fire-and-forget, NOT awaited. A death between the image POST and that
// insert leaves NO row; this sweep structurally cannot see a missing
// row. Do not claim the charge-point write is synchronous on both paths.
//
// Discriminator for "Atlas prediction row eligible to peek":
//   provider:'atlas' AND providerRequestId != null AND costSource:'estimated'
// This correctly EXCLUDES atlasLlmStreamService.recordFlatCost rows,
// which also set provider:'atlas' and default costSource:'estimated'
// but never set providerRequestId. Do not narrow further by stage.
//
// ── NO CLAIM, ON PURPOSE ───────────────────────────────────────────────
// Same argument as bootRecoveryService's header. Autoscaling means
// several renderer instances will all run this.
//
//   1. The only provider call is a free authenticated GET. Two instances
//      peeking the same prediction wastes one HTTP request and nothing
//      else. Never a billable POST.
//   2. The write is estimated → actual, keyed on {_id, providerRequestId,
//      costSource:'estimated'}. Mongo `updateOne` is first-writer-wins:
//      the loser matches zero documents. A stale writer that wins would
//      lock the row on a non-final price, after which reconcileCost
//      refuses the settled figure. That race is removed by construction:
//      a row is only written when Atlas's own record is TERMINAL and
//      carries a usable price. providerRequestId is index:true but NOT
//      unique (CostLog.js), so the filter also pins row._id — the sweep
//      has it; discarding it can retarget a different row.
//
// ── TERMINAL STATUS IS THE GATE, NOT AGE ───────────────────────────────
// Eligibility for a WRITE is Atlas terminal status, classified by the
// same arms as liquidretail_backend's scripts/backfillCostReconcile.js
// `classifyRow` (helpers imported from atlasVideoService; not a third
// copy). minAgeMs is NOT load-bearing for correctness. The old 10 min
// floor was justified as sitting past the in-process chain; that was
// false: the chain is scheduled at terminal and then sleeps 523s, and
// video MAX_POLL_MS is 900s, so createdAt + 10 min can still be an
// in-flight prediction. Peeking that and `$set costSource:'actual'` on
// a non-final price is the defect this rewrite exists to close.
//
// minAgeMs (default 600_000 = 10 min) remains only as a query/politeness
// bound so we do not GET every young estimated row the live chain will
// handle. maxAgeMs (default 172_800_000 = 48h) bounds how long we keep
// re-polling a row that may never settle.
//
// ── $0 / costSource:'none' IS REPORT-ONLY ──────────────────────────────
// The two error directions are asymmetric. A row left estimated that
// should be $0 over-reports (visible, harmless, correctable). A row
// wrongly written to $0 erases real spend (invisible, unrecoverable).
// This sweep writes ONLY estimated → actual, on a provider-terminal
// row with a usable price. The failed-unbilled class
// (`confirmedCharge.charged === false`) is logged for a human and
// NEVER passed to the write. The repair tool is
// `scripts/backfillCostReconcile.js` in the `liquidretail_backend`
// repo — it is not in adgen.
//
// Env overrides: COST_RECONCILE_MIN_AGE_MS, COST_RECONCILE_MAX_AGE_MS,
// COST_RECONCILE_MAX_ROWS, COST_RECONCILE_INTERVAL_MIN (the last is
// read by renderer.js's startCostReconcileSweep). Negative / NaN env
// values fall back to the default — they must not clamp to 0.

const CostLog = require('../models/CostLog');
// axios is required LAZILY inside peekSettledPrice; atlasVideoService
// (confirmedCharge / SETTLED_POLL_STATUSES / TERMINAL_OK_STATUSES) is
// required LAZILY inside classifyRow. A top-level require of
// atlasVideoService pulls in axios and would make this module unloadable
// in a bare worktree — scripts/verifyDurableCostReconcile.js must exit 0
// with no node_modules and no network, injecting `peek` / `classify` so
// those paths are never taken in the harness. Production renderer has axios.

function envInt(raw, fallback, minInclusive) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < minInclusive) return fallback;
  return n;
}

const DEFAULT_MIN_AGE_MS = envInt(process.env.COST_RECONCILE_MIN_AGE_MS, 600_000, 0);
const DEFAULT_MAX_AGE_MS = envInt(process.env.COST_RECONCILE_MAX_AGE_MS, 172_800_000, 1);
const DEFAULT_MAX_ROWS   = envInt(process.env.COST_RECONCILE_MAX_ROWS, 50, 1);

/**
 * Pure Mongo filter for Atlas prediction rows this sweep will peek.
 * minAgeMs / maxAgeMs are politeness / retention bounds, not a
 * correctness gate — Atlas terminal status is.
 *
 * MONEY: the costSource:'estimated' arm is what makes a second pass after
 * a successful reconcile a no-op (the row no longer matches). The
 * providerRequestId != null arm is what excludes atlasLlmStreamService
 * flat-cost rows (same provider, never a prediction id).
 */
function buildReconcileFilter({
  now = Date.now(),
  minAgeMs = DEFAULT_MIN_AGE_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  return {
    provider: 'atlas',
    providerRequestId: { $ne: null },
    costSource: 'estimated',
    createdAt: {
      $lt: new Date(now - minAgeMs),
      $gt: new Date(now - maxAgeMs)
    }
  };
}

/**
 * Free GET of an Atlas prediction. Returns { httpStatus, data } for
 * classifyRow, or null when the GET itself failed. NEVER throws —
 * network errors stay unknown (matches the "unknown stays unknown,
 * never invent a number" rule used everywhere else on this path).
 *
 * `data` is the inner prediction object (`res.data.data`), matching
 * liquidretail_backend's scripts/backfillCostReconcile.js fetchPrediction.
 * peekPrediction is the same GET but classifies internally and drops
 * httpStatus / the raw payload, so it cannot be the peek here.
 *
 * NEVER a billable POST. validateStatus: () => true so a non-2xx
 * (Atlas serves failed predictions as HTTP 500 with a complete
 * data.status:'failed' body) does not throw; res.status is passed through.
 */
async function peekSettledPrice(predictionId) {
  if (!predictionId) return null;
  try {
    const axios = require('axios');
    const base = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';
    const res = await axios.get(`${base}/model/prediction/${predictionId}`, {
      headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` },
      timeout: 15_000,
      validateStatus: () => true
    });
    const data = res.data && res.data.data ? res.data.data : null;
    return { httpStatus: res.status, data };
  } catch (err) {
    console.warn(
      `   ⚠️  costReconcileSweep: peek failed for ${predictionId}: ${err && err.message}`
    );
    return null;
  }
}

/**
 * THE MONEY GATE: is `raw` a price Atlas actually PUBLISHED?
 *
 * This single predicate separates the two states that must never blur:
 *
 *   PUBLISHED zero  → transcription. Atlas said the figure is 0. Written.
 *   ABSENT price    → inference. We would be guessing 0. Report-only.
 *
 * It decides by TYPE and by literal form, never by coercion, because
 * JavaScript's `Number()` collapses several "absent" shapes onto 0:
 *
 *   Number('')  === 0     Number(' ')   === 0     Number('\n') === 0
 *   Number([])  === 0     Number([5])   === 5     Number(null) === 0
 *   Number(false) === 0
 *
 * Any of those reaching a `>= 0` test writes a settled $0 over a real
 * estimate — erasing spend that was genuinely billed.
 *
 * A JSON number is NOT sufficient on its own: Atlas sends `price` as a
 * STRING (measured: "0.9", "0.75" — see atlasVideoService.parseAtlasSettledPrice's
 * own note), so a number-only gate would reject every real price and send
 * the whole success arm to report-only. A numeric string is therefore
 * accepted, but only when it is a well-formed numeric literal: a string
 * that is empty or whitespace is an ABSENT price wearing a string's type.
 *
 * DELIBERATE DIVERGENCE from backend's classifyRow, recorded rather than
 * mirrored: backend tests only `!== undefined && !== null && !== ''` before
 * `Number(raw)`, so `price: []` and `price: ' '` both coerce to a settled
 * $0 there. Mirroring a bug for parity is how a defect becomes a
 * convention; backend gets its own MONEY fix.
 */
function isPublishedPrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw === 'string') {
    if (raw.trim() === '') return false;          // '', ' ', '\n' are ABSENT
    return Number.isFinite(Number(raw));
  }
  return false;                                    // null/undefined/[]/{}/bool
}

/**
 * Pure classification for one peeked Atlas prediction.
 *
 * Mirrors liquidretail_backend's scripts/backfillCostReconcile.js
 * classifyRow (written after a live dry-run) in every arm except one:
 * `charged === false` is `action:'report'`, never a write. A wrong $0
 * erases real spend; leaving the row estimated over-reports and is
 * correctable via that backend script.
 *
 * DELIBERATELY ASYMMETRIC between success and failure — same reason as
 * the backend original. confirmedCharge()'s "absent price → charged
 * false" rule is justified ONLY for a FAILURE verdict (measured: failed
 * predictions carry no price because Atlas refunds them). A successful
 * generation does not always have `price` published on the completion
 * payload either (images: 7/38 at completion), so on completed/succeeded
 * an absent price means "not yet published", not "confirmed free".
 *
 * Helpers (confirmedCharge, SETTLED_POLL_STATUSES, TERMINAL_OK_STATUSES)
 * are lazy-required from atlasVideoService — do not write a third copy.
 */
function classifyRow({ httpStatus, data } = {}) {
  const {
    confirmedCharge,
    SETTLED_POLL_STATUSES,
    TERMINAL_OK_STATUSES
  } = require('./atlasVideoService');

  if (httpStatus === 404 || !data) return { action: 'leave', reason: 'prediction not found' };
  const status = String(data.status || '').toLowerCase();
  if (!SETTLED_POLL_STATUSES.has(status)) return { action: 'leave', reason: `still ${status || 'unknown'}` };

  if (TERMINAL_OK_STATUSES.has(status)) {
    const raw = data.price;
    const n = Number(raw);
    if (isPublishedPrice(raw) && n >= 0) {
      return { action: 'reconcile', costUsd: n, costSource: 'actual' };
    }
    return { action: 'leave', reason: 'completed but price not yet published' };
  }

  const { charged, priceUsd } = confirmedCharge(data);
  if (charged === true && priceUsd != null && Number.isFinite(Number(priceUsd)) && Number(priceUsd) > 0) {
    return { action: 'reconcile', costUsd: Number(priceUsd), costSource: 'actual' };
  }
  if (charged === false) {
    return {
      action: 'report',
      costUsd: 0,
      costSource: 'none',
      reason: 'failed and Atlas confirms no charge'
    };
  }
  return { action: 'leave', reason: 'failed but charge state unreadable' };
}

/**
 * estimated → actual, pinned on {_id, providerRequestId, costSource:'estimated'}.
 *
 * Same contract as costTracker.reconcileCost plus `_id`. reconcileCost keys
 * only on providerRequestId, which is indexed but NOT unique; this sweep
 * has row._id in hand and must not discard it. Refuses any costSource other
 * than 'actual' so a $0 / 'none' write cannot land through this helper.
 */
async function reconcileEstimatedById({ _id, providerRequestId, costUsd, costSource = 'actual' } = {}) {
  if (_id == null || !providerRequestId || !Number.isFinite(Number(costUsd))) return false;
  if (costSource !== 'actual') return false;
  if (!CostLog.COST_SOURCES.includes(costSource)) return false;
  try {
    const res = await CostLog.updateOne(
      { _id, providerRequestId, costSource: 'estimated' },
      { $set: { costUsd: Number(costUsd), costSource } }
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    if (n) console.log(`   💲 cost reconciled ${providerRequestId} -> $${Number(costUsd).toFixed(6)} (${costSource})`);
    return !!n;
  } catch (err) {
    console.warn(`   ⚠️  cost reconcile failed for ${providerRequestId}: ${err.message}`);
    return false;
  }
}

/**
 * One sweep pass. NEVER throws — a bad row / network blip must not kill
 * the interval. Returns { considered, reconciled, stillPending, reportedUnbilled, errors }.
 *
 * `peek` / `reconcile` / `classify` are injectable so
 * scripts/verifyDurableCostReconcile.js can drive the REAL query/update
 * logic against miniMongoStub without network or a live Mongo connection
 * (same pattern as bootRecoveryService.resumeInFlightAds's recoverImage
 * injection). Injected peek must return { httpStatus, data } or null —
 * never a bare price.
 *
 * MONEY: the only write is estimated → actual, pinned on _id. The
 * failed-unbilled class is counted in reportedUnbilled and logged; it
 * is never written.
 */
async function sweepCostReconcile({
  now = Date.now(),
  limit = DEFAULT_MAX_ROWS,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  peek = peekSettledPrice,
  reconcile = reconcileEstimatedById,
  classify = classifyRow
} = {}) {
  const out = { considered: 0, reconciled: 0, stillPending: 0, reportedUnbilled: 0, errors: 0 };
  try {
    let rows;
    try {
      rows = await CostLog.find(buildReconcileFilter({ now, minAgeMs, maxAgeMs }))
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();
    } catch (err) {
      console.warn(`⚠️  costReconcileSweep: could not query CostLog — ${err && err.message}`);
      return out;
    }
    out.considered = Array.isArray(rows) ? rows.length : 0;
    if (!out.considered) return out;

    const reports = [];

    for (const row of rows) {
      try {
        if (row._id == null) {
          out.errors++;
          console.warn(
            `   ⚠️  costReconcileSweep: row ${row && row.providerRequestId} has no _id — refusing un-pinned write`
          );
          continue;
        }

        const peeked = await peek(row.providerRequestId);
        if (!peeked || typeof peeked !== 'object') {
          // Network blip / empty id / injected peek returning a bare
          // number. NOT a 404 — absence of evidence is not "not found".
          out.stillPending++;
          continue;
        }

        const verdict = classify(peeked);

        if (verdict.action === 'report') {
          out.reportedUnbilled++;
          reports.push({
            providerRequestId: row.providerRequestId,
            _id: row._id,
            stage: row.stage,
            estimatedUsd: row.costUsd,
            reason: verdict.reason
          });
          continue;
        }

        // Load-bearing: never write costSource:'none' / $0 through this
        // arm, even if classifyRow is later "fixed" back to a write.
        if (verdict.action === 'reconcile' && verdict.costSource === 'actual') {
          const updated = await reconcile({
            _id: row._id,
            providerRequestId: row.providerRequestId,
            costUsd: verdict.costUsd,
            costSource: 'actual'
          });
          // Falsy = another instance already flipped costSource (or the
          // row vanished). NOT an error — the write is a no-op by design.
          if (updated) out.reconciled++;
          else out.stillPending++;
          continue;
        }

        out.stillPending++;
      } catch (err) {
        out.errors++;
        console.warn(
          `   ⚠️  costReconcileSweep: row ${row && row.providerRequestId} failed — ${err && err.message}`
        );
      }
    }

    if (reports.length) {
      console.warn(
        `💲 costReconcileSweep: ${reports.length} estimated row(s) look Atlas-unbilled ` +
        `(terminal failure, confirmedCharge.charged === false) and were NOT written to $0. ` +
        `A wrong $0 erases real spend; leaving them estimated over-reports (visible, correctable). ` +
        `Inspect and apply via scripts/backfillCostReconcile.js in the liquidretail_backend repo ` +
        `(that script is not in adgen). ` +
        reports.map((r) =>
          `${r.providerRequestId} [_id=${r._id} stage=${r.stage} estimated=$${Number(r.estimatedUsd)}] (${r.reason})`
        ).join('; ')
      );
    }

    if (out.considered > 0) {
      console.log(
        `💲 costReconcileSweep: considered=${out.considered} reconciled=${out.reconciled} ` +
        `stillPending=${out.stillPending} reportedUnbilled=${out.reportedUnbilled} errors=${out.errors}`
      );
    }
    return out;
  } catch (err) {
    console.warn(`⚠️  costReconcileSweep: pass failed — ${err && err.message}`);
    return out;
  }
}

module.exports = {
  buildReconcileFilter,
  peekSettledPrice,
  // Exported so the harness asserts the REAL money gate, not a restatement.
  isPublishedPrice,
  classifyRow,
  sweepCostReconcile,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ROWS
};