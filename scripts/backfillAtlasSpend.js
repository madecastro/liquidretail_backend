#!/usr/bin/env node
//
// backfillAtlasSpend.js — added 2026-08-05 with the Atlas billing reconciler.
//
// Two independent, additive-only backfills. NEVER mutates CostLog.costUsd or
// costSource — owner decision: store Atlas truth, do not rewrite the ledger,
// because rewriting estimates in place destroys the evidence of what went wrong.
//
//   --spend       Pull the full retained Atlas billing window into AtlasSpendDay
//                 (both liquidretail + account scopes). Free GETs only.
//   --video-ids   Restore providerRequestId on atlas_video_render CostLog rows
//                 from Ad.veoPredictionId (the spend receipt already persisted
//                 at the charge point). Makes the 175 existing video rows
//                 reconcilable without touching dollar figures.
//   --all         Both.
//   --dry-run     Preview only; no writes.
//
// Expected baseline (measured live 2026-08-05, production Reach-Social.io):
//   liquidretail ≈ $413.19   account ≈ $819.98
// over the retained window. Printed next to the actual totals so a mismatch
// is obvious.
//
// Usage:
//   node scripts/backfillAtlasSpend.js --spend
//   node scripts/backfillAtlasSpend.js --spend --dry-run
//   node scripts/backfillAtlasSpend.js --video-ids
//   node scripts/backfillAtlasSpend.js --all
//
// Requires MONGODB_URI + (for --spend) ATLAS_API_KEY. ATLAS_BILLING_KEY_IDS
// must be set for the liquidretail pass (same rule as atlasSpendReconciler).

'use strict';

require('dotenv').config();
require('dotenv').config({
  path: require('path').join(__dirname, '..', 'config', 'defaults.env')
});

const mongoose = require('mongoose');
const AtlasSpendDay = require('../models/AtlasSpendDay');
const CostLog = require('../models/CostLog');
const Ad = require('../models/Ad');
const { getModelCosts, getModelUsage } = require('../services/atlasBillingClient');

// Measured live 2026-08-05 — printed next to grand totals for visual compare.
const EXPECTED_LIQUIDRETAIL_USD = 413.19;
const EXPECTED_ACCOUNT_USD = 819.98;

// syncSpendDays caps lookback at 30 days (recent-tick re-pull). Historical
// backfill must call the client directly and reuse the same upsert shape.
// Ask for a wide range; dateWindows chunks at 180 days and pre-retention
// windows simply return empty buckets.
const HISTORY_LOOKBACK_DAYS = 400;

const BULK_BATCH = 500;

// ── date helpers (UTC — Atlas buckets are UTC days) ─────────────────────────

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

// ── money / usage (mirrors atlasSpendReconciler — keep in lockstep) ─────────

function amountToMicros(amount) {
  if (amount == null || amount === '') return 0;
  if (typeof amount === 'object') {
    return AtlasSpendDay.usdStringToMicros(
      amount.value != null ? amount.value : amount.amount
    );
  }
  return AtlasSpendDay.usdStringToMicros(amount);
}

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
  return r.model.name || null;
}

function resultMergeKey(r) {
  return modelSlugFromResult(r) || (r?.model && r.model.id) || r?.model_type || '_';
}

function buildUpsertOp({
  date, scope, modelType, modelName, modelId, apiKeyId, apiKeyName,
  amountMicroUsd, usageFlat, requests, partial, coveredUntil, currency, atlasRequestId
}) {
  // bulkWrite skips pre('validate') — key MUST be computed here as the filter.
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

/**
 * Merge cost + usage buckets into upsert ops for one stored scope.
 * Same identity / finality rules as atlasSpendReconciler.bucketsToOps.
 */
function bucketsToOps(costBuckets, usageBuckets, scope) {
  const byDate = new Map();

  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
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
      if (bucket.partial === true) slot.sawPartial = true;
      else if (bucket.partial === false) slot.sawFinal = true;
      else slot.sawPartial = true;
      if (bucket.covered_until) {
        const cu = new Date(bucket.covered_until);
        if (!Number.isNaN(cu.getTime())) slot.coveredUntil = cu;
      }
      if (bucket.currency) slot.currency = bucket.currency;
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
  const dayMicros = new Map(); // date → total amountMicroUsd (for month summary)

  for (const [date, slot] of byDate) {
    const partial = !(slot.sawFinal && !slot.sawPartial);
    let daySum = 0;
    for (const { cost, usage } of slot.results.values()) {
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
      const requests = Number(
        (usage && usage.requests)
        ?? (usageSrc && usageSrc.requests)
        ?? (cost && cost.requests)
        ?? 0
      ) || 0;
      const amountMicroUsd = amountToMicros(cost && cost.amount);
      daySum += amountMicroUsd;

      ops.push(buildUpsertOp({
        date,
        scope,
        modelType,
        modelName,
        modelId,
        apiKeyId,
        apiKeyName,
        amountMicroUsd,
        usageFlat,
        requests,
        partial,
        coveredUntil: slot.coveredUntil,
        currency: (cost && cost.currency) || (usage && usage.currency) || slot.currency,
        atlasRequestId: slot.atlasRequestId
      }));
    }
    dayMicros.set(date, (dayMicros.get(date) || 0) + daySum);
  }

  return { ops, dayMicros, days: byDate.size, rows: ops.length };
}

async function flushOps(ops) {
  if (!ops.length) return 0;
  let written = 0;
  for (let i = 0; i < ops.length; i += BULK_BATCH) {
    const chunk = ops.slice(i, i + BULK_BATCH);
    const res = await AtlasSpendDay.bulkWrite(chunk, { ordered: false });
    written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
  }
  return written;
}

function printMonthSummary(label, dayMicros) {
  const byMonth = new Map();
  let grand = 0;
  for (const [date, micro] of [...dayMicros.entries()].sort()) {
    const month = String(date).slice(0, 7); // YYYY-MM
    const slot = byMonth.get(month) || { micro: 0, days: 0 };
    slot.micro += micro;
    slot.days += 1;
    byMonth.set(month, slot);
    grand += micro;
  }

  console.log(`\n── ${label} per-month ──`);
  for (const [month, slot] of byMonth) {
    const usd = AtlasSpendDay.microsToUsd(slot.micro);
    console.log(
      `  ${month}:  $${usd.toFixed(2).padStart(10)}  (${slot.days} day${slot.days === 1 ? '' : 's'})`
    );
  }
  const grandUsd = AtlasSpendDay.microsToUsd(grand);
  return grandUsd;
}

function keyIdsFromEnv() {
  return String(process.env.ATLAS_BILLING_KEY_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── --spend ─────────────────────────────────────────────────────────────────

async function backfillSpend({ dryRun }) {
  if (!process.env.ATLAS_API_KEY) {
    throw new Error('ATLAS_API_KEY is required for --spend (secret lives in Render / local .env)');
  }

  const today = utcYmd();
  // end_date is EXCLUSIVE. Tomorrow includes today's partial bucket.
  const startDate = addUtcDays(today, -HISTORY_LOOKBACK_DAYS);
  const endDate = addUtcDays(today, 1);

  console.log(`\n══ --spend  (Atlas → AtlasSpendDay)${dryRun ? '  [DRY RUN]' : ''} ══`);
  console.log(`   window: ${startDate} .. ${endDate} (end exclusive, lookback=${HISTORY_LOOKBACK_DAYS}d)`);
  console.log('   additive only — CostLog is never written');

  const keyIds = keyIdsFromEnv();
  const results = {};

  // liquidretail pass — key allowlist. Same rule as syncSpendDays: empty
  // allowlist SKIPPED, never silently broadened to unfiltered account.
  if (!keyIds.length) {
    console.warn(
      '   ⚠️  ATLAS_BILLING_KEY_IDS is empty — skipping liquidretail pass. ' +
      'Set the allowlist (liquidretail keys only) before reconciling.'
    );
    results.liquidretail = { days: 0, rows: 0, written: 0, totalUsd: 0 };
  } else {
    console.log(`   liquidretail keys: ${keyIds.join(', ')}`);
    results.liquidretail = await pullAndUpsertScope({
      scope: 'liquidretail',
      apiKeyIds: keyIds,
      startDate,
      endDate,
      dryRun
    });
  }

  // account pass — no key filter. Balance/burn context only.
  results.account = await pullAndUpsertScope({
    scope: 'account',
    apiKeyIds: null,
    startDate,
    endDate,
    dryRun
  });

  console.log('\n── grand totals vs expected (measured 2026-08-05) ──');
  console.log(
    `  liquidretail:  $${results.liquidretail.totalUsd.toFixed(2).padStart(10)}` +
    `   expected ≈ $${EXPECTED_LIQUIDRETAIL_USD.toFixed(2)}` +
    (results.liquidretail.totalUsd < EXPECTED_LIQUIDRETAIL_USD - 1
      ? '  ⚠ below baseline — investigate'
      : '  ✓ at/above baseline')
  );
  console.log(
    `  account:       $${results.account.totalUsd.toFixed(2).padStart(10)}` +
    `   expected ≈ $${EXPECTED_ACCOUNT_USD.toFixed(2)}` +
    (results.account.totalUsd < EXPECTED_ACCOUNT_USD - 1
      ? '  ⚠ below baseline — investigate'
      : '  ✓ at/above baseline')
  );
  // The baselines were measured at a point in time on 2026-08-05 while that day
  // was still `partial:true` and accruing, so totals only ever GROW past them.
  // Only a total BELOW the baseline is suspicious (lost history / wrong key
  // filter); running higher is just elapsed spend. An exact-match check here
  // reported a false 'mismatch' on a +$1.73 drift 20 minutes after measurement.
  console.log(
    '  (baselines are a floor, not an equality — 2026-08-05 was still accruing when measured)'
  );
  console.log(
    `  written: liquidretail=${results.liquidretail.written}` +
    ` account=${results.account.written}` +
    (dryRun ? '  (dry-run: 0 writes)' : '')
  );

  return results;
}

async function pullAndUpsertScope({ scope, apiKeyIds, startDate, endDate, dryRun }) {
  const params = {
    startDate,
    endDate,
    groupBy: ['model'],
    // Wire scope is always 'account'; stored scope is liquidretail|account.
    // Filtering liquidretail is done via apiKeyIds, not scope=self (self only
    // covers the authenticating key — dies the day a second liquidretail key
    // is added).
    scope: 'account'
  };
  if (apiKeyIds && apiKeyIds.length) params.apiKeyIds = apiKeyIds;

  console.log(`\n   pulling scope=${scope} …`);
  const [costBuckets, usageBuckets] = await Promise.all([
    getModelCosts(params),
    getModelUsage(params)
  ]);

  const { ops, dayMicros, days, rows } = bucketsToOps(costBuckets, usageBuckets, scope);
  const totalUsd = printMonthSummary(scope, dayMicros);
  console.log(
    `  ${scope}: ${days} day(s), ${rows} row(s), total $${totalUsd.toFixed(2)}`
  );

  let written = 0;
  if (!dryRun && ops.length) {
    written = await flushOps(ops);
    console.log(`  ${scope}: upserted/modified ${written}`);
  } else if (dryRun) {
    console.log(`  ${scope}: dry-run — would upsert ${ops.length} row(s)`);
  }

  return { days, rows, written, totalUsd, dayMicros };
}

// ── --video-ids ─────────────────────────────────────────────────────────────

async function backfillVideoIds({ dryRun }) {
  console.log(`\n══ --video-ids  (Ad.veoPredictionId → CostLog.providerRequestId)${dryRun ? '  [DRY RUN]' : ''} ══`);
  console.log('   restores the handle only — costUsd / costSource untouched');

  // Rows that can never reconcile without a prediction id. Null / missing /
  // empty string all count as "no handle".
  const filter = {
    stage: 'atlas_video_render',
    adId: { $ne: null, $exists: true },
    $or: [
      { providerRequestId: null },
      { providerRequestId: { $exists: false } },
      { providerRequestId: '' }
    ]
  };

  const rows = await CostLog.find(filter)
    .select('_id adId providerRequestId')
    .lean();

  const scanned = rows.length;
  let recoverable = 0;
  let updated = 0;
  let noReceipt = 0;
  let missingAd = 0;
  let errors = 0;

  // Batch Ad lookups.
  const adIds = [...new Set(rows.map((r) => String(r.adId)).filter(Boolean))];
  const ads = adIds.length
    ? await Ad.find({ _id: { $in: adIds } }).select('_id veoPredictionId').lean()
    : [];
  const adById = new Map(ads.map((a) => [String(a._id), a]));

  for (const row of rows) {
    const ad = adById.get(String(row.adId));
    if (!ad) {
      missingAd++;
      noReceipt++; // no Ad → no receipt to recover
      continue;
    }
    const predId = ad.veoPredictionId && String(ad.veoPredictionId).trim();
    if (!predId) {
      noReceipt++;
      continue;
    }
    recoverable++;
    if (dryRun) {
      updated++; // count would-update
      continue;
    }
    try {
      // Re-filter providerRequestId so a concurrent write / re-run is a no-op.
      const res = await CostLog.updateOne(
        {
          _id: row._id,
          $or: [
            { providerRequestId: null },
            { providerRequestId: { $exists: false } },
            { providerRequestId: '' }
          ]
        },
        { $set: { providerRequestId: predId } }
      );
      if (res.modifiedCount > 0) updated++;
    } catch (err) {
      errors++;
      console.warn(`   ⚠️  CostLog ${row._id}: ${err.message}`);
    }
  }

  console.log(`\n── video-ids summary ──`);
  console.log(`  rows scanned:              ${scanned}`);
  console.log(`  recoverable (Ad has id):   ${recoverable}`);
  console.log(`  rows ${dryRun ? 'would update' : 'updated'}:         ${updated}`);
  console.log(`  no receipt (permanent):    ${noReceipt}`);
  if (missingAd) console.log(`    of which missing Ad:     ${missingAd}`);
  if (errors) console.log(`  errors:                    ${errors}`);
  if (noReceipt > 0) {
    console.log(
      '\n  NOTE: rows with no Ad.veoPredictionId are permanently unreconcilable —\n' +
      '  the spend receipt was never persisted at the charge point, and Atlas\n' +
      '  has no per-request cost lookup from CostLog fields alone. There is no\n' +
      '  further backfill for those; the normal reconcile path cannot invent an id.'
    );
  }
  console.log('  (idempotent: a second run must update 0 rows)');

  return { scanned, recoverable, updated, noReceipt, missingAd, errors };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { spend: false, videoIds: false, dryRun: false };
  for (const a of argv) {
    if (a === '--spend') out.spend = true;
    else if (a === '--video-ids') out.videoIds = true;
    else if (a === '--all') { out.spend = true; out.videoIds = true; }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown flag: ${a}`);
      out.help = true;
    }
  }
  return out;
}

function usage() {
  console.log(`
Usage:
  node scripts/backfillAtlasSpend.js --spend [--dry-run]
  node scripts/backfillAtlasSpend.js --video-ids [--dry-run]
  node scripts/backfillAtlasSpend.js --all [--dry-run]

  --spend       Atlas billing buckets → AtlasSpendDay (liquidretail + account)
  --video-ids   Ad.veoPredictionId → CostLog.providerRequestId (handle only)
  --all         both
  --dry-run     no writes
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.spend && !args.videoIds)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('🔌 connected to', mongoose.connection.host);
  if (args.dryRun) console.log('   DRY RUN — no writes will be issued');

  try {
    if (args.spend) await backfillSpend({ dryRun: args.dryRun });
    if (args.videoIds) await backfillVideoIds({ dryRun: args.dryRun });
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 disconnected');
  }
}

main().catch((err) => {
  console.error('❌ backfillAtlasSpend failed:', err);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
