'use strict';
// Ad-gen regenerate consumer (routing fix, 2026-08-26).
//
// Owner directive, verbatim: "regenerate whether user triggered or
// triggered by the QC check should absolutely be running through adgen."
//
// Backend's POST /api/ads/:id/regenerate, plus the two agent capabilities
// (ad.regenerate, ad.regenerateWithPrompt), all funnel into
// services/adRegenerateService.regenerateAd() in the backend. When
// ADGEN_RENDERER_ENABLED is true, that function no longer executes the
// regenerate itself — it wins the existing `regenerating` atomic lock (same
// semantics as always) and additionally stamps the full call as
// Ad.regenerationRequest, then returns. This module is the other half: it
// polls for stamped-but-unclaimed requests, atomically claims ONE, and runs
// it through THIS repo's OWN adRegenerateService.runClaimedRegeneration —
// the same vendored file backend uses, fully self-contained against this
// repo's own videoRouter / atlasVideoService / directImageRenderService /
// brandScriptExecutor, including the MONEY-CRITICAL allowResume:false
// carve-out inside runVideoFull and the shared resolveDeriveFromMaster 409
// gate inside preflight (already run by the backend before the 202 — this
// consumer does not re-run it).
//
// ── MONEY — why this can never double-submit with the backend ───────────
// The ONE bit that decides who executes a regenerate is
// Ad.regenerationRequest (an actual stamped object ONLY on the deferred
// path — see the doc comment on those fields in models/Ad.js). The
// backend's own local-execution path (flag off) NEVER writes that field, so
// this consumer's claim query (regenerationRequest:{$type:'object'}) can
// never match a row the backend is already executing in-process. Uses
// $type, deliberately NOT $ne:null — MongoDB's $ne is documented to match
// documents that do not contain the field at all, which is exactly the
// shape of every pre-migration ad and every ad whose regenerate ran
// locally, so an earlier version of this filter using $ne:null claimed
// those rows too (see claimOne()'s own comment and
// scripts/verifyRegenerateConsumerClaim.js A3/B7 for the full story). The
// claim itself is a SEPARATE lock (regenerateClaimedByWorker) on a filter
// disjoint from the mint-time render claim (status:'rendering' +
// claimedByWorker) — it cannot race that claim for the same document
// either.
//
// ── MONEY — why a stuck claim cannot double-submit ───────────────────────
// There is deliberately NO retry/release sweep for a claim that crashes
// mid-flight (regenerateClaimedByWorker stays set forever until an operator
// clears it by hand). This matches today's PRE-EXISTING backend-only
// behaviour exactly — a backend crash mid regenerateAd today also leaves the
// row stuck at regenerating:true forever, with zero automated retry; this
// change does not make that worse, and does not fix it either. Adding a
// retry here would be a REGRESSION relative to that baseline unless the
// retry is itself resume-aware — adRegenerateService.runVideoFull
// deliberately passes allowResume:false to generateForAd (an operator
// regenerate always wants a FRESH video, never a resumed one — see
// atlasVideoService.shouldResumeAttempt), so a naive retry would be a
// genuine second billable Omni submit. Do not add automatic retry here
// without also solving that.
//
// ── Wiring ────────────────────────────────────────────────────────────
// Started from renderer.run() (not a new ADGEN_ROLE) — same reasoning as
// startTitlingResumeSweep / startBootRecoverySweep in that file: this is a
// low-volume, on-demand consumer, not a bulk render queue, so it does not
// need its own deployed service, its own MAX_INFLIGHT, or a render.yaml
// change. Gated on isAdgenRendererEnabled(), read at call time (inside
// every tick, not just at start()) — same rationale as every other
// adgen-handoff gate in this repo: when the flag is OFF (rollback), the
// backend owns this collection and adgen must stand down immediately, not
// just at boot.

const { WORKER_ID, isAdgenRendererEnabled } = require('../config');
const Ad = require('../models/Ad');
const regen = require('./adRegenerateService');

const POLL_MS = Math.max(500, parseInt(process.env.ADGEN_REGEN_POLL_MS, 10) || 2000);

let stopping = false;
let inFlight = false;
let intervalHandle = null;
let bootTimeoutHandle = null;

// Atomic claim. Mirrors renderer.js claimOne()'s shape (findOneAndUpdate,
// {new:true}, FIFO sort by staleness) but on a filter DISJOINT from both the
// mint-time render claim (status:'rendering' + claimedByWorker) and from
// titler's claim (titlingNeeded) — see the file header for why that
// disjointness is the whole safety argument.
//
// ⚠️ MONEY — regenerationRequest MUST be tested with $type, NOT $ne:null.
// MongoDB's $ne is documented to match documents that do not contain the
// field at all ("This includes documents that do not contain the field" —
// https://www.mongodb.com/docs/manual/reference/operator/query/ne/), which
// is the OPPOSITE of what this filter needs: regenerationRequest is absent
// on every ad that predates this migration AND on every ad whose regenerate
// ran on the local-execution path (the field this repo's own doc comments
// call "the ONE field the backend local-execution path never writes"). An
// earlier version of this filter used {$ne:null} and — because absent
// satisfies $ne:null — collapsed to matching ANY regenerating:true row,
// including ones the backend was executing in-process (double submit) and
// ones stuck from a past crash with no receipt to protect (see
// scripts/verifyRegenerateConsumerClaim.js B7/B8 for the regression proof).
// $type:'object' requires the field to actually BE a stamped object —
// excludes both "missing" and explicit null, which is exactly the "backend
// deferred this to me" bit this claim depends on.
async function claimOne() {
  if (!isAdgenRendererEnabled()) return null;
  return Ad.findOneAndUpdate(
    {
      regenerating:              true,
      regenerationRequest:       { $type: 'object' },
      regenerateClaimedByWorker: null
    },
    { $set: { regenerateClaimedByWorker: WORKER_ID, regenerateClaimedAt: new Date() } },
    { new: true, sort: { updatedAt: 1 } }
  );
}

// The ad currently being processed (id + kind), for the shutdown alert
// below — null whenever nothing is in flight. Not the whole doc: this is
// diagnostic metadata, not something that should keep a large object alive.
let currentAd = null;

async function processClaimed(ad) {
  const req = (ad && ad.regenerationRequest) || {};
  currentAd = { id: String(ad._id), kind: req.kind || ad.kind || 'image' };
  console.log(
    `regenerate-consumer[${WORKER_ID}]: claimed ad=${currentAd.id} kind=${currentAd.kind}`
  );
  try {
    await regen.runClaimedRegeneration(ad, req);
  } catch (err) {
    // runClaimedRegeneration owns markComplete on both its success and
    // failure paths (same try/catch shape as regenerateAd's local path) —
    // a throw escaping THIS far means it never got that far (a bug in this
    // file, or a crash before performRegeneration's own try began). Leave
    // the row exactly as-is rather than guess at a state; see the file
    // header on why no automatic retry/release exists.
    console.error(
      `regenerate-consumer[${WORKER_ID}]: ad=${currentAd.id} crashed outside performRegeneration — ${err.message}`
    );
  } finally {
    currentAd = null;
  }
}

async function tick() {
  if (stopping || inFlight) return;
  if (!isAdgenRendererEnabled()) return;
  // Set BEFORE claimOne() so a SIGTERM that lands during the await still
  // sees inFlight===true and drainOnShutdown waits. The previous ordering
  // (set after claimOne returned) let stop() observe inFlight===false,
  // return immediately, then have the claim land on a process about to
  // exit — orphaning a just-claimed row. Mint-time renderer.js increments
  // its counter around the claim; regenerate deliberately does NOT release
  // leftover claims on shutdown (allowResume:false — a restart retry would
  // be a second billable submit). Clearing inFlight on a null/failed claim
  // is the only extra step, so idle ticks do not hold the drain.
  inFlight = true;
  try {
    let ad;
    try {
      ad = await claimOne();
    } catch (err) {
      console.warn(`regenerate-consumer[${WORKER_ID}]: claim query failed — ${err.message}`);
      return;
    }
    if (!ad) return;
    await processClaimed(ad);
  } finally {
    inFlight = false;
  }
}

// ⚠️ MONEY — SIGTERM must not silently abandon in-flight work. Render
// sends SIGTERM ~30s before SIGKILL on every deploy / autoscale-down /
// instance replacement (renderer.js's own SHUTDOWN_DRAIN_MS comment — three
// rolling deploys in 10 minutes once produced 22 zombie mint-time claims).
// A video regenerate can run for MINUTES (billed submit + poll), so a fixed
// ~25s drain window will often NOT be enough for it to finish — this stop()
// does not pretend otherwise. What it DOES do: wait up to the SAME budget
// renderer.js already gives mint-time work, and if the in-flight regenerate
// is STILL running when that budget expires, fire a LOUD alert naming the
// ad before returning — so an interrupted regenerate (submitted, maybe
// billed, now unpolled — nothing here or in bootRecoveryService watches a
// `regenerating:true` row, since regenerate never sets Ad.status) becomes a
// visible operational item instead of a silent one. This does NOT release
// the claim (regenerateClaimedByWorker stays set) and does NOT retry — see
// the file header on why a naive retry would be a genuine second submit.
// "FLAG, DON'T DISCARD" — same posture adVisionQcService's video QC path
// already uses for a different unrecoverable-cheaply money situation.
const SHUTDOWN_DRAIN_MS = Number(process.env.ADGEN_SHUTDOWN_DRAIN_MS || 25_000);
// Bound on the shutdown Slack notify. sendSlack already aborts at
// ALERT_SEND_TIMEOUT_MS (default 8s), which is still too long for the
// leftover SIGTERM budget after a 25s drain (Render SIGKILL is ~30s).
const SHUTDOWN_ALERT_MS = Number(process.env.ADGEN_SHUTDOWN_ALERT_MS || 4_000);

async function drainOnShutdown() {
  const t0 = Date.now();
  const deadline = t0 + SHUTDOWN_DRAIN_MS;
  while (inFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (inFlight && currentAd) {
    const waitedMs = Date.now() - t0;
    console.error(
      `regenerate-consumer[${WORKER_ID}]: SHUTDOWN with a regenerate still in flight after ` +
      `${waitedMs}ms drain — ad=${currentAd.id} kind=${currentAd.kind}. If the provider submit already ` +
      `succeeded, its receipt is now unpolled (regenerate never sets Ad.status, so bootRecoveryService's ` +
      `sweep will not find it) — needs manual review.`
    );
    try {
      const alerts = require('./alertService');
      // Await notify() (not fire-and-forget notifyAsync) so the HTTP
      // attempt actually starts before entrypoint.js process.exit(0).
      // Raced against SHUTDOWN_ALERT_MS so a hung Slack cannot stall
      // the leftover SIGTERM budget indefinitely.
      let timedOut = false;
      let timer;
      try {
        await Promise.race([
          alerts.notify({
            level: 'error',
            title: 'Regenerate interrupted by shutdown — possible uncollected receipt',
            key:   `regenerate-shutdown-interrupted:${currentAd.id}`,
            fields: {
              adId: currentAd.id, kind: currentAd.kind, worker: WORKER_ID,
              waitedMs, note: 'row left as regenerating:true — not released, not retried; needs manual review'
            }
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; resolve(); }, SHUTDOWN_ALERT_MS);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (timedOut) {
        console.warn(
          `regenerate-consumer[${WORKER_ID}]: shutdown alert timed out after ${SHUTDOWN_ALERT_MS}ms`
        );
      }
    } catch (err) {
      console.warn(`regenerate-consumer[${WORKER_ID}]: shutdown alert failed — ${err.message}`);
    }
  }
}

// Started from renderer.run(), stopped from renderer.shutdown() — same
// {stop()} shape as startTitlingResumeSweep / startBootRecoverySweep, except
// this stop() is ASYNC (awaits the drain above) — renderer.shutdown() must
// await it, not fire-and-forget, or the drain/alert above never gets a
// chance to run before the process exits.
function start() {
  const gated = isAdgenRendererEnabled();
  console.log(
    `regenerate-consumer[${WORKER_ID}]: starting — poll interval ${POLL_MS}ms, handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}`
  );
  // One immediate tick so a request stamped just before this process booted
  // doesn't wait a full interval — small delay so Mongo is connected.
  bootTimeoutHandle = setTimeout(() => { tick().catch(() => {}); }, 3000);
  if (typeof bootTimeoutHandle.unref === 'function') bootTimeoutHandle.unref();
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  return {
    async stop() {
      stopping = true;
      clearTimeout(bootTimeoutHandle);
      clearInterval(intervalHandle);
      await drainOnShutdown();
    }
  };
}

module.exports = { start, claimOne, POLL_MS, SHUTDOWN_DRAIN_MS, SHUTDOWN_ALERT_MS };
