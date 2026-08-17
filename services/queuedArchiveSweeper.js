'use strict';
//
// QUEUED-LEFTOVER ARCHIVE — park mint leftovers so they cannot be billed later.
//
// WHY (2026-08-12). expandWizardJob mints EVERY ad the request implies, then
// selectAdsForRun claims only MAX_CREATIVES_PER_RUN. The remainder sit
// status:'queued' forever. Measured in prod: 345 such rows, oldest 2026-06-01,
// all receipt-free / renderUrl-null / renderAttempts:0. A later Generate on
// the same product can claim one of those months-old rows and BILL it
// (selectAdsForRun is product-scoped, not new-ad-scoped). 345 rows ≈ $33 of
// latent unintended spend.
//
// "queued ads never auto-drain" (CLAUDE.md §2) is still true for RENDERING —
// this sweeper does not render, requeue, or submit. It moves inert leftovers
// to status:'archived' (reversible, already on the Ad enum) so they drop out
// of every claim filter (all of which key on status:'queued').
//
// ── WHY WORKER, NOT WEB ──────────────────────────────────────────────────
// This sweep never renders. No Remotion, no runRenderLoop, no Atlas submit.
// strandedRunSweeper lives on web because its requeue half NEEDS the render
// loop (routes/ads.js). This is the opposite job — prevent a claim — so it
// belongs next to the reaper / watchdog on the worker, which stays up across
// web deploys (the moment leftover inventory is most likely sitting unclaimed).
//
// ── WHAT THIS MUST NEVER TOUCH ───────────────────────────────────────────
//   · an ad holding a spend receipt (veoPredictionId / imageGeneration.predictionId)
//   · an ad with a renderUrl (something was delivered)
//   · an ad with renderAttempts > 0 (work began; strandedRunSweeper owns those)
//   · an ad whose minting run is still preparing/running
// The filter is a pure function so the harness can evaluate it against
// synthetic docs (same pattern as titlingResumeService.buildResumeFilter).

const Ad          = require('../models/Ad');
const CampaignRun = require('../models/CampaignRun');
// THE spend-receipt helper. Do not re-implement — a call site that used this
// without importing it shipped a broken money guard to production (CLAUDE.md §4).
const { receiptFree } = require('./spendReceipt');
const alerts      = require('./alertService');

const truthy = (v, dflt) => {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
};

// Blank env is 0, not NaN (Number('') === 0) — same trap as PMAX_PROOF_*.
// A 0-hour threshold would archive a run's leftovers the moment it finished
// and kill same-day "Generate more" (POST /runs). Invalid / blank / <1 → default.
function afterHours() {
  const raw = process.env.QUEUED_ARCHIVE_AFTER_H;
  const n = Number(raw);
  if (raw == null || String(raw).trim() === '' || !Number.isFinite(n) || n < 1) return 24;
  return n;
}

function maxAds() {
  const raw = process.env.QUEUED_ARCHIVE_MAX_ADS;
  const n = Number(raw);
  if (raw == null || String(raw).trim() === '' || !Number.isFinite(n) || n < 1) return 200;
  return Math.floor(n);
}

const ENABLED = () => truthy(process.env.QUEUED_ARCHIVE_ENABLED, true);

const TERMINAL_RUN_STATUSES = Object.freeze(['done', 'failed']);

/**
 * The sweep predicate, as a PURE function of terminal run ids + age cutoff.
 *
 * Extracted so a harness can evaluate the REAL filter against REAL document
 * shapes instead of regexing this file. A source-text assertion cannot tell a
 * working query from one that merely still contains the right words, and this
 * query is the only thing standing between a leftover queued row and a later
 * Generate billing it.
 *
 * @param {{ terminalRunIds: string[], olderThan: Date }} args
 */
function buildQueuedArchiveFilter({ terminalRunIds, olderThan } = {}) {
  const ids = (Array.isArray(terminalRunIds) ? terminalRunIds : [])
    .filter((id) => id != null && id !== '')
    .map(String);
  return receiptFree({
    status: 'queued',
    // Ownership: the ad's EVERY campaignRunIds entry must be an old
    // terminal run. `$in` alone is "any" — not enough. After we stamp the
    // minting run at insert, a later POST /runs (or a later Generate) that
    // claims the leftover $addToSet's its own runId. If that later run is
    // still preparing/running — or failed minutes ago and strandedSweep
    // is about to requeue it — `$in: [oldMintingRun]` would still match
    // and this pass would archive work another run owns. `$not $elemMatch
    // $nin` is "no element outside the terminal set".
    campaignRunIds: {
      $in: ids,
      $not: { $elemMatch: { $nin: ids } }
    },
    queuedAt: { $lt: olderThan },
    $and: [
      // renderUrl default is null; '' is defensive. A delivered asset is
      // never "inert leftover".
      { $or: [{ renderUrl: null }, { renderUrl: '' }] },
      // renderAttempts default is 0. Anything above 0 means work began —
      // strandedRunSweeper / the operator own those rows, not this pass.
      { $or: [{ renderAttempts: 0 }, { renderAttempts: null }] }
    ]
  });
}

/**
 * Re-apply the money predicates on the write so a concurrent claim or a
 * receipt stamp between find and updateMany cannot be overwritten.
 */
function buildQueuedArchiveWriteFilter(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  return receiptFree({
    _id: { $in: list },
    status: 'queued',
    $and: [
      { $or: [{ renderUrl: null }, { renderUrl: '' }] },
      { $or: [{ renderAttempts: 0 }, { renderAttempts: null }] }
    ]
  });
}

function buildTerminalRunFilter(olderThan) {
  return {
    status: { $in: TERMINAL_RUN_STATUSES },
    // completedAt is stamped on every honest terminal write. The startedAt
    // arm is only for a done/failed row that lost its completedAt — we still
    // refuse to consider a run younger than the threshold.
    $or: [
      { completedAt: { $lt: olderThan } },
      { completedAt: null, startedAt: { $lt: olderThan } }
    ]
  };
}

/**
 * Historical leftovers minted BEFORE campaignRunIds was stamped at insert.
 * The 345 prod rows were this shape. New mints carry a run id; this arm
 * exists so a leftover that slipped through (or predates the stamp) is
 * not a permanent claimable bill. Safe only when the campaign has no
 * in-flight run — a live prepare/render might still claim these.
 */
function buildEmptyRunIdArchiveFilter({ olderThan } = {}) {
  return receiptFree({
    status: 'queued',
    $or: [
      { campaignRunIds: { $exists: false } },
      { campaignRunIds: { $size: 0 } },
      { campaignRunIds: null }
    ],
    queuedAt: { $lt: olderThan },
    $and: [
      { $or: [{ renderUrl: null }, { renderUrl: '' }] },
      { $or: [{ renderAttempts: 0 }, { renderAttempts: null }] }
    ]
  });
}

/**
 * One bounded pass. Never throws — the caller is worker.js's interval.
 * Idempotent: archived ads no longer match status:'queued'.
 */
async function sweepQueuedLeftovers() {
  const out = { considered: 0, archived: 0, skipped: false };
  if (!ENABLED()) { out.skipped = 'QUEUED_ARCHIVE_ENABLED=false'; return out; }

  const olderThan = new Date(Date.now() - afterHours() * 3600 * 1000);
  let runs;
  try {
    // No per-pass run cap. A limit(500) with no sort can return the SAME
    // 500 terminal rows forever and starve leftovers whose minting run
    // sits outside that set — those rows would stay claimable. Run ids
    // are small; the ad query is what we bound (maxAds).
    runs = await CampaignRun.find(buildTerminalRunFilter(olderThan))
      .select('runId')
      .lean();
  } catch (err) {
    console.warn(`⚠️  queuedArchive: terminal-run query failed — ${err.message}`);
    return out;
  }
  const terminalRunIds = (runs || []).map((r) => r.runId).filter(Boolean);

  let ads = [];
  if (terminalRunIds.length) {
    try {
      ads = await Ad.find(buildQueuedArchiveFilter({ terminalRunIds, olderThan }))
        .sort({ queuedAt: 1 })
        // brandId/campaignRunIds are for the operator notice only — they never
        // affect what is archived. The write filter re-derives its own guards.
        .select('_id brandId campaignRunIds')
        .limit(maxAds())
        .lean();
    } catch (err) {
      console.warn(`⚠️  queuedArchive: leftover query failed — ${err.message}`);
      return out;
    }
  }

  // Historical / unstamped leftovers. Campaigns with a preparing/running
  // run are skipped so we cannot park inventory a live claim is about
  // to take.
  let orphans = [];
  try {
    const found = await Ad.find(buildEmptyRunIdArchiveFilter({ olderThan }))
      .sort({ queuedAt: 1 })
      .select('_id campaignId')
      .limit(maxAds())
      .lean();
    if (found.length) {
      const campIds = [...new Set(found.map((a) => a.campaignId).filter(Boolean))];
      const busy = campIds.length
        ? await CampaignRun.find({
            campaignId: { $in: campIds },
            status: { $in: ['preparing', 'running'] }
          }).select('campaignId').lean()
        : [];
      const busySet = new Set(busy.map((r) => String(r.campaignId)));
      orphans = found.filter((a) => !busySet.has(String(a.campaignId)));
    }
  } catch (err) {
    console.warn(`⚠️  queuedArchive: empty-runId leftover query failed — ${err.message}`);
  }

  const byId = new Map();
  for (const a of ads) byId.set(String(a._id), a);
  for (const a of orphans) byId.set(String(a._id), a);
  const unique = [...byId.values()];
  out.considered = unique.length;
  if (!unique.length) return out;

  try {
    const res = await Ad.updateMany(
      buildQueuedArchiveWriteFilter(unique.map((a) => a._id)),
      { $set: { status: 'archived', updatedAt: new Date() } }
    );
    out.archived = Number(res && res.modifiedCount) || 0;
  } catch (err) {
    console.warn(`⚠️  queuedArchive: archive write failed — ${err.message}`);
    return out;
  }

  if (out.archived) {
    console.log(
      `🗃️  queuedArchive: archived ${out.archived} leftover queued ad(s) ` +
      `(inert, receipt-free, run terminal or unstamped, older than ${afterHours()}h)`
    );

    // OPERATOR NOTICE. Until now this pass was entirely silent: ads left the
    // operator's queue and nobody was told. That is defensible only while the
    // rows are worthless, and "worthless" is precisely what the guards above
    // enforce — so the notice must SAY that rather than imply an interruption.
    //
    // WORD IT TRUTHFULLY. It is tempting to phrase this as "generation was
    // interrupted / in-progress ads were removed". That would be FALSE for
    // everything this pass can touch: receiptFree() excludes any ad carrying a
    // spend receipt, and the filters additionally require renderUrl empty and
    // renderAttempts 0. An ad that started or was billed is unreachable from
    // here by construction. Claiming otherwise would send the operator hunting
    // for lost paid work that does not exist — a false alarm is a worse defect
    // than silence, because it burns the channel's credibility.
    //
    // NEVER let Slack break the sweep. notifyAsync is fire-and-forget (same
    // reason adVisionQcService uses it on the paid path), and the whole block
    // is wrapped: the archive has already been committed by this point, so a
    // transport failure must not surface as a sweep failure or a retry.
    try {
      const byBrand = new Map();
      const runIds  = new Set();
      for (const a of unique) {
        const b = String(a.brandId || 'unknown');
        byBrand.set(b, (byBrand.get(b) || 0) + 1);
        for (const r of (a.campaignRunIds || [])) runIds.add(String(r));
      }
      // considered vs archived can differ: the write re-applies the money
      // guards, so an ad that gained a receipt between read and write is
      // correctly left alone. Report both rather than implying they match.
      const partial = out.considered > out.archived
        ? ` ${out.considered - out.archived} candidate(s) were left alone because the write-time money guard still matched them.`
        : '';
      alerts.notifyAsync({
        level: 'warn',
        title: `Queued leftovers archived — ${out.archived} ad(s)`,
        detail:
          `${out.archived} queued ad(s) were archived. They NEVER STARTED and were NEVER BILLED — ` +
          `no spend receipt, no renderUrl, zero render attempts. These are mint-vs-claim ` +
          `leftovers: the run minted more ads than it claimed, and the remainder sat in ` +
          `'queued' after their run reached a terminal state (or carried no run at all). ` +
          `Nothing in progress or paid for was touched.${partial}`,
        fields: {
          archived:   String(out.archived),
          considered: String(out.considered),
          brands:     [...byBrand.entries()].map(([b, n]) => `${b} (${n})`).join(', ') || '—',
          owningRuns: [...runIds].slice(0, 10).join(', ') || 'none (unstamped leftovers)',
          olderThanH: String(afterHours())
        },
        key: 'queued-archive-sweep'
      });
    } catch (err) {
      console.warn(`⚠️  queuedArchive: operator notice failed (archive already committed) — ${err.message}`);
    }
  }
  return out;
}

module.exports = {
  sweepQueuedLeftovers,
  buildQueuedArchiveFilter,
  buildQueuedArchiveWriteFilter,
  buildEmptyRunIdArchiveFilter,
  buildTerminalRunFilter,
  ENABLED,
  afterHours,
  maxAds,
  TERMINAL_RUN_STATUSES
};
