'use strict';
// titler role — out-of-process Remotion titling for adgen.
//
// LIFECYCLE. The adgen renderer's video path, when ADGEN_TITLER_ENABLED is
// true, atomically stamps `titlingNeeded: true` + releases its claim
// immediately after the master's veoVideoUrl lands. The row stays
// status:'rendering' (receipt-holding, reaper-safe). This role's poll loop
// then claims those rows and does Remotion titling out-of-process, where
// Chrome gets all 8 GiB of memory without contending with the renderer's
// poll loop, Atlas HTTP work, or static submits on the same instance.
//
// CLAIM FILTER (money-safe):
//   { status: 'rendering',
//     veoVideoUrl:   { $ne: null },    // Omni master delivered — has receipt
//     titlingNeeded: true,             // renderer explicitly handed off
//     claimedByWorker: null }          // idle
//   sort: { createdAt: 1 }             // FIFO, matches renderer.claimOne
//
// SUCCESSFUL TERMINAL WRITE clears titlingNeeded, stamps renderUrl (via
// brandScriptExecutor.uploadRenderAndStamp), and releases the claim. Failed
// vision QC (buildVideoQcFailureFields inside titling) already stamps
// status:'failed' — the guarded terminal write here MUST NOT overwrite that
// (see settleNonDraftTerminal).
//
// ── DUPLICATION NOTICE ──
// This file duplicates several helpers currently defined in
// src/services/renderer.js: startAdHeartbeat, bumpRunCounter,
// maybeFinalizeRun, settleNonDraftTerminal, notifyRunFinalized, and the
// per-run heartbeat plumbing (runInflight/runHeartbeats/acquireRunHeartbeat).
// This is DELIBERATE — Phase 4 deletes the renderer's video titling path
// entirely (once ADGEN_TITLER_ENABLED has been on in prod for a stable
// window), at which point the helpers move here permanently and the
// renderer's copies vanish with the code that uses them. Extracting a
// shared module NOW would enlarge the blast radius of this PR unnecessarily.
// If you edit one copy, edit the other, until Phase 4 lands.

const { POLL_MS, WORKER_ID, MAX_INFLIGHT, isTitlerEnabled, isAdgenRendererEnabled } = require('../config');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const Ad          = require('../models/Ad');
const Brand       = require('../models/Brand');
const Media       = require('../models/Media');
const CampaignRun = require('../models/CampaignRun');
const alerts      = require('./alertService');
const { adStage } = require('./adStage');
const { renderBrandScriptAndSave, qcAndStampVideoAd } = require('./brandScriptExecutor');
const { classifyRunAdOutcome, buildRunReconciliationUpdate } = require('./campaignRunGuards');
const { startRunHeartbeat } = require('./campaignRunHeartbeat');

const HEARTBEAT_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 25_000;

// AD_HEARTBEAT — see renderer.js's long block for the full reasoning.
// Duplicated intentionally (see header). Same clamp, same 90s ceiling.
const AD_HEARTBEAT_MS_RAW  = Number(process.env.AD_HEARTBEAT_MS || 60_000);
const AD_HEARTBEAT_SAFE_MAX_MS = 90_000;
const AD_HEARTBEAT_MS = Math.min(AD_HEARTBEAT_MS_RAW, AD_HEARTBEAT_SAFE_MAX_MS);
if (AD_HEARTBEAT_MS_RAW > AD_HEARTBEAT_SAFE_MAX_MS) {
  console.error(
    `titler[${WORKER_ID}]: AD_HEARTBEAT_MS=${AD_HEARTBEAT_MS_RAW}ms > safe max ` +
    `${AD_HEARTBEAT_SAFE_MAX_MS}ms — clamping (see renderer.js for reasoning).`
  );
}
// Max lifetime for the per-ad titling heartbeat. Remotion queue wait +
// render + upload + QC has a p99 well under this cap.
const AD_HEARTBEAT_MAX_MS = 60 * 60 * 1000; // 60 min

const state = {
  running: false,
  shuttingDown: false,
  inFlight: new Set(),                 // ad._id strings currently being titled
  heartbeatTimer: null,
  pollTimer: null,
  startedAt: null,
};

function log(msg) { console.log(`titler[${WORKER_ID}]: ${msg}`); }
function warn(msg) { console.warn(`titler[${WORKER_ID}]: ${msg}`); }

function heartbeatOnce() {
  const uptime = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const gate = isTitlerEnabled() ? 'ON' : 'OFF';
  log(`alive — uptime ${uptime}s, inflight ${state.inFlight.size}/${MAX_INFLIGHT}, handoff ${gate}`);
}

// ── atomic claim ───────────────────────────────────────────────────────────
async function claimOne() {
  // GATED ON ADGEN_RENDERER_ENABLED — the SAME cutover flag the renderer's
  // claimOne consults — in addition to ADGEN_TITLER_ENABLED (checked by
  // pollTick() before this is ever called). Two reasons this second gate
  // exists, on top of pollTick()'s own:
  //   1. Defense in depth, same as the renderer — safe for any future call
  //      site, not just today's single caller.
  //   2. ADGEN_RENDERER_ENABLED is the single switch documented to decide
  //      whether adgen or backend is doing ANY rendering work right now.
  //      Titling-in-progress video is part of that work. Without this, an
  //      operator reverting to backend by flipping ADGEN_RENDERER_ENABLED
  //      off — while forgetting ADGEN_TITLER_ENABLED, a separate flag —
  //      would leave this role still claiming and titling fresh masters.
  // Read at CALL TIME, same fail-safe direction as the renderer: unreadable
  // or malformed reads as OFF, so this stands down rather than claims. A
  // row already claimed by THIS worker is unaffected either way — the gate
  // only guards acquiring a NEW claim, never an in-flight one.
  if (!isAdgenRendererEnabled()) return null;

  return await Ad.findOneAndUpdate(
    {
      status:          'rendering',
      veoVideoUrl:     { $ne: null },
      titlingNeeded:   true,
      claimedByWorker: null,
    },
    { $set: { claimedByWorker: WORKER_ID, claimedAt: new Date() } },
    { new: true, sort: { createdAt: 1 } }
  );
}

async function releaseClaim(adId, reason = null) {
  try {
    await Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID },
      { $set: { claimedByWorker: null, claimedAt: null } }
    );
    if (reason) log(`released claim on ${String(adId).slice(-6)} — ${reason}`);
  } catch (err) {
    warn(`release claim failed for ${adId}: ${err.message}`);
  }
}

// ── per-ad titling heartbeat (DUPLICATE OF renderer.js, see header) ────────
function startAdHeartbeat(adId) {
  const openedAt = Date.now();
  let stopped = false;
  const timer = setInterval(() => {
    if (Date.now() - openedAt > AD_HEARTBEAT_MAX_MS) {
      clearInterval(timer);
      stopped = true;
      warn(
        `titling heartbeat for ad=${String(adId).slice(-6)} hit the ` +
        `${Math.round(AD_HEARTBEAT_MAX_MS / 60000)}m cap — stopping liveness updates`
      );
      return;
    }
    Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID, status: 'rendering' },
      { $set: { updatedAt: new Date() } }
    ).catch(() => {});
  }, AD_HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() { if (!stopped) { stopped = true; clearInterval(timer); } }
  };
}

// ── run counter + finalize (DUPLICATE OF renderer.js) ──────────────────────
async function bumpRunCounter(campaignRunIds, field) {
  if (!Array.isArray(campaignRunIds) || !campaignRunIds.length) return;
  const runId = campaignRunIds[campaignRunIds.length - 1];
  try {
    await CampaignRun.updateOne(
      { runId },
      { $inc: { [field]: 1 }, $set: { updatedAt: new Date(), lastHeartbeatAt: new Date() } }
    );
  } catch (err) {
    warn(`bumpRunCounter(${field}) failed for ${runId}: ${err.message}`);
  }
  await maybeFinalizeRun(runId);
}

async function maybeFinalizeRun(runId) {
  if (!runId) return;
  try {
    const claimedAds = await Ad.find({ campaignRunIds: runId })
      .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage titlingNeeded')
      .lean();
    if (!claimedAds.length) return;

    const outcome = classifyRunAdOutcome(claimedAds);
    if (!outcome.isSettled) return;
    if (outcome.needsRetry) return;

    const update = buildRunReconciliationUpdate(outcome, { now: new Date() });
    const res = await CampaignRun.updateOne({ runId, status: 'running' }, update);
    if (res && (res.modifiedCount || res.nModified)) {
      log(`run ${runId} finalized -> done (succeeded=${outcome.succeeded} failed=${outcome.failed})`);
      notifyRunFinalized(runId, outcome);
    }
  } catch (err) {
    warn(`maybeFinalizeRun(${runId}) failed: ${err.message}`);
  }
}

function notifyRunFinalized(runId, outcome) {
  if (!outcome || !outcome.failed) return;
  try {
    const nOk = outcome.succeeded || 0;
    const nFailed = outcome.failed;
    alerts.notifyAsync({
      level: nOk === 0 ? 'error' : 'warn',
      title: nOk === 0
        ? `Campaign run failed entirely — ${nFailed} ad(s)`
        : `Campaign run finished with ${nFailed} failed ad(s)`,
      key: `run-failed:${nOk === 0 ? 'total' : 'partial'}`,
      fields: { run: runId, outcome: `${nOk}✓ / ${nFailed}✗ of ${nOk + nFailed}` }
    });
  } catch (_) { /* alerting must never block finalization */ }
}

// ── settle guard (DUPLICATE OF renderer.js) ────────────────────────────────
// Vision QC already stamped status:'failed' — do NOT resurrect to 'draft'.
// This is the SAME safety property renderer.js documents at length (46
// lines of comment). Read that file's copy before touching this one.
async function settleNonDraftTerminal(ad, label) {
  const shortId = String(ad._id).slice(-6);
  const after = await Ad.findOneAndUpdate(
    { _id: ad._id },
    {
      $set: {
        titlingResumeState: null,
        titlingNeeded:      false,           // titler owns clearing this
        claimedByWorker:    null,
        claimedAt:          null,
        updatedAt:          new Date()
      }
    },
    { new: true, projection: { status: 1 } }
  ).lean();
  const kept = (after && after.status) || 'failed';
  warn(
    `${label} ad=${shortId} kept terminal status='${kept}' ` +
    `(NOT overwritten with draft) — claim released, titling debt cleared`
  );
  return { status: kept, counter: kept === 'failed' ? 'failed' : 'succeeded' };
}

// ── run heartbeat plumbing (DUPLICATE OF renderer.js) ──────────────────────
const runInflight   = new Map();
const runHeartbeats = new Map();
const runDocIdCache = new Map();

function runIdOf(ad) {
  return Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
    : null;
}
function runIsWorking(runId) { return (runInflight.get(runId) || 0) > 0; }

async function acquireRunHeartbeat(runId) {
  const noop = { stop() {} };
  if (!runId) return noop;

  runInflight.set(runId, (runInflight.get(runId) || 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (runInflight.get(runId) || 1) - 1;
    if (n <= 0) {
      runInflight.delete(runId);
      const handle = runHeartbeats.get(runId);
      runHeartbeats.delete(runId);
      runDocIdCache.delete(runId);
      if (handle) handle.stop();
    } else {
      runInflight.set(runId, n);
    }
  };

  try {
    if (!runHeartbeats.has(runId)) {
      let docId = runDocIdCache.get(runId);
      if (!docId) {
        const doc = await CampaignRun.findOne({ runId }).select('_id').lean();
        docId = doc && doc._id;
        if (docId) runDocIdCache.set(runId, docId);
      }
      if (docId && !runHeartbeats.has(runId)) {
        let adIds = [];
        try {
          const claimed = await Ad.find({ campaignRunIds: runId }).select('_id').lean();
          adIds = Array.isArray(claimed) ? claimed.map((a) => a._id) : [];
        } catch (_) {}
        runHeartbeats.set(runId, startRunHeartbeat({
          runDocId:  docId,
          adIds,
          isWorking: () => runIsWorking(runId)
        }));
      }
    }
  } catch (err) {
    warn(`startRunHeartbeat failed for ${runId}: ${err.message}`);
  }

  return { stop: release };
}

// ── titling core ───────────────────────────────────────────────────────────
async function titleAd(ad) {
  const adId = String(ad._id);
  const shortId = adId.slice(-6);
  const t0 = Date.now();
  const isDerive = !!(ad.deriveFromMaster);
  const label = isDerive ? 'DERIVE' : 'MASTER';
  log(`VIDEO ${label} titling start ad=${shortId} format=${ad.platformFormat}`);

  // Load brand (via ad.mediaId → Media.brandId, else ad.brandId).
  const sourceMedia = ad.mediaId ? await Media.findById(ad.mediaId).select('brandId').lean() : null;
  const brandDoc = sourceMedia?.brandId
    ? await Brand.findById(sourceMedia.brandId).lean()
    : (ad.brandId ? await Brand.findById(ad.brandId).lean() : null);

  // For derives, veoReferenceImages must come from the master (not the
  // derive's own record — the inherit-write on renderer.js copies only
  // what's needed to ship/title, not the seed list). See renderer.js's
  // long comment for the full reasoning.
  let masterForQc = null;
  if (isDerive) {
    masterForQc = await Ad.findOne({
      campaignId:     ad.campaignId,
      productId:      ad.productId,
      platformFormat: ad.deriveFromMaster,
      kind:           'video',
      _id:            { $ne: ad._id },
      $and: [
        { $or: [{ deriveFromMaster: null }, { deriveFromMaster: { $exists: false } }] },
        { $or: [{ funnelStage: null },       { funnelStage: { $exists: false } }] }
      ]
    }).sort({ generatedAt: -1 }).lean();
  }

  // Re-read the ad after any potential renderer stamps landed.
  const adFinal = await Ad.findById(adId).lean();

  if (brandDoc) {
    adStage(adId, `titling ${ad.aspectRatio || '9:16'} (${label.toLowerCase()})`);
    const beat = startAdHeartbeat(adId);
    try {
      try {
        const chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
        if (chromeOut?.skipped) {
          log(`VIDEO ${label} no-chrome ad=${shortId} — shipping master`);
        }
      } catch (scriptErr) {
        // scriptErr.titlingResumable is stamped by brandScriptExecutor's
        // stampTitlingFailureAndThrow for OOM, timeout, AND a generic child
        // failure/exception (bounded by TITLING_ATTEMPTS_MAX) — was OOM-only
        // (isRemotionChildOomError). This file duplicates renderer.js's
        // titling call site (see this file's own header: "If you edit one
        // copy, edit the other") — renderer.js's video derive/master arms
        // were updated to the same flag; this arm had been missed, which
        // meant a resumable timeout/generic titling failure on the titler
        // role fell through to processAd's catch below and got
        // double-counted as a genuine 'failed' (bumpRunCounter) even though
        // the Ad row itself stays recoverable (its write is owner-scoped and
        // no-ops once the stamp has cleared claimedByWorker).
        if (scriptErr && scriptErr.titlingResumable) {
          // brandScriptExecutor already stamped draft + titlingResumeState:'pending'.
          // Also clear titlingNeeded so we don't loop-claim (resume path takes
          // over from here — same shape as renderer's resumable branch).
          await Ad.updateOne(
            { _id: ad._id, claimedByWorker: WORKER_ID },
            { $set: { titlingNeeded: false, claimedByWorker: null, claimedAt: null } }
          );
          warn(`VIDEO ${label} titling ${scriptErr.titlingFailureKind || 'failed'} ad=${shortId} — paid asset kept, titling left pending`);
          return { earlyReturn: true };
        }
        throw scriptErr;
      }
    } finally {
      beat.stop();
    }
  } else {
    // NO BRAND RESOLVED — same fallback the renderer uses. Vision QC only,
    // no titling. See renderer.js's long comments for the reasoning
    // (veoReferenceImages must come from `master` for derives).
    const beat = startAdHeartbeat(adId);
    try {
      const qcAd = isDerive && masterForQc
        ? {
            ...adFinal,
            veoReferenceImages: masterForQc.veoReferenceImages || [],
            videoDurationSec:   masterForQc.videoDurationSec || adFinal.videoDurationSec || null
          }
        : adFinal;
      const deliveredUrl = adFinal.renderUrl || adFinal.veoVideoUrl;
      await qcAndStampVideoAd({ ad: qcAd, deliveredUrl });
    } finally {
      beat.stop();
    }
  }

  // Terminal — clear titling debt + claim + titlingNeeded. GUARDED: titling
  // may have already stamped status:'failed' (vision QC).
  const promoted = await Ad.updateOne(
    { _id: ad._id, status: { $in: ['rendering', 'draft'] } },
    {
      $set: {
        status:             'draft',
        titlingResumeState: null,
        titlingNeeded:      false,
        claimedByWorker:    null,
        claimedAt:          null,
        updatedAt:          new Date()
      }
    }
  );
  const settled = promoted.matchedCount
    ? { status: 'draft', counter: 'succeeded' }
    : await settleNonDraftTerminal(ad, `VIDEO ${label}`);
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`VIDEO ${label} done ad=${shortId} wall=${wallSec}s status=${settled.status}`);
  await bumpRunCounter(ad.campaignRunIds, settled.counter);
  return { settled };
}

// End-to-end for one claimed ad.
async function processAd(ad) {
  const runHeartbeat = await acquireRunHeartbeat(runIdOf(ad));
  const adKey = String(ad._id);
  state.inFlight.add(adKey);
  try {
    try {
      await titleAd(ad);
    } catch (err) {
      const shortId = adKey.slice(-6);
      warn(`titling failed ad=${shortId}: ${err.message}`);
      // Terminal-fail with owner-scoped write. If claim already lost, no-op.
      try {
        await Ad.updateOne(
          { _id: ad._id, claimedByWorker: WORKER_ID },
          {
            $set: {
              status:          'failed',
              titlingNeeded:   false,
              claimedByWorker: null,
              claimedAt:       null,
              updatedAt:       new Date(),
              renderError: {
                message: (err && err.message) ? String(err.message).slice(0, 500) : 'titler processAd threw',
                stage:   'titler',
                at:      new Date()
              }
            }
          }
        );
      } catch (writeErr) {
        warn(`terminal-fail write failed for ${adKey.slice(-6)}: ${writeErr.message}`);
      }
      try {
        await bumpRunCounter(ad.campaignRunIds, 'failed');
      } catch (bumpErr) {
        warn(`bump-fail write failed for ${adKey.slice(-6)}: ${bumpErr.message}`);
      }
      try {
        alerts.notifyAsync({
          level: 'error',
          title: `titler render failure`,
          key:   `titler-render-failure:${ad.platformFormat || 'unknown'}`,
          fields: {
            ad:     String(ad._id),
            format: ad.platformFormat,
            error:  err && err.message ? String(err.message).slice(0, 200) : String(err)
          }
        });
      } catch (_) {}
    }
  } finally {
    state.inFlight.delete(adKey);
    try { runHeartbeat.stop(); } catch (_) {}
  }
}

// ── poll ──────────────────────────────────────────────────────────────────
async function pollTick() {
  if (state.shuttingDown) return;
  if (!isTitlerEnabled()) return;
  if (state.inFlight.size >= MAX_INFLIGHT) return;

  try {
    while (!state.shuttingDown && state.inFlight.size < MAX_INFLIGHT) {
      const ad = await claimOne();
      if (!ad) break;
      // Unawaited — burst-claim, process concurrently.
      processAd(ad).catch((err) => warn(`unhandled processAd error: ${err.message}`));
    }
    resetReconnectAttempts();
  } catch (err) {
    if (isStaleTopologyError(err)) {
      warn(`stale topology (${err.message}) — reconnecting`);
      await reconnectAfterStaleTopology().catch((e) => warn(`reconnect failed: ${e.message}`));
      return;
    }
    warn(`poll error: ${err.message}`);
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────
async function run() {
  if (state.running) throw new Error('titler.run called twice');
  state.running = true;
  state.startedAt = Date.now();
  log(`starting — poll interval ${POLL_MS}ms, max-inflight ${MAX_INFLIGHT}, handoff gate ${isTitlerEnabled() ? 'ON (claiming)' : 'OFF (idle)'}`);

  heartbeatOnce();
  state.heartbeatTimer = setInterval(heartbeatOnce, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();

  await pollTick();
  state.pollTimer = setInterval(pollTick, POLL_MS);
  state.pollTimer.unref?.();
}

async function shutdown() {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log(`shutting down — inflight=${state.inFlight.size}, drain up to ${SHUTDOWN_DRAIN_MS}ms`);

  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);

  const drainDeadline = Date.now() + SHUTDOWN_DRAIN_MS;
  while (state.inFlight.size > 0 && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (state.inFlight.size === 0) {
    log('clean drain in 0ms — no forced release needed');
    return;
  }

  // Force-release remaining claims so a peer titler picks them up.
  const remaining = [...state.inFlight];
  log(`drain window exhausted — force-releasing ${remaining.length} claim(s) for peer pickup`);
  await Promise.all(remaining.map((id) => releaseClaim(id, 'sigterm-drain-timeout')));
}

module.exports = { run, shutdown };
