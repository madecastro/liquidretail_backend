'use strict';
// Ad-gen manual RE-TITLE consumer (2026-08-28).
//
// Owner ask, verbatim: confirm whether backend's manual retitle routes
// (routes/brand.js POST /:id/retitle-videos, /title-still) would genuinely
// become "more scalable" if routed through adgen's titler engine instead of
// running in-process on the backend web server. Investigation found:
//  - retitle-videos IS a good fit: it already runs Remotion in-process on
//    the SAME process serving HTTP traffic (a worker pool of concurrency
//    1-4 inside the web server), the exact CPU-isolation problem adgen's
//    titler role exists to solve for the automatic post-generation path.
//  - title-still is NOT — it is a synchronous ~1-3s interactive preview
//    loop ("Powers /title-playground"); routing it through an async
//    claim-based remote worker would add latency variance and break its
//    whole reason for existing. Left untouched, still local-only.
//  - title-spec/modify is NOT a Remotion render at all (an LLM spec-editing
//    call) — does not belong in this migration.
//  - adgen's EXISTING titler.js claim (titlingNeeded/claimedByWorker) is
//    built exclusively for "a master just landed and has never been
//    titled" (claim requires status:{$in:['rendering','draft']}); manual
//    retitle's real-world target is commonly status:'live', delivered days
//    or weeks earlier, which that claim can never match. This file is a
//    NEW, disjoint claim namespace for exactly that reason — not a reuse.
//
// LIFECYCLE. Backend's routes/brand.js runRetitleJobViaAdgen(), when
// ADGEN_RENDERER_ENABLED is true, stamps Ad.retitleRequest per ad instead
// of calling renderBrandScriptAndSave in-process, then polls Mongo for
// completion. This module is the other half: it polls for stamped-but-
// unclaimed requests, atomically claims ONE via retitleClaimedByWorker (a
// field pair DISJOINT from claimedByWorker (mint-time render claim),
// titlingNeeded (renderer->titler handoff), AND regenerateClaimedByWorker
// (regenerate) — see models/Ad.js's retitleRequest doc comment), and runs
// it through THIS repo's own brandScriptExecutor.renderBrandScriptAndSave
// with retitleMode:true.
//
// ── retitleMode:true IS NOT OPTIONAL — read before touching this ────────
// renderBrandScriptAndSave's terminal write (uploadRenderAndStamp) forces
// status:'draft' on EVERY call by default — correct for the FIRST titling
// pass right after generation, catastrophic for a retitle of an
// already-delivered ad: it would silently un-publish a status:'live' ad on
// every single retitle, success or a QC fail. retitleMode:true (added
// alongside this file, see brandScriptExecutor.js's preserveAdStatus /
// retitleMode headers) is what stops that. It also routes a Remotion
// failure to a plain throw instead of stampTitlingFailureAndThrow, which
// exists solely to bound FIRST-titling retries via the SHARED
// Ad.titlingAttempts cap and to hand an unfinished master to
// titlingResumeState:'pending' for the automatic resume sweep — neither of
// which describes a manual retitle of an ad that already has a
// perfectly-titled, delivered renderUrl.
//
// ── MONEY — why this can never double-render with the automatic paths ───
// The claim bit is Ad.retitleRequest (an object ONLY on the deferred
// path — see the doc comment on those fields in models/Ad.js). Backend's
// stamp NEVER fires on a row currently mid-first-titling
// (titlingNeeded:{$ne:true} in its own filter), so this consumer's claim
// query (retitleRequest:{$type:'object'}) can never collide with the
// renderer->titler handoff or the automatic titling-resume sweep over the
// SAME row. Uses $type, deliberately NOT $ne:null — same reason as
// regenerationRequest: Mongo's $ne matches documents that do not contain
// the field at all, which is every pre-migration ad.
//
// CORRECTED 2026-08-28 (adversarial Grok review caught the first draft
// overclaiming "confirmed FREE"): retitle makes no NEW Atlas VIDEO-
// GENERATION submit (brandScriptExecutor.js never requires
// atlasVideoService, grep-verified in both repos) — but it DOES still
// make the same real, pre-existing Atlas LLM calls every titling render
// already makes: vision QC (adVisionQcService) and face-detection for the
// safe-crop (basePlateCropService), both via
// atlasLlmService.chatCompletion. Not a new cost introduced here. The
// hazard a dual claim guards against is DOUBLE EXECUTION of one
// operator-requested retitle — wasted Remotion compute + a duplicate
// Cloudinary upload + a duplicate vision-QC/face-detection call for the
// SAME request, not a double charge for two different things. That is
// why, UNLIKE the regenerate consumer, this one runs a stale-claim
// reclaim sweep (reclaimStaleRetitleClaims below) — a stuck claim is safe
// to release automatically because retrying costs only time and a
// render slot.
//
// ⚠️ KNOWN RESIDUAL, narrower direction, NOT fixed here: backend's stamp
// refuses a NEW retitleRequest while regenerating:true (added after
// adversarial review), but the REVERSE is unguarded — adRegenerateService's
// existing in-flight lock does not check retitleRequest/
// retitleClaimedByWorker, so a regenerate can start while this consumer
// already holds an active retitle claim on the same ad. Worst case is a
// last-writer-wins clobber between the retitle's stale-master output and
// the regenerate's fresh (paid) master — not a double bill. Judged
// disproportionate to fix by modifying regenerate's own already-
// adversarially-reviewed, money-critical lock for this narrower window.

const { WORKER_ID, isAdgenRendererEnabled } = require('../config');
const Ad    = require('../models/Ad');
const Brand = require('../models/Brand');
const { renderBrandScriptAndSave } = require('./brandScriptExecutor');

const POLL_MS = Math.max(500, parseInt(process.env.ADGEN_RETITLE_POLL_MS, 10) || 2000);

let stopping = false;
let inFlight = false;
let intervalHandle = null;
let bootTimeoutHandle = null;

function log(msg) { console.log(`retitle-consumer[${WORKER_ID}]: ${msg}`); }
function warn(msg) { console.warn(`retitle-consumer[${WORKER_ID}]: ${msg}`); }

// ── atomic claim ─────────────────────────────────────────────────────────
// Mirrors regenerateConsumer.js claimOne()'s shape (findOneAndUpdate,
// {new:true}, FIFO sort) on a filter DISJOINT from the mint-time render
// claim, the titler claim, and the regenerate claim — see the file header
// for why that disjointness is the whole safety argument.
//
// ⚠️ MONEY-ADJACENT (claim-safety, not billing) — retitleRequest MUST be
// tested with $type, NOT $ne:null. See the file header.
async function claimOne() {
  if (!isAdgenRendererEnabled()) return null;
  return Ad.findOneAndUpdate(
    {
      retitleRequest:         { $type: 'object' },
      retitleClaimedByWorker: null,
    },
    { $set: { retitleClaimedByWorker: WORKER_ID, retitleClaimedAt: new Date() } },
    { new: true, sort: { updatedAt: 1 } }
  );
}

// Clears the full retitle state in ONE $set, scoped to THIS worker's own
// claim (retitleClaimedByWorker: WORKER_ID) so a write that lands after a
// stale-claim reclaim already released this row cannot stomp whatever a
// later claimant is doing. Both success and failure funnel through here —
// same "one settle path" shape as regenerateConsumer's markComplete.
async function settle(adId, { status, renderUrl = null, error = null }) {
  await Ad.updateOne(
    { _id: adId, retitleClaimedByWorker: WORKER_ID },
    {
      $set: {
        retitleRequest:         null,
        retitleClaimedByWorker: null,
        retitleClaimedAt:       null,
        retitleResult: {
          status,
          renderUrl,
          error,
          completedAt: new Date(),
        },
        updatedAt: new Date(),
      },
    }
  );
}

let currentAd = null;

async function processClaimed(ad) {
  currentAd = { id: String(ad._id) };
  log(`claimed ad=${currentAd.id} — running retitle`);
  try {
    const brand = ad.brandId ? await Brand.findById(ad.brandId) : null;
    if (!brand) {
      await settle(ad._id, { status: 'failed', error: 'brand not found for this ad' });
      warn(`ad=${currentAd.id} FAILED — brand not found`);
      return;
    }
    const result = await renderBrandScriptAndSave({ ad, brand, retitleMode: true });
    if (result?.skipped) {
      // "No chrome configured" — not a failure, mirrors the local path's
      // own ok:true/skipped:true shape.
      await settle(ad._id, { status: 'done', renderUrl: ad.renderUrl || null });
      log(`ad=${currentAd.id} skipped (${result.reason || 'no-chrome'})`);
      return;
    }
    await settle(ad._id, { status: 'done', renderUrl: result.renderUrl || null });
    log(`ad=${currentAd.id} done`);
  } catch (err) {
    try {
      await settle(ad._id, { status: 'failed', error: (err && err.message) || String(err) });
    } catch (settleErr) {
      // Leave the row claimed — reclaimStaleRetitleClaims frees it on its
      // own schedule (retitle is safe to let a reclaim sweep clear; see the
      // file header). No retry loop here on purpose, same as the render
      // loop's own terminal-write failure handling.
      warn(`ad=${currentAd.id} settle() failed after a render failure (${settleErr.message}) — left claimed for the reclaim sweep`);
    }
    warn(`ad=${currentAd.id} retitle failed — ${(err && err.message) || err}`);
  } finally {
    currentAd = null;
  }
}

async function tick() {
  if (stopping || inFlight) return;
  if (!isAdgenRendererEnabled()) return;
  inFlight = true;
  try {
    let ad;
    try {
      ad = await claimOne();
    } catch (err) {
      warn(`claim query failed — ${err.message}`);
      return;
    }
    if (!ad) return;
    await processClaimed(ad);
  } finally {
    inFlight = false;
  }
}

// ── stale-claim reclaim ──────────────────────────────────────────────────
// Mirrors titler.js's reclaimStaleTitlerClaims exactly, on the retitle
// field pair. A worker that dies mid-render (OOM, deploy, SIGKILL) leaves
// retitleClaimedByWorker set forever otherwise — safe to auto-release
// because a re-run here is not a new billable VIDEO GENERATION (unlike
// the regenerate consumer's claim, which deliberately has NO reclaim
// sweep — see that file's header on why an automatic retry there would
// be a second billable Omni submit). A re-run here just re-pays the
// small, already-inherent vision-QC/face-detection LLM cost this render
// always makes — see this file's header for the "confirmed FREE"
// correction.
const RETITLE_CLAIM_STALE_MIN = Math.max(1, parseInt(process.env.RETITLE_CLAIM_STALE_MIN, 10) || 20);

async function reclaimStaleRetitleClaims() {
  const cutoff = new Date(Date.now() - RETITLE_CLAIM_STALE_MIN * 60 * 1000);
  const result = await Ad.updateMany(
    {
      retitleRequest:         { $type: 'object' },
      retitleClaimedByWorker: { $ne: null },
      retitleClaimedAt:       { $lt: cutoff },
    },
    { $set: { retitleClaimedByWorker: null, retitleClaimedAt: null } }
  );
  return { reclaimed: result.modifiedCount || 0 };
}

function startRetitleClaimReclaimSweep() {
  const intervalMin = Math.max(1, parseInt(process.env.RETITLE_CLAIM_RECLAIM_INTERVAL_MIN, 10) || 5);
  let inFlightPass = false;
  let timeoutHandle = null;
  let intervalHandle2 = null;

  const reclaimTick = () => {
    if (stopping || inFlightPass) return;
    if (!isAdgenRendererEnabled()) return; // backend owns this collection right now
    inFlightPass = true;
    reclaimStaleRetitleClaims()
      .then((out) => {
        if (out && out.reclaimed) {
          log(`claim reclaim — released ${out.reclaimed} stale retitle claim(s) (>${RETITLE_CLAIM_STALE_MIN}min old)`);
        }
      })
      .catch((err) => warn(`claim reclaim failed — ${err.message}`))
      .finally(() => { inFlightPass = false; });
  };

  // Same 90s-delay/N-min-interval shape as titler.js's own reclaim sweep.
  timeoutHandle = setTimeout(reclaimTick, 90 * 1000);
  intervalHandle2 = setInterval(reclaimTick, intervalMin * 60 * 1000);
  timeoutHandle.unref?.();
  intervalHandle2.unref?.();

  return {
    stop() {
      clearTimeout(timeoutHandle);
      clearInterval(intervalHandle2);
    },
  };
}

let claimReclaimSweep = null;

// ── SIGTERM drain ─────────────────────────────────────────────────────────
// Same posture as regenerateConsumer.js's drain — retitle is not billable,
// so an interrupted retitle is a much smaller deal than an interrupted
// regenerate: no receipt to lose, no double-submit risk. Still worth a
// bounded wait so a mid-render claim is not immediately orphaned on every
// rolling deploy; the stale-claim reclaim sweep is the actual backstop if
// the wait is not enough.
const SHUTDOWN_DRAIN_MS = Number(process.env.ADGEN_SHUTDOWN_DRAIN_MS || 25_000);

async function drainOnShutdown() {
  const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
  while (inFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (inFlight && currentAd) {
    warn(`SHUTDOWN with a retitle still in flight after ${SHUTDOWN_DRAIN_MS}ms drain — ad=${currentAd.id}. Not billable; the stale-claim reclaim sweep (>${RETITLE_CLAIM_STALE_MIN}min) will free it for a future request.`);
  }
}

function start() {
  const gated = isAdgenRendererEnabled();
  log(`starting — poll interval ${POLL_MS}ms, handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}`);
  bootTimeoutHandle = setTimeout(() => { tick().catch(() => {}); }, 3000);
  if (typeof bootTimeoutHandle.unref === 'function') bootTimeoutHandle.unref();
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  claimReclaimSweep = startRetitleClaimReclaimSweep();
  return {
    async stop() {
      stopping = true;
      clearTimeout(bootTimeoutHandle);
      clearInterval(intervalHandle);
      if (claimReclaimSweep) claimReclaimSweep.stop();
      await drainOnShutdown();
    },
  };
}

module.exports = {
  start,
  // Exported for scripts/verifyRetitleConsumerClaim.js — pure functions
  // driven directly against a real/stubbed Ad collection, same pattern as
  // regenerateConsumer's own harness.
  claimOne,
  settle,
  reclaimStaleRetitleClaims,
};
