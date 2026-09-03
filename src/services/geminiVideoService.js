'use strict';
//
// geminiVideoService — direct Gemini Developer API video generation.
//
// Owner-directed cutover from Atlas. Costs are approved: Atlas settles at
// $0.90/master, Gemini measures $1.0351 at matched 1080p (~15% more).
//
// ── THE CHARGE POINT IS AN ACCEPTED interaction_id, NOT AN HTTP STATUS ───
// This is the single most important fact in this file and it is the OPPOSITE
// of the Atlas contract, which is why it is stated first.
//
// MEASURED 2026-09-03: exceeding the rate cap did NOT return HTTP 429 on the
// POST. The POST returned **200 with an interaction_id**, and the FIRST POLL
// on that id returned `too_many_requests` with "Please retry in 23.397s".
// Artifact: gemini-direct/prod-sel-generic/8ec2/staged-failed-ratelimit-attempt1/.
//
// Therefore:
//   * An id came back  → POSSIBLY BILLED. Stamp the receipt before polling.
//     Never resubmit for that ad. A `too_many_requests` on poll is a terminal
//     outcome for that attempt, not a free replay.
//   * NO id came back, with a structured pre-work rejection → the only shape
//     that licenses a replay.
//   * Socket death / timeout / unparseable body AFTER the request was
//     accepted → treat as possibly billed. Recover by GETting to discover the
//     orphan, never by POSTing again.
//
// Porting Atlas's `isDefinite429`/`submitRetryDecision` semantics verbatim
// would read the poll-body rejection as "rejected before work began" and
// resubmit. That is the double-bill.
//
// ── WHAT MUST NOT BE PORTED FROM ATLAS ───────────────────────────────────
//  * "confirmedCharge from a missing `price`". Gemini NEVER returns `price`,
//    on success or failure. Copying that inference marks every completion
//    unbilled and produces an unbounded resubmit loop — worse than a
//    one-off double charge.
//  * The integer duration enum [4,6,8,10]. Gemini's field is
//    `response_format.duration`, a STRING like "10s".
//  * `pacedModelSubmit` / `semaphore.js` as the cap. See geminiVideoLease.js.
//  * Atlas slugs as the submit `model`.
//
// ── background:true IS A MONEY GUARD ─────────────────────────────────────
// `background:false` with real inputs returns `completed` synchronously AND
// BILLS IMMEDIATELY. That is exactly how a stray $0.36 got spent during an
// earlier "validation" pass. There is no dry-run mode on this API: the only
// safe dry run is one that never POSTs. `buildRequestBody` is exported so a
// dry run can inspect the exact bytes without sending them.
//
const axios = require('axios');
const crypto = require('crypto');

const Ad = require('../models/Ad');
const { recordFlatCost, finalizeFlatCost } = require('./costTracker');
const { adStage } = require('./adStage');
const { resolveGeminiVideoApiKey } = require('./geminiVideoKey');
const lease = require('./geminiVideoLease');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = process.env.GEMINI_VIDEO_MODEL || 'gemini-omni-1.1-flash';

// PROVIDER TAG. Written to Ad and to every CostLog row so the reconcile sweep
// and bootRecoveryService can route by provider instead of guessing. Without
// it, a Gemini interaction id gets Atlas-GET'd (garbage) or never swept at
// all, and the receipt sits in `rendering` forever.
const PROVIDER = 'gemini';
const COST_STAGE = 'gemini_video_render';

// ── PRICING (PUBLISHED) ──────────────────────────────────────────────────
// $/1M tokens. Video output is the dominant term by ~50x.
const USD_PER_M_INPUT = 1.50;
const USD_PER_M_TEXT_OUT = 9.00;
const USD_PER_M_VIDEO_OUT = 17.50;

// PUBLISHED for 720p; MEASURED identical at 1080p (57,920 tokens for a 10s
// clip at both, and the 1080p output was ffprobe-confirmed as genuinely
// 1080x1920, not a silently downgraded 720p). So 1080p is a free quality win
// and is the default here. 360p/4k rates are NOT PUBLISHED and NOT MEASURED —
// a request at those resolutions must ledger costSource:'unknown' rather
// than invent a formula.
const VIDEO_TOKENS_PER_SEC = 5792;
const PRICED_RESOLUTIONS = new Set(['720p', '1080p']);

const DEFAULT_RESOLUTION = process.env.GEMINI_VIDEO_RESOLUTION || '1080p';

// PROBED: aspect_ratio accepts ONLY these two. 1:1 / 4:5 / 4:3 / 21:9 are all
// rejected. Non-portrait/landscape surfaces are derived from a paid master by
// the output-side crop, exactly as on Atlas — that money invariant is
// untouched by this file.
const SUPPORTED_ASPECTS = new Set(['16:9', '9:16']);

function isEnabled() {
  return String(process.env.VIDEO_PROVIDER || 'atlas').toLowerCase() === PROVIDER;
}

/**
 * Total wall-clock budget for polling one interaction.
 *
 * MEASURED submit→terminal: 46s / 60s / 80.6s, plus a file-PROCESSING tail of
 * up to ~95s (interaction `completed` does NOT mean the file is `ACTIVE`).
 * 10 minutes is ~3.5x the worst observed total.
 */
const MAX_POLL_MS = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600_000;
})();

const POLL_INTERVAL_MS = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5_000;
})();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Build the exact request body.
 *
 * SHAPE IS MEASURED, NOT INFERRED. An earlier attempt guessed
 * `{inputs:[{role,parts}]}` and got HTTP 400 `Unknown parameter 'inputs'`.
 * The working shape is a flat typed `input` list plus `response_format`.
 * Exported so a dry run can assert the bytes without POSTing.
 */
function buildRequestBody({ images, prompt, aspectRatio, resolution, durationSec }) {
  const ar = SUPPORTED_ASPECTS.has(aspectRatio) ? aspectRatio : '9:16';
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 10;
  return {
    model: MODEL,
    input: [
      ...images.map((img) => ({
        type: 'image',
        data: Buffer.isBuffer(img.buffer) ? img.buffer.toString('base64') : String(img.data || ''),
        mime_type: img.mimeType || 'image/jpeg'
      })),
      { type: 'text', text: String(prompt || '') }
    ],
    response_format: {
      type: 'video',
      aspect_ratio: ar,
      resolution: resolution || DEFAULT_RESOLUTION,
      // STRING, never an integer. 3–10s inclusive, fractional allowed.
      duration: `${secs}s`,
      delivery: 'uri'
    },
    generation_config: { video_config: { task: 'reference_to_video' } },
    // See the header: background:false bills synchronously. Never flip this.
    background: true,
    store: true,
    stream: false
  };
}

/**
 * Compute cost from provider-reported usage.
 *
 * Returns { costUsd, costSource }. `costSource:'unknown'` when the resolution
 * has no published rate — the caller must NOT coerce that to 0.
 *
 * NOTE on thoughts: `total_thought_tokens` is reported separately but is
 * INSIDE `total_output_tokens`, so text-out is derived by subtraction rather
 * than added on top. Adding both double-charges the thinking tokens.
 */
// MEASURED SHAPE, corrected 2026-09-03 by a live gate run. The first version
// read `usage.video_tokens`, WHICH DOES NOT EXIST — Gemini reports it nested:
//   usage.output_tokens_by_modality: [{ modality: 'video', tokens: 57920 }, ...]
// The consequence was not cosmetic: videoTok resolved to 0, so computeCost
// returned costSource:'unknown' on EVERY successful generation and no real
// master was ever priced. It failed safe (never wrote $0) but never worked.
// Only running it against a real response could find this — the field name was
// inferred, and inference is exactly what cost an HTTP 400 earlier.
function videoTokensOf(usage) {
  const byMod = usage?.output_tokens_by_modality;
  if (Array.isArray(byMod)) {
    const v = byMod.find((m) => String(m?.modality).toLowerCase() === 'video');
    if (v && Number(v.tokens) > 0) return Number(v.tokens);
  }
  // Tolerate a flat field if the API ever grows one; do not depend on it.
  return Number(usage?.video_tokens || 0);
}

function computeCost(usage, resolution) {
  if (!usage) return { costUsd: null, costSource: 'unknown' };
  const inTok = Number(usage.total_input_tokens || usage.input_tokens || 0);
  const videoTok = videoTokensOf(usage);
  const outTok = Number(usage.total_output_tokens || usage.output_tokens || 0);
  const textOut = Math.max(0, outTok - videoTok);

  if (!PRICED_RESOLUTIONS.has(String(resolution))) {
    return { costUsd: null, costSource: 'unknown' };
  }
  if (!videoTok) return { costUsd: null, costSource: 'unknown' };

  const usd =
    (inTok / 1e6) * USD_PER_M_INPUT +
    (textOut / 1e6) * USD_PER_M_TEXT_OUT +
    (videoTok / 1e6) * USD_PER_M_VIDEO_OUT;
  return { costUsd: Number(usd.toFixed(6)), costSource: 'actual' };
}

/** Floor-grade pre-submit estimate, so a row is never $0 before settlement. */
function estimateCost({ durationSec, resolution }) {
  if (!PRICED_RESOLUTIONS.has(String(resolution))) {
    return { costUsd: null, costSource: 'unknown' };
  }
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 10;
  const videoTok = VIDEO_TOKENS_PER_SEC * secs;
  const usd = (videoTok / 1e6) * USD_PER_M_VIDEO_OUT;
  return { costUsd: Number(usd.toFixed(6)), costSource: 'estimated' };
}

/**
 * Classify a poll body. The whole point is to keep "possibly billed" distinct
 * from "provably unbilled".
 */
function classifyPoll(body) {
  const status = String(body?.status || '').toLowerCase();
  const errCode = String(body?.error?.code || '').toLowerCase();

  if (errCode === 'too_many_requests') {
    // The cap rejection that arrives AFTER an accepted id. Terminal for this
    // attempt and POSSIBLY BILLED — never a free replay.
    return { state: 'rate_rejected', billed: 'possible', retryable: false };
  }
  if (status === 'completed' || status === 'succeeded') {
    return { state: 'completed', billed: 'yes', retryable: false };
  }
  if (status === 'failed' || status === 'error') {
    return { state: 'failed', billed: 'possible', retryable: false };
  }
  return { state: 'pending', billed: 'possible', retryable: false };
}

/**
 * Submit ONE generation. Returns { interactionId } on an accepted request.
 *
 * The lease is acquired by the caller BEFORE this is invoked. This function
 * makes exactly one POST and never retries — retry policy belongs to the
 * caller, which is the only place that knows whether an id already exists.
 */
async function submitGeneration({ images, prompt, aspectRatio, resolution, durationSec }) {
  const key = resolveGeminiVideoApiKey();
  if (!key) {
    const err = new Error('gemini video: no API key resolved (GEMINI_VIDEO_API_KEY / GEMINI_API_KEY)');
    err.code = 'GEMINI_AUTH_MISSING';
    err.billed = 'no'; // never reached the network
    throw err;
  }
  const body = buildRequestBody({ images, prompt, aspectRatio, resolution, durationSec });

  let res;
  try {
    res = await axios.post(ENDPOINT, body, {
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      timeout: 120_000,
      // Axios defaults to 21 redirects and RE-SENDS THE BODY on 307/308 —
      // a silent double charge inside one call, invisible to retry logic.
      maxRedirects: 0,
      validateStatus: () => true
    });
  } catch (err) {
    // Socket death / timeout. The request MAY have been accepted, so this is
    // possibly-billed and must never be blind-resubmitted.
    err.billed = 'possible';
    err.code = err.code || 'GEMINI_TRANSPORT';
    throw err;
  }

  const id = res.data?.id || res.data?.interaction_id || null;

  if (id) {
    // An id exists → possibly billed regardless of status code.
    return { interactionId: String(id), httpStatus: res.status };
  }

  // No id. This is the ONLY shape that can be provably unbilled — and only
  // when the body is a structured rejection rather than an opaque failure.
  const err = new Error(
    `gemini video submit rejected (HTTP ${res.status}): ${JSON.stringify(res.data).slice(0, 400)}`
  );
  err.code = 'GEMINI_SUBMIT_REJECTED';
  err.httpStatus = res.status;
  err.billed = (res.status >= 400 && res.status < 500 && res.data?.error) ? 'no' : 'possible';
  throw err;
}

/** GET one interaction. FREE. Never submits. */
async function peekInteraction(interactionId) {
  const key = resolveGeminiVideoApiKey({ log: false });
  if (!key) return null;
  const res = await axios.get(`${ENDPOINT}/${encodeURIComponent(interactionId)}`, {
    headers: { 'x-goog-api-key': key },
    timeout: 60_000,
    maxRedirects: 0,
    validateStatus: () => true
  });
  return res.data || null;
}

/**
 * RESUME from a spend receipt. GET-only.
 *
 * THIS FUNCTION MUST NEVER SUBMIT. It exists so a process that died mid-poll
 * collects the master it already paid for. bootRecoveryService and the
 * titling resume both reach video recovery through here.
 */
async function resumeForAd(ad) {
  const id = ad?.veoPredictionId || null;
  if (!id) return { resumed: false, reason: 'no receipt' };
  const body = await peekInteraction(id);
  if (!body) return { resumed: false, reason: 'peek failed' };
  const verdict = classifyPoll(body);
  return { resumed: true, state: verdict.state, body };
}

/**
 * Pull the delivered video URI out of a terminal interaction.
 *
 * Walks steps -> content and takes the first `type:'video'` entry with a uri.
 * Tolerates the documented-but-unobserved top-level shapes as fallbacks so a
 * future API change degrades to "no uri" rather than a wrong uri.
 */
function extractVideoUri(body) {
  const steps = Array.isArray(body?.steps) ? body.steps : [];
  for (const st of steps) {
    const content = Array.isArray(st?.content) ? st.content : [];
    for (const c of content) {
      if (String(c?.type).toLowerCase() === 'video' && c?.uri) return String(c.uri);
    }
  }
  return body?.output?.uri || body?.output?.[0]?.uri || body?.uri || null;
}

/**
 * Generate one master. Mirrors atlasVideoService.generateForAd's contract so
 * renderer.js can dispatch to either without knowing the difference.
 *
 * ORDER OF OPERATIONS IS THE SAFETY ARGUMENT — do not reorder:
 *   1. acquire the GLOBAL lease (before the POST, never around it)
 *   2. resume instead of submitting if a receipt already exists
 *   3. POST
 *   4. stamp the receipt on Ad.veoPredictionId BEFORE the first poll
 *   5. ledger the submit at the charge point
 *   6. poll
 *   7. settle the cost from provider-reported usage
 *
 * Step 4 before step 6 is what makes a crash mid-poll recoverable instead of
 * a silent $1 loss: bootRecoveryService finds the receipt and collects the
 * master with a free GET.
 */
async function generateForAd({ ad, prompt, images, aspectRatio, durationSec, allowResume = true, campaignRunId = null }) {
  const resolution = DEFAULT_RESOLUTION;
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 10;

  // ── RESUME BEFORE SUBMIT. An ad that already holds a receipt must never
  // buy a second generation. Same predicate as Atlas's shouldResumeAttempt:
  // resume only on the FIRST attempt, and only with a non-empty string id.
  const existing = typeof ad?.veoPredictionId === 'string' && ad.veoPredictionId.length > 0
    ? ad.veoPredictionId
    : null;
  const isResuming = allowResume === true && !!existing;

  let interactionId = existing;
  let slot = null;

  if (!isResuming) {
    // ── THE LEASE. Acquired BEFORE the POST. A null slot means we cannot
    // prove we are under the provider cap, and the cost of guessing wrong is
    // a possibly-billed dead id — so this is a refusal, not a delay-and-send.
    slot = await lease.acquire(`${PROVIDER}:${MODEL}`);
    if (!slot) {
      return { skipped: true, reason: `gemini video: no ${PROVIDER} slot available (cap ${lease.MAX_SLOTS}) — not submitting` };
    }
  }

  try {
    if (!isResuming) {
      adStage(ad._id, `master video submit (gemini ${aspectRatio} ${resolution})`);
      const submitted = await submitGeneration({ images, prompt, aspectRatio, resolution, durationSec: secs });
      interactionId = submitted.interactionId;

      // ── STEP 4: THE SPEND RECEIPT, BEFORE ANY POLL ──────────────────────
      // Non-fatal by design: a bookkeeping failure must never fail a path
      // that has already been billed, because the retry would double-charge.
      // Field is the EXISTING veoPredictionId so every existing reader keeps
      // working; veoProvider is what lets the recovery sweep route by
      // provider instead of Atlas-GETting a Gemini id.
      try {
        await Ad.updateOne({ _id: ad._id }, {
          $set: {
            veoPredictionId: interactionId,
            veoProvider: PROVIDER,
            veoPrompt: prompt,
            veoModel: MODEL,
            veoAspectRatio: aspectRatio,
            veoResolution: resolution,
            updatedAt: new Date()
          }
        });
      } catch (err) {
        console.warn(`⚠️  gemini video: receipt stamp failed for ad=${ad._id} id=${interactionId}: ${err.message}`);
      }

      // ── STEP 5: LEDGER AT THE CHARGE POINT, not the success point.
      // A billable submit that then fails still cost money.
      const est = estimateCost({ durationSec: secs, resolution });
      try {
        await recordFlatCost({
          provider: PROVIDER,
          model: MODEL,
          stage: COST_STAGE,
          status: 'submitted',
          costUsd: est.costUsd,
          costSource: est.costSource,
          adId: ad._id,
          campaignRunId,
          predictionId: interactionId
        });
      } catch (err) {
        console.warn(`⚠️  gemini video: cost ledger failed for ad=${ad._id}: ${err.message}`);
      }
    }

    // ── STEP 6: POLL. Free. Never resubmits.
    const deadline = Date.now() + MAX_POLL_MS;
    let body = null;
    let verdict = { state: 'pending' };
    while (Date.now() < deadline) {
      body = await peekInteraction(interactionId);
      verdict = classifyPoll(body);
      if (verdict.state !== 'pending') break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (verdict.state === 'rate_rejected') {
      // The cap rejection that arrives AFTER an accepted id. TERMINAL for
      // this attempt and possibly billed. The receipt stays on the ad so a
      // later free GET can still collect the master if Google settles it.
      const err = new Error('gemini video: rate-limited AFTER submit (interaction accepted; possibly billed — NOT resubmitting)');
      err.code = 'GEMINI_RATE_REJECTED_AFTER_ACCEPT';
      err.billed = 'possible';
      err.predictionId = interactionId;
      throw err;
    }

    if (verdict.state === 'pending') {
      // TIMEOUT. Leave status:'rendering' — NEVER 'failed'. A failed stamp
      // severs the receipt from bootRecoveryService's selector and the paid
      // master becomes uncollectable.
      const err = new Error(`gemini video: unsettled at timeout after ${Math.round(MAX_POLL_MS / 1000)}s (receipt kept)`);
      err.code = 'GEMINI_UNSETTLED_AT_TIMEOUT';
      err.unsettledAtTimeout = true;
      err.billed = 'possible';
      err.predictionId = interactionId;
      throw err;
    }

    if (verdict.state === 'failed') {
      const err = new Error(`gemini video: generation failed (${JSON.stringify(body?.error || {}).slice(0, 300)})`);
      err.code = 'GEMINI_GENERATION_FAILED';
      err.billed = 'possible';
      err.predictionId = interactionId;
      throw err;
    }

    // ── STEP 7: SETTLE THE COST from provider-reported usage.
    // NOTE: costUsd may be null here (unpriced resolution / no usage). It is
    // passed through as null rather than 0 deliberately — finalizeFlatCost's
    // `Number(x)||0` would otherwise ledger a real charge as free.
    const settled = computeCost(body?.usage || body?.usage_metadata, resolution);
    if (settled.costUsd != null) {
      try {
        await finalizeFlatCost({
          predictionId: interactionId,
          costUsd: settled.costUsd,
          costSource: settled.costSource,
          status: 'ok'
        });
      } catch (err) {
        console.warn(`⚠️  gemini video: cost settle failed for ad=${ad._id}: ${err.message}`);
      }
    } else {
      console.warn(
        `⚠️  gemini video: no priceable usage for ad=${ad._id} id=${interactionId} ` +
        `(resolution=${resolution}) — leaving the submit-time estimate rather than writing $0`
      );
    }

    // MEASURED SHAPE, corrected 2026-09-03 by a live gate run. The URI is NOT
    // at output.uri — it is in the model_output STEP:
    //   steps: [ {type:'user_input'}, {type:'thought'},
    //            {type:'model_output', content:[{type:'video', uri, mime_type}]} ]
    // The first version looked at output.uri/output[0].uri and found nothing,
    // so it threw GEMINI_NO_OUTPUT_URI on a generation that had SUCCEEDED and
    // been BILLED — losing a ~$1.03 master on every single call. Inferred
    // field names on a money path are how you pay for nothing.
    const uri = extractVideoUri(body);
    if (!uri) {
      const err = new Error('gemini video: completed but no output uri (file may still be PROCESSING)');
      err.code = 'GEMINI_NO_OUTPUT_URI';
      err.billed = 'yes';
      err.predictionId = interactionId;
      throw err;
    }

    return {
      skipped: false,
      provider: PROVIDER,
      predictionId: interactionId,
      videoUrl: uri,
      prompt,
      model: MODEL,
      aspectRatio,
      resolution,
      referenceImages: images.map((i) => i.sourceUrl).filter(Boolean),
      costUsd: settled.costUsd,
      costSource: settled.costSource
    };
  } finally {
    // Release the slot however we exit. The TTL is the backstop if this
    // process dies before getting here.
    if (slot) await slot.release();
  }
}

module.exports = {
  isEnabled,
  generateForAd,
  PROVIDER,
  MODEL,
  COST_STAGE,
  ENDPOINT,
  buildRequestBody,
  extractVideoUri,
  videoTokensOf,
  computeCost,
  estimateCost,
  classifyPoll,
  submitGeneration,
  peekInteraction,
  resumeForAd,
  SUPPORTED_ASPECTS,
  PRICED_RESOLUTIONS,
  VIDEO_TOKENS_PER_SEC,
  MAX_POLL_MS,
  POLL_INTERVAL_MS
};
