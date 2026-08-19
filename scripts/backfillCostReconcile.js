#!/usr/bin/env node
'use strict';
/**
 * scripts/backfillCostReconcile.js — reconcile HISTORICAL CostLog rows to
 * Atlas's settled provider truth (money-critical audit, 2026-08-19).
 *
 * WHY THIS EXISTS
 * costTracker.reconcileCost() and its schedulers (scheduleCostReconcile /
 * scheduleVideoCostReconcile) already upgrade a row from 'estimated' to
 * 'actual' going forward — but only for a bounded number of re-polls after
 * the ORIGINAL submit (scheduleVideoCostReconcile gives up after ~13.5
 * minutes of backoff; see its own delays[] array). A row whose prediction
 * only settles later than that — or whose process died before the scheduler
 * even got to run — is stuck at the submit-time ESTIMATE forever. That is
 * the exact shape of the incident this audit was opened for: two Omni video
 * masters (run_1787119100250_eef4d871) that Atlas confirms were NEVER
 * BILLED (status:'failed', price:null) but whose CostLog rows still carried
 * costUsd:1.20, costSource:'estimated' — $2.40 of pure phantom spend.
 *
 * WHAT THIS DOES
 * Walks every CostLog row that is still costSource:'estimated' AND carries a
 * providerRequestId (the only rows a per-request settle even EXISTS for —
 * image + video Atlas predictions; LLM/chat rows have no such id and no such
 * endpoint, see the audit report). For each, re-reads Atlas's OWN settled
 * record (GET /model/prediction/:id — free, not billable) and classifies:
 *
 *   - terminal success + a positive settled price -> 'actual', costUsd = price
 *   - terminal failure AND Atlas confirms NO price  -> 'none',   costUsd = 0
 *     (the $2.40 bug class)
 *   - terminal failure but Atlas DID settle a real price (a "failed" verdict
 *     that still billed — rare, but the settled record is the only truth,
 *     never assumed)                                 -> 'actual', costUsd = price
 *   - still processing, prediction gone (404), or a network/parse error
 *     -> LEFT ALONE. Absence of evidence is not evidence of non-charge.
 *
 * Uses services/atlasVideoService.confirmedCharge() for the classification —
 * the SAME tri-state rule the live video-failure and image-failure paths
 * already use (imported, not re-implemented) — and
 * services/costTracker.reconcileCost() for the write, which is GATED to only
 * ever touch a row that is STILL costSource:'estimated'. That is what makes
 * this script:
 *   - IDEMPOTENT — running it twice (or after the live schedulers already
 *     caught a row) is a safe no-op on every row already corrected.
 *   - NEVER DOUBLE-COUNTING — it is an UPDATE keyed on providerRequestId,
 *     never an insert; a row it cannot match is left exactly as it was.
 *   - NEVER GUESSING — a row it cannot get a confirmed verdict for is left
 *     exactly as it was, in every one of the three "leave alone" cases above.
 *
 * DRY-RUN BY DEFAULT. Nothing is written unless you pass --apply.
 *
 * USAGE
 *   node scripts/backfillCostReconcile.js                      # dry run, all history
 *   node scripts/backfillCostReconcile.js --apply               # apply the corrections
 *   node scripts/backfillCostReconcile.js --since=2026-08-01     # bound by createdAt
 *   node scripts/backfillCostReconcile.js --limit=10             # cap rows examined
 *   node scripts/backfillCostReconcile.js --delay-ms=300          # pace Atlas GETs
 *
 * Requires MONGODB_URI and ATLAS_API_KEY in the environment.
 */

const mongoose = require('mongoose');
const axios = require('axios');
const CostLog = require('../models/CostLog');
const { confirmedCharge, SETTLED_POLL_STATUSES, TERMINAL_OK_STATUSES } = require('../services/atlasVideoService');
const { reconcileCost } = require('../services/costTracker');

// Atlas WAFs default python-urllib/curl/axios user agents with a 403 — see
// CLAUDE.md's Atlas gotchas. GET reads only; nothing here is billable.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_URL = 'https://api.atlascloud.ai/api/v1';

function apiKey() {
  const k = process.env.ATLAS_API_KEY;
  if (!k) throw new Error('ATLAS_API_KEY is not set in the environment');
  return k;
}

function parseArgs(argv) {
  const out = { apply: false, limit: null, since: null, delayMs: 250 };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10);
    else if (a.startsWith('--since=')) out.since = new Date(a.slice('--since='.length));
    else if (a.startsWith('--delay-ms=')) out.delayMs = parseInt(a.slice('--delay-ms='.length), 10);
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchPrediction(id) {
  const res = await axios.get(`${BASE_URL}/model/prediction/${id}`, {
    headers: { Authorization: `Bearer ${apiKey()}`, 'User-Agent': UA },
    timeout: 20000,
    validateStatus: () => true
  });
  return { httpStatus: res.status, data: res.data && res.data.data ? res.data.data : null };
}

/**
 * Pure classification for one row given Atlas's prediction payload. Exported
 * so a future harness can pin it offline (no DB/network) the same way this
 * repo pins every other money decision.
 *
 * DELIBERATELY ASYMMETRIC between success and failure — this mirrors
 * peekPrediction's own branching (services/atlasVideoService.js) exactly,
 * and getting it WRONG was a real bug caught by testing this script against
 * live data before writing anything (verified on prediction
 * b752315fb72e4658a8951aeffb358691: status:'completed', a real delivered
 * output URL, price ABSENT). confirmedCharge()'s "absent price -> charged
 * false" rule is empirically justified ONLY for a FAILURE verdict
 * (CLAUDE.md §2, measured 2026-08-10: 5/5 failed predictions carry no price
 * field at all because Atlas refunds them). Atlas's own docs/this repo's
 * measurements say a SUCCESSFUL generation does not always have `price`
 * published on the completion payload either (images: 7/38 at completion) —
 * so on a `completed`/`succeeded` verdict, an absent price means "not yet
 * published", not "confirmed free". Zeroing a delivered, billed generation
 * because we asked before Atlas indexed the price would hide REAL spend,
 * which is the mirror-image of the bug this script exists to fix — so the
 * success branch below NEVER calls confirmedCharge() and never reconciles to
 * 'none'; peekPrediction's own "done" branch (production's own reconcile
 * path) makes exactly the same choice, passing `price` through unclassified.
 *
 * @returns {{action:'reconcile', costUsd:number, costSource:'actual'|'none'} |
 *           {action:'leave', reason:string}}
 */
function classifyRow({ httpStatus, data }) {
  if (httpStatus === 404 || !data) return { action: 'leave', reason: 'prediction not found' };
  const status = String(data.status || '').toLowerCase();
  if (!SETTLED_POLL_STATUSES.has(status)) return { action: 'leave', reason: `still ${status || 'unknown'}` };

  if (TERMINAL_OK_STATUSES.has(status)) {
    const raw = data.price;
    const n = Number(raw);
    if (raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n >= 0) {
      return { action: 'reconcile', costUsd: n, costSource: 'actual' };
    }
    // Delivered successfully but Atlas has not (yet, or ever, for an old
    // prediction) published a settled price on this payload. NOT a zero —
    // leave the pre-settlement estimate standing rather than under-report.
    return { action: 'leave', reason: 'completed but price not yet published' };
  }

  // TERMINAL_FAILURE_STATUSES from here down — confirmedCharge()'s tri-state
  // rule is the one this repo already measured and ships on the live
  // failure-recovery path (bootRecoveryService / generateForAd's final-
  // failure branch); reused here rather than re-derived.
  const { charged, priceUsd } = confirmedCharge(data);
  if (charged === true && priceUsd != null && Number.isFinite(Number(priceUsd)) && Number(priceUsd) > 0) {
    return { action: 'reconcile', costUsd: Number(priceUsd), costSource: 'actual' };
  }
  if (charged === false) {
    return { action: 'reconcile', costUsd: 0, costSource: 'none' };
  }
  // charged === null — Atlas's settled record did not carry a readable price.
  // Never guess; leave the estimate exactly as it is.
  return { action: 'leave', reason: 'failed but charge state unreadable' };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in the environment');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const query = { costSource: 'estimated', providerRequestId: { $ne: null } };
  if (opts.since && !Number.isNaN(opts.since.getTime())) query.createdAt = { $gte: opts.since };

  console.log(`\nbackfillCostReconcile — ${opts.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`query: ${JSON.stringify(query)}${opts.limit ? ` (limit ${opts.limit})` : ''}\n`);

  const cursor = CostLog.find(query)
    .select('_id stage model provider costUsd providerRequestId createdAt campaignId campaignRunId')
    .sort({ createdAt: 1 })
    .lean()
    .cursor();

  let examined = 0;
  let touched = 0;
  const leaveReasons = {};
  let claimedTotalAll = 0;      // sum of costUsd across every row examined, unchanged
  let correctedTotalAll = 0;    // sum of costUsd across every row examined, AFTER this pass
  let claimedTotalTouched = 0;
  let correctedTotalTouched = 0;
  const diffs = [];

  for await (const row of cursor) {
    if (opts.limit && examined >= opts.limit) break;
    examined++;
    const before = Number(row.costUsd) || 0;
    claimedTotalAll += before;

    let pred;
    try {
      pred = await fetchPrediction(row.providerRequestId);
    } catch (err) {
      leaveReasons['fetch error'] = (leaveReasons['fetch error'] || 0) + 1;
      correctedTotalAll += before;
      console.warn(`  ⚠️  ${row.providerRequestId} [${row.stage}]: fetch failed (${err.message}) — leaving 'estimated'`);
      await sleep(opts.delayMs);
      continue;
    }

    const verdict = classifyRow(pred);
    if (verdict.action === 'leave') {
      leaveReasons[verdict.reason] = (leaveReasons[verdict.reason] || 0) + 1;
      correctedTotalAll += before;
      await sleep(opts.delayMs);
      continue;
    }

    touched++;
    claimedTotalTouched += before;
    correctedTotalTouched += verdict.costUsd;
    correctedTotalAll += verdict.costUsd;
    diffs.push({
      predictionId: row.providerRequestId,
      stage: row.stage,
      model: row.model,
      campaignId: row.campaignId ? String(row.campaignId) : null,
      before: { costUsd: before, costSource: 'estimated' },
      after: { costUsd: verdict.costUsd, costSource: verdict.costSource }
    });

    const line = `  ${opts.apply ? '' : '[DRY] '}${row.providerRequestId} [${row.stage}/${row.model}] ` +
      `$${before.toFixed(4)} (estimated) -> $${verdict.costUsd.toFixed(4)} (${verdict.costSource})`;

    if (opts.apply) {
      const ok = await reconcileCost({
        providerRequestId: row.providerRequestId,
        costUsd: verdict.costUsd,
        costSource: verdict.costSource
      });
      console.log(`${ok ? '  ✅' : '  ⏭️ (already reconciled by another process)'} ${line.trim()}`);
    } else {
      console.log(line);
    }

    await sleep(opts.delayMs);
  }

  console.log('\n' + '='.repeat(78));
  console.log('SUMMARY');
  console.log('='.repeat(78));
  console.log(`rows examined:                 ${examined}`);
  console.log(`rows corrected (touched):      ${touched}`);
  for (const [reason, n] of Object.entries(leaveReasons)) {
    console.log(`  left alone — ${reason}: ${n}`);
  }
  console.log('');
  console.log(`touched rows — claimed total:    $${claimedTotalTouched.toFixed(4)}`);
  console.log(`touched rows — corrected total:  $${correctedTotalTouched.toFixed(4)}`);
  console.log(`touched rows — delta:            $${(correctedTotalTouched - claimedTotalTouched).toFixed(4)}`);
  console.log('');
  console.log(`ALL examined rows — claimed total (before):   $${claimedTotalAll.toFixed(4)}`);
  console.log(`ALL examined rows — corrected total (after):  $${correctedTotalAll.toFixed(4)}`);
  console.log(`ALL examined rows — TOTAL DELTA:               $${(correctedTotalAll - claimedTotalAll).toFixed(4)}`);
  console.log('');
  console.log(opts.apply
    ? '✅ APPLIED — the corrections above are now live in CostLog.'
    : '(DRY RUN — nothing was written. Re-run with --apply to write these corrections.)');

  await mongoose.disconnect();
  return { examined, touched, claimedTotalAll, correctedTotalAll, diffs };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('backfillCostReconcile failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { classifyRow, main };
