'use strict';
//
// BOOT RECOVERY — collect generations we already paid for.
//
// WHY (2026-08-04): providers charge at SUBMIT. When a process dies mid-render,
// the ad is left in `rendering` holding a spend receipt (Ad.veoPredictionId) for
// work Atlas may have gone on to finish. Nothing ever looked at that receipt, so
// the asset was abandoned and the next run re-bought it. Measured: a 411s Omni
// master completed at 17:27:09 and the shutdown requeue swept its run one second
// later.
//
// services/spendReceipt.js stopped the re-buy (a requeue can no longer touch a
// receipt-holding ad). This module is the other half: it goes and FETCHES the
// asset. Nothing here can submit — for the image receipts this module still
// recovers, it calls imageRecoveryService.recoverImageAd, a free GET with no
// submit path (see that module's own header for the money contract). Video
// receipt recovery used to live here too (atlasVideoService.resumeForAd) —
// see the ADGEN OWNS ALL VIDEO RENDERING section below for why it doesn't
// any more.
//
// ── NO CLAIM, ON PURPOSE ────────────────────────────────────────────────────
// Autoscaling means several instances boot at once and will all run this. There
// is deliberately NO claim/lease, for two reasons:
//
//   1. The only provider call is a free GET. Two instances peeking the same
//      prediction wastes one HTTP request and nothing else.
//   2. Every write is guarded by `status: 'rendering'` in its own filter, so the
//      first writer transitions the ad and every later writer is a no-op. That
//      is cheaper and far less fragile than a lease, and it needs no new schema
//      field — which matters, because mongoose strict mode SILENTLY DROPS writes
//      to undeclared paths (this repo has already lost `renderError.predictionId`
//      that way; see models/Ad.js).
//
// ── ADGEN OWNS ALL VIDEO RENDERING — UNCONDITIONALLY ────────────────────────
// This used to be a runtime flag check (ADGEN_RENDERER_ENABLED /
// isAdgenRendererEnabled, services/adgenBridge.js — both deleted; owner
// directive, "we are not going back to that infrastructure") with an
// in-process video-recovery fallback below it for when the flag was off.
// That fallback is gone. Video-receipt rows are excluded from this sweep's
// query unconditionally now (receiptKinds:'image' — see resumeInFlightAds)
// — adgen always owns collecting and titling a stranded video master.
//
// adgen carries its OWN vendored copy of this file, wired from its renderer
// (`startBootRecoverySweep`), which is what actually recovers a stranded
// video receipt today. Its vendored copy is a SEPARATE, unaudited codebase
// this file cannot reach or verify — standing down here does not prove the
// dual-render race is closed against every actor, only that this process no
// longer peeks or writes a video-receipt row at all.
//
// SCOPED TO VIDEO RECOVERY ONLY — this is the constraint that matters most.
// Static-image recovery (recoverImageAd, below) stays unconditional, and so
// does its cost-reconcile call, because it was never exposed to the race
// video is: a recovered image is ONE atomic peek-then-write with no
// asynchronous hand-off to a second process, so two peekers racing it is
// exactly the harmless case the "NO CLAIM, ON PURPOSE" reasoning above
// already covers. Video is different SPECIFICALLY because a recovered
// master used to hand off to a SEPARATE titling pass — that hand-off is the
// thing a live adgen claim must not have stolen out from under it, back
// when this process still collected video masters at all.
//
// ── Ad.claimedByWorker IS A DIFFERENT THING — SECONDARY, defense in depth ──
// The "no claim" reasoning at the top of this file is about concurrent
// bootRecoveryService peekers racing each other. Ad.claimedByWorker is
// adgen's ownership marker for a row this sweep must not touch while the
// claiming worker is alive — not a concurrency-dedup lease among peekers.
// With video recovery excluded entirely above as the primary defense, this
// claim-aware filter is what still protects an image row adgen is actively
// claiming and rendering right now — it stays unconditional and per-row
// rather than assuming kind is the only signal, because a stale claim
// marker left over from ANY prior owner deserves the same caution. Adgen's
// renderer DOES run
// its own per-ad heartbeat during titling (mirrors this repo's renderOne,
// routes/ads.js:2822 — every 60s, unlike renderOne it also covers a claimed
// row stuck at status:'rendering' through the WHOLE titling pass, since
// adgen does not flip to 'draft' until titling terminates), but this sweep
// must not assume that heartbeat is reliable: it can lag under event-loop
// contention from a CPU-heavy Remotion pass, silently miss individual
// writes (a caught-and-swallowed error — "the next one lands"), or stop
// entirely once adgen's own heartbeat lifetime cap is hit while work is
// still genuinely in flight (adgen's own code documents that exact residual
// as accepted, deferring to backend recovery). Any of those looks identical
// from here: an untouched updatedAt. Sweeping a still-live claim on the
// strength of RESUME_STALE_MIN (5m, calibrated for OUR OWN renderOne's
// beat, not another process's) would stamp status:'draft' +
// titlingResumeState:'pending' out from under the live worker (dual
// Remotion render on one paid master). Claimed rows therefore get
// RESUME_CLAIM_STALE_MIN (default 15, same "generous on purpose" convention
// as titlingResumeService.CLAIM_STALE_MIN) — long enough that a
// merely-lagging beat is never mistaken for a dead one, short enough that a
// dead worker's paid master is still recovered; this sweep must never
// become a permanent no-op for claimed rows.
//
// ⚠️ NEITHER GUARD IS COMPLETE ON ITS OWN, and neither closes every known
// race — stated plainly rather than implied. The ownership gate is a
// process-wide switch, not a per-row lock: `Ad.updateOne` below is still
// guarded only by `{ _id, status:'rendering' }`, so a row that looked
// unclaimed at query time but gets claimed by adgen a moment later (between
// the find and the write) can still be stomped — pre-existing behaviour,
// not introduced or closed here. And adgen's OWN vendored copy of this
// file is a SEPARATE, unaudited codebase this fix cannot reach — closing
// this gap here does not prove the adgen-side sweeper is claim-aware or
// correctly gated. Both are known, out-of-scope-for-this-file residuals;
// do not read this fix as "the dual-render race is closed."
//
// ── WHY THE STALENESS WINDOW EXISTS ─────────────────────────────────────────
// An ad being rendered RIGHT NOW by another live instance is also
// `status: 'rendering'` with a receipt. Peeking it is harmless, but stamping it
// `draft` underneath its owner would race the owner's own completion write.
// renderOne heartbeats `updatedAt` every 60s, so an ad untouched for
// RESUME_STALE_MIN minutes has missed several beats and is not being actively
// rendered by anyone. Default 5 = five missed heartbeats.

const Ad = require('../models/Ad');
const { HAS_RECEIPT } = require('./spendReceipt');
// Static-image counterpart: recoverImageAd peeks (free GET), finishPlate (local
// crop + logo), Cloudinary upload, optional vision QC. ZERO image submits.
// See imageRecoveryService header for the money contract.
const { recoverImageAd } = require('./imageRecoveryService');
// Upgrades an 'estimated' ledger row to Atlas's own settled `price`. The owner rule
// is that a charge must be CONFIRMED, never assumed — see the charge block below.
const { reconcileCost } = require('./costTracker');
const alerts = require('./alertService');

// Five missed 60s heartbeats. Lower than REAP_STALE_MIN (15) on purpose: the
// point is to recover the asset BEFORE the reaper or a re-run gets involved.
const RESUME_STALE_MIN = Math.max(1, parseInt(process.env.RESUME_STALE_MIN, 10) || 5);
// Bound the boot cost. Recovery is fire-and-forget and must never make startup
// slow or unbounded; whatever is missed is picked up on the next sweep.
const RESUME_MAX_ADS   = Math.max(1, parseInt(process.env.RESUME_MAX_ADS, 10) || 25);
// Generous on purpose — mirrors titlingResumeService's TITLING_RESUME_STALE_MIN=15.
// Must be materially larger than RESUME_STALE_MIN (5): RESUME_STALE_MIN is
// calibrated to OUR OWN renderOne's 60s beat (routes/ads.js:2822); a claim
// held by a DIFFERENT process has no such guarantee from here — its own
// heartbeat (if any) can lag under load, miss a write, or stop while work is
// still genuinely in flight, and titling can legitimately run long when
// serialized behind REMOTION_QUEUE_CONCURRENCY, so a short window would steal a
// live claim. A long one costs, at worst, wasted CPU on a redundant second pass
// IF the claim really is dead — never a double-SPEND (recoverImageAd only
// peeks a free GET and only writes when the provider says done; this sweep
// never submits).
//
// Floored at RESUME_STALE_MIN, not a bare 1 — adversarial finding: a bare
// `Math.max(1, ...)` let an operator set RESUME_CLAIM_STALE_MIN=1 (or raise
// RESUME_STALE_MIN above the claimed default) and INVERT the whole point of
// this constant, making a claimed row easier to steal than an unclaimed one.
// That is exactly the misconfiguration that looks fine in a diff and only
// shows up as a dual Remotion render at 3am. Clamping here means the
// invariant holds for every caller of buildRecoverySweepFilter, not just the
// default-value assertions in F1/F1b below, which check defaults only.
const RESUME_CLAIM_STALE_MIN = Math.max(RESUME_STALE_MIN, parseInt(process.env.RESUME_CLAIM_STALE_MIN, 10) || 15);

function enabled() {
  return String(process.env.RESUME_IN_FLIGHT_ON_BOOT ?? 'true').toLowerCase() !== 'false';
}

/**
 * The sweep's candidate filter, as a pure function of both staleness
 * cutoffs. Exported so a harness can evaluate it against real document
 * shapes instead of regexing this file.
 *
 * Claim-aware (2026-08-26): an ad actively claimed by an adgen worker
 * (Ad.claimedByWorker set) can legitimately sit status:'rendering' with
 * a stale updatedAt while Remotion titling runs — the claiming process's
 * own heartbeat (if any) is not something this sweep can verify or rely
 * on. Sweeping it here would stamp status:'draft' +
 * titlingResumeState:'pending' out from under the live claim, corrupting
 * the status:'rendering' guard the claiming worker's own completion
 * write relies on to know it still owns the row — the DUAL-RENDER hole.
 * So a claimed row gets a MUCH longer staleness allowance
 * (RESUME_CLAIM_STALE_MIN, default 15m, mirrors
 * titlingResumeService.CLAIM_STALE_MIN's "generous on purpose"
 * convention) before this sweep treats the claiming worker as dead and
 * takes the row over anyway — this sweep's whole purpose is recovering
 * a paid asset a dead process can no longer deliver, so it must never
 * become a permanent no-op for claimed rows.
 *
 * HAS_RECEIPT is nested inside `$and`, never spread next to the claim
 * `$or`. HAS_RECEIPT is itself `{ $or: [...] }`; two top-level `$or`
 * keys in one object would silently drop the receipt guard.
 *
 * TWO CLOCKS on the claimed arm, both required stale, on purpose. `claimedAt`
 * is stamped ONCE, at claim time, and never refreshed — it answers "how old
 * is this ownership", not "is the work still moving". `updatedAt` is what
 * (if anything) heartbeats during the work itself. Gating on `updatedAt`
 * alone has a real hole: a HANDOFF — the titler clearing a claim for
 * reclaim, or a fresh `claimOne()` winning it — writes `claimedByWorker`
 * without touching `updatedAt` at all (adversarial finding), so a row could
 * carry a SECONDS-old claim sitting on an `updatedAt` that predates it by
 * well over claimCutoff and be swept immediately. Requiring `claimedAt` to
 * ALSO be stale closes exactly that: a brand-new claim's `claimedAt` is
 * fresh regardless of what `updatedAt` last said, so it is protected from
 * the moment it is taken, not only once something first heartbeats it.
 *
 * `claimedAt: null` (legacy/unstamped claims) needs an EXPLICIT null arm,
 * not a bare `$lt`, and this was gotten wrong once — corrected 2026-08-27
 * against a real production probe, not by re-reading the Mongo manual.
 * MongoDB's comparison OPERATORS are type-bracketed: `{$lt: <a Date>}` only
 * matches values of a comparable type and does NOT match `null`, unlike the
 * general BSON *sort* order (where null sorts before every non-MinKey type)
 * — the two rules look like they should agree and do not. Measured directly
 * against this collection: of 1,391 rows with `claimedAt: null`, querying
 * `{claimedAt: {$lt: <a cutoff one full YEAR in the future}}}` matched
 * **zero** — the most favorable cutoff possible for the wrong assumption,
 * and it still matched nothing. 65 real-Date `claimedAt` rows matched the
 * same query as a positive control (all 65). So the ORIGINAL single-clause
 * `claimedAt: { $lt: claimCutoff }` silently EXCLUDED every legacy claim
 * from ever being swept — the opposite of the fallback this clause exists
 * to provide: a claimed-but-unstamped row would sit `status:'rendering'`,
 * holding a paid receipt, FOREVER, no matter how dead the worker actually
 * is. The fix is the explicit `$or` below, verified against the same
 * production data with both a positive control (a real, stale `claimedAt`
 * still matches) and a negative control (a real, FRESH `claimedAt` — one
 * newer than the cutoff — still does NOT match, so this is not "null always
 * passes" swallowing genuine staleness).
 *
 * `receiptKinds` narrows WHICH receipt a candidate must hold — 'both' (the
 * original HAS_RECEIPT $or), 'image', or 'video'. Exists so the video
 * ownership gate in resumeInFlightAds can EXCLUDE video rows from the query
 * itself, not just skip them once loaded (adversarial finding, second
 * round): `.limit(limit)` is shared across both kinds, sorted oldest-first,
 * and a deferred video row is never written — so it stays a candidate on
 * EVERY subsequent pass. Filtering it out only inside the loop still lets
 * it occupy a limit slot forever; once enough stranded video rows
 * accumulate (one mixed Meta+PMax product alone is 21 video rows) they can
 * fill the whole limit and starve image recovery entirely, which is exactly
 * the "must keep running" job this gate is not supposed to touch. Excluding
 * video at the query level keeps every limit slot available for the work
 * this process still owns.
 *
 * @param {Date} cutoff       unclaimed rows older than this are swept
 * @param {Date} claimCutoff  claimed rows older than this are swept
 * @param {'both'|'image'|'video'} [receiptKinds='both']
 */
function buildRecoverySweepFilter({ cutoff, claimCutoff, receiptKinds = 'both' }) {
  // 'image' and 'video' must be MUTUALLY EXCLUSIVE and together cover
  // exactly what HAS_RECEIPT covers, matching the loop's own tie-break rule
  // below (`isImageReceipt = !ad.veoPredictionId && !!ad.imageGeneration
  // ?.predictionId` — video wins a tie). A row holding BOTH receipts is
  // 'video' kind, never 'image' kind, so 'image' must ALSO require
  // veoPredictionId to be absent/empty — omitting that half would let a
  // dual-receipt row pass the video ownership gate's query-level exclusion
  // (it has an image receipt) and then still fall into the video branch in
  // the loop (video wins the tie), defeating the gate for that row.
  const receiptClause = receiptKinds === 'image'
    ? { veoPredictionId: { $in: [null, ''] }, 'imageGeneration.predictionId': { $nin: [null, ''] } }
    : receiptKinds === 'video'
      ? { veoPredictionId: { $nin: [null, ''] } }
      : HAS_RECEIPT;
  return {
    status: 'rendering',
    $and: [
      receiptClause,
      {
        $or: [
          { claimedByWorker: null, updatedAt: { $lt: cutoff } },
          {
            claimedByWorker: { $ne: null },
            updatedAt: { $lt: claimCutoff },
            // Explicit null arm — see the docblock above. `{$lt: claimCutoff}`
            // alone does NOT match `claimedAt: null` in real MongoDB (type-
            // bracketed comparison, verified against production), so a bare
            // single clause here would silently strand every legacy/unstamped
            // claim in `rendering` forever, regardless of how stale it is.
            $or: [
              { claimedAt: null },
              { claimedAt: { $lt: claimCutoff } }
            ]
          }
        ]
      }
    ]
  };
}

/**
 * Find receipt-holding ads stranded in `rendering` and collect whatever the
 * provider finished. Returns a summary; NEVER throws — a recovery pass must not
 * be able to take down the boot it runs inside, which is the exact crash class
 * (an unhandled rejection in fire-and-forget work) that motivated all of this.
 */
async function resumeInFlightAds({
  limit = RESUME_MAX_ADS,
  staleMinutes = RESUME_STALE_MIN,
  claimStaleMinutes = RESUME_CLAIM_STALE_MIN,
  // Injectable so the harness can exercise image recovery without network.
  recoverImage = recoverImageAd
} = {}) {
  const out = {
    considered: 0, recovered: 0, failed: 0, stillRunning: 0, unknown: 0, skipped: false,
    // Static images whose paid output was located but finishPlate/upload could
    // not complete this pass (fetch blip, geometry, etc.). Retried next sweep.
    // NOT "we refuse to collect" — collection is recoverImageAd below.
    recoverableNotCollected: 0,
    // Video-receipt rows left untouched because adgen owns rendering — see
    // the ADGEN OWNERSHIP header comment. Counted separately from
    // recoverableNotCollected: this is not "we tried and couldn't", it is
    // "someone else's job right now", and the two must not be conflated in
    // an operator-facing summary.
    deferredToAdgen: 0
  };
  if (!enabled()) { out.skipped = 'RESUME_IN_FLIGHT_ON_BOOT=false'; return out; }

  let ads;
  try {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const claimCutoff = new Date(Date.now() - claimStaleMinutes * 60 * 1000);
    // OWNER of the status:'rendering' + receipt population.
    // strandedRunSweeper owns queued/failed-run stranding; this service owns
    // mid-render / mid-QC crashes left in rendering. The worker reaper
    // (worker.js) deliberately leaves HAS_RECEIPT ads in rendering and only
    // requeues receiptFree — so recovery here cannot race a reaper requeue
    // into a second billable submit. RESUME_STALE_MIN (default 5) is also
    // lower than REAP_STALE_MIN (15): we collect before the reaper even
    // considers the row.
    //
    // Claim-aware: an adgen-claimed row can sit status:'rendering' with a
    // stale updatedAt through titling — its own heartbeat, if any, is not
    // something this process can verify. The 5-min unclaimed window would
    // steal a live claim and stamp draft + titlingResumeState pending out
    // from under the worker. Claimed rows use claimCutoff
    // (RESUME_CLAIM_STALE_MIN, default 15) so a dead worker is still
    // recovered. Filter is buildRecoverySweepFilter — HAS_RECEIPT nested
    // in $and, never spread next to the claim $or.
    //
    // Adgen owns all video rendering unconditionally, so the query itself
    // excludes video-receipt rows (receiptKinds:'image'), not just the loop
    // below. `.limit(limit)` is shared and a deferred video row is never
    // written, so it would stay a candidate on EVERY subsequent pass;
    // excluding it here (rather than fetching then skipping) keeps every
    // limit slot available for the image recovery this process still owns.
    ads = await Ad.find(buildRecoverySweepFilter({ cutoff, claimCutoff, receiptKinds: 'image' }))
      // imageGeneration is selected because HAS_RECEIPT/the 'image' clause
      // matches on imageGeneration.predictionId — see the routing note in
      // the loop below. Selecting only veoPredictionId is what made every stranded
      // STATIC ad fall through to the video resume and get written off as 'unknown'.
      // Full lean doc for recoverImageAd (platformFormat, mediaId, brandId, …).
      .sort({ updatedAt: 1 })          // oldest first — most likely already finished
      .limit(limit)
      .lean();

    // Deferred-video VISIBILITY only — a separate, limit-free count so the
    // operator-facing summary still says how many paid masters are sitting
    // out there, without letting them consume a single slot of `limit` that
    // image recovery needs. Never gates or delays the find above; a count
    // failure is non-fatal and simply leaves deferredToAdgen at 0 for this
    // pass (retried next tick, same as everything else in this file).
    out.deferredToAdgen = await Ad.countDocuments(
      buildRecoverySweepFilter({ cutoff, claimCutoff, receiptKinds: 'video' })
    ).catch((err) => {
      console.warn(`⚠️  bootRecovery: could not count deferred video ads — ${err.message}`);
      return 0;
    });
    if (out.deferredToAdgen > 0) {
      console.log(
        `♻️  bootRecovery: ${out.deferredToAdgen} video-receipt ad(s) left untouched — adgen owns rendering`
      );
    }
  } catch (err) {
    console.warn(`⚠️  bootRecovery: could not query stranded ads — ${err.message}`);
    return out;
  }
  out.considered = ads.length;
  if (!ads.length) return out;

  console.log(
    `♻️  bootRecovery: ${ads.length} ad(s) stranded in rendering with a spend receipt ` +
    `(>${staleMinutes}m stale) — polling receipts, never re-submitting`
  );

  for (const ad of ads) {
    // ROUTE BY WHICH RECEIPT THE AD ACTUALLY HOLDS, never by ad.kind — kind is not
    // always populated on a stranded row, whereas the receipt is the thing that
    // proves what was bought. Video wins a tie: if somehow both are present, the
    // Omni master is the expensive one (~$1.00 vs ~$0.07).
    const isImageReceipt = !ad.veoPredictionId && !!ad.imageGeneration?.predictionId;

    // ── ADGEN OWNS RENDERING: belt-and-braces, should be unreachable ──────
    // The query above already excludes video rows (adgen owns all video
    // rendering unconditionally), so `ads` should never contain one here.
    // Kept anyway: the query filter and this check are two
    // independently-maintainable mechanisms, and a future edit to ONE of
    // them (e.g. a new receipt shape, a refactored query) must not silently
    // reopen the video-recovery-while-adgen-owns-rendering hole this file
    // exists to close. Does not touch deferredToAdgen — that counter is
    // owned by the countDocuments call above; if this branch ever fires it
    // means the two mechanisms have drifted apart, which is worth a
    // distinct log line, not a silent merge into the same counter.
    if (!isImageReceipt) {
      console.warn(
        `⚠️  bootRecovery[${ad._id}]: video row reached the loop while adgen owns rendering — ` +
        `the query-level exclusion should have prevented this; skipping without acting`
      );
      continue;
    }

    // ── STATIC IMAGE: finish the already-paid plate (crop + logo + upload) ──
    // recoverImageAd peeks, fetches, finishPlate, uploads, optional vision QC.
    // ZERO image submits. Status-filtered write; never stamps raw Atlas URL.
    if (isImageReceipt) {
      let ir;
      try {
        ir = await recoverImage({ ad });
      } catch (err) {
        out.unknown++;
        console.warn(`   ⚠️  bootRecovery[${ad._id}]: image recover threw — ${err.message}`);
        continue;
      }
      if (ir.state === 'recovered') {
        out.recovered++;
        console.log(
          `   ✅ bootRecovery[${ad._id}]: static plate recovered from receipt ${ir.predictionId}` +
          `${ir.qcFailed ? ' (vision QC failed — kept paid render, status failed)' : ''} — $0 image submit`
        );
        continue;
      }
      if (ir.state === 'processing' || ir.state === 'unknown') {
        out.stillRunning++;
        continue;
      }
      if (ir.state === 'failed') {
        // Atlas says the prediction failed. Charge is CONFIRMED only when peek
        // published a positive price (same rule as the video failure path).
        try {
          const confirmedCharge = ir.priceConfirmed === true && Number(ir.price) > 0;
          const chargeNote = ir.priceConfirmed !== true
            ? ' [charge UNCONFIRMED — Atlas published no price for this prediction; stored as not-charged because the schema cannot express "unknown"]'
            : '';
          await Ad.updateOne(
            { _id: ad._id, status: 'rendering' },
            { $set: {
              status: 'failed',
              updatedAt: new Date(),
              'renderError.message': (ir.message || 'prediction failed') + chargeNote,
              'renderError.stage': 'resume',
              'renderError.at': new Date(),
              'renderError.predictionId': ad.imageGeneration?.predictionId || null,
              'renderError.charged': confirmedCharge
            } }
          );
          if (confirmedCharge && ir.predictionId) {
            reconcileCost({ providerRequestId: ir.predictionId, costUsd: Number(ir.price) })
              .catch(() => {});
          }
          out.failed++;
        } catch (err) {
          console.warn(`   ⚠️  bootRecovery[${ad._id}]: could not record image failure — ${err.message}`);
          out.unknown++;
        }
        continue;
      }
      if (ir.state === 'no-receipt') {
        out.unknown++;
        continue;
      }
      // unrecoverable this pass (geometry / upload / already resolved) — leave
      // in rendering for a later retry, or already-resolved is a no-op.
      out.recoverableNotCollected++;
      console.warn(
        `   ⚠️  bootRecovery[${ad._id}]: image recover ${ir.state} — ${ir.message || 'no detail'}`
      );
      continue;
    }
  }

  // A located-but-uncollected paid image is also worth waking someone for: the money
  // is spent and the asset is sitting at Atlas, so it belongs in the same report
  // rather than only in a log line nobody greps.
  const touched = out.recovered + out.failed + out.recoverableNotCollected;
  if (touched > 0) {
    console.log(
      `♻️  bootRecovery: ${out.recovered} recovered · ${out.failed} failed · ` +
      `${out.recoverableNotCollected} paid-but-uncollected · ` +
      `${out.stillRunning} still running · ${out.unknown} unknown`
    );
    // Worth waking someone for: money was recovered, confirmed lost, or is sitting
    // paid-for and undelivered.
    alerts.notifyAsync({
      level: out.recovered > 0 ? 'info' : 'warn',
      title: out.recovered > 0
        ? `Recovered ${out.recovered} paid generation(s) after a restart`
        : out.recoverableNotCollected > 0
          ? `${out.recoverableNotCollected} paid image(s) located but not finished this pass`
          : `${out.failed} paid generation(s) confirmed failed after a restart`,
      key: 'boot-recovery',
      fields: {
        recovered: out.recovered || undefined,
        failed: out.failed || undefined,
        'not finished this pass': out.recoverableNotCollected || undefined,
        'still running': out.stillRunning || undefined,
        unknown: out.unknown || undefined
      }
    });
  }
  return out;
}

module.exports = {
  resumeInFlightAds, RESUME_STALE_MIN, RESUME_MAX_ADS, enabled,
  // Claim-aware sweep filter + the longer claimed-row TTL. Exported so a
  // harness can evaluate the real query against real document shapes.
  buildRecoverySweepFilter, RESUME_CLAIM_STALE_MIN
};
