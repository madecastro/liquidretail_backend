#!/usr/bin/env node
'use strict';
/**
 * scripts/reconcileAtlasDailyCosts.js — independent DAILY cross-check of our
 * CostLog ledger against Atlas's own authoritative Billing Public API
 * (2026-08-19 audit).
 *
 * WHY THIS EXISTS
 * Per-request reconciliation (backfillCostReconcile.js, and the live
 * scheduleCostReconcile / scheduleVideoCostReconcile paths) only covers rows
 * that carry a providerRequestId — image and video Atlas predictions. LLM
 * chat-completion rows have NO per-request price field anywhere in Atlas's
 * API (confirmed by reading atlasLlmService.js's response handling and
 * docs/ATLAS.md — see this audit's report) and can therefore never settle
 * row-by-row. Atlas DOES publish an authoritative DAILY total though, via
 * `GET /public/v1/model-costs` (base path `/public/v1`, NOT `/v1` or
 * `/api/v1` — a different surface from the per-prediction endpoints used
 * elsewhere in this codebase). This script is the aggregate-level
 * reconciliation the per-request one cannot provide: it does not correct any
 * CostLog row, it tells you HOW WRONG the whole ledger is for a given day so
 * that drift is visible instead of silent.
 *
 * WHAT IT DOES (READ-ONLY — no CostLog writes, nothing billable)
 *   1. GET /public/v1/balance — current account balance, printed so a low
 *      balance is visible before it becomes a mid-run surprise.
 *   2. GET /public/v1/model-costs?start_date&end_date&group_by[]=model — for
 *      each day in range, Atlas's own settled total (and per-model
 *      breakdown). `end_date` is EXCLUSIVE per Atlas's contract; a day still
 *      being billed comes back `partial:true` with a `covered_until`
 *      timestamp — printed but visibly flagged, never silently averaged in
 *      as if it were a complete day.
 *   3. Sums CostLog.costUsd for the same UTC day, `provider:'atlas'` rows
 *      only (Atlas's bill cannot include a direct-Gemini/direct-OpenAI
 *      fallback call — those never touch Atlas's meter), both as one figure
 *      and broken out by `model`, so the model-level compare in step 4 is
 *      apples-to-apples.
 *   4. Prints day-by-day: Atlas total | our total | delta | % — and a
 *      per-model breakdown for the worst-delta day so a drift is traceable
 *      to WHICH producer, not just "the ledger is off".
 *
 * USAGE
 *   node scripts/reconcileAtlasDailyCosts.js                     # last 3 UTC days
 *   node scripts/reconcileAtlasDailyCosts.js --days=7
 *   node scripts/reconcileAtlasDailyCosts.js --start=2026-08-10 --end=2026-08-19
 *
 * Requires MONGODB_URI and ATLAS_API_KEY in the environment.
 */

const mongoose = require('mongoose');
const axios = require('axios');
const CostLog = require('../models/CostLog');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_URL = 'https://api.atlascloud.ai/public/v1';
const LOW_BALANCE_USD = Number(process.env.ATLAS_LOW_BALANCE_ALERT_USD || 10);

function apiKey() {
  const k = process.env.ATLAS_API_KEY;
  if (!k) throw new Error('ATLAS_API_KEY is not set in the environment');
  return k;
}

function authed(path) {
  return axios.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey()}`, 'User-Agent': UA },
    timeout: 20000
  });
}

function ymd(d) { return d.toISOString().slice(0, 10); }

function parseArgs(argv) {
  const out = { days: 3, start: null, end: null };
  for (const a of argv) {
    if (a.startsWith('--days=')) out.days = parseInt(a.slice('--days='.length), 10);
    else if (a.startsWith('--start=')) out.start = a.slice('--start='.length);
    else if (a.startsWith('--end=')) out.end = a.slice('--end='.length);
  }
  if (!out.start || !out.end) {
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1); // end_date is EXCLUSIVE — cover today too
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - out.days);
    out.start = ymd(start);
    out.end = ymd(end);
  }
  return out;
}

async function fetchBalance() {
  const res = await authed('/balance');
  return res.data;
}

async function fetchModelCosts(start, end) {
  const res = await authed(`/model-costs?start_date=${start}&end_date=${end}&group_by[]=model`);
  return res.data.data || [];
}

/** Sum CostLog.costUsd per UTC day + model, provider:'atlas' only. */
async function sumOurLedger(start, end) {
  const rows = await CostLog.aggregate([
    {
      $match: {
        provider: 'atlas',
        createdAt: { $gte: new Date(`${start}T00:00:00.000Z`), $lt: new Date(`${end}T00:00:00.000Z`) }
      }
    },
    {
      $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, model: '$model' },
        usd: { $sum: '$costUsd' },
        n: { $sum: 1 }
      }
    }
  ]);
  const byDay = new Map();
  for (const r of rows) {
    const day = r._id.day;
    const entry = byDay.get(day) || { total: 0, byModel: new Map() };
    entry.total += r.usd || 0;
    entry.byModel.set(r._id.model || 'unknown', { usd: r.usd || 0, n: r.n });
    byDay.set(day, entry);
  }
  return byDay;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in the environment');

  console.log(`\nreconcileAtlasDailyCosts — ${opts.start} .. ${opts.end} (end exclusive)\n`);

  const [balance, atlasBuckets] = await Promise.all([fetchBalance(), fetchModelCosts(opts.start, opts.end)]);

  const avail = Number(balance?.available?.value ?? NaN);
  console.log('ATLAS ACCOUNT BALANCE');
  console.log('='.repeat(78));
  console.log(`  available: $${Number.isFinite(avail) ? avail.toFixed(2) : '?'} ${balance?.available?.currency || ''}`);
  if (Number.isFinite(avail) && avail < LOW_BALANCE_USD) {
    console.log(`  ⚠️  LOW BALANCE — below the $${LOW_BALANCE_USD} alert threshold (ATLAS_LOW_BALANCE_ALERT_USD)`);
  }
  console.log('');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const ourByDay = await sumOurLedger(opts.start, opts.end);

  console.log('DAILY RECONCILIATION — Atlas settled total vs. our CostLog total (provider:\'atlas\' only)');
  console.log('='.repeat(78));
  console.log(
    'date'.padEnd(12) + 'atlas $'.padStart(10) + '  ours $'.padStart(10) + '  delta $'.padStart(10) +
    '  delta %'.padStart(10) + '  status'
  );

  let worstDay = null;
  let worstAbsDelta = -1;
  const summary = [];

  for (const bucket of atlasBuckets) {
    const day = bucket.date;
    const atlasTotal = (bucket.results || []).reduce((s, r) => s + (Number(r.amount?.value) || 0), 0);
    const ours = ourByDay.get(day) || { total: 0, byModel: new Map() };
    const delta = ours.total - atlasTotal;
    const pct = atlasTotal > 0 ? (delta / atlasTotal) * 100 : (ours.total > 0 ? Infinity : 0);
    const status = bucket.partial ? `PARTIAL (covered until ${bucket.covered_until})` : 'complete';

    console.log(
      day.padEnd(12) +
      `$${atlasTotal.toFixed(4)}`.padStart(10) +
      `$${ours.total.toFixed(4)}`.padStart(11) +
      `$${delta.toFixed(4)}`.padStart(11) +
      `${Number.isFinite(pct) ? pct.toFixed(1) : '∞'}%`.padStart(11) +
      `  ${status}`
    );

    summary.push({ day, atlasTotal, ours: ours.total, delta, partial: !!bucket.partial });
    if (!bucket.partial && Math.abs(delta) > worstAbsDelta) {
      worstAbsDelta = Math.abs(delta);
      worstDay = { day, bucket, ours };
    }
  }

  console.log('');
  const completeDays = summary.filter((s) => !s.partial);
  const totalAtlas = completeDays.reduce((s, d) => s + d.atlasTotal, 0);
  const totalOurs = completeDays.reduce((s, d) => s + d.ours, 0);
  console.log(`COMPLETE-DAY TOTALS (partial days excluded — Atlas has not finished billing them):`);
  console.log(`  Atlas: $${totalAtlas.toFixed(4)}   Ours: $${totalOurs.toFixed(4)}   Delta: $${(totalOurs - totalAtlas).toFixed(4)}` +
    (totalAtlas > 0 ? ` (${(((totalOurs - totalAtlas) / totalAtlas) * 100).toFixed(1)}%)` : ''));

  if (worstDay) {
    console.log(`\nWORST COMPLETE-DAY DELTA: ${worstDay.day} — per-model breakdown`);
    console.log('-'.repeat(78));
    const atlasByModel = new Map();
    for (const r of worstDay.bucket.results || []) {
      atlasByModel.set(r.model?.name || 'unknown', Number(r.amount?.value) || 0);
    }
    const allModels = new Set([...atlasByModel.keys(), ...worstDayModels(worstDay.ours)]);
    for (const model of allModels) {
      const a = atlasByModel.get(model) || 0;
      const o = worstDay.ours.byModel.get(model)?.usd || 0;
      console.log(`  ${model.padEnd(50)} atlas=$${a.toFixed(4).padStart(9)}  ours=$${o.toFixed(4).padStart(9)}  Δ=$${(o - a).toFixed(4)}`);
    }
  }

  console.log('\n(This script writes nothing — it is a read-only cross-check. Fix drift via');
  console.log(' MODEL_RATES corrections or scripts/backfillCostReconcile.js, not by editing');
  console.log(' this script\'s output.)');

  await mongoose.disconnect();
}

function worstDayModels(ours) {
  return [...(ours.byModel ? ours.byModel.keys() : [])];
}

if (require.main === module) {
  main().catch((err) => {
    console.error('reconcileAtlasDailyCosts failed:', err.response?.data || err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { fetchBalance, fetchModelCosts, sumOurLedger };
