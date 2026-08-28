'use strict';
// renderer role — Phase 1b real static path.
//
// Replaces the Phase 1a mockRender with the actual static ad-gen pipeline:
//   1. Atomic claim (unchanged from Phase 1a — proven working)
//   2. Load Ad + concept + brand + product + media
//   3. Derive LayoutInputArtifact (layoutInputService.buildLayoutInput)
//   4. Submit to Atlas gpt-image-2/edit + Sharp crop + Cloudinary upload +
//      final Ad stamp (directImageRenderService.renderDirectImage)
//   5. Update CampaignRun succeeded/failed counters
//   6. Release claim + move on
//
// Money invariants preserved by using the SAME functions backend uses:
//   - Ad.imageGeneration.predictionId stamped inside atlasImageService.submitAndPoll
//   - CostLog rows written by atlasImageService (recordFlatCost, reconcileCost)
//   - Atomic claim via findOneAndUpdate — same shape as backend claimAdsForRun
//
// Video path (renderRoute:'veo') is NOT wired here — Phase 1c. The claim
// filter still permits video masters/derives to be claimed, but the
// dispatch below throws "video not yet supported" and releases the claim.
// A concurrent backend deploy with ADGEN_RENDERER_ENABLED=true would
// therefore only cover the static half. Leave the flag off in prod until
// Phase 1c ships.

const { POLL_MS, WORKER_ID, MAX_INFLIGHT, isAdgenRendererEnabled, isTitlerEnabled } = require('../config');
const { concurrency } = require('./concurrency');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const Ad          = require('../models/Ad');
const Brand       = require('../models/Brand');
const Media       = require('../models/Media');
const CampaignRun = require('../models/CampaignRun');
const directImage = require('./directImageRenderService');
const {
  buildLayoutInput,
  resolveQuoteAssemblyOptions,
  applyStagedQuotePick
} = require('./layoutInputService');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const crypto = require('crypto');
const { adStage, noteRenderIssue } = require('./adStage');
const { childTailsFrom } = require('./renderErrorFields');
// Already required by 6 other adgen services (adVisionQcService,
// aiCreativeDirectorService, bootRecoveryService, campaignAdsGenerationService,
// costTracker, metaApiVersion) — this file had ZERO references until now. See
// the "Slack alerting" section below for why and what it ports.
const alerts = require('./alertService');

// Per-run Slack thread (runFeedService). Backend's startRun created the
// parent on CampaignRun.slackFeed; this process must ATTACH to that ts,
// never post a second parent. Fire-and-forget, never awaited — a Slack
// outage cannot fail a billed render (same isolation as notifyRenderFailure).
function feedSourceFor(ad) {
  return ad && ad.renderRoute === 'veo'
    ? 'adgen-renderer (video)'
    : 'adgen-renderer (static)';
}
function noteFeed(ad, stage, extra) {
  try {
    const runFeed = require('./runFeedService');
    const source = (extra && extra.source) || feedSourceFor(ad);
    runFeed.attachAd(ad, { source });
    if (stage) adStage(ad && ad._id, stage);
  } catch (err) {
    try { console.warn(`renderer[${WORKER_ID}]: runFeed note failed: ${err && err.message}`); }
    catch (_) { /* alerting must never fail generation */ }
  }
}
function noteFeedEvent(ad, stage, extra) {
  try {
    const runFeed = require('./runFeedService');
    const source = (extra && extra.source) || feedSourceFor(ad);
    runFeed.attachAd(ad, { source });
    const runId = Array.isArray(ad && ad.campaignRunIds) && ad.campaignRunIds.length
      ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
      : null;
    if (!runId || !stage) return;
    runFeed.noteEvent(runId, stage, {
      adId: ad && ad._id != null ? String(ad._id) : null,
      source,
      template: ad && ad.template,
      aspectRatio: ad && ad.aspectRatio,
      platformFormat: ad && ad.platformFormat,
      mediaId: ad && ad.mediaId,
      ...(extra || {})
    });
  } catch (err) {
    try { console.warn(`renderer[${WORKER_ID}]: runFeed event failed: ${err && err.message}`); }
    catch (_) { /* alerting must never fail generation */ }
  }
}

// Extracted from backend renderService.persistStage's `copy` field builder.
// Preferred: renderedCopy from directImage output (post-density-budget
// truth) — the actual strings the model was told to typeset. Fallback:
// layoutInput.copy (pre-render marketing copy). See CLAUDE.md § 5 for
// why the two can drift.
function extractCopySnapshot(input, rendered = null) {
  const price = input?.product?.price;
  const priceStr = typeof price === 'string' ? price
                 : typeof price === 'number' ? `$${price.toFixed(2)}`
                 : (price?.display || '');
  const useRendered = rendered && typeof rendered === 'object';
  return {
    headline:     useRendered ? (rendered.headline || '') : (input?.copy?.headline                    || ''),
    cta_text:     useRendered ? (rendered.cta_text  || '') : (input?.cta?.text                         || ''),
    quote:        useRendered ? (rendered.quote     || '') : (input?.social_proof?.primary_quote?.text || ''),
    productName:  input?.product?.name                     || '',
    productPrice: priceStr
  };
}

// Extracted from renderService.uploadStage. Same Cloudinary folder / publicId
// shape backend uses — so re-renders of the same ad OVERWRITE (money invariant:
// one identity digest = one Cloudinary asset) rather than accumulate orphans.
async function uploadRenderToCloudinary(renderOutput, ctx) {
  const folder = `ads/${ctx.brandId}/${ctx.campaignId}`;
  const shortMedia = String(ctx.mediaId).slice(-8);
  const shortDigest = (ctx.identityDigest || '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
  const publicId = `${ctx.aspectRatio.replace(/[:.]/g, '_')}-${ctx.template}-${shortMedia}-${shortDigest}`;
  const result = await uploadBufferToCloudinary(renderOutput.buffer, {
    folder,
    publicId,
    resourceType: 'image',
    overwrite:    true
  });
  return {
    cloudinaryPublicId: result.public_id,
    renderUrl:          result.secure_url || result.url,
    posterUrl:          null,
    bytes:              result.bytes  || renderOutput.bytes,
    width:              result.width  || renderOutput.width,
    height:             result.height || renderOutput.height,
    durationMs:         null
  };
}
const { resolveDeriveFromMaster } = require('./campaignAdsGenerationService');
const { classifyRunAdOutcome, buildRunReconciliationUpdate } = require('./campaignRunGuards');
// CampaignRun liveness heartbeat. IMPORTED, never re-implemented inline —
// CLAUDE.md records production ReferenceErrors from call sites that used a
// helper the file never imported. The module itself is vendored and correct;
// it was never required from this render loop, which is why a live run's
// lastHeartbeatAt stays null until an ad settles.
const { startRunHeartbeat } = require('./campaignRunHeartbeat');
const atlasVideo = require('./atlasVideoService');
const { renderBrandScriptAndSave } = require('./brandScriptExecutor');
// videoRouter exports `prepareStoryboard`; the backend's routes/ads.js binds it
// under the local alias `veoPrepareStoryboard`. Phase 1c ported the CALL from
// there but kept the alias on the require(), destructuring a key that does not
// exist — so this was `undefined` and every first-time video master threw
// "veoPrepareStoryboard is not a function". Alias explicitly instead.
const { prepareStoryboard: veoPrepareStoryboard } = require('./videoRouter');

// Bounded wait for a derive-only ad's sibling master to complete. Kept
// SHORT (60s default) so an unwaiting derive releases its worker slot
// quickly for another ad — peer workers pick it up when the master
// lands. A backend-style 12-min wait would hog MAX_INFLIGHT slots and
// starve throughput. deriveWaitAttempts bounds infinite requeue loops.
const DERIVE_MASTER_WAIT_MS    = Number(process.env.DERIVE_MASTER_WAIT_MS    || 60_000);  // 60s
const DERIVE_MASTER_POLL_MS    = Number(process.env.DERIVE_MASTER_POLL_MS    || 5_000);   // 5s poll
const MAX_DERIVE_WAIT_ATTEMPTS = Number(process.env.MAX_DERIVE_WAIT_ATTEMPTS || 60);      // 60 × ~60s = 60 min ceiling per derive

// ── PER-AD TITLING HEARTBEAT ──────────────────────────────────────────────
// Ported from liquidretail_backend routes/ads.js:2704. Read that, and
// services/campaignRunHeartbeat.js, before changing anything here — the
// gating and the cap below are load-bearing, not ceremony.
//
// WHY IT EXISTS. models/Ad.js is `timestamps: false`, so `updatedAt` only
// moves when written explicitly, and claimOne() writes only claimedByWorker
// /claimedAt. During the Atlas Omni poll we are fine — pollPrediction calls
// adStage every ~5s and that $sets updatedAt. But after the master persists
// we enter Remotion titling, which queues behind REMOTION_QUEUE_CONCURRENCY
// with NO Ad write while it waits. Backend's worker runs bootRecoveryService
// against this SAME collection, ungated on ADGEN_RENDERER_ENABLED, selecting
// { status:'rendering', updatedAt < now-5min, HAS_RECEIPT } — so a perfectly
// healthy adgen titling job becomes eligible to be "recovered" out from
// under us, after which backend web's titlingResumeService titles the same
// paid master concurrently. Two Remotion renders, one ~$0.90 asset, both
// writing renderUrl.
//
// The OOM fix made this MORE likely, not less: REMOTION_QUEUE_CONCURRENCY
// went 4 -> 2 (measured 1.97 GiB/slot, not the committed ~0.9), so per-ad
// queue wait is longer and the 5-minute window is easier to reach.
//
// bootRecovery's own comment (backend services/bootRecoveryService.js:34-36)
// says the quiet part: "renderOne heartbeats updatedAt every 60s, so an ad
// untouched for RESUME_STALE_MIN minutes has missed several beats and is not
// being actively rendered by anyone." That calibration assumes a 60s beat
// EXISTS. adgen has never had one, so RESUME_STALE_MIN has been measuring
// nothing for every adgen row — this does not just close a steal window, it
// makes an existing safety margin mean what its own comment says it means.
const AD_HEARTBEAT_MS_RAW = Number(process.env.AD_HEARTBEAT_MS || 60_000);   // 60s, as backend

// SAFETY CLAMP ON THE INTERVAL ITSELF — CLAMP, not fail-boot, and not a
// mere warn. Adversarial review (2026-08-24, second pass) found the earlier
// warn-only version could be silenced by wrapping its condition in dead code
// (`if (false && ...)`) while the unsafe value still flowed through — a
// presence check on the warn text proved nothing about the actual interval
// used. Clamping the VALUE itself has no boolean gate to defeat: as long as
// this statement exists at all, AD_HEARTBEAT_MS can never exceed the safe
// ceiling, regardless of what happens to any warning around it.
//
// Why clamp instead of the fail-boot pattern src/config.js uses for
// ADGEN_ROLE: ADGEN_ROLE has no safe default, so refusing to boot is the
// only honest option there. AD_HEARTBEAT_MS has a perfectly good default —
// failing to boot over a misconfigured interval would take the entire
// renderer down, a strictly worse outage than one stolen titling job. There
// is also no legitimate reason to ever set this interval at or above the
// staleness window it exists to defeat, so clamping overrides no real
// operator intent.
//
// 90s is 1/3.3 of backend's RESUME_STALE_MIN default (5min/300_000ms) —
// inside the "five missed heartbeats" margin bootRecoveryService's own
// comment describes.
const AD_HEARTBEAT_SAFE_MAX_MS = 90_000;
if (AD_HEARTBEAT_MS_RAW > AD_HEARTBEAT_SAFE_MAX_MS) {
  console.error(
    `renderer[${WORKER_ID}]: AD_HEARTBEAT_MS=${AD_HEARTBEAT_MS_RAW}ms is above backend ` +
    `RESUME_STALE_MIN (default 5min) — CLAMPING to ${AD_HEARTBEAT_SAFE_MAX_MS}ms so a live ` +
    'titling job cannot be recovered out from under this render. Fix the env var — this clamp ' +
    'keeps the renderer running safely, it does not fix the misconfiguration.'
  );
}
const AD_HEARTBEAT_MS = Math.min(AD_HEARTBEAT_MS_RAW, AD_HEARTBEAT_SAFE_MAX_MS);

// TOTAL LIFETIME CAP — mandatory, and the hazard here is WORSE than the run
// case campaignRunHeartbeat guards. An uncapped beat on a Remotion render
// that never settles keeps this row out of bootRecoveryService's reach
// FOREVER, and the thing stranded is a master we have already paid ~$0.90
// for. Past the cap the beat stops, updatedAt goes stale, and recovery
// behaves exactly as it did before this existed. Adversarial review caught
// the absence of the equivalent cap in the run heartbeat; not repeating it.
//
// DERIVED FROM LIVE CONCURRENCY, not hardcoded — REMOTION_QUEUE_CONCURRENCY
// was 4 before the 2026-08-21 OOM and is 2 today; a future re-raise (more RAM)
// or another drop must not silently invalidate a number baked in at review
// time. Worst-case queue depth is MAX_INFLIGHT ads all queued behind
// REMOTION_QUEUE_CONCURRENCY titling slots, at a MEASURED single-render time
// of 76s (concurrency.js REMOTION_QUEUE_CONCURRENCY 'why'). 3x that for
// headroom — 76s is one measurement, not a distribution, and 1080p render
// time is not guaranteed linear in queue depth if memory pressure forces
// swapping under concurrency.
//
// STATE THE REAL NUMBER, do not let the floor read as the size. At today's
// live values (MAX_INFLIGHT=32, REMOTION_QUEUE_CONCURRENCY=2) this resolves
// to 3 * ceil(32/2) * 76_000ms = 3,648,000ms = 60.8 MINUTES. The 10-minute
// floor NEVER BINDS at these values — the derived term is 6x larger — it
// only matters if concurrency is raised enough to shrink the formula under
// it. Do not lower this to "something that feels right" (10min, 20min): the
// cap must outlast a LEGITIMATE worst-case queue wait, which really is
// ceil(MAX_INFLIGHT / REMOTION_QUEUE_CONCURRENCY) renders deep, or the cap
// fires mid-legitimate-wait and hands a healthy ad to bootRecovery — the
// exact bug this file exists to fix, reintroduced by a more reassuring
// number. The design self-corrects the direction that matters: the cap is
// inversely proportional to REMOTION_QUEUE_CONCURRENCY, so it is 60.8min
// today only BECAUSE that knob was dropped 4 -> 2 after the OOM; restoring 4
// halves it to ~30min automatically. A hung render on an otherwise-idle box
// looks alive and holds a paid master untitled for up to 60.8 minutes before
// bootRecovery can even consider it. Left far below the 4h run cap so the
// two heartbeats can never disagree about a wedged render — that does not
// make 60.8min small, only smaller than 4h.
const REMOTION_RENDER_MS_MEASURED = 76_000;
const AD_HEARTBEAT_MAX_MS = Number(process.env.AD_HEARTBEAT_MAX_MS) || Math.max(
  10 * 60 * 1000,
  3 * Math.ceil(MAX_INFLIGHT / concurrency.REMOTION_QUEUE_CONCURRENCY) * REMOTION_RENDER_MS_MEASURED
);

// ACCEPTED RESIDUAL — stopping the beat does not stop the render, and does
// NOT release the claim. When the cap fires we stop telling Mongo about this
// row; Remotion keeps running in THIS process, and claimedByWorker stays set
// on purpose (see the divergence note below) so no OTHER adgen worker can
// claim it and resubmit a second paid Omni master. What we give up is only
// the protection against BACKEND recovery: if the render is still genuinely
// alive past the cap (not hung, just slow — the swapping/memory-pressure
// case above), the row now reads as abandoned to bootRecoveryService, which
// can hand it to titlingResumeService for a SECOND Remotion render on the
// same paid asset while ours is still in-process.
//
// THIS IS NOT THE SAME HAZARD CLASS campaignRunHeartbeat's 4h cap accepts,
// and treating it as directly equivalent overstates how settled this is.
// Stopping a RUN beat lets the reaper reclaim a whole batch — coarse, but a
// clean handoff. Stopping THIS beat risks a live dual-title race on one
// asset, for however long the render keeps running past the cap —
// CONCRETELY: two concurrent Remotion renders of the same clip on a box
// that has already OOM-killed twice today at ~2 GiB/slot. That is a memory
// event, not merely wasted CPU — say that plainly rather than leaning on
// "different hazard class" as an abstraction. Both traded away an uncapped
// beat's worse failure (a paid master stranded out of recovery's reach
// forever) for a bounded, smaller one — that part IS the same shape — but
// the smaller ones are not the same size or the same kind of smaller.
// Actually cancelling the in-flight Remotion job at the cap would close
// this properly; that reaches into remotionRenderService's queue and
// is out of scope here. The cap's calibration above is the mitigation
// available at this layer — keep it comfortably above measured render time,
// not tight, and do not read "60.8 minutes" as "effectively never happens."

/**
 * Beat one claimed ad's `updatedAt` while THIS worker is titling it.
 * Returns { stop } — call it in a finally; a double stop is a no-op.
 *
 * WRITES ONLY updatedAt. Never status, never titlingResumeState, never a
 * counter — same rule as campaignRunHeartbeat, for the same reason: a
 * heartbeat that touched outcome state would tell an operator work happened
 * that did not.
 *
 * DELIBERATE DIVERGENCE FROM THE PORTED SHAPE — the claimedByWorker term.
 * Backend's beat cannot express it because backend never sets that field;
 * renderer.js is the only writer of it in either repo. Requiring it here
 * means that if we somehow no longer own the claim we STOP beating, instead
 * of keeping another owner's row artificially alive and out of reach of the
 * recovery that should now have it. This is an improvement on the original,
 * not drift — do not "fix" it back when diffing the two copies.
 */
function startAdHeartbeat(adId) {
  const openedAt = Date.now();
  let stopped = false;
  const timer = setInterval(() => {
    // The cap. See AD_HEARTBEAT_MAX_MS.
    if (Date.now() - openedAt > AD_HEARTBEAT_MAX_MS) {
      clearInterval(timer);
      stopped = true;
      console.warn(
        `renderer[${WORKER_ID}]: titling heartbeat for ad=${String(adId).slice(-6)} hit the ` +
        `${Math.round(AD_HEARTBEAT_MAX_MS / 60000)}m cap — stopping liveness updates. Claim stays ` +
        `held (claimedByWorker unchanged) so no other adgen worker resubmits; backend recovery ` +
        `can now consider this row abandoned if the render is genuinely still running`
      );
      return;
    }
    Ad.updateOne(
      {
        _id: adId,
        claimedByWorker: WORKER_ID,
        $or: [
          { status: 'rendering' },
          { status: 'draft', titlingResumeState: 'claimed' }
        ]
      },
      { $set: { updatedAt: new Date() } }
    ).catch(() => {});   // a missed beat is survivable; the next one lands
  }, AD_HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}

// ── Slack alerting — ports the backend's now-dead call sites ───────────────
//
// WHY THIS EXISTS: when ADGEN_RENDERER_ENABLED is true, backend's own
// runRenderLoop (routes/ads.js) returns before it ever reaches its own
// per-run Slack alert, the CampaignRun heartbeat, or any of its four
// alertService call sites (~2113 run-completion, ~2242 derive-wait backup,
// ~3132 video-unsettled-at-timeout, ~3168 video-failed). This renderer does
// the actual work now but never picked up the alerting that went with it —
// the crash path here only ever `console.warn`ed. Measured consequence:
// adgen-renderer was OOM-killed twice on 2026-08-24, stranding 12 ads
// mid-titling, and a text search for "alert" across that service's
// full-day logs returns zero rows.
//
// Every function below is a PURE ADDITION next to the render/claim logic —
// none of them changes a $set object or what gets persisted to Mongo.
// renderer.js's terminal writes are owned by a peer branch
// (fix/vision-qc-invariant); this file stays out of that. alertService
// itself never throws and every call here is fire-and-forget
// (notifyAsync), so a Slack outage or a bad channel id can never affect a
// render.

// TWO windows. They measure two different clocks, and an orphan is BOTH.
//
// claimedAt is stamped ONCE at claimOne() and never refreshed — the
// titling heartbeat writes updatedAt only (#9). CLAIM_STALE_MIN is
// therefore "how old is this claim", not "has this job gone quiet".
// 20 minutes is still the right bound for that first question: generous
// enough to cover Atlas's 10-minute poll budget plus Remotion, without
// leaving a never-started claim invisible for the life of the next
// instance. Kept in the orphan filter on purpose: claimOne() does not
// write updatedAt (Ad.timestamps is false), so a freshly claimed row can
// carry a pre-claim stale updatedAt. Without this gate a sibling that
// just claimed a backlog row would page on our next boot, before its
// first beat. A claim that died before the first beat still pages, once
// claimedAt itself is this old.
const CLAIM_STALE_MIN = Math.max(1, parseInt(process.env.ADGEN_CLAIM_STALE_MIN, 10) || 20);

// updatedAt IS refreshed, at least every AD_HEARTBEAT_MS (clamped to 90s
// by #11). HEARTBEAT_STALE_MIN is "has the beat gone quiet", and it is
// deliberately NOT 20 minutes — 20 minutes of silence on a 60-90s beat
// is 13–20 missed beats, which would leave a dead paid master unpaged
// long after bootRecovery already treats it as abandoned.
//
// Same env, same default, same meaning as bootRecoveryService's
// RESUME_STALE_MIN: 5 minutes = 5 missed 60s beats, or 3.3 missed beats
// at the 90s clamp (the heartbeat's own comment already treats 90s as
// inside that "five missed heartbeats" margin). A live job that beats
// every 60-90s can never look stale here; a worker that died mid-titling
// looks stale within minutes.
//
// Floor at 3 minutes even if RESUME_STALE_MIN is set to 1: 3 = two
// missed clamped 90s beats plus 30s. Without the floor a legal
// RESUME_STALE_MIN=1 would make a live job at the 90s clamp look stale
// (90s > 60s) and re-open a false page on the pager. Recovery being
// mis-tuned must not teach Slack to cry wolf.
const HEARTBEAT_STALE_MIN = Math.max(
  3,
  Math.max(1, parseInt(process.env.RESUME_STALE_MIN, 10) || 5)
);

/**
 * A single ad's render failing — called from processAd's catch. Mirrors
 * backend routes/ads.js's two dead video alerts for the video route
 * (~3132 unsettled-at-timeout warn, ~3168 video-failed error), and for the
 * static route reuses the classification directImageRenderService ALREADY
 * stamps on every throw (`err.alertLevel` / `err.alertKey` — e.g. 'fatal' +
 * 'direct-image:no-credentials' for missing Atlas creds; see its
 * taggedError()). That is the exact convention backend's
 * services/renderService.js used to consume at ITS OWN dead call site —
 * deleted from this repo entirely (CLAUDE.md "Layout difference": adgen
 * calls directImageRenderService directly, bypassing renderService.js) —
 * so reusing the tag here revives an existing classification rather than
 * inventing a new one.
 */
function notifyRenderFailure(ad, err) {
  try {
    const adId  = String(ad._id);
    const runId = Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
      ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
      : null;
    const msg = String((err && err.message) || err || 'unknown error');
    const commonFields = {
      ad:    adId,
      run:   runId,
      brand: ad.brandId ? String(ad.brandId) : null
    };
    // Slack field values clip to 200 chars. Child stderr belongs in `detail`
    // (fenced block, ~4 KiB) — a fields.stderrTail slice would keep the HEAD
    // of a throw-first stack and then get clipped again.
    const stderrDetail = (childTailsFrom(err).stderrTail || '').slice(0, 4000) || null;

    if (ad.renderRoute === 'veo') {
      if (err && err.unsettledAtTimeout) {
        alerts.notifyAsync({
          level:  'warn',
          title:  'Video master unsettled at poll timeout — awaiting reconciliation',
          key:    `video-unsettled:${msg.slice(0, 60)}`,
          fields: { ...commonFields, predictionId: err.predictionId || null, error: msg.slice(0, 300) }
        });
      } else {
        alerts.notifyAsync({
          level:  'error',
          title:  'Video generation failed',
          key:    `video-failed:${msg.slice(0, 60)}`,
          fields: { ...commonFields, error: msg.slice(0, 300) },
          detail: stderrDetail
        });
      }
      return;
    }

    // Static (html_gen) route — and the defensive "unknown renderRoute"
    // throw from processAd's dispatch, which has no route-specific class
    // of its own and falls into the same bucket as any other static fault.
    //
    // unsettledAtResume mirrors the video branch above: a resumed
    // prediction whose poll came back ambiguous is NOT a confirmed
    // failure — mayResubmit already refused to spend again, and the claim
    // is about to be released with status:'rendering' intact for a future
    // resume/recovery, not stamped 'failed'. Alerting it as "render
    // failed" would misreport a still-pending outcome as a confirmed one.
    if (err && err.unsettledAtResume) {
      alerts.notifyAsync({
        level:  'warn',
        title:  'Static ad resume unsettled — awaiting reconciliation',
        key:    `static-unsettled:${msg.slice(0, 60)}`,
        fields: { ...commonFields, predictionId: err.predictionId || null, error: msg.slice(0, 300) }
      });
    } else {
      alerts.notifyAsync({
        level:  (err && err.alertLevel) || 'error',
        title:  'Static ad render failed (direct overlay)',
        key:    (err && err.alertKey) || 'direct-image:render-failed',
        fields: { ...commonFields, error: msg.slice(0, 300) },
        detail: (err && err.stack) || null
      });
    }
  } catch (_) {
    // Alerting must never fail the failure path it is reporting on.
  }
}

/**
 * One Slack notice per derive-wait BACKUP EPISODE — not one per ad, not one
 * per poll. Mirrors backend routes/ads.js's notifyDeriveWaitBackup (~2242).
 * "Not one per poll" is enforced entirely by alertService's own key-based
 * dedupe (ALERT_DEDUPE_WINDOW_MIN), keyed on the sibling MASTER so every
 * derivative waiting on the same master folds into one message rather than
 * spamming or going silent.
 *
 * Adapted to this service's shape: adgen's derive wait is a short (60s)
 * poll-then-requeue cycle, not backend's 12-minute in-process hold, and
 * this repo has no `othersQueued` context query — omitted rather than
 * approximated with a second query that could drift from what actually
 * decides "derives from this master" (resolveDeriveFromMaster).
 */
function notifyDeriveWaitBackup(ad, master, waitAttempt) {
  try {
    const masterId = master && master._id ? String(master._id) : null;
    const masterAgeMs = master && master.updatedAt
      ? Date.now() - new Date(master.updatedAt).getTime()
      : null;
    // Sibling-master "stuck" is a conservative ceiling on updatedAt silence
    // — CLAIM_STALE_MIN (20), not the tighter heartbeat bound the boot
    // orphan scan uses. A derive waiting on a live, heartbeating master
    // will not escalate: master.updatedAt is what this reads, and a beat
    // every 60-90s keeps masterAgeMs well under 20 minutes. The orphan
    // scan (below) is a different question and uses both clocks.
    const masterLooksStuck = !!master && master.status === 'rendering'
      && masterAgeMs != null && masterAgeMs > CLAIM_STALE_MIN * 60 * 1000;
    const escalated = masterLooksStuck || waitAttempt > MAX_DERIVE_WAIT_ATTEMPTS;
    const fmtMin = (ms) => `${Math.max(1, Math.round(ms / 60000))}m`;

    alerts.notifyAsync({
      level: escalated ? 'error' : 'warn',
      title: masterLooksStuck
        ? 'Derive-wait: sibling master looks STUCK, not just backed up'
        : 'Derive-wait backup: sibling master still in flight',
      key: `derive-wait-backup:${masterId || String(ad._id)}`,
      fields: {
        ad:           String(ad._id),
        master:       masterId,
        masterStatus: master ? master.status : 'not-found-yet',
        masterAge:    masterAgeMs != null ? fmtMin(masterAgeMs) : 'unknown',
        attempt:      waitAttempt
      }
    });
  } catch (_) {
    // Alerting must never block the derive-wait retry path.
  }
}

/**
 * A CampaignRun reaching its terminal 'done' state with losses — mirrors
 * backend routes/ads.js's run-completion alert (~2113), which fires at the
 * end of runRenderLoop and is therefore unreachable once
 * ADGEN_RENDERER_ENABLED short-circuits that loop. maybeFinalizeRun (above)
 * is the only place in this service that drives a CampaignRun to 'done',
 * so it is the only correct place to fire the replacement. Silent when
 * nothing failed, matching backend's own `nFailed > 0` gate.
 */
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
      fields: {
        run:     runId,
        outcome: `${nOk}✓ / ${nFailed}✗ of ${nOk + nFailed}`
      }
    });
  } catch (_) {
    // Alerting must never block run finalization.
  }
}

/**
 * Boot-time visibility for ads orphaned by a SIGKILL'd renderer. SIGKILL is
 * uncatchable — nothing can alert from INSIDE a dying process — so this is
 * the only way a silent process death ever becomes visible without a human
 * reading Render logs by hand: the NEXT process notices on its own boot
 * (immediate scan for already-cold rows, plus one delayed rescan after
 * HEARTBEAT_STALE_MIN + one clamped beat — a predecessor that died seconds
 * before we started still looks alive until that window elapses).
 *
 * READ-ONLY. Deliberately does not touch claimedByWorker/status — deciding
 * whether to release or resume a stranded claim is a real remediation
 * question (bootRecoveryService is the adjacent, receipt-based mechanism
 * for exactly this, but it is not wired into this repo's boot path either —
 * see CLAUDE.md "What this repo does not do (yet)" — and wiring it is a
 * separate, larger change than an alerting fix). This function only makes
 * the orphan VISIBLE.
 *
 * SEVERITY — chosen deliberately, not defaulted: a video row that already
 * has `veoVideoUrl` is a PAID master (Atlas Omni, ~$1.00) stranded
 * mid-titling — the money is already spent and the asset is sitting there
 * recoverable, which is a materially different situation from a claim that
 * died before anything billable happened. That bucket alerts at 'error';
 * everything else at 'warn'. Both deliberately clear ALERT_MIN_LEVEL's
 * default 'warn' floor — an 'info' alert here (as bootRecoveryService
 * itself uses for its own "recovered" case) would never reach Slack under
 * that default floor, which is exactly the silent-recovery trap this
 * function exists to avoid.
 */
async function alertOrphanedClaimsOnBoot() {
  try {
    const now = Date.now();
    const claimCutoff = new Date(now - CLAIM_STALE_MIN * 60 * 1000);
    const beatCutoff  = new Date(now - HEARTBEAT_STALE_MIN * 60 * 1000);
    // An orphan is claimed long ago AND not heartbeating. claimedAt-only
    // was the false-page: a healthy titling job holds its original
    // claimedAt for up to AD_HEARTBEAT_MAX_MS (~60.8 min) while beating
    // updatedAt every 60-90s, so a 20-minute claim-age cutoff matched
    // WORKING paid masters. updatedAt-only would false-page a fresh
    // claim whose updatedAt is still the pre-claim write (claimOne does
    // not touch it). Both conditions, both required.
    const stale = await Ad.find({
      status:          'rendering',
      claimedByWorker: { $ne: null },
      claimedAt:       { $lt: claimCutoff },
      updatedAt:       { $lt: beatCutoff }
    }).select('_id claimedByWorker claimedAt updatedAt renderRoute veoVideoUrl').lean();

    if (!stale.length) return;

    const paidMasters = stale.filter((a) => a.renderRoute === 'veo' && a.veoVideoUrl);
    const other       = stale.filter((a) => !(a.renderRoute === 'veo' && a.veoVideoUrl));
    const owners      = [...new Set(stale.map((a) => a.claimedByWorker))];

    if (paidMasters.length) {
      alerts.notifyAsync({
        level: 'error',
        title: `${paidMasters.length} paid video master(s) stranded mid-titling by a dead worker`,
        key:   'orphaned-claim:paid-master',
        fields: {
          worker:         WORKER_ID,
          count:          paidMasters.length,
          previousOwners: owners.slice(0, 5).join(',') || null,
          ads:            paidMasters.slice(0, 8).map((a) => String(a._id).slice(-6)).join(',')
        }
      });
    }
    if (other.length) {
      alerts.notifyAsync({
        level: 'warn',
        title: `${other.length} ad(s) orphaned by a dead renderer worker (stale claim)`,
        key:   'orphaned-claim:unstarted',
        fields: {
          worker:         WORKER_ID,
          count:          other.length,
          previousOwners: owners.slice(0, 5).join(',') || null,
          ads:            other.slice(0, 8).map((a) => String(a._id).slice(-6)).join(',')
        }
      });
    }
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: alertOrphanedClaimsOnBoot failed — ${err.message}`);
  }
}

let stopping = false;
let titlingResumeSweep = null;   // set by run(), stopped by shutdown()
let bootRecoverySweep  = null;   // set by run(), stopped by shutdown()
let costReconcileSweep = null;   // set by run(), stopped by shutdown()
let regenerateConsumer = null;   // set by run(), stopped by shutdown()
let retitleConsumer    = null;   // set by run(), stopped by shutdown()

async function claimOne() {
  // GATED ON ADGEN_RENDERER_ENABLED, read HERE — not only by poll()'s
  // caller-side check (below) before it loops into this function. poll()
  // has always checked first, so this is defense in depth for any other
  // call site, present or future, rather than a behavior change on the
  // live path. Read at CALL TIME (isAdgenRendererEnabled() re-reads
  // process.env every time, never cached), so the switch stays effective
  // without a restart — same property backend's adgenBridge.js relies on.
  //
  // FAIL-SAFE DIRECTION: an unreadable/malformed value is treated as OFF
  // (see isAdgenRendererEnabled in ../config — anything other than the
  // exact string 'true' reads as disabled). OFF means this function
  // returns null and claims nothing. That is the safe direction here,
  // specifically because backend's own render loop renders
  // UNCONDITIONALLY whenever this same flag is not 'true'
  // (services/adgenBridge.js) — so adgen standing down leaves the ad
  // exactly where backend already handles it; adgen claiming on a
  // misread would instead race backend for the same row.
  if (!isAdgenRendererEnabled()) return null;

  // Claim any static (html_gen) or video (veo) ad that's in status:'rendering'
  // and unowned. NOTE: derives ARE claimable here even without their own
  // veoVideoUrl — the sibling-master wait happens INSIDE renderVideo() via
  // findSiblingMasterAd, not at claim time. Gating derives on their OWN
  // veoVideoUrl (Phase 1a design mistake) meant no derive was ever claimable,
  // because the veoVideoUrl gets INHERITED from the master during render,
  // never before. Cost of the fix: a derive worker holds a slot for up to
  // DERIVE_MASTER_WAIT_MS (12min) if the master hasn't landed yet. Bounded
  // by MAX_DERIVE_WAIT_ATTEMPTS at requeue time. Matches backend behavior.
  //
  // TITLER HANDOFF: when isTitlerEnabled(), the video path stamps
  // titlingNeeded:true and clears this claim in the same $set (master
  // ~:1353, derive ~:1094), leaving status:'rendering'. Exclude those
  // rows here or the next poll re-claims them — renderer/titler livelock.
  // `$ne: true` (not `: false`) so pre-field rows stay claimable. Gated
  // so a flag-off rollback can still pick leftovers and title in-process.
  return Ad.findOneAndUpdate(
    {
      status:          'rendering',
      claimedByWorker: null,
      renderRoute:     { $in: ['html_gen', 'veo'] },
      ...(isTitlerEnabled() ? { titlingNeeded: { $ne: true } } : {}),
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
    if (reason) console.warn(`renderer[${WORKER_ID}]: released claim on ${String(adId).slice(-6)} — ${reason}`);
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: release claim failed for ${adId}: ${err.message}`);
  }
}

// Increment run counter atomically. Backend keeps this too — both writers
// converge on the same field because Mongo $inc is atomic. Missing
// runIds (ad ended up on a run with no CampaignRun row — shouldn't happen
// but shouldn't crash if it does) are silently skipped.
async function bumpRunCounter(campaignRunIds, field) {
  if (!Array.isArray(campaignRunIds) || !campaignRunIds.length) return;
  const runId = campaignRunIds[campaignRunIds.length - 1]; // most recent claim wins
  try {
    await CampaignRun.updateOne(
      { runId },
      { $inc: { [field]: 1 }, $set: { updatedAt: new Date(), lastHeartbeatAt: new Date() } }
    );
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: bumpRunCounter(${field}) failed for ${runId}: ${err.message}`);
  }
  await maybeFinalizeRun(runId);
}

/**
 * Drive a CampaignRun to its terminal state once every claimed Ad has settled.
 *
 * WHY THIS EXISTS. The backend's own terminal write (routes/ads.js:2048,
 * `buildTerminalDoneFilter` -> status:'done' + completedAt) sits ~325 lines
 * AFTER runRenderLoop's adgen early-return, so with ADGEN_RENDERER_ENABLED
 * true it is unreachable. Nothing in adgen wrote it either: bumpRunCounter
 * only $inc'd counters. MEASURED in production: run_1787557633213_a0ccdd01
 * held succeeded=2 failed=1 total=3 — every ad settled — while status stayed
 * 'running' with completedAt null for ~20 minutes.
 *
 * That is not merely cosmetic. While updatedAt is stale past REAP_STALE_MIN
 * (15m) the backend's duplicate-generation gate loses its running arm, so an
 * identical /generate is admitted with no 409 — and for static that is a
 * second BILLED gpt-image-2 fan-out.
 *
 * WHY IT REUSES THE VENDORED BUILDERS rather than inventing semantics:
 * classifyRunAdOutcome + buildRunReconciliationUpdate are already vendored in
 * campaignRunGuards.js — byte-identical to the backend's — and were simply
 * never called from anywhere in src/. The backend reaper (worker.js:496-526)
 * makes exactly these calls. Using them means both services derive the same
 * verdict from the same Ad truth instead of two implementations drifting.
 *
 * SAFE AGAINST THE BACKEND REAPER BY CONSTRUCTION. The write is CAS-guarded on
 * status:'running', which is the identical guard worker.js:522 uses. Whichever
 * runs first wins; the loser's updateOne matches nothing and is a no-op. No
 * lock, no coordination, no double-write.
 *
 * DELIBERATELY DOES NOT HANDLE needsRetry. When some sibling ad has been
 * requeued away, buildRunReconciliationUpdate takes its stale-reaper branch,
 * whose operator-facing message reads "no update from the render loop for over
 * Xm" — true when a 15-minute reaper says it, a lie when we say it moments
 * after an ad settled. That case is left to the backend reaper, which has the
 * elapsed-time context to describe it honestly. Finalizing early is not worth
 * writing a false explanation into a row an operator reads.
 *
 * Failure is swallowed: this is a post-settle convenience, and the backend
 * reaper remains the backstop. It must never be able to fail a render.
 */
async function maybeFinalizeRun(runId) {
  if (!runId) return;
  try {
    // Match the backend reaper's query EXACTLY (worker.js:508): ads are found
    // by the runId STRING on campaignRunIds, not by the CampaignRun _id.
    const claimedAds = await Ad.find({ campaignRunIds: runId })
      .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage')
      .lean();
    if (!claimedAds.length) return;

    const outcome = classifyRunAdOutcome(claimedAds);
    if (!outcome.isSettled) return;       // something is still rendering
    if (outcome.needsRetry) return;       // see the header — backend reaper owns this

    const update = buildRunReconciliationUpdate(outcome, { now: new Date() });
    const res = await CampaignRun.updateOne({ runId, status: 'running' }, update);
    if (res && (res.modifiedCount || res.nModified)) {
      console.log(
        `renderer[${WORKER_ID}]: run ${runId} finalized -> done ` +
        `(succeeded=${outcome.succeeded} failed=${outcome.failed})`
      );
      notifyRunFinalized(runId, outcome);
      try {
        require('./runFeedService').finishRun({
          runId,
          succeeded: outcome.succeeded,
          failed: outcome.failed,
          skipped: outcome.skipped || 0
        });
      } catch (_) { /* feed must never fail finalization */ }
    }
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: maybeFinalizeRun(${runId}) failed: ${err.message}`);
  }
}

// Static-path render. Called for renderRoute === 'html_gen'.
// The Ad row has been claimed atomically; on any throw we release the
// claim so a peer worker can retry (bounded by renderAttempts in backend's
// existing sweepers).
async function renderStatic(ad) {
  const adId = String(ad._id);
  const shortId = adId.slice(-6);
  console.log(
    `renderer[${WORKER_ID}]: STATIC render start ad=${shortId} template=${ad.template} ` +
    `format=${ad.platformFormat} concept=${ad.conceptId || 'legacy'}`
  );
  const t0 = Date.now();
  noteFeed(ad, 'layout build');

  // Step 1 — derive LayoutInputArtifact. MIRRORS backend's
  // renderService.deriveStage exactly. Three moves:
  //   a. resolveQuoteAssemblyOptions — pre-computes funnel-stage + concept
  //      angle so the quote pool + stage-aware pick land consistently.
  //   b. buildLayoutInput — returns the derived input (NOT the artifact).
  //   c. LayoutInputArtifact.findOne — separate lookup for the persisted
  //      artifact's _id (buildLayoutInput does NOT return it — a Phase 1b
  //      wrong-destructure bug meant renderDirectImage always saw
  //      layoutInputArtifactId=undefined and fell back to a "generic
  //      layout" on every static render).
  //   d. applyStagedQuotePick — re-picks the printed quote against the
  //      stored pool so a cache-hit artifact written by another stage
  //      cannot leak.
  const quoteAssembly = await resolveQuoteAssemblyOptions({
    funnelStage:       ad.funnelStage || null,
    conceptArtifactId: ad.conceptArtifactId ? String(ad.conceptArtifactId) : null,
    conceptId:         ad.conceptId || null,
    conceptAngle:      null
  });

  const rawInput = await buildLayoutInput({
    mediaId:     String(ad.mediaId),
    template:    ad.template,
    aspectRatio: ad.aspectRatio,
    refresh:     false,
    campaignRunId: Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
      ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
      : null,
    brandId:     ad.brandId ? String(ad.brandId) : null,
    productId:   ad.productId ? String(ad.productId) : null,
    adId,
    options: {
      campaignKind:       ad.campaignKind || null,
      promotionalDetails: null,
      ctaText:            ad.ctaText || null,
      ctaUrl:             ad.ctaUrl  || null,
      variantKind:        ad.variantKind || 'ugc',
      productId:          ad.productId ? String(ad.productId) : null,
      paletteSource:      ad.paletteSource || 'media',
      rafflePrizeMediaId: ad.rafflePrizeMediaId ? String(ad.rafflePrizeMediaId) : null,
      funnelStage:        quoteAssembly.funnelStage,
      conceptAngle:       quoteAssembly.conceptAngle
    }
  });

  // Cache-key fields match buildLayoutInput's findOneAndReplace filter
  // (mediaId, template, aspectRatio, productId, variantKind) so the
  // FK re-read matches exactly the row buildLayoutInput just wrote.
  const artifact = await LayoutInputArtifact.findOne({
    mediaId:     String(ad.mediaId),
    template:    ad.template,
    aspectRatio: ad.aspectRatio,
    productId:   ad.productId ? String(ad.productId) : null,
    variantKind: ad.variantKind || 'ugc'
  }).select('_id').lean();

  const layoutInputArtifactId = artifact?._id || null;
  const input = applyStagedQuotePick(rawInput, {
    funnelStage:  quoteAssembly.funnelStage,
    conceptAngle: quoteAssembly.conceptAngle
  });

  // Step 2 — actual render. Directly through directImageRenderService,
  // bypassing renderService.renderCreative (which we deleted because it
  // pulled in puppeteer and legacy HTML paths).
  const runId = Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
    : null;

  const result = await directImage.renderDirectImage({
    adId,
    layoutInputArtifactId,
    aspectRatio:         ad.aspectRatio,
    mediaId:             String(ad.mediaId),
    productId:           ad.productId ? String(ad.productId) : null,
    brandId:             ad.brandId ? String(ad.brandId) : null,
    campaignId:          ad.campaignId ? String(ad.campaignId) : null,
    campaignRunId:       runId,
    adConceptArtifactId: ad.conceptArtifactId ? String(ad.conceptArtifactId) : null,
    adConceptId:         ad.conceptId || null,
    template:            ad.template,
    referenceMediaIds:   Array.isArray(ad.mediaIds) ? ad.mediaIds.map(String) : [],
    referenceSource:     ad.paletteSource === 'brand' ? 'director' : 'operator',
    platformFormat:      ad.platformFormat || 'meta_feed_1_1',
    variantKind:         ad.variantKind || null,
    funnelStage:         ad.funnelStage || null,
    // No regenerate/prompt override on the fresh render path.
    operatorPrompt:      null,
    rawPromptOverride:   null,
    skipVisionQc:        false,
    // MONEY — resume-from-receipt (mirrors renderVideo's video-master submit
    // call, which passes this same allowResume:true — see that call site
    // further down in this file). This is the ONE call site allowed to opt
    // in: renderStatic can be re-entered on an
    // ad that already holds a receipt (claim released after a crash mid-
    // submit/poll — see the shutdown-drain comment in this file, and
    // bootRecoveryService/strandedRunSweeper for the other receipt-aware
    // recovery paths), and this ad's own imageGeneration.predictionId is
    // exactly that receipt. Passing it through with allowResume:true means
    // directImageRenderService resumes polling the SAME Atlas prediction
    // instead of submitting a fresh one — see directImageRenderService.js's
    // renderDirectImage doc comment for the full contract, and
    // atlasImageService.shouldResumeImageAttempt /
    // submitAndPollWithResume for the decision itself.
    existingPredictionId: ad.imageGeneration?.predictionId || null,
    allowResume:          true
  });

  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  if (result && result.skipped) {
    noteFeed(ad, `failed — skipped (${result.reason || 'no reason'})`);
    console.log(`renderer[${WORKER_ID}]: STATIC skipped ad=${shortId} reason=${result.reason || '-'} wall=${wallSec}s`);
    await Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID },
      { $set: {
          status: 'failed',
          renderError: { message: `skipped: ${result.reason || 'no reason'}`, stage: 'render', at: new Date() },
          claimedByWorker: null,
          claimedAt: null,
          updatedAt: new Date()
      }}
    );
    await bumpRunCounter(ad.campaignRunIds, 'skipped');
    return;
  }

  // renderDirectImage returned a paid buffer + metadata. Now upload to
  // Cloudinary (previously renderService.uploadStage) then persist the
  // full field set (previously renderService.persistStage). Doing this
  // in ONE Ad.updateOne closes the money bug where the ad stayed in
  // status:'rendering', got re-claimed, and re-billed a fresh Atlas
  // submit ($0.072/loop) — observed 21× on ad b46703 pre-fix, ~$1.44 lost.
  if (!result?.buffer) {
    throw new Error('renderDirectImage returned no buffer — cannot upload');
  }
  noteFeed(ad, 'atlas image ready');
  noteFeed(ad, 'cloudinary upload');
  const upload = await uploadRenderToCloudinary(result, {
    brandId:        ad.brandId ? String(ad.brandId) : 'unknown',
    campaignId:     ad.campaignId ? String(ad.campaignId) : 'unknown',
    mediaId:        String(ad.mediaId),
    template:       ad.template,
    aspectRatio:    ad.aspectRatio,
    identityDigest: ad.identityDigest
  });

  const copy = extractCopySnapshot(input, result.renderedCopy || null);

  await Ad.updateOne(
    { _id: ad._id, claimedByWorker: WORKER_ID, status: 'rendering' },
    {
      $set: {
        layoutInputArtifactId,
        sourceFileType:     null,
        kind:               result.kind || 'image',
        renderUrl:          upload.renderUrl,
        posterUrl:          upload.posterUrl,
        cloudinaryPublicId: upload.cloudinaryPublicId,
        width:              upload.width,
        height:             upload.height,
        bytes:              upload.bytes,
        durationMs:         upload.durationMs,
        fontResolution:     result.fontResolution || null,
        imageGeneration:    result.imageGeneration || null,
        intentResolution:   result.intentResolution || null,
        visionQc:           result.visionQc || null,
        copy,
        status:             'draft',
        renderedAt:         new Date(),
        updatedAt:          new Date(),
        claimedByWorker:    null,
        claimedAt:          null
      },
      $inc: { renderAttempts: 1 }
    }
  );

  console.log(`renderer[${WORKER_ID}]: STATIC done ad=${shortId} wall=${wallSec}s url=${upload.renderUrl.slice(0, 60)}…`);
  noteFeedEvent(ad, 'done');
  await bumpRunCounter(ad.campaignRunIds, 'succeeded');
}

// Sibling master lookup. Mirrors backend's findSiblingMasterAd in
// routes/ads.js — a derive ad's master is same-campaign, same-product,
// video kind, with the requested platformFormat, and NO deriveFromMaster
// / funnelStage of its own (true master, not another retitle).
async function findSiblingMasterAd(ad, masterPlatformFormat) {
  const base = {
    campaignId: ad.campaignId,
    productId:  ad.productId,
    platformFormat: masterPlatformFormat,
    kind:      'video',
    _id:       { $ne: ad._id },
    $and: [
      { $or: [{ deriveFromMaster: null }, { deriveFromMaster: { $exists: false } }] },
      { $or: [{ funnelStage: null },       { funnelStage: { $exists: false } }] }
    ]
  };
  const runIds = Array.isArray(ad.campaignRunIds) ? ad.campaignRunIds.map(String).filter(Boolean) : [];
  if (runIds.length) {
    const inRun = await Ad.findOne({ ...base, campaignRunIds: { $in: runIds } })
      .sort({ generatedAt: -1 }).lean();
    if (inRun) return inRun;
  }
  return Ad.findOne(base).sort({ generatedAt: -1 }).lean();
}

// Requeue a derive whose master isn't ready yet. Bumps deriveWaitAttempts
// (NOT renderAttempts — that would spuriously trip the stranded-sweeper).
// The claim is released so a peer worker can retry after the master lands.
async function requeueDeriveForRetry(ad, reason) {
  await Ad.updateOne(
    { _id: ad._id, claimedByWorker: WORKER_ID },
    {
      $set: {
        status:          'rendering',
        claimedByWorker: null,
        claimedAt:       null,
        updatedAt:       new Date()
      },
      $inc: { deriveWaitAttempts: 1 }
    }
  );
  console.log(`renderer[${WORKER_ID}]: derive requeued ad=${String(ad._id).slice(-6)} — ${reason}`);
  noteFeed(ad, 'derive: retrying (sibling master not ready)');
}

/**
 * Fallback half of the video terminal stamp, shared by both branches.
 * Reached ONLY when the guarded promote-to-draft write matched nothing,
 * i.e. something already stamped a terminal verdict. Returns
 * { status, counter }.
 *
 * The promote write itself stays INLINE in each branch on purpose: two
 * harnesses read the literal out of the branch body — verifyPmaxVideoExpansion
 * E1b wants `status: 'draft'` inside the derive body, and
 * verifyRendererAtomicClaim D1 wants status and `claimedByWorker: null` in the
 * SAME update document. Hoisting it here would blind both.
 *
 * THE GUARD IS THE POINT. Titling runs before this and can stamp its OWN
 * terminal verdict: services/brandScriptExecutor.js buildVideoQcFailureFields
 * sets status:'failed' when vision QC really fails (PR #282 — "deliver a
 * QC-failed ad as failed with the exact Slack reason"). This write used to be
 * a bare { _id }, so it overwrote that verdict with 'draft' and then counted
 * the ad 'succeeded'. Measured in prod 2026-08-24: 47 video ads with
 * visionQc.passed:false sitting in status:'draft', and ZERO in 'failed' —
 * B=0 is the signature; the verdict never survived even once.
 *
 * WHY $nin AND NOT status:'rendering'. Copying renderStatic's
 * { _id, claimedByWorker, status:'rendering' } filter here looks right and is
 * wrong: uploadRenderAndStamp (brandScriptExecutor.js) already promoted this
 * row to 'draft' during titling, so a 'rendering' guard would no-op on every
 * SUCCESSFUL render — stranding claimedByWorker forever (claimOne needs it
 * null, and nothing in either repo ever clears it) and leaving the titling
 * debt for titlingResumeService to re-render. $nin preserves any terminal
 * verdict, whoever wrote it, without blocking the happy path.
 * AN ALLOWLIST, NOT A DENYLIST, AND THAT DIRECTION IS THE SAFETY PROPERTY.
 * A $nin:['failed','archived'] denylist fails OPEN: any status nobody
 * enumerated gets overwritten with 'draft'. That resurrects a row a backend
 * requeue just moved to 'queued' (processAlerts SIGTERM / the crash catches),
 * and it DEMOTES an ad an operator promoted to 'live'. The allowlist admits
 * only the two states this function legitimately owns at this point —
 * 'rendering' (no-chrome / no-brand: titling never ran) and 'draft' (the
 * normal case: uploadRenderAndStamp already promoted it) — so every unknown
 * status falls to the settle-only arm, which releases the claim and clears
 * the debt WITHOUT touching status. Unknown state => leave it alone.
 * These literals live in the FILTER, never the update, so renderer.js still
 * never WRITES 'archived' — see scripts/verifyRendererAdStatusEnum.js B3.
 *
 * The claim + debt are settled on BOTH branches. A no-op that skipped them
 * would trade a clobbered verdict for a permanently unclaimable row.
 */
async function settleNonDraftTerminal(ad, label) {
  const shortId = String(ad._id).slice(-6);
  // A terminal verdict was already stamped. Do NOT resurrect it — but the
  // claim and the titling debt are still ours to settle.
  //
  // renderStage:'done' is set here UNCONDITIONALLY, same as the guarded
  // success $set this function backstops — deliberately NOT status-gated.
  // renderStage is progress telemetry ("is this ad still working"), not a
  // pass/fail verdict; `status` (left alone here — could be 'failed' from
  // vision QC, or 'archived') already carries that distinction correctly.
  // Before this, NOTHING ever wrote a terminal renderStage on this arm, so a
  // QC-failed video ad kept showing its last in-flight stage (typically
  // "vision QC (video)") forever with the frontend's live elapsed-timer UI —
  // measured 2026-08-26: 242/300 recent video ads stuck exactly there,
  // reading as "stuck in quality check" when they were actually done and
  // correctly failed. See renderStage's own success-path precedent in
  // titlingResumeService.js, which already does this the same way.
  const after = await Ad.findOneAndUpdate(
    { _id: ad._id },
    {
      $set: {
        titlingResumeState: null,
        claimedByWorker:    null,
        claimedAt:          null,
        renderStage:        'done',
        renderStageAt:      new Date(),
        updatedAt:          new Date()
      }
    },
    { new: true, projection: { status: 1 } }
  ).lean();
  const kept = (after && after.status) || 'failed';
  console.warn(
    `renderer[${WORKER_ID}]: ${label} ad=${shortId} kept terminal status='${kept}' ` +
    `(NOT overwritten with draft) — claim released, titling debt cleared`
  );
  // 'archived' is an operator action, not a render failure; only a real
  // 'failed' verdict counts against the run.
  return { status: kept, counter: kept === 'failed' ? 'failed' : 'succeeded' };
}

// Video render path — handles BOTH the billable master submit (Atlas Omni)
// AND the free derive-only crops/retitles of an existing master. Money-
// critical gate: renderDeriveOnlyVideoAd MUST NEVER call atlasVideo.
// generateForAd — that would submit a paid Omni master on a "free" derive
// row. The check is resolveDeriveFromMaster (imported, single definition,
// fail-closed on pmax_video_1_1 by construction).
async function renderVideo(ad) {
  const adId = String(ad._id);
  const shortId = adId.slice(-6);
  const t0 = Date.now();
  const runId = Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
    : null;

  const deriveFromFmt = resolveDeriveFromMaster(ad);

  if (deriveFromFmt) {
    // ── DERIVE PATH — no Omni submit, ever ─────────────────────────────
    console.log(`renderer[${WORKER_ID}]: VIDEO DERIVE start ad=${shortId} deriveFrom=${deriveFromFmt}`);
    noteFeed(ad, 'derive: waiting for sibling master');

    if ((ad.deriveWaitAttempts || 0) >= MAX_DERIVE_WAIT_ATTEMPTS) {
      throw new Error(`derive exceeded max wait attempts (${MAX_DERIVE_WAIT_ATTEMPTS}); sibling master never landed`);
    }

    // Poll for the sibling master's veoVideoUrl up to DERIVE_MASTER_WAIT_MS.
    const deadline = Date.now() + DERIVE_MASTER_WAIT_MS;
    let master = null;
    while (Date.now() < deadline) {
      master = await findSiblingMasterAd(ad, deriveFromFmt);
      if (master?.veoVideoUrl) break;
      if (master?.status === 'failed') {
        throw new Error(`sibling master ${String(master._id).slice(-6)} failed — cannot derive`);
      }
      await new Promise((r) => setTimeout(r, DERIVE_MASTER_POLL_MS));
    }
    if (!master?.veoVideoUrl) {
      notifyDeriveWaitBackup(ad, master, (ad.deriveWaitAttempts || 0) + 1);
      await requeueDeriveForRetry(ad, 'sibling master not yet ready — retry later');
      return; // NOT counted as failure; requeue is the intent
    }

    noteFeed(ad, 'derive: inherited master');

    // Inherit the paid master's veoVideoUrl / cloudinary asset onto the derive.
    // Two modes, one atomic write — DO NOT split (a two-write shape opens a
    // window where a titler can observe titlingNeeded=true without veoVideoUrl):
    //   - HANDOFF mode (isTitlerEnabled true): stamp titlingNeeded=true and
    //     release the claim in the same $set as veoVideoUrl. Return early; the
    //     titler role picks up the ad on its next poll and does Remotion out
    //     of process.
    //   - IN-PROCESS mode: stamp titlingResumeState:'claimed' as before and
    //     fall through to the existing Remotion titling below.
    // Keep the mode-specific fields as an inline literal spread so
    // titlingResumeState: 'claimed' lands verbatim in the source —
    // verifyVideoQcVerdictSurvives F5 uses that string as its ordering anchor.
    const handoffMode = isTitlerEnabled();
    const $setDerive = {
      veoVideoUrl:        master.veoVideoUrl,
      veoAspectRatio:     master.veoAspectRatio || ad.aspectRatio,
      veoModel:           master.veoModel || null,
      renderUrl:          master.veoVideoUrl,
      sourceFileType:     'video',
      renderedAt:         new Date(),
      updatedAt:          new Date(),
      ...(handoffMode
        ? {
            titlingNeeded:      true,
            titlingResumeState: null,
            claimedByWorker:    null,
            claimedAt:          null,
          }
        : {
            titlingResumeState: 'claimed',
          }),
    };
    await Ad.updateOne(
      { _id: ad._id, claimedByWorker: WORKER_ID },
      { $set: $setDerive, $inc: { renderAttempts: 1 } }
    );

    if (handoffMode) {
      const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `renderer[${WORKER_ID}]: VIDEO DERIVE handoff ad=${shortId} wall=${wallSec}s ` +
        `— stamped titlingNeeded=true, released to titler`
      );
      noteFeed(ad, 'derive: handed off to titler');
      // Do NOT bumpRunCounter — the ad hasn't settled yet, the titler owns
      // the terminal stamp. `updatedAt` above keeps the CampaignRun off the
      // reaper radar during the brief poll window before titler claims.
      return;
    }

    // Load brand for titling
    const sourceMedia = ad.mediaId ? await Media.findById(ad.mediaId).select('brandId').lean() : null;
    const brandDoc = sourceMedia?.brandId
      ? await Brand.findById(sourceMedia.brandId).lean()
      : (ad.brandId ? await Brand.findById(ad.brandId).lean() : null);

    // Re-read AFTER the inherit-write above, before either arm — the master's
    // veoReferenceImages (the exact seed sent to the model) has to be visible
    // to qcAndStampVideoAd's no-brand arm below, not just to renderBrandScript
    // AndSave's. Hoisted out of the if-arm (which used to read it locally) so
    // both arms share one read instead of the no-brand arm needing its own.
    const adFinal = await Ad.findById(adId).lean();

    if (brandDoc) {
      adStage(adId, `titling ${ad.aspectRatio || '9:16'} (derive)`);
      // Beat updatedAt for the whole titling window — including the queue
      // wait, which writes nothing otherwise. See startAdHeartbeat.
      // OUTER wrapper: beat.stop() lives in finally so an OOM early-return
      // still releases the timer. INNER wrapper: child OOM returns without
      // the success $set (that would clear titling debt) and without throwing
      // into processAd (that would mark status:'failed').
      const beat = startAdHeartbeat(adId);
      try {
        try {
          const chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
          if (chromeOut?.skipped) {
            console.log(`renderer[${WORKER_ID}]: VIDEO DERIVE no-chrome ad=${shortId} — shipping master`);
          }
        } catch (scriptErr) {
          // scriptErr.titlingResumable is stamped by brandScriptExecutor's
          // stampTitlingFailureAndThrow — true for OOM, timeout, AND a
          // generic child failure/exception, as long as the attempt cap
          // (TITLING_ATTEMPTS_MAX) has not been exceeded. It has ALREADY
          // written status:'draft' + titlingResumeState:'pending' (or, past
          // the cap, status:'failed') before rethrowing here, ALWAYS
          // clearing claimedByWorker as part of that same write. Do not fall
          // through to the success $set below (that would clear the debt on
          // a resumable failure). Throwing into processAd would NOT actually
          // overwrite the stamped Ad fields — its own terminal write is
          // filtered on {claimedByWorker: WORKER_ID}, which the stamp has
          // already nulled, so that write would just no-op — but it WOULD
          // still run bumpRunCounter('failed') (wrong: this ad is not
          // terminal) and fire the render-failure Slack alert (noisy: this
          // is not an operator-actionable event) for a resumable outcome.
          // Was OOM-only; a timeout or a generic child exit used to fall
          // through to `throw scriptErr` here and hit exactly that path.
          if (scriptErr && scriptErr.titlingResumable) {
            console.warn(`renderer[${WORKER_ID}]: VIDEO DERIVE titling ${scriptErr.titlingFailureKind || 'failed'} ad=${shortId} — paid plate kept, titling left pending`);
            return;
          }
          throw scriptErr;
        }
      } finally {
        beat.stop();   // must not outlive the render, on success OR throw OR OOM return
      }
    } else {
      // NO BRAND RESOLVED — same gap as the master path below (and the one
      // backend's routes/ads.js:2609/3067 already closed): this never reaches
      // renderBrandScriptAndSave, so it never reaches vision QC either. The
      // derived plate would otherwise ship with NO Ad.visionQc at all — not
      // even the {skipped:true, disabled:true} stub. deliveredUrl is the
      // inherited sibling master's URL, not a fresh Omni submit (this is the
      // free derive path).
      //
      // SAME HEARTBEAT AS THE BRAND ARM, and for the identical reason: vision
      // QC is a real vision-LLM call (up to MAX_ATTEMPTS x TIMEOUT_MS plus a
      // direct-provider fallback — several minutes in a real retry scenario),
      // and this row is still status:'rendering' with a live Omni receipt.
      // Without a beat, backend's bootRecoveryService (RESUME_STALE_MIN,
      // default 5min) can steal it mid-QC exactly as it could a live titling
      // render — the whole reason startAdHeartbeat exists. Adversarial review
      // (Grok xhigh) caught this being missing on the first draft of this fix.
      //
      // REFERENCE IMAGE: adFinal does NOT carry the master's veoReferenceImages
      // — the inherit-write above deliberately copies only what's needed to
      // ship/title the plate, not the seed list. Passing adFinal as-is would
      // make runVideoVisionQcForAd fall through to a CatalogProduct hero photo
      // that may not be the frame that generated this clip (the master could
      // have been seeded from a different lifestyle photo), producing a FALSE
      // product-fidelity failure that flips a perfectly good derive to
      // status:'failed'. Also caught in the same adversarial pass. Sourcing
      // veoReferenceImages/videoDurationSec from `master` (the sibling's own
      // record, already in memory, unprojected) instead fixes the comparison
      // for THIS call only — deliberately NOT persisted onto the Ad doc, and
      // deliberately NOT a fix to the pre-existing branded-arm version of this
      // same gap (uploadRenderAndStamp's QC call has the identical exposure
      // today, independent of this change — a separate, pre-existing defect).
      //
      // videoDurationSec falls back to adFinal's OWN value, not straight to
      // null, if master's happens to be unset — Ad.videoDurationSec is
      // operator/wizard-stamped per ad per format
      // (campaignAdsGenerationService.resolveVideoDurationForFormat), so
      // master-null-while-derive-set is reachable. `master.x || null` would
      // silently discard a real duration and force
      // runVideoVisionQcForAd's hardcoded 8s fallback, which shifts every
      // sampled frame timestamp and can request frames past a shorter clip's
      // end. veoReferenceImages has no equivalent third fallback because
      // there isn't one to lose — an empty array here and an empty array on
      // adFinal land on the identical CatalogProduct fallback either way.
      //
      // ⚠️ DO NOT "HARMONISE" THESE TWO LINES TO THE SAME SHAPE. They look
      // like they should match and MUST NOT: Ad.videoDurationSec defaults to
      // null (models/Ad.js) — falsy — so `master.x || adFinal.x || null`
      // works. Ad.veoReferenceImages defaults to `[]` (models/Ad.js) — an
      // EMPTY ARRAY IS TRUTHY in JS — so the identical-looking
      // `adFinal.veoReferenceImages || master.veoReferenceImages || []`
      // would silently pick adFinal's stored `[]` and never reach master at
      // all, reopening the exact CatalogProduct-fallback bug this merge
      // exists to close. Found in a second adversarial (Grok xhigh) round,
      // specifically as "the review comment that would spring it."
      const { qcAndStampVideoAd } = require('./brandScriptExecutor');
      const beat = startAdHeartbeat(adId);
      try {
        await qcAndStampVideoAd({
          ad: {
            ...adFinal,
            veoReferenceImages: master.veoReferenceImages || [],
            videoDurationSec:   master.videoDurationSec || adFinal.videoDurationSec || null
          },
          deliveredUrl: master.veoVideoUrl
        });
      } finally {
        beat.stop();
      }
    }

    // Success stamp — clear titling debt, terminal state. GUARDED: titling
    // may already have stamped status:'failed' (vision QC). See
    // settleNonDraftTerminal for the full reasoning.
    const derivePromoted = await Ad.updateOne(
      { _id: ad._id, status: { $in: ['rendering', 'draft'] } },
      {
        $set: {
          status:             'draft',
          titlingResumeState: null,
          claimedByWorker:    null,
          claimedAt:          null,
          // Terminal stage — see settleNonDraftTerminal's comment for why
          // this is 'done' regardless of the vision-QC verdict (status
          // already carries pass/fail; renderStage is progress telemetry).
          renderStage:        'done',
          renderStageAt:      new Date(),
          updatedAt:          new Date()
        }
      }
    );
    const deriveSettled = derivePromoted.matchedCount
      ? { status: 'draft', counter: 'succeeded' }
      : await settleNonDraftTerminal(ad, 'VIDEO DERIVE');
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `renderer[${WORKER_ID}]: VIDEO DERIVE done ad=${shortId} wall=${wallSec}s status=${deriveSettled.status}`
    );
    noteFeedEvent(ad, deriveSettled.status === 'draft' ? 'done' : `failed — ${deriveSettled.status}`);
    await bumpRunCounter(ad.campaignRunIds, deriveSettled.counter);
    return;
  }

  // ── MASTER PATH — billable Atlas Omni submit ──────────────────────────
  console.log(`renderer[${WORKER_ID}]: VIDEO MASTER start ad=${shortId} format=${ad.platformFormat}`);

  const sourceMedia = ad.mediaId ? await Media.findById(ad.mediaId).select('fileType fileUrl brandId').lean() : null;
  const brandDoc = sourceMedia?.brandId
    ? await Brand.findById(sourceMedia.brandId).lean()
    : (ad.brandId ? await Brand.findById(ad.brandId).lean() : null);

  // Stage 1 — prepare storyboard / prompt context. On Atlas the storyboard
  // is null and the Ken Burns prompt directs motion; kept as-called for
  // compat with legacy vertex path (which noop-returns).
  adStage(adId, 'preparing video context');
  const { storyboard } = await veoPrepareStoryboard({ ad });

  // Stage 2 — the billable Omni submit + poll. Stamps veoPredictionId
  // (spend receipt) inside atlasVideoService before polling.
  //
  // allowResume: true — EXPLICIT, matching the default, so a future reader
  // does not have to go check atlasVideoService's default to know this call
  // site is protected. This is the exact path a released claim on a
  // receipt-holding ad re-enters (claimOne has no receipt filter — a claim
  // released while status stays 'rendering', by a future claim-TTL sweeper
  // or any other requeue path, makes the row claimable again), so this is
  // precisely where resume-instead-of-resubmit has to be on.
  adStage(adId, `master video generation (${ad.aspectRatio || '9:16'})`);
  const veoResult = await atlasVideo.generateForAd({ ad, storyboard, campaignRunId: runId, allowResume: true });
  if (veoResult.skipped) {
    throw new Error(veoResult.reason || 'video generation skipped by provider');
  }
  noteFeed(ad, 'master video ready');

  // Persist master + titling debt marker in one write (see backend
  // routes/ads.js:2940 — this shape is the money-critical stamp that
  // makes the paid asset reclaimable if the process dies mid-titling).
  //
  // veoVideoUrl and veoReferenceImages land in the SAME $set, which is what
  // makes the derive path's poll loop (findSiblingMasterAd, above) safe: the
  // moment a sibling can observe master.veoVideoUrl, master.veoReferenceImages
  // is guaranteed populated too — there is no partial-write window where the
  // URL is visible but the reference list isn't. The derive no-brand else-arm
  // below relies on exactly this to source a correct QC reference image. If
  // this write is ever split into two, that guarantee breaks silently.
  //
  // HANDOFF mode (isTitlerEnabled true) adds titlingNeeded=true + claim
  // release TO THIS SAME $set so a titler observing titlingNeeded also sees
  // the settled veoVideoUrl — same partial-write-window argument, one write.
  // Mode-specific spread — see derive path above for the F5 anchor note.
  //
  // FIELD NAME: `cloudinaryPublicId`, NOT `veoCloudinaryPublicId`. This key
  // MUST match backend routes/ads.js's video-master persist write exactly —
  // that write puts the SAME veoResult.cloudinaryPublicId (the raw Omni
  // master's Cloudinary asset, uploaded by
  // atlasVideoService/aiVideoReferenceService BEFORE Remotion titling ever
  // runs) into the schema-declared `cloudinaryPublicId` path (grep
  // `cloudinaryPublicId` in liquidretail_backend/routes/ads.js to re-locate
  // it — line numbers drift there and are deliberately not pinned here).
  // The later titled-render upload (brandScriptExecutor.uploadRenderAndStamp,
  // both repos) only ever stamps `renderUrl`/`posterUrl` — it never touches
  // `cloudinaryPublicId` — so this field identifies the RAW MASTER for the
  // life of the ad, never the titled asset. `veoCloudinaryPublicId` is NOT a
  // path in models/Ad.js on either side (verified: only `cloudinaryPublicId`
  // is declared, at src/models/Ad.js:530 here, same shape on backend) —
  // writing that name is a silent no-op under Mongoose strict mode. This was
  // the 4th instance of that failure class in this repo, after
  // renderError.predictionId, the renderStage sentinel, and titlingNeeded
  // (all documented in models/Ad.js). See
  // scripts/verifyVideoMasterCloudinaryPublicId.js for the regression guard.
  const handoffMode = isTitlerEnabled();
  const $setMaster = {
    veoVideoUrl:          veoResult.videoUrl,
    veoAspectRatio:       veoResult.aspectRatio || ad.aspectRatio,
    veoPrompt:            veoResult.prompt || null,
    veoStoryboard:        veoResult.storyboard || storyboard || null,
    cloudinaryPublicId:    veoResult.cloudinaryPublicId || null,
    veoModel:             veoResult.model || null,
    veoReferenceImages:   veoResult.referenceImages || [],
    renderUrl:            veoResult.videoUrl,
    sourceFileType:       'video',
    renderedAt:           new Date(),
    updatedAt:            new Date(),
    ...(handoffMode
      ? {
          titlingNeeded:      true,
          titlingResumeState: null,
          claimedByWorker:    null,
          claimedAt:          null,
        }
      : {
          titlingResumeState: 'claimed',
        }),
  };
  await Ad.updateOne(
    { _id: ad._id, claimedByWorker: WORKER_ID },
    { $set: $setMaster, $inc: { renderAttempts: 1 } }
  );

  if (handoffMode) {
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `renderer[${WORKER_ID}]: VIDEO MASTER handoff ad=${shortId} wall=${wallSec}s ` +
      `— stamped titlingNeeded=true, released to titler`
    );
    noteFeed(ad, 'handed off to titler');
    // Do NOT bumpRunCounter — the ad hasn't settled yet, the titler owns
    // the terminal stamp. `updatedAt` above keeps the CampaignRun off the
    // reaper radar during the brief poll window before titler claims.
    return;
  }

  // Stage 3 — Remotion titling on the paid master.
  // Re-read AFTER the persist-write above, before either arm — that write
  // just populated veoReferenceImages (the exact seed URLs actually sent to
  // the model), which qcAndStampVideoAd's no-brand arm below needs just as
  // much as renderBrandScriptAndSave does. Reading it off the in-memory `ad`
  // param instead would silently fall through to a CatalogProduct hero photo
  // that may not be the frame that generated this clip.
  const adFinal = await Ad.findById(adId).lean();
  if (brandDoc) {
    adStage(adId, `titling ${ad.aspectRatio || '9:16'}`);
    // Beat updatedAt for the whole titling window — including the queue
    // wait, which writes nothing otherwise. See startAdHeartbeat.
    // OUTER wrapper: beat.stop() lives in finally so an OOM early-return
    // still releases the timer. INNER wrapper: child OOM returns without
    // the success $set (that would clear titling debt) and without throwing
    // into processAd (that would mark status:'failed').
    const beat = startAdHeartbeat(adId);
    try {
      try {
        const chromeOut = await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
        if (chromeOut?.skipped) {
          console.log(`renderer[${WORKER_ID}]: VIDEO MASTER no-chrome ad=${shortId} — shipping master`);
        }
      } catch (scriptErr) {
        // See the identical comment on the VIDEO DERIVE arm above —
        // titlingResumable now covers OOM, timeout, and a generic child
        // failure/exception (bounded by TITLING_ATTEMPTS_MAX), not just OOM.
        if (scriptErr && scriptErr.titlingResumable) {
          // brandScriptExecutor already stamped draft + titlingResumeState:'pending'
          // and cleared claimedByWorker. Do not fall through to the success
          // $set (that would clear the debt) — throwing into processAd would
          // not actually flip the stamped fields back (its terminal write is
          // filtered on the now-cleared claimedByWorker and would no-op),
          // but it WOULD still bump the run's 'failed' counter and fire the
          // failure alert for an outcome that is not actually terminal.
          console.warn(`renderer[${WORKER_ID}]: VIDEO MASTER titling ${scriptErr.titlingFailureKind || 'failed'} ad=${shortId} — paid master kept, titling left pending`);
          return;
        }
        throw scriptErr;
      }
    } finally {
      beat.stop();   // must not outlive the render, on success OR throw OR OOM return
    }
  } else {
    // NO BRAND RESOLVED (sourceMedia carried no brandId, or the lookup came
    // back empty) — this NEVER reaches renderBrandScriptAndSave, so it never
    // reaches vision QC either. Both of those call vision QC before the ad is
    // considered delivered; without this, the master ships straight to
    // 'draft' below with no equivalent call at all — a video ad with NO
    // Ad.visionQc whatsoever, not even the {skipped:true, disabled:true}
    // stub. Mirrors backend's routes/ads.js:3067.
    //
    // SAME HEARTBEAT AS THE BRAND ARM — vision QC is a real vision-LLM call
    // (several minutes in a real retry scenario) and this row is still
    // status:'rendering' with a live Omni receipt; without a beat, backend's
    // bootRecoveryService can steal it mid-QC exactly as it could a live
    // titling render. adFinal already carries the correct veoReferenceImages
    // here (the persist-write just above wrote them from veoResult before
    // this re-read), unlike the derive path, so no extra merge is needed.
    const { qcAndStampVideoAd } = require('./brandScriptExecutor');
    const beat = startAdHeartbeat(adId);
    try {
      await qcAndStampVideoAd({ ad: adFinal, deliveredUrl: veoResult.videoUrl });
    } finally {
      beat.stop();
    }
  }

  // Terminal — clear titling debt + claim. GUARDED: titling may already have
  // stamped status:'failed' (vision QC). See settleNonDraftTerminal.
  const masterPromoted = await Ad.updateOne(
    { _id: ad._id, status: { $in: ['rendering', 'draft'] } },
    {
      $set: {
        status:             'draft',
        titlingResumeState: null,
        claimedByWorker:    null,
        claimedAt:          null,
        // Terminal stage — see settleNonDraftTerminal's comment for why
        // this is 'done' regardless of the vision-QC verdict (status
        // already carries pass/fail; renderStage is progress telemetry).
        renderStage:        'done',
        renderStageAt:      new Date(),
        updatedAt:          new Date()
      }
    }
  );
  const masterSettled = masterPromoted.matchedCount
    ? { status: 'draft', counter: 'succeeded' }
    : await settleNonDraftTerminal(ad, 'VIDEO MASTER');
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `renderer[${WORKER_ID}]: VIDEO MASTER done ad=${shortId} wall=${wallSec}s status=${masterSettled.status}`
  );
  noteFeedEvent(ad, masterSettled.status === 'draft' ? 'done' : `failed — ${masterSettled.status}`);
  await bumpRunCounter(ad.campaignRunIds, masterSettled.counter);
}

// In-process concurrent-render tracking. Every processAd() invocation
// increments this on entry and decrements on completion (finally). poll()
// burst-claims up to MAX_INFLIGHT and fires each render as an unawaited
// promise, so one instance can run many concurrent ads.
let inFlight = 0;

// ── CAMPAIGNRUN LIVENESS HEARTBEAT — a money/visibility guard, not telemetry.
//
// Backend worker.js's reaper flips any CampaignRun sitting in 'running' with
// `updatedAt` older than REAP_STALE_MIN (15m) to 'failed'. With
// ADGEN_RENDERER_ENABLED=true, adgen renders every new ad, and the only
// CampaignRun writes this loop used to make were bumpRunCounter's per-ad
// `$inc { succeeded | failed | skipped }` — which fire when an ad SETTLES.
// So the reaper's predicate measured "no ad settled recently", not "this
// run is alive". MEASURED IN PRODUCTION 2026-08-18
// (run_1787105727540_e8c94542): 18 statics settled by 02:21, video titling
// then ran silently, and at 02:36 the reaper stamped a working run 'failed'
// with `errors: []`, `failed: 0`. Re-measured live 2026-08-24
// (run_1787575090320_db5a5d96): lastHeartbeatAt NULL, updatedAt frozen 6+
// minutes while the master was generating and the per-ad beat moved every
// ~10s. The module that was written to fix this was vendored into adgen
// and never called.
//
// GATED ON REAL WORK, and that is the whole design. Backend's runRenderLoop
// owns one run and gates on `pools.some(p => p.inflight > 0)` — the same
// counters the loop uses to decide it is finished. Adgen's worker is
// multi-run: the process-wide `inFlight` above is "any ad, any run", so
// gating on it would keep a finished run beating while a sibling's ads
// were in flight (the unconditional tick that defeats the reaper). The
// equivalent signal is this Map: incremented when processAd begins work
// on an ad of that run, decremented in the same finally that stops the
// ticker. A truthy constant here would resurrect the wedged-run-lives-
// forever class the reaper exists to kill.
//
// `runDocId` is CampaignRun._id (what buildRunHeartbeatFilter matches).
// Ad.campaignRunIds holds the runId STRING, so we resolve _id once per
// run and cache it. Lookup failure → no ticker (fail towards reapable).
//
// The Ad arm gets this run's claimed set, same as backend routes/ads.js:1868.
// Backend still bulk-claims the whole batch to status:'rendering' BEFORE
// the adgen early-return (claimAdsForRun, then runRenderLoop returns).
// Those rows sit {status:'rendering', claimedByWorker:null} with updatedAt
// frozen at claim time (Ad.timestamps is false; claimOne does not refresh
// it). That is the claimed-but-undispatched tail the 2026-08-18 Ad sweep
// stranded — it is in Mongo, not an in-memory pool. startAdHeartbeat
// cannot cover it: it requires claimedByWorker:WORKER_ID and only wraps
// titling. Passing a snapshot of the one ad in processAd would miss the
// siblings still waiting for a slot. The module's Ad-arm filter is
// { _id: { $in: adIds }, status:'rendering' }, so settled rows are a
// no-op and the per-ad beat (#9/#11) is undisturbed.
//
// Fire-and-forget, never awaited into the render, never throws into the
// loop. stop() is idempotent and is called from BOTH catch and finally —
// same discipline as routes/ads.js:1922/1937.
const runInflight    = new Map(); // runId string → processAd count for that run
const runHeartbeats  = new Map(); // runId string → startRunHeartbeat handle
const runDocIdCache  = new Map(); // runId string → CampaignRun._id

function runIdOf(ad) {
  return Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
    ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
    : null;
}

function runIsWorking(runId) {
  return (runInflight.get(runId) || 0) > 0;
}

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
        else {
          console.warn(
            `renderer[${WORKER_ID}]: no CampaignRun for ${runId} — skipping run heartbeat (fail towards reapable)`
          );
        }
      }
      if (docId && !runHeartbeats.has(runId)) {
        // Same population backend hands the ticker: every ad this run
        // claimed. Taken once when the ticker opens — the bulk claim
        // already landed before the first processAd of the run.
        let adIds = [];
        try {
          const claimed = await Ad.find({ campaignRunIds: runId }).select('_id').lean();
          adIds = Array.isArray(claimed) ? claimed.map((a) => a._id) : [];
        } catch (err) {
          console.warn(
            `renderer[${WORKER_ID}]: Ad.find for run heartbeat ${runId} failed: ${err.message} — run arm still starts`
          );
        }
        runHeartbeats.set(runId, startRunHeartbeat({
          runDocId:  docId,
          adIds,
          isWorking: () => runIsWorking(runId)
        }));
      }
    }
  } catch (err) {
    // A missed start is survivable — the run stays reapable. Never throw
    // into processAd over a liveness ticker.
    console.warn(`renderer[${WORKER_ID}]: startRunHeartbeat failed for ${runId}: ${err.message}`);
  }

  return { stop: release };
}

// ── VIDEO POLL-TIMEOUT LIFETIME CAP ─────────────────────────────────────────
// How many times ONE ad may take processAd's unsettledAtTimeout branch before
// it is failed terminally instead of being left for another cycle.
//
// THIS IS NEW COVERAGE, NOT A REPAIR OF SOMETHING THAT EXISTED. The first
// triage of this incident assumed a frozen renderAttempts had blinded an
// existing ceiling. It had not: strandedRunSweeper's
// `renderAttempts < STRANDED_SWEEP_MAX_ATTEMPTS` bound
// (strandedRunSweeper.js:112) sits inside buildStrandedAdFilter, which also
// requires `status:'queued'` AND membership in a FAILED run's campaignRunIds
// (:105-117). A 'rendering' ad on a 'running' run is out of that filter's
// scope entirely, so no value of the counter could ever have brought it into
// range. queuedArchiveSweeper's renderAttempts:0 guard is likewise
// `status:'queued'`-scoped. There was NO guard covering a 'rendering'
// re-claim loop — the counter being frozen was real and worth fixing for
// honesty and sweeper visibility, but it is not what let this run away.
//
// Default 3 is a backstop, not the primary bound: with the receipt handoff
// below, a receipt-holding ad takes that branch ONCE and is then owned by
// bootRecoveryService's free poller, so reaching this cap means something
// else is re-claiming the row and the loop must stop regardless.
// FLOOR 2, matching resolveUnsettledTimeoutAction's own floor. They must agree:
// this constant is what the Slack `cap` field and the persisted message report,
// while the pure function is what actually decides. Flooring here at 1 while the
// decision floors at 2 meant VIDEO_UNSETTLED_MAX_ATTEMPTS=1 produced correct
// BEHAVIOUR (a first timeout still holds) with LYING diagnostics — logs and
// alerts claiming a cap of 1 that nothing enforced. A stage line that
// under-reports the real rule misdirects whoever reads it at 3am. Found by
// adversarial review 2026-08-27.
const UNSETTLED_TIMEOUT_MAX_ATTEMPTS = Math.max(
  2,
  parseInt(process.env.VIDEO_UNSETTLED_MAX_ATTEMPTS, 10) || 3
);

/**
 * Settle a video master whose poll hit MAX_POLL_MS while Atlas was still
 * working. Replaces an unconditional release-the-claim requeue that had no
 * lifetime bound (see processAd's caller comment for the measured incident).
 *
 * THE MONEY INVARIANT: never make a receipt-holding row claimable again.
 *
 * A released claim on a `status:'rendering'` row is, by claimOne's own filter
 * ({status:'rendering', claimedByWorker:null, renderRoute:{$in:[...]}}), an
 * immediate invitation to re-enter renderVideo -> generateForAd. Even though
 * that re-entry SHOULD resume from the receipt for free, "should" is doing
 * load-bearing work across two files and four conditions, and the measured
 * outcome was ten billable submits. So this stops relying on the downstream
 * gate to be the only thing between a requeue and a second charge:
 *
 *   receipt present  -> DO NOT release the claim. Leave the row claimed and
 *                       'rendering'. That is exactly the resting state
 *                       spendReceipt.js already prescribes and the SIGKILL
 *                       drain handler (:2160-2180) already implements for the
 *                       same reason, in its own words: "Receipt-HOLDING ads
 *                       deliberately stay claimed and `rendering`. That is the
 *                       honest state ... and it preserves the receipt so the
 *                       asset can be recovered for free rather than re-bought."
 *                       bootRecoveryService then owns it, and it DOES still
 *                       sweep a claimed row — but read the condition, because
 *                       this comment used to state it wrongly. Its selector
 *                       (buildRecoverySweepFilter, bootRecoveryService.js:178)
 *                       became claim-AWARE in PR #75, which landed underneath
 *                       this branch. Alongside the unclaimed arm it carries
 *                       `{claimedByWorker:{$ne:null}, updatedAt:{$lt:claimCutoff},
 *                       claimedAt:{$lt:claimCutoff}}`, plus a third arm for a
 *                       claim with no `claimedAt` at all. So a held row is
 *                       swept once BOTH clocks are stale, on the longer
 *                       RESUME_CLAIM_STALE_MIN window — NOT on `updatedAt`
 *                       alone, which is what the pre-#75 selector needed and
 *                       what this passage previously claimed.
 *                       Satisfied here rather than assumed: a held row's
 *                       `claimedAt` is already ~15 min old, because the Atlas
 *                       poll ran under this very claim. Verified against the
 *                       MERGED #75 file during the rebase, not predicted from
 *                       its branch; harness C5 asserts the invariant (a
 *                       claimed, stale, receipt-holding row must be sweepable)
 *                       across both selector shapes rather than either
 *                       spelling. Ad.js sets `timestamps: false` (:738), so the
 *                       $inc below does not bump updatedAt and does not itself
 *                       restart that clock; and the per-ad beat is already
 *                       stopped, because startAdHeartbeat's `beat.stop()` sits
 *                       in the render path's `finally` (~:1517) and therefore
 *                       ran when the throw left renderVideo, before this
 *                       function was called.
 *                       Outcome: Atlas settles, and the sweep either collects
 *                       the paid master for $0 or reconciles the ledger to a
 *                       confirmed non-charge. Zero further submits.
 *
 *                       HONEST LIMITATION — recovery is not necessarily PROMPT.
 *                       The per-RUN heartbeat also writes ads: acquireRunHeartbeat
 *                       seeds the ticker with `Ad.find({campaignRunIds: runId})`
 *                       — EVERY ad of the run — and campaignRunHeartbeat beats
 *                       `{_id:{$in:adIds}, status:'rendering'}`. A held row
 *                       matches both, so while this worker still has ANY ad of
 *                       the same run in flight (`runIsWorking`, refcounted by
 *                       runInflight), the held row's updatedAt keeps being
 *                       refreshed and bootRecoveryService's staleness window
 *                       cannot open. Once the run's last ad settles here the
 *                       ticker stops and the clock finally runs. So free
 *                       collection can be delayed by the remainder of the run —
 *                       which is survivable and strictly better than the old
 *                       behaviour, because the delay costs only poll-free
 *                       waiting while the old path spent a fresh submit every
 *                       cycle. Narrowing the run ticker's Ad population to ads
 *                       actually in flight would fix the delay, but it is a
 *                       liveness mechanism shared with titler.js and belongs in
 *                       its own change, not smuggled into a money fix.
 *
 *   no receipt       -> nothing was paid for, so releasing is safe. Kept so a
 *                       genuinely receipt-free timeout still behaves as before.
 *
 * ⚠️  WHAT BOUNDS WHAT — an earlier version of this comment claimed "both arms
 * are bounded by UNSETTLED_TIMEOUT_MAX_ATTEMPTS". That was FALSE in precisely
 * the way the bug it fixes was false, and adversarial review (Grok xhigh,
 * 2026-08-27) caught it. Stated properly:
 *
 *   - RELEASE is bounded by the cap. It makes the row claimable, so a re-entry
 *     increments the counter, and the cap ends it.
 *   - HOLD is NOT bounded by the cap, and structurally cannot be: holding keeps
 *     the claim, claimOne cannot re-take the row, so nothing re-enters, so
 *     renderAttempts is $inc'd exactly once and `attempts >= cap` is
 *     unreachable. The cap still earns its place on this arm as a backstop
 *     against re-entry driven by something else (a future claim-TTL sweeper, any
 *     new requeue path) — but it is not what ends a hold.
 *   - A HOLD is bounded by bootRecoveryService settling the prediction. If that
 *     sweep is switched off, nothing bounds it at all, which is why
 *     freePollerEnabled is passed to the decision and returns 'terminal'
 *     instead of parking.
 *   - RESIDUAL, NAMED not hidden: a prediction Atlas NEVER settles parks
 *     indefinitely even with the sweep on (its 'processing' arm deliberately
 *     leaves such rows alone, and its Slack report gates on
 *     recovered+failed+recoverableNotCollected so `stillRunning` never pages).
 *     This function therefore fires its OWN per-ad alert on every hold, so the
 *     park is visible rather than silent. A periodic terminal sweeper for that
 *     residual case is a follow-up, not something this change pretends to have.
 *
 * renderAttempts is $inc'd on EVERY pass through here. That matches the field's
 * documented meaning — models/Ad.js:592 "counts every attempt that STARTED a
 * render (submit/generation actually reached)" — which a timed-out submit
 * plainly did. It is deliberately NOT deriveWaitAttempts: that field exists for
 * the wait-only derive path which "never submits anything, never bills"
 * (models/Ad.js:681-690), the exact opposite of this path.
 */
async function settleUnsettledVideoTimeout(ad, err) {
  const shortId = String(ad._id).slice(-6);

  // Prefer the id the throw carries — that is the prediction THIS attempt
  // actually polled. Fall back to the doc's stamp.
  const receipt =
    (typeof err.predictionId === 'string' && err.predictionId && err.predictionId) ||
    (typeof ad.veoPredictionId === 'string' && ad.veoPredictionId && ad.veoPredictionId) ||
    null;

  // COUNT IT, and read the post-image back so the cap sees a real number
  // rather than a stale in-memory one. Unscoped by claim on purpose: the
  // count must land even if the claim moved underneath us.
  //
  // KNOWN CONFLATION, documented rather than hidden: renderAttempts counts
  // RENDER STARTS, not timeout-branch entries — the completion writes at
  // :975/:1193/:1460 $inc it too. A first-time master is unaffected (0 -> 1, so
  // it holds), and every other reader of the field is status:'queued'-scoped, so
  // this increment is strictly safer for them (nonzero means "work started").
  // The narrow bad case is an ad re-entering renderer with a nonzero stored
  // count, which could escalate or terminal on its FIRST timeout. The real fix
  // is a dedicated timeout counter, but that needs a DECLARED schema path and
  // verifyModelParity asserts adgen's paths are a SUBSET of the backend's — so
  // it is a coordinated cross-repo change, not a unilateral one. Raised by
  // adversarial review 2026-08-27 and deliberately left as a tradeoff.
  let attempts = 1;
  try {
    const after = await Ad.findOneAndUpdate(
      { _id: ad._id },
      { $inc: { renderAttempts: 1 } },
      { new: true, projection: { renderAttempts: 1 } }
    ).lean();
    const n = Number(after && after.renderAttempts);
    if (Number.isFinite(n) && n > 0) attempts = n;
  } catch (e) {
    console.warn(`renderer[${WORKER_ID}]: could not $inc renderAttempts for ${shortId} — ${e.message}`);
  }

  // ESCALATE A REPEAT. notifyRenderFailure already fired a warn keyed on the
  // message (`video-unsettled:${msg.slice(0,60)}`), which folds a wide
  // Atlas-side fault across many ads into one Slack message — deliberate, and
  // left alone. But that key carries the prediction id, so it does NOT fold
  // repeats of the SAME ad, and nothing distinguished "one slow render" from
  // "this row has done it three times". This ad-scoped error does.
  if (attempts > 1) {
    alerts.notifyAsync({
      level: 'error',
      title: 'Video master has hit the poll timeout repeatedly — possible re-claim loop',
      key:   `video-unsettled-repeat:${ad._id}`,
      fields: {
        ad:           String(ad._id),
        run:          runIdOf(ad) || null,
        attempts:     String(attempts),
        cap:          String(UNSETTLED_TIMEOUT_MAX_ATTEMPTS),
        predictionId: receipt
      }
    });
  }

  // THE DECISION IS PURE AND LIVES IN spendReceipt.js — see
  // resolveUnsettledTimeoutAction's doc comment. Required locally, matching the
  // existing lazy require of this same module in the shutdown handler below.
  const { resolveUnsettledTimeoutAction } = require('./spendReceipt');
  // WHETHER THE FREE POLLER IS ACTUALLY RUNNING is an INPUT, not an assumption.
  // Parking a paid row is only safe if something will come back for it; with
  // RESUME_IN_FLIGHT_ON_BOOT=false nothing does (the reaper skips claimed rows,
  // the shutdown drain only releases receipt-free ones, and bootRecovery's
  // still-processing count never pages), so the decision has to know.
  let freePollerEnabled = true;
  try {
    freePollerEnabled = require('./bootRecoveryService').enabled();
  } catch (e) {
    // Fail towards NOT parking: if we cannot tell, do not bet a paid asset on a
    // sweep that may not exist.
    freePollerEnabled = false;
    console.warn(`renderer[${WORKER_ID}]: could not read bootRecovery enabled() — ${e.message}`);
  }
  const decision = resolveUnsettledTimeoutAction({
    receipt,
    attempts,
    cap: UNSETTLED_TIMEOUT_MAX_ATTEMPTS,
    freePollerEnabled
  });

  // ── CAP REACHED — terminal, receipt preserved ─────────────────────────────
  if (decision.action === 'terminal') {
    // SAY WHICH terminal this is. 'cap-reached' and 'no-free-poller' are very
    // different operator stories — one means a row cycled, the other means the
    // free-recovery sweep is switched off and parking would have stranded a paid
    // asset silently. A generic message would send someone hunting the wrong one.
    const message = decision.reason === 'no-free-poller'
      ? `video master unsettled at Atlas and the free receipt sweep is DISABLED ` +
        `(RESUME_IN_FLIGHT_ON_BOOT=false) — failing instead of parking, because nothing ` +
        `would ever collect it; receipt ${receipt || 'absent'} preserved for reconciliation`
      : `video master still unsettled at Atlas after ${attempts} poll timeout(s) ` +
        `(cap ${UNSETTLED_TIMEOUT_MAX_ATTEMPTS}) — not re-queued; ` +
        `receipt ${receipt || 'absent'} preserved for reconciliation`;
    await Ad.updateOne(
      // CLAIM-SCOPED, matching the ordinary terminal write below rather than
      // the looser `{_id, status}`. bootRecoveryService's persist uses that same
      // loose shape, so two writers with no owner check can race: this write
      // could stamp 'failed' while a concurrent sweep is mid-peek on a
      // prediction that then settles 'done', and the sweep's own status-guarded
      // $set would silently no-op — a paid, delivered output recorded as failed
      // with chargeState 'unknown'. Dormant today (the cap cannot fire on a
      // clean first-time master) but free to close, and the nearby write already
      // demonstrates the safer filter. Found by adversarial review 2026-08-27.
      { _id: ad._id, claimedByWorker: WORKER_ID, status: 'rendering' },
      {
        $set: {
          status:             'failed',
          claimedByWorker:    null,
          claimedAt:          null,
          // Same clears the ordinary terminal write below makes, for the same
          // reasons (backlogWatchdog[titling-stuck], live-elapsed-timer UI).
          titlingResumeState: null,
          titlingNeeded:      false,
          renderStage:        'done',
          renderStageAt:      new Date(),
          updatedAt:          new Date(),
          renderError: {
            message,
            stage:        'render',
            at:           new Date(),
            // THE RECOVERY HANDLE. Atlas retains predictions ~30 days, so this
            // is what lets imageRecoveryService.settleChargeState (and a human)
            // answer "did this cost us money?" after the fact.
            predictionId: receipt,
            // 'unknown', NEVER 'not-charged'. We timed out without a verdict;
            // absence of evidence is not evidence of non-charge, and
            // understating the ledger is the one direction that never gets
            // corrected because nothing knows to go looking (models/Ad.js).
            chargeState:  'unknown',
            code:         err.code || null
          }
        }
      }
    );
    await bumpRunCounter(ad.campaignRunIds, 'failed');
    noteFeedEvent(ad, `failed — ${message.slice(0, 80)}`);
    console.error(`renderer[${WORKER_ID}]: ${shortId} ${message}`);
    return;
  }

  // ── RECEIPT PRESENT — hand to the free poller, do NOT release ────────────
  if (decision.action === 'hold') {
    // PERSIST THE RECEIPT IF THE CHARGE POINT DID NOT. atlasVideoService's
    // veoPredictionId $set is deliberately best-effort — wrapped in a non-fatal
    // try/catch, because "a telemetry or bookkeeping failure must never fail a
    // generation post-payment". So a genuinely BILLED prediction can exist only
    // on the thrown Error. spendReceipt.HAS_RECEIPT matches the MONGO field, so
    // parking such a row would make it invisible to the very sweep we are handing
    // it to: claim held, money spent, nothing ever coming back. Found by
    // adversarial review 2026-08-27.
    //
    // Guarded THREE ways: owner-scoped (we still hold the claim), only when the
    // stored field is genuinely empty (never overwrite a newer receipt), and
    // non-fatal (a failure here must not turn a parked row into an exception).
    if (receipt && !ad.veoPredictionId) {
      try {
        await Ad.updateOne(
          { _id: ad._id, claimedByWorker: WORKER_ID, veoPredictionId: { $in: [null, ''] } },
          { $set: { veoPredictionId: receipt } }
        );
      } catch (e) {
        console.warn(
          `renderer[${WORKER_ID}]: could not backfill veoPredictionId=${receipt} on ${shortId} ` +
          `— ${e.message}; the free sweep may not see this paid row`
        );
      }
    }

    // bumpRunCounter('skipped') is kept from the original branch and is still
    // safe: maybeFinalizeRun re-derives isSettled from a LIVE Ad.find, and
    // classifyRunAdOutcome buckets status:'rendering' as stillRendering, so
    // the run cannot finalize while this row sits here regardless of what the
    // counter says. It also refreshes the CampaignRun heartbeat.
    await bumpRunCounter(ad.campaignRunIds, 'skipped');
    noteFeedEvent(ad, 'unsettled at poll timeout — awaiting free receipt recovery');

    // MAKE THE PARK VISIBLE. A held row is silent otherwise: bootRecovery's
    // Slack report gates on `recovered + failed + recoverableNotCollected`, so
    // its `stillRunning` count never pages; there is no periodic
    // ALERT_RENDERING_STALE_MIN scanner in this repo (only boot-time
    // alertOrphanedClaimsOnBoot); and the attempt-cap escalation below cannot
    // fire on this arm, because holding prevents the re-entry that would
    // increment the counter. So without this, a paid master parked indefinitely
    // — including one Atlas never settles — looks exactly like nothing
    // happening. Ad-scoped key: repeats for the same ad fold, different ads do
    // not, which is the opposite of the message-keyed warn's behaviour and the
    // right choice for a per-row park.
    alerts.notifyAsync({
      level:  'warn',
      title:  'Video master parked on its spend receipt — awaiting free recovery',
      key:    `video-unsettled-parked:${ad._id}`,
      fields: {
        ad:           String(ad._id),
        run:          runIdOf(ad) || null,
        predictionId: receipt,
        attempts:     String(attempts),
        note:         'claim intentionally held so nothing can resubmit; bootRecovery polls this for $0'
      }
    });

    console.warn(
      `renderer[${WORKER_ID}]: ${shortId} unsettled at poll timeout (attempt ${attempts}) — ` +
      `KEEPING claim on receipt ${receipt}; bootRecovery will poll it for free. Not re-queued.`
    );
    return;
  }

  // ── NO RECEIPT — nothing paid for, releasing is safe ─────────────────────
  await releaseClaim(ad._id, `video master unsettled at poll timeout, no receipt (attempt ${attempts}/${UNSETTLED_TIMEOUT_MAX_ATTEMPTS})`);
  await bumpRunCounter(ad.campaignRunIds, 'skipped');
}

// End-to-end render for one claimed ad. Wrapped so poll() can dispatch
// via .finally() without holding the poll loop.
async function processAd(ad) {
  const started = Date.now();
  const runHeartbeat = await acquireRunHeartbeat(runIdOf(ad));
  try {
    try {
      noteFeed(ad, `claimed by ${WORKER_ID}`);
      if (ad.renderRoute === 'html_gen') {
        await renderStatic(ad);
      } else if (ad.renderRoute === 'veo') {
        await renderVideo(ad);
      } else {
        throw new Error(`unknown renderRoute: ${ad.renderRoute}`);
      }
    } catch (err) {
      const shortId = String(ad._id).slice(-6);
      const wallSec = ((Date.now() - started) / 1000).toFixed(1);
      console.error(`renderer[${WORKER_ID}]: render failed ad=${shortId} route=${ad.renderRoute} wall=${wallSec}s: ${err.message}`);
      if (err && err.stderrTail) {
        console.error(`renderer[${WORKER_ID}]: child stderrTail ad=${shortId}:\n${err.stderrTail}`);
      }
      // SKIP when the error already went through
      // brandScriptExecutor.stampTitlingFailureAndThrow (present whenever
      // err.titlingFailureKind is set) — that function already persisted a
      // MORE SPECIFIC renderError on this exact row (stage:'titling', the
      // real code, and the attempt-cap count) before rethrowing. Only a
      // titlingResumable===false (cap-exceeded, terminal) error reaches this
      // catch at all — a resumable one returns early at the renderer.js
      // call site — but noteRenderIssue's write is UNSCOPED (no claim
      // filter, unlike the terminal $set below) and unconditionally
      // OVERWRITES renderError wholesale (adStage.js), so without this guard
      // it clobbers the stamp's detailed message/code with a generic
      // stage:'render' one carrying no code and no cap-count — a real
      // diagnostics regression a titling failure never used to risk before
      // this fix (OOM previously never reached this catch at all). Every
      // OTHER failure kind (a genuine render/static/pre-titling error) is
      // unaffected — it never carries this field.
      if (!err.titlingFailureKind) {
        try {
          noteRenderIssue(ad._id, {
            message: err.message,
            stage: 'render',
            predictionId: (err && err.predictionId) ? err.predictionId : undefined,
            err
          });
        } catch (_) {}
      }
      notifyRenderFailure(ad, err);
      noteFeedEvent(ad, `failed — ${String((err && err.message) || err).slice(0, 80)}`);

      // UNSETTLED AT TIMEOUT — NOT a confirmed failure. pollPrediction hit
      // its own MAX_POLL_MS wall-clock budget while the Atlas job was still
      // genuinely processing. That ceiling was 600s and is now 900s, sized from
      // the measured distribution (n=68: mean 229.7s, sd 124.5s, max 760.3s —
      // see atlasVideoService.js's MAX_POLL_MS comment). 600s sat at mean+2.97sd
      // with the observed maximum already past it, so this branch fired on
      // renders that were going to succeed. It can still fire: 900s is p99.84,
      // not p100, which is exactly why the receipt handling below matters.
      // Writing status:'failed' here would strand the whole
      // point of the resume-from-receipt fix: shouldResumeAttempt
      // (atlasVideoService.js) only fires on a FRESH attempt against a row
      // that gets re-entered — a row stamped 'failed' is never re-entered
      // by anything.
      //
      // ⚠️  THE COMMENT THAT USED TO BE HERE WAS FALSE, AND THAT IS WHY THIS
      //     INCIDENT STAYED INVISIBLE. It asserted that releasing the claim
      //     and leaving status:'rendering' meant the next processAd "resumes
      //     the SAME prediction — re-polling, never resubmitting, so this can
      //     only ever cost more poll time, never a second charge."
      //
      //     Measured 2026-08-26 (run 2h21m, master 6a8fb12ad0621a3e8f4a7d49):
      //     TEN DISTINCT Atlas prediction ids, a fresh billable submit roughly
      //     every 12-14 minutes, none completing, 17 derives pinned behind it.
      //
      //     BE PRECISE ABOUT WHICH HALF WAS FALSE — the next reader will trust
      //     whichever version is left here.
      //
      //     TRUE, of the RETRY LADDER inside one generateForAd call. That ladder
      //     genuinely cannot resubmit after a deadline. mayRetryAfterFailure
      //     (atlasVideoService.js) requires
      //     `policyRetryable === true && chargeConfirmed === false`, and neither
      //     deadline shape can satisfy it: the terminal-failure-at-deadline
      //     branch sets `policyRetryable = false` / `policyMaxAttempts = 1`
      //     outright ("deadline already reached; never resubmit from this path",
      //     :3928-3929), and OUR shape — still 'processing' — simply never sets
      //     policyRetryable at all, leaving it undefined, with
      //     chargeConfirmed null. Both are refused, by explicit false in one
      //     case and by omission in the other. shouldResumeAttempt is likewise
      //     correct: allowResume && attempt===1 && a non-empty receipt, with
      //     renderer.js passing allowResume:true explicitly and veoPredictionId
      //     declared (models/Ad.js:416) so the charge-point $set really lands.
      //     A re-entry that SEES the receipt does resume for free.
      //
      //     FALSE, of the CLAIM BOUNDARY one level up — where the loop actually
      //     lived. Terminating the ladder is not the same as terminating the
      //     work. Releasing the claim while leaving status:'rendering' starts a
      //     BRAND NEW attempt, with a fresh attempt counter and its own fresh
      //     retry policy, and that attempt submits. So the ladder behaved exactly
      //     as designed and documented while the row cycled anyway. Nothing at
      //     the claim boundary bounded ANYTHING: no lifetime cap, no deadline,
      //     and renderAttempts never moved (it is $inc'd only by the COMPLETION
      //     writes at :975/:1193/:1460, never on this path), so the row stayed
      //     re-eligible for claimOne forever while every attempt-shaped guard in
      //     the service read 0 attempts.
      //
      //     THE FIX THEREFORE BELONGS AT THE CLAIM BOUNDARY, not in the ladder —
      //     bounding retries inside code that is already correct would have
      //     changed nothing. Same shape the regenerate path is PROPOSED to use
      //     for its own reclaim loop (ADGEN_REGEN_MAX_RECLAIMS, a doc-persisted
      //     count checked before any submit) — on the still-open, unmerged PR
      //     #76, NOT on master. Corrected 2026-08-27: this line previously read
      //     "already uses", and master's regenerate claim in fact has no reclaim
      //     loop at all (regenerateConsumer.js:41-54).
      //
      //     And the free recovery this branch delegated to was structurally
      //     unreachable: bootRecoveryService selects
      //     {status:'rendering', updatedAt < now-RESUME_STALE_MIN, HAS_RECEIPT}
      //     (bootRecoveryService.js:162). The ad heartbeat (:1277) refreshes
      //     updatedAt every 60-90s precisely so a LIVE render never looks
      //     stale — so an ad that is re-claimed within seconds of each release
      //     never once sat still for the 5 minutes that free poller needs. The
      //     mechanism that was supposed to collect this asset for $0 could
      //     never see it.
      //
      // WHAT THIS DOES NOW. Hand the row to the free receipt poller instead of
      // back to claimOne, and bound the branch. See
      // settleUnsettledVideoTimeout below for the full reasoning.
      if (err && err.unsettledAtTimeout) {
        await settleUnsettledVideoTimeout(ad, err);
        return;
      }

      // ── STATIC RESUME (#74) — A SEPARATE BRANCH, DELIBERATELY *NOT* ROUTED
      //    THROUGH settleUnsettledVideoTimeout ABOVE ───────────────────────
      //
      // These two conditions shared ONE branch until this PR split them, and
      // they must STAY split. They are structurally disjoint — one per route:
      // err.unsettledAtTimeout is set ONLY by atlasVideoService (:3945, the
      // video poll deadline); err.unsettledAtResume ONLY by atlasImageService
      // (:726, an ambiguous static resume poll). No error can carry both, so
      // the order of these two ifs is not load-bearing — but the separation is.
      //
      // settleUnsettledVideoTimeout is video-specific by construction AND by
      // name: it backfills veoPredictionId, writes a video-shaped renderError
      // (predictionId + chargeState) and reports against the VIDEO poll
      // ceiling. Sending a static resume through it would be wrong in a
      // different way than the bug this PR fixes. So the static path keeps
      // #74's release-and-leave-rendering treatment verbatim, and #74's
      // reasoning for it is preserved below rather than summarised away.
      //
      // err.unsettledAtResume is the STATIC counterpart, added alongside
      // atlasImageService.shouldResumeImageAttempt / submitAndPollWithResume
      // (adversarial review, Grok xhigh): a resumed static prediction whose
      // poll came back AMBIGUOUS (no err.policy at all — a raw network
      // exception off the poll GET — or a probe-class Atlas verdict like
      // serverError/gatewayTimeout, where the true outcome is genuinely
      // unknown) must not be terminal-failed either — mayResubmit already
      // refused a second submit, so nothing here is unsafe, but writing
      // status:'failed' would strand the receipt exactly like the video
      // case above: bootRecoveryService only ever looks at status:'rendering'
      // rows. Same release-and-leave-rendering treatment, so a future
      // claimOne() re-entry (or bootRecoveryService's own sweep) gets
      // another free look at the SAME receipt. Deliberately EXCLUDES a
      // genuinely deterministic verdict (err.policy.terminal — bad
      // credentials, a moderation block) — atlasImageService itself never
      // sets unsettledAtResume for those, so they fall through to the
      // ordinary terminal-failure write below, same as today.
      //
      // bumpRunCounter('skipped') is safe here even though the Ad's true
      // fate is still pending: maybeFinalizeRun re-derives isSettled from a
      // LIVE Ad.find, and classifyRunAdOutcome buckets status:'rendering'
      // as stillRendering — so the run cannot finalize while this row sits
      // here, regardless of what the 'skipped' counter says.
      //
      if (err && err.unsettledAtResume) {
        await releaseClaim(
          ad._id,
          'static resume — poll outcome ambiguous, left rendering for a future resume/recovery'
        );
        await bumpRunCounter(ad.campaignRunIds, 'skipped');
        return;
      }

      await Ad.updateOne(
        { _id: ad._id, claimedByWorker: WORKER_ID },
        {
          $set: {
            status:          'failed',
            claimedByWorker: null,
            claimedAt:       null,
            // Clear the titling-debt marker on terminal failure — otherwise
            // backlogWatchdog[titling-stuck] pages forever on 'claimed' ads
            // that already died. Measured 2026-08-25: 44 failed ads (yesterday's
            // Pelagic run + earlier) stuck in state='claimed' because this catch
            // stamps failed but doesn't touch titlingResumeState, so the OLD
            // renderer's stamp of 'claimed' before the throw survives the terminal
            // write. Cleared here too (same shape as titlingNeeded below) so any
            // future bubbled titling failure lands clean.
            titlingResumeState: null,
            titlingNeeded:      false,
            // Terminal stage — this ad is done (definitively failed, status
            // already carries that); without this it kept showing whatever
            // in-flight stage it died mid-transition, forever, in the
            // frontend's live-elapsed-timer UI. Same fix as
            // settleNonDraftTerminal's — see that function's comment.
            renderStage:        'done',
            renderStageAt:      new Date(),
            renderError:     {
              message: String(err.message || err).slice(0, 400),
              stage: 'render',
              at: new Date(),
              code: err.code || null,
              ...childTailsFrom(err)
            },
            // PERSIST THE QC VERDICT ON A TERMINAL FAILURE.
            //
            // directImageRenderService attaches `err.visionQc` on a
            // QC-exhausted static, with the explicit comment "surface that +
            // the verdict (with discarded URLs) so the failure path can
            // persist them". THIS is that failure path, and it dropped it.
            // renderError.message survived, so the failure looked
            // investigable right up until you tried to see the pixels that
            // caused it — visionQc was null and the discarded attempt URLs
            // were gone with it.
            //
            // Measured twice, in two separate E2E rounds: three statics
            // rejected for inventing a brand wordmark on the product, none
            // re-examinable; then the same wall again adjudicating
            // logo-occlusion catches. Both investigations degraded to quoting
            // the judge's prose instead of looking at the image.
            //
            // The VIDEO path has done this correctly since #282 —
            // brandScriptExecutor's
            //   $set: { visionQc, ...buildVideoQcFailureFields(...) }
            // This is the static half of the same idea, not a new mechanism.
            //
            // CONDITIONAL, not unconditional. Most terminal failures here
            // carry no verdict at all — a provider timeout, an unreachable
            // seed, an IPC error. Writing the key regardless would replace a
            // real earlier verdict with null on a later non-QC failure of the
            // same ad, which is worse than not writing it.
            ...(err.visionQc ? { visionQc: err.visionQc } : {}),
            updatedAt:       new Date()
          }
        }
      ).catch(() => {});
      await bumpRunCounter(ad.campaignRunIds, 'failed');
    }
  } catch (err) {
    // DEAD TODAY, AND DELIBERATELY KEPT — same as backend routes/ads.js's
    // runRenderLoop catch. The inner catch swallows render failures, so this
    // arm only fires if the inner catch itself throws. What it buys is that
    // the invariant survives an edit: a rejection would otherwise skip the
    // still-beating timer and keep a crashed run out of the reaper's reach.
    // stop() is idempotent, so the pair with finally costs nothing.
    runHeartbeat.stop();
    throw err;
  } finally {
    runHeartbeat.stop();
  }
}

async function poll() {
  const start = Date.now();
  try {
    if (!isAdgenRendererEnabled()) {
      resetReconnectAttempts();
      scheduleNext(start);
      return;
    }

    // Burst-claim: keep pulling ads while there's spare capacity. Each
    // claim is an atomic findOneAndUpdate (fast ~ms) and the render fires
    // as an unawaited promise so N concurrent renders share this single
    // Node event loop. Loop guarded by MAX_INFLIGHT so we never over-
    // subscribe local resources (Sharp memory, Remotion pool, etc).
    while (inFlight < MAX_INFLIGHT) {
      const ad = await claimOne();
      if (!ad) break;   // queue empty for now — next poll will re-check
      inFlight++;
      // Fire-and-forget: processAd manages its own error state and Ad row.
      // .finally releases the slot regardless of outcome.
      processAd(ad).finally(() => { inFlight--; });
    }
    resetReconnectAttempts();
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: poll error — ${err.message}`);
    if (isStaleTopologyError(err)) {
      reconnectAfterStaleTopology();
    }
  }
  scheduleNext(start);
}

function scheduleNext(startTs) {
  const elapsed = Date.now() - startTs;
  const wait = Math.max(50, POLL_MS - elapsed);
  if (!stopping) setTimeout(poll, wait);
}

// ── TITLING RESUME SWEEP ────────────────────────────────────────────────
//
// Runs titlingResumeService.resumeUntitledMasters() from THIS role, not
// orchestrator. First draft of this fix put it on orchestrator specifically
// because render.yaml keeps that role singleton — but orchestrator's own
// plan is `starter` (~512 MB), while a single Remotion titling slot has been
// MEASURED at ~1.97 GiB (see REMOTION_QUEUE_CONCURRENCY's own comment,
// above). resumeUntitledMasters() calls renderBrandScriptAndSave for real —
// it is not a dry pass — so the very first ad it actually retitled would
// have OOM-killed the orchestrator process itself. Caught in adversarial
// review before this ever deployed; renderer is `pro_plus` (8 GB) and
// already budgets exactly this cost via REMOTION_QUEUE_CONCURRENCY, so
// running the sweep here shares the SAME governed Remotion pool instead of
// spawning an ungoverned one on a box sized for a read-only poll loop.
//
// AUTOSCALED (min2/max8), unlike orchestrator — but that is fine:
// titlingResumeService's own per-document CAS claim (buildResumeFilter +
// a conditional Ad.updateOne whose filter reproduces the exact prior state)
// is what makes two instances racing the SAME ad safe, not "only one
// process ever runs this." Proven with two REAL concurrent
// resumeUntitledMasters() calls racing one ad
// (scripts/verifyTitlingRecoverability.js, section C). Redundant `Ad.find`
// reads across up to 8 instances on a 5-minute interval are cheap; a
// double-titled ad is not possible because of the claim, and an
// OOM-crashing sweep host is a guaranteed failure, not a shared-resource
// nicety — the tradeoff is not close.
//
// Still gated on ADGEN_RENDERER_ENABLED (same flag PR #52 wired into
// claimOne()) so it cannot race backend's own render/resume path over the
// shared collection when adgen is not the active renderer, and still
// re-entrancy-guarded (a single Remotion render has been measured at 76s;
// TITLING_RESUME_MAX defaults to 5/pass, so a pass can outlast the
// interval — a second concurrent pass on the SAME instance would stack
// Remotion renders on top of the poll loop's own MAX_INFLIGHT budget).
// Boot-recovery sweep. Wired 2026-08-26 to close the 273-minute-tail defect
// measured on run_1787699482964: master cb7a91 was left status:'rendering'
// with claimedBy=renderer-7364c5b1 after that worker died mid-generate. The
// receipt (veoPredictionId) was intact, but nothing on adgen was reaping it.
// Backend's bootRecoveryService runs against the same collection UNGATED on
// ADGEN_RENDERER_ENABLED (see the ADGEN_RENDERER_ENABLED comment further
// above in this file) — but only on backend's own web boot, which is a
// rare event during a busy adgen day, so the recovery gap was hours long.
//
// bootRecoveryService is money-safe by construction (see its own header):
// it ONLY touches ads with a spend receipt (veoPredictionId /
// imageGeneration.predictionId) that have been status:'rendering' with a
// stale updatedAt beyond RESUME_STALE_MIN (default 5min = five missed 60s
// heartbeats). Peeks the paid prediction with a GET, either fetches/uploads
// the finished asset or terminal-fails the row — never re-submits. Safe to
// run redundantly across autoscaled instances (its own header: "NO CLAIM,
// ON PURPOSE — the only provider call is a free GET").
//
// Two triggers:
//   1. BOOT — one immediate pass so a newly-booted renderer picks up an
//      orphan its dead predecessor left behind.
//   2. PERIODIC — every BOOT_RECOVERY_INTERVAL_MIN (default 5min). Covers
//      the autoscale-quiet case (long stretch with no new boots).
//
// Gated on isAdgenRendererEnabled() — same rationale as titlingResumeSweep:
// when the flag is OFF (rollback), the backend owns this collection and
// adgen must stand down.
function startBootRecoverySweep() {
  const { resumeInFlightAds } = require('./bootRecoveryService');
  const intervalMin = Math.max(1, parseInt(process.env.BOOT_RECOVERY_INTERVAL_MIN, 10) || 5);
  let inFlightPass = false;
  let timeoutHandle = null;
  let intervalHandle = null;

  const tick = () => {
    if (stopping || inFlightPass) return;
    if (!isAdgenRendererEnabled()) return;   // backend owns this collection right now
    inFlightPass = true;
    resumeInFlightAds()
      .then((out) => {
        if (out && (out.recovered || out.failed || out.stillRunning || out.recoverableNotCollected)) {
          console.log(
            `renderer[${WORKER_ID}]: boot recovery — considered=${out.considered} ` +
            `recovered=${out.recovered} failed=${out.failed} stillRunning=${out.stillRunning} ` +
            `recoverableNotCollected=${out.recoverableNotCollected || 0} unknown=${out.unknown || 0}`
          );
        }
      })
      .catch(err => console.warn(`renderer[${WORKER_ID}]: boot recovery failed — ${err.message}`))
      .finally(() => { inFlightPass = false; });
  };

  // Immediate pass on boot — catches orphans left by a dead predecessor.
  // Small delay (10s) so mongoose is fully connected and the renderer's own
  // heartbeat has fired at least once (avoids the sweep briefly seeing this
  // instance's own about-to-heartbeat ads as stale).
  timeoutHandle = setTimeout(tick, 10 * 1000);
  intervalHandle = setInterval(tick, intervalMin * 60 * 1000);
  if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();

  return {
    stop() {
      clearTimeout(timeoutHandle);
      clearInterval(intervalHandle);
    }
  };
}

function startTitlingResumeSweep() {
  // Lazy require — keeps titlingResumeService (and its own lazy require of
  // brandScriptExecutor) out of this module's own top-level require graph;
  // matches the pattern already used for qcAndStampVideoAd above.
  const { resumeUntitledMasters } = require('./titlingResumeService');
  const intervalMin = Math.max(1, parseInt(process.env.TITLING_RESUME_INTERVAL_MIN, 10) || 5);
  let inFlightPass = false;
  let timeoutHandle = null;
  let intervalHandle = null;

  const tick = () => {
    if (stopping || inFlightPass) return;
    if (!isAdgenRendererEnabled()) return;   // backend owns this collection right now
    inFlightPass = true;
    resumeUntitledMasters()
      .then((out) => {
        if (out && (out.titled || out.failed || out.skipped)) {
          console.log(
            `renderer[${WORKER_ID}]: titling resume — ${out.titled} titled · ` +
            `${out.failed} failed · ${out.skipped} skipped`
          );
        }
      })
      .catch(err => console.warn(`renderer[${WORKER_ID}]: titling resume failed — ${err.message}`))
      .finally(() => { inFlightPass = false; });
  };

  timeoutHandle = setTimeout(tick, 90 * 1000);
  intervalHandle = setInterval(tick, intervalMin * 60 * 1000);
  timeoutHandle.unref();
  intervalHandle.unref();

  return {
    stop() {
      clearTimeout(timeoutHandle);
      clearInterval(intervalHandle);
    }
  };
}

// Durable cost-reconcile sweep. The in-process setTimeout chain in
// atlasImageService.scheduleCostReconcile / atlasVideoService.scheduleVideoCostReconcile
// is the only mechanism that upgrades a charge-point CostLog row from
// costSource:'estimated' to Atlas's settled price. That chain dies with
// the process (deploy SIGTERM, OOM, crash) anywhere in its ~8.7 min
// window, leaving the row estimated forever — frequently ~33% HIGH
// (video MODEL_CAPS) or ~7x LOW (image base_price). This sweep is the
// durable backstop: it re-finds those rows in CostLog (no new schema)
// and peeks the free Atlas GET.
//
// Money-safe by construction (see costReconcileSweep.js header):
//   - only a free GET, never a billable POST
//   - write is costTracker.reconcileCost, which only upgrades
//     costSource:'estimated' (already-actual is a no-op)
//   - no claim/lease — two autoscaled instances racing the same row
//     at worst both $set the identical settled price
//
// Gated on isAdgenRendererEnabled() — same rationale as the other two
// sweeps: when the flag is OFF (rollback), the backend owns this
// collection and adgen must stand down. Initial delay 60s so this tick
// does not collide with boot-recovery (10s) or titling-resume (90s)
// on every boot.
function startCostReconcileSweep() {
  const { sweepCostReconcile } = require('./costReconcileSweep');
  const intervalMin = Math.max(1, parseInt(process.env.COST_RECONCILE_INTERVAL_MIN, 10) || 5);
  let inFlightPass = false;
  let timeoutHandle = null;
  let intervalHandle = null;

  const tick = () => {
    if (stopping || inFlightPass) return;
    if (!isAdgenRendererEnabled()) return;   // backend owns this collection right now
    inFlightPass = true;
    sweepCostReconcile()
      .then((out) => {
        if (out && out.considered > 0) {
          console.log(
            `renderer[${WORKER_ID}]: cost reconcile — considered=${out.considered} ` +
            `reconciled=${out.reconciled} stillPending=${out.stillPending} ` +
            `reportedUnbilled=${out.reportedUnbilled} errors=${out.errors}`
          );
        }
      })
      .catch(err => console.warn(`renderer[${WORKER_ID}]: cost reconcile failed — ${err.message}`))
      .finally(() => { inFlightPass = false; });
  };

  timeoutHandle = setTimeout(tick, 60 * 1000);
  intervalHandle = setInterval(tick, intervalMin * 60 * 1000);
  if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();

  return {
    stop() {
      clearTimeout(timeoutHandle);
      clearInterval(intervalHandle);
    }
  };
}

async function run() {
  const gated = isAdgenRendererEnabled();
  console.log(
    `renderer[${WORKER_ID}] starting — poll interval ${POLL_MS}ms, max-inflight ${MAX_INFLIGHT}, handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}`
  );
  // Sharp concurrency — see services/sharpConcurrency.js's header. This is
  // a NO-OP unless SHARP_CONCURRENCY is set; UV_THREADPOOL_SIZE (the other
  // half) must be an env var and is set in config/defaults.env.
  try {
    const { configureSharpConcurrency } = require('./sharpConcurrency');
    const sc = configureSharpConcurrency();
    if (sc.applied) console.log(`renderer[${WORKER_ID}] sharp.concurrency(${sc.value}) applied`);
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}] sharp concurrency setup failed — ${err.message}`);
  }
  // Fire-and-forget. Immediate pass catches already-cold orphans
  // (updatedAt already past HEARTBEAT_STALE_MIN — predecessor died well
  // before we started). A predecessor that died seconds before this boot
  // still looks alive (last beat ≤90s ago); the two-condition filter
  // cannot distinguish that from a live sibling until the silence window
  // elapses. One delayed rescan after HEARTBEAT_STALE_MIN + one clamped
  // beat: a live job will have kept beating, a dead one will not. unref
  // so the timer cannot hold the process open. Same key as the immediate
  // pass, so ALERT_DEDUPE_WINDOW_MIN (15) swallows a double-fire on a
  // cold orphan both scans would see.
  alertOrphanedClaimsOnBoot();
  const orphanRescanMs = HEARTBEAT_STALE_MIN * 60 * 1000 + AD_HEARTBEAT_SAFE_MAX_MS;
  const orphanRescan = setTimeout(() => { alertOrphanedClaimsOnBoot(); }, orphanRescanMs);
  if (typeof orphanRescan.unref === 'function') orphanRescan.unref();
  poll();
  setInterval(() => {
    if (stopping) return;
    const g = isAdgenRendererEnabled();
    console.log(`renderer[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s, inflight ${inFlight}/${MAX_INFLIGHT}, handoff ${g ? 'ON' : 'OFF'}`);
  }, 30_000).unref();
  titlingResumeSweep = startTitlingResumeSweep();
  bootRecoverySweep  = startBootRecoverySweep();
  costReconcileSweep = startCostReconcileSweep();
  // Ad-gen regenerate consumer (routing fix, 2026-08-26) — see
  // services/regenerateConsumer.js header for the full money argument.
  // Own poll loop, own {stop()}, same lifecycle shape as the sweeps
  // above; not folded into poll()/claimOne() above because its claim
  // filter is deliberately disjoint from the mint-time render claim.
  regenerateConsumer = require('./regenerateConsumer').start();
  // Ad-gen manual RE-TITLE consumer (2026-08-28) — see
  // services/retitleConsumer.js header for the full argument (a THIRD
  // independent claim namespace, not billable, safe to reclaim on a stale
  // claim unlike the regenerate consumer above).
  retitleConsumer = require('./retitleConsumer').start();
}

// Graceful shutdown. Render fires SIGTERM ~30s before SIGKILL on deploy /
// autoscale-down / instance replacement. Three responsibilities:
//   1. Stop the poll loop from claiming NEW ads (stopping=true — poll's
//      claim-loop bails, scheduleNext no-ops).
//   2. Give in-flight processAd() promises up to SHUTDOWN_DRAIN_MS to
//      settle. On terminal state they clear their own claim.
//   3. Any ad STILL claimed after the drain window is about to be SIGKILL'd —
//      release its claim so a peer can pick it up on next poll. Otherwise
//      it becomes a zombie for the reaper to clean up, and today the reaper
//      CAN'T (backend worker.js:1b692d1 — respects claimedByWorker != null
//      by design so live workers own their claims).
//
// Live proof this matters: three rolling deploys in 10 min accumulated 22
// zombie claims that blocked the queue.
const SHUTDOWN_DRAIN_MS = Number(process.env.ADGEN_SHUTDOWN_DRAIN_MS || 25_000);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (titlingResumeSweep) titlingResumeSweep.stop();
  if (bootRecoverySweep)  bootRecoverySweep.stop();
  if (costReconcileSweep) costReconcileSweep.stop();
  // regenerateConsumer.stop() is ASYNC — it runs its own internal drain
  // (same SHUTDOWN_DRAIN_MS budget, read independently) and alerts if a
  // regenerate is still in flight when that budget expires (see that
  // file's header — a video regenerate can run for minutes, so this is a
  // best-effort wait + loud flag, not a guarantee of a clean finish).
  // Started here WITHOUT awaiting so it runs CONCURRENTLY with the
  // mint-time drain loop below, not sequentially after it — otherwise a
  // renderer instance doing both kinds of work could take up to 2x
  // SHUTDOWN_DRAIN_MS to shut down. Awaited below, after that loop, so
  // shutdown() as a whole does not proceed to release claims / disconnect
  // Mongo until BOTH drains have had their full window.
  const regenerateStopPromise = regenerateConsumer ? regenerateConsumer.stop() : Promise.resolve();
  // retitleConsumer.stop() — same concurrent-drain reasoning as
  // regenerateConsumer's above. Not billable, so its own drain is a
  // shorter, best-effort wait (see that file's header) — still started
  // here, not sequenced after, for the same 2x-shutdown-time reason.
  const retitleStopPromise = retitleConsumer ? retitleConsumer.stop() : Promise.resolve();
  const t0 = Date.now();
  console.log(`renderer[${WORKER_ID}] shutting down — inflight=${inFlight}, drain up to ${SHUTDOWN_DRAIN_MS}ms`);
  const deadline = t0 + SHUTDOWN_DRAIN_MS;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  await regenerateStopPromise;
  await retitleStopPromise;
  const drainedMs = Date.now() - t0;
  if (inFlight > 0) {
    console.warn(`renderer[${WORKER_ID}] drain window elapsed (${drainedMs}ms), ${inFlight} still in flight — releasing claims for peer pickup`);
    try {
      // RECEIPT-AWARE. Releasing a claim on a `rendering` ad hands it straight
      // back to claimOne — its filter is {status:'rendering', claimedByWorker:
      // null, renderRoute:{$in:['html_gen','veo']}}, which is exactly the shape
      // this write produces. The peer that picks it up re-enters renderVideo /
      // renderStatic from the top and calls generateForAd / renderDirectImage
      // again.
      //
      // UPDATED — BOTH charge points now have a resume-from-receipt guard
      // (adversarial review, Grok xhigh, flagged this exact comment as
      // stale when the static half landed). Video's atlasVideoService
      // (shouldResumeAttempt reading ad.veoPredictionId — see processAd's
      // unsettledAtTimeout branch above, which relies on exactly this) has
      // had one since commit 2f99218 (PR #40); static's atlasImageService
      // (shouldResumeImageAttempt / submitAndPollWithResume reading
      // ad.imageGeneration.predictionId, wired through
      // directImageRenderService.renderDirectImage's existingPredictionId/
      // allowResume params — see processAd's unsettledAtResume handling)
      // closes the gap this comment used to describe as open. So a re-entry
      // on EITHER route would now resume the existing prediction rather than
      // buying the same generation a second time — this exclusion is no
      // longer required by an absent guard on either side.
      //
      // It is STILL kept, though, and deliberately: this filter is
      // conservative, not load-bearing. services/spendReceipt.js already
      // states the rule this must obey: "a requeue may only ever touch
      // RECEIPT-FREE ads". That module exists because providers charge at
      // SUBMIT, so a stamped predictionId means the money is gone whatever
      // happens next. RECEIPT_FREE covers BOTH charge points — Ad.veoPredictionId
      // (Omni video) and Ad.imageGeneration.predictionId (static gpt-image-2)
      // — and is shaped to treat null/'' as "no receipt", because the schema
      // default is null so a bare {$exists:false} would match almost nothing.
      //
      // Receipt-HOLDING ads deliberately stay claimed and `rendering`. That is
      // the honest state (the outcome genuinely is unknown until the receipt is
      // polled), it keeps them visible to ALERT_RENDERING_STALE_MIN, and it
      // preserves the receipt so the asset can be recovered for free rather
      // than re-bought. It does re-expose the zombie-claim problem this
      // shutdown handler was written to solve — but only for the subset that
      // has spent money, where paying twice is the worse outcome. Widening
      // this specific release to ALSO cover receipt-holding ads (now that a
      // resume guard exists on both routes) is a real, available follow-up —
      // not done here because it changes SIGKILL-time behavior beyond
      // generateForAd/renderDirectImage themselves and deserves its own
      // sign-off, separate from this fix.
      // USE THE COMPOSER, NOT A SPREAD. spendReceipt.js exports receiptFree()
      // for exactly this and says why: "Spread-merging would silently drop an
      // existing `$and`". `{ ...base, ...RECEIPT_FREE }` works only while the
      // base filter happens to have no $and of its own — the day someone adds
      // one, the receipt guard disappears with no error and no failing test,
      // and we are back to buying paid generations twice. receiptFree()
      // concatenates instead, so it stays correct under that edit.
      const { receiptFree } = require('./spendReceipt');
      const res = await Ad.updateMany(
        receiptFree({ claimedByWorker: WORKER_ID, status: 'rendering' }),
        { $set: { claimedByWorker: null, claimedAt: null, updatedAt: new Date() } }
      );
      const held = await Ad.countDocuments({ claimedByWorker: WORKER_ID, status: 'rendering' });
      console.warn(
        `renderer[${WORKER_ID}] released ${res.modifiedCount} receipt-free claim(s) on forced shutdown` +
        (held > 0
          ? ` — ${held} receipt-holding ad(s) deliberately KEPT claimed so a peer cannot re-submit a paid generation`
          : '')
      );
    } catch (err) {
      console.error(`renderer[${WORKER_ID}] release-on-shutdown failed: ${err.message}`);
    }
  } else {
    console.log(`renderer[${WORKER_ID}] clean drain in ${drainedMs}ms — no forced release needed`);
  }

  // Evict any reframe claims THIS process still holds. Without this, a
  // peer renderer that races us on the same media+aspect polls for ~6min
  // (26 attempts × 1s..26s backoff) before giving up and cropping.
  // MEASURED 2026-08-25: this single stall added ~350s to the master's
  // total wall clock on run_1787677348712_e426912d. Release is safe here
  // — atlasVideoService.releaseAllActiveReframeClaims() only touches
  // claim-only entries (no url yet). A billed reframe already persisted
  // its URL and the claim is gone from the registry, so this can never
  // steal a paid asset. Failures are logged but never block shutdown.
  try {
    const cleared = await atlasVideo.releaseAllActiveReframeClaims();
    if (cleared > 0) {
      console.log(`renderer[${WORKER_ID}] released ${cleared} reframe claim(s) so peers can proceed immediately`);
    }
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}] reframe-claim release-on-shutdown failed: ${err.message}`);
  }
}

module.exports = { run, shutdown };
