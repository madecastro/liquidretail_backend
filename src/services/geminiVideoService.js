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
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { resolveGeminiVideoApiKey } = require('./geminiVideoKey');
const lease = require('./geminiVideoLease');
const { assembleReferences } = require('./geminiReferenceAssembly');
const { buildVeoPrompt } = require('./veoPromptBuilder');

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

// Bounded backoff when lease.acquire() returns null (cap full). This is a
// routine condition once real traffic approaches 8 concurrent — NOT an
// error. Sleeping HERE (inside the already-claimed generateForAd call) is
// the FULL retry budget: renderer.js does not persist a counter and does
// not release the claim back to claimOne between attempts. Reusing
// deriveWaitAttempts for that (the first patch) excluded the row from
// strandedRunSweeper after 3 cycles; a later queuedArchiveSweeper pass
// then silently archived it. Holding the claim through this loop costs
// one MAX_INFLIGHT slot, not money — acquire() runs before any submit.
//
// Defaults sized against a measured 21-master run vs 8 slots: occupancy
// hold is ~3 min (submit→terminal 46/60/80.6s plus a ~95s file-
// PROCESSING tail), so the third wave waits ~6 min. 21 attempts × 30s
// backoff = 10 min of internal wait, which covers that with margin.
// Floor 2 so a mis-set env of 1 cannot mean zero retries.
const LEASE_ACQUIRE_ATTEMPTS = (() => {
  const raw = Number(process.env.GEMINI_LEASE_ACQUIRE_ATTEMPTS);
  const n = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 21;
  return Math.max(2, n);
})();
const LEASE_ACQUIRE_BACKOFF_MS = (() => {
  const raw = Number(process.env.GEMINI_LEASE_ACQUIRE_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : 30_000;
})();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Per-call model id.
 *
 * The operator dropdown (adRegenerateService's `videoModel` /
 * videoRouter's `modelOverride`) is an Atlas slug such as
 * `xai/grok-imagine-video-v1.5/reference-to-video`. Those are NOT Gemini
 * model ids; passing them through as `model` would 400 the submit.
 * Gemini currently has one production model (GEMINI_VIDEO_MODEL /
 * gemini-omni-1.1-flash). Honor the override ONLY when it already looks
 * like a Gemini model id (`gemini-…`); otherwise use the configured
 * default. Fold to lowercase: the lease scope is `${PROVIDER}:${model}`
 * and Google's cap is PerProjectPerModel — mixed-case overrides would
 * split the 8-slot pool. Unreachable today (one lowercase registry
 * entry) but the fold is free. There is no Atlas-slug→Gemini mapping —
 * inventing one would silently send a paid job to the wrong model.
 */
function resolveGeminiModel(modelOverride) {
  const raw = typeof modelOverride === 'string' ? modelOverride.trim() : '';
  if (raw && /^gemini-/i.test(raw)) return raw.toLowerCase();
  return MODEL;
}

/**
 * Strip `x-goog-api-key` when axios follows a redirect to a different
 * host. follow-redirects only strips Authorization / Proxy-Authorization
 * / Cookie by default; x-goog-api-key is not in that list. A Files API
 * URI redirecting to storage.googleapis.com (normal, expected) would
 * otherwise forward the credential. Same-host redirects keep the header
 * — a later Files API path still needs it.
 */
function stripGoogApiKeyOnCrossHostRedirect(originalHost) {
  const origin = originalHost ? String(originalHost).toLowerCase() : null;
  return function beforeRedirect(options) {
    if (!options) return;
    let nextHost = options.hostname || options.host;
    if (!nextHost) {
      const href = options.href || options.url;
      if (href) {
        try { nextHost = new URL(href).host; } catch { /* leave unset */ }
      }
    }
    const crossHost = !origin || (nextHost && String(nextHost).toLowerCase() !== origin);
    if (!crossHost || !options.headers) return;
    delete options.headers['x-goog-api-key'];
    delete options.headers['X-Goog-Api-Key'];
  };
}

function geminiMirrorPublicId(interactionId) {
  const id = String(interactionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `gemini_${id}`;
}

function makeUnsettledMirrorError(code, message, interactionId) {
  const err = new Error(message);
  err.code = code;
  err.billed = 'yes';
  err.predictionId = interactionId;
  // SAME flag the poll-timeout path sets. renderer.js's catch only routes
  // into settleUnsettledVideoTimeout (release claim, leave status
  // 'rendering', bootRecovery can still collect) when this is true.
  // Without it a download/mirror failure after cost-settlement writes
  // status:'failed', which is invisible to claimOne AND to
  // bootRecoveryService (selector is status:'rendering' exclusively).
  err.unsettledAtTimeout = true;
  return err;
}

/**
 * Free GET of a completed Gemini Files API URI into a Buffer. Shared by
 * generateForAd and bootRecoveryService so the credential-on-redirect
 * strip and the `.apiKey` header construction cannot drift between the
 * two call sites.
 */
async function downloadOutputToBuffer(uri) {
  const dlKey = resolveGeminiVideoApiKey({ log: false });
  let originalHost = null;
  try { originalHost = new URL(uri).host; } catch { /* strip on any redirect if unparseable */ }
  const dlRes = await axios.get(uri, {
    headers: dlKey.apiKey ? { 'x-goog-api-key': dlKey.apiKey } : {},
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 200 * 1024 * 1024,
    beforeRedirect: stripGoogApiKeyOnCrossHostRedirect(originalHost)
    // No maxRedirects:0 — this is a free content download, not a new
    // generation. A signed-URL redirect to backing storage is normal.
  });
  if (dlRes.status < 200 || dlRes.status >= 300) {
    throw new Error(`HTTP ${dlRes.status}`);
  }
  return Buffer.from(dlRes.data);
}

async function uploadMirroredMaster(videoBuffer, { model, interactionId }) {
  const modelKey = String(model || MODEL).replace(/\//g, '_');
  return uploadBufferToCloudinary(videoBuffer, {
    folder: `liquidretail/gemini_renders/${modelKey}`,
    publicId: geminiMirrorPublicId(interactionId),
    overwrite: true,
    resourceType: 'video',
    format: 'mp4'
  });
}

/**
 * Build the exact request body.
 *
 * SHAPE IS MEASURED, NOT INFERRED. An earlier attempt guessed
 * `{inputs:[{role,parts}]}` and got HTTP 400 `Unknown parameter 'inputs'`.
 * The working shape is a flat typed `input` list plus `response_format`.
 * Exported so a dry run can assert the bytes without POSTing.
 */
function buildRequestBody({ images, prompt, aspectRatio, resolution, durationSec, model }) {
  const ar = SUPPORTED_ASPECTS.has(aspectRatio) ? aspectRatio : '9:16';
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 10;
  return {
    model: model || MODEL,
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
  // Gemini's error.code is NOT a short enum — it can be a full sentence
  // (e.g. a content-policy rejection: "Unable to show the generated video.
  // The video was filtered out because it violated Google's ... policy.").
  // Match known short codes with equality; everything else that still HAS
  // an error object falls through to the generic-error branch below rather
  // than silently matching nothing.
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
  // GENERIC ERROR FALLBACK — live-confirmed gap (2026-09-03): a content-policy
  // rejection body is `{error:{message,code}}` with NO top-level `status`
  // field at all, so it matched none of the branches above and fell through
  // to `pending` — the poll loop read that as "still processing" and looped
  // until MAX_POLL_MS, then treated it as a mere timeout instead of the
  // definitive rejection it already was. ANY body carrying a top-level
  // `error` object that didn't match a more specific case above is terminal,
  // not pending — this is a safety net for response shapes we haven't
  // individually enumerated, not just the one observed shape.
  if (body && body.error) {
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
async function submitGeneration({ images, prompt, aspectRatio, resolution, durationSec, model }) {
  // BUG (B2, live-confirmed 403 with `[object Object]` as the header value):
  // resolveGeminiVideoApiKey() ALWAYS returns an object ({apiKey, slot,
  // fingerprint, length}) — it never returns a falsy value, even when no key
  // is configured (apiKey is '' in that case). So `if (!key)` below was dead
  // code, and interpolating the OBJECT itself into the auth header sent the
  // literal string "[object Object]" as the credential on every request.
  // Fixed by reading `.apiKey` (the actual token string) and checking THAT
  // for emptiness, matching geminiVideoKey.js's real exported shape.
  const key = resolveGeminiVideoApiKey();
  if (!key.apiKey) {
    const err = new Error('gemini video: no API key resolved (GEMINI_VIDEO_API_KEY / GEMINI_API_KEY)');
    err.code = 'GEMINI_AUTH_MISSING';
    err.billed = 'no'; // never reached the network
    throw err;
  }
  const body = buildRequestBody({ images, prompt, aspectRatio, resolution, durationSec, model });

  let res;
  try {
    res = await axios.post(ENDPOINT, body, {
      headers: { 'x-goog-api-key': key.apiKey, 'Content-Type': 'application/json' },
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
  // Same B2 fix as submitGeneration: resolveGeminiVideoApiKey() returns an
  // object, never a falsy value — read `.apiKey`, not the object itself.
  const key = resolveGeminiVideoApiKey({ log: false });
  if (!key.apiKey) return null;
  const res = await axios.get(`${ENDPOINT}/${encodeURIComponent(interactionId)}`, {
    headers: { 'x-goog-api-key': key.apiKey },
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
async function generateForAd({ ad, prompt = null, images = null, aspectRatio, durationSec, operatorPrompt = null, allowResume = true, campaignRunId = null, modelOverride = null }) {
  const resolution = DEFAULT_RESOLUTION;
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 10;
  const resolvedModel = resolveGeminiModel(modelOverride);
  if (modelOverride && resolvedModel === MODEL && String(modelOverride).trim() !== MODEL) {
    console.log(
      `gemini video[ad=${ad?._id}]: ignoring modelOverride=${JSON.stringify(modelOverride)} ` +
      `(not a gemini-* id; using ${MODEL})`
    );
  }

  // ── ASSEMBLE OUR OWN REFERENCES. Do not trust the caller to pass them. ──
  //
  // This function originally took `images` as a required parameter, and BOTH
  // callers passed `storyboard?.images` — which is ALWAYS [] on the gemini
  // path, because videoRouter.prepareStoryboard returns {storyboard:null} for
  // every non-atlas provider. So the merged version would have submitted ZERO
  // references on every call: text-to-video instead of reference-to-video,
  // ~$1 per useless master, with nothing in the response to indicate why.
  //
  // Owning assembly here removes the whole class of bug rather than fixing it
  // at two call sites: a caller CANNOT forget. It also matches
  // atlasVideoService, which likewise builds its own stack internally.
  //
  // An explicit non-empty `images` still wins, so a dry run or a harness can
  // inject a known stack without touching Mongo.
  let refs = Array.isArray(images) && images.length ? images : null;
  if (!refs) {
    const assembled = await assembleReferences({ ad, aspectRatioOverride: aspectRatio });
    refs = assembled.images;
  }

  // ── RESUME BEFORE SUBMIT. An ad that already holds a receipt must never
  // buy a second generation. Same predicate as Atlas's shouldResumeAttempt:
  // resume only on the FIRST attempt, and only with a non-empty string id.
  // Computed HERE, before prompt-building below, because the prompt
  // precedence fix needs to know whether this is a genuine resume.
  const existing = typeof ad?.veoPredictionId === 'string' && ad.veoPredictionId.length > 0
    ? ad.veoPredictionId
    : null;
  const isResuming = allowResume === true && !!existing;

  // ── BUILD OUR OWN PROMPT TOO, for exactly the same reason. ─────────────
  //
  // Both callers passed `storyboard?.prompt || ad.veoPrompt`. On the gemini
  // path storyboard is null (prepareStoryboard no-ops for non-atlas), and
  // `ad.veoPrompt` is stamped as part of the RECEIPT — i.e. AFTER the submit.
  // So on a first render it is null, and we would have submitted an EMPTY
  // prompt alongside the (previously empty) reference list. Same bug class,
  // one layer over: the caller cannot supply what does not exist yet.
  //
  // PRECEDENCE (B8 fix), matching atlasVideoService's opTrim rule
  // (:5551-5570 there):
  //   (1) an explicit `prompt` argument — dry-run / harness callers only;
  //       the real videoRouter call site never supplies one (see that
  //       file's "NO prompt ARGUMENT. This is deliberate" comment).
  //   (2) a non-empty operatorPrompt ALWAYS wins, exactly like Atlas's
  //       opTrim branch. Whitespace-only does not count as an override
  //       (same trim-gate Atlas uses), so it falls through below.
  //   (3) ad.veoPrompt ONLY when genuinely RESUMING (isResuming, computed
  //       above) — that is the whole point of stamping it as part of the
  //       receipt. The PREVIOUS version of this file checked ad.veoPrompt
  //       unconditionally (whenever it happened to be non-empty, regardless
  //       of isResuming), which silently discarded a fresh operatorPrompt on
  //       every single regenerate — a regenerate ALWAYS has a stale
  //       ad.veoPrompt from the render it is regenerating, and
  //       adRegenerateService always calls this with allowResume:false (a
  //       guaranteed new billable submit), so isResuming is false and the
  //       operator's edit must win. This is the exact "Vaportek incident"
  //       class of bug videoRouter.js's header comment documents as fixed by
  //       moving prompt construction into this file — gating on isResuming
  //       (not "ad.veoPrompt happens to be set") is what actually closes it.
  //   (4) CORE, via the single builder, with the operator's text folded in.
  const opTrim = typeof operatorPrompt === 'string' ? operatorPrompt.trim() : null;
  let effectivePrompt = typeof prompt === 'string' && prompt.trim() ? prompt : null;
  if (!effectivePrompt && !opTrim && isResuming &&
      typeof ad?.veoPrompt === 'string' && ad.veoPrompt.trim()) {
    effectivePrompt = ad.veoPrompt;
  }
  if (!effectivePrompt) {
    // CORE, via the single builder. Not a local copy of the text: the prompt
    // is sha-pinned by scripts/verifyOperatorPromptPrecedence group A and a
    // second copy here would drift the moment CORE is tuned.
    effectivePrompt = buildVeoPrompt({
      brand: null,
      product: null,
      media: null,
      aspectRatio,
      hasProductReference: refs.length > 1,
      operatorPrompt: opTrim || null,
      durationSec: secs,
      platformFormat: ad?.platformFormat || null,
      // Gemini publishes no prompt byte cap (Atlas's 20,000 is Atlas-only),
      // and CORE is ~1.2 KB, so no cap is passed. enforceByteCap treats a
      // null caps as the default ceiling, which CORE is nowhere near.
      caps: null
    });
  }
  if (!effectivePrompt || !effectivePrompt.trim()) {
    const err = new Error('gemini video: refusing to submit with an empty prompt');
    err.code = 'GEMINI_NO_PROMPT';
    err.billed = 'no';
    throw err;
  }
  if (!refs.length) {
    // Belt and braces. assembleReferences throws rather than returning short,
    // so reaching here means someone passed an empty array explicitly.
    const err = new Error('gemini video: refusing to submit with zero reference images');
    err.code = 'GEMINI_NO_REFERENCES';
    err.billed = 'no';
    throw err;
  }

  let interactionId = existing;
  let slot = null;

  if (!isResuming) {
    // ── THE LEASE. Acquired BEFORE the POST. A null slot means we cannot
    // prove we are under the provider cap, and the cost of guessing wrong is
    // a possibly-billed dead id — so this is a refusal, not a delay-and-send.
    //
    // Scope is provider:RESOLVED-model because Google's cap is
    // PerProjectPerModel. A future gemini-* override must not share the
    // default model's 8 slots, and must not be counted against them.
    const leaseScope = `${PROVIDER}:${resolvedModel}`;
    for (let attempt = 1; attempt <= LEASE_ACQUIRE_ATTEMPTS; attempt += 1) {
      slot = await lease.acquire(leaseScope);
      if (slot) break;
      if (attempt === LEASE_ACQUIRE_ATTEMPTS) {
        // NOT an error and nothing was billed. retryable:true is the
        // signal for regenerate to park on its 45-min claim rather than
        // markComplete('failed'). renderer.js treats ANY skip — including
        // this one — as a throw after this function's internal budget is
        // exhausted (holding the claim through the loop above is the
        // retry; a persisted counter is how we collided with
        // strandedRunSweeper). A terminal-fail here costs the campaign
        // one unbilled ad, same as any other render failure.
        return {
          skipped: true,
          retryable: true,
          code: 'GEMINI_LEASE_EXHAUSTED',
          reason: `gemini video: no ${PROVIDER} slot available (cap ${lease.MAX_SLOTS}) after ${LEASE_ACQUIRE_ATTEMPTS} attempts — not submitting`
        };
      }
      try { adStage(ad._id, `gemini lease wait ${attempt}/${LEASE_ACQUIRE_ATTEMPTS}`); } catch { /* non-fatal */ }
      console.log(
        `gemini video[ad=${ad?._id}]: no slot (attempt ${attempt}/${LEASE_ACQUIRE_ATTEMPTS}); ` +
        `backing off ${LEASE_ACQUIRE_BACKOFF_MS}ms`
      );
      await sleep(LEASE_ACQUIRE_BACKOFF_MS);
    }
  }

  try {
    if (!isResuming) {
      adStage(ad._id, `master video submit (gemini ${aspectRatio} ${resolution})`);
      const submitted = await submitGeneration({ images: refs, prompt: effectivePrompt, aspectRatio, resolution, durationSec: secs, model: resolvedModel });
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
            veoPrompt: effectivePrompt,
            veoModel: resolvedModel,
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
          model: resolvedModel,
          stage: COST_STAGE,
          status: 'submitted',
          costUsd: est.costUsd,
          costSource: est.costSource,
          adId: ad._id,
          campaignRunId,
          // BUG (B3): this used to be `predictionId`, which is not a field on
          // the CostLog schema (see models/CostLog.js — only
          // `providerRequestId` exists) and, more importantly, is NOT the key
          // finalizeFlatCost() matches on. Passing the wrong name here didn't
          // break THIS insert (Mongoose strict silently drops the unknown
          // field and the row still gets created), but it meant the row this
          // charge-point write created could never be found again by the
          // settle step below — see that call for the actual consequence.
          providerRequestId: interactionId
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
      if (slot && typeof slot.heartbeat === 'function') {
        try { await slot.heartbeat(); } catch { /* TTL is the backstop; keep polling */ }
      }
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
      // Distinguish a content-policy rejection from any other terminal
      // failure — live-confirmed shape (2026-09-03): error.message/code
      // mention Google's Generative AI Prohibited Use policy, "filtered",
      // or "blocked". This is actionable differently than a generic
      // technical failure (rephrase the prompt / review the product
      // image / escalate to Google), so it gets its own error code and,
      // via notifyRenderFailure in renderer.js, its own Slack alert
      // instead of being lumped into "Video generation failed".
      const errBlob = `${body?.error?.message || ''} ${body?.error?.code || ''}`.toLowerCase();
      const isContentPolicyBlock = /prohibited|content polic|filtered out|violat.*polic/.test(errBlob);
      const err = new Error(`gemini video: generation failed (${JSON.stringify(body?.error || {}).slice(0, 300)})`);
      err.code = isContentPolicyBlock ? 'GEMINI_CONTENT_POLICY_BLOCKED' : 'GEMINI_GENERATION_FAILED';
      err.contentPolicyBlocked = isContentPolicyBlock;
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
        // BUG (B3), found by reading costTracker.js's actual contract:
        // finalizeFlatCost() keys its update on `meta.providerRequestId`
        // (costTracker.js:457 `const id = meta.providerRequestId`). This call
        // used to pass `predictionId` instead — not a real key the function
        // reads — so `id` was always undefined, and
        // `if (!id) return recordFlatCost(meta)` fired on EVERY settle. That
        // fallback calls persistCost() with only
        // {predictionId,costUsd,costSource,status} — missing the
        // schema-required `stage`/`provider`/`model` — so CostLog.create()
        // threw a ValidationError and persistCost DROPPED THE ROW (loudly,
        // via its own alerts.error, but dropped). Net effect: the real
        // settled price (~$1.03) was never recorded; the charge-point row
        // from the submit above stood forever at status:'submitted',
        // costSource:'estimated'. Fixed by using the real key
        // (providerRequestId) AND — matching atlasVideoService's own
        // finalizeFlatCost calls (:5866-5878, :5892-5904), which always pass
        // a complete record — including stage/provider/model so even a
        // missed update (e.g. the charge-point write above failed its own
        // non-fatal try/catch) falls back to a valid insert instead of a
        // silently dropped one.
        await finalizeFlatCost({
          stage: COST_STAGE,
          provider: PROVIDER,
          model: resolvedModel,
          providerRequestId: interactionId,
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
      // Completed + billed, file still in the PROCESSING tail. Same
      // recoverability as a poll timeout: leave status:'rendering'.
      throw makeUnsettledMirrorError(
        'GEMINI_NO_OUTPUT_URI',
        'gemini video: completed but no output uri (file may still be PROCESSING)',
        interactionId
      );
    }

    // ── BUG (B1): MIRROR TO CLOUDINARY, exactly like atlasVideoService does
    // for its own delivered master (atlasVideoService.js :5951-5979
    // downloadToBuffer + uploadBufferToCloudinary). The PREVIOUS version of
    // this file returned `uri` itself as `videoUrl` — a
    // generativelanguage.googleapis.com/v1beta/files/... resource. That is
    // not a durable public asset link: it requires the SAME x-goog-api-key
    // credential every other call in this file needs, and Google's Files API
    // expires uploaded/generated files (not indefinitely retained). renderer.js
    // stamps this value straight onto Ad.veoVideoUrl AND Ad.renderUrl and
    // hands it to vision QC and the titling composite (renderer.js
    // veoResult.videoUrl / veoResult.cloudinaryPublicId) — so an
    // un-mirrored URL would 403/expire the moment anything outside this
    // process tried to load it, and cloudinaryPublicId would be silently
    // absent (videoRouter.js's documented uniform provider return shape
    // requires it). Download once, mirror once, return the durable
    // Cloudinary URL — same contract Atlas already honors.
    adStage(ad._id, `downloading master video (${aspectRatio})`);
    let videoBuffer;
    try {
      videoBuffer = await downloadOutputToBuffer(uri);
    } catch (err) {
      // Billed and delivered — the master exists at `uri` even though this
      // mirror step failed. Never 'no'. unsettledAtTimeout routes the ad
      // through settleUnsettledVideoTimeout so bootRecovery can still
      // collect it with a free GET rather than a status:'failed' write
      // that strands the paid master forever.
      throw makeUnsettledMirrorError(
        'GEMINI_OUTPUT_DOWNLOAD_FAILED',
        `gemini video: output download failed (${err.message})`,
        interactionId
      );
    }

    adStage(ad._id, `mirror upload (${aspectRatio})`);
    let uploaded;
    try {
      uploaded = await uploadMirroredMaster(videoBuffer, { model: resolvedModel, interactionId });
    } catch (err) {
      throw makeUnsettledMirrorError(
        'GEMINI_OUTPUT_MIRROR_FAILED',
        `gemini video: Cloudinary mirror failed (${err.message})`,
        interactionId
      );
    }

    return {
      skipped: false,
      provider: PROVIDER,
      predictionId: interactionId,
      videoUrl: uploaded.secure_url,
      cloudinaryPublicId: uploaded.public_id,
      prompt: effectivePrompt,
      model: resolvedModel,
      aspectRatio,
      resolution,
      referenceImages: refs.map((i) => i.sourceUrl).filter(Boolean),
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
  resolveGeminiModel,
  stripGoogApiKeyOnCrossHostRedirect,
  downloadOutputToBuffer,
  uploadMirroredMaster,
  geminiMirrorPublicId,
  makeUnsettledMirrorError,
  SUPPORTED_ASPECTS,
  PRICED_RESOLUTIONS,
  VIDEO_TOKENS_PER_SEC,
  MAX_POLL_MS,
  POLL_INTERVAL_MS,
  LEASE_ACQUIRE_ATTEMPTS,
  LEASE_ACQUIRE_BACKOFF_MS
};
