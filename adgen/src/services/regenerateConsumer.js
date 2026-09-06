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
// ── MONEY — lease expiry + baseline snapshot + receipt check ─────────────
// A crash mid-flight used to leave regenerateClaimedByWorker set FOREVER —
// stuck until an operator cleared it by hand (confirmed live in production).
// claimOne() now has a second arm that reclaims a claim whose
// regenerateClaimedAt is older than CLAIM_STALE_MIN. That is NOT a naive
// retry, and the distinction is the whole safety argument.
//
// WHY A NAIVE RESUME WOULD BE WRONG. A regenerate always runs on an ad that
// ALREADY holds a previously-completed video, so Ad.veoPredictionId is
// essentially ALWAYS populated BEFORE a regenerate begins — it holds the OLD
// prediction. "A receipt exists" therefore cannot mean "this attempt paid for
// something". Resuming on that basis would poll the OLD completed prediction,
// return the OLD video, and report success while silently handing the operator
// back the exact video they were trying to replace.
//
// That is precisely why adRegenerateService.runVideoFull passes the LITERAL
// allowResume:false into generateForAd. That literal is FROZEN — it was set by
// commit 2f99218 (PR #40, "resume-from-receipt on generateForAd re-entry
// (MONEY)"), whose review explicitly "required the caller-site allowResume
// wiring to be explicit, not implicit", and it is pinned by
// scripts/verifyVideoResumeFromReceipt.js C2. Do NOT widen it. A lease that
// re-entered that path blindly would bill a fresh Omni submit every
// CLAIM_STALE_MIN.
//
// WHAT MAKES RECLAIMING SAFE IS THE RECEIPT CHECK, NOT THE LEASE. Arm 1 (a
// fresh claim) snapshots veoPredictionId onto
// regenerationRequest.priorVeoPredictionId / priorVeoPredictionSetAt in a
// second, winner-scoped write, BEFORE that attempt can touch it. Arm 2 (a
// reclaim) deliberately does NOT restamp those — the original baseline must
// survive every reclaim unchanged. runClaimedRegeneration then treats a NEW
// veoPredictionId (unequal to the baseline, and only when a baseline was
// actually captured) as the ONLY positive proof that the abandoned attempt
// minted its own Atlas receipt, and peeks it with atlasVideoService.resumeForAd
// — a free GET that can never submit. No baseline, or the id is still the old
// one, means today's dispatch, byte-for-byte unchanged: crash-before-submit,
// any static regenerate, any pre-fix stuck row. The lease decides only WHO may
// look; the receipt check decides whether a submit is legal.
//
// ARM 2 REQUIRES A BASELINE, DELIBERATELY. The filter demands
// regenerationRequest.priorVeoPredictionSetAt be a real date, so a row claimed
// BEFORE this code shipped is never leased. Without that predicate, deploying
// this would auto-reclaim every currently-stuck production row — none of which
// carry a baseline — fall through to runVideoFull, and fire a brand-new
// billable Omni submit for each one that had already paid. That would turn a
// $0 stuck-forever state into real money on deploy day. Pre-fix rows therefore
// keep exactly today's behaviour (operator-cleared); only claims taken after
// this ships get a lease.
//
// BOUNDED RECLAIM CEILING. Today's stuck claim costs $0 extra. A lease that
// reclaimed forever would bill a fresh submit every CLAIM_STALE_MIN
// indefinitely (the confirmed-unbilled-failure branch legitimately falls
// through to a fresh submit). MAX_RECLAIMS is enforced in the EXECUTOR, not in
// arm 2's filter, so an exhausted row settles into an honest terminal failed
// state with an alert instead of becoming a NEW silently-stuck population —
// filter-side silence is the defect this change exists to remove.
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

// How long a claim must sit untouched before arm 2 may take it over.
//
// GENEROUS ON PURPOSE, because this consumer does NOT heartbeat the lease:
// regenerateClaimedAt is written once, at claim time. adRegenerateService's
// setStage() bumps Ad.updatedAt during the flight, but the lease keys off
// regenerateClaimedAt, which stays frozen at the claim instant. A legitimately
// in-progress video regenerate therefore looks exactly as old as a dead one,
// so the threshold must exceed the longest plausible attempt by a wide margin.
// Under-setting it is the HARMFUL direction: a still-alive worker and a
// reclaimer would both be inside runVideoFull, which is a second billable Omni
// submit. (titlingResumeService's own CLAIM_STALE_MIN documents the same
// posture for the same reason — there the cost of getting it wrong is wasted
// CPU; here it is money.)
//
// Worst plausible case, from the code rather than a guess. A single
// pollPrediction can block for the whole ATLAS_TIMEOUT_MS budget
// (atlasVideoService MAX_POLL_MS, default 600000 = 10 min) when Atlas is
// genuinely still rendering; real Omni predictions have been measured at
// 14-25 min. On top of that: submit latency, the predictionFailed policy's
// backoff, the master download, the Cloudinary mirror and the Remotion
// composite. (An earlier version of this comment claimed "10 min x 3 attempts
// = 30 min of polling"; that is wrong — a FAILED generation returns fast, so
// the attempts do not each burn the full poll budget. Corrected by adversarial
// review. The default is generous for the right reason, not the stated one.)
//
// FLOORED, not merely defaulted — the same discipline atlasVideoService's
// REFRAME_CLAIM_TTL_MS uses (max(configured, MAX_POLL_MS + 10min)). Without a
// floor, ADGEN_REGEN_CLAIM_STALE_MIN=1 would be accepted and a still-alive
// pre-submit worker could have its row stolen, which is a double billable
// submit — and raising ATLAS_TIMEOUT_MS would silently reopen the same hole.
// An operator can raise this knob but cannot lower it into a money bug.
//
// THE PROPER FIX IS A HEARTBEAT (station-contract element 2) — with one, this
// threshold could drop to minutes and the still-alive-worker race would close
// entirely. Deliberately out of scope for this change.
const ATLAS_POLL_CEILING_MIN = Math.ceil(
  ((parseInt(process.env.ATLAS_TIMEOUT_MS, 10) || 600000) / 60000)
) + 10;
const CLAIM_STALE_MIN = Math.max(
  ATLAS_POLL_CEILING_MIN,
  parseInt(process.env.ADGEN_REGEN_CLAIM_STALE_MIN, 10) || 45
);

// Ceiling on how many times one request may be reclaimed. Enforced by
// runClaimedRegeneration BEFORE any provider call — deliberately NOT in arm
// 2's filter, so an exhausted row terminates honestly instead of silently
// dropping out of the claimable population. Duplicated there with the same env
// parse (requiring it from this file would be a cycle: this module already
// requires adRegenerateService). Default 2 = the original claim plus two
// reclaims.
const MAX_RECLAIMS = Math.max(1, parseInt(process.env.ADGEN_REGEN_MAX_RECLAIMS, 10) || 2);

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

  // ── ARM 1 — fresh claim ────────────────────────────────────────────────
  // Filter and $set are BYTE-IDENTICAL to the original single-arm claim.
  // scripts/verifyRegenerateConsumerClaim.js A2/A3/A4/A7/A8 extract the FIRST
  // Ad.findOneAndUpdate in this function and pin exactly these keys — do not
  // add fields to this $set.
  const fresh = await Ad.findOneAndUpdate(
    {
      regenerating:              true,
      regenerationRequest:       { $type: 'object' },
      regenerateClaimedByWorker: null
    },
    { $set: { regenerateClaimedByWorker: WORKER_ID, regenerateClaimedAt: new Date() } },
    { new: true, sort: { updatedAt: 1 } }
  );

  if (fresh) {
    // ⚠️ MONEY — THE BASELINE SNAPSHOT. Captured in a SECOND write, scoped to
    // {_id, regenerateClaimedByWorker: WORKER_ID} so only the claim's winner
    // can stamp it, and taken NOW — before this attempt can touch
    // veoPredictionId. This is the only thing that later lets a reclaim tell
    // "this attempt minted a new receipt" from "this is still the very video
    // the operator asked us to replace". See the file header.
    //
    // Written as dotted sub-paths of regenerationRequest, which is declared
    // Mixed in models/Ad.js — so no new top-level schema path is created and
    // scripts/verifyModelParity.js's adgen ⊆ backend subset rule is untouched.
    // markComplete's existing `regenerationRequest: null` clears them for free.
    //
    // Never throws (matching this file's posture for secondary writes). If it
    // fails we do NOT mirror onto the in-memory doc, and the executor fails
    // CLOSED — no baseline means no resume, ever. Arm 2 additionally refuses
    // to lease a row with no baseline, so a failed snapshot degrades to
    // exactly today's stuck-until-an-operator-looks behaviour rather than to a
    // blind resubmit.
    const priorId = fresh.veoPredictionId ?? null;
    const priorAt = new Date();
    try {
      const snap = await Ad.updateOne(
        { _id: fresh._id, regenerateClaimedByWorker: WORKER_ID },
        {
          $set: {
            'regenerationRequest.priorVeoPredictionId':    priorId,
            'regenerationRequest.priorVeoPredictionSetAt': priorAt
          }
        }
      );
      if ((snap.matchedCount ?? snap.n ?? 0) > 0) {
        if (!fresh.regenerationRequest || typeof fresh.regenerationRequest !== 'object') {
          fresh.regenerationRequest = {};
        }
        fresh.regenerationRequest.priorVeoPredictionId = priorId;
        fresh.regenerationRequest.priorVeoPredictionSetAt = priorAt;
      } else {
        console.warn(
          `regenerate-consumer[${WORKER_ID}]: baseline snapshot matched 0 rows for ad=${fresh._id} ` +
          '— failing closed (this attempt can never resume, and cannot be reclaimed)'
        );
      }
    } catch (err) {
      console.warn(
        `regenerate-consumer[${WORKER_ID}]: baseline snapshot failed for ad=${fresh._id} — ${err.message} ` +
        '(failing closed: this attempt can never resume, and cannot be reclaimed)'
      );
    }
    return fresh;
  }

  // ── ARM 2 — reclaim after lease expiry ─────────────────────────────────
  // Only reached when arm 1 found nothing, so a claimable fresh request always
  // wins over reclaiming a stale one.
  //
  // ⚠️ MONEY — priorVeoPredictionSetAt MUST be required here. It is what stops
  // this arm from leasing a row claimed BEFORE this code shipped: those rows
  // carry no baseline, so the executor's receipt gate cannot evaluate them,
  // and they would fall straight through to a fresh billable Omni submit —
  // including every stuck row that had ALREADY paid. Requiring the baseline
  // keeps pre-fix rows at exactly today's behaviour ($0, operator-cleared).
  // $type:'date' (not $exists / $ne:null) for the same reason arm 1's
  // regenerationRequest test uses $type — it demands the field actually BE a
  // date, excluding both "missing" and an explicit null.
  //
  // No reclaim ceiling in this filter, on purpose — see MAX_RECLAIMS.
  // The two baseline sub-fields are deliberately NOT touched: the original
  // claim's snapshot must survive every reclaim unchanged, or a reclaim would
  // rebase the baseline onto the receipt it is supposed to be judging.
  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MIN * 60 * 1000);
  return Ad.findOneAndUpdate(
    {
      regenerating:              true,
      regenerationRequest:       { $type: 'object' },
      regenerateClaimedByWorker: { $ne: null },
      regenerateClaimedAt:       { $lt: staleCutoff },
      'regenerationRequest.priorVeoPredictionSetAt': { $type: 'date' }
    },
    {
      $set: { regenerateClaimedByWorker: WORKER_ID, regenerateClaimedAt: new Date() },
      $inc: { 'regenerationRequest.reclaimCount': 1 }
    },
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
    // header: the LEASE is now the retry, and it is gated on the receipt
    // check, so leaving the row untouched here is safe rather than terminal.
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
  // its counter around the claim; regenerate still does NOT release leftover
  // claims on shutdown. That is now a deliberate choice rather than the only
  // option: claimOne's arm 2 reclaims the row after CLAIM_STALE_MIN, and the
  // executor's receipt gate decides whether resubmitting is legal — so an
  // orphaned claim recovers on its own instead of needing an operator, without
  // a shutdown-time release that could hand a live worker's row to a peer.
  // Clearing inFlight on a null/failed claim is the only extra step, so idle
  // ticks do not hold the drain.
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
// visible operational item instead of a silent one. This does NOT release the
// claim (regenerateClaimedByWorker stays set) and does not retry inline — but
// unlike before, the row is no longer stranded: claimOne's arm 2 reclaims it
// after CLAIM_STALE_MIN and the receipt gate then decides whether a resubmit is
// legal. The alert still fires, because a possibly-billed in-flight submit is
// worth a human's attention sooner than the lease interval.
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
      `sweep will not find it). The lease will reclaim it in ~${CLAIM_STALE_MIN}min and the receipt ` +
      `check will decide whether it is safe to resubmit; flagging now because that is slower than a human.`
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
              waitedMs,
              note: `row left as regenerating:true — not released; the lease reclaims it in ~${CLAIM_STALE_MIN}min ` +
                    'and the receipt check gates any resubmit'
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
    `regenerate-consumer[${WORKER_ID}]: starting — poll interval ${POLL_MS}ms, ` +
    `lease ${CLAIM_STALE_MIN}min, max reclaims ${MAX_RECLAIMS}, ` +
    `handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}`
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

module.exports = {
  start, claimOne, POLL_MS,
  CLAIM_STALE_MIN, MAX_RECLAIMS,
  SHUTDOWN_DRAIN_MS, SHUTDOWN_ALERT_MS
};
